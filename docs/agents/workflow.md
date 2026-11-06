# Git protocol, CI structure, Dependabot, releases

## Commits and tasks

- Conventional Commits, English, one logical change per commit.
- One plan task = one commit: implementation files + the `[x]` / `Status: [done]` flip in `plan/tasks.md` together. Missed a file before pushing? Amend. After pushing: a follow-up commit — **force-push to `master` is blocked** by branch protection.
- Missing a file in `AGENTS.md`-referenced docs after a change is a bug: docs follow code in the same commit.

## Branch protection and CI

- `master` is protected: pull requests + the required status check named exactly **`CI`** are enforced; force-pushes and branch deletion are disabled.
- The required check is a **gate job** named `CI` in `.github/workflows/ci.yml` that fails when any job behind it fails (static, test matrix, timezone matrix, install containers, package, unsupported-node). Never rename it; add new jobs to its `needs`. Mutation testing lives in the separate daily `.github/workflows/mutation.yml` (D-045) and does not gate pushes.
- Admin (`yepbro`) may push directly — used during bootstrap; regular work lands via squash-merged PRs.
- Node matrix: `22.13.0` (declared minimum), `22`, `24`. Add the next LTS to the matrix when it ships.
- Diagnosing a red run: `gh api "repos/yepbro/quotameter/actions/runs?head_sha=<full-sha>"` → job ids → `gh run view --job <id> --log`.

## Actions pinning

Pin third-party actions to full commit SHAs with the version in a comment. **Verify SHAs via `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`** — never write them from memory; a made-up SHA silently breaks the workflow.

The same root-of-trust rule covers the Node runtime archive the `install` job downloads: it is verified against SHA-256 digests **pinned in the workflow, in repository history** (the one domain a compromised nodejs.org mirror/CDN cannot rewrite — a run-time `SHASUMS256.txt` fetch from the same CDN would verify the mirror against itself; decision D-157). Bumping the pinned Node version is a documented all-sites procedure in the workflow's comment (`version=` + step name + both digests, the `node -v` expectation, the unsupported-node grep, `package.json` `engines.node`, and the guard's `PINNED_VERSION`/`PINNED_DIGESTS`), enforced by `test/unit/ci-workflow.spec.ts` — a bump that skips a site fails `make check`, not CI.

## Dependabot

Weekly updates (npm + github-actions, `chore(deps)` / `chore(ci)` prefixes). Merging its PRs:

1. All must be `CLEAN` (branch protection requires an up-to-date branch), so merge **one at a time**.
2. After each merge the rest become `BEHIND` — comment `@dependabot rebase` on each and wait for its CI to pass.

The `dependencies` label both update blocks assign is **repository metadata, not repository content**: a label listed under `labels:` that does not exist in the repository is **silently ignored** by Dependabot (documented behavior), so the assignment depends on the label existing. It exists on `yepbro/quotameter` (created per D-157); if it ever goes missing (fresh fork, deletion), update PRs silently lose it — restore it with:

```sh
gh label create dependencies --repo yepbro/quotameter --description "Dependency updates (Dependabot)" --color 0366d6
```

An in-workflow bootstrap cannot cover it (no workflow of ours runs before Dependabot opens its PRs). Note the deliberate choice in the other direction too: removing `labels:` would NOT keep an implicit missing-label failure (D-157's original, incorrect argument — corrected by D-168) — Dependabot's default labels, including `dependencies`, are auto-created. The declaration stays because it pins the exact label set (one shared `dependencies`, not the defaults' `dependencies` + per-ecosystem labels) and keeps it repository-governed.

Held updates: `typescript` major bumps are ignored in `dependabot.yml` (since 2026-11-05) — TypeScript 7.0 has no programmatic API, so `typescript-eslint` (peer `<6.1.0`) and `vue-tsc`/Volar cannot run on it; see the rule comment there. Revisit when TypeScript 7.1 ships a stable API and typescript-eslint supports it (typescript-eslint#10940).

## Releases

- npm publishing happens **only from CI** on a pushed `vX.Y.Z` tag (`.github/workflows/release.yml`, OIDC trusted publishing, provenance; no tokens in the repo). `private: true` stays in `package.json`; the release workflow removes it.
- Semver + `CHANGELOG.md` (Keep a Changelog): fold **Unreleased** into the version at release time. Checklist: `docs/release.md`.
