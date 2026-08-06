import { describe, expect, it, vi } from 'vitest';
import type { PaneLayout, PsychePane } from '../src/types.js';
import { applyPaneLayoutMutation } from '../src/layout/PaneLayoutController.js';

function pane(
  id: string,
  paneId: string,
  hidden = false
): Pick<PsychePane, 'id' | 'paneId' | 'hidden'> {
  return { id, paneId, hidden };
}

const dimensions = {
  controlPaneId: '%0',
  terminalWidth: 201,
  terminalHeight: 60,
};

describe('applyPaneLayoutMutation', () => {
  it('seeds absent topology without the inserted pane, then inserts it once', async () => {
    const selectLayout = vi.fn((_layout: string) => true);

    const result = await applyPaneLayoutMutation({
      ...dimensions,
      paneLayout: undefined,
      panes: [pane('psyche-1', '%1'), pane('psyche-2', '%2')],
      mutation: {
        kind: 'insert',
        paneId: 'psyche-2',
        targetPaneId: 'psyche-1',
        direction: 'horizontal',
      },
      selectLayout,
    });

    expect(selectLayout).toHaveBeenCalledTimes(1);
    expect(result.layout).toEqual({
      version: 1,
      root: {
        kind: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { kind: 'leaf', paneId: 'psyche-1' },
        second: { kind: 'leaf', paneId: 'psyche-2' },
      },
    });
  });

  it('rejects without returning a changed layout when tmux rejects the projection', async () => {
    const paneLayout: PaneLayout = {
      version: 1,
      root: { kind: 'leaf', paneId: 'psyche-1' },
    };

    await expect(applyPaneLayoutMutation({
      ...dimensions,
      paneLayout,
      panes: [pane('psyche-1', '%1')],
      mutation: { kind: 'reconcile' },
      selectLayout: () => false,
    })).rejects.toThrow('tmux rejected pane layout');

    expect(paneLayout).toEqual({
      version: 1,
      root: { kind: 'leaf', paneId: 'psyche-1' },
    });
  });

  it('prunes unknown leaves while excluding hidden panes only from the tmux projection', async () => {
    const selectLayout = vi.fn((_layout: string) => true);
    const paneLayout: PaneLayout = {
      version: 1,
      root: {
        kind: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: {
          kind: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { kind: 'leaf', paneId: 'psyche-1' },
          second: { kind: 'leaf', paneId: 'closed-pane' },
        },
        second: { kind: 'leaf', paneId: 'psyche-2' },
      },
    };

    const result = await applyPaneLayoutMutation({
      ...dimensions,
      paneLayout,
      panes: [pane('psyche-1', '%1'), pane('psyche-2', '%2', true)],
      mutation: { kind: 'reconcile' },
      selectLayout,
    });

    expect(result.layout).toEqual({
      version: 1,
      root: {
        kind: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { kind: 'leaf', paneId: 'psyche-1' },
        second: { kind: 'leaf', paneId: 'psyche-2' },
      },
    });
    const [projectedLayout] = selectLayout.mock.calls[0];
    expect(projectedLayout).toMatch(/,1}$/);
    expect(projectedLayout).not.toMatch(/,2}$/);
  });

  it('surfaces duplicate IDs and missing insertion targets', async () => {
    await expect(applyPaneLayoutMutation({
      ...dimensions,
      paneLayout: {
        version: 1,
        root: {
          kind: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { kind: 'leaf', paneId: 'psyche-1' },
          second: { kind: 'leaf', paneId: 'psyche-2' },
        },
      },
      panes: [pane('psyche-1', '%1'), pane('psyche-2', '%2')],
      mutation: {
        kind: 'insert',
        paneId: 'psyche-1',
        targetPaneId: 'psyche-2',
        direction: 'vertical',
      },
      selectLayout: () => true,
    })).rejects.toThrow('already contains pane ID psyche-1');

    await expect(applyPaneLayoutMutation({
      ...dimensions,
      paneLayout: undefined,
      panes: [pane('psyche-1', '%1'), pane('psyche-2', '%2')],
      mutation: {
        kind: 'insert',
        paneId: 'psyche-2',
        targetPaneId: 'missing-pane',
        direction: 'vertical',
      },
      selectLayout: () => true,
    })).rejects.toThrow('does not contain target pane ID missing-pane');
  });
});
