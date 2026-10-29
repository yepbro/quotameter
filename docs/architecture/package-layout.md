# Application package layout

The authoritative map of repository modules and the rules that keep them
independent. The layout separates server, CLI, provider adapters, services,
database access, shared schemas, frontend, docs, and tests (task 059; spec
§3, §8.1). Every implementation task places its code in the files named
here, so tasks target disjoint file sets by construction (directories may
repeat across stages that run sequentially).

The rules on this page are **executable**: [`test/unit/package-layout.spec.ts`](../../test/unit/package-layout.spec.ts)
resolves every relative import in `src/`, `ui/`, and `bin/` and fails when a
forbidden dependency appears — the layer import directions, adapter isolation,
the `node:sqlite` storage gate, the no-loose-files rule, the `ui/` type-only
rule, and the `bin/` → `src/cli/` rule. The [trust-boundaries map](trust-boundaries.md)
says _what_ is validated where; this page says _which module owns it_.

## Repository top level

| Path       | Contents                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `bin/`     | `quotameter.mjs` — thin, build-free launcher; delegates to `src/cli/`                            |
| `src/`     | server-side application code, layered as described below                                         |
| `ui/`      | Vue 3 + Vite frontend; talks only to the HTTP API, never to providers or SQLite                  |
| `test/`    | automated tests — layout and conventions in [`test/README.md`](../../test/README.md)             |
| `docs/`    | project documentation (this map, trust boundaries, providers, release, security, agent guides)   |
| `scripts/` | repository tooling run by `make` targets and CI (build verification, package and license checks) |
| `plan/`    | specification and task plan — the source of truth, never touched by application code             |

## `src/` layers and dependency rules

