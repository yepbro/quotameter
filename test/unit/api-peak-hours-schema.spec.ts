import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { calculatePeakHoursIntervals } from '../../src/services/peak-hours-intervals';
import type { PeakHoursConfig } from '../../src/schemas/config';
import { HistoryRangeReportSchema } from '../../src/schemas/api/history';
import {
  LOCAL_TIME_PATTERN,
  OffPeakIntervalSchema,
  PeakHoursIntervalSchema,
  PeakHoursQuerySchema,
  PeakHoursResponseSchema,
  PeakIntervalSchema,
  PEAK_HOURS_INTERVAL_KINDS,
} from '../../src/schemas/api/peak-hours';

/**
 * The §13 peak-hours contract tables (task 162, decision D-142): the closed
 * response objects, the kind-discriminated interval union, the query grammar
 * (§13's required ISO parameters), and the no-drift rows — the schema layer
 * declares what the services layer owns as literals it cannot import, so
 * the suite pins the two sides together.
 */

/** One complete, valid peak interval (the §9.1 sample's shape). */
const VALID_PEAK = {
  kind: 'peak',
  start: 1_761_000_000_000,
  end: 1_761_014_400_000,
  multiplier: 1.0,
  windowId: 'zai-weekday-peak',
  name: 'Z.ai Coding Plan peak hours',
  localStart: '2026-10-19T14:00',
  localEnd: '2026-10-19T18:00',
} as const;

/** One complete, valid off-peak interval. */
const VALID_OFF_PEAK = {
  kind: 'off-peak',
  start: 1_761_014_400_000,
  end: 1_761_115_800_000,
  multiplier: 0.5,
  localStart: '2026-10-19T18:00',
  localEnd: '2026-10-20T14:00',
} as const;

/** One complete, valid range report of the passing outcome. */
const OK_REPORT = {
  outcome: 'ok',
  requestedFrom: 1_761_000_000_000,
  requestedTo: 1_761_115_800_000,
  effectiveFrom: 1_761_000_000_000,
  effectiveTo: 1_761_115_800_000,
  retentionHorizon: null,
} as const;

/** The complete `GET /api/peak-hours` happy body. */
const VALID_BODY = {
  accountId: 'work',
  providerId: 'zai-coding-plan',
  timezone: 'Asia/Singapore',
  offPeakMultiplier: 0.5,
  range: OK_REPORT,
  intervals: [VALID_PEAK, VALID_OFF_PEAK],
} as const;

