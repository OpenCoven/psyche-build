/**
 * CLOSE Action - Close a pane with various cleanup options
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import type { PsychePane, PsycheConfig } from '../../types.js';
import type { ActionResult, ActionContext, ActionOption } from '../types.js';
import { StateManager } from '../../shared/StateManager.js';
import { PaneLifecycleManager } from '../../services/PaneLifecycleManager.js';
import { triggerHook, triggerHookSync } from '../../utils/hooks.js';
import { LogService } from '../../services/LogService.js';
import { WorktreeCleanupService } from '../../services/WorktreeCleanupService.js';
import { deriveProjectRootFromWorktreePath, getPaneProjectRoot } from '../../utils/paneProject.js';
import { cleanupPromptFilesForSlug } from '../../utils/promptStore.js';
import { buildDevWatchRespawnCommand } from '../../utils/devWatchCommand.js';
import { isActiveDevSourcePath } from '../../utils/devSource.js';
import { getPaneDisplayName } from '../../utils/paneTitle.js';
import { paneReferencesWorktree } from '../../utils/paneWorktreeReference.js';
import {
  paneRecoveryInstructions,
  tearDownFullPaneWithVerification,
  verifyFullPaneAbsent,
  type TmuxPanePresence,
} from '../../utils/paneTeardown.js';
import {
  getCurrentTmuxServerIdentity,
  sameTmuxServerIdentity,
  type TmuxServerIdentity,
} from '../../services/TmuxServerIdentity.js';
import {
  assessTmuxTeardownOwnership,
} from '../../services/TmuxResourceOwnership.js';

function probeTmuxPanePresence(paneId: string): TmuxPanePresence {
  try {
    const paneList = execSync('tmux list-panes -a -F "#{pane_id}"', {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    });
    return paneList
      .toString()
      .split('\n')
      .map((line) => line.trim())
      .map((line) => line.match(/^%\d+/)?.[0] || line)
      .includes(paneId)
      ? 'present'
      : 'absent';
  } catch {
    LogService.getInstance().warn(
      `Could not verify whether pane ${paneId} exists; preserving pane record and worktree`,
      'paneActions'
    );
    return 'unknown';
  }
}

function probeTmuxWindowPresence(windowId: string): TmuxPanePresence {
  try {
    const windowList = execSync('tmux list-windows -a -F "#{window_id}"', {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    });
    return windowList
      .toString()
      .split('\n')
      .map((line) => line.trim())
      .includes(windowId)
      ? 'present'
      : 'absent';
  } catch {
    LogService.getInstance().warn(
      `Could not verify whether background window ${windowId} exists; preserving pane record and worktree`,
      'paneActions',
    );
    return 'unknown';
  }
}

async function tearDownOwnedPane(
  pane: PsychePane,
  panes: readonly PsychePane[],
  getCurrentGeneration: () => TmuxServerIdentity | undefined,
) {
  const currentGeneration = getCurrentGeneration();
  const assessment = assessTmuxTeardownOwnership(
    pane as PsychePane & Record<string, unknown>,
    panes as Array<PsychePane & Record<string, unknown>>,
    currentGeneration,
  );
  const { ownership } = assessment;
  if (ownership === 'stale-generation') {
    // The exact config-CAS that invoked this callback removes only this old
    // record. A reused ID in the new server must never receive a kill command.
    return {
      presence: 'absent' as const,
      pane: { presence: 'absent' as const },
      backgroundPanes: new Map(),
      windows: new Map(),
    };
  }
  if (ownership === 'unverified-generation' || ownership === 'ambiguous') {
    return {
      presence: 'unknown' as const,
      error: ownership === 'ambiguous'
        ? 'tmux resource ownership is ambiguous in the current server generation'
        : 'current tmux server generation could not be verified',
      pane: { presence: 'unknown' as const },
      backgroundPanes: new Map(),
      windows: new Map(),
    };
  }
  if (ownership === 'legacy') {
    // A legacy ID has no tmux generation, so it may name an unrelated pane
    // after a server restart. Only remove the record when every resource is
    // already proven absent; never issue a kill based on that ID alone.
    return verifyFullPaneAbsent({
      target: assessment.target,
      probePane: (paneId) => probeTmuxPanePresence(paneId),
      probeWindow: probeTmuxWindowPresence,
    });
  }
  return tearDownFullPaneWithVerification({
    target: assessment.target,
    probePane: (paneId) => {
      const generation = getCurrentGeneration();
      if (!generation || !currentGeneration) return 'unknown';
      if (!sameTmuxServerIdentity(generation, currentGeneration)) return 'absent';
      return probeTmuxPanePresence(paneId);
    },
    killPane: (paneId) => {
      const generation = getCurrentGeneration();
      if (
        !generation
        || !currentGeneration
        || !sameTmuxServerIdentity(generation, currentGeneration)
      ) {
        return;
      }
      execSync(`tmux kill-pane -t '${paneId}'`, {
        stdio: 'pipe',
        timeout: 5000,
      });
    },
    probeWindow: (windowId) => {
      const generation = getCurrentGeneration();
      if (!generation || !currentGeneration) return 'unknown';
      if (!sameTmuxServerIdentity(generation, currentGeneration)) return 'absent';
      return probeTmuxWindowPresence(windowId);
    },
    killWindow: (windowId) => {
      const generation = getCurrentGeneration();
      if (
        !generation
        || !currentGeneration
        || !sameTmuxServerIdentity(generation, currentGeneration)
      ) {
        return;
      }
      execSync(`tmux kill-window -t '${windowId}'`, {
        stdio: 'pipe',
        timeout: 5000,
      });
    },
  });
}

function paneKeepsWorktreeActive(
  candidate: PsychePane,
  worktreePath: string,
): boolean {
  const legacyCwd = (candidate as unknown as { cwd?: unknown }).cwd;
  return (
    isActiveDevSourcePath(candidate.worktreePath, worktreePath)
    || (
      (
        candidate.type === 'shell'
        || Boolean(candidate.cwdReference)
        || typeof legacyCwd === 'string'
      )
      && paneReferencesWorktree(candidate, worktreePath)
    )
  );
}

/**
 * Close a pane - presents options for how to close
 */
