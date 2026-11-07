import { describe, expect, it } from 'vitest';
import type { AccountRecord } from '../../src/storage/repository';
import { accountView, type ManagedAccountConfig } from '../../src/server/api/accounts';
import {
  deriveAccountStatus,
  type AccountStatus,
  type AccountStatusInput,
} from '../../src/services/polling-status';
import { INITIAL_SUSPENSION_STATE } from '../../src/services/polling-suspension';
import type { AccountAttention } from '../../ui/src/account-attention';
import { accountAttentionOf } from '../../ui/src/account-attention';
import type { StatusAccountView } from '../../src/schemas/api/status';

/**
 * The FSM-2 lifecycle matrix invariant (TZ-fsm §4.3 R4, decision D-191):
 * the `enabled × archived × configured` cube walks every combination of
 * the three source facts and asserts the PURE projections agree on it —
 * the shared derivation's token, the accounts surface's lifecycle field,
 * and the UI attention's verdict. The route-level projection walks the
 * same cube through the real `/status` endpoint (the status suite); the
 * CLI projection is pinned at its own consumer for the cells its
 * §5.2 charter reaches (the configured accounts it lists — the
 * hand-re-add archived cell included); this suite is the
 * cross-projection law itself, so a future projection drift fails here
 * with the whole table in view.
 *
 * The working-rank cell (enabled, active, configured) is exercised with
 * fresh evidence — the strongest lower-rank shape, so an archived row
 * that leaked a runtime status fails the loudest cell first (the §4.1
 * contradiction's exact shape).
 */

/** Deterministic §11.1 epoch-millisecond timestamps. */
const T0 = 1_761_000_000_000;

/** A configured account — the base every cell overrides. */
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

/** A storage row — the base every cell overrides. */
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

/** Fresh run evidence — one success a minute old, the strongest shape. */
const freshRuns = Object.freeze({
  latestRunOutcome: 'success',
  lastSuccessAt: T0 - 60_000,
  firstAttemptAt: T0 - 600_000,
}) as AccountStatusInput['runs'];

/** One cell of the cube; every projection derives from the same facts. */
interface MatrixCell {
  readonly label: string;
  readonly enabled: boolean;
  readonly archived: boolean;
  readonly configured: boolean;
  /** The derivation's expected token (the canonical precedence). */
  readonly status: AccountStatus;
  /** The accounts surface's expected lifecycle field. */
  readonly accountStatus: 'active' | 'archived';
  /** The attention classifier's expected verdict beside a status row. */
  readonly attention: AccountAttention | null;
  /**
   * The reachable keyless shape for the `not-configured` cell is the
   * unresolved environment source (§6.3); the sourceless shape is the
   * schema-total fallback the attention module still answers honestly.
   */
  readonly keySource?: ManagedAccountConfig['keySource'];
}

const CELLS: readonly MatrixCell[] = [
  {
    label: 'enabled × archived × configured — the §4.1 hand-re-add shape',
    enabled: true,
    archived: true,
    configured: true,
    status: 'archived',
    accountStatus: 'archived',
    attention: 'archived',
  },
  {
    label: 'enabled × archived × not-configured',
    enabled: true,
    archived: true,
    configured: false,
    status: 'archived',
    accountStatus: 'archived',
    attention: 'archived',
    keySource: 'environment',
  },
  {
    label: 'disabled × archived × configured',
    enabled: false,
    archived: true,
    configured: true,
    status: 'archived',
    accountStatus: 'archived',
    attention: 'archived',
  },
  {
    label: 'disabled × archived × not-configured',
    enabled: false,
    archived: true,
    configured: false,
    status: 'archived',
    accountStatus: 'archived',
    attention: 'archived',
  },
  {
    label: 'disabled × active × configured',
    enabled: false,
    archived: false,
    configured: true,
    status: 'disabled',
    accountStatus: 'active',
    attention: 'disabled',
  },
  {
    label: 'disabled × active × not-configured',
    enabled: false,
    archived: false,
    configured: false,
    status: 'disabled',
    accountStatus: 'active',
    attention: 'disabled',
  },
  {
    label: 'enabled × active × not-configured — the unresolved environment key',
    enabled: true,
    archived: false,
    configured: false,
    status: 'not-configured',
    accountStatus: 'active',
    attention: 'keyless-environment',
    keySource: 'environment',
  },
  {
    label: 'enabled × active × configured — the working ranks (fresh evidence)',
    enabled: true,
    archived: false,
    configured: true,
    status: 'fresh',
    accountStatus: 'active',
    attention: null,
  },
];

