/**
 * The `quotameter logs` command handler (task 143, spec §5.2/§16; decision
 * D-116).
 *
 * §5.2: "`quotameter logs` — Convenient `journalctl` wrapper for system or
 * user service"; §16: "Use Pino JSON logs on stdout/stderr, collected by
 * journald. … `quotameter logs` wraps `journalctl` conveniently." The
 * wrapper's product is the correct scope plus useful defaults; it composes
 * the landed layers, each fact from the layer that owns it:
 *
 * - **Scope** — D-110's installed-unit disk discovery (the 140 handler's
 *   shape), never a re-derived install route: which unit file exists decides
 *   whether `journalctl -u quotameter.service` or `journalctl --user -u
 *   quotameter.service` runs. Both existing is the mistake task 139 warns
 *   about: D-108's privileges-select rule applies and the cross-unit note
 *   (shared with 140) is printed on stderr **before** the stream — after a
 *   follow it would be lost under the entries.
 * - **Foreground-run honesty** — D-112's lock read (`readServiceLock` +
 *   `isProcessAlive`), consulted **only on the nothing-installed path**: a
 *   foreground `quotameter run` has no journal at all — its messages are on
 *   the terminal it was started from — so a live lock holder there gets the
 *   honest "nothing to show" guidance naming the pid. An installed unit's
 *   journal is read regardless of running state (journals persist across
 *   stops), so the lock is irrelevant on the installed paths.
 * - **Reading is unprivileged** — D-105's vocabulary names journalctl
 *   queries service-owner operations: the system journal is read in-process
 *   whatever this invocation's privileges are; an OS-level refusal (exit
 *   non-zero) renders the `sudo journalctl …` remedy instead of a refusal,
 *   and a privileged run facing a user unit is sent to the regular account
 *   (root's `--user` query would filter root's journal, never the owner's —
 *   the D-105 never-reach-into-the-user-manager rule).
 * - **Manager reachability** — the 140/142 capability gates, mirrored: no
 *   systemd means no journal at all (journald is part of it), and an
 *   unreachable user manager gets the exact next-login-session command,
 *   both honest failures with steps.
 *
 * **Streaming (D-116)**: `runJournalctlPassthrough` spawns journalctl with
 * piped stdio, forwards stdout chunks **raw** to the process's stdout as
 * they arrive (no line reassembly — follow mode is a live stream; the raw
 * byte path is the one documented exception to the `CliOutput` line
 * contract), captures stderr bounded (the house cap) for the failure
 * detail, and forwards SIGINT/SIGTERM to the child — a Ctrl-C ends a
 * follow as success, the `docker logs -f` convention, and a second signal
 * escalates to SIGKILL so a wedged child cannot hold the terminal. A
 * closed output pipe (`| head`, EPIPE) gets the same stop-early
 * semantics instead of an unhandled stream error, and `write`-reported
 * backpressure pauses the child until the sink drains. journalctl itself
 * missing is detected through the spawn error arm (ENOENT and friends),
 * not a PATH probe.
 *
 * **Exit codes**: 0 exactly when journalctl ran and exited 0, or was
 * interrupted through a forwarded signal; every other outcome — owner
 * problems, an unusable owner home, nothing installed (foreground or not),
 * a privileged run facing a user unit, an unavailable manager, a missing
 * journalctl, or a failed journalctl — exits 1 with the failure on stderr
 * and actionable steps on stdout. The handler's own logic never throws
 * (the owner resolution's broken-system throw included, D-110's contract);
 * a rejecting injected seam propagates to the dispatcher's exit-1 failure
 * arm, exactly the landed 140/141/142 shape.
 */

