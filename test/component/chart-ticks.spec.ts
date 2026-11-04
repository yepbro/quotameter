import { describe, expect, it } from 'vitest';
import type { ChartWindow } from '../../ui/src/charts/annotations';
import { chartTicks, chooseTickStep, TICK_STEPS } from '../../ui/src/charts/ticks';

/**
 * The §14.4 axis-tick engine (task 177; decision D-150): tick instants
 * aligned to LOCAL hour/day/month boundaries of the configured display
 * zone, DST transitions included. Every fixture pins an explicit zone and
 * literal epochs (the D-097 convention), so the suite stays green under
 * any process `TZ` — the engine reads no machine-local state (§10, the
 * D-021 discipline mirrored client-side; the manual matrix run under
 * several `TZ` values is the recorded evidence).
 *
 * The DST facts under test (all verified against the zone data):
 *
 * - America/New_York 2026-03-08: a 23-hour local day (02:00 EST → 03:00
 *   EDT) — wall 02:00 exists nowhere; local midnights Mar 8 → Mar 9 sit
 *   23 h apart (1772946000000 → 1773028800000).
 * - America/New_York 2026-11-01: a 25-hour local day (02:00 EDT → 01:00
 *   EST) — wall 01:00 exists TWICE (05:00Z EDT and 06:00Z EST); local
 *   midnights Nov 1 → Nov 2 sit 25 h apart (1793505600000 → 1793595600000).
 * - Australia/Lord_Howe: ±30-minute DST shifts at wall 02:00 — the spring
 *   day (2026-10-04) has NO wall 02:00 (01:00 → 03:00 spans 90 real
 *   minutes), and a uniform epoch ladder can never express the zone's
 *   boundary phase at all (its offsets are +10:30/+11).
 * - America/Havana 2026-03-08: the transition sits AT midnight — wall
 *   00:00 does not exist; the local day starts at 01:00 (05:00Z).
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A window plus a plot width wide enough to force the finest ladder. */
const WIDE = 100_000;

function windowOf(from: number, spanMs: number): ChartWindow {
  return { from, to: from + spanMs };
}

function instantsOf(ticks: ReturnType<typeof chartTicks>): number[] {
  return ticks.map((tick) => tick.at);
}

function labelsOf(ticks: ReturnType<typeof chartTicks>): string[] {
  return ticks.map((tick) => tick.label);
}

/** The consecutive epoch distances between ticks — the DST spacing oracle. */
function gapsOf(values: readonly number[]): number[] {
  return values.slice(1).map((value, index) => value - values[index]!);
}

/* ── Granularity selection (the density ladder) ────────────────────────── */

describe('chooseTickStep (span × plot width)', () => {
  it('walks the ladder finest-first by label-gap budget', () => {
    expect(chooseTickStep(2 * HOUR, 824)).toEqual({ kind: 'hour', step: 1 });
    expect(chooseTickStep(24 * HOUR, 824)).toEqual({ kind: 'hour', step: 3 });
    expect(chooseTickStep(24 * HOUR, 284)).toEqual({ kind: 'hour', step: 12 });
    expect(chooseTickStep(7 * DAY, 824)).toEqual({ kind: 'day', step: 1 });
    expect(chooseTickStep(30 * DAY, 824)).toEqual({ kind: 'day', step: 7 });
    // §14.1's 360 px canvas: its 284 px plot still carries 7-day labels.
    expect(chooseTickStep(30 * DAY, 284)).toEqual({ kind: 'day', step: 7 });
    // A 117-day span goes 14-day before months while the plot is wide…
    expect(chooseTickStep(117 * DAY, 824)).toEqual({ kind: 'day', step: 14 });
    // …and month-granular once the 14-day labels stop fitting.
    expect(chooseTickStep(117 * DAY, 500)).toEqual({ kind: 'month', step: 1 });
    expect(chooseTickStep(212 * DAY, 224)).toEqual({ kind: 'month', step: 3 });
  });

  it('answers the coarsest step when nothing fits, and the finest for tiny spans', () => {
    // §11.3's retention ceiling (3650 days) exceeds every budget.
    expect(chooseTickStep(3650 * DAY, 824)).toEqual(TICK_STEPS[TICK_STEPS.length - 1]);
    expect(chooseTickStep(30 * MINUTE, 284)).toEqual({ kind: 'hour', step: 1 });
  });
});

/* ── Hour-boundary alignment ───────────────────────────────────────────── */

