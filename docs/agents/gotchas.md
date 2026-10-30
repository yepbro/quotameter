# Known pitfalls

Lessons already paid for — do not repeat them.

## Container / host boundaries

- The container (uid 1000) cannot write into host-owned bind-mount dirs (uid 1001). Every generated directory must be env-configured into the data volume (`REPORTS_DIR`, `DIST_DIR`, `COVERAGE_DIR`, `E2E_OUTPUT_DIR`, Stryker `tempDirName`). A new tool writing into the repo from the container will hit `EACCES` until it follows the pattern — see [environment.md](environment.md).
- Host `node_modules/` can end up root-owned after Docker created the mountpoint: `sudo chown -R brooks:brooks node_modules` (via the askpass helper), then `npm install` works.
- The Playwright download CDN is unreachable from containers — browsers come from the read-only host cache mount.

## CI parity

- CI runs `test:ci` (coverage + thresholds), `check:package`, and e2e on every push; mutation testing runs once a day in `.github/workflows/mutation.yml` (rolling `mutation-report` issue, DECISIONS.md D-045), not per push. A green local `make test` proves nothing about thresholds — `make check-all` is the pre-push gate (it mirrors the per-push CI exactly; run `make mutation` manually when you need Stryker locally).
- Commit message conventions are checked by humans only, but the workflow files are linted with `actionlint` (docker: `rhysd/actionlint`) — run it after editing workflows.

## Tooling quirks

- **ESLint flat presets**: `@intlify/eslint-plugin-vue-i18n`'s `flat/recommended` is an **array**, not an object — spreading it into a config object breaks with `Unexpected key "0"`. Register the plugin manually and enable the single rule instead.
- **Prettier vs `eslint-plugin-vue`** disagree about line breaks in short `<p>` elements: the residual warnings in `ui/src/App.vue` are expected; do not "fix" them (the two formatters will ping-pong).
- **Vitest project `sequence.sort`** does not exist — use `sequence.shuffle: false` for determinism.
- **`node:sqlite`** imports fine on 22.13.0+ but prints an `ExperimentalWarning` — expected, not an error.
- **`npm pack`** silently skips allowlisted-but-missing files (`LICENSE`/`NOTICE` were reserved before they existed) — the allowlist check only fails on _unexpected_ entries.
- **Dependabot PRs** go `BEHIND` after every merge (strict branch protection): rebase each remaining PR (`@dependabot rebase`) before merging it.
