import fs from 'fs/promises';
import path from 'path';
import type { PsychePane, SidebarProject } from '../types.js';
import { splitPane } from '../utils/tmux.js';
import {
  paneTmuxIdentityIsCurrent,
  rebindPaneByTitle,
} from '../utils/paneRebinding.js';
import { LogService } from '../services/LogService.js';
import { TmuxService } from '../services/TmuxService.js';
import {
  sameTmuxServerIdentity,
  type TmuxServerIdentity,
} from '../services/TmuxServerIdentity.js';
import { PaneLifecycleManager } from '../services/PaneLifecycleManager.js';
import { TMUX_COMMAND_TIMEOUT, TMUX_RETRY_DELAY } from '../constants/timing.js';
import { syncPaneColorThemes } from '../utils/paneColors.js';
import { buildAgentResumeOrLaunchCommand } from '../utils/agentLaunch.js';
import { ensureGeminiFolderTrusted } from '../utils/geminiTrust.js';
import {
  buildCodexHookedCommand,
  installCodexPaneHooks,
} from '../utils/codexHooks.js';
import { getPaneTmuxTitle } from '../utils/paneTitle.js';
import {
  getVisiblePanes,
  syncHiddenStateFromCurrentWindow,
} from '../utils/paneVisibility.js';
import { normalizeSidebarProjects } from '../utils/sidebarProjects.js';
import { SPACER_PANE_TITLE } from '../constants/layout.js';
import {
  mutateProjectPaneConfig,
  projectPaneConfigPath,
  type ProjectPaneConfigPaneIdentity,
  removeProjectPaneConfigPaneIdentities,
  replaceProjectPaneConfigPaneIdentity,
} from '../services/ProjectPaneConfig.js';
import { WorktreeCleanupService } from '../services/WorktreeCleanupService.js';
import {
  paneRecoveryInstructions,
  tearDownPaneWithVerification,
  type TmuxPanePresence,
} from '../utils/paneTeardown.js';
import { retainPaneRecovery } from '../utils/paneLifecycleRecovery.js';
import { indexUniquePaneTitles } from '../utils/paneTitleIndex.js';

// Separate config structure to match new format
export interface PsycheConfig {
  projectName?: string;
  projectRoot?: string;
  panes: PsychePane[];
  sidebarProjects?: SidebarProject[];
  settings?: any;
  lastUpdated?: string;
  controlPaneId?: string;
  welcomePaneId?: string;
}

/**
 * Compatibility migration for records written while background windows only
 * had window IDs. Recovery records created by newer clients can carry the
 * durable pane identity, so hydrate it without discarding legacy window
 * ownership when loading a mixed-version project config.
 */
export function migrateBackgroundPaneResources(pane: PsychePane): PsychePane {
  const recoveries = Array.isArray(pane.backgroundWindowRecoveries)
    ? pane.backgroundWindowRecoveries
    : [];
  const testRecovery = recoveries.find((recovery) => (
    recovery.type === 'test' && recovery.windowId === pane.testWindowId
  ));
  const devRecovery = recoveries.find((recovery) => (
    recovery.type === 'dev' && recovery.windowId === pane.devWindowId
  ));
  return {
    ...pane,
    ...(
      !pane.testPaneId && testRecovery?.paneId
        ? { testPaneId: testRecovery.paneId }
        : {}
    ),
    ...(
      !pane.testTmuxServerIdentity && testRecovery?.tmuxServerIdentity
        ? { testTmuxServerIdentity: testRecovery.tmuxServerIdentity }
        : {}
    ),
    ...(
      !pane.devPaneId && devRecovery?.paneId
        ? { devPaneId: devRecovery.paneId }
        : {}
    ),
    ...(
      !pane.devTmuxServerIdentity && devRecovery?.tmuxServerIdentity
        ? { devTmuxServerIdentity: devRecovery.tmuxServerIdentity }
        : {}
    ),
  };
}

interface PaneLoadResult {
  panes: PsychePane[];
  allPaneIds: string[];
  titleToId: Map<string, string>;
}

