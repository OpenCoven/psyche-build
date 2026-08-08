import { execSync } from 'child_process';
import fs from 'fs/promises';
import { useCallback } from 'react';
import type { PsychePane } from '../types.js';
import { TmuxService } from '../services/TmuxService.js';
import { enforceControlPaneSize } from '../utils/tmux.js';
import { SIDEBAR_WIDTH } from '../utils/layoutManager.js';
import { getCurrentBranch, getPaneBranchName } from '../utils/git.js';
import { cleanupPromptFilesForSlug } from '../utils/promptStore.js';
import { deriveProjectRootFromWorktreePath } from '../utils/paneProject.js';
import { useTemporaryStatus } from './useTemporaryStatus.js';
import {
  describeLiveTmuxWorktreeGuard,
  inspectLiveTmuxWorktreeConsumers,
} from '../services/LiveTmuxWorktreeGuard.js';
import {
  tearDownFullPaneWithVerification,
  verifyFullPaneAbsent,
} from '../utils/paneTeardown.js';
import { getCurrentTmuxServerIdentity } from '../services/TmuxServerIdentity.js';
import { assessTmuxTeardownOwnership } from '../services/TmuxResourceOwnership.js';

interface Params {
  panes: PsychePane[];
  removePaneFromConfig: (paneId: string) => Promise<PsychePane[]>;
  setStatusMessage: (msg: string) => void;
  setShowMergeConfirmation: (v: boolean) => void;
  setMergedPane: (pane: PsychePane | null) => void;
}

