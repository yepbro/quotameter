import { describe, expect, it } from 'vitest';
import { compareEpochMs } from '../../src/util/compare-epoch-ms';

/**
 * Unit tests for src/util/compare-epoch-ms.ts (spec §10; task U-013,
 * decision D-090): the shared epoch-millisecond ordering every
 * chronological sort in the services uses. The two contract halves pinned
 * here are the total order over finite epoch-ms — exact at the ±8.64e15
 * ECMAScript time-value bounds, where subtraction would rely on rounding —
 * and the fail-fast rejection of non-finite inputs (D-021: timestamps are
 * validated-finite data; `NaN` must never silently order as "equal").
 */

/** ±100 000 000 days from the epoch: ECMAScript's whole time-value range. */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/** 2026-10-30T12:00:00Z — a modern instant (the clock suite's anchor). */
const NOW_MODERN = 1_793_361_600_000;

/** 1969-12-31T00:00:00Z — a strictly pre-1970 (negative) instant. */
const NOW_PRE_EPOCH = -86_400_000;

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
