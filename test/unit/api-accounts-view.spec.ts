import { describe, expect, it } from 'vitest';
import type { AccountRecord } from '../../src/storage/repository';
import {
  accountView,
  mergeAccountViews,
  type ManagedAccountConfig,
} from '../../src/server/api/accounts';
import { ACCOUNT_KEY_MASK } from '../../src/schemas/api/accounts';

/**
 * The pure half of task 159's list composition (decision D-128): how the
 * configuration entries and the storage rows merge into the §13 view —
 * which side owns which field, what an absent half reads as, and that the
 * mask never derives from key material. Pinned here so the endpoint suite
 * can pin wire behavior only.
 */

/** Deterministic §11.1 epoch-millisecond timestamps. */
const T0 = 1_761_000_000_000;

/** A configured account — the base every override spreads. */
function managed(overrides: Partial<ManagedAccountConfig> = {}): ManagedAccountConfig {
  return {
    id: 'work',
    providerId: 'zai-coding-plan',
    label: 'Work plan',
    enabled: true,
    keyConfigured: true,
    keySource: 'file',
    ...overrides,
  };
}

/** A storage row — the base every override spreads. */
function record(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id: 'work',
    providerId: 'zai-coding-plan',
    label: 'Work plan',
    planName: 'Pro',
    status: 'active',
    createdAt: T0,
    archivedAt: null,
    ...overrides,
  };
}

describe('accountView — the two halves (task 159, D-128)', () => {
  it('prefers the configuration for management fields, the row for lifecycle facts', () => {
    const view = accountView(
      managed({ label: 'Renamed in config', enabled: false }),
      record({ label: 'Stale row label', planName: 'Pro', status: 'active' }),
    );
    // §6.4: label/enabled are live-reloadable configuration truth; the
    // row's copy is a denormalization that may lag.
    expect(view.label).toBe('Renamed in config');
    expect(view.enabled).toBe(false);
    // §8.2/§11.2: lifecycle and history facts belong to the row.
    expect(view.status).toBe('active');
    expect(view.planName).toBe('Pro');
    expect(view.createdAt).toBe(T0);
    expect(view.archivedAt).toBeNull();
  });

  it('renders a configured account with no row as active with null history facts', () => {
    const view = accountView(managed(), null);
    expect(view.status).toBe('active');
    expect(view.planName).toBeNull();
    expect(view.createdAt).toBeNull();
    expect(view.archivedAt).toBeNull();
  });

  it('renders a row with no configuration entry as disabled with no key state', () => {
    // The archived shape: DELETE removed the entry, §8.2 kept the row.
    const view = accountView(undefined, record({ status: 'archived', archivedAt: T0 + 1000 }));
    expect(view.enabled).toBe(false);
    expect(view.hasKey).toBe(false);
    expect(view.keySource).toBe('none');
    expect(view.keyMask).toBeNull();
    expect(view.status).toBe('archived');
    expect(view.archivedAt).toBe(T0 + 1000);
  });

  it('masks every configured key source identically — no derivation from the value', () => {
    // The mask is the constant for file keys, environment keys, and any
    // future source: content-free by construction (§15.4).
    expect(accountView(managed(), record()).keyMask).toBe(ACCOUNT_KEY_MASK);
    expect(
      accountView(managed({ keySource: 'environment', keyConfigured: true }), record()).keyMask,
    ).toBe(ACCOUNT_KEY_MASK);
    expect(accountView(managed({ keyConfigured: false }), record()).keyMask).toBeNull();
  });

  it('fails loudly when both halves are absent — a wiring bug, never an empty view', () => {
    expect(() => accountView(undefined, null)).toThrow(TypeError);
  });
});

describe('mergeAccountViews — the §13 list (task 159, §8.2)', () => {
  it('unions both stores, id-ascending, whichever side lacks the id', () => {
    const views = mergeAccountViews(
      [managed({ id: 'b-config-only' }), managed({ id: 'a-both' })],
      [record({ id: 'a-both' }), record({ id: 'c-row-only', status: 'archived', archivedAt: T0 })],
    );
    expect(views.map((view) => view.id)).toEqual(['a-both', 'b-config-only', 'c-row-only']);
    // The union's three shapes: merged, configured-only, row-only.
    expect(views[0]).toMatchObject({ id: 'a-both', status: 'active', createdAt: T0 });
    expect(views[1]).toMatchObject({ id: 'b-config-only', status: 'active', createdAt: null });
    expect(views[2]).toMatchObject({
      id: 'c-row-only',
      status: 'archived',
      enabled: false,
      keySource: 'none',
    });
  });

  it('keeps an archived account listed — archive retains history and identity (§8.2)', () => {
    const views = mergeAccountViews([], [record({ status: 'archived', archivedAt: T0 + 500 })]);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ id: 'work', status: 'archived', archivedAt: T0 + 500 });
  });

  it('answers the empty state with an empty list', () => {
    expect(mergeAccountViews([], [])).toEqual([]);
  });

  it('never carries a key value — the merged views have no secret field at all', () => {
    const views = mergeAccountViews([managed()], [record()]);
    for (const view of views) {
      expect(Object.keys(view).sort()).toEqual([
        'archivedAt',
        'createdAt',
        'enabled',
        'hasKey',
        'id',
        'keyMask',
        'keySource',
        'label',
        'planName',
        'providerId',
        'status',
      ]);
    }
  });
});
