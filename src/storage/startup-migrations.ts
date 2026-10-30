/**
 * The startup migration operation — §11.4's backup-then-migrate sequence
 * and newer-schema refusal as one call (task 092, decision D-065).
 *
 * Spec §11.4: "Before applying migrations, create a backup using
 * `VACUUM INTO` and retain the three most recent automatic backups. Apply
 * migrations automatically at startup. If the database schema is newer
 * than the running application supports, refuse to start and leave the
 * database unchanged." Spec §5.6 states the backup and the same refusal
 * from the process-lifecycle side. This module is that ordering, as the
 * seam the future server startup wiring calls; scheduling, process exit,
 * and error reporting are the wiring's, not storage's.
 *
 * The order is the contract, and every step is deliberately placed:
 *
 * 1. **Read the version relation first — before any backup, any
 *    migration, any runner construction.** `schemaVersionStatus` is
 *    read-only (it never even creates the journal table), so the refusal
 *    path performs not one write: a newer schema throws {@link
 *    NewerSchemaError} over a database that is byte-for-byte what it was
 *    (pinned by test), which is §11.4's "leave the database unchanged"
 *    made strong. The runner must not be constructed before the check —
 *    D-027's construction creates the journal table, a write.
 * 2. **`'up-to-date'` returns without touching anything.** No migrations
 *    pending means no backup (§5.6 guards *migrations*, and there are
 *    none) and no reason to pay even the journal-table write; the early
 *    return precedes runner construction, pinned by test on a fresh
 *    database against an empty set.
 * 3. **`'behind'` backs up only when a pre-migration state exists.** With
 *    `appliedVersion > 0` the database carries a schema worth protecting.
 *    A schema-0 database with no tables at all — the fresh install this
 *    application itself produces — skips the backup: `VACUUM INTO` of an
 *    empty file protects nothing and costs a directory plus a file copy.
 *    The carve-out is emptiness, not the journal alone: a journal-less
 *    database that has tables (a foreign file at the data path, or one
 *    whose `schema_migrations` was lost) *is* backed up — the pending
 *    migrations will transform or collide with that content, which is
 *    exactly when an operator wants the pre-migration image (review
 *    finding). Either way {@link createAutomaticBackup} runs first, so a
 *    migration that fails midway — one transaction per migration, D-027 —
 *    still leaves the pre-migration image on disk and the next startup
 *    retries over it. Pinned in D-065 and by test.
 * 4. **Then, and only then, the D-027 harness applies pending
 *    migrations** — `createMigrationRunner(...).up()`, unchanged. Its
 *    failure semantics (atomic apply+record, later migrations never
 *    attempted after a failure) are D-027's and stay tested there; the
 *    backup taken in step 3 survives any of them.
 *
 * A backup failure (unwritable directory, full disk) propagates before
 * any migration runs: the database stays at its current schema, and the
 * next startup retries the whole sequence — the conservative direction
 * §11.4's backup exists for.
 */

import type { DatabaseSync } from 'node:sqlite';
import { createSystemClock, type Clock } from '../util/clock';
import { automaticBackupsDir, createAutomaticBackup, type AutomaticBackupResult } from './backups';
import {
  createMigrationRunner,
  type AppliedMigration,
  type Migration,
  MIGRATIONS_TABLE,
  type SchemaVersionStatus,
  schemaVersionStatus,
} from './migrations';

/**
 * The §11.4 refusal: the database's schema is newer than this application
 * supports, so nothing may run against it. Thrown by {@link
 * runStartupMigrations} before any write; the startup wiring turns it
 * into the refuse-to-start exit. Carries the evidence so callers can
 * report it without re-reading the database.
 */
export class NewerSchemaError extends Error {
  /** The schema version this application's migration set supports. */
  readonly supportedVersion: number;
  /** The highest schema version the database's journal records. */
  readonly appliedVersion: number;
  /** The journal entries beyond {@link supportedVersion}, name order. */
  readonly newerThanSupported: ReadonlyArray<AppliedMigration>;

