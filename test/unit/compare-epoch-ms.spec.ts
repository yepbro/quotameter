import { describe, expect, it } from 'vitest';
import { compareByEpochMs, compareEpochMs } from '../../src/util/compare-epoch-ms';

/**
 * Unit tests for src/util/compare-epoch-ms.ts (spec §10; task U-013,
 * decision D-090; compound-key family task U-023, decision D-096): the
 * shared epoch-millisecond ordering every chronological sort in the
 * services uses. The two contract halves pinned here are the total order
 * over finite epoch-ms — exact at the ±8.64e15 ECMAScript time-value
 * bounds, where subtraction would rely on rounding — and the fail-fast
 * rejection of non-finite inputs (D-021: timestamps are validated-finite
 * data; `NaN` must never silently order as "equal"). The D-096 blocks
 * below pin the same two halves for the compound-key builder: primary
 * epoch order, ascending finite tie-break, eager per-invocation
 * validation of both roles.
 */

/** ±100 000 000 days from the epoch: ECMAScript's whole time-value range. */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/** 2026-10-30T12:00:00Z — a modern instant (the clock suite's anchor). */
const NOW_MODERN = 1_793_361_600_000;

/** 1969-12-31T00:00:00Z — a strictly pre-1970 (negative) instant. */
const NOW_PRE_EPOCH = -86_400_000;

/** One item of the builder's test domain: both keys plus an identity tag. */
interface Keyed {
  readonly at: number;
  readonly tie: number;
  readonly tag: string;
}

/** Builds a {@link Keyed} record — tags name the inputs in assertions. */
const keyed = (at: number, tie: number, tag: string): Keyed => ({ at, tie, tag });

/** The comparator under test, over both keys of {@link Keyed}. */
const byAtThenTie = compareByEpochMs(
  (item: Keyed) => item.at,
  (item: Keyed) => item.tie,
);

/** Tags of a record list, in order — the observable sort outcome. */
const tagsOf = (items: readonly Keyed[]): string[] => items.map((item) => item.tag);

