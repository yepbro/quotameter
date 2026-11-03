import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import {
  CollectionErrorEventItemSchema,
  EventsQuerySchema,
  EventsResponseSchema,
  EVENT_ITEM_KINDS,
  GapEventItemSchema,
  HistoryBucketSchema,
  HistoryEmptyPointSchema,
  HistoryPointSchema,
  HistoryQuerySchema,
  HistoryRangeReportSchema,
  HistoryResponseSchema,
  HISTORY_MAX_POINTS_DEFAULT,
  HISTORY_MAX_POINTS_MAX,
  HISTORY_MAX_POINTS_MIN,
  HISTORY_POINT_KINDS,
  ResetEventItemSchema,
  RETENTION_RANGE_OUTCOMES,
  StoppedServiceEventItemSchema,
} from '../../src/schemas/api/history';
import { ACCOUNT_ERROR_OUTCOMES } from '../../src/schemas/api/status';
import {
  DEFAULT_MAX_POINTS,
  MAX_MAX_POINTS,
  MIN_MAX_POINTS,
} from '../../src/services/history-downsample';
import type { RetentionBoundedRange } from '../../src/storage/history-retention';

/**
 * The §13 history/events contract tables (task 161, decision D-139): the
 * closed response objects, the kind-discriminated item unions, the query
 * grammar (§13's required ISO parameters beside the `maxPoints` budget),
 * and the no-drift rows — the schema layer declares §13's own numbers as
 * literals (it is a leaf and cannot import the services layer), so the
 * suite pins them against the landed constants they must equal.
 */

/** One complete, valid point-endpoint value vocabulary. */
const VALID_POINT_VALUES = {
  collectedAt: 1_761_000_000_000,
  used: 80,
  remaining: 20,
  limit: 100,
  percentUsed: 80,
  percentRemaining: 20,
  resetsAt: 1_761_086_400_000,
  isValid: true,
  invalidReason: null,
} as const;

/** The points-array entry form (the `kind` discriminator added). */
const VALID_POINT = { kind: 'point', ...VALID_POINT_VALUES } as const;

/** One complete, valid bucket. */
const VALID_BUCKET = {
  kind: 'bucket',
  fromEpochMs: 1_761_000_000_000,
  toEpochMs: 1_761_003_000_000,
  count: 3,
  min: { used: 10, remaining: 20, percentUsed: null, percentRemaining: null },
  max: { used: 80, remaining: 20, percentUsed: null, percentRemaining: null },
  first: VALID_POINT_VALUES,
  last: { ...VALID_POINT_VALUES, used: 10, remaining: 90, percentUsed: 10, percentRemaining: 90 },
} as const;

/** One complete, valid range report of the passing outcome. */
const OK_REPORT = {
  outcome: 'ok',
  requestedFrom: 0,
  requestedTo: 100,
  effectiveFrom: 0,
  effectiveTo: 100,
  retentionHorizon: null,
} as const;

/** The complete `GET /api/history` happy body. */
const VALID_HISTORY_BODY = {
  accountId: 'acc-main',
  metric: 'mcp-monthly',
  unit: 'CREDITS',
  limitType: 'MONTHLY',
  range: OK_REPORT,
  downsampled: false,
  resolutionMs: null,
  sourcePointCount: 1,
  points: [VALID_POINT, { kind: 'empty', collectedAt: 50 }],
} as const;

