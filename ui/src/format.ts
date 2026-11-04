/**
 * Pure `Intl` formatting helpers (spec §14.1; task 172, decision D-137).
 *
 * §14.1: "Format dates and numbers with `Intl` using the configured
 * display time zone" — these functions are the single home of that
 * formatting for the overview surface (§14.3), pure and injectable-in-time
 * (every function takes its timestamp inputs; none reads the clock), so
 * component tests stay deterministic and the future chart tasks (174+)
 * reuse the same helpers instead of growing private formatters.
 *
 * Locale is fixed to `'en'` (the only shipped language, §14.1); the time
 * zone is always an explicit argument — the caller owns which zone is
 * configured (the overview reads it from `/api/settings`, with the
 * browser's zone as the documented degraded fallback).
 */

/** The quota-value formatter: grouping on, at most two fraction digits. */
const quotaNumberFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });

/** Relative-time formatter with automatic phrasing ("now", "yesterday"). */
const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** Absolute date-time formatters by zone — one per distinct zone used. */
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormat(timeZone: string): Intl.DateTimeFormat {
  let format = dateTimeFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    });
    dateTimeFormats.set(timeZone, format);
  }
  return format;
}

/** Chart-date formats by zone — one per distinct zone used (§14.4 tooltips/axis). */
const chartDateFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * Formats one UTC epoch-milliseconds timestamp as a compact chart date
 * ("Nov 4, 2:00 PM") in `timeZone` — the §14.4 tooltip and axis-label
 * rendering. Task 177 owns tick PLACEMENT (local hour/day boundaries in
 * the display zone, DST-aware); this helper owns only the text of one
 * tick, which that task keeps consuming.
 */
export function formatChartDate(epochMs: number, timeZone: string): string {
  let format = chartDateFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    });
    chartDateFormats.set(timeZone, format);
  }
  return format.format(epochMs);
}

/** Formats one quota value (§14.3: explicit numbers via `Intl`). */
export function formatQuotaNumber(value: number): string {
  return quotaNumberFormat.format(value);
}

/**
 * Formats one UTC epoch-milliseconds timestamp as an absolute local
 * date-time in `timeZone` (§14.3: "in the configured display time zone").
 */
export function formatEpochMs(epochMs: number, timeZone: string): string {
  return dateTimeFormat(timeZone).format(epochMs);
}

/**
 * The relative-time buckets: `[maxAbsoluteSeconds, secondsPerUnit, unit]`,
 * coarse-to-fine thresholds for seconds → weeks.
 */
const RELATIVE_STEPS: ReadonlyArray<readonly [number, number, Intl.RelativeTimeFormatUnit]> =
  Object.freeze([
    [60, 1, 'second'],
    [3_600, 60, 'minute'],
    [86_400, 3_600, 'hour'],
    [7 * 86_400, 86_400, 'day'],
    [31 * 86_400, 7 * 86_400, 'week'],
  ] as const);

/** The seconds-per-month divisor of the next-to-last bucket (≈30.44 days). */
const SECONDS_PER_MONTH = 2_629_800;

/** The seconds-per-year divisor of the last bucket (the Gregorian ≈). */
const SECONDS_PER_YEAR = 31_557_600;

/**
 * Formats the distance of `epochMs` from `nowEpochMs` as a relative
 * phrase (§14.3: reset times "relative to current time") — "in 2 hours",
 * "3 hours ago", "now". The caller supplies both instants so the phrase
 * is a pure function (the overview captures `now` when data arrives and
 * re-renders on the next load; a live ticker is not part of §14.3).
 */
export function formatRelative(epochMs: number, nowEpochMs: number): string {
  const differenceSeconds = (epochMs - nowEpochMs) / 1000;
  const absolute = Math.abs(differenceSeconds);
  for (const [limit, perUnit, unit] of RELATIVE_STEPS) {
    if (absolute < limit)
      return relativeFormat.format(Math.round(differenceSeconds / perUnit), unit);
  }
  // Beyond the week bucket: whole months up to a year, then whole
  // years — the 174+ charts' long history ranges render "3 years ago",
  // not "40 months ago" (calendar-approximate per Intl's own units).
  if (absolute < SECONDS_PER_YEAR) {
    return relativeFormat.format(Math.round(differenceSeconds / SECONDS_PER_MONTH), 'month');
  }
  return relativeFormat.format(Math.round(differenceSeconds / SECONDS_PER_YEAR), 'year');
}

/**
 * The rolling-window length (§8.4 `windowSeconds`) in whole hours — the
 * Z.ai shapes are integral-hour windows ("5-hour token quota"); a
 * non-integral length returns `undefined` so the caller omits the window
 * phrase instead of inventing a unit it was not given.
 */
export function windowHours(windowSeconds: number): number | undefined {
  const hours = windowSeconds / 3_600;
  return Number.isInteger(hours) && hours > 0 ? hours : undefined;
}
