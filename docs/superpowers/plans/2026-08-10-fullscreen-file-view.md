# Fullscreen File View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open workspace files in the same focused-canvas presentation as a maximized pane, with the pane minimap available and Escape returning to the previous pane without closing the file tab.

**Architecture:** Keep files in the existing tab/editor model and add a transient file-focus state that records the return pane. Extend the existing pane minimap renderer to accept an active file, then route minimap clicks and Escape through the existing guarded terminal/pane focus flow.

**Tech Stack:** Vanilla JavaScript, HTML, CSS, Tauri web shell, CodeMirror, Vitest, TypeScript contract tests

---

## File map

- Modify `native/macos/psyche-build-tauri/web/main.js`: transient file-focus state, file-aware minimap model/rendering, guarded return flow, Escape handling, and active-file close behavior.
- Modify `native/macos/psyche-build-tauri/web/styles.css`: reserve the minimap column while a file owns the canvas and style the file minimap entry.
- Modify `__tests__/tauriWorkspaceEditorIntegration.test.ts`: file-focus entry, dirty guard, close, Escape, help, and CSS contracts.
- Modify `__tests__/tauriPhysicalPanes.test.ts`: minimap item modeling and return-target fallback behavior.

Implementation should run in a dedicated worktree. Do not change the pane-tree persistence format or make files pane-tree leaves.

### Task 1: Enter file focus without losing the return pane

**Files:**
- Modify: `__tests__/tauriWorkspaceEditorIntegration.test.ts:560-875`
- Modify: `native/macos/psyche-build-tauri/web/main.js:63-80`
- Modify: `native/macos/psyche-build-tauri/web/main.js:3921-4000`
- Modify: `native/macos/psyche-build-tauri/web/styles.css:1003-1018`
- Modify: `native/macos/psyche-build-tauri/web/styles.css:2177-2190`

- [ ] **Step 1: Write the failing file-focus entry tests**

Add these tests to `__tests__/tauriWorkspaceEditorIntegration.test.ts`:

```ts
it('enters file focus once and preserves the original return pane across file tabs', () => {
  const state = {
    activeFileId: null as string | null,
    activeThreadId: 'thread-a',
  };
  const fileFocus = { returnThreadId: null as string | null };
  const classes = new Set<string>();
  const minimapCalls: Array<{ layout: unknown; fileId: string }> = [];
  const layout = { root: { type: 'leaf', id: 'leaf-a', threadId: 'thread-a' } };
  const fileViewEl = { hidden: true };
  const terminalHost = { hidden: false };
  const enterFileFocus = compileFunction<
    (file: { id: string }) => void
  >(extractFunctionSource(mainJs, 'enterFileFocus'), {
    state,
    fileFocus,
    terminalArea: {
      classList: {
        add: (name: string) => classes.add(name),
      },
    },
    fileViewEl,
    terminalHost,
    activePaneLayout: () => layout,
    renderPaneMinimap: (value: unknown, file: { id: string }) => {
      minimapCalls.push({ layout: value, fileId: file.id });
    },
  });

  enterFileFocus({ id: 'file-a' });
  expect(fileFocus.returnThreadId).toBe('thread-a');
  expect(state.activeFileId).toBe('file-a');
  expect(fileViewEl.hidden).toBe(false);
  expect(terminalHost.hidden).toBe(true);
  expect(classes).toContain('is-file-focused');

  state.activeThreadId = 'thread-b';
  enterFileFocus({ id: 'file-b' });
  expect(fileFocus.returnThreadId).toBe('thread-a');
  expect(state.activeFileId).toBe('file-b');
  expect(minimapCalls).toEqual([
    { layout, fileId: 'file-a' },
    { layout, fileId: 'file-b' },
  ]);
  expect(extractFunctionSource(mainJs, 'enterFileFocus')).not.toMatch(
    /applyLayout|data\.layout|sidebar/
  );
});

it('reserves the focus-mode minimap column for the fullscreen file editor', () => {
  expect(stylesCss).toMatch(
    /\.terminal-area\.is-file-focused \.file-view\s*\{[^}]*grid-column:\s*1;/
  );
  expect(stylesCss).toMatch(
    /\.terminal-area\.is-file-focused \.pane-minimap\s*\{[^}]*grid-column:\s*2;/
  );
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspaceEditorIntegration.test.ts
```

Expected: FAIL because `enterFileFocus` and the `is-file-focused` CSS rules do not exist.

- [ ] **Step 3: Add transient file-focus state and the entry helper**

