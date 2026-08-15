# Repository Code Review Skill Design

Date: 2026-08-15
Status: Approved for implementation

## Goal

Add a project-local GitHub Copilot skill at
`.github/skills/code-review/SKILL.md` that produces high-confidence,
repository-aware code reviews for Psyche Build.

The skill must find actionable defects introduced by the reviewed change while
avoiding style commentary, speculative concerns, unrelated pre-existing
problems, and success claims unsupported by evidence.

## Scope

The skill reviews:

- working-tree and staged changes, including untracked files;
- commits and commit ranges;
- feature branches against an explicit or inferred base;
- pull-request diffs and regression-risk audits.

The skill is read-only. It reports findings but does not edit files, apply
patches, commit changes, or mutate GitHub state.

Explicit requests to find exploitable vulnerabilities remain owned by the
dedicated security-review workflow. Ordinary code reviews still inspect
security-sensitive behavior when it is part of the changed code.

## Structure

Use one repository-first `SKILL.md` rather than separate language references.
Keep the workflow coherent and self-contained while staying below the skill
system's preferred 500-line limit.

The file contains:

1. Trigger-focused YAML frontmatter.
2. A read-only operating contract.
3. Review target and comparison-base discovery.
4. Repository context and change-intent discovery.
5. End-to-end behavioral tracing.
6. Repository-specific risk lenses.
7. Targeted validation guidance.
8. False-positive and severity calibration.
9. A strict findings output format.

## Review Workflow

### 1. Establish the review target

Determine whether the user wants the working tree, staged changes, a commit,
a range, a branch, or a pull request reviewed. Resolve the comparison base
explicitly when possible and state uncertainty when it cannot be established.

Include untracked files for working-tree reviews. Do not silently review only
the latest commit when the user asked for current changes.

### 2. Inspect intent and surrounding contracts

Read the complete diff, then inspect only the surrounding files, callers,
tests, specifications, documentation, and recent history needed to understand
the changed behavior.

Use repository documentation and approved design specifications as evidence of
intent, but prefer executable behavior and current contracts when documents
are stale.

### 3. Classify touched surfaces

Map changed files to the relevant repository surfaces:

- TypeScript and Node.js CLI/runtime code;
- React, Vue, Ink, and browser-side TypeScript or JavaScript;
- Tauri Rust and platform-specific desktop behavior;
- Swift and iOS project/runtime code;
- protocol, fixture, generated, package, release, and documentation surfaces.

### 4. Trace behavior end to end

Follow changed values and authority across boundaries rather than reviewing
each file in isolation. Relevant boundaries include:

- UI to runtime or daemon;
- MCP/client to control server;
- authenticated identity to task scope;
- lease, approval, command, and canonical receipt;
- project root to worktree and filesystem path;
- parent process to child process and shutdown/recovery;
- TypeScript/web bundle to Tauri command;
- shared core behavior to macOS, Windows, Linux, or iOS implementations;
- source definitions to generated or packaged artifacts.

### 5. Apply repository-specific risk lenses

Prioritize defects involving:

- canonical project and worktree isolation;
- symlink, hardlink, path traversal, and filesystem race defenses;
- shell argument handling, quoting, process identity, and cleanup;
- task-bound authentication and caller-supplied identity fields;
- capability lease, approval, receipt, and ownership checks;
- stale generations, replaced resources, ambiguous effects, and quarantine;
- persistence, recovery, restart, and backward-compatibility behavior;
- platform conditionals and desktop/iOS parity;
- bounded inputs, outputs, queues, snapshots, and retained state;
- generated files, workspace packages, release metadata, and packaged content;
- tests that assert a proxy while missing the actual changed contract.

### 6. Validate selectively

Run only the smallest read-only check that can confirm or reject a suspected
finding. Never modify files merely to complete a review.

Candidate checks include:

- focused Vitest files or selectors;
- `pnpm run typecheck:tests` for test-only TypeScript changes;
- `pnpm run typecheck` for broader TypeScript changes;
- targeted desktop web bundle builds;
- Rust formatting, focused tests, and `cargo check`;
- iOS project generation checks or focused Xcode tests when available;
- `pnpm smoke` for startup, onboarding, or tmux lifecycle changes;
- `npm pack --dry-run` or `pnpm smoke:pack` for package-surface changes.

The review must distinguish checks that were run from checks that are merely
recommended or unavailable.

### 7. Calibrate findings

Report a finding only when all of these are true:

- the reviewed change introduces or exposes the problem;
- a concrete input, state, platform, or sequence triggers it;
- the impact is meaningful for correctness, security, reliability, data
  integrity, compatibility, or maintainability of an enforced contract;
- the location can be cited precisely;
- the claim is supported by repository evidence rather than preference.

Before reporting, actively look for guards, caller guarantees, platform
constraints, recovery paths, tests, or documentation that invalidate the
concern.

## Severity Model

- `P0`: immediate catastrophic impact, such as broad data loss or critical
  authority compromise, with a credible trigger.
- `P1`: high-impact defect likely to affect core workflows, security
  boundaries, releases, or multiple users/platforms.
- `P2`: concrete functional or reliability defect with a narrower trigger or
  workaround.
- `P3`: real low-impact defect worth fixing, not a style preference or
  optional hardening suggestion.

When severity is uncertain, choose the lower priority or omit the finding.

## Output Contract

Order findings by priority and then by file location.

Each finding uses:

```text
[P1] Imperative, specific title
path/to/file.ts:123-131

Describe the concrete triggering scenario, the resulting behavior or impact,
and why the changed code causes it. Keep fix direction brief and do not include
a patch.
```

Keep cited ranges as narrow as possible. A finding must stand alone without
requiring the reader to reconstruct the entire review.

If no issue meets the reporting bar, return:

```text
No findings.
```

The response may add a concise residual-risk note only for a material area that
could not be inspected or validated. It must not turn missing validation into
a speculative defect.

## Non-goals

- Editing or fixing reviewed code.
- Generic style, naming, formatting, or documentation polish.
- Demanding tests for every change without identifying a missed behavior.
- Repeating lint, compiler, or test output without explaining a code defect.
- Exhaustive security auditing outside the changed behavior.
- Reviewing unrelated dirty-worktree changes unless they affect the target.
- Producing a summary that obscures or dilutes actionable findings.

## Acceptance Criteria

- The skill is installed at `.github/skills/code-review/SKILL.md`.
- Its frontmatter clearly triggers on repository code-review tasks.
- It is explicitly read-only.
- It covers all major languages and runtime surfaces in this repository.
- It encodes the repository's highest-risk isolation, authority, lifecycle,
  platform, persistence, and packaging invariants.
- It includes targeted validation commands consistent with the repository's
  contribution and CI workflows.
- It requires precise, severity-ranked, high-confidence findings.
- It emits `No findings.` when no actionable defect is supported.
- The completed skill passes the skill creator's structural validator.
