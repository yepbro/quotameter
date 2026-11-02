import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OutgoingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildHttpServer, type HttpServerOptions } from '../../src/server/http';
import { createLogger, type Logger } from '../../src/util/logger';
import { createMemoryLogSink } from '../helpers/logSink';
import { createTempDir, type TempDir } from '../helpers/isolation';

/**
 * Security headers (task 158, spec §15.5, §17.1; decision D-127): every
 * header the task configures is pinned by exact value — the strict CSP's
 * byte-exact wire string, nosniff, no-referrer, and the API-only
 * `Cache-Control: no-store` — across the response classes the layer must
 * cover (API success, API error envelopes, the `/api` scope's guard
 * verdicts, static assets, SPA deep links, both serving modes), and
 * against the surface §15.5 does not list: every unlisted helmet default
 * is pinned absent, because the emitted set is exactly the spec's list.
 * The browser-level proof that the UI still runs under this policy lives
 * in the e2e suite (`test/e2e/csp-shell.spec.ts` — a real Chromium against
 * the real construction over the built UI, CSP-violation events asserted
 * empty).
 *
 * Integration project on purpose: the headers are construction behavior,
 * exercised through the full task-146/158 `buildHttpServer` via
 * `fastify.inject`.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The exact §15.5 CSP wire string (task 158, D-127) — byte-pinned. The
 * implementation holds the directive object in `src/server/http.ts` and
 * helmet serializes it (directives joined with `;`, names and values with
 * single spaces, insertion order preserved); this literal is the
 * independent pin, so any directive, ordering, or formatting drift fails
 * here first.
 */
const CSP_WIRE_VALUE =
  "default-src 'none';" +
  "script-src 'self';" +
  "style-src 'self';" +
  "img-src 'self';" +
  "font-src 'self';" +
  "connect-src 'self';" +
  "base-uri 'none';" +
  "form-action 'none';" +
  "frame-ancestors 'none';" +
  "object-src 'none'";

/**
 * Helmet defaults §15.5 does not list (D-127) — every one is explicitly
 * disabled in the construction, so the emitted security-header surface is
 * exactly the spec's list. Pinned absent (beside the complete header-name
 * allowlist below) so a helmet upgrade that grows a default, or a dropped
 * `false` in the configuration, surfaces here instead of shipping
 * silently.
 */
const UNLISTED_HELMET_HEADERS = [
  'strict-transport-security',
  'x-frame-options',
  'x-download-options',
  'x-xss-protection',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'origin-agent-cluster',
  'x-dns-prefetch-control',
  'x-permitted-cross-domain-policies',
  'content-security-policy-report-only',
] as const;

/**
 * The COMPLETE header-name allowlist of an API response (pinned on the
 * representative `GET /api/health`): the §15.5 security set plus the
 * transport headers fastify/light-my-request emit. A denylist can only
 * catch the defaults someone thought to name; this pin catches a genuinely
 * NEW helmet default header the day it appears (review round P2-3) — the
 * tripwire D-127 claims, made executable.
 */
const API_RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
  'cache-control',
  'content-type',
  'content-length',
  'date',
  'connection',
]);

/** The shape of an injected response this suite asserts headers on. */
interface InjectedResponse {
  readonly headers: OutgoingHttpHeaders;
}

/** Asserts the exact §15.5 header set on a response — and nothing more. */
function expectSecurityHeaders(response: InjectedResponse, label = ''): void {
  expect(response.headers['content-security-policy'], label).toBe(CSP_WIRE_VALUE);
  expect(response.headers['x-content-type-options'], label).toBe('nosniff');
  expect(response.headers['referrer-policy'], label).toBe('no-referrer');
  for (const header of UNLISTED_HELMET_HEADERS) {
    expect(response.headers[header], `${label} ${header}`).toBeUndefined();
  }
}

/** Every Fastify instance this test file had a hand in creating. */
const openServers: FastifyInstance[] = [];

