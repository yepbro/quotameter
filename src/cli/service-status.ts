/**
 * The `quotameter status` command handler (task 142, spec §5.2/§7.3; decision
 * D-114).
 *
 * §5.2: "`quotameter status` — Show service status, latest collection, and
 * last error for each account", and the task's done-condition: the output is
 * useful for both system and user units. The report therefore carries the
 * **facts a status question can ask**, each from the landed layer that owns
 * it, and composes nothing new:
 *
 * - **Installed scope** — the disk probe of tasks 139/140 (D-110's
 *   installed-unit discovery, never a re-derived install route): which unit
 *   files exist decides which service the report describes; both existing is
 *   reported as the mistake task 139 already warns about.
 * - **Running state** — the §5.6 single-instance lock through task 141's
 *   reader (D-112): the lock exists exactly while a service instance holds
 *   the data directory, for every run mode — a systemd unit and a foreground
 *   `quotameter run` alike — so one read answers "running, and at which
 *   pid?" where a manager-scoped query could only answer "installed".
 * - **Manager state** — `systemctl [-–user] is-active quotameter.service`
 *   through task 137's command seam, only for an installed unit, and only as
 *   an unprivileged query (D-105's vocabulary: status/journalctl queries run
 *   as the service owner). The exit status is the binary contract
 *   (`active`/`not active`); a privileged run never asks a `--user` manager
 *   (it would be root's, not the owner's — the regular-account hint is
 *   printed instead), and an unreachable manager is an honest `unknown`.
 * - **Configuration** — `loadConfigWithEnv`, the exact pipeline the service
 *   runs (the D-112 precedent): valid gives the account list, the §7.1
 *   interval, and the §10 display zone; absent is the "not configured yet"
 *   answer with the init hint; invalid prints the pipeline's field-addressed
 *   problems and costs the accounts section.
 * - **Per-account facts** — task 111's `deriveAccountStatus` (§7.3's
 *   vocabulary, D-070; the archived rank-0 input is D-191, FSM-2) over
 *   `readPollingRunEvidence` storage reads, with the two inputs a
 *   separate process cannot observe fixed to their honest proxies: the
 *   D-064 suspension state passes `INITIAL_SUSPENSION_STATE`
 *   (the derivation's `auth_error`-run branch keeps rank 1 truthful — the
 *   stance D-070 recorded for exactly this consumer), and `configured`
 *   resolves `apiKeyEnv` against **this invocation's** environment (the
 *   D-112 residual: the CLI cannot see the service's environment; the
 *   service's own log line is the authority). The archived lifecycle
 *   fact comes from the storage row beside the configured entry — the
 *   hand-re-added archived id reports `Archived`, agreeing with the web
 *   UI's accounts surface instead of a live runtime status.
 * - **Last collection / last error** — §7.2's "most recent successful
 *   collection and most recent error" as two independent facts: the evidence
 *   object's `lastSuccessAt` (the latest snapshot's §8.4 stamp) and the
 *   newest non-success run, probed through the repository's outcome-filtered
 *   latest read (six bounded, indexed queries — `success` is not an error).
 *   The stored `error_message` is sanitized by construction (D-048) and
 *   renders verbatim after a belt-and-suspenders exact-occurrence redaction
 *   of the configured secrets (§7.4's rule mirrored for this surface).
 * - **Dead-engine suspicion** — the FSM-4/D-192 advisory: a separate
 *   process cannot probe the polling engine, so when the lock is held by
 *   a live pid yet every pollable account's silence exceeds what its own
 *   evidence makes legitimate, the report appends a warning with a
 *   `quotameter logs` pointer. The base expectation is `gapThresholdMs`
 *   — §12.2's three jitter-expanded intervals, one threshold source —
 *   widened per account by the facts the newest run row itself carries:
 *   an `auth_error` newest run is the D-064 suspended shape (§7.2's
 *   hourly verification cadence), a stored `retry_after_seconds` is the
 *   provider's requested pause (§7.2's deferral — evidence, never the
 *   engine's gate re-derived, D-069). Advisory only: the exit code stays
 *   D-114's (states never fail a status question).
 *
 * **Exit codes (D-114)**: 0 exactly when every probe *answered* — the states
 * themselves (stopped, not installed, no accounts, no data) never fail a
 * status question; 1 when a probe could not answer (owner problems, an
 * unusable owner home, an unreadable or invalid lock file, an invalid
 * configuration, or a storage read failure) — the report still renders
 * everything it established, with the failure lines on stderr. A database
 * file that does not exist yet is *empty evidence*, not a failure: a data
 * directory no service ever opened has no runs by construction, and the
 * command never creates a database (the connection opens only an existing
 * file). The handler never throws, the owner resolution's broken-system
 * throw included (D-110's contract).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type ConfigEnvLoadResult, loadConfigWithEnv } from '../config/env';
import { configFilePath } from '../config/load';
import type { PathEnv } from '../config/paths';
import { gapThresholdMs } from '../services/history-gaps';
import {
  INITIAL_SUSPENSION_STATE,
  AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS,
} from '../services/polling-suspension';
import { MAX_POLLING_INTERVAL_MS, MIN_POLLING_INTERVAL_MS } from '../services/polling-scheduler';
import {
  deriveAccountStatus,
  readPollingRunEvidence,
  ACCOUNT_STATUS_LABELS,
  type PollingRunEvidence,
} from '../services/polling-status';
import { COLLECTION_OUTCOMES } from '../services/polling-outcomes';
import { isProcessAlive, lockFilePath } from '../server/single-instance';
import {
  createQuotaRepository,
  type CollectionRunRecord,
  type QuotaRepository,
  type RunOutcome,
} from '../storage/repository';
import { CONFIG_DEFAULTS } from '../schemas/config';
import {
  createSystemClock,
  formatZonedDate,
  formatZonedTime,
  resolveTimeZone,
  type EpochMs,
} from '../util/clock';
import type { CliContext, CliHandler } from './commands';
import type { ServiceOwnerResolution } from './service-owner';
import {
  ownerUnitDirectories,
  resolveOwnerForCommand,
  unitFileExistsOnDisk,
} from './service-install';
import { readServiceLock, type ServiceLockRead } from './service-reload';
import {
  failureLine,
  probeServiceCapabilities,
  spawnServiceCommand,
  thrownMessage,
  type CapabilityProbe,
  type CommandOutcome,
  type ServiceCapabilities,
  type ServiceCommandRunner,
} from './service-setup';
import { SYSTEM_UNIT_INSTALL_PATH, SYSTEM_UNIT_NAME } from './systemd-unit';
import { userUnitInstallPath, USER_UNIT_NAME } from './systemd-user-unit';

/* ── The manager view ──────────────────────────────────────────────────── */

