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
import { gateUntrackedPaneAdoption } from '../services/UntrackedPaneAdoptionGate.js';
import {
  attachDurableEffectWarning,
  type DurableEffectWarning,
} from '../utils/durableEffectWarnings.js';

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
): Promise<{
  updatedPanes: PsychePane[];
  shellPanesAdded: boolean;
  warnings?: readonly DurableEffectWarning[];
}> {
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
    let savedPaneIds: string[] = [];

    try {
      const configContent = await fs.readFile(panesFile, 'utf-8');
      const config = JSON.parse(configContent);
      controlPaneId = config.controlPaneId;
      paneLayoutControlPaneId = config.controlPaneId;
      welcomePaneId = config.welcomePaneId;
      sidebarProjects = Array.isArray(config.sidebarProjects) ? config.sidebarProjects : [];
      savedPaneIds = savedTmuxPaneIds(config.panes);
    } catch (error) {
      // Config not available (expected on first run), continue without filtering
  //       LogService.getInstance().debug(
  //         `Config file not available for shell detection: ${error instanceof Error ? error.message : String(error)}`,
  //         'useShellDetection'
  //       );
    }

    // The caller's pane snapshot can predate a record another code path has
    // just saved (#517), so a pane already on disk counts as tracked too.
    const trackedPaneIds = [...new Set([
      ...activePanes.map(p => p.paneId),
      ...savedPaneIds,
    ])];
  //     LogService.getInstance().debug(
  //       `Checking for untracked panes. Tracked: [${trackedPaneIds.join(', ')}], Control: ${controlPaneId}, Welcome: ${welcomePaneId}`,
  //       'shellDetection'
  //     );

    const sessionName = ''; // Empty string will make tmux use current session
    const detectedPanes = await getUntrackedPanes(sessionName, trackedPaneIds, controlPaneId, welcomePaneId);

    if (detectedPanes.length === 0) {
      return { updatedPanes: activePanes, shellPanesAdded: false };
    }

    // Skip panes another transaction already accounts for: a creation still
    // in flight (#517), or an earlier failure that is already quarantined and
    // reported (#516). Re-adopting those would stack a new quarantine record
    // and recovery marker for the same pane on every polling cycle.
    const adoption = await gateUntrackedPaneAdoption(projectRoot, detectedPanes, {
      serverIdentityOf: (paneId) => TmuxService.getInstance().getServerIdentity?.(paneId),
    });
    if (adoption.deferred) {
      LogService.getInstance().debug(
        `Deferring untracked-pane adoption: pane creation ${adoption.deferred.recoveryId} is in flight`,
        'shellDetection',
      );
    }
    for (const exclusion of adoption.excluded) {
      if (exclusion.reason === 'creation-in-flight') {
        LogService.getInstance().debug(
          `Not adopting pane ${exclusion.paneId}: creation ${exclusion.recoveryId} is in flight`,
          'shellDetection',
          exclusion.paneId,
        );
      }
    }
    const untrackedPanes = adoption.adoptable;

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
    // The gate has just reconciled when it had anything stale to settle; the
    // first reservation of this cycle need not repeat it.
    let skipStaleReconciliation = adoption.reconciled;
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
          skipStaleReconciliation,
          allocate: async ({ occupiedSlugs }) => ({
            slug: await allocateUniquePaneSlug(`shell-${nextId}`, occupiedSlugs),
            worktreePath: paneProjectInfo.cwdReference || targetProjectRoot,
          }),
        });
        reservations.push(reservation);
        skipStaleReconciliation = false;
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
      const warnings: DurableEffectWarning[] = [];
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
        const settlement = await reservation.completeAfterPanePersisted(shellPane);
        if (settlement?.cleanupWarning) {
          warnings.push(settlement.cleanupWarning);
          attachDurableEffectWarning(shellPane, settlement.cleanupWarning);
          LogService.getInstance().warn(
            settlement.cleanupWarning.message,
            'shellDetection',
            shellPane.paneId,
          );
        }
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

      return {
        updatedPanes,
        shellPanesAdded: newShellPanes.length > 0,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (error) {
      const settlementWarnings: string[] = [];
      for (const reservation of reservations) {
        if (completedRecoveryIds.has(reservation.recoveryId)) {
          continue;
        }
        const settlement = await settlePaneSlugReservationAfterFailure(reservation, {
          operation: 'shell-pane-adoption-failure',
          reason: error instanceof Error ? error.message : String(error),
        });
        if (settlement.message) {
          settlementWarnings.push(settlement.message);
        }
      }
      if (settlementWarnings.length > 0) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; ${
            settlementWarnings.join('; ')
          }`,
        );
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

function savedTmuxPaneIds(panes: unknown): string[] {
  if (!Array.isArray(panes)) {
    return [];
  }
  return panes.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      return [];
    }
    const paneId = (candidate as { paneId?: unknown }).paneId;
    return typeof paneId === 'string' && paneId.length > 0 ? [paneId] : [];
  });
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
