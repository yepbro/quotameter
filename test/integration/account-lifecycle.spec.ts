import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { purgeAccount, retireAccount } from '../../src/storage/account-lifecycle';
import {
  persistCollectionCycle,
  type CycleEventInput,
  type CycleMetricInput,
  type ParseFailureCollectionCycle,
  type SuccessfulCollectionCycle,
} from '../../src/storage/collection-cycles';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import {
  createQuotaRepository,
  type NewAccount,
  type QuotaRepository,
} from '../../src/storage/repository';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 090's done-condition (spec §8.2, §11.2): archive and purge are
 * distinct operations with distinct tests, and the cascade behavior is
 * correct — verified, not asserted. The retirement suite pins the §8.2
 * default: a retired account stays queryable with every history row
 * intact (runs, snapshot, metrics, events, raw payload), re-retirement is
 * a no-op keeping the original timestamp (D-058), and an unknown account
 * reports `unknown`. The purge suite pins the explicit action: every
 * §11.2 account-history table cascades away, sessions and meta survive
 * (D-056 — service state, not account history), another account's history
 * is untouched, an already-archived account purges identically, and a
 * cascade that leaves residue (a foreign-keys-off connection) fails
 * loudly instead of reporting success. Conventions follow
 * `test/integration/collection-cycles.spec.ts`: fresh disposable
 * databases, the canonical migrations, deterministic §11.1 timestamps, and
 * history seeded through the 089 atomic-cycle seam. The `node:sqlite`
 * ExperimentalWarning is expected here, as in every storage test
 * (docs/agents/gotchas.md).
 */

/** Deterministic §11.1 epoch-millisecond timestamps for the factories. */
const T0 = 1_761_000_000_000;

/** A session digest in the D-056 shape — SHA-256 hex, never the token. */
const TOKEN_HASH = createHash('sha256').update('fixture-session-token').digest('hex');

/**
 * Runs `body` against a fresh repository over a fully migrated disposable
 * database. `foreignKeys: false` opens the connection the way a raw
 * `node:sqlite` handle defaults (D-056's pinned note) — the residue
 * defense's failure mode.
 */
async function withRepository(
  body: (repository: QuotaRepository, database: DatabaseSync) => Promise<void> | void,
  options: { readonly foreignKeys?: boolean } = {},
): Promise<void> {
  const { foreignKeys = true } = options;
  await withTempDir(async (dir) => {
    const database = new DatabaseSync(dir.sqlitePath());
    database.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    await createMigrationRunner({ database, migrations: MIGRATIONS }).up();
    const repository = createQuotaRepository({ database });
    try {
      await body(repository, database);
    } finally {
      database.close();
    }
  });
}

/* ── Input factories (every field explicit, spreads for overrides) ─────── */

function account(overrides: Partial<NewAccount> = {}): NewAccount {
  return {
    id: 'work',
    providerId: 'zai-coding-plan',
    label: 'Work plan',
    planName: 'Pro',
    createdAt: T0,
    ...overrides,
  };
}

function metricInput(overrides: Partial<CycleMetricInput> = {}): CycleMetricInput {
  return {
    metricKey: 'monthly-credits',
    limitType: 'MONTHLY',
    unit: 'CREDITS',
    windowSeconds: null,
    used: 80,
    remaining: 20,
    limit: 100,
    percentUsed: 80,
    percentRemaining: 20,
    resetsAt: T0 + 86_400_000,
    isValid: true,
    invalidReason: null,
    derivedFields: null,
    ...overrides,
  };
}

function eventInput(overrides: Partial<CycleEventInput> = {}): CycleEventInput {
  return {
    metricKey: 'monthly-credits',
    eventType: 'RESET',
    eventAt: T0 + 86_400_000,
    details: {
      reason: 'used decreased beyond tolerance',
      previous: { collectedAt: T0, used: 80 },
      current: { collectedAt: T0 + 300_000, used: 5 },
    },
    ...overrides,
  };
}

function successCycle(
  overrides: Partial<SuccessfulCollectionCycle> = {},
): SuccessfulCollectionCycle {
  return {
    accountId: 'work',
    startedAt: T0,
    endedAt: T0 + 1_200,
    intervalSeconds: 300,
    attempts: 1,
    httpStatus: 200,
    outcome: 'success',
    snapshot: {
      collectedAt: T0 + 1_200,
      planName: 'Pro',
      metrics: [metricInput()],
      events: [],
    },
    ...overrides,
  };
}

function parseErrorCycle(
  overrides: Partial<ParseFailureCollectionCycle> = {},
): ParseFailureCollectionCycle {
  return {
    accountId: 'work',
    startedAt: T0 + 300_000,
    endedAt: T0 + 300_500,
    intervalSeconds: 300,
    attempts: 1,
    httpStatus: 200,
    errorMessage: 'envelope mismatch',
    retryAfterSeconds: null,
    outcome: 'parse_error',
    rawResponse: {
      capturedAt: T0 + 300_000,
      httpStatus: 200,
      contentType: 'application/json',
      body: '{"limits": [1, 2]}',
    },
    ...overrides,
  };
}

