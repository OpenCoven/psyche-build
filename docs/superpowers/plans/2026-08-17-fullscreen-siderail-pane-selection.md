# Fullscreen Siderail Pane Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep fullscreen mode active while switching its visible and focused pane when the user selects another local pane from the left siderail.

**Architecture:** Preserve `focusThread` as the single pane-selection transition used by the siderail and other focus entry points. When its target belongs to a currently maximized layout, move both `focusedLeafId` and `maximizedLeafId` to the target leaf before the existing workspace render and terminal-focus restoration.

**Tech Stack:** Browser JavaScript, Psyche pane-tree utilities, TypeScript, Vitest.

---

## File structure

- Modify: `native/desktop/psyche-build-tauri/web/main.js` — keep the active layout's maximized leaf synchronized with explicit thread focus.
- Modify: `__tests__/tauriPhysicalPanes.test.ts` — expose layout state through the existing focus harness and cover maximized and tiled focus transitions.

### Task 1: Synchronize fullscreen state during pane focus

**Files:**
- Modify: `__tests__/tauriPhysicalPanes.test.ts:223-330`
- Modify: `__tests__/tauriPhysicalPanes.test.ts:1020-1340`
- Modify: `native/desktop/psyche-build-tauri/web/main.js:4465-4471`
- Test: `__tests__/tauriPhysicalPanes.test.ts`

- [ ] **Step 1: Extend the pane-focus harness with an optional layout**

Add a focused layout type above `createPaneFocusHarness`:

```ts
type PaneFocusLayout = {
  root: Record<string, unknown>;
  focusedLeafId: string | null;
  maximizedLeafId?: string | null;
};
```

Add an optional fourth argument while preserving all existing callers:

```ts
function createPaneFocusHarness(
  threads: PaneFocusThread[],
  activeThreadId: string,
  activeElement: unknown = null,
  layout: PaneFocusLayout | null = null,
) {
```

Pass the supplied layout and real pane-tree helpers into the compiled
`focusThread`:

```ts
    paneLayoutFor: () => layout,
    PsychePanes,
```

- [ ] **Step 2: Write the failing fullscreen-selection regression**

Add this test alongside the existing `focusThread` transition tests:

```ts
  it('moves fullscreen focus to the explicitly selected pane', async () => {
    const source: PaneFocusThread = {
      id: 'thread-fullscreen-source',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      pane: { id: 'pane-fullscreen-source' },
      host: { contains: () => false },
      term: { blur: () => undefined, focus: () => undefined },
    };
    const target: PaneFocusThread = {
      id: 'thread-fullscreen-target',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      pane: { id: 'pane-fullscreen-target' },
      host: { contains: () => false },
      term: { blur: () => undefined, focus: () => undefined },
    };
    const root = PsychePanes.insertBelow(
      PsychePanes.createLeaf('leaf-fullscreen-source', source.id),
      'leaf-fullscreen-source',
      PsychePanes.createLeaf('leaf-fullscreen-target', target.id),
      'split-fullscreen',
    );
    const fullscreenLayout: PaneFocusLayout = {
      root,
      focusedLeafId: 'leaf-fullscreen-source',
      maximizedLeafId: 'leaf-fullscreen-source',
    };
    const fullscreenHarness = createPaneFocusHarness(
      [source, target],
      source.id,
      null,
      fullscreenLayout,
    );

    await expect(fullscreenHarness.focusThread(target.id)).resolves.toBe(true);

    expect(fullscreenHarness.state.activeThreadId).toBe(target.id);
    expect(fullscreenLayout.focusedLeafId).toBe('leaf-fullscreen-target');
    expect(fullscreenLayout.maximizedLeafId).toBe('leaf-fullscreen-target');
    expect(
      PsychePanes.findLeafById(
        fullscreenLayout.root,
        fullscreenLayout.maximizedLeafId,
      )?.threadId,
    ).toBe(target.id);

    const tiledLayout: PaneFocusLayout = {
      root,
      focusedLeafId: 'leaf-fullscreen-source',
      maximizedLeafId: null,
    };
    const tiledHarness = createPaneFocusHarness(
      [source, target],
      source.id,
      null,
      tiledLayout,
    );

    await expect(tiledHarness.focusThread(target.id)).resolves.toBe(true);

    expect(tiledHarness.state.activeThreadId).toBe(target.id);
    expect(tiledLayout.focusedLeafId).toBe('leaf-fullscreen-target');
    expect(tiledLayout.maximizedLeafId).toBeNull();
  });
```

- [ ] **Step 3: Run the focused test and verify the regression fails**

Run:

```bash
pnpm vitest --run __tests__/tauriPhysicalPanes.test.ts
```

Expected: FAIL in `moves fullscreen focus to the explicitly selected pane`
because `fullscreenLayout.maximizedLeafId` remains
`leaf-fullscreen-source`.

- [ ] **Step 4: Update the centralized focus transition**

Replace the current single-line focused-leaf assignment in `focusThread`:

```js
    if (layout && leaf) layout.focusedLeafId = leaf.id;
```

with:

```js
    if (layout && leaf) {
      if (layout.maximizedLeafId) layout.maximizedLeafId = leaf.id;
      layout.focusedLeafId = leaf.id;
    }
```

Do not change `activateLocalRow`; it must continue delegating to `focusThread`
so siderail, keyboard, palette, and other explicit focus paths share the same
fullscreen behavior.

- [ ] **Step 5: Run the focused native pane suite**

Run:

```bash
pnpm vitest --run __tests__/tauriPhysicalPanes.test.ts
```

Expected: PASS, including the new fullscreen-selection regression and existing
focus, span, maximize, pane lifecycle, and terminal-focus-report tests.

- [ ] **Step 6: Type-check the test harness**

Run:

```bash
pnpm typecheck:tests
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 7: Commit the implementation**

```bash
git add \
  __tests__/tauriPhysicalPanes.test.ts \
  native/desktop/psyche-build-tauri/web/main.js
git commit -m "fix: switch focused pane in fullscreen mode" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
