import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BODY_BYTES,
  TransportAbortError,
  TransportConnectionError,
  TransportContentTypeError,
  TransportDnsError,
  TransportNetworkError,
  TransportResponseTooLargeError,
  TransportSocketError,
  TransportStatusError,
  TransportTimeoutError,
  providerFetch,
  type ProviderHttpRequest,
} from '../../src/providers/transport';

/**
 * Unit coverage for the transport's pure halves (spec §7.2, §8.1, §17.1):
 * input validation, the failure taxonomy against the exact undici error
 * shapes verified on the pinned runtime (decision D-042), and the
 * injectable-fetch seam. Real-socket behavior lives in
 * test/integration/transport.spec.ts.
 */

/** The marker-secret scenario value (§15.4, §17.1); must never survive. */
const MARKER = 'qm-marker-secret-t104-unit';

/** A request whose credential surfaces (query + header) carry the marker. */
function markerRequest(url = `http://127.0.0.1:1/x?token=${MARKER}`): ProviderHttpRequest {
  return { url, headers: { authorization: `Bearer ${MARKER}` } };
}

/**
 * Builds the undici rejection shape for a network-level cause: the runtime
 * wraps the real error as `TypeError: fetch failed` with the cause attached
 * (verified against Node 22.13.0; D-042).
 */
function fetchFailed(code: string, causeMessage: string): TypeError {
  const cause = Object.assign(new Error(causeMessage), { code });
  const error = new TypeError('fetch failed');
  return Object.assign(error, { cause });
}

/** A fetch double that rejects immediately with a fixed error. */
function failingFetch(error: unknown): typeof globalThis.fetch {
  return (async () => {
    throw error;
  }) as typeof globalThis.fetch;
}

/** A fetch double that rejects with `error()` once its signal settles. */
function abortRejectingFetch(error: () => unknown): typeof globalThis.fetch {
  type FetchInput = Parameters<typeof globalThis.fetch>[0];
  type FetchInit = Parameters<typeof globalThis.fetch>[1];
  return ((_input: FetchInput, init?: FetchInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(error()), { once: true });
    })) as typeof globalThis.fetch;
}

/** Renders every string an error could leak a secret through. */
function errorSurface(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return [error.name, error.message, error.stack ?? '', JSON.stringify(error)].join('\n');
}

describe('providerFetch constants (spec §7.2, §7.4)', () => {
  it('pins the §7.2 default timeout and the 64 KiB body cap', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(MAX_RESPONSE_BODY_BYTES).toBe(64 * 1024);
  });
});

