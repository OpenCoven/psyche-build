# Native Coven Physical Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `coven chat` the default macOS Psyche terminal experience, render independent Tauri PTYs as simultaneous physical panes, and attach discovered Coven sessions without routing through tmux.

**Architecture:** Keep PTY/process ownership in `state.threads`, add a pure bundled pane-tree module for top/bottom layout, and let `main.js` coordinate the two without persisting process topology. Harden `pty_start` so project scope and cwd are distinct and linked worktrees are validated in Rust. Reintroduce the existing bounded Coven discovery adapter only after physical panes and default launch are independently stable.

**Tech Stack:** Tauri 2, Rust 2021, `portable-pty`, vanilla JavaScript, xterm.js, esbuild IIFE bundles, TypeScript, Vitest, pnpm.

**Design:** `docs/superpowers/specs/2026-08-08-native-coven-physical-panes-design.md`

**Repository rule:** Execute each PR phase in its own short-lived worktree. Create PR 1 from the reviewed documentation commit at `HEAD`; create later phases from freshly verified `origin/main` after their prerequisite PR merges. The commit steps below require Val's explicit approval before running; do not commit, push, merge, or delete branches automatically.

---

## File map

### PR 1 — Physical pane foundation

- Create `native/macos/psyche-build-tauri/web/panes/pane-tree.mjs`: pure immutable pane-tree operations and rectangle projection.
- Create `native/macos/psyche-build-tauri/web/panes/pane-entry.js`: exports the pure module into the `PsychePanes` IIFE global.
- Generate `native/macos/psyche-build-tauri/web/panes.bundle.js`: checked-in browser bundle.
- Create `__tests__/tauriPaneTree.test.ts`: behavior tests for tree mutation, fit constraints, and geometry.
- Create `__tests__/tauriPhysicalPanes.test.ts`: source/DOM contracts for physical rendering, focus, dividers, and resize scheduling.
- Modify `native/macos/psyche-build-tauri/package.json`: build the pane bundle.
- Modify `native/macos/psyche-build-tauri/web/index.html`: load `panes.bundle.js` before `main.js`.
- Modify `native/macos/psyche-build-tauri/web/main.js`: own process-local pane layouts and render visible terminal leaves.
- Modify `native/macos/psyche-build-tauri/web/styles.css`: physical pane, header, divider, focus, and minimum-size presentation.
- Modify `__tests__/tauriWorkspacePanels.test.ts`: pin bundle generation and load order.
- Modify `__tests__/tauriWorkspaceEditorIntegration.test.ts`: replace active-only fit dependencies with visible-pane scheduling.

### PR 2 — Default Coven launch

- Create `__tests__/tauriCovenLaunch.test.ts`: webview launch, retry, close, and source-boundary contracts.
- Modify `native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs`: expose the existing safe session-id predicate within the crate.
- Modify `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`: split project scope from cwd, validate linked worktrees, expose executable `coven_path`, and validate Coven attach identifiers.
- Modify `native/macos/psyche-build-tauri/web/main.js`: launch `coven chat` by default, add `/new-shell`, preserve `/new-psyche`, and make start/close transitions idempotent.
- Modify `native/macos/psyche-build-tauri/web/index.html`: update command-bar guidance.
- Modify `__tests__/tauriDesktopTabs.test.ts`: pin contextual Command-T to the Coven launcher.

### PR 3 — Discovery and native attach

- Modify `native/macos/psyche-build-tauri/web/sessions/session-model.mjs`: preserve last confirmed rows through refresh failures.
- Regenerate `native/macos/psyche-build-tauri/web/sessions.bundle.js`.
- Modify `native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs`: drop discovered records with explicitly unsafe cwd values.
- Modify `native/macos/psyche-build-tauri/web/main.js`: restore visible-only discovery polling, remote rail rows, and deduplicated native attach.
- Modify `native/macos/psyche-build-tauri/web/styles.css`: remote row and stale/error state presentation.
- Modify `__tests__/tauriSessionModel.test.ts`: stale-data and recovery behavior.
- Modify `__tests__/tauriCovenSessionLifecycle.test.ts`: discovery ownership, polling, attach deduplication, and tmux boundary.
- Modify `__tests__/tauriCovenSessionSiderail.test.ts`: mixed local/remote grouping and remote row interaction.
- Modify `__tests__/tauriCovenSessionNativeContract.test.ts`: keep bounded native discovery and add Rust launch-boundary source assertions.
- Modify `docs/SMOKE.md`: packaged physical-pane acceptance procedure.

---

# PR 1 — Physical pane foundation

Create the worktree only after the reviewed design and this plan are present on
the starting branch:

```bash
git fetch origin
git worktree add -b feat/native-physical-panes .worktrees/native-physical-panes HEAD
cd .worktrees/native-physical-panes
```

## Task 1: Add the pure pane-tree module

**Files:**

- Create: `native/macos/psyche-build-tauri/web/panes/pane-tree.mjs`
- Create: `native/macos/psyche-build-tauri/web/panes/pane-entry.js`
- Create: `__tests__/tauriPaneTree.test.ts`

- [ ] **Step 1: Write failing immutable tree tests**

Create `__tests__/tauriPaneTree.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  canFit,
  createLeaf,
  findLeafById,
  findLeafByThreadId,
  insertBelow,
  layoutRects,
  leafIds,
  removeLeaf,
  resizeSplit,
} from '../native/macos/psyche-build-tauri/web/panes/pane-tree.mjs';

const minimums = { width: 320, height: 120, separator: 6 };

describe('native physical pane tree', () => {
  it('inserts below focus without mutating the previous tree', () => {
    const first = createLeaf('leaf-a', 'thread-a');
    const result = insertBelow(first, 'leaf-a', createLeaf('leaf-b', 'thread-b'), 'split-1');

    expect(first).toEqual({ type: 'leaf', id: 'leaf-a', threadId: 'thread-a' });
    expect(result).toEqual({
      type: 'split',
      id: 'split-1',
      ratio: 0.5,
      first,
      second: { type: 'leaf', id: 'leaf-b', threadId: 'thread-b' },
    });
    expect(leafIds(result)).toEqual(['leaf-a', 'leaf-b']);
  });

  it('supports nested insertion and thread lookup', () => {
    const first = createLeaf('leaf-a', 'thread-a');
    const second = insertBelow(first, 'leaf-a', createLeaf('leaf-b', 'thread-b'), 'split-1');
    const third = insertBelow(
      second,
      'leaf-a',
      createLeaf('leaf-c', 'thread-c'),
      'split-2',
    );

    expect(leafIds(third)).toEqual(['leaf-a', 'leaf-c', 'leaf-b']);
    expect(findLeafByThreadId(third, 'thread-c')).toEqual(
      { type: 'leaf', id: 'leaf-c', threadId: 'thread-c' },
    );
    expect(findLeafById(third, 'leaf-c')).toEqual(
      { type: 'leaf', id: 'leaf-c', threadId: 'thread-c' },
    );
    expect(second).toEqual({
      type: 'split',
      id: 'split-1',
      ratio: 0.5,
      first,
      second: { type: 'leaf', id: 'leaf-b', threadId: 'thread-b' },
    });
  });

  it('collapses ancestors and chooses the nearest surviving leaf', () => {
    const tree = insertBelow(
      insertBelow(
        createLeaf('leaf-a', 'thread-a'),
        'leaf-a',
        createLeaf('leaf-b', 'thread-b'),
        'split-1',
      ),
      'leaf-b',
      createLeaf('leaf-c', 'thread-c'),
      'split-2',
    );

    expect(removeLeaf(tree, 'leaf-b')).toEqual({
      root: {
        type: 'split',
        id: 'split-1',
        ratio: 0.5,
        first: { type: 'leaf', id: 'leaf-a', threadId: 'thread-a' },
        second: { type: 'leaf', id: 'leaf-c', threadId: 'thread-c' },
      },
      nextLeafId: 'leaf-c',
    });
    expect(removeLeaf(createLeaf('leaf-a', 'thread-a'), 'leaf-a'))
      .toEqual({ root: null, nextLeafId: null });
  });

  it('rejects layouts below terminal minima and projects clamped rectangles', () => {
    const tree = insertBelow(
      createLeaf('leaf-a', 'thread-a'),
      'leaf-a',
      createLeaf('leaf-b', 'thread-b'),
      'split-1',
    );

    expect(canFit(tree, { width: 319, height: 500 }, minimums)).toBe(false);
    expect(canFit(tree, { width: 800, height: 245 }, minimums)).toBe(false);
    expect(canFit(tree, { width: 800, height: 246 }, minimums)).toBe(true);

    const resized = resizeSplit(tree, 'split-1', 0.9);
    const layout = layoutRects(
      resized,
      { x: 0, y: 0, width: 800, height: 300 },
      minimums,
    );
    expect(layout.leaves).toEqual([
      { leafId: 'leaf-a', threadId: 'thread-a', x: 0, y: 0, width: 800, height: 174 },
      { leafId: 'leaf-b', threadId: 'thread-b', x: 0, y: 180, width: 800, height: 120 },
    ]);
    expect(layout.splits).toEqual([
      { splitId: 'split-1', x: 0, y: 174, width: 800, height: 6, ratio: 0.5918367346938775 },
    ]);
  });
});
```

- [ ] **Step 2: Run the focused suite and verify the red state**

Run:

```bash
pnpm vitest --run __tests__/tauriPaneTree.test.ts
```

Expected: FAIL because `web/panes/pane-tree.mjs` does not exist.

- [ ] **Step 3: Implement the pure pane-tree API**

Create `native/macos/psyche-build-tauri/web/panes/pane-tree.mjs` with these
exports and invariants:

