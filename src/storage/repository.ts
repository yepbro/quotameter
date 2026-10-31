/**
 * The typed repository facade — `QuotaRepository` (spec §8.1, §11; task 088,
 * decision D-058).
 *
 * Spec §8.1 names `QuotaRepository` among the core services and spec §3
 * requires all database access isolated behind a storage module; D-009
 * therefore pins it as the storage layer's public facade: services, the
 * composition root, and the CLI consume this interface, and every SQL
 * statement in the application lives inside `src/storage/`. The done-condition
 * of task 088 — application services issue no ad hoc SQL outside the storage
 * module — is enforced mechanically by
 * `test/unit/storage-sql-gate.spec.ts` (statement-shaped string literals
 * outside this directory fail `make check`) alongside the existing
 * `node:sqlite` import gate of `test/unit/package-layout.spec.ts` (D-009).
 *
 * The methods are deliberately **synchronous**: the driver is
 * `node:sqlite`'s `DatabaseSync` (D-002), so an async facade would only add
 * promise allocation around calls that cannot await anything. Pinned
 * interpretations (D-058):
 *
 * - **Timestamps are writer-supplied arguments, never read from a clock.**
 *   The repository takes no `Clock`; D-021's injectable clock belongs to the
 *   services that own write timing (the D-032/D-034/D-036/D-056 no-SQL-time
 *   rule carried into the API surface).
 * - **The named CHECK constraints are the write gate.** Tasks 081–087 built
 *   the schema so every domain invariant is enforced in SQL by a named
 *   constraint; the repository re-validates nothing, and constraint failures
 *   propagate unchanged — SQLite reports them by name (`CHECK constraint
 *   failed: metric_values_invalid_clean`), which is the diagnosable English
 *   vocabulary those tasks pinned. The repository only maps types the SQL
 *   cannot express: `is_valid` 0/1 ⇄ boolean, `derived_fields` bitmask ⇄
 *   `DerivedMetricField[]` (D-039: "the repository encodes/decodes").
 * - **Foreign-key carriers are internal.** `insertSnapshot` writes the
 *   CHECK-bound `'success'` carrier and `insertRawResponse` the
 *   `'parse_error'` carrier (the D-036/D-051 composite-FK technique); callers
 *   never see or set `run_outcome` on these tables.
 * - **`withTransaction` is the atomicity seam** task 089 composes: run,
 *   snapshot, metric, event, and raw-response inserts inside its callback
 *   commit together or vanish together (spec §11.1). Plain inserts are single
 *   statements (atomic alone, not as a group) — multi-record cycles must wrap
 *   them. Nesting throws loudly, the D-027 no-nested-`BEGIN` rule.
 * - **Deletion follows the cascade direction the schema fixed**: purging an
 *   account (`deleteAccount`) removes its history through the `ON DELETE
 *   CASCADE` foreign keys; retention deletes (`delete…Before`) return the
 *   number of removed rows so task 091's cleanup can report what it did.
 *
 * Every read maps rows to readonly camelCase records over the §8.4 vocabulary
 * in `src/schemas/metrics.ts` before they leave this module; no `snake_case`
 * row and no `DatabaseSync` handle crosses the boundary.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { DerivedMetricField, LimitType, MetricUnit } from '../schemas/metrics';

/* ── Vocabulary types ──────────────────────────────────────────────────── */

/** The `accounts.status` enum (spec §11.2; D-032). */
export type AccountStatus = 'active' | 'archived';

/**
 * The `collection_runs.outcome` enum (spec §11.2): §7.2's outcome classes —
 * the storage vocabulary of §7.3's status precedence (D-034).
 */
export type RunOutcome =
  | 'success'
  | 'auth_error'
  | 'rate_limited'
  | 'network_error'
  | 'timeout'
  | 'server_error'
  | 'parse_error';

/** The `quota_events.event_type` enum (spec §11.2): `RESET` in version 1. */
export type QuotaEventType = 'RESET';

/* ── Records (read models) ─────────────────────────────────────────────── */

/** One `accounts` row (spec §11.2). Nullable columns read back as `null`. */
export interface AccountRecord {
  readonly id: string;
  readonly providerId: string;
  readonly label: string;
  readonly planName: string | null;
  readonly status: AccountStatus;
  readonly createdAt: number;
  readonly archivedAt: number | null;
}

/** One `collection_runs` row (spec §11.2) — a completed polling cycle. */
export interface CollectionRunRecord {
  readonly id: number;
  readonly accountId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly intervalSeconds: number;
  readonly outcome: RunOutcome;
  readonly httpStatus: number | null;
  readonly errorMessage: string | null;
  readonly attempts: number;
  readonly retryAfterSeconds: number | null;
}

/** One `snapshots` row (spec §11.2) — the §8.4 snapshot header. */
export interface SnapshotRecord {
  readonly runId: number;
  readonly accountId: string;
  readonly collectedAt: number;
  readonly planName: string | null;
}

/** One `metric_values` row (spec §11.2) — a persisted §8.4 metric reading. */
export interface MetricValueRecord {
  readonly accountId: string;
  readonly runId: number;
  readonly collectedAt: number;
  readonly metricKey: string;
  readonly limitType: LimitType;
  readonly unit: MetricUnit;
  readonly windowSeconds: number | null;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly limit: number | null;
  readonly percentUsed: number | null;
  readonly percentRemaining: number | null;
  readonly resetsAt: number | null;
  readonly isValid: boolean;
  readonly invalidReason: string | null;
  readonly derivedFields: ReadonlyArray<DerivedMetricField> | null;
}

