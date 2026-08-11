# Hide Empty Session Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the macOS Psyche session rail never shows empty worktree or branch groups while preserving populated and unresolved session groups.

**Architecture:** Keep native Git discovery and the shared rail model complete, then enforce the session-driven visibility rule in `renderSessionList`. The current production code at commit `c9237b6` already applies this filter, so the remaining work is to lock the uncovered hidden-session and unresolved-session acceptance criteria into the focused renderer suite without changing Git state or unrelated workspace behavior.

**Tech Stack:** Tauri 2, vanilla JavaScript, TypeScript, Vitest

---

## File map

- Modify `__tests__/tauriCovenSessionSiderail.test.ts`: add renderer regressions for hiding a group's final hidden session and retaining the populated unresolved-session fallback.
- Verify `native/macos/psyche-build-tauri/web/main.js:1206-1231`: retain the existing render-boundary filter that includes only groups with session rows.
- Reference `native/macos/psyche-build-tauri/web/sessions/session-model.mjs:173-225`: keep full worktree discovery and unresolved row ownership unchanged.

### Task 1: Complete empty-group renderer coverage

**Files:**
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts:258-269`
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts:449-519`
- Verify: `native/macos/psyche-build-tauri/web/main.js:1206-1231`

- [ ] **Step 1: Add the persisted hidden-state field to the renderer fixture type**

Add `hidden?: boolean` to `LocalThread` so test fixtures match the production
thread shape:

```ts
type LocalThread = {
  id: string;
  projectId: string;
  name: string;
  needsAttention?: boolean;
  status?: string;
  spawning?: boolean;
  hidden?: boolean;
  covenSessionId?: string | null;
  worktreePath?: string;
  kind?: string;
};
```

- [ ] **Step 2: Add regressions for hidden-only and unresolved groups**

Insert these cases after
`hides selected empty worktrees while preserving populated worktree ownership and attention`:

```ts
  it('omits a project when its only worktree session is hidden', () => {
    const renderer = createRenderer({
      projects: [
        {
          id: 'alpha', name: 'Alpha', root: '/alpha',
          worktrees: [
            { path: '/alpha', branch: 'main', is_main: true, dirty: false, missing: false },
          ],
        },
        {
          id: 'beta', name: 'Beta', root: '/beta',
          worktrees: [
            { path: '/beta', branch: 'main', is_main: true, dirty: false, missing: false },
          ],
        },
      ],
      threads: [
        {
          id: 'hidden-alpha', projectId: 'alpha', name: 'Hidden Alpha',
          status: 'running', worktreePath: '/alpha', hidden: true,
        },
        {
          id: 'visible-beta', projectId: 'beta', name: 'Visible Beta',
          status: 'running', worktreePath: '/beta',
        },
      ],
    });

    renderer.render();

    const groups = renderer.sessionListEl.querySelectorAll('.session-group');
    expect(groups).toHaveLength(1);
    expect(groups[0].textContent).toContain('Beta');
    expect(renderer.sessionListEl.textContent).not.toContain('Alpha');
    expect(renderer.sessionListEl.querySelectorAll('.session-worktree-group')).toHaveLength(1);
    expect(renderer.sessionListEl.querySelector('.session-row')?.dataset.threadId)
      .toBe('visible-beta');
  });

  it('keeps unresolved sessions visible because their fallback group is populated', () => {
    const renderer = createRenderer({
      projects: [{
        id: 'alpha', name: 'Alpha', root: '/alpha',
        worktrees: [
          { path: '/alpha', branch: 'main', is_main: true, dirty: false, missing: false },
        ],
      }],
      threads: [{
        id: 'orphan', projectId: 'alpha', name: 'Orphan session',
        status: 'running', worktreePath: '/removed/worktree',
      }],
    });

    renderer.render();

    expect(renderer.sessionListEl.querySelectorAll('.session-worktree-group')).toHaveLength(1);
    expect(renderer.sessionListEl.querySelector('.session-worktree-head')?.title)
      .toBe('Sessions with no available worktree');
    expect(renderer.sessionListEl.querySelector('.session-row')?.dataset.threadId).toBe('orphan');
  });
```

- [ ] **Step 3: Run the focused renderer suite**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: PASS. The current renderer already filters `entry.rows.length > 0`
and adds `projectRows` only when unresolved sessions exist.

- [ ] **Step 4: Confirm the production filter remains presentation-only**

Inspect `native/macos/psyche-build-tauri/web/main.js` and keep this logic
unchanged:

```js
      var visibleWorktrees = railModel.worktrees.filter(function (entry) {
        return entry.rows.length > 0;
      });
      if (railModel.projectRows.length > 0) {
        visibleWorktrees.push({
          worktree: {
            path: "",
            branch: "Unresolved sessions",
            is_main: false,
            dirty: false,
            missing: true,
            collapsed: false,
            virtual: true,
          },
          matches: true,
          rows: railModel.projectRows,
        });
      }
      if (visibleWorktrees.length === 0) return;
```

Do not modify `refreshProjectWorktrees`, `git_worktrees`, or
`buildProjectRailModel`; those surfaces must retain the complete discovered
worktree list.

- [ ] **Step 5: Commit the completed regression coverage**

```bash
git add __tests__/tauriCovenSessionSiderail.test.ts
git diff --cached --check
git commit -m "test: cover empty session group filtering"
```

### Task 2: Verify the rail contract and repository types

**Files:**
- Verify: `__tests__/tauriCovenSessionSiderail.test.ts`
- Verify: `__tests__/tauriWorkspaceRail.test.ts`
- Verify: `__tests__/tauriSessionModel.test.ts`
- Verify: `native/macos/psyche-build-tauri/web/main.js`

- [ ] **Step 1: Run all focused rail and model regressions together**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriSessionModel.test.ts
```

Expected: PASS. Empty worktrees, branch-only search matches, hidden-only
projects, and empty rails remain absent; populated and unresolved groups remain
visible.

- [ ] **Step 2: Run the repository typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS with no TypeScript errors in the updated renderer fixture type
or test cases.

- [ ] **Step 3: Confirm the change set is limited to the approved scope**

Run:

```bash
git status --short
git diff --check
git diff -- __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: no production JavaScript, native Rust, worktree discovery, branch
deletion, or unrelated workspace files are changed by this plan.
