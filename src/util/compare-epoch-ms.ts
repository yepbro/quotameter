/**
 * Total ordering of UTC epoch-millisecond timestamps (spec §10; task U-013,
 * decision D-090; compound-key family task U-023, decision D-096).
 *
 * One shared contract family for every chronological sort over `EpochMs`
 * data: the single-key comparator that replaced the byte-identical private
 * copies the history services each carried (tasks 119–121) and, since
 * U-023, the compound-key builder that replaced the two subtraction-based
 * sorts the U-013 census left outside its file set (`peak-hours-intervals.ts`'s
 * `(start, end)` and `storage/backups.ts`'s `(timestampMs, seq)`). It lives
 * beside the clock as a leaf of the same layer (D-021: the clock API owns
 * time, and ordering timestamps is a clock-adjacent, dependency-free concern
 * — the single-siting discipline that motivated this module).
 *
 * Contract (D-090, extended by D-096):
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
 * - **Compound keys (D-096).** `compareByEpochMs(primary, tieBreak)` builds
 *   an `Array#sort` comparator that orders by the primary epoch key and
 *   breaks exact ties by a second key: any finite number, ascending, the
 *   same sign ladder. The tie-break domain is deliberately just "finite
 *   number" — the services site's second key is an epoch (`end`), the
 *   storage site's is an integer counter (`seq`), and the family claims
 *   neither. Non-finite throws exactly like the primary key, and both keys
 *   of both items are validated on every invocation, so rejection never
 *   depends on where a sort happens to stop comparing.
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
  return signOrder(a, b);
}

/**
 * Builds a comparator over `T` items that orders by the primary epoch-ms
 * key and breaks exact ties by `tieBreak`: −1/0/1, ascending in both
 * roles, usable directly as an `Array#sort` comparator (stable sorts keep
 * input order when both keys are equal). One key extractor per role, each
 * reading one item — the call site names its own keys (an epoch pair at
 * the services site, an instant plus an integer sequence at the storage
 * site), and mixing keys between items is unrepresentable.
 *
 * Both keys of both items are validated on every invocation, primary pair
 * first: a non-finite key of either role throws a `TypeError` naming both
 * values of that role, even when the comparison would already be decided —
 * a corrupt tie-break key is rejected deterministically, not only when a
 * tie happens to occur.
 *
 * @throws `TypeError` when any extracted key is not a finite number
 *   (`NaN`, `±Infinity`) — see the module contract above.
 */
export function compareByEpochMs<T>(
  primary: (item: T) => EpochMs,
  tieBreak: (item: T) => number,
): (a: T, b: T) => number {
  return (a: T, b: T): number => {
    const aPrimary = primary(a);
    const bPrimary = primary(b);
    if (!Number.isFinite(aPrimary) || !Number.isFinite(bPrimary)) {
      throw new TypeError(
        `compareByEpochMs: primary keys must be finite UTC epoch milliseconds, got ${aPrimary} and ${bPrimary}`,
      );
    }
    const aTie = tieBreak(a);
    const bTie = tieBreak(b);
    if (!Number.isFinite(aTie) || !Number.isFinite(bTie)) {
      throw new TypeError(
        `compareByEpochMs: tie-break keys must be finite numbers, got ${aTie} and ${bTie}`,
      );
    }
    if (aPrimary !== bPrimary) {
      return signOrder(aPrimary, bPrimary);
    }
    return signOrder(aTie, bTie);
  };
}

/**
 * The exact sign ladder shared by both comparators — subtraction-free, so
 * exact at every finite magnitude (D-090). Callers validate finiteness
 * first: distinct finite arguments never draw the `0` arm here.
 */
function signOrder(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
