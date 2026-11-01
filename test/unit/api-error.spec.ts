import { describe, expect, it } from 'vitest';
import {
  ApiError,
  classifyApiError,
  notFoundClassification,
  unmatchedApiClassification,
  type ApiErrorClassification,
} from '../../src/server/api/error';
import { API_ERROR_DEFINITIONS } from '../../src/schemas/api/error';

/**
 * The error-classification machinery (task 148, spec §13; decision D-113):
 * `ApiError` (the throw-side extension point), `classifyApiError` (the pure
 * trust boundary between "anything thrown" and the wire — total over
 * `unknown`, because a route can throw a non-Error and fastify hands it to
 * the handler verbatim), and `notFoundClassification` (the 404 arm). The
 * wire itself — statuses, bytes, headers, logging — is pinned by
 * `test/integration/api-errors.spec.ts` against the real construction.
 */

/** A classification as a comparable plain object. */
function plain(classification: ApiErrorClassification) {
  return { ...classification };
}

/** A synthetic fastify schema-validation error, the shape the runtime emits. */
function fastifyValidationError(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const error = new Error('querystring/n must be number') as Error & Record<string, unknown>;
  error.code = 'FST_ERR_VALIDATION';
  error.statusCode = 400;
  error.validationContext = 'querystring';
  error.validation = [
    {
      instancePath: '/n',
      schemaPath: '#/properties/n/type',
      keyword: 'type',
      params: { type: 'number' },
      message: 'must be number',
    },
  ];
  Object.assign(error, overrides);
  return error;
}

describe('ApiError — the throw-side extension point (D-113)', () => {
  it('defaults message and details from the registry and pins the status', () => {
    const error = new ApiError('UNAUTHENTICATED');
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.statusCode).toBe(API_ERROR_DEFINITIONS.UNAUTHENTICATED.statusCode);
    expect(error.message).toBe(API_ERROR_DEFINITIONS.UNAUTHENTICATED.message);
    expect(error.details).toBeNull();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiError');
  });

  it('accepts a message override and structured details', () => {
    const error = new ApiError('FORBIDDEN', {
      message: 'Remote access requires a password; run quotameter passwd',
      details: { reason: 'proxy-headers-without-password' },
    });
    expect(error.message).toBe('Remote access requires a password; run quotameter passwd');
    expect(error.details).toEqual({ reason: 'proxy-headers-without-password' });
    expect(error.statusCode).toBe(403);
  });

  it('refuses an unknown code at construction — the registry style of D-013', () => {
    expect(() => new ApiError('TEAPOT' as never)).toThrow(TypeError);
    expect(() => new ApiError('TEAPOT' as never)).toThrow(/unknown API error code 'TEAPOT'/);
  });

  it('refuses INTERNAL message/details overrides — the generic-wire rule (§15.4, D-113)', () => {
    // The INTERNAL response is generic by contract; a hand-written message
    // is exactly the leak the strict classifier exists to prevent, so the
    // refusal fires at the throw site (review fix).
    expect(
      () => new ApiError('INTERNAL', { message: 'db at /var/lib/quotameter is corrupt' }),
    ).toThrow(TypeError);
    expect(() => new ApiError('INTERNAL', { details: { path: '/etc/passwd' } })).toThrow(TypeError);
    // The bare form is the sanctioned one: generic message, no details.
    expect(new ApiError('INTERNAL').message).toBe('Internal server error');
    expect(new ApiError('INTERNAL').details).toBeNull();
  });
});

