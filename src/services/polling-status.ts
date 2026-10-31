/**
 * Account status derivation (spec §7.3, §14.6, §13; task 111, decision D-070).
 *
 * The pure view over the polling pipeline: {@link deriveAccountStatus} picks
 * the primary displayed account status from §7.3's precedence using exactly
 * the evidence the landed tasks already produce — task 105's
 * `STATUS_CONTRIBUTION_BY_OUTCOME` for the three failure-defined ranks (no
 * re-derivation: a 429 or a success contributes nothing and falls through to
 * the age-based states, D-048's explicit delegation), task 108's D-064
 * suspension state for `Auth rejected` (§7.2's pause *is* the status: it is
 * entered by a 401/403 and released only by a key change, a manual test, or
 * a successful probe), and the repository's latest-by-outcome run reads for
 * the time dimension. {@link readPollingRunEvidence} is the storage seam:
 * the three §11.2 lookups D-058 designed for this consumer (latest cycle,
 * latest snapshot, oldest cycle), frozen into the evidence object the
 * caller spreads beside its configuration and scheduler inputs.
 *
 * Pinned interpretations (D-070):
 *
 * - **`Auth rejected` = the suspension is active OR the latest run is an
 *   `auth_error`** — the "outcome contribution plus suspension state" D-064
 *   reserved for this task. The disjunction covers the two states a single
 *   input misses: an *inconclusive* verification probe (network, timeout,
 *   5xx, 429, parse) while suspended leaves the latest run a failure yet
 *   rank 1 still governs (the probe proved nothing about the key), and the
 *   window after a release or a restart (the in-memory suspension is gone
 *   or re-armed, the last recorded verdict is still a rejection) keeps the
 *   truthful display until the next cycle supersedes it — one cycle long,
 *   because D-066 makes the post-release poll immediately due.
 * - **`Collecting` = no successful collection yet, within three configured
 *   intervals of the account's first attempt (or no attempts at all)**.
 *   `Fresh`/`Stale` are defined by the age of the *latest success*, which
 *   does not exist yet for such an account; `Collecting` is §7.3's state
 *   for "collection is underway, no data yet". The live-activity reading
 *   ("a cycle is in flight right now") is rejected: the precedence list is
 *   ordered by evidence (failure class, then data age), an in-flight
 *   indicator would need scheduler state as an input, and it would leave
 *   no state at all for an idle account without data.
 * - **The `Stale` anchor is the latest success, or — when none exists — the
 *   first recorded attempt**: "no successful collection for more than three
 *   configured collection intervals" measures how long the lack of success
 *   has lasted, from the moment it began (the last success, or the first
 *   attempt when there has never been one). The boundary follows the spec's
 *   own words: `Fresh` at an age of at most three intervals ("no older
 *   than"), `Stale` only past them ("more than").
 * - **The failure ranks read the latest cycle's class only** — §7.3 attaches
 *   no recency qualifier to `Unreachable` ("latest cycle failed due to
 *   network issue, timeout, or 5xx"); the age dimension enters exclusively
 *   through ranks 4–6, so rank 3 beats a stale-but-recently-cycled account.
 * - **`Disabled` outranks `Not configured`**, both ahead of the precedence
 *   list: the operator's enablement is the outermost switch, so a disabled
 *   account shows `Disabled` whether or not its key is resolved.
 *   `configured` means *a usable secret is resolved* — `apiKey` set, or
 *   `apiKeyEnv` naming a variable the process provides (§6.3). The config
 *   contract rejects an account declaring neither source, so the reachable
 *   `Not configured` account is the unresolved-`apiKeyEnv` one; the caller
 *   resolves the flag from the live configuration.
 *
 * Time never comes from the machine clock (D-021): `nowEpochMs` is an
 * argument of {@link deriveAccountStatus}, and the reader reads no time at
 * all — the evidence is timeless data, so a status is recomputable for any
 * instant (§13's `/api/status` and §5.2's `quotameter status` pass their
 * own clock reading).
 */

