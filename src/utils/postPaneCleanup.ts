/**
 * Shared utility for post-pane cleanup operations
 * Handles welcome pane recreation and layout recalculation when last pane is removed
 */

import fs from 'fs/promises';
import path from 'path';
import type { PsycheConfig } from '../types.js';
import { LogService } from '../services/LogService.js';
import { TmuxService } from '../services/TmuxService.js';
import { applyStoredPaneLayout, SIDEBAR_WIDTH } from './layoutManager.js';

/**
 * Recreate welcome pane and recalculate layout after the last pane is removed
 * This should be called whenever panes.length transitions from >0 to 0
 *
 * @param projectRoot - The project root directory
 */
export async function handleLastPaneRemoved(
  projectRoot: string,
  sidebarWidth: number = SIDEBAR_WIDTH
): Promise<void> {
  const tmuxService = TmuxService.getInstance();

  try {
    // Get the ACTUAL current control pane ID from tmux (don't trust config)
    let controlPaneId: string;
    try {
      const { execSync } = await import('child_process');
      controlPaneId = execSync('tmux display-message -p "#{pane_id}"', {
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim();
    } catch (error) {
      return;
    }

    if (!controlPaneId) {
      return;
    }

    // Recreate welcome pane
    const { createWelcomePaneCoordinated } = await import('./welcomePaneManager.js');
    await createWelcomePaneCoordinated(
      projectRoot,
      controlPaneId,
      undefined,
      sidebarWidth
    );

    const dimensions = await tmuxService.getTerminalDimensions();
    const panesFile = path.join(projectRoot, '.psyche', 'psyche.config.json');
    const config = JSON.parse(await fs.readFile(panesFile, 'utf-8')) as PsycheConfig;
    if (Array.isArray(config)) {
      throw new Error('Pane layout requires an object-form config');
    }
    await applyStoredPaneLayout({
      panesFile,
      panes: config.panes || [],
      controlPaneId,
      terminalWidth: dimensions.width,
      terminalHeight: dimensions.height,
      sidebarWidth,
      mutation: { kind: 'reconcile' },
    });
  } catch (error) {
    LogService.getInstance().error(
      'Failed to handle last pane removal',
      'postPaneCleanup',
      undefined,
      error instanceof Error ? error : undefined
    );
  }
}
