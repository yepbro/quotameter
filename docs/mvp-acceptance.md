# MVP acceptance criteria — evidence verification (spec §19)

Task 199 (plan/tasks.md): "Verify every MVP acceptance criterion — Review each
criterion in §19 against automated evidence, clean-install results, and
documentation. Done when: no criterion is marked complete without evidence."
This page is that verification: one section per §19 criterion, each naming the
evidence that supports the verdict. Decision D-209 records the method and the
summary; nothing here claims more than the cited evidence shows.

**Verification date: 2026-11-09.** Re-verify before the `1.0.0` release that
closes §19 (see the final section).

## Method and evidence classes

Every verdict below rests on evidence from at least one of these classes, named
inline:

- **Automated suites** — a spec file (or suite family) that runs in
  `make check`/`make check-all` or a CI job, green in the task-197 gate audit
  (D-207: 257 spec files in `make check`, 61/61 E2E, all three coverage
  threshold layers green).
- **Clean-container execution** — the §17.2 matrix runs: the six-cell
  two-runtime install matrix (D-203: Ubuntu 22.04/24.04 + Debian stable × Node
  22.13.0/24.22.2, executed 2026-11-08 through the CI step bodies verbatim,
  provider blackholed) and the systemd lifecycle scenarios (D-206: real systemd
  PID 1, three phases split by two container reboots, `make test-systemd`
  green).
- **Live observation** — the task-198 real-account smoke (D-208,
  [docs/smoke-test.md](smoke-test.md)): nine scenarios against the live Z.ai
  API with the owner's console cross-check.
- **Documentation** — a deliverable file named by §18, pinned against drift by
  its own guard spec where one exists.
- **CI wiring** — a CI-only job pinned executably by a structural guard spec
  that runs inside `test:ci` (so the wiring itself is tested on every push)
  while the job's first pushed execution is still pending; recorded as
  wiring-verified, never as executed.

Facts recorded precisely where they bound a verdict: the last green `CI` run on
`master` is 42458066716 (2026-11-08T07:15:48Z, push of `e358788`); it predates
the task-195 two-runtime install matrix and the task-196 `systemd` job, whose
first pushed-run execution is therefore still pending (residual R2).

## Verdict legend

- **Complete** — the criterion's own words are met, with named evidence.
- **Complete with residual** — the criterion's own words are met, with named
  evidence; a separately-tracked open item touches an adjacent surface, named
  so it cannot be lost.
- **Pending** — part of the criterion still lacks evidence that cannot exist
  yet; the missing piece and its owner are named. A pending criterion is not
  marked complete.

## Summary

| #   | Criterion (abbreviated)                                                                       | Verdict  | Primary evidence anchor                                                           |
| --- | --------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| 1   | Installs and runs on supported Linux/systemd targets, Node ≥ 22.13.0, clean containers        | Complete | D-203 six-cell matrix; D-206 scenarios; D-196                                     |
| 2   | `init` requires IANA tz; system unit, user unit, or exact manual instructions                 | Complete | CLI suites; D-206; `docs/examples/`                                               |
| 3   | Accounts added via CLI or UI and tested independently                                         | Complete | smoke scenario 1; credential-check probe; UI E2E; R1 closed by U-061 (D-210)      |
| 4   | 5-min default interval; runtime changes; immediate post-startup collection                    | Complete | schema default 300; reload suites; smoke scenarios 2/3/5                          |
| 5   | SQLite via `node:sqlite`; migrations with pre-migration backups                               | Complete | migration suites; smoke scenario 4                                                |
| 6   | Light/dark/system themes; current values; 24 h–30 d charts; disabled out-of-retention ranges  | Complete | E2E `themes`, `history-ranges`; component suites                                  |
| 7   | Reset/gap/error/peak markers with correct TZ/DST                                              | Complete | E2E `chart-markers`; peak-hours suites; TZ matrix                                 |
| 8   | API failures preserve last valid values, visible; parse failures retain sanitized diagnostics | Complete | smoke scenario 7; §7.2–§7.4 suites; R1 closed by U-061 (D-210)                    |
| 9   | No browser needed; restarts after failure and reboot                                          | Complete | D-206 crash-restart and reboot phases; smoke environment                          |
| 10  | Password for remote; loopback `auto` passwordless; CSRF/Origin and Host guards in all modes   | Complete | security suite family; smoke ran in `auto` loopback                               |
| 11  | Keys never leak to assets/logs/API/errors/diagnostics; config permissions enforced            | Complete | sanitize/secrets suites; smoke scenario 8                                         |
| 12  | All artifacts English; every §18 deliverable present                                          | Complete | §18 inventory below; `test/component/i18n-catalog.spec.ts`                        |
| 13  | Gates pass in CI; publication from GitHub Actions with provenance                             | Complete | green pushed runs 42641831541, 42652784987; v0.1.0 provenance publish 42654771911 |
| 14  | Z.ai source and payload contract documented with links/fixtures; nothing guessed              | Complete | D-199 dossier + drift guard; D-208 live confirmation                              |

