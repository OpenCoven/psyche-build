import path from 'path';
import type { PsychePane } from '../types.js';
import { rebindPaneByTitle } from '../utils/paneRebinding.js';
import { LogService } from '../services/LogService.js';
import { TmuxService } from '../services/TmuxService.js';
import { PaneLifecycleManager } from '../services/PaneLifecycleManager.js';
import { TMUX_COMMAND_TIMEOUT } from '../constants/timing.js';
import type { PsycheConfig } from './usePaneLoading.js';
import { getPaneTmuxTitle } from '../utils/paneTitle.js';
import { StateManager } from '../shared/StateManager.js';
import { normalizeSidebarProjects } from '../utils/sidebarProjects.js';
import { syncPaneColorThemes } from '../utils/paneColors.js';
import { SPACER_PANE_TITLE } from '../constants/layout.js';
import { mutateProjectPaneConfig } from '../services/ProjectPaneConfig.js';

/**
 * Enforces that tmux pane titles match the encoded config title for each pane.
 * This keeps rebinding stable while allowing a separate user-facing display name.
 */
export async function enforcePaneTitles(
  panes: PsychePane[],
  allPaneIds: string[],
  controlPaneId?: string
): Promise<void> {
  const tmuxService = TmuxService.getInstance();
  const sessionProjectRoot = StateManager.getInstance().getState().projectRoot;
  const titleByPaneId = new Map<string, string>();

  try {
    const paneInfo = await tmuxService.getAllPaneInfo('session');
    for (const pane of paneInfo) {
      titleByPaneId.set(pane.paneId, pane.title);
    }
  } catch {
    // Fall back to per-pane title lookups below.
  }

  // Enforce control pane title stays "psyche"
  if (controlPaneId) {
    try {
      const controlTitle = titleByPaneId.get(controlPaneId)
        ?? await tmuxService.getPaneTitle(controlPaneId);
      if (controlTitle !== 'psyche') {
        await tmuxService.setPaneTitle(controlPaneId, 'psyche');
      }
    } catch {
      // Ignore - control pane might not exist yet
    }
  }

  for (const pane of panes) {
    if (allPaneIds.includes(pane.paneId)) {
      try {
        // Get current title to check if update is needed
        const currentTitle = titleByPaneId.get(pane.paneId)
          ?? await tmuxService.getPaneTitle(pane.paneId);

        const expectedTitle = getPaneTmuxTitle(pane, sessionProjectRoot || undefined);

        // Only update if title doesn't match expected title
        if (currentTitle !== expectedTitle) {
          await tmuxService.setPaneTitle(pane.paneId, expectedTitle);
          LogService.getInstance().debug(
            `Synced pane title: ${pane.id} "${currentTitle}" → "${expectedTitle}"`,
            'shellDetection'
          );
        }
      } catch (error) {
        // Ignore errors - pane might have been killed between check and sync
        LogService.getInstance().debug(
          `Failed to sync title for pane ${pane.id}: ${error instanceof Error ? error.message : String(error)}`,
          'usePaneSync'
        );
      }
    }
  }
}

/**
 * Saves panes to config file with rebinding and write lock protection
 * Used for explicit save operations (not periodic background saves)
 */
export async function savePanesToFile(
  panesFile: string,
  panes: PsychePane[],
  withWriteLock: <T>(operation: () => Promise<T>) => Promise<T>,
  previousPanes: readonly PsychePane[],
): Promise<PsychePane[]> {
  const originatingPanes = [...previousPanes];
  const nextPanes = [...panes];

  return withWriteLock(async () => {
    let activePanes = nextPanes;

    // Try to update pane IDs if they've changed (rebinding)
    try {
      const tmuxService = TmuxService.getInstance();
      const titleToId = new Map<string, string>();
      const paneInfo = await tmuxService.getAllPaneInfo('session');

      for (const pane of paneInfo) {
        if (
          pane.paneId &&
          pane.paneId.startsWith('%') &&
          pane.title &&
          pane.title !== SPACER_PANE_TITLE
        ) {
          titleToId.set(pane.title.trim(), pane.paneId);
        }
      }

      // Only rebind IDs, don't filter out panes
      // This prevents losing panes during concurrent operations
      // Note: We need to get allPaneIds to properly use rebindPaneByTitle
      const allPaneIds = Array.from(titleToId.values());
      activePanes = nextPanes.map(p => rebindPaneByTitle(p, titleToId, allPaneIds));
    } catch (error) {
      // If tmux command fails, keep panes as-is (prevents data loss during tmux instability)
      LogService.getInstance().debug(
        `Failed to fetch tmux panes for rebinding: ${error instanceof Error ? error.message : String(error)}`,
        'usePaneSync'
      );
      activePanes = nextPanes;
    }

    const sessionProjectRoot = path.dirname(path.dirname(panesFile));
    return persistPaneConfigDelta(
      sessionProjectRoot,
      originatingPanes,
      activePanes,
    );
  });
}

