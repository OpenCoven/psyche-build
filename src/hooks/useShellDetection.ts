import fs from 'fs/promises';
import path from 'path';
import type { PsychePane } from '../types.js';
import { getUntrackedPanes, createShellPane, getNextPsycheId } from '../utils/shellPaneDetection.js';
import { LogService } from '../services/LogService.js';
import { TmuxService } from '../services/TmuxService.js';
import { syncPaneColorThemes } from '../utils/paneColors.js';
import {
  capturePaneInsertion,
  insertPaneIntoStoredLayout,
} from '../utils/layoutManager.js';

/**
 * Detects untracked panes (manually created via tmux commands)
 * and creates shell pane objects for them
 */
export async function detectAndAddShellPanes(
  panesFile: string,
  activePanes: PsychePane[],
  allPaneIds: string[],
  options: {
    focusedTmuxPaneId?: string | null;
    selectedPaneId?: string;
    sidebarWidth?: number;
  } = {}
): Promise<{ updatedPanes: PsychePane[]; shellPanesAdded: boolean }> {
  // Only detect if we have pane IDs from tmux
  if (allPaneIds.length === 0) {
    return { updatedPanes: activePanes, shellPanesAdded: false };
  }

  try {
    // Get controlPaneId and welcomePaneId from config
    let controlPaneId: string | undefined;
    let welcomePaneId: string | undefined;
    let paneLayoutControlPaneId: string | undefined;
    let projectRoot = path.dirname(path.dirname(panesFile));
    let sidebarProjects: import('../types.js').SidebarProject[] = [];

    try {
      const configContent = await fs.readFile(panesFile, 'utf-8');
      const config = JSON.parse(configContent);
      controlPaneId = config.controlPaneId;
      paneLayoutControlPaneId = config.controlPaneId;
      welcomePaneId = config.welcomePaneId;
      projectRoot = config.projectRoot || projectRoot;
      sidebarProjects = Array.isArray(config.sidebarProjects) ? config.sidebarProjects : [];
    } catch (error) {
      // Config not available (expected on first run), continue without filtering
  //       LogService.getInstance().debug(
  //         `Config file not available for shell detection: ${error instanceof Error ? error.message : String(error)}`,
  //         'useShellDetection'
  //       );
    }

    const trackedPaneIds = activePanes.map(p => p.paneId);
  //     LogService.getInstance().debug(
  //       `Checking for untracked panes. Tracked: [${trackedPaneIds.join(', ')}], Control: ${controlPaneId}, Welcome: ${welcomePaneId}`,
  //       'shellDetection'
  //     );

    const sessionName = ''; // Empty string will make tmux use current session
    const untrackedPanes = await getUntrackedPanes(sessionName, trackedPaneIds, controlPaneId, welcomePaneId);

    if (untrackedPanes.length === 0) {
      return { updatedPanes: activePanes, shellPanesAdded: false };
    }

  //     LogService.getInstance().debug(
  //       `Found ${untrackedPanes.length} untracked panes: ${untrackedPanes.map(p => p.paneId).join(', ')}`,
  //       'shellDetection'
  //     );

    // Create shell pane objects for each untracked pane
    const newShellPanes: PsychePane[] = [];
    let nextId = getNextPsycheId(activePanes);

    for (const paneInfo of untrackedPanes) {
      const shellPane = await createShellPane(paneInfo.paneId, nextId, paneInfo.title);
      newShellPanes.push(
        syncPaneColorThemes([shellPane], sidebarProjects, projectRoot)[0]
      );
      nextId++;
    }

    if (!paneLayoutControlPaneId) {
      throw new Error('Pane layout cannot be updated without a control pane');
    }

    const plannedInsertions: Array<{
      pane: PsychePane;
      insertion: NonNullable<Awaited<ReturnType<typeof captureShellPaneInsertion>>>;
    }> = [];
    let plannedPanes = [...activePanes];
    for (const shellPane of newShellPanes) {
      const insertion = await captureShellPaneInsertion({
        panesFile,
        panes: plannedPanes,
        focusedTmuxPaneId: options.focusedTmuxPaneId,
        selectedPaneId: options.selectedPaneId,
      });
      if (!insertion) {
        throw new Error('Pane layout has no visible insertion target');
      }

      plannedInsertions.push({ pane: shellPane, insertion });
      plannedPanes = [...plannedPanes, shellPane];
    }

    let updatedPanes = [...activePanes];
    for (const { pane: shellPane, insertion } of plannedInsertions) {
      await insertPaneIntoStoredLayout({
        panesFile,
        panes: updatedPanes,
        pane: shellPane,
        controlPaneId: paneLayoutControlPaneId,
        insertion,
        sidebarWidth: options.sidebarWidth,
      });
      updatedPanes = [...updatedPanes, shellPane];
    }

  //     LogService.getInstance().debug(
  //       `Added ${newShellPanes.length} shell panes to tracking`,
  //       'shellDetection'
  //     );

    return { updatedPanes, shellPanesAdded: newShellPanes.length > 0 };
  } catch (error) {
    LogService.getInstance().error(
      `Failed to add detected shell panes: ${error instanceof Error ? error.message : String(error)}`,
      'shellDetection',
      undefined,
      error instanceof Error ? error : undefined
    );
  //     LogService.getInstance().debug(
  //       'Failed to detect untracked panes',
  //       'shellDetection'
  //     );
    return { updatedPanes: activePanes, shellPanesAdded: false };
  }
}

async function captureShellPaneInsertion(options: {
  panesFile: string;
  panes: PsychePane[];
  focusedTmuxPaneId?: string | null;
  selectedPaneId?: string;
}) {
  const capture = () => capturePaneInsertion(options);
  let insertion;
  let refreshed = false;

  try {
    insertion = await capture();
  } catch {
    await TmuxService.getInstance().getAllPaneIds('window');
    refreshed = true;
    insertion = await capture();
  }

  if (!insertion && !refreshed) {
    await TmuxService.getInstance().getAllPaneIds('window');
    insertion = await capture();
  }

  return insertion;
}
