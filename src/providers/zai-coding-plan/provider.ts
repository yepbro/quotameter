/**
 * ZaiCodingPlanProvider — the Z.ai Coding Plan adapter (spec §8.3; task 098,
 * decision D-052).
 *
 * First module of the adapter island `src/providers/zai-coding-plan/`
 * (island rules: only `src/schemas/`, `src/util/`, and the provider core are
 * importable; nothing outside `src/providers/` imports this except the
 * composition root). Task 098 delivers the provider skeleton with
 * {@link ZaiCodingPlanProvider.validateCredentials} — the status-based
 * credential check of [`validate.ts`](validate.ts) — while
 * {@link ZaiCodingPlanProvider.fetchSnapshot} (task 099) and the §8.4 metric
 * mapping (task 100) land next; registration in the composition root is a
 * later assembly task, so nothing here edits `src/server/**`.
 */

import type { ProviderSnapshot } from '../../schemas/metrics';
import type { AccountContext, QuotaProvider } from '../registry';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../transport';
import { validateZaiCredentials } from './validate';

/** Stable adapter id (spec §8.1): the registry key and snapshot `providerId`. */
export const ZAI_CODING_PLAN_PROVIDER_ID = 'zai-coding-plan';

/**
 * The Coding Plan OpenAI-compatible API base (dossier sources 3 and 6: the
 * ZCode configuration and quick-start endpoint tables), the production
 * default behind {@link ZaiCodingPlanProviderOptions.codingBaseUrl}.
 */
export const DEFAULT_CODING_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';

/**
 * The credential-check path appended to the coding base — dossier endpoint 4
 * (`GET {coding-base}/models`, never part of a collection cycle).
 */
export const CREDENTIAL_CHECK_PATH = '/models';

/**
 * The loud not-yet stub for {@link ZaiCodingPlanProvider.fetchSnapshot}
 * (task 099 owns the method). The 070 contract types `fetchSnapshot` as a
 * required method and `ProviderRegistry.register` checks it is a function,
 * so a missing method would fail assembly; a pinned, self-identifying
 * rejection is the honest interim.
 */
export const SNAPSHOT_NOT_IMPLEMENTED_MESSAGE =
  'zai-coding-plan: fetchSnapshot is not implemented yet (planned by task 099)';

/** Options adjusting the adapter; both default to the dossier values. */
export interface ZaiCodingPlanProviderOptions {
  /**
   * The Coding Plan API base URL the credential check is served from.
   * Injectable so tests point the adapter at the loopback mock provider
   * server; defaults to {@link DEFAULT_CODING_BASE_URL}.
   */
  readonly codingBaseUrl?: string;
  /**
   * The §7.2 total request deadline for the credential check. The spec's
   * 5–60 s configuration range is enforced where configuration enters
   * (later tasks wire it); tests need short deadlines, so any positive
   * finite value is accepted here — the transport's own rule.
   */
  readonly timeoutMs?: number;
}

/**
 * Composes the credential-check URL from a coding base URL (dossier
 * endpoint 4). Validated eagerly and echo-free (a base URL carries no
 * secret, but §15.4 discipline is cheap here): the base must be an absolute
 * http(s) URL without a query or fragment, and trailing slashes on the path
 * are normalized so `{base}/` and `{base}` request the same endpoint.
 */
export function composeCredentialCheckUrl(codingBaseUrl: string): string {
  let base: URL;
  try {
    base = new URL(codingBaseUrl);
  } catch {
    throw new TypeError('ZaiCodingPlanProvider: codingBaseUrl must be an absolute http(s) URL');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TypeError('ZaiCodingPlanProvider: codingBaseUrl must be an absolute http(s) URL');
  }
  if (base.search !== '' || base.hash !== '') {
    throw new TypeError('ZaiCodingPlanProvider: codingBaseUrl must not carry a query or fragment');
  }
  if (base.username !== '' || base.password !== '') {
    // Silent stripping (origin drops userinfo) would quietly alter a wiring
    // mistake; fail fast instead — this module's stated stance.
    throw new TypeError('ZaiCodingPlanProvider: codingBaseUrl must not carry URL credentials');
  }
  return `${base.origin}${base.pathname.replace(/\/+$/u, '')}${CREDENTIAL_CHECK_PATH}`;
}

/**
 * The Z.ai Coding Plan adapter (spec §8.3): `validateCredentials` runs the
 * dossier's status-based credential check; every failure is a
 * `CredentialCheckError` subclass from [`validate.ts`](validate.ts) carrying
 * only non-secret facts. Created by the composition root with default
 * options; nothing provider-specific is parsed outside this island.
 */
export class ZaiCodingPlanProvider implements QuotaProvider {
  readonly id = ZAI_CODING_PLAN_PROVIDER_ID;
  readonly name = 'Z.ai Coding Plan';
  readonly #credentialCheckUrl: string;
  readonly #timeoutMs: number;

  constructor(options: ZaiCodingPlanProviderOptions = {}) {
    this.#credentialCheckUrl = composeCredentialCheckUrl(
      options.codingBaseUrl ?? DEFAULT_CODING_BASE_URL,
    );
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('ZaiCodingPlanProvider: timeoutMs must be a positive finite number');
    }
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Checks the account's credentials (the "test connection" action, spec
   * §8.2): resolves when Z.ai accepts the key, rejects with a
   * `CredentialsRejectedError` (401/403, dossier A3) or a
   * `ProviderUnavailableError` (any other transport failure). See
   * [`validate.ts`](validate.ts) for the full contract.
   */
  async validateCredentials(account: AccountContext): Promise<void> {
    await validateZaiCredentials(account, {
      url: this.#credentialCheckUrl,
      timeoutMs: this.#timeoutMs,
    });
  }

  /**
   * Not implemented by task 098 — task 099 lands the collection flow over
   * the dossier's endpoint trio. Until then this loud stub rejects with
   * {@link SNAPSHOT_NOT_IMPLEMENTED_MESSAGE} so no caller can mistake the
   * skeleton for a working poller; the registry contract (070) requires the
   * method to exist, which is why it is present at all.
   * The 070 contract is satisfied with a narrower parameter list (a method
   * taking fewer arguments implements the interface), which also keeps the
   * unused-parameter lint honest until real parameters arrive with 099.
   */
  async fetchSnapshot(): Promise<ProviderSnapshot> {
    throw new Error(SNAPSHOT_NOT_IMPLEMENTED_MESSAGE);
  }
}
