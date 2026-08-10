# Disappearing Panel Headers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every terminal and tool panel a semi-transparent glass-hairline header that collapses after intentional scrolling and reveals safely through the top edge or keyboard focus.

**Architecture:** A pure `HeaderVisibilityController` owns threshold, reveal, pinning, and cleanup state for one header/scroll surface. `main.js` creates independent controller instances for terminal panes and tool panels, while CSS renders the approved glass treatment from a single `is-header-hidden` class.

**Tech Stack:** Browser JavaScript modules, DOM events, xterm.js viewport integration, CSS, esbuild, Vitest.

---

## File structure

- Create `native/macos/psyche-build-tauri/web/headers/header-visibility.mjs`
  - Pure controller for scroll accumulation, reveal, focus/gesture pinning, and cleanup.
- Create `native/macos/psyche-build-tauri/web/headers/header-entry.js`
  - Browser-global exports for `PsycheHeaders`.
- Create `__tests__/tauriHeaderVisibility.test.ts`
  - Controller behavior and integration source contracts.
- Modify `native/macos/psyche-build-tauri/package.json`
  - Build `headers.bundle.js`.
- Modify `native/macos/psyche-build-tauri/web/index.html`
  - Load the header bundle and add reveal zones to static tool panels.
- Modify `native/macos/psyche-build-tauri/web/main.js`
  - Bind terminal and tool controllers, pin gestures/controls, and destroy stale bindings.
- Modify `native/macos/psyche-build-tauri/web/styles.css`
  - Glass-hairline treatment, collapsed state, reveal zones, and reduced motion.
- Modify `__tests__/tauriPhysicalPanes.test.ts`
  - Terminal controller integration and pane cleanup contracts.
- Modify `__tests__/tauriWorkspacePanels.test.ts`
  - Tool-panel markup, bundle ordering, and panel binding contracts.
- Modify `docs/SMOKE.md`
  - Manual disappearing-header acceptance flow.

### Task 1: Build the reusable header visibility controller

**Files:**
- Create: `native/macos/psyche-build-tauri/web/headers/header-visibility.mjs`
- Create: `native/macos/psyche-build-tauri/web/headers/header-entry.js`
- Create: `__tests__/tauriHeaderVisibility.test.ts`
- Modify: `native/macos/psyche-build-tauri/package.json`
- Modify: `native/macos/psyche-build-tauri/web/index.html`

- [ ] **Step 1: Write failing controller tests**

