import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildHttpServer } from '../../src/server/http';
import { createLogger, type Logger } from '../../src/util/logger';
import { createMemoryLogSink, type MemoryLogSink } from '../helpers/logSink';
import { createTempDir, type TempDir } from '../helpers/isolation';

/**
 * The §15.3 Host-allowlist guard on the wire (task 151, decision D-120):
 * through the full task-146 construction (`buildHttpServer` +
 * `fastify.inject`), a `Host` outside `{localhost, 127.0.0.1, [::1], the
 * configured host}` is rejected with the §13 envelope's FORBIDDEN class
 * on BOTH route families — `/api` and the frontend (static assets, SPA
 * deep links, and the API-only not-found arm alike), because the guard
 * registers at root scope, outermost of the §15.3 layers. Pass-through
 * evidence rides the health endpoint's byte-pinned `{"status":"ok"}` and
 * the static fixture's shell — response classes the guard can never
 * produce.
 *
 * `fastify.inject` always defaults the Host header to `localhost:80` and
 * cannot express a missing or duplicate one, so the missing-Host
 * (HTTP/1.0 — an HTTP/1.1 request without Host is answered 400 by the
 * HTTP parser before fastify, the documented transport boundary),
 * duplicate-Host, and absolute-form arms run against a real ephemeral
 * loopback listener over `node:net` sockets. The same mock normalizes
 * absolute-form URLs away (light-my-request delivers `pathname +
 * search`), so the absolute-form arms live there too — on the real wire
 * the router matches the extracted path while `request.url` keeps the
 * full attacker-controlled URL (verified live).
 */

/** Every Fastify instance this test file had a hand in creating. */
const openServers: FastifyInstance[] = [];

/** Builds the real construction with test defaults and records it for teardown. */
function buildServer(options: { staticRoot?: string; host?: string } = {}): {
  server: FastifyInstance;
  sink: MemoryLogSink;
} {
  const sink = createMemoryLogSink();
  const logger: Logger = createLogger({ level: 'warn', destination: sink });
  const server = buildHttpServer({
    host: options.host ?? '127.0.0.1',
    port: 0,
    logger,
    ...(options.staticRoot === undefined ? {} : { staticRoot: options.staticRoot }),
  });
  openServers.push(server);
  return { server, sink };
}

/** A built-UI fixture: `index.html` plus one asset (the api-errors pattern). */
async function makeDistFixture(): Promise<TempDir> {
  const dir = await createTempDir('host-dist-');
  await writeFile(join(dir.path, 'index.html'), '<html id="quotameter-ui">shell</html>');
  await writeFile(join(dir.path, 'style.css'), 'body{}');
  return dir;
}

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await server.close().catch(() => undefined);
  }
});

/** The byte-pinned FORBIDDEN envelope of every Host-guard rejection. */
function forbiddenBody(reason: string): string {
  return `{"error":{"code":"FORBIDDEN","message":"Request host rejected","details":{"reason":"${reason}"}}}`;
}

/** Sends one raw request over a real loopback socket and reads the reply. */
function rawExchange(server: FastifyInstance, request: string): Promise<string> {
  const address = server.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a listening server on an ephemeral port');
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect(address.port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('error', reject);
    // Loopback round-trips are milliseconds; five seconds is the house
    // delivered-response deadline (D-087) and only a safety bound.
    const deadline = setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, 5000);
    socket.on('close', () => {
      clearTimeout(deadline);
      resolve(data);
    });
  });
}

