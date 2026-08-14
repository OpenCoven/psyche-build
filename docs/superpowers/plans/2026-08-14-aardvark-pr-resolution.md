# Aardvark PR Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every open `aardvark` pull request against the latest `main`, merge every distinct validated fix, close only proven superseded work, and leave no open `aardvark` PR.

**Architecture:** Run a sequential merge train from a clean worktree based on `origin/main`. Each PR is updated after the preceding merge, reviewed as a complete diff, validated with its focused security regression suite and applicable build checks, pushed to its existing head branch, and squash-merged before the train advances.

**Tech Stack:** Git, GitHub CLI, pnpm, Vitest, TypeScript, Rust/Cargo, Tauri, tmux.

---

## File Map

- `src/control/server.ts`: principal-aware control snapshot redaction for #130.
- `__tests__/controlCredentials.test.ts`: operator/non-operator snapshot confidentiality coverage for #130.
- `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`: Git helper hardening for #132 and trusted-webview PTY protection used to assess #133.
- `__tests__/tauriDesktopPlatform.test.ts`: trusted-webview regression coverage used to assess #133.
- `native/desktop/psyche-build-tauri/web/control/agent-control-drawer.mjs`: requested-authority disclosure for #134.
- `native/desktop/psyche-build-tauri/web/control.bundle.js`: generated desktop control bundle for #134.
- `__tests__/tauriAgentControlUi.test.ts`: authority disclosure coverage for #134.
- `src/layout/PaneLayoutCompiler.ts`: persisted tmux pane ID validation for #137.
- `src/services/TmuxService.ts`: safe tmux resize and shell-free layout selection for #137.
- `__tests__/paneLayoutCompiler.test.ts`: malformed persisted pane ID coverage for #137.
- `src/services/bridge/BridgeDaemon.ts`: attach authorization for managed terminal panes in #138.
- `src/services/bridge/MobileControlGateway.ts`: mobile mutation authorization for managed terminal panes in #138.
- `__tests__/bridge/bridgeTerminalStreams.test.ts`: attach rejection coverage for #138.
- `__tests__/bridge/mobileControlGateway.test.ts`: kill/meta rejection coverage for #138.
- `src/daemon/panes.ts`: tmux server-generation validation for #136.
- `src/daemon/index.ts`: identity-aware pane surface refresh wiring for #136.
- `src/daemon/controlHandlers.ts`: identity-aware close behavior in #136 and project-scoped mutation resolution in #139.
- `__tests__/daemon/panes.test.ts`: stale/reused pane binding coverage for #136.
- `__tests__/daemon/controlHandlers.test.ts`: daemon pane effect coverage for #136 and #139.
- `__tests__/daemon/controlSocketMount.test.ts`: unregistered canonical-control pane rejection for #139.

### Task 1: Create the Clean Merge-Train Worktree

**Files:**
- Preserve: `docs/superpowers/specs/2026-08-14-aardvark-pr-resolution-design.md`
- Preserve: `docs/superpowers/plans/2026-08-14-aardvark-pr-resolution.md`

- [ ] **Step 1: Preserve planning commits on a dedicated branch**

```bash
git branch aardvark-resolution-docs HEAD
```

Expected: branch `aardvark-resolution-docs` points to the committed design and plan.

- [ ] **Step 2: Fetch current repository and PR state**

```bash
git fetch origin --prune
gh pr list --state open --label aardvark --limit 100 \
  --json number,title,headRefName,baseRefName,mergeable,mergeStateStatus,url
```

Expected: the remaining train is enumerated and every base branch is `main`.

- [ ] **Step 3: Create an isolated worktree from remote main**

```bash
git worktree add .worktrees/aardvark-train -b aardvark-train origin/main
cd .worktrees/aardvark-train
git status --short --branch
```

Expected: clean branch `aardvark-train` based exactly on `origin/main`.

### Task 2: Prove and Resolve PR #133 Supersession

**Files:**
- Compare: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`
- Compare: `__tests__/tauriDesktopPlatform.test.ts`

- [ ] **Step 1: Fetch PR #133 and inspect its complete delta**

```bash
git fetch origin pull/133/head:pr-133
git diff --stat origin/main...pr-133
git diff origin/main...pr-133 -- \
  native/desktop/psyche-build-tauri/src-tauri/src/lib.rs \
  __tests__/tauriDesktopPlatform.test.ts
