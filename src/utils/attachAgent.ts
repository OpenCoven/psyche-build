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
import {
  WorktreeCleanupService,
  type WorktreeReuseReservation,
} from '../services/WorktreeCleanupService.js';
import {
  compareAndRemoveProjectPaneConfigPaneIdentities,
  projectPaneConfigPath,
  transactProjectPaneConfig,
} from '../services/ProjectPaneConfig.js';
import {
  paneRecoveryInstructions,
  tearDownPaneWithVerification,
  type TmuxPanePresence,
  type VerifiedPaneTeardownResult,
} from './paneTeardown.js';
import { createPsychePaneId } from './paneIdentity.js';
import {
  isPaneLifecycleReservationRetainedError,
  PaneLifecycleReservationRetainedError,
  retainPaneRecovery,
  type PaneRecoveryPersistenceResult,
} from './paneLifecycleRecovery.js';

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
  const reservation = await WorktreeCleanupService.getInstance().beginWorktreeReuseReservation(
    options.targetPane.worktreePath,
    projectRoot,
  );
  let settled = false;
  try {
    const result = await attachAgentToReservedWorktree(
      {
        ...options,
        targetPane: {
          ...options.targetPane,
          worktreePath: reservation.canonicalWorktreePath,
        },
      },
      reservation,
    );
    await reservation.complete();
    settled = true;
    return result;
  } catch (error) {
    if (isPaneLifecycleReservationRetainedError(error)) {
      reservation.retain();
      settled = true;
    }
    throw error;
  } finally {
    if (!settled) {
      await reservation.cancel();
    }
  }
}

