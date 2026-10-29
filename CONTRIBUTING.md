# Contributing to Quotameter

Thank you for contributing! This guide covers the repository rules. The design baseline is the [Technical Specification](plan/SPECIFICATION.md); planned work is tracked in the [Implementation Task Plan](plan/tasks.md).

## Language

All repository artefacts must be in **English**: branch names, issues, pull requests, commit subjects and bodies, source comments, documentation, UI strings, CLI output, API errors, and logs. See [spec §4.1](plan/SPECIFICATION.md#41-public-repository-and-language).

## Commits

This project uses [Conventional Commits](https://www.conventionalcommits.org/). A commit message looks like:

```
<type>(<optional scope>): <short imperative subject>

<optional body explaining why>
```

Common types:

- `feat` — a new feature
- `fix` — a bug fix
- `docs` — documentation only
- `test` — tests only
- `refactor` — code change that neither fixes a bug nor adds a feature
- `chore` — tooling, repository configuration, CI, dependencies
- `perf` — performance improvement

Rules:

- Subject in English, imperative mood, lowercase after the colon, no trailing period.
- Keep the subject under ~72 characters; put details in the body.
- One logical change per commit.

## Branches and pull requests

- `master` is the default branch and is protected: changes land through pull requests, the required `CI` check must pass, force-pushes and branch deletion are disabled.
- Pull requests are merged with **squash merge**; the branch is deleted automatically after merge. Make sure the final squash subject follows Conventional Commits.
- Use the pull-request template; fill in every section, including security and documentation impact.
- Reference the related issue (`Closes #N`) or plan task number (e.g. `Task 0NN`) in the pull request.

## Secrets

Never commit API keys, passwords, tokens, cookies, or raw provider responses. Local configuration belongs in files ignored by `.gitignore` (`.env`, `*.db`, `config.local.json`). See [spec §15.4](plan/SPECIFICATION.md#154-secret-protection).

## Planned work

Work items come from [plan/tasks.md](plan/tasks.md). When a task is completed:

1. Flip its checkbox to `[x]` and its status to **[done]** — only when its stated acceptance condition is met, not merely when code was written.
2. Keep task numbers stable.
3. Include the status update in the same commit as the work it describes, when the work produces commits.

## AI-assisted development

Agent skills and MCP servers used in this repository are part of its tooling and must stay reproducible:

- **Skills** are installed locally into `.agents/skills/` (git-ignored) and are **recorded in [`skills-lock.json`](skills-lock.json)**, which is committed. Restore them on a fresh checkout with `npx skills experimental_install`; update with `npx skills update`. Do not hand-edit skill folders — manage them through the `skills` CLI so the lockfile stays truthful.
- **MCP servers** are configured per project in [`opencode.json`](opencode.json) (`mcp` section), which is committed. Keep the set minimal; document why each server is needed in the pull request that adds it.
- Skills and third-party instructions run with full agent permissions — review their content before adding new ones. Prefer upstream repositories over archived mirrors when both exist.

## Development environment

The reproducible Docker-based development environment is defined by Stage 1 of the plan. Until it exists, do not rely on host-installed tooling for anything that CI must reproduce.
