# Aardvark PR Resolution Design

## Goal

Resolve every open pull request labeled `aardvark` against the latest `main`, preserve every distinct security fix, close only fixes proven redundant, and leave no open `aardvark` pull request.

## Scope

The initial train contains PRs #130, #132, #133, #134, #136, #137, #138, and #139.

## Resolution Strategy

Use a sequential, risk-ordered merge train. Each retained PR is updated against the `main` produced by the preceding merge, reviewed as a complete resulting diff, remediated on its own branch, validated, and squash-merged before the next PR proceeds.

The initial order is:

1. Verify whether #133 is fully superseded by merged PR #128. Close #133 with a precise explanation if its intended protection and tests are already present; otherwise retain its missing behavior.
2. Resolve #130, the control snapshot confidentiality fix.
3. Resolve #132, the desktop Git helper execution hardening.
4. Rebase and resolve #134, preserving its operator-facing authority disclosure over the lease credential changes from merged PR #135.
5. Resolve #137, the persisted pane ID validation and shell-free `select-layout` invocation.
6. Resolve #138, the mobile bridge restriction to managed tmux-backed panes.
7. Resolve #136, the tmux server-generation validation and identity-aware close path.
8. Resolve #139 after #136 so project-registry authorization composes with the strengthened daemon pane lifecycle.

The order may change when a complete diff demonstrates a direct dependency, but overlapping PRs must remain sequential and every later PR must be validated against the latest `main`.

## Per-PR Workflow

For each retained PR:

1. Fetch the current head and update it from the latest `main`.
2. Resolve conflicts without discarding either the PR's distinct security intent or protections already on `main`.
3. Review the complete post-resolution diff for authorization gaps, unsafe fallbacks, incomplete call-site coverage, stale generated artifacts, and insufficient regression coverage.
4. Fix identified defects directly on the PR branch and push the branch.
5. Run the narrowest tests that cover the changed behavior, along with applicable type, format, build, or bundle checks.
6. Wait for required GitHub checks to complete successfully.
7. Squash-merge to `main`. Maintainer/admin authority may bypass missing human approval after comprehensive validation, but must not bypass failing required checks.
8. Refresh local and remote `main` before proceeding.

## Superseded PR Policy

A PR may be closed rather than merged only when the latest `main` or another resolved PR already contains its complete intended behavior and equivalent regression coverage. The closing comment must identify the superseding PR or commit and explain why no unique code remains.

Partially overlapping PRs must be rewritten to retain their unique value and then merged. No-op changes must not be manufactured merely to produce a merge event.

## Validation

Targeted validation must exercise the measurable security boundary changed by each PR, including negative tests for unauthorized, unregistered, stale, malformed, or untrusted inputs as applicable.

After the last merge:

1. Update local `main` from `origin/main`.
2. Run the repository's integrated typecheck and relevant test suites, escalating to the full available suite when practical.
3. Confirm every retained PR is merged, every redundant PR is closed with evidence, and no open PR labeled `aardvark` remains.
4. Confirm the worktree is clean and `main` matches `origin/main`.

## Failure Handling

Conflicts, test failures, or review findings are fixed on the affected PR branch before merge. Pre-existing or environment-specific failures must be distinguished with reproducible evidence; they are not silently ignored. If a required check fails for the PR's code, the PR remains unmerged until corrected.
