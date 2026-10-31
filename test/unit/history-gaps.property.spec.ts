import { describe, expect, it } from 'vitest';
import { fc } from '../helpers/property';
import {
  detectCollectionGaps,
  effectivePollingIntervalMs,
  gapThresholdMs,
  type CollectionGap,
  type SuccessfulMetricPoint,
} from '../../src/services/history-gaps';
import { POLLING_JITTER_FRACTION } from '../../src/services/polling-scheduler';

/**
 * Property-based coverage of the §12.2 gap rule (task 119, decision D-075),
 * the standing complement to `history-gaps.spec.ts` (task 124 will extend
 * this suite): a cadence the §7.1 scheduler can actually produce — every
 * inter-poll delay inside the additive jitter bounds of `pollingDelayMs`
 * (D-066) — never yields a gap at any §7.1 interval; a single stretched
 * delta yields exactly one gap at exactly that pair; the threshold boundary
 * is exact at every §7.1 interval; and over arbitrary multi-series input
 * the detector agrees with a direct oracle (sort each series, flag adjacent
 * pairs whose delta strictly exceeds three jitter-expanded intervals)
 * regardless of input order.
 */

/** 2026-10-31T12:00:00Z — the base collection timestamp of every series. */
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

/** Any §7.1-valid configured interval, in seconds. */
const intervalSecondsArb = fc.integer({ min: 60, max: 3600 });

/**
 * Per-poll jitter in whole units of `intervalSeconds` milliseconds: a delay
 * of `intervalSeconds * 1000 + units * intervalSeconds` lies exactly inside
 * `pollingDelayMs`'s realized range `[interval, interval +
 * floor(interval × POLLING_JITTER_FRACTION)]`, both ends included — units
 * 0 is the plain interval, units 100 the fully-jittered one.
 */
const jitterUnitsArb = fc.array(fc.integer({ min: 0, max: 100 }), {
  minLength: 1,
  maxLength: 40,
});

/** One series of successful points for the canonical identity. */
function seriesFromDeltas(deltas: readonly number[]): SuccessfulMetricPoint[] {
  const points: SuccessfulMetricPoint[] = [];
  let collectedAt = T0;
  for (const delta of deltas) {
    points.push({ accountId: 'zai-main', metricKey: 'credits_5h', collectedAt });
    collectedAt += delta;
  }
  points.push({ accountId: 'zai-main', metricKey: 'credits_5h', collectedAt });
  return points;
}

describe('effective interval arithmetic stays exact', () => {
  it('is the integer interval-plus-jitter expansion at every §7.1 interval', () => {
    fc.assert(
      fc.property(intervalSecondsArb, (intervalSeconds) => {
        // 1000 ms + 100 ms of §7.1 allowance per configured second: integer
        // arithmetic, no float drift at the boundary. A non-integral
        // POLLING_JITTER_FRACTION would break this pin and must force the
        // arithmetic to be revisited.
        expect(effectivePollingIntervalMs(intervalSeconds)).toBe(intervalSeconds * 1100);
        expect(gapThresholdMs(intervalSeconds)).toBe(intervalSeconds * 3300);
        expect(Number.isInteger(gapThresholdMs(intervalSeconds))).toBe(true);
      }),
    );
  });

  it('never undercounts the scheduler’s maximum realized delay', () => {
    fc.assert(
      fc.property(intervalSecondsArb, (intervalSeconds) => {
        const maxDelayMs =
          intervalSeconds * 1000 + Math.floor(intervalSeconds * 1000 * POLLING_JITTER_FRACTION);
        expect(effectivePollingIntervalMs(intervalSeconds)).toBeGreaterThanOrEqual(maxDelayMs);
      }),
    );
  });
});

describe('a scheduler-producible cadence never gaps', () => {
  it('flags nothing for any delay sequence inside the §7.1 jitter bounds', () => {
    fc.assert(
      fc.property(intervalSecondsArb, jitterUnitsArb, (intervalSeconds, jitterUnits) => {
        const deltas = jitterUnits.map((units) => intervalSeconds * 1000 + units * intervalSeconds);
        expect(detectCollectionGaps(seriesFromDeltas(deltas), intervalSeconds)).toEqual([]);
      }),
    );
  });
});

