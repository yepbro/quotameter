import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../../src/server/api/error';
import {
  classifyOriginRequest,
  normalizeAuthority,
  originGuard,
  STATE_CHANGING_METHODS,
  type OriginDecision,
  type OriginGuardReason,
} from '../../src/server/api/security';

/**
 * The §15.3 Origin/Fetch-Metadata decision machinery (task 149, decision
 * D-115): `classifyOriginRequest` — the pure, fail-closed verdict over
 * `{method, origin, secFetchSite, authority}` — plus `normalizeAuthority`
 * (the comparison yardstick task 151 reuses) and `originGuard` (the hook
 * — its wiring, statuses, bytes, headers, and logging are pinned by
 * `test/integration/api-origin.spec.ts` against the real construction).
 */

/** The denial verdict for a reason, as a comparable plain object. */
function denied(reason: OriginGuardReason): OriginDecision {
  return { allowed: false, reason };
}

/** The allowance verdict. */
const allowed: OriginDecision = { allowed: true };

/** One mutation with optional headers over a fixed loopback authority. */
function mutation(headers: {
  origin?: string;
  secFetchSite?: string;
  authority?: string;
}): OriginDecision {
  return classifyOriginRequest({ method: 'POST', ...headers });
}

describe("classifyOriginRequest — safe methods are never the guard's business (§13)", () => {
  it('allows every non-state-changing method even with fully hostile headers', () => {
    const hostile = { origin: 'https://evil.example', secFetchSite: 'cross-site' };
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'TRACE']) {
      expect(
        classifyOriginRequest({ method, ...hostile, authority: '127.0.0.1:8787' }),
        method,
      ).toEqual(allowed);
    }
  });

  it('normalizes method case before the §13 set lookup', () => {
    // The HTTP parser delivers uppercased methods; the normalization keeps
    // the pure function total over arbitrary input (branchless, pinned).
    expect(classifyOriginRequest({ method: 'post', origin: 'https://evil.example' })).toEqual(
      denied('origin-mismatch'),
    );
    expect(classifyOriginRequest({ method: 'get', origin: 'https://evil.example' })).toEqual(
      allowed,
    );
  });

  it("holds exactly §13's four state-changing methods", () => {
    expect([...STATE_CHANGING_METHODS].sort()).toEqual(['DELETE', 'PATCH', 'POST', 'PUT']);
  });
});

describe('classifyOriginRequest — Sec-Fetch-Site (§15.3, D-115)', () => {
  it('decides every token × all four mutation methods — the full D-115 matrix', () => {
    // `same-site` is rejected alongside `cross-site`: same-site ≠
    // same-origin (a sibling subdomain or another port on the same host
    // is still a cross-origin mutation — the done-condition's wording).
    // Malformed tokens fail closed; only the browser-asserted
    // `same-origin` and the user-initiated `none` pass, on every method.
    const verdicts: ReadonlyArray<readonly [string, OriginDecision]> = [
      ['same-origin', allowed],
      ['none', allowed],
      ['cross-site', denied('cross-site-fetch')],
      ['same-site', denied('cross-site-fetch')],
      ['Same-Origin', allowed],
      ['  same-origin  ', allowed],
      ['', denied('cross-site-fetch')],
      ['   ', denied('cross-site-fetch')],
      ['bogus', denied('cross-site-fetch')],
      ['same origin', denied('cross-site-fetch')],
      ['cross_site', denied('cross-site-fetch')],
    ];
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      for (const [secFetchSite, expected] of verdicts) {
        expect(
          classifyOriginRequest({ method, secFetchSite, authority: '127.0.0.1:8787' }),
          `${method} "${secFetchSite}"`,
        ).toEqual(expected);
      }
    }
  });
});

