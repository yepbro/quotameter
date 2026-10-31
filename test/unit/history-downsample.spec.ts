import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_POINTS,
  MAX_MAX_POINTS,
  MIN_MAX_POINTS,
  downsampleHistorySeries,
  type DownsamplePoint,
} from '../../src/services/history-downsample';

/**
 * Deterministic coverage of the §13 max-points contract (task 121, decision
 * D-081): the passthrough/downsampled boundary at exactly `maxPoints`
 * points, a hand-computed bucket layout with per-field min/max and
 * first/last point identity, both critical-boundary kinds splitting exactly
 * the pair they separate (a reset stamped on a point groups it with the
 * post side; a gap's edge points keep their own sides), the §13 constants,
 * the degenerate dense-boundary carve-out, and the fail-fast input
 * contract. Property-based complements (budget, oracle extrema, coverage,
 * boundary cleanliness, order-insensitivity) live in
 * `history-downsample.property.spec.ts`.
 */

/** 2026-10-31T12:00:00Z — the base collection timestamp of every series. */
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

/** The §7.1 default polling interval as the point spacing of the fixtures. */
const STEP_MS = 60_000;

/**
 * `count` points at one-minute spacing from `T0`, `used` climbing by index
 * and `remaining` falling — so every bucket's extrema are hand-checkable.
 */
function minuteSeries(count: number, from: number = T0): DownsamplePoint[] {
  const points: DownsamplePoint[] = [];
  for (let index = 0; index < count; index++) {
    points.push({
      collectedAt: from + index * STEP_MS,
      used: index,
      remaining: 1000 - index,
    });
  }
  return points;
}

describe('the §13 max-points constants', () => {
  it('pins the default and the accepted range', () => {
    expect(DEFAULT_MAX_POINTS).toBe(1500);
    expect(MIN_MAX_POINTS).toBe(100);
    expect(MAX_MAX_POINTS).toBe(5000);
  });

  it.each([
    ['below the accepted floor', 99],
    ['above the accepted ceiling', 5001],
    ['a non-integer', 100.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '1500'],
  ])('rejects maxPoints %s', (_label, maxPoints) => {
    expect(() => downsampleHistorySeries([], maxPoints as unknown as number)).toThrow(
      'downsampleHistorySeries: maxPoints must be an integer in [100, 5000] (spec §13)',
    );
  });
});

describe('downsampleHistorySeries: fail-fast input contract', () => {
  it('rejects a non-array points argument', () => {
    expect(() =>
      downsampleHistorySeries('nope' as unknown as readonly DownsamplePoint[], 100),
    ).toThrow('downsampleHistorySeries: points must be an array of DownsamplePoint');
  });

  it.each([
    ['a non-object entry', 'x'],
    ['a null entry', null],
    ['a non-finite collectedAt', { collectedAt: Number.NaN, used: 1 }],
    ['a non-numeric collectedAt', { collectedAt: '2026' }],
  ])('rejects points containing %s', (_label, bad) => {
    const points = [{ collectedAt: T0 }, bad] as unknown as readonly DownsamplePoint[];
    expect(() => downsampleHistorySeries(points, 100)).toThrow(/points\[1\]/);
  });

  it.each([
    ['used', { collectedAt: T0, used: Number.POSITIVE_INFINITY }],
    ['percentRemaining', { collectedAt: T0, percentRemaining: Number.NaN }],
  ])('rejects a non-finite %s value', (field, bad) => {
    expect(() => downsampleHistorySeries([bad as unknown as DownsamplePoint], 100)).toThrow(
      `downsampleHistorySeries: points[0].${field} must be a finite number when present`,
    );
  });

  it('rejects a non-object boundaries argument', () => {
    expect(() => downsampleHistorySeries([], 100, null as unknown as undefined)).toThrow(
      'downsampleHistorySeries: boundaries must be a DownsampleBoundaries object',
    );
  });

  it('rejects malformed reset-event boundaries', () => {
    expect(() =>
      downsampleHistorySeries([], 100, { resetEvents: 'x' as unknown as never }),
    ).toThrow(
      'downsampleHistorySeries: boundaries.resetEvents must be an array of ResetEventBoundary',
    );
    expect(() =>
      downsampleHistorySeries([], 100, { resetEvents: ['x' as unknown as never] }),
    ).toThrow('downsampleHistorySeries: boundaries.resetEvents[0] must be a ResetEventBoundary');
    expect(() =>
      downsampleHistorySeries([], 100, { resetEvents: [{ eventAt: Number.NaN }] }),
    ).toThrow(
      'downsampleHistorySeries: boundaries.resetEvents[0].eventAt must be a finite UTC epoch-milliseconds timestamp',
    );
  });

  it('rejects malformed or degenerate gap boundaries', () => {
    expect(() => downsampleHistorySeries([], 100, { gaps: 'x' as unknown as never })).toThrow(
      'downsampleHistorySeries: boundaries.gaps must be an array of GapBoundary',
    );
    expect(() => downsampleHistorySeries([], 100, { gaps: ['x' as unknown as never] })).toThrow(
      'downsampleHistorySeries: boundaries.gaps[0] must be a GapBoundary',
    );
    expect(() =>
      downsampleHistorySeries([], 100, {
        gaps: [{ fromEpochMs: Number.NaN, toEpochMs: T0 }],
      }),
    ).toThrow(
      'downsampleHistorySeries: boundaries.gaps[0] edges must be finite UTC epoch-milliseconds timestamps',
    );
    expect(() =>
      downsampleHistorySeries([], 100, { gaps: [{ fromEpochMs: T0, toEpochMs: T0 }] }),
    ).toThrow(
      'downsampleHistorySeries: boundaries.gaps[0] must have toEpochMs > fromEpochMs (a gap is a non-empty interval, D-075)',
    );
    expect(() =>
      downsampleHistorySeries([], 100, {
        gaps: [{ fromEpochMs: T0 + STEP_MS, toEpochMs: T0 }],
      }),
    ).toThrow('must have toEpochMs > fromEpochMs');
  });
});

