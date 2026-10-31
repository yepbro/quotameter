import { describe, expect, it } from 'vitest';
import { epochMsFromIso } from '../../src/util/clock';
import { calculatePeakHoursIntervals } from '../../src/services/peak-hours-intervals';
import type { PeakHoursConfig, PeakWindow } from '../../src/schemas/config';

/**
 * The §17.1 time-zone transition matrix through the whole calculator
 * (task 115, decision D-079): the zones the spec names for DST-transition
 * coverage — `America/New_York`, `Europe/London`, `Asia/Shanghai`,
 * `Asia/Kolkata`, `Australia/Lord_Howe`, `Pacific/Chatham`, `UTC` — plus
 * `America/Havana` (a spring gap that starts at midnight, the shape task
 * 114's review required the matrix to include) and `Asia/Singapore` (the
 * §9.1 production schedule zone). What is pinned per DST zone: the 23- and
 * 25-hour days (§17.1), windows that stretch or collapse across the
 * transition, half-hour and quarter-hour transitions, `24:00` ends through
 * transitions, and the gap-shift semantics (a window entirely inside a gap
 * keeps its wall duration — §9.3 "duration can differ").
 *
 * Expected instants are hand-derived from the zones' 2026 transition facts
 * (annotated per case; verified against the tz database on the pinned
 * runtime) — never from the module under test, so the suite never depends
 * on the host `TZ` (the D-073 invariance discipline).
 */

/** `epochMsFromIso` under a shorter name — every expected instant goes through it. */
const iso = epochMsFromIso;

/** A valid peak window with overridable fields (the §9.2 sample shape). */
const window = (overrides: Partial<PeakWindow> = {}): PeakWindow => ({
  id: 'w1',
  name: 'W1',
  days: ['sun'],
  start: '14:00',
  end: '18:00',
  ...overrides,
});

/** A schedule section with overridable fields. */
const schedule = (timezone: string, windows: PeakWindow[]): PeakHoursConfig => ({
  timezone,
  offPeakMultiplier: 0.5,
  windows,
});

/** `[kind, start, end]` of every interval — the shape the matrix asserts. */
const shape = (timeline: ReturnType<typeof calculatePeakHoursIntervals>) =>
  timeline.intervals.map((interval) => [interval.kind, interval.start, interval.end]);

