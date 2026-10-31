/**
 * History series downsampling (spec §13; task 121, decision D-081).
 *
 * The §13 max-points contract as one pure function: a metric series with
 * more points than the caller's `maxPoints` budget (default 1500, accepted
 * range 100–5000) is aggregated into time buckets that each preserve their
 * member minimum, maximum, first, and last points, and no bucket ever
 * aggregates across a critical boundary — a quota-reset instant or a
 * collection-gap interval — because §13 says those "must not be lost".
 * Points, budget, and boundaries in; buckets out. Nothing here reads
 * storage, knows the clock (D-021: timestamps are data), or speaks HTTP —
 * the §13 `GET /api/history` route composes this service and serializes the
 * effective resolution it returns.
 *
 * Boundaries arrive **as data**, never recomputed: the reset instants are
 * the `eventAt` of the D-074 detector's `ResetEvent`s and the gap intervals
 * are the D-075 detector's `CollectionGap`s (`fromEpochMs`/`toEpochMs`) —
 * both shapes satisfy this module's structural boundary interfaces verbatim,
 * already filtered to the one series being downsampled (§13 requests one
 * account and one metric; the identity fields the detector outputs carry are
 * this caller's business, not the downsampler's).
 *
 * Interpretations pinned in D-081:
 *
 * - **Min/max are per quota field; first/last are real points.** §13 says
 *   "preserving each bucket's minimum, maximum, first, and last points"; a
 *   point carries several fields, so the extrema are computed per field
 *   (`used`, `remaining`, `percentUsed`, `percentRemaining`) over the
 *   members that carry it, and a field absent from every member is absent
 *   from the extrema. `first`/`last` are the earliest/latest member point
 *   objects themselves — references to the caller's input, so any field
 *   beyond this module's declared vocabulary rides along untouched.
 * - **Boundaries separate consecutive points, not grid instants.** A reset
 *   instant `e` splits between the pair with `previous < e ≤ next` (a reset
 *   stamped at a point's own collection time — D-074's
 *   `current_collected_at` source — groups that point with the **post**
 *   side, where it belongs). A gap `(from, to)` splits exactly the pair
 *   straddling its whole interval (`previous ≤ from ∧ next ≥ to`), so both
 *   edge points — D-075 guarantees they are adjacent successful points —
 *   stay with their own side of the silence. Equal-timestamp pairs never
 *   separate.
 * - **Segments get apportioned uniform time slices.** Separations cut the
 *   sorted series into segments aggregated independently, so the
 *   boundary rule holds by construction. Segment `i` with `nᵢ` of `N`
 *   points receives `1 + ⌊nᵢ·E/N⌋` buckets (`E = maxPoints − segment
 *   count`): always at least one, never more than its own point count, and
 *   the total never exceeds the budget — no capping or remainder passes.
 *   Members land in time slice `⌊(t − s)·b/span⌋` of their segment — exact
 *   cross-multiplied arithmetic for the integer timestamps epoch
 *   milliseconds are — and empty slices are simply not emitted. Bucket
 *   edges are observed member timestamps, never synthetic grid values.
 * - **The boundary rule outranks the budget.** §13's "must not be lost" is
 *   unconditional; `maxPoints` bends only when the boundary structure
 *   itself needs more buckets than the budget (more segments than
 *   `maxPoints` — unreachable below 100 boundaries, since §13 caps the
 *   accepted range at 100–5000): every segment then stays exactly one
 *   bucket and the output may exceed `maxPoints`, the only alternative
 *   being the aggregation across a boundary §13 forbids.
 * - **The effective resolution is the widest allocated slice width** —
 *   `segment span / bucket count`, maximized over the segments: the time
 *   granularity the aggregation actually operated at. A bucket's observed
 *   member span can fall below it (clustered or simultaneous points) and
 *   would understate how coarsely the values were merged; a series at or
 *   under the budget passes through unaggregated with a `null` resolution.
 *
 * The output is deterministic: points are stably sorted by `collectedAt`
 * (equal timestamps keep input order), boundary arrays are
 * order-independent, and every arithmetic step is exact for integer
 * timestamps (all products stay far below 2⁵³). Results and buckets are
 * frozen; the point objects themselves are the caller's and are never
 * cloned or mutated.
 */