/**
 * Rebinds all panes and filters out dead shell panes
 * Keeps worktree panes even if not found (they can be recreated)
 *
 * IMPORTANT: Checks PaneLifecycleManager to avoid queuing panes for recreation
 * if they are being intentionally closed (prevents race condition)
 *
 * CRITICAL FIX: On initial load, shell panes with stale IDs are immediately removed.
 * Shell panes cannot be recreated (they have no worktreePath), so keeping them
 * with stale IDs causes psyche to hang when trying to interact with non-existent panes.
 */
export function rebindAndFilterPanes(
  loadedPanes: PsychePane[],
  titleToId: Map<string, string>,
  allPaneIds: string[],
  isInitialLoad: boolean
): { activePanes: PsychePane[]; shellPanesRemoved: boolean; worktreePanesToRecreate: PsychePane[] } {
  const worktreePanesToRecreate: PsychePane[] = [];
  const lifecycleManager = PaneLifecycleManager.getInstance();

  // LogService.getInstance().debug(
  //   `Checking panes: loaded=${loadedPanes.length}, allPaneIds=[${allPaneIds.join(', ')}]`,
  //   'shellDetection'
  // );

  // Rebind panes based on title matching
  const reboundPanes = loadedPanes.map(loadedPane => {
    const rebound = rebindPaneByTitle(loadedPane, titleToId, allPaneIds);
    if (rebound.paneId !== loadedPane.paneId) {
      LogService.getInstance().debug(
        `Pane ${loadedPane.id} (${loadedPane.paneId}) not found in tmux, checking for rebind`,
        'shellDetection'
      );
    }
    return rebound;
  });

  // Filter out dead shell panes, keep worktree panes
  const activePanes = reboundPanes.filter(pane => {
    // If we have tmux data and this pane is not found
    if (allPaneIds.length > 0 && !allPaneIds.includes(pane.paneId)) {
      // CRITICAL: Check if pane is being intentionally closed
      // If so, remove it from tracking (don't recreate, don't keep)
      if (lifecycleManager.isClosing(pane.id) || lifecycleManager.isClosing(pane.paneId)) {
        LogService.getInstance().debug(
          `Pane ${pane.id} (${pane.slug}) is being intentionally closed - removing from list`,
          'shellDetection'
        );
        return false; // Remove from list entirely
      }

      LogService.getInstance().debug(
        `Pane ${pane.id} (${pane.paneId}) not in tmux. Type: ${pane.type}`,
        'shellDetection'
      );

      // CRITICAL FIX: Remove shell panes that are no longer present
      // Shell panes have no worktreePath, so they cannot be recreated.
      // Keeping them with stale paneIds causes psyche to hang when:
      // 1. Trying to send keys to non-existent panes
      // 2. Trying to get pane status/content
      // 3. Trying to apply layouts with stale pane IDs
      // This is especially important on session reopen where tmux pane IDs change.
      if (pane.type === 'shell') {
        LogService.getInstance().info(
          `Removing stale shell pane: ${pane.id} (${pane.slug}) - paneId ${pane.paneId} no longer exists`,
          'shellDetection'
        );
        return false;
      }

      // For worktree panes after initial load, queue them for recreation
      if (!isInitialLoad && pane.worktreePath) {
        LogService.getInstance().debug(
          `Worktree pane ${pane.id} (${pane.slug}) was killed, will recreate it`,
          'shellDetection'
        );
        worktreePanesToRecreate.push(pane);
        return true; // Keep it in the list
      }

      // Keep worktree panes (they can be recreated on restart)
      LogService.getInstance().debug(
        `Keeping worktree pane: ${pane.id} (will be recreated if needed)`,
        'shellDetection'
      );
    }
    return true;
  });

  // Track if shell panes were removed (for saving to config)
  const shellPanesRemoved = loadedPanes.some(p =>
    p.type === 'shell' && allPaneIds.length > 0 && !allPaneIds.includes(p.paneId)
  );

  if (shellPanesRemoved) {
    LogService.getInstance().info(
      `Removed ${loadedPanes.filter(p => p.type === 'shell' && !allPaneIds.includes(p.paneId)).length} stale shell pane(s) from config`,
      'shellDetection'
    );
  }

  return { activePanes, shellPanesRemoved, worktreePanesToRecreate };
}

