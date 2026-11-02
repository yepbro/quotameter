/**
 * The `quotameter doctor` command handler (task 145, spec §5.5; decision
 * D-119).
 *
 * §5.5: "Check Node version and `node:sqlite`, configuration-schema
 * validity, secret/config directory permissions, IANA time zone, database
 * open and `PRAGMA quick_check`, connectivity for each account, service
 * state and unit freshness, port occupancy, consistency between
 * network/authentication settings, and system clock/NTP status via
 * `timedatectl`. `quotameter doctor --raw <account>` may show sanitized
 * provider responses stored for parse failures; this diagnostic is
 * CLI-only."
 *
 * The command's product is the **check-result contract** (the
 * done-condition's own words: "checks return actionable messages and a
 * stable exit status"). Every check yields one {@link DoctorCheck} with a
 * closed status vocabulary:
 *
 * - `pass` — the check ran and found nothing needing attention; the summary
 *   states the fact it established (a version, a path, a verdict).
 * - `fail` — the check ran and found something the operator must act on;
 *   the summary names the problem and the indented detail lines name the
 *   next step (a quotameter command or a system remedy). Unlike `status`
 *   (D-114, where states never fail a question), doctor is the
 *   attention-flagging command — a stopped service or an occupied port is
 *   exactly the diagnosis its user ran it for, so those states fail here.
 * - `unavailable` — the check could not run (timedatectl on a systemd-less
 *   machine, an unreachable manager, an inconclusive credential check);
 *   the reason is stated honestly. An unavailable check never fails the
 *   exit code: a non-diagnosis is not a diagnosis (D-114's `unknown`
 *   stance, applied to exit semantics).
 * - `skip` — a precondition the check depends on was not met (an invalid
 *   configuration skips the zone, port, auth, and account checks); the
 *   summary says which precondition, and the row that failed carries the
 *   remedy.
 *
 * **Exit code: 1 exactly when at least one check is `fail`** (or the
 * pre-flight owner/directory resolution failed, which renders the standard
 * failure lines and no report); otherwise 0.
 *
 * Each check reads its fact from the layer that owns it, composed — never
 * re-derived: the runtime minimum from `src/server/main.ts` (lazily, so
 * the dispatch graph stays light), configuration validity from the
 * service's own `loadConfigWithEnv` pipeline (the D-112 precedent), the
 * §6.3 permission facts from a **diagnostic-only** stat (doctor never
 * chmods — `enforceConfigPermissions` is the fixing half, and a diagnostic
 * that mutates its subject lies about what it found), the IANA gate from
 * `src/util/clock.ts`, the database through the read-only storage sibling
 * plus `PRAGMA quick_check` (§5.5's own probe), per-account connectivity
 * through the §8.1 `validateCredentials` contract with init-account's
 * secret-scrubbing classifier (D-102), the installed scope from D-110's
 * disk probe, unit freshness from the §5.4 generator's own parser and
 * validators against `serviceExecPaths()`, manager state from the exported
 * D-114 `planManagerProbe`/`describeManagerState` pair, run-mode
 * independence from D-112's lock read, port occupancy from a real
 * ephemeral bind, the §15.1 consistency verdict from `isLoopbackHost`
 * (valid configurations) or the D-101 placeholder-hash probe (invalid
 * ones — `withPlaceholderHash`, additively exported), and the clock from
 * `timedatectl show` parsed as `Key=value` (never the human table, whose
 * wording is locale-dependent).
 *
 * `--raw <account>` (§7.4/§5.5, D-067): after the checks, the report
 * appends the account's retained sanitized payloads through the 103 read
 * path (`readRawDiagnostics` + `renderRawDiagnostics`) over the same
 * read-only database handle the Database check opened — the CLI-only
 * exposure the raw-response gate enforces structurally. The section is
 * informational: it never changes the exit code, and a blank account id is
 * a handler failure (exit 1) naming the correct spelling.
 *
 * The `node:sqlite` discipline (D-116): this module is statically imported
 * by the dispatch table, so it opens no database through any static edge —
 * every `node:sqlite`-reaching import is dynamic and sits behind the
 * existence probe (the ExperimentalWarning belongs to invocations that
 * actually open a database), and the probe module itself lives in
 * `src/storage/`, the layer the layout gate reserves for the built-in.
 */

import { spawn } from 'node:child_process';
import { existsSync, type Stats } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { type ConfigEnvLoadResult, loadConfigWithEnv, parseConfigWithEnv } from '../config/env';
import { configFilePath, parseJson } from '../config/load';
import { CONFIG_DIR_MODE } from '../config/permissions';
import type { PathEnv } from '../config/paths';
import { CONFIG_FILE_MODE } from '../config/write';
import { createAccountContext, type QuotaProvider } from '../providers/registry';
import type { QuotaRepository } from '../storage/repository';
import { isLoopbackHost, type AccountConfig, type Config } from '../schemas/config';
import { createInitialAccountProvider } from '../server/providers';
import { isProcessAlive, lockFilePath } from '../server/single-instance';
import { isValidTimeZone } from '../util/clock';
import { satisfiesMinimum } from '../util/version';
import type { CliContext, CliHandler } from './commands';
import { classifyTestFailure } from './init-account';
import { withPlaceholderHash } from './init-persist';
import { readRawDiagnostics, renderRawDiagnostics } from './raw-diagnostics';
import type { ServiceOwnerResolution } from './service-owner';
import {
  ownerUnitDirectories,
  resolveOwnerForCommand,
  unitFileExistsOnDisk,
} from './service-install';
import { readServiceLock, type ServiceLockRead } from './service-reload';
import { describeManagerState, planManagerProbe } from './service-status';
import {
  failureLine,
  firstDiagnosticLine,
  probeServiceCapabilities,
  serviceExecPaths,
  spawnServiceCommand,
  STDERR_CAPTURE_CAP,
  thrownMessage,
  type ServiceCapabilities,
  type ServiceCommandRunner,
  type ServiceExecPaths,
} from './service-setup';
import { parseUnitFile, SYSTEM_UNIT_INSTALL_PATH, validateSystemUnit } from './systemd-unit';
import { userUnitInstallPath, validateUserUnit } from './systemd-user-unit';

/* ── The check-result contract (D-119) ─────────────────────────────────── */

/** One doctor check's outcome; the closed vocabulary of D-119. */
export type CheckStatus = 'pass' | 'fail' | 'unavailable' | 'skip';

/**
 * One rendered check: a status, a single-line actionable summary, and
 * optional indented detail lines (problems, or the next-step commands a
 * `fail` row prescribes). Everything display-ready — the handler assembles,
 * the renderer joins.
 */
export interface DoctorCheck {
  readonly status: CheckStatus;
  readonly summary: string;
  readonly detail?: readonly string[];
}

