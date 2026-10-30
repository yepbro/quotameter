import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_BACKUP_RETAINED_COUNT,
  automaticBackupsDir,
  createAutomaticBackup,
  listAutomaticBackups,
} from '../../src/storage/backups';
import {
  createMigrationRunner,
  MIGRATIONS,
  MIGRATIONS_TABLE,
  type Migration,
  schemaVersionStatus,
} from '../../src/storage/migrations';
import { NewerSchemaError, runStartupMigrations } from '../../src/storage/startup-migrations';
import { createFixedClock } from '../../src/util/clock';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 092's verification (spec §5.6, §11.4): before applying migrations a
 * backup is created with `VACUUM INTO`, only the three most recent
 * automatic backups are retained, a schema newer than the running
 * application supports refuses to run and leaves the database unchanged,
 * and a failed migration loses neither the pre-migration state nor the
 * backup of it. The `node:sqlite` ExperimentalWarning is expected here, as
 * in every storage test (docs/agents/gotchas.md).
 *
 * Conventions follow test/integration/migrations.spec.ts: disposable
 * databases under per-test temporary directories, a fixed clock for
 * deterministic names and journal timestamps, and every persisted state
 * proven through a second, independent connection — a backup proves
 * nothing until someone else can open it.
 */

/** Deterministic timestamps: backup names and journal `applied_at`. */
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

/** Table names read through an independent connection. */
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

/** The relation of one database against one migration set, read independently. */
function relationOf(dbPath: string, migrations: ReadonlyArray<Migration>): string {
  const reader = new DatabaseSync(dbPath);
  try {
    return schemaVersionStatus(reader, migrations).relation;
  } finally {
    reader.close();
  }
}

/** File names in a directory — membership/length checks only, unsorted. */
function fileNames(directory: string): string[] {
  return readdirSync(directory);
}

/**
 * Automatic backup names in retention order (oldest first, by the parsed
 * timestamp then same-instant sequence) — the ordering the naive
 * lexicographic sort cannot express (`'-'` sorts before `'.'`, which
 * would invert `backup-T` against `backup-T-1`).
 */
