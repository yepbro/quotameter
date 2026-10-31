import { describe, expect, it } from 'vitest';
import { epochMsFromIso, resolveTimeZone, type TimeZone } from '../../src/util/clock';
import {
  MAX_QUERY_SPAN_DAYS,
  MINUTES_PER_DAY,
  calculatePeakHoursIntervals,
  resolveLocalInstantLuxon,
  type LocalScheduleTime,
} from '../../src/services/peak-hours-intervals';
import type { PeakHoursConfig, PeakWindow } from '../../src/schemas/config';

/**
 * The peak-hours interval matrix (spec §9.3, §10; task 114, decision D-073):
 * the done-condition made executable — the calculated timeline carries
 * exact UTC intervals, window names, rate multipliers, and the boundaries'
 * local times in the schedule zone, for the canonical schedule, every
 * boundary shape, and the fail-fast inputs.
 *
 * Expected instants are derived from hand-computed UTC ISO strings (offset
 * arithmetic done in the comments), never from the module under test, so
 * the suite never depends on the host `TZ` — the module reads no machine
 * zone (D-021), and pinned literals hold under any `TZ`.
 *
 * The DST transition cases assert what the documented default resolver
 * produces; the §17.1 transition matrix that pins the §9.3 policy is task
 * 115's deliverable, deliberately not duplicated here.
 */

/** `epochMsFromIso` under a shorter name — every expected instant goes through it. */
const iso = epochMsFromIso;

/** A valid peak window with overridable fields (the §9.2 sample shape). */
const window = (overrides: Partial<PeakWindow> = {}): PeakWindow => ({
  id: 'w1',
  name: 'W1',
  days: ['mon'],
  start: '14:00',
  end: '18:00',
  ...overrides,
});

/** A schedule section with overridable fields; defaults to the empty shape. */
const schedule = (overrides: Partial<PeakHoursConfig> = {}): PeakHoursConfig => ({
  timezone: 'UTC',
  windows: [],
  ...overrides,
});

/** 2026-11-02 — the Monday of the canonical-schedule week below. */
const MONDAY = iso('2026-11-02T00:00:00Z');

describe('the canonical Z.ai schedule over one week (spec §9.1, §9.3)', () => {
  // Monday–Friday 14:00–18:00 Asia/Singapore (UTC+8, no DST) is
  // 06:00–10:00 UTC; 2026-11-01 and 2026-11-07/08 are the weekend around it.
  const zai = schedule({
    timezone: 'Asia/Singapore',
    offPeakMultiplier: 0.5,
    windows: [
      window({
        id: 'zai-weekday-peak',
        name: 'Z.ai Coding Plan peak hours',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        start: '14:00',
        end: '18:00',
        multiplier: 1.0,
      }),
    ],
  });

  it('returns the exact UTC intervals, names, rates, and local times', () => {
    const timeline = calculatePeakHoursIntervals(zai, {
      from: iso('2026-11-01T00:00:00Z'),
      to: iso('2026-11-08T00:00:00Z'),
    });

    // SGT 14:00 = 06:00Z, SGT 18:00 = 10:00Z (UTC+8 all year); the evenings
    // between weekday peaks are off-peak like the weekend bookends.
    const offPeak = (startIso: string, endIso: string, localStart: string, localEnd: string) => ({
      kind: 'off-peak',
      start: iso(startIso),
      end: iso(endIso),
      multiplier: 0.5,
      localStart,
      localEnd,
    });
    const peak = (day: number) => ({
      kind: 'peak',
      start: iso(`2026-11-0${day}T06:00:00.000Z`),
      end: iso(`2026-11-0${day}T10:00:00.000Z`),
      multiplier: 1.0,
      windowId: 'zai-weekday-peak',
      name: 'Z.ai Coding Plan peak hours',
      localStart: `2026-11-0${day}T14:00`,
      localEnd: `2026-11-0${day}T18:00`,
    });

    const intervals: unknown[] = [
      offPeak(
        '2026-11-01T00:00:00.000Z',
        '2026-11-02T06:00:00.000Z',
        '2026-11-01T08:00',
        '2026-11-02T14:00',
      ),
    ];
    for (let day = 2; day <= 6; day++) {
      intervals.push(peak(day));
      if (day < 6) {
        intervals.push(
          offPeak(
            `2026-11-0${day}T10:00:00.000Z`,
            `2026-11-0${day + 1}T06:00:00.000Z`,
            `2026-11-0${day}T18:00`,
            `2026-11-0${day + 1}T14:00`,
          ),
        );
      }
    }
    intervals.push(
      offPeak(
        '2026-11-06T10:00:00.000Z',
        '2026-11-08T00:00:00.000Z',
        '2026-11-06T18:00',
        '2026-11-08T08:00',
      ),
    );

    expect(timeline).toEqual({
      timezone: 'Asia/Singapore',
      offPeakMultiplier: 0.5,
      intervals,
    });
  });

  it('skips the weekend days the schedule does not select', () => {
    const timeline = calculatePeakHoursIntervals(zai, {
      from: iso('2026-11-07T00:00:00Z'), // Saturday
      to: iso('2026-11-08T00:00:00Z'), // Sunday
    });
    expect(timeline.intervals).toEqual([
      {
        kind: 'off-peak',
        start: iso('2026-11-07T00:00:00.000Z'),
        end: iso('2026-11-08T00:00:00.000Z'),
        multiplier: 0.5,
        localStart: '2026-11-07T08:00',
        localEnd: '2026-11-08T08:00',
      },
    ]);
  });
});