Create `__tests__/tauriHeaderVisibility.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const headersRoot = join(
  repoRoot,
  'native/macos/psyche-build-tauri/web/headers',
);
const headers = await import(
  pathToFileURL(join(headersRoot, 'header-visibility.mjs')).href,
);

class FakeTarget {
  listeners = new Map<string, Set<(event: any) => void>>();
  classes = new Set<string>();
  classList = {
    toggle: (name: string, enabled: boolean) => {
      if (enabled) this.classes.add(name);
      else this.classes.delete(name);
    },
  };
  addEventListener(name: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name: string, listener: (event: any) => void) {
    this.listeners.get(name)?.delete(listener);
  }
  dispatch(name: string, event: any = {}) {
    this.listeners.get(name)?.forEach((listener) => listener(event));
  }
  contains(target: unknown) {
    return target === this;
  }
}

function fixture(threshold = 24) {
  const root = new FakeTarget();
  const scroll = new FakeTarget();
  const reveal = new FakeTarget();
  const header = new FakeTarget();
  const controller = headers.createHeaderVisibilityController({
    root,
    header,
    scrollTarget: scroll,
    revealTarget: reveal,
    threshold,
  });
  return { root, scroll, reveal, header, controller };
}

describe('header visibility controller', () => {
  it('hides only after accumulated downward scroll crosses the threshold', () => {
    const value = fixture();
    value.scroll.dispatch('wheel', { deltaX: 0, deltaY: 10 });
    expect(value.root.classes.has('is-header-hidden')).toBe(false);
    value.scroll.dispatch('wheel', { deltaX: 0, deltaY: 15 });
    expect(value.root.classes.has('is-header-hidden')).toBe(true);
  });

  it('ignores horizontal scroll, upward movement, and tiny jitter', () => {
    const value = fixture();
    value.scroll.dispatch('wheel', { deltaX: 30, deltaY: 2 });
    value.scroll.dispatch('wheel', { deltaX: 0, deltaY: -30 });
    value.scroll.dispatch('wheel', { deltaX: 0, deltaY: 3 });
    expect(value.root.classes.has('is-header-hidden')).toBe(false);
  });

  it('reveals from the top edge and resets accumulation', () => {
    const value = fixture(10);
    value.scroll.dispatch('wheel', { deltaY: 11, deltaX: 0 });
    value.reveal.dispatch('pointerenter');
    expect(value.root.classes.has('is-header-hidden')).toBe(false);
    value.scroll.dispatch('wheel', { deltaY: 9, deltaX: 0 });
    expect(value.root.classes.has('is-header-hidden')).toBe(false);
  });

  it('reveals and pins while focus remains inside the header', () => {
    const value = fixture(10);
    value.scroll.dispatch('wheel', { deltaY: 11, deltaX: 0 });
    value.header.dispatch('focusin');
    value.scroll.dispatch('wheel', { deltaY: 100, deltaX: 0 });
    expect(value.root.classes.has('is-header-hidden')).toBe(false);
    value.header.dispatch('focusout', { relatedTarget: null });
    value.scroll.dispatch('wheel', { deltaY: 11, deltaX: 0 });
    expect(value.root.classes.has('is-header-hidden')).toBe(true);
  });

  it('supports explicit gesture pinning and independent instances', () => {
    const first = fixture(10);
    const second = fixture(10);
    first.controller.pin();
    first.scroll.dispatch('wheel', { deltaY: 11, deltaX: 0 });
    second.scroll.dispatch('wheel', { deltaY: 11, deltaX: 0 });
    expect(first.root.classes.has('is-header-hidden')).toBe(false);
    expect(second.root.classes.has('is-header-hidden')).toBe(true);
    first.controller.unpin();
  });

  it('removes listeners and stops mutating state after destroy', () => {
    const value = fixture(10);
    value.controller.destroy();
    value.scroll.dispatch('wheel', { deltaY: 20, deltaX: 0 });
    expect(value.root.classes.has('is-header-hidden')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm the module is absent**

Run:

```bash
pnpm vitest --run __tests__/tauriHeaderVisibility.test.ts
```

Expected: FAIL because `header-visibility.mjs` does not exist.

- [ ] **Step 3: Implement the controller**

Create `web/headers/header-visibility.mjs`:

```js
export function createHeaderVisibilityController(options) {
  const root = options.root;
  const header = options.header;
  const scrollTarget = options.scrollTarget;
  const revealTarget = options.revealTarget;
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 24;
  let accumulated = 0;
  let pinCount = 0;
  let destroyed = false;

  function setHidden(hidden) {
    if (destroyed || pinCount > 0) hidden = false;
    root.classList.toggle("is-header-hidden", hidden);
    if (!hidden) accumulated = 0;
  }

  function onWheel(event) {
    if (destroyed || pinCount > 0) return;
    const deltaX = Number(event.deltaX) || 0;
    const deltaY = Number(event.deltaY) || 0;
    if (Math.abs(deltaX) > Math.abs(deltaY) || deltaY <= 0) {
      accumulated = 0;
      return;
    }
    accumulated += deltaY;
    if (accumulated >= threshold) setHidden(true);
  }

  function reveal() {
    setHidden(false);
  }

  function pin() {
    pinCount += 1;
    reveal();
  }

  function unpin() {
    pinCount = Math.max(0, pinCount - 1);
  }

  function onFocusIn() {
    pin();
  }

  function onFocusOut(event) {
    if (event.relatedTarget && header.contains(event.relatedTarget)) return;
    unpin();
  }

  scrollTarget.addEventListener("wheel", onWheel, { passive: true });
  revealTarget.addEventListener("pointerenter", reveal);
  header.addEventListener("focusin", onFocusIn);
  header.addEventListener("focusout", onFocusOut);

  return {
    reveal,
    pin,
    unpin,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      scrollTarget.removeEventListener("wheel", onWheel);
      revealTarget.removeEventListener("pointerenter", reveal);
      header.removeEventListener("focusin", onFocusIn);
      header.removeEventListener("focusout", onFocusOut);
      root.classList.toggle("is-header-hidden", false);
    },
  };
}
```

The production implementation may use an internal `listen()` helper so removal
uses the same listener options. It must preserve the public API above.

- [ ] **Step 4: Add browser exports and bundle wiring**

Create `web/headers/header-entry.js`:

```js
export { createHeaderVisibilityController } from "./header-visibility.mjs";
```

Append to `build:web` in `native/macos/psyche-build-tauri/package.json`:

```text
esbuild web/headers/header-entry.js --bundle --minify --format=iife --global-name=PsycheHeaders --outfile=web/headers.bundle.js
```

Load it after `panes.bundle.js` and before `workspace.bundle.js`:

```html
<script src="./headers.bundle.js" defer></script>
```

Update the exact `build:web` expectation in
`__tests__/tauriWorkspacePanels.test.ts` by appending:

```text
 && esbuild web/headers/header-entry.js --bundle --minify --format=iife --global-name=PsycheHeaders --outfile=web/headers.bundle.js
