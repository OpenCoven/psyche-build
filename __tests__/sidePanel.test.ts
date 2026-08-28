import { describe, expect, it } from 'vitest';

describe('side panel responsive helpers', () => {
  it('uses a compact rail width when the side panel is collapsed', async () => {
    const sidePanel = await import('../src/utils/sidePanel.js');

    expect(sidePanel.getSidePanelWidth(true)).toBe(4);
    expect(sidePanel.getSidePanelWidth(false)).toBe(40);
  });

  it('starts collapsed for narrow mobile-sized terminals', async () => {
    const sidePanel = await import('../src/utils/sidePanel.js');

    expect(sidePanel.shouldUseCompactSidePanel(89)).toBe(true);
    expect(sidePanel.shouldUseCompactSidePanel(139)).toBe(true);
    expect(sidePanel.shouldUseCompactSidePanel(140)).toBe(false);
  });

  it('does not auto-collapse narrow terminals after a manual side panel override', async () => {
    const sidePanel = await import('../src/utils/sidePanel.js');

    expect(sidePanel.shouldAutoCollapseSidePanel(89, false)).toBe(true);
    expect(sidePanel.shouldAutoCollapseSidePanel(89, true)).toBe(false);
  });
});

describe('side panel layout width resolution', () => {
  it('measures the tmux window rather than the sidebar pane', async () => {
    const sidePanel = await import('../src/utils/sidePanel.js');

    // stdout reports the sidebar pane (40 wide) inside a 200-wide window.
    expect(sidePanel.resolveSidePanelLayoutWidth(200, 40)).toBe(200);
    expect(sidePanel.shouldUseCompactSidePanel(sidePanel.resolveSidePanelLayoutWidth(200, 40))).toBe(
      false
    );
  });

  it('does not latch collapsed once the rail is the only thing stdout can see', async () => {
    const sidePanel = await import('../src/utils/sidePanel.js');

    // The regression: collapsed rail is 4 columns, so measuring stdout kept the
    // panel below the 140 breakpoint forever, at any window size.
    const collapsedRail = sidePanel.SIDE_PANEL_COLLAPSED_WIDTH;
    expect(sidePanel.shouldUseCompactSidePanel(collapsedRail)).toBe(true);

    const resolved = sidePanel.resolveSidePanelLayoutWidth(200, collapsedRail);
    expect(resolved).toBe(200);
    expect(sidePanel.shouldUseCompactSidePanel(resolved)).toBe(false);
  });

  it('still collapses when the window itself is genuinely narrow', async () => {
    const sidePanel = await import('../src/utils/sidePanel.js');

    const resolved = sidePanel.resolveSidePanelLayoutWidth(100, 40);
    expect(resolved).toBe(100);
    expect(sidePanel.shouldUseCompactSidePanel(resolved)).toBe(true);
  });

  it('falls back to stdout when no tmux window width is available', async () => {
    const sidePanel = await import('../src/utils/sidePanel.js');

    expect(sidePanel.resolveSidePanelLayoutWidth(null, 200)).toBe(200);
    expect(sidePanel.resolveSidePanelLayoutWidth(undefined, 200)).toBe(200);
    expect(sidePanel.resolveSidePanelLayoutWidth(Number.NaN, 200)).toBe(200);
    expect(sidePanel.resolveSidePanelLayoutWidth(0, 200)).toBe(200);
  });

  it('falls back to a usable default when neither width is known', async () => {
    const sidePanel = await import('../src/utils/sidePanel.js');

    expect(sidePanel.resolveSidePanelLayoutWidth(null, undefined)).toBe(
      sidePanel.SIDE_PANEL_FALLBACK_WIDTH
    );
    expect(sidePanel.resolveSidePanelLayoutWidth(Number.NaN, Number.NaN)).toBe(
      sidePanel.SIDE_PANEL_FALLBACK_WIDTH
    );
  });
});
