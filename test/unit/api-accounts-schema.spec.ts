import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_KEY_MASK,
  AccountMutationResultSchema,
  AccountTestResponseSchema,
  AccountViewSchema,
  AccountsListResponseSchema,
  CreateAccountBodySchema,
  DeleteAccountQuerySchema,
  UpdateAccountBodySchema,
} from '../../src/schemas/api/accounts';
import { ID_PATTERN } from '../../src/schemas/config';

/**
 * The §13 accounts contract tables (task 159, decision D-128): every
 * request/response schema is closed (`additionalProperties: false`) — the
 * structural write-only-key guard, pinned at the schema layer the way the
 * D-111 health suite pins its closed literal — and the field rules the
 * endpoints rely on (charset, minProperties, the purge boolean) hold
 * exactly. The id charset is additionally pinned against the configuration
 * contract's own pattern (the no-drift rule, D-100's precedent for shared
 * patterns): the API cannot accept an id the configuration would refuse to
 * persist.
 */

/** A complete, valid account view — the base every mutation spreads. */
const VALID_VIEW = {
  id: 'work',
  providerId: 'zai-coding-plan',
  label: 'Work plan',
  enabled: true,
  status: 'active',
  hasKey: true,
  keySource: 'file',
  keyMask: ACCOUNT_KEY_MASK,
  planName: 'Pro',
  createdAt: 1_761_000_000_000,
  archivedAt: null,
} as const;

