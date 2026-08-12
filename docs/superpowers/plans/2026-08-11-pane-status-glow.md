# Pane Status Glow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pane-header status chip/dot with exception-only status glow on the native macOS pane frame.

**Architecture:** Runtime status becomes pane-level state applied by one helper to `data-status` and `aria-description`. Pane mounting removes the status DOM node, while CSS maps starting, failed, and exited states to restrained outer glows that preserve focus and yield to needs-attention.

**Tech Stack:** Vanilla JavaScript DOM, CSS container/layout rules, Vitest source-contract tests.

---

## File map

- Modify `native/macos/psyche-build-tauri/web/main.js`: move status state to the pane element and remove the header status node from terminal, Web, and tool panes.
- Modify `native/macos/psyche-build-tauri/web/styles.css`: remove status-chip styles, reduce header tracks, and render exception-only pane glows with focus and attention precedence.
- Modify `__tests__/tauriPhysicalPanes.test.ts`: cover pane-level status state, accessible descriptions, header structure, and status-glow CSS.
- Modify `__tests__/tauriSessionAttention.test.ts`: update the terminal-header track contract and preserve attention precedence.

### Task 1: Move runtime status onto the pane element

**Files:**
- Modify: `__tests__/tauriPhysicalPanes.test.ts:550-595`
- Modify: `native/macos/psyche-build-tauri/web/main.js:2135-2555`
- Modify: `native/macos/psyche-build-tauri/web/main.js:2624-2636`
- Modify: `native/macos/psyche-build-tauri/web/main.js:3472-3484`

- [ ] **Step 1: Rewrite the metadata test to require pane-level status state**

Replace the status-node assertions in `keeps mounted pane metadata current for status and rename changes` with a pane fake and pane-level expectations:

```ts
it('keeps mounted pane metadata current for status and rename changes', () => {
  const closeAttributes = new Map<string, string>();
  const paneAttributes = new Map<string, string>();
  const pane = {
    dataset: {} as Record<string, string>,
    setAttribute: (name: string, value: string) => paneAttributes.set(name, value),
    removeAttribute: (name: string) => paneAttributes.delete(name),
  };
  const thread = {
    id: 'thread-a', projectId: 'project', name: 'Psyche', status: 'starting',
    pane,
    paneTitle: { textContent: '' },
    paneClose: {
      setAttribute: (name: string, value: string) => closeAttributes.set(name, value),
    },
  };
  const applyPaneStatus = compileFunction<(element: typeof pane, status: string) => void>(
    functionSource('applyPaneStatus'),
    {},
  );
  const syncThreadPaneMetadata = compileFunction<(value: typeof thread) => void>(
    functionSource('syncThreadPaneMetadata'),
    {
      applyPaneStatus,
      threadLaneLabel: () => 'main',
      paneLayoutForThread: () => null,
      PsychePanes: { findLeafByThreadId: () => null },
      syncPaneSpanControl: () => undefined,
      syncPaneMaxControl: () => undefined,
    },
  );

  thread.status = 'running';
  syncThreadPaneMetadata(thread);
  expect(pane.dataset.status).toBe('running');
  expect(paneAttributes.get('aria-description')).toBe('Status: running');

  thread.status = 'exited';
  syncThreadPaneMetadata(thread);
  expect(pane.dataset.status).toBe('exited');
  expect(paneAttributes.get('aria-description')).toBe('Status: exited');

  thread.status = 'unsupported';
  syncThreadPaneMetadata(thread);
  expect(pane.dataset.status).toBeUndefined();
  expect(paneAttributes.has('aria-description')).toBe(false);

  thread.status = 'exited';
  const renameThread = compileFunction<(id: string, name: string) => boolean>(
    functionSource('renameThread'),
    {
      findThread: () => thread,
      syncThreadPaneMetadata,
      saveWorkspaceSoon: () => undefined,
      state: { activeThreadId: null },
      setProjectStatus: () => undefined,
      findProject: () => ({ id: 'project' }),
      statusLevel: () => 'ok',
    },
  );
  expect(renameThread(thread.id, 'Renamed')).toBe(true);
  expect(thread.paneTitle.textContent).toBe('Renamed');
  expect(closeAttributes.get('aria-label')).toBe('Stop and close Renamed');

  expect(functionSource('spawnPty')).toMatch(
    /thread\.status = "running";[\s\S]*syncThreadPaneMetadata\(thread\)/,
  );
  expect(functionSource('handlePtyExit')).toMatch(
    /thread\.status = "exited";[\s\S]*syncThreadPaneMetadata\(thread\)/,
  );
  expect(functionSource('spawnPty')).toMatch(
    /already running[\s\S]*thread\.ptyStarted = true/,
  );
});
```

- [ ] **Step 2: Run the focused metadata test and confirm it fails**

Run:

```bash
pnpm exec vitest --run __tests__/tauriPhysicalPanes.test.ts \
  -t "keeps mounted pane metadata current for status and rename changes"
```

Expected: FAIL because `syncThreadPaneMetadata` still passes `thread.paneStatus`
to the old element-oriented helper.

