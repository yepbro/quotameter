import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  createMigrationRunner,
  createMigrationStorage,
  MIGRATIONS_TABLE,
  type Migration,
} from '../../src/storage/migrations';
import { createFixedClock } from '../../src/util/clock';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 078's verification (spec §3, §11.4): Umzug drives forward migrations
 * applied through the built-in `node:sqlite` driver, records every applied
 * migration in the journal table inside the database, respects the recorded
 * state on re-runs, and never leaves a half-applied migration behind. The
 * `node:sqlite` ExperimentalWarning is expected here, as in every storage
 * test (docs/agents/gotchas.md).
 *
 * Every database is a disposable file under a per-test temporary directory
 * (test/helpers/isolation.ts). State written by the runner is always proven
 * through a second, independent connection — the journal and schema must be
 * visible beyond the runner's own database handle.
 */

/** Deterministic `applied_at` for journal assertions. */
const T0 = 1_761_000_000_000;

/** Journal rows read through an independent connection, in name order. */
function journalRows(dbPath: string): Array<{ name: string; applied_at: number }> {
  const reader = new DatabaseSync(dbPath);
  try {
    return reader
      .prepare(`SELECT name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY name ASC`)
      .all() as Array<{ name: string; applied_at: number }>;
  } finally {
    reader.close();
  }
}

/** User table names read through an independent connection. */
function tableNames(dbPath: string): string[] {
  const reader = new DatabaseSync(dbPath);
  try {
    const rows = reader
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC")
      .all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  } finally {
    reader.close();
  }
}

