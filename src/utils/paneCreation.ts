import path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import type { PsychePane, PsycheConfig, MergeTargetReference } from '../types.js';
import { TmuxService } from '../services/TmuxService.js';
import {
  ensurePaneBorderStatusForCurrentSession,
  setupSidebarLayout,
  getTerminalDimensions,
  splitPane,
} from './tmux.js';
import { SIDEBAR_WIDTH, recalculateAndApplyLayout } from './layoutManager.js';
import { generateSlug } from './slug.js';
import { capturePaneContent } from './paneCapture.js';
import { triggerHook, triggerHookSync, initializeHooksDirectory } from './hooks.js';
import { TMUX_LAYOUT_APPLY_DELAY, TMUX_SPLIT_DELAY } from '../constants/timing.js';
import { LogService } from '../services/LogService.js';
import {
  WorktreeCleanupService,
  type CreatedWorktreeIdentity,
  type WorktreeCreationReservation,
} from '../services/WorktreeCleanupService.js';
import type { ProjectWorktreeLifecycleLease } from '../services/WorktreeOperationLease.js';
import {
  mutateProjectPaneConfig,
  projectPaneConfigPath,
  upsertProjectPaneConfigPanes,
} from '../services/ProjectPaneConfig.js';
import {
  appendSlugSuffix,
  launchAgentInPane,
  type AgentName,
} from './agentLaunch.js';
import { buildWorktreePaneTitle } from './paneTitle.js';
import { isValidBranchName } from './git.js';
import { ensurePsycheRuntimeIgnored } from './gitignore.js';
import { readWorktreeMetadata, writeWorktreeMetadata } from './worktreeMetadata.js';
import { installCodexPaneHooks } from './codexHooks.js';
import { resolveProjectColorTheme } from './paneColors.js';
import { getSidebarProjectDisplayName } from './sidebarProjects.js';
import type { SidebarProject } from '../types.js';
import {
  paneRecoveryInstructions,
  tearDownPaneWithVerification,
  type TmuxPanePresence,
  type VerifiedPaneTeardownResult,
} from './paneTeardown.js';

export interface CreatePaneOptions {
  prompt: string;
  agent?: AgentName;
  slugSuffix?: string;
  slugBase?: string;
  existingWorktree?: {
    slug: string;
    worktreePath: string;
    branchName: string;
  };
  /**
   * Persists a newly-created pane while its creation lease is still held.
   */
  persistCreatedPane?: (pane: PsychePane) => Promise<void>;
  persistReusedPane?: (pane: PsychePane) => Promise<void>;
  startPointBranch?: string;
  mergeTargetChain?: MergeTargetReference[];
  projectName: string;
  existingPanes: PsychePane[];
  projectRoot?: string; // Target repository root for the new pane
  skipAgentSelection?: boolean; // Explicitly allow creating pane with no agent
  sessionConfigPath?: string; // Shared psyche config file for the current session
  sessionProjectRoot?: string; // Session root that owns sidebar/welcome pane state
  /**
   * A caller that already owns the project lifecycle lease (for example
   * resumeBranches) passes it through so reuse does not try to re-acquire the
   * non-reentrant project lock.
   */
  projectLifecycleLease?: ProjectWorktreeLifecycleLease;
}

export interface CreatePaneResult {
  pane: PsychePane;
  needsAgentChoice: boolean;
  persistedDuringLifecycle?: boolean;
}

