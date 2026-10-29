/**
 * Canonical clock and time-zone API (spec §10; task 071, decision D-021).
 *
 * Every server-side consumer that needs "now", a conversion between UTC epoch
 * milliseconds and a time zone, or a formatted timestamp goes through this
 * module. It is the single place where wall-clock time enters the
 * application: `createSystemClock` owns the only sanctioned `Date.now()` call,
 * and no function here reads the machine's local zone, `TZ`, or Luxon's
 * default-zone machinery — so business logic cannot depend on implicit
 * machine-local time (spec §10) and behaves identically under any `TZ`.
 *
 * Scope decisions (decision D-021):
 *
 * - Zones are explicit and branded: validate once per entry point with
 *   `resolveTimeZone`, then pass the branded `TimeZone` to every helper —
 *   the construction-gate pattern of `AccountContext` (D-013).
 * - IANA validity semantics are a deliberate twin of `isValidTimeZoneName`
 *   in `src/schemas/config.ts` (D-014 item 8: `Intl` resolution minus
 *   ECMA-402 offset identifiers). `schemas` and `util` are both leaves and
 *   cannot import each other (D-009); a parity test keeps the twins
 *   identical instead of an import.
 * - Converting local wall-clock fields to an instant is deliberately absent:
 *   that is where DST nonexistent/ambiguous times live, and spec §9.3 fixes
 *   their resolution policy — owned by task 115. This module exposes only
 *   the unambiguous epoch → wall-clock direction, plus the `zonedDateTime`
 *   Luxon bridge that peak-hours intervals (114), DST handling (115), and
 *   rolling ranges (116) build on.
 */

import { performance } from 'node:perf_hooks';
import { DateTime } from 'luxon';

/* ── Types ─────────────────────────────────────────────────────────────── */

/**
 * A moment in time as UTC Unix epoch milliseconds — the representation used
 * for storage (SQLite `INTEGER`) and API timestamps (spec §10).
 */
export type EpochMs = number;

declare const timeZoneBrand: unique symbol;

/**
 * An IANA time-zone identifier validated by `resolveTimeZone`. The brand is a
 * compile-time gate: a zone reaches the conversion helpers only through
 * validation. It is erased at runtime, so `zonedDateTime` re-runs the same
 * IANA gate on every call — Luxon alone would accept pseudo-zones such as
 * `local` or `utc+4` that resolve to machine-local readings (spec §10) — and
 * additionally checks Luxon's `.isValid` for the epoch side.
 */
export type TimeZone = string & { readonly [timeZoneBrand]: true };

/**
 * The source of "now" for everything above this layer (spec §10, §7.1).
 * Services receive a `Clock` instead of calling `Date.now()`/`new Date()`
 * themselves; `monotonicMs()` backs elapsed-time measurement and monotonic
 * interval scheduling.
 */
export interface Clock {
  /** Current time as UTC epoch milliseconds. */
  now(): EpochMs;
  /** Monotonic milliseconds for measuring elapsed time; never wall-clock. */
  monotonicMs(): number;
}

/** A `Clock` whose readings a test can set directly. */
export interface FixedClock extends Clock {
  /**
   * Jumps the wall-clock reading only; the monotonic reading is untouched —
   * the shape of an NTP correction (spec §10 assumes a synchronized clock).
   */
  set(at: EpochMs): void;
  /**
   * Moves both readings by `deltaMs`. Any finite value is accepted,
   * negative included: a test double may simulate skew deliberately.
   */
  advance(deltaMs: number): void;
}

/* ── Clocks ────────────────────────────────────────────────────────────── */

/**
 * The production clock: epoch time from `Date.now()` and monotonic time from
 * `performance.now()`. The composition root creates one and injects it.
 */
export function createSystemClock(): Clock {
  return {
    // The only sanctioned Date.now() call site in the application.
    now: () => Date.now(),
    monotonicMs: () => performance.now(),
  };
}

/** Creates a deterministic clock pinned to `at` (monotonic reading defaults to 0). */
export function createFixedClock(at: EpochMs, monotonicMs: number = 0): FixedClock {
  let epoch = requireFinite(at, 'fixed clock epoch');
  let monotonic = requireFinite(monotonicMs, 'fixed clock monotonic start');
  return {
    now: () => epoch,
    monotonicMs: () => monotonic,
    set(next) {
      epoch = requireFinite(next, 'fixed clock epoch');
    },
    advance(deltaMs) {
      const delta = requireFinite(deltaMs, 'fixed clock advance');
      // Validate the sums too: MAX_VALUE + MAX_VALUE must not silently
      // overflow a reading to Infinity.
      epoch = requireFinite(epoch + delta, 'fixed clock epoch');
      monotonic = requireFinite(monotonic + delta, 'fixed clock monotonic reading');
    },
  };
}

