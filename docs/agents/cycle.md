# Parallel development cycle

## Roles

The main session runs the cycle: it picks tasks, sets statuses, lands and verifies work. Each task is executed by a separate subagent launched in the background with full context: the task text, links to the spec sections, the worktree's absolute path as the working directory, the verification requirements, and the decision number allocated to the task (see "Decision numbers").

## Sliding window

- Up to **4 independent tasks** at a time; a strictly sequential pass happens only when every remaining task is dependent.
- Only **non-conflicting, non-overlapping tasks** run in parallel — the main session checks both dimensions before launching: **functionality** (no shared feature area, no task consuming what another task produces, no shared schema/contract changes) and **files** (the sets of files each task may touch are disjoint; a shared file means sequential execution). Tasks failing either check are dependent: they start strictly after the blocking task lands.
- A subagent completion notification is the signal to launch the next one from the queue immediately, without waiting for the others.

## Task execution order

1. The main session picks the next independent task with status `[new]`, sets it to `[in progress]` with a status commit on `master`, **records that commit's hash as the task anchor** (`XSTART`), creates the branch `t-NNN` and the worktree `~/worktrees/quotamonitor/t-NNN`, runs `make up` there (docktree isolates containers/volumes), and launches the subagent **in the background** with full context.
2. The subagent runs its inner loop — **design (`plan` skill) → implementation (after loading the `antfu` and `ts-library` skills, per the "Skills before writing code" non-negotiable in AGENTS.md) → tests → documentation** — and produces **one task commit** (Conventional Commits, English). No code before the design is complete. The subagent **never touches** `plan/tasks.md`: only the main session changes statuses (steps 1 and 5). Fixes from verification and review go through `git commit --amend`; the commit stays single. The subagent does not push or merge.
3. After a green `make check`, the subagent runs a **code review** following [review.md](review.md): one round; agreeing with a finding → fix + amend + `make check` again; disagreeing → reasoned justification in the report. There is no second review round.
4. On the completion notification, the main session verifies the result: the commit exists and is exactly one, `git status` is clean, the task status is `[in progress]`, and the report is complete (design, what was done, decisions, checks, review outcome, commit hash). When in doubt — targeted tests (`make test-unit` / `make test-integration`).
5. Verification passed → the main session **finalizes the task**: sets `[done]` and lands the work as **a single final commit exactly at the anchor position** (recipe in "Finalization (squash on the anchor)" below), then runs `make check-all` in the main tree. Green → the worktree and branch are removed. **Red** → roll `master` back to the pre-finalization state, fix on the branch (amend or relaunch the subagent), repeat from step 4.
6. The subagent returns a full report: the task design (architecture, files, scope of changes), what was done and which decisions were made, check results, review outcome (findings / fixes / rejections), commit hash. The main session cross-checks the report against the actual state.

## Finalization (squash on the anchor)

Outcome: **1 commit per task** on `master`. The start, work, and `[done]` status commits merge into one; the final commit lands exactly where the start commit sat (`A_start`), and everything after it is replayed onto the new parent:

```
before: ... — A_start — B_start — C_start          (master)
         ... — A_start … — A_task                  (t-A)

after:  ... — A_final — B_start' — C_start'        (master)
```

`A_final = A_start + A_task + [done]`; the prime marks are the same commits with new hashes. Finalization order does not have to match start order: every task lands on its own anchor.

```bash
BASE=$(git rev-parse "$XSTART^")

# 1) Move the task commit — and nothing else — onto BASE
#    (the task tree now contains ONLY its own changes — B/C starts stay non-empty).
#    The upstream is t-NNN^ (not master): after another task's finalization the
#    start commits this branch was cut from may no longer be in master, and
#    `--onto "$BASE" master` would replay those orphaned status commits into
#    the branch (observed live in the 059/060/069 wave).
git -C ~/worktrees/quotamonitor/t-NNN rebase --onto "$BASE" t-NNN^ t-NNN

# 2) In the worktree: the [done] flip in plan/tasks.md + the final message — amend.
#    IMPORTANT: after step 1 the branch is based on BASE (before the start commit),
#    so the task's status in the file is [new]; the flip is [new] → [done].
git -C ~/worktrees/quotamonitor/t-NNN commit --amend -F msg.txt

# 3) The final commit exactly at the anchor position
XFINAL=$(git commit-tree "t-NNN^{tree}" -p "$BASE" -F msg.txt)

# 4) Everything after the anchor moves onto the final commit
git rebase --onto "$XFINAL" "$XSTART" master
```

