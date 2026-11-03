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
 * load the accounts and providers lists).
 */
export function healthyApiBody(input: string): unknown {
  if (input === '/api/accounts') return { accounts: [] };
  if (input === '/api/providers') return { providers: [] };
  return { status: 'ok' };
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