/** One `quota_events` row (spec §11.2, §12.1). */
export interface QuotaEventRecord {
  readonly accountId: string;
  readonly metricKey: string;
  readonly eventType: QuotaEventType;
  readonly eventAt: number;
  readonly runId: number | null;
  readonly details: QuotaEventDetails;
}

/** One `raw_responses` row (spec §7.4, §11.2) — a sanitized parse-failure body. */
export interface RawResponseRecord {
  readonly runId: number;
  readonly accountId: string;
  readonly capturedAt: number;
  readonly httpStatus: number | null;
  readonly contentType: string | null;
  readonly body: string;
}

/** One `sessions` row (spec §11.2, §15.2). */
export interface SessionRecord {
  readonly tokenHash: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
}

/**
 * The §12.1 detection evidence a `quota_events.details` row carries. The SQL
 * CHECKs (D-046) pin the audit minimum — a non-empty `reason` and the compared
 * `previous`/`current` points; the deeper vocabulary (point fields,
 * `tolerance`, `eventTimeSource`, …) is the detector's to produce, so extra
 * properties pass through verbatim.
 */
export interface QuotaEventDetails {
  /** Which §12.1 condition fired, and any conservative-approach exception. */
  readonly reason: string;
  /** The previous valid point the new snapshot was compared against. */
  readonly previous: Record<string, unknown>;
  /** The new point whose values triggered the event. */
  readonly current: Record<string, unknown>;
  readonly [evidence: string]: unknown;
}

/* ── Write inputs ──────────────────────────────────────────────────────── */

/** Values for `insertAccount`. New accounts start `active` (spec §8.2). */
export interface NewAccount {
  readonly id: string;
  readonly providerId: string;
  readonly label: string;
  /** Absent or `null` stores no plan; when present, non-blank (§8.4 shape). */
  readonly planName?: string | null;
  /** §11.1 epoch milliseconds, supplied by the writer (D-021). */
  readonly createdAt: number;
}

/** The mutable `accounts` fields a configuration sync may change. */
export interface AccountChanges {
  readonly label?: string;
  /** Explicit `null` clears the plan; absent leaves it unchanged. */
  readonly planName?: string | null;
}

/** Values for `insertCollectionRun` — one row per cycle, any outcome (§11.1). */
export interface NewCollectionRun {
  readonly accountId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly intervalSeconds: number;
  readonly outcome: RunOutcome;
  readonly httpStatus?: number | null;
  /** Already-sanitized text (§7.2); must be absent on a success run. */
  readonly errorMessage?: string | null;
  readonly attempts: number;
  readonly retryAfterSeconds?: number | null;
}

/**
 * Values for `insertSnapshot` — one row per **successful** run (§11.1). The
 * success linkage is structural: the insert fails with a foreign-key
 * violation unless `runId` names an existing run of this account whose
 * outcome is `success` (D-036).
 */
export interface NewSnapshot {
  readonly accountId: string;
  readonly runId: number;
  readonly collectedAt: number;
  readonly planName?: string | null;
}

/**
 * Values for `insertMetricValues` — the persisted §8.4 metric without its
 * `label` (§11.2's row omits it, D-039). The denormalized `accountId`/
 * `collectedAt` are explicit and must match the referenced snapshot exactly;
 * the composite foreign key rejects drift loudly (D-039).
 */
export interface NewMetricValue {
  readonly accountId: string;
  readonly runId: number;
  readonly collectedAt: number;
  readonly metricKey: string;
  readonly limitType: LimitType;
  readonly unit: MetricUnit;
  readonly windowSeconds?: number | null;
  readonly used?: number | null;
  readonly remaining?: number | null;
  readonly limit?: number | null;
  readonly percentUsed?: number | null;
  readonly percentRemaining?: number | null;
  readonly resetsAt?: number | null;
  readonly isValid: boolean;
  readonly invalidReason?: string | null;
  /**
   * Fields computed from other supplied fields (§8.4); absent or `null`
   * stores no mask, an empty array stores the empty mask. Stored as the
   * D-039 bitmask — the bit assignment is on-disk contract.
   */
  readonly derivedFields?: ReadonlyArray<DerivedMetricField> | null;
}

/** Values for `insertQuotaEvent`. */
export interface NewQuotaEvent {
  readonly accountId: string;
  readonly metricKey: string;
  readonly eventType: QuotaEventType;
  /**
   * §12.1's rule: the previous point's `resetsAt` when it lay between the
   * two snapshots, else the new snapshot's collection time — deliberately
   * its own value, not the snapshot's (D-046).
   */
  readonly eventAt: number;
  /** The optional §11.2 snapshot reference — the D-036 run identity. */
  readonly runId?: number | null;
  readonly details: QuotaEventDetails;
}

/** Values for `insertRawResponse` — only parse-failure runs qualify (§7.4). */
export interface NewRawResponse {
  readonly accountId: string;
  readonly runId: number;
  readonly capturedAt: number;
  readonly httpStatus?: number | null;
  readonly contentType?: string | null;
  /** The sanitizer's bounded output, stored as-is (D-041/D-051). */
  readonly body: string;
}

/** Values for `insertSession`. */
export interface NewSession {
  /** SHA-256 hex digest of the cookie token — never the token (§15.2). */
  readonly tokenHash: string;
  readonly createdAt: number;
  /** Initialized to the creation time: login is the first sighting (D-056). */
  readonly lastSeenAt: number;
  /** The effective expiry: `min(lastSeen + 7 d, created + 30 d)` (D-056). */
  readonly expiresAt: number;
}

/** The refresh write `touchSession` performs on authenticated use. */
export interface SessionSighting {
  readonly lastSeenAt: number;
  readonly expiresAt: number;
}

/* ── Query options ─────────────────────────────────────────────────────── */

