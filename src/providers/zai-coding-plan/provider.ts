/**
 * ZaiCodingPlanProvider — the Z.ai Coding Plan adapter (spec §8.3; tasks
 * 098–099, decisions D-052/D-053).
 *
 * The adapter island `src/providers/zai-coding-plan/` (island rules: only
 * `src/schemas/`, `src/util/`, and the provider core are importable;
 * nothing outside `src/providers/` imports this except the composition
 * root). Task 098 delivered the skeleton with
 * {@link ZaiCodingPlanProvider.validateCredentials} — the status-based
 * credential check of [`validate.ts`](validate.ts). Task 099 adds
 * {@link ZaiCodingPlanProvider.fetchSnapshot} — the three-GET collection
 * cycle of [`snapshot.ts`](snapshot.ts) with the §8.4 metric mapping of
 * [`mapping.ts`](mapping.ts) (task 100 refines and verifies that mapping);
 * registration in the composition root is a later assembly task, so
 * nothing here edits `src/server/**`.
 */

import { createSystemClock, type Clock } from '../../util/clock';
import type { ProviderSnapshot } from '../../schemas/metrics';
import type { AccountContext, QuotaProvider } from '../registry';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../transport';
import type { SnapshotLogger, ZaiSnapshotUrls } from './snapshot';
import { collectZaiSnapshot } from './snapshot';
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
 * The quota-surface API base the collection cycle reads (dossier 093: the
 * monitor/biz endpoints live on the host `https://api.z.ai`, *not* under
 * the coding base — spec §8.3's warning that the coding base URL "must not
 * be assumed to be a quota-statistics endpoint"), the production default
 * behind {@link ZaiCodingPlanProviderOptions.apiBaseUrl}.
 */
export const DEFAULT_API_BASE_URL = 'https://api.z.ai';

/** The credential-check path appended to the coding base (dossier endpoint 4). */
export const CREDENTIAL_CHECK_PATH = '/models';

/** Dossier endpoint 1 — the primary quota-metrics GET (096 request table). */
const QUOTA_LIMIT_PATH = '/api/monitor/usage/quota/limit';
/** Dossier endpoint 2 — the subscription-records GET (plan-name context). */
const SUBSCRIPTION_LIST_PATH = '/api/biz/subscription/list';
/** Dossier endpoint 3 — the reset-cards GET (context only; maps nothing in v1). */
const RESET_CARDS_PATH = '/api/biz/customer-package-reset/list';
/** The one known query parameter of endpoint 3 (A8: personal scope only). */
const RESET_CARDS_TARGET_TYPE = 'PERSONAL';

/** Options adjusting the adapter; all default to the dossier values. */
export interface ZaiCodingPlanProviderOptions {
  /**
   * The Coding Plan API base URL the credential check is served from.
   * Injectable so tests point the adapter at the loopback mock provider
   * server; defaults to {@link DEFAULT_CODING_BASE_URL}.
   */
  readonly codingBaseUrl?: string;
  /**
   * The quota-surface base URL the collection cycle's three GETs are served
   * from (dossier endpoints 1–3). Injectable for the loopback mock provider
   * server; defaults to {@link DEFAULT_API_BASE_URL}.
   */
  readonly apiBaseUrl?: string;
  /**
   * The §7.2 total request deadline, per request: a cycle makes up to three
   * sequential requests, each with its own deadline (D-047). The spec's
   * 5–60 s configuration range is enforced where configuration enters
   * (later tasks wire it); tests need short deadlines, so any positive
   * finite value is accepted here — the transport's own rule.
   */
  readonly timeoutMs?: number;
  /**
   * The sink for skip reports and soft-failure warnings (endpoints 2/3
   * degradation, unrecognized limits entries). A structural `Pick` of the
   * D-025 logger: the composition root passes the application logger, tests
   * capture calls; absent means silent — the adapter never creates output
   * sinks itself.
   */
  readonly logger?: SnapshotLogger;
  /**
   * The clock stamping `collectedAt` (spec §10: business logic never reads
   * machine time directly). Defaults to the system clock.
   */
  readonly clock?: Clock;
}

/**
 * Parses and validates a base URL the way the adapter's URL composers
 * require (D-052's stance, reused): absolute http(s), no query, fragment,
 * or userinfo, and trailing slashes on the path normalized so `{base}/`
 * and `{base}` address the same endpoint. Echo-free (§15.4 discipline).
 */
function parseBaseUrl(raw: string, optionName: string): URL {
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw new TypeError(`ZaiCodingPlanProvider: ${optionName} must be an absolute http(s) URL`);
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TypeError(`ZaiCodingPlanProvider: ${optionName} must be an absolute http(s) URL`);
  }
  if (base.search !== '' || base.hash !== '') {
    throw new TypeError(`ZaiCodingPlanProvider: ${optionName} must not carry a query or fragment`);
  }
  if (base.username !== '' || base.password !== '') {
    // Silent stripping (origin drops userinfo) would quietly alter a wiring
    // mistake; fail fast instead — this module's stated stance.
    throw new TypeError(`ZaiCodingPlanProvider: ${optionName} must not carry URL credentials`);
  }
  return base;
}