import type { QuotaRepository } from '../storage/repository';
import { MAX_POLLING_INTERVAL_MS, MIN_POLLING_INTERVAL_MS } from './polling-scheduler';
import {
  STATUS_CONTRIBUTION_BY_OUTCOME,
  isCollectionOutcome,
  type CollectionOutcome,
} from './polling-outcomes';
import { isSuspended, type AuthSuspensionState } from './polling-suspension';

/* ── The §7.3/§14.6 status vocabulary ──────────────────────────────────── */

/**
 * Every account status spec §7.3/§14.6 distinguishes, in §7.3's precedence
 * order for the six ranked states, followed by the two separate
 * (`Disabled`, `Not configured`) states. Membership, not order, is the
 * wire contract for §13's API; a new status is a code change plus a
 * decision.
 */
export const ACCOUNT_STATUSES = Object.freeze([
  'auth-rejected',
  'format-changed',
  'unreachable',
  'stale',
  'collecting',
  'fresh',
  'disabled',
  'not-configured',
] as const);

/** One account's primary displayed status (spec §7.3, §14.6). */
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * The exact §7.3/§14.6 English spellings, keyed by machine token — the
 * display vocabulary for §5.2's `quotameter status` (English-only CLI
 * output); the web UI maps the tokens through its own i18n catalog.
 */
export const ACCOUNT_STATUS_LABELS: Readonly<Record<AccountStatus, string>> = Object.freeze({
  'auth-rejected': 'Auth rejected',
  'format-changed': 'Format changed',
  unreachable: 'Unreachable',
  stale: 'Stale',
  collecting: 'Collecting',
  fresh: 'Fresh',
  disabled: 'Disabled',
  'not-configured': 'Not configured',
});

/**
 * §7.3's freshness window multiplier: both `Fresh` ("no older than three
 * configured intervals") and `Stale` ("more than three") are measured in
 * multiples of the configured §7.1 polling interval. Fixed by the spec —
 * no configuration may change it.
 */
export const STATUS_FRESHNESS_INTERVALS = 3;

/* ── The repository evidence ───────────────────────────────────────────── */

/**
 * The run-history evidence of one account — everything §7.3's derivation
 * needs from storage, as three timeless values {@link readPollingRunEvidence}
 * freezes from the repository's latest-by-outcome reads. `lastSuccessAt` is
 * the latest snapshot's §8.4 collection stamp (the data's own timestamp;
 * D-060 commits it atomically with its success run, so the two cannot
 * disagree); `firstAttemptAt` is the account's oldest run's start — the
 * `Stale` anchor when no success exists.
 */
export interface PollingRunEvidence {
  /**
   * The outcome of the account's latest completed cycle, or `null` when the
   * account has no runs (its §7.1 immediate first poll is due or in
   * flight).
   */
  readonly latestRunOutcome: CollectionOutcome | null;
  /** The latest successful collection's epoch-ms stamp, or `null` when none exists. */
  readonly lastSuccessAt: number | null;
  /** The account's first cycle attempt's epoch-ms start, or `null` when no runs exist. */
  readonly firstAttemptAt: number | null;
}

/**
 * Reads one account's §7.3 evidence from the repository — the three D-058
 * lookups designed for this consumer: `getLatestCollectionRun` (the latest
 * cycle's outcome), `getLatestSnapshot` (the last success's collection
 * stamp), and `listCollectionRuns` with `limit: 1` (the ascending order
 * makes the cap select the account's *oldest* run — the no-success `Stale`
 * anchor). Returns a frozen evidence object; the caller owns combining it
 * with configuration and scheduler state into an {@link AccountStatusInput}.
 */
