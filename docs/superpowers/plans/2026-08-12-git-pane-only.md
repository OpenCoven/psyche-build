# Git Pane-Only Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the permanent macOS Git dock and expose Changes and Commit only through one on-demand, project-scoped Git canvas pane opened with New Pane, `/git`, or `⌘G`.

**Architecture:** First promote the existing pop-out path into a project/worktree-scoped open-or-focus API while the dock remains functional. Then move all Git controls into the shared surface, wire pane-native entry points, and atomically remove dock chrome, persistence, and visibility gates so every commit remains usable.

**Tech Stack:** Tauri 2 native web shell, vanilla JavaScript/HTML/CSS, Vitest contract and extracted-function tests, pnpm, Rust formatting/tests.

---

## File Structure

- Modify `native/macos/psyche-build-tauri/web/index.html`: add New Pane → Git, move branch/remote/refresh into the shared Git surface, and replace the right dock with a hidden staging host.
- Modify `native/macos/psyche-build-tauri/web/styles.css`: style the Git toolbar, make detail canvas-only, and remove dock/splitter/right-rail rules.
- Modify `native/macos/psyche-build-tauri/web/main.js`: implement scoped open-or-focus, wire `/git` and `⌘G`, stage the closed surface, remove dock layout state, and gate async Git work by pane visibility.
- Modify `__tests__/tauriWorkspacePanels.test.ts`: cover Git ownership, single-instance lifecycle, staging, pane-only markup, refresh visibility, and legacy migration.
- Modify `__tests__/tauriAgentPicker.test.ts`: cover the Git launcher, `⌘G`, and help text.
- Modify `__tests__/tauriWorkspaceEditorIntegration.test.ts`: replace dock-visibility refresh expectations with Git-pane visibility.
- Modify `__tests__/tauriCovenLaunch.test.ts`: remove obsolete saved dock-layout fixtures and assertions.
- Verify `__tests__/tauriPhysicalPanes.test.ts` and `__tests__/tauriWebBundles.test.ts`; modify only when a real contract or generated bundle requires it.

### Task 1: Promote the existing Git pop-out to project-scoped open-or-focus

**Files:**
- Modify: `__tests__/tauriWorkspacePanels.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js`

- [ ] **Step 1: Write failing ownership and deduplication tests**

Replace the global-singleton source assertion with:

```ts
describe('Git pane ownership', () => {
  it('scopes lookup to project and worktree', () => {
    const source = functionSource('gitPaneThread');
    expect(source).toContain('thread.projectId === projectId');
    expect(source).toContain('thread.worktreePath === workspaceRoot');
    expect(source).toContain('!thread.closing');
  });

  it('focuses an existing owner before allocating a pane', () => {
    const source = functionSource('openOrFocusGitPane');
    expect(source).toMatch(/gitPaneThread\(project\.id, workspaceRoot\)/);
    expect(source).toMatch(
      /if \(existing\) \{ await focusThread\(existing\.id\); return existing; \}/,
    );
    expect(source).toContain('preparePanePlacement(id, project.id, workspaceRoot)');
  });

  it('keeps the current dock pop-out as a compatibility caller', () => {
    expect(mainJs).toMatch(
      /function popOutGitPane\(dropTarget\)[\s\S]*return openOrFocusGitPane\(dropTarget\)/,
    );
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm the expected failure**

```bash
pnpm exec vitest run __tests__/tauriWorkspacePanels.test.ts -t 'Git pane ownership'
```

Expected: FAIL because `gitPaneThread()` is global and `openOrFocusGitPane()` does not exist.

- [ ] **Step 3: Implement scoped lookup and open-or-focus without removing the dock**

```js
function gitPaneThread(projectId, workspaceRoot) {
  for (var i = 0; i < state.threads.length; i++) {
    var thread = state.threads[i];
    if (thread.kind === "git" &&
        thread.projectId === projectId &&
        thread.worktreePath === workspaceRoot &&
        !thread.closing) return thread;
  }
  return null;
}