/** The `is-active` question the report asks an installed unit's manager. */
const SYSTEM_IS_ACTIVE_COMMAND = ['systemctl', 'is-active', SYSTEM_UNIT_NAME] as const;
const USER_IS_ACTIVE_COMMAND = ['systemctl', '--user', 'is-active', USER_UNIT_NAME] as const;

/** What the report can ask the service manager about an installed unit. */
export type ManagerProbePlan =
  /** Nothing is installed — there is no manager line at all. */
  | { readonly state: 'skip' }
  /** Ask `command`; `kind` names the unit for the both-installed case. */
  | {
      readonly state: 'ask';
      readonly command: readonly string[];
      readonly kind: 'system' | 'user';
    }
  /** The manager cannot be queried here; `reason` says why, honestly. */
  | { readonly state: 'unavailable'; readonly reason: string };

/** Everything the manager-probe decision needs; pure over its inputs. */
export interface ManagerProbeInput {
  /** Which unit kind the report describes (`undefined` — none installed). */
  readonly selected: 'system' | 'user' | undefined;
  /** The invocation's privileges (D-105); a held run never asks a `--user` manager. */
  readonly privileges: 'held' | 'none';
  /** Task 137's capability facts. */
  readonly capabilities: ServiceCapabilities;
  /** The service owner's account name, for the regular-account hint. */
  readonly ownerName: string;
}

/**
 * Decides whether and how the report queries the service manager (pure, so
 * every arm is a table test on the systemd-less container). The
 * `is-active` query is unprivileged in both scopes (D-105's vocabulary:
 * status queries run as the service owner) — the only privilege rule here is
 * the user-manager one: a privileged run's `--user` manager would be root's,
 * not the owner's, so the report says where to ask instead of asking wrong.
 */
export function planManagerProbe(input: ManagerProbeInput): ManagerProbePlan {
  if (input.selected === undefined) return { state: 'skip' };
  if (input.selected === 'system') {
    if (!input.capabilities.systemd) {
      return {
        state: 'unavailable',
        reason: 'systemd is not available on this machine',
      };
    }
    return { state: 'ask', command: SYSTEM_IS_ACTIVE_COMMAND, kind: 'system' };
  }
  if (input.privileges === 'held') {
    return {
      state: 'unavailable',
      reason: `the user service manager belongs to ${input.ownerName}'s regular account — run quotameter status there, without sudo`,
    };
  }
  if (!input.capabilities.userManager) {
    return {
      state: 'unavailable',
      reason: 'the systemd user manager is not reachable in this session',
    };
  }
  return { state: 'ask', command: USER_IS_ACTIVE_COMMAND, kind: 'user' };
}

/**
 * Renders the manager line's value from the plan and (when asked) the
 * command's outcome. The exit status is the binary contract — `active` or
 * `not active` — but only for a command that **ran and answered**: a
 * non-zero exit carrying a diagnostic (the spawn seam's error arm, or a
 * manager that could not reach its bus) is a probe that did not answer, and
 * renders `unknown (<diagnostic>)` with the incomplete flag set (D-114's
 * correction trail — a clean non-zero exit is how `is-active` answers
 * "inactive"/"failed", with an empty stderr; anything on stderr means no
 * answer arrived). The line is disambiguated by the unit kind only when both
 * unit kinds are installed and the Installed line therefore names two
 * services.
 */
