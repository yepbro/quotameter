import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  appliedMigrations,
  createMigrationRunner,
  createMigrationStorage,
  migrationVersion,
  MIGRATIONS,
  MIGRATIONS_TABLE,
  type Migration,
  schemaVersionStatus,
  supportedSchemaVersion,
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
 *
 * The last describe block covers task 080's metadata layer (D-031): the
 * done-condition — applied migration versions persisted and queryable — plus
 * versioned names, the strictly-increasing set rule, the raw journal read,
 * and the §11.4 schema-version status task 092 builds its refusal on.
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

describe('migration metadata and version checks (task 080, D-031)', () => {
  it('parses versioned names and rejects malformed ones', () => {
    expect(migrationVersion('0001-init')).toBe(1);
    expect(migrationVersion('0012-add-quota-events')).toBe(12);
    expect(migrationVersion('20261030-date-style')).toBe(20_261_030);
    for (const malformed of [
      '', // blank
      'init', // no version prefix
      '0001', // no description
      '0001-', // blank description
      ' 0001-init', // prefix does not start the name
      '0000000009-nine-digits', // beyond the 8-digit cap (exact Number parsing)
      'x-0001', // prefix is not digits
    ]) {
      expect(() => migrationVersion(malformed)).toThrow(
        /must be <version>-<description> with a 1-8 digit version prefix/,
      );
    }
    // Version 0 is reserved for "nothing applied yet" — the empty journal.
    for (const zeroed of ['0-init', '00000000-init']) {
      expect(() => migrationVersion(zeroed)).toThrow(/has version 0; versions start at 1/);
    }
  });

  it('rejects sets whose application order is not strictly version-increasing', () => {
    const cases: Array<{ migrations: ReadonlyArray<Migration>; message: RegExp }> = [
      // Name order puts '10-later' first ('1' sorts before '9'): the set
      // applies 10 then 9, and the rule names the non-increasing migration.
      {
        migrations: [probeMigration('9-earlier'), probeMigration('10-later')],
        message: /strictly increase.*'9-earlier' \(version 9\) does not follow version 10/,
      },
      // Distinct names may not share a version.
      {
        migrations: [probeMigration('0001-a'), probeMigration('0001-b')],
        message: /strictly increase.*'0001-b' \(version 1\)/,
      },
      // Unversioned names never reach the set rules.
      { migrations: [probeMigration('init')], message: /must be <version>-<description>/ },
    ];
    for (const { migrations, message } of cases) {
      const database = new DatabaseSync(':memory:');
      expect(() => createMigrationRunner({ database, migrations })).toThrow(message);
      // Every version consumer validates the same set the same way.
      expect(() => schemaVersionStatus(database, migrations)).toThrow(message);
      database.close();
    }
  });

  it('persists applied versions and exposes them queryable beyond the runner', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('metadata.sqlite');
      const db = new DatabaseSync(dbPath);
      const runner = createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        // Authored out of order: application order is name (version) order.
        migrations: [probeMigration('0002-accounts'), probeMigration('0001-init')],
      });

      expect(await runner.up()).toEqual(['0001-init', '0002-accounts']);
      db.close();

      // The done-condition: applied versions persisted and queryable, read
      // through an independent connection, with §11.1 epoch-ms timestamps.
      const reader = new DatabaseSync(dbPath);
      const applied = appliedMigrations(reader);
      reader.close();
      expect(applied).toEqual([
        { name: '0001-init', appliedAt: T0 },
        { name: '0002-accounts', appliedAt: T0 },
      ]);
      for (const entry of applied) {
        expect(Number.isInteger(entry.appliedAt)).toBe(true);
      }
    });
  });

  it('reports a brand-new database against an empty migration set as up-to-date at version 0', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('fresh-metadata.sqlite');
      const db = new DatabaseSync(dbPath);

      // The empty set stays a legitimate input after task 081 grew the
      // canonical list (D-031's planned growth): version 0 — "nothing
      // applied yet" — is what an empty set supports, and a fresh database
      // is exactly at it. The canonical set itself is pinned, non-empty,
      // in test/integration/accounts.spec.ts.
      const empty: ReadonlyArray<Migration> = [];
      expect(supportedSchemaVersion(empty)).toBe(0);
      expect(appliedMigrations(db)).toEqual([]);
      expect(schemaVersionStatus(db, empty)).toEqual({
        supportedVersion: 0,
        appliedVersion: 0,
        relation: 'up-to-date',
        newerThanSupported: [],
      });
      // The query is read-only: it must not create the journal table.
      expect(tableNames(dbPath)).not.toContain(MIGRATIONS_TABLE);

      // The same fresh database is behind any non-empty set.
      expect(schemaVersionStatus(db, [probeMigration('0001-init')]).relation).toBe('behind');
      db.close();
    });
  });

  it('flips behind → up-to-date as the runner applies, including one release forward', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('interplay.sqlite');
      const db = new DatabaseSync(dbPath);
      const clock = createFixedClock(T0);
      const set = [probeMigration('0001-init'), probeMigration('0002-accounts')];
      const runner = createMigrationRunner({ database: db, clock, migrations: set });

      expect(schemaVersionStatus(db, set)).toEqual({
        supportedVersion: 2,
        appliedVersion: 0,
        relation: 'behind',
        newerThanSupported: [],
      });

      await runner.up();
      db.close();

      const reader = new DatabaseSync(dbPath);
      expect(schemaVersionStatus(reader, set)).toEqual({
        supportedVersion: 2,
        appliedVersion: 2,
        relation: 'up-to-date',
        newerThanSupported: [],
      });
      reader.close();

      // The §11.4 forward pattern each schema release must have: the next
      // release grows the set by one migration; only it is pending, and
      // applying it reaches up-to-date from the previous supported schema.
      const grown = [...set, probeMigration('0003-events')];
      const db2 = new DatabaseSync(dbPath);
      expect(schemaVersionStatus(db2, grown).relation).toBe('behind');
      expect(await createMigrationRunner({ database: db2, clock, migrations: grown }).up()).toEqual(
        ['0003-events'],
      );
      expect(schemaVersionStatus(db2, grown).relation).toBe('up-to-date');
      db2.close();
    });
  });

  it('detects a newer schema with evidence — the surface task 092 refuses on', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('newer.sqlite');
      const db = new DatabaseSync(dbPath);
      // A database migrated by a newer release of the application.
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0 - 1_000),
        migrations: [probeMigration('0001-init'), probeMigration('0009-from-the-future')],
      }).up();
      db.close();

      const olderSet = [probeMigration('0001-init')];
      const reader = new DatabaseSync(dbPath);
      expect(schemaVersionStatus(reader, olderSet)).toEqual({
        supportedVersion: 1,
        appliedVersion: 9,
        relation: 'newer',
        newerThanSupported: [{ name: '0009-from-the-future', appliedAt: T0 - 1_000 }],
      });
      reader.close();

      // Unknown journal entries within the supported range are not a newer
      // schema: versions decide, names alone do not flip the relation.
      const strayPath = dir.sqlitePath('stray.sqlite');
      const stray = new DatabaseSync(strayPath);
      await createMigrationRunner({
        database: stray,
        clock: createFixedClock(T0),
        migrations: [probeMigration('0001-init')],
      }).up();
      stray
        .prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`)
        .run('0001-renamed-legacy', T0);
      expect(schemaVersionStatus(stray, [probeMigration('0001-init')]).relation).toBe('up-to-date');
      stray.close();

      // The membership half of the same rule: equal maxima do not mean
      // up-to-date when a set migration is missing from the journal — here a
      // foreign row carries version 2 under another name, so 0002-accounts is
      // still pending work (D-031).
      const holePath = dir.sqlitePath('hole.sqlite');
      const hole = new DatabaseSync(holePath);
      await createMigrationRunner({
        database: hole,
        clock: createFixedClock(T0),
        migrations: [probeMigration('0001-init')],
      }).up();
      hole
        .prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`)
        .run('0002-renamed-legacy', T0);
      expect(
        schemaVersionStatus(hole, [probeMigration('0001-init'), probeMigration('0002-accounts')]),
      ).toEqual({
        supportedVersion: 2,
        appliedVersion: 2,
        relation: 'behind',
        newerThanSupported: [],
      });
      hole.close();
    });
  });

  it('fails fast on a journal row with a malformed name', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('malformed.sqlite');
      const db = new DatabaseSync(dbPath);
      // An empty run only creates the journal table.
      await createMigrationRunner({
        database: db,
        clock: createFixedClock(T0),
        migrations: [],
      }).up();
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`).run(
        'legacy-init',
        T0,
      );

      // A foreign or corrupt row must surface, not silently read as version 0.
      expect(() => schemaVersionStatus(db, MIGRATIONS)).toThrow(
        /'legacy-init' must be <version>-<description>/,
      );
      db.close();
    });
  });

  it('rejects journal rows with non-integer applied_at values', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('foreign.sqlite');
      const db = new DatabaseSync(dbPath);
      // A journal this application did not write: no STRICT column, and a
      // corrupt timestamp that must not flow out as a fake number.
      db.exec(`CREATE TABLE ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, applied_at TEXT)`);
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`).run(
        '0001-foreign',
        'yesterday',
      );

      expect(() => appliedMigrations(db)).toThrow(/'0001-foreign' has a non-integer applied_at/);
      db.close();
    });
  });
});
