/**
 * Conflict Resolution Pane Creation
 *
 * Utilities for creating a new pane specifically for AI-assisted merge conflict resolution
 */

import type { PsychePane } from '../types.js';
import { TmuxService } from '../services/TmuxService.js';
import {
  enforceControlPaneSize,
  ensurePaneBorderStatusForCurrentSession,
  splitPane,
} from './tmux.js';
import { capturePaneContent } from './paneCapture.js';
import { SIDEBAR_WIDTH } from './layoutManager.js';
import { TMUX_LAYOUT_APPLY_DELAY, TMUX_SPLIT_DELAY } from '../constants/timing.js';
import {
  buildPromptReadAndDeleteSnippet,
  deletePromptFile,
  writePromptFile,
} from './promptStore.js';
import { ensureGeminiFolderTrusted } from './geminiTrust.js';
import {
  buildAgentCommand,
  buildInitialPromptCommand,
  getAgentProcessName,
  getPromptTransport,
  getSendKeysPostPasteDelayMs,
  getSendKeysPrePrompt,
  getSendKeysReadyDelayMs,
  getSendKeysSubmit,
  type AgentName,
} from './agentLaunch.js';
import { sendPromptViaTmux } from './agentPromptDispatch.js';
import { resolveProjectColorTheme } from './paneColors.js';
import { createPsychePaneId } from './paneIdentity.js';
import {
  WorktreeCleanupService,
  type WorktreeReuseReservation,
} from '../services/WorktreeCleanupService.js';
import {
  compareAndRemoveProjectPaneConfigPaneIdentities,
  ensureProjectPaneConfigPane,
  projectPaneConfigPath,
} from '../services/ProjectPaneConfig.js';
import {
  paneRecoveryInstructions,
  tearDownPaneWithVerification,
  type TmuxPanePresence,
} from './paneTeardown.js';
import {
  isPaneLifecycleReservationRetainedError,
  PaneLifecycleReservationRetainedError,
  retainPaneRecovery,
  type PaneRecoveryPersistenceResult,
} from './paneLifecycleRecovery.js';

export interface ConflictResolutionPaneOptions {
  sourceBranch: string;      // Branch being merged (the worktree branch)
  targetBranch: string;      // Branch merging into (usually main)
  targetRepoPath: string;    // Path to the target repository (where merge will happen)
  agent: AgentName;
  projectName: string;
  existingPanes: PsychePane[];
  /** The shared pane registry root, not the conflict worktree itself. */
  sessionProjectRoot: string;
  /** Must durably add this exact record before merge/agent commands run. */
  persistConflictPane: (pane: PsychePane) => Promise<void>;
  refreshPanes?: () => Promise<void>;
}

/**
 * Create a pane for resolving merge conflicts with AI assistance
 */
