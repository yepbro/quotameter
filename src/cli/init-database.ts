/**
 * The §5.3 step-5 database half of `init` (task U-059, spec §5.3; decision
 * D-187).
 *
 * §5.3 step 5: "Create configuration/data directories with mode `0700`,
 * configuration file with mode `0600`, and the database." The
 * configuration half landed with task 132 (`init-persist.ts`); the
 * database half is this module — on a fresh run, after the consented
 * configuration write, the run creates the data directory and brings the
 * database to the current schema, so the service that starts later (by
 * hand, by the installed unit, or after a reboot) opens a ready database
 * instead of creating one at its own startup.
 *
 * The storage seam is the composition's own open/migrate pair, consumed
 * read-only through dynamic imports (`node:sqlite` stays out of every
 * dispatch graph until a command actually touches storage — the D-116
 * discipline `passwd.ts` set): `openStorageConnection` applies the §11.1
 * pragmas (creating the file on first open), and `runStartupMigrations`
 * runs §11.4's backup-protected sequence over the canonical `MIGRATIONS`.
 * The sequence is idempotent by construction — a surviving database (the
 * D-141 revocation world: configuration deleted or re-pointed while the
 * database lived on) classifies up-to-date or behind and migrates, exactly
 * what the service's storage component would do at its own start. Before
 * anything opens, the data directory's §5.6 single-instance lock is read:
 * a **live** holder refuses the step (init must never run backup or DDL
 * under a running service — the lock is the mechanism §5.6 exists for),
 * and an unreadable or invalid lock refuses fail-closed; a dead holder's
 * stale lock and the fresh machine's absent lock proceed.
 *
 * The failure policy is the configuration write's, not the connection
 * test's (D-187): §5.3 step 5 is a must, not a best-effort — every
 * reachable failure (an unwritable data directory, a corrupt or foreign
 * file at the database path, a WAL-incapable filesystem, §11.4's newer
 * schema) leaves a service that cannot start, so the run aborts (exit 1,
 * the service never installed) with the already-written configuration
 * file explicitly kept. A failed provider connection test (step 6) is the
 * tolerated contrast: a bad key harms only the account, the environment
 * still works.
 */

import { chmod, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { thrownMessage } from './service-setup';

/**
 * The on-disk database name inside a data directory — storage's
 * `DATABASE_FILENAME` contract, restated so the path exists before any
 * storage module loads (the `passwd.ts` precedent; the duplication is
 * pinned by the integration suite, which creates the database through the
 * landed connection module).
 */
const DATABASE_FILENAME = 'quotameter.sqlite';

/** What one database-initialization run established. */
export type InitDatabaseOutcome =
  | {
      /** The data directory exists and the database is at the current schema. */
      readonly state: 'ready';
      /** Absolute path of the database file (`<dataDir>/${DATABASE_FILENAME}`). */
      readonly databasePath: string;
    }
  | {
      /** Nothing usable was established; `detail` is one honest line. */
      readonly state: 'failed';
      readonly detail: string;
    };

/** The seam behind `InitDeps.createDatabase`; production {@link createInitDatabase}. */
export type InitDatabaseStep = (dataDir: string) => Promise<InitDatabaseOutcome>;

/**
 * Refuses when a live quotameter service holds the data directory's §5.6
 * single-instance lock (review round P2): init must never run backup or
 * DDL under a live process — the lock is exactly the §5.6 mechanism that
 * exists to prevent two processes using one data directory. Read through
 * the landed D-112 reader; fail closed on an unreadable or invalid lock (a
 * directory whose lock state cannot be established is not one to migrate);
 * a dead holder's stale lock does not refuse (§5.6's next start clears
 * it), and an absent lock — the fresh-machine case — proceeds.
 */
async function liveHolderDetail(dataDir: string): Promise<string | null> {
  const { readServiceLock } = await import('./service-reload');
  const { lockFilePath, isProcessAlive } = await import('../server/single-instance');
  const lock = await readServiceLock(lockFilePath(dataDir));
  if (lock.state === 'held' && isProcessAlive(lock.pid)) {
    return (
      `the data directory is in use by a running quotameter service (pid ${lock.pid}) — ` +
      'stop it before initializing'
    );
  }
  if (lock.state === 'unreadable') {
    return `the single-instance lock of the data directory cannot be read (${lock.detail})`;
  }
  if (lock.state === 'invalid') {
    return (
      'the single-instance lock of the data directory is not a valid quotameter lock — ' +
      'verify that no quotameter process is running, then remove the lock file and run init again'
    );
  }
  return null;
}

/**
 * Creates the data directory (§5.3 step 5's `0700`) level by level, each
 * `mkdir` followed by an explicit `chmod` — the configuration path's own
 * umask-proof walk (a recursive `mkdir` applies `mode & ~umask` to every
 * level it creates, so a hostile umask would leave the first new ancestor
 * untraversable), and the final level is chmod'd even when it already
 * existed, so a drifted pre-existing directory is corrected to `0700`.
 */
async function ensureDataDirectory(dataDir: string): Promise<void> {
  const missing: string[] = [];
  for (let current = dataDir; ;) {
    if (await pathExists(current)) break;
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const level of missing.reverse()) {
    try {
      await mkdir(level, { mode: 0o700 });
    } catch (error) {
      // A concurrent creator is not this run's to correct level by level;
      // the final chmod below still covers the data directory itself.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      continue;
    }
    await chmod(level, 0o700);
  }
  await chmod(dataDir, 0o700);
}

/** Whether `targetPath` exists, by one `stat` whose ENOENT reads as absent. */
async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the data directory and brings the database inside it to the
 * current schema. One failure domain: every problem — the lock, the
 * directory walk, the open, the migrations — is the `failed` outcome with
 * the underlying message (the layers already report in operator-addressable
 * English with the full path), never a throw.
 */
export async function createInitDatabase(dataDir: string): Promise<InitDatabaseOutcome> {
  const databasePath = join(dataDir, DATABASE_FILENAME);
  try {
    const holder = await liveHolderDetail(dataDir);
    if (holder !== null) return { state: 'failed', detail: holder };
    await ensureDataDirectory(dataDir);
    const { openStorageConnection } = await import('../storage/connection');
    const { runStartupMigrations } = await import('../storage/startup-migrations');
    const { MIGRATIONS } = await import('../storage/migrations');
    const connection = openStorageConnection({ dataDir });
    try {
      await runStartupMigrations({
        database: connection.database,
        dataDir,
        migrations: MIGRATIONS,
      });
    } finally {
      connection.close();
    }
    return { state: 'ready', databasePath };
  } catch (error) {
    return { state: 'failed', detail: thrownMessage(error) };
  }
}