export function describeManagerState(
  plan: ManagerProbePlan,
  outcome: CommandOutcome | undefined,
  bothInstalled: boolean,
): { readonly line: string | null; readonly incomplete: boolean } {
  if (plan.state === 'skip') return { line: null, incomplete: false };
  if (plan.state === 'unavailable') return { line: `unknown (${plan.reason})`, incomplete: false };
  if (outcome === undefined || outcome.ok) {
    return { line: decorate(plan, 'active', bothInstalled), incomplete: false };
  }
  if (outcome.detail === '') {
    return { line: decorate(plan, 'not active', bothInstalled), incomplete: false };
  }
  return { line: `unknown (${outcome.detail})`, incomplete: true };
}

/** Appends the unit-kind disambiguator used only in the both-installed case. */
function decorate(plan: Extract<ManagerProbePlan, { state: 'ask' }>, state: string, both: boolean) {
  return both ? `${state} (${plan.kind} service)` : state;
}

/* ── The storage read ──────────────────────────────────────────────────── */

/** The outcome of opening the data directory's database for reading. */
export type StatusStoreRead =
  /** No database file — no service ever opened this data directory. */
  | { readonly state: 'absent' }
  /**
   * An open repository over the existing database. The caller must call
   * `close` after reading (the connection's idempotent close, D-030).
   */
  | {
      readonly state: 'open';
      readonly repository: QuotaRepository;
      readonly close: () => void;
    }
  /** The database exists but cannot be opened or read; `detail` explains. */
  | { readonly state: 'failed'; readonly detail: string };

/**
 * The on-disk database name inside a data directory — storage's
 * `DATABASE_FILENAME` contract, restated here so the existence probe can run
 * **before** any storage module loads (`node:sqlite`'s ExperimentalWarning
 * then belongs to invocations that actually open a database — a data
 * directory without one answers absent having imported nothing). The
 * duplication is pinned behaviorally: the suites read databases created
 * through the landed connection module, so a drift of either name fails
 * them.
 */
const DATABASE_FILENAME = 'quotameter.sqlite';

/**
 * Opens the data directory's database for the report's reads — an existing
 * file only, **read-only** (storage's `openReadOnlyStorageConnection`): the
 * command never creates a database (a read-only handle cannot, closing the
 * probe-then-open creation window), never writes pages (no hot-journal
 * recovery as another user under `sudo`), and reads through the repository
 * facade. A fresh data directory reads as *absent* (no runs exist by
 * construction, which the §7.3 derivation's no-run paths answer exactly);
 * every open or configuration failure becomes the `failed` state carrying
 * the error message, which the handler renders exactly like the landed
 * handlers render their seam failures. The residual is accepted (D-114's
 * correction trail): a database that needs WAL recovery (a crashed writer's
 * hot journal) refuses a read-only open — an honest failure; a writer must
 * open it first.
 */
export async function openStatusStore(dataDir: string): Promise<StatusStoreRead> {
  if (!existsSync(join(dataDir, DATABASE_FILENAME))) {
    return { state: 'absent' };
  }
  try {
    const { openReadOnlyStorageConnection } = await import('../storage/connection');
    const connection = openReadOnlyStorageConnection({ dataDir });
    return {
      state: 'open',
      repository: createQuotaRepository({ database: connection.database }),
      close: () => connection.close(),
    };
  } catch (error) {
    return { state: 'failed', detail: thrownMessage(error) };
  }
}

/* ── Account facts ─────────────────────────────────────────────────────── */

/** The §11.2 run outcomes that are not a success — the last-error probe set. */
const FAILURE_OUTCOMES: readonly RunOutcome[] = COLLECTION_OUTCOMES.filter(
  (outcome) => outcome !== 'success',
);

/**
 * The English run-outcome vocabulary of the last-error line — §7.3's own
 * names for the three failure classes it ranks, extended with the two
 * §7.2/§11.2 outcomes that contribute no status but are still errors a
 * status report must name (a 429 cycle, a plain success for table totality).
 */
export const RUN_OUTCOME_LABELS: Readonly<Record<RunOutcome, string>> = Object.freeze({
  success: 'Success',
  auth_error: 'Auth rejected',
  rate_limited: 'Rate limited',
  network_error: 'Network error',
  timeout: 'Timeout',
  server_error: 'Server error',
  parse_error: 'Format changed',
});

/**
 * Finds the account's most recent **non-success** run — §7.2's "most recent
 * error" as a fact independent of the most recent success. Six bounded,
 * indexed lookups (`collection_runs_account_outcome_start`), newest by
 * `(started_at, id)` — the repository's own latest-read ordering.
 */
export function findLatestErrorRun(
  repository: QuotaRepository,
  accountId: string,
): CollectionRunRecord | null {
  let latest: CollectionRunRecord | null = null;
  for (const outcome of FAILURE_OUTCOMES) {
    const run = repository.getLatestCollectionRun(accountId, outcome);
    if (run === null) continue;
    if (
      latest === null ||
      run.startedAt > latest.startedAt ||
      (run.startedAt === latest.startedAt && run.id > latest.id)
    ) {
      latest = run;
    }
  }
  return latest;
}

/**
 * Whether a usable provider secret is resolved for the account (§6.3, the
 * D-070 caller contract): `apiKey` set, or `apiKeyEnv` naming a variable
 * **this invocation's** environment provides as a non-empty string (the
 * D-011 uniform rule). The service resolves the same rule against its own
 * environment; the CLI cannot see that environment, so an env-sourced key
 * missing in this shell reports `Not configured` — D-112's recorded
 * residual stance for CLI-side mirrors of service-side reads.
 */