describe('23- and 25-hour days (§17.1) — full-day windows across the transition', () => {
  it('America/New_York: 2026-03-08 has 23 hours, 2026-11-01 has 25', () => {
    const spring = calculatePeakHoursIntervals(
      schedule('America/New_York', [window({ start: '00:00', end: '24:00' })]),
      { from: iso('2026-03-07T12:00:00Z'), to: iso('2026-03-09T12:00:00Z') },
    );
    expect(shape(spring)).toEqual([
      ['off-peak', iso('2026-03-07T12:00:00Z'), iso('2026-03-08T05:00:00Z')],
      // Day start 00:00 EST = 05:00Z; day end 24:00 = 2026-03-09 00:00 EDT
      // = 04:00Z — one hour of the wall day never happened.
      ['peak', iso('2026-03-08T05:00:00Z'), iso('2026-03-09T04:00:00Z')],
      ['off-peak', iso('2026-03-09T04:00:00Z'), iso('2026-03-09T12:00:00Z')],
    ]);
    const fall = calculatePeakHoursIntervals(
      schedule('America/New_York', [window({ start: '00:00', end: '24:00' })]),
      { from: iso('2026-10-31T12:00:00Z'), to: iso('2026-11-02T12:00:00Z') },
    );
    expect(shape(fall)).toEqual([
      ['off-peak', iso('2026-10-31T12:00:00Z'), iso('2026-11-01T04:00:00Z')],
      // 00:00 EDT = 04:00Z; 24:00 = 2026-11-02 00:00 EST = 05:00Z — the
      // repeated hour makes the wall day 25 real hours.
      ['peak', iso('2026-11-01T04:00:00Z'), iso('2026-11-02T05:00:00Z')],
      ['off-peak', iso('2026-11-02T05:00:00Z'), iso('2026-11-02T12:00:00Z')],
    ]);
  });

  it('Europe/London: the same pair around its own dates', () => {
    const spring = calculatePeakHoursIntervals(
      schedule('Europe/London', [window({ start: '00:00', end: '24:00' })]),
      { from: iso('2026-03-28T12:00:00Z'), to: iso('2026-03-30T12:00:00Z') },
    );
    expect(shape(spring)).toEqual([
      ['off-peak', iso('2026-03-28T12:00:00Z'), iso('2026-03-29T00:00:00Z')],
      // 00:00 GMT = 00:00Z; 24:00 = 2026-03-30 00:00 BST = 2026-03-29T23:00Z.
      ['peak', iso('2026-03-29T00:00:00Z'), iso('2026-03-29T23:00:00Z')],
      ['off-peak', iso('2026-03-29T23:00:00Z'), iso('2026-03-30T12:00:00Z')],
    ]);
    const fall = calculatePeakHoursIntervals(
      schedule('Europe/London', [window({ start: '00:00', end: '24:00' })]),
      { from: iso('2026-10-24T12:00:00Z'), to: iso('2026-10-26T12:00:00Z') },
    );
    expect(shape(fall)).toEqual([
      ['off-peak', iso('2026-10-24T12:00:00Z'), iso('2026-10-24T23:00:00Z')],
      // 00:00 BST = 2026-10-24T23:00Z; 24:00 = 2026-10-26 00:00 GMT = 00:00Z.
      ['peak', iso('2026-10-24T23:00:00Z'), iso('2026-10-26T00:00:00Z')],
      ['off-peak', iso('2026-10-26T00:00:00Z'), iso('2026-10-26T12:00:00Z')],
    ]);
  });

  it('America/Havana: a 23-hour day born from a midnight gap', () => {
    const timeline = calculatePeakHoursIntervals(
      schedule('America/Havana', [window({ start: '00:00', end: '24:00' })]),
      { from: iso('2026-03-07T12:00:00Z'), to: iso('2026-03-09T12:00:00Z') },
    );
    expect(shape(timeline)).toEqual([
      ['off-peak', iso('2026-03-07T12:00:00Z'), iso('2026-03-08T05:00:00Z')],
      // The day starts nonexistent (00:00 is in the gap and shifts to the
      // 01:00 CDT instant 05:00Z) and ends at 2026-03-09 00:00 CDT = 04:00Z.
      ['peak', iso('2026-03-08T05:00:00Z'), iso('2026-03-09T04:00:00Z')],
      ['off-peak', iso('2026-03-09T04:00:00Z'), iso('2026-03-09T12:00:00Z')],
    ]);
  });
});

