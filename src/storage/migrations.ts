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
 *
 * Task 080 (decision D-031) adds the metadata layer on top of the journal —
 * the version semantics §11.4 demands beyond raw bookkeeping, without a
 * second journal: versioned names (`0001-…`), a canonical migration set, a
 * read-only applied-migrations query, and the schema-version status
 * (`up-to-date` / `behind` / `newer`) the startup wiring and task 092's
 * newer-schema refusal consume.
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

/**
 * The schema-version currency (D-031): a migration name is
 * `<version>-<description>`, where the version prefix is 1–8 ASCII digits
 * (sequential `0001-…` and date `20261030-…` conventions both fit; the cap
 * keeps `Number` parsing exact) and the description is non-blank.
 */
const VERSIONED_NAME = /^(\d{1,8})-(\S.*)$/;

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
   * Unique, non-blank migration name: `<version>-<description>` with a 1–8
   * digit version prefix (D-031; see {@link migrationVersion}). The runner
   * orders the migration list by name, so names must sort in the order the
   * schema requires, and versions must strictly increase in that order
   * (zero-prefixed names, e.g. `0007-add-quota-events`, satisfy both).
   */
  readonly name: string;
  /** Applies the migration inside the runner's transaction. */
  up(context: MigrationContext): Promise<void> | void;
}

/** Options for {@link createMigrationRunner}. */
export interface MigrationRunnerOptions {
  /** An open database; the runner never opens or closes it. */
  readonly database: DatabaseSync;
  /** The migration list — for the application, the canonical {@link MIGRATIONS}. */
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
   * §11.4) does not appear here — {@link appliedMigrations} exposes the raw
   * journal and {@link schemaVersionStatus} interprets it.
   */
  executed(): Promise<ReadonlyArray<string>>;
}

/** Options for {@link createMigrationStorage}. */
export interface MigrationStorageOptions {
  readonly database: DatabaseSync;
  /** Timestamp source for journal entries; defaults to the system clock. */
  readonly clock?: Clock;
}

/** One journal row: a migration that was applied, and when (§11.4). */
export interface AppliedMigration {
  /** The migration's name as recorded — not necessarily known to this app. */
  readonly name: string;
  /** When the migration was recorded: integer UTC epoch milliseconds (§11.1). */
  readonly appliedAt: number;
}

/**
 * How the database's schema relates to what the running application supports
 * (§11.4): `'up-to-date'`, `'behind'` (pending migrations — startup applies
 * them), or `'newer'` (the journal records a schema newer than this
 * application supports — task 092 refuses to start on it).
 */
export type SchemaVersionRelation = 'up-to-date' | 'behind' | 'newer';

