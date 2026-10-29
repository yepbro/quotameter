# Architecture decision overview

This page is the Stage-7 consolidation demanded by task 077 (spec §3, §8.1, §18):
the narrative that ties the individual decision-log entries into four coherent
stories —
the migration library, the package layout, the configuration contract, and the
provider boundaries — for a maintainer who was not there when they were made.

How this page relates to its neighbours:

- [`DECISIONS.md`](../../DECISIONS.md) is the **authoritative record**. Entries are
  immutable; each one captures the reasoning behind one decision at one moment. This
  page never overrides it — where the two disagree, the D-entry wins and this page is
  wrong.
- [`package-layout.md`](package-layout.md) says **which module owns what** and lists
  the executable import rules.
- [`trust-boundaries.md`](trust-boundaries.md) says **what is validated where**.
- This page says **why the architecture has the shape it has**, what each choice
  costs, and where its consequences were deliberately deferred to later tasks.

Every section ends with a **maintenance lens**: what future changes are cheap, what is
expensive, and what was deferred — with the task numbers where the deferred work
lands.

## 1. Migration library: Umzug over `node:sqlite`

**Decisions:** [D-002](../../DECISIONS.md), [D-027](../../DECISIONS.md) · **Spec:**
[§3](../../plan/SPECIFICATION.md), [§11.4](../../plan/SPECIFICATION.md) · **Tasks:**
078 (verification and harness), 079–092 (Stage 8)

The spec names the preference directly: "Migration library, preferably Umzug;
migrations are forward-only and recorded in the database" (§3). Task 078 verified the
preferred library against the built-in `node:sqlite` driver and found no blocker, so
the high bar for _rejecting_ the spec-preferred library was never approached: `umzug`
delivered a forward migration applied and recorded in a disposable database, with a
storage contract small enough — three methods, `logMigration` / `unlogMigration` /
`executed` — to implement over `DatabaseSync` without a second driver or shim
(D-027).

What the harness (`src/storage/migrations.ts`) actually adopts from Umzug is its
**semantics**, not its machinery. Migrations arrive as an injected typed array — never
file globs — because the shipped package must not perform install-time builds or
filesystem assumptions (§3 packaging), and because glob/TypeScript-loading machinery
has no place in the runtime path. Since Umzug sorts glob inputs but not injected
arrays, the runner itself applies **name order** deterministically and validates the
list (blank/duplicate names, non-function `up`) at construction, before touching the
database — the fail-fast wiring-check style the registry already uses (D-013).

Two safety properties are structural rather than conventional:

- **Forward-only.** `unlogMigration` exists only to satisfy the library's storage
  contract; the runner exposes no `down`. Rolling back means restoring a backup and
  re-running — which is exactly why §11.4's pre-migration backups exist (task 092).
- **Atomic per-migration journaling.** Each migration runs inside one
  `BEGIN IMMEDIATE` … `COMMIT` transaction that spans both the migration body _and_
  its journal insert, so "applied but unrecorded" and "recorded but not applied" are
  unreachable states. A failed migration rolls back whole and stays pending for the
  next startup. This is the interrupted-write standard D-016 set for the config file,
  applied to schema changes; the transaction lives in the runner because Umzug's
  fixed `up()`-then-`logMigration()` sequence must be spanned by one caller-owned
  transaction.

The trade-offs were recorded honestly in D-027 rather than glossed over:

- **Dependency footprint.** `umzug` is a runtime dependency with five direct and
  roughly twenty-five transitive packages — including, via `@rushstack/ts-command-line`,
  the Rushstack CLI stack — for a product whose spec says "keep runtime dependencies
  minimal" (§3). It is MIT-licensed, pure JavaScript, free of native modules and
  install scripts, and clean under `npm audit --omit=dev`; the package is CJS-only
  and consumed through Node's ESM interop. Smaller than it looks for what it buys,
  but the cost is on the record.
- **No down path.** Forward-only is a spec rule (§3), and the harness encodes it by
  omitting the API rather than by convention. The cost — a bad migration cannot be
  reverted in place — is paid back by task 092's `VACUUM INTO` backups with
  three-generation retention and by the newer-schema refuse-to-start check.

**Maintenance lens.** _Cheap:_ adding a migration — a typed array entry with a
`000N-`-prefixed name and statements through `context.database` (the pattern tasks
080–087 follow); re-runs are no-ops, ordering is automatic, and the integration tests
pin the semantics. _Expensive:_ touching the `schema_migrations` table or its columns
— it is an on-disk contract, and renaming it requires a successor decision to D-027.
_Deferred:_ pre-migration backups, retention, and the newer-schema refusal land in
task 092; the connection and its pragmas (§11.1) belong to task 079; no separate
migration lock is needed because migrations run at startup under the single-instance
lock (D-017).

