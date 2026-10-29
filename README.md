# Quotameter

Self-hosted personal web service that monitors usage quotas for AI subscriptions. Quotameter periodically retrieves quota snapshots from supported providers, stores history locally in SQLite, detects reset events and collection gaps, and visualizes current values and historical changes in a bundled web UI.

Designed to be installed and operated by one person on their own Linux VPS: distributed as a public npm package with a CLI and a bundled responsive web interface. Version 1.0 supports **Z.ai Coding Plan**; the adapter architecture allows future providers to be added without touching the polling engine, persistence, or charts.

## Key documentation

- [Technical Specification](plan/SPECIFICATION.md) — full requirements: architecture, providers, persistence, security, testing, and release process
- [Implementation Task Plan](plan/tasks.md) — staged, independently reviewable task breakdown with acceptance conditions
- [Decision Log](DECISIONS.md) — key technical and business decisions, their reasons, and consequences
- [Contributing guide](CONTRIBUTING.md) — commit convention, pull-request rules, and repository workflow

## Project status

The project is in the bootstrapping stage: the specification and the task plan are complete, and implementation work follows [plan/tasks.md](plan/tasks.md) in order. A reproducible Docker-based development environment and setup instructions arrive with Stage 1 of the plan; until then, `plan/SPECIFICATION.md` is the single source of truth for every design decision.

## Development environment

All routine work runs inside a Docker container with the pinned minimum runtime (Node.js 22.13.0); no host-installed Node.js is required. The command surface is the [`Makefile`](Makefile):

```bash
make help          # list all targets
make build         # build (or rebuild) the development image
make up            # start the development container in the background
make shell         # open an interactive shell inside the container
make down          # stop the container (volumes are kept)
make clean         # stop the container and remove ALL volumes
```

Layout inside the container:

- `/app` — the repository, bind-mounted for live editing (host changes are visible immediately, no rebuild needed);
- `/app/node_modules` — a named volume shadowing the host path, so host and container dependencies never conflict;
- `/var/lib/quotameter/config` and `/var/lib/quotameter/data` — isolated development paths (`QUOTAMETER_CONFIG_DIR`, `QUOTAMETER_DATA_DIR`) so secrets, SQLite databases, and logs never appear in tracked directories;
- `/home/node/.cache` — a named volume with the npm/Playwright caches to speed up rebuilds.

Data-volume handling:

- `make down` keeps the dependency, cache, and data volumes; `make up` afterwards restores the previous state.
- `make clean` removes all volumes, including development configuration and any local SQLite history. This is the supported way to reset the environment to a pristine state; it never touches files outside Docker volumes.
- To point the development data elsewhere, copy [`.env.example`](.env.example) to `.env` and adjust the paths (container-side only; the volumes must stay out of the source tree).

Run `make verify-runtime` after the first build to confirm the minimum runtime: it checks Node.js `>= 22.13.0` and that `node:sqlite` imports without `--experimental-sqlite`.

