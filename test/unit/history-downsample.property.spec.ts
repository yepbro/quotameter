import { describe, expect, it } from 'vitest';
import { fc } from '../helpers/property';
import {
  downsampleHistorySeries,
  type DownsampleBoundaries,
  type DownsamplePoint,
} from '../../src/services/history-downsample';

/**
 * Property-based coverage of the §13 downsampling contract (task 121,
 * decision D-081), the standing complement to `history-downsample.spec.ts`
 * (task 124 extends this suite): over generated strictly-chronological
 * series with generated reset instants and gap intervals (the D-074/D-075
 * output shapes, as data), the passthrough/downsampled boundary follows
 * `maxPoints` exactly; the bucket count stays inside the budget (and inside
 * `max(maxPoints, segments)` unconditionally, the D-081 carve-out bound);
 * walking the series chronologically and consuming bucket counts in order
 * reproduces every bucket's `first`/`last` members exactly — the coverage,
 * no-loss, and no-reorder oracle — while each bucket's per-field extrema
 * equal the true aggregates of exactly those members, the whole series'
 * extrema survive in the bucket extrema, and no bucket spans any boundary.
 */

/** 2026-10-31T12:00:00Z — the base collection timestamp of every series. */
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

/** The quota fields a bucket aggregates. */
const VALUE_FIELDS = ['used', 'remaining', 'percentUsed', 'percentRemaining'] as const;

/** A finite quota value in a plausible range (any finite value is legal). */
const valueArb = fc.double({ min: 0, max: 1_000_000, noNaN: true });

/** The carried value fields of one point (any subset). */
const fieldsArb = fc.record({
  used: fc.option(valueArb, { nil: undefined }),
  remaining: fc.option(valueArb, { nil: undefined }),
  percentUsed: fc.option(valueArb, { nil: undefined }),
  percentRemaining: fc.option(valueArb, { nil: undefined }),
});

/**
 * A strictly chronological series of at most 221 points, one minute or more
 * apart — distinct timestamps, so output is invariant under input
 * shuffling. `size: 'max'` is load-bearing: fast-check's default array
 * size caps lengths far below the §13 budget floor of 100, and without it
 * the generator never produces an overfull series (found in review). The
 * `pairIndex` lists select which adjacent pairs the boundary records fall
 * on; `interiorGap` moves the gap edges off the points.
 */
const caseArb = fc
  .tuple(
    fc.array(fieldsArb, { maxLength: 220, size: 'max' }),
    fc.array(fc.nat(219), { maxLength: 6 }),
    fc.array(fc.nat(219), { maxLength: 4 }),
    fc.boolean(),
  )
  .map(([fields, resetPairs, gapPairs, interiorGap]) => {
    const points: DownsamplePoint[] = fields.map((carried, index) => ({
      ...carried,
      collectedAt: T0 + (index + 1) * 60_000,
    }));
    const pairCount = Math.max(points.length - 1, 0);
    const pick = (raw: number) => raw % pairCount;
    const at = (index: number) => points[index]!.collectedAt;
    // A series of fewer than two points has no pair a boundary could
    // separate, so the record lists are empty then.
    const resetEvents =
      pairCount === 0 ? [] : resetPairs.map((pair) => ({ eventAt: at(pick(pair)) + 30_000 }));
    const gaps =
      pairCount === 0
        ? []
        : gapPairs.map((pair) => {
            const from = at(pick(pair));
            const to = at(pick(pair) + 1);
            return interiorGap
              ? { fromEpochMs: from + 10_000, toEpochMs: to - 10_000 }
              : { fromEpochMs: from, toEpochMs: to };
          });
    return { points, resetEvents, gaps } as const;
  });

/** Any §13-valid point budget, kept at or below the series-size generator. */
const maxPointsArb = fc.integer({ min: 100, max: 220 });

/**
 * The independent segmentation oracle: which adjacent pairs a boundary
 * separates, computed by brute force over the boundary records — resets
 * apply through their instant, gaps when the pair straddles the interval.
 */
function oracleSegmentCount(
  points: readonly DownsamplePoint[],
  boundaries: DownsampleBoundaries,
): number {
  if (points.length === 0) return 0;
  let segments = 1;
  for (let index = 0; index + 1 < points.length; index++) {
    const fromAt = points[index]!.collectedAt;
    const toAt = points[index + 1]!.collectedAt;
    const resetCut = boundaries.resetEvents?.some(
      (event) => fromAt < event.eventAt && event.eventAt <= toAt,
    );
    const gapCut = boundaries.gaps?.some(
      (gap) => fromAt <= gap.fromEpochMs && toAt >= gap.toEpochMs,
    );
    if (resetCut || gapCut) segments++;
  }
  return segments;
}

/** The true per-field aggregates of `members`, as a bucket-extrema object. */
function trueExtrema(
  members: readonly DownsamplePoint[],
  combine: (a: number, b: number) => number,
): Record<string, number> {
  const extrema: Record<string, number> = {};
  for (const field of VALUE_FIELDS) {
    const values = members
      .map((member) => member[field])
      .filter((value): value is number => value !== undefined);
    if (values.length > 0) extrema[field] = values.reduce(combine);
  }
  return extrema;
}

/**
 * Runs every preservation check against one generated case: the member
 * walk (coverage, no loss, no reordering, first/last identity), the oracle
 * extrema, the budget bounds, the boundary cleanliness, and the reported
 * resolution. Sets the vacuity tripwires below.
 */
let sawDownsampled = false;
let sawPassthrough = false;
let sawSeparated = false;

