# Siderail Project Closing and Empty-Project Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-level close action to the native desktop Sessions siderail and omit projects that own no non-dormant local or assigned Coven sessions.

**Architecture:** Keep the complete workspace state unchanged and apply project eligibility only while building the native desktop Sessions rail. Reuse the existing shared project context-menu helper for pointer and keyboard menus, and route its new danger action through the existing `removeProject` lifecycle.

**Tech Stack:** Plain JavaScript DOM rendering in Tauri, Vitest, TypeScript test harnesses, pnpm.

---

## File structure

- Modify `native/desktop/psyche-build-tauri/web/main.js`: separate underlying project-session eligibility from visible row filtering, and add **Close project** to the shared project context actions.
- Modify `__tests__/tauriCovenSessionSiderail.test.ts`: extend the renderer/context-menu harnesses with a `removeProject` spy and cover empty-project eligibility plus pointer/keyboard close actions.
- Reference `docs/superpowers/specs/2026-08-20-siderail-close-hide-empty-projects-design.md`: approved behavior and non-goals; no implementation edit is required.

### Task 1: Hide Only Truly Empty Projects

**Files:**
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts:1027-1415`
- Modify: `native/desktop/psyche-build-tauri/web/main.js:7538-7567`

- [ ] **Step 1: Write failing renderer tests for project eligibility**

Add these tests near the other project rendering tests in
`__tests__/tauriCovenSessionSiderail.test.ts`:

```ts
it('omits projects with no non-dormant local or assigned Coven sessions', () => {
  const renderer = createRenderer({
    projects: [
      {
        id: 'active',
        name: 'Active',
        root: '/active',
        collapsed: false,
        selectedWorktreePath: '/active',
        worktrees: [{
          path: '/active',
          branch: 'main',
          is_main: true,
          collapsed: false,
          dirty: false,
          missing: false,
        }],
      },
      {
        id: 'empty',
        name: 'Empty',
        root: '/empty',
        collapsed: false,
        selectedWorktreePath: '/empty',
        worktrees: [{
          path: '/empty',
          branch: 'main',
          is_main: true,
          collapsed: false,
          dirty: false,
          missing: false,
        }],
      },
    ],
    threads: [
      {
        id: 'shell',
        projectId: 'active',
        worktreePath: '/active',
        name: 'shell',
        kind: 'shell',
        status: 'running',
      },
      {
        id: 'exited',
        projectId: 'empty',
        worktreePath: '/empty',
        name: 'exited shell',
        kind: 'shell',
        status: 'exited',
      },
    ],
  });

  renderer.render();

  expect(renderer.sessionListEl.querySelectorAll('.session-project-name').map(
    (name) => name.textContent,
  )).toEqual(['Active']);
  expect(renderer.state.projects.map((project) => project.id))
    .toEqual(['active', 'empty']);
});

it('keeps projects with hidden non-dormant local sessions', () => {
  const renderer = createRenderer({
    projects: [{
      id: 'hidden',
      name: 'Hidden',
      root: '/hidden',
      collapsed: false,
      selectedWorktreePath: '/hidden',
      worktrees: [{
        path: '/hidden',
        branch: 'main',
        is_main: true,
        collapsed: false,
        dirty: false,
        missing: false,
      }],
    }],
    threads: [{
      id: 'hidden-shell',
      projectId: 'hidden',
      worktreePath: '/hidden',
      name: 'hidden shell',
      kind: 'shell',
      status: 'running',
      hidden: true,
    }],
  });

  renderer.render();

  expect(renderer.sessionListEl.querySelector('.session-project-name')?.textContent)
    .toBe('Hidden');
  expect(renderer.sessionListEl.querySelector('.session-row')).toBeNull();
  expect(renderer.sessionListEl.querySelector('.session-empty')?.textContent)
    .toBe('No sessions yet.');
});

