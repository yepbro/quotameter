/**
 * The §12.2/§9.3 annotation mapping for the §14.4 metric charts (task 176,
 * spec §9.3, §12.2, §14.4; decision D-149) — pure functions from the
 * account-level events timeline and the peak-hours intervals onto the
 * per-metric annotation lists the option builder renders.
 *
 * Pinned interpretations:
 *
 * - **Per-metric vs account-level events (§12.2's semantics).** Resets and
 *   gaps carry a `metricKey` — they are facts of ONE metric's series and
 *   render only on that metric's chart. Failed collection cycles and
 *   stopped-service regions are account-level facts (the optional `metric`
 *   filter of `GET /api/events` narrows only resets/gaps, D-139): a cycle
 *   that failed collected nothing for ANY metric, so every metric chart of
 *   the account renders the same error markers and stopped bands — the
 *   consistent mapping D-149 pins.
 * - **Window honesty.** The page's events/peak-hours loads and a card's own
 *   history load each compute rolling bounds from their own `Date.now()`
 *   (D-147's fresh-bounds rule), so the served intervals can differ from the
 *   card's window by milliseconds at the edges. Every band clamps to the
 *   card's window and a band that empties under clamping drops; marks
 *   outside the window drop. Nothing draws outside the chart's axes.
 * - **The browser never calculates windows (§9.3).** Peak bands map the
 *   served intervals verbatim — the schedule-zone local times ride the wire
 *   item into the tooltip unchanged.
 */

import type { EventsResponse } from '../../../src/schemas/api/history';
import type { PeakHoursResponse } from '../../../src/schemas/api/peak-hours';
import type { AccountErrorOutcome } from '../../../src/schemas/api/status';

/** The chart's x window — the range report's requested bounds (D-148). */
export interface ChartWindow {
  readonly from: number;
  readonly to: number;
}

/** One §12.1 quota-reset instant (per-metric). */
export interface ResetMark {
  readonly at: number;
}

/** One §12.2 collection gap (per-metric) — D-075's fields, verbatim. */
export interface GapMark {
  readonly from: number;
  readonly to: number;
  readonly elapsedMs: number;
  readonly thresholdMs: number;
}

/** One §12.2 stopped-service region (account-level), clamped to the window. */
export interface StoppedMark {
  readonly from: number;
  readonly to: number;
  readonly elapsedMs: number;
}

/** One failed collection cycle (account-level) — the strip marker. */
export interface ErrorMark {
  readonly at: number;
  readonly outcome: AccountErrorOutcome;
  readonly httpStatus: number | null;
  readonly message: string;
  readonly attempts: number;
  readonly retryAfterSeconds: number | null;
}

/** The annotations of one metric's chart, mapped from the account timeline. */
export interface MetricAnnotations {
  readonly resets: readonly ResetMark[];
  readonly gaps: readonly GapMark[];
  readonly stopped: readonly StoppedMark[];
  readonly errors: readonly ErrorMark[];
}

/** The empty annotation set — the null-events degenerate renders nothing. */
const NO_ANNOTATIONS: MetricAnnotations = Object.freeze({
  resets: [],
  gaps: [],
  stopped: [],
  errors: [],
});

/** `[from, to]` clamped to the window; `null` when nothing remains. */
function clampInterval(
  from: number,
  to: number,
  window: ChartWindow,
): readonly [number, number] | null {
  const clampedFrom = Math.max(from, window.from);
  const clampedTo = Math.min(to, window.to);
  return clampedTo > clampedFrom ? ([clampedFrom, clampedTo] as const) : null;
}

/**
 * Maps the account-level events timeline onto one metric's annotations:
 * resets/gaps filtered by `metricKey` (per-metric facts), errors/stopped
 * passed to every metric (account-level facts), everything clamped to the
 * card's own window.
 */
