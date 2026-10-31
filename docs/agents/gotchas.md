# Known pitfalls

Lessons already paid for — do not repeat them.

## Container / host boundaries

- The container (uid 1000) cannot write into host-owned bind-mount dirs (uid 1001). Every generated directory must be env-configured into the data volume (`REPORTS_DIR`, `DIST_DIR`, `COVERAGE_DIR`, `E2E_OUTPUT_DIR`, Stryker `tempDirName`). A new tool writing into the repo from the container will hit `EACCES` until it follows the pattern — see [environment.md](environment.md).
- Host `node_modules/` can end up root-owned after Docker created the mountpoint: `sudo chown -R brooks:brooks node_modules` (via the askpass helper), then `npm install` works.
- The Playwright download CDN is unreachable from containers — browsers come from the read-only host cache mount.

## CI parity

- CI runs `typecheck:all` (server `tsc` + `vue-tsc`), `test:ci` (coverage + thresholds), `check:package`, and e2e on every push; mutation testing runs once a day in `.github/workflows/mutation.yml` (rolling `mutation-report` issue, DECISIONS.md D-045), not per push. A green local `make test` proves nothing about thresholds — `make check` runs the same `test:ci` coverage pass (global 90% plus the D-085 critical-module 100% keys) — and both `make check` and `make check-all` run `typecheck-all`, the same `typecheck:all` command CI's `static` job runs, so a UI type error is caught before committing too (D-092; the standalone `make typecheck` remains the fast server-only loop); `make check-all` remains the pre-push gate (it mirrors the per-push CI exactly; run `make mutation` manually when you need Stryker locally).
- Commit message conventions are checked by humans only, but the workflow files are linted with `actionlint` (docker: `rhysd/actionlint`) — run it after editing workflows.

## Test stability under parallel load

- **Compute-bound property tests declare explicit per-test timeouts — Vitest's default 5 s is a flake under parallel-wave load.** A property doing ~100 fast-check runs over `size: 'max'` series with brute-force oracle walks is legitimately compute-bound: the downsample cluster property measures 0.95 s clean, 1.4 s under v8 coverage (permanent in `make check` since D-085), and **6.8 s** worst in a full coverage run under the starvation rig — past the default at exactly the ambient load (~18) where U-012's matrix flaked it. There is nothing to synchronize (the D-087 synchronization pattern needs a phase; here the test simply needs more wall time) — declare the timeout instead: `it('…', { timeout: 20_000 }, fn)` on the installed Vitest 5 (options-object form; `describe`-level options and the legacy trailing-number form also exist — `peak-hours-dst.property.spec.ts` uses the latter). **Size from the measured worst case under the rig, never guess**: six busy-loop hogs pinned across the container's 8 cores (`taskset -c 0..5 sh -c 'while :; do :; done'`, the U-010/U-012 method), run the _full_ `make check` under it (the 104-file pool contends far more than isolated suite runs: 3.8 s isolated-rig worst vs 6.8 s full-rig worst for the same test), then take ≈3× that worst (U-020 chose 20 s; `peak-hours-dst` pins 15/30 s by the same logic). A test joins the census when it measures ≥ ~250 ms clean or ≥ ~1 s under the rig — anything measured far below (events-detection 0.8 s, history-gaps 0.37 s, history-timeline 0.62 s, rolling-ranges 18 ms under the rig) stays on the default, keeping the timeout a meaningful statement. Never lower `numRuns` to fit a timeout — the properties are the §17.1 coverage. Recorded as decision D-094; the same load-sensitivity family as D-087 (validate-suite deadlines) and measured over the D-090 comparator paths these suites walk.

## Tooling quirks

- **ESLint flat presets**: `@intlify/eslint-plugin-vue-i18n`'s `flat/recommended` is an **array**, not an object — spreading it into a config object breaks with `Unexpected key "0"`. Register the plugin manually and enable the single rule instead.
- **Prettier vs `eslint-plugin-vue`** disagree about line breaks in short `<p>` elements: the residual warnings in `ui/src/App.vue` are expected; do not "fix" them (the two formatters will ping-pong).
- **Vitest project `sequence.sort`** does not exist — use `sequence.shuffle: false` for determinism.
- **`node:sqlite`** imports fine on 22.13.0+ but prints an `ExperimentalWarning` — expected, not an error.
- **`npm pack`** silently skips allowlisted-but-missing files (`LICENSE`/`NOTICE` were reserved before they existed) — the allowlist check only fails on _unexpected_ entries.
- **Dependabot PRs** go `BEHIND` after every merge (strict branch protection): rebase each remaining PR (`@dependabot rebase`) before merging it.
