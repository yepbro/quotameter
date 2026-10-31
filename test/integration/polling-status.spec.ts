import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  deriveAccountStatus,
  readPollingRunEvidence,
  type AccountStatusInput,
} from '../../src/services/polling-status';
import { COLLECTION_OUTCOMES } from '../../src/services/polling-outcomes';
import { INITIAL_SUSPENSION_STATE } from '../../src/services/polling-suspension';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import {
  createQuotaRepository,
  type QuotaRepository,
  type RunOutcome,
} from '../../src/storage/repository';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 111's storage seam against a real migrated database (spec §7.3,
 * §11.2; decision D-070): {@link readPollingRunEvidence} turns the three
 * D-058 lookups designed for this consumer (latest cycle, latest snapshot,
 * oldest cycle) into the evidence {@link deriveAccountStatus} consumes —
 * one end-to-end §7.3 table straight from `collection_runs`/`snapshots`
 * rows, plus the anchor pins: the last success is the latest *snapshot's*
 * stamp (never a later failed run), the no-success `Stale` anchor is the
 * account's oldest run (by `started_at`, not insertion order), and
 * accounts are isolated. Conventions follow
 * `test/integration/polling-persist.spec.ts`: canonical migrations, §11.1
 * foreign keys on, deterministic §11.1 timestamps. The `node:sqlite`
 * ExperimentalWarning is expected here, as in every storage test
 * (docs/agents/gotchas.md).
 */

/** Deterministic §11.1 epoch-millisecond base for the seeded rows. */
const T0 = 1_761_000_000_000;
/** The §7.1 default interval, in seconds. */
const INTERVAL_SECONDS = 300;
/** §7.3's freshness window at that interval. */
const WINDOW_MS = 3 * INTERVAL_SECONDS * 1000;

/** Runs `body` on a fresh repository over a migrated disposable database. */
async function withRepository(
  body: (repository: QuotaRepository) => Promise<void> | void,
): Promise<void> {
  await withTempDir(async (dir) => {
    const database = new DatabaseSync(dir.sqlitePath());
    database.exec('PRAGMA foreign_keys = ON');
    await createMigrationRunner({ database, migrations: MIGRATIONS }).up();
    const repository = createQuotaRepository({ database });
    try {
      await body(repository);
    } finally {
      database.close();
    }
  });
}

/** Seeds one account row (run rows carry a foreign key to it). */
function seedAccount(repository: QuotaRepository, id: string): void {
  repository.insertAccount({
    id,
    providerId: 'zai-coding-plan',
    label: `Account ${id}`,
    planName: null,
    createdAt: T0,
  });
}

/** Inserts one run row and returns its id. */
function insertRun(
  repository: QuotaRepository,
  accountId: string,
  startedAt: number,
  outcome: RunOutcome,
): number {
  return repository.insertCollectionRun({
    accountId,
    startedAt,
    endedAt: startedAt + 2_500,
    intervalSeconds: INTERVAL_SECONDS,
    outcome,
    httpStatus: null,
    errorMessage: outcome === 'success' ? null : 'Synthetic provider failure',
    attempts: 1,
    retryAfterSeconds: null,
  });
}

/** Inserts one successful run with its snapshot (collected mid-cycle). */
function insertSuccess(repository: QuotaRepository, accountId: string, startedAt: number): void {
  const runId = insertRun(repository, accountId, startedAt, 'success');
  repository.insertSnapshot({ accountId, runId, collectedAt: startedAt + 1_000, planName: null });
}

/** The derivation input for `accountId`'s read evidence, healthy otherwise. */
function statusInput(repository: QuotaRepository, accountId: string): AccountStatusInput {
  return {
    enabled: true,
    configured: true,
    suspension: INITIAL_SUSPENSION_STATE,
    runs: readPollingRunEvidence(repository, accountId),
    intervalSeconds: INTERVAL_SECONDS,
  };
}