function requireFinite(value: number, what: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${what} must be a finite number, got ${value}`);
  }
  return value;
}

/* ── IANA zone validation ──────────────────────────────────────────────── */

/**
 * True when `name` is a valid IANA time-zone identifier, following the same
 * resolver as the configuration contract (D-014 item 8): whatever
 * `Intl.DateTimeFormat` accepts — canonical names, links/aliases such as
 * `Asia/Calcutta`, `UTC`, V8's case-insensitive lookup — minus ECMA-402
 * offset identifiers such as `+03:00`, which are not IANA names.
 *
 * Results are memoized: `zonedDateTime` re-validates every zone it receives
 * (Luxon accepts pseudo-zones like `local`/`utc+4` that this gate rejects),
 * and formatting loops must not pay an `Intl.DateTimeFormat` construction
 * per call. Cache keys are zone names from validated configuration, so the
 * map stays small in practice.
 */
export function isValidTimeZone(name: string): boolean {
  const cached = zoneChecks.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const valid = !name.startsWith('+') && !name.startsWith('-') && resolvableByIntl(name);
  zoneChecks.set(name, valid);
  return valid;
}

const zoneChecks = new Map<string, boolean>();

function resolvableByIntl(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates `name` and brands it as a `TimeZone`. Throws a plain English
 * error for anything `isValidTimeZone` rejects — the single validation gate
 * every zone parameter passes through.
 */
export function resolveTimeZone(name: string): TimeZone {
  if (!isValidTimeZone(name)) {
    throw new Error(`'${name}' is not a valid IANA time zone`);
  }
  return name as TimeZone;
}

/* ── Conversions and formatting ────────────────────────────────────────── */

/**
 * The instant `epochMs` as a Luxon `DateTime` located in `timeZone` — the
 * bridge future time-zone consumers (peak hours, DST handling, rolling
 * ranges) build on. Always valid: non-finite or out-of-range epochs and
 * unsupported zones throw.
 */
export function zonedDateTime(epochMs: EpochMs, timeZone: TimeZone): DateTime {
  // Runtime zone gate: the brand is erased, and Luxon alone would accept
  // pseudo-zones (`local`, `system`, `utc+4`, offset ids) that resolve to
  // machine-local readings — the §10 failure mode this module prevents.
  requireTimeZone(timeZone);
  const dateTime = DateTime.fromMillis(epochMs, { zone: timeZone });
  return requireValid(dateTime, `epoch ${epochMs} in zone '${timeZone}'`);
}

/**
 * Formats `epochMs` as ISO 8601 UTC with millisecond precision and a `Z`
 * suffix (spec §10: API timestamps use ISO 8601 UTC ending in `Z`).
 */
export function toUtcIso(epochMs: EpochMs): string {
  const dateTime = DateTime.fromMillis(epochMs, { zone: 'utc' });
  // Non-null by construction: requireValid() rejected invalid date-times.
  return requireValid(dateTime, `epoch ${epochMs}`).toISO() as string;
}

/**
 * An ISO 8601 timestamp must carry an explicit UTC designator (`Z`/`z`) or a
 * numeric offset (`±HH:mm`/`±HHmm`); anything else is rejected before Luxon
 * could interpret it in a default zone.
 */
const OFFSET_REQUIRED = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/**
 * Parses an ISO 8601 timestamp into UTC epoch milliseconds. The string must
 * carry an explicit offset or `Z` — offset-less strings (including bare
 * dates) are exactly where an implicit zone would creep in, so they are
 * rejected loudly instead of guessed (spec §10).
 */
export function epochMsFromIso(iso: string): EpochMs {
  if (!OFFSET_REQUIRED.test(iso)) {
    throw new Error(`ISO 8601 timestamp must carry an explicit offset or 'Z': '${iso}'`);
  }
  const dateTime = DateTime.fromISO(iso, { zone: 'utc' });
  return requireValid(dateTime, `ISO timestamp '${iso}'`).toMillis();
}

/** Local wall-clock fields of an instant, read in `timeZone`. */
export interface ZonedParts {
  /** The source instant, echoed for convenience. */
  readonly epochMs: EpochMs;
  /** Zone offset at that instant, in minutes east of UTC. */
  readonly offsetMinutes: number;
  /** Calendar year (no era offset). */
  readonly year: number;
  /** Month of year, 1–12. */
  readonly month: number;
  /** Day of month, 1–31. */
  readonly day: number;
  /** Hour of day, 0–23. */
  readonly hour: number;
  /** Minute of hour, 0–59. */
  readonly minute: number;
  /** Second of minute, 0–59. */
  readonly second: number;
  /** Millisecond of second, 0–999. */
  readonly millisecond: number;
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  readonly weekday: number;
}

/**
 * The wall-clock reading of `epochMs` in `timeZone` as plain data — for
 * consumers that should not depend on Luxon types. Day selection for
 * schedules (spec §9.2) reads `weekday`/`day` from here.
 */
export function zonedParts(epochMs: EpochMs, timeZone: TimeZone): ZonedParts {
  const dateTime = zonedDateTime(epochMs, timeZone);
  return {
    epochMs: dateTime.toMillis(),
    offsetMinutes: dateTime.offset,
    year: dateTime.year,
    month: dateTime.month,
    day: dateTime.day,
    hour: dateTime.hour,
    minute: dateTime.minute,
    second: dateTime.second,
    millisecond: dateTime.millisecond,
    weekday: dateTime.weekday,
  };
}

/**
 * Local wall-clock time of `epochMs` in `timeZone`, `HH:mm` (24-hour,
 * zero-padded) — the local-time format peak-hours display uses (spec §9.3).
 */
export function formatZonedTime(epochMs: EpochMs, timeZone: TimeZone): string {
  return zonedDateTime(epochMs, timeZone).toFormat('HH:mm');
}

/**
 * Local calendar date of `epochMs` in `timeZone`, zero-padded `yyyy-MM-dd`.
 */
export function formatZonedDate(epochMs: EpochMs, timeZone: TimeZone): string {
  // Non-null by construction: requireValid() rejected invalid date-times.
  return zonedDateTime(epochMs, timeZone).toISODate() as string;
}

function requireValid(dateTime: DateTime, what: string): DateTime {
  if (!dateTime.isValid) {
    throw new Error(`invalid date-time for ${what}: ${dateTime.invalidReason}`);
  }
  return dateTime;
}

function requireTimeZone(timeZone: TimeZone): void {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`'${timeZone}' is not a valid IANA time zone`);
  }
}
