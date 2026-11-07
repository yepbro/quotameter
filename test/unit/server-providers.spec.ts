import { describe, expect, it } from 'vitest';
import {
  CredentialCheckError,
  CredentialsRejectedError,
} from '../../src/providers/zai-coding-plan/validate';
import { ProviderRegistry } from '../../src/providers/registry';
import type { QuotaProvider } from '../../src/providers/registry';
import { createAccountContext } from '../../src/providers/registry';
import {
  createAccountSuspensions,
  keyIdentityOfSecret,
} from '../../src/services/account-suspensions';
import { createFixedClock } from '../../src/util/clock';
import { isSuspended } from '../../src/services/polling-suspension';
import { createConfiguredZaiProvider, observingManualTests } from '../../src/server/providers';
import type { Config, PeakHoursConfig } from '../../src/schemas/config';
import { CONFIG_DEFAULTS } from '../../src/schemas/config';
import { createLogger } from '../../src/util/logger';

/**
 * The manual-test observation wrapper (task U-040, decision D-140): §7.2's
 * suspension semantics fed from the provider seam the composition owns —
 * release-on-request before the attempt, re-entry on a D-052
 * `credentials-rejected` rejection, verbatim delegation for everything else
 * (the accounts endpoint's own classification stays the wire's authority).
 */

const T0 = Date.UTC(2026, 10, 3, 10, 0, 0);

/** The marker secret — §15.4: it must never travel past the wrapper. */
const MARKER_KEY = 'sk-marker-observation-77c1';

type InnerMode = 'ok' | 'rejected' | 'unavailable' | 'unclassified';

/** Builds the controllable inner provider plus its behavior record. */
function innerProvider(mode: InnerMode): QuotaProvider & { calls: number } {
  const provider: QuotaProvider & { calls: number } = {
    id: 'zai-coding-plan',
    name: 'Z.ai Coding Plan (test double)',
    calls: 0,
    metricCatalog: [{ metricKey: 'five_hour.quota', label: 'Rolling 5-hour quota' }],
    async validateCredentials() {
      provider.calls++;
      if (mode === 'rejected') throw new CredentialsRejectedError(401);
      if (mode === 'unavailable') {
        throw new CredentialCheckError(
          'provider-unavailable',
          'the credential check could not be completed (test double)',
        );
      }
      if (mode === 'unclassified') throw new Error('unclassified (test double)');
    },
    async fetchSnapshot() {
      throw new Error('fetchSnapshot is not under test');
    },
  };
  return provider;
}

function wrapped(
  mode: InnerMode,
  bridge?: (accountId: string) => void,
  rejectionBridge?: (accountId: string) => void,
): {
  provider: QuotaProvider;
  inner: QuotaProvider & { calls: number };
  suspensions: ReturnType<typeof createAccountSuspensions>;
} {
  const clock = createFixedClock(T0);
  const suspensions = createAccountSuspensions({ clock });
  const inner = innerProvider(mode);
  return {
    provider: observingManualTests(inner, {
      suspensions,
      ...(bridge === undefined ? {} : { onManualTestRequested: bridge }),
      ...(rejectionBridge === undefined ? {} : { onManualTestRejected: rejectionBridge }),
    }),
    inner,
    suspensions,
  };
}

const ACCOUNT = createAccountContext('work', 'Work account', MARKER_KEY);

/** The account's D-064 key identity, as the observation derives it. */
const IDENTITY_A = keyIdentityOfSecret(MARKER_KEY);

