# `src/storage/` — the only database access layer

All `node:sqlite` access is isolated here (spec §3, §11): the connection and
pragmas (079), forward-only migrations with backups (078, 080–092), and
`QuotaRepository` — the typed facade the application consumes (088). Rows are
mapped to typed domain records from `src/schemas/` before leaving this layer.

**Rule:** may import only `src/schemas/` and `src/util/`. No SQL is issued
anywhere else; `QuotaRepository` satisfies the §8.1 "core services" list as
the storage layer's public facade (decision D-009).

## `migrations.ts` — forward-only migration harness (spec §3, §11.4, decision D-027)

Task 078's verification artifact, grown into the harness tasks 080–087 build
the real migration set on. The spec-preferred library (Umzug) drives
migrations over the built-in `node:sqlite` driver through a storage adapter
that records every applied migration in the journal table inside the database
itself — "tracked in the database" (§11.4).

**Surface.** `createMigrationRunner({ database, migrations, clock? })` →
`{ up(), pending(), executed() }`. There is deliberately no `down`:
migrations are forward-only (§3).

- **Migrations are injected as code** — `ReadonlyArray<{ name, up(context) }>`
  with a `MigrationContext` exposing the caller's `DatabaseSync`. No files,
  no globs: the compiled package carries the list. Names order the set
  lexicographically (zero- or date-prefixed, e.g. `0007-add-quota-events`),
  and construction rejects blank/duplicate names and a missing `up`
  (D-013 wiring-check style) before the database is touched.
- **Journal.** `schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER
NOT NULL) STRICT` — exported as `MIGRATIONS_TABLE`; the name is part of the
  on-disk contract. Timestamps are integer UTC epoch milliseconds (§11.1).
  A duplicate record fails loudly on the primary key, never silently.
- **Atomic apply + record.** `up()` wraps each migration in
  `BEGIN IMMEDIATE` … `COMMIT` around Umzug's per-name slice, so the
  migration body and its journal entry commit together. Any failure — bad
  DDL, a throwing migration, a failing journal write — rolls the migration
  back whole and leaves it pending for the next run; "applied but unrecorded"
  and "recorded but not applied" are unreachable (the D-016
  interrupted-write standard, applied to schema changes).
- **Recorded state is respected.** Re-runs are no-ops; `pending()` and
  `executed()` answer the §11.4 state questions the startup wiring and the
  newer-schema refusal (task 092) need.
- **Seams.** The runner owns no connection — task 079 supplies the
  `DatabaseSync` with the §11.1 pragmas (`WAL`, `busy_timeout`, …) — and
  takes the D-021 `Clock` for deterministic `applied_at` (tests inject a
  fixed clock; the composition root passes its shared system clock).
  `createMigrationStorage` is the standalone adapter for tooling that needs
  raw journal operations; the atomic pairing lives in the runner.

**Conventions for migration authors (tasks 080+).** Migrations must issue
their statements through `context.database` only and must never open their
own transactions — the runner's transaction wraps them; a `BEGIN` inside it
fails loudly. In practice migrations run once at startup under the
single-instance lock (D-017), so journal contention is not a concern.

**Explicitly out of scope here:** the §11.4 backup before migrations
(`VACUUM INTO`, three-generation retention) and the refuse-to-start check for
a schema newer than the application — both task 092; the application tables
themselves — tasks 080–087.

Importing `node:sqlite` prints an `ExperimentalWarning` on Node 22 — expected,
not an error (docs/agents/gotchas.md; spec §3).

## `connection.ts` — the §11.1 database connection (task 079, decision D-030)

`openStorageConnection({ dataDir })` opens
`<data>/quotameter.sqlite` (`databaseFilePath(dataDir)`; `DATABASE_FILENAME`
is part of the on-disk contract) and returns a closeable handle:

- **`database`** — the configured `DatabaseSync`; this is the D-027 seam the
  migration runner and the future repository (task 088) consume.
- **Pragmas (§11.1)** are applied as statements and verified by readback:
  `busy_timeout=5000` first (so engaging WAL on a busy existing file waits
  instead of failing), then `journal_mode=WAL`, `synchronous=NORMAL`,
  `foreign_keys=ON`. A database that cannot hold a required setting refuses
  to open — `:memory:` silently keeps `journal_mode=memory`, and without the
  readback that would degrade into a non-WAL database. A corrupt or
  non-SQLite file at the path (the driver's constructor reads the header
  lazily, so it passes) first fails inside pragma application; every
  configuration-time failure — open, driver error mid-pragma, refused
  setting — carries the full path and the original error as `cause`. The
  optional `openDatabase` seam exists so tests can prove the refusals;
  production callers never pass it.