import { spawn } from 'node:child_process';
import type { PathEnv } from '../config/paths';
import { isProcessAlive, lockFilePath } from '../server/single-instance';
import type { CliContext, CliHandler } from './commands';
import { otherUnitWarning } from './service-control';
import {
  ownerUnitDirectories,
  resolveOwnerForCommand,
  unitFileExistsOnDisk,
} from './service-install';
import type { ServiceOwnerContext, ServiceOwnerResolution } from './service-owner';
import { readServiceLock, type ServiceLockRead } from './service-reload';
import {
  failureLine,
  firstDiagnosticLine,
  probeServiceCapabilities,
  STDERR_CAPTURE_CAP,
  thrownMessage,
  type CapabilityProbe,
} from './service-setup';
import { SYSTEM_UNIT_INSTALL_PATH, SYSTEM_UNIT_NAME } from './systemd-unit';
import { userUnitInstallPath, USER_UNIT_NAME } from './systemd-user-unit';

/* ── The flag surface (D-116: §5.2/§16 name no defaults — these are the
   wrapper's convenience contract) ──────────────────────────────────────── */

/** The default tail: journalctl's own 10 is too short for Pino JSON lines. */
export const LOGS_DEFAULT_LINES = 100;

/**
 * The default output format: wall-clock timestamps with microsecond
 * precision around §16's JSON message (`cat` shows the raw JSON line only,
 * `json` the full journal record).
 */
export const LOGS_DEFAULT_OUTPUT = 'short-precise';

/**
 * The closed `--output` enum — journalctl's stable, human-facing formats
 * (the binary/export/`json-sse`/`json-seq` shapes are tooling formats, not
 * views). A closed set keeps the help honest and a typo an immediate,
 * self-explaining failure instead of journalctl's own.
 */
export const LOG_OUTPUT_FORMATS: readonly string[] = Object.freeze([
  'cat',
  'json',
  'json-pretty',
  'short',
  'short-full',
  'short-iso',
  'short-iso-precise',
  'short-monotonic',
  'short-precise',
  'verbose',
  'with-unit',
]);

/** The `--lines` flag's parse result: a count, `all`, or one problem line. */
export type LogLinesParse =
  | { readonly ok: true; readonly lines: number | 'all' }
  | { readonly ok: false; readonly problem: string };

/**
 * Parses `--lines`: `all` (the entire backlog) or a plain decimal string of
 * whole lines >= 1 within the safe-integer range — the `--restart-sec`
 * grammar, so no flag value can pass here and confuse journalctl.
 */
export function parseLogLines(value: string): LogLinesParse {
  if (value === 'all') return { ok: true, lines: 'all' };
  if (!/^\d+$/.test(value)) {
    return {
      ok: false,
      problem: `--lines must be a whole number of lines >= 1 or all (got ${JSON.stringify(value)})`,
    };
  }
  const lines = Number(value);
  if (!Number.isSafeInteger(lines) || lines < 1) {
    return {
      ok: false,
      problem: `--lines must be a whole number of lines >= 1 or all (got ${JSON.stringify(value)})`,
    };
  }
  return { ok: true, lines };
}

/** The `--output` flag's parse result. */
export type LogOutputParse =
  { readonly ok: true; readonly format: string } | { readonly ok: false; readonly problem: string };

/** Parses `--output` against the closed enum, listing every allowed value. */
export function parseLogOutputFormat(value: string): LogOutputParse {
  if (LOG_OUTPUT_FORMATS.includes(value)) return { ok: true, format: value };
  return {
    ok: false,
    problem: `--output must be one of: ${LOG_OUTPUT_FORMATS.join(', ')} (got ${JSON.stringify(value)})`,
  };
}

/** Everything the journalctl vector needs; pure data, table-pinned. */
export interface JournalctlCommandInput {
  /** The installed unit's manager scope (D-110's discovery decides). */
  readonly kind: 'system' | 'user';
  /** `--follow`: stream new entries until interrupted. */
  readonly follow: boolean;
  /** A whole number of lines >= 1, or `all` for the entire backlog. */
  readonly lines: number | 'all';
  /** One of {@link LOG_OUTPUT_FORMATS}. */
  readonly output: string;
}

