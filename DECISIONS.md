# Quotameter — Decision Log

This file records important technical and business decisions made during development: what was decided, why, and what it means for the project. It complements the [Technical Specification](plan/SPECIFICATION.md) (the full requirements baseline) and the [Implementation Task Plan](plan/tasks.md).

**Rules:**

- Entries are immutable once accepted; a reversed or replaced decision gets a new entry that references the old one.
- Every entry has a unique stable ID (`D-NNN`), a date, and a status (`Accepted`, `Superseded by D-NNN`, `Reversed`).
- Decisions live here even when they are also described in the specification; this file records the _reasoning_, not the full requirements.

---

## D-001 — Single-user, self-hosted product shape

**Date:** 2026-10-28 · **Status:** Accepted · **Spec:** [§1](plan/SPECIFICATION.md#1-purpose-and-scope)

**Decision.** Quotameter is a personal self-hosted service operated by one person on their own Linux VPS. There is no registration, user directory, roles, or multi-user features, and it is not a hosted/cloud service.

**Reasons.** The tool exists to monitor the author's own AI subscription quotas; multi-tenancy adds auth complexity, attack surface, and operational burden with no benefit for the target user.

**Consequences.** Authentication is a single optional password with hardened `auto`/`required` modes instead of an account system. Data model, UI, and deployment assume one operator. A future hosted offering would be a new product, not an extension.

## D-002 — Node.js/TypeScript stack with built-in `node:sqlite`

**Date:** 2026-10-28 · **Status:** Accepted · **Spec:** [§3, §11](plan/SPECIFICATION.md#3-technology-and-packaging)

**Decision.** Server and tooling run on Node.js `>=22.13.0` with TypeScript in `strict` mode; the web layer uses Fastify and Vue 3; history is stored in SQLite through the built-in `node:sqlite` module. No external database process, ORM-free direct usage per the spec.

**Reasons.** One runtime covers the server, CLI, build tooling, and tests. `node:sqlite` imports without the `--experimental-sqlite` flag starting from Node.js 22.13.0, removing a separate database service and its upgrade/backup surface from a single-VPS deployment.

**Consequences.** The minimum supported Node version is pinned at 22.13.0 and must be verified in CI and clean-install tests. Data lives in a single SQLite file, enabling simple `VACUUM INTO` backups. Any feature requiring a richer data engine must justify abandoning this simplicity.

## D-003 — Provider adapter architecture; Z.ai Coding Plan only in v1.0

**Date:** 2026-10-28 · **Status:** Accepted · **Spec:** [§1, §8](plan/SPECIFICATION.md#8-provider-architecture-and-zai-adapter)

**Decision.** Providers are integrated as isolated adapters behind a stable provider interface. Version 1.0 ships exactly one adapter: Z.ai Coding Plan. Multiple accounts per provider (including several Z.ai accounts) are first-class.

**Reasons.** Quota APIs differ per vendor and change independently; isolating them keeps the polling engine, persistence, history API, and charts provider-agnostic. Shipping one production adapter keeps the MVP verifiable end-to-end.

**Consequences.** Adding a provider must not require changes outside its adapter (plus configuration schema entries). The Z.ai adapter doubles as the reference implementation; its verified API behavior is documented separately in `docs/providers/`.

## D-004 — Secrets live in the config file, never in the database

**Date:** 2026-10-28 · **Status:** Accepted · **Spec:** [§6.3, §15.4](plan/SPECIFICATION.md#63-secret-storage-and-writes)

**Decision.** API keys and the password hash are stored in the JSON config file with mode `0600` (directory `0700`), not in SQLite. `apiKeyEnv` is an alternative to `apiKey`; exactly one may be set per account. Config writes are atomic (temp file, `fsync`, `rename`).

**Reasons.** Database files are the artefact most likely to be copied into backups, bug reports, and diagnostics; keeping secrets out of them limits exposure. A single sensitive file with enforced permissions is easier to reason about and to protect.

**Consequences.** Database backups and sanitized raw responses are secret-free by construction. The config file becomes the one object requiring strict permission checks at startup (fix or refuse). UI key inputs are write-only; only masked state is ever displayed.

## D-005 — Public repository with English-only artefacts

**Date:** 2026-10-28 · **Status:** Accepted · **Spec:** [§4.1](plan/SPECIFICATION.md#41-public-repository-and-language)

**Decision.** The source repository is public on GitHub (`yepbro/quotameter`, default branch `master`) from day one, and every repository artefact is in English: branches, issues, PRs, commit messages, code comments, docs, UI strings, CLI output, API errors, and logs.

**Reasons.** Public development from the start enables community contributions and verifiable releases. A single language avoids mixed-language drift across code, docs, and support threads.

**Consequences.** Non-English contributions must be reworked before merge. All user-facing strings, including logs and errors, are part of this contract and are tested/reviewed accordingly.

## D-006 — Repository workflow: protected `master`, squash-only merges, minimal Actions token

**Date:** 2026-10-29 · **Status:** Accepted · **Tasks:** [003–005](plan/tasks.md)

**Decision.** `master` is protected: pull requests and a required `CI` status check are enforced before merging, force-pushes and branch deletion are disallowed. Only squash merges are allowed and branches are deleted on merge. The GitHub Actions default token is read-only (`read`), and workflows must request additional permissions explicitly.

**Reasons.** Linear, one-commit-per-change history matches the Conventional Commits convention and keeps `git log` and releases auditable. A read-only default token limits the blast radius of a compromised or malicious workflow.

**Consequences.** Every contribution lands as exactly one squashed Conventional Commit. Until the CI workflow exists, the required `CI` check holds PRs open — accepted as preventive. Admin enforcement is currently off to permit direct bootstrap pushes during Stages 0–1; it will be revisited once CI is live.

## D-007 — MIT License with attribution to the prototype author

**Date:** 2026-10-28 · **Status:** Accepted (pending provenance verification) · **Spec:** [§4.3](plan/SPECIFICATION.md#43-license-and-attribution)

**Decision.** The project uses the MIT License, with `LICENSE` and `NOTICE` files attributing the original prototype author: Den Brooks, `denis@yepbro.pro`.

**Reasons.** MIT is permissive, npm-ecosystem-friendly, and compatible with the widest range of dependencies.

**Consequences.** No prototype code may be copied until its provenance and license compatibility are verified. Every bundled third-party component must pass a license check in CI before release.

## D-008 — Releases are published only from CI on version tags

**Date:** 2026-10-28 · **Status:** Accepted · **Spec:** [§4.4](plan/SPECIFICATION.md#44-cicd-and-supply-chain-safeguards)

**Decision.** npm publication happens only from GitHub Actions, only on a pushed `vX.Y.Z` Git tag, using trusted publishing with provenance. Versioning follows semver; a `CHANGELOG.md` is maintained.

**Reasons.** Tag-gated, CI-only publishing makes releases reproducible and auditable, prevents accidental local publishes, and attaches provenance attestations required for supply-chain trust.

**Consequences.** No local `npm publish` workflow exists by design. Every release requires a green CI run on the tagged commit; package content is restricted by a `files` allowlist and audited (`npm audit --omit=dev`, license checks) before publication.

## D-009 — Layered `src/` package layout with enforced import direction

**Date:** 2026-10-29 · **Status:** Accepted · **Spec:** [§3, §8.1](plan/SPECIFICATION.md#3-technology-and-packaging) · **Tasks:** [059](plan/tasks.md)

**Decision.** Server-side code is organized into layer directories under `src/` — `schemas`, `util`, `config`, `providers` (shared core + one subdirectory per adapter), `storage`, `services`, `server` (composition root), `cli` — with a one-way dependency table: leaves (`schemas`, `util`) import nothing; adapters are islands reachable only through the registry and wired only by the composition root; `bin/` stays a build-free launcher over `src/cli/`. The map and rules live in [docs/architecture/package-layout.md](docs/architecture/package-layout.md) and are enforced mechanically by `test/unit/package-layout.spec.ts`, which resolves every relative import in `src/`, `ui/`, and `bin/`. `ui/` may consume `src/schemas/**` only through type-only imports; it has no runtime dependency on server code.

**Reasons.** Spec §8.1 requires that adding a provider never rewrites the scheduler, persistence, history endpoints, or charts — only a mechanical import boundary makes that guarantee instead of a hope. Spec §3 requires all `node:sqlite` access isolated behind a storage module. A second interpretation was settled here: §8.1 names `QuotaRepository` among the "core services", so it is implemented as the storage layer's public facade — services consume it, but all SQL stays in `src/storage/`.

**Consequences.** Parallel plan tasks target disjoint file sets by construction (each task's placement is listed in the layout doc; directories may repeat across sequential stages). `src/version.ts` moved to `src/util/version.ts` so no loose files sit at `src/` root. Forbidden or unresolved relative imports, cross-adapter imports, and `node:sqlite` usage outside `src/storage/` fail `make check`. Publishing (compiled output, `files` allowlist) remains owned by tasks 184–186 and must respect the documented packaging constraints.

## D-010 — Normalized metric model interpretations (spec §8.4)

**Date:** 2026-10-29 · **Status:** Accepted · **Spec:** [§8.4](plan/SPECIFICATION.md#84-normalized-snapshot-and-metric-model) · **Tasks:** [069](plan/tasks.md)

**Decision.** Three interpretations of the §8.4 sketch are pinned in `src/schemas/metrics.ts`: (1) `derivedFields` is a closed union of the five numeric metric fields (`used`, `remaining`, `limit`, `percentUsed`, `percentRemaining`), not the sketch's `string[]`; (2) "an invalid metric is stored without numeric values" covers exactly those five quota-value fields — `windowSeconds` and `resetsAt` are metadata an invalid metric may still carry; (3) the model is pure TypeScript without TypeBox, because it is the validated _output_ of trust boundary 2, not a validation schema.

**Reasons.** (1) §8.4 asks for "derived field names" — names of the metric's own fields; the closed set gives adapters compile-time checking, enables a runtime guard for database read-back, and makes the "listed as derived but not set" invariant expressible; the sketch is prefixed "equivalent to", which allows strengthening. (2) The parenthetical "(not as zero)" targets quota placeholders — the failure mode is unknown quota being recorded as 0 — while a window length or reset schedule can remain known when a reading fails, and discarding it would lose provider information. (3) Runtime validation of provider payloads is adapter-local (Stage 9, trust boundary 2); TypeBox enters the repository with the configuration contract (task 061), so the normalized model needs no dependency.

**Consequences.** Storage (tasks 078+) mirrors these rules in its constraints: invalid rows NULL the five quota columns and require `invalid_reason`; `window_seconds`/`resets_at` may be retained. Adding an enum value or derivable field remains a code change plus a database migration (§8.4). Adapters list derivations explicitly and only for fields computed from supplied originals.

## D-011 — XDG path resolution semantics (spec §6.1)

**Date:** 2026-10-29 · **Status:** Accepted · **Spec:** [§6.1](plan/SPECIFICATION.md#61-paths) · **Tasks:** [063](plan/tasks.md)

**Decision.** `src/config/paths.ts` resolves directories with the precedence `QUOTAMETER_CONFIG_DIR`/`QUOTAMETER_DATA_DIR` → `XDG_CONFIG_HOME`/`XDG_DATA_HOME` + `quotameter` segment → `<home>/.config/quotameter` / `<home>/.local/share/quotameter`. Five edge rules are pinned: (1) an empty string counts as unset for all four variables (the XDG wording "either not set or empty", applied uniformly); (2) a `QUOTAMETER_*` value is the directory itself — no `quotameter` segment is appended — because it replaces the whole path the way `AWS_CONFIG_FILE` does, not the base the way `XDG_CONFIG_HOME` does; (3) relative `XDG_*` values are ignored (default applies) because the XDG Base Directory Specification requires absolute paths and leaves relative ones undefined — silently honoring them would make secret-bearing paths depend on the working directory; (4) relative `QUOTAMETER_*` values are honored, anchored to the current working directory via `path.resolve`, because silently discarding an explicit override could redirect secrets back to the default location; (5) the home directory is a non-empty `HOME` from the injected environment snapshot, else `os.homedir()`, and resolution throws when neither yields a value rather than producing a relative default.

**Reasons.** §6.1 names the variables and defaults but not the edge behavior; these choices keep resolution pure and deterministic (environment and home lookup are injectable, so unit tests never mutate `process.env`), keep results absolute and normalized in every branch, and prefer loud failure over guessing where secrets are stored.

**Consequences.** Consumers (config loading 064, permissions/startup 066, `init` CLI) receive only directory paths — file naming (`config.json`) stays with 064 and directory creation/permission enforcement with 066. Deployments that set a relative `QUOTAMETER_*` value get working-directory-anchored paths; deployments with a broken `HOME` get a startup error explaining the home-directory lookup.

## D-012 — Absolute-home requirement and verbatim values in path resolution (refines D-011)

**Date:** 2026-10-29 · **Status:** Accepted · **Spec:** [§6.1](plan/SPECIFICATION.md#61-paths) · **Tasks:** [063](plan/tasks.md) · **References:** D-011

**Decision.** Two refinements of D-011, from the review of task 063. (1) The home directory behind the XDG defaults must be an **absolute** path: a `HOME` that is empty or relative is skipped in favor of the `os.homedir()` fallback — the same fall-through D-011 applies to relative `XDG_*` values — and resolution throws when the fallback is also empty or relative. (2) All variable values are used **verbatim**: a leading `~` is not expanded (matching the XDG Base Directory Specification, which performs no shell expansion), so `QUOTAMETER_CONFIG_DIR=~/conf` denotes a directory literally named `~` under the current working directory.

**Reasons.** (1) With a relative `HOME`, D-011's implementation returned a relative, cwd-dependent default path — contradicting its own "results absolute and normalized in every branch" guarantee and reproducing exactly the cwd-dependent-secrets failure mode that motivated ignoring relative `XDG_*` values; a loud failure is preferable to guessing where secrets are stored. (2) Tilde expansion would import shell semantics (leading `~/` only? `~user`?) that directory-valued environment variables, including the XDG specification itself, do not provide; documenting the verbatim rule is the consistent choice, and the review's only objection was the silent middle ground.

**Consequences.** `src/config/paths.ts` returns an absolute path in every branch or throws. Environments with a relative `HOME` and no usable OS lookup fail with an explanation instead of writing secrets relative to the working directory. The `init`/config documentation (tasks 064, 128) should state that override values are taken verbatim and that `~` is not expanded.

## D-013 — Provider registry semantics and log-safe AccountContext (spec §8.1)

**Date:** 2026-10-29 · **Status:** Accepted · **Spec:** [§8.1](plan/SPECIFICATION.md#81-provider-interface) · **Tasks:** [070](plan/tasks.md)

**Decision.** `src/providers/registry.ts` pins four interpretations the spec leaves open: (1) `ProviderRegistry.register` **throws** on a duplicate provider id — and on a blank or whitespace-padded id, a blank name, or non-function methods — instead of replacing or ignoring: registration happens once in the composition root, so a wiring bug must fail at startup rather than silently route accounts to the wrong adapter or surface at the first poll; (2) `get` throws for an unknown id with the registered ids listed, and `has`/`list` support the non-exceptional paths — `list()` returns a fresh array in registration order, giving polling a deterministic sequence; (3) `AccountContext` is a **branded** type (the `Validated<T>` pattern from `src/schemas/boundary.ts`) constructible only through `createAccountContext`, which rejects blank fields, defines `secret` as non-enumerable and read-only, and freezes the object; (4) `QuotaProvider.fetchSnapshot` returns the §8.4 `ProviderSnapshot` from `src/schemas/metrics.ts` unchanged, and the registry performs no runtime validation of snapshot contents — that is the polling service's job (task 093+).

**Reasons.** (1)/(2) The registry's only writers are trusted, compile-time-checked call sites, so its runtime checks target startup wiring mistakes and diagnosability, not untrusted input. (3) Spec §8.1 requires that secrets "remain in process memory and must not be logged": non-enumerability defeats the accidental leak vectors (`JSON.stringify`, `util.inspect`, object spread), branding makes the factory the only construction path so the guarantee cannot be bypassed by building a plain object literal, and error messages never echo values. This is defense at the type/object layer; the exit-side counterpart is the redacting logger (task 072, §15.4). (4) Keeps the registry pure — a mock provider registers and runs through it without any polling, storage, or transport code existing (the task-070 done-condition).

**Consequences.** Future adapters implement `QuotaProvider` and are registered by the composition root; nothing else changes (D-003). Services build `AccountContext` values from validated configuration (boundary 3) via the factory and may hand the object to log calls or spread it — only safe fields travel. Registry error messages are part of the English-only contract and are pinned by tests.

## D-014 — Configuration contract interpretations (spec §6.2)

**Date:** 2026-10-29 · **Status:** Accepted · **Spec:** [§6.2](plan/SPECIFICATION.md#6-configuration-and-secrets) · **Tasks:** [061](plan/tasks.md)

**Decision.** The configuration contract in `src/schemas/config.ts` pins these interpretations of §6.2 and its neighbors: (1) **schema/invariants split** — structural rules (types, ranges, patterns, closed enums) live in TypeBox schemas; cross-field rules (exactly one secret source per account, unique account/window ids, IANA time zone validity, `start < end`, same-day window overlap, password required for non-loopback binds or `auth.mode: required`) live in one `findConfigProblems` checker, mirroring the `metrics.ts` precedent (D-010); task 064 composes both into a boundary parser. (2) **Field naming** carries units explicitly (`pollingIntervalSeconds`, `historyRetentionDays`, `requestTimeoutSeconds`); spec §6.2's key names are illustrative, not a contract. (3) **Defaults** are annotated inside the schemas (JSON Schema `default`) and mirrored in one `CONFIG_DEFAULTS` constant with a drift test; `app` is the only required section because `app.timezone` is mandatory and must never be defaulted (§10). (4) **`additionalProperties: false` everywhere**: the file is hand-edited and reloaded (§9.2), so typo'd keys must fail, not silently pass. (5) **Exactly one secret source is an invariant, not a `oneOf` union** — both fields stay optional strings so the derived `AccountConfig` type stays ergonomic for consumers. (6) **The schema is provider-agnostic**: Z.ai's `offPeakMultiplier: 0.5` (§9.1) is seeded data in init/example config, never a schema constraint; `peakHours` is required per provider entry with possibly-empty `windows` (§9.2 "not configured"), and window `multiplier` defaults to `1.0` like `offPeakMultiplier` (§9.2 says "multipliers" plural). (7) **`requestTimeoutSeconds` (5–60, default 15) lives in provider config** because §7.2 fixes the range for provider HTTP requests. (8) **IANA validity follows `Intl` resolution** (aliases, `UTC`, V8's case-insensitive lookup) minus ECMA-402 offset identifiers such as `+03:00` — the same resolver the display path uses. (9) **Account ids and provider record keys are constrained to `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`** because both appear in API paths (§13); the provider record is closed (`additionalProperties: false` alongside `patternProperties`), since a key matching no pattern would otherwise be unconstrained under JSON Schema semantics and skip validation entirely (found in review); loopback for the password rule is `localhost`, `127.0.0.0/8`, `::1` (§15.1/§15.3).

**Reasons.** (1) JSON Schema cannot express the cross-field rules without unreadable `oneOf`/`if-then` constructs, and the project already has a "problems" vocabulary for them (`boundary.ts`); encoding the rules once keeps the config loader, CLI `doctor` checks, and future UI validation from diverging. (2)(3) Explicit units and one defaults source prevent unit confusion and drift between the published JSON Schema (task 062) and applied values (task 064). (4) Silent-ignore of unknown keys is the classic hand-edited-config failure mode. (5) A union type would force narrowing on every consumer for two plain-string fields. (6) Hardcoding vendor values into the contract would violate the provider-agnostic architecture (D-003). (7) The timeout governs provider HTTP calls, so it travels with the provider section and stays independently configurable per provider. (8) Rejecting what `Intl` accepts (or accepting offsets it also accepts) would make config validation disagree with the rendering path.

**Consequences.** Tasks 062–068 and 112 consume these export names unchanged (`ConfigSchema`, section schemas, `Config` types, `CONFIG_DEFAULTS`, `findConfigProblems`, closed enums for UI selects). Adding a configuration field is a schema change plus a `CHANGELOG` entry; adding a provider-specific constraint belongs in provider data, not here. Secrets remain opaque strings: no pattern, no transformation, no echo.

## D-015 — The configuration JSON Schema is a committed generated artifact (spec §6.2)

**Date:** 2026-10-29 · **Status:** Accepted · **Spec:** [§6.2, §18](plan/SPECIFICATION.md#62-configuration-contract) · **Tasks:** [062](plan/tasks.md) · **References:** D-014

**Decision.** The published JSON Schema is `schema/config.schema.json` — a **committed, generated** file, not a build-time output. (1) **Source of truth:** `CONFIG_SCHEMA_DOCUMENT` in `src/schemas/config.ts` (an additive export: the contract schema spread under `$schema: draft 2020-12`, `title`, and a `description` marking it structural-only; no `$id` until a canonical distribution URL exists — adding one later is additive). TypeBox schemas are plain JSON Schema and the emitted `exclusiveMinimum` is the numeric 2020-12 form, so draft 2020-12 is declared. (2) **Committed vs generated-at-build:** the development container runs as uid 1000 and must never write into the bind-mounted repository tree, so no CI/check flow may produce the file in-tree. `scripts/generate-schema.mjs` serializes the document deterministically (Prettier's JSON layout, so the artifact is always formatting-clean) into an env-configured output directory (`SCHEMA_DIR`, host default `schema/`, container `/var/lib/quotameter/schema` — the `docs/agents/environment.md` pattern), and `make schema` streams the generated bytes back so a host-side process owns the repository copy. Freshness is enforced where no writes are needed: `test/unit/config-schema-published.spec.ts` asserts the committed file deep-equals the document's JSON projection and pins the constraint keywords (ranges, closed enums, patterns, defaults, `additionalProperties: false` everywhere) that editor tooling and task 064's Ajv compilation read. (3) **Distribution:** the file is allowlisted explicitly in `package.json` `files` and required-present by `scripts/check-package.mjs` (it is always committed, unlike the pre-reserved LICENSE/NOTICE entries). `scripts/verify-build.mjs` is untouched — the schema is a source artifact, not a build output, and the freshness test owns its verification. (4) **Honesty about scope:** the document deliberately excludes the cross-field invariants of `findConfigProblems` (D-014); users are told a config passing the schema may still be rejected at startup/reload. Behavioral validation of the contract stays in `test/unit/config.spec.ts` on the live TypeBox schemas — `Value.Check` dispatches on a `Symbol(Kind)` marker that JSON serialization strips, so TypeBox cannot validate the published file itself.

**Reasons.** (1) Keeping the document inside the contract module makes drift impossible at the source and gives tests, generator, and schema one definition site. (2) A build-time-generated schema would either violate the uid invariant (container writing in-tree) or require CI-only verification with no local gate; a committed artifact verified by a read-only test gives the same guarantee with `make check`. Deterministic serialization keeps regeneration churn-free. (3) An explicit `files` entry plus a required-present tarball check keeps the §4.4 allowlist truthful in both directions. (4) Editors and Ajv read standard keywords, so the artifact's guarantees are exactly the pinned structural keywords; claiming more would mislead users.

**Consequences.** Changing `src/schemas/config.ts` structurally requires `make schema` before `make check` passes (the freshness test names the command). The published path `schema/config.schema.json` is a public artifact: moving or renaming it is a breaking change for users' editor associations and needs a changelog entry and a `D-015` successor. Task 064 compiles the same document/contract with Ajv rather than re-deriving keywords.

## D-016 — Atomic write semantics: pinned 0600 mode, no directory creation, inert stale temps (spec §6.3)

**Date:** 2026-10-29 · **Status:** Accepted · **Spec:** [§6.3, §15.4](plan/SPECIFICATION.md#63-secret-storage-and-writes) · **Tasks:** [065](plan/tasks.md) · **References:** D-004

**Decision.** `src/config/write.ts` implements the §6.3 mechanism — serialize, create a same-directory temp file `.<basename>.tmp-<pid>-<random>` with `open('wx', 0600)`, write, `fchmod(0600)`, `fsync`, close, `rename` onto the parameterized target — with four interpretations pinned: (1) the result file mode is **exactly `0600` on every write**, enforced by an explicit chmod that defeats the process umask, rather than copying the replaced file's mode; (2) a missing target directory is a loud `ENOENT` failure — the module never creates directories; (3) stale temp files left by a hard crash are inert garbage with a documented naming pattern, never activated and never blocking later writes (sweeping them is future housekeeping, e.g. 066/doctor); (4) serialization runs before any filesystem effect, and any rejection after temp creation closes, unlinks the temp, and rethrows one wrapped error whose `cause` preserves the original `code` — the message never echoes serialized content, since the config carries secrets.

**Reasons.** (1) `rename` replaces the inode, so the old mode is silently lost in a naive temp-file write; inheriting whatever mode the temp got from creation-plus-umask is how files drift to `0644`, and _copying_ the previous mode would perpetuate permissive drift instead of correcting it — §6.3 fixes the mode at `0600`, and startup enforcement (066) remains the verifier of last resort. (2) Directory creation and `0700` enforcement are task 066's; a silent `mkdir` here would duplicate that work, race its permission fix, and mask caller wiring bugs (e.g. an unresolved path), contradicting the loud-failure precedent of D-011/D-012. (3) Only the final rename can change the active file, so crash leftovers cannot corrupt anything — deleting files this module did not create, in a directory it does not exclusively own, buys nothing. (4) One uniform error shape lets callers (064 loader, future `ConfigService`) branch on `cause.code` without string matching, and the done-condition — an interrupted write can never leave a partially written config as the active file — is testable by injecting failures at every step.

**Consequences.** Task 064 composes this behind config loading and chooses the file name (`config.json`); tasks 066/073+ call it for every settings change, getting `0600` by construction. Stricter-than-`0600` states (e.g. a hand-set `0400`) are themselves non-compliant with §6.3 and are normalized on the next write. Operators are documented (via `src/config/README.md`) that hidden `.config.json.tmp-*` files next to the config are crash residue, not active data.
