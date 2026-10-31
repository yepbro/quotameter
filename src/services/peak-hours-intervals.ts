/**
 * Peak-hours interval calculation (spec §9.3, §10; task 114, decision D-073).
 *
 * `PeakHoursService`'s calculation half as a pure function: a validated
 * schedule (`PeakHoursConfig`, spec §9.2 — the configuration contract's
 * rules are never re-stated here) plus an explicit query range go in, and the
 * UTC timeline of peak and off-peak intervals comes out — every interval
 * carrying its exact boundaries as UTC epoch milliseconds (spec §10), the
 * window's id/name and multiplier, and the boundaries read back in the
 * schedule zone's local time. A window is the actual interval between its
 * local start/end instants, so its duration is wall-clock-true: it stretches
 * or shrinks across daylight-saving transitions (spec §9.3).
 *
 * Scope decisions (decision D-073):
 *
 * - The timeline **partitions** the whole query range: peak intervals are the
 *   window occurrences clipped to the range, off-peak intervals are the
 *   complement, and consecutive intervals touch. §13's endpoint promises
 *   "UTC peak/off-peak intervals", and a partition is what the chart
 *   highlighting (spec §9.3, §14) needs — no gaps, no double coverage.
 * - Intervals are half-open `[start, end)` in UTC epoch milliseconds; the
 *   range is `[from, to)` likewise. `from === to` is an empty timeline, not
 *   an error; anything non-finite or inverted fails loudly.
 * - The walk runs on **local calendar days** of the schedule zone (the day
 *   set of a window selects days there, spec §9.2), one day before the
 *   range's first local day included, so a window ending at `24:00` is
 *   considered even when only its final midnight lies inside the range.
 * - Converting a local wall-clock reading to an instant is exactly where
 *   §9.3's DST policy lives, and that policy is single-sited in
 *   `peak-hours-dst.ts` (task 115, decisions D-021 and D-079). This module
 *   routes every conversion through the injectable {@link
 *   LocalInstantResolver} seam; its default {@link resolveLocalInstantDst}
 *   computes §9.3's rules explicitly — nonexistent local times shift
 *   forward by the exact gap, ambiguous local times select the first
 *   occurrence. A window whose two edges resolve to the same instant or
 *   invert (a start inside a spring-forward gap whose shift passes the end)
 *   is dropped and its wall-clock span becomes off-peak.
 * - §9.3's gap shift is **not monotone** in wall order — a nonexistent
 *   02:30 resolves to the instant of 03:30, later than the real 03:00 — so
 *   two wall-disjoint windows of one day can cover overlapping instants.
 *   The walk therefore unions the peak occurrences: candidates are sorted
 *   by `(start, end)` and each start is clipped to the still-uncovered
 *   stretch (decision D-079, superseding D-073's monotonicity assumption),
 *   which keeps the partition contract — chronological, adjacent, single
 *   coverage — true for any resolver, monotone or not.
 * - No clock is read (D-021): the range endpoints are arguments, like the
 *   rolling-range bounds (D-068), and no function here consults the machine
 *   zone or `TZ`.
 */

import { DateTime } from 'luxon';
import { CONFIG_DEFAULTS, WEEK_DAYS } from '../schemas/config';
import type { PeakHoursConfig } from '../schemas/config';
import { isValidTimeZone, resolveTimeZone, zonedDateTime } from '../util/clock';
import type { EpochMs, TimeZone } from '../util/clock';
import { DAY_MS } from '../util/rolling-ranges';
import { resolveLocalInstantDst } from './peak-hours-dst';

/* ── Vocabulary ────────────────────────────────────────────────────────── */

/** Minutes in one local calendar day; `24:00` is minute 1440 (spec §9.2). */
export const MINUTES_PER_DAY = 1440;

/**
 * The largest query span the calculator accepts, in local days of the
 * schedule zone. History retention is capped at 3650 days (spec §11.3) and
 * §13 makes the routes truncate beyond retention; this bound just refuses,
 * loudly and before iterating, the spans whose day loop could never finish
 * (a full-range epoch query would walk billions of days).
 */
export const MAX_QUERY_SPAN_DAYS = 3660;

/** The explicit query range: `from` inclusive, `to` exclusive (D-073). */
export interface PeakHoursQueryRange {
  readonly from: EpochMs;
  readonly to: EpochMs;
}