/** A probe migration creating a disposable table — never a §11.2 table. */
function probeMigration(name: string): Migration {
  return {
    name,
    up: ({ database }) => {
      // Quoted identifier: migration names are digits-prefixed, which SQL
      // would not accept as a bare table name.
      const table = name.replace(/-/g, '_');
      database.exec(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY) STRICT;`);
    },
  };
}

describe('migration harness (Umzug over node:sqlite)', () => {
  it('applies pending migrations in name order and records them in the journal', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('migrations.sqlite');
      const db = new DatabaseSync(dbPath);
      const ranInOrder: string[] = [];
      const runner = createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        // Injected out of name order on purpose: the harness must apply by
        // name, not by list position.
        migrations: [
          {
            ...probeMigration('0002-later-probe'),
            up: (context) => {
              ranInOrder.push('0002-later-probe');
              return probeMigration('0002-later-probe').up(context);
            },
          },
          {
            ...probeMigration('0001-early-probe'),
            up: (context) => {
              ranInOrder.push('0001-early-probe');
              return probeMigration('0001-early-probe').up(context);
            },
          },
        ],
      });

      const applied = await runner.up();
      db.close();

      expect(applied).toEqual(['0001-early-probe', '0002-later-probe']);
      expect(ranInOrder).toEqual(['0001-early-probe', '0002-later-probe']);
      // §11.4 bookkeeping: one journal entry per applied migration, timestamp
      // integer UTC epoch milliseconds (§11.1), proven from outside.
      expect(journalRows(dbPath)).toEqual([
        { name: '0001-early-probe', applied_at: T0 },
        { name: '0002-later-probe', applied_at: T0 },
      ]);
      // The migrations' DDL is committed and visible independently.
      const tables = tableNames(dbPath);
      expect(tables).toContain('0001_early_probe');
      expect(tables).toContain('0002_later_probe');
    });
  });

  it('re-running is a no-op: recorded state is respected', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('no-op.sqlite');
      const db = new DatabaseSync(dbPath);
      const clock = createFixedClock(T0);
      const runner = createMigrationRunner({
        database: db,
        clock,
        migrations: [probeMigration('0001-probe'), probeMigration('0002-probe')],
      });

      await runner.up();
      clock.advance(60_000);
      const appliedAgain = await runner.up();
      db.close();

      expect(appliedAgain).toEqual([]);
      // No re-recording: the journal still holds the original entries.
      expect(journalRows(dbPath)).toEqual([
        { name: '0001-probe', applied_at: T0 },
        { name: '0002-probe', applied_at: T0 },
      ]);
    });
  });

  it('skips migrations the journal already records, applies the rest', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('preseeded.sqlite');
      const db = new DatabaseSync(dbPath);
      const clock = createFixedClock(T0);
      const runner = createMigrationRunner({
        database: db,
        clock,
        migrations: [probeMigration('0001-recorded'), probeMigration('0002-pending')],
      });
      // A journal entry from an earlier run of the same migration.
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`).run(
        '0001-recorded',
        T0 - 5_000,
      );

      const applied = await runner.up();
      db.close();

      expect(applied).toEqual(['0002-pending']);
      expect(journalRows(dbPath)).toEqual([
        { name: '0001-recorded', applied_at: T0 - 5_000 },
        { name: '0002-pending', applied_at: T0 },
      ]);
    });
  });

  it('reports pending and applied state from the journal', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('state.sqlite');
      const db = new DatabaseSync(dbPath);
      const runner = createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: [probeMigration('0001-probe'), probeMigration('0002-probe')],
      });

      expect(await runner.pending()).toEqual(['0001-probe', '0002-probe']);
      expect(await runner.executed()).toEqual([]);

      await runner.up();

      expect(await runner.pending()).toEqual([]);
      expect(await runner.executed()).toEqual(['0001-probe', '0002-probe']);

      // A journal entry for a migration this runner does not know (a newer
      // schema, §11.4) is not reported as executed — it is absent from the
      // injected list, and interpreting raw journal state is task 092's.
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`).run(
        '9999-unknown',
        T0,
      );

      expect(await runner.executed()).toEqual(['0001-probe', '0002-probe']);
      expect(await runner.pending()).toEqual([]);
      db.close();
    });
  });

  it('prepares a brand-new database: journal table at construction, all pending', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('fresh.sqlite');
      const db = new DatabaseSync(dbPath);
      // No clock injected: this case also covers the default system-clock
      // seam, so applied_at is only known to be a positive epoch value.
      const runner = createMigrationRunner({
        database: db,
        migrations: [probeMigration('0001-probe')],
      });

      // The journal table name is part of the on-disk contract (D-027);
      // pin it so a rename cannot pass silently.
      expect(MIGRATIONS_TABLE).toBe('schema_migrations');
      expect(tableNames(dbPath)).toContain(MIGRATIONS_TABLE);
      expect(await runner.pending()).toEqual(['0001-probe']);
      expect(await runner.executed()).toEqual([]);

      expect(await runner.up()).toEqual(['0001-probe']);
      db.close();

      const [entry] = journalRows(dbPath);
      expect(entry?.name).toBe('0001-probe');
      expect(Number.isInteger(entry?.applied_at)).toBe(true);
      expect(entry?.applied_at ?? 0).toBeGreaterThan(0);
    });
  });

  it('rolls a failed migration back and leaves it pending for the next run', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('failing.sqlite');
      const db = new DatabaseSync(dbPath);
      const clock = createFixedClock(T0);
      const broken: Migration = {
        name: '0001-broken',
        up: ({ database }) => {
          // Partial DDL before failing: exactly the state a crash mid-write
          // would leave behind.
          database.exec('CREATE TABLE broken_probe (id INTEGER PRIMARY KEY) STRICT;');
          throw new Error('simulated failure after partial DDL');
        },
      };
      const runner = createMigrationRunner({
        database: db,
        clock,
        migrations: [broken, probeMigration('0002-never-reached')],
      });

      // Umzug wraps the failure in its MigrationError naming the migration.
      await expect(runner.up()).rejects.toThrow(
        /Migration 0001-broken \(up\) failed: Original error: simulated failure/,
      );
      db.close();

      // The whole migration is gone: no partial DDL, no journal entry, and
      // later migrations were never attempted.
      expect(tableNames(dbPath)).not.toContain('broken_probe');
      expect(journalRows(dbPath)).toEqual([]);

      // Still pending — and a corrected migration of the same name applies.
      const db2 = new DatabaseSync(dbPath);
      const fixed = createMigrationRunner({
        database: db2,
        clock,
        migrations: [probeMigration('0001-broken'), probeMigration('0002-never-reached')],
      });
      expect(await fixed.pending()).toEqual(['0001-broken', '0002-never-reached']);
      expect(await fixed.up()).toEqual(['0001-broken', '0002-never-reached']);
      db2.close();
      expect(journalRows(dbPath)).toEqual([
        { name: '0001-broken', applied_at: T0 },
        { name: '0002-never-reached', applied_at: T0 },
      ]);
    });
  });

  it('commits each migration separately: a later failure keeps earlier ones applied', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('granularity.sqlite');
      const db = new DatabaseSync(dbPath);
      const clock = createFixedClock(T0);
      const failingSecond: Migration = {
        name: '0002-explodes',
        up: ({ database }) => {
          database.exec('CREATE TABLE explodes_probe (id INTEGER PRIMARY KEY) STRICT;');
          throw new Error('simulated failure in the second migration');
        },
      };
      const runner = createMigrationRunner({
        database: db,
        clock,
        migrations: [probeMigration('0001-first'), failingSecond],
      });

      await expect(runner.up()).rejects.toThrow(/Migration 0002-explodes \(up\) failed/);
      db.close();

      // One transaction per migration, not one for the whole run: 0001 stayed
      // applied and recorded, 0002 vanished whole.
      expect(tableNames(dbPath)).toContain('0001_first');
      expect(tableNames(dbPath)).not.toContain('explodes_probe');
      expect(journalRows(dbPath)).toEqual([{ name: '0001-first', applied_at: T0 }]);

      // A corrected re-run applies only the second migration.
      const db2 = new DatabaseSync(dbPath);
      const fixed = createMigrationRunner({
        database: db2,
        clock,
        migrations: [probeMigration('0001-first'), probeMigration('0002-explodes')],
      });
      expect(await fixed.pending()).toEqual(['0002-explodes']);
      expect(await fixed.up()).toEqual(['0002-explodes']);
      db2.close();
      expect(journalRows(dbPath)).toEqual([
        { name: '0001-first', applied_at: T0 },
        { name: '0002-explodes', applied_at: T0 },
      ]);
    });
  });

  it('rejects a migration that manages its own transaction, staying pending', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('nested-begin.sqlite');
      const db = new DatabaseSync(dbPath);
      const nested: Migration = {
        name: '0001-opens-own-transaction',
        up: ({ database }) => {
          // The runner's transaction already wraps the migration; a nested
          // BEGIN must fail loudly instead of nesting silently.
          database.exec('BEGIN');
        },
      };
      const runner = createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: [nested],
      });

      await expect(runner.up()).rejects.toThrow(
        /Migration 0001-opens-own-transaction \(up\) failed: Original error: cannot start a transaction within a transaction/,
      );
      expect(await runner.pending()).toEqual(['0001-opens-own-transaction']);
      db.close();
      expect(journalRows(dbPath)).toEqual([]);
    });
  });

  it('rolls the migration back when the journal write itself fails', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('journal-failure.sqlite');
      const db = new DatabaseSync(dbPath);
      const sabotaging: Migration = {
        name: '0001-sabotaged',
        up: ({ database }) => {
          database.exec('CREATE TABLE sabotaged_probe (id INTEGER PRIMARY KEY) STRICT;');
          // Occupy the journal row the runner is about to write, so the
          // journal insert fails after the DDL succeeded.
          database
            .prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`)
            .run('0001-sabotaged', 1);
        },
      };
      const runner = createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: [sabotaging],
      });

      await expect(runner.up()).rejects.toThrow(/UNIQUE constraint failed/);
      db.close();

      // Atomic apply+record from the record side: the failed insert rolls
      // the migration's DDL *and* its own journal row back — the database is
      // exactly as it was before the migration started.
      expect(tableNames(dbPath)).not.toContain('sabotaged_probe');
      expect(journalRows(dbPath)).toEqual([]);
    });
  });

  it('rejects invalid migration lists at construction, before touching the database', () => {
    // Validation-only cases: an in-memory database is the most disposable
    // one possible, and construction must fail before any write anyway.
    const cases: Array<{ migrations: ReadonlyArray<Migration>; message: RegExp }> = [
      { migrations: [{ ...probeMigration('0001-x'), name: '  ' }], message: /non-blank/ },
      {
        migrations: [{ ...probeMigration('0001-x'), name: 123 as unknown as string }],
        message: /non-blank strings \(got '123'\)/,
      },
      {
        migrations: [probeMigration('0001-x'), probeMigration('0001-x')],
        message: /duplicate migration name '0001-x'/,
      },
      {
        migrations: [{ name: '0001-x', up: undefined as unknown as Migration['up'] }],
        message: /no up\(\) function/,
      },
    ];
    for (const { migrations, message } of cases) {
      const database = new DatabaseSync(':memory:');
      expect(() => createMigrationRunner({ database, migrations })).toThrow(message);
      // The journal table was never created: validation precedes all writes.
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      expect(tables).toEqual([]);
      database.close();
    }
  });
});

describe('migration storage adapter (Umzug storage contract)', () => {
  it('records, lists, and forgets journal entries', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('adapter.sqlite');
      const db = new DatabaseSync(dbPath);
      const storage = createMigrationStorage({ database: db, clock: createFixedClock(T0) });
      const params = { name: '0001-direct', context: undefined };

      expect(await storage.executed({ context: undefined })).toEqual([]);
      await storage.logMigration(params);
      expect(await storage.executed({ context: undefined })).toEqual(['0001-direct']);
      expect(journalRows(dbPath)).toEqual([{ name: '0001-direct', applied_at: T0 }]);
      await storage.unlogMigration(params);
      expect(await storage.executed({ context: undefined })).toEqual([]);
      db.close();
    });
  });
});