/**
 * Builds the exact journalctl invocation: the scope flag first, the
 * convenience defaults (`--no-pager` always — the wrapper keeps the user's
 * scrollback; the line count; the output format), `-f` only when following,
 * and the unit match last. Deterministic order, byte-pinned by tests.
 */
export function buildJournalctlCommand(input: JournalctlCommandInput): readonly string[] {
  const command = ['journalctl'];
  if (input.kind === 'user') command.push('--user');
  command.push('--no-pager', `--lines=${input.lines}`, `--output=${input.output}`);
  if (input.follow) command.push('-f');
  command.push('-u', input.kind === 'system' ? SYSTEM_UNIT_NAME : USER_UNIT_NAME);
  return command;
}

/* ── The streaming passthrough seam ────────────────────────────────────── */

/** The outcome of one journalctl run through {@link runJournalctlPassthrough}. */
export type LogViewerOutcome =
  /**
   * journalctl ran and exited 0, or was ended by a forwarded interrupt —
   * both successes (`interrupted` distinguishes the Ctrl-C shape).
   */
  | { readonly ok: true; readonly interrupted: boolean }
  | {
      readonly ok: false;
      /** `true` — journalctl never ran (missing binary, not executable). */
      readonly spawnFailed: boolean;
      /** One bounded diagnostic line: the spawn error, journalctl's first stderr line, or the exit status. */
      readonly detail: string;
    };

/** Runs the journalctl command; production {@link runJournalctlPassthrough}. */
export type LogViewerRunner = (command: readonly string[]) => Promise<LogViewerOutcome>;

/** The bounded stderr capture of one run; {@link appendCappedStderrChunk} maintains it. */
export interface StderrCapture {
  /** The captured chunks, in order; together never longer than the cap. */
  readonly chunks: Buffer[];
  /** The total captured length. */
  size: number;
}

/**
 * Appends one stderr chunk to the capture, never storing more than the
 * house cap: a chunk that crosses the line is sliced to the remaining
 * allowance, later chunks are ignored. The failure detail is one trimmed
 * line, so the first chunk (the first complaint) always survives intact.
 */
export function appendCappedStderrChunk(capture: StderrCapture, chunk: Buffer): void {
  const remaining = STDERR_CAPTURE_CAP - capture.size;
  if (remaining <= 0) return;
  const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  capture.chunks.push(slice);
  capture.size += slice.length;
}

/**
 * The production viewer: spawns the command, forwards every stdout chunk
 * **raw** to `process.stdout` as it arrives (the stream is the product — no
 * line reassembly, no buffering, follow mode included; the raw byte path is
 * the one documented exception to the `CliOutput` line contract, whose
 * one-newline semantics cannot express a child's live stream), captures
 * stderr bounded for the failure detail, and forwards SIGINT/SIGTERM to
 * the child — a Ctrl-C ends a follow as success, the `docker logs -f`
 * convention; a **second** signal escalates to SIGKILL so a wedged child
 * cannot hold the terminal hostage. A closed output pipe (`quotameter
 * logs | head`, EPIPE on `process.stdout`) gets the same stop-early
 * semantics: the child is terminated and the run resolves as an
 * interrupted success instead of crashing on an unhandled stream error —
 * and when `write` reports backpressure, the child's stdout is paused
 * until the sink drains, so `--lines=all` over a slow pipe cannot queue
 * the whole journal in memory. journalctl's own stderr is part of its
 * product: on a successful exit a non-empty capture is flushed to
 * `process.stderr` (warnings must not vanish), while a failed exit quotes
 * the first line in the failure detail. The forwarders, stream-error
 * listeners, and any pending drain handler are removed when the child
 * closes, restoring the process's default dispositions.
 */
