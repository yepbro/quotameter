/**
 * The database connection every storage consumer shares (spec §11.1; task
 * 079, decision D-030).
 *
 * Opens `<data>/quotameter.sqlite` and applies the §11.1 pragma set. The
 * data directory arrives already resolved by `src/config/paths.ts` (task
 * 063) — storage never re-resolves it — and the connection hands its
 * configured `DatabaseSync` to task 078's migration harness (D-027: "the
 * runner owns no connection — 079 supplies it") and the future repository
 * (task 088).
 *
 * - **Pragmas are applied as statements and verified by readback.** Driver
 *   constructor options for these settings did not all exist on the pinned
 *   minimum runtime (Node 22.13.0), and one setting has a silent-fallback
 *   failure mode: `:memory:` keeps `journal_mode=memory`, and filesystems
 *   without WAL support fall back to `delete`. A database that cannot hold a
 *   required setting refuses to open instead of degrading (the D-013
 *   fail-fast style) — durability assumptions elsewhere (atomic
 *   snapshot+metric+event transactions, §11.1) rest on WAL actually being
 *   engaged.
 * - **The wrapper owns close semantics.** Node 22.13 has no `isOpen` on
 *   `DatabaseSync` and throws `ERR_INVALID_STATE` on a repeated `close()`;
 *   the connection tracks openness itself and keeps `close()` idempotent —
 *   the shutdown sequence (D-020) closes storage after the drain and must
 *   survive a repeated call, including one that follows a direct
 *   `database.close()` by a consumer.
 * - **No directory creation.** The startup path creates the data directory
 *   when acquiring the single-instance lock (task 074, `ensureDataDir`);
 *   a missing parent is an operator problem reported loudly with the full
 *   path, never papered over with a `mkdir`.
 */

import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';

/**
 * Database file name inside the data directory (spec §11.1). Part of the
 * on-disk contract: renaming it strands existing databases, the way
 * `MIGRATIONS_TABLE` does (D-027).
 */
export const DATABASE_FILENAME = 'quotameter.sqlite';

/** Milliseconds a statement waits on a locked database (spec §11.1: 5000). */
export const BUSY_TIMEOUT_MS = 5000;

/** Options for {@link openStorageConnection}. */
export interface StorageConnectionOptions {
  /**
   * Data directory holding the database file, resolved by the caller via
   * `resolvePaths`/`resolveDataDir` (spec §6.1, task 063). This module
   * appends {@link DATABASE_FILENAME} and creates nothing.
   */
  readonly dataDir: string;
  /**
   * Opens the database handle; defaults to `new DatabaseSync(path)`. The
   * seam exists so tests can prove the fail-fast contract (a database that
   * cannot hold a §11.1 setting refuses to open) without a WAL-incapable
   * filesystem; production callers never pass it.
   */
  readonly openDatabase?: (databasePath: string) => DatabaseSync;
}

/** A closeable handle around the configured `DatabaseSync`. */
export interface StorageConnection {
  /**
   * The open database with the §11.1 pragmas applied — the value task 078's
   * `createMigrationRunner({ database })` and the repository consume.
   */
  readonly database: DatabaseSync;
  /** Absolute path of the database file (`<data>/${DATABASE_FILENAME}`). */
  readonly path: string;
  /** False once {@link close} has run. */
  readonly isOpen: boolean;
  /**
   * Closes the database. Idempotent: a second call is a no-op, and a call
   * that follows a direct `database.close()` by a consumer is tolerated.
   */
  close(): void;
}

/** One §11.1 setting: the statement that applies it and proves it took. */
interface PragmaSetting {
  /** Applied with `exec` at open. */
  readonly apply: string;
  /** Whose single-row result proves the setting took effect. */
  readonly verify: string;
  /** Column name of that row — `PRAGMA busy_timeout` reports `timeout`. */
  readonly column: string;
  /** The value spec §11.1 requires. */
  readonly expected: string | number;
}

/**
 * The §11.1 settings, in application order. `busy_timeout` comes first so
 * that engaging WAL on a busy existing database waits within the §11.1
 * budget instead of failing immediately; `synchronous` reports its mode by
 * number (0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA).
 */
