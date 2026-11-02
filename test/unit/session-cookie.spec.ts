import { describe, expect, it, vi } from 'vitest';
import { SESSION_INACTIVITY_TIMEOUT_MS } from '../../src/storage/migrations';
import {
  clearSessionCookieAttributes,
  isClientFacingHttps,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_PATH,
  sessionCookieAttributes,
} from '../../src/services/session-cookie';

/**
 * Task 157's unit half (spec §15.2; decision D-126): the session cookie's
 * attribute layer as pure tables — the `Secure` verdict over the transport
 * facts (the full HTTP / direct-TLS / proxy matrix §15.2's "public
 * URL/reverse-proxy configuration" resolves into, D-126's pin that the
 * configuration contract's missing public-URL field makes the request
 * itself the only source), the unconditional `HttpOnly`/`SameSite=Strict`
 * pins, the `Max-Age` mapping off the row's effective expiry (exact and
 * ceil-rounded, tied to the schema's own inactivity constant), the
 * fail-fast guards (the D-090/D-123 integrality family, plus the
 * expired-session refusal), and the logout clear twin. The wire half —
 * the attribute set serialized through the real `@fastify/cookie` plugin
 * on the real constructed server, plus the value's verbatim round-trip —
 * lives in `test/integration/session-cookie.spec.ts`.
 */

/** A deterministic §11.1 epoch-millisecond anchor for the expiry tables. */
const T0 = 1_761_000_000_000;

/** One day in epoch milliseconds — readable expiry deltas. */
const DAY_MS = 86_400_000;

/** The transport facts of a plain direct HTTP request — the loopback default deployment. */
const PLAIN_HTTP = { requestTls: false } as const;

/** The transport facts of a request whose own socket is TLS. */
const DIRECT_TLS = { requestTls: true } as const;

/** Facts with an `X-Forwarded-Proto` value (the de-facto proxy header). */
function xfp(value: string) {
  return { requestTls: false, forwardedProto: value };
}

/** Facts with an RFC 7239 `Forwarded` value (the standards-track fallback). */
function fwd(value: string) {
  return { requestTls: false, forwarded: value };
}

describe('SESSION_COOKIE_NAME / SESSION_COOKIE_PATH (D-126 identity pins)', () => {
  it('the cookie is named quotameter_session — self-identifying, never a generic collision', () => {
    expect(SESSION_COOKIE_NAME).toBe('quotameter_session');
  });

  it('the cookie is scoped to the /api prefix — never a static-asset request', () => {
    expect(SESSION_COOKIE_PATH).toBe('/api');
  });
});

