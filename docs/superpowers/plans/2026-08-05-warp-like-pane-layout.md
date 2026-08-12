# Warp-Like Pane Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every shell a first-class tmux workspace pane in a persistent, adaptive split layout rather than a sidebar card or a rebalanced grid.

**Architecture:** A pure `PaneLayoutTree` stores logical Psyche pane IDs and describes split topology. A compiler projects the visible portion of that tree into a tmux layout string, and a controller applies that projection before atomically persisting the changed session configuration. All pane creation, external shell detection, close, hide, restore, and resize paths call the controller instead of `recalculateAndApplyLayout`.

**Tech Stack:** TypeScript, React/Ink, tmux, Vitest, pnpm.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/layout/PaneLayoutTree.ts` | Persistent layout types plus pure seed, insert, hide-aware projection, remove, and validation operations. |
| `src/layout/PaneLayoutCompiler.ts` | Converts a visible split tree into tmux's checksum-prefixed custom-layout syntax. |
| `src/layout/PaneLayoutController.ts` | Resolves the focused target, mutates a copied tree, applies the tmux layout, and returns a commit-ready layout only on success. |
| `src/layout/LayoutCalculator.ts`, `src/layout/SpacerManager.ts`, `src/layout/TmuxLayoutApplier.ts` | Deleted: automatic-grid and spacer implementation replaced by the persistent tree. |
| `src/types.ts` | Stores the optional `paneLayout` session field and exports the shared layout types. |
| `src/utils/layoutManager.ts` | Retains sidebar sizing but delegates workspace layout to the split-tree controller; removes automatic-grid and spacer behavior. |
| `src/hooks/usePanes.ts`, `src/hooks/usePaneSync.ts`, `src/hooks/usePaneLoading.ts` | Seed legacy layouts, preserve `paneLayout` across saves, and reconcile shell exits and pane-ID rebinding. |
| `src/utils/paneCreation.ts`, `src/utils/attachAgent.ts`, `src/utils/reopenWorktree.ts`, `src/PsycheApp.tsx`, `src/hooks/useInputHandling.ts`, `src/hooks/useShellDetection.ts`, `src/actions/implementations/closeAction.ts`, `src/utils/postPaneCleanup.ts` | Route each lifecycle action through the controller with the correct target pane and mutation kind. |
| `src/components/panes/PanesGrid.tsx` | Omits shell-pane rows so the tmux workspace is the only shell view. |
| `__tests__/paneLayoutTree.test.ts`, `__tests__/paneLayoutCompiler.test.ts`, `__tests__/paneLayoutController.test.ts`, `__tests__/panesGrid.test.tsx` | Cover the new pure model, layout projection, rollback semantics, and sidebar behavior. |
| `__tests__/layout.test.ts`, `__tests__/usePaneCreation.test.ts`, `__tests__/paneVisibility.test.ts`, `__tests__/reopenWorktree.test.ts` | Replace grid assumptions and cover lifecycle integration with the persistent layout. |

### Task 1: Define and test the persistent layout tree

**Files:**
- Create: `src/layout/PaneLayoutTree.ts`
- Modify: `src/types.ts:201-211`
- Create: `__tests__/paneLayoutTree.test.ts`

- [ ] **Step 1: Write the failing tree-model tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  insertPane,
  listLeafPaneIds,
  removePane,
  seedPaneLayout,
  visiblePaneLayout,
} from '../src/layout/PaneLayoutTree.js';

describe('PaneLayoutTree', () => {
  it('seeds a deterministic right-branching tree from legacy visible pane order', () => {
    expect(seedPaneLayout(['psyche-1', 'psyche-2', 'psyche-3'])).toEqual({
      version: 1,
      root: {
        kind: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { kind: 'leaf', paneId: 'psyche-1' },
        second: {
          kind: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { kind: 'leaf', paneId: 'psyche-2' },
          second: { kind: 'leaf', paneId: 'psyche-3' },
        },
      },
    });
  });

  it('inserts a new leaf next to the requested target without moving unrelated branches', () => {
    const layout = seedPaneLayout(['psyche-1', 'psyche-2', 'psyche-3']);
    const next = insertPane(layout, 'psyche-2', 'psyche-4', 'vertical');

    expect(listLeafPaneIds(next.root)).toEqual([
      'psyche-1',
      'psyche-2',
      'psyche-4',
      'psyche-3',
    ]);
    expect(next.root?.kind).toBe('split');
  });

  it('collapses a closed leaf parent while retaining its surviving sibling', () => {
    const layout = insertPane(seedPaneLayout(['psyche-1']), 'psyche-1', 'psyche-2', 'horizontal');
    expect(removePane(layout, 'psyche-1')).toEqual({
      version: 1,
      root: { kind: 'leaf', paneId: 'psyche-2' },
    });
  });

  it('omits hidden panes from the rendered projection without changing persisted topology', () => {
    const layout = seedPaneLayout(['psyche-1', 'psyche-2']);
    expect(visiblePaneLayout(layout, new Set(['psyche-2']))).toEqual({
      kind: 'leaf',
      paneId: 'psyche-1',
    });
    expect(listLeafPaneIds(layout.root)).toEqual(['psyche-1', 'psyche-2']);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm vitest --run __tests__/paneLayoutTree.test.ts`

