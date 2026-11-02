import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildHttpServer, HTTP_BODY_LIMIT_BYTES } from '../../src/server/http';
import { createLogger, type Logger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { createTempDir, type TempDir } from '../helpers/isolation';

/**
 * The §15.3 Origin/Fetch-Metadata guard on the wire (task 149, decision
 * D-115): through the full task-146 construction (`buildHttpServer` +
 * `fastify.inject`, no sockets), cross-origin mutations under `/api` are
 * rejected with the §13 envelope's FORBIDDEN class (task 148's registry
 * already names CSRF rejections there) while legitimate mutations,
 * safe-method requests, and the header-less non-browser client pass —
 * identically in API-only and static-serving modes (the D-113 lesson:
 * no verdict may depend on the static build) and in every auth mode (the
 * guard consults headers only; mode selection is task 152's own layer).
 *
 * Pass-through evidence rides the scope's catch-all route (task 148): an
 * allowed mutation reaches it and answers its 404 envelope — a response
 * class the guard can never produce — while a rejected one answers 403
 * before any handler runs. The real mutation endpoints (159+) register
 * into the same scope and inherit the hook unchanged.
 */

/** Every Fastify instance this test file had a hand in creating. */
const openServers: FastifyInstance[] = [];

/** Builds the real construction with test defaults and records it for teardown. */
function buildServer(
  staticRoot?: string,
  host = '127.0.0.1',
): {
  server: FastifyInstance;
  sink: MemoryLogSink;
} {
  const sink = createMemoryLogSink();
  const logger: Logger = createLogger({ level: 'warn', destination: sink });
  const server = buildHttpServer({
    host,
    port: 0,
    logger,
    ...(staticRoot === undefined ? {} : { staticRoot }),
  });
  openServers.push(server);
  return { server, sink };
}

/** A built-UI fixture: `index.html` plus one asset (the api-errors pattern). */
async function makeDistFixture(): Promise<TempDir> {
  const dir = await createTempDir('origin-dist-');
  await writeFile(join(dir.path, 'index.html'), '<html id="quotameter-ui">shell</html>');
  await writeFile(join(dir.path, 'style.css'), 'body{}');
  return dir;
}

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await server.close().catch(() => undefined);
  }
});

/** The loopback authority the injections below pose as. */
const HOST = { host: '127.0.0.1:8787' };

/**
 * The dedicated mutation header every pass-through mutation carries
 * since task 150 (`./api-custom-header.spec.ts` pins that guard's own
 * matrix) — here it is scenery, keeping the origin guard's pass-through
 * arms reaching the router. The arms are bodiless, so the JSON
 * content-type leg does not apply to them (D-117) and none is sent.
 */
const MUTATION_HEADERS = { 'x-quotameter-request': 'quotameter-ui' };

