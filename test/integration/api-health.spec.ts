import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  buildHttpServer,
  createHttpServerComponent,
  type HttpServerComponent,
} from '../../src/server/http';
import { healthRoutes } from '../../src/server/api/health';
import { HealthResponseSchema } from '../../src/schemas/api/health';
import { createLogger, type Logger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';

/**
 * The public health response (task 147, spec §13, §15.1, §15.5; decisions
 * D-111 and D-192): unauthenticated `GET /api/health` answers with the
 * byte-exact literal `{"status":"ok"}` — no versions, uptime, memory,
 * storage state, account data, errors, or timestamps — and stays public in
 * every auth mode (nothing here consults credentials; the
 * request-security tasks 149–152 are bound by §13's "except the public
 * health response"). Since FSM-4 (D-192) the authenticated branch — a
 * request the §15.1 layer would grant — additionally carries the
 * `polling.running` diagnostics through the wired source; every other
 * shape keeps the literal, pinned byte-exactly below.
 *
 * Integration project on purpose: the route is exercised through the full
 * task-146 construction (`buildHttpServer`, `fastify.inject` — no sockets),
 * plus one real ephemeral loopback socket through the lifecycle component,
 * the §17.1 API-testing pattern.
 */

/** Every Fastify instance this test file had a hand in creating. */
const openServers: Array<{ close(): Promise<void> }> = [];

/** Every component whose `start` may have been called. */
const startedComponents: HttpServerComponent[] = [];

/** Builds a server with test defaults and records it for teardown. */
function buildServer(): { server: FastifyInstance; sink: MemoryLogSink } {
  const sink = createMemoryLogSink();
  const logger: Logger = createLogger({ level: 'warn', destination: sink });
  const server = buildHttpServer({ host: '127.0.0.1', port: 0, logger });
  openServers.push(server);
  return { server, sink };
}

afterEach(async () => {
  // Components first (a close through them also closes the server), then
  // any bare instance; fastify resolves a close of an already-closed server.
  for (const component of startedComponents.splice(0)) {
    await component.stop().catch(() => undefined);
  }
  for (const server of openServers.splice(0)) {
    await server.close().catch(() => undefined);
  }
});

describe('GET /api/health — the minimal public response (§13)', () => {
  it('answers unauthenticated with the byte-exact literal and nothing else', async () => {
    const { server, sink } = buildServer();
    // The injection carries no Authorization header and no cookie: the
    // request is unauthenticated by construction.
    const response = await server.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    // Byte-pinned: the whole response is the literal — every diagnostic
    // field (version, uptime, memory, storage, accounts, errors, time) is
    // absent because there is no byte beyond it.
    expect(response.body).toBe('{"status":"ok"}');
    const parsed = response.json();
    expect(parsed).toEqual({ status: 'ok' });
    expect(Object.keys(parsed)).toEqual(['status']);
    // §16 via D-109's gate: the public request logs nothing at warn.
    const messages = sink.records().map((record) => String(record.msg));
    expect(messages).not.toContain('incoming request');
    expect(messages.some((message) => message.includes('request completed'))).toBe(false);
  });

  it('serves JSON with §15.5 no-store', async () => {
    const { server } = buildServer();
    const response = await server.inject({ method: 'GET', url: '/api/health' });
    // The framework's default JSON content type — the spec prescribes no
    // exact value (§13/§15.5); pinned so a Fastify default change is seen.
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    // §15.5: `Cache-Control: no-store` for API responses — the
    // construction's root-scope rule since task 158 (D-127); the
    // route-scoped header this suite pinned between tasks 147 and 158
    // is gone, generalized.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('ignores query strings — no diagnostic mode hides behind parameters', async () => {
    const { server } = buildServer();
    for (const url of [
      '/api/health',
      '/api/health?verbose=true&diagnostics=true',
      '/api/health?status=full',
    ]) {
      const response = await server.inject({ method: 'GET', url });
      expect(response.statusCode, `GET ${url}`).toBe(200);
      expect(response.body, `GET ${url}`).toBe('{"status":"ok"}');
    }
  });

  it('answers the same body with credentials present — nothing to authenticate yet', async () => {
    // Tasks 152–155 add authentication; this pins the route's today
    // contract: no credential changes the answer, because nothing on it
    // consults credentials (§13's "except the public health response").
    const { server } = buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization: 'Bearer not-a-real-token', cookie: 'session=none' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"status":"ok"}');
  });
});

