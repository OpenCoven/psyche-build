# Persistent Dock Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the expanded Files/Git/Web dock tabs and keep the icon-only right rail visible for panel switching and collapse.

**Architecture:** The existing `#rail-right` toolbar becomes the single panel selector in both open and collapsed dock states. HTML drops the duplicate top selector, CSS permanently reserves the rail column and gives the dock content its full height, and JavaScript stops hiding the rail while preserving the existing active-icon collapse behavior.

**Tech Stack:** Static HTML, CSS Grid, browser JavaScript, Vitest source-contract tests, esbuild

---

## File structure

- Modify `native/macos/psyche-build-tauri/web/index.html`: remove `.dock-tabs`, keep Files/Git/Web controls in `#rail-right`, move the Git count badge into the rail, and remove the rail's initial `hidden` state.
- Modify `native/macos/psyche-build-tauri/web/styles.css`: always reserve the right-rail column, collapse the dock grid to one row, place panels in that row, and style the Git count badge on the rail.
- Modify `native/macos/psyche-build-tauri/web/main.js`: stop hiding `#rail-right` when the dock opens and remove the deleted top collapse-button binding.
- Modify `__tests__/tauriWorkspacePanels.test.ts`: lock the single-selector markup, persistent rail, and Git badge location.
- Modify `__tests__/tauriWorkspaceEditorIntegration.test.ts`: lock `syncDockChrome` and the existing active-icon collapse behavior.
- Regenerate `native/macos/psyche-build-tauri/web/editor.bundle.js`, `sessions.bundle.js`, and `panes.bundle.js` through the existing build command if source imports require it; the committed HTML/CSS/`main.js` are copied directly and do not have generated counterparts.

The three source files and two tests already contain uncommitted workspace
panel changes. Preserve those edits and do not stage or commit the combined
files unless the user explicitly requests a combined commit.

### Task 1: Define the persistent-rail markup and behavior contracts

**Files:**
- Modify: `__tests__/tauriWorkspacePanels.test.ts`
- Modify: `__tests__/tauriWorkspaceEditorIntegration.test.ts`

- [ ] **Step 1: Add failing markup assertions**

Extend the existing right-rail panel test in
`__tests__/tauriWorkspacePanels.test.ts`:

```ts
it('uses the persistent icon rail as the only tools panel selector', () => {
  expect(indexHtml).not.toContain('class="dock-tabs"');
  expect(indexHtml).not.toContain('class="dock-tab"');

  const railStart = indexHtml.indexOf('id="rail-right"');
  const railEnd = indexHtml.indexOf('</nav>', railStart);
  const rail = indexHtml.slice(railStart, railEnd);

  expect(railStart).toBeGreaterThan(-1);
  expect(rail).not.toMatch(/\shidden(?:\s|>)/);
  for (const panel of ['files', 'git', 'browser']) {
    expect(rail).toContain(`data-panel-btn="${panel}"`);
  }
  expect(rail).toContain('id="dock-git-count"');
});
```

- [ ] **Step 2: Add failing CSS layout assertions**

Add:

```ts
it('reserves the right rail and gives dock panels the full dock height', () => {
  expect(stylesCss).toMatch(
    /\.workbench\s*\{[^}]*grid-template-columns:\s*var\(--sidebar-w\)\s+minmax\(0,\s*1fr\)\s+var\(--mini-rail-w\);/,
  );
  expect(stylesCss).toMatch(
    /\.app\[data-sidebar="collapsed"\]\s+\.workbench\s*\{[^}]*grid-template-columns:\s*var\(--mini-rail-w\)\s+minmax\(0,\s*1fr\)\s+var\(--mini-rail-w\);/,
  );
  expect(stylesCss).not.toMatch(/\.app\[data-dock="collapsed"\]\s+\.workbench/);
  expect(stylesCss).toMatch(
    /\.browser-pane\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/,
  );
  expect(stylesCss).toMatch(/\.panel\s*\{[^}]*grid-area:\s*1\s*\/\s*1;/);
});
```

- [ ] **Step 3: Add failing JavaScript assertions**

In `__tests__/tauriWorkspaceEditorIntegration.test.ts`, add:

```ts
it('keeps the panel rail visible while syncing dock state', () => {
  const syncDockChrome = extractFunctionSource(mainJs, 'syncDockChrome');

  expect(syncDockChrome).toContain(
    'appEl.dataset.dock = open ? "open" : "collapsed"',
  );
  expect(syncDockChrome).not.toContain('dockMiniEl.hidden');
  expect(mainJs).not.toContain('onRailClick("dock-collapse"');
});
```

Keep the existing click-handler contract which requires clicking the active
`data-panel-btn` to call `applyLayout("terminal")`.

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```sh
pnpm vitest --run \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts
```

Expected: FAIL on the top-tab markup, hidden rail, two-row dock CSS, and
`dockMiniEl.hidden` assignment.