Expected: FAIL because `PaneLayoutTree.js` does not exist.

- [ ] **Step 3: Add the serializable layout types to the session model**

Add these declarations above `PsycheConfig` in `src/types.ts` and add
`paneLayout?: PaneLayout` to `PsycheConfig`:

```ts
export type PaneSplitDirection = 'horizontal' | 'vertical';

export interface PaneLayoutLeaf {
  kind: 'leaf';
  paneId: string;
}

export interface PaneLayoutSplit {
  kind: 'split';
  direction: PaneSplitDirection;
  ratio: number;
  first: PaneLayoutNode;
  second: PaneLayoutNode;
}

export type PaneLayoutNode = PaneLayoutLeaf | PaneLayoutSplit;

export interface PaneLayout {
  version: 1;
  root: PaneLayoutNode | null;
}
```

- [ ] **Step 4: Implement pure, immutable tree operations**

Create `src/layout/PaneLayoutTree.ts` with the following exported API. Use
logical `PsychePane.id` values only; tmux pane IDs are runtime bindings and
must never be persisted in the tree.

```ts
import type {
  PaneLayout,
  PaneLayoutNode,
  PaneSplitDirection,
} from '../types.js';

export function seedPaneLayout(paneIds: string[]): PaneLayout;
export function listLeafPaneIds(node: PaneLayoutNode | null): string[];
export function insertPane(
  layout: PaneLayout,
  targetPaneId: string,
  newPaneId: string,
  direction: PaneSplitDirection,
): PaneLayout;
export function removePane(layout: PaneLayout, paneId: string): PaneLayout;
export function visiblePaneLayout(
  layout: PaneLayout,
  hiddenPaneIds: ReadonlySet<string>,
): PaneLayoutNode | null;
export function prunePaneLayout(
  layout: PaneLayout,
  knownPaneIds: ReadonlySet<string>,
): PaneLayout;
```

Implement `seedPaneLayout` as the right-branching horizontal tree asserted in
the test. `insertPane` must throw if either ID is absent/present incorrectly,
replace only the target leaf with a 50/50 split, and preserve all other node
references. `removePane` must recursively remove one leaf and replace a
one-child split with the surviving child. `visiblePaneLayout` must recursively
remove hidden leaves without mutating the stored tree; `prunePaneLayout` uses
the same collapse rule for pane metadata that has been permanently removed.

- [ ] **Step 5: Run the tree tests to verify they pass**

Run: `pnpm vitest --run __tests__/paneLayoutTree.test.ts`

Expected: PASS with four tests.

- [ ] **Step 6: Commit the model**

```bash
git add src/types.ts src/layout/PaneLayoutTree.ts __tests__/paneLayoutTree.test.ts
git commit -m "feat: add persistent pane layout tree"
```

### Task 2: Compile split trees into valid tmux layouts

**Files:**
- Create: `src/layout/PaneLayoutCompiler.ts`
- Modify: `src/utils/tmux.ts:156-335`
- Modify: `__tests__/layout.test.ts`
- Create: `__tests__/paneLayoutCompiler.test.ts`

