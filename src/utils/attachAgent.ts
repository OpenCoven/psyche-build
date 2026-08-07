/**
 * Attach a second (or Nth) agent to an existing worktree pane.
 *
 * Creates a new tmux pane that `cd`s into the same worktree directory,
 * launches the chosen agent, and returns a sibling PsychePane that shares
 * the same worktreePath/branchName/projectRoot.
 */

import path from 'path';
import type { PsychePane } from '../types.js';
import type { AgentName } from './agentLaunch.js';
import { launchAgentInPane } from './agentLaunch.js';
import { autoApproveTrustPrompt } from './paneCreation.js';
import { TmuxService } from '../services/TmuxService.js';
import { splitPane, getTerminalDimensions } from './tmux.js';
import { recalculateAndApplyLayout } from './layoutManager.js';
import { buildWorktreePaneTitle } from './paneTitle.js';
import { SettingsManager } from './settingsManager.js';
import { LogService } from '../services/LogService.js';
import { installCodexPaneHooks } from './codexHooks.js';
import { resolveProjectColorTheme } from './paneColors.js';
import { WorktreeCleanupService } from '../services/WorktreeCleanupService.js';
import {
  readProjectPaneConfigUnderLock,
  removeProjectPaneConfigPanes,
  upsertProjectPaneConfigPanes,
} from '../services/ProjectPaneConfig.js';

export interface AttachAgentOptions {
  targetPane: PsychePane;
  prompt: string;
  agent: AgentName;
  existingPanes: PsychePane[];
  sessionProjectRoot: string;
  /**
   * Retained for callers using the older API. Config access is now derived
   * from sessionProjectRoot and performed through the shared mutation APIs.
   */
  sessionConfigPath?: string;
}

/**
 * Generate a unique sibling slug like `fix-auth-a2`, `fix-auth-a3`, etc.
 */
