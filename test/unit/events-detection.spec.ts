import { describe, expect, it } from 'vitest';
import type { CycleEventInput } from '../../src/storage/collection-cycles';
import {
  ABSOLUTE_TOLERANCE,
  detectResetEvent,
  detectSeriesResetEvents,
  PERCENT_TOLERANCE,
  RESET_SIGNAL_CODES,
  ROLLING_WINDOW_NOTE,
  type ResetEvent,
  type ResetPointInput,
} from '../../src/services/events-detection';

/**
 * The §12.1 detection matrix (task 117, decision D-074): both conditions,
 * the conservative rolling-window rules, every ambiguity suppression, the
 * caller-contract guards, the evidence shape, and the series fold — the
 * done-condition ("ambiguous rolling-window transitions do not generate
 * reset events") made executable from both sides: the ambiguous shapes
 * record nothing, the unambiguous ones record exactly the spec's event.
 */

/** A collection time; snapshots are five minutes apart unless stated. */
const T0 = 1_700_000_000_000;
const T1 = T0 + 300_000;

/** A valid point of the default fixed-period series under test. */
function point(overrides: Partial<ResetPointInput> = {}): ResetPointInput {
  return {
    accountId: 'acct',
    metricKey: 'mcp-monthly',
    collectedAt: T0,
    limitType: 'MONTHLY',
    unit: 'REQUESTS',
    isValid: true,
    used: 500,
    remaining: 1500,
    resetsAt: T0 + 86_400_000,
    ...overrides,
  };
}

/** A valid rolling-window point (the Z.ai `tokens-5h` shape: percentages only). */
function rollingPoint(overrides: Partial<ResetPointInput> = {}): ResetPointInput {
  return {
    accountId: 'acct',
    metricKey: 'tokens-5h',
    collectedAt: T0,
    limitType: 'ROLLING_WINDOW',
    unit: 'PERCENT',
    isValid: true,
    percentUsed: 80,
    percentRemaining: 20,
    resetsAt: T0 + 3_600_000,
    ...overrides,
  };
}

describe('detectResetEvent: condition 1 (values beyond tolerance)', () => {
  it('records a usage decrease with the new collection time', () => {
    const event = detectResetEvent(point(), point({ collectedAt: T1, used: 100, remaining: 1900 }));
    expect(event).toEqual({
      metricKey: 'mcp-monthly',
      eventType: 'RESET',
      eventAt: T1,
      details: {
        reason: 'usage_decreased+remaining_increased',
        previous: {
          collectedAt: T0,
          used: 500,
          remaining: 1500,
          resetsAt: T0 + 86_400_000,
        },
        current: { collectedAt: T1, used: 100, remaining: 1900, resetsAt: T0 + 86_400_000 },
        tolerance: { absolute: ABSOLUTE_TOLERANCE, percent: PERCENT_TOLERANCE },
        eventTimeSource: 'current_collected_at',
      },
    });
  });

  it('records a remaining increase when usage evidence is absent', () => {
    const previous = point({ used: undefined, remaining: 100, percentUsed: undefined });
    const current = point({
      collectedAt: T1,
      used: undefined,
      remaining: 400,
      percentUsed: undefined,
    });
    expect(detectResetEvent(previous, current)?.details.reason).toBe('remaining_increased');
  });

  it('records a percentage decrease on a percent-only metric with both percent signals', () => {
    const previous = point({
      metricKey: 'weekly-quota',
      limitType: 'WEEKLY',
      unit: 'PERCENT',
      used: undefined,
      remaining: undefined,
      percentUsed: 30,
      percentRemaining: 70,
    });
    const current = point({
      metricKey: 'weekly-quota',
      limitType: 'WEEKLY',
      unit: 'PERCENT',
      collectedAt: T1,
      used: undefined,
      remaining: undefined,
      percentUsed: 20,
      percentRemaining: 80,
    });
    const event = detectResetEvent(previous, current);
    expect(event?.metricKey).toBe('weekly-quota');
    expect(event?.details.reason).toBe('usage_decreased+remaining_increased');
  });

  it('records nothing for equal values', () => {
    expect(detectResetEvent(point(), point({ collectedAt: T1 }))).toBeUndefined();
  });

  it('records nothing for a one-point percentage move (rounding tolerance)', () => {
    const previous = point({ used: undefined, remaining: undefined, percentUsed: 20 });
    const current = point({
      collectedAt: T1,
      used: undefined,
      remaining: undefined,
      percentUsed: 19,
    });
    expect(detectResetEvent(previous, current)).toBeUndefined();
  });

  it('records any strict absolute decrease (absolute tolerance is zero)', () => {
    const previous = point({
      used: 3,
      remaining: undefined,
      percentUsed: undefined,
      resetsAt: undefined,
    });
    const current = point({
      collectedAt: T1,
      used: 2,
      remaining: undefined,
      percentUsed: undefined,
      resetsAt: undefined,
    });
    expect(detectResetEvent(previous, current)?.details.reason).toBe('usage_decreased');
  });

  it('records nothing when one pair contradicts the other beyond tolerance', () => {
    // used collapsed but percentUsed rose: the evidence contradicts itself.
    const previous = point({ used: 100, percentUsed: 10 });
    const current = point({ collectedAt: T1, used: 0, percentUsed: 15 });
    expect(detectResetEvent(previous, current)).toBeUndefined();
  });

  it('judges only the pairs both points carry', () => {
    // percentUsed absent on the new point: only the used pair speaks.
    const previous = point({ percentUsed: undefined });
    const current = point({ collectedAt: T1, used: 400, percentUsed: undefined });
    expect(detectResetEvent(previous, current)?.details.reason).toBe('usage_decreased');
  });

  it('records nothing when a plan downgrade re-states every field downwards', () => {
    // used fell, but so did remaining (D-047's used+remaining=limit holds on
    // both sides): a smaller allowance, not a replenishment — the falling
    // remaining contradicts the reset hypothesis across signals.
    const previous = point({ used: 500, remaining: 1500, percentUsed: 25 });
    const current = point({
      collectedAt: T1,
      used: 100,
      remaining: 400,
      percentUsed: 20,
    });
    expect(detectResetEvent(previous, current)).toBeUndefined();
  });

  it('records nothing when a plan upgrade re-states every field upwards', () => {
    const previous = point({ used: 100, remaining: 400, percentUsed: 20 });
    const current = point({ collectedAt: T1, used: 500, remaining: 1500, percentUsed: 25 });
    expect(detectResetEvent(previous, current)).toBeUndefined();
  });

  it('records nothing when the contradiction crosses field kinds', () => {
    // used fell but percentRemaining also fell: not a reset shape.
    const previous = point({ used: 500, percentRemaining: 75 });
    const current = point({ collectedAt: T1, used: 100, percentRemaining: 60 });
    expect(detectResetEvent(previous, current)).toBeUndefined();
  });

  it('records both codes when absolutes and percentages move consistently', () => {
    // used collapsed while the percentage pair moved two points the same
    // way (28 = 30 − 2, beyond the one-point tolerance): every carried
    // field supports the reset hypothesis.
    const previous = point({
      used: 500,
      remaining: undefined,
      percentUsed: 30,
      percentRemaining: 70,
    });
    const current = point({
      collectedAt: T1,
      used: 0,
      remaining: undefined,
      percentUsed: 28,
      percentRemaining: 72,
    });
    expect(detectResetEvent(previous, current)?.details.reason).toBe(
      'usage_decreased+remaining_increased',
    );
  });
});

