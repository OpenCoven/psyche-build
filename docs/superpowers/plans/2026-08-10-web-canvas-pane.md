# Web Canvas Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the outer Git/Web switch while keeping Changes/Commit and make Web a first-class tiled canvas pane beside shell and agent panes.

**Architecture:** Reuse the existing pane tree by representing the worktree browser as a non-PTY thread-like surface record with `kind: "web"`. Keep one browser record per project worktree, move the existing browser DOM surface into its active canvas pane, and retain the current per-worktree tab/history model and Tauri child-webview commands.

**Tech Stack:** Vanilla JavaScript, HTML/CSS, Tauri 2 child webviews, xterm.js, Vitest contract tests

---

## File map

- Modify `__tests__/tauriWorkspacePanels.test.ts`: define the desired dock, canvas-pane, lifecycle, and removed-band contracts.
- Modify `native/macos/psyche-build-tauri/web/index.html`: remove the top browser band and outer Git/Web controls; keep a Git-only dock and an inert browser-surface staging host.
- Modify `native/macos/psyche-build-tauri/web/main.js`: add the browser pane lifecycle, route shared pane-tree behavior through it, and remove browser-band/browser-column code.
- Modify `native/macos/psyche-build-tauri/web/styles.css`: make canvas/dock layout independent of the browser band and style Web inside a canvas pane.

### Task 1: Lock the desired structure with failing contracts

**Files:**
- Modify: `__tests__/tauriWorkspacePanels.test.ts`
- Test: `__tests__/tauriWorkspacePanels.test.ts`

- [ ] **Step 1: Replace obsolete browser-band assertions**

Add direct structural contracts:

```ts
it('keeps a Git-only dock with Changes and Commit', () => {
  expect(indexHtml).not.toContain('class="dock-tab"');
  expect(indexHtml).not.toContain('data-browser-column-toggle');
  expect(indexHtml).toContain('class="panel panel-git"');
  expect(indexHtml).toContain('data-git-tab="changes"');
  expect(indexHtml).toContain('data-git-tab="commit"');
});

it('moves Web from the top band into the canvas pane lifecycle', () => {
  expect(indexHtml).not.toContain('class="browser-band"');
  expect(indexHtml).not.toContain('id="browser-band-resize"');
  expect(indexHtml).toContain('id="browser-surface-staging"');
  expect(mainJs).toMatch(/function createBrowserPane\(/);
  expect(mainJs).toMatch(/kind:\s*"web"/);
  expect(mainJs).toMatch(/function closeBrowserPane\(/);
});
```

- [ ] **Step 2: Assert removal of obsolete layout code**

```ts
it('has no browser-band or browser-column layout state', () => {
  expect(stylesCss).not.toContain('--browser-band');
  expect(stylesCss).not.toContain('.browser-band');
  expect(mainJs).not.toContain('setBandHeight');
  expect(mainJs).not.toContain('setBrowserColumn');
  expect(mainJs).not.toContain('data-browser-column-toggle');
});
```

- [ ] **Step 3: Run the focused test and observe the expected failure**

Run: `pnpm vitest --run __tests__/tauriWorkspacePanels.test.ts`

Expected: failures report the still-present dock tabs/top browser band and missing browser-pane lifecycle.

### Task 2: Implement Web as a canvas surface

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/index.html`
- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `native/macos/psyche-build-tauri/web/styles.css`
- Test: `__tests__/tauriWorkspacePanels.test.ts`

- [ ] **Step 1: Make the HTML dock Git-only and stage Web**

Move the existing browser toolbar, tabs, and preview under:

```html
<div id="browser-surface-staging" hidden>
  <div class="browser-surface" id="browser-surface">
    <!-- retain the existing browser controls and preview elements here -->
  </div>
</div>
```

Remove the top-band wrapper, band resize separator, outer Git/Web buttons, and collapsed-rail Web button. Put `#dock-collapse` in the Git header and preserve Changes/Commit unchanged.

- [ ] **Step 2: Add one browser pane record per worktree**

Add lookup and creation beside the existing thread lifecycle:

```js
function findBrowserPane(projectId, worktreePath) {
  return state.threads.find(function (thread) {
    return thread.kind === "web" && thread.projectId === projectId &&
      thread.worktreePath === worktreePath;
  }) || null;
}

function createBrowserPane(project) {
  project = project || activeProject();
  if (!project) return null;
  var worktreePath = activeWorkspaceRoot(project);
  var existing = findBrowserPane(project.id, worktreePath);
  if (existing) {
    focusThread(existing.id);
    return existing;
  }
  var id = makeThreadId();
  var placement = preparePanePlacement(id, project.id, worktreePath);
  if (!placement) return null;
  var pane = {
    id: id, projectId: project.id, worktreePath: worktreePath,
    name: "Web", kind: "web", status: "running",
    term: null, fit: null, host: null, pane: null,
    closing: false, closeStarted: false
  };
  commitPanePlacement(placement);
  state.threads.push(pane);
  mountBrowserPane(pane);
  focusThread(id);
  return pane;
}
```

- [ ] **Step 3: Mount Web with shared pane-tree behavior**

Build Web with the existing `.terminal-pane` frame and shared span, maximize, drag, focus, and close operations. Move `#browser-surface` into its body while active. `closeBrowserPane` returns the surface to `#browser-surface-staging`, removes the leaf, and skips PTY shutdown. Update focus/render helpers so `kind: "web"` calls `markActiveSurface("browser")` and refreshes native bounds after pane-tree changes.

- [ ] **Step 4: Route browser entry points through the pane**

Make `openBlankBrowserTab`, terminal URL navigation, the new-pane Web action, and contextual Command-T create/focus the Web pane before showing or navigating a tab. Preserve restored tabs when creating a pane; add a blank tab only when none exist. A second Web action focuses the existing pane and adds a new blank tab.

- [ ] **Step 5: Simplify layout and bounds**

Use a single grid row for canvas/splitter/Git dock:

```css
.detail[data-layout="terminal"] {
  grid-template-columns: 1fr;
  grid-template-rows: 1fr;
}
.detail[data-layout="split"] {
  grid-template-columns: minmax(var(--terminal-min), var(--terminal-col))
                         var(--splitter-w)
                         minmax(var(--browser-min), 1fr);
  grid-template-rows: 1fr;
}
.browser-surface {
  display: grid;
  grid-template-rows: var(--browser-bar-h) var(--browser-tab-h) minmax(0, 1fr);
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
```

Calculate native-webview bounds only from a visible active-worktree Web pane. Remove browser-band height, browser-column toggle, and band-resize handlers.

- [ ] **Step 6: Run the focused contract**

Run: `pnpm vitest --run __tests__/tauriWorkspacePanels.test.ts`

Expected: all tests in the file pass.

### Task 3: Verify regressions and commit

**Files:**
- Modify: `docs/superpowers/plans/2026-08-10-web-canvas-pane.md`
- Verify: every file in the file map

- [ ] **Step 1: Rebuild generated pane assets**

Run: `pnpm --filter psyche-build-tauri run build:web`

Expected: esbuild emits all three web bundles without errors.

- [ ] **Step 2: Run focused browser and pane-tree contracts**

Run: `pnpm vitest --run __tests__/tauriWorkspacePanels.test.ts __tests__/tauriDesktopTabs.test.ts __tests__/paneTree.test.ts`

Expected: all selected tests pass.

- [ ] **Step 3: Run repository verification**

Run `pnpm test`, then `pnpm typecheck`, then `pnpm build`.

Expected: each exits zero with no failing tests or TypeScript errors.

- [ ] **Step 4: Review exact scope**

Run `git status --short`, `git diff --check`, `git diff --stat`, and the full diff for the five files in the file map.

Expected: only the accepted Web-pane implementation, contracts, and plan are present.

- [ ] **Step 5: Commit verified changes**

```bash
git add __tests__/tauriWorkspacePanels.test.ts \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css \
  docs/superpowers/plans/2026-08-10-web-canvas-pane.md
git commit -m "Move Web into the pane canvas"
```
