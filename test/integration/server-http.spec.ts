import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QuotameterApp, type LifecycleEvent } from '../../src/server/app';
import {
  buildHttpServer,
  createHttpServerComponent,
  HTTP_BODY_LIMIT_BYTES,
  HTTP_CONNECTION_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  RequestLoggingGate,
  resolveUiDistDir,
  type HttpServerComponent,
  type HttpServerOptions,
} from '../../src/server/http';
import type { FastifyInstance } from 'fastify';
import { runServer } from '../../src/server/main';
import { MAX_DRAIN_TIMEOUT_MS } from '../../src/server/shutdown';
import { createLogger, type LadderLevel, type Logger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { createTempDir, type TempDir } from '../helpers/isolation';

/**
 * Fastify server construction (task 146, spec §3, §13, §15.5; decision
 * D-109): every construction item — plugin set, request-body limit,
 * connection/request timeouts, static serving with the SPA fallback, and
 * the `/api` route seam — is pinned here, plus the lifecycle behavior of
 * the `http-listener` component in the application shell: `fastify.inject`
 * answers without sockets, real loopback sockets serve the constructed
 * shell, and `QuotameterApp`/`runServer` (the U-018/U-022 contracts) start
 * and stop it cleanly, including the §5.6 bounded forced close.
 *
 * Integration project on purpose: the lifecycle parts bind real (ephemeral,
 * loopback-only) sockets, and the no-network guard permits loopback.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** A logger plus the sink capturing every record it emits. */
function makeLogger(level: LadderLevel = 'warn'): { logger: Logger; sink: MemoryLogSink } {
  const sink = createMemoryLogSink();
  return { logger: createLogger({ level, destination: sink }), sink };
}

/** Overrides for the test builders: any server option, or the log level. */
type BuildOverrides = Partial<Omit<HttpServerOptions, 'logger'>> & { level?: LadderLevel };

/** Every Fastify instance this test file had a hand in creating. */
const openServers: Array<{ close(): Promise<void> }> = [];

/** Builds a server with test defaults and records it for teardown. */
function buildServer(overrides: BuildOverrides = {}) {
  const { level = 'warn', ...rest } = overrides;
  const { logger, sink } = makeLogger(level);
  const server = buildHttpServer({
    host: '127.0.0.1',
    port: 0,
    logger,
    ...rest,
  });
  openServers.push(server);
  return { server, sink };
}

/** Every component whose `start` may have been called. */
const startedComponents: HttpServerComponent[] = [];

/** Builds a component with test defaults and records it for teardown. */
function buildComponent(overrides: BuildOverrides = {}): {
  component: HttpServerComponent;
  sink: MemoryLogSink;
} {
  const { level = 'warn', ...rest } = overrides;
  const { logger, sink } = makeLogger(level);
  const component = createHttpServerComponent({ host: '127.0.0.1', port: 0, logger, ...rest });
  openServers.push(component.server);
  startedComponents.push(component);
  return { component, sink };
}

/**
 * Firing these after a failed test settles any `runServer` promise still
 * pending, so its keep-alive interval cannot hang the worker — the
 * server-main suite's deferred-shutdown pattern.
 */
const shutdownTriggers: Array<() => void> = [];

/** A built-UI fixture: `index.html` plus one hashed-style asset. */
async function makeDistFixture(): Promise<TempDir> {
  const dir = await createTempDir('http-dist-');
  await writeFile(join(dir.path, 'index.html'), '<html id="quotameter-ui">shell</html>');
  await writeFile(join(dir.path, 'app-0123.js'), 'console.log("app")');
  return dir;
}

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

afterEach(async () => {
  // Components first (a close through them also closes the server), then
  // any bare instance; fastify resolves a close of an already-closed server.
  for (const component of startedComponents.splice(0)) {
    await component.stop().catch(() => undefined);
  }
  for (const server of openServers.splice(0)) {
    await server.close().catch(() => undefined);
  }
  // Settle any still-pending runServer before restoring the spied APIs.
  for (const trigger of shutdownTriggers.splice(0)) trigger();
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.restoreAllMocks();
});

describe('buildHttpServer — construction pins (§3, §15.5)', () => {
  it('configures the request-body limit and the connection/request timeouts', () => {
    const { server } = buildServer();
    // `requestTimeout` is applied by the factory but missing from fastify's
    // `initialConfig` typings — read it through the runtime shape.
    const initial = server.initialConfig as typeof server.initialConfig & {
      requestTimeout?: number;
    };
    expect(server.initialConfig.bodyLimit).toBe(HTTP_BODY_LIMIT_BYTES);
    expect(HTTP_BODY_LIMIT_BYTES).toBe(65_536);
    expect(initial.requestTimeout).toBe(HTTP_REQUEST_TIMEOUT_MS);
    expect(server.initialConfig.connectionTimeout).toBe(HTTP_CONNECTION_TIMEOUT_MS);
    expect(server.initialConfig.keepAliveTimeout).toBe(HTTP_KEEP_ALIVE_TIMEOUT_MS);
    expect(server.initialConfig.forceCloseConnections).toBe('idle');
  });

  it('enforces the 64 KiB body limit on injected requests', async () => {
    const { server } = buildServer();
    const atLimit = `"${'x'.repeat(HTTP_BODY_LIMIT_BYTES - 2)}"`; // exactly 65 536 bytes
    const overLimit = `"${'x'.repeat(HTTP_BODY_LIMIT_BYTES - 1)}"`; // 65 537 bytes
    const atLimitResponse = await server.inject({
      method: 'POST',
      url: '/api/unknown',
      payload: atLimit,
      headers: {
        // Task 150's §15.3 mutation headers — scenery for the body-limit
        // arms, keeping the requests past both request-security guards.
        'x-quotameter-request': 'quotameter-ui',
        'content-type': 'application/json',
      },
    });
    expect(atLimitResponse.statusCode).toBe(404); // passed the limit; no route
    const overLimitResponse = await server.inject({
      method: 'POST',
      url: '/api/unknown',
      payload: overLimit,
      headers: {
        'x-quotameter-request': 'quotameter-ui',
        'content-type': 'application/json',
      },
    });
    expect(overLimitResponse.statusCode).toBe(413);
  });

  it('registers the cookie plugin and leaves helmet/rate-limit to their tasks', async () => {
    // Decision D-109: construction owns @fastify/static + @fastify/cookie;
    // @fastify/helmet (158) is declared but deliberately unregistered —
    // pinned so an accidental early registration cannot silently pre-empt
    // that task's configuration. @fastify/rate-limit stays unregistered
    // with no owning task left: §15.2's budget counts *failed* attempts
    // and answers with increasing delays, which a generic per-request 429
    // limiter cannot express — task 156 landed the primitive in
    // src/services/login-rate-limit.ts (D-125) instead, so whether the
    // dependency stays at all is an open maintenance question.
    const { server } = buildServer();
    // Plugin registration completes during boot.
    await server.ready();
    expect(server.hasPlugin('@fastify/cookie')).toBe(true);
    expect(server.hasPlugin('@fastify/helmet')).toBe(false);
    expect(server.hasPlugin('@fastify/rate-limit')).toBe(false);
  });
  it('resolves the default static root to the package ui/dist directory', () => {
    expect(resolveUiDistDir()).toBe(join(REPO_ROOT, 'ui', 'dist'));
  });
});

describe('buildHttpServer — route seam and injection (§13)', () => {
  it('answers injected requests for unknown /api paths with the error envelope', async () => {
    const { server } = buildServer();
    const response = await server.inject({ method: 'GET', url: '/api/unknown' });
    expect(response.statusCode).toBe(404);
    // Task 148's §13 envelope (D-113) — byte-pinned in api-errors.spec.ts;
    // pinned structurally here as part of the construction contract.
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Not found',
        details: { method: 'GET', path: '/api/unknown' },
      },
    });
  });

  it('keeps CORS disabled on every response (§13)', async () => {
    const dist = await makeDistFixture();
    try {
      const { server } = buildServer({ staticRoot: dist.path });
      for (const url of ['/', '/api/unknown']) {
        const response = await server.inject({ method: 'GET', url });
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      }
    } finally {
      await dist.remove();
    }
  });
});

