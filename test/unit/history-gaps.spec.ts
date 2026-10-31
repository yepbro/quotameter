import { describe, expect, it } from 'vitest';
import {
  GAP_THRESHOLD_INTERVALS,
  detectCollectionGaps,
  effectivePollingIntervalMs,
  gapThresholdMs,
  type SuccessfulMetricPoint,
} from '../../src/services/history-gaps';

/**
 * Deterministic coverage of the §12.2 gap rule (task 119, decision D-075):
 * the three-effective-interval boundary on both sides (raw 3× and the
 * jitter-expanded 3× — §7.1's up-to-10% additive jitter makes three
 * fully-stretched polls legitimate, so only elapsed times strictly beyond
 * 3 × 1.1 intervals are gaps), interval changes over time (each adjacent
 * pair judged by the interval in effect at its earlier point), the series
 * partitioning (accounts and metrics never share a gap), and the fail-fast
 * input contract. Property-based complements (jitter-bounded cadences,
 * stretched-delta placement, oracle agreement) live in
 * `history-gaps.property.spec.ts`.
 */

/** 2026-10-31T12:00:00Z — the base collection timestamp of every series. */
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

const ACCOUNT = 'zai-main';
const METRIC = 'credits_5h';

/** One successful point, defaulting to the canonical series identity. */
function point(
  collectedAt: number,
  accountId = ACCOUNT,
  metricKey = METRIC,
): SuccessfulMetricPoint {
  return { accountId, metricKey, collectedAt };
}

/** The §7.1 default interval (300 s): threshold 990 000 ms, jitter max 330 s. */
const DEFAULT_INTERVAL = 300;
const DEFAULT_THRESHOLD_MS = gapThresholdMs(DEFAULT_INTERVAL);

describe('the §12.2 threshold constants and helpers', () => {
  it('pins the three-interval count', () => {
    expect(GAP_THRESHOLD_INTERVALS).toBe(3);
  });

  it.each([
    [60, 66_000],
    [61, 67_100],
    [300, 330_000],
    [3600, 3_960_000],
  ])('expands %i s by the §7.1 jitter allowance to exactly %i ms', (seconds, effective) => {
    expect(effectivePollingIntervalMs(seconds)).toBe(effective);
  });

  it.each([
    [60, 198_000],
    [300, 990_000],
    [3600, 11_880_000],
  ])('makes the gap threshold of %i s exactly %i ms', (seconds, threshold) => {
    expect(gapThresholdMs(seconds)).toBe(threshold);
  });

  it.each([
    ['below the §7.1 floor', 59],
    ['above the §7.1 ceiling', 3601],
    ['a non-integer', 300.5],
    ['zero', 0],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s as a configured interval', (_label, seconds) => {
    expect(() => effectivePollingIntervalMs(seconds as number)).toThrow(
      'effectivePollingIntervalMs: intervalSeconds must be an integer in [60, 3600] (spec §7.1)',
    );
    expect(() => gapThresholdMs(seconds as number)).toThrow(
      'gapThresholdMs: intervalSeconds must be an integer in [60, 3600] (spec §7.1)',
    );
  });
});

describe('detectCollectionGaps: trivial series', () => {
  it('returns no gaps for an empty series', () => {
    expect(detectCollectionGaps([], DEFAULT_INTERVAL)).toEqual([]);
  });

  it('returns no gaps for a single point — a gap needs two observed edges', () => {
    expect(detectCollectionGaps([point(T0)], DEFAULT_INTERVAL)).toEqual([]);
  });
});

