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
 * ("Nov 4, 2:00 PM") in `timeZone` — since task 177 the §14.4 TOOLTIP
 * header (and the axis-label fallback for a value outside the tick set);
 * the axis tick text itself lives in the four tick-label formatters
 * below.
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

/* ── Chart tick labels (§14.4 axis rendering, task 177; D-150) ─────────── */

/** The wall-clock-hour tick label — "2 PM". */
const chartTimeFormats = new Map<string, Intl.DateTimeFormat>();
/** The wall-clock-hour tick label with its zone name — "1 AM EST". */
const chartZoneTimeFormats = new Map<string, Intl.DateTimeFormat>();
/** The day tick label — "Nov 4". */
const chartDayFormats = new Map<string, Intl.DateTimeFormat>();
/** The month tick label — "Nov 2026". */
const chartMonthFormats = new Map<string, Intl.DateTimeFormat>();

function cachedFormat(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string,
  create: () => Intl.DateTimeFormat,
): Intl.DateTimeFormat {
  let format = cache.get(timeZone);
  if (format === undefined) {
    format = create();
    cache.set(timeZone, format);
  }
  return format;
}

/**
 * Formats one tick's wall-clock time — "2 PM" — in `timeZone`: the label
 * of an hour-granularity tick (task 177). Time only: the full date stays
 * in the tooltip (an hour-granularity axis can span days).
 */
export function formatChartTime(epochMs: number, timeZone: string): string {
  return cachedFormat(
    chartTimeFormats,
    timeZone,
    () => new Intl.DateTimeFormat('en', { timeZone, hour: 'numeric' }),
  ).format(epochMs);
}

/**
 * Formats one tick's wall-clock time with its short zone name — "1 AM EST":
 * the disambiguated label for a tick on a duplicated wall hour (a 25-hour
 * day reads "1 AM" twice; the offsets are the honest difference, §14.4).
 */
export function formatChartZoneTime(epochMs: number, timeZone: string): string {
  return cachedFormat(
    chartZoneTimeFormats,
    timeZone,
    () => new Intl.DateTimeFormat('en', { timeZone, hour: 'numeric', timeZoneName: 'short' }),
  ).format(epochMs);
}

/** Formats one day-granularity tick — "Nov 4" — in `timeZone`. */
export function formatChartDay(epochMs: number, timeZone: string): string {
  return cachedFormat(
    chartDayFormats,
    timeZone,
    () => new Intl.DateTimeFormat('en', { timeZone, month: 'short', day: 'numeric' }),
  ).format(epochMs);
}

/**
 * Formats one month-granularity tick — "Nov 2026": the year rides along
 * because a month-step axis spans more than one month (task 177).
 */
export function formatChartMonth(epochMs: number, timeZone: string): string {
  return cachedFormat(
    chartMonthFormats,
    timeZone,
    () => new Intl.DateTimeFormat('en', { timeZone, month: 'short', year: 'numeric' }),
  ).format(epochMs);
}

/** Formats one quota value (§14.3: explicit numbers via `Intl`). */
export function formatQuotaNumber(value: number): string {
  return quotaNumberFormat.format(value);
}

/**
 * Formats a duration for chart annotations (§14.4/§12.2 tooltips and band
 * facts): compact "45s", "47m", "1h 30m" — the honest elapsed fact, never a
 * false-precision decimal. Non-positive or non-finite input renders "0s"
 * (a degenerate span states zero, it does not invent time).
 */
export function formatChartDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0s';
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
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