export function runJournalctlPassthrough(command: readonly string[]): Promise<LogViewerOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let interrupted = false;
    let streamFailure: string | null = null;
    let signalsForwarded = 0;
    let drainHandler: (() => void) | null = null;
    const stderrCapture: StderrCapture = { chunks: [], size: 0 };
    const forwarders = new Map<NodeJS.Signals, () => void>();
    const onStdoutError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EPIPE') {
        // The consumer of this run's output closed (`| head`): the same
        // stop-early semantics as a Ctrl-C, never an unhandled stream
        // error crashing the CLI.
        interrupted = true;
        child.kill('SIGTERM');
        return;
      }
      streamFailure = firstDiagnosticLine(error.message);
      child.kill('SIGKILL');
    };
    const onStderrError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EPIPE') return; // nowhere is left to report anything
      streamFailure ??= firstDiagnosticLine(error.message);
      child.kill('SIGKILL');
    };
    const cleanup = (): void => {
      for (const [signal, handler] of forwarders) {
        process.removeListener(signal, handler);
      }
      process.stdout.removeListener('error', onStdoutError);
      process.stderr.removeListener('error', onStderrError);
      if (drainHandler !== null) {
        process.stdout.removeListener('drain', drainHandler);
      }
    };
    // A spawn failure fires only `error` (the process never ran, so no
    // `close` follows), and a resolved promise keeps its first value — the
    // arms below cannot race into a wrong outcome.
    process.stdout.on('error', onStdoutError);
    process.stderr.on('error', onStderrError);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = (): void => {
        interrupted = true;
        signalsForwarded += 1;
        child.kill(signalsForwarded >= 2 ? 'SIGKILL' : signal);
      };
      process.on(signal, handler);
      forwarders.set(signal, handler);
    }
    // A paused stdout would never see EOF, so the child's `close` could
    // wait forever on a backpressured stream — resume once the process
    // itself ended, letting the stream drain to its end.
    child.once('exit', () => {
      child.stdout.resume();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      // Backpressure: stop reading the child until the sink drains.
      if (!process.stdout.write(chunk)) {
        child.stdout.pause();
        if (drainHandler !== null) {
          process.stdout.removeListener('drain', drainHandler);
        }
        drainHandler = () => {
          child.stdout.resume();
        };
        process.stdout.once('drain', drainHandler);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      appendCappedStderrChunk(stderrCapture, chunk);
    });
    child.once('error', (error: Error) => {
      cleanup();
      resolve({ ok: false, spawnFailed: true, detail: firstDiagnosticLine(error.message) });
    });
    child.once('close', (code: number | null) => {
      const captured = Buffer.concat(stderrCapture.chunks).toString('utf8');
      if ((code === 0 || interrupted) && streamFailure === null) {
        if (captured !== '') {
          process.stderr.write(captured);
        }
        cleanup();
        resolve({ ok: true, interrupted });
        return;
      }
      const detail =
        streamFailure ??
        (firstDiagnosticLine(captured) ||
          (code === null ? 'the command was terminated' : `exit status ${code}`));
      cleanup();
      resolve({ ok: false, spawnFailed: false, detail });
    });
  });
}

/* ── Outcome renderers ─────────────────────────────────────────────────── */

/** §5.2's helpful next step when no service is installed at all. */
export function renderNotInstalledSteps(): string {
  return [
    'Service logs: no systemd service is installed, so there is no journal to read.',
    'A foreground run (quotameter run) logs to its own terminal, not to the journal.',
    'Install the service to keep its logs in the journal:',
    '  sudo quotameter service install   (system service)',
    '  quotameter service install        (user service, no sudo needed)',
    'Or set everything up in one step: quotameter init',
  ].join('\n');
}

/**
 * The foreground-run outcome (D-112's lock found a live holder, nothing is
 * installed): the running service's messages are on its own terminal —
 * there is no journal, and the wrapper says so instead of showing nothing.
 */