Rules:

- **Step 1 is mandatory**: rebasing the branch onto the `master` tip instead would bake the other tasks' start flips into the task tree, and step 4 would replay them as empty commits that git drops. Rebasing onto `BASE` keeps task changes discrete (subagents never touch tasks.md).
- **Orphaned start commits**: finalization drops other tasks' start commits from `master`, but a branch cut before that finalization still carries them, so the range `(master..t-NNN]` can contain more than the task commit — replaying it with `master` as the upstream bakes a foreign status flip into the task tree (seen live in the 059/060/069 wave). Step 1 avoids this by using `t-NNN^` as the upstream, which always selects exactly the one task commit. Safety check after any rebase of the branch: `git log --oneline "$BASE"..t-NNN` must show exactly one commit; if extras appear, drop them with another targeted rebase (`git rebase --onto "$BASE" <orphan-immediately-below-the-task-commit> t-NNN`).
- **Expected conflict on step 4**: task lines in `plan/tasks.md` are adjacent, so the finalized task's flip and a replayed start's flip touch overlapping hunks — git stops with a conflict in `tasks.md`. The resolution is mechanical: inside the conflict block, every task keeps its current status (`[done]` for finalized, `[in progress]` for running), then `git rebase --continue`. The recipe is verified by a live scratch test on the A/B/C scenario: the final landed at the anchor position and the B/C starts replayed non-empty.
- A finalization rewrites the hashes of later commits on `master` — safe, because pushing happens only on request. Branches of still-running tasks rebase normally at their own finalization (step 1 of their recipe).
- Anchor hashes of live tasks are invalidated by another task's finalization: after every finalization, recompute the anchors of the remaining tasks (the new hash of a start commit is found via `git log --grep` on the status commit message).
- `make check-all` in the main tree runs after step 4, before the branch is removed.

## Dual-mode statuses

- **Cycle (subagents)**: only the main session changes statuses in `plan/tasks.md`; `[done]` = green `make check-all` on `master`.
- **Solo (the main session does the task itself)**: the `[x] + [done]` flip is part of the task commit, as before.

## Decision numbers

Parallel subagents cannot see each other's `DECISIONS.md` edits, so tasks that record a decision independently pick the same next free `D-NNN` — observed live when the 061/063/070 wave all chose D-011 and the collisions had to be renumbered by hand at each finalization. Therefore:

- **The main session assigns the number at launch** and passes it in the subagent prompt ("record your decision as D-NNN"). Numbers are allocated in launch order, starting from the highest existing entry in `master`'s `DECISIONS.md` plus one; a task that ends up recording no decision simply leaves its number unused.
- **If a collision still slips through** (the number is already occupied when the task lands), fix it while landing, before the `[done]` amend: renumber the branch's entry heading, every in-tree reference to it (`src/`, tests, READMEs), and the `D-NNN` mentions in the commit message, then add a one-line renumbering note to the final message. This is how D-013 and D-014 were allocated during the 061/063/070 wave.

## Miscellany

- Blocked task: set it back to `[new]`, add a line with the reason underneath, take the next one.
- Forcibly stopping a subagent: `opencode session delete <sessionID>`; before that, reclaim the worktree (`git worktree remove --force`; container-created root-owned directories — via sudo) and delete the branch if needed.
- One-off tasks outside `plan/tasks.md` (CI, infrastructure, documentation): same rules, no status change in tasks.md, commit without a task number.
- In the main tree the main session makes only service commits: status commits, targeted fixes for checks that broke after a landing, AGENTS.md edits on explicit request.