async function waitForPaneReady(
  tmuxService: TmuxService,
  paneId: string,
  timeoutMs: number = 600
): Promise<void> {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    if (await tmuxService.paneExists(paneId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function persistPaneBeforeAgentLaunch(
  options: CreatePaneOptions,
  sessionProjectRoot: string,
  pane: PsychePane,
): Promise<void> {
  const persist = options.existingWorktree
    ? options.persistReusedPane
    : options.persistCreatedPane;
  if (persist) {
    await persist(pane);
    return;
  }

  await mutateProjectPaneConfig(sessionProjectRoot, (config) => {
    const panes = Array.isArray(config.panes) ? config.panes : [];
    const index = panes.findIndex((candidate) => candidate.id === pane.id);
    if (index >= 0) {
      panes[index] = pane;
    } else {
      panes.push(pane);
    }
    config.panes = panes;
    config.lastUpdated = new Date().toISOString();
  });
}

interface PaneRecoveryRecordResult {
  durable: boolean;
  message: string;
}

async function terminatePaneForRollback(
  tmuxService: TmuxService,
  paneId: string,
): Promise<VerifiedPaneTeardownResult> {
  return tearDownPaneWithVerification({
    probe: () => probePanePresence(tmuxService, paneId),
    kill: () => tmuxService.killPane(paneId),
  });
}

async function probePanePresence(
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

async function persistPaneRecoveryRecord(
  sessionProjectRoot: string,
  pane: PsychePane,
): Promise<PaneRecoveryRecordResult> {
  const configPath = projectPaneConfigPath(sessionProjectRoot);
  try {
    await upsertProjectPaneConfigPanes(sessionProjectRoot, [pane]);
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
 * Core pane creation logic that can be used by both TUI and API
 * Returns the newly created pane and whether agent choice is needed
 */
export async function createPane(
  options: CreatePaneOptions,
  availableAgents: AgentName[]
): Promise<CreatePaneResult> {
  if (!options.existingWorktree) {
    return createPaneWithReuseReservation(options, availableAgents);
  }

  if (!options.persistReusedPane) {
    throw new Error(
      'Reusing an existing worktree requires persistReusedPane so cleanup remains blocked through pane persistence'
    );
  }

  const existingWorktree = options.existingWorktree;
  return WorktreeCleanupService.getInstance().withWorktreeReuseReservation(
    existingWorktree.worktreePath,
    async (canonicalWorktreePath) => {
      return createPaneWithReuseReservation(
        {
          ...options,
          existingWorktree: {
            ...existingWorktree,
            worktreePath: canonicalWorktreePath,
          },
        },
        availableAgents
      );
    },
    options.projectRoot,
    options.projectLifecycleLease,
  );
}

async function createPaneWithReuseReservation(
  options: CreatePaneOptions,
  availableAgents: AgentName[]
): Promise<CreatePaneResult> {
  const {
    prompt,
    existingPanes,
    slugSuffix,
    slugBase,
    existingWorktree,
    startPointBranch,
    mergeTargetChain,
    skipAgentSelection = false,
    sessionConfigPath: optionsSessionConfigPath,
    sessionProjectRoot: optionsSessionProjectRoot,
  } = options;
  let { agent, projectRoot: optionsProjectRoot } = options;

  // Load settings to check for default agent and autopilot
  const { SettingsManager } = await import('./settingsManager.js');

  // Get project root (handle git worktrees correctly)
  let projectRoot: string;
  if (optionsProjectRoot) {
    projectRoot = optionsProjectRoot;
  } else {
    try {
      // For git worktrees, we need to get the main repository root, not the worktree root
      // git rev-parse --git-common-dir gives us the main .git directory
      const gitCommonDir = execSync('git rev-parse --git-common-dir', {
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();

      // If it's a worktree, gitCommonDir will be an absolute path to main .git
      // If it's the main repo, it will be just '.git'
      if (gitCommonDir === '.git') {
        // We're in the main repo
        projectRoot = execSync('git rev-parse --show-toplevel', {
          encoding: 'utf-8',
          stdio: 'pipe',
        }).trim();
      } else {
        // We're in a worktree, get the parent directory of the .git directory
        projectRoot = path.dirname(gitCommonDir);
      }
    } catch {
      projectRoot = process.cwd();
    }
  }

  const settingsManager = new SettingsManager(projectRoot);
  const settings = settingsManager.getSettings();
  const existingWorktreeMetadata = existingWorktree
    ? readWorktreeMetadata(existingWorktree.worktreePath)
    : null;

  const sessionProjectRoot = optionsSessionProjectRoot
    || (optionsSessionConfigPath ? path.dirname(path.dirname(optionsSessionConfigPath)) : projectRoot);
  let paneProjectName = path.basename(projectRoot);

  // If no agent specified, check settings for default agent unless caller explicitly disabled auto-selection.
  if (!agent && !skipAgentSelection && settings.defaultAgent) {
    // Only use default if it's available
    if (availableAgents.includes(settings.defaultAgent)) {
      agent = settings.defaultAgent;
    }
  }

  // Determine if we need agent choice
  if (!agent && !skipAgentSelection && availableAgents.length > 1) {
    // Need to ask which agent to use
    return {
      pane: null as any,
      needsAgentChoice: true,
    };
  }

  // Auto-select agent if only one is available or if not specified
  if (!agent && !skipAgentSelection && availableAgents.length === 1) {
    agent = availableAgents[0];
  }

  // Trigger before_pane_create hook
  await triggerHook('before_pane_create', projectRoot, undefined, {
    PSYCHE_PROMPT: prompt,
    PSYCHE_AGENT: agent || 'unknown',
  });

  // Validate branchPrefix before use
  const branchPrefix = settings.branchPrefix || '';
  if (branchPrefix && !isValidBranchName(branchPrefix)) {
    throw new Error(`Invalid branch prefix: ${branchPrefix}`);
  }

  // Generate slug (filesystem-safe directory name) and branch name (may include prefix).
  const generatedSlug = existingWorktree
    ? existingWorktree.slug
    : (slugBase || await generateSlug(prompt));
  const slug = existingWorktree
    ? existingWorktree.slug
    : appendSlugSuffix(generatedSlug, slugSuffix);
  const branchName = existingWorktree
    ? existingWorktree.branchName
    : (branchPrefix ? `${branchPrefix}${slug}` : slug);
  const tmuxService = TmuxService.getInstance();

  const worktreePath = existingWorktree?.worktreePath
    || path.join(projectRoot, '.psyche', 'worktrees', slug);
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
            LogService.getInstance().warn(
              `Control pane ${persistedControlPaneId} no longer exists, updating to ${originalPaneId}`,
              'paneCreation'
            );
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
  } catch (error) {
    // Fallback if config loading fails
    controlPaneId = originalPaneId;
  }

  // Enable pane borders to show titles
  try {
    ensurePaneBorderStatusForCurrentSession();
  } catch {
    // Ignore if already set or fails
  }

  // Determine if this is the first content pane
  // Check existingPanes instead of contentPaneIds, because contentPaneIds includes the welcome pane
  const isFirstContentPane = existingPanes.length === 0;

  let paneInfo: string;

  // Self-healing: Try to create pane, if it fails due to stale controlPaneId, fix and retry
  try {
    if (isFirstContentPane) {
      // First, create the tmux pane but DON'T destroy welcome pane yet
      // This way we can save the pane to config first, THEN destroy welcome pane
      paneInfo = setupSidebarLayout(controlPaneId, projectRoot);
    } else {
      // Subsequent panes - always split horizontally, let layout manager organize
      // Get actual psyche pane IDs (not welcome pane) from existingPanes
      const psychePaneIds = existingPanes.map(p => p.paneId);
      const targetPane = psychePaneIds[psychePaneIds.length - 1]; // Split from the most recent psyche pane

      // Always split horizontally - the layout manager will organize panes optimally
      paneInfo = splitPane({ targetPane, cwd: projectRoot });
    }
  } catch (error) {
    // Check if error is due to stale pane ID (can't find pane)
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes("can't find pane")) {
      LogService.getInstance().warn('Pane creation failed with stale control pane ID, self-healing', 'paneCreation');

      // Fix: Update controlPaneId to current pane and save to config
      const currentPaneId = originalPaneId; // We got this at the start of createPane
      LogService.getInstance().info(
        `Updating controlPaneId from ${controlPaneId} to ${currentPaneId}`,
        'paneCreation'
      );

      try {
        await mutateProjectPaneConfig(sessionProjectRoot, (configRecord) => {
          const config = configRecord as unknown as PsycheConfig;
          config.controlPaneId = currentPaneId;
          config.controlPaneSize = SIDEBAR_WIDTH;
          config.lastUpdated = new Date().toISOString();
        });
        controlPaneId = currentPaneId; // Update local variable
      } catch (configError) {
        LogService.getInstance().error(
          `Failed to update config after control pane recovery: ${configError}`,
          'paneCreation'
        );
        throw error; // Re-throw original error
      }

      // Retry pane creation with corrected controlPaneId
      if (isFirstContentPane) {
        paneInfo = setupSidebarLayout(controlPaneId, projectRoot);
      } else {
        const psychePaneIds = existingPanes.map(p => p.paneId);
        const targetPane = psychePaneIds[psychePaneIds.length - 1];
        paneInfo = splitPane({ targetPane, cwd: projectRoot });
      }
    } else {
      // Different error, re-throw
      throw error;
    }
  }

  await waitForPaneReady(tmuxService, paneInfo);

  // Set pane title (project-tagged for collision-safe rebinding across projects)
  try {
    const paneTitle = projectRoot === sessionProjectRoot
      ? slug
      : buildWorktreePaneTitle(slug, projectRoot, paneProjectName);
    await tmuxService.setPaneTitle(paneInfo, paneTitle);
  } catch {
    // Ignore if setting title fails
  }

  // Apply optimal layout using the layout manager
  if (controlPaneId) {
    const dimensions = getTerminalDimensions();
    const allContentPaneIds = [...existingPanes.map(p => p.paneId), paneInfo];

    await recalculateAndApplyLayout(
      controlPaneId,
      allContentPaneIds,
      dimensions.width,
      dimensions.height
    );

    // Refresh tmux to apply changes
    await tmuxService.refreshClient();
  }

  // Construct the recovery record before any fallible post-pane work. If tmux
  // later cannot confirm teardown, this exact record can be persisted while
  // the creation/reuse lease is still held.
  const newPane: PsychePane = {
    id: `psyche-${Date.now()}`,
    slug,
    displayName: existingWorktreeMetadata?.displayName,
    branchName: branchName !== slug ? branchName : undefined,
    prompt: prompt || 'No initial prompt',
    paneId: paneInfo,
    projectRoot,
    projectName: paneProjectName,
    colorTheme: resolveProjectColorTheme(projectRoot, configSidebarProjects),
    worktreePath,
    agent,
    permissionMode: settings.permissionMode,
    autopilot: settings.enableAutopilotByDefault ?? false,
    mergeTargetChain,
  };

  // Trigger pane_created hook (after pane created, before worktree)
  try {
    await triggerHook('pane_created', projectRoot, undefined, {
      PSYCHE_PANE_ID: newPane.id,
      PSYCHE_SLUG: slug,
      PSYCHE_PROMPT: prompt,
      PSYCHE_AGENT: agent || 'unknown',
      PSYCHE_TMUX_PANE_ID: paneInfo,
    });
  } catch (error) {
    const teardown = await terminatePaneForRollback(tmuxService, paneInfo);
    const recovery = teardown.presence === 'absent'
      ? undefined
      : await persistPaneRecoveryRecord(sessionProjectRoot, newPane);
    throw new Error(
      `Failed to create pane "${slug}": pane_created hook failed: ${
        error instanceof Error ? error.message : String(error)
      }${
        recovery ? `; ${recovery.message}` : ''
      }`,
    );
  }

  // Check if this is a hooks editing session (before worktree creation)
  const isHooksEditingSession = !!prompt && (
    /(create|edit|modify).*(psyche|\.)?.*hooks/i.test(prompt)
    || /\.psyche-hooks/i.test(prompt)
  );

  // Create git worktree and cd into it
  let creationReservation: WorktreeCreationReservation | undefined;
  let createdWorktreeIdentity: CreatedWorktreeIdentity | undefined;
  let worktreeCreatedByThisAttempt = false;
  try {
    if (existingWorktree) {
      if (!fs.existsSync(path.join(worktreePath, '.git'))) {
        throw new Error(`Existing worktree not found at ${worktreePath}`);
      }

      await tmuxService.sendShellCommand(paneInfo, `cd "${worktreePath}"`);
      await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
      await new Promise((resolve) => setTimeout(resolve, 300));
    } else {
      creationReservation = await WorktreeCleanupService.getInstance()
        .beginWorktreeCreation(
          worktreePath,
          projectRoot,
          options.projectLifecycleLease,
        );

      // IMPORTANT: Prune stale worktrees first to avoid conflicts
      // This must run synchronously from psyche, not in the pane
      try {
        execSync('git worktree prune', {
          encoding: 'utf-8',
          stdio: 'pipe',
          cwd: projectRoot,
        });
      } catch {
        // Ignore prune errors, proceed anyway
      }

      // Validate and resolve base branch for new worktrees
      const baseBranch = settings.baseBranch || '';
      if (baseBranch && !isValidBranchName(baseBranch)) {
        throw new Error(`Invalid base branch name: ${baseBranch}`);
      }
      const resolvedStartPoint = startPointBranch || baseBranch;
      if (resolvedStartPoint && !isValidBranchName(resolvedStartPoint)) {
        throw new Error(`Invalid worktree start-point branch name: ${resolvedStartPoint}`);
      }
      if (resolvedStartPoint) {
        try {
          execSync(`git rev-parse --verify --end-of-options "${resolvedStartPoint}"`, {
            stdio: 'pipe',
            cwd: projectRoot,
          });
        } catch {
          if (startPointBranch) {
            throw new Error(
              `Worktree start-point branch "${resolvedStartPoint}" does not exist anymore. Reopen the parent worktree or recreate it before branching again.`
            );
          }

          throw new Error(
            `Base branch "${resolvedStartPoint}" does not exist. Update the baseBranch setting to a valid branch name.`
          );
        }
      }

      const maxWorktreeAttempts = 3;
      const maxWaitTime = 5000; // 5 seconds max
      const checkInterval = 100; // Check every 100ms
      if (fs.existsSync(worktreePath)) {
        throw new Error(
          `Planned worktree path already exists at ${worktreePath}; refusing to claim another creator's directory`
        );
      }

      let branchExists = false;
      try {
        execSync(`git show-ref --verify --quiet "refs/heads/${branchName}"`, {
          stdio: 'pipe',
          cwd: projectRoot,
        });
        branchExists = true;
      } catch {
        // The branch will be created with the worktree.
      }

      const startingOid = execSync(
        `git rev-parse --verify --end-of-options "${
          branchExists ? branchName : (resolvedStartPoint || 'HEAD')
        }"`,
        {
          cwd: projectRoot,
          encoding: 'utf-8',
          stdio: 'pipe',
        }
      ).trim();
      if (!startingOid) {
        throw new Error(`Could not resolve starting OID for ${branchName}`);
      }

      let worktreeCreated = false;

      for (let attempt = 1; attempt <= maxWorktreeAttempts && !worktreeCreated; attempt++) {
        // Build worktree command:
        // - If branch exists, use it (don't create with -b)
        // - If branch doesn't exist, create it with -b, optionally from a configured base branch
        const startPoint = resolvedStartPoint ? ` "${resolvedStartPoint}"` : '';
        const worktreeAddCmd = branchExists
          ? `git worktree add "${worktreePath}" "${branchName}"`
          : `git worktree add "${worktreePath}" -b "${branchName}"${startPoint}`;
        const worktreeCmd = `cd "${projectRoot}" && ${worktreeAddCmd} && cd "${worktreePath}"`;

        // Send the git worktree command (auto-quoted by sendShellCommand)
        await tmuxService.sendShellCommand(paneInfo, worktreeCmd);
        await tmuxService.sendTmuxKeys(paneInfo, 'Enter');

        const startTime = Date.now();
        while (!fs.existsSync(worktreePath) && (Date.now() - startTime) < maxWaitTime) {
          await new Promise((resolve) => setTimeout(resolve, checkInterval));
        }

        worktreeCreated = fs.existsSync(worktreePath);
        if (worktreeCreated) {
          // The path was absent before this attempt, so this reservation now
          // owns its provisional lifecycle. Record that fact before any Git
          // verification can fail; every later error then runs guarded
          // rollback instead of silently abandoning a new worktree.
          worktreeCreatedByThisAttempt = true;
          createdWorktreeIdentity = creationReservation.recordCreatedWorktree({
            branchName,
            startingOid,
            createdOid: startingOid,
            deleteBranch: !branchExists,
            configProjectRoot: sessionProjectRoot,
          });
        }
        if (!worktreeCreated && attempt < maxWorktreeAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }

      // Verify worktree was created successfully
      if (!worktreeCreated) {
        throw new Error(`Worktree directory not created at ${worktreePath} after ${maxWorktreeAttempts} attempts`);
      }

      // Give a bit more time for git to finish setting up the worktree
      await new Promise((resolve) => setTimeout(resolve, 500));

      const createdOid = execSync(
        `git rev-parse --verify --end-of-options "${branchName}"`,
        {
          cwd: projectRoot,
          encoding: 'utf-8',
          stdio: 'pipe',
        }
      ).trim();
      const checkedOutBranch = execSync(
        `git -C "${worktreePath}" rev-parse --abbrev-ref HEAD`,
        {
          cwd: projectRoot,
          encoding: 'utf-8',
          stdio: 'pipe',
        }
      ).trim();
      if (!createdOid || checkedOutBranch !== branchName) {
        throw new Error(
          `Created worktree identity does not match ${branchName} at ${worktreePath}`
        );
      }
      // Replace the provisional identity only after full Git verification.
      createdWorktreeIdentity = creationReservation.recordCreatedWorktree({
        branchName,
        startingOid,
        createdOid,
        deleteBranch: !branchExists,
        configProjectRoot: sessionProjectRoot,
      });
    }

    try {
      const { addedEntries } = ensurePsycheRuntimeIgnored(worktreePath);
      if (addedEntries.length > 0) {
        LogService.getInstance().debug(
          `Added ${addedEntries.join(', ')} to worktree .gitignore for ${slug}`,
          'paneCreation'
        );
      }
    } catch (gitignoreError) {
      LogService.getInstance().warn(
        `Failed to ensure psyche runtime gitignore entries for ${slug}: ${gitignoreError}`,
        'paneCreation'
      );
    }

    try {
      writeWorktreeMetadata(worktreePath, {
        agent,
        permissionMode: settings.permissionMode,
        displayName: existingWorktreeMetadata?.displayName,
        branchName: branchName !== slug ? branchName : undefined,
        mergeTargetChain,
      });
    } catch (metadataError) {
      LogService.getInstance().warn(
        `Failed to persist worktree metadata for ${slug}: ${metadataError}`,
        'paneCreation'
      );
    }

    // Initialize .psyche-hooks if this is a hooks editing session
    if (isHooksEditingSession) {
      initializeHooksDirectory(worktreePath);
    }
  } catch (error) {
    // Worktree creation failed - kill the pane and abort. Leaving the pane
    // open at projectRoot is dangerous because the agent would run against
    // the main checkout instead of an isolated worktree.
    const errorMsg = error instanceof Error ? error.message : String(error);
    LogService.getInstance().error(
      `Worktree creation failed for ${slug}: ${errorMsg}`,
      'paneCreation',
      undefined,
      error instanceof Error ? error : undefined
    );
    const teardown = await terminatePaneForRollback(tmuxService, paneInfo);
    const recovery = teardown.presence === 'absent'
      ? undefined
      : await persistPaneRecoveryRecord(sessionProjectRoot, newPane);
    let rollbackError: string | undefined;
    if (teardown.presence === 'absent' && creationReservation && createdWorktreeIdentity) {
      const rollbackResult = await creationReservation.rollbackCreatedWorktree(
        createdWorktreeIdentity
      );
      if (!rollbackResult.success) {
        rollbackError = rollbackResult.error || 'unknown rollback failure';
      }
    } else if (teardown.presence === 'absent' && worktreeCreatedByThisAttempt) {
      rollbackError = 'worktree identity could not be recorded';
    }
    if (teardown.presence === 'absent' || recovery?.durable) {
      await creationReservation?.cancel();
    } else if (creationReservation) {
      LogService.getInstance().error(
        `Retaining creation lease for ${newPane.worktreePath}: pane teardown is ${teardown.presence} and recovery record is not durable`,
        'paneCreation',
        newPane.id,
      );
    }
    if (controlPaneId) {
      try {
        await tmuxService.selectPane(controlPaneId);
      } catch {
        // best-effort focus restore
      }
    }
    throw new Error(
      `Failed to create worktree for "${slug}": ${errorMsg}${
        rollbackError ? `; rollback failed: ${rollbackError}` : ''
      }${
        recovery ? `; ${recovery.message}` : ''
      }`
    );
  }

  // Run worktree_created hook synchronously BEFORE launching the agent.
  // If the hook fails, tear down the pane and abort so the agent never
  // runs against a half-configured worktree.
  const hookResult = await triggerHookSync('worktree_created', projectRoot, newPane);
  if (!hookResult.success) {
    const hookError = hookResult.error || 'unknown error';
    let rollbackError: string | undefined;
    LogService.getInstance().error(
      `worktree_created hook failed for ${slug}: ${hookError}`,
      'paneCreation'
    );
    const teardown = await terminatePaneForRollback(tmuxService, paneInfo);
    const recovery = teardown.presence === 'absent'
      ? undefined
      : await persistPaneRecoveryRecord(sessionProjectRoot, newPane);
    if (teardown.presence === 'absent' && creationReservation && createdWorktreeIdentity) {
      const rollbackResult = await creationReservation.rollbackCreatedWorktree(
        createdWorktreeIdentity
      );
      if (!rollbackResult.success) {
        rollbackError = rollbackResult.error || 'unknown rollback failure';
        LogService.getInstance().error(
          `Failed to roll back newly created worktree for ${slug}: ${rollbackError}`,
          'paneCreation',
          newPane.id,
          new Error(rollbackError)
        );
      }
    } else if (teardown.presence === 'absent' && worktreeCreatedByThisAttempt) {
      rollbackError = 'worktree identity could not be recorded';
      LogService.getInstance().error(
        `Failed to roll back newly created worktree for ${slug}: ${rollbackError}`,
        'paneCreation',
        newPane.id,
        new Error(rollbackError)
      );
    }
    if (teardown.presence === 'absent' || recovery?.durable) {
      await creationReservation?.cancel();
    } else if (creationReservation) {
      LogService.getInstance().error(
        `Retaining creation lease for ${newPane.worktreePath}: pane teardown is ${teardown.presence} and recovery record is not durable`,
        'paneCreation',
        newPane.id,
      );
    }
    if (controlPaneId) {
      try {
        await tmuxService.selectPane(controlPaneId);
      } catch {
        // best-effort focus restore
      }
    }
    throw new Error(
      `worktree_created hook failed for "${slug}": ${hookError}${
        rollbackError ? `; rollback failed: ${rollbackError}` : ''
      }${
        recovery ? `; ${recovery.message}` : ''
      }`
    );
  }

  // A worktree is not safe to expose to an agent until the pane registry
  // points at it. Keep the creation/reuse lease through this mutation so
  // queued cleanup cannot observe an unreferenced active worktree.
  try {
    await persistPaneBeforeAgentLaunch(options, sessionProjectRoot, newPane);
  } catch (error) {
    const persistenceError = error instanceof Error ? error.message : String(error);
    const teardown = await terminatePaneForRollback(tmuxService, paneInfo);
    const recovery = teardown.presence === 'absent'
      ? undefined
      : await persistPaneRecoveryRecord(sessionProjectRoot, newPane);
    let rollbackError: string | undefined;
    if (teardown.presence === 'absent' && creationReservation && createdWorktreeIdentity) {
      const rollbackResult = await creationReservation.rollbackCreatedWorktree(
        createdWorktreeIdentity
      );
      if (!rollbackResult.success) {
        rollbackError = rollbackResult.error || 'unknown rollback failure';
      }
    }
    if (teardown.presence === 'absent' || recovery?.durable) {
      await creationReservation?.cancel();
    } else if (creationReservation) {
      LogService.getInstance().error(
        `Retaining creation lease for ${newPane.worktreePath}: pane teardown is ${teardown.presence} and recovery record is not durable`,
        'paneCreation',
        newPane.id,
      );
    }
    throw new Error(
      `Failed to persist pane "${slug}" before agent launch: ${persistenceError}${
        rollbackError ? `; rollback failed: ${rollbackError}` : ''
      }${
        recovery ? `; ${recovery.message}` : ''
      }`
    );
  }

  if (creationReservation) {
    try {
      await creationReservation.complete();
    } catch (error) {
      // The pane is already durable, so never attempt rollback after this
      // point. Surface the lease-release problem without exposing it to
      // cleanup as an unreferenced worktree.
      throw new Error(
        `Pane "${slug}" was persisted but its creation lease could not be released: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // Launch agent if specified
  if (agent) {
    // Codex hooks must be installed before launch so the wrapped command can
    // point at the event file. Kept here because it needs the worktree path
    // and the persisted pane id.
    let codexHookEventFile: string | undefined;
    if (agent === 'codex') {
      try {
        codexHookEventFile = installCodexPaneHooks({
          worktreePath,
          psychePaneId: newPane.id,
          tmuxPaneId: paneInfo,
        }).eventFile;
      } catch (error) {
        LogService.getInstance().warn(
          `Failed to install Codex hooks for ${slug}: ${error instanceof Error ? error.message : String(error)}`,
          'paneCreation',
          newPane.id
        );
      }
    }

    await launchAgentInPane({
      paneId: paneInfo,
      agent,
      prompt,
      slug,
      projectRoot,
      worktreePath,
      permissionMode: settings.permissionMode,
      psychePaneId: newPane.id,
      codexHookEventFile,
      tmuxService,
    });

    if (agent === 'claude') {
      // Auto-approve trust prompts for Claude (workspace trust, not edit
      // permissions). Lives here rather than in the shared launcher because
      // agentLaunch importing this module would be circular.
      autoApproveTrustPrompt(paneInfo, prompt).catch(() => {
        // Ignore errors in background monitoring
      });
    }
  }

  // Keep focus on the new pane
  await tmuxService.selectPane(paneInfo);

  // Always destroy the welcome pane if one exists in config.
  // We do this unconditionally because shell panes detected by detectAndAddShellPanes
  // can make existingPanes.length > 0 even when no real content panes exist yet,
  // which causes isFirstContentPane to be false and skips welcome pane destruction.
  try {
    const { destroyWelcomePaneCoordinated } = await import('./welcomePaneManager.js');
    await destroyWelcomePaneCoordinated(sessionProjectRoot);
  } catch {
    // Ignore - welcome pane cleanup is not critical
  }

  // Switch back to the original pane
  await tmuxService.selectPane(originalPaneId);

  // Re-set the title for the psyche pane
  try {
    await tmuxService.setPaneTitle(originalPaneId, "psyche");
  } catch {
    // Ignore if setting title fails
  }

  return {
    pane: newPane,
    needsAgentChoice: false,
    persistedDuringLifecycle: true,
  };
}

/**
 * Auto-approve Claude trust prompts
 */
export async function autoApproveTrustPrompt(
  paneInfo: string,
  prompt: string
): Promise<void> {
  // Wait longer for Claude to start up before checking for prompts
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const maxChecks = 100; // 100 checks * 100ms = 10 seconds total
  const checkInterval = 100; // Check every 100ms
  let lastContent = '';
  let stableContentCount = 0;
  let promptHandled = false;

  // Trust prompt patterns - made more specific to avoid false positives
  const trustPromptPatterns = [
    // Specific trust/permission questions
    /Do you trust the files in this folder\?/i,
    /Trust the files in this workspace\?/i,
    /Do you trust the authors of the files/i,
    /Do you want to trust this workspace\?/i,
    /trust.*files.*folder/i,
    /trust.*workspace/i,
    /Trust this folder/i,
    /trust.*directory/i,
    /workspace.*trust/i,
    // Claude-specific numbered menu format
    /❯\s*1\.\s*Yes,\s*proceed/i,
    /Enter to confirm.*Esc to exit/i,
    /1\.\s*Yes,\s*proceed/i,
    /2\.\s*No,\s*exit/i,
  ];

  for (let i = 0; i < maxChecks; i++) {
    await new Promise((resolve) => setTimeout(resolve, checkInterval));

    try {
      // Capture the pane content
      const paneContent = capturePaneContent(paneInfo, 30);

      // Early exit: If Claude is already running (prompt has been processed), we're done
      if (
        paneContent.includes('Claude') ||
        paneContent.includes('Assistant') ||
        paneContent.includes('claude>')
      ) {
        break;
      }

      // Check if content has stabilized
      if (paneContent === lastContent) {
        stableContentCount++;
      } else {
        stableContentCount = 0;
        lastContent = paneContent;
      }

      // Look for trust prompt using specific patterns only
      const hasTrustPrompt = trustPromptPatterns.some((pattern) =>
        pattern.test(paneContent)
      );

      // Only act if we have high confidence it's a trust prompt
      if (hasTrustPrompt && !promptHandled) {
        // Require content to be stable for longer to avoid false positives
        if (stableContentCount >= 5) {
          // Check if this is the new Claude numbered menu format
          const isNewClaudeFormat =
            /❯\s*1\.\s*Yes,\s*proceed/i.test(paneContent) ||
            /Enter to confirm.*Esc to exit/i.test(paneContent);

          const tmuxService = TmuxService.getInstance();
          if (isNewClaudeFormat) {
            // For new Claude format, just press Enter
            await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
          } else {
            // Try multiple response methods for older formats
            await tmuxService.sendTmuxKeys(paneInfo, 'y');
            await new Promise((resolve) => setTimeout(resolve, 50));
            await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
            await new Promise((resolve) => setTimeout(resolve, TMUX_SPLIT_DELAY));
            await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
          }

          promptHandled = true;

          // Wait and check if prompt is gone
          await new Promise((resolve) => setTimeout(resolve, 500));

          // Verify the prompt is gone
          const updatedContent = capturePaneContent(paneInfo, 10);

          const promptGone = !trustPromptPatterns.some((p) =>
            p.test(updatedContent)
          );

          if (promptGone) {
            // Check if Claude is running
            const claudeRunning =
              updatedContent.includes('Claude') ||
              updatedContent.includes('claude') ||
              updatedContent.includes('Assistant') ||
              (prompt &&
                updatedContent.includes(
                  prompt.substring(0, Math.min(20, prompt.length))
                ));

            if (!claudeRunning && !updatedContent.includes('$')) {
              // Resend Claude command if needed
              await new Promise((resolve) => setTimeout(resolve, 300));
              // Note: We can't easily resend the command here without the escapedCmd
              // This is a limitation, but the TUI handles it
            }

            break;
          }
        }
      }
    } catch (error) {
      // Continue checking, errors are non-fatal
    }
  }
}