describe('detectResetEvent: condition 2 (declared reset-time advancement)', () => {
  it('records the advancement with the previous resetsAt as the event time', () => {
    const resetsAt = T0 + 120_000; // strictly between the snapshots
    const previous = point({ resetsAt });
    const current = point({ collectedAt: T1, resetsAt: resetsAt + 3_600_000 });
    const event = detectResetEvent(previous, current);
    expect(event?.details.reason).toBe('resets_at_advanced');
    expect(event?.eventAt).toBe(resetsAt);
    expect(event?.details.eventTimeSource).toBe('previous_resets_at');
  });

  it('treats a resetsAt equal to the new collection time as passed and between', () => {
    const previous = point({ resetsAt: T1 });
    const current = point({ collectedAt: T1, resetsAt: T1 + 1 });
    const event = detectResetEvent(previous, current);
    expect(event?.eventAt).toBe(T1);
    expect(event?.details.eventTimeSource).toBe('previous_resets_at');
  });

  it('falls back to the new collection time for a declaration stale before the previous point', () => {
    const previous = point({ resetsAt: T0 }); // passed, but not strictly between
    const current = point({ collectedAt: T1, resetsAt: T1 + 1 });
    const event = detectResetEvent(previous, current);
    expect(event?.details.reason).toBe('resets_at_advanced');
    expect(event?.eventAt).toBe(T1);
    expect(event?.details.eventTimeSource).toBe('current_collected_at');
  });

  it('records nothing when the declared reset has not passed yet', () => {
    const resetsAt = T1 + 60_000; // still in the future at the new snapshot
    const previous = point({ resetsAt });
    const current = point({ collectedAt: T1, resetsAt: resetsAt + 60_000 });
    expect(detectResetEvent(previous, current)).toBeUndefined();
  });

  it('records nothing for an equal, earlier, or missing resetsAt', () => {
    expect(
      detectResetEvent(
        point({ resetsAt: T0 + 60_000 }),
        point({ collectedAt: T1, resetsAt: T0 + 60_000 }),
      ),
    ).toBeUndefined();
    expect(
      detectResetEvent(
        point({ resetsAt: T0 + 60_000 }),
        point({ collectedAt: T1, resetsAt: T0 + 30_000 }),
      ),
    ).toBeUndefined();
    expect(
      detectResetEvent(
        point({ resetsAt: T0 + 60_000 }),
        point({ collectedAt: T1, resetsAt: undefined }),
      ),
    ).toBeUndefined();
    expect(
      detectResetEvent(point({ resetsAt: undefined }), point({ collectedAt: T1, resetsAt: T1 })),
    ).toBeUndefined();
  });

  it('fires on a points pair that carries nothing but the declarations', () => {
    const previous = point({ used: undefined, remaining: undefined, resetsAt: T0 + 60_000 });
    const current = point({
      collectedAt: T1,
      used: undefined,
      remaining: undefined,
      resetsAt: T1 + 60_000,
    });
    expect(detectResetEvent(previous, current)?.details.reason).toBe('resets_at_advanced');
  });
});

