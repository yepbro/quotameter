import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from '../../src/schemas/api/health';

/**
 * The health response contract (task 147, spec §13; decision D-111): the
 * schema accepts exactly the literal `{"status":"ok"}` and rejects every
 * diagnostic-carrying shape — the leak-guard property (`additionalProperties:
 * false`) the route's compiled serializer enforces, pinned at the schema
 * layer so task 163's OpenAPI generation inherits a contract that cannot
 * describe a second field.
 */

describe('HealthResponseSchema (task 147, §13)', () => {
  it('accepts exactly the literal health payload', () => {
    const validate = new Ajv2020().compile(HealthResponseSchema);
    expect(validate({ status: 'ok' })).toBe(true);
  });

  it('rejects every diagnostic-carrying shape — the closed object', () => {
    const validate = new Ajv2020().compile(HealthResponseSchema);
    // Any extra key is invalid: no versions, uptime, memory, storage
    // state, account data, errors, or timestamps can pass this schema.
    const rejected: unknown[] = [
      { status: 'ok', uptime: 123 },
      { status: 'ok', version: '1.0.0' },
      { status: 'ok', diagnostics: { memory: 1, database: 'ok' } },
      { status: 'ok', timestamp: '2026-11-01T00:00:00Z' },
      { status: 'ok', accounts: [] },
      // Wrong or missing declared values are equally invalid.
      { status: 'degraded' },
      { status: 'OK' },
      {},
      'ok',
      null,
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });
});
