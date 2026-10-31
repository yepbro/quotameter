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

/**
 * A fetch double reproducing the lost abort-vs-read race (U-007): it waits
 * for the composed signal to abort — deadline or caller, whichever the test
 * arms — and then resolves the response anyway, exactly what undici does
 * when the abort loses to an already-delivered reply and the body closes
 * `done` instead of rejecting. `afterAbortMs` delays the resolution past
 * further events (e.g. a second signal firing).
 */
function abortLosingFetch(build: () => Response, afterAbortMs = 0): typeof globalThis.fetch {
  type FetchInput = Parameters<typeof globalThis.fetch>[0];
  type FetchInit = Parameters<typeof globalThis.fetch>[1];
  return ((_input: FetchInput, init?: FetchInit) =>
    new Promise<Response>((resolve) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          setTimeout(() => resolve(build()), afterAbortMs);
        },
        { once: true },
      );
    })) as typeof globalThis.fetch;
}

/** A bodiless 2xx the content-type gate accepts. */
function bodilessJsonResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

describe('providerFetch success-path abort classification (U-007, D-072)', () => {
  /**
   * The lost abort-vs-read race behind CI run 41162981449: undici may close
   * an aborted body stream as `done` instead of rejecting, so a
   * deadline-exceeded or caller-aborted exchange can reach the success
   * returns. D-042's signal-state authority applies there too — pinned here
   * deterministically through the injected fetch, no sockets.
   */

  it('classifies a done body resolved after the deadline as a timeout', async () => {
    const error = await providerFetch(markerRequest(), {
      timeoutMs: 20,
      fetchImpl: abortLosingFetch(
        () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportTimeoutError);
    expect((error as TransportTimeoutError).kind).toBe('timeout');
    expect((error as TransportTimeoutError).message).toContain('20 ms');
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('classifies a truncated done body after the deadline as a timeout', async () => {
    // The exact CI shape: the slow trickle body closed `done` mid-JSON and
    // the exchange resolved as a 200 instead of the §7.2 timeout it was.
    const error = await providerFetch(markerRequest(), {
      timeoutMs: 20,
      fetchImpl: abortLosingFetch(
        () =>
          new Response('{"partial":', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportTimeoutError);
    expect((error as TransportTimeoutError).kind).toBe('timeout');
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('classifies a done body resolved after a caller abort as an abort', async () => {
    const controller = new AbortController();
    const promise = providerFetch(
      { ...markerRequest(), signal: controller.signal },
      {
        timeoutMs: 5000,
        fetchImpl: abortLosingFetch(
          () =>
            new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
        ),
      },
    );
    setTimeout(() => controller.abort(), 25);
    const error = await promise.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportAbortError);
    expect((error as TransportAbortError).kind).toBe('aborted');
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('lets the deadline win when both signals fired before the body ended', async () => {
    const controller = new AbortController();
    const promise = providerFetch(
      { ...markerRequest(), signal: controller.signal },
      {
        timeoutMs: 20,
        // The composed signal aborts with the deadline at 20 ms; resolving
        // 150 ms later outlives the caller's 50 ms abort, so both signals
        // have fired when the body reaches `done` — the deadline outranks.
        fetchImpl: abortLosingFetch(
          () =>
            new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
          150,
        ),
      },
    );
    setTimeout(() => controller.abort(), 50);
    const error = await promise.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportTimeoutError);
    expect((error as TransportTimeoutError).kind).toBe('timeout');
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('delivers a body that completes with neither signal fired', async () => {
    const body = '{"ok":true}';
    const fetchImpl = (async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
    const result = await providerFetch(markerRequest(), { timeoutMs: 5000, fetchImpl });
    expect(result).toEqual({
      status: 200,
      contentType: 'application/json',
      body,
      bytes: Buffer.byteLength(body),
    });
  });

  it('classifies a bodiless 2xx resolved after the deadline as a timeout', async () => {
    const error = await providerFetch(markerRequest(), {
      timeoutMs: 20,
      fetchImpl: abortLosingFetch(() => bodilessJsonResponse(204)),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportTimeoutError);
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('classifies a bodiless 2xx resolved after a caller abort as an abort', async () => {
    const controller = new AbortController();
    const promise = providerFetch(
      { ...markerRequest(), signal: controller.signal },
      { timeoutMs: 5000, fetchImpl: abortLosingFetch(() => bodilessJsonResponse(204)) },
    );
    setTimeout(() => controller.abort(), 25);
    const error = await promise.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportAbortError);
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('keeps a delivered non-2xx an observation even after the deadline fired', async () => {
    // An arrived status is more actionable than the race it lost (D-072):
    // re-classifying it as a timeout would misroute §7.2's 429 and 401/403
    // rows into the retryable timeout row.
    const error = await providerFetch(markerRequest(), {
      timeoutMs: 20,
      fetchImpl: abortLosingFetch(() => new Response('x', { status: 503 })),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportStatusError);
    expect((error as TransportStatusError).status).toBe(503);
    expect((error as TransportStatusError).kind).toBe('http-status');
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('keeps a delivered wrong content type an observation even after the deadline fired', async () => {
    const error = await providerFetch(markerRequest(), {
      timeoutMs: 20,
      fetchImpl: abortLosingFetch(
        () => new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportContentTypeError);
    expect((error as TransportContentTypeError).kind).toBe('content-type');
    expect(errorSurface(error)).not.toContain(MARKER);
  });

  it('keeps an over-cap response an observation even after the deadline fired', async () => {
    // The third observation leg of D-072: the cap violation is the
    // actionable truth — both the declared-length fast path and the
    // mid-read enforcement classify by the cap, never by the race.
    const fastPath = await providerFetch(markerRequest(), {
      timeoutMs: 20,
      maxResponseBytes: 8,
      fetchImpl: abortLosingFetch(
        () =>
          new Response('x'.repeat(10), {
            status: 200,
            headers: { 'content-type': 'application/json', 'content-length': '10' },
          }),
      ),
    }).catch((thrown: unknown) => thrown);
    expect(fastPath).toBeInstanceOf(TransportResponseTooLargeError);
    expect((fastPath as TransportResponseTooLargeError).kind).toBe('response-too-large');
    expect((fastPath as TransportResponseTooLargeError).limitBytes).toBe(8);

    const midRead = await providerFetch(markerRequest(), {
      timeoutMs: 20,
      maxResponseBytes: 8,
      fetchImpl: abortLosingFetch(
        () =>
          new Response('x'.repeat(10), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    }).catch((thrown: unknown) => thrown);
    expect(midRead).toBeInstanceOf(TransportResponseTooLargeError);
    expect(errorSurface(midRead)).not.toContain(MARKER);
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

  it('ignores a failing body release on the non-2xx path (U-016)', async () => {
    // cancel() only releases a discarded body's socket; a runtime whose
    // release itself rejects must not mask the status observation with
    // that failure. A real ReadableStream's cancel always resolves, so
    // the double is the only deterministic route to the no-op catch.
    const unreleasable = {
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Headers(),
      body: { cancel: () => Promise.reject(new Error('release failed')) },
    };
    const fetchImpl = (async () => unreleasable as unknown as Response) as typeof globalThis.fetch;
    const error = await providerFetch(markerRequest(), {
      timeoutMs: 5000,
      fetchImpl,
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportStatusError);
    const status = error as TransportStatusError;
    expect(status.kind).toBe('http-status');
    expect(status.status).toBe(503);
    expect(status.statusText).toBe('Service Unavailable');
    expect(status.retryAfter).toBeUndefined();
    expect(errorSurface(error)).not.toContain('release failed');
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

describe('exact taxonomy messages (U-006 mutation triage)', () => {
  /** Runs providerFetch against a fixed rejection and returns the error. */
  async function failureOf(error: unknown): Promise<unknown> {
    return providerFetch(markerRequest(), {
      timeoutMs: 5000,
      fetchImpl: failingFetch(error),
    }).catch((thrown: unknown) => thrown);
  }

  it('pins the dns, connection, and socket messages with their cause code', async () => {
    const dns = await failureOf(fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND x.invalid'));
    expect((dns as Error).message).toBe('provider hostname could not be resolved (ENOTFOUND)');
    const connection = await failureOf(
      fetchFailed('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:46597'),
    );
    expect((connection as Error).message).toBe('connection to the provider failed (ECONNREFUSED)');
    const socket = await failureOf(fetchFailed('UND_ERR_SOCKET', 'other side closed'));
    expect((socket as Error).message).toBe(
      'provider connection was reset or terminated (UND_ERR_SOCKET)',
    );
  });

  it('pins the network message without a cause-code suffix', async () => {
    const network = await failureOf(new TypeError('fetch failed'));
    expect((network as Error).message).toBe('provider network request failed');
    expect((network as TransportNetworkError).causeCode).toBeUndefined();
  });

  it('pins the aborted message', async () => {
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
    expect((error as Error).message).toBe('provider request was aborted by the caller');
  });

  it('pins the response-too-large message', async () => {
    const fetchImpl = (async () =>
      new Response('123456789', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
    const error = await providerFetch(markerRequest(), { fetchImpl, maxResponseBytes: 8 }).catch(
      (thrown: unknown) => thrown,
    );
    expect((error as Error).message).toBe('provider response exceeded the 8-byte limit');
  });

  it('ignores a non-string cause code instead of suffixing it', async () => {
    const cause = Object.assign(new Error('weird runtime'), { code: 42 });
    const error = await failureOf(Object.assign(new TypeError('fetch failed'), { cause }));
    expect(error).toBeInstanceOf(TransportNetworkError);
    expect((error as Error).message).toBe('provider network request failed');
  });

  it('classifies a thrown non-Error (null) as a plain network failure', async () => {
    const error = await failureOf(null);
    expect(error).toBeInstanceOf(TransportNetworkError);
    expect((error as TransportNetworkError).causeCode).toBeUndefined();
  });
});

describe('status and content-type rendering (U-006 mutation triage)', () => {
  it('pins the HTTP status message with status text, space included', async () => {
    const fetchImpl = (async () =>
      new Response('x', { status: 500, statusText: 'Server Error' })) as typeof globalThis.fetch;
    const error = await providerFetch({ url: 'http://127.0.0.1:1/' }, { fetchImpl }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransportStatusError);
    expect((error as Error).message).toBe('provider responded with HTTP 500 Server Error');
  });

  it('pins the HTTP status message without status text, no trailing space', async () => {
    const fetchImpl = (async () =>
      new Response('x', { status: 500, statusText: '' })) as typeof globalThis.fetch;
    const error = await providerFetch({ url: 'http://127.0.0.1:1/' }, { fetchImpl }).catch(
      (thrown: unknown) => thrown,
    );
    expect((error as Error).message).toBe('provider responded with HTTP 500');
  });

  it('pins the content-type message with the observed type', async () => {
    const fetchImpl = (async () =>
      new Response('<html/>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof globalThis.fetch;
    const error = await providerFetch({ url: 'http://127.0.0.1:1/' }, { fetchImpl }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransportContentTypeError);
    expect((error as Error).message).toBe(
      'provider response content type was not application/json (observed: text/html)',
    );
  });

  it('accepts application/json with parameters, keeping the raw header', async () => {
    const fetchImpl = (async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })) as typeof globalThis.fetch;
    const result = await providerFetch({ url: 'http://127.0.0.1:1/' }, { fetchImpl });
    expect(result.contentType).toBe('application/json; charset=utf-8');
    expect(result.body).toBe('{"ok":true}');
  });

  it('trims padding around the media type before comparing it', async () => {
    // A space before the parameter separator keeps the media type
    // "application/json " after the split — only the trim makes it match.
    const fetchImpl = (async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json ; charset=utf-8' },
      })) as typeof globalThis.fetch;
    const result = await providerFetch({ url: 'http://127.0.0.1:1/' }, { fetchImpl });
    expect(result.contentType).toBe('application/json ; charset=utf-8');
    expect(result.body).toBe('{"ok":true}');
  });
});

describe('header scrubbing scope (U-006 mutation triage)', () => {
  /** A fetch double answering 500 with the given status text. */
  function echoFetch(statusText: string): typeof globalThis.fetch {
    return (async () => new Response('', { status: 500, statusText })) as typeof globalThis.fetch;
  }

  it('leaves non-sensitive header text and empty sensitive values alone', async () => {
    const error = await providerFetch(
      {
        url: 'http://127.0.0.1:1/',
        headers: { 'x-note': 'plain-value', accept: 'text/plain', 'x-api-key': '' },
      },
      { fetchImpl: echoFetch('plain-value') },
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportStatusError);
    // No [REDACTED] and no per-character mangling: the empty value is skipped
    // and the non-sensitive names are outside the scrub set.
    expect((error as Error).message).toBe('provider responded with HTTP 500 plain-value');
  });

  it('scrubs X-Api-Key whole values but not scheme-stripped halves', async () => {
    const error = await providerFetch(
      { url: 'http://127.0.0.1:1/', headers: { 'x-api-key': 'Bearer sk-cred' } },
      { fetchImpl: echoFetch('sk-cred') },
    ).catch((thrown: unknown) => thrown);
    // The whole header value is a secret; the bare credential after a scheme
    // is extracted only for Authorization-style headers (D-025 vocabulary).
    expect((error as Error).message).toBe('provider responded with HTTP 500 sk-cred');
  });

  it('keeps the x-prefix rule narrow: a PAuthorization header is not sensitive', async () => {
    const error = await providerFetch(
      { url: 'http://127.0.0.1:1/', headers: { PAuthorization: 'sk-cred' } },
      { fetchImpl: echoFetch('sk-cred') },
    ).catch((thrown: unknown) => thrown);
    // 'pauthorization' is not in the D-025 set and does not start with 'x';
    // its value must stay visible verbatim.
    expect((error as Error).message).toBe('provider responded with HTTP 500 sk-cred');
  });

  it('extracts and scrubs the bare credential of Authorization headers', async () => {
    const cases: ReadonlyArray<{ header: string; headerValue: string; echo: string }> = [
      { header: 'authorization', headerValue: 'Bearer sk-cred', echo: 'sk-cred' },
      { header: 'Authorization', headerValue: '  Bearer sk-pad  ', echo: 'sk-pad' },
      { header: 'Authorization', headerValue: 'Bearer  sk-wide', echo: 'sk-wide' },
      { header: 'Authorization', headerValue: 'Bearer sk two', echo: 'sk two' },
      { header: 'Proxy-Authorization', headerValue: 'Basic sk-proxy', echo: 'sk-proxy' },
    ];
    for (const { header, headerValue, echo } of cases) {
      const error = await providerFetch(
        { url: 'http://127.0.0.1:1/', headers: { [header]: headerValue } },
        { fetchImpl: echoFetch(echo) },
      ).catch((thrown: unknown) => thrown);
      expect(error as Error, `echo of ${JSON.stringify(echo)}`).toBeInstanceOf(
        TransportStatusError,
      );
      expect((error as Error).message).toBe('provider responded with HTTP 500 [REDACTED]');
    }
  });

  it('does not extract a scheme from a single-token Authorization value', async () => {
    const error = await providerFetch(
      { url: 'http://127.0.0.1:1/', headers: { authorization: 'sk-only' } },
      { fetchImpl: echoFetch('Oops') },
    ).catch((thrown: unknown) => thrown);
    expect((error as Error).message).toBe('provider responded with HTTP 500 Oops');
  });
});

describe('protocol and body-shape handling (U-006 mutation triage)', () => {
  it('accepts https URLs', async () => {
    const fetchImpl = (async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
    const result = await providerFetch({ url: 'https://provider.example/api' }, { fetchImpl });
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"ok":true}');
  });

  it('handles bodyless error and content-type responses without touching a null body', async () => {
    const statusError = await providerFetch(
      { url: 'http://127.0.0.1:1/' },
      { fetchImpl: (async () => new Response(null, { status: 500 })) as typeof globalThis.fetch },
    ).catch((thrown: unknown) => thrown);
    expect(statusError).toBeInstanceOf(TransportStatusError);
    expect((statusError as Error).message).toBe('provider responded with HTTP 500');

    const contentTypeError = await providerFetch(
      { url: 'http://127.0.0.1:1/' },
      {
        fetchImpl: (async () =>
          new Response(null, {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          })) as typeof globalThis.fetch,
      },
    ).catch((thrown: unknown) => thrown);
    expect(contentTypeError).toBeInstanceOf(TransportContentTypeError);
    expect((contentTypeError as Error).message).toBe(
      'provider response content type was not application/json (observed: text/plain)',
    );
  });

  it('delivers a bodyless 2xx application/json response as an empty body', async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
    const result = await providerFetch({ url: 'http://127.0.0.1:1/' }, { fetchImpl });
    expect(result).toEqual({ status: 200, contentType: 'application/json', body: '', bytes: 0 });
  });

  it('enforces the declared content-length before reading, exactly at the cap', async () => {
    const fetchImpl = (async () =>
      new Response('123456789', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '9' },
      })) as typeof globalThis.fetch;
    const atCap = await providerFetch(
      { url: 'http://127.0.0.1:1/' },
      { fetchImpl, maxResponseBytes: 9 },
    );
    expect(atCap.bytes).toBe(9);
  });

  it('rejects a lying content-length before a single body byte is read', async () => {
    const fetchImpl = (async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '999' },
      })) as typeof globalThis.fetch;
    const error = await providerFetch(
      { url: 'http://127.0.0.1:1/' },
      { fetchImpl, maxResponseBytes: 64 },
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransportResponseTooLargeError);
    expect((error as TransportResponseTooLargeError).limitBytes).toBe(64);
  });
});
