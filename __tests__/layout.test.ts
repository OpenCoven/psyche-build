import { describe, expect, it } from 'vitest';
import { compileSidebarPaneLayout } from '../src/layout/PaneLayoutCompiler.js';

const panes = new Map([
  ['psyche-1', '%1'],
  ['psyche-2', '%2'],
  ['psyche-3', '%3'],
]);

function horizontalPair(windowWidth = 201, windowHeight = 60): string {
  return compileSidebarPaneLayout({
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
    windowWidth,
    windowHeight,
  });
}

describe('tmux pane layout compilation', () => {
  it('generates a four-character hexadecimal checksum', () => {
    const layout = horizontalPair();

    expect(layout).toMatch(/^[0-9a-f]{4},/);
  });

  it('keeps sidebar and content coordinates absolute', () => {
    const layout = horizontalPair();

    expect(layout).toContain('40x60,0,0,0');
    expect(layout).toContain(',41,0,1');
    expect(layout).toContain(',121,0,2');
  });

  it('gives the final child the remainder after a split border', () => {
    const layout = horizontalPair();

    expect(layout).toContain('79x60,41,0,1');
    expect(layout).toContain('80x60,121,0,2');
  });

  it('is deterministic for an identical pane tree and window size', () => {
    expect(horizontalPair()).toBe(horizontalPair());
  });
});