export async function closePane(
  pane: PsychePane,
  context: ActionContext
): Promise<ActionResult> {
  const paneName = getPaneDisplayName(pane);

  // For shell panes (no worktree), close immediately without options
  if (pane.type === 'shell' || !pane.worktreePath) {
    return executeCloseOption(pane, context, 'kill_only');
  }

  const siblingPanesOnWorktree = context.panes.filter(candidate =>
    candidate.id !== pane.id &&
    paneKeepsWorktreeActive(candidate, pane.worktreePath!)
  );

  if (siblingPanesOnWorktree.length > 0) {
    const siblingLabel = siblingPanesOnWorktree.length === 1
      ? '1 other pane'
      : `${siblingPanesOnWorktree.length} other panes`;
    const MAX_LISTED_SIBLINGS = 5;
    const listedSiblings = siblingPanesOnWorktree
      .slice(0, MAX_LISTED_SIBLINGS)
      .map((sibling) => `  - ${getPaneDisplayName(sibling)}`);
    const remainingSiblings = siblingPanesOnWorktree.length - listedSiblings.length;
    const remainingSiblingLine = remainingSiblings > 0
      ? [`  - +${remainingSiblings} more`]
      : [];

    return {
      type: 'choice',
      title: 'Close Pane',
      message: [
        `This worktree is still in use by ${siblingLabel}.`,
        'Other panes on this worktree:',
        ...listedSiblings,
        ...remainingSiblingLine,
      ].join('\n'),
      options: [
        {
          id: 'kill_only',
          label: 'Just close pane',
          description: 'Keep worktree and branch',
          default: true,
        },
      ],
      onSelect: async (optionId: string) => {
        return executeCloseOption(pane, context, optionId);
      },
      dismissable: true,
    };
  }

  // For worktree panes, present options
  const options: ActionOption[] = [
    {
      id: 'kill_only',
      label: 'Just close pane',
      description: 'Keep worktree and branch',
      default: true,
    },
    {
      id: 'kill_and_clean',
      label: 'Close and remove worktree',
      description: 'Delete worktree but keep branch',
      danger: true,
    },
    {
      id: 'kill_clean_branch',
      label: 'Close and delete everything',
      description: 'Remove worktree and delete branch',
      danger: true,
    },
  ];

  return {
    type: 'choice',
    title: 'Close Pane',
    message: `How do you want to close "${paneName}"?`,
    options,
    onSelect: async (optionId: string) => {
      return executeCloseOption(pane, context, optionId);
    },
    dismissable: true,
  };
}

/**
 * Execute the selected close option
 */
