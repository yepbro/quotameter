# Testing conventions

## Tests are mandatory

- New or changed logic ships with tests **in the same commit**: happy path + errors + edge cases. The test type follows the logic (see the layout below): pure functions — unit, SQLite/config work — integration, components — component, pages — e2e.
- A failing test is fixed within the same task; it is never deferred or skipped without an explicit reason recorded in the commit.
- Green `make check` before committing; green `make check-all` before landing in `master` (both enforce coverage thresholds — `make check-all` adds audit, licenses, build, e2e, and package).

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
- **Coverage**: v8, on `src/**` (untested included files count too — a new module with no tests reads 0% and fails the gate). Two threshold layers, both enforced by `test:ci` (CI and `make check` run exactly that script; local `make test` stays the fast loop without coverage): global 90% statements/branches/functions/lines (spec §17.3 overall), and **100% on all four axes for the §17.3 critical modules** (decision D-085), configured as per-file glob thresholds in `vitest.config.ts` — time-zone logic (`src/util/clock.ts`, `src/util/rolling-ranges.ts`), peak-hours (`src/services/peak-hours*.ts`, so later §9.3 files join automatically), sanitization (`src/providers/sanitize.ts`), secret-handling (`src/util/logger.ts`, `src/config/permissions.ts`, `src/config/write.ts` — §15.4's redaction, permission, and atomic-write enforcement), and since U-016 (decision D-089) also the configuration-loading mechanics (`src/config/env.ts`, `load.ts`, `reload.ts`) and the shared transport (`src/providers/transport.ts`), each lifted to its measured maximum before the key was added. A shortfall fails the run naming the exact file and axis. Three single-branch arms inside the U-016 files are unreachable by construction and are the only sanctioned exceptions (D-089; their keys pin the measured maximum instead of 100, so any _new_ uncovered arm still fails): `env.ts`'s unknown-name sort comparator equal-key arm (object keys are unique — the Proxy `ownKeys` invariant enforces it too — and string `<`/`>` is a total order, so "neither less nor greater" is impossible; 97.67% branches), `load.ts`'s "must be one of the allowed values" schema-growth fallback (every ConfigSchema union is literal-only today, so Ajv always emits const line-mates for a failed anyOf; 99.13%), and `reload.ts`'s `?? CONFIG_DEFAULTS.logging.level` fallback (the canonical parser always materializes `logging.level`; 97.22%). Avoid defensively unreachable branches; restructure instead of suppressing (a past `?? 0` fallback cost a red CI).
- **`console` is banned in `src/**` and `ui/**`** (ESLint error): secrets travel only through the future redacting logger. Test/script code may log.
- **Vue i18n**: raw user-facing strings in `ui/**` templates are lint errors (`vue-i18n/no-raw-text`, no exceptions since task 167's catalog, plus the rule's `attributes` option for static attribute literals — D-131's blind spot); catalog completeness — every used key exists, no dead keys, static literal lookups only, no bound-literal attribute disguises, and the attribute list in lockstep with the ESLint rule (decision D-132) — is pinned by `test/component/i18n-catalog.spec.ts`.
- **Lint contracts** are executable: `test/unit/vue-template-lint.spec.ts` and `test/unit/vue-i18n-lint.spec.ts` run the real ESLint binary — extend that pattern when adding lint rules that must not silently regress.
- **Time-zone regression matrix** (task 126, D-097): `npm run test:time` runs the time/peak-hours suite — the twelve spec files pinned by `test/unit/time-suite-manifest.spec.ts` (which fails `make check` when a pinned time/peak-hours spec leaves the selection; a spec added outside the filter vocabulary is the documented blind spot — name such specs after their modules). CI's `timezone` job runs it under nine process `TZ` values (the §17.1 zones plus `Asia/Kathmandu` and `Pacific/Kiritimati`) after `scripts/verify-tz.mjs` proves the zone took effect with the right canonical name and minute-exact DST/fractional-offset facts (compared numerically — ICU spells zero offsets differently across Node lines); `make test-time ZONE=<zone>` does one cell locally, `make test-time-matrix` walks all nine (part of `make check-all`). New zones join the script's table, the CI matrix, and `test/integration/tz-verify-script.spec.ts` together — that spec also scans the workflow's matrix structurally, so workflow drift fails a test.
- **Failing tests exit non-zero** everywhere (verified; documented in `test/README.md`) — CI relies on exit codes.
