# Mutation testing: daily run, report, and triage

How the project's Stryker mutation testing is scheduled, how to inspect a
run, and how to act on the report. The placement decision (daily workflow
instead of a per-push gate) is [DECISIONS.md D-045](../DECISIONS.md); the
quality target comes from spec §17.3 (see
[`plan/SPECIFICATION.md`](../plan/SPECIFICATION.md)).

## What runs where

| Concern    | Answer                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| Trigger    | `schedule` cron `17 2 * * *` — daily at **02:17 UTC = 09:17 (UTC+7)** — plus manual `workflow_dispatch` |
| Executor   | GitHub-hosted `ubuntu-latest` runner — GitHub's infrastructure, nothing local is involved               |
| Definition | [`.github/workflows/mutation.yml`](../.github/workflows/mutation.yml) on the default branch (`master`)  |
| Subject    | The tip of `master` at run start (fresh checkout)                                                       |
| Tool       | Stryker via `npm run test:mutation`, configured by [`stryker.config.mjs`](../stryker.config.mjs)        |
| Cost       | Free — Actions minutes are not billed for public repositories                                           |
| Output     | Run artifact (JSON + HTML) and the rolling `mutation-report` issue                                      |

The pipeline inside the run: checkout → `npm ci` → Stryker
(`continue-on-error`, so a below-threshold score still produces the
report) → artifact upload → markdown rendered from the JSON report →
issue upsert through the preinstalled `gh` CLI (the repository pins
third-party actions by commit SHA and adds none here) → the job is marked
failed **after** reporting if the score is below the break threshold.

The workflow declares `permissions: { contents: read, issues: write }` —
the auto-injected `GITHUB_TOKEN` can create and edit issues and nothing
else. No secrets are stored anywhere for this to work.

## The rolling issue

- A single open issue labeled **`mutation-report`** carries the latest
  report as its body (title shows the last run date and verdict); the
  workflow creates the label itself before first use, via
  `gh label create … || true`, so the repository needs no one-time setup.
- Every run **appends a one-line comment**, so the comment thread is the
  history of verdicts over time.
- Find it from the command line:

  ```bash
  gh issue list --label mutation-report --state open
  ```

## How to check a run

```bash
# Latest runs of the workflow
gh run list --workflow=mutation.yml --limit 5

# One run, step by step (validates the manual trigger the same way)
gh run view <run-id>

# Follow a running one live
gh run watch <run-id>

# Download the JSON/HTML report artifact of a finished run
gh run download <run-id> -n mutation-report -D /tmp/mutation-report

# Trigger an out-of-schedule run (e.g. right after landing risky logic)
gh workflow run mutation.yml --ref master
```

The issue body is rendered by
[`scripts/render-mutation-report.mjs`](../scripts/render-mutation-report.mjs)
— the workflow's render step just calls it — so any downloaded artifact can
be re-rendered locally (also how renderer changes are verified against a
real report before landing):

```bash
node scripts/render-mutation-report.mjs /tmp/mutation-report/mutation/mutation.json
```

The verdict line follows `STRYKER_OUTCOME` (`failure` means below the break
threshold); prefix the command with `STRYKER_OUTCOME=failure` to preview a
red run faithfully, since a hand run without the variable always reads as
passing.

The HTML report (`mutation.html` in the artifact) shows every mutant with
its diff — the most convenient view while triaging.

## How to read the report

- **Verdict** — `within the configured thresholds` or `below the
configured break threshold`. Thresholds live in
  `stryker.config.mjs` (`high: 80`, `low: 60`, `break: 60` today).
- **Mutation score** — `detected / scoreable`, where detected = `killed` +
  `timed out` and scoreable = killed + timed out + survived + noCoverage —
  Stryker's own formula (decision D-055). Deliberately ignored mutants
  (in-code `// Stryker disable` exclusions) and error-status mutants leave
  the denominator but stay visible as counts. The break threshold is what
  fails the daily job.
- **Per-file table** — where the survivors concentrate; start triage with
  the file that has the lowest score, not the first line.
- **Runtime/compile errors** — mutants that broke the test run itself; they
  are excluded from the score (D-055) and surface as neither detected nor
  survived, and the summary lists their files when any exist.
- **Survived mutants** — `file:line — MutatorName`. Each is a concrete
  behavioral change the current tests failed to detect.

## How to react

1. **A manageable survivors list (the normal case).** Work it like a
   backlog: pick a survivor, look at `file:line`, and either
   - **write the killing test** — the mutant describes an exact behavior
     change; assert that behavior; or
   - **ignore it deliberately** — when the mutant is equivalent or the
     behavior is intentionally unspecified, exclude it next to the line
     with Stryker's ignore comments (`// Stryker disable next-line …`,
     see the [Stryker exclusion docs](https://stryker-mutator.io/docs/configuration/mutator-exclusions/))
     so the exclusion is visible in the code and reviewed with it. Keep the
     reason short and English; Stryker's ignore granularity is one line per
     mutator, so an exclusion may also cover line-mates — say so in the
     reason when it does. Ignored mutants leave the score denominator
     (D-055) but stay visible as a count in the report.
2. **`noCoverage` mutants** — no test executes the line at all; add the
   missing test before anything finer-grained.
3. **Job red (below break threshold)** — treat as a regression of the
   quality gate: triage the worst files first, land killing tests, and
   re-run the workflow manually (`gh workflow run mutation.yml`) to
   confirm instead of waiting a day. Do not lower thresholds to make a
   report green; raising them when the §17.3 critical modules
   (reset detection, peak-hours, sanitization, downsampling) land is the
   expected direction (task 055 plan).
4. **Turning findings into work.** During the development cycle, a triage
   conclusion becomes a normal planned task or an `U-NNN` entry in the
   "Unplanned tasks" section of [`plan/tasks.md`](../plan/tasks.md); the
   next daily run reflects the landed fixes automatically.
5. **`timed out` mutants** count as detected, but a growing count signals
   slow or hanging tests — worth a look before it eats the runner budget.

## Running locally

```bash
make mutation          # full Stryker run in the dev container (~30 min on 8 cores)
```

Reports land in the container's report volume (`REPORTS_DIR`, see
[`docs/agents/environment.md`](agents/environment.md)); the JSON reporter
writes the same `mutation/mutation.json` the GitHub workflow consumes, so
a local HTML/JSON review works identically to the artifact.

## Operational notes

- **Schedule drift is normal** — GitHub queues cron runs and can be late
  by tens of minutes in busy windows; the non-round minute (`17`) keeps
  us out of the worst congestion.
- **60-day inactivity** — GitHub auto-disables scheduled workflows in
  repositories without commits for 60 days. Active development never hits
  this; re-enable with `gh workflow enable mutation.yml` if it ever fires.
- **Pausing** — `gh workflow disable mutation.yml` (and `enable` to
  resume). The per-push CI and `make check-all` are unaffected either way:
  mutation does not gate pushes (D-045).
- **If the issue-upsert step fails** (for example after a permissions
  change), the artifact still contains the full report — re-rendering the
  issue is a manual `gh issue create --label mutation-report` away.
