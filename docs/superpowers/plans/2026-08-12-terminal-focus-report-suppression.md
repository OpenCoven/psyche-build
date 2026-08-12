# Terminal Focus Report Suppression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Psyche's internal pane rerenders from inserting xterm focus reports into newly launched Codex prompts.

**Architecture:** Add an exact focus-report classifier at the xterm input boundary and activate it only while `renderPaneWorkspace` reparents mounted terminal panes. Use per-thread suppression depth plus two animation frames of cleanup so overlapping renders remain safe and the existing asynchronous focus restoration completes before suppression ends.

**Tech Stack:** Vanilla JavaScript, xterm.js 6, Tauri 2 webview, Vitest source-contract and function-harness tests.

---

## File map

- `native/macos/psyche-build-tauri/web/main.js` — exact focus-report filtering, per-thread render suppression state, focus restoration, and pane-render lifecycle.
- `__tests__/tauriPhysicalPanes.test.ts` — focused unit and renderer lifecycle coverage.
- `__tests__/tauriCovenLaunch.test.ts` — unchanged regression coverage for Codex agent launch descriptors and native pane creation.

### Task 1: Filter exact focus reports at the xterm input boundary

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js:1718-1855`
- Modify: `native/macos/psyche-build-tauri/web/main.js:2645-2690`
- Test: `__tests__/tauriPhysicalPanes.test.ts:360-430`

- [ ] **Step 1: Write the failing focus-report classifier test**

Add this test after the existing persistent-pane mounting test in
`__tests__/tauriPhysicalPanes.test.ts`:

```ts
it('suppresses only exact xterm focus reports during an internal pane render', () => {
  const isTerminalFocusReport = compileFunction<(data: unknown) => boolean>(
    functionSource('isTerminalFocusReport'),
    {},
  );
  const shouldSuppressTerminalData = compileFunction<(
    thread: { internalPaneRenderDepth?: number } | null,
    data: unknown,
  ) => boolean>(
    functionSource('shouldSuppressTerminalData'),
    { isTerminalFocusReport },
  );
  const suppressing = { internalPaneRenderDepth: 1 };
  const idle = { internalPaneRenderDepth: 0 };

  expect(isTerminalFocusReport('\x1b[I')).toBe(true);
  expect(isTerminalFocusReport('\x1b[O')).toBe(true);
  expect(isTerminalFocusReport('\x1b[O\x1b[I\x1b[O')).toBe(true);
  expect(isTerminalFocusReport('')).toBe(false);
  expect(isTerminalFocusReport('hello')).toBe(false);
  expect(isTerminalFocusReport('\x03')).toBe(false);
  expect(isTerminalFocusReport('\x1b[Ix')).toBe(false);
  expect(isTerminalFocusReport('x\x1b[O')).toBe(false);
  expect(isTerminalFocusReport(new Uint8Array([27, 91, 73]))).toBe(false);

  expect(shouldSuppressTerminalData(suppressing, '\x1b[I')).toBe(true);
  expect(shouldSuppressTerminalData(suppressing, '\x1b[O\x1b[I')).toBe(true);
  expect(shouldSuppressTerminalData(suppressing, 'typed text')).toBe(false);
  expect(shouldSuppressTerminalData(suppressing, '\x1b[Ityped text')).toBe(false);
  expect(shouldSuppressTerminalData(idle, '\x1b[I')).toBe(false);
  expect(shouldSuppressTerminalData(null, '\x1b[O')).toBe(false);
});
```

- [ ] **Step 2: Write the failing xterm input-boundary contract**

Add a separate source-contract test:

```ts
it('checks render-scoped focus suppression before writing xterm input to the PTY', () => {
  const mountTerminal = functionSource('mountTerminal');

  expect(mountTerminal).toMatch(
    /term\.onData\(function \(data\) \{\s*if \(shouldSuppressTerminalData\(thread, data\)\) return;\s*sendToThread\(thread, data\);\s*\}\);/,
  );
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
pnpm vitest --run __tests__/tauriPhysicalPanes.test.ts
```

Expected: FAIL because `isTerminalFocusReport` and
`shouldSuppressTerminalData` do not exist, and `mountTerminal` still forwards
every `term.onData` payload directly to `sendToThread`.

- [ ] **Step 4: Add explicit suppression state to terminal threads**

In the thread object created by `createThread`, add the state beside the other
runtime-only lifecycle fields:

```js
      ptyStarted: false,
      internalPaneRenderDepth: 0,
      metricsGeneration: 0,
```

This state is process-local and must not be added to workspace persistence.

- [ ] **Step 5: Implement the exact classifier and suppression predicate**

Add these helpers immediately before `mountTerminal`:

```js
  function isTerminalFocusReport(data) {
    return typeof data === "string" && /^(?:\x1b\[[IO])+$/.test(data);
  }

  function shouldSuppressTerminalData(thread, data) {
    return Boolean(
      thread &&
      thread.internalPaneRenderDepth > 0 &&
      isTerminalFocusReport(data)
    );
  }
```

The regular expression accepts only complete repetitions of `ESC[I` and
`ESC[O`. Do not strip focus sequences out of a mixed payload; mixed data must
remain byte-for-byte unchanged.

- [ ] **Step 6: Guard the xterm input callback**

Replace the one-line `term.onData` callback in `mountTerminal`:

```js
    term.onData(function (data) {
      if (shouldSuppressTerminalData(thread, data)) return;
      sendToThread(thread, data);
    });
```

- [ ] **Step 7: Run the focused tests and verify GREEN**

Run:

```bash
pnpm vitest --run __tests__/tauriPhysicalPanes.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the input-boundary change**

```bash
git add native/macos/psyche-build-tauri/web/main.js __tests__/tauriPhysicalPanes.test.ts
git commit -m "fix(macos): filter internal terminal focus reports" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Bound suppression to pane rendering and restore focus safely

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js:3130-3320`
- Test: `__tests__/tauriPhysicalPanes.test.ts:430-590`

- [ ] **Step 1: Write the failing render suppression lifecycle test**

Add this test after the focus-report classifier tests:

```ts
it('tracks overlapping pane-render suppression until two animation frames settle', () => {
  const queued: Array<() => void> = [];
  const visible = {
    id: 'visible',
    term: {},
    pane: {},
    internalPaneRenderDepth: 0,
  };
  const hidden = {
    id: 'hidden',
    term: {},
    pane: {},
    internalPaneRenderDepth: 0,
  };
  const shellWithoutTerm = {
    id: 'unmounted',
    term: null,
    pane: {},
    internalPaneRenderDepth: 0,
  };
  const state = { threads: [visible, hidden, shellWithoutTerm] };
  const terminalHost = {
    contains: (pane: unknown) => pane === visible.pane,
  };
  const beginPaneRenderFocusSuppression = compileFunction<() => typeof state.threads>(
    functionSource('beginPaneRenderFocusSuppression'),
    { state, terminalHost },
  );
  const endPaneRenderFocusSuppression = compileFunction<(
    threads: typeof state.threads,
  ) => void>(
    functionSource('endPaneRenderFocusSuppression'),
    {
      requestAnimationFrame: (callback: () => void) => {
        queued.push(callback);
        return queued.length;
      },
    },
  );

  const first = beginPaneRenderFocusSuppression();
  const second = beginPaneRenderFocusSuppression();
  expect(first).toEqual([visible]);
  expect(second).toEqual([visible]);
  expect(visible.internalPaneRenderDepth).toBe(2);
  expect(hidden.internalPaneRenderDepth).toBe(0);
  expect(shellWithoutTerm.internalPaneRenderDepth).toBe(0);

  endPaneRenderFocusSuppression(first);
  endPaneRenderFocusSuppression(second);
  expect(queued).toHaveLength(2);

  const firstFrame = queued.splice(0);
  firstFrame.forEach((callback) => callback());
  expect(visible.internalPaneRenderDepth).toBe(2);
  expect(queued).toHaveLength(2);

  const secondFrame = queued.splice(0);
  secondFrame.forEach((callback) => callback());
  expect(visible.internalPaneRenderDepth).toBe(0);
});
```

- [ ] **Step 2: Write the failing focused-terminal restoration test**

Add:

```ts
it('restores a terminal that was focused before the pane tree was rebuilt', () => {
  const queued: Array<() => void> = [];
  const activeElement = {};
  const thread = {
    id: 'thread-a',
    term: { focus: vi.fn() },
    host: { contains: (element: unknown) => element === activeElement },
    pane: {},
  };
  const state = { threads: [thread], activeThreadId: thread.id };
  const terminalHost = { contains: (pane: unknown) => pane === thread.pane };
  const focusedTerminalThreadForRender = compileFunction<() => typeof thread | null>(
    functionSource('focusedTerminalThreadForRender'),
    {
      document: { activeElement },
      state,
    },
  );
  const restoreRenderedTerminalFocus = compileFunction<(value: typeof thread) => void>(
    functionSource('restoreRenderedTerminalFocus'),
    {
      requestAnimationFrame: (callback: () => void) => {
        queued.push(callback);
        return queued.length;
      },
      isLiveThread: (value: unknown) => value === thread,
      state,
      terminalHost,
    },
  );

  expect(focusedTerminalThreadForRender()).toBe(thread);
  restoreRenderedTerminalFocus(thread);
  expect(thread.term.focus).not.toHaveBeenCalled();
  queued.shift()?.();
  expect(thread.term.focus).toHaveBeenCalledTimes(1);

  state.activeThreadId = 'thread-b';
  restoreRenderedTerminalFocus(thread);
  queued.shift()?.();
  expect(thread.term.focus).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: Write the failing guaranteed-cleanup renderer test**

Add:

```ts
it('ends pane-render suppression even when rebuilding the DOM throws', () => {
  const focused = { id: 'thread-a' };
  const suppressed = [{ id: 'thread-a' }];
  const calls: string[] = [];
  const renderPaneWorkspace = compileFunction<() => void>(
    functionSource('renderPaneWorkspace'),
    {
      terminalHost: {
        replaceChildren: () => {
          calls.push('replace');
          throw new Error('render failed');
        },
      },
      focusedTerminalThreadForRender: () => focused,
      beginPaneRenderFocusSuppression: () => {
        calls.push('begin');
        return suppressed;
      },
      stageBrowserSurface: () => calls.push('stage'),
      restoreRenderedTerminalFocus: (thread: unknown) => {
        expect(thread).toBe(focused);
        calls.push('restore');
      },
      endPaneRenderFocusSuppression: (threads: unknown) => {
        expect(threads).toBe(suppressed);
        calls.push('end');
      },
    },
  );

  expect(() => renderPaneWorkspace()).toThrow('render failed');
  expect(calls).toEqual(['begin', 'stage', 'replace', 'restore', 'end']);
});
```

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```bash
pnpm vitest --run __tests__/tauriPhysicalPanes.test.ts
```

Expected: FAIL because the render suppression and focus restoration helpers do
not exist and `renderPaneWorkspace` has no guaranteed cleanup lifecycle.

- [ ] **Step 5: Implement the render suppression lifecycle helpers**

Add these helpers immediately before `renderPaneNode`:

```js
  function focusedTerminalThreadForRender() {
    var activeElement = document.activeElement;
    if (!activeElement) return null;
    for (var i = 0; i < state.threads.length; i++) {
      var thread = state.threads[i];
      if (thread.term && thread.host && thread.host.contains(activeElement)) {
        return thread;
      }
    }
    return null;
  }

  function beginPaneRenderFocusSuppression() {
    var affected = [];
    state.threads.forEach(function (thread) {
      if (!thread.term || !thread.pane || !terminalHost.contains(thread.pane)) return;
      thread.internalPaneRenderDepth = (thread.internalPaneRenderDepth || 0) + 1;
      affected.push(thread);
    });
    return affected;
  }

  function restoreRenderedTerminalFocus(thread) {
    if (!thread) return;
    requestAnimationFrame(function () {
      if (
        !isLiveThread(thread) ||
        state.activeThreadId !== thread.id ||
        !thread.term ||
        !thread.pane ||
        !terminalHost.contains(thread.pane)
      ) {
        return;
      }
      thread.term.focus();
    });
  }

  function endPaneRenderFocusSuppression(threads) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        threads.forEach(function (thread) {
          thread.internalPaneRenderDepth = Math.max(
            0,
            (thread.internalPaneRenderDepth || 0) - 1
          );
        });
      });
    });
  }