describe('AccountViewSchema (task 159, §13/§15.4)', () => {
  it('accepts the complete view', () => {
    const validate = new Ajv2020().compile(AccountViewSchema);
    expect(validate(VALID_VIEW)).toBe(true);
  });

  it('accepts the honest-gap views: null history facts, archived, keyless', () => {
    const validate = new Ajv2020().compile(AccountViewSchema);
    const accepted: unknown[] = [
      // Configured but not yet mirrored into storage.
      { ...VALID_VIEW, planName: null, createdAt: null },
      // Archived: no configuration entry anymore.
      {
        ...VALID_VIEW,
        status: 'archived',
        enabled: false,
        hasKey: false,
        keySource: 'none',
        keyMask: null,
        archivedAt: 1_761_000_001_000,
      },
    ];
    for (const value of accepted) {
      expect(validate(value), JSON.stringify(value)).toBe(true);
    }
  });

  it('rejects key-bearing shapes — the closed object is the leak guard', () => {
    const validate = new Ajv2020().compile(AccountViewSchema);
    const rejected: unknown[] = [
      { ...VALID_VIEW, apiKey: 'sk-marker-secret' },
      { ...VALID_VIEW, key: 'sk-marker-secret' },
      { ...VALID_VIEW, secret: 'sk-marker-secret' },
      { ...VALID_VIEW, apiKeyEnv: 'ZAI_KEY' },
      { ...VALID_VIEW, apiKeyMask: 'sk-…1234' },
      // Wrong shapes on the declared fields.
      { ...VALID_VIEW, status: 'retired' },
      { ...VALID_VIEW, keySource: 'env' },
      { ...VALID_VIEW, createdAt: '2026-11-01T00:00:00Z' },
      { ...VALID_VIEW, id: 'has space' },
      { ...VALID_VIEW, label: '' },
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('keeps the mask constant content-free — fixed width, no derivation', () => {
    // §15.4 read strictly: the mask carries nothing derived from key
    // material — not even its length. A constant is the only shape that
    // cannot leak by construction.
    expect(ACCOUNT_KEY_MASK).toBe('********');
  });
});

describe('AccountsListResponseSchema (task 159, §13)', () => {
  it('accepts the empty and populated list, rejects anything beside accounts', () => {
    const validate = new Ajv2020().compile(AccountsListResponseSchema);
    expect(validate({ accounts: [] })).toBe(true);
    expect(validate({ accounts: [VALID_VIEW] })).toBe(true);
    expect(validate({ accounts: [VALID_VIEW], total: 1 })).toBe(false);
    expect(validate({ accounts: [{ ...VALID_VIEW, apiKey: 'x' }] })).toBe(false);
    expect(validate({})).toBe(false);
  });
});

describe('CreateAccountBodySchema (task 159, §13/§6.3)', () => {
  it('accepts the minimal create and every optional field', () => {
    const validate = new Ajv2020().compile(CreateAccountBodySchema);
    const accepted: unknown[] = [
      { providerId: 'zai-coding-plan', label: 'Work' },
      { id: 'work', providerId: 'zai-coding-plan', label: 'Work' },
      { providerId: 'zai-coding-plan', label: 'Work', apiKey: 'sk-write-only' },
      { providerId: 'zai-coding-plan', label: 'Work', enabled: false },
    ];
    for (const value of accepted) {
      expect(validate(value), JSON.stringify(value)).toBe(true);
    }
  });

  it('rejects ids outside the configuration charset, blanks, and foreign fields', () => {
    const validate = new Ajv2020().compile(CreateAccountBodySchema);
    const rejected: unknown[] = [
      { providerId: 'zai-coding-plan' }, // no label
      { providerId: '', label: 'Work' },
      { providerId: 'zai-coding-plan', label: '' },
      { id: '', providerId: 'zai-coding-plan', label: 'Work' },
      { id: '-leading-dash', providerId: 'zai-coding-plan', label: 'Work' },
      { id: 'has space', providerId: 'zai-coding-plan', label: 'Work' },
      { id: 'x'.repeat(65), providerId: 'zai-coding-plan', label: 'Work' },
      { providerId: 'zai-coding-plan', label: 'Work', apiKeyEnv: 'ZAI_KEY' }, // §6.3: file-only
      { providerId: 'zai-coding-plan', label: 'Work', apiKey: '' },
      { providerId: 'zai-coding-plan', label: 'Work', planName: 'Pro' },
      'account',
      null,
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('UpdateAccountBodySchema (task 159, §13)', () => {
  it("accepts each of §13's three mutable fields alone and together", () => {
    const validate = new Ajv2020().compile(UpdateAccountBodySchema);
    const accepted: unknown[] = [
      { label: 'Renamed' },
      { enabled: false },
      { apiKey: 'sk-rotated' },
      { label: 'Renamed', enabled: true, apiKey: 'sk-rotated' },
    ];
    for (const value of accepted) {
      expect(validate(value), JSON.stringify(value)).toBe(true);
    }
  });

  it("rejects the empty patch and every field outside §13's three", () => {
    const validate = new Ajv2020().compile(UpdateAccountBodySchema);
    const rejected: unknown[] = [
      {}, // minProperties: 1 — an empty patch is a client error
      { id: 'other' },
      { providerId: 'other-provider' },
      { apiKeyEnv: 'ZAI_KEY' },
      { label: '' },
      { apiKey: '' },
      { enabled: 'yes' },
    ];
    for (const value of rejected) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('DeleteAccountQuerySchema (task 159, §13/§8.2)', () => {
  it('accepts absent and boolean purgeHistory only', () => {
    const validate = new Ajv2020().compile(DeleteAccountQuerySchema);
    expect(validate({})).toBe(true);
    expect(validate({ purgeHistory: true })).toBe(true);
    expect(validate({ purgeHistory: false })).toBe(true);
    expect(validate({ purgeHistory: 'yes' })).toBe(false);
    expect(validate({ purgeHistory: 1 })).toBe(false);
    expect(validate({ purgeHistory: true, extra: 1 })).toBe(false);
  });
});

describe('AccountMutationResultSchema (task 159, §13/§8.2)', () => {
  it('accepts the three outcomes with the purge evidence exactly on purge', () => {
    const validate = new Ajv2020().compile(AccountMutationResultSchema);
    expect(validate({ result: 'archived', account: VALID_VIEW, removed: null })).toBe(true);
    expect(validate({ result: 'already-archived', account: VALID_VIEW, removed: null })).toBe(true);
    expect(
      validate({
        result: 'purged',
        account: VALID_VIEW,
        removed: {
          collectionRuns: 1,
          snapshots: 1,
          metricValues: 2,
          quotaEvents: 0,
          rawResponses: 0,
        },
      }),
    ).toBe(true);
    expect(validate({ result: 'archived', account: VALID_VIEW })).toBe(false);
    expect(validate({ result: 'deleted', account: VALID_VIEW, removed: null })).toBe(false);
    expect(
      validate({
        result: 'purged',
        account: VALID_VIEW,
        removed: { collectionRuns: 1 }, // D-061's counts are all-or-nothing
      }),
    ).toBe(false);
  });
});

describe('AccountTestResponseSchema (task 159, §13/D-052)', () => {
  it('accepts the three outcomes, message only on failure', () => {
    const validate = new Ajv2020().compile(AccountTestResponseSchema);
    expect(validate({ outcome: 'ok' })).toBe(true);
    expect(
      validate({
        outcome: 'rejected',
        message: 'the provider rejected the account credentials (HTTP 401)',
      }),
    ).toBe(true);
    expect(
      validate({ outcome: 'unavailable', message: 'the credential check could not be completed' }),
    ).toBe(true);
    expect(validate({ outcome: 'ok', message: 'surplus' })).toBe(false);
    expect(validate({ outcome: 'failed' })).toBe(false);
    expect(validate({})).toBe(false);
  });
});

describe('the id charset — one pattern, two consumers (D-100/D-128)', () => {
  it("validates ids against exactly the configuration contract's pattern", () => {
    // The API schema imports the pattern; this pin makes the equality a
    // tested contract, so a future edit to either side fails here instead
    // of drifting the API away from what the configuration can persist.
    expect(CreateAccountBodySchema.properties.id).toMatchObject({ pattern: ID_PATTERN });
    expect(AccountViewSchema.properties.id).toMatchObject({ pattern: ID_PATTERN });
  });
});
