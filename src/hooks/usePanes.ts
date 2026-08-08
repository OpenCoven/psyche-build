import { useEffect, useState, useRef } from 'react';
import path from 'path';
import PQueue from 'p-queue';
import type { PsycheConfig, PsychePane, SavePanes, SidebarProject } from '../types.js';
import { LogService } from '../services/LogService.js';
import { PANE_POLLING_INTERVAL } from '../constants/timing.js';
import {
  loadAndProcessPanes,
  loadSidebarProjectsFromFile,
  recreateKilledWorktreePanes,
  fetchTmuxPaneIds,
} from './usePaneLoading.js';
import {
  enforcePaneTitles,
  savePanesToFile,
  rebindAndFilterPanes,
  saveUpdatedPaneConfig,
  handleLastPaneRemoval,
  destroyWelcomePaneIfNeeded,
} from './usePaneSync.js';
import {
  detectAndAddShellPanes,
} from './useShellDetection.js';
import { rebindPaneByTitle } from '../utils/paneRebinding.js';
import { PaneEventService, type PaneEventMode } from '../services/PaneEventService.js';
import { enforceControlPaneSize } from '../utils/tmux.js';
import { SIDEBAR_WIDTH } from '../utils/layoutManager.js';
import { normalizeSidebarProjects } from '../utils/sidebarProjects.js';
import { syncPaneColorThemes } from '../utils/paneColors.js';
import {
  compareAndRemoveProjectPaneConfigPaneIdentities,
  mutateProjectPaneConfig,
  removeProjectPaneConfigPaneIdentities,
  removeProjectPaneConfigPanes,
} from '../services/ProjectPaneConfig.js';
import type { PaneLifecycleIdentity } from '../actions/types.js';

// Use p-queue for proper concurrency control instead of manual write lock
// This prevents race conditions and provides better visibility into queue state
const configQueue = new PQueue({ concurrency: 1 });

async function withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  return configQueue.add(operation);
}

export interface UsePanesOptions {
  panesFile: string;
  skipLoading: boolean;
  sessionName: string;
  controlPaneId?: string;
  useHooks?: boolean; // undefined = not yet decided, true = use hooks, false = use polling
}

