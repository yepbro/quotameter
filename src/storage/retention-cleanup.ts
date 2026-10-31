/**
 * Retention cleanup — §11.3's delete-and-maintain operation (task 091,
 * decision D-063).
 *
 * Spec §11.3: "Cleanup runs at startup and daily: delete expired runs,
 * snapshots, metric values, events, expired sessions, and out-of-policy raw
 * responses. Then checkpoint WAL and run `incremental_vacuum` where
 * supported/configured. Do not delete configuration, account metadata
 * needed for current state, or connection settings." {@link
 * runRetentionCleanup} is that operation as one repeat-safe call: given an
 * explicit `now` and a §11.3 retention window, it deletes every row the
 * window expired — through the repository facade's count-returning deletes
 * (D-058), in one transaction that also writes the §11.2 cleanup metadata —
 * and then runs the maintenance primitive. Scheduling (when this runs) is
 * the server lifecycle's concern; this module is the operation itself,
 * safe to call back-to-back with the same or any later input.
 *
 * Pinned interpretations (D-063):
 *
 * - **A sibling storage module, not facade methods** — D-058's growth rule;
 *   its reasons section listed "091's retention + meta bookkeeping" among
 *   the consumers that compose the surface without extending it. The
 *   cleanup-report vocabulary and the §11.3 policy constants stay out of
 *   the per-table facade contract, exactly as D-060/D-061 kept theirs out.
 * - **Timestamps and the window are writer-supplied** (D-021/D-058). The
 *   caller owns `now` — the future scheduler computes it from the
 *   injectable clock at startup and once a day — and `retentionDays`
 *   arrives as the loaded configuration's `app.historyRetentionDays`.
 *   Nothing here reads a clock, so a repeated call with identical input is
 *   the same cleanup twice over the same rows.
 * - **The bounds are validated here, before any delete runs.** §11.3's
 *   7–3650 range is policy this module owns at the storage boundary (the
 *   config layer validates its own copy; a direct caller — a CLI, a test,
 *   a future wiring bug — must not reach the deletes with a window the
 *   spec rejects). This is not D-058's no-pre-validation rule replayed in
 *   reverse: that rule concerns row data the schema's named CHECKs already
 *   gate, and no schema constraint can express a range about a query
 *   parameter. A rejected input deletes nothing.
 * - **The run is the retention unit.** `deleteCollectionRunsBefore` is the
 *   history delete; the schema's cascading foreign keys take each expired
 *   run's snapshot, metric values, snapshot-linked events, and raw payload
 *   with it (D-036/D-046/D-051). Snapshots and metric rows therefore have
 *   no separate cutoff calls — a snapshot cannot outlive its run — and the
 *   report's run count covers the cascade. Events and raw payloads do have
 *   their own time columns and their own deletes: an event's §12.1
 *   `event_at` can predate its run, and run-free events (§11.2) have no
 *   run to cascade from; a raw payload's §7.4 window (30 days) is not the
 *   history window at all.
 * - **Raw payloads follow §7.4's own 30-day window** — the time-based half
 *   of that section's "no more than 20 responses per account and no more
 *   than 30 days". The per-account 20-record cap is task 103's (it
 *   composes `listRawResponses` with `deleteRawResponsesByRunIds`); this
 *   module never counts records, it only expires age.
 * - **Sessions follow §15.2, not the history window.** A session dies when
 *   its own `expires_at` passes — the D-056 CHECK bounds already cap that
 *   at 7 days of inactivity and 30 days of life — so cleanup deletes
 *   strictly-expired rows at `now` regardless of `retentionDays`.
 * - **Deletes and metadata commit as one transaction.** The last-run
 *   markers must never claim a cleanup that half-happened: if any delete
 *   or marker write throws, everything rolls back and the next run —
 *   startup or daily — is the same cleanup over the same rows (the
 *   done-condition's repeat-safety, by construction).
 * - **Maintenance runs after the commit, unconditionally** — §11.3's own
 *   order ("Then checkpoint WAL…"), also when the deletes removed nothing;
 *   a checkpoint of an empty WAL is what keeps the file small between
 *   cleanups. See `maintenance.ts` for the TRUNCATE/no-op interpretations.
 * - **The reduce-retention warning is a recorded hook, not built here.**
 *   §11.3's "warn that older records will be removed at the next cleanup"
 *   is the config/UI layer's surface: it reads this module's
 *   `retention:applied-days` marker (the window the last cleanup actually
 *   applied) and warns when a newly configured window is smaller — the
 *   records between the two windows are exactly what the next cleanup
 *   deletes. The markers this cleanup writes are that hook's data.
 *
 * Protected by construction (§11.3's "do not delete" sentence): the
 * operation touches no `accounts` row (active or archived — the §7.3
 * current-state reads keep their sources), no configuration (files, not
 * database rows), no connection setting (task 079's pragmas), and no
 * `meta` key except its own two markers.
 *
 * Since U-014 (decision D-091) the horizon arithmetic this module's cutoff
 * and D-082's `boundHistoryRange` share is single-sited here as the
 * exported `historyCutoff` — the query-side twin consumes the definition
 * instead of re-deriving the day arithmetic, so the two-sided alignment is
 * by construction.
 */

import type { DatabaseSync } from 'node:sqlite';
import { DAY_MS } from '../util/rolling-ranges';
import { runStorageMaintenance, type StorageMaintenanceResult } from './maintenance';
import type { QuotaRepository } from './repository';

/** §11.3's accepted retention window, in days (7–3650; the 180-day default is the config schema's). */
export const MIN_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 3650;

