# GPU ADE Slice 3: Terminal Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every terminal pane an isolated WebGL/fallback lifecycle and schedule visible rendering, fitting, resizing, and layout work at most once per animation frame.

**Architecture:** Add testable TypeScript runtime primitives behind the `PsycheRuntime` bundle. The existing shell remains responsible for projects and pane layout, while a controller owns each xterm instance and a keyed scheduler coalesces replaceable visual work.

**Tech Stack:** TypeScript, esbuild, xterm.js 6, xterm WebGL/Fit addons, browser observers, Vitest, CSS.

---

Prerequisite: Slice 2 is green and `PsycheRuntime` owns acknowledged PTY delivery.

## File map

- Create `web/runtime/frame-scheduler.ts` — keyed requestAnimationFrame coalescing and metrics.
- Create `web/runtime/terminal-pane-controller.ts` — per-pane xterm, WebGL, fit, visibility, output, and disposal lifecycle.
- Create `web/runtime/virtual-list.ts` — bounded collection windowing.
- Modify `web/runtime/runtime-entry.ts`, generated `runtime.bundle.js`, `web/main.js`, and `styles.css`.
- Create `__tests__/tauriFrameScheduler.test.ts`, `tauriTerminalRenderer.test.ts`, `tauriVirtualList.test.ts`, and `tauriCompositorCss.test.ts`.

### Task 1: Implement a keyed frame scheduler

**Files:**
- Create: `web/runtime/frame-scheduler.ts`
- Create: `__tests__/tauriFrameScheduler.test.ts`
- Modify: `web/runtime/runtime-entry.ts`

- [ ] **Step 1: Write failing scheduler tests**

```ts
import { describe, expect, it } from 'vitest';
import { FrameScheduler } from '../native/desktop/psyche-build-tauri/web/runtime/frame-scheduler';

it('runs only the latest value for a key in one frame', () => {
  const queued: FrameRequestCallback[] = [];
  const values: number[] = [];
  const scheduler = new FrameScheduler((cb) => (queued.push(cb), queued.length));
  scheduler.schedule('pane-1:fit', () => values.push(1));
  scheduler.schedule('pane-1:fit', () => values.push(2));
  expect(queued).toHaveLength(1);
  queued.shift()!(16);
  expect(values).toEqual([2]);
  expect(scheduler.snapshot().coalescedVisualUpdates).toBe(1);
});

it('keeps different panes independent', () => {
  // Schedule pane-a:fit and pane-b:fit, flush once, and expect both callbacks.
});
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest --run __tests__/tauriFrameScheduler.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement the scheduler**

`FrameScheduler` stores the latest callback per string key, requests one browser frame, swaps the pending map before executing, and schedules another frame only if callbacks enqueue new work. `cancelPrefix('pane-1:')` removes disposed-pane work. Callback failure is isolated and reported through an injected error sink.

- [ ] **Step 4: Verify GREEN and commit**

Run the focused test, then:

```bash
git add native/desktop/psyche-build-tauri/web/runtime __tests__/tauriFrameScheduler.test.ts
git commit -m "Add keyed rendering frame scheduler"
```

### Task 2: Build the isolated terminal controller

**Files:**
- Create: `web/runtime/terminal-pane-controller.ts`
- Create: `__tests__/tauriTerminalRenderer.test.ts`
- Modify: `web/runtime/runtime-entry.ts`, `web/main.js`

- [ ] **Step 1: Write failing controller lifecycle tests**

Use fake terminal/addon/observer factories. Cover one terminal per pane, visible output scheduled once per frame, fit only while visible and connected, resize only for changed dimensions, and disposal of every registration.

```ts
it('does not fit or paint while effectively hidden', () => {
  const fixture = createControllerFixture();
  fixture.controller.setVisibility({ document: true, pane: false, intersecting: true });
  fixture.controller.receive(batch(1, 'hidden'));
  fixture.frames.flush();
  expect(fixture.fit.fit).not.toHaveBeenCalled();
  expect(fixture.term.write).not.toHaveBeenCalled();
  fixture.hiddenDrain.flush();
  expect(fixture.term.write).toHaveBeenCalledOnce();
  expect(fixture.term.refresh).not.toHaveBeenCalled();
});

