# Cmd+D Agent and Cmd+F Composer Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the agent picker's Command/Control+P binding with Command/Control+D and the bottom command input's Command/Control+K binding with Command/Control+F across both the main shell and embedded browser pages.

**Architecture:** Keep the existing `routeGlobalShortcut`, agent-picker modal router, and Tauri child-webview event bridge. Make D and F exact primary-modifier shortcuts with no Alt or Shift, remove P and K behavior, update visible hints, and extend the existing browser bridge with two focused events rather than introducing a shortcut registry.

**Tech Stack:** JavaScript, TypeScript, Vitest, Rust, Tauri events, pnpm, Cargo

---

## File Structure

- Modify `native/desktop/psyche-build-tauri/web/main.js` for main-shell routing, visible empty-state/help hints, and browser shortcut listeners.
- Modify `native/desktop/psyche-build-tauri/web/index.html` for the New Pane agent shortcut hint.
- Modify `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs` for child-webview D/F interception and event forwarding.
- Modify `__tests__/tauriAgentPicker.test.ts` for main-shell, modal, alias-removal, modifier, and visible-hint coverage.
- Modify `__tests__/tauriDesktopTabs.test.ts` for embedded browser forwarding and listener coverage.

### Task 1: Replace Main-Shell Agent and Composer Shortcuts

**Files:**
- Modify: `__tests__/tauriAgentPicker.test.ts:335-475, 620-835, 899-930`
- Modify: `native/desktop/psyche-build-tauri/web/main.js:6193-6204, 8205-8235, 8501-8512, 8535-8545`
- Modify: `native/desktop/psyche-build-tauri/web/index.html:115-121`
- Reference: `docs/superpowers/specs/2026-08-12-cmd-d-agent-cmd-f-composer-design.md`

- [ ] **Step 1: Replace the source-contract shortcut test with D/F expectations**

Replace the existing `uses Command-P and list keyboard controls to drive the
picker` test with:

```ts
  it('uses Command-D for the agent picker and Command-F for the composer', () => {
    const documentShortcutIndex = mainJs.indexOf('async function routeGlobalShortcut(e) {');
    const modalRouteIndex = mainJs.indexOf('if (routeAgentPickerModalKeydown(e)) return;');
    const commandDIndex = mainJs.indexOf('String(e.key).toLowerCase() === "d"');
    const commandFIndex = mainJs.indexOf('String(e.key).toLowerCase() === "f"');
    const commandOIndex = mainJs.indexOf('if (e.key === "o")');

    expect(modalRouteIndex).toBeGreaterThan(documentShortcutIndex);
    expect(modalRouteIndex).toBeLessThan(commandDIndex);
    expect(commandDIndex).toBeGreaterThan(-1);
    expect(commandDIndex).toBeLessThan(commandOIndex);
    expect(commandFIndex).toBeGreaterThan(commandOIndex);
    expect(mainJs).not.toContain('String(e.key).toLowerCase() === "p"');
    expect(mainJs).not.toContain('if (e.key === "k")');

    const agentShortcutBlock = mainJs.slice(commandDIndex, commandDIndex + 260);
    expect(agentShortcutBlock).toContain('!e.altKey && !e.shiftKey');
    expect(agentShortcutBlock).toContain('if (openAgentPicker()) e.preventDefault();');

    const composerShortcutBlock = mainJs.slice(commandFIndex, commandFIndex + 260);
    expect(composerShortcutBlock).toContain('!e.altKey && !e.shiftKey');
    expect(composerShortcutBlock).toContain('commandInput.focus();');
    expect(composerShortcutBlock).toContain('openPalette("/", true);');
    expect(composerShortcutBlock).toContain('e.preventDefault();');

    expect(mainJs).toContain('agentPickerListEl.addEventListener("keydown", handleAgentPickerListKeydown)');
    const listKeydownSource = functionSource('handleAgentPickerListKeydown');
    expect(listKeydownSource).toContain('event.key === "Tab"');
    expect(listKeydownSource).toContain('event.key === "ArrowDown"');
    expect(listKeydownSource).toContain('event.key === "ArrowUp"');
    expect(listKeydownSource).toContain('event.key === "Home"');
    expect(listKeydownSource).toContain('event.key === "End"');
    expect(listKeydownSource).toContain('event.key === "Enter"');
    expect(listKeydownSource).toContain('event.key === "Escape"');
  });
```

- [ ] **Step 2: Add behavior coverage for exact D/F shortcuts and removed aliases**

Add this test after the source-contract test:

```ts
  it('routes only exact primary-D and primary-F to the agent picker and composer', async () => {
    const calls = { picker: 0, focus: 0, palette: 0 };
    const routeGlobalShortcut = compileFunction<(
      event: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        shiftKey?: boolean;
        code?: string;
        preventDefault: () => void;
      },
    ) => Promise<unknown>>(
      functionSource('routeGlobalShortcut'),
      {
        routeAgentPickerModalKeydown: () => false,
        routeGitPaneShortcut: () => false,
        handleExplicitFileSave: () => Promise.resolve(),
        createTerminalPane: () => Promise.resolve(),
        openAgentPicker: () => { calls.picker += 1; return true; },
        openProjectPicker: () => undefined,
        state: { activeFileId: null, activeProjectId: null, projects: [] },
        closeFileTab: () => Promise.resolve(),
        removeProject: () => Promise.resolve(),
        commandInput: { focus: () => { calls.focus += 1; } },
        openPalette: () => { calls.palette += 1; },
        toggleSidebar: () => undefined,
        canvasThreadIds: () => [],
        focusThread: () => Promise.resolve(),
        switchTab: () => Promise.resolve(),
        projectFiles: () => [],
        activateFileTab: () => Promise.resolve(),
        setActiveProject: () => Promise.resolve(),
      },
    );

    async function dispatch(
      key: string,
      overrides: Record<string, unknown> = {},
    ) {
      let prevented = 0;
      await routeGlobalShortcut({
        key,
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault: () => { prevented += 1; },
        ...overrides,
      });
      return prevented;
    }

    expect(await dispatch('d')).toBe(1);
    expect(await dispatch('d', { metaKey: false, ctrlKey: true })).toBe(1);
    expect(calls.picker).toBe(2);

    expect(await dispatch('f')).toBe(1);
    expect(await dispatch('f', { metaKey: false, ctrlKey: true })).toBe(1);
    expect(calls.focus).toBe(2);
    expect(calls.palette).toBe(2);

    for (const [key, overrides] of [
      ['p', {}],
      ['k', {}],
      ['d', { altKey: true }],
      ['d', { shiftKey: true }],
      ['f', { altKey: true }],
      ['f', { shiftKey: true }],
    ] as const) {
      expect(await dispatch(key, overrides)).toBe(0);
    }

    expect(calls).toEqual({ picker: 2, focus: 2, palette: 2 });
  });
```

- [ ] **Step 3: Replace the modal Command-P reset test with exact D and negative P coverage**

Replace `keeps Command-P as a modal reset-and-refocus shortcut` with:

```ts
  it('uses exact Command-D as the modal reset shortcut without a P alias', () => {
    const opened: string[] = [];
    const consumed: string[] = [];
    const controller = compileFunction<(
      event: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        shiftKey?: boolean;
        preventDefault: () => void;
        stopImmediatePropagation: () => void;
      }
    ) => boolean>(
      functionSource('routeAgentPickerModalKeydown'),
      {
        agentPickerOpen: () => true,
        openAgentPicker: () => { opened.push('picker'); return true; },
        handleAgentPickerListKeydown: () => false,
        consumeAgentPickerKey: (
          event: {
            key: string;
            preventDefault: () => void;
            stopImmediatePropagation: () => void;
          }
        ) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          consumed.push(event.key);
        },
        dirtyFileDialogEl: { open: false },
      },
    );

    const event = (key: string, overrides: Record<string, unknown> = {}) => ({
      key,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: () => undefined,
      stopImmediatePropagation: () => undefined,
      ...overrides,
    });

    expect(controller(event('d'))).toBe(true);
    expect(opened).toEqual(['picker']);

    expect(controller(event('p'))).toBe(true);
    expect(controller(event('d', { shiftKey: true }))).toBe(true);
    expect(controller(event('d', { altKey: true }))).toBe(true);
    expect(opened).toEqual(['picker']);
    expect(consumed).toEqual(['d', 'p', 'd', 'd']);
  });
```

- [ ] **Step 4: Update visible shortcut assertions**

In `keeps shell, agent, browser, and Git launch hints distinct across menus,
empty state, and help`, replace the P/K expectations with:

```ts
    expect(indexHtml).toMatch(
      /id="new-pane-agent"[\s\S]*?Agent — choose CLI[\s\S]*?<span class="new-pane-key">⌘D<\/span>/,
    );
    expect(indexHtml).not.toContain(
      '<span class="new-pane-glyph">✳</span>Agent — choose CLI<span class="new-pane-key">⌘P</span>',
    );

    const emptyState = functionSource('renderTerminalEmptyState');
    expect(emptyState).toContain('<span class="glyph">✳</span>Agent<span class="key">⌘D</span>');
    expect(emptyState).not.toContain('<span class="glyph">✳</span>Agent<span class="key">⌘P</span>');

    expect(mainJs).toMatch(/\["Open the composer", "⌘F"\]/);
    expect(mainJs).not.toMatch(/\["Open the composer", "⌘K"\]/);
    expect(mainJs).toMatch(/\["Choose an agent", "⌘D"\]/);
    expect(mainJs).not.toMatch(/\["Choose an agent", "⌘P"\]/);
```