describe('detectResetEvent: the conservative rolling-window approach', () => {
  it('records nothing for a rolling-window percentage drop without declaration evidence (done-condition)', () => {
    // A 5h window sliding: old usage exits, the percentage falls. This is
    // exactly the ambiguous transition that must not become an event.
    expect(
      detectResetEvent(
        rollingPoint(),
        rollingPoint({
          collectedAt: T1,
          percentUsed: 10,
          percentRemaining: 90,
          resetsAt: undefined,
        }),
      ),
    ).toBeUndefined();
  });

  it('records nothing for rolling-window absolute replenishment either', () => {
    const previous = rollingPoint({
      unit: 'CREDITS',
      percentUsed: undefined,
      percentRemaining: undefined,
      used: 900,
      remaining: 100,
    });
    const current = rollingPoint({
      unit: 'CREDITS',
      collectedAt: T1,
      percentUsed: undefined,
      percentRemaining: undefined,
      used: 100,
      remaining: 900,
    });
    expect(detectResetEvent(previous, current)).toBeUndefined();
  });

  it('records nothing for a rolling window whose declared resetsAt did not advance', () => {
    expect(
      detectResetEvent(
        rollingPoint(),
        rollingPoint({ collectedAt: T1, percentUsed: 0, percentRemaining: 100 }),
      ),
    ).toBeUndefined();
  });

  it('records a rolling-window event on declared advancement, noting the conservative exception', () => {
    const resetsAt = T0 + 240_000;
    const event = detectResetEvent(
      rollingPoint({ resetsAt }),
      rollingPoint({
        collectedAt: T1,
        percentUsed: 0,
        percentRemaining: 100,
        resetsAt: resetsAt + 18_000_000,
      }),
    );
    expect(event?.details.reason).toBe(`resets_at_advanced+${ROLLING_WINDOW_NOTE}`);
    expect(event?.eventAt).toBe(resetsAt);
    expect(event?.details.eventTimeSource).toBe('previous_resets_at');
  });

  it('records nothing for a rolling window whose declared resetsAt advanced but has not passed', () => {
    const resetsAt = T1 + 60_000;
    expect(
      detectResetEvent(
        rollingPoint({ resetsAt }),
        rollingPoint({ collectedAt: T1, percentUsed: 0, resetsAt: resetsAt + 60_000 }),
      ),
    ).toBeUndefined();
  });
});

