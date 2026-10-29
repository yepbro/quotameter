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
