# Pane Hide Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace pane-topbar span cycling with a reversible Hide pane control for terminal, agent, browser, Git, and Files surfaces.

**Architecture:** `main.js` mounts the same three-control header independently for each surface type. Replace the first control with one shared Hide button factory that dispatches through a canvas-surface hide adapter. Threads retain their established `hidden` lifecycle; Files receives an equivalent persisted visibility record and reversible leaf placement.

**Tech Stack:** Tauri native web shell, vanilla JavaScript modules, Vitest.

---

## File structure

- `native/desktop/psyche-build-tauri/web/main.js` — pane-header controls and canvas-surface hide/restore lifecycle.
- `native/desktop/psyche-build-tauri/web/styles.css` — shared first-control selector, retaining the 22px control footprint and focus treatment.
- `__tests__/tauriWorkspaceRail.test.ts` — header action contract for every pane mount.
- `__tests__/tauriWorkspaceFilesPaneView.test.ts` — Files hide wiring and restore contract.
- `__tests__/tauriPhysicalPanes.test.ts` — reversible lifecycle behavior.

### Task 1: Lock down topbar replacement

**Files:**
- Modify: `__tests__/tauriWorkspaceRail.test.ts`
- Modify: `__tests__/tauriWorkspaceFilesPaneView.test.ts`
- Modify: `native/desktop/psyche-build-tauri/web/main.js`
- Modify: `native/desktop/psyche-build-tauri/web/styles.css`

- [ ] **Step 1: Write the failing header-contract tests**

Assert that `mountToolPane`, `mountBrowserPane`, `mountTerminal`, and `mountFilesPane` call `createPaneHideButton`, provide `title` and `aria-label` equal to `Hide pane`, and no longer wire `cyclePaneSpan`.

- [ ] **Step 2: Verify red**

Run: `pnpm vitest --run __tests__/tauriWorkspaceRail.test.ts __tests__/tauriWorkspaceFilesPaneView.test.ts`

Expected: failure because the existing header creates `terminal-pane-span` and calls `cyclePaneSpan`.

- [ ] **Step 3: Implement the shared control**

Add this factory to `main.js`, then use it as the first control in each mount function:

```js
function createPaneHideButton(surface) {
  var hide = document.createElement("button");
  hide.type = "button";
  hide.className = "terminal-pane-hide";
  hide.title = "Hide pane";
  hide.setAttribute("aria-label", "Hide pane");
  hide.textContent = "−";
  hide.addEventListener("click", function (event) {
    event.stopPropagation();
    hideCanvasSurface(surface);
  });
  return hide;
}
```

Store the result as `paneHide`; remove `paneSpan` assignment and `syncPaneSpanControl` calls. Rename CSS selector groups from `.terminal-pane-span` to `.terminal-pane-hide` without changing their size, hover, opacity, or focus behavior.

- [ ] **Step 4: Verify green**

Run: `pnpm vitest --run __tests__/tauriWorkspaceRail.test.ts __tests__/tauriWorkspaceFilesPaneView.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/desktop/psyche-build-tauri/web/main.js native/desktop/psyche-build-tauri/web/styles.css __tests__/tauriWorkspaceRail.test.ts __tests__/tauriWorkspaceFilesPaneView.test.ts
git commit -m "feat: replace pane span control with hide"
```

### Task 2: Generalize reversible canvas-surface hiding

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/main.js`
- Modify: `__tests__/tauriPhysicalPanes.test.ts`
- Modify: `__tests__/tauriWorkspaceFilesPaneView.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Compile and invoke `hideCanvasSurface(surface)` and `reopenCanvasSurface(id)` with terminal and Files fixtures. Assert that hide detaches the leaf, sets `hidden = true`, leaves the surface alive, updates focus, and persists; assert restore uses `preparePanePlacement`, clears `hidden`, commits placement, renders, focuses, refreshes the switcher, and persists.

- [ ] **Step 2: Verify red**

Run: `pnpm vitest --run __tests__/tauriPhysicalPanes.test.ts`

Expected: failure because generic hide/restore functions and a Files visibility lifecycle do not yet exist.

- [ ] **Step 3: Implement the surface adapters**

Implement `hideCanvasSurface(surface)` to delegate thread surfaces to `hideThread(surface.id)`. For Files, detach its leaf, set `filesPane.hidden = true`, render the next surface, refresh the switcher, and save the workspace.

Implement `reopenCanvasSurface(id)` to delegate thread surfaces to `reopenThread(id)`. For a hidden Files surface in the active project/worktree, call `preparePanePlacement`, clear `hidden`, call `commitPanePlacement`, focus Files, render, refresh the switcher, and save. Keep `hideThread` and `reopenThread` unchanged so Git request suspension/reveal remains intact.

Ensure canvas enumeration retains hidden Files surfaces but renders only visible leaves; preserve its file editor state on the surface object. Update `ensureFilesPane` and file activation so selecting or opening a file restores a hidden Files pane before it receives focus.

- [ ] **Step 4: Verify green**

Run: `pnpm vitest --run __tests__/tauriPhysicalPanes.test.ts __tests__/tauriWorkspaceFilesPaneView.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/desktop/psyche-build-tauri/web/main.js __tests__/tauriPhysicalPanes.test.ts __tests__/tauriWorkspaceFilesPaneView.test.ts
git commit -m "feat: make pane hiding reversible"
```

### Task 3: Run integration verification

**Files:**
- Modify only if a focused regression assertion needs correction: `__tests__/tauriWorkspaceRail.test.ts`, `__tests__/tauriPhysicalPanes.test.ts`, `__tests__/tauriWorkspaceFilesPaneView.test.ts`

- [ ] **Step 1: Verify header removal and integration**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspaceRail.test.ts __tests__/tauriWorkspaceFilesPaneView.test.ts __tests__/tauriPhysicalPanes.test.ts
pnpm typecheck
pnpm --dir native/desktop/psyche-build-tauri build:web
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 2: Commit any final test-only alignment**

```bash
git add __tests__/tauriWorkspaceRail.test.ts __tests__/tauriPhysicalPanes.test.ts __tests__/tauriWorkspaceFilesPaneView.test.ts
git commit -m "test: cover reversible pane hiding"
```