/**
 * Saves updated pane config to file (used during periodic polling)
 */
export async function saveUpdatedPaneConfig(
  panesFile: string,
  activePanes: PsychePane[],
  withWriteLock: <T>(operation: () => Promise<T>) => Promise<T>,
  previousPanes: readonly PsychePane[],
): Promise<void> {
  const originatingPanes = [...previousPanes];
  const nextPanes = [...activePanes];

  await withWriteLock(async () => {
    const sessionProjectRoot = path.dirname(path.dirname(panesFile));
    const panes = await persistPaneConfigDelta(
      sessionProjectRoot,
      originatingPanes,
      nextPanes,
    );
    LogService.getInstance().debug(
      `Writing config with ${panes.length} panes`,
      'shellDetection'
    );
    LogService.getInstance().debug('Config file written successfully', 'shellDetection');
  });
}

/**
 * Applies a caller's snapshot delta to the fresh config while the project-wide
 * lease is held. Unrelated panes written by the daemon remain untouched.
 */
async function persistPaneConfigDelta(
  projectRoot: string,
  previousPanes: readonly PsychePane[],
  nextPanes: readonly PsychePane[],
): Promise<PsychePane[]> {
  const mutation = await mutateProjectPaneConfig(projectRoot, (configRecord) => {
    const config = configRecord as unknown as PsycheConfig;
    const mergedPanes = mergePaneSnapshots(
      Array.isArray(config.panes) ? config.panes : [],
      previousPanes,
      nextPanes,
    );
    const effectiveProjectRoot = config.projectRoot || projectRoot;
    const projectName = config.projectName || path.basename(effectiveProjectRoot);
    const normalizedSidebarProjects = normalizeSidebarProjects(
      config.sidebarProjects,
      mergedPanes,
      effectiveProjectRoot,
      projectName,
    );
    config.sidebarProjects = normalizedSidebarProjects;
    config.panes = syncPaneColorThemes(
      mergedPanes,
      normalizedSidebarProjects,
      effectiveProjectRoot,
    );
    config.lastUpdated = new Date().toISOString();
    return config.panes;
  });
  return mutation.result as PsychePane[];
}

/**
 * Reconciles an originating UI snapshot with the fresh registry. A pane that
 * disappeared after the snapshot is not resurrected by a stale update; a
 * newly added ID is the explicit re-addition case.
 */
export function mergePaneSnapshots(
  freshPanes: readonly PsychePane[],
  previousPanes: readonly PsychePane[],
  nextPanes: readonly PsychePane[],
): PsychePane[] {
  const previousById = new Map(previousPanes.map((pane) => [pane.id, pane]));
  const nextById = new Map(nextPanes.map((pane) => [pane.id, pane]));
  const explicitlyRemoved = new Set(
    previousPanes
      .filter((pane) => !nextById.has(pane.id))
      .map((pane) => pane.id),
  );
  const freshIds = new Set(freshPanes.map((pane) => pane.id));
  const merged: PsychePane[] = [];

  for (const freshPane of freshPanes) {
    if (explicitlyRemoved.has(freshPane.id)) {
      continue;
    }

    const nextPane = nextById.get(freshPane.id);
    const previousPane = previousById.get(freshPane.id);
    if (nextPane && previousPane) {
      const delta = getPanePropertyDelta(previousPane, nextPane);
      merged.push(
        delta
          ? applyPanePropertyDelta(freshPane, delta)
          : freshPane
      );
    } else if (nextPane && !previousPane) {
      // A pane newly introduced by this caller has no originating record from
      // which to derive a property-level intent, so it remains an explicit
      // full-record addition.
      merged.push(nextPane);
    } else {
      merged.push(freshPane);
    }
  }

  for (const nextPane of nextPanes) {
    if (!previousById.has(nextPane.id) && !freshIds.has(nextPane.id)) {
      merged.push(nextPane);
    }
  }

  return merged;
}

