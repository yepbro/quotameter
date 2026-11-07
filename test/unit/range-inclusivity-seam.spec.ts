import { describe, expect, it } from 'vitest';
import { epochMsFromIso, type EpochMs } from '../../src/util/clock';
import { DAY_MS, rollingRangeBounds, rollingRangeContains } from '../../src/util/rolling-ranges';
import {
  calculatePeakHoursIntervals,
  type PeakHoursTimeline,
} from '../../src/services/peak-hours-intervals';
import type { PeakHoursConfig, PeakWindow } from '../../src/schemas/config';
import { boundHistoryRange } from '../../src/storage/history-retention';

/**
 * The range-inclusivity seam pin (decision D-171): the two range
 * conventions that meet at the §13 boundary are asserted **side by side,
 * cross-module**, so neither can be silently normalized.
 *
 * - The **history side is closed** `[from, to]` — the rolling-range bounds
 *   (D-068, `rollingRangeContains` — the executable twin of the
 *   server-side filter, whose SQL-level closedness the repository suite
 *   pins per read: `collected_at`, `event_at`, and `started_at` each keep
 *   an exact-at-`to` row asserted) and the retention bounds (D-082, whose
 *   effective range keeps the reads' closed convention). Closed suits
 *   point membership: a row stamped exactly at `to` is inside the read.
 * - The **peak-hours side is half-open** `[from, to)` (D-073): the
 *   timeline partitions its range into adjacent, non-overlapping
 *   intervals, and half-open bounds are what make adjacent ranges tile
 *   with no gap and no double coverage — closing them would double-cover
 *   every shared edge and break D-073's partition contract.
 *
 * The seam is deliberate, not drift: the same numeric `from`/`to` pair
 * serves both surfaces (§13's `GET /api/history` and `GET /api/peak-hours`
 * receive the UI's rolling bounds). A change that closes the peak-hours
 * range or half-opens the history predicates fails the seam block below
 * (and the predicate twins' own suites hold the SQL honest).
 *
 * Naming: this spec is deliberately outside the `test:time` filter
 * vocabulary (clock/rolling-ranges/peak-hours/compare-epoch-ms, D-097) —
 * it is a pure numeric cross-module contract, not a module suite; the
 * module specs themselves run in the §17.1 TZ matrix, and every input
 * here is an explicit epoch (D-021), so the pin is TZ-invariant by
 * construction. It follows the cross-module precedent of
 * `test/unit/history-cross.property.spec.ts` (task 124).
 */

/** `epochMsFromIso` under a shorter name — every instant is a pinned literal. */
const iso = epochMsFromIso;

/** A peak window with overridable fields (the §9.2 sample shape). */
const window = (overrides: Partial<PeakWindow> = {}): PeakWindow => ({
  id: 'w1',
  name: 'W1',
  days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  start: '00:00',
  end: '24:00',
  ...overrides,
});

/** A UTC schedule whose single window covers every whole local day. */
const fullCoverageSchedule = (overrides: Partial<PeakHoursConfig> = {}): PeakHoursConfig => ({
  timezone: 'UTC',
  windows: [window()],
  ...overrides,
});

/** The half-open membership predicate of a timeline's intervals. */
const coveredBy = (timeline: PeakHoursTimeline, instant: EpochMs): boolean =>
  timeline.intervals.some((interval) => interval.start <= instant && instant < interval.end);

describe('the history side of the seam is closed (D-068, D-082)', () => {
  it('rolling-range bounds include both ends: `to` — now itself — is inside', () => {
    const now = iso('2026-11-02T12:00:00Z');
    const bounds = rollingRangeBounds('7d', now);
    expect(rollingRangeContains(bounds, bounds.from)).toBe(true);
    expect(rollingRangeContains(bounds, now)).toBe(true);
  });

  it('retention bounds keep the closed convention at both edges of the horizon', () => {
    const now = iso('2026-11-02T12:00:00Z');
    const window30d = { now, retentionDays: 30 };
    const horizon = now - 30 * DAY_MS;
    // `from` exactly at the horizon: nothing is cut — a row collected at
    // the horizon is retained (D-082's closed lower edge, aligned with
    // the delete side's strict-before deletes), and `to` passes through
    // as the inclusive upper bound the reads filter on.
    expect(boundHistoryRange({ from: horizon, to: now }, window30d)).toEqual({
      outcome: 'ok',
      effectiveFrom: horizon,
      effectiveTo: now,
    });
  });
});

