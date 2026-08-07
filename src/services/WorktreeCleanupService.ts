import { execFileSync, spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import type { PsycheConfig, PsychePane } from '../types.js';
import { triggerHook } from '../utils/hooks.js';
import { getPaneBranchName } from '../utils/git.js';
import { detectAllWorktrees } from '../utils/worktreeDiscovery.js';
import { LogService } from './LogService.js';

export interface WorktreeCleanupJob {
  pane: PsychePane;
  paneProjectRoot: string;
  mainRepoPath: string;
  configPath: string;
  currentProjectRoot: string;
  deleteBranch: boolean;
}

export interface CreatedWorktreeRollbackJob {
  worktreePath: string;
  branchName: string;
  branchOid: string;
  mainRepoPath: string;
  deleteBranch: boolean;
}

export interface WorktreeRollbackResult {
  success: boolean;
  error?: string;
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

interface GitTextResult extends CommandResult {
  output?: string;
}

interface WorktreeIdentity {
  repoPath: string;
  worktreePath: string;
  canonicalWorktreePath: string;
  branchName: string;
  branchOid: string;
}

interface QueuedWorktreeCleanupJob {
  pane: PsychePane;
  paneProjectRoot: string;
  canonicalWorktreePath: string;
  branchName: string;
  branchOid: string;
  configPath: string;
  currentProjectRoot: string;
  generation: number;
  deleteBranch: boolean;
  worktreeTargets: WorktreeIdentity[];
  branchTargets: Array<Pick<WorktreeIdentity, 'repoPath' | 'branchName' | 'branchOid'>>;
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
  private cleanupGenerations = new Map<string, number>();
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

    const canonicalWorktreePath = normalizePathForCompare(job.pane.worktreePath);
    const generation = this.incrementCleanupGeneration(canonicalWorktreePath);
    const queuedJob = this.captureCleanupJob(job, canonicalWorktreePath, generation);
    if (!queuedJob) {
      return;
    }

    this.cleanupQueue = this.cleanupQueue
      .then(() => this.runCleanup(queuedJob))
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

  cancelCleanupForWorktree(worktreePath: string): void {
    const canonicalWorktreePath = normalizePathForCompare(worktreePath);
    const generation = this.incrementCleanupGeneration(canonicalWorktreePath);
    this.logger.debug(
      `Canceled stale cleanup generation for ${canonicalWorktreePath} (generation ${generation})`,
      'paneActions'
    );
  }

  rollbackCreatedWorktree(job: CreatedWorktreeRollbackJob): WorktreeRollbackResult {
    const canonicalWorktreePath = normalizePathForCompare(job.worktreePath);
    const identity: WorktreeIdentity = {
      repoPath: job.mainRepoPath,
      worktreePath: job.worktreePath,
      canonicalWorktreePath,
      branchName: job.branchName,
      branchOid: job.branchOid,
    };

    const mappedBranch = this.getWorktreeBranch(identity.repoPath, identity.canonicalWorktreePath);
    if (!mappedBranch.success) {
      return {
        success: false,
        error: `could not verify newly created worktree identity: ${mappedBranch.error}`,
      };
    }
    if (!mappedBranch.found || mappedBranch.branchName !== identity.branchName) {
      return {
        success: false,
        error: `newly created worktree identity changed before rollback (expected ${identity.branchName}, found ${mappedBranch.branchName || 'no branch'})`,
      };
    }

    const currentOid = this.getBranchOid(identity.repoPath, identity.branchName);
    if (!currentOid.success || currentOid.output !== identity.branchOid) {
      return {
        success: false,
        error: `newly created branch identity changed before rollback`,
      };
    }

    const removeResult = this.runGitTextSync(
      ['worktree', 'remove', identity.worktreePath, '--force'],
      identity.repoPath
    );
    if (!removeResult.success) {
      return {
        success: false,
        error: `failed to remove newly created worktree: ${removeResult.error}`,
      };
    }

    const afterRemoval = this.getWorktreeBranch(identity.repoPath, identity.canonicalWorktreePath);
    if (!afterRemoval.success || afterRemoval.found) {
      return {
        success: false,
        error: afterRemoval.success
          ? 'newly created worktree removal could not be confirmed'
          : `could not confirm newly created worktree removal: ${afterRemoval.error}`,
      };
    }

    if (!job.deleteBranch) {
      return { success: true };
    }

    const branchOidBeforeDelete = this.getBranchOid(identity.repoPath, identity.branchName);
    if (!branchOidBeforeDelete.success || branchOidBeforeDelete.output !== identity.branchOid) {
      return {
        success: false,
        error: 'newly created branch identity changed before rollback deletion',
      };
    }

    const deleteResult = this.runGitTextSync(
      ['branch', '-D', identity.branchName],
      identity.repoPath
    );
    if (!deleteResult.success) {
      return {
        success: false,
        error: `failed to delete newly created branch: ${deleteResult.error}`,
      };
    }

    return { success: true };
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

  private async runCleanup(job: QueuedWorktreeCleanupJob): Promise<void> {
    this.logger.debug(
      `Starting background worktree cleanup for ${job.pane.slug}`,
      'paneActions',
      job.pane.id
    );

    let allWorktreesRemoved = true;
    for (const target of job.worktreeTargets) {
      if (!this.canRunDestructiveCleanup(job, target)) {
        allWorktreesRemoved = false;
        continue;
      }

      const removeResult = await this.runGitCommand(
        ['worktree', 'remove', target.worktreePath, '--force'],
        target.repoPath
      );

      if (!removeResult.success) {
        this.logger.warn(
          `Worktree removal reported an error for ${job.pane.slug} in ${target.repoPath}: ${removeResult.error}`,
          'paneActions',
          job.pane.id
        );
        allWorktreesRemoved = false;
        continue;
      }

      const afterRemoval = this.getWorktreeBranch(
        target.repoPath,
        target.canonicalWorktreePath
      );
      if (!afterRemoval.success || afterRemoval.found) {
        this.logger.warn(
          afterRemoval.success
            ? `Skipping branch deletion for ${job.pane.slug}: worktree removal was not confirmed for ${target.canonicalWorktreePath}`
            : `Skipping branch deletion for ${job.pane.slug}: could not confirm worktree removal for ${target.canonicalWorktreePath}: ${afterRemoval.error}`,
          'paneActions',
          job.pane.id
        );
        allWorktreesRemoved = false;
      }
    }

    // The hook should run after deletion is attempted, regardless of outcome.
    await triggerHook('worktree_removed', job.paneProjectRoot, job.pane);

    if (job.deleteBranch && allWorktreesRemoved) {
      for (const target of job.branchTargets) {
        if (!this.canRunDestructiveCleanup(job)) {
          continue;
        }

        if (!this.areAllWorktreesRemoved(job)) {
          this.logger.warn(
            `Skipping branch deletion for ${job.pane.slug}: worktree removal is no longer confirmed`,
            'paneActions',
            job.pane.id
          );
          break;
        }

        const currentOid = this.getBranchOid(target.repoPath, target.branchName);
        if (!currentOid.success || currentOid.output !== target.branchOid) {
          this.logger.warn(
            `Skipping branch deletion for ${job.pane.slug}: branch OID changed for ${target.branchName} in ${target.repoPath}`,
            'paneActions',
            job.pane.id
          );
          continue;
        }

        const deleteBranchResult = await this.runGitCommand(
          ['branch', '-D', target.branchName],
          target.repoPath
        );
        if (!deleteBranchResult.success) {
          this.logger.warn(
            `Branch deletion reported an error for ${job.pane.slug} in ${target.repoPath}: ${deleteBranchResult.error}`,
            'paneActions',
            job.pane.id
          );
        }
      }
    }

    this.logger.debug(
      `Finished background worktree cleanup for ${job.pane.slug}`,
      'paneActions',
      job.pane.id
    );
  }

  private incrementCleanupGeneration(canonicalWorktreePath: string): number {
    const generation = (this.cleanupGenerations.get(canonicalWorktreePath) || 0) + 1;
    this.cleanupGenerations.set(canonicalWorktreePath, generation);
    return generation;
  }

  private captureCleanupJob(
    job: WorktreeCleanupJob,
    canonicalWorktreePath: string,
    generation: number
  ): QueuedWorktreeCleanupJob | null {
    if (!job.pane.worktreePath) {
      return null;
    }
    if (!job.configPath || !job.currentProjectRoot) {
      this.logger.warn(
        `Skipping background worktree cleanup for ${job.pane.slug}: missing config or project identity`,
        'paneActions',
        job.pane.id
      );
      return null;
    }

    const branchName = getPaneBranchName(job.pane);
    const worktreeTargets = this.getWorktreeRemovalTargets(job.pane, job.mainRepoPath);
    const identities: WorktreeIdentity[] = [];

    for (const target of worktreeTargets) {
      const canonicalTargetPath = normalizePathForCompare(target.worktreePath);
      const mappedBranch = this.getWorktreeBranch(target.repoPath, canonicalTargetPath);
      if (!mappedBranch.success || !mappedBranch.found || mappedBranch.branchName !== branchName) {
        this.logger.warn(
          mappedBranch.success
            ? `Skipping background worktree cleanup for ${job.pane.slug}: ${canonicalTargetPath} maps to ${mappedBranch.branchName || 'no branch'} instead of ${branchName}`
            : `Skipping background worktree cleanup for ${job.pane.slug}: could not verify ${canonicalTargetPath}: ${mappedBranch.error}`,
          'paneActions',
          job.pane.id
        );
        return null;
      }

      const branchOid = this.getBranchOid(target.repoPath, branchName);
      if (!branchOid.success || !branchOid.output) {
        this.logger.warn(
          `Skipping background worktree cleanup for ${job.pane.slug}: could not record branch OID for ${branchName} in ${target.repoPath}`,
          'paneActions',
          job.pane.id
        );
        return null;
      }

      identities.push({
        repoPath: target.repoPath,
        worktreePath: target.worktreePath,
        canonicalWorktreePath: canonicalTargetPath,
        branchName,
        branchOid: branchOid.output,
      });
    }

    const rootIdentity = identities.find(
      (identity) => identity.canonicalWorktreePath === canonicalWorktreePath
    );
    if (!rootIdentity) {
      this.logger.warn(
        `Skipping background worktree cleanup for ${job.pane.slug}: queued worktree identity was not found`,
        'paneActions',
        job.pane.id
      );
      return null;
    }

    return {
      pane: job.pane,
      paneProjectRoot: job.paneProjectRoot,
      canonicalWorktreePath,
      branchName,
      branchOid: rootIdentity.branchOid,
      configPath: job.configPath,
      currentProjectRoot: normalizePathForCompare(job.currentProjectRoot),
      generation,
      deleteBranch: job.deleteBranch,
      worktreeTargets: identities,
      branchTargets: job.deleteBranch
        ? identities.map(({ repoPath, branchName: targetBranchName, branchOid }) => ({
          repoPath,
          branchName: targetBranchName,
          branchOid,
        }))
        : [],
    };
  }

  private canRunDestructiveCleanup(
    job: QueuedWorktreeCleanupJob,
    target?: WorktreeIdentity
  ): boolean {
    if (this.cleanupGenerations.get(job.canonicalWorktreePath) !== job.generation) {
      this.logger.warn(
        `Skipping background worktree cleanup for ${job.pane.slug}: cleanup was canceled or superseded`,
        'paneActions',
        job.pane.id
      );
      return false;
    }

    if (!this.configAllowsCleanup(job)) {
      return false;
    }

    if (!target) {
      return true;
    }

    const mappedBranch = this.getWorktreeBranch(target.repoPath, target.canonicalWorktreePath);
    if (!mappedBranch.success || !mappedBranch.found || mappedBranch.branchName !== target.branchName) {
      this.logger.warn(
        mappedBranch.success
          ? `Skipping worktree removal for ${job.pane.slug}: ${target.canonicalWorktreePath} no longer maps to ${target.branchName}`
          : `Skipping worktree removal for ${job.pane.slug}: could not verify ${target.canonicalWorktreePath}: ${mappedBranch.error}`,
        'paneActions',
        job.pane.id
      );
      return false;
    }

    return true;
  }

  private configAllowsCleanup(job: QueuedWorktreeCleanupJob): boolean {
    let config: PsycheConfig;
    try {
      config = JSON.parse(readFileSync(job.configPath, 'utf-8')) as PsycheConfig;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Skipping background worktree cleanup for ${job.pane.slug}: could not read current config ${job.configPath}: ${errorMessage}`,
        'paneActions',
        job.pane.id
      );
      return false;
    }

    if (config.projectRoot && normalizePathForCompare(config.projectRoot) !== job.currentProjectRoot) {
      this.logger.warn(
        `Skipping background worktree cleanup for ${job.pane.slug}: current config project identity changed`,
        'paneActions',
        job.pane.id
      );
      return false;
    }

    if (!Array.isArray(config.panes)) {
      this.logger.warn(
        `Skipping background worktree cleanup for ${job.pane.slug}: current config has no pane list`,
        'paneActions',
        job.pane.id
      );
      return false;
    }

    if (config.panes.some((pane) => (
      typeof pane.worktreePath === 'string'
      && normalizePathForCompare(pane.worktreePath) === job.canonicalWorktreePath
    ))) {
      this.logger.warn(
        `Skipping background worktree cleanup for ${job.pane.slug}: current config still references ${job.canonicalWorktreePath}`,
        'paneActions',
        job.pane.id
      );
      return false;
    }

    return true;
  }

  private areAllWorktreesRemoved(job: QueuedWorktreeCleanupJob): boolean {
    for (const target of job.worktreeTargets) {
      const mappedBranch = this.getWorktreeBranch(target.repoPath, target.canonicalWorktreePath);
      if (!mappedBranch.success || mappedBranch.found) {
        return false;
      }
    }
    return true;
  }

  private getWorktreeBranch(
    repoPath: string,
    canonicalWorktreePath: string
  ): { success: boolean; found?: boolean; branchName?: string; error?: string } {
    const result = this.runGitTextSync(['worktree', 'list', '--porcelain'], repoPath);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    let currentWorktreePath: string | undefined;
    let found = false;
    for (const line of (result.output || '').split('\n')) {
      if (line.startsWith('worktree ')) {
        currentWorktreePath = normalizePathForCompare(line.slice('worktree '.length).trim());
        found ||= currentWorktreePath === canonicalWorktreePath;
        continue;
      }
      if (
        currentWorktreePath === canonicalWorktreePath
        && line.startsWith('branch refs/heads/')
      ) {
        return {
          success: true,
          found: true,
          branchName: line.slice('branch refs/heads/'.length),
        };
      }
      if (!line) {
        currentWorktreePath = undefined;
      }
    }

    return { success: true, found };
  }

  private getBranchOid(repoPath: string, branchName: string): GitTextResult {
    return this.runGitTextSync(
      ['rev-parse', '--verify', `refs/heads/${branchName}`],
      repoPath
    );
  }

  private runGitTextSync(args: string[], cwd: string): GitTextResult {
    try {
      const output = execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return {
        success: true,
        output: output.trim(),
      };
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const stderr = (error as { stderr?: Buffer | string }).stderr;
      return {
        success: false,
        error: typeof stderr === 'string'
          ? stderr.trim()
          : Buffer.isBuffer(stderr)
            ? stderr.toString().trim()
            : errorObj.message,
      };
    }
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
