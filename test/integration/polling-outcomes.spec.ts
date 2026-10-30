import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  TransportConnectionError,
  TransportStatusError,
  TransportTimeoutError,
} from '../../src/providers/transport';
import {
  classifyParseFailure,
  classifySuccess,
  classifyTransportError,
  COLLECTION_OUTCOMES,
  isCollectionOutcome,
} from '../../src/services/polling-outcomes';
import { createFixedClock } from '../../src/util/clock';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 105's outcome-persistence done-condition: every outcome the
 * classifier emits is exactly what the landed `collection_runs` CHECK
 * accepts — D-034's `collection_runs_outcome` enum over migration
 * `0002-collection-runs`. The parity is proven in both directions against
 * the real database (not the source text): the CHECK's admitted values are
 * read back from `sqlite_master` and compared to `COLLECTION_OUTCOMES`,
 * then one classifier-derived row per outcome is inserted, and a bogus
 * value plus the classifier's `'cancelled'` pseudo-outcome are proven
 * unwritable. The canonical `MIGRATIONS` set is applied as-is with no
 * length or version pin: parallel tasks (085+) append entries, and this
 * spec must stay green when they do. The `node:sqlite` ExperimentalWarning
 * is expected, as in every storage test (docs/agents/gotchas.md).
 */

/** Deterministic §11.1 epoch-millisecond timestamps for run rows. */
const T0 = 1_761_000_000_000;

/**
 * A migrated database with the `work` account present: the full canonical
 * set applied and §11.1's foreign-keys setting switched on (079's connection
 * applies it in production; raw handles default to off).
 */
async function openDatabase(dbPath: string): Promise<DatabaseSync> {
  const database = new DatabaseSync(dbPath);
  await createMigrationRunner({
    database,
    clock: createFixedClock(T0),
    migrations: MIGRATIONS,
  }).up();
  database.exec('PRAGMA foreign_keys = ON');
  database
    .prepare(
      `INSERT INTO accounts (id, provider_id, label, plan_name, status, created_at, archived_at)
       VALUES ('work', 'zai-coding-plan', 'Work account', NULL, 'active', ?, NULL)`,
    )
    .run(T0);
  return database;
}

/** One classifier-derived classification per §11.2 outcome. */
const OUTCOME_SOURCES = [
  classifySuccess(200),
  classifyTransportError(new TransportStatusError(401, 'Unauthorized', undefined)),
  classifyTransportError(new TransportStatusError(429, 'Too Many Requests', '37')),
  classifyTransportError(new TransportConnectionError('ECONNREFUSED')),
  classifyTransportError(new TransportTimeoutError(15_000)),
  classifyTransportError(new TransportStatusError(503, 'Service Unavailable', undefined)),
  classifyParseFailure({ httpStatus: 200, reason: 'payload did not match the expected schema' }),
] as const;

/**
 * The outcome values D-034's `collection_runs_outcome` CHECK admits, read
 * from the migrated database's own schema — the on-disk contract, not the
 * TypeScript constant.
 */
function checkOutcomeValues(database: DatabaseSync): string[] {
  const row = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'collection_runs'`)
    .get() as { sql: string };
  const match =
    /CONSTRAINT\s+collection_runs_outcome\s+CHECK\s*\(\s*outcome\s+IN\s*\(([^)]*)\)/.exec(row.sql);
  expect(match, 'collection_runs_outcome CHECK not found in the table DDL').not.toBeNull();
  return (match?.[1] ?? '').split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
}

/** Inserts one run row carrying the classification's own fields. */
function insertClassifiedRun(
  database: DatabaseSync,
  outcome: string,
  httpStatus: number | null,
  errorMessage: string | null,
  retryAfterSeconds: number | null,
  attempts: number,
): void {
  database
    .prepare(
      `INSERT INTO collection_runs
         (account_id, started_at, ended_at, interval_seconds, outcome,
          http_status, error_message, attempts, retry_after_seconds)
       VALUES ('work', ?, ?, 300, ?, ?, ?, ?, ?)`,
    )
    .run(T0, T0 + 1_500, outcome, httpStatus, errorMessage, attempts, retryAfterSeconds);
}

describe('outcome persistence parity (task 105, spec §11.2, D-034/D-048)', () => {
  it('the CHECK enum equals COLLECTION_OUTCOMES in both directions', async () => {
    await withTempDir(async (dir) => {
      const database = await openDatabase(dir.sqlitePath('outcome-parity.sqlite'));
      try {
        expect(new Set(checkOutcomeValues(database))).toEqual(new Set(COLLECTION_OUTCOMES));
      } finally {
        database.close();
      }
    });
  });

  it('every classifier outcome writes one accepted run row', async () => {
    await withTempDir(async (dir) => {
      const database = await openDatabase(dir.sqlitePath('outcome-inserts.sqlite'));
      try {
        let attempts = 0;
        for (const classification of OUTCOME_SOURCES) {
          attempts += 1;
          if (!isCollectionOutcome(classification.outcome)) {
            throw new Error(`outcome source classified as '${classification.outcome}'`);
          }
          // retry_after_seconds is 107's parse of retryAfterRaw; for the
          // one source carrying a raw value ('37') the integer form is
          // written, proving the retained metadata fits the column.
          const retryAfterSeconds =
            classification.retryAfterRaw === undefined
              ? null
              : Number.parseInt(classification.retryAfterRaw, 10);
          insertClassifiedRun(
            database,
            classification.outcome,
            classification.httpStatus ?? null,
            classification.errorMessage ?? null,
            retryAfterSeconds,
            attempts,
          );
        }
        const stored = database
          .prepare(`SELECT outcome, http_status, error_message FROM collection_runs ORDER BY id`)
          .all() as Array<{
          outcome: string;
          http_status: number | null;
          error_message: string | null;
        }>;
        expect(stored.map((row) => row.outcome).sort()).toEqual([...COLLECTION_OUTCOMES].sort());
        // A success run stays error-free (collection_runs_success_clean).
        expect(stored.find((row) => row.outcome === 'success')?.error_message).toBeNull();
      } finally {
        database.close();
      }
    });
  });

  it('rejects an outcome outside the enum', async () => {
    await withTempDir(async (dir) => {
      const database = await openDatabase(dir.sqlitePath('outcome-bogus.sqlite'));
      try {
        expect(() =>
          insertClassifiedRun(database, 'validation_error', null, 'nope', null, 1),
        ).toThrow(/collection_runs_outcome/);
      } finally {
        database.close();
      }
    });
  });

  it("rejects the classifier's 'cancelled' pseudo-outcome", async () => {
    await withTempDir(async (dir) => {
      const database = await openDatabase(dir.sqlitePath('outcome-cancelled.sqlite'));
      try {
        // `aborted` classifies outside the enum precisely so it cannot be
        // persisted as a collection outcome (D-048): the CHECK agrees.
        expect(() =>
          insertClassifiedRun(database, 'cancelled', null, 'caller aborted', null, 1),
        ).toThrow(/collection_runs_outcome/);
      } finally {
        database.close();
      }
    });
  });
});