In `native/macos/psyche-build-tauri/web/main.js`, immediately after `state`, add:

```js
  // File focus is presentation-only. Open files persist through state.openFiles,
  // but the pane to return to belongs only to the current interaction.
  var fileFocus = {
    returnThreadId: null,
  };
```

Add this helper next to `findOpenFile`:

```js
  function enterFileFocus(file) {
    if (!file) return false;
    if (!state.activeFileId) {
      fileFocus.returnThreadId = state.activeThreadId || null;
    }
    state.activeFileId = file.id;
    terminalArea.classList.add("is-file-focused");
    fileViewEl.hidden = false;
    terminalHost.hidden = true;
    renderPaneMinimap(activePaneLayout(), file);
    return true;
  }
```

Change `activateFileTabNow` to use the helper:

```js
  function activateFileTabNow(id) {
    var file = findOpenFile(id);
    if (!file) return false;
    enterFileFocus(file);
    markActiveSurface("terminal");
    refreshTabs();
    renderFileView();
    return true;
  }
```

- [ ] **Step 4: Add the file-focus grid rules**

In `native/macos/psyche-build-tauri/web/styles.css`, keep the existing default file view rule and add:

```css
.terminal-area.is-file-focused .file-view {
  grid-column: 1;
}
.terminal-area.is-file-focused .pane-minimap {
  grid-column: 2;
}
```

The existing declarations remain:

```css
.file-view     { grid-row: 3; grid-column: 1 / -1; }
.pane-minimap  { grid-row: 3; grid-column: 2; }
```

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspaceEditorIntegration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add __tests__/tauriWorkspaceEditorIntegration.test.ts \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css
git commit -m "Add fullscreen file focus state" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Render the current file in the pane minimap

**Files:**
- Modify: `__tests__/tauriPhysicalPanes.test.ts:930-1075`
- Modify: `native/macos/psyche-build-tauri/web/main.js:2278-2530`
- Modify: `native/macos/psyche-build-tauri/web/styles.css:1629-1665`

- [ ] **Step 1: Write the failing minimap model test**

Add this test inside `describe('span and focus modes', ...)` in
`__tests__/tauriPhysicalPanes.test.ts`:

```ts
it('prepends the active file to the pane minimap and marks only it current', () => {
  const layout: Layout = { root: tree(), focusedLeafId: 'leaf-b' };
  const threads = new Map([
    ['thread-a', {
      id: 'thread-a', name: 'Agent', kind: 'agent',
      status: 'running', needsAttention: false,
    }],
    ['thread-b', {
      id: 'thread-b', name: 'Tests', kind: 'shell',
      status: 'running', needsAttention: true, attentionReason: 'permission',
    }],
  ]);
  const paneMinimapItems = compileFunction<
    (
      value: Layout,
      file: { id: string; name: string; rel: string } | null,
    ) => Array<Record<string, unknown>>
  >(functionSource('paneMinimapItems'), {
    scopedPaneRoot: (value: Layout) => value.root,
    PsychePanes,
    findThread: (id: string) => threads.get(id) || null,
    PsycheSessions: {
      attentionLabel: () => 'Waiting for you',
    },
  });

  const items = paneMinimapItems(layout, {
    id: 'file-a',
    name: 'Button.tsx',
    rel: 'src/Button.tsx',
  });

  expect(items).toEqual([
    {
      kind: 'file',
      id: 'file-a',
      label: 'Button.tsx',
      detail: 'src/Button.tsx',
      current: true,
      thread: null,
    },
    {
      kind: 'pane',
      id: 'thread-a',
      label: 'Agent',
      detail: 'running',
      current: false,
      thread: threads.get('thread-a'),
    },
    {
      kind: 'pane',
      id: 'thread-b',
      label: 'Tests',
      detail: 'running · Waiting for you',
      current: false,
      thread: threads.get('thread-b'),
    },
  ]);
});
```

