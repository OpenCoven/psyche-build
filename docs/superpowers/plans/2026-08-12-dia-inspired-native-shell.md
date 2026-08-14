# Dia-Inspired Native Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Psyche's current macOS title bar and sidebar chrome with the approved Dia-inspired shell, and move session search into a `?` composer palette.

**Architecture:** Keep the existing app grid and pane system, but split the title bar into sidebar and workspace zones that share the same width token as the workbench. Reuse the existing composer palette for `?` session search, with ordered results derived from the existing pure sidebar model so sidebar and composer matching cannot drift. Keep session activation in `main.js`, where live local threads and Coven sessions can be revalidated immediately before focus or attach.

**Tech Stack:** Tauri webview, HTML, CSS, vanilla JavaScript, ES modules bundled with esbuild, Vitest source-contract and model tests.

---

## Execution Prerequisite

Create a fresh isolated worktree from the commit containing this plan and `83d65b7` (`fix(macos): remove session status legend`). Do not implement this shell in `.worktrees/terminal-focus-report-suppression`; that branch has unrelated unresolved synchronization defects.

## File Structure

- Create: `native/macos/psyche-build-tauri/web/assets/psyche-mark.png`
  - Browser-loadable copy of the existing packaged Psyche app icon for the sidebar title-bar cap.
- Modify: `native/macos/psyche-build-tauri/web/index.html`
  - Replace the current full-width title-bar controls with sidebar/workspace title-bar zones.
  - Move the existing sidebar toggle to the workspace boundary.
  - Remove sidebar search markup.
  - Give the existing composer palette session-search semantics and accessible labeling.
- Modify: `native/macos/psyche-build-tauri/web/styles.css`
  - Define the shared sidebar/workspace surfaces, title-bar geometry, inward top-left workspace curve, flat bottom edge, boundary toggle, brand cap, and session-search palette rows.
- Modify: `native/macos/psyche-build-tauri/web/sessions/sidebar-model.mjs`
  - Flatten already-filtered project models into stable, sidebar-ordered session-search results.
- Modify: `native/macos/psyche-build-tauri/web/sessions/sidebar-model.d.mts`
  - Declare the session-search result shape and helper.
- Modify: `native/macos/psyche-build-tauri/web/sessions/session-entry.js`
  - Export the session-search helper through `window.PsycheSessions`.
- Modify: `native/macos/psyche-build-tauri/web/sessions.bundle.js`
  - Regenerate the checked-in browser bundle.
- Modify: `native/macos/psyche-build-tauri/web/main.js`
  - Remove sidebar query state and `/` focus routing.
  - Build and render `?` palette entries.
  - Revalidate and activate local or Coven results.
  - Preserve `/`, `!`, `%`, and plain-text composer behavior.
- Modify: `__tests__/tauriWorkspaceRail.test.ts`
  - Replace sidebar-search expectations with title-bar branding, relocated toggle, and retained tab/filter contracts.
- Modify: `__tests__/tauriFooterStatusBar.test.ts`
  - Update the title-bar grid contract from a monolithic row to aligned sidebar/workspace zones.
- Modify: `__tests__/tauriThemeTokens.test.ts`
  - Lock the shared sidebar surface, shared workspace surface, single top-left radius, and flat lower edge.
- Modify: `__tests__/tauriSidebarModel.test.ts`
  - Test ordered flattening and complete result metadata.
- Create: `__tests__/tauriSessionSearchPalette.test.ts`
  - Test `?` palette wiring, keyboard behavior, no-result behavior, stale-result guards, and preservation of existing composer modes.
- Modify: `__tests__/tauriWebBundles.test.ts`
  - Assert the generated sessions bundle exports the new helper.

### Task 1: Build the Two-Zone Dia Shell

**Files:**
- Create: `native/macos/psyche-build-tauri/web/assets/psyche-mark.png`
- Modify: `native/macos/psyche-build-tauri/web/index.html:16-181`
- Modify: `native/macos/psyche-build-tauri/web/styles.css:1-320`
- Modify: `__tests__/tauriWorkspaceRail.test.ts:1-230`
- Modify: `__tests__/tauriFooterStatusBar.test.ts:1-150`
- Modify: `__tests__/tauriThemeTokens.test.ts:1-220`

- [ ] **Step 1: Write the failing shell markup tests**

Replace the sidebar-search assertions in `__tests__/tauriWorkspaceRail.test.ts` with contracts for the approved shell:

```ts
it('uses a branded sidebar cap and keeps sidebar controls below it', () => {
  expect(indexHtml).toMatch(
    /class="titlebar-sidebar"[\s\S]*src="\.\/assets\/psyche-mark\.png"[\s\S]*>Psyche</,
  );
  expect(indexHtml).toMatch(
    /class="titlebar-workspace"[\s\S]*id="sidebar-collapse"/,
  );
  expect(indexHtml).not.toContain('id="session-search"');
  expect(indexHtml).not.toContain('id="sidebar-collapse" class="sidebar-head-action');
  expect(styles).not.toMatch(/\.session-search(?:-wrap|-key)?\b/);
  expect(indexHtml).toMatch(/role="tablist" aria-label="Sidebar sections"/);
  expect(indexHtml).toContain('id="titlebar-brand-mark"');
  expect(indexHtml).not.toMatch(/\sonerror=/);
  expect(mainJs).toContain('initializeTitlebarBrandMark();');
  expect(indexHtml).toContain('data-sidebar-tab="sessions"');
  expect(indexHtml).toContain('data-sidebar-tab="files"');
  expect(indexHtml).toContain('id="rail-new-tab"');
  expect(indexHtml).toContain('data-session-filter="all"');
  expect(indexHtml).toContain('data-session-filter="attention"');
});

it('removes status, help, and browser-like controls from the native title bar', () => {
  const titlebar = indexHtml.match(/<header class="titlebar"[\s\S]*?<\/header>/)?.[0] ?? '';
  expect(titlebar).not.toContain('id="daemon-status"');
  expect(titlebar).not.toContain('id="shell-status"');
  expect(titlebar).not.toContain('id="help-toggle"');
  expect(titlebar).not.toContain('id="back"');
  expect(titlebar).not.toContain('id="forward"');
  expect(titlebar).not.toContain('id="reload"');
  expect(titlebar).not.toContain('id="url"');
  expect(titlebar).not.toContain('id="open-external"');
});
```

Update the title-bar assertion in `__tests__/tauriFooterStatusBar.test.ts`:

