/**
 * The `quotameter reload` command handler (task 141, spec §5.2/§6.4; decision
 * D-112).
 *
 * §5.2: "`quotameter reload` — Reload configuration on SIGHUP without
 * restarting where supported", and the done-condition of the task: the
 * feedback must reflect whether the configuration was accepted or rejected.
 * The reload *mechanism* is landed (task 068, `src/config/reload.ts` — the
 * service re-runs the load pipeline on SIGHUP and keeps the last valid
 * configuration on rejection, spec §6.2); this handler is the command that
 * triggers it and answers the accepted/rejected question.
 *
 * **Running-service discovery is the §5.6 single-instance lock, single-sited
 * through the landed module** (`lockFilePath` of `src/server/single-instance.ts`,
 * imported read-only — task 141 must not modify `src/server/**`). The lock
 * file exists exactly while a service instance holds the data directory, for
 * every run mode: a systemd unit and a foreground `quotameter run` alike. A
 * `systemctl kill`-scoped alternative would only reach installed units and
 * would probe *installed*, not *running* — the lock answers both questions
 * (running, and at which pid) with one read. The recorded holder pid is
 * liveness-probed with the landed `isProcessAlive` before anything is
 * signalled: a stale lock (crashed service, §5.6's automatic stale-break has
 * not run yet because nothing restarted) reports "not running", never a
 * signal at a dead pid.
 *
 * **The accepted/rejected oracle is a pre-flight validation (D-112)**: the
 * command re-runs `loadConfigWithEnv` — the exact pipeline function the
 * service reloader calls on SIGHUP (D-023/D-026) — over the owner-scoped
 * §6.1 configuration path, in this process. Validation is deterministic, so
 * the answer is immediate and needs no observation channel, which v1.0 does
 * not have (the health API is task 147, journald reading is task 143): a
 * rejected file is reported with its pipeline problems verbatim and **no
 * SIGHUP is sent**, because §6.2 pins the service-side consequence — keep
 * the last valid configuration — making the signal a guaranteed no-op. A
 * valid file is signalled, and the success report carries the §6.4 advisory
 * (live settings apply; `server.host`/`server.port`/`auth.mode` require
 * `quotameter restart`) without fabricating the service's
 * applied-vs-pending-restart classification, which only the service can
 * compute — its reload log line is the authoritative record (`quotameter
 * logs`, task 143).
 *
 * Exit codes: 0 exactly when the configuration validated and SIGHUP was
 * delivered; every other outcome — owner problems, unusable owner home, no
 * running service (absent, stale, or unreadable lock), an invalid lock
 * payload, a rejected configuration, or a failed signal (the service exited
 * meanwhile, permission denied, or another error) — exits 1 with the failure
 * on stderr and actionable steps on stdout. The handler never throws, the
 * owner resolution's broken-system throw included (D-110's contract).
 */

import { readFile } from 'node:fs/promises';
import { type ConfigEnvLoadResult, loadConfigWithEnv } from '../config/env';
import { configFilePath } from '../config/load';
import type { PathEnv } from '../config/paths';
import { isProcessAlive, lockFilePath } from '../server/single-instance';
import type { CliContext, CliHandler } from './commands';
import type { ServiceOwnerResolution } from './service-owner';
import { ownerUnitDirectories, resolveOwnerForCommand } from './service-install';
import { failureLine, thrownMessage } from './service-setup';

/* ── Reading the §5.6 lock of the data directory ───────────────────────── */

/** What reading the single-instance lock of a data directory established. */
export type ServiceLockRead =
  /** No lock file — no service instance holds the data directory. */
  | { readonly state: 'absent' }
  /** The path exists but cannot be read; `detail` is the filesystem error. */
  | { readonly state: 'unreadable'; readonly detail: string }
  /** The payload is not a quotameter lock (damaged or foreign content). */
  | { readonly state: 'invalid' }
  /** A structurally valid lock naming its holder `pid`. */
  | { readonly state: 'held'; readonly pid: number };

/**
 * Extracts the holder pid from lock file content, or `null` when it is not
 * ours. Mirrors the private `parseHolderPid` of `src/server/single-instance.ts`
 * — the payload contract `{ pid: <positive integer>, id: <token> }` is
 * published by that module and pinned by its tests; this copy exists because
 * exporting the private parser would modify a `src/server/**` file, outside
 * this task's boundary (task 147's set). The two must stay in lockstep.
 */