```js
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function createLeaf(id, threadId) {
  return { type: 'leaf', id, threadId };
}

export function leafIds(root) {
  if (!root) return [];
  if (root.type === 'leaf') return [root.id];
  return leafIds(root.first).concat(leafIds(root.second));
}

export function findLeafByThreadId(root, threadId) {
  if (!root) return null;
  if (root.type === 'leaf') return root.threadId === threadId ? root : null;
  return findLeafByThreadId(root.first, threadId)
    || findLeafByThreadId(root.second, threadId);
}

export function findLeafById(root, leafId) {
  if (!root) return null;
  if (root.type === 'leaf') return root.id === leafId ? root : null;
  return findLeafById(root.first, leafId) || findLeafById(root.second, leafId);
}

export function insertBelow(root, focusedLeafId, nextLeaf, splitId) {
  if (!root) return nextLeaf;
  if (root.type === 'leaf') {
    return root.id === focusedLeafId
      ? { type: 'split', id: splitId, ratio: 0.5, first: root, second: nextLeaf }
      : root;
  }
  const first = insertBelow(root.first, focusedLeafId, nextLeaf, splitId);
  if (first !== root.first) return { ...root, first };
  const second = insertBelow(root.second, focusedLeafId, nextLeaf, splitId);
  return second === root.second ? root : { ...root, second };
}

function removeNode(root, leafId) {
  if (!root) return null;
  if (root.type === 'leaf') return root.id === leafId ? null : root;
  const first = removeNode(root.first, leafId);
  const second = removeNode(root.second, leafId);
  if (!first) return second;
  if (!second) return first;
  return first === root.first && second === root.second
    ? root
    : { ...root, first, second };
}

export function removeLeaf(root, leafId) {
  const ordered = leafIds(root);
  const index = ordered.indexOf(leafId);
  if (index === -1) return { root, nextLeafId: ordered[0] ?? null };
  const nextLeafId = ordered[index + 1] ?? ordered[index - 1] ?? null;
  return { root: removeNode(root, leafId), nextLeafId };
}

function requiredHeight(root, minimums) {
  if (!root) return 0;
  if (root.type === 'leaf') return minimums.height;
  return requiredHeight(root.first, minimums)
    + minimums.separator
    + requiredHeight(root.second, minimums);
}

export function canFit(root, rect, minimums) {
  if (!root) return true;
  return rect.width >= minimums.width
    && rect.height >= requiredHeight(root, minimums);
}

export function resizeSplit(root, splitId, ratio) {
  if (!root || root.type === 'leaf') return root;
  if (root.id === splitId) return { ...root, ratio: clamp(ratio, 0, 1) };
  const first = resizeSplit(root.first, splitId, ratio);
  const second = resizeSplit(root.second, splitId, ratio);
  return first === root.first && second === root.second
    ? root
    : { ...root, first, second };
}

export function layoutRects(root, rect, minimums) {
  const leaves = [];
  const splits = [];

  function visit(node, box) {
    if (node.type === 'leaf') {
      leaves.push({ leafId: node.id, threadId: node.threadId, ...box });
      return;
    }
    const available = box.height - minimums.separator;
    const firstMinimum = requiredHeight(node.first, minimums);
    const secondMinimum = requiredHeight(node.second, minimums);
    const minimumRatio = firstMinimum / available;
    const maximumRatio = 1 - (secondMinimum / available);
    const ratio = clamp(node.ratio, minimumRatio, maximumRatio);
    const firstHeight = Math.round(available * ratio);
    const secondY = box.y + firstHeight + minimums.separator;

    visit(node.first, { ...box, height: firstHeight });
    splits.push({
      splitId: node.id,
      x: box.x,
      y: box.y + firstHeight,
      width: box.width,
      height: minimums.separator,
      ratio,
    });
    visit(node.second, {
      x: box.x,
      y: secondY,
      width: box.width,
      height: box.height - firstHeight - minimums.separator,
    });
  }

  if (root) visit(root, rect);
  return { leaves, splits };
}
```

Create `native/macos/psyche-build-tauri/web/panes/pane-entry.js`:

```js
export {
  canFit,
  createLeaf,
  findLeafById,
  findLeafByThreadId,
  insertBelow,
  layoutRects,
  leafIds,
  removeLeaf,
  resizeSplit,
} from './pane-tree.mjs';
```

- [ ] **Step 4: Run the focused suite and verify green**

Run:

```bash
pnpm vitest --run __tests__/tauriPaneTree.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the pure model after approval**

```bash
git add \
  __tests__/tauriPaneTree.test.ts \
  native/macos/psyche-build-tauri/web/panes/pane-entry.js \
  native/macos/psyche-build-tauri/web/panes/pane-tree.mjs
git diff --cached --check
git commit -m "feat(macos): add physical pane tree model"
```

## Task 2: Bundle and load the pane model

**Files:**

- Modify: `native/macos/psyche-build-tauri/package.json`
- Modify: `native/macos/psyche-build-tauri/web/index.html`
- Generate: `native/macos/psyche-build-tauri/web/panes.bundle.js`
- Modify: `__tests__/tauriWorkspacePanels.test.ts`

- [ ] **Step 1: Write the failing bundle/load-order contract**

In `__tests__/tauriWorkspacePanels.test.ts`, read `panes.bundle.js`, then replace
the build/load-order expectations with:

```ts
const panesBundle = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/panes.bundle.js'),
  'utf8',
);

it('builds and loads the physical-pane bundle before the application', () => {
  expect(tauriPackage.scripts['build:web']).toBe(
    'esbuild web/editor/editor-entry.js --bundle --minify --format=iife --global-name=PsycheCodeEditor --outfile=web/editor.bundle.js'
    + ' && esbuild web/sessions/session-entry.js --bundle --minify --format=iife --global-name=PsycheSessions --outfile=web/sessions.bundle.js'
    + ' && esbuild web/panes/pane-entry.js --bundle --minify --format=iife --global-name=PsychePanes --outfile=web/panes.bundle.js'
  );
  const sessionsScript = '<script src="./sessions.bundle.js" defer></script>';
  const panesScript = '<script src="./panes.bundle.js" defer></script>';
  const mainScript = '<script src="./main.js" defer></script>';
  expect(indexHtml.indexOf(sessionsScript)).toBeLessThan(indexHtml.indexOf(panesScript));
  expect(indexHtml.indexOf(panesScript)).toBeLessThan(indexHtml.indexOf(mainScript));
  expect(panesBundle).toContain('PsychePanes');
});
```

- [ ] **Step 2: Run the contract and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspacePanels.test.ts
```

Expected: FAIL because the build script, bundle, and script tag are absent.

- [ ] **Step 3: Add the bundle to the native build**

Set `scripts.build:web` in
`native/macos/psyche-build-tauri/package.json` to:

```json
"build:web": "esbuild web/editor/editor-entry.js --bundle --minify --format=iife --global-name=PsycheCodeEditor --outfile=web/editor.bundle.js && esbuild web/sessions/session-entry.js --bundle --minify --format=iife --global-name=PsycheSessions --outfile=web/sessions.bundle.js && esbuild web/panes/pane-entry.js --bundle --minify --format=iife --global-name=PsychePanes --outfile=web/panes.bundle.js"
```

Add this tag after `sessions.bundle.js` and before `main.js` in `index.html`:

```html
<script src="./panes.bundle.js" defer></script>
```

Generate the checked-in bundle:

```bash
pnpm --dir native/macos/psyche-build-tauri build:web
```

Expected: esbuild writes `web/panes.bundle.js` without errors.

- [ ] **Step 4: Run the bundle contract and verify green**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriPaneTree.test.ts \
  __tests__/tauriWorkspacePanels.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the bundle plumbing after approval**

```bash
git add \
  __tests__/tauriWorkspacePanels.test.ts \
  native/macos/psyche-build-tauri/package.json \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/panes.bundle.js
git diff --cached --check
git commit -m "build(macos): bundle physical pane model"
```

## Task 3: Integrate process-local pane layouts

**Files:**

- Create: `__tests__/tauriPhysicalPanes.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `native/macos/psyche-build-tauri/web/styles.css`
- Modify: `__tests__/tauriWorkspaceEditorIntegration.test.ts`

- [ ] **Step 1: Write failing physical-pane source contracts**

Create `__tests__/tauriPhysicalPanes.test.ts` with the repository's existing
`extractFunctionSource` helper and these assertions:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const mainJs = readFileSync(
  join(root, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);
const styles = readFileSync(
  join(root, 'native/macos/psyche-build-tauri/web/styles.css'),
  'utf8',
);

describe('native physical pane integration', () => {
  it('keeps pane topology process-local and out of workspace persistence', () => {
    expect(mainJs).toContain('var paneLayouts = new Map();');
    expect(mainJs).toContain('function paneLayoutKey(projectId, worktreePath)');
    expect(mainJs).toContain('function renderPaneWorkspace()');
    expect(mainJs).not.toMatch(/persistableProject[\s\S]{0,500}paneLayouts/);
    expect(mainJs).not.toMatch(/saveWorkspaceNow[\s\S]{0,500}paneLayouts/);
  });

  it('moves each mounted terminal into a pane leaf without a thread back-reference', () => {
    expect(mainJs).toContain('PsychePanes.createLeaf');
    expect(mainJs).toContain('PsychePanes.insertBelow');
    expect(mainJs).toContain('PsychePanes.removeLeaf');
    expect(mainJs).not.toContain('paneLeafId:');
    expect(mainJs).toMatch(/pane\.className = "terminal-pane"/);
    expect(mainJs).toMatch(/header\.className = "terminal-pane-header"/);
    expect(mainJs).toMatch(/body\.className = "terminal-pane-body"/);
  });

  it('renders simultaneous terminals and keeps the file tab strip file-only', () => {
    expect(styles).not.toMatch(/\.term-instance\.active\s*\{\s*visibility:\s*visible/);
    expect(styles).toMatch(/\.terminal-pane\.focused\s*\{/);
    expect(styles).toMatch(/\.terminal-pane-body\s*\{[^}]*min-height:\s*0/);
    expect(mainJs).toContain('function refreshTabs()');
    expect(mainJs).not.toMatch(/function refreshTabs\(\)[\s\S]*activeProjectThreads/);
    expect(mainJs).toContain('PsychePanes.layoutRects(');
    expect(mainJs).toContain('split.ratio');
  });

  it('checks candidate geometry before adding thread state', () => {
    const createStart = mainJs.indexOf('function createThread(');
    const createEnd = mainJs.indexOf('\n  function spawnPty(', createStart);
    const source = mainJs.slice(createStart, createEnd);
    expect(source.indexOf('preparePanePlacement')).toBeLessThan(source.indexOf('state.threads.push'));
    expect(source).toContain('PsychePanes.canFit');
  });
});
```

In `__tests__/tauriWorkspaceEditorIntegration.test.ts`, replace test stubs named
`fitActiveTerm` with `scheduleVisiblePaneFit`, matching the production rename.

- [ ] **Step 2: Run focused tests and verify the red state**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts
```

Expected: FAIL because pane layout state and physical DOM are not implemented.

- [ ] **Step 3: Add pane layout ownership and placement helpers**

In `main.js`, add:

```js
var paneLayouts = new Map();
var paneCounter = 0;
var PANE_MINIMUMS = { width: 320, height: 120, separator: 6 };

function nextPaneId(prefix) {
  paneCounter += 1;
  return prefix + "-" + Date.now().toString(36) + "-" + paneCounter;
}

function paneLayoutKey(projectId, worktreePath) {
  return String(projectId || "") + "\n" + String(worktreePath || "");
}

function paneLayoutFor(projectId, worktreePath) {
  return paneLayouts.get(paneLayoutKey(projectId, worktreePath)) || null;
}

function activePaneLayout() {
  var project = activeProject();
  var worktree = selectedWorktree(project);
  return project && worktree ? paneLayoutFor(project.id, worktree.path) : null;
}

function measuredTerminalHost() {
  var rect = terminalHost.getBoundingClientRect();
  return { x: 0, y: 0, width: rect.width, height: rect.height };
}

