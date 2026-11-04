/**
 * The typed API client — the UI's single data layer over the §13 surface
 * (task 169, spec §13, §14; decision D-134).
 *
 * One factory, {@link createApiClient}, with one method per landed §13
 * route, grouped by endpoint family. Request and response types come from
 * the server's own TypeBox contracts through **type-only imports**: the
 * imports are erased at build time, so the browser bundle carries neither
 * the schema modules nor `@sinclair/typebox`/fastify behind them — the
 * coupling is compile-time truth, zero runtime weight. The endpoint
 * families still to land (peak-hours, task 162; auth, task 180) join
 * as new methods here, the same pattern; the history/events families
 * landed with task 174 (D-139's grammar: ISO-8601 request boundaries,
 * epoch-ms responses).
 *
 * Success bodies are trusted casts, not re-validated: the same-origin
 * server serializes through the same closed schemas (the D-111/D-128
 * guard), and a body that is not JSON at all is caught as the
 * `unexpected` error kind — a second validator in the browser would
 * re-buy, per payload, what the wire contract already guarantees
 * (D-134).
 *
 * §15.3 mutation contract (D-117): every state-changing method carries
 * the dedicated nonstandard header {@link API_MUTATION_HEADER} (presence
 * is the CSRF property; the value is uninterpreted) and types its body
 * `application/json` — exactly when a body is sent, matching the server's
 * body-bound content-type leg. GETs carry neither header. The header name
 * is a UI-local constant pinned against the server's
 * `API_MUTATION_HEADER_NAME` by a component test, instead of a runtime
 * import that would drag the server module graph into the bundle.
 *
 * Every call runs under a deadline (default
 * {@link API_DEFAULT_TIMEOUT_MS}) with optional caller cancellation: the
 * two abort sources are composed manually onto one controller so the
 * failure taxonomy can tell a deliberate `aborted` from the client's own
 * `timeout` — and every failure collapses onto the one
 * {@link ApiClientError} class the presentation layer consumes.
 */

import type { HealthResponse } from '../../../src/schemas/api/health';
import type {
  AccountMutationResult,
  AccountTestResponse,
  AccountView,
  AccountsListResponse,
  CreateAccountBody,
  UpdateAccountBody,
} from '../../../src/schemas/api/accounts';
import type { ProvidersListResponse } from '../../../src/schemas/api/providers';
import type { EventsResponse, HistoryResponse } from '../../../src/schemas/api/history';
import type {
  SettingsResponse,
  UpdateSettingsBody,
  UpdateSettingsResponse,
} from '../../../src/schemas/api/settings';
import type { QuotaResponse, StatusResponse } from '../../../src/schemas/api/status';
import { ApiClientError, parseApiErrorEnvelope } from './error';

/**
 * The §15.3 mutation header (decision D-117) as the client's own constant:
 * the server's `API_MUTATION_HEADER_NAME` is the single source on its
 * side, and `test/component/api-client.spec.ts` pins this value against
 * it — a runtime import would carry the server module graph into the
 * browser bundle for the sake of one string.
 */
export const API_MUTATION_HEADER = 'X-Quotameter-Request';

/**
 * The header value — any non-empty value satisfies the server (presence
 * is the whole CSRF proof, D-117); a short constant keeps it honest.
 */
const API_MUTATION_HEADER_VALUE = '1';

/** The same-origin API base (spec §13; CSP `connect-src 'self'`, D-127). */
const API_BASE_URL = '/api';

/**
 * The per-request deadline. §15.5 pins server-side timeouts only; the
 * client needs its own bound so a hung request cannot freeze a page —
 * 15 s is far above every same-origin round trip (the heaviest landed
 * route is the settings write) while staying inside human patience, and
 * per-client override exists for the heavier future families (161/162).
 */
export const API_DEFAULT_TIMEOUT_MS = 15_000;

/** §13's state-changing methods — the §15.3 header/content-type set. */
const MUTATION_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The response surface the client reads — a structural subset of the
 * DOM `Response`, so tests provide plain objects and nothing depends on
 * the full class. The browser's `fetch` satisfies it as-is.
 */
export interface ApiFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/**
 * The fetch seam: injectable per client (the theme-storage precedent,
 * D-133), structural over exactly what the client uses.
 */
export type ApiFetch = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal: AbortSignal;
  },
) => Promise<ApiFetchResponse>;

