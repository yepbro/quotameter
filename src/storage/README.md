# `src/storage/` — the only database access layer

All `node:sqlite` access is isolated here (spec §3, §11): the connection and
pragmas (079), forward-only migrations with backups (078, 080–092),
`QuotaRepository` — the typed facade the application consumes (088) — the
atomic collection-cycle write composed over it (089), the §8.2 account
archive/purge lifecycle operations (090), and the §11.3 retention cleanup
with its WAL-checkpoint maintenance primitive (091). Rows are mapped to typed
domain records from `src/schemas/` before leaving this layer.

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
(`VACUUM INTO`, three-generation retention — `backups.ts`) and the
refuse-to-start check for a schema newer than the application
(`startup-migrations.ts`); the application tables themselves are tasks
080–087.

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
retention) and the refuse-to-start behavior are task 092's
(`backups.ts`/`startup-migrations.ts`), built on `appliedMigrations()` and
`schemaVersionStatus()`.

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

## The `metric_values` table — migration `0004-metric-values` (task 084, spec §11.2, §8.4, decision D-039)

The fourth entry of the canonical `MIGRATIONS` list (schema version 4). One
row per metric per snapshot — the persisted §8.4 `NormalizedMetric`, with
account and collection time denormalized so §11.2's series queries never
join (§11.3's ≈52k-snapshots-per-account scale). Exercised directly in
`test/integration/metric-values.spec.ts`; the typed data access is task
088's repository.

| Column              | Type      | Rules                                                                                        |
| ------------------- | --------- | -------------------------------------------------------------------------------------------- |
| `run_id`            | `INTEGER` | `NOT NULL` — the snapshot identity (D-036); composite-FK carrier below                       |
| `account_id`        | `TEXT`    | `NOT NULL`, `metric_values_account_charset` (D-014), FK → `accounts(id)` `ON DELETE CASCADE` |
| `collected_at`      | `INTEGER` | `NOT NULL`, §11.1 epoch ms, composite-FK carrier — pinned to the snapshot's value            |
| `metric_key`        | `TEXT`    | `NOT NULL`, `metric_values_metric_key_nonempty`                                              |
| `limit_type`        | `TEXT`    | `NOT NULL`, `metric_values_limit_type`: the five `LIMIT_TYPES` values only                   |
| `unit`              | `TEXT`    | `NOT NULL`, `metric_values_unit`: the four `METRIC_UNITS` values only                        |
| `window_seconds`    | `INTEGER` | nullable; no range CHECK (the §8.4 boundary validates only finiteness)                       |
| `used`              | `REAL`    | nullable quota column                                                                        |
| `remaining`         | `REAL`    | nullable quota column                                                                        |
| `limit_value`       | `REAL`    | nullable quota column; `limit` renamed — bare `limit` is an SQL keyword                      |
| `percent_used`      | `REAL`    | nullable quota column                                                                        |
| `percent_remaining` | `REAL`    | nullable quota column                                                                        |
| `resets_at`         | `INTEGER` | nullable, §11.1 epoch ms; retainable on invalid rows (D-010(2))                              |
| `is_valid`          | `INTEGER` | `NOT NULL`, `metric_values_valid_flag`: 0/1 only                                             |
| `invalid_reason`    | `TEXT`    | nullable, absent-or-non-blank; required when invalid (`metric_values_invalid_reason`)        |
| `derived_fields`    | `INTEGER` | nullable, `metric_values_derived_fields_range`: 0–31 bitmask over D-010's field order        |

Structural constraints beyond the columns:

- `UNIQUE (run_id, metric_key)` — one row per metric per snapshot; the
  storage face of §8.4's "keys are unique within a snapshot". Its autoindex
  (leading `run_id`) also serves the snapshot/run cascade scans.
- `metric_values_valid_has_value` — a valid row carries at least one of the
  five quota values (§11.2 "a valid metric row must include at least one
  usable numeric metric value").
- `metric_values_invalid_clean` — an invalid row carries none of the five:
  NULL, never zero placeholders (§11.2/D-010); `window_seconds` and
  `resets_at` may be retained.
- `metric_values_derived_present` — every set bit requires its column
  present: D-010's "listed as derived but the field is not set" record
  invariant, structurally; an invalid row (all five quota columns NULL) can
  carry only the NULL or 0 mask.
- Composite FK `(account_id, run_id, collected_at)` →
  `snapshots (account_id, run_id, collected_at)` `ON DELETE CASCADE` — a
  parent key this migration exposes by adding the unique index
  `snapshots_account_run_time`. One constraint proves the snapshot exists,
  the account matches, and the denormalized time matches (the D-036
  technique); the parent-side NO ACTION default freezes a referenced
  snapshot's identity against post-hoc UPDATEs. The direct
  `account_id → accounts` FK is kept alongside it (the D-036 shape).

Index (§11.2 "series access"): `metric_values_series_access
(account_id, metric_key, collected_at)` — the spec's wording, named the
D-034 way; proven used via `EXPLAIN QUERY PLAN`.

Pinned interpretations (D-039):

- **No `label` column** — §11.2's metric_values row does not list it
  (labels are adapter/UI vocabulary, not history); the D-032 exact-set rule.
- **Quota values REAL, metadata INTEGER** — the §8.4 boundary types the five
  quota fields as `number` and percentages are fractional; an INTEGER column
  would reject states the domain can produce (the D-032 identical-states
  rule). `window_seconds` (a duration, D-034's `interval_seconds` precedent)
  and `resets_at` (§11.1 integer epoch ms) are integral by definition.
- **`derived_fields` bitmask** — used=1, remaining=2, limit=4,
  percentUsed=8, percentRemaining=16 (D-010's `DERIVED_METRIC_FIELDS`
  order); NULL = absent, 0 = empty set, 0–31 = exactly the power set of the
  closed set. A set outside the closed list is unrepresentable; a JSON
  encoding was rejected because CHECK constraints cannot validate
  per-element membership, which would leave the closed set a writer
  contract. Each set bit is additionally coupled to its column's presence
  (`metric_values_derived_present`), mirroring the §8.4 boundary's
  derived⇒set invariant. The repository (task 088) encodes/decodes; the bit
  assignment is on-disk contract.
- **`metric_values_invalid_reason` is one-directional** — invalid requires a
  non-blank reason; a valid row's reason is unconstrained, mirroring D-034's
  `collection_runs_success_clean` (encode exactly what the spec states).
- **No range CHECKs on `window_seconds`/`resets_at`** — the §8.4 boundary
  validates only finiteness for them; invented bounds would reject states
  the domain can produce.

## The `quota_events` table — migration `0005-quota-events` (task 085, spec §11.2, §12.1, decision D-046)

The fifth entry of the canonical `MIGRATIONS` list (schema version 5). One
row per recorded quota event — `RESET` in version 1 (§11.2) — written in
the same transaction as the snapshot that produced it (§11.1). Reset
**detection** is tasks 117/118's and the typed access is task 088's; this
is the storage shape. Exercised directly in
`test/integration/quota-events.spec.ts`.

| Column       | Type      | Rules                                                                                         |
| ------------ | --------- | --------------------------------------------------------------------------------------------- |
| `account_id` | `TEXT`    | `NOT NULL`, `quota_events_account_charset` (D-014), FK → `accounts(id)` `ON DELETE CASCADE`   |
| `metric_key` | `TEXT`    | `NOT NULL`, `quota_events_metric_key_nonempty` — same semantics as `metric_values.metric_key` |
| `event_type` | `TEXT`    | `NOT NULL`, `quota_events_type`: `'RESET'` only (the §11.2 version-1 set)                     |
| `event_at`   | `INTEGER` | `NOT NULL`, §11.1 epoch ms, writer-supplied (no SQL default)                                  |
| `run_id`     | `INTEGER` | nullable — the optional §11.2 snapshot id, the D-036 identity; composite-FK carrier below     |
| `details`    | `TEXT`    | `NOT NULL`, JSON object carrying §12.1's evidence; the shape CHECKs below                     |

Structural constraints beyond the columns:

- `quota_events_details_json` / `_object` / `_reason` / `_points` — the
  SQL-enforced audit minimum for `details`: valid JSON, a top-level object,
  a non-empty-text `$.reason`, and object `$.previous`/`$.current` (the
  §12.1 compared points). `json_valid` is declared first so malformed JSON
  fails by constraint name before the shape checks' `json_type` throws; the
  path checks coalesce a missing key's NULL to a mismatch because a NULL
  CHECK result passes in SQLite (verified on the pinned runtime).
- Composite FK `(account_id, run_id)` →
  `snapshots (account_id, run_id)` `ON DELETE CASCADE` — a parent key this
  migration exposes by adding the unique index `snapshots_account_run`.
  One constraint proves the snapshot exists and the event's account matches
  it; the parent-side NO ACTION default freezes a referenced snapshot's
  identity against post-hoc UPDATEs (the D-036/D-039 technique). The direct
  `account_id → accounts` FK stays alongside it (the both-foreign-keys
  shape).

Index (§11.2 "events by account/metric/time"):
`quota_events_account_metric_time (account_id, metric_key, event_at)` —
the spec's wording, named the D-034 way; its leading `account_id` serves
both cascade scans, so no extra foreign-key index.

Pinned interpretations (D-046):

- **`event_at` is deliberately not the snapshot's time** — §12.1's rule
  makes it the previous point's `resetsAt` when that timestamp lies between
  the two snapshots, else the new snapshot's time. It is writer-supplied
  and unpinned (the two legitimately differ; cross-table CHECKs are
  impossible anyway).
- **The metric reference is the key string only** — §11.2 lists no window
  or enum columns for events (D-032 exact-set rule); window evidence
  belongs in `details`.
- **`details`'s deeper vocabulary is a writer contract** — camelCase point
  fields (`runId`, `collectedAt`, `used`, `resetsAt`, …), `tolerance`,
  `eventTimeSource` are produced by detection (117/118) and encoded by the
  repository (088); CHECKs cannot validate per-key membership of arbitrary
  objects (the D-039 JSON-rejection rationale), so SQL pins the audit
  minimum only.
- **The reason is a free non-empty string, not a CHECK enum** — the reason
  vocabulary is detection policy (§12.1's conservative approach), not a
  stated record property (the D-034 rule of encoding exactly what the spec
  states).
- **No primary key, no UNIQUE constraint** — no query references an event
  id, and §12.1 states no per-snapshot event uniqueness; duplicate
  prevention is the writer's (one comparison per metric per snapshot).
- **Deletion behavior** — deleting an account removes its events on both FK
  paths (§8.2 purge); deleting a run removes its snapshot and with it the
  events referencing it; archiving an account is an UPDATE and retains the
  events (§8.2). A NULL `run_id` satisfies the composite FK while the
  direct FK still proves the account exists.

## The `raw_responses` table — migration `0006-raw-responses` (task 086, spec §7.4, §11.2, decision D-051)

The sixth entry of the canonical `MIGRATIONS` list (schema version 6). One
row per **parse-failed** collection run — the bounded, sanitized payload
`quotameter doctor --raw` (task 103) diagnoses `Format changed` with.
Sanitization is task 102's (D-041: the row stores the sanitizer's output
as-is), retention execution (20 per account / 30 days) is task 103's, and
the typed access is task 088's. Exercised directly in
`test/integration/raw-responses.spec.ts`.

| Column         | Type      | Rules                                                                                        |
| -------------- | --------- | -------------------------------------------------------------------------------------------- |
| `run_id`       | `INTEGER` | `NOT NULL UNIQUE` — one raw record per run by identity; composite-FK carrier below           |
| `account_id`   | `TEXT`    | `NOT NULL`, `raw_responses_account_charset` (D-014), FK → `accounts(id)` `ON DELETE CASCADE` |
| `captured_at`  | `INTEGER` | `NOT NULL`, §11.1 epoch ms, writer-supplied (no SQL default) — the 30-day retention key      |
| `http_status`  | `INTEGER` | nullable, `raw_responses_http_status_range`: NULL or 100–599 (D-034 mirror)                  |
| `content_type` | `TEXT`    | nullable, `raw_responses_content_type_nonempty`: absent or non-blank                         |
| `body`         | `TEXT`    | `NOT NULL`, may be empty; `raw_responses_body_size`: `octet_length(body) <= 65536`           |
| `run_outcome`  | `TEXT`    | `NOT NULL`, `raw_responses_parse_error_only`: `'parse_error'` only — the composite FK's term |

Structural constraints beyond the columns:

- `run_id INTEGER NOT NULL UNIQUE` — §11.2's "one per run" as the schema, a
  plain UNIQUE column (D-036's verified finding: a NULL into a NOT NULL
  rowid alias is silently replaced by a fresh id, while the plain UNIQUE
  column rejects it). No second identity column: no query references a
  raw-response id.
- Composite FK `(account_id, run_id, run_outcome)` →
  `collection_runs (account_id, id, outcome)` `ON DELETE CASCADE` — the
  parent key task 083 already exposed (`collection_runs_account_id_outcome`,
  no new parent index) — with `raw_responses_parse_error_only` pinning the
  child's carrier. One constraint proves three §7.4/§11.2 properties: the
  run exists, it belongs to the same account, and its outcome is
  `parse_error` — so a successful run (or any non-parse failure) can never
  carry a raw record, and a payload can never be filed under another
  account's run. The parent-side NO ACTION default freezes a referenced
  run's outcome/account against post-hoc UPDATEs.
- `raw_responses_body_size` — the D-041 64 KiB cap in SQL, in **bytes**:
  `octet_length()` counts the full UTF-8 byte length (NUL included; SQLite
  ≥ 3.43, the pinned runtime carries 3.47.2), while `length()` counts code
  points (up to 4 bytes each) and stops at NUL. At-cap passes, one byte
  over is rejected. The bound interpolates from
  `RAW_RESPONSE_MAX_PAYLOAD_BYTES` — the storage-side twin of D-041's
  `MAX_PAYLOAD_BYTES`, re-declared because the layout DAG forbids storage
  importing providers and drift-tested for equality against the sanitizer's
  constant.

Index: `raw_responses_account_time (account_id, captured_at)` — the
per-account scan task 103's retention policy needs (newest-first for the
20-record cap, `captured_at` ranges for the 30-day expiry), named the
D-034 way; its leading `account_id` also serves the account-FK cascade
scan, and the `run_id UNIQUE` autoindex serves the run cascade — no extra
foreign-key indexes.

Pinned interpretations (D-051):

- **Column set = §11.2's row plus the two D-036 FK carriers** — `account_id`
  and `run_outcome` exist solely so the parse-error linkage can compare
  against the run's own columns (the D-036-documented bend); `account_id`
  additionally leads the retention index. `captured_at` names §11.2's
  "timestamp" (the house `_at` suffix); §7.4 names no content type,
  §11.2's row does, so the column is here.
- **`body` may be empty** — an empty body is itself a parse failure
  (`JSON.parse('')` throws; the sanitizer passes `''` through), so unlike
  `error_message` there is no non-empty CHECK; no charset or NUL guard
  either — the row stores the sanitizer's output and must fit every state
  the domain can produce (the D-039 rule).
- **Evidence columns mirror D-034's shapes** — `http_status` is NULL when
  the failure produced no response to retain a status from (D-048:
  `response-too-large`/`content-type` carry none); `content_type` is the
  header value verbatim or absent — unbounded by design: §7.4's cap is the
  payload's, the transport's header-size limit bounds what can arrive, and
  a schema-side bound would reject states the domain can produce (the
  D-039 rule).
- **Cascading linkage** — deleting a run removes its payload (§11.3's
  cleanup deletes expired runs — their payloads are older still); deleting
  an account removes its payloads (§8.2 purge); archiving is an UPDATE and
  retains them.

## The `sessions` and `meta` tables — migration `0007-sessions-meta` (task 087, spec §11.2, §15.2, decision D-056)

The seventh entry of the canonical `MIGRATIONS` list (schema version 7) —
one migration for both tables (D-031's one-entry-per-task rule), completing
§11.2's table list. The session/auth layer that uses them is tasks 154–157;
the typed access is task 088's. Exercised directly in
`test/integration/sessions-meta.spec.ts`.

### `sessions`

| Column         | Type      | Rules                                                                                                                                                             |
| -------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token_hash`   | `TEXT`    | `PRIMARY KEY`, `NOT NULL`, `sessions_token_hash_hex`: exactly 64 lowercase hex chars (the SHA-256 digest's `digest('hex')` form), GLOB-encoded with the NUL guard |
| `created_at`   | `INTEGER` | `NOT NULL`, §11.1 epoch ms, writer-supplied (no SQL default)                                                                                                      |
| `last_seen_at` | `INTEGER` | `NOT NULL`, §11.1 epoch ms — initialized to creation (login is the first sighting)                                                                                |
| `expires_at`   | `INTEGER` | `NOT NULL`, §11.1 epoch ms — the effective expiry: `min(last_seen + 7 d, created + 30 d)`                                                                         |

Structural constraints beyond the columns:

- `sessions_expiry_absolute` — `expires_at <= created_at +
SESSION_MAX_AGE_MS` (§15.2 "no later than 30 days after creation";
  30 d = 2 592 000 000 ms, exported as `SESSION_MAX_AGE_MS`).
- `sessions_expiry_inactivity` — `expires_at <= last_seen_at +
SESSION_INACTIVITY_TIMEOUT_MS` (§15.2 "expire after 7 days of
  inactivity"; 7 d = 604 800 000 ms, exported as
  `SESSION_INACTIVITY_TIMEOUT_MS`). At-bound values pass (`<=`).

Index (§11.2 "sessions by expiry"): `sessions_expiry (expires_at)` — named
the D-034 way; serves §11.3's expired-session cleanup as a range scan. The
primary-key autoindex serves §15.2's token-hash lookup — no other index.

Pinned interpretations (D-056):

- **Never the raw cookie token** — §11.2's rule made structural three ways:
  the exact four-column pin (nothing beyond the §11.2 row exists), the
  credential-fragment pin (`token_hash` is the only column whose name may
  carry token/cookie/secret/raw vocabulary — a future raw-token column
  breaks the test, the accounts D-032 precedent), and the hex-shape CHECK,
  which the raw 256-bit token's wire forms (base64url, raw bytes) cannot
  fit. One precondition is recorded (D-056): a lowercase-hex cookie
  encoding would be shape-identical to the digest — no SQL constraint can
  distinguish the two — so the value's digest-not-token provenance stays
  the session layer's writer contract (task 154), and the cookie's wire
  form stays non-hex (base64url), keeping the two shapes distinct.
- **Identity = the digest** — no second id column: no query references one
  (the D-036/D-039/D-046/D-051 no-second-identity rule); lookups are
  cookie token → digest → row.
- **One effective expiry column** — the writer (task 155) maintains
  `expires_at` as the tighter of §15.2's two bounds, refreshed together
  with `last_seen_at`, so one column plus one index answers both validation
  and cleanup; `created_at`/`last_seen_at` stay stored, keeping both rules
  independently auditable. No lower-bound ordering CHECKs — the D-032/D-034
  clock-skew leniency; §15.2 states upper bounds only.
- **Not account-bound** — §15.1's one-user service state, not account
  history: no `account_id`, no foreign key, and §11.2's cascading-deletion
  policy for purged account history does not reach this table (pinned by
  test: purging every account leaves sessions untouched).

### `meta`

| Column  | Type   | Rules                                                        |
| ------- | ------ | ------------------------------------------------------------ |
| `key`   | `TEXT` | `PRIMARY KEY`, `NOT NULL`, `meta_key_nonempty` (`key <> ''`) |
| `value` | `TEXT` | `NOT NULL` — any TEXT value, including the empty string      |

Pinned interpretations (D-056):

- **Exactly key/value** — no timestamps or columns §11.2 does not list (the
  D-032 exact-set rule). Writers own the vocabulary: task 091's cleanup
  metadata (e.g. when cleanup last ran) lands as rows it defines, typed by
  the repository (088).
- **No shape CHECK on `value`** — §11.2 states none; a JSON or charset
  contract would freeze a writer convention into the on-disk schema and
  could reject states the service produces (the D-039 identical-states
  rule). Key lookups run on the primary-key autoindex.

## `repository.ts` — the typed repository facade (task 088, spec §8.1/§11, decision D-058)

`QuotaRepository` — the §8.1 core-service name, the storage layer's public
facade (D-009) — over the migrated canonical schema:
`createQuotaRepository({ database })` takes the configured `DatabaseSync`
(the `database` field of task 079's `StorageConnection`; it owns no
lifecycle) and returns the only sanctioned data path. Every method maps rows
to readonly camelCase records over the §8.4 vocabulary; no snake_case row
and no handle crosses the boundary. Pinned interpretations (D-058):

- **Synchronous methods** — `DatabaseSync` cannot await anything; no async
  facade theater. Multi-record atomicity is explicit:
  `withTransaction(work)` runs the callback's inserts in one
  `BEGIN IMMEDIATE` … `COMMIT` unit (rollback + rethrow on failure, loud
  nesting refusal) — the seam task 089 composes into the §11.1 atomic cycle
  write.
- **No clock** — timestamps are writer-supplied arguments on every write and
  every retention cutoff (D-021's discipline carried into the API surface).
- **The named CHECK constraints are the write gate** — the repository
  re-validates nothing; constraint failures propagate by name. It only maps
  what SQL cannot express: `is_valid` ⇄ boolean and the `derived_fields`
  bitmask ⇄ `DerivedMetricField[]` (D-039).
- **FK carriers are internal** — `insertSnapshot` writes the `'success'`
  carrier, `insertRawResponse` the `'parse_error'` carrier; callers cannot
  express the D-036/D-051 linkages wrong (an error cycle can never gain a
  snapshot; a successful run can never carry a raw payload).
- **Retention deletes return counts** — `deleteCollectionRunsBefore` and
  siblings report what they removed (task 091); `deleteAccount` is the §8.2
  purge (the cascades remove the history), `archiveAccount` touches only an
  active row so the archive timestamp is immutable.

Surface, by consumer: accounts (`insertAccount`, `getAccount`,
`listAccounts`, `updateAccountDetails`, `archiveAccount`, `deleteAccount` —
090), runs (`insertCollectionRun` → assigned id, `getCollectionRun`,
`listCollectionRuns`, `getLatestCollectionRun`,
`deleteCollectionRunsBefore` — 110/091/142), snapshots (`insertSnapshot`,
`getSnapshotByRun`, `getLatestSnapshot`, `listSnapshots`), metrics
(`insertMetricValues`, `getMetricValuesForRun`, `getMetricSeries` — proven
on the `metric_values_series_access` index), events (`insertQuotaEvent`,
`listQuotaEvents`, `deleteQuotaEventsBefore`), raw responses
(`insertRawResponse`, `getRawResponseByRun`, `listRawResponses` newest
first, `deleteRawResponsesByRunIds` + `deleteRawResponsesBefore` — the
identity delete and the time cutoff compose into 103's 20-per-account /
30-day policy), sessions (`insertSession`,
`getSession`, `touchSession`, `deleteSession`, `deleteAllSessions`,
`deleteSessionsExpiredBefore` — 154/155), and meta (`getMetaValue`,
`setMetaValue` upsert — 091).

**Boundary enforcement.** "Application services issue no ad hoc SQL outside
the storage module" is mechanically true, not conventional:
`test/unit/package-layout.spec.ts` already gates `node:sqlite` imports to
this directory (D-009), and `test/unit/storage-sql-gate.spec.ts`
additionally fails `make check` on any uppercase house-style SQL statement
literal outside `src/storage/` (positive-control fixtures prove the
detector non-vacuous, D-058). The SQL gate is a tripwire against
accidental violations in the house style — deliberately not a security
boundary: lowercase or concatenated SQL, `SAVEPOINT`, and non-`.ts` files
stay out of its scope by design (D-058 records the prose-safety rationale
and the no-silent-widening rule). The per-table integration specs under
`test/integration/` and `test/helpers/` are storage-module tests and
remain sanctioned direct-SQL users. `test/integration/repository.spec.ts`
pins the facade itself: round-trips per table, the structural rejections,
transaction commit/rollback/nesting, and the bitmask round-trip.

## `collection-cycles.ts` — the atomic cycle write (task 089, spec §11.1, decision D-060)

`persistCollectionCycle(repository, cycle)` is §11.1's sentence as code: one
call writes the run row every cycle leaves behind — successful or not — and,
for a successful cycle, the snapshot, its metric rows, and its reset events
inside the repository's `withTransaction` seam (D-058); a parse-failure cycle
carries its §7.4 sanitized payload beside the run instead. Everything commits
together or vanishes together: any failure — a named CHECK rejecting a row, a
UNIQUE collision, or a driver-level throw — rolls the whole cycle back and
propagates unchanged, so a run row never survives without its snapshot, a
snapshot never without its metric rows, and an event never without the
snapshot it evidences. `test/integration/collection-cycles.spec.ts` verifies
that at **every insert position** with injected failures (§17.1): SQL-level
rejections (FK at the run insert, `snapshots_plan_nonempty`,
`metric_values_valid_has_value`, a mid-batch duplicate key,
`quota_events_details_reason`, `raw_responses_body_size`) plus driver-level
throws through a delegating proxy — each asserting zero residue across runs,
snapshots, events, and raw payloads, and the connection staying usable.

- **A sibling module, not a facade method** (D-060): D-058 designed the
  repository surface so this orchestration composes it without extension;
  composing the public methods is also what makes position-targeted failure
  injection testable through a proxy — a facade method would call its sibling
  closures directly.
- **The writer supplies identity**: metric, event, and raw-payload inputs are
  the facade row types minus `accountId`/`runId`/`collectedAt` (`Omit`, kept
  in lockstep); the function injects the cycle's account, the assigned run
  id, and the snapshot's collection time into each row — D-039
  denormalization drift and a wrong-account event (D-046) are unrepresentable
  in the input, not merely rejected. `eventAt` stays writer-supplied per
  §12.1 (deliberately its own value, D-046).
- **The input is a classified cycle** — a discriminated union on `outcome`
  in D-048's vocabulary: the success branch carries the snapshot and cannot
  express `errorMessage`/`retryAfterSeconds` (`collection_runs_success_clean`
  by construction); only a parse-failure branch can carry a raw payload (the
  sole outcome §7.4 sanctions — the D-051 linkage is structural too); the
  other five failure outcomes carry only run evidence. Either snapshot array
  may be empty — §11.1 stores a snapshot for every successful collection,
  and the §8.4 boundary admits zero-metric snapshots.
- **No pre-validation, no wrapping** — the named CHECK constraints remain the
  write gate (D-058); the function validates nothing beforehand and swallows
  nothing. Task 110's poller hands classified cycles to this seam; reset-event
  detection (§12.1, tasks 117/118) and scheduling happen before the call.

## `account-lifecycle.ts` — the §8.2 archive/purge operations (task 090, spec §8.2, §11.2, decision D-061)

`retireAccount(repository, { accountId, archivedAt })` and
`purgeAccount(repository, accountId)` are §8.2's lifecycle split as two
composed operations: archiving is the **default retirement** — the account
row is archived and stays queryable with every history row intact — and
purging is the **separate explicit action** — the account row is deleted and
the schema's cascading foreign keys take every history table with it
(collection runs, snapshots, metric values, quota events, raw payloads),
while `sessions` and `meta` survive as service state (D-056).
`test/integration/account-lifecycle.spec.ts` pins the two paths as distinct
suites (the done-condition's "distinct tests"), including the cascade across
every table, cross-account isolation, the D-056 service-state survival, and
a foreign-keys-off connection making the purge fail loudly instead of
orphaning history.

- **A sibling module, not facade methods** (D-061, the D-060 precedent):
  D-058's growth rule designed the facade so this task composes
  `archiveAccount`/`deleteAccount` and the read surface without extension;
  the lifecycle-outcome vocabulary stays out of the per-table contract, and
  no new SQL exists.
- **Disambiguated retirement outcomes** — the facade primitive's boolean
  cannot tell unknown from already-archived; `retireAccount` adds the
  follow-up read and returns `unknown` / `archived` / `already-archived`
  (the §13 API's 404-versus-idempotent-success distinction, task 159).
  Re-retirement is a no-op keeping the original timestamp (D-058's
  archive-once semantic).
- **Purge works regardless of status** — §8.2 states no archive-first
  requirement; an already-archived account purges identically (pinned by
  test).
- **The purge reports what it removed** — `PurgedHistoryCounts`, one count
  per §11.2 account-history table, captured synchronously before the
  single-statement delete (atomic alone, D-058); no transaction wrapping,
  because nothing can interleave between the reads and the write on one
  synchronous connection. The metric count rides the captured run ids —
  `metric_values` has no account-level facade read, and every metric row
  carries one.
- **The purge self-verifies its post-condition** — after the delete, a
  residue sweep through the facade reads throws loudly if any history row
  survived (§11.2's cascading-deletion sentence enforced at runtime; the
  defense targets foreign-keys-off connections, which raw `node:sqlite`
  handles default to — D-056's note).
- **Reactivation is out of scope** — §8.2 names no archived-to-active
  transition and the facade has no primitive for it; the config-sync tasks
  extend the surface when they need one.

## `maintenance.ts` — the WAL checkpoint / `incremental_vacuum` primitive (task 091, spec §11.3, §5.6, decision D-063)

`runStorageMaintenance(database)` is §11.3's closing step — "Then checkpoint
WAL and run `incremental_vacuum` where supported/configured" — and §5.6's
shutdown checkpoint, as one primitive over the raw connection (the facade
rightly never hands a `DatabaseSync` back, D-058; a checkpoint is a statement
about the database file, not about any table). It is deliberately **not** a
repository method, for the same sibling-module reason as the other composed
operations. `test/integration/maintenance.spec.ts` verifies the checkpoint by
its **effect** — the `-wal` file, which only TRUNCATE mode resets to zero
bytes — against the production connection (task 079's readback-verified WAL).

- **`wal_checkpoint(TRUNCATE)`, outcome as data** — TRUNCATE is the mode that
  actually returns the disk; its `{busy, log, checkpointed}` row maps into the
  result, where `busy` (another connection's read snapshot held the WAL —
  `doctor`, an operator shell) is a reportable outcome, not an error: the next
  cleanup checkpoints again. On a §11.1 connection the checkpoint first waits
  out the 5 s `busy_timeout` budget through SQLite's busy handler before
  reporting `busy` — a caller on the hot path should expect that synchronous
  stall. Only driver-level failures throw, unwrapped (D-058 style).
- **`incremental_vacuum` runs unconditionally; SQLite decides** — the §11.1
  pragma set configures no `auto_vacuum`, so a Quotameter database defaults to
  `NONE`, where the pragma is a documented no-op (verified on the pinned
  runtime). "Where supported/configured" is expressed by running the call and
  reporting the actual mode readback (`'none'`/`'full'`/`'incremental'`): real
  work only on an operator-configured `INCREMENTAL` file, zero cost on the
  service's own default.
- **Checkpoint before vacuum** — §11.3's own order; the vacuum then operates
  on a database that already absorbed the WAL.

## `retention-cleanup.ts` — the §11.3 retention cleanup (task 091, spec §11.3, §7.4, §15.2, decision D-063)

`runRetentionCleanup({ repository, database }, { now, retentionDays })` is
§11.3's cleanup as one repeat-safe operation: it deletes every row the window
expired — through the facade's count-returning deletes (D-058), in one
transaction that also writes the §11.2 cleanup metadata — and then runs the
maintenance primitive. **Scheduling is not here**: when this runs (startup and
daily) is the server lifecycle's concern; the module takes an explicit `now`
and window (D-021 — the future scheduler computes them from the injectable
clock and the loaded configuration) and is safe to call back-to-back.
`test/integration/retention-cleanup.spec.ts` verifies the done-condition —
"startup and daily cleanup are safe to repeat" — by running the cleanup twice
over seeded multi-account history (identical input: the second run removes
nothing and changes nothing), then at a later `now` (only the newly expired
go), then at an earlier one (a harmless no-op).

| Table             | Time column   | Cutoff                     | Semantics                                                                                                               |
| ----------------- | ------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `collection_runs` | `started_at`  | `now − retentionDays` days | strictly before → deleted; the cascade takes the run's snapshot, metric values, snapshot-linked events, and raw payload |
| `quota_events`    | `event_at`    | same                       | strictly before → deleted (run-free rows and surviving runs' §12.1-dated events alike)                                  |
| `raw_responses`   | `captured_at` | `now − 30` days (§7.4)     | strictly before → deleted; the count excludes payloads a run cascade already took                                       |
| `sessions`        | `expires_at`  | `now` (§15.2)              | strictly before → deleted, independent of the history window                                                            |

- **The bounds are validated here, before any delete runs** — `retentionDays`
  must be an integer in 7–3650 (`MIN_RETENTION_DAYS`/`MAX_RETENTION_DAYS`);
  a rejected input deletes nothing. This is §11.3 policy the module owns at
  the storage boundary, not a replay of D-058's no-pre-validation rule (no
  schema CHECK can express a range about a query parameter); the config layer
  validates its own copy (`app.historyRetentionDays`).
- **The run is the retention unit** — snapshots and metric rows have no
  separate cutoff calls: a snapshot cannot outlive its run, and the report's
  run count covers the cascade (no O(history) counting reads at §11.3's
  ~52,000-snapshots-per-account scale; the series/history indexes those
  queries rely on are D-058's query-plan-pinned ones).
- **Raw payloads follow §7.4's own 30-day window** (`RAW_RESPONSE_MAX_AGE_DAYS`)
  — the time-based half of "no more than 20 per account and no more than 30
  days". The per-account 20-record cap is task 103's (`listRawResponses` +
  `deleteRawResponsesByRunIds`); this module never counts records, it only
  expires age.
- **Sessions follow §15.2, not the history window** — a session dies at its
  own `expires_at` (the D-056 CHECKs already cap that at 7 days of inactivity
  and 30 days of life); the delete is `expires_at < now`, whatever the window.
- **Deletes and markers commit as one transaction** — the last-run markers
  (`retention:last-run` = the run's `now`, `retention:applied-days` = the
  window applied) never claim a half-done cleanup; an injected marker-write
  failure rolls every delete back, and the next (startup/daily) run redoes
  the whole cleanup — the repeat-safety is by construction, verified by test.
- **Maintenance after the commit, unconditionally** — §11.3's order; the WAL
  the transaction grew is observable as a zero-byte `-wal` file after the
  call, also when the deletes removed nothing.
- **§11.3's "do not delete" is by construction** — no `accounts` row (active
  or archived), no configuration, no connection setting, and no `meta` key
  except the two markers is touched; expired history of archived accounts
  goes with the window (retention is a history rule), pinned by test.
- **The reduce-retention warning is a recorded hook, not built here** — the
  config/UI layer reads `retention:applied-days` and warns when a newly
  configured window is smaller: the records between the two windows are
  exactly what the next cleanup deletes.

## `backups.ts` — the automatic `VACUUM INTO` backup primitive (task 092, spec §5.6, §11.4, decision D-065)

`createAutomaticBackup({ database, backupDir, now })` writes one automatic
backup of the open database and enforces §5.6/§11.4's retention window:
"retain the three most recent automatic backups" (`AUTOMATIC_BACKUP_RETAINED_COUNT`).
A sibling of `maintenance.ts` — deliberately not part of it, per D-063's
separate-concerns rule: maintenance tends the live file, a backup is a
standalone copy written _before_ a risky change and kept _after_ it. Takes
the raw `DatabaseSync` (D-058: the facade never hands a connection back).

- **Location and naming.** Backups live in `<data>/backups/`
  (`automaticBackupsDir(dataDir)`; `AUTOMATIC_BACKUP_DIRNAME` is on-disk
  contract) as `backup-<epoch-ms>[-<seq>].sqlite`. The `-<seq>` suffix
  (1, 2, …) disambiguates same-instant names — SQLite's `VACUUM INTO`
  refuses an existing target (verified on the pinned runtime), and a fixed
  test clock or two startups in one millisecond would otherwise collide.
- **Ordering is parsed, never lexicographic.** Retention ranks by the
  `(timestampMs, seq)` parsed from the name (`listAutomaticBackups`,
  oldest first): a raw name sort would invert `backup-T` against
  `backup-T-1` (`'-'` sorts before `'.'`) and break on any future name
  width. The unsuffixed name is sequence 0 — the first of its instant —
  so same-instant generations evict in creation order.
- **Only automatic backups are ever evicted.** The naming grammar is the
  retention scope: an operator-placed file whose name is outside the
  grammar is invisible to listing and eviction alike (§11.4 says
  "automatic backups"), pinned by test.
- **Evict after the new backup exists — and never the new backup
  itself.** A failed creation (full disk, unwritable directory) costs no
  existing generation; fs errors propagate unwrapped (D-058 style) and
  the next migration re-runs retention over the same directory. The
  just-created backup is exempt from its own retention pass: ordering is
  by the name-parsed timestamp, and a clock reading _earlier_ than the
  retained window (an NTP step-back, or a same-instant revisit after the
  unsuffixed name was evicted) would sort the fresh image oldest and
  delete it — migrating with zero pre-migration backups exactly when the
  safety net matters (review finding, reproduced and pinned by test).
  The window keeps three total — the new backup plus the newest two
  others — converging back to the three-newest rule on subsequent runs.
- **Bound parameter.** The target path binds to `VACUUM INTO ?` — never
  interpolated into the SQL literal. The image is a complete standalone
  database (committed-but-uncheckpointed WAL content included, no `-wal`
  sidecar — both pinned by test); SQLite refuses the statement from
  inside a transaction (pinned by test), which the caller's ordering
  guarantees (see `startup-migrations.ts`).
- **Timestamps are writer-supplied** (D-021): `now` names the backup; a
  non-integer or negative value is rejected before the filesystem is
  touched — it would mint a name outside the grammar, invisible to
  retention. The backups subdirectory is created by the call (the §11.1
  database-file auto-create carve-out); a missing _data_ directory fails
  loudly with `ENOENT` rather than being re-created (the D-030 posture —
  task 074's lock path owns the data directory).

## `startup-migrations.ts` — §11.4's backup-then-migrate sequence and newer-schema refusal (task 092, decision D-065)

`runStartupMigrations({ database, dataDir, migrations, clock? })` is the
operation the future server startup wiring calls (the wiring, scheduling,
and process exit are later tasks'). Returns
`{ status, applied, backup? }`; the order of its steps **is** the contract:

1. **Read the version relation first** — `schemaVersionStatus`, read-only
   (it never even creates the journal table). `'newer'` throws
   `NewerSchemaError` — carrying `supportedVersion`, `appliedVersion`, and
   the `newerThanSupported` evidence, message naming both versions and the
   §5.6 remedy (`npm update -g quotameter`, restart) — **before any
   backup, migration, or runner construction**. The refusal path performs
   not one write: the main database file is byte-identical after it
   (pinned by test), which is §11.4's "leave the database unchanged" made
   strong. The runner must not be constructed before the check — D-027's
   construction creates the journal table, a write.
2. **`'up-to-date'` returns without touching anything** — no migrations
   pending means no backup (§5.6 guards _migrations_) and not even the
   journal-table write; the early return precedes runner construction,
   pinned by test.
3. **`'behind'` backs up only when a pre-migration state exists** —
   `appliedVersion > 0` runs `createAutomaticBackup` first, so a migration
   that fails midway still leaves the pre-migration image on disk for the
   next startup. A database with no tables at all — the fresh install —
   skips the backup: `VACUUM INTO` of an empty file protects nothing. The
   carve-out is emptiness, not the journal: a journal-less database with
   tables (a foreign file, a lost `schema_migrations`) **is** backed up —
   the pending migrations are about to transform that content (D-065,
   pinned by test).
4. **Then the D-027 harness applies pending migrations** — unchanged; a
   backup failure propagates before any migration runs, so the database
   stays at its current schema and the next startup retries the sequence.

`test/integration/startup-migrations.spec.ts` verifies the done-condition:
forward migration with a usable backup (opens independently, integrity ok,
contains the pre-migration schema and data), backup retention (exactly
three kept, oldest evicted, foreign files untouched, same-instant name
disambiguation, and the just-created backup never evicted by its own pass
— clock step-back and unsuffixed-name revisit included), the newer-schema
refusal (both versions named, database byte-identical, no backup directory
created), and interrupted-migration recovery (the backup and the
pre-migration state survive a failing migration; a corrected re-run
completes). The primitive's runtime contract is pinned there too:
committed-but-uncheckpointed WAL content lands in the standalone image,
and the in-transaction refusal.