/** Optional filters for {@link QuotaRepository.listCollectionRuns}. */
export interface CollectionRunQuery {
  readonly outcome?: RunOutcome;
  /** Inclusive lower bound on `started_at`. */
  readonly from?: number;
  /** Inclusive upper bound on `started_at`. */
  readonly to?: number;
  /** Cap on returned rows, after ordering (ascending: the oldest `limit`). */
  readonly limit?: number;
}

/** Optional filters for {@link QuotaRepository.listSnapshots}. */
export interface SnapshotQuery {
  /** Inclusive lower bound on `collected_at`. */
  readonly from?: number;
  /** Inclusive upper bound on `collected_at`. */
  readonly to?: number;
  /** Cap on returned rows, after ordering (ascending: the oldest `limit`). */
  readonly limit?: number;
}

/** Optional filters for {@link QuotaRepository.getMetricSeries}. */
export interface MetricSeriesQuery {
  /** Inclusive lower bound on `collected_at`. */
  readonly from?: number;
  /** Inclusive upper bound on `collected_at`. */
  readonly to?: number;
}

/** Optional filters for {@link QuotaRepository.listQuotaEvents}. */
export interface QuotaEventQuery {
  readonly metricKey?: string;
  /** Inclusive lower bound on `event_at`. */
  readonly from?: number;
  /** Inclusive upper bound on `event_at`. */
  readonly to?: number;
}

/** Optional filters for {@link QuotaRepository.listRawResponses}. */
export interface RawResponseQuery {
  /** Cap on returned rows, after ordering (newest first). */
  readonly limit?: number;
}

/* ── The facade ────────────────────────────────────────────────────────── */

/** Options for {@link createQuotaRepository}. */
export interface QuotaRepositoryOptions {
  /**
   * An open database with the §11.1 pragmas applied — the `database` field of
   * task 079's `StorageConnection`, already migrated to the canonical schema.
   * The repository owns no connection lifecycle.
   */
  readonly database: DatabaseSync;
}

/**
 * The typed storage facade (spec §8.1, §11): every application read and write
 * of accounts, runs, snapshots, metrics, events, raw responses, sessions, and
 * meta goes through these methods — there is no other sanctioned SQL path.
 */
export interface QuotaRepository {
  /* Accounts (spec §11.2, §8.2) */

  /**
   * Inserts a new account (status `active`, no archive timestamp). Fails
   * loudly on a duplicate id or a constraint violation (D-032's named
   * CHECKs).
   */
  insertAccount(account: NewAccount): void;
  /** The account with this id, or `null`. */
  getAccount(id: string): AccountRecord | null;
  /** Every account, id-ascending (the table is small and config-synced). */
  listAccounts(): ReadonlyArray<AccountRecord>;
  /**
   * Applies label/plan changes (the configuration-sync write). At least one
   * field must be present — an empty change set is a wiring bug. Returns
   * `true` when the row exists.
   */
  updateAccountDetails(id: string, changes: AccountChanges): boolean;
  /**
   * Archives the account: sets `status = 'archived'` and the archive
   * timestamp, keeping every history row (§8.2 archive-not-delete). Only an
   * active account can be archived — re-archiving cannot rewrite the
   * original timestamp. Returns `true` when an active row was archived.
   */
  archiveAccount(id: string, archivedAt: number): boolean;
  /**
   * Deletes the account row — the §8.2 purge path ("a separate explicit
   * action with confirmation"); the schema's cascading foreign keys remove
   * its runs, snapshots, metric values, events, and raw payloads. Returns
   * `true` when a row was deleted.
   */
  deleteAccount(id: string): boolean;

  /* Collection runs (spec §11.2, §7.2) */

  /**
   * Inserts one run row per polling cycle — successful or not (§11.1) — and
   * returns the database-assigned run id (the identity snapshots, metric
   * values, and raw responses reference).
   */
  insertCollectionRun(run: NewCollectionRun): number;
  /** The run with this id, or `null`. */
  getCollectionRun(id: number): CollectionRunRecord | null;
  /**
   * Runs of one account, `started_at`-ascending — the §12.2 gap/error
   * timeline source (served by `collection_runs_account_start` /
   * `collection_runs_account_outcome_start`).
   */
  listCollectionRuns(
    accountId: string,
    query?: CollectionRunQuery,
  ): ReadonlyArray<CollectionRunRecord>;
  /**
   * The most recent run of an account, optionally restricted to an outcome —
   * the §7.3 status row (last cycle, last success, last failure).
   */
  getLatestCollectionRun(accountId: string, outcome?: RunOutcome): CollectionRunRecord | null;
  /**
   * Deletes every run that started strictly before `cutoff` and returns the
   * count — §11.3 retention. Cascades remove each deleted run's snapshot,
   * metric values, events (those referencing its snapshot), and raw payload.
   */
  deleteCollectionRunsBefore(cutoff: number): number;

  /* Snapshots (spec §11.2, §8.4) */

  /**
   * Inserts the snapshot header for a successful run — the composite foreign
   * key rejects any other run (D-036), so an error cycle cannot create a
   * false snapshot. At most one snapshot per run is structural.
   */
  insertSnapshot(snapshot: NewSnapshot): void;
  /** The snapshot of this run, or `null`. */
  getSnapshotByRun(runId: number): SnapshotRecord | null;
  /** The account's most recent snapshot — the §13 `/api/quota` source. */
  getLatestSnapshot(accountId: string): SnapshotRecord | null;
  /**
   * The account's snapshots, `collected_at`-ascending — served by
   * `snapshots_account_time` (§11.2 "snapshots by account/time").
   */
  listSnapshots(accountId: string, query?: SnapshotQuery): ReadonlyArray<SnapshotRecord>;