/** {@link createApiClient} options — every one injectable for tests. */
export interface ApiClientOptions {
  /** The fetch implementation; defaults to the global `fetch`. */
  readonly fetchImpl?: ApiFetch;
  /** Request base; defaults to the same-origin {@link API_BASE_URL}. */
  readonly baseUrl?: string;
  /** Per-request deadline; defaults to {@link API_DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** One request as the endpoint helpers declare it. */
interface RequestSpec {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  /** Query entries; `undefined` values are omitted, `false` is kept. */
  readonly query?: Record<string, string | boolean | undefined>;
  /** JSON-serialized when present (this also arms the content-type leg). */
  readonly body?: unknown;
  /** Caller cancellation, composed with the client's own deadline. */
  readonly signal?: AbortSignal;
}

/** Builds the request URL: base + path + serialized query. */
function buildUrl(baseUrl: string, path: string, query: RequestSpec['query']): string {
  // Tolerate a trailing slash on the base (the seam's callers spell both
  // `/api` and `/api/`): composing must never double the separator.
  const url = `${baseUrl.replace(/\/+$/u, '')}${path}`;
  if (query === undefined) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    // Only `undefined` omits an entry: a deliberate `false` (an honest
    // archive request beside `purgeHistory: true`) must serialize.
    if (value !== undefined) params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized === '' ? url : `${url}?${serialized}`;
}

/** The client the plugin provides and the pages consume (§14, task 170+). */
export interface ApiClient {
  /** `GET /api/health` — the public liveness response (§13). */
  readonly health: {
    get(signal?: AbortSignal): Promise<HealthResponse>;
  };
  /** `GET /api/status` — service state and per-account §7.3 statuses. */
  readonly status: {
    get(signal?: AbortSignal): Promise<StatusResponse>;
  };
  /** `GET /api/quota?accountId=…` — the latest valid values of one account. */
  readonly quota: {
    get(accountId: string, signal?: AbortSignal): Promise<QuotaResponse>;
  };
  /** `GET /api/providers` — available provider types with schedules. */
  readonly providers: {
    list(signal?: AbortSignal): Promise<ProvidersListResponse>;
  };
  /**
   * The accounts management surface (§13, D-128). `remove` is the §13
   * archive/purge split: `purgeHistory: true` sends the destructive
   * `?purgeHistory=true` spelling explicitly.
   */
  readonly accounts: {
    list(signal?: AbortSignal): Promise<AccountsListResponse>;
    create(body: CreateAccountBody, signal?: AbortSignal): Promise<AccountView>;
    update(id: string, body: UpdateAccountBody, signal?: AbortSignal): Promise<AccountView>;
    remove(
      id: string,
      options?: { readonly purgeHistory?: boolean },
      signal?: AbortSignal,
    ): Promise<AccountMutationResult>;
    test(id: string, signal?: AbortSignal): Promise<AccountTestResponse>;
  };
  /** The safe settings view and the runtime-modification update (§13, D-130). */
  readonly settings: {
    get(signal?: AbortSignal): Promise<SettingsResponse>;
    update(body: UpdateSettingsBody, signal?: AbortSignal): Promise<UpdateSettingsResponse>;
  };
  /**
   * The range-bearing history family (§13, D-139): one account/metric
   * series over an ISO-8601 window, and the account-level §12.2
   * timeline. `from`/`to` must carry an explicit offset or `Z` (the
   * server's strict parse gate); the page computes them as rolling
   * bounds ending now (§10, D-068/D-147). `maxPoints` and `metric`
   * (the events filter) are the optional §13 refinements — omitted
   * here, the server applies its documented defaults.
   */
  readonly history: {
    get(
      query: {
        readonly accountId: string;
        readonly metric: string;
        readonly from: string;
        readonly to: string;
        readonly maxPoints?: number;
      },
      signal?: AbortSignal,
    ): Promise<HistoryResponse>;
  };
  readonly events: {
    list(
      query: {
        readonly accountId: string;
        readonly from: string;
        readonly to: string;
        readonly metric?: string;
      },
      signal?: AbortSignal,
    ): Promise<EventsResponse>;
  };
}

/**
 * Creates the API client. The returned object carries the request
 * pipeline (deadline, mutation headers, JSON handling, error taxonomy) —
 * pure TypeScript, no Vue: the provide/inject half lives in
 * `ui/src/api/index.ts`.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetchImpl: ApiFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const baseUrl = options.baseUrl ?? API_BASE_URL;
  const timeoutMs = options.timeoutMs ?? API_DEFAULT_TIMEOUT_MS;

  /**
   * The three-way transport-failure discrimination, shared by the fetch
   * dispatch and the body read (a connection can drop mid-body): the
   * caller's signal outranks the deadline — a deliberate cancellation
   * stays `aborted` even when the race is close — and everything else is
   * an honest `network` failure.
   */
  function transportFailure(
    signal: AbortSignal | undefined,
    timedOut: boolean,
    cause: unknown,
  ): ApiClientError {
    if (signal?.aborted === true) return new ApiClientError({ kind: 'aborted', cause });
    if (timedOut) return new ApiClientError({ kind: 'timeout', cause });
    return new ApiClientError({ kind: 'network', cause });
  }

