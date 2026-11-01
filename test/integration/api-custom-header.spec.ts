import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildHttpServer } from '../../src/server/http';
import { API_MUTATION_HEADER_NAME } from '../../src/server/api/security';
import { createLogger, type Logger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { createTempDir, type TempDir } from '../helpers/isolation';

/**
 * The §15.3 custom-header/JSON-content-type guard on the wire (task 150,
 * decision D-117): through the full task-146 construction
 * (`buildHttpServer` + `fastify.inject`, no sockets), a state-changing
 * request under `/api` without the dedicated nonstandard header
 * `X-Quotameter-Request` (or with one that is present but empty) is
 * rejected through the §13 envelope's FORBIDDEN class with the reason
 * detail, and a request that carries a body whose Content-Type's base
 * media type is not `application/json` is rejected as the 415 class in
 * the registry's default shape — byte-identical to fastify's native
 * media-type rejection, so the class keeps one wire body (D-113). The
 * content-type leg binds body-carrying requests only: a bodiless
 * mutation (verified live: fastify answers a claimed-but-empty JSON body
 * with its own empty-body 400) has no payload to type, and the dedicated
 * header — the unforgeable leg — applies always. Requests that satisfy
 * the guard pass to the router, safe methods stay untouched, and the
 * verdicts are identical in API-only and static-serving modes and in
 * every auth mode (D-113/D-115: the guard consults exactly
 * `{method, customHeader, contentType, contentLength, transferEncoding}`,
 * never server state).
 *
 * Pass-through evidence rides the scope's catch-all route (task 148): an
 * allowed mutation reaches it and answers its 404 envelope — a response
 * class the guard can never produce — while a rejected one answers 403/415
 * before any handler runs. The real mutation endpoints (159+) register
 * into the same scope and inherit the hooks unchanged.
 */

/** Every Fastify instance this test file had a hand in creating. */
const openServers: FastifyInstance[] = [];

/** Builds the real construction with test defaults and records it for teardown. */
function buildServer(staticRoot?: string): { server: FastifyInstance; sink: MemoryLogSink } {
  const sink = createMemoryLogSink();
  const logger: Logger = createLogger({ level: 'warn', destination: sink });
  const server = buildHttpServer({
    host: '127.0.0.1',
    port: 0,
    logger,
    ...(staticRoot === undefined ? {} : { staticRoot }),
  });
  openServers.push(server);
  return { server, sink };
}

/** A built-UI fixture: `index.html` plus one asset (the api-errors pattern). */
async function makeDistFixture(): Promise<TempDir> {
  const dir = await createTempDir('custom-header-dist-');
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

/** The dedicated header — the one requirement every mutation carries. */
const CUSTOM_HEADER = { 'x-quotameter-request': 'quotameter-ui' };

/** The headers a legitimate bodied mutation carries. */
const BODIED_MUTATION_HEADERS = { ...CUSTOM_HEADER, 'content-type': 'application/json' };

describe('mutations without the dedicated header — rejected through the §13 envelope (§15.3)', () => {
  it('rejects the absent header on all four state-changing methods, byte-pinned', async () => {
    const { server } = buildServer();
    const post = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: '{}',
      headers: { 'content-type': 'application/json', ...HOST },
    });
    expect(post.statusCode).toBe(403);
    expect(post.body).toBe(
      '{"error":{"code":"FORBIDDEN","message":"The X-Quotameter-Request header is required","details":{"reason":"missing-custom-header"}}}',
    );
    expect(post.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(post.headers['cache-control']).toBe('no-store');
    // The same verdict for every state-changing method (§13's set) —
    // bodied (PUT/PATCH carry a payload) and bodiless (DELETE) alike:
    // the header leg applies always.
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const response = await server.inject({
        method,
        url: '/api/accounts',
        payload: method === 'DELETE' ? undefined : '{}',
        headers: { 'content-type': 'application/json', ...HOST },
      });
      expect(response.statusCode, method).toBe(403);
      expect(response.json(), method).toEqual({
        error: {
          code: 'FORBIDDEN',
          message: `The ${API_MUTATION_HEADER_NAME} header is required`,
          details: { reason: 'missing-custom-header' },
        },
      });
    }
  });

  it('rejects an empty header value and the wrong-name lookalikes', async () => {
    const { server } = buildServer();
    // An empty value is not a header in any meaningful sense (fail
    // closed); lookalike names — the plural, the bare prefix, the classic
    // nonstandard CSRF header — are absent as far as the guard is
    // concerned, and none of them may satisfy it.
    for (const [name, value] of [
      ['x-quotameter-request', ''],
      ['x-quotameter-request', '   '],
      ['x-quotameter-requests', '1'],
      ['x-quotameter', '1'],
      ['x-requested-with', 'XMLHttpRequest'],
      ['x-csrf-token', '1'],
    ] as const) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: '{}',
        headers: { [name]: value, 'content-type': 'application/json', ...HOST },
      });
      expect(response.statusCode, `${name}: ${value}`).toBe(403);
      expect(response.json(), `${name}: ${value}`).toMatchObject({
        error: { code: 'FORBIDDEN', details: { reason: 'missing-custom-header' } },
      });
    }
  });

  it('screens unmatched mutations too — the guard outranks the catch-all and the body parser', async () => {
    const { server } = buildServer();
    // An unknown path (the scope's catch-all) and a method mismatch on a
    // real route are still mutation attempts: the 403 arrives before
    // routing's own 404 and before any body parsing.
    for (const url of ['/api/unknown-path', '/api/health'] as const) {
      const response = await server.inject({
        method: 'POST',
        url,
        payload: '{"broken',
        headers: { 'content-type': 'application/json', ...HOST },
      });
      expect(response.statusCode, url).toBe(403);
      expect(response.json(), url).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
  });
});