/**
 * A local wall-clock reading in a schedule zone: a calendar date plus
 * minutes since local midnight, `0–1440`, where `1440` represents the
 * `24:00` window end — the midnight that ends the day (spec §9.2).
 */
export interface LocalScheduleTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  /** Minutes since local midnight; `1440` means the following day's 00:00. */
  readonly minutesSinceMidnight: number;
}

/**
 * The local-time → instant seam — the single place §9.3's DST policy is
 * applied (decision D-021; made explicit by task 115, decision D-079).
 * Receives the branded zone this module already validated; returns the UTC
 * epoch the reading resolves to. The default — the authoritative §9.3
 * policy — is {@link resolveLocalInstantDst}; {@link
 * resolveLocalInstantLuxon} remains exported as a compat alternative.
 *
 * Contract the timeline's partition relies on (D-079): implementations
 * resolve deterministically and return finite instants — they need **not**
 * be monotone in local reading order, because §9.3's own gap shift is not
 * (a nonexistent 02:30 resolves past a real 03:00). The walk below unions
 * overlapping peak occurrences, so same-day disjoint windows may resolve to
 * overlapping instants and the timeline still partitions the range.
 */
export type LocalInstantResolver = (time: LocalScheduleTime, timeZone: TimeZone) => EpochMs;

/** One peak interval: a window occurrence clipped to the query range. */
export interface PeakInterval {
  readonly kind: 'peak';
  /** Interval start, UTC epoch milliseconds; inclusive. */
  readonly start: EpochMs;
  /** Interval end, UTC epoch milliseconds; exclusive. */
  readonly end: EpochMs;
  /** The window's credit-rate multiplier (§9.1); `1.0` when unconfigured. */
  readonly multiplier: number;
  /** The window's stable id (spec §9.2). */
  readonly windowId: string;
  /** The window's human-readable name (spec §9.3 output requirement). */
  readonly name: string;
  /** `start` read in the schedule zone, `yyyy-MM-ddTHH:mm`. */
  readonly localStart: string;
  /** `end` read in the schedule zone, `yyyy-MM-ddTHH:mm`. */
  readonly localEnd: string;
}

/** One off-peak interval: a stretch of the range covered by no window. */
export interface OffPeakInterval {
  readonly kind: 'off-peak';
  /** Interval start, UTC epoch milliseconds; inclusive. */
  readonly start: EpochMs;
  /** Interval end, UTC epoch milliseconds; exclusive. */
  readonly end: EpochMs;
  /** The schedule's `offPeakMultiplier`; `1.0` when unconfigured. */
  readonly multiplier: number;
  /** `start` read in the schedule zone, `yyyy-MM-ddTHH:mm`. */
  readonly localStart: string;
  /** `end` read in the schedule zone, `yyyy-MM-ddTHH:mm`. */
  readonly localEnd: string;
}

/** The intervals of one timeline, in chronological order. */
export type PeakHoursInterval = PeakInterval | OffPeakInterval;

/** The full §9.3 answer for one schedule over one query range. */
export interface PeakHoursTimeline {
  /** The schedule zone, branded by {@link resolveTimeZone} at entry. */
  readonly timezone: TimeZone;
  /** The off-peak multiplier in effect (echoed for the response envelope). */
  readonly offPeakMultiplier: number;
  /** Peak and off-peak intervals partitioning `[from, to)` in order. */
  readonly intervals: readonly PeakHoursInterval[];
}

/* ── The compat resolver (Luxon; policy default lives in peak-hours-dst) ── */

/**
 * The Luxon-backed {@link LocalInstantResolver} — task 114's original
 * default, kept as the compat alternative. Its output follows Luxon's
 * documented resolution: a nonexistent local time (inside a spring-forward
 * gap) resolves shifted forward by the gap, an ambiguous one (inside a
 * fall-back overlap) to its first occurrence; `24:00` resolves to the
 * following day's local midnight through calendar-aware day arithmetic.
 * Empirically equal to the authoritative {@link resolveLocalInstantDst}
 * across the §17.1 transition matrix on the pinned runtime (Luxon 3.7.2;
 * the parity sweep lives in `test/unit/peak-hours-dst.property.spec.ts`) —
 * but the equality is verified, not guaranteed: Luxon converges on these
 * answers from an offset guess seeded by the current instant (D-079).
 *
 * Fails loudly, never `NaN`: an unvalidatable zone, a non-integer or
 * out-of-range minute value, or an impossible calendar date (February 30)
 * throws an English error.
 */
