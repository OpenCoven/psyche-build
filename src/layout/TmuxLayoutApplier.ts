import { LogService } from '../services/LogService.js';
import { TmuxService } from '../services/TmuxService.js';
import { SPACER_PANE_TITLE } from '../constants/layout.js';
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
   * The persistent-tree controller will replace this legacy path in Task 3.
   * Until then, this keeps the calculated grid layout behavior.
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
      const layoutString = this.generateLegacySidebarGridLayout(
        controlPaneId,
        contentPaneIds,
        layout.windowWidth,
        terminalHeight,
        layout.cols
      );

      if (layoutString) {
        const success = this.tmuxService.selectLayoutSync(layoutString);
        if (!success) {
          this.applyMainVerticalFallback();
        }
      } else {
        this.applyMainVerticalFallback();
      }
    } catch {
      this.resizeControlPane(controlPaneId);
    }
  }

  /**
   * Generates the legacy calculated grid layout used until the persistent tree
   * controller replaces this class.
   */
  private generateLegacySidebarGridLayout(
    controlPaneId: string,
    contentPanes: string[],
    windowWidth: number,
    windowHeight: number,
    columns: number
  ): string {
    const numContentPanes = contentPanes.length;

    if (numContentPanes === 0) {
      return '';
    }

    const cols = columns;
    const rows = Math.ceil(numContentPanes / cols);
    const contentWidth = windowWidth - this.config.SIDEBAR_WIDTH - 1;
    const contentStartX = this.config.SIDEBAR_WIDTH + 1;

    const lastPaneIsSpacer =
      contentPanes.length > 0 &&
      (() => {
        try {
          const lastPaneId = contentPanes[contentPanes.length - 1];
          const title = this.tmuxService.getPaneTitleSync(lastPaneId);
          return title === SPACER_PANE_TITLE;
        } catch {
          return false;
        }
      })();

    const bordersHeight = rows - 1;
    const availableHeight = windowHeight - bordersHeight;
    const paneHeight = Math.floor(availableHeight / rows);

    const sidebarId = controlPaneId.replace(/^%/, '');
    const gridRows: string[] = [];
    let paneIndex = 0;
    let currentY = 0;

    for (let row = 0; row < rows; row++) {
      const rowPanes: string[] = [];
      let absoluteX = contentStartX;

      const rowHeight = row === rows - 1 ? windowHeight - currentY : paneHeight;

      const panesInThisRow: string[] = [];
      for (let col = 0; col < cols && paneIndex + col < numContentPanes; col++) {
        panesInThisRow.push(contentPanes[paneIndex + col]);
      }

      const rowHasSpacer =
        lastPaneIsSpacer &&
        row === rows - 1 &&
        panesInThisRow.length > 0 &&
        panesInThisRow[panesInThisRow.length - 1] === contentPanes[numContentPanes - 1];

      const numContentPanesInRow = rowHasSpacer ? panesInThisRow.length - 1 : panesInThisRow.length;

      let contentPaneWidths: number[];
      let spacerWidth: number | null = null;

      if (rowHasSpacer) {
        const contentPaneWidth = this.config.MAX_COMFORTABLE_WIDTH;
        const bordersInRow = panesInThisRow.length - 1;
        const totalContentWidth = numContentPanesInRow * contentPaneWidth;
        const remainingWidth = contentWidth - totalContentWidth - bordersInRow;

        contentPaneWidths = Array(numContentPanesInRow).fill(contentPaneWidth);
        spacerWidth = remainingWidth;
      } else {
        const bordersInRow = panesInThisRow.length - 1;
        const availableWidthInRow = contentWidth - bordersInRow;
        const evenWidth = Math.floor(availableWidthInRow / panesInThisRow.length);
        const remainder = availableWidthInRow - evenWidth * panesInThisRow.length;

        contentPaneWidths = Array(panesInThisRow.length).fill(evenWidth);
        contentPaneWidths[0] += remainder;
      }

      for (let col = 0; col < panesInThisRow.length; col++) {
        const paneId = panesInThisRow[col].replace(/^%/, '');
        const isSpacerPane = rowHasSpacer && col === panesInThisRow.length - 1;
        const colWidth = isSpacerPane ? spacerWidth! : contentPaneWidths[col];

        rowPanes.push(`${colWidth}x${rowHeight},${absoluteX},${currentY},${paneId}`);

        absoluteX += colWidth;
        if (col < panesInThisRow.length - 1) {
          absoluteX += 1;
        }
      }

      paneIndex += panesInThisRow.length;

      if (rowPanes.length > 1) {
        const rowString = `${contentWidth}x${rowHeight},${contentStartX},${currentY}{${rowPanes.join(',')}}`;
        gridRows.push(rowString);
      } else if (rowPanes.length === 1) {
        const paneStr = rowPanes[0];
        const parts = paneStr.split(',');
        parts[1] = contentStartX.toString();
        parts[2] = currentY.toString();
        gridRows.push(parts.join(','));
      }

      if (row < rows - 1) {
        currentY += paneHeight + 1;
      }
    }

    const sidebar = `${this.config.SIDEBAR_WIDTH}x${windowHeight},0,0,${sidebarId}`;
    let layoutWithoutChecksum: string;

    if (gridRows.length > 1) {
      const contentArea = `${contentWidth}x${windowHeight},${contentStartX},0[${gridRows.join(',')}]`;
      layoutWithoutChecksum = `${windowWidth}x${windowHeight},0,0{${sidebar},${contentArea}}`;
    } else if (gridRows.length === 1) {
      const row = gridRows[0];
      const contentArea = row.replace(/^(\d+x\d+),0,/, `$1,${contentStartX},`);
      layoutWithoutChecksum = `${windowWidth}x${windowHeight},0,0{${sidebar},${contentArea}}`;
    } else {
      return '';
    }

    return `${this.calculateLayoutChecksum(layoutWithoutChecksum)},${layoutWithoutChecksum}`;
  }

  private calculateLayoutChecksum(layout: string): string {
    let checksum = 0;

    for (let index = 0; index < layout.length; index += 1) {
      checksum = (checksum >> 1) + ((checksum & 1) << 15);
      checksum += layout.charCodeAt(index);
      checksum &= 0xffff;
    }

    return checksum.toString(16).padStart(4, '0');
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