describe('chartTicks: hour alignment', () => {
  it('ticks every local hour of a plain UTC day, from included, to excluded', () => {
    const ticks = chartTicks(windowOf(Date.UTC(2026, 10, 4), DAY), 'UTC', WIDE);
    expect(instantsOf(ticks)).toEqual(
      Array.from({ length: 24 }, (_unused, index) => Date.UTC(2026, 10, 4) + index * HOUR),
    );
    expect(labelsOf(ticks)[0]).toBe('12 AM');
    expect(labelsOf(ticks)[13]).toBe('1 PM');
    // A no-transition zone never suffixes — one reading per wall hour.
    expect(labelsOf(ticks).every((label) => !label.includes('GMT') && !label.includes('UTC'))).toBe(
      true,
    );
  });

  it('anchors steps to wall hours divisible by the step (00/03/06/… for 3 h)', () => {
    const ticks = chartTicks(windowOf(Date.UTC(2026, 10, 4), DAY), 'UTC', 824);
    expect(labelsOf(ticks)).toEqual([
      '12 AM',
      '3 AM',
      '6 AM',
      '9 AM',
      '12 PM',
      '3 PM',
      '6 PM',
      '9 PM',
    ]);
  });

  it('aligns a +05:45 zone to ITS hour boundaries (:15 UTC-minutes)', () => {
    // Asia/Kathmandu: local midnight is 18:15Z — a uniform epoch ladder
    // anchored anywhere cannot hit these instants.
    const from = Date.UTC(2026, 10, 3, 18, 15);
    const ticks = chartTicks(windowOf(from, DAY), 'Asia/Kathmandu', WIDE);
    expect(instantsOf(ticks)[0]).toBe(from);
    expect(gapsOf(instantsOf(ticks))).toEqual(Array.from({ length: 23 }, () => HOUR));
    expect(labelsOf(ticks)[0]).toBe('12 AM');
  });
});

/* ── DST hour days — the §14.4 done-condition ──────────────────────────── */

describe('chartTicks: DST transition days (hour granularity)', () => {
  it('a 23-hour day: the skipped wall hour has no tick; offsets follow the zone', () => {
    // America/New_York 2026-03-08, local midnight to local midnight = 23 h.
    const from = 1_772_946_000_000; // 2026-03-08T05:00:00Z = Mar 8, 12:00 AM EST
    const ticks = chartTicks(windowOf(from, 23 * HOUR), 'America/New_York', WIDE);
    expect(ticks).toHaveLength(23);
    expect(labelsOf(ticks)).not.toContain('2 AM');
    // The wall sequence jumps 1 AM → 3 AM while the epoch spacing stays
    // one real hour — the transition instant itself is a boundary.
    expect(labelsOf(ticks).slice(0, 4)).toEqual(['12 AM', '1 AM', '3 AM EDT', '4 AM']);
    expect(gapsOf(instantsOf(ticks))).toEqual(Array.from({ length: 22 }, () => HOUR));
    expect(instantsOf(ticks).at(-1)).toBe(Date.UTC(2026, 2, 9, 3)); // 11 PM EDT
  });

  it('a 25-hour day: the duplicated wall hour ticks twice, zone-disambiguated', () => {
    // America/New_York 2026-11-01, local midnight to local midnight = 25 h.
    const from = 1_793_505_600_000; // 2026-11-01T04:00:00Z = Nov 1, 12:00 AM EDT
    const ticks = chartTicks(windowOf(from, 25 * HOUR), 'America/New_York', WIDE);
    expect(ticks).toHaveLength(25);
    expect(gapsOf(instantsOf(ticks))).toEqual(Array.from({ length: 24 }, () => HOUR));
    // Wall 01:00 exists at 05:00Z (EDT) and 06:00Z (EST) — both tick, and
    // BOTH carry the zone name so the pair never reads indistinguishably.
    expect(labelsOf(ticks).slice(0, 4)).toEqual(['12 AM', '1 AM EDT', '1 AM EST', '2 AM']);
    expect(instantsOf(ticks).slice(1, 3)).toEqual([
      Date.UTC(2026, 10, 1, 5),
      Date.UTC(2026, 10, 1, 6),
    ]);
  });

  it('a ±30-minute zone: boundaries follow the actual offsets (Lord Howe)', () => {
    // Spring 2026-10-04 (02:00 +10:30 → 02:30 +11): wall 02:00 does not
    // exist; the 01:00 → 03:00 boundary gap is 90 real minutes.
    const springFrom = 1_791_034_200_000; // 2026-10-03T13:30:00Z = Oct 4, 12:00 AM +10:30
    const spring = chartTicks(windowOf(springFrom, 23.5 * HOUR), 'Australia/Lord_Howe', WIDE);
    expect(spring).toHaveLength(23);
    expect(labelsOf(spring)).not.toContain('2 AM');
    const springGaps = gapsOf(instantsOf(spring));
    expect(springGaps.filter((gap) => gap !== HOUR)).toEqual([1.5 * HOUR]);
    // The first tick after the shift states its offset.
    expect(labelsOf(spring).slice(1, 4)).toEqual(['1 AM', '3 AM GMT+11', '4 AM']);

    // Fall 2026-04-05 (02:00 +11 → 01:30 +10:30): every wall hour exists;
    // the 01:00 → 02:00 boundary gap is 90 real minutes the other way.
    const fallFrom = 1_775_307_600_000; // 2026-04-04T13:00:00Z = Apr 5, 12:00 AM +11
    const fall = chartTicks(windowOf(fallFrom, 24.5 * HOUR), 'Australia/Lord_Howe', WIDE);
    expect(fall).toHaveLength(24);
    const fallGaps = gapsOf(instantsOf(fall));
    expect(fallGaps.filter((gap) => gap !== HOUR)).toEqual([1.5 * HOUR]);
    expect(labelsOf(fall).slice(1, 4)).toEqual(['1 AM', '2 AM GMT+10:30', '3 AM']);
  });

  it('a two-hour fall-back disambiguates every duplicated wall hour (Antarctica/Troll)', () => {
    // 2026-10-25 (03:00 +02 → 01:00 +00): BOTH wall 01:00 and wall 02:00
    // occur twice — the disambiguation is global over the ladder, so no
    // same-reading pair renders indistinguishably (the review round's P2).
    const from = Date.UTC(2026, 9, 24, 22);
    const ticks = chartTicks(windowOf(from, 26 * HOUR), 'Antarctica/Troll', WIDE);
    const oneOclocks = labelsOf(ticks).filter((label) => label.startsWith('1 AM'));
    const twoOclocks = labelsOf(ticks).filter((label) => label.startsWith('2 AM'));
    expect(oneOclocks).toHaveLength(2);
    expect(twoOclocks).toHaveLength(2);
    expect(oneOclocks).not.toContain('1 AM');
    expect(twoOclocks).not.toContain('2 AM');
    // The two readings of one wall hour differ by their zone names.
    expect(new Set(twoOclocks).size).toBe(2);
    expect(new Set(oneOclocks).size).toBe(2);
  });
});