describe('interval boundaries and clipping (UTC schedule zone)', () => {
  it('mirrors a window into exact UTC epochs across midnight-free days', () => {
    const timeline = calculatePeakHoursIntervals(
      schedule({ windows: [window({ start: '09:00', end: '17:00' })] }),
      { from: MONDAY, to: MONDAY + 86_400_000 },
    );
    expect(
      timeline.intervals.map((interval) => [interval.kind, interval.start, interval.end]),
    ).toEqual([
      ['off-peak', MONDAY, iso('2026-11-02T09:00:00Z')],
      ['peak', iso('2026-11-02T09:00:00Z'), iso('2026-11-02T17:00:00Z')],
      ['off-peak', iso('2026-11-02T17:00:00Z'), MONDAY + 86_400_000],
    ]);
  });

  it('clips a window at both range ends and reports the clipped local times', () => {
    const timeline = calculatePeakHoursIntervals(
      schedule({ windows: [window()] }), // 14:00–18:00
      { from: iso('2026-11-02T15:30:00Z'), to: iso('2026-11-02T16:45:00Z') },
    );
    expect(timeline.intervals).toEqual([
      {
        kind: 'peak',
        start: iso('2026-11-02T15:30:00Z'),
        end: iso('2026-11-02T16:45:00Z'),
        multiplier: 1,
        windowId: 'w1',
        name: 'W1',
        localStart: '2026-11-02T15:30',
        localEnd: '2026-11-02T16:45',
      },
    ]);
  });

  it('excludes a window that ends exactly at `from` (half-open range)', () => {
    const timeline = calculatePeakHoursIntervals(
      schedule({ windows: [window({ start: '08:00', end: '12:00' })] }),
      { from: iso('2026-11-02T12:00:00Z'), to: iso('2026-11-02T20:00:00Z') },
    );
    expect(timeline.intervals.map((interval) => interval.kind)).toEqual(['off-peak']);
    expect(timeline.intervals[0]!.start).toBe(iso('2026-11-02T12:00:00Z'));
  });

  it('excludes a window that starts exactly at `to` (half-open range)', () => {
    const timeline = calculatePeakHoursIntervals(schedule({ windows: [window()] }), {
      from: iso('2026-11-02T06:00:00Z'),
      to: iso('2026-11-02T14:00:00Z'),
    });
    expect(timeline.intervals.map((interval) => interval.kind)).toEqual(['off-peak']);
    expect(timeline.intervals[0]!.end).toBe(iso('2026-11-02T14:00:00Z'));
  });

  it('includes a window that ends exactly at `to`', () => {
    const timeline = calculatePeakHoursIntervals(
      schedule({ windows: [window({ start: '12:00', end: '14:00' })] }),
      { from: iso('2026-11-02T06:00:00Z'), to: iso('2026-11-02T14:00:00Z') },
    );
    expect(timeline.intervals.map((interval) => interval.kind)).toEqual(['off-peak', 'peak']);
  });
});

