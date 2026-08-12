# Native Browser Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Destroy native browser webviews when their tabs or pane close, preserve dormant tab state for reopening, and keep native browser content hidden behind every interactive HTML overlay.

**Architecture:** Add explicit Tauri commands for closing one or many child webviews. In the frontend, centralize native browser visibility behind a serialized occlusion controller, preserve browser tab metadata independently from native view lifetime, and lazily recreate dormant tabs without changing history.

**Tech Stack:** Tauri 2, Rust, plain browser JavaScript, Vitest, pnpm, Cargo.

---

## File map

- Create `__tests__/tauriBrowserLifecycle.test.ts`
  - Contract-test native destroy commands, browser tab/pane teardown, dormant
    tab restoration, occlusion state, and overlay wiring.
- Modify `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`
  - Add single and batch child-webview destruction commands and register them.
- Modify `native/macos/psyche-build-tauri/web/main.js`
  - Add browser teardown helpers, dormant-tab restoration, serialized native
    visibility syncing, and overlay occlusion calls.

No CSS or HTML changes are required. The overlays already have the intended
appearance; they are currently covered because native child webviews are
outside the HTML stacking context.

### Task 1: Add native child-webview destruction

**Files:**
- Create: `__tests__/tauriBrowserLifecycle.test.ts`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:780-870`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:2280-2300`

- [ ] **Step 1: Write the failing native command contract**

Create `__tests__/tauriBrowserLifecycle.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const repoRoot = process.cwd();
const mainJs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);
const nativeLib = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/src-tauri/src/lib.rs'),
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
  source: string,
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(...names, `"use strict"; return (${source});`)(...values) as T;
}

describe('Tauri native browser lifecycle', () => {
  it('registers idempotent single and batch webview destruction commands', () => {
    expect(nativeLib).toMatch(
      /fn destroy_browser_webview\([\s\S]*app\.get_webview\(&label\)[\s\S]*webview\.close\(\)/,
    );
    expect(nativeLib).toMatch(
      /fn browser_destroy\([\s\S]*destroy_browser_webview\(&app,\s*label\)/,
    );
    expect(nativeLib).toMatch(
      /fn browser_destroy_many\([\s\S]*for label in labels[\s\S]*destroy_browser_webview\(&app,\s*Some\(label\)\)/,
    );
    expect(nativeLib).toMatch(
      /tauri::generate_handler!\s*\[[\s\S]*browser_destroy\s*,\s*browser_destroy_many\s*,/,
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserLifecycle.test.ts
```

Expected: FAIL because `browser_destroy` and `browser_destroy_many` do not
exist.

- [ ] **Step 3: Add the native destruction commands**

In `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`, immediately after
`browser_hide_all_except`, add:

```rust
fn destroy_browser_webview(
    app: &AppHandle,
    label: Option<String>,
) -> Result<(), String> {
    let label = safe_browser_label(label);
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn browser_destroy(app: AppHandle, label: Option<String>) -> Result<(), String> {
    destroy_browser_webview(&app, label)
}

#[tauri::command]
fn browser_destroy_many(app: AppHandle, labels: Vec<String>) -> Result<(), String> {
    for label in labels {
        destroy_browser_webview(&app, Some(label))?;
    }
    Ok(())
}
```

Register both commands immediately after `browser_hide_all_except`:

```rust
            browser_hide_all_except,
            browser_destroy,
            browser_destroy_many,
            browser_reload,
```

`Webview::close()` removes the child webview from Tauri's manager. Looking up a
missing label remains a successful no-op, making repeated cleanup safe.

- [ ] **Step 4: Run the focused test and Rust check**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserLifecycle.test.ts
pnpm --dir native/macos/psyche-build-tauri exec cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: the Vitest file passes and Cargo exits with code 0.

- [ ] **Step 5: Commit the native lifecycle**

```bash
git add __tests__/tauriBrowserLifecycle.test.ts \
  native/macos/psyche-build-tauri/src-tauri/src/lib.rs
git commit -m "feat: add native browser teardown commands"
```

### Task 2: Destroy tab views and preserve dormant pane state