async function attachAgentToReservedWorktree(
  options: AttachAgentOptions,
  reservation: WorktreeReuseReservation,
): Promise<{ pane: PsychePane }> {
  const {
    targetPane,
    prompt,
    agent,
    sessionProjectRoot,
  } = options;
  if (!targetPane.worktreePath) {
    throw new Error('Target pane has no worktree to attach to');
  }
  const worktreePath = targetPane.worktreePath;
  const projectRoot = targetPane.projectRoot || sessionProjectRoot;
  const settingsManager = new SettingsManager(projectRoot);
  const settings = settingsManager.getSettings();

  const tmuxService = TmuxService.getInstance();
  const originalPaneId = tmuxService.getCurrentPaneIdSync();
  const psychePaneId = createPsychePaneId();
  let paneInfo: string | undefined;
  let newPane: PsychePane | undefined;

  // The worktree reuse reservation holds the project lifecycle lease before
  // this transaction starts. Allocate from the transaction's fresh panes and
  // make the exact record durable before another attach can allocate a
  // sibling. Caller-provided existingPanes is deliberately not consulted.
  const transaction = await transactProjectPaneConfig(
    sessionProjectRoot,
    async ({ config, persist }) => {
      const freshPanes = Array.isArray(config.panes)
        ? config.panes as PsychePane[]
        : [];
      const slug = generateSiblingSlugForTargetPane(targetPane, freshPanes);
      let controlPaneId = typeof config.controlPaneId === 'string' && config.controlPaneId
        ? config.controlPaneId
        : originalPaneId;

      try {
        if (controlPaneId && !(await tmuxService.paneExists(controlPaneId))) {
          controlPaneId = originalPaneId;
        }
      } catch {
        // The transaction still protects allocation; the current pane is a
        // safe layout fallback when tmux cannot answer this cosmetic probe.
        controlPaneId = originalPaneId;
      }

      try {
        const panesForLayout = freshPanes.length > 0
          ? freshPanes
          : [targetPane];
        const splitTarget = panesForLayout.at(-1)?.paneId;
        paneInfo = splitPane({ targetPane: splitTarget, cwd: projectRoot });
        if (!paneInfo) {
          throw new Error('tmux returned no pane ID');
        }

        const tmuxServerIdentity = tmuxService.getServerIdentity?.(paneInfo);
        newPane = {
          id: psychePaneId,
          slug,
          branchName: targetPane.branchName,
          prompt: prompt || 'No initial prompt',
          paneId: paneInfo,
          ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
          projectRoot,
          projectName: targetPane.projectName,
          colorTheme: targetPane.colorTheme || resolveProjectColorTheme(projectRoot, []),
          worktreePath,
          agent,
          permissionMode: settings.permissionMode,
          autopilot: settings.enableAutopilotByDefault ?? false,
        };
        if (!tmuxServerIdentity) {
          throw new Error(
            `Could not capture tmux server generation for attached pane ${paneInfo}`,
          );
        }

        // The exact record and generation are durable before this pane
        // receives a title, layout mutation, cwd, or agent command.
        config.projectName = config.projectName || path.basename(sessionProjectRoot);
        config.projectRoot = config.projectRoot || sessionProjectRoot;
        config.panes = [...freshPanes, newPane];
        config.lastUpdated = new Date().toISOString();
        await persist();

        const start = Date.now();
        while ((Date.now() - start) < 600) {
          if (await tmuxService.paneExists(paneInfo)) break;
          await new Promise(r => setTimeout(r, 30));
        }

        try {
          const paneProjectName = targetPane.projectName || path.basename(projectRoot);
          const paneTitle = projectRoot === sessionProjectRoot
            ? slug
            : buildWorktreePaneTitle(slug, projectRoot, paneProjectName);
          await tmuxService.setPaneTitle(paneInfo, paneTitle);
        } catch {
          // Ignore title errors.
        }

        if (controlPaneId) {
          const dimensions = getTerminalDimensions();
          const allContentPaneIds = [...panesForLayout.map(p => p.paneId), paneInfo];
          await recalculateAndApplyLayout(
            controlPaneId,
            allContentPaneIds,
            dimensions.width,
            dimensions.height,
          );
          await tmuxService.refreshClient();
        }

        await tmuxService.sendShellCommand(paneInfo, `cd "${worktreePath}"`);
        await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
        await new Promise(r => setTimeout(r, 300));
        return newPane;
      } catch (error) {
        const teardown = paneInfo
          ? await killAttachedPane(tmuxService, paneInfo, slug, 'setup or persistence failure')
          : undefined;
        const recovery = teardown && teardown.presence !== 'absent' && newPane
          ? await retainPaneRecovery({
            projectRoot,
            sessionProjectRoot,
            pane: newPane,
            operation: 'attach-agent',
            reason: `attached pane setup or persistence failed: ${errorMessage(error)}`,
            reservation,
            persistConfigRecovery: newPane.tmuxServerIdentity
              ? () => persistAttachedRecoveryRecord(
                config,
                persist,
                freshPanes,
                newPane!,
                sessionProjectRoot,
              )
              : async () => ({
                durable: false,
                message: 'refused to persist an unversioned attached pane record',
              }),
          })
          : undefined;
        const recoveryMessage = teardown && teardown.presence !== 'absent'
          ? `; ${recovery?.message || paneRecoveryInstructions(
            paneInfo || psychePaneId,
            projectPaneConfigPath(sessionProjectRoot),
          )}`
          : '';
        if (recovery?.retained) {
          throw new PaneLifecycleReservationRetainedError(
            `Failed to prepare attached pane "${slug}": ${errorMessage(error)}${recoveryMessage}`,
          );
        }
        throw new Error(
          `Failed to prepare attached pane "${slug}": ${errorMessage(error)}${recoveryMessage}`,
        );
      }
    },
  );
  const attachedPane = transaction.result as PsychePane;
  newPane = attachedPane;
  const slug = attachedPane.slug;
  const attachedPaneId = attachedPane.paneId;

  let codexHookEventFile: string | undefined;
  if (agent === 'codex') {
    try {
      codexHookEventFile = installCodexPaneHooks({
        worktreePath,
        psychePaneId,
        tmuxPaneId: attachedPaneId,
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
      paneId: attachedPaneId,
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
      attachedPaneId,
      sessionProjectRoot,
      attachedPane,
    );
    throw new Error(
      `Failed to launch attached agent for "${slug}": ${errorMessage(error)}${
        cleanupError ? `; ${cleanupError}` : ''
      }`,
    );
  }

  // Auto-approve trust prompts for Claude
  if (agent === 'claude') {
    autoApproveTrustPrompt(attachedPaneId, prompt).catch(() => {
      // Ignore errors in background monitoring
    });
  }

  // Keep focus on the new pane
  try {
    await tmuxService.selectPane(attachedPaneId);
  } catch (error) {
    LogService.getInstance().warn(
      `Failed to focus attached pane ${attachedPaneId}: ${errorMessage(error)}`,
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

  return { pane: attachedPane };
}

async function killAttachedPane(
  tmuxService: TmuxService,
  paneId: string,
  slug: string,
  reason: string,
): Promise<VerifiedPaneTeardownResult> {
  const result = await tearDownPaneWithVerification({
    probe: () => probeAttachedPanePresence(tmuxService, paneId),
    kill: () => tmuxService.killPane(paneId),
  });
  if (result.presence !== 'absent') {
    LogService.getInstance().warn(
      `Could not confirm attached pane ${paneId} is gone for ${slug} after ${reason}`,
      'attachAgent',
    );
  }
  return result;
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
  try {
    let teardown: VerifiedPaneTeardownResult | undefined;
    await compareAndRemoveProjectPaneConfigPaneIdentities(
      sessionProjectRoot,
      [{ id: pane.id, paneId }],
      async () => {
        teardown = await killAttachedPane(
          tmuxService,
          paneId,
          pane.slug,
          'agent launch failure',
        );
        if (teardown.presence !== 'absent') {
          throw new Error(
            `could not confirm pane ${paneId} is closed (${teardown.presence}); retained tracked pane record ${pane.id}. ${
              paneRecoveryInstructions(paneId, projectPaneConfigPath(sessionProjectRoot))
            }`,
          );
        }
      },
    );
    return undefined;
  } catch (error) {
    const message = errorMessage(error);
    LogService.getInstance().warn(
      `Failed to remove failed attached pane record ${pane.id}: ${message}`,
      'attachAgent',
      pane.id,
    );
    return `failed to remove exact pane record ${pane.id} after launch failure: ${message}`;
  }
}

async function persistAttachedRecoveryRecord(
  config: Record<string, unknown>,
  persist: () => Promise<void>,
  freshPanes: PsychePane[],
  pane: PsychePane,
  sessionProjectRoot: string,
): Promise<PaneRecoveryPersistenceResult> {
  const panes = Array.isArray(config.panes)
    ? config.panes as PsychePane[]
    : freshPanes;
  if (!panes.some((candidate) => candidate.id === pane.id)) {
    config.panes = [...panes, pane];
  }
  config.lastUpdated = new Date().toISOString();

  const configPath = projectPaneConfigPath(sessionProjectRoot);
  try {
    await persist();
    return {
      durable: true,
      message: `retained recovery record ${pane.id} in ${configPath}. ${
        paneRecoveryInstructions(pane.paneId, configPath)
      }`,
    };
  } catch (error) {
    return {
      durable: false,
      message: `could not persist recovery record ${pane.id}: ${errorMessage(error)}. ${
        paneRecoveryInstructions(pane.paneId, configPath)
      }`,
    };
  }
}

async function probeAttachedPanePresence(
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