describe('downsampleHistorySeries: the passthrough boundary (§13 "more points")', () => {
  it('passes an empty series through', () => {
    expect(downsampleHistorySeries([], 100)).toEqual({
      kind: 'passthrough',
      points: [],
      resolutionMs: null,
    });
  });

  it('passes a single point through untouched, by reference', () => {
    const only = { collectedAt: T0, used: 5 };
    const result = downsampleHistorySeries([only], 100);
    expect(result).toEqual({ kind: 'passthrough', points: [only], resolutionMs: null });
    if (result.kind === 'passthrough') expect(result.points[0]).toBe(only);
  });

  it('passes a series of exactly maxPoints points through', () => {
    const points = minuteSeries(100);
    const result = downsampleHistorySeries(points, 100);
    expect(result.kind).toBe('passthrough');
    if (result.kind !== 'passthrough') return;
    expect(result.points).toHaveLength(100);
    expect(result.resolutionMs).toBeNull();
  });

  it('still passes through when boundaries are present — nothing is aggregated under the budget', () => {
    const points = minuteSeries(50);
    const boundaries = {
      resetEvents: [{ eventAt: T0 + 10 * STEP_MS }],
      gaps: [{ fromEpochMs: T0 + 20 * STEP_MS, toEpochMs: T0 + 21 * STEP_MS }],
    };
    expect(downsampleHistorySeries(points, 100, boundaries).kind).toBe('passthrough');
  });

  it('returns passthrough points chronologically sorted, whatever the input order', () => {
    const points = [
      minuteSeries(1, T0 + 2 * STEP_MS)[0]!,
      minuteSeries(1, T0)[0]!,
      minuteSeries(1, T0 + STEP_MS)[0]!,
    ];
    const result = downsampleHistorySeries(points, 100);
    if (result.kind !== 'passthrough') throw new Error('expected passthrough');
    expect(result.points.map((p) => p.collectedAt)).toEqual([T0, T0 + STEP_MS, T0 + 2 * STEP_MS]);
  });

  it('keeps input order among equal timestamps in passthrough (stable sort)', () => {
    const first = { collectedAt: T0, used: 1 };
    const second = { collectedAt: T0, used: 2 };
    const result = downsampleHistorySeries([second, first], 100);
    if (result.kind !== 'passthrough') throw new Error('expected passthrough');
    expect(result.points[0]).toBe(second);
    expect(result.points[1]).toBe(first);
  });
});

