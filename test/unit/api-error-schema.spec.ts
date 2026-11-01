import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { API_ERROR_DEFINITIONS, ApiErrorBodySchema } from '../../src/schemas/api/error';

/**
 * The error-envelope contract (task 148, spec §13; decision D-113): the
 * schema accepts exactly the closed `error` object — a registry code, a
 * string message, any JSON `details` — and rejects every other shape, so
 * task 163's OpenAPI generation inherits a contract that cannot describe a
 * stray field. The literal-union drift guard pins the schema's codes against
 * the registry keys: the two tables cannot silently diverge.
 */

/** The schema's accepted codes, read from the compiled JSON Schema itself. */
function schemaCodes(): string[] {
  const union = ApiErrorBodySchema.properties.error.properties.code.anyOf as Array<{
    const: string;
  }>;
  return union.map((literal) => literal.const);
}

describe('ApiErrorBodySchema (task 148, §13)', () => {
  it('accepts a well-formed envelope for every registry code', () => {
    const validate = new Ajv2020().compile(ApiErrorBodySchema);
    for (const code of Object.keys(API_ERROR_DEFINITIONS)) {
      expect(validate({ error: { code, message: 'anything', details: null } }), code).toBe(true);
    }
  });

  it('accepts any JSON value as details — the class decides what to carry', () => {
    const validate = new Ajv2020().compile(ApiErrorBodySchema);
    for (const details of [
      null,
      { validation: [{ where: 'body', path: '/id', message: 'must be string' }] },
      ['one', 'two'],
      'text',
      42,
      true,
    ]) {
      expect(
        validate({ error: { code: 'VALIDATION', message: 'm', details } }),
        JSON.stringify(details),
      ).toBe(true);
    }
  });

  it('rejects unknown codes, non-string messages, and malformed shapes', () => {
    const validate = new Ajv2020().compile(ApiErrorBodySchema);
    const rejected: unknown[] = [
      { error: { code: 'TEAPOT', message: 'm', details: null } },
      { error: { code: null, message: 'm', details: null } },
      { error: { code: 'VALIDATION', message: 42, details: null } },
      { error: { code: 'VALIDATION' } },
      { error: { code: 'VALIDATION', message: 'm', details: null, extra: 1 } },
      { error: { code: 'VALIDATION', message: 'm', details: null }, statusCode: 400 },
      { code: 'VALIDATION', message: 'm', details: null },
      'error',
      null,
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('pins the schema codes to the registry keys — the drift guard (D-113)', () => {
    // Sorted compares: both sides are plain string arrays, and order is not
    // part of the contract — membership is.
    expect([...schemaCodes()].sort()).toEqual([...Object.keys(API_ERROR_DEFINITIONS)].sort());
    // A registry addition without its schema literal must fail this equality.
    expect(schemaCodes()).toHaveLength(Object.keys(API_ERROR_DEFINITIONS).length);
  });

  it('pins the registry table itself — stable codes and statuses (§13)', () => {
    expect(API_ERROR_DEFINITIONS).toEqual({
      VALIDATION: { statusCode: 400, message: 'Request validation failed' },
      UNAUTHENTICATED: { statusCode: 401, message: 'Authentication required' },
      FORBIDDEN: { statusCode: 403, message: 'Forbidden' },
      NOT_FOUND: { statusCode: 404, message: 'Not found' },
      PAYLOAD_TOO_LARGE: { statusCode: 413, message: 'Request body exceeds the 64 KiB limit' },
      URI_TOO_LONG: { statusCode: 414, message: 'The request URI is too long' },
      UNSUPPORTED_MEDIA_TYPE: { statusCode: 415, message: 'Content-Type is not supported' },
      INTERNAL: { statusCode: 500, message: 'Internal server error' },
    });
  });
});
