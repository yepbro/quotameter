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
