import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { calculatePeakHoursIntervals } from '../../src/services/peak-hours-intervals';
import type { PeakHoursTimeline } from '../../src/services/peak-hours-intervals';
import type { PeakWindow, PeakHoursConfig, ProvidersConfig } from '../../src/schemas/config';
import { intervalViews, resolveSchedule, scheduleFactsOf } from '../../src/server/api/peak-hours';
import type { PeakHoursIntervalItem } from '../../src/schemas/api/peak-hours';
import { PeakHoursResponseSchema } from '../../src/schemas/api/peak-hours';
import { epochMsFromIso } from '../../src/util/clock';

/**
 * The §13 peak-hours view compositions (task 162, decision D-142): the pure
 * halves of `src/server/api/peak-hours.ts` — the schedule resolution, the
 * schedule facts, and the timeline→wire bridge — plus the done-condition's
 * core proof: the server's wire encoding of the task-114/115 DST matrix.
 * Every matrix case below re-uses a fixture whose expected instants the
 * landed suites derived by hand from the zones' 2026 transition facts, wraps
 * the timeline in a complete response envelope, validates it through the
 * compiled contract, and deep-equals the intervals — so the endpoint's
 * served output agrees with the configured timezone/DST tests, not just the
 * service underneath it. All epochs are pinned literals (the D-073
 * invariance discipline — this suite runs under the §17.1 TZ matrix).
 */

/** `epochMsFromIso` under a shorter name — every epoch goes through it. */
const iso = epochMsFromIso;

/** The §9.1 sample window: Z.ai weekday peak in the schedule zone. */
const zaiWindow: PeakWindow = {
  id: 'zai-weekday-peak',
  name: 'Z.ai Coding Plan peak hours',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  start: '14:00',
  end: '18:00',
  multiplier: 1.0,
};

/** The §9.1 sample schedule. */
const zaiSchedule: PeakHoursConfig = {
  timezone: 'Asia/Singapore',
  offPeakMultiplier: 0.5,
  windows: [zaiWindow],
};

/** One peak wire entry; the window identity defaults to the §9.1 sample. */
const peak = (
  start: number,
  end: number,
  localStart: string,
  localEnd: string,
  identity: { windowId: string; name: string } = {
    windowId: 'zai-weekday-peak',
    name: 'Z.ai Coding Plan peak hours',
  },
): PeakHoursIntervalItem => ({
  kind: 'peak',
  start,
  end,
  multiplier: 1.0,
  ...identity,
  localStart,
  localEnd,
});

/** One off-peak wire entry. */
const offPeak = (
  start: number,
  end: number,
  localStart: string,
  localEnd: string,
): PeakHoursIntervalItem => ({
  kind: 'off-peak',
  start,
  end,
  multiplier: 0.5,
  localStart,
  localEnd,
});

/** The window identity the matrix schedules below override the sample with. */
const W1 = { windowId: 'w1', name: 'W1' } as const;

/* ── The schedule resolution and facts ──────────────────────────────────── */

describe('resolveSchedule (the §9.2 no-schedule arm)', () => {
  it('resolves the provider’s own schedule from the live section', () => {
    const schedules: ProvidersConfig = {
      'zai-coding-plan': { peakHours: zaiSchedule },
    };
    expect(resolveSchedule(schedules, 'zai-coding-plan')).toBe(zaiSchedule);
  });

  it('answers null for a provider the configuration does not carry', () => {
    expect(resolveSchedule({}, 'zai-coding-plan')).toBe(null);
    // The empty section object is the composition reader's own default
    // (`currentConfig().providers ?? {}`): an absent section and an absent
    // entry are the same not-configured fact.
    expect(
      resolveSchedule({ 'other-provider': { peakHours: zaiSchedule } }, 'zai-coding-plan'),
    ).toBe(null);
  });

  it('keeps an empty-windows schedule a schedule (§9.2’s unverified shape)', () => {
    const empty: PeakHoursConfig = { timezone: 'Asia/Singapore', windows: [] };
    expect(resolveSchedule({ p: { peakHours: empty } }, 'p')).toBe(empty);
  });
});

