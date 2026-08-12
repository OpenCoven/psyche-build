/**
 * MERGE Action - Merge a worktree into the main branch with comprehensive pre-checks
 *
 * This is the simplified orchestrator that delegates to specialized modules.
 * Supports multi-merge: detects sub-worktrees and merges them all sequentially.
 */

import type { PsychePane } from '../../types.js';
import type { ActionResult, ActionContext } from '../types.js';
import { triggerHook } from '../../utils/hooks.js';
import { getPaneBranchName } from '../../utils/git.js';
import { executeMerge } from '../merge/mergeExecution.js';
import {
  handleNothingToMerge,
  handleMainDirty,
  handleWorktreeUncommitted,
  handleMergeConflict,
} from '../merge/issueHandlers/index.js';
import { LogService } from '../../services/LogService.js';
import {
  buildFallbackMergeMessage,
  buildMissingMergeTargetMessage,
  resolveMergeTarget,
  type MergeTargetResolution,
} from '../../utils/mergeTargets.js';
import { getPaneDisplayName } from '../../utils/paneTitle.js';
import { TmuxService } from '../../services/TmuxService.js';
import {
  tearDownFullPaneWithVerification,
  verifyFullPaneAbsent,
} from '../../utils/paneTeardown.js';
import { paneReferencesWorktree } from '../../utils/paneWorktreeReference.js';
import { getCurrentTmuxServerIdentity } from '../../services/TmuxServerIdentity.js';
import { assessTmuxTeardownOwnership } from '../../services/TmuxResourceOwnership.js';

/**
 * Merge a worktree into the main branch with comprehensive pre-checks.
 * Supports multi-merge: if sub-worktrees exist, merges all of them sequentially.
 */
export async function mergePane(
  pane: PsychePane,
  context: ActionContext,
  params?: { mainBranch?: string }
): Promise<ActionResult> {
  const paneName = getPaneDisplayName(pane);
  // 1. Validation
  if (!pane.worktreePath) {
    return {
      type: 'error',
      message: 'This pane has no worktree to merge',
      dismissable: true,
    };
  }

  const mergeTarget = resolveMergeTarget(pane);
  if (!mergeTarget) {
    return {
      type: 'error',
      message: buildMissingMergeTargetMessage(pane),
      dismissable: true,
    };
  }

  // 2. Detect all worktrees (including sub-worktrees created by hooks)
  const { detectAllWorktrees } = await import('../../utils/worktreeDiscovery.js');
  const worktrees = detectAllWorktrees(pane.worktreePath).map((worktree) =>
    worktree.isRoot
      ? {
          ...worktree,
          parentRepoPath: mergeTarget.targetRepoPath,
          mainBranch: mergeTarget.targetBranch,
        }
      : worktree
  );

  console.error(`[mergeAction] Detected ${worktrees.length} worktree(s) in ${pane.worktreePath}`);
  for (const wt of worktrees) {
    console.error(`[mergeAction]   - ${wt.repoName} (${wt.branch}) at ${wt.relativePath} [depth=${wt.depth}, isRoot=${wt.isRoot}]`);
  }

  // 3. Build merge queue (only worktrees with changes)
  const { buildMergeQueue, executeMultiMerge } = await import('../merge/multiMergeOrchestrator.js');
  const queue = await buildMergeQueue(worktrees);

  console.error(`[mergeAction] Merge queue has ${queue.length} item(s)`);

  // 4. Handle based on queue size
  // No changes anywhere
  if (queue.length === 0) {
    return {
      type: 'info',
      message: 'No changes to merge in any repository',
      dismissable: true,
    };
  }

  const continueMerge = async (): Promise<ActionResult> => {
    // Single root worktree = use existing flow (backwards compatible)
    if (queue.length === 1 && queue[0].worktree.isRoot) {
      console.error('[mergeAction] Single root worktree - using existing flow');
      return executeSingleRootMerge(pane, context, params, mergeTarget);
    }

    // Multiple worktrees or only sub-worktrees = use multi-merge flow
    console.error('[mergeAction] Multiple worktrees or sub-worktrees - using multi-merge flow');
    return executeMultiMerge(pane, context, queue);
  };

  if (!mergeTarget.requiresConfirmation) {
    return continueMerge();
  }

  return buildMergeTargetFallbackConfirmation(pane, paneName, mergeTarget, continueMerge);
}

/**
 * Execute single root worktree merge (original flow, backwards compatible)
 */
