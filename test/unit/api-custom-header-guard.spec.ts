import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../../src/server/api/error';
import {
  API_MUTATION_HEADER_NAME,
  classifyCustomHeaderRequest,
  customHeaderGuard,
  STATE_CHANGING_METHODS,
  type HeaderDecision,
  type HeaderGuardReason,
} from '../../src/server/api/security';

/**
 * The §15.3 custom-header/JSON-content-type decision machinery (task 150,
 * decision D-117): `classifyCustomHeaderRequest` — the pure, fail-closed
 * verdict over `{method, customHeader, contentType, contentLength,
 * transferEncoding}` (the content-type leg binds requests that carry a
 * body; the header leg binds every mutation) — and the
 * `customHeaderGuard` hook (its wiring, statuses, bytes, and logging are
 * pinned by `test/integration/api-custom-header.spec.ts` against the real
 * construction).
 */

/** The denial verdict for a reason, as a comparable plain object. */
function denied(reason: HeaderGuardReason): HeaderDecision {
  return { allowed: false, reason };
}

/** The allowance verdict. */
const allowed: HeaderDecision = { allowed: true };

/**
 * One bodied mutation with optional header values — the shape the
 * content-type leg decides over (a body is claimed through
 * `content-length`, exactly as the wire delivers it).
 */
function bodiedMutation(headers: { customHeader?: string; contentType?: string }): HeaderDecision {
  return classifyCustomHeaderRequest({ method: 'POST', contentLength: '10', ...headers });
}

describe("classifyCustomHeaderRequest — safe methods are never the guard's business (§13)", () => {
  it('allows every non-state-changing method even with fully hostile header values', () => {
    const hostile = { customHeader: '', contentType: 'application/x-www-form-urlencoded' };
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'TRACE']) {
      expect(classifyCustomHeaderRequest({ method, ...hostile }), method).toEqual(allowed);
    }
    // Neither header at all: a safe request carries no mutation to forge.
    expect(classifyCustomHeaderRequest({ method: 'GET' })).toEqual(allowed);
  });

  it('normalizes method case before the §13 set lookup', () => {
    // The parser delivers uppercased methods; the normalization keeps the
    // pure function total over arbitrary input (branchless, pinned).
    expect(classifyCustomHeaderRequest({ method: 'delete', customHeader: '' })).toEqual(
      denied('missing-custom-header'),
    );
    expect(classifyCustomHeaderRequest({ method: 'patch' })).toEqual(
      denied('missing-custom-header'),
    );
  });

  it("decides over exactly §13's four state-changing methods", () => {
    // The shared seam: both §15.3 guards consult the one set, so the
    // header guard cannot drift from the Origin guard's method scope.
    expect([...STATE_CHANGING_METHODS].sort()).toEqual(['DELETE', 'PATCH', 'POST', 'PUT']);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect(
        classifyCustomHeaderRequest({
          method,
          customHeader: 'quotameter-ui',
          contentType: 'application/json',
          contentLength: '10',
        }),
        method,
      ).toEqual(allowed);
      expect(classifyCustomHeaderRequest({ method }), method).toEqual(
        denied('missing-custom-header'),
      );
    }
  });
});