- **`close()` is idempotent** — a repeated call, or one that follows a direct
  `database.close()` by a consumer, is tolerated instead of throwing
  `ERR_INVALID_STATE` (Node 22.13 has no `isOpen` on the handle, so the
  wrapper tracks openness itself). `isOpen` reports the tracked state.
- **No directory creation.** The startup path creates the data directory
  when acquiring the single-instance lock (task 074); a missing parent is
  reported loudly with the full path and the original error as `cause`.

The data directory arrives already resolved by `src/config/paths.ts` (task 063) — storage never re-resolves XDG paths (it may not import `src/config/`;
see the layer rules above).

## Migration metadata and version checks (task 080, spec §11.4, decision D-031)

On top of the 078 journal — without duplicating it — `migrations.ts` carries
the version semantics the startup wiring and task 092 consume:

- **Versioned names.** Every migration name is `<version>-<description>` — a
  1–8 digit prefix (sequential `0001-…` or date `20261030-…`) and a
  non-blank description; the parser rejects version 0, which is reserved
  for "nothing applied yet". `migrationVersion(name)` parses it and throws
  on malformed names. Sets — the runner's injected list included — must
  have **strictly increasing versions in application (name) order**, so
  D-027's name ordering is always version-coherent; violations fail at
  construction, before the database is touched.
- **Canonical set.** `MIGRATIONS` is the application's one migration list —
  empty at task 080 (the journal table comes from the storage adapter, not
  from a migration); tasks 081–087 append entries. `supportedSchemaVersion(set)`
  is the version the running application supports (0 for the empty set).
- **Journal reads.** `appliedMigrations(database)` returns every journal row
  `{ name, appliedAt }` in name order — including entries the running
  application does not know, which is exactly the newer-schema evidence
  §11.4's refusal needs (078's `executed()` deliberately filters those out).
  The read is read-only: it never creates the journal table, and a
  non-integer `applied_at` (a journal this app did not write) throws.
- **Version check.** `schemaVersionStatus(database, migrations)` answers
  §11.4's comparison: `supportedVersion`, `appliedVersion`, `relation`
  (`'up-to-date'` / `'behind'` — apply pending at startup — / `'newer'` —
  task 092 refuses to start), and `newerThanSupported`, the refusal's
  evidence. Version maxima decide `'newer'`; a set migration missing from
  the journal means `'behind'` even at equal versions. A journal row with a
  malformed name throws instead of silently reading as version 0.

The schema tables themselves are tasks 081–087; backups (`VACUUM INTO`,
retention) and the refuse-to-start behavior remain task 092, which builds
them on `appliedMigrations()` and `schemaVersionStatus()`.

## The `accounts` table — migration `0001-accounts` (task 081, spec §11.2, decision D-032)

The first entry of the canonical `MIGRATIONS` list (schema version 1). One
row per monitored account, synced from configuration — the stable id,
provider, label, optional plan, and lifecycle every later history table keys
against. The schema is exercised directly in
`test/integration/accounts.spec.ts`; the typed data access is task 088's
repository.

| Column        | Type      | Rules                                                                  |
| ------------- | --------- | ---------------------------------------------------------------------- |
| `id`          | `TEXT`    | `PRIMARY KEY`, `NOT NULL`, `accounts_id_charset` (D-014 charset)       |
| `provider_id` | `TEXT`    | `NOT NULL`, `accounts_provider_charset` (same charset)                 |
| `label`       | `TEXT`    | `NOT NULL`, `accounts_label_nonempty` (mirrors the config minimum)     |
| `plan_name`   | `TEXT`    | nullable; `accounts_plan_nonempty`: absent or non-blank (§8.4 shape)   |
| `status`      | `TEXT`    | `NOT NULL`, `accounts_status`: `'active'` or `'archived'` only         |
| `created_at`  | `INTEGER` | `NOT NULL`, §11.1 epoch ms, writer-supplied (no SQL default)           |
| `archived_at` | `INTEGER` | nullable, §11.1 epoch ms; tied to `status` by `accounts_archive_state` |