export function readPollingRunEvidence(
  repository: QuotaRepository,
  accountId: string,
): PollingRunEvidence {
  if (
    typeof repository !== 'object' ||
    repository === null ||
    typeof repository.getLatestCollectionRun !== 'function' ||
    typeof repository.getLatestSnapshot !== 'function' ||
    typeof repository.listCollectionRuns !== 'function'
  ) {
    throw new TypeError('readPollingRunEvidence: repository must be a QuotaRepository');
  }
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    throw new TypeError('readPollingRunEvidence: accountId must be a non-blank string');
  }
  const latestRun = repository.getLatestCollectionRun(accountId);
  const latestSnapshot = repository.getLatestSnapshot(accountId);
  const oldestRun = repository.listCollectionRuns(accountId, { limit: 1 })[0];
  return Object.freeze({
    latestRunOutcome: latestRun === null ? null : latestRun.outcome,
    lastSuccessAt: latestSnapshot === null ? null : latestSnapshot.collectedAt,
    firstAttemptAt: oldestRun === undefined ? null : oldestRun.startedAt,
  });
}

/* ── Input validation (fail-fast, the D-064/D-066 convention) ──────────── */

/** Validates the injected clock reading; the D-021 discipline. */
function requireFiniteNow(nowEpochMs: number, caller: string): void {
  if (!Number.isFinite(nowEpochMs)) {
    throw new TypeError(`${caller}: nowEpochMs must be a finite number`);
  }
}

/**
 * Validates the §7.1 interval in seconds against the same bounds
 * {@link createPollingScheduler} enforces in milliseconds — one source of
 * truth, so a seconds/milliseconds wiring bug fails here at assembly, not
 * as a silently nine-times-too-long freshness window.
 */
function requireIntervalSeconds(intervalSeconds: number, caller: string): void {
  if (
    typeof intervalSeconds !== 'number' ||
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds * 1000 < MIN_POLLING_INTERVAL_MS ||
    intervalSeconds * 1000 > MAX_POLLING_INTERVAL_MS
  ) {
    throw new RangeError(
      `${caller}: intervalSeconds must be an integer in [${MIN_POLLING_INTERVAL_MS / 1000}, ` +
        `${MAX_POLLING_INTERVAL_MS / 1000}] (spec §7.1)`,
    );
  }
}

/** Structural validation of the derivation input against wiring bugs. */
function requireStatusInput(input: AccountStatusInput, caller: string): void {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError(`${caller}: input must be an AccountStatusInput`);
  }
  if (typeof input.enabled !== 'boolean' || typeof input.configured !== 'boolean') {
    throw new TypeError(`${caller}: enabled and configured must be booleans`);
  }
  // The derivation reads only the gate; D-064's own transitions validate the
  // full state, and a hand-crafted `{ suspended: <non-boolean> }` must fail
  // loudly rather than narrow arbitrarily.
  if (
    typeof input.suspension !== 'object' ||
    input.suspension === null ||
    typeof input.suspension.suspended !== 'boolean'
  ) {
    throw new TypeError(`${caller}: suspension must be an AuthSuspensionState (D-064)`);
  }
  if (typeof input.runs !== 'object' || input.runs === null) {
    throw new TypeError(`${caller}: runs must be a PollingRunEvidence`);
  }
  if (input.runs.latestRunOutcome !== null && !isCollectionOutcome(input.runs.latestRunOutcome)) {
    // 'cancelled' (D-048's pseudo-outcome) lands here too: it is never
    // persisted, so it can never be a latest run's outcome.
    throw new TypeError(`${caller}: runs.latestRunOutcome must be a CollectionOutcome or null`);
  }
  if (input.runs.lastSuccessAt !== null && !Number.isFinite(input.runs.lastSuccessAt)) {
    throw new TypeError(`${caller}: runs.lastSuccessAt must be a finite epoch or null`);
  }
  if (input.runs.firstAttemptAt !== null && !Number.isFinite(input.runs.firstAttemptAt)) {
    throw new TypeError(`${caller}: runs.firstAttemptAt must be a finite epoch or null`);
  }
  requireIntervalSeconds(input.intervalSeconds, caller);
}

/* ── The derivation ────────────────────────────────────────────────────── */