/** The seeded history's run identities, for direct per-run assertions. */
interface SeededRuns {
  readonly successRunId: number;
  readonly parseRunId: number;
}

/**
 * Seeds one account with a row in every §11.2 account-history table — one
 * successful cycle (snapshot, two metric rows, one reset event) and one
 * parse-failure cycle (a sanitized raw payload) — through the atomic
 * cycle seam (task 089), plus one run-free event (`run_id` NULL): §11.2
 * admits that row shape, and it cascades only through the direct
 * account FK (a NULL column satisfies the composite snapshot FK
 * vacuously), an edge the cycle seam cannot produce.
 */
function seedHistory(repository: QuotaRepository, accountId = 'work'): SeededRuns {
  repository.insertAccount(account({ id: accountId }));
  const successRunId = persistCollectionCycle(
    repository,
    successCycle({
      accountId,
      snapshot: {
        collectedAt: T0 + 1_200,
        planName: 'Pro',
        metrics: [
          metricInput({ metricKey: 'monthly-credits' }),
          metricInput({ metricKey: 'weekly-requests', limitType: 'WEEKLY', unit: 'REQUESTS' }),
        ],
        events: [eventInput()],
      },
    }),
  );
  const parseRunId = persistCollectionCycle(repository, parseErrorCycle({ accountId }));
  repository.insertQuotaEvent({
    accountId,
    metricKey: 'five-hour-credits',
    eventType: 'RESET',
    eventAt: T0 + 600_000,
    runId: null,
    details: {
      reason: 'run-free evidence row',
      previous: { collectedAt: T0, used: 90 },
      current: { collectedAt: T0 + 600_000, used: 10 },
    },
  });
  return { successRunId, parseRunId };
}

/* ── Retirement: the §8.2 default keeps history ────────────────────────── */

describe('account retirement — the §8.2 default keeps history (task 090, spec §8.2)', () => {
  it('archives an active account and keeps every history row queryable', async () => {
    await withRepository((repository) => {
      const { successRunId, parseRunId } = seedHistory(repository);
      const archivedAt = T0 + 5 * 86_400_000;

      const outcome = retireAccount(repository, { accountId: 'work', archivedAt });

      expect(outcome).toEqual({
        result: 'archived',
        account: {
          id: 'work',
          providerId: 'zai-coding-plan',
          label: 'Work plan',
          planName: 'Pro',
          status: 'archived',
          createdAt: T0,
          archivedAt,
        },
      });
      // §8.2 archive-not-delete: the account row stays queryable …
      expect(repository.getAccount('work')?.status).toBe('archived');
      // … and so does every history row, through every read path.
      expect(repository.listCollectionRuns('work')).toHaveLength(2);
      expect(repository.getSnapshotByRun(successRunId)).not.toBe(null);
      expect(repository.getMetricValuesForRun(successRunId)).toHaveLength(2);
      expect(repository.getMetricSeries('work', 'monthly-credits')).toHaveLength(1);
      expect(repository.listQuotaEvents('work')).toHaveLength(2);
      expect(repository.getRawResponseByRun(parseRunId)).not.toBe(null);
    });
  });

  it('re-retirement is a no-op keeping the original archive timestamp (D-058)', async () => {
    await withRepository((repository) => {
      seedHistory(repository);
      const firstArchivedAt = T0 + 5 * 86_400_000;
      expect(retireAccount(repository, { accountId: 'work', archivedAt: firstArchivedAt })).toEqual(
        expect.objectContaining({ result: 'archived' }),
      );

      const second = retireAccount(repository, {
        accountId: 'work',
        archivedAt: firstArchivedAt + 1,
      });

      // The lifecycle event happened once; the second call changes nothing.
      expect(second).toMatchObject({
        result: 'already-archived',
        account: { archivedAt: firstArchivedAt, status: 'archived' },
      });
      expect(repository.getAccount('work')?.archivedAt).toBe(firstArchivedAt);
      expect(repository.listCollectionRuns('work')).toHaveLength(2);
      expect(repository.listQuotaEvents('work')).toHaveLength(2);
    });
  });

  it('reports unknown for an account that does not exist', async () => {
    await withRepository((repository) => {
      expect(retireAccount(repository, { accountId: 'ghost', archivedAt: T0 })).toEqual({
        result: 'unknown',
      });
      expect(repository.getAccount('ghost')).toBe(null);
      expect(repository.listAccounts()).toEqual([]);
    });
  });

  it('archives an account that has collected no history yet', async () => {
    await withRepository((repository) => {
      repository.insertAccount(account());
      expect(retireAccount(repository, { accountId: 'work', archivedAt: T0 })).toEqual(
        expect.objectContaining({ result: 'archived' }),
      );
      expect(repository.getAccount('work')?.status).toBe('archived');
    });
  });
});

/* ── Purge: the §8.2 explicit action cascades every history table ──────── */