Keep the existing shell, browser, Git, and removed-tools-dock assertions.

- [ ] **Step 5: Run the focused test and verify the red state**

Run:

```bash
pnpm exec vitest --run __tests__/tauriAgentPicker.test.ts
```

Expected: failures show that D/F are not routed, P/K are still routed, the
modal still resets on P, and the visible hints still advertise `⌘P`/`⌘K`.

- [ ] **Step 6: Replace the global and modal shortcut branches**

In `routeGlobalShortcut`, replace the P and K branches with:

```js
    if (!e.altKey && !e.shiftKey &&
        String(e.key).toLowerCase() === "d") {
      if (openAgentPicker()) e.preventDefault();
      return;
    }
```

```js
    if (!e.altKey && !e.shiftKey &&
        String(e.key).toLowerCase() === "f") {
      commandInput.focus();
      openPalette("/", true);
      e.preventDefault();
      return;
    }
```

Keep D where P currently appears and F where K currently appears so shortcut
ordering and the surrounding behavior remain stable.

In `routeAgentPickerModalKeydown`, replace the P condition with:

```js
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      String(event.key).toLowerCase() === "d"
    ) {
      consumeAgentPickerKey(event);
      openAgentPicker();
      return true;
    }
```

- [ ] **Step 7: Update main-shell shortcut hints**

In `renderTerminalEmptyState`, change:

```js
'<span class="glyph">✳</span>Agent<span class="key">⌘P</span></button>'
```

to:

```js
'<span class="glyph">✳</span>Agent<span class="key">⌘D</span></button>'
```

In `HELP_ROWS`, change:

```js
["Open the composer", "⌘K"],
["Choose an agent", "⌘P"],
```

to:

```js
["Open the composer", "⌘F"],
["Choose an agent", "⌘D"],
```

In `web/index.html`, change the New Pane agent item to:

```html
<span class="new-pane-glyph">✳</span>Agent — choose CLI<span class="new-pane-key">⌘D</span>
```

- [ ] **Step 8: Run the focused test and verify the green state**

Run:

```bash
pnpm exec vitest --run __tests__/tauriAgentPicker.test.ts
```

Expected: every agent-picker test passes.

- [ ] **Step 9: Commit the main-shell replacement**

```bash
git add __tests__/tauriAgentPicker.test.ts \
  native/desktop/psyche-build-tauri/web/main.js \
  native/desktop/psyche-build-tauri/web/index.html
git -c commit.gpgsign=false commit \
  -m "feat: replace agent and composer shortcuts" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Forward D/F from Embedded Browser Webviews

**Files:**
- Modify: `__tests__/tauriDesktopTabs.test.ts:76-85`
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs:2693-2703`
- Modify: `native/desktop/psyche-build-tauri/web/main.js:7951-7957`
- Reference: `docs/superpowers/specs/2026-08-12-cmd-d-agent-cmd-f-composer-design.md`

- [ ] **Step 1: Expand the embedded-browser shortcut contract test**

Replace `lets embedded browser webviews request a terminal pane with
Command+T` with:

```ts
  it('forwards terminal, agent, and composer shortcuts from embedded browser webviews', () => {
    const shortcutStart = tauriLib.indexOf(
      'if (!window.__PSYCHE_BROWSER_SHORTCUTS_INSTALLED__)',
    );
    const shortcutEnd = tauriLib.indexOf(
      'window.addEventListener("pointerdown"',
      shortcutStart,
    );
    const shortcutSource = tauriLib.slice(shortcutStart, shortcutEnd);

    expect(shortcutSource).toContain('browser:shortcut-terminal-pane');
    expect(shortcutSource).toContain('browser:shortcut-agent-pane');
    expect(shortcutSource).toContain('browser:shortcut-composer');
    expect(shortcutSource).toContain('event.key.toLowerCase()');
    expect(shortcutSource).toContain('!event.altKey && !event.shiftKey');
    expect(shortcutSource).toMatch(/key === "t"/);
    expect(shortcutSource).toMatch(/key === "d"/);
    expect(shortcutSource).toMatch(/key === "f"/);
    expect(shortcutSource).not.toMatch(/key === "[pk]"/);
    expect(tauriLib).not.toMatch(forbiddenBrowserNewTabShortcut);
    expect(tauriLib).toMatch(/function\(browserLabel\)/);
    expect(tauriLib).not.toMatch(/label_json,\s*label_json/);

    expect(mainJs).toMatch(
      /listen\(\s*"browser:shortcut-terminal-pane",\s*function\s*\(\)\s*\{[\s\S]*createTerminalPane\(\);[\s\S]*\}\s*\)\.catch/
    );
    expect(mainJs).toMatch(
      /listen\(\s*"browser:shortcut-agent-pane",\s*function\s*\(\)\s*\{[\s\S]*openAgentPicker\(\);[\s\S]*\}\s*\)\.catch/
    );
    expect(mainJs).toMatch(
      /listen\(\s*"browser:shortcut-composer",\s*function\s*\(\)\s*\{[\s\S]*commandInput\.focus\(\);[\s\S]*openPalette\("\/", true\);[\s\S]*\}\s*\)\.catch/
    );
  });
```