```

Add source-contract assertions proving exactly one header bundle is loaded
before `workspace.bundle.js` and `main.js`:

```ts
const headersScript = '<script src="./headers.bundle.js" defer></script>';
const workspaceScript = '<script src="./workspace.bundle.js" defer></script>';
expect(indexHtml.match(/headers\.bundle\.js/g)).toHaveLength(1);
expect(indexHtml.indexOf(headersScript)).toBeLessThan(
  indexHtml.indexOf(workspaceScript),
);
expect(indexHtml.indexOf(headersScript)).toBeLessThan(
  indexHtml.indexOf(mainScript),
);
```

- [ ] **Step 5: Run focused tests and build**

Run:

```bash
pnpm vitest --run __tests__/tauriHeaderVisibility.test.ts __tests__/tauriWorkspacePanels.test.ts
pnpm --dir native/macos/psyche-build-tauri build:web
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  __tests__/tauriHeaderVisibility.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  native/macos/psyche-build-tauri/package.json \
  native/macos/psyche-build-tauri/web/headers \
  native/macos/psyche-build-tauri/web/index.html
git commit -m "feat(tauri): add disappearing header controller"
```

### Task 2: Apply the controller to terminal panes

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js:1255-1420`
- Modify: `native/macos/psyche-build-tauri/web/main.js:1450-1580`
- Modify: `native/macos/psyche-build-tauri/web/main.js:1760-1815`
- Modify: `native/macos/psyche-build-tauri/web/styles.css:995-1190`
- Modify: `__tests__/tauriHeaderVisibility.test.ts`
- Modify: `__tests__/tauriPhysicalPanes.test.ts`

- [ ] **Step 1: Add failing terminal integration tests**

Add source contracts:

```ts
it('binds one visibility controller to each xterm viewport', () => {
  const mount = functionSource('mountTerminal');
  expect(mount).toContain('className = "terminal-pane-header-reveal"');
  expect(mount).toContain('PsycheHeaders.createHeaderVisibilityController');
  expect(mount).toMatch(/scrollTarget:\s*terminalScrollTarget\(container\)/);
  expect(mount).toContain('thread.headerVisibility');
});

it('pins terminal headers during drag, context menus, and actions', () => {
  const mount = functionSource('mountTerminal');
  expect(mount).toContain('thread.headerVisibility.pin()');
  expect(mount).toContain('thread.headerVisibility.unpin()');
  expect(mount).toContain('contextmenu');
  expect(mount).toContain('close.addEventListener');
});

it('destroys header bindings before disposing a pane', () => {
  const close = functionSource('closeThread');
  expect(close).toMatch(/headerVisibility[\s\S]*destroy\(\)/);
});
```

- [ ] **Step 2: Run the terminal tests and confirm failure**

Run:

```bash
pnpm vitest --run __tests__/tauriHeaderVisibility.test.ts __tests__/tauriPhysicalPanes.test.ts
```

Expected: FAIL because terminal panes have no controller.

- [ ] **Step 3: Create the reveal zone and bind xterm scrolling**

In `mountTerminal`, create:

```js
var reveal = document.createElement("div");
reveal.className = "terminal-pane-header-reveal";
reveal.setAttribute("aria-hidden", "true");
pane.appendChild(reveal);
```

After `term.open(container)`, resolve the xterm viewport:

```js
function terminalScrollTarget(container) {
  return container.querySelector(".xterm-viewport") || container;
}

thread.headerVisibility = PsycheHeaders.createHeaderVisibilityController({
  root: pane,
  header: header,
  scrollTarget: terminalScrollTarget(container),
  revealTarget: reveal,
  threshold: 24,
});
```