describe('account purge — the §8.2 explicit action cascades every history table (task 090, spec §8.2, §11.2)', () => {
  it('purges an active account, cascades every history table, and reports what was removed', async () => {
    await withRepository((repository) => {
      const { successRunId, parseRunId } = seedHistory(repository);

      const outcome = purgeAccount(repository, 'work');

      expect(outcome).toEqual({
        result: 'purged',
        account: expect.objectContaining({ id: 'work', status: 'active' }),
        removed: {
          collectionRuns: 2,
          snapshots: 1,
          metricValues: 2,
          quotaEvents: 2,
          rawResponses: 1,
        },
      });
      // The account row and every history row are gone — each table checked
      // through its account-level read …
      expect(repository.getAccount('work')).toBe(null);
      expect(repository.listCollectionRuns('work')).toEqual([]);
      expect(repository.listSnapshots('work')).toEqual([]);
      expect(repository.listQuotaEvents('work')).toEqual([]);
      expect(repository.listRawResponses('work')).toEqual([]);
      // … and through the per-run reads, the identity every row keys on.
      expect(repository.getSnapshotByRun(successRunId)).toBe(null);
      expect(repository.getMetricValuesForRun(successRunId)).toEqual([]);
      expect(repository.getRawResponseByRun(parseRunId)).toBe(null);
    });
  });

  it('purges an already-archived account identically', async () => {
    await withRepository((repository) => {
      seedHistory(repository);
      retireAccount(repository, { accountId: 'work', archivedAt: T0 + 86_400_000 });

      const outcome = purgeAccount(repository, 'work');

      // §8.2's explicit action states no archive-first requirement (D-061):
      // an archived account purges exactly like an active one.
      expect(outcome).toEqual({
        result: 'purged',
        account: expect.objectContaining({ id: 'work', status: 'archived' }),
        removed: {
          collectionRuns: 2,
          snapshots: 1,
          metricValues: 2,
          quotaEvents: 2,
          rawResponses: 1,
        },
      });
      expect(repository.getAccount('work')).toBe(null);
      expect(repository.listCollectionRuns('work')).toEqual([]);
      expect(repository.listSnapshots('work')).toEqual([]);
      expect(repository.listQuotaEvents('work')).toEqual([]);
      expect(repository.listRawResponses('work')).toEqual([]);
    });
  });

  it('reports unknown for a missing account and for an already-purged one', async () => {
    await withRepository((repository) => {
      expect(purgeAccount(repository, 'ghost')).toEqual({ result: 'unknown' });

      seedHistory(repository);
      expect(purgeAccount(repository, 'work')).toEqual(
        expect.objectContaining({ result: 'purged' }),
      );
      expect(purgeAccount(repository, 'work')).toEqual({ result: 'unknown' });
    });
  });

  it("leaves another account's row and history untouched by the purge", async () => {
    await withRepository((repository) => {
      seedHistory(repository, 'work');
      const personal = seedHistory(repository, 'personal');

      expect(purgeAccount(repository, 'work')).toEqual(
        expect.objectContaining({ result: 'purged' }),
      );

      // The cascade reached only the purged account's rows.
      expect(repository.getAccount('work')).toBe(null);
      expect(repository.listCollectionRuns('work')).toEqual([]);

      // The active account keeps its row and its full history.
      expect(repository.getAccount('personal')?.status).toBe('active');
      expect(repository.listCollectionRuns('personal')).toHaveLength(2);
      expect(repository.listSnapshots('personal')).toHaveLength(1);
      expect(repository.getMetricValuesForRun(personal.successRunId)).toHaveLength(2);
      expect(repository.getMetricSeries('personal', 'weekly-requests')).toHaveLength(1);
      expect(repository.listQuotaEvents('personal')).toHaveLength(2);
      expect(repository.listRawResponses('personal')).toHaveLength(1);
    });
  });

  it('leaves sessions and meta untouched — service state, not account history (D-056)', async () => {
    await withRepository((repository) => {
      seedHistory(repository);
      repository.insertSession({
        tokenHash: TOKEN_HASH,
        createdAt: T0,
        lastSeenAt: T0,
        expiresAt: T0 + 604_800_000,
      });
      repository.setMetaValue('cleanup:last-run', '2026-10-31T00:00:00Z');

      expect(purgeAccount(repository, 'work')).toEqual(
        expect.objectContaining({ result: 'purged' }),
      );

      expect(repository.getSession(TOKEN_HASH)).not.toBe(null);
      expect(repository.getMetaValue('cleanup:last-run')).toBe('2026-10-31T00:00:00Z');
    });
  });

  it('throws loudly when the cascade leaves residue behind (a foreign-keys-off connection)', async () => {
    await withRepository(
      (repository) => {
        seedHistory(repository);

        // The account row itself is deleted, but with FK enforcement off
        // the cascades never fire — the purge must fail loudly instead of
        // reporting success over orphaned history (D-061's defense). The
        // message names every surviving table class and the likely cause.
        expect(() => purgeAccount(repository, 'work')).toThrow(
          /purgeAccount: history survived the cascade delete of account 'work' \(collection runs, snapshots, metric values, quota events, raw responses\); is foreign_keys disabled/,
        );

        expect(repository.getAccount('work')).toBe(null);
        expect(repository.listCollectionRuns('work')).toHaveLength(2);
        expect(repository.listSnapshots('work')).toHaveLength(1);
      },
      { foreignKeys: false },
    );
  });
});