  /* Metric values (spec §11.2, §8.4) */

  /**
   * Inserts metric rows for one snapshot. The rows of one insert are not
   * atomic as a group — wrap the cycle's writes in
   * {@link QuotaRepository.withTransaction} (task 089). Duplicate
   * `(runId, metricKey)` pairs fail on the UNIQUE constraint.
   */
  insertMetricValues(rows: ReadonlyArray<NewMetricValue>): void;
  /** This run's metric rows, `metric_key`-ascending. */
  getMetricValuesForRun(runId: number): ReadonlyArray<MetricValueRecord>;
  /**
   * One account/metric series, `collected_at`-ascending — the §13
   * `/api/history` source, served by `metric_values_series_access`
   * (§11.2's required series index; proven used via query plan in
   * `test/integration/repository.spec.ts`).
   */
  getMetricSeries(
    accountId: string,
    metricKey: string,
    query?: MetricSeriesQuery,
  ): ReadonlyArray<MetricValueRecord>;
  /**
   * The account's most recent **valid** value per metric key — §7.2's
   * "retain and display the latest valid values and their collection time
   * after an error", generalized past the failed-run case (a failed run owns
   * no metric rows at all, D-036) to §8.4's per-metric validity: a later
   * invalid row for one metric (NULL numerics, D-010) never erases that
   * metric's last valid measurement and never surfaces as one, while the
   * valid siblings of the same snapshot still update — so the returned rows
   * may come from different snapshots, each carrying its own collection
   * time (the D-039 denormalization pins it to the snapshot structurally).
   * Equal collection stamps resolve to the later run. `metric_key`-ascending;
   * an account with no valid rows (or none at all) yields an empty array —
   * absence, never zero (§7.2). Served by `metric_values_series_access`
   * (task 122, decision D-077).
   */
  getLatestValidMetricValues(accountId: string): ReadonlyArray<MetricValueRecord>;

  /* Quota events (spec §11.2, §12.1) */

  /**
   * Inserts one event row; `details` is serialized to the JSON text the
   * D-046 CHECK contract audits. Wrap in
   * {@link QuotaRepository.withTransaction} with the snapshot it evidences
   * (§11.1 writes them together).
   */
  insertQuotaEvent(event: NewQuotaEvent): void;
  /**
   * The account's events, `event_at`-ascending (rowid tiebreak — the table
   * deliberately has no id column, D-046; the tiebreak orders same-instant
   * rows by insertion within this database's lifetime, the strongest claim
   * a rowid column supports — VACUUM may renumber rowids, so nothing may
   * persist across one) — served by `quota_events_account_metric_time`.
   */
  listQuotaEvents(accountId: string, query?: QuotaEventQuery): ReadonlyArray<QuotaEventRecord>;
  /** Deletes events recorded strictly before `cutoff`; returns the count. */
  deleteQuotaEventsBefore(cutoff: number): number;

  /* Raw responses (spec §7.4, §11.2) */

  /**
   * Inserts the sanitized parse-failure payload of one run — the composite
   * foreign key rejects any run whose outcome is not `parse_error` (D-051),
   * so a successful cycle can never carry a raw body. One per run.
   */
  insertRawResponse(response: NewRawResponse): void;
  /** The raw payload of this run, or `null` — the `doctor --raw` lookup. */
  getRawResponseByRun(runId: number): RawResponseRecord | null;
  /**
   * The account's payloads, **newest first** (`captured_at`-descending) —
   * the ordering task 103's 20-per-account cap and 30-day window consume —
   * served by `raw_responses_account_time`.
   */
  listRawResponses(accountId: string, query?: RawResponseQuery): ReadonlyArray<RawResponseRecord>;
  /**
   * Deletes the raw payloads of exactly these runs and returns the count —
   * the identity-delete primitive task 103's 20-per-account cap composes
   * with {@link listRawResponses} (keep the newest `limit`, delete the rest
   * by run id); no global cutoff can express a per-account cap.
   */
  deleteRawResponsesByRunIds(runIds: ReadonlyArray<number>): number;
  /** Deletes payloads captured strictly before `cutoff`; returns the count. */
  deleteRawResponsesBefore(cutoff: number): number;

  /* Sessions (spec §11.2, §15.2) */

  /** Inserts one session row; the digest is the identity, never the token. */
  insertSession(session: NewSession): void;
  /** The session with this token hash, or `null` — the §15.2 cookie lookup. */
  getSession(tokenHash: string): SessionRecord | null;
  /**
   * Records a sighting: refreshes `last_seen_at` and the effective
   * `expires_at` together (D-056). Returns `true` when the row exists.
   */
  touchSession(tokenHash: string, sighting: SessionSighting): boolean;
  /** Deletes one session (logout/revocation). Returns `true` when it existed. */
  deleteSession(tokenHash: string): boolean;
  /** Deletes every session (password-change revocation); returns the count. */
  deleteAllSessions(): number;
  /**
   * Deletes sessions expired strictly before `now` and returns the count —
   * §11.3's expired-session cleanup, served by `sessions_expiry`.
   */
  deleteSessionsExpiredBefore(now: number): number;

  /* Meta (spec §11.2) */

  /** The stored value of `key`, or `null`. */
  getMetaValue(key: string): string | null;
  /**
   * Upserts one key/value row — the write task 091's cleanup bookkeeping
   * (and other service state) uses. §11.2 pins no shape on `value`.
   */
  setMetaValue(key: string, value: string): void;

  /* Transactions (spec §11.1) */