```

Expected: the diff is limited to trusted-webview checks for `pty_start` and `pty_write` plus regression assertions.

- [ ] **Step 2: Verify merged PR #128 contains equivalent protection**

```bash
git show --stat --oneline 4611d56a
git grep -n "require_trusted_app_webview\\|TRUSTED_APP_WEBVIEW_LABEL" origin/main -- \
  native/desktop/psyche-build-tauri/src-tauri/src/lib.rs \
  __tests__/tauriDesktopPlatform.test.ts
pnpm exec vitest --run __tests__/tauriDesktopPlatform.test.ts
```

Expected: `origin/main` checks the trusted webview before PTY commands and the focused test file passes.

- [ ] **Step 3: Close only if no unique behavior remains**

```bash
gh pr close 133 --comment \
  "Closing as superseded by #128 (commit 4611d56a). The trusted-app-webview guard for PTY entry points and its regression coverage are already present on main, so this branch has no distinct protection left to merge."
```

Expected: PR #133 is closed. If Step 2 disproves equivalence, do not close it; update its branch with the per-PR workflow from Task 3 and retain the missing behavior.

### Task 3: Resolve and Merge PR #130

**Files:**
- Modify: `src/control/server.ts`
- Test: `__tests__/controlCredentials.test.ts`

- [ ] **Step 1: Check out and update the PR branch**

```bash
git fetch origin codex/fix-control-snapshots-to-prevent-lease-leaks
git switch -C pr-130 origin/codex/fix-control-snapshots-to-prevent-lease-leaks
git rebase origin/main
```

Expected: the branch is based on current `origin/main`; conflicts are resolved by preserving operator visibility and redacting sensitive snapshot fields for all non-operators.

- [ ] **Step 2: Review the complete post-rebase diff**

```bash
git diff --check
git diff origin/main...HEAD -- src/control/server.ts __tests__/controlCredentials.test.ts
```

Expected: `state.get` passes the authenticated principal into snapshot generation, operators retain full state, and `agent`/`compatibility` principals receive no resources, leases, requests, approvals, or receipts.

- [ ] **Step 3: Validate the security boundary**

```bash
pnpm exec vitest --run __tests__/controlCredentials.test.ts
pnpm run typecheck
```

Expected: both commands exit successfully.

- [ ] **Step 4: Push and merge**

```bash
git push --force-with-lease origin HEAD:codex/fix-control-snapshots-to-prevent-lease-leaks
gh pr checks 130 --watch
gh pr merge 130 --squash --admin --delete-branch
git fetch origin main
```

Expected: required checks pass and PR #130 is merged.

### Task 4: Resolve and Merge PR #132

**Files:**
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`

- [ ] **Step 1: Check out and update the PR branch**

```bash
git fetch origin codex/fix-security-vulnerability-in-git-commands
git switch -C pr-132 origin/codex/fix-security-vulnerability-in-git-commands
git rebase origin/main
```

Expected: the branch rebases cleanly or conflicts are resolved without weakening existing Tauri command restrictions.

- [ ] **Step 2: Inspect the hardening and tests**

```bash
git diff --check
git diff origin/main...HEAD -- native/desktop/psyche-build-tauri/src-tauri/src/lib.rs
```

Expected: every inspected Git command disables repository `core.fsmonitor`; diff operations include `--no-ext-diff` and `--no-textconv`; Unix tests prove configured helpers are not executed.

- [ ] **Step 3: Validate Rust and frontend coverage**

```bash
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml -- --check
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml workspace_panel_tests --locked
pnpm exec vitest --run __tests__/tauriWorkspacePanels.test.ts
```

Expected: formatting, Rust workspace-panel tests, and frontend contract tests pass.

- [ ] **Step 4: Push and merge**

```bash
git push --force-with-lease origin HEAD:codex/fix-security-vulnerability-in-git-commands
gh pr checks 132 --watch
gh pr merge 132 --squash --admin --delete-branch
git fetch origin main
```

Expected: PR #132 is merged.

### Task 5: Resolve and Merge PR #134

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/control/agent-control-drawer.mjs`
- Modify: `native/desktop/psyche-build-tauri/web/control.bundle.js`
- Test: `__tests__/tauriAgentControlUi.test.ts`
- Test: `__tests__/tauriWebBundles.test.ts`

- [ ] **Step 1: Check out and rebase over merged lease hardening**

```bash
git fetch origin codex/fix-agent-lease-drawer-security-flaw
git switch -C pr-134 origin/codex/fix-agent-lease-drawer-security-flaw
git rebase origin/main
```

Expected: conflicts with #135 are resolved by retaining #135's credential protections and #134's display of requested TTL, resource identity, generation, and capabilities before grant.

- [ ] **Step 2: Rebuild the generated bundle**

```bash
pnpm --filter psyche-build-tauri run build:web
git diff --check
git diff origin/main...HEAD -- \
  native/desktop/psyche-build-tauri/web/control/agent-control-drawer.mjs \
  native/desktop/psyche-build-tauri/web/control.bundle.js \
  __tests__/tauriAgentControlUi.test.ts