describe('detectCollectionGaps: the three-effective-interval boundary', () => {
  it.each([
    ['one plain interval', 300_000],
    ['one fully-jittered interval (§7.1 maximum)', 330_000],
    ['three raw intervals — below the jitter-expanded threshold', 900_000],
    ['exactly three effective intervals — the boundary, "exceeds" is strict', 990_000],
  ])('%s between two points is not a gap', (_label, deltaMs) => {
    expect(detectCollectionGaps([point(T0), point(T0 + deltaMs)], DEFAULT_INTERVAL)).toEqual([]);
  });

  it.each([
    ['one millisecond past the boundary', 990_001],
    ['a clear outage', 1_000_000],
    ['a week of silence', 604_800_000],
  ])('%s between two points is a gap', (_label, deltaMs) => {
    expect(detectCollectionGaps([point(T0), point(T0 + deltaMs)], DEFAULT_INTERVAL)).toHaveLength(
      1,
    );
  });

  it('reports the full gap record for a clear outage', () => {
    expect(detectCollectionGaps([point(T0), point(T0 + 1_000_000)], DEFAULT_INTERVAL)).toEqual([
      {
        accountId: ACCOUNT,
        metricKey: METRIC,
        fromEpochMs: T0,
        toEpochMs: T0 + 1_000_000,
        elapsedMs: 1_000_000,
        intervalSeconds: DEFAULT_INTERVAL,
        thresholdMs: DEFAULT_THRESHOLD_MS,
      },
    ]);
  });

  it('keeps the 60 s floor boundary exact: 198 000 ms is not a gap, 198 001 ms is', () => {
    expect(detectCollectionGaps([point(T0), point(T0 + 198_000)], 60)).toEqual([]);
    expect(detectCollectionGaps([point(T0), point(T0 + 198_001)], 60)).toHaveLength(1);
  });

  it('treats irregular poll times within the jitter allowance as healthy', () => {
    const deltas = [305_000, 312_345, 330_000, 300_000, 329_999, 318_500];
    let at = T0;
    const points = [point(at)];
    for (const delta of deltas) {
      at += delta;
      points.push(point(at));
    }
    expect(detectCollectionGaps(points, DEFAULT_INTERVAL)).toEqual([]);
  });

  it('finds a gap between interior points without inventing edges beyond them', () => {
    // Healthy lead-in, one outage, healthy tail: exactly one gap, whose
    // edges are the observed points around the outage — nothing before the
    // first or after the last point (§12.2 gaps live between snapshots).
    const points = [
      point(T0),
      point(T0 + 300_000),
      point(T0 + 600_000),
      point(T0 + 600_000 + 1_500_000),
      point(T0 + 600_000 + 1_800_000),
    ];
    const gaps = detectCollectionGaps(points, DEFAULT_INTERVAL);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.fromEpochMs).toBe(T0 + 600_000);
    expect(gaps[0]?.toEpochMs).toBe(T0 + 600_000 + 1_500_000);
  });
});

