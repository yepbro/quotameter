import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildHttpServer, type HttpAuthOptions } from '../../src/server/http';
import { createLogger, type Logger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { createTempDir, type TempDir } from '../helpers/isolation';

/**
 * The §15.1 auth-mode matrix on the wire (task 152, decision D-121):
 * through the full task-146 construction (`buildHttpServer` +
 * `fastify.inject`, no sockets), the full address (loopback /
 * non-loopback bind) × proxy-indicator (each §15.1 header, absent) ×
 * password (configured / not) × mode (`auto` / `required`) table is
 * pinned — the passwordless loopback pass-through, the 401 of every
 * password-demanding cell, §15.1's own 403-with-instructions for the
 * proxied passwordless shape, the public health route (unauthenticated
 * in every mode, address, and proxy state), the frontend shell that
 * must load for the §14.6 login page, and the guard order D-120 pinned
 * (Host outermost, then the §15.3 mutation guards, then this layer).
 *
 * Pass-through evidence rides the scope's catch-all route (task 148):
 * an unmatched `/api` path answers its 404 envelope — a class the auth
 * layer can never produce — so a 404 proves the request passed the auth
 * question unanswered. The startup-refusal legs of §15.1 belong to the
 * config layer (task 073, pinned by its own suites); here their shapes
 * are fed straight into the construction to pin the fail-closed wire
 * answer (401, never open).
 */

/** Every Fastify instance this test file had a hand in creating. */
const openServers: FastifyInstance[] = [];

/** Builds the real construction with test defaults and records it for teardown. */
function buildServer(
  auth?: HttpAuthOptions,
  host = '127.0.0.1',
  staticRoot?: string,
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
    ...(auth === undefined ? {} : { auth }),
    ...(staticRoot === undefined ? {} : { staticRoot }),
  });
  openServers.push(server);
  return { server, sink };
}

/** A built-UI fixture: `index.html` plus one asset (the api-origin pattern). */
async function makeDistFixture(): Promise<TempDir> {
  const dir = await createTempDir('auth-dist-');
  await writeFile(join(dir.path, 'index.html'), '<html id="quotameter-ui">shell</html>');
  await writeFile(join(dir.path, 'style.css'), 'body{}');
  return dir;
}

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await server.close().catch(() => undefined);
  }
});

/** The loopback authority the injections pose as on the loopback bind. */
const HOST = { host: '127.0.0.1:8787' };

/** The authority of the non-loopback bind arms (the configured host). */
const REMOTE_HOST = { host: '192.168.1.5:8787' };

/** The dedicated mutation header of task 150 — scenery for the order pins. */
const MUTATION_HEADERS = { 'x-quotameter-request': 'quotameter-ui' };

/** §15.1's instruction message, JSON-encoded for the byte-pinned body. */
const PROXY_INSTRUCTIONS =
  'The request was forwarded by a reverse proxy, but no password is configured; ' +
  'set one with `quotameter passwd` before exposing the service through a proxy, ' +
  'or reach it directly on the loopback interface';

/** The byte-pinned 403 envelope of the passwordless proxied shape. */
const PROXY_FORBIDDEN_BODY =
  `{"error":{"code":"FORBIDDEN","message":${JSON.stringify(PROXY_INSTRUCTIONS)},` +
  '"details":{"reason":"proxy-without-password"}}}';

/** The byte-pinned 401 envelope of every credential-demanding rejection. */
const UNAUTHENTICATED_BODY =
  '{"error":{"code":"UNAUTHENTICATED","message":"Authentication required",' +
  '"details":{"reason":"authentication-required"}}}';

/** A password-present projection without any secret: the fact, not the hash. */
const PASSWORD_SET: HttpAuthOptions = { passwordConfigured: () => true };