export function resolveLocalInstantLuxon(time: LocalScheduleTime, timeZone: TimeZone): EpochMs {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`'${timeZone}' is not a valid IANA time zone`);
  }
  const minutes = time.minutesSinceMidnight;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MINUTES_PER_DAY) {
    throw new Error(
      `local schedule minutes must be an integer in 0-${MINUTES_PER_DAY}, got ${minutes}`,
    );
  }
  const midnight = requireValid(
    DateTime.fromObject({ year: time.year, month: time.month, day: time.day }, { zone: timeZone }),
    `local schedule date ${time.year}-${time.month}-${time.day}`,
  );
  if (minutes === MINUTES_PER_DAY) {
    return requireValid(
      midnight.plus({ days: 1 }),
      `the day after ${time.year}-${time.month}-${time.day}`,
    ).toMillis();
  }
  // Valid by construction: midnight is valid and the minutes are in range.
  return midnight.set({ hour: Math.floor(minutes / 60), minute: minutes % 60 }).toMillis();
}

/* ── The calculator ────────────────────────────────────────────────────── */

/**
 * Calculates the peak/off-peak timeline of `schedule` over `range`
 * (spec §9.3): every window occurrence that intersects `[from, to)` becomes
 * a peak interval — exact UTC boundaries, window id/name, multiplier, and
 * the boundaries' local times in the schedule zone — and the stretches
 * between them become off-peak intervals carrying `offPeakMultiplier`. The
 * intervals partition the range chronologically.
 *
 * `schedule` must be structurally and semantically valid (the §9.2 rules of
 * `PeakWindowSchema` and `findConfigProblems`); this module re-checks only
 * what it consumes directly — the IANA zone through `resolveTimeZone`
 * (D-021's once-per-entry-point gate) and the range's shape and span.
 * `from === to` yields an empty timeline; a non-finite or inverted range, a
 * span over {@link MAX_QUERY_SPAN_DAYS} local days, or an invalid zone
 * throws.
 */
