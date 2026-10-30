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
 *
 * Task 081 (decision D-032) appends the first schema migration — the §11.2
 * `accounts` table — growing the canonical set and the supported schema
 * version to 1. Tasks 082–087 append theirs after it.
 *
 * Task 082 (decision D-034) appends the second schema migration — the §11.2
 * `collection_runs` table with its two spec-named indexes — growing the
 * supported schema version to 2. Tasks 083–087 append theirs after it.
 *
 * Task 083 (decision D-036) appends the third schema migration — the §11.2
 * `snapshots` header row with its spec-named account/time index and the
 * parent key its success-linkage foreign key needs — growing the supported
 * schema version to 3. Tasks 084–087 append theirs after it.
 *
 * Task 084 (decision D-039) appends the fourth schema migration — the §11.2
 * `metric_values` row per §8.4 metric with its spec-named series-access
 * index and the parent key its denormalization-pinning foreign key needs —
 * growing the supported schema version to 4. Tasks 085–087 append theirs
 * after it.
 *
 * Task 085 (decision D-046) appends the fifth schema migration — the §11.2
 * `quota_events` row per §12.1 reset event with its spec-named
 * account/metric/time index, the SQL-enforced JSON evidence contract for
 * `details`, and the parent key its account-pinning snapshot foreign key
 * needs — growing the supported schema version to 5. Tasks 086–087 append
 * theirs after it.
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
 * The `accounts` table (spec §11.2; task 081, decision D-032). One row per
 * monitored account, synced from configuration — the stable id, provider,
 * label, optional plan, and lifecycle every history table keys against:
 *
 * - **Id charsets in SQL.** `id` and `provider_id` carry the D-014 account-id
 *   charset `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` as CHECK constraints encoded
 *   with case-sensitive GLOB — first character alphanumeric, no character
 *   outside `[A-Za-z0-9_-]`, length 1–64, no embedded NUL (SQLite's GLOB and
 *   `length()` stop at NUL while the full bytes are stored, so the NUL guard
 *   is what makes the encoding exact). This CHECK is the charset gate for
 *   `provider_id`: configuration provider record keys are ID_PATTERN-bound
 *   (D-014), but the field that lands here — `accounts[].providerId` — is
 *   only `minLength: 1` in the configuration contract. A number bound for a
 *   TEXT id is affinity-rendered with a decimal point (`'123.0'`) before the
 *   CHECK runs, so numeric ids cannot slip through either.
 * - **Archive, not delete (§8.2).** `status` is the closed
 *   `active`/`archived` enum (§11.2 "constraints for enum values"), tied to
 *   `archived_at` by a composite CHECK: an archived account always carries
 *   its archive timestamp, an active one never does — the pair cannot drift.
 * - **Plan non-blank when present.** §8.4's `planName` is absent-or-non-blank
 *   at the domain boundary; `accounts_plan_nonempty` keeps the same three
 *   states here (NULL or non-empty, never `''`).
 * - **Named CHECK constraints.** SQLite reports a failed named constraint by
 *   name (`CHECK constraint failed: accounts_status`), which keeps violations
 *   self-explanatory in logs and precise in tests.
 * - **No credential columns.** Secrets stay in the config file (§11.1,
 *   §15.4); the structural guarantee is the exact pinned column set in
 *   `test/integration/accounts.spec.ts`.
 * - **No SQL-side defaults.** Timestamps are integer UTC epoch milliseconds
 *   (§11.1) supplied by the writer from the injected clock (D-021) — the
 *   journal's `applied_at` precedent — never computed by the database. The
 *   explicit `NOT NULL` on `id` closes SQLite's rowid-table quirk that would
 *   otherwise accept a NULL text primary key.
 */