- [ ] **Step 2: Run the pane test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriPhysicalPanes.test.ts
```

Expected: FAIL because `paneMinimapItems` does not exist.

- [ ] **Step 3: Extract a testable minimap item model**

Add this function immediately before `renderPaneMinimap` in
`native/macos/psyche-build-tauri/web/main.js`:

```js
  function paneMinimapItems(layout, activeFile) {
    var items = [];
    if (activeFile) {
      items.push({
        kind: "file",
        id: activeFile.id,
        label: activeFile.name,
        detail: activeFile.rel,
        current: true,
        thread: null,
      });
    }
    if (!layout || !layout.root) return items;

    PsychePanes.leafIds(scopedPaneRoot(layout)).forEach(function (leafId) {
      var leaf = PsychePanes.findLeafById(layout.root, leafId);
      var thread = leaf && findThread(leaf.threadId);
      if (!thread) return;
      items.push({
        kind: "pane",
        id: thread.id,
        label: thread.name,
        detail: (thread.status || "") +
          (thread.needsAttention
            ? " · " + PsycheSessions.attentionLabel(thread.attentionReason)
            : ""),
        current: !activeFile && layout.maximizedLeafId === leafId,
        thread: thread,
      });
    });
    return items;
  }
```

- [ ] **Step 4: Replace `renderPaneMinimap` with file-aware rendering**

Replace the existing function with:

```js
  function renderPaneMinimap(layout, activeFile) {
    if (!terminalArea) return;
    var rail = terminalArea.querySelector(".pane-minimap");
    if (!activeFile && (!layout || !layout.maximizedLeafId)) {
      if (rail) rail.remove();
      return;
    }
    if (!rail) {
      rail = document.createElement("aside");
      rail.className = "pane-minimap";
      rail.setAttribute("aria-label", "Pane minimap");
      terminalArea.appendChild(rail);
    }
    rail.replaceChildren();

    paneMinimapItems(layout, activeFile).forEach(function (item) {
      var entry = document.createElement("button");
      entry.type = "button";
      entry.className = "minimap-pane" + (item.current ? " is-current" : "");
      if (item.kind === "file") entry.classList.add("is-file");
      entry.title = item.kind === "file"
        ? item.detail + " · current file"
        : item.label + " — " + item.detail + " · click to focus this pane";
      entry.setAttribute("aria-label", entry.title);

      var head = document.createElement("span");
      head.className = "minimap-head";
      var glyph = document.createElement("span");
      glyph.className = "minimap-glyph";
      glyph.textContent = item.kind === "file" ? "F" : paneGlyphFor(item.thread.kind);
      var dot = document.createElement("span");
      dot.className = item.kind === "file"
        ? "minimap-dot file"
        : "minimap-dot " + sessionStatusClass(item.thread) +
          (item.thread.needsAttention ? " attention" : "");
      head.appendChild(glyph);
      head.appendChild(dot);

      var body = document.createElement("span");
      body.className = "minimap-body";
      var name = document.createElement("span");
      name.className = "minimap-name";
      name.textContent = item.label;

      entry.appendChild(head);
      entry.appendChild(body);
      entry.appendChild(name);
      if (item.kind === "file") {
        entry.addEventListener("click", restoreFileEditorFocus);
      } else {
        entry.dataset.threadId = item.thread.id;
        entry.addEventListener("click", async function () {
          var leaf = PsychePanes.findLeafByThreadId(layout.root, item.thread.id);
          if (!leaf) return;
          var previousMaximizedLeafId = layout.maximizedLeafId;
          var previousFocusedLeafId = layout.focusedLeafId;
          layout.maximizedLeafId = leaf.id;
          layout.focusedLeafId = leaf.id;
          if (state.activeFileId) {
            if (!(await focusThread(item.thread.id))) {
              layout.maximizedLeafId = previousMaximizedLeafId;
              layout.focusedLeafId = previousFocusedLeafId;
              renderPaneMinimap(layout, findOpenFile(state.activeFileId));
            }
            return;
          }
          focusThread(item.thread.id);
        });
      }
      rail.appendChild(entry);
    });
  }
```

Add the file dot style:

```css
.minimap-dot.file {
  background: var(--accent);
  box-shadow: 0 0 7px var(--accent-glow);
}
```

- [ ] **Step 5: Keep background pane renders file-aware**

In `renderPaneWorkspace`, pass the active file into the minimap renderer:

```js
    renderPaneMinimap(layout, findOpenFile(state.activeFileId));
```

This replaces:

```js
    renderPaneMinimap(layout);
