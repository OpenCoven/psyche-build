# Repository Code Review Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, repository-aware GitHub Copilot code-review skill that reports only high-confidence defects introduced by the reviewed change.

**Architecture:** Create one project-local `.github/skills/code-review/SKILL.md` with trigger-focused frontmatter, a deterministic review workflow, Psyche Build-specific risk lenses, targeted validation guidance, and a strict severity-ranked findings contract. Validate the skill structure with the skill creator's existing `quick_validate.py`; do not add a repository eval harness.

**Tech Stack:** Markdown skill instructions, YAML frontmatter, Git, GitHub CLI, pnpm/Vitest/TypeScript, Rust/Cargo, Tauri, Swift/Xcode.

---

## File structure

- Create: `.github/skills/code-review/SKILL.md` — repository-specific review workflow and output contract.
- Reference: `docs/superpowers/specs/2026-08-15-code-review-skill-design.md` — approved behavior and acceptance criteria.
- Do not modify: application source, tests, workflows, package manifests, generated bundles, or unrelated dirty-worktree files.

### Task 1: Add the repository code-review skill

**Files:**
- Create: `.github/skills/code-review/SKILL.md`

- [ ] **Step 1: Create the complete skill**

Create `.github/skills/code-review/SKILL.md` with exactly this content:

````markdown
---
name: code-review
description: Review code changes in the Psyche Build repository for high-confidence, actionable defects. Use this skill whenever the user asks to review a working tree, staged changes, a commit, branch, pull request, patch, regression, or implementation for correctness and risk—even if they do not explicitly say "code review." It is read-only and repository-specific across TypeScript/Node, React/Vue/Ink, Tauri Rust and web bundles, Swift/iOS, protocols, generated files, packaging, CI, and release surfaces. Do not use it for an explicit vulnerability or exploit hunt; use the dedicated security-review workflow for that request.
compatibility: Requires repository read access and Git. GitHub PR reviews may use gh. Optional validation uses pnpm, Cargo, Xcode, tmux, and platform toolchains already documented by the repository.
---

# Psyche Build code review

## Operating contract

Review the requested change without editing files, applying patches, committing,
pushing, merging, or mutating GitHub state.

Find defects introduced or exposed by the reviewed change. Do not report style
preferences, optional refactors, speculative hardening, unrelated pre-existing
problems, or missing tests unless a concrete behavior is unprotected and can
fail.

Treat explicit requests to find exploitable vulnerabilities as security-review
tasks instead. During an ordinary code review, still inspect authentication,
authorization, filesystem, process, browser, and secret-handling boundaries
when the changed behavior crosses them.

## 1. Establish the exact review target

Identify what the user asked to review before reading implementation details:

- **Working tree:** inspect `git status --short`, unstaged changes, staged
  changes, and every relevant untracked file.
- **Staged changes:** use the index as the target; do not mix in unstaged work.
- **Commit:** inspect that commit and its parent relationship. Do not assume
  `HEAD^` is the intended target when a commit hash was supplied.
- **Range:** preserve the user's endpoints and whether the range is two-dot or
  three-dot.
- **Branch:** resolve the intended base, compute the merge base, and review the
  branch delta rather than unrelated local dirt.
- **Pull request:** inspect PR metadata, base/head refs, changed files, and the
  actual diff. Prefer `gh` when remote context is required.

State a material base ambiguity rather than silently choosing a comparison
that could change the result. Never omit untracked files from a working-tree
review.

Start with a change inventory:

```bash
git status --short
git diff --stat
git diff --name-status
git diff --cached --stat
git diff --cached --name-status
```

Adapt these commands to the target. Disable pagers for Git and GitHub commands.
Do not run destructive or mutating commands.

## 2. Recover intent before judging behavior

Read the complete relevant diff, then inspect the smallest surrounding context
needed to understand it:

1. changed functions, types, schemas, and configuration;
2. direct callers and consumers;
3. tests covering the changed contract;
4. approved design documents and operational documentation;
5. recent commits when they clarify an invariant or compatibility decision;
6. generated, packaged, or platform copies derived from the changed source.