describe('compareEpochMs — total order over finite epoch-ms', () => {
  it('returns −1/0/1 for less/equal/greater at everyday magnitudes', () => {
    expect(compareEpochMs(NOW_PRE_EPOCH, NOW_MODERN)).toBe(-1);
    expect(compareEpochMs(NOW_MODERN, NOW_MODERN)).toBe(0);
    expect(compareEpochMs(NOW_MODERN, NOW_PRE_EPOCH)).toBe(1);
  });

  it('orders 0 and negative (pre-1970) epochs correctly', () => {
    expect(compareEpochMs(-1, 0)).toBe(-1);
    expect(compareEpochMs(0, -1)).toBe(1);
    expect(compareEpochMs(0, 0)).toBe(0);
    expect(compareEpochMs(-2 * NOW_MODERN, -NOW_MODERN)).toBe(-1);
  });

  it('is exact at the ±8.64e15 ECMAScript time-value bounds', () => {
    // The anchors task 124's rolling-range properties generate over — and
    // the widest pair, where `a - b` (1.728e16 > 2⁵³) would already be a
    // rounded magnitude rather than an exact difference.
    expect(compareEpochMs(-MAX_EPOCH_MS, MAX_EPOCH_MS)).toBe(-1);
    expect(compareEpochMs(MAX_EPOCH_MS, -MAX_EPOCH_MS)).toBe(1);
    expect(compareEpochMs(MAX_EPOCH_MS, MAX_EPOCH_MS)).toBe(0);
    expect(compareEpochMs(-MAX_EPOCH_MS, -MAX_EPOCH_MS)).toBe(0);
    // Adjacent integers at the bound: exact, no rounding to a tie.
    expect(compareEpochMs(MAX_EPOCH_MS, MAX_EPOCH_MS - 1)).toBe(1);
    expect(compareEpochMs(-MAX_EPOCH_MS + 1, -MAX_EPOCH_MS)).toBe(1);
  });

  it('stays exact for finite magnitudes beyond the time-value range', () => {
    // The contract is a total order over *finite* epoch-ms values, not just
    // the date-representable slice; sign comparison needs no arithmetic.
    expect(compareEpochMs(Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER)).toBe(1);
    expect(compareEpochMs(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBe(-1);
    expect(compareEpochMs(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 2)).toBe(1);
  });

  it('is antisymmetric and reflexive across the domain anchors', () => {
    const anchors = [-MAX_EPOCH_MS, NOW_PRE_EPOCH, -1, 0, 1, NOW_MODERN, MAX_EPOCH_MS] as const;
    for (const a of anchors) {
      expect(compareEpochMs(a, a)).toBe(0); // reflexive
      for (const b of anchors) {
        // Antisymmetric: reversing the arguments reverses the answer (summed,
        // not negated — Object.is distinguishes +0 from -0).
        expect(compareEpochMs(a, b) + compareEpochMs(b, a)).toBe(0);
        // Transitivity at the anchors: the sign agrees with the raw <, ===, >.
        expect(Math.sign(compareEpochMs(a, b))).toBe(a < b ? -1 : a > b ? 1 : 0);
      }
    }
  });

  it('serves as an Array#sort comparator across the whole domain', () => {
    const shuffled = [NOW_MODERN, -MAX_EPOCH_MS, 0, MAX_EPOCH_MS, NOW_PRE_EPOCH];
    expect([...shuffled].sort(compareEpochMs)).toEqual([
      -MAX_EPOCH_MS,
      NOW_PRE_EPOCH,
      0,
      NOW_MODERN,
      MAX_EPOCH_MS,
    ]);
  });
});

describe('compareEpochMs — non-finite input fails fast (D-090)', () => {
  it.each([
    ['NaN in the first argument', Number.NaN, NOW_MODERN],
    ['NaN in the second argument', NOW_MODERN, Number.NaN],
    ['+Infinity in the first argument', Number.POSITIVE_INFINITY, NOW_MODERN],
    ['-Infinity in the second argument', NOW_MODERN, Number.NEGATIVE_INFINITY],
  ])('throws a TypeError on %s', (_label, a, b) => {
    expect(() => compareEpochMs(a, b)).toThrow(TypeError);
    expect(() => compareEpochMs(a, b)).toThrow(
      'compareEpochMs: timestamps must be finite UTC epoch milliseconds',
    );
  });

  it('reports both offending values in the message', () => {
    expect(() => compareEpochMs(Number.POSITIVE_INFINITY, Number.NaN)).toThrow(
      'got Infinity and NaN',
    );
  });
});

describe('compareByEpochMs — compound total order over (primary, tie-break)', () => {
  it('orders by the primary key at everyday magnitudes', () => {
    expect(byAtThenTie(keyed(NOW_PRE_EPOCH, 9, 'a'), keyed(NOW_MODERN, 0, 'b'))).toBe(-1);
    expect(byAtThenTie(keyed(NOW_MODERN, 0, 'a'), keyed(NOW_PRE_EPOCH, 9, 'b'))).toBe(1);
    // The tie-break never fires when the primary key decides.
    expect(byAtThenTie(keyed(NOW_MODERN, -1, 'a'), keyed(NOW_MODERN + 1, 5, 'b'))).toBe(-1);
  });

  it('breaks exact primary ties by the tie-break, ascending', () => {
    expect(byAtThenTie(keyed(NOW_MODERN, -1, 'a'), keyed(NOW_MODERN, 0, 'b'))).toBe(-1);
    expect(byAtThenTie(keyed(NOW_MODERN, 0, 'a'), keyed(NOW_MODERN, 0, 'b'))).toBe(0);
    expect(byAtThenTie(keyed(NOW_MODERN, 2, 'a'), keyed(NOW_MODERN, 1, 'b'))).toBe(1);
  });

  it('is exact at the ±8.64e15 anchors for both key roles', () => {
    // Primary: the widest epoch pair, where a difference is a rounded
    // magnitude; the tie-break plays no role.
    expect(byAtThenTie(keyed(-MAX_EPOCH_MS, 5, 'a'), keyed(MAX_EPOCH_MS, -5, 'b'))).toBe(-1);
    expect(byAtThenTie(keyed(MAX_EPOCH_MS, 5, 'a'), keyed(MAX_EPOCH_MS - 1, -5, 'b'))).toBe(1);
    // Tie-break: the same exactness at magnitudes no epoch pair reaches.
    expect(
      byAtThenTie(keyed(NOW_MODERN, Number.MAX_SAFE_INTEGER, 'a'), keyed(NOW_MODERN, 0, 'b')),
    ).toBe(1);
    expect(
      byAtThenTie(keyed(NOW_MODERN, -Number.MAX_SAFE_INTEGER, 'a'), keyed(NOW_MODERN, 0, 'b')),
    ).toBe(-1);
    expect(
      byAtThenTie(
        keyed(NOW_MODERN, Number.MAX_SAFE_INTEGER, 'a'),
        keyed(NOW_MODERN, Number.MAX_SAFE_INTEGER - 2, 'b'),
      ),
    ).toBe(1);
  });

  it('is antisymmetric and reflexive across anchor pairs of both keys', () => {
    const anchors = [-MAX_EPOCH_MS, NOW_PRE_EPOCH, -1, 0, 1, NOW_MODERN, MAX_EPOCH_MS] as const;
    for (const at of anchors) {
      for (const tie of anchors) {
        const item = keyed(at, tie, `${at}/${tie}`);
        expect(byAtThenTie(item, item)).toBe(0); // reflexive
        for (const otherAt of anchors) {
          for (const otherTie of anchors) {
            const other = keyed(otherAt, otherTie, `${otherAt}/${otherTie}`);
            // Antisymmetric: reversing the arguments reverses the answer.
            expect(byAtThenTie(item, other) + byAtThenTie(other, item)).toBe(0);
            // Transitivity of the sign: the pair order agrees with the
            // lexicographic reading of the two keys.
            const expected =
              at < otherAt ? -1 : at > otherAt ? 1 : tie < otherTie ? -1 : tie > otherTie ? 1 : 0;
            expect(byAtThenTie(item, other)).toBe(expected);
          }
        }
      }
    }
  });

  it('serves as an Array#sort comparator across the whole domain', () => {
    const shuffled = [
      keyed(NOW_MODERN, 1, 'modern-1'),
      keyed(-MAX_EPOCH_MS, 0, 'min-0'),
      keyed(NOW_MODERN, 0, 'modern-0'),
      keyed(0, 7, 'zero-7'),
      keyed(NOW_PRE_EPOCH, 3, 'pre-3'),
      keyed(MAX_EPOCH_MS, 0, 'max-0'),
      keyed(0, -7, 'zero-neg7'),
    ];
    expect(tagsOf([...shuffled].sort(byAtThenTie))).toEqual([
      'min-0',
      'pre-3',
      'zero-neg7',
      'zero-7',
      'modern-0',
      'modern-1',
      'max-0',
    ]);
  });

  it('returns 0 for equal keys, keeping input order in a stable sort', () => {
    // The peak-hours union's pinned expectation: at equal (start, end) the
    // earlier-listed occurrence is the one reported.
    const equalKeys = [keyed(NOW_MODERN, 5, 'first'), keyed(NOW_MODERN, 5, 'second')];
    expect(byAtThenTie(equalKeys[0]!, equalKeys[1]!)).toBe(0);
    expect(tagsOf([...equalKeys].sort(byAtThenTie))).toEqual(['first', 'second']);
  });
});

describe('compareByEpochMs — non-finite input fails fast (D-096)', () => {
  it.each([
    ['NaN in the first item’s primary', Number.NaN, NOW_MODERN, 0, 0],
    ['NaN in the second item’s primary', NOW_MODERN, Number.NaN, 0, 0],
    ['+Infinity in the first item’s primary', Number.POSITIVE_INFINITY, NOW_MODERN, 0, 0],
    ['-Infinity in the second item’s primary', NOW_MODERN, Number.NEGATIVE_INFINITY, 0, 0],
  ])('throws a TypeError on %s', (_label, atA, atB, tieA, tieB) => {
    expect(() => byAtThenTie(keyed(atA, tieA, 'a'), keyed(atB, tieB, 'b'))).toThrow(TypeError);
    expect(() => byAtThenTie(keyed(atA, tieA, 'a'), keyed(atB, tieB, 'b'))).toThrow(
      'compareByEpochMs: primary keys must be finite UTC epoch milliseconds',
    );
  });

  it.each([
    ['NaN in the first item’s tie-break', NOW_MODERN, 0, Number.NaN, 0],
    ['NaN in the second item’s tie-break', NOW_MODERN, 0, 0, Number.NaN],
    ['+Infinity in the first item’s tie-break', NOW_MODERN, 0, Number.POSITIVE_INFINITY, 0],
    ['-Infinity in the second item’s tie-break', NOW_MODERN, 0, 0, Number.NEGATIVE_INFINITY],
  ])('throws a TypeError on %s', (_label, atA, atB, tieA, tieB) => {
    expect(() => byAtThenTie(keyed(atA, tieA, 'a'), keyed(atB, tieB, 'b'))).toThrow(TypeError);
    expect(() => byAtThenTie(keyed(atA, tieA, 'a'), keyed(atB, tieB, 'b'))).toThrow(
      'compareByEpochMs: tie-break keys must be finite numbers',
    );
  });

  it('validates the tie-break even when the primary keys differ', () => {
    // Eager per-invocation validation (D-096): the tie-break key is a
    // property of the record, so a corrupt one is rejected even when this
    // comparison would already be decided by the primary keys — the throw
    // must not depend on where a sort stops comparing.
    expect(() =>
      byAtThenTie(keyed(NOW_MODERN, Number.NaN, 'a'), keyed(NOW_MODERN + 1, 0, 'b')),
    ).toThrow('tie-break keys must be finite numbers');
  });

  it('reports the primary violation before the tie-break violation', () => {
    expect(() =>
      byAtThenTie(keyed(Number.NaN, Number.NaN, 'a'), keyed(NOW_MODERN, 0, 'b')),
    ).toThrow('primary keys must be finite UTC epoch milliseconds');
  });

  it('reports both offending values per role in the message', () => {
    expect(() =>
      byAtThenTie(
        keyed(NOW_MODERN, Number.POSITIVE_INFINITY, 'a'),
        keyed(NOW_MODERN, Number.NaN, 'b'),
      ),
    ).toThrow('got Infinity and NaN');
    expect(() =>
      byAtThenTie(keyed(Number.NaN, 0, 'a'), keyed(Number.POSITIVE_INFINITY, 0, 'b')),
    ).toThrow('got NaN and Infinity');
  });
});