function automaticBackupNames(backupDir: string): string[] {
  return listAutomaticBackups(backupDir).map((backup) => backup.name);
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

describe('startup migrations: backup-then-migrate and newer-schema refusal', () => {
  it('migrates a schema-0 fresh database without a backup: nothing to protect', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('fresh.sqlite');
      const db = new DatabaseSync(dbPath);
      // A missing backup directory is an empty backup list, not an error.
      expect(listAutomaticBackups(automaticBackupsDir(dir.path))).toEqual([]);

      const result = await runStartupMigrations({
        database: db,
        dataDir: dir.path,
        migrations: MIGRATIONS,
        clock: createFixedClock(T0),
      });
      db.close();

      // The whole canonical set applies, in application order…
      expect(result.applied).toEqual(MIGRATIONS.map((migration) => migration.name));
      // …with no backup taken: the pre-migration state is "no database
      // content at all", and §5.6 guards migrations, not fresh installs.
      expect(result.backup).toBeUndefined();
      expect(existsSync(automaticBackupsDir(dir.path))).toBe(false);

      // The database reached the supported schema version.
      expect(relationOf(dbPath, MIGRATIONS)).toBe('up-to-date');
    });
  });

  it('backs up before a forward migration, and the backup carries the pre-migration state', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('forward.sqlite');
      // A database at the previous supported schema (6), holding data.
      const db = new DatabaseSync(dbPath);
      await createMigrationRunner({
        database: db,
        migrations: MIGRATIONS.slice(0, 6),
        clock: createFixedClock(T0),
      }).up();
      db.prepare(
        `INSERT INTO accounts (id, provider_id, label, status, created_at)
         VALUES ('acc-1', 'zai', 'Probe account', 'active', ${T0})`,
      ).run();

      // §11.4's forward pattern through the startup seam: only 0007 is
      // pending, and a backup precedes it.
      const result = await runStartupMigrations({
        database: db,
        dataDir: dir.path,
        migrations: MIGRATIONS,
        clock: createFixedClock(T0),
      });
      db.close();

      expect(result.applied).toEqual(['0007-sessions-meta']);
      expect(result.status.relation).toBe('behind');
      // Exactly one automatic backup, named by its timestamp.
      expect(result.backup?.backup.name).toBe(`backup-${T0}.sqlite`);
      expect(fileNames(automaticBackupsDir(dir.path))).toEqual([`backup-${T0}.sqlite`]);
      expect(result.backup?.evicted).toEqual([]);

      // Backup usability: a complete standalone image — opens
      // independently, passes integrity, and contains the pre-migration
      // schema (journal at 6, no sessions table) and the pre-migration
      // data, but not the migration that had not run yet.
      const backupPath = result.backup?.backup.path ?? '';
      expect(backupPath).not.toBe('');
      const backup = new DatabaseSync(backupPath);
      try {
        expect(backup.prepare('PRAGMA integrity_check').get()).toEqual({
          integrity_check: 'ok',
        });
        expect(backup.prepare('SELECT id FROM accounts').all()).toEqual([{ id: 'acc-1' }]);
        expect(tableNames(backupPath)).not.toContain('sessions');
      } finally {
        backup.close();
      }
      expect(journalRows(backupPath).map((row) => row.name)).not.toContain('0007-sessions-meta');

      // The live database moved forward to the full supported schema.
      expect(relationOf(dbPath, MIGRATIONS)).toBe('up-to-date');
    });
  });

  it('an up-to-date database migrates nothing and backs up nothing', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('current.sqlite');
      const db = new DatabaseSync(dbPath);
      await runStartupMigrations({
        database: db,
        dataDir: dir.path,
        migrations: MIGRATIONS,
        clock: createFixedClock(T0),
      });

      const result = await runStartupMigrations({
        database: db,
        dataDir: dir.path,
        migrations: MIGRATIONS,
        clock: createFixedClock(T0 + 60_000),
      });
      db.close();

      expect(result.status.relation).toBe('up-to-date');
      expect(result.applied).toEqual([]);
      expect(result.backup).toBeUndefined();
      // No backup was ever taken (the first run started from schema 0).
      expect(existsSync(automaticBackupsDir(dir.path))).toBe(false);
    });
  });

  it('retains exactly three automatic backups, evicting the oldest, and never touches foreign files', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('retention.sqlite');
      const db = new DatabaseSync(dbPath);
      const clock = createFixedClock(T0);
      const backupDir = automaticBackupsDir(dir.path);

      // Growing probe sets: every run after the first leaves one migration
      // pending from a protected schema, so each takes a backup — all at
      // the same fixed clock reading, exercising the same-instant name
      // disambiguation (`-1`, `-2`, …) the grammar provides for.
      const first = await runStartupMigrations({
        database: db,
        dataDir: dir.path,
        migrations: [probeMigration('0001-one')],
        clock,
      });
      // Schema-0 start: migrations apply, but no backup is taken.
      expect(first.backup).toBeUndefined();
      expect(existsSync(backupDir)).toBe(false);

      const second = await runStartupMigrations({
        database: db,
        dataDir: dir.path,
        migrations: [probeMigration('0001-one'), probeMigration('0002-two')],
        clock,
      });
      // An operator-placed file in the backup directory: outside the
      // automatic naming grammar, hence outside retention's reach.
      const foreign = join(backupDir, 'operator-copy.sqlite');
      db.prepare('VACUUM INTO ?').run(foreign);

      const third = await runStartupMigrations({
        database: db,
        dataDir: dir.path,
        migrations: [
          probeMigration('0001-one'),
          probeMigration('0002-two'),
          probeMigration('0003-three'),
        ],
        clock,
      });
      const fourth = await runStartupMigrations({
        database: db,
        dataDir: dir.path,
        migrations: [
          probeMigration('0001-one'),
          probeMigration('0002-two'),
          probeMigration('0003-three'),
          probeMigration('0004-four'),
        ],
        clock,
      });
      db.close();

      // Three same-instant backups: the plain name first, then -1, -2.
      expect(second.backup?.backup.name).toBe(`backup-${T0}.sqlite`);
      expect(third.backup?.backup.name).toBe(`backup-${T0}-1.sqlite`);
      expect(fourth.backup?.backup.name).toBe(`backup-${T0}-2.sqlite`);
      expect(fourth.backup?.evicted).toEqual([]);
      expect(automaticBackupNames(backupDir)).toEqual([
        `backup-${T0}.sqlite`,
        `backup-${T0}-1.sqlite`,
        `backup-${T0}-2.sqlite`,
      ]);
      expect(fileNames(backupDir)).toContain('operator-copy.sqlite');
      expect(fileNames(backupDir)).toHaveLength(4);

      // The fifth backup evicts the oldest generation — the plain name,
      // sequence 0 of the shared instant — and only automatic backups.
      const fifthDb = new DatabaseSync(dbPath);
      const fifth = await runStartupMigrations({
        database: fifthDb,
        dataDir: dir.path,
        migrations: [
          probeMigration('0001-one'),
          probeMigration('0002-two'),
          probeMigration('0003-three'),
          probeMigration('0004-four'),
          probeMigration('0005-five'),
        ],
        clock,
      });
      fifthDb.close();

      expect(fifth.backup?.backup.name).toBe(`backup-${T0}-3.sqlite`);
      expect(fifth.backup?.evicted.map((evicted) => evicted.name)).toEqual([`backup-${T0}.sqlite`]);
      expect(automaticBackupNames(backupDir)).toEqual([
        `backup-${T0}-1.sqlite`,
        `backup-${T0}-2.sqlite`,
        `backup-${T0}-3.sqlite`,
      ]);
      // The foreign file survived the eviction untouched.
      expect(fileNames(backupDir)).toContain('operator-copy.sqlite');
      expect(fileNames(backupDir)).toHaveLength(4);
      // The spec's retention number, pinned.
      expect(AUTOMATIC_BACKUP_RETAINED_COUNT).toBe(3);
    });
  });

  it('refuses a newer schema before any work, leaving the database unchanged', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('newer.sqlite');
      // A database migrated by a newer release of the application.
      const writer = new DatabaseSync(dbPath);
      await createMigrationRunner({
        database: writer,
        migrations: [probeMigration('0001-init'), probeMigration('0009-from-the-future')],
        clock: createFixedClock(T0 - 1_000),
      }).up();
      writer.close();

      // Baseline: the main database file's exact bytes, plus its journal.
      const bytesBefore = readFileSync(dbPath);
      const journalBefore = journalRows(dbPath);

      const db = new DatabaseSync(dbPath);
      let refusal: NewerSchemaError | undefined;
      try {
        await runStartupMigrations({
          database: db,
          dataDir: dir.path,
          migrations: [probeMigration('0001-init')],
          clock: createFixedClock(T0),
        });
      } catch (error) {
        refusal = error as NewerSchemaError;
      }
      db.close();

      // The refusal itself: the §11.4 error naming both versions and the
      // evidence, thrown before any backup or migration work happened.
      expect(refusal).toBeInstanceOf(NewerSchemaError);
      expect(refusal?.name).toBe('NewerSchemaError');
      expect(refusal?.supportedVersion).toBe(1);
      expect(refusal?.appliedVersion).toBe(9);
      expect(refusal?.newerThanSupported.map((entry) => entry.name)).toEqual([
        '0009-from-the-future',
      ]);
      expect(refusal?.message).toMatch(
        /database schema version 9 is newer than this application supports \(1\)/,
      );
      expect(refusal?.message).toContain('0009-from-the-future');
      expect(refusal?.message).toContain('npm update -g quotameter');

      // §11.4 "leave the database unchanged": no backup directory was
      // created, the journal is untouched, and the main database file is
      // byte-identical — the refusal path performs not one write.
      expect(existsSync(automaticBackupsDir(dir.path))).toBe(false);
      expect(journalRows(dbPath)).toEqual(journalBefore);
      expect(readFileSync(dbPath).equals(bytesBefore)).toBe(true);
      expect(tableNames(dbPath)).toContain('0009_from_the_future');
    });
  });

  it('a failed migration keeps the backup and the pre-migration state; a corrected re-run applies', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('interrupted.sqlite');
      const clock = createFixedClock(T0);
      const db = new DatabaseSync(dbPath);
      // Schema 1 with data in it — the state the backup must preserve.
      await runStartupMigrations({
        database: db,
        dataDir: dir.path,
        migrations: [probeMigration('0001-base')],
        clock,
      });
      db.prepare('INSERT INTO "0001_base" (id) VALUES (7)').run();

      const exploding: Migration = {
        name: '0002-explodes',
        up: ({ database }) => {
          // Partial DDL before failing: exactly the state a crash mid-write
          // would leave behind.
          database.exec('CREATE TABLE explodes_probe (id INTEGER PRIMARY KEY) STRICT;');
          throw new Error('simulated failure after partial DDL');
        },
      };

      await expect(
        runStartupMigrations({
          database: db,
          dataDir: dir.path,
          migrations: [probeMigration('0001-base'), exploding],
          clock,
        }),
      ).rejects.toThrow(/Migration 0002-explodes \(up\) failed/);

      // The backup of the pre-migration state survived the failure and is
      // usable: it opens and carries the data as it was.
      const backupDir = automaticBackupsDir(dir.path);
      expect(automaticBackupNames(backupDir)).toEqual([`backup-${T0}.sqlite`]);
      const backup = new DatabaseSync(join(backupDir, `backup-${T0}.sqlite`));
      expect(backup.prepare('SELECT id FROM "0001_base"').all()).toEqual([{ id: 7 }]);
      backup.close();

      // The live database is exactly at schema 1 again: D-027's rollback
      // left no partial migration behind.
      expect(tableNames(dbPath)).not.toContain('explodes_probe');
      expect(journalRows(dbPath)).toEqual([{ name: '0001-base', applied_at: T0 }]);

      // The corrected re-run takes a second backup — same clock reading,
      // so the name disambiguates — and completes the migration.
      const corrected = await runStartupMigrations({
        database: db,
        dataDir: dir.path,
        migrations: [probeMigration('0001-base'), probeMigration('0002-explodes')],
        clock,
      });
      db.close();

      expect(corrected.applied).toEqual(['0002-explodes']);
      expect(corrected.backup?.backup.name).toBe(`backup-${T0}-1.sqlite`);
      expect(automaticBackupNames(backupDir)).toEqual([
        `backup-${T0}.sqlite`,
        `backup-${T0}-1.sqlite`,
      ]);
      expect(tableNames(dbPath)).toContain('0002_explodes');
    });
  });

  it('returns up-to-date without creating the journal table (no-write early return)', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('empty-set.sqlite');
      const db = new DatabaseSync(dbPath);
      const result = await runStartupMigrations({
        database: db,
        dataDir: dir.path,
        migrations: [],
        clock: createFixedClock(T0),
      });
      db.close();

      expect(result.status).toEqual({
        supportedVersion: 0,
        appliedVersion: 0,
        relation: 'up-to-date',
        newerThanSupported: [],
      });
      expect(result.applied).toEqual([]);
      expect(result.backup).toBeUndefined();
      // The early return precedes runner construction, which is what
      // creates the journal table: a no-op run writes nothing at all.
      expect(tableNames(dbPath)).not.toContain(MIGRATIONS_TABLE);
      expect(existsSync(automaticBackupsDir(dir.path))).toBe(false);
    });
  });

  it('backs up a journal-less but non-empty database before its first migration', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('foreign.sqlite');
      const db = new DatabaseSync(dbPath);
      // A foreign writer's tables with no journal: schema 0 by version,
      // but content the migrations are about to transform — protected,
      // not skipped (the carve-out is emptiness, not the journal).
      db.exec('CREATE TABLE foreign_state (id INTEGER PRIMARY KEY) STRICT;');
      db.prepare('INSERT INTO foreign_state (id) VALUES (3)').run();

      const result = await runStartupMigrations({
        database: db,
        dataDir: dir.path,
        migrations: [probeMigration('0001-one')],
        clock: createFixedClock(T0),
      });
      db.close();

      expect(result.applied).toEqual(['0001-one']);
      expect(result.backup?.backup.name).toBe(`backup-${T0}.sqlite`);

      // The pre-migration image keeps the foreign table exactly as it
      // was; the live database moved on.
      const backupPath = result.backup?.backup.path ?? '';
      const backup = new DatabaseSync(backupPath);
      expect(backup.prepare('SELECT id FROM foreign_state').all()).toEqual([{ id: 3 }]);
      backup.close();
      expect(tableNames(backupPath)).not.toContain('0001_one');
      expect(tableNames(dbPath)).toContain('0001_one');
      expect(tableNames(dbPath)).toContain('foreign_state');
    });
  });

  it('rejects a non-integer backup timestamp before touching the filesystem', async () => {
    await withTempDir(async (dir) => {
      const db = new DatabaseSync(':memory:');
      for (const now of [Number.NaN, -1, 1.5]) {
        expect(() =>
          createAutomaticBackup({
            database: db,
            backupDir: automaticBackupsDir(dir.path),
            now,
          }),
        ).toThrow(/must be a non-negative integer/);
      }
      db.close();
      expect(existsSync(automaticBackupsDir(dir.path))).toBe(false);
    });
  });
});