describe('isClientFacingHttps (§15.2 Secure rule over the transport facts)', () => {
  it('plain direct HTTP — the loopback default — has no Secure', () => {
    expect(isClientFacingHttps(PLAIN_HTTP)).toBe(false);
  });

  it('a TLS socket is HTTPS regardless of any header', () => {
    expect(isClientFacingHttps(DIRECT_TLS)).toBe(true);
    // Direct observation outranks the forwarded claim.
    expect(isClientFacingHttps({ requestTls: true, forwardedProto: 'http' })).toBe(true);
    expect(isClientFacingHttps({ requestTls: true, forwarded: 'for=a;proto=http' })).toBe(true);
  });

  it('X-Forwarded-Proto: https is HTTPS — exact, cased, and whitespace-tolerant', () => {
    expect(isClientFacingHttps(xfp('https'))).toBe(true);
    expect(isClientFacingHttps(xfp('HTTPS'))).toBe(true);
    expect(isClientFacingHttps(xfp('  https  '))).toBe(true);
  });

  it('X-Forwarded-Proto: http is not HTTPS', () => {
    expect(isClientFacingHttps(xfp('http'))).toBe(false);
  });

  it('a multi-hop X-Forwarded-Proto list is decided by its leftmost element', () => {
    // Proxies append, so the first element names the client-facing leg.
    expect(isClientFacingHttps(xfp('https, http'))).toBe(true);
    expect(isClientFacingHttps(xfp('http, https'))).toBe(false);
    expect(isClientFacingHttps(xfp('https,http'))).toBe(true);
  });

  it('an empty X-Forwarded-Proto is no evidence — the fallback stays consultable', () => {
    expect(isClientFacingHttps(xfp(''))).toBe(false);
    expect(isClientFacingHttps(xfp('   '))).toBe(false);
    // No proto claim of its own: the RFC 7239 header still answers.
    expect(
      isClientFacingHttps({
        requestTls: false,
        forwardedProto: '',
        forwarded: 'for=a;proto=https',
      }),
    ).toBe(true);
  });

  it('a non-https proto claim answers literally, whatever protocol it names', () => {
    expect(isClientFacingHttps(xfp('ftp'))).toBe(false);
    expect(isClientFacingHttps(xfp('wss'))).toBe(false);
  });

  it('Forwarded: proto=https is HTTPS — parameter names and values case-insensitively', () => {
    expect(isClientFacingHttps(fwd('for=192.0.2.1;proto=https'))).toBe(true);
    expect(isClientFacingHttps(fwd('for=192.0.2.1;PROTO=HTTPS'))).toBe(true);
    expect(isClientFacingHttps(fwd('proto=https;for=192.0.2.1'))).toBe(true);
    // RFC 7239 §6: values may be quoted.
    expect(isClientFacingHttps(fwd('for=192.0.2.1;proto="https"'))).toBe(true);
  });

  it('Forwarded: proto=http (or any non-https value) is not HTTPS', () => {
    expect(isClientFacingHttps(fwd('for=192.0.2.1;proto=http'))).toBe(false);
    expect(isClientFacingHttps(fwd('for=192.0.2.1;proto="http"'))).toBe(false);
  });

  it('a Forwarded entry without a proto parameter is no evidence', () => {
    expect(isClientFacingHttps(fwd('for=192.0.2.1'))).toBe(false);
    expect(isClientFacingHttps(fwd('for=192.0.2.1;by=203.0.113.7'))).toBe(false);
    // A dangling token without `=` is no parameter at all.
    expect(isClientFacingHttps(fwd('for=a;proto'))).toBe(false);
    // An empty proto value — bare or quoted — is no claim.
    expect(isClientFacingHttps(fwd('proto='))).toBe(false);
    expect(isClientFacingHttps(fwd('proto=""'))).toBe(false);
    // A lone quote is neither quoted nor a protocol.
    expect(isClientFacingHttps(fwd('proto="'))).toBe(false);
    // ...and a proto-less leftmost entry does not answer for a proto-ful
    // later one — the leftmost entry names the client-facing leg.
    expect(isClientFacingHttps(fwd('for=a, for=b;proto=https'))).toBe(false);
  });

  it('a multi-entry Forwarded list is decided by its leftmost entry', () => {
    expect(isClientFacingHttps(fwd('for=a;proto=https, for=b;proto=http'))).toBe(true);
    expect(isClientFacingHttps(fwd('for=a;proto=http, for=b;proto=https'))).toBe(false);
  });

  it('quoted Forwarded values do not cut an entry off its proto (RFC 7239 §5.2/§6)', () => {
    // The RFC's own quoted-list example shape: the comma inside the quotes
    // is part of the `for` value, not an entry separator — the review
    // round's P2 fix, pinned against the plain split that lost `proto`.
    expect(isClientFacingHttps(fwd('for="192.0.2.43, 2001:db8:cafe::17";proto=https'))).toBe(true);
    expect(isClientFacingHttps(fwd('for="a,b";proto=https'))).toBe(true);
    // A semicolon inside quotes is part of the value, not a parameter
    // separator — the quoted `proto=http` below is data, the bare one the
    // claim.
    expect(isClientFacingHttps(fwd('for="a;proto=http";proto=https'))).toBe(true);
    expect(isClientFacingHttps(fwd('for="a;proto=https";proto=http'))).toBe(false);
    // A backslash-escaped quote inside the value does not close the
    // quote (RFC 7239 §6): the parameter separator after it is real.
    expect(isClientFacingHttps(fwd('for="x\\"y";proto=https'))).toBe(true);
    // ...and an escaped quote followed by the claim keeps the claim
    // quoted data — the quote never closed before it.
    expect(isClientFacingHttps(fwd('for="x\\";proto=https'))).toBe(false);
    // An unbalanced quote conservatively quotes to the end: the `;` and
    // the would-be proto stay quoted *data* inside the `for` value — no
    // fabricated split, and no parameter is conjured out of the quote.
    expect(isClientFacingHttps(fwd('for="unbalanced;proto=https'))).toBe(false);
  });

  it('an empty Forwarded value is no evidence', () => {
    expect(isClientFacingHttps(fwd(''))).toBe(false);
  });

  it('X-Forwarded-Proto outranks Forwarded when both are present', () => {
    expect(
      isClientFacingHttps({
        requestTls: false,
        forwardedProto: 'https',
        forwarded: 'for=a;proto=http',
      }),
    ).toBe(true);
    expect(
      isClientFacingHttps({
        requestTls: false,
        forwardedProto: 'http',
        forwarded: 'for=a;proto=https',
      }),
    ).toBe(false);
  });
});