Use specifications as evidence of intended behavior, but prefer current
executable contracts when documentation is stale. Do not mistake a source-text
test or documentation assertion for proof that runtime behavior works.

Follow one continuous behavioral trace across files. Review related callers,
callees, and tests together rather than splitting the review into isolated
language or directory checklists.

## 3. Classify the touched repository surfaces

Use the changed paths to select relevant context and validation:

| Surface | Common paths | Primary concerns |
|---|---|---|
| Node CLI and runtime | `src/`, `psyche`, `scripts/` | tmux, Git/worktrees, process lifecycle, config, recovery, IPC |
| Tests | `__tests__/` | contract coverage, mocks, platform assumptions, proxy assertions |
| Shared frontend | `frontend/`, `packages/vim-core/` | state, focus, input, rendering, workspace package boundaries |
| Desktop web runtime | `native/desktop/psyche-build-tauri/web/` | source/bundle parity, browser lifecycle, Tauri command contracts |
| Desktop Rust | `native/desktop/psyche-build-tauri/src-tauri/` | platform cfg, filesystem/process authority, async state, Tauri IPC |
| iOS and Swift | `native/ios/` | generated project parity, actor/state lifecycle, platform capability boundaries |
| Protocol and fixtures | protocol types, fixtures, control/MCP code | compatibility, exact ownership, serialization, bounds |
| Distribution | `package.json`, workspace config, `.github/workflows/`, release docs | generated artifacts, package contents, pinned tools, release gates |

Do not assume a change is local because only one file was edited. Check the
runtime, generated, platform, test, and package surfaces that consume it.

## 4. Trace changed behavior end to end

For each material change, identify:

- the initiating input, event, request, or persisted state;
- normalization and validation steps;
- authority or ownership decisions;
- state transitions and side effects;
- asynchronous or process boundaries;
- persistence and recovery behavior;
- the observable result and error contract;
- tests that exercise the same path rather than a proxy.

Pay special attention when the trace crosses:

- UI to runtime, daemon, or Tauri command;
- MCP/client to control server;
- authenticated identity to task or project scope;
- lease to approval to command to canonical receipt;
- project root to worktree or filesystem path;
- parent to child process, watcher, tmux pane, or shutdown path;
- source module to checked-in browser bundle;
- shared behavior to macOS, Windows, Linux, or iOS implementations;
- source definitions to generated docs, fixtures, package files, or releases.

## 5. Apply Psyche Build's high-risk invariants

### Project, worktree, and path isolation

Verify that project identity comes from a canonical trusted root and remains
consistent across worktrees, aliases, sockets, credentials, panes, and
persistence. Look for:

- prefix checks that confuse sibling paths;
- lexical normalization used where canonicalization is required;
- symlink or hardlink traversal into protected state;
- path validation followed by a race-prone reopen;
- workspace globs that accidentally include `.worktrees/` or
  `.psyche/worktrees/`;
- cleanup that targets a path before ownership is proved.

### Authentication and task scope

Authenticated identity must be authoritative. Caller-supplied `task_id`,
project paths, actor IDs, subject IDs, or resource IDs may be equality checks
or lookup inputs, never proof of authority.

Check that:

- unbound or legacy identities fail closed for task-sensitive operations;
- task, actor, subject, principal, and project ownership are checked at every
  relevant read and mutation;
- subject rotation or revocation invalidates already-open connections and
  stale capabilities;
- missing and cross-task records remain indistinguishable where required;
- operator-only snapshots, events, or secrets cannot leak through broad
  object spreads, fallback APIs, logs, or error details.

### Leases, approvals, generations, and receipts

Trace exact resource generation, lease ID/revision, action ID, task ownership,
actor/subject ownership, and approval ownership through the full command
lifecycle.

Look for:

- time-of-check/time-of-use gaps after lease expiry, prune, rotation, or target
  replacement;
- approval resolution that no longer proves the original action context;
- stale resource generations accepted after rebinding or restore;
- receipts reconstructed from bounded or redacted history instead of canonical
  retained state;