Pinned interpretations (D-032):

- **No credential columns** — secrets stay in the config file (§11.1, §15.4).
  The test pins the exact seven-column set and rejects column names carrying
  credential fragments, so a future migration cannot add one silently.
- **Archive, not delete (§8.2)** — `accounts_archive_state` makes
  `status`/`archived_at` consistent by construction: archived always carries
  a timestamp, active never does. Archiving is an `UPDATE`; the row (and its
  history) stays queryable.
- **Charsets in SQL** — `GLOB`-encoded `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`
  (case-sensitive) plus a NUL guard: SQLite's `GLOB`/`length()` stop at an
  embedded NUL while the stored bytes do not, so `instr(x, char(0)) = 0` is
  what makes the encoding exact. The CHECK is also the charset **gate** for
  `provider_id` — the config field that lands there (`accounts[].providerId`)
  is only `minLength: 1`; D-014's ID_PATTERN binds provider record keys, a
  different surface. A number bound for the TEXT id is affinity-rendered as
  `'123.0'` before the CHECK runs, so numeric ids cannot slip through.
- **No `enabled` column** — enable/disable is configuration state (§6.2), not
  §11.2 storage state; a later migration can add it if the repository needs
  it persisted.
- **Named CHECK constraints** — SQLite reports failures by name
  (`CHECK constraint failed: accounts_status`), keeping violations
  self-explanatory.
- **No SQL-side defaults and no indexes** — timestamps come from the injected
  clock (D-021) at write time; §11.2 requires no accounts index (the table is
  small and configuration-synced). `id` declares `NOT NULL` explicitly because
  SQLite rowid tables would otherwise accept a NULL text primary key.

## The `collection_runs` table — migration `0002-collection-runs` (task 082, spec §11.2, decision D-034)

The second entry of the canonical `MIGRATIONS` list (schema version 2). One
row per polling cycle — successful or not (§11.1) — capturing what §7.2's
retry/error behaviors leave behind. Exercised directly in
`test/integration/collection-runs.spec.ts`; the typed data access is task
088's repository.