export function annotationsOf(
  events: EventsResponse | null | undefined,
  metricKey: string,
  window: ChartWindow,
): MetricAnnotations {
  if (events === null || events === undefined) return NO_ANNOTATIONS;
  const resets: ResetMark[] = [];
  const gaps: GapMark[] = [];
  const stopped: StoppedMark[] = [];
  const errors: ErrorMark[] = [];
  for (const event of events.events) {
    switch (event.kind) {
      case 'reset': {
        if (event.metricKey !== metricKey) break;
        if (event.eventAt < window.from || event.eventAt > window.to) break;
        resets.push({ at: event.eventAt });
        break;
      }
      case 'gap': {
        if (event.metricKey !== metricKey) break;
        const clamped = clampInterval(event.fromEpochMs, event.toEpochMs, window);
        if (clamped === null) break;
        gaps.push({
          from: clamped[0],
          to: clamped[1],
          elapsedMs: event.elapsedMs,
          thresholdMs: event.thresholdMs,
        });
        break;
      }
      case 'stopped_service': {
        const clamped = clampInterval(event.fromEpochMs, event.toEpochMs, window);
        if (clamped === null) break;
        stopped.push({ from: clamped[0], to: clamped[1], elapsedMs: event.elapsedMs });
        break;
      }
      case 'collection_error': {
        if (event.fromEpochMs < window.from || event.fromEpochMs > window.to) break;
        errors.push({
          at: event.fromEpochMs,
          outcome: event.outcome,
          httpStatus: event.httpStatus,
          message: event.message,
          attempts: event.attempts,
          retryAfterSeconds: event.retryAfterSeconds,
        });
        break;
      }
    }
  }
  return { resets, gaps, stopped, errors };
}

/* ── Peak bands (§9.3, served intervals) ───────────────────────────────── */

/** One peak/off-peak band of the chart — a served interval, verbatim facts. */
export interface PeakBand {
  readonly kind: 'peak' | 'offPeak';
  /** The drawn span, clamped to the card's window. */
  readonly from: number;
  readonly to: number;
  /** The served span — the tooltip's both-zone times (§14.4/§9.3). */
  readonly start: number;
  readonly end: number;
  /** The window's §9.3 name (peak only; off-peak has none). */
  readonly name: string | null;
  /** The §9.3 rate multiplier (the window's, or the schedule's off-peak). */
  readonly multiplier: number;
  /** `from` in the schedule zone — the D-073 local string, rendered verbatim. */
  readonly localStart: string;
  /** `to` in the schedule zone. */
  readonly localEnd: string;
}

/**
 * Maps the peak-hours response onto chart bands: the served intervals,
 * clamped to the card's window. A null response (load pending/failed), a
 * rejected range, or the §9.2 no-schedule arm (`timezone: null`, empty
 * intervals) maps to no bands — the browser never invents a schedule.
 */
export function peakBandsOf(
  response: PeakHoursResponse | null | undefined,
  window: ChartWindow,
): readonly PeakBand[] {
  if (response === null || response === undefined) return [];
  const bands: PeakBand[] = [];
  for (const interval of response.intervals) {
    const clamped = clampInterval(interval.start, interval.end, window);
    if (clamped === null) continue;
    bands.push({
      kind: interval.kind === 'peak' ? 'peak' : 'offPeak',
      from: clamped[0],
      to: clamped[1],
      start: interval.start,
      end: interval.end,
      name: interval.kind === 'peak' ? interval.name : null,
      multiplier: interval.multiplier,
      localStart: interval.localStart,
      localEnd: interval.localEnd,
    });
  }
  return bands;
}

/** The schedule zone's name for tooltips (§14.4: times in BOTH zones). */
export function scheduleZoneOf(response: PeakHoursResponse | null | undefined): string | null {
  return response?.timezone ?? null;
}

/* ── Error marker symbols (§12.2: distinct symbol per error type) ──────── */

/**
 * The scatter symbol of one §11.2 failure outcome — six shapes for six
 * classes, so the classes stay distinguishable with color vision off the
 * table (§14.1). Exhaustive: a future outcome fails the `never` assignment
 * at compile time instead of silently reusing a shape.
 */
export function errorSymbolOf(outcome: AccountErrorOutcome): string {
  switch (outcome) {
    case 'auth_error':
      return 'diamond';
    case 'rate_limited':
      return 'triangle';
    case 'network_error':
      return 'circle';
    case 'timeout':
      return 'rect';
    case 'server_error':
      return 'roundRect';
    case 'parse_error':
      return 'pin';
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
