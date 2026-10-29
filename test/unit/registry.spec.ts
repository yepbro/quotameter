import { inspect } from 'node:util';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ProviderRegistry,
  createAccountContext,
  type AccountContext,
  type QuotaProvider,
} from '../../src/providers/registry';
import { findProviderSnapshotProblems } from '../../src/schemas/metrics';
import type { ProviderSnapshot } from '../../src/schemas/metrics';

/**
 * Locks the provider contracts and registry semantics (spec §8.1): the
 * spec-shaped `QuotaProvider` interface, an `AccountContext` whose secret
 * cannot travel into logs by accident, and a fail-fast registry (decision
 * D-013). The final test proves the task's done-condition: a mock provider
 * registers and runs through the registry alone — this file imports nothing
 * from polling, storage, or services, because none is needed.
 */

/** A snapshot the normalized model accepts (spec §8.4 invariants hold). */
function validSnapshot(): ProviderSnapshot {
  return {
    providerId: 'mock',
    collectedAt: Date.UTC(2026, 9, 29, 12, 0, 0),
    planName: 'Mock plan',
    metrics: [
      {
        key: 'mock-weekly',
        label: 'Weekly quota',
        limitType: 'WEEKLY',
        unit: 'PERCENT',
        percentUsed: 73,
        percentRemaining: 27,
        isValid: true,
      },
    ],
  };
}

/** A minimal in-test provider; adapter code arrives with Stage 9. */
function mockProvider(overrides: Partial<QuotaProvider> = {}): QuotaProvider {
  return {
    id: 'mock',
    name: 'Mock Provider',
    async validateCredentials(): Promise<void> {},
    async fetchSnapshot(): Promise<ProviderSnapshot> {
      return validSnapshot();
    },
    ...overrides,
  };
}

/** A context with a sentinel secret for leak assertions. */
function mockAccount(): AccountContext {
  return createAccountContext('acc-1', 'Work plan', 'sk-sentinel');
}

describe('createAccountContext', () => {
  it('exposes the account id, label, and secret for explicit reads', () => {
    const account = createAccountContext('acc-1', 'Work plan', 'sk-live');
    expect(account.accountId).toBe('acc-1');
    expect(account.label).toBe('Work plan');
    expect(account.secret).toBe('sk-live');
  });

  it('keeps the secret out of serialization, enumeration, inspection, and spreads', () => {
    const account = mockAccount();
    expect(JSON.stringify(account)).toBe('{"accountId":"acc-1","label":"Work plan"}');
    expect(Object.keys(account)).toEqual(['accountId', 'label']);
    expect(inspect(account)).toBe("{ accountId: 'acc-1', label: 'Work plan' }");
    expect(inspect(account)).not.toContain('sk-sentinel');
    const spread: Record<string, unknown> = { ...account };
    expect(spread).toEqual({ accountId: 'acc-1', label: 'Work plan' });
  });

  it('freezes the context against later mutation', () => {
    const account = mockAccount();
    expect(Object.isFrozen(account)).toBe(true);
    expect(() => {
      (account as unknown as { accountId: string }).accountId = 'other';
    }).toThrow(TypeError);
    expect(account.accountId).toBe('acc-1');
  });

  it('rejects blank fields', () => {
    expect(() => createAccountContext('', 'Work plan', 'sk-live')).toThrow(TypeError);
    expect(() => createAccountContext('acc-1', '   ', 'sk-live')).toThrow(TypeError);
    expect(() => createAccountContext('acc-1', 'Work plan', '\t')).toThrow(TypeError);
    expect(() => createAccountContext('acc-1', 'Work plan', '')).toThrow(TypeError);
  });

  it('names the offending field without echoing any value', () => {
    let message = '';
    try {
      createAccountContext('   ', 'Work plan', 'sk-sentinel');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('AccountContext: accountId must be a non-empty string');
    expect(message).not.toContain('sk-sentinel');
  });
});

describe('ProviderRegistry.register', () => {
  it('accepts a provider and returns it from get untouched', () => {
    const registry = new ProviderRegistry();
    const provider = mockProvider();
    registry.register(provider);
    expect(registry.get('mock')).toBe(provider);
  });

  it('rejects a duplicate id even for a different object', () => {
    const registry = new ProviderRegistry();
    registry.register(mockProvider());
    expect(() => registry.register(mockProvider({ name: 'Other Mock' }))).toThrow(
      "ProviderRegistry: provider 'mock' is already registered",
    );
  });

  it('rejects non-objects and blank ids and names', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.register(null as unknown as QuotaProvider)).toThrow(TypeError);
    expect(() => registry.register(mockProvider({ id: '  ' }))).toThrow(TypeError);
    expect(() => registry.register(mockProvider({ name: '' }))).toThrow(TypeError);
    expect(registry.list()).toEqual([]);
  });

  it('rejects an id with surrounding whitespace before it can desync lookups', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.register(mockProvider({ id: ' mock ' }))).toThrow(
      'ProviderRegistry: provider id must not have surrounding whitespace',
    );
    expect(registry.has(' mock ')).toBe(false);
  });

  it('rejects providers whose methods are not functions', () => {
    const registry = new ProviderRegistry();
    expect(() =>
      registry.register({
        ...mockProvider(),
        validateCredentials: undefined as unknown as QuotaProvider['validateCredentials'],
      }),
    ).toThrow('ProviderRegistry: provider.validateCredentials must be a function');
    expect(() =>
      registry.register({
        ...mockProvider(),
        fetchSnapshot: undefined as unknown as QuotaProvider['fetchSnapshot'],
      }),
    ).toThrow('ProviderRegistry: provider.fetchSnapshot must be a function');
  });
});