describe('cross-origin mutations — rejected through the §13 envelope (§15.3)', () => {
  it('rejects a cross-origin Origin on all four state-changing methods', async () => {
    const { server } = buildServer();
    const post = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { origin: 'https://evil.example', ...HOST },
    });
    expect(post.statusCode).toBe(403);
    expect(post.body).toBe(
      '{"error":{"code":"FORBIDDEN","message":"Cross-origin request rejected","details":{"reason":"origin-mismatch"}}}',
    );
    expect(post.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(post.headers['cache-control']).toBe('no-store');
    // The same verdict for every state-changing method (§13's set).
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const response = await server.inject({
        method,
        url: '/api/accounts',
        headers: { origin: 'https://evil.example', ...HOST },
      });
      expect(response.statusCode, method).toBe(403);
      expect(response.json(), method).toEqual({
        error: {
          code: 'FORBIDDEN',
          message: 'Cross-origin request rejected',
          details: { reason: 'origin-mismatch' },
        },
      });
    }
  });

  it('rejects hostile Sec-Fetch-Site values — cross-site, same-site, malformed', async () => {
    const { server } = buildServer();
    const crossSite = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { 'sec-fetch-site': 'cross-site', ...HOST },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.body).toBe(
      '{"error":{"code":"FORBIDDEN","message":"Cross-origin request rejected","details":{"reason":"cross-site-fetch"}}}',
    );
    // `same-site` is rejected beside `cross-site` (D-115): same-site ≠
    // same-origin — a sibling subdomain or another port is still a
    // cross-origin mutation. Malformed tokens fail closed.
    for (const secFetchSite of ['same-site', 'forged-token']) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: { 'sec-fetch-site': secFetchSite, ...HOST },
      });
      expect(response.statusCode, secFetchSite).toBe(403);
      expect(response.json(), secFetchSite).toMatchObject({
        error: { code: 'FORBIDDEN', details: { reason: 'cross-site-fetch' } },
      });
    }
  });

  it('rejects opaque and malformed Origins with their own reasons', async () => {
    const { server } = buildServer();
    for (const [origin, reason] of [
      ['null', 'opaque-origin'],
      ['not a url', 'malformed-origin'],
    ] as const) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: { origin, ...HOST },
      });
      expect(response.statusCode, origin).toBe(403);
      expect(response.json(), origin).toEqual({
        error: {
          code: 'FORBIDDEN',
          message: 'Cross-origin request rejected',
          details: { reason },
        },
      });
    }
  });

  it('rejects when the two signals disagree — either failure suffices', async () => {
    const { server } = buildServer();
    const hostileMetadata = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { origin: 'http://127.0.0.1:8787', 'sec-fetch-site': 'cross-site', ...HOST },
    });
    expect(hostileMetadata.statusCode).toBe(403);
    expect(hostileMetadata.json()).toMatchObject({
      error: { details: { reason: 'cross-site-fetch' } },
    });
    const hostileOrigin = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin', ...HOST },
    });
    expect(hostileOrigin.statusCode).toBe(403);
    expect(hostileOrigin.json()).toMatchObject({
      error: { details: { reason: 'origin-mismatch' } },
    });
  });

  it("screens unmatched mutations too — the guard outranks the scope's catch-all", async () => {
    // A method mismatch on a real route is still a mutation attempt: the
    // 403 arrives before routing's own 404 (and a hostile client learns
    // nothing about the route table).
    const { server } = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/health',
      headers: { origin: 'https://evil.example', ...HOST },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('rejects before the body is read or parsed — the guard outranks the transport classes', async () => {
    // The ordering pin (onRequest, ahead of the content-type parser and
    // the body limit): a cross-origin mutation answers 403 even when the
    // body is malformed or over the §15.5 limit, and a same-origin
    // control still answers the transport classes (400/413) — proving
    // the 403 is the guard, not a coincidental status.
    const { server } = buildServer();
    const malformed = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: '{"broken',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json', ...HOST },
    });
    expect(malformed.statusCode).toBe(403);
    expect(malformed.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const overLimit = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: `"${'x'.repeat(HTTP_BODY_LIMIT_BYTES - 1)}"`,
      headers: { origin: 'https://evil.example', 'content-type': 'application/json', ...HOST },
    });
    expect(overLimit.statusCode).toBe(403);
    expect(overLimit.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const sameOriginControl = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: '{"broken',
      headers: {
        origin: 'http://127.0.0.1:8787',
        ...MUTATION_HEADERS,
        'content-type': 'application/json', // bodied: task 150's other leg
        ...HOST,
      },
    });
    expect(sameOriginControl.statusCode).toBe(400);
    expect(sameOriginControl.json()).toMatchObject({ error: { code: 'VALIDATION' } });
  });

  it('echoes no attacker-controlled header value in the envelope (§15.4)', async () => {
    const { server } = buildServer();
    const response = await server.inject({
      method: 'DELETE',
      url: '/api/accounts/1',
      headers: {
        origin: 'https://evil.example/<script>',
        'sec-fetch-site': 'cross-site',
        ...HOST,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('evil.example');
    expect(response.body).not.toContain('<script>');
  });
});

describe('legitimate mutations and safe requests — pass-through (§15.3)', () => {
  it('passes a same-origin mutation on to the router', async () => {
    const { server } = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { origin: 'http://127.0.0.1:8787', ...MUTATION_HEADERS, ...HOST },
    });
    // The scope catch-all's 404 — a class the guard can never produce —
    // is the proof the request passed the guard and was routed.
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(
      '{"error":{"code":"NOT_FOUND","message":"Not found","details":{"method":"POST","path":"/api/accounts"}}}',
    );
  });

  it('passes browser fetch-metadata tokens and the origin-header-less non-browser mutation', async () => {
    const { server } = buildServer();
    // The custom header/content type are carried by every pass-through
    // mutation since task 150 (MUTATION_HEADERS); "header-less" here is
    // the ORIGIN family — only browsers emit those on mutations.
    for (const headers of [
      { 'sec-fetch-site': 'same-origin', ...MUTATION_HEADERS, ...HOST },
      { 'sec-fetch-site': 'none', ...MUTATION_HEADERS, ...HOST },
      { ...MUTATION_HEADERS, ...HOST },
      { ...MUTATION_HEADERS },
    ]) {
      const response = await server.inject({ method: 'POST', url: '/api/settings', headers });
      expect(response.statusCode, JSON.stringify(headers)).toBe(404);
      expect(response.json(), JSON.stringify(headers)).toMatchObject({
        error: { code: 'NOT_FOUND' },
      });
    }
  });

  it('matches authorities across default ports and case', async () => {
    // The proxied arm configures the public name as the server's host —
    // since task 151 the root-scope Host allowlist (D-120) admits
    // `QUOTAMETER.EXAMPLE:443` only as "the configured host" (§15.6's
    // TLS-terminating-proxy hop); the loopback arm needs no configured
    // name (the base allowlist carries `localhost`).
    const { server } = buildServer();
    // A browser Origin never serializes the default port; hosts and
    // proxies sometimes write one. Also the inject default (`localhost:80`).
    const localhost = await server.inject({
      method: 'POST',
      url: '/api/settings',
      headers: { origin: 'http://localhost', host: 'localhost:80', ...MUTATION_HEADERS },
    });
    expect(localhost.statusCode).toBe(404);
    const { server: proxiedServer } = buildServer(undefined, 'quotameter.example');
    const proxied = await proxiedServer.inject({
      method: 'POST',
      url: '/api/settings',
      headers: {
        origin: 'https://quotameter.example',
        host: 'QUOTAMETER.EXAMPLE:443',
        ...MUTATION_HEADERS,
      },
    });
    expect(proxied.statusCode).toBe(404);
    expect(proxied.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('keeps safe methods untouched even with hostile headers', async () => {
    const { server } = buildServer();
    const hostile = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', ...HOST };
    const health = await server.inject({ method: 'GET', url: '/api/health', headers: hostile });
    expect(health.statusCode).toBe(200);
    expect(health.body).toBe('{"status":"ok"}');
    const head = await server.inject({ method: 'HEAD', url: '/api/health', headers: hostile });
    expect(head.statusCode).toBe(200);
    // A safe method on an unknown path answers the 404 envelope, not a
    // CSRF verdict — GET carries no mutation to forge.
    const unknown = await server.inject({ method: 'GET', url: '/api/unknown', headers: hostile });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('mode independence — the guard with static serving active (D-113 lesson)', () => {
  it('answers identical rejections while the SPA keeps serving', async () => {
    const dist = await makeDistFixture();
    try {
      const { server } = buildServer(dist.path);
      const response = await server.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: { origin: 'https://evil.example', ...HOST },
      });
      expect(response.statusCode).toBe(403);
      expect(response.body).toBe(
        '{"error":{"code":"FORBIDDEN","message":"Cross-origin request rejected","details":{"reason":"origin-mismatch"}}}',
      );
      // The mode this scope must not disturb: deep links serve the shell.
      const deepLink = await server.inject({ method: 'GET', url: '/accounts' });
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.body).toContain('quotameter-ui');
      const health = await server.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      // Pass-through holds in this mode too.
      const allowedMutation = await server.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: { origin: 'http://127.0.0.1:8787', ...MUTATION_HEADERS, ...HOST },
      });
      expect(allowedMutation.statusCode).toBe(404);
    } finally {
      await dist.remove();
    }
  });
});

describe('the bare-/api boundary (§13)', () => {
  it('answers a cross-origin POST to the bare /api through the root not-found arm', async () => {
    // The scope's routes (guard included) need a trailing segment; the
    // bare `/api` is no endpoint at all, so the mutation is rejected by
    // routing itself — the documented boundary, not a guard bypass.
    const { server } = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api',
      headers: { origin: 'https://evil.example', ...HOST },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Not found',
        details: { method: 'POST', path: '/api' },
      },
    });
  });
});

describe('§16 — guard rejections log nothing', () => {
  it('keeps the sink at its baseline across rejections and pass-throughs', async () => {
    const { server, sink } = buildServer();
    const baseline = sink.records().length;
    await server.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { origin: 'https://evil.example', ...HOST },
    });
    await server.inject({
      method: 'DELETE',
      url: '/api/accounts/1',
      headers: { 'sec-fetch-site': 'same-site', ...MUTATION_HEADERS, ...HOST },
    });
    await server.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { ...MUTATION_HEADERS, ...HOST },
    });
    // A client-side rejection is a 4xx class: §16's level discipline logs
    // nothing at warn — there is nothing to diagnose server-side.
    expect(sink.records().length).toBe(baseline);
  });
});
