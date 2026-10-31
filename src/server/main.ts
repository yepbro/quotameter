/**
 * Server entry point and process orchestration (task 060, spec §5.6).
 *
 * `runServer` is the callable behind the future `quotameter run` command
 * (spec §5.2): it verifies the runtime, starts the assembled application,
 * turns SIGTERM/SIGINT into a graceful shutdown, and returns the process exit
 * code. It never calls `process.exit` itself — the caller owns the process,
 * which keeps the orchestration testable in-process.
 *
 * Startup and shutdown *semantics* live in `src/server/app.ts`; this module
 * only wires the process to them. SIGHUP is deliberately not handled yet:
 * configuration reload (task 068) will plug into this same seam, and silently
 * swallowing SIGHUP before that would change terminal-disconnect behavior.
 */

import { type LifecycleComponent, QuotameterApp } from './app';
import { satisfiesMinimum } from '../util/version';

/** The declared minimum runtime (spec §5.1); mirrors `engines.node`. */
export const MINIMUM_NODE_VERSION = '22.13.0';

/** The runtime facts the bootstrap gate checks; injected so tests can vary them. */
export interface RuntimeFacts {
  readonly nodeVersion: string;
  /**
   * Running user id, or `undefined` when the platform cannot report it. The
   * service targets Linux (spec §5.1), where it always can; an absent uid is
   * refused rather than guessed.
   */
  readonly uid: number | undefined;
}

/** Reads the runtime facts of the current process. */
export function currentRuntime(): RuntimeFacts {
  return { nodeVersion: process.versions.node, uid: process.getuid?.() };
}

/**
 * Refuses to run on an unsupported runtime (spec §5.1): Node.js below the
 * declared minimum, an unverifiable user, or a root user — the service must
 * run under a regular account, and the generated systemd unit sets `User=`
 * accordingly (§5.4).
 */
export function verifyRuntime(facts: RuntimeFacts): void {
  if (!satisfiesMinimum(facts.nodeVersion, MINIMUM_NODE_VERSION)) {
    throw new Error(
      `quotameter requires Node.js >= ${MINIMUM_NODE_VERSION} ` +
        `(found ${facts.nodeVersion}); refusing to start`,
    );
  }
  if (facts.uid === undefined) {
    throw new Error('cannot determine the uid of the running process; refusing to start');
  }
  if (facts.uid === 0) {
    throw new Error(
      'quotameter must not run as root; run it under a regular user account ' +
        '(the generated systemd unit sets User= accordingly)',
    );
  }
}

/**
 * Assembles the application's components in startup dependency order.
 *
 * Bootstrap stage (task 060): the skeleton runs with no components at all,
 * which is exactly the milestone "starts and stops cleanly without collecting
 * provider data". Later construction tasks register theirs here, in the order
 * spec §5.6 shutdown semantics require:
 *
 * 1. single-instance lock (074) — before anything touches the data directory;
 * 2. storage connection (078+) — database handle, WAL checkpoint on shutdown;
 * 3. polling service (093+) — first collection right after startup (§7.1);
 * 4. HTTP listener (146) — last, so it serves a fully assembled application.
 */
export function buildComponents(): LifecycleComponent[] {
  return [];
}

/** Handles installed by {@link installShutdownSignals}. */
export interface InstalledSignals {
  /** Remove the installed listeners. */
  dispose(): void;
}

/**
 * Turns SIGTERM and SIGINT into calls of `trigger` (which must handle its own
 * errors). Returns a disposer so an embedding process or test can remove the
 * listeners again.
 */