describe('ProviderRegistry.get and has', () => {
  it('throws a diagnostic error for an unknown id', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.get('mock')).toThrow(
      "ProviderRegistry: no provider registered with id 'mock' (none)",
    );

    registry.register(mockProvider({ id: 'alpha', name: 'Alpha' }));
    registry.register(mockProvider({ id: 'beta', name: 'Beta' }));
    expect(() => registry.get('gamma')).toThrow(
      "ProviderRegistry: no provider registered with id 'gamma' ('alpha', 'beta')",
    );
  });

  it('reports existence through has', () => {
    const registry = new ProviderRegistry();
    expect(registry.has('mock')).toBe(false);
    registry.register(mockProvider());
    expect(registry.has('mock')).toBe(true);
    expect(registry.has('other')).toBe(false);
  });
});

describe('ProviderRegistry.list', () => {
  it('returns providers in registration order', () => {
    const registry = new ProviderRegistry();
    const alpha = mockProvider({ id: 'alpha', name: 'Alpha' });
    const beta = mockProvider({ id: 'beta', name: 'Beta' });
    registry.register(alpha);
    registry.register(beta);
    expect(registry.list()).toEqual([alpha, beta]);
  });

  it('returns a fresh copy the caller cannot use to mutate the registry', () => {
    const registry = new ProviderRegistry();
    registry.register(mockProvider());
    registry.register(mockProvider({ id: 'beta', name: 'Beta' }));

    const listed = registry.list();
    expect(listed).toHaveLength(2);
    (listed as QuotaProvider[]).length = 0;
    expect(registry.list()).toHaveLength(2);
    expect(registry.list()).not.toBe(registry.list());
  });

  it('is empty before anything registers', () => {
    expect(new ProviderRegistry().list()).toEqual([]);
  });
});

describe('type-level guarantees (spec §8.1)', () => {
  it('pins QuotaProvider to the spec sketch', () => {
    expectTypeOf<QuotaProvider['id']>().toEqualTypeOf<string>();
    expectTypeOf<QuotaProvider['name']>().toEqualTypeOf<string>();
    expectTypeOf<QuotaProvider['validateCredentials']>().parameters.toEqualTypeOf<
      [account: AccountContext]
    >();
    expectTypeOf<QuotaProvider['validateCredentials']>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<QuotaProvider['fetchSnapshot']>().parameters.toEqualTypeOf<
      [account: AccountContext, signal: AbortSignal]
    >();
    expectTypeOf<QuotaProvider['fetchSnapshot']>().returns.toEqualTypeOf<
      Promise<ProviderSnapshot>
    >();
  });

  it('pins AccountContext to the spec fields', () => {
    expectTypeOf<AccountContext['accountId']>().toEqualTypeOf<string>();
    expectTypeOf<AccountContext['label']>().toEqualTypeOf<string>();
    expectTypeOf<AccountContext['secret']>().toEqualTypeOf<string>();
  });

  it('refuses plain object literals as AccountContext (brand forces the factory)', () => {
    // @ts-expect-error AccountContext is branded: only createAccountContext builds one
    const bare: AccountContext = { accountId: 'acc-1', label: 'Work plan', secret: 'sk-live' };
    expect(bare).toBeDefined();
  });
});

describe('done-condition (task 070)', () => {
  it('runs a mock provider end-to-end through the registry alone', async () => {
    const registry = new ProviderRegistry();
    const seen: { account?: AccountContext; signal?: AbortSignal } = {};
    const mock: QuotaProvider = {
      id: 'mock',
      name: 'Mock Provider',
      async validateCredentials(account) {
        seen.account = account;
      },
      async fetchSnapshot(account, signal) {
        seen.account = account;
        seen.signal = signal;
        expect(signal.aborted).toBe(false);
        return validSnapshot();
      },
    };

    registry.register(mock);
    const provider = registry.get('mock');
    const account = mockAccount();

    await expect(provider.validateCredentials(account)).resolves.toBeUndefined();
    const controller = new AbortController();
    const snapshot = await provider.fetchSnapshot(account, controller.signal);

    // The mock received exactly what the caller passed through the registry.
    expect(seen.account).toBe(account);
    expect(seen.signal).toBe(controller.signal);
    // The snapshot satisfies the normalized model (spec §8.4) unchanged.
    expect(findProviderSnapshotProblems(snapshot)).toEqual([]);
    expect(snapshot.providerId).toBe('mock');
  });
});
