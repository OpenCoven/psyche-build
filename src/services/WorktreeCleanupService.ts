import { spawn } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import type { PsychePane } from '../types.js';
import { triggerHook } from '../utils/hooks.js';
import { getPaneBranchName } from '../utils/git.js';
import { detectAllWorktrees } from '../utils/worktreeDiscovery.js';
import { LogService } from './LogService.js';

interface WorktreeCleanupJob {
  pane: PsychePane;
  paneProjectRoot: string;
  mainRepoPath: string;
  deleteBranch: boolean;
}

interface WorktreePruneJob {
  projectRoot: string;
  activePanes: PsychePane[];
  maxManagedWorktrees: number;
}

interface CommandResult {
  success: boolean;
  error?: string;
}

interface BranchDeletionTarget {
  repoPath: string;
  branchName: string;
}

interface WorktreeRemovalTarget {
  repoPath: string;
  worktreePath: string;
  depth: number;
}

interface ManagedWorktreePruneTarget {
  worktreePath: string;
  mtimeMs: number;
}

function normalizePathForCompare(value: string): string {
  return path.resolve(value);
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizePathForCompare(left);
  const normalizedRight = normalizePathForCompare(right);

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}${path.sep}`) ||
    normalizedRight.startsWith(`${normalizedLeft}${path.sep}`)
  );
}

/**
 * Queues worktree deletions in the background so large filesystem cleanup
 * never blocks the main psyche event loop.
 */
export class WorktreeCleanupService {
  private static instance: WorktreeCleanupService;
  private cleanupQueue: Promise<void> = Promise.resolve();
  private logger = LogService.getInstance();

  static getInstance(): WorktreeCleanupService {
    if (!WorktreeCleanupService.instance) {
      WorktreeCleanupService.instance = new WorktreeCleanupService();
    }
    return WorktreeCleanupService.instance;
  }

  enqueueCleanup(job: WorktreeCleanupJob): void {
    if (!job.pane.worktreePath) {
      return;
    }

    this.cleanupQueue = this.cleanupQueue
      .then(() => this.runCleanup(job))
      .catch((error) => {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        this.logger.error(
          `Background worktree cleanup failed for ${job.pane.slug}: ${errorObj.message}`,
          'paneActions',
          job.pane.id,
          errorObj
        );
      });
  }

  enqueuePruneManagedWorktrees(job: WorktreePruneJob): void {
    if (!Number.isInteger(job.maxManagedWorktrees) || job.maxManagedWorktrees < 1) {
      return;
    }

    this.cleanupQueue = this.cleanupQueue
      .then(() => this.runPruneManagedWorktrees(job))
      .catch((error) => {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        this.logger.error(
          `Managed worktree pruning failed for ${job.projectRoot}: ${errorObj.message}`,
          'paneActions',
          undefined,
          errorObj
        );
      });
  }

  private async runCleanup(job: WorktreeCleanupJob): Promise<void> {
    const { pane, paneProjectRoot, mainRepoPath, deleteBranch } = job;
    if (!pane.worktreePath) {
      return;
    }

    const worktreeRemovalTargets = this.getWorktreeRemovalTargets(pane, mainRepoPath);
    const branchDeletionTargets = deleteBranch
      ? this.getBranchDeletionTargets(pane, mainRepoPath)
      : [];

    this.logger.debug(
      `Starting background worktree cleanup for ${pane.slug}`,
      'paneActions',
      pane.id
    );

    for (const target of worktreeRemovalTargets) {
      const removeResult = await this.runGitCommand(
        ['worktree', 'remove', target.worktreePath, '--force'],
        target.repoPath
      );

      if (!removeResult.success) {
        this.logger.warn(
          `Worktree removal reported an error for ${pane.slug} in ${target.repoPath}: ${removeResult.error}`,
          'paneActions',
          pane.id
        );
      }
    }

    // The hook should run after deletion is attempted, regardless of outcome.
    await triggerHook('worktree_removed', paneProjectRoot, pane);

    if (deleteBranch) {
      for (const target of branchDeletionTargets) {
        const branchExists = await this.runGitCommand(
          ['show-ref', '--verify', '--quiet', `refs/heads/${target.branchName}`],
          target.repoPath
        );
        if (!branchExists.success) {
          continue;
        }

        const deleteBranchResult = await this.runGitCommand(
          ['branch', '-D', target.branchName],
          target.repoPath
        );

        if (!deleteBranchResult.success) {
          this.logger.warn(
            `Branch deletion reported an error for ${pane.slug} in ${target.repoPath}: ${deleteBranchResult.error}`,
            'paneActions',
            pane.id
          );
        }
      }
    }

    this.logger.debug(
      `Finished background worktree cleanup for ${pane.slug}`,
      'paneActions',
      pane.id
    );
  }

  private getBranchDeletionTargets(
    pane: PsychePane,
    mainRepoPath: string
  ): BranchDeletionTarget[] {
    const branchName = getPaneBranchName(pane);
    const repoPaths = new Set<string>([mainRepoPath]);

    if (pane.worktreePath) {
      try {
        for (const worktree of detectAllWorktrees(pane.worktreePath)) {
          repoPaths.add(worktree.parentRepoPath);
        }
      } catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        this.logger.debug(
          `Failed to detect nested worktrees for ${pane.slug}: ${errorObj.message}`,
          'paneActions',
          pane.id
        );
      }
    }

    return Array.from(repoPaths).map((repoPath) => ({
      repoPath,
      branchName,
    }));
  }

  private getWorktreeRemovalTargets(
    pane: PsychePane,
    mainRepoPath: string
  ): WorktreeRemovalTarget[] {
    if (!pane.worktreePath) {
      return [];
    }

    const targets = new Map<string, WorktreeRemovalTarget>();
    const addTarget = (repoPath: string, worktreePath: string, depth: number) => {
      targets.set(`${repoPath}::${worktreePath}`, {
        repoPath,
        worktreePath,
        depth,
      });
    };

    // Fall back to the pane root even if nested worktree detection fails.
    addTarget(mainRepoPath, pane.worktreePath, 0);

    try {
      for (const worktree of detectAllWorktrees(pane.worktreePath)) {
        addTarget(worktree.parentRepoPath, worktree.worktreePath, worktree.depth);
      }
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      this.logger.debug(
        `Failed to detect worktree removal targets for ${pane.slug}: ${errorObj.message}`,
        'paneActions',
        pane.id
      );
    }

    return Array.from(targets.values()).sort((left, right) => {
      if (left.depth !== right.depth) {
        return right.depth - left.depth;
      }

      return right.worktreePath.length - left.worktreePath.length;
    });
  }

  private async runPruneManagedWorktrees(job: WorktreePruneJob): Promise<void> {
    const targets = this.getManagedWorktreePruneTargets(job);

    if (targets.length === 0) {
      return;
    }

    this.logger.debug(
      `Pruning ${targets.length} old managed worktree${targets.length === 1 ? '' : 's'} for ${job.projectRoot}`,
      'paneActions'
    );

    for (const target of targets) {
      const removeResult = await this.runGitCommand(
        ['worktree', 'remove', target.worktreePath],
        job.projectRoot
      );

      if (!removeResult.success) {
        this.logger.warn(
          `Managed worktree pruning skipped ${target.worktreePath}: ${removeResult.error}`,
          'paneActions'
        );
      }
    }
  }

  private getManagedWorktreePruneTargets(job: WorktreePruneJob): ManagedWorktreePruneTarget[] {
    if (!Number.isInteger(job.maxManagedWorktrees) || job.maxManagedWorktrees < 1) {
      return [];
    }

    const managedRoot = path.join(job.projectRoot, '.psyche', 'worktrees');
    if (!existsSync(managedRoot)) {
      return [];
    }

    const activeWorktreePaths = job.activePanes
      .map((pane) => pane.worktreePath)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);

    const managedWorktrees: ManagedWorktreePruneTarget[] = [];

    for (const entry of readdirSync(managedRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const worktreePath = path.join(managedRoot, entry.name);
      const stats = statSync(worktreePath);
      managedWorktrees.push({
        worktreePath,
        mtimeMs: stats.mtimeMs,
      });
    }

    if (managedWorktrees.length <= job.maxManagedWorktrees) {
      return [];
    }

    const activeManagedCount = managedWorktrees.filter((worktree) =>
      activeWorktreePaths.some((activePath) => pathsOverlap(worktree.worktreePath, activePath))
    ).length;

    if (activeManagedCount >= job.maxManagedWorktrees) {
      return [];
    }

    const pruneCount = managedWorktrees.length - job.maxManagedWorktrees;

    return managedWorktrees
      .filter((worktree) =>
        !activeWorktreePaths.some((activePath) => pathsOverlap(worktree.worktreePath, activePath))
      )
      .sort((left, right) => {
        if (left.mtimeMs !== right.mtimeMs) {
          return left.mtimeMs - right.mtimeMs;
        }

        return left.worktreePath.localeCompare(right.worktreePath);
      })
      .slice(0, pruneCount);
  }

  private runGitCommand(args: string[], cwd: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let stderr = '';

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('error', (error: Error) => {
        resolve({
          success: false,
          error: error.message,
        });
      });

      child.on('close', (code: number | null) => {
        if (code === 0) {
          resolve({ success: true });
          return;
        }

        resolve({
          success: false,
          error:
            stderr.trim() ||
            `git ${args.join(' ')} failed with exit code ${code ?? 'unknown'}`,
        });
      });
    });
  }
}
