import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import type { RunOutcome } from '../../src/storage/repository';
import { ACCOUNT_STATUSES } from '../../src/services/polling-status';
import {
  ACCOUNT_ERROR_OUTCOMES,
  ACCOUNT_STATUS_TOKENS,
  AccountErrorViewSchema,
  MetricViewSchema,
  QuotaQuerySchema,
  QuotaResponseSchema,
  StatusAccountViewSchema,
  StatusResponseSchema,
} from '../../src/schemas/api/status';
import { ID_PATTERN } from '../../src/schemas/config';

/**
 * The §13 status/quota contract tables (task 160, decision D-130): every
 * response object is closed (`additionalProperties: false`) — the
 * structural no-secret guard, pinned at the schema layer the way the
 * D-111/D-128 suites pin theirs — the request grammar (the required,
 * charset-validated `accountId`) holds exactly, and the wire vocabularies
 * cannot drift from their owning modules: the status tokens from the §7.3
 * derivation's own list, the error outcomes from the storage outcome union.
 */

/** Deterministic §11.1 epoch-millisecond timestamps. */
const T0 = 1_761_000_000_000;

describe('the wire vocabularies cannot drift from their owners', () => {
  it('ACCOUNT_STATUS_TOKENS is exactly the §7.3 derivation list', () => {
    expect([...ACCOUNT_STATUS_TOKENS]).toEqual([...ACCOUNT_STATUSES]);
  });

  it('ACCOUNT_ERROR_OUTCOMES is exactly the non-success storage outcomes', () => {
    // Compile-time exhaustiveness (review round P2): if `RunOutcome` grows
    // a member beyond 'success' and the wire list, the `Record` below
    // demands a key for it and stops compiling — the old Exclude-only form
    // stayed green under exactly that growth.
    const exhaustive: Record<
      Exclude<RunOutcome, 'success' | (typeof ACCOUNT_ERROR_OUTCOMES)[number]>,
      never
    > = {};
    expect(Object.keys(exhaustive)).toHaveLength(0);
    // Runtime: the wire list holds the six failure classes, never success.
    const wireOutcomes: readonly RunOutcome[] = ACCOUNT_ERROR_OUTCOMES;
    expect(wireOutcomes).toHaveLength(6);
    expect(wireOutcomes).not.toContain('success');
  });
});

