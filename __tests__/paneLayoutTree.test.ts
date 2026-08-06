import { describe, expect, it } from 'vitest';
import {
  insertPane,
  listLeafPaneIds,
  prunePaneLayout,
  removePane,
  seedPaneLayout,
  visiblePaneLayout,
} from '../src/layout/PaneLayoutTree.js';

describe('PaneLayoutTree', () => {
  it('rejects duplicate pane IDs when seeding a layout', () => {
    expect(() => seedPaneLayout(['psyche-1', 'psyche-1'])).toThrow(
      'Pane layout cannot contain duplicate pane ID psyche-1'
    );
  });

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

  it('prunes missing panes and collapses the remaining visible tree', () => {
    const layout = seedPaneLayout(['psyche-1', 'psyche-2', 'psyche-3']);
    const pruned = prunePaneLayout(layout, new Set(['psyche-1', 'psyche-3']));

    expect(pruned).toEqual({
      version: 1,
      root: {
        kind: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { kind: 'leaf', paneId: 'psyche-1' },
        second: { kind: 'leaf', paneId: 'psyche-3' },
      },
    });
  });
});
