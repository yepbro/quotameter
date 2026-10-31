# AGENTS.md — agent instructions for Quotameter

Brief rules and pointers. Details live in separate documents under `docs/agents/` — follow the links when the task touches that area. Human-facing docs (`README.md`) are for people; read them only when explicitly needed.

## Project

- **Quotameter**: self-hosted web service monitoring usage quotas for AI subscriptions. v1.0 supports Z.ai Coding Plan. Public npm package `quotameter`, repository `yepbro/quotameter`.
- **Source of truth**: `plan/SPECIFICATION.md`. Consult it **by section number** (§ references come from `plan/tasks.md`); grep the section heading instead of reading the whole file.
- **Work tracker**: `plan/tasks.md` — tasks are executed in plan order, one commit per task.
- **Decisions**: `DECISIONS.md` — entries are immutable; a changed decision gets a new `D-NNN` entry referencing the old one.

## Non-negotiables

- **English only** for every repository artifact: commits, code comments, docs, UI strings, CLI output, logs (spec §4.1).
- **Conventional Commits** (`feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`); imperative subject ≤72 chars.
- **Plan before code**: before implementing any plan task — design first via the `plan` skill (architecture, affected files, scope of changes). No code is written until the design is complete.
- **Skills before writing code**: before writing or reviewing TypeScript (implementation and tests), load the `antfu` and `ts-library` skills — this applies to the main session and to subagents alike. Follow their conventions where they do not conflict with the specification, `DECISIONS.md`, or the project's existing files; on conflict the project's own rules win.
- **Tests are mandatory**: new or changed logic ships with tests (happy path + errors + edge cases) in the same commit. A failing test is fixed within the task that broke it, never deferred. Green `make check` before committing; green `make check-all` before landing in `master`.
- **Task statuses are dual-mode**: in the subagent cycle only the main session changes statuses in `plan/tasks.md` (`[done]` = green `make check-all` on `master`); in solo mode the `[x] + [done]` flip is part of the task commit.
- A task's **done-condition must be genuinely verified**; describe the verification in the commit body.
- **Push to the remote only on an explicit user request.** Never push autonomously.
- **Linear history**: no merge commits — rebase or fast-forward; remote merges are squash-only.
- **The spec settles disputes**: interpretation doubts are resolved from the text of `plan/SPECIFICATION.md`; the decision is recorded — briefly in the commit body, in detail in `DECISIONS.md`.
- **Do not break public contracts**: changes to API, formats, or events require a `DECISIONS.md` entry and updated affected documentation.

## Documentation upkeep

Every change ships with updates to the markdown files it affects: task statuses, `CHANGELOG.md` (Unreleased), spec/plan cross-references, README or CONTRIBUTING when behavior changes. Project docs are never left stale, and documentation is updated **after** green test runs, not before.

## Commands

All commands go through `make` and run inside the worktree's container (no host Node.js needed):

- `make check` — fast local gate (format, lint, type checks server + UI, tests).
- `make check-all` — full CI parity; **run it before a push is requested** (plain `make test` does not enforce coverage thresholds; CI does).
- Individual checks: `make test-unit`, `make lint`, `make typecheck`, …; `make help` lists everything.
- Fresh checkout: `make image up` once; everything else auto-starts.

## Area guides

- **Parallel development cycle** (independent non-overlapping tasks, subagents, worktrees, statuses, one-commit finalization) → [docs/agents/cycle.md](docs/agents/cycle.md)
- **Code review** (single round, `opencode run` + glm-5.3#max, P0–P3) → [docs/agents/review.md](docs/agents/review.md)
- **Docker, docktree, worktrees, generated-output rules** → [docs/agents/environment.md](docs/agents/environment.md)
- **Git protocol, CI structure, Dependabot, releases** → [docs/agents/workflow.md](docs/agents/workflow.md)
- **Testing conventions** → [docs/agents/testing.md](docs/agents/testing.md)
- **Known pitfalls** → [docs/agents/gotchas.md](docs/agents/gotchas.md)