it('keeps projects with assigned Coven sessions', () => {
  const renderer = createRenderer({
    projects: [{
      id: 'coven',
      name: 'Coven',
      root: '/coven',
      collapsed: false,
      selectedWorktreePath: '/coven',
      worktrees: [{
        path: '/coven',
        branch: 'main',
        is_main: true,
        collapsed: false,
        dirty: false,
        missing: false,
      }],
    }],
    sessions: [{
      id: 'remote',
      projectRoot: '/coven',
      title: 'Agent Coven',
      status: 'running',
      cwd: '/coven',
      labels: ['source:psyche-build'],
    }],
  });

  renderer.render();

  expect(renderer.sessionListEl.querySelector('.session-project-name')?.textContent)
    .toBe('Coven');
  expect(covenRows(renderer.sessionListEl)).toHaveLength(1);
});

it('keeps populated projects when the active filter has no matching rows', () => {
  const renderer = createRenderer({
    projects: [{
      id: 'shells',
      name: 'Shells',
      root: '/shells',
      collapsed: false,
      selectedWorktreePath: '/shells',
      worktrees: [{
        path: '/shells',
        branch: 'main',
        is_main: true,
        collapsed: false,
        dirty: false,
        missing: false,
      }],
    }],
    threads: [{
      id: 'shell',
      projectId: 'shells',
      worktreePath: '/shells',
      name: 'shell',
      kind: 'shell',
      status: 'running',
    }],
    typeFilter: 'agents',
  });

  renderer.render();

  expect(renderer.sessionListEl.querySelector('.session-project-name')?.textContent)
    .toBe('Shells');
  expect(renderer.sessionListEl.querySelector('.session-row')).toBeNull();
  expect(renderer.sessionListEl.querySelector('.session-empty')?.textContent)
    .toBe('No sessions match the agents filter.');
});
```

- [ ] **Step 2: Run the eligibility tests and verify they fail**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts \
  -t "omits projects|keeps projects with hidden|keeps projects with assigned|keeps populated projects"
```

Expected: FAIL because the current renderer includes the `Empty` project.

- [ ] **Step 3: Separate underlying sessions from visible local rows**

Replace the project-model loop in
`native/desktop/psyche-build-tauri/web/main.js` with:

```js
var projectModels = [];
state.projects.forEach(function (project) {
  var projectThreads = state.threads.filter(function (thread) {
    return thread.projectId === project.id && !isDormantThread(thread);
  });
  var remoteRows = covenSessionsForProject(project, covenAssignments);
  if (projectThreads.length === 0 && remoteRows.length === 0) return;

  var localRows = projectThreads.filter(function (thread) {
    return !thread.hidden;
  });
  var projectModel = PsycheSessions.buildSidebarProjectModel({
    project: project,
    localSessions: localRows,
    covenSessions: remoteRows,
    query: currentSearchQuery,
    filter: sessionTypeFilter,
    selectedKey: selectedKey,
    now: now,
  });
  matched += projectModel.visibleCount;
  projectModels.push({
    project: project,
    model: projectModel,
    appearance: PsycheSessions.resolveProjectAppearance(project, projectAppearances),
  });
});
```

Keep eligibility before `buildSidebarProjectModel` so search/filter changes
cannot redefine a populated project as empty. Do not mutate `state.projects`.

- [ ] **Step 4: Run the eligibility tests and verify they pass**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts \
  -t "omits projects|keeps projects with hidden|keeps projects with assigned|keeps populated projects"
```

Expected: PASS for all four project eligibility tests.

- [ ] **Step 5: Run the complete siderail suite**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: PASS with no project hierarchy, empty-state, or Coven assignment
regressions.

- [ ] **Step 6: Commit the visibility change**

```bash
git add native/desktop/psyche-build-tauri/web/main.js \
  __tests__/tauriCovenSessionSiderail.test.ts
git commit --no-gpg-sign -m "feat: hide empty siderail projects" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Close Projects From Pointer and Keyboard Menus

**Files:**
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts:545-925`
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts:928-986`
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts:1319-1374`
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts:1568-1622`
- Modify: `native/desktop/psyche-build-tauri/web/main.js:5458-5466`

- [ ] **Step 1: Add `removeProject` spies to both menu harnesses**

In `createRenderer`, define the spy beside the other project actions:

```ts
const removeProject = vi.fn().mockResolvedValue(true);
```

