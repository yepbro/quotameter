/**
 * Rolling range calculations (spec §10, §13, §14.4; task 116, decision D-068).
 *
 * "Last N hours/days" means a rolling interval ending now (spec §10): the
 * caller passes explicit `from`/`to` bounds to the server, which filters
 * history server-side. This module computes those bounds as pure UTC epoch
 * millisecond arithmetic — `to = now`, `from = now − duration` — with no
 * calendar or DST wall-clock component, so a "24 hours" range is exactly
 * 86 400 000 ms of absolute time even across a DST transition.
 *
 * Scope decisions (decision D-068):
 *
 * - The supported range vocabulary is the closed set of spec §14.4 —
 *   24 hours, 3 days, 7 days (default), 14 days, and 30 days — modeled as a
 *   typed union; §13's endpoints carry only explicit `from`/`to` values, and
 *   this module is where those values come from. Nothing speculative.
 * - `now` is always an argument, never the machine clock (the D-021
 *   discipline of `clock.ts`); the module reads no environment, no system
 *   zone, and no `TZ`, so the bounds are identical under any `TZ` setting
 *   by construction. The multi-`TZ` invariance suite
 *   (`test/integration/rolling-ranges-tz.spec.ts`) verifies that in real
 *   child processes.
 * - The bounds form a closed interval `[from, to]` — both ends inclusive.
 *   The spec is silent on inclusivity; the pin lives here so the server-side
 *   filter (`collected_at >= from AND collected_at <= to`, Stage 12) and the
 *   `rollingRangeContains` predicate cannot drift apart.
 */

import type { EpochMs } from './clock';

/* ── Vocabulary ────────────────────────────────────────────────────────── */

/**
 * A supported rolling range id (spec §14.4): `24h`, `3d`, `7d`, `14d`,
 * `30d`. The closed union is the whole vocabulary — the HTTP layer and UI
 * select from it, and unknown ids are rejected at runtime with the valid
 * ids listed.
 */
export type RollingRangeId = '24h' | '3d' | '7d' | '14d' | '30d';

/**
 * Every supported range id in ascending duration order — the display order
 * range selectors use (spec §14.4).
 */
export const ROLLING_RANGE_IDS: readonly RollingRangeId[] = Object.freeze([
  '24h',
  '3d',
  '7d',
  '14d',
  '30d',
]);

/** The default range of the history view: 7 days (spec §14.4). */
export const DEFAULT_ROLLING_RANGE: RollingRangeId = '7d';

/** One hour in milliseconds — exact in IEEE-754 at every realistic epoch. */
export const HOUR_MS = 3_600_000;

/** One day of absolute time in milliseconds (86 400 000; no DST component). */
export const DAY_MS = 86_400_000;

/**
 * Duration of each range in milliseconds. Exact duration arithmetic only:
 * a range is a fixed number of hours/days of absolute time, so a "24h"
 * range spanning a spring-forward transition is still 86 400 000 ms long.
 */
const DURATIONS_MS: Readonly<Record<RollingRangeId, number>> = Object.freeze({
  '24h': 24 * HOUR_MS,
  '3d': 3 * DAY_MS,
  '7d': 7 * DAY_MS,
  '14d': 14 * DAY_MS,
  '30d': 30 * DAY_MS,
});

/* ── Bounds ────────────────────────────────────────────────────────────── */

/**
 * The explicit boundaries of a rolling interval (spec §10): UTC epoch
 * milliseconds, ready to serialize with `toUtcIso` for the §13 endpoints.
 * A **closed** interval — `from` and `to` are both inclusive (D-068).
 */
export interface RollingRangeBounds {
  /** Interval start, `now − duration`; inclusive. */
  readonly from: EpochMs;
  /** Interval end, `now`; inclusive. */
  readonly to: EpochMs;
}

/**
 * The duration of `range` in exact UTC milliseconds. Throws for an unknown
 * id with the valid ids listed — the registry's error discipline (D-013).
 */
export function rollingRangeDurationMs(range: RollingRangeId): number {
  return durationsFor(range)[range];
}

/**
 * Computes the explicit `from`/`to` bounds of `range` ending at `now`
 * (spec §10): `to = now` and `from = now − duration`, both inclusive.
 * `now` is an argument in the clock module's discipline (D-021) — callers
 * inject the clock; nothing here reads the machine clock.
 *
 * Throws for an unknown range id or a non-finite `now`. For finite `now`
 * the subtraction itself cannot leave the finite range: the largest
 * duration (2 592 000 000 ms) is far below the float spacing at
 * `Number.MAX_VALUE`, so the result is at worst absorbed (`from === now`)
 * — documented float-exact behavior, never `Infinity`.
 */
export function rollingRangeBounds(range: RollingRangeId, now: EpochMs): RollingRangeBounds {
  const durationMs = durationsFor(range)[range];
  if (!Number.isFinite(now)) {
    throw new Error(`now must be a finite number, got ${now}`);
  }
  return Object.freeze({ from: now - durationMs, to: now });
}

/**
 * Whether `epochMs` lies inside `bounds` — the executable definition of the
 * closed-interval pin (D-068): both `from` and `to` are inclusive, matching
 * the server-side filter the §13 endpoints apply. A non-finite probe (NaN)
 * is inside nothing.
 */
export function rollingRangeContains(bounds: RollingRangeBounds, epochMs: EpochMs): boolean {
  return epochMs >= bounds.from && epochMs <= bounds.to;
}

/** The duration table for a validated `range`, or a loud English error. */
function durationsFor(range: RollingRangeId): Readonly<Record<RollingRangeId, number>> {
  if (typeof range !== 'string' || !Object.hasOwn(DURATIONS_MS, range)) {
    throw new Error(
      `unknown rolling range '${String(range)}'; expected one of: ${ROLLING_RANGE_IDS.map((id) => `'${id}'`).join(', ')}`,
    );
  }
  return DURATIONS_MS;
}