- retries that duplicate an effect;
- ambiguous completion reported as success or ordinary failure instead of
  `effect_unknown` and quarantine where required;
- cleanup that erases evidence before authoritative completion is known.

### Processes, tmux, Git, and shutdown

Prefer structured argument arrays and existing command helpers over shell
strings. Review quoting, environment inheritance, working directory, signals,
exit status, cancellation, and process identity.

Check behavior under:

- spaces, Unicode, leading dashes, and shell metacharacters in paths or names;
- child startup failure and partial initialization;
- PID reuse or stale stored identities;
- concurrent close, merge, watcher, and shutdown operations;
- tmux or config unavailability;
- unverified pane closure and recovery-marker creation;
- Git conflicts, detached heads, dirty worktrees, and renamed branches;
- interrupted cleanup and restart recovery.

Do not accept a success-shaped fallback when the system cannot prove the
effect.

### Persistence, concurrency, and bounded state

Inspect atomic publication, file and directory permissions, lock ownership,
compare-and-swap revisions, rename behavior, crash consistency, and restart
reconstruction.

Check that inputs, outputs, queues, journals, snapshots, receipts, retained
state, and UI lists remain bounded before expensive allocation or serialization.
Look for races hidden by single-threaded tests, especially read-check-write
sequences across async boundaries.

### Desktop, browser, and iOS boundaries

Verify `cfg` and availability conditions on every supported platform. A macOS
fix must not break Windows or Linux compilation; shared desktop behavior must
not assume APIs available only on one target.

For browser or webview behavior, inspect document/tab generation, navigation,
callback lifetime, event listener cleanup, provider loss, stale snapshots, and
source-to-bundle parity.

For Swift/iOS behavior, inspect actor isolation, main-thread UI updates,
restoration, session identity, generated Xcode project consistency, simulator
assumptions, and unavailable desktop capabilities.

### UI and state transitions

Trace focus, selection, pane/thread identity, async callbacks, popup ownership,
restoration, optimistic state, and stale response handling. Check empty,
loading, error, replacement, and rapid-interaction sequences.

Treat snapshot or source-string tests as regression guards only. Confirm that
they assert the actual state transition or runtime contract when that matters.

### Generated, package, CI, and release surfaces

When a source definition has a checked-in derivative, verify both are updated
or deliberately generated during build. Common examples include desktop web
bundles, hook documentation, protocol fixtures, Xcode projects, and release
metadata.

Check:

- explicit workspace package paths remain isolated from worktree copies;
- package exports and `files` include every required runtime artifact;
- lockfiles and pinned tool versions match the intended workflow;
- CI covers the platform or package surface affected by the change;
- release commands preserve approval gates and do not publish, tag, merge, or
  replace stable applications implicitly.

## 6. Validate suspected findings selectively

Run a check only when it can confirm or reject a concrete concern. Start with
the smallest relevant command and expand only when the result requires it.
Review commands must be read-only with respect to source files; beware commands
that regenerate checked-in artifacts.

### TypeScript and Vitest

```bash
pnpm vitest --run path/to/relevant.test.ts
pnpm run typecheck:tests
pnpm run typecheck
```

Use the focused test first. `pnpm run typecheck:tests` is sufficient for
test-only TypeScript changes; broader source or contract changes generally
need `pnpm run typecheck`.

### Desktop web bundles

```bash
pnpm --dir native/desktop/psyche-build-tauri build:web
```

This regenerates checked-in bundles, so do not run it in a read-only review
unless the worktree is clean for those files and regeneration is necessary to
verify source/bundle parity. Prefer inspecting the build script and existing
diff first.

### Desktop Rust

```bash
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
```

Use a focused Cargo test filter when one covers the suspected path.

### iOS

```bash
pnpm ios:project:check
```

This command regenerates the Xcode project before diffing it. Do not run it
when that would alter unrelated dirty files. Run focused `xcodebuild test` only
when the required pinned Xcode and simulator are available.

### Startup, packaging, and release

```bash
pnpm smoke
npm pack --dry-run
pnpm smoke:pack
pnpm release:check
```

