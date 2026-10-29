# Code review scheme

## Launching

- The review runs as a CLI call to `opencode run` with the model
  `zai-coding-plan/glm-5.3#max`:

  ```bash
  timeout 1200 opencode run --auto \
    -m "zai-coding-plan/glm-5.3#max" \
    --title "review-<slug>" "$(cat /tmp/opencode/review/prompt-<slug>.md)" \
    > /tmp/opencode/review/<slug>-stdout.md 2>&1; echo "exit=$?"
  ```

- It runs **synchronously inside the subagent's session**: the subagent waits for `opencode run` to finish, processes the findings, and only then returns its final report. Do not run it in the background or "after the report" — the session would close before the result arrives and the findings would stay unprocessed.
- The review runs **once** per task; there are no repeat rounds.

## Reviewer rules

- Strictly **read-only**: it does not modify repository files and makes no commits or branches. Its only write is the report at `/tmp/opencode/review/NN-<slug>.md`.
- Report: findings **P0–P3** (P0 — security/data loss/crash; P1 — significant bug; P2 — code quality; P3 — ideas), `file:line`, essence, proposed fix, confidence (high/medium/low).
- Every finding is verified against context: callers/consumers are grepped through the repository before the finding enters the report; anything unconfirmed is not a finding.

## Handling results

- Agree with a finding → fix + `git commit --amend` + re-run `make check`.
- Disagree → reasoned justification in the report and the commit body.
- Reviewer unavailable (non-zero exit, provider error/limits in the stdout file) → the review does not run; the fact is recorded in the report and the commit body.
