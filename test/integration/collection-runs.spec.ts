import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  createMigrationRunner,
  MIGRATIONS,
  MIGRATIONS_TABLE,
  schemaVersionStatus,
} from '../../src/storage/migrations';
import { createFixedClock } from '../../src/util/clock';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 082's done-condition (spec §11.2): the `collection_runs` table exists,
 * "every listed outcome is constrained and indexed queries pass". The schema
 * is exercised directly at the SQL level — the typed repository is task 088 —
 * against disposable databases migrated by the 078 runner with the canonical
 * set (D-031/D-034). Runs are inserted only after their account exists and
 * with `PRAGMA foreign_keys = ON`, matching the §11.1 connection production
 * uses (task 079); raw `DatabaseSync` handles default to SQLite's off. The
 * `node:sqlite` ExperimentalWarning is expected here, as in every storage
 * test (docs/agents/gotchas.md).
 */

/** Deterministic §11.1 epoch-millisecond timestamps for run rows. */
const T0 = 1_761_000_000_000;

/**
 * The exact §11.2 column contract of `collection_runs` (D-034) — name,
 * declared STRICT type, required flag, and primary-key membership. `id` is
 * the auto-assigned rowid alias the snapshots table (task 083) references,
 * so it is the one column without NOT NULL in its declaration.
 */
const EXPECTED_COLUMNS = [
  { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
  { name: 'account_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'started_at', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'ended_at', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'interval_seconds', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'outcome', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'http_status', type: 'INTEGER', notnull: 0, pk: 0 },
  { name: 'error_message', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'attempts', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'retry_after_seconds', type: 'INTEGER', notnull: 0, pk: 0 },
] as const;

/** The indexes `collection_runs` carries after the canonical set's first
 * three migrations: the two §11.2 query indexes task 082 owes (runs by
 * account/start and by account/outcome/start) plus the unique parent key
 * `collection_runs_account_id_outcome` that task 083's snapshots composite
 * FK added (decision D-036 — pinned in detail in snapshots.spec.ts). In
 * name order, as `PRAGMA index_list` output is sorted for the pin. */
const EXPECTED_INDEXES = [
  { name: 'collection_runs_account_id_outcome', unique: 1, origin: 'c' },
  { name: 'collection_runs_account_outcome_start', unique: 0, origin: 'c' },
  { name: 'collection_runs_account_start', unique: 0, origin: 'c' },
] as const;

/** One `collection_runs` row exactly as INSERTed — every field explicit. */
interface RunRow {
  readonly accountId: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly intervalSeconds: number | null;
  readonly outcome: string | null;
  readonly httpStatus: number | null;
  readonly errorMessage: string | null;
  readonly attempts: number | null;
  readonly retryAfterSeconds: number | null;
}

/** A successful run — the base every overriding test spreads (§7.2's first
 * row is the absence of every failure). */
function successRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    accountId: 'work',
    startedAt: T0,
    endedAt: T0 + 1_200,
    intervalSeconds: 300,
    outcome: 'success',
    httpStatus: 200,
    errorMessage: null,
    attempts: 1,
    retryAfterSeconds: null,
    ...overrides,
  };
}

