import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockProviderServer, startMockProviderServer } from '../helpers/mockProviderServer';
import {
  MAX_RESPONSE_BODY_BYTES,
  TransportAbortError,
  TransportConnectionError,
  TransportContentTypeError,
  TransportNetworkError,
  TransportResponseTooLargeError,
  TransportSocketError,
  TransportStatusError,
  TransportTimeoutError,
  TransportError,
  providerFetch,
  type ProviderHttpRequest,
} from '../../src/providers/transport';

/**
 * Real-socket coverage for the HTTP transport (spec §7.2, §17.1; task 104,
 * decision D-042): every §7.2-required transport failure is reproduced
 * locally and asserted against the taxonomy. The shared mock provider
 * server covers status/body/delay/pre-response-termination; the two shapes
 * it cannot express — a body that trickles slower than the deadline and a
 * socket destroyed mid-body — come from file-local `node:http` servers on
 * 127.0.0.1 (the landed helper is not modified; D-042). Failure shapes were
 * probed against the pinned runtime (Node 22.13.0) before being pinned here.
 */

/** The marker-secret scenario value (§15.4, §17.1); must never survive. */
const MARKER = 'qm-marker-secret-t104-integration';

/** A request whose credential surfaces (query + header) carry the marker. */
function markerRequest(url: string): ProviderHttpRequest {
  return { url: `${url}?token=${MARKER}`, headers: { authorization: `Bearer ${MARKER}` } };
}

/** Renders every string an error could leak a secret through. */
function errorSurface(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return [error.name, error.message, error.stack ?? '', JSON.stringify(error)].join('\n');
}

interface LocalServer {
  url: string;
  close(): Promise<void>;
}

/**
 * A one-off loopback server for behaviors outside the shared mock server's
 * vocabulary. Connections are force-closed on shutdown so keep-alive
 * sockets never stall `close()`.
 */