async function executeSingleRootMerge(
  pane: PsychePane,
  context: ActionContext,
  params: { mainBranch?: string } | undefined,
  mergeTarget: MergeTargetResolution
): Promise<ActionResult> {
  const paneName = getPaneDisplayName(pane);
  const { validateMerge } = await import('../../utils/mergeValidation.js');
  const validation = validateMerge(
    mergeTarget.targetRepoPath,
    pane.worktreePath!,
    getPaneBranchName(pane)
  );

  // Handle detected issues
  if (!validation.canMerge) {
    return handleMergeIssues(pane, context, validation, mergeTarget.targetRepoPath);
  }

  // Check for sibling panes sharing the same worktree
  const siblingPanes = context.panes.filter(
    p => p.id !== pane.id && paneReferencesWorktree(p, pane.worktreePath!)
  );
  let activeContext = context;

  // The exact-record guard runs while the project config lease is held. It
  // fetches each sibling from that fresh registry and tears down every current
  // resource before compareAndRemove removes any record. This prevents a
  // concurrent dev/test claim from being added after a stale UI snapshot was
  // torn down but before record removal.
  const closeSiblings = async (): Promise<ActionResult | undefined> => {
    if (!activeContext.removePaneIdentitiesFromConfig) {
      return {
        type: 'error',
        title: 'Merge Could Not Safely Close Siblings',
        message: 'Merge requires exact pane identity removal support; sibling records and worktree were retained.',
        dismissable: true,
      };
    }
    const tmuxService = TmuxService.getInstance();
    let failedSibling: PsychePane | undefined;
    let failedPresence: 'present' | 'unknown' | undefined;
    let failedDetail: string | undefined;
    let withoutSiblings: PsychePane[];
    try {
      withoutSiblings = await activeContext.removePaneIdentitiesFromConfig(
        siblingPanes.map((sibling) => ({
          id: sibling.id,
          paneId: sibling.paneId,
        })),
        async (freshPanes, exactPanes) => {
          const fresh = (exactPanes || []).map((pane) => pane as PsychePane);
          for (const sibling of siblingPanes) {
            const current = fresh.find((candidate) => (
              candidate.id === sibling.id && candidate.paneId === sibling.paneId
            ));
            if (!current) {
              throw new Error(
                `fresh sibling record "${sibling.id}" is missing or rebound`,
              );
            }

            const assessment = assessTmuxTeardownOwnership(
              current as PsychePane & Record<string, unknown>,
              (freshPanes || []) as Array<PsychePane & Record<string, unknown>>,
              tmuxService.getServerIdentity?.() ?? getCurrentTmuxServerIdentity(),
            );
            const { ownership } = assessment;
            const teardown = ownership === 'legacy'
              ? await verifyFullPaneAbsent({
                target: assessment.target,
                probePane: (paneId) => tmuxService.probePanePresence(paneId),
                probeWindow: (windowId) => tmuxService.probeWindowPresence(windowId),
              })
              : ownership === 'stale-generation'
                ? {
                  presence: 'absent' as const,
                  error: undefined,
                  pane: { presence: 'absent' as const },
                  backgroundPanes: new Map(),
                  windows: new Map(),
                }
                : ownership === 'unverified-generation' || ownership === 'ambiguous'
                  ? {
                    presence: 'unknown' as const,
                    error: undefined,
                    pane: { presence: 'unknown' as const },
                    backgroundPanes: new Map(),
                    windows: new Map(),
                  }
                  : await tearDownFullPaneWithVerification({
                    target: assessment.target,
                    probePane: (paneId) => tmuxService.probePanePresence(paneId),
                    killPane: (paneId) => tmuxService.killPane(paneId),
                    probeWindow: (windowId) => tmuxService.probeWindowPresence(windowId),
                    killWindow: (windowId) => tmuxService.killWindow(windowId),
                  });
            if (teardown.presence !== 'absent') {
              failedSibling = current;
              failedPresence = teardown.presence;
              failedDetail = teardown.error;
              throw new Error(
                `sibling ${current.paneId} is ${teardown.presence} after teardown${
                  teardown.error ? `: ${teardown.error}` : ''
                }`,
              );
            }
          }
        },
      );
    } catch (error) {
      const sibling = failedSibling;
      const detail = failedDetail ? `: ${failedDetail}` : '';
      LogService.getInstance().warn(
        `Aborted merge of ${paneName}: ${
          sibling
            ? `sibling ${sibling.paneId} is ${failedPresence} after teardown${detail}`
            : `sibling identity changed before teardown: ${
              error instanceof Error ? error.message : String(error)
            }`
        }`,
        'mergeAction',
        sibling?.id,
      );
      return {
        type: 'error',
        title: 'Sibling Pane Could Not Be Closed',
        message: sibling
          ? `Merge aborted because sibling "${getPaneDisplayName(sibling)}" is ${failedPresence} after teardown. Its pane record and worktree were retained.`
          : `Merge aborted because sibling ownership changed before its fresh record could be safely torn down. Its pane record and worktree were retained.`,
        dismissable: true,
      };
    }
    activeContext = {
      ...activeContext,
      panes: withoutSiblings,
    };
    LogService.getInstance().info(
      `Closed ${siblingPanes.length} sibling pane(s) for merge of ${paneName}`,
      'mergeAction',
    );
    return undefined;
  };

  // Helper that produces the merge confirmation flow
  const buildMergeConfirmation = async (): Promise<ActionResult> => {
    return {
      type: 'confirm',
      title: 'Merge Worktree',
      message: `Merge "${paneName}" into ${mergeTarget.targetLabel}?`,
      confirmLabel: 'Merge',
      cancelLabel: 'Cancel',
      onConfirm: async () => {
        await triggerHook('pre_merge', mergeTarget.targetRepoPath, pane, {
          PSYCHE_TARGET_BRANCH: validation.mainBranch,
        });
        return executeMerge(
          pane,
          activeContext,
          validation.mainBranch,
          mergeTarget.targetRepoPath
        );
      },
      onCancel: async () => ({
        type: 'info' as const,
        message: 'Merge cancelled',
        dismissable: true,
      }),
    };
  };

  // If siblings exist, show warning first, then proceed with normal merge flow
  if (siblingPanes.length > 0) {
    const siblingNames = siblingPanes.map((s) => getPaneDisplayName(s)).join(', ');
    return {
      type: 'confirm',
      title: 'Sibling Agents Active',
      message: `${siblingPanes.length} other agent(s) (${siblingNames}) are using this worktree. Merging will close them all. Proceed?`,
      confirmLabel: 'Continue',
      cancelLabel: 'Cancel',
      onConfirm: async () => {
        const closeResult = await closeSiblings();
        if (closeResult) {
          return closeResult;
        }
        return buildMergeConfirmation();
      },
      onCancel: async () => ({
        type: 'info' as const,
        message: 'Merge cancelled',
        dismissable: true,
      }),
    };
  }

  // No siblings — proceed with standard merge flow
  return buildMergeConfirmation();
}

