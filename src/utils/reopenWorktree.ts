import path from 'path';
import * as fs from 'fs';
import { TmuxService } from '../services/TmuxService.js';
import {
  ensurePaneBorderStatusForCurrentSession,
  setupSidebarLayout,
} from './tmux.js';
import {
  capturePaneInsertion,
  insertPaneIntoStoredLayout,
  SIDEBAR_WIDTH,
} from './layoutManager.js';
import type { PsychePane, PsycheConfig } from '../types.js';
import { atomicWriteJsonSync } from './atomicWrite.js';
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
import { withPanesConfigFileWriteLock } from './panesConfigQueue.js';

export interface ReopenWorktreeOptions {
  agent?: AgentName;
  slug: string;
  worktreePath: string;
  projectRoot: string; // Target repo root for the reopened pane
  sessionConfigPath?: string; // Shared psyche config path for this session
  sessionProjectRoot?: string; // Session root for welcome pane/layout state
  existingPanes: PsychePane[];
  sidebarWidth?: number;
  focusedTmuxPaneId?: string | null;
  selectedPaneId?: string;
}

export interface ReopenWorktreeResult {
  pane: PsychePane;
}

async function updatePanesConfig(
  configPath: string,
  update: (config: PsycheConfig) => void
): Promise<PsycheConfig> {
  return withPanesConfigFileWriteLock(configPath, async () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as PsycheConfig;
    if (Array.isArray(config)) {
      throw new Error('Pane config must use object form');
    }

    update(config);
    atomicWriteJsonSync(configPath, config);
    return config;
  });
}

/**
 * Reopens a closed worktree by creating a new pane in the existing worktree
 * and launching the best available agent resume command.
 */
export async function reopenWorktree(
  options: ReopenWorktreeOptions
): Promise<ReopenWorktreeResult> {
  const {
    agent: requestedAgent,
    slug,
    worktreePath,
    projectRoot,
    existingPanes,
    sessionConfigPath: optionsSessionConfigPath,
    sessionProjectRoot: optionsSessionProjectRoot,
    sidebarWidth: optionsSidebarWidth,
    focusedTmuxPaneId,
    selectedPaneId,
  } = options;
  let paneProjectName = path.basename(projectRoot);
  const settings = new SettingsManager(projectRoot).getSettings();
  const metadata = readWorktreeMetadata(worktreePath);
  const sessionProjectRoot = optionsSessionProjectRoot
    || (optionsSessionConfigPath ? path.dirname(path.dirname(optionsSessionConfigPath)) : projectRoot);
  const sidebarWidth = optionsSidebarWidth ?? SIDEBAR_WIDTH;

  const tmuxService = TmuxService.getInstance();
  const originalPaneId = tmuxService.getCurrentPaneIdSync();

  // Load config to get control pane info
  const configPath = optionsSessionConfigPath
    || path.join(sessionProjectRoot, '.psyche', 'psyche.config.json');
  let controlPaneId: string | undefined;
  let configSidebarProjects: SidebarProject[] = [];

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config: PsycheConfig = JSON.parse(configContent);
    controlPaneId = config.controlPaneId;
    configSidebarProjects = Array.isArray(config.sidebarProjects) ? config.sidebarProjects : [];
    paneProjectName = getSidebarProjectDisplayName(
      configSidebarProjects,
      projectRoot
    );

    // Verify the control pane ID from config still exists
    if (controlPaneId) {
      const exists = await tmuxService.paneExists(controlPaneId);
      if (!exists) {
        controlPaneId = originalPaneId;
        await updatePanesConfig(configPath, (latestConfig) => {
          latestConfig.controlPaneId = controlPaneId;
          latestConfig.controlPaneSize = sidebarWidth;
          latestConfig.lastUpdated = new Date().toISOString();
        });
      }
    }

    if (!controlPaneId) {
      controlPaneId = originalPaneId;
      await updatePanesConfig(configPath, (latestConfig) => {
        latestConfig.controlPaneId = controlPaneId;
        latestConfig.controlPaneSize = sidebarWidth;
        latestConfig.lastUpdated = new Date().toISOString();
      });
    }
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
  const insertion = isFirstContentPane
    ? undefined
    : await capturePaneInsertion({
        panesFile: configPath,
        panes: existingPanes,
        focusedTmuxPaneId,
        selectedPaneId,
      });

  let paneInfo: string;

  if (isFirstContentPane) {
    paneInfo = setupSidebarLayout(controlPaneId, projectRoot, sidebarWidth);
    await new Promise((resolve) => setTimeout(resolve, 300));
  } else {
    if (!insertion) {
      throw new Error('Pane layout has no visible insertion target');
    }
    paneInfo = await tmuxService.splitPane({
      targetPane: insertion.targetTmuxPaneId,
      cwd: projectRoot,
    });
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  // Set pane title
  try {
    const paneTitle = projectRoot === sessionProjectRoot
      ? slug
      : buildWorktreePaneTitle(slug, projectRoot, paneProjectName);
    await tmuxService.setPaneTitle(paneInfo, paneTitle);
  } catch {
    // Ignore if setting title fails
  }

  // CD into the worktree
  await tmuxService.sendShellCommand(paneInfo, `cd "${worktreePath}"`);
  await tmuxService.sendTmuxKeys(paneInfo, 'Enter');

  // Wait for CD to complete
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Detect which agent to use - prefer stored metadata, then fall back to enabled/installed order.
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
  const psychePaneId = `psyche-${Date.now()}`;

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

  // Create the pane object
  const currentBranch = getCurrentBranch(worktreePath);

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

  if (!controlPaneId) {
    throw new Error('Pane layout cannot be updated without a control pane');
  }
  await insertPaneIntoStoredLayout({
    panesFile: configPath,
    panes: existingPanes,
    pane: newPane,
    controlPaneId,
    insertion,
    sidebarWidth,
  });

  // Always destroy welcome pane if one exists — shell panes can make isFirstContentPane
  // false even when no real content pane exists yet.
  try {
    const { destroyWelcomePaneCoordinated } = await import('./welcomePaneManager.js');
    destroyWelcomePaneCoordinated(sessionProjectRoot);
  } catch {
    // Ignore - welcome pane cleanup is not critical
  }

  // Switch back to the original pane
  await tmuxService.selectPane(originalPaneId);

  return {
    pane: newPane,
  };
}
