# Environment: Docker, docktree, worktrees

## Isolation model

Docker environments are managed by **docktree** (`docktree.yml`): every git worktree gets its own compose project — unique container names, unique volumes (including `node_modules`), unique port allocations. Parallel worktrees cannot interfere.

- Worktree convention: `~/worktrees/quotamonitor/<feature>`.
- In any worktree, `make up` starts its isolated environment; all `make` targets work identically there.
- Image is pinned to Node.js **22.13.0** (the declared minimum — catches accidental use of newer APIs early).

## Critical invariant: uid mismatch

The container runs as `node` (uid 1000); the host user is uid 1001. The container **must not write to bind-mounted repository directories** — generated output goes into the isolated data volume via environment variables set in `compose.yaml`:

| Variable         | Used by                                         | Container path                    |
| ---------------- | ----------------------------------------------- | --------------------------------- |
| `COVERAGE_DIR`   | Vitest coverage                                 | `/var/lib/quotameter/coverage`    |
| `E2E_OUTPUT_DIR` | Playwright artifacts                            | `/var/lib/quotameter/e2e-results` |
| `REPORTS_DIR`    | JUnit, license reports, Stryker HTML            | `/var/lib/quotameter/reports`     |
| `DIST_DIR`       | Vite build output (`ui`), verify-build, preview | `/var/lib/quotameter/ui-dist`     |

**Rule: any new tool that writes files must follow this pattern** (env-configured output directory with a host-friendly default), otherwise host/container runs fight over ownership and CI-parity checks break.

## Playwright browsers

The Playwright CDN is unreachable from container networks. Browser binaries come from the host cache via a read-only mount (`~/.cache/ms-playwright` → `/home/node/.cache/ms-playwright`). The image carries the required shared libraries.

## Dependencies

`node_modules` is a named volume per worktree; `make deps` (run automatically by every target) reinstalls via `npm ci` when `package-lock.json` changed (stamp file in the data volume). Install packages on the host (`npm install …` writes the lockfile), then any `make` target syncs the container volume.

## Lifecycle targets

`make image` (build), `make up` / `down` (start/stop, volumes kept), `make restart` (recreate), `make clean` (remove **this worktree's** volumes), `make shell`, `make exec CMD="…"`. Docktree utilities: `docktree --json status | ports [--all] | clean --dry-run`, `docktree --json down --volumes`.