**Files:**
- Modify: `__tests__/tauriBrowserLifecycle.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js:3530-3550`
- Modify: `native/macos/psyche-build-tauri/web/main.js:5345-5410`
- Modify: `native/macos/psyche-build-tauri/web/main.js:6875-6970`

- [ ] **Step 1: Add failing tab, pane, and restoration tests**

Append these tests inside the existing `describe` block:

```ts
  it('removes a tab only after its native view is destroyed', async () => {
    const browser = {
      tabs: [
        { id: 'one', created: true },
        { id: 'two', created: true },
      ],
      activeTabId: 'one',
    };
    const invokes: Array<[string, unknown]> = [];
    const closeBrowserTab = compileFunction<
      (project: { id: string }, tabId: string) => Promise<boolean>
    >(functionSource('closeBrowserTab'), {
      ensureBrowserModel: () => browser,
      browserLabelForTab: (_project: unknown, tab: { id: string }) => `p__${tab.id}`,
      invoke: async (command: string, payload: unknown) => {
        invokes.push([command, payload]);
      },
      renderBrowserTabs: vi.fn(),
      syncProjectBrowser: vi.fn(),
      saveWorkspaceSoon: vi.fn(),
      setStatus: vi.fn(),
    });

    await expect(closeBrowserTab({ id: 'p' }, 'one')).resolves.toBe(true);
    expect(invokes).toEqual([
      ['browser_destroy', { label: 'p__one' }],
    ]);
    expect(browser).toEqual({
      tabs: [{ id: 'two', created: true }],
      activeTabId: 'two',
    });
  });

  it('retains a tab when native destruction fails', async () => {
    const browser = {
      tabs: [{ id: 'one', created: true }],
      activeTabId: 'one',
    };
    const setStatus = vi.fn();
    const closeBrowserTab = compileFunction<
      (project: { id: string }, tabId: string) => Promise<boolean>
    >(functionSource('closeBrowserTab'), {
      ensureBrowserModel: () => browser,
      browserLabelForTab: () => 'p__one',
      invoke: async () => { throw new Error('close failed'); },
      renderBrowserTabs: vi.fn(),
      syncProjectBrowser: vi.fn(),
      saveWorkspaceSoon: vi.fn(),
      setStatus,
    });

    await expect(closeBrowserTab({ id: 'p' }, 'one')).resolves.toBe(false);
    expect(browser.tabs).toHaveLength(1);
    expect(setStatus).toHaveBeenCalledWith(
      'browser tab close failed: Error: close failed',
      'error',
    );
  });

  it('destroys pane views and marks retained tabs dormant before closing', async () => {
    const tabs = [
      { id: 'one', created: true, loading: true, url: 'https://one.test' },
      { id: 'two', created: true, loading: false, url: 'https://two.test' },
    ];
    const project = { id: 'p' };
    const thread = { id: 'web-1', kind: 'web', projectId: 'p', worktreePath: '/repo' };
    const calls: string[] = [];
    const closeBrowserPane = compileFunction<
      (value: typeof thread) => Promise<boolean>
    >(functionSource('closeBrowserPane'), {
      findProject: () => project,
      ensureBrowserModel: () => ({ tabs }),
      browserLabelForTab: (_project: unknown, tab: { id: string }) => `p__${tab.id}`,
      invoke: async (command: string) => { calls.push(command); },
      saveWorkspaceSoon: vi.fn(),
      stageBrowserSurface: () => { calls.push('stage'); },
      closeThread: () => { calls.push('close-thread'); return true; },
      state: { activeThreadId: 'web-1' },
      markActiveSurface: vi.fn(),
      setStatus: vi.fn(),
    });

    await expect(closeBrowserPane(thread)).resolves.toBe(true);
    expect(calls).toEqual(['browser_destroy_many', 'stage', 'close-thread']);
    expect(tabs).toEqual([
      { id: 'one', created: false, loading: false, url: 'https://one.test' },
      { id: 'two', created: false, loading: false, url: 'https://two.test' },
    ]);
  });

  it('restores a dormant saved URL without adding history', async () => {
    const tab = {
      id: 'one',
      created: false,
      url: 'https://one.test',
      history: ['https://one.test'],
      historyIndex: 0,
    };
    const navigateBrowser = vi.fn(async (
      _url: string,
      options: { preserveHistory: boolean },
    ) => {
      expect(options.preserveHistory).toBe(true);
      tab.created = true;
    });
    const restoreDormantBrowserTab = compileFunction<
      (project: unknown, value: typeof tab) => Promise<boolean>
    >(functionSource('restoreDormantBrowserTab'), { navigateBrowser });

    await expect(restoreDormantBrowserTab({}, tab)).resolves.toBe(true);
    expect(navigateBrowser).toHaveBeenCalledWith(
      'https://one.test',
      { tabId: 'one', preserveHistory: true },
    );
    expect(tab.history).toEqual(['https://one.test']);
    expect(tab.historyIndex).toBe(0);
  });
```

