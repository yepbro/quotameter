# Test directory convention

All automated tests live under `test/` with a predictable layout. Test files are named `*.spec.ts` (or `*.spec.mjs` where a plain-Node runner is required); helper modules are plain `.ts` files without the `spec` suffix.

| Directory          | Purpose                                                                 | Environment        |
| ------------------ | ----------------------------------------------------------------------- | ------------------ |
| `test/unit/`       | Fast, isolated tests of single modules. No network, no real filesystem paths outside temporary directories. | Node               |
| `test/integration/`| Tests that exercise real I/O: SQLite storage, config files, the mock provider server. | Node               |
| `test/component/`  | Vue component mount tests (Vue Test Utils).                             | happy-dom          |
| `test/e2e/`        | Playwright browser tests against a locally built UI. `test/e2e/helpers/` holds page-level helpers (a11y checks and similar). | Chromium           |
| `test/fixtures/`   | Static test data: `sanitized/` (real payloads with secrets redacted) and `synthetic/` (invented payloads). See the fixtures README before adding anything. | —                  |
| `test/helpers/`    | Shared utilities: mock provider server, isolation/cleanup helpers, the no-network guard. | —                  |

Conventions:

- Placement should be unambiguous: a new unit test goes to `test/unit/`, a new storage test to `test/integration/`, and so on. When a test spans categories, place it in the most specific directory it needs (e.g. a test that touches SQLite belongs to `integration` even if it also parses a fixture).
- Every test must clean up after itself (see `test/helpers/isolation.ts`); tests must not depend on execution order.
- The default suite runs with the no-network guard enabled (`test/helpers/network-guard.ts`): outbound requests to non-loopback hosts fail loudly. Tests that need HTTP use the local mock provider server or explicit loopback listeners.
- Property-based tests import `fast-check` and follow the deterministic-seed convention documented in the root README of `test/`.