/* ── Day and month granularity ─────────────────────────────────────────── */

describe('chartTicks: day alignment', () => {
  it('local midnights sit 23 h apart across a spring-forward day (New York)', () => {
    const from = Date.UTC(2026, 2, 6, 12);
    // Plot 300 px: the 12-hour rung no longer fits, the walk is daily.
    const ticks = chartTicks(windowOf(from, 2.75 * DAY), 'America/New_York', 300);
    expect(instantsOf(ticks)).toEqual([
      Date.UTC(2026, 2, 7, 5), // Mar 7, 12:00 AM EST
      1_772_946_000_000, // Mar 8, 12:00 AM EST = 2026-03-08T05:00:00Z
      1_773_028_800_000, // Mar 9, 12:00 AM EDT = 2026-03-09T04:00:00Z (−1 h)
    ]);
    expect(gapsOf(instantsOf(ticks))).toEqual([DAY, 23 * HOUR]);
    expect(labelsOf(ticks)).toEqual(['Mar 7', 'Mar 8', 'Mar 9']);
  });

  it('local midnights sit 25 h apart across a fall-back day (New York)', () => {
    const from = Date.UTC(2026, 9, 30, 12);
    const ticks = chartTicks(windowOf(from, 2.75 * DAY), 'America/New_York', 300);
    expect(instantsOf(ticks)).toEqual([
      Date.UTC(2026, 9, 31, 4), // Oct 31, 12:00 AM EDT
      1_793_505_600_000, // Nov 1, 12:00 AM EDT = 2026-11-01T04:00:00Z
      1_793_595_600_000, // Nov 2, 12:00 AM EST = 2026-11-02T05:00:00Z (+1 h)
    ]);
    expect(gapsOf(instantsOf(ticks))).toEqual([DAY, 25 * HOUR]);
  });

  it("a skipped midnight ticks at the day's actual first instant (Havana)", () => {
    // 2026-03-08: the transition sits AT wall midnight — 00:00 does not
    // exist, the local day starts at 01:00 (05:00Z), still labeled by its
    // date. Midnight-to-first-instant reads 24 h; the next midnight 23 h.
    const from = Date.UTC(2026, 2, 5, 12);
    const ticks = chartTicks(windowOf(from, 4.5 * DAY), 'America/Havana', 300);
    expect(instantsOf(ticks)).toEqual([
      Date.UTC(2026, 2, 6, 5),
      Date.UTC(2026, 2, 7, 5),
      Date.UTC(2026, 2, 8, 5), // Mar 8 starts here (01:00 CDT)
      Date.UTC(2026, 2, 9, 4),
    ]);
    expect(gapsOf(instantsOf(ticks))).toEqual([DAY, DAY, 23 * HOUR]);
    expect(labelsOf(ticks)[2]).toBe('Mar 8');
  });

  it('a skipped calendar day leaves one tick per instant (Pacific/Apia 2011)', () => {
    // 2011-12-30 does not exist in Apia (the Date Line moved −10 → +14):
    // the skipped day's anchor and the next day's resolve to the SAME
    // instant, which renders once, labeled by its actual wall date.
    const from = Date.UTC(2011, 11, 28, 12);
    const ticks = chartTicks(windowOf(from, 4.5 * DAY), 'Pacific/Apia', 300);
    const values = instantsOf(ticks);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain(Date.UTC(2011, 11, 30, 10));
    expect(labelsOf(ticks)).toContain('Dec 31');
    expect(labelsOf(ticks)).not.toContain('Dec 30');
  });

  it('a 7-day step anchors to epoch-day indices — one weekday all axis', () => {
    const from = Date.UTC(2026, 10, 4);
    const ticks = chartTicks(windowOf(from, 30 * DAY), 'UTC', 824);
    // The oracle is the definition itself: every epoch day divisible by 7.
    const expected: number[] = [];
    for (let day = 0; day < 30; day++) {
      const at = from + day * DAY;
      if ((at / DAY) % 7 === 0) expected.push(at);
    }
    expect(expected.length).toBeGreaterThan(3);
    expect(instantsOf(ticks)).toEqual(expected);
    expect(gapsOf(instantsOf(ticks))).toEqual(
      Array.from({ length: expected.length - 1 }, () => 7 * DAY),
    );
  });
});