- [ ] **Step 2: Run the focused test and verify the new cases fail**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserLifecycle.test.ts
```

Expected: FAIL because tab and pane close are synchronous and
`restoreDormantBrowserTab` does not exist.

- [ ] **Step 3: Make tab close transactional**

Replace `closeBrowserTab` in `main.js` with:

```js
  async function closeBrowserTab(project, tabId) {
    project = project || activeProject();
    var browser = ensureBrowserModel(project);
    if (!browser) return false;
    var idx = browser.tabs.findIndex(function (tab) { return tab.id === tabId; });
    if (idx < 0) return false;
    var tab = browser.tabs[idx];
    try {
      await invoke("browser_destroy", {
        label: browserLabelForTab(project, tab),
      });
    } catch (error) {
      setStatus("browser tab close failed: " + String(error), "error");
      return false;
    }
    browser.tabs.splice(idx, 1);
    if (browser.activeTabId === tabId) {
      var next = browser.tabs[Math.min(idx, browser.tabs.length - 1)] || null;
      browser.activeTabId = next ? next.id : null;
    }
    renderBrowserTabs();
    syncProjectBrowser();
    saveWorkspaceSoon();
    return true;
  }
```

Change the tab click listener in `renderBrowserTabs()` to await close:

```js
      btn.addEventListener("click", async function (event) {
        if (event.target && event.target.classList.contains("browser-tab-close")) {
          await closeBrowserTab(project, tab.id);
        } else {
          await activateBrowserTab(project, tab.id);
        }
      });
```

- [ ] **Step 4: Add dormant-tab restoration**

Add immediately before `activateBrowserTab`:

```js
  async function restoreDormantBrowserTab(project, tab) {
    if (!tab || tab.created || !tab.url || tab.url === "about:blank") return false;
    await navigateBrowser(tab.url, {
      tabId: tab.id,
      preserveHistory: true,
    });
    return !!tab.created;
  }
```

Replace `activateBrowserTab` with:

```js
  async function activateBrowserTab(project, tabId) {
    project = project || activeProject();
    var browser = ensureBrowserModel(project);
    if (!browser) return false;
    var tab = browser.tabs.find(function (candidate) {
      return candidate.id === tabId;
    });
    if (!tab) return false;
    markActiveSurface("browser");
    browser.activeTabId = tabId;
    renderBrowserTabs();
    syncProjectBrowser();
    saveWorkspaceSoon();
    if (!tab.created) await restoreDormantBrowserTab(project, tab);
    return true;
  }
```

In `openBlankBrowserTab`, restore an existing active dormant tab after
`syncProjectBrowser()`:

```js
    syncProjectBrowser();
    var activeTab = currentBrowserTab(project);
    if (!options.requireNew && activeTab && !activeTab.created) {
      await restoreDormantBrowserTab(project, activeTab);
    }
    if (urlInput) urlInput.focus();
    return tab || (options.requireNew ? null : activeTab);
```

- [ ] **Step 5: Destroy pane views while preserving its browser model**

Replace `closeBrowserPane` with:

```js
  async function closeBrowserPane(thread) {
    if (!thread || thread.kind !== "web") return false;
    var project = findProject(thread.projectId);
    if (!project) return false;
    var browser = ensureBrowserModel(project, thread.worktreePath);
    var labels = browser.tabs.map(function (tab) {
      return browserLabelForTab(project, tab);
    });
    try {
      if (labels.length) {
        await invoke("browser_destroy_many", { labels: labels });
      }
    } catch (error) {
      setStatus("browser pane close failed: " + String(error), "error");
      return false;
    }
    browser.tabs.forEach(function (tab) {
      tab.created = false;
      tab.loading = false;
    });
    saveWorkspaceSoon();
    var wasActive = state.activeThreadId === thread.id;
    stageBrowserSurface();
    var closed = closeThread(thread.id);
    if (closed && wasActive) markActiveSurface("terminal");
    return closed;
  }
