# Agent Picker Shortcut and Scope Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the native macOS agent picker after the composer scope menu removal and move every agent-picker shortcut path and hint from Command-P to Command-D.

**Architecture:** Keep the existing native picker controller and keyboard routing intact. Remove only the stale scope-menu dependency, update the two picker-owned keyboard routes, and synchronize the three visible shortcut hints with focused source-contract tests.

**Tech Stack:** Vanilla JavaScript and HTML in the native macOS web bundle, TypeScript, Vitest, pnpm.

---

## File Structure

- Modify `native/macos/psyche-build-tauri/web/main.js`: remove the stale `closeScopeMenu()` call, switch the global and modal picker routes to `d`, and update the empty-state and help-overlay hints.
- Modify `native/macos/psyche-build-tauri/web/index.html`: update the new-pane agent hint to `⌘D`.
- Modify `__tests__/tauriAgentPicker.test.ts`: execute `openAgentPicker()` without a scope-menu shim and lock both keyboard routes and all visible hints to Command-D.

### Task 1: Remove the stale scope-menu dependency

**Files:**
- Modify: `__tests__/tauriAgentPicker.test.ts:250-315`
- Modify: `native/macos/psyche-build-tauri/web/main.js:8203-8219`

- [ ] **Step 1: Write the failing regression**

In the test named `opens the picker by closing the session context menu, resetting selection, and focusing the list`, remove the `closeScopeMenu` dependency and assert that the function source no longer references it:

```ts
const controller = compileFunctionWithState<() => boolean>(
  functionSource('openAgentPicker'),
  {
    document: { activeElement: previousFocus },
    agentPickerOpen: () => false,
    renderAgentPicker: () => { renderCalls += 1; },
    focusAgentPickerList: () => { focusCalls += 1; },
    setHelpOpen: () => undefined,
    closeNewPaneMenu: () => undefined,
    closeSessionContextMenu: () => { closeSessionContextMenuCalls += 1; },
  },
  {
    agentPickerOverlayEl: overlay,
    dirtyFileDialogEl: { open: false },
    agentPickerListEl: { focus: () => { throw new Error('focus should route through focusAgentPickerList'); } },
    agentPickerIndex: 4,
    agentPickerPreviousFocus: null,
  },
);

expect(functionSource('openAgentPicker')).not.toContain('closeScopeMenu');
expect(controller.fn()).toBe(true);
```

In the dirty-file-dialog test, also remove this dependency:

```ts
closeScopeMenu: () => { calls.push('scope'); },
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriAgentPicker.test.ts
```

Expected: FAIL because `openAgentPicker()` still contains and invokes `closeScopeMenu()`.

- [ ] **Step 3: Remove the dead call**

Change `openAgentPicker()` to:

```js
function openAgentPicker() {
  if (!agentPickerOverlayEl || !agentPickerListEl) return false;
  if (dirtyFileDialogEl && dirtyFileDialogEl.open) return false;
  if (!agentPickerOpen()) agentPickerPreviousFocus = document.activeElement;
  setHelpOpen(false);
  closeNewPaneMenu();
  closeSessionContextMenu();
  agentPickerIndex = 0;
  renderAgentPicker();
  agentPickerOverlayEl.hidden = false;
  focusAgentPickerList();
  return true;
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm vitest --run __tests__/tauriAgentPicker.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the dependency cleanup**

```bash
git add __tests__/tauriAgentPicker.test.ts native/macos/psyche-build-tauri/web/main.js
git commit -m "fix: restore agent picker opening" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Move the agent picker shortcut to Command-D

**Files:**
- Modify: `__tests__/tauriAgentPicker.test.ts:321-333`
- Modify: `__tests__/tauriAgentPicker.test.ts:587-635`
- Modify: `__tests__/tauriAgentPicker.test.ts:764-793`
- Modify: `native/macos/psyche-build-tauri/web/main.js:5267-5271`
- Modify: `native/macos/psyche-build-tauri/web/main.js:7046-7049`
- Modify: `native/macos/psyche-build-tauri/web/main.js:7253-7263`
- Modify: `native/macos/psyche-build-tauri/web/main.js:7286-7297`
- Modify: `native/macos/psyche-build-tauri/web/index.html:70-73`

- [ ] **Step 1: Update the global shortcut test to require Command-D**

Replace the Command-P assertions with:

