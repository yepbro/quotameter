import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  buildHttpServer,
  createHttpServerComponent,
  type HttpServerComponent,
} from '../../src/server/http';
import { HealthResponseSchema } from '../../src/schemas/api/health';
import { createLogger, type Logger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';

/**
 * The public health response (task 147, spec §13, §15.1, §15.5; decision
 * D-111): unauthenticated `GET /api/health` answers with the byte-exact
 * literal `{"status":"ok"}` — no versions, uptime, memory, storage state,
 * account data, errors, or timestamps — and stays public in every auth mode
 * (nothing here consults credentials; the request-security tasks 149–152 are
 * bound by §13's "except the public health response").
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
    // §15.5: `Cache-Control: no-store` for API responses — route-scoped
    // here until task 158's global security-header pass.
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
      const response = await server.inject({ method, url: '/api/health' });
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
