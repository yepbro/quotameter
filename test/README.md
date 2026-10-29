# Test directory convention

All automated tests live under `test/` with a predictable layout. Test files are named `*.spec.ts` (or `*.spec.mjs` where a plain-Node runner is required); helper modules are plain `.ts` files without the `spec` suffix.

| Directory           | Purpose                                                                                                                                                    | Environment |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `test/unit/`        | Fast, isolated tests of single modules. No network, no real filesystem paths outside temporary directories.                                                | Node        |
| `test/integration/` | Tests that exercise real I/O: SQLite storage, config files, the mock provider server.                                                                      | Node        |
| `test/component/`   | Vue component mount tests (Vue Test Utils).                                                                                                                | happy-dom   |
| `test/e2e/`         | Playwright browser tests against a locally built UI. `test/e2e/helpers/` holds page-level helpers (a11y checks and similar).                               | Chromium    |
| `test/fixtures/`    | Static test data: `sanitized/` (real payloads with secrets redacted) and `synthetic/` (invented payloads). See the fixtures README before adding anything. | —           |
| `test/helpers/`     | Shared utilities: mock provider server, isolation/cleanup helpers, the no-network guard.                                                                   | —           |

Conventions:

- Placement should be unambiguous: a new unit test goes to `test/unit/`, a new storage test to `test/integration/`, and so on. When a test spans categories, place it in the most specific directory it needs (e.g. a test that touches SQLite belongs to `integration` even if it also parses a fixture).
- Every test must clean up after itself (see `test/helpers/isolation.ts`); tests must not depend on execution order.
- The default suite runs with the no-network guard enabled (`test/helpers/network-guard.ts`): outbound requests to non-loopback hosts fail loudly. Tests that need HTTP use the local mock provider server or explicit loopback listeners.
- Property-based tests import `fast-check` and follow the deterministic-seed convention documented in the root README of `test/`.

## Command surface

All test commands run inside the development container (`make shell`) or any Node.js `>=22.13.0` environment:

| Command                    | Effect                                                                     |
| -------------------------- | -------------------------------------------------------------------------- |
| `npm run test`             | Run the full unit + integration suite once; exits non-zero on any failure. |
| `npm run test:unit`        | Run only `test/unit/`.                                                     |
| `npm run test:integration` | Run only `test/integration/`.                                              |
| `npm run test:component`   | Run only `test/component/`.                                                |
| `npm run test:watch`       | Watch mode for local development.                                          |
| `npm run test:ci`          | Full suite with an additional JUnit report at `reports/junit.xml` for CI.  |

## Failure semantics

The canonical command (`npm run test`, and every `test:*` variant) exits **non-zero** when any assertion fails, when a suite fails to collect, and when a scoped suite matches no test files. Verified live: a temporary failing spec produced `Test Files 1 failed | 7 passed`, exit code `1`. CI consumes these exit codes directly, so a failing assertion always blocks a build.
