import path from 'path';
import { TmuxService } from '../services/TmuxService.js';
import { tearDownGenerationBoundPane } from './TmuxGenerationGuard.js';
import {
  ensurePaneBorderStatusForCurrentSession,
  setupSidebarLayout,
  getTerminalDimensions,
  splitPane,
} from './tmux.js';
import {
  capturePaneInsertion,
  insertPaneIntoStoredLayout,
  SIDEBAR_WIDTH,
} from './layoutManager.js';
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
} from './paneTeardown.js';
import { createPsychePaneId } from './paneIdentity.js';
import {
  isPaneLifecycleReservationRetainedError,
  PaneLifecycleReservationRetainedError,
  type PaneRecoveryPersistenceResult,
} from './paneLifecycleRecovery.js';
import { createTransactionalPane } from './transactionalPaneCreation.js';

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
    slug: requestedSlug,
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
  const panesFile = optionsSessionConfigPath
    || path.join(sessionProjectRoot, '.psyche', 'psyche.config.json');
  const insertion = isFirstContentPane
    ? undefined
    : await capturePaneInsertion({
      panesFile,
      panes: existingPanes,
    });

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
  let newPane: PsychePane;
  try {
    newPane = await createTransactionalPane({
    projectRoot,
    sessionProjectRoot,
    operation: 'reopen-worktree',
    slugBase: requestedSlug,
    worktreePath,
    paneRecordId: psychePaneId,
    reservation,
    allocate: () => (
      isFirstContentPane
        ? setupSidebarLayout(controlPaneId, projectRoot)
        : splitPane(insertion ? { targetPane: insertion.targetTmuxPaneId } : {})
    ),
    createPane: ({
      paneId,
      tmuxServerIdentity,
      paneRecordId,
      slug,
    }) => ({
      id: paneRecordId,
      slug,
      displayName: metadata?.displayName,
      branchName: (metadata?.branchName || currentBranch) !== slug
        ? (metadata?.branchName || currentBranch)
        : undefined,
      prompt: '(Reopened session)',
      paneId,
      tmuxServerIdentity,
      projectRoot,
      projectName: paneProjectName,
      colorTheme: resolveProjectColorTheme(projectRoot, configSidebarProjects),
      worktreePath,
      agent,
      permissionMode,
      autopilot: settings.enableAutopilotByDefault ?? false,
      mergeTargetChain: metadata?.mergeTargetChain,
    }),
    persist: async (pane) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!(await tmuxService.paneExists(pane.paneId))) {
        throw new Error(`newly split pane ${pane.paneId} is not present`);
      }
      const paneTitle = projectRoot === sessionProjectRoot
        ? pane.slug
        : buildWorktreePaneTitle(pane.slug, projectRoot, paneProjectName);
      await tmuxService.setPaneTitle(pane.paneId, paneTitle);
      if (!controlPaneId) {
        throw new Error('Pane layout cannot be updated without a control pane');
      }
      await insertPaneIntoStoredLayout({
        panesFile,
        panes: existingPanes,
        pane,
        controlPaneId,
        insertion,
        sidebarWidth: SIDEBAR_WIDTH,
      });
      await options.persistReopenedPane(pane);
    },
      persistRecovery: (pane) => persistReopenedPaneRecovery(
        sessionProjectRoot,
        pane,
      ),
      tearDown: (paneId, identity) => tearDownGenerationBoundPane(
        tmuxService,
        paneId,
        identity,
        { generationMismatch: 'unknown' },
      ),
    });
  } catch (error) {
    const message = `Failed to persist reopened pane before agent launch: ${
      error instanceof Error ? error.message : String(error)
    }`;
    if (isPaneLifecycleReservationRetainedError(error)) {
      throw new PaneLifecycleReservationRetainedError(message);
    }
    throw new Error(message);
  }
  const paneInfo = newPane.paneId;

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