describe('windows across a spring-forward gap', () => {
  it('keeps the wall duration of a window entirely inside the gap (shift by the exact gap)', () => {
    // New York's gap is [02:00, 03:00) on 2026-03-08: every minute of
    // 02:10–02:50 is nonexistent, both edges shift by the same 60 minutes,
    // and the peak is the real 03:10–03:50 — 40 wall minutes, 40 real
    // minutes (§9.3: only transitions *inside* a window change duration).
    const timeline = calculatePeakHoursIntervals(
      schedule('America/New_York', [window({ start: '02:10', end: '02:50' })]),
      { from: iso('2026-03-08T00:00:00Z'), to: iso('2026-03-09T00:00:00Z') },
    );
    expect(shape(timeline)).toEqual([
      ['off-peak', iso('2026-03-08T00:00:00Z'), iso('2026-03-08T07:10:00Z')],
      ['peak', iso('2026-03-08T07:10:00Z'), iso('2026-03-08T07:50:00Z')],
      ['off-peak', iso('2026-03-08T07:50:00Z'), iso('2026-03-09T00:00:00Z')],
    ]);
  });

  it('drops a window whose shifted start passes its real end', () => {
    // 02:30 shifts to the 03:30 instant (07:30Z) but 03:30 exists (07:30Z):
    // the edges meet and the window collapses to nothing.
    const timeline = calculatePeakHoursIntervals(
      schedule('America/New_York', [window({ start: '02:30', end: '03:30' })]),
      { from: iso('2026-03-08T00:00:00Z'), to: iso('2026-03-09T00:00:00Z') },
    );
    expect(shape(timeline)).toEqual([
      ['off-peak', iso('2026-03-08T00:00:00Z'), iso('2026-03-09T00:00:00Z')],
    ]);
  });

  it('shrinks a window straddling the gap to its surviving part', () => {
    // 01:30 EST = 06:30Z; 03:00 EDT = 07:00Z — one wall hour and a half,
    // thirty real minutes.
    const timeline = calculatePeakHoursIntervals(
      schedule('America/New_York', [window({ start: '01:30', end: '03:00' })]),
      { from: iso('2026-03-08T00:00:00Z'), to: iso('2026-03-09T00:00:00Z') },
    );
    expect(shape(timeline)).toEqual([
      ['off-peak', iso('2026-03-08T00:00:00Z'), iso('2026-03-08T06:30:00Z')],
      ['peak', iso('2026-03-08T06:30:00Z'), iso('2026-03-08T07:00:00Z')],
      ['off-peak', iso('2026-03-08T07:00:00Z'), iso('2026-03-09T00:00:00Z')],
    ]);
  });

  it('Australia/Lord_Howe: shifts by the 30-minute gap inside [02:00, 02:30)', () => {
    // 02:15–03:00 on 2026-10-04: the start is nonexistent (shifts 30 minutes
    // to the 02:45 +11:00 instant, 15:45Z) and the end exists (16:00Z):
    // 45 wall minutes become 15 real minutes.
    const timeline = calculatePeakHoursIntervals(
      schedule('Australia/Lord_Howe', [window({ start: '02:15', end: '03:00' })]),
      { from: iso('2026-10-03T12:00:00Z'), to: iso('2026-10-04T12:00:00Z') },
    );
    expect(shape(timeline)).toEqual([
      ['off-peak', iso('2026-10-03T12:00:00Z'), iso('2026-10-03T15:45:00Z')],
      ['peak', iso('2026-10-03T15:45:00Z'), iso('2026-10-03T16:00:00Z')],
      ['off-peak', iso('2026-10-03T16:00:00Z'), iso('2026-10-04T12:00:00Z')],
    ]);
  });

  it('Pacific/Chatham: a quarter-hour zone, gap [02:45, 03:45)', () => {
    // 03:00–03:30 on 2026-09-27 lies inside the gap; both edges shift by
    // the full hour: the window is the real 04:00–04:30 at +13:45
    // (14:15Z–14:45Z), wall duration intact.
    const timeline = calculatePeakHoursIntervals(
      schedule('Pacific/Chatham', [window({ start: '03:00', end: '03:30' })]),
      { from: iso('2026-09-26T12:00:00Z'), to: iso('2026-09-27T12:00:00Z') },
    );
    expect(shape(timeline)).toEqual([
      ['off-peak', iso('2026-09-26T12:00:00Z'), iso('2026-09-26T14:15:00Z')],
      ['peak', iso('2026-09-26T14:15:00Z'), iso('2026-09-26T14:45:00Z')],
      ['off-peak', iso('2026-09-26T14:45:00Z'), iso('2026-09-27T12:00:00Z')],
    ]);
  });
});