export function parseServiceLockPid(content: string): number | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const pid = (value as { pid?: unknown }).pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

/**
 * Reads the single-instance lock at `lockPath` and classifies it. Never
 * throws: every filesystem failure (except `ENOENT`, which is the absent
 * state) becomes the `unreadable` state carrying the error message — the
 * caller renders it, exactly like the landed handlers render their seam
 * failures.
 */
export async function readServiceLock(lockPath: string): Promise<ServiceLockRead> {
  let content: string;
  try {
    content = await readFile(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'absent' };
    }
    return { state: 'unreadable', detail: thrownMessage(error) };
  }
  const pid = parseServiceLockPid(content);
  return pid === null ? { state: 'invalid' } : { state: 'held', pid };
}

/* ── SIGHUP delivery ───────────────────────────────────────────────────── */

/** The outcome of signalling the running service. */
export type SignalDelivery =
  | { readonly delivered: true }
  | {
      readonly delivered: false;
      /** `no-process` — ESRCH; `permission` — EPERM; `failure` — anything else. */
      readonly reason: 'no-process' | 'permission' | 'failure';
      /** The error message, for the failure detail of the rendered line. */
      readonly detail: string;
    };

/**
 * Classifies a thrown `process.kill` error for the handler's guidance arms.
 * Pure over the thrown value, so every errno arm is a table test — a real
 * `EPERM` cannot be produced deterministically under the container uid
 * (signalling pid 1 to provoke it is environment-dependent and dangerous),
 * the same reason the landed single-instance suite drives its `EPERM` arm
 * through the seam.
 */
export function classifySignalFailure(
  error: unknown,
): Extract<SignalDelivery, { delivered: false }> {
  const detail = thrownMessage(error);
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ESRCH') return { delivered: false, reason: 'no-process', detail };
  if (code === 'EPERM') return { delivered: false, reason: 'permission', detail };
  return { delivered: false, reason: 'failure', detail };
}

/**
 * The production delivery: one SIGHUP to the holder pid via `process.kill`.
 * `process.kill` is synchronous — Node's syscall wrapper resolves the errno
 * before returning — so the outcome is complete when this returns.
 */
export function sendSighup(pid: number): SignalDelivery {
  try {
    process.kill(pid, 'SIGHUP');
    return { delivered: true };
  } catch (error) {
    return classifySignalFailure(error);
  }
}

/* ── Outcome renderers ─────────────────────────────────────────────────── */

/** §5.2's helpful next step when no service instance is running. */
export function renderNotRunningGuidance(): string {
  return [
    'Service reload: there is no running service to reload.',
    'An installed service starts with quotameter start; without installation, run it in the foreground:',
    '  quotameter run',
    'Or set everything up in one step: quotameter init',
    'Check what is running: quotameter status',
  ].join('\n');
}

/**
 * The stale-lock outcome: the holder pid is gone, so the service stopped
 * without releasing its lock (a crash — §5.6's next starter breaks the lock
 * automatically, and the recycled-pid residual is the lock protocol's own,
 * D-017). The remedy sentence mirrors the lock module's refusal wording.
 */
export function renderStaleLockGuidance(pid: number, lockPath: string): string {
  return [
    `Service reload: the lock file still names pid ${pid}, which is not running — the service stopped without releasing it (the next start clears it automatically).`,
    'Start the service with quotameter start, or run it in the foreground with quotameter run, then reload again.',
    `If pid ${pid} is not running quotameter (for example a recycled pid), remove ${lockPath} and start again.`,
  ].join('\n');
}

/** The unreadable-lock outcome: the running service cannot be identified. */
export function renderUnreadableLockSteps(lockPath: string): string {
  return [
    `Service reload: the lock file ${lockPath} exists but cannot be read, so the running service cannot be identified.`,
    'Check the data directory permissions and what the service is doing:',
    '  quotameter status',
  ].join('\n');
}

/**
 * The invalid-lock outcome: damaged content. The remedy mirrors the lock
 * module's own refusal guidance for a file it cannot interpret.
 */
