import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildHttpServer } from '../../src/server/http';
import {
  clearSessionCookieAttributes,
  SESSION_COOKIE_NAME,
  sessionCookieAttributes,
  type SessionCookieTransportFacts,
} from '../../src/services/session-cookie';
import { SESSION_INACTIVITY_TIMEOUT_MS } from '../../src/storage/migrations';
import { generateSessionToken } from '../../src/services/sessions';
import { createLogger, type Logger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';

/**
 * Task 157's wire half (spec §15.2; decision D-126): the attribute layer
 * of `src/services/session-cookie.ts` serialized through the real
 * `@fastify/cookie` plugin registered by the task-146 construction — the
 * done-condition's "cookie attributes are tested under HTTP and
 * HTTPS/proxy setups" on the actual `Set-Cookie` header, not on the
 * options object. Probe routes on the constructed server compose the
 * module exactly as the future login/logout endpoint will (transport
 * facts resolved from the request, a minted token as the value), so the
 * suite also pins the resolution recipe the module documents: Node's
 * folded header view, the base64url value passing verbatim (no quoting —
 * D-123's cookie-safety pin), and the parse-back through
 * `request.cookies`. The guard-chain interaction for a cookie-setting
 * public route is D-121's own pinned territory (task 152's suite covers
 * `PUBLIC_AUTH_ROUTE_CONFIG`); these probes sit outside the `/api` scope's
 * hooks on purpose, so a proxied header cannot be answered by an auth
 * verdict that belongs to the endpoint task.
 */

/** A deterministic §11.1 epoch-millisecond anchor — the set instant. */
const T0 = 1_761_000_000_000;

/** Every Fastify instance this test file had a hand in creating. */
const openServers: Array<{ close(): Promise<void> }> = [];

/** The documented endpoint recipe: one request header value, Node-folded. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}

/**
 * The documented endpoint recipe (the module docblock's contract): the
 * transport facts of one request. `requestTls` reads the protocol Fastify
 * derived from the socket — trustProxy is never enabled in D-109's
 * construction, so no header can fake it; under `inject` the simulated
 * socket is plain HTTP, which is why the direct-TLS arm carries its fact
 * explicitly below.
 */
function transportFactsOf(request: FastifyRequest): SessionCookieTransportFacts {
  return {
    requestTls: request.protocol === 'https',
    forwardedProto: headerValue(request.headers['x-forwarded-proto']),
    forwarded: headerValue(request.headers.forwarded),
  };
}

/** Builds the real task-146 construction with cookie-probe routes added. */
function buildProbeServer(): FastifyInstance {
  const sink: MemoryLogSink = createMemoryLogSink();
  const logger: Logger = createLogger({ level: 'warn', destination: sink });
  const server = buildHttpServer({ host: '127.0.0.1', port: 0, logger });
  openServers.push(server);

  // The login composition: mint (D-123), resolve the transport facts, and
  // set the cookie with the module's attribute object — one spread, the
  // exact call the future endpoint makes. The expiry pair is the fresh
  // row's: `expires_at` at the 7-day inactivity bound (creation is the
  // first sighting), `now` the same reading creation stamped.
  server.get('/__session-cookie-probe', async (request, reply) => {
    const token = generateSessionToken();
    const attributes = sessionCookieAttributes({
      transport: transportFactsOf(request),
      expiresAtMs: T0 + SESSION_INACTIVITY_TIMEOUT_MS,
      nowMs: T0,
    });
    reply.setCookie(SESSION_COOKIE_NAME, token, attributes);
    return { secure: attributes.secure };
  });

  // The direct-TLS arm: `inject` cannot simulate a TLS socket, so this
  // probe carries the socket fact explicitly — what the serialization of
  // `secure: true` needs, with no header involved at all.
  server.get('/__session-cookie-probe/tls', async (_request, reply) => {
    const token = generateSessionToken();
    const attributes = sessionCookieAttributes({
      transport: { requestTls: true },
      expiresAtMs: T0 + SESSION_INACTIVITY_TIMEOUT_MS,
      nowMs: T0,
    });
    reply.setCookie(SESSION_COOKIE_NAME, token, attributes);
    return { secure: attributes.secure };
  });

  // The logout composition: the clear twin after `revokeSession` (D-124).
  server.get('/__session-cookie-probe/clear', async (request, reply) => {
    reply.setCookie(
      SESSION_COOKIE_NAME,
      '',
      clearSessionCookieAttributes(transportFactsOf(request)),
    );
    return {};
  });

  // The parse-back: the registered plugin's parsing half, proving the
  // value a client re-presents is the value that was set.
  server.get('/__session-cookie-probe/echo', async (request) => {
    return { value: request.cookies[SESSION_COOKIE_NAME] ?? null };
  });

  return server;
}

/** The single `Set-Cookie` header of a response, as the serializer wrote it. */
function setCookieHeader(
  server: FastifyInstance,
  url: string,
  headers: Record<string, string> = {},
) {
  return async (): Promise<{ header: string; secure: boolean }> => {
    const response = await server.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(200);
    const raw = response.headers['set-cookie'];
    expect(raw).toBeDefined();
    // Exactly one cookie is set per response here; both the lone-string
    // and the array representations are accepted, so a light-my-request
    // or Node representation change cannot fail this suite (the review
    // round's P3 — the attribute assertions below are the contract).
    const header = Array.isArray(raw) ? raw[0]! : (raw as string);
    return { header, secure: response.json().secure };
  };
}

/** The `name=value` pair plus the lowercase attribute names of a Set-Cookie header. */
function parseSetCookie(header: string): { pair: string; attributes: string[] } {
  const [pair, ...rawAttributes] = header.split('; ');
  return {
    pair: pair!,
    attributes: rawAttributes.map((attribute) => attribute.trim().toLowerCase()),
  };
}

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await server.close();
  }
});