describe('invalid Host values — rejected on API routes (§15.3)', () => {
  it('answers the FORBIDDEN envelope with the disallowed-host reason', async () => {
    const { server } = buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toBe(forbiddenBody('disallowed-host'));
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects every rebinding shape — foreign names, lookalikes, foreign IPv6', async () => {
    const { server } = buildServer();
    for (const host of [
      'evil.example',
      'EVIL.EXAMPLE',
      'evil.example:8787',
      'localhost.evil.example',
      '127.0.0.2', // spec-literal: the /8 range is not the allowlist
      '0.0.0.0',
      '[fe80::1]',
      '::1', // unbracketed IPv6 is not a Host grammar form
      'localhost:99999', // not a port value
      'localhost, evil.example', // the duplicate-header join shape
    ]) {
      const response = await server.inject({
        method: 'GET',
        url: '/api/health',
        headers: { host },
      });
      expect(response.statusCode, host).toBe(403);
      expect(response.json(), host).toMatchObject({
        error: { code: 'FORBIDDEN', details: { reason: 'disallowed-host' } },
      });
    }
  });

  it('is method-blind — safe methods are guarded exactly like mutations', () => {
    // Unlike the Origin/custom-header guards (§13's four methods), the
    // Host check has no method dimension: a rebinding page reads the
    // frontend through GET, so the guard cannot spare it.
    return (async () => {
      const { server } = buildServer();
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await server.inject({
          method,
          url: '/api/health',
          headers: { host: 'evil.example' },
        });
        expect(response.statusCode, method).toBe(403);
      }
    })();
  });

  it('outranks the /api scope guards — the outermost §15.3 layer', async () => {
    // Root-scope hooks run ahead of scoped ones (the structural
    // layering): a request failing Host AND Origin/header checks answers
    // the Host verdict; with the Host allowed, the landed guards still
    // answer their own classes.
    const { server } = buildServer();
    const bothHostile = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { host: 'evil.example', origin: 'https://evil.example' },
    });
    expect(bothHostile.statusCode).toBe(403);
    expect(bothHostile.json()).toMatchObject({
      error: { details: { reason: 'disallowed-host' } },
    });
    const originStillOwns = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { origin: 'https://evil.example' }, // Host: localhost:80
    });
    expect(originStillOwns.statusCode).toBe(403);
    expect(originStillOwns.json()).toMatchObject({
      error: { details: { reason: 'origin-mismatch' } },
    });
  });

  it('rejects before the body is read or parsed', async () => {
    const { server } = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: '{"broken',
      headers: { host: 'evil.example', 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('screens unmatched API paths too — the guard outranks the catch-all', async () => {
    const { server } = buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/unknown',
      headers: { host: 'evil.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('answers an absolute-form request target by its own authority (raw wire only)', () => {
    // `fastify.inject` cannot express this shape — light-my-request
    // parses the URL and delivers `pathname + search` only — so these
    // arms live in the raw-socket describe below; this test documents
    // the split and pins the inject normalization itself: the absolute
    // prefix never survives to routing, and the allowlisted Host
    // decides alone (the same verdict the classifier's origin-form arm
    // gives over `{host: 'localhost:80', url: '/api/health'}`).
    return (async () => {
      const { server } = buildServer();
      const normalized = await server.inject({
        method: 'GET',
        url: 'http://evil.example/api/health',
        headers: { host: 'localhost:80' },
      });
      expect(normalized.statusCode).toBe(200);
      expect(normalized.body).toBe('{"status":"ok"}');
    })();
  });
});

describe('invalid Host values — rejected on frontend routes (the done-condition)', () => {
  it('rejects the shell, assets, and SPA deep links while static serving is active', async () => {
    const dist = await makeDistFixture();
    try {
      const { server } = buildServer({ staticRoot: dist.path });
      for (const url of ['/', '/style.css', '/accounts']) {
        const response = await server.inject({
          method: 'GET',
          url,
          headers: { host: 'evil.example' },
        });
        expect(response.statusCode, url).toBe(403);
        expect(response.json(), url).toMatchObject({ error: { code: 'FORBIDDEN' } });
        expect(response.headers['cache-control'], url).toBe('no-store');
      }
      // The mode this scope must not disturb: the same paths serve the
      // UI for an allowlisted Host.
      const shell = await server.inject({ method: 'GET', url: '/' }); // localhost:80
      expect(shell.statusCode).toBe(200);
      expect(shell.body).toContain('quotameter-ui');
      const deepLink = await server.inject({
        method: 'GET',
        url: '/accounts',
        headers: { host: 'localhost:8787' },
      });
      expect(deepLink.statusCode).toBe(200);
    } finally {
      await dist.remove();
    }
  });

  it('rejects frontend paths in API-only mode too — the root not-found arm is guarded', async () => {
    // Without a build, GET / normally answers the 404 envelope; with a
    // foreign Host it answers the Host verdict first — the guard does
    // not depend on the static-serving state (the D-113 lesson).
    const { server } = buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'evil.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'FORBIDDEN', details: { reason: 'disallowed-host' } },
    });
  });
});

describe('allowed Host values — pass-through in every shape (§15.3)', () => {
  it('serves the health endpoint for every allowlisted authority form', async () => {
    const { server } = buildServer();
    for (const host of [
      'localhost', // the inject default's name, written bare
      'localhost:80',
      'localhost:443',
      'LOCALHOST:80',
      '127.0.0.1',
      '127.0.0.1:8787',
      '[::1]',
      '[::1]:8787',
      'localhost:9999', // the SSH-tunnel port shape (D-120)
    ]) {
      const response = await server.inject({
        method: 'GET',
        url: '/api/health',
        headers: { host },
      });
      expect(response.statusCode, host).toBe(200);
      expect(response.body, host).toBe('{"status":"ok"}');
    }
  });

  it('admits the configured host and its port forms, and only them beside the base', async () => {
    const { server } = buildServer({ host: '192.168.1.5' });
    for (const host of ['192.168.1.5', '192.168.1.5:8787', '192.168.1.5:80', '192.168.1.5:443']) {
      const response = await server.inject({
        method: 'GET',
        url: '/api/health',
        headers: { host },
      });
      expect(response.statusCode, host).toBe(200);
    }
    // A different address — same interface or not — is another host.
    const other = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '10.0.0.1:8787' },
    });
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    // The base names stay admitted under any configured host.
    const base = await server.inject({ method: 'GET', url: '/api/health' }); // localhost:80
    expect(base.statusCode).toBe(200);
  });

  it('warns once at construction for a wildcard bind and admits only its literal name', async () => {
    // D-120's recorded consequence, made audible (the review round's
    // ask): a wildcard bind 403s every concrete interface address, so
    // the operator hears it at startup with the reachable shapes named.
    const { server, sink } = buildServer({ host: '0.0.0.0' });
    // The API-only construction also logs its own no-built-UI warn, so
    // the pin is exactly one HOST-allowlist warning line.
    const warnings = sink
      .records()
      .filter((record) => String(record.msg).includes('host allowlist'));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.msg)).toContain('0.0.0.0');
    expect(String(warnings[0]?.msg)).toContain('§15.3');
    // The literal wildcard name passes; a concrete address does not;
    // the base names keep the tunnel shapes reachable.
    const literal = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '0.0.0.0:8787' },
    });
    expect(literal.statusCode).toBe(200);
    const lan = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '192.168.1.5:8787' },
    });
    expect(lan.statusCode).toBe(403);
    const tunnel = await server.inject({ method: 'GET', url: '/api/health' }); // localhost:80
    expect(tunnel.statusCode).toBe(200);
  });
});