/** Everything §7.3's precedence consumes besides the clock reading. */
export interface AccountStatusInput {
  /** Whether the account is enabled in the live configuration (§6.2). */
  readonly enabled: boolean;
  /**
   * Whether a usable provider secret is resolved for the account: `apiKey`
   * set, or `apiKeyEnv` naming a variable the process provides (§6.3). The
   * configuration contract rejects an account declaring neither source, so
   * the reachable `Not configured` account is the unresolved-`apiKeyEnv`
   * one; the caller resolves this flag from the live configuration.
   */
  readonly configured: boolean;
  /**
   * The account's D-064 suspension state — the §7.2 401/403 pause. The
   * scheduler holds it; a status view after a restart passes
   * `INITIAL_SUSPENSION_STATE` (the derivation's `auth_error`-run branch
   * keeps the display truthful for that first cycle, D-070).
   */
  readonly suspension: AuthSuspensionState;
  /** The account's run-history evidence (see {@link readPollingRunEvidence}). */
  readonly runs: PollingRunEvidence;
  /** The configured §7.1 polling interval in effect, in seconds. */
  readonly intervalSeconds: number;
}

/**
 * Derives the account's primary displayed status (spec §7.3, §14.6) — a
 * total function of evidence and time:
 *
 * | Order | Status | Condition |
 * | --- | --- | --- |
 * | 0a | `disabled` | `enabled` is false |
 * | 0b | `not-configured` | no usable secret is resolved |
 * | 1 | `auth-rejected` | D-064 suspension active, or the latest run is `auth_error` |
 * | 2 | `format-changed` | the latest run is `parse_error` |
 * | 3 | `unreachable` | the latest run is `network_error`/`timeout`/`server_error` |
 * | 4 | `stale` | no successful collection for more than three intervals |
 * | 5 | `collecting` | no success yet, within three intervals of the first attempt (or no runs) |
 * | 6 | `fresh` | latest success no older than three intervals |
 *
 * Ranks 1–3 consume D-048's contribution table as data (`rate_limited` and
 * `success` contribute nothing and fall through); ranks 4–6 measure the age
 * of the latest success — or of the first attempt when none exists —
 * against `STATUS_FRESHNESS_INTERVALS × intervalSeconds`. A wall reading
 * behind the last success (clock regression, D-021) yields a negative age
 * and stays `Fresh`: fail-safe in the direction of not alarming.
 */
export function deriveAccountStatus(input: AccountStatusInput, nowEpochMs: number): AccountStatus {
  requireStatusInput(input, 'deriveAccountStatus');
  requireFiniteNow(nowEpochMs, 'deriveAccountStatus');

  if (!input.enabled) return 'disabled';
  if (!input.configured) return 'not-configured';

  const latest = input.runs.latestRunOutcome;
  const contribution = latest === null ? 'none' : STATUS_CONTRIBUTION_BY_OUTCOME[latest];
  // Rank 1 is the disjunction D-064 reserved for this task: the pause is the
  // status, and an inconclusive probe while suspended must not downgrade it.
  if (isSuspended(input.suspension) || contribution === 'auth-rejected') return 'auth-rejected';
  if (contribution === 'format-changed') return 'format-changed';
  if (contribution === 'unreachable') return 'unreachable';

  const thresholdMs = STATUS_FRESHNESS_INTERVALS * input.intervalSeconds * 1000;
  if (input.runs.lastSuccessAt !== null) {
    // Ranks 4/6: the age of the data itself.
    return nowEpochMs - input.runs.lastSuccessAt <= thresholdMs ? 'fresh' : 'stale';
  }
  if (input.runs.firstAttemptAt === null) {
    // No runs at all: §7.1's immediate first poll is due or in flight.
    return 'collecting';
  }
  // Never a success: Collecting while the pipeline is still inside its
  // first freshness window, Stale once it has run dry of one.
  return nowEpochMs - input.runs.firstAttemptAt <= thresholdMs ? 'collecting' : 'stale';
}