describe('AccountErrorViewSchema (§7.2 last error)', () => {
  it('accepts every failure outcome class', () => {
    const validate = new Ajv2020().compile(AccountErrorViewSchema);
    for (const outcome of ACCOUNT_ERROR_OUTCOMES) {
      expect(validate({ outcome, message: 'connection refused', at: T0 }), outcome).toBe(true);
    }
  });

  it('rejects the success outcome and malformed shapes', () => {
    const validate = new Ajv2020().compile(AccountErrorViewSchema);
    const rejected: unknown[] = [
      { outcome: 'success', message: '', at: T0 },
      { outcome: 'network_error', at: T0 },
      { outcome: 'network_error', message: 'x', at: '2026-11-01T00:00:00Z' },
      { outcome: 'network_error', message: 'x', at: T0, apiKey: 'sk-marker-secret' },
      ['network_error', 'x', T0],
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('StatusAccountViewSchema (§13 status row)', () => {
  const VALID_ROW = {
    id: 'work',
    status: 'fresh',
    lastSuccessAt: T0,
    lastError: { outcome: 'timeout', message: 'request timed out', at: T0 - 60_000 },
  } as const;

  it('accepts the complete row and both honest nulls', () => {
    const validate = new Ajv2020().compile(StatusAccountViewSchema);
    expect(validate(VALID_ROW)).toBe(true);
    expect(validate({ ...VALID_ROW, lastSuccessAt: null, lastError: null })).toBe(true);
  });

  it('rejects unknown tokens, secret-bearing shapes, and string timestamps', () => {
    const validate = new Ajv2020().compile(StatusAccountViewSchema);
    const rejected: unknown[] = [
      { ...VALID_ROW, status: 'Healthy' },
      { ...VALID_ROW, status: 'ok' },
      { ...VALID_ROW, apiKey: 'sk-marker-secret' },
      { ...VALID_ROW, secret: 'sk-marker-secret' },
      { ...VALID_ROW, lastSuccessAt: '2026-11-01T00:00:00Z' },
      { ...VALID_ROW, label: 'Work plan' },
      { id: 'work', status: 'fresh' },
      { ...VALID_ROW, id: 'has space' },
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('StatusResponseSchema (§13 service state)', () => {
  it('accepts the answering-service shape and rejects additions', () => {
    const validate = new Ajv2020().compile(StatusResponseSchema);
    expect(validate({ status: 'ok', pollingIntervalSeconds: 300, accounts: [] })).toBe(true);
    const rejected: unknown[] = [
      { status: 'degraded', pollingIntervalSeconds: 300, accounts: [] },
      { status: 'ok', pollingIntervalSeconds: 30, accounts: [] },
      { status: 'ok', pollingIntervalSeconds: 300, accounts: [], apiKey: 'sk-marker-secret' },
      { status: 'ok', pollingIntervalSeconds: 300 },
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('QuotaQuerySchema (the required accountId)', () => {
  it('accepts a charset-valid id and rejects everything else', () => {
    const validate = new Ajv2020().compile(QuotaQuerySchema);
    expect(validate({ accountId: 'work' })).toBe(true);
    expect(validate({ accountId: 'acc-123_45' })).toBe(true);
    const rejected: unknown[] = [
      {},
      { accountId: '' },
      { accountId: 'has space' },
      { accountId: 'work', metric: 'monthly-credits' },
      null,
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
    // The charset is the configuration contract's own (the no-drift rule).
    expect(new RegExp(ID_PATTERN).test('work')).toBe(true);
  });
});

describe('MetricViewSchema (the §8.4 row on the wire)', () => {
  const VALID_METRIC = {
    metricKey: 'mcp-monthly',
    limitType: 'MONTHLY',
    unit: 'CREDITS',
    windowSeconds: null,
    used: 80,
    remaining: 20,
    limit: 100,
    percentUsed: 80,
    percentRemaining: 20,
    resetsAt: T0 + 86_400_000,
    isValid: true,
    invalidReason: null,
    derivedFields: ['remaining'],
    collectedAt: T0,
  } as const;

  it('accepts the complete row and nullable numeric gaps', () => {
    const validate = new Ajv2020().compile(MetricViewSchema);
    expect(validate(VALID_METRIC)).toBe(true);
    expect(
      validate({
        ...VALID_METRIC,
        used: null,
        remaining: null,
        limit: null,
        percentUsed: 80,
        unit: 'PERCENT',
        derivedFields: null,
      }),
    ).toBe(true);
  });

  it('rejects closed-enum violations and non-contract fields', () => {
    const validate = new Ajv2020().compile(MetricViewSchema);
    const rejected: unknown[] = [
      { ...VALID_METRIC, limitType: 'YEARLY' },
      { ...VALID_METRIC, unit: 'EURO' },
      { ...VALID_METRIC, derivedFields: ['total'] },
      // `label` is adapter parse-time data the storage row never carries
      // (D-039); the closed contract keeps the gap visible instead of
      // half-serving it.
      { ...VALID_METRIC, label: 'Monthly MCP tool quota' },
      { ...VALID_METRIC, accountId: 'work' },
      { ...VALID_METRIC, runId: 7 },
      { ...VALID_METRIC, collectedAt: '2026-11-01T00:00:00Z' },
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('QuotaResponseSchema (§13 latest values)', () => {
  it('accepts the empty state — absence, never zero (§7.2)', () => {
    const validate = new Ajv2020().compile(QuotaResponseSchema);
    expect(
      validate({
        accountId: 'work',
        status: 'collecting',
        collectedAt: null,
        planName: null,
        metrics: [],
      }),
    ).toBe(true);
  });

  it('rejects additions and charset violations', () => {
    const validate = new Ajv2020().compile(QuotaResponseSchema);
    const base = {
      accountId: 'work',
      status: 'fresh',
      collectedAt: T0,
      planName: 'Pro',
      metrics: [],
    } as const;
    const rejected: unknown[] = [
      { ...base, apiKey: 'sk-marker-secret' },
      { ...base, secretOf: 'sk-marker-secret' },
      { ...base, accountId: 'has space' },
      { accountId: 'work', status: 'fresh', collectedAt: T0, planName: null },
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });
});