export function resolveAccountConfigured(
  account: { readonly apiKey?: string; readonly apiKeyEnv?: string },
  env: NodeJS.ProcessEnv,
): boolean {
  if (account.apiKey !== undefined) return true;
  if (account.apiKeyEnv === undefined) return false;
  const value = env[account.apiKeyEnv];
  return typeof value === 'string' && value !== '';
}

/* ── The dead-engine suspicion (FSM-4, D-192) ───────────────────────────── */

/**
 * One pollable account's newest-run evidence — the silence judgment's
 * input. Any outcome counts (a failing cycle still proves the loop
 * alive); the two facts that LEGITIMATELY widen an account's expected
 * silence ride beside the stamp, both read from the same stored run row.
 */
export interface EngineAccountSilence {
  /** The run's `started_at` (epoch ms) — the silence's anchor. */
  readonly startedAt: number;
  /**
   * The run's outcome token: an `auth_error` newest run is the suspended
   * shape (the D-064 episode holds until a release — a newer run would
   * exist otherwise), whose verification cadence §7.2 fixes at one probe
   * per hour.
   */
  readonly outcome: RunOutcome;
  /**
   * The run's stored `retry_after_seconds` evidence (D-069: the §7.2
   * header's decision at settle time, capped at 3600 — evidence of the
   * provider's requested pause, never the engine's gate re-derived).
   */
  readonly retryAfterSeconds: number | null;
}

/** What {@link assessEngineLiveness} concludes from the available evidence. */
export type EngineLiveness =
  /**
   * No suspicion is derivable: the service is not running (an old latest
   * cycle is then EXPECTED — the report's Running line already explains
   * it), or no pollable account has a run at all (a fresh install, a
   * database without history — honest ambiguity, §12.1's spirit).
   */
  | { readonly kind: 'no-evidence' }
  /** At least one account's silence sits within its own expectation. */
  | { readonly kind: 'current' }
  /**
   * The evidence suggests a dead engine: the service holds the data
   * directory (a live pid), yet EVERY pollable account's silence exceeds
   * its own expectation. `newestCycleAt` carries the anchor for the
   * rendered warning.
   */
  | { readonly kind: 'stale-silence'; readonly newestCycleAt: EpochMs };

/** Everything the dead-engine suspicion decides over; pure over its inputs. */
export interface EngineLivenessInput {
  /** Whether the single-instance lock is held by a live pid (D-112). */
  readonly serviceRunning: boolean;
  /**
   * The pollable accounts' newest-run evidence (empty — or absent runs —
   * means no suspicion is derivable).
   */
  readonly accounts: ReadonlyArray<EngineAccountSilence>;
  /** The configured §7.1 interval in seconds (the live threshold base). */
  readonly intervalSeconds: number;
  /** The wall reading the silence is measured against (D-021). */
  readonly nowEpochMs: number;
}

/**
 * Derives the dead-engine suspicion from the evidence a separate process
 * can see (FSM-4, D-192 — the audit's finding that a scheduler killed by
 * a broken seam was learnable only from eventual `Stale` statuses). A
 * separate process cannot probe the engine directly, so the suspicion is
 * the same silence §12.2's timeline reads — judged PER ACCOUNT against
 * the silence that account's own evidence makes legitimate:
 *
 * - the base is {@link gapThresholdMs} from the history-gaps module, the
 *   ONE threshold source (three jitter-expanded §7.1 intervals, strict
 *   on the boundary exactly as the gap rule is);
 * - a newest run of `auth_error` is the D-064 suspended shape: the §7.2
 *   verification cadence (one probe per
 *   {@link AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS}) legitimately
 *   stretches that account's silence by an hour;
 * - a stored `retry_after_seconds` is the provider's own requested pause
 *   (§7.2, capped at an hour at store time): the deferral window is
 *   added to that account's expectation — the stored evidence widens
 *   the tolerance, the engine's gate is never re-derived from it
 *   (D-069's evidence-not-gate rule).
 *
 * The verdict is advisory: it warns on the report and never changes the
 * exit code (D-114: states never fail a status question).
 */
