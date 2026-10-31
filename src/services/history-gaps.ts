/**
 * Collection-gap detection (spec §12.2; task 119, decision D-075).
 *
 * The §12.2 gap rule as one pure function: a gap is the interval between two
 * adjacent **successful** metric points of the same account and metric whose
 * elapsed time exceeds three polling intervals, "using the `interval_s` in
 * effect at the relevant collection time". Points go in, gap intervals come
 * out — nothing here reads storage, knows the clock (D-021: timestamps are
 * data), or decides what a chart does with a gap (the §13 `/api/events`
 * consumer and the history/downsampling services turn gaps into broken
 * lines and empty points; task 120's error indicators are a separate input).
 *
 * Two interpretations are pinned in D-075:
 *
 * - **The threshold is jitter-expanded.** §7.1 schedules each poll at the
 *   configured interval *plus* a jitter of up to 10% of it (the additive
 *   shape of `pollingDelayMs`, D-066), so three maximally-stretched polls
 *   legitimately span 3 × 1.1 intervals. The effective interval is therefore
 *   the configured seconds plus the §7.1 allowance, and a gap requires
 *   elapsed **strictly greater** than three of those ("exceeds" — three
 *   fully-jittered polls in a row are late, not missing). §7.3's sibling
 *   `Stale` rule counts the same three intervals, but in its own
 *   "configured" wording and without the jitter expansion — the two
 *   thresholds intentionally differ by the allowance.
 * - **"The relevant collection time" is the earlier point of the pair.**
 *   Elapsed is measured from it, and the polls that should have followed it
 *   were scheduled under the interval then in effect. Interval *changes*
 *   are supplied as a timeline and resolved per pair: a pair whose span
 *   contains no change is judged by its starting cadence; a pair whose span
 *   *does* contain a change is judged by the most permissive cadence
 *   anywhere in the span — a mid-span change re-anchors the schedule
 *   (`setIntervalMs`, D-066), so how many polls should have arrived is
 *   ambiguous evidence, and the fail-safe direction is no gap. Without
 *   this, every runtime grow beyond 2× (60→300 s is one §6.4 edit away)
 *   would deterministically mint a false gap on a perfectly healthy series.
 *
 * Scope guard: the caller supplies successful points only (§12.2 says
 * "adjacent successful snapshots"; invalid metrics and failed cycles are
 * excluded before this function — task 120 derives the separate error
 * indicators), and the function emits nothing for the series edges: a gap
 * exists only *between* two observed points, never before the first or after
 * the last (silence with no records is §12.2's stopped-service class).
 */

import { compareEpochMs } from '../util/compare-epoch-ms';
import {
  MAX_POLLING_INTERVAL_MS,
  MIN_POLLING_INTERVAL_MS,
  POLLING_JITTER_FRACTION,
} from './polling-scheduler';

/* ── The §12.2 threshold ───────────────────────────────────────────────── */

/**
 * §12.2: a gap is an elapsed time exceeding **three** polling intervals (the
 * same count as §7.3's `Stale` window — "no successful collection for more
 * than three configured collection intervals" — though §7.3 speaks of
 * *configured* intervals and grants no jitter tolerance, so the two
 * thresholds deliberately differ).
 */
export const GAP_THRESHOLD_INTERVALS = 3;

/**
 * The §7.1 jitter allowance per configured second of interval, in whole
 * milliseconds: `1000 ms × POLLING_JITTER_FRACTION` — the scheduler's own
 * fraction, so the allowance cannot drift from the delays it actually
 * produces. Whole-millisecond integer arithmetic keeps the threshold exact
 * (no float error at the boundary); a unit test pins the value at 100 and
 * the integrality of the effective interval across §7.1's whole range, so a
 * future non-integral fraction forces this arithmetic to be revisited.
 */
const JITTER_MS_PER_INTERVAL_SECOND = 1000 * POLLING_JITTER_FRACTION; // 100

/**
 * §7.1's configured-interval bounds in seconds — the scheduler's millisecond
 * constants are the one source of truth (D-070's precedent); this module
 * speaks seconds because §12.2 names `interval_s`, the unit the collection
 * run rows carry (D-069).
 */
const MIN_INTERVAL_SECONDS = MIN_POLLING_INTERVAL_MS / 1000;

/** {@link MIN_INTERVAL_SECONDS}'s ceiling twin: 3600 s. */
const MAX_INTERVAL_SECONDS = MAX_POLLING_INTERVAL_MS / 1000;