describe('detectResetEvent: guards and ambiguity suppressions', () => {
  it('records nothing for the first point of a series', () => {
    expect(detectResetEvent(undefined, point())).toBeUndefined();
  });

  it('rejects an invalid point with a TypeError (invalid points do not participate)', () => {
    expect(() =>
      detectResetEvent(
        point({ isValid: false, used: undefined, remaining: undefined }),
        point({ collectedAt: T1, used: 100 }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      detectResetEvent(
        point(),
        point({ collectedAt: T1, isValid: false, used: undefined, remaining: undefined }),
      ),
    ).toThrow(/§12\.1/);
  });

  it('rejects points of different accounts or metrics', () => {
    expect(() =>
      detectResetEvent(point(), point({ accountId: 'other', collectedAt: T1, used: 100 })),
    ).toThrow(TypeError);
    expect(() =>
      detectResetEvent(point(), point({ metricKey: 'tokens-5h', collectedAt: T1, used: 100 })),
    ).toThrow(TypeError);
  });

  it('records nothing for an out-of-order pair', () => {
    expect(detectResetEvent(point(), point({ collectedAt: T0 - 1, used: 100 }))).toBeUndefined();
  });

  it('records nothing when the series was redefined between the points', () => {
    expect(
      detectResetEvent(point(), point({ collectedAt: T1, limitType: 'WEEKLY', used: 100 })),
    ).toBeUndefined();
    expect(
      detectResetEvent(point(), point({ collectedAt: T1, unit: 'CREDITS', used: 100 })),
    ).toBeUndefined();
  });

  it('tolerates equal collection times on otherwise unambiguous evidence', () => {
    const event = detectResetEvent(point(), point({ collectedAt: T0, used: 100 }));
    expect(event?.eventAt).toBe(T0);
    expect(event?.details.eventTimeSource).toBe('current_collected_at');
  });
});

describe('the exported vocabulary', () => {
  it('pins the tolerances and the reason codes (drift guard)', () => {
    expect(ABSOLUTE_TOLERANCE).toBe(0);
    expect(PERCENT_TOLERANCE).toBe(1);
    expect(RESET_SIGNAL_CODES).toEqual([
      'usage_decreased',
      'remaining_increased',
      'resets_at_advanced',
    ]);
    expect(ROLLING_WINDOW_NOTE).toBe('rolling_window_conservative');
  });

  it('produces events storable as-is by the cycle write (task 118 seam)', () => {
    const event = detectResetEvent(
      point({ runId: 41 }),
      point({ collectedAt: T1, runId: 42, used: 100, remaining: 1900 }),
    );
    // Assignment compatibility is proven at compile time; the runtime no-op
    // pins that the identity is lossless (no conversion happens in 118).
    const asCycleEventInput = (reset: ResetEvent): CycleEventInput => reset;
    expect(event !== undefined && asCycleEventInput(event)).toEqual(event);
  });
});

describe('detectSeriesResetEvents', () => {
  it('returns nothing for a single point (no predecessor)', () => {
    expect(detectSeriesResetEvents([point()])).toEqual([]);
  });

  it('skips invalid points entirely: neither compared nor made the base', () => {
    const invalid = point({
      collectedAt: T0 + 150_000,
      isValid: false,
      used: undefined,
      remaining: undefined,
    });
    const events = detectSeriesResetEvents([
      point(),
      invalid,
      point({ collectedAt: T1, used: 100, remaining: 1900 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.details.previous.collectedAt).toBe(T0);
    expect(events[0]?.details.current.collectedAt).toBe(T1);
  });

  it('records nothing when the series ends on an invalid point', () => {
    expect(
      detectSeriesResetEvents([
        point(),
        point({ collectedAt: T1, isValid: false, used: undefined, remaining: undefined }),
      ]),
    ).toEqual([]);
  });

  it('keeps interleaved metrics separate', () => {
    const events = detectSeriesResetEvents([
      point(),
      rollingPoint(),
      point({ collectedAt: T1, used: 100, remaining: 1900 }),
      // tokens-5h slides from 80% to 10%: ambiguous, never an event.
      rollingPoint({ collectedAt: T1, percentUsed: 10, percentRemaining: 90 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.metricKey).toBe('mcp-monthly');
  });

  it('keeps accounts separate: the same metric on two accounts never crosses', () => {
    // Interleaving two accounts' mcp-monthly points must not compare
    // account A's reading against account B's (§12.1: "the same account
    // and metric"): A drops against its own previous point (an event),
    // while B's usage merely grows (no event).
    const events = detectSeriesResetEvents([
      point({ accountId: 'a', used: 500, remaining: 1500, collectedAt: T0 }),
      point({ accountId: 'b', used: 800, remaining: 1200, collectedAt: T0 + 60_000 }),
      point({ accountId: 'a', used: 100, remaining: 1900, collectedAt: T1 }),
      point({ accountId: 'b', used: 850, remaining: 1150, collectedAt: T1 + 60_000 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.details.previous.used).toBe(500);
    expect(events[0]?.details.current.used).toBe(100);
  });

  it('drops the event for an out-of-order point but keeps it as the new base', () => {
    const events = detectSeriesResetEvents([
      point({ collectedAt: T1 }),
      point({ collectedAt: T0, used: 100 }), // out of order: no event
      point({ collectedAt: T1 + 300_000, used: 50 }), // compared against T0's values
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.details.previous.collectedAt).toBe(T0);
  });

  it('emits events in input order across metrics', () => {
    const events = detectSeriesResetEvents([
      point({ runId: 1 }),
      rollingPoint({ runId: 2, resetsAt: T0 + 60_000 }),
      point({ collectedAt: T1, runId: 3, used: 100, remaining: 1900 }),
      rollingPoint({
        collectedAt: T1,
        runId: 4,
        // The previous declaration (T0+60s) passed between the snapshots and
        // a later one replaced it: the rolling series' one admissible event.
        resetsAt: T0 + 60_000 + 3_600_000,
      }),
    ]);
    expect(events.map((event) => event.metricKey)).toEqual(['mcp-monthly', 'tokens-5h']);
    expect(events[0]?.details.previous.runId).toBe(1);
    expect(events[1]?.details.previous.runId).toBe(2);
  });
});