export function installShutdownSignals(
  trigger: (signal: NodeJS.Signals) => void,
): InstalledSignals {
  const handler = (signal: NodeJS.Signals): void => {
    trigger(signal);
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  return {
    dispose() {
      process.removeListener('SIGTERM', handler);
      process.removeListener('SIGINT', handler);
    },
  };
}

export interface RunServerOptions {
  /** Components to assemble; defaults to {@link buildComponents}. */
  readonly components?: readonly LifecycleComponent[];
  /** Runtime facts to verify; defaults to the current process. */
  readonly runtime?: RuntimeFacts;
  /**
   * Announces that the application started and the shutdown signal handlers
   * are installed — the process is gracefully stoppable from this moment.
   * Signal-readiness seam for embedders and the lifecycle tests (the
   * child-process specs must not signal before the handlers exist, U-001);
   * omitting it, as normal runs do, changes nothing. A throwing callback
   * rejects {@link runServer} without stopping the started components —
   * fail-fast for a broken readiness hook.
   */
  readonly onSignalsReady?: () => void;
}

/**
 * Runs the application until a shutdown signal arrives.
 *
 * Returns `0` after a clean shutdown, and `1` when the runtime gate or the
 * startup sequence failed, or a component failed to stop. Fatal bootstrap
 * problems are explained on stderr — before the structured logger exists
 * (task 072) a service that refuses to start must still say why, and no
 * secrets can be involved this early (configuration is loaded later, §6).
 *
 * A failed startup is followed by a best-effort `app.stop()` before the
 * failure code is returned (§5.6, decision D-095): `start()`'s rollback
 * records the components it could not release, and that stop is their retry
 * route (D-088) — only this entry point knows the startup failed. The retry
 * is awaited, and a rejecting retry is reported and swallowed: the startup
 * error stays the process's diagnosis and the exit code stays `1`.
 *
 * Shutdown handlers are installed only after a successful start, so signals
 * arriving during startup keep the OS-default disposition. The graceful
 * shutdown coordinator (task 075) owns this seam: it must move installation
 * ahead of `app.start()` and define stop-during-startup semantics.
 */
export async function runServer(options: RunServerOptions = {}): Promise<number> {
  try {
    verifyRuntime(options.runtime ?? currentRuntime());
  } catch (error) {
    reportFatal(describeError(error));
    return 1;
  }

  let app: QuotameterApp | undefined;
  try {
    app = new QuotameterApp({ components: options.components ?? buildComponents() });
    await app.start();
  } catch (error) {
    // The startup error is reported first — it stays the process's diagnosis
    // even when the cleanup retry below hangs or fails.
    reportFatal(describeError(error));
    await stopAfterFailedStart(app);
    return 1;
  }

  // Hold the event loop open: a signal-driven foreground service must keep
  // running even when the assembled components are pure and own no I/O
  // handles (the HTTP listener and poll timers of the later construction
  // tasks will hold it by themselves). Cleared once shutdown completes so
  // the process can exit with the returned code.
  const keepAlive = setInterval(() => {}, 600_000);

  let resolveShutdown!: () => void;
  const shutdownCompleted = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  let stopFailed = false;
  const signals = installShutdownSignals(() => {
    void app
      .stop()
      .catch((error: unknown) => {
        stopFailed = true;
        reportFatal(describeError(error));
      })
      .finally(resolveShutdown);
  });

  try {
    // First statement of the try on purpose: the finally clause releases the
    // signal handlers and the keep-alive interval even if the callback throws.
    options.onSignalsReady?.();
    await shutdownCompleted;
  } finally {
    signals.dispose();
    clearInterval(keepAlive);
  }
  return stopFailed ? 1 : 0;
}

function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map((inner) => describeError(inner)).join('; ')}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Best-effort `app.stop()` from the startup-failure branch (§5.6, decision
 * D-095, on D-088's retryable-cleanup semantics): the rollback inside
 * `start()` records the components it could not release, and `stop()` from
 * `'failed'` retries exactly those — but only the entry point knows the
 * startup failed, so only it can trigger the retry before the process
 * reports its failure code. The stop is awaited so the release attempt
 * settles first; a rejecting retry is reported through the fatal-diagnostics
 * seam and swallowed — the startup error printed above stays the diagnosis,
 * and the exit code is unchanged. `app` is `undefined` only when assembly
 * threw before the constructor completed, leaving nothing to stop (no route
 * there today: `buildComponents()` assembles nothing yet — the §5.6
 * construction tasks add the throwing constructions).
 */
async function stopAfterFailedStart(app: QuotameterApp | undefined): Promise<void> {
  if (!app) return;
  try {
    await app.stop();
  } catch (error) {
    reportFatal(describeError(error));
  }
}

/** Pre-logger fatal diagnostics; replaced by the structured logger (task 072). */
function reportFatal(message: string): void {
  process.stderr.write(`quotameter: ${message}\n`);
}