```

PTY status updates and other background pane renders can occur while the editor
is visible; this keeps them from replacing the file-current minimap with the
underlying pane-current minimap.

- [ ] **Step 6: Run the pane and editor tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add __tests__/tauriPhysicalPanes.test.ts \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css
git commit -m "Show files in the pane minimap" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Return from file focus through Escape or a minimap pane

**Files:**
- Modify: `__tests__/tauriPhysicalPanes.test.ts:930-1075`
- Modify: `__tests__/tauriWorkspaceEditorIntegration.test.ts:760-875`
- Modify: `__tests__/tauriWorkspaceEditorIntegration.test.ts:1040-1080`
- Modify: `native/macos/psyche-build-tauri/web/main.js:3921-4090`
- Modify: `native/macos/psyche-build-tauri/web/main.js:5620-5680`

- [ ] **Step 1: Write the failing return-target tests**

Add this test inside the pane focus-mode describe block:

```ts
it('resolves the recorded return pane, then focused pane, then first pane', () => {
  const layout: Layout = { root: tree(), focusedLeafId: 'leaf-b' };
  const threads = new Map([
    ['thread-a', {
      id: 'thread-a', projectId: 'project', worktreePath: '/repo', hidden: false,
    }],
    ['thread-b', {
      id: 'thread-b', projectId: 'project', worktreePath: '/repo', hidden: false,
    }],
  ]);
  const project = { id: 'project' };
  const fileFocusThreadIsAvailable = compileFunction<
    (
      thread: Record<string, unknown> | null,
      root: Record<string, unknown>,
      value: typeof project,
      workspaceRoot: string,
    ) => boolean
  >(functionSource('fileFocusThreadIsAvailable'), { PsychePanes });
  const resolveFileFocusThreadId = compileFunction<
    (preferredId?: string | null) => string | null
  >(functionSource('resolveFileFocusThreadId'), {
    activeProject: () => project,
    activeWorkspaceRoot: () => '/repo',
    activePaneLayout: () => layout,
    scopedPaneRoot: (value: Layout) => value.root,
    findThread: (id: string) => threads.get(id) || null,
    PsychePanes,
    fileFocusThreadIsAvailable,
  });

  expect(resolveFileFocusThreadId('thread-a')).toBe('thread-a');
  threads.get('thread-a')!.hidden = true;
  expect(resolveFileFocusThreadId('thread-a')).toBe('thread-b');
  layout.focusedLeafId = 'leaf-missing';
  expect(resolveFileFocusThreadId('thread-a')).toBe('thread-b');
  threads.get('thread-b')!.hidden = true;
  expect(resolveFileFocusThreadId('thread-a')).toBeNull();
});
```

Add these tests to `__tests__/tauriWorkspaceEditorIntegration.test.ts`:

```ts
it('keeps file focus intact when dirty-file navigation is cancelled', async () => {
  const state = { activeFileId: 'file-a' };
  const fileFocus = { returnThreadId: 'thread-a' };
  let clearCalls = 0;
  const showTerminalView = compileFunction<() => Promise<boolean>>(
    extractFunctionSource(mainJs, 'showTerminalView'),
    {
      state,
      fileNavigationInFlight: false,
      fileDecisionInFlight: null,
      guardDirtyFile: async () => false,
      findOpenFile: () => ({ id: 'file-a', dirty: true }),
      clearFileFocusPresentation: () => { clearCalls += 1; },
      refreshTabs: () => undefined,
      requestAnimationFrame: () => undefined,
      scheduleVisiblePaneFit: () => undefined,
    },
  );

  await expect(showTerminalView()).resolves.toBe(false);
  expect(state.activeFileId).toBe('file-a');
  expect(fileFocus.returnThreadId).toBe('thread-a');
  expect(clearCalls).toBe(0);
});