```

Expected: source and checked-in bundle agree and no unrelated generated changes appear.

- [ ] **Step 3: Validate disclosure and bundle integrity**

```bash
pnpm exec vitest --run \
  __tests__/tauriAgentControlUi.test.ts \
  __tests__/tauriWebBundles.test.ts
```

Expected: both test files pass.

- [ ] **Step 4: Push and merge**

```bash
git push --force-with-lease origin HEAD:codex/fix-agent-lease-drawer-security-flaw
gh pr checks 134 --watch
gh pr merge 134 --squash --admin --delete-branch
git fetch origin main
```

Expected: PR #134 is merged.

### Task 6: Resolve and Merge PR #137

**Files:**
- Modify: `src/layout/PaneLayoutCompiler.ts`
- Modify: `src/services/TmuxService.ts`
- Test: `__tests__/paneLayoutCompiler.test.ts`

- [ ] **Step 1: Check out and update the PR branch**

```bash
git fetch origin codex/fix-unvalidated-pane-ids-in-tmux-layout
git switch -C pr-137 origin/codex/fix-unvalidated-pane-ids-in-tmux-layout
git rebase origin/main
```

Expected: the branch is based on the latest merged fixes.

- [ ] **Step 2: Review validation and process invocation**

```bash
git diff --check
git diff origin/main...HEAD -- \
  src/layout/PaneLayoutCompiler.ts \
  src/services/TmuxService.ts \
  __tests__/paneLayoutCompiler.test.ts
```

Expected: content and control pane IDs must match `%<digits>`, resize targets are validated, and `select-layout` uses an argument vector rather than shell interpolation.

- [ ] **Step 3: Validate malformed-input rejection**

```bash
pnpm exec vitest --run \
  __tests__/paneLayoutCompiler.test.ts \
  __tests__/layoutManager.test.ts \
  __tests__/paneLayoutController.test.ts
pnpm run typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 4: Push and merge**

```bash
git push --force-with-lease origin HEAD:codex/fix-unvalidated-pane-ids-in-tmux-layout
gh pr checks 137 --watch
gh pr merge 137 --squash --admin --delete-branch
git fetch origin main
```

Expected: PR #137 is merged.

### Task 7: Resolve and Merge PR #138

**Files:**
- Modify: `src/services/bridge/BridgeDaemon.ts`
- Modify: `src/services/bridge/MobileControlGateway.ts`
- Test: `__tests__/bridge/bridgeTerminalStreams.test.ts`
- Test: `__tests__/bridge/mobileControlGateway.test.ts`

- [ ] **Step 1: Check out and update the PR branch**

```bash
git fetch origin codex/fix-mobile-tmux-authorization-flaw
git switch -C pr-138 origin/codex/fix-mobile-tmux-authorization-flaw
git rebase origin/main
```

Expected: the branch is based on the latest `main`.

- [ ] **Step 2: Review the pane-kind allowlist**

```bash
git diff --check
git diff origin/main...HEAD -- \
  src/services/bridge/BridgeDaemon.ts \
  src/services/bridge/MobileControlGateway.ts \
  __tests__/bridge/bridgeTerminalStreams.test.ts \
  __tests__/bridge/mobileControlGateway.test.ts
```

Expected: attach, kill, and metadata mutation authorize only `agent` and `terminal` panes; `coven-session` metadata cannot authorize arbitrary tmux IDs.

- [ ] **Step 3: Validate negative authorization cases**

```bash
pnpm exec vitest --run \
  __tests__/bridge/bridgeTerminalStreams.test.ts \
  __tests__/bridge/mobileControlGateway.test.ts
pnpm run typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 4: Push and merge**

```bash
git push --force-with-lease origin HEAD:codex/fix-mobile-tmux-authorization-flaw
gh pr checks 138 --watch
gh pr merge 138 --squash --admin --delete-branch
git fetch origin main
```

Expected: PR #138 is merged.

### Task 8: Resolve and Merge PR #136

**Files:**
- Modify: `src/daemon/panes.ts`
- Modify: `src/daemon/index.ts`
- Modify: `src/daemon/controlHandlers.ts`
- Test: `__tests__/daemon/panes.test.ts`
- Test: `__tests__/daemon/controlHandlers.test.ts`
- Test: `__tests__/daemon/killBridgePane.test.ts`

- [ ] **Step 1: Check out and update the PR branch**

```bash
git fetch origin codex/propose-fix-for-tmux-pane-id-vulnerability
git switch -C pr-136 origin/codex/propose-fix-for-tmux-pane-id-vulnerability
git rebase origin/main
```

Expected: conflicts preserve all prior authorization and validation fixes.

- [ ] **Step 2: Review identity validation and teardown**

```bash
git diff --check
git diff origin/main...HEAD -- \
  src/daemon/panes.ts \
  src/daemon/index.ts \
  src/daemon/controlHandlers.ts \
  __tests__/daemon/panes.test.ts \
  __tests__/daemon/controlHandlers.test.ts
