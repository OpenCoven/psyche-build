# Project Files Sidebar Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the global Sessions/Files switcher with project-scoped Files drill-in navigation and a full-width New Session button.

**Architecture:** Keep the existing session tree and file tree, but place them behind transient `sessions` and `files` sidebar views rather than persisted tabs. Project headers initiate Files navigation for their selected worktree; Back restores Sessions and focus, while a request-generation guard prevents stale asynchronous file listings.

**Tech Stack:** Browser JavaScript, semantic HTML, CSS, Vitest, TypeScript test harness, Tauri filesystem commands.

---

## File structure

- Modify: `native/desktop/psyche-build-tauri/web/index.html` — remove sidebar tabs, label and widen New Session, and add Back to Sessions.
- Modify: `native/desktop/psyche-build-tauri/web/styles.css` — style the full-width trigger, project Files action, and Files drill-in subbar.
- Modify: `native/desktop/psyche-build-tauri/web/main.js` — remove persisted tab state, add transient sidebar navigation, project Files actions, focus restoration, zero-session project retention, and stale request guards.
- Modify: `__tests__/tauriWorkspaceRail.test.ts` — update shell/settings contracts and assert project-scoped navigation wiring.
- Modify: `__tests__/tauriWorkspacePanels.test.ts` — replace global Files-tab expectations with the project drill-in contract.
- Create: `__tests__/tauriProjectFilesSidebar.test.ts` — behavior-test navigation, focus restoration, activation failure, and file request scope.

### Task 1: Replace the global tab chrome with transient sidebar views

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/index.html:59-133`
- Modify: `native/desktop/psyche-build-tauri/web/styles.css:228-334`
- Modify: `native/desktop/psyche-build-tauri/web/main.js:990-1060`
- Modify: `native/desktop/psyche-build-tauri/web/main.js:5420-5470`
- Modify: `native/desktop/psyche-build-tauri/web/main.js:7790-7805`
- Modify: `__tests__/tauriWorkspaceRail.test.ts:92-170`
- Modify: `__tests__/tauriWorkspaceRail.test.ts:480-530`
- Modify: `__tests__/tauriWorkspacePanels.test.ts:130-175`

- [ ] **Step 1: Write failing shell and settings assertions**

Update the native-shell test in `__tests__/tauriWorkspaceRail.test.ts` to assert:

```ts
    expect(indexHtml).not.toContain('aria-label="Sidebar sections"');
    expect(indexHtml).not.toContain('data-sidebar-tab=');
    expect(indexHtml).not.toContain('Sessions</span>');
    expect(indexHtml).toMatch(
      /id="rail-new-tab"[\s\S]*?>\s*New Session\s*<\/button>/,
    );
    expect(indexHtml).toMatch(
      /id="files-back"[^>]*aria-label="Back to Sessions"[^>]*>\s*‹ Sessions\s*<\/button>/,
    );
    expect(ruleBlock(styles, '.sidebar-head .rail-btn')).toMatch(/width:\s*100%;/);
```

Replace the sidebar settings assertions with:

```ts
    expect(mainJs).not.toContain('settings.sidebarTab');
    expect(mainJs).not.toContain('saved.sidebarTab');
    expect(mainJs).toContain('var sidebarView = "sessions";');
    expect(mainJs).toContain('setSidebarView("sessions");');
    expect(loadSettingsSource).not.toContain('sidebarTab');
    expect(saveSettingsSource).not.toContain('sidebarTab');
```

Update the Files placement assertions in `__tests__/tauriWorkspacePanels.test.ts`:

```ts
    const sidebar = indexHtml.slice(
      indexHtml.indexOf('class="rail sidebar"'),
      indexHtml.indexOf('</aside>'),
    );
    expect(sidebar).not.toContain('data-sidebar-tab=');
    expect(sidebar).toContain('id="files-back"');
    expect(sidebar).toContain('id="file-tree"');
```

- [ ] **Step 2: Run the focused tests to verify the old tab UI fails**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriWorkspacePanels.test.ts
```

Expected: FAIL because the global tablist, persisted `sidebarTab`, icon-only trigger, and missing Back control still reflect the old design.