async function startLocalServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LocalServer> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Reserves a loopback port and releases it, leaving a refused port behind. */
async function freedLoopbackPort(): Promise<number> {
  const probe: Server = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Ignores write errors on sockets the client has already abandoned. */
function ignoreStreamErrors(res: ServerResponse): void {
  res.on('error', () => {});
  res.socket?.on('error', () => {});
}

describe('providerFetch over real sockets', () => {
  let server: MockProviderServer;

  beforeAll(async () => {
    server = await startMockProviderServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('delivers a 2xx application/json response and passes headers through', async () => {
    const body = '{"quota":{"used":10}}';
    server.setBehavior({ kind: 'respond', status: 200, body });

    const result = await providerFetch(markerRequest(`${server.url}/api/monitor/usage`), {
      timeoutMs: 5000,
    });

    expect(result).toEqual({
      status: 200,
      contentType: 'application/json',
      body,
      bytes: Buffer.byteLength(body),
    });
    // The credential does reach the provider — only error paths must hide it.
    expect(server.requests.at(-1)).toMatchObject({
      method: 'GET',
      url: `/api/monitor/usage?token=${MARKER}`,
    });
    expect(server.requests.at(-1)?.headers.authorization).toBe(`Bearer ${MARKER}`);
  });

  it('accepts application/json with parameters', async () => {
    server.setBehavior({
      kind: 'respond',
      status: 200,
      body: '{}',
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    const result = await providerFetch({ url: `${server.url}/` }, { timeoutMs: 5000 });
    expect(result.contentType).toBe('application/json; charset=utf-8');
    expect(result.body).toBe('{}');
  });

  it('times out while awaiting response headers (spec §7.2 deadline)', async () => {
    server.setBehavior({ kind: 'respond', status: 200, body: '{}', delayMs: 400 });
    const startedAt = Date.now();
    const error = await providerFetch(markerRequest(`${server.url}/`), { timeoutMs: 60 }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransportTimeoutError);
    expect((error as TransportTimeoutError).kind).toBe('timeout');
    // The deadline really cut the 400 ms delay.
    expect(Date.now() - startedAt).toBeLessThan(350);
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('times out while reading a slow body', async () => {
    const trickle = await startLocalServer((_req, res) => {
      ignoreStreamErrors(res);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"chunked":');
      const interval = setInterval(() => res.write('1'), 60);
      res.on('close', () => clearInterval(interval));
      setTimeout(() => {
        clearInterval(interval);
        res.end('}');
      }, 800);
    });
    try {
      const error = await providerFetch(markerRequest(`${trickle.url}/`), {
        timeoutMs: 120,
      }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(TransportTimeoutError);
      expect(errorSurface(error)).not.toContain(MARKER);
    } finally {
      await trickle.close();
    }
  });

  it('reports connection refused as a connection failure', async () => {
    const port = await freedLoopbackPort();
    const error = await providerFetch(markerRequest(`http://127.0.0.1:${port}/`), {
      timeoutMs: 5000,
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportConnectionError);
    expect((error as TransportConnectionError).kind).toBe('connection');
    expect((error as TransportConnectionError).causeCode).toBe('ECONNREFUSED');
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('reports an unresolvable host as a plain network failure under the guard', async () => {
    // The suite's no-network guard intercepts non-loopback hostnames before
    // DNS resolution, so the *.invalid case surfaces as the guard rejection
    // — classified as a network failure, never a crash (D-042). The DNS
    // class itself is pinned in test/unit/transport.spec.ts against the
    // verified ENOTFOUND/EAI_AGAIN runtime shapes.
    const error = await providerFetch(markerRequest('http://t104-nonexistent.invalid/api'), {
      timeoutMs: 5000,
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportNetworkError);
    expect((error as TransportNetworkError).kind).toBe('network');
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('reports socket termination before the response', async () => {
    server.setBehavior({ kind: 'abort' });
    const error = await providerFetch(markerRequest(`${server.url}/`), { timeoutMs: 5000 }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransportSocketError);
    expect((error as TransportSocketError).kind).toBe('socket');
    expect((error as TransportSocketError).causeCode).toBe('UND_ERR_SOCKET');
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('reports socket termination mid-body', async () => {
    const cutter = await startLocalServer((_req, res) => {
      ignoreStreamErrors(res);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
      setTimeout(() => res.socket?.destroy(), 40);
    });
    try {
      const error = await providerFetch(markerRequest(`${cutter.url}/`), {
        timeoutMs: 5000,
      }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(TransportSocketError);
      expect((error as TransportSocketError).kind).toBe('socket');
      expect(errorSurface(error)).not.toContain(MARKER);
    } finally {
      await cutter.close();
    }
  });

  it.each([401, 403, 500, 503])('observes HTTP %d without retrying', async (status) => {
    server.setBehavior({ kind: 'respond', status, body: '{"error":true}' });
    const attemptsBefore = server.requests.length;
    const error = await providerFetch(markerRequest(`${server.url}/`), { timeoutMs: 5000 }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransportStatusError);
    const statusError = error as TransportStatusError;
    expect(statusError.kind).toBe('http-status');
    expect(statusError.status).toBe(status);
    expect(statusError.retryAfter).toBeUndefined();
    expect(errorSurface(error)).not.toContain(MARKER);
    // A transport observation is exactly one attempt; the retry policy is
    // task 106, built on this seam later.
    expect(server.requests.length).toBe(attemptsBefore + 1);
  });

  it('observes HTTP 429 and carries the raw Retry-After value', async () => {
    server.setBehavior({
      kind: 'respond',
      status: 429,
      body: '{}',
      headers: { 'retry-after': '37' },
    });
    const error = await providerFetch(markerRequest(`${server.url}/`), { timeoutMs: 5000 }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransportStatusError);
    const statusError = error as TransportStatusError;
    expect(statusError.status).toBe(429);
    expect(statusError.retryAfter).toBe('37');
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('rejects redirects outright', async () => {
    // redirect: 'error' (D-042): stable provider endpoints never redirect,
    // and refusing removes any cross-origin credential-forwarding question.
    server.setBehavior({
      kind: 'respond',
      status: 301,
      headers: { location: `${server.url}/elsewhere` },
    });
    const error = await providerFetch(markerRequest(`${server.url}/`), { timeoutMs: 5000 }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransportNetworkError);
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('fails fast on a declared Content-Length over the cap', async () => {
    // The mock server always sets Content-Length, so an oversized body
    // through it exercises the fast path (D-042).
    server.setBehavior({
      kind: 'respond',
      status: 200,
      body: 'x'.repeat(MAX_RESPONSE_BODY_BYTES + 1),
    });
    const error = await providerFetch(markerRequest(`${server.url}/`), { timeoutMs: 5000 }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransportResponseTooLargeError);
    expect((error as TransportResponseTooLargeError).limitBytes).toBe(MAX_RESPONSE_BODY_BYTES);
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('accepts a body of exactly the default cap', async () => {
    server.setBehavior({
      kind: 'respond',
      status: 200,
      body: 'x'.repeat(MAX_RESPONSE_BODY_BYTES),
    });
    const result = await providerFetch({ url: `${server.url}/` }, { timeoutMs: 5000 });
    expect(result.bytes).toBe(MAX_RESPONSE_BODY_BYTES);
  });

  it('enforces the cap mid-read when no length is declared', async () => {
    // Chunked (length-less) responses bypass the fast path; the stream read
    // itself must bound memory.
    const chunky = await startLocalServer((_req, res) => {
      ignoreStreamErrors(res);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('x'.repeat(64));
      setTimeout(() => res.end('x'.repeat(64)), 20);
    });
    try {
      const error = await providerFetch(markerRequest(`${chunky.url}/`), {
        timeoutMs: 5000,
        maxResponseBytes: 65,
      }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(TransportResponseTooLargeError);
      expect((error as TransportResponseTooLargeError).limitBytes).toBe(65);
      expect(errorSurface(error)).not.toContain(MARKER);
    } finally {
      await chunky.close();
    }
  });

  it('honors a custom cap at the boundary', async () => {
    server.setBehavior({ kind: 'respond', status: 200, body: '12345678' });
    const exact = await providerFetch({ url: `${server.url}/` }, { maxResponseBytes: 8 });
    expect(exact.body).toBe('12345678');
    server.setBehavior({ kind: 'respond', status: 200, body: '123456789' });
    await expect(
      providerFetch({ url: `${server.url}/` }, { maxResponseBytes: 8 }),
    ).rejects.toBeInstanceOf(TransportResponseTooLargeError);
  });

  it('rejects a 2xx with a non-JSON content type', async () => {
    server.setBehavior({
      kind: 'respond',
      status: 200,
      body: '<html/>',
      headers: { 'content-type': 'text/plain' },
    });
    const error = await providerFetch(markerRequest(`${server.url}/`), { timeoutMs: 5000 }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransportContentTypeError);
    const contentType = error as TransportContentTypeError;
    expect(contentType.kind).toBe('content-type');
    expect(contentType.observedContentType).toBe('text/plain');
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('rejects a 2xx with no content type at all', async () => {
    const bare = await startLocalServer((_req, res) => {
      ignoreStreamErrors(res);
      res.writeHead(200);
      res.end('{}');
    });
    try {
      const error = await providerFetch(markerRequest(`${bare.url}/`), { timeoutMs: 5000 }).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(TransportContentTypeError);
      expect((error as TransportContentTypeError).observedContentType).toBe('');
      expect((error as TransportContentTypeError).message).toContain('none');
      expect(errorSurface(error)).not.toContain(MARKER);
    } finally {
      await bare.close();
    }
  });

  it('delivers an empty body for a bodiless 2xx', async () => {
    const empty = await startLocalServer((_req, res) => {
      ignoreStreamErrors(res);
      res.writeHead(204, { 'content-type': 'application/json' });
      res.end();
    });
    try {
      const result = await providerFetch({ url: `${empty.url}/` }, { timeoutMs: 5000 });
      expect(result.status).toBe(204);
      expect(result.body).toBe('');
      expect(result.bytes).toBe(0);
    } finally {
      await empty.close();
    }
  });

  it('stops and rejects when the caller aborts (spec §8.1)', async () => {
    server.setBehavior({ kind: 'respond', status: 200, body: '{}', delayMs: 400 });
    const controller = new AbortController();
    const promise = providerFetch(
      { ...markerRequest(`${server.url}/`), signal: controller.signal },
      { timeoutMs: 10_000 },
    );
    setTimeout(() => controller.abort(), 50);
    const error = await promise.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportAbortError);
    expect((error as TransportAbortError).kind).toBe('aborted');
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('scrubs credential material echoed back by the provider (spec §15.4)', async () => {
    server.setBehavior({
      kind: 'respond',
      status: 429,
      headers: { 'retry-after': MARKER },
    });
    const error = await providerFetch(markerRequest(`${server.url}/`), { timeoutMs: 5000 }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransportStatusError);
    expect((error as TransportStatusError).retryAfter).toBe('[REDACTED]');
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('scrubs credential material echoed into the content type', async () => {
    server.setBehavior({
      kind: 'respond',
      status: 200,
      body: '{}',
      headers: { 'content-type': `application/${MARKER}` },
    });
    const error = await providerFetch(markerRequest(`${server.url}/`), { timeoutMs: 5000 }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransportContentTypeError);
    expect((error as TransportContentTypeError).observedContentType).not.toContain(MARKER);
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('every transport error is a TransportError with a kind for task 105', async () => {
    server.setBehavior({ kind: 'respond', status: 503, body: '' });
    const error = await providerFetch({ url: `${server.url}/` }, { timeoutMs: 5000 }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransportError);
    expect(typeof (error as TransportError).kind).toBe('string');
    expect((error as TransportError).kind).toBe('http-status');
  });
});
