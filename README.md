# Quotameter

[![CI](https://github.com/yepbro/quotameter/actions/workflows/ci.yml/badge.svg)](https://github.com/yepbro/quotameter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5%2022.13.0-brightgreen.svg)](https://nodejs.org/en/about/previous-releases)
[![Platform: Linux](https://img.shields.io/badge/platform-linux-blue.svg)](https://github.com/yepbro/quotameter#development-environment)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Self-hosted personal web service that monitors usage quotas for AI subscriptions. Quotameter periodically retrieves quota snapshots from supported providers, stores history locally in SQLite, detects reset events and collection gaps, and visualizes current values and historical changes in a bundled web UI.

Designed to be installed and operated by one person on their own Linux VPS: distributed as a public npm package with a CLI and a bundled responsive web interface. Version 1.0 supports **Z.ai Coding Plan**; the adapter architecture allows future providers to be added without touching the polling engine, persistence, or charts.

## Key documentation

- [Technical Specification](plan/SPECIFICATION.md) — full requirements: architecture, providers, persistence, security, testing, and release process
- [Implementation Task Plan](plan/tasks.md) — staged, independently reviewable task breakdown with acceptance conditions
- [Decision Log](DECISIONS.md) — key technical and business decisions, their reasons, and consequences
- [Contributing guide](CONTRIBUTING.md) — commit convention, pull-request rules, and repository workflow
- [Configuration JSON Schema](docs/config-schema.md) — the published `config.json` schema, editor validation, and regeneration
- [Package layout](docs/architecture/package-layout.md) — module map and dependency rules for `src/`, `ui/`, and `bin/`

## Project status

The project is in the bootstrapping stage: the specification and the task plan are complete, and implementation work follows [plan/tasks.md](plan/tasks.md) in order. A reproducible Docker-based development environment and setup instructions arrive with Stage 1 of the plan; until then, `plan/SPECIFICATION.md` is the single source of truth for every design decision.

## Development environment

All routine work runs inside a Docker container with the pinned minimum runtime (Node.js 22.13.0); no host-installed Node.js is required. Environments are managed by [docktree](docktree.yml): **each git worktree gets its own isolated compose project** — unique container names, unique volumes (including `node_modules`), and its own port allocations — so parallel worktrees never interfere with each other. The command surface is the [`Makefile`](Makefile): every project command runs in the worktree's container, brings it up automatically, and synchronizes dependencies from the lockfile when it changes. On a fresh checkout run `make image up` once; afterwards any target works on its own.

`make help` prints the same list with one-line descriptions.

### Parallel worktrees

Work on multiple tasks at once by creating a git worktree and starting it the same way:

```bash
git worktree add -b my-feature ~/worktrees/quotamonitor/my-feature
cd ~/worktrees/quotamonitor/my-feature
make up        # isolated containers + volumes for this worktree only
```

Everything works inside the worktree exactly as in the main tree (`make check`, `make test`, …), simultaneously with other worktrees. Useful docktree commands alongside the Make targets:

| Command                           | Effect                                               |
| --------------------------------- | ---------------------------------------------------- |
| `docktree --json status`          | Is anything running for this worktree?               |
| `docktree --json ports [--all]`   | Allocated ports for this (or all) worktree(s)        |
| `docktree --json clean --dry-run` | Preview removal of stale worktree instances          |
| `docktree --json down --volumes`  | Tear down this worktree's containers **and volumes** |

### Container lifecycle

| Command                 | Effect                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `make image`            | Build (or rebuild) the development image                                               |
| `make up` / `make down` | Start / stop this worktree's container (volumes are kept)                              |
| `make restart`          | Recreate the container after image or Compose changes                                  |
| `make status`           | Show this worktree's container status                                                  |
| `make clean`            | Stop this worktree's container and remove **its** volumes (dependencies, caches, data) |

### Interactive

| Command                   | Effect                                     |
| ------------------------- | ------------------------------------------ |
| `make shell`              | Open an interactive shell in the container |
| `make exec CMD="node -v"` | Run a one-off command in the container     |

### Checks

| Command          | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make check`     | **Minimal gate** before committing: format check, lint, type checks, full Vitest suite (~15 s)                                                                                                                                                                                                                                                                                                                                                            |
| `make check-all` | **Full CI parity**: everything the required CI job runs — static checks, audit, licenses, tests with coverage and JUnit report, UI build with artifact verification, Playwright E2E, tarball allowlist check. Mutation testing runs daily via [`.github/workflows/mutation.yml`](.github/workflows/mutation.yml) and reports to a rolling issue ([how it works and how to triage](docs/mutation-testing.md), D-045); run it manually with `make mutation` |

### Individual commands

| Command                                                           | Effect                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `make test` / `test-unit` / `test-integration` / `test-component` | Run the whole Vitest suite / one project                                                       |
| `make test-coverage` / `test-ci`                                  | Tests with coverage thresholds / CI mode (coverage + JUnit)                                    |
| `make test-e2e`                                                   | Playwright E2E against a locally built UI                                                      |
| `make test-watch`                                                 | Watch mode (interactive)                                                                       |
| `make lint` / `lint-fix`                                          | Lint / lint and auto-fix                                                                       |
| `make format` / `format-check`                                    | Rewrite formatting / verify without touching files                                             |
| `make typecheck` / `typecheck-ui` / `typecheck-all`               | Type-check server / UI / both                                                                  |
| `make audit`                                                      | `npm audit --omit=dev` (policy: [vulnerability policy](docs/security/vulnerability-policy.md)) |
| `make licenses`                                                   | Dependency license check against the allowlist                                                 |
| `make mutation`                                                   | Stryker mutation testing                                                                       |
| `make package`                                                    | npm tarball contents against the packaging allowlist                                           |
| `make build`                                                      | Build the UI and verify the expected artifacts                                                 |
| `make verify-runtime`                                             | Confirm Node `>= 22.13.0` and flagless `node:sqlite`                                           |

Layout inside the container:

- `/app` — the repository, bind-mounted for live editing (host changes are visible immediately, no rebuild needed);
- `/app/node_modules` — a named volume shadowing the host path, so host and container dependencies never conflict;
- `/var/lib/quotameter/config` and `/var/lib/quotameter/data` — isolated development paths (`QUOTAMETER_CONFIG_DIR`, `QUOTAMETER_DATA_DIR`) so secrets, SQLite databases, and logs never appear in tracked directories;
- `/home/node/.cache` — a named volume with the npm/Playwright caches to speed up rebuilds.

Data-volume handling:

- `make down` keeps this worktree's dependency, cache, and data volumes; `make up` afterwards restores the previous state.
- `make clean` removes this worktree's volumes, including development configuration and any local SQLite history. This is the supported way to reset the environment to a pristine state; it never touches other worktrees or files outside Docker volumes.
- To point the development data elsewhere, copy [`.env.example`](.env.example) to `.env` and adjust the paths (container-side only; the volumes must stay out of the source tree).

Run `make verify-runtime` after the first build to confirm the minimum runtime: it checks Node.js `>= 22.13.0` and that `node:sqlite` imports without `--experimental-sqlite`.

## Project structure

The application separates server, CLI, provider adapters, services, database access, and shared schemas into layered modules; the frontend (`ui/`) talks only to the HTTP API. The full map with dependency rules is in [docs/architecture/package-layout.md](docs/architecture/package-layout.md) — a structural test (`test/unit/package-layout.spec.ts`) enforces the import directions.

```
bin/            quotameter launcher (plain JS, no build step)
src/
  schemas/      TypeBox contracts at every trust boundary (leaf)
  util/         cross-cutting helpers: clock, logger, version (leaf)
  config/       configuration mechanics: XDG paths, loading, atomic writes
  providers/    provider core (registry, transport) + one <id>/ dir per adapter
  storage/      all node:sqlite access: migrations, QuotaRepository
  services/     PollingService, HistoryService, EventService, PeakHoursService, …
  server/       composition root: Fastify app, HTTP API, lifecycle
  cli/          quotameter commands (init, run, status, doctor, …)
ui/             Vue 3 + Vite frontend (own build)
test/           unit / integration / component / e2e tests, fixtures, helpers
docs/           architecture, provider, security, and release documentation
```