```ts
it('aligns title-bar zones with the sidebar and workspace columns', () => {
  expect(indexHtml).toMatch(
    /<header class="titlebar"[\s\S]*class="titlebar-sidebar"[\s\S]*class="titlebar-workspace"/,
  );
  expect(stylesCss).toMatch(
    /\.titlebar\s*\{[^}]*grid-template-columns:\s*var\(--sidebar-w\)\s+minmax\(0,\s*1fr\);/s,
  );
  expect(stylesCss).toMatch(
    /\.app\[data-sidebar="collapsed"\]\s+\.titlebar\s*\{[^}]*grid-template-columns:\s*var\(--mini-rail-w\)\s+minmax\(0,\s*1fr\);/s,
  );
});
```

Add geometry contracts to `__tests__/tauriThemeTokens.test.ts`:

```ts
it('uses shared Dia shell surfaces with one inward top-left workspace curve', () => {
  expect(stylesCss).toMatch(
    /--sidebar-surface:\s*rgba\(var\(--rgb-deep\),\s*calc\(var\(--bg-opacity\)\s*\*\s*0\.55\)\);/,
  );
  expect(stylesCss).toMatch(
    /--workspace-surface:\s*rgba\(var\(--rgb-deep\),\s*calc\(var\(--bg-opacity\)\s*\*\s*0\.72\)\);/,
  );
  expect(stylesCss).toMatch(
    /\.titlebar-sidebar\s*\{[^}]*background:\s*var\(--sidebar-surface\);/s,
  );
  expect(stylesCss).toMatch(
    /\.sidebar\s*\{[^}]*background:\s*var\(--sidebar-surface\);/s,
  );
  expect(stylesCss).toMatch(
    /\.titlebar-workspace\s*\{[^}]*background:\s*var\(--workspace-surface\);/s,
  );
  expect(stylesCss).toMatch(
    /\.detail\s*\{[^}]*background:\s*var\(--workspace-surface\);[^}]*border-radius:\s*var\(--workspace-radius\)\s+0\s+0\s+0;/s,
  );
  expect(stylesCss).not.toMatch(/\.detail\s*\{[^}]*border-(?:bottom-left|bottom-right)-radius:/s);
});

it('paints the exposed workspace corner with the sidebar surface', () => {
  expect(stylesCss).toMatch(
    /\.workbench\s*\{[^}]*background:\s*var\(--sidebar-surface\);/s,
  );
});
```

- [ ] **Step 2: Run the shell tests to verify they fail**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriThemeTokens.test.ts
```

Expected: FAIL because the current title bar is monolithic, sidebar search still exists, and the workspace does not yet have the approved surface/radius contract.

- [ ] **Step 3: Copy the packaged Psyche icon into the web assets**

Run:

```bash
mkdir -p native/macos/psyche-build-tauri/web/assets
cp native/macos/psyche-build-tauri/src-tauri/icons/32x32.png \
  native/macos/psyche-build-tauri/web/assets/psyche-mark.png
```

Confirm the copy is byte-identical:

```bash
cmp \
  native/macos/psyche-build-tauri/src-tauri/icons/32x32.png \
  native/macos/psyche-build-tauri/web/assets/psyche-mark.png
```

Expected: `cmp` exits with status 0 and prints no output.

- [ ] **Step 4: Replace the current title bar and simplify the sidebar header**

Replace the current `<header class="titlebar">` in `index.html` with:

```html
<header class="titlebar" data-tauri-drag-region>
  <div class="titlebar-sidebar" data-tauri-drag-region>
    <span class="traffic-gutter" aria-hidden="true"></span>
    <span class="titlebar-brand" data-tauri-drag-region>
      <span class="titlebar-brand-icon" aria-hidden="true">
        <span class="titlebar-brand-fallback">P</span>
        <img
          id="titlebar-brand-mark"
          class="titlebar-brand-mark"
          src="./assets/psyche-mark.png"
          alt=""
        />
      </span>
      <span class="titlebar-brand-name">Psyche</span>
    </span>
  </div>
  <div class="titlebar-workspace" data-tauri-drag-region>
    <button
      id="sidebar-collapse"
      class="titlebar-sidebar-toggle"
      type="button"
      title="Toggle sidebar (⌘B)"
      aria-label="Collapse sidebar"
      aria-pressed="false"
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/>
        <line x1="5.5" y1="2.5" x2="5.5" y2="13.5" stroke="currentColor" stroke-width="1.3"/>
      </svg>
    </button>
  </div>
</header>
```

In `main.js`, attach a normal `error` listener to `#titlebar-brand-mark` that
removes the failed decorative image, and run the same removal during boot when
`mark.complete && mark.naturalWidth === 0`. Do not use inline event handlers;
the visible fallback `P` remains behind the image.

Remove the `session-search-wrap` block and the old `#sidebar-collapse` button from `.sidebar-head`. Keep this exact sidebar hierarchy:

1. `.sidebar-tabs` remains the first child of `.sidebar-controls`.
2. `.sidebar-head` contains only the existing `#rail-new-tab` button.
3. `.session-filter-row` remains immediately after `.sidebar-head`.

Do not move or remove the browser pane toolbar under `#browser-surface`; only the native app title bar loses browser-like controls.

- [ ] **Step 5: Implement the approved shell surfaces and geometry**

Add or update the shell tokens near the top of `styles.css`:

```css
:root {
  --sidebar-surface: rgba(var(--rgb-deep), calc(var(--bg-opacity) * 0.55));
  --workspace-surface: rgba(var(--rgb-deep), calc(var(--bg-opacity) * 0.72));
  --workspace-radius: 18px;
}
```

Replace the monolithic title-bar layout with:

```css
.titlebar {
  display: grid;
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
  min-width: 0;
  height: var(--titlebar-h);
  background: var(--sidebar-surface);
  -webkit-app-region: drag;
}

.app[data-sidebar="collapsed"] .titlebar {
  grid-template-columns: var(--mini-rail-w) minmax(0, 1fr);
}

.titlebar-sidebar,
.titlebar-workspace {
  min-width: 0;
  height: 100%;
  -webkit-app-region: drag;
}

.titlebar-sidebar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-inline: 12px;
  background: var(--sidebar-surface);
  backdrop-filter: blur(24px) saturate(1.4);
  -webkit-backdrop-filter: blur(24px) saturate(1.4);
}

.titlebar-workspace {
  position: relative;
  background: var(--workspace-surface);
}

.titlebar-brand {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.titlebar-brand-icon {
  position: relative;
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  overflow: hidden;
  border-radius: 5px;
  background: linear-gradient(135deg, var(--accent), var(--accent-strong));
  pointer-events: none;
}

.titlebar-brand-fallback {
  color: var(--text);
  font-size: 10px;
  font-weight: 800;
}

.titlebar-brand-mark {
  position: absolute;
  inset: 0;
  width: 18px;
  height: 18px;
  object-fit: cover;
}

.titlebar-brand-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}

.titlebar-sidebar-toggle {
  position: absolute;
  z-index: 4;
  left: 0;
  top: 50%;
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  background: var(--workspace-surface);
  color: var(--text-muted);
  transform: translate(-50%, -50%);
  -webkit-app-region: no-drag;
}

.app[data-sidebar="collapsed"] .titlebar-sidebar-toggle {
  left: calc(var(--titlebar-pad-l) - var(--mini-rail-w));
  transform: translateY(-50%);
}

.titlebar-sidebar-toggle:hover,
.titlebar-sidebar-toggle:focus-visible {
  color: var(--text-strong);
  border-color: var(--border-strong);
}
```

