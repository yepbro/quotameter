# Code review scheme

## Launching

- **Primary reviewer: kimi** (Kimi Code CLI; see `~/.config/opencode/agent-kimi.md` for auth/diagnostics). The review runs as a headless CLI call with the model `kimi-code/k3.1-pro`, from the working tree under review:

  ```bash
  timeout 1200 kimi -m kimi-code/k3.1-pro \
    -p "$(cat /tmp/opencode/review/prompt-<slug>.md)" --output-format text </dev/null \
    > /tmp/opencode/review/<slug>-kimi.md 2>&1; echo "exit=$?"
  ```

  Never combine `-p` with `-y`/`--auto`; `</dev/null` keeps it headless. The text output may prepend the reviewer's working transcript — locate the report body (severity-tagged findings) before treating the run as failed.

- **Fallback reviewer: `opencode run`** with `zai-coding-plan/glm-5.3#max` — used **only** when the primary produced no review (non-zero exit, auth/provider/quota error in the output file, or no findings text):

  ```bash
  timeout 1200 opencode run --auto \
    -m "zai-coding-plan/glm-5.3#max" \
    --title "review-<slug>" "$(cat /tmp/opencode/review/prompt-<slug>.md)" \
    > /tmp/opencode/review/<slug>-stdout.md 2>&1; echo "exit=$?"
  ```

  The review prompt must state the read-only constraint and the P0–P3 report format explicitly for kimi (the fallback receives the same prompt file).

- Either reviewer runs **synchronously inside the subagent's session**: the subagent waits for the CLI call to finish, processes the findings, and only then returns its final report. Do not run it in the background or "after the report" — the session would close before the result arrives and the findings would stay unprocessed.
- The review runs **once** per task; there are no repeat rounds. A failed primary + fallback round is still one round; if both fail, the review does not run.

## Reviewer rules

- Strictly **read-only**: it does not modify repository files and makes no commits or branches. Its only write is the report at `/tmp/opencode/review/NN-<slug>.md`.
- Report: findings **P0–P3** (P0 — security/data loss/crash; P1 — significant bug; P2 — code quality; P3 — ideas), `file:line`, essence, proposed fix, confidence (high/medium/low).
- Every finding is verified against context: callers/consumers are grepped through the repository before the finding enters the report; anything unconfirmed is not a finding.

## Handling results

- Agree with a finding → fix + `git commit --amend` + re-run `make check`.
- Disagree → reasoned justification in the report and the commit body.
- Primary (kimi) unavailable → run the fallback (`opencode run`); record which reviewer produced the round in the report and the commit body.
- Both reviewers unavailable (non-zero exit, provider error/limits in the output files) → the review does not run; the fact is recorded in the report and the commit body.