/** Raw INSERT accepting anything the STRICT columns must reject. */
function insertRawRunValues(
  database: DatabaseSync,
  ...values: Array<string | number | Uint8Array | null>
): void {
  database
    .prepare(
      `INSERT INTO collection_runs
         (account_id, started_at, ended_at, interval_seconds, outcome,
          http_status, error_message, attempts, retry_after_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...values);
}

/** Inserts one typed run row. */
function insertRun(database: DatabaseSync, row: RunRow): void {
  insertRawRunValues(
    database,
    row.accountId,
    row.startedAt,
    row.endedAt,
    row.intervalSeconds,
    row.outcome,
    row.httpStatus,
    row.errorMessage,
    row.attempts,
    row.retryAfterSeconds,
  );
}

/** Inserts an account the run helper's `work` default refers to. */
function insertAccount(database: DatabaseSync, id: string): void {
  database
    .prepare(
      `INSERT INTO accounts (id, provider_id, label, plan_name, status, created_at, archived_at)
       VALUES (?, 'zai-coding-plan', 'Work account', NULL, 'active', ?, NULL)`,
    )
    .run(id, T0);
}

/**
 * A migrated database ready for run inserts: full canonical set applied, the
 * §11.1 foreign-keys setting switched on (079's connection applies it in
 * production; raw handles default to off), and the `work` account present.
 */
async function openRunsDatabase(dbPath: string): Promise<DatabaseSync> {
  const database = new DatabaseSync(dbPath);
  await createMigrationRunner({
    database,
    clock: createFixedClock(T0),
    migrations: MIGRATIONS,
  }).up();
  database.exec('PRAGMA foreign_keys = ON');
  insertAccount(database, 'work');
  return database;
}

/** One stored `collection_runs` row, in SELECT * column order. */
interface StoredRun {
  readonly id: number;
  readonly account_id: string;
  readonly started_at: number;
  readonly ended_at: number;
  readonly interval_seconds: number;
  readonly outcome: string;
  readonly http_status: number | null;
  readonly error_message: string | null;
  readonly attempts: number;
  readonly retry_after_seconds: number | null;
}

/** All `collection_runs` rows, ordered for deterministic assertions. */
function allRuns(database: DatabaseSync): StoredRun[] {
  return database
    .prepare('SELECT * FROM collection_runs ORDER BY id ASC')
    .all() as unknown as StoredRun[];
}

/** The `EXPLAIN QUERY PLAN` details for a statement, joined for matching. */
function queryPlan(database: DatabaseSync, sql: string, ...params: Array<string | number>): string {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join(' | ');
}

describe('collection_runs table (task 082, spec §11.2, decision D-034)', () => {
  it('migrates a schema-1 database forward to up-to-date version 3', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('collection-runs-forward.sqlite');

      // §11.4's forward test from the previous supported schema: a database
      // at schema 1 — migrated by the task-081 canonical set (0001 only).
      const schemaOneSet = MIGRATIONS.filter((migration) => migration.name === '0001-accounts');
      const db = new DatabaseSync(dbPath);
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: schemaOneSet,
      }).up();
      expect(schemaVersionStatus(db, MIGRATIONS)).toEqual({
        supportedVersion: 5,
        appliedVersion: 1,
        relation: 'behind',
        newerThanSupported: [],
      });

      // The canonical set, grown by tasks 082–085, completes it: the four
      // newer migrations apply in order.
      const applied = await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0 + 1),
        migrations: MIGRATIONS,
      }).up();
      expect(applied).toEqual([
        '0002-collection-runs',
        '0003-snapshots',
        '0004-metric-values',
        '0005-quota-events',
      ]);
      expect(schemaVersionStatus(db, MIGRATIONS)).toEqual({
        supportedVersion: 5,
        appliedVersion: 5,
        relation: 'up-to-date',
        newerThanSupported: [],
      });
      db.close();

      // Journal proven through an independent connection: all five entries
      // with their own §11.1 epoch-ms timestamps.
      const reader = new DatabaseSync(dbPath);
      const journal = reader
        .prepare(`SELECT name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY name ASC`)
        .all() as Array<{ name: string; applied_at: number }>;
      expect(journal).toEqual([
        { name: '0001-accounts', applied_at: T0 },
        { name: '0002-collection-runs', applied_at: T0 + 1 },
        { name: '0003-snapshots', applied_at: T0 + 1 },
        { name: '0004-metric-values', applied_at: T0 + 1 },
        { name: '0005-quota-events', applied_at: T0 + 1 },
      ]);
      reader.close();

      // The recorded state is respected: a re-run is a no-op.
      const reopened = new DatabaseSync(dbPath);
      const rerun = await createMigrationRunner({
        database: reopened,
        clock: createFixedClock(T0 + 2),
        migrations: MIGRATIONS,
      }).up();
      expect(rerun).toEqual([]);
      reopened.close();
    });
  });

  it('pins the exact column set: STRICT types, no defaults, both §11.2 indexes', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('collection-runs-columns.sqlite');
      const db = await openRunsDatabase(dbPath);
      db.close();

      const reader = new DatabaseSync(dbPath);
      const info = reader.prepare('PRAGMA table_info(collection_runs)').all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      // §11.2's column list, exactly: names, declared types (STRICT makes
      // them per-value), required columns, and the synthetic run id.
      expect(info.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual(
        EXPECTED_COLUMNS,
      );

      // No SQL-side defaults: timestamps come from the injected clock (D-021)
      // and the run id from the rowid alias — never a database time function.
      expect(info.map((column) => column.dflt_value)).toEqual(
        Array<string | null>(info.length).fill(null),
      );

      // §11.2 "strict tables where feasible": the declaration carries STRICT
      // (the per-value enforcement is pinned by the test below).
      const created = reader
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'collection_runs'")
        .get() as { sql: string };
      expect(created.sql).toMatch(/\)\s*STRICT$/);

      // The table's indexes after the full canonical set: the two plain
      // §11.2 query indexes plus the unique FK parent key (D-036).
      // `index_list` reports reverse-creation order, so sort for the pin.
      const indexes = reader.prepare('PRAGMA index_list(collection_runs)').all() as Array<{
        name: string;
        unique: number;
        origin: string;
      }>;
      const named = [...indexes]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(({ name, unique, origin }) => ({ name, unique, origin }));
      expect(named).toEqual(EXPECTED_INDEXES);
      reader.close();
    });
  });

  it('accepts every §7.2 outcome with the evidence its cycle produces', async () => {
    await withTempDir(async (dir) => {
      const db = await openRunsDatabase(dir.sqlitePath('collection-runs-outcomes.sqlite'));

      // One row per §7.2 class, shaped as its cycle looks: success (1
      // attempt), auth rejected (401, no retry), rate limited (429 with a
      // Retry-After honored within the hour), network error (no status,
      // three retries), timeout (no status, initial try plus three
      // retries), server error (503, retries exhausted), parse error
      // (payload arrived fine but was unusable, §7.2's sanitized response).
      insertRun(db, successRun());
      insertRun(db, successRun({ outcome: 'auth_error', httpStatus: 401 }));
      insertRun(
        db,
        successRun({ outcome: 'rate_limited', httpStatus: 429, retryAfterSeconds: 900 }),
      );
      insertRun(
        db,
        successRun({
          outcome: 'network_error',
          httpStatus: null,
          attempts: 3,
          errorMessage: 'ECONNRESET',
        }),
      );
      insertRun(
        db,
        successRun({
          outcome: 'timeout',
          httpStatus: null,
          attempts: 4,
          errorMessage: 'request timed out',
        }),
      );
      insertRun(db, successRun({ outcome: 'server_error', httpStatus: 503, attempts: 4 }));
      insertRun(
        db,
        successRun({ outcome: 'parse_error', attempts: 1, errorMessage: 'missing required field' }),
      );

      expect(allRuns(db).map((row) => row.outcome)).toEqual([
        'success',
        'auth_error',
        'rate_limited',
        'network_error',
        'timeout',
        'server_error',
        'parse_error',
      ]);
      // §7.2: one record per cycle keeps the total attempt count.
      expect(allRuns(db).map((row) => row.attempts)).toEqual([1, 1, 1, 3, 4, 4, 1]);

      // The §7.2 rate-limited row round-trips its evidence whole.
      const rateLimited = allRuns(db).find((row) => row.outcome === 'rate_limited');
      expect(rateLimited).toMatchObject({
        account_id: 'work',
        interval_seconds: 300,
        http_status: 429,
        retry_after_seconds: 900,
      });
      db.close();
    });
  });

  it('rejects outcome values outside the §11.2 enum', async () => {
    await withTempDir(async (dir) => {
      const db = await openRunsDatabase(dir.sqlitePath('collection-runs-bad-outcome.sqlite'));

      // Case-sensitive enum; §7.3's display states and hyphenated spellings
      // are different vocabularies that must not leak into storage.
      const badOutcomes = [
        'AUTH_ERROR',
        'auth-error',
        'http_error',
        'ok',
        'success ', // trailing whitespace is a different value
        'parse-error',
        '',
      ];
      for (const outcome of badOutcomes) {
        expect(() => insertRun(db, successRun({ outcome })), `outcome '${outcome}'`).toThrow(
          /CHECK constraint failed: collection_runs_outcome/,
        );
      }
      expect(() => insertRun(db, successRun({ outcome: null }))).toThrow(
        /NOT NULL constraint failed: collection_runs.outcome/,
      );

      expect(allRuns(db)).toEqual([]);

      // Constraints bind the UPDATE path too — a future repository writing
      // through them cannot corrupt recorded history silently.
      insertRun(db, successRun());
      expect(() => db.prepare("UPDATE collection_runs SET outcome = 'bogus'").run()).toThrow(
        /CHECK constraint failed: collection_runs_outcome/,
      );
      expect(allRuns(db).map((row) => row.outcome)).toEqual(['success']);
      db.close();
    });
  });

  it('rejects NULL in every required column', async () => {
    await withTempDir(async (dir) => {
      const db = await openRunsDatabase(dir.sqlitePath('collection-runs-required.sqlite'));

      expect(() => insertRun(db, successRun({ accountId: null }))).toThrow(
        /NOT NULL constraint failed: collection_runs.account_id/,
      );
      expect(() => insertRun(db, successRun({ startedAt: null }))).toThrow(
        /NOT NULL constraint failed: collection_runs.started_at/,
      );
      expect(() => insertRun(db, successRun({ endedAt: null }))).toThrow(
        /NOT NULL constraint failed: collection_runs.ended_at/,
      );
      expect(() => insertRun(db, successRun({ intervalSeconds: null }))).toThrow(
        /NOT NULL constraint failed: collection_runs.interval_seconds/,
      );
      expect(() => insertRun(db, successRun({ attempts: null }))).toThrow(
        /NOT NULL constraint failed: collection_runs.attempts/,
      );

      expect(allRuns(db)).toEqual([]);
      db.close();
    });
  });

  it('enforces the §7.1 interval range and §7.2 attempt/retry-after bounds', async () => {
    await withTempDir(async (dir) => {
      const db = await openRunsDatabase(dir.sqlitePath('collection-runs-ranges.sqlite'));

      // §7.1: the interval in effect is the validated 60–3600 range.
      for (const intervalSeconds of [59, 3601, -300]) {
        expect(
          () => insertRun(db, successRun({ intervalSeconds })),
          `interval ${intervalSeconds}`,
        ).toThrow(/CHECK constraint failed: collection_runs_interval_range/);
      }
      for (const intervalSeconds of [60, 300, 3600]) {
        insertRun(db, successRun({ intervalSeconds }));
      }

      // §7.2: a run records a total attempt count — at least one request
      // happened; the retry ceiling is poller policy, not storage truth.
      for (const attempts of [0, -1]) {
        expect(() => insertRun(db, successRun({ attempts })), `attempts ${attempts}`).toThrow(
          /CHECK constraint failed: collection_runs_attempts_positive/,
        );
      }
      insertRun(db, successRun({ attempts: 4 }));

      // §7.2: Retry-After is respected "up to one hour" — the honored value
      // is a non-negative delay within that cap, or absent.
      for (const retryAfterSeconds of [-1, 3601]) {
        expect(
          () =>
            insertRun(
              db,
              successRun({ outcome: 'rate_limited', httpStatus: 429, retryAfterSeconds }),
            ),
          `retry-after ${retryAfterSeconds}`,
        ).toThrow(/CHECK constraint failed: collection_runs_retry_after_range/);
      }
      insertRun(db, successRun({ outcome: 'rate_limited', httpStatus: 429, retryAfterSeconds: 0 }));
      insertRun(
        db,
        successRun({ outcome: 'rate_limited', httpStatus: 429, retryAfterSeconds: 3600 }),
      );

      expect(allRuns(db)).toHaveLength(6);
      db.close();
    });
  });

  it('constrains http_status to NULL or a real status code', async () => {
    await withTempDir(async (dir) => {
      const db = await openRunsDatabase(dir.sqlitePath('collection-runs-status.sqlite'));

      for (const httpStatus of [99, 600, 0]) {
        expect(() => insertRun(db, successRun({ httpStatus })), `status ${httpStatus}`).toThrow(
          /CHECK constraint failed: collection_runs_http_status_range/,
        );
      }
      insertRun(db, successRun({ httpStatus: 100 }));
      insertRun(db, successRun({ httpStatus: 599 }));
      // No response arrived — the network-failure and timeout shapes.
      insertRun(db, successRun({ outcome: 'network_error', httpStatus: null, attempts: 2 }));
      insertRun(db, successRun({ outcome: 'timeout', httpStatus: null, attempts: 2 }));
      // The uncoupling cuts both ways: storage does not demand a status for
      // a success either — §7.2's outcome↔HTTP mapping is the collector's
      // to guarantee, not the on-disk contract's (D-034).
      insertRun(db, successRun({ httpStatus: null }));

      expect(allRuns(db)).toHaveLength(5);
      db.close();
    });
  });

  it('keeps error_message absent-or-non-blank and successful runs error-free', async () => {
    await withTempDir(async (dir) => {
      const db = await openRunsDatabase(dir.sqlitePath('collection-runs-error.sqlite'));

      // A blank message is not a third state (the plan_name precedent).
      expect(() => insertRun(db, successRun({ outcome: 'parse_error', errorMessage: '' }))).toThrow(
        /CHECK constraint failed: collection_runs_error_nonempty/,
      );

      // A successful run records no error text — the one §7.2 coupling.
      expect(() => insertRun(db, successRun({ errorMessage: 'recovered after retry' }))).toThrow(
        /CHECK constraint failed: collection_runs_success_clean/,
      );

      // A failure may carry its sanitized message (already sanitized by the
      // provider layer, task 102) or none at all.
      insertRun(db, successRun({ outcome: 'parse_error', errorMessage: 'missing required field' }));
      insertRun(db, successRun({ outcome: 'network_error', httpStatus: null }));
      insertRun(db, successRun());

      expect(allRuns(db).map((row) => [row.outcome, row.error_message])).toEqual([
        ['parse_error', 'missing required field'],
        ['network_error', null],
        ['success', null],
      ]);
      db.close();
    });
  });

  it('rejects account ids outside the D-014 charset', async () => {
    await withTempDir(async (dir) => {
      const db = await openRunsDatabase(dir.sqlitePath('collection-runs-bad-ids.sqlite'));

      // The same boundaries as accounts (D-032): history rows may only key
      // on ids the accounts table can hold.
      const badIds = [
        '', // empty
        '-lead', // leading '-' — the first character must be alphanumeric
        'sp ace', // spaces anywhere
        `${'a'.repeat(64)}x`, // 65 characters — one past the bound
        'a\0b', // embedded NUL: GLOB/length stop at NUL, the stored bytes do not
      ];
      for (const accountId of badIds) {
        expect(() => insertRun(db, successRun({ accountId })), `id '${accountId}'`).toThrow(
          /CHECK constraint failed: collection_runs_account_charset/,
        );
      }

      // A number bound for the TEXT column is affinity-rendered with a
      // decimal point ('123.0') before the CHECK runs.
      expect(() =>
        insertRawRunValues(db, 123, T0, T0 + 1, 300, 'success', 200, null, 1, null),
      ).toThrow(/CHECK constraint failed: collection_runs_account_charset/);

      expect(allRuns(db)).toEqual([]);
      db.close();
    });
  });

  it('enforces STRICT runtime types', async () => {
    await withTempDir(async (dir) => {
      const db = await openRunsDatabase(dir.sqlitePath('collection-runs-strict.sqlite'));

      // §11.2 "strict tables where feasible", per value: a blob cannot
      // enter the TEXT account id and text cannot enter an INTEGER column.
      expect(() =>
        insertRawRunValues(
          db,
          new Uint8Array([0x61]),
          T0,
          T0 + 1,
          300,
          'success',
          200,
          null,
          1,
          null,
        ),
      ).toThrow(/cannot store BLOB value in TEXT column collection_runs.account_id/);
      expect(() =>
        insertRawRunValues(db, 'work', 'yesterday', T0 + 1, 300, 'success', 200, null, 1, null),
      ).toThrow(/cannot store TEXT value in INTEGER column collection_runs.started_at/);

      expect(allRuns(db)).toEqual([]);
      db.close();
    });
  });

  it('links runs to accounts: unknown accounts rejected, deletion cascades', async () => {
    await withTempDir(async (dir) => {
      const db = await openRunsDatabase(dir.sqlitePath('collection-runs-fk.sqlite'));
      db.exec('PRAGMA foreign_keys = ON');

      // §11.2: run→account is a real reference — a run for an account that
      // does not exist cannot be recorded.
      expect(() => insertRun(db, successRun({ accountId: 'ghost' }))).toThrow(
        /FOREIGN KEY constraint failed/,
      );

      // §8.2: archiving retains history — an archived account keeps
      // collecting reference-able rows.
      insertAccount(db, 'gone');
      db.prepare(`UPDATE accounts SET status = 'archived', archived_at = ? WHERE id = 'gone'`).run(
        T0 + 1,
      );
      insertRun(db, successRun({ accountId: 'gone', outcome: 'auth_error', httpStatus: 401 }));

      insertRun(db, successRun());
      insertRun(db, successRun({ startedAt: T0 + 300_000, endedAt: T0 + 301_200 }));
      expect(allRuns(db)).toHaveLength(3);

      // §11.2 "cascading deletion for purged account history": removing an
      // account removes exactly its runs.
      db.prepare(`DELETE FROM accounts WHERE id = 'work'`).run();
      const remaining = allRuns(db);
      expect(remaining.map((row) => row.account_id)).toEqual(['gone']);
      db.close();
    });
  });

  it('assigns sequential integer ids as the run reference for snapshots', async () => {
    await withTempDir(async (dir) => {
      const db = await openRunsDatabase(dir.sqlitePath('collection-runs-ids.sqlite'));

      // The rowid alias: ids are assigned on insert (the INSERT names no
      // id column) and stay integers — the shape task 083's snapshots
      // reference as "run id".
      insertRun(db, successRun());
      insertRun(db, successRun({ outcome: 'server_error', httpStatus: 503, attempts: 4 }));
      insertRun(db, successRun({ startedAt: T0 + 300_000, endedAt: T0 + 300_900 }));

      const runs = allRuns(db);
      expect(runs.map((row) => row.id)).toEqual([1, 2, 3]);
      expect(runs.every((row) => Number.isInteger(row.id))).toBe(true);
      db.close();
    });
  });

  it('serves the §11.2 run queries from the named indexes', async () => {
    await withTempDir(async (dir) => {
      const db = await openRunsDatabase(dir.sqlitePath('collection-runs-indexes.sqlite'));
      insertRun(db, successRun());
      insertRun(
        db,
        successRun({
          startedAt: T0 + 300_000,
          endedAt: T0 + 301_200,
          outcome: 'timeout',
          httpStatus: null,
          attempts: 4,
        }),
      );
      insertRun(
        db,
        successRun({
          startedAt: T0 + 600_000,
          endedAt: T0 + 601_200,
          outcome: 'network_error',
          httpStatus: null,
          attempts: 3,
        }),
      );

      // Runs by account/start — the recent-history shape (§7.3's Stale and
      // "most recent successful collection" both scan an account's runs in
      // start order): searched through the account/start index, ordered by
      // it, with no temporary sort.
      const byStart = queryPlan(
        db,
        'SELECT id FROM collection_runs WHERE account_id = ? ORDER BY started_at DESC',
        'work',
      );
      // `SELECT id` reads only index columns (the rowid rides every index
      // entry), so the plan reports the covering variant of the search.
      expect(byStart).toMatch(/USING (COVERING )?INDEX collection_runs_account_start/);
      expect(byStart).not.toContain('TEMP B-TREE');

      // Runs by account/outcome/start — the §7.3 status scan (latest run
      // per outcome within a window, e.g. every Unreachable cycle):
      // searched through the three-column index.
      const byOutcome = queryPlan(
        db,
        'SELECT id FROM collection_runs WHERE account_id = ? AND outcome = ? AND started_at >= ?',
        'work',
        'network_error',
        T0,
      );
      expect(byOutcome).toMatch(/USING (COVERING )?INDEX collection_runs_account_outcome_start/);

      // And the queries return the right rows — indexes serve §11.3's
      // "history queries must be indexed and should remain usable at that
      // scale".
      const recent = db
        .prepare(
          'SELECT outcome FROM collection_runs WHERE account_id = ? ORDER BY started_at DESC',
        )
        .all('work') as Array<{ outcome: string }>;
      expect(recent.map((row) => row.outcome)).toEqual(['network_error', 'timeout', 'success']);
      const unreachable = db
        .prepare(
          'SELECT COUNT(*) AS n FROM collection_runs WHERE account_id = ? AND outcome = ? AND started_at >= ?',
        )
        .get('work', 'network_error', T0) as { n: number };
      expect(unreachable.n).toBe(1);
      db.close();
    });
  });
});
