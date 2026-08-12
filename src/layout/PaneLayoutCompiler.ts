import type { PaneLayoutNode } from '../types.js';

export interface CompileSidebarPaneLayoutOptions {
  controlPaneId: string;
  root: PaneLayoutNode | null;
  panes: ReadonlyMap<string, string>;
  sidebarWidth: number;
  windowWidth: number;
  windowHeight: number;
}

function calculateLayoutChecksum(layout: string): string {
  let checksum = 0;

  for (let index = 0; index < layout.length; index += 1) {
    checksum = (checksum >> 1) + ((checksum & 1) << 15);
    checksum += layout.charCodeAt(index);
    checksum &= 0xFFFF;
  }

  return checksum.toString(16).padStart(4, '0');
}

function renderNode(
  node: PaneLayoutNode,
  panes: ReadonlyMap<string, string>,
  x: number,
  y: number,
  width: number,
  height: number
): string {
  if (node.kind === 'leaf') {
    const paneId = panes.get(node.paneId);
    if (!paneId) {
      throw new Error(`missing tmux pane binding for ${node.paneId}`);
    }

    return `${width}x${height},${x},${y},${paneId.replace(/^%/, '')}`;
  }

  if (node.direction === 'horizontal') {
    const firstWidth = Math.floor((width - 1) * node.ratio);
    const secondWidth = width - firstWidth - 1;
    const first = renderNode(node.first, panes, x, y, firstWidth, height);
    const second = renderNode(node.second, panes, x + firstWidth + 1, y, secondWidth, height);
    return `${width}x${height},${x},${y}{${first},${second}}`;
  }

  const firstHeight = Math.floor((height - 1) * node.ratio);
  const secondHeight = height - firstHeight - 1;
  const first = renderNode(node.first, panes, x, y, width, firstHeight);
  const second = renderNode(node.second, panes, x, y + firstHeight + 1, width, secondHeight);
  return `${width}x${height},${x},${y}[${first},${second}]`;
}

export function compileSidebarPaneLayout(options: CompileSidebarPaneLayoutOptions): string {
  const sidebarPaneId = options.controlPaneId.replace(/^%/, '');

  if (!options.root) {
    const body = `${options.windowWidth}x${options.windowHeight},0,0,${sidebarPaneId}`;
    return `${calculateLayoutChecksum(body)},${body}`;
  }

  const contentWidth = options.windowWidth - options.sidebarWidth - 1;
  const contentX = options.sidebarWidth + 1;
  const sidebar = `${options.sidebarWidth}x${options.windowHeight},0,0,${sidebarPaneId}`;
  const content = renderNode(
    options.root,
    options.panes,
    contentX,
    0,
    contentWidth,
    options.windowHeight
  );
  const body = `${options.windowWidth}x${options.windowHeight},0,0{${sidebar},${content}}`;

  return `${calculateLayoutChecksum(body)},${body}`;
}