describe('automatic backup primitive (retention and runtime edge cases)', () => {
  it('never evicts the backup it just created when the clock reads earlier than the window', async () => {
    await withTempDir(async (dir) => {
      const backupDir = automaticBackupsDir(dir.path);
      const db = new DatabaseSync(dir.sqlitePath('stepback.sqlite'));
      db.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY) STRICT;');

      // Three generations at 3000, 4000, 5000 fill the window.
      for (const now of [3000, 4000, 5000]) {
        createAutomaticBackup({ database: db, backupDir, now });
      }
      expect(automaticBackupNames(backupDir)).toEqual([
        'backup-3000.sqlite',
        'backup-4000.sqlite',
        'backup-5000.sqlite',
      ]);

      // A clock step-back (the NTP-correction shape src/util/clock.ts
      // acknowledges): the new backup sorts oldest by its name but must
      // survive its own retention pass — the pre-migration image this
      // call exists to protect is not a legal eviction candidate.
      const stepped = createAutomaticBackup({ database: db, backupDir, now: 2000 });
      expect(stepped.backup.name).toBe('backup-2000.sqlite');
      expect(stepped.evicted.map((evicted) => evicted.name)).toEqual(['backup-3000.sqlite']);
      expect(automaticBackupNames(backupDir)).toEqual([
        'backup-2000.sqlite',
        'backup-4000.sqlite',
        'backup-5000.sqlite',
      ]);
      db.close();
    });
  });

  it('keeps a recreated unsuffixed name even though it sorts oldest at its instant', async () => {
    await withTempDir(async (dir) => {
      const backupDir = automaticBackupsDir(dir.path);
      const db = new DatabaseSync(dir.sqlitePath('revisit.sqlite'));
      db.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY) STRICT;');

      // Four backups at one instant: retention evicts the unsuffixed
      // name (sequence 0 of the instant)…
      for (let i = 0; i < 4; i += 1) {
        createAutomaticBackup({ database: db, backupDir, now: 8000 });
      }
      expect(automaticBackupNames(backupDir)).toEqual([
        'backup-8000-1.sqlite',
        'backup-8000-2.sqlite',
        'backup-8000-3.sqlite',
      ]);

      // …so a later backup at the same instant recreates that name,
      // which again sorts oldest — and again must survive its own pass.
      const revisited = createAutomaticBackup({ database: db, backupDir, now: 8000 });
      expect(revisited.backup.name).toBe('backup-8000.sqlite');
      expect(revisited.evicted.map((evicted) => evicted.name)).toEqual(['backup-8000-1.sqlite']);
      expect(automaticBackupNames(backupDir)).toEqual([
        'backup-8000.sqlite',
        'backup-8000-2.sqlite',
        'backup-8000-3.sqlite',
      ]);
      db.close();
    });
  });

  it('orders retention by parsed timestamps across digit-width boundaries', async () => {
    await withTempDir(async (dir) => {
      const backupDir = automaticBackupsDir(dir.path);
      const db = new DatabaseSync(dir.sqlitePath('widths.sqlite'));
      db.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY) STRICT;');

      // 999 → 1000 crosses a digit width, where lexicographic order
      // inverts ('backup-1000…' sorts before 'backup-999…').
      for (const now of [999, 1000, 1001]) {
        createAutomaticBackup({ database: db, backupDir, now });
      }
      const fourth = createAutomaticBackup({ database: db, backupDir, now: 1002 });
      expect(fourth.evicted.map((evicted) => evicted.name)).toEqual(['backup-999.sqlite']);
      expect(automaticBackupNames(backupDir)).toEqual([
        'backup-1000.sqlite',
        'backup-1001.sqlite',
        'backup-1002.sqlite',
      ]);
      db.close();
    });
  });

  it('includes committed-but-uncheckpointed WAL content in the standalone image', async () => {
    await withTempDir(async (dir) => {
      const dbPath = dir.sqlitePath('wal.sqlite');
      // The production shape: a WAL-mode connection (§11.1, D-030) that
      // stays open while the backup runs, with its commit sitting in the
      // WAL — proven by a non-empty sidecar file before the backup.
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('CREATE TABLE wal_marker (id INTEGER PRIMARY KEY) STRICT;');
      db.prepare('INSERT INTO wal_marker (id) VALUES (11)').run();
      expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

      const { backup } = createAutomaticBackup({
        database: db,
        backupDir: automaticBackupsDir(dir.path),
        now: T0,
      });
      db.close();

      const image = new DatabaseSync(backup.path);
      expect(image.prepare('SELECT id FROM wal_marker').all()).toEqual([{ id: 11 }]);
      image.close();
      // Standalone: the image carries no sidecar of its own.
      expect(existsSync(`${backup.path}-wal`)).toBe(false);
    });
  });

  it('refuses to back up from inside a transaction, writing no backup file', async () => {
    await withTempDir(async (dir) => {
      const backupDir = automaticBackupsDir(dir.path);
      const db = new DatabaseSync(dir.sqlitePath('tx.sqlite'));
      db.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY) STRICT;');
      db.exec('BEGIN IMMEDIATE');
      try {
        expect(() => createAutomaticBackup({ database: db, backupDir, now: T0 })).toThrow(
          /cannot VACUUM from within a transaction/,
        );
      } finally {
        db.exec('ROLLBACK');
      }
      db.close();
      // The directory exists (creation precedes the statement) but no
      // backup file was written.
      expect(readdirSync(backupDir)).toEqual([]);
    });
  });
});