```

The two-frame release is intentional. `focusThread` already restores xterm
focus in the next animation frame, so suppression must remain active through
that callback. The depth counter prevents an earlier render's cleanup from
ending suppression while a later overlapping render is still settling.

- [ ] **Step 6: Wrap `renderPaneWorkspace` in guaranteed cleanup**

Replace `renderPaneWorkspace` with:

```js
  function renderPaneWorkspace() {
    if (!terminalHost) return;
    var focusedThread = focusedTerminalThreadForRender();
    var suppressedThreads = beginPaneRenderFocusSuppression();
    try {
      stageBrowserSurface();
      terminalHost.replaceChildren();
      var layout = activePaneLayout();
      if (!layout || !layout.root) {
        renderTerminalEmptyState();
        renderPaneMinimap(layout, findOpenFile(state.activeFileId));
        return;
      }
      var root = effectivePaneRoot(layout);
      var projected = PsychePanes.layoutRects(
        root,
        measuredTerminalHost(),
        PANE_MINIMUMS
      );
      var splitRatios = new Map();
      projected.splits.forEach(function (split) {
        splitRatios.set(split.splitId, split.ratio);
      });
      terminalHost.appendChild(renderPaneNode(root, splitRatios));
      PsychePanes.leafIds(layout.root).forEach(function (leafId) {
        var leaf = PsychePanes.findLeafById(layout.root, leafId);
        var thread = leaf && findThread(leaf.threadId);
        if (!thread || !thread.pane) return;
        thread.pane.classList.toggle("focused", thread.id === state.activeThreadId);
        syncPanePicking(thread);
        syncThreadPaneMetadata(thread);
      });
      renderSetPickBar();
      renderPaneMinimap(layout, findOpenFile(state.activeFileId));
      scheduleVisiblePaneFit();
      requestAnimationFrame(syncBrowserBounds);
    } finally {
      restoreRenderedTerminalFocus(focusedThread);
      endPaneRenderFocusSuppression(suppressedThreads);
    }
  }