describe('chartTicks: month alignment', () => {
  it('walks calendar month starts with the year in every label', () => {
    const from = Date.UTC(2026, 8, 15);
    const ticks = chartTicks(windowOf(from, 117 * DAY), 'UTC', 500);
    expect(instantsOf(ticks)).toEqual([
      Date.UTC(2026, 9, 1),
      Date.UTC(2026, 10, 1),
      Date.UTC(2026, 11, 1),
      Date.UTC(2027, 0, 1),
    ]);
    expect(labelsOf(ticks)).toEqual(['Oct 2026', 'Nov 2026', 'Dec 2026', 'Jan 2027']);
  });

  it('a 3-month step anchors to calendar quarters', () => {
    const from = Date.UTC(2026, 7, 1);
    const ticks = chartTicks(windowOf(from, 212 * DAY), 'UTC', 300);
    expect(instantsOf(ticks)).toEqual([Date.UTC(2026, 9, 1), Date.UTC(2027, 0, 1)]);
    expect(labelsOf(ticks)).toEqual(['Oct 2026', 'Jan 2027']);
  });
});

/* ── Degenerate spans ──────────────────────────────────────────────────── */

describe('chartTicks: degenerate spans', () => {
  it('a sub-hour window renders only the boundaries it contains — none invented', () => {
    expect(chartTicks(windowOf(Date.UTC(2026, 10, 4, 12, 10), 30 * MINUTE), 'UTC', WIDE)).toEqual(
      [],
    );
    const one = chartTicks(windowOf(Date.UTC(2026, 10, 4, 11, 30), 40 * MINUTE), 'UTC', WIDE);
    expect(instantsOf(one)).toEqual([Date.UTC(2026, 10, 4, 12)]);
  });

  it('an empty, inverted, or zero-width span answers no ticks', () => {
    const from = Date.UTC(2026, 10, 4, 12);
    expect(chartTicks({ from, to: from }, 'UTC', WIDE)).toEqual([]);
    expect(chartTicks({ from, to: from - HOUR }, 'UTC', WIDE)).toEqual([]);
    expect(chartTicks(windowOf(from, DAY), 'UTC', 0)).toEqual([]);
  });
});