| Column                | Type      | Rules                                                                                          |
| --------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `id`                  | `INTEGER` | `PRIMARY KEY` (rowid alias, auto-assigned) — the run id snapshots reference                    |
| `account_id`          | `TEXT`    | `NOT NULL`, `collection_runs_account_charset` (D-014), FK → `accounts(id)` `ON DELETE CASCADE` |
| `started_at`          | `INTEGER` | `NOT NULL`, §11.1 epoch ms, wall-clock (§7.1)                                                  |
| `ended_at`            | `INTEGER` | `NOT NULL`, §11.1 epoch ms                                                                     |
| `interval_seconds`    | `INTEGER` | `NOT NULL`, `collection_runs_interval_range`: §7.1's 60–3600                                   |
| `outcome`             | `TEXT`    | `NOT NULL`, `collection_runs_outcome`: §11.2's seven values only                               |
| `http_status`         | `INTEGER` | nullable, `collection_runs_http_status_range`: NULL or 100–599                                 |
| `error_message`       | `TEXT`    | nullable, `collection_runs_error_nonempty`; NULL on success (`collection_runs_success_clean`)  |
| `attempts`            | `INTEGER` | `NOT NULL`, `collection_runs_attempts_positive`: §7.2's total attempt count                    |
| `retry_after_seconds` | `INTEGER` | nullable, `collection_runs_retry_after_range`: NULL or 0–3600 (§7.2's cap)                     |

Indexes (§11.2 "runs by account/start and account/outcome/start"):
`collection_runs_account_start (account_id, started_at)` and
`collection_runs_account_outcome_start (account_id, outcome, started_at)` —
the first also serves the foreign-key cascade scan, so no extra FK index.

Pinned interpretations (D-034):

- **Outcome enum = §7.2's outcome classes** — the closed §11.2 list
  (`success`, `auth_error`, `rate_limited`, `network_error`, `timeout`,
  `server_error`, `parse_error`) is exactly the vocabulary of §7.2's failure
  table and §7.3's status precedence.
- **Ranges mirror the domain boundaries** (the D-032 plan-name precedent):
  interval carries §7.1's validated 60–3600, `attempts >= 1` keeps §7.2's
  "total attempt count" a count (the maximum of 4 is poller retry policy,
  not storage truth), retry-after honors §7.2's one-hour cap.
- **Nullable evidence, uncoupled from the outcome** — `http_status` is absent
  when no response arrived; `retry_after_seconds` is absent when no
  `Retry-After` applies (a 429 may arrive without the header). Binding either
  to specific outcomes would freeze collector/adapter behavior (tasks 098+)
  into the on-disk contract.
- **`error_message` stores already-sanitized text** (§7.2 "sanitized error
  information") — the redaction module is task 102's; storage keeps the
  absent-or-non-blank shape and the one §7.2 coupling: a successful run
  never carries an error (failures may lack a message).
- **No `ended_at >= started_at` CHECK** — same clock-skew leniency D-032
  recorded for `archived_at >= created_at`: a rejected INSERT would lose the
  run record permanently; the interval and retry-after ranges are this
  table's timing-sanity checks.
- **Synthetic id without `AUTOINCREMENT`** — §11.2's consistent cascading
  deletion means a deleted run's history dies with it, so rowid recycling
  cannot create a stale reference; the auto-assigned rowid is the one
  database-generated value and has no clock dependency.

## The `snapshots` table — migration `0003-snapshots` (task 083, spec §11.2, decision D-036)

The third entry of the canonical `MIGRATIONS` list (schema version 3). One
header row per **successful** run (§11.1/§7.2) — the §8.4 snapshot header the
`metric_values` table (task 084) hangs off. Exercised directly in
`test/integration/snapshots.spec.ts`; the typed data access is task 088's
repository.

| Column         | Type      | Rules                                                                                               |
| -------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `run_id`       | `INTEGER` | `NOT NULL UNIQUE` — one snapshot per run by identity; FK carrier below                              |
| `account_id`   | `TEXT`    | `NOT NULL`, `snapshots_account_charset` (D-014), FK → `accounts(id)` `ON DELETE CASCADE`            |
| `collected_at` | `INTEGER` | `NOT NULL`, §11.1 epoch ms, wall-clock (§7.1), writer-supplied (no SQL default)                     |
| `plan_name`    | `TEXT`    | nullable, `snapshots_plan_nonempty`: absent or non-blank (§8.4 shape)                               |
| `run_outcome`  | `TEXT`    | `NOT NULL`, `snapshots_success_only`: `'success'` only — the composite FK's comparison term (D-036) |

Foreign keys (both `ON DELETE CASCADE`): `account_id` → `accounts(id)`, and
the composite `(account_id, run_id, run_outcome)` →
`collection_runs (account_id, id, outcome)` — a parent key this migration
exposes by adding the unique index `collection_runs_account_id_outcome`.

Index (§11.2 "snapshots by account/time"): `snapshots_account_time
(account_id, collected_at)` — the spec's wording, named the D-034 way; its
leading column also serves the account-FK cascade scan. The `run_id UNIQUE`
constraint adds the implicit `sqlite_autoindex_snapshots_1`.

Pinned interpretations (D-036):

- **`UNIQUE`, not `INTEGER PRIMARY KEY`** — verified on the pinned runtime:
  a NULL inserted into a NOT NULL rowid alias is silently replaced by a
  fresh auto-assigned id, attaching a snapshot to an arbitrary run; a plain
  UNIQUE column rejects NULL. The UNIQUE constraint is the structural
  "at most one snapshot per run", and no query needs a second identity —
  the snapshot's identity is its run (task 084/085 reference it as such).
- **Success linkage via one composite FK** — `(account_id, run_id,
run_outcome)` matching the parent `(account_id, id, outcome)` proves three
  §11.2 properties in one constraint: the run exists, it belongs to the same
  account, and it succeeded. The parent-side default (`ON UPDATE NO ACTION`)
  additionally freezes a referenced run's `outcome`/`account_id` against
  post-hoc UPDATEs. Rejected: a trigger (no precedent, more on-disk objects),
  a partial unique parent index (SQLite forbids as an FK parent key), and a
  plain run FK + writer contract (§11.2's stated record property left
  unenforced).
- **`run_outcome` is the one column beyond §11.2's list** — a CHECK-bound
  constant carried solely for that composite FK; the exact-column-set rule
  (D-032/D-034) bends only here, recorded in D-036.
- **No cross-table time CHECK** — `collected_at` is not ordered against the
  run's timestamps: the clock-skew leniency D-032/D-034 recorded, and CHECK
  constraints cannot span tables regardless.
