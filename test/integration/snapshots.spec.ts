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
 * Task 083's done-condition (spec §11.2): the `snapshots` table exists,
 * "each successful run has at most one snapshot and lookup by account/time
 * is indexed". The schema is exercised directly at the SQL level — the typed
 * repository is task 088 — against disposable databases migrated by the 078
 * runner with the canonical set (D-031/D-036). Runs are inserted only after
 * their account exists and with `PRAGMA foreign_keys = ON`, matching the
 * §11.1 connection production uses (task 079); raw `DatabaseSync` handles
 * default to SQLite's off (D-034's pinned note for storage tests). The
 * `node:sqlite` ExperimentalWarning is expected here, as in every storage
 * test (docs/agents/gotchas.md).
 */

/** Deterministic §11.1 epoch-millisecond timestamps for run/snapshot rows. */
const T0 = 1_761_000_000_000;

/**
 * The exact column contract of `snapshots` (D-036) — name, declared STRICT
 * type, required flag, and primary-key membership. §11.2's four columns
 * (account, run id, collection time, plan name) plus `run_outcome`, the
 * CHECK-bound carrier the composite success-linkage FK compares against.
 */
const EXPECTED_COLUMNS = [
  { name: 'run_id', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'account_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'collected_at', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'plan_name', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'run_outcome', type: 'TEXT', notnull: 1, pk: 0 },
] as const;

/**
 * The indexes `snapshots` carries, in name order, as `PRAGMA index_list`
 * reports them: §11.2's named account/time index (created by the migration)
 * and the autoindex of the `run_id UNIQUE` constraint — the structural
 * at-most-one-snapshot-per-run enforcement (origin 'u' = UNIQUE constraint).
 * `snapshots_account_run_time` is the parent key task 084's `metric_values`
 * migration adds for its denormalization-pinning composite FK, and
 * `snapshots_account_run` the one task 085's `quota_events` migration adds
 * for its account-pinning composite FK (D-036's precedent for a later
 * migration's parent key).
 */
const EXPECTED_INDEXES = [
  { name: 'snapshots_account_run', unique: 1, origin: 'c' },
  { name: 'snapshots_account_run_time', unique: 1, origin: 'c' },
  { name: 'snapshots_account_time', unique: 0, origin: 'c' },
  { name: 'sqlite_autoindex_snapshots_1', unique: 1, origin: 'u' },
] as const;

/** One `snapshots` row exactly as INSERTed — every field explicit. */
interface SnapshotRow {
  readonly runId: number | null;
  readonly accountId: string | null;
  readonly collectedAt: number | null;
  readonly planName: string | null;
  readonly runOutcome: string | null;
}

/** A snapshot of a successful run — the base every overriding test spreads. */
function successfulSnapshot(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    runId: 1,
    accountId: 'work',
    collectedAt: T0 + 1_500,
    planName: null,
    runOutcome: 'success',
    ...overrides,
  };
}