## 2. Framework and package layout

**Decisions:** [D-002](../../DECISIONS.md), [D-009](../../DECISIONS.md) · **Spec:**
[§3](../../plan/SPECIFICATION.md), [§8.1](../../plan/SPECIFICATION.md) · **Task:**
059

The stack itself is D-002: one runtime (Node.js ≥ 22.13.0, TypeScript strict) for
server, CLI, tooling, and tests; Fastify and Vue 3 at the edges; history in a single
SQLite file through the built-in `node:sqlite` module, so a one-VPS deployment
carries no second database process to upgrade, back up, or secure.

The interesting decision is the layout on top of that stack (D-009). `src/` is
organized into layers — `schemas` and `util` as leaves that import nothing, then
`config`, `providers` (shared core plus one subdirectory per adapter), `storage`,
`services`, and the two top-level consumers `server` (composition root) and `cli` —
forming a DAG with a one-way dependency table. The table itself lives in
[`package-layout.md`](package-layout.md); the point to understand here is _why the
rules are executable_.

Spec §8.1 demands that adding a provider "must not require rewriting the scheduler,
persistence, history endpoints, or chart components". D-009's reading: only a
mechanical import boundary makes that guarantee instead of a hope.
`test/unit/package-layout.spec.ts` resolves every relative import in `src/`, `ui/`,
and `bin/` and fails `make check` on any forbidden dependency — wrong layer
direction, cross-adapter import, `node:sqlite` outside `src/storage/` (the §3
isolation rule), a loose file at `src/` root, a runtime import from `ui/` into
server code, or `bin/` reaching past `src/cli/`. The same decision settled a spec
ambiguity: §8.1 names `QuotaRepository` among the "core services", so it is
implemented as the storage layer's public facade — services consume it, but all SQL
stays behind the one database gate.

The layout's costs are real and were accepted knowingly:

- **The leaf rule forces deliberate duplication.** `schemas` and `util` cannot import
  each other, so the IANA time-zone validator exists as a tested twin on both sides
  (D-021), held together by a parity test instead of an import. The friction is the
  point: it fails loudly at `make check` if either twin drifts.
- **Islands are unreachable except through the front door.** An adapter is registered
  only by the composition root and consumed only through the registry — convenient
  isolation, at the price of a wiring step that cannot be skipped.
- **The `ui/` project shares contracts, not code.** Only type-only imports from
  `src/schemas/**` are allowed, so the client and server consume the same canonical
  shapes while the browser bundle stays free of server code.

**Maintenance lens.** _Cheap:_ placing new code — the layout document's
"Adding a module or provider" checklist is mechanical by construction, and the
planned-placement table let parallel plan tasks target disjoint file sets.
_Expensive:_ changing the DAG itself — adding a layer or re-pointing import directions
means a D-009 successor decision and a structural-test update, not a refactor.
_Deferred:_
the publishing shape (compiled output, `files` allowlist, build-artifact checks) is
owned by tasks 184–186 and must respect the packaging constraints recorded in
`package-layout.md`.

## 3. Configuration contract

**Decisions:** [D-004](../../DECISIONS.md), D-011/D-012, [D-014](../../DECISIONS.md)
through [D-016](../../DECISIONS.md), [D-018](../../DECISIONS.md),
[D-019](../../DECISIONS.md), [D-022](../../DECISIONS.md), [D-023](../../DECISIONS.md),
[D-026](../../DECISIONS.md) · **Spec:**
[§6](../../plan/SPECIFICATION.md) · **Tasks:** 061–068, 073

The configuration area accumulated the most decisions because it concentrates the
project's risk: a hand-edited file that carries secrets, is read at startup, re-read
on reload, overridden by the environment, and exposed to the UI.

**One contract source, two consumers.** The TypeBox contract in `src/schemas/config.ts`
is the single source of truth (D-014). The runtime validator is Ajv, compiled once
with the 2020-12 variant — required because TypeBox emits the numeric
`exclusiveMinimum` that draft-07 Ajv rejects — and paired with a parity test against
TypeBox's own `Value.Check` (D-018). The same source feeds the published JSON Schema
at `schema/config.schema.json`: a **committed, generated** artifact (D-015), produced
by deterministic serialization outside the container (which must never write into the
repository tree) and verified by a read-only freshness test — a build-time output
would either violate the container invariant or move the guarantee out of
`make check`.