describe('one stretched delta is exactly one gap', () => {
  it('places the gap at the stretched pair with exact fields', () => {
    fc.assert(
      fc.property(
        intervalSecondsArb,
        jitterUnitsArb,
        fc.integer({ min: 0, max: 39 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (intervalSeconds, jitterUnits, holeIndex, extraMs) => {
          const thresholdMs = gapThresholdMs(intervalSeconds);
          const deltas = jitterUnits.map(
            (units) => intervalSeconds * 1000 + units * intervalSeconds,
          );
          const hole = holeIndex % deltas.length;
          deltas[hole] = thresholdMs + extraMs;
          const points = seriesFromDeltas(deltas);
          const gaps = detectCollectionGaps(points, intervalSeconds);
          expect(gaps).toHaveLength(1);
          expect(gaps[0]).toMatchObject({
            accountId: 'zai-main',
            metricKey: 'credits_5h',
            fromEpochMs: points[hole]?.collectedAt,
            toEpochMs: points[hole + 1]?.collectedAt,
            elapsedMs: thresholdMs + extraMs,
            intervalSeconds,
            thresholdMs,
          });
        },
      ),
    );
  });

  it('holds the boundary at every §7.1 interval: exact threshold no gap, +1 ms gap', () => {
    fc.assert(
      fc.property(intervalSecondsArb, (intervalSeconds) => {
        const thresholdMs = gapThresholdMs(intervalSeconds);
        const at = (delta: number) =>
          detectCollectionGaps(
            [
              { accountId: 'a', metricKey: 'm', collectedAt: T0 },
              { accountId: 'a', metricKey: 'm', collectedAt: T0 + delta },
            ],
            intervalSeconds,
          );
        expect(at(thresholdMs)).toEqual([]);
        expect(at(thresholdMs + 1)).toHaveLength(1);
      }),
    );
  });
});

describe('a scheduler-producible runtime interval change never gaps', () => {
  it('keeps the straddling pair healthy for any grow or shrink', () => {
    fc.assert(
      fc.property(
        intervalSecondsArb,
        intervalSecondsArb,
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (oldSeconds, newSeconds, leadUnits, beforeUnits, afterUnits) => {
          // D-066's setIntervalMs re-anchor: the last pre-change point sits
          // a maximally-jittered old-interval poll before the change, the
          // first post-change point a maximally-jittered new-interval poll
          // after it. The straddling span is at most 1.1×(old + new) while
          // the span widening judges it by 3 × 1.1 × max(old, new) ≥
          // 2.2 × max(old, new) ≥ that span — a healthy grow or shrink
          // never mints a gap.
          const changeAt = T0 + 10 * oldSeconds * 1000;
          const prevBefore = changeAt - 2 * oldSeconds * 1000 - leadUnits * oldSeconds;
          const lastBefore = changeAt - (oldSeconds * 1000 + beforeUnits * oldSeconds);
          const firstAfter = changeAt + newSeconds * 1000 + afterUnits * newSeconds;
          const points: SuccessfulMetricPoint[] = [
            { accountId: 'zai-main', metricKey: 'credits_5h', collectedAt: prevBefore },
            { accountId: 'zai-main', metricKey: 'credits_5h', collectedAt: lastBefore },
            { accountId: 'zai-main', metricKey: 'credits_5h', collectedAt: firstAfter },
          ];
          const timeline = [
            { effectiveFromEpochMs: T0, intervalSeconds: oldSeconds },
            { effectiveFromEpochMs: changeAt, intervalSeconds: newSeconds },
          ];
          expect(detectCollectionGaps(points, timeline)).toEqual([]);
          expect(prevBefore).toBeGreaterThan(T0); // non-vacuous: real covered points
          expect(firstAfter - lastBefore).toBeGreaterThanOrEqual((oldSeconds + newSeconds) * 1000);
        },
      ),
    );
  });
});

describe('arbitrary multi-series input agrees with the oracle', () => {
  /** Arbitrary, unsorted, possibly duplicate timestamps for one series. */
  const timestampsArb = fc.array(fc.integer({ min: 0, max: 1_000_000_000 }), {
    minLength: 0,
    maxLength: 30,
  });

  /** One series identity paired with its (arbitrary) timestamps. */
  const seriesArb = fc.tuple(timestampsArb, timestampsArb, timestampsArb).map(
    ([mainMetric, mainOther, backupMetric]) =>
      [
        { accountId: 'zai-main', metricKey: 'credits_5h', timestamps: mainMetric },
        { accountId: 'zai-main', metricKey: 'requests_day', timestamps: mainOther },
        { accountId: 'zai-backup', metricKey: 'credits_5h', timestamps: backupMetric },
      ] as const,
  );

  /**
   * The oracle: sort each series, flag adjacent pairs strictly past
   * 3 × jitter-expanded intervals (`intervalSeconds × 3300` ms).
   */
  function oracleGaps(
    series: ReadonlyArray<{
      readonly accountId: string;
      readonly metricKey: string;
      readonly timestamps: readonly number[];
    }>,
    intervalSeconds: number,
  ): CollectionGap[] {
    const thresholdMs = intervalSeconds * 3300;
    const gaps: CollectionGap[] = [];
    for (const entry of series) {
      const ordered = [...entry.timestamps].sort((a, b) => a - b);
      let fromAt: number | undefined;
      for (const toAt of ordered) {
        if (fromAt !== undefined && toAt - fromAt > thresholdMs) {
          gaps.push({
            accountId: entry.accountId,
            metricKey: entry.metricKey,
            fromEpochMs: T0 + fromAt,
            toEpochMs: T0 + toAt,
            elapsedMs: toAt - fromAt,
            intervalSeconds,
            thresholdMs,
          });
        }
        fromAt = toAt;
      }
    }
    return gaps;
  }

  /** Order-insensitive comparison key for a gap list. */
  function canonical(gaps: readonly CollectionGap[]): CollectionGap[] {
    return [...gaps].sort((a, b) =>
      `${a.accountId}/${a.metricKey}/${a.fromEpochMs}/${a.toEpochMs}`.localeCompare(
        `${b.accountId}/${b.metricKey}/${b.fromEpochMs}/${b.toEpochMs}`,
      ),
    );
  }

  it('detects exactly the oracle gaps, independent of input order', () => {
    fc.assert(
      fc.property(intervalSecondsArb, seriesArb, (intervalSeconds, series) => {
        const points: SuccessfulMetricPoint[] = [];
        // Round-robin interleave keeps every series represented in turn;
        // the detector's own grouping/sorting must make order irrelevant.
        for (let index = 0; series.some((entry) => index < entry.timestamps.length); index++) {
          for (const entry of series) {
            const at = entry.timestamps[index];
            if (at !== undefined) {
              points.push({
                accountId: entry.accountId,
                metricKey: entry.metricKey,
                collectedAt: T0 + at,
              });
            }
          }
        }
        const expected = canonical(oracleGaps(series, intervalSeconds));
        expect(canonical(detectCollectionGaps(points, intervalSeconds))).toEqual(expected);
        expect(canonical(detectCollectionGaps([...points].reverse(), intervalSeconds))).toEqual(
          expected,
        );
      }),
    );
  });
});