/**
 * The effective polling interval in milliseconds: the configured seconds
 * expanded by §7.1's up-to-10% jitter allowance. This is the largest
 * legitimate realized spacing between two adjacent polls, so three of them
 * bound the largest legitimate silence that is *not* a gap.
 */
export function effectivePollingIntervalMs(intervalSeconds: number): number {
  requireIntervalSeconds(intervalSeconds, 'effectivePollingIntervalMs');
  // Integer × integer: 1000 ms plus 100 ms of allowance per configured
  // second — exact, unlike intervalMs × 1.1 (0.1 is not representable).
  return intervalSeconds * 1000 + intervalSeconds * JITTER_MS_PER_INTERVAL_SECOND;
}

/**
 * The gap threshold in milliseconds: {@link GAP_THRESHOLD_INTERVALS} effective
 * intervals. An elapsed time **strictly greater** than this is a gap
 * (§12.2 "exceeds"); equal is not.
 */
export function gapThresholdMs(intervalSeconds: number): number {
  // Validated under this function's own name (the delegation below would
  // otherwise surface the helper's prefix) — the house convention of
  // caller-addressed fail-fast messages.
  requireIntervalSeconds(intervalSeconds, 'gapThresholdMs');
  return GAP_THRESHOLD_INTERVALS * effectivePollingIntervalMs(intervalSeconds);
}

/* ── The input model ───────────────────────────────────────────────────── */

/**
 * One successful metric point — the §8.4 identity of a stored reading: the
 * account it belongs to, the metric's stable `key`, and the snapshot's
 * `collectedAt` epoch milliseconds. Successful points only: the caller
 * excludes invalid metrics and the points failed cycles never produced.
 */
export interface SuccessfulMetricPoint {
  /** The account the snapshot was collected for. */
  readonly accountId: string;
  /** §8.4 `NormalizedMetric.key` — the series identity within the account. */
  readonly metricKey: string;
  /** §8.4 `collectedAt`, UTC epoch milliseconds. */
  readonly collectedAt: number;
}

/**
 * One point in the interval history: the configured §7.1 interval from
 * `effectiveFromEpochMs` (inclusive) until the next change. §6.4 runtime
 * changes and D-069's per-run `interval_seconds` give the caller exact
 * change times; the timeline may arrive unsorted.
 */
export interface IntervalChange {
  /** UTC epoch milliseconds from which `intervalSeconds` applies. */
  readonly effectiveFromEpochMs: number;
  /** The configured interval in seconds (§7.1 range). */
  readonly intervalSeconds: number;
}

/**
 * How the effective interval is supplied: a constant (the interval never
 * changed over the series) or the full timeline of changes (the interval in
 * effect before the earliest change is the timeline's first entry — a
 * constant `c` is exactly `[{ effectiveFromEpochMs: -Infinity, c }]`).
 */
export type PollingIntervalSource = number | readonly IntervalChange[];

/** A detected §12.2 collection gap between two adjacent successful points. */
export interface CollectionGap {
  /** The account whose series contains the gap. */
  readonly accountId: string;
  /** The metric key of the gapped series. */
  readonly metricKey: string;
  /** The earlier point's `collectedAt` — the gap's start edge. */
  readonly fromEpochMs: number;
  /** The later point's `collectedAt` — the gap's end edge. */
  readonly toEpochMs: number;
  /** `toEpochMs − fromEpochMs`. */
  readonly elapsedMs: number;
  /**
   * The interval the gap was judged by: the start edge's cadence, widened to
   * the span's most permissive interval when a change landed between the
   * edges (D-075).
   */
  readonly intervalSeconds: number;
  /** The threshold the elapsed time exceeded: {@link gapThresholdMs}. */
  readonly thresholdMs: number;
}

/* ── Validation (fail-fast, the D-059/D-064 convention) ────────────────── */

/**
 * Validates a configured interval in seconds against §7.1's 60–3600 range —
 * the scheduler's own bounds (one source of truth), so a seconds/milliseconds
 * confusion in the wiring fails here instead of producing a nine-fold-off
 * threshold.
 */
function requireIntervalSeconds(intervalSeconds: number, caller: string): void {
  if (
    typeof intervalSeconds !== 'number' ||
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < MIN_INTERVAL_SECONDS ||
    intervalSeconds > MAX_INTERVAL_SECONDS
  ) {
    throw new RangeError(
      `${caller}: intervalSeconds must be an integer in [${MIN_INTERVAL_SECONDS}, ${MAX_INTERVAL_SECONDS}] (spec §7.1)`,
    );
  }
}

