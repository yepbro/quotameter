/**
 * The §14.4 chart-axis tick engine (task 177, spec §10, §14.4; decision
 * D-150) — pure functions that choose the x-axis tick INSTANTS of the metric
 * charts and the label of each, aligned to local hour/day/month boundaries
 * in the CONFIGURED display zone (§10: `Intl.DateTimeFormat` with an
 * explicit `timeZone`; never machine-local time — the D-021 discipline
 * mirrored client-side, so every suite pins zones explicitly and stays
 * green under any process `TZ`).
 *
 * Pinned interpretations:
 *
 * - **Why ticks are computed here at all.** ECharts' value axis places
 *   ticks on a uniform epoch-milliseconds ladder (`intervalScaleNiceTicks`
 *   anchors at multiples of the interval); a uniform ladder cannot express
 *   local boundaries — a +05:45 zone's hours sit at :15 UTC-minutes, and a
 *   DST transition shifts the phase mid-window. The engine walks the zone's
 *   ACTUAL boundaries: instants whose wall clock in the zone reads
 *   minute-and-second zero (hour granularity) or local midnight
 *   (day/month). On a 23-hour spring-forward day the skipped wall hour
 *   simply has no tick; on a 25-hour fall-back day the duplicated wall hour
 *   ticks twice, one real hour apart.
 * - **Delivery: `customValues`.** ECharts 6's value axis accepts explicit
 *   tick values through `axisLabel.customValues` / `axisTick.customValues`
 *   (verified against the 6.1.0 source: the arrays are the tick set,
 *   filtered to the extent and still formatted through the axis formatter)
 *   — the option builder passes this module's instants there, on BOTH the
 *   main and the strip x-axis (D-149's aligned pair).
 * - **Granularity.** A wall-clock step ladder — 1/2/3/6/12 hours, 1/2/7/14
 *   days, 1/3/6 months — walked finest-first; a step is used when its
 *   labels fit the plot width ({@link HOUR_LABEL_GAP_PX} et al., derived
 *   from the longest label shape at ECharts' 12 px axis font). Hour steps
 *   anchor to wall hours divisible by the step; day steps to epoch-day
 *   indices (a 7-day step lands on the same weekdays across the window);
 *   month steps to calendar month starts.
 * - **DST disambiguation.** A tick whose wall reading occurs more than
 *   once in the window (a 25-hour day's duplicated hour — or several,
 *   under a fall-back longer than an hour) or whose zone offset differs
 *   from the previous tick's renders with the zone's short name —
 *   "1 AM EDT" beside "1 AM EST" — never two indistinguishable labels.
 * - **Sub-hour spans.** §14.4's windows are the D-147 fixed ranges (24 h at
 *   the smallest), so the ladder starts at one hour; a degenerate sub-hour
 *   window renders its 0–1 contained boundaries rather than an invented
 *   sub-hour alignment (§14.4 names hour/day boundaries only).
 */

import type { ChartWindow } from './annotations';
import { formatChartDay, formatChartMonth, formatChartTime, formatChartZoneTime } from '../format';

/* ── Zone arithmetic (Intl-only; no machine-local paths) ───────────────── */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** One wall-clock reading of an instant in a zone. */
interface WallParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const wallPartFormats = new Map<string, Intl.DateTimeFormat>();

function wallPartFormat(timeZone: string): Intl.DateTimeFormat {
  let format = wallPartFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    wallPartFormats.set(timeZone, format);
  }
  return format;
}

/** Reads an instant's wall clock in `timeZone` (h23: midnight is hour 0). */
function wallOf(epochMs: number, timeZone: string): WallParts {
  const read: Record<string, number> = {};
  for (const part of wallPartFormat(timeZone).formatToParts(epochMs)) {
    if (part.type !== 'literal') read[part.type] = Number(part.value);
  }
  return {
    year: read.year ?? 1970,
    month: read.month ?? 1,
    day: read.day ?? 1,
    hour: read.hour ?? 0,
    minute: read.minute ?? 0,
    second: read.second ?? 0,
  };
}

/** Treats a wall-clock reading as if it were UTC — pure calendar math. */
function asUtcMs(wall: WallParts): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/** The zone's offset east of UTC at `epochMs`, in milliseconds. */
function offsetOf(epochMs: number, timeZone: string): number {
  return asUtcMs(wallOf(epochMs, timeZone)) - epochMs;
}

