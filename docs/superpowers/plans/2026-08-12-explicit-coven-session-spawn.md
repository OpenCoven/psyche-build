# Explicit Coven Session Spawning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent app boot and project navigation from creating Coven sessions while preserving one coalesced creation path for explicit Coven actions.

**Architecture:** Remove `ensureProjectCoven` from passive workspace lifecycle callers and delete the now-obsolete `ensureCoven` suppression option, while retaining normal restoration and focus of existing local panes. Route the agent picker and `/new-thread` through `ensureProjectCoven` so explicit requests reuse a visible pane and share the existing per-project/worktree in-flight launch guard.

**Tech Stack:** Tauri web runtime JavaScript, Vitest, TypeScript, pnpm

---

## File Structure

- Modify `native/macos/psyche-build-tauri/web/main.js`: remove passive Coven launch side effects and route explicit actions through the guarded launch helper.
- Modify `__tests__/tauriCovenLaunch.test.ts`: replace automatic-start contracts with explicit-only lifecycle and routing contracts.
- Modify `__tests__/tauriAgentPicker.test.ts`: prove the Coven picker delegates to the guarded launch path.
- Modify `__tests__/tauriPhysicalPanes.test.ts`: update project activation and `/new-thread` behavioral harnesses after removing the `ensureCoven` option.
- Modify `__tests__/tauriCovenSessionLifecycle.test.ts`: prove daemon attachment activation remains passive without special suppression flags.

### Task 1: Make Workspace Lifecycle Passive

**Files:**

- Modify: `native/macos/psyche-build-tauri/web/main.js` — `activateProjectWorktree`, `setActiveProject`, `openCovenSession`, `openProjectPicker`, and `boot`
- Test: `__tests__/tauriCovenLaunch.test.ts` — lifecycle routing and project activation
- Test: `__tests__/tauriAgentPicker.test.ts` — lifecycle source contract
- Test: `__tests__/tauriPhysicalPanes.test.ts` — worktree activation and `/new-thread`
- Test: `__tests__/tauriCovenSessionLifecycle.test.ts` — daemon attachment activation

- [ ] **Step 1: Replace automatic-start source assertions with explicit-only assertions**

In `__tests__/tauriCovenLaunch.test.ts`, replace the lifecycle expectations at
the end of `routes native defaults to Coven while retaining explicit shell and
Psyche commands` with:

```typescript
    expect(functionSource('setActiveProject')).not.toContain('ensureProjectCoven');
    expect(functionSource('setActiveProject')).not.toContain('ensureCoven');
    expect(functionSource('openProjectPicker')).not.toContain('ensureProjectCoven');
    expect(functionSource('boot')).not.toContain('ensureProjectCoven');
    expect(mainJs).toContain('label: "Open Coven Terminal"');
    expect(mainJs).toMatch(/\/new-thread[\s\S]*\/new-shell[\s\S]*\/new-psyche/);
```

Replace the final automatic-start test in
`__tests__/tauriAgentPicker.test.ts` with:

```typescript
  it('keeps project lifecycle passive while the picker handles explicit agent choice', () => {
    expect(functionSource('setActiveProject')).not.toContain('ensureProjectCoven');
    expect(functionSource('openProjectPicker')).not.toContain('ensureProjectCoven');
    expect(functionSource('boot')).not.toContain('ensureProjectCoven');
  });
```

- [ ] **Step 2: Add behavioral regressions for project activation and project opening**

Replace the tests named
`does not overwrite picker or activation errors when Coven creation returns null`
and `marks picker and activation ready only after Coven creation succeeds` in
`__tests__/tauriCovenLaunch.test.ts` with:

```typescript
  it('opens a project without starting Coven', async () => {
    const project = { id: 'project', root: '/repo', name: 'repo' };
    let launches = 0;
    const openProjectPicker = compileFunction<() => Promise<void>>(
      functionSource('openProjectPicker'),
      {
        dialogOpen: async () => '/repo',
        state: { env: { home: '/home' } },
        addProject: async () => project,
        ensureProjectCoven: async () => { launches += 1; return { id: 'coven' }; },
        writeToActive: () => undefined,
      },
    );

    await openProjectPicker();

    expect(launches).toBe(0);
  });

  it('activates a project with no local pane without starting Coven', async () => {
    const project = {
      id: 'project',
      root: '/repo',
      selectedWorktreePath: '/repo',
      lastActiveThreadId: null,
    };
    const state = {
      activeProjectId: 'other',
      activeThreadId: 'previous',
      threads: [],
    };
    let launches = 0;
    const setActiveProject = compileFunction<(id: string) => Promise<boolean>>(
      functionSource('setActiveProject'),
      {
        state,
        showTerminalView: async () => true,
        findProject: () => project,
        restoreProjectLayout: () => undefined,
        loadAgentSkills: () => undefined,
        activeWorkspaceRoot: () => '/repo',
        focusThread: async () => true,
        renderPaneWorkspace: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        syncProjectBrowser: () => undefined,
        ensureProjectCoven: async () => { launches += 1; return { id: 'coven' }; },
        saveWorkspaceSoon: () => undefined,
      },
    );

    await expect(setActiveProject(project.id)).resolves.toBe(true);

    expect(state.activeProjectId).toBe(project.id);
    expect(state.activeThreadId).toBeNull();
    expect(launches).toBe(0);
  });
```

The injected `ensureProjectCoven` dependency intentionally remains in these
harnesses during the red phase so the tests prove the function is not called.

- [ ] **Step 3: Run the passive lifecycle tests and verify they fail**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriAgentPicker.test.ts
```

Expected: FAIL because `setActiveProject`, `openProjectPicker`, and `boot`
still contain automatic `ensureProjectCoven` calls.

- [ ] **Step 4: Remove passive Coven creation from project activation**

In `setActiveProject` in
`native/macos/psyche-build-tauri/web/main.js`, replace the no-thread branch:

```javascript
    } else {
      state.activeThreadId = null;
      renderPaneWorkspace();
      refreshSidebar();
      refreshTabs();
      syncProjectBrowser();
      if (!options || options.ensureCoven !== false) {
        var covenThread = await ensureProjectCoven(project);
        if (covenThread) setStatus("no pane — launching Coven…", "");
      }
    }
```

with:

```javascript
    } else {
      state.activeThreadId = null;
      renderPaneWorkspace();
      refreshSidebar();
      refreshTabs();
      syncProjectBrowser();
    }
```

Do not change project selection, saved layout restoration, status refresh, or
workspace persistence.

- [ ] **Step 5: Remove passive Coven creation from project opening and boot**

In `openProjectPicker`, replace:

```javascript
      var project = await addProject(selected);
      if (project) {
        var covenThread = await ensureProjectCoven(project);
        if (covenThread) setProjectStatus(project, "ok");
      }
```

with:

```javascript
      await addProject(selected);
```

In `boot`, remove only:

```javascript
      await ensureProjectCoven(project);
```

Keep browser restoration and `restoreProjectLayout(project)` in their current
order.

- [ ] **Step 6: Remove the obsolete attach-only `ensureCoven` option**

In `openCovenSession`, replace:

```javascript
        if (!(await activateProjectWorktree(
          project, existing.worktreePath, { ensureCoven: false }
        ))) return null;
```

with:

```javascript
        if (!(await activateProjectWorktree(project, existing.worktreePath))) return null;
```

Replace:

```javascript
      if (!(await activateProjectWorktree(project, worktree.path, { ensureCoven: false }))) return null;
```

with:

```javascript
      if (!(await activateProjectWorktree(project, worktree.path))) return null;
```

In `__tests__/tauriCovenSessionLifecycle.test.ts`, remove the
`ensureProjectCoven` dependency and `defaultLaunches` counter from the two tests
that open a hidden attachment or create an attachment in an inactive project.
Keep the existing assertions for selected worktree, reopened attachment, and
created attachment options.

In `__tests__/tauriPhysicalPanes.test.ts`, replace test-only
`{ ensureCoven: false }` option fixtures and expected focus options with the
equivalent refresh-only forms:

```typescript
const options = { refreshStatus: false };
```

and:

```typescript
expect(focusCalls).toEqual([
  { id: 'thread-a', options: { refreshStatus: false } },
]);
```

- [ ] **Step 7: Run the focused passive lifecycle suite**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts
```

Expected: PASS. Project boot, opening, switching, worktree activation, and
daemon attachment no longer require launch suppression because they have no
implicit launch path.

