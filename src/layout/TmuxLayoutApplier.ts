import { LogService } from '../services/LogService.js';
import { TmuxService } from '../services/TmuxService.js';
import type { LayoutConfig } from '../utils/layoutManager.js';
import type { LayoutConfiguration } from './LayoutCalculator.js';

/**
 * TmuxLayoutApplier - Applies calculated layouts to tmux
 *
 * Responsibilities:
 * - Set tmux window dimensions
 * - Generate and apply tmux layout strings
 * - Handle layout application failures with fallbacks
 * - Resize control pane (sidebar)
 *
 * Does NOT:
 * - Calculate layouts (use LayoutCalculator)
 * - Manage spacer panes (use SpacerManager)
 * - Determine when layouts need recalculation
 */
export class TmuxLayoutApplier {
  private tmuxService = TmuxService.getInstance();

  constructor(private config: LayoutConfig) {}

  /**
   * Sets tmux window dimensions to match calculated layout
   *
   * Accounts for status bar height to prevent terminal scrolling.
   * Only resizes if dimensions have actually changed to prevent resize loops.
   *
   * @param width - Desired window width in cells
   * @param height - Desired terminal height in cells (will subtract status bar)
   */
  setWindowDimensions(width: number, height: number): void {
    try {
      // Subtract status bar height from the provided terminal height
      const statusBarHeight = this.tmuxService.getStatusBarHeightSync();
      const windowHeight = height - statusBarHeight;

      // Check if dimensions have actually changed
      const currentDims = this.tmuxService.getWindowDimensionsSync();
      if (currentDims.width === width && currentDims.height === windowHeight) {
        // Dimensions already correct, skip resize to prevent loops
        return;
      }

      // Use manual mode to constrain width, but also set height to match terminal
      this.tmuxService.setWindowOptionSync('window-size', 'manual');
      this.tmuxService.resizeWindowSync({ width, height: windowHeight });
    } catch (error) {
      // Log but don't fail - some tmux versions may not support this
      LogService.getInstance().warn(
        `Could not set window dimensions to ${width}x${height}: ${error}`,
        'Layout'
      );
    }
  }

  /**
   * Applies the calculated layout to tmux panes
   *
   * The persistent-tree controller replaces custom automatic layouts. This
   * legacy path retains tmux's built-in layout as a fallback until then.
   *
   * @param controlPaneId - ID of sidebar/control pane
   * @param contentPaneIds - IDs of content panes (in display order)
   * @param layout - Calculated layout configuration
   * @param terminalHeight - Terminal height in cells
   */
  applyPaneLayout(
    controlPaneId: string,
    contentPaneIds: string[],
    layout: LayoutConfiguration,
    terminalHeight: number
  ): void {
    const numContentPanes = contentPaneIds.length;

    if (numContentPanes === 0) {
      // No content panes, just resize sidebar
      this.resizeControlPane(controlPaneId);
      return;
    }

    try {
      this.applyMainVerticalFallback();
    } catch {
      this.resizeControlPane(controlPaneId);
    }
  }

  /**
   * Resizes the control pane (sidebar) to configured width
   * Used as ultimate fallback when layout application fails
   */
  private resizeControlPane(controlPaneId: string): void {
    try {
      this.tmuxService.resizePaneSync(controlPaneId, {
        width: this.config.SIDEBAR_WIDTH
      });
    } catch (error) {
      LogService.getInstance().error(
        'Error resizing control pane',
        'Layout',
        undefined,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Applies main-vertical layout as fallback
   * Used when custom layout string generation or application fails
   */
  private applyMainVerticalFallback(): void {
    try {
      this.tmuxService.setWindowOptionSync('main-pane-width', String(this.config.SIDEBAR_WIDTH));
      this.tmuxService.selectLayoutSync('main-vertical');
      // LogService.getInstance().debug('Fell back to main-vertical layout', 'Layout');
    } catch (error) {
      LogService.getInstance().error(`Main-vertical fallback failed: ${error}`, 'Layout');
    }
  }

  /**
   * Logs current pane state for debugging
   * Useful for diagnosing layout application failures
   */
  private logPaneState(): void {
    // Commented out to reduce log noise
    // try {
    //   const paneList = this.tmuxService.listPanesSync('#{pane_id}=#{pane_index}');
    //   LogService.getInstance().debug(`Panes right before layout apply: ${paneList}`, 'Layout');
    // } catch {
    //   // Ignore errors
    // }
  }
}