/** The width every status tag pads to, so the summaries align. */
const STATUS_TAGS: Readonly<Record<CheckStatus, string>> = Object.freeze({
  pass: '[pass]',
  fail: '[fail]',
  unavailable: '[unavailable]',
  skip: '[skip]',
});

/** Where detail lines sit: exactly under the row summaries (2 + tag + 1). */
const DETAIL_INDENT = ' '.repeat(2 + STATUS_TAGS.unavailable.length + 1);

/**
 * Renders the whole report — one deterministic string, so the suites pin
 * its exact bytes (the 141/142 renderer precedent). No secret ever enters:
 * every summary and detail line is composed from paths, versions, labels,
 * and the already-secret-free problem strings of the landed layers.
 */
export function renderDoctorReport(
  checks: readonly DoctorCheck[],
  rawSection: string | null,
): string {
  const lines = ['Quotameter doctor', ''];
  for (const check of checks) {
    lines.push(
      `  ${STATUS_TAGS[check.status].padEnd(STATUS_TAGS.unavailable.length)} ${check.summary}`,
    );
    for (const detail of check.detail ?? []) {
      lines.push(`${DETAIL_INDENT}${detail}`);
    }
  }
  const failed = checks.filter((check) => check.status === 'fail').length;
  if (failed > 0) {
    const noun = failed === 1 ? 'problem' : 'problems';
    lines.push('', `${failed} ${noun} found — every [fail] row above names its next step.`);
  } else {
    const passed = checks.filter((check) => check.status === 'pass').length;
    const skipped = checks.filter((check) => check.status === 'skip').length;
    const unavailable = checks.filter((check) => check.status === 'unavailable').length;
    lines.push(
      '',
      `No problems found (${passed} passed, ${skipped} skipped, ${unavailable} unavailable).`,
    );
  }
  if (rawSection !== null) {
    lines.push('', rawSection);
  }
  return lines.join('\n');
}

/** Whether any check demands operator attention — the exit-code oracle. */
export function anyCheckFailed(checks: readonly DoctorCheck[]): boolean {
  return checks.some((check) => check.status === 'fail');
}

/* ── The system clock/NTP check (spec §5.5, via timedatectl) ───────────── */

/** The `timedatectl show` command the clock check runs (machine-readable). */
const TIME_DATECTL_COMMAND = [
  'timedatectl',
  'show',
  '--property=NTPSynchronized',
  '--property=NTP',
] as const;

/**
 * How long the clock check waits for `timedatectl` before killing it: the
 * command answers from a local daemon in well under a second on a healthy
 * machine, so a few seconds bound a slow one while a wedged D-Bus cannot
 * hang the whole diagnostic.
 */
export const TIME_DATECTL_TIMEOUT_MS = 5000;

/** What one `timedatectl show` run established. */
export interface TimedatectlRead {
  /** Whether the command ran and exited 0. */
  readonly ok: boolean;
  /** Its captured stdout (bounded), empty on failure. */
  readonly stdout: string;
  /** One bounded diagnostic line from stderr (or the spawn error). */
  readonly detail: string;
}

/**
 * The clock facts parsed from `timedatectl show` output: `undefined` for a
 * key the output did not carry. Only the boolean properties are read —
 * timestamps in the report would be stale the moment they print.
 */
export interface ClockSyncFacts {
  readonly synchronized: boolean | undefined;
  readonly ntpActive: boolean | undefined;
}

/**
 * Parses `timedatectl show --property=NTPSynchronized --property=NTP`
 * output: one `Key=value` pair per line, `yes`/`no` boolean values (case
 * insensitive), anything else — including absent keys — reading as
 * `undefined`. The human `timedatectl` table is deliberately never parsed:
 * its wording is locale-dependent, `show` output is a stable contract.
 */
export function parseTimedatectlShow(stdout: string): ClockSyncFacts {
  let synchronized: boolean | undefined;
  let ntpActive: boolean | undefined;
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    const parsed = value === 'yes' ? true : value === 'no' ? false : undefined;
    if (key === 'NTPSynchronized') synchronized = parsed;
    if (key === 'NTP') ntpActive = parsed;
  }
  return { synchronized, ntpActive };
}

/**
 * The production `timedatectl` runner: spawns the show command, captures
 * stdout and stderr each bounded to the house cap (a malfunctioning child
 * cannot buffer unbounded output), and resolves the exit status plus one
 * diagnostic line — a spawn error (missing binary, systemd-less machine)
 * is a normal `ok: false` outcome, because an unavailable clock answer is
 * a check result, never a crash (`spawnServiceCommand` cannot be reused
 * here: it ignores stdout by design, and stdout is this check's product).
 * A child that neither exits nor errors within
 * {@link TIME_DATECTL_TIMEOUT_MS} is killed and read as failed — a wedged
 * D-Bus must not hang the whole diagnostic on its clock row (review round
 * P3). The command is a parameter so the timeout arm is testable against
 * a real sleeping child.
 */
export function runTimedatectlShow(
  command: readonly string[] = TIME_DATECTL_COMMAND,
  timeoutMs: number = TIME_DATECTL_TIMEOUT_MS,
): Promise<TimedatectlRead> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBuffered = 0;
    let stderrBuffered = 0;
    let settled = false;
    const settle = (read: TimedatectlRead): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(read);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ ok: false, stdout: '', detail: 'timed out' });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBuffered < STDERR_CAPTURE_CAP) {
        stdout.push(chunk);
        stdoutBuffered += chunk.length;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBuffered < STDERR_CAPTURE_CAP) {
        stderr.push(chunk);
        stderrBuffered += chunk.length;
      }
    });
    child.once('error', (error: Error) => {
      settle({ ok: false, stdout: '', detail: firstDiagnosticLine(error.message) });
    });
    child.once('close', (code: number | null) => {
      if (code === 0) {
        settle({ ok: true, stdout: Buffer.concat(stdout).toString('utf8'), detail: '' });
        return;
      }
      const detail =
        firstDiagnosticLine(Buffer.concat(stderr).toString('utf8')) ||
        (code === null ? 'the command was terminated' : `exit status ${code}`);
      settle({ ok: false, stdout: '', detail });
    });
  });
}

/** The clock check over one read: the D-119 vocabulary, §5.5's remedy. */
export function clockCheck(read: TimedatectlRead): DoctorCheck {
  if (!read.ok) {
    return {
      status: 'unavailable',
      summary: `cannot determine the system clock state — timedatectl failed (${read.detail})`,
    };
  }
  const facts = parseTimedatectlShow(read.stdout);
  if (facts.synchronized === true && facts.ntpActive === true) {
    return { status: 'pass', summary: 'system clock synchronized, NTP service active' };
  }
  if (facts.synchronized === false) {
    return {
      status: 'fail',
      summary: 'system clock is not synchronized — timestamps and schedules depend on it',
      detail: ['sudo timedatectl set-ntp true'],
    };
  }
  if (facts.ntpActive === false) {
    return {
      status: 'fail',
      summary:
        'system clock is synchronized but the NTP service is inactive — the clock will drift',
      detail: ['sudo timedatectl set-ntp true'],
    };
  }
  return {
    status: 'unavailable',
    summary: 'cannot determine the system clock state — timedatectl output was not recognizable',
  };
}

