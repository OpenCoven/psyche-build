export const SIDE_PANEL_EXPAND_GLYPH = '›';
export const SIDE_PANEL_COLLAPSE_GLYPH = '‹';
export const SIDE_PANEL_EXPANDED_WIDTH = 40;
export const SIDE_PANEL_COLLAPSED_WIDTH = 4;
export const SIDE_PANEL_MOBILE_BREAKPOINT = 140; // Increased from 100; 40 sidebar + 100 content = readable minimum

export function getSidePanelWidth(collapsed: boolean): number {
  return collapsed ? SIDE_PANEL_COLLAPSED_WIDTH : SIDE_PANEL_EXPANDED_WIDTH;
}

export function shouldUseCompactSidePanel(terminalWidth: number): boolean {
  return Number.isFinite(terminalWidth) && terminalWidth < SIDE_PANEL_MOBILE_BREAKPOINT;
}

export function shouldAutoCollapseSidePanel(
  terminalWidth: number,
  hasManualOverride: boolean
): boolean {
  return shouldUseCompactSidePanel(terminalWidth) && !hasManualOverride;
}
