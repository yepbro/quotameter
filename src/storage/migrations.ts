/**
 * Forward-only migration harness over the built-in `node:sqlite` driver
 * (spec §3, §11.4; task 078, decision D-027).
 *
 * Task 078's verification: the spec-preferred library (Umzug) drives
 * migrations applied to a `DatabaseSync`, with every applied migration
 * recorded in a journal table inside the database itself — "tracked in the
 * database" (§11.4) — and re-runs becoming no-ops because the recorded state
 * is respected. This module is the reusable harness the table migrations of
 * tasks 080–087 grow into the real migration set:
 *
 * - **Injected migration list.** Migrations arrive as code —
 *   `createMigrationRunner({ database, migrations })` — never as files, so
 *   the compiled package (spec §3 packaging: no install-time build steps)
 *   carries them. The runner orders them by name (Umzug sorts glob inputs
 *   but not injected arrays) and rejects blank/duplicate names and
 *   non-function `up` at construction, the D-013 wiring-check style.
 * - **Atomic apply + record.** `up()` runs one `BEGIN IMMEDIATE` … `COMMIT`
 *   transaction per migration, wrapping Umzug's per-name slice so that the
 *   migration body and the journal insert commit together. A failure at any
 *   point — bad DDL, a throwing migration, or a failing journal write —
 *   rolls the whole migration back and leaves it pending for the next run:
 *   "applied but unrecorded" and "recorded but not applied" are unreachable.
 *   The interrupted-operation standard of D-016, applied to schema changes.
 * - **Forward-only.** The runner exposes `up`/`pending`/`executed` only;
 *   no `down` path exists (spec §3). The storage adapter implements
 *   `unlogMigration` solely to satisfy Umzug's storage contract.
 * - **No connection ownership.** The caller supplies the `DatabaseSync`;
 *   connection creation and the §11.1 pragmas belong to task 079, and
 *   migrations run under the single-instance lock (D-017) at startup.
 *   Backups (`VACUUM INTO`) and newer-schema refusal are task 092's.
 */

import type { DatabaseSync } from 'node:sqlite';
import { Umzug, type UmzugStorage } from 'umzug';
import { createSystemClock, type Clock } from '../util/clock';

/**
 * The journal table every applied migration is recorded in (spec §11.2
 * "migration metadata", §11.4 "tracked in the database"). Part of the on-disk
 * contract: renaming it would strand existing databases.
 */
export const MIGRATIONS_TABLE = 'schema_migrations';

/* ── Types ─────────────────────────────────────────────────────────────── */

/**
 * What a migration may act on: the caller's database. The runner wraps every
 * migration in an open transaction, so migrations must issue their statements
 * through this connection and must never manage transactions themselves.
 */
export interface MigrationContext {
  /** The database being migrated; statements join the runner's transaction. */
  readonly database: DatabaseSync;
}

/** One forward migration. Names sort lexicographically in application order. */
export interface Migration {
  /**
   * Unique, non-blank migration name. The runner orders the migration list
   * by name, so names must sort in the order the schema requires (zero- or
   * date-prefixed names, e.g. `0007-add-quota-events`).
   */
  readonly name: string;
  /** Applies the migration inside the runner's transaction. */
  up(context: MigrationContext): Promise<void> | void;
}

/** Options for {@link createMigrationRunner}. */
export interface MigrationRunnerOptions {
  /** An open database; the runner never opens or closes it. */
  readonly database: DatabaseSync;
  /** The migration list tasks 080+ maintain as code. */
  readonly migrations: ReadonlyArray<Migration>;
  /**
   * Source of `applied_at` timestamps (D-021); defaults to the system clock.
   * The composition root passes its shared clock; tests inject a fixed one.
   */
  readonly clock?: Clock;
}

/** The public harness surface: forward-only by construction. */
export interface MigrationRunner {
  /**
   * Applies every pending migration, one transaction each, and resolves with
   * the applied names in application order. A no-op (empty result) when the
   * journal already records every migration.
   */
  up(): Promise<ReadonlyArray<string>>;
  /** Names of not-yet-applied migrations, in application order. */
  pending(): Promise<ReadonlyArray<string>>;
  /**
   * Names of applied migrations from the injected list, in name order. A
   * journal entry for a migration unknown to this runner (a newer schema,
   * §11.4) does not appear here — the raw journal is task 092's territory.
   */
  executed(): Promise<ReadonlyArray<string>>;
}