describe('scheduleFactsOf (the response’s schedule echoes)', () => {
  it('answers nulls exactly when no schedule is configured', () => {
    expect(scheduleFactsOf(null)).toEqual({ timezone: null, offPeakMultiplier: null });
  });

  it('defaults the off-peak multiplier the way the calculator does (drift row)', () => {
    const withoutMultiplier: PeakHoursConfig = { timezone: 'UTC', windows: [] };
    expect(scheduleFactsOf(withoutMultiplier)).toEqual({ timezone: 'UTC', offPeakMultiplier: 1 });
    // The same two values the calculator puts on its timeline — the wire
    // and the computed intervals cannot disagree.
    const timeline = calculatePeakHoursIntervals(withoutMultiplier, {
      from: iso('2026-10-19T00:00:00Z'),
      to: iso('2026-10-19T01:00:00Z'),
    });
    expect(scheduleFactsOf(withoutMultiplier)).toEqual({
      timezone: timeline.timezone,
      offPeakMultiplier: timeline.offPeakMultiplier,
    });
    const zaiTimeline = calculatePeakHoursIntervals(zaiSchedule, {
      from: iso('2026-10-19T00:00:00Z'),
      to: iso('2026-10-19T01:00:00Z'),
    });
    expect(scheduleFactsOf(zaiSchedule)).toEqual({
      timezone: zaiTimeline.timezone,
      offPeakMultiplier: zaiTimeline.offPeakMultiplier,
    });
  });
});

/* ── The timeline→wire bridge ──────────────────────────────────────────── */

describe('intervalViews (the verbatim bridge)', () => {
  it('copies the timeline’s intervals field-for-field', () => {
    const timeline = calculatePeakHoursIntervals(zaiSchedule, {
      from: iso('2026-10-19T00:00:00Z'),
      to: iso('2026-10-20T00:00:00Z'),
    });
    const views = intervalViews(timeline);
    expect(views).toHaveLength(timeline.intervals.length);
    for (const [index, view] of views.entries()) {
      expect(view).toEqual({ ...timeline.intervals[index] });
    }
    // The peak entry carries §9.3's whole output vocabulary.
    expect(views[1]).toEqual(
      peak(
        iso('2026-10-19T06:00:00Z'),
        iso('2026-10-19T10:00:00Z'),
        '2026-10-19T14:00',
        '2026-10-19T18:00',
      ),
    );
  });
});

/* ── The DST matrix on the wire (the done-condition’s proof) ────────────── */

/** Wraps one timeline in the complete response envelope the route serves. */
function responseAround(
  timeline: PeakHoursTimeline,
  from: number,
  to: number,
): {
  accountId: string;
  providerId: string;
  timezone: string | null;
  offPeakMultiplier: number | null;
  range: Record<string, unknown>;
  intervals: PeakHoursIntervalItem[];
} {
  return {
    accountId: 'work',
    providerId: 'zai-coding-plan',
    // The timeline's own facts — equal to scheduleFactsOf's output by the
    // drift row above, so the envelope matches what the route serves.
    timezone: timeline.timezone,
    offPeakMultiplier: timeline.offPeakMultiplier,
    range: {
      outcome: 'ok',
      requestedFrom: from,
      requestedTo: to,
      effectiveFrom: from,
      effectiveTo: to,
      retentionHorizon: null,
    },
    intervals: intervalViews(timeline),
  };
}

/**
 * The standing proof: the served envelope validates against the compiled
 * contract, the intervals partition the range (chronological, adjacent,
 * covering), and they equal the matrix suites' hand-derived expectations
 * verbatim — epochs and local times alike.
 */
function expectServedTimeline(
  schedule: PeakHoursConfig,
  from: number,
  to: number,
  expected: PeakHoursIntervalItem[],
): void {
  const timeline = calculatePeakHoursIntervals(schedule, { from, to });
  const body = responseAround(timeline, from, to);
  const validate = new Ajv2020().compile(PeakHoursResponseSchema);
  expect(validate(body), JSON.stringify(body)).toBe(true);
  // The partition contract (D-073): a non-empty timeline covers the range,
  // adjacent, ordered (the degenerate range's empty timeline skips this).
  if (body.intervals.length > 0) {
    expect(body.intervals[0]).toMatchObject({ start: from });
    expect(body.intervals[body.intervals.length - 1]).toMatchObject({ end: to });
  }
  for (const [index, interval] of body.intervals.entries()) {
    expect(interval.end).toBeGreaterThan(interval.start);
    if (index > 0) {
      expect(interval.start).toBe(body.intervals[index - 1]!.end);
    }
  }
  expect(body.intervals).toEqual(expected);
}

