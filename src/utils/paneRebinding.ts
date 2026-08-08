import type { PsychePane } from '../types.js';
import { LogService } from '../services/LogService.js';
import { getPaneTitleCandidates } from './paneTitle.js';
import { StateManager } from '../shared/StateManager.js';
import {
  getCurrentTmuxServerIdentity,
  sameTmuxServerIdentity,
} from '../services/TmuxServerIdentity.js';

/**
 * Attempts to rebind a pane whose ID has changed by matching on its stable tmux title.
 *
 * IMPORTANT: Only rebinds if the pane ID is truly missing (pane was killed and recreated).
 * Does NOT rebind if the title simply changed (user renamed it).
 *
 * @param pane - The pane to potentially rebind
 * @param titleToIdMap - Map of pane titles to their current tmux pane IDs
 * @param allPaneIds - Array of all current tmux pane IDs
 * @returns The pane with potentially updated paneId
 */
export function rebindPaneByTitle(
  pane: PsychePane,
  titleToIdMap: Map<string, string>,
  allPaneIds: string[]
): PsychePane {
  const existingIdIsCurrent = paneTmuxIdentityIsCurrent(pane, allPaneIds);
  // A tmux ID is reusable only within its recorded server generation.
  if (existingIdIsCurrent) {
    return pane; // Pane still exists, no rebinding needed
  }

  // Pane ID missing - try to find it by title match
  if (allPaneIds.length > 0 && !existingIdIsCurrent) {
    const sessionProjectRoot = StateManager.getInstance().getState().projectRoot;
    const titleCandidates = getPaneTitleCandidates(
      pane,
      sessionProjectRoot || undefined
    );
    for (const candidate of titleCandidates) {
      const remappedId = titleToIdMap.get(candidate);
      if (remappedId) {
  //         LogService.getInstance().debug(
  //           `Rebound pane ${pane.id} from ${pane.paneId} to ${remappedId} (matched by title: ${candidate})`,
  //           'shellDetection'
  //         );
        const tmuxServerIdentity = getCurrentTmuxServerIdentity(remappedId);
        if (!tmuxServerIdentity) {
          // A title match without a server generation is not an ownership
          // proof. Keep the old record instead of rebinding it to a reused ID.
          return pane;
        }
        if (
          remappedId === pane.paneId
          && pane.tmuxServerIdentity
          && !sameTmuxServerIdentity(pane.tmuxServerIdentity, tmuxServerIdentity)
        ) {
          continue;
        }
        const rebound: PsychePane = {
          ...pane,
          paneId: remappedId,
          tmuxServerIdentity,
        };
        if (
          !pane.tmuxServerIdentity
          || !sameTmuxServerIdentity(pane.tmuxServerIdentity, tmuxServerIdentity)
        ) {
          delete rebound.testWindowId;
          delete rebound.testPaneId;
          delete rebound.testTmuxServerIdentity;
          delete rebound.testStatus;
          delete rebound.testOutput;
          delete rebound.devWindowId;
          delete rebound.devPaneId;
          delete rebound.devTmuxServerIdentity;
          delete rebound.devStatus;
          delete rebound.devUrl;
          delete rebound.backgroundWindowRecoveries;
        }
        return rebound;
      }
    }
  }

  return pane;
}

export function paneTmuxIdentityIsCurrent(
  pane: PsychePane,
  allPaneIds: readonly string[],
): boolean {
  if (!allPaneIds.includes(pane.paneId) || !pane.tmuxServerIdentity) {
    return false;
  }
  const current = getCurrentTmuxServerIdentity(pane.paneId);
  return Boolean(
    current
    && sameTmuxServerIdentity(pane.tmuxServerIdentity, current)
  );
}