describe('downsampleHistorySeries: a hand-computed single-segment layout', () => {
  // 200 one-minute points, budget 100 → one segment apportioned
  // 1 + ⌊200·99/200⌋ = 100 buckets; slice membership floor(i·100/199)
  // pairs the points as {p0,p1}, {p2,p3}, … {p198,p199}.
  const points = minuteSeries(200).map((point, index) => ({
    ...point,
    // percentUsed rides only on even indices; percentRemaining on nothing.
    ...(index % 2 === 0 ? { percentUsed: index } : {}),
  }));
  const result = downsampleHistorySeries(points, 100);

  it('produces exactly the budget of buckets and covers every point', () => {
    expect(result.kind).toBe('downsampled');
    if (result.kind !== 'downsampled') return;
    expect(result.buckets).toHaveLength(100);
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(200);
  });

  it('aggregates each pair with exact extrema, count, and edges', () => {
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    const bucket = result.buckets[10]!;
    expect(bucket.first).toBe(points[20]); // by reference
    expect(bucket.last).toBe(points[21]);
    expect(bucket.count).toBe(2);
    expect(bucket.fromEpochMs).toBe(points[20]!.collectedAt);
    expect(bucket.toEpochMs).toBe(points[21]!.collectedAt);
    expect(bucket.min).toEqual({ used: 20, remaining: 979, percentUsed: 20 });
    expect(bucket.max).toEqual({ used: 21, remaining: 980, percentUsed: 20 });
  });

  it('reports the widest allocated slice width as the effective resolution', () => {
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    // One segment of a 199-minute span in 100 slices: 11 940 000 / 100 ms
    // per slice — the granularity the pairs were merged at, which the
    // observed one-minute pair spans would understate.
    expect(result.resolutionMs).toBe(11_940_000 / 100);
  });

  it('keeps first/last bucket endpoints at the series ends', () => {
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    expect(result.buckets[0]!.first).toBe(points[0]);
    expect(result.buckets.at(-1)!.last).toBe(points.at(-1));
  });
});

describe('downsampleHistorySeries: per-field extrema over sparse fields', () => {
  it('omits fields no member carries and aggregates the rest per field', () => {
    const points: DownsamplePoint[] = [];
    for (let index = 0; index < 202; index++) {
      points.push({
        collectedAt: T0 + index * STEP_MS,
        used: index % 2 === 0 ? index : undefined,
        percentUsed: index % 2 === 1 ? index : undefined,
      });
    }
    const result = downsampleHistorySeries(points, 100);
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    // The head slice {p0, p1, p2} (⌊i·100/201⌋) carries used from p0 and
    // p2 (both even) and percentUsed from p1 (odd): a single-carrier field
    // reports that member's own value, a two-carrier field its true
    // min/max.
    const head = result.buckets[0]!;
    expect(head.min.used).toBe(0);
    expect(head.max.used).toBe(2);
    expect(head.min.percentUsed).toBe(1);
    expect(head.max.percentUsed).toBe(1);
    expect('remaining' in head.min).toBe(false);
    expect('percentRemaining' in head.max).toBe(false);
  });
});

describe('downsampleHistorySeries: reset boundaries (D-074 eventAt as data)', () => {
  it('splits the series at a reset strictly between two points', () => {
    const points = minuteSeries(200);
    const resetAt = T0 + 100 * STEP_MS + STEP_MS / 2; // strictly inside pair (100, 101]
    const result = downsampleHistorySeries(points, 100, { resetEvents: [{ eventAt: resetAt }] });
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    // Segments of 101 and 99 points, apportioned 1 + ⌊101·98/200⌋ = 50 and
    // 1 + ⌊99·98/200⌋ = 49 buckets — 99 in total, inside the budget — and
    // no bucket spans the reset.
    expect(result.buckets).toHaveLength(99);
    for (const bucket of result.buckets) {
      const spansReset = bucket.fromEpochMs < resetAt && resetAt <= bucket.toEpochMs;
      expect(spansReset).toBe(false);
    }
    expect(result.buckets.at(-1)!.last).toBe(points.at(-1));
  });

  it('groups a point stamped by the reset with the post side (current_collected_at)', () => {
    const points = minuteSeries(200);
    const resetAt = T0 + 101 * STEP_MS; // exactly p101's collection time
    const result = downsampleHistorySeries(points, 100, { resetEvents: [{ eventAt: resetAt }] });
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    const after = result.buckets.filter((b) => b.fromEpochMs >= resetAt);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]!.first).toBe(points[101]); // p101 belongs to the post side
  });

  it('does not split when the reset instant sits on the pre-side point', () => {
    const points = minuteSeries(200);
    const resetAt = T0 + 100 * STEP_MS; // exactly p100's time: (t100, t101] misses it
    const result = downsampleHistorySeries(points, 100, { resetEvents: [{ eventAt: resetAt }] });
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    expect(result.buckets).toHaveLength(100); // one segment, no split
  });

  it('ignores reset instants outside the observed span', () => {
    const points = minuteSeries(200);
    const result = downsampleHistorySeries(points, 100, {
      resetEvents: [{ eventAt: T0 - STEP_MS }, { eventAt: T0 + 500 * STEP_MS }],
    });
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    expect(result.buckets).toHaveLength(100);
  });

  it('ignores gap intervals entirely outside the observed span', () => {
    const points = minuteSeries(200);
    const result = downsampleHistorySeries(points, 100, {
      gaps: [
        { fromEpochMs: T0 - 2 * STEP_MS, toEpochMs: T0 - STEP_MS },
        { fromEpochMs: T0 + 300 * STEP_MS, toEpochMs: T0 + 400 * STEP_MS },
      ],
    });
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    expect(result.buckets).toHaveLength(100); // one segment, no split
  });
});