/* ── The database check (spec §5.5: open + PRAGMA quick_check) ─────────── */

/**
 * The on-disk database name inside a data directory — storage's
 * `DATABASE_FILENAME` contract, restated (as tasks 142/144 did) so the
 * existence probe runs **before** any storage module loads: the
 * ExperimentalWarning then belongs to invocations that actually open a
 * database (the D-116 lazy-import discipline).
 */
const DATABASE_FILENAME = 'quotameter.sqlite';

/** What opening the data directory's database for doctor established. */
export type DoctorDatabaseRead =
  /** No database file — no service ever opened this data directory. */
  | { readonly state: 'absent' }
  /**
   * An open read-only connection with its repository facade. The caller
   * must call `close` after both the Database check and any `--raw`
   * section finished with it.
   */
  | {
      readonly state: 'open';
      readonly runQuickCheck: () => unknown[];
      readonly repository: QuotaRepository;
      readonly close: () => void;
    }
  /** The database exists but cannot be opened; `detail` explains. */
  | { readonly state: 'failed'; readonly detail: string };

/**
 * Opens the data directory's database for the doctor reads — an existing
 * file only, **read-only** (the D-114 `status` stance: a diagnostic never
 * creates a database and never writes pages, so no hot-journal recovery
 * happens as another user under `sudo`). The repository facade over the
 * same handle serves the `--raw` read path (§7.4) with the D-067 cap, so
 * one open answers both consumers.
 */
export async function openDoctorDatabase(dataDir: string): Promise<DoctorDatabaseRead> {
  if (!existsSync(join(dataDir, DATABASE_FILENAME))) {
    return { state: 'absent' };
  }
  try {
    const { openReadOnlyStorageConnection } = await import('../storage/connection');
    const { createQuotaRepository } = await import('../storage/repository');
    const connection = openReadOnlyStorageConnection({ dataDir });
    try {
      const repository = createQuotaRepository({ database: connection.database });
      return {
        state: 'open',
        runQuickCheck: () => connection.database.prepare('PRAGMA quick_check').all(),
        repository,
        close: () => connection.close(),
      };
    } catch (error) {
      // The repository facade failed over an open handle — release it
      // before reporting the failure (review round P3: no leaked handle).
      connection.close();
      throw error;
    }
  } catch (error) {
    return { state: 'failed', detail: thrownMessage(error) };
  }
}

/** The quick_check verdict: healthy, or the problems it reported. */
export type QuickCheckVerdict =
  { readonly ok: true } | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Classifies `PRAGMA quick_check` result rows: a single `'ok'` row is
 * health (SQLite's documented contract); anything else — other rows,
 * missing rows, non-object shapes — is the problem list, each row
 * stringified (quick_check reports one problem per row, e.g. "row X
 * missing from index Y"). Pure over its input, so the table tests pin
 * every arm without crafting a corrupted-both-ways database file.
 */
export function classifyQuickCheck(rows: readonly unknown[]): QuickCheckVerdict {
  if (rows.length === 1) {
    const row = rows[0] as Record<string, unknown> | null;
    if (row !== null && typeof row === 'object' && String(row.quick_check) === 'ok') {
      return { ok: true };
    }
  }
  return {
    ok: false,
    problems: rows.map((row) =>
      row !== null && typeof row === 'object'
        ? String((row as Record<string, unknown>).quick_check)
        : String(row),
    ),
  };
}

/** The database check over one read; D-114's residual becomes a hint line. */
export function databaseCheck(
  read: DoctorDatabaseRead,
  dataDir: string,
): { readonly check: DoctorCheck; readonly verdict: QuickCheckVerdict | null } {
  if (read.state === 'absent') {
    return {
      check: {
        status: 'skip',
        summary: `no database yet — the service creates it on first start (${join(dataDir, DATABASE_FILENAME)})`,
      },
      verdict: null,
    };
  }
  if (read.state === 'failed') {
    return {
      check: {
        status: 'fail',
        summary: 'the database cannot be opened read-only',
        detail: [
          read.detail,
          'If the service crashed recently, its journal needs a writer: start it once (quotameter start) and run doctor again.',
        ],
      },
      verdict: null,
    };
  }
  let rows: unknown[];
  try {
    rows = read.runQuickCheck();
  } catch (error) {
    return {
      check: {
        status: 'fail',
        summary: 'PRAGMA quick_check could not be executed',
        detail: [thrownMessage(error)],
      },
      verdict: null,
    };
  }
  const verdict = classifyQuickCheck(rows);
  if (verdict.ok) {
    return {
      check: {
        status: 'pass',
        summary: 'database opened read-only, PRAGMA quick_check passed',
      },
      verdict,
    };
  }
  return {
    check: {
      status: 'fail',
      summary:
        'PRAGMA quick_check reported problems — back up the data directory before anything else',
      detail: verdict.problems.slice(0, 5),
    },
    verdict,
  };
}

/* ── The port occupancy check (spec §5.5) ──────────────────────────────── */

/** What a bind probe of the configured endpoint established. */
export type PortProbeOutcome =
  | { readonly state: 'free' }
  | { readonly state: 'in-use' }
  | { readonly state: 'denied'; readonly detail: string }
  | { readonly state: 'unbindable'; readonly detail: string }
  | { readonly state: 'failed'; readonly detail: string };

/**
 * Classifies a bind error by errno — pure, so every arm is a table test.
 * `EADDRINUSE` is occupancy (the check's subject); `EACCES` is the
 * privileged-port refusal (binding fails for the service exactly as it
 * failed here); the address errors (`EADDRNOTAVAIL`, `ENOTFOUND`,
 * `EINVAL`) mean the configured endpoint cannot be bound on this machine
 * at all — a defect of the configuration, not an unavailable probe
 * (review round P3); everything else is an honest `failed`.
 */
export function classifyBindError(error: NodeJS.ErrnoException): PortProbeOutcome {
  if (error.code === 'EADDRINUSE') return { state: 'in-use' };
  if (error.code === 'EACCES') return { state: 'denied', detail: error.message };
  if (error.code === 'EADDRNOTAVAIL' || error.code === 'ENOTFOUND' || error.code === 'EINVAL') {
    return { state: 'unbindable', detail: error.code };
  }
  return { state: 'failed', detail: error.code ?? error.message };
}

/**
 * The production port probe: binds `host:port` on an ephemeral TCP server
 * and closes immediately. The server binds exactly the address the service
 * will, so the probe answers the §5.5 question for real — no `ss`/`lsof`
 * subprocess, whose availability and output format are distribution
 * properties (the well-known-path-over-subprocess reasoning of D-107).
 */
export function probePortBinding(host: string, port: number): Promise<PortProbeOutcome> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve(classifyBindError(error));
    });
    server.listen(port, host, () => {
      // Close before resolving: the probe must leave no state behind.
      server.close(() => resolve({ state: 'free' }));
    });
  });
}