/** Builds the real construction with test defaults and records it for teardown. */
function buildServer(overrides: Partial<Omit<HttpServerOptions, 'logger'>> = {}): FastifyInstance {
  const logger: Logger = createLogger({ level: 'warn', destination: createMemoryLogSink() });
  const server = buildHttpServer({ host: '127.0.0.1', port: 0, logger, ...overrides });
  openServers.push(server);
  return server;
}

/** A built-UI fixture: `index.html` plus hashed JS/CSS assets. */
async function makeDistFixture(): Promise<TempDir> {
  const dir = await createTempDir('security-headers-dist-');
  await writeFile(join(dir.path, 'index.html'), '<html id="quotameter-ui">shell</html>');
  await writeFile(join(dir.path, 'app-0123.js'), 'console.log("app")');
  await writeFile(join(dir.path, 'app-0456.css'), 'body{}');
  return dir;
}

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await server.close().catch(() => undefined);
  }
});

describe('§15.5 header set on API responses (task 158, D-127)', () => {
  it('answers /api/health with the exact CSP, nosniff, no-referrer, and no-store', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expectSecurityHeaders(response);
    expect(response.headers['cache-control']).toBe('no-store');
    // The complete-name pin: an API response carries exactly the allowlisted
    // headers — the §15.5 set plus the transport basics — so a helmet
    // upgrade's brand-new default header fails here by name.
    expect(
      Object.keys(response.headers).filter((name) => !API_RESPONSE_HEADER_ALLOWLIST.has(name)),
    ).toEqual([]);
    expect([...API_RESPONSE_HEADER_ALLOWLIST].every((name) => name in response.headers)).toBe(true);
  });

  it('carries the full set on API error envelopes — a 404 is an API response', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/api/unknown' });
    expect(response.statusCode).toBe(404);
    expectSecurityHeaders(response);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('carries the full set on the /api scope guard verdicts — a 401 too', async () => {
    // The scope's guards (Origin/header/auth) reject strictly AFTER
    // helmet's root hooks in the hook chain, so their verdicts carry the
    // helmet set; the auth-mode 401 is the representative pin (D-121's
    // matrix cell: required mode, a password configured, no credentials).
    const server = buildServer({
      auth: { mode: 'required', passwordConfigured: () => true },
    });
    const response = await server.inject({ method: 'GET', url: '/api/unknown' });
    expect(response.statusCode).toBe(401);
    expectSecurityHeaders(response);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('answers the HEAD twin with the same headers', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'HEAD', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    expectSecurityHeaders(response);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('the API-vs-static split — no-store is the API rule (§15.5)', () => {
  it('serves static responses with the header set, on the static caching default', async () => {
    const dist = await makeDistFixture();
    try {
      const server = buildServer({ staticRoot: dist.path });
      for (const [url, contentType] of [
        ['/', 'text/html'],
        ['/app-0123.js', 'application/javascript'],
        ['/app-0456.css', 'text/css'],
        ['/accounts', 'text/html'], // SPA deep link — the app shell
      ] as const) {
        const response = await server.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(200);
        expect(response.headers['content-type'], url).toContain(contentType);
        expectSecurityHeaders(response, url);
        // §15.5 fixes one cache rule — "no-store for API responses" — and
        // no static caching directive; static responses keep
        // @fastify/static's own default, pinned so the API rule cannot
        // leak onto the frontend. `public, max-age=0` is revalidate
        // always (send's ETags answer conditional requests), so a
        // upgraded build can never serve a stale app shell.
        expect(response.headers['cache-control'], url).toBe('public, max-age=0');
      }
    } finally {
      await dist.remove();
    }
  });

  it('lets the §13 /api boundary decide the no-store arm — never a string prefix', async () => {
    const dist = await makeDistFixture();
    try {
      const server = buildServer({ staticRoot: dist.path });
      for (const url of ['/api', '/api?x=1', '/api/unknown']) {
        const response = await server.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(404);
        expect(response.headers['cache-control'], url).toBe('no-store');
      }
      // `/apiary` is a UI deep link: the SPA arm serves it, and no
      // string-prefix accident puts it on the no-store side.
      const lookalike = await server.inject({ method: 'GET', url: '/apiary' });
      expect(lookalike.statusCode).toBe(200);
      expect(lookalike.headers['cache-control']).toBe('public, max-age=0');
      expectSecurityHeaders(lookalike, '/apiary');
    } finally {
      await dist.remove();
    }
  });

  it('decides the boundary on the DECODED path — percent-encoded spellings are API paths', async () => {
    // Review round P2-1, reproduced before the fix: fastify's
    // `request.url` is the raw wire path while the router matches the
    // decoded one, so `/%61pi/health` reached the real `/api/health`
    // handler with NO Cache-Control at all, and the bare `/%61pi` served
    // the SPA shell instead of the §13 envelope. The predicate decodes.
    const server = buildServer();
    const health = await server.inject({ method: 'GET', url: '/%61pi/health' });
    expect(health.statusCode).toBe(200);
    expect(health.body).toBe('{"status":"ok"}');
    expect(health.headers['cache-control']).toBe('no-store');
    expectSecurityHeaders(health, '/%61pi/health');

    const unknown = await server.inject({ method: 'GET', url: '/%61pi/unknown' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['cache-control']).toBe('no-store');

    const dist = await makeDistFixture();
    try {
      const staticServer = buildServer({ staticRoot: dist.path });
      // The bare encoded form is the envelope arm, not the SPA shell —
      // with a built UI present.
      const bare = await staticServer.inject({ method: 'GET', url: '/%61pi' });
      expect(bare.statusCode).toBe(404);
      expect(bare.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(bare.headers['cache-control']).toBe('no-store');
      // And the encoded UI-deep-link shape still serves the shell.
      const deepLink = await staticServer.inject({ method: 'GET', url: '/%61ccounts' });
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.headers['cache-control']).toBe('public, max-age=0');
    } finally {
      await dist.remove();
    }
  });
});

describe('mode independence and layering (D-127)', () => {
  it('answers with the full set in API-only mode too, envelope 404s included', async () => {
    const server = buildServer({ staticRoot: join(REPO_ROOT, 'no-such-dist-directory') });
    const health = await server.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expectSecurityHeaders(health);
    expect(health.headers['cache-control']).toBe('no-store');

    // A non-API miss answers the §13 envelope (no SPA fallback in this
    // mode): the helmet set rode the hooks — nothing gate-rejected the
    // request — and no-store rides the envelope's own error-path
    // guarantee (sendApiError), which holds wherever the envelope appears.
    const miss = await server.inject({ method: 'GET', url: '/overview' });
    expect(miss.statusCode).toBe(404);
    expectSecurityHeaders(miss, '/overview');
    expect(miss.headers['cache-control']).toBe('no-store');
  });

  it('carries the full set on the Host guard verdict too; only router-level rejections miss it', async () => {
    // The layering pins (verified on the pinned runtime). Helmet's
    // onRequest hooks are added by a plugin registered AHEAD of the
    // construction's addHook calls, so they run FIRST in the root chain:
    // even the Host guard's thrown 403 carries the full helmet set. The
    // one rejection class without it is the router-level
    // `frameworkErrors` — a malformed percent-escape path is rejected
    // during routing, before any hook runs — and that response still
    // answers the §13 envelope with its no-store. Pinned so a
    // fastify/helmet change to this ordering is seen, not silent (the
    // security meaning is nil either way: an error JSON nothing renders,
    // while everything the browser does render carries the set).
    const server = buildServer();
    const hostileHost = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.example' },
    });
    expect(hostileHost.statusCode).toBe(403);
    expect(hostileHost.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(hostileHost.headers['cache-control']).toBe('no-store');
    expectSecurityHeaders(hostileHost, 'hostile host');

    const malformed = await server.inject({ method: 'GET', url: '/api/%zz' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(malformed.headers['cache-control']).toBe('no-store');
    expect(malformed.headers['content-security-policy']).toBeUndefined();
    expect(malformed.headers['x-content-type-options']).toBeUndefined();
    expect(malformed.headers['referrer-policy']).toBeUndefined();
  });
});
