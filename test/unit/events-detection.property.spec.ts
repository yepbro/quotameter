import { describe, expect, it } from 'vitest';
import { fc } from '../helpers/property';
import {
  detectResetEvent,
  detectSeriesResetEvents,
  ROLLING_WINDOW_NOTE,
  type ResetEvent,
  type ResetPointInput,
} from '../../src/services/events-detection';

/**
 * Standing properties over the §12.1 detector (task 117, decision D-074).
 * The heart is the done-condition as a proof: no rolling-window value
 * transition — however drastic — records an event without the declaration
 * condition, while a fixed-period quota records exactly the spec's event
 * for genuine usage drops and never for monotone usage. The fold property
 * checks grouping, validity skipping, and ordering against an independent
 * group-first oracle. Task 124 extends this suite with generated sequences
 * for the downsampling and gap rules.
 */

/** A collection time; the series under test is otherwise arbitrary. */
const T0 = 1_700_000_000_000;

/** An absolute quota value the provider could report. */
const absolute = fc.integer({ min: 0, max: 1_000_000 });

/** A percentage the provider could report (integers, D-047). */
const percent = fc.integer({ min: 0, max: 100 });

/** An optional-field generator that yields `undefined` for absence. */
const maybe = (arb: fc.Arbitrary<number>) => fc.option(arb, { nil: undefined });

/** A valid fixed-period point with exactly the supplied value fields. */
function fixedPoint(values: {
  collectedAt: number;
  used?: number;
  remaining?: number;
  percentUsed?: number;
  percentRemaining?: number;
  resetsAt?: number;
}): ResetPointInput {
  return {
    accountId: 'acct',
    metricKey: 'mcp-monthly',
    limitType: 'MONTHLY',
    unit: 'REQUESTS',
    isValid: true,
    ...values,
  };
}

/** A valid rolling-window point with exactly the supplied value fields. */
function rollingPoint(values: {
  collectedAt: number;
  used?: number;
  remaining?: number;
  percentUsed?: number;
  percentRemaining?: number;
  resetsAt?: number;
}): ResetPointInput {
  return {
    accountId: 'acct',
    metricKey: 'tokens-5h',
    limitType: 'ROLLING_WINDOW',
    unit: 'PERCENT',
    isValid: true,
    ...values,
  };
}

describe('fixed-period quotas (property)', () => {
  it('never records an event while usage is monotone', () => {
    fc.assert(
      fc.property(
        absolute,
        absolute,
        percent,
        fc.integer({ min: 1, max: 3_600_000 }),
        (used, remaining, percentUsed, gap) => {
          const previous = fixedPoint({
            collectedAt: T0,
            used,
            remaining,
            percentUsed,
            percentRemaining: 100 - percentUsed,
          });
          const current = fixedPoint({
            collectedAt: T0 + gap,
            used: used + 1, // usage only grows…
            remaining: Math.max(0, remaining - 1), // …and remaining only shrinks
            percentUsed: Math.min(100, percentUsed + 1),
            percentRemaining: Math.max(0, 100 - percentUsed - 1),
          });
          expect(detectResetEvent(previous, current)).toBeUndefined();
        },
      ),
    );
  });

  it('records exactly one event for every strict usage decrease', () => {
    const usedAndSmaller = absolute
      .filter((used) => used >= 1)
      .chain((used) => fc.tuple(fc.constant(used), fc.integer({ min: 0, max: used - 1 })));
    fc.assert(
      fc.property(
        usedAndSmaller,
        fc.integer({ min: 1, max: 3_600_000 }),
        ([used, currentUsed], gap) => {
          const previous = fixedPoint({ collectedAt: T0, used });
          const current = fixedPoint({ collectedAt: T0 + gap, used: currentUsed });
          const event = detectResetEvent(previous, current);
          expect(event).toBeDefined();
          expect(event?.metricKey).toBe('mcp-monthly');
          expect(event?.eventType).toBe('RESET');
          expect(event?.details.reason).toBe('usage_decreased');
          expect(event?.eventAt).toBe(T0 + gap);
          expect(event?.details.eventTimeSource).toBe('current_collected_at');
          // Deterministic: the same comparison yields the same event.
          expect(detectResetEvent(previous, current)).toEqual(event);
        },
      ),
    );
  });
});