async function executeCloseOption(
  pane: PsychePane,
  context: ActionContext,
  option: string
): Promise<ActionResult> {
  const paneName = getPaneDisplayName(pane);
  const lifecycleManager = PaneLifecycleManager.getInstance();
  const stateManager = StateManager.getInstance();
  const state = stateManager.getState();
  const sessionProjectRoot = state.projectRoot || process.cwd();
  const paneProjectRoot = getPaneProjectRoot(pane, sessionProjectRoot);
  const panesFile = state.panesFile || path.join(sessionProjectRoot, '.psyche', 'psyche.config.json');

  try {
    // CRITICAL: Mark pane as closing FIRST to prevent race condition with polling
    // This prevents usePanes from recreating the pane while we're closing it
    await lifecycleManager.beginClose(pane.id, `close action: ${option}`);
    // Also mark by paneId in case polling checks that
    await lifecycleManager.beginClose(pane.paneId, `close action: ${option}`);

    // Trigger before_pane_close hook
    await triggerHook('before_pane_close', paneProjectRoot, pane);

    // CRITICAL: Pause ConfigWatcher to prevent race condition where
    // the watcher reloads the pane list from disk before our save completes
    stateManager.pauseConfigWatcher();

    try {
      let startedBackgroundCleanup = false;

      let updatedPanes = context.panes.filter(p => p.id !== pane.id);

      // The identity check, background-window teardown, pane teardown, and
      // record removal execute under one config lease. A concurrent rebind is
      // therefore detected before this action can kill its replacement.
      if (!context.removePaneIdentitiesFromConfig) {
        throw new Error('Close requires exact pane identity removal support');
      }
      try {
        updatedPanes = await context.removePaneIdentitiesFromConfig(
          [{
            id: pane.id,
            paneId: pane.paneId,
            ...(pane.tmuxServerIdentity
              ? { tmuxServerIdentity: pane.tmuxServerIdentity }
              : {}),
          }],
          async (_panes, exactPanes) => {
            // ProjectPaneConfig always supplies this fresh record. The
            // snapshot fallback preserves legacy ActionContext adapters that
            // predate the second guard argument; production close paths never
            // take it.
            const current = exactPanes?.[0] || pane;
            // The config lease has already revalidated this exact identity.
            // Read its current background pane/window fields here rather than
            // tearing down a stale UI snapshot after a concurrent update.
            const teardown = await tearDownOwnedPane(
              current,
              (_panes || []) as PsychePane[],
              () => (
                context.getTmuxServerIdentity?.()
                ?? getCurrentTmuxServerIdentity()
              ),
            );
            if (teardown.presence !== 'absent') {
              const message = teardown.presence === 'unknown'
                ? `Could not confirm pane "${paneName}" and all owned background windows closed; pane record and worktree were preserved. ${
                  paneRecoveryInstructions(pane.paneId, panesFile)
                }`
                : `Failed to close pane "${paneName}" or an owned background window; worktree cleanup was not started`;
              throw new Error(message);
            }
          },
        );
      } catch (error) {
        await context.refreshPanes?.();
        return {
          type: 'error',
          message: `Close aborted; pane identity or teardown changed. ${
            error instanceof Error ? error.message : String(error)
          }`,
          dismissable: true,
        };
      }

      // Best-effort cleanup of any stored prompt files for this pane slug
      // (including leftovers from interrupted launches).
      try {
        const promptCleanupRoot = pane.worktreePath
          ? (deriveProjectRootFromWorktreePath(pane.worktreePath) || paneProjectRoot)
          : paneProjectRoot;
        await cleanupPromptFilesForSlug(promptCleanupRoot, pane.slug);
      } catch {
        // Ignore prompt cleanup errors
      }

      // Handle worktree cleanup based on option
      if (pane.worktreePath && (option === 'kill_and_clean' || option === 'kill_clean_branch')) {
        // Check if sibling panes still share this worktree
        // updatedPanes already excludes the current pane, so any match = active sibling
        const siblingPanes = updatedPanes.filter((candidate) =>
          paneKeepsWorktreeActive(candidate, pane.worktreePath!)
        );
        if (siblingPanes.length > 0) {
          // Skip worktree/branch deletion — other panes still using it
          LogService.getInstance().info(
            `Skipping worktree cleanup for ${paneName}: ${siblingPanes.length} sibling(s) still using ${pane.worktreePath}`,
            'paneActions',
            pane.id
          );
        } else {
          const mainRepoPath = deriveProjectRootFromWorktreePath(pane.worktreePath) || paneProjectRoot;

          // Trigger before_worktree_remove hook synchronously — the hook may need
          // to read the worktree (e.g. run bundled teardown scripts), and the
          // worktree directory is about to be deleted.
          await triggerHookSync('before_worktree_remove', paneProjectRoot, pane);

          try {
            WorktreeCleanupService.getInstance().enqueueCleanup({
              pane,
              paneProjectRoot,
              mainRepoPath,
              configPath: panesFile,
              currentProjectRoot: sessionProjectRoot,
              deleteBranch: option === 'kill_clean_branch',
            });
            startedBackgroundCleanup = true;
          } catch (cleanupError) {
            LogService.getInstance().warn(
              `Failed to start background cleanup for pane ${pane.id}`,
              'paneActions',
              pane.id
            );
          }
        }
      }

      if (context.onPaneRemove) {
        await context.onPaneRemove(pane.paneId); // Pass tmux pane ID, not psyche ID
      }

      // Recalculate layout for remaining panes
      // CRITICAL FIX: Use validated pane IDs, not just the ones from config
      // The config may have stale IDs if panes were killed between save and layout
      try {
        const config: PsycheConfig = JSON.parse(fs.readFileSync(panesFile, 'utf-8'));
        if (config.controlPaneId && updatedPanes.length > 0) {
          // Verify control pane exists before attempting layout
          const paneListCheck = execSync('tmux list-panes -F "#{pane_id}"', {
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 5000
          });
          const currentPaneIds = paneListCheck.trim().split('\n').filter(Boolean);

          if (!currentPaneIds.includes(config.controlPaneId)) {
            LogService.getInstance().debug(
              `Control pane ${config.controlPaneId} no longer exists, skipping layout recalc`,
              'paneActions'
            );
          } else {
            // Filter to only panes that actually exist in tmux
            const validPaneIds = updatedPanes
              .map(p => p.paneId)
              .filter(id => currentPaneIds.includes(id));

            if (validPaneIds.length > 0) {
              const { recalculateAndApplyLayout } = await import('../../utils/layoutManager.js');
              const { getTerminalDimensions } = await import('../../utils/tmux.js');
              const dimensions = getTerminalDimensions();

              await recalculateAndApplyLayout(
                config.controlPaneId,
                validPaneIds,
                dimensions.width,
                dimensions.height,
                panesFile,
              );

              LogService.getInstance().debug(
                `Recalculated layout after closing pane: ${validPaneIds.length} panes remaining`,
                'paneActions'
              );
            }
          }
        }
      } catch (error) {
        // Log but don't fail - layout recalc is non-critical
        LogService.getInstance().debug('Failed to recalculate layout after pane close', 'paneActions');
      }

      // Trigger pane_closed hook (after everything is cleaned up)
      await triggerHook('pane_closed', paneProjectRoot, pane);

      // If we just closed the last pane, recreate the welcome pane and recalculate layout
      if (updatedPanes.length === 0) {
        const { handleLastPaneRemoved } = await import('../../utils/postPaneCleanup.js');
        await handleLastPaneRemoved(sessionProjectRoot);
      }

      const hasRemainingPaneForWorktree = Boolean(
        pane.worktreePath &&
        updatedPanes.some(candidate =>
          paneKeepsWorktreeActive(candidate, pane.worktreePath!)
        )
      );

      // Dev source fallback:
      // If the pane being closed is the current dev source worktree and no
      // sibling panes remain on that worktree, respawn the control pane from
      // the root checkout.
      if (
        process.env.PSYCHE_DEV === 'true' &&
        pane.worktreePath &&
        isActiveDevSourcePath(pane.worktreePath, process.cwd()) &&
        !hasRemainingPaneForWorktree
      ) {
        try {
          const fallbackCommand = buildDevWatchRespawnCommand(sessionProjectRoot);
          const quotedCommand = `'${fallbackCommand.replace(/'/g, "'\\''")}'`;
          const configForRespawn: PsycheConfig = JSON.parse(fs.readFileSync(panesFile, 'utf-8'));
          const targetControlPaneId = configForRespawn.controlPaneId || execSync(
            'tmux display-message -p "#{pane_id}"',
            { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }
          ).trim();

          if (targetControlPaneId) {
            execSync(
              `tmux respawn-pane -k -t '${targetControlPaneId}' ${quotedCommand}`,
              { stdio: 'pipe', timeout: 5000 }
            );
          }
        } catch (respawnError) {
          LogService.getInstance().warn(
            'Failed to respawn dev source at root after closing source pane',
            'paneActions',
            pane.id
          );
        }
      }

      return {
        type: 'success',
        message: startedBackgroundCleanup
          ? `Pane "${paneName}" closed successfully (cleanup running in background)`
          : `Pane "${paneName}" closed successfully`,
        dismissable: true,
      };
    } finally {
      // CRITICAL: Always resume watcher, even if there was an error
      stateManager.resumeConfigWatcher();

      // Complete the lifecycle close (releases lock)
      // Do this AFTER resume to ensure the config is stable
      await lifecycleManager.completeClose(pane.id);
      await lifecycleManager.completeClose(pane.paneId);
    }
  } catch (error) {
    // Release lifecycle lock on error
    await lifecycleManager.completeClose(pane.id);
    await lifecycleManager.completeClose(pane.paneId);

    return {
      type: 'error',
      message: `Failed to close pane: ${error}`,
      dismissable: true,
    };
  }
}
