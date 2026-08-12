# Side Panel Chevron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a discoverable chevron that toggles Psyche's existing left side panel between its full panel and compact rail.

**Architecture:** `PanesGrid` renders a dedicated first-row collapse control while `SidePanelRail` renders the matching expand glyph. `useInputHandling` treats only that expanded-row coordinate as the new mouse toggle target and offsets all existing sidebar row hit tests, preserving current card and action behavior.

**Tech Stack:** TypeScript, React/Ink, Vitest, ink-testing-library.

---

### Task 1: Render and handle the side-panel chevron

**Files:**
- Modify: `src/PsycheApp.tsx:139-147,1900-1919`
- Modify: `src/components/panes/PanesGrid.tsx:46-226`
- Modify: `src/hooks/useInputHandling.ts:1043-1085`
- Modify: `__tests__/useInputHandling.sidePanelToggle.test.tsx`
- Create: `__tests__/panesGrid.test.tsx`

- [ ] **Step 1: Write the failing rendering and input tests**

Create `__tests__/panesGrid.test.tsx` with this focused expanded-control test:

```tsx
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import PanesGrid from '../src/components/panes/PanesGrid.js';

describe('PanesGrid', () => {
  it('renders a collapse chevron before sidebar content', () => {
    const { lastFrame } = render(
      <PanesGrid
        panes={[]}
        selectedIndex={0}
        isLoading={false}
        themeName="green"
        projectThemeByRoot={new Map()}
        sidebarProjects={[]}
        fallbackProjectRoot="/repo"
        fallbackProjectName="repo"
        showCollapseControl
      />,
    );

    expect(stripAnsi(lastFrame() ?? '').split('\n')[0]).toContain('‹');
  });
});
```

Add these cases to `__tests__/useInputHandling.sidePanelToggle.test.tsx`:

```tsx
it('toggles the expanded panel only when its chevron cell is clicked', async () => {
  const onToggleSidePanel = vi.fn();
  const { stdin, unmount } = render(
    <Harness onToggleSidePanel={onToggleSidePanel} sidePanelWidth={40} />,
  );

  await sleep(20);
  stdin.write('\x1b[<0;40;1M');
  await sleep(40);

  expect(onToggleSidePanel).toHaveBeenCalledTimes(1);
  unmount();
});

it('does not toggle the expanded panel when a non-chevron sidebar cell is clicked', async () => {
  const onToggleSidePanel = vi.fn();
  const { stdin, unmount } = render(
    <Harness onToggleSidePanel={onToggleSidePanel} sidePanelWidth={40} />,
  );

  await sleep(20);
  stdin.write('\x1b[<0;1;1M');
  await sleep(40);

  expect(onToggleSidePanel).not.toHaveBeenCalled();
  unmount();
});
```

Extend `Harness` with an optional `sidePanelWidth = 40` prop and pass it into
the `useInputHandling` parameter object.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
pnpm vitest --run __tests__/panesGrid.test.tsx __tests__/useInputHandling.sidePanelToggle.test.tsx
```

Expected: FAIL because `PanesGrid` does not accept `showCollapseControl` and
expanded-panel chevron clicks are not recognized.

- [ ] **Step 3: Render matching control glyphs**

Add optional `showCollapseControl?: boolean` to `PanesGridProps`. At the top
of the existing column, render a full-width, right-aligned chevron row only
when it is true:

```tsx
{showCollapseControl && (
  <Box width={HEADER_WIDTH} justifyContent="flex-end">
    <Text color={COLORS.accent}>‹</Text>
  </Box>
)}
```

Pass `showCollapseControl` from `PsycheApp` whenever the full `PanesGrid`
branch renders. Keep the collapsed `SidePanelRail` at width four and replace
its existing `›` literal with a named `SIDE_PANEL_EXPAND_GLYPH` constant
exported from `src/utils/sidePanel.ts`; export
`SIDE_PANEL_COLLAPSE_GLYPH = '‹'` alongside it and use that constant in
`PanesGrid`.

- [ ] **Step 4: Restrict mouse toggling to the new expanded control**

In `handleSidebarMousePress`, retain the current entire-rail expansion branch:

```ts
if (onToggleSidePanel && sidePanelCollapsed
  && mouseEvent.column <= SIDE_PANEL_COLLAPSED_WIDTH) {
  onToggleSidePanel();
  return true;
}
```

Add the expanded control branch:

```ts
if (onToggleSidePanel && !sidePanelCollapsed
  && mouseEvent.row === 1
  && mouseEvent.column === sidePanelWidth) {
  onToggleSidePanel();
  return true;
}
```

Because the full-panel chevron adds one rendered row, call
`resolveSidebarMouseTarget` with `mouseEvent.row - 1` whenever the panel is
expanded. Return early for non-positive adjusted rows. Keep the `z` shortcut
unchanged.

- [ ] **Step 5: Run focused tests to verify they pass**

Run:

```bash
pnpm vitest --run __tests__/panesGrid.test.tsx __tests__/useInputHandling.sidePanelToggle.test.tsx
pnpm typecheck
```

Expected: both suites and typecheck pass; existing compact-rail click and `z`
shortcut cases remain green.

- [ ] **Step 6: Commit the feature**

```bash
git add src/PsycheApp.tsx src/components/panes/PanesGrid.tsx src/hooks/useInputHandling.ts src/utils/sidePanel.ts __tests__/panesGrid.test.tsx __tests__/useInputHandling.sidePanelToggle.test.tsx
git commit -m "feat: add side panel collapse chevron" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