  async function request<T>(spec: RequestSpec): Promise<T> {
    if (spec.signal?.aborted === true) {
      // An already-aborted signal never fires its listener — answer the
      // deliberate cancellation outright, as the native fetch would.
      throw new ApiClientError({ kind: 'aborted' });
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (MUTATION_METHODS.has(spec.method)) {
      headers[API_MUTATION_HEADER] = API_MUTATION_HEADER_VALUE;
    }
    let body: string | undefined;
    if (spec.body !== undefined) {
      // §15.3's content-type leg is body-bound (D-117): only a request
      // that carries a payload types it — a bodiless mutation (DELETE,
      // the future logout) sends the dedicated header alone.
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(spec.body);
    }

    // Manual abort composition: one controller the deadline timer and the
    // caller's signal both fire into, so `fetch` sees one signal and the
    // catch side can tell WHO aborted by the flags. The guard below spans
    // the headers phase AND the body read: `fetch` resolves at headers, a
    // responder can stall the body after them, and a caller can cancel
    // mid-body (route change, unmount) — the deadline and the listener
    // stay armed until the whole exchange settles, so both phases are
    // bounded, cancellable, and classified by who aborted.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = (): void => controller.abort();
    spec.signal?.addEventListener('abort', onCallerAbort);

    let responseOk: boolean;
    let responseStatus: number;
    let text: string;
    try {
      const response = await fetchImpl(buildUrl(baseUrl, spec.path, spec.query), {
        method: spec.method,
        headers,
        body,
        signal: controller.signal,
      });
      responseOk = response.ok;
      responseStatus = response.status;
      text = await response.text();
    } catch (cause) {
      throw transportFailure(spec.signal, timedOut, cause);
    } finally {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onCallerAbort);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiClientError({ kind: 'unexpected', status: responseStatus });
    }
    const envelope = parseApiErrorEnvelope(parsed);
    if (envelope !== undefined) {
      // The §13 envelope — whatever the status said, the body is an
      // error answer: classify `rejected` with the facts carried.
      throw new ApiClientError({
        kind: 'rejected',
        status: responseStatus,
        code: envelope.error.code,
        serverMessage: envelope.error.message,
        serverDetails: envelope.error.details,
      });
    }
    if (!responseOk) {
      // A non-2xx that is JSON but not the envelope — some other
      // responder's error shape (a proxy, a captive portal).
      throw new ApiClientError({ kind: 'unexpected', status: responseStatus });
    }
    // Trusted cast (D-134): the same-origin server serializes through the
    // same closed schemas this type came from.
    return parsed as T;
  }

  return {
    health: {
      get: (signal) => request<HealthResponse>({ method: 'GET', path: '/health', signal }),
    },
    status: {
      get: (signal) => request<StatusResponse>({ method: 'GET', path: '/status', signal }),
    },
    quota: {
      get: (accountId, signal) =>
        request<QuotaResponse>({ method: 'GET', path: '/quota', query: { accountId }, signal }),
    },
    providers: {
      list: (signal) =>
        request<ProvidersListResponse>({ method: 'GET', path: '/providers', signal }),
    },
    accounts: {
      list: (signal) => request<AccountsListResponse>({ method: 'GET', path: '/accounts', signal }),
      create: (body, signal) =>
        request<AccountView>({ method: 'POST', path: '/accounts', body, signal }),
      update: (id, body, signal) =>
        request<AccountView>({
          method: 'PATCH',
          path: `/accounts/${encodeURIComponent(id)}`,
          body,
          signal,
        }),
      remove: (id, options, signal) =>
        request<AccountMutationResult>({
          method: 'DELETE',
          path: `/accounts/${encodeURIComponent(id)}`,
          query: { purgeHistory: options?.purgeHistory },
          signal,
        }),
      test: (id, signal) =>
        request<AccountTestResponse>({
          method: 'POST',
          path: `/accounts/${encodeURIComponent(id)}/test`,
          signal,
        }),
    },
    settings: {
      get: (signal) => request<SettingsResponse>({ method: 'GET', path: '/settings', signal }),
      update: (body, signal) =>
        request<UpdateSettingsResponse>({ method: 'PUT', path: '/settings', body, signal }),
    },
    history: {
      get: (query, signal) =>
        request<HistoryResponse>({
          method: 'GET',
          path: '/history',
          query: {
            accountId: query.accountId,
            metric: query.metric,
            from: query.from,
            to: query.to,
            maxPoints: query.maxPoints === undefined ? undefined : String(query.maxPoints),
          },
          signal,
        }),
    },
    events: {
      list: (query, signal) =>
        request<EventsResponse>({
          method: 'GET',
          path: '/events',
          query: {
            accountId: query.accountId,
            from: query.from,
            to: query.to,
            metric: query.metric,
          },
          signal,
        }),
    },
  };
}