describe('sessionCookieAttributes (the login cookie)', () => {
  it('HttpOnly and SameSite=Strict and Path=/api are unconditional across every transport', () => {
    const transports = [
      PLAIN_HTTP,
      DIRECT_TLS,
      xfp('https'),
      xfp('http'),
      fwd('for=a;proto=https'),
    ];
    for (const transport of transports) {
      const attributes = sessionCookieAttributes({
        transport,
        expiresAtMs: T0 + 7 * DAY_MS,
        nowMs: T0,
      });
      expect(attributes.httpOnly).toBe(true);
      expect(attributes.sameSite).toBe('strict');
      expect(attributes.path).toBe('/api');
    }
  });

  it('secure mirrors the client-facing protocol — off on plain HTTP, on for HTTPS/proxy HTTPS', () => {
    // Plain-HTTP loopback setup: no Secure (§15.2's flag exists for HTTPS).
    expect(
      sessionCookieAttributes({ transport: PLAIN_HTTP, expiresAtMs: T0 + DAY_MS, nowMs: T0 })
        .secure,
    ).toBe(false);
    // Proxied HTTP: the client-facing leg is plain — still no Secure.
    expect(
      sessionCookieAttributes({
        transport: xfp('http'),
        expiresAtMs: T0 + DAY_MS,
        nowMs: T0,
      }).secure,
    ).toBe(false);
    // Public HTTPS through the reverse proxy: Secure is set.
    expect(
      sessionCookieAttributes({
        transport: xfp('https'),
        expiresAtMs: T0 + DAY_MS,
        nowMs: T0,
      }).secure,
    ).toBe(true);
    expect(
      sessionCookieAttributes({
        transport: fwd('for=192.0.2.1;proto=https'),
        expiresAtMs: T0 + DAY_MS,
        nowMs: T0,
      }).secure,
    ).toBe(true);
    // Direct TLS: Secure is set.
    expect(
      sessionCookieAttributes({
        transport: DIRECT_TLS,
        expiresAtMs: T0 + DAY_MS,
        nowMs: T0,
      }).secure,
    ).toBe(true);
  });

  it('maxAge mirrors the row expiry in whole seconds — the 7-day login tie', () => {
    // A fresh row (D-123) expires at the inactivity bound: min(7 d, 30 d).
    const attributes = sessionCookieAttributes({
      transport: PLAIN_HTTP,
      expiresAtMs: T0 + SESSION_INACTIVITY_TIMEOUT_MS,
      nowMs: T0,
    });
    expect(attributes.maxAge).toBe(604_800);
    expect(attributes.maxAge).toBe(SESSION_INACTIVITY_TIMEOUT_MS / 1000);
  });

  it('maxAge rounds up — the client cookie never dies before the row', () => {
    // One millisecond of remaining lifetime still buys a full second.
    expect(
      sessionCookieAttributes({ transport: PLAIN_HTTP, expiresAtMs: T0 + 1, nowMs: T0 }).maxAge,
    ).toBe(1);
    // 1001 ms of lifetime is 1.001 s — rounded up, never truncated to 1.
    expect(
      sessionCookieAttributes({ transport: PLAIN_HTTP, expiresAtMs: T0 + 1001, nowMs: T0 }).maxAge,
    ).toBe(2);
    // An exact-second boundary is exact.
    expect(
      sessionCookieAttributes({ transport: PLAIN_HTTP, expiresAtMs: T0 + 1000, nowMs: T0 }).maxAge,
    ).toBe(1);
  });

  it('a non-integer epoch-ms input fails fast, naming the field (D-090/D-123)', () => {
    expect(() =>
      sessionCookieAttributes({ transport: PLAIN_HTTP, expiresAtMs: T0 + 0.5, nowMs: T0 }),
    ).toThrowError(TypeError);
    expect(() =>
      sessionCookieAttributes({ transport: PLAIN_HTTP, expiresAtMs: T0 + 0.5, nowMs: T0 }),
    ).toThrowError(/expiresAtMs/);
    expect(() =>
      sessionCookieAttributes({
        transport: PLAIN_HTTP,
        expiresAtMs: T0 + DAY_MS,
        nowMs: Number.NaN,
      }),
    ).toThrowError(TypeError);
    expect(() =>
      sessionCookieAttributes({
        transport: PLAIN_HTTP,
        expiresAtMs: T0 + DAY_MS,
        nowMs: Number.NaN,
      }),
    ).toThrowError(/nowMs/);
  });

  it('refuses an already-expired (or exactly expiring) session — clearing is the other primitive', () => {
    expect(() =>
      sessionCookieAttributes({ transport: PLAIN_HTTP, expiresAtMs: T0, nowMs: T0 }),
    ).toThrowError(/expired/);
    expect(() =>
      sessionCookieAttributes({ transport: PLAIN_HTTP, expiresAtMs: T0, nowMs: T0 + 1 }),
    ).toThrowError(/expired/);
  });

  it('the attribute object is frozen', () => {
    const attributes = sessionCookieAttributes({
      transport: PLAIN_HTTP,
      expiresAtMs: T0 + DAY_MS,
      nowMs: T0,
    });
    expect(Object.isFrozen(attributes)).toBe(true);
  });
});

