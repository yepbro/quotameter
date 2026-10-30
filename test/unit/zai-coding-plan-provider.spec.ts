import { describe, expect, it } from 'vitest';
import { ProviderRegistry, type QuotaProvider } from '../../src/providers/registry';
import {
  composeCredentialCheckUrl,
  CREDENTIAL_CHECK_PATH,
  DEFAULT_CODING_BASE_URL,
  SNAPSHOT_NOT_IMPLEMENTED_MESSAGE,
  ZaiCodingPlanProvider,
  ZAI_CODING_PLAN_PROVIDER_ID,
} from '../../src/providers/zai-coding-plan/provider';

/**
 * Locks the Z.ai Coding Plan provider skeleton (spec §8.1, §8.3; task 098):
 * the dossier identity, the registry conformance the 070 contract demands,
 * the credential-check URL composition with its fail-fast validation, and
 * the loud fetchSnapshot stub task 099 replaces. No HTTP here — the unit
 * suite runs under the no-network guard; end-to-end behavior is covered by
 * test/integration/zai-coding-plan-validate.spec.ts.
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

  it('rejects fetchSnapshot loudly until task 099 lands it', async () => {
    const provider = new ZaiCodingPlanProvider();

    await expect(provider.fetchSnapshot()).rejects.toThrow(SNAPSHOT_NOT_IMPLEMENTED_MESSAGE);
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

describe('ZaiCodingPlanProvider options validation', () => {
  it('rejects invalid coding base URLs at construction (fail fast, D-013 spirit)', () => {
    expect(() => new ZaiCodingPlanProvider({ codingBaseUrl: 'not a url' })).toThrow(TypeError);
    expect(() => new ZaiCodingPlanProvider({ codingBaseUrl: 'ftp://api.z.ai' })).toThrow(TypeError);
    expect(() => new ZaiCodingPlanProvider({ codingBaseUrl: 'https://api.z.ai/?q=1' })).toThrow(
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
    expect(() => new ZaiCodingPlanProvider({ timeoutMs: 5_000 })).not.toThrow();
    expect(() => new ZaiCodingPlanProvider()).not.toThrow();
  });
});
