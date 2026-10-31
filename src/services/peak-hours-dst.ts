/**
 * Explicit DST resolution for schedule local wall-clock readings (spec
 * §9.3, §17.1; task 115, decision D-079).
 *
 * §9.3 fixes two rules for turning a schedule's local reading into an
 * instant, and this module computes them — the policy is code here, not a
 * library's convergence behavior:
 *
 * - **Nonexistent readings shift forward by the exact gap.** A spring-
 *   forward gap jumps over a wall-clock interval (New York's `[02:00,
 *   03:00)`); a reading inside it resolves to the instant of the reading
 *   plus the gap size — 02:30 becomes 03:30. The shift is the offset delta,
 *   not a fixed hour: `Australia/Lord_Howe` gaps are 30 minutes,
 *   `Pacific/Chatham` gaps start at 02:45, and a gap starting at midnight
 *   (`America/Havana`) shifts a day's `00:00` and a `24:00` window end
 *   alike.
 * - **Ambiguous readings resolve to the first occurrence.** A fall-back
 *   overlap repeats a wall-clock interval; the earlier instant — still on
 *   the pre-transition offset — is the answer (D-079).
 *
 * Mechanics — offset differencing around the reading, all through the
 * canonical epoch → zone direction (`zonedParts`, the D-021 bridge):
 *
 * 1. Read the wall time as a pseudo-epoch `P` (its fields as if UTC) and
 *    collect the zone offsets active at `P`, `P − 1 day`, and `P + 1 day`.
 *    A transition that affects the reading satisfies
 *    |P − T| < |offsetBefore| + |offsetDelta| (the reading's occurrence
 *    lies within one offset of it, and a gap covering the reading lies
 *    within the jumped span of it). IANA offsets are at most 14 hours in
 *    magnitude, and the only offset deltas above two hours are the 24-hour
 *    dateline gaps (`Pacific/Apia` skipped 2011-12-30 whole), whose
 *    pre-offsets are at most −10 hours — so in every case both sides of
 *    the relevant transition appear among the three day probes, and tz
 *    database zones never transition twice within 48 hours, keeping the
 *    candidate set to the two offsets around at most one transition.
 * 2. Each candidate offset proposes the instant `P − offset`; it proves an
 *    **occurrence** by round-trip — the instant must read back as exactly
 *    the input calendar date and time (the date comparison rejects
 *    proposals that land on another day, e.g. the pre-offset candidate of
 *    a midnight gap, or another day entirely, e.g. the pre-offset
 *    candidate of a dateline gap).
 * 3. Occurrences found → the earliest (a normal reading verifies exactly
 *    once; an ambiguous one twice — the earlier is the first occurrence).
 *    None found → the reading is inside a gap: the pre-transition offset —
 *    the smaller candidate, since an offset that jumps over readings
 *    increases — places the instant after the transition, where it reads
 *    as the wall time plus the gap (for Apia's skipped day, wall
 *    2011-12-30 12:00 resolves to the instant of 2011-12-31 12:00).
 *
 * Why explicit rather than Luxon (whose output matches on the pinned
 * runtime): Luxon's wall-time resolution converges from an offset guess
 * seeded by the machine's current instant (`fixOffset` +
 * `guessOffsetForZone`); landing on §9.3's answers is a property of its
 * iteration, not a contract. The default this module provides is the
 * policy; `resolveLocalInstantLuxon` stays exported as the compat
 * alternative, pinned equal to this resolver across the §17.1 matrix by
 * `test/unit/peak-hours-dst.property.spec.ts`.
 *
 * Fails loudly, never `NaN`: an unvalidatable zone, a non-integer or
 * out-of-range minute value, or an impossible calendar date (February 30)
 * throws an English error. Supported envelope: the modern tz database era —
 * minute-aligned transitions between two offsets (every zone post-1972;
 * before that, a handful of zones carried second-level offsets such as
 * Monrovia's −00:44:30, which the minute-granular `LocalScheduleTime`
 * vocabulary cannot express). The gap-path answer is `P − preOffset`, so a
 * reading within one offset of the epoch ceiling could in principle shift
 * past the representable range — no zone's in-range spring gap sits that
 * close to the ceiling (the last extrapolated transitions are months
 * away), and the interval walk's range clip drops any such occurrence
 * regardless; the seam's contract is finite instants.
 */

import { isValidTimeZone, zonedParts } from '../util/clock';
import { DAY_MS } from '../util/rolling-ranges';
import type { EpochMs, TimeZone } from '../util/clock';
// The value import is deliberate despite the mutual import with
// `peak-hours-intervals` (which imports this module as its default
// resolver): both sides read the binding only inside function bodies, which
// is safe under ESM live bindings and CJS call-time property access alike.
import { MINUTES_PER_DAY } from './peak-hours-intervals';
import type { LocalScheduleTime } from './peak-hours-intervals';

