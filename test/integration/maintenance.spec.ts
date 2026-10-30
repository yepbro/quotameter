import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openStorageConnection } from '../../src/storage/connection';
import { runStorageMaintenance } from '../../src/storage/maintenance';
import { createMigrationRunner, MIGRATIONS } from '../../src/storage/migrations';
import { withTempDir } from '../helpers/isolation';

/**
 * The §11.3 maintenance primitive's own suite (task 091, decision D-063):
 * the WAL checkpoint is observable by its **effect** — the `-wal` file,
 * which only TRUNCATE mode resets to zero bytes — and the auto_vacuum
 * readback is the "where supported/configured" visibility §11.3 asks for.
 * The fixtures deliberately run against the production connection
 * (`openStorageConnection`, task 079): its readback-verified WAL pragma is
 * what makes the file-level assertion meaningful, and the module always
 * runs on such a connection in the service. The busy outcome needs a
 * second connection holding a stale read snapshot, so that case opens raw
 * handles with `busy_timeout = 0` — with the §11.1 budget it would instead
 * wait five seconds before reporting busy, which no test should pay for.
 * The `node:sqlite` ExperimentalWarning is expected here, as in every
 * storage test (docs/agents/gotchas.md).
 */

/** The `-wal` companion file path of a database file. */
const walPath = (databasePath: string): string => `${databasePath}-wal`;

describe('storage maintenance — §11.3 checkpoint and incremental_vacuum (task 091)', () => {
  it('checkpoints the WAL to zero bytes and reports the outcome', async () => {
    await withTempDir(async (dir) => {
      const connection = openStorageConnection({ dataDir: dir.path });
      try {
        await createMigrationRunner({ database: connection.database, migrations: MIGRATIONS }).up();
        connection.database
          .prepare(
            `INSERT INTO meta (key, value) VALUES ('maintenance-probe', 'written via the WAL')`,
          )
          .run();

        const walSizeBefore = statSync(walPath(connection.path)).size;
        expect(walSizeBefore).toBeGreaterThan(0);

        const result = runStorageMaintenance(connection.database);

        // TRUNCATE mode reset the WAL file — the disk reclamation §11.3's
        // post-cleanup checkpoint exists for.
        expect(statSync(walPath(connection.path)).size).toBe(0);
        expect(result.walCheckpoint.busy).toBe(false);
        expect(result.walCheckpoint.walPages).toBeGreaterThanOrEqual(0);
        expect(result.walCheckpoint.checkpointedPages).toBeGreaterThanOrEqual(0);
        // The §11.1 pragma set configures no auto_vacuum, so the service's
        // own databases report NONE — where incremental_vacuum is a no-op.
        expect(result.autoVacuumMode).toBe('none');
      } finally {
        connection.close();
      }
    });
  });

  it('reports the auto_vacuum mode of operator-configured databases', async () => {
    await withTempDir(async (dir) => {
      for (const [mode, expected] of [
        ['FULL', 'full'],
        ['INCREMENTAL', 'incremental'],
      ] as const) {
        const database = new DatabaseSync(dir.sqlitePath(`${mode.toLowerCase()}.sqlite`));
        try {
          // auto_vacuum must be set before the first table exists; WAL makes
          // the fixture match the service's journal mode.
          database.exec(`PRAGMA auto_vacuum = ${mode}`);
          database.exec('PRAGMA journal_mode = WAL');
          database.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY)');

          const result = runStorageMaintenance(database);

          expect(result.autoVacuumMode).toBe(expected);
          expect(result.walCheckpoint.busy).toBe(false);
        } finally {
          database.close();
        }
      }
    });
  });

  it('reports busy when another connection holds a stale read snapshot', async () => {
    await withTempDir(async (dir) => {
      const databasePath = dir.sqlitePath('busy.sqlite');
      const writer = new DatabaseSync(databasePath);
      const reader = new DatabaseSync(databasePath);
      try {
        writer.exec('PRAGMA journal_mode = WAL');
        writer.exec('PRAGMA busy_timeout = 0');
        writer.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY)');
        writer.exec('INSERT INTO probe (id) VALUES (1)');

        // The reader's snapshot predates the writer's next insert, so the
        // checkpoint cannot reset the WAL past it — TRUNCATE reports busy
        // instead of waiting (busy_timeout is zero on both handles).
        reader.exec('PRAGMA busy_timeout = 0');
        reader.exec('BEGIN');
        reader.prepare('SELECT count(*) AS n FROM probe').get();
        writer.exec('INSERT INTO probe (id) VALUES (2)');

        const result = runStorageMaintenance(writer);

        expect(result.walCheckpoint.busy).toBe(true);
        // busy is a reportable outcome, not an error: nothing threw, and
        // the next cleanup (§11.3: startup and daily) checkpoints again.
        reader.exec('ROLLBACK');
        expect(runStorageMaintenance(writer).walCheckpoint.busy).toBe(false);
      } finally {
        writer.close();
        reader.close();
      }
    });
  });
});