function preparePanePlacement(threadId, projectId, worktreePath) {
  var key = paneLayoutKey(projectId, worktreePath);
  var current = paneLayouts.get(key) || null;
  var leaf = PsychePanes.createLeaf(nextPaneId("leaf"), threadId);
  var candidate = current && current.root
    ? PsychePanes.insertBelow(
        current.root,
        current.focusedLeafId,
        leaf,
        nextPaneId("split")
      )
    : leaf;
  if (!PsychePanes.canFit(candidate, measuredTerminalHost(), PANE_MINIMUMS)) {
    return null;
  }
  return {
    key: key,
    value: { root: candidate, focusedLeafId: leaf.id },
  };
}

function commitPanePlacement(placement) {
  paneLayouts.set(placement.key, placement.value);
}
```

Change `createThread` so it resolves `project` and `worktreePath`, calls
`preparePanePlacement(id, project.id, worktreePath)`, and returns `null` after
`setStatus("Not enough space for another terminal pane", "warn")` when the
candidate is not feasible. Call `commitPanePlacement` before
`state.threads.push(thread)`. Resolve the grouping path with:

```js
var worktreePath = opts.worktreePath
  || opts.projectRoot
  || (project && activeWorkspaceRoot(project));
```

Do not add a pane id to the thread object.

- [ ] **Step 4: Mount persistent pane DOM and render the active tree**

Replace the top of `mountTerminal(thread)` with:

```js
var pane = document.createElement("section");
pane.className = "terminal-pane";
pane.dataset.threadId = thread.id;
var header = document.createElement("header");
header.className = "terminal-pane-header";
var title = document.createElement("span");
title.className = "terminal-pane-title";
title.textContent = thread.name;
var status = document.createElement("span");
status.className = "terminal-pane-status";
status.textContent = thread.status;
var close = document.createElement("button");
close.type = "button";
close.className = "terminal-pane-close";
close.textContent = "×";
close.title = "Stop and close terminal";
close.setAttribute("aria-label", "Stop and close " + thread.name);
close.addEventListener("click", function (event) {
  event.stopPropagation();
  closeThread(thread.id);
});
var body = document.createElement("div");
body.className = "terminal-pane-body";
var container = document.createElement("div");
container.className = "term-instance";
container.dataset.threadId = thread.id;
body.appendChild(container);
pane.addEventListener("pointerdown", function () {
  if (state.activeThreadId !== thread.id) focusThread(thread.id);
});
header.appendChild(title);
header.appendChild(status);
header.appendChild(close);
pane.appendChild(header);
pane.appendChild(body);
thread.pane = pane;
thread.host = container;
renderPaneWorkspace();
```

Keep the existing xterm construction after that block, but remove the old
`terminalHost.appendChild(container)` and final `thread.host = container`.

Add these render helpers:

```js
function renderPaneNode(node, projectedRatios) {
  if (node.type === "leaf") {
    var thread = findThread(node.threadId);
    return thread && thread.pane ? thread.pane : document.createDocumentFragment();
  }
  var ratio = projectedRatios.get(node.id) ?? node.ratio;
  var split = document.createElement("div");
  split.className = "terminal-pane-split";
  split.dataset.splitId = node.id;
  var first = document.createElement("div");
  first.className = "terminal-pane-branch";
  first.style.flexBasis = (ratio * 100) + "%";
  first.appendChild(renderPaneNode(node.first, projectedRatios));
  var divider = createPaneDivider(node, ratio);
  var second = document.createElement("div");
  second.className = "terminal-pane-branch";
  second.appendChild(renderPaneNode(node.second, projectedRatios));
  split.appendChild(first);
  split.appendChild(divider);
  split.appendChild(second);
  return split;
}

function renderPaneWorkspace() {
  terminalHost.replaceChildren();
  var layout = activePaneLayout();
  if (!layout || !layout.root) {
    renderTerminalEmptyState();
    return;
  }
  var projection = PsychePanes.layoutRects(
    layout.root,
    measuredTerminalHost(),
    PANE_MINIMUMS
  );
  var projectedRatios = new Map(projection.splits.map(function (split) {
    return [split.splitId, split.ratio];
  }));
  terminalHost.appendChild(renderPaneNode(layout.root, projectedRatios));
  state.threads.forEach(function (thread) {
    if (!thread.pane) return;
    thread.pane.classList.toggle("focused", state.activeThreadId === thread.id);
  });
  scheduleVisiblePaneFit();
}
```

Update project/worktree switch, hide, reopen, close, and focus call sites to
mutate only the matching layout and then call `renderPaneWorkspace`. Add one
leaf-detachment helper used by hide and close:

```js
function detachThreadPane(thread) {
  var key = paneLayoutKey(thread.projectId, thread.worktreePath);
  var layout = paneLayouts.get(key);
  var leaf = layout && PsychePanes.findLeafByThreadId(layout.root, thread.id);
  if (!layout || !leaf) return null;
  var removed = PsychePanes.removeLeaf(layout.root, leaf.id);
  var nextLeaf = removed.root && removed.nextLeafId
    ? PsychePanes.findLeafById(removed.root, removed.nextLeafId)
    : null;
  if (removed.root) {
    paneLayouts.set(key, {
      root: removed.root,
      focusedLeafId: removed.nextLeafId,
    });
  } else {
    paneLayouts.delete(key);
  }
  return nextLeaf ? nextLeaf.threadId : null;
}
```

In `focusThread`, replace active-only DOM class toggling with:

```js
var layout = paneLayoutFor(thread.projectId, thread.worktreePath);
var leaf = layout && PsychePanes.findLeafByThreadId(layout.root, thread.id);
if (layout && leaf) {
  paneLayouts.set(paneLayoutKey(thread.projectId, thread.worktreePath), {
    root: layout.root,
    focusedLeafId: leaf.id,
  });
}
renderPaneWorkspace();
```

Call `detachThreadPane(thread)` before changing hidden/thread state. Focus its
returned thread id only when it belongs to the same project/worktree. A `null`
return renders the empty state. Replace `hideThread` with:

```js
function hideThread(id) {
  var thread = findThread(id);
  if (!thread || thread.hidden) return false;
  var nextThreadId = detachThreadPane(thread);
  thread.hidden = true;
  if (state.activeThreadId === id) {
    state.activeThreadId = null;
    if (nextThreadId) focusThread(nextThreadId);
  }
  renderPaneWorkspace();
  refreshSidebar();
  refreshTabs();
  return true;
}
```

On hide, retain the thread and PTY. On close, remove the thread after removing
the leaf. On reopen, call `preparePanePlacement` with the existing thread id.
Add the single-thread helper used later by native attachment:

```js
function reopenThread(id) {
  var thread = findThread(id);
  if (!thread || !thread.hidden) return thread || null;
  var placement = preparePanePlacement(thread.id, thread.projectId, thread.worktreePath);
  if (!placement) {
    setStatus("Not enough space to reopen this terminal pane", "warn");
    return null;
  }
  thread.hidden = false;
  commitPanePlacement(placement);
  state.activeThreadId = thread.id;
  renderPaneWorkspace();
  refreshSidebar();
  return thread;
}
```

Keep the existing group-level `reopenThreads(projectId, worktreePath)`, but
implement it by calling `reopenThread` for each hidden thread until the layout
minimum prevents another insertion.

- [ ] **Step 5: Add physical-pane styles**

Replace the active-only `.term-instance` rules with:

```css
.terminal-host {
  position: relative;
  background: transparent;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 8px 12px 4px;
}
.terminal-pane-split,
.terminal-pane-branch {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.terminal-pane-branch { flex: 1 1 0; }
.terminal-pane {
  display: grid;
  grid-template-rows: 24px minmax(0, 1fr);
  min-width: 320px;
  min-height: 120px;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 7px;
}
.terminal-pane.focused {
  border-color: var(--accent-line);
  box-shadow: inset 0 0 0 1px var(--accent-soft);
}
.terminal-pane-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 11px;
}
.terminal-pane-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.terminal-pane-status {
  flex: 0 0 auto;
  color: var(--muted);
}
.terminal-pane-retry,
.terminal-pane-close {
  border: 0;
  background: transparent;
  color: inherit;
}
.terminal-pane-body,
.term-instance {
  position: relative;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
}
.terminal-pane-divider {
  flex: 0 0 6px;
  cursor: row-resize;
  background: var(--border);
}
.terminal-pane-divider:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriPaneTree.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriDesktopTabs.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit pane integration after approval**

```bash
git add \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css
git diff --cached --check
git commit -m "feat(macos): render native PTYs as physical panes"
```

## Task 4: Add accessible dividers and visible-pane fitting

**Files:**

- Modify: `__tests__/tauriPhysicalPanes.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js`

- [ ] **Step 1: Add failing divider and resize-scheduler tests**

Append:

```ts
it('uses accessible horizontal separators with pointer and keyboard resize', () => {
  expect(mainJs).toMatch(/function createPaneDivider\(node,\s*effectiveRatio\)/);
  expect(mainJs).toContain('divider.setAttribute("role", "separator")');
  expect(mainJs).toContain('divider.setAttribute("aria-orientation", "horizontal")');
  expect(mainJs).toContain('divider.setAttribute("aria-valuemin", "0")');
  expect(mainJs).toContain('divider.setAttribute("aria-valuemax", "100")');
  expect(mainJs).toContain('divider.addEventListener("pointerdown"');
  expect(mainJs).toContain('divider.addEventListener("keydown"');
  expect(mainJs).toContain('PsychePanes.resizeSplit');
});

it('coalesces one fit per visible leaf per animation frame', () => {
  expect(mainJs).toContain('var visiblePaneFitFrame = 0;');
  expect(mainJs).toContain('function scheduleVisiblePaneFit()');
  expect(mainJs).toContain('function fitVisiblePanes()');
  expect(mainJs).not.toContain('function fitActiveTerm()');
  expect(mainJs).toMatch(/window\.addEventListener\("resize",[\s\S]*scheduleVisiblePaneFit/);
});
```

- [ ] **Step 2: Verify the new assertions fail**

Run:

```bash
pnpm vitest --run __tests__/tauriPhysicalPanes.test.ts
```

Expected: FAIL on missing divider behavior and `fitActiveTerm`.

- [ ] **Step 3: Implement divider interaction**

Add:

```js
function updateActiveSplit(splitId, ratio) {
  var project = activeProject();
  var worktree = selectedWorktree(project);
  var key = paneLayoutKey(project && project.id, worktree && worktree.path);
  var layout = paneLayouts.get(key);
  if (!layout) return;
  var root = PsychePanes.resizeSplit(layout.root, splitId, ratio);
  paneLayouts.set(key, { root: root, focusedLeafId: layout.focusedLeafId });
  renderPaneWorkspace();
}

function createPaneDivider(node, effectiveRatio) {
  var divider = document.createElement("div");
  divider.className = "terminal-pane-divider";
  divider.dataset.splitId = node.id;
  divider.tabIndex = 0;
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "horizontal");
  divider.setAttribute("aria-valuemin", "0");
  divider.setAttribute("aria-valuemax", "100");
  divider.setAttribute("aria-valuenow", String(Math.round(effectiveRatio * 100)));

  divider.addEventListener("pointerdown", function (event) {
    event.preventDefault();
    var split = divider.parentNode;
    var rect = split.getBoundingClientRect();
    function move(nextEvent) {
      updateActiveSplit(node.id, (nextEvent.clientY - rect.top) / rect.height);
    }
    function stop() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  });

  divider.addEventListener("keydown", function (event) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    var step = event.shiftKey ? 0.01 : 0.04;
    updateActiveSplit(
      node.id,
      effectiveRatio + (event.key === "ArrowDown" ? step : -step)
    );
    event.preventDefault();
  });
  return divider;
}
```

- [ ] **Step 4: Replace active-only fitting**

Replace `fitActiveTerm` with:

```js
var visiblePaneFitFrame = 0;

function fitVisiblePanes() {
  visiblePaneFitFrame = 0;
  var layout = activePaneLayout();
  if (!layout || !layout.root || terminalHost.hidden) return;
  var visibleIds = new Set(PsychePanes.leafIds(layout.root));
  state.threads.forEach(function (thread) {
    var leaf = PsychePanes.findLeafByThreadId(layout.root, thread.id);
    if (!leaf || !visibleIds.has(leaf.id) || !thread.fit) return;
    try {
      thread.fit.fit();
    } catch (error) {
      console.warn("[panes] xterm fit failed", thread.id, error);
    }
  });
}

function scheduleVisiblePaneFit() {
  if (visiblePaneFitFrame) return;
  visiblePaneFitFrame = requestAnimationFrame(fitVisiblePanes);
}
```

Replace every `fitActiveTerm()` call in `main.js` with
`scheduleVisiblePaneFit()`. Preserve `syncBrowserBounds()` calls.

- [ ] **Step 5: Run PR 1 validation**

Run:

```bash
pnpm --dir native/macos/psyche-build-tauri build:web
pnpm vitest --run \
  __tests__/tauriPaneTree.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriDesktopTabs.test.ts
pnpm typecheck
```

Expected: all commands PASS.

- [ ] **Step 6: Commit divider/fit behavior after approval**

```bash
git add \
  __tests__/tauriPhysicalPanes.test.ts \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/panes.bundle.js
git diff --cached --check
git commit -m "feat(macos): resize visible terminal panes"
```

## Task 5: Close PR 1 with regression and packaged checks

- [ ] **Step 1: Run the complete repository gate**

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm smoke
pnpm smoke:pack
```

Expected: no new failures. Record any known pre-existing platform failures
separately; do not weaken tests to hide them.

- [ ] **Step 2: Run the native Rust and package gate**

```bash
cd native/macos/psyche-build-tauri/src-tauri
cargo fmt --check
cargo test --locked
cargo check --locked
cd ..
pnpm build:web
pnpm build
```

Expected: PASS and an unsigned `.app` artifact under `src-tauri/target/release/bundle/macos/`.

- [ ] **Step 3: Inspect the packaged pane foundation**

Launch the packaged app and verify:

1. two existing shell/Psyche threads render simultaneously;
2. clicking either terminal routes input and command-bar text only to that PTY;
3. dragging and keyboard-adjusting the divider resizes both PTYs;
4. project/worktree switches restore their in-process pane trees;
5. hiding and reopening moves the same live PTY without restarting it;
6. closing one pane stops only that PTY and collapses its split; and
7. file tabs remain file-only.

- [ ] **Step 4: Prepare the PR after approval**

```bash
git status --short
git log --oneline origin/main..HEAD
git diff --check origin/main...HEAD
```

Expected: only PR 1 files are changed. Do not open or merge the PR without
explicit approval.

---

# PR 2 — Default Coven launch

After PR 1 is merged, create a fresh worktree from the updated main:

```bash
git fetch origin
git worktree add -b feat/native-coven-launch .worktrees/native-coven-launch origin/main
cd .worktrees/native-coven-launch
```

## Task 6: Separate project scope from PTY cwd

**Files:**

- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`
- Create: `__tests__/tauriCovenLaunch.test.ts`

- [ ] **Step 1: Add failing Rust tests for contained and linked worktrees**

In `workspace_panel_tests`, add:

```rust
#[test]
fn resolves_pty_cwd_inside_project_or_verified_linked_worktree() {
    let tree = TempTree::new("pty-cwd");
    let project = tree.root.join("project");
    let nested = project.join("src");
    let linked = tree.root.join("linked");
    let linked_nested = linked.join("app");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::create_dir_all(&linked_nested).unwrap();

    assert_eq!(
        resolve_pty_cwd_with_worktrees(
            path_text(&project),
            path_text(&nested),
            &[linked.clone()],
        )
        .unwrap(),
        nested.canonicalize().unwrap(),
    );
    assert_eq!(
        resolve_pty_cwd_with_worktrees(
            path_text(&project),
            path_text(&linked_nested),
            &[linked.clone()],
        )
        .unwrap(),
        linked_nested.canonicalize().unwrap(),
    );
}

#[test]
fn rejects_unrelated_sibling_and_missing_pty_cwd() {
    let tree = TempTree::new("pty-cwd-outside");
    let project = tree.root.join("project");
    let sibling = tree.root.join("project-copy");
    let file = project.join("not-a-directory");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&sibling).unwrap();
    std::fs::write(&file, "content").unwrap();

    assert!(resolve_pty_cwd_with_worktrees(
        path_text(&project),
        path_text(&sibling),
        &[],
    )
    .is_err());
    assert!(resolve_pty_cwd_with_worktrees(
        path_text(&project),
        path_text(&tree.root.join("missing")),
        &[],
    )
    .is_err());
    assert!(resolve_pty_cwd_with_worktrees(
        path_text(&project),
        path_text(&file),
        &[],
    )
    .is_err());
}

#[cfg(unix)]
#[test]
fn rejects_pty_cwd_symlink_escape() {
    use std::os::unix::fs::symlink;
    let tree = TempTree::new("pty-cwd-symlink");
    let project = tree.root.join("project");
    let outside = tree.root.join("outside");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let link = project.join("escape");
    symlink(&outside, &link).unwrap();

    assert!(resolve_pty_cwd_with_worktrees(
        path_text(&project),
        path_text(&link),
        &[],
    )
    .is_err());
}
```

- [ ] **Step 2: Verify the Rust tests fail**

Run:

```bash
cd native/macos/psyche-build-tauri/src-tauri
cargo test --locked workspace_panel_tests::resolves_pty_cwd_inside_project_or_verified_linked_worktree
```

Expected: FAIL because `resolve_pty_cwd_with_worktrees` does not exist.

- [ ] **Step 3: Add explicit scope/cwd fields and validators**

Extend `StartOptions`:

```rust
pub project_root: Option<String>,
pub cwd: Option<String>,
pub launch_kind: Option<String>,
pub coven_session_id: Option<String>,
```

Add:

```rust
fn resolve_pty_cwd_with_worktrees(
    project_root: &str,
    cwd: &str,
    linked_worktrees: &[PathBuf],
) -> Result<PathBuf, String> {
    let root = canonical_project_root(project_root)?;
    let candidate = Path::new(cwd)
        .canonicalize()
        .map_err(|error| format!("pty cwd '{}': {}", cwd, error))?;
    if !candidate.is_dir() {
        return Err(format!("pty cwd is not a directory: {}", cwd));
    }
    if candidate.starts_with(&root) {
        return Ok(candidate);
    }
    for linked in linked_worktrees {
        let linked = linked
            .canonicalize()
            .map_err(|error| format!("linked worktree '{}': {}", linked.display(), error))?;
        if candidate.starts_with(&linked) {
            return Ok(candidate);
        }
    }
    Err(format!("pty cwd is outside project scope: {}", cwd))
}

fn linked_worktree_roots(project_root: &Path) -> Result<Vec<PathBuf>, String> {
    let root = project_root.to_string_lossy().to_string();
    let raw = run_git(&root, &["worktree", "list", "--porcelain"])?;
    Ok(parse_git_worktrees(&raw)
        .into_iter()
        .filter(|worktree| !worktree.bare && !worktree.prunable && !worktree.missing)
        .filter_map(|worktree| Path::new(&worktree.path).canonicalize().ok())
        .collect())
}

fn resolve_pty_cwd(project_root: &str, cwd: &str) -> Result<PathBuf, String> {
    let root = canonical_project_root(project_root)?;
    let candidate = Path::new(cwd)
        .canonicalize()
        .map_err(|error| format!("pty cwd '{}': {}", cwd, error))?;
    if !candidate.is_dir() {
        return Err(format!("pty cwd is not a directory: {}", cwd));
    }
    if candidate.starts_with(&root) {
        return Ok(candidate);
    }
    let linked = linked_worktree_roots(&root)?;
    resolve_pty_cwd_with_worktrees(project_root, cwd, &linked)
}
```

In `pty_start`, require both values and replace `cmd.cwd(root)` with:

```rust
let project_root = options
    .project_root
    .as_deref()
    .ok_or_else(|| "projectRoot is required".to_string())?;
let cwd = options.cwd.as_deref().unwrap_or(project_root);
let resolved_cwd = resolve_pty_cwd(project_root, cwd)?;
cmd.cwd(&resolved_cwd);
```

Do not accept arbitrary external cwd when Git discovery fails.

- [ ] **Step 4: Run Rust tests**

```bash
cd native/macos/psyche-build-tauri/src-tauri
cargo fmt --check
cargo test --locked workspace_panel_tests::resolves_pty_cwd_inside_project_or_verified_linked_worktree
cargo test --locked workspace_panel_tests::rejects_unrelated_sibling_and_missing_pty_cwd
cargo test --locked workspace_panel_tests::rejects_pty_cwd_symlink_escape
```

Expected: PASS.

- [ ] **Step 5: Commit PTY scope validation after approval**

```bash
git add native/macos/psyche-build-tauri/src-tauri/src/lib.rs
git diff --cached --check
git commit -m "feat(macos): validate PTY project scope and cwd"
```

## Task 7: Resolve and validate the Coven executable

**Files:**

- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs`
- Modify: `__tests__/tauriCovenLaunch.test.ts`
- Modify: `__tests__/tauriDesktopTabs.test.ts`

- [ ] **Step 1: Write failing executable and attach-contract tests**

Create `__tests__/tauriCovenLaunch.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const mainJs = readFileSync(
  join(root, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);
const nativeLib = readFileSync(
  join(root, 'native/macos/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8',
);

describe('native Coven launch contract', () => {
  it('exposes an executable absolute Coven path', () => {
    expect(nativeLib).toMatch(/pub\s+coven_path:\s*Option<String>/);
    expect(nativeLib).toMatch(/let\s+coven_path\s*=\s*which_on_path\("coven"\)/);
    expect(nativeLib).toMatch(/fn\s+is_executable_file\(/);
    expect(nativeLib).toMatch(/fn\s+which_on_path_with\(/);
  });

  it('validates exact Coven launch shapes at the Rust boundary', () => {
    expect(nativeLib).toMatch(/fn\s+validate_coven_launch\(/);
    expect(nativeLib).toContain('"coven-chat"');
    expect(nativeLib).toContain('"coven-attach"');
    expect(nativeLib).toContain('is_safe_coven_session_id');
  });

  it('creates chat launch descriptors with no tmux environment', () => {
    expect(mainJs).toMatch(/function\s+covenChatLaunch\(project,\s*worktree\)/);
    expect(mainJs).toContain('command: state.env.coven_path');
    expect(mainJs).toContain('args: ["chat"]');
    expect(mainJs).toContain('launchKind: "coven-chat"');
    expect(mainJs).not.toMatch(/function\s+covenChatLaunch[\s\S]*TMUX_TMPDIR/);
  });
});
```

Add to `tauriDesktopTabs.test.ts`:

```ts
expect(mainJs).toMatch(
  /if\s*\(\s*activeSurface\s*===\s*"browser"\s*\)\s*openBlankBrowserTab\(\);\s*else\s*spawnCovenThread\(\);/
);
```

- [ ] **Step 2: Verify the contracts fail**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriDesktopTabs.test.ts
```

Expected: FAIL because Coven launch resolution is not present.

- [ ] **Step 3: Harden executable lookup and expose `coven_path`**

Add:

```rust
#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn which_on_path_with(binary: &str, path: &str) -> Option<String> {
    std::env::split_paths(path)
        .map(|directory| directory.join(binary))
        .find(|candidate| is_executable_file(candidate))
        .and_then(|candidate| candidate.canonicalize().ok())
        .map(|candidate| candidate.to_string_lossy().to_string())
}

fn which_on_path(binary: &str) -> Option<String> {
    which_on_path_with(binary, augmented_path())
}
```

Extend `AppEnvironment` with `pub coven_path: Option<String>`, resolve it using
`which_on_path("coven")`, and include it in the returned struct.

Add this Unix unit test using `TempTree`:

```rust
#[cfg(unix)]
#[test]
fn resolves_only_executable_canonical_files_from_path() {
    use std::os::unix::fs::PermissionsExt;

    let tree = TempTree::new("coven-path");
    let bin = tree.root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let coven = bin.join("coven");
    let inert = bin.join("inert");
    std::fs::write(&coven, "#!/bin/sh\n").unwrap();
    std::fs::write(&inert, "not executable").unwrap();
    std::fs::set_permissions(&coven, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::set_permissions(&inert, std::fs::Permissions::from_mode(0o644)).unwrap();

    assert_eq!(
        which_on_path_with("coven", path_text(&bin)),
        Some(coven.canonicalize().unwrap().to_string_lossy().into_owned()),
    );
    assert_eq!(which_on_path_with("inert", path_text(&bin)), None);
}
```

- [ ] **Step 4: Validate Coven launch shape in Rust**

Import the shared Rust validator:

```rust
use coven_sessions::{coven_sessions, is_safe_session_id as is_safe_coven_session_id};
```

Change `is_safe_session_id` in `coven_sessions.rs` to `pub(crate)`.

Add a testable validator plus the runtime wrapper:

```rust
fn validate_coven_launch_with(
    options: &StartOptions,
    resolved_coven: Option<&str>,
) -> Result<(), String> {
    match options.launch_kind.as_deref() {
        Some("coven-chat") => {
            if options.args.as_deref() != Some(&["chat".to_string()]) {
                return Err("coven chat launch arguments are invalid".to_string());
            }
            if options.coven_session_id.is_some() {
                return Err("coven chat must not include a session id".to_string());
            }
        }
        Some("coven-attach") => {
            let session_id = options
                .coven_session_id
                .as_deref()
                .ok_or_else(|| "coven attach requires a session id".to_string())?;
            if !is_safe_coven_session_id(session_id) {
                return Err("coven session id contains unsupported characters".to_string());
            }
            if options.args.as_deref()
                != Some(&["attach".to_string(), session_id.to_string()])
            {
                return Err("coven attach launch arguments are invalid".to_string());
            }
        }
        Some(other) => return Err(format!("unsupported PTY launch kind: {}", other)),
        None => return Ok(()),
    }

    let resolved = resolved_coven
        .ok_or_else(|| "Coven CLI not found on the augmented PATH".to_string())?;
    if options.command.as_deref() != Some(resolved) {
        return Err("Coven launch command does not match the resolved executable".to_string());
    }
    Ok(())
}

fn validate_coven_launch(options: &StartOptions) -> Result<(), String> {
    let resolved = which_on_path("coven");
    validate_coven_launch_with(options, resolved.as_deref())
}
```

Call `validate_coven_launch(&options)?` before opening the PTY. Add:

```rust
fn coven_start_options(
    command: &str,
    args: &[&str],
    launch_kind: &str,
    session_id: Option<&str>,
) -> StartOptions {
    StartOptions {
        thread_id: "test-thread".to_string(),
        project_root: Some("/project".to_string()),
        cwd: Some("/project".to_string()),
        command: Some(command.to_string()),
        args: Some(args.iter().map(|arg| (*arg).to_string()).collect()),
        launch_kind: Some(launch_kind.to_string()),
        coven_session_id: session_id.map(str::to_string),
        cols: None,
        rows: None,
        env: None,
    }
}

#[test]
fn validates_exact_coven_chat_and_attach_shapes() {
    let chat = coven_start_options("/opt/coven", &["chat"], "coven-chat", None);
    let attach = coven_start_options(
        "/opt/coven",
        &["attach", "session-1"],
        "coven-attach",
        Some("session-1"),
    );
    assert!(validate_coven_launch_with(&chat, Some("/opt/coven")).is_ok());
    assert!(validate_coven_launch_with(&attach, Some("/opt/coven")).is_ok());
}

#[test]
fn rejects_unsafe_or_mismatched_coven_launches() {
    let unsafe_id = coven_start_options(
        "/opt/coven",
        &["attach", "../escape"],
        "coven-attach",
        Some("../escape"),
    );
    let wrong_args = coven_start_options("/opt/coven", &["sessions"], "coven-chat", None);
    let wrong_binary = coven_start_options("/tmp/coven", &["chat"], "coven-chat", None);
    assert!(validate_coven_launch_with(&unsafe_id, Some("/opt/coven")).is_err());
    assert!(validate_coven_launch_with(&wrong_args, Some("/opt/coven")).is_err());
    assert!(validate_coven_launch_with(&wrong_binary, Some("/opt/coven")).is_err());
}
```

- [ ] **Step 5: Run focused Rust and TypeScript tests**

```bash
cd native/macos/psyche-build-tauri/src-tauri
cargo fmt --check
cargo test --locked workspace_panel_tests
cd ../../../..
pnpm vitest --run \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriCovenSessionNativeContract.test.ts \
  __tests__/tauriDesktopTabs.test.ts
```

Expected: Rust tests PASS; the web launch test remains red until Task 8.

- [ ] **Step 6: Commit native Coven validation after approval**

```bash
git add \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriCovenSessionNativeContract.test.ts \
  native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs \
  native/macos/psyche-build-tauri/src-tauri/src/lib.rs
git diff --cached --check
git commit -m "feat(macos): validate native Coven launches"
```

## Task 8: Make `coven chat` the default native session

**Files:**

- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `native/macos/psyche-build-tauri/web/index.html`
- Modify: `__tests__/tauriCovenLaunch.test.ts`
- Modify: `__tests__/tauriDesktopTabs.test.ts`

- [ ] **Step 1: Add failing launch-routing assertions**

Append:

```ts
it('routes every default terminal action to one Coven chat launcher', () => {
  expect(mainJs).toMatch(/function\s+ensureProjectCoven\(project\)/);
  expect(mainJs).toMatch(/function\s+spawnCovenThread\(\)/);
  expect(mainJs).not.toContain('ensureProjectPsyche(');
  expect(mainJs).toMatch(/cmd:\s*"\/new-thread"[\s\S]*spawnCovenThread\(\)/);
  expect(mainJs).toMatch(/cmd:\s*"\/new-shell"[\s\S]*spawnShellThread\(\)/);
  expect(mainJs).toMatch(/cmd:\s*"\/new-psyche"[\s\S]*spawnPsycheThread\(\)/);
  expect(mainJs).toMatch(/thread\.kind\s*===\s*"coven-chat"/);
  expect(mainJs).toContain('cwd: opts.cwd || worktreePath');
});

it('does not mutate pane state when Coven is unavailable', () => {
  const start = mainJs.indexOf('function spawnCovenThread(');
  const end = mainJs.indexOf('\n  function ', start + 1);
  const source = mainJs.slice(start, end);
  expect(source.indexOf('state.env.coven_path')).toBeLessThan(source.indexOf('createThread('));
  expect(source).toContain('setStatus("Coven CLI not found');
});
```

- [ ] **Step 2: Run tests and verify the red state**

```bash
pnpm vitest --run \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriDesktopTabs.test.ts
```

Expected: FAIL because shell/Psyche remains the default.

- [ ] **Step 3: Add a reusable launch descriptor**

Change thread state to retain one descriptor:

```js
launch: {
  command: opts.command,
  args: Array.isArray(opts.args) ? opts.args.slice() : [],
  env: Object.assign({}, opts.env || {}),
  projectRoot: opts.projectRoot || (project && project.root),
  cwd: opts.cwd || worktreePath,
  launchKind: opts.launchKind || null,
  covenSessionId: opts.covenSessionId || null,
},
```

Change `spawnPty` to read only `thread.launch` and send:

```js
options: {
  threadId: thread.id,
  thread_id: thread.id,
  projectRoot: thread.launch.projectRoot,
  project_root: thread.launch.projectRoot,
  cwd: thread.launch.cwd,
  command: thread.launch.command,
  args: thread.launch.args,
  launchKind: thread.launch.launchKind,
  launch_kind: thread.launch.launchKind,
  covenSessionId: thread.launch.covenSessionId,
  coven_session_id: thread.launch.covenSessionId,
  cols: thread.term ? thread.term.cols : 120,
  rows: thread.term ? thread.term.rows : 40,
  env: thread.launch.env,
}
```

- [ ] **Step 4: Implement default Coven and explicit shell launchers**

Add:

```js
function covenChatLaunch(project, worktree) {
  if (!state.env || !state.env.coven_path) return null;
  return {
    project: project,
    name: "Coven",
    kind: "coven-chat",
    command: state.env.coven_path,
    args: ["chat"],
    projectRoot: project.root,
    cwd: worktree.path,
    worktreePath: worktree.path,
    launchKind: "coven-chat",
  };
}

function spawnCovenThread(project) {
  project = project || activeProject();
  if (!project || !state.env || !state.env.coven_path) {
    setStatus("Coven CLI not found — install @opencoven/cli and restart Psyche", "error");
    return null;
  }
  var worktree = selectedWorktree(project);
  return createThread(covenChatLaunch(project, worktree));
}

function ensureProjectCoven(project) {
  if (!project) return null;
  var worktree = selectedWorktree(project);
  var existing = state.threads.find(function (thread) {
    return thread.projectId === project.id
      && thread.worktreePath === worktree.path
      && thread.kind === "coven-chat"
      && !thread.hidden
      && thread.status !== "exited";
  });
  if (existing) {
    focusThread(existing.id);
    return existing;
  }
  return spawnCovenThread(project);
}

function spawnShellThread() {
  var project = activeProject();
  var worktree = selectedWorktree(project);
  return createThread({
    project: project,
    name: "shell " + (state.threads.length + 1),
    kind: "shell",
    command: state.env && state.env.default_shell ? state.env.default_shell : "/bin/zsh",
    args: ["-l"],
    projectRoot: project.root,
    cwd: worktree.path,
    worktreePath: worktree.path,
  });
}
```

Replace `ensureProjectPsyche` call sites with `ensureProjectCoven`. Replace
`spawnDefaultThread` with `spawnCovenThread`. Keep `spawnPsycheThread`
unchanged except that it passes `projectRoot: project.root`,
`cwd: worktree.path`, and `worktreePath: worktree.path` as distinct values.

Change the command entries:

```js
{
  cmd: "/new-thread",
  desc: "Spawn a new Coven session",
  run: function () { spawnCovenThread(); },
},
{
  cmd: "/new-shell",
  desc: "Spawn a plain login shell",
  run: function () { spawnShellThread(); },
},
```

Change terminal-side `createContextualTab` to `spawnCovenThread()`. Update the
command-input hint text to mention `/new-thread`, `/new-shell`, and
`/new-psyche`.

- [ ] **Step 5: Run focused launch tests**

```bash
pnpm vitest --run \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriDesktopTabs.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit default launch after approval**

```bash
git add \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriDesktopTabs.test.ts \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/main.js
git diff --cached --check
git commit -m "feat(macos): launch Coven by default"
```

## Task 9: Make PTY retry and close transitions idempotent

**Files:**

- Modify: `__tests__/tauriCovenLaunch.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js`

- [ ] **Step 1: Add failing lifecycle assertions**

Append:

```ts
it('guards PTY start, retry, and close transitions', () => {
  expect(mainJs).toContain('startInFlight: false');
  expect(mainJs).toContain('closeStarted: false');
  expect(mainJs).toMatch(/function\s+retryThread\(id\)/);
  expect(mainJs).toMatch(/if\s*\(\s*thread\.startInFlight\s*\)\s*return/);
  expect(mainJs).toMatch(/if\s*\(\s*thread\.closeStarted\s*\)\s*return/);
  expect(mainJs).toMatch(/thread\.status\s*!==\s*"exited"\s*&&\s*thread\.status\s*!==\s*"failed"/);
});

it('retains failed and exited leaves for retry or close', () => {
  expect(mainJs).toContain('thread.status = "failed"');
  expect(mainJs).toContain('thread.status = "exited"');
  expect(mainJs).toMatch(/Retry[\s\S]*retryThread/);
  expect(mainJs).not.toMatch(/pty:exit[\s\S]{0,500}closeThread/);
});
```

- [ ] **Step 2: Verify the lifecycle assertions fail**

```bash
pnpm vitest --run __tests__/tauriCovenLaunch.test.ts
```

Expected: FAIL on missing transition guards.

- [ ] **Step 3: Add state guards and retry**

Initialize:

```js
startInFlight: false,
closeStarted: false,
status: "starting",
```

Wrap `spawnPty`:

```js
function spawnPty(thread) {
  if (!thread || thread.startInFlight || thread.closeStarted) return;
  thread.startInFlight = true;
  thread.status = "starting";
  refreshSidebar();
  updatePaneChrome(thread);
  invoke("pty_start", { options: ptyStartOptions(thread) }).then(function () {
    thread.startInFlight = false;
    thread.status = "running";
    var pending = pendingDataBuffers.get(thread.id);
    if (pending && thread.term) {
      pending.forEach(function (bytes) { thread.term.write(bytes); });
      pendingDataBuffers.delete(thread.id);
    }
    refreshSidebar();
    updatePaneChrome(thread);
    if (state.activeThreadId === thread.id) {
      setProjectStatus(findProject(thread.projectId), "ok");
    }
  }).catch(function (error) {
    thread.startInFlight = false;
    thread.status = "failed";
    if (thread.term) {
      thread.term.write("\r\n\x1b[31m[pty_start error]\x1b[0m " + String(error) + "\r\n");
    }
    refreshSidebar();
    updatePaneChrome(thread);
  });
}

function retryThread(id) {
  var thread = findThread(id);
  if (!thread || thread.startInFlight || thread.closeStarted) return false;
  if (thread.status !== "exited" && thread.status !== "failed") return false;
  spawnPty(thread);
  return true;
}
```

Change `closeThread` to set `closeStarted` before removing layout/state and
calling `pty_stop`; repeated calls return immediately. Clear any buffered data
for the id. Keep the pane on `pty:exit`, set `startInFlight = false`, and update
its header. Replace `closeThread` with this complete guarded
detach/collapse/dispose body:

```js
function closeThread(id, options) {
  var thread = findThread(id);
  if (!thread || thread.closeStarted) return false;
  thread.closeStarted = true;
  pendingDataBuffers.delete(id);
  var nextThreadId = detachThreadPane(thread);
  invoke("pty_stop", { threadId: id, thread_id: id }).catch(function (error) {
    console.warn("[panes] PTY stop failed", id, error);
  });

  if (thread.term && thread.term.dispose) {
    try {
      thread.term.dispose();
    } catch (error) {
      console.warn("[panes] xterm dispose failed", id, error);
    }
  }
  state.threads = state.threads.filter(function (candidate) {
    return candidate.id !== id;
  });
  if (state.activeThreadId === id) {
    state.activeThreadId = null;
    if (nextThreadId && (!options || options.focus !== false)) {
      focusThread(nextThreadId);
    }
  }
  renderPaneWorkspace();
  refreshSidebar();
  refreshTabs();
  return true;
}
```

Implement `updatePaneChrome(thread)` so the header title/status is updated and
Retry is present only for `failed`/`exited`:

```js
function updatePaneChrome(thread) {
  if (!thread || !thread.pane) return;
  var title = thread.pane.querySelector(".terminal-pane-title");
  var status = thread.pane.querySelector(".terminal-pane-status");
  var retry = thread.pane.querySelector(".terminal-pane-retry");
  if (title) title.textContent = thread.name;
  if (status) status.textContent = thread.status;
  var retryable = thread.status === "failed" || thread.status === "exited";
  if (retryable && !retry) {
    retry = document.createElement("button");
    retry.type = "button";
    retry.className = "terminal-pane-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", function (event) {
      event.stopPropagation();
      retryThread(thread.id);
    });
    thread.pane.querySelector(".terminal-pane-header").insertBefore(
      retry,
      thread.pane.querySelector(".terminal-pane-close")
    );
  }
  if (retry) retry.hidden = !retryable;
}
```

- [ ] **Step 4: Run PR 2 validation**

```bash
pnpm --dir native/macos/psyche-build-tauri build:web
pnpm vitest --run \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriDesktopTabs.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriCovenSessionNativeContract.test.ts
pnpm typecheck
cd native/macos/psyche-build-tauri/src-tauri
cargo fmt --check
cargo test --locked
cargo check --locked
```

Expected: PASS.

- [ ] **Step 5: Commit lifecycle guards after approval**

```bash
git add \
  __tests__/tauriCovenLaunch.test.ts \
  native/macos/psyche-build-tauri/web/main.js
git diff --cached --check
git commit -m "fix(macos): guard native PTY lifecycle"
```

## Task 10: Close PR 2 with packaged Coven smoke

- [ ] **Step 1: Run the complete repository gate**

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm smoke
pnpm smoke:pack
pnpm --filter psyche-build-tauri run build
```

Expected: no new failures.

- [ ] **Step 2: Inspect the packaged launch behavior**

Verify:

1. project open creates one `coven chat` pane in the selected worktree;
2. reselecting the same worktree focuses rather than duplicates;
3. terminal Command-T, rail `+`, and `/new-thread` create `coven chat`;
4. browser Command-T still creates a browser tab;
5. `/new-shell` creates a login shell;
6. `/new-psyche` still starts the isolated tmux-backed TUI;
7. removing `coven` from the app PATH leaves tree/process state unchanged and
   shows installation guidance;
8. failed/exited panes retry in place; and
9. app restart creates one fresh active-worktree pane rather than restoring all
   prior processes.

- [ ] **Step 3: Prepare the PR after approval**

```bash
git status --short
git log --oneline origin/main..HEAD
git diff --check origin/main...HEAD
```

Expected: only PR 2 files are changed.

---

# PR 3 — Discovery and native attach

After PR 2 is merged, create a fresh worktree:

```bash
git fetch origin
git worktree add -b feat/native-coven-attach .worktrees/native-coven-attach origin/main
cd .worktrees/native-coven-attach
```

## Task 11: Preserve confirmed sessions through discovery failures

**Files:**

- Modify: `native/macos/psyche-build-tauri/web/sessions/session-model.mjs`
- Modify: `__tests__/tauriSessionModel.test.ts`
- Regenerate: `native/macos/psyche-build-tauri/web/sessions.bundle.js`

- [ ] **Step 1: Replace the clearing-error test with stale-preservation cases**

Replace the failure loop in `tauriSessionModel.test.ts` with:

```ts
test('preserves confirmed rows as stale through failures and replaces them on recovery', () => {
  const requested = model.beginCovenRequest(model.createCovenDiscoveryState());
  const ready = model.applyCovenResponse(requested.state, requested.requestId, {
    status: 'ready',
    sessions: [{ id: 'live', projectRoot: '/alpha', status: 'running' }],
  }, 100);

  for (const status of ['unavailable', 'incompatible', 'error']) {
    const next = model.beginCovenRequest(ready);
    const failed = model.applyCovenResponse(
      next.state,
      next.requestId,
      { status, message: ' nope ' },
      101,
    );
    expect(failed).toEqual({
      phase: status,
      sessionsByProject: ready.sessionsByProject,
      message: 'nope',
      requestId: next.requestId,
      refreshedAt: 101,
      stale: true,
    });

    const recovery = model.beginCovenRequest(failed);
    const recovered = model.applyCovenResponse(recovery.state, recovery.requestId, {
      status: 'ready',
      sessions: [{ id: 'recovered', projectRoot: '/beta', status: 'running' }],
    }, 102);
    expect(recovered).toMatchObject({ phase: 'ready', stale: false });
    expect(recovered.sessionsByProject.has('/alpha')).toBe(false);
    expect(recovered.sessionsByProject.get('/beta')?.[0].id).toBe('recovered');
  }
});
```

Update initial/empty/malformed expectations to include `stale: false`.

- [ ] **Step 2: Verify the model tests fail**

```bash
pnpm vitest --run __tests__/tauriSessionModel.test.ts
```

Expected: FAIL because failure responses currently clear rows.

- [ ] **Step 3: Implement stale preservation**

Add `stale: false` to `createCovenDiscoveryState`. In
`applyCovenResponse`, use:

```js
if (status === 'ready' || status === 'empty') {
  return {
    ...state,
    phase: 'ready',
    sessionsByProject: groupCovenSessions(response.sessions),
    message,
    refreshedAt,
    stale: false,
  };
}

if (status === 'unavailable' || status === 'incompatible' || status === 'error') {
  return {
    ...state,
    phase: status,
    sessionsByProject: state.sessionsByProject,
    message,
    refreshedAt,
    stale: state.sessionsByProject.size > 0,
  };
}
```

Malformed statuses use `phase: "error"` with the same stale rule. Explicit
`invalidateCovenRequests` clears rows and resets `stale: false`.

- [ ] **Step 4: Rebuild and test**

```bash
pnpm --dir native/macos/psyche-build-tauri build:web
pnpm vitest --run \
  __tests__/tauriSessionModel.test.ts \
  __tests__/tauriWorkspacePanels.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit stale discovery semantics after approval**

```bash
git add \
  __tests__/tauriSessionModel.test.ts \
  native/macos/psyche-build-tauri/web/sessions/session-model.mjs \
  native/macos/psyche-build-tauri/web/sessions.bundle.js
git diff --cached --check
git commit -m "fix(macos): preserve confirmed Coven sessions"
```

## Task 12: Restore bounded, visible-only discovery

**Files:**

- Modify: `__tests__/tauriCovenSessionLifecycle.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs`

- [ ] **Step 1: Replace the removal contract with lifecycle tests**

Use the existing `functionSource` helper and assert:

```ts
it('discovers every project and available worktree root in one bounded request', () => {
  const refresh = functionSource(mainJs, 'refreshCovenSessions');
  expect(refresh).toContain('covenDiscoveryRoots()');
  expect(refresh).toContain('invoke("coven_sessions"');
  expect(refresh).toContain('projectRoots: roots');
  expect(refresh).toContain('PsycheSessions.beginCovenRequest');
  expect(refresh).toContain('PsycheSessions.applyCovenResponse');
});

it('polls only with visible open projects and invalidates on project removal', () => {
  expect(mainJs).toContain('var COVEN_POLL_MS = 5000;');
  expect(functionSource(mainJs, 'startCovenPolling')).toContain(
    'document.visibilityState === "hidden" || state.projects.length === 0'
  );
  expect(functionSource(mainJs, 'handleVisibilityChange')).toMatch(
    /hidden[\s\S]*saveWorkspaceNow\(\)[\s\S]*stopCovenPolling\(\)/
  );
  expect(functionSource(mainJs, 'handleVisibilityChange')).toMatch(
    /else[\s\S]*startCovenPolling\(\)/
  );
  expect(functionSource(mainJs, 'removeProject')).toContain(
    'PsycheSessions.invalidateCovenRequests'
  );
});

it('keeps remote records outside local thread state', () => {
  expect(functionSource(mainJs, 'refreshCovenSessions')).not.toContain('state.threads');
});
```

In `coven_sessions.rs`, change
`keeps_only_cwds_within_requested_project_or_worktree_roots` to assert that the
session with the external cwd is dropped entirely:

```rust
assert_eq!(
    sessions.iter().map(|session| session.id.as_str()).collect::<Vec<_>>(),
    vec!["inside", "linked"],
);
```

- [ ] **Step 2: Verify lifecycle tests fail**

```bash
pnpm vitest --run __tests__/tauriCovenSessionLifecycle.test.ts
```

Expected: FAIL because discovery was intentionally removed.

- [ ] **Step 3: Implement ownership roots and polling**

Add:

```js
var covenDiscovery = PsycheSessions.createCovenDiscoveryState();
var covenPollTimer = null;
var COVEN_POLL_MS = 5000;

function covenDiscoveryRoots() {
  var roots = [];
  state.projects.forEach(function (project) {
    [project.root].concat(
      (project.worktrees || [])
        .filter(function (worktree) { return !worktree.missing && !worktree.prunable && !worktree.bare; })
        .map(function (worktree) { return worktree.path; })
    ).forEach(function (root) {
      if (root && roots.indexOf(root) === -1) roots.push(root);
    });
  });
  return roots;
}

function covenSessionsForProject(project) {
  var roots = [project.root].concat(
    (project.worktrees || []).map(function (worktree) { return worktree.path; })
  );
  return roots.reduce(function (sessions, root) {
    return sessions.concat(covenDiscovery.sessionsByProject.get(root) || []);
  }, []);
}

async function refreshCovenSessions() {
  var roots = covenDiscoveryRoots();
  var started = PsycheSessions.beginCovenRequest(covenDiscovery);
  covenDiscovery = started.state;
  renderSessionList();
  try {
    var response = await invoke("coven_sessions", { projectRoots: roots });
    covenDiscovery = PsycheSessions.applyCovenResponse(
      covenDiscovery,
      started.requestId,
      response
    );
  } catch (_) {
    covenDiscovery = PsycheSessions.applyCovenResponse(
      covenDiscovery,
      started.requestId,
      { status: "error", sessions: [], message: "Coven sessions could not be loaded" }
    );
  }
  renderSessionList();
  return covenDiscovery;
}

function stopCovenPolling() {
  if (covenPollTimer) clearInterval(covenPollTimer);
  covenPollTimer = null;
}

function startCovenPolling() {
  stopCovenPolling();
  if (document.visibilityState === "hidden" || state.projects.length === 0) return;
  refreshCovenSessions();
  covenPollTimer = setInterval(refreshCovenSessions, COVEN_POLL_MS);
}
```

Update `handleVisibilityChange`: hidden saves/stops; visible starts. Refresh
after boot, project add/remove, worktree refresh, and successful Coven start.
Invalidate request identity before project removal so a late response is
ignored.

Change cwd normalization so an explicitly supplied missing or out-of-scope cwd
drops the record instead of silently rewriting it to `None`:

```rust
let cwd = match optional_string(fields, "cwd", "cwd")? {
    Some(cwd) => {
        let canonical_cwd = Path::new(&cwd).canonicalize().ok()?;
        if !requested_roots
            .keys()
            .any(|requested_root| canonical_cwd.starts_with(requested_root))
        {
            return None;
        }
        Some(cwd)
    }
    None => None,
};
```

- [ ] **Step 4: Run lifecycle/model tests**

```bash
pnpm vitest --run \
  __tests__/tauriSessionModel.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriCovenSessionNativeContract.test.ts
cd native/macos/psyche-build-tauri/src-tauri
cargo test --locked coven_sessions::tests::keeps_only_cwds_within_requested_project_or_worktree_roots
cd ../../../..
```

Expected: PASS.

- [ ] **Step 5: Commit discovery lifecycle after approval**

```bash
git add \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs \
  native/macos/psyche-build-tauri/web/main.js
git diff --cached --check
git commit -m "feat(macos): restore scoped Coven discovery"
```

## Task 13: Render mixed local and Coven rail rows

**Files:**

- Modify: `__tests__/tauriCovenSessionSiderail.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `native/macos/psyche-build-tauri/web/styles.css`

- [ ] **Step 1: Replace local-only rail assertions**

Restore mixed-source expectations:

```ts
it('renders local and daemon sessions as distinct subsections and identities', () => {
  const renderer = createRenderer({
    threads: [{
      id: 'attached',
      projectId: 'alpha',
      name: 'Attached locally',
      status: 'running',
      kind: 'coven-attach',
      covenSessionId: 'remote',
      worktreePath: '/alpha',
    }],
    sessions: [{
      id: 'remote',
      projectRoot: '/alpha',
      title: 'Durable session',
      status: 'waiting',
    }],
  });

  renderer.render();
  expect(textOf(renderer.sessionListEl.querySelectorAll('.session-subsection-label')))
    .toEqual(['Psyche', 'Coven']);
  expect(renderer.sessionListEl.querySelector('.session-row')?.dataset.threadId)
    .toBe('attached');
  expect(renderer.sessionListEl.querySelector('.session-coven-row')?.dataset.sessionId)
    .toBe('remote');
  expect(renderer.sessionListEl.querySelectorAll('.session-attention-badge')).not.toHaveLength(0);
});

it('keeps stale rows visible with one discovery status line', () => {
  const renderer = createRenderer({
    sessions: [{ id: 'remote', projectRoot: '/alpha', title: 'Remote', status: 'running' }],
    phase: 'unavailable',
    message: 'Daemon offline',
    stale: true,
  });
  renderer.render();
  expect(renderer.sessionListEl.querySelector('.session-coven-row')).not.toBeNull();
  expect(renderer.sessionListEl.querySelector('.session-inline-state')?.textContent)
    .toContain('Daemon offline');
});
```

Extend the harness option/state type with `stale?: boolean` and pass real
`covenInlineState`/`covenToneClass` function sources from `main.js`.

- [ ] **Step 2: Verify rail tests fail**

```bash
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: FAIL because the renderer passes `[]` for remote rows.

- [ ] **Step 3: Render remote rows without merging identities**

For each project call:

```js
var remoteRows = covenSessionsForProject(project);
var railModel = PsycheSessions.buildProjectRailModel(
  project,
  localRows,
  remoteRows,
  currentSearchQuery
);
```

Partition each worktree's rows:

```js
var threads = entry.rows
  .filter(function (row) { return row.source === "psyche"; })
  .map(function (row) { return row.value; });
var covenSessions = entry.rows
  .filter(function (row) { return row.source === "coven"; })
  .map(function (row) { return row.value; });
```

Render `Psyche` before local rows and `Coven` before daemon rows. Each daemon
button uses `className = "session-coven-row"`,
`dataset.sessionId = session.id`, title/status/harness text, and calls
`openCovenSession(project, session)`. If an attachment thread exists, label the
action `Focus attachment`; otherwise label it `Attach`.

Render one `.session-inline-state` for loading/error/incompatible/unavailable.
When `covenDiscovery.stale` is true, retain rows and append `— showing last
confirmed sessions`.

- [ ] **Step 4: Restore scoped styles**

Add only the selectors used by the renderer:

```css
.session-coven-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  background: transparent;
  color: var(--text-soft);
  text-align: left;
}
.session-coven-row:hover,
.session-coven-row:focus-visible {
  background: var(--surface-2);
  color: var(--text);
}
.session-inline-state {
  padding: 4px 10px 6px 28px;
  color: var(--muted);
  font-size: 11px;
}
.coven-tone-ok { color: var(--ok); }
.coven-tone-warn { color: var(--warning); }
.coven-tone-danger { color: var(--error); }
.coven-tone-muted { color: var(--muted); }
```

- [ ] **Step 5: Run rail regression tests**

```bash
pnpm vitest --run \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriSessionModel.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit mixed rail rendering after approval**

```bash
git add \
  __tests__/tauriCovenSessionSiderail.test.ts \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css
git diff --cached --check
git commit -m "feat(macos): show scoped Coven sessions"
```

## Task 14: Add deduplicated native attachment

**Files:**

- Modify: `__tests__/tauriCovenSessionLifecycle.test.ts`
- Modify: `__tests__/tauriCovenLaunch.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js`

- [ ] **Step 1: Add failing attach focus/deduplication tests**

Add source-executed tests proving:

```ts
it('reserves attach identity and releases it on settle', () => {
  const source = functionSource(mainJs, 'openCovenSession');
  expect(mainJs).toContain('var covenAttachInFlight = new Map();');
  expect(source).toContain('covenAttachInFlight.set(key, opening)');
  expect(source).toContain('PsycheSessions.isSafeCovenSessionId(session.id)');
  expect(source).toContain('args: ["attach", session.id]');
  expect(source).toContain('launchKind: "coven-attach"');
  expect(source).toContain('covenSessionId: session.id');
  expect(source).toContain('.finally(function ()');
  expect(source).not.toMatch(/coven\.session\.open|openProjectCovenSession|tmux/i);
});

it('focuses or reopens an existing attachment before reserving a new one', () => {
  const source = functionSource(mainJs, 'openCovenSession');
  expect(source.indexOf('existing.hidden')).toBeLessThan(source.indexOf('covenAttachInFlight.set'));
  expect(source.indexOf('focusThread(existing.id)')).toBeLessThan(
    source.indexOf('covenAttachInFlight.set')
  );
});

it('revalidates an attachment before retrying its PTY', () => {
  const source = functionSource(mainJs, 'retryThread');
  expect(source).toContain('await refreshCovenSessions()');
  expect(source).toContain('covenDiscovery.phase === "ready"');
  expect(source).toContain('session.id === thread.launch.covenSessionId');
  expect(source.indexOf('await refreshCovenSessions()')).toBeLessThan(
    source.indexOf('spawnPty(thread)')
  );
});
```

Execute `openCovenSession` twice with a deferred `createThread` start and assert
both calls return the same promise and `createThread` runs once. Also defer
`setActiveProject` and assert the reservation already deduplicates the second
call before project switching or pane mutation completes.

- [ ] **Step 2: Verify attach tests fail**

```bash
pnpm vitest --run \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriCovenLaunch.test.ts
```

Expected: FAIL because native attach is absent.

- [ ] **Step 3: Implement exact native attach**

Add:

```js
var covenAttachInFlight = new Map();

function covenAttachKey(project, session) {
  return project.root + "\n" + session.id;
}

function openCovenSession(project, session) {
  if (!project || !session || !PsycheSessions.isSafeCovenSessionId(session.id)) {
    setStatus("Invalid Coven session", "error");
    return Promise.resolve(null);
  }
  if (!state.env || !state.env.coven_path) {
    setStatus("Coven CLI not found — install @opencoven/cli and restart Psyche", "error");
    return Promise.resolve(null);
  }

  var existing = state.threads.find(function (thread) {
    return thread.projectId === project.id
      && thread.covenSessionId === session.id
      && !thread.closeStarted;
  });
  if (existing) {
    return Promise.resolve().then(async function () {
      if (project.id !== state.activeProjectId && !(await setActiveProject(project.id))) {
        return null;
      }
      if (existing.hidden && !reopenThread(existing.id)) return null;
      await focusThread(existing.id);
      return existing;
    });
  }

  var key = covenAttachKey(project, session);
  if (covenAttachInFlight.has(key)) return covenAttachInFlight.get(key);

  var opening = Promise.resolve().then(async function () {
    if (project.id !== state.activeProjectId && !(await setActiveProject(project.id))) {
      return null;
    }
    var worktree = (project.worktrees || []).find(function (candidate) {
      return session.cwd && (
        session.cwd === candidate.path
        || session.cwd.indexOf(candidate.path + "/") === 0
      );
    }) || (project.worktrees || []).find(function (candidate) {
      return session.projectRoot === candidate.path;
    }) || selectedWorktree(project);
    return createThread({
      project: project,
      name: session.title || "Coven " + session.id.slice(0, 8),
      kind: "coven-attach",
      command: state.env.coven_path,
      args: ["attach", session.id],
      projectRoot: project.root,
      cwd: session.cwd || worktree.path,
      worktreePath: worktree.path,
      launchKind: "coven-attach",
      covenSessionId: session.id,
    });
  }).finally(function () {
    covenAttachInFlight.delete(key);
  });
  covenAttachInFlight.set(key, opening);
  return opening;
}
```

If `coven_path` is unavailable, return before setting the reservation. If the
candidate pane does not fit, `createThread` returns `null` and no PTY starts.
Because the `Promise.resolve().then(...)` callback runs in a microtask,
`covenAttachInFlight.set(key, opening)` executes before project switching,
layout mutation, or PTY start.

Replace `retryThread` with an async version that revalidates attachment targets:

```js
async function retryThread(id) {
  var thread = findThread(id);
  if (!thread || thread.startInFlight || thread.closeStarted) return false;
  if (thread.status !== "exited" && thread.status !== "failed") return false;
  if (thread.launch.launchKind === "coven-attach") {
    var project = findProject(thread.projectId);
    await refreshCovenSessions();
    var stillExists = project
      && covenDiscovery.phase === "ready"
      && covenSessionsForProject(project).some(function (session) {
        return session.id === thread.launch.covenSessionId;
      });
    if (!stillExists) {
      setStatus("Coven session is no longer available; refresh the rail before retrying", "warn");
      return false;
    }
  }
  spawnPty(thread);
  return true;
}
```

- [ ] **Step 4: Run focused attach tests**

```bash
pnpm vitest --run \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriPhysicalPanes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit native attach after approval**

```bash
git add \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  native/macos/psyche-build-tauri/web/main.js
git diff --cached --check
git commit -m "feat(macos): attach Coven sessions natively"
```

## Task 15: Pin the no-tmux boundary and packaged acceptance

**Files:**

- Modify: `__tests__/tauriCovenSessionLifecycle.test.ts`
- Modify: `__tests__/tauriCovenSessionNativeContract.test.ts`
- Modify: `docs/SMOKE.md`

- [ ] **Step 1: Add the native source boundary**

Add:

```ts
it('keeps native Coven create and attach outside daemon/tmux mutation paths', () => {
  const create = functionSource(mainJs, 'covenChatLaunch');
  const attach = functionSource(mainJs, 'openCovenSession');
  const nativeCovenSource = `${create}\n${attach}`;
  expect(nativeCovenSource).not.toMatch(
    /coven\.session\.open|openProjectCovenSession|createTmuxPane|sendTmuxCommand|TMUX_TMPDIR/
  );
  expect(nativeCovenSource).toContain('args: ["chat"]');
  expect(nativeCovenSource).toContain('args: ["attach", session.id]');
});
```

In `tauriCovenSessionNativeContract.test.ts`, assert:

```ts
expect(libSource).toMatch(/fn\s+validate_coven_launch\(/);
expect(libSource).toMatch(/fn\s+resolve_pty_cwd\(/);
expect(libSource).toMatch(/fn\s+linked_worktree_roots\(/);
expect(libSource).toMatch(/cmd\.env_remove\("TMUX"\)/);
```

- [ ] **Step 2: Run boundary tests**

```bash
pnpm vitest --run \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriCovenSessionNativeContract.test.ts
```

Expected: PASS.

- [ ] **Step 3: Document the packaged smoke procedure**

Add a `Native Coven physical panes` subsection to `docs/SMOKE.md` with exact
operator checks:

```markdown
### Native Coven physical panes

1. Launch the unsigned macOS app with `coven` available on the augmented PATH.
2. Open a repository with a linked worktree and select that worktree.
3. Confirm project open creates one `coven chat` PTY in that worktree.
4. Press Command-T twice and confirm three simultaneous physical panes.
5. Type distinct input in each pane and confirm focus/input isolation.
6. Drag a divider and use its arrow-key controls; confirm all visible PTYs resize.
7. Select a durable session in the Coven rail twice; confirm one native
   `coven attach <id>` pane is created and the second action focuses it.
8. Close the attachment and confirm `coven sessions` still lists the durable session.
9. Stop the daemon and confirm new `coven chat` panes still launch while the rail
   shows stale/unavailable discovery state.
10. Run `/new-shell` and `/new-psyche`; confirm the former is a login shell and
    only the latter starts the legacy tmux-backed TUI.
```

- [ ] **Step 4: Commit the boundary and smoke guide after approval**

```bash
git add \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriCovenSessionNativeContract.test.ts \
  docs/SMOKE.md
git diff --cached --check
git commit -m "test(macos): pin native Coven pane boundary"
```

## Task 16: Run final verification and prepare PR 3

- [ ] **Step 1: Run focused native suites**

```bash
pnpm --dir native/macos/psyche-build-tauri build:web
pnpm vitest --run \
  __tests__/tauriPaneTree.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriSessionModel.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriCovenSessionNativeContract.test.ts \
  __tests__/tauriDesktopTabs.test.ts \
  __tests__/tauriWorkspaceEditorIntegration.test.ts \
  __tests__/tauriWorkspacePanels.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run complete TypeScript and Rust gates**

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm smoke
pnpm smoke:pack
cd native/macos/psyche-build-tauri/src-tauri
cargo fmt --check
cargo test --locked
cargo check --locked
cd ..
pnpm build
```

Expected: no new failures and an unsigned packaged app.

- [ ] **Step 3: Run the documented packaged smoke**

Execute every `Native Coven physical panes` step in `docs/SMOKE.md`. Record the
app build path, macOS version, Coven version, and result for all ten checks in
the PR readiness packet.

- [ ] **Step 4: Review the complete diff**

```bash
git status --short
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Confirm:

- no pane tree or process descriptors are serialized to workspace storage;
- the top tab strip still contains files only;
- native create/attach source contains no daemon mutation or tmux calls;
- `openProjectCovenSession` remains available for legacy daemon consumers;
- remote discovery never inserts records into `state.threads`; and
- unrelated user changes are absent.

- [ ] **Step 5: Prepare the PR after explicit approval**

Do not push, open, or merge the PR until Val explicitly authorizes those
actions.