### Task 2: Replace the top selector with the persistent rail

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/index.html`
- Modify: `native/macos/psyche-build-tauri/web/styles.css`
- Modify: `native/macos/psyche-build-tauri/web/main.js`

- [ ] **Step 1: Remove the expanded dock tabs**

Delete the complete block beginning with:

```html
<div class="dock-tabs" role="tablist" aria-label="Tools dock">
```

and ending at its matching `</div>` before `.panel-browser`. Do not remove any
panel markup.

- [ ] **Step 2: Make the right rail present from first paint**

Change:

```html
<nav class="mini-rail dock-mini" id="rail-right" hidden
```

to:

```html
<nav class="mini-rail dock-mini" id="rail-right"
```

Move the existing Git count span into the Git rail button:

```html
<button class="mini-rail-btn" data-panel-btn="git" type="button" aria-pressed="false"
        title="Git, GitHub and diffs" aria-label="Git and diffs panel">
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <circle cx="4.8" cy="3.9" r="1.7" fill="none" stroke="currentColor" stroke-width="1.35"/>
    <circle cx="4.8" cy="12.1" r="1.7" fill="none" stroke="currentColor" stroke-width="1.35"/>
    <circle cx="11.2" cy="8" r="1.7" fill="none" stroke="currentColor" stroke-width="1.35"/>
    <path d="M4.8 5.6v4.8M6.4 4.5c2.7.2 4.7 1.2 4.8 1.8"
          fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
  </svg>
  <span class="dock-tab-count" id="dock-git-count" hidden></span>
</button>
```

Preserve the exact SVG paths already present in the file if they differ from
the excerpt; only the label text and count span location are behavior changes.

- [ ] **Step 3: Permanently reserve the rail column**

Replace the workbench column rules with:

```css
.workbench {
  position: relative;
  display: grid;
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr) var(--mini-rail-w);
  min-height: 0;
  overflow: hidden;
}
.app[data-sidebar="collapsed"] .workbench {
  grid-template-columns: var(--mini-rail-w) minmax(0, 1fr) var(--mini-rail-w);
}
```

Remove the `.app[data-dock="collapsed"] .workbench` and combined
sidebar/dock-collapsed column overrides. Keep `data-dock` itself because other
layout state and tests use it.

- [ ] **Step 4: Give dock panels the removed row**

Update both `.browser-pane` declarations in `styles.css` to:

```css
.browser-pane {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}
```

Keep their existing backgrounds, borders, sizing, and backdrop properties.
Change the shared panel placement from:

```css
.panel {
  grid-area: 2 / 1;
```

to:

```css
.panel {
  grid-area: 1 / 1;
```

Delete `.dock-tabs`, `.dock-tabs .dock-collapse`, `.dock-tab`, and
`.dock-tab:hover`/pressed rules. Keep `.dock-tab-count` for the Git rail badge
and add:

```css
.dock-mini .dock-tab-count {
  position: absolute;
  top: 2px;
  right: 2px;
  transform: none;
}
```

- [ ] **Step 5: Stop hiding the rail from JavaScript**

Change `syncDockChrome` to:

```js
function syncDockChrome() {
  var open = currentLayout() !== "terminal";
  if (appEl) appEl.dataset.dock = open ? "open" : "collapsed";
}
```

Delete:

```js
onRailClick("dock-collapse", function () { applyLayout("terminal"); });
```

Do not alter the shared `[data-panel-btn]` handler. It already opens a selected
panel, switches panels, and collapses when the active icon is clicked.

- [ ] **Step 6: Run the focused tests**

Run:

```sh
pnpm vitest --run \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts
```

Expected: both suites pass.

### Task 3: Validate layout contracts and generated web assets

**Files:**
- Modify only if regenerated: `native/macos/psyche-build-tauri/web/editor.bundle.js`
- Modify only if regenerated: `native/macos/psyche-build-tauri/web/sessions.bundle.js`
- Modify only if regenerated: `native/macos/psyche-build-tauri/web/panes.bundle.js`

- [ ] **Step 1: Run all related Tauri workspace tests**

Run:

```sh
pnpm vitest --run \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriDesktopTabs.test.ts
```

Expected: all three related suites pass.

- [ ] **Step 2: Rebuild committed Tauri web bundles**

Run:

```sh
pnpm --dir native/macos/psyche-build-tauri build:web
```

Expected: esbuild succeeds. The three committed JavaScript bundles change only
when their imported sources changed.

- [ ] **Step 3: Verify bundle parity**

Run:

```sh
pnpm vitest --run __tests__/tauriWebBundles.test.ts
```

Expected: the committed bundles match fresh builds.

- [ ] **Step 4: Run typecheck and whitespace validation**

Run:

```sh
pnpm typecheck
git diff --check
```

Expected: both pass.

### Task 4: Manual interaction check

**Files:** none.

- [ ] **Step 1: Launch the current Tauri dev app**

Run:

```sh
pnpm dev:tauri
```

Expected: the workspace opens with no Files/Git/Web text strip above the tools
panel and the icon rail remains visible on the right.

- [ ] **Step 2: Exercise the rail**

Verify:

1. Files opens from its rail icon.
2. Git opens and still includes the merged changes/diff section.
3. Web opens and its browser controls and tabs remain usable.
4. Clicking the active icon collapses the dock.
5. Clicking any icon while collapsed reopens the selected panel.
6. The rail remains visible while the dock is open.
7. Cycling the dock side does not hide or duplicate the rail.

- [ ] **Step 3: Preserve unrelated workspace edits**

Run:

```sh
git status --short
git --no-pager diff -- \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css
```

Confirm the earlier Git/diffs consolidation remains intact. Leave these
overlapping files unstaged unless the user explicitly requests a combined
commit.
