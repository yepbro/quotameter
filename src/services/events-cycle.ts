/**
 * Cycle reset-event detection — the §12.1 storage seam behind the cycle
 * write (spec §12.1, §11.1; task 118, decision D-078).
 *
 * Task 117 (D-074) built the pure rule: consecutive valid points in,
 * `RESET` events out. This module is the half that knows where the previous
 * points live — {@link detectCycleResetEvents} reads the account's latest
 * valid points through the repository facade (D-058) and hands task 110's
 * success write (D-069) exactly the events the pure detector produces for
 * the new snapshot, so the cycle's `events` ride D-060's §11.1 transaction
 * with the snapshot they evidence. Nothing here writes, and no clock is
 * read (D-021): every timestamp is data on the points.
 *
 * Pinned interpretations (D-078, read swap D-083):
 *
 * - **The previous valid point is each metric's newest valid stored row**
 *   (`getLatestValidMetricValues`, D-077 — one account-level read per
 *   cycle, skipping invalid rows in SQL: §12.1 "invalid points do not
 *   participate" applies to the comparison base as much as to the new
 *   point). The read resolves to exactly the row D-078's original
 *   full-series walk-back selected — the valid row maximizing
 *   `(collected_at, run_id)`, which is the facade's own series ordering —
 *   so out-of-order arrivals resolve identically and an out-of-order new
 *   snapshot (collected before the stored tail) stays suppressed by the
 *   detector's chronology guard — a missed event, never a false one.
 * - **Detection is pairwise and per-cycle, never a re-fold over history.**
 *   Each valid metric of the new snapshot is compared once, against the
 *   last valid stored point only: a reset a previous cycle already recorded
 *   cannot be detected again (the events of one cycle are a function of
 *   that cycle's snapshot and the stored tail alone), and no backfill over
 *   already-persisted history ever runs.
 * - **Reads happen before the write.** The latest-valid points are read
 *   outside (and before) D-060's transaction, so the new snapshot's own
 *   rows cannot become their own comparison base; the write then carries
 *   the events into the same transaction as the snapshot, which the D-046
 *   composite foreign key makes the only structurally possible home for
 *   them.
 * - **Evidence runIds are truthful, not symmetric.** The previous point's
 *   `runId` is passed through from the stored row (which run produced the
 *   comparison base); the current point carries none — the cycle's run id
 *   does not exist until the write assigns it, and the event ROW's `run_id`
 *   is D-060's injection, which points at the snapshot the event came from.
 * - **Duplicate metric keys cannot occur**: the §8.4 boundary
 *   (`findProviderSnapshotProblems`) rejects them, so the snapshot a
 *   success write carries has unique keys by the time detection runs.
 */

import type { NormalizedMetric, ProviderSnapshot } from '../schemas/metrics';
import type { MetricValueRecord, QuotaRepository } from '../storage/repository';
import { detectResetEvent, type ResetEvent, type ResetPointInput } from './events-detection';

/* ── Point mapping ─────────────────────────────────────────────────────── */

/**
 * One stored metric row as the detector's point input: SQL `NULL`s become
 * absent optional fields; `runId` rides along as comparison evidence.
 */
function storedPoint(row: MetricValueRecord): ResetPointInput {
  return {
    accountId: row.accountId,
    metricKey: row.metricKey,
    collectedAt: row.collectedAt,
    limitType: row.limitType,
    unit: row.unit,
    isValid: row.isValid,
    runId: row.runId,
    used: row.used ?? undefined,
    remaining: row.remaining ?? undefined,
    percentUsed: row.percentUsed ?? undefined,
    percentRemaining: row.percentRemaining ?? undefined,
    resetsAt: row.resetsAt ?? undefined,
  };
}

/** One metric of the new snapshot as the detector's point input. */
function snapshotPoint(
  accountId: string,
  collectedAt: number,
  metric: NormalizedMetric,
): ResetPointInput {
  return {
    accountId,
    metricKey: metric.key,
    collectedAt,
    limitType: metric.limitType,
    unit: metric.unit,
    isValid: metric.isValid,
    used: metric.used,
    remaining: metric.remaining,
    percentUsed: metric.percentUsed,
    percentRemaining: metric.percentRemaining,
    resetsAt: metric.resetsAt,
  };
}

/**
 * The account's latest valid points as a by-key lookup — one
 * {@link QuotaRepository.getLatestValidMetricValues} read (D-077) serves
 * every metric of the cycle, each key mapping to its newest valid row or
 * nothing (a new metric, or a new account's first cycle): skipping
 * invalid rows in SQL is §12.1's "invalid points do not participate"
 * applied to the base.
 */
function latestValidPointsByKey(
  repository: QuotaRepository,
  accountId: string,
): ReadonlyMap<string, MetricValueRecord> {
  const byKey = new Map<string, MetricValueRecord>();
  for (const row of repository.getLatestValidMetricValues(accountId)) {
    byKey.set(row.metricKey, row);
  }
  return byKey;
}

/* ── Detection ─────────────────────────────────────────────────────────── */

/**
 * Detects the §12.1 `RESET` events a successful collection cycle must
 * persist alongside its snapshot: every **valid** metric of `snapshot` is
 * compared once against the previous valid point of its stored (account,
 * metric) series — read before the cycle's write, so only prior cycles can
 * form the base — and the returned events (D-074's evidence vocabulary,
 * structurally `CycleEventInput`) are exactly what the cycle write stores,
 * in snapshot order. One account-level latest-valid read (performed only
 * once the snapshot's first valid metric needs a base — a zero-metric or
 * all-invalid snapshot reads nothing) serves every comparison. Invalid
 * metrics of the new snapshot are skipped entirely; a metric with no
 * stored valid point is its series' first point and yields nothing. A
 * storage read failure propagates unchanged and is contained by the
 * engine's §7.2 isolation, like a failing write.
 */
export function detectCycleResetEvents(
  repository: QuotaRepository,
  accountId: string,
  snapshot: ProviderSnapshot,
): ResetEvent[] {
  const events: ResetEvent[] = [];
  let latestValid: ReadonlyMap<string, MetricValueRecord> | undefined;
  for (const metric of snapshot.metrics) {
    // §12.1: invalid points do not participate — neither as the new point
    // (skipped here; the pair API treats one as a wiring bug) nor as the
    // base (skipped by the latest-valid read's `is_valid = 1` filter).
    if (!metric.isValid) continue;
    const current = snapshotPoint(accountId, snapshot.collectedAt, metric);
    latestValid ??= latestValidPointsByKey(repository, accountId);
    const previousRow = latestValid.get(metric.key);
    const previous = previousRow === undefined ? undefined : storedPoint(previousRow);
    const event = detectResetEvent(previous, current);
    if (event !== undefined) events.push(event);
  }
  return events;
}