import type { EpochMs } from '../util/clock';

/* ── The §13 max-points contract ───────────────────────────────────────── */

/** §13: the `maxPoints` default of `GET /api/history`. */
export const DEFAULT_MAX_POINTS = 1500;

/** §13: the smallest `maxPoints` the API accepts. */
export const MIN_MAX_POINTS = 100;

/** §13: the largest `maxPoints` the API accepts. */
export const MAX_MAX_POINTS = 5000;

/** The quota fields a bucket's extrema aggregate, in §8.4 declaration order. */
const VALUE_FIELDS = Object.freeze([
  'used',
  'remaining',
  'percentUsed',
  'percentRemaining',
] as const);

/** One of {@link VALUE_FIELDS}. */
type ValueField = (typeof VALUE_FIELDS)[number];

/* ── Input and output types ────────────────────────────────────────────── */

/**
 * One point of the metric series being downsampled — the §8.4 reading of a
 * stored `metric_values` row: its snapshot's `collectedAt` plus the value
 * fields the row carries (invalid rows carry none, D-010, and simply
 * contribute nothing to the extrema). First/last bucket members are the
 * caller's own objects, so fields beyond this interface survive on them.
 */
export interface DownsamplePoint {
  /** Collection time of the snapshot the point came from, UTC epoch ms. */
  readonly collectedAt: EpochMs;
  /** Consumed amount in the metric's unit (§8.4). */
  readonly used?: number;
  /** Remaining amount in the metric's unit (§8.4). */
  readonly remaining?: number;
  /** Percentage of the allowance consumed (§8.4). */
  readonly percentUsed?: number;
  /** Percentage of the allowance remaining (§8.4). */
  readonly percentRemaining?: number;
}

/**
 * A reset boundary as data: the D-074 `ResetEvent`'s `eventAt` — the §12.1
 * event time, either the previous snapshot's declared `resetsAt` or the
 * post-reset snapshot's collection time. Satisfied by `ResetEvent`
 * (`src/services/events-detection.ts`) verbatim.
 */
export interface ResetEventBoundary {
  /** UTC epoch milliseconds of the detected reset (§12.1). */
  readonly eventAt: EpochMs;
}

/**
 * A gap boundary as data: the D-075 `CollectionGap`'s interval — the
 * adjacent successful points whose elapsed time exceeded three effective
 * polling intervals. Satisfied by `CollectionGap`
 * (`src/services/history-gaps.ts`) verbatim.
 */
export interface GapBoundary {
  /** The earlier point's `collectedAt` — the gap's start edge. */
  readonly fromEpochMs: EpochMs;
  /** The later point's `collectedAt` — the gap's end edge. */
  readonly toEpochMs: EpochMs;
}

/** The critical boundaries a downsampling pass must respect (§13). */
export interface DownsampleBoundaries {
  /** Detected quota-reset events of this series (D-074 output, as data). */
  readonly resetEvents?: readonly ResetEventBoundary[];
  /** Detected collection gaps of this series (D-075 output, as data). */
  readonly gaps?: readonly GapBoundary[];
}

/** The per-field extrema of one bucket's members (§13 "minimum, maximum"). */
export interface BucketExtrema {
  /** The smallest member `used`, when any member carries it. */
  readonly used?: number;
  /** The smallest member `remaining`, when any member carries it. */
  readonly remaining?: number;
  /** The smallest member `percentUsed`, when any member carries it. */
  readonly percentUsed?: number;
  /** The smallest member `percentRemaining`, when any member carries it. */
  readonly percentRemaining?: number;
}