describe('classifyOriginRequest — Origin (§15.3, D-115)', () => {
  it("allows a present Origin carrying the request's own authority", () => {
    for (const [origin, authority] of [
      ['http://127.0.0.1:8787', '127.0.0.1:8787'],
      ['https://quotameter.example', 'quotameter.example'],
      ['http://[::1]:8787', '[::1]:8787'],
      ['http://localhost:3000', 'LOCALHOST:3000'],
      ['https://user@quotameter.example', 'quotameter.example'],
    ] as const) {
      expect(mutation({ origin, authority }), `${origin} vs ${authority}`).toEqual(allowed);
    }
  });

  it("treats an explicit default port as the same authority — the origin scheme's only", () => {
    // Browsers never serialize default ports in Origin; hosts and proxies
    // sometimes write them. `new URL` drops them on the Origin side,
    // `normalizeAuthority` on the authority side — but only the origin
    // scheme's own default (the P2-2 review fix: the opposite scheme's
    // default is a non-default port and stays identity).
    expect(mutation({ origin: 'http://localhost', authority: 'localhost:80' })).toEqual(allowed);
    expect(mutation({ origin: 'http://a.example:80', authority: 'a.example' })).toEqual(allowed);
    expect(mutation({ origin: 'https://a.example', authority: 'a.example:443' })).toEqual(allowed);
    // A non-default port is identity: another port on the same host is a
    // different origin.
    expect(mutation({ origin: 'http://localhost:3000', authority: 'localhost:8080' })).toEqual(
      denied('origin-mismatch'),
    );
    expect(mutation({ origin: 'https://a.example:8443', authority: 'a.example' })).toEqual(
      denied('origin-mismatch'),
    );
    // Opposite-scheme default ports must not collapse onto each other:
    // 443 is a non-default port for http, 80 for https.
    expect(mutation({ origin: 'http://a.example:443', authority: 'a.example:80' })).toEqual(
      denied('origin-mismatch'),
    );
    expect(mutation({ origin: 'https://a.example:80', authority: 'a.example' })).toEqual(
      denied('origin-mismatch'),
    );
  });

  it('rejects a different authority', () => {
    expect(mutation({ origin: 'https://evil.example', authority: '127.0.0.1:8787' })).toEqual(
      denied('origin-mismatch'),
    );
    // A subtle port mismatch, not a different hostname, is still cross-origin.
    expect(mutation({ origin: 'http://127.0.0.1:8788', authority: '127.0.0.1:8787' })).toEqual(
      denied('origin-mismatch'),
    );
    // The Origin's scheme is deliberately not compared (D-115: behind a
    // TLS-terminating proxy the internal hop is plain HTTP) — pinned so
    // the omission stays a decision, not an accident.
    expect(mutation({ origin: 'https://127.0.0.1:8787', authority: '127.0.0.1:8787' })).toEqual(
      allowed,
    );
  });

  it('rejects an Origin it cannot compare — fail closed', () => {
    // No Host authority to establish sameness against.
    expect(mutation({ origin: 'http://127.0.0.1:8787' })).toEqual(denied('origin-mismatch'));
    expect(mutation({ origin: 'http://127.0.0.1:8787', authority: '' })).toEqual(
      denied('origin-mismatch'),
    );
  });

  it('rejects the opaque origin, unparseable values, and non-http authorities', () => {
    expect(mutation({ origin: 'null', authority: '127.0.0.1:8787' })).toEqual(
      denied('opaque-origin'),
    );
    for (const origin of ['not a url', '', ' ', 'http://a b.example', '://'] as const) {
      expect(mutation({ origin, authority: '127.0.0.1:8787' }), `"${origin}"`).toEqual(
        denied('malformed-origin'),
      );
    }
    // A serialized Origin is always an http/https tuple: `file:`/`data:`/
    // `mailto:` parse but carry no origin authority — fail closed (the
    // P3-1 review fix; the empty-host corner needs no separate arm: the
    // WHATWG parser rejects every empty-host http/https form, so only
    // non-http schemes could carry one and they reject here already).
    for (const origin of [
      'file:///etc/passwd',
      'data:text/plain,hello',
      'mailto:user@example.test',
    ] as const) {
      expect(mutation({ origin, authority: '127.0.0.1:8787' }), `"${origin}"`).toEqual(
        denied('malformed-origin'),
      );
      expect(mutation({ origin, authority: '' }), `"${origin}" vs empty host`).toEqual(
        denied('malformed-origin'),
      );
    }
    // An http URL that parses always has a host — the parser collapses
    // the extra slash onto it (`http:///path` reads host `path`), so it
    // lands in the authority mismatch, never in an empty-host equality.
    expect(mutation({ origin: 'http:///path', authority: '127.0.0.1:8787' })).toEqual(
      denied('origin-mismatch'),
    );
  });
});

