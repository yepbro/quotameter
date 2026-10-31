import { describe, expect, it } from 'vitest';
import { epochMsFromIso } from '../../src/util/clock';
import {
  DAY_MS,
  DEFAULT_ROLLING_RANGE,
  HOUR_MS,
  ROLLING_RANGE_IDS,
  rollingRangeBounds,
  rollingRangeContains,
  rollingRangeDurationMs,
  type RollingRangeId,
} from '../../src/util/rolling-ranges';

/**
 * Unit tests for src/util/rolling-ranges.ts (spec §10, §14.4; task 116,
 * decision D-068). Every `now` is a pinned literal or a UTC-ISO-derived
 * instant, so the suite never depends on the host `TZ`; the subprocess-level
 * proof of `TZ` invariance lives in
 * test/integration/rolling-ranges-tz.spec.ts (the task's done-condition).
 */

/** 2026-10-30T12:00:00Z — a modern instant (the clock suite's anchor). */
const NOW_MODERN = 1_793_361_600_000;

/** The Unix epoch itself: `from` lands in negative (pre-1970) territory. */
const NOW_EPOCH_START = 0;

/** 1969-12-31T00:00:00Z — a strictly pre-1970 `now` (negative epoch). */
const NOW_PRE_EPOCH = -86_400_000;

/** 2026-03-08T07:00:00Z — the instant America/New_York sprang forward. */
const NOW_AFTER_US_DST_SPRING_FORWARD = epochMsFromIso('2026-03-08T07:00:00.000Z');

/** A wall-clock day around that transition is 82 800 000 ms; ours is not. */
const US_DST_SPRING_FORWARD_DAY_MS = 82_800_000;

/** 2024-02-29T12:00:00.500Z — a leap day with sub-second precision. */
const NOW_LEAP_DAY_FRACTIONAL = epochMsFromIso('2024-02-29T12:00:00.500Z');

/** Instants the boundary table runs over: epoch edges, DST, leap, fraction. */
const NOWS: readonly number[] = [
  NOW_MODERN,
  NOW_EPOCH_START,
  NOW_PRE_EPOCH,
  NOW_AFTER_US_DST_SPRING_FORWARD,
  NOW_LEAP_DAY_FRACTIONAL,
];

/** Exact durations per spec §14.4's vocabulary (decision D-068). */
const EXPECTED_DURATIONS: readonly (readonly [RollingRangeId, number])[] = [
  ['24h', 86_400_000],
  ['3d', 259_200_000],
  ['7d', 604_800_000],
  ['14d', 1_209_600_000],
  ['30d', 2_592_000_000],
];

describe('rolling range vocabulary', () => {
  it('is exactly the five spec §14.4 ranges in ascending duration order', () => {
    expect(ROLLING_RANGE_IDS).toEqual(['24h', '3d', '7d', '14d', '30d']);
    for (let index = 1; index < ROLLING_RANGE_IDS.length; index += 1) {
      const previous = rollingRangeDurationMs(ROLLING_RANGE_IDS[index - 1]!);
      const current = rollingRangeDurationMs(ROLLING_RANGE_IDS[index]!);
      expect(current).toBeGreaterThan(previous);
    }
  });

  it('defaults to the 7-day range (spec §14.4)', () => {
    expect(DEFAULT_ROLLING_RANGE).toBe('7d');
    expect(ROLLING_RANGE_IDS).toContain(DEFAULT_ROLLING_RANGE);
  });

  it('maps every range to its exact millisecond duration', () => {
    for (const [range, durationMs] of EXPECTED_DURATIONS) {
      expect(rollingRangeDurationMs(range)).toBe(durationMs);
    }
  });

  it('exports the exact hour and day constants', () => {
    expect(HOUR_MS).toBe(3_600_000);
    expect(DAY_MS).toBe(24 * HOUR_MS);
  });
});