/** One aggregated time bucket of a downsampled series (§13). */
export interface MetricBucket {
  /** The earliest member's `collectedAt` — an observed timestamp. */
  readonly fromEpochMs: EpochMs;
  /** The latest member's `collectedAt` — an observed timestamp. */
  readonly toEpochMs: EpochMs;
  /** How many series points the bucket aggregates. */
  readonly count: number;
  /** The earliest member point, by time then input order — the caller's object. */
  readonly first: DownsamplePoint;
  /** The latest member point, by time then input order — the caller's object. */
  readonly last: DownsamplePoint;
  /** Per-field minima over the members that carry each field. */
  readonly min: BucketExtrema;
  /** Per-field maxima over the members that carry each field. */
  readonly max: BucketExtrema;
}

/**
 * The result of one downsampling pass. A series with at most `maxPoints`
 * points passes through unaggregated (§13 aggregates only when a range has
 * **more** points); an overfull series comes back as buckets plus the
 * effective resolution the §13 response must include.
 */
export type DownsampleResult = DownsamplePassthrough | DownsampledSeries;

/** The at-or-under-budget outcome: the series itself, chronological. */
export interface DownsamplePassthrough {
  readonly kind: 'passthrough';
  /** The input points, stably sorted by `collectedAt` — the caller's objects. */
  readonly points: readonly DownsamplePoint[];
  /** `null`: no aggregation happened, so there is no bucket resolution. */
  readonly resolutionMs: null;
}

/** The over-budget outcome: the aggregated series and its resolution. */
export interface DownsampledSeries {
  readonly kind: 'downsampled';
  /** The buckets, chronologically ordered and boundary-clean. */
  readonly buckets: readonly MetricBucket[];
  /** The widest allocated slice width in ms — §13's effective resolution. */
  readonly resolutionMs: number;
}

/* ── Validation (fail-fast, the D-059/D-064 convention) ────────────────── */

/**
 * Validates the point-budget argument against §13's accepted range, so a
 * wiring mistake above this module (an unclamped query parameter, a
 * unit-confused constant) fails here instead of silently reshaping every
 * chart.
 */
function requireMaxPoints(maxPoints: number, caller: string): void {
  if (
    typeof maxPoints !== 'number' ||
    !Number.isInteger(maxPoints) ||
    maxPoints < MIN_MAX_POINTS ||
    maxPoints > MAX_MAX_POINTS
  ) {
    throw new RangeError(
      `${caller}: maxPoints must be an integer in [${MIN_MAX_POINTS}, ${MAX_MAX_POINTS}] (spec §13)`,
    );
  }
}

/**
 * Validates the series. Non-objects, non-finite timestamps, and non-finite
 * carried values are caller wiring mistakes and fail loudly with the
 * offending index — the §8.4 boundary check (§11.2 storage columns) already
 * excludes non-finite values, so this is the seam's own tripwire.
 */
function requirePoints(points: readonly DownsamplePoint[], caller: string): void {
  if (!Array.isArray(points)) {
    throw new TypeError(`${caller}: points must be an array of DownsamplePoint`);
  }
  for (const [index, point] of points.entries()) {
    if (typeof point !== 'object' || point === null) {
      throw new TypeError(`${caller}: points[${index}] must be a DownsamplePoint`);
    }
    if (typeof point.collectedAt !== 'number' || !Number.isFinite(point.collectedAt)) {
      throw new TypeError(
        `${caller}: points[${index}].collectedAt must be a finite UTC epoch-milliseconds timestamp`,
      );
    }
    for (const field of VALUE_FIELDS) {
      const value = point[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new TypeError(
          `${caller}: points[${index}].${field} must be a finite number when present`,
        );
      }
    }
  }
}

/**
 * Validates the boundary records. Degenerate gaps (`to ≤ from`) are
 * rejected outright: D-075 guarantees `elapsedMs > 0` for every real gap, so
 * an inverted interval is a wiring mistake, not data.
 */