describe('the §9.1 production schedule on the wire', () => {
  it('serves the Z.ai weekday week in Asia/Singapore with exact local times', () => {
    expectServedTimeline(
      zaiSchedule,
      iso('2026-10-19T00:00:00Z'), // a Monday
      iso('2026-10-21T00:00:00Z'), // Wednesday
      [
        offPeak(
          iso('2026-10-19T00:00:00Z'),
          iso('2026-10-19T06:00:00Z'),
          '2026-10-19T08:00',
          '2026-10-19T14:00',
        ),
        peak(
          iso('2026-10-19T06:00:00Z'),
          iso('2026-10-19T10:00:00Z'),
          '2026-10-19T14:00',
          '2026-10-19T18:00',
        ),
        offPeak(
          iso('2026-10-19T10:00:00Z'),
          iso('2026-10-20T06:00:00Z'),
          '2026-10-19T18:00',
          '2026-10-20T14:00',
        ),
        peak(
          iso('2026-10-20T06:00:00Z'),
          iso('2026-10-20T10:00:00Z'),
          '2026-10-20T14:00',
          '2026-10-20T18:00',
        ),
        offPeak(
          iso('2026-10-20T10:00:00Z'),
          iso('2026-10-21T00:00:00Z'),
          '2026-10-20T18:00',
          '2026-10-21T08:00',
        ),
      ],
    );
  });

  it('serves the empty-windows schedule as the whole-range off-peak partition', () => {
    expectServedTimeline(
      { timezone: 'Asia/Singapore', windows: [] },
      iso('2026-10-19T00:00:00Z'),
      iso('2026-10-19T01:00:00Z'),
      // No windows and no offPeakMultiplier: §9.2's default 1.0 applies —
      // the unverified-schedule shape still partitions, at the base rate.
      [
        {
          kind: 'off-peak',
          start: iso('2026-10-19T00:00:00Z'),
          end: iso('2026-10-19T01:00:00Z'),
          multiplier: 1,
          localStart: '2026-10-19T08:00',
          localEnd: '2026-10-19T09:00',
        },
      ],
    );
  });

  it('serves the degenerate range as the empty timeline', () => {
    expectServedTimeline(zaiSchedule, iso('2026-10-19T00:00:00Z'), iso('2026-10-19T00:00:00Z'), []);
  });
});