Layers form a DAG. A layer may import only itself and the layers listed in its
row ("—" means leaf: no relative imports outside the layer's own directory).
`server` and `cli` are top-level consumers: they see everything below them.

| Layer               | Path                    | Owns                                                                                                          | May import                                               |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `schemas`           | `src/schemas/`          | TypeBox contracts + validated types for all trust boundaries (§8.4 model, §6.2 config, §13 API)               | —                                                        |
| `util`              | `src/util/`             | dependency-free helpers: clock/time (§10), redacting logger (§16), version helpers                            | —                                                        |
| `config`            | `src/config/`           | configuration mechanics: XDG paths, loading, validation, atomic writes, permissions, env overrides (§6)       | `schemas`, `util`                                        |
| `providers:core`    | `src/providers/*.ts`    | `QuotaProvider`/`AccountContext` contracts, `ProviderRegistry`, shared transport, sanitization (§8.1)         | `schemas`, `util`                                        |
| `providers:adapter` | `src/providers/<id>/**` | one adapter per provider with all provider-specific parsing (§8.3)                                            | `schemas`, `util`, `providers:core`                      |
| `storage`           | `src/storage/`          | all `node:sqlite` access: connection, migrations, `QuotaRepository`, retention (§3, §11)                      | `schemas`, `util`                                        |
| `services`          | `src/services/`         | `PollingService`, `HistoryService`, `EventService`, `PeakHoursService`, `ConfigService`, `AuthService` (§8.1) | `schemas`, `util`, `config`, `providers:core`, `storage` |
| `server`            | `src/server/`           | composition root: entry point, lifecycle, Fastify app, HTTP API, static serving, security (§13, §15)          | everything except `cli`                                  |
| `cli`               | `src/cli/`              | `quotameter` commands: init, run, service, reload, status, logs, passwd, doctor (§5.2)                        | everything except `providers:adapter`                    |

Additional invariants:

- **No loose modules.** Files directly in `src/` are forbidden; every module
  lives in a layer directory (which is why `version.ts` lives in `src/util/`).
- **Adapters are islands.** A `src/providers/<id>/` adapter never imports
  another adapter and is never imported outside `src/providers/` — except by
  the composition root (`src/server/`), which registers it in the registry.
  This is what makes "add a provider without rewriting the scheduler,
  persistence, history endpoints, or charts" (§8.1) mechanically true.
- **One database gate.** SQL exists only inside `src/storage/`. Services
  consume `QuotaRepository`; spec §8.1 names it among the core services, and
  spec §3 requires all database access isolated behind a storage module — it
  is therefore the storage layer's public facade (decision D-009). The
  structural test enforces the gate: any file outside `src/storage/` that
  imports `node:sqlite` fails `make check`.
- **Secrets stop at their layer.** Provider secrets travel from
  `src/config/` through services into adapters and are logged only through the
  redacting logger in `src/util/` (§15.4); no layer may print them.
- **Composition only at the top.** Only `src/server/` (and `src/cli/` for
  off-process commands) instantiate concrete implementations; everything
  below receives its dependencies.

### Planned placements

Where the remaining plan tasks land. Rows name the files each task owns, and
the sets are disjoint — directories may repeat across rows for stages that
run sequentially:

| Tasks   | Files                                                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 060     | `src/server/main.ts`, `src/server/app.ts` (bootstrap and assembly)                                                                                                    |
| 061–068 | `src/schemas/config.ts`, `src/config/*`                                                                                                                               |
| 069     | `src/schemas/metrics.ts` (normalized snapshot/metric model)                                                                                                           |
| 070     | `src/providers/registry.ts`, provider contracts                                                                                                                       |
| 071–072 | `src/util/clock.ts`, `src/util/logger.ts`                                                                                                                             |
| 073–076 | `src/services/config*` (settings validation), `src/server/single-instance.ts`, `src/server/shutdown.ts`                                                               |
| 078–092 | `src/storage/*` (connection, migrations, repository, retention, backups)                                                                                              |
| 093–111 | `src/providers/zai-coding-plan/*`, `src/providers/transport.ts`, `src/providers/sanitize.ts`, `src/services/polling*`                                                 |
| 112–127 | `src/services/peak-hours*`, `src/services/history*`, `src/services/events*`                                                                                           |
| 128–145 | `src/cli/*`                                                                                                                                                           |
| 146–164 | `src/server/api/*` (routes), `src/schemas/api/*`, `src/services/auth*` (AuthService, sessions, hashing), `src/server/auth*` (HTTP middleware, cookies, rate limiting) |
| 165–183 | `ui/src/*` (see below)                                                                                                                                                |

Tasks that produce no `src/` code land where their artefacts belong: research,
fixtures, and provider documentation (093–097, 127) in `test/fixtures/` and
`docs/providers/`; example configuration (112) in `docs/`; tests and
documentation-only tasks (076, 077, 125, 126) in `test/` and `DECISIONS.md`.

File naming: kebab-case (`peak-hours.ts`), one service or contract family per
file; test files mirror the layout under `test/`.

## `ui/` — frontend layout

The browser application is a separate project with its own tsconfig and build
(§3, §14). It communicates with the server **only through the HTTP API**.

| Path                 | Contents                                                               |
| -------------------- | ---------------------------------------------------------------------- |
| `ui/index.html`      | Vite entry                                                             |
| `ui/vite.config.ts`  | build configuration (output via `DIST_DIR`)                            |
| `ui/src/main.ts`     | application bootstrap                                                  |
| `ui/src/App.vue`     | root component                                                         |
| `ui/src/api/`        | typed API client (task 169) — reserved                                 |
| `ui/src/router/`     | Vue Router route definitions (task 166) — reserved                     |
| `ui/src/views/`      | route views: overview, accounts, settings, login (Stage 13) — reserved |
| `ui/src/components/` | shared components — reserved                                           |
| `ui/src/locales/`    | `vue-i18n` `en` catalog (task 167) — reserved                          |
| `ui/src/stores/`     | Pinia stores, only if they prove useful (§3) — reserved                |

**Rule:** `ui/**` never imports `src/**` at runtime — the only sanctioned
sharing is **type-only** imports from `src/schemas/**` (erased at build time),
so the client and the server consume the same canonical contracts (§8.4, §13).
The executable check enforces both halves of that sentence.

## Tests

The test layout (`test/unit`, `test/integration`, `test/component`, `test/e2e`,
`test/fixtures`, `test/helpers`) is defined in [`test/README.md`](../../test/README.md)
and unchanged by this task. Placement follows the code under test: schema and
pure-service logic → `unit`, SQLite/config/HTTP work → `integration`, Vue
components → `component`, browser flows → `e2e`.

## Packaging constraints (forward pointer)

Spec §3 fixes the packaging shape the layout must support: no install-time
build, no `postinstall`, no native modules; the tarball ships the built
frontend `dist/`, a ready-to-run CLI, and the published JSON Schema
(`schema/config.schema.json`, task 062). Concretely: `bin/quotameter.mjs`
stays plain JavaScript; the TypeScript under `src/` is compiled at publish
time; `ui/dist` is the served frontend output. The `files` allowlist, export
paths, and build-artifact checks are finalized by tasks 184–186, which extend
`package.json`, `scripts/verify-build.mjs`, and `scripts/check-package.mjs`
accordingly. Module READMEs under `src/` are development documentation and
stay out of the tarball.

## Adding a module or provider

- **New provider (§8.1):** create `src/providers/<id>/`, implement the
  contracts from `src/providers/registry.ts` (task 070), register it in the
  composition root, add fixtures under `test/fixtures/`, and document the
  contract in `docs/providers/<id>.md`. No scheduler, persistence, API, or
  chart changes.
- **New service:** add a file under `src/services/`, depend on the layers
  listed above, and wire it in `src/server/`. If it needs SQL, the SQL goes
  into `src/storage/` and the service calls the repository.
- **New schema:** grows the owning file in `src/schemas/` first; consumers
  follow. Trust-boundary changes update
  [`trust-boundaries.md`](trust-boundaries.md) in the same commit.