describe('classifyCustomHeaderRequest — the dedicated header (§15.3, D-117)', () => {
  it('rejects an absent, empty, or whitespace-only header, bodied or not', () => {
    expect(bodiedMutation({ contentType: 'application/json' })).toEqual(
      denied('missing-custom-header'),
    );
    // The bodiless mutation (no body signals at all) still carries the
    // header leg — it is the unforgeable one.
    expect(classifyCustomHeaderRequest({ method: 'DELETE' })).toEqual(
      denied('missing-custom-header'),
    );
    for (const customHeader of ['', ' ', '\t', '  \n '] as const) {
      expect(
        bodiedMutation({ customHeader, contentType: 'application/json' }),
        JSON.stringify(customHeader),
      ).toEqual(denied('missing-custom-header'));
    }
  });

  it('requires presence only — the value is deliberately uninterpreted', () => {
    // Presence of a non-safelisted header is the whole CSRF property (a
    // cross-origin browser cannot set one without a CORS preflight, and
    // CORS stays disabled); no fixed literal would add security. Any
    // non-empty value passes, on every mutation method — including the
    // delimiter-only `', '`, Node's join of two empty duplicate headers
    // (a shape a form cannot produce either; the security property is
    // unaffected by which non-empty value arrives).
    for (const customHeader of ['1', 'quotameter-ui', 'any opaque value', 'x'.repeat(500), ', ']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        expect(
          classifyCustomHeaderRequest({
            method,
            customHeader,
            contentType: 'application/json',
            contentLength: '10',
          }),
          `${method} ${customHeader.length}`,
        ).toEqual(allowed);
      }
    }
  });
});

describe('classifyCustomHeaderRequest — the body-carrying question (D-117)', () => {
  it('derives "carries a body" from the wire signals', () => {
    const header = { customHeader: '1' };
    // A body: any non-zero length, any transfer-encoding, and any
    // non-canonical zero — `00` included, verified live: fastify treats
    // it as a body present and demands a content type, so the guard
    // reads it the same way (fail closed, transport-aligned).
    for (const signal of [
      { contentLength: '1' },
      { contentLength: ' 42 ' },
      { contentLength: '00' },
      { transferEncoding: 'chunked' },
      { contentLength: '0', transferEncoding: 'chunked' }, // chunked wins: there is a body
    ] as const) {
      expect(
        classifyCustomHeaderRequest({ method: 'POST', ...header, ...signal }),
        JSON.stringify(signal),
      ).toEqual(denied('non-json-content-type'));
    }
    // Bodiless: absent signals, or the exact canonical zero.
    for (const signal of [
      {},
      { contentLength: '0' },
      { contentLength: ' 0 ' },
      { contentType: 'text/plain' }, // no body signals: the type describes a body that is not there
    ] as const) {
      expect(
        classifyCustomHeaderRequest({ method: 'DELETE', ...header, ...signal }),
        JSON.stringify(signal),
      ).toEqual(allowed);
    }
  });

  it('treats unparsable content-lengths as carrying a body — fail closed', () => {
    // Duplicated-joined or malformed lengths cannot prove the request
    // bodiless, so the content-type leg applies (the transport's own
    // content-length class answers the genuinely malformed values later).
    for (const contentLength of ['', 'abc', '-1', '5, 6', '0x10'] as const) {
      expect(
        classifyCustomHeaderRequest({
          method: 'POST',
          customHeader: '1',
          contentLength,
          contentType: 'text/plain',
        }),
        JSON.stringify(contentLength),
      ).toEqual(denied('non-json-content-type'));
    }
  });
});

describe('classifyCustomHeaderRequest — the JSON content type (§15.3, D-117)', () => {
  it('accepts application/json with any parameters, case, or padding', () => {
    for (const contentType of [
      'application/json',
      'application/json; charset=utf-8',
      'application/json;charset=UTF-8',
      'APPLICATION/JSON',
      '  application/json  ',
      'application/json;',
      'application/json; charset=utf-16', // parameters are the parser's business
    ] as const) {
      expect(bodiedMutation({ customHeader: '1', contentType }), contentType).toEqual(allowed);
    }
  });

  it('rejects a missing, empty, or non-JSON content type on a body — the form-built shapes', () => {
    // The three HTML form enctype values are the CSRF shapes this leg exists
    // for; the suffix and lookalike types fail the exact-base-type
    // comparison (§15.3's "Accept only `application/json`").
    for (const contentType of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=----formdata',
      'text/json',
      'application/jsonp',
      'application/merge-patch+json',
      'application/vnd.api+json',
      'application/json, application/json', // Node's duplicate-header join
      'text/plain; charset=utf-8',
      'application/json text/plain',
      '',
    ] as const) {
      expect(bodiedMutation({ customHeader: '1', contentType }), contentType).toEqual(
        denied('non-json-content-type'),
      );
    }
    // Absent entirely on a body.
    expect(bodiedMutation({ customHeader: '1' })).toEqual(denied('non-json-content-type'));
  });

  it('checks the header before the content type — a fixed order', () => {
    // Both requirements failing answers the header reason, so the
    // rejection class is deterministic (mirrors the origin guard's fixed
    // Origin-then-Sec-Fetch order).
    expect(bodiedMutation({})).toEqual(denied('missing-custom-header'));
    expect(bodiedMutation({ contentType: 'text/plain' })).toEqual(denied('missing-custom-header'));
  });
});

