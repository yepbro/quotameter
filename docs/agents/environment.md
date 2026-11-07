# Environment: Docker, docktree, worktrees

## Isolation model

Docker environments are managed by **docktree** (`docktree.yml`): every git worktree gets its own compose project — unique container names, unique volumes (including `node_modules`), unique port allocations. Parallel worktrees cannot interfere.

- Worktree convention: `~/worktrees/quotamonitor/<feature>`.
- In any worktree, `make up` starts its isolated environment; all `make` targets work identically there.
- The image carries **npm 11** (pinned `11.9.0` in the Dockerfile): the registry retired the quick-audit endpoint on 2026-10-30 and the npm bundled with Node 22 can no longer run `npm audit` (npm 11 uses the bulk advisory endpoint). CI does the same bump before its audit step.
- Image is pinned to Node.js **22.13.0** (the declared minimum — catches accidental use of newer APIs early).

## Matching the host user

The development container runs as the **host user** (decision D-181): the Makefile exports `DEV_UID`/`DEV_GID` (from `id -u`/`id -g`) for every target, `compose.yaml` passes them as build args, and the Dockerfile remaps its `node` user to those ids. Container-side tools that rewrite tracked files — `prettier --write` (`make format`), `eslint --fix`, codegen — therefore work on files created host-side; the EACCES class of the pre-D-181 era (the image's `node` user at uid 1000 vs this host's uid 1001, tracked files mode 664) is gone.

- The `1000:1000` defaults keep the image's own user: the remap step is a no-op, so `1000:1000` hosts and builds without the variables see no change at all.
- The remap edits the existing `node` user (not a numeric `USER`), keeping a passwd entry — `HOME=/home/node` and every name-based path resolution (npm/Playwright caches) are unchanged.
- Images are per worktree (docktree), so host-specific ids are baked per instance and never leak across worktrees.
- Build through `make image` / `make restart` — the Makefile exports the ids. A direct `docktree build` (no make) reads only `.env`, so it rebuilds at the `1000:1000` defaults and flips the trap back: a uid-1000 container can neither rewrite host-owned tracked files nor write the now-host-owned volumes. On hosts that build outside make, pin `DEV_UID`/`DEV_GID` in the worktree's `.env` (see `.env.example`).

**Migrating a pre-D-181 environment**: volumes created before the fix are owned by uid 1000, and after a rebuild the new (host-uid) container fails on the first write _inside_ the volumes — a coverage/reports/build-output write, or `npm ci` when the lockfile changed (`make deps` alone can look healthy: with an up-to-date stamp it writes nothing, so do not treat a passing deps run as proof of migration). Check which uid an environment runs as with `docktree exec dev -- id`. Disposable worktrees: `make clean && make image && make up` (fresh volumes seed their root ownership from the rebuilt image). Keeping the data volume (the main tree's config and SQLite databases): stop the container first — a live one keeps creating uid-1000 files mid-chown — then chown the three volumes with a throwaway root container; the instance name is the `name` field of `.docktree/state.json`, volumes are `<instance>-node_modules` / `<instance>-dev-cache` / `<instance>-dev-data`, the image is `docktree/<instance>/dev:latest`:

```bash
make down
INSTANCE=<name from .docktree/state.json>
for v in node_modules dev-cache dev-data; do
  docker run --rm --user 0 -v "$INSTANCE-$v:/v" \
    "docktree/$INSTANCE/dev:latest" chown -R "$(id -u):$(id -g)" /v
done
make image && make restart
```

## Generated output stays in the data volume

Rewriting tracked files from the container is now legitimate — that is what D-181 buys. Generated _output_ (reports, coverage, build artifacts) still goes into the isolated data volume via the environment variables set in `compose.yaml`, not into the tracked tree:

| Variable         | Used by                                                       | Container path                    |
| ---------------- | ------------------------------------------------------------- | --------------------------------- |
| `COVERAGE_DIR`   | Vitest coverage                                               | `/var/lib/quotameter/coverage`    |
| `E2E_OUTPUT_DIR` | Playwright artifacts                                          | `/var/lib/quotameter/e2e-results` |
| `REPORTS_DIR`    | JUnit (Vitest, Playwright E2E), license reports, Stryker HTML | `/var/lib/quotameter/reports`     |
| `DIST_DIR`       | Vite build output (`ui`), verify-build, preview               | `/var/lib/quotameter/ui-dist`     |
| `SCHEMA_DIR`     | `scripts/generate-schema.mjs` (JSON Schema)                   | `/var/lib/quotameter/schema`      |
| `OPENAPI_DIR`    | `scripts/generate-openapi.mjs` (OpenAPI)                      | `/var/lib/quotameter/openapi`     |

**Rule: any new tool that writes files must follow this pattern** (env-configured output directory with a host-friendly default). The grounds are cleanliness and one shared convention, not local permissions anymore: generated artifacts stay out of `git status`, out of the package, and out of the bind mount on every runner — local container, CI job container, any host — regardless of uid matches (CI's job container chowns its workspace to `node`, a convention the routing does not depend on).

## Playwright browsers

The Playwright CDN is unreachable from container networks. Browser binaries come from the host cache via a read-only mount (`~/.cache/ms-playwright` → `/home/node/.cache/ms-playwright`). The image carries the required shared libraries.

## Dependencies

`node_modules` is a named volume per worktree; `make deps` (run automatically by every target) reinstalls via `npm ci` when `package-lock.json` changed (stamp file in the data volume). Install packages on the host (`npm install …` writes the lockfile), then any `make` target syncs the container volume.

## Lifecycle targets

`make image` (build), `make up` / `down` (start/stop, volumes kept), `make restart` (recreate), `make clean` (remove **this worktree's** volumes), `make shell`, `make exec CMD="…"`. Docktree utilities: `docktree --json status | ports [--all] | clean --dry-run`, `docktree --json down --volumes`.