async function restoreAgentSessionForPane(
  tmuxService: TmuxService,
  pane: PsychePane,
  paneId: string
): Promise<void> {
  if (!pane.agent) {
    return;
  }

  if (pane.agent === 'gemini' && pane.worktreePath) {
    ensureGeminiFolderTrusted(pane.worktreePath);
  }

  await new Promise((resolve) => setTimeout(resolve, 200));
  let command = buildAgentResumeOrLaunchCommand(pane.agent, pane.permissionMode);

  if (pane.agent === 'codex' && pane.worktreePath) {
    let codexHookEventFile: string | undefined;
    try {
      codexHookEventFile = installCodexPaneHooks({
        worktreePath: pane.worktreePath,
        psychePaneId: pane.id,
        tmuxPaneId: paneId,
      }).eventFile;
    } catch {
      // Hook installation is best effort; Codex can still resume normally.
    }

    command = buildCodexHookedCommand(command, {
      psychePaneId: pane.id,
      tmuxPaneId: paneId,
      eventFile: codexHookEventFile,
    });
  }

  await tmuxService.sendShellCommand(paneId, command);
  await tmuxService.sendTmuxKeys(paneId, 'Enter');
}

class RestoreReservationRetentionError extends Error {}

/**
 * Fetches all tmux pane IDs and titles for the current session
 * Retries up to maxRetries times with delay between attempts
 */
export async function fetchTmuxPaneIds(maxRetries = 2): Promise<{
  allPaneIds: string[];
  titleToId: Map<string, string>;
  currentWindowPaneIds: string[];
}> {
  const tmuxService = TmuxService.getInstance();
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      const paneInfo = await tmuxService.getAllPaneInfo('session');
      const currentWindowPaneIds = await tmuxService.getAllPaneIds('window');
      const { allPaneIds, titleToId } = indexUniquePaneTitles(
        paneInfo,
        SPACER_PANE_TITLE,
      );

      if (allPaneIds.length > 0 || retryCount === maxRetries) {
        return { allPaneIds, titleToId, currentWindowPaneIds };
      }
    } catch (error) {
      // Retry on tmux command failure (common during rapid pane creation/destruction)
  //       LogService.getInstance().debug(
  //         `Tmux fetch failed (attempt ${retryCount + 1}/${maxRetries}): ${error instanceof Error ? error.message : String(error)}`,
  //         'usePaneLoading'
  //       );
      if (retryCount < maxRetries) await new Promise(r => setTimeout(r, TMUX_RETRY_DELAY));
    }
    retryCount++;
  }

  return { allPaneIds: [], titleToId: new Map(), currentWindowPaneIds: [] };
}

/**
 * Reads and parses the panes config file
 * Handles both old array format and new config format
 */
export async function loadPanesFromFile(panesFile: string): Promise<PsychePane[]> {
  const fallbackProjectRoot = path.dirname(path.dirname(panesFile));

  try {
    const content = await fs.readFile(panesFile, 'utf-8');
    const parsed: any = JSON.parse(content);

    if (Array.isArray(parsed)) {
      return syncPaneColorThemes(
        (parsed as PsychePane[]).map(migrateBackgroundPaneResources),
        [],
        fallbackProjectRoot,
      );
    } else {
      const config = parsed as PsycheConfig;
      const projectRoot = config.projectRoot || fallbackProjectRoot;
      const panes = Array.isArray(config.panes)
        ? config.panes.map(migrateBackgroundPaneResources)
        : [];
      const sidebarProjects = Array.isArray(config.sidebarProjects) ? config.sidebarProjects : [];
      return syncPaneColorThemes(panes, sidebarProjects, projectRoot);
    }
  } catch (error) {
    // Return empty array if config file doesn't exist or is invalid
    // This is expected on first run
  //     LogService.getInstance().debug(
  //       `Config file not found or invalid: ${error instanceof Error ? error.message : String(error)}`,
  //       'usePaneLoading'
  //     );
    return [];
  }
}

export async function loadSidebarProjectsFromFile(
  panesFile: string,
  panes?: PsychePane[]
): Promise<SidebarProject[]> {
  const fallbackProjectRoot = path.dirname(path.dirname(panesFile));

  try {
    const content = await fs.readFile(panesFile, 'utf-8');
    const parsed: any = JSON.parse(content);
    const config = Array.isArray(parsed)
      ? { panes: parsed as PsychePane[] }
      : parsed as PsycheConfig;
    const configPanes = Array.isArray(config.panes) ? config.panes : [];
    const effectivePanes = panes || configPanes;
    const projectRoot = config.projectRoot || fallbackProjectRoot;
    const projectName = config.projectName || path.basename(projectRoot);

    return normalizeSidebarProjects(
      config.sidebarProjects,
      effectivePanes,
      projectRoot,
      projectName
    );
  } catch {
    return normalizeSidebarProjects(
      undefined,
      panes || [],
      fallbackProjectRoot,
      path.basename(fallbackProjectRoot)
    );
  }
}