interface PanePropertyDelta {
  changed: Map<string, unknown>;
  deleted: Set<string>;
}

/**
 * Returns only the caller's intent between two snapshots of the same pane.
 *
 * Deletion semantics are intentional: a property is cleared when it had a
 * defined value in the originating snapshot and is absent or `undefined` in
 * the next snapshot. Properties absent (or undefined) in both snapshots have
 * no local intent and therefore cannot erase a concurrently persisted value.
 */
function getPanePropertyDelta(
  previousPane: PsychePane,
  nextPane: PsychePane,
): PanePropertyDelta | undefined {
  const changed = new Map<string, unknown>();
  const deleted = new Set<string>();
  const properties = new Set([
    ...Object.keys(previousPane),
    ...Object.keys(nextPane),
  ]);

  for (const property of properties) {
    if (property === 'id') {
      continue;
    }

    const hadPreviousValue = hasOwnProperty(previousPane, property);
    const hasNextValue = hasOwnProperty(nextPane, property);
    const previousValue = (previousPane as unknown as Record<string, unknown>)[property];
    const nextValue = (nextPane as unknown as Record<string, unknown>)[property];

    if (
      hadPreviousValue
      && previousValue !== undefined
      && (!hasNextValue || nextValue === undefined)
    ) {
      deleted.add(property);
      continue;
    }

    if (
      hasNextValue
      && nextValue !== undefined
      && (
        !hadPreviousValue
        || previousValue === undefined
        || !panePropertyValuesEqual(previousValue, nextValue)
      )
    ) {
      changed.set(property, nextValue);
    }
  }

  if (changed.size === 0 && deleted.size === 0) {
    return undefined;
  }

  return { changed, deleted };
}

function applyPanePropertyDelta(
  freshPane: PsychePane,
  delta: PanePropertyDelta,
): PsychePane {
  const mergedPane = {
    ...freshPane,
  } as Record<string, unknown>;

  for (const property of delta.deleted) {
    delete mergedPane[property];
  }
  for (const [property, value] of delta.changed) {
    mergedPane[property] = value;
  }

  return mergedPane as unknown as PsychePane;
}

function hasOwnProperty(value: object, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function panePropertyValuesEqual(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Handles cleanup when the last pane is removed
 * Recreates welcome pane and recalculates layout
 */
export async function handleLastPaneRemoval(projectRoot: string): Promise<void> {
  const { handleLastPaneRemoved } = await import('../utils/postPaneCleanup.js');
  await handleLastPaneRemoved(projectRoot);
}

/**
 * Destroys welcome pane when panes are added
 */
export async function destroyWelcomePaneIfNeeded(
  panesFile: string,
  currentPaneCount: number,
  newPaneCount: number
): Promise<void> {
  const shouldDestroyWelcome = currentPaneCount === 0 && newPaneCount > 0;
  if (!shouldDestroyWelcome) return;

  try {
    const sessionProjectRoot = path.dirname(path.dirname(panesFile));
    await mutateProjectPaneConfig(sessionProjectRoot, async (configRecord) => {
      const config = configRecord as { welcomePaneId?: string; lastUpdated?: string };
      if (!config.welcomePaneId) {
        return;
      }
      LogService.getInstance().debug(
        `Destroying welcome pane ${config.welcomePaneId} because panes were added`,
        'shellDetection'
      );
      const { destroyWelcomePane } = await import('../utils/welcomePane.js');
      await destroyWelcomePane(config.welcomePaneId);
      config.welcomePaneId = undefined;
      config.lastUpdated = new Date().toISOString();
    });
  } catch (error) {
    LogService.getInstance().debug('Failed to destroy welcome pane', 'shellDetection');
  }
}