describe('rolling windows (property — the done-condition)', () => {
  it('records nothing for arbitrary value transitions without declaration evidence', () => {
    fc.assert(
      fc.property(
        absolute,
        absolute,
        percent,
        percent,
        fc.integer({ min: 1, max: 3_600_000 }),
        fc.constantFrom(
          'both-absent' as const,
          'previous-absent' as const,
          'current-absent' as const,
          'equal' as const,
          'earlier' as const,
          'not-passed' as const,
        ),
        (used, remaining, percentUsed, percentRemaining, gap, resetsAtShape) => {
          const t1 = T0 + gap;
          let previousResetsAt: number | undefined;
          let currentResetsAt: number | undefined;
          switch (resetsAtShape) {
            case 'both-absent':
              break;
            case 'previous-absent':
              currentResetsAt = t1 + 60_000;
              break;
            case 'current-absent':
              previousResetsAt = T0 + 60_000;
              break;
            case 'equal':
              previousResetsAt = T0 + 60_000;
              currentResetsAt = previousResetsAt;
              break;
            case 'earlier':
              previousResetsAt = t1 + 60_000;
              currentResetsAt = previousResetsAt - 1;
              break;
            case 'not-passed':
              previousResetsAt = t1 + 1; // still ahead of the new snapshot
              currentResetsAt = previousResetsAt + 3_600_000;
              break;
          }
          // Any value movement — down to a full drop to zero — is ambiguous
          // for a replenishing window and must not record an event.
          expect(
            detectResetEvent(
              rollingPoint({
                collectedAt: T0,
                used,
                remaining,
                percentUsed,
                percentRemaining,
                resetsAt: previousResetsAt,
              }),
              rollingPoint({
                collectedAt: t1,
                used: 0,
                remaining,
                percentUsed: 0,
                percentRemaining,
                resetsAt: currentResetsAt,
              }),
            ),
          ).toBeUndefined();
        },
      ),
    );
  });

  it('records the declaration event whenever condition 2 holds, with the spec event time', () => {
    fc.assert(
      fc.property(
        absolute,
        percent,
        fc.integer({ min: 1, max: 3_600_000 }), // gap between the snapshots
        fc.integer({ min: 1, max: 3_600_000 }), // where the declaration sits inside the gap
        fc.integer({ min: 1, max: 3_600_000 }), // how much later the new declaration is
        (used, percentUsed, gap, offset, later) => {
          const t1 = T0 + gap;
          const resetsAt = T0 + ((offset - 1) % gap) + 1; // strictly inside (T0, t1]
          const previous = rollingPoint({ collectedAt: T0, used, percentUsed, resetsAt });
          const current = rollingPoint({
            collectedAt: t1,
            used: 0, // value evidence exists but is inadmissible
            percentUsed: 0,
            resetsAt: resetsAt + later,
          });
          const event = detectResetEvent(previous, current);
          expect(event?.details.reason).toBe(`resets_at_advanced+${ROLLING_WINDOW_NOTE}`);
          expect(event?.eventAt).toBe(resetsAt);
          expect(event?.details.eventTimeSource).toBe('previous_resets_at');
        },
      ),
    );
  });

  it('stamps a stale declaration (passed before the previous snapshot) with the new collection time', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3_600_000 }),
        fc.integer({ min: 1, max: 3_600_000 }),
        fc.integer({ min: 1, max: 3_600_000 }),
        (gap, stale, later) => {
          const t1 = T0 + gap;
          const previous = rollingPoint({
            collectedAt: T0,
            resetsAt: T0 - stale, // already passed at the previous snapshot
          });
          const current = rollingPoint({
            collectedAt: t1,
            resetsAt: T0 - stale + later,
          });
          const event = detectResetEvent(previous, current);
          expect(event?.details.reason).toBe(`resets_at_advanced+${ROLLING_WINDOW_NOTE}`);
          expect(event?.eventAt).toBe(t1);
          expect(event?.details.eventTimeSource).toBe('current_collected_at');
        },
      ),
    );
  });
});