describe('createConfiguredZaiProvider (no HTTP here — the transport cells live in integration)', () => {
  /** A minimal effective configuration; only `providers` varies per cell. */
  const configOf = (providers?: Config['providers']): Config => ({
    app: { timezone: 'UTC' },
    ...(providers === undefined ? {} : { providers }),
  });

  /** An empty §9.2 schedule — the shape the config type requires. */
  const peakHours = (): PeakHoursConfig => ({ timezone: 'UTC', windows: [] });

  /** The factory with every seam satisfied, over one reader. */
  const factory = (config: () => Config): QuotaProvider =>
    createConfiguredZaiProvider({
      config,
      clock: createFixedClock(T0),
      logger: createLogger({ level: 'error' }),
    });

  it('exposes the adapter identity facts verbatim (the registry key and D-137 catalog)', () => {
    const provider = factory(() =>
      configOf({ 'zai-coding-plan': { peakHours: peakHours(), requestTimeoutSeconds: 30 } }),
    );

    expect(provider.id).toBe('zai-coding-plan');
    expect(provider.name).toBe('Z.ai Coding Plan');
    expect(provider.metricCatalog).toEqual([
      { metricKey: 'mcp-monthly', label: 'Monthly MCP tool quota' },
      { metricKey: 'tokens-5h', label: '5-hour token quota' },
      { metricKey: 'weekly-quota', label: 'Weekly quota' },
    ]);
  });

  it('constructs without a providers section (the §7.2 default deadline arm)', () => {
    const provider = factory(() => configOf());

    // The eager construction is the assertion: the fallback seconds are
    // CONFIG_DEFAULTS.provider.requestTimeoutSeconds (pinned by the config
    // suites), and the behavioral pin of the delivered response at the
    // default deadline lives in the integration suite.
    expect(CONFIG_DEFAULTS.provider.requestTimeoutSeconds).toBe(15);
    expect(provider.id).toBe('zai-coding-plan');
  });

  it('constructs when another provider holds the providers record (the missing-entry arm)', () => {
    const provider = factory(() =>
      configOf({ beta: { peakHours: peakHours(), requestTimeoutSeconds: 5 } }),
    );

    expect(provider.id).toBe('zai-coding-plan');
  });
});

