import { describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';
import { applyPaneLayoutMutation } from '../src/layout/PaneLayoutController.js';
import { seedPaneLayout } from '../src/layout/PaneLayoutTree.js';
import {
  getBulkVisibilityAction,
  getProjectVisibilityAction,
  getVisiblePanes,
  partitionPanesByProject,
  syncHiddenStateFromCurrentWindow,
} from '../src/utils/paneVisibility.js';

function pane(id: string, hidden = false, projectRoot = '/repo-a'): PsychePane {
  return {
    id,
    slug: `pane-${id}`,
    prompt: `prompt-${id}`,
    paneId: `%${id.replace('psyche-', '')}`,
    hidden,
    projectRoot,
  };
}

describe('paneVisibility', () => {
  it('syncs hidden flags from the active window pane list', () => {
    const panes = [
      pane('psyche-1', true),
      pane('psyche-2', false),
      pane('psyche-3', false),
    ];

    const synced = syncHiddenStateFromCurrentWindow(panes, ['%2']);

    expect(synced.map((entry) => entry.hidden)).toEqual([true, false, true]);
  });

  it('preserves hidden flags when no current window pane list is available', () => {
    const panes = [
      pane('psyche-1', true),
      pane('psyche-2', false),
    ];

    const synced = syncHiddenStateFromCurrentWindow(panes, []);

    expect(synced).toEqual(panes);
  });

  it('chooses hide-others when any other pane is visible', () => {
    const panes = [
      pane('psyche-1', false),
      pane('psyche-2', false),
      pane('psyche-3', true),
    ];

    expect(getBulkVisibilityAction(panes, panes[0])).toBe('hide-others');
  });

  it('chooses show-others when all other panes are hidden', () => {
    const panes = [
      pane('psyche-1', false),
      pane('psyche-2', true),
      pane('psyche-3', true),
    ];

    expect(getBulkVisibilityAction(panes, panes[0])).toBe('show-others');
  });

  it('returns only visible panes', () => {
    const panes = [
      pane('psyche-1', false),
      pane('psyche-2', true),
      pane('psyche-3', false),
    ];

    expect(getVisiblePanes(panes).map((entry) => entry.id)).toEqual([
      'psyche-1',
      'psyche-3',
    ]);
  });

  it('keeps hidden panes in topology and restores their original sibling position when unhidden', async () => {
    const paneLayout = seedPaneLayout(['psyche-1', 'psyche-2', 'psyche-3']);
    const hiddenPanes = [
      pane('psyche-1'),
      pane('psyche-2', true),
      pane('psyche-3'),
    ];
    const hiddenSelectLayout = vi.fn((_layout: string) => true);

    const hiddenResult = await applyPaneLayoutMutation({
      paneLayout,
      panes: hiddenPanes,
      controlPaneId: '%0',
      terminalWidth: 201,
      terminalHeight: 60,
      mutation: { kind: 'reconcile' },
      selectLayout: hiddenSelectLayout,
    });

    expect(hiddenResult.layout).toEqual(paneLayout);
    expect(hiddenSelectLayout.mock.calls[0][0]).not.toMatch(/,2,/);

    const visibleSelectLayout = vi.fn((_layout: string) => true);
    const visibleResult = await applyPaneLayoutMutation({
      paneLayout: hiddenResult.layout,
      panes: hiddenPanes.map((entry) => ({ ...entry, hidden: false })),
      controlPaneId: '%0',
      terminalWidth: 201,
      terminalHeight: 60,
      mutation: { kind: 'reconcile' },
      selectLayout: visibleSelectLayout,
    });

    expect(visibleResult.layout).toEqual(paneLayout);
    expect(visibleSelectLayout.mock.calls[0][0]).toMatch(/,2,/);
  });

  it('partitions panes by project root', () => {
    const panes = [
      pane('psyche-1', false, '/repo-a'),
      pane('psyche-2', true, '/repo-a'),
      pane('psyche-3', false, '/repo-b'),
    ];

    const { projectPanes, otherPanes } = partitionPanesByProject(
      panes,
      '/repo-a',
      '/fallback'
    );

    expect(projectPanes.map((entry) => entry.id)).toEqual(['psyche-1', 'psyche-2']);
    expect(otherPanes.map((entry) => entry.id)).toEqual(['psyche-3']);
  });

  it('chooses focus-project when other projects are still visible', () => {
    const panes = [
      pane('psyche-1', false, '/repo-a'),
      pane('psyche-2', false, '/repo-a'),
      pane('psyche-3', false, '/repo-b'),
    ];

    expect(getProjectVisibilityAction(panes, '/repo-a', '/fallback')).toBe('focus-project');
  });

  it('chooses focus-project when selected project has hidden panes', () => {
    const panes = [
      pane('psyche-1', false, '/repo-a'),
      pane('psyche-2', true, '/repo-a'),
      pane('psyche-3', true, '/repo-b'),
    ];

    expect(getProjectVisibilityAction(panes, '/repo-a', '/fallback')).toBe('focus-project');
  });

  it('chooses show-all when the selected project is already focused', () => {
    const panes = [
      pane('psyche-1', false, '/repo-a'),
      pane('psyche-2', false, '/repo-a'),
      pane('psyche-3', true, '/repo-b'),
    ];

    expect(getProjectVisibilityAction(panes, '/repo-a', '/fallback')).toBe('show-all');
  });
});
