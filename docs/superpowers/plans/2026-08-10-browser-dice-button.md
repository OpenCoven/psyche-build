# Browser Dice Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dice icon button to every embedded browser pane that opens a fresh embedded tab at the fixed YouTube URL.

**Architecture:** Extend the existing unbundled Tauri browser toolbar with one accessible SVG icon button. Keep the destination and action in `main.js`: a dedicated helper creates a blank embedded tab through the established tab-limit flow, then navigates that exact tab by ID so the current tab is never replaced.

**Tech Stack:** Plain HTML, inline SVG, browser JavaScript, Tauri embedded webviews, Vitest, pnpm.

---

## File map

- Create `__tests__/tauriBrowserDiceButton.test.ts`
  - Contract-test toolbar placement, accessible text, the exact destination,
    new-tab behavior, and blank-tab availability.
- Modify `native/macos/psyche-build-tauri/web/index.html`
  - Add the dice icon button immediately before the external-open button.
- Modify `native/macos/psyche-build-tauri/web/main.js`
  - Define the fixed URL, implement `openDiceBrowserTab()`, and register the
    click handler.

No CSS, native Rust command, settings, or workspace persistence changes are
needed because the button reuses the existing `icon-btn ghost-btn` styles and
browser-tab APIs.

### Task 1: Add the dice-button contract and implementation

**Files:**
- Create: `__tests__/tauriBrowserDiceButton.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/index.html:304-316`
- Modify: `native/macos/psyche-build-tauri/web/main.js:5530-5590`
- Modify: `native/macos/psyche-build-tauri/web/main.js:5660-5680`

- [ ] **Step 1: Write the failing source-contract test**

Create `__tests__/tauriBrowserDiceButton.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const indexHtml = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/index.html'),
  'utf8',
);
const mainJs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);
const diceUrl =
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1&pp=ygUJcmljayByb2xsoAcB0gcJCckLAYcqIYzv';

describe('Tauri browser dice button', () => {
  it('places an accessible dice icon immediately before external open', () => {
    const toolbarStart = indexHtml.indexOf(
      '<header class="pane-header browser-bar">',
    );
    const toolbar = indexHtml.slice(
      toolbarStart,
      indexHtml.indexOf('</header>', toolbarStart),
    );

    expect(toolbarStart).toBeGreaterThanOrEqual(0);
    expect(toolbar).toMatch(
      /<button id="open-surprise" class="icon-btn ghost-btn" title="Open surprise in new tab" aria-label="Open surprise in new tab">[\s\S]*?<svg[\s\S]*?<\/svg>[\s\S]*?<\/button>\s*<button id="open-external"/,
    );
  });

  it('creates a new embedded tab and navigates that tab to the exact URL', () => {
    expect(mainJs).toContain(`var DICE_BROWSER_URL = "${diceUrl}";`);
    expect(mainJs).toMatch(
      /async function openDiceBrowserTab\(\) \{\s*var tab = await openBlankBrowserTab\(\);\s*if \(!tab\) return;\s*await navigateBrowser\(DICE_BROWSER_URL, \{ tabId: tab\.id \}\);\s*\}/,
    );
    expect(mainJs).toContain(
      'document.getElementById("open-surprise").addEventListener("click", openDiceBrowserTab);',
    );
  });

  it('keeps the dice action enabled when the current tab is blank', () => {
    const controls = mainJs.match(
      /function updateBrowserControls\(\) \{[\s\S]*?\n  \}/,
    )?.[0];

    expect(controls).toBeTruthy();
    expect(controls).not.toContain('open-surprise');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserDiceButton.test.ts
```

Expected: FAIL because `open-surprise`, `DICE_BROWSER_URL`, and
`openDiceBrowserTab()` do not exist.

- [ ] **Step 3: Add the toolbar button**

In `native/macos/psyche-build-tauri/web/index.html`, place this markup between
the URL input and `open-external`:

```html
            <button id="open-surprise" class="icon-btn ghost-btn" title="Open surprise in new tab" aria-label="Open surprise in new tab">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.35"/>
                <circle cx="5" cy="5" r="0.85" fill="currentColor"/>
                <circle cx="11" cy="5" r="0.85" fill="currentColor"/>
                <circle cx="8" cy="8" r="0.85" fill="currentColor"/>
                <circle cx="5" cy="11" r="0.85" fill="currentColor"/>
                <circle cx="11" cy="11" r="0.85" fill="currentColor"/>
              </svg>
            </button>
```

Keep the existing external-open button directly after it:

```html
            <button id="open-external" class="icon-btn ghost-btn" title="Open in default browser" aria-label="Open in default browser">↗</button>
```

- [ ] **Step 4: Add the fixed destination and new-tab helper**

In `native/macos/psyche-build-tauri/web/main.js`, add the destination beside the
browser-tab ID helper:

```js
  var DICE_BROWSER_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1&pp=ygUJcmljayByb2xsoAcB0gcJCckLAYcqIYzv";
  function makeBrowserTabId() { return "bt" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7); }
```

Immediately after `openBlankBrowserTab()`, add:

```js
  async function openDiceBrowserTab() {
    var tab = await openBlankBrowserTab({ requireNew: true });
    if (!tab) return;
    await navigateBrowser(DICE_BROWSER_URL, { tabId: tab.id });
  }
```

This ordering is required: `openBlankBrowserTab()` owns tab-limit messaging,
and navigation must receive the returned tab ID rather than using whichever tab
was previously active.

- [ ] **Step 5: Register the click handler**

In the browser control listener block in
`native/macos/psyche-build-tauri/web/main.js`, add the dice handler immediately
before the existing external-open handler:

```js
  document.getElementById("open-surprise").addEventListener("click", openDiceBrowserTab);
  document.getElementById("open-external").addEventListener("click", function () { var tab = currentBrowserTab(); if (tab && tab.url && tab.url !== "about:blank" && openUrl) openUrl(tab.url).catch(function () {}); });
```

Do not add `open-surprise` to `updateBrowserControls()`: the action must remain
enabled when no URL is loaded because it creates a new tab.

- [ ] **Step 6: Run the focused test and verify it passes**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserDiceButton.test.ts
```

Expected: PASS with 4 tests.

- [ ] **Step 7: Commit the feature**

```bash
git add __tests__/tauriBrowserDiceButton.test.ts \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/main.js
git commit -m "feat: add browser dice shortcut"
```

### Task 2: Run browser-pane regression checks

**Files:**
- Test: `__tests__/tauriBrowserDiceButton.test.ts`
- Test: `__tests__/tauriDesktopTabs.test.ts`
- Test: `__tests__/tauriWorkspacePanels.test.ts`

- [ ] **Step 1: Run the related browser-pane tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriBrowserDiceButton.test.ts \
  __tests__/tauriDesktopTabs.test.ts \
  __tests__/tauriWorkspacePanels.test.ts
```

Expected: PASS for all selected test files.

- [ ] **Step 2: Run the repository type checks**

Run:

```bash
pnpm run typecheck
```

Expected: exit code 0 with the application and test TypeScript checks passing.

- [ ] **Step 3: Check the final diff**

Run:

```bash
git diff --check HEAD^
git status --short
```

Expected: `git diff --check HEAD^` exits 0. `git status --short` is empty unless
the worktree already contained unrelated user changes.

