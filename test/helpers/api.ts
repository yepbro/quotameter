import type { ApiFetch, ApiFetchResponse } from '../../ui/src/api/client';

/**
 * Deterministic fakes for the API client's injectable fetch seam (task
 * 169; decision D-134): component tests install per-mount `FakeFetch`
 * instead of the browser's `fetch`, so requests are observable
 * (method/URL/headers/body recorded) and responses are programmed per
 * case — no happy-dom globals, no network, the theme-storage precedent
 * (D-133) applied to the data layer.
 */

/** One dispatched request, exactly as the client built it. */
export interface RecordedCall {
  readonly input: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal: AbortSignal;
}

/** A `Response`-shaped answer: the structural surface the client reads. */
export function jsonResponse(status: number, body: unknown): ApiFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/** A non-JSON answer — the HTML error page / proxy junk shape. */
export function textResponse(status: number, body: string): ApiFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  };
}

/**
 * The fake `fetch`: records every call and answers through the
 * programmed handler, rejecting on `signal` abort like the native fetch
 * (the client's abort paths need a transport that actually refuses).
 */
export class FakeFetch {
  readonly calls: RecordedCall[] = [];

  /**
   * @param handler answers each recorded call; a throwing/rejecting
   * handler is the network-failure arm.
   */
  constructor(private readonly handler: (call: RecordedCall) => Promise<ApiFetchResponse>) {}

  /** The `ApiFetch` to pass as `fetchImpl`. */
  readonly impl: ApiFetch = (input, init) => {
    const call: RecordedCall = {
      input,
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    };
    this.calls.push(call);
    return new Promise<ApiFetchResponse>((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('The request was aborted')));
      void this.handler(call).then(resolve, reject);
    });
  };
}

/** A handler that never answers — for timeout and cancellation cases. */
export function neverRespond(): () => Promise<ApiFetchResponse> {
  return () => new Promise<ApiFetchResponse>(() => undefined);
}

/**
 * A healthy §13 body per route the shell's pages load, for component
 * tests that mount the whole app: success bodies are trusted casts
 * (D-134), so a one-shape answer for every URL is a lie the consumers
 * choke on once a page loads real routes (task 170 made `/accounts`
 * load the accounts and providers lists; task 172 made `/` load the
 * status, settings, and — when an account is selected — quota routes;
 * task 174 added the range-keyed history/events loads, exactly as
 * D-139's consequences recorded).
 */
export function healthyApiBody(input: string): unknown {
  if (input === '/api/accounts') return { accounts: [] };
  if (input === '/api/providers') return { providers: [] };
  if (input === '/api/status') {
    return { status: 'ok', pollingIntervalSeconds: 300, accounts: [] };
  }
  if (input === '/api/settings') return healthySettingsBody();
  if (input.startsWith('/api/quota?')) {
    // The honest empty quota view (§7.2): no snapshot, no metrics.
    return {
      accountId: new URLSearchParams(input.slice('/api/quota?'.length)).get('accountId') ?? '',
      status: 'fresh',
      collectedAt: null,
      planName: null,
      metrics: [],
    };
  }
  if (input.startsWith('/api/history?')) return healthyHistoryBody(input);
  if (input.startsWith('/api/events?')) return healthyEventsBody(input);
  return { status: 'ok' };
}

/**
 * A minimal valid `GET /api/settings` body — the overview reads its
 * display time zone (`UTC`, deterministic in tests) and history
 * retention from here.
 */
export function healthySettingsBody(historyRetentionDays = 365): unknown {
  const annotated = (value: unknown) => ({
    value,
    source: 'file',
    restartRequired: false,
  });
  return {
    settings: {
      server: {
        host: annotated('127.0.0.1'),
        port: annotated(8642),
      },
      app: {
        timezone: annotated('UTC'),
        pollingIntervalSeconds: annotated(300),
        historyRetentionDays: annotated(historyRetentionDays),
      },
      auth: {
        mode: annotated('auto'),
        passwordConfigured: false,
      },
      logging: {
        level: annotated('warn'),
      },
    },
    paths: { configPath: '/tmp/quotameter/config.json', dataDir: '/tmp/quotameter/data' },
  };
}

/**
 * The range report both range-bearing routes echo (D-139): the healthy
 * arm passes the request through untouched (`outcome: 'ok'`, no
 * horizon). The parsed request parameters are echoed as epoch-ms
 * integers — one format per direction.
 */
function healthyRangeReport(
  input: string,
  routePrefix: string,
): {
  outcome: 'ok';
  requestedFrom: number;
  requestedTo: number;
  effectiveFrom: number;
  effectiveTo: number;
  retentionHorizon: null;
} {
  const params = new URLSearchParams(input.slice(routePrefix.length));
  const requestedFrom = Date.parse(params.get('from') ?? '');
  const requestedTo = Date.parse(params.get('to') ?? '');
  return {
    outcome: 'ok',
    requestedFrom,
    requestedTo,
    effectiveFrom: requestedFrom,
    effectiveTo: requestedTo,
    retentionHorizon: null,
  };
}

/** A minimal valid `GET /api/history` body: an honest empty series. */
export function healthyHistoryBody(input: string): unknown {
  const params = new URLSearchParams(input.slice('/api/history?'.length));
  return {
    accountId: params.get('accountId') ?? '',
    metric: params.get('metric') ?? '',
    unit: null,
    limitType: null,
    range: healthyRangeReport(input, '/api/history?'),
    downsampled: false,
    resolutionMs: null,
    sourcePointCount: 0,
    points: [],
  };
}

/** A minimal valid `GET /api/events` body: an honest empty timeline. */
export function healthyEventsBody(input: string): unknown {
  const params = new URLSearchParams(input.slice('/api/events?'.length));
  return {
    accountId: params.get('accountId') ?? '',
    metric: params.get('metric'),
    range: healthyRangeReport(input, '/api/events?'),
    events: [],
  };
}

/** A handler that always rejects — the network-failure arm. */
export function networkFailure(reason = 'Failed to fetch'): () => Promise<ApiFetchResponse> {
  return () => Promise.reject(new TypeError(reason));
}

/**
 * A response whose headers arrived but whose body never will on its own:
 * `text()` rejects only when the request's signal aborts — the stalled-
 * body transport shape (the native fetch behaves the same: the body
 * stream dies with the request). The body-phase deadline and the
 * caller-abort tests ride on it.
 */
export function stalledBodyResponse(signal: AbortSignal): ApiFetchResponse {
  return {
    ok: true,
    status: 200,
    text: () =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('The body read was aborted')));
      }),
  };
}
