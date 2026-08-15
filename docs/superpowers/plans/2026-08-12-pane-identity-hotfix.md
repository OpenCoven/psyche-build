# Pane Identity Generation Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a generation-less stale pane identity from matching and removing a generation-tagged replacement pane.

**Architecture:** Tighten the existing `ProjectPaneConfig` compare-and-remove boundary rather than adding another close-path guard. Pane IDs and tmux generations will match symmetrically, so legacy records remain compatible with legacy callers while generation-tagged records require generation-tagged expectations.

**Tech Stack:** TypeScript 5.9, Vitest, pnpm, GitHub CLI

---

## File Structure

- Modify `src/services/ProjectPaneConfig.ts`: enforce symmetric optional tmux-generation matching in the canonical pane identity comparator.
- Modify `__tests__/projectPaneConfig.test.ts`: add the regression case for a generation-less expected identity against a generation-tagged replacement.
- Read-only validation `__tests__/actions/closeAction.test.ts`: retain coverage that an identity conflict aborts before tmux teardown.

### Task 1: Create the Isolated Hotfix Worktree

**Files:**
- Read: `docs/superpowers/specs/2026-08-12-merged-regression-hotfixes-design.md`

- [ ] **Step 1: Refresh the protected base**

Run:

```bash
git fetch --prune origin
```

Expected: command exits successfully and `origin/main` is current.

- [ ] **Step 2: Create a clean worktree from `origin/main`**

Run from the repository root:

```bash
git worktree add -b fix/pane-identity-generation-match \
  ../psyche-build-pane-identity-generation-match \
  origin/main
```

Expected: Git creates `../psyche-build-pane-identity-generation-match` on branch `fix/pane-identity-generation-match`.

- [ ] **Step 3: Confirm isolation**

Run:

```bash
git -C ../psyche-build-pane-identity-generation-match status --short --branch
```

Expected:

```text
## fix/pane-identity-generation-match...origin/main
```

### Task 2: Add the Failing Generation-Mismatch Test

**Files:**
- Modify: `__tests__/projectPaneConfig.test.ts`

- [ ] **Step 1: Add the regression test after the existing cross-generation test**

Add:

```ts
  it('does not let a generation-less identity remove a generation-tagged replacement', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    const replacement = {
      id: 'psyche-exact',
      paneId: '%1',
      slug: 'replacement',
      tmuxServerIdentity: {
        pid: 222,
        processStartIdentity: 'new-start',
        socketPath: '/tmux.sock',
        sessionId: '$2',
      },
    };
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [replacement];
    });

    await expect(removeProjectPaneConfigPaneIdentities(projectRoot, [{
      id: 'psyche-exact',
      paneId: '%1',
    }])).rejects.toThrow(/identity conflict/);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).panes).toEqual([replacement]);
  });
```

- [ ] **Step 2: Run the focused test and verify the regression is exposed**

Run:

```bash
cd ../psyche-build-pane-identity-generation-match
pnpm vitest --run __tests__/projectPaneConfig.test.ts
```

Expected: the new test fails because the current comparator treats the missing expected generation as a wildcard and removes `replacement`.

### Task 3: Make Optional Generation Matching Symmetric

**Files:**
- Modify: `src/services/ProjectPaneConfig.ts:876-895`

- [ ] **Step 1: Replace the wildcard comparator**

Replace `hasPaneRecordIdentity` with:

```ts
function hasPaneRecordIdentity(
  value: ProjectPaneConfigPane,
  expected: ProjectPaneConfigPaneIdentity,
): boolean {
  const identity = paneRecordIdentity(value);
  if (
    !identity
    || identity.id !== expected.id
    || identity.paneId !== expected.paneId
  ) {
    return false;
  }

  if (!identity.tmuxServerIdentity || !expected.tmuxServerIdentity) {
    return (
      identity.tmuxServerIdentity === undefined
      && expected.tmuxServerIdentity === undefined
    );
  }

  return sameTmuxServerIdentity(
    identity.tmuxServerIdentity,
    expected.tmuxServerIdentity,
  );
}
```

- [ ] **Step 2: Run the focused config tests**

Run:

```bash
pnpm vitest --run __tests__/projectPaneConfig.test.ts
```

Expected: all tests pass, including legacy-to-legacy removal, matching tagged identities, different generations, and the new missing-generation mismatch.

- [ ] **Step 3: Run the close-path regression tests**

Run:

```bash
pnpm vitest --run __tests__/actions/closeAction.test.ts
```

Expected: all tests pass, including `aborts before teardown and refreshes UI when the exact pane identity was rebound`.

- [ ] **Step 4: Run type checking**

Run:

```bash
pnpm typecheck
```

Expected: TypeScript source and test type checks pass.

- [ ] **Step 5: Commit the production hotfix**

Run:

```bash
git add src/services/ProjectPaneConfig.ts __tests__/projectPaneConfig.test.ts
git commit -m "fix: require symmetric pane generation identity" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: one commit containing only the comparator and regression test.

### Task 4: Open, Review, and Merge the Hotfix PR

**Files:**
- No additional repository files.

- [ ] **Step 1: Push the branch**

Run:

```bash
git push -u origin fix/pane-identity-generation-match
```

Expected: the branch is published without force pushing.

- [ ] **Step 2: Create the pull request**

Run:

```bash
gh pr create \
  --base main \
  --head fix/pane-identity-generation-match \
  --title "fix: require symmetric pane generation identity" \
  --body "$(cat <<'EOF'
## Summary
- reject generation-less close identities when the persisted pane is generation-tagged
- preserve matching legacy-to-legacy pane cleanup
- cover the stale replacement regression

## Test Plan
- `pnpm vitest --run __tests__/projectPaneConfig.test.ts`
- `pnpm vitest --run __tests__/actions/closeAction.test.ts`
- `pnpm typecheck`
EOF
)"
```

Expected: GitHub returns the new PR URL.

- [ ] **Step 3: Run a fresh read-only code review**

Use the code-review agent against the final PR diff. Expected: no high-confidence correctness or security findings.

- [ ] **Step 4: Wait for required checks**

Run:

```bash
gh pr checks --watch --fail-fast
```

Expected: required `TypeScript and Rust` and `iOS` checks pass.

- [ ] **Step 5: Merge with linear history**

Run:

```bash
gh pr merge --squash --delete-branch
```

Expected: the PR is merged into `main`; if branch protection refuses the merge, stop and report the unmet requirement instead of bypassing it.

