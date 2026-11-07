/**
 * Provider composition (spec §8.1; tasks 133/U-040, U-054).
 *
 * `src/server/` is the composition root — the one layer the package layout
 * allows to import concrete provider adapters — so the factories that hand
 * other top-level consumers a production adapter live here. Two factories,
 * two worlds (U-054, D-179):
 *
 * - {@link createConfiguredZaiProvider} — the server's own bootstrap
 *   composition (`./composition.ts`) registers its product into the
 *   `ProviderRegistry` as the default adapter, wrapped by
 *   {@link observingManualTests} so manual tests feed the §7.2 suspension
 *   holder. It derives the §7.2 request deadline from the LIVE effective
 *   configuration at every request (§6.4-live, D-026) and receives the
 *   composition's shared clock (D-021) and shared logger.
 * - {@link createInitialAccountProvider} — the CLI's pre-configuration
 *   paths: `init`'s initial-account connection test (spec §5.3 step 6,
 *   which D-102 orders before the configuration write — the write is
 *   step 5's configuration half, deferred to the run's end, so a fresh
 *   run has no file yet and a re-run keeps the same answer-driven
 *   factory rather than reading the file's provider section) and
 *   `doctor`'s per-account connectivity probes (a diagnostic whose probe
 *   budget deliberately stays the spec's own default — independent of
 *   the configuration under test). Both keep the D-052 default 15 s
 *   deadline (recorded in D-179).
 */

import type { AccountContext, QuotaProvider } from '../providers/registry';
import { keyIdentityOfSecret, type AccountSuspensions } from '../services/account-suspensions';
import { ZaiCodingPlanProvider, ZAI_CODING_PLAN_PROVIDER_ID } from '../providers/zai-coding-plan';
import { CONFIG_DEFAULTS, type Config } from '../schemas/config';
import type { Clock } from '../util/clock';
import type { Logger } from '../util/logger';

/* ── The production adapter factories (U-054, D-179) ────────────────────── */

/**
 * Options of {@link createConfiguredZaiProvider}; every member is an
 * injection seam the composition satisfies from its shared services.
 */
export interface ConfiguredZaiProviderOptions {
  /**
   * The live effective-configuration reader (the reloader's
   * `current().config`): every request derives the §7.2 deadline from the
   * configuration effective at that request, so a reload changing
   * `providers.zai-coding-plan.requestTimeoutSeconds` — a §6.4 live field
   * (D-026: it "governs the next request") — applies with no restart, no
   * re-registration, and no wiring rebuild.
   */
  readonly config: () => Config;
  /** The shared clock (D-021): the adapter's one source of `collectedAt`. */
  readonly clock: Clock;
  /**
   * The shared redacting logger (§16): the adapter's skip reports and
   * endpoints-2/3 soft-failure warnings ride it — without it the
   * degradation the dossier allows would be silent in production logs.
   */
  readonly logger: Logger;
  /**
   * The credential-check base URL, passed through to the adapter verbatim.
   * The adapter's own loopback-mock test seam; production omits it (the
   * dossier default), and so does the composition.
   */
  readonly codingBaseUrl?: string;
  /**
   * The quota-surface base URL, passed through to the adapter verbatim —
   * the adapter's own loopback-mock test seam; production omits it (the
   * dossier default), and so does the composition.
   */
  readonly apiBaseUrl?: string;
}

