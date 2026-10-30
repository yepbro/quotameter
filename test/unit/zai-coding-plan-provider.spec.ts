import { describe, expect, it } from 'vitest';
import { ProviderRegistry, type QuotaProvider } from '../../src/providers/registry';
import {
  composeCredentialCheckUrl,
  composeSnapshotUrls,
  CREDENTIAL_CHECK_PATH,
  DEFAULT_API_BASE_URL,
  DEFAULT_CODING_BASE_URL,
  ZaiCodingPlanProvider,
  ZAI_CODING_PLAN_PROVIDER_ID,
} from '../../src/providers/zai-coding-plan/provider';

/**
 * Locks the Z.ai Coding Plan provider skeleton (spec §8.1, §8.3; tasks
 * 098/099): the dossier identity, the registry conformance the 070 contract
 * demands, the credential-check and snapshot URL compositions with their
 * fail-fast validation, and the options surface task 099 added. No HTTP
 * here — the unit suite runs under the no-network guard; end-to-end
 * behavior is covered by test/integration/zai-coding-plan-{validate,snapshot}.spec.ts.
 */

describe('ZaiCodingPlanProvider skeleton', () => {
  it('exposes the dossier identity', () => {
    const provider = new ZaiCodingPlanProvider();

    expect(provider.id).toBe(ZAI_CODING_PLAN_PROVIDER_ID);
    expect(ZAI_CODING_PLAN_PROVIDER_ID).toBe('zai-coding-plan');
    expect(provider.name).toBe('Z.ai Coding Plan');
  });

  it('satisfies the 070 contract and registers in the ProviderRegistry', () => {
    const provider: QuotaProvider = new ZaiCodingPlanProvider();
    const registry = new ProviderRegistry();

    registry.register(provider);

    expect(registry.has(ZAI_CODING_PLAN_PROVIDER_ID)).toBe(true);
    expect(registry.get(ZAI_CODING_PLAN_PROVIDER_ID)).toBe(provider);
    expect(registry.list()).toEqual([provider]);
  });

  it('validates credentials without collecting (the method exists per 070)', () => {
    const provider = new ZaiCodingPlanProvider();

    // Not invoked here (it would perform a real request against the
    // production base); the integration spec exercises the flow itself.
    expect(typeof provider.validateCredentials).toBe('function');
  });
});

describe('composeCredentialCheckUrl', () => {
  it('pins the production default to dossier endpoint 4', () => {
    expect(DEFAULT_CODING_BASE_URL).toBe('https://api.z.ai/api/coding/paas/v4');
    expect(CREDENTIAL_CHECK_PATH).toBe('/models');
    expect(composeCredentialCheckUrl(DEFAULT_CODING_BASE_URL)).toBe(
      'https://api.z.ai/api/coding/paas/v4/models',
    );
  });

  it('normalizes trailing slashes and bare origins', () => {
    expect(composeCredentialCheckUrl('https://api.z.ai/api/coding/paas/v4/')).toBe(
      'https://api.z.ai/api/coding/paas/v4/models',
    );
    expect(composeCredentialCheckUrl('https://api.z.ai/api/coding/paas/v4//')).toBe(
      'https://api.z.ai/api/coding/paas/v4/models',
    );
    expect(composeCredentialCheckUrl('http://127.0.0.1:34567')).toBe(
      'http://127.0.0.1:34567/models',
    );
  });

  it('rejects non-http(s), unparseable, and query/fragment bases echo-free', () => {
    const invalid = [
      'ftp://api.z.ai/api/coding/paas/v4',
      'api.z.ai/api/coding/paas/v4',
      '',
      'https://api.z.ai/api/coding/paas/v4?x=1',
      'https://api.z.ai/api/coding/paas/v4#fragment',
      'https://user:pass@api.z.ai/api/coding/paas/v4',
    ];

    for (const base of invalid) {
      expect(() => composeCredentialCheckUrl(base)).toThrow(TypeError);
    }
    for (const base of invalid.filter((candidate) => candidate !== '')) {
      try {
        composeCredentialCheckUrl(base);
      } catch (error) {
        // Echo-free even though a base URL is not secret (§15.4 discipline).
        expect((error as Error).message).not.toContain(base);
      }
    }
  });
});

