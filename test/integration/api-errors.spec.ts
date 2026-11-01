import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { buildHttpServer, HTTP_BODY_LIMIT_BYTES } from '../../src/server/http';
import { ApiError } from '../../src/server/api/error';
import { createLogger, type Logger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { createTempDir, type TempDir } from '../helpers/isolation';

/**
 * The common API error envelope (task 148, spec §13, §15.4, §15.5, §16;
 * decision D-113): every error the server produces — the not-found 404s, the
 * native fastify validation/transport errors, thrown application errors —
 * answers the one `error.code/message/details` shape with stable codes,
 * byte-pinned here against the real task-146 construction
 * (`buildHttpServer` + `fastify.inject`, no sockets). The internal class is
 * generic on the wire and carries the real cause only into the §16 log; the
 * auth classes are representable before mode selection lands (task 152) via
 * the `ApiError` extension point, driven here by test-only routes.
 */

/** Every Fastify instance this test file had a hand in creating. */
const openServers: FastifyInstance[] = [];

/**
 * Builds the real construction with test-only routes registered before the
 * boot — the D-111 serializer-block precedent, now on the full task-146
 * stack so the root-scope error handler is exactly the production wiring.
 */
function buildServer(): { server: FastifyInstance; sink: MemoryLogSink } {
  const sink = createMemoryLogSink();
  const logger: Logger = createLogger({ level: 'warn', destination: sink });
  const server = buildHttpServer({ host: '127.0.0.1', port: 0, logger });

  // Validation target: a TypeBox querystring schema like every §13 route
  // will carry (fastify compiles it through Ajv and rejects ?n=abc).
  server.get(
    '/api/test/validate',
    {
      schema: {
        querystring: Type.Object({ n: Type.Number() }, { additionalProperties: false }),
      },
    },
    async () => ({ ok: true }),
  );

  // The auth-class extension points (§15.1's classes; the modes land in 152).
  server.get('/api/test/unauthenticated', async () => {
    throw new ApiError('UNAUTHENTICATED');
  });
  server.get('/api/test/forbidden', async () => {
    throw new ApiError('FORBIDDEN', {
      message: 'Remote access requires a password; run quotameter passwd',
      details: { reason: 'proxy-headers-without-password' },
    });
  });
  // A route-level not-found: the resource shape exists, the id does not.
  server.get('/api/test/accounts/:id', async (request) => {
    throw new ApiError('NOT_FOUND', {
      message: 'Account not found',
      details: { accountId: (request.params as { id: string }).id },
    });
  });

  // The internal class: an unknown error whose message carries the exact
  // shapes §15.4 forbids on the wire (a path, a secret-looking token).
  server.get('/api/test/boom', async () => {
    throw new Error('connect ENOENT /home/brooks/.config/quotameter (token=sk-secret-123)');
  });
  server.get('/api/test/foreign-status', async () => {
    const error = new Error('conflict');
    (error as Error & { statusCode?: number }).statusCode = 409;
    throw error;
  });

  // A JSON-body target for the native transport classes.
  server.post('/api/test/echo', async () => ({ ok: true }));

  // A param route for the router-level URI bounds (fastify's default
  // maxParamLength is 100; a longer segment reaches the frameworkErrors
  // callback the construction wires to the shared handler).
  server.get('/api/test/p/:id', async () => ({ ok: true }));

  // Scope inheritance: an error thrown inside a registered plugin scope
  // (where the 159+ endpoint routes will live) must reach the root handler.
  server.register(
    async (scope) => {
      scope.get('/scoped-boom', async () => {
        throw new Error('scoped secret /home/brooks failure');
      });
    },
    { prefix: '/api/test-scope' },
  );

  openServers.push(server);
  return { server, sink };
}

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await server.close().catch(() => undefined);
  }
});

/**
 * A built-UI fixture: `index.html` plus one asset; `withoutIndex` builds the
 * partial-build shape (assets only) that must degrade to the envelope.
 */
async function makeDistFixture(withoutIndex = false): Promise<TempDir> {
  const dir = await createTempDir('errors-dist-');
  if (!withoutIndex) {
    await writeFile(join(dir.path, 'index.html'), '<html id="quotameter-ui">shell</html>');
  }
  await writeFile(join(dir.path, 'style.css'), 'body{}');
  return dir;
}