All fourteen criteria are met by their own words — fourteen clean after
U-061 (D-210) closed residual R1 on criteria 3 and 8 and task 200's release
cycle closed residuals R2 and R3 on criterion 13 (2026-11-09). No criterion
is marked complete without evidence.

## Criterion-by-criterion verification

### 1. Install and run on supported targets, verified in clean containers

**Demands.** The public npm package installs and runs on supported
Linux/systemd targets using Node.js `>=22.13.0`, verified in clean containers
(§19.1).

**Evidence.** The D-203 matrix: the packed tarball installed globally and
verified (`--version`, `--help`, no install-time lifecycle scripts, no native
addons, `dist/` present) in all six cells — Ubuntu 22.04, Ubuntu 24.04, Debian
stable × Node 22.13.0 and 24.22.2 — executed 2026-11-08 through the CI step
bodies verbatim, compiler-free containers, provider host blackholed for
`init --yes`; the unsupported-Node arm (Node 20) refuses with the clear error
naming `22.13.0`. The systemd-target half: D-206's scenarios install and start
the service under a real systemd PID 1 (Debian 12, systemd 252, Node 22.13.0).
The matrix is wired as CI's `install` job and pinned by
`test/unit/ci-workflow.spec.ts`; its first pushed-run execution is tracked as
residual R2 under criterion 13 (criterion 1 demands clean-container
verification, which the executed matrix provides).

**Verdict — Complete.**

### 2. `init`: mandatory IANA time zone; system unit, user unit, or manual instructions

**Demands.** `quotameter init` requires an explicit IANA time zone and
configures the application/service; it installs a system unit with appropriate
privileges, a user unit without sudo, or provides exact manual instructions
(§19.2, §5.3).

**Evidence.** The mandatory-time-zone contract is pinned by the CLI init
suites (`test/unit/cli-init.spec.ts`, `test/unit/cli-init-yes.spec.ts`) and the
configuration reference's cross-field validation pin
(`test/unit/configuration-reference.spec.ts`; IANA zone validation in
`findConfigProblems`). All three installation outcomes are proven by execution:
D-206's scenarios install the **system unit** through the genuine privileged
route (regular-account session, `sudo quotameter service install`, SUDO_USER
resolution) reaching active+enabled+healthy; the **user unit** from a PAM login
session without sudo (then the linger pair, disabled-first with the exact
`loginctl enable-linger` guidance, enabled across a second reboot); and the
**systemd-less** manual path is the D-160 capability probe's degraded outcome,
pinned by the CLI seam suites and exercised by every install-matrix cell (no
systemd in the stock containers). The operator documentation: README's
"Service scope" section and `docs/examples/quotameter.service` /
`docs/examples/quotameter-user.service`, generator-pinned by
`test/unit/systemd-unit-examples.spec.ts`.

**Verdict — Complete.**

### 3. Accounts added through CLI or UI and tested independently

**Demands.** One or more Z.ai Coding Plan accounts can be added through CLI or
UI and tested independently (§19.3).

**Evidence.** CLI: `init` account setup with the connection test, and the
per-account independence of polling (no overlap per account) pinned by the
polling suites (`test/unit/polling-scheduler.spec.ts` and the §7.1 family).
UI: `test/e2e/acceptance/account-management.spec.ts` (adding an account,
masked key entry) and the component suites. Live: smoke scenario 1 — a real
account added via `init --yes --api-key-env`, "Connection test passed" against
the live provider; the credential-check endpoint's rejection arm was also
probed live (D-208): a bogus key gets a genuine HTTP 401 and classifies
correctly (`credentials-rejected`) — the connection test the criterion names is
observation-backed correct.