```

Keep the existing comment explaining why span and maximise synchronize every
pane, placing it immediately before the `PsychePanes.leafIds` loop.

- [ ] **Step 7: Run the focused tests and verify GREEN**

Run:

```bash
pnpm vitest --run __tests__/tauriPhysicalPanes.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the renderer lifecycle change**

```bash
git add native/macos/psyche-build-tauri/web/main.js __tests__/tauriPhysicalPanes.test.ts
git commit -m "fix(macos): preserve terminal focus across pane renders" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Verify the Codex launch regression boundary

**Files:**
- Verify: `native/macos/psyche-build-tauri/web/main.js`
- Verify: `__tests__/tauriPhysicalPanes.test.ts`
- Verify: `__tests__/tauriCovenLaunch.test.ts`

- [ ] **Step 1: Run the focused native pane and agent launch tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriCovenLaunch.test.ts
```

Expected: PASS with both test files green.

- [ ] **Step 2: Type-check the test harness**

Run:

```bash
pnpm run typecheck:tests
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Rebuild the committed native web bundles**

Run:

```bash
pnpm --filter psyche-build-tauri run build:web
git --no-pager diff --check
git --no-pager status --short
```

Expected: the web build succeeds, `git diff --check` reports no whitespace
errors, and no generated bundle changes appear because this patch modifies the
unbundled `web/main.js` entry only.

- [ ] **Step 4: Inspect the final diff against the acceptance criteria**

Run:

```bash
git --no-pager diff HEAD~2 -- \
  native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriPhysicalPanes.test.ts
```

Confirm:

1. only exact `ESC[I` and `ESC[O` report-only payloads are dropped;
2. filtering is active only while pane render depth is positive;
3. cleanup decrements one depth per render after two animation frames;
4. focused terminals are restored only when still live, active, and visible;
5. no PTY, Rust, agent launch descriptor, or persistence behavior changed.