/**
 * Recreates missing worktree panes that exist in config but not in tmux
 * Only called on initial load
 */
export async function recreateMissingPanes(
  missingPanes: PsychePane[],
  panesFile: string
): Promise<void> {
  if (missingPanes.length === 0) return;

  const tmuxService = TmuxService.getInstance();
  const sessionProjectRoot = path.dirname(path.dirname(panesFile));

  for (const missingPane of missingPanes) {
    try {
      await restoreMissingPaneWithLease(
        tmuxService,
        missingPane,
        sessionProjectRoot,
      );
    } catch (error) {
      LogService.getInstance().warn(
        `Failed to restore pane ${missingPane.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'usePaneLoading',
        missingPane.id,
      );
    }
  }

  // Apply even-horizontal layout after creating panes
  try {
    await tmuxService.selectLayout('even-horizontal');
    await tmuxService.refreshClient();
  } catch {}
}

async function restoreMissingPaneWithLease(
  tmuxService: TmuxService,
  missingPane: PsychePane,
  sessionProjectRoot: string,
): Promise<void> {
  if (!missingPane.worktreePath) {
    throw new Error('Cannot restore a worktree pane without its worktree path');
  }

  const expected = {
    id: missingPane.id,
    paneId: missingPane.paneId,
    ...(missingPane.tmuxServerIdentity
      ? { tmuxServerIdentity: missingPane.tmuxServerIdentity }
      : {}),
  };
  const reservation = await WorktreeCleanupService.getInstance().beginWorktreeReuseReservation(
    missingPane.worktreePath,
    missingPane.projectRoot || sessionProjectRoot,
  );
  let reservationSettled = false;
  let retainDestructiveProtection = false;

  try {
    const worktreePath = reservation.canonicalWorktreePath;
    const newPaneId = splitPane({ cwd: worktreePath });
    const tmuxServerIdentity = tmuxService.getServerIdentity?.(newPaneId);
    if (!tmuxServerIdentity) {
      const unversionedPane: PsychePane = {
        ...missingPane,
        paneId: newPaneId,
        worktreePath,
      };
      const teardown = await tearDownRestoredPane(
        tmuxService,
        newPaneId,
        tmuxServerIdentity,
      );
      if (teardown.presence === 'absent') {
        throw new Error(
          `Could not capture tmux server generation for restored pane ${missingPane.id}`,
        );
      }
      const recovery = await retainPaneRecovery({
        projectRoot: sessionProjectRoot,
        sessionProjectRoot,
        pane: unversionedPane,
        operation: 'pane-restoration-generation',
        reason: `could not capture tmux server generation; pane teardown is ${teardown.presence}`,
        reservation,
        persistConfigRecovery: async () => ({
          durable: false,
          message: 'refused to persist an unversioned restored pane record',
        }),
      });
      retainDestructiveProtection = recovery.retained;
      throw new RestoreReservationRetentionError(
        `Could not capture tmux server generation for restored pane ${missingPane.id}; ${recovery.message}`,
      );
    }
    const reboundPane: PsychePane = {
      ...missingPane,
      paneId: newPaneId,
      tmuxServerIdentity,
      worktreePath,
    };

    try {
      await tmuxService.setPaneTitle(
        newPaneId,
        getPaneTmuxTitle(reboundPane, sessionProjectRoot),
      );
    } catch {
      // The title is only a rebinding aid; lifecycle safety comes from config.
    }

    try {
      const replacement = await replaceProjectPaneConfigPaneIdentity(
        sessionProjectRoot,
        expected,
        reboundPane,
      );
      // Object.assign alone would retain removed old-generation test/dev
      // fields on the caller's in-memory object. Replace the exact object
      // contents so the restored pane cannot target stale resource IDs before
      // the next config reload.
      const mutableMissingPane = missingPane as unknown as Record<string, unknown>;
      for (const key of Object.keys(mutableMissingPane)) {
        delete mutableMissingPane[key];
      }
      Object.assign(missingPane, replacement.result as PsychePane);
    } catch (error) {
      const persistenceError = error instanceof Error ? error.message : String(error);
      const teardown = await tearDownRestoredPane(
        tmuxService,
        newPaneId,
        tmuxServerIdentity,
      );
      if (teardown.presence === 'absent') {
        throw new Error(
          `Failed to persist restored pane ${missingPane.id}: ${persistenceError}`,
        );
      }

      const recovery = await persistRestoredPaneRecovery(
        sessionProjectRoot,
        expected,
        reboundPane,
      );
      const message = `Failed to persist restored pane ${missingPane.id}: ${persistenceError}; pane teardown is ${teardown.presence}; ${recovery.message}`;
      if (!recovery.durable) {
        retainDestructiveProtection = true;
        throw new RestoreReservationRetentionError(message);
      }
      throw new Error(message);
    }

    // The exact rebound identity is durable before the resumed process can
    // receive any command. From this point the record protects the worktree.
    await reservation.complete();
    reservationSettled = true;

    await tmuxService.sendKeys(newPaneId, `"echo '# Pane restored: ${missingPane.slug}'" Enter`);
    const promptPreview = missingPane.prompt?.substring(0, 50) || '';
    await tmuxService.sendKeys(newPaneId, `"echo '# Original prompt: ${promptPreview}...'" Enter`);
    await tmuxService.sendKeys(newPaneId, `"cd ${worktreePath}" Enter`);
    await restoreAgentSessionForPane(tmuxService, missingPane, newPaneId);
  } catch (error) {
    if (error instanceof RestoreReservationRetentionError) {
      throw new Error(error.message);
    }
    throw error;
  } finally {
    if (!reservationSettled && !retainDestructiveProtection) {
      await reservation.cancel();
    }
  }
}

async function tearDownRestoredPane(
  tmuxService: TmuxService,
  paneId: string,
  allocationIdentity: TmuxServerIdentity | undefined,
) {
  if (!allocationIdentity) {
    return {
      presence: 'unknown' as const,
      error: 'restored pane allocation has no tmux server generation',
    };
  }

  const currentIdentity = tmuxService.getServerIdentity?.();
  if (!currentIdentity) {
    return {
      presence: 'unknown' as const,
      error: 'current tmux server generation could not be verified',
    };
  }
  if (!sameTmuxServerIdentity(allocationIdentity, currentIdentity)) {
    // The resource was allocated by a previous server. A reused pane ID in
    // the replacement server must not receive a kill command.
    return { presence: 'absent' as const };
  }

  return tearDownPaneWithVerification({
    probe: async () => {
      const identity = tmuxService.getServerIdentity?.();
      if (!identity) {
        return 'unknown';
      }
      if (!sameTmuxServerIdentity(allocationIdentity, identity)) {
        return 'absent';
      }
      return probeRestoredPanePresence(tmuxService, paneId);
    },
    kill: async () => {
      // Revalidate immediately before the destructive command. The initial
      // probe may have raced a tmux restart that reused this pane ID.
      const identity = tmuxService.getServerIdentity?.();
      if (!identity) {
        throw new Error('current tmux server generation could not be verified');
      }
      if (!sameTmuxServerIdentity(allocationIdentity, identity)) {
        return;
      }
      await tmuxService.killPane(paneId);
    },
  });
}

async function probeRestoredPanePresence(
  tmuxService: TmuxService,
  paneId: string,
): Promise<TmuxPanePresence> {
  const probe = (tmuxService as TmuxService & {
    probePanePresence?: (id: string) => Promise<TmuxPanePresence>;
  }).probePanePresence;
  if (probe) {
    return probe.call(tmuxService, paneId);
  }

  try {
    return await tmuxService.paneExists(paneId) ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

async function persistRestoredPaneRecovery(
  sessionProjectRoot: string,
  expected: ProjectPaneConfigPaneIdentity,
  pane: PsychePane,
): Promise<{ durable: boolean; message: string }> {
  const configPath = projectPaneConfigPath(sessionProjectRoot);
  try {
    await replaceProjectPaneConfigPaneIdentity(
      sessionProjectRoot,
      expected,
      pane,
    );
    return {
      durable: true,
      message: `retained recovery record ${pane.id} in ${configPath}. ${
        paneRecoveryInstructions(pane.paneId, configPath)
      }`,
    };
  } catch (error) {
    return {
      durable: false,
      message: `could not persist recovery record ${pane.id}: ${
        error instanceof Error ? error.message : String(error)
      }. ${paneRecoveryInstructions(pane.paneId, configPath)}`,
    };
  }
}

/**
 * Recreates worktree panes that were killed by the user (e.g., via Ctrl+b x)
 * Called during periodic polling after initial load
 *
 * IMPORTANT: Checks PaneLifecycleManager to avoid recreating panes that are
 * being intentionally closed (prevents race condition with close/merge actions)
 */
export async function recreateKilledWorktreePanes(
  panes: PsychePane[],
  allPaneIds: string[],
  panesFile: string
): Promise<PsychePane[]> {
  const lifecycleManager = PaneLifecycleManager.getInstance();
  const sessionProjectRoot = path.dirname(path.dirname(panesFile));

  // Filter out panes that are being intentionally closed
  const worktreePanesToRecreate = panes.filter(pane => {
    // Pane must be missing from tmux and have a worktree path
    if (paneTmuxIdentityIsCurrent(pane, allPaneIds) || !pane.worktreePath) {
      return false;
    }

    // CRITICAL: Check if this pane is being intentionally closed
    // This is a safety belt - the main protection is that close action
    // removes pane from config BEFORE killing tmux pane
    if (lifecycleManager.isClosing(pane.id) || lifecycleManager.isClosing(pane.paneId)) {
      LogService.getInstance().debug(
        `Skipping recreation of pane ${pane.id} (${pane.slug}) - intentionally being closed`,
        'shellDetection'
      );
      return false;
    }

    return true;
  });

  if (worktreePanesToRecreate.length === 0) return panes;

  const tmuxService = TmuxService.getInstance();

  //   LogService.getInstance().debug(
  //     `Recreating ${worktreePanesToRecreate.length} killed worktree panes`,
  //     'shellDetection'
  //   );

  const updatedPanes = [...panes];

  for (const pane of worktreePanesToRecreate) {
    try {
      const paneIndex = updatedPanes.findIndex(p => p.id === pane.id);
      if (paneIndex === -1) {
        continue;
      }
      const reboundPane = { ...updatedPanes[paneIndex] };
      await restoreMissingPaneWithLease(
        tmuxService,
        reboundPane,
        sessionProjectRoot,
      );
      updatedPanes[paneIndex] = reboundPane;
    } catch (error) {
  //       LogService.getInstance().debug(
  //         `Failed to recreate worktree pane ${pane.id} (${pane.slug})`,
  //         'shellDetection'
  //       );
    }
  }

  // Recalculate layout after recreating panes
  try {
    const configContent = await fs.readFile(panesFile, 'utf-8');
    const config = JSON.parse(configContent);
    if (config.controlPaneId) {
      const { recalculateAndApplyLayout } = await import('../utils/layoutManager.js');
      const { getTerminalDimensions } = await import('../utils/tmux.js');
      const dimensions = getTerminalDimensions();

      const contentPaneIds = getVisiblePanes(updatedPanes).map(p => p.paneId);
      await recalculateAndApplyLayout(
        config.controlPaneId,
        contentPaneIds,
        dimensions.width,
        dimensions.height,
        panesFile,
      );

  //       LogService.getInstance().debug(
  //         `Recalculated layout after recreating worktree panes`,
  //         'shellDetection'
  //       );
    }
  } catch (error) {
  //     LogService.getInstance().debug(
  //       'Failed to recalculate layout after recreating worktree panes',
  //       'shellDetection'
  //     );
  }

  return updatedPanes;
}

export async function removeStaleShellPaneRecords(
  projectRoot: string,
  stalePanes: readonly PsychePane[],
): Promise<void> {
  await removeProjectPaneConfigPaneIdentities(
    projectRoot,
    stalePanes.map((pane) => ({
      id: pane.id,
      paneId: pane.paneId,
      ...(pane.tmuxServerIdentity
        ? { tmuxServerIdentity: pane.tmuxServerIdentity }
        : {}),
    })),
  );
}

/**
 * Loads panes from config file, rebinds IDs, and recreates missing panes
 * Returns the loaded and processed panes along with tmux state
 *
 * CRITICAL FIX: On initial load, stale shell panes are removed immediately.
 * Shell panes have no worktreePath so they cannot be recreated - keeping them
 * with stale paneIds causes psyche to hang when trying to interact with them.
 */
export async function loadAndProcessPanes(
  panesFile: string,
  isInitialLoad: boolean
): Promise<PaneLoadResult> {
  const loadedPanes = await loadPanesFromFile(panesFile);
  let { allPaneIds, titleToId, currentWindowPaneIds } = await fetchTmuxPaneIds();

  // Attempt to rebind panes whose IDs changed by matching on their stable tmux title.
  let reboundPanes = syncHiddenStateFromCurrentWindow(
    loadedPanes.map(p => rebindPaneByTitle(p, titleToId, allPaneIds)),
    currentWindowPaneIds
  );

  // CRITICAL FIX: On initial load, immediately filter out shell panes with stale IDs
  // Shell panes cannot be recreated (no worktreePath), so keeping them causes:
  // 1. Hang when trying to send keys to non-existent panes
  // 2. Hang when trying to get pane status/content
  // 3. "Invalid layout" errors when applying layouts with stale pane IDs
  if (isInitialLoad && allPaneIds.length > 0) {
    const staleShellPanes = reboundPanes.filter(
      p => p.type === 'shell' && !paneTmuxIdentityIsCurrent(p, allPaneIds)
    );

    if (staleShellPanes.length > 0) {
      LogService.getInstance().info(
        `Removing ${staleShellPanes.length} stale shell pane(s) on startup: ${staleShellPanes.map(p => p.slug).join(', ')}`,
        'usePaneLoading'
      );
      reboundPanes = reboundPanes.filter(
        p => !(p.type === 'shell' && !paneTmuxIdentityIsCurrent(p, allPaneIds))
      );

      // Save the cleaned config immediately to prevent these panes from reappearing
      try {
        const sessionProjectRoot = path.dirname(path.dirname(panesFile));
        await removeStaleShellPaneRecords(sessionProjectRoot, staleShellPanes);
        const mutation = await mutateProjectPaneConfig(
          sessionProjectRoot,
          (configRecord) => {
            const config = configRecord as unknown as PsycheConfig;
            const persistedPanes = Array.isArray(config.panes) ? config.panes : [];
            const projectRoot = config.projectRoot || sessionProjectRoot;
            const projectName = config.projectName || path.basename(projectRoot);
            config.panes = persistedPanes;
            config.sidebarProjects = normalizeSidebarProjects(
              config.sidebarProjects,
              persistedPanes,
              projectRoot,
              projectName
            );
            config.lastUpdated = new Date().toISOString();
            return persistedPanes;
          }
        );
        reboundPanes = mutation.result;
        LogService.getInstance().debug('Saved cleaned config after removing stale shell panes', 'usePaneLoading');
      } catch (saveError) {
        LogService.getInstance().debug(
          `Failed to save cleaned config: ${saveError}`,
          'usePaneLoading'
        );
      }
    }
  }

  // Only attempt to recreate missing panes on initial load (only worktree panes, not shell)
  const missingPanes = (allPaneIds.length > 0 && reboundPanes.length > 0 && isInitialLoad)
    ? reboundPanes.filter(pane =>
        !paneTmuxIdentityIsCurrent(pane, allPaneIds) && pane.type !== 'shell'
      )
    : [];

  // Recreate missing panes (only on initial load)
  await recreateMissingPanes(missingPanes, panesFile);

  // Re-fetch pane IDs after recreation
  if (missingPanes.length > 0) {
    const freshData = await fetchTmuxPaneIds();
    allPaneIds = freshData.allPaneIds;
    titleToId = freshData.titleToId;
    currentWindowPaneIds = freshData.currentWindowPaneIds;

    // Re-rebind after recreation
    reboundPanes = syncHiddenStateFromCurrentWindow(
      reboundPanes.map(p => rebindPaneByTitle(p, titleToId, allPaneIds)),
      currentWindowPaneIds
    );
  }

  return { panes: reboundPanes, allPaneIds, titleToId };
}
