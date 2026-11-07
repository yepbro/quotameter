/**
 * Server entry point and process orchestration (task 060, spec §5.6).
 *
 * `runServer` is the callable behind the `quotameter run` command
 * (spec §5.2; wired as its handler by task U-050's `src/cli/run.ts`): it
 * verifies the runtime, starts the assembled application, turns
 * SIGTERM/SIGINT into a graceful shutdown and SIGHUP into a
 * configuration reload (§6.4; task U-052, decision D-177), and returns
 * the process exit code. It never calls `process.exit` itself — the
 * caller owns the process, which keeps the orchestration testable
 * in-process.
 *
 * Startup and shutdown *semantics* live in `src/server/app.ts`; this
 * module only wires the process to them. The SIGHUP handler is installed
 * only when a reload operation exists (D-177): the composed default
 * always provides one, while an embedder injecting bare components keeps
 * the OS-default disposition — a handler with nothing to reload would
 * only swallow the signal. The foreground consequence is deliberate and
 * documented: a `quotameter run` whose terminal disconnects survives the
 * TTY's SIGHUP (it triggers a usually no-op reload, §16-logged), because
 * §5.2/§6.4 designate SIGHUP as the reload channel — `quotameter reload`
 * must not kill the service — while SIGINT/SIGTERM remain the stop
 * channels. A signal arriving during startup keeps the OS-default
 * disposition, exactly as for SIGTERM/SIGINT (D-024's recorded window) —
 * a window `quotameter reload`'s lock-based discovery can reach, because
 * the §5.6 lock names the holder pid for the whole of `app.start()`
 * (migrations, listener bind) while the SIGHUP handler installs only
 * after it settles; the symmetric post-dispose shutdown tail behaves the
 * same. Both windows terminate the starting/stopping service and are
 * D-177's recorded residual (systemd's `Restart=on-failure` recovers).
 */

import { type LifecycleComponent, QuotameterApp } from './app';
import { type ComposedApplication, composeApplication } from './composition';
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
 * accordingly (§5.4). Version strings order by their numeric prefix: a
 * prerelease-suffixed runtime such as a nightly build counts as its release
 * line (task 129, decision D-098).
 */