Make the underlying workbench paint the exposed corner with the sidebar surface and keep the lower edge flat:

```css
.workbench {
  background: var(--sidebar-surface);
}

.sidebar {
  background: var(--sidebar-surface);
}

.detail {
  min-width: 0;
  overflow: hidden;
  background: var(--workspace-surface);
  border-radius: var(--workspace-radius) 0 0 0;
}
```

Remove obsolete title-bar rules for `.brand`, `.titlebar-spacer`, `.titlebar-sep`, `.daemon-status`, `.daemon-dot`, `.daemon-label`, `.titlebar .status-pill`, `.help-btn`, `.session-search-wrap`, `.session-search`, and `.session-search-key`. Preserve `.traffic-gutter` so the brand remains clear of the macOS traffic lights.
Also remove `.titlebar > * { -webkit-app-region: no-drag; }`; the two zones must stay draggable while `.titlebar-sidebar-toggle` remains explicitly `no-drag`.

- [ ] **Step 6: Update collapsed-toggle accessibility in `main.js`**

Add these DOM references beside `sidebarMiniEl`:

```js
var sidebarCollapseEl = document.getElementById("sidebar-collapse");
var sidebarExpandEl = document.getElementById("sidebar-expand");
```

Add:

```js
function syncSidebarToggleState(collapsed) {
  if (sidebarCollapseEl) {
    sidebarCollapseEl.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    sidebarCollapseEl.setAttribute("aria-pressed", collapsed ? "true" : "false");
  }
  if (sidebarExpandEl) sidebarExpandEl.hidden = !collapsed;
}
```

Update `setSidebarOpen` to call the helper:

```js
function setSidebarOpen(open) {
  if (!appEl) return;
  appEl.dataset.sidebar = open ? "open" : "collapsed";
  if (sidebarMiniEl) sidebarMiniEl.hidden = open;
  syncSidebarToggleState(!open);
  if (!open) closeNewPaneMenu();
  requestAnimationFrame(function () {
    scheduleVisiblePaneFit();
    syncBrowserBounds();
  });
}
```

- [ ] **Step 7: Run the shell tests to verify they pass**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriThemeTokens.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the shell**

```bash
git add \
  native/macos/psyche-build-tauri/web/assets/psyche-mark.png \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/styles.css \
  native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriThemeTokens.test.ts
git commit -m "feat(macos): add Dia-inspired native shell"
```

### Task 2: Add Ordered Session-Search Results to the Sidebar Model

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/sessions/sidebar-model.mjs:250-end`
- Modify: `native/macos/psyche-build-tauri/web/sessions/sidebar-model.d.mts:70-end`
- Modify: `native/macos/psyche-build-tauri/web/sessions/session-entry.js:1-end`
- Modify: `native/macos/psyche-build-tauri/web/sessions.bundle.js`
- Modify: `__tests__/tauriSidebarModel.test.ts:1-end`
- Modify: `__tests__/tauriWebBundles.test.ts:1-end`

- [ ] **Step 1: Write the failing ordered-results model test**

Import `flattenSidebarSearchResults` in `__tests__/tauriSidebarModel.test.ts`:

```ts
import {
  SIDEBAR_ACTIVE_WINDOW_MS,
  SIDEBAR_FILTERS,
  buildSidebarProjectModel,
  deriveCovenSidebarStatus,
  deriveLocalSidebarStatus,
  flattenSidebarSearchResults,
  localSidebarSelectionKey,
  matchTextRanges,
  normalizeSidebarFilter,
  sidebarSelectionKey,
  sidebarTailIsWorking,
} from '../native/macos/psyche-build-tauri/web/sessions/sidebar-model.mjs';
```

Add:

```ts
it('flattens matching rows in sidebar order with project and branch context', () => {
  const projectModel = buildSidebarProjectModel({
    project: baseProject,
    localSessions: [
      localSession('shell-tests', {
        name: 'Tests',
        launch: { command: 'pnpm', args: ['vitest'] },
        lastOutputAt: 8_500,
      }),
      localSession('shell-api', {
        name: 'API',
        launch: { command: 'pnpm', args: ['dev'] },
        needsAttention: true,
        lastOutputAt: 9_000,
      }),
    ],
    covenSessions: [covenSession('coven-1', { title: 'Review agent' })],
    query: '',
    filter: 'all',
    selectedKey: '',
    now: 10_000,
  });

  expect(flattenSidebarSearchResults([projectModel]).map((result) => ({
    key: result.key,
    source: result.source,
    projectId: result.projectId,
    projectTitle: result.projectTitle,
    branchTitle: result.branchTitle,
    title: result.title,
    meta: result.meta,
    status: result.status.label,
  }))).toEqual([
    {
      key: 'coven:coven-1',
      source: 'coven',
      projectId: 'psyche',
      projectTitle: 'PSYCHE-BUILD',
      branchTitle: 'feat/web-pane-attention',
      title: 'Review agent',
      meta: 'Coven · running',
      status: 'BUSY',
    },
    {
      key: 'psyche:shell-api',
      source: 'psyche',
      projectId: 'psyche',
      projectTitle: 'PSYCHE-BUILD',
      branchTitle: 'feat/web-pane-attention',
      title: 'API',
      meta: 'pnpm dev',
      status: 'REPLY',
    },
    {
      key: 'psyche:shell-tests',
      source: 'psyche',
      projectId: 'psyche',
      projectTitle: 'PSYCHE-BUILD',
      branchTitle: 'feat/web-pane-attention',
      title: 'Tests',
      meta: 'pnpm vitest',
      status: 'ACTIVE',
    },
  ]);
});

it('returns only rows retained by the project model query', () => {
  const projectModel = buildSidebarProjectModel({
    project: baseProject,
    localSessions: [
      localSession('shell-api', { name: 'API server' }),
      localSession('shell-tests', { name: 'Tests' }),
    ],
    covenSessions: [],
    query: ' API ',
    filter: 'all',
    selectedKey: '',
    now: 10_000,
  });

  expect(flattenSidebarSearchResults([projectModel]).map((result) => result.title)).toEqual([
    'API server',
  ]);
});
```

- [ ] **Step 2: Run the model test to verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriSidebarModel.test.ts
```