describe('raw-socket arms — wire shapes inject cannot express', () => {
  it(
    'rejects an HTTP/1.0 request without a Host header (missing-host)',
    { timeout: 10_000 },
    async () => {
      const { server } = buildServer();
      await server.listen({ host: '127.0.0.1', port: 0 });
      const reply = await rawExchange(server, 'GET /api/health HTTP/1.0\r\n\r\n');
      expect(reply).toContain(' 403 ');
      expect(reply).toContain('"reason":"missing-host"');
      // The control: the same request shape with an allowlisted Host passes.
      const control = await rawExchange(
        server,
        'GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r\n',
      );
      expect(control).toContain(' 200 ');
      expect(control).toContain('{"status":"ok"}');
    },
  );

  it(
    'answers an HTTP/1.1 request without a Host with the parser-level 400 (the boundary)',
    { timeout: 10_000 },
    async () => {
      // llhttp rejects the Host-less HTTP/1.1 request before fastify —
      // the guard's missing-host arm is the HTTP/1.0-reachable one; this
      // pin keeps the split honest.
      const { server } = buildServer();
      await server.listen({ host: '127.0.0.1', port: 0 });
      const reply = await rawExchange(
        server,
        'GET /api/health HTTP/1.1\r\nConnection: close\r\n\r\n',
      );
      expect(reply).toContain(' 400 ');
    },
  );

  it('rejects duplicate Host header entries (duplicate-host)', { timeout: 10_000 }, async () => {
    // Node folds `headers.host` onto the first value; rawHeaders keeps
    // both, and the RFC 9112 §3.2.2 MUST-reject fires on the scan — the
    // allowlisted first value must not smuggle the pair through.
    const { server } = buildServer();
    await server.listen({ host: '127.0.0.1', port: 0 });
    const reply = await rawExchange(
      server,
      'GET /api/health HTTP/1.1\r\nHost: localhost\r\nHost: evil.example\r\nConnection: close\r\n\r\n',
    );
    expect(reply).toContain(' 403 ');
    expect(reply).toContain('"reason":"duplicate-host"');
  });

  it(
    'rejects an absolute-form target on the raw wire as the classifier decides',
    { timeout: 10_000 },
    async () => {
      // Over a real socket the absolute form survives intact in
      // `request.url` while find-my-way routes the extracted path
      // (verified live) — an unchecked second authority without the
      // guard's target leg. Inject cannot express this (it normalizes),
      // so all three target verdicts pin here.
      const { server } = buildServer();
      await server.listen({ host: '127.0.0.1', port: 0 });
      const foreign = await rawExchange(
        server,
        'GET http://evil.example/api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
      );
      expect(foreign).toContain(' 403 ');
      expect(foreign).toContain('"reason":"disallowed-target"');
      const mismatch = await rawExchange(
        server,
        'GET http://127.0.0.1/api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
      );
      expect(mismatch).toContain(' 403 ');
      expect(mismatch).toContain('"reason":"target-mismatch"');
      // Same allowlisted name on both sides (ports unpinned, D-120).
      const sameName = await rawExchange(
        server,
        'GET http://localhost:9999/api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
      );
      expect(sameName).toContain(' 200 ');
      expect(sameName).toContain('{"status":"ok"}');
    },
  );
});

describe('§15.4/§16 discipline', () => {
  it('echoes no attacker-controlled header value in the envelope', async () => {
    const { server } = buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.example/<script>' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('evil.example');
    expect(response.body).not.toContain('<script>');
  });

  it('keeps the log sink at its baseline across rejections and pass-throughs', async () => {
    const { server, sink } = buildServer();
    const baseline = sink.records().length;
    await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.example' },
    });
    await server.inject({ method: 'POST', url: '/api/accounts', headers: { host: '::1' } });
    await server.inject({ method: 'GET', url: '/api/health' });
    // A client-side rejection is a 4xx class: §16's level discipline
    // logs nothing at warn — there is nothing to diagnose server-side.
    expect(sink.records().length).toBe(baseline);
  });
});
