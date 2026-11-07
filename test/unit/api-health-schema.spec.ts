import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { HealthPollingDiagnosticsSchema, HealthResponseSchema } from '../../src/schemas/api/health';

/**
 * The health response contract (task 147, spec §13; decisions D-111 and
 * D-192): the schema accepts exactly the literal `{"status":"ok"}` and its
 * authenticated extension `{"status":"ok","polling":{"running":…}}`, and
 * rejects every other diagnostic-carrying shape — the leak-guard property
 * (`additionalProperties: false`) the route's compiled serializer enforces,
 * pinned at the schema layer so task 163's OpenAPI generation inherits a
 * contract that cannot describe an undeclared field. The `polling` block
 * itself is closed the same way: one boolean, nothing else.
 */

describe('HealthResponseSchema (task 147 §13; FSM-4 D-192)', () => {
  it('accepts exactly the literal health payload', () => {
    const validate = new Ajv2020().compile(HealthResponseSchema);
    expect(validate({ status: 'ok' })).toBe(true);
  });

  it('accepts the authenticated diagnostics extension — both running values', () => {
    const validate = new Ajv2020().compile(HealthResponseSchema);
    expect(validate({ status: 'ok', polling: { running: true } })).toBe(true);
    expect(validate({ status: 'ok', polling: { running: false } })).toBe(true);
  });

  it('rejects every other diagnostic-carrying shape — the closed object', () => {
    const validate = new Ajv2020().compile(HealthResponseSchema);
    // Any extra key is invalid: no versions, uptime, memory, storage
    // state, account data, errors, or timestamps can pass this schema.
    const rejected: unknown[] = [
      { status: 'ok', uptime: 123 },
      { status: 'ok', version: '1.0.0' },
      { status: 'ok', diagnostics: { memory: 1, database: 'ok' } },
      { status: 'ok', timestamp: '2026-11-01T00:00:00Z' },
      { status: 'ok', accounts: [] },
      // The declared diagnostics block is closed and typed: wrong-shaped
      // or extra-carrying `polling` values are equally invalid.
      { status: 'ok', polling: {} },
      { status: 'ok', polling: { running: 'yes' } },
      { status: 'ok', polling: { running: 1 } },
      { status: 'ok', polling: { running: true, engine: 'dead' } },
      { status: 'ok', polling: null },
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

describe('HealthPollingDiagnosticsSchema (FSM-4 D-192)', () => {
  it('accepts exactly the two boolean payloads — closed like its parent', () => {
    const validate = new Ajv2020().compile(HealthPollingDiagnosticsSchema);
    expect(validate({ running: true })).toBe(true);
    expect(validate({ running: false })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ running: true, extra: 1 })).toBe(false);
    expect(validate({ running: 'true' })).toBe(false);
  });
});