describe('body-carrying mutations with a non-JSON content type — the 415 class (§15.3)', () => {
  it('rejects the form-built content types on all four methods, byte-pinned against the native class', async () => {
    const { server } = buildServer();
    // The three HTML form enctype values are the CSRF shapes; the wire body is
    // the registry default — exactly fastify's native 415 body (D-113),
    // so the class keeps one shape regardless of which layer rejected.
    // Every state-changing method rejects them (§13's set, bodied arms).
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      for (const contentType of [
        'text/plain',
        'application/x-www-form-urlencoded',
        'multipart/form-data; boundary=----formdata',
        'application/xml',
      ] as const) {
        const response = await server.inject({
          method,
          url: '/api/accounts',
          payload: 'x=1',
          headers: { ...CUSTOM_HEADER, 'content-type': contentType, ...HOST },
        });
        expect(response.statusCode, `${method} ${contentType}`).toBe(415);
        expect(response.body, `${method} ${contentType}`).toBe(
          '{"error":{"code":"UNSUPPORTED_MEDIA_TYPE","message":"Content-Type is not supported","details":null}}',
        );
        expect(response.headers['cache-control'], `${method} ${contentType}`).toBe('no-store');
      }
    }
  });

  it('rejects a body with no Content-Type at all', async () => {
    const { server } = buildServer();
    // A payload with no content-type: nothing but the guard would reject
    // it (fastify parses no body without a type), so the 415 here is the
    // guard's alone.
    const withBody = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: '{"label":"a"}',
      headers: { ...CUSTOM_HEADER, ...HOST },
    });
    expect(withBody.statusCode).toBe(415);
    expect(withBody.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
  });

  it('passes a bodiless mutation with the header alone — the transport owns the stray-type shapes', async () => {
    const { server } = buildServer();
    // A bodiless mutation has no payload to type (D-117): the header leg
    // is the requirement, and the request reaches the router.
    const bodiless = await server.inject({
      method: 'DELETE',
      url: '/api/accounts/1',
      headers: { ...CUSTOM_HEADER, ...HOST },
    });
    expect(bodiless.statusCode).toBe(404);
    expect(bodiless.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    // The empirical reason the content-type leg cannot be unconditional:
    // a bodiless request that claims `application/json` is answered by
    // fastify's own empty-body 400 (FST_ERR_CTP_EMPTY_JSON_BODY → the
    // VALIDATION class) — the transport, not this guard, owns that shape.
    const claimedEmpty = await server.inject({
      method: 'DELETE',
      url: '/api/accounts/1',
      headers: { ...CUSTOM_HEADER, 'content-type': 'application/json', ...HOST },
    });
    expect(claimedEmpty.statusCode).toBe(400);
    expect(claimedEmpty.json()).toMatchObject({ error: { code: 'VALIDATION' } });

    // The rest of the bodiless stray-type matrix is the transport's own
    // parser registry (D-117): fastify's default text/plain parser
    // accepts the empty body and the request still routes, while an
    // unregistered type answers fastify's NATIVE 415 — through D-113's
    // handler it is the same envelope the guard produces, which is the
    // byte-identity's purpose (the native mapping stays live behind the
    // guard for exactly these bodiless shapes).
    const strayTextPlain = await server.inject({
      method: 'DELETE',
      url: '/api/accounts/1',
      headers: { ...CUSTOM_HEADER, 'content-type': 'text/plain', ...HOST },
    });
    expect(strayTextPlain.statusCode).toBe(404);
    expect(strayTextPlain.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const strayUnregistered = await server.inject({
      method: 'DELETE',
      url: '/api/accounts/1',
      headers: { ...CUSTOM_HEADER, 'content-type': 'application/xml', ...HOST },
    });
    expect(strayUnregistered.statusCode).toBe(415);
    expect(strayUnregistered.body).toBe(
      '{"error":{"code":"UNSUPPORTED_MEDIA_TYPE","message":"Content-Type is not supported","details":null}}',
    );

    // A non-canonical zero is a body to the transport (verified: fastify
    // demands a content type for `00`), so the guard reads it the same
    // way — fail closed, never a bodiless disagreement between layers.
    const leadingZero = await server.inject({
      method: 'DELETE',
      url: '/api/accounts/1',
      headers: { ...CUSTOM_HEADER, 'content-length': '00', ...HOST },
    });
    expect(leadingZero.statusCode).toBe(415);
    expect(leadingZero.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
  });

  it('outranks the transport classes — and passes them once satisfied', async () => {
    const { server } = buildServer();
    // The ordering pin: a text/plain body answers the guard's 415 before
    // the content-type parser or the body limit could speak, while the
    // same malformed body under application/json passes the guard and
    // reaches the parser's own 400 VALIDATION — proving the 415/403 arms
    // are the guard, not a coincidental status.
    const guardRejected = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: '{"broken',
      headers: { ...CUSTOM_HEADER, 'content-type': 'text/plain', ...HOST },
    });
    expect(guardRejected.statusCode).toBe(415);
    expect(guardRejected.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });

    const parserControl = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: '{"broken',
      headers: { 'x-quotameter-request': '1', 'content-type': 'application/json', ...HOST },
    });
    expect(parserControl.statusCode).toBe(400);
    expect(parserControl.json()).toMatchObject({ error: { code: 'VALIDATION' } });
  });
});