- [ ] **Step 8: Commit the passive lifecycle change**

```bash
git add \
  native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts
git diff --cached --check
git commit -m "fix(macos): stop automatic Coven session spawning" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Unify Explicit Coven Creation

**Files:**

- Modify: `native/macos/psyche-build-tauri/web/main.js` — `runNewThreadCommand` and `spawnAgentThread`
- Test: `__tests__/tauriCovenLaunch.test.ts` — launch coalescing and source routing
- Test: `__tests__/tauriAgentPicker.test.ts` — Coven picker delegation
- Test: `__tests__/tauriPhysicalPanes.test.ts` — `/new-thread` delegation

- [ ] **Step 1: Change the `/new-thread` test to require the guarded explicit path**

In `__tests__/tauriPhysicalPanes.test.ts`, replace the
`accepts guarded /new-thread creation only after revealing the terminal` test
with:

```typescript
  it('routes /new-thread through the guarded Coven ensure path', async () => {
    const project = { id: 'project', root: '/repo' };
    let ensured: typeof project | null = null;
    const result = { kind: 'coven-chat' };
    const runNewThreadCommand = compileFunction<() => Promise<typeof result | null>>(
      functionSource('runNewThreadCommand'),
      {
        activeProject: () => project,
        ensureProjectCoven: async (value: typeof project) => {
          ensured = value;
          return result;
        },
      },
    );

    await expect(runNewThreadCommand()).resolves.toBe(result);
    expect(ensured).toBe(project);
    expect(mainJs).toMatch(/cmd: "\/new-thread"[\s\S]*?run: runNewThreadCommand/);
  });
```

Replace the `/new-thread` cancellation test with:

```typescript
  it('returns null from /new-thread when no project can be ensured', async () => {
    const runNewThreadCommand = compileFunction<() => Promise<null>>(
      functionSource('runNewThreadCommand'),
      {
        activeProject: () => null,
        ensureProjectCoven: async () => null,
      },
    );

    await expect(runNewThreadCommand()).resolves.toBeNull();
  });
```

- [ ] **Step 2: Change the Coven picker test to require the guarded explicit path**

In `__tests__/tauriAgentPicker.test.ts`, replace
`resolves Coven Code through the discovered Coven executable` with:

```typescript
  it('routes Coven Code through the guarded explicit launch path', async () => {
    const project = { id: 'project', root: '/repo' };
    const ensured = { id: 'coven-thread' };
    let ensuredProject: typeof project | null = null;
    const spawnAgentThread = compileFunction<
      (agentId: string) => Promise<typeof ensured | null>
    >(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => project,
        selectedWorktree: () => ({ path: '/repo' }),
        showTerminalView: async () => {
          throw new Error('ensureProjectCoven owns terminal reveal');
        },
        agentLaunchOptions: () => [
          { id: 'coven-code', label: 'Coven Code', command: null, args: ['chat'], kind: 'coven-chat' },
        ],
        state: { env: { coven_path: '/opt/homebrew/bin/coven' } },
        setStatus: () => undefined,
        ensureProjectCoven: async (value: typeof project) => {
          ensuredProject = value;
          return ensured;
        },
        createThread: () => {
          throw new Error('Coven picker must not bypass ensureProjectCoven');
        },
      },
    );

    await expect(spawnAgentThread('coven-code')).resolves.toBe(ensured);
    expect(ensuredProject).toBe(project);
  });
```

Retain the existing unavailable-Coven test; add an
`ensureProjectCoven` dependency that throws if called so the test continues
proving availability is checked before launch delegation.

- [ ] **Step 3: Strengthen the explicit routing source contract**

In `__tests__/tauriCovenLaunch.test.ts`, update the final routing test to
include:

```typescript
    expect(functionSource('runNewThreadCommand')).toMatch(
      /ensureProjectCoven\(activeProject\(\)\)/
    );
    expect(functionSource('spawnAgentThread')).toMatch(
      /entry\.id === "coven-code"[\s\S]*return ensureProjectCoven\(project\)/
    );
    expect(mainJs).toMatch(
      /label: "Open Coven Terminal"[\s\S]*ensureProjectCoven\(project\)/
    );