/** The repository root — for a static root that provably does not exist. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('not-found — the envelope at the API boundary (§13)', () => {
  it('answers an unknown API path with the byte-pinned 404 envelope', async () => {
    const { server } = buildServer();
    const response = await server.inject({ method: 'GET', url: '/api/unknown' });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(
      '{"error":{"code":"NOT_FOUND","message":"Not found","details":{"method":"GET","path":"/api/unknown"}}}',
    );
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('answers method mismatches, query forms, and the bare /api path', async () => {
    const { server } = buildServer();
    const post = await server.inject({ method: 'POST', url: '/api/health' });
    expect(post.statusCode).toBe(404);
    expect(post.body).toBe(
      '{"error":{"code":"NOT_FOUND","message":"Not found","details":{"method":"POST","path":"/api/health"}}}',
    );

    const queried = await server.inject({ method: 'GET', url: '/api/unknown?verbose=true' });
    expect(queried.statusCode).toBe(404);
    // The query string never reaches the details — routing failed on the path.
    expect(queried.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Not found',
        details: { method: 'GET', path: '/api/unknown' },
      },
    });

    const bare = await server.inject({ method: 'GET', url: '/api?x=1' });
    expect(bare.statusCode).toBe(404);
    expect(bare.json()).toMatchObject({ error: { code: 'NOT_FOUND', details: { path: '/api' } } });
  });

  it('answers the HEAD twin with the envelope headers — no body on the wire', async () => {
    const { server } = buildServer();
    const response = await server.inject({ method: 'HEAD', url: '/api/unknown' });
    expect(response.statusCode).toBe(404);
    // Inject reflects what the handler sent; the transport owns HEAD
    // bodylessness (Node's http server discards writes for HEAD replies),
    // so the pin here is the envelope's headers — the route-twin case
    // (`GET /api/health`, api-health.spec.ts) covers the stripped-body form.
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('not-found — the boundary stays exact (§13, §14.1)', () => {
  it('keeps the SPA fallback for UI deep links while API paths get the envelope', async () => {
    const dist = await makeDistFixture();
    try {
      const sink = createMemoryLogSink();
      const logger = createLogger({ level: 'warn', destination: sink });
      const server = buildHttpServer({ host: '127.0.0.1', port: 0, logger, staticRoot: dist.path });
      openServers.push(server);

      // `/apiary` is a UI deep link, not an API path — a string prefix would 404 it.
      const lookalike = await server.inject({ method: 'GET', url: '/apiary' });
      expect(lookalike.statusCode).toBe(200);
      expect(lookalike.body).toContain('quotameter-ui');

      const deepLink = await server.inject({ method: 'GET', url: '/accounts' });
      expect(deepLink.statusCode).toBe(200);

      const api = await server.inject({ method: 'GET', url: '/api/unknown' });
      expect(api.statusCode).toBe(404);
      expect(api.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    } finally {
      await dist.remove();
    }
  });

  it('answers non-API 404s with the envelope in API-only mode — one shape, not two', async () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'warn', destination: sink });
    const server = buildHttpServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      staticRoot: join(REPO_ROOT, 'no-such-dist-directory'),
    });
    openServers.push(server);
    const response = await server.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Not found',
        details: { method: 'GET', path: '/' },
      },
    });
  });
});

describe('validation — fastify schema errors normalized (§13)', () => {
  it('accepts a valid request and rejects an invalid value with pinned details', async () => {
    const { server } = buildServer();
    const ok = await server.inject({ method: 'GET', url: '/api/test/validate?n=5' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });

    const invalid = await server.inject({ method: 'GET', url: '/api/test/validate?n=abc' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toBe(
      '{"error":{"code":"VALIDATION","message":"Request validation failed","details":{"validation":[{"where":"querystring","path":"/n","message":"must be number"}]}}}',
    );
    expect(invalid.headers['cache-control']).toBe('no-store');
  });

  it('reports a missing required value with the root path', async () => {
    const { server } = buildServer();
    const missing = await server.inject({ method: 'GET', url: '/api/test/validate' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({
      error: {
        code: 'VALIDATION',
        message: 'Request validation failed',
        details: {
          validation: [
            { where: 'querystring', path: '', message: "must have required property 'n'" },
          ],
        },
      },
    });
  });
});

describe('transport classes — native fastify errors normalized (§15.5)', () => {
  it('answers an over-limit body with the byte-pinned 413 envelope', async () => {
    const { server } = buildServer();
    const overLimit = `"${'x'.repeat(HTTP_BODY_LIMIT_BYTES - 1)}"`; // 65 537 bytes
    const response = await server.inject({
      method: 'POST',
      url: '/api/test/echo',
      payload: overLimit,
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(413);
    expect(response.body).toBe(
      '{"error":{"code":"PAYLOAD_TOO_LARGE","message":"Request body exceeds the 64 KiB limit","details":null}}',
    );
  });

  it('answers malformed JSON, empty JSON bodies, and content-length mismatches with VALIDATION', async () => {
    const { server } = buildServer();
    const malformed = await server.inject({
      method: 'POST',
      url: '/api/test/echo',
      payload: '{"broken',
      headers: { 'content-type': 'application/json' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      error: { code: 'VALIDATION', message: 'Request validation failed', details: null },
    });

    const empty = await server.inject({
      method: 'POST',
      url: '/api/test/echo',
      payload: '',
      headers: { 'content-type': 'application/json' },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: { code: 'VALIDATION' } });

    const mismatched = await server.inject({
      method: 'POST',
      url: '/api/test/echo',
      payload: 'ab',
      headers: { 'content-type': 'application/json', 'content-length': '5' },
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toMatchObject({ error: { code: 'VALIDATION' } });
  });

  it('answers an unregistered content type with the 415 envelope', async () => {
    const { server } = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/test/echo',
      payload: '<a/>',
      headers: { 'content-type': 'application/xml' },
    });
    expect(response.statusCode).toBe(415);
    expect(response.body).toBe(
      '{"error":{"code":"UNSUPPORTED_MEDIA_TYPE","message":"Content-Type is not supported","details":null}}',
    );
  });
});

describe('router-level failures — the frameworkErrors path (§13, D-113 review fix)', () => {
  it('answers a malformed percent-escape path with the VALIDATION envelope, not the framework body', async () => {
    const { server, sink } = buildServer();
    const baseline = sink.records().length;
    const response = await server.inject({ method: 'GET', url: '/api/%zz' });
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(
      '{"error":{"code":"VALIDATION","message":"Request validation failed","details":null}}',
    );
    expect(response.headers['cache-control']).toBe('no-store');
    // A truncated multi-byte escape is the same router-level rejection.
    const utf8 = await server.inject({ method: 'GET', url: '/api/%E0%A4%A' });
    expect(utf8.statusCode).toBe(400);
    expect(utf8.json()).toEqual({
      error: { code: 'VALIDATION', message: 'Request validation failed', details: null },
    });
    // A client mistake is not logged (§16).
    expect(sink.records().length).toBe(baseline);
  });

  it('answers an over-long route parameter with the URI_TOO_LONG envelope', async () => {
    // API-only mode: the failed param match lands in the /api scope's
    // catch-all route, which re-derives the 414 class from the path (the
    // same envelope the router's own FST_ERR_MAX_PARAM_LENGTH would map
    // to — the class is mode-independent by design; the static-mode twin
    // is pinned below, post-verification fix).
    const { server, sink } = buildServer();
    const baseline = sink.records().length;
    const response = await server.inject({
      method: 'GET',
      url: `/api/test/p/${'x'.repeat(150)}`,
    });
    expect(response.statusCode).toBe(414);
    expect(response.json()).toEqual({
      error: { code: 'URI_TOO_LONG', message: 'The request URI is too long', details: null },
    });
    // The bound governs every method — the catch-all is method-wide, so a
    // non-GET over-long param cannot fall out to a mode-split 404.
    for (const method of ['POST', 'DELETE'] as const) {
      const other = await server.inject({ method, url: `/api/test/p/${'x'.repeat(150)}` });
      expect(other.statusCode, method).toBe(414);
      expect(other.json(), method).toMatchObject({ error: { code: 'URI_TOO_LONG' } });
    }
    // A segment past the bound is un-routable even with no param route
    // there — the class comes from the path, not from which route missed.
    const unmatched = await server.inject({
      method: 'GET',
      url: `/api/unknown/${'x'.repeat(150)}`,
    });
    expect(unmatched.statusCode).toBe(414);
    expect(unmatched.json()).toMatchObject({ error: { code: 'URI_TOO_LONG' } });
    // The yardstick is the decoded segment (find-my-way decodes params
    // before measuring): a raw-180/decoded-60 escape still routes.
    const decodable = await server.inject({
      method: 'GET',
      url: `/api/test/p/${'%41'.repeat(60)}`,
    });
    expect(decodable.statusCode).toBe(200);
    // A client mistake is not logged (§16).
    expect(sink.records().length).toBe(baseline);
  });

  it('bubbles errors from encapsulated route scopes to the root handler', async () => {
    // The 159+ endpoint routes register inside plugin scopes; the envelope
    // contract holds there through error-handler inheritance (review fix:
    // pinned, not assumed).
    const { server, sink } = buildServer();
    const baseline = sink.records().length;
    const response = await server.inject({ method: 'GET', url: '/api/test-scope/scoped-boom' });
    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(
      '{"error":{"code":"INTERNAL","message":"Internal server error","details":null}}',
    );
    expect(response.body).not.toContain('/home/brooks');
    expect(sink.records().length - baseline).toBe(1);
  });
});

describe('static serving — client rejections contained onto the envelope (D-113 review fix)', () => {
  it('answers a %00 path with FORBIDDEN, never a false 500 or an error record', async () => {
    const dist = await makeDistFixture();
    try {
      const sink = createMemoryLogSink();
      const logger = createLogger({ level: 'warn', destination: sink });
      const server = buildHttpServer({ host: '127.0.0.1', port: 0, logger, staticRoot: dist.path });
      openServers.push(server);

      // Assets still serve through the contained scope.
      const asset = await server.inject({ method: 'GET', url: '/style.css' });
      expect(asset.statusCode).toBe(200);

      // A path the static layer actually serves: send's null-byte
      // rejection (a foreign 403) is contained onto FORBIDDEN — never a
      // false 500 or an error record.
      const deepLink = await server.inject({ method: 'GET', url: '/deep%00link' });
      expect(deepLink.statusCode).toBe(403);
      expect(deepLink.json()).toEqual({
        error: { code: 'FORBIDDEN', message: 'Forbidden', details: null },
      });
      expect(deepLink.headers['cache-control']).toBe('no-store');

      // An API-prefixed miss never reaches the static layer anymore — the
      // /api scope's catch-all owns it in every mode (D-113
      // post-verification fix): the null byte just makes it unmatched, and
      // API-only mode answers the same envelope (no mode split).
      const apiMiss = await server.inject({ method: 'GET', url: '/api/x%00' });
      expect(apiMiss.statusCode).toBe(404);
      expect(apiMiss.json()).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Not found',
          details: { method: 'GET', path: '/api/x%00' },
        },
      });
      // A client-rejected path logs nothing (§16) — the uncontained shape
      // answered 500 INTERNAL plus one error-level record per request.
      expect(sink.records()).toHaveLength(0);
    } finally {
      await dist.remove();
    }
  });

  it('answers a malformed percent-escape path with the envelope in static mode too', async () => {
    // Pinned in both modes: the router rejects the path before any scope —
    // static or API — sees it, so `frameworkErrors` must carry the envelope
    // there exactly as it does in API-only mode.
    const dist = await makeDistFixture();
    try {
      const sink = createMemoryLogSink();
      const logger = createLogger({ level: 'warn', destination: sink });
      const server = buildHttpServer({ host: '127.0.0.1', port: 0, logger, staticRoot: dist.path });
      openServers.push(server);

      const response = await server.inject({ method: 'GET', url: '/api/%zz' });
      expect(response.statusCode).toBe(400);
      expect(response.body).toBe(
        '{"error":{"code":"VALIDATION","message":"Request validation failed","details":null}}',
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(sink.records()).toHaveLength(0);
    } finally {
      await dist.remove();
    }
  });

  it('answers the over-long-parameter classes identically in static mode (mode matrix)', async () => {
    // Post-verification regression pin: find-my-way reports an over-long
    // route parameter (FST_ERR_MAX_PARAM_LENGTH, the 414 class) only when
    // the failed match leaves the router no other candidate — with the
    // static wildcard present it rescued those requests into a plain 404,
    // so the class was mode-dependent until the /api scope owned its
    // unmatched arm as a route (D-113 fix).
    const dist = await makeDistFixture();
    try {
      const sink = createMemoryLogSink();
      const logger = createLogger({ level: 'warn', destination: sink });
      const server = buildHttpServer({ host: '127.0.0.1', port: 0, logger, staticRoot: dist.path });
      openServers.push(server);

      // The SPA fallback keeps serving its own paths in this mode.
      const deepLink = await server.inject({ method: 'GET', url: '/accounts' });
      expect(deepLink.statusCode).toBe(200);

      for (const method of ['GET', 'POST', 'DELETE'] as const) {
        const response = await server.inject({
          method,
          url: `/api/test/p/${'x'.repeat(150)}`,
        });
        expect(response.statusCode, method).toBe(414);
        expect(response.json(), method).toEqual({
          error: { code: 'URI_TOO_LONG', message: 'The request URI is too long', details: null },
        });
        expect(response.headers['cache-control'], method).toBe('no-store');
      }
      // The no-param-route arm of the same class, in this mode too.
      const unmatched = await server.inject({
        method: 'GET',
        url: `/api/unknown/${'x'.repeat(150)}`,
      });
      expect(unmatched.statusCode).toBe(414);
      expect(unmatched.json()).toMatchObject({ error: { code: 'URI_TOO_LONG' } });
      // §16: client mistakes log nothing.
      expect(sink.records()).toHaveLength(0);
    } finally {
      await dist.remove();
    }
  });

  it('degrades a partial build (assets, no index.html) to the envelope 404', async () => {
    const dist = await makeDistFixture(true);
    try {
      const sink = createMemoryLogSink();
      const logger = createLogger({ level: 'warn', destination: sink });
      const server = buildHttpServer({ host: '127.0.0.1', port: 0, logger, staticRoot: dist.path });
      openServers.push(server);

      const asset = await server.inject({ method: 'GET', url: '/style.css' });
      expect(asset.statusCode).toBe(200);

      // The SPA fallback must not sendFile a missing index (fastify would
      // answer a plain-text basic 404 plus a warn line inside the handler).
      const deepLink = await server.inject({ method: 'GET', url: '/accounts' });
      expect(deepLink.statusCode).toBe(404);
      expect(deepLink.json()).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Not found',
          details: { method: 'GET', path: '/accounts' },
        },
      });
      expect(sink.records()).toHaveLength(0);
    } finally {
      await dist.remove();
    }
  });
});

describe('auth-class errors — representable before mode selection (§15.1, task 152)', () => {
  it('carries a thrown UNAUTHENTICATED ApiError as the byte-pinned 401 envelope', async () => {
    const { server } = buildServer();
    const response = await server.inject({ method: 'GET', url: '/api/test/unauthenticated' });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe(
      '{"error":{"code":"UNAUTHENTICATED","message":"Authentication required","details":null}}',
    );
  });

  it('carries a FORBIDDEN ApiError with its custom message and details', async () => {
    const { server } = buildServer();
    const response = await server.inject({ method: 'GET', url: '/api/test/forbidden' });
    expect(response.statusCode).toBe(403);
    expect(response.body).toBe(
      '{"error":{"code":"FORBIDDEN","message":"Remote access requires a password; run quotameter passwd","details":{"reason":"proxy-headers-without-password"}}}',
    );
  });

  it('carries a route-level NOT_FOUND ApiError — the resource class of the 404 family', async () => {
    const { server } = buildServer();
    const response = await server.inject({ method: 'GET', url: '/api/test/accounts/missing-one' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Account not found',
        details: { accountId: 'missing-one' },
      },
    });
  });
});

describe('internal — generic on the wire, real cause in the log (§15.4, §16)', () => {
  it('answers an unknown thrown error with the byte-pinned generic 500', async () => {
    const { server, sink } = buildServer();
    // The construction-time "no built UI" warn is the baseline, not traffic.
    const baseline = sink.records().length;
    const response = await server.inject({ method: 'GET', url: '/api/test/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(
      '{"error":{"code":"INTERNAL","message":"Internal server error","details":null}}',
    );
    // §15.4/§13: neither the message nor the stack — nothing it carried.
    expect(response.body).not.toContain('/home/brooks');
    expect(response.body).not.toContain('sk-secret-123');
    expect(response.body).not.toContain('ENOENT');

    // §16: the real cause, server-side only, through the redacting logger —
    // exactly one record, at error, with type/message/stack under `err`.
    expect(sink.records().length - baseline).toBe(1);
    const record = sink.records().at(-1)!;
    expect(record.level).toBe(50);
    expect(record.msg).toBe('request failed with an internal error');
    const err = record.err as { message?: string; stack?: string; type?: string };
    expect(err.type).toBe('Error');
    expect(err.message).toBe(
      'connect ENOENT /home/brooks/.config/quotameter (token=sk-secret-123)',
    );
    expect(typeof err.stack).toBe('string');
  });

  it('logs nothing for the 4xx classes — §16 level discipline', async () => {
    const { server, sink } = buildServer();
    const baseline = sink.records().length;
    await server.inject({ method: 'GET', url: '/api/unknown' });
    await server.inject({ method: 'GET', url: '/api/test/validate?n=abc' });
    await server.inject({ method: 'GET', url: '/api/test/unauthenticated' });
    await server.inject({
      method: 'POST',
      url: '/api/test/echo',
      payload: 'x'.repeat(HTTP_BODY_LIMIT_BYTES),
      headers: { 'content-type': 'application/json' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/test/echo',
      payload: '<a/>',
      headers: { 'content-type': 'application/xml' },
    });
    await server.inject({ method: 'GET', url: '/api/%zz' });
    expect(sink.records().length).toBe(baseline);
  });

  it('resolves a foreign thrown statusCode to INTERNAL — the strict contract (D-113)', async () => {
    const { server } = buildServer();
    const response = await server.inject({ method: 'GET', url: '/api/test/foreign-status' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL' } });
    expect(response.body).not.toContain('conflict');
  });
});