export function generateSiblingSlugForTargetPane(
  targetPane: Pick<PsychePane, 'slug' | 'worktreePath'>,
  existingPanes: ReadonlyArray<Pick<PsychePane, 'slug'>>,
): string {
  // Always anchor attached-agent slugs to the real worktree directory name.
  // This avoids repeated suffixes when attaching from an already attached pane.
  const worktreeSlug = targetPane.worktreePath
    ? path.basename(targetPane.worktreePath)
    : '';
  const baseSlug = worktreeSlug || targetPane.slug;

  const siblingPrefix = `${baseSlug}-a`;
  let maxSibling = 1;

  for (const pane of existingPanes) {
    if (!pane.slug.startsWith(siblingPrefix)) continue;
    const suffix = pane.slug.slice(siblingPrefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    maxSibling = Math.max(maxSibling, Number.parseInt(suffix, 10));
  }

  return `${baseSlug}-a${maxSibling + 1}`;
}

export async function attachAgentToWorktree(
  options: AttachAgentOptions
): Promise<{ pane: PsychePane }> {
  if (!options.targetPane.worktreePath) {
    throw new Error('Target pane has no worktree to attach to');
  }

  const projectRoot = options.targetPane.projectRoot || options.sessionProjectRoot;
  return WorktreeCleanupService.getInstance().withWorktreeReuseReservation(
    options.targetPane.worktreePath,
    async (canonicalWorktreePath) => attachAgentToReservedWorktree({
      ...options,
      targetPane: {
        ...options.targetPane,
        worktreePath: canonicalWorktreePath,
      },
    }),
    projectRoot,
  );
}

async function attachAgentToReservedWorktree(
  options: AttachAgentOptions,
): Promise<{ pane: PsychePane }> {
  const {
    targetPane,
    prompt,
    agent,
    existingPanes,
    sessionProjectRoot,
  } = options;
  if (!targetPane.worktreePath) {
    throw new Error('Target pane has no worktree to attach to');
  }
  const worktreePath = targetPane.worktreePath;
  const projectRoot = targetPane.projectRoot || sessionProjectRoot;
  const settingsManager = new SettingsManager(projectRoot);
  const settings = settingsManager.getSettings();

  // Generate a unique slug for this sibling
  const slug = generateSiblingSlugForTargetPane(targetPane, existingPanes);

  const tmuxService = TmuxService.getInstance();
  const originalPaneId = tmuxService.getCurrentPaneIdSync();

  // Read the control-pane state through the shared config lease so an
  // attachment never reads a partially written registry.
  let controlPaneId = originalPaneId;
  try {
    const config = await readProjectPaneConfigUnderLock(sessionProjectRoot);
    if (typeof config.controlPaneId === 'string' && config.controlPaneId) {
      controlPaneId = config.controlPaneId;
    }
  } catch {
    // The current pane is a safe fallback when config reads are transiently
    // unavailable. Persistence below still uses the cross-process API.
  }

  let paneInfo: string | undefined;
  try {
    // Split from the last existing pane (standard grid placement)
    const psychePaneIds = existingPanes.map(p => p.paneId);
    const splitTarget = psychePaneIds[psychePaneIds.length - 1];
    paneInfo = splitPane({ targetPane: splitTarget, cwd: projectRoot });

    // Wait for pane to be ready
    const start = Date.now();
    while ((Date.now() - start) < 600) {
      if (await tmuxService.paneExists(paneInfo)) break;
      await new Promise(r => setTimeout(r, 30));
    }

    // Set pane title
    try {
      const paneProjectName = targetPane.projectName || path.basename(projectRoot);
      const paneTitle = projectRoot === sessionProjectRoot
        ? slug
        : buildWorktreePaneTitle(slug, projectRoot, paneProjectName);
      await tmuxService.setPaneTitle(paneInfo, paneTitle);
    } catch {
      // Ignore title errors
    }

    // Recalculate layout
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

    // cd into the existing worktree (no git worktree add)
    const cdCmd = `cd "${worktreePath}"`;
    await tmuxService.sendShellCommand(paneInfo, cdCmd);
    await tmuxService.sendTmuxKeys(paneInfo, 'Enter');

    // Small delay for cd to complete
    await new Promise(r => setTimeout(r, 300));
  } catch (error) {
    if (paneInfo) {
      await killAttachedPane(tmuxService, paneInfo, slug, 'setup failure');
    }
    throw new Error(
      `Failed to prepare attached pane "${slug}": ${errorMessage(error)}`,
    );
  }
  if (!paneInfo) {
    throw new Error(`Failed to prepare attached pane "${slug}": tmux returned no pane ID`);
  }

  const psychePaneId = `psyche-${Date.now()}`;
  const newPane: PsychePane = {
    id: psychePaneId,
    slug,
    branchName: targetPane.branchName,
    prompt: prompt || 'No initial prompt',
    paneId: paneInfo,
    projectRoot,
    projectName: targetPane.projectName,
    colorTheme: targetPane.colorTheme || resolveProjectColorTheme(projectRoot, []),
    worktreePath,
    agent,
    permissionMode: settings.permissionMode,
    autopilot: settings.enableAutopilotByDefault ?? false,
  };

  // A reused worktree remains reserved until this record is durable, so
  // cleanup cannot remove it between pane creation and agent launch.
  try {
    await upsertProjectPaneConfigPanes(sessionProjectRoot, [newPane]);
  } catch (error) {
    await killAttachedPane(tmuxService, paneInfo, slug, 'pane persistence failure');
    throw new Error(
      `Failed to persist attached pane "${slug}" before agent launch: ${errorMessage(error)}`,
    );
  }

  let codexHookEventFile: string | undefined;
  if (agent === 'codex') {
    try {
      codexHookEventFile = installCodexPaneHooks({
        worktreePath,
        psychePaneId,
        tmuxPaneId: paneInfo,
      }).eventFile;
    } catch (error) {
      LogService.getInstance().warn(
        `Failed to install Codex hooks for ${slug}: ${errorMessage(error)}`,
        'attachAgent',
        psychePaneId
      );
    }
  }

  try {
    await launchAgentInPane({
      paneId: paneInfo,
      agent,
      prompt,
      slug,
      projectRoot,
      // The attached agent runs in the target pane's worktree, not the project
      // root, so workspace-trust setup has to point at the worktree.
      worktreePath,
      psychePaneId,
      codexHookEventFile,
      permissionMode: settings.permissionMode,
    });
  } catch (error) {
    const cleanupError = await removeFailedAttachedPane(
      tmuxService,
      paneInfo,
      sessionProjectRoot,
      newPane,
    );
    throw new Error(
      `Failed to launch attached agent for "${slug}": ${errorMessage(error)}${
        cleanupError ? `; ${cleanupError}` : ''
      }`,
    );
  }

  // Auto-approve trust prompts for Claude
  if (agent === 'claude') {
    autoApproveTrustPrompt(paneInfo, prompt).catch(() => {
      // Ignore errors in background monitoring
    });
  }

  // Keep focus on the new pane
  try {
    await tmuxService.selectPane(paneInfo);
  } catch (error) {
    LogService.getInstance().warn(
      `Failed to focus attached pane ${paneInfo}: ${errorMessage(error)}`,
      'attachAgent',
      psychePaneId,
    );
  }

  // Switch focus back to control pane
  try {
    await tmuxService.selectPane(originalPaneId);
  } catch (error) {
    LogService.getInstance().warn(
      `Failed to restore focus after attaching ${slug}: ${errorMessage(error)}`,
      'attachAgent',
      psychePaneId,
    );
  }

  // Re-set the psyche sidebar title
  try {
    await tmuxService.setPaneTitle(originalPaneId, "psyche");
  } catch {
    // Ignore title errors
  }

  LogService.getInstance().info(
    `Attached ${agent} to worktree ${worktreePath} as ${slug}`,
    'attachAgent',
  );

  return { pane: newPane };
}

async function killAttachedPane(
  tmuxService: TmuxService,
  paneId: string,
  slug: string,
  reason: string,
): Promise<string | undefined> {
  try {
    await tmuxService.killPane(paneId);
    return undefined;
  } catch (error) {
    const message = errorMessage(error);
    LogService.getInstance().warn(
      `Failed to kill attached pane ${paneId} for ${slug} after ${reason}: ${message}`,
      'attachAgent',
    );
    return message;
  }
}

/**
 * Failed launches follow the old attached-agent UX (the failed attachment
 * disappears), but only after the pane is killed. If tmux teardown fails, the
 * durable record is deliberately retained so a live pane is never untracked.
 */
async function removeFailedAttachedPane(
  tmuxService: TmuxService,
  paneId: string,
  sessionProjectRoot: string,
  pane: PsychePane,
): Promise<string | undefined> {
  const killError = await killAttachedPane(
    tmuxService,
    paneId,
    pane.slug,
    'agent launch failure',
  );
  if (killError) {
    return `failed to kill pane ${paneId}; retained tracked pane record ${pane.id}`;
  }

  try {
    await removeProjectPaneConfigPanes(sessionProjectRoot, [pane.id]);
    return undefined;
  } catch (error) {
    const message = errorMessage(error);
    LogService.getInstance().warn(
      `Failed to remove failed attached pane record ${pane.id}: ${message}`,
      'attachAgent',
      pane.id,
    );
    return `failed to remove pane record ${pane.id} after killing pane ${paneId}: ${message}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