- [ ] **Step 4: Pin terminal interactions**

Wrap the existing drag gesture:

```js
header.addEventListener("pointerdown", function (event) {
  if (event.target && event.target.closest && event.target.closest("button")) return;
  thread.headerVisibility.pin();
  startPaneReposition(thread, event, function () {
    thread.headerVisibility.unpin();
  });
});
```

Extend `startPaneReposition` with an optional completion callback invoked by
every finish/cancel path.

Before opening the context menu, call `pin()`. Extend
`openSessionContextMenu` with an `onClose` callback and call `unpin()` when the
menu settles.

For close and retry actions, call `pin()` before the action. Destruction or
menu settlement releases the pin; no timer-based unpin is allowed.

- [ ] **Step 5: Destroy controllers with panes**

Before xterm disposal in `closeThread`:

```js
if (thread.headerVisibility) {
  thread.headerVisibility.destroy();
  thread.headerVisibility = null;
}
```

Do the same before replacing/rebuilding a mounted terminal pane.

- [ ] **Step 6: Add terminal glass and collapse CSS**

Define:

```css
:root {
  --pane-head-h: 27px;
  --header-motion: 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.terminal-pane {
  grid-template-rows: var(--pane-head-h) minmax(0, 1fr);
  transition: grid-template-rows var(--header-motion);
}

.terminal-pane-header {
  min-height: var(--pane-head-h);
  padding: 0 6px 0 8px;
  background: linear-gradient(
    180deg,
    rgba(var(--rgb-s1), calc(var(--bg-opacity) * 0.56)),
    rgba(var(--rgb-deep), calc(var(--bg-opacity) * 0.34))
  );
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border-bottom-color: rgba(255, 255, 255, 0.06);
  transition:
    opacity var(--header-motion),
    transform var(--header-motion);
}

.terminal-pane.is-header-hidden {
  grid-template-rows: 0 minmax(0, 1fr);
}

.terminal-pane.is-header-hidden .terminal-pane-header {
  opacity: 0;
  transform: translateY(-100%);
  pointer-events: none;
}

.terminal-pane-header-reveal {
  position: absolute;
  inset: 0 0 auto;
  z-index: 4;
  height: 5px;
  pointer-events: none;
}

.terminal-pane.is-header-hidden .terminal-pane-header-reveal {
  pointer-events: auto;
}
```

Keep existing status, drag, and focused-pane styling but reduce title/meta/glyph
visual weight rather than removing required information.

- [ ] **Step 7: Add reduced-motion CSS**

```css
@media (prefers-reduced-motion: reduce) {
  .terminal-pane,
  .terminal-pane-header {
    transition-duration: 0ms;
  }
  .terminal-pane.is-header-hidden .terminal-pane-header {
    transform: none;
  }
}
```

- [ ] **Step 8: Run terminal tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriHeaderVisibility.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriCovenLaunch.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add \
  __tests__/tauriHeaderVisibility.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css
git commit -m "feat(tauri): hide terminal headers on scroll"
```

### Task 3: Apply the controller to Files, Git, and Web

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/index.html:200-275`
- Modify: `native/macos/psyche-build-tauri/web/main.js:620-850`
- Modify: `native/macos/psyche-build-tauri/web/main.js:4550-5050`
- Modify: `native/macos/psyche-build-tauri/web/styles.css:1575-1655`
- Modify: `native/macos/psyche-build-tauri/web/styles.css:2010-2125`
- Modify: `__tests__/tauriHeaderVisibility.test.ts`
- Modify: `__tests__/tauriWorkspacePanels.test.ts`

- [ ] **Step 1: Add failing tool-panel tests**

Add:

```ts
it('adds reveal zones to every tool panel', () => {
  const indexHtml = readFileSync(
    join(repoRoot, 'native/macos/psyche-build-tauri/web/index.html'),
    'utf8',
  );
  for (const panel of ['browser', 'files', 'git']) {
    expect(indexHtml).toContain(`data-header-reveal="${panel}"`);
  }
});

it('binds independent Files, Git, and Web controllers', () => {
  const bind = functionSource('bindToolPanelHeaders');
  expect(bind).toContain('file-tree');
  expect(bind).toContain('panel-git-body');
  expect(bind).toContain('preview');
  expect(bind).toContain('PsycheHeaders.createHeaderVisibilityController');
});

it('keeps the Git subheader coordinated with the primary Git header', () => {
  const styles = readFileSync(
    join(repoRoot, 'native/macos/psyche-build-tauri/web/styles.css'),
    'utf8',
  );
  expect(styles).toMatch(
    /\.panel-git\.is-header-hidden[\s\S]*\.panel-subbar/,
  );
});
```