  constructor(status: SchemaVersionStatus) {
    super(
      `database schema version ${status.appliedVersion} is newer than this application ` +
        `supports (${status.supportedVersion}); refusing to start so the database is left ` +
        `unchanged. Journal entries newer than supported: ` +
        `${status.newerThanSupported.map((entry) => entry.name).join(', ')}. ` +
        `Upgrade quotameter to a release supporting schema ${status.appliedVersion} or newer ` +
        `(npm update -g quotameter), then restart (spec §5.6).`,
    );
    this.name = new.target.name;
    this.supportedVersion = status.supportedVersion;
    this.appliedVersion = status.appliedVersion;
    this.newerThanSupported = status.newerThanSupported;
  }
}

/** Options for {@link runStartupMigrations}. */
export interface StartupMigrationsOptions {
  /** An open database; never opened or closed here (the D-027 seam). */
  readonly database: DatabaseSync;
  /**
   * The data directory (resolved by `src/config/paths.ts`, the task 079
   * seam): automatic backups land in its {@link automaticBackupsDir}.
   */
  readonly dataDir: string;
  /** The migration list — for the application, the canonical `MIGRATIONS`. */
  readonly migrations: ReadonlyArray<Migration>;
  /**
   * Timestamps for the journal and the backup name (D-021); defaults to
   * the system clock. The composition root passes its shared clock.
   */
  readonly clock?: Clock;
}

/** What one startup migration run did. */
export interface StartupMigrationsResult {
  /** The §11.4 version check the run opened with. */
  readonly status: SchemaVersionStatus;
  /** Applied migration names in application order; `[]` when none ran. */
  readonly applied: ReadonlyArray<string>;
  /**
   * The backup taken before migrating — `undefined` when none was due (a
   * schema-0 database, or an up-to-date one; see the module comment).
   */
  readonly backup: AutomaticBackupResult | undefined;
}

/**
 * Runs §11.4's startup sequence over one open database: refuse a newer
 * schema (leaving the database unchanged), back up when pending
 * migrations would transform an existing schema, then apply the pending
 * migrations. See the module comment for the ordering contract.
 */
export async function runStartupMigrations(
  options: StartupMigrationsOptions,
): Promise<StartupMigrationsResult> {
  const { database, dataDir, migrations, clock = createSystemClock() } = options;

  // Read-only, and it validates the set first (D-031): a malformed list
  // fails here, before the filesystem is touched at all.
  const status = schemaVersionStatus(database, migrations);

  if (status.relation === 'newer') {
    throw new NewerSchemaError(status);
  }
  if (status.relation === 'up-to-date') {
    // Nothing to migrate: no backup, no journal-table write, no runner.
    return { status, applied: [], backup: undefined };
  }

  // 'behind': protect the existing schema before transforming it — the
  // carve-out is a genuinely empty database (fresh install), not merely a
  // journal-less one: foreign or journal-lost tables are content the
  // migrations are about to transform.
  const backup =
    status.appliedVersion > 0 || hasNonJournalTables(database)
      ? createAutomaticBackup({
          database,
          backupDir: automaticBackupsDir(dataDir),
          now: clock.now(),
        })
      : undefined;

  const applied = await createMigrationRunner({ database, migrations, clock }).up();
  return { status, applied, backup };
}

/**
 * Whether the database holds any table beyond the journal and SQLite's own
 * — the read-only emptiness probe behind the schema-0 backup carve-out.
 * Considers tables only (`sqlite_master`'s internal objects and indexes
 * are not user content).
 */
function hasNonJournalTables(database: DatabaseSync): boolean {
  const row = database
    .prepare(
      `SELECT 1 FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ?
       LIMIT 1`,
    )
    .get(MIGRATIONS_TABLE);
  return row !== undefined;
}
