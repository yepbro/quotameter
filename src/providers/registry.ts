import type { ProviderSnapshot } from '../schemas/metrics';

/**
 * Provider contracts and registry (spec §8.1).
 *
 * A provider is integrated as an isolated adapter (a subdirectory of this
 * layer) implementing {@link QuotaProvider}. The composition root registers
 * each adapter in a {@link ProviderRegistry}; polling, storage, history, and
 * the UI consume providers only through these contracts, which is what makes
 * "adding a provider never rewrites the scheduler, persistence, history
 * endpoints, or charts" (spec §8.1) mechanically true.
 */

declare const accountContextBrand: unique symbol;

/**
 * One monitored account handed to a provider adapter (spec §8.1, §8.2):
 * the stable account id, the display label, and the provider secret.
 *
 * Values are created only by {@link createAccountContext}, which keeps the
 * secret non-enumerable and the object frozen. The brand (the same pattern as
 * `Validated<T>` in `src/schemas/boundary.ts`) makes that factory the only
 * way to produce this type, so a context cannot be built as a plain object
 * literal with a loggable secret by accident.
 */
export type AccountContext = AccountContextFields & { readonly [accountContextBrand]: true };

/** The log-safe fields of an {@link AccountContext}. */
interface AccountContextFields {
  /** Stable identifier; ties collection history, state, and errors to one account (spec §8.2). */
  readonly accountId: string;
  /** English display label shown in the UI and CLI. */
  readonly label: string;
  /**
   * The provider secret (API key). Process memory only — never logged, never
   * persisted (spec §8.1, §15.4). Non-enumerable on every instance, so
   * serialization, inspection, and object spreading cannot carry it into a
   * log line; only an explicit `.secret` read reaches it.
   */
  readonly secret: string;
}

/**
 * Builds an {@link AccountContext}, rejecting blank fields.
 *
 * The error message names the offending field but never echoes any field
 * value, so it cannot leak the secret it is rejecting.
 */
export function createAccountContext(
  accountId: string,
  label: string,
  secret: string,
): AccountContext {
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    throw new TypeError('AccountContext: accountId must be a non-empty string');
  }
  if (typeof label !== 'string' || label.trim() === '') {
    throw new TypeError('AccountContext: label must be a non-empty string');
  }
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new TypeError('AccountContext: secret must be a non-empty string');
  }

  // The brand and the secret are attached below; this intermediate shape is
  // the only place the assertion is needed.
  const context = { accountId, label } as AccountContext;
  Object.defineProperty(context, 'secret', {
    value: secret,
    enumerable: false,
    // Equivalent mutants (U-006 triage): Object.freeze below re-asserts both
    // flags before the context escapes, so each is unobservable alone.
    // Stryker disable next-line BooleanLiteral
    writable: false,
    // Stryker disable next-line BooleanLiteral
    configurable: false,
  });
  return Object.freeze(context);
}

/**
 * The contract every provider adapter implements (spec §8.1).
 *
 * Adapters validate raw provider payloads adapter-locally (trust boundary 2)
 * and return normalized snapshots from `src/schemas/metrics` (spec §8.4).
 * Failures follow the polling semantics of spec §7.2: reject rather than
 * fabricate values, and never embed the account secret in an error message.
 */
export interface QuotaProvider {
  /** Stable adapter identifier, e.g. `zai-coding-plan`; the registry key and the `providerId` of emitted snapshots. */
  readonly id: string;
  /** English display name. */
  readonly name: string;
  /**
   * Checks the account's credentials without collecting metrics (the "test
   * connection" action, spec §8.2). Resolves when the provider accepts them;
   * rejects with a provider-neutral error otherwise.
   */
  validateCredentials(account: AccountContext): Promise<void>;
  /**
   * Collects one normalized snapshot for the account. The polling service
   * supplies an abort signal; an in-flight collection must stop and reject
   * when it fires.
   */
  fetchSnapshot(account: AccountContext, signal: AbortSignal): Promise<ProviderSnapshot>;
}

/**
 * Registry of the adapters wired by the composition root (spec §8.1).
 *
 * Registration happens once at startup; duplicate or malformed registrations
 * throw so a wiring mistake fails fast instead of silently shadowing a
 * provider (decision D-013).
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, QuotaProvider>();

  /**
   * Adds `provider`. Throws on a blank or whitespace-padded id, a blank name,
   * non-function methods, or a duplicate id.
   */
  register(provider: QuotaProvider): void {
    if (provider === null || typeof provider !== 'object') {
      throw new TypeError('ProviderRegistry: provider must be an object');
    }
    if (typeof provider.id !== 'string' || provider.id.trim() === '') {
      throw new TypeError('ProviderRegistry: provider id must be a non-empty string');
    }
    if (provider.id !== provider.id.trim()) {
      throw new TypeError('ProviderRegistry: provider id must not have surrounding whitespace');
    }
    if (typeof provider.name !== 'string' || provider.name.trim() === '') {
      throw new TypeError('ProviderRegistry: provider name must be a non-empty string');
    }
    if (typeof provider.validateCredentials !== 'function') {
      throw new TypeError('ProviderRegistry: provider.validateCredentials must be a function');
    }
    if (typeof provider.fetchSnapshot !== 'function') {
      throw new TypeError('ProviderRegistry: provider.fetchSnapshot must be a function');
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`ProviderRegistry: provider '${provider.id}' is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  /** Returns the provider registered under `id`; throws when there is none. */
  get(id: string): QuotaProvider {
    const provider = this.providers.get(id);
    if (provider === undefined) {
      const registered =
        this.providers.size === 0
          ? 'none'
          : [...this.providers.keys()].map((key) => `'${key}'`).join(', ');
      throw new Error(`ProviderRegistry: no provider registered with id '${id}' (${registered})`);
    }
    return provider;
  }

  /** True when a provider is registered under `id`. */
  has(id: string): boolean {
    return this.providers.has(id);
  }

  /** All registered providers as a fresh array in registration order. */
  list(): readonly QuotaProvider[] {
    return [...this.providers.values()];
  }
}