- [ ] **Step 2: Run the tool-panel tests and confirm failure**

Run:

```bash
pnpm vitest --run __tests__/tauriHeaderVisibility.test.ts __tests__/tauriWorkspacePanels.test.ts
```

Expected: FAIL because static panels are not bound.

- [ ] **Step 3: Add static reveal zones**

Inside each `.panel-browser`, `.panel-files`, and `.panel-git`, immediately
after the header:

```html
<div class="panel-header-reveal" data-header-reveal="files" aria-hidden="true"></div>
```

Use the matching panel value for Web and Git.

- [ ] **Step 4: Bind tool panels once**

Add:

```js
var toolHeaderControllers = new Map();

function bindToolPanelHeader(name, root, header, scrollTarget) {
  var previous = toolHeaderControllers.get(name);
  if (previous) previous.destroy();
  var reveal = root.querySelector('[data-header-reveal="' + name + '"]');
  if (!root || !header || !scrollTarget || !reveal) {
    console.warn("[headers] missing " + name + " binding");
    return null;
  }
  var controller = PsycheHeaders.createHeaderVisibilityController({
    root: root,
    header: header,
    scrollTarget: scrollTarget,
    revealTarget: reveal,
    threshold: 24,
  });
  toolHeaderControllers.set(name, controller);
  return controller;
}

function bindToolPanelHeaders() {
  bindToolPanelHeader(
    "files",
    document.querySelector(".panel-files"),
    document.querySelector(".panel-files > .pane-header"),
    document.getElementById("file-tree"),
  );
  bindToolPanelHeader(
    "git",
    document.querySelector(".panel-git"),
    document.querySelector(".panel-git > .pane-header"),
    document.querySelector(".panel-git-body"),
  );
  bindToolPanelHeader(
    "browser",
    document.querySelector(".panel-browser"),
    document.querySelector(".panel-browser > .pane-header"),
    document.getElementById("preview"),
  );
}
```

Call `bindToolPanelHeaders()` once after DOM references exist. Do not rebind on
every render.

- [ ] **Step 5: Pin tool controls**

The controller's focus handling pins Files/Git buttons and Web navigation/URL
automatically. Add pointer pinning only for gestures that can outlive focus:

```js
function pinToolHeader(name, operation) {
  var controller = toolHeaderControllers.get(name);
  if (controller) controller.pin();
  return Promise.resolve(operation()).finally(function () {
    if (controller) controller.unpin();
  });
}
```

Use it around browser navigation/reload operations that replace child webviews.
Do not pin routine file/Git refresh promises after the pointer action completes.

- [ ] **Step 6: Add tool-panel glass and collapse CSS**

```css
.panel {
  --tool-header-h: 27px;
  transition: grid-template-rows var(--header-motion);
}

.pane-header,
.panel-subbar {
  background: linear-gradient(
    180deg,
    rgba(var(--rgb-s1), calc(var(--bg-opacity) * 0.56)),
    rgba(var(--rgb-deep), calc(var(--bg-opacity) * 0.34))
  );
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border-bottom-color: rgba(255, 255, 255, 0.06);
  transition:
    opacity var(--header-motion),
    transform var(--header-motion);
}

.panel-files.is-header-hidden,
.panel-git.is-header-hidden {
  grid-template-rows: 0 minmax(0, 1fr);
}

.panel-browser.is-header-hidden {
  grid-template-rows: 0 var(--browser-tabs-h) minmax(0, 1fr);
}

.panel.is-header-hidden > .pane-header {
  opacity: 0;
  transform: translateY(-100%);
  pointer-events: none;
}

.panel-git.is-header-hidden .panel-subbar {
  opacity: 0;
  transform: translateY(-100%);
  min-height: 0;
  height: 0;
  overflow: hidden;
}

.panel-header-reveal {
  position: absolute;
  inset: 0 0 auto;
  z-index: 8;
  height: 5px;
  pointer-events: none;
}

.panel.is-header-hidden .panel-header-reveal {
  pointer-events: auto;
}
```

