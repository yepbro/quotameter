# Git protocol, CI structure, Dependabot, releases

## Commits and tasks

- Conventional Commits, English, one logical change per commit.
- One plan task = one commit: implementation files + the `[x]` / `Status: [done]` flip in `plan/tasks.md` together. Missed a file before pushing? Amend. After pushing: a follow-up commit — **force-push to `master` is blocked** by branch protection.
- Missing a file in `AGENTS.md`-referenced docs after a change is a bug: docs follow code in the same commit.

## Branch protection and CI

- `master` is protected: pull requests + the required status check named exactly **`CI`** are enforced; force-pushes and branch deletion are disabled.
- The required check is a **gate job** named `CI` in `.github/workflows/ci.yml` that fails when any job behind it fails (static, test matrix, install containers, package, unsupported-node, mutation). Never rename it; add new jobs to its `needs`.
- Admin (`yepbro`) may push directly — used during bootstrap; regular work lands via squash-merged PRs.
- Node matrix: `22.13.0` (declared minimum), `22`, `24`. Add the next LTS to the matrix when it ships.
- Diagnosing a red run: `gh api "repos/yepbro/quotameter/actions/runs?head_sha=<full-sha>"` → job ids → `gh run view --job <id> --log`.

## Actions pinning

Pin third-party actions to full commit SHAs with the version in a comment. **Verify SHAs via `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`** — never write them from memory; a made-up SHA silently breaks the workflow.

## Dependabot

Weekly updates (npm + github-actions, `chore(deps)` / `chore(ci)` prefixes). Merging its PRs:

1. All must be `CLEAN` (branch protection requires an up-to-date branch), so merge **one at a time**.
2. After each merge the rest become `BEHIND` — comment `@dependabot rebase` on each and wait for its CI to pass.

## Releases

- npm publishing happens **only from CI** on a pushed `vX.Y.Z` tag (`.github/workflows/release.yml`, OIDC trusted publishing, provenance; no tokens in the repo). `private: true` stays in `package.json`; the release workflow removes it.
- Semver + `CHANGELOG.md` (Keep a Changelog): fold **Unreleased** into the version at release time. Checklist: `docs/release.md`.