```

The existing Web pane close button and context action already call
`closeBrowserPane(thread)`.

- [ ] **Step 6: Route sidebar and command closes through Web pane cleanup**

Add before `armSessionClose`:

```js
  function requestThreadClose(thread) {
    if (!thread) return Promise.resolve(false);
    if (thread.kind === "web") return closeBrowserPane(thread);
    return Promise.resolve(closeThread(thread.id));
  }
```

In the session close confirmation, replace:

```js
      closeThread(thread.id);
```

with:

```js
      requestThreadClose(thread);
```

Change the `/close` command to:

```js
      run: function () {
        var thread = findThread(state.activeThreadId);
        if (thread) requestThreadClose(thread);
      },
```

- [ ] **Step 7: Run the focused lifecycle and pane tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriBrowserLifecycle.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriDesktopTabs.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit frontend destruction and restoration**

```bash
git add __tests__/tauriBrowserLifecycle.test.ts \
  native/macos/psyche-build-tauri/web/main.js
git commit -m "fix: release closed browser webviews"
```

### Task 3: Add serialized browser occlusion

**Files:**
- Modify: `__tests__/tauriBrowserLifecycle.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js:735-765`
- Modify: `native/macos/psyche-build-tauri/web/main.js:6980-7020`

- [ ] **Step 1: Add failing occlusion controller tests**

Append:

```ts
  it('tracks idempotent and overlapping browser occlusion reasons', () => {
    const reasons = new Set<string>();
    const syncBrowserBounds = vi.fn();
    const setBrowserOccluded = compileFunction<
      (reason: string, occluded: boolean) => boolean
    >(functionSource('setBrowserOccluded'), {
      browserOcclusionReasons: reasons,
      syncBrowserBounds,
    });

    expect(setBrowserOccluded('agent-picker', true)).toBe(true);
    expect(setBrowserOccluded('agent-picker', true)).toBe(false);
    expect(setBrowserOccluded('scope-menu', true)).toBe(true);
    expect(setBrowserOccluded('agent-picker', false)).toBe(true);
    expect(reasons).toEqual(new Set(['scope-menu']));
    expect(setBrowserOccluded('scope-menu', false)).toBe(true);
    expect(reasons.size).toBe(0);
    expect(syncBrowserBounds).toHaveBeenCalledTimes(4);
  });

  it('keeps all native browsers hidden while any occlusion reason is active', async () => {
    const invoke = vi.fn(async () => undefined);
    const performBrowserBoundsSync = compileFunction<
      () => Promise<boolean>
    >(functionSource('performBrowserBoundsSync'), {
      browserIsOccluded: () => true,
      activeProject: () => ({ id: 'p' }),
      currentBrowserTab: () => ({ id: 'one', created: true }),
      browserLabelForTab: () => 'p__one',
      visibleBrowserBounds: () => ({ x: 1, y: 2, w: 300, h: 200 }),
      invoke,
    });

    await expect(performBrowserBoundsSync()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'browser_hide_all_except',
      { label: null },
    );
  });

  it('serializes visibility operations and reports native failures', () => {
    expect(functionSource('syncBrowserBounds')).toMatch(
      /browserVisibilitySync = browserVisibilitySync[\s\S]*performBrowserBoundsSync[\s\S]*catch/,
    );
    expect(functionSource('syncBrowserBounds')).toContain(
      'setStatus("browser visibility failed: " + String(error), "error")',
    );
  });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserLifecycle.test.ts
```

Expected: FAIL because the occlusion controller does not exist.

- [ ] **Step 3: Add shared controller state**

Beside the existing browser element references near the top of `main.js`, add:

```js
  var browserOcclusionReasons = new Set();
  var browserVisibilitySync = Promise.resolve(true);
