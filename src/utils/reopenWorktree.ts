import path from 'path';
import { TmuxService } from '../services/TmuxService.js';
import {
  ensurePaneBorderStatusForCurrentSession,
  setupSidebarLayout,
  getTerminalDimensions,
  splitPane,
} from './tmux.js';
import { SIDEBAR_WIDTH, recalculateAndApplyLayout } from './layoutManager.js';
import type { PsychePane, PsycheConfig } from '../types.js';
import { buildWorktreePaneTitle } from './paneTitle.js';
import {
  AGENT_IDS,
  buildAgentResumeOrLaunchCommand,
  type AgentName,
} from './agentLaunch.js';
import { ensureGeminiFolderTrusted } from './geminiTrust.js';
import { SettingsManager } from './settingsManager.js';
import { filterEnabledAgents, getInstalledAgents } from './agentDetection.js';
import { getCurrentBranch } from './git.js';
import { readWorktreeMetadata } from './worktreeMetadata.js';
import {
  buildCodexHookedCommand,
  installCodexPaneHooks,
} from './codexHooks.js';
import { resolveProjectColorTheme } from './paneColors.js';
import { getSidebarProjectDisplayName } from './sidebarProjects.js';
import type { SidebarProject } from '../types.js';
import {
  WorktreeCleanupService,
  type WorktreeReuseReservation,
} from '../services/WorktreeCleanupService.js';
import {
  ensureProjectPaneConfigPane,
  mutateProjectPaneConfig,
  projectPaneConfigPath,
} from '../services/ProjectPaneConfig.js';
import {
  paneRecoveryInstructions,
  tearDownPaneWithVerification,
  type TmuxPanePresence,
} from './paneTeardown.js';
import { createPsychePaneId } from './paneIdentity.js';
import {
  isPaneLifecycleReservationRetainedError,
  PaneLifecycleReservationRetainedError,
  retainPaneRecovery,
  type PaneRecoveryPersistenceResult,
} from './paneLifecycleRecovery.js';

export interface ReopenWorktreeOptions {
  agent?: AgentName;
  slug: string;
  worktreePath: string;
  projectRoot: string; // Target repo root for the reopened pane
  sessionConfigPath?: string; // Shared psyche config path for this session
  sessionProjectRoot?: string; // Session root for welcome pane/layout state
  existingPanes: PsychePane[];
  persistReopenedPane: (pane: PsychePane) => Promise<void>;
}

export interface ReopenWorktreeResult {
  pane: PsychePane;
}

/**
 * Reopens a closed worktree by creating a new pane in the existing worktree
 * and launching the best available agent resume command.
 */
export async function reopenWorktree(
  options: ReopenWorktreeOptions
): Promise<ReopenWorktreeResult> {
  const reservation = await WorktreeCleanupService.getInstance().beginWorktreeReuseReservation(
    options.worktreePath,
    options.projectRoot,
  );
  let releaseReservation = true;
  let reservationSettled = false;

  try {
    const result = await reopenWorktreeWithReuseReservation(
      {
        ...options,
        worktreePath: reservation.canonicalWorktreePath,
      },
      reservation,
    );
    await reservation.complete();
    reservationSettled = true;
    return result;
  } catch (error) {
    if (isPaneLifecycleReservationRetainedError(error)) {
      reservation.retain();
      releaseReservation = false;
      throw new Error(error.message);
    }
    throw error;
  } finally {
    if (releaseReservation && !reservationSettled) {
      await reservation.cancel();
    }
  }
}