- [ ] **Step 1: Write failing compiler tests**

```ts
import { describe, expect, it } from 'vitest';
import { compileSidebarPaneLayout } from '../src/layout/PaneLayoutCompiler.js';

describe('compileSidebarPaneLayout', () => {
  const panes = new Map([
    ['psyche-1', '%1'],
    ['psyche-2', '%2'],
    ['psyche-3', '%3'],
  ]);

  it('renders a sidebar and a horizontal sibling pair at absolute coordinates', () => {
    const layout = compileSidebarPaneLayout({
      controlPaneId: '%0',
      root: {
        kind: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { kind: 'leaf', paneId: 'psyche-1' },
        second: { kind: 'leaf', paneId: 'psyche-2' },
      },
      panes,
      sidebarWidth: 40,
      windowWidth: 201,
      windowHeight: 60,
    });

    expect(layout).toMatch(/^[0-9a-f]{4},201x60,0,0\{/);
    expect(layout).toContain('40x60,0,0,0');
    expect(layout).toContain(',41,0,1');
    expect(layout).toContain(',121,0,2');
  });

  it('renders vertical descendants below their parent and gives the last child the rounding remainder', () => {
    const layout = compileSidebarPaneLayout({
      controlPaneId: '%0',
      root: {
        kind: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { kind: 'leaf', paneId: 'psyche-1' },
        second: {
          kind: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { kind: 'leaf', paneId: 'psyche-2' },
          second: { kind: 'leaf', paneId: 'psyche-3' },
        },
      },
      panes,
      sidebarWidth: 40,
      windowWidth: 201,
      windowHeight: 61,
    });

    expect(layout).toContain(',41,0,1');
    expect(layout).toContain(',41,31,2');
    expect(layout).toContain(',121,31,3');
  });

  it('throws rather than emitting a layout for an unresolved logical pane ID', () => {
    expect(() => compileSidebarPaneLayout({
      controlPaneId: '%0',
      root: { kind: 'leaf', paneId: 'missing' },
      panes,
      sidebarWidth: 40,
      windowWidth: 120,
      windowHeight: 40,
    })).toThrow('missing tmux pane binding for missing');
  });
});
```

- [ ] **Step 2: Run the compiler tests to verify they fail**

Run: `pnpm vitest --run __tests__/paneLayoutCompiler.test.ts`

Expected: FAIL because `PaneLayoutCompiler.js` does not exist.

- [ ] **Step 3: Implement the layout compiler**

Create `src/layout/PaneLayoutCompiler.ts`. Export:

```ts
export interface CompileSidebarPaneLayoutOptions {
  controlPaneId: string;
  root: PaneLayoutNode | null;
  panes: ReadonlyMap<string, string>;
  sidebarWidth: number;
  windowWidth: number;
  windowHeight: number;
}

export function compileSidebarPaneLayout(
  options: CompileSidebarPaneLayoutOptions,
): string;
```

Implement a recursive renderer receiving `x`, `y`, `width`, and `height`.
For a horizontal split, divide `width - 1` at
`Math.floor((width - 1) * ratio)`, place the second child one cell after the
first, and give any remainder to the second child. Apply the symmetric rule to
`height - 1` for vertical splits. Leaves resolve their logical ID through
`panes`, strip the `%` prefix, and use absolute coordinates. Wrap the content
tree with the existing fixed-width sidebar, then calculate the existing
four-character tmux checksum from the final body.

- [ ] **Step 4: Remove grid-only public API and rewrite its focused tests**

Delete `generateSidebarGridLayout` from `src/utils/tmux.ts` and replace the
`generateSidebarGridLayout - checksum fixes` block in
`__tests__/layout.test.ts` with imports from `PaneLayoutCompiler`. Retain the
tests for the checksum width, sidebar coordinates, rounding, and deterministic
output, but express them through `compileSidebarPaneLayout`. Remove the
`calculateOptimalColumns` and `calculateOptimalLayout` expectations because
grid selection is no longer workspace behavior.

- [ ] **Step 5: Run compiler and updated layout tests**

