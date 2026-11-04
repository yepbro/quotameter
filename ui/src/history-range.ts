/**
 * The history-range vocabulary and boundary arithmetic for the §14.4
 * rolling-range controls (task 174, spec §10, §13, §14.4; decision
 * D-147).
 *
 * "Last N hours/days" is a rolling interval ending now (spec §10): the
 * page computes explicit `from`/`to` bounds client-side and the §13
 * endpoints filter server-side. The bounds are EXACT absolute-duration
 * arithmetic — `to = now`, `from = now − duration` — with no calendar
 * or DST wall-clock component, so **no time zone participates in a
 * request** (D-068's pin, mirrored here; the configured display zone is
 * presentation-only, §10, and never anchors a boundary). The wire form
 * is ISO 8601 UTC ending in `Z` — D-139's request grammar: §13 names
 * the ISO requirement for the range parameters, and the server parses
 * them through its strict explicit-offset gate.
 *
 * The vocabulary is UI-LOCAL, drift-pinned against the server's own
 * `src/util/rolling-ranges.ts` by `test/component/history-range.spec.ts`
 * — the `API_MUTATION_HEADER` precedent (D-134): nothing from `src/**`
 * crosses into the UI at all (the layout contract keeps ui imports of
 * server code to type-only `src/schemas/**`), so the id union is
 * declared here and pinned to the server's union in BOTH directions
 * (compile-time assignability plus runtime order) by the spec.
 */

/**
 * A §14.4 rolling-range id — the UI-local twin of the server's
 * `RollingRangeId`; the drift test holds the two identical.
 */
export type HistoryRangeId = '24h' | '3d' | '7d' | '14d' | '30d';

/** One day of absolute time in milliseconds (86 400 000; no DST component). */
export const HISTORY_DAY_MS = 86_400_000;

/**
 * Every §14.4 range id in ascending duration order — the display order
 * the control renders. Pinned against the server's `ROLLING_RANGE_IDS`.
 */
export const HISTORY_RANGE_IDS: readonly HistoryRangeId[] = Object.freeze([
  '24h',
  '3d',
  '7d',
  '14d',
  '30d',
]);

/** The §14.4 default range: 7 days. Pinned against `DEFAULT_ROLLING_RANGE`. */
export const HISTORY_RANGE_DEFAULT: HistoryRangeId = '7d';

/** Each range's exact duration in milliseconds — D-068's table. */
export const HISTORY_RANGE_DURATIONS_MS: Readonly<Record<HistoryRangeId, number>> = Object.freeze({
  '24h': 24 * 3_600_000,
  '3d': 3 * HISTORY_DAY_MS,
  '7d': 7 * HISTORY_DAY_MS,
  '14d': 14 * HISTORY_DAY_MS,
  '30d': 30 * HISTORY_DAY_MS,
});

/** The duration of `range` in exact UTC milliseconds. */
export function historyRangeDurationMs(range: HistoryRangeId): number {
  return HISTORY_RANGE_DURATIONS_MS[range];
}

/**
 * Whether `range` fits inside the configured retention (§14.4: disable
 * ranges that EXCEED the period — an exactly-equal range stays
 * selectable). Exact milliseconds on both sides; a 7-day retention
 * keeps the §14.4 default (7d) enabled by construction, since §11.3's
 * accepted retention minimum is 7 days.
 */
export function isHistoryRangeWithinRetention(
  range: HistoryRangeId,
  retentionDays: number,
): boolean {
  return historyRangeDurationMs(range) <= retentionDays * HISTORY_DAY_MS;
}

/** The explicit `from`/`to` request parameters, ISO 8601 UTC ending in `Z`. */
export interface HistoryRangeIsoBounds {
  readonly from: string;
  readonly to: string;
}

/**
 * Computes the §13 request boundaries of `range` ending at `nowMs`:
 * `to = nowMs`, `from = nowMs − duration` (D-068's closed interval),
 * both serialized by `toISOString()` — always UTC with the explicit
 * `Z` designator D-139's grammar requires. The bounds are recomputed
 * on every dispatch (a rolling range ends "now", so each request
 * re-anchors the window — never reuse a stale pair).
 */
export function historyRangeIsoBounds(range: HistoryRangeId, nowMs: number): HistoryRangeIsoBounds {
  return Object.freeze({
    from: new Date(nowMs - historyRangeDurationMs(range)).toISOString(),
    to: new Date(nowMs).toISOString(),
  });
}
