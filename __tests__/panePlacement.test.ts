import { describe, expect, it } from 'vitest';
import type { PaneLayout, PsychePane } from '../src/types.js';

function pane(id: string, paneId: string, hidden = false): PsychePane {
  return {
    id,
    slug: id,
    prompt: id,
    paneId,
    hidden,
  };
}

describe('pane placement', () => {
  it('uses a vertical tree split for a wide focused pane', async () => {
    const { adaptiveSplitDirection } = await import('../src/layout/PanePlacement.js');

    expect(adaptiveSplitDirection({ width: 80, height: 40 })).toBe('vertical');
  });

  it('uses a horizontal tree split for a tall focused pane', async () => {
    const { adaptiveSplitDirection } = await import('../src/layout/PanePlacement.js');

    expect(adaptiveSplitDirection({ width: 40, height: 80 })).toBe('horizontal');
  });

  it('resolves focused content before selected content and visible tree leaves', async () => {
    const { resolvePaneInsertionTarget } = await import('../src/layout/PanePlacement.js');
    const panes = [
      pane('first', '%1'),
      pane('selected', '%2'),
      pane('focused', '%3'),
    ];
    const paneLayout: PaneLayout = {
      version: 1,
      root: {
        kind: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { kind: 'leaf', paneId: 'first' },
        second: {
          kind: 'split',
          direction: 'vertical',
          ratio: 0.5,
          first: { kind: 'leaf', paneId: 'selected' },
          second: { kind: 'leaf', paneId: 'focused' },
        },
      },
    };

    expect(resolvePaneInsertionTarget({
      panes,
      paneLayout,
      focusedTmuxPaneId: '%3',
      selectedPaneId: 'selected',
    })?.id).toBe('focused');
    expect(resolvePaneInsertionTarget({
      panes,
      paneLayout,
      focusedTmuxPaneId: '%missing',
      selectedPaneId: 'selected',
    })?.id).toBe('selected');
    expect(resolvePaneInsertionTarget({
      panes,
      paneLayout,
      selectedPaneId: 'missing',
    })?.id).toBe('first');
  });
});
