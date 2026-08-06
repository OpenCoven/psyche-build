import type { PaneLayout, PaneSplitDirection, PsychePane } from '../types.js';
import { listLeafPaneIds } from './PaneLayoutTree.js';

export interface PaneDimensions {
  width: number;
  height: number;
}

export interface ResolvePaneInsertionTargetOptions {
  panes: readonly PsychePane[];
  paneLayout?: PaneLayout;
  focusedTmuxPaneId?: string | null;
  selectedPaneId?: string;
}

export function adaptiveSplitDirection(
  dimensions: PaneDimensions
): PaneSplitDirection {
  return dimensions.height >= dimensions.width ? 'horizontal' : 'vertical';
}

export function resolvePaneInsertionTarget(
  options: ResolvePaneInsertionTargetOptions
): PsychePane | undefined {
  const visiblePanes = options.panes.filter((pane) => !pane.hidden);

  const focusedPane = visiblePanes.find(
    (pane) => pane.paneId === options.focusedTmuxPaneId
  );
  if (focusedPane) {
    return focusedPane;
  }

  const selectedPane = visiblePanes.find(
    (pane) => pane.id === options.selectedPaneId
  );
  if (selectedPane) {
    return selectedPane;
  }

  const panesById = new Map(visiblePanes.map((pane) => [pane.id, pane]));
  for (const paneId of listLeafPaneIds(options.paneLayout?.root ?? null)) {
    const pane = panesById.get(paneId);
    if (pane) {
      return pane;
    }
  }

  return undefined;
}