describe('the series fold (property)', () => {
  /** One generated point: series identity, time increment, validity, values. */
  interface PointSpec {
    accountId: 'acct-1' | 'acct-2';
    metricKey: 'a' | 'b' | 'c';
    gapMs: number;
    isValid: boolean;
    used: number | undefined;
    remaining: number | undefined;
    percentUsed: number | undefined;
    percentRemaining: number | undefined;
    resetsAtOffset: number | undefined;
  }

  const pointSpec: fc.Arbitrary<PointSpec> = fc.record({
    accountId: fc.constantFrom('acct-1', 'acct-2'),
    metricKey: fc.constantFrom('a', 'b', 'c'),
    gapMs: fc.integer({ min: 0, max: 600_000 }),
    isValid: fc.boolean(),
    used: maybe(absolute),
    remaining: maybe(absolute),
    percentUsed: maybe(percent),
    percentRemaining: maybe(percent),
    resetsAtOffset: maybe(fc.integer({ min: -3_600_000, max: 3_600_000 })),
  });

  /** Fixed series identities: two fixed-period keys and one rolling key. */
  const SERIES: Readonly<Record<'a' | 'b' | 'c', Pick<ResetPointInput, 'limitType' | 'unit'>>> = {
    a: { limitType: 'MONTHLY', unit: 'REQUESTS' },
    b: { limitType: 'ROLLING_WINDOW', unit: 'PERCENT' },
    c: { limitType: 'WEEKLY', unit: 'CREDITS' },
  };

  /** Materializes generated specs into points with running timestamps. */
  function materialize(specs: ReadonlyArray<PointSpec>): ResetPointInput[] {
    let collectedAt = T0;
    return specs.map((spec) => {
      collectedAt += spec.gapMs;
      const identity = SERIES[spec.metricKey];
      return {
        accountId: spec.accountId,
        metricKey: spec.metricKey,
        collectedAt,
        limitType: identity.limitType,
        unit: identity.unit,
        isValid: spec.isValid,
        used: spec.used,
        remaining: spec.remaining,
        percentUsed: spec.percentUsed,
        percentRemaining: spec.percentRemaining,
        resetsAt: spec.resetsAtOffset === undefined ? undefined : collectedAt + spec.resetsAtOffset,
      };
    });
  }

  /**
   * Event identity for comparison: at most one event per current point, so
   * (current.collectedAt, metricKey) is a total, unique sort key — equal
   * keys can only occur inside one series, where both the implementation
   * and the oracle preserve input order.
   */
  function byIdentity(events: ReadonlyArray<ResetEvent>): ResetEvent[] {
    return [...events].sort(
      (left, right) =>
        left.details.current.collectedAt - right.details.current.collectedAt ||
        (left.metricKey < right.metricKey ? -1 : left.metricKey > right.metricKey ? 1 : 0),
    );
  }

  it('equals a group-first oracle: per account and metric, consecutive valid pairs', () => {
    fc.assert(
      fc.property(fc.array(pointSpec, { minLength: 0, maxLength: 40 }), (specs) => {
        const points = materialize(specs);
        // Independent oracle: group valid points by (account, metric) first,
        // then compare consecutive group members — no shared fold state
        // with the implementation's single-pass last-valid-point map.
        const oracle: ResetEvent[] = [];
        const bySeries = new Map<string, ResetPointInput[]>();
        for (const p of points) {
          if (!p.isValid) continue;
          const key = `${p.accountId}/${p.metricKey}`;
          const series = bySeries.get(key) ?? [];
          series.push(p);
          bySeries.set(key, series);
        }
        for (const series of bySeries.values()) {
          for (let index = 1; index < series.length; index += 1) {
            const event = detectResetEvent(series[index - 1]!, series[index]!);
            if (event !== undefined) oracle.push(event);
          }
        }
        expect(byIdentity(detectSeriesResetEvents(points))).toEqual(byIdentity(oracle));
      }),
    );
  });
});