export function assessEngineLiveness(input: EngineLivenessInput): EngineLiveness {
  const caller = 'assessEngineLiveness';
  if (!Number.isFinite(input.nowEpochMs)) {
    throw new TypeError(`${caller}: nowEpochMs must be a finite epoch-milliseconds reading`);
  }
  if (
    !Number.isInteger(input.intervalSeconds) ||
    input.intervalSeconds * 1000 < MIN_POLLING_INTERVAL_MS ||
    input.intervalSeconds * 1000 > MAX_POLLING_INTERVAL_MS
  ) {
    throw new RangeError(
      `${caller}: intervalSeconds must be an integer in ` +
        `[${MIN_POLLING_INTERVAL_MS / 1000}, ${MAX_POLLING_INTERVAL_MS / 1000}] (spec §7.1)`,
    );
  }
  for (const account of input.accounts) {
    if (!Number.isFinite(account.startedAt)) {
      throw new TypeError(`${caller}: each account's startedAt must be finite`);
    }
    if (
      account.retryAfterSeconds !== null &&
      (!Number.isFinite(account.retryAfterSeconds) || account.retryAfterSeconds < 0)
    ) {
      throw new TypeError(
        `${caller}: retryAfterSeconds must be null or a non-negative finite number of seconds`,
      );
    }
  }
  if (!input.serviceRunning || input.accounts.length === 0) {
    return { kind: 'no-evidence' };
  }
  let newestCycleAt = Number.NEGATIVE_INFINITY;
  for (const account of input.accounts) {
    const baseMs = gapThresholdMs(input.intervalSeconds);
    const suspensionMs =
      account.outcome === 'auth_error' ? AUTH_SUSPENSION_VERIFICATION_INTERVAL_MS : 0;
    const deferralMs = (account.retryAfterSeconds ?? 0) * 1000;
    const expectedSilenceMs = baseMs + suspensionMs + deferralMs;
    // Within its own expectation — the loop is provably alive on this
    // account's evidence alone.
    if (input.nowEpochMs - account.startedAt <= expectedSilenceMs) {
      return { kind: 'current' };
    }
    if (account.startedAt > newestCycleAt) newestCycleAt = account.startedAt;
  }
  return { kind: 'stale-silence', newestCycleAt };
}

/* ── Rendering ─────────────────────────────────────────────────────────── */

/**
 * One §10-disciplined report timestamp: the instant rendered in the
 * **configured display time zone** — `yyyy-MM-dd HH:mm (Zone)` through the
 * clock module's zoned formatters, never the machine-local zone (D-021).
 */
export function formatStatusTimestamp(epochMs: EpochMs, timeZoneName: string): string {
  const timeZone = resolveTimeZone(timeZoneName);
  return `${formatZonedDate(epochMs, timeZone)} ${formatZonedTime(epochMs, timeZone)} (${timeZone})`;
}

/**
 * Replaces exact occurrences of every configured secret with `[REDACTED]` —
 * §7.4's rule mirrored for the report's error lines as defense in depth
 * (the stored messages are sanitized by construction, D-048; a write-side
 * bug must still not echo a key through `status`). Blank entries are ignored
 * — the same rule `sanitize.ts` applies to its secret list. Private because
 * the public `sanitizeRawResponse` is payload-shaped (JSON walk + 64 KiB
 * cap): the wrong tool for a one-line error message.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    // The same blank-entry rule as `sanitize.ts`'s secret list: a blank
    // marker would redact everything and nothing.
    if (secret.trim() === '') continue;
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

/** One account's rendered block; every field is display-ready data. */
export interface AccountReportLine {
  readonly label: string;
  readonly providerId: string;
  /** The §7.3 English label (`ACCOUNT_STATUS_LABELS` vocabulary). */
  readonly status: string;
  /** §10-formatted timestamp, or `null` when no success exists yet. */
  readonly lastCollection: string | null;
  /** The rendered last-error line, or `null` for "none". */
  readonly lastError: string | null;
}

/** The accounts section: listed (possibly empty), or unavailable with a reason. */
export type AccountsSection =
  | { readonly state: 'listed'; readonly accounts: readonly AccountReportLine[] }
  | { readonly state: 'unavailable'; readonly reason: string };

/** Everything the report renderer needs; the handler assembles it. */
export interface StatusReport {
  readonly ownerName: string;
  /** The rendered Installed value (paths and the both-installed mistake). */
  readonly installed: string;
  /** The rendered Manager value; `null` omits the line (nothing installed). */
  readonly manager: string | null;
  /** The rendered Running value (running/stopped/stale/unknown with detail). */
  readonly running: string;
  readonly dataDir: string;
  readonly configPath: string;
  readonly configState: 'valid' | 'valid-env-only' | 'absent' | 'invalid';
  /** The §10 display zone; printed only for a valid configuration. */
  readonly timeZone: string | null;
  readonly accounts: AccountsSection;
  /**
   * The dead-engine warning line (FSM-4, D-192), or `null` when the
   * evidence does not suggest one ({@link assessEngineLiveness}): the
   * service running while no account has recorded a cycle for more than
   * three polling intervals. Advisory only — never a probe failure, so
   * the exit code is untouched (D-114).
   */
  readonly engineWarning: string | null;
}

/**
 * Renders the whole report — one deterministic string, so every scenario in
 * the suites pins its exact bytes (the 141 renderer precedent). No secret
 * ever enters: the fields are labels, paths, pids, timestamps, and the
 * already-redacted error text.
 */