describe('day selection and window shapes (spec §9.2 feeding §9.3)', () => {
  it('emits one interval per window and keeps chronological order', () => {
    // Deliberately listed out of time order; touching windows leave no gap.
    const timeline = calculatePeakHoursIntervals(
      schedule({
        windows: [
          window({ id: 'w-evening', name: 'Evening', start: '18:00', end: '20:00' }),
          window({ id: 'w-morning', name: 'Morning', start: '09:00', end: '12:00', multiplier: 2 }),
        ],
      }),
      { from: MONDAY, to: MONDAY + 86_400_000 },
    );
    expect(timeline.intervals.map((interval) => interval.kind)).toEqual([
      'off-peak',
      'peak',
      'off-peak',
      'peak',
      'off-peak',
    ]);
    expect(timeline.intervals[1]).toMatchObject({
      windowId: 'w-morning',
      name: 'Morning',
      multiplier: 2,
    });
    expect(timeline.intervals[3]).toMatchObject({
      windowId: 'w-evening',
      name: 'Evening',
      multiplier: 1,
    });
  });

  it('resolves a `24:00` end to the following local midnight', () => {
    const timeline = calculatePeakHoursIntervals(
      schedule({ windows: [window({ days: ['sun'], start: '22:00', end: '24:00' })] }),
      { from: iso('2026-11-01T23:00:00Z'), to: iso('2026-11-02T06:00:00Z') }, // Sun 23:00 → Mon 06:00
    );
    expect(timeline.intervals).toEqual([
      {
        kind: 'peak',
        start: iso('2026-11-01T23:00:00Z'),
        end: iso('2026-11-02T00:00:00Z'),
        multiplier: 1,
        windowId: 'w1',
        name: 'W1',
        localStart: '2026-11-01T23:00',
        localEnd: '2026-11-02T00:00', // the midnight ending Sunday, not a literal 24:00
      },
      {
        kind: 'off-peak',
        start: iso('2026-11-02T00:00:00Z'),
        end: iso('2026-11-02T06:00:00Z'),
        multiplier: 1,
        localStart: '2026-11-02T00:00',
        localEnd: '2026-11-02T06:00',
      },
    ]);
  });

  it('excludes a `24:00` window of the guard day that only touches `from`', () => {
    const timeline = calculatePeakHoursIntervals(
      schedule({ windows: [window({ days: ['sun'], start: '22:00', end: '24:00' })] }),
      { from: MONDAY, to: MONDAY + 86_400_000 }, // from is exactly Sunday's 24:00
    );
    expect(timeline.intervals.map((interval) => interval.kind)).toEqual(['off-peak']);
  });

  it('covers whole local days with a `00:00–24:00` window and emits no off-peak', () => {
    const timeline = calculatePeakHoursIntervals(
      schedule({ windows: [window({ days: ['mon', 'tue'], start: '00:00', end: '24:00' })] }),
      { from: MONDAY, to: MONDAY + 2 * 86_400_000 },
    );
    expect(timeline.intervals.map((interval) => interval.kind)).toEqual(['peak', 'peak']);
    expect(timeline.intervals[0]).toMatchObject({
      localStart: '2026-11-02T00:00',
      localEnd: '2026-11-03T00:00',
    });
  });

  it('returns a single off-peak interval for the unconfigured schedule', () => {
    const timeline = calculatePeakHoursIntervals(schedule({ offPeakMultiplier: 0.5 }), {
      from: MONDAY,
      to: MONDAY + 3 * 86_400_000,
    });
    expect(timeline.intervals).toEqual([
      {
        kind: 'off-peak',
        start: MONDAY,
        end: MONDAY + 3 * 86_400_000,
        multiplier: 0.5,
        localStart: '2026-11-02T00:00',
        localEnd: '2026-11-05T00:00',
      },
    ]);
  });

  it('defaults both multipliers to 1.0 when unconfigured (§9.2)', () => {
    const timeline = calculatePeakHoursIntervals(schedule({ windows: [window()] }), {
      from: MONDAY,
      to: MONDAY + 86_400_000,
    });
    expect(timeline.offPeakMultiplier).toBe(1);
    expect(timeline.intervals[0]!.multiplier).toBe(1);
    expect(timeline.intervals[1]!.multiplier).toBe(1);
  });
});