- [ ] **Step 3: Make `applyPaneStatus` operate on pane state**

Replace the current `applyPaneStatus` implementation in `main.js` with:

```js
function applyPaneStatus(pane, status) {
  if (!pane) return;
  var label = status || "";
  var supported = label === "running" || label === "starting" ||
    label === "failed" || label === "exited";
  if (!supported) {
    if (pane.dataset) delete pane.dataset.status;
    pane.removeAttribute("aria-description");
    return;
  }
  pane.dataset.status = label;
  pane.setAttribute("aria-description", "Status: " + label);
}
```

Update `syncThreadPaneMetadata` to apply status to the mounted pane:

```js
if (thread.pane) {
  applyPaneStatus(thread.pane, thread.status);
}
```

Delete the old `if (thread.paneStatus)` block.

- [ ] **Step 4: Remove the status node from all pane mounting paths**

In each of `mountToolPane`, `mountBrowserPane`, and `mountTerminal`:

1. Delete creation and initialization of `var status`.
2. Delete `header.appendChild(status)`.
3. Delete `thread.paneStatus = status`.

The terminal header append order must become:

```js
header.appendChild(glyph);
header.appendChild(label);
header.appendChild(attention);
header.appendChild(span);
header.appendChild(maximize);
header.appendChild(close);
```

The Web and tool header append order must become:

```js
header.appendChild(glyph);
header.appendChild(label);
header.appendChild(span);
header.appendChild(maximize);
header.appendChild(close);
```

Keep `thread.pane = pane` assigned before `syncThreadPaneMetadata(thread)` so
initial status is applied through the same path as later lifecycle changes.

- [ ] **Step 5: Run the focused metadata test and confirm it passes**

Run:

```bash
pnpm exec vitest --run __tests__/tauriPhysicalPanes.test.ts \
  -t "keeps mounted pane metadata current for status and rename changes"
```

Expected: PASS.

- [ ] **Step 6: Commit pane-level status state**

```bash
git commit --only \
  -m "refactor(macos): move pane status to frame state" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -- native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriPhysicalPanes.test.ts
```

### Task 2: Render exception status as pane glow

**Files:**
- Modify: `__tests__/tauriPhysicalPanes.test.ts:1765-1805`
- Modify: `__tests__/tauriSessionAttention.test.ts:310-322`
- Modify: `native/macos/psyche-build-tauri/web/styles.css:1260-1480`

- [ ] **Step 1: Replace the old header/status CSS contract tests**

Update `pane frame` tests in `tauriPhysicalPanes.test.ts`:

```ts
it('gives each pane header exactly one track per child', () => {
  expect(stylesCss).toMatch(
    /\.terminal-pane-header\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto auto auto;/s,
  );
  expect(stylesCss).toMatch(
    /\.terminal-pane\.is-web \.terminal-pane-header,[\s\S]*\.terminal-pane\.is-tool \.terminal-pane-header\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto auto;/s,
  );
  expect(functionSource('mountTerminal')).toMatch(
    /header\.appendChild\(glyph\);[\s\S]*header\.appendChild\(label\);[\s\S]*header\.appendChild\(attention\);[\s\S]*header\.appendChild\(span\);[\s\S]*header\.appendChild\(maximize\);[\s\S]*header\.appendChild\(close\)/,
  );
  expect(functionSource('mountTerminal')).not.toContain('terminal-pane-status');
  expect(functionSource('mountBrowserPane')).not.toContain('terminal-pane-status');
  expect(functionSource('mountToolPane')).not.toContain('terminal-pane-status');
});

it('uses exception-only status glow without restoring a running indicator', () => {
  expect(stylesCss).not.toContain('.terminal-pane-status');
  expect(stylesCss).toMatch(
    /\.terminal-pane\[data-status="starting"\]\s*\{[^}]*--pane-status-rgb:\s*251,\s*191,\s*36;/s,
  );
  expect(stylesCss).toMatch(
    /\.terminal-pane\[data-status="failed"\]\s*\{[^}]*--pane-status-rgb:\s*248,\s*113,\s*113;/s,
  );
  expect(stylesCss).toMatch(
    /\.terminal-pane\[data-status="exited"\]\s*\{[^}]*--pane-status-rgb:\s*138,\s*132,\s*153;/s,
  );
  expect(stylesCss).not.toMatch(
    /\.terminal-pane\[data-status="running"\]\s*\{/,
  );
  expect(stylesCss).toMatch(
    /\.terminal-pane:is\(\[data-status="starting"\], \[data-status="failed"\], \[data-status="exited"\]\):not\(\.needs-attention\)\s*\{[^}]*box-shadow:/s,
  );
  expect(stylesCss).toMatch(
    /\.terminal-pane\.focused:is\(\[data-status="starting"\], \[data-status="failed"\], \[data-status="exited"\]\):not\(\.needs-attention\)\s*\{[^}]*rgba\(var\(--rgb-accent\), 0\.22\)[^}]*rgba\(var\(--pane-status-rgb\), 0\.24\)/s,
  );
  expect(stylesCss).not.toMatch(
    /\.terminal-pane\[data-status="(?:starting|failed|exited)"\][^}]*animation:/s,
  );
});
```