function requireBoundaries(boundaries: DownsampleBoundaries, caller: string): void {
  if (typeof boundaries !== 'object' || boundaries === null) {
    throw new TypeError(`${caller}: boundaries must be a DownsampleBoundaries object`);
  }
  const { resetEvents = [], gaps = [] } = boundaries;
  if (!Array.isArray(resetEvents)) {
    throw new TypeError(`${caller}: boundaries.resetEvents must be an array of ResetEventBoundary`);
  }
  for (const [index, event] of resetEvents.entries()) {
    if (typeof event !== 'object' || event === null) {
      throw new TypeError(
        `${caller}: boundaries.resetEvents[${index}] must be a ResetEventBoundary`,
      );
    }
    if (typeof event.eventAt !== 'number' || !Number.isFinite(event.eventAt)) {
      throw new TypeError(
        `${caller}: boundaries.resetEvents[${index}].eventAt must be a finite UTC epoch-milliseconds timestamp`,
      );
    }
  }
  if (!Array.isArray(gaps)) {
    throw new TypeError(`${caller}: boundaries.gaps must be an array of GapBoundary`);
  }
  for (const [index, gap] of gaps.entries()) {
    if (typeof gap !== 'object' || gap === null) {
      throw new TypeError(`${caller}: boundaries.gaps[${index}] must be a GapBoundary`);
    }
    if (
      typeof gap.fromEpochMs !== 'number' ||
      !Number.isFinite(gap.fromEpochMs) ||
      typeof gap.toEpochMs !== 'number' ||
      !Number.isFinite(gap.toEpochMs)
    ) {
      throw new TypeError(
        `${caller}: boundaries.gaps[${index}] edges must be finite UTC epoch-milliseconds timestamps`,
      );
    }
    if (gap.toEpochMs <= gap.fromEpochMs) {
      throw new RangeError(
        `${caller}: boundaries.gaps[${index}] must have toEpochMs > fromEpochMs (a gap is a non-empty interval, D-075)`,
      );
    }
  }
}

/* ── Segmentation ──────────────────────────────────────────────────────── */