export function renderForegroundRunSteps(pid: number): string {
  return [
    `Service logs: the service is running in the foreground (pid ${pid}) — a foreground run logs to the terminal it was started from, not to the journal, so there is nothing for this wrapper to show.`,
    'No systemd service is installed on this machine either.',
    'Install the service to keep its logs in the journal:',
    '  sudo quotameter service install   (system service)',
    '  quotameter service install        (user service, no sudo needed)',
  ].join('\n');
}

/** The systemd-less outcome for an installed unit: no systemd, no journal. */
export function renderManagerlessSteps(kind: 'system' | 'user', installPath: string): string {
  return [
    `Service logs: systemd is not available on this machine, so the installed ${kind} service's journal cannot be read here — the journal is collected by systemd's journald.`,
    `The unit file is ${installPath}.`,
    'Check what the service is doing without the journal:',
    '  quotameter status',
  ].join('\n');
}

/**
 * The privileged-run outcome for an installed user unit (D-105's rule): a
 * `--user` journal query under sudo would read root's own user units, never
 * the owner's — the command belongs to the regular account.
 */
export function renderUserFromRegularAccountSteps(ownerName: string): string {
  return [
    `Service logs: a user service is installed for ${ownerName}, but this run holds root privileges — a --user journal query under sudo reads root's journal, not ${ownerName}'s.`,
    'Run the command from the regular account without sudo:',
    '  quotameter logs',
  ].join('\n');
}

/** The unreachable user-manager outcome: the exact command for the next login session. */
export function renderUserSessionSteps(installPath: string): string {
  return [
    "Service logs: the systemd user manager is not reachable in this session, so the user service's journal cannot be read here.",
    `The unit file is ${installPath}. Once you have a login session, run:`,
    `  journalctl --user -u ${USER_UNIT_NAME}`,
  ].join('\n');
}

/** The journalctl-missing outcome (the spawn error arm). */
export function renderJournalctlMissingSteps(): string {
  return [
    'Service logs: journalctl could not be started — it ships with systemd, so it is missing or not executable on this machine.',
    'Check the systemd installation (journalctl usually lives in /usr/bin), then run the command again.',
    'The service state is available without the journal:',
    '  quotameter status',
  ].join('\n');
}

/**
 * The failed-read outcome: the exact direct journalctl command for the
 * scope, rebuilt from the vector that ran — the user's own flags (`-f`,
 * `-n`, `-o`) carry over, so the remedy is what they asked for, not the
 * defaults.
 */
export function renderJournalctlFailedSteps(
  command: readonly string[],
  kind: 'system' | 'user',
): string {
  const retry = kind === 'system' ? `sudo ${command.join(' ')}` : command.join(' ');
  const lead =
    kind === 'system'
      ? 'the system journal usually requires root or journal-access group membership (systemd-journal, adm) to read'
      : "the user journal needs a login session of the owner's account — try again from there";
  return [
    'Service logs: the journal could not be read — journalctl exited with an error; its first complaint is quoted in the detail above.',
    `On a ${kind} service, ${lead}.`,
    'Read the journal directly with:',
    `  ${retry}`,
    'Also check the service itself:',
    '  quotameter status',
  ].join('\n');
}

/* ── The handler ───────────────────────────────────────────────────────── */

/** Injectable collaborators; every one has a production default. */
export interface ServiceLogsDeps {
  /** The §5.3 step 1 owner resolution (task 136, D-105); production `resolveServiceOwner`. */
  readonly resolveOwner?: () => ServiceOwnerResolution;
  /** The §5.3 step 1 capability probe (task 137); production `probeServiceCapabilities`. */
  readonly probeCapabilities?: CapabilityProbe;
  /** Whether a unit file is on disk; production `unitFileExistsOnDisk` (task 139). */
  readonly unitFileExists?: (installPath: string) => boolean;
  /**
   * The environment the owner-scoped §6.1 data directory (the §5.6 lock's
   * home) resolves from; production `process.env` — read only on the
   * nothing-installed path, for the foreground-run check (D-112 discipline).
   */
  readonly pathEnv?: PathEnv;
  /** Reads the single-instance lock; production `readServiceLock` (task 141). */
  readonly readLock?: (lockPath: string) => Promise<ServiceLockRead>;
  /** Liveness probe for the recorded holder pid; production `isProcessAlive`. */
  readonly isAlive?: (pid: number) => boolean;
  /** The journalctl passthrough executor; production `runJournalctlPassthrough`. */
  readonly runViewer?: LogViewerRunner;
}

