# Files Pane Interaction Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the native Files pane header support the same drag-to-reposition and double-click maximize behavior as other canvas panes.

**Architecture:** Keep Files as a first-class leaf in the existing pane tree and delegate its missing header interactions to `startPaneReposition` and `togglePaneMaximize`. Existing generic divider resizing, hide/restore, dirty-file close, leaf removal, and split collapse paths remain unchanged and are covered by the focused regression suite.

**Tech Stack:** Browser JavaScript, DOM pointer events, Vitest, TypeScript test harness, Psyche pane-tree utilities.

---

## File structure

- Modify: `native/desktop/psyche-build-tauri/web/main.js` — wire the Files header into existing pane reposition and maximize behavior.
- Modify: `__tests__/tauriWorkspaceFilesPaneView.test.ts` — exercise Files header events and button-event isolation through the existing fake DOM seam.
- Verify without modification: `__tests__/tauriWorkspaceFilesPaneLifecycle.test.ts` — dirty guards, hide/restore, whole-pane close, and leaf removal.
- Verify without modification: `__tests__/tauriPhysicalPanes.test.ts` and `__tests__/tauriPaneTree.test.ts` — generic divider resizing, movement, leaf removal, and tree collapse.

### Task 1: Add Files header interaction parity

**Files:**
- Modify: `__tests__/tauriWorkspaceFilesPaneView.test.ts:91-163`
- Modify: `native/desktop/psyche-build-tauri/web/main.js:2948-3017`
- Test: `__tests__/tauriWorkspaceFilesPaneView.test.ts`
- Test: `__tests__/tauriWorkspaceFilesPaneLifecycle.test.ts`
- Test: `__tests__/tauriPhysicalPanes.test.ts`
- Test: `__tests__/tauriPaneTree.test.ts`

- [ ] **Step 1: Write the failing Files header behavior test**

First, give `FakeElement` listeners a callable event type:

```ts
  listeners = new Map<
    string,
    Array<(event: Record<string, unknown>) => unknown>
  >();

  addEventListener(
    name: string,
    listener: (event: Record<string, unknown>) => unknown,
  ) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
  }
```

Then add this test after `reparents the existing file view when mounting a Files surface`:

```ts
  it('repositions and maximizes Files from non-button header gestures', () => {
    const fileView = new FakeElement();
    const repositionEvents: unknown[] = [];
    const maximizedSurfaces: unknown[] = [];
    const mountFilesPane = compileFunction<(surface: Record<string, unknown>) => FakeElement>(
      extractFunctionSource('mountFilesPane'),
      {
        document: { createElement: () => new FakeElement() },
        fileViewEl: fileView,
        createPaneHideButton: () => new FakeElement(),
        startPaneReposition: (surface: unknown, event: unknown) => {
          repositionEvents.push([surface, event]);
        },
        togglePaneMaximize: (surface: unknown) => {
          maximizedSurfaces.push(surface);
        },
        closeFilesPane: () => undefined,
        focusCanvasSurface: () => undefined,
      },
    );
    const surface: Record<string, unknown> = {
      id: 'files-a',
      projectId: 'project-a',
      workspaceRoot: '/worktree',
      kind: 'files',
    };
    const pane = mountFilesPane(surface);
    const header = pane.children[0];
    const pointerdown = header.listeners.get('pointerdown')?.[0];
    const dblclick = header.listeners.get('dblclick')?.[0];
    const headerTarget = { closest: () => null };
    const pointerEvent = { target: headerTarget };
    let prevented = 0;

    expect(pointerdown).toBeTypeOf('function');
    expect(dblclick).toBeTypeOf('function');
    pointerdown?.(pointerEvent);
    dblclick?.({
      target: headerTarget,
      preventDefault: () => { prevented += 1; },
    });

    expect(repositionEvents).toEqual([[surface, pointerEvent]]);
    expect(maximizedSurfaces).toEqual([surface]);
    expect(prevented).toBe(1);

    const buttonTarget = {
      closest: (selector: string) => selector === 'button' ? {} : null,
    };
    pointerdown?.({ target: buttonTarget });
    dblclick?.({
      target: buttonTarget,
      preventDefault: () => { prevented += 1; },
    });

    expect(repositionEvents).toHaveLength(1);
    expect(maximizedSurfaces).toHaveLength(1);
    expect(prevented).toBe(1);
  });
```

- [ ] **Step 2: Run the new test to verify the interaction gap**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspaceFilesPaneView.test.ts
```

Expected: FAIL in `repositions and maximizes Files from non-button header gestures` because the Files header has no `pointerdown` or `dblclick` listener.

- [ ] **Step 3: Delegate Files header gestures to the existing pane handlers**

In `mountFilesPane`, after the close button listener and before appending the header children, add:

```js
    header.addEventListener("pointerdown", function (event) {
      if (event.target && event.target.closest && event.target.closest("button")) return;
      startPaneReposition(filesPane, event);
    });
    header.addEventListener("dblclick", function (event) {
      if (event.target && event.target.closest && event.target.closest("button")) return;
      event.preventDefault();
      togglePaneMaximize(filesPane);
    });
```

Do not add Files-specific drag, resize, close, or layout code. The handlers must continue to operate on the Files surface through the shared pane-tree APIs.

- [ ] **Step 4: Run the Files view test to verify the patch**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspaceFilesPaneView.test.ts
```

Expected: PASS, including the new non-button gesture and button-isolation assertions.

- [ ] **Step 5: Run the focused pane parity regression suite**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriWorkspaceFilesPaneView.test.ts \
  __tests__/tauriWorkspaceFilesPaneLifecycle.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriPaneTree.test.ts
```

Expected: PASS. This proves the new header wiring alongside existing divider resizing, movement, hide/restore, dirty-file close refusal, successful whole-pane close, leaf removal, and split collapse behavior.

- [ ] **Step 6: Type-check the test harness and inspect the final diff**

Run:

```bash
pnpm typecheck:tests
git --no-pager diff --check -- \
  native/desktop/psyche-build-tauri/web/main.js \
  __tests__/tauriWorkspaceFilesPaneView.test.ts
git --no-pager diff -- \
  native/desktop/psyche-build-tauri/web/main.js \
  __tests__/tauriWorkspaceFilesPaneView.test.ts
```

Expected: the test type-check and whitespace check exit `0`; the diff contains only the Files header listeners and their regression test.

- [ ] **Step 7: Commit the verified implementation**

```bash
git add \
  native/desktop/psyche-build-tauri/web/main.js \
  __tests__/tauriWorkspaceFilesPaneView.test.ts
git commit \
  -m "fix: align Files pane interactions" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: one implementation commit containing the Files header parity patch and its focused test.