Expected: FAIL because `flattenSidebarSearchResults` is not exported.

- [ ] **Step 3: Implement the pure flattening helper**

Add to `sidebar-model.mjs` after `buildSidebarProjectModel`:

```js
export function flattenSidebarSearchResults(projectModels = []) {
  return projectModels.flatMap((projectModel) => (
    projectModel.branches.flatMap((branchModel) => (
      branchModel.categories.flatMap((category) => (
        category.rows.map((row) => ({
          key: row.key,
          selectionKey: row.selectionKey,
          source: row.source,
          id: row.id,
          projectId: projectStableIdentity(projectModel.project),
          projectRoot: row.projectRoot,
          worktreePath: row.worktreePath,
          projectTitle: projectModel.title,
          branchTitle: branchModel.title,
          title: row.title,
          meta: row.meta,
          status: row.status,
          kind: row.kind,
          type: row.type,
          value: row.value,
        }))
      ))
    ))
  ));
}
```

This helper must not sort again. `buildSidebarProjectModel` already applies selected/status/activity ordering, and empty `?` search must match visible sidebar order.

- [ ] **Step 4: Declare and export the result type**

Add to `sidebar-model.d.mts`:

```ts
export interface SidebarSearchResult<T = unknown> {
  key: string;
  selectionKey: string;
  source: SidebarRowSource;
  id: string;
  projectId: string;
  projectRoot: string;
  worktreePath: string | null;
  projectTitle: string;
  branchTitle: string;
  title: string;
  meta: string;
  status: SidebarStatusPresentation;
  kind: string;
  type: SidebarRowType;
  value: T;
}

export function flattenSidebarSearchResults(
  projectModels?: Array<SidebarProjectModel>,
): Array<SidebarSearchResult>;
```

Export it from `session-entry.js` alongside `buildSidebarProjectModel`:

```js
export {
  SIDEBAR_ACTIVE_WINDOW_MS,
  SIDEBAR_FILTERS,
  buildSidebarProjectModel,
  deriveCovenSidebarStatus,
  deriveLocalSidebarStatus,
  flattenSidebarSearchResults,
  localSidebarSelectionKey,
  matchTextRanges,
  normalizeSidebarFilter,
  sidebarSelectionKey,
  sidebarTailIsWorking,
} from './sidebar-model.mjs';
```

- [ ] **Step 5: Run the model test to verify it passes**

Run:

```bash
pnpm vitest --run __tests__/tauriSidebarModel.test.ts
```

Expected: PASS.

- [ ] **Step 6: Add a failing generated-bundle contract**

Add to `__tests__/tauriWebBundles.test.ts`:

```ts
it('exports ordered session-search results from the sessions bundle', () => {
  const sessionEntryJs = readFileSync(
    join(webRoot, 'sessions/session-entry.js'),
    'utf8',
  );
  const sessionsBundleJs = readFileSync(join(webRoot, 'sessions.bundle.js'), 'utf8');
  expect(sessionEntryJs).toContain('flattenSidebarSearchResults');
  expect(sessionsBundleJs).toContain('flattenSidebarSearchResults');
});
```

Run:

```bash
pnpm vitest --run __tests__/tauriWebBundles.test.ts
```

Expected: FAIL because the checked-in sessions bundle has not been regenerated.

- [ ] **Step 7: Regenerate the browser bundles and rerun bundle tests**

Run:

```bash
pnpm --filter psyche-build-tauri run build:web
pnpm vitest --run __tests__/tauriWebBundles.test.ts __tests__/tauriSidebarModel.test.ts
```

Expected: PASS. Only `web/sessions.bundle.js` should contain a semantic change; the other generated bundles may be byte-identical.

- [ ] **Step 8: Commit the reusable search model**

```bash
git add \
  native/macos/psyche-build-tauri/web/sessions/sidebar-model.mjs \
  native/macos/psyche-build-tauri/web/sessions/sidebar-model.d.mts \
  native/macos/psyche-build-tauri/web/sessions/session-entry.js \
  native/macos/psyche-build-tauri/web/sessions.bundle.js \
  __tests__/tauriSidebarModel.test.ts \
  __tests__/tauriWebBundles.test.ts
git commit -m "feat(macos): expose ordered session search results"
```