/**
 * The nothing-installed path: the §5.2 helpful next step, preceded by
 * D-112's foreground-run check — a live lock holder is a foreground
 * `quotameter run`, which has no journal, and gets the honest guidance
 * naming its pid. The lock read is best-effort here: it cannot change the
 * primary answer (nothing installed means no journal either way), so an
 * unreadable or invalid lock costs one stderr line, never the steps. The
 * directories call cannot throw on this path: `userUnitInstallPath` has
 * already validated the owner's home (an unusable home exited the command
 * above), so `resolvePaths` runs with an absolute forced `HOME` — its only
 * throwing arm (D-012's no-usable-home error) is precluded.
 */
async function reportNoJournal(
  ctx: CliContext,
  deps: ServiceLogsDeps,
  owner: ServiceOwnerContext,
  errorPrefix: string,
): Promise<number> {
  ctx.output.err(`${errorPrefix}: no systemd service is installed — there is no journal to read`);
  const env = deps.pathEnv ?? process.env;
  const lockPath = lockFilePath(ownerUnitDirectories(owner.user, env).dataDir);
  const lock = await (deps.readLock ?? readServiceLock)(lockPath);
  if (lock.state === 'held') {
    const isAlive = deps.isAlive ?? isProcessAlive;
    if (isAlive(lock.pid)) {
      ctx.output.out(renderForegroundRunSteps(lock.pid));
      return 1;
    }
    // A dead holder is 142's report, not a journal question: nothing is
    // running, and the not-installed steps below answer completely.
  } else if (lock.state === 'unreadable') {
    ctx.output.err(
      failureLine(errorPrefix, `reading the service lock ${lockPath} failed`, lock.detail),
    );
  } else if (lock.state === 'invalid') {
    ctx.output.err(failureLine(errorPrefix, `${lockPath} is not a valid quotameter lock file`, ''));
  }
  ctx.output.out(renderNotInstalledSteps());
  return 1;
}

/**
 * Builds the §5.2 `quotameter logs` handler (task 143, D-116): resolves the
 * owner, discovers the installed unit, and either streams its journal
 * through the passthrough runner or prints the exact steps that make the
 * invocation possible. Never throws; returns the process exit code.
 */