/** Non-subtraction ordering of epoch timestamps (no float-overflow corners). */
function compareEpochMs(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The segmentation question — "does a critical boundary fall between these
 * two chronologically adjacent points?" — answered for a whole series in
 * one chronological walk. A reset instant applies through its own timestamp
 * (`from < eventAt ≤ to`: the point a `current_collected_at` reset is
 * stamped on belongs to the post side); a gap applies when the pair
 * straddles its whole interval (`from ≤ gap.from ∧ to ≥ gap.to`: both edge
 * points keep their own side). Equal timestamps never separate — both
 * windows are empty then.
 *
 * The boundary records are sorted once up front and the walk advances two
 * cursors monotonically (the pairs arrive with non-decreasing edges): the
 * reset check asks whether the smallest instant beyond `fromAt` still lies
 * inside the pair, and the gap check tracks the latest gap start among the
 * gaps that end at or before `toAt` — the pair brackets exactly the gaps
 * whose whole interval it contains. One pass is O(N + R + G) after the
 * sorts, versus a rescan of every boundary for every pair — a §14.4-maximum
 * series (30 days at the 60 s floor, 43 200 points) with dense gaps
 * otherwise costs seconds per request on the §13 route.
 */
interface SeparationOracle {
  /** Chronological calls only: both edges non-decreasing across invocations. */
  separates(fromAt: number, toAt: number): boolean;
}

/** Builds {@link SeparationOracle} from the caller's boundary records. */
function buildSeparationOracle(
  resetEvents: readonly ResetEventBoundary[],
  gaps: readonly GapBoundary[],
): SeparationOracle {
  const resets = [...resetEvents].map((event) => event.eventAt).sort(compareEpochMs);
  const gapsByEnd = [...gaps].sort((a, b) => compareEpochMs(a.toEpochMs, b.toEpochMs));
  let resetCursor = 0; // first instant not yet known to be ≤ the current fromAt
  let gapCursor = 0; // first gap not yet known to end at or before the current toAt
  let latestGapStartMs = Number.NEGATIVE_INFINITY; // latest start among admitted gaps

  return {
    separates(fromAt: number, toAt: number): boolean {
      while (resetCursor < resets.length && resets[resetCursor]! <= fromAt) resetCursor++;
      // The smallest instant strictly beyond fromAt — the only reset that
      // can fall inside (fromAt, toAt]; undefined when none exists.
      const nextResetAt = resets[resetCursor];
      if (nextResetAt !== undefined && nextResetAt <= toAt) return true;
      while (gapCursor < gapsByEnd.length && gapsByEnd[gapCursor]!.toEpochMs <= toAt) {
        latestGapStartMs = Math.max(latestGapStartMs, gapsByEnd[gapCursor]!.fromEpochMs);
        gapCursor++;
      }
      // Some fully-bracketed gap exists iff the latest-starting gap that
      // ends inside the pair still starts at or after the pair's opening.
      return latestGapStartMs >= fromAt;
    },
  };
}

/* ── Aggregation ───────────────────────────────────────────────────────── */

/** The per-field extrema of `members` — `combine` is `Math.min` or `Math.max`. */
function bucketExtrema(
  members: readonly DownsamplePoint[],
  combine: (a: number, b: number) => number,
): BucketExtrema {
  const extrema: Partial<Record<ValueField, number>> = {};
  for (const field of VALUE_FIELDS) {
    let value: number | undefined;
    for (const member of members) {
      const current = member[field];
      if (current === undefined) continue;
      // `value` carries the previous member's number whenever it runs.
      value = value === undefined ? current : combine(value, current);
    }
    if (value !== undefined) extrema[field] = value;
  }
  return Object.freeze(extrema);
}

/** Builds one bucket over a chronologically ordered, non-empty member run. */
function makeBucket(members: readonly DownsamplePoint[]): MetricBucket {
  // Non-empty by construction: segmentation only emits runs of real points.
  const first = members[0]!;
  const last = members[members.length - 1]!;
  return Object.freeze({
    fromEpochMs: first.collectedAt,
    toEpochMs: last.collectedAt,
    count: members.length,
    first,
    last,
    min: bucketExtrema(members, Math.min),
    max: bucketExtrema(members, Math.max),
  });
}

/** One segment's aggregation: its buckets and its allocated slice width. */
interface SegmentAggregation {
  readonly buckets: readonly MetricBucket[];
  /** `segmentSpan / bucketCount` in ms — the slice width points were merged at. */
  readonly sliceWidthMs: number;
}

/**
 * Aggregates one segment into `bucketCount` uniform time slices anchored at
 * the segment's first member. Slice membership is computed by
 * cross-multiplication — `⌊(t − s)·b/span⌋`, clamped to the last slice —
 * which is exact for integer timestamps (the product stays below 2⁵³ for
 * any §14.4 range and budget) and needs no synthetic edge values: a
 * bucket's edges are simply its first and last member timestamps. Slices
 * that receive no points are not emitted (a cluster of points may leave
 * trailing slices empty), and a zero-span segment (every member sharing one
 * timestamp) lands entirely in slice 0.
 */
function aggregateSegment(
  members: readonly DownsamplePoint[],
  bucketCount: number,
): SegmentAggregation {
  // Non-empty by construction; the first member anchors the slices, the
  // last closes the span (they may be the same point).
  const startAt = members[0]!.collectedAt;
  const spanMs = members[members.length - 1]!.collectedAt - startAt;

  const slices: DownsamplePoint[][] = Array.from({ length: bucketCount }, () => []);
  for (const member of members) {
    const offset = member.collectedAt - startAt;
    const index =
      spanMs === 0 ? 0 : Math.min(Math.floor((offset * bucketCount) / spanMs), bucketCount - 1);
    slices[index]!.push(member);
  }

  const buckets: MetricBucket[] = [];
  for (const slice of slices) {
    if (slice.length === 0) continue;
    buckets.push(makeBucket(slice));
  }
  return { buckets, sliceWidthMs: spanMs / bucketCount };
}

/* ── Downsampling ──────────────────────────────────────────────────────── */

/**
 * Downsamples one metric series to fit the §13 `maxPoints` budget.
 *
 * A series with at most `maxPoints` points passes through unaggregated —
 * chronologically sorted (stably: equal timestamps keep input order; input
 * order is otherwise irrelevant) — with `resolutionMs: null`. An overfull
 * series is cut into segments at the critical boundaries ({@link
 * DownsampleBoundaries}: reset instants and gap intervals, as data), every
 * segment is aggregated into uniform time slices apportioned by point count
 * (`1 + ⌊nᵢ·E/N⌋` buckets — at least one per segment, never more than its
 * points, total within the budget), and the widest allocated slice width is
 * returned as the effective resolution. When the boundary structure alone
 * needs more buckets than the budget, every segment stays exactly one
 * bucket and the bucket count may exceed `maxPoints` (D-081: the
 * must-not-be-lost rule outranks the count target; unreachable below 100
 * boundaries).
 *
 * The output is deterministic and frozen; bucket `first`/`last` are the
 * caller's own point objects. Invalid arguments fail fast with
 * caller-addressed messages.
 */
export function downsampleHistorySeries(
  points: readonly DownsamplePoint[],
  maxPoints: number,
  boundaries: DownsampleBoundaries = {},
): DownsampleResult {
  const caller = 'downsampleHistorySeries';
  requireMaxPoints(maxPoints, caller);
  requirePoints(points, caller);
  requireBoundaries(boundaries, caller);

  // Stable sort: equal timestamps keep input order; the fresh array leaves
  // the caller's input untouched.
  const ordered = [...points].sort((a, b) => compareEpochMs(a.collectedAt, b.collectedAt));

  // §13 aggregates only when the range has *more* points than the budget.
  if (ordered.length <= maxPoints) {
    return Object.freeze({
      kind: 'passthrough',
      points: Object.freeze(ordered),
      resolutionMs: null,
    });
  }

  const { resetEvents = [], gaps = [] } = boundaries;
  const oracle = buildSeparationOracle(resetEvents, gaps);
  const segments: DownsamplePoint[][] = [];
  let current: DownsamplePoint[] = [];
  for (const [index, point] of ordered.entries()) {
    if (index > 0 && oracle.separates(ordered[index - 1]!.collectedAt, point.collectedAt)) {
      segments.push(current);
      current = [];
    }
    current.push(point);
  }
  segments.push(current);

  // Apportionment: with S segments of N > maxPoints points in total, every
  // segment keeps one bucket plus its proportional floor share of the
  // E = maxPoints − S extras. nᵢ·E < nᵢ·N (E < N), so the share is always
  // below the segment's own point count, and the floors sum to at most E —
  // no capping, no remainder passes, the budget holds by arithmetic. The
  // degenerate S > maxPoints case (D-081) keeps one bucket per segment.
  const totalPoints = ordered.length;
  const extraBudget = maxPoints - segments.length;
  const buckets: MetricBucket[] = [];
  let resolutionMs = 0;
  for (const segment of segments) {
    const bucketCount =
      extraBudget <= 0 ? 1 : 1 + Math.floor((segment.length * extraBudget) / totalPoints);
    const { buckets: segmentBuckets, sliceWidthMs } = aggregateSegment(segment, bucketCount);
    resolutionMs = Math.max(resolutionMs, sliceWidthMs);
    buckets.push(...segmentBuckets);
  }

  // At least one bucket always exists: every segment's anchor point lands
  // in its slice 0, so an overfull series can never aggregate to nothing.
  return Object.freeze({
    kind: 'downsampled',
    buckets: Object.freeze(buckets),
    resolutionMs,
  });
}