export async function createConflictResolutionPane(
  options: ConflictResolutionPaneOptions
): Promise<PsychePane> {
  const reservation = await WorktreeCleanupService.getInstance()
    .beginWorktreeReuseReservation(
      options.targetRepoPath,
      options.sessionProjectRoot,
    );
  let settled = false;
  try {
    const pane = await createConflictResolutionPaneWithReservation(
      options,
      reservation,
    );
    await reservation.complete();
    settled = true;
    return pane;
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

async function createConflictResolutionPaneWithReservation(
  options: ConflictResolutionPaneOptions,
  reservation: WorktreeReuseReservation,
): Promise<PsychePane> {
  const { sourceBranch, targetBranch, targetRepoPath, agent, projectName, existingPanes } = options;
  const tmuxService = TmuxService.getInstance();
  const { SettingsManager } = await import('./settingsManager.js');
  const settings = new SettingsManager(targetRepoPath).getSettings();

  // Generate slug for this conflict resolution session
  const slug = `merge-${sourceBranch}-into-${targetBranch}`.substring(0, 50);

  // Get current pane info
  const originalPaneId = tmuxService.getCurrentPaneIdSync();

  // Enable pane borders to show titles
  try {
    ensurePaneBorderStatusForCurrentSession();
  } catch {
    // Ignore if already set or fails
  }

  // Create new pane. From this point onward, every fallible operation is
  // guarded by exact persistence or verified teardown/recovery.
  const paneInfo = splitPane();
  const prompt = `There are conflicts merging ${targetBranch} into ${sourceBranch}. Both are valid changes, so please keep both feature sets and merge them intelligently. Check git status to see the conflicting files, then resolve each conflict to preserve both sets of changes. Once all conflicts are resolved, commit the merge.`;
  const tmuxServerIdentity = tmuxService.getServerIdentity?.(paneInfo);
  const newPane: PsychePane = {
    id: createPsychePaneId(),
    slug,
    prompt,
    paneId: paneInfo,
    ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
    projectRoot: targetRepoPath,
    projectName,
    colorTheme: resolveProjectColorTheme(targetRepoPath, []),
    worktreePath: targetRepoPath,
    agent,
  };

  try {
    if (!tmuxServerIdentity) {
      throw new Error(
        `Could not capture tmux server generation for conflict pane ${paneInfo}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!(await tmuxService.paneExists(paneInfo))) {
      throw new Error(`newly split conflict pane ${paneInfo} is not present`);
    }
    await tmuxService.setPaneTitle(paneInfo, slug);
    const controlPaneId = tmuxService.getCurrentPaneIdSync();
    await enforceControlPaneSize(controlPaneId, SIDEBAR_WIDTH);
    await options.persistConflictPane(newPane);
  } catch (error) {
    const teardown = await tearDownConflictPane(tmuxService, paneInfo);
    const recovery = teardown.presence === 'absent'
      ? undefined
      : await retainPaneRecovery({
        projectRoot: options.sessionProjectRoot,
        sessionProjectRoot: options.sessionProjectRoot,
        pane: newPane,
        operation: 'conflict-resolution-pane',
        reason: `post-split setup or persistence failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        reservation,
        persistConfigRecovery: tmuxServerIdentity
          ? () => persistConflictPaneRecovery(
            options.sessionProjectRoot,
            newPane,
          )
          : async () => ({
            durable: false,
            message: 'refused to persist an unversioned conflict pane record',
          }),
      });
    if (recovery?.retained) {
      throw new PaneLifecycleReservationRetainedError(
        `Failed to persist conflict resolution pane before commands: ${
          error instanceof Error ? error.message : String(error)
        }; ${recovery.message}`,
      );
    }
    throw new Error(
      `Failed to persist conflict resolution pane before commands: ${
        error instanceof Error ? error.message : String(error)
      }${recovery ? `; ${recovery.message}` : ''}`,
    );
  }

  try {
    // The durable record exists before the pane touches the worktree or starts
    // a merge. This lets cleanup see it even if the agent command fails.
    await tmuxService.sendShellCommand(paneInfo, `cd "${targetRepoPath}"`);
    await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await tmuxService.sendShellCommand(paneInfo, 'git merge --abort 2>/dev/null || true');
    await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await tmuxService.sendShellCommand(paneInfo, `git merge ${targetBranch} --no-edit || true`);
    await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
    await new Promise((resolve) => setTimeout(resolve, TMUX_LAYOUT_APPLY_DELAY));

    const shouldSendPromptViaTmux = getPromptTransport(agent) === 'send-keys';

    let promptFilePath: string | null = null;
    if (!shouldSendPromptViaTmux) {
      try {
        promptFilePath = await writePromptFile(targetRepoPath, slug, prompt);
      } catch {
        // Fall back to escaped inline flows if prompt file creation fails
      }
    }

    if (agent === 'gemini') {
      ensureGeminiFolderTrusted(targetRepoPath);
    }

    let baselineCommand: string | undefined;
    if (shouldSendPromptViaTmux) {
      try {
        baselineCommand = await tmuxService.getPaneCurrentCommand(paneInfo);
      } catch {
        baselineCommand = undefined;
      }
    }

    let launchCommand: string;
    if (promptFilePath && !shouldSendPromptViaTmux) {
      const promptBootstrap = buildPromptReadAndDeleteSnippet(promptFilePath);
      launchCommand = `${promptBootstrap}; ${buildInitialPromptCommand(
        agent,
        '"$PSYCHE_PROMPT_CONTENT"',
        settings.permissionMode
      )}`;
      promptFilePath = null;
    } else {
      const escapedPrompt = prompt
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');
      launchCommand = buildInitialPromptCommand(
        agent,
        `"${escapedPrompt}"`,
        settings.permissionMode
      );
    }

    if (!launchCommand) {
      launchCommand = buildAgentCommand(agent, settings.permissionMode);
    }

    await tmuxService.sendShellCommand(paneInfo, launchCommand);
    await tmuxService.sendTmuxKeys(paneInfo, 'Enter');

    if (shouldSendPromptViaTmux) {
      await sendPromptViaTmux({
        paneId: paneInfo,
        prompt,
        tmuxService,
        expectedCommand: getAgentProcessName(agent),
        baselineCommand,
        prePromptKeys: getSendKeysPrePrompt(agent),
        submitKeys: getSendKeysSubmit(agent),
        postPasteDelayMs: getSendKeysPostPasteDelayMs(agent),
        readyDelayMs: getSendKeysReadyDelayMs(agent),
      });
    }

    if (agent === 'claude') {
      // Auto-approve trust prompts for Claude (workspace trust, not edit permissions)
      autoApproveTrustPrompt(paneInfo).catch(() => {
        // Ignore errors in background monitoring
      });
    }

    if (promptFilePath) {
      await deletePromptFile(promptFilePath);
    }

    await tmuxService.selectPane(paneInfo);

    await tmuxService.selectPane(originalPaneId);
    try {
      await tmuxService.setPaneTitle(originalPaneId, "psyche");
    } catch {
      // The durable conflict record remains the lifecycle authority.
    }
    return newPane;
  } catch (error) {
    let teardown: Awaited<ReturnType<typeof tearDownConflictPane>> | undefined;
    try {
      await compareAndRemoveProjectPaneConfigPaneIdentities(
        options.sessionProjectRoot,
        [{ id: newPane.id, paneId: newPane.paneId }],
        async () => {
          teardown = await tearDownConflictPane(tmuxService, paneInfo);
          if (!teardown || teardown.presence !== 'absent') {
            throw new Error(
              `could not confirm conflict pane ${paneInfo} is closed (${
                teardown?.presence || 'unknown'
              }); ${
                paneRecoveryInstructions(paneInfo, projectPaneConfigPath(options.sessionProjectRoot))
              }`,
            );
          }
        },
      );
    } catch (cleanupError) {
      await options.refreshPanes?.();
      throw new Error(
        `Conflict resolution command failed: ${
          error instanceof Error ? error.message : String(error)
        }; exact pane cleanup was retained: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
      );
    }
    await options.refreshPanes?.();
    throw error;
  }
}

async function tearDownConflictPane(
  tmuxService: TmuxService,
  paneId: string,
) {
  return tearDownPaneWithVerification({
    probe: () => probeConflictPanePresence(tmuxService, paneId),
    kill: () => tmuxService.killPane(paneId),
  });
}

async function probeConflictPanePresence(
  tmuxService: TmuxService,
  paneId: string,
): Promise<TmuxPanePresence> {
  try {
    return await tmuxService.paneExists(paneId) ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

async function persistConflictPaneRecovery(
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
 * Auto-approve Claude trust prompts (reused from paneCreation.ts)
 */
async function autoApproveTrustPrompt(paneInfo: string): Promise<void> {
  // Wait longer for Claude to start up before checking for prompts
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const maxChecks = 100;
  const checkInterval = 100;
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
      const paneContent = capturePaneContent(paneInfo, 30);

      // Early exit: If Claude is already running (prompt has been processed), we're done
      if (
        paneContent.includes('Claude') ||
        paneContent.includes('Assistant') ||
        paneContent.includes('claude>')
      ) {
        break;
      }

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
          const isNewClaudeFormat =
            /❯\s*1\.\s*Yes,\s*proceed/i.test(paneContent) ||
            /Enter to confirm.*Esc to exit/i.test(paneContent);

          if (isNewClaudeFormat) {
            const tmuxService = TmuxService.getInstance();
            await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
          } else {
            const tmuxService = TmuxService.getInstance();
            await tmuxService.sendTmuxKeys(paneInfo, 'y');
            await new Promise((resolve) => setTimeout(resolve, 50));
            await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
            await new Promise((resolve) => setTimeout(resolve, TMUX_SPLIT_DELAY));
            await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
          }

          promptHandled = true;
          await new Promise((resolve) => setTimeout(resolve, 500));

          const updatedContent = capturePaneContent(paneInfo, 10);

          const promptGone = !trustPromptPatterns.some((p) =>
            p.test(updatedContent)
          );

          if (promptGone) {
            break;
          }
        }
      }
    } catch {
      // Continue checking
    }
  }
}