describe('PeakHoursQuerySchema (§13 parameters)', () => {
  it('accepts the complete query and rejects missing or smuggled fields', () => {
    const validate = new Ajv2020().compile(PeakHoursQuerySchema);
    const base = {
      accountId: 'work',
      from: '2026-10-19T00:00:00.000Z',
      to: '2026-10-21T00:00:00.000Z',
    };
    expect(validate(base)).toBe(true);
    const rejected: unknown[] = [
      { accountId: 'work', from: base.from },
      { accountId: 'work', to: base.to },
      { from: base.from, to: base.to },
      { ...base, accountId: 'not an id!' },
      { ...base, accountId: '' },
      { ...base, from: '' },
      { ...base, metric: 'mcp-monthly' },
      { ...base, maxPoints: 100 },
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('The interval union (kind-discriminated)', () => {
  it('accepts each kind and rejects foreign kinds, additions, and bad shapes', () => {
    const peak = new Ajv2020().compile(PeakIntervalSchema);
    const offPeak = new Ajv2020().compile(OffPeakIntervalSchema);
    const union = new Ajv2020().compile(PeakHoursIntervalSchema);
    expect(peak(VALID_PEAK)).toBe(true);
    expect(offPeak(VALID_OFF_PEAK)).toBe(true);
    expect(union(VALID_PEAK)).toBe(true);
    expect(union(VALID_OFF_PEAK)).toBe(true);
    // The kinds do not cross: a peak entry misses the window fields, an
    // off-peak entry carries fields the complement never has.
    expect(peak({ ...VALID_PEAK, kind: 'off-peak' })).toBe(false);
    expect(offPeak({ ...VALID_OFF_PEAK, kind: 'peak' })).toBe(false);
    // Closed objects and constrained values.
    expect(peak({ ...VALID_PEAK, apiKey: 'sk-marker-secret' })).toBe(false);
    expect(offPeak({ ...VALID_OFF_PEAK, windowId: 'smuggled' })).toBe(false);
    expect(peak({ ...VALID_PEAK, multiplier: 0 })).toBe(false);
    expect(peak({ ...VALID_PEAK, multiplier: -1 })).toBe(false);
    expect(offPeak({ ...VALID_OFF_PEAK, multiplier: 0 })).toBe(false);
    expect(peak({ ...VALID_PEAK, windowId: '' })).toBe(false);
    expect(peak({ ...VALID_PEAK, start: '2026-10-19T06:00:00Z' })).toBe(false);
    expect(peak({ ...VALID_PEAK, end: 1.5 })).toBe(false);
  });

  it('local times are D-073’s yyyy-MM-ddTHH:mm strings', () => {
    const peak = new Ajv2020().compile(PeakIntervalSchema);
    expect(peak({ ...VALID_PEAK, localStart: '2026-10-19T14:00:30' })).toBe(false);
    expect(peak({ ...VALID_PEAK, localStart: '2026-10-19 14:00' })).toBe(false);
    expect(peak({ ...VALID_PEAK, localStart: '2026-10-19T14:00:00.000Z' })).toBe(false);
    expect(peak({ ...VALID_PEAK, localStart: '14:00' })).toBe(false);
    // A five-digit year stays legal: the calculator renders whatever the
    // zone's calendar holds, and retention/span bounds are policy, not
    // schema guarantees.
    expect(peak({ ...VALID_PEAK, localStart: '10202-10-19T14:00' })).toBe(true);
    expect(LOCAL_TIME_PATTERN).toBe('^\\d{4,}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$');
  });
});

describe('The response envelope (closed contract)', () => {
  it('accepts the body, the no-schedule arm, and rejects every addition', () => {
    const validate = new Ajv2020().compile(PeakHoursResponseSchema);
    expect(validate(VALID_BODY)).toBe(true);
    // The no-schedule arm: null facts, empty timeline, the same shape.
    expect(
      validate({
        accountId: 'work',
        providerId: 'zai-coding-plan',
        timezone: null,
        offPeakMultiplier: null,
        range: OK_REPORT,
        intervals: [],
      }),
    ).toBe(true);
    // The empty-windows arm still computes: one off-peak interval.
    expect(
      validate({
        accountId: 'work',
        providerId: 'zai-coding-plan',
        timezone: 'Asia/Singapore',
        offPeakMultiplier: 0.5,
        range: OK_REPORT,
        intervals: [VALID_OFF_PEAK],
      }),
    ).toBe(true);
    const rejected: unknown[] = [
      { ...VALID_BODY, apiKey: 'sk-marker-secret' },
      { ...VALID_BODY, windows: [] },
      { ...VALID_BODY, timezone: '' },
      { ...VALID_BODY, providerId: '' },
      { ...VALID_BODY, offPeakMultiplier: 0 },
      { ...VALID_BODY, accountId: 'not an id!' },
      { ...VALID_BODY, intervals: [{ kind: 'wrong' }] },
      { ...VALID_BODY, range: { outcome: 'clamped' } },
      { accountId: 'work', providerId: 'zai-coding-plan', timezone: null, intervals: [] },
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('No-drift rows (the schema layer cannot import the sources)', () => {
  it('the kind list covers the discriminated union it names', () => {
    expect(PEAK_HOURS_INTERVAL_KINDS).toEqual(['peak', 'off-peak']);
  });

  it('the range report is history’s own schema object, not a copy', () => {
    // One family, one report: the peak-hours response literally re-uses the
    // D-139 range-report schema, so the two surfaces cannot drift apart.
    const response = PeakHoursResponseSchema as { properties: { range: unknown } };
    expect(response.properties.range).toBe(HistoryRangeReportSchema);
  });

  it('the calculator’s output validates against the interval schemas', () => {
    // The timeline (D-073) was designed as this endpoint's output shape: a
    // real computed timeline — DST zone included — passes the wire contract
    // untouched, and its local times satisfy the declared pattern.
    const schedule: PeakHoursConfig = {
      timezone: 'America/New_York',
      offPeakMultiplier: 0.5,
      windows: [
        {
          id: 'ny-sunday',
          name: 'Sunday peak',
          days: ['sun'],
          start: '00:00',
          end: '24:00',
          multiplier: 1.0,
        },
      ],
    };
    const timeline = calculatePeakHoursIntervals(schedule, {
      from: Date.UTC(2026, 2, 7, 12),
      to: Date.UTC(2026, 2, 9, 12),
    });
    const validate = new Ajv2020().compile(PeakHoursIntervalSchema);
    for (const interval of timeline.intervals) {
      expect(validate({ ...interval }), JSON.stringify(interval)).toBe(true);
    }
  });
});