describe('clearSessionCookieAttributes (the logout cookie)', () => {
  it('carries Max-Age=0 — the deletion protocol — with the same unconditional pins', () => {
    const attributes = clearSessionCookieAttributes(PLAIN_HTTP);
    expect(attributes.maxAge).toBe(0);
    expect(attributes.httpOnly).toBe(true);
    expect(attributes.sameSite).toBe('strict');
    expect(attributes.path).toBe('/api');
  });

  it('secure mirrors the same transport rule — the deletion must address the cookie that was set', () => {
    expect(clearSessionCookieAttributes(PLAIN_HTTP).secure).toBe(false);
    expect(clearSessionCookieAttributes(DIRECT_TLS).secure).toBe(true);
    expect(clearSessionCookieAttributes(xfp('https')).secure).toBe(true);
    expect(clearSessionCookieAttributes(xfp('http')).secure).toBe(false);
  });

  it('the clear attribute object is frozen', () => {
    expect(Object.isFrozen(clearSessionCookieAttributes(PLAIN_HTTP))).toBe(true);
  });
});

describe('module discipline', () => {
  it('writes nothing to the console — no logger to leak a token through (§15.4/§16)', () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) =>
      vi.spyOn(console, level as keyof Console).mockImplementation(() => {}),
    );
    try {
      expect(isClientFacingHttps(xfp('https'))).toBe(true);
      const attributes = sessionCookieAttributes({
        transport: xfp('https'),
        expiresAtMs: T0 + DAY_MS,
        nowMs: T0,
      });
      expect(attributes.maxAge).toBe(86_400);
      expect(clearSessionCookieAttributes(PLAIN_HTTP).maxAge).toBe(0);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