Run: `pnpm vitest --run __tests__/paneLayoutCompiler.test.ts __tests__/layout.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the tmux projection**

```bash
git add src/layout/PaneLayoutCompiler.ts src/utils/tmux.ts __tests__/paneLayoutCompiler.test.ts __tests__/layout.test.ts
git commit -m "feat: compile persistent pane layouts for tmux"
```

### Task 3: Apply and persist layout mutations transactionally

**Files:**
- Create: `src/layout/PaneLayoutController.ts`
- Delete: `src/layout/LayoutCalculator.ts`
- Delete: `src/layout/SpacerManager.ts`
- Delete: `src/layout/TmuxLayoutApplier.ts`
- Modify: `src/utils/layoutManager.ts`
- Modify: `src/utils/tmux.ts:1-12,412-512`
- Modify: `src/hooks/usePaneLoading.ts:27-36,318-334`
- Modify: `src/hooks/usePaneSync.ts:84-141,263-305`
- Modify: `src/hooks/usePanes.ts:67-189`
- Create: `__tests__/paneLayoutController.test.ts`
- Modify: `__tests__/paneVisibility.test.ts`

- [ ] **Step 1: Write failing controller and migration tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { applyPaneLayoutMutation } from '../src/layout/PaneLayoutController.js';
import { seedPaneLayout } from '../src/layout/PaneLayoutTree.js';

describe('applyPaneLayoutMutation', () => {
  const panes = [
    { id: 'psyche-1', paneId: '%1', hidden: false },
    { id: 'psyche-2', paneId: '%2', hidden: false },
  ];

  it('seeds a missing layout, inserts beside the selected pane, applies it, then returns it for persistence', async () => {
    const selectLayout = vi.fn().mockReturnValue(true);
    const result = await applyPaneLayoutMutation({
      paneLayout: undefined,
      panes,
      controlPaneId: '%0',
      terminalWidth: 201,
      terminalHeight: 60,
      mutation: { kind: 'insert', paneId: 'psyche-2', targetPaneId: 'psyche-1', direction: 'horizontal' },
      selectLayout,
    });

    expect(result.layout).toEqual(seedPaneLayout(['psyche-1', 'psyche-2']));
    expect(selectLayout).toHaveBeenCalledTimes(1);
  });

  it('does not return a changed layout if tmux rejects the generated layout', async () => {
    await expect(applyPaneLayoutMutation({
      paneLayout: seedPaneLayout(['psyche-1']),
      panes: [panes[0]],
      controlPaneId: '%0',
      terminalWidth: 120,
      terminalHeight: 40,
      mutation: { kind: 'remove', paneId: 'psyche-1' },
      selectLayout: vi.fn().mockReturnValue(false),
    })).rejects.toThrow('tmux rejected pane layout');
  });
});
```

- [ ] **Step 2: Run the controller tests to verify they fail**

Run: `pnpm vitest --run __tests__/paneLayoutController.test.ts`

Expected: FAIL because `PaneLayoutController.js` does not exist.

- [ ] **Step 3: Implement the controller with explicit mutation types**

Create `src/layout/PaneLayoutController.ts` with:

```ts
export type PaneLayoutMutation =
  | { kind: 'insert'; paneId: string; targetPaneId: string; direction: PaneSplitDirection }
  | { kind: 'remove'; paneId: string }
  | { kind: 'reconcile' };

export async function applyPaneLayoutMutation(options: {
  paneLayout: PaneLayout | undefined;
  panes: Pick<PsychePane, 'id' | 'paneId' | 'hidden'>[];
  controlPaneId: string;
  terminalWidth: number;
  terminalHeight: number;
  mutation: PaneLayoutMutation;
  selectLayout: (layout: string) => boolean | Promise<boolean>;
}): Promise<{ layout: PaneLayout }>;
```

Seed an absent layout from current pane metadata order; for an `insert`, seed
from that order with `mutation.paneId` excluded, then insert it exactly once.
For `reconcile`, prune closed panes and project only visible panes. For
`insert`, reject a duplicate logical ID, mutate the seeded/current layout, and
project it. For `remove`, remove the logical leaf before projecting. Use
`compileSidebarPaneLayout` and call `selectLayout`; throw on a false result or
compiler failure. Return the new layout only after `selectLayout` succeeds so
callers cannot persist a layout tmux did not accept.