const ACCOUNTS_MIGRATION: Migration = {
  name: '0001-accounts',
  up: ({ database }) => {
    database.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY NOT NULL,
        provider_id TEXT NOT NULL,
        label TEXT NOT NULL,
        plan_name TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        archived_at INTEGER,
        CONSTRAINT accounts_id_charset CHECK (
          id GLOB '[A-Za-z0-9]*'
          AND id NOT GLOB '*[^A-Za-z0-9_-]*'
          AND length(id) BETWEEN 1 AND 64
          AND instr(id, char(0)) = 0
        ),
        CONSTRAINT accounts_provider_charset CHECK (
          provider_id GLOB '[A-Za-z0-9]*'
          AND provider_id NOT GLOB '*[^A-Za-z0-9_-]*'
          AND length(provider_id) BETWEEN 1 AND 64
          AND instr(provider_id, char(0)) = 0
        ),
        CONSTRAINT accounts_label_nonempty CHECK (label <> ''),
        CONSTRAINT accounts_plan_nonempty CHECK (plan_name IS NULL OR plan_name <> ''),
        CONSTRAINT accounts_status CHECK (status IN ('active', 'archived')),
        CONSTRAINT accounts_archive_state CHECK (
          (status = 'active' AND archived_at IS NULL)
          OR (status = 'archived' AND archived_at IS NOT NULL)
        )
      ) STRICT;
    `);
  },
};

/**
 * The `collection_runs` table and its indexes (spec §11.2; task 082,
 * decision D-034). One row per polling cycle — successful or not (§11.1
 * "store a run record for every collection cycle, successful or
 * unsuccessful") — capturing what §7.2's retry/error behaviors must leave
 * behind:
 *
 * - **Synthetic id.** `id INTEGER PRIMARY KEY` — the rowid alias SQLite
 *   auto-assigns — is the run id §11.2's `snapshots` row references. No
 *   `AUTOINCREMENT`: §11.2 mandates cascading deletion consistently, so a
 *   deleted run's history dies with it and rowid recycling cannot create a
 *   stale reference. The auto-assigned id is the one database-generated
 *   value; it has no clock dependency, so the no-SQL-time rule holds.
 * - **Outcome enum = §7.2's outcome classes.** The closed §11.2 list maps
 *   the §7.2 failure rows exactly: network failure → `network_error`,
 *   timeout → `timeout`, HTTP 5xx → `server_error`, 429 → `rate_limited`,
 *   401/403 → `auth_error`, invalid payload → `parse_error`, plus
 *   `success`. The enum is the charset of §7.3's status vocabulary.
 * - **Ranges mirror the domain boundaries** (the D-032
 *   plan-nonempty precedent): `interval_seconds` carries §7.1's 60–3600
 *   valid range, `attempts >= 1` keeps §7.2's "total attempt count"
 *   (1 request plus up to 3 retries) a count and not a flag, and
 *   `retry_after_seconds` is NULL or within §7.2's one-hour cap. The
 *   attempt maximum is deliberately not encoded — it is poller retry
 *   policy, not a property of a recorded run.
 * - **Nullable evidence columns, uncoupled from the outcome.** `http_status`
 *   (NULL or a real 100–599 status) is absent when no response arrived and
 *   `retry_after_seconds` is absent when no `Retry-After` applies — a 429
 *   may legally arrive without the header. Binding either to specific
 *   outcomes would freeze provider/transport behavior (tasks 098+) into
 *   the on-disk contract; §7.2's mapping is the collector's to guarantee.
 * - **`error_message` stores already-sanitized text** (§7.2 "sanitized
 *   error information"): the redaction module is task 102's, storage only
 *   keeps the absent-or-non-blank shape, and `collection_runs_success_clean`
 *   keeps a successful run error-free — the one coupling §7.2 states
 *   outright (a failure may still lack a message, so it is one-directional).
 * - **No start/end ordering CHECK.** `ended_at >= started_at` was rejected
 *   for the same reason D-032 rejected `archived_at >= created_at`: both
 *   timestamps are wall-clock reads (§7.1) around one HTTP cycle, a clock
 *   correction between them is possible, and a rejected INSERT would lose
 *   the run record permanently — history tables must not turn skew into
 *   data loss. The interval and retry-after ranges are the timing-sanity
 *   checks this table carries.
 * - **Cascading account linkage.** `account_id` references `accounts(id)`
 *   with `ON DELETE CASCADE` — §11.2 "use cascading deletion consistently
 *   for purged account history" — and carries the D-014 charset CHECK
 *   (D-032's encoding, NUL guard included) so the id history rows key on is
 *   exactly the id `accounts` can hold. The `collection_runs_account_start`
 *   index's leading column serves the parent-delete scan; no extra
 *   foreign-key index is needed.
 */
const COLLECTION_RUNS_MIGRATION: Migration = {
  name: '0002-collection-runs',
  up: ({ database }) => {
    database.exec(`
      CREATE TABLE collection_runs (
        id INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        interval_seconds INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        http_status INTEGER,
        error_message TEXT,
        attempts INTEGER NOT NULL,
        retry_after_seconds INTEGER,
        CONSTRAINT collection_runs_account_charset CHECK (
          account_id GLOB '[A-Za-z0-9]*'
          AND account_id NOT GLOB '*[^A-Za-z0-9_-]*'
          AND length(account_id) BETWEEN 1 AND 64
          AND instr(account_id, char(0)) = 0
        ),
        CONSTRAINT collection_runs_outcome CHECK (
          outcome IN (
            'success', 'auth_error', 'rate_limited', 'network_error',
            'timeout', 'server_error', 'parse_error'
          )
        ),
        CONSTRAINT collection_runs_interval_range CHECK (interval_seconds BETWEEN 60 AND 3600),
        CONSTRAINT collection_runs_attempts_positive CHECK (attempts >= 1),
        CONSTRAINT collection_runs_http_status_range CHECK (
          http_status IS NULL OR http_status BETWEEN 100 AND 599
        ),
        CONSTRAINT collection_runs_retry_after_range CHECK (
          retry_after_seconds IS NULL
          OR (retry_after_seconds >= 0 AND retry_after_seconds <= 3600)
        ),
        CONSTRAINT collection_runs_error_nonempty CHECK (error_message IS NULL OR error_message <> ''),
        CONSTRAINT collection_runs_success_clean CHECK (
          outcome <> 'success' OR error_message IS NULL
        ),
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX collection_runs_account_start
        ON collection_runs (account_id, started_at);

      CREATE INDEX collection_runs_account_outcome_start
        ON collection_runs (account_id, outcome, started_at);
    `);
  },
};

/**
 * The `snapshots` table, its spec-named index, and the parent key its
 * success-linkage foreign key needs (spec §11.2; task 083, decision D-036).
 * One row per **successful** run (§11.1 "always store a snapshot for every
 * successful collection") — the §8.4 snapshot header: account, run id,
 * collection time, plan name. Metric values are task 084's table; the
 * repository is task 088's.
 *
 * - **Identity = the run.** `run_id` carries a plain `UNIQUE` constraint —
 *   the structural "at most one snapshot per run" — and deliberately **not**
 *   `INTEGER PRIMARY KEY`: verified on the pinned runtime, a NULL inserted
 *   into a NOT NULL rowid alias is silently replaced by a fresh auto-
 *   assigned id (attaching a snapshot to an arbitrary run), while a plain
 *   UNIQUE column rejects NULL. A synthetic snapshot id + `UNIQUE(run_id)`
 *   was rejected for the same cost D-034 avoided in `collection_runs`: a
 *   second identity no query references — task 084's metric rows and §11.2's
 *   event "snapshot id" key by the snapshot's run.
 * - **Success linkage via one composite foreign key.**
 *   `(account_id, run_id, run_outcome)` references
 *   `collection_runs (account_id, id, outcome)` — a parent key this
 *   migration exposes through the `collection_runs_account_id_outcome`
 *   unique index — with `snapshots_success_only` pinning the child's
 *   `run_outcome` to `'success'`. One constraint proves three §11.2
 *   properties: the run exists, it belongs to the same account, and it
 *   succeeded. The parent-side default (`ON UPDATE NO ACTION`) additionally
 *   freezes a referenced run's `outcome` and `account_id` against post-hoc
 *   UPDATEs — recorded history cannot be rewritten out from under a
 *   snapshot. A partial unique index (`WHERE outcome = 'success'`) cannot
 *   serve as an FK parent key in SQLite, and a trigger was rejected (no
 *   precedent in this schema, more on-disk objects, and totality over the
 *   INSERT/UPDATE paths of both tables to maintain).
 * - **`run_outcome` is the one column beyond §11.2's list** — a CHECK-bound
 *   constant carried solely so the composite FK can compare against the
 *   run's outcome. The D-032/D-034 exact-column-set rule bends only here,
 *   because no combination of the four listed columns can express "per
 *   successful run" (D-036).
 * - **Cascading linkage.** Both foreign keys cascade: deleting a run
 *   removes its snapshot; deleting an account removes its snapshots and
 *   runs (§11.2 "use cascading deletion consistently"; D-034 named this
 *   table's run cascade explicitly). `snapshots_account_time`'s leading
 *   column serves the account cascade scan — the D-034
 *   `collection_runs_account_start` precedent.
 * - **Charset and plan shape.** `account_id` carries the D-014 charset
 *   CHECK (D-032's GLOB encoding, NUL guard included) so history keys on
 *   exactly the ids `accounts` can hold; `plan_name` is absent-or-non-blank
 *   (§8.4's `planName` shape, the `accounts_plan_nonempty` precedent).
 * - **No SQL defaults, no cross-table time CHECKs.** `collected_at` is §11.1
 *   epoch milliseconds from the injected clock (D-021); ordering it against
 *   the run's timestamps was rejected for the clock-skew leniency D-032 and
 *   D-034 recorded (and CHECK constraints cannot span tables regardless).
 * - **Index naming.** `snapshots_account_time (account_id, collected_at)`
 *   follows D-034's spec-wording precedent ("runs by account/start" →
 *   `collection_runs_account_start`; "snapshots by account/time" → here).
 */
const SNAPSHOTS_MIGRATION: Migration = {
  name: '0003-snapshots',
  up: ({ database }) => {
    database.exec(`
      CREATE UNIQUE INDEX collection_runs_account_id_outcome
        ON collection_runs (account_id, id, outcome);

      CREATE TABLE snapshots (
        run_id INTEGER NOT NULL UNIQUE,
        account_id TEXT NOT NULL,
        collected_at INTEGER NOT NULL,
        plan_name TEXT,
        run_outcome TEXT NOT NULL,
        CONSTRAINT snapshots_account_charset CHECK (
          account_id GLOB '[A-Za-z0-9]*'
          AND account_id NOT GLOB '*[^A-Za-z0-9_-]*'
          AND length(account_id) BETWEEN 1 AND 64
          AND instr(account_id, char(0)) = 0
        ),
        CONSTRAINT snapshots_plan_nonempty CHECK (plan_name IS NULL OR plan_name <> ''),
        CONSTRAINT snapshots_success_only CHECK (run_outcome = 'success'),
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
        FOREIGN KEY (account_id, run_id, run_outcome)
          REFERENCES collection_runs (account_id, id, outcome) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX snapshots_account_time
        ON snapshots (account_id, collected_at);
    `);
  },
};

/**
 * The `metric_values` table, its spec-named series index, and the parent key
 * its denormalization-pinning foreign key needs (spec §11.2, §8.4; task 084,
 * decision D-039). One row per metric per snapshot — the persisted §8.4
 * `NormalizedMetric`, with account and collection time denormalized so
 * §11.2's series queries never join (§11.3's ≈52k-snapshots-per-account
 * scale). The typed repository is task 088's.
 *
 * - **Column set exactly §11.2's row.** The snapshot reference (`run_id` —
 *   the identity D-036 pinned: no query references a second metric-row id),
 *   the denormalized `account_id`/`collected_at`, then §8.4's fields:
 *   `metric_key`, `limit_type`, `unit`, `window_seconds`, the five quota
 *   values, `resets_at`, `is_valid`, `invalid_reason`, `derived_fields`.
 *   §8.4's `label` is deliberately absent — §11.2's row does not list it
 *   (labels are adapter/UI vocabulary, not history), the D-032 exact-set
 *   rule. `limit` is stored as `limit_value` because bare `limit` is an SQL
 *   keyword no unquoted statement can reference safely.
 * - **Enums are `src/schemas/metrics.ts` mirrored exactly** (D-010): the
 *   five `LIMIT_TYPES` and four `METRIC_UNITS` values, case-sensitive —
 *   adding an enum value stays a code change plus a migration (§8.4).
 * - **Quota values are REAL; metadata seconds and epochs are INTEGER.** The
 *   §8.4 boundary types all five quota fields as `number` and percentages
 *   are fractional by nature, so an INTEGER column would reject states the
 *   domain can produce — the D-032 identical-states rule. `window_seconds`
 *   (a duration, the D-034 `interval_seconds` precedent) and `resets_at`
 *   (§11.1 integer epoch ms) are integral by definition.
 * - **Validity invariants = §8.4/§11.2 stated properties.**
 *   `metric_values_valid_has_value`: a valid row carries at least one of the
 *   five quota values ("a valid metric row must include at least one usable
 *   numeric metric value"). `metric_values_invalid_clean`: an invalid row
 *   carries none of the five — NULL, never zero placeholders — while
 *   `window_seconds`/`resets_at` may be retained (D-010(2): a window length
 *   or reset schedule can remain known when a reading fails).
 *   `metric_values_invalid_reason` is one-directional — invalid requires a
 *   reason; a valid row's reason is unconstrained — the D-034
 *   `collection_runs_success_clean` pattern of encoding exactly what the
 *   spec states and nothing a writer merely happens to guarantee.
 * - **`derived_fields` is a 5-bit mask** over D-010's closed
 *   `DERIVED_METRIC_FIELDS` order (used=1, remaining=2, limit=4,
 *   percentUsed=8, percentRemaining=16): NULL = absent, 0 = empty set,
 *   0–31 = exactly the power set of the closed set. A set outside the
 *   closed list is unrepresentable — CHECKs cannot validate per-element
 *   membership of a JSON array (no subqueries), so a JSON encoding would
 *   have left the closed set a writer contract, the alternative D-036
 *   rejected for snapshots' success linkage. `metric_values_derived_present`
 *   additionally couples every set bit to its column's presence — D-010's
 *   "listed as derived but the field is not set" record invariant, in SQL
 *   (review finding); as a side effect an invalid row (all five quota
 *   columns NULL) can carry only the NULL or 0 mask. The repository
 *   (task 088) encodes/decodes; the assignment is on-disk contract.
 * - **Denormalization pinned by the D-036 composite-FK technique.**
 *   `(account_id, run_id, collected_at)` references
 *   `snapshots (account_id, run_id, collected_at)` `ON DELETE CASCADE` — a
 *   parent key this migration exposes through the `snapshots_account_run_time`
 *   unique index — so the copied account and time can never drift from their
 *   snapshot: one constraint proves the snapshot exists, the account
 *   matches, and the series time matches. The parent-side default (ON
 *   UPDATE NO ACTION) additionally freezes a referenced snapshot's identity
 *   against post-hoc UPDATEs. The direct `account_id → accounts` FK is kept
 *   alongside it, the D-036 both-foreign-keys shape: §11.2's "cascading
 *   deletion consistently" names the account path explicitly.
 * - **One metric per key per snapshot is structural**: `UNIQUE
 *   (run_id, metric_key)` — the storage face of §8.4's "keys are unique
 *   within a snapshot". Its autoindex (leading `run_id`) also serves the
 *   snapshot/run cascade scans, the D-034 one-index-two-jobs pattern.
 * - **No range CHECKs on `window_seconds`/`resets_at`.** The §8.4 boundary
 *   validates only finiteness for them (D-010); inventing bounds here would
 *   make storage reject states the domain can produce. Timing sanity ends
 *   at STRICT's integer typing and the FK-pinned epoch column.
 * - **No SQL defaults.** Every value is writer-supplied from validated
 *   normalized data (task 088 supplies clock timestamps, D-021).
 */
const METRIC_VALUES_MIGRATION: Migration = {
  name: '0004-metric-values',
  up: ({ database }) => {
    database.exec(`
      CREATE UNIQUE INDEX snapshots_account_run_time
        ON snapshots (account_id, run_id, collected_at);

      CREATE TABLE metric_values (
        run_id INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        collected_at INTEGER NOT NULL,
        metric_key TEXT NOT NULL,
        limit_type TEXT NOT NULL,
        unit TEXT NOT NULL,
        window_seconds INTEGER,
        used REAL,
        remaining REAL,
        limit_value REAL,
        percent_used REAL,
        percent_remaining REAL,
        resets_at INTEGER,
        is_valid INTEGER NOT NULL,
        invalid_reason TEXT,
        derived_fields INTEGER,
        CONSTRAINT metric_values_account_charset CHECK (
          account_id GLOB '[A-Za-z0-9]*'
          AND account_id NOT GLOB '*[^A-Za-z0-9_-]*'
          AND length(account_id) BETWEEN 1 AND 64
          AND instr(account_id, char(0)) = 0
        ),
        CONSTRAINT metric_values_metric_key_nonempty CHECK (metric_key <> ''),
        CONSTRAINT metric_values_limit_type CHECK (
          limit_type IN ('ROLLING_WINDOW', 'DAILY', 'WEEKLY', 'MONTHLY', 'OTHER')
        ),
        CONSTRAINT metric_values_unit CHECK (
          unit IN ('TOKENS', 'CREDITS', 'REQUESTS', 'PERCENT')
        ),
        CONSTRAINT metric_values_valid_flag CHECK (is_valid IN (0, 1)),
        CONSTRAINT metric_values_valid_has_value CHECK (
          is_valid = 0
          OR used IS NOT NULL
          OR remaining IS NOT NULL
          OR limit_value IS NOT NULL
          OR percent_used IS NOT NULL
          OR percent_remaining IS NOT NULL
        ),
        CONSTRAINT metric_values_invalid_clean CHECK (
          is_valid = 1
          OR (
            used IS NULL
            AND remaining IS NULL
            AND limit_value IS NULL
            AND percent_used IS NULL
            AND percent_remaining IS NULL
          )
        ),
        CONSTRAINT metric_values_invalid_reason CHECK (
          is_valid = 1 OR invalid_reason IS NOT NULL
        ),
        CONSTRAINT metric_values_invalid_reason_nonempty CHECK (
          invalid_reason IS NULL OR invalid_reason <> ''
        ),
        CONSTRAINT metric_values_derived_fields_range CHECK (
          derived_fields IS NULL OR derived_fields BETWEEN 0 AND 31
        ),
        CONSTRAINT metric_values_derived_present CHECK (
          derived_fields IS NULL
          OR (
            ((derived_fields & 1) = 0 OR used IS NOT NULL)
            AND ((derived_fields & 2) = 0 OR remaining IS NOT NULL)
            AND ((derived_fields & 4) = 0 OR limit_value IS NOT NULL)
            AND ((derived_fields & 8) = 0 OR percent_used IS NOT NULL)
            AND ((derived_fields & 16) = 0 OR percent_remaining IS NOT NULL)
          )
        ),
        UNIQUE (run_id, metric_key),
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
        FOREIGN KEY (account_id, run_id, collected_at)
          REFERENCES snapshots (account_id, run_id, collected_at) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX metric_values_series_access
        ON metric_values (account_id, metric_key, collected_at);
    `);
  },
};

/**
 * The `quota_events` table, its spec-named index, and the parent key its
 * account-pinning snapshot foreign key needs (spec §11.2, §12.1; task 085,
 * decision D-046). One row per recorded quota event — `RESET` in version 1
 * (§11.2) — written in the same transaction as the snapshot that produced
 * it (§11.1). Reset **detection** is tasks 117/118's; the repository is
 * 088's; this is only the storage shape.
 *
 * - **Column set exactly §11.2's row** — the account reference, the metric
 *   key (the same non-empty string semantics as `metric_values.metric_key`;
 *   §11.2 lists no window or enum columns for events, and the D-032
 *   exact-set rule keeps them out — window evidence belongs in `details`),
 *   the event type, the event time, the optional snapshot reference, and
 *   the JSON details. Names refined per §11.2's "may refine physical
 *   details": `event_type` (the spec's "type", qualified the way
 *   `accounts.status` and `collection_runs.outcome` carry their spec words
 *   — a bare `type` column reads as `sqlite_master.type` in ad-hoc SQL),
 *   `event_at` (the house `_at` suffix, §11.1 epoch milliseconds).
 * - **Event time follows §12.1's rule and is deliberately its own value** —
 *   either the previous point's `resetsAt` (it lay between the two
 *   snapshots) or the new snapshot's collection time. It is writer-supplied
 *   from the injected clock's data (D-021, no SQL default) and is not
 *   pinned to the referenced snapshot's `collected_at`: the two legitimately
 *   differ, and cross-table CHECKs are impossible anyway (the D-032/D-034
 *   clock-skew leniency).
 * - **The snapshot reference is the D-036 identity (`run_id`), nullable.**
 *   §11.2 says "optional snapshot id"; in practice every v1 RESET event has
 *   an evidence snapshot (§12.1 detects on a new one), but the column keeps
 *   the spec's optionality — no presence CHECK (the D-034 rule of encoding
 *   exactly what the spec states). It references the snapshot the new point
 *   came from, not the historical previous point.
 * - **`details` carries §12.1's detection evidence as a JSON object** — the
 *   SQL-enforced audit minimum is the trio every reset event is meaningless
 *   without: `$.reason` (non-empty text — which §12.1 condition fired and
 *   any conservative-approach exception; a free string, not a CHECK enum,
 *   because the reason vocabulary is detection policy, not a stated record
 *   property) and the compared points `$.previous`/`$.current` (objects —
 *   §12.1's "compare each new snapshot with the previous **valid** point").
 *   `quota_events_details_json` is declared first so malformed JSON fails
 *   there by name before the shape checks' `json_type` would throw; the
 *   shape checks reject JSON the domain cannot produce (scalars, arrays, a
 *   missing or blank reason, missing points). The path checks coalesce a
 *   missing key's NULL `json_type` to a mismatch — in SQLite a NULL CHECK
 *   result passes, so the plain `= 'text'` form would admit an absent
 *   reason (verified on the pinned runtime). The deeper vocabulary —
 *   camelCase point fields (`runId`, `collectedAt`, `used`, `resetsAt`, …),
 *   `tolerance`, `eventTimeSource` — is the D-046 writer contract the
 *   repository (088) encodes and the detector (117/118) produces; CHECKs
 *   cannot validate per-key membership of arbitrary objects, the same
 *   limitation that made D-039 reject JSON for `derived_fields`.
 * - **Account/snapshot linkage = the D-036/D-039 both-foreign-keys shape.**
 *   `(account_id, run_id)` references `snapshots (account_id, run_id)` — a
 *   parent key this migration exposes through the `snapshots_account_run`
 *   unique index — so an event can never claim an account its snapshot does
 *   not belong to: one constraint proves the snapshot exists and the account
 *   matches, and the parent-side default (ON UPDATE NO ACTION) freezes a
 *   referenced snapshot's identity against post-hoc UPDATEs. The direct
 *   `account_id → accounts` FK stays alongside it; §11.2 names the account
 *   path of the consistent cascade policy explicitly. A NULL `run_id`
 *   satisfies the composite FK (SQLite treats any NULL child key as
 *   satisfied) while the direct FK still proves the account exists.
 * - **Cascading linkage mirrors 082–084.** Deleting an account removes its
 *   events (both FK paths — §8.2 purge); deleting a run removes its
 *   snapshot and with it the events that referenced it; archiving an
 *   account is an UPDATE and retains history (§8.2). The index's leading
 *   `account_id` serves both cascade scans — the D-034
 *   one-index-two-jobs pattern; no extra foreign-key index.
 * - **No primary key, no UNIQUE constraint.** No query references an event
 *   id (§13 returns event lists), so none is minted — the D-036/D-039
 *   no-second-identity rule; and §12.1 states no per-snapshot uniqueness
 *   for events, so none is invented. Duplicate prevention is the writer's
 *   (one comparison per metric per snapshot, task 117).
 * - **Index naming.** `quota_events_account_metric_time
 *   (account_id, metric_key, event_at)` is §11.2's "events by
 *   account/metric/time" wording, named the D-034 way.
 */
const QUOTA_EVENTS_MIGRATION: Migration = {
  name: '0005-quota-events',
  up: ({ database }) => {
    database.exec(`
      CREATE UNIQUE INDEX snapshots_account_run
        ON snapshots (account_id, run_id);

      CREATE TABLE quota_events (
        account_id TEXT NOT NULL,
        metric_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_at INTEGER NOT NULL,
        run_id INTEGER,
        details TEXT NOT NULL,
        CONSTRAINT quota_events_account_charset CHECK (
          account_id GLOB '[A-Za-z0-9]*'
          AND account_id NOT GLOB '*[^A-Za-z0-9_-]*'
          AND length(account_id) BETWEEN 1 AND 64
          AND instr(account_id, char(0)) = 0
        ),
        CONSTRAINT quota_events_metric_key_nonempty CHECK (metric_key <> ''),
        CONSTRAINT quota_events_type CHECK (event_type IN ('RESET')),
        CONSTRAINT quota_events_details_json CHECK (json_valid(details)),
        CONSTRAINT quota_events_details_object CHECK (json_type(details) = 'object'),
        CONSTRAINT quota_events_details_reason CHECK (
          coalesce(json_type(details, '$.reason'), '') = 'text'
          AND json_extract(details, '$.reason') <> ''
        ),
        CONSTRAINT quota_events_details_points CHECK (
          coalesce(json_type(details, '$.previous'), '') = 'object'
          AND coalesce(json_type(details, '$.current'), '') = 'object'
        ),
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
        FOREIGN KEY (account_id, run_id)
          REFERENCES snapshots (account_id, run_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX quota_events_account_metric_time
        ON quota_events (account_id, metric_key, event_at);
    `);
  },
};

/**
 * The application's canonical migration set (§11.4, D-031): the one ordered
 * list the composition root hands to {@link createMigrationRunner}, grown by
 * one entry per schema change — `0001-accounts` since task 081 (D-032),
 * `0002-collection-runs` since task 082 (D-034), `0003-snapshots` since
 * task 083 (D-036), `0004-metric-values` since task 084 (D-039),
 * `0005-quota-events` since task 085 (D-046); tasks 086–087 append theirs
 * after it. The journal table itself comes from the storage adapter, not
 * from a migration.
 */
export const MIGRATIONS: ReadonlyArray<Migration> = [
  ACCOUNTS_MIGRATION,
  COLLECTION_RUNS_MIGRATION,
  SNAPSHOTS_MIGRATION,
  METRIC_VALUES_MIGRATION,
  QUOTA_EVENTS_MIGRATION,
];

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