Add `'removeProject'` to the dynamic `Function` parameter list immediately
after `'openProjectAppearancePopover'`, pass `removeProject` in the matching
invocation position, and return it from `createRenderer`:

```ts
// Replace these existing Function parameter lines:
'openSessionContextMenu', 'openProjectAppearancePopover',
'invoke', 'refreshCovenSessions', 'localStorage', 'seedStatusAlertEl', 'seedToastEl',

// With:
'openSessionContextMenu', 'openProjectAppearancePopover', 'removeProject',
'invoke', 'refreshCovenSessions', 'localStorage', 'seedStatusAlertEl', 'seedToastEl',

// Replace these existing invocation arguments:
openSessionContextMenu,
openProjectAppearancePopover,
invoke,

// With:
openSessionContextMenu,
openProjectAppearancePopover,
removeProject,
invoke,
```

Then add the spy to the returned renderer object:

```ts
return {
  ...harness,
  document,
  sessionListEl,
  composerInputEl,
  state,
  discovery,
  focusSets,
  removeFromFocusSet,
  applySetScopeForThread,
  activateFocusSet,
  clearFocusSet,
  settings,
  saveSettings,
  saveWorkspaceSoon,
  setSessionTypeFilter,
  openSessionContextMenu,
  setActiveProject,
  activateProjectWorktree,
  focusThread,
  closeThread,
  hideThread,
  renameThread,
  editLabelInline,
  openCovenSession,
  invoke,
  localStorage,
  refreshCovenSessions,
  setStatus,
  statusAlertEl,
  toastEl,
  toastTimeouts,
  canvasThreadIds,
  openProjectAppearancePopover,
  removeProject,
};
```

In `createSessionContextMenuHarness`, define and inject the same dependency:

```ts
const removeProject = vi.fn().mockResolvedValue(true);
const harness = Function(
  'document', 'window', 'sessionListEl', 'findProject',
  'openProjectAppearancePopover', 'removeProject',
  `"use strict";
  var sessionTreeFocusKey = "";
  var projectAppearancePopover = null;
  function closeProjectAppearancePopover() {}
  var sessionContextMenu = null;
  var sessionContextMenuRestoreKey = "";
  ${extractFunctionSource(mainJs, 'visibleSessionTreeItems')}
  ${extractFunctionSource(mainJs, 'focusSessionTreeItem')}
  ${extractFunctionSource(mainJs, 'parentSessionTreeItem')}
  ${extractFunctionSource(mainJs, 'firstChildSessionTreeItem')}
  ${extractFunctionSource(mainJs, 'toggleSessionTreeDisclosure')}
  ${extractFunctionSource(mainJs, 'activateSessionTreeItem')}
  ${extractFunctionSource(mainJs, 'restoreSessionTreeFocus')}
  ${extractFunctionSource(mainJs, 'projectAppearanceContextActions')}
  ${extractFunctionSource(mainJs, 'closeSessionContextMenu')}
  ${extractFunctionSource(mainJs, 'openSessionContextMenu')}
  ${extractFunctionSource(mainJs, 'handleSessionTreeKeydown')}
  return {
    closeSessionContextMenu: closeSessionContextMenu,
    handleTreeKeydown: handleSessionTreeKeydown,
    sessionContextMenu: function () { return sessionContextMenu; },
    sessionTreeFocusKey: function () { return sessionTreeFocusKey; }
  };`,
)(
  document,
  windowValue,
  sessionListEl,
  (id: string) => (id === projectValue.id ? projectValue : null),
  openProjectAppearancePopover,
  removeProject,
);
```

Return `removeProject` from `createSessionContextMenuHarness`:

```ts
return {
  ...harness,
  document,
  sessionListEl,
  project,
  openProjectAppearancePopover,
  removeProject,
};
```

- [ ] **Step 2: Update the pointer-menu test to require the close action**

Rename the existing pointer test to
`opens a project header context menu with appearance and close actions` and
replace its action assertions with:

```ts
expect(renderer.openSessionContextMenu).toHaveBeenCalledTimes(1);
const [, actions, anchor] = renderer.openSessionContextMenu.mock.calls[0];
expect(actions).toHaveLength(2);
expect(actions[0]).toMatchObject({ label: 'Customize appearance' });
expect(actions[1]).toMatchObject({ label: 'Close project', danger: true });
expect(anchor).toBe(projectTreeitem);
expect(renderer.sessionTreeFocusKey()).toBe(projectTreeitem?.dataset.treeKey);

actions[0].run();
expect(renderer.openProjectAppearancePopover).toHaveBeenCalledWith(
  renderer.state.projects[0],
  projectTreeitem,
);

await actions[1].run();
expect(renderer.removeProject).toHaveBeenCalledOnce();
expect(renderer.removeProject).toHaveBeenCalledWith('psyche');
```

- [ ] **Step 3: Update the keyboard-menu test to require the shared action list**

After each Context Menu and Shift+F10 invocation, assert the labels and danger
state:

```ts
expect(renderer.openSessionContextMenu.mock.calls[0][1].map(
  (action: { label: string }) => action.label,
)).toEqual(['Customize appearance', 'Close project']);
expect(renderer.openSessionContextMenu.mock.calls[0][1][1]).toMatchObject({
  label: 'Close project',
  danger: true,
});
```

Keep the existing assertions that the menu is anchored to the focused project
treeitem and that the keyboard events are prevented and stopped.

- [ ] **Step 4: Run the project-menu tests and verify they fail**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts \
  -t "project header context menu|focused project treeitem context menus"
```

Expected: FAIL because `projectAppearanceContextActions` currently returns only
**Customize appearance**.

- [ ] **Step 5: Add the danger-styled close action**

Replace `projectAppearanceContextActions` in
`native/desktop/psyche-build-tauri/web/main.js` with:

```js
function projectAppearanceContextActions(project, anchor) {
  if (!project) return [];
  return [
    {
      label: "Customize appearance",
      run: function () {
        openProjectAppearancePopover(project, anchor);
      },
    },
    {
      label: "Close project",
      danger: true,
      run: function () {
        return removeProject(project.id);
      },
    },
  ];
}
```

Do not add a second close implementation or a new confirmation. The existing
`removeProject` function remains authoritative for dirty-file guards, thread
shutdown, resource cleanup, fallback selection, persistence, and errors.

- [ ] **Step 6: Run the project-menu tests and verify they pass**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts \
  -t "project header context menu|focused project treeitem context menus"
```

Expected: PASS for pointer and keyboard menu coverage.

- [ ] **Step 7: Run the complete siderail suite**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: PASS, including project-menu focus restoration and appearance
behavior.

- [ ] **Step 8: Commit the close action**

```bash
git add native/desktop/psyche-build-tauri/web/main.js \
  __tests__/tauriCovenSessionSiderail.test.ts
git commit --no-gpg-sign -m "feat: close projects from siderail" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Verify Project Lifecycle Regressions

**Files:**
- Verify: `native/desktop/psyche-build-tauri/web/main.js`
- Verify: `__tests__/tauriCovenSessionSiderail.test.ts`
- Verify: `__tests__/tauriPhysicalPanes.test.ts`
- Verify: `__tests__/tauriWorkspaceEditorIntegration.test.ts`
- Verify: `__tests__/tauriCovenSessionLifecycle.test.ts`

- [ ] **Step 1: Run the siderail and project-removal regression suites**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts
```

Expected: PASS. These suites cover the shared menu, project removal, dirty-file
boundaries, thread shutdown, pane cleanup, active-project fallback, Coven
polling, and workspace rendering.

- [ ] **Step 2: Type-check the TypeScript test harness**

Run:

```bash
pnpm run typecheck:tests
```

Expected: PASS with no errors from the new mock, dynamic function parameter, or
action typings.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git --no-pager diff --check HEAD~2..HEAD
git --no-pager diff --stat HEAD~2..HEAD
```

Expected: no whitespace errors; only
`native/desktop/psyche-build-tauri/web/main.js` and
`__tests__/tauriCovenSessionSiderail.test.ts` appear in the two implementation
commits.