/** The row the status surface would serve for the cell's derived token. */
function statusRowOf(status: AccountStatus): StatusAccountView {
  return {
    id: 'work',
    status,
    lastSuccessAt: freshRuns.lastSuccessAt,
    lastError: null,
  };
}

describe('the enabled × archived × configured matrix — every projection agrees (D-191)', () => {
  it.each(CELLS)('$label', (cell) => {
    // The shared derivation: the one canonical classifier every surface
    // consumes (rank 0 → 0a → 0b → the working ranks).
    const input: AccountStatusInput = {
      archived: cell.archived,
      enabled: cell.enabled,
      configured: cell.configured,
      suspension: INITIAL_SUSPENSION_STATE,
      runs: freshRuns,
      intervalSeconds: 300,
    };
    expect(deriveAccountStatus(input, T0)).toBe(cell.status);

    // The accounts surface: the raw lifecycle fact stays its own field —
    // the storage half the derivation's rank 0 reads.
    const view = accountView(
      managed({ enabled: cell.enabled, keySource: cell.keySource ?? 'file' }),
      cell.archived ? record({ status: 'archived', archivedAt: T0 - 1_000 }) : record(),
    );
    expect(view.status).toBe(cell.accountStatus);

    // The UI attention, fed the classifier's verdict over the wire (R3):
    // archived/disabled/not-configured arrive decided by the row.
    expect(accountAttentionOf(view, statusRowOf(cell.status))).toBe(cell.attention);
  });

  it('the accounts surface and the derivation never disagree about "is archived"', () => {
    for (const cell of CELLS) {
      const rowArchived = cell.archived;
      const view = accountView(
        managed({ enabled: cell.enabled }),
        rowArchived ? record({ status: 'archived', archivedAt: T0 - 1_000 }) : record(),
      );
      const derived = deriveAccountStatus(
        {
          archived: rowArchived,
          enabled: cell.enabled,
          configured: cell.configured,
          suspension: INITIAL_SUSPENSION_STATE,
          runs: freshRuns,
          intervalSeconds: 300,
        },
        T0,
      );
      // The §4.3 R2 invariant, both directions: the accounts surface says
      // archived exactly when the status token is archived, and a runtime
      // token never appears beside an archived row.
      expect(view.status === 'archived', cell.label).toBe(derived === 'archived');
    }
  });

  it('the schema-total sourceless fallback still reads keyless (cell 7 honesty arm)', () => {
    const view = accountView(managed({ keyConfigured: false, keySource: 'none' }), record());
    // No §7.3 row can vouch for the environment wording without the
    // server-side resolution; the raw hasKey fact answers the fix-here
    // wording instead (D-138's schema-total fallback, unchanged).
    expect(accountAttentionOf(view, statusRowOf('not-configured'))).toBe('keyless');
    expect(accountAttentionOf(view, null)).toBe('keyless');
  });

  it('the attention module consumes the row verdict even against a stale list (race honesty)', () => {
    // The row's archived verdict outranks a stale active list load, and
    // the raw archived fact outranks a stale working verdict — both
    // directions of the cross-load race resolve to the lifecycle truth.
    const activeList = accountView(managed(), record());
    expect(accountAttentionOf(activeList, statusRowOf('archived'))).toBe('archived');
    const archivedList = accountView(
      managed(),
      record({ status: 'archived', archivedAt: T0 - 1_000 }),
    );
    expect(accountAttentionOf(archivedList, statusRowOf('fresh'))).toBe('archived');
    // The same both-directions rule for the enable switch one rank down.
    const enabledList = accountView(managed({ enabled: true }), record());
    expect(accountAttentionOf(enabledList, statusRowOf('disabled'))).toBe('disabled');
    const disabledList = accountView(managed({ enabled: false }), record());
    expect(accountAttentionOf(disabledList, statusRowOf('fresh'))).toBe('disabled');
  });
});