/** The §11.4 version-check answer (see {@link schemaVersionStatus}). */
export interface SchemaVersionStatus {
  /** The version the given migration set supports; 0 for an empty set. */
  readonly supportedVersion: number;
  /** The highest version recorded in the journal; 0 when nothing is applied. */
  readonly appliedVersion: number;
  readonly relation: SchemaVersionRelation;
  /**
   * Journal rows whose version exceeds {@link supportedVersion} — the
   * evidence a `newer` relation is built on (task 092's refusal message).
   */
  readonly newerThanSupported: ReadonlyArray<AppliedMigration>;
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
  // journal table in a database the caller may not use after all. Since task
  // 080 this includes the version rules (D-031): every set the runner may
  // apply is version-coherent in application order, not just the sets that
  // happen to pass a schemaVersionStatus check.
  const ordered = validatedSet(migrations);

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

/* ── Migration metadata (task 080) ─────────────────────────────────────── */

/**
 * The schema version of a migration name: the numeric `<version>-` prefix
 * (D-031). Throws on names that are not `<version>-<description>` with a
 * 1–8 digit prefix — including journal rows a database may carry from a
 * foreign or future writer, which must surface instead of silently reading
 * as version 0.
 */
export function migrationVersion(name: string): number {
  const match = VERSIONED_NAME.exec(name);
  if (match === null) {
    throw new Error(
      `migration name '${name}' must be <version>-<description> with a 1-8 digit version prefix`,
    );
  }
  const version = Number(match[1]);
  if (version < 1) {
    // Version 0 is reserved for "nothing applied yet" — the empty journal.
    throw new Error(`migration name '${name}' has version 0; versions start at 1`);
  }
  return version;
}

/**
 * The application's canonical migration set (§11.4, D-031): the one ordered
 * list the composition root hands to {@link createMigrationRunner}, grown by
 * one entry per schema change. Empty at task 080 — the journal table comes
 * from the storage adapter, not from a migration, so no schema-changing
 * migration exists yet; tasks 081–087 append the table migrations here.
 */
export const MIGRATIONS: ReadonlyArray<Migration> = [];

/**
 * The schema version the given migration set supports — its newest
 * migration's version, `0` for an empty set. Validates the set first
 * (078's checks plus the version rules), like every version consumer.
 */
export function supportedSchemaVersion(migrations: ReadonlyArray<Migration>): number {
  return lastVersion(validatedSet(migrations));
}

/**
 * Every journal row, in name order, as `{ name, appliedAt }` — the raw
 * §11.4 bookkeeping, including entries the running application does not
 * know (a newer schema; 078's `executed()` deliberately filters those out).
 * Read-only: never creates the journal table, so a database nothing has
 * migrated yet simply reports no rows.
 */
export function appliedMigrations(database: DatabaseSync): ReadonlyArray<AppliedMigration> {
  const tableExists = database
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(MIGRATIONS_TABLE);
  if (tableExists === undefined) {
    return [];
  }
  const rows = database
    .prepare(`SELECT name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY name ASC`)
    .all() as Array<{ name: string; applied_at: number }>;
  return rows.map((row) => {
    // A journal this application did not write (§11.4's newer schema, or a
    // corrupt one) could carry a TEXT or NULL applied_at; evidence columns
    // fail fast like names do, instead of flowing out as a fake number.
    if (!Number.isInteger(row.applied_at)) {
      throw new Error(
        `journal row '${row.name}' has a non-integer applied_at (${String(row.applied_at)})`,
      );
    }
    return { name: row.name, appliedAt: row.applied_at };
  });
}

/**
 * Answers §11.4's version check for one database against one migration set:
 * what the application supports, what the database has applied, how they
 * relate, and — when the relation is `'newer'` — the journal rows proving
 * it. Task 092 turns `'newer'` into a refusal to start; the startup wiring
 * applies migrations while the relation is `'behind'`. A journal row with a
 * malformed name throws rather than passing as version 0.
 */
export function schemaVersionStatus(
  database: DatabaseSync,
  migrations: ReadonlyArray<Migration>,
): SchemaVersionStatus {
  const ordered = validatedSet(migrations);
  const supportedVersion = lastVersion(ordered);
  const applied = appliedMigrations(database);
  const appliedNames = new Set(applied.map((entry) => entry.name));

  let appliedVersion = 0;
  const newerThanSupported: AppliedMigration[] = [];
  for (const entry of applied) {
    const version = migrationVersion(entry.name);
    appliedVersion = Math.max(appliedVersion, version);
    if (version > supportedVersion) {
      newerThanSupported.push(entry);
    }
  }

  // Version maxima decide 'newer'; name membership decides the rest — a set
  // migration missing from the journal means work is pending even when the
  // applied version already equals the supported one.
  const upToDate = ordered.every((migration) => appliedNames.has(migration.name));
  const relation: SchemaVersionRelation =
    appliedVersion > supportedVersion ? 'newer' : upToDate ? 'up-to-date' : 'behind';

  return { supportedVersion, appliedVersion, relation, newerThanSupported };
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

/** Copies the list ordered by name — the application order (see `Migration`). */
function orderByName(migrations: ReadonlyArray<Migration>): Migration[] {
  // Default string comparison (code-unit order), matching how Umzug sorts
  // file-based migrations — not locale-sensitive `localeCompare`.
  return [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Orders and fully validates a migration list: 078's wiring checks, then the
 * D-031 version rules. Every version consumer (the runner included) goes
 * through this, so no code path can observe a set whose application order
 * disagrees with its version order.
 */
function validatedSet(migrations: ReadonlyArray<Migration>): Migration[] {
  const ordered = orderByName(migrations);
  validateMigrations(ordered);
  validateVersionedSet(ordered);
  return ordered;
}

/** Version of the newest migration in application order; 0 for an empty set. */
function lastVersion(ordered: ReadonlyArray<Migration>): number {
  const last = ordered.at(-1);
  return last === undefined ? 0 : migrationVersion(last.name);
}

/**
 * The D-031 version rules: in application (name) order, versions must
 * strictly increase — which also makes them unique and keeps D-027's name
 * ordering coherent with numeric version order (equal-width zero-padded
 * prefixes satisfy it by construction; `10-…` before `9-…` does not).
 */
function validateVersionedSet(ordered: ReadonlyArray<Migration>): void {
  let previous = 0;
  for (const migration of ordered) {
    const version = migrationVersion(migration.name);
    if (version <= previous) {
      throw new Error(
        `migration versions must strictly increase in application order: ` +
          `'${migration.name}' (version ${version}) does not follow version ${previous}`,
      );
    }
    previous = version;
  }
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