describe('detectCollectionGaps: interval changes over time', () => {
  /** A 300 s → 60 s shrink half an hour into the series. */
  const SHRINK_AT = T0 + 1_800_000;
  const shrunkTimeline = [
    { effectiveFromEpochMs: T0, intervalSeconds: 300 },
    { effectiveFromEpochMs: SHRINK_AT, intervalSeconds: 60 },
  ];

  it('judges every pair without an interior change by its starting interval', () => {
    // Before the change: 950 000 ms is under the 300 s threshold (990 000).
    // After the change: 198 000 ms is exactly the 60 s boundary (no gap),
    // 200 000 ms exceeds it (gap). Neither pair spans the change itself.
    const points = [
      point(T0),
      point(T0 + 300_000),
      point(T0 + 600_000),
      point(T0 + 600_000 + 950_000),
      point(SHRINK_AT + 60_000),
      point(SHRINK_AT + 258_000),
      point(SHRINK_AT + 458_000),
    ];
    const gaps = detectCollectionGaps(points, shrunkTimeline);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      fromEpochMs: SHRINK_AT + 258_000,
      toEpochMs: SHRINK_AT + 458_000,
      elapsedMs: 200_000,
      intervalSeconds: 60,
      thresholdMs: 198_000,
    });
  });

  it('judges a straddling pair by the span’s most permissive cadence (D-075)', () => {
    // Healthy 300 s cadence up to T0+1 500 000; the change lands at
    // SHRINK_AT and the next point arrives 800 000 ms after the last one.
    // The span contains the change, so the pair is judged by the widest
    // cadence it ever ran under (300 s → threshold 990 000) — not a gap —
    // even though its later point runs under 60 s, where 800 000 ms would
    // exceed the threshold: mid-span ambiguity resolves fail-safe.
    const from = SHRINK_AT - 300_000;
    const to = SHRINK_AT + 500_000;
    const points = [
      point(T0),
      point(T0 + 300_000),
      point(T0 + 600_000),
      point(T0 + 900_000),
      point(T0 + 1_200_000),
      point(from),
      point(to),
    ];
    expect(detectCollectionGaps(points, shrunkTimeline)).toEqual([]);
    expect(to - from).toBeGreaterThan(198_000); // would gap under the 60 s regime
  });

  /** A 60 s → 300 s grow ten minutes into the series (a §6.4 runtime edit). */
  const GROW_AT = T0 + 600_000;
  const growTimeline = [
    { effectiveFromEpochMs: T0, intervalSeconds: 60 },
    { effectiveFromEpochMs: GROW_AT, intervalSeconds: 300 },
  ];

  it('never flags a scheduler-producible runtime grow as a gap (D-066)', () => {
    // setIntervalMs re-anchors to `now + newInterval + jitter`: the last
    // pre-change point sits a maximally-jittered 60 s poll before the
    // change, the first post-change point a maximally-jittered 300 s poll
    // after it — a healthy series whose straddling pair spans 390 000 ms.
    // Judged by the start cadence alone (threshold 198 000) that would be a
    // false gap; the span widening (300 s → 990 000) keeps it healthy.
    const points = [
      point(T0),
      point(T0 + 60_000),
      point(T0 + 120_000),
      point(T0 + 180_000),
      point(T0 + 240_000),
      point(T0 + 300_000),
      point(T0 + 360_000),
      point(T0 + 420_000),
      point(T0 + 480_000),
      point(T0 + 540_000), // GROW_AT − 60 000
      point(GROW_AT + 330_000), // re-anchored, maximally jittered
    ];
    expect(detectCollectionGaps(points, growTimeline)).toEqual([]);
    expect(GROW_AT + 330_000 - (GROW_AT - 60_000)).toBe(390_000);
    expect(390_000).toBeGreaterThan(198_000); // the discriminant the widening defuses
  });

  it('still flags a straddling pair whose silence exceeds even the widened cadence', () => {
    // Same grow, but the next point arrives 1 100 000 ms after the change:
    // 1 160 000 ms exceeds even three effective 300 s intervals.
    const points = [
      point(T0),
      point(T0 + 60_000),
      point(T0 + 120_000),
      point(T0 + 180_000),
      point(T0 + 240_000),
      point(T0 + 300_000),
      point(T0 + 360_000),
      point(T0 + 420_000),
      point(T0 + 480_000),
      point(T0 + 540_000), // GROW_AT − 60 000
      point(GROW_AT + 1_100_000),
    ];
    const gaps = detectCollectionGaps(points, growTimeline);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      fromEpochMs: GROW_AT - 60_000,
      toEpochMs: GROW_AT + 1_100_000,
      elapsedMs: 1_160_000,
      intervalSeconds: 300, // the widened span cadence, not the 60 s start
      thresholdMs: 990_000,
    });
  });

  it('widens to the largest interval anywhere inside the span, not just the endpoints', () => {
    // The span below starts and ends under 60 s but briefly ran 3000 s in
    // between; a pure endpoint rule (max(60, 60)) would flag the 660 000 ms
    // silence against a 198 000 ms threshold — the interior change governs
    // the widening.
    const interiorGrowTimeline = [
      { effectiveFromEpochMs: T0, intervalSeconds: 60 },
      { effectiveFromEpochMs: T0 + 600_000, intervalSeconds: 3000 },
      { effectiveFromEpochMs: T0 + 900_000, intervalSeconds: 60 },
    ];
    const points = [
      point(T0),
      point(T0 + 60_000),
      point(T0 + 120_000),
      point(T0 + 180_000),
      point(T0 + 240_000),
      point(T0 + 300_000),
      point(T0 + 360_000),
      point(T0 + 420_000),
      point(T0 + 480_000),
      point(T0 + 540_000),
      point(T0 + 1_200_000),
    ];
    expect(detectCollectionGaps(points, interiorGrowTimeline)).toEqual([]);
    expect(T0 + 1_200_000 - (T0 + 540_000)).toBeGreaterThan(198_000); // endpoint rule would gap
  });

  it('applies a change exactly at a point timestamp to that point', () => {
    // The point at SHRINK_AT resolves the new 60 s interval, so the 200 000
    // ms pair it starts is a gap.
    const points = [point(SHRINK_AT - 300_000), point(SHRINK_AT), point(SHRINK_AT + 200_000)];
    const gaps = detectCollectionGaps(points, shrunkTimeline);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.intervalSeconds).toBe(60);
  });

  it('treats a constant as a one-entry timeline in effect everywhere', () => {
    const points = [point(T0), point(T0 + 300_000), point(T0 + 1_300_000)];
    expect(detectCollectionGaps(points, DEFAULT_INTERVAL)).toEqual(
      detectCollectionGaps(points, [{ effectiveFromEpochMs: T0 - 1, intervalSeconds: 300 }]),
    );
  });

  it('accepts an unsorted timeline', () => {
    const points = [point(T0), point(T0 + 300_000), point(T0 + 1_300_000)];
    const sorted = [
      { effectiveFromEpochMs: T0 - 86_400_000, intervalSeconds: 300 },
      { effectiveFromEpochMs: T0 + 43_200_000, intervalSeconds: 600 },
    ];
    expect(detectCollectionGaps(points, [...sorted].reverse())).toEqual(
      detectCollectionGaps(points, sorted),
    );
  });

  it('rejects a point older than the timeline coverage', () => {
    expect(() => detectCollectionGaps([point(T0 - 1)], shrunkTimeline)).toThrow(
      `detectCollectionGaps: no interval in effect at ${T0 - 1} (the timeline starts at ${T0}); supply interval changes covering every point`,
    );
  });
});

