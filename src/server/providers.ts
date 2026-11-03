/**
 * Provider composition (spec §8.1; tasks 133/U-040).
 *
 * `src/server/` is the composition root — the one layer the package layout
 * allows to import concrete provider adapters — so the factory that hands
 * another top-level consumer a production adapter lives here. Its first
 * consumer is the CLI's `init` connection test (spec §5.3 step 6): the
 * initial account's credentials are checked through `validateCredentials`
 * before the configuration is written. The server's own bootstrap
 * composition (`./composition.ts`, task U-040) registers the same adapter
 * into the `ProviderRegistry`, wrapped by {@link observingManualTests} so
 * manual tests feed the §7.2 suspension holder; this factory constructs and
 * never registers, so the two uses cannot interfere.
 */

import type { AccountContext, QuotaProvider } from '../providers/registry';
import { keyIdentityOfSecret, type AccountSuspensions } from '../services/account-suspensions';
import { ZaiCodingPlanProvider } from '../providers/zai-coding-plan';

/**
 * The provider behind `init`'s initial-account connection test (spec §5.3
 * step 6): v1.0's one supported provider (§8.3), constructed with its
 * production defaults — the dossier base URLs and the §7.2 default 15 s
 * request deadline, one GET, no retries (the credential check's own
 * contract, task 098/D-052).
 */
export function createInitialAccountProvider(): QuotaProvider {
  return new ZaiCodingPlanProvider();
}

/* ── Manual-test observation (§7.2's suspension lift, task U-040/D-140) ─── */

/** What {@link observingManualTests} feeds the suspension holder with. */
export interface ManualTestObservationOptions {
  /** The composition's D-064 holder (D-130's `suspensionOf` seam owner). */
  readonly suspensions: AccountSuspensions;
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
 * suspension holder (task U-040, D-140): the *request* applies D-064's
 * unconditional release ("until … a manual test is requested"), the attempt
 * then runs unchanged, and a key-refused rejection (D-052's
 * `credentials-rejected`) re-enters suspension with a fresh 60-minute
 * window. A successful attempt ends released — the §7.2 lift. Every other
 * member delegates verbatim, and every rejection rethrows unchanged, so the
 * accounts test endpoint's own classification is the wire's only authority.
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
  const { suspensions } = options;
  return {
    id: provider.id,
    name: provider.name,
    ...(provider.metricCatalog !== undefined ? { metricCatalog: provider.metricCatalog } : {}),
    async validateCredentials(account: AccountContext): Promise<void> {
      suspensions.manualTestRequested(account.accountId);
      try {
        await provider.validateCredentials(account);
      } catch (error) {
        if (isCredentialsRejected(error)) {
          suspensions.manualTestRejected(account.accountId, keyIdentityOfSecret(account.secret));
        }
        throw error;
      }
    },
    fetchSnapshot(account, signal) {
      // Deliberately NOT observed: `fetchSnapshot` is the polling cycle's
      // seam, and polled cycles feed D-064 through the polling engine (with
      // its own admission pacing) when it joins the composition — observing
      // here would double-feed the machine from two holders.
      return provider.fetchSnapshot(account, signal);
    },
  };
}