describe('classifyApiError — the trust boundary (§13, §15.4)', () => {
  it('passes an ApiError through untouched, overrides included', () => {
    const thrown = new ApiError('NOT_FOUND', {
      message: 'Account not found',
      details: { accountId: 'zai-main' },
    });
    expect(plain(classifyApiError(thrown))).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Account not found',
      details: { accountId: 'zai-main' },
    });
  });

  it('maps fastify schema-validation errors onto VALIDATION with projected details', () => {
    const classification = classifyApiError(fastifyValidationError());
    expect(plain(classification)).toEqual({
      statusCode: 400,
      code: 'VALIDATION',
      message: 'Request validation failed',
      details: {
        validation: [{ where: 'querystring', path: '/n', message: 'must be number' }],
      },
    });
  });

  it('requires the fastify validation code before projecting — shape alone is not provenance', () => {
    // Review fix: a foreign throwable that merely carries a `validation`
    // property (a dependency's error, a buggy route's object) must not have
    // its strings forwarded to the client.
    const shapeOnly = {
      validationContext: 'body',
      validation: [{ instancePath: '/x', message: 'secret /home/brooks leak' }],
    };
    expect(classifyApiError(shapeOnly).code).toBe('INTERNAL');
    expect(classifyApiError(shapeOnly).message).toBe('Internal server error');
  });

  it('projects every validation item and falls back when fields are malformed', () => {
    // Reachable by construction: the handler receives arbitrary throwables,
    // and a buggy route can throw a validation-coded object with holes.
    const hostile = {
      code: 'FST_ERR_VALIDATION',
      validationContext: 'body',
      validation: [
        { instancePath: '', message: "must have required property 'label'" },
        { instancePath: '/items/0/id' }, // no message
        'not-even-an-object',
      ],
    };
    const classification = classifyApiError(hostile);
    expect(classification.details).toEqual({
      validation: [
        { where: 'body', path: '', message: "must have required property 'label'" },
        { where: 'body', path: '/items/0/id', message: '' },
        { where: 'body', path: '', message: '' },
      ],
    });
    // A missing validationContext surfaces as null, never a guess.
    expect(
      classifyApiError({
        code: 'FST_ERR_VALIDATION',
        validation: [{ instancePath: '/x', message: 'm' }],
      }).details,
    ).toEqual({ validation: [{ where: null, path: '/x', message: 'm' }] });
  });

  it('maps every verified native fastify transport code', () => {
    const cases: ReadonlyArray<readonly [string, string, number, string]> = [
      [
        'FST_ERR_CTP_BODY_TOO_LARGE',
        'PAYLOAD_TOO_LARGE',
        413,
        'Request body exceeds the 64 KiB limit',
      ],
      [
        'FST_ERR_CTP_INVALID_MEDIA_TYPE',
        'UNSUPPORTED_MEDIA_TYPE',
        415,
        'Content-Type is not supported',
      ],
      ['FST_ERR_CTP_INVALID_JSON_BODY', 'VALIDATION', 400, 'Request validation failed'],
      ['FST_ERR_CTP_EMPTY_JSON_BODY', 'VALIDATION', 400, 'Request validation failed'],
      ['FST_ERR_CTP_INVALID_CONTENT_LENGTH', 'VALIDATION', 400, 'Request validation failed'],
      ['FST_ERR_BAD_URL', 'VALIDATION', 400, 'Request validation failed'],
      ['FST_ERR_MAX_PARAM_LENGTH', 'URI_TOO_LONG', 414, 'The request URI is too long'],
    ];
    for (const [nativeCode, expectedCode, expectedStatus, expectedMessage] of cases) {
      const classification = classifyApiError({
        code: nativeCode,
        statusCode: 499,
        message: 'framework words',
      });
      expect(plain(classification), nativeCode).toEqual({
        statusCode: expectedStatus,
        code: expectedCode,
        message: expectedMessage,
        details: null,
      });
    }
  });

  it('resolves unknown errors to the generic INTERNAL — never their own words (§15.4)', () => {
    const secret = new Error('connect ENOENT /home/brooks/.config/quotameter: secret-token');
    expect(plain(classifyApiError(secret))).toEqual({
      statusCode: 500,
      code: 'INTERNAL',
      message: 'Internal server error',
      details: null,
    });
    // A foreign statusCode does not buy trust — 4xx casing included.
    const foreign = new Error('conflict');
    (foreign as Error & { statusCode?: number }).statusCode = 409;
    expect(classifyApiError(foreign).code).toBe('INTERNAL');
    expect(classifyApiError(foreign).statusCode).toBe(500);
    // Unknown fastify codes, non-Error throwables, and holes resolve the same way.
    expect(classifyApiError({ code: 'FST_ERR_SOMETHING_ELSE' }).code).toBe('INTERNAL');
    expect(classifyApiError('a string').code).toBe('INTERNAL');
    expect(classifyApiError(42).code).toBe('INTERNAL');
    expect(classifyApiError(null).code).toBe('INTERNAL');
    expect(classifyApiError(undefined).code).toBe('INTERNAL');
  });

  it('does not treat an empty or missing validation array as a validation error', () => {
    // With or without the code: no items to project means nothing vouched.
    expect(classifyApiError({ code: 'FST_ERR_VALIDATION', validation: [] }).code).toBe('INTERNAL');
    expect(classifyApiError({ validation: [] }).code).toBe('INTERNAL');
    expect(classifyApiError({ validation: null }).code).toBe('INTERNAL');
  });

  it('keeps the INTERNAL wire shape generic even for a mutated instance', () => {
    // Error.message is writable after construction; the classifier is the
    // second layer of the generic-wire rule (review fix).
    const mutated = new ApiError('INTERNAL');
    mutated.message = 'secret /home/brooks/.config path';
    expect(plain(classifyApiError(mutated))).toEqual({
      statusCode: 500,
      code: 'INTERNAL',
      message: 'Internal server error',
      details: null,
    });
  });
});