export function calculatePeakHoursIntervals(
  schedule: PeakHoursConfig,
  range: PeakHoursQueryRange,
  resolveLocalInstant: LocalInstantResolver = resolveLocalInstantDst,
): PeakHoursTimeline {
  const timeZone = resolveTimeZone(schedule.timezone);
  const { from, to } = range;
  if (!Number.isFinite(from)) {
    throw new Error(`query range 'from' must be a finite number, got ${from}`);
  }
  if (!Number.isFinite(to)) {
    throw new Error(`query range 'to' must be a finite number, got ${to}`);
  }
  if (from > to) {
    throw new Error(`query range must satisfy from <= to, got from ${from} and to ${to}`);
  }
  const offPeakMultiplier =
    schedule.offPeakMultiplier ?? CONFIG_DEFAULTS.peakHours.offPeakMultiplier;
  if (from === to) {
    return Object.freeze({ timezone: timeZone, offPeakMultiplier, intervals: Object.freeze([]) });
  }

  // Local-day walk, count-bounded on the user's range. The span is the
  // distance between the range's first and last local day; the walk adds a
  // guard day before the start because a window ending at 24:00 there can
  // still reach into the range through that day's midnight, which half-open
  // clipping then trims. The loop is bounded by the day count, never by
  // comparing cursor instants: in zones whose spring-forward gap starts at
  // midnight (America/Havana, Africa/Cairo, …), stepping through the gap
  // leaves the cursor at 01:00 wall time forever after, and an instant
  // comparison would silently drop the last local day (review finding P1).
  // Each cursor is one anchored `plus({days: offset})`, which lands on the
  // true midnight even across such gaps.
  const firstLocalDay = zonedDateTime(from, timeZone).startOf('day');
  const lastLocalDay = zonedDateTime(to, timeZone).startOf('day');
  const spanDays = Math.round((lastLocalDay.toMillis() - firstLocalDay.toMillis()) / DAY_MS);
  if (spanDays > MAX_QUERY_SPAN_DAYS) {
    throw new Error(
      `query range spans ${spanDays} local days, above the maximum of ${MAX_QUERY_SPAN_DAYS}`,
    );
  }

  const peaks: PeakOccurrence[] = [];
  for (let offset = -1; offset <= spanDays; offset++) {
    const day = firstLocalDay.plus({ days: offset });
    const dayOfWeek = WEEK_DAYS[day.weekday - 1]!;
    const at = (minutesSinceMidnight: number): LocalScheduleTime => ({
      year: day.year,
      month: day.month,
      day: day.day,
      minutesSinceMidnight,
    });
    for (const window of schedule.windows) {
      if (!window.days.includes(dayOfWeek)) {
        continue;
      }
      const windowStart = resolveLocalInstant(at(minutesOfWindowEdge(window.start)), timeZone);
      const windowEnd = resolveLocalInstant(at(minutesOfWindowEdge(window.end)), timeZone);
      if (windowEnd <= windowStart) {
        // The window's edges resolve to one instant or invert — a start
        // inside a spring-forward gap whose §9.3 shift reaches past the end
        // (D-079); its wall-clock span simply stays off-peak.
        continue;
      }
      const start = Math.max(windowStart, from);
      const end = Math.min(windowEnd, to);
      if (start >= end) {
        continue;
      }
      peaks.push({
        start,
        end,
        multiplier: window.multiplier ?? CONFIG_DEFAULTS.peakHours.windowMultiplier,
        windowId: window.id,
        name: window.name,
      });
    }
  }

  // Union of the occurrences as the timeline's peak set (D-079): §9.3's
  // gap shift is not monotone in wall order — a nonexistent 02:30 resolves
  // past a real 03:00 — so two wall-disjoint windows of a day can cover
  // overlapping instants. Sorting by `(start, end)` and clipping each start
  // to the still-uncovered stretch emits exactly the union: chronological,
  // adjacent, single coverage, for any resolver. Local times are rendered
  // from the finally emitted boundaries, so a clipped interval reports the
  // instants it actually spans.
  peaks.sort((left, right) => left.start - right.start || left.end - right.end);
  const intervals: PeakHoursInterval[] = [];
  let uncoveredStart = from;
  for (const peak of peaks) {
    const start = Math.max(peak.start, uncoveredStart);
    if (start >= peak.end) {
      // Fully covered by earlier occurrences of the union.
      continue;
    }
    if (start > uncoveredStart) {
      intervals.push(offPeakInterval(uncoveredStart, start, offPeakMultiplier, timeZone));
    }
    intervals.push({
      kind: 'peak',
      start,
      end: peak.end,
      multiplier: peak.multiplier,
      windowId: peak.windowId,
      name: peak.name,
      localStart: formatLocalWallTime(start, timeZone),
      localEnd: formatLocalWallTime(peak.end, timeZone),
    });
    uncoveredStart = peak.end;
  }
  if (uncoveredStart < to) {
    intervals.push(offPeakInterval(uncoveredStart, to, offPeakMultiplier, timeZone));
  }
  return Object.freeze({
    timezone: timeZone,
    offPeakMultiplier,
    intervals: Object.freeze(intervals),
  });
}

/* ── Internals ─────────────────────────────────────────────────────────── */

/**
 * One window occurrence clipped to the query range — before the union
 * clipping of the final walk and before its local times are rendered.
 */
interface PeakOccurrence {
  readonly start: EpochMs;
  readonly end: EpochMs;
  readonly multiplier: number;
  readonly windowId: string;
  readonly name: string;
}

/**
 * Minutes since local midnight for an `HH:mm` or `24:00` window edge; only
 * called on values that passed `PeakWindowSchema` validation, so the parse
 * cannot fail (the configuration contract's own assumption, `config.ts`).
 */
function minutesOfWindowEdge(value: string): number {
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** The local wall-clock reading of `epochMs` in `timeZone`, `yyyy-MM-ddTHH:mm`. */
function formatLocalWallTime(epochMs: EpochMs, timeZone: TimeZone): string {
  return zonedDateTime(epochMs, timeZone).toFormat("yyyy-MM-dd'T'HH:mm");
}

function offPeakInterval(
  start: EpochMs,
  end: EpochMs,
  multiplier: number,
  timeZone: TimeZone,
): OffPeakInterval {
  return {
    kind: 'off-peak',
    start,
    end,
    multiplier,
    localStart: formatLocalWallTime(start, timeZone),
    localEnd: formatLocalWallTime(end, timeZone),
  };
}

function requireValid(dateTime: DateTime, what: string): DateTime {
  if (!dateTime.isValid) {
    throw new Error(`invalid date-time for ${what}: ${dateTime.invalidReason}`);
  }
  return dateTime;
}