/**
 * Composes the credential-check URL from a coding base URL (dossier
 * endpoint 4 — never part of a collection cycle).
 */
export function composeCredentialCheckUrl(codingBaseUrl: string): string {
  const base = parseBaseUrl(codingBaseUrl, 'codingBaseUrl');
  return `${base.origin}${base.pathname.replace(/\/+$/u, '')}${CREDENTIAL_CHECK_PATH}`;
}

/**
 * Composes the collection cycle's three GET URLs from a quota-surface base
 * URL (dossier endpoints 1–3; task 099). Endpoint 3 carries its one known
 * query parameter, `targetType=PERSONAL` (A8), built through the `URL` API
 * so the encoding is canonical.
 */
export function composeSnapshotUrls(apiBaseUrl: string): ZaiSnapshotUrls {
  const base = parseBaseUrl(apiBaseUrl, 'apiBaseUrl');
  const origin = `${base.origin}${base.pathname.replace(/\/+$/u, '')}`;
  const resetCards = new URL(`${origin}${RESET_CARDS_PATH}`);
  resetCards.searchParams.set('targetType', RESET_CARDS_TARGET_TYPE);
  return {
    quotaLimit: `${origin}${QUOTA_LIMIT_PATH}`,
    subscriptionList: `${origin}${SUBSCRIPTION_LIST_PATH}`,
    resetCards: resetCards.toString(),
  };
}

/**
 * The Z.ai Coding Plan adapter (spec §8.3): `validateCredentials` runs the
 * dossier's status-based credential check ([`validate.ts`](validate.ts));
 * `fetchSnapshot` runs the three-GET collection cycle
 * ([`snapshot.ts`](snapshot.ts)) — endpoint 1 strictly, endpoints 2/3
 * softly — and stamps the result with the adapter identity. Every failure
 * carries only non-secret facts. Created by the composition root with
 * default options; nothing provider-specific is parsed outside this island.
 */
export class ZaiCodingPlanProvider implements QuotaProvider {
  readonly id = ZAI_CODING_PLAN_PROVIDER_ID;
  readonly name = 'Z.ai Coding Plan';
  readonly #credentialCheckUrl: string;
  readonly #snapshotUrls: ZaiSnapshotUrls;
  readonly #timeoutMs: number;
  readonly #logger: SnapshotLogger | undefined;
  readonly #clock: Clock;

  constructor(options: ZaiCodingPlanProviderOptions = {}) {
    this.#credentialCheckUrl = composeCredentialCheckUrl(
      options.codingBaseUrl ?? DEFAULT_CODING_BASE_URL,
    );
    this.#snapshotUrls = composeSnapshotUrls(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('ZaiCodingPlanProvider: timeoutMs must be a positive finite number');
    }
    this.#timeoutMs = timeoutMs;
    this.#logger = options.logger;
    this.#clock = options.clock ?? createSystemClock();
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
   * Collects one normalized snapshot for the account (spec §8.1, §8.3):
   * the dossier's endpoint trio through the shared transport, the caller's
   * abort signal composed into every exchange (D-042). Rejects with the
   * re-thrown D-042 `TransportError` when endpoint 1 fails at the transport
   * level (task 105 classifies the kind), or with a `SnapshotParseError`
   * carrying the §7.4 sanitized payload when its body fails validation —
   * endpoints 2/3 failures degrade softly and are logged. See
   * [`snapshot.ts`](snapshot.ts) for the cycle contract.
   */
  async fetchSnapshot(account: AccountContext, signal: AbortSignal): Promise<ProviderSnapshot> {
    const collected = await collectZaiSnapshot(account, signal, {
      urls: this.#snapshotUrls,
      timeoutMs: this.#timeoutMs,
      logger: this.#logger,
      clock: this.#clock,
    });
    return { providerId: ZAI_CODING_PLAN_PROVIDER_ID, ...collected };
  }
}