it('disposes only the selected pane', () => {
  const a = createControllerFixture('a');
  const b = createControllerFixture('b');
  a.controller.dispose();
  expect(a.term.dispose).toHaveBeenCalledOnce();
  expect(b.term.dispose).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest --run __tests__/tauriTerminalRenderer.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement the controller contract**

```ts
export type RendererState = 'initializing' | 'webgl' | 'recovering' | 'fallback' | 'disposed';

export interface TerminalPaneController {
  receive(batch: PtyDataBatch): void;
  setVisibility(state: VisibilityState): void;
  scheduleFit(): void;
  focus(): void;
  rendererSnapshot(): RendererSnapshot;
  dispose(): void;
}
```

Construct xterm with `scrollback: 10_000`. The controller owns FitAddon, observers, PTY client, xterm disposables, scheduled keys, and hidden drain timer. Visible output goes through the frame scheduler. Hidden/background output is parsed no faster than 100 ms without fitting or calling refresh. A visibility restore schedules one fit before the next visible write.

- [ ] **Step 4: Integrate `main.js` without changing pane ownership**

Replace the xterm construction and addon wiring inside `mountTerminal` with `PsycheRuntime.createTerminalPaneController`. Store the controller on `thread.terminalController`; keep `thread.term` only as a temporary compatibility alias for link/tail functions. Route focus, fit, close, theme, and output through the controller. Remove the old global `visiblePaneFitFrame` path after all callers use keyed scheduling.

- [ ] **Step 5: Verify GREEN and existing terminal behavior**

```bash
pnpm --dir native/desktop/psyche-build-tauri build:web
pnpm vitest --run __tests__/tauriTerminalRenderer.test.ts __tests__/tauriFrameScheduler.test.ts __tests__/terminalLinks.test.ts __tests__/tauriPhysicalPanes.test.ts __tests__/tauriWebBundles.test.ts
```

- [ ] **Step 6: Commit controller integration**

```bash
git add native/desktop/psyche-build-tauri/web __tests__/tauriTerminalRenderer.test.ts __tests__/tauriFrameScheduler.test.ts
git commit -m "Isolate terminal pane rendering lifecycles"
```

### Task 3: Recover WebGL loss or fall back cleanly

**Files:**
- Modify: `web/runtime/terminal-pane-controller.ts`
- Test: `__tests__/tauriTerminalRenderer.test.ts`

- [ ] **Step 1: Add failing context-loss tests**

Test successful one-time recreation, failed recreation to fallback, a second loss within 30 seconds staying fallback, no xterm/PTY disposal, and isolation from another pane.

```ts
it('recreates WebGL once after a visible stable frame', () => {
  const fixture = createControllerFixture('pane', { webglAddons: [firstWebgl, secondWebgl] });
  firstWebgl.loseContext();
  expect(fixture.controller.rendererSnapshot().state).toBe('recovering');
  fixture.frames.flush();
  expect(firstWebgl.dispose).toHaveBeenCalledOnce();
  expect(secondWebgl.loaded).toBe(true);
  expect(fixture.controller.rendererSnapshot().state).toBe('webgl');
  expect(fixture.term.dispose).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify RED**

Expected: failure because context loss currently only disposes the addon.

- [ ] **Step 3: Implement the renderer state machine**

Load WebGL only after `term.open`. Register `onContextLoss`, dispose the failed addon, and schedule `pane:<id>:webgl-recover`. Retry only when connected, visible, and measurably sized. If construction/load throws, set `fallback` with a bounded reason. If another loss occurs within 30 seconds, remain fallback. Never dispose xterm or stop the PTY during renderer fallback.

- [ ] **Step 4: Verify GREEN and commit**

Run focused tests and bundle freshness, then commit as `Recover terminal WebGL context loss`.

### Task 4: Throttle pane and browser geometry to one frame

**Files:**
- Modify: `web/main.js`
- Modify: `web/runtime/frame-scheduler.ts`
- Test: `__tests__/tauriFrameScheduler.test.ts`, existing pane-tree/browser tests

- [ ] **Step 1: Add failing integration contracts**

Assert split/sidebar pointer moves call `scheduleLayout`, `window.resize` schedules fit/browser bounds/tab measurements, and direct high-frequency `syncBrowserBounds()` calls are absent from event handlers.

- [ ] **Step 2: Run and verify RED**

Run focused frame, pane tree, desktop tabs, and workspace editor integration tests.

- [ ] **Step 3: Route replaceable geometry through keyed scheduling**

Use keys `layout:pane-tree`, `layout:sidebar`, `browser:<id>:bounds`, and `pane:<id>:fit`. Pointer handlers update only the latest model value and schedule work. Send `pty_resize` only when the fitted `{cols, rows}` differs from the controller's last sent size.

- [ ] **Step 4: Verify GREEN and commit**

Run the focused tests plus a browser bounds smoke. Commit as `Coalesce pane geometry per frame`.

### Task 5: Virtualize long collections

**Files:**
- Create: `web/runtime/virtual-list.ts`
- Create: `__tests__/tauriVirtualList.test.ts`
- Modify: `web/main.js`, `web/runtime/runtime-entry.ts`

- [ ] **Step 1: Write failing pure windowing tests**

```ts
expect(computeVirtualWindow({ count: 1_000, rowHeight: 28, viewportHeight: 280, scrollTop: 2_800, overscan: 8 }))
  .toEqual({ start: 92, end: 118, before: 2_576, after: 24_696 });
expect(shouldVirtualize(200)).toBe(false);
expect(shouldVirtualize(201)).toBe(true);
```

Also test clamping, active-row inclusion, stable keys, empty lists, and estimated variable-height file rows.

- [ ] **Step 2: Run and verify RED**

Expected: module-not-found failure.

- [ ] **Step 3: Implement and integrate virtualization**

Use threshold 200 and overscan 8. Render top/bottom spacers plus the visible window for session/process lists, file trees, and diagnostic logs. Preserve selected item identity and keyboard traversal by stable key. Terminal history remains xterm's viewport with the explicit 10,000-line scrollback bound.

- [ ] **Step 4: Verify GREEN and commit**

Run virtual-list, sidebar, file-browser, workspace-panel, and terminal tests. Commit as `Virtualize long desktop collections`.

### Task 6: Enforce compositor-safe CSS

**Files:**
- Create: `__tests__/tauriCompositorCss.test.ts`
- Modify: `web/styles.css`, `web/main.js`

- [ ] **Step 1: Write a failing CSS audit test**

Parse every `@keyframes` block and reject animated declarations other than `transform` and `opacity`. Reject transitions naming width, height, top, right, bottom, left, inset, background-position, box-shadow, filter, or backdrop-filter. Assert `will-change` appears only under `.is-transitioning` selectors.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest --run __tests__/tauriCompositorCss.test.ts`

Expected: FAIL on current shimmer/layout/glass effects.

- [ ] **Step 3: Replace unsafe animations and reduce costly effects**

Convert shimmer to a translated pseudo-element or make it static. Remove layout-property animation. Reduce nested backdrop filters, large terminal shadows, and transparent stacked terminal surfaces. Preserve resizing as scheduled direct geometry, not animation.

Add `beginCompositorTransition(element)` which adds `.is-transitioning`, removes it on `transitionend`/`animationend`, and has a 500 ms cancellation timeout. No global or persistent `will-change` declaration is allowed.

- [ ] **Step 4: Verify GREEN and reduced-motion behavior**

Run compositor, desktop tab, workspace panel, and smoke tests. Inspect terminal/editor/browser focus transitions at normal and reduced-motion settings.

- [ ] **Step 5: Commit the CSS audit**

```bash
git add native/desktop/psyche-build-tauri/web __tests__/tauriCompositorCss.test.ts
git commit -m "Keep desktop transitions compositor safe"
```

### Task 7: Verify Slice 3

- [ ] **Step 1: Run focused rendering gates**

```bash
pnpm --dir native/desktop/psyche-build-tauri build:web
pnpm vitest --run __tests__/tauriFrameScheduler.test.ts __tests__/tauriTerminalRenderer.test.ts __tests__/tauriVirtualList.test.ts __tests__/tauriCompositorCss.test.ts __tests__/tauriWebBundles.test.ts
pnpm typecheck
```

- [ ] **Step 2: Run interactive renderer checks**

With six streaming panes, resize continuously, switch focus, hide/show panes, change projects, minimize/restore, and force context loss from a debug hook. Confirm hidden panes do not fit/refresh, visible resize runs once per frame, and WebGL recovery/fallback does not stop output.

- [ ] **Step 3: Inspect resource ownership**

Close all panes and confirm observers, timers, animation frames, xterm instances, WebGL addons, and PTYs return to zero in the runtime snapshot.
