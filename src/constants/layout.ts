/**
 * Title given to the filler pane that keeps content panes from stretching
 * too wide. Panes with this title are excluded from every pane listing, so
 * the value is a real runtime contract with a live tmux server, not a label.
 */
export const SPACER_PANE_TITLE = 'psyche-spacer';

export const DEFAULT_MAX_PANE_WIDTH = 80;
export const MIN_MAX_PANE_WIDTH = 40;
export const MAX_MAX_PANE_WIDTH = 300;
export const SHIFT_MAX_PANE_WIDTH_STEP = 10;

export const DEFAULT_MIN_PANE_WIDTH = 50;
export const MIN_MIN_PANE_WIDTH = MIN_MAX_PANE_WIDTH;
export const MAX_MIN_PANE_WIDTH = MAX_MAX_PANE_WIDTH;
export const SHIFT_MIN_PANE_WIDTH_STEP = SHIFT_MAX_PANE_WIDTH_STEP;
