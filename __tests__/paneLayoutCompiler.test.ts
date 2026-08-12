import { describe, expect, it } from 'vitest';
import { compileSidebarPaneLayout } from '../src/layout/PaneLayoutCompiler.js';

describe('compileSidebarPaneLayout', () => {
  const panes = new Map([
    ['psyche-1', '%1'],
    ['psyche-2', '%2'],
    ['psyche-3', '%3'],
  ]);

  it('renders a sidebar and horizontal siblings at absolute coordinates', () => {
    const layout = compileSidebarPaneLayout({
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
      windowWidth: 201,
      windowHeight: 60,
    });

    expect(layout).toMatch(/^[0-9a-f]{4},201x60,0,0\{/);
    expect(layout).toContain('40x60,0,0,0');
    expect(layout).toContain(',41,0,1');
    expect(layout).toContain(',121,0,2');
  });

  it('renders vertical descendants and gives the last child the rounding remainder', () => {
    const layout = compileSidebarPaneLayout({
      controlPaneId: '%0',
      root: {
        kind: 'split',
        direction: 'vertical',
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
      panes,
      sidebarWidth: 40,
      windowWidth: 201,
      windowHeight: 61,
    });

    expect(layout).toContain(',41,0,1');
    expect(layout).toContain(',41,31,2');
    expect(layout).toContain(',121,31,3');
  });

  it('throws a clear error for a missing logical pane binding', () => {
    expect(() => compileSidebarPaneLayout({
      controlPaneId: '%0',
      root: { kind: 'leaf', paneId: 'missing' },
      panes,
      sidebarWidth: 40,
      windowWidth: 120,
      windowHeight: 40,
    })).toThrow('missing tmux pane binding for missing');
  });

  it('renders a valid sidebar-only layout when the visible tree is empty', () => {
    const layout = compileSidebarPaneLayout({
      controlPaneId: '%0',
      root: null,
      panes,
      sidebarWidth: 40,
      windowWidth: 201,
      windowHeight: 60,
    });

    expect(layout).toMatch(/^[0-9a-f]{4},201x60,0,0,0$/);
  });

  it('produces deterministic output with a four-character checksum', () => {
    const options = {
      controlPaneId: '%0',
      root: {
        kind: 'leaf' as const,
        paneId: 'psyche-1',
      },
      panes,
      sidebarWidth: 40,
      windowWidth: 201,
      windowHeight: 60,
    };

    const first = compileSidebarPaneLayout(options);
    const second = compileSidebarPaneLayout(options);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{4},/);
  });
});