### Task 3: Add `?` Session Search to the Composer Palette

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/index.html:360-405`
- Modify: `native/macos/psyche-build-tauri/web/styles.css:3600-3900`
- Modify: `native/macos/psyche-build-tauri/web/main.js:4100-4140, 5530-6030, 7180-7460`
- Create: `__tests__/tauriSessionSearchPalette.test.ts`
- Create: `__tests__/tauriThreadFocus.test.ts`
- Modify: `__tests__/tauriWorkspaceRail.test.ts:205-230`
- Modify: `__tests__/tauriComposerScope.test.ts:1-end`

- [ ] **Step 1: Write the failing composer session-search contracts**

Create `__tests__/tauriSessionSearchPalette.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const webRoot = join(repoRoot, 'native/macos/psyche-build-tauri/web');
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
const mainJs = readFileSync(join(webRoot, 'main.js'), 'utf8');
const stylesCss = readFileSync(join(webRoot, 'styles.css'), 'utf8');

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionSource(source: string, name: string) {
  const match = new RegExp(`function\\s+${escapeRegExp(name)}\\s*\\(`).exec(source);
  if (!match || match.index === undefined) throw new Error(`missing function ${name}`);
  const bodyStart = source.indexOf('{', match.index + match[0].length);
  if (bodyStart === -1) throw new Error(`missing body for ${name}`);

  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

describe('Tauri composer session search', () => {
  it('uses the existing composer palette as an accessible session-search popover', () => {
    expect(indexHtml).toMatch(
      /id="palette"[^>]*role="listbox"[^>]*aria-label="Composer suggestions"/,
    );
    expect(indexHtml).toMatch(
      /id="command-input"[^>]*role="combobox"[^>]*aria-controls="palette"/,
    );
    expect(stylesCss).toMatch(/\.palette\s*\{[^}]*bottom:\s*calc\(100%\s*\+/s);
    expect(stylesCss).toMatch(/\.palette-item\.palette-session\s*\{/);
    expect(stylesCss).toMatch(/\.palette-empty\s*\{/);
  });

  it('recognizes ? without changing the existing composer sigils', () => {
    expect(mainJs).toContain('var PALETTE_SIGILS = "/!%?";');
    expect(mainJs).toContain('function buildSessionSearchEntries(query)');
    expect(mainJs).toContain('PsycheSessions.buildSidebarProjectModel({');
    expect(mainJs).toContain('PsycheSessions.flattenSidebarSearchResults(projectModels)');
    expect(mainJs).toContain('filter: sessionTypeFilter');
    expect(mainJs).toContain('function runSessionSearchPick(pick)');
  });

  it('supports empty, no-result, keyboard, click, and escape behavior', () => {
    const openPalette = functionSource(mainJs, 'openPalette');
    const renderPalette = functionSource(mainJs, 'renderPalette');
    const runPalettePick = functionSource(mainJs, 'runPalettePick');
    expect(openPalette).toContain('sigil === "?"');
    expect(openPalette).toContain('buildSessionSearchEntries(rest)');
    expect(renderPalette).toContain('"No matching sessions"');
    expect(renderPalette).toContain('role", "option"');
    expect(renderPalette).toContain('"palette-option-" + idx');
    expect(renderPalette).toContain('palette-session');
    expect(runPalettePick).toContain('pick.kind === "session"');
    expect(mainJs).toContain('"Search sessions, " + paletteFiltered.length');
    expect(mainJs).toContain('if (paletteVisible && e.key === "ArrowDown"');
    expect(mainJs).toContain('if (paletteVisible && e.key === "ArrowUp"');
    expect(mainJs).toContain('if (paletteVisible && e.key === "Enter"');
    expect(mainJs).toContain('if (paletteVisible && e.key === "Escape"');
    expect(mainJs).toContain('commandInput.value = "";');
  });

  it('revalidates local and Coven matches immediately before activation', () => {
    const selection = functionSource(mainJs, 'runSessionSearchPick');
    expect(selection).toContain('findThread(pick.sessionId)');
    expect(selection).toContain('candidate.hidden');
    expect(selection).toContain('isDormantThread(candidate)');
    expect(selection).toContain('activateProjectWorktree(');
    expect(selection).toContain('thread.worktreePath, { focusTerminal: false }');
    expect(selection).toContain('snapshotSetScopePresentation(thread)');
    expect(selection).toContain('applySetScopeForThread(thread)');
    expect(selection).toContain(
      'restoreSetScopePresentation(previousPresentation, appliedPresentation)',
    );
    expect(selection).toContain('covenSessionsForProject(project)');
    expect(selection).toContain('candidate.id === pick.sessionId');
    expect(selection).toContain('settings.selectedSessionKey = pick.selectionKey');
    expect(selection).toContain('saveSettings()');
    expect(selection).toContain('focusThread(thread.id, { focusTerminal: false })');
    expect(selection).toContain(
      'openCovenSession(project, session, { focusTerminal: false })',
    );
    expect(selection).toContain('toast("Session is no longer available")');
  });
});
```

Add preservation assertions to `__tests__/tauriComposerScope.test.ts`:

```ts
it('preserves shell, pane, command, and plain-text composer routing', () => {
  const runCommand = functionSource(mainJs, 'runCommand');
  expect(runCommand).toContain('runShellSigil(trimmed.slice(1).trim())');
  expect(runCommand).toContain('runPaneSigil(trimmed.slice(1))');
  expect(runCommand).toContain('if (trimmed[0] !== "/")');
  expect(runCommand).toContain('sendToThread(focused, trimmed + "\\n")');
  expect(runCommand).toContain('if (trimmed.charAt(0) === "?")');
  expect(runCommand).toContain('openPalette(trimmed, true);');
});
```

Replace the obsolete sidebar search case in `__tests__/tauriWorkspaceRail.test.ts` with:

```ts
it('keeps persisted filters while composer search remains visit-local', () => {
  expect(indexHtml).not.toContain('id="session-search"');
  expect(mainJs).not.toContain('var sessionSearchEl =');
  expect(mainJs).not.toContain('settings.sessionSearch');
  expect(mainJs).not.toContain('sessionSearchEl.focus()');
  expect(mainJs).toContain('var sessionTypeFilter = settings.sessionFilter;');
  expect(mainJs).toContain('function setSessionTypeFilter(value, options)');
  expect(mainJs).toContain('settings.sessionFilter = sessionTypeFilter;');
  expect(mainJs).toContain('setSessionTypeFilter(settings.sessionFilter, { persist: false });');
  expect(styles).toMatch(/\.session-filter\.is-active\s*\{/);
});
```

- [ ] **Step 2: Run the session-search tests to verify they fail**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriSessionSearchPalette.test.ts \
  __tests__/tauriComposerScope.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
```

Expected: FAIL because `?` is not a palette sigil and sidebar search wiring is still present.

- [ ] **Step 3: Remove sidebar query state and global `/` focus routing**

In `main.js`, remove:

```js
var sessionSearchEl = document.getElementById("session-search");
var sessionFilter = "";
var sessionSearchRestoreKey = "";
```

Remove the `sessionSearchEl.addEventListener("input", ...)` listener and the document-level shortcut that focuses the sidebar search input when `/` is pressed.

At the top of `renderSessionList`, replace:

```js
var currentSearchQuery = sessionFilter;
var needle = currentSearchQuery.trim().toLowerCase();
var matched = 0;
```

with:

```js
var currentSearchQuery = "";
var matched = 0;
```

Replace the search/filter summary branch with the filter-only version:

```js
if (sessionTypeFilter !== "all") {
  var summary = document.createElement("div");
  summary.className = "session-result-summary";
  summary.setAttribute("role", "status");
  summary.setAttribute("aria-live", "polite");
  var summaryText = document.createElement("span");
  summaryText.textContent = matched + (matched === 1 ? " session" : " sessions");
  var reset = document.createElement("button");
  reset.type = "button";
  reset.className = "session-result-reset";
  reset.textContent = "Reset filter";
  reset.addEventListener("click", function () {
    setSessionTypeFilter("all");
    var allFilter = document.querySelector('[data-session-filter="all"]');
    if (allFilter) allFilter.focus();
  });
  summary.appendChild(summaryText);
  summary.appendChild(reset);
  sessionListEl.appendChild(summary);
}
```

Replace the empty-state text with:

```js
empty.textContent = sessionTypeFilter !== "all"
  ? "No sessions match the " + sessionTypeFilter + " filter."
  : state.projects.length
    ? "No sessions yet."
    : "No project open — ⌘O to add one.";
```

Delete the sidebar-search focus/input/keydown listener block in full. Keep `sessionTypeFilter` persistence unchanged so sidebar filters continue to operate independently from composer search.

- [ ] **Step 4: Add search-aware composer markup and styling**

Update the existing composer controls in `index.html`:

```html
<div
  class="palette"
  id="palette"
  role="listbox"
  aria-label="Composer suggestions"
  hidden
></div>
```

Add these attributes to `#command-input`:

```html
role="combobox"
aria-controls="palette"
aria-autocomplete="list"
aria-expanded="false"
```

Retain the existing placement of `#palette` immediately above the composer row.

Add to `styles.css`:

```css
.palette {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  left: 0;
  max-height: min(360px, 45vh);
  overflow: auto;
}

.palette-item.palette-session {
  grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto;
}

.palette-empty {
  padding: 14px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}
```

- [ ] **Step 5: Build session entries from the existing sidebar model**

Change:

```js
var PALETTE_SIGILS = "/!%";
```

to:

```js
var PALETTE_SIGILS = "/!%?";
```

Change the composer input listener to inspect the actual first character rather than trimmed input:

```js
var sessionSearchActivationGeneration = 0;

commandInput.addEventListener("input", function () {
  sessionSearchActivationGeneration += 1;
  if (PALETTE_SIGILS.indexOf(commandInput.value.charAt(0)) !== -1) openPalette();
  else hidePalette();
  syncComposerChrome();
});
```

Add before `openPalette`:

```js
function buildSessionSearchEntries(query) {
  var now = Date.now();
  var selectedThread = findThread(state.activeThreadId);
  var selectedProject = selectedThread ? findProject(selectedThread.projectId) : null;
  var selectedKey = selectedThread && selectedProject
    ? PsycheSessions.localSidebarSelectionKey(selectedProject, selectedThread)
    : settings.selectedSessionKey;
  var covenAssignments = covenSessionAssignments();
  var projectModels = state.projects.map(function (project) {
    return PsycheSessions.buildSidebarProjectModel({
      project: project,
      localSessions: state.threads.filter(function (thread) {
        return thread.projectId === project.id
          && !thread.hidden
          && !isDormantThread(thread);
      }),
      covenSessions: covenSessionsForProject(project, covenAssignments),
      query: query,
      filter: sessionTypeFilter,
      selectedKey: selectedKey,
      now: now,
    });
  }).filter(function (projectModel) {
    return projectModel.visibleCount > 0;
  });

  return PsycheSessions.flattenSidebarSearchResults(projectModels).map(function (result) {
    return {
      cmd: result.title,
      desc: [result.projectTitle, result.branchTitle, result.meta].filter(Boolean).join(" · "),
      badge: result.status.label,
      hint: "↵",
      kind: "session",
      group: "Sessions",
      key: result.key,
      sessionSource: result.source,
      sessionId: result.id,
      selectionKey: result.selectionKey,
      projectId: result.projectId,
    };
  });
}
```

Using `filter: sessionTypeFilter` makes an empty query mirror the sessions currently visible under the active sidebar chip while preserving the sidebar model's ordering.

- [ ] **Step 6: Render `?` results and a visible no-results state**

Replace `openPalette` with:

```js
function openPalette(query, force) {
  var inputValue = commandInput.value;
  var typedSigil = inputValue.charAt(0);
  var raw = (query || inputValue).trim();
  var sigil = raw[0] || "/";
  if (!force && PALETTE_SIGILS.indexOf(typedSigil) === -1) {
    hidePalette();
    return;
  }
  if (PALETTE_SIGILS.indexOf(sigil) === -1) sigil = "/";

  var rest = raw.slice(1).trim().toLowerCase();
  if (sigil === "?") {
    paletteFiltered = buildSessionSearchEntries(rest);
  } else {
    var queryText = sigil === "/" ? raw.toLowerCase() : rest;
    paletteFiltered = paletteCorpus(sigil, rest).filter(function (entry) {
      if (entry.pinned) return true;
      var hay = (entry.cmd + " " + (entry.desc || "") + " " + (entry.badge || "")).toLowerCase();
      return entry.cmd.toLowerCase().indexOf(queryText) === 0 || hay.indexOf(queryText) !== -1;
    });
  }

  if (paletteFiltered.length === 0 && sigil !== "?") {
    hidePalette();
    return;
  }
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteFiltered.length - 1));
  commandInput.setAttribute("aria-expanded", "true");
  renderPalette();
  paletteEl.hidden = false;
  paletteVisible = true;
}
```

In `renderPalette`, keep the palette visible for an empty session result set:

```js
paletteEl.replaceChildren();
var isSessionSearch = commandInput.value.charAt(0) === "?";
if (paletteFiltered.length === 0) {
  if (!isSessionSearch) {
    hidePalette();
    return;
  }
  var empty = document.createElement("div");
  empty.className = "palette-empty";
  empty.textContent = "No matching sessions";
  paletteEl.appendChild(empty);
  paletteEl.hidden = false;
  paletteVisible = true;
  commandInput.removeAttribute("aria-activedescendant");
  return;
}
```

When creating each item:

```js
div.id = "palette-option-" + idx;
div.setAttribute("role", "option");
div.setAttribute("aria-selected", idx === paletteIndex ? "true" : "false");
if (entry.kind === "session") div.classList.add("palette-session");
if (idx === paletteIndex) commandInput.setAttribute("aria-activedescendant", div.id);
```

Replace the current `div.innerHTML` assignment with a branch that uses the same escaped markup for every palette kind:

```js
div.innerHTML =
  '<span class="cmd">' + escapeHtml(c.cmd) + "</span>" +
  '<span class="desc">' +
    (c.desc ? escapeHtml(c.desc) : "") +
    (c.badge ? '<span class="badge">' + escapeHtml(c.badge) + "</span>" : "") +
  "</span>" +
  '<span class="hint-key">' + escapeHtml(c.hint || "↵") + "</span>";
```

In `hidePalette`, add:

```js
commandInput.setAttribute("aria-expanded", "false");
commandInput.removeAttribute("aria-activedescendant");
```

At the start of `runCommand`, after `trimmed` is normalized and before the `/`, `!`, `%`, or plain-text branches, add:

```js
if (trimmed.charAt(0) === "?") {
  commandInput.value = trimmed;
  openPalette(trimmed, true);
  syncComposerChrome();
  return;
}
```

This is the final guard that prevents a `?` query from reaching an active PTY if a click or future key path calls `runCommand` directly.

- [ ] **Step 7: Revalidate and activate selected sessions**

Harden `focusThread` so the thread is resolved again after file navigation and
inside the queued autofocus frame. Generic focus keeps visible exited or failed
panes viewable; composer search performs its stricter live-status validation
before calling focus. Composer activation passes `{ focusTerminal: false }`;
all other callers retain the default autofocus:

```js
async function focusThread(id, options) {
  function resolveFocusableThread() {
    var candidate = findThread(id);
    if (!candidate || candidate.hidden || candidate.closing ||
        candidate.closeStarted) return null;
    return candidate;
  }
  var thread = resolveFocusableThread();
  if (!thread) return false;
  if (!(await showTerminalView())) return false;
  thread = resolveFocusableThread();
  if (!thread) return false;
  markActiveSurface(thread.kind === "web" ? "browser" : "terminal");
  state.activeThreadId = id;
  if (thread.projectId && state.activeProjectId !== thread.projectId) {
    state.activeProjectId = thread.projectId;
  }
  var project = findProject(thread.projectId);
  if (project) {
    project.lastActiveThreadId = id;
    project.selectedWorktreePath = thread.worktreePath;
  }
  var layout = paneLayoutFor(thread.projectId, thread.worktreePath);
  var leaf = layout && PsychePanes.findLeafByThreadId(layout.root, id);
  if (layout && leaf) layout.focusedLeafId = leaf.id;
  renderPaneWorkspace();
  refreshSidebar();
  requestAnimationFrame(function () {
    var focusedThread = resolveFocusableThread();
    if (!focusedThread || state.activeThreadId !== id) return;
    scheduleVisiblePaneFit();
    if ((!options || options.focusTerminal !== false) && focusedThread.term) {
      focusedThread.term.focus();
    }
    syncBrowserBounds();
  });

  setProjectStatus(project, statusLevel(thread.status));
  if ((!options || options.refreshStatus !== false) &&
      typeof refreshStatusController === "function") {
    refreshStatusController();
  }
  return true;
}
```

Extend `openCovenSession(project, session, options)` so an existing attachment
still passes the caller options through project activation and `focusThread`.
For a new attachment, keep one option-neutral coalesced creation promise: use
`{ focusTerminal: false }` for its project activation and `createThread`, then
have every caller apply its own options with
`focusCovenAttachmentForCaller(opening, options)`. Immediately after the
terminal-layout frame, re-resolve the project, owned worktree, and Coven
session from current state before `createThread`; stale targets use the existing
neutral unavailable warning and return `null`. Extend `createThread` narrowly:

```js
focusThread(id, opts.focusTerminal === false ? { focusTerminal: false } : undefined);
```

Ordinary callers omit the option and keep terminal autofocus. Then add:

```js
function snapshotSetScopePresentation(thread) {
  var layout = paneLayoutForThread(thread);
  if (!layout) return null;
  return {
    projectId: thread.projectId,
    worktreePath: thread.worktreePath,
    layout: layout,
    root: layout.root,
    activeSetId: layout.activeSetId,
    maximizedLeafId: layout.maximizedLeafId,
    spanRoot: layout.spanRoot,
    spanSignature: layout.spanSignature,
  };
}

function restoreSetScopePresentation(snapshot, applied) {
  if (!snapshot || !applied || snapshot.layout !== applied.layout) return false;
  var layout = paneLayoutFor(snapshot.projectId, snapshot.worktreePath);
  if (layout !== snapshot.layout ||
      layout.root !== applied.root ||
      layout.activeSetId !== applied.activeSetId ||
      layout.maximizedLeafId !== applied.maximizedLeafId ||
      layout.spanRoot !== applied.spanRoot ||
      layout.spanSignature !== applied.spanSignature) return false;
  layout.activeSetId = snapshot.activeSetId;
  layout.maximizedLeafId = snapshot.maximizedLeafId;
  layout.spanRoot = snapshot.spanRoot;
  layout.spanSignature = snapshot.spanSignature;
  renderPaneWorkspace();
  refreshSidebar();
  return true;
}

async function runSessionSearchPick(pick) {
  var project = findProject(pick.projectId);
  if (!project) { toast("Session is no longer available"); return false; }
  if (pick.sessionSource === "psyche") {
    function resolveLocalThread() {
      var candidate = findThread(pick.sessionId);
      if (!candidate || candidate.projectId !== project.id || candidate.hidden ||
          candidate.closing || candidate.closeStarted ||
          isDormantThread(candidate) || candidate.status === "failed") return null;
      return candidate;
    }
    var thread = resolveLocalThread();
    if (!thread) {
      toast("Session is no longer available");
      return false;
    }
    if ((project.id !== state.activeProjectId ||
         project.selectedWorktreePath !== thread.worktreePath) &&
        !(await activateProjectWorktree(
          project, thread.worktreePath, { focusTerminal: false }
        ))) return false;
    project = findProject(pick.projectId);
    if (!project) return false;
    thread = resolveLocalThread();
    if (!thread) return false;
    var previousPresentation = snapshotSetScopePresentation(thread);
    var scopeChanged = applySetScopeForThread(thread);
    var appliedPresentation = scopeChanged
      ? snapshotSetScopePresentation(thread)
      : null;
    function restorePreviousPresentation() {
      if (!scopeChanged) return;
      restoreSetScopePresentation(previousPresentation, appliedPresentation);
    }
    var focused = await focusThread(thread.id, { focusTerminal: false });
    if (!focused) {
      restorePreviousPresentation();
      return false;
    }
    thread = resolveLocalThread();
    if (!thread || state.activeThreadId !== thread.id) {
      restorePreviousPresentation();
      return false;
    }
    settings.selectedSessionKey = pick.selectionKey;
    saveSettings();
    return true;
  }

  var session = covenSessionsForProject(project).find(function (candidate) {
    return candidate.id === pick.sessionId;
  });
  if (!session) {
    toast("Session is no longer available");
    return false;
  }
  var opened = await openCovenSession(
    project, session, { focusTerminal: false }
  );
  if (!opened) return false;
  settings.selectedSessionKey = pick.selectionKey;
  saveSettings();
  return true;
}
```

Make `runPalettePick` async, invalidate older activations when a newer pick
starts, capture the query, and restore composer UI/focus only while both still
match. Coven activation suppresses terminal autofocus at its source, so no
post-selection frame drain is needed:

```js
async function runPalettePick(pick, mode) {
  if (!pick) return;
  if (pick.kind === "session") {
    var activationGeneration = ++sessionSearchActivationGeneration;
    var activationQuery = commandInput.value;
    var selected = false;
    try {
      selected = await runSessionSearchPick(pick);
    } finally {
      var activationCurrent =
        activationGeneration === sessionSearchActivationGeneration &&
        commandInput.value === activationQuery;
      if (activationCurrent) {
        if (selected) {
          commandInput.value = "";
          hidePalette();
        }
        syncComposerChrome();
        commandInput.focus();
      }
    }
    return;
  }

  var runsImmediately = pick.kind === "agent" || pick.kind === "recent" ||
    pick.kind === "pane" || pick.kind === "shell" || mode === "run";
  if (runsImmediately) {
    runCommand(pick.cmd);
    commandInput.value = "";
    hidePalette();
    syncComposerChrome();
    commandInput.focus();
    return;
  }
  commandInput.value = pick.cmd + " ";
  hidePalette();
  syncComposerChrome();
  commandInput.focus();
}
```

Existing click and Enter callers may invoke the async function without awaiting
it. Older activations may still complete their requested session focus, but
their generation/query guard prevents them from clearing, hiding, or focusing
over a newer composer interaction.

- [ ] **Step 8: Make keyboard and composer chrome behavior explicit**

In the command-input keydown handler, use these exact guards before the existing non-palette Enter path:

```js
if (paletteVisible && e.key === "ArrowDown" && paletteFiltered.length > 0) {
  e.preventDefault();
  paletteIndex = (paletteIndex + 1) % paletteFiltered.length;
  renderPalette();
  return;
}
if (paletteVisible && e.key === "ArrowUp" && paletteFiltered.length > 0) {
  e.preventDefault();
  paletteIndex = (paletteIndex - 1 + paletteFiltered.length) % paletteFiltered.length;
  renderPalette();
  return;
}
if (paletteVisible && e.key === "Enter" && commandInput.value.charAt(0) === "?") {
  e.preventDefault();
  if (paletteFiltered[paletteIndex]) void runPalettePick(paletteFiltered[paletteIndex]);
  return;
}
if (paletteVisible && e.key === "Tab" && commandInput.value.charAt(0) === "?") {
  e.preventDefault();
  return;
}
if (paletteVisible && e.key === "Escape") {
  e.preventDefault();
  if (commandInput.value.charAt(0) === "?") commandInput.value = "";
  hidePalette();
  syncComposerChrome();
  commandInput.focus();
  return;
}
```

Replace `syncComposerChrome` with:

```js
function syncComposerChrome() {
  var rawValue = commandInput ? commandInput.value : "";
  var value = rawValue.trim();
  var sessionSearchOpen = rawValue.charAt(0) === "?";
  if (composerSendEl) {
    composerSendEl.hidden = sessionSearchOpen || value.length === 0;
    composerSendEl.firstChild.textContent = value[0] === "/" ? "Run " : "Send ";
  }
  if (composerMicEl) composerMicEl.hidden = value.length > 0;
  if (composerSendHintEl) {
    composerSendHintEl.textContent = !value || sessionSearchOpen
      ? ""
      : value[0] === "/" ? "runs command"
      : value[0] === "!" ? "runs in the focused terminal"
      : value[0] === "%" ? "jumps to a pane"
      : "→ focused pane";
  }
  commandInput.setAttribute(
    "aria-label",
    sessionSearchOpen
      ? "Search sessions, " + paletteFiltered.length +
        (paletteFiltered.length === 1 ? " result" : " results")
      : "Command composer",
  );
}
```

Typing or pasting a value whose first character is `?` opens the session palette through the existing input listener. Deleting that character closes the palette and restores the composer controls.

- [ ] **Step 9: Run the targeted composer tests to verify they pass**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriSessionSearchPalette.test.ts \
  __tests__/tauriComposerScope.test.ts \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriSidebarModel.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit composer session search**

```bash
git add \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/styles.css \
  native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriSessionSearchPalette.test.ts \
  __tests__/tauriThreadFocus.test.ts \
  __tests__/tauriComposerScope.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
git commit -m "feat(macos): move session search into composer"
```

### Task 4: Validate the Complete Shell and Search Integration

**Files:**
- Modify if a failing contract identifies an implementation defect:
  - `native/macos/psyche-build-tauri/web/index.html`
  - `native/macos/psyche-build-tauri/web/styles.css`
  - `native/macos/psyche-build-tauri/web/main.js`
  - `native/macos/psyche-build-tauri/web/sessions/sidebar-model.mjs`
  - `native/macos/psyche-build-tauri/web/sessions/sidebar-model.d.mts`
  - `native/macos/psyche-build-tauri/web/sessions/session-entry.js`
  - `__tests__/tauriWorkspaceRail.test.ts`
  - `__tests__/tauriFooterStatusBar.test.ts`
  - `__tests__/tauriThemeTokens.test.ts`
  - `__tests__/tauriSidebarModel.test.ts`
  - `__tests__/tauriSessionSearchPalette.test.ts`
  - `__tests__/tauriComposerScope.test.ts`

- [ ] **Step 1: Run all native-web contract and model tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriThemeTokens.test.ts \
  __tests__/tauriSidebarModel.test.ts \
  __tests__/tauriSessionSearchPalette.test.ts \
  __tests__/tauriComposerScope.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriWebBundles.test.ts
```

Expected: PASS.

- [ ] **Step 2: Build all checked-in native web bundles**

Run:

```bash
pnpm --filter psyche-build-tauri run build:web
git status --short
```

Expected: build exits with status 0. `git status --short` shows no unexpected generated-file changes beyond files already committed for this feature.

- [ ] **Step 3: Run test type-checking**

Run:

```bash
pnpm run typecheck:tests
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Inspect the final feature diff**

Run:

```bash
git --no-pager diff --check main...HEAD
git --no-pager diff --stat main...HEAD
git --no-pager diff main...HEAD -- \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/styles.css \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/sessions/sidebar-model.mjs \
  native/macos/psyche-build-tauri/web/sessions/sidebar-model.d.mts \
  native/macos/psyche-build-tauri/web/sessions/session-entry.js \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriThemeTokens.test.ts \
  __tests__/tauriSidebarModel.test.ts \
  __tests__/tauriSessionSearchPalette.test.ts \
  __tests__/tauriComposerScope.test.ts
```

Expected:

- `diff --check` prints no output.
- The title bar contains only brand/toggle chrome.
- Sidebar search and its `/` shortcut are absent.
- Sidebar tabs and filter chips remain.
- The workspace has only a top-left radius.
- The exposed top-left patch uses the sidebar surface.
- No bottom radius is introduced.
- `?` search includes empty-query results, a no-results state, keyboard/click selection, and stale-result guards.
- `/`, `!`, `%`, and plain text still use their previous paths.

- [ ] **Step 5: Commit any validation-driven correction**

If Steps 1-4 required a correction, stage the feature files and commit the correction:

```bash
git add \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/styles.css \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/sessions/sidebar-model.mjs \
  native/macos/psyche-build-tauri/web/sessions/sidebar-model.d.mts \
  native/macos/psyche-build-tauri/web/sessions/session-entry.js \
  native/macos/psyche-build-tauri/web/sessions.bundle.js \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriThemeTokens.test.ts \
  __tests__/tauriSidebarModel.test.ts \
  __tests__/tauriSessionSearchPalette.test.ts \
  __tests__/tauriComposerScope.test.ts \
  __tests__/tauriWebBundles.test.ts
git commit -m "fix(macos): complete Dia shell integration"
```

If no correction was required, do not create an empty commit.