describe('notFoundClassification — the 404 arm (§13)', () => {
  it('carries the client method and path as details with the fixed message', () => {
    expect(plain(notFoundClassification('GET', '/api/accounts'))).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Not found',
      details: { method: 'GET', path: '/api/accounts' },
    });
  });
});

describe('unmatchedApiClassification — the /api catch-all arm (§13, D-113)', () => {
  it('classifies an ordinary unmatched path as NOT_FOUND with routing details', () => {
    expect(plain(unmatchedApiClassification('GET', '/api/unknown'))).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Not found',
      details: { method: 'GET', path: '/api/unknown' },
    });
  });

  it('classifies a segment past the router bound as URI_TOO_LONG', () => {
    expect(plain(unmatchedApiClassification('GET', `/api/test/p/${'x'.repeat(101)}`))).toEqual({
      statusCode: 414,
      code: 'URI_TOO_LONG',
      message: 'The request URI is too long',
      details: null,
    });
    // Any segment, not only the last.
    expect(unmatchedApiClassification('GET', `/api/${'x'.repeat(101)}/tail`).code).toBe(
      'URI_TOO_LONG',
    );
    // Exactly at the bound is routable — the check is strictly greater,
    // find-my-way's own comparison.
    expect(unmatchedApiClassification('GET', `/api/test/p/${'x'.repeat(100)}`).code).toBe(
      'NOT_FOUND',
    );
  });

  it('measures the decoded segment — the router yardstick', () => {
    // Raw 180 characters decoding to 60 ('A' * 60): inside the bound, the
    // same verdict find-my-way gives the param itself.
    expect(unmatchedApiClassification('GET', `/api/unknown/${'%41'.repeat(60)}`).code).toBe(
      'NOT_FOUND',
    );
    // Raw 360 decoding to 120: over the bound.
    expect(unmatchedApiClassification('GET', `/api/unknown/${'%41'.repeat(120)}`).code).toBe(
      'URI_TOO_LONG',
    );
  });

  it('falls back to the raw length for an undecodable segment (defensive)', () => {
    // Malformed escapes never reach the catch-all (FST_ERR_BAD_URL fires
    // before routing); if one ever did, its raw length decides.
    expect(unmatchedApiClassification('GET', `/api/${'%zz'.repeat(50)}`).code).toBe('URI_TOO_LONG');
  });
});
