import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  BUSY_TIMEOUT_MS,
  DATABASE_FILENAME,
  databaseFilePath,
  openStorageConnection,
} from '../../src/storage/connection';
import { createMigrationRunner, type Migration } from '../../src/storage/migrations';
import { withTempDir } from '../helpers/isolation';

/**
 * Task 079's verification (spec §11.1): the connection module opens
 * `<data>/quotameter.sqlite` automatically and every required setting is
 * proven by reading it back — `journal_mode=WAL` through an independent
 * connection (WAL lives in the file), the per-connection settings through
 * the connection's own handle, and `foreign_keys=ON` behaviorally: a real
 * foreign-key violation must fail. The `node:sqlite` ExperimentalWarning is
 * expected here, as in every storage test (docs/agents/gotchas.md).
 *
 * Every database is a disposable file under a per-test temporary directory
 * (test/helpers/isolation.ts).
 */

/** The single row a pragma readback returns. */
function pragmaRow(database: DatabaseSync, statement: string): Record<string, unknown> {
  return database.prepare(statement).get() as Record<string, unknown>;
}

/** Captures the thrown value of `body` for message/cause assertions. */
function captureFailure(body: () => void): unknown {
  try {
    body();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('storage connection (§11.1 settings)', () => {
  it('creates <data>/quotameter.sqlite automatically and reports its path', async () => {
    await withTempDir(async (dir) => {
      // The file name is part of the on-disk contract (D-030), pinned the
      // way MIGRATIONS_TABLE is (D-027): a rename must not pass silently.
      expect(DATABASE_FILENAME).toBe('quotameter.sqlite');

      const connection = openStorageConnection({ dataDir: dir.path });
      try {
        expect(connection.path).toBe(databaseFilePath(dir.path));
        expect(existsSync(connection.path)).toBe(true);
      } finally {
        connection.close();
      }
    });
  });

  it('engages WAL on a fresh file, visible to an independent connection', async () => {
    await withTempDir(async (dir) => {
      const connection = openStorageConnection({ dataDir: dir.path });
      connection.close();

      // WAL is a property of the file, not the handle: prove it from a
      // connection this module never touched.
      const reader = new DatabaseSync(databaseFilePath(dir.path));
      try {
        expect(pragmaRow(reader, 'PRAGMA journal_mode')['journal_mode']).toBe('wal');
      } finally {
        reader.close();
      }
    });
  });

  it('reopens an existing database with data intact and settings re-applied', async () => {
    await withTempDir(async (dir) => {
      const first = openStorageConnection({ dataDir: dir.path });
      try {
        first.database.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY) STRICT;');
        first.database.prepare('INSERT INTO probe (id) VALUES (?)').run(7);
      } finally {
        first.close();
      }

      const second = openStorageConnection({ dataDir: dir.path });
      try {
        expect(second.isOpen).toBe(true);
        const row = second.database.prepare('SELECT id FROM probe').get() as { id: number };
        expect(row.id).toBe(7);
        // §11.1 applies on every open, not only on a fresh file.
        expect(pragmaRow(second.database, 'PRAGMA journal_mode')['journal_mode']).toBe('wal');
      } finally {
        second.close();
      }
    });
  });

  it('configures busy_timeout, synchronous, and foreign_keys per §11.1', async () => {
    await withTempDir(async (dir) => {
      // The value itself is spec-pinned, not negotiable through options.
      expect(BUSY_TIMEOUT_MS).toBe(5000);

      const connection = openStorageConnection({ dataDir: dir.path });
      try {
        // Per-connection settings: read back through the connection's own
        // handle (an independent reader would report its own defaults).
        // `PRAGMA busy_timeout` reports its result under the column `timeout`.
        expect(pragmaRow(connection.database, 'PRAGMA busy_timeout')['timeout']).toBe(5000);
        // synchronous reports the mode by number: 1 = NORMAL.
        expect(pragmaRow(connection.database, 'PRAGMA synchronous')['synchronous']).toBe(1);
        expect(pragmaRow(connection.database, 'PRAGMA foreign_keys')['foreign_keys']).toBe(1);
      } finally {
        connection.close();
      }
    });
  });

  it('enforces foreign keys: inserting a child without its parent fails', async () => {
    await withTempDir(async (dir) => {
      const connection = openStorageConnection({ dataDir: dir.path });
      try {
        connection.database.exec(`
          CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;
          CREATE TABLE child (parent_id INTEGER NOT NULL REFERENCES parent (id)) STRICT;
        `);

        expect(() =>
          connection.database.prepare('INSERT INTO child (parent_id) VALUES (?)').run(999),
        ).toThrow(/FOREIGN KEY constraint failed/);

        // Control: with the parent present the same statement succeeds.
        connection.database.prepare('INSERT INTO parent (id) VALUES (?)').run(1);
        connection.database.prepare('INSERT INTO child (parent_id) VALUES (?)').run(1);
        const rows = connection.database.prepare('SELECT COUNT(*) AS n FROM child').get() as {
          n: number;
        };
        expect(rows.n).toBe(1);
      } finally {
        connection.close();
      }
    });
  });

  it('closes idempotently and tolerates a close through the raw handle', async () => {
    await withTempDir(async (dir) => {
      const connection = openStorageConnection({ dataDir: dir.path });
      expect(connection.isOpen).toBe(true);
      connection.close();
      expect(connection.isOpen).toBe(false);
      // Second close: a no-op, not ERR_INVALID_STATE (D-020 shutdown paths).
      expect(() => connection.close()).not.toThrow();
      expect(connection.isOpen).toBe(false);
      // The underlying handle really is closed.
      expect(() => connection.database.prepare('SELECT 1')).toThrow(/database is not open/);

      // A consumer closing `database` directly must not break the wrapper.
      const external = openStorageConnection({ dataDir: dir.path });
      external.database.close();
      expect(() => external.close()).not.toThrow();
      expect(external.isOpen).toBe(false);
    });
  });

  it('reports a missing parent directory loudly and creates nothing', async () => {
    await withTempDir(async (dir) => {
      const missing = join(dir.path, 'does-not-exist');
      const failure = captureFailure(() => openStorageConnection({ dataDir: missing }));

      expect(failure).toBeInstanceOf(Error);
      const error = failure as Error;
      expect(error.message).toContain(`cannot open database at '${databaseFilePath(missing)}'`);
      expect(error.message).toContain('unable to open database file');
      expect(error.cause).toBeInstanceOf(Error);

      // Directory creation belongs to the startup path (task 074), never here.
      expect(existsSync(missing)).toBe(false);
    });
  });

  it("refuses a database that cannot hold the settings (':memory:' keeps journal_mode=memory)", () => {
    // The openDatabase seam supplies the one WAL-incapable database that
    // exists everywhere: in-memory SQLite reports journal_mode 'memory' no
    // matter what was applied — exactly the silent fallback §11.1 forbids.
    const failure = captureFailure(() =>
      openStorageConnection({
        dataDir: '/irrelevant-with-the-seam',
        openDatabase: () => new DatabaseSync(':memory:'),
      }),
    );

    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error;
    expect(error.message).toContain("PRAGMA journal_mode reports 'memory', expected 'wal'");
    expect(error.message).toContain('database at ');
  });

  it('reports a corrupt file with full context: the driver error surfaces mid-pragma', async () => {
    await withTempDir(async (dir) => {
      // A non-SQLite file passes the constructor (the header is read
      // lazily) and first fails inside pragma application as a bare
      // driver error — the wrapper must add the path and keep the cause.
      const garbage = databaseFilePath(dir.path);
      await writeFile(garbage, 'this is not a sqlite database at all, just bytes');

      const failure = captureFailure(() => openStorageConnection({ dataDir: dir.path }));

      expect(failure).toBeInstanceOf(Error);
      const error = failure as Error;
      expect(error.message).toContain(`cannot configure database at '${garbage}'`);
      expect(error.message).toContain('while applying PRAGMA');
      expect(error.cause).toBeInstanceOf(Error);
    });
  });

  it('lets the configuration error win when releasing the unusable handle also fails', () => {
    // A handle that is already closed fails both at pragma application and
    // at the cleanup close; the reported error must be the configuration
    // one (with the path), never the cleanup's ERR_INVALID_STATE.
    const premature = new DatabaseSync(':memory:');
    premature.close();
    const failure = captureFailure(() =>
      openStorageConnection({
        dataDir: '/irrelevant-with-the-seam',
        openDatabase: () => premature,
      }),
    );

    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error;
    // The path-bearing configuration wrapper is what escaped — had the
    // cleanup close masked it, the thrown error would be the bare
    // `ERR_INVALID_STATE: database is not open` with no path.
    expect(error.message).toContain(
      `cannot configure database at '${databaseFilePath('/irrelevant-with-the-seam')}'`,
    );
    expect(error.message).toContain('while applying PRAGMA busy_timeout');
  });

  it('feeds the migration harness: the D-027 seam receives the configured database', async () => {
    await withTempDir(async (dir) => {
      const connection = openStorageConnection({ dataDir: dir.path });
      const probe: Migration = {
        name: '0001-connection-probe',
        up: ({ database }) => {
          database.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY) STRICT;');
        },
      };
      const runner = createMigrationRunner({ database: connection.database, migrations: [probe] });

      expect(await runner.up()).toEqual(['0001-connection-probe']);
      connection.close();

      // The applied migration is committed and visible beyond the handle.
      const reader = new DatabaseSync(databaseFilePath(dir.path));
      try {
        const tables = reader
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>;
        expect(tables.map((table) => table.name)).toContain('probe');
      } finally {
        reader.close();
      }
    });
  });
});