- [ ] **Step 3: Replace the sidebar markup**

In `index.html`, remove the `sidebar-tabs` block. Keep `sidebar-controls`, but change its contents to:

```html
          <div class="sidebar-controls" id="sidebar-session-controls">
            <div class="sidebar-head">
              <button
                id="rail-new-tab"
                class="rail-btn new-session-button"
                type="button"
                title="Create a new session (t / a / w)"
                aria-label="Create a new session"
                aria-haspopup="menu"
                aria-expanded="false"
                aria-controls="new-pane-menu"
              >New Session</button>
            </div>

            <div class="session-filter-row" role="toolbar" aria-label="Filter sessions">
              <button class="session-filter is-active" type="button" data-session-filter="all" aria-pressed="true">All</button>
              <button class="session-filter" type="button" data-session-filter="agents" aria-pressed="false">Agents</button>
              <button class="session-filter" type="button" data-session-filter="shells" aria-pressed="false">Shells</button>
              <button class="session-filter" type="button" data-session-filter="active" aria-pressed="false">Active</button>
              <button class="session-filter" type="button" data-session-filter="attention" aria-pressed="false">Attention</button>
            </div>
          </div>
```

Change the Files subbar to:

```html
            <div class="sidebar-subbar">
              <button id="files-back" class="sidebar-back-button" type="button"
                      aria-label="Back to Sessions">‹ Sessions</button>
              <span class="panel-crumb" id="files-crumb"></span>
              <button id="files-refresh" class="icon-btn ghost-btn" title="Refresh"
                      aria-label="Refresh file tree">
                <!-- retain the existing refresh SVG -->
              </button>
            </div>
```

- [ ] **Step 4: Remove persisted tab settings and add the transient view seam**

Delete `sidebarTab` from `loadSettings` defaults, parsed settings, and `saveSettings`.

Replace the existing `sidebarTab` variable, `setSidebarTab`, and `[data-sidebar-tab]` listener block with:

```js
  var sidebarSessionControlsEl = document.getElementById("sidebar-session-controls");
  var sidebarView = "sessions";
  var sidebarFilesReturnProjectId = null;

  function setSidebarView(name) {
    sidebarView = name === "files" ? "files" : "sessions";
    var showingFiles = sidebarView === "files";
    if (sidebarSessionControlsEl) sidebarSessionControlsEl.hidden = showingFiles;
    if (sessionListEl) sessionListEl.hidden = showingFiles;
    if (sidebarFilesEl) sidebarFilesEl.hidden = !showingFiles;
    if (showingFiles) {
      closeNewPaneMenu();
      renderFilesPanel();
    }
    return sidebarView;
  }
```

Replace startup restoration:

```js
  setSidebarView("sessions");
```

- [ ] **Step 5: Update the sidebar styles**

Replace the square-button rule with:

```css
.sidebar-head .rail-btn {
  width: 100%;
  height: 34px;
  border-radius: 8px;
}
.new-session-button {
  border: 1px solid var(--accent-line);
  background: var(--accent-soft);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  font-weight: 650;
}
.sidebar-controls[hidden] { display: none; }
.sidebar-back-button {
  flex: none;
  border: 0;
  border-radius: 6px;
  padding: 4px 6px;
  background: transparent;
  color: var(--text-soft);
  font: inherit;
  font-size: 11px;
}
.sidebar-back-button:hover { background: var(--surface-2); color: var(--text); }
.sidebar-back-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
```

Retain the generic `.sidebar-tabs` and `.sidebar-tab` rules because the Git Changes/Commit segmented control still uses them.

- [ ] **Step 6: Run the chrome/settings tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriWorkspacePanels.test.ts
```

Expected: PASS for the removed sidebar tabs, transient startup view, Back markup, and full-width New Session control.

- [ ] **Step 7: Commit the sidebar shell**

```bash
git add \
  native/desktop/psyche-build-tauri/web/index.html \
  native/desktop/psyche-build-tauri/web/styles.css \
  native/desktop/psyche-build-tauri/web/main.js \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriWorkspacePanels.test.ts
