import type { PanePosition } from '../types.js';
import { TmuxService } from '../services/TmuxService.js';

// Layout configuration - adjust these to change layout behavior
export const SIDEBAR_WIDTH = 40;

// Re-export types from TmuxService for backwards compatibility
export type { WindowDimensions } from '../types.js';

/**
 * Gets current window dimensions
 * @deprecated Use TmuxService.getInstance().getWindowDimensionsSync() instead
 */
export const getWindowDimensions = () => {
  return TmuxService.getInstance().getWindowDimensionsSync();
};

/**
 * Gets current terminal (client) dimensions
 * This is the actual terminal size, not the tmux window size
 * @deprecated Use TmuxService.getInstance().getTerminalDimensionsSync() instead
 */
export const getTerminalDimensions = () => {
  return TmuxService.getInstance().getTerminalDimensionsSync();
};

/**
 * Get pane positions for all panes
 * @deprecated Use TmuxService.getInstance().getPanePositionsSync() instead
 */
export const getPanePositions = (): PanePosition[] => {
  return TmuxService.getInstance().getPanePositionsSync();
};

/**
 * Creates a new tmux pane by splitting horizontally
 * @param options - Split pane options
 * @param options.targetPane - Pane to split from (optional)
 * @param options.cwd - Working directory for new pane (optional)
 * @param options.command - Command to run in new pane (optional)
 * @returns The new pane ID
 * @deprecated Use TmuxService.getInstance().splitPaneSync() instead
 */
export const splitPane = (options: {
  targetPane?: string;
  cwd?: string;
  command?: string;
} = {}): string => {
  return TmuxService.getInstance().splitPaneSync(options);
};

/**
 * Gets all pane IDs in current window
 * @deprecated Use TmuxService.getInstance().getAllPaneIdsSync() instead
 */
export const getAllPaneIds = (): string[] => {
  return TmuxService.getInstance().getAllPaneIdsSync();
};

/**
 * Enable pane border titles for the current tmux session only.
 */
export const ensurePaneBorderStatusForCurrentSession = (): void => {
  const tmuxService = TmuxService.getInstance();
  const sessionName = tmuxService.getCurrentSessionNameSync();
  tmuxService.setSessionOptionSync(sessionName, 'pane-border-status', 'top');
};

/**
 * Creates initial sidebar layout by splitting from control pane
 * @param controlPaneId The pane ID running psyche TUI (left sidebar)
 * @param cwd Optional working directory for the new content pane
 * @returns The newly created content area pane ID
 */
export const setupSidebarLayout = (controlPaneId: string, cwd?: string): string => {
  try {
    const tmuxService = TmuxService.getInstance();

    // Defensive check: verify the control pane still exists before splitting
    try {
      // Try to get the pane title - this will throw if the pane doesn't exist
      tmuxService.getPaneTitleSync(controlPaneId);
    } catch (error) {
      throw new Error(`Control pane ${controlPaneId} does not exist. Cannot create sidebar layout.`);
    }

    // Split horizontally (left-right) from control pane
    const newPaneId = tmuxService.splitPaneSync({
      targetPane: controlPaneId,
      cwd,
    });

    // Resize control pane to fixed width (sync version for initial setup)
    try {
      tmuxService.resizePaneSync(controlPaneId, { width: SIDEBAR_WIDTH });
    } catch {
      // Ignore resize errors during initial setup
    }

    return newPaneId;
  } catch (error) {
    throw new Error(`Failed to setup sidebar layout: ${error}`);
  }
};

/**
 * Enforces the fixed-width left sidebar and refreshes the current client.
 */
export const enforceControlPaneSize = async (
  controlPaneId: string,
  width: number,
  _options?: { forceLayout?: boolean; suppressLayoutLogs?: boolean; disableSpacer?: boolean }
): Promise<void> => {
  const tmuxService = TmuxService.getInstance();

  await tmuxService.resizePane(controlPaneId, { width });
  await tmuxService.refreshClient();
};