**Residual R1 — closed by U-061 (D-210), history kept:** the smoke also
observed that the **collection** endpoint answers a bad key with HTTP 200 +
`{"code":401,...}`, and the adapter then misclassified that envelope as
`parse_error`/`format-changed` (bypassing the D-064 suspension machinery on
that path). That defect sat on the collection path, not on the add/test path
this criterion's words describe; U-061 landed the auth classification end to
end with the retained body as a contract fixture, and the same live-shape
coverage now pins it (also under criterion 8).

**Verdict — Complete (residual R1 closed by U-061, D-210: the envelope-encoded rejection now classifies as the §7.2 auth outcome end to end, with the provider's sanitized reason in `lastError`).**

### 4. Five-minute default interval; runtime changes; immediate startup collection

**Demands.** The service collects on a five-minute default interval, supports
runtime interval changes, and performs a collection immediately after
startup/restart (§19.4, §7.1).

**Evidence.** The default: `schema/config.schema.json` sets
`pollingIntervalSeconds` default `300`, pinned against the reference by
`test/unit/configuration-reference.spec.ts`. Runtime changes: §6.4 reload
(`test/unit/cli-service-reload.spec.ts` and the reloader suites; applied-lists
semantics) plus live observation — smoke scenario 5 changed 60 s → 120 s with
SIGHUP and the observed cadence moved accordingly. Immediate collection:
`test/unit/polling-scheduler.spec.ts` (immediate startup poll, monotonic
scheduling), `test/integration/composition-polling.spec.ts` (the first poll
through the real composition), and live — smoke scenario 2: `collection_runs`
row 1 starts at boot +0 s. Cadence itself observed at the configured interval
(scenario 3).

**Verdict — Complete.**

### 5. SQLite persistence through `node:sqlite`; migrations with pre-migration backups

**Demands.** Historical data persists in SQLite through `node:sqlite`;
migrations run through the selected migration library with pre-migration
backups (§19.5, §11).

**Evidence.** The storage suites: `test/integration/migrations.spec.ts`
(migrations from every supported prior schema, refusal of newer schema),
`test/integration/startup-migrations.spec.ts` (the service's startup path),
`test/integration/history-retention.spec.ts` (retention/cleanup), with
transaction atomicity, WAL, and the single-instance lock covered by the §17.1
storage row (green in the D-207 audit). Pre-migration backups: the internal
keep-3 `backups/backup-*.sqlite` behavior asserted by the migration suites and
documented for operators in README's "Backups and restore" (§11.4). Live:
smoke scenario 4 — every cycle persisted to `metric_values` and `/api/history`
served the real points across the observation span (04:20–04:34Z).

**Verdict — Complete.**

### 6. Themes, current values, and the five history ranges

**Demands.** The English UI supports light/dark/system themes, current values,
and separate metric charts for 24 hours, 3, 7, 14, and 30 days; ranges outside
retention are disabled (§19.6, §14).

**Evidence.** `test/e2e/acceptance/themes.spec.ts` (light/dark repaint) with
`test/e2e/theme.spec.ts` and `test/component/theme.spec.ts` pinning the `system`
mode's OS-preference resolution; `test/e2e/acceptance/history-ranges.spec.ts`
(the five ranges and the disabled state outside retention); current values by
`test/component/overview-view.spec.ts` (the metric cards and their values) and
the per-metric charts by `test/component/chart-series.spec.ts` and
`test/component/metric-history-chart.spec.ts`.
All E2E green (61/61) in the D-207 audit, which also verified the axe
accessibility cells and responsive sizes (§17.1's E2E list).

**Verdict — Complete.**

### 7. Chart markers and time-zone/DST correctness

**Demands.** Charts show reset markers, gaps, collection errors, and configured
peak/off-peak intervals with correct time-zone/DST handling (§19.7, §9, §12).

**Evidence.** `test/e2e/acceptance/chart-markers.spec.ts` proves the E2E half
of §17.1's marker list — reset/gap/error markers through the chart's accessible
name and the configured peak schedule loaded through `/api/peak-hours`; the
peak band's on-chart rendering is pinned at the component layer by
`test/component/chart-series.spec.ts` (the peak-band series cells);
peak/off-peak windows by `test/unit/peak-hours-intervals.spec.ts` and its
property suite; reset detection, gap thresholds, and downsampling by their
§17.1 suites (events and downsampling rows, green in D-207). Time-zone/DST:
the nine-zone matrix — CI's `timezone` job runs `scripts/verify-tz.mjs` plus
the time/peak suite per `TZ`, including DST transitions, 23/25-hour days, and
the half/quarter-hour zones (§17.1's time-zone row).

**Verdict — Complete.**

### 8. API failures preserve values and surface; parse failures retain sanitized diagnostics

**Demands.** API failures preserve the last valid values and are visible in the
UI; parse failures retain sanitized diagnostic responses (§19.8, §7.2–§7.4).

**Evidence.** The §7.2/§7.3 suites: `test/unit/polling-status.spec.ts` and the
status-precedence family (the nine statuses and error visibility), with
last-valid preservation pinned by `test/integration/api-status.spec.ts` (an
invalid newer reading never erases the last valid per-metric value) and
`test/integration/api-history.spec.ts` (the UI's history data source); §7.4
retention (`test/integration/raw-response-retention.spec.ts`,
`test/unit/sanitize.spec.ts` and its property suite — sanitized payloads only).
Live: smoke scenario 7 — a real
auth failure preserved the last valid values, the error state was visible
through the API the UI renders, and the provider's diagnostic message was
retained sanitized (readable through `quotameter doctor --raw`). The
criterion's own two sentences held in the live run.

**Residual R1 — closed by U-061 (D-210), history kept:** the same live run
exposed that the collection path's envelope-encoded rejection classified as a
parse/format failure rather than an auth failure — visible and diagnosed
(this criterion's words), but under the wrong label. U-061 landed the
taxonomy fix: the envelope 401/403 now classifies as `auth_error` end to end
(auth episodes, suspension machinery, the §7.3 auth status), and the
provider's reason surfaces in `lastError`; §7.4 raw-response retention
remains parse-scoped per spec. The pre-fix observation that the delivered
envelope was readable through `quotameter doctor --raw` described the
then-misclassified (parse) cycle — the auth-classified cycle's diagnostic
surface is `lastError`.

**Verdict — Complete (residual R1 closed by U-061, D-210: the envelope-encoded rejection now classifies as the §7.2 auth outcome end to end, with the provider's sanitized reason in `lastError`).**

### 9. No browser needed; restarts after failure and reboot

**Demands.** Collection works without an open browser; the service restarts
after failure and machine reboot (§19.9).

**Evidence.** Architecture: the poller is a headless server process; the
entire smoke ran without any browser (its environment section records that the
UI was not driven at all — connection, collection, cadence, and history all
observed through the service). Restart after failure: D-206's crash scenario —
SIGKILL the supervised pid, systemd's `Restart=on-failure` brings a new pid,
`NRestarts` counted, and the restarted instance re-acquires the §5.6
single-instance lock. Machine reboot: D-206's reboot phases — enablement
survived two genuine container reboots (fresh PID 1), for the system unit and
the lingered user unit alike.

**Verdict — Complete.**

### 10. Password-protected remote access; `auto` loopback; CSRF/Origin and Host guards

**Demands.** Remote access is protected by a password; direct loopback access
may be passwordless in `auto` mode; CSRF/Origin and Host/DNS-rebinding
protections operate in all modes (§19.10, §15).

**Evidence.** The §17.1 security matrix suites: `test/integration/api-auth-mode.spec.ts`
(bind × proxy × password presence), `test/integration/composition-auth.spec.ts`,
`test/unit/api-host-guard.spec.ts` + `test/integration/api-host.spec.ts` (Host
allowlist, DNS rebinding), `test/integration/security-headers.spec.ts` (CSP and
headers), `test/integration/sessions-authentication.spec.ts` (rate limits,
expiry, revocation), `test/integration/api-sweep-security.spec.ts` (the
end-to-end sweep), and CSRF/Origin rejection in the guard suites — green in
the D-207 audit. Live: the smoke ran in the designed `auto` loopback
passwordless shape; non-loopback requires a password by §15.1's rule, pinned by
the same suites.

**Verdict — Complete.**

### 11. No key leakage; enforced config permissions

**Demands.** API keys do not leak to browser assets, logs, APIs, errors, or
diagnostic interfaces, and config permissions are enforced (§19.11, §6.3,
§15.4).

**Evidence.** The §17.1 secrets row: marker-secret scenarios across logs, API
responses, client bundle, error text, and sanitized payloads
(`test/unit/sanitize.spec.ts` + property,
`test/integration/raw-response-retention.spec.ts`, the raw-response gate,
`test/integration/api-sweep-secrets.spec.ts`, and the UI-side non-inclusion
cells). Config permissions: the §6.3 `0700`/`0600` enforcement in
`test/integration/config-permissions.spec.ts` (`enforceConfigPermissions`,
exact modes, drift correction, hostile umask) and
`test/integration/cli-init-idempotent.spec.ts` — additionally
asserted in every clean-container `init` cell (D-203) and the systemd
scenarios (D-206). Live: smoke scenario 8 — an exact-value scan of the whole
container after the run (logs, API responses, errors, diagnostics, database)
found zero occurrences of the key.

**Verdict — Complete.**

### 12. English-only artifacts; every §18 deliverable present

**Demands.** All repository artefacts and documentation are in English and all
documentation in §18 is present (§19.12, §18, §4.1).

**Evidence.** The §18 inventory, each file present:

| §18 deliverable                                          | Path                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| README (install, init, key, accounts, lifecycle, VPS, …) | `README.md` (D-198, pinned by `test/unit/readme-command-table.spec.ts`)             |
| Configuration reference                                  | `docs/configuration.md` (D-197)                                                     |
| Published JSON Schema                                    | `schema/config.schema.json`, `docs/config-schema.md`                                |
| Sample config                                            | `docs/config.example.json`                                                          |
| Z.ai provider doc (verified behavior, peak-hours source) | `docs/providers/zai-coding-plan.md` (D-199)                                         |
| Example system/user unit files                           | `docs/examples/quotameter.service`, `docs/examples/quotameter-user.service` (D-200) |
| CONTRIBUTING / CHANGELOG                                 | `CONTRIBUTING.md`, `CHANGELOG.md`                                                   |
| LICENSE / NOTICE                                         | `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES` (D-201)                                  |
| Generated OpenAPI documentation                          | `docs/openapi.json`, `docs/api.md` (D-202)                                          |

English-only is a standing project rule (spec §4.1, enforced in review across
commits, docs, UI strings, and logs); the UI's message surface is pinned to its
English catalog by `test/component/i18n-catalog.spec.ts` (key completeness —
no untranslated string ships).

**Verdict — Complete.**

### 13. Gates pass in CI; publication from GitHub Actions with provenance

**Demands.** Tests pass in CI; lint, type checks, format checks, coverage,
package audit/license checks, package build, `npm pack`, and clean installation
tests pass; npm publication occurs from GitHub Actions with provenance
(§19.13, §17.3, §4.4).

**Evidence for what has evidence.** Every gate named has a green home: the
D-207 audit ran formatting, lint, both type checks, the 257-file suite with all
coverage layers, the TZ matrix, build verification, E2E, audit, licenses, the
tarball allowlist, and the systemd scenarios green in the task worktree; the
first green pushed `CI` run carrying the complete current job set — including
the two-runtime `install` matrix (D-203) and the `systemd` job (D-206) — is
**42641831541** (2026-11-09, push of `16e616c`, all 25 jobs green), and
**42652784987** (push of `163621c`, green after one rerun of a single
load-flake matrix cell) repeats it.

**Residual R2 — CI currency — closed 2026-11-09.** The runs above are pushed
green runs that include both previously-unexecuted jobs; the wiring guards
(`test/unit/ci-workflow.spec.ts`, `test/unit/systemd-scenario.spec.ts`) keep
the job set pinned inside every `test:ci`.

**Residual R3 — the publication clause — closed 2026-11-09 by task 200's
`v0.1.0` release cycle.** The release workflow published `v0.1.0` from the
`v0.1.0` tag (run **42654771911**, green through the tag/version gate, the
green-CI gate, the containerized test suite — see U-062/D-211 for the first
attempt's environment failure and the re-pointed tag — the builds, and the
tarball allowlist) with provenance verified live: `npm view quotameter@0.1.0 dist.attestations`
prints the attestations object with the
SLSA provenance predicate, `dist-tags.latest` moved off the D-204 `0.0.0`
reservation stub, and the clean-container install on `node:22.13.0-slim`
answers `0.1.0` through the registry-installed command. The publish also
validated the pending trusted-publisher configuration inside its 48-hour
window (D-204). The §19-closing milestone evidence remains due at `1.0.0`
(D-186).

**Scope note.** The daily mutation gate is not named by this criterion's
words; its own post-repair live verification is recorded in D-207 as pending
the next scheduled run.

**Verdict — Complete.**

### 14. Z.ai source and payload contract documented; nothing guessed

**Demands.** The verified Z.ai quota-data source and payload contract are
documented with links and fixtures; unsupported or undocumented response fields
are not guessed (§19.14, §8.3).

**Evidence.** `docs/providers/zai-coding-plan.md` carries the task-189
claim-by-claim evidence audit (D-199): every endpoint, authentication,
envelope, mapping, units, error-behavior, and schedule claim classified as
in-repo-evidenced or official-source-evidenced with URL and access date — no
unbacked claim — plus the complete fixtures inventory (3 sanitized + 22
synthetic Z.ai + 2 provider-neutral) and the peak-hours official references.
The load-bearing claims are pinned by `test/unit/provider-dossier.spec.ts`
(documented URLs match the adapter, fixtures agree with the directory in both
directions, every cited suite and decision exists). "Not guessed": the mapping
discipline (D-047/D-057 — percentages never invent counts) and the §17.1
adapter row (unknown-field and changed-schema tolerance; invalid values never
become zero). Live: D-208's smoke confirmed the envelope and error shapes
against the real provider and resolved the dossier's assumptions A2/A3 by
their own rules, retaining the observed bodies as contract material.

**Verdict — Complete.**

## Residuals and owners

| ID  | Essence                                                                                                                                                                                                                                                                 | Criteria touched        | Owner  | Closes when |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------ | ----------- |
| R1  | ~~Envelope-encoded auth rejection on the collection path misclassifies as `parse_error`/`format-changed`~~ **closed 2026-11-09 by U-061 (D-210)** — the auth outcome end to end, the retained body a contract fixture                                                   | 3, 8                    | closed | —           |
| R2  | ~~The two-runtime `install` matrix and the `systemd` CI job have never executed on a pushed run~~ **closed 2026-11-09** — green `CI` runs 42641831541 (push of `16e616c`) and 42652784987 (push of `163621c`) include both jobs                                         | 13 (CI clause)          | closed | —           |
| R3  | ~~"npm publication occurs from GitHub Actions with provenance" — no release published yet~~ **closed 2026-11-09 by task 200's `v0.1.0` release cycle** — published from `.github/workflows/release.yml` (run 42654771911) with SLSA provenance verified on the registry | 13 (publication clause) | closed | —           |

## Re-verification at 1.0.0

§19 closes at `1.0.0` (D-186: the milestone release that must satisfy every
criterion). Before that release, re-verify this matrix:

1. R2 closed 2026-11-09 — the green pushed `CI` runs 42641831541 and
   42652784987 include the two-runtime `install` matrix and the `systemd`
   job; at `1.0.0`, cite that release cycle's own green run.
2. R3 closed 2026-11-09 — `v0.1.0` was published from the release workflow
   with SLSA provenance (run 42654771911; the checklist's post-release
   verification printed the attestations). At `1.0.0`, re-run the same
   verification for that version.
3. R1 closed 2026-11-09 by U-061 (D-210) — criteria 3 and 8 re-verified
   against its landed contract tests; nothing further owed for R1.
4. Re-run the cheap local gates (`make check`) so the suite references above
   are fresh, and update this page's verification date.

This page is pinned by `test/unit/mvp-acceptance.spec.ts`: the §19 criterion
count, the per-criterion sections and verdict vocabulary, the residual names
(U-061, task 200, `1.0.0`), the README link, and the existence of every
repository path cited above — so the evidence cannot silently rot.