```

Add near the browser preview helpers:

```js
  function browserIsOccluded() {
    return browserOcclusionReasons.size > 0;
  }

  function setBrowserOccluded(reason, occluded) {
    if (!reason) return false;
    var changed;
    if (occluded) {
      var previousSize = browserOcclusionReasons.size;
      browserOcclusionReasons.add(reason);
      changed = browserOcclusionReasons.size !== previousSize;
    } else {
      changed = browserOcclusionReasons.delete(reason);
    }
    if (!changed) return false;
    syncBrowserBounds();
    return true;
  }
```

- [ ] **Step 4: Serialize native visibility commands**

Replace `syncBrowserBounds` with:

```js
  function performBrowserBoundsSync() {
    var project = activeProject();
    var tab = currentBrowserTab(project);
    var label = browserLabelForTab(project, tab);
    var bounds = visibleBrowserBounds();
    if (browserIsOccluded() || !bounds || !tab || !tab.created) {
      return invoke("browser_hide_all_except", { label: null }).then(function () {
        return true;
      });
    }
    return invoke("browser_hide_all_except", { label: label }).then(function () {
      return invoke("browser_set_bounds", {
        label: label,
        x: bounds.x,
        y: bounds.y,
        w: bounds.w,
        h: bounds.h,
      });
    }).then(function () {
      return true;
    });
  }

  function syncBrowserBounds() {
    browserVisibilitySync = browserVisibilitySync.then(
      performBrowserBoundsSync,
      performBrowserBoundsSync
    ).catch(function (error) {
      setStatus("browser visibility failed: " + String(error), "error");
      return false;
    });
    return browserVisibilitySync;
  }
```

This replaces the existing swallowed errors and prevents an older hide request
from completing after a newer restore request.

- [ ] **Step 5: Keep navigation hidden while occluded**

In `navigateBrowser`, replace the bounds passed to `browser_navigate` with:

```js
    var nativeBounds = browserIsOccluded()
      ? { x: -10000, y: -10000, w: 1, h: 1 }
      : b;