describe('auto mode, loopback bind — the §15.1 default surface', () => {
  it('lets the direct loopback request through (pass-through evidence: the 404 catch-all)', async () => {
    const { server } = buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: HOST,
    });
    expect(response.statusCode).toBe(404);
  });

  it.each([
    ['Forwarded', { forwarded: 'for=203.0.113.7' }],
    ['X-Real-IP', { 'x-real-ip': '203.0.113.7' }],
    ['X-Forwarded-For', { 'x-forwarded-for': '203.0.113.7' }],
    ['X-Forwarded-Proto', { 'x-forwarded-proto': 'https' }],
    ['X-Forwarded-Host', { 'x-forwarded-host': 'quotameter.example' }],
  ])(
    'answers the 403-with-instructions envelope for a lone %s (no password)',
    async (_name, proxy) => {
      const { server } = buildServer();
      const response = await server.inject({
        method: 'GET',
        url: '/api/accounts',
        headers: { ...HOST, ...proxy },
      });
      expect(response.statusCode).toBe(403);
      expect(response.body).toBe(PROXY_FORBIDDEN_BODY);
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it('keeps the public health route answering through a proxy hop (proxy-blind)', async () => {
    const { server } = buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { ...HOST, 'x-real-ip': '203.0.113.7' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"status":"ok"}');
  });

  it('stays passwordless for the direct loopback request even with a password set', async () => {
    // auto mode's own words: "direct loopback requests do not require a
    // password" — the configured password matters on the remote paths.
    const { server } = buildServer(PASSWORD_SET);
    const response = await server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: HOST,
    });
    expect(response.statusCode).toBe(404);
  });

  it('demands credentials for the proxied request once a password exists (401)', async () => {
    const { server } = buildServer(PASSWORD_SET);
    const response = await server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { ...HOST, 'x-forwarded-for': '203.0.113.7' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe(UNAUTHENTICATED_BODY);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('auto mode, non-loopback bind — the password is demanded on every path', () => {
  it('answers 401 for the direct request (no proxy headers needed)', async () => {
    const { server } = buildServer(PASSWORD_SET, '192.168.1.5');
    const response = await server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: REMOTE_HOST,
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe(UNAUTHENTICATED_BODY);
  });

  it('answers 401 for the proxied request (both §15.1 triggers stacked)', async () => {
    const { server } = buildServer(PASSWORD_SET, '192.168.1.5');
    const response = await server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { ...REMOTE_HOST, forwarded: 'for=203.0.113.7' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe(UNAUTHENTICATED_BODY);
  });

  it('keeps the public health route answering under the remote bind', async () => {
    const { server } = buildServer(PASSWORD_SET, '192.168.1.5');
    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: REMOTE_HOST,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"status":"ok"}');
  });

  it('answers the startup-refused shape fail-closed 401, never open (config refuses it first)', async () => {
    // The config layer refuses this bind without a password at startup
    // (task 073); fed straight into the construction anyway, the wire
    // answer stays shut — the classifier's fail-closed arm.
    const { server } = buildServer(undefined, '192.168.1.5');
    const response = await server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: REMOTE_HOST,
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe(UNAUTHENTICATED_BODY);
  });
});

describe('required mode — a password is always required', () => {
  it('answers 401 for the direct loopback request (auto-mode local exemption gone)', async () => {
    const { server } = buildServer({ mode: 'required', ...PASSWORD_SET });
    const response = await server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: HOST,
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe(UNAUTHENTICATED_BODY);
  });

  it('answers 401 on the unmatched catch-all too — no route enumeration under auth', async () => {
    const { server } = buildServer({ mode: 'required', ...PASSWORD_SET });
    const response = await server.inject({
      method: 'GET',
      url: '/api/does-not-exist',
      headers: HOST,
    });
    expect(response.statusCode).toBe(401);
  });

  it('keeps the public health route answering without credentials (GET and the HEAD twin)', async () => {
    const { server } = buildServer({ mode: 'required', ...PASSWORD_SET });
    const get = await server.inject({ method: 'GET', url: '/api/health', headers: HOST });
    expect(get.statusCode).toBe(200);
    expect(get.body).toBe('{"status":"ok"}');
    // The auto-generated HEAD twin inherits the route config carrying
    // the public opt-out.
    const head = await server.inject({ method: 'HEAD', url: '/api/health', headers: HOST });
    expect(head.statusCode).toBe(200);
  });

  it('serves the frontend shell and SPA fallback without credentials (the §14.6 login page loads)', async () => {
    const dist = await makeDistFixture();
    const { server } = buildServer({ mode: 'required', ...PASSWORD_SET }, '127.0.0.1', dist.path);
    const shell = await server.inject({ method: 'GET', url: '/', headers: HOST });
    expect(shell.statusCode).toBe(200);
    expect(shell.body).toBe('<html id="quotameter-ui">shell</html>');
    const deepLink = await server.inject({
      method: 'GET',
      url: '/accounts/acc_123',
      headers: HOST,
    });
    expect(deepLink.statusCode).toBe(200);
    expect(deepLink.body).toBe('<html id="quotameter-ui">shell</html>');
  });

  it('answers the non-API and bare-/api arms with the mode-independent 404 (outside the /api scope)', async () => {
    // The auth layer lives in the /api scope (D-121): non-API paths in
    // API-only mode and the bare `/api` boundary answer the envelope's
    // 404 exactly as before — no authentication question is asked, and
    // no protected surface exists there.
    const { server } = buildServer({ mode: 'required', ...PASSWORD_SET });
    const nonApi = await server.inject({ method: 'GET', url: '/nope', headers: HOST });
    expect(nonApi.statusCode).toBe(404);
    const bareApi = await server.inject({ method: 'GET', url: '/api', headers: HOST });
    expect(bareApi.statusCode).toBe(404);
  });

  it('answers the startup-refused shape fail-closed 401 (required without a password)', async () => {
    const { server } = buildServer({ mode: 'required' });
    const response = await server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: HOST,
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe(UNAUTHENTICATED_BODY);
  });

  it('passes an authenticated request through the construction (the 153–155 seam)', async () => {
    const { server } = buildServer({
      mode: 'required',
      ...PASSWORD_SET,
      isAuthenticated: (request) => request.headers.cookie !== undefined,
    });
    const authenticated = await server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { ...HOST, cookie: 'qm-session=t.example' },
    });
    expect(authenticated.statusCode).toBe(404);
    const anonymous = await server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: HOST,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('guard order — the auth verdict comes last of the security layers', () => {
  it('answers the Host verdict before the auth verdict (root-scope Host outermost)', async () => {
    // auto/loopback/no-password: the proxied shape would answer the
    // 403 instructions — the hostile Host answers FIRST.
    const { server } = buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { host: 'evil.example', 'x-real-ip': '203.0.113.7' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toBe(
      '{"error":{"code":"FORBIDDEN","message":"Request host rejected","details":{"reason":"disallowed-host"}}}',
    );
  });

  it('answers the Origin verdict before the auth verdict (a proxied cross-origin mutation)', async () => {
    const { server } = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: {
        ...HOST,
        origin: 'https://evil.example',
        ...MUTATION_HEADERS,
        'x-real-ip': '203.0.113.7',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.details).toEqual({ reason: 'origin-mismatch' });
  });

  it('answers the custom-header verdict before the auth verdict (a header-less mutation)', async () => {
    const { server } = buildServer(PASSWORD_SET);
    const response = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: {
        ...HOST,
        origin: 'http://127.0.0.1:8787',
        'x-forwarded-for': '203.0.113.7',
        'content-length': '0',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.details).toEqual({ reason: 'missing-custom-header' });
  });

  it('answers the auth verdict once the §15.3 layers pass (the same mutation, completed)', async () => {
    const { server } = buildServer(PASSWORD_SET);
    const response = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: {
        ...HOST,
        origin: 'http://127.0.0.1:8787',
        ...MUTATION_HEADERS,
        'x-forwarded-for': '203.0.113.7',
        'content-length': '0',
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe(UNAUTHENTICATED_BODY);
  });
});

describe('the full §15.1 matrix on the wire — every cell, table-driven', () => {
  /**
   * One wire row of the §17.1 security matrix: a construction under one
   * (mode, bind, password) triple answers a proxied and an unproxied
   * request. All eight triples × both proxy states = the full 16-cell
   * table; the passwordless remote and passwordless `required` shapes
   * are the config layer's startup refusals (task 073) fed straight
   * into the construction, pinning the fail-closed wire answer.
   */
  interface MatrixRow {
    readonly mode: 'auto' | 'required';
    readonly host: string;
    readonly password: boolean;
    readonly direct: number;
    readonly proxied: number;
  }

  const LOOPBACK = '127.0.0.1';
  const REMOTE = '192.168.1.5';

  it.each<MatrixRow>([
    // auto + loopback: the proxy indication flips the verdict; the
    // direct request stays passwordless with and without a password.
    { mode: 'auto', host: LOOPBACK, password: false, direct: 404, proxied: 403 },
    { mode: 'auto', host: LOOPBACK, password: true, direct: 404, proxied: 401 },
    // auto + non-loopback: demanded on every path; the passwordless
    // rows are the startup-refused shapes, fail-closed on the wire.
    { mode: 'auto', host: REMOTE, password: false, direct: 401, proxied: 401 },
    { mode: 'auto', host: REMOTE, password: true, direct: 401, proxied: 401 },
    // required: unconditional, every address and hop, with and without
    // a password (the passwordless rows are startup-refused shapes).
    { mode: 'required', host: LOOPBACK, password: false, direct: 401, proxied: 401 },
    { mode: 'required', host: LOOPBACK, password: true, direct: 401, proxied: 401 },
    { mode: 'required', host: REMOTE, password: false, direct: 401, proxied: 401 },
    { mode: 'required', host: REMOTE, password: true, direct: 401, proxied: 401 },
  ])(
    'mode=%s bind=%s password=%s → direct %s, proxied %s',
    async ({ mode, host, password, direct, proxied }) => {
      const authority = host === LOOPBACK ? HOST : REMOTE_HOST;
      const { server } = buildServer({ mode, ...(password ? PASSWORD_SET : {}) }, host);
      const directResponse = await server.inject({
        method: 'GET',
        url: '/api/matrix-probe',
        headers: authority,
      });
      expect(directResponse.statusCode).toBe(direct);
      const proxiedResponse = await server.inject({
        method: 'GET',
        url: '/api/matrix-probe',
        headers: { ...authority, 'x-forwarded-for': '203.0.113.7' },
      });
      expect(proxiedResponse.statusCode).toBe(proxied);
      // The rejection bodies are the byte-pinned envelopes of their
      // class — the same literals every named arm above pins.
      if (proxied === 403) {
        expect(proxiedResponse.body).toBe(PROXY_FORBIDDEN_BODY);
      }
      if (proxied === 401) {
        expect(proxiedResponse.body).toBe(UNAUTHENTICATED_BODY);
      }
      if (direct === 404) {
        expect(directResponse.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }
    },
  );
});

describe('§15.4/§16 discipline — the rejections echo and log nothing', () => {
  it('leaves the client-supplied proxy values out of the 403 body', async () => {
    const { server } = buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { ...HOST, 'x-real-ip': '203.0.113.7', 'x-forwarded-host': 'tracker.example' },
    });
    expect(response.body).toBe(PROXY_FORBIDDEN_BODY);
    expect(response.body).not.toContain('203.0.113.7');
    expect(response.body).not.toContain('tracker.example');
  });

  it('writes zero log records for the 403 and 401 rejections at warn', async () => {
    // The review round's fix: the 403 needs its own passwordless server
    // — on the passworded one the same proxied request answers 401, so
    // the passworded server alone never exercised the 403 class.
    const passwordless = buildServer();
    const passwordlessBaseline = passwordless.sink.records().length;
    const forbidden = await passwordless.server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { ...HOST, 'x-forwarded-for': '203.0.113.7' },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(passwordless.sink.records().length).toBe(passwordlessBaseline);
    // The 401 arm keeps the passworded construction, plus the public
    // health route and the pass-through 404 for class completeness.
    const { server, sink } = buildServer(PASSWORD_SET);
    const baseline = sink.records().length;
    await server.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { ...HOST, 'x-forwarded-for': '203.0.113.7' },
    });
    await server.inject({ method: 'GET', url: '/api/accounts', headers: { ...HOST } });
    await server.inject({ method: 'GET', url: '/api/health', headers: HOST });
    expect(sink.records().length).toBe(baseline);
  });
});