git commit \
  -m "refactor: replace Files sidebar tabs" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Add project-scoped Files navigation and focus restoration

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/main.js:6728-6820`
- Modify: `native/desktop/psyche-build-tauri/web/main.js:7090-7270`
- Modify: `native/desktop/psyche-build-tauri/web/main.js:11080-11110`
- Modify: `native/desktop/psyche-build-tauri/web/styles.css:334-430`
- Modify: `__tests__/tauriWorkspaceRail.test.ts`
- Create: `__tests__/tauriProjectFilesSidebar.test.ts`

- [ ] **Step 1: Create failing navigation behavior tests**

Create `__tests__/tauriProjectFilesSidebar.test.ts` with this header and extraction harness:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const mainJs = readFileSync(
  join(process.cwd(), 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
);

function functionSource(name: string) {
  const asyncStart = mainJs.indexOf(`async function ${name}(`);
  const syncStart = mainJs.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = mainJs.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainJs.length; index += 1) {
    if (mainJs[index] === '{') depth += 1;
    if (mainJs[index] === '}') depth -= 1;
    if (depth === 0) return mainJs.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function compileFunction<T extends (...args: never[]) => unknown>(
  name: string,
  dependencies: Record<string, unknown>,
) {
  return Function(
    ...Object.keys(dependencies),
    `"use strict"; return (${functionSource(name)});`,
  )(...Object.values(dependencies)) as T;
}

describe('project Files sidebar navigation', () => {
});
```

Inside that `describe`, add:

```ts
  it('enters Files only after the requested project activates', async () => {
    const project = {
      id: 'project-a',
      name: 'Project A',
      selectedWorktreePath: '/repo/worktree-a',
    };
    const views: string[] = [];
    const showProjectFiles = compileFunction<
      (projectId: string) => Promise<boolean>
    >('showProjectFiles', {
      findProject: (id: string) => id === project.id ? project : null,
      setActiveProject: async () => true,
      state: { activeProjectId: project.id },
      setSidebarView: (view: string) => { views.push(view); },
      sidebarFilesReturnProjectId: null,
    });

    await expect(showProjectFiles(project.id)).resolves.toBe(true);
    expect(project.selectedWorktreePath).toBe('/repo/worktree-a');
    expect(views).toEqual(['files']);
  });

  it('stays on Sessions when project activation fails', async () => {
    const project = { id: 'project-a', selectedWorktreePath: '/repo' };
    const views: string[] = [];
    const showProjectFiles = compileFunction<
      (projectId: string) => Promise<boolean>
    >('showProjectFiles', {
      findProject: () => project,
      setActiveProject: async () => false,
      state: { activeProjectId: null },
      setSidebarView: (view: string) => { views.push(view); },
      sidebarFilesReturnProjectId: null,
    });

    await expect(showProjectFiles(project.id)).resolves.toBe(false);
    expect(views).toEqual([]);
  });
```

Add source-contract assertions:

```ts
  it('renders one isolated Files action in every project header', () => {
    const createProjectGroup = functionSource('createProjectGroup');
    const renderSessionList = functionSource('renderSessionList');

    expect(createProjectGroup).toContain('session-project-files');
    expect(createProjectGroup).toContain('files.dataset.projectFiles = projectModel.project.id');
    expect(createProjectGroup).toContain('"Browse files in " + projectModel.title');
    expect(renderSessionList).toContain('event.stopPropagation()');
    expect(renderSessionList).toContain('showProjectFiles(project.id)');
    expect(renderSessionList).not.toContain('if (projectModel.visibleCount === 0) return;');
  });
```

- [ ] **Step 2: Run the new test to verify project navigation is absent**

Run:

```bash
pnpm vitest --run __tests__/tauriProjectFilesSidebar.test.ts
```

Expected: FAIL because `showProjectFiles` and the project-header Files action do not exist.

- [ ] **Step 3: Render and return the project Files action**

In `createProjectGroup`, append this button after the count:

```js
    var files = document.createElement("button");
    files.type = "button";
    files.className = "session-project-files";
    files.dataset.projectFiles = projectModel.project.id;
    files.textContent = "Files";
    files.setAttribute("aria-label", "Browse files in " + projectModel.title);
    head.appendChild(files);
```

Return it from the helper:

```js
    return {
      group: group,
      head: head,
      disclosure: disclosure,
      files: files,
      children: children,
    };
```

Style it:

```css
.session-project-files {
  flex: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 3px 6px;
  background: var(--surface-2);
  color: var(--text-soft);
  font: inherit;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
}
.session-project-files:hover { border-color: var(--accent-line); color: var(--text); }
.session-project-files:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
```

- [ ] **Step 4: Keep every project group and wire isolated navigation**

In `renderSessionList`, remove:

```js
      if (projectModel.visibleCount === 0) return;
```

After the project disclosure listener, add:

```js
      projectParts.files.addEventListener("pointerdown", function (event) {
        event.stopPropagation();
      });
      projectParts.files.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        showProjectFiles(project.id);
      });
```

This keeps session filters applied to branches/rows while preserving each project header and Files action.

- [ ] **Step 5: Add Files entry and Back navigation**

Add:

```js
  async function showProjectFiles(projectId) {
    var project = findProject(projectId);
    if (!project) return false;
    if (!(await setActiveProject(projectId))) return false;
    project = findProject(projectId);
    if (!project || state.activeProjectId !== project.id) return false;
    sidebarFilesReturnProjectId = project.id;
    setSidebarView("files");
    return true;
  }

  function showSessionsSidebar() {
    var restoreProjectId = sidebarFilesReturnProjectId;
    sidebarFilesReturnProjectId = null;
    setSidebarView("sessions");
    renderSessionList({ preserveFocus: false });
    requestAnimationFrame(function () {
      var buttons = sessionListEl
        ? sessionListEl.querySelectorAll("[data-project-files]")
        : [];
      var target = Array.prototype.find.call(buttons, function (button) {
        return button.dataset.projectFiles === restoreProjectId;
      });
      if (target) target.focus();
      else restoreSessionTreeFocus("");
    });
    return true;
  }
```

Wire Back with the other rail actions:

```js
  onRailClick("files-back", function () { showSessionsSidebar(); });
```

- [ ] **Step 6: Test focus restoration and fallback**

Add to `__tests__/tauriProjectFilesSidebar.test.ts` a small harness around `showSessionsSidebar` with fake `sessionListEl.querySelectorAll`, `requestAnimationFrame`, `setSidebarView`, and `restoreSessionTreeFocus`. Assert the matching `data-project-files` button receives `focus()`, and a missing project calls `restoreSessionTreeFocus("")`.

Use this exact assertion shape:

```ts
    expect(views).toEqual(['sessions']);
    expect(origin.focus).toHaveBeenCalledTimes(1);
    expect(restoreTreeFocus).not.toHaveBeenCalled();
```

Then run:

```bash
pnpm vitest --run \
  __tests__/tauriProjectFilesSidebar.test.ts \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: PASS, including existing session-tree rendering and navigation coverage.

- [ ] **Step 7: Commit project Files navigation**

```bash
git add \
  native/desktop/psyche-build-tauri/web/main.js \
  native/desktop/psyche-build-tauri/web/styles.css \
  __tests__/tauriProjectFilesSidebar.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
git commit \
  -m "feat: browse Files from project headers" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Guard project file listings against stale scopes

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/main.js:894-950`
- Modify: `native/desktop/psyche-build-tauri/web/main.js:11610-11630`
- Modify: `__tests__/tauriProjectFilesSidebar.test.ts`

- [ ] **Step 1: Write failing request-scope tests**

Add a harness for the request helpers:

```ts
  it('accepts only the current Files project and worktree request', () => {
    const project = { id: 'project-a', selectedWorktreePath: '/repo/a' };
    const requestMatches = compileFunction<
      (generation: number, projectId: string, workspaceRoot: string) => boolean
    >('filesPanelRequestMatches', {
      sidebarView: 'files',
      filesPanelGeneration: 4,
      activeProject: () => project,
      activeWorkspaceRoot: () => project.selectedWorktreePath,
    });

    expect(requestMatches(4, project.id, '/repo/a')).toBe(true);
    expect(requestMatches(3, project.id, '/repo/a')).toBe(false);
    expect(requestMatches(4, 'project-b', '/repo/a')).toBe(false);
    expect(requestMatches(4, project.id, '/repo/b')).toBe(false);
  });
```

Add source assertions:

```ts
    const renderFilesPanel = functionSource('renderFilesPanel');
    expect(renderFilesPanel).toContain('var generation = ++filesPanelGeneration;');
    expect(renderFilesPanel).toContain(
      'if (!filesPanelRequestMatches(generation, project.id, workspaceRoot)) return false;',
    );
    expect(functionSource('showSessionsSidebar')).toContain('invalidateFilesPanelRender();');
    expect(functionSource('setActiveProject')).toContain(
      'if (sidebarView === "files") renderFilesPanel();',
    );
```

- [ ] **Step 2: Run the scope test to verify stale requests are unguarded**

Run:

```bash
pnpm vitest --run __tests__/tauriProjectFilesSidebar.test.ts
```

Expected: FAIL because the generation helpers and post-read scope check do not exist.

- [ ] **Step 3: Add request invalidation and matching helpers**

Near the file-tree state, add:

```js
  var filesPanelGeneration = 0;

  function invalidateFilesPanelRender() {
    filesPanelGeneration += 1;
    return filesPanelGeneration;
  }

  function filesPanelRequestMatches(generation, projectId, workspaceRoot) {
    var project = activeProject();
    return sidebarView === "files" &&
      generation === filesPanelGeneration &&
      !!project &&
      project.id === projectId &&
      activeWorkspaceRoot(project) === workspaceRoot;
  }
```

At the start of `showSessionsSidebar`, call:

```js
    invalidateFilesPanelRender();
```

- [ ] **Step 4: Guard file-tree rendering**

Change `renderFilesPanel` to:

```js
  async function renderFilesPanel() {
    if (!fileTreeEl) return false;
    var generation = ++filesPanelGeneration;
    var project = activeProject();
    if (!project) {
      panelMessage(fileTreeEl, "No project open — ⌘O to add one.");
      return false;
    }
    var workspaceRoot = activeWorkspaceRoot(project);
    if (filesCrumbEl) filesCrumbEl.textContent = shortenRoot(workspaceRoot);
    var fileRows = [];
    await appendDirInto(fileRows, workspaceRoot, workspaceRoot, 0);
    if (!filesPanelRequestMatches(generation, project.id, workspaceRoot)) return false;
    renderedFileRows = fileRows;
    renderFileRows(fileRows);
    if (!fileTreeEl.firstChild) panelMessage(fileTreeEl, "Empty directory.");
    return true;
  }
```

At the end of both `setActiveProject` and `activateProjectWorktree`, after their project/worktree state is final, add:

```js
    if (sidebarView === "files") renderFilesPanel();
```

- [ ] **Step 5: Run the complete focused sidebar and Files suite**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriProjectFilesSidebar.test.ts \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWorkspaceFilesPane.test.ts \
  __tests__/tauriWorkspaceFilesPaneView.test.ts \
  __tests__/tauriWorkspaceFilesPaneLifecycle.test.ts
```

Expected: PASS. Existing file opening, Files pane lifecycle, session filtering, and tree behavior remain intact.

- [ ] **Step 6: Type-check and inspect the final implementation**

Run:

```bash
pnpm typecheck:tests
git --no-pager diff --check -- \
  native/desktop/psyche-build-tauri/web/index.html \
  native/desktop/psyche-build-tauri/web/styles.css \
  native/desktop/psyche-build-tauri/web/main.js \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriProjectFilesSidebar.test.ts
git --no-pager diff --stat
```

Expected: type-check and whitespace checks exit `0`; only the approved sidebar navigation and tests changed.

- [ ] **Step 7: Commit stale-request protection**

```bash
git add \
  native/desktop/psyche-build-tauri/web/main.js \
  __tests__/tauriProjectFilesSidebar.test.ts
git commit \
  -m "fix: scope project Files requests" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