Use `pnpm smoke` for startup, onboarding, or tmux session lifecycle changes.
Use package checks for exports, included files, generated docs, or install
behavior. Do not perform publication, tagging, protected-branch pushes, or
stable application replacement.

Record which checks actually ran and their result. Never imply that an
unavailable, skipped, or merely suggested check passed.

## 7. Prove each finding and remove false positives

Report a finding only when all are true:

1. The reviewed change introduces or exposes the problem.
2. A concrete input, state, platform, race, or operation sequence triggers it.
3. The impact affects correctness, security, reliability, data integrity,
   compatibility, or an enforced operational contract.
4. The cited lines are the smallest useful location for the cause.
5. Repository code, tests, documentation, or a targeted check supports the
   claim.

Before keeping a finding, actively search for:

- an earlier guard or normalization step;
- a caller guarantee enforced by types or runtime checks;
- a later validation, rollback, quarantine, or recovery path;
- platform constraints that make the scenario impossible;
- an existing test that exercises the exact path;
- intentional behavior documented in an approved design or compatibility
  contract.

If any of these invalidates the trigger or impact, remove the finding.

Do not report:

- naming, formatting, comment, or stylistic preferences;
- optional refactors or generalized "could be cleaner" advice;
- hypothetical vulnerabilities without a reachable changed path;
- absent tests without a concrete missed failure;
- compiler, lint, or test output without the underlying code defect;
- API behavior unsupported by this repository's documented compatibility;
- an environment/tooling failure as though it were a product bug;
- unrelated dirty-worktree or pre-existing defects.

## 8. Assign conservative severity

- **P0:** credible immediate catastrophic impact, such as broad data loss or
  critical authority compromise.
- **P1:** high-impact defect affecting core workflows, security boundaries,
  releases, or multiple users/platforms.
- **P2:** concrete functional or reliability defect with a narrower trigger or
  viable workaround.
- **P3:** real low-impact defect worth fixing; never use P3 for style or
  optional hardening.

When uncertain between priorities, choose the lower severity. When uncertain
whether the issue is real, omit it.

## 9. Produce findings-first output

Order findings by priority, then by file path and line.

Use this exact shape for every finding:

```text
[P1] Use a specific imperative title
path/to/file.ts:123-131

Explain the concrete trigger, resulting behavior or impact, and why the changed
code causes it. Keep fix direction brief; do not provide a patch.
```

Keep the cited line range narrow and overlap the changed lines whenever they
contain the cause. One finding should describe one defect. Combine locations
only when they are inseparable parts of the same failure.

After findings, include a short validation line only if useful:

```text
Validation: `pnpm vitest --run __tests__/example.test.ts` passed.
```

If no issue meets the reporting bar, return:

```text
No findings.
```

You may then add one concise `Residual risk:` sentence only when a material
surface could not be inspected or validated. Missing validation alone is not a
finding.
````

- [ ] **Step 2: Check the file for accidental placeholders and size**

Run:

```bash
rg -n 'TBD|TODO|PLACEHOLDER|XXX|\?\?\?' .github/skills/code-review/SKILL.md
wc -l .github/skills/code-review/SKILL.md
```

Expected: `rg` returns no matches. The file remains below 500 lines.

- [ ] **Step 3: Validate the skill structure**

Run:

```bash
python /Users/buns/.agents/skills/skill-creator/scripts/quick_validate.py .github/skills/code-review
```

Expected:

```text
Skill is valid!
```

- [ ] **Step 4: Verify the repository diff is scoped**

Run:

```bash
git diff --check -- .github/skills/code-review/SKILL.md
git status --short
git diff -- .github/skills/code-review/SKILL.md
```

Expected: no whitespace errors; the only implementation file added by this
plan is `.github/skills/code-review/SKILL.md`. Preserve and do not stage
unrelated changes such as `.github/FUNDING.yml` or other contributors' plan
files.

- [ ] **Step 5: Commit the skill**

Run:

```bash
git add -- .github/skills/code-review/SKILL.md
git commit -m "feat: add repository code review skill" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: one commit containing only `.github/skills/code-review/SKILL.md`.