describe('detectCollectionGaps: series partitioning and order', () => {
  const OTHER_ACCOUNT = 'zai-backup';
  const OTHER_METRIC = 'requests_day';

  it('keeps accounts and metrics separate in interleaved input', () => {
    // Only zai-main/credits_5h has an outage; the same metric key under
    // another account and other metrics under this account stay healthy.
    const points = [
      point(T0, ACCOUNT, METRIC),
      point(T0 + 300_000, OTHER_ACCOUNT, METRIC),
      point(T0 + 305_000, ACCOUNT, OTHER_METRIC),
      point(T0 + 1_305_000, ACCOUNT, METRIC), // the outage: 1 305 000 ms
      point(T0 + 600_000, OTHER_ACCOUNT, METRIC),
      point(T0 + 610_000, ACCOUNT, OTHER_METRIC),
    ];
    const gaps = detectCollectionGaps(points, DEFAULT_INTERVAL);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      accountId: ACCOUNT,
      metricKey: METRIC,
      fromEpochMs: T0,
      toEpochMs: T0 + 1_305_000,
      elapsedMs: 1_305_000,
    });
  });

  it('orders gaps by account first appearance, then metric, then time', () => {
    const points = [
      point(T0, OTHER_ACCOUNT, METRIC), // second account appears first
      point(T0, ACCOUNT, OTHER_METRIC),
      point(T0 + 1_300_000, ACCOUNT, OTHER_METRIC),
      point(T0 + 2_600_000, ACCOUNT, OTHER_METRIC), // two gaps in a row
      point(T0, ACCOUNT, METRIC),
      point(T0 + 1_300_000, ACCOUNT, METRIC),
      point(T0 + 1_300_000, OTHER_ACCOUNT, METRIC),
    ];
    const gaps = detectCollectionGaps(points, DEFAULT_INTERVAL);
    expect(gaps.map((gap) => [gap.accountId, gap.metricKey, gap.fromEpochMs])).toEqual([
      [OTHER_ACCOUNT, METRIC, T0],
      [ACCOUNT, OTHER_METRIC, T0],
      [ACCOUNT, OTHER_METRIC, T0 + 1_300_000],
      [ACCOUNT, METRIC, T0],
    ]);
  });

  it('sorts an unsorted input series before comparing', () => {
    const scrambled = [point(T0 + 300_000), point(T0 + 1_700_000), point(T0), point(T0 + 600_000)];
    const chronological = [
      point(T0),
      point(T0 + 300_000),
      point(T0 + 600_000),
      point(T0 + 1_700_000),
    ];
    // The scrambled and chronological inputs produce the same single gap
    // (the 1 100 000 ms final delta) — the comparison is non-vacuous.
    expect(detectCollectionGaps(scrambled, DEFAULT_INTERVAL)).toEqual(
      detectCollectionGaps(chronological, DEFAULT_INTERVAL),
    );
    expect(detectCollectionGaps(scrambled, DEFAULT_INTERVAL)).toHaveLength(1);
  });

  it('never treats duplicate timestamps as a gap', () => {
    const points = [point(T0), point(T0), point(T0 + 300_000), point(T0 + 300_000)];
    expect(detectCollectionGaps(points, DEFAULT_INTERVAL)).toEqual([]);
  });
});