async function reopenWorktreeWithReuseReservation(
  options: ReopenWorktreeOptions,
  reservation: WorktreeReuseReservation,
): Promise<ReopenWorktreeResult> {
  const {
    agent: requestedAgent,
    slug,
    worktreePath,
    projectRoot,
    existingPanes,
    sessionConfigPath: optionsSessionConfigPath,
    sessionProjectRoot: optionsSessionProjectRoot,
  } = options;

  let paneProjectName = path.basename(projectRoot);
  const settings = new SettingsManager(projectRoot).getSettings();
  const metadata = readWorktreeMetadata(worktreePath);
  const sessionProjectRoot = optionsSessionProjectRoot
    || (optionsSessionConfigPath ? path.dirname(path.dirname(optionsSessionConfigPath)) : projectRoot);

  const tmuxService = TmuxService.getInstance();
  const originalPaneId = tmuxService.getCurrentPaneIdSync();

  // Load config to get control pane info
  let controlPaneId: string | undefined;
  let configSidebarProjects: SidebarProject[] = [];

  try {
    const mutation = await mutateProjectPaneConfig(
      sessionProjectRoot,
      async (configRecord) => {
        const config = configRecord as unknown as PsycheConfig;
        let persistedControlPaneId = config.controlPaneId;
        const sidebarProjects = Array.isArray(config.sidebarProjects)
          ? config.sidebarProjects
          : [];

        if (persistedControlPaneId) {
          const exists = await tmuxService.paneExists(persistedControlPaneId);
          if (!exists) {
            persistedControlPaneId = originalPaneId;
          }
        }
        if (!persistedControlPaneId) {
          persistedControlPaneId = originalPaneId;
        }

        config.controlPaneId = persistedControlPaneId;
        config.controlPaneSize = SIDEBAR_WIDTH;
        config.lastUpdated = new Date().toISOString();
        return { persistedControlPaneId, sidebarProjects };
      }
    );
    controlPaneId = mutation.result.persistedControlPaneId;
    configSidebarProjects = mutation.result.sidebarProjects;
    paneProjectName = getSidebarProjectDisplayName(
      configSidebarProjects,
      projectRoot
    );
  } catch {
    controlPaneId = originalPaneId;
  }

  // Enable pane borders to show titles
  try {
    ensurePaneBorderStatusForCurrentSession();
  } catch {
    // Ignore if already set or fails
  }

  // Determine if this is the first content pane
  const isFirstContentPane = existingPanes.length === 0;

  // Resolve all record fields before tmux allocation. Once a split succeeds,
  // the exact identity is available immediately for recovery persistence.
  const installedAgents = await getInstalledAgents();
  const enabledAgents = filterEnabledAgents(installedAgents, settings.enabledAgents);
  const candidateAgents = enabledAgents.length > 0 ? enabledAgents : installedAgents;
  const preferredOrder: AgentName[] = [
    'claude',
    'codex',
    'opencode',
    ...AGENT_IDS.filter((agent) =>
      !['claude', 'codex', 'opencode'].includes(agent)
    ),
  ];
  const configuredAgent = metadata?.agent;
  const agent = requestedAgent
    || (configuredAgent && candidateAgents.includes(configuredAgent)
      ? configuredAgent
      : preferredOrder.find((candidate) => candidateAgents.includes(candidate)));
  const permissionMode = metadata?.permissionMode ?? settings.permissionMode;
  const psychePaneId = createPsychePaneId();
  const currentBranch = getCurrentBranch(worktreePath);

  let paneInfo: string;

  if (isFirstContentPane) {
    paneInfo = setupSidebarLayout(controlPaneId, projectRoot);
  } else {
    // Subsequent panes - always split horizontally
    const psychePaneIds = existingPanes.map(p => p.paneId);
    const targetPane = psychePaneIds[psychePaneIds.length - 1];
    paneInfo = splitPane({ targetPane });
  }

  const newPane: PsychePane = {
    id: psychePaneId,
    slug,
    displayName: metadata?.displayName,
    branchName: (metadata?.branchName || currentBranch) !== slug
      ? (metadata?.branchName || currentBranch)
      : undefined,
    prompt: '(Reopened session)',
    paneId: paneInfo,
    projectRoot,
    projectName: paneProjectName,
    colorTheme: resolveProjectColorTheme(projectRoot, configSidebarProjects),
    worktreePath,
    agent,
    permissionMode,
    autopilot: settings.enableAutopilotByDefault ?? false,
    mergeTargetChain: metadata?.mergeTargetChain,
  };

  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!(await tmuxService.paneExists(paneInfo))) {
      throw new Error(`newly split pane ${paneInfo} is not present`);
    }
    const paneTitle = projectRoot === sessionProjectRoot
      ? slug
      : buildWorktreePaneTitle(slug, projectRoot, paneProjectName);
    await tmuxService.setPaneTitle(paneInfo, paneTitle);

    if (controlPaneId) {
      const dimensions = getTerminalDimensions();
      const allContentPaneIds = [...existingPanes.map(p => p.paneId), paneInfo];
      await recalculateAndApplyLayout(
        controlPaneId,
        allContentPaneIds,
        dimensions.width,
        dimensions.height,
      );
      await tmuxService.refreshClient();
    }

    await options.persistReopenedPane(newPane);
  } catch (error) {
    const persistenceError = error instanceof Error ? error.message : String(error);
    const teardown = await tearDownReopenedPane(tmuxService, paneInfo);
    if (teardown.presence !== 'absent') {
      const recovery = await retainPaneRecovery({
        projectRoot,
        sessionProjectRoot,
        pane: newPane,
        operation: 'reopen-worktree',
        reason: `reopened pane persistence failed: ${persistenceError}`,
        reservation,
        persistConfigRecovery: () => persistReopenedPaneRecovery(
          sessionProjectRoot,
          newPane,
        ),
      });
      const message = `Failed to persist reopened pane before agent launch: ${persistenceError}; pane teardown is ${teardown.presence}; ${recovery.message}`;
      if (recovery.retained) {
        throw new PaneLifecycleReservationRetainedError(message);
      }
      throw new Error(message);
    }
    throw new Error(
      `Failed to persist reopened pane before agent launch: ${persistenceError}`,
    );
  }

  // A durable exact record exists before the pane receives a cwd or agent
  // command. Later launch failures remain visible to normal pane recovery.
  await tmuxService.sendShellCommand(paneInfo, `cd "${worktreePath}"`);
  await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Resume the agent session (or start interactive mode when no resume command is available).
  if (agent) {
    if (agent === 'gemini') {
      ensureGeminiFolderTrusted(worktreePath);
    }

    let resumeCommand = buildAgentResumeOrLaunchCommand(agent, permissionMode);
    if (agent === 'codex') {
      let codexHookEventFile: string | undefined;
      try {
        codexHookEventFile = installCodexPaneHooks({
          worktreePath,
          psychePaneId,
          tmuxPaneId: paneInfo,
        }).eventFile;
      } catch {
        // Hook installation is best effort; Codex can still resume normally.
      }

      resumeCommand = buildCodexHookedCommand(resumeCommand, {
        psychePaneId,
        tmuxPaneId: paneInfo,
        eventFile: codexHookEventFile,
      });
    }

    await tmuxService.sendShellCommand(paneInfo, resumeCommand);
    await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
  }

  // Keep focus on the new pane
  await tmuxService.selectPane(paneInfo);

  // Always destroy welcome pane if one exists — shell panes can make isFirstContentPane
  // false even when no real content pane exists yet.
  try {
    const { destroyWelcomePaneCoordinated } = await import('./welcomePaneManager.js');
    await destroyWelcomePaneCoordinated(sessionProjectRoot);
  } catch {
    // Ignore - welcome pane cleanup is not critical
  }

  // Switch back to the original pane
  await tmuxService.selectPane(originalPaneId);

  return {
    pane: newPane,
  };
}

async function tearDownReopenedPane(
  tmuxService: TmuxService,
  paneId: string,
) {
  return tearDownPaneWithVerification({
    probe: () => probeReopenedPanePresence(tmuxService, paneId),
    kill: () => tmuxService.killPane(paneId),
  });
}

async function probeReopenedPanePresence(
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

async function persistReopenedPaneRecovery(
  sessionProjectRoot: string,
  pane: PsychePane,
): Promise<PaneRecoveryPersistenceResult> {
  const configPath = projectPaneConfigPath(sessionProjectRoot);
  try {
    await ensureProjectPaneConfigPane(sessionProjectRoot, pane);
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
