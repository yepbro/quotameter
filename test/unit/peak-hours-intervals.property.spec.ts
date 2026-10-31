import { describe, expect, it } from 'vitest';
import { fc } from '../helpers/property';
import { resolveTimeZone, zonedParts } from '../../src/util/clock';
import { calculatePeakHoursIntervals } from '../../src/services/peak-hours-intervals';
import { WEEK_DAYS } from '../../src/schemas/config';
import type { PeakHoursConfig, PeakWindow, WeekDay } from '../../src/schemas/config';

/**
 * The standing proofs of task 114's core invariants (spec §9.3; decision
 * D-073), over generated schedules and query ranges:
 *
 * 1. **Partition** — the returned intervals are chronological, disjoint,
 *    adjacent (consecutive intervals touch), and cover exactly `[from, to)`.
 * 2. **Oracle agreement** — the kind of every interval is confirmed by an
 *    independent classifier built on the *opposite* conversion direction:
 *    `zonedParts` reads a midpoint's local wall clock (the D-021-unambiguous
 *    epoch → local direction), and day/minute membership in the generated
 *    windows decides peak versus off-peak. The calculator walks local →
 *    UTC; the oracle walks UTC → local; agreement is only exact because
 *    generation is restricted to fixed-offset zones, where the two
 *    directions are bijections — DST zones are deliberately out of scope
 *    here, since their transition semantics are task 115's policy.
 *
 * Windows are generated on distinct weekdays with `start < end` (§9.2's
 * no-overlap/no-midnight rules), so every generated schedule is one the
 * configuration contract would accept.
 */

/**
 * Fixed-offset zones only (no DST history in 2025–2028): UTC (+0),
 * Asia/Singapore (+8), Asia/Kolkata (+5:30), Asia/Kathmandu (+5:45),
 * Asia/Tokyo (+9), America/Phoenix (−7), Pacific/Honolulu (−10).
 */
const FIXED_ZONES = [
  'UTC',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Asia/Tokyo',
  'America/Phoenix',
  'Pacific/Honolulu',
] as const;

/** `HH:mm` for minutes since midnight; `1440` renders as `24:00` (§9.2). */
function hhmm(minutes: number): string {
  if (minutes === 1440) {
    return '24:00';
  }
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Minutes since midnight of an `HH:mm` or `24:00` window edge. */
function minutesOf(value: string): number {
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** A `[start, end)` pair of minutes since midnight, `0 ≤ start < end ≤ 1440`. */
const timesArb = fc
  .integer({ min: 0, max: 1439 })
  .chain((start) => fc.integer({ min: start + 1, max: 1440 }).map((end) => ({ start, end })));

/** One to three windows on distinct weekdays, `start < end`, ends may be `24:00`. */
const windowsArb = fc
  .uniqueArray(fc.constantFrom(...WEEK_DAYS), { minLength: 1, maxLength: 3 })
  .chain((days) =>
    fc.array(timesArb, { minLength: days.length, maxLength: days.length }).map((times) =>
      days.map((day, index): PeakWindow => {
        const time = times[index]!;
        return {
          id: `w${index + 1}`,
          name: `W${index + 1}`,
          days: [day],
          start: hhmm(time.start),
          end: hhmm(time.end),
        };
      }),
    ),
  );

/** A query range of 1 minute to 5 days inside 2025–2027, arbitrary millisecond ends. */
const rangeArb = fc
  .integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2027, 11, 20) })
  .chain((from) =>
    fc.integer({ min: 1, max: 5 * 1440 }).map((minutes): { from: number; to: number } => ({
      from,
      to: from + minutes * 60_000,
    })),
  );

/** True when local `parts` falls inside `window` on its weekday (§9.2 day/time). */
function windowCovers(window: PeakWindow, weekday: number, minutes: number): boolean {
  const day: WeekDay = WEEK_DAYS[weekday - 1]!;
  return (
    window.days.includes(day) &&
    minutes >= minutesOf(window.start) &&
    minutes < minutesOf(window.end)
  );
}

describe('generated schedules partition the query range (decision D-073)', () => {
  it('intervals are chronological, disjoint, adjacent, and cover exactly [from, to)', () => {
    let sawPeak = false;
    let sawOnlyOffPeak = false;
    let sawManyIntervals = false;
    fc.assert(
      fc.property(
        fc.constantFrom(...FIXED_ZONES),
        windowsArb,
        rangeArb,
        (timezone, windows, { from, to }) => {
          const schedule: PeakHoursConfig = { timezone, offPeakMultiplier: 0.5, windows };
          const intervals = calculatePeakHoursIntervals(schedule, { from, to }).intervals;

          expect(intervals.length).toBeGreaterThan(0);
          let cursor = from;
          for (const interval of intervals) {
            expect(interval.start).toBe(cursor);
            expect(interval.end).toBeGreaterThan(interval.start);
            cursor = interval.end;
          }
          expect(cursor).toBe(to);

          sawPeak ||= intervals.some((interval) => interval.kind === 'peak');
          sawOnlyOffPeak ||= intervals.every((interval) => interval.kind === 'off-peak');
          sawManyIntervals ||= intervals.length >= 3;
        },
      ),
    );
    // Vacuity tripwires: the generator must have produced all three shapes.
    expect([sawPeak, sawOnlyOffPeak, sawManyIntervals]).toEqual([true, true, true]);
  });

  it('every interval’s kind matches an independent epoch → local classifier at its midpoint', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FIXED_ZONES),
        windowsArb,
        rangeArb,
        (timezone, windows, { from, to }) => {
          const schedule: PeakHoursConfig = { timezone, offPeakMultiplier: 0.5, windows };
          const zone = resolveTimeZone(timezone);
          const intervals = calculatePeakHoursIntervals(schedule, { from, to }).intervals;

          for (const interval of intervals) {
            const mid = interval.start + (interval.end - interval.start) / 2;
            const parts = zonedParts(mid, zone);
            const minutes = parts.hour * 60 + parts.minute;
            const inside = windows.some((window) => windowCovers(window, parts.weekday, minutes));
            expect(interval.kind === 'peak').toBe(inside);
            expect(interval.multiplier).toBe(interval.kind === 'peak' ? 1 : 0.5);
          }
        },
      ),
    );
  });
});