```

Keep the existing `ensureProjectCoven` tests that prove:

- concurrent requests return the same promise and create one thread;
- rejected launches clear the in-flight map;
- a visible live exact-workspace pane is focused instead of duplicated; and
- a hidden, exited, or other-worktree pane does not block an explicit launch.

- [ ] **Step 4: Run the explicit routing tests and verify they fail**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriPhysicalPanes.test.ts
```

Expected: FAIL because `/new-thread` calls `spawnCovenThread` directly and the
Coven picker calls `createThread` with the registry's raw `chat` arguments.

- [ ] **Step 5: Route `/new-thread` through `ensureProjectCoven`**

Replace:

```javascript
  async function runNewThreadCommand() {
    return spawnCovenThread();
  }
```

with:

```javascript
  async function runNewThreadCommand() {
    return ensureProjectCoven(activeProject());
  }
```

`ensureProjectCoven` already returns `null` for a missing project, focuses a
matching visible live pane, and coalesces concurrent requests.

- [ ] **Step 6: Route the Coven picker through `ensureProjectCoven`**

In `spawnAgentThread`, keep project, worktree, registry-entry, and Coven
executable validation. Replace the Coven-specific command substitution with an
early explicit delegation:

```javascript
    if (entry.id === "coven-code") {
      if (!state.env || !state.env.coven_path) {
        setStatus("Coven CLI not found — install @opencoven/cli and restart Psyche", "error");
        return null;
      }
      return ensureProjectCoven(project);
    }
```

After that branch, retain the generic agent path:

```javascript
    if (!(await showTerminalView())) return null;
    return createThread({
      project: project,
      worktreePath: worktree.path,
      name: entry.label,
      kind: entry.kind,
      command: entry.command,
      args: entry.args.slice(),
      launchKind: null,
      projectRoot: project.root,
      cwd: worktree.path,
    });
```

This prevents the Coven picker from bypassing secure session ID generation,
the provenance environment marker, PTY validation, and launch coalescing.

- [ ] **Step 7: Run the focused explicit routing suite**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriPhysicalPanes.test.ts
```

Expected: PASS. Every normal explicit Coven creation surface delegates to
`ensureProjectCoven`; the intentional Duplicate action remains a separate
fresh-session path.

- [ ] **Step 8: Commit the explicit routing change**

```bash
git add \
  native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriPhysicalPanes.test.ts
git diff --cached --check
git commit -m "fix(macos): guard explicit Coven launches" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Verify the Complete Behavior

**Files:**

- Verify: `native/macos/psyche-build-tauri/web/main.js`
- Verify: `__tests__/tauriCovenLaunch.test.ts`
- Verify: `__tests__/tauriAgentPicker.test.ts`
- Verify: `__tests__/tauriPhysicalPanes.test.ts`
- Verify: `__tests__/tauriCovenSessionLifecycle.test.ts`

- [ ] **Step 1: Run the complete Coven and workspace regression set**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriSessionModel.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
```

Expected: PASS. Existing daemon discovery, attachment, row assignment,
workspace switching, hidden-pane, and explicit launch behavior remain intact.

- [ ] **Step 2: Run type checking and the full unit suite**

Run:

```bash
pnpm typecheck
pnpm exec vitest --run --minWorkers=1 --maxWorkers=1
```

Expected: both commands exit successfully with no test failures or TypeScript
errors.

- [ ] **Step 3: Run the build and source integrity checks**

Run:

```bash
pnpm build
git diff --check
git status --short
```

Expected: build succeeds, `git diff --check` reports no whitespace errors, and
the worktree contains only the intended implementation commits plus this plan
document if it has not already been committed.

- [ ] **Step 4: Inspect the final launch call graph**

Run:

```bash
rg -n "ensureProjectCoven|spawnCovenThread|ensureCoven" \
  native/macos/psyche-build-tauri/web/main.js
```

Expected:

- no `ensureCoven` matches;
- no `ensureProjectCoven` call in `boot`, `openProjectPicker`, or
  `setActiveProject`;
- explicit worktree action, Coven picker, and `/new-thread` call
  `ensureProjectCoven`;
- `ensureProjectCoven` is the normal caller of `spawnCovenThread`; and
- the intentional Duplicate action may still call the fresh Coven launch path.