/** Raw INSERT accepting anything the STRICT columns must reject. */
function insertRawSnapshotValues(
  database: DatabaseSync,
  ...values: Array<string | number | Uint8Array | null>
): void {
  database
    .prepare(
      `INSERT INTO snapshots (run_id, account_id, collected_at, plan_name, run_outcome)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(...values);
}

/** Inserts one typed snapshot row. */
function insertSnapshot(database: DatabaseSync, row: SnapshotRow): void {
  insertRawSnapshotValues(
    database,
    row.runId,
    row.accountId,
    row.collectedAt,
    row.planName,
    row.runOutcome,
  );
}

/** Inserts an account the helpers' `work` default refers to. */
function insertAccount(database: DatabaseSync, id: string): void {
  database
    .prepare(
      `INSERT INTO accounts (id, provider_id, label, plan_name, status, created_at, archived_at)
       VALUES (?, 'zai-coding-plan', 'Work account', NULL, 'active', ?, NULL)`,
    )
    .run(id, T0);
}

/** The run outcomes a collection cycle may record (§11.2's enum). */
type RunOutcome =
  | 'success'
  | 'auth_error'
  | 'rate_limited'
  | 'network_error'
  | 'timeout'
  | 'server_error'
  | 'parse_error';

/**
 * Inserts one `collection_runs` row and answers its auto-assigned id — the
 * `run_id` snapshots key on. Minimal but valid: §7.1's default interval, one
 * attempt, and the §7.2 evidence the given outcome produces.
 */
function insertRun(database: DatabaseSync, accountId: string, outcome: RunOutcome): number {
  const result = database
    .prepare(
      `INSERT INTO collection_runs
         (account_id, started_at, ended_at, interval_seconds, outcome, http_status,
          error_message, attempts, retry_after_seconds)
       VALUES (?, ?, ?, 300, ?, ?, NULL, 1, NULL)`,
    )
    .run(accountId, T0, T0 + 1_200, outcome, outcome === 'success' ? 200 : null) as {
    lastInsertRowid: number | bigint;
  };
  return Number(result.lastInsertRowid);
}

/**
 * A migrated database ready for snapshot inserts: full canonical set applied,
 * the §11.1 foreign-keys setting switched on (079's connection applies it in
 * production; raw handles default to off), and the `work` account present
 * with one successful run (id 1) for the base helper's defaults.
 */
async function openSnapshotsDatabase(dbPath: string): Promise<DatabaseSync> {
  const database = new DatabaseSync(dbPath);
  await createMigrationRunner({
    database,
    clock: createFixedClock(T0),
    migrations: MIGRATIONS,
  }).up();
  database.exec('PRAGMA foreign_keys = ON');
  insertAccount(database, 'work');
  insertRun(database, 'work', 'success');
  return database;
}

/** One stored `snapshots` row, in SELECT * column order. */
interface StoredSnapshot {
  readonly run_id: number;
  readonly account_id: string;
  readonly collected_at: number;
  readonly plan_name: string | null;
  readonly run_outcome: string;
}

/** All `snapshots` rows, ordered for deterministic assertions. */
function allSnapshots(database: DatabaseSync): StoredSnapshot[] {
  return database
    .prepare('SELECT * FROM snapshots ORDER BY run_id ASC')
    .all() as unknown as StoredSnapshot[];
}

/** The `EXPLAIN QUERY PLAN` details for a statement, joined for matching. */
function queryPlan(database: DatabaseSync, sql: string, ...params: Array<string | number>): string {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join(' | ');
}

describe('snapshots table (task 083, spec §11.2, decision D-036)', () => {
  it('migrates a schema-2 database forward to up-to-date version 3', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('snapshots-forward.sqlite');

      // §11.4's forward test from the previous supported schema: a database
      // at schema 2 — migrated by the task-082 canonical set (0001–0002);
      // every later migration is excluded, or 0004 would run without the
      // snapshots table 0003 creates.
      const schemaTwoSet = MIGRATIONS.filter(
        (migration) =>
          migration.name !== '0003-snapshots' &&
          migration.name !== '0004-metric-values' &&
          migration.name !== '0005-quota-events' &&
          migration.name !== '0006-raw-responses',
      );
      const db = new DatabaseSync(dbPath);
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: schemaTwoSet,
      }).up();
      expect(schemaVersionStatus(db, MIGRATIONS)).toEqual({
        supportedVersion: 6,
        appliedVersion: 2,
        relation: 'behind',
        newerThanSupported: [],
      });

      // The canonical set, grown by tasks 083–086, completes it: the four
      // newer migrations apply in order.
      const applied = await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0 + 1),
        migrations: MIGRATIONS,
      }).up();
      expect(applied).toEqual([
        '0003-snapshots',
        '0004-metric-values',
        '0005-quota-events',
        '0006-raw-responses',
      ]);
      expect(schemaVersionStatus(db, MIGRATIONS)).toEqual({
        supportedVersion: 6,
        appliedVersion: 6,
        relation: 'up-to-date',
        newerThanSupported: [],
      });
      db.close();

      // Journal proven through an independent connection: all six entries
      // with their own §11.1 epoch-ms timestamps.
      const reader = new DatabaseSync(dbPath);
      const journal = reader
        .prepare(`SELECT name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY name ASC`)
        .all() as Array<{ name: string; applied_at: number }>;
      expect(journal).toEqual([
        { name: '0001-accounts', applied_at: T0 },
        { name: '0002-collection-runs', applied_at: T0 },
        { name: '0003-snapshots', applied_at: T0 + 1 },
        { name: '0004-metric-values', applied_at: T0 + 1 },
        { name: '0005-quota-events', applied_at: T0 + 1 },
        { name: '0006-raw-responses', applied_at: T0 + 1 },
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

  it('pins the exact column set: STRICT types, no defaults, the spec-named index, the unique run key', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('snapshots-columns.sqlite');
      const db = await openSnapshotsDatabase(dbPath);
      db.close();

      const reader = new DatabaseSync(dbPath);
      const info = reader.prepare('PRAGMA table_info(snapshots)').all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      // §11.2's column list plus the D-036 carrier, exactly: names, declared
      // types (STRICT makes them per-value), and required columns.
      expect(info.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual(
        EXPECTED_COLUMNS,
      );

      // No SQL-side defaults: the collection timestamp comes from the
      // injected clock (D-021) and the run id from the referenced run —
      // never a database time function or an auto-assigned rowid.
      expect(info.map((column) => column.dflt_value)).toEqual(
        Array<string | null>(info.length).fill(null),
      );

      // §11.2 "strict tables where feasible": the declaration carries STRICT
      // (the per-value enforcement is pinned by the test below).
      const created = reader
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'")
        .get() as { sql: string };
      expect(created.sql).toMatch(/\)\s*STRICT$/);

      // §11.2's named index for this table (account/time, plain) plus the
      // UNIQUE autoindex — the structural one-snapshot-per-run key.
      // `index_list` reports reverse-creation order, so sort for the pin.
      const indexes = reader.prepare('PRAGMA index_list(snapshots)').all() as Array<{
        name: string;
        unique: number;
        origin: string;
      }>;
      const named = [...indexes]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(({ name, unique, origin }) => ({ name, unique, origin }));
      expect(named).toEqual(EXPECTED_INDEXES);

      // The parent key this migration adds to collection_runs for the
      // composite FK — unique, and one more entry than task 082 left.
      const parentIndexes = reader.prepare('PRAGMA index_list(collection_runs)').all() as Array<{
        name: string;
        unique: number;
        origin: string;
      }>;
      const parentNamed = parentIndexes.map(({ name, unique, origin }) => ({
        name,
        unique,
        origin,
      }));
      expect(parentNamed).toContainEqual({
        name: 'collection_runs_account_id_outcome',
        unique: 1,
        origin: 'c',
      });
      reader.close();
    });
  });

  it('stores one snapshot per successful run with collection time and plan', async () => {
    await withTempDir(async (dir) => {
      const db = await openSnapshotsDatabase(dir.sqlitePath('snapshots-happy.sqlite'));

      // §8.4's header shape: collection time, optional plan name, run id.
      insertSnapshot(db, successfulSnapshot({ planName: 'Lite 2026' }));
      const secondRun = insertRun(db, 'work', 'success');
      insertSnapshot(
        db,
        successfulSnapshot({ runId: secondRun, collectedAt: T0 + 300_000, planName: null }),
      );

      // Another account's successful run gets its own snapshot.
      insertAccount(db, 'personal');
      const personalRun = insertRun(db, 'personal', 'success');
      insertSnapshot(db, successfulSnapshot({ runId: personalRun, accountId: 'personal' }));

      expect(allSnapshots(db)).toEqual([
        {
          run_id: 1,
          account_id: 'work',
          collected_at: T0 + 1_500,
          plan_name: 'Lite 2026',
          run_outcome: 'success',
        },
        {
          run_id: secondRun,
          account_id: 'work',
          collected_at: T0 + 300_000,
          plan_name: null,
          run_outcome: 'success',
        },
        {
          run_id: personalRun,
          account_id: 'personal',
          collected_at: T0 + 1_500,
          plan_name: null,
          run_outcome: 'success',
        },
      ]);
      db.close();
    });
  });

  it('allows at most one snapshot per run and rejects an invented run id', async () => {
    await withTempDir(async (dir) => {
      const db = await openSnapshotsDatabase(dir.sqlitePath('snapshots-unique-run.sqlite'));

      insertSnapshot(db, successfulSnapshot({ planName: 'first' }));

      // The structural one-snapshot-per-run guarantee: a second row for the
      // same run — whatever its other fields — cannot exist. Since task
      // 085's `snapshots_account_run` parent key (D-046) is checked before
      // the `run_id` autoindex, the reported constraint is the two-column
      // one; either form proves the duplicate is unrepresentable.
      expect(() =>
        insertSnapshot(db, successfulSnapshot({ collectedAt: T0 + 600_000, planName: 'second' })),
      ).toThrow(/UNIQUE constraint failed: snapshots\.(account_id, snapshots\.run_id|run_id)/);

      // NULL run_id is rejected, not auto-assigned: on the pinned runtime a
      // NOT NULL *rowid alias* would silently invent a fresh id and attach
      // the snapshot to an arbitrary run — the quirk that decided the plain
      // UNIQUE column over `INTEGER PRIMARY KEY` (D-036).
      expect(() => insertSnapshot(db, successfulSnapshot({ runId: null }))).toThrow(
        /NOT NULL constraint failed: snapshots.run_id/,
      );

      // The rejected writes left the original row untouched.
      expect(allSnapshots(db).map((row) => row.plan_name)).toEqual(['first']);
      db.close();
    });
  });

  it('links each snapshot to a successful run of the same account', async () => {
    await withTempDir(async (dir) => {
      const db = await openSnapshotsDatabase(dir.sqlitePath('snapshots-fk.sqlite'));

      // The carrier is CHECK-bound: only 'success' may ever be stored —
      // the composite FK's comparison term.
      expect(() => insertSnapshot(db, successfulSnapshot({ runOutcome: 'network_error' }))).toThrow(
        /CHECK constraint failed: snapshots_success_only/,
      );

      // A failed run never receives a snapshot, even when the child claims
      // success — §7.2's failure rows belong to collection_runs alone.
      const failedRun = insertRun(db, 'work', 'network_error');
      expect(() => insertSnapshot(db, successfulSnapshot({ runId: failedRun }))).toThrow(
        /FOREIGN KEY constraint failed/,
      );

      // A run id nothing recorded.
      expect(() => insertSnapshot(db, successfulSnapshot({ runId: 999 }))).toThrow(
        /FOREIGN KEY constraint failed/,
      );

      // A snapshot may not claim another account for a run: the composite
      // FK matches (account, run, outcome) as one key.
      insertAccount(db, 'other');
      const otherRun = insertRun(db, 'other', 'success');
      expect(() =>
        insertSnapshot(db, successfulSnapshot({ runId: otherRun, accountId: 'work' })),
      ).toThrow(/FOREIGN KEY constraint failed/);

      // The mismatched writes stored nothing; the honest ones (below) pass.
      expect(allSnapshots(db)).toEqual([]);
      insertSnapshot(db, successfulSnapshot());
      insertSnapshot(db, successfulSnapshot({ runId: otherRun, accountId: 'other' }));
      expect(allSnapshots(db).map((row) => row.account_id)).toEqual(['work', 'other']);
      db.close();
    });
  });

  it("freezes a referenced run's outcome and account against post-hoc UPDATEs", async () => {
    await withTempDir(async (dir) => {
      const db = await openSnapshotsDatabase(dir.sqlitePath('snapshots-parent-freeze.sqlite'));
      const runId = insertRun(db, 'work', 'success');
      insertSnapshot(db, successfulSnapshot({ runId }));
      // The re-attribution target must exist: with a real 'other' account
      // the plain accounts FK is satisfied, so the rejection below is the
      // composite FK's — the snapshot's reference, not the account's.
      insertAccount(db, 'other');

      // Rewriting the run's outcome or account under an existing snapshot
      // would orphan the composite FK — the parent-side default (NO ACTION
      // on UPDATE) rejects it: recorded history stays interpretable.
      expect(() =>
        db.prepare('UPDATE collection_runs SET outcome = ? WHERE id = ?').run('parse_error', runId),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(() =>
        db.prepare('UPDATE collection_runs SET account_id = ? WHERE id = ?').run('other', runId),
      ).toThrow(/FOREIGN KEY constraint failed/);

      // Unrelated evidence columns of a referenced run stay writable.
      db.prepare('UPDATE collection_runs SET http_status = ? WHERE id = ?').run(200, runId);

      // And runs without snapshots are unaffected by the same updates —
      // the freeze is the snapshot's doing, not a blanket UPDATE ban.
      const freeRun = insertRun(db, 'work', 'server_error');
      db.prepare('UPDATE collection_runs SET outcome = ? WHERE id = ?').run('timeout', freeRun);
      db.prepare('UPDATE collection_runs SET account_id = ? WHERE id = ?').run('other', freeRun);
      expect(allSnapshots(db)).toHaveLength(1);
      db.close();
    });
  });

  it('rejects NULL in every required column', async () => {
    await withTempDir(async (dir) => {
      const db = await openSnapshotsDatabase(dir.sqlitePath('snapshots-required.sqlite'));

      expect(() => insertSnapshot(db, successfulSnapshot({ accountId: null }))).toThrow(
        /NOT NULL constraint failed: snapshots.account_id/,
      );
      expect(() => insertSnapshot(db, successfulSnapshot({ collectedAt: null }))).toThrow(
        /NOT NULL constraint failed: snapshots.collected_at/,
      );
      expect(() => insertSnapshot(db, successfulSnapshot({ runOutcome: null }))).toThrow(
        /NOT NULL constraint failed: snapshots.run_outcome/,
      );
      // run_id's NULL rejection is pinned in the uniqueness test together
      // with the rowid auto-assign quirk it closes.

      expect(allSnapshots(db)).toEqual([]);
      db.close();
    });
  });

  it('rejects account ids outside the D-014 charset', async () => {
    await withTempDir(async (dir) => {
      const db = await openSnapshotsDatabase(dir.sqlitePath('snapshots-bad-ids.sqlite'));

      // The same boundaries as accounts and runs (D-032/D-034): history
      // rows may only key on ids the accounts table can hold.
      const badIds = [
        '', // empty
        '-lead', // leading '-' — the first character must be alphanumeric
        'sp ace', // spaces anywhere
        `${'a'.repeat(64)}x`, // 65 characters — one past the bound
        'a\0b', // embedded NUL: GLOB/length stop at NUL, the stored bytes do not
      ];
      for (const accountId of badIds) {
        expect(
          () => insertSnapshot(db, successfulSnapshot({ accountId })),
          `id '${accountId}'`,
        ).toThrow(/CHECK constraint failed: snapshots_account_charset/);
      }

      // A number bound for the TEXT column is affinity-rendered with a
      // decimal point ('123.0') before the CHECK runs.
      expect(() => insertRawSnapshotValues(db, 1, 123, T0, null, 'success')).toThrow(
        /CHECK constraint failed: snapshots_account_charset/,
      );

      expect(allSnapshots(db)).toEqual([]);
      db.close();
    });
  });

  it('keeps plan_name absent-or-non-blank (§8.4 shape)', async () => {
    await withTempDir(async (dir) => {
      const db = await openSnapshotsDatabase(dir.sqlitePath('snapshots-plan.sqlite'));

      // A blank plan is not a third state (the accounts_plan_nonempty
      // precedent) — §8.4's planName is absent or non-blank.
      expect(() => insertSnapshot(db, successfulSnapshot({ planName: '' }))).toThrow(
        /CHECK constraint failed: snapshots_plan_nonempty/,
      );

      const secondRun = insertRun(db, 'work', 'success');
      insertSnapshot(db, successfulSnapshot()); // absent
      insertSnapshot(db, successfulSnapshot({ runId: secondRun, planName: 'Pro 2026' })); // present
      expect(allSnapshots(db).map((row) => row.plan_name)).toEqual([null, 'Pro 2026']);
      db.close();
    });
  });

  it('enforces STRICT runtime types', async () => {
    await withTempDir(async (dir) => {
      const db = await openSnapshotsDatabase(dir.sqlitePath('snapshots-strict.sqlite'));

      // §11.2 "strict tables where feasible", per value: a blob cannot
      // enter the TEXT account id and text cannot enter the INTEGER run id.
      expect(() =>
        insertRawSnapshotValues(db, 1, new Uint8Array([0x61]), T0, null, 'success'),
      ).toThrow(/cannot store BLOB value in TEXT column snapshots.account_id/);
      expect(() => insertRawSnapshotValues(db, 'one', 'work', T0, null, 'success')).toThrow(
        /cannot store TEXT value in INTEGER column snapshots.run_id/,
      );

      expect(allSnapshots(db)).toEqual([]);
      db.close();
    });
  });

  it('cascades: run deletion removes its snapshot, account deletion removes both', async () => {
    await withTempDir(async (dir) => {
      const db = await openSnapshotsDatabase(dir.sqlitePath('snapshots-cascade.sqlite'));
      insertAccount(db, 'other');
      const otherRun = insertRun(db, 'other', 'success');
      insertSnapshot(db, successfulSnapshot({ planName: 'work plan' }));
      insertSnapshot(db, successfulSnapshot({ runId: otherRun, accountId: 'other' }));

      // §11.2 cascading deletion, run side: the snapshot dies with its run.
      db.prepare('DELETE FROM collection_runs WHERE id = ?').run(1);
      expect(allSnapshots(db).map((row) => row.account_id)).toEqual(['other']);

      // Account side: both the direct snapshot FK and the path through the
      // account's runs remove the account's snapshots; the other account's
      // history stays. The account re-collects first so the purge has rows
      // to remove on both paths.
      const workRun = insertRun(db, 'work', 'success');
      insertSnapshot(db, successfulSnapshot({ runId: workRun, planName: 're-created' }));
      db.prepare("DELETE FROM accounts WHERE id = 'work'").run();
      expect(allSnapshots(db).map((row) => row.account_id)).toEqual(['other']);
      const remainingRuns = db
        .prepare('SELECT account_id FROM collection_runs ORDER BY id ASC')
        .all() as Array<{ account_id: string }>;
      expect(remainingRuns.map((row) => row.account_id)).toEqual(['other']);
      db.close();
    });
  });

  it('serves the §11.2 account/time queries from the named index', async () => {
    await withTempDir(async (dir) => {
      const db = await openSnapshotsDatabase(dir.sqlitePath('snapshots-indexes.sqlite'));
      insertAccount(db, 'other');
      const runs: Array<[string, number]> = [
        ['work', T0 + 1_500],
        ['work', T0 + 301_500],
        ['work', T0 + 601_500],
        ['other', T0 + 1_500],
      ];
      const runIds = runs.map(([accountId, collectedAt], index) => {
        const runId = index === 0 ? 1 : insertRun(db, accountId, 'success');
        insertSnapshot(
          db,
          successfulSnapshot({ runId, accountId, collectedAt, planName: `plan-${index}` }),
        );
        return runId;
      });

      // §13's latest-successful-snapshot shape (GET /api/quota): an
      // account's snapshots in collection-time order, newest first —
      // searched and ordered through the account/time index, no temp sort.
      const latest = queryPlan(
        db,
        'SELECT run_id FROM snapshots WHERE account_id = ? ORDER BY collected_at DESC',
        'work',
      );
      // `SELECT run_id` reads only index columns (the rowid rides every
      // index entry), so the plan reports the covering variant.
      expect(latest).toMatch(/USING (COVERING )?INDEX snapshots_account_time/);
      expect(latest).not.toContain('TEMP B-TREE');

      // The history-window shape (§13 GET /api/history's from/to): an
      // account's snapshots within a time range — an index range scan.
      const window = queryPlan(
        db,
        'SELECT run_id FROM snapshots WHERE account_id = ? AND collected_at >= ? AND collected_at < ?',
        'work',
        T0 + 300_000,
        T0 + 600_000,
      );
      expect(window).toMatch(/USING (COVERING )?INDEX snapshots_account_time/);

      // And the queries return the right rows — the index serves §11.3's
      // "history queries must be indexed and should remain usable at that
      // scale" (≈52k snapshots per account per 180 days).
      const newest = db
        .prepare(
          'SELECT run_id FROM snapshots WHERE account_id = ? ORDER BY collected_at DESC LIMIT 1',
        )
        .all('work') as Array<{ run_id: number }>;
      expect(newest).toEqual([{ run_id: runIds[2] }]);
      const inWindow = db
        .prepare(
          'SELECT run_id FROM snapshots WHERE account_id = ? AND collected_at >= ? AND collected_at < ? ORDER BY collected_at ASC',
        )
        .all('work', T0 + 300_000, T0 + 600_000) as Array<{ run_id: number }>;
      expect(inWindow).toEqual([{ run_id: runIds[1] }]);
      db.close();
    });
  });
});
