import type { PaneLayout, PaneSplitDirection, PsychePane } from '../types.js';
import { compileSidebarPaneLayout } from './PaneLayoutCompiler.js';
import {
  insertPane,
  listLeafPaneIds,
  prunePaneLayout,
  removePane,
  seedPaneLayout,
  visiblePaneLayout,
} from './PaneLayoutTree.js';

const SIDEBAR_WIDTH = 40;

export type PaneLayoutMutation =
  | { kind: 'insert'; paneId: string; targetPaneId: string; direction: PaneSplitDirection }
  | { kind: 'remove'; paneId: string }
  | { kind: 'reconcile' };

export interface ApplyPaneLayoutMutationOptions {
  paneLayout: PaneLayout | undefined;
  panes: Pick<PsychePane, 'id' | 'paneId' | 'hidden'>[];
  controlPaneId: string;
  terminalWidth: number;
  terminalHeight: number;
  mutation: PaneLayoutMutation;
  selectLayout: (layout: string) => boolean | Promise<boolean>;
}

function paneMap(
  panes: ApplyPaneLayoutMutationOptions['panes']
): Map<string, string> {
  const panesById = new Map<string, string>();

  for (const pane of panes) {
    if (panesById.has(pane.id)) {
      throw new Error(`Pane metadata contains duplicate pane ID ${pane.id}`);
    }
    panesById.set(pane.id, pane.paneId);
  }

  return panesById;
}

function validateLayoutPaneIds(layout: PaneLayout): void {
  const paneIds = listLeafPaneIds(layout.root);
  const seenPaneIds = new Set<string>();

  for (const paneId of paneIds) {
    if (seenPaneIds.has(paneId)) {
      throw new Error(`Pane layout contains duplicate pane ID ${paneId}`);
    }
    seenPaneIds.add(paneId);
  }
}

function seedLayoutForMutation(
  panes: ApplyPaneLayoutMutationOptions['panes'],
  mutation: PaneLayoutMutation
): PaneLayout {
  const paneIds = mutation.kind === 'insert'
    ? panes.filter((pane) => pane.id !== mutation.paneId).map((pane) => pane.id)
    : panes.map((pane) => pane.id);

  return seedPaneLayout(paneIds);
}

function applyMutation(
  layout: PaneLayout,
  mutation: PaneLayoutMutation,
  knownPaneIds: ReadonlySet<string>
): PaneLayout {
  switch (mutation.kind) {
    case 'insert':
      if (!knownPaneIds.has(mutation.paneId)) {
        throw new Error(`Pane metadata does not contain pane ID ${mutation.paneId}`);
      }
      return insertPane(layout, mutation.targetPaneId, mutation.paneId, mutation.direction);
    case 'remove':
      return removePane(layout, mutation.paneId);
    case 'reconcile':
      return prunePaneLayout(layout, knownPaneIds);
  }
}

export async function applyPaneLayoutMutation(
  options: ApplyPaneLayoutMutationOptions
): Promise<{ layout: PaneLayout }> {
  const panesById = paneMap(options.panes);
  const baseLayout = options.paneLayout ?? seedLayoutForMutation(options.panes, options.mutation);
  validateLayoutPaneIds(baseLayout);

  const layout = applyMutation(baseLayout, options.mutation, new Set(panesById.keys()));
  const hiddenPaneIds = new Set(
    options.panes.filter((pane) => pane.hidden).map((pane) => pane.id)
  );
  const projectedRoot = visiblePaneLayout(layout, hiddenPaneIds);
  const compiledLayout = compileSidebarPaneLayout({
    controlPaneId: options.controlPaneId,
    root: projectedRoot,
    panes: panesById,
    sidebarWidth: SIDEBAR_WIDTH,
    windowWidth: options.terminalWidth,
    windowHeight: options.terminalHeight,
  });

  const accepted = await options.selectLayout(compiledLayout);
  if (!accepted) {
    throw new Error('tmux rejected pane layout');
  }

  return { layout };
}