describe('fail-fast inputs', () => {
  it('returns an empty timeline for an empty range', () => {
    const timeline = calculatePeakHoursIntervals(
      schedule({ windows: [window()], offPeakMultiplier: 0.5 }),
      { from: MONDAY, to: MONDAY },
    );
    expect(timeline).toEqual({ timezone: 'UTC', offPeakMultiplier: 0.5, intervals: [] });
  });

  it('rejects a non-finite range end', () => {
    expect(() => calculatePeakHoursIntervals(schedule(), { from: MONDAY, to: Number.NaN })).toThrow(
      /'to' must be a finite number, got NaN/,
    );
    expect(() =>
      calculatePeakHoursIntervals(schedule(), { from: Number.POSITIVE_INFINITY, to: MONDAY }),
    ).toThrow(/'from' must be a finite number, got Infinity/);
  });

  it('rejects an inverted range', () => {
    expect(() => calculatePeakHoursIntervals(schedule(), { from: MONDAY + 1, to: MONDAY })).toThrow(
      /from <= to, got from \d+ and to \d+/,
    );
  });

  it('rejects a span over the day ceiling', () => {
    expect(() =>
      calculatePeakHoursIntervals(schedule(), {
        from: iso('2000-01-01T00:00:00Z'),
        to: iso('2026-11-02T00:00:00Z'), // ~9800 local days
      }),
    ).toThrow(new RegExp(`above the maximum of ${MAX_QUERY_SPAN_DAYS}`));
  });

  it('accepts a span within the day ceiling', () => {
    // 2016-11-02 → 2026-11-02 is 3652 days (leap years 2020 and 2024).
    expect(() =>
      calculatePeakHoursIntervals(schedule(), {
        from: iso('2016-11-02T00:00:00Z'),
        to: iso('2026-11-02T00:00:00Z'),
      }),
    ).not.toThrow();
  });

  it('rejects a non-IANA schedule zone through the entry-point gate', () => {
    expect(() =>
      calculatePeakHoursIntervals(schedule({ timezone: 'Not/AZone' }), {
        from: MONDAY,
        to: MONDAY + 1,
      }),
    ).toThrow(/'Not\/AZone' is not a valid IANA time zone/);
  });
});

describe('the local-instant seam (the task-115 handoff)', () => {
  it('routes every window edge through the injected resolver', () => {
    const calls: LocalScheduleTime[] = [];
    const recording = (time: LocalScheduleTime, timeZone: TimeZone): number => {
      calls.push(time);
      return resolveLocalInstantLuxon(time, timeZone);
    };
    calculatePeakHoursIntervals(
      schedule({ windows: [window({ days: ['mon'], start: '22:00', end: '24:00' })] }),
      { from: MONDAY, to: MONDAY + 86_400_000 },
      recording,
    );
    expect(calls).toEqual([
      { year: 2026, month: 11, day: 2, minutesSinceMidnight: 22 * 60 },
      { year: 2026, month: 11, day: 2, minutesSinceMidnight: MINUTES_PER_DAY },
    ]);
  });

  it('honors an injected resolver with different instants', () => {
    const skewed = (time: LocalScheduleTime, timeZone: TimeZone): number =>
      resolveLocalInstantLuxon(time, timeZone) + 60_000;
    const timeline = calculatePeakHoursIntervals(
      schedule({ windows: [window()], offPeakMultiplier: 0.5 }),
      { from: MONDAY, to: MONDAY + 86_400_000 },
      skewed,
    );
    expect(
      timeline.intervals.map((interval) => [interval.kind, interval.start, interval.end]),
    ).toEqual([
      ['off-peak', MONDAY, iso('2026-11-02T14:01:00Z')],
      ['peak', iso('2026-11-02T14:01:00Z'), iso('2026-11-02T18:01:00Z')],
      ['off-peak', iso('2026-11-02T18:01:00Z'), MONDAY + 86_400_000],
    ]);
  });
});