describe('downsampleHistorySeries: gap boundaries (D-075 CollectionGap as data)', () => {
  it('splits at a gap whose edges are the adjacent points themselves', () => {
    const points = minuteSeries(200);
    const gap = { fromEpochMs: T0 + 100 * STEP_MS, toEpochMs: T0 + 101 * STEP_MS };
    const result = downsampleHistorySeries(points, 100, { gaps: [gap] });
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    // Same 101/99 segmentation as a reset at that pair: 50 + 49 buckets,
    // both segments slicing to exactly 120 000 ms (6 000 000/50 and
    // 5 880 000/49) — the multi-segment resolution is the max of the slice
    // widths.
    expect(result.buckets).toHaveLength(99);
    expect(result.resolutionMs).toBe(120_000);
    for (const bucket of result.buckets) {
      const spansGap = bucket.fromEpochMs <= gap.fromEpochMs && bucket.toEpochMs >= gap.toEpochMs;
      expect(spansGap).toBe(false);
    }
    // The pre-gap point stays the last bucket of the pre side.
    const pre = result.buckets.filter((b) => b.toEpochMs <= gap.fromEpochMs);
    expect(pre.at(-1)!.last).toBe(points[100]);
  });

  it('splits at a gap whose edges fall between the points', () => {
    const points = minuteSeries(200);
    const gap = {
      fromEpochMs: T0 + 100 * STEP_MS + 10_000,
      toEpochMs: T0 + 101 * STEP_MS - 10_000,
    };
    const result = downsampleHistorySeries(points, 100, { gaps: [gap] });
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    expect(result.buckets).toHaveLength(99);
    expect(
      result.buckets.every(
        (b) => !(b.fromEpochMs <= gap.fromEpochMs && b.toEpochMs >= gap.toEpochMs),
      ),
    ).toBe(true);
  });

  it('treats a reset and a gap between the same pair as one separation', () => {
    const points = minuteSeries(200);
    const between = T0 + 100 * STEP_MS + STEP_MS / 2;
    const result = downsampleHistorySeries(points, 100, {
      resetEvents: [{ eventAt: between }],
      gaps: [{ fromEpochMs: T0 + 100 * STEP_MS, toEpochMs: T0 + 101 * STEP_MS }],
    });
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    // Two segments, not three: the pair separates once and no empty
    // in-between segment can exist.
    expect(result.buckets).toHaveLength(99);
  });

  it('keeps a one-point segment between two adjacent separations intact', () => {
    const points = minuteSeries(200);
    const result = downsampleHistorySeries(points, 100, {
      resetEvents: [{ eventAt: T0 + 50 * STEP_MS + 1 }, { eventAt: T0 + 51 * STEP_MS + 1 }],
    });
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    const singleton = result.buckets.find(
      (b) => b.count === 1 && b.fromEpochMs === T0 + 51 * STEP_MS,
    );
    expect(singleton).toBeDefined();
    expect(singleton!.first).toBe(points[51]);
    expect(singleton!.toEpochMs - singleton!.fromEpochMs).toBe(0);
  });
});