/**
 * The port check: occupancy read against the running-service fact and the
 * invocation's privileges. A privileged run that binds a port below 1024
 * proves nothing about the service, which runs as the unprivileged owner
 * — that combination fails with the owner's rule (review round P3, the
 * permission check's own reasoning applied here).
 */
export function portCheck(
  outcome: PortProbeOutcome,
  host: string,
  port: number,
  serviceRunning: boolean,
  privilegedInvocation: boolean,
): DoctorCheck {
  const endpoint = `${host}:${port}`;
  if (outcome.state === 'free') {
    if (privilegedInvocation && port < 1024) {
      return {
        status: 'fail',
        summary: `${endpoint} binds under this run's privileges, but the service runs as the unprivileged owner and cannot`,
        detail: ['Pick an unprivileged port (>= 1024) in server.port.'],
      };
    }
    return { status: 'pass', summary: `${endpoint} is free — the service can bind it` };
  }
  if (outcome.state === 'in-use') {
    if (serviceRunning) {
      return {
        status: 'pass',
        summary: `${endpoint} is in use by the running quotameter service`,
      };
    }
    return {
      status: 'fail',
      summary: `${endpoint} is already in use by another process — the service cannot start on it`,
      detail: [
        'Stop the process holding the port, or change server.port in the configuration (quotameter reload applies it after a restart).',
      ],
    };
  }
  if (outcome.state === 'denied') {
    return {
      status: 'fail',
      summary: `binding ${endpoint} was refused — the service could not bind it either`,
      detail: [
        'Pick an unprivileged port (>= 1024), or grant the service account access to this one.',
      ],
    };
  }
  if (outcome.state === 'unbindable') {
    return {
      status: 'fail',
      summary: `${endpoint} cannot be bound on this machine (${outcome.detail}) — the service could not start on it`,
      detail: ['Fix server.host or server.port in the configuration.'],
    };
  }
  return {
    status: 'unavailable',
    summary: `could not test ${endpoint} (${outcome.detail})`,
  };
}

/* ── The runtime checks (spec §5.5: Node version and node:sqlite) ──────── */

/**
 * The production minimum-version source: `src/server/main.ts`'s
 * `MINIMUM_NODE_VERSION`, the constant that mirrors `engines.node` (D-098)
 * — imported lazily so the dispatch graph never pays for the server entry
 * module's own imports just to read one string.
 */
async function resolveMinimumNodeVersion(): Promise<string> {
  const { MINIMUM_NODE_VERSION } = await import('../server/main');
  return MINIMUM_NODE_VERSION;
}

/**
 * The Node.js runtime check. A version string that cannot be parsed fails
 * closed with its own wording (D-098's launcher stance — an unverifiable
 * runtime is a refused runtime, never a guessed one).
 */
export function runtimeCheck(nodeVersion: string, minimum: string): DoctorCheck {
  let satisfied: boolean;
  try {
    satisfied = satisfiesMinimum(nodeVersion, minimum);
  } catch {
    return {
      status: 'fail',
      summary: `cannot determine the Node.js version (${JSON.stringify(nodeVersion)})`,
      detail: [
        `Reinstall Node.js >= ${minimum} (for example via the official binaries or nvm) and try again.`,
      ],
    };
  }
  if (satisfied) {
    return { status: 'pass', summary: `Node.js ${nodeVersion} (minimum ${minimum})` };
  }
  return {
    status: 'fail',
    summary: `Node.js ${nodeVersion} is below the minimum ${minimum}`,
    detail: ['Upgrade Node.js (for example via the official binaries or nvm) and try again.'],
  };
}

/**
 * The production `node:sqlite` probe: the storage layer's availability
 * seam (spec §5.5; `src/storage/sqlite-availability.ts`), reached
 * dynamically so this module's own static graph — it is statically
 * imported by the dispatch table — stays free of storage and its
 * ExperimentalWarning (the D-116 discipline).
 */
export async function probeNodeSqliteDefault(): Promise<boolean> {
  const { probeNodeSqlite } = await import('../storage/sqlite-availability');
  return probeNodeSqlite();
}

/** The `node:sqlite` check over the probe result. */
export function sqliteCheck(available: boolean, minimum: string): DoctorCheck {
  if (available) {
    return { status: 'pass', summary: 'node:sqlite is available' };
  }
  return {
    status: 'fail',
    summary: 'node:sqlite is not available in this Node.js build — storage cannot work',
    detail: [`Reinstall Node.js >= ${minimum} from an official build (custom builds may omit it).`],
  };
}

/* ── The permissions check (spec §5.5, §6.3/§15.4 — diagnostic only) ───── */

/** One filesystem object the permission check looked at. */
export type EntryStat =
  { readonly state: 'ok'; readonly stats: Stats } | { readonly state: 'absent' };

/**
 * The production stat seam: `lstat`, with only `ENOENT` reading as absence
 * (every other failure — an unsearchable parent, an I/O error — fails the
 * check loudly; a diagnostic must not read a broken path as "absent").
 */