function checkPreservation(
  points: readonly DownsamplePoint[],
  maxPoints: number,
  boundaries: DownsampleBoundaries,
): void {
  const result = downsampleHistorySeries(points, maxPoints, boundaries);
  expect(downsampleHistorySeries(points, maxPoints, boundaries)).toEqual(result); // deterministic
  expect(downsampleHistorySeries([...points].reverse(), maxPoints, boundaries)).toEqual(result);

  const segmentCount = oracleSegmentCount(points, boundaries);
  if (points.length <= maxPoints) {
    sawPassthrough = true;
    expect(result.kind).toBe('passthrough');
    if (result.kind !== 'passthrough') throw new Error('unreachable');
    expect(result.resolutionMs).toBeNull();
    expect(result.points).toEqual([...points].sort((a, b) => a.collectedAt - b.collectedAt));
    return;
  }
  sawDownsampled = true;
  if (segmentCount > 1) sawSeparated = true;

  expect(result.kind).toBe('downsampled');
  if (result.kind !== 'downsampled') throw new Error('unreachable');
  const { buckets } = result;
  expect(buckets.length).toBeLessThanOrEqual(Math.max(maxPoints, segmentCount));
  if (segmentCount <= maxPoints) {
    expect(buckets.length).toBeLessThanOrEqual(maxPoints);
  }
  expect(buckets.length).toBeLessThanOrEqual(points.length);

  // The member walk: consuming each bucket's count in chronological order
  // must land exactly on that bucket's first and last member references.
  const ordered = [...points].sort((a, b) => a.collectedAt - b.collectedAt);
  let cursor = 0;
  let widest = 0;
  for (const bucket of buckets) {
    const members = ordered.slice(cursor, cursor + bucket.count);
    expect(members.length).toBe(bucket.count);
    expect(bucket.first).toBe(members[0]);
    expect(bucket.last).toBe(members.at(-1));
    expect(bucket.fromEpochMs).toBe(bucket.first.collectedAt);
    expect(bucket.toEpochMs).toBe(bucket.last.collectedAt);
    expect(bucket.min).toEqual(trueExtrema(members, (a, b) => Math.min(a, b)));
    expect(bucket.max).toEqual(trueExtrema(members, (a, b) => Math.max(a, b)));
    // Boundary cleanliness: no bucket aggregates across a reset instant or
    // a whole gap interval.
    for (const event of boundaries.resetEvents ?? []) {
      expect(
        bucket.first.collectedAt < event.eventAt && event.eventAt <= bucket.last.collectedAt,
      ).toBe(false);
    }
    for (const gap of boundaries.gaps ?? []) {
      expect(
        bucket.first.collectedAt <= gap.fromEpochMs && bucket.last.collectedAt >= gap.toEpochMs,
      ).toBe(false);
    }
    widest = Math.max(widest, bucket.toEpochMs - bucket.fromEpochMs);
    cursor += bucket.count;
  }
  expect(cursor).toBe(ordered.length); // every point bucketed, none lost
  // The effective resolution is the widest allocated slice width: at least
  // any observed bucket span (members share a slice), at most the series
  // span (a slice never exceeds its segment), and positive unless every
  // segment is instantaneous. `ordered` is non-empty in this branch.
  const seriesSpanMs = ordered.at(-1)!.collectedAt - ordered[0]!.collectedAt;
  expect(result.resolutionMs).toBeGreaterThanOrEqual(widest);
  expect(result.resolutionMs).toBeLessThanOrEqual(seriesSpanMs);
  if (seriesSpanMs > 0) expect(result.resolutionMs).toBeGreaterThan(0);

  // The whole series' extrema survive in the bucket extrema.
  for (const field of VALUE_FIELDS) {
    const bucketMinima = buckets
      .map((b) => b.min[field])
      .filter((v): v is number => v !== undefined);
    const bucketMaxima = buckets
      .map((b) => b.max[field])
      .filter((v): v is number => v !== undefined);
    const seriesMinimum = trueExtrema(ordered, (a, b) => Math.min(a, b))[field];
    const seriesMaximum = trueExtrema(ordered, (a, b) => Math.max(a, b))[field];
    if (seriesMinimum !== undefined) {
      expect(bucketMinima.length).toBeGreaterThan(0);
      expect(Math.min(...bucketMinima)).toBe(seriesMinimum);
      expect(Math.max(...bucketMaxima)).toBe(seriesMaximum);
    } else {
      expect(bucketMinima).toEqual([]);
      expect(bucketMaxima).toEqual([]);
    }
  }
}

describe('downsampleHistorySeries: preservation properties (§13, §17.1)', () => {
  it('preserves extrema, first/last members, boundaries, and the budget over arbitrary series', () => {
    fc.assert(
      fc.property(caseArb, maxPointsArb, ({ points, resetEvents, gaps }, maxPoints) => {
        checkPreservation(points, maxPoints, { resetEvents, gaps });
      }),
    );
    // Vacuity tripwires: the generator must have produced all three shapes —
    // an overfull series, an at-or-under-budget one, and a separated one
    // (the default fast-check array size never reaches the 100-point budget
    // floor; found in review).
    expect([sawDownsampled, sawPassthrough, sawSeparated]).toEqual([true, true, true]);
  });

  it('pins the §13 boundary: exactly maxPoints points pass through, one more aggregates', () => {
    fc.assert(
      fc.property(caseArb, maxPointsArb, ({ points, resetEvents, gaps }, maxPoints) => {
        const boundaries = { resetEvents, gaps };
        const atBudget = points.slice(0, maxPoints);
        expect(downsampleHistorySeries(atBudget, maxPoints, boundaries).kind).toBe('passthrough');
        const overBudget = points.slice(0, maxPoints + 1);
        if (overBudget.length > maxPoints) {
          expect(downsampleHistorySeries(overBudget, maxPoints, boundaries).kind).toBe(
            'downsampled',
          );
        }
      }),
    );
  });
});