it('routes Escape through guarded file return before pane maximize', () => {
  expect(mainJs).toMatch(
    /document\.addEventListener\("keydown", async function \(event\)[\s\S]*if \(state\.activeFileId\) \{[\s\S]*event\.preventDefault\(\);[\s\S]*await returnFromFileFocus\(\);[\s\S]*if \(!typing && exitPaneMaximize\(\)\)/
  );
  expect(extractFunctionSource(mainJs, 'renderPaneMinimap')).toMatch(
    /await returnFromFileFocus\(item\.thread\.id, true\)/
  );
});

it('stops dirty-dialog Escape before it reaches fullscreen file return', () => {
  expect(extractFunctionSource(mainJs, 'showFileDecision')).toMatch(
    /event\.key === "Escape"[\s\S]*event\.preventDefault\(\);[\s\S]*event\.stopPropagation\(\);[\s\S]*settle\(fallback\)/
  );
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts
```

Expected: FAIL because the return resolver, presentation clearer, async Escape branch, and guarded return function do not exist.

- [ ] **Step 3: Implement deterministic return-target resolution**

Add these functions next to `enterFileFocus`:

```js
  function fileFocusThreadIsAvailable(thread, root, project, workspaceRoot) {
    return !!thread &&
      !thread.hidden &&
      thread.projectId === project.id &&
      thread.worktreePath === workspaceRoot &&
      !!PsychePanes.findLeafByThreadId(root, thread.id);
  }

  function resolveFileFocusThreadId(preferredId) {
    var project = activeProject();
    var layout = activePaneLayout();
    if (!project || !layout || !layout.root) return null;
    var root = scopedPaneRoot(layout);
    var workspaceRoot = activeWorkspaceRoot(project);
    var preferred = preferredId ? findThread(preferredId) : null;
    if (fileFocusThreadIsAvailable(preferred, root, project, workspaceRoot)) {
      return preferred.id;
    }

    var focused = layout.focusedLeafId
      ? PsychePanes.findLeafById(root, layout.focusedLeafId)
      : null;
    var focusedThread = focused ? findThread(focused.threadId) : null;
    if (fileFocusThreadIsAvailable(focusedThread, root, project, workspaceRoot)) {
      return focusedThread.id;
    }

    var leafIds = PsychePanes.leafIds(root);
    for (var i = 0; i < leafIds.length; i++) {
      var leaf = PsychePanes.findLeafById(root, leafIds[i]);
      var thread = leaf ? findThread(leaf.threadId) : null;
      if (fileFocusThreadIsAvailable(thread, root, project, workspaceRoot)) {
        return thread.id;
      }
    }
    return null;
  }
```

- [ ] **Step 4: Implement guarded file-focus exit**

Add:

```js
  function clearFileFocusPresentation() {
    state.activeFileId = null;
    fileFocus.returnThreadId = null;
    terminalArea.classList.remove("is-file-focused");
    fileViewEl.hidden = true;
    terminalHost.hidden = false;
  }

  async function returnFromFileFocus(explicitThreadId, maximizeDestination) {
    if (!state.activeFileId) return false;
    var activeFile = findOpenFile(state.activeFileId);
    var destinationId = resolveFileFocusThreadId(
      explicitThreadId || fileFocus.returnThreadId
    );
    if (destinationId) {
      var layout = activePaneLayout();
      var leaf = layout && layout.root
        ? PsychePanes.findLeafByThreadId(layout.root, destinationId)
        : null;
      var previousMaximizedLeafId = layout ? layout.maximizedLeafId : null;
      var previousFocusedLeafId = layout ? layout.focusedLeafId : null;
      if (maximizeDestination && layout && leaf) {
        layout.maximizedLeafId = leaf.id;
        layout.focusedLeafId = leaf.id;
      }
      var focused = await focusThread(destinationId);
      if (!focused && maximizeDestination && layout) {
        layout.maximizedLeafId = previousMaximizedLeafId;
        layout.focusedLeafId = previousFocusedLeafId;
        renderPaneMinimap(layout, activeFile);
      }
      return focused;
    }
    if (!(await showTerminalView())) return false;
    renderPaneWorkspace();
    refreshSidebar();
    return true;
  }
```

Update `showTerminalView`:

```js
  async function showTerminalView() {
    if (!state.activeFileId) return true;
    if (fileNavigationInFlight || fileDecisionInFlight) return false;
    fileNavigationInFlight = true;
    var canShowTerminal;
    try {
      canShowTerminal = await guardDirtyFile(findOpenFile(state.activeFileId));
    } finally {
      fileNavigationInFlight = false;
    }
    if (!canShowTerminal) return false;
    clearFileFocusPresentation();
    refreshTabs();
    requestAnimationFrame(function () { scheduleVisiblePaneFit(); });
    return true;
  }
```

Replace the minimap pane click handler with:

```js
        entry.addEventListener("click", async function () {
          var leaf = PsychePanes.findLeafByThreadId(layout.root, item.thread.id);
          if (!leaf) return;
          if (state.activeFileId) {
            await returnFromFileFocus(item.thread.id, true);
            return;
          }
          layout.maximizedLeafId = leaf.id;
          layout.focusedLeafId = leaf.id;
          focusThread(item.thread.id);
        });
```

- [ ] **Step 5: Put file return into the Escape cascade**

First, keep the dirty decision dialog's Escape key from bubbling into the
global fullscreen-file shortcut:

```js
      bind(dirtyFileDialogEl, "keydown", function (event) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          settle(fallback);
        }
      });
```

Change the global shortcut listener to async and insert file return before pane
maximize:

```js
  document.addEventListener("keydown", async function (event) {
    var tag = (event.target && event.target.tagName ? event.target.tagName : "").toLowerCase();
    var typing = tag === "input" || tag === "textarea" || tag === "select" ||
      (event.target && event.target.isContentEditable);
    if (event.key === "Escape") {
      if (helpOverlayEl && !helpOverlayEl.hidden) { setHelpOpen(false); return; }
      var menuWasOpen = (newPaneMenuEl && !newPaneMenuEl.hidden) ||
        (scopeMenuEl && !scopeMenuEl.hidden);
      closeNewPaneMenu();
      closeScopeMenu();
      if (menuWasOpen) return;
      if (cancelSetPicking()) return;
      if (armedSessionClose) { disarmSessionClose(); return; }
      if (state.activeFileId) {
        event.preventDefault();
        await returnFromFileFocus();
        return;
      }
      if (!typing && exitPaneMaximize()) return;
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "?") { toggleHelp(); event.preventDefault(); }
  });
```

- [ ] **Step 6: Keep close behavior consistent with file focus**

In `closeFileTab`, preserve file focus when another project file remains. When
the last active file closes, clear the presentation and rebuild the pane
workspace:

```js
    var remaining = projectFiles(file.projectId);
    var next = remaining[Math.min(idx, remaining.length - 1)];
    if (next) {
      activateFileTabNow(next.id);
    } else {
      clearFileFocusPresentation();
      refreshTabs();
      renderPaneWorkspace();
    }
```

Update existing compiled `closeFileTab` tests to provide
`clearFileFocusPresentation` and `renderPaneWorkspace` dependencies instead of
direct `fileViewEl`, `terminalHost`, and fit-scheduling dependencies.

For the pending-write test, replace those dependencies with:

```ts
      clearFileFocusPresentation: () => {
        state.activeFileId = null;
      },
      renderPaneWorkspace: () => undefined,
```

Add a focused last-file close assertion:

```ts
it('restores the pane workspace after the last active file closes', async () => {
  const file = { id: 'f1', projectId: 'p1', dirty: false, savePromise: null };
  const state = { activeFileId: file.id, activeProjectId: 'p1', openFiles: [file] };
  let cleared = 0;
  let rendered = 0;
  const closeFileTab = compileFunction<
    (id: string) => Promise<boolean>
  >(extractFunctionSource(mainJs, 'closeFileTab'), {
    findOpenFile: () => file,
    fileNavigationInFlight: false,
    fileDecisionInFlight: null,
    guardDirtyFile: async () => true,
    projectFiles: () => state.openFiles,
    state,
    refreshTabs: () => undefined,
    activateFileTabNow: () => undefined,
    clearFileFocusPresentation: () => {
      cleared += 1;
      state.activeFileId = null;
    },
    renderPaneWorkspace: () => { rendered += 1; },
  });

  await expect(closeFileTab(file.id)).resolves.toBe(true);
  expect(state.openFiles).toEqual([]);
  expect(state.activeFileId).toBeNull();
  expect({ cleared, rendered }).toEqual({ cleared: 1, rendered: 1 });
});
```

- [ ] **Step 7: Run the focused tests and verify they pass**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  native/macos/psyche-build-tauri/web/main.js
git commit -m "Return safely from fullscreen files" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Document the shortcut and run the native web regression gates

**Files:**
- Modify: `__tests__/tauriWorkspaceEditorIntegration.test.ts:560-610`
- Modify: `native/macos/psyche-build-tauri/web/main.js:5590-5630`

- [ ] **Step 1: Write the failing help contract**

Add:

```ts
it('documents Escape as the way to leave a fullscreen file', () => {
  expect(mainJs).toContain('["Leave a fullscreen file", "esc"]');
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspaceEditorIntegration.test.ts
```

Expected: FAIL because the help row is absent.

- [ ] **Step 3: Add the shortcut to the native help overlay**

Add this row to `HELP_ROWS` after the save shortcut:

```js
    ["Leave a fullscreen file", "esc"],
```

- [ ] **Step 4: Run all focused native web tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriDesktopTabs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run type checking**

Run:

```bash
pnpm typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Build the native web bundles**

Run:

```bash
pnpm --filter psyche-build-tauri run build:web
```

Expected: PASS and regenerate the checked-in editor, sessions, panes, and diff
bundles without errors.

- [ ] **Step 7: Run the full test suite**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add __tests__/tauriWorkspaceEditorIntegration.test.ts \
  native/macos/psyche-build-tauri/web/main.js
git commit -m "Document fullscreen file return" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