describe('the session cookie on the wire (task 157, §15.2, D-126)', () => {
  it('plain-HTTP loopback setup: HttpOnly, SameSite=Strict, Path=/api, Max-Age — and no Secure', async () => {
    const server = buildProbeServer();
    const { header, secure } = await setCookieHeader(server, '/__session-cookie-probe')();
    expect(secure).toBe(false);
    const { pair, attributes } = parseSetCookie(header);
    // The value is the minted token, verbatim: base64url needs no quoting
    // (D-123's cookie-safety pin, now on the wire).
    expect(pair.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(pair.slice(SESSION_COOKIE_NAME.length + 1)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([...attributes].sort()).toStrictEqual(
      ['httponly', 'max-age=604800', 'path=/api', 'samesite=strict'].sort(),
    );
  });

  it('proxied HTTPS setup (X-Forwarded-Proto: https): Secure is set', async () => {
    const server = buildProbeServer();
    const { header, secure } = await setCookieHeader(server, '/__session-cookie-probe', {
      'x-forwarded-proto': 'https',
    })();
    expect(secure).toBe(true);
    const { attributes } = parseSetCookie(header);
    expect([...attributes].sort()).toStrictEqual(
      ['httponly', 'max-age=604800', 'path=/api', 'samesite=strict', 'secure'].sort(),
    );
  });

  it('proxied plain-HTTP setup (X-Forwarded-Proto: http): no Secure', async () => {
    const server = buildProbeServer();
    const { header, secure } = await setCookieHeader(server, '/__session-cookie-probe', {
      'x-forwarded-proto': 'http',
    })();
    expect(secure).toBe(false);
    expect(parseSetCookie(header).attributes).not.toContain('secure');
  });

  it('proxied HTTPS through RFC 7239 (Forwarded: proto=https): Secure is set', async () => {
    const server = buildProbeServer();
    const { header, secure } = await setCookieHeader(server, '/__session-cookie-probe', {
      forwarded: 'for=192.0.2.1;proto=https',
    })();
    expect(secure).toBe(true);
    expect(parseSetCookie(header).attributes).toContain('secure');
  });

  it('a multi-hop forwarded list rides Node folding and decides by its leftmost hop', async () => {
    const server = buildProbeServer();
    const proxiedHttps = await setCookieHeader(server, '/__session-cookie-probe', {
      'x-forwarded-proto': 'https, http',
    })();
    expect(proxiedHttps.secure).toBe(true);
    const proxiedHttp = await setCookieHeader(server, '/__session-cookie-probe', {
      'x-forwarded-proto': 'http, https',
    })();
    expect(proxiedHttp.secure).toBe(false);
    expect(parseSetCookie(proxiedHttp.header).attributes).not.toContain('secure');
  });

  it('direct TLS: Secure is set with no proxy header at all', async () => {
    const server = buildProbeServer();
    const { header, secure } = await setCookieHeader(server, '/__session-cookie-probe/tls')();
    expect(secure).toBe(true);
    expect(parseSetCookie(header).attributes).toContain('secure');
  });

  it('the logout clear twin carries Max-Age=0 with the same unconditional attributes', async () => {
    const server = buildProbeServer();
    const plain = await setCookieHeader(server, '/__session-cookie-probe/clear')();
    const { pair, attributes } = parseSetCookie(plain.header);
    expect(pair).toBe(`${SESSION_COOKIE_NAME}=`);
    expect([...attributes].sort()).toStrictEqual(
      ['httponly', 'max-age=0', 'path=/api', 'samesite=strict'].sort(),
    );
    // The proxied-HTTPS logout clears with Secure, addressing the cookie
    // the proxied-HTTPS login set.
    const proxied = await setCookieHeader(server, '/__session-cookie-probe/clear', {
      'x-forwarded-proto': 'https',
    })();
    expect(parseSetCookie(proxied.header).attributes).toContain('secure');
  });

  it('the set value re-parses verbatim through the registered plugin', async () => {
    const server = buildProbeServer();
    const { header } = await setCookieHeader(server, '/__session-cookie-probe')();
    const token = parseSetCookie(header).pair.slice(SESSION_COOKIE_NAME.length + 1);
    const response = await server.inject({
      method: 'GET',
      url: '/__session-cookie-probe/echo',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ value: token });
  });

  it('Max-Age ties to the schema constants — the fresh row expires at the inactivity bound', async () => {
    const server = buildProbeServer();
    const { header } = await setCookieHeader(server, '/__session-cookie-probe')();
    const maxAge = parseSetCookie(header).attributes.find((attribute) =>
      attribute.startsWith('max-age='),
    );
    expect(maxAge).toBe(`max-age=${SESSION_INACTIVITY_TIMEOUT_MS / 1000}`);
  });
});