describe('the §17.1 DST transition matrix on the wire', () => {
  it('America/New_York: the 23-hour spring day and the 25-hour fall day', () => {
    const fullDay = (timezone: string): PeakHoursConfig => ({
      timezone,
      offPeakMultiplier: 0.5,
      windows: [
        { ...zaiWindow, id: 'w1', name: 'W1', days: ['sun'], start: '00:00', end: '24:00' },
      ],
    });
    expectServedTimeline(
      fullDay('America/New_York'),
      iso('2026-03-07T12:00:00Z'),
      iso('2026-03-09T12:00:00Z'),
      [
        offPeak(
          iso('2026-03-07T12:00:00Z'),
          iso('2026-03-08T05:00:00Z'),
          '2026-03-07T07:00',
          '2026-03-08T00:00',
        ),
        // 00:00 EST = 05:00Z through the 24:00 end = 2026-03-09 00:00 EDT
        // = 04:00Z — one wall hour of the day never happened.
        peak(
          iso('2026-03-08T05:00:00Z'),
          iso('2026-03-09T04:00:00Z'),
          '2026-03-08T00:00',
          '2026-03-09T00:00',
          W1,
        ),
        offPeak(
          iso('2026-03-09T04:00:00Z'),
          iso('2026-03-09T12:00:00Z'),
          '2026-03-09T00:00',
          '2026-03-09T08:00',
        ),
      ],
    );
    expectServedTimeline(
      fullDay('America/New_York'),
      iso('2026-10-31T12:00:00Z'),
      iso('2026-11-02T12:00:00Z'),
      [
        offPeak(
          iso('2026-10-31T12:00:00Z'),
          iso('2026-11-01T04:00:00Z'),
          '2026-10-31T08:00',
          '2026-11-01T00:00',
        ),
        // The repeated hour makes the wall day 25 real hours.
        peak(
          iso('2026-11-01T04:00:00Z'),
          iso('2026-11-02T05:00:00Z'),
          '2026-11-01T00:00',
          '2026-11-02T00:00',
          W1,
        ),
        offPeak(
          iso('2026-11-02T05:00:00Z'),
          iso('2026-11-02T12:00:00Z'),
          '2026-11-02T00:00',
          '2026-11-02T07:00',
        ),
      ],
    );
  });

  it('America/Havana: the day born from a midnight gap', () => {
    expectServedTimeline(
      {
        timezone: 'America/Havana',
        offPeakMultiplier: 0.5,
        windows: [
          { ...zaiWindow, id: 'w1', name: 'W1', days: ['sun'], start: '00:00', end: '24:00' },
        ],
      },
      iso('2026-03-07T12:00:00Z'),
      iso('2026-03-09T12:00:00Z'),
      [
        offPeak(
          iso('2026-03-07T12:00:00Z'),
          iso('2026-03-08T05:00:00Z'),
          '2026-03-07T07:00',
          // The off-peak stretch ends AT the shifted midnight instant
          // (00:00 was nonexistent); its truthful local rendering is 01:00
          // — the same shifted wall time the peak starts at (D-073).
          '2026-03-08T01:00',
        ),
        // The day starts nonexistent (00:00 is inside the gap, shifts to
        // the 01:00 CDT instant) — the wire renders the instants it spans.
        peak(
          iso('2026-03-08T05:00:00Z'),
          iso('2026-03-09T04:00:00Z'),
          '2026-03-08T01:00',
          '2026-03-09T00:00',
          W1,
        ),
        offPeak(
          iso('2026-03-09T04:00:00Z'),
          iso('2026-03-09T12:00:00Z'),
          '2026-03-09T00:00',
          '2026-03-09T08:00',
        ),
      ],
    );
  });

  it('Australia/Lord_Howe: the 30-minute spring gap, half an hour off UTC', () => {
    expectServedTimeline(
      {
        timezone: 'Australia/Lord_Howe',
        offPeakMultiplier: 0.5,
        windows: [
          { ...zaiWindow, id: 'w1', name: 'W1', days: ['sun'], start: '02:15', end: '03:00' },
        ],
      },
      iso('2026-10-03T12:00:00Z'),
      iso('2026-10-04T12:00:00Z'),
      [
        offPeak(
          iso('2026-10-03T12:00:00Z'),
          iso('2026-10-03T15:45:00Z'),
          '2026-10-03T22:30',
          '2026-10-04T02:45',
        ),
        // The nonexistent 02:15 start shifts by the exact 30-minute gap to
        // the 02:45 +11:00 instant: 45 wall minutes are 15 real ones.
        peak(
          iso('2026-10-03T15:45:00Z'),
          iso('2026-10-03T16:00:00Z'),
          '2026-10-04T02:45',
          '2026-10-04T03:00',
          W1,
        ),
        offPeak(
          iso('2026-10-03T16:00:00Z'),
          iso('2026-10-04T12:00:00Z'),
          '2026-10-04T03:00',
          '2026-10-04T23:00',
        ),
      ],
    );
  });

  it('Pacific/Chatham: the quarter-hour zone’s hour-wide gap', () => {
    expectServedTimeline(
      {
        timezone: 'Pacific/Chatham',
        offPeakMultiplier: 0.5,
        windows: [
          { ...zaiWindow, id: 'w1', name: 'W1', days: ['sun'], start: '03:00', end: '03:30' },
        ],
      },
      iso('2026-09-26T12:00:00Z'),
      iso('2026-09-27T12:00:00Z'),
      [
        offPeak(
          iso('2026-09-26T12:00:00Z'),
          iso('2026-09-26T14:15:00Z'),
          '2026-09-27T00:45',
          '2026-09-27T04:00',
        ),
        // Both edges sit inside [02:45, 03:45): each shifts by the full
        // hour — the window is the real 04:00–04:30 at +13:45.
        peak(
          iso('2026-09-26T14:15:00Z'),
          iso('2026-09-26T14:45:00Z'),
          '2026-09-27T04:00',
          '2026-09-27T04:30',
          W1,
        ),
        offPeak(
          iso('2026-09-26T14:45:00Z'),
          iso('2026-09-27T12:00:00Z'),
          '2026-09-27T04:30',
          '2026-09-28T01:45',
        ),
      ],
    );
  });

  it('Asia/Kolkata: the half-hour fixed-offset zone clips at the range edge', () => {
    expectServedTimeline(
      {
        timezone: 'Asia/Kolkata',
        offPeakMultiplier: 0.5,
        windows: [
          { ...zaiWindow, id: 'w1', name: 'W1', days: ['mon'], start: '14:00', end: '18:00' },
        ],
      },
      iso('2026-10-19T00:00:00Z'),
      iso('2026-10-19T12:00:00Z'),
      [
        offPeak(
          iso('2026-10-19T00:00:00Z'),
          iso('2026-10-19T08:30:00Z'),
          '2026-10-19T05:30',
          '2026-10-19T14:00',
        ),
        // 14:00 IST = 08:30Z; the window's 18:00 end (12:30Z) lies beyond
        // the range, so the peak clips at `to` and the wire renders the
        // clipped boundary's own local time (D-073).
        peak(
          iso('2026-10-19T08:30:00Z'),
          iso('2026-10-19T12:00:00Z'),
          '2026-10-19T14:00',
          '2026-10-19T17:30',
          W1,
        ),
      ],
    );
  });
});