describe('resolveLocalInstantLuxon — the documented default', () => {
  // Zones enter through the branded gate (D-021), the way every consumer
  // passes them onward after `resolveTimeZone`.
  const SGT = resolveTimeZone('Asia/Singapore');
  const NY = resolveTimeZone('America/New_York');
  const UTC = resolveTimeZone('UTC');

  it('resolves a local time in a fixed-offset zone', () => {
    // SGT 14:00 on Monday 2026-11-02 is 06:00Z (UTC+8).
    expect(
      resolveLocalInstantLuxon({ year: 2026, month: 11, day: 2, minutesSinceMidnight: 840 }, SGT),
    ).toBe(iso('2026-11-02T06:00:00.000Z'));
  });

  it('resolves `24:00` to the following day’s local midnight', () => {
    expect(
      resolveLocalInstantLuxon({ year: 2026, month: 11, day: 2, minutesSinceMidnight: 1440 }, UTC),
    ).toBe(iso('2026-11-03T00:00:00.000Z'));
    // Across the US spring-forward: Sunday’s midnight EST plus one calendar
    // day is Monday 2026-03-08 00:00 EST = 05:00Z (the transition is at 02:00).
    expect(
      resolveLocalInstantLuxon({ year: 2026, month: 3, day: 7, minutesSinceMidnight: 1440 }, NY),
    ).toBe(iso('2026-03-08T05:00:00.000Z'));
  });

  it('fails loudly for impossible inputs instead of returning NaN', () => {
    expect(() =>
      resolveLocalInstantLuxon({ year: 2026, month: 2, day: 30, minutesSinceMidnight: 0 }, UTC),
    ).toThrow(/local schedule date 2026-2-30/);
    expect(() =>
      resolveLocalInstantLuxon({ year: 2026, month: 11, day: 2, minutesSinceMidnight: 1441 }, UTC),
    ).toThrow(/must be an integer in 0-1440, got 1441/);
    expect(() =>
      resolveLocalInstantLuxon({ year: 2026, month: 11, day: 2, minutesSinceMidnight: -1 }, UTC),
    ).toThrow(/must be an integer in 0-1440, got -1/);
    expect(() =>
      resolveLocalInstantLuxon({ year: 2026, month: 11, day: 2, minutesSinceMidnight: 12.5 }, UTC),
    ).toThrow(/must be an integer in 0-1440, got 12.5/);
    expect(() =>
      resolveLocalInstantLuxon(
        { year: 2026, month: 11, day: 2, minutesSinceMidnight: 0 },
        'local' as TimeZone,
      ),
    ).toThrow(/'local' is not a valid IANA time zone/);
    expect(() =>
      resolveLocalInstantLuxon(
        { year: 275760, month: 9, day: 13, minutesSinceMidnight: 1440 },
        UTC,
      ),
    ).toThrow(/the day after 275760-9-13/);
  });
});

describe('DST transitions through the default (the matrix is task 115’s)', () => {
  // America/New_York 2026: spring forward 2026-03-08 (02:00 EST → 03:00 EDT),
  // fall back 2026-11-01 (02:00 EDT → 01:00 EST). Both dates are Sundays.
  const newYork = (windows: PeakWindow[]): PeakHoursConfig => ({
    timezone: 'America/New_York',
    offPeakMultiplier: 0.5,
    windows,
  });

  it('stretches a window across the fall-back overlap to its real duration', () => {
    const timeline = calculatePeakHoursIntervals(
      newYork([window({ days: ['sun'], start: '01:00', end: '02:00' })]),
      { from: iso('2026-11-01T00:00:00Z'), to: iso('2026-11-02T00:00:00Z') },
    );
    expect(
      timeline.intervals.map((interval) => [interval.kind, interval.start, interval.end]),
    ).toEqual([
      ['off-peak', iso('2026-11-01T00:00:00Z'), iso('2026-11-01T05:00:00Z')],
      // 01:00 EDT = 05:00Z; 02:00 EST = 07:00Z — one wall-clock hour is two
      // real hours around the transition (§9.3 “duration can differ”).
      ['peak', iso('2026-11-01T05:00:00Z'), iso('2026-11-01T07:00:00Z')],
      ['off-peak', iso('2026-11-01T07:00:00Z'), iso('2026-11-02T00:00:00Z')],
    ]);
    expect(timeline.intervals[1]).toMatchObject({
      localStart: '2026-11-01T01:00',
      localEnd: '2026-11-01T02:00',
    });
  });

  it('drops a window that collapses entirely into the spring-forward gap', () => {
    const timeline = calculatePeakHoursIntervals(
      newYork([window({ days: ['sun'], start: '02:00', end: '03:00' })]),
      { from: iso('2026-03-08T00:00:00Z'), to: iso('2026-03-09T00:00:00Z') },
    );
    expect(timeline.intervals.map((interval) => interval.kind)).toEqual(['off-peak']);
  });

  it('applies the post-transition offset to windows after the jump', () => {
    const timeline = calculatePeakHoursIntervals(
      newYork([window({ days: ['sun'], start: '03:00', end: '04:00' })]),
      { from: iso('2026-03-08T00:00:00Z'), to: iso('2026-03-09T00:00:00Z') },
    );
    expect(
      timeline.intervals.map((interval) => [interval.kind, interval.start, interval.end]),
    ).toEqual([
      ['off-peak', iso('2026-03-08T00:00:00Z'), iso('2026-03-08T07:00:00Z')],
      // 03:00 EDT = 07:00Z (UTC-4 after the jump from UTC-5).
      ['peak', iso('2026-03-08T07:00:00Z'), iso('2026-03-08T08:00:00Z')],
      ['off-peak', iso('2026-03-08T08:00:00Z'), iso('2026-03-09T00:00:00Z')],
    ]);
  });
});