/**
 * The inclusive epoch-millisecond range both `Date` and the `zonedParts`
 * bridge represent (±8.64e15 ms, the ECMAScript time-value range): probes
 * and `24:00` arithmetic stay inside it or fail loudly.
 */
const EPOCH_RANGE_MS = 8_640_000_000_000_000;

/* ── The §9.3 policy ───────────────────────────────────────────────────── */

/**
 * The authoritative {@link LocalInstantResolver} (spec §9.3, decision
 * D-079): nonexistent local readings shift forward by the exact DST gap,
 * ambiguous readings resolve to the first occurrence — see the module
 * header for the algorithm. This is the default of
 * `calculatePeakHoursIntervals`.
 */
export function resolveLocalInstantDst(time: LocalScheduleTime, timeZone: TimeZone): EpochMs {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`'${timeZone}' is not a valid IANA time zone`);
  }
  const minutes = time.minutesSinceMidnight;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MINUTES_PER_DAY) {
    throw new Error(
      `local schedule minutes must be an integer in 0-${MINUTES_PER_DAY}, got ${minutes}`,
    );
  }
  const midnight = requireCalendarDate(time.year, time.month, time.day);
  if (minutes === MINUTES_PER_DAY) {
    // `24:00` is the midnight that ends the day (§9.2): the next calendar
    // day's 00:00 reading, resolved through the same policy — a midnight
    // inside a DST gap (America/Havana) shifts forward like any other
    // nonexistent reading.
    const nextMidnight = midnight + DAY_MS;
    if (nextMidnight > EPOCH_RANGE_MS) {
      throw new Error(
        `the day after ${time.year}-${time.month}-${time.day} is outside the supported epoch range`,
      );
    }
    const next = new Date(nextMidnight);
    return resolveLocalInstantDst(
      {
        year: next.getUTCFullYear(),
        month: next.getUTCMonth() + 1,
        day: next.getUTCDate(),
        minutesSinceMidnight: 0,
      },
      timeZone,
    );
  }
  const wall = midnight + minutes * 60_000;

  // Candidate offsets: the distinct offsets active within one day of the
  // reading (module header, step 1). Probes beyond the epoch range are
  // skipped: readings at the very edge of representable time simply see
  // fewer candidates, and an edge reading is never inside a transition.
  const offsets: number[] = [];
  for (const probe of [wall - DAY_MS, wall, wall + DAY_MS]) {
    if (probe < -EPOCH_RANGE_MS || probe > EPOCH_RANGE_MS) {
      continue;
    }
    const offset = zonedParts(probe, timeZone).offsetMinutes;
    if (!offsets.includes(offset)) {
      offsets.push(offset);
    }
  }

  // Occurrences: candidates that read back as exactly the input fields
  // (module header, step 2).
  const occurrences: EpochMs[] = [];
  for (const offset of offsets) {
    const instant = wall - offset * 60_000;
    const parts = zonedParts(instant, timeZone);
    if (
      parts.year === time.year &&
      parts.month === time.month &&
      parts.day === time.day &&
      parts.hour === Math.floor(minutes / 60) &&
      parts.minute === minutes % 60
    ) {
      occurrences.push(instant);
    }
  }

  if (occurrences.length > 0) {
    // First occurrence (§9.3): the earlier instant of an ambiguous reading;
    // a normal reading reaches this as its single verification.
    return Math.min(...occurrences);
  }
  // No occurrence: the reading is inside a spring-forward gap. Shift
  // forward by the gap — the pre-transition (smaller) offset's instant,
  // which lands after the jump and reads as the wall time plus the gap
  // (module header, step 3).
  return wall - Math.min(...offsets) * 60_000;
}

/* ── Internals ─────────────────────────────────────────────────────────── */

/**
 * The pseudo-epoch of a calendar date's midnight (its fields as if UTC)
 * after proving it is a valid calendar date: `Date.UTC` silently rolls
 * impossible dates forward (February 30 becomes March 2) and maps
 * two-digit years into the 1900s, so the fields are read back and compared
 * before anything downstream may trust them.
 */
function requireCalendarDate(year: number, month: number, day: number): EpochMs {
  const midnight = Date.UTC(year, month - 1, day);
  const readBack = new Date(midnight);
  if (
    Number.isNaN(midnight) ||
    readBack.getUTCFullYear() !== year ||
    readBack.getUTCMonth() !== month - 1 ||
    readBack.getUTCDate() !== day
  ) {
    throw new Error(`local schedule date ${year}-${month}-${day} is not a valid calendar date`);
  }
  return midnight;
}