export function renderStatusReport(report: StatusReport): string {
  const configState =
    report.configState === 'valid'
      ? 'valid'
      : report.configState === 'valid-env-only'
        ? 'valid — from environment overrides, no configuration file'
        : report.configState === 'absent'
          ? 'not configured yet'
          : 'invalid — the problems are on stderr';
  /** The report body up to the accounts section's own ending. */
  const body = (() => {
    const lines = [
      'Quotameter status',
      '',
      'Service:',
      `  Owner: ${report.ownerName}`,
      `  Installed: ${report.installed}`,
    ];
    if (report.manager !== null) {
      lines.push(`  Manager: ${report.manager}`);
    }
    lines.push(
      `  Running: ${report.running}`,
      `  Data directory: ${report.dataDir}`,
      `  Configuration: ${report.configPath} (${configState})`,
    );
    if (report.timeZone !== null) {
      lines.push(`  Display time zone: ${report.timeZone}`);
    }
    lines.push('');
    if (report.accounts.state === 'unavailable') {
      lines.push(`Accounts: unavailable — ${report.accounts.reason}`);
      return lines;
    }
    const accounts = report.accounts.accounts;
    if (accounts.length === 0) {
      lines.push('Accounts: none configured yet — add one with quotameter init or in the web UI.');
      return lines;
    }
    lines.push(`Accounts (${accounts.length}):`);
    for (const account of accounts) {
      lines.push(
        `  ${account.label} (${account.providerId})`,
        `    Status: ${account.status}`,
        `    Last collection: ${
          account.lastCollection ?? 'none yet (no successful collection recorded)'
        }`,
        `    Last error: ${account.lastError ?? 'none'}`,
      );
    }
    return lines;
  })();
  // The dead-engine warning rides every path (in practice it can only be
  // non-null on the listed-accounts one — the suspicion needs runs — but
  // the renderer owes the field its place unconditionally).
  if (report.engineWarning !== null) {
    body.push('', report.engineWarning);
  }
  return body.join('\n');
}

/* ── The handler ───────────────────────────────────────────────────────── */

/** Injectable collaborators; every one has a production default. */
export interface ServiceStatusDeps {
  /** The §5.3 step 1 owner resolution (task 136, D-105); production `resolveServiceOwner`. */
  readonly resolveOwner?: () => ServiceOwnerResolution;
  /**
   * The environment both the owner-scoped §6.1 directories and the
   * configuration pipeline read; production `process.env`. `HOME` is always
   * forced to the owner's home for the directories, the same D-112
   * discipline `reload` follows.
   */
  readonly pathEnv?: PathEnv;
  /** Whether a unit file is on disk; production `unitFileExistsOnDisk` (task 139). */
  readonly unitFileExists?: (installPath: string) => boolean;
  /** The §5.3 capability probe (task 137); production `probeServiceCapabilities`. */
  readonly probeCapabilities?: CapabilityProbe;
  /** The service-command executor; production `spawnServiceCommand`. */
  readonly runCommand?: ServiceCommandRunner;
  /** Reads the single-instance lock; production `readServiceLock` (task 141). */
  readonly readLock?: (lockPath: string) => Promise<ServiceLockRead>;
  /** Liveness probe for the recorded holder pid; production `isProcessAlive`. */
  readonly isAlive?: (pid: number) => boolean;
  /** The configuration pipeline; production `loadConfigWithEnv`. */
  readonly validate?: (configPath: string, env: NodeJS.ProcessEnv) => Promise<ConfigEnvLoadResult>;
  /** Opens the data directory's database; production {@link openStatusStore}. */
  readonly openStore?: (dataDir: string) => Promise<StatusStoreRead>;
  /** The clock reading every §7.3 derivation and §10 rendering uses; production the system clock (D-021). */
  readonly now?: () => EpochMs;
}

/**
 * Builds the §5.2 `quotameter status` handler (task 142, D-114): resolves
 * the owner, establishes the installed scope, the manager view, the running
 * state, the configuration, and every account's §7.3 status, last
 * collection, and last error — then renders the report. Never throws;
 * returns the process exit code (0 exactly when every probe answered).
 */
