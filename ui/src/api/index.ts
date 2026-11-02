/**
 * The API layer's Vue-facing half (task 169, spec §13, §14; decision
 * D-134): the provided-client seam and the call-state composable the
 * pages consume. The pure client lives in `./client`, the taxonomy in
 * `./error`.
 *
 * A factory + plugin + inject getter, exactly the router (D-131), i18n
 * (D-132), and theme (D-133) shape: the composition root installs the
 * real client, every component test installs its own with an injectable
 * fetch — no module singleton, no cross-test state, and no component
 * reaches for a global. This module is the contract tasks 170+ consume:
 * `const api = useApi()` once per component, then
 * `useApiCall(() => api.…)` per request.
 */

import { inject, ref, type App, type InjectionKey, type Ref } from 'vue';
import { createApiClient, type ApiClient, type ApiClientOptions } from './client';
import { isApiClientError, type ApiClientError } from './error';

export { createApiClient } from './client';
export type { ApiClient, ApiClientOptions, ApiFetch, ApiFetchResponse } from './client';
export { API_DEFAULT_TIMEOUT_MS, API_MUTATION_HEADER } from './client';
export { ApiClientError, isApiClientError, parseApiErrorEnvelope } from './error';
export type { ApiClientErrorKind, ApiErrorEnvelope } from './error';

const apiInjectionKey: InjectionKey<ApiClient> = Symbol('quotameter-api');

/** The provided client, as an installable plugin (the `useTheme` precedent). */
export interface ApiClientPlugin extends ApiClient {
  /** Vue plugin installation — provides the client to the app. */
  install(app: App): void;
}

/**
 * Creates the API client as an app plugin. Accepts the same options as
 * {@link createApiClient}; the composition root passes none (the global
 * `fetch`, the same-origin base, the default deadline), tests pass a
 * fake `fetchImpl`.
 */
export function createApiClientPlugin(options: ApiClientOptions = {}): ApiClientPlugin {
  const client: ApiClient = createApiClient(options);
  return {
    ...client,
    install(app: App): void {
      app.provide(apiInjectionKey, client);
    },
  };
}

/** The installed API client; throws with its remedy when the plugin is missing. */
export function useApi(): ApiClient {
  const client = inject(apiInjectionKey);
  if (client === undefined) {
    throw new Error(
      'useApi() requires the API client plugin (createApiClientPlugin()) to be installed',
    );
  }
  return client;
}

/** The reactive state of one API call — the shared page-level pattern. */
export interface ApiCallState<T> {
  /** The last success result; `null` before the first success and after a failure. */
  readonly data: Ref<T | null>;
  /** The taxonomy error when the call failed; `null` otherwise. */
  readonly error: Ref<ApiClientError | null>;
  /** True while the newest call is in flight. */
  readonly pending: Ref<boolean>;
  /**
   * Runs the call. Resolves the data on success and `null` on a taxonomy
   * failure (the error is in `error`); anything else the call throws is
   * rethrown — a programming error stays loud instead of rendering as a
   * wire failure. Two deliberate non-failures also resolve `null` without
   * touching `error`: a caller cancellation (`kind === 'aborted'` — a
   * cancelled request is not an error to present, D-134) and a superseded
   * run (a newer `execute()` started before this one settled — only the
   * newest run may write state, so a retry or an argument change cannot
   * have a stale result overwrite it).
   */
  readonly execute: () => Promise<T | null>;
}

/**
 * The per-request composable every page reuses (task 169's wiring, kept
 * by 170+): run a client call, keep its data/error/pending state, render
 * `error` through the shared notice component. One composable per
 * request; the call is a thunk so re-running (retry, parameter change)
 * re-enters with fresh arguments.
 */
export function useApiCall<T>(call: () => Promise<T>): ApiCallState<T> {
  const data = ref<T | null>(null) as Ref<T | null>;
  const error = ref<ApiClientError | null>(null);
  const pending = ref(false);
  // The re-entry token: bumped by every execute(), compared before any
  // state write — a superseded run settles silently, so overlapping
  // calls (double click, fast argument change) never race the newest.
  let run = 0;

  async function execute(): Promise<T | null> {
    const token = ++run;
    error.value = null;
    pending.value = true;
    let result: T;
    try {
      result = await call();
    } catch (thrown) {
      // A programming error stays loud whatever its age.
      if (!isApiClientError(thrown)) throw thrown;
      if (token === run) {
        pending.value = false;
        if (thrown.kind !== 'aborted') {
          // A deliberate cancellation is not a failure (D-134): resolve
          // quietly, leaving the previously loaded data in place.
          data.value = null;
          error.value = thrown;
        }
      }
      return null;
    }
    if (token === run) {
      data.value = result;
      pending.value = false;
    }
    return result;
  }

  return { data, error, pending, execute };
}