/** Options for {@link createMigrationStorage}. */
export interface MigrationStorageOptions {
  readonly database: DatabaseSync;
  /** Timestamp source for journal entries; defaults to the system clock. */
  readonly clock?: Clock;
}

/* ── Storage adapter ───────────────────────────────────────────────────── */

/**
 * Umzug's storage contract over the built-in driver: the journal table in the
 * database being migrated (spec §11.4). Safe standalone — each method is a
 * plain statement — but the atomic migration-plus-entry pairing comes from
 * {@link createMigrationRunner}'s transactions; without them, a standalone
 * insert commits on its own.
 */
export function createMigrationStorage(options: MigrationStorageOptions): UmzugStorage {
  const { database, clock = createSystemClock() } = options;
  ensureJournalTable(database);
  return {
    async logMigration({ name }) {
      // Plain INSERT: a duplicate name violates the primary key loudly
      // instead of silently re-recording an entry.
      database
        .prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`)
        .run(name, clock.now());
    },
    async unlogMigration({ name }) {
      // Present to satisfy Umzug's storage contract; the forward-only runner
      // never triggers it (spec §3).
      database.prepare(`DELETE FROM ${MIGRATIONS_TABLE} WHERE name = ?`).run(name);
    },
    async executed() {
      const rows = database
        .prepare(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name ASC`)
        .all() as Array<{ name: string }>;
      return rows.map((row) => row.name);
    },
  };
}

/** Creates the journal table if the database does not have it yet. */
function ensureJournalTable(database: DatabaseSync): void {
  // STRICT (spec §11.2 "strict tables where feasible"): name stays TEXT and
  // applied_at stays INTEGER; timestamps are UTC epoch milliseconds (§11.1).
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);
}

/* ── Runner ────────────────────────────────────────────────────────────── */

/** Creates the forward-only migration harness for one open database. */
export function createMigrationRunner(options: MigrationRunnerOptions): MigrationRunner {
  const { database, migrations, clock } = options;
  // Validate before touching the database: bad wiring must not create the
  // journal table in a database the caller may not use after all.
  const ordered = orderByName(migrations);
  validateMigrations(ordered);

  const umzug = new Umzug<MigrationContext>({
    migrations: ordered.map((migration) => ({
      name: migration.name,
      up: async ({ context }) => migration.up(context),
    })),
    context: { database },
    storage: createMigrationStorage({ database, clock }),
    // Umzug's option type requires an explicit logger; `undefined` keeps the
    // harness silent — the storage layer never writes to stdout/stderr
    // (spec §15.4, §16).
    logger: undefined,
  });

  return {
    async up() {
      const applied: string[] = [];
      for (const pending of await umzug.pending()) {
        // One transaction per migration around Umzug's per-name slice: the
        // migration body and the journal insert it triggers commit together
        // (or vanish together on any failure). BEGIN IMMEDIATE takes the
        // write lock up front rather than mid-migration.
        database.exec('BEGIN IMMEDIATE');
        try {
          await umzug.up({ migrations: [pending.name] });
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        applied.push(pending.name);
      }
      return applied;
    },
    async pending() {
      return (await umzug.pending()).map((migration) => migration.name);
    },
    async executed() {
      return (await umzug.executed()).map((migration) => migration.name);
    },
  };
}

/** Copies the list ordered by name — the application order (see `Migration`). */
function orderByName(migrations: ReadonlyArray<Migration>): Migration[] {
  // Default string comparison (code-unit order), matching how Umzug sorts
  // file-based migrations — not locale-sensitive `localeCompare`.
  return [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Fail-fast checks on the injected list (the D-013 wiring-check style). */
function validateMigrations(migrations: ReadonlyArray<Migration>): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (typeof migration.name !== 'string' || migration.name.trim() === '') {
      throw new Error(
        `migration names must be non-blank strings (got '${String(migration.name)}')`,
      );
    }
    if (typeof migration.up !== 'function') {
      throw new Error(`migration '${migration.name}' has no up() function`);
    }
    if (seen.has(migration.name)) {
      throw new Error(`duplicate migration name '${migration.name}'`);
    }
    seen.add(migration.name);
  }
}