  /**
   * Runs `work` inside one `BEGIN IMMEDIATE` … `COMMIT` transaction on the
   * repository's connection: every insert the callback performs commits
   * together, and any throw rolls them all back before rethrowing — the
   * seam task 089 composes into the atomic cycle write (§11.1). The callback
   * receives this same repository (one connection: its reads see the
   * callback's own writes). Nesting throws: SQLite cannot nest plain
   * transactions, and savepoints are policy this facade does not own.
   */
  withTransaction<T>(work: (repository: QuotaRepository) => T): T;
}

/* ── The derived-fields bitmask (D-039) ────────────────────────────────── */

/**
 * The bit assignment of `derived_fields` — D-010's
 * `DERIVED_METRIC_FIELDS` order (used=1, remaining=2, limit=4,
 * percentUsed=8, percentRemaining=16). On-disk contract: a successor
 * migration is required to change it.
 */
const DERIVED_BITS: ReadonlyArray<{ readonly field: DerivedMetricField; readonly bit: number }> = [
  { field: 'used', bit: 1 },
  { field: 'remaining', bit: 2 },
  { field: 'limit', bit: 4 },
  { field: 'percentUsed', bit: 8 },
  { field: 'percentRemaining', bit: 16 },
];

/** Values a prepared-statement parameter may carry (the driver's bind set). */
type SqlParameter = string | number | bigint | null | Uint8Array;

/** The stored mask for a derived-field list; `null` when the field is absent. */
function encodeDerivedFields(
  fields: ReadonlyArray<DerivedMetricField> | null | undefined,
): number | null {
  if (fields === null || fields === undefined) return null;
  let mask = 0;
  for (const { field, bit } of DERIVED_BITS) {
    // OR is idempotent, so a duplicated name collapses instead of shifting
    // the mask — the boundary's no-duplicates rule is §8.4 validation, not
    // storage policy.
    if (fields.includes(field)) mask |= bit;
  }
  return mask;
}

/** The derived-field list a stored mask decodes to; `null` when absent. */
function decodeDerivedFields(mask: number | null): ReadonlyArray<DerivedMetricField> | null {
  if (mask === null) return null;
  return DERIVED_BITS.filter(({ bit }) => (mask & bit) !== 0).map(({ field }) => field);
}

/* ── Raw row shapes (never exported) ───────────────────────────────────── */

interface AccountRow {
  readonly id: string;
  readonly provider_id: string;
  readonly label: string;
  readonly plan_name: string | null;
  readonly status: string;
  readonly created_at: number;
  readonly archived_at: number | null;
}

interface CollectionRunRow {
  readonly id: number;
  readonly account_id: string;
  readonly started_at: number;
  readonly ended_at: number;
  readonly interval_seconds: number;
  readonly outcome: string;
  readonly http_status: number | null;
  readonly error_message: string | null;
  readonly attempts: number;
  readonly retry_after_seconds: number | null;
}

interface SnapshotRow {
  readonly run_id: number;
  readonly account_id: string;
  readonly collected_at: number;
  readonly plan_name: string | null;
}

interface MetricValueRow {
  readonly run_id: number;
  readonly account_id: string;
  readonly collected_at: number;
  readonly metric_key: string;
  readonly limit_type: string;
  readonly unit: string;
  readonly window_seconds: number | null;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly limit_value: number | null;
  readonly percent_used: number | null;
  readonly percent_remaining: number | null;
  readonly resets_at: number | null;
  readonly is_valid: number;
  readonly invalid_reason: string | null;
  readonly derived_fields: number | null;
}

interface QuotaEventRow {
  readonly account_id: string;
  readonly metric_key: string;
  readonly event_type: string;
  readonly event_at: number;
  readonly run_id: number | null;
  readonly details: string;
}

interface RawResponseRow {
  readonly run_id: number;
  readonly account_id: string;
  readonly captured_at: number;
  readonly http_status: number | null;
  readonly content_type: string | null;
  readonly body: string;
}

interface SessionRow {
  readonly token_hash: string;
  readonly created_at: number;
  readonly last_seen_at: number;
  readonly expires_at: number;
}

/** Column lists shared by the SELECT and mapper of each table. */
const ACCOUNT_COLUMNS = 'id, provider_id, label, plan_name, status, created_at, archived_at';
const RUN_COLUMNS =
  'id, account_id, started_at, ended_at, interval_seconds, outcome, ' +
  'http_status, error_message, attempts, retry_after_seconds';
const SNAPSHOT_COLUMNS = 'run_id, account_id, collected_at, plan_name';
const METRIC_COLUMNS =
  'run_id, account_id, collected_at, metric_key, limit_type, unit, ' +
  'window_seconds, used, remaining, limit_value, percent_used, percent_remaining, ' +
  'resets_at, is_valid, invalid_reason, derived_fields';
const EVENT_COLUMNS = 'account_id, metric_key, event_type, event_at, run_id, details';
const RAW_RESPONSE_COLUMNS = 'run_id, account_id, captured_at, http_status, content_type, body';
const SESSION_COLUMNS = 'token_hash, created_at, last_seen_at, expires_at';

/** `x ?? null`: an optional field's absence binds as SQL NULL. */
function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

/**
 * Creates the repository over one open, migrated database. One repository
 * per connection: the `withTransaction` re-entrancy guard is per instance,
 * so two facades over one `DatabaseSync` would bypass it (SQLite still
 * refuses the nested `BEGIN`, but without this facade's actionable message).
 */