```

Then invoke with:

```js
    invoke("browser_navigate", {
      label: label,
      url: normalised,
      x: nativeBounds.x,
      y: nativeBounds.y,
      w: nativeBounds.w,
      h: nativeBounds.h,
    }).then(function () {
```

At the end of the successful navigation callback, replace the direct
`browser_hide_all_except` invocation with:

```js
      renderBrowserTabs();
      syncUrlInput();
      saveWorkspaceSoon();
      syncBrowserBounds();
```

- [ ] **Step 6: Run the focused tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriBrowserLifecycle.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriBrowserDiceButton.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the occlusion controller**

```bash
git add __tests__/tauriBrowserLifecycle.test.ts \
  native/macos/psyche-build-tauri/web/main.js
git commit -m "fix: serialize native browser visibility"
```

### Task 4: Wire every interactive overlay into occlusion

**Files:**
- Modify: `__tests__/tauriBrowserLifecycle.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js:3690-3745`
- Modify: `native/macos/psyche-build-tauri/web/main.js:4240-4660`
- Modify: `native/macos/psyche-build-tauri/web/main.js:5480-5530`
- Modify: `native/macos/psyche-build-tauri/web/main.js:6525-6710`
- Modify: `native/macos/psyche-build-tauri/web/main.js:7280-7310`
- Modify: `native/macos/psyche-build-tauri/web/main.js:7445-7460`
- Modify: `native/macos/psyche-build-tauri/web/main.js:8340-8360`

- [ ] **Step 1: Add a failing overlay wiring contract**

Append:

```ts
  it('occludes the browser for every interactive HTML overlay', () => {
    const requiredCalls = [
      'setBrowserOccluded("session-context-menu", true)',
      'setBrowserOccluded("session-context-menu", false)',
      'setBrowserOccluded("pane-usage-popover", true)',
      'setBrowserOccluded("pane-usage-popover", false)',
      'setBrowserOccluded(paneFooterMenuOcclusionReason(thread), true)',
      'setBrowserOccluded(paneFooterMenuOcclusionReason(thread), false)',
      'setBrowserOccluded("dirty-file-dialog", true)',
      'setBrowserOccluded("dirty-file-dialog", false)',
      'setBrowserOccluded("scope-menu", true)',
      'setBrowserOccluded("scope-menu", false)',
      'setBrowserOccluded("command-palette", true)',
      'setBrowserOccluded("command-palette", false)',
      'setBrowserOccluded("new-pane-menu", true)',
      'setBrowserOccluded("new-pane-menu", false)',
      'setBrowserOccluded("help-overlay", open)',
      'setBrowserOccluded("agent-picker", true)',
      'setBrowserOccluded("agent-picker", false)',
    ];

    for (const call of requiredCalls) {
      expect(mainJs, call).toContain(call);
    }
  });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserLifecycle.test.ts
```

Expected: FAIL on the first missing `setBrowserOccluded` call.

- [ ] **Step 3: Wire context menus and pane footer overlays**

Update `closeSessionContextMenu`:

```js
  function closeSessionContextMenu() {
    if (sessionContextMenu && sessionContextMenu.parentNode) {
      sessionContextMenu.parentNode.removeChild(sessionContextMenu);
    }
    sessionContextMenu = null;
    setBrowserOccluded("session-context-menu", false);
  }
```

After assigning `sessionContextMenu = menu` in `openSessionContextMenu`, add:

```js
    setBrowserOccluded("session-context-menu", true);
```

At the end of `closePaneFooterPopovers`, before focus restoration, add:

```js
    setBrowserOccluded("pane-usage-popover", false);
```

After positioning the usage popover in `openPaneUsagePopover`, add:

```js
    setBrowserOccluded("pane-usage-popover", true);
```

Add before `closePaneFooterMenu`:

```js
  function paneFooterMenuOcclusionReason(thread) {
    return "pane-footer-menu:" + (thread ? thread.id : "unknown");
  }
```

At the end of `closePaneFooterMenu`, before focus restoration, add:

```js
    setBrowserOccluded(paneFooterMenuOcclusionReason(thread), false);
```

After positioning the overflow menu in `syncPaneFooter`, add:

```js
    setBrowserOccluded(paneFooterMenuOcclusionReason(thread), true);
```

- [ ] **Step 4: Wire the dirty-file dialog**

Inside `settle`, immediately after closing the dialog, add:

```js
        setBrowserOccluded("dirty-file-dialog", false);
```

Immediately before `dirtyFileDialogEl.showModal()`, add:

```js
      setBrowserOccluded("dirty-file-dialog", true);
```

Wrap `showModal()` so a browser does not remain permanently occluded if the
dialog API throws:

```js
      try {
        dirtyFileDialogEl.showModal();
      } catch (error) {
        setBrowserOccluded("dirty-file-dialog", false);
        fileDecisionInFlight = null;
        setStatus("file decision dialog failed: " + String(error), "error");
        resolve(fallback);
        return;
      }
```

- [ ] **Step 5: Wire scope, command palette, and new-pane menus**

Update `closeScopeMenu`:

```js
  function closeScopeMenu() {
    if (scopeMenuEl) scopeMenuEl.hidden = true;
    if (scopeBtnEl) scopeBtnEl.setAttribute("aria-expanded", "false");
    setBrowserOccluded("scope-menu", false);
  }
```

After toggling `scopeMenuEl.hidden`, add:

```js
      setBrowserOccluded("scope-menu", open);
```

At the end of `openPalette`, add:

```js
    setBrowserOccluded("command-palette", true);
```

At the end of `hidePalette`, add:

```js
    setBrowserOccluded("command-palette", false);
```

Update `closeNewPaneMenu`:

```js
  function closeNewPaneMenu() {
    if (newPaneMenuEl) newPaneMenuEl.hidden = true;
    var trigger = document.getElementById("rail-new-tab");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    setBrowserOccluded("new-pane-menu", false);
  }
```

After toggling `newPaneMenuEl.hidden`, add:

```js
    setBrowserOccluded("new-pane-menu", open);
```

- [ ] **Step 6: Wire help and agent picker modals**

Replace `setHelpOpen` with:

```js
  function setHelpOpen(open) {
    if (!helpOverlayEl) return;
    if (open) renderHelpRows();
    helpOverlayEl.hidden = !open;
    setBrowserOccluded("help-overlay", open);
  }
```

In `openAgentPicker`, immediately before showing the overlay, add:

```js
    setBrowserOccluded("agent-picker", true);
```

Update the beginning of `closeAgentPicker`:

```js
  function closeAgentPicker() {
    if (agentPickerOverlayEl) agentPickerOverlayEl.hidden = true;
    setBrowserOccluded("agent-picker", false);
```

- [ ] **Step 7: Run overlay and regression tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriBrowserLifecycle.test.ts \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriPaneFooter.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit overlay occlusion**

```bash
git add __tests__/tauriBrowserLifecycle.test.ts \
  native/macos/psyche-build-tauri/web/main.js
git commit -m "fix: hide browser behind interactive overlays"
```

### Task 5: Destroy browser views when removing a project

**Files:**
- Modify: `__tests__/tauriBrowserLifecycle.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js:5345-5410`

- [ ] **Step 1: Add a failing project cleanup contract**

Append:

```ts
  it('destroys all project browser views before removing project state', () => {
    const source = functionSource('removeProject');
    expect(source).toMatch(
      /await destroyProjectBrowserViews\(project\)[\s\S]*state\.projects = state\.projects\.filter/,
    );
    expect(source).toContain(
      'setStatus("project browser close failed: " + String(error), "error")',
    );
  });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserLifecycle.test.ts
```

Expected: FAIL because project removal still leaves native browser webviews
alive.

- [ ] **Step 3: Add project-wide browser teardown**

Add before `removeProject`:

```js
  async function destroyProjectBrowserViews(project) {
    var tabs = [];
    Object.keys(project.browsersByWorktree || {}).forEach(function (workspaceRoot) {
      var browser = ensureBrowserModel(project, workspaceRoot);
      browser.tabs.forEach(function (tab) {
        tabs.push(tab);
      });
    });
    var labels = tabs.map(function (tab) {
      return browserLabelForTab(project, tab);
    });
    if (labels.length) {
      await invoke("browser_destroy_many", { labels: labels });
    }
    tabs.forEach(function (tab) {
      tab.created = false;
      tab.loading = false;
    });
  }
```

In `removeProject`, after dirty-file approval and before closing threads, add:

```js
    try {
      await destroyProjectBrowserViews(project);
    } catch (error) {
      setStatus("project browser close failed: " + String(error), "error");
      return false;
    }
```

- [ ] **Step 4: Run project and lifecycle tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriBrowserLifecycle.test.ts \
  __tests__/tauriDesktopTabs.test.ts \
  __tests__/tauriWorkspacePanels.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit project cleanup**

```bash
git add __tests__/tauriBrowserLifecycle.test.ts \
  native/macos/psyche-build-tauri/web/main.js
git commit -m "fix: tear down browser views with projects"
```

### Task 6: Run complete validation

**Files:**
- Test: `__tests__/tauriBrowserLifecycle.test.ts`
- Test: `__tests__/tauriAgentPicker.test.ts`
- Test: `__tests__/tauriBrowserDiceButton.test.ts`
- Test: `__tests__/tauriDesktopTabs.test.ts`
- Test: `__tests__/tauriPaneFooter.test.ts`
- Test: `__tests__/tauriPhysicalPanes.test.ts`
- Test: `__tests__/tauriWorkspaceEditorIntegration.test.ts`
- Test: `__tests__/tauriWorkspacePanels.test.ts`
- Test: `__tests__/tauriWorkspaceRail.test.ts`

- [ ] **Step 1: Run all browser and overlay regressions together**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriBrowserLifecycle.test.ts \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriBrowserDiceButton.test.ts \
  __tests__/tauriDesktopTabs.test.ts \
  __tests__/tauriPaneFooter.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run TypeScript checks**

Run:

```bash
pnpm run typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Run the native Rust check**

Run:

```bash
pnpm --dir native/macos/psyche-build-tauri exec cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: exit code 0.

- [ ] **Step 4: Check the final change set**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` exits 0. Status contains no uncommitted files from
this implementation; unrelated pre-existing user changes may remain.