describe('downsampleHistorySeries: degenerate and clustered series', () => {
  it('collapses a fully simultaneous overfull series into one bucket', () => {
    const points: DownsamplePoint[] = Array.from({ length: 150 }, (_, index) => ({
      collectedAt: T0,
      used: index,
    }));
    const result = downsampleHistorySeries(points, 100);
    expect(result).toEqual({
      kind: 'downsampled',
      buckets: [
        {
          fromEpochMs: T0,
          toEpochMs: T0,
          count: 150,
          first: points[0],
          last: points[149],
          min: { used: 0 },
          max: { used: 149 },
        },
      ],
      resolutionMs: 0,
    });
  });

  it('skips empty slices when the points cluster at the segment ends', () => {
    // 100 points at T0, 100 points an hour later, budget 100: the segment is
    // apportioned 100 slices of 36 s each, but only slice 0 and slice 99
    // ever receive points.
    const points: DownsamplePoint[] = [
      ...Array.from({ length: 100 }, (_, index) => ({ collectedAt: T0, used: index })),
      ...Array.from({ length: 100 }, (_, index) => ({
        collectedAt: T0 + 3_600_000,
        used: 1000 + index,
      })),
    ];
    const result = downsampleHistorySeries(points, 100);
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(200);
    // The segment was allocated 100 slices over a one-hour span: a 36-second
    // effective resolution, although every observed bucket span is 0.
    expect(result.resolutionMs).toBe(3_600_000 / 100);
  });

  it('lets the boundary structure outrank the budget (D-081 carve-out)', () => {
    // 102 points with a gap between every adjacent pair: 102 segments —
    // more than the budget of 100 — so each point keeps its own bucket and
    // the count exceeds maxPoints rather than aggregating across a gap.
    const points = minuteSeries(102);
    const gaps = points.slice(0, -1).map((point, index) => ({
      fromEpochMs: point.collectedAt,
      toEpochMs: points[index + 1]!.collectedAt,
    }));
    const result = downsampleHistorySeries(points, 100, { gaps });
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    expect(result.buckets).toHaveLength(102);
    expect(result.buckets.every((b) => b.count === 1)).toBe(true);
    expect(result.resolutionMs).toBe(0);
  });

  it('never allocates more buckets than a segment has points', () => {
    // 101 points, budget 100 → 100 buckets; the best-attended bucket holds
    // at most ⌈101/100⌉ = 2 points.
    const points = minuteSeries(101);
    const result = downsampleHistorySeries(points, 100);
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    expect(result.buckets).toHaveLength(100);
    expect(Math.max(...result.buckets.map((b) => b.count))).toBeLessThanOrEqual(2);
    expect(result.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(101);
  });
});

describe('downsampleHistorySeries: determinism and immutability', () => {
  const points = minuteSeries(220);
  const boundaries = {
    resetEvents: [{ eventAt: T0 + 150 * STEP_MS + 1 }],
    gaps: [{ fromEpochMs: T0 + 40 * STEP_MS, toEpochMs: T0 + 41 * STEP_MS }],
  };

  it('returns identical output for identical input, shuffled or not', () => {
    const sorted = downsampleHistorySeries(points, 100, boundaries);
    const again = downsampleHistorySeries(points, 100, boundaries);
    const shuffled = downsampleHistorySeries([...points].reverse(), 100, {
      ...boundaries,
      gaps: [...boundaries.gaps].reverse(),
    });
    expect(again).toEqual(sorted);
    // Distinct timestamps: reversal changes nothing.
    expect(shuffled).toEqual(sorted);
  });

  it('freezes the result, the bucket list, each bucket, and its extrema', () => {
    const result = downsampleHistorySeries(points, 100, boundaries);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind !== 'downsampled') throw new Error('expected downsampled');
    expect(Object.isFrozen(result.buckets)).toBe(true);
    expect(Object.isFrozen(result.buckets[0])).toBe(true);
    expect(Object.isFrozen(result.buckets[0]!.min)).toBe(true);
    expect(Object.isFrozen(result.buckets[0]!.max)).toBe(true);
  });

  it('leaves the caller’s input array and points untouched', () => {
    const input = [...points].reverse();
    const snapshot = input.map((p) => p.collectedAt);
    downsampleHistorySeries(input, 100, boundaries);
    expect(input.map((p) => p.collectedAt)).toEqual(snapshot);
  });
});