/**
 * Validates the points. Blank ids, non-finite timestamps, and non-objects
 * are caller wiring mistakes and fail loudly with the offending index.
 */
function requirePoints(points: readonly SuccessfulMetricPoint[], caller: string): void {
  if (!Array.isArray(points)) {
    throw new TypeError(`${caller}: points must be an array of SuccessfulMetricPoint`);
  }
  for (const [index, point] of points.entries()) {
    if (typeof point !== 'object' || point === null) {
      throw new TypeError(`${caller}: points[${index}] must be a SuccessfulMetricPoint`);
    }
    if (typeof point.accountId !== 'string' || point.accountId.trim() === '') {
      throw new TypeError(`${caller}: points[${index}].accountId must be a non-blank string`);
    }
    if (typeof point.metricKey !== 'string' || point.metricKey.trim() === '') {
      throw new TypeError(`${caller}: points[${index}].metricKey must be a non-blank string`);
    }
    if (typeof point.collectedAt !== 'number' || !Number.isFinite(point.collectedAt)) {
      throw new TypeError(
        `${caller}: points[${index}].collectedAt must be a finite UTC epoch-milliseconds timestamp`,
      );
    }
  }
}

/** The internal timeline: `changes` ascending by `effectiveFromEpochMs`. */
interface NormalizedTimeline {
  readonly changes: readonly IntervalChange[];
}

/**
 * Normalizes the interval source into an ascending timeline. A constant
 * becomes a synthetic `−Infinity` entry (it is in effect for every finite
 * timestamp); a caller timeline must be non-empty with finite, unique change
 * times and §7.1-valid intervals — duplicates are ambiguous history and
 * fail fast rather than resolving to whichever entry sorted last.
 */
function normalizeTimeline(
  intervalSource: PollingIntervalSource,
  caller: string,
): NormalizedTimeline {
  if (typeof intervalSource === 'number') {
    requireIntervalSeconds(intervalSource, caller);
    return {
      changes: [
        { effectiveFromEpochMs: Number.NEGATIVE_INFINITY, intervalSeconds: intervalSource },
      ],
    };
  }
  if (!Array.isArray(intervalSource)) {
    throw new TypeError(`${caller}: intervalSource must be a number or an array of IntervalChange`);
  }
  if (intervalSource.length === 0) {
    throw new RangeError(`${caller}: the interval timeline must not be empty`);
  }
  for (const [index, change] of intervalSource.entries()) {
    if (typeof change !== 'object' || change === null) {
      throw new TypeError(`${caller}: intervals[${index}] must be an IntervalChange`);
    }
    if (
      typeof change.effectiveFromEpochMs !== 'number' ||
      !Number.isFinite(change.effectiveFromEpochMs)
    ) {
      throw new TypeError(
        `${caller}: intervals[${index}].effectiveFromEpochMs must be a finite UTC epoch-milliseconds timestamp`,
      );
    }
    requireIntervalSeconds(change.intervalSeconds, `${caller} intervals[${index}]`);
  }
  const changes = [...intervalSource].sort((a, b) =>
    compareEpochMs(a.effectiveFromEpochMs, b.effectiveFromEpochMs),
  );
  let previous: IntervalChange | undefined;
  for (const change of changes) {
    if (previous !== undefined && change.effectiveFromEpochMs === previous.effectiveFromEpochMs) {
      throw new TypeError(
        `${caller}: intervals must have unique effectiveFromEpochMs (spec §7.1 interval changes)`,
      );
    }
    previous = change;
  }
  return { changes };
}

/**
 * The interval in effect at `collectedAt`: the last change at or before it
 * (a change exactly at a point's timestamp applies to that point). Every
 * point is resolved once, up front — a point older than the timeline's
 * first change has no interval in effect, which is a caller wiring mistake
 * (the history and the interval timeline must cover the same span) and
 * fails loudly instead of silently skipping pairs.
 */
function intervalSecondsAt(timeline: NormalizedTimeline, collectedAt: number): number {
  let resolved: IntervalChange | undefined;
  for (const change of timeline.changes) {
    if (change.effectiveFromEpochMs > collectedAt) break;
    resolved = change;
  }
  if (resolved === undefined) {
    throw new RangeError(
      `detectCollectionGaps: no interval in effect at ${collectedAt} (the timeline starts at ${timeline.changes[0]?.effectiveFromEpochMs}); supply interval changes covering every point`,
    );
  }
  return resolved.intervalSeconds;
}