Adjust the existing panel grid definitions to use the shared header variable.
Ensure `.panel` is positioned so the reveal zone anchors correctly.

- [ ] **Step 7: Add safe Web fallback**

The Web controller listens only to host events received by `#preview`. Do not
inject scripts into external pages or poll child-webview scroll position. If
the native child consumes wheel events, the Web header stays visible.

Add a test asserting `bindToolPanelHeaders` has no `browser_eval`, interval, or
document-wide wheel listener.

- [ ] **Step 8: Run tool and regression tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriHeaderVisibility.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriPhysicalPanes.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add \
  __tests__/tauriHeaderVisibility.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css
git commit -m "feat(tauri): hide tool headers on scroll"
```

### Task 4: Verify motion, accessibility, and packaged behavior

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/styles.css`
- Modify: `__tests__/tauriHeaderVisibility.test.ts`
- Modify: `docs/SMOKE.md`
- Generated: `native/macos/psyche-build-tauri/web/headers.bundle.js`

- [ ] **Step 1: Add final style contracts**

Add tests that assert:

```ts
expect(stylesCss).toMatch(/backdrop-filter:\s*blur\(18px\)/);
expect(stylesCss).toMatch(/prefers-reduced-motion:\s*reduce/);
expect(stylesCss).not.toMatch(/is-header-hidden[\s\S]{0,120}display:\s*none/);
expect(stylesCss).not.toMatch(/is-header-hidden[\s\S]{0,120}visibility:\s*hidden/);
```

- [ ] **Step 2: Add reduced-motion coverage**

Ensure the shared reduced-motion block includes:

```css
@media (prefers-reduced-motion: reduce) {
  .terminal-pane,
  .terminal-pane-header,
  .panel,
  .pane-header,
  .panel-subbar {
    transition-duration: 0ms;
  }
  .is-header-hidden .terminal-pane-header,
  .panel.is-header-hidden > .pane-header,
  .panel-git.is-header-hidden .panel-subbar {
    transform: none;
  }
}
```

- [ ] **Step 3: Document packaged acceptance**

Add to `docs/SMOKE.md`:

```markdown
## Disappearing panel headers

1. Open two terminal panes plus Files, Git, and Web.
2. Scroll downward more than one small trackpad gesture in one terminal; only
   that terminal header should fade and collapse.
3. Move the pointer to the hidden pane's top edge; the glass header should
   return without shifting another pane.
4. Tab into the close button and confirm the header remains visible while
   focused.
5. Drag a terminal pane and open its context menu; the header must not move
   during either gesture.
6. Repeat for Files and Git; Git and Changes headers should disappear together.
7. Scroll a loaded external Web page. If the host receives the event the Web
   header hides; otherwise it remains visible and usable.
8. Enable Reduce Motion in macOS and repeat; visibility changes should be
   immediate with no sliding animation.
9. Restart Psyche and confirm restored sessions start with visible headers.
```

- [ ] **Step 4: Build bundles**

Run:

```bash
pnpm --dir native/macos/psyche-build-tauri build:web
```

Expected: `headers.bundle.js` is generated and all existing bundles rebuild.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriHeaderVisibility.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriCovenLaunch.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run type checking**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Inspect the diff**

Run:

```bash
git diff --check
git status --short
git diff -- \
  __tests__/tauriHeaderVisibility.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  native/macos/psyche-build-tauri/package.json \
  native/macos/psyche-build-tauri/web/headers \
  native/macos/psyche-build-tauri/web/headers.bundle.js \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css \
  docs/SMOKE.md
```

Expected: only the planned header controller, integrations, styles, tests,
generated bundle, and smoke documentation appear.

- [ ] **Step 8: Commit**

```bash
git add \
  __tests__/tauriHeaderVisibility.test.ts \
  docs/SMOKE.md \
  native/macos/psyche-build-tauri/web/editor.bundle.js \
  native/macos/psyche-build-tauri/web/headers.bundle.js \
  native/macos/psyche-build-tauri/web/panes.bundle.js \
  native/macos/psyche-build-tauri/web/sessions.bundle.js \
  native/macos/psyche-build-tauri/web/workspace.bundle.js \
  native/macos/psyche-build-tauri/web/styles.css
git commit -m "test(tauri): verify disappearing panel headers"
```
