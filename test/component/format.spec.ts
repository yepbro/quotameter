import { describe, expect, it } from 'vitest';
import {
  formatChartDate,
  formatChartDuration,
  formatEpochMs,
  formatQuotaNumber,
  formatRelative,
  windowHours,
} from '../../ui/src/format';

/**
 * The §14.1 formatting helpers (task 172, D-137): every function is pure
 * in its inputs, so the whole matrix is deterministic — the component
 * specs assert presence and relative phrases; the exact rendering lives
 * here.
 */

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0); // 2026-11-03T12:00:00Z

describe('formatQuotaNumber (§14.3 explicit numbers)', () => {
  it('groups large values and keeps at most two fraction digits', () => {
    expect(formatQuotaNumber(120_000)).toBe('120,000');
    expect(formatQuotaNumber(42.5)).toBe('42.5');
    expect(formatQuotaNumber(33.333_333)).toBe('33.33');
  });

  it('renders a genuine zero as zero — the hostile-formatter pin', () => {
    expect(formatQuotaNumber(0)).toBe('0');
  });
});

describe('formatEpochMs (§14.1 configured display time zone)', () => {
  it('formats the same instant differently per zone', () => {
    const instant = Date.UTC(2026, 10, 3, 9, 5, 0);
    expect(formatEpochMs(instant, 'UTC')).toBe('Nov 3, 2026, 9:05 AM');
    expect(formatEpochMs(instant, 'America/New_York')).toBe('Nov 3, 2026, 4:05 AM');
    expect(formatEpochMs(instant, 'Asia/Singapore')).toBe('Nov 3, 2026, 5:05 PM');
  });

  it('honors a zone with a non-whole-hour offset', () => {
    const instant = Date.UTC(2026, 10, 3, 18, 30, 0);
    expect(formatEpochMs(instant, 'Asia/Kolkata')).toBe('Nov 4, 2026, 12:00 AM');
  });
});

describe('formatChartDate (§14.4 chart ticks and tooltips)', () => {
  it('formats compact chart dates in the configured zone', () => {
    const instant = Date.UTC(2026, 10, 4, 14, 0, 0);
    expect(formatChartDate(instant, 'UTC')).toBe('Nov 4, 2:00 PM');
    expect(formatChartDate(instant, 'America/New_York')).toBe('Nov 4, 9:00 AM');
  });

  it('honors a zone with a non-whole-hour offset', () => {
    const instant = Date.UTC(2026, 10, 4, 18, 45, 0);
    expect(formatChartDate(instant, 'Asia/Kathmandu')).toBe('Nov 5, 12:30 AM');
  });
});

describe('formatChartDuration (§14.4/§12.2 annotation facts, task 176)', () => {
  it('renders seconds, minutes, and mixed hours/minutes compactly', () => {
    expect(formatChartDuration(45_000)).toBe('45s');
    expect(formatChartDuration(2_820_000)).toBe('47m');
    expect(formatChartDuration(5_400_000)).toBe('1h 30m');
    expect(formatChartDuration(7_200_000)).toBe('2h');
  });

  it('states zero for degenerate spans instead of inventing time', () => {
    expect(formatChartDuration(0)).toBe('0s');
    expect(formatChartDuration(-5)).toBe('0s');
    expect(formatChartDuration(Number.NaN)).toBe('0s');
  });
});

describe('formatRelative (§14.3 relative to current time)', () => {
  it.each([
    [0, 'now'],
    [30_000, 'in 30 seconds'],
    [-30_000, '30 seconds ago'],
    [120_000, 'in 2 minutes'],
    [-120_000, '2 minutes ago'],
    [2 * 3_600_000, 'in 2 hours'],
    [-3 * 3_600_000, '3 hours ago'],
    [2 * 86_400_000, 'in 2 days'],
    [-6 * 86_400_000, '6 days ago'],
    [8 * 86_400_000, 'next week'],
    [-40 * 86_400_000, 'last month'],
    [-400 * 86_400_000, 'last year'],
    [2 * 365.25 * 86_400_000, 'in 2 years'],
  ])('NOW + %i ms → %s', (offsetMs: number, expected: string) => {
    expect(formatRelative(NOW + offsetMs, NOW)).toBe(expected);
  });

  it('rounds to the nearest unit value at bucket edges', () => {
    // 90 s is in the minute bucket and rounds to 2 minutes.
    expect(formatRelative(NOW + 90_000, NOW)).toBe('in 2 minutes');
    // 45 minutes stays in the minute bucket — 45 minutes, not 1 hour
    // (the hour bucket begins at 3,600 s).
    expect(formatRelative(NOW + 45 * 60_000, NOW)).toBe('in 45 minutes');
  });
});

describe('windowHours (§8.4 rolling-window metadata)', () => {
  it('returns whole hours for integral windows', () => {
    expect(windowHours(18_000)).toBe(5);
    expect(windowHours(3_600)).toBe(1);
  });

  it('returns undefined for non-integral or non-positive lengths', () => {
    expect(windowHours(5_400)).toBeUndefined();
    expect(windowHours(0)).toBeUndefined();
    expect(windowHours(-3_600)).toBeUndefined();
  });
});