/**
 * The interval a pair of adjacent points is judged by (D-075): the interval
 * in effect at the pair's earlier point, **widened to the most permissive
 * cadence in the span when an interval change lands between the two
 * points**. A mid-span change re-anchors the whole schedule — D-066's
 * `setIntervalMs` moves a pending poll to `now + newInterval + jitter`, so
 * the first post-change point legitimately arrives up to 1.1 × (old + new)
 * after the earlier one — and how many polls should have arrived during the
 * span is then ambiguous evidence; the fail-safe resolution (§12.1's spirit:
 * no event on ambiguity) is the largest interval the span was ever run
 * under. `fromSeconds` is the already-validated earlier-point resolution, so
 * this never throws.
 */
function pairIntervalSeconds(
  timeline: NormalizedTimeline,
  fromAt: number,
  toAt: number,
  fromSeconds: number,
): number {
  let widestSeconds = fromSeconds;
  for (const change of timeline.changes) {
    if (change.effectiveFromEpochMs <= fromAt) continue; // not inside the span
    if (change.effectiveFromEpochMs > toAt) break; // past it; sorted ascending
    widestSeconds = Math.max(widestSeconds, change.intervalSeconds);
  }
  return widestSeconds;
}

/* ── Detection ─────────────────────────────────────────────────────────── */

/**
 * Detects the §12.2 collection gaps in a set of successful metric points.
 *
 * The points are partitioned by `(accountId, metricKey)` — accounts and
 * metrics never share a gap — and each series is inspected chronologically
 * (input order is irrelevant; equal timestamps keep input order and yield a
 * zero elapsed time, never a gap). A pair of adjacent points is a gap when
 * its elapsed time strictly exceeds three effective intervals
 * ({@link gapThresholdMs}) of the interval the pair is judged by: its
 * earlier point's cadence, widened to the span's most permissive interval
 * when a change lands between the two points (D-075).
 *
 * The result order is deterministic: accounts in the order their first point
 * appears in the input, metrics within an account likewise, and gaps within
 * a series chronologically. Empty and single-point inputs return `[]`.
 */
export function detectCollectionGaps(
  points: readonly SuccessfulMetricPoint[],
  intervalSource: PollingIntervalSource,
): CollectionGap[] {
  const caller = 'detectCollectionGaps';
  requirePoints(points, caller);
  const timeline = normalizeTimeline(intervalSource, caller);

  // Coverage validation first, uniformly: every point — not only the ones
  // that happen to start a candidate pair — must fall inside the interval
  // timeline. After this pass the per-pair lookups below cannot throw.
  for (const point of points) {
    intervalSecondsAt(timeline, point.collectedAt);
  }

  // Nested maps partition without composite-string keys (an id containing a
  // joiner character must never alias two series); both levels preserve
  // first-appearance order, which fixes the result order below.
  const byAccount = new Map<string, Map<string, SuccessfulMetricPoint[]>>();
  for (const point of points) {
    let metrics = byAccount.get(point.accountId);
    if (metrics === undefined) {
      metrics = new Map<string, SuccessfulMetricPoint[]>();
      byAccount.set(point.accountId, metrics);
    }
    const group = metrics.get(point.metricKey);
    if (group === undefined) metrics.set(point.metricKey, [point]);
    else group.push(point);
  }

  const gaps: CollectionGap[] = [];
  for (const metrics of byAccount.values()) {
    for (const group of metrics.values()) {
      // Array#sort is stable (equal timestamps keep input order and yield a
      // zero elapsed time — never a gap); the fresh array leaves the input
      // untouched.
      const ordered = [...group].sort((a, b) => compareEpochMs(a.collectedAt, b.collectedAt));
      let from: SuccessfulMetricPoint | undefined;
      for (const to of ordered) {
        if (from !== undefined) {
          const elapsedMs = to.collectedAt - from.collectedAt;
          const intervalSeconds = pairIntervalSeconds(
            timeline,
            from.collectedAt,
            to.collectedAt,
            intervalSecondsAt(timeline, from.collectedAt),
          );
          const thresholdMs = gapThresholdMs(intervalSeconds);
          if (elapsedMs > thresholdMs) {
            gaps.push({
              accountId: from.accountId,
              metricKey: from.metricKey,
              fromEpochMs: from.collectedAt,
              toEpochMs: to.collectedAt,
              elapsedMs,
              intervalSeconds,
              thresholdMs,
            });
          }
        }
        from = to;
      }
    }
  }
  return gaps;
}