describe('windows across a fall-back overlap', () => {
  it('America/New_York: one wall hour is two real hours (first occurrence at both edges)', () => {
    // 01:00 first occurrence = 05:00Z (EDT); 02:00 exists once at EST =
    // 07:00Z — the §9.3 "duration can differ" sentence itself.
    const timeline = calculatePeakHoursIntervals(
      schedule('America/New_York', [window({ start: '01:00', end: '02:00' })]),
      { from: iso('2026-11-01T00:00:00Z'), to: iso('2026-11-02T00:00:00Z') },
    );
    expect(shape(timeline)).toEqual([
      ['off-peak', iso('2026-11-01T00:00:00Z'), iso('2026-11-01T05:00:00Z')],
      ['peak', iso('2026-11-01T05:00:00Z'), iso('2026-11-01T07:00:00Z')],
      ['off-peak', iso('2026-11-01T07:00:00Z'), iso('2026-11-02T00:00:00Z')],
    ]);
    expect(timeline.intervals[1]).toMatchObject({
      localStart: '2026-11-01T01:00',
      localEnd: '2026-11-01T02:00',
    });
  });

  it('Australia/Lord_Howe: a 30-minute overlap stretches 30 wall minutes to 60', () => {
    // 01:30 first occurrence (+11:00) = 2026-04-04T14:30Z; 02:00 exists at
    // +10:30 = 15:30Z.
    const timeline = calculatePeakHoursIntervals(
      schedule('Australia/Lord_Howe', [window({ start: '01:30', end: '02:00' })]),
      { from: iso('2026-04-04T12:00:00Z'), to: iso('2026-04-05T12:00:00Z') },
    );
    expect(shape(timeline)).toEqual([
      ['off-peak', iso('2026-04-04T12:00:00Z'), iso('2026-04-04T14:30:00Z')],
      ['peak', iso('2026-04-04T14:30:00Z'), iso('2026-04-04T15:30:00Z')],
      ['off-peak', iso('2026-04-04T15:30:00Z'), iso('2026-04-05T12:00:00Z')],
    ]);
  });

  it('Pacific/Chatham: the window exactly covering the repeated hour stretches by it', () => {
    // The repeated interval is [02:45, 03:45) itself: first 02:45 (+13:45) =
    // 2026-04-04T13:00Z; 03:45 exists at +12:45 = 15:00Z — 60 wall minutes,
    // 120 real ones.
    const timeline = calculatePeakHoursIntervals(
      schedule('Pacific/Chatham', [window({ start: '02:45', end: '03:45' })]),
      { from: iso('2026-04-04T12:00:00Z'), to: iso('2026-04-05T12:00:00Z') },
    );
    expect(shape(timeline)).toEqual([
      ['off-peak', iso('2026-04-04T12:00:00Z'), iso('2026-04-04T13:00:00Z')],
      ['peak', iso('2026-04-04T13:00:00Z'), iso('2026-04-04T15:00:00Z')],
      ['off-peak', iso('2026-04-04T15:00:00Z'), iso('2026-04-05T12:00:00Z')],
    ]);
  });

  it('America/Havana: the window starting on the ambiguous midnight', () => {
    // 00:00 first occurrence (CDT) = 04:00Z; 01:00 exists at CST = 06:00Z.
    const timeline = calculatePeakHoursIntervals(
      schedule('America/Havana', [window({ start: '00:00', end: '01:00' })]),
      { from: iso('2026-10-31T12:00:00Z'), to: iso('2026-11-01T12:00:00Z') },
    );
    expect(shape(timeline)).toEqual([
      ['off-peak', iso('2026-10-31T12:00:00Z'), iso('2026-11-01T04:00:00Z')],
      ['peak', iso('2026-11-01T04:00:00Z'), iso('2026-11-01T06:00:00Z')],
      ['off-peak', iso('2026-11-01T06:00:00Z'), iso('2026-11-01T12:00:00Z')],
    ]);
  });
});

describe('`24:00` ends through transitions', () => {
  it('a Saturday window ending at the gapped midnight meets Sunday at the shifted instant', () => {
    // Saturday 2026-03-07 22:00–24:00 in Havana: 22:00 CST = 03:00Z, the
    // 24:00 end is the nonexistent 2026-03-08 00:00 → 05:00Z.
    const timeline = calculatePeakHoursIntervals(
      schedule('America/Havana', [window({ days: ['sat'], start: '22:00', end: '24:00' })]),
      { from: iso('2026-03-07T00:00:00Z'), to: iso('2026-03-08T12:00:00Z') },
    );
    expect(shape(timeline)).toEqual([
      ['off-peak', iso('2026-03-07T00:00:00Z'), iso('2026-03-08T03:00:00Z')],
      ['peak', iso('2026-03-08T03:00:00Z'), iso('2026-03-08T05:00:00Z')],
      ['off-peak', iso('2026-03-08T05:00:00Z'), iso('2026-03-08T12:00:00Z')],
    ]);
    // The ending midnight renders as the wall time it shifted to.
    expect(timeline.intervals[1]).toMatchObject({ localEnd: '2026-03-08T01:00' });
  });

  it('a window ending at `24:00` of the gap day itself ends at the ordinary next midnight', () => {
    // Sunday 2026-03-08 (the gap day) 22:00–24:00 in Havana: the end is the
    // *wall reading* 00:00 of Monday 2026-03-09 — an ordinary midnight at
    // CDT = 04:00Z. The day's own shifted midnight must not leak into the
    // window end (the Luxon compat resolver lands an hour later here; the
    // authoritative normalization is pinned in `peak-hours-dst.spec.ts`,
    // decision D-079).
    const timeline = calculatePeakHoursIntervals(
      schedule('America/Havana', [window({ start: '22:00', end: '24:00' })]),
      { from: iso('2026-03-08T00:00:00Z'), to: iso('2026-03-09T12:00:00Z') },
    );
    expect(shape(timeline)).toEqual([
      ['off-peak', iso('2026-03-08T00:00:00Z'), iso('2026-03-09T02:00:00Z')],
      // 22:00 CDT (UTC−4) = 2026-03-09T02:00Z; 24:00 = 2026-03-09 00:00 CDT
      // = 04:00Z.
      ['peak', iso('2026-03-09T02:00:00Z'), iso('2026-03-09T04:00:00Z')],
      ['off-peak', iso('2026-03-09T04:00:00Z'), iso('2026-03-09T12:00:00Z')],
    ]);
    expect(timeline.intervals[1]).toMatchObject({ localEnd: '2026-03-09T00:00' });
  });
});