/**
 * The production Z.ai adapter behind the composition's registry default
 * (spec §6.2, §6.4, §7.2, §8.3; task U-054, decision D-179): a live-reader
 * factory whose every `validateCredentials`/`fetchSnapshot` call delegates
 * to a `ZaiCodingPlanProvider` constructed with `{ timeoutMs, clock, logger }`
 * derived from the live configuration. The inner adapter is memoized by the
 * effective timeout value — an unchanged configuration reuses one instance,
 * a reload that changes the seconds constructs the replacement on the next
 * request (the lazy form of D-026's "governs the next request").
 *
 * Why a live reader instead of an eager rebuild on the reload feed: the
 * registry entry's identity never changes, so the manual-test observation
 * wrapper stays intact, and the polling recorders — which capture
 * `registry.get(...)` once per wiring build — hold the live wrapper and can
 * never keep a stale deadline. This is the house pattern for §6.4-live
 * values consumed on the request path (the `pollingIntervalSeconds` and
 * peak-hours `schedules()` readers, the retention window's read-at-run-time).
 *
 * The seconds value is trusted, not re-validated: the 5–60 s §7.2 range is
 * enforced where configuration enters (the schema and the load pipeline) —
 * the same stance the transport takes for `timeoutMs` (D-042).
 */
export function createConfiguredZaiProvider(options: ConfiguredZaiProviderOptions): QuotaProvider {
  const { config, clock, logger } = options;
  const baseUrls = {
    ...(options.codingBaseUrl === undefined ? {} : { codingBaseUrl: options.codingBaseUrl }),
    ...(options.apiBaseUrl === undefined ? {} : { apiBaseUrl: options.apiBaseUrl }),
  };
  /**
   * The adapter for the CURRENTLY effective deadline, memoized by value:
   * `timeoutMs` is the one option that varies with the configuration, so it
   * is the whole cache key — clock and logger are process-singletons.
   */
  let memo: { readonly timeoutMs: number; readonly adapter: ZaiCodingPlanProvider } | undefined;
  const adapterFor = (): ZaiCodingPlanProvider => {
    const seconds =
      config().providers?.[ZAI_CODING_PLAN_PROVIDER_ID]?.requestTimeoutSeconds ??
      CONFIG_DEFAULTS.provider.requestTimeoutSeconds;
    const timeoutMs = seconds * 1000;
    if (memo?.timeoutMs === timeoutMs) return memo.adapter;
    const adapter = new ZaiCodingPlanProvider({ timeoutMs, clock, logger, ...baseUrls });
    memo = { timeoutMs, adapter };
    return adapter;
  };
  // Constructed once eagerly: the adapter facts below are static (they never
  // vary with the deadline), and an eager construction surfaces any wiring
  // fault at composition time, not at the first polled request.
  const initial = adapterFor();
  return {
    id: initial.id,
    name: initial.name,
    // The concrete adapter always declares its D-137 catalog — no
    // conditional copy here (unlike the generic observingManualTests input).
    metricCatalog: initial.metricCatalog,
    validateCredentials: (account: AccountContext) => adapterFor().validateCredentials(account),
    fetchSnapshot: (account: AccountContext, signal: AbortSignal) =>
      adapterFor().fetchSnapshot(account, signal),
  };
}

/**
 * The provider behind the CLI's pre-configuration connection tests: v1.0's
 * one supported provider (§8.3) with its D-052 defaults — the dossier base
 * URLs and the §7.2 default 15 s request deadline, one GET, no retries.
 * Used by `init`'s initial-account test (spec §5.3 step 6, which D-102
 * orders before the configuration write — the write is step 5's
 * configuration half, deferred to the run's end, so a fresh run has no
 * file yet and a re-run keeps the same answer-driven factory) and
 * `doctor`'s per-account connectivity probes (a diagnostic whose probe
 * budget deliberately stays the spec's own default, independent of the
 * configuration under test). The running service's registry default is
 * {@link createConfiguredZaiProvider} instead; the split is D-179.
 */
export function createInitialAccountProvider(): QuotaProvider {
  return new ZaiCodingPlanProvider();
}

/* ── Manual-test observation (§7.2's suspension lift, task U-040/D-140) ─── */