describe('observingManualTests', () => {
  it('lifts the suspension when the manual test succeeds (the §7.2 done-condition)', async () => {
    const { provider, suspensions } = wrapped('ok');
    suspensions.manualTestRejected('work', IDENTITY_A);
    expect(isSuspended(suspensions.suspensionOf('work'))).toBe(true);

    await expect(provider.validateCredentials(ACCOUNT)).resolves.toBeUndefined();
    expect(isSuspended(suspensions.suspensionOf('work'))).toBe(false);
  });

  it('re-enters suspension with a fresh window when the key is refused', async () => {
    const { provider, suspensions } = wrapped('rejected');
    await expect(provider.validateCredentials(ACCOUNT)).rejects.toThrow(
      /rejected the account credentials/,
    );
    const state = suspensions.suspensionOf('work');
    expect(isSuspended(state)).toBe(true);
    if (!isSuspended(state)) return;
    // The episode is keyed by the tested secret's identity — the vocabulary
    // the configuration observation shares.
    expect(state.keyIdentity).toBe(IDENTITY_A);
  });

  it('releases a suspended account on the request even when the check is inconclusive', async () => {
    const { provider, suspensions } = wrapped('unavailable');
    suspensions.manualTestRejected('work', IDENTITY_A);
    expect(isSuspended(suspensions.suspensionOf('work'))).toBe(true);

    // D-064's unconditional release-on-request fires before the attempt;
    // the inconclusive outcome proves nothing about the key and re-enters
    // nothing.
    const rejection = provider.validateCredentials(ACCOUNT);
    await expect(rejection).rejects.toThrow(CredentialCheckError);
    expect(suspensions.suspensionOf('work').suspended).toBe(false);
  });

  it('rethrows unclassified errors untouched (the endpoint re-classifies)', async () => {
    const { provider } = wrapped('unclassified');
    await expect(provider.validateCredentials(ACCOUNT)).rejects.toThrow(
      'unclassified (test double)',
    );
  });

  it('delegates the adapter facts verbatim and passes fetchSnapshot through', async () => {
    const { provider, inner, suspensions } = wrapped('ok');
    expect(provider.id).toBe(inner.id);
    expect(provider.name).toBe(inner.name);
    expect(provider.metricCatalog).toEqual(inner.metricCatalog);

    await expect(provider.validateCredentials(ACCOUNT)).resolves.toBeUndefined();
    expect(inner.calls).toBe(1);
    // A healthy account's test leaves the initial state (D-064's no-op).
    expect(suspensions.suspensionOf('work').suspended).toBe(false);

    await expect(provider.fetchSnapshot(ACCOUNT, new AbortController().signal)).rejects.toThrow(
      'fetchSnapshot is not under test',
    );
  });

  it('registers and resolves through a real ProviderRegistry unchanged', () => {
    const { provider } = wrapped('ok');
    const registry = new ProviderRegistry();
    registry.register(provider);
    expect(registry.has('zai-coding-plan')).toBe(true);
    expect(registry.get('zai-coding-plan')).toBe(provider);
  });

  it('derives the key identity without exposing the secret (sha256 of the wire value)', () => {
    const identity = keyIdentityOfSecret(MARKER_KEY);
    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    expect(identity).not.toContain(MARKER_KEY);
    // The identity is stable per key and distinct across keys.
    expect(keyIdentityOfSecret(MARKER_KEY)).toBe(identity);
    expect(identity).not.toBe(keyIdentityOfSecret('sk-another-key-2f8b'));
  });

  describe('the manual-test bridge into the polling engine (U-051, D-176)', () => {
    it('notifies the bridge with the account id once per test, before the attempt', async () => {
      const order: string[] = [];
      const { provider, inner, suspensions } = wrapped('ok', (accountId) => {
        // The bridge fires before the attempt: the inner provider has not
        // been called yet at this vantage point.
        order.push(`${accountId}@inner-calls=${inner.calls}`);
      });
      await provider.validateCredentials(ACCOUNT);
      expect(order).toEqual(['work@inner-calls=0']);
      expect(inner.calls).toBe(1);
      expect(isSuspended(suspensions.suspensionOf('work'))).toBe(false);
    });

    it('fires even when the attempt is refused — both release events at one site', async () => {
      const seen: string[] = [];
      const { provider } = wrapped('rejected', (accountId) => {
        seen.push(accountId);
      });
      await expect(provider.validateCredentials(ACCOUNT)).rejects.toThrow(
        /rejected the account credentials/,
      );
      expect(seen).toEqual(['work']);
    });

    it('propagates a throwing bridge (a broken bridge is a wiring bug)', async () => {
      const { provider } = wrapped('ok', () => {
        throw new Error('bridge is broken (test double)');
      });
      await expect(provider.validateCredentials(ACCOUNT)).rejects.toThrow(
        'bridge is broken (test double)',
      );
    });

    it('is absent-safe: no bridge changes nothing (the composition always wires one)', async () => {
      const { provider, inner } = wrapped('ok');
      await expect(provider.validateCredentials(ACCOUNT)).resolves.toBeUndefined();
      expect(inner.calls).toBe(1);
    });

    it('notifies the rejection bridge beside the holder re-entry, on a refused test only', async () => {
      const rejections: string[] = [];
      const { provider, suspensions } = wrapped('rejected', undefined, (accountId) => {
        rejections.push(accountId);
      });
      await expect(provider.validateCredentials(ACCOUNT)).rejects.toThrow(
        /rejected the account credentials/,
      );
      expect(rejections).toEqual(['work']);
      expect(isSuspended(suspensions.suspensionOf('work'))).toBe(true);

      // A successful test never notifies the rejection half.
      const healthy = wrapped('ok', undefined, (accountId) => {
        rejections.push(accountId);
      });
      await expect(healthy.provider.validateCredentials(ACCOUNT)).resolves.toBeUndefined();
      expect(rejections).toEqual(['work']);
    });

    it('propagates a throwing rejection bridge', async () => {
      const { provider } = wrapped('rejected', undefined, () => {
        throw new Error('rejection bridge is broken (test double)');
      });
      await expect(provider.validateCredentials(ACCOUNT)).rejects.toThrow(
        'rejection bridge is broken (test double)',
      );
    });
  });
});
