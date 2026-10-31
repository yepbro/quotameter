import { describe, expect, it } from 'vitest';
import { fc } from '../helpers/property';
import {
  buildTimelineIndicators,
  type CollectionErrorIndicator,
  type CollectionRunInput,
  type StoppedServiceIndicator,
  type TimelineIndicator,
} from '../../src/services/history-timeline';
import { gapThresholdMs } from '../../src/services/history-gaps';
import { COLLECTION_OUTCOMES } from '../../src/services/polling-outcomes';

/**
 * Property-based coverage of the §12.2 timeline indicators (task 120,
 * decision D-080): over generated multi-account run histories with mixed
 * outcomes, cadences, and spacings, the error indicators are exactly the
 * failed cycles, the stopped-service regions are well-formed record-free
 * silences beyond the shared D-075 threshold, and the whole output is
 * invariant under input permutation up to the documented account-block
 * ordering. Directed coverage lives in `history-timeline.spec.ts`.
 *
 * The permutation property's one documented exception: records of one
 * account with equal `startedAt` (the generator never emits them — steps
 * are ≥ 120 000 ms) resolve by input order under the stable sort, so their
 * frontier handover is the sole permutation-sensitive case; §7.1 polls an
 * account sequentially and D-069 writes one row per executed cycle, so
 * equal cycle starts cannot be persisted.
 */

/** 2026-10-31T12:00:00Z — every generated history starts walking here. */
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

const intervalArb = fc.constantFrom(60, 300, 3600);
const outcomeArb = fc.constantFrom(...COLLECTION_OUTCOMES);

/**
 * One account's chronological history: steps keep consecutive cycles
 * non-overlapping (min 120 000 ms > max 90 000 ms duration) and span both
 * the live cadence and silences past every cadence's threshold; `at` is the
 * account id, attached by the composing generator.
 */
const historyArb = fc
  .array(
    fc.record({
      step: fc.integer({ min: 120_000, max: 20_000_000 }),
      duration: fc.integer({ min: 0, max: 90_000 }),
      interval: intervalArb,
      outcome: outcomeArb,
      attempts: fc.integer({ min: 1, max: 4 }),
    }),
    { minLength: 1, maxLength: 12 },
  )
  .map((specs) => {
    const runs: Omit<CollectionRunInput, 'accountId'>[] = [];
    let at = T0;
    for (const spec of specs) {
      at += spec.step;
      runs.push({
        startedAt: at,
        endedAt: at + spec.duration,
        intervalSeconds: spec.interval,
        outcome: spec.outcome,
        attempts: spec.attempts,
      });
    }
    return runs;
  });

/** A whole scenario: two accounts' histories, a covering range, an order. */
const scenarioArb = fc
  .record({
    aHistory: historyArb,
    bHistory: historyArb,
    leadingSlack: fc.integer({ min: 0, max: 2_000_000 }),
    trailingSlack: fc.integer({ min: 0, max: 2_000_000 }),
    aFirst: fc.boolean(),
    rotateBy: fc.nat(24),
  })
  .map(({ aHistory, bHistory, leadingSlack, trailingSlack, aFirst, rotateBy }) => {
    const a = aHistory.map((runData) => ({ ...runData, accountId: 'acc-a' }));
    const b = bHistory.map((runData) => ({ ...runData, accountId: 'acc-b' }));
    const concatenated = aFirst ? [...a, ...b] : [...b, ...a];
    const lastEnd = Math.max(...concatenated.map((run) => run.endedAt));
    return {
      a,
      b,
      runs: concatenated,
      range: { from: T0 - leadingSlack, to: lastEnd + trailingSlack },
      rotateBy,
    };
  });

/** Rotates `runs` left by `by` (mod length) — one more input permutation. */
function rotate<T>(items: readonly T[], by: number): T[] {
  if (items.length === 0) return [...items];
  const offset = by % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

/** A canonical, order-free form of an indicator list for equality checks. */
function canonical(indicators: readonly TimelineIndicator[]): string[] {
  return indicators.map((indicator) => JSON.stringify(indicator)).sort();
}

describe('buildTimelineIndicators (properties)', () => {
  it('derives exactly one typed indicator per failed cycle, whatever the mix', () => {
    let failedSeen = 0;
    fc.assert(
      fc.property(scenarioArb, ({ runs, range }) => {
        const indicators = buildTimelineIndicators(runs, range).filter(
          (indicator): indicator is CollectionErrorIndicator =>
            indicator.kind === 'collection_error',
        );
        const expected = runs
          .filter((run) => run.outcome !== 'success')
          .map((run) => [run.accountId, run.outcome, run.startedAt, run.endedAt, run.attempts]);
        failedSeen += expected.length;
        const actual = indicators.map((indicator) => [
          indicator.accountId,
          indicator.outcome,
          indicator.fromEpochMs,
          indicator.toEpochMs,
          indicator.attempts,
        ]);
        expect([...actual].sort()).toEqual([...expected].sort());
      }),
    );
    // Vacuity tripwire: the generator must actually produce failed cycles.
    expect(failedSeen).toBeGreaterThan(0);
  });

  it('derives stopped regions that are disjoint, in-range, past their threshold, and record-free', () => {
    let regionsSeen = 0;
    fc.assert(
      fc.property(scenarioArb, ({ runs, range }) => {
        const regions = buildTimelineIndicators(runs, range).filter(
          (indicator): indicator is StoppedServiceIndicator => indicator.kind === 'stopped_service',
        );
        regionsSeen += regions.length;
        let previous: StoppedServiceIndicator | undefined;
        for (const region of regions) {
          expect(region.fromEpochMs).toBeGreaterThanOrEqual(range.from);
          expect(region.toEpochMs).toBeLessThanOrEqual(range.to);
          expect(region.elapsedMs).toBe(region.toEpochMs - region.fromEpochMs);
          expect(region.elapsedMs).toBeGreaterThan(region.thresholdMs);
          expect(region.thresholdMs).toBe(gapThresholdMs(region.intervalSeconds));
          // No record of this account starts strictly inside the region —
          // a region is silence, bounded by the records around it.
          for (const run of runs) {
            if (run.accountId === region.accountId) {
              expect(run.startedAt <= region.fromEpochMs || run.startedAt >= region.toEpochMs).toBe(
                true,
              );
            }
          }
          // Within an account the output is chronological and disjoint;
          // across accounts the account blocks simply alternate in order.
          if (previous !== undefined && previous.accountId === region.accountId) {
            expect(region.fromEpochMs).toBeGreaterThanOrEqual(previous.toEpochMs);
          }
          previous = region;
        }
      }),
    );
    // Vacuity tripwire: the generator must actually produce qualifying
    // silences (steps reach 20 000 000 ms, far past every threshold).
    expect(regionsSeen).toBeGreaterThan(0);
  });

  it('is invariant under input permutation up to the account-block order', () => {
    fc.assert(
      fc.property(scenarioArb, ({ a, b, runs, range, rotateBy }) => {
        const baseline = canonical(buildTimelineIndicators(runs, range));
        const interleaved: CollectionRunInput[] = [];
        for (let index = 0; index < Math.max(a.length, b.length); index++) {
          if (a[index] !== undefined) interleaved.push(a[index]!);
          if (b[index] !== undefined) interleaved.push(b[index]!);
        }
        const variants = [
          [...runs].reverse(),
          rotate(runs, rotateBy),
          interleaved,
          rotate(interleaved, rotateBy),
        ];
        for (const variant of variants) {
          expect(canonical(buildTimelineIndicators(variant, range))).toEqual(baseline);
        }
      }),
    );
  });
});