export function renderInvalidLockSteps(lockPath: string): string {
  return [
    `Service reload: ${lockPath} is not a valid quotameter lock file, so the running service cannot be identified.`,
    'Verify that no quotameter process is running, then remove the file and start the service again.',
  ].join('\n');
}

/** The rejected outcome: §6.2's guarantee, restated, with the fix path. */
export function renderRejectedOutcome(configPath: string): string {
  return [
    'Service reload: the configuration is invalid — the service would reject it and keep the last valid configuration, so no SIGHUP was sent.',
    `Configuration file: ${configPath}`,
    'Each problem is reported on stderr. Fix the file, then run quotameter reload again.',
    'The running service keeps its current settings.',
  ].join('\n');
}

/**
 * The accepted outcome: validation passed and the signal went out. The §6.4
 * advisory names the live settings (the `RELOAD_FIELDS` live half, D-026 —
 * §6.4's five groups plus `logging.level` and `auth.passwordHash`) and the
 * restart-requiring trio, phrased for BOTH run modes the lock-based
 * discovery supports (`quotameter restart` is an installed-service command;
 * a foreground run restarts by being stopped and started again — review
 * round P2). The CLI does not claim the service's own
 * applied-vs-pending-restart classification (only its reloader can diff
 * against the in-memory configuration; D-112), and the authoritative record
 * is the service's `configuration reloaded` log line — journald for an
 * installed unit, the terminal for a foreground run.
 */
export function renderAcceptedOutcome(pid: number, configPath: string): string {
  return [
    `Service reload: the configuration is valid and SIGHUP was delivered to the running service (pid ${pid}) — reload accepted.`,
    `Validated with the same checks the service applies on SIGHUP: ${configPath}`,
    'Live settings (accounts, time zone, polling interval, retention, provider peak-hour schedule, logging level, web password) apply without a restart.',
    'Changes to server.host, server.port, or auth.mode need a restart:',
    '  quotameter restart      (an installed service)',
    '  Ctrl-C, then quotameter run again      (a foreground run)',
    'The service writes its own reload record to its logs (quotameter logs, an installed service) or, in the foreground, to its terminal.',
  ].join('\n');
}

/**
 * The permission-denied outcome: the service runs as another user. The
 * owner-account step comes first (review round P3): sudo's default
 * `env_reset` drops the very `QUOTAMETER_*` path override that located the
 * lock in the failing run, so a plain sudo re-run can resolve a different
 * data directory — the sudo line names the repetition explicitly.
 */
export function renderPermissionDeniedSteps(pid: number): string {
  return [
    `Service reload: SIGHUP could not be delivered to pid ${pid} — the process belongs to another user, so this run may not signal it.`,
    "Run the command from the service owner's own account:",
    '  quotameter reload',
    'Or with sudo from a regular account (repeat any QUOTAMETER_* path override this run used — sudo drops it by default):',
    '  sudo quotameter reload',
  ].join('\n');
}

/** The exited-meanwhile outcome: the pid died between discovery and signal. */
export function renderExitedSteps(pid: number): string {
  return [
    `Service reload: pid ${pid} stopped meanwhile — there is no running service to reload.`,
    'Start it again (quotameter start, or quotameter run in the foreground), then reload again.',
  ].join('\n');
}

/* ── The handler ───────────────────────────────────────────────────────── */

/** The configuration-validation seam; production `loadConfigWithEnv`. */
export type ConfigValidation = (
  configPath: string,
  env: NodeJS.ProcessEnv,
) => Promise<ConfigEnvLoadResult>;

/** Injectable collaborators; every one has a production default. */
export interface ServiceReloadDeps {
  /** The §5.3 step 1 owner resolution (task 136, D-105); production `resolveServiceOwner`. */
  readonly resolveOwner?: () => ServiceOwnerResolution;
  /**
   * The environment both the owner-scoped §6.1 directories and the
   * configuration validation read; production `process.env`. `HOME` is
   * always forced to the owner's home for the directories (a privileged run
   * must resolve the owner's data directory, never root's), while the
   * validation reads the `QUOTAMETER_*` overrides of this invocation.
   */
  readonly pathEnv?: PathEnv;
  /** Reads the single-instance lock; production {@link readServiceLock}. */
  readonly readLock?: (lockPath: string) => Promise<ServiceLockRead>;
  /** Liveness probe for the recorded holder pid; production `isProcessAlive`. */
  readonly isAlive?: (pid: number) => boolean;
  /** Delivers SIGHUP; production {@link sendSighup}. */
  readonly deliverSignal?: (pid: number) => SignalDelivery;
  /** The pre-flight validation; production `loadConfigWithEnv`. */
  readonly validate?: ConfigValidation;
}