const PRAGMA_SETTINGS: ReadonlyArray<PragmaSetting> = [
  {
    apply: `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`,
    verify: 'PRAGMA busy_timeout',
    column: 'timeout',
    expected: BUSY_TIMEOUT_MS,
  },
  {
    apply: 'PRAGMA journal_mode = WAL',
    verify: 'PRAGMA journal_mode',
    column: 'journal_mode',
    expected: 'wal',
  },
  {
    apply: 'PRAGMA synchronous = NORMAL',
    verify: 'PRAGMA synchronous',
    column: 'synchronous',
    expected: 1,
  },
  {
    apply: 'PRAGMA foreign_keys = ON',
    verify: 'PRAGMA foreign_keys',
    column: 'foreign_keys',
    expected: 1,
  },
];

/** The database file path inside a data directory (spec §11.1). */
export function databaseFilePath(dataDir: string): string {
  // `resolvePaths` returns absolute directories (D-012); resolve also
  // normalizes a relative test directory and makes `connection.path`
  // deterministic regardless of the working directory.
  return path.resolve(dataDir, DATABASE_FILENAME);
}

/**
 * Opens the database at `<data>/${DATABASE_FILENAME}`, creating the file
 * automatically on first open, and configures the §11.1 settings.
 *
 * Fails fast — with the full path and the original error as `cause` — when
 * the file cannot be opened (a missing parent directory) or a required
 * setting does not take or fails to apply (a database that cannot hold WAL,
 * or a corrupt file: the constructor reads the header lazily, so a non-
 * SQLite file first surfaces as a driver error inside pragma application).
 * The unusable handle is closed — best-effort, never masking the real
 * failure — before the error propagates.
 */
export function openStorageConnection(options: StorageConnectionOptions): StorageConnection {
  const { dataDir, openDatabase = defaultOpenDatabase } = options;
  const databasePath = databaseFilePath(dataDir);

  let database: DatabaseSync;
  try {
    database = openDatabase(databasePath);
  } catch (error) {
    throw new Error(`cannot open database at '${databasePath}': ${describeCause(error)}`, {
      cause: error,
    });
  }

  try {
    applyPragmaSettings(database, databasePath);
  } catch (error) {
    // The settings did not take — release the unusable handle rather than
    // leaking it to the caller that never received it. Best-effort on
    // purpose: a failing release must not mask the configuration error,
    // which is the actionable one.
    try {
      database.close();
    } catch {
      // Nothing to add — the configuration error below is the report.
    }
    throw error;
  }

  let open = true;
  return {
    database,
    path: databasePath,
    get isOpen() {
      return open;
    },
    close() {
      if (!open) return;
      // The state flips before the underlying close: a close that throws a
      // non-tolerated error then reports isOpen=false even though the handle
      // may survive — the reverse ordering would instead rethrow on a retry.
      // Both orders are imperfect; this one keeps the D-020 shutdown path
      // survivable, which is the requirement that matters.
      open = false;
      try {
        database.close();
      } catch (error) {
        // The handle was already closed through `database` directly; an
        // idempotent close treats that as done rather than crashing the
        // shutdown path (D-020).
        if ((error as NodeJS.ErrnoException).code !== 'ERR_INVALID_STATE') {
          throw error;
        }
      }
    },
  };
}

/** The default {@link StorageConnectionOptions.openDatabase}. */
function defaultOpenDatabase(databasePath: string): DatabaseSync {
  return new DatabaseSync(databasePath);
}

/** Applies every §11.1 setting and verifies it by readback. */
function applyPragmaSettings(database: DatabaseSync, databasePath: string): void {
  for (const setting of PRAGMA_SETTINGS) {
    let row: Record<string, unknown>;
    try {
      database.exec(setting.apply);
      row = database.prepare(setting.verify).get() as Record<string, unknown>;
    } catch (error) {
      // A driver failure mid-pragma carries no context of its own — a
      // corrupt or non-SQLite file passes the constructor (lazy header
      // read) and first surfaces here as a bare `file is not a database`.
      throw new Error(
        `cannot configure database at '${databasePath}' while applying ` +
          `${setting.apply}: ${describeCause(error)}`,
        { cause: error },
      );
    }
    const reported = row[setting.column];
    if (reported !== setting.expected) {
      throw new Error(
        `database at '${databasePath}' cannot be configured per the required settings: ` +
          `${setting.verify} reports '${String(reported)}', expected '${String(setting.expected)}'`,
      );
    }
  }
}

/** Renders an opening failure for an error message, with its errno code. */
function describeCause(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `(${code}) ${error.message}`;
  }
  return String(error);
}