function sameWall(a: WallParts, b: WallParts): boolean {
  return asUtcMs(a) === asUtcMs(b);
}

/** Adds whole hours to a wall reading through UTC-space calendar math. */
function wallPlusHours(wall: WallParts, hours: number): WallParts {
  return wallOfUtc(asUtcMs(wall) + hours * HOUR_MS);
}

function wallOfDate(year: number, month: number, day: number): WallParts {
  return { year, month, day, hour: 0, minute: 0, second: 0 };
}

/** Reads a UTC instant's parts with the UTC calendar (pure math helper). */
function wallOfUtc(epochMs: number): WallParts {
  const date = new Date(epochMs);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function nextDay(wall: WallParts): WallParts {
  return wallOfUtc(Date.UTC(wall.year, wall.month - 1, wall.day) + DAY_MS);
}

function nextMonth(wall: WallParts): WallParts {
  const monthIndex = wall.year * 12 + (wall.month - 1) + 1;
  return wallOfDate(Math.floor(monthIndex / 12), (monthIndex % 12) + 1, 1);
}

/**
 * Resolves a wall-clock reading to its epoch instant. The two-probe
 * iteration converges for every existing wall time; an ambiguous reading
 * (a fall-back's duplicated hour) returns one genuine occurrence — which
 * one is probe luck (the D-079 discipline), and no ladder relies on the
 * choice. A SKIPPED reading (a spring-forward gap) has no instant; the
 * answer is the first instant whose wall clock reads later than the target
 * — the boundary's actual first instant (America/Havana's 2026-03-08
 * midnight does not exist: that day starts at 01:00).
 */
function resolveWall(wall: WallParts, timeZone: string): number {
  const target = asUtcMs(wall);
  const first = target - offsetOf(target, timeZone);
  const second = target - offsetOf(first, timeZone);
  if (offsetOf(second, timeZone) === offsetOf(first, timeZone)) {
    // Stable: `second` is the fixed point. Its wall reading equals the
    // target for every unambiguous reading; for a duplicated hour this is
    // one genuine occurrence.
    return second;
  }
  // Unstable — the reading is skipped or ambiguous. Prefer a probe whose
  // wall reading IS the target (ambiguous, an exact occurrence), else the
  // first probe reading later than the target (skipped: the post-gap
  // instant).
  if (sameWall(wallOf(first, timeZone), wall)) return first;
  if (sameWall(wallOf(second, timeZone), wall)) return second;
  if (asUtcMs(wall) < asUtcMs(wallOf(first, timeZone))) return first;
  return second;
}

/* ── The hour-boundary walk ────────────────────────────────────────────── */

function isHourAligned(wall: WallParts): boolean {
  return wall.minute === 0 && wall.second === 0;
}

function isMidnight(wall: WallParts): boolean {
  return wall.hour === 0 && isHourAligned(wall);
}

function zeroedWall(wall: WallParts): WallParts {
  return { ...wall, minute: 0, second: 0 };
}

/**
 * The smallest aligned wall hour at or after this reading: the reading
 * itself when aligned, else the next whole wall hour.
 */
function ceilToWallHour(wall: WallParts): WallParts {
  return isHourAligned(wall) ? wall : wallPlusHours(zeroedWall(wall), 1);
}

/**
 * Resolves a candidate aligned wall hour to an emitted boundary instant,
 * skipping wall hours the zone does not have: a spring-forward can skip
 * the very hour being resolved (Australia/Lord_Howe 2026-10-04 has no wall
 * 02:00), so a failed resolution advances hour by hour. The answer is
 * always `aligned && > after`; `null` only if no zone within three hours
 * cooperates (no known zone — the caller then keeps its probe).
 */
function resolveBoundaryHour(candidate: WallParts, after: number, timeZone: string): number | null {
  let wall = candidate;
  for (let attempt = 0; attempt < 3; attempt++) {
    const at = resolveWall(wall, timeZone);
    if (at > after && isHourAligned(wallOf(at, timeZone))) return at;
    wall = wallPlusHours(wall, 1);
  }
  return null;
}

/** The first hour-boundary instant at or after `from`. */
function firstHourBoundaryAtOrAfter(from: number, timeZone: string): number {
  const wall = wallOf(from, timeZone);
  if (isHourAligned(wall)) return from;
  return resolveBoundaryHour(ceilToWallHour(wall), from - 1, timeZone) ?? from + HOUR_MS;
}

/**
 * The next hour-boundary instant strictly after `t`. The probe-and-snap
 * walk is what makes shifted-phase zones work: `t + 1 h` lands mid-hour
 * whenever a transition moved the offset by less than an hour
 * (Australia/Lord_Howe's ±30 min), so the snap resolves the NEXT aligned
 * wall hour instead — the epoch distances between local hour boundaries
 * follow the zone's actual offsets (5 400 000 ms across Lord Howe's
 * transitions; 3 600 000 ms across New York's).
 */
function nextHourBoundaryAfter(t: number, timeZone: string): number {
  const probe = t + HOUR_MS;
  const probeWall = wallOf(probe, timeZone);
  if (isHourAligned(probeWall)) return probe;
  return resolveBoundaryHour(ceilToWallHour(probeWall), t, timeZone) ?? probe;
}

/* ── Granularity selection ─────────────────────────────────────────────── */

/** One ladder step: what aligns, and how wide its labels can get. */
export interface TickStep {
  readonly kind: 'hour' | 'day' | 'month';
  readonly step: number;
}

/**
 * The step ladder, finest first. Hour steps align to wall hours divisible
 * by the step (00, 03, 06, … for 3 h); day steps to epoch-day indices
 * divisible by the step; month steps to calendar month starts divisible by
 * the step.
 */
export const TICK_STEPS: readonly TickStep[] = Object.freeze([
  { kind: 'hour', step: 1 },
  { kind: 'hour', step: 2 },
  { kind: 'hour', step: 3 },
  { kind: 'hour', step: 6 },
  { kind: 'hour', step: 12 },
  { kind: 'day', step: 1 },
  { kind: 'day', step: 2 },
  { kind: 'day', step: 7 },
  { kind: 'day', step: 14 },
  { kind: 'month', step: 1 },
  { kind: 'month', step: 3 },
  { kind: 'month', step: 6 },
] as const);

/**
 * Minimum pixel distance between labels, per kind: the longest label shape
 * at ECharts' 12 px axis font ("12 AM EDT" ≈ 54 px, "Sep 22" ≈ 36 px,
 * "Nov 2026" ≈ 48 px) plus margin — §14.1's 360 px viewport must not
 * collide (its ~250 px plot holds three to four labels, not the 24 of a
 * raw hour ladder).
 */
const HOUR_LABEL_GAP_PX = 72;
const DAY_LABEL_GAP_PX = 64;
const MONTH_LABEL_GAP_PX = 64;

/** A step's nominal span in epoch milliseconds — an estimate for density. */
function approximateStepMs(step: TickStep): number {
  if (step.kind === 'hour') return step.step * HOUR_MS;
  if (step.kind === 'day') return step.step * DAY_MS;
  // The Gregorian month average; the walk itself is calendar-exact.
  return step.step * 30.44 * DAY_MS;
}

function labelGapPx(step: TickStep): number {
  if (step.kind === 'hour') return HOUR_LABEL_GAP_PX;
  if (step.kind === 'day') return DAY_LABEL_GAP_PX;
  return MONTH_LABEL_GAP_PX;
}

/**
 * Chooses the finest ladder step whose estimated labels fit the plot: the
 * first (finest-to-coarsest) whose average label gap stays above the
 * kind's minimum. A span no step can carry answers the coarsest step — an
 * honest coarse axis beats none.
 */
export function chooseTickStep(spanMs: number, plotWidthPx: number): TickStep {
  for (const step of TICK_STEPS) {
    const tickCount = spanMs / approximateStepMs(step);
    if (tickCount <= 1 || tickCount <= plotWidthPx / labelGapPx(step)) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1]!;
}

/* ── The walks ─────────────────────────────────────────────────────────── */

/** One chosen tick: the instant and its rendered label. */
export interface ChartTick {
  readonly at: number;
  readonly label: string;
}

/** A bound on every walk: the §11.3 retention ceiling walks months, not hours. */
const MAX_TICKS = 5_000;

/**
 * Walks the zone's hour boundaries (`firstHourBoundaryAtOrAfter` +
 * `nextHourBoundaryAfter`), emitting every `step`-th wall hour with the
 * DST-disambiguated label. Disambiguation is GLOBAL over the ladder, not
 * adjacency-local: every tick whose wall reading occurs more than once in
 * the window — any fall-back longer than an hour duplicates several wall
 * hours (Antarctica/Troll's two-hour shift repeats both 01:00 and 02:00)
 * — renders with the zone's short name, as does the first tick after an
 * offset change, so no two same-reading ticks are indistinguishable.
 */
function hourTicks(window: ChartWindow, timeZone: string, step: number): ChartTick[] {
  const instants: number[] = [];
  let at = firstHourBoundaryAtOrAfter(window.from, timeZone);
  while (at < window.to && instants.length < MAX_TICKS) {
    const wall = wallOf(at, timeZone);
    if (wall.hour % step === 0) instants.push(at);
    at = nextHourBoundaryAfter(at, timeZone);
  }
  const walls = instants.map((instant) => wallOf(instant, timeZone));
  const wallCounts = new Map<number, number>();
  for (const wall of walls) {
    const key = asUtcMs(wall);
    wallCounts.set(key, (wallCounts.get(key) ?? 0) + 1);
  }
  return instants.map((instant, index) => {
    const duplicated = (wallCounts.get(asUtcMs(walls[index]!)) ?? 0) > 1;
    const offsetChanged =
      index > 0 && offsetOf(instant, timeZone) !== offsetOf(instants[index - 1]!, timeZone);
    return {
      at: instant,
      label:
        duplicated || offsetChanged
          ? formatChartZoneTime(instant, timeZone)
          : formatChartTime(instant, timeZone),
    };
  });
}

/**
 * Walks local midnights, emitting every `step`-th epoch day index. A
 * SKIPPED calendar day (Pacific/Apia has no 2011-12-30 — the zone moved
 * the International Date Line) resolves to the same instant as the next
 * day, so equal consecutive instants dedupe to one tick.
 */
function dayTicks(window: ChartWindow, timeZone: string, step: number): ChartTick[] {
  const ticks: ChartTick[] = [];
  const startWall = wallOf(window.from, timeZone);
  let date = wallOfDate(startWall.year, startWall.month, startWall.day);
  if (!isMidnight(startWall)) date = nextDay(date);
  let lastAt = Number.NaN;
  for (let guard = 0; guard < MAX_TICKS; guard++) {
    const at = resolveWall(date, timeZone);
    if (at >= window.to) break;
    if (
      (Date.UTC(date.year, date.month - 1, date.day) / DAY_MS) % step === 0 &&
      at >= window.from &&
      at !== lastAt
    ) {
      ticks.push({ at, label: formatChartDay(at, timeZone) });
      lastAt = at;
    }
    date = nextDay(date);
  }
  return ticks;
}

/** Walks local month starts, emitting every `step`-th calendar month. */
function monthTicks(window: ChartWindow, timeZone: string, step: number): ChartTick[] {
  const ticks: ChartTick[] = [];
  const startWall = wallOf(window.from, timeZone);
  let date = wallOfDate(startWall.year, startWall.month, 1);
  if (startWall.day > 1) date = nextMonth(date);
  let lastAt = Number.NaN;
  for (let guard = 0; guard < MAX_TICKS; guard++) {
    const at = resolveWall(date, timeZone);
    if (at >= window.to) break;
    if ((date.year * 12 + (date.month - 1)) % step === 0 && at >= window.from && at !== lastAt) {
      ticks.push({ at, label: formatChartMonth(at, timeZone) });
      lastAt = at;
    }
    date = nextMonth(date);
  }
  return ticks;
}

/**
 * The x-axis ticks of one chart window in the configured display zone:
 * aligned local boundaries (the walk) at a density the plot width carries
 * (the step), each with its label. Half-open `[from, to)` — the right
 * window edge never renders a clipped label; a non-positive span or width
 * answers no ticks.
 */
export function chartTicks(
  window: ChartWindow,
  timeZone: string,
  plotWidthPx: number,
): ChartTick[] {
  const span = window.to - window.from;
  if (!(span > 0) || !(plotWidthPx > 0)) return [];
  const step = chooseTickStep(span, plotWidthPx);
  if (step.kind === 'hour') return hourTicks(window, timeZone, step.step);
  if (step.kind === 'day') return dayTicks(window, timeZone, step.step);
  return monthTicks(window, timeZone, step.step);
}