- [ ] **Step 4: Replace grid calculation with a layout-manager wrapper**

Delete `LayoutCalculator.ts`, `SpacerManager.ts`, and `TmuxLayoutApplier.ts`.
In `src/utils/layoutManager.ts`, remove their imports,
`lastLayoutDimensions`, and the grid-specific `recalculateAndApplyLayout`
implementation. Add:

```ts
export async function applyStoredPaneLayout(options: {
  panesFile: string;
  panes: PsychePane[];
  controlPaneId: string;
  terminalWidth: number;
  terminalHeight: number;
  mutation: PaneLayoutMutation;
}): Promise<PaneLayout>;
```

Read the current object-form config, pass `config.paneLayout` to
`applyPaneLayoutMutation`, and atomically write the returned layout into the
same config object only after tmux accepts it. Keep
`enforceControlPaneSize` as the resize fallback for an empty visible tree.

In `src/utils/tmux.ts`, retain `SIDEBAR_WIDTH`, pane discovery, and
`enforceControlPaneSize`, but remove `calculateOptimalColumns`,
`generateSidebarGridLayout`, and its `recalculateAndApplyLayout` delegation.
`enforceControlPaneSize` must only resize the control pane and refresh the
client; callers that need a workspace projection must call
`applyStoredPaneLayout` explicitly.

- [ ] **Step 5: Preserve and reconcile the layout during normal config writes**

Update `PsycheConfig` imports to use the shared type from `src/types.ts`; remove
the duplicate interface from `usePaneLoading.ts`. In `savePanesToFile`,
`saveUpdatedPaneConfig`, and `saveSidebarProjects`, preserve an existing
`paneLayout`, then call `applyStoredPaneLayout` with `{ kind: 'reconcile' }`
after panes are rebound, hidden, or removed. When a legacy config has no
layout, the first successful reconciliation writes its seeded tree. If
application fails, log through the existing `LogService` path and leave the
stored tree untouched.

- [ ] **Step 6: Add hide/unhide persistence coverage**

Extend `__tests__/paneVisibility.test.ts` with a case that hides
`psyche-2`, asserts the stored layout still contains both logical IDs, and
asserts the controller projection passed to tmux contains only `psyche-1`.
Unhide the pane and assert its original sibling position returns.

- [ ] **Step 7: Run transactional layout tests**