describe('classifyOriginRequest — the combined signal (§15.3, D-115)', () => {
  it('allows when both present signals independently pass', () => {
    expect(
      mutation({
        origin: 'http://127.0.0.1:8787',
        secFetchSite: 'same-origin',
        authority: '127.0.0.1:8787',
      }),
    ).toEqual(allowed);
    expect(
      mutation({
        origin: 'http://127.0.0.1:8787',
        secFetchSite: 'none',
        authority: '127.0.0.1:8787',
      }),
    ).toEqual(allowed);
  });

  it('rejects when the signals disagree — either failure suffices, in a fixed order', () => {
    // A browser never lets the two disagree; disagreement is a forged
    // client. The Origin family is checked first, so the reason is
    // deterministic when both are hostile.
    expect(
      mutation({
        origin: 'https://evil.example',
        secFetchSite: 'same-origin',
        authority: '127.0.0.1:8787',
      }),
    ).toEqual(denied('origin-mismatch'));
    expect(
      mutation({
        origin: 'http://127.0.0.1:8787',
        secFetchSite: 'cross-site',
        authority: '127.0.0.1:8787',
      }),
    ).toEqual(denied('cross-site-fetch'));
    expect(
      mutation({ origin: 'null', secFetchSite: 'cross-site', authority: '127.0.0.1:8787' }),
    ).toEqual(denied('opaque-origin'));
    expect(
      mutation({
        origin: 'not a url',
        secFetchSite: 'cross-site',
        authority: '127.0.0.1:8787',
      }),
    ).toEqual(denied('malformed-origin'));
  });

  it('allows a mutation with both headers absent — the non-browser client', () => {
    // Only browsers emit Origin/Sec-Fetch-Site on mutations; curl and the
    // future CLI send neither. The residual old-browser gap is task 150's
    // mandatory custom header (§15.3's second layer).
    expect(mutation({})).toEqual(allowed);
    expect(classifyOriginRequest({ method: 'DELETE' })).toEqual(allowed);
  });
});

describe("normalizeAuthority — the comparison yardstick (§15.3; task 151's seam)", () => {
  it('normalizes case, surrounding whitespace, and default ports', () => {
    for (const [value, expected] of [
      ['LocalHost:80', 'localhost'],
      ['localhost', 'localhost'],
      ['  127.0.0.1:8787  ', '127.0.0.1:8787'],
      ['[::1]:8080', '[::1]:8080'],
      ['a.example:443', 'a.example'],
      ['a.example:8443', 'a.example:8443'],
      ['', ''],
    ] as const) {
      expect(normalizeAuthority(value), `"${value}"`).toBe(expected);
    }
  });

  it("strips only the given scheme's default port — the other stays identity (P2-2)", () => {
    for (const [value, scheme, expected] of [
      ['a.example:80', 'http', 'a.example'],
      ['a.example:443', 'http', 'a.example:443'],
      ['a.example:443', 'https', 'a.example'],
      ['a.example:80', 'https', 'a.example:80'],
      ['a.example:8443', 'https', 'a.example:8443'],
      ['a.example', 'http', 'a.example'],
    ] as const) {
      expect(normalizeAuthority(value, scheme), `"${value}" ${scheme}`).toBe(expected);
    }
  });
});

describe("originGuard — the hook (D-113's throw-side pattern)", () => {
  /** A minimal request double — the hook reads method and three headers, nothing else. */
  function request(headers: Record<string, unknown>, method = 'POST'): FastifyRequest {
    return { method, headers } as unknown as FastifyRequest;
  }

  it('rejects with the FORBIDDEN ApiError, stable message, and reason detail', async () => {
    let error: unknown;
    try {
      await originGuard(request({ origin: 'https://evil.example', host: '127.0.0.1:8787' }));
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('FORBIDDEN');
    expect(apiError.statusCode).toBe(403);
    expect(apiError.message).toBe('Cross-origin request rejected');
    expect(apiError.details).toEqual({ reason: 'origin-mismatch' });
  });

  it('resolves without throwing for an allowed request', async () => {
    await expect(
      originGuard(request({ origin: 'http://127.0.0.1:8787', host: '127.0.0.1:8787' })),
    ).resolves.toBeUndefined();
    await expect(originGuard(request({ host: '127.0.0.1:8787' }))).resolves.toBeUndefined();
    await expect(originGuard(request({}, 'GET'))).resolves.toBeUndefined();
  });

  it("joins split header values into the wire's duplicate-join shape — and still rejects", async () => {
    // Node delivers duplicate headers joined (`a, b`), which fails the
    // strict checks; the array arm is the type-total read and must fail
    // identically — a split value can never smuggle a verdict through.
    await expect(
      originGuard(request({ 'sec-fetch-site': ['same-origin', 'cross-site'], host: 'x' })),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      originGuard(request({ origin: ['http://a.example', 'http://b.example'] })),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