/** §7.4's raw-payload age window in days — fixed policy, not configuration. */
export const RAW_RESPONSE_MAX_AGE_DAYS = 30;

/**
 * The §11.3 history horizon: the epoch-ms cutoff before which a retention
 * window has expired history — `now − retentionDays` days (decision D-091:
 * the single definition site of that arithmetic). This cleanup's
 * strict-before deletes and D-082's query-side clamp both consume this one
 * value, so their documented two-sided alignment — deletes take strictly
 * earlier, reads serve at-or-after on the closed interval — holds by
 * construction instead of by twin literals agreeing. Pure arithmetic on
 * caller-supplied time (D-021): both consuming seams validate `now` and
 * §11.3's 7–3650 window before calling, each with its own context-named
 * error, so the helper adds no second error vocabulary.
 */
export function historyCutoff(now: number, retentionDays: number): number {
  return now - retentionDays * DAY_MS;
}

/** Meta key holding the epoch-ms `now` of the last completed cleanup (§11.2 cleanup metadata). */
export const RETENTION_LAST_RUN_KEY = 'retention:last-run';

/** Meta key holding the retention window the last completed cleanup applied. */
export const RETENTION_APPLIED_DAYS_KEY = 'retention:applied-days';

/** The collaborators the cleanup composes: the facade and the connection it runs on. */
export interface RetentionCleanupOptions {
  readonly repository: QuotaRepository;
  /**
   * The same `DatabaseSync` the repository was created over — the
   * post-commit maintenance step needs it, and the facade (rightly) never
   * hands a connection back (D-058).
   */
  readonly database: DatabaseSync;
}

/** What one cleanup is: an explicit time and an explicit window (D-021). */
export interface RetentionCleanupInput {
  /** §11.1 epoch milliseconds the cutoffs are computed from. */
  readonly now: number;
  /** The history retention window in days, 7–3650 (spec §11.3). */
  readonly retentionDays: number;
}

/** What one cleanup removed — the facade's per-statement counts. */
export interface RetentionRemovedCounts {
  /** Expired runs; their snapshots, metric values, and linked rows cascaded with them. */
  readonly collectionRuns: number;
  /** Events with `event_at` before the history cutoff (of those still present — the count excludes events a run cascade already took). */
  readonly quotaEvents: number;
  /** Raw payloads older than §7.4's 30-day window (count excludes those a run cascade already took). */
  readonly rawResponses: number;
  /** Sessions expired before `now` (§15.2's own bounds). */
  readonly sessions: number;
}

/** What one cleanup did — the cutoffs used, the removals, the maintenance outcome. */
export interface RetentionCleanupReport {
  readonly historyCutoff: number;
  readonly rawResponseCutoff: number;
  readonly removed: RetentionRemovedCounts;
  readonly maintenance: StorageMaintenanceResult;
}

/**
 * Runs one §11.3 cleanup and returns what it did. Deletes every run that
 * started before `now − retentionDays` (the cascade removes its snapshot,
 * metric values, and linked events/raw payload), every event older than
 * that cutoff, every raw payload older than §7.4's 30 days, and every
 * session expired before `now` — all in one transaction that also writes
 * the cleanup metadata — then checkpoints the WAL and runs
 * `incremental_vacuum`. Safe to repeat: an identical second call removes
 * nothing, and any later call removes only what newly expired. Throws
 * before deleting anything when `retentionDays` is outside §11.3's 7–3650
 * range or `now` is not finite.
 */
export function runRetentionCleanup(
  options: RetentionCleanupOptions,
  input: RetentionCleanupInput,
): RetentionCleanupReport {
  const { retentionDays, now } = input;
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < MIN_RETENTION_DAYS ||
    retentionDays > MAX_RETENTION_DAYS
  ) {
    throw new Error(
      `runRetentionCleanup: retentionDays must be an integer between ` +
        `${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days (spec §11.3), got '${retentionDays}'`,
    );
  }
  if (!Number.isFinite(now)) {
    throw new Error(
      `runRetentionCleanup: now must be a finite epoch-milliseconds value, got '${now}'`,
    );
  }

  const cutoff = historyCutoff(now, retentionDays);
  const rawResponseCutoff = now - RAW_RESPONSE_MAX_AGE_DAYS * DAY_MS;

  // Deletes and markers are one transaction: a mid-cleanup failure rolls
  // everything back, so the last-run markers only ever describe a cleanup
  // that fully happened, and the next (startup/daily) run redoes it whole.
  const removed = options.repository.withTransaction((tx) => {
    // Runs first: their cascades remove the snapshot-linked events and
    // run-linked payloads of expired runs, so the event and raw counts
    // below describe only the rows the cutoffs expired on their own.
    const collectionRuns = tx.deleteCollectionRunsBefore(cutoff);
    const quotaEvents = tx.deleteQuotaEventsBefore(cutoff);
    const rawResponses = tx.deleteRawResponsesBefore(rawResponseCutoff);
    const sessions = tx.deleteSessionsExpiredBefore(now);
    tx.setMetaValue(RETENTION_LAST_RUN_KEY, String(now));
    tx.setMetaValue(RETENTION_APPLIED_DAYS_KEY, String(retentionDays));
    return { collectionRuns, quotaEvents, rawResponses, sessions };
  });

  // §11.3's order: maintenance only after the cleanup commits. A failure
  // here propagates with the deletes already durable — correct, since the
  // next run's deletes are idempotent and the checkpoint retries then.
  const maintenance = runStorageMaintenance(options.database);

  return { historyCutoff: cutoff, rawResponseCutoff, removed, maintenance };
}
