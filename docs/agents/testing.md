# Testing conventions

## Tests are mandatory

- New or changed logic ships with tests **in the same commit**: happy path + errors + edge cases. The test type follows the logic (see the layout below): pure functions — unit, SQLite/config work — integration, components — component, pages — e2e.
- A failing test is fixed within the same task; it is never deferred or skipped without an explicit reason recorded in the commit.
- Green `make check` before committing; green `make check-all` before landing in `master` (coverage thresholds are enforced only by the latter).

## Layout and runners

| Directory                  | What                                                    | Runner / environment |
| -------------------------- | ------------------------------------------------------- | -------------------- |
| `test/unit/`               | isolated module tests                                   | Vitest, node         |
| `test/integration/`        | real I/O: SQLite, config files, mock HTTP               | Vitest, node         |
| `test/component/`          | Vue component mounts                                    | Vitest, happy-dom    |
| `test/e2e/`                | browser tests (+ `helpers/` for page helpers like a11y) | Playwright, chromium |
| `test/fixtures/sanitized/` | real payloads with secrets redacted                     | —                    |
| `test/fixtures/synthetic/` | invented payloads                                       | —                    |
| `test/helpers/`            | shared utilities                                        | —                    |

Tests are `*.spec.ts`; every test cleans up after itself; no execution-order dependencies.

## Hard rules

- **No-network guard** is active in every Vitest project: requests to non-loopback hosts throw. HTTP tests use `test/helpers/mockProviderServer.ts` (status/body/delay/socket-termination control) on 127.0.0.1.
- **Property tests** import `fc` from `test/helpers/property.ts` (100 runs, `FC_SEED` env pins a seed to reproduce a failure).
- **Fixtures never contain real secrets**: no API keys, tokens, cookies, passwords, personal data. Sanitized fixtures document their origin in `test/fixtures/README.md`.
- **Coverage**: v8, global 90% thresholds on `src/**`, enforced by `test:ci`/CI. Local `make test` does **not** enforce it — run `make check-all` (or `make test-ci`) before a push. Avoid defensively unreachable branches; restructure instead of suppressing (a past `?? 0` fallback cost a red CI).
- **`console` is banned in `src/**` and `ui/**`** (ESLint error): secrets travel only through the future redacting logger. Test/script code may log.
- **Vue i18n**: raw user-facing strings in `ui/**` templates are lint errors (`vue-i18n/no-raw-text`); the two bootstrap placeholder strings are the only documented exemptions.
- **Lint contracts** are executable: `test/unit/vue-template-lint.spec.ts` and `test/unit/vue-i18n-lint.spec.ts` run the real ESLint binary — extend that pattern when adding lint rules that must not silently regress.
- **Failing tests exit non-zero** everywhere (verified; documented in `test/README.md`) — CI relies on exit codes.