async function openOrFocusGitPane(dropTarget) {
  var project = activeProject();
  if (!project) { setStatus("No project open", "warn"); return null; }
  var workspaceRoot = activeWorkspaceRoot(project);
  var existing = gitPaneThread(project.id, workspaceRoot);
  if (existing) { await focusThread(existing.id); return existing; }
  var id = makeThreadId();
  var placement = preparePanePlacement(id, project.id, workspaceRoot);
  if (!placement) {
    setStatus("Not enough space for another pane", "warn");
    return null;
  }
  var thread = {
    id: id, projectId: project.id, worktreePath: workspaceRoot,
    name: "Git", kind: "git", status: "", spawning: false,
    term: null, fit: null, host: null, pane: null,
    closing: false, closeStarted: false, startInFlight: false,
    stopRequested: false, ptyStarted: false,
  };
  commitPanePlacement(placement);
  state.threads.push(thread);
  if (typeof noteStatusActivity === "function") noteStatusActivity();
  mountToolPane(thread);
  if (dropTarget && dropTarget.threadId && dropTarget.position) {
    movePaneTo(id, dropTarget.threadId, dropTarget.position);
  }
  await focusThread(id);
  syncGitDockChrome();
  refreshSidebar();
  saveWorkspaceSoon();
  return thread;
}

function popOutGitPane(dropTarget) {
  return openOrFocusGitPane(dropTarget);
}
```

Update `syncGitDockChrome()` and the dock-back handler to resolve the active owner:

```js
var project = activeProject();
var thread = project
  ? gitPaneThread(project.id, activeWorkspaceRoot(project))
  : null;
