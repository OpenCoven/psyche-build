import fs from 'fs/promises';
import path from 'path';
import type { PsychePane } from '../types.js';
import {
  getUntrackedPanes,
  createShellPane,
  detectShellPaneProjectInfo,
  getNextPsycheId,
} from '../utils/shellPaneDetection.js';
import { LogService } from '../services/LogService.js';
import { TmuxService } from '../services/TmuxService.js';
import { syncPaneColorThemes } from '../utils/paneColors.js';
import {
  capturePaneInsertion,
  insertPanesIntoStoredLayout,
} from '../utils/layoutManager.js';
import { createPsychePaneId } from '../utils/paneIdentity.js';
import { allocateUniquePaneSlug } from '../services/PaneSlugRegistry.js';
import {
  reserveCrashSafePaneSlug,
  settlePaneSlugReservationAfterFailure,
} from '../services/PaneSlugReservation.js';

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
    const reservations: Array<Awaited<ReturnType<typeof reserveCrashSafePaneSlug>>> = [];
    const completedRecoveryIds = new Set<string>();
    let nextId = getNextPsycheId(activePanes);

    try {
      for (const paneInfo of untrackedPanes) {
        const paneRecordId = createPsychePaneId();
        const paneProjectInfo = await detectShellPaneProjectInfo(paneInfo.paneId);
        const targetProjectRoot = paneProjectInfo.projectRoot || projectRoot;
        const reservation = await reserveCrashSafePaneSlug({
          sessionProjectRoot: projectRoot,
          projectRoot: targetProjectRoot,
          paneId: paneRecordId,
          operation: 'shell-pane-adoption',
          allocate: async ({ occupiedSlugs }) => ({
            slug: await allocateUniquePaneSlug(`shell-${nextId}`, occupiedSlugs),
            worktreePath: paneProjectInfo.cwdReference || targetProjectRoot,
          }),
        });
        reservations.push(reservation);
        const tmuxServerIdentity = TmuxService.getInstance().getServerIdentity?.(
          paneInfo.paneId,
        );
        if (!tmuxServerIdentity) {
          throw new Error(
            `Cannot adopt shell pane ${paneInfo.paneId} without its tmux server generation`,
          );
        }
        await reservation.recordPaneEffect(
          paneInfo.paneId,
          tmuxServerIdentity,
        );
        const shellPane = await createShellPane(
          paneInfo.paneId,
          nextId,
          paneInfo.title,
          {
            tmuxServerIdentity,
            setPaneTitle: false,
            paneRecordId,
            slug: reservation.slug,
            projectInfo: paneProjectInfo,
          },
        );
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

      await insertPanesIntoStoredLayout({
        panesFile,
        panes: activePanes,
        insertions: plannedInsertions,
        controlPaneId: paneLayoutControlPaneId,
        sidebarWidth: options.sidebarWidth,
      });
      for (let index = 0; index < reservations.length; index += 1) {
        const reservation = reservations[index];
        const shellPane = newShellPanes[index];
        await reservation.completeAfterPanePersisted(shellPane);
        completedRecoveryIds.add(reservation.recoveryId);
        try {
          await TmuxService.getInstance().setPaneTitle(
            shellPane.paneId,
            shellPane.slug,
          );
        } catch {
          // The durable record and ownership settlement remain authoritative.
        }
      }
      const updatedPanes = [...activePanes, ...newShellPanes];

      return { updatedPanes, shellPanesAdded: newShellPanes.length > 0 };
    } catch (error) {
      for (const reservation of reservations) {
        if (completedRecoveryIds.has(reservation.recoveryId)) {
          continue;
        }
        await settlePaneSlugReservationAfterFailure(reservation, {
          operation: 'shell-pane-adoption-failure',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
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