describe('providerFetch input validation', () => {
  it('rejects a malformed URL without echoing it', async () => {
    // A non-numeric port makes the URL constructor reject the string
    // outright — with the marker inside the would-be query.
    const malformed = `http://127.0.0.1:abc/?token=${MARKER}`;
    await expect(providerFetch({ url: malformed })).rejects.toThrow(
      /must be a valid absolute http\(s\) URL/u,
    );
    // The marker (here: in the query of the rejected URL) never surfaces.
    const error = await providerFetch({ url: malformed }).catch((thrown: unknown) => thrown);
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('rejects non-http(s) schemes', async () => {
    await expect(providerFetch({ url: 'ftp://127.0.0.1/files' })).rejects.toThrow(
      /must be a valid absolute http\(s\) URL/u,
    );
    await expect(providerFetch({ url: 'file:///etc/passwd' })).rejects.toThrow(
      /must be a valid absolute http\(s\) URL/u,
    );
  });

  it('rejects invalid timeout values', async () => {
    for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      await expect(providerFetch({ url: 'http://127.0.0.1:1/' }, { timeoutMs })).rejects.toThrow(
        /timeoutMs must be a positive finite number/u,
      );
    }
  });

  it('rejects invalid response caps', async () => {
    for (const maxResponseBytes of [0, -1, 1.5, Number.NaN]) {
      await expect(
        providerFetch({ url: 'http://127.0.0.1:1/' }, { maxResponseBytes }),
      ).rejects.toThrow(/maxResponseBytes must be a positive integer/u);
    }
  });

  it('rejects a URL that is not absolute', async () => {
    await expect(providerFetch({ url: '42' })).rejects.toThrow(/valid/u);
  });
});

describe('providerFetch failure classification (verified runtime shapes)', () => {
  it.each([
    ['ENOTFOUND', `getaddrinfo ENOTFOUND x.invalid`, TransportDnsError, 'dns'],
    ['EAI_AGAIN', 'getaddrinfo EAI_AGAIN api.example', TransportDnsError, 'dns'],
    [
      'ECONNREFUSED',
      'connect ECONNREFUSED 127.0.0.1:46597',
      TransportConnectionError,
      'connection',
    ],
    ['EHOSTUNREACH', 'connect EHOSTUNREACH 10.0.0.1:443', TransportConnectionError, 'connection'],
    ['ECONNRESET', 'read ECONNRESET', TransportSocketError, 'socket'],
    ['UND_ERR_SOCKET', 'other side closed', TransportSocketError, 'socket'],
  ] as const)('classifies cause code %s', async (code, causeMessage, errorClass, kind) => {
    const error = await providerFetch(markerRequest(), {
      timeoutMs: 5000,
      fetchImpl: failingFetch(fetchFailed(code, causeMessage)),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(errorClass);
    const transport = error as InstanceType<typeof errorClass>;
    expect(transport.kind).toBe(kind);
    expect(transport.causeCode).toBe(code);
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('classifies the codeless mid-body "terminated" rejection as a socket failure', async () => {
    const error = await providerFetch(markerRequest(), {
      timeoutMs: 5000,
      fetchImpl: failingFetch(new TypeError('terminated')),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportSocketError);
    expect((error as TransportSocketError).kind).toBe('socket');
  });

  it('classifies unclassifiable rejections (incl. the test guard shape) as network', async () => {
    const shapes: readonly unknown[] = [
      new TypeError('fetch failed'),
      new Error('Blocked outbound network request to "x.invalid" by the test no-network guard.'),
    ];
    for (const shape of shapes) {
      const error = await providerFetch(markerRequest(), {
        timeoutMs: 5000,
        fetchImpl: failingFetch(shape),
      }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(TransportNetworkError);
      expect((error as TransportNetworkError).kind).toBe('network');
      expect((error as TransportNetworkError).causeCode).toBeUndefined();
      expect(errorSurface(error)).not.toContain(MARKER);
    }
  });

  it('reports the internal deadline as a timeout even mid-body', async () => {
    const error = await providerFetch(markerRequest(), {
      timeoutMs: 20,
      // The runtime rejects a deadline-aborted body read with the timeout
      // signal's own DOMException; the classifier must rely on signal state.
      fetchImpl: abortRejectingFetch(
        () => new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      ),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportTimeoutError);
    expect((error as TransportTimeoutError).kind).toBe('timeout');
    expect((error as TransportTimeoutError).message).toContain('20 ms');
  });

  it('reports a caller abort distinctly from a timeout', async () => {
    const controller = new AbortController();
    const promise = providerFetch(
      { ...markerRequest(), signal: controller.signal },
      {
        timeoutMs: 5000,
        fetchImpl: abortRejectingFetch(
          () => new DOMException('This operation was aborted', 'AbortError'),
        ),
      },
    );
    controller.abort();
    const error = await promise.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportAbortError);
    expect((error as TransportAbortError).kind).toBe('aborted');
    expect(errorSurface(error)).not.toContain(MARKER);
  });
});

describe('providerFetch response handling (injectable fetch)', () => {
  it('delivers a 2xx application/json body', async () => {
    const body = '{"quota":{"used":10}}';
    const fetchImpl = (async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
    const result = await providerFetch({ url: 'http://127.0.0.1:1/' }, { fetchImpl });
    expect(result).toEqual({
      status: 200,
      contentType: 'application/json',
      body,
      bytes: Buffer.byteLength(body),
    });
  });

  it('rejects non-2xx with status, scrubbed status text, and the raw Retry-After', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"rate limited"}', {
        status: 429,
        statusText: MARKER,
        headers: { 'retry-after': MARKER },
      })) as typeof globalThis.fetch;
    const error = await providerFetch(markerRequest(), { fetchImpl }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransportStatusError);
    const status = error as TransportStatusError;
    expect(status.kind).toBe('http-status');
    expect(status.status).toBe(429);
    // A provider echoing the credential back gets it scrubbed (§15.4).
    expect(status.statusText).toBe('[REDACTED]');
    expect(status.retryAfter).toBe('[REDACTED]');
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('rejects a 2xx with a non-JSON content type, scrubbing the observed value', async () => {
    const fetchImpl = (async () =>
      new Response('<html/>', {
        status: 200,
        headers: { 'content-type': `text/plain; note=${MARKER}` },
      })) as typeof globalThis.fetch;
    const error = await providerFetch(markerRequest(), { fetchImpl }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransportContentTypeError);
    const contentType = error as TransportContentTypeError;
    expect(contentType.kind).toBe('content-type');
    expect(contentType.observedContentType).not.toContain(MARKER);
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('scrubs credential material from X- prefixed sensitive headers (review P2)', async () => {
    // `X-Api-Key` normalizes to `xapikey` — a spelling the D-025 vocabulary
    // does not carry — so the prefix-stripped form must stay in the scrub set.
    const fetchImpl = (async () =>
      new Response('', {
        status: 429,
        headers: { 'retry-after': MARKER },
      })) as typeof globalThis.fetch;
    const error = await providerFetch(
      { url: 'http://127.0.0.1:1/', headers: { 'x-api-key': MARKER } },
      { fetchImpl },
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportStatusError);
    expect((error as TransportStatusError).retryAfter).toBe('[REDACTED]');
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('enforces the response cap mid-read, allowing exactly the cap', async () => {
    const fetchImpl = (async () =>
      new Response('123456789', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
    const atCap = await providerFetch(
      { url: 'http://127.0.0.1:1/' },
      { fetchImpl, maxResponseBytes: 9 },
    );
    expect(atCap.bytes).toBe(9);
    const error = await providerFetch(markerRequest(), { fetchImpl, maxResponseBytes: 8 }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransportResponseTooLargeError);
    expect((error as TransportResponseTooLargeError).limitBytes).toBe(8);
    expect(errorSurface(error)).not.toContain(MARKER);
  });
});