describe('composeSnapshotUrls', () => {
  it('pins the production default to the dossier endpoint trio', () => {
    expect(DEFAULT_API_BASE_URL).toBe('https://api.z.ai');
    expect(composeSnapshotUrls(DEFAULT_API_BASE_URL)).toEqual({
      quotaLimit: 'https://api.z.ai/api/monitor/usage/quota/limit',
      subscriptionList: 'https://api.z.ai/api/biz/subscription/list',
      resetCards: 'https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL',
    });
  });

  it('normalizes trailing slashes and bare origins', () => {
    const fromTrailing = composeSnapshotUrls('https://api.z.ai/');
    expect(fromTrailing).toEqual(composeSnapshotUrls('https://api.z.ai'));
    const loopback = composeSnapshotUrls('http://127.0.0.1:34567');
    expect(loopback.quotaLimit).toBe('http://127.0.0.1:34567/api/monitor/usage/quota/limit');
    expect(loopback.resetCards).toBe(
      'http://127.0.0.1:34567/api/biz/customer-package-reset/list?targetType=PERSONAL',
    );
  });

  it('rejects non-http(s), unparseable, and query/fragment bases echo-free', () => {
    const invalid = [
      'ftp://api.z.ai',
      'api.z.ai',
      '',
      'https://api.z.ai?x=1',
      'https://api.z.ai#fragment',
      'https://user:pass@api.z.ai',
    ];

    for (const base of invalid) {
      expect(() => composeSnapshotUrls(base)).toThrow(TypeError);
    }
    for (const base of invalid.filter((candidate) => candidate !== '')) {
      try {
        composeSnapshotUrls(base);
      } catch (error) {
        // Echo-free even though a base URL is not secret (§15.4 discipline).
        expect((error as Error).message).not.toContain(base);
      }
    }
  });
});

describe('ZaiCodingPlanProvider options validation', () => {
  it('rejects invalid coding base URLs at construction (fail fast, D-013 spirit)', () => {
    expect(() => new ZaiCodingPlanProvider({ codingBaseUrl: 'not a url' })).toThrow(TypeError);
    expect(() => new ZaiCodingPlanProvider({ codingBaseUrl: 'ftp://api.z.ai' })).toThrow(TypeError);
    expect(() => new ZaiCodingPlanProvider({ codingBaseUrl: 'https://api.z.ai/?q=1' })).toThrow(
      TypeError,
    );
  });

  it('rejects invalid quota-surface base URLs at construction (099)', () => {
    expect(() => new ZaiCodingPlanProvider({ apiBaseUrl: 'not a url' })).toThrow(TypeError);
    expect(() => new ZaiCodingPlanProvider({ apiBaseUrl: 'ftp://api.z.ai' })).toThrow(TypeError);
    expect(() => new ZaiCodingPlanProvider({ apiBaseUrl: 'https://api.z.ai/#f' })).toThrow(
      TypeError,
    );
  });

  it('rejects non-positive or non-finite timeouts at construction', () => {
    for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => new ZaiCodingPlanProvider({ timeoutMs })).toThrow(TypeError);
    }
  });

  it('accepts the documented seam values', () => {
    expect(
      () => new ZaiCodingPlanProvider({ codingBaseUrl: 'http://127.0.0.1:1/api/coding/paas/v4' }),
    ).not.toThrow();
    expect(() => new ZaiCodingPlanProvider({ apiBaseUrl: 'http://127.0.0.1:34567' })).not.toThrow();
    expect(() => new ZaiCodingPlanProvider({ timeoutMs: 5_000 })).not.toThrow();
    expect(() => new ZaiCodingPlanProvider()).not.toThrow();
  });
});
