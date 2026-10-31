import { describe, expect, it } from 'vitest';
import { fc } from '../helpers/property';
import {
  ROLLING_RANGE_IDS,
  rollingRangeBounds,
  rollingRangeContains,
  rollingRangeDurationMs,
} from '../../src/util/rolling-ranges';

/**
 * Property-based coverage of the §10 rolling-range invariants (task 124, the
 * property complement to task 116's directed suite, decision D-068): over
 * generated `now` values — spanning the whole ECMAScript epoch-millisecond
 * range, negative pre-1970 instants included — every range id computes a
 * closed interval ending exactly at `now` with exact integer millisecond
 * arithmetic, both ends are inclusive with ±1 ms outside excluded, and the
 * five §14.4 ranges nest: longer ranges start earlier, and containment is
 * upward-closed through the vocabulary. Timestamps are generated data
 * (D-021): nothing here reads a clock, so the properties are deterministic
 * by construction and `TZ`-independent at the unit level (the subprocess
 * proof lives in test/integration/rolling-ranges-tz.spec.ts).
 */

/**
 * The outer bounds of ECMAScript time: ±100 000 000 days from the epoch
 * (±8.64e15 ms). Integer epoch milliseconds anywhere inside stay exact in
 * IEEE-754 (|value| < 2⁵³), and subtracting the largest duration
 * (2 592 000 000 ms) stays inside too — the whole domain the module accepts.
 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/** Any finite integer instant the module must accept. */
const nowArb = fc.integer({ min: -MAX_EPOCH_MS, max: MAX_EPOCH_MS });

describe('rollingRangeBounds (property — §10 invariants)', () => {
  it('computes a closed interval ending exactly at now, at exact ms arithmetic', () => {
    fc.assert(
      fc.property(nowArb, fc.constantFrom(...ROLLING_RANGE_IDS), (now, range) => {
        const durationMs = rollingRangeDurationMs(range);
        const bounds = rollingRangeBounds(range, now);
        expect(bounds.to).toBe(now);
        expect(bounds.from).toBe(now - durationMs);
        // The duration survives the round trip exactly — no float drift at
        // any integer instant (the D-068 pin, now over the whole domain).
        expect(bounds.from + durationMs).toBe(bounds.to);
        expect(bounds.to - bounds.from).toBe(durationMs);
      }),
    );
  });

  it('contains both ends and excludes ±1 ms outside, at every instant', () => {
    fc.assert(
      fc.property(nowArb, fc.constantFrom(...ROLLING_RANGE_IDS), (now, range) => {
        const bounds = rollingRangeBounds(range, now);
        expect(rollingRangeContains(bounds, bounds.from)).toBe(true);
        expect(rollingRangeContains(bounds, bounds.to)).toBe(true);
        expect(rollingRangeContains(bounds, bounds.from - 1)).toBe(false);
        expect(rollingRangeContains(bounds, bounds.to + 1)).toBe(false);
      }),
    );
  });

  it('nests the five ranges: longer ranges start earlier and contain the shorter', () => {
    fc.assert(
      fc.property(nowArb, (now) => {
        const byRange = new Map(
          ROLLING_RANGE_IDS.map((range) => [range, rollingRangeBounds(range, now)] as const),
        );
        for (let index = 1; index < ROLLING_RANGE_IDS.length; index += 1) {
          const shorter = byRange.get(ROLLING_RANGE_IDS[index - 1]!)!;
          const longer = byRange.get(ROLLING_RANGE_IDS[index]!)!;
          // Ascending duration order ⇒ the longer range's window starts at
          // or before the shorter's (both end at the same `now`).
          expect(longer.from).toBeLessThanOrEqual(shorter.from);
          // Containment is upward-closed: every instant inside the shorter
          // range is inside every longer one.
          expect(rollingRangeContains(longer, shorter.from)).toBe(true);
          expect(rollingRangeContains(longer, shorter.to)).toBe(true);
        }
        // The extremes of the whole vocabulary nest as well.
        const smallest = byRange.get('24h')!;
        const largest = byRange.get('30d')!;
        expect(rollingRangeContains(largest, smallest.from)).toBe(true);
      }),
    );
  });
});