/** What {@link observingManualTests} feeds the suspension store with. */
export interface ManualTestObservationOptions {
  /** The shared D-064 store (D-130's `suspensionOf` seam owner). */
  readonly suspensions: AccountSuspensions;
  /**
   * The manual-test bridge into the polling engine (U-051, D-176): invoked
   * with the account id right after the store's release, before the attempt
   * — both §7.2 release events ("until … a manual test is requested") land
   * at one site. The composition wires the engine's `requestManualTest`, so
   * the engine owes the account one attempt through the dispatch loop
   * (sequential and overlap rules hold; its own release application over
   * the shared store is the idempotent no-op after this wrapper's).
   * Optional and absent in the wrapper's own unit tests; errors propagate
   * (a broken bridge is a wiring bug, the D-059 loud-seam convention).
   */
  readonly onManualTestRequested?: (accountId: string) => void;
  /**
   * The rejection half of the bridge: invoked right after the holder's
   * `manualTestRejected` feed (a D-052 `credentials-rejected` rejection),
   * so the engine drops any still-owed manual attempt — the key the
   * provider just refused has nothing left to try, and the shared store's
   * probe cadence (already re-entered by the wrapper's application, the
   * one D-064 feed for this event) owns the next attempt (§7.2's pause).
   * Optional like the request half; errors propagate the same way.
   */
  readonly onManualTestRejected?: (accountId: string) => void;
}

/**
 * Reads the D-052 credential-check discriminant off a thrown value, the same
 * structural read the accounts test endpoint uses: `kind` plus a string
 * `message`, provider-neutral and adapter-type-free.
 */
function isCredentialsRejected(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const kind = (error as { readonly kind?: unknown }).kind;
  const message = (error as { readonly message?: unknown }).message;
  return kind === 'credentials-rejected' && typeof message === 'string';
}

/**
 * Wraps one provider adapter so its manual connection tests feed the §7.2
 * suspension store (task U-040, D-140; the single-application site since
 * FSM-3/D-189): the *request* applies D-064's unconditional release ("until
 * … a manual test is requested"), the attempt then runs unchanged, and a
 * key-refused rejection (D-052's `credentials-rejected`) re-enters
 * suspension with a fresh 60-minute window — under the TESTED key's
 * identity, the key the provider actually refused. A successful attempt
 * ends released — the §7.2 lift. Every other member delegates verbatim,
 * and every rejection rethrows unchanged, so the accounts test endpoint's
 * own classification is the wire's only authority. This wrapper is the ONE
 * application site for both manual-test events: the engine bridges below
 * only owe/drop the manual attempt, so the store can never be fed twice
 * with different identities.
 *
 * The key identity reported on a rejection comes from the holder module's
 * own {@link keyIdentityOfSecret} — the same vocabulary the composition's
 * configuration observation reports, so the machine compares like with like.
 *
 * The observation rides the provider (not the route) because the route
 * families are landed contracts; this module is the composition root — the
 * one layer allowed to compose adapters (the registry docblock's own rule).
 */
export function observingManualTests(
  provider: QuotaProvider,
  options: ManualTestObservationOptions,
): QuotaProvider {
  const { suspensions, onManualTestRequested, onManualTestRejected } = options;
  return {
    id: provider.id,
    name: provider.name,
    ...(provider.metricCatalog !== undefined ? { metricCatalog: provider.metricCatalog } : {}),
    async validateCredentials(account: AccountContext): Promise<void> {
      suspensions.manualTestRequested(account.accountId);
      onManualTestRequested?.(account.accountId);
      try {
        await provider.validateCredentials(account);
      } catch (error) {
        if (isCredentialsRejected(error)) {
          suspensions.manualTestRejected(account.accountId, keyIdentityOfSecret(account.secret));
          onManualTestRejected?.(account.accountId);
        }
        throw error;
      }
    },
    fetchSnapshot(account, signal) {
      // Deliberately NOT observed: `fetchSnapshot` is the polling cycle's
      // seam, and polled cycles feed D-064 through the engine's settle path
      // into the shared store (with its own admission pacing) — observing
      // here would double-feed the one store from two sites.
      return provider.fetchSnapshot(account, signal);
    },
  };
}
