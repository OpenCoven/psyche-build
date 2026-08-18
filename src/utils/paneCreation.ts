import path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import type { PaneLayout, PsychePane, PsycheConfig, MergeTargetReference } from '../types.js';
import { TmuxService } from '../services/TmuxService.js';
import {
  assertTmuxGenerationUnchanged,
  captureTmuxGeneration,
  tearDownGenerationBoundPane,
} from './TmuxGenerationGuard.js';
import {
  ensurePaneBorderStatusForCurrentSession,
  setupSidebarLayout,
  getTerminalDimensions,
  splitPane,
} from './tmux.js';
import {
  capturePaneInsertion,
  SIDEBAR_WIDTH,
} from './layoutManager.js';
import {
  insertPane,
  reconcilePaneLayout,
  seedPaneLayout,
} from '../layout/PaneLayoutTree.js';
import { generateSlug } from './slug.js';
import { capturePaneContent } from './paneCapture.js';
import { triggerHook, triggerHookSync, initializeHooksDirectory } from './hooks.js';
import { TMUX_LAYOUT_APPLY_DELAY, TMUX_SPLIT_DELAY } from '../constants/timing.js';
import { LogService } from '../services/LogService.js';
import {
  WorktreeCleanupService,
  type CreatedWorktreeIdentity,
  type WorktreeCreationReservation,
  type WorktreeReuseReservation,
} from '../services/WorktreeCleanupService.js';
import type { ProjectWorktreeLifecycleLease } from '../services/WorktreeOperationLease.js';
import {
  ensureProjectPaneConfigPane,
  mutateProjectPaneConfig,
  projectPaneConfigPath,
  readProjectPaneConfigUnderLock,
  withProjectPaneSlugAllocationLock,
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
import { createPsychePaneId } from './paneIdentity.js';
import { runGitProcess } from './gitProcess.js';
import {
  listQuarantinedPaneSlugs,
  writeWorktreeRecoveryMarker,
} from '../services/WorktreeRecoveryMarker.js';
import {
  isPaneLifecycleReservationRetainedError,
  PaneLifecycleReservationRetainedError,
  retainPaneRecovery,
  type PaneRecoveryPersistenceResult,
} from './paneLifecycleRecovery.js';

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
   * Internal allocator for reused-worktree panes. It is invoked only after
   * reuse has been reserved and the persisted pane registry has been reloaded.
   */
  resolveExistingWorktreeSlug?: (
    freshPanes: readonly PsychePane[],
  ) => string;
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
  focusedTmuxPaneId?: string | null;
  selectedPaneId?: string;
  /**
   * A caller that already owns the project lifecycle lease (for example
   * resumeBranches) passes it through so reuse does not try to re-acquire the
   * non-reentrant project lock.
   */
  projectLifecycleLease?: ProjectWorktreeLifecycleLease;
  /**
   * Internal explicit reservation used when reopening an existing worktree.
   * It is deliberately retained if a possibly-live split pane cannot be
   * made durable.
   */
  reuseReservation?: WorktreeReuseReservation;
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

function resolvePaneProjectRoot(optionsProjectRoot?: string): string {
  if (optionsProjectRoot) {
    return optionsProjectRoot;
  }

  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    if (gitCommonDir === '.git') {
      return execSync('git rev-parse --show-toplevel', {
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
    }
    return path.dirname(gitCommonDir);
  } catch {
    return process.cwd();
  }
}

function resolvePaneSessionProjectRoot(
  options: Pick<CreatePaneOptions, 'sessionConfigPath' | 'sessionProjectRoot'>,
  projectRoot: string,
): string {
  return options.sessionProjectRoot
    || (options.sessionConfigPath
      ? path.dirname(path.dirname(options.sessionConfigPath))
      : projectRoot);
}

async function persistPaneBeforeAgentLaunch(
  options: CreatePaneOptions,
  sessionProjectRoot: string,
  pane: PsychePane,
  insertion: Awaited<ReturnType<typeof capturePaneInsertion>>,
): Promise<void> {
  await mutateProjectPaneConfig(sessionProjectRoot, (configRecord) => {
    const config = configRecord as unknown as PsycheConfig;
    const currentPanes = Array.isArray(config.panes) ? config.panes : [];
    const panes = currentPanes.some((candidate) => candidate.id === pane.id)
      ? currentPanes
      : [...currentPanes, pane];
    const paneIds = panes.map((candidate) => candidate.id);
    const currentLayout = config.paneLayout;
    let paneLayout: PaneLayout;
    if (!currentLayout) {
      paneLayout = seedPaneLayout(paneIds);
    } else if (insertion && !paneIds.includes(pane.id)) {
      // The expected pane must be part of this transaction's fresh registry.
      throw new Error(`Pane layout insertion is missing pane ${pane.id}`);
    } else if (insertion) {
      paneLayout = insertPane(
        currentLayout,
        insertion.targetPaneId,
        pane.id,
        insertion.direction,
      );
    } else {
      paneLayout = reconcilePaneLayout(currentLayout, paneIds);
    }
    config.panes = panes;
    config.paneLayout = paneLayout;
    config.lastUpdated = new Date().toISOString();
  });

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

async function terminatePaneForRollback(
  tmuxService: TmuxService,
  paneId: string,
  allocationGeneration?: import('../services/TmuxServerIdentity.js').TmuxServerIdentity,
): Promise<VerifiedPaneTeardownResult> {
  if (allocationGeneration) {
    return tearDownGenerationBoundPane(
      tmuxService,
      paneId,
      allocationGeneration,
    );
  }
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
  const projectRoot = resolvePaneProjectRoot(options.projectRoot);
  const sessionProjectRoot = resolvePaneSessionProjectRoot(options, projectRoot);
  const reservation = await WorktreeCleanupService.getInstance().beginWorktreeReuseReservation(
    existingWorktree.worktreePath,
    projectRoot,
    options.projectLifecycleLease,
    sessionProjectRoot,
  );
  let settled = false;
  try {
    const reservedOptions: CreatePaneOptions = {
      ...options,
      reuseReservation: reservation,
      existingWorktree: {
        ...existingWorktree,
        worktreePath: reservation.canonicalWorktreePath,
      },
    };
    const createReservedPane = () => createPaneWithReuseReservation(
      reservedOptions,
      availableAgents,
    );

    let result: CreatePaneResult;
    if (options.resolveExistingWorktreeSlug) {
      // Lock order is reuse reservation -> project slug allocation -> pane
      // config read/write. Release the slug lock before completing or
      // cancelling reuse so cleanup never waits while holding this namespace.
      result = await withProjectPaneSlugAllocationLock(
        sessionProjectRoot,
        createReservedPane,
      );
    } else {
      result = await createReservedPane();
    }

    await reservation.complete();
    settled = true;
    return result;
  } catch (error) {
    if (isPaneLifecycleReservationRetainedError(error)) {
      settled = true;
    }
    throw error;
  } finally {
    if (!settled) {
      await reservation.cancel();
    }
  }
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
    startPointBranch,
    mergeTargetChain,
    skipAgentSelection = false,
    sessionConfigPath: optionsSessionConfigPath,
    focusedTmuxPaneId,
    selectedPaneId,
  } = options;
  let {
    agent,
    existingWorktree,
    projectRoot: optionsProjectRoot,
  } = options;

  // Load settings to check for default agent and autopilot
  const { SettingsManager } = await import('./settingsManager.js');

  const projectRoot = resolvePaneProjectRoot(optionsProjectRoot);

  const sessionProjectRoot = resolvePaneSessionProjectRoot(options, projectRoot);
  if (existingWorktree && options.resolveExistingWorktreeSlug) {
    const config = await readProjectPaneConfigUnderLock(sessionProjectRoot);
    const freshPanes = Array.isArray(config.panes)
      ? config.panes.filter((pane): pane is PsychePane => (
        typeof pane === 'object'
        && pane !== null
        && typeof (pane as Partial<PsychePane>).slug === 'string'
      ))
      : [];
    const quarantinedSlugs = await listQuarantinedPaneSlugs(sessionProjectRoot);
    existingWorktree = {
      ...existingWorktree,
      slug: options.resolveExistingWorktreeSlug([
        ...freshPanes,
        ...quarantinedSlugs.map((slug) => ({ slug } as PsychePane)),
      ]),
    };
  }

  const settingsManager = new SettingsManager(projectRoot);
  const settings = settingsManager.getSettings();
  const existingWorktreeMetadata = existingWorktree
    ? readWorktreeMetadata(existingWorktree.worktreePath)
    : null;

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

  let worktreePath = existingWorktree?.worktreePath
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
  const panesFile = optionsSessionConfigPath
    || path.join(sessionProjectRoot, '.psyche', 'psyche.config.json');
  const insertion = isFirstContentPane
    ? undefined
    : await capturePaneInsertion({
      panesFile,
      panes: existingPanes,
      focusedTmuxPaneId,
      selectedPaneId,
    });

  let paneInfo: string;
  let creationReservation: WorktreeCreationReservation | undefined;
  let createdWorktreeIdentity: CreatedWorktreeIdentity | undefined;
  let worktreeCreatedByThisAttempt = false;
  let rollbackOwnershipLostReason: string | undefined;

  const allocationGeneration = captureTmuxGeneration(
    tmuxService,
    'pane allocation',
  );
  // Self-healing: Try to create pane, if it fails due to stale controlPaneId, fix and retry
  try {
    if (isFirstContentPane) {
      // First, create the tmux pane but DON'T destroy welcome pane yet
      // This way we can save the pane to config first, THEN destroy welcome pane
      paneInfo = setupSidebarLayout(controlPaneId, projectRoot);
    } else {
      // Subsequent panes - always split horizontally, let layout manager organize
      // Get actual psyche pane IDs (not welcome pane) from existingPanes
      paneInfo = splitPane(
        insertion
          ? { targetPane: insertion.targetTmuxPaneId, cwd: projectRoot }
          : { cwd: projectRoot }
      );
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
        paneInfo = splitPane(
          insertion
            ? { targetPane: insertion.targetTmuxPaneId, cwd: projectRoot }
            : { cwd: projectRoot }
        );
      }
    } else {
      // Different error, re-throw
      throw error;
    }
  }

  const tmuxServerIdentity = allocationGeneration;
  const newPane: PsychePane = {
    id: createPsychePaneId(),
    slug,
    displayName: existingWorktreeMetadata?.displayName,
    branchName: branchName !== slug ? branchName : undefined,
    prompt: prompt || 'No initial prompt',
    paneId: paneInfo,
    ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
    projectRoot,
    projectName: paneProjectName,
    colorTheme: resolveProjectColorTheme(projectRoot, configSidebarProjects),
    worktreePath,
    agent,
    permissionMode: settings.permissionMode,
    autopilot: settings.enableAutopilotByDefault ?? false,
    mergeTargetChain,
  };

  // From the instant a tmux split succeeds, every readiness/layout/title
  // failure must either leave an exact durable record or prove the pane is
  // gone. Construct the identity before touching any fallible post-split
  // operation so uncertain teardown has something precise to retain.
  try {
    assertTmuxGenerationUnchanged(
      tmuxService,
      allocationGeneration,
      'pane allocation',
    );
  } catch (error) {
    const teardown = await tearDownGenerationBoundPane(
      tmuxService,
      paneInfo,
      allocationGeneration,
      { generationMismatch: 'unknown' },
    );
    const recovery = teardown.presence === 'absent'
      ? undefined
      : await retainPaneRecovery({
        projectRoot,
        sessionProjectRoot,
        pane: newPane,
        operation: 'pane-creation-generation',
        reason: `${error instanceof Error ? error.message : String(error)}; pane teardown is ${teardown.presence}`,
        reservation: options.reuseReservation,
        persistConfigRecovery: async () => ({
          durable: false,
          message: 'refused to persist an unversioned pane record',
        }),
      });
    if (recovery?.retained) {
      throw new PaneLifecycleReservationRetainedError(
        `Could not verify tmux server generation for pane "${slug}"; ${recovery.message}`,
      );
    }
    throw new Error(
      `Could not verify tmux server generation for pane "${slug}"${
        recovery ? `; ${recovery.message}` : ''
      }`,
    );
  }

  try {
    await waitForPaneReady(tmuxService, paneInfo);

    const paneTitle = projectRoot === sessionProjectRoot
      ? slug
      : buildWorktreePaneTitle(slug, projectRoot, paneProjectName);
    await tmuxService.setPaneTitle(paneInfo, paneTitle);

  } catch (error) {
    const teardown = await terminatePaneForRollback(
      tmuxService,
      paneInfo,
      tmuxServerIdentity,
    );
    const recovery = teardown.presence === 'absent'
      ? undefined
      : await retainPaneRecovery({
        projectRoot,
        sessionProjectRoot,
        pane: newPane,
        operation: 'pane-creation-post-split',
        reason: `post-split setup failed: ${error instanceof Error ? error.message : String(error)}`,
        reservation: options.reuseReservation,
        persistConfigRecovery: () => persistPaneRecoveryRecord(sessionProjectRoot, newPane),
      });
    if (recovery?.retained) {
      throw new PaneLifecycleReservationRetainedError(
        `Failed to prepare pane "${slug}" after split: ${error instanceof Error ? error.message : String(error)}; ${recovery.message}`,
      );
    }
    throw new Error(
      `Failed to prepare pane "${slug}" after split: ${
        error instanceof Error ? error.message : String(error)
      }${recovery ? `; ${recovery.message}` : ''}`,
    );
  }

  const retainRecoveryAfterUncertainTeardown = (
    operation: string,
    reason: string,
  ) => retainPaneRecovery({
    projectRoot,
    sessionProjectRoot,
    pane: newPane,
    operation,
    reason,
    reservation: creationReservation || options.reuseReservation,
    persistConfigRecovery: () => persistPaneRecoveryRecord(sessionProjectRoot, newPane),
  });

  const preserveUnownedCreatedWorktree = async (
    operation: string,
    failureReason: string,
  ): Promise<string | undefined> => {
    if (!worktreeCreatedByThisAttempt || !rollbackOwnershipLostReason) {
      return undefined;
    }

    const reason = [
      rollbackOwnershipLostReason,
      `Later ${operation} failure: ${failureReason}`,
      `Preserved worktree ${worktreePath} and branch ${branchName}; this transaction never claimed destructive rollback ownership.`,
    ].join(' ');
    try {
      const marker = await writeWorktreeRecoveryMarker({
        sessionProjectRoot,
        projectRoot,
        worktreePath,
        pane: { id: newPane.id, paneId: newPane.paneId },
        operation: 'worktree-creation-ownership',
        reason,
      });
      return `preserved hook-modified worktree and branch; recovery marker ${marker.path}. ${marker.marker.operatorInstructions}`;
    } catch (error) {
      return `preserved hook-modified worktree and branch, but could not write recovery marker: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
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
    const teardown = await terminatePaneForRollback(
      tmuxService,
      paneInfo,
      tmuxServerIdentity,
    );
    const recovery = teardown.presence === 'absent'
      ? undefined
      : await retainRecoveryAfterUncertainTeardown(
        'pane-created-hook',
        `pane_created hook failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    if (recovery?.retained) {
      throw new PaneLifecycleReservationRetainedError(
        `Failed to create pane "${slug}": pane_created hook failed: ${
          error instanceof Error ? error.message : String(error)
        }; ${recovery.message}`,
      );
    }
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
          sessionProjectRoot,
        );
      worktreePath = creationReservation.canonicalWorktreePath;
      newPane.worktreePath = worktreePath;

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

      const worktreeArgs = branchExists
        ? ['worktree', 'add', worktreePath, branchName]
        : [
          'worktree',
          'add',
          worktreePath,
          '-b',
          branchName,
          ...(resolvedStartPoint ? [resolvedStartPoint] : []),
        ];
      // Creation ownership begins only after this direct child exits zero.
      // A directory appearing after a failed child can belong to an external
      // creator and must never be rolled back by this transaction.
      const supervisedMutation = (
        creationReservation as WorktreeCreationReservation & {
          runGitMutation?: (
            args: readonly string[],
            cwd: string,
          ) => ReturnType<typeof runGitProcess>;
        }
      ).runGitMutation;
      const addResult = supervisedMutation
        ? await supervisedMutation(worktreeArgs, projectRoot)
        : await runGitProcess(worktreeArgs, projectRoot);
      if (addResult.exitCode !== 0) {
        throw new Error(
          `git ${worktreeArgs.join(' ')} failed with exit code ${
            addResult.exitCode ?? 'unknown'
          }${addResult.stderr ? `: ${addResult.stderr}` : ''}`,
        );
      }
      worktreeCreatedByThisAttempt = true;

      let createdOid: string;
      try {
        createdOid = execSync(
          `git rev-parse --verify --end-of-options "${branchName}"`,
          {
            cwd: projectRoot,
            encoding: 'utf-8',
            stdio: 'pipe',
          }
        ).trim();
      } catch (error) {
        rollbackOwnershipLostReason = (
          `Could not verify branch ${branchName} after git worktree add: ${
            error instanceof Error ? error.message : String(error)
          }.`
        );
        throw error;
      }
      const checkedOutBranch = execSync(
        `git -C "${worktreePath}" rev-parse --abbrev-ref HEAD`,
        {
          cwd: projectRoot,
          encoding: 'utf-8',
          stdio: 'pipe',
        }
      ).trim();
      if (!createdOid || checkedOutBranch !== branchName) {
        rollbackOwnershipLostReason = (
          `Could not verify that ${worktreePath} remains checked out on ${branchName} `
          + `after git worktree add (found ${checkedOutBranch || 'no branch'}).`
        );
        throw new Error(
          `Created worktree identity does not match ${branchName} at ${worktreePath}`
        );
      }
      if (createdOid !== startingOid) {
        // Git hooks run during `worktree add`. A post-checkout hook can make a
        // real commit before this child exits, which means this transaction no
        // longer owns the branch tip and must never roll it back.
        rollbackOwnershipLostReason = (
          `Branch ${branchName} changed from ${startingOid} to ${createdOid} `
          + 'during git worktree add (for example, a post-checkout hook commit).'
        );
      } else {
        createdWorktreeIdentity = creationReservation.recordCreatedWorktree({
          branchName,
          startingOid,
          createdOid,
          deleteBranch: !branchExists,
          configProjectRoot: sessionProjectRoot,
        });
      }

      // The pane is moved only after direct Git creation and identity
      // verification succeed. No tmux shell command creates lifecycle state.
      await tmuxService.sendShellCommand(paneInfo, `cd "${worktreePath}"`);
      await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
      await new Promise((resolve) => setTimeout(resolve, 300));
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
    const teardown = await terminatePaneForRollback(
      tmuxService,
      paneInfo,
      tmuxServerIdentity,
    );
    const recovery = teardown.presence === 'absent'
      ? undefined
      : await retainRecoveryAfterUncertainTeardown(
        'worktree-creation',
        `worktree creation failed: ${errorMsg}`,
      );
    const ownershipRecovery = await preserveUnownedCreatedWorktree(
      'worktree creation',
      errorMsg,
    );
    let rollbackError: string | undefined;
    if (teardown.presence === 'absent' && creationReservation && createdWorktreeIdentity) {
      const rollbackResult = await creationReservation.rollbackCreatedWorktree(
        createdWorktreeIdentity
      );
      if (!rollbackResult.success) {
        rollbackError = rollbackResult.error || 'unknown rollback failure';
      }
    } else if (
      teardown.presence === 'absent'
      && worktreeCreatedByThisAttempt
      && !rollbackOwnershipLostReason
    ) {
      rollbackError = 'worktree identity could not be recorded';
    }
    if (recovery?.retained) {
      throw new PaneLifecycleReservationRetainedError(
        `Failed to create worktree for "${slug}": ${errorMsg}; ${recovery.message}${
          ownershipRecovery ? `; ${ownershipRecovery}` : ''
        }`,
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
      `Failed to create worktree for "${slug}": ${errorMsg}${
        rollbackError ? `; rollback failed: ${rollbackError}` : ''
      }${
        recovery ? `; ${recovery.message}` : ''
      }${
        ownershipRecovery ? `; ${ownershipRecovery}` : ''
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
    const teardown = await terminatePaneForRollback(
      tmuxService,
      paneInfo,
      tmuxServerIdentity,
    );
    const recovery = teardown.presence === 'absent'
      ? undefined
      : await retainRecoveryAfterUncertainTeardown(
        'worktree-created-hook',
        `worktree_created hook failed: ${hookError}`,
      );
    const ownershipRecovery = await preserveUnownedCreatedWorktree(
      'worktree_created hook',
      hookError,
    );
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
    } else if (
      teardown.presence === 'absent'
      && worktreeCreatedByThisAttempt
      && !rollbackOwnershipLostReason
    ) {
      rollbackError = 'worktree identity could not be recorded';
      LogService.getInstance().error(
        `Failed to roll back newly created worktree for ${slug}: ${rollbackError}`,
        'paneCreation',
        newPane.id,
        new Error(rollbackError)
      );
    }
    if (recovery?.retained) {
      throw new PaneLifecycleReservationRetainedError(
        `worktree_created hook failed for "${slug}": ${hookError}; ${recovery.message}${
          ownershipRecovery ? `; ${ownershipRecovery}` : ''
        }`,
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
      }${
        ownershipRecovery ? `; ${ownershipRecovery}` : ''
      }`
    );
  }

  // A worktree is not safe to expose to an agent until the pane registry
  // points at it. Keep the creation/reuse lease through this mutation so
  // queued cleanup cannot observe an unreferenced active worktree.
  try {
    await persistPaneBeforeAgentLaunch(
      options,
      sessionProjectRoot,
      newPane,
      insertion,
    );
  } catch (error) {
    const persistenceError = error instanceof Error ? error.message : String(error);
    const teardown = await terminatePaneForRollback(
      tmuxService,
      paneInfo,
      tmuxServerIdentity,
    );
    const recovery = teardown.presence === 'absent'
      ? undefined
      : await retainRecoveryAfterUncertainTeardown(
        'pane-persistence',
        `initial pane persistence failed: ${persistenceError}`,
      );
    const ownershipRecovery = await preserveUnownedCreatedWorktree(
      'pane persistence',
      persistenceError,
    );
    let rollbackError: string | undefined;
    if (teardown.presence === 'absent' && creationReservation && createdWorktreeIdentity) {
      const rollbackResult = await creationReservation.rollbackCreatedWorktree(
        createdWorktreeIdentity
      );
      if (!rollbackResult.success) {
        rollbackError = rollbackResult.error || 'unknown rollback failure';
      }
    }
    if (recovery?.retained) {
      throw new PaneLifecycleReservationRetainedError(
        `Failed to persist pane "${slug}" before agent launch: ${persistenceError}; ${recovery.message}${
          ownershipRecovery ? `; ${ownershipRecovery}` : ''
        }`,
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
    throw new Error(
      `Failed to persist pane "${slug}" before agent launch: ${persistenceError}${
        rollbackError ? `; rollback failed: ${rollbackError}` : ''
      }${
        recovery ? `; ${recovery.message}` : ''
      }${
        ownershipRecovery ? `; ${ownershipRecovery}` : ''
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