```

Expected: published durable bindings require the current tmux server identity; pane effects refresh before resolution; close uses the locked identity-aware teardown path rather than raw `killPane`.

- [ ] **Step 3: Validate stale-generation and close behavior**

```bash
pnpm exec vitest --run \
  __tests__/daemon/panes.test.ts \
  __tests__/daemon/controlHandlers.test.ts \
  __tests__/daemon/killBridgePane.test.ts
pnpm run typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 4: Push and merge**

```bash
git push --force-with-lease origin HEAD:codex/propose-fix-for-tmux-pane-id-vulnerability
gh pr checks 136 --watch
gh pr merge 136 --squash --admin --delete-branch
git fetch origin main
```

Expected: PR #136 is merged.

### Task 9: Resolve and Merge PR #139

**Files:**
- Modify: `src/daemon/controlHandlers.ts`
- Test: `__tests__/daemon/controlSocketMount.test.ts`
- Test: `__tests__/daemon/controlHandlers.test.ts`

- [ ] **Step 1: Check out and rebase after #136**

```bash
git fetch origin codex/fix-control-socket-pane-authorization-bypass
git switch -C pr-139 origin/codex/fix-control-socket-pane-authorization-bypass
git rebase origin/main
```

Expected: conflicts in `src/daemon/controlHandlers.ts` preserve #136's refresh/identity-aware close path and #139's project-registry resolution for every canonical control mutation.

- [ ] **Step 2: Review all affected mutation handlers**

```bash
git diff --check
git diff origin/main...HEAD -- \
  src/daemon/controlHandlers.ts \
  __tests__/daemon/controlSocketMount.test.ts \
  __tests__/daemon/controlHandlers.test.ts
```

Expected: send input, resize, focus, and close/kill resolve caller-supplied pane IDs through the configured project registry before reaching tmux; unregistered `%999` is rejected with `pane_not_found`.

- [ ] **Step 3: Validate project-scoped authorization**

```bash
pnpm exec vitest --run \
  __tests__/daemon/controlHandlers.test.ts \
  __tests__/daemon/daemonConnection.test.ts \
  __tests__/daemon/controlSocketMount.test.ts
pnpm run typecheck
```

Expected: tests and typecheck pass. The environment must provide `tmux`; if it does not, install/use the repository-supported tmux environment rather than skipping the control-socket regression.

- [ ] **Step 4: Push and merge**

```bash
git push --force-with-lease origin HEAD:codex/fix-control-socket-pane-authorization-bypass
gh pr checks 139 --watch
gh pr merge 139 --squash --admin --delete-branch
git fetch origin main
```

Expected: PR #139 is merged.

### Task 10: Final Integrated Verification

**Files:**
- Verify: all files changed by merged aardvark PRs.

- [ ] **Step 1: Update the train branch to final main**

```bash
git switch aardvark-train
git merge --ff-only origin/main
git status --short --branch
```

Expected: clean worktree matching `origin/main`.

- [ ] **Step 2: Run integrated repository checks**

```bash
pnpm run typecheck
pnpm test
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml -- --check
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
```

Expected: all available integrated checks pass. Any environment failure is recorded with its exact command and error and must already be covered by passing required GitHub CI before completion.

- [ ] **Step 3: Confirm PR closure and merge state**

```bash
gh pr list --state open --label aardvark --limit 100
for pr in 130 132 133 134 136 137 138 139; do
  gh pr view "$pr" --json number,state,mergedAt,url
done
```

Expected: no open `aardvark` PR remains; each retained PR is merged and each superseded PR is closed with evidence.

- [ ] **Step 4: Remove the temporary worktree**

```bash
cd ../..
git worktree remove .worktrees/aardvark-train
git worktree prune
```

Expected: the temporary merge-train worktree is removed without affecting the preserved documentation branch.