export default function usePanes(
  panesFile: string,
  skipLoading: boolean,
  sessionName?: string,
  controlPaneId?: string,
  useHooks?: boolean // undefined = not yet decided, true = use hooks, false = use polling
) {
  const [panes, setPanes] = useState<PsychePane[]>([]);
  const panesRef = useRef<PsychePane[]>([]);
  const [sidebarProjects, setSidebarProjects] = useState<SidebarProject[]>([]);
  const sidebarProjectsRef = useRef<SidebarProject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [eventMode, setEventMode] = useState<PaneEventMode>('disabled');
  const initialLoadComplete = useRef(false);
  const isLoadingPanes = useRef(false); // Guard against concurrent loadPanes calls
  const pendingLoad = useRef(false);
  const paneEventService = useRef(PaneEventService.getInstance());

  useEffect(() => {
    panesRef.current = panes;
  }, [panes]);

  useEffect(() => {
    sidebarProjectsRef.current = sidebarProjects;
  }, [sidebarProjects]);

  const loadPanes = async () => {
    if (skipLoading) return;

    // Prevent concurrent loadPanes calls which can cause race conditions
    // and duplicate pane detection
    if (isLoadingPanes.current) {
      pendingLoad.current = true;
      return;
    }
    isLoadingPanes.current = true;

    try {
      do {
        pendingLoad.current = false;

        // Load panes from file and rebind IDs based on tmux state
        const { panes: loadedPanes, allPaneIds, titleToId } = await loadAndProcessPanes(
          panesFile,
          !initialLoadComplete.current
        );
        const loadedSidebarProjects = await loadSidebarProjectsFromFile(panesFile, loadedPanes);

        // For initial load, set the loaded panes and mark as complete
        if (!initialLoadComplete.current) {
          panesRef.current = loadedPanes;
          setPanes(loadedPanes);
          sidebarProjectsRef.current = loadedSidebarProjects;
          setSidebarProjects(loadedSidebarProjects);
          initialLoadComplete.current = true;
          break; // Exit loop after initial load — pending loads are handled by the next polling/event cycle
        }

        // Rebind and filter panes (removes dead shell panes, keeps worktree panes)
        const { activePanes, shellPanesRemoved, worktreePanesToRecreate } = rebindAndFilterPanes(
          loadedPanes,
          titleToId,
          allPaneIds,
          !initialLoadComplete.current
        );

        // Recreate worktree panes that were killed (e.g., via Ctrl+b x)
        let finalPanes = activePanes;
        if (worktreePanesToRecreate.length > 0) {
          finalPanes = await recreateKilledWorktreePanes(activePanes, allPaneIds, panesFile);

          // Re-fetch pane IDs after recreation
          const freshData = await fetchTmuxPaneIds();
          const updatedIds = freshData.allPaneIds;
          const updatedTitleToId = freshData.titleToId;

          // Re-rebind after recreation using the utility function
          finalPanes = finalPanes.map(p => rebindPaneByTitle(p, updatedTitleToId, updatedIds));
        }

        // Detect untracked panes (only after initial load)
        let shellPanesAdded = false;
        if (initialLoadComplete.current) {
          const { updatedPanes, shellPanesAdded: added } = await detectAndAddShellPanes(
            panesFile,
            finalPanes,
            allPaneIds
          );
          finalPanes = updatedPanes;
          shellPanesAdded = added;
        }

        const nextSidebarProjects = await loadSidebarProjectsFromFile(panesFile, finalPanes);

        // Destroy welcome pane if transitioning from 0 to >0 panes
        await destroyWelcomePaneIfNeeded(panesFile, panesRef.current.length, finalPanes.length);

        // Enforce tmux pane titles so they keep a stable rebinding key while
        // reflecting any user-defined display names in the visible border title.
        await enforcePaneTitles(finalPanes, allPaneIds, controlPaneId);

        // Check if panes changed (compare IDs and paneIds only)
        const currentPaneIds = panesRef.current.map(p => `${p.id}:${p.paneId}`).sort().join(',');
        const newPaneIds = finalPanes.map(p => `${p.id}:${p.paneId}`).sort().join(',');

        // Check if IDs were remapped
        const idsChanged = finalPanes.some((pane, idx) =>
          loadedPanes[idx] && loadedPanes[idx].paneId !== pane.paneId
        );
        const sidebarProjectsChanged = JSON.stringify(sidebarProjectsRef.current)
          !== JSON.stringify(nextSidebarProjects);

        // Update state and save if panes changed OR if shell panes were added/removed
        if (
          currentPaneIds !== newPaneIds ||
          shellPanesAdded ||
          shellPanesRemoved ||
          sidebarProjectsChanged
        ) {
          panesRef.current = finalPanes;
          setPanes(finalPanes);
          if (sidebarProjectsChanged) {
            sidebarProjectsRef.current = nextSidebarProjects;
            setSidebarProjects(nextSidebarProjects);
          }

          // Save to file if IDs were remapped OR if shell panes were added/removed
          if (idsChanged || shellPanesAdded || shellPanesRemoved) {
            await saveUpdatedPaneConfig(
              panesFile,
              finalPanes,
              withWriteLock,
              loadedPanes,
            );

            if (shellPanesRemoved) {
              // If shell panes were removed and we now have 0 panes, recreate welcome pane.
              if (finalPanes.length === 0) {
                const sessionProjectRoot = path.dirname(path.dirname(panesFile));
                await handleLastPaneRemoval(sessionProjectRoot);
              } else if (controlPaneId) {
                // Manual shell exits bypass closeAction's layout recalc path.
                // Re-apply layout so adjacent panes are rebalanced.
                try {
                  await enforceControlPaneSize(controlPaneId, SIDEBAR_WIDTH);
                } catch (error) {
                  LogService.getInstance().debug(
                    `Layout rebalance after shell close failed: ${error instanceof Error ? error.message : String(error)}`,
                    'usePanes'
                  );
                }
              }
            }
          }
        }
      } while (pendingLoad.current);
    } catch (error) {
      // Silently ignore errors during pane loading to prevent UI crashes
      // Most common errors are transient tmux state issues that resolve on next poll
      LogService.getInstance().debug(
        `Error loading panes: ${error instanceof Error ? error.message : String(error)}`,
        'usePanes'
      );
    } finally {
      isLoadingPanes.current = false;
      if (isLoading) setIsLoading(false);
    }
  };

  const savePanes: SavePanes = async (newPanes, previousPanes) => {
    const updatedPanes = await savePanesToFile(
      panesFile,
      newPanes,
      withWriteLock,
      previousPanes,
    );
    panesRef.current = updatedPanes;
    setPanes(updatedPanes);

    const fallbackProjectRoot = path.dirname(path.dirname(panesFile));
    const nextSidebarProjects = normalizeSidebarProjects(
      sidebarProjectsRef.current,
      updatedPanes,
      fallbackProjectRoot,
      path.basename(fallbackProjectRoot)
    );
    if (JSON.stringify(sidebarProjectsRef.current) !== JSON.stringify(nextSidebarProjects)) {
      sidebarProjectsRef.current = nextSidebarProjects;
      setSidebarProjects(nextSidebarProjects);
    }
  };

  const removePanesFromConfig = async (
    paneIds: Iterable<string>,
  ): Promise<PsychePane[]> => {
    return withWriteLock(async () => {
      const ids = new Set(
        Array.from(paneIds).filter((paneId) => typeof paneId === 'string' && paneId.length > 0),
      );
      const fallbackProjectRoot = path.dirname(path.dirname(panesFile));
      await removeProjectPaneConfigPanes(fallbackProjectRoot, ids);
      const mutation = await mutateProjectPaneConfig(
        fallbackProjectRoot,
        (configRecord) => {
          const config = configRecord as unknown as PsycheConfig;
          const projectRoot = config.projectRoot || fallbackProjectRoot;
          const projectName = config.projectName || path.basename(projectRoot);
          const freshPanes = Array.isArray(config.panes) ? config.panes : [];
          const normalizedProjects = normalizeSidebarProjects(
            config.sidebarProjects,
            freshPanes,
            projectRoot,
            projectName
          );

          // Close is intentionally a targeted config mutation: preserve every
          // fresh pane record unchanged and remove only the pane that closed.
          config.sidebarProjects = normalizedProjects;
          config.lastUpdated = new Date().toISOString();
          return {
            panes: freshPanes,
            sidebarProjects: normalizedProjects,
          };
        }
      );
      const persistedPanes = mutation.result.panes;
      panesRef.current = persistedPanes;
      setPanes(persistedPanes);
      sidebarProjectsRef.current = mutation.result.sidebarProjects;
      setSidebarProjects(mutation.result.sidebarProjects);
      return persistedPanes;
    });
  };

  const removePaneFromConfig = async (paneId: string): Promise<PsychePane[]> => {
    return removePanesFromConfig([paneId]);
  };

  const removePaneIdentitiesFromConfig = async (
    identities: Iterable<PaneLifecycleIdentity>,
    beforeRemove?: (
      panes?: readonly PsychePane[],
      exactPanes?: readonly PsychePane[],
    ) => Promise<void> | void,
  ): Promise<PsychePane[]> => {
    return withWriteLock(async () => {
      const fallbackProjectRoot = path.dirname(path.dirname(panesFile));
      try {
        await compareAndRemoveProjectPaneConfigPaneIdentities(
          fallbackProjectRoot,
          identities,
          beforeRemove
            ? (freshPanes, exactPanes) => beforeRemove(
              freshPanes as PsychePane[],
              exactPanes as PsychePane[],
            )
            : undefined,
        );
        const mutation = await mutateProjectPaneConfig(
          fallbackProjectRoot,
          (configRecord) => {
            const config = configRecord as unknown as PsycheConfig;
            const projectRoot = config.projectRoot || fallbackProjectRoot;
            const projectName = config.projectName || path.basename(projectRoot);
            const freshPanes = Array.isArray(config.panes) ? config.panes : [];
            const normalizedProjects = normalizeSidebarProjects(
              config.sidebarProjects,
              freshPanes,
              projectRoot,
              projectName,
            );
            config.sidebarProjects = normalizedProjects;
            config.lastUpdated = new Date().toISOString();
            return {
              panes: freshPanes,
              sidebarProjects: normalizedProjects,
            };
          },
        );
        const persistedPanes = mutation.result.panes;
        panesRef.current = persistedPanes;
        setPanes(persistedPanes);
        sidebarProjectsRef.current = mutation.result.sidebarProjects;
        setSidebarProjects(mutation.result.sidebarProjects);
        return persistedPanes;
      } catch (error) {
        // Exact-identity failures are intentionally non-destructive, but the
        // in-memory UI is now stale by definition. Reload it before surfacing
        // the failure so a concurrent rebind becomes visible immediately.
        await loadPanes();
        throw error;
      }
    });
  };

  const saveSidebarProjects = async (newSidebarProjects: SidebarProject[]) => {
    return withWriteLock(async () => {
      const fallbackProjectRoot = path.dirname(path.dirname(panesFile));
      const mutation = await mutateProjectPaneConfig(
        fallbackProjectRoot,
        (configRecord) => {
          const config = configRecord as unknown as PsycheConfig;
          const projectRoot = config.projectRoot || fallbackProjectRoot;
          const projectName = config.projectName || path.basename(projectRoot);
          const freshPanes = Array.isArray(config.panes) ? config.panes : [];
          const normalizedProjects = normalizeSidebarProjects(
            newSidebarProjects,
            freshPanes,
            projectRoot,
            projectName
          );
          const syncedPanes = syncPaneColorThemes(
            freshPanes,
            normalizedProjects,
            projectRoot
          );

          config.panes = syncedPanes;
          config.sidebarProjects = normalizedProjects;
          config.lastUpdated = new Date().toISOString();
          return { normalizedProjects, syncedPanes };
        }
      );
      const { normalizedProjects, syncedPanes } = mutation.result;

      if (panesRef.current !== syncedPanes) {
        panesRef.current = syncedPanes;
        setPanes(syncedPanes);
      }
      sidebarProjectsRef.current = normalizedProjects;
      setSidebarProjects(normalizedProjects);
      return normalizedProjects;
    });
  };

  // Initialize PaneEventService when session info is available
  useEffect(() => {
    if (!sessionName) return;

    const service = paneEventService.current;
    service.initialize({
      sessionName,
      controlPaneId,
      pollInterval: PANE_POLLING_INTERVAL,
    });

    return () => {
      // Cleanup on unmount
      service.stop();
    };
  }, [sessionName, controlPaneId]);

  // Start event-driven updates when useHooks preference is determined
  useEffect(() => {
    if (!sessionName || useHooks === undefined) return;

    const service = paneEventService.current;

    const startEvents = async () => {
      try {
        const mode = await service.start(useHooks);
        setEventMode(mode);
        LogService.getInstance().info(
          `Pane event mode: ${mode}`,
          'paneEvents'
        );
      } catch (error) {
        LogService.getInstance().error(
          `Failed to start pane events: ${error}`,
          'paneEvents'
        );
        // Fall back to polling with interval
        setEventMode('polling');
      }
    };

    startEvents();

    return () => {
      service.stop();
    };
  }, [sessionName, useHooks]);

  // Subscribe to pane change events from PaneEventService
  useEffect(() => {
    if (skipLoading) return;

    const service = paneEventService.current;

    // Initial load
    loadPanes();

    // Subscribe to pane change events
    const unsubscribe = service.onPanesChanged(() => {
      LogService.getInstance().debug('Pane change event received', 'paneEvents');
      loadPanes();
    });

    // Listen for pane split events from SIGUSR2 signal (legacy support)
    const handlePaneSplit = () => {
      LogService.getInstance().debug('Pane split event received, triggering immediate detection', 'shellDetection');
      loadPanes();
      // Also trigger a force check on the service
      service.forceCheck();
    };
    process.on('pane-split-detected' as any, handlePaneSplit);

    // Keep a backup polling interval for resilience
    // This is much longer when hooks are active
    const backupInterval = setInterval(() => {
      loadPanes();
    }, eventMode === 'hooks' ? 30000 : PANE_POLLING_INTERVAL); // 30s backup for hooks, 5s for polling

    return () => {
      unsubscribe();
      clearInterval(backupInterval);
      process.off('pane-split-detected' as any, handlePaneSplit);
    };
  }, [skipLoading, panesFile, eventMode]);

  return {
    panes,
    setPanes,
    sidebarProjects,
    isLoading,
    loadPanes,
    savePanes,
    removePaneFromConfig,
    removePanesFromConfig,
    removePaneIdentitiesFromConfig,
    saveSidebarProjects,
    eventMode,
  } as const;
}