export default function useWorktreeActions({
  panes,
  removePaneFromConfig,
  setStatusMessage,
  setShowMergeConfirmation,
  setMergedPane,
}: Params) {
  const showTemporary = useTemporaryStatus(setStatusMessage);

  const assertNoLiveTmuxWorktreeConsumer = (worktreePath: string) => {
    const guard = inspectLiveTmuxWorktreeConsumers(worktreePath);
    if (guard.state !== 'safe') {
      throw new Error(
        `Refusing worktree removal while ${describeLiveTmuxWorktreeGuard(guard)}`,
      );
    }
  };

  const closePane = useCallback(async (pane: PsychePane) => {
    try {
      const tmuxService = TmuxService.getInstance();
      const ownership = assessTmuxTeardownOwnership(
        pane as PsychePane & Record<string, unknown>,
        panes as Array<PsychePane & Record<string, unknown>>,
        tmuxService.getServerIdentity?.() ?? getCurrentTmuxServerIdentity(),
      );
      const teardown = ownership === 'legacy'
        ? await verifyFullPaneAbsent({
          target: pane,
          probePane: (paneId) => tmuxService.probePanePresence(paneId),
          probeWindow: (windowId) => tmuxService.probeWindowPresence(windowId),
        })
        : ownership === 'stale-generation'
          ? {
            presence: 'absent' as const,
            pane: { presence: 'absent' as const },
            backgroundPanes: new Map(),
            windows: new Map(),
          }
          : ownership === 'unverified-generation' || ownership === 'ambiguous'
            ? {
              presence: 'unknown' as const,
              pane: { presence: 'unknown' as const },
              backgroundPanes: new Map(),
              windows: new Map(),
            }
            : await tearDownFullPaneWithVerification({
        target: pane,
        probePane: (paneId) => tmuxService.probePanePresence(paneId),
        killPane: (paneId) => tmuxService.killPane(paneId),
        probeWindow: (windowId) => tmuxService.probeWindowPresence(windowId),
        killWindow: (windowId) => tmuxService.killWindow(windowId),
            });
      if (teardown.presence !== 'absent') {
        throw new Error(`Could not confirm pane teardown (${teardown.presence})`);
      }
      // Don't apply global layouts - just enforce sidebar width
      try {
        const controlPaneId = await tmuxService.getCurrentPaneId();
        enforceControlPaneSize(controlPaneId, SIDEBAR_WIDTH);
      } catch {}

      await removePaneFromConfig(pane.id);

      showTemporary(`Closed pane: ${pane.slug}`);
    } catch {
      showTemporary('Failed to close pane', 2000);
    }
  }, [panes, removePaneFromConfig, showTemporary]);

  const mergeWorktree = useCallback(async (pane: PsychePane) => {
    if (!pane.worktreePath) {
      setStatusMessage('No worktree to merge');
      setTimeout(() => setStatusMessage(''), 2000);
      return;
    }

    try {
      setStatusMessage('Checking worktree status...');
      const mainBranch = getCurrentBranch();
      const statusOutput = execSync(`git -C "${pane.worktreePath}" status --porcelain`, { encoding: 'utf-8' });

      if (statusOutput.trim()) {
        setStatusMessage('Staging changes...');
        execSync(`git -C "${pane.worktreePath}" add -A`, { stdio: 'pipe' });
        setStatusMessage('Committing changes...');
        // Use generic message to avoid bringing in LLM here
        execSync(`git -C "${pane.worktreePath}" commit -m 'chore: worktree changes'`, { stdio: 'pipe' });
      }

      setStatusMessage('Merging into main...');
      try {
        execSync(`git merge "${getPaneBranchName(pane)}"`, { stdio: 'pipe' });
      } catch (mergeError: any) {
        const errorMessage = mergeError.message || String(mergeError);
        if (errorMessage.includes('CONFLICT') || errorMessage.includes('conflict')) {
          process.stderr.write('\n\x1b[31m✗ Merge conflict detected!\x1b[0m\n');
          process.stderr.write(`\nThere are merge conflicts when merging branch '${getPaneBranchName(pane)}' into '${mainBranch}'.\n`);
          process.stderr.write('\nTo resolve:\n');
          process.stderr.write('1. Manually resolve the merge conflicts in your editor\n');
          process.stderr.write('2. Stage the resolved files: git add <resolved-files>\n');
          process.stderr.write('3. Complete the merge: git commit\n');
          process.stderr.write('4. Run psyche again to continue managing your panes\n');
          process.stderr.write('\nExiting psyche now...\n\n');
          process.stdout.write('\x1b[2J\x1b[H');
          process.stdout.write('\x1b[3J');
          try {
            const tmuxService = TmuxService.getInstance();
            tmuxService.clearHistorySync();
          } catch {}
          process.exit(1);
        }
        // Don't remove worktree on merge failure
        throw mergeError;
      }

      // Only remove worktree if merge succeeded
      assertNoLiveTmuxWorktreeConsumer(pane.worktreePath);
      execSync(`git worktree remove "${pane.worktreePath}"`, { stdio: 'pipe' });
      const mainRepoPath = deriveProjectRootFromWorktreePath(pane.worktreePath) || process.cwd();
      await cleanupPromptFilesForSlug(mainRepoPath, pane.slug);
      execSync(`git branch -d "${getPaneBranchName(pane)}"`, { stdio: 'pipe' });

      setStatusMessage(`Merged ${pane.slug} into ${mainBranch}`);
      setTimeout(() => setStatusMessage(''), 3000);
      setMergedPane(pane);
      setShowMergeConfirmation(true);
    } catch {
      setStatusMessage('Failed to merge - check git status');
      setTimeout(() => setStatusMessage(''), 3000);
    }
  }, [setStatusMessage, setMergedPane, setShowMergeConfirmation]);

  const mergeAndPrune = useCallback(async (pane: PsychePane) => {
    if (!pane.worktreePath) {
      setStatusMessage('No worktree to merge');
      setTimeout(() => setStatusMessage(''), 2000);
      return;
    }

    try {
      setStatusMessage('Checking worktree status...');
      const mainBranch = getCurrentBranch();
      const statusOutput = execSync(`git -C "${pane.worktreePath}" status --porcelain`, { encoding: 'utf-8' });

      if (statusOutput.trim()) {
        setStatusMessage('Staging changes...');
        execSync(`git -C "${pane.worktreePath}" add -A`, { stdio: 'pipe' });
        setStatusMessage('Committing changes...');
        execSync(`git -C "${pane.worktreePath}" commit -m 'chore: worktree changes'`, { stdio: 'pipe' });
      }

      setStatusMessage('Merging into main...');
      try {
        execSync(`git merge "${getPaneBranchName(pane)}"`, { stdio: 'pipe' });
      } catch (mergeError: any) {
        const errorMessage = mergeError.message || String(mergeError);
        if (errorMessage.includes('CONFLICT') || errorMessage.includes('conflict')) {
          process.stderr.write('\n\x1b[31m✗ Merge conflict detected!\x1b[0m\n');
          process.stderr.write(`\nThere are merge conflicts when merging branch '${getPaneBranchName(pane)}' into '${mainBranch}'.\n`);
          process.stderr.write('\nTo resolve:\n');
          process.stderr.write('1. Manually resolve the merge conflicts in your editor\n');
          process.stderr.write('2. Stage the resolved files: git add <resolved-files>\n');
          process.stderr.write('3. Complete the merge: git commit\n');
          process.stderr.write('4. Run psyche again to continue managing your panes\n');
          process.stderr.write('\nExiting psyche now...\n\n');
          process.stdout.write('\x1b[2J\x1b[H');
          process.stdout.write('\x1b[3J');
          try {
            const tmuxService = TmuxService.getInstance();
            tmuxService.clearHistorySync();
          } catch {}
          process.exit(1);
        }
        // Don't remove worktree on merge failure
        throw mergeError;
      }

      // Only remove worktree if merge succeeded
      assertNoLiveTmuxWorktreeConsumer(pane.worktreePath);
      execSync(`git worktree remove "${pane.worktreePath}"`, { stdio: 'pipe' });
      const mainRepoPath = deriveProjectRootFromWorktreePath(pane.worktreePath) || process.cwd();
      await cleanupPromptFilesForSlug(mainRepoPath, pane.slug);
      execSync(`git branch -d "${getPaneBranchName(pane)}"`, { stdio: 'pipe' });
      await closePane(pane);
      setStatusMessage(`Merged ${pane.slug} into ${mainBranch} and closed pane`);
      setTimeout(() => setStatusMessage(''), 3000);
    } catch {
      setStatusMessage('Failed to merge - check git status');
      setTimeout(() => setStatusMessage(''), 3000);
    }
  }, [closePane, setStatusMessage]);

  const deleteUnsavedChanges = useCallback(async (pane: PsychePane) => {
    if (!pane.worktreePath) {
      await closePane(pane);
      return;
    }

    try {
      setStatusMessage('Removing worktree with unsaved changes...');
      assertNoLiveTmuxWorktreeConsumer(pane.worktreePath);
      execSync(`git worktree remove --force "${pane.worktreePath}"`, { stdio: 'pipe' });
      const mainRepoPath = deriveProjectRootFromWorktreePath(pane.worktreePath) || process.cwd();
      await cleanupPromptFilesForSlug(mainRepoPath, pane.slug);
      try { execSync(`git branch -D "${getPaneBranchName(pane)}"`, { stdio: 'pipe' }); } catch {}
      await closePane(pane);
      setStatusMessage(`Deleted worktree ${pane.slug} and closed pane`);
      setTimeout(() => setStatusMessage(''), 3000);
    } catch {
      setStatusMessage('Failed to delete worktree');
      setTimeout(() => setStatusMessage(''), 3000);
    }
  }, [closePane, setStatusMessage]);

  const handleCloseOption = useCallback(async (option: number, pane: PsychePane) => {
    switch (option) {
      case 0:
        await mergeAndPrune(pane);
        break;
      case 1:
        await mergeWorktree(pane);
        break;
      case 2:
        await deleteUnsavedChanges(pane);
        break;
      case 3:
        await closePane(pane);
        break;
    }
  }, [mergeAndPrune, mergeWorktree, deleteUnsavedChanges, closePane]);

  return { closePane, mergeWorktree, mergeAndPrune, deleteUnsavedChanges, handleCloseOption } as const;
}