describe('the peak-hours side of the seam is half-open (D-073)', () => {
  it('partitions exactly [from, to): the `to` instant belongs to no interval', () => {
    const from = iso('2026-11-02T00:00:00Z');
    const to = iso('2026-11-03T00:00:00Z');
    const timeline = calculatePeakHoursIntervals(fullCoverageSchedule(), { from, to });
    expect(coveredBy(timeline, from)).toBe(true);
    expect(coveredBy(timeline, to - 1)).toBe(true);
    expect(coveredBy(timeline, to)).toBe(false);
  });

  it('adjacent half-open ranges tile: no gap and no double coverage at the shared edge', () => {
    // The property that forced half-open bounds (D-073): two adjacent
    // query ranges mirror each window edge exactly once. The same
    // assertion over closed bounds would double-cover the shared edge.
    const a = iso('2026-11-02T00:00:00Z');
    const b = iso('2026-11-02T12:00:00Z');
    const c = iso('2026-11-03T00:00:00Z');
    const first = calculatePeakHoursIntervals(fullCoverageSchedule(), { from: a, to: b });
    const second = calculatePeakHoursIntervals(fullCoverageSchedule(), { from: b, to: c });
    const tiled = [...first.intervals, ...second.intervals];
    for (const instant of [a, b - 1, b, c - 1]) {
      expect(
        tiled.filter((interval) => interval.start <= instant && instant < interval.end),
        `instant ${instant}`,
      ).toHaveLength(1);
    }
    expect(coveredBy(first, b)).toBe(false);
    expect(coveredBy(second, b)).toBe(true);
  });

  it('a mixed peak/off-peak timeline is adjacent and covers exactly to − from', () => {
    const from = iso('2026-11-02T00:00:00Z');
    const to = iso('2026-11-04T00:00:00Z');
    const schedule = fullCoverageSchedule({
      windows: [window({ days: ['mon'], start: '06:00', end: '18:00' })],
    });
    const timeline = calculatePeakHoursIntervals(schedule, { from, to });
    // Chronological, adjacent, single coverage — the partition contract.
    let cursor = from;
    let total = 0;
    const kinds = new Set<string>();
    for (const interval of timeline.intervals) {
      expect(interval.start).toBe(cursor);
      expect(interval.end).toBeGreaterThan(interval.start);
      cursor = interval.end;
      total += interval.end - interval.start;
      kinds.add(interval.kind);
    }
    expect(cursor).toBe(to);
    expect(total).toBe(to - from);
    expect(kinds).toEqual(new Set(['peak', 'off-peak']));
  });
});

describe('the seam itself: one numeric pair, two deliberate conventions (D-171)', () => {
  it('identical bounds: history includes `to`, peak-hours ends before it', () => {
    // The §13 boundary in miniature: the UI's one numeric `from`/`to`
    // pair serves both surfaces. This block fails if either side is
    // silently normalized — closing the peak range breaks the first
    // expect, half-opening the rolling predicate breaks the second.
    const now = iso('2026-11-02T12:00:00Z');
    const from = now - 7 * DAY_MS;
    const bounds = rollingRangeBounds('7d', now);
    expect(bounds.from).toBe(from);
    expect(bounds.to).toBe(now);
    const historyIncludesTo = rollingRangeContains(bounds, now);
    const timeline = calculatePeakHoursIntervals(fullCoverageSchedule(), { from, to: now });
    const peakIncludesTo = coveredBy(timeline, now);
    expect(historyIncludesTo).toBe(true);
    expect(peakIncludesTo).toBe(false);
  });
});