describe('zones without DST stay exact (§17.1: Shanghai, Kolkata, UTC; production: Singapore)', () => {
  it('Asia/Shanghai and Asia/Kolkata: full-day windows are exactly 24 hours', () => {
    const shanghai = calculatePeakHoursIntervals(
      // July 1 2026 is a Wednesday in Shanghai (UTC+8, local days run
      // 16:00Z to 16:00Z).
      schedule('Asia/Shanghai', [window({ days: ['wed'], start: '00:00', end: '24:00' })]),
      { from: iso('2026-06-30T12:00:00Z'), to: iso('2026-07-02T12:00:00Z') },
    );
    expect(shape(shanghai)).toEqual([
      ['off-peak', iso('2026-06-30T12:00:00Z'), iso('2026-06-30T16:00:00Z')],
      // China is UTC+8 without DST: local midnight is 16:00Z year-round.
      ['peak', iso('2026-06-30T16:00:00Z'), iso('2026-07-01T16:00:00Z')],
      ['off-peak', iso('2026-07-01T16:00:00Z'), iso('2026-07-02T12:00:00Z')],
    ]);
    const kolkata = calculatePeakHoursIntervals(
      schedule('Asia/Kolkata', [window({ days: ['wed'], start: '00:00', end: '24:00' })]),
      { from: iso('2026-06-30T12:00:00Z'), to: iso('2026-07-02T12:00:00Z') },
    );
    // +5:30: the local day 2026-07-01 spans 2026-06-30T18:30Z → 2026-07-01T18:30Z.
    expect(shape(kolkata)).toEqual([
      ['off-peak', iso('2026-06-30T12:00:00Z'), iso('2026-06-30T18:30:00Z')],
      ['peak', iso('2026-06-30T18:30:00Z'), iso('2026-07-01T18:30:00Z')],
      ['off-peak', iso('2026-07-01T18:30:00Z'), iso('2026-07-02T12:00:00Z')],
    ]);
  });

  it('Asia/Singapore: the production schedule stays exact across any DST date', () => {
    // The §9.1 Z.ai weekday window through New York's fall-back date —
    // Singapore never transitions: 14:00–18:00 SGT = 06:00–10:00Z.
    const timeline = calculatePeakHoursIntervals(
      schedule('Asia/Singapore', [
        window({
          id: 'zai-peak',
          name: 'Z.ai Coding Plan peak hours',
          days: ['mon', 'tue', 'wed', 'thu', 'fri'],
          start: '14:00',
          end: '18:00',
        }),
      ]),
      { from: iso('2026-10-30T00:00:00Z'), to: iso('2026-11-03T00:00:00Z') },
    );
    const peaks = timeline.intervals.filter((interval) => interval.kind === 'peak');
    expect(peaks.map((peak) => [peak.start, peak.end, peak.windowId])).toEqual([
      // Friday 2026-10-30 and Monday 2026-11-02 in Singapore; the weekend
      // between them selects no day.
      [iso('2026-10-30T06:00:00Z'), iso('2026-10-30T10:00:00Z'), 'zai-peak'],
      [iso('2026-11-02T06:00:00Z'), iso('2026-11-02T10:00:00Z'), 'zai-peak'],
    ]);
  });

  it('UTC: no transitions, the anchor for every other row', () => {
    // Monday 2026-06-01, default 14:00–18:00 window.
    const timeline = calculatePeakHoursIntervals(schedule('UTC', [window({ days: ['mon'] })]), {
      from: iso('2026-06-01T00:00:00Z'),
      to: iso('2026-06-02T00:00:00Z'),
    });
    expect(shape(timeline)).toEqual([
      ['off-peak', iso('2026-06-01T00:00:00Z'), iso('2026-06-01T14:00:00Z')],
      ['peak', iso('2026-06-01T14:00:00Z'), iso('2026-06-01T18:00:00Z')],
      ['off-peak', iso('2026-06-01T18:00:00Z'), iso('2026-06-02T00:00:00Z')],
    ]);
  });
});