Run: `pnpm vitest --run __tests__/paneLayoutController.test.ts __tests__/paneVisibility.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit transactional persistence**

```bash
git add -A src/layout src/utils/layoutManager.ts src/utils/tmux.ts src/types.ts src/hooks/usePaneLoading.ts src/hooks/usePaneSync.ts src/hooks/usePanes.ts __tests__/paneLayoutController.test.ts __tests__/paneVisibility.test.ts
git commit -m "feat: persist pane layout mutations transactionally"
```

### Task 4: Route every pane lifecycle through the split-tree controller

**Files:**
- Modify: `src/utils/paneCreation.ts:318-328`
- Modify: `src/utils/attachAgent.ts:119-130`
- Modify: `src/utils/reopenWorktree.ts:145-156`
- Modify: `src/hooks/usePaneCreation.ts:108-146,186-229`
- Modify: `src/PsycheApp.tsx:917-971,1050-1090`
- Modify: `src/hooks/useInputHandling.ts:2339-2346`
- Modify: `src/hooks/useShellDetection.ts`
- Modify: `src/actions/implementations/closeAction.ts:312-359`
- Modify: `src/hooks/usePaneLoading.ts:318-334`
- Modify: `src/utils/postPaneCleanup.ts:39-53`
- Modify: `src/utils/tmux.ts:412-512`
- Modify: `__tests__/usePaneCreation.test.ts`
- Modify: `__tests__/reopenWorktree.test.ts`
- Modify: `__tests__/integration/paneLifecycle.test.ts`

- [ ] **Step 1: Add failing lifecycle integration cases**

Add this concrete focused creation test to `__tests__/usePaneCreation.test.ts`
after the existing single-save test. Extend the harness to accept a
`persistPaneLayout` mock and add that callback to `usePaneCreation`'s
parameters in the implementation:

```ts
it('persists a newly created pane as an adaptive sibling of the focused pane', async () => {
  createPaneMock.mockResolvedValue({
    pane: pane('psyche-2'),
    needsAgentChoice: false,
  });
  const persistPaneLayout = vi.fn(async () => {});
  const h = harness([pane('psyche-1')], {
    focusedPaneId: 'psyche-1',
    persistPaneLayout,
  });

  await h.api.createNewPane('Fix auth', 'claude');

  expect(persistPaneLayout).toHaveBeenCalledWith(
    [pane('psyche-1'), pane('psyche-2')],
    {
      kind: 'insert',
      paneId: 'psyche-2',
      targetPaneId: 'psyche-1',
      direction: 'horizontal',
    },
  );
});
```

Add this test to `__tests__/integration/paneLifecycle.test.ts` beside the
existing tmux split tests; mock `applyStoredPaneLayout` in the same module
mock block as the current layout manager:

```ts
it('removes a closed pane from the layout only after tmux close succeeds', async () => {
  applyStoredPaneLayoutMock.mockRejectedValueOnce(
    new Error('tmux rejected pane layout'),
  );
  const paneToClose = {
    id: 'psyche-1',
    slug: 'lane',
    prompt: '',
    paneId: '%1',
  } as PsychePane;

  await expect(closePane(paneToClose, context)).rejects.toThrow(
    'tmux rejected pane layout',
  );
  expect(applyStoredPaneLayoutMock).toHaveBeenCalledWith(
    expect.objectContaining({
      mutation: { kind: 'remove', paneId: 'psyche-1' },
    }),
  );
});
```

- [ ] **Step 2: Run the focused lifecycle tests to verify they fail**

Run: `pnpm vitest --run __tests__/usePaneCreation.test.ts __tests__/reopenWorktree.test.ts __tests__/integration/paneLifecycle.test.ts`

Expected: FAIL because lifecycle paths still invoke `recalculateAndApplyLayout`
or append shell metadata without an insert mutation.

- [ ] **Step 3: Capture the correct insertion target and adaptive direction**

In `PsycheApp.tsx`, expose the focused content pane through the existing
`focusedPaneId` state and pass its logical Psyche ID to pane-creation callbacks.
When focus is on the control pane, fall back to `panes[selectedIndex]`; when
there is no selected content pane, use the first visible layout leaf. Add an
`adaptiveSplitDirection` helper in `PaneLayoutController.ts` that reads the
focused pane's tmux width and height: return `'horizontal'` when height is
greater than or equal to width, otherwise return `'vertical'`.

- [ ] **Step 4: Replace creation and reopen grid reflows**

Remove each `recalculateAndApplyLayout` call in `paneCreation.ts`,
`attachAgent.ts`, and `reopenWorktree.ts`. Have their callers invoke
`applyStoredPaneLayout` after the new `PsychePane` is created and before its
updated pane array is persisted. Use an `insert` mutation with the captured
target and adaptive direction. Preserve the existing tmux split for process
creation; the controller immediately projects it into the persistent topology.

- [ ] **Step 5: Integrate terminal, ritual, and external-shell creation**

Update `usePaneCreation.ts`, `PsycheApp.tsx`'s
`createTerminalPaneForRitual`, and `useInputHandling.ts`'s `t` shortcut to
pass the same target metadata to the layout controller. Update
`detectAndAddShellPanes` to accept the resolved target ID, create each shell
entry, then apply one `insert` mutation per discovered shell. If the target is
stale, refresh tmux IDs, set the existing status message, and do not write the
new layout.

- [ ] **Step 6: Integrate close, manual exit, restore, and empty-workspace paths**

Replace the close-action call to `recalculateAndApplyLayout` with
`applyStoredPaneLayout({ mutation: { kind: 'remove', paneId: pane.id } })`.
Replace `usePaneLoading`'s killed-pane recovery reflow with `reconcile`.
Replace the post-cleanup call with an empty-tree reconciliation that retains
only the fixed sidebar/welcome-pane behavior. Ensure a manually exited shell is
pruned by `reconcile` without changing unrelated branches. Update
`enforceControlPaneSize` call sites so they only resize the sidebar; none may
trigger a hidden automatic-grid projection.

- [ ] **Step 7: Run lifecycle tests**

Run: `pnpm vitest --run __tests__/usePaneCreation.test.ts __tests__/reopenWorktree.test.ts __tests__/integration/paneLifecycle.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit lifecycle wiring**