export function runLogsCommand(deps: ServiceLogsDeps = {}): CliHandler {
  return async (ctx: CliContext): Promise<number> => {
    const errorPrefix = `quotameter ${ctx.commandPath.join(' ')}`;
    const owner = resolveOwnerForCommand(ctx.output, deps, errorPrefix);
    if (owner === null) {
      return 1;
    }

    // Entry-evaluated seam consts (the 139/140 shape): the default arms are
    // selected the moment the command runs, before any gate decides whether
    // journalctl actually streams — the systemd-less test environments'
    // honest routes then evaluate the production defaults too.
    const capabilities = await (deps.probeCapabilities ?? probeServiceCapabilities)();
    const runViewer = deps.runViewer ?? runJournalctlPassthrough;

    const linesFlag = ctx.flags['lines'];
    const lines =
      linesFlag === undefined
        ? { ok: true as const, lines: LOGS_DEFAULT_LINES as number | 'all' }
        : parseLogLines(String(linesFlag));
    if (!lines.ok) {
      ctx.output.err(`${errorPrefix}: ${lines.problem}`);
      return 1;
    }
    const outputFlag = ctx.flags['output'];
    const output =
      outputFlag === undefined
        ? { ok: true as const, format: LOGS_DEFAULT_OUTPUT }
        : parseLogOutputFormat(String(outputFlag));
    if (!output.ok) {
      ctx.output.err(`${errorPrefix}: ${output.problem}`);
      return 1;
    }
    const follow = ctx.flags['follow'] === true;

    /* Installed scope (D-110's disk discovery, the 140 handler's shape). */
    const unitFileExists = deps.unitFileExists ?? unitFileExistsOnDisk;
    const systemUnit = unitFileExists(SYSTEM_UNIT_INSTALL_PATH);
    // The user unit lives under the owner's home; an unusable passwd home
    // cannot name that path (the 140 handler's reasoning exactly).
    let userUnitPath: string | undefined;
    try {
      userUnitPath = userUnitInstallPath(owner.user.home);
    } catch (error) {
      if (systemUnit) {
        userUnitPath = undefined;
      } else {
        ctx.output.err(
          failureLine(errorPrefix, 'resolving the user unit path failed', thrownMessage(error)),
        );
        return 1;
      }
    }
    const userUnit = userUnitPath !== undefined && unitFileExists(userUnitPath);

    if (!systemUnit && !userUnit) {
      return reportNoJournal(ctx, deps, owner, errorPrefix);
    }

    // Both units installed: privileges select (D-108's rule), and the
    // cross-unit note precedes the stream (a post-follow stderr line would
    // be lost under the entries).
    const kind: 'system' | 'user' =
      systemUnit && userUnit
        ? owner.privileges === 'held'
          ? 'system'
          : 'user'
        : systemUnit
          ? 'system'
          : 'user';
    if (systemUnit && userUnit) {
      ctx.output.err(`${errorPrefix}: ${otherUnitWarning(kind, owner.user.name)}`);
    }

    // No systemd means no journal at all — the more fundamental fact, so it
    // gates before the user-manager questions (a regular-account re-run on
    // a systemd-less machine still finds no journal).
    if (!capabilities.systemd) {
      ctx.output.err(
        `${errorPrefix}: systemd is not available on this machine, so the installed ${kind} service's journal cannot be read here`,
      );
      ctx.output.out(
        renderManagerlessSteps(kind, kind === 'system' ? SYSTEM_UNIT_INSTALL_PATH : userUnitPath!),
      );
      return 1;
    }
    if (kind === 'user') {
      if (owner.privileges === 'held') {
        ctx.output.err(
          `${errorPrefix}: a user service is installed, but this run holds root privileges — the user service's journal belongs to the regular account`,
        );
        ctx.output.out(renderUserFromRegularAccountSteps(owner.user.name));
        return 1;
      }
      if (!capabilities.userManager) {
        ctx.output.err(
          `${errorPrefix}: the systemd user manager is not reachable in this session, so the user service's journal cannot be read here`,
        );
        ctx.output.out(renderUserSessionSteps(userUnitPath!));
        return 1;
      }
    }

    const command = buildJournalctlCommand({
      kind,
      follow,
      lines: lines.lines,
      output: output.format,
    });
    const outcome = await runViewer(command);
    if (outcome.ok) {
      // The stream is the product: a clean run (and a Ctrl-C-ended follow)
      // needs no summary chatter around the entries.
      return 0;
    }
    if (outcome.spawnFailed) {
      ctx.output.err(failureLine(errorPrefix, 'journalctl is not available', outcome.detail));
      ctx.output.out(renderJournalctlMissingSteps());
      return 1;
    }
    ctx.output.err(failureLine(errorPrefix, `\`${command.join(' ')}\` failed`, outcome.detail));
    ctx.output.out(renderJournalctlFailedSteps(command, kind));
    return 1;
  };
}