describe('HistoryQuerySchema (§13 parameters)', () => {
  it('accepts the complete query and applies the maxPoints bounds', () => {
    const validate = new Ajv2020({ useDefaults: true }).compile(HistoryQuerySchema);
    const query: Record<string, unknown> = {
      accountId: 'acc-main',
      metric: 'mcp-monthly',
      from: '2026-10-27T00:00:00.000Z',
      to: '2026-11-03T00:00:00.000Z',
    };
    expect(validate(query)).toBe(true);
    // The default lives in the schema; the endpoint's validator (useDefaults)
    // applies it in place, so the validated data carries 1500.
    expect(query.maxPoints).toBe(HISTORY_MAX_POINTS_DEFAULT);
    const withBounds = (maxPoints: number): boolean =>
      validate({
        accountId: 'acc-main',
        metric: 'mcp-monthly',
        from: '2026-10-27T00:00:00.000Z',
        to: '2026-11-03T00:00:00.000Z',
        maxPoints,
      });
    expect(withBounds(HISTORY_MAX_POINTS_MIN)).toBe(true);
    expect(withBounds(HISTORY_MAX_POINTS_MAX)).toBe(true);
  });

  it('rejects missing parameters, out-of-budget maxPoints, and smuggled fields', () => {
    const validate = new Ajv2020({ useDefaults: true }).compile(HistoryQuerySchema);
    const base = { accountId: 'acc-main', metric: 'mcp-monthly', from: 'f', to: 't' };
    const rejected: unknown[] = [
      { accountId: 'acc-main', metric: 'mcp-monthly', from: 'f' },
      { accountId: 'acc-main', metric: 'mcp-monthly', to: 't' },
      { accountId: 'acc-main', from: 'f', to: 't' },
      { metric: 'mcp-monthly', from: 'f', to: 't' },
      { ...base, metric: '' },
      { ...base, accountId: 'not an id!' },
      { ...base, maxPoints: HISTORY_MAX_POINTS_MIN - 1 },
      { ...base, maxPoints: HISTORY_MAX_POINTS_MAX + 1 },
      { ...base, maxPoints: 1500.5 },
      { ...base, maxPoints: '1500' },
      { ...base, timezone: 'UTC' },
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('keeps the events metric filter optional and just as strict when present', () => {
    const validate = new Ajv2020().compile(EventsQuerySchema);
    const base = { accountId: 'acc-main', from: 'f', to: 't' };
    expect(validate(base)).toBe(true);
    expect(validate({ ...base, metric: 'mcp-monthly' })).toBe(true);
    expect(validate({ ...base, metric: '' })).toBe(false);
    expect(validate({ ...base, maxPoints: 100 })).toBe(false);
    expect(validate({ from: 'f', to: 't' })).toBe(false);
  });
});

describe('The item unions (kind-discriminated)', () => {
  it('accepts each history kind and rejects the others', () => {
    const point = new Ajv2020().compile(HistoryPointSchema);
    const bucket = new Ajv2020().compile(HistoryBucketSchema);
    const empty = new Ajv2020().compile(HistoryEmptyPointSchema);
    expect(point(VALID_POINT)).toBe(true);
    expect(point({ ...VALID_POINT, kind: 'bucket' })).toBe(false);
    expect(bucket(VALID_BUCKET)).toBe(true);
    expect(bucket({ ...VALID_BUCKET, count: 0 })).toBe(false);
    expect(empty({ kind: 'empty', collectedAt: 50 })).toBe(true);
    expect(empty({ kind: 'empty', collectedAt: 50, used: null })).toBe(false);
    // An invalid row is a real point with honest nulls, never zero (§8.4).
    expect(
      point({
        ...VALID_POINT,
        used: null,
        remaining: null,
        limit: null,
        percentUsed: null,
        percentRemaining: null,
        resetsAt: null,
        isValid: false,
        invalidReason: 'provider field missing',
      }),
    ).toBe(true);
  });

  it('accepts each events kind and rejects foreign kinds', () => {
    const reset = new Ajv2020().compile(ResetEventItemSchema);
    const gap = new Ajv2020().compile(GapEventItemSchema);
    const error = new Ajv2020().compile(CollectionErrorEventItemSchema);
    const stopped = new Ajv2020().compile(StoppedServiceEventItemSchema);
    expect(
      reset({
        kind: 'reset',
        metricKey: 'mcp-monthly',
        eventAt: 1,
        runId: null,
        details: { reason: 'usage_decreased' },
      }),
    ).toBe(true);
    expect(
      gap({
        kind: 'gap',
        metricKey: 'mcp-monthly',
        fromEpochMs: 1,
        toEpochMs: 2,
        elapsedMs: 1,
        intervalSeconds: 300,
        thresholdMs: 990_000,
      }),
    ).toBe(true);
    expect(
      error({
        kind: 'collection_error',
        outcome: 'rate_limited',
        fromEpochMs: 1,
        toEpochMs: 2,
        durationMs: 1,
        httpStatus: 429,
        message: 'Too Many Requests',
        attempts: 2,
        retryAfterSeconds: 60,
      }),
    ).toBe(true);
    expect(
      stopped({
        kind: 'stopped_service',
        fromEpochMs: 1,
        toEpochMs: 2,
        elapsedMs: 1,
        intervalSeconds: 300,
        thresholdMs: 990_000,
      }),
    ).toBe(true);
    for (const outcome of ACCOUNT_ERROR_OUTCOMES) {
      expect(error({ kind: 'collection_error', outcome })).toBe(false); // incomplete
    }
    expect(
      error({
        kind: 'collection_error',
        outcome: 'success',
        fromEpochMs: 1,
        toEpochMs: 2,
        durationMs: 1,
        httpStatus: null,
        message: '',
        attempts: 1,
        retryAfterSeconds: null,
      }),
    ).toBe(false);
  });
});

describe('The response envelopes (closed contracts)', () => {
  it('accepts the history body and rejects every addition', () => {
    const validate = new Ajv2020().compile(HistoryResponseSchema);
    expect(validate(VALID_HISTORY_BODY)).toBe(true);
    expect(validate({ ...VALID_HISTORY_BODY, unit: null, limitType: null })).toBe(true);
    expect(
      validate({
        ...VALID_HISTORY_BODY,
        downsampled: true,
        resolutionMs: 30_000.5,
        points: [VALID_BUCKET],
      }),
    ).toBe(true);
    expect(validate({ ...VALID_HISTORY_BODY, apiKey: 'sk-marker-secret' })).toBe(false);
    expect(validate({ ...VALID_HISTORY_BODY, points: [{ kind: 'wrong', collectedAt: 1 }] })).toBe(
      false,
    );
    expect(validate({ ...VALID_HISTORY_BODY, sourcePointCount: -1 })).toBe(false);
  });

  it('accepts the events body and rejects every addition', () => {
    const validate = new Ajv2020().compile(EventsResponseSchema);
    const body = {
      accountId: 'acc-main',
      metric: null,
      range: OK_REPORT,
      events: [],
    } as const;
    expect(validate(body)).toBe(true);
    expect(validate({ ...body, events: [{ kind: 'reset' }] })).toBe(false);
    expect(validate({ ...body, metric: 'mcp-monthly' })).toBe(true);
    expect(validate({ ...body, metric: '' })).toBe(false);
    expect(validate({ ...body, apiKey: 'sk-marker-secret' })).toBe(false);
  });

  it('range reports carry exactly the three retention outcomes', () => {
    const validate = new Ajv2020().compile(HistoryRangeReportSchema);
    expect(validate(OK_REPORT)).toBe(true);
    expect(
      validate({
        outcome: 'truncated',
        requestedFrom: 0,
        requestedTo: 100,
        effectiveFrom: 40,
        effectiveTo: 100,
        retentionHorizon: 40,
      }),
    ).toBe(true);
    expect(
      validate({
        outcome: 'rejected',
        requestedFrom: 0,
        requestedTo: 10,
        effectiveFrom: null,
        effectiveTo: null,
        retentionHorizon: 40,
      }),
    ).toBe(true);
    expect(validate({ ...OK_REPORT, outcome: 'clamped' })).toBe(false);
  });
});

describe('No-drift rows (the schema layer cannot import the sources)', () => {
  it('the maxPoints literals equal the downsampler budget constants (§13)', () => {
    expect(HISTORY_MAX_POINTS_DEFAULT).toBe(DEFAULT_MAX_POINTS);
    expect(HISTORY_MAX_POINTS_MIN).toBe(MIN_MAX_POINTS);
    expect(HISTORY_MAX_POINTS_MAX).toBe(MAX_MAX_POINTS);
  });

  it('the range outcomes equal task 123’s RetentionBoundedRange vocabulary', () => {
    const variants = [
      { outcome: 'ok', effectiveFrom: 0, effectiveTo: 1 },
      { outcome: 'truncated', effectiveFrom: 0, effectiveTo: 1, requestedFrom: 0 },
      { outcome: 'rejected', horizon: 0, requestedFrom: 0, requestedTo: 0 },
    ] as const as ReadonlyArray<RetentionBoundedRange>;
    const outcomes = variants.map((range) => range.outcome);
    expect([...RETENTION_RANGE_OUTCOMES].sort()).toEqual([...outcomes].sort());
  });

  it('the kind lists cover the discriminated unions they name', () => {
    expect(HISTORY_POINT_KINDS).toEqual(['point', 'bucket', 'empty']);
    expect(EVENT_ITEM_KINDS).toEqual(['reset', 'gap', 'collection_error', 'stopped_service']);
  });
});
