import type { PanePosition } from '../types.js';
import { LogService } from '../services/LogService.js';
import { TmuxService } from '../services/TmuxService.js';
import { recalculateAndApplyLayout } from './layoutManager.js';
import { execSync } from 'child_process';
import { SPACER_PANE_TITLE } from '../constants/layout.js';

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
 * Gets content pane IDs (excludes control pane and spacer pane)
 * This uses synchronous operations to maintain compatibility with existing code
 */
export const getContentPaneIds = (controlPaneId: string): string[] => {
  const tmuxService = TmuxService.getInstance();
  const allPanes = tmuxService.getAllPaneIdsSync();

  return allPanes.filter(id => {
    if (id === controlPaneId) return false;

    // Filter out spacer pane
    try {
      const title = tmuxService.getPaneTitleSync(id);
      return title !== SPACER_PANE_TITLE;
    } catch {
      return true; // Include pane if we can't get title
    }
  });
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
 * Enforces left sidebar layout: 40-char wide sidebar on left, content panes in grid on right
 * This maintains the structure: [Sidebar (40 chars, full height) | Content Grid Area]
 *
 * @deprecated This function now delegates to the centralized layout manager.
 * Consider using recalculateAndApplyLayout() directly from layoutManager.ts
 */
export const enforceControlPaneSize = async (
  controlPaneId: string,
  width: number,
  options?: { forceLayout?: boolean; suppressLayoutLogs?: boolean; disableSpacer?: boolean }
): Promise<void> => {
  const logService = LogService.getInstance();
  const tmuxService = TmuxService.getInstance();

  try {
    const contentPanes = getContentPaneIds(controlPaneId);
    // logService.debug(`enforceControlPaneSize called: ${contentPanes.length} content panes`, 'Layout');

    // If we only have the control pane, nothing to enforce
    if (contentPanes.length === 0) {
      // Just resize the sidebar
      try {
        await tmuxService.resizePane(controlPaneId, { width });
      } catch {
        // Ignore errors
      }
      return;
    }

    // Check if we have only the welcome pane (should not be width-constrained)
    if (contentPanes.length === 1) {
      try {
        const title = tmuxService.getPaneTitleSync(contentPanes[0]);

        if (title === 'Welcome') {
          // Welcome pane should use full terminal width, not be constrained
          // Get terminal dimensions and let window follow terminal
          const termDims = getTerminalDimensions();

          // Calculate window height accounting for status bar to prevent scroll
          const statusBarHeight = tmuxService.getStatusBarHeightSync();
          const windowHeight = termDims.height - statusBarHeight;

          // Set window size to match terminal (manual mode but always tracking terminal)
          tmuxService.setWindowOptionSync('window-size', 'manual');
          await tmuxService.resizeWindow({ width: termDims.width, height: windowHeight });

          // Apply main-vertical layout with fixed sidebar width
          tmuxService.setWindowOptionSync('main-pane-width', String(width));
          await tmuxService.selectLayout('main-vertical');
          await tmuxService.refreshClient();
          return;
        }
      } catch {
        // If we can't get the title, fall through to normal layout
      }
    }

    // Use the new layout manager for regular content panes.
    // IMPORTANT: target control pane client dimensions, not popup/client-of-caller dimensions.
    let dimensions = getTerminalDimensions();
    try {
      const output = execSync(
        `tmux display-message -t '${controlPaneId}' -p "#{client_width} #{client_height}"`,
        { encoding: 'utf-8' }
      ).trim();
      const [targetWidth, targetHeight] = output.split(' ').map(n => parseInt(n, 10));
      if (
        Number.isFinite(targetWidth) &&
        Number.isFinite(targetHeight) &&
        targetWidth > 0 &&
        targetHeight > 0
      ) {
        dimensions = { width: targetWidth, height: targetHeight };
      }
    } catch {
      // Fall back to caller client dimensions.
    }
    // logService.debug(`Terminal dimensions: ${dimensions.width}x${dimensions.height}`, 'Layout');

    await recalculateAndApplyLayout(
      controlPaneId,
      contentPanes,
      dimensions.width,
      dimensions.height,
      undefined,
      {
        force: options?.forceLayout === true,
        suppressLogs: options?.suppressLayoutLogs === true,
        disableSpacer: options?.disableSpacer === true,
        sidebarWidth: width,
      }
    );

    // Refresh to apply changes (but don't select the pane - don't steal focus!)
    await tmuxService.refreshClient();
  } catch (error) {
    // Log error for debugging but don't crash
    const msg = 'Layout enforcement failed';
    LogService.getInstance().error(msg, 'tmux', undefined, error instanceof Error ? error : undefined);
  }
};