describe('readPollingRunEvidence + deriveAccountStatus (integration)', () => {
  it('an account without runs reads all-null evidence and derives Collecting', async () => {
    await withRepository(async (repository) => {
      seedAccount(repository, 'fresh-start');
      expect(readPollingRunEvidence(repository, 'fresh-start')).toEqual({
        latestRunOutcome: null,
        lastSuccessAt: null,
        firstAttemptAt: null,
      });
      expect(deriveAccountStatus(statusInput(repository, 'fresh-start'), T0)).toBe('collecting');
    });
  });

  it.each([...COLLECTION_OUTCOMES])(
    'one %s cycle derives its §7.3 status end-to-end',
    async (outcome) => {
      await withRepository(async (repository) => {
        seedAccount(repository, 'solo');
        if (outcome === 'success') {
          insertSuccess(repository, 'solo', T0);
        } else {
          insertRun(repository, 'solo', T0, outcome);
        }
        const expected =
          outcome === 'success'
            ? 'fresh'
            : outcome === 'auth_error'
              ? 'auth-rejected'
              : outcome === 'parse_error'
                ? 'format-changed'
                : outcome === 'rate_limited'
                  ? 'collecting' // no success yet, the first attempt just happened
                  : 'unreachable'; // network_error | timeout | server_error
        expect(deriveAccountStatus(statusInput(repository, 'solo'), T0 + 2_500)).toBe(expected);
      });
    },
  );

  it('the last success is the latest snapshot stamp, never a later failed run', async () => {
    await withRepository(async (repository) => {
      seedAccount(repository, 'weathered');
      insertSuccess(repository, 'weathered', T0);
      insertSuccess(repository, 'weathered', T0 + INTERVAL_SECONDS * 1000);
      insertRun(repository, 'weathered', T0 + 2 * INTERVAL_SECONDS * 1000, 'network_error');
      const evidence = readPollingRunEvidence(repository, 'weathered');
      expect(evidence.latestRunOutcome).toBe('network_error');
      expect(evidence.lastSuccessAt).toBe(T0 + INTERVAL_SECONDS * 1000 + 1_000);
      // Rank 3 over the (still fresh) data; the snapshot read is what keeps
      // the data age honest when the failure is superseded.
      expect(
        deriveAccountStatus(
          statusInput(repository, 'weathered'),
          T0 + 2 * INTERVAL_SECONDS * 1000 + 2_500,
        ),
      ).toBe('unreachable');
    });
  });

  it('the no-success Stale anchor is the oldest run by started_at, not insertion order', async () => {
    await withRepository(async (repository) => {
      seedAccount(repository, 'rate-limited');
      // Arrives last, is the account's first attempt:
      insertRun(repository, 'rate-limited', T0, 'rate_limited');
      insertRun(repository, 'rate-limited', T0 + 60_000, 'rate_limited');
      const evidence = readPollingRunEvidence(repository, 'rate-limited');
      expect(evidence.firstAttemptAt).toBe(T0);
      expect(evidence.latestRunOutcome).toBe('rate_limited');
      expect(evidence.lastSuccessAt).toBeNull();
      const input = statusInput(repository, 'rate-limited');
      expect(deriveAccountStatus(input, T0 + WINDOW_MS)).toBe('collecting');
      expect(deriveAccountStatus(input, T0 + WINDOW_MS + 1)).toBe('stale');
    });
  });

  it('accounts are isolated: each reads only its own rows', async () => {
    await withRepository(async (repository) => {
      seedAccount(repository, 'healthy');
      seedAccount(repository, 'broken');
      insertSuccess(repository, 'healthy', T0);
      insertRun(repository, 'broken', T0, 'parse_error');
      expect(readPollingRunEvidence(repository, 'healthy')).toEqual({
        latestRunOutcome: 'success',
        lastSuccessAt: T0 + 1_000,
        firstAttemptAt: T0,
      });
      expect(readPollingRunEvidence(repository, 'broken')).toEqual({
        latestRunOutcome: 'parse_error',
        lastSuccessAt: null,
        firstAttemptAt: T0,
      });
    });
  });

  it('the evidence object is frozen', async () => {
    await withRepository(async (repository) => {
      seedAccount(repository, 'frozen');
      expect(Object.isFrozen(readPollingRunEvidence(repository, 'frozen'))).toBe(true);
    });
  });

  it('rejects a malformed repository seam and a blank account id', async () => {
    await withRepository(async (repository) => {
      expect(() => readPollingRunEvidence({} as unknown as QuotaRepository, 'work')).toThrow(
        'readPollingRunEvidence: repository must be a QuotaRepository',
      );
      expect(() => readPollingRunEvidence(repository, '  ')).toThrow(
        'readPollingRunEvidence: accountId must be a non-blank string',
      );
    });
  });
});