export async function statConfigEntry(
  target: string,
): Promise<EntryStat | { readonly state: 'error'; readonly detail: string }> {
  try {
    return { state: 'ok', stats: await lstat(target) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    return { state: 'error', detail: thrownMessage(error) };
  }
}

/** Renders a mode as an octal literal, e.g. `0o644`. */
function octal(mode: number): string {
  return `0o${mode.toString(8)}`;
}

/**
 * Verifies one object against its §6.3 rule and returns problem strings —
 * empty when the object passes. The rules are `enforceConfigPermissions`'s
 * own (exact mode, real type, no symlink, owner-uid) restated as
 * diagnostics with the operator's remedy; doctor never fixes, because a
 * diagnostic that mutates its subject lies about what it found.
 */
function permissionProblems(
  noun: string,
  target: string,
  stats: Stats,
  requiredMode: number,
  ownerName: string,
  ownerUid: number,
): string[] {
  const problems: string[] = [];
  if (stats.isSymbolicLink()) {
    problems.push(
      `${noun} ${target} is a symbolic link — replace it with a real ${noun === 'configuration directory' ? 'directory' : 'file'}`,
    );
  } else if (
    (noun === 'configuration directory' && !stats.isDirectory()) ||
    (noun === 'configuration file' && !stats.isFile())
  ) {
    problems.push(
      `${noun} ${target} is not a ${noun === 'configuration directory' ? 'directory' : 'regular file'}`,
    );
  }
  if (stats.uid !== ownerUid) {
    problems.push(
      `${noun} ${target} is owned by uid ${stats.uid}, but the service owner is ${ownerName} (uid ${ownerUid}) — chown it to ${ownerName}`,
    );
  }
  const mode = stats.mode & 0o7777;
  if (mode !== requiredMode) {
    problems.push(
      `${noun} ${target} has mode ${octal(mode)}, expected ${octal(requiredMode)} — run: chmod ${requiredMode.toString(8)} ${target}`,
    );
  }
  return problems;
}

/**
 * The permissions check over both stats. An absent object skips (the
 * Configuration row already failed absence); an inspection error is an
 * honest `unavailable`.
 */
export function permissionsCheck(
  configDir: string,
  configFile: string,
  dirStat: EntryStat | { readonly state: 'error'; readonly detail: string },
  fileStat: EntryStat | { readonly state: 'error'; readonly detail: string },
  ownerName: string,
  ownerUid: number,
): DoctorCheck {
  if (dirStat.state === 'error') {
    return {
      status: 'unavailable',
      summary: `cannot inspect the configuration paths (${dirStat.detail})`,
    };
  }
  if (fileStat.state === 'error') {
    return {
      status: 'unavailable',
      summary: `cannot inspect the configuration paths (${fileStat.detail})`,
    };
  }
  if (dirStat.state === 'absent' || fileStat.state === 'absent') {
    return {
      status: 'skip',
      summary: 'no configuration on disk yet — nothing to verify (see Configuration)',
    };
  }
  const problems = [
    ...permissionProblems(
      'configuration directory',
      configDir,
      dirStat.stats,
      CONFIG_DIR_MODE,
      ownerName,
      ownerUid,
    ),
    ...permissionProblems(
      'configuration file',
      configFile,
      fileStat.stats,
      CONFIG_FILE_MODE,
      ownerName,
      ownerUid,
    ),
  ];
  if (problems.length > 0) {
    return { status: 'fail', summary: 'configuration permissions need repair:', detail: problems };
  }
  return {
    status: 'pass',
    summary: `configuration directory ${octal(CONFIG_DIR_MODE)} and file ${octal(CONFIG_FILE_MODE)}, owned by ${ownerName}`,
  };
}

/* ── The time zone check (spec §5.5, through the clock module's gate) ──── */

/**
 * The IANA verdict for the configured display zone. Through the service's
 * pipeline a valid configuration always carries a valid zone (the parser
 * pre-validates it), so the fail arm is the defense-in-depth half — total
 * over any string, and directly table-tested for it.
 */
export function timezoneCheck(zone: string): DoctorCheck {
  return isValidTimeZone(zone)
    ? { status: 'pass', summary: `${zone} is a valid IANA time zone` }
    : {
        status: 'fail',
        summary: `${zone} is not a valid IANA time zone — set app.timezone to an IANA name`,
      };
}

/* ── The network/authentication consistency check (spec §5.5, §15.1) ───── */

/**
 * The §15.1 verdict for a **valid** configuration: `findConfigProblems`
 * already refuses the inconsistent ones (§15.1 is a parser invariant), so
 * this renders the classification the operator can act on — which of
 * loopback/remote and auto/required they run, and whether a password is
 * set. Unreachable arms (remote without a password, `required` without a
 * hash) cannot occur here by construction; the invalid-configuration probe
 * below is their diagnostic path.
 */
export function authConsistencyCheck(config: Config): DoctorCheck {
  // Defaults completion materializes both sections and their defaulted
  // fields on a validated configuration (D-018); the non-null assertions
  // state that invariant (the U-009 house pattern, no defensive fallback
  // arms). `passwordHash` has no default — its absence is the real state.
  const host = config.server!.host!;
  const port = config.server!.port!;
  const mode = config.auth!.mode!;
  const hasPassword = config.auth!.passwordHash !== undefined;
  const loopback = isLoopbackHost(host);
  if (loopback && mode === 'auto' && !hasPassword) {
    return {
      status: 'pass',
      summary: `loopback bind ${host}:${port} with auth.mode auto — no password required`,
    };
  }
  const where = loopback ? `loopback bind ${host}:${port}` : `remote bind ${host}:${port}`;
  const passwordPart = hasPassword ? 'a password is set' : 'no password is set';
  return {
    status: 'pass',
    summary: `${where}, auth.mode ${mode} — ${passwordPart}`,
  };
}

/**
 * The §15.1 verdict for an **invalid** configuration: the D-101
 * placeholder-hash probe (`withPlaceholderHash`, additively exported by
 * `init-persist.ts`), re-run through the service's own
 * `parseConfigWithEnv` so environment overrides keep their precedence. The
 * probe applies only where the stored hash is absent (D-101's rule — a
 * present-but-malformed hash is a defect the probe never masks): a
 * configuration whose only defect is the missing password classifies as
 * the actionable password-pending state with `passwd` as the remedy;
 * anything else stays the Configuration row's problem list.
 */
export function authPendingProbeCheck(fileInput: unknown, env: NodeJS.ProcessEnv): DoctorCheck {
  const probed = parseConfigWithEnv(withPlaceholderHash(fileInput), env);
  if (probed.ok) {
    return {
      status: 'fail',
      summary:
        'a password is required (auth.mode "required" or a non-loopback server.host) but none is set — the service refuses to start',
      detail: ['Set one with: quotameter passwd'],
    };
  }
  return {
    status: 'skip',
    summary: 'not checked — the configuration has other problems (see Configuration)',
  };
}

/* ── The unit-freshness check (spec §5.5, §5.4) ────────────────────────── */

/** What one installed unit's content check established. */
export type UnitFreshnessCheck = DoctorCheck;

/**
 * Checks an installed unit's content for freshness: parse problems first,
 * then the §5.4 stale-path comparison (`ExecStart`'s node/CLI tokens
 * against this installation's `serviceExecPaths()`), then the structural
 * validator of the unit's kind — the system unit additionally against the
 * owner-scoped config/data pair `ReadWritePaths` must carry. Pure over
 * content + paths, so the whole matrix is table-testable.
 */
export function unitFreshnessCheck(
  content: string,
  kind: 'system' | 'user',
  execPaths: ServiceExecPaths,
  expectedDirs: { readonly configDir: string; readonly dataDir: string },
): UnitFreshnessCheck {
  const parsed = parseUnitFile(content);
  if (parsed.problems.length > 0) {
    return {
      status: 'fail',
      summary: `the ${kind} unit file cannot be parsed:`,
      detail: parsed.problems,
    };
  }
  const execStart = parsed.directives.find(
    (directive) => directive.section === 'Service' && directive.key === 'ExecStart',
  );
  const expectedTokens = [execPaths.nodePath, execPaths.cliPath, 'run'];
  // Token-exact, like the validator's own `expectUnitExecStartRun`: a
  // hand-edited unit whose paths are current but whose spacing differs is
  // NOT stale; and only the compared tokens are ever quoted back — a unit
  // the application does not control could carry anything in a raw value
  // (review round P3: no whole-string comparison, no raw echo).
  const actualTokens = execStart === undefined ? [] : execStart.value.trim().split(/\s+/);
  if (
    execStart === undefined ||
    actualTokens.length !== expectedTokens.length ||
    actualTokens.some((token, index) => token !== expectedTokens[index])
  ) {
    return {
      status: 'fail',
      summary:
        'stale ExecStart — the pinned Node/CLI paths no longer match this installation (spec §5.4)',
      detail: [
        `unit starts: ${actualTokens.join(' ')}`,
        `this installation: ${expectedTokens.join(' ')}`,
        kind === 'system'
          ? 'Regenerate it with: sudo quotameter service install'
          : 'Regenerate it with: quotameter service install',
      ],
    };
  }
  const problems =
    kind === 'system' ? validateSystemUnit(content, expectedDirs) : validateUserUnit(content);
  if (problems.length > 0) {
    return {
      status: 'fail',
      summary: `the ${kind} unit no longer matches the generated shape:`,
      detail: problems.slice(0, 8),
    };
  }
  return {
    status: 'pass',
    summary: `${kind} unit is current — Node/CLI paths and shape match this installation`,
  };
}

/* ── The handler ───────────────────────────────────────────────────────── */

/** Injectable collaborators; every one has a production default. */
export interface DoctorDeps {
  /** The §5.3 step 1 owner resolution (task 136, D-105); production `resolveServiceOwner`. */
  readonly resolveOwner?: () => ServiceOwnerResolution;
  /**
   * The environment the owner-scoped §6.1 directories, the configuration
   * pipeline, and `apiKeyEnv` resolution read; production `process.env`.
   */
  readonly pathEnv?: PathEnv;
  /** The configuration pipeline; production `loadConfigWithEnv` (the D-112 precedent). */
  readonly validate?: (configPath: string, env: NodeJS.ProcessEnv) => Promise<ConfigEnvLoadResult>;
  /** Reads configuration file text (the §15.1 probe's raw input); production reads the file. */
  readonly readConfigText?: (target: string) => Promise<string>;
  /** Stats one filesystem object; production {@link statConfigEntry}. */
  readonly statEntry?: (target: string) => ReturnType<typeof statConfigEntry>;
  /** The found Node.js version; production `process.versions.node`. */
  readonly nodeVersion?: () => string;
  /** The declared minimum; production `MINIMUM_NODE_VERSION` (lazily imported). */
  readonly minimumNodeVersion?: () => Promise<string>;
  /** The `node:sqlite` probe; production {@link probeNodeSqlite}. */
  readonly probeSqlite?: () => Promise<boolean>;
  /** Opens the data directory's database; production {@link openDoctorDatabase}. */
  readonly openDatabase?: (dataDir: string) => Promise<DoctorDatabaseRead>;
  /** Builds the provider behind per-account connectivity; production `createInitialAccountProvider`. */
  readonly createProvider?: () => QuotaProvider;
  /** Whether a unit file is on disk; production `unitFileExistsOnDisk` (task 139). */
  readonly unitFileExists?: (installPath: string) => boolean;
  /** Reads an installed unit file; production reads it as UTF-8 text. */
  readonly readUnitFile?: (installPath: string) => Promise<string>;
  /** The absolute paths freshness compares against; production `serviceExecPaths`. */
  readonly execPaths?: () => ServiceExecPaths;
  /** The §5.3 capability probe (task 137); production `probeServiceCapabilities`. */
  readonly probeCapabilities?: () => ServiceCapabilities;
  /** The service-command executor; production `spawnServiceCommand`. */
  readonly runCommand?: ServiceCommandRunner;
  /** Reads the single-instance lock; production `readServiceLock` (task 141). */
  readonly readLock?: (lockPath: string) => Promise<ServiceLockRead>;
  /** Liveness probe for a lock's holder pid; production `isProcessAlive`. */
  readonly isAlive?: (pid: number) => boolean;
  /** The bind probe of the configured endpoint; production {@link probePortBinding}. */
  readonly probePort?: (host: string, port: number) => Promise<PortProbeOutcome>;
  /** The `timedatectl` read; production {@link runTimedatectlShow}. */
  readonly readTimedatectl?: () => Promise<TimedatectlRead>;
}

/** The production unit-file reader: UTF-8 text of the installed unit. */
async function readUnitFileFromDisk(installPath: string): Promise<string> {
  return readFile(installPath, 'utf8');
}

/** The production configuration-text reader (the §15.1 probe's input). */
async function readConfigTextFromDisk(target: string): Promise<string> {
  return readFile(target, 'utf8');
}

/**
 * Builds the §5.5 `quotameter doctor` handler: resolves the owner and the
 * owner-scoped directories, runs every check, appends the `--raw` section
 * when the flag names an account, renders the report, and returns the exit
 * code (1 exactly when a check failed or the pre-flight failed). Never
 * throws; a rejecting injected seam propagates to the dispatcher's exit-1
 * failure arm, the landed 140–144 shape.
 */
export function runDoctorCommand(deps: DoctorDeps = {}): CliHandler {
  return async (ctx: CliContext): Promise<number> => {
    const errorPrefix = `quotameter ${ctx.commandPath.join(' ')}`;
    const rawFlag = ctx.flags.raw;
    const rawAccount = typeof rawFlag === 'string' ? rawFlag : undefined;
    if (rawAccount !== undefined && rawAccount.trim() === '') {
      ctx.output.err(
        `${errorPrefix}: --raw needs an account id — for example: quotameter doctor --raw work`,
      );
      return 1;
    }

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

    const checks: DoctorCheck[] = [];

    /* Runtime (§5.5: Node version and node:sqlite). */
    const minimum = await (deps.minimumNodeVersion ?? resolveMinimumNodeVersion)();
    checks.push(runtimeCheck((deps.nodeVersion ?? (() => process.versions.node))(), minimum));
    checks.push(sqliteCheck(await (deps.probeSqlite ?? probeNodeSqliteDefault)(), minimum));

    /* Configuration (the service's own pipeline; D-112's precedent). */
    const configPath = configFilePath(directories.configDir);
    const config = await (deps.validate ?? loadConfigWithEnv)(configPath, env);
    const configAbsent =
      !config.ok &&
      config.problems.length === 1 &&
      config.problems[0] === `configuration file not found: ${configPath}`;
    if (config.ok) {
      checks.push({
        status: 'pass',
        summary: config.fileAbsent
          ? `valid — from environment overrides, no configuration file (${configPath} would be used)`
          : `valid at ${configPath}`,
      });
    } else if (configAbsent) {
      checks.push({
        status: 'fail',
        summary: `no configuration file at ${configPath} — initialize first:`,
        detail: ['quotameter init'],
      });
    } else {
      checks.push({
        status: 'fail',
        summary: 'invalid — the problems are:',
        detail: config.problems,
      });
    }
    const validConfig = config.ok ? config.config : null;

    /* Permissions (§6.3, diagnostic-only). */
    const statEntry = deps.statEntry ?? statConfigEntry;
    checks.push(
      permissionsCheck(
        directories.configDir,
        configPath,
        await statEntry(directories.configDir),
        await statEntry(configPath),
        owner.user.name,
        owner.user.uid,
      ),
    );

    /* Time zone (§5.5, through the clock module's IANA gate). */
    if (validConfig === null) {
      checks.push({
        status: 'skip',
        summary: 'not checked — the configuration is not usable (see Configuration)',
      });
    } else {
      checks.push(timezoneCheck(validConfig.app.timezone));
    }

    /* Database (§5.5: open + PRAGMA quick_check) — the handle also feeds --raw. */
    const database = await (deps.openDatabase ?? openDoctorDatabase)(directories.dataDir);
    try {
      const databaseResult = databaseCheck(database, directories.dataDir);
      checks.push(databaseResult.check);

      /* The §5.6 lock read — shared by the service rows and the port check. */
      const lock = await (deps.readLock ?? readServiceLock)(lockFilePath(directories.dataDir));
      const isAlive = deps.isAlive ?? isProcessAlive;
      // Narrowed once: every consumer below answers "running, and at which
      // pid?" from this pair, with no second liveness read.
      const runningPid = lock.state === 'held' && isAlive(lock.pid) ? lock.pid : null;

      /* Service state and unit freshness (§5.5, through the landed seams). */
      const unitFileExists = deps.unitFileExists ?? unitFileExistsOnDisk;
      const systemUnit = unitFileExists(SYSTEM_UNIT_INSTALL_PATH);
      const userUnitPath = userUnitInstallPath(owner.user.home);
      const userUnit = unitFileExists(userUnitPath);
      const readUnitFile = deps.readUnitFile ?? readUnitFileFromDisk;
      if (systemUnit && userUnit) {
        checks.push({
          status: 'fail',
          summary:
            'both a system unit and a user unit are installed — two independent services for the same data; only one should be',
          detail: [
            `system unit: ${SYSTEM_UNIT_INSTALL_PATH}`,
            `user unit: ${userUnitPath}`,
            'Remove one with quotameter service uninstall (sudo-prefixed for the system unit).',
          ],
        });
      } else if (systemUnit || userUnit) {
        const kind: 'system' | 'user' = systemUnit ? 'system' : 'user';
        const installPath = systemUnit ? SYSTEM_UNIT_INSTALL_PATH : userUnitPath;
        try {
          checks.push(
            unitFreshnessCheck(
              await readUnitFile(installPath),
              kind,
              (deps.execPaths ?? serviceExecPaths)(),
              directories,
            ),
          );
        } catch (error) {
          checks.push({
            status: 'unavailable',
            summary: `cannot read the installed ${kind} unit at ${installPath} (${thrownMessage(error)})`,
          });
        }
      } else {
        checks.push({
          status: 'skip',
          summary:
            'no systemd unit installed — the service runs in the foreground with quotameter run',
        });
      }
      if (systemUnit && userUnit) {
        checks.push({
          status: 'skip',
          summary: 'not checked — two units are installed (see the Service unit row)',
        });
      } else if (systemUnit || userUnit) {
        const kind: 'system' | 'user' = systemUnit ? 'system' : 'user';
        const capabilities = (deps.probeCapabilities ?? probeServiceCapabilities)();
        const plan = planManagerProbe({
          selected: kind,
          privileges: owner.privileges,
          capabilities,
          ownerName: owner.user.name,
        });
        const manager =
          plan.state === 'ask'
            ? describeManagerState(
                plan,
                await (deps.runCommand ?? spawnServiceCommand)(plan.command),
                false,
              )
            : describeManagerState(plan, undefined, false);
        // An installed unit always yields a manager line ('ask' and
        // 'unavailable' both render one); the non-null assertion states that
        // invariant (the U-009 house pattern, no defensive fallback arm).
        const line = manager.line!;
        if (line === 'active') {
          checks.push({ status: 'pass', summary: `the ${kind} service is active` });
        } else if (line === 'not active') {
          checks.push({
            status: 'fail',
            summary: `the ${kind} service is installed but not active — start it:`,
            detail: [
              kind === 'system' && owner.privileges === 'none'
                ? 'sudo quotameter start'
                : 'quotameter start',
            ],
          });
        } else {
          checks.push({
            status: 'unavailable',
            summary: `the manager state is ${line}`,
          });
        }
      } else if (runningPid !== null) {
        checks.push({
          status: 'pass',
          summary: `running in the foreground (pid ${runningPid}) — no systemd unit installed`,
        });
      } else if (lock.state === 'held') {
        checks.push({
          status: 'fail',
          summary: `not running — a stale lock names pid ${lock.pid}; the next start clears it`,
          detail: ['Run the service: quotameter run', 'Or install it: quotameter service install'],
        });
      } else if (lock.state === 'absent') {
        checks.push({
          status: 'fail',
          summary: 'the service is neither installed nor running',
          detail: [
            'Install it: quotameter service install',
            'Or run it in the foreground: quotameter run',
          ],
        });
      } else {
        checks.push({
          status: 'unavailable',
          summary:
            lock.state === 'unreadable'
              ? `cannot determine the running state — the service lock cannot be read (${lock.detail})`
              : 'cannot determine the running state — the service lock is not a valid quotameter lock file',
        });
      }

      /* Port occupancy (§5.5), against the configured endpoint. */
      if (validConfig === null) {
        checks.push({
          status: 'skip',
          summary: 'not checked — the configuration is not usable (see Configuration)',
        });
      } else {
        // Defaults completion materializes the server section (D-018); the
        // non-null assertions state that invariant (the U-009 house pattern,
        // no defensive fallback arms).
        const host = validConfig.server!.host!;
        const port = validConfig.server!.port!;
        const outcome = await (deps.probePort ?? probePortBinding)(host, port);
        checks.push(
          portCheck(outcome, host, port, runningPid !== null, owner.privileges === 'held'),
        );
      }

      /* Network/authentication consistency (§5.5, §15.1). */
      if (validConfig !== null) {
        checks.push(authConsistencyCheck(validConfig));
      } else if (configAbsent) {
        checks.push({
          status: 'skip',
          summary: 'not checked — no configuration to check (see Configuration)',
        });
      } else {
        // The §15.1 probe needs the file's parsed input; a file that cannot
        // be read or parsed keeps its problems in the Configuration row and
        // this check honestly skips. The re-read is deliberate and
        // accepted (review round P3): the pipeline does not expose its
        // parsed input, and a concurrent edit inside the millisecond
        // window between the two reads can at worst make this row describe
        // a slightly newer file than the Configuration row — an advisory
        // detail beside that row's own problem list, never a wrong
        // verdict on its own.
        let fileInput: unknown;
        let probed = false;
        try {
          const parsed = parseJson(
            await (deps.readConfigText ?? readConfigTextFromDisk)(configPath),
          );
          if (parsed.ok) {
            fileInput = parsed.value;
            probed = true;
          }
        } catch {
          // an unreadable file — the same skip below
        }
        checks.push(
          probed
            ? authPendingProbeCheck(fileInput, env)
            : {
                status: 'skip',
                summary:
                  'not checked — the configuration file could not be read or parsed (see Configuration)',
              },
        );
      }

      /* Per-account connectivity (§5.5, through the §8.1 contract). */
      if (validConfig === null) {
        checks.push({
          status: 'skip',
          summary: 'accounts not checked — the configuration is not usable (see Configuration)',
        });
      } else {
        // Defaults completion materializes the accounts array (D-018); the
        // non-null assertion states that invariant (the U-009 house pattern).
        const accounts = validConfig.accounts!;
        if (accounts.length === 0) {
          checks.push({
            status: 'skip',
            summary: 'no accounts configured — add one with quotameter init or in the web UI',
          });
        } else {
          const provider = deps.createProvider?.() ?? createInitialAccountProvider();
          for (const account of accounts) {
            checks.push(await accountConnectivityCheck(account, provider, env));
          }
        }
      }

      /* System clock/NTP (§5.5, via timedatectl). */
      checks.push(clockCheck(await (deps.readTimedatectl ?? runTimedatectlShow)()));

      /* The --raw section (§7.4, D-067) — informational, never gating. */
      let rawSection: string | null = null;
      if (rawAccount !== undefined) {
        rawSection = renderRawSection(database, rawAccount, directories.dataDir);
      }

      ctx.output.out(renderDoctorReport(checks, rawSection));
      return anyCheckFailed(checks) ? 1 : 0;
    } finally {
      // The read-only handle is released on every path (review round P1,
      // the status handler's finally shape) — a later seam throw cannot leak it.
      if (database.state === 'open') {
        database.close();
      }
    }
  };
}

/**
 * One account's connectivity row: disabled accounts skip, an env-sourced
 * key missing from this shell is the D-112 residual (unavailable, never a
 * verdict), and the §8.1 test itself classifies through init-account's
 * secret-scrubbing classifier — a rejected key fails with the replacement
 * remedy, an inconclusive check is honestly unavailable (D-052's own
 * distinction: unavailability is not a verdict on the key).
 *
 * Totality guards (review round P2s, the init-account precedent): the
 * schema accepts untrimmed `minLength: 1` strings, but whitespace is
 * never a credential or label (D-011) — both become fail rows here
 * instead of a thrown `AccountContext` TypeError aborting the report; and
 * an account naming a provider this build does not carry is never probed
 * with the bundled adapter — its key must not travel to a provider its
 * configuration never named (§15.4), and the row names the defect.
 */
async function accountConnectivityCheck(
  account: AccountConfig,
  provider: QuotaProvider,
  env: NodeJS.ProcessEnv,
): Promise<DoctorCheck> {
  const name =
    account.label.trim() === ''
      ? `account '${account.id}' (its label is blank)`
      : `account '${account.label}'`;
  if (account.enabled === false) {
    return { status: 'skip', summary: `${name} is disabled — not tested` };
  }
  if (account.label.trim() === '') {
    // The context factory rejects a trimmed-blank label (and init never
    // collects one), so this is a hand-edited defect — a fail row naming
    // the account by id, never a thrown TypeError losing the report.
    return {
      status: 'fail',
      summary: `${name} — the label must not be blank; fix the configuration`,
    };
  }
  if (account.providerId !== provider.id) {
    return {
      status: 'fail',
      summary: `${name} names provider '${account.providerId}', but this build provides only '${provider.id}'`,
      detail: [
        `Fix providerId in the configuration, or upgrade to a build that carries provider '${account.providerId}'.`,
      ],
    };
  }
  let secret: string;
  if (account.apiKey !== undefined) {
    if (account.apiKey.trim() === '') {
      return {
        status: 'fail',
        summary: `${name} has a blank API key — whitespace is never a credential`,
        detail: ['Replace the API key in the web UI or the configuration file.'],
      };
    }
    secret = account.apiKey;
  } else {
    const variable = account.apiKeyEnv ?? '';
    const value = env[variable];
    if (typeof value !== 'string' || value.trim() === '') {
      return {
        status: 'unavailable',
        summary:
          `${name} reads its API key from environment variable '${variable}', ` +
          'which is not set to a usable value in this shell — the service environment may hold it; not tested here',
      };
    }
    secret = value;
  }
  const context = createAccountContext(account.id, account.label, secret);
  try {
    await provider.validateCredentials(context);
  } catch (error) {
    const failure = classifyTestFailure(error, secret);
    if (failure.outcome === 'credentials-rejected') {
      return {
        status: 'fail',
        summary: `the provider rejected the credentials for ${name}`,
        detail: [failure.detail, 'Replace the API key in the web UI or the configuration file.'],
      };
    }
    return {
      status: 'unavailable',
      summary: `could not verify ${name}: ${failure.detail}`,
    };
  }
  return {
    status: 'pass',
    summary: `the provider accepted the credentials for ${name}`,
  };
}

/**
 * Renders the `--raw` section from the database handle the Database check
 * opened: the D-067 read path verbatim — `readRawDiagnostics` (the bounded,
 * newest-first read with its own blank-account guard) feeding
 * `renderRawDiagnostics` (§7.4's CLI-only exposure). Absent or unusable
 * databases render their honest sentence, and a read that fails over an
 * open handle (a database that passes `quick_check` but predates the
 * `raw_responses` table, say) renders its failure sentence instead of
 * aborting the report — the section is informational, never gating
 * (review round P1: an appendix must not be able to lose the report).
 */
function renderRawSection(
  database: DoctorDatabaseRead,
  accountId: string,
  dataDir: string,
): string {
  if (database.state === 'absent') {
    return `Sanitized raw responses for account '${accountId}': no database exists yet (${join(dataDir, DATABASE_FILENAME)}), so nothing was ever retained.`;
  }
  if (database.state === 'failed') {
    return `Sanitized raw responses for account '${accountId}': the database cannot be opened (see the Database row).`;
  }
  try {
    const records = readRawDiagnostics(database.repository, accountId);
    return `Sanitized raw responses for account '${accountId}':\n${renderRawDiagnostics(records)}`;
  } catch (error) {
    return `Sanitized raw responses for account '${accountId}': the read failed (${thrownMessage(error)}) — see the Database row.`;
  }
}