describe('legitimate mutations — pass-through (§15.3)', () => {
  it('passes a fully-headered mutation on to the router, on all four methods', async () => {
    const { server } = buildServer();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const bodied = method !== 'DELETE';
      const response = await server.inject({
        method,
        url: '/api/accounts',
        payload: bodied ? '{}' : undefined,
        headers: bodied ? { ...BODIED_MUTATION_HEADERS, ...HOST } : { ...CUSTOM_HEADER, ...HOST },
      });
      // The scope catch-all's 404 — a class the guard can never produce —
      // is the proof the request passed the guard and was routed.
      expect(response.statusCode, method).toBe(404);
      expect(response.json(), method).toMatchObject({
        error: { code: 'NOT_FOUND', details: { method } },
      });
    }
  });

  it('accepts charset parameters, case, and arbitrary header values', async () => {
    const { server } = buildServer();
    for (const headers of [
      { ...BODIED_MUTATION_HEADERS, 'content-type': 'application/json; charset=utf-8' },
      { ...BODIED_MUTATION_HEADERS, 'content-type': 'APPLICATION/JSON' },
      { ...BODIED_MUTATION_HEADERS, 'x-quotameter-request': '1' },
      { ...BODIED_MUTATION_HEADERS, 'x-quotameter-request': 'x'.repeat(200) },
    ]) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/settings',
        payload: '{}',
        headers: { ...headers, ...HOST },
      });
      expect(response.statusCode, JSON.stringify(headers)).toBe(404);
      expect(response.json(), JSON.stringify(headers)).toMatchObject({
        error: { code: 'NOT_FOUND' },
      });
    }
  });

  it('keeps safe methods untouched — no custom header, hostile content type', async () => {
    const { server } = buildServer();
    const health = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
    });
    expect(health.statusCode).toBe(200);
    expect(health.body).toBe('{"status":"ok"}');
    const unknown = await server.inject({
      method: 'GET',
      url: '/api/unknown',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('interaction with the Origin guard — the layering order (D-115/D-117)', () => {
  it('answers a cross-origin mutation with the Origin verdict, not the header verdict', async () => {
    const { server } = buildServer();
    // Cross-origin AND missing the custom header: the origin guard is
    // registered first, so its reason wins — nothing downstream is
    // consulted for a request an earlier layer already rejected.
    const bothHostile = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: '{}',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json', ...HOST },
    });
    expect(bothHostile.statusCode).toBe(403);
    expect(bothHostile.body).toBe(
      '{"error":{"code":"FORBIDDEN","message":"Cross-origin request rejected","details":{"reason":"origin-mismatch"}}}',
    );

    // Cross-origin with BOTH §15.3 legs satisfied is still rejected —
    // the layers are independent defenses, not alternatives.
    const originHostileOnly = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: '{}',
      headers: { origin: 'https://evil.example', ...BODIED_MUTATION_HEADERS, ...HOST },
    });
    expect(originHostileOnly.statusCode).toBe(403);
    expect(originHostileOnly.json()).toMatchObject({
      error: { details: { reason: 'origin-mismatch' } },
    });
  });

  it('answers a same-origin mutation missing the header with the header verdict', async () => {
    const { server } = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: '{}',
      headers: {
        origin: 'http://127.0.0.1:8787',
        'content-type': 'application/json',
        ...HOST,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'The X-Quotameter-Request header is required',
        details: { reason: 'missing-custom-header' },
      },
    });
  });
});