describe('GET /api/health — routing edges (§13)', () => {
  it('keeps the route GET-only: other methods get the §13 error envelope', async () => {
    const { server } = buildServer();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      // The bodiless mutation carries task 150's dedicated header so the
      // §15.3 guards pass it and the routing verdict is what answers.
      const response = await server.inject({
        method,
        url: '/api/health',
        headers: { 'x-quotameter-request': 'quotameter-ui' },
      });
      expect(response.statusCode, method).toBe(404);
      // Task 148's §13 envelope (D-113), byte-pinned in api-errors.spec.ts.
      expect(response.json(), method).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Not found',
          details: { method, path: '/api/health' },
        },
      });
    }
  });

  it('answers the auto-exposed HEAD twin with headers only — no body can leak', async () => {
    // Fastify's default `exposeHeadRoute` derives HEAD from GET: same
    // handler, same headers, discarded body.
    const { server } = buildServer();
    const response = await server.inject({ method: 'HEAD', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('matches the path exactly — the trailing-slash variant is not the endpoint', async () => {
    const { server } = buildServer();
    const response = await server.inject({ method: 'GET', url: '/api/health/' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('GET /api/health — the authenticated polling diagnostics (§13, FSM-4/D-192)', () => {
  /**
   * Builds a server with the diagnostics source wired — the shape the
   * production composition registers (`routes.health.polling.running`).
   * `running` and the §15.1 facts are per-test; the credential seam
   * defaults to fail-closed false exactly as an unwired seam would.
   */
  function buildDiagnosticsServer(options: {
    readonly running: () => boolean;
    readonly mode?: 'auto' | 'required';
    readonly passwordConfigured?: () => boolean;
    readonly isAuthenticated?: (request: unknown) => boolean | Promise<boolean>;
  }): { server: FastifyInstance; sink: MemoryLogSink } {
    const sink = createMemoryLogSink();
    const logger: Logger = createLogger({ level: 'warn', destination: sink });
    const server = buildHttpServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      ...(options.mode === undefined && options.passwordConfigured === undefined
        ? {}
        : {
            auth: {
              ...(options.mode === undefined ? {} : { mode: options.mode }),
              ...(options.passwordConfigured === undefined
                ? {}
                : { passwordConfigured: options.passwordConfigured }),
              ...(options.isAuthenticated === undefined
                ? {}
                : { isAuthenticated: options.isAuthenticated }),
            },
          }),
      routes: { health: { polling: { running: options.running } } },
    });
    openServers.push(server);
    return { server, sink };
  }

  it('grants the diagnostics on the §15.1 not-required cell — both running values', async () => {
    // Auto mode, loopback bind, no proxy indication: the local operator's
    // trust cell — the same boundary that serves /api/status without a
    // password. The diagnostics ride the authenticated branch; the body
    // is the literal plus exactly the declared block.
    for (const running of [true, false]) {
      const { server } = buildDiagnosticsServer({ running: () => running });
      const response = await server.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode, `running=${running}`).toBe(200);
      expect(response.body, `running=${running}`).toBe(
        `{"status":"ok","polling":{"running":${running}}}`,
      );
      const parsed = response.json();
      expect(Object.keys(parsed)).toEqual(['status', 'polling']);
      expect(parsed).toEqual({ status: 'ok', polling: { running } });
    }
  });

  it('reads the source per request — the value never goes stale behind a cached response', async () => {
    let running = true;
    const { server } = buildDiagnosticsServer({ running: () => running });
    const first = await server.inject({ method: 'GET', url: '/api/health' });
    expect(first.body).toBe('{"status":"ok","polling":{"running":true}}');
    // The engine dies between the two probes; the next granted request
    // reports the death — the audit's dead-state finding made observable.
    running = false;
    const second = await server.inject({ method: 'GET', url: '/api/health' });
    expect(second.body).toBe('{"status":"ok","polling":{"running":false}}');
  });

  it('grants the diagnostics in required mode through the credential seam', async () => {
    const { server } = buildDiagnosticsServer({
      running: () => false,
      mode: 'required',
      passwordConfigured: () => true,
      isAuthenticated: () => true, // the session the guard itself would accept
    });
    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: 'quotameter-session=valid-session-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"status":"ok","polling":{"running":false}}');
  });

  it('keeps the byte-exact literal when the credential seam refuses (required mode)', async () => {
    // No session cookie, a garbage cookie, and a seam that rejects the
    // presented cookie all collapse to the same public body — the §15.1
    // layer would not grant this request any protected route, so the
    // diagnostics are not its to see (D-124's indistinguishable-absence
    // rule, mirrored at this route).
    for (const headers of [
      {},
      { cookie: 'quotameter-session=garbage' },
      { authorization: 'Bearer not-a-real-token' },
    ]) {
      const { server } = buildDiagnosticsServer({
        running: () => false,
        mode: 'required',
        passwordConfigured: () => true,
        isAuthenticated: () => false,
      });
      const response = await server.inject({ method: 'GET', url: '/api/health', headers });
      expect(response.statusCode, JSON.stringify(headers)).toBe(200);
      expect(response.body, JSON.stringify(headers)).toBe('{"status":"ok"}');
    }
  });

  it('keeps the byte-exact literal for the passwordless proxied request — fail-closed', async () => {
    // §15.1's proxy-without-password cell: a protected route would answer
    // the 403-instructions envelope; health stays public (D-121) and the
    // diagnostics stay away — no password is configured, so no session
    // can exist for the fail-closed seam to accept.
    const { server } = buildDiagnosticsServer({ running: () => true });
    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"status":"ok"}');
  });

  it('refuses the passwordless proxied request even when the seam would accept — structural (review P1)', async () => {
    // The seam is NOT consulted on this verdict — the guard's own table
    // 403s the cell without any credential question, and the grant rule
    // mirrors it structurally. The reachable production shape: the hash
    // is a live fact (a hand-edit removing it does not revoke existing
    // session rows), so a proxied request with a still-valid cookie must
    // still learn nothing beyond the public literal.
    const { server } = buildDiagnosticsServer({
      running: () => true,
      isAuthenticated: () => true, // a seam that would accept anything
    });
    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-forwarded-for': '203.0.113.7', cookie: 'quotameter-session=still-valid' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"status":"ok"}');
  });

  it('requires the session once a proxied request faces a password (auto mode)', async () => {
    // Auto + loopback + proxy indication + a configured password: the
    // §15.1 verdict flips to required, so the seam decides — granted with
    // a valid session, the literal without one.
    const granted = await buildDiagnosticsServer({
      running: () => true,
      passwordConfigured: () => true,
      isAuthenticated: () => true,
    }).server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-forwarded-for': '203.0.113.7', cookie: 'quotameter-session=valid' },
    });
    expect(granted.body).toBe('{"status":"ok","polling":{"running":true}}');
    const refused = await buildDiagnosticsServer({
      running: () => true,
      passwordConfigured: () => true,
      isAuthenticated: () => false,
    }).server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(refused.body).toBe('{"status":"ok"}');
  });

  it('keeps the HEAD twin bodyless on the granted branch — nothing can leak', async () => {
    const { server } = buildDiagnosticsServer({ running: () => true });
    const response = await server.inject({ method: 'HEAD', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('GET /api/health — the live listener (§5.6)', () => {
  it('answers through a real ephemeral loopback socket', async () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({ level: 'warn', destination: sink });
    const component = createHttpServerComponent({ host: '127.0.0.1', port: 0, logger });
    openServers.push(component.server);
    startedComponents.push(component);
    await component.start();
    const address = component.server.server.address() as AddressInfo;

    const { status, body } = await httpGet(`http://127.0.0.1:${address.port}/api/health`);
    expect(status).toBe(200);
    expect(body).toBe('{"status":"ok"}');

    await component.stop();
    expect(component.server.server.address()).toBeNull();
  });
});

describe('the schema-compiled serializer — the structural leak guard (D-111)', () => {
  it('emits the byte-exact literal whatever the handler result carries', async () => {
    // Validation and serialization are different engines: the Ajv suite
    // pins the schema's closed-object contract, this block pins the wire —
    // a test-only route carrying the same `HealthResponseSchema`, driven
    // with handler results a future edit could plausibly return. The
    // compiled serializer drops every undeclared key and the `const`
    // literal emits 'ok' regardless of the input value (verified on the
    // pinned runtime — fast-json-stringify 7.2.0), so the wire output is
    // invariant: diagnostics cannot leak through this schema at all.
    const app = Fastify();
    openServers.push(app);
    const hostileResults: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['extra', { status: 'ok', uptime: 42, version: '9.9.9', memory: { rss: 1 }, db: 'corrupt' }],
      ['wrong', { status: 'degraded' }],
      ['hostile', { diagnostics: { everything: true }, status: 'bad' }],
    ];
    for (const [path, payload] of hostileResults) {
      app.get(
        `/${path}`,
        { schema: { response: { 200: HealthResponseSchema } } },
        async () => payload,
      );
    }
    await app.ready();
    for (const [path] of hostileResults) {
      const response = await app.inject({ method: 'GET', url: `/${path}` });
      expect(response.statusCode, path).toBe(200);
      expect(response.body, path).toBe('{"status":"ok"}');
    }
  });
});

describe('healthRoutes registration — the fail-fast wiring guards (D-192)', () => {
  it('refuses a diagnostics source whose reader is not a function', async () => {
    const app = Fastify();
    openServers.push(app);
    await expect(
      app.register(healthRoutes, {
        polling: { running: 'not-a-function' as never },
        authMode: { mode: 'auto', bindHost: '127.0.0.1' },
      }),
    ).rejects.toThrow(/polling\.running/u);
  });

  it('refuses a diagnostics source without the §15.1 facts', async () => {
    // Diagnostics without the grant rule would be a wiring bug: the
    // registration refuses loudly rather than diagnosing everyone.
    const app = Fastify();
    openServers.push(app);
    await expect(app.register(healthRoutes, { polling: { running: () => true } })).rejects.toThrow(
      /authMode/u,
    );
  });
});

/** One real loopback GET; resolves with status and body, rejects on errors. */
function httpGet(url: string): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    request.on('error', reject);
  });
}
