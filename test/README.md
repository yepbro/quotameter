# Test directory convention

All automated tests live under `test/` with a predictable layout. Test files are named `*.spec.ts` (or `*.spec.mjs` where a plain-Node runner is required); helper modules are plain `.ts` files without the `spec` suffix.

| Directory              | Purpose                                                                                                                                                                                                     | Environment |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `test/unit/`           | Fast, isolated tests of single modules. No network, no real filesystem paths outside temporary directories.                                                                                                 | Node        |
| `test/integration/`    | Tests that exercise real I/O: SQLite storage, config files, the mock provider server.                                                                                                                       | Node        |
| `test/component/`      | Vue component mount tests (Vue Test Utils).                                                                                                                                                                 | happy-dom   |
| `test/e2e/`            | Playwright browser tests against a locally built UI. `test/e2e/helpers/` holds page-level helpers (a11y checks and similar).                                                                                | Chromium    |
| `test/e2e/acceptance/` | The §17.1 acceptance scenarios: one real `composeApplication` server per spec file (built UI served, real Z.ai adapter over the loopback mock provider — `test/e2e/helpers/acceptance.ts`, decision D-166). | Chromium    |
| `test/fixtures/`       | Static test data: `sanitized/` (real payloads with secrets redacted) and `synthetic/` (invented payloads). See the fixtures README before adding anything.                                                  | —           |
| `test/helpers/`        | Shared utilities: mock provider server, isolation/cleanup helpers, the no-network guard.                                                                                                                    | —           |

Conventions:

- Placement should be unambiguous: a new unit test goes to `test/unit/`, a new storage test to `test/integration/`, and so on. When a test spans categories, place it in the most specific directory it needs (e.g. a test that touches SQLite belongs to `integration` even if it also parses a fixture).
- Every test must clean up after itself (see `test/helpers/isolation.ts`); tests must not depend on execution order.
- The default suite runs with the no-network guard enabled (`test/helpers/network-guard.ts`): outbound requests to non-loopback hosts fail loudly. Tests that need HTTP use the local mock provider server or explicit loopback listeners.
- Environments are injected object literals; `process.env` is never mutated — the one exception is `test/helpers/hermeticEnv.ts` (`withQuotameterEnv`), which swaps the `QUOTAMETER_*` slice of `process.env` for the duration of one body with full save/restore, reserved for testing the production seams whose default is `process.env` (decision D-028).
- Property-based tests import `fast-check` and follow the deterministic-seed convention documented in the root README of `test/`.
- E2E has two tiers (decision D-166): the `test/e2e/*.spec.ts` suites run against `vite preview` (fast shell pins, degradation surfaces, route interception); the `test/e2e/acceptance/` scenarios each start a real server — the production composition with the built UI served from `DIST_DIR` (container) or `ui/dist` (CI) and the real adapter pointed at `startMockProviderServer` — so they need `make build` first (`make test-e2e` and CI do this). Acceptance specs are `test.describe.configure({ mode: 'serial' })` per file: one `beforeAll` world per file (seeded through the real write path, `Date.now()`-anchored — see the harness docblock; the a11y file deliberately starts a second password-mode world for its login scan); the harness is vitest-free and owns its temp-directory lifecycle because Playwright workers cannot import the vitest-coupled helpers.

## Command surface

All test commands run inside the development container (`make shell`) or any Node.js `>=22.13.0` environment:

| Command                    | Effect                                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test`             | Run the full unit + integration suite once; exits non-zero on any failure.                                                                                                                                                                              |
| `npm run test:unit`        | Run only `test/unit/`.                                                                                                                                                                                                                                  |
| `npm run test:integration` | Run only `test/integration/`.                                                                                                                                                                                                                           |
| `npm run test:component`   | Run only `test/component/`.                                                                                                                                                                                                                             |
| `npm run test:time`        | Run the time/peak-hours suite — the twelve spec files CI's `timezone` matrix runs under each process `TZ` (see `scripts/verify-tz.mjs` and `test/unit/time-suite-manifest.spec.ts`; locally `make test-time ZONE=<zone>` verifies a matrix zone first). |
| `npm run test:watch`       | Watch mode for local development.                                                                                                                                                                                                                       |
| `npm run test:ci`          | Full suite with an additional JUnit report at `reports/junit.xml` for CI.                                                                                                                                                                               |

## Failure semantics

The canonical command (`npm run test`, and every `test:*` variant) exits **non-zero** when any assertion fails, when a suite fails to collect, and when a scoped suite matches no test files. Verified live: a temporary failing spec produced `Test Files 1 failed | 7 passed`, exit code `1`. CI consumes these exit codes directly, so a failing assertion always blocks a build.