```bash
git add src/utils/paneCreation.ts src/utils/attachAgent.ts src/utils/reopenWorktree.ts src/hooks/usePaneCreation.ts src/PsycheApp.tsx src/hooks/useInputHandling.ts src/hooks/useShellDetection.ts src/actions/implementations/closeAction.ts src/hooks/usePaneLoading.ts src/utils/postPaneCleanup.ts __tests__/usePaneCreation.test.ts __tests__/reopenWorktree.test.ts __tests__/integration/paneLifecycle.test.ts
git commit -m "feat: place all panes in persistent split layout"
```

### Task 5: Remove shell cards from the sidebar and verify the feature

**Files:**
- Modify: `src/components/panes/PanesGrid.tsx:141-226`
- Create: `__tests__/panesGrid.test.tsx`
- Modify: `__tests__/covenSessionsPanel.test.tsx`
- Modify: `README.md:102-114`

- [ ] **Step 1: Write the failing sidebar test**

```tsx
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import PanesGrid from '../src/components/panes/PanesGrid.js';
import { createShellPane, createWorktreePane } from './fixtures/mockPanes.js';

describe('PanesGrid', () => {
  it('does not render shell cards while preserving worktree navigation', () => {
    const { lastFrame } = render(
      <PanesGrid
        panes={[
          createWorktreePane({ id: 'psyche-1', slug: 'agent-lane' }),
          createShellPane({ id: 'psyche-2', slug: 'shell-4' }),
        ]}
        selectedIndex={0}
        isLoading={false}
        themeName="green"
        projectThemeByRoot={new Map()}
        sidebarProjects={[]}
        fallbackProjectRoot="/repo"
        fallbackProjectName="repo"
      />
    );

    const output = stripAnsi(lastFrame() ?? '');
    expect(output).toContain('agent-lane');
    expect(output).not.toContain('shell-4');
  });
});
```

- [ ] **Step 2: Run the sidebar test to verify it fails**

Run: `pnpm vitest --run __tests__/panesGrid.test.tsx`

Expected: FAIL because `PanesGrid` currently renders every entry in
`group.panes`, including shells.

- [ ] **Step 3: Filter sidebar card rows without changing workspace metadata**

In `PanesGrid.tsx`, derive `navigationPanes` from each project group with:

```ts
const navigationPanes = group.panes.filter((entry) => entry.pane.type !== 'shell');
```

Render `navigationPanes` in place of `group.panes`. Keep the original `panes`
prop for project actions, focus synchronization, session status, and all tmux
workspace behavior; only sidebar card rendering changes.

- [ ] **Step 4: Document the workspace behavior**

Replace the README pane-visibility bullet with:

```md
- **Persistent pane layouts** — agent and shell panes share a Warp-like split
  workspace; creating, hiding, restoring, and resizing panes preserves the
  arrangement instead of rebalancing it into a grid.
```

- [ ] **Step 5: Run final focused validation**

Run:

```bash
pnpm vitest --run __tests__/paneLayoutTree.test.ts __tests__/paneLayoutCompiler.test.ts __tests__/paneLayoutController.test.ts __tests__/layout.test.ts __tests__/panesGrid.test.tsx __tests__/usePaneCreation.test.ts __tests__/paneVisibility.test.ts __tests__/reopenWorktree.test.ts __tests__/integration/paneLifecycle.test.ts
pnpm typecheck
```

Expected: all targeted suites and typecheck pass. The repository-wide suite
still has the documented local baseline failures in
`appStoreConnect.test.ts` (pnpm version) and `releaseWorkflow.test.ts` (GNU
`stat` flags) until those environment assumptions are addressed separately.

- [ ] **Step 6: Commit the UI and documentation**

```bash
git add src/components/panes/PanesGrid.tsx __tests__/panesGrid.test.tsx __tests__/covenSessionsPanel.test.tsx README.md
git commit -m "feat: show shells only in pane workspace"
```