describe("customHeaderGuard — the hook (D-113's throw-side pattern)", () => {
  /** A minimal request double — the hook reads method and four headers, nothing else. */
  function request(headers: Record<string, unknown>, method = 'POST'): FastifyRequest {
    return { method, headers } as unknown as FastifyRequest;
  }

  it('rejects with the FORBIDDEN ApiError naming the required header', async () => {
    let error: unknown;
    try {
      await customHeaderGuard(request({ 'content-type': 'application/json' }));
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('FORBIDDEN');
    expect(apiError.statusCode).toBe(403);
    expect(apiError.message).toBe(`The ${API_MUTATION_HEADER_NAME} header is required`);
    expect(apiError.message).toBe('The X-Quotameter-Request header is required');
    expect(apiError.details).toEqual({ reason: 'missing-custom-header' });
  });

  it('rejects a non-JSON content type on a body with the registry-default 415 ApiError', async () => {
    let error: unknown;
    try {
      await customHeaderGuard(
        request({
          [API_MUTATION_HEADER_NAME.toLowerCase()]: '1',
          'content-type': 'text/plain',
          'content-length': '3',
        }),
      );
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    // The registry's default shape — byte-identical to fastify's native
    // media-type rejection, so the 415 class has one wire body.
    expect(apiError.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(apiError.statusCode).toBe(415);
    expect(apiError.message).toBe('Content-Type is not supported');
    expect(apiError.details).toBeNull();
  });

  it('resolves without throwing for allowed requests and for safe methods', async () => {
    // A bodied mutation with both requirements satisfied…
    await expect(
      customHeaderGuard(
        request({
          'x-quotameter-request': 'quotameter-ui',
          'content-type': 'application/json',
          'content-length': '2',
        }),
      ),
    ).resolves.toBeUndefined();
    // …a bodiless mutation with the header alone (no payload to type)…
    await expect(
      customHeaderGuard(request({ 'x-quotameter-request': '1', 'content-length': '0' })),
    ).resolves.toBeUndefined();
    await expect(
      customHeaderGuard(request({ 'x-quotameter-request': '1' })),
    ).resolves.toBeUndefined();
    // …and a safe method with nothing at all.
    await expect(customHeaderGuard(request({}, 'GET'))).resolves.toBeUndefined();
  });

  it("joins split header values into the wire's duplicate-join shape", async () => {
    // Node joins duplicate headers (`a, b`); the joined custom header
    // stays a non-empty value (presence semantics — a form cannot send
    // two of them either), while a joined content type never equals the
    // single base media type and fails closed.
    await expect(
      customHeaderGuard(
        request({
          'x-quotameter-request': ['one', 'two'],
          'content-type': ['application/json', 'application/json'],
          'content-length': '2',
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    // All-empty duplicates join to a delimiter-only value — non-empty by
    // the letter of the presence check (the value is uninterpreted, and
    // the split-array shape itself never occurs on a real wire: Node
    // joins duplicates before the headers object exists), so the verdict
    // comes from the bodied content-type leg instead. A single empty
    // value stays the missing-header verdict (pinned above).
    await expect(
      customHeaderGuard(request({ 'x-quotameter-request': ['', ''], 'content-length': '1' })),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  });
});