describe('detectCollectionGaps: fail-fast validation', () => {
  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an object', { collectedAt: T0 }],
  ])('rejects points that are %s', (_label, badPoints) => {
    expect(() =>
      detectCollectionGaps(
        badPoints as unknown as readonly SuccessfulMetricPoint[],
        DEFAULT_INTERVAL,
      ),
    ).toThrow('detectCollectionGaps: points must be an array of SuccessfulMetricPoint');
  });

  it('names the offending point index and field', () => {
    expect(() =>
      detectCollectionGaps([point(T0), 'x' as unknown as SuccessfulMetricPoint], 300),
    ).toThrow('detectCollectionGaps: points[1] must be a SuccessfulMetricPoint');
    expect(() => detectCollectionGaps([point(T0, '')], 300)).toThrow(
      'detectCollectionGaps: points[0].accountId must be a non-blank string',
    );
    expect(() => detectCollectionGaps([point(T0, ACCOUNT, '  ')], 300)).toThrow(
      'detectCollectionGaps: points[0].metricKey must be a non-blank string',
    );
    expect(() => detectCollectionGaps([point(Number.NaN)], 300)).toThrow(
      'detectCollectionGaps: points[0].collectedAt must be a finite UTC epoch-milliseconds timestamp',
    );
    expect(() => detectCollectionGaps([point(Number.POSITIVE_INFINITY)], 300)).toThrow(
      'detectCollectionGaps: points[0].collectedAt must be a finite UTC epoch-milliseconds timestamp',
    );
  });

  it('rejects an interval source that is neither a number nor an array', () => {
    expect(() => detectCollectionGaps([point(T0)], '300' as unknown as number)).toThrow(
      'detectCollectionGaps: intervalSource must be a number or an array of IntervalChange',
    );
  });

  it.each([
    ['below the §7.1 floor', 59],
    ['above the §7.1 ceiling', 3601],
    ['a non-integer', 300.5],
    ['zero', 0],
    ['negative', -300],
    ['NaN', Number.NaN],
  ])('rejects a constant interval that is %s', (_label, seconds) => {
    expect(() => detectCollectionGaps([point(T0)], seconds as number)).toThrow(
      'detectCollectionGaps: intervalSeconds must be an integer in [60, 3600] (spec §7.1)',
    );
  });

  it('rejects an empty timeline', () => {
    expect(() => detectCollectionGaps([point(T0)], [])).toThrow(
      'detectCollectionGaps: the interval timeline must not be empty',
    );
  });

  it('names the offending timeline entry and field', () => {
    expect(() => detectCollectionGaps([point(T0)], ['x' as unknown as never])).toThrow(
      'detectCollectionGaps: intervals[0] must be an IntervalChange',
    );
    expect(() =>
      detectCollectionGaps(
        [point(T0)],
        [{ effectiveFromEpochMs: Number.NaN, intervalSeconds: 300 }],
      ),
    ).toThrow(
      'detectCollectionGaps: intervals[0].effectiveFromEpochMs must be a finite UTC epoch-milliseconds timestamp',
    );
    expect(() =>
      detectCollectionGaps(
        [point(T0)],
        [
          { effectiveFromEpochMs: T0, intervalSeconds: 300 },
          { effectiveFromEpochMs: T0 + 1, intervalSeconds: 3601 },
        ],
      ),
    ).toThrow(
      'detectCollectionGaps intervals[1]: intervalSeconds must be an integer in [60, 3600] (spec §7.1)',
    );
  });

  it('rejects duplicate timeline timestamps — ambiguous history', () => {
    expect(() =>
      detectCollectionGaps(
        [point(T0)],
        [
          { effectiveFromEpochMs: T0 + 60_000, intervalSeconds: 300 },
          { effectiveFromEpochMs: T0, intervalSeconds: 600 },
          { effectiveFromEpochMs: T0 + 60_000, intervalSeconds: 60 },
        ],
      ),
    ).toThrow(
      'detectCollectionGaps: intervals must have unique effectiveFromEpochMs (spec §7.1 interval changes)',
    );
  });
});