export function createQuotaRepository(options: QuotaRepositoryOptions): QuotaRepository {
  const { database } = options;

  // One prepared statement per distinct SQL text; optional filters assemble
  // SQL from constant fragments only, so the set of texts is bounded and the
  // text itself is a collision-proof cache key. Values always bind through
  // parameter markers — never interpolated.
  const statements = new Map<string, StatementSync>();
  const statement = (sql: string): StatementSync => {
    let prepared = statements.get(sql);
    if (prepared === undefined) {
      prepared = database.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  };

  // withTransaction's re-entrancy guard: a nested call would issue a second
  // BEGIN inside the open transaction and fail with SQLite's bare
  // "cannot start a transaction within a transaction" — this names the bug.
  let inTransaction = false;

  const repository: QuotaRepository = {
    /* Accounts */

    insertAccount(account) {
      statement(
        `INSERT INTO accounts (id, provider_id, label, plan_name, status, created_at, archived_at)
         VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
      ).run(
        account.id,
        account.providerId,
        account.label,
        orNull(account.planName),
        account.createdAt,
      );
    },

    getAccount(id) {
      const row = statement(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).get(id) as
        AccountRow | undefined;
      return row === undefined ? null : toAccountRecord(row);
    },

    listAccounts() {
      const rows = statement(
        `SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY id ASC`,
      ).all() as unknown as AccountRow[];
      return rows.map(toAccountRecord);
    },

    updateAccountDetails(id, changes) {
      const sets: string[] = [];
      const params: SqlParameter[] = [];
      if (changes.label !== undefined) {
        sets.push('label = ?');
        params.push(changes.label);
      }
      if (changes.planName !== undefined) {
        sets.push('plan_name = ?');
        params.push(changes.planName);
      }
      if (sets.length === 0) {
        throw new Error('updateAccountDetails: changes must set label or planName');
      }
      params.push(id);
      const result = statement(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(
        ...params,
      );
      return Number(result.changes) > 0;
    },

    archiveAccount(id, archivedAt) {
      // The status guard keeps the original archive timestamp immutable —
      // re-archiving cannot rewrite history (§8.2 archive is one lifecycle
      // event; the accounts_archive_state CHECK holds the pair consistent).
      const result = statement(
        `UPDATE accounts
         SET status = 'archived', archived_at = ?
         WHERE id = ? AND status = 'active'`,
      ).run(archivedAt, id);
      return Number(result.changes) > 0;
    },

    deleteAccount(id) {
      const result = statement('DELETE FROM accounts WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },

    /* Collection runs */

    insertCollectionRun(run) {
      const result = statement(
        `INSERT INTO collection_runs
           (account_id, started_at, ended_at, interval_seconds, outcome,
            http_status, error_message, attempts, retry_after_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.accountId,
        run.startedAt,
        run.endedAt,
        run.intervalSeconds,
        run.outcome,
        orNull(run.httpStatus),
        orNull(run.errorMessage),
        run.attempts,
        orNull(run.retryAfterSeconds),
      );
      return Number(result.lastInsertRowid);
    },

    getCollectionRun(id) {
      const row = statement(`SELECT ${RUN_COLUMNS} FROM collection_runs WHERE id = ?`).get(id) as
        CollectionRunRow | undefined;
      return row === undefined ? null : toRunRecord(row);
    },

    listCollectionRuns(accountId, query = {}) {
      const where: string[] = ['account_id = ?'];
      const params: SqlParameter[] = [accountId];
      if (query.outcome !== undefined) {
        where.push('outcome = ?');
        params.push(query.outcome);
      }
      if (query.from !== undefined) {
        where.push('started_at >= ?');
        params.push(query.from);
      }
      if (query.to !== undefined) {
        where.push('started_at <= ?');
        params.push(query.to);
      }
      let limitClause = '';
      if (query.limit !== undefined) {
        limitClause = ' LIMIT ?';
        params.push(query.limit);
      }
      const rows = statement(
        `SELECT ${RUN_COLUMNS} FROM collection_runs
         WHERE ${where.join(' AND ')}
         ORDER BY started_at ASC, id ASC${limitClause}`,
      ).all(...params) as unknown as CollectionRunRow[];
      return rows.map(toRunRecord);
    },

    getLatestCollectionRun(accountId, outcome) {
      const where = outcome === undefined ? 'account_id = ?' : 'account_id = ? AND outcome = ?';
      const params: SqlParameter[] = outcome === undefined ? [accountId] : [accountId, outcome];
      const row = statement(
        `SELECT ${RUN_COLUMNS} FROM collection_runs
         WHERE ${where}
         ORDER BY started_at DESC, id DESC
         LIMIT 1`,
      ).get(...params) as CollectionRunRow | undefined;
      return row === undefined ? null : toRunRecord(row);
    },

    deleteCollectionRunsBefore(cutoff) {
      const result = statement('DELETE FROM collection_runs WHERE started_at < ?').run(cutoff);
      return Number(result.changes);
    },

    /* Snapshots */

    insertSnapshot(snapshot) {
      statement(
        `INSERT INTO snapshots (run_id, account_id, collected_at, plan_name, run_outcome)
         VALUES (?, ?, ?, ?, 'success')`,
      ).run(snapshot.runId, snapshot.accountId, snapshot.collectedAt, orNull(snapshot.planName));
    },

    getSnapshotByRun(runId) {
      const row = statement(`SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE run_id = ?`).get(
        runId,
      ) as SnapshotRow | undefined;
      return row === undefined ? null : toSnapshotRecord(row);
    },

    getLatestSnapshot(accountId) {
      const row = statement(
        `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots
         WHERE account_id = ?
         ORDER BY collected_at DESC, run_id DESC
         LIMIT 1`,
      ).get(accountId) as SnapshotRow | undefined;
      return row === undefined ? null : toSnapshotRecord(row);
    },

    listSnapshots(accountId, query = {}) {
      const where: string[] = ['account_id = ?'];
      const params: SqlParameter[] = [accountId];
      if (query.from !== undefined) {
        where.push('collected_at >= ?');
        params.push(query.from);
      }
      if (query.to !== undefined) {
        where.push('collected_at <= ?');
        params.push(query.to);
      }
      let limitClause = '';
      if (query.limit !== undefined) {
        limitClause = ' LIMIT ?';
        params.push(query.limit);
      }
      const rows = statement(
        `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots
         WHERE ${where.join(' AND ')}
         ORDER BY collected_at ASC, run_id ASC${limitClause}`,
      ).all(...params) as unknown as SnapshotRow[];
      return rows.map(toSnapshotRecord);
    },

    /* Metric values */

    insertMetricValues(rows) {
      const insert = statement(
        `INSERT INTO metric_values
           (run_id, account_id, collected_at, metric_key, limit_type, unit,
            window_seconds, used, remaining, limit_value, percent_used,
            percent_remaining, resets_at, is_valid, invalid_reason, derived_fields)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        insert.run(
          row.runId,
          row.accountId,
          row.collectedAt,
          row.metricKey,
          row.limitType,
          row.unit,
          orNull(row.windowSeconds),
          orNull(row.used),
          orNull(row.remaining),
          orNull(row.limit),
          orNull(row.percentUsed),
          orNull(row.percentRemaining),
          orNull(row.resetsAt),
          row.isValid ? 1 : 0,
          orNull(row.invalidReason),
          encodeDerivedFields(row.derivedFields),
        );
      }
    },

    getMetricValuesForRun(runId) {
      const rows = statement(
        `SELECT ${METRIC_COLUMNS} FROM metric_values WHERE run_id = ? ORDER BY metric_key ASC`,
      ).all(runId) as unknown as MetricValueRow[];
      return rows.map(toMetricRecord);
    },

    getMetricSeries(accountId, metricKey, query = {}) {
      const where: string[] = ['account_id = ?', 'metric_key = ?'];
      const params: SqlParameter[] = [accountId, metricKey];
      if (query.from !== undefined) {
        where.push('collected_at >= ?');
        params.push(query.from);
      }
      if (query.to !== undefined) {
        where.push('collected_at <= ?');
        params.push(query.to);
      }
      const rows = statement(
        `SELECT ${METRIC_COLUMNS} FROM metric_values
         WHERE ${where.join(' AND ')}
         ORDER BY collected_at ASC, run_id ASC`,
      ).all(...params) as unknown as MetricValueRow[];
      return rows.map(toMetricRecord);
    },

    getLatestValidMetricValues(accountId) {
      // One row per metric key — that key's newest valid row. The recency
      // window orders collected_at DESC with run_id DESC as the tiebreak:
      // collected_at is not unique across snapshots, and the later-inserted
      // run (the strictly increasing rowid snapshots are keyed by, D-036) is
      // the more recent collection. The is_valid filter is §7.2's erasure
      // ban as SQL — an invalid row (NULL numerics, D-010) can neither win
      // the window nor be returned as a measurement.
      const rows = statement(
        `SELECT ${METRIC_COLUMNS} FROM (
           SELECT ${METRIC_COLUMNS}, ROW_NUMBER() OVER (
             PARTITION BY metric_key
             ORDER BY collected_at DESC, run_id DESC
           ) AS recency
           FROM metric_values
           WHERE account_id = ? AND is_valid = 1
         ) WHERE recency = 1
         ORDER BY metric_key ASC`,
      ).all(accountId) as unknown as MetricValueRow[];
      return rows.map(toMetricRecord);
    },

    /* Quota events */

    insertQuotaEvent(event) {
      statement(
        `INSERT INTO quota_events (account_id, metric_key, event_type, event_at, run_id, details)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        event.accountId,
        event.metricKey,
        event.eventType,
        event.eventAt,
        orNull(event.runId),
        JSON.stringify(event.details),
      );
    },

    listQuotaEvents(accountId, query = {}) {
      const where: string[] = ['account_id = ?'];
      const params: SqlParameter[] = [accountId];
      if (query.metricKey !== undefined) {
        where.push('metric_key = ?');
        params.push(query.metricKey);
      }
      if (query.from !== undefined) {
        where.push('event_at >= ?');
        params.push(query.from);
      }
      if (query.to !== undefined) {
        where.push('event_at <= ?');
        params.push(query.to);
      }
      const rows = statement(
        `SELECT ${EVENT_COLUMNS} FROM quota_events
         WHERE ${where.join(' AND ')}
         ORDER BY event_at ASC, rowid ASC`,
      ).all(...params) as unknown as QuotaEventRow[];
      return rows.map(toEventRecord);
    },

    deleteQuotaEventsBefore(cutoff) {
      const result = statement('DELETE FROM quota_events WHERE event_at < ?').run(cutoff);
      return Number(result.changes);
    },

    /* Raw responses */

    insertRawResponse(response) {
      statement(
        `INSERT INTO raw_responses
           (run_id, account_id, captured_at, http_status, content_type, body, run_outcome)
         VALUES (?, ?, ?, ?, ?, ?, 'parse_error')`,
      ).run(
        response.runId,
        response.accountId,
        response.capturedAt,
        orNull(response.httpStatus),
        orNull(response.contentType),
        response.body,
      );
    },

    getRawResponseByRun(runId) {
      const row = statement(
        `SELECT ${RAW_RESPONSE_COLUMNS} FROM raw_responses WHERE run_id = ?`,
      ).get(runId) as RawResponseRow | undefined;
      return row === undefined ? null : toRawResponseRecord(row);
    },

    listRawResponses(accountId, query = {}) {
      let limitClause = '';
      const params: SqlParameter[] = [accountId];
      if (query.limit !== undefined) {
        limitClause = ' LIMIT ?';
        params.push(query.limit);
      }
      const rows = statement(
        `SELECT ${RAW_RESPONSE_COLUMNS} FROM raw_responses
         WHERE account_id = ?
         ORDER BY captured_at DESC, run_id DESC${limitClause}`,
      ).all(...params) as unknown as RawResponseRow[];
      return rows.map(toRawResponseRecord);
    },

    deleteRawResponsesByRunIds(runIds) {
      if (runIds.length === 0) return 0;
      // The marker list is built from the length only; values bind. The
      // SQL text (the cache key) varies per length — a bounded set.
      const markers = runIds.map(() => '?').join(', ');
      const result = statement(`DELETE FROM raw_responses WHERE run_id IN (${markers})`).run(
        ...runIds,
      );
      return Number(result.changes);
    },

    deleteRawResponsesBefore(cutoff) {
      const result = statement('DELETE FROM raw_responses WHERE captured_at < ?').run(cutoff);
      return Number(result.changes);
    },

    /* Sessions */

    insertSession(session) {
      statement(
        `INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      ).run(session.tokenHash, session.createdAt, session.lastSeenAt, session.expiresAt);
    },

    getSession(tokenHash) {
      const row = statement(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE token_hash = ?`).get(
        tokenHash,
      ) as SessionRow | undefined;
      return row === undefined ? null : toSessionRecord(row);
    },

    touchSession(tokenHash, sighting) {
      const result = statement(
        `UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?`,
      ).run(sighting.lastSeenAt, sighting.expiresAt, tokenHash);
      return Number(result.changes) > 0;
    },

    deleteSession(tokenHash) {
      const result = statement('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return Number(result.changes) > 0;
    },

    deleteAllSessions() {
      const result = statement('DELETE FROM sessions').run();
      return Number(result.changes);
    },

    deleteSessionsExpiredBefore(now) {
      const result = statement('DELETE FROM sessions WHERE expires_at < ?').run(now);
      return Number(result.changes);
    },

    /* Meta */

    getMetaValue(key) {
      const row = statement('SELECT value FROM meta WHERE key = ?').get(key) as
        { readonly value: string } | undefined;
      return row === undefined ? null : row.value;
    },

    setMetaValue(key, value) {
      statement(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ).run(key, value);
    },

    /* Transactions */

    withTransaction<T>(work: (repository: QuotaRepository) => T): T {
      if (inTransaction) {
        throw new Error(
          'withTransaction cannot be nested: use the repository the callback receives',
        );
      }
      inTransaction = true;
      let committed = false;
      try {
        // BEGIN sits inside the try on purpose: a BEGIN that itself fails
        // (SQLITE_BUSY past the §11.1 busy_timeout budget, or residue of a
        // previously swallowed failure) must reset the guard in the finally
        // — a latched flag would refuse every later transaction on a
        // healthy connection (review finding, task 088).
        database.exec('BEGIN IMMEDIATE');
        const result = work(repository);
        database.exec('COMMIT');
        committed = true;
        return result;
      } finally {
        if (!committed) {
          // Best-effort rollback that must not mask the work failure (the
          // D-016/D-030 cleanup precedent): a ROLLBACK that itself throws
          // means the connection is broken beyond ordering concerns —
          // including the "no transaction is active" of a failed BEGIN,
          // which is exactly the nothing-to-clean case.
          try {
            database.exec('ROLLBACK');
          } catch {
            // The original error is the actionable report.
          }
        }
        inTransaction = false;
      }
    },
  };

  return repository;
}

/* ── Row → record mappers (the schema's vocabulary, camelCased) ────────── */

function toAccountRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label,
    planName: row.plan_name,
    status: row.status as AccountStatus,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

function toRunRecord(row: CollectionRunRow): CollectionRunRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    intervalSeconds: row.interval_seconds,
    outcome: row.outcome as RunOutcome,
    httpStatus: row.http_status,
    errorMessage: row.error_message,
    attempts: row.attempts,
    retryAfterSeconds: row.retry_after_seconds,
  };
}

function toSnapshotRecord(row: SnapshotRow): SnapshotRecord {
  return {
    runId: row.run_id,
    accountId: row.account_id,
    collectedAt: row.collected_at,
    planName: row.plan_name,
  };
}

function toMetricRecord(row: MetricValueRow): MetricValueRecord {
  return {
    accountId: row.account_id,
    runId: row.run_id,
    collectedAt: row.collected_at,
    metricKey: row.metric_key,
    limitType: row.limit_type as LimitType,
    unit: row.unit as MetricUnit,
    windowSeconds: row.window_seconds,
    used: row.used,
    remaining: row.remaining,
    limit: row.limit_value,
    percentUsed: row.percent_used,
    percentRemaining: row.percent_remaining,
    resetsAt: row.resets_at,
    isValid: row.is_valid === 1,
    invalidReason: row.invalid_reason,
    derivedFields: decodeDerivedFields(row.derived_fields),
  };
}

function toEventRecord(row: QuotaEventRow): QuotaEventRecord {
  return {
    accountId: row.account_id,
    metricKey: row.metric_key,
    eventType: row.event_type as QuotaEventType,
    eventAt: row.event_at,
    runId: row.run_id,
    // The D-046 CHECK contract guarantees parseable JSON with the audit
    // minimum on every stored row; values written by this facade round-trip.
    details: JSON.parse(row.details) as QuotaEventDetails,
  };
}

function toRawResponseRecord(row: RawResponseRow): RawResponseRecord {
  return {
    runId: row.run_id,
    accountId: row.account_id,
    capturedAt: row.captured_at,
    httpStatus: row.http_status,
    contentType: row.content_type,
    body: row.body,
  };
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}