describe('midnight-gap zones keep every local day (the count-bounded walk)', () => {
  // America/Havana springs forward 2026-03-08 at 00:00 → 01:00: a day
  // cursor stepped through the gap keeps the 01:00 wall clock forever
  // after, and a loop bounded by comparing cursor instants would silently
  // drop the range's last local day (review finding, task 114). These
  // regressions pin the walk's arithmetic, not §9.3's DST policy — the
  // transition matrix remains task 115's, which should also include
  // midnight-transition zones (Havana, Cairo, Santiago) for this reason.
  const havana = (windows: PeakWindow[]): PeakHoursConfig => ({
    timezone: 'America/Havana',
    offPeakMultiplier: 0.5,
    windows,
  });

  it('emits the last local day’s window across the midnight gap', () => {
    const timeline = calculatePeakHoursIntervals(
      havana([window({ days: ['thu'], start: '10:00', end: '12:00' })]),
      { from: iso('2026-03-08T00:00:00Z'), to: iso('2026-03-13T00:00:00Z') },
    );
    expect(
      timeline.intervals.map((interval) => [interval.kind, interval.start, interval.end]),
    ).toEqual([
      ['off-peak', iso('2026-03-08T00:00:00Z'), iso('2026-03-12T14:00:00Z')],
      // Thursday 2026-03-12 10:00–12:00 Cuba Summer Time (UTC−4 after the
      // 2026-03-08 jump from UTC−5) = 14:00–16:00Z.
      ['peak', iso('2026-03-12T14:00:00Z'), iso('2026-03-12T16:00:00Z')],
      ['off-peak', iso('2026-03-12T16:00:00Z'), iso('2026-03-13T00:00:00Z')],
    ]);
  });

  it('keeps the last local day of a range that starts right after the transition', () => {
    const timeline = calculatePeakHoursIntervals(
      havana([window({ days: ['wed'], start: '08:00', end: '09:00' })]),
      { from: iso('2026-03-09T12:00:00Z'), to: iso('2026-03-11T23:00:00Z') },
    );
    expect(
      timeline.intervals.map((interval) => [interval.kind, interval.start, interval.end]),
    ).toEqual([
      ['off-peak', iso('2026-03-09T12:00:00Z'), iso('2026-03-11T12:00:00Z')],
      // Wednesday 2026-03-11 08:00–09:00 (UTC−4) = 12:00–13:00Z.
      ['peak', iso('2026-03-11T12:00:00Z'), iso('2026-03-11T13:00:00Z')],
      ['off-peak', iso('2026-03-11T13:00:00Z'), iso('2026-03-11T23:00:00Z')],
    ]);
  });
});