- [ ] **Step 2: Run the desktop-tabs test and verify the red state**

Run:

```bash
pnpm exec vitest --run __tests__/tauriDesktopTabs.test.ts
```

Expected: the test fails because the child webview and main shell have no D/F
bridge events or listeners.

- [ ] **Step 3: Extend the Rust-injected child-webview shortcut handler**

Replace the current single T condition inside the injected `keydown` listener
with:

```js
var key = event.key ? event.key.toLowerCase() : "";
var primary = (event.metaKey || event.ctrlKey) &&
  !event.altKey && !event.shiftKey;
if ((event.metaKey || event.ctrlKey) && key === "t") {
  event.preventDefault();
  event.stopPropagation();
  emit("browser:shortcut-terminal-pane", { label: browserLabel, url: location.href });
} else if (primary && key === "d") {
  event.preventDefault();
  event.stopPropagation();
  emit("browser:shortcut-agent-pane", { label: browserLabel, url: location.href });
} else if (primary && key === "f") {
  event.preventDefault();
  event.stopPropagation();
  emit("browser:shortcut-composer", { label: browserLabel, url: location.href });
}
```

Write it using the existing Rust raw-format-string escaping:

```rust
var key = event.key ? event.key.toLowerCase() : "";
var primary = (event.metaKey || event.ctrlKey) &&
  !event.altKey && !event.shiftKey;
if ((event.metaKey || event.ctrlKey) && key === "t") {{
  event.preventDefault();
  event.stopPropagation();
  emit("browser:shortcut-terminal-pane", {{ label: browserLabel, url: location.href }});
}} else if (primary && key === "d") {{
  event.preventDefault();
  event.stopPropagation();
  emit("browser:shortcut-agent-pane", {{ label: browserLabel, url: location.href }});
}} else if (primary && key === "f") {{
  event.preventDefault();
  event.stopPropagation();
  emit("browser:shortcut-composer", {{ label: browserLabel, url: location.href }});
}}
```

The T condition deliberately retains its current modifier semantics; only D
and F require no Alt or Shift.

- [ ] **Step 4: Add main-shell listeners for browser D/F events**

Immediately after the existing terminal-pane listener, add:

```js
  listen("browser:shortcut-agent-pane", function () {
    openAgentPicker();
  }).catch(function () {});
  listen("browser:shortcut-composer", function () {
    commandInput.focus();
    openPalette("/", true);
  }).catch(function () {});
```

- [ ] **Step 5: Run both targeted shortcut suites**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriDesktopTabs.test.ts
```

Expected: both files pass.

- [ ] **Step 6: Run type, web, and Rust validation**

Run:

```bash
pnpm typecheck:tests
pnpm --dir native/desktop/psyche-build-tauri build:web
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check
cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
```

Expected: test TypeScript compiles, every native web bundle builds, Rust
formatting is clean, and the Tauri crate checks successfully.

- [ ] **Step 7: Inspect the final scoped diff**

Run:

```bash
git diff --check
git diff HEAD~1 -- \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriDesktopTabs.test.ts \
  native/desktop/psyche-build-tauri/web/main.js \
  native/desktop/psyche-build-tauri/web/index.html \
  native/desktop/psyche-build-tauri/src-tauri/src/lib.rs
```

Expected: only the approved D/F shortcut replacement, browser bridge, visible
hints, and focused tests are present. P/K aliases are absent and T remains.

- [ ] **Step 8: Commit the embedded-browser bridge**

```bash
git add __tests__/tauriDesktopTabs.test.ts \
  native/desktop/psyche-build-tauri/src-tauri/src/lib.rs \
  native/desktop/psyche-build-tauri/web/main.js
git -c commit.gpgsign=false commit \
  -m "feat: forward app shortcuts from browser panes" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Security Correction Addendum

The direct child-webview event emissions in Task 2 are superseded. Forward T,
D, and F through one dedicated `browser_app_shortcut` Tauri command instead.
Generate only that command's app permission in `build.rs`, grant it only to
`psyche-browser-*` webviews through a local plus HTTP/HTTPS capability, validate
the trusted caller label and shortcut allowlist in Rust, focus `main`, and
dispatch the existing internal event with `emit_to("main", ...)`. Do not grant
remote pages general event-emission permission or permission-gate unrelated app
commands.