describe('rollingRangeBounds', () => {
  it.each(EXPECTED_DURATIONS)(
    'computes %s as a closed interval ending at now',
    (range, durationMs) => {
      for (const now of NOWS) {
        const bounds = rollingRangeBounds(range, now);
        expect(bounds.to).toBe(now);
        expect(bounds.from).toBe(now - durationMs);
        expect(bounds.from + durationMs).toBe(bounds.to);
      }
    },
  );

  it('keeps a 24h range exactly 24 absolute hours across a DST spring-forward', () => {
    // A calendar-day subtraction in America/New_York would produce a
    // 82 800 000 ms "day" around this transition; duration arithmetic
    // must not drift with wall clocks (spec §10, decision D-068).
    const bounds = rollingRangeBounds('24h', NOW_AFTER_US_DST_SPRING_FORWARD);
    expect(bounds.to - bounds.from).toBe(DAY_MS);
    expect(bounds.to - bounds.from).not.toBe(US_DST_SPRING_FORWARD_DAY_MS);
  });

  it('passes a fractional now through without rounding', () => {
    const bounds = rollingRangeBounds('3d', 1_234.5);
    expect(bounds.to).toBe(1_234.5);
    expect(bounds.from).toBe(1_234.5 - 259_200_000);
  });

  it('returns a frozen bounds object', () => {
    const bounds = rollingRangeBounds('7d', NOW_MODERN);
    expect(Object.isFrozen(bounds)).toBe(true);
    const writable = bounds as { to: number };
    expect(() => {
      writable.to = 0;
    }).toThrow(TypeError);
  });

  it('rejects an unknown range id by listing the vocabulary', () => {
    expect(() => rollingRangeDurationMs('1h' as RollingRangeId)).toThrow(
      /unknown rolling range '1h'; expected one of: '24h', '3d', '7d', '14d', '30d'/,
    );
    expect(() => rollingRangeBounds('90d' as RollingRangeId, NOW_MODERN)).toThrow(
      /unknown rolling range '90d'/,
    );
  });

  it('rejects a non-string range input the same way', () => {
    expect(() => rollingRangeDurationMs(undefined as unknown as RollingRangeId)).toThrow(
      /unknown rolling range 'undefined'/,
    );
  });

  it('validates the range before the instant (deterministic error order)', () => {
    expect(() => rollingRangeBounds('1h' as RollingRangeId, Number.NaN)).toThrow(
      /unknown rolling range/,
    );
  });

  it('rejects a non-finite now', () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => rollingRangeBounds('24h', now)).toThrow(
        `now must be a finite number, got ${now}`,
      );
    }
  });

  it('stays finite at the ms-arithmetic edges: absorption, not overflow', () => {
    // Subtracting a ≤ 2 592 000 000 ms duration cannot leave the finite
    // range: the float spacing at ±MAX_VALUE dwarfs every duration, so the
    // result is absorbed exactly (from === now) — documented in D-068.
    const positive = rollingRangeBounds('30d', Number.MAX_VALUE);
    expect(positive.to).toBe(Number.MAX_VALUE);
    expect(positive.from).toBe(Number.MAX_VALUE);
    const negative = rollingRangeBounds('30d', -Number.MAX_VALUE);
    expect(negative.to).toBe(-Number.MAX_VALUE);
    expect(negative.from).toBe(-Number.MAX_VALUE);
  });
});

describe('rollingRangeContains', () => {
  const bounds = rollingRangeBounds('24h', 1_000_000);

  it('includes both boundaries — the closed-interval pin (D-068)', () => {
    expect(rollingRangeContains(bounds, bounds.from)).toBe(true);
    expect(rollingRangeContains(bounds, bounds.to)).toBe(true);
  });

  it('excludes points one millisecond outside on either side', () => {
    expect(rollingRangeContains(bounds, bounds.from - 1)).toBe(false);
    expect(rollingRangeContains(bounds, bounds.to + 1)).toBe(false);
  });

  it('excludes non-finite probes', () => {
    expect(rollingRangeContains(bounds, Number.NaN)).toBe(false);
    expect(rollingRangeContains(bounds, Number.POSITIVE_INFINITY)).toBe(false);
    expect(rollingRangeContains(bounds, Number.NEGATIVE_INFINITY)).toBe(false);
  });
});
