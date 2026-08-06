import type { PaneLayout, PaneLayoutNode, PaneSplitDirection } from '../types.js';

function isLeaf(node: PaneLayoutNode): node is { kind: 'leaf'; paneId: string } {
  return node.kind === 'leaf';
}

function splitNode(
  first: PaneLayoutNode,
  second: PaneLayoutNode,
  direction: PaneSplitDirection
): PaneLayoutNode {
  return {
    kind: 'split',
    direction,
    ratio: 0.5,
    first,
    second,
  };
}

function collectLeafIds(node: PaneLayoutNode | null, leafIds: string[]): void {
  if (!node) {
    return;
  }

  if (isLeaf(node)) {
    leafIds.push(node.paneId);
    return;
  }

  collectLeafIds(node.first, leafIds);
  collectLeafIds(node.second, leafIds);
}

function pruneNode(
  node: PaneLayoutNode | null,
  shouldKeepLeaf: (paneId: string) => boolean
): PaneLayoutNode | null {
  if (!node) {
    return null;
  }

  if (isLeaf(node)) {
    return shouldKeepLeaf(node.paneId) ? node : null;
  }

  const first = pruneNode(node.first, shouldKeepLeaf);
  const second = pruneNode(node.second, shouldKeepLeaf);

  if (!first && !second) {
    return null;
  }

  if (!first) {
    return second;
  }

  if (!second) {
    return first;
  }

  if (first === node.first && second === node.second) {
    return node;
  }

  return {
    kind: 'split',
    direction: node.direction,
    ratio: node.ratio,
    first,
    second,
  };
}

export function seedPaneLayout(paneIds: string[]): PaneLayout {
  if (paneIds.length === 0) {
    return { version: 1, root: null };
  }

  let root: PaneLayoutNode = { kind: 'leaf', paneId: paneIds[paneIds.length - 1] };

  for (let index = paneIds.length - 2; index >= 0; index -= 1) {
    root = splitNode({ kind: 'leaf', paneId: paneIds[index] }, root, 'horizontal');
  }

  return { version: 1, root };
}

export function listLeafPaneIds(node: PaneLayoutNode | null): string[] {
  const leafIds: string[] = [];
  collectLeafIds(node, leafIds);
  return leafIds;
}

export function insertPane(
  layout: PaneLayout,
  targetPaneId: string,
  newPaneId: string,
  direction: PaneSplitDirection
): PaneLayout {
  const leafIds = listLeafPaneIds(layout.root);

  if (leafIds.includes(newPaneId)) {
    throw new Error(`Pane layout already contains pane ID ${newPaneId}`);
  }

  if (!leafIds.includes(targetPaneId)) {
    throw new Error(`Pane layout does not contain target pane ID ${targetPaneId}`);
  }

  let inserted = false;

  const insertNode = (node: PaneLayoutNode): PaneLayoutNode => {
    if (isLeaf(node)) {
      if (node.paneId !== targetPaneId) {
        return node;
      }

      inserted = true;
      return splitNode(node, { kind: 'leaf', paneId: newPaneId }, direction);
    }

    const first = insertNode(node.first);
    if (first !== node.first) {
      return {
        kind: 'split',
        direction: node.direction,
        ratio: node.ratio,
        first,
        second: node.second,
      };
    }

    const second = insertNode(node.second);
    if (second !== node.second) {
      return {
        kind: 'split',
        direction: node.direction,
        ratio: node.ratio,
        first: node.first,
        second,
      };
    }

    return node;
  };

  const root = layout.root ? insertNode(layout.root) : null;

  if (!inserted) {
    throw new Error(`Pane layout does not contain target pane ID ${targetPaneId}`);
  }

  return {
    version: layout.version,
    root,
  };
}

export function removePane(layout: PaneLayout, paneId: string): PaneLayout {
  const leafIds = listLeafPaneIds(layout.root);
  if (!leafIds.includes(paneId)) {
    throw new Error(`Pane layout does not contain pane ID ${paneId}`);
  }

  const root = pruneNode(layout.root, (leafPaneId) => leafPaneId !== paneId);

  return {
    version: layout.version,
    root,
  };
}

export function visiblePaneLayout(
  layout: PaneLayout,
  hiddenPaneIds: ReadonlySet<string>
): PaneLayoutNode | null {
  return pruneNode(layout.root, (paneId) => !hiddenPaneIds.has(paneId));
}

export function prunePaneLayout(
  layout: PaneLayout,
  knownPaneIds: ReadonlySet<string>
): PaneLayout {
  return {
    version: layout.version,
    root: pruneNode(layout.root, (paneId) => knownPaneIds.has(paneId)),
  };
}