/**
 * Builds the §5.2 `quotameter reload` handler (task 141, D-112): resolves
 * the owner, discovers the running service through the §5.6 lock of the
 * owner's data directory, answers accepted/rejected by re-running the load
 * pipeline in-process, and delivers SIGHUP only for a validated
 * configuration. Never throws; returns the process exit code.
 */
export function runReloadCommand(deps: ServiceReloadDeps = {}): CliHandler {
  return async (ctx: CliContext): Promise<number> => {
    const errorPrefix = `quotameter ${ctx.commandPath.join(' ')}`;
    const owner = resolveOwnerForCommand(ctx.output, deps, errorPrefix);
    if (owner === null) {
      return 1;
    }
    const env = deps.pathEnv ?? process.env;
    let directories: { readonly configDir: string; readonly dataDir: string };
    try {
      directories = ownerUnitDirectories(owner.user, env);
    } catch (error) {
      ctx.output.err(
        failureLine(errorPrefix, 'resolving the service directories failed', thrownMessage(error)),
      );
      return 1;
    }

    // Discovery precedes validation: with no running service there is
    // nothing to reload into, and the configuration's validity is moot.
    const lockPath = lockFilePath(directories.dataDir);
    const lock = await (deps.readLock ?? readServiceLock)(lockPath);
    if (lock.state === 'absent') {
      ctx.output.err(
        `${errorPrefix}: the quotameter service is not running — no instance holds the data directory ${directories.dataDir}`,
      );
      ctx.output.out(renderNotRunningGuidance());
      return 1;
    }
    if (lock.state === 'unreadable') {
      ctx.output.err(
        failureLine(errorPrefix, `reading the service lock ${lockPath} failed`, lock.detail),
      );
      ctx.output.out(renderUnreadableLockSteps(lockPath));
      return 1;
    }
    if (lock.state === 'invalid') {
      ctx.output.err(
        failureLine(errorPrefix, `${lockPath} is not a valid quotameter lock file`, ''),
      );
      ctx.output.out(renderInvalidLockSteps(lockPath));
      return 1;
    }
    const isAlive = deps.isAlive ?? isProcessAlive;
    if (!isAlive(lock.pid)) {
      ctx.output.err(
        `${errorPrefix}: the quotameter service is not running — the lock file still names pid ${lock.pid}, which is not running`,
      );
      ctx.output.out(renderStaleLockGuidance(lock.pid, lockPath));
      return 1;
    }

    const configPath = configFilePath(directories.configDir);
    const validate = deps.validate ?? loadConfigWithEnv;
    const validated = await validate(configPath, env);
    if (!validated.ok) {
      // §6.2: the service would reject this file and keep the last valid
      // configuration — a signal cannot change anything, so none is sent
      // (D-112). The pipeline's problems are field-addressed and value-free
      // (D-018), safe to print verbatim.
      for (const problem of validated.problems) {
        ctx.output.err(`${errorPrefix}: ${problem}`);
      }
      ctx.output.out(renderRejectedOutcome(configPath));
      return 1;
    }

    const delivery = (deps.deliverSignal ?? sendSighup)(lock.pid);
    if (!delivery.delivered) {
      if (delivery.reason === 'no-process') {
        ctx.output.err(
          `${errorPrefix}: the service (pid ${lock.pid}) exited before the signal could be delivered`,
        );
        ctx.output.out(renderExitedSteps(lock.pid));
        return 1;
      }
      if (delivery.reason === 'permission') {
        ctx.output.err(
          `${errorPrefix}: permission denied — the service (pid ${lock.pid}) runs as a different user, so this run may not signal it`,
        );
        ctx.output.out(renderPermissionDeniedSteps(lock.pid));
        return 1;
      }
      ctx.output.err(
        failureLine(errorPrefix, `signaling the service (pid ${lock.pid}) failed`, delivery.detail),
      );
      return 1;
    }
    ctx.output.out(renderAcceptedOutcome(lock.pid, configPath));
    return 0;
  };
}