export function verifyRuntime(facts: RuntimeFacts): void {
  if (!satisfiesMinimum(facts.nodeVersion, MINIMUM_NODE_VERSION)) {
    throw new Error(
      `quotameter requires Node.js >= ${MINIMUM_NODE_VERSION} ` +
        `(found ${facts.nodeVersion}); refusing to start. ` +
        'Upgrade Node.js (for example via the official binaries or nvm) and try again.',
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
 * Assembles the application in startup dependency order.
 *
 * Bootstrap stage (task 060): the skeleton ran with no components at all,
 * which is exactly the milestone "starts and stops cleanly without collecting
 * provider data". The composition root (task U-040, decision D-140; the
 * polling engine since U-051/D-176) assembles the real service —
 * configuration, storage, the §5.6 graceful drain, the polling engine, the
 * wired API — through `composeApplication`, in the order spec §5.6 shutdown
 * semantics require:
 *
 * 1. single-instance lock (074) — before anything touches the data directory;
 * 2. storage connection (078+) — database handle, WAL checkpoint on shutdown;
 * 3. graceful drain (075) — bounded wait for in-flight polling work;
 * 4. polling engine (093+, composed by U-051) — first collection right
 *    after startup (§7.1);
 * 5. HTTP listener (146) — last, so it serves a fully assembled application.
 *
 * The function is async because the composition loads and validates the
 * configuration before any component exists (§6.2: an invalid startup
 * configuration refuses to start — `runServer` reports the problems and
 * returns exit code 1). Since U-052 (D-177) it returns the whole composed
 * result, not just the component list: the SIGHUP wiring needs the
 * composition's reload wrapper beside the components.
 */
export async function buildApplication(): Promise<ComposedApplication> {
  return composeApplication();
}

/** Handlers installed by {@link installShutdownSignals} and {@link installReloadSignal}. */
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

/**
 * Turns SIGHUP into a call of `reload` (§6.4; task U-052, decision D-177).
 * The callback must handle its own errors, like the shutdown trigger — the
 * composed application's wrapper contains every fault at `error` through
 * the §16 logger, so a rejected or faulting reload never kills the process
 * (§6.2 keeps the last valid configuration effective). Returns a disposer
 * so an embedding process or test can remove the listener again;
 * disposing restores the OS-default disposition, exactly like the
 * shutdown pair.
 */
export function installReloadSignal(reload: () => void): InstalledSignals {
  process.on('SIGHUP', reload);
  return {
    dispose() {
      process.removeListener('SIGHUP', reload);
    },
  };
}

export interface RunServerOptions {
  /**
   * Components to assemble; defaults to the composed application's list
   * through {@link buildApplication}.
   */
  readonly components?: readonly LifecycleComponent[];
  /**
   * The operation a SIGHUP triggers (§6.4; decision D-177): defaults to
   * the composed application's reload wrapper when the default assembly
   * runs, and to nothing when `components` are injected — embedders and
   * tests opt into SIGHUP handling by providing this seam, keeping the
   * OS-default disposition otherwise. The callback must handle its own
   * errors (a signal handler must never throw).
   */
  readonly reload?: () => void;
  /** Runtime facts to verify; defaults to the current process. */
  readonly runtime?: RuntimeFacts;
  /**
   * Announces that the application started, the shutdown signal handlers
   * are installed, and — when a reload operation exists (D-177) — the
   * SIGHUP reload handler is installed too: the process is gracefully
   * stoppable and reloadable from this moment. Signal-readiness seam for
   * embedders and the lifecycle tests (the child-process specs must not
   * signal before the handlers exist, U-001); omitting it, as normal runs
   * do, changes nothing. A throwing callback rejects {@link runServer}
   * without stopping the started components — fail-fast for a broken
   * readiness hook.
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
 *
 * SIGHUP never terminates the process: when a reload operation exists
 * (D-177) it triggers §6.4's reload through the composition's wrapper,
 * whose outcome — success, rejection, or fault — leaves the shutdown
 * promise and the exit code untouched (§6.2 keeps the last valid
 * configuration effective; a fault is contained at `error` through the
 * §16 logger). A reload still in flight when shutdown completes dies with
 * the process.
 */
export async function runServer(options: RunServerOptions = {}): Promise<number> {
  try {
    verifyRuntime(options.runtime ?? currentRuntime());
  } catch (error) {
    reportFatal(describeError(error));
    return 1;
  }

  let app: QuotameterApp | undefined;
  let reload: (() => void) | undefined;
  try {
    if (options.components === undefined) {
      // The production assembly: the composed result carries the SIGHUP
      // reload operation beside the components (D-177).
      const composed = await buildApplication();
      reload = options.reload ?? composed.reloadOnSighup;
      app = new QuotameterApp({ components: composed.components });
    } else {
      // An embedder's or test's components: no reload operation unless one
      // is injected — the OS-default SIGHUP disposition stays (D-177).
      reload = options.reload;
      app = new QuotameterApp({ components: options.components });
    }
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
  // Beside the shutdown pair, and only when there is something to reload:
  // SIGHUP becomes §6.4's reload (D-177). Disposed before the shutdown
  // pair below (LIFO), so a SIGHUP after shutdown completion regains the
  // OS default exactly like SIGTERM/SIGINT.
  const reloadSignal = reload === undefined ? undefined : installReloadSignal(reload);

  try {
    // First statement of the try on purpose: the finally clause releases the
    // signal handlers and the keep-alive interval even if the callback throws.
    options.onSignalsReady?.();
    await shutdownCompleted;
  } finally {
    reloadSignal?.dispose();
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
 * threw before the constructor completed, leaving nothing to stop — today
 * the composition's own refusals (invalid configuration, §6.2) land there;
 * component-start failures reach the rollback below instead.
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