```

- [ ] **Step 4: Run the entire panel and physical-pane suites**

```bash
pnpm exec vitest run __tests__/tauriWorkspacePanels.test.ts __tests__/tauriPhysicalPanes.test.ts
```

Expected: both files PASS; dock pop-out and drag/drop remain functional.

- [ ] **Step 5: Verify and commit Task 1**

```bash
git add __tests__/tauriWorkspacePanels.test.ts native/macos/psyche-build-tauri/web/main.js
git diff --cached --check
git commit -m "refactor(macos): scope Git panes to worktrees"
```

### Task 2: Move Git controls into the shared surface and add pane entry points

**Files:**
- Modify: `__tests__/tauriWorkspacePanels.test.ts`
- Modify: `__tests__/tauriAgentPicker.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/index.html`
- Modify: `native/macos/psyche-build-tauri/web/styles.css`
- Modify: `native/macos/psyche-build-tauri/web/main.js`

- [ ] **Step 1: Write failing toolbar, launcher, command, shortcut, and help tests**

```ts
expect(indexHtml).toContain('class="git-pane-toolbar"');
expect(indexHtml).toMatch(
  /id="git-surface"[\s\S]*id="git-branch"[\s\S]*id="git-open-remote"[\s\S]*id="git-refresh"/,
);
expect(indexHtml).toMatch(
  /id="new-pane-git"[\s\S]*Git — changes and commits[\s\S]*<span class="new-pane-key">⌘G<\/span>/,
);
expect(mainJs).toMatch(
  /onMenuClick\("new-pane-git", async function \(\)[\s\S]*openOrFocusGitPane\(\)/,
);
expect(mainJs).toMatch(
  /cmd: "\/git",[\s\S]*desc: "Open or focus the Git pane"[\s\S]*openOrFocusGitPane\(\)/,
);
expect(mainJs).toMatch(
  /String\(e\.key\)\.toLowerCase\(\) === "g"[\s\S]*await openOrFocusGitPane\(\)/,
);
expect(mainJs).toMatch(/\["Open or focus Git", "⌘G"\]/);
```

- [ ] **Step 2: Run launcher tests and verify they fail**

```bash
pnpm exec vitest run __tests__/tauriWorkspacePanels.test.ts __tests__/tauriAgentPicker.test.ts -t 'Git|launch|shortcut'
```

Expected: FAIL because the toolbar controls remain in the dock header and pane-native entry points are absent.

- [ ] **Step 3: Move branch/remote/refresh controls inside `#git-surface`**

Move the existing controls; do not copy them. The beginning of the shared surface becomes:

```html
<div class="panel-body panel-git-body" id="git-surface">
  <div class="git-pane-toolbar" role="toolbar" aria-label="Git actions">
    <span class="panel-crumb" id="git-branch"></span>
    <button id="git-open-remote" class="icon-btn ghost-btn"
            title="Open repository on GitHub" aria-label="Open repository on GitHub" disabled>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6.25 3.5H3.9c-.9 0-1.6.7-1.6 1.6v6c0 .9.7 1.6 1.6 1.6h6c.9 0 1.6-.7 1.6-1.6V8.75" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><path d="M9.25 2.75h4v4M13.25 2.75 7.75 8.25" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button id="git-refresh" class="icon-btn ghost-btn" title="Refresh" aria-label="Refresh git state">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M12.2 6.2A4.6 4.6 0 1 0 12.6 9" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round"/><path d="M12.25 3.8v2.7h-2.7" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>
  <div class="sidebar-tabs dock-tabs-segmented" role="tablist" aria-label="Git sections">
```

```css
.git-pane-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 30px;
  padding: 2px 4px 2px 8px;
  border-bottom: 1px solid var(--border);
  background: rgba(var(--rgb-deep), calc(var(--bg-opacity) * 0.86));
}
```

- [ ] **Step 4: Add New Pane → Git, `/git`, `⌘G`, and help text**

Insert after Browser in the New Pane menu:

```html
<button id="new-pane-git" class="new-pane-item" type="button" role="menuitem">
  <span class="new-pane-glyph">⑂</span>Git — changes and commits<span class="new-pane-key">⌘G</span>
</button>
```

Wire every entry point through `openOrFocusGitPane()`:

```js
onMenuClick("new-pane-git", async function () {
  closeNewPaneMenu();
  await openOrFocusGitPane();
});

{
  cmd: "/git",
  desc: "Open or focus the Git pane",
  run: function () { return openOrFocusGitPane(); },
},

if (String(e.key).toLowerCase() === "g" && !e.altKey && !e.shiftKey) {
  e.preventDefault();
  await openOrFocusGitPane();
  return;
}
```

Add `["Open or focus Git", "⌘G"]` to `HELP_ROWS`. Keep the old dock entry points in this task; Task 3 removes them atomically with the dock.

- [ ] **Step 5: Run focused suites and commit Task 2**

```bash
pnpm exec vitest run __tests__/tauriWorkspacePanels.test.ts __tests__/tauriAgentPicker.test.ts __tests__/tauriPhysicalPanes.test.ts
git diff --check
git add __tests__/tauriWorkspacePanels.test.ts __tests__/tauriAgentPicker.test.ts native/macos/psyche-build-tauri/web/index.html native/macos/psyche-build-tauri/web/styles.css native/macos/psyche-build-tauri/web/main.js
git diff --cached --check
git commit -m "feat(macos): open Git as a canvas pane"
```

Expected: all three files PASS and both old dock launch plus new pane launch remain usable.

### Task 3: Atomically remove dock chrome, state, and visibility gates

**Files:**
- Modify: `__tests__/tauriWorkspacePanels.test.ts`
- Modify: `__tests__/tauriAgentPicker.test.ts`
- Modify: `__tests__/tauriWorkspaceEditorIntegration.test.ts`
- Modify: `__tests__/tauriCovenLaunch.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/index.html`
- Modify: `native/macos/psyche-build-tauri/web/styles.css`
- Modify: `native/macos/psyche-build-tauri/web/main.js`

- [ ] **Step 1: Write failing pane-only shell, migration, and request-ownership tests**

```ts
expect(indexHtml).not.toContain('class="git-dock dock"');
expect(indexHtml).not.toContain('id="splitter"');
expect(indexHtml).not.toContain('id="rail-right"');
expect(indexHtml).not.toContain('id="dock-collapse"');
expect(indexHtml).not.toContain('id="git-pop-out"');
expect(indexHtml).not.toContain('id="git-dock-back"');
expect(indexHtml).not.toContain('data-dock=');
expect(indexHtml).not.toContain('data-panel=');
expect(indexHtml).toMatch(/id="git-surface-staging"[\s\S]*id="git-surface"/);
expect(indexHtml.match(/id="git-surface"/g)).toHaveLength(1);

for (const token of ['.git-dock', '.dock-mini', '.dock-collapse', '--split-frac', '--terminal-col']) {
  expect(stylesCss).not.toContain(token);
}
expect(functionSource('persistableProject')).not.toContain('layout:');
expect(functionSource('sanitizeSavedProject')).not.toContain('saved.layout');
expect(mainJs).not.toContain('applyLayout');
expect(mainJs).not.toContain('toggleDock');
expect(mainJs).not.toContain('panelIsVisible');
expect(mainJs).not.toContain('cmd: "/split"');
expect(mainJs).not.toMatch(/e\.key === "\\\\"/);
expect(mainJs).not.toMatch(/e\.code === "KeyB" && e\.altKey/);

const visible = functionSource('gitPaneIsVisible');
expect(visible).toContain('gitPaneThread(project.id, workspaceRoot)');
expect(visible).toContain('canvasThreadIds().indexOf(thread.id) !== -1');
expect(functionSource('currentDiffRequestMatches')).toContain('gitPaneIsVisible(project)');
```

Update editor tests to inject `gitPaneIsVisible` instead of `currentLayout`/`currentPanel`. Remove `layout` from saved-project fixtures in `tauriCovenLaunch.test.ts` and assert sanitized projects do not gain it.

- [ ] **Step 2: Run the affected suites and confirm the expected failures**

```bash
pnpm exec vitest run __tests__/tauriWorkspacePanels.test.ts __tests__/tauriAgentPicker.test.ts __tests__/tauriWorkspaceEditorIntegration.test.ts __tests__/tauriCovenLaunch.test.ts
```

Expected: FAIL on dock markup/state, legacy layout persistence, and panel-based diff visibility.

- [ ] **Step 3: Replace visible dock markup with neutral staging and canvas-only CSS**

Remove `data-dock` from `#app`, remove `data-layout`/`data-panel` from `#detail`, and delete `.git-dock`, `#splitter`, and `#rail-right`. Move the one complete `#git-surface` subtree under:

```html
<div id="git-surface-staging" hidden>
  <!-- The existing complete #git-surface subtree is moved here once. -->
</div>
```

Do not leave the explanatory comment in production. The staging host is outside `main.detail`, has no chrome or geometry, and is hidden only while it owns the surface.

```css
.detail {
  display: block;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}
.terminal-area { width: 100%; height: 100%; min-width: 0; min-height: 0; }
#git-surface-staging[hidden] { display: none; }
```

Delete canvas-versus-dock selectors and variables, but retain `.terminal-pane-split`, diff Split/Stacked styling, and pane divider rules.

- [ ] **Step 4: Remove dock state and introduce staged, pane-visible refresh ownership**

```js
var gitSurfaceEl = document.getElementById("git-surface");
var gitSurfaceStagingEl = document.getElementById("git-surface-staging");

function stageGitSurface() {
  if (gitSurfaceEl && gitSurfaceStagingEl &&
      gitSurfaceEl.parentElement !== gitSurfaceStagingEl) {
    gitSurfaceStagingEl.appendChild(gitSurfaceEl);
  }
}

function gitPaneIsVisible(project) {
  project = project || activeProject();
  if (!project || project.id !== state.activeProjectId) return false;
  var workspaceRoot = activeWorkspaceRoot(project);
  var thread = gitPaneThread(project.id, workspaceRoot);
  return !!thread && !thread.hidden && !thread.closing &&
    canvasThreadIds().indexOf(thread.id) !== -1;
}

function renderGitSurface() {
  var project = activeProject();
  if (!gitPaneIsVisible(project)) {
    suspendDiffRequests();
    return false;
  }
  renderGitPanel();
  renderDiffsPanel();
  return true;
}
```

Call `stageGitSurface()` before `detachThreadPane()` in `closeToolPane()`, change its close label to `Close Git pane`, and remove return-to-dock behavior. Call `renderGitSurface()` after open/focus and active project/worktree canvas switches.

Remove `PANELS`, aliases, split-fraction/project-layout helpers, dock button syncing, dock drag/drop, the canvas-versus-dock splitter handlers, and their DOM refs. `persistableProject()` omits `layout`; `sanitizeSavedProject()` ignores old `saved.layout`, which performs the legacy migration without auto-opening Git. Remove calls from project activation, file reveal, add-project, boot, and browser commands.

Replace every `panelIsVisible("diffs")` request guard with `gitPaneIsVisible(project)` using the request's captured project. After file save, use `renderGitSurface()` when the edited project/worktree is active. Rename `setDockGitCount()` to `setGitChangesCount()` and update only `#git-changes-count`.

Delete `/split`, `⌘\\`, `⌘⌥B`, and the old dock help row. Update `/preview` and `/browser-tab` to use their existing browser-pane paths without `applyLayout("split")`; make `/terminal` call `showTerminalView()`.

- [ ] **Step 5: Run all affected suites and commit Task 3**

```bash
pnpm exec vitest run \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriPhysicalPanes.test.ts
git diff --check
git add __tests__/tauriWorkspacePanels.test.ts __tests__/tauriAgentPicker.test.ts __tests__/tauriWorkspaceEditorIntegration.test.ts __tests__/tauriCovenLaunch.test.ts native/macos/psyche-build-tauri/web/index.html native/macos/psyche-build-tauri/web/styles.css native/macos/psyche-build-tauri/web/main.js
git diff --cached --check
git commit -m "refactor(macos): remove Git dock state"
```

Expected: all five files PASS and the app has only the pane-native Git path.

### Task 4: Complete regression, build, and exact-build acceptance

**Files:**
- Modify only if a real stale contract is exposed: `__tests__/tauriPhysicalPanes.test.ts`
- Modify only if regeneration changes them: `native/macos/psyche-build-tauri/web/*.bundle.js`

- [ ] **Step 1: Prove dead dock terms are gone without removing valid pane/diff splits**

```bash
rg -n 'git-dock|rail-right|dock-collapse|git-pop-out|git-dock-back|toggleDock|panelIsVisible|currentPanel|applyLayout|splitFrac|splitter-w|Toggle the tools dock|⌘⌥B|cmd: "/split"' \
  native/macos/psyche-build-tauri/web __tests__/tauri*.test.ts
```

Expected: no matches. Diff layout “Split” and pane-tree split functions remain valid.

- [ ] **Step 2: Run focused native UI regression**

```bash
pnpm exec vitest run \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWebBundles.test.ts
```

Expected: all files PASS.

- [ ] **Step 3: Run repository-wide verification**

Run separately; stop at the first failure:

```bash
pnpm typecheck
pnpm --filter psyche-build-tauri run build:web
pnpm test
pnpm build
cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml -- --check
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
git diff --check
```

Expected: all commands exit 0, with zero Vitest/Rust failures. If `build:web` changes committed bundles, rerun `__tests__/tauriWebBundles.test.ts` before staging them.

- [ ] **Step 4: Run exact-build manual acceptance without disturbing another worktree**

```bash
ps -axo pid=,command= | rg 'Psyche Build|psyche-build-tauri|target/(debug|release)/psyche'
```

Do not stop a process owned by another worktree. Launch this worktree's verified build only when ownership and app path are unambiguous, then confirm:

1. Canvas fills the former right-panel width; no rail, splitter, or reserved column remains.
2. New Pane → Git creates one pane; `⌘G`, `/git`, and repeated opens focus it.
3. Changes/Commit, branch, refresh, remote link, count, diffs, and history work.
4. Git moves, resizes, spans, maximizes, closes, and reopens like Shell/Web.
5. A second project/worktree owns its own Git pane and never shows another owner's data.
6. No-project and full-canvas failures warn without mutating the pane tree.

- [ ] **Step 5: Commit only legitimate verification output and prove branch hygiene**

If no files changed, do not create an empty commit. If tests or bundle generation required updates:

```bash
git add __tests__/tauriPhysicalPanes.test.ts native/macos/psyche-build-tauri/web/*.bundle.js
git diff --cached --check
pnpm exec vitest run __tests__/tauriPhysicalPanes.test.ts __tests__/tauriWebBundles.test.ts
git commit -m "test(macos): verify pane-only Git workspace"
```

Then:

```bash
git status --short --branch
git log --format='%h %G? %s' origin/main..HEAD
```

Expected: clean worktree and `G` for every commit.