describe('buildHttpServer — static files and SPA fallback (§14.1)', () => {
  it('serves the built UI, assets, and SPA deep links from the static root', async () => {
    const dist = await makeDistFixture();
    try {
      const { server } = buildServer({ staticRoot: dist.path });
      await server.ready();
      // Since task 148's containment scope (D-113 review fix), the static
      // plugin registers inside `staticServingScope` — encapsulated, and a
      // root instance's `hasPlugin` sees only its own registrations
      // (verified on the pinned runtime). `printPlugins` prints the booted
      // tree, so the scope and the static plugin inside it stay
      // root-observable — the construction-ownership pin.
      const plugins = server.printPlugins();
      expect(plugins).toContain('staticServingScope');
      expect(plugins).toContain('@fastify/static');

      const home = await server.inject({ method: 'GET', url: '/' });
      expect(home.statusCode).toBe(200);
      expect(home.body).toContain('quotameter-ui');
      expect(home.headers['content-type']).toContain('text/html');

      const asset = await server.inject({ method: 'GET', url: '/app-0123.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toContain('console.log');

      // SPA fallback: a client-side route has no file — the app shell loads.
      const deepLink = await server.inject({ method: 'GET', url: '/accounts' });
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.body).toContain('quotameter-ui');

      // The API boundary is exact: `/apiary` is a UI deep link, not an API
      // path — a string prefix would 404 it.
      const lookalike = await server.inject({ method: 'GET', url: '/apiary' });
      expect(lookalike.statusCode).toBe(200);
      expect(lookalike.body).toContain('quotameter-ui');

      // The fallback never swallows API paths — with or without a query.
      for (const url of ['/api', '/api?x=1', '/api/unknown']) {
        const api = await server.inject({ method: 'GET', url });
        expect(api.statusCode, `GET ${url}`).toBe(404);
        expect(api.json(), `GET ${url}`).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }
    } finally {
      await dist.remove();
    }
  });

  it('degrades to an API-only server when no built UI exists', async () => {
    const { server, sink } = buildServer({
      staticRoot: join(REPO_ROOT, 'no-such-dist-directory'),
    });
    await server.ready();
    // The static plugin tree is absent in API-only mode — pinned through
    // the root-observable booted tree (see the static-mode test above).
    expect(server.printPlugins()).not.toContain('@fastify/static');
    const warnRecords = sink.records().filter((record) => record.level === 40);
    expect(warnRecords.length).toBe(1);
    expect(String(warnRecords[0]?.msg)).toContain('serving the API only');

    const home = await server.inject({ method: 'GET', url: '/' });
    expect(home.statusCode).toBe(404);
    expect(home.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const deepLink = await server.inject({ method: 'GET', url: '/accounts' });
    expect(deepLink.statusCode).toBe(404);
  });
});

describe('buildHttpServer — request logging follows the configured level (§16)', () => {
  it('emits no request-log lines at warn', async () => {
    const { server, sink } = buildServer({ level: 'warn' });
    await server.inject({ method: 'GET', url: '/api/unknown' });
    const messages = sink.records().map((record) => String(record.msg));
    expect(messages).not.toContain('incoming request');
    expect(messages.some((message) => message.includes('request completed'))).toBe(false);
  });

  it('emits request-log lines at debug through the redacting logger', async () => {
    const { server, sink } = buildServer({ level: 'debug' });
    await server.inject({ method: 'GET', url: '/api/unknown' });
    const records = sink.records();
    expect(records.some((record) => record.msg === 'incoming request')).toBe(true);
    expect(records.some((record) => record.msg === 'request completed')).toBe(true);
    expect(records.every((record) => record.name === 'quotameter')).toBe(true);
  });

  it('gates the closing-server 503 line on debug as well', () => {
    // The stock LogController always emits `serviceUnavailable` — the one
    // §16 escape hatch; the construction's gate closes it. Driven directly
    // with a real logger because the path needs a request arriving exactly
    // while the server is closing.
    const { logger, sink } = makeLogger('info');
    // `server` is unused by the underlying log call; the gate only reads it.
    const unusedServer = {} as FastifyInstance;
    new RequestLoggingGate(true).serviceUnavailable(logger.pino, unusedServer);
    expect(sink.records()).toHaveLength(0);
    new RequestLoggingGate(false).serviceUnavailable(logger.pino, unusedServer);
    const records = sink.records();
    expect(records).toHaveLength(1);
    expect(String(records[0]?.msg)).toContain('refusing to accept new requests');
  });
});

describe('createHttpServerComponent — lifecycle in the application shell (§5.6)', () => {
  it('validates the §5.6 stop bound at assembly', () => {
    for (const stopTimeoutMs of [
      0,
      -1,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      MAX_DRAIN_TIMEOUT_MS + 1,
    ]) {
      expect(
        () => buildComponent({ stopTimeoutMs }),
        `stopTimeoutMs=${String(stopTimeoutMs)}`,
      ).toThrow(/http-listener stopTimeoutMs must be a finite number/);
    }
    // The bound itself and shorter values are accepted; the accepted
    // components' servers are closed by the file-wide teardown.
    expect(() => buildComponent({ stopTimeoutMs: MAX_DRAIN_TIMEOUT_MS })).not.toThrow();
    expect(() => buildComponent({ stopTimeoutMs: 250 })).not.toThrow();
  });

  it('starts and stops cleanly through QuotameterApp', async () => {
    const events: LifecycleEvent[] = [];
    const { component } = buildComponent();
    const app = new QuotameterApp({
      components: [component],
      onLifecycle: (event) => events.push(event),
    });

    await app.start();
    const address = component.server.server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    expect(address.port).toBeGreaterThan(0);

    // The §15.5 timeouts are live on the listening server. Fastify applies
    // `connectionTimeout` as `server.setTimeout`, observable as `server.timeout`
    // — the property the review round proved is the real surface.
    const rawServer = component.server.server as {
      requestTimeout?: number;
      keepAliveTimeout?: number;
      timeout?: number;
    };
    expect(rawServer.requestTimeout).toBe(HTTP_REQUEST_TIMEOUT_MS);
    expect(rawServer.keepAliveTimeout).toBe(HTTP_KEEP_ALIVE_TIMEOUT_MS);
    expect(rawServer.timeout).toBe(HTTP_CONNECTION_TIMEOUT_MS);

    // A real socket serves the constructed shell — startup, not just inject.
    const response = await httpGet(`http://127.0.0.1:${address.port}/api/unknown`);
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.stop();
    expect(component.server.server.address()).toBeNull();
    expect(events).toContainEqual({ type: 'component-started', component: 'http-listener' });
    expect(events).toContainEqual({ type: 'component-stopped', component: 'http-listener' });
  });

  it('runs under runServer until a shutdown signal and exits cleanly', async () => {
    const onSpy = vi.spyOn(process, 'on');
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const { component } = buildComponent();
    const server = runServer({
      components: [component],
      runtime: { nodeVersion: '22.13.0', uid: 1000 },
      onSignalsReady: () => resolveReady(),
    });
    const handler = await sigtermHandlerAfter(onSpy, ready);
    shutdownTriggers.push(() => handler('SIGTERM'));
    expect(component.server.server.address()).not.toBeNull();

    handler('SIGTERM');
    await expect(server).resolves.toBe(0);
    expect(component.server.server.address()).toBeNull();
  });

  it('treats a repeated stop after a settled one as a no-op', async () => {
    const { component } = buildComponent();
    await component.start();
    // The pin is the close count: fastify tolerates repeated closes, so a
    // memo-less implementation would also resolve — while closing again.
    const closeSpy = vi.spyOn(component.server, 'close');
    await component.stop();
    await expect(component.stop()).resolves.toBeUndefined();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent stops into one close', async () => {
    const { component } = buildComponent();
    await component.start();
    const closeSpy = vi.spyOn(component.server, 'close');
    await Promise.all([component.stop(), component.stop()]);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps a rejected stop retryable — the U-018 component contract', async () => {
    const { component } = buildComponent();
    let closeAttempts = 0;
    // The `done(err)` callback form is the seam that makes fastify's
    // close() reject (a hook that throws synchronously escapes as an
    // unhandled error instead — probed).
    component.server.addHook('onClose', (_instance, done) => {
      closeAttempts += 1;
      if (closeAttempts === 1) done(new Error('close failed once'));
      else done();
    });
    await component.start();

    // The first close rejects; the component must surface it and stay
    // addressable (the memo is cleared, not latched to the rejection).
    await expect(component.stop()).rejects.toThrow('close failed once');
    expect(component.server.server.listening).toBe(false);
    // The retry re-attempts the release — a second close call — and this
    // time it settles (fastify does not re-run the hook once it errored).
    const closeSpy = vi.spyOn(component.server, 'close');
    await expect(component.stop()).resolves.toBeUndefined();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('forces completion once the §5.6 stop bound expires', async () => {
    const { component } = buildComponent({ stopTimeoutMs: 250 });
    // A route that never responds holds fastify's close open forever; the
    // component must force completion at the bound. The hang starts at
    // request ARRIVAL — the deferred makes that causal, not timed (D-087).
    let requestArrived!: () => void;
    const arrived = new Promise<void>((resolve) => {
      requestArrived = resolve;
    });
    component.server.get('/hang', () => {
      requestArrived();
      return new Promise<void>(() => {});
    });
    await component.start();
    const address = component.server.server.address() as AddressInfo;
    const requestError = new Promise<Error>((resolve) => {
      const request = get(`http://127.0.0.1:${address.port}/hang`);
      request.on('error', (error: Error) => resolve(error));
    });
    await arrived;

    const startedAt = performance.now();
    await component.stop();
    const elapsed = performance.now() - startedAt;
    // The bound is respected (timers never fire early) and the close is
    // genuinely forced — without closeAllConnections it would never settle.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(10_000);
    // The hung client's socket was destroyed with a transport error.
    expect(await requestError).toBeInstanceOf(Error);
  });
});

/**
 * Resolves once `started` settled and the microtask queue drained, with the
 * SIGTERM handler `runServer` registered (it installs right after
 * `app.start()` resolves) — the server-main suite's handshake.
 */
async function sigtermHandlerAfter(
  onSpy: MockInstance<typeof process.on>,
  started: Promise<unknown>,
): Promise<(signal: NodeJS.Signals) => void> {
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const call = onSpy.mock.calls.filter(([event]) => event === 'SIGTERM').at(-1);
  expect(call, 'runServer did not register a SIGTERM handler').toBeDefined();
  return call?.[1] as (signal: NodeJS.Signals) => void;
}