describe('gap-shifted windows overlap in instant space; the timeline unions them (D-079)', () => {
  // §9.3's gap shift is not monotone in wall order: on New York's
  // 2026-03-08 gap day, nonexistent 02:10 resolves past the real 03:10, so
  // wall-disjoint §9.2-valid windows can cover overlapping — even
  // identical — instants. The partition contract survives by union
  // clipping: chronological, adjacent, single coverage.
  const gapDay = (windows: PeakWindow[]): PeakHoursConfig => ({
    timezone: 'America/New_York',
    offPeakMultiplier: 0.5,
    windows,
  });
  const range = { from: iso('2026-03-08T00:00:00Z'), to: iso('2026-03-09T00:00:00Z') };

  it('emits one peak where two windows resolve to identical instants', () => {
    // 02:10–02:50 (entirely inside the gap) and 03:10–03:50 both resolve
    // to [07:10Z, 07:50Z) — wall 02:10 shifted by the 60-minute gap *is*
    // wall 03:10. The union is one peak; the earlier-listed window is the
    // one reported (stable sort at equal start and end).
    const timeline = calculatePeakHoursIntervals(
      gapDay([
        window({ id: 'w-gap', name: 'Gap window', days: ['sun'], start: '02:10', end: '02:50' }),
        window({ id: 'w-after', name: 'After gap', days: ['sun'], start: '03:10', end: '03:50' }),
      ]),
      range,
    );
    expect(
      timeline.intervals.map((interval) => [interval.kind, interval.start, interval.end]),
    ).toEqual([
      ['off-peak', iso('2026-03-08T00:00:00Z'), iso('2026-03-08T07:10:00Z')],
      ['peak', iso('2026-03-08T07:10:00Z'), iso('2026-03-08T07:50:00Z')],
      ['off-peak', iso('2026-03-08T07:50:00Z'), iso('2026-03-09T00:00:00Z')],
    ]);
    expect(timeline.intervals[1]).toMatchObject({ windowId: 'w-gap' });
  });

  it('clips a partially overlapping occurrence and reports the clipped local time', () => {
    // 02:15–02:45 → [07:15Z, 07:45Z) and 03:15–03:20 → [07:15Z, 07:20Z):
    // the shorter occurrence sorts first, the longer is clipped to start at
    // its own uncovered stretch, and the clipped start renders truthfully.
    const timeline = calculatePeakHoursIntervals(
      gapDay([
        window({ id: 'w-gap', name: 'Gap window', days: ['sun'], start: '02:15', end: '02:45' }),
        window({ id: 'w-after', name: 'After gap', days: ['sun'], start: '03:15', end: '03:20' }),
      ]),
      range,
    );
    expect(
      timeline.intervals.map((interval) => [
        interval.kind,
        interval.start,
        interval.end,
        interval.multiplier,
      ]),
    ).toEqual([
      ['off-peak', iso('2026-03-08T00:00:00Z'), iso('2026-03-08T07:15:00Z'), 0.5],
      ['peak', iso('2026-03-08T07:15:00Z'), iso('2026-03-08T07:20:00Z'), 1],
      ['peak', iso('2026-03-08T07:20:00Z'), iso('2026-03-08T07:45:00Z'), 1],
      ['off-peak', iso('2026-03-08T07:45:00Z'), iso('2026-03-09T00:00:00Z'), 0.5],
    ]);
    expect(timeline.intervals[1]).toMatchObject({
      windowId: 'w-after',
      localStart: '2026-03-08T03:15',
      localEnd: '2026-03-08T03:20',
    });
    // The clipped peak reports the instants it actually spans: 07:20Z
    // reads 03:20 EDT.
    expect(timeline.intervals[2]).toMatchObject({
      windowId: 'w-gap',
      localStart: '2026-03-08T03:20',
      localEnd: '2026-03-08T03:45',
    });
  });

  it('drops an occurrence fully covered by an earlier one', () => {
    // 02:30–03:45 → [07:30Z, 07:45Z) sits inside 02:00–04:00 →
    // [07:00Z, 08:00Z): after the longer peak, the inner one clips to
    // nothing and disappears.
    const timeline = calculatePeakHoursIntervals(
      gapDay([
        window({ id: 'w-big', name: 'Big', days: ['sun'], start: '02:00', end: '04:00' }),
        window({ id: 'w-inner', name: 'Inner', days: ['sun'], start: '02:30', end: '03:45' }),
      ]),
      range,
    );
    expect(
      timeline.intervals.map((interval) => [interval.kind, interval.start, interval.end]),
    ).toEqual([
      ['off-peak', iso('2026-03-08T00:00:00Z'), iso('2026-03-08T07:00:00Z')],
      ['peak', iso('2026-03-08T07:00:00Z'), iso('2026-03-08T08:00:00Z')],
      ['off-peak', iso('2026-03-08T08:00:00Z'), iso('2026-03-09T00:00:00Z')],
    ]);
    expect(timeline.intervals[1]).toMatchObject({ windowId: 'w-big' });
  });
});
