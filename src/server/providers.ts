/**
 * Provider composition (spec §8.1; task 133).
 *
 * `src/server/` is the composition root — the one layer the package layout
 * allows to import concrete provider adapters — so the factory that hands
 * another top-level consumer a production adapter lives here. Its first
 * consumer is the CLI's `init` connection test (spec §5.3 step 6): the
 * initial account's credentials are checked through `validateCredentials`
 * before the configuration is written. When the server's own bootstrap
 * composition lands, it registers the same adapter into the
 * `ProviderRegistry`; this factory constructs and never registers, so the
 * two uses cannot interfere.
 */

import type { QuotaProvider } from '../providers/registry';
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
