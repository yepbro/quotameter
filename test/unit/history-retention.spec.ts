import { describe, expect, it } from 'vitest';
import { boundHistoryRange, type RetentionBoundedRange } from '../../src/storage/history-retention';
import { DAY_MS } from '../../src/util/rolling-ranges';

/**
 * The pure half of task 123's module (spec §11.3, §13, D-082): the clamp's
 * outcome table and validation, with no I/O — placement follows the
 * unit/integration split (docs/agents/testing.md; the rolling-ranges
 * precedent: pure table in unit, database work in
 * `test/integration/history-retention.spec.ts`). Time is data (D-021): the
 * same deterministic T0/NOW/window the integration suite seeds with.
 */

/** Deterministic §11.1 epoch-millisecond base (mirrors the integration spec). */
const T0 = 1_761_000_000_000;

/** The window's "now" — 40 days after the seed base. */
const NOW = T0 + 40 * DAY_MS;

/** The retention window under test: 30 of §11.3's 7–3650 days. */
const RETENTION_DAYS = 30;

/** The horizon that window leaves: NOW − 30 d = T0 + 10 d. */
const HORIZON = NOW - RETENTION_DAYS * DAY_MS;

/** Day-count helpers keeping the probe stamps readable. */
const days = (count: number): number => T0 + count * DAY_MS;

describe('boundHistoryRange (task 123, spec §11.3, §13, D-082)', () => {
  const window = { now: NOW, retentionDays: RETENTION_DAYS };

  it('passes a range inside retention through unchanged', () => {
    expect(boundHistoryRange({ from: days(11), to: days(20) }, window)).toEqual({
      outcome: 'ok',
      effectiveFrom: days(11),
      effectiveTo: days(20),
    });
  });

  it('truncates a partially older range to the horizon, reporting the cut', () => {
    expect(boundHistoryRange({ from: days(5), to: days(20) }, window)).toEqual({
      outcome: 'truncated',
      effectiveFrom: HORIZON,
      effectiveTo: days(20),
      requestedFrom: days(5),
    });
  });

  it('rejects a range entirely older than the horizon, reporting both', () => {
    expect(boundHistoryRange({ from: days(1), to: days(9) }, window)).toEqual({
      outcome: 'rejected',
      horizon: HORIZON,
      requestedFrom: days(1),
      requestedTo: days(9),
    });
  });

  it('decides both sides of the horizon exactly at the range edges', () => {
    // from at the horizon: nothing is cut — ok.
    expect(boundHistoryRange({ from: HORIZON, to: days(20) }, window)).toEqual({
      outcome: 'ok',
      effectiveFrom: HORIZON,
      effectiveTo: days(20),
    });
    // One millisecond older: a 1 ms truncation.
    expect(boundHistoryRange({ from: HORIZON - 1, to: days(20) }, window)).toEqual({
      outcome: 'truncated',
      effectiveFrom: HORIZON,
      effectiveTo: days(20),
      requestedFrom: HORIZON - 1,
    });
    // to at the horizon: truncated down to the single point [horizon, horizon].
    expect(boundHistoryRange({ from: days(5), to: HORIZON }, window)).toEqual({
      outcome: 'truncated',
      effectiveFrom: HORIZON,
      effectiveTo: HORIZON,
      requestedFrom: days(5),
    });
    // One millisecond short of the horizon: nothing queryable — rejected.
    expect(boundHistoryRange({ from: days(5), to: HORIZON - 1 }, window)).toEqual({
      outcome: 'rejected',
      horizon: HORIZON,
      requestedFrom: days(5),
      requestedTo: HORIZON - 1,
    });
    // A point range exactly at the horizon is the last ok instant.
    expect(boundHistoryRange({ from: HORIZON, to: HORIZON }, window)).toEqual({
      outcome: 'ok',
      effectiveFrom: HORIZON,
      effectiveTo: HORIZON,
    });
  });

  it('never clamps the upper bound — retention bounds old data only', () => {
    const to = NOW + 5 * DAY_MS;
    expect(boundHistoryRange({ from: NOW - 3_600_000, to }, window)).toEqual({
      outcome: 'ok',
      effectiveFrom: NOW - 3_600_000,
      effectiveTo: to,
    });
  });

  it('accepts §11.3 boundary windows of exactly 7 and 3650 days', () => {
    const sevenDayHorizon = NOW - 7 * DAY_MS;
    expect(
      boundHistoryRange({ from: NOW - DAY_MS, to: NOW }, { now: NOW, retentionDays: 7 }),
    ).toMatchObject({
      outcome: 'ok',
      effectiveFrom: NOW - DAY_MS,
    });
    expect(
      boundHistoryRange({ from: NOW - 10 * DAY_MS, to: NOW }, { now: NOW, retentionDays: 7 }),
    ).toMatchObject({ outcome: 'truncated', effectiveFrom: sevenDayHorizon });
    // 3650 days reaches far past every seed stamp — nothing truncates.
    expect(boundHistoryRange({ from: T0, to: NOW }, { now: NOW, retentionDays: 3650 })).toEqual({
      outcome: 'ok',
      effectiveFrom: T0,
      effectiveTo: NOW,
    });
  });

  it('rejects a window outside §11.3 before anything is read', () => {
    for (const retentionDays of [6, 3651, 180.5, Number.NaN]) {
      expect(() =>
        boundHistoryRange({ from: days(11), to: days(20) }, { now: NOW, retentionDays }),
      ).toThrow(/retentionDays must be an integer between 7 and 3650 days \(spec §11\.3\)/);
    }
  });

  it('rejects non-finite bounds and an inverted range as bad input, not outcomes', () => {
    expect(() =>
      boundHistoryRange(
        { from: days(11), to: days(20) },
        { now: Number.POSITIVE_INFINITY, retentionDays: 30 },
      ),
    ).toThrow(/now must be a finite epoch-milliseconds value/);
    expect(() =>
      boundHistoryRange({ from: Number.NaN, to: days(20) }, { now: NOW, retentionDays: 30 }),
    ).toThrow(/from and to must be finite epoch-milliseconds values/);
    expect(() =>
      boundHistoryRange(
        { from: days(11), to: Number.POSITIVE_INFINITY },
        { now: NOW, retentionDays: 30 },
      ),
    ).toThrow(/from and to must be finite epoch-milliseconds values/);
    expect(() =>
      boundHistoryRange({ from: days(20), to: days(11) }, { now: NOW, retentionDays: 30 }),
    ).toThrow(/requested range is inverted \(from > to\)/);
  });

  it('freezes the report', () => {
    const bound: RetentionBoundedRange = boundHistoryRange(
      { from: days(11), to: days(20) },
      window,
    );
    expect(Object.isFrozen(bound)).toBe(true);
  });
});