export function runStatusCommand(deps: ServiceStatusDeps = {}): CliHandler {
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

    // Everything below renders into one report; a probe that cannot answer
    // marks the report incomplete (exit 1) but never hides the facts the
    // other probes established.
    const nowEpochMs = (deps.now ?? createSystemClock().now)();
    let incomplete = false;

    /* Installed scope (D-110's disk discovery, the 140 handler's shape). */
    const unitFileExists = deps.unitFileExists ?? unitFileExistsOnDisk;
    const systemUnit = unitFileExists(SYSTEM_UNIT_INSTALL_PATH);
    // ownerUnitDirectories validated the owner's home, so the user-unit path
    // resolves here too (the 140 handler's invariant).
    const userUnitPath = userUnitInstallPath(owner.user.home);
    const userUnit = unitFileExists(userUnitPath);
    const bothInstalled = systemUnit && userUnit;
    const selected: 'system' | 'user' | undefined = bothInstalled
      ? owner.privileges === 'held'
        ? 'system'
        : 'user'
      : systemUnit
        ? 'system'
        : userUnit
          ? 'user'
          : undefined;
    const installed = bothInstalled
      ? `both a system service (${SYSTEM_UNIT_INSTALL_PATH}) and a user service (${userUnitPath}) — two independent services for the same data; only one should be installed`
      : systemUnit
        ? `system service (${SYSTEM_UNIT_INSTALL_PATH})`
        : userUnit
          ? `user service (${userUnitPath})`
          : 'no systemd service (run in the foreground with quotameter run, or install one)';

    /* Running state (D-112's lock read; run-mode independent). */
    const lockPath = lockFilePath(directories.dataDir);
    const lock = await (deps.readLock ?? readServiceLock)(lockPath);
    let running: string;
    // The dead-engine suspicion's service half (FSM-4, D-192): only a
    // service that actually holds the data directory can have a DEAD
    // engine — a stopped service's old cycles are expected, not evidence.
    let serviceRunning = false;
    if (lock.state === 'absent') {
      running = `stopped (no instance holds the data directory ${directories.dataDir})`;
    } else if (lock.state === 'held') {
      const isAlive = deps.isAlive ?? isProcessAlive;
      if (isAlive(lock.pid)) {
        serviceRunning = true;
        running = `running (pid ${lock.pid})`;
      } else {
        running = `stopped (stale lock naming pid ${lock.pid} — the service stopped without releasing it; the next start clears it automatically)`;
      }
    } else if (lock.state === 'unreadable') {
      ctx.output.err(
        failureLine(errorPrefix, `reading the service lock ${lockPath} failed`, lock.detail),
      );
      running = `unknown (the lock file ${lockPath} cannot be read)`;
      incomplete = true;
    } else {
      ctx.output.err(
        failureLine(errorPrefix, `${lockPath} is not a valid quotameter lock file`, ''),
      );
      running = `unknown (${lockPath} is not a valid quotameter lock file)`;
      incomplete = true;
    }

    /* Manager state (installed units only; unprivileged query). */
    const capabilities = await (deps.probeCapabilities ?? probeServiceCapabilities)();
    const plan = planManagerProbe({
      selected,
      privileges: owner.privileges,
      capabilities,
      ownerName: owner.user.name,
    });
    const runCommand = deps.runCommand ?? spawnServiceCommand;
    const manager =
      plan.state === 'ask'
        ? describeManagerState(plan, await runCommand(plan.command), bothInstalled)
        : describeManagerState(plan, undefined, bothInstalled);
    if (manager.incomplete) {
      incomplete = true;
    }

    /* Configuration (the service's own pipeline; D-112's precedent). */
    const configPath = configFilePath(directories.configDir);
    const validate = deps.validate ?? loadConfigWithEnv;
    const config = await validate(configPath, env);
    // The pinned not-found message is the sanctioned absence detection (the
    // 141 handler's technique, from task 064's contract).
    const configAbsent =
      !config.ok &&
      config.problems.length === 1 &&
      config.problems[0] === `configuration file not found: ${configPath}`;
    let configState: StatusReport['configState'];
    if (config.ok) {
      // §6.3's env-only mode reports its provenance: the effective
      // configuration is real, but there is no file at this path.
      configState = config.fileAbsent ? 'valid-env-only' : 'valid';
    } else if (configAbsent) {
      configState = 'absent';
    } else {
      for (const problem of config.problems) {
        ctx.output.err(`${errorPrefix}: ${problem}`);
      }
      configState = 'invalid';
      incomplete = true;
    }

    /* Per-account facts (§7.3 through task 111; §7.2's two most-recents). */
    let accounts: AccountsSection;
    // The dead-engine suspicion's evidence half (FSM-4, D-192): each
    // pollable account's newest-run facts, or nothing when no run exists
    // for any of them (fresh install, empty store).
    const livenessAccounts: EngineAccountSilence[] = [];
    if (!config.ok) {
      accounts = configAbsent
        ? // Nothing is configured — the helpful §5.2 next step, not an error.
          { state: 'listed', accounts: [] }
        : {
            state: 'unavailable',
            reason: 'the configuration is invalid (the problems are on stderr)',
          };
    } else {
      // Defaults completion materializes every section (D-018), so the
      // accounts array and the auth section exist on a validated config.
      const validConfig = config.config;
      const accountConfigs = validConfig.accounts!;
      // The redaction list covers every §6.3 secret source: file-stored keys,
      // environment-supplied key values (a first-class §6.3 mode — the
      // defense-in-depth promise must hold for it too), and the password hash.
      const secrets: string[] = [];
      for (const account of accountConfigs) {
        if (account.apiKey !== undefined) secrets.push(account.apiKey);
        if (account.apiKeyEnv !== undefined) {
          const value = env[account.apiKeyEnv];
          if (typeof value === 'string' && value !== '') secrets.push(value);
        }
      }
      const passwordHash = validConfig.auth!.passwordHash;
      if (passwordHash !== undefined) secrets.push(passwordHash);

      /** Everything the storage read of one account produced. */
      interface AccountFacts {
        readonly evidence: PollingRunEvidence;
        readonly errorRun: CollectionRunRecord | null;
        /** Whether the account's storage row is archived (§8.2, rank 0). */
        readonly archived: boolean;
        /**
         * The account's newest run row (any outcome — the dead-engine
         * suspicion's liveness anchor, FSM-4/D-192: the stamp plus the
         * two facts that legitimately widen an account's expected
         * silence); `null` when no run exists.
         */
        readonly latestRun: CollectionRunRecord | null;
      }

      /** The storage reads of one account — the only I/O in the block. */
      const readAccountFacts = (repository: QuotaRepository, accountId: string): AccountFacts => ({
        evidence: readPollingRunEvidence(repository, accountId),
        errorRun: findLatestErrorRun(repository, accountId),
        archived: repository.getAccount(accountId)?.status === 'archived',
        latestRun: repository.getLatestCollectionRun(accountId),
      });

      /** The pure render of one account's block (no I/O). */
      const renderAccountLine = (
        account: (typeof accountConfigs)[number],
        facts: AccountFacts,
      ): AccountReportLine => {
        const status = deriveAccountStatus(
          {
            archived: facts.archived,
            enabled: account.enabled !== false,
            configured: resolveAccountConfigured(account, env),
            suspension: INITIAL_SUSPENSION_STATE,
            runs: facts.evidence,
            // Defaults completion materializes the interval (D-018); the
            // non-null assertion states that invariant (the U-009 house
            // pattern, no defensive fallback arm).
            intervalSeconds: validConfig.app.pollingIntervalSeconds!,
          },
          nowEpochMs,
        );
        const lastCollection =
          facts.evidence.lastSuccessAt === null
            ? null
            : formatStatusTimestamp(facts.evidence.lastSuccessAt, validConfig.app.timezone);
        const { errorRun } = facts;
        const lastError =
          errorRun === null
            ? null
            : [
                `${formatStatusTimestamp(errorRun.endedAt, validConfig.app.timezone)}: `,
                RUN_OUTCOME_LABELS[errorRun.outcome],
                errorRun.errorMessage === null || errorRun.errorMessage === ''
                  ? errorRun.httpStatus === null
                    ? ''
                    : ` (HTTP ${errorRun.httpStatus})`
                  : ` — ${redactSecrets(errorRun.errorMessage, secrets)}`,
              ].join('');
        return {
          label: account.label,
          providerId: account.providerId,
          status: ACCOUNT_STATUS_LABELS[status],
          lastCollection,
          lastError,
        };
      };

      const emptyFacts: AccountFacts = {
        evidence: { latestRunOutcome: null, lastSuccessAt: null, firstAttemptAt: null },
        errorRun: null,
        // No database file: no rows exist by construction, so nothing is
        // archived — the derivation's `archived: false` is the honest read.
        archived: false,
        latestRun: null,
      };

      const openStore = deps.openStore ?? openStatusStore;
      const store = await openStore(directories.dataDir);
      if (store.state === 'failed') {
        ctx.output.err(
          failureLine(errorPrefix, 'reading the service database failed', store.detail),
        );
        accounts = { state: 'unavailable', reason: 'the storage read failed (see stderr)' };
        incomplete = true;
      } else if (store.state === 'absent') {
        // No database file: no runs exist by construction — the derivation's
        // no-run paths answer, and the command never creates a database.
        accounts = {
          state: 'listed',
          accounts: accountConfigs.map((account) => renderAccountLine(account, emptyFacts)),
        };
      } else {
        try {
          // Only the repository reads sit in the try: the failure line names
          // storage, and the render beside it cannot throw on these inputs
          // (the derivation's inputs are validated upstream; the zone came
          // through the configuration contract).
          const facts = accountConfigs.map((account) =>
            readAccountFacts(store.repository, account.id),
          );
          accounts = {
            state: 'listed',
            accounts: accountConfigs.map((account, index) =>
              renderAccountLine(account, facts[index]!),
            ),
          };
          // The suspicion reads only the accounts the engine would poll
          // (enabled, secret resolvable in THIS environment — the
          // CLI-side approximation of the pollable set; a disabled or
          // unconfigured account never runs, so its silence is not
          // evidence of a dead engine). Any outcome counts: a failing
          // cycle still proves the loop alive, and the row's own
          // deferral/suspension facts widen that account's expectation
          // inside the pure judgment below.
          for (const [index, account] of accountConfigs.entries()) {
            if (account.enabled === false || !resolveAccountConfigured(account, env)) continue;
            const run = facts[index]!.latestRun;
            if (run === null) continue;
            livenessAccounts.push({
              startedAt: run.startedAt,
              outcome: run.outcome,
              retryAfterSeconds: run.retryAfterSeconds,
            });
          }
        } catch (error) {
          ctx.output.err(
            failureLine(errorPrefix, 'reading the service database failed', thrownMessage(error)),
          );
          accounts = { state: 'unavailable', reason: 'the storage read failed (see stderr)' };
          incomplete = true;
        } finally {
          store.close();
        }
      }
    }

    /* The dead-engine suspicion (FSM-4, D-192) — advisory, exit-neutral. */
    const liveness = assessEngineLiveness({
      serviceRunning,
      accounts: livenessAccounts,
      // A non-ok configuration leaves the evidence empty (no-evidence),
      // so the interval never decides anything there; the default keeps
      // the pure function's input contract honest regardless.
      intervalSeconds: config.ok
        ? config.config.app.pollingIntervalSeconds!
        : CONFIG_DEFAULTS.app.pollingIntervalSeconds!,
      nowEpochMs,
    });
    const engineWarning =
      liveness.kind !== 'stale-silence' || !config.ok
        ? null
        : `Warning: the service is running, but the newest collection cycle is older than three polling intervals (last cycle ${formatStatusTimestamp(liveness.newestCycleAt, config.config.app.timezone)}) — the polling engine may have stopped. Run quotameter logs to inspect the service records.`;

    ctx.output.out(
      renderStatusReport({
        ownerName: owner.user.name,
        installed,
        manager: manager.line,
        running,
        dataDir: directories.dataDir,
        configPath,
        configState,
        timeZone: config.ok ? config.config.app.timezone : null,
        accounts,
        engineWarning,
      }),
    );
    return incomplete ? 1 : 0;
  };
}