```ts
it('uses Command-D and list keyboard controls to drive the picker', () => {
  const documentShortcutIndex = mainJs.indexOf('document.addEventListener("keydown", async function (e) {');
  const modalRouteIndex = mainJs.indexOf('if (routeAgentPickerModalKeydown(e)) return;', documentShortcutIndex);
  const commandDIndex = mainJs.indexOf(
    'String(e.key).toLowerCase() === "d"',
    documentShortcutIndex,
  );
  const commandOIndex = mainJs.indexOf('if (e.key === "o")', commandDIndex);
  expect(modalRouteIndex).toBeGreaterThan(documentShortcutIndex);
  expect(modalRouteIndex).toBeLessThan(commandDIndex);
  expect(commandDIndex).toBeGreaterThan(-1);
  expect(commandDIndex).toBeLessThan(commandOIndex);
  const shortcutBlock = mainJs.slice(commandDIndex, commandDIndex + 200);
  expect(shortcutBlock).toContain('if (openAgentPicker()) e.preventDefault();');
  expect(shortcutBlock).not.toContain('toLowerCase() === "p"');

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

- [ ] **Step 2: Update the modal reset test to require Command-D**

Rename the test to `keeps Command-D as a modal reset-and-refocus shortcut`, then use and assert `d`:

```ts
expect(controller({
  key: 'd',
  metaKey: true,
  preventDefault: () => { calls.prevented += 1; },
  stopImmediatePropagation: () => { calls.immediateStopped += 1; },
})).toBe(true);

expect(calls).toEqual({ prevented: 1, immediateStopped: 1 });
expect(consumed).toEqual(['d']);
expect(opened).toEqual(['picker']);
expect(functionSource('routeAgentPickerModalKeydown')).not.toContain(
  'String(event.key).toLowerCase() === "p"',
);
```

- [ ] **Step 3: Update visible-hint tests to require `⌘D` and reject stale `⌘P`**

In `keeps shell, agent, and browser launch hints distinct across menus, empty state, and help`, use:

```ts
expect(indexHtml).toMatch(
  /id="new-pane-agent"[\s\S]*?Agent — choose CLI[\s\S]*?<span class="new-pane-key">⌘D<\/span>/,
);
expect(indexHtml).not.toMatch(
  /id="new-pane-agent"[\s\S]*?<span class="new-pane-key">⌘P<\/span>/,
);

const emptyState = functionSource('renderTerminalEmptyState');
expect(emptyState).toContain('data-empty-action="agent"');
expect(emptyState).toContain('<span class="glyph">✳</span>Agent<span class="key">⌘D</span>');
expect(emptyState).not.toContain('<span class="glyph">✳</span>Agent<span class="key">⌘P</span>');

expect(mainJs).toMatch(/\["Choose an agent", "⌘D"\]/);
expect(mainJs).not.toMatch(/\["Choose an agent", "⌘P"\]/);
```

Keep the existing terminal, browser, dock, and negative agent-terminal assertions unchanged.

- [ ] **Step 4: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriAgentPicker.test.ts
```

Expected: FAIL because the runtime routes and visible hints still use Command-P.

- [ ] **Step 5: Change both keyboard routes to `d`**

In the global document keydown handler:

```js
if (String(e.key).toLowerCase() === "d") {
  if (openAgentPicker()) e.preventDefault();
  return;
}
```

In `routeAgentPickerModalKeydown()`:

```js
if (
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  String(event.key).toLowerCase() === "d"
) {
  consumeAgentPickerKey(event);
  openAgentPicker();
  return true;
}
```

- [ ] **Step 6: Change all visible picker hints to `⌘D`**

In `renderTerminalEmptyState()`:

```js
'<span class="glyph">✳</span>Agent<span class="key">⌘D</span></button>' +
```

In `HELP_ROWS`:

```js
["Choose an agent", "⌘D"],
```

In `native/macos/psyche-build-tauri/web/index.html`:

```html
<span class="new-pane-glyph">✳</span>Agent — choose CLI<span class="new-pane-key">⌘D</span>
```

- [ ] **Step 7: Run the focused test and verify it passes**

Run:

```bash
pnpm vitest --run __tests__/tauriAgentPicker.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the shortcut change**

```bash
git add __tests__/tauriAgentPicker.test.ts native/macos/psyche-build-tauri/web/main.js native/macos/psyche-build-tauri/web/index.html
git commit -m "feat: move agent picker shortcut to command d" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Verify the completed cleanup

**Files:**
- Verify: `__tests__/tauriAgentPicker.test.ts`
- Verify: `native/macos/psyche-build-tauri/web/main.js`
- Verify: `native/macos/psyche-build-tauri/web/index.html`

- [ ] **Step 1: Run the repository typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 2: Run the full test suite**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 3: Check the final diff**

Run:

```bash
git diff --check HEAD~2..HEAD
```

Expected: no output and exit code 0.

- [ ] **Step 4: Confirm only the requested Command-P references were removed**

Run:

```bash
rg -n 'closeScopeMenu|⌘P|toLowerCase\(\) === "p"' \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/index.html
```

Expected: no output. The focused test suite separately contains negative assertions that reject these stale agent-picker strings.