**Structure in schemas, invariants in one checker.** JSON Schema cannot express the
cross-field rules (exactly one secret source per account, unique ids, IANA validity,
`start < end`, window overlap, the password rule for non-loopback binds) without
unreadable `oneOf`/`if-then` constructs, so they live in one `findConfigProblems`
checker beside the schemas (D-014). Defaults are annotated in the schemas and
mirrored in one `CONFIG_DEFAULTS` constant with a drift test; the loader applies them
in an explicit pass rather than Ajv's `useDefaults`, relying only on documented
validator behavior and keeping the parser's input immutable (D-018). The published
schema is honest about the split: it carries the structural keywords and says so —
a config that passes the schema may still be rejected at startup (D-015).

**Secrets have one home and a hardened write path.** Secrets live in the config file
— never in the database, whose files are the artefact most likely to be copied into
backups and bug reports (D-004). Writes are atomic (temp file, `fsync`, `rename`)
with the mode pinned to exactly `0600` on every write, defeating the umask and
refusing to inherit or perpetuate drift (D-016). Startup enforcement (D-019)
demands exact modes, fixes what it can with a re-verified `chmod`, creates missing
directory levels one explicit `0700` at a time (a single recursive `mkdir` fails
under a umask like `0177`), and refuses on the uncorrectable — foreign ownership,
symlinked final objects, a filesystem that ignores modes. Errors everywhere are
field-addressed and **value-free**: paths, limits, and type names, never data — the
loader even strips the input snippet V8 embeds in `JSON.parse` messages, because a
broken line could quote a secret (D-018).

**The environment joins through the same parser.** Exactly seven scalar settings are
overridable, with variable names that mechanically mirror the field path
(`QUOTAMETER_APP_POLLING_INTERVAL_SECONDS`); overrides splice onto the parsed file
input and the whole result re-enters `parseConfig`, so an environment value fails
exactly like a file value and cross-field rules hold for the _effective_
configuration (D-023). Unknown `QUOTAMETER_*` names are rejected — a typo must fail,
extending the closed-contract philosophy from keys to variables. Environment-only
operation works when the file is absent, and the environment never masks a broken
file. The result reports which fields and account secrets came from the environment
so the UI can mark them read-only.

**Reload keeps the incumbent.** The reloader (D-026) re-runs the whole pipeline,
classifies every field of the contract per §6.4 (`applied` / `pending-restart` /
`rejected` — a coverage test fails if a new field arrives without a classification),
swaps the effective configuration in one synchronous step, and never rejects for
configuration problems: the last valid configuration stays active. Two diff baselines
keep the reports honest — `applied` diffs against the previous effective
configuration, `restartRequired` against what the process actually bound at startup.
Reloads serialize on an internal promise chain, so a SIGHUP burst applies every time.

One layer above, the service boundary `validateSettings` (D-022) exists only because
prompt/CLI answers are strings with blank-means-keep semantics; every range, enum,
and cross-field check is delegated back to the landed parser instead of being
restated — the single-checker rule again.

**Maintenance lens.** _Cheap:_ adding a configuration field — a schema entry, a
`CONFIG_DEFAULTS` row, a `RELOAD_FIELDS` row, and a CHANGELOG entry; the drift,
freshness, and coverage tests catch forgotten pieces. _Expensive:_ moving or renaming
the published schema path (users' editor associations depend on it — a breaking
change needing a D-015 successor), rewording problem messages (pinned by tests as
part of the English-only contract), and adding environment overrides (a closed set
that grows only through a decision, per D-023). _Deferred:_ erase semantics for
stored values and the server-side merge that must protect stored account secrets
from a naive GET-then-PUT settings client — both recorded in D-022's consequences
and owned by the Stage-12 `ConfigService`; a possible schema-level rejection of
`apiKeyEnv` values starting with `QUOTAMETER_` is documented as a reservation in
D-023 pending a future decision.

## 4. Provider boundaries

**Decisions:** [D-003](../../DECISIONS.md), [D-010](../../DECISIONS.md),
[D-013](../../DECISIONS.md), [D-025](../../DECISIONS.md) · **Spec:**
[§8.1](../../plan/SPECIFICATION.md), [§8.4](../../plan/SPECIFICATION.md) · **Tasks:**
069, 070; Stage 9 (093–111)

Quota APIs differ per vendor and change independently, so providers are integrated
as isolated adapters behind a stable interface, with exactly one adapter — Z.ai
Coding Plan — shipping in v1.0 to keep the MVP verifiable end-to-end (D-003). The
adapter doubles as the reference implementation.

The model has three load-bearing pieces:

- **The registry is pure and fail-fast** (D-013). `ProviderRegistry` knows nothing
  about polling, storage, or transport — a mock provider registers and runs through
  it with none of that code existing, which was task 070's done-condition. Its checks
  target trusted wiring, not untrusted input: duplicate or blank ids, non-function
  methods — registration mistakes — throw at startup rather than surfacing at the
  first poll. `list()` returns a fresh array in registration order, giving polling a
  deterministic sequence.
- **Adapters are islands** (D-009's rule, restated as the provider-facing promise).
  An adapter imports no other adapter and is imported by nothing outside
  `src/providers/` except the composition root that registers it. Its untrusted HTTP
  payloads are validated by adapter-local schemas (trust boundary 2) and normalized
  into the §8.4 snapshot model (D-010) — a pure TypeScript contract with closed
  enums, explicitly listed derived fields, and per-metric validity, so the rest of
  the system never sees vendor shapes.
- **Secrets travel one path and never leave it.** A provider secret flows from the
  config layer through services into the adapter inside an `AccountContext` whose
  `secret` is non-enumerable, read-only, and constructible only through the factory —
  branding makes the factory the only construction path, so the guarantee cannot be
  bypassed with an object literal, and the accidental leak vectors
  (`JSON.stringify`, `util.inspect`, spread) come up empty (D-013). The exit side is
  the two-layer redacting logger (D-025): the wrapper every first-party call site
  uses deep-sanitizes messages and payloads — key names at any depth, known secret
  values, error cause chains — before Pino sees them, while a Pino-side redaction
  layer guards the raw instance exposed to integrations. Together with D-004
  (secrets never enter the database), the result is that no storage, log, or backup
  artefact contains a key by construction.

The §8.1 promise — adding a provider means implementing and registering an adapter,
nothing else — is therefore enforced from two directions at once: the structural
import test makes "nothing else" true mechanically (§2 of this page), and the
normalized snapshot model (D-010) means persistence, history endpoints, and charts
consume a stable provider-neutral shape. The cost of that stability is the model's
own closedness: adding an enum value or derived field is a code change plus a
database migration (§8.4) — cheap enough to be deliberate, expensive enough to
prevent casual drift.

**Maintenance lens.** _Cheap:_ a new provider — an island directory implementing the
contracts, one registration line in the composition root, fixtures, and a
`docs/providers/<id>.md` contract page; no scheduler, persistence, API, or chart
changes. _Expensive:_ extending the normalized model (enum values, derived fields —
code plus migration plus every adapter that maps into it), and changing the
`AccountContext` construction rules (a D-013 successor). _Deferred:_ runtime
validation of snapshot contents at the polling boundary (task 093+, explicitly not
the registry's job), the shared transport and response sanitization modules (Stage
9, tasks 093–111), and the Z.ai reference adapter itself with its verified API
contract documentation (tasks 096 and 127).

## 5. Cross-cutting themes

Four patterns recur across all four areas. They are the practical content of the
architecture — the D-entries apply them to specific problems, but a maintainer can
apply the same patterns to new ones:

- **Construction gates and branded types.** Values that carry a guarantee — a
  validated config, an `AccountContext`, a resolved IANA zone — are branded and
  constructible only through a factory that enforces the guarantee
  (`Validated<T>` in `src/schemas/boundary.ts`). Downstream code cannot express the
  unvalidated state. See D-013, D-018, D-021.
- **Loud failure over guessing.** Where an ambiguity would otherwise be resolved by
  silently guessing — a relative `HOME`, a missing config directory, a duplicate
  provider id, a typo'd environment variable — the implementation throws or refuses
  with an actionable English message. Guessing is reserved for nothing: paths that
  could hold secrets fail loudest (D-011/D-012, D-016, D-019, D-013, D-023).
- **Executable invariants.** Every rule that matters to maintenance has a test that
  fails when it is broken: the import-direction test (D-009), the defaults drift and
  schema-freshness tests (D-014/D-015), the Ajv/TypeBox parity test (D-018), the
  IANA twin parity test (D-021), the reload classification coverage test (D-026),
  the migration semantics suite (D-027). Conventions that cannot break the build are
  treated as not yet decided.
- **Injectable seams.** Time (clock), filesystem, environment snapshots, logger, and
  readiness callbacks are injected facts, never ambient state — which is what keeps
  the modules unit-testable and what let the child-process lifecycle tests close a
  real race (D-024).

One meta-rule sits above all four: interpretation doubts are settled from the text
of `plan/SPECIFICATION.md`, and the settlement is recorded in `DECISIONS.md` with
its spec reference. Every entry cited on this page carries one. When a future change
challenges a decision recorded here, the path is not to edit it — it is to write the
next D-entry, referencing the old one, and to update this overview to match.