function buildMergeTargetFallbackConfirmation(
  pane: PsychePane,
  paneName: string,
  mergeTarget: MergeTargetResolution,
  onConfirm: () => Promise<ActionResult>
): ActionResult {
  return {
    type: 'confirm',
    title: 'Parent Merge Target Unavailable',
    message: buildFallbackMergeMessage(pane, mergeTarget, paneName),
    confirmLabel: 'Continue',
    cancelLabel: 'Cancel',
    onConfirm,
    onCancel: async () => ({
      type: 'info',
      message: 'Merge cancelled',
      dismissable: true,
    }),
  };
}

/**
 * Handle detected merge issues by delegating to specialized handlers
 */
async function handleMergeIssues(
  pane: PsychePane,
  context: ActionContext,
  validation: any,
  mainRepoPath: string
): Promise<ActionResult> {
  const { issues, mainBranch } = validation;

  // Create retry function that re-runs the merge
  const retryMerge = () => mergePane(pane, context, { mainBranch });

  // Find and handle specific issue types
  const nothingToMerge = issues.find((i: any) => i.type === 'nothing_to_merge');
  if (nothingToMerge && issues.length === 1) {
    return handleNothingToMerge();
  }

  const mainDirty = issues.find((i: any) => i.type === 'main_dirty');
  if (mainDirty) {
    return handleMainDirty(mainDirty, mainBranch, mainRepoPath, pane, context, retryMerge);
  }

  const worktreeUncommitted = issues.find((i: any) => i.type === 'worktree_uncommitted');
  if (worktreeUncommitted) {
    return handleWorktreeUncommitted(
      worktreeUncommitted,
      pane,
      context,
      mainBranch,
      retryMerge
    );
  }

  const mergeConflict = issues.find((i: any) => i.type === 'merge_conflict');
  if (mergeConflict) {
    return handleMergeConflict(mergeConflict, mainBranch, mainRepoPath, pane, context);
  }

  // Generic fallback for unknown issues
  return {
    type: 'error',
    title: 'Merge Issues Detected',
    message: issues.map((i: any) => i.message).join('\n'),
    dismissable: true,
  };
}
