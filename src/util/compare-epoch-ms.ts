/**
 * Total ordering of UTC epoch-millisecond timestamps (spec §10; task U-013,
 * decision D-090).
 *
 * One shared comparator for every chronological sort over `EpochMs` data,
 * replacing the byte-identical private copies the history services each
 * carried (tasks 119–121). It lives beside the clock as a leaf of the same
 * layer (D-021: the clock API owns time, and ordering timestamps is a
 * clock-adjacent, dependency-free concern — the single-siting discipline
 * that motivated this module).
 *
 * Contract (D-090):
 *
 * - **Total order over finite epoch-ms.** Exact −1/0/1 sign comparison —
 *   no subtraction, so no precision corners anywhere in the finite domain:
 *   exact at the ±8.64e15 ECMAScript time-value bounds (the domain task
 *   124's rolling-range properties generate over), where a difference-based
 *   comparator starts relying on IEEE-754 rounding for magnitudes ≥ 2⁵³.
 * - **Non-finite input fails fast.** `NaN` and `±Infinity` throw: D-021
 *   treats timestamps as validated-finite data (the clock and every service
 *   seam reject non-finite values before ordering), and the sign-only form
 *   would silently answer "equal" for `NaN` against anything — not a total
 *   order, and a quiet degenerate sort over corrupt data. A non-finite
 *   timestamp reaching an ordering decision is a missed validation seam and
 *   fails loudly here (the D-059/D-064 fail-fast convention).
 */

import type { EpochMs } from './clock';

/**
 * Orders two epoch-millisecond timestamps: −1 when `a` precedes `b`, `0`
 * when they are equal, 1 when `a` follows — usable directly as an
 * `Array#sort` comparator (stable sorts keep input order on `0`).
 *
 * @throws `TypeError` when either argument is not a finite number
 *   (`NaN`, `±Infinity`) — see the module contract above.
 */
export function compareEpochMs(a: EpochMs, b: EpochMs): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new TypeError(
      `compareEpochMs: timestamps must be finite UTC epoch milliseconds, got ${a} and ${b}`,
    );
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
