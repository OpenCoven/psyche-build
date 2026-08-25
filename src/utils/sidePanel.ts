export const SIDE_PANEL_EXPAND_GLYPH = '›';
export const SIDE_PANEL_COLLAPSE_GLYPH = '‹';
export const SIDE_PANEL_EXPANDED_WIDTH = 40;
export const SIDE_PANEL_COLLAPSED_WIDTH = 4;
export const SIDE_PANEL_MOBILE_BREAKPOINT = 140; // Increased from 100; 40 sidebar + 100 content = readable minimum
export const SIDE_PANEL_FALLBACK_WIDTH = 80;

export function getSidePanelWidth(collapsed: boolean): number {
  return collapsed ? SIDE_PANEL_COLLAPSED_WIDTH : SIDE_PANEL_EXPANDED_WIDTH;
}

export function shouldUseCompactSidePanel(terminalWidth: number): boolean {
  return Number.isFinite(terminalWidth) && terminalWidth < SIDE_PANEL_MOBILE_BREAKPOINT;
}

/**
 * Picks the width the responsive breakpoint should be measured against.
 *
 * The breakpoint is a whole-window figure (40 sidebar + 100 content), but psyche
 * renders inside its own tmux pane, so `process.stdout.columns` reports the
 * sidebar's width rather than the window's. Feeding that back in is
 * self-latching: the expanded sidebar is 40 and the collapsed rail is 4, both
 * far below the breakpoint, so once the panel collapses it can never measure
 * itself wide enough to reopen. Prefer the tmux window width and fall back to
 * stdout only when psyche is not running inside tmux.
 */
export function resolveSidePanelLayoutWidth(
  tmuxWindowWidth: number | null | undefined,
  stdoutColumns: number | null | undefined
): number {
  if (isUsableWidth(tmuxWindowWidth)) {
    return tmuxWindowWidth;
  }
  if (isUsableWidth(stdoutColumns)) {
    return stdoutColumns;
  }
  return SIDE_PANEL_FALLBACK_WIDTH;
}

function isUsableWidth(width: number | null | undefined): width is number {
  return typeof width === 'number' && Number.isFinite(width) && width > 0;
}

export function shouldAutoCollapseSidePanel(
  terminalWidth: number,
  hasManualOverride: boolean
): boolean {
  return shouldUseCompactSidePanel(terminalWidth) && !hasManualOverride;
}