Update the attention header-track assertion in
`tauriSessionAttention.test.ts`:

```ts
expect(stylesCss).toMatch(
  /\.terminal-pane-header \{[\s\S]{0,120}grid-template-columns: auto minmax\(0, 1fr\) auto auto auto auto;/
);
expect(functionSource('mountTerminal')).toMatch(
  /header\.appendChild\(attention\);[\s\S]*header\.appendChild\(span\)/
);
```

- [ ] **Step 2: Run the pane-frame and attention tests and confirm they fail**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriSessionAttention.test.ts \
  -t "pane header|status glow|waiting reason"
```

Expected: FAIL because the stylesheet still defines seven header tracks and
the old status chip/dot.

- [ ] **Step 3: Reduce the header grid tracks**

Change the generic pane header grid to six tracks:

```css
.terminal-pane-header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto auto auto;
  align-items: center;
  gap: 8px;
  padding: 0 6px 0 8px;
  background: rgba(255, 255, 255, 0.025);
  font-size: 12.5px;
  user-select: none;
}
.terminal-pane.is-web .terminal-pane-header,
.terminal-pane.is-tool .terminal-pane-header {
  grid-template-columns: auto minmax(0, 1fr) auto auto auto;
}
```

Update the nearby track comment to describe terminal panes as:

```text
glyph · label · attention · span · maximise · close
```

- [ ] **Step 4: Delete the old status chip/dot CSS**

Remove the complete `.terminal-pane-status` block and all state variants:

```css
.terminal-pane-status
.terminal-pane-status:empty
.terminal-pane-status.starting
.terminal-pane-status.failed
.terminal-pane-status.exited
.terminal-pane-status.running
```

Also remove this narrow-pane rule:

```css
.terminal-pane-status:not(.running) { display: none; }
```

Retain the rest of the `@container pane (max-width: 300px)` block so compact
header spacing still applies.

- [ ] **Step 5: Add exception-only pane glow with explicit precedence**

Place these rules after the base focused and needs-attention frame rules:

```css
.terminal-pane[data-status="starting"] { --pane-status-rgb: 251, 191, 36; }
.terminal-pane[data-status="failed"] { --pane-status-rgb: 248, 113, 113; }
.terminal-pane[data-status="exited"] { --pane-status-rgb: 138, 132, 153; }

.terminal-pane:is([data-status="starting"], [data-status="failed"], [data-status="exited"]):not(.needs-attention) {
  box-shadow:
    0 0 0 1px rgba(var(--pane-status-rgb), 0.2),
    0 0 12px rgba(var(--pane-status-rgb), 0.24);
}

.terminal-pane.focused:is([data-status="starting"], [data-status="failed"], [data-status="exited"]):not(.needs-attention) {
  border-color: rgba(var(--rgb-accent), 0.55);
  box-shadow:
    0 0 0 1px rgba(var(--rgb-accent), 0.22),
    0 0 12px rgba(var(--pane-status-rgb), 0.24);
}
```

Do not add a selector for `data-status="running"`. Do not animate status glow.
The `:not(.needs-attention)` guard leaves the existing attention border,
shadow, and header tint untouched.

- [ ] **Step 6: Run the pane-frame and attention tests and confirm they pass**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriSessionAttention.test.ts \
  -t "pane header|status glow|waiting reason"
```

Expected: PASS.

- [ ] **Step 7: Commit the pane glow**

```bash
git commit --only \
  -m "feat(macos): show pane status as exception glow" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -- native/macos/psyche-build-tauri/web/styles.css \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriSessionAttention.test.ts
```

### Task 3: Verify pane lifecycle and interaction regressions

**Files:**
- Verify: `native/macos/psyche-build-tauri/web/main.js`
- Verify: `native/macos/psyche-build-tauri/web/styles.css`
- Verify: `__tests__/tauriPhysicalPanes.test.ts`
- Verify: `__tests__/tauriSessionAttention.test.ts`

- [ ] **Step 1: Run both complete focused test files**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriSessionAttention.test.ts
```

Expected: both test files pass with no failed tests.

- [ ] **Step 2: Run the test TypeScript checker**

Run:

```bash
pnpm run typecheck:tests
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Inspect the final diff for removed status-node remnants**

Run:

```bash
git --no-pager diff HEAD~2 -- \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriSessionAttention.test.ts
if rg -n "paneStatus|terminal-pane-status" \
    native/macos/psyche-build-tauri/web/main.js \
    native/macos/psyche-build-tauri/web/styles.css; then
  echo "unexpected legacy pane status reference"
  exit 1
fi
```

Expected: the diff contains only pane-status state, header-track, glow, and test
changes; `rg` returns no matches.

- [ ] **Step 4: Confirm the worktree preserves unrelated user changes**

Run:

```bash
git --no-pager status --short
```

Expected: no uncommitted changes in the four implementation files. Any
pre-existing staged or untracked paths outside those files remain untouched.