describe('mode independence — the guard with static serving active (D-113 lesson)', () => {
  it('answers identical rejections while the SPA keeps serving', async () => {
    const dist = await makeDistFixture();
    try {
      const { server } = buildServer(dist.path);
      const missingHeader = await server.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: '{}',
        headers: { 'content-type': 'application/json', ...HOST },
      });
      expect(missingHeader.statusCode).toBe(403);
      expect(missingHeader.body).toBe(
        '{"error":{"code":"FORBIDDEN","message":"The X-Quotameter-Request header is required","details":{"reason":"missing-custom-header"}}}',
      );
      const wrongType = await server.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: 'x=1',
        headers: { ...CUSTOM_HEADER, 'content-type': 'text/plain', ...HOST },
      });
      expect(wrongType.statusCode).toBe(415);
      // The mode this scope must not disturb: deep links serve the shell.
      const deepLink = await server.inject({ method: 'GET', url: '/accounts' });
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.body).toContain('quotameter-ui');
      const health = await server.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      // Pass-through holds in this mode too (bodied and bodiless).
      const allowedBodied = await server.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: '{}',
        headers: { ...BODIED_MUTATION_HEADERS, ...HOST },
      });
      expect(allowedBodied.statusCode).toBe(404);
      const allowedBodiless = await server.inject({
        method: 'DELETE',
        url: '/api/accounts/1',
        headers: { ...CUSTOM_HEADER, ...HOST },
      });
      expect(allowedBodiless.statusCode).toBe(404);
    } finally {
      await dist.remove();
    }
  });
});

describe('the bare-/api boundary and §15.4/§16 discipline', () => {
  it('keeps the bare /api at the root not-found arm — the documented boundary', async () => {
    // The scope's routes (guards included) need a trailing segment; the
    // bare `/api` is no endpoint at all, so routing itself answers — the
    // boundary task 149 pinned, unchanged by the second guard.
    const { server } = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api',
      headers: { ...HOST },
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

  it('echoes no attacker-controlled header value in the envelope (§15.4)', async () => {
    const { server } = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: 'x=<script>',
      headers: {
        'x-quotameter-request': '<script>alert(1)</script>',
        'content-type': 'text/plain; x=<script>',
        ...HOST,
      },
    });
    // A non-empty header value passes presence; the body's content type
    // rejects, and nothing the client sent appears in the envelope.
    expect(response.statusCode).toBe(415);
    expect(response.body).not.toContain('<script>');
    expect(response.body).not.toContain('alert');
  });

  it('logs nothing for either rejection class — §16 level discipline', async () => {
    const { server, sink } = buildServer();
    const baseline = sink.records().length;
    await server.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: '{}',
      headers: { 'content-type': 'application/json', ...HOST },
    });
    await server.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: 'x=1',
      headers: { ...CUSTOM_HEADER, 'content-type': 'text/plain', ...HOST },
    });
    await server.inject({
      method: 'DELETE',
      url: '/api/accounts/1',
      headers: { ...CUSTOM_HEADER, ...HOST },
    });
    // Both rejection classes are 4xx: nothing to diagnose server-side.
    expect(sink.records().length).toBe(baseline);
  });
});
