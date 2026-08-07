import { execFileSync, spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
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
  configPath?: string;
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
  canonicalWorktreePath: string;
  branchName: string;
  branchOid: string;
}

interface QueuedWorktreeIdentity extends WorktreeIdentity {
  generation: number;
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
  worktreeTargets: QueuedWorktreeIdentity[];
  branchTargets: Array<Pick<WorktreeIdentity, 'repoPath' | 'branchName' | 'branchOid'>>;
}

interface WorktreeRemovalTarget {
  repoPath: string;
  worktreePath: string;
  depth: number;
}

interface ManagedWorktreePruneTarget {
  canonicalWorktreePath: string;
  mtimeMs: number;
  expectedGeneration: number;
}

interface ManagedWorktreePruneCandidate {
  canonicalWorktreePath: string;
  mtimeMs: number;
}

export interface WorktreeReuseLease {
  canonicalWorktreePath: string;
  release: () => void;
}

function canonicalizePathForCompare(value: string): string {
  const resolvedPath = path.resolve(value);

  try {
    return realpathSync.native(resolvedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return resolvedPath;
    }
    throw error;
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = canonicalizePathForCompare(left);
  const normalizedRight = canonicalizePathForCompare(right);

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
  private worktreeLockTails = new Map<string, Promise<void>>();
  private logger = LogService.getInstance();

  static getInstance(): WorktreeCleanupService {
    if (!WorktreeCleanupService.instance) {
      WorktreeCleanupService.instance = new WorktreeCleanupService();
    }
    return WorktreeCleanupService.instance;
  }

  async acquireWorktreeReuseLease(worktreePath: string): Promise<WorktreeReuseLease> {
    const canonicalWorktreePath = canonicalizePathForCompare(worktreePath);
    const releaseLock = await this.acquireWorktreeLock(canonicalWorktreePath);

    try {
      const generation = this.incrementCleanupGeneration(canonicalWorktreePath);
      if (!this.isReusableWorktree(canonicalWorktreePath)) {
        throw new Error(
          `Worktree is no longer available for reuse at ${canonicalWorktreePath}`
        );
      }

      this.logger.debug(
        `Canceled stale cleanup generation for ${canonicalWorktreePath} (generation ${generation})`,
        'paneActions'
      );

      let released = false;
      return {
        canonicalWorktreePath,
        release: () => {
          if (released) {
            return;
          }
          released = true;
          releaseLock();
        },
      };
    } catch (error) {
      releaseLock();
      throw error;
    }
  }

  enqueueCleanup(job: WorktreeCleanupJob): void {
    if (!job.pane.worktreePath) {
      return;
    }

    const canonicalWorktreePath = canonicalizePathForCompare(job.pane.worktreePath);
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

  async cancelCleanupForWorktree(worktreePath: string): Promise<void> {
    const canonicalWorktreePath = canonicalizePathForCompare(worktreePath);
    await this.withWorktreeLock(canonicalWorktreePath, async () => {
      const generation = this.incrementCleanupGeneration(canonicalWorktreePath);
      this.logger.debug(
        `Canceled stale cleanup generation for ${canonicalWorktreePath} (generation ${generation})`,
        'paneActions'
      );
    });
  }

  async rollbackCreatedWorktree(
    job: CreatedWorktreeRollbackJob
  ): Promise<WorktreeRollbackResult> {
    const canonicalWorktreePath = canonicalizePathForCompare(job.worktreePath);
    return this.withWorktreeLock(canonicalWorktreePath, async () => {
      const identity: WorktreeIdentity = {
        repoPath: job.mainRepoPath,
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
          error: 'newly created branch identity changed before rollback',
        };
      }

      const removeResult = this.runGitTextSync(
        ['worktree', 'remove', identity.canonicalWorktreePath, '--force'],
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
    });
  }

  enqueuePruneManagedWorktrees(job: WorktreePruneJob): void {
    if (!Number.isInteger(job.maxManagedWorktrees) || job.maxManagedWorktrees < 1) {
      return;
    }

    let targets: ManagedWorktreePruneTarget[];
    try {
      targets = this.getManagedWorktreePruneTargets(job);
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Managed worktree pruning failed for ${job.projectRoot}: ${errorObj.message}`,
        'paneActions',
        undefined,
        errorObj
      );
      return;
    }
    if (targets.length === 0) {
      return;
    }

    this.cleanupQueue = this.cleanupQueue
      .then(() => this.runPruneManagedWorktrees(job, targets))
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

    const allWorktreesRemoved = await this.withWorktreeLock(
      job.canonicalWorktreePath,
      async () => {
        if (
          !this.canRunDestructiveCleanup(job)
          || !this.haveUnchangedQueuedBranchOids(job)
        ) {
          return false;
        }

        for (const target of job.worktreeTargets) {
          const removeTarget = () => this.removeValidatedWorktreeTarget(job, target);
          const removed = target.canonicalWorktreePath === job.canonicalWorktreePath
            ? await removeTarget()
            : await this.withWorktreeLock(target.canonicalWorktreePath, removeTarget);

          // Nested worktree removal must succeed before the parent can be
          // removed; otherwise a reused nested worktree could be deleted with
          // its parent directory.
          if (!removed) {
            return false;
          }
        }

        return true;
      }
    );

    // The hook should run after deletion is attempted, regardless of outcome.
    await triggerHook('worktree_removed', job.paneProjectRoot, job.pane);

    if (job.deleteBranch && allWorktreesRemoved) {
      await this.withWorktreeLock(job.canonicalWorktreePath, async () => {
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
      });
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

  private getCleanupGeneration(canonicalWorktreePath: string): number {
    return this.cleanupGenerations.get(canonicalWorktreePath) || 0;
  }

  private async withWorktreeLock<T>(
    canonicalWorktreePath: string,
    operation: () => Promise<T> | T
  ): Promise<T> {
    const release = await this.acquireWorktreeLock(canonicalWorktreePath);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async acquireWorktreeLock(
    canonicalWorktreePath: string
  ): Promise<() => void> {
    const previousTail = this.worktreeLockTails.get(canonicalWorktreePath)
      || Promise.resolve();
    let resolveCurrentTail!: () => void;
    const currentTail = new Promise<void>((resolve) => {
      resolveCurrentTail = resolve;
    });
    const queueTail = previousTail.then(() => currentTail);
    this.worktreeLockTails.set(canonicalWorktreePath, queueTail);
    await previousTail;

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      resolveCurrentTail();
      if (this.worktreeLockTails.get(canonicalWorktreePath) === queueTail) {
        this.worktreeLockTails.delete(canonicalWorktreePath);
      }
    };
  }

  private isReusableWorktree(canonicalWorktreePath: string): boolean {
    try {
      return (
        statSync(canonicalWorktreePath).isDirectory()
        && existsSync(path.join(canonicalWorktreePath, '.git'))
      );
    } catch {
      return false;
    }
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
    const identities: QueuedWorktreeIdentity[] = [];

    for (const target of worktreeTargets) {
      const canonicalTargetPath = canonicalizePathForCompare(target.worktreePath);
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

      const targetGeneration = canonicalTargetPath === canonicalWorktreePath
        ? generation
        : this.incrementCleanupGeneration(canonicalTargetPath);
      identities.push({
        repoPath: target.repoPath,
        canonicalWorktreePath: canonicalTargetPath,
        branchName,
        branchOid: branchOid.output,
        generation: targetGeneration,
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
      currentProjectRoot: canonicalizePathForCompare(job.currentProjectRoot),
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
    target?: QueuedWorktreeIdentity
  ): boolean {
    if (this.cleanupGenerations.get(job.canonicalWorktreePath) !== job.generation) {
      this.logger.warn(
        `Skipping background worktree cleanup for ${job.pane.slug}: cleanup was canceled or superseded`,
        'paneActions',
        job.pane.id
      );
      return false;
    }

    if (!this.configAllowsCleanup(job, target)) {
      return false;
    }

    if (!target) {
      return true;
    }

    if (this.getCleanupGeneration(target.canonicalWorktreePath) !== target.generation) {
      this.logger.warn(
        `Skipping worktree removal for ${job.pane.slug}: cleanup was canceled or superseded`,
        'paneActions',
        job.pane.id
      );
      return false;
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

    const currentOid = this.getBranchOid(target.repoPath, target.branchName);
    if (!currentOid.success || currentOid.output !== target.branchOid) {
      this.logger.warn(
        `Skipping worktree removal for ${job.pane.slug}: branch OID changed for ${target.branchName} in ${target.repoPath}`,
        'paneActions',
        job.pane.id
      );
      return false;
    }

    return true;
  }

  private async removeValidatedWorktreeTarget(
    job: QueuedWorktreeCleanupJob,
    target: QueuedWorktreeIdentity
  ): Promise<boolean> {
    if (!this.canRunDestructiveCleanup(job, target)) {
      return false;
    }

    const removeResult = await this.runGitCommand(
      ['worktree', 'remove', target.canonicalWorktreePath, '--force'],
      target.repoPath
    );

    if (!removeResult.success) {
      this.logger.warn(
        `Worktree removal reported an error for ${job.pane.slug} in ${target.repoPath}: ${removeResult.error}`,
        'paneActions',
        job.pane.id
      );
      return false;
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
      return false;
    }

    return true;
  }

  private haveUnchangedQueuedBranchOids(job: QueuedWorktreeCleanupJob): boolean {
    for (const target of job.worktreeTargets) {
      const currentOid = this.getBranchOid(target.repoPath, target.branchName);
      if (!currentOid.success || currentOid.output !== target.branchOid) {
        this.logger.warn(
          `Skipping background worktree cleanup for ${job.pane.slug}: branch OID changed for ${target.branchName} in ${target.repoPath}`,
          'paneActions',
          job.pane.id
        );
        return false;
      }
    }

    return true;
  }

  private configAllowsCleanup(
    job: QueuedWorktreeCleanupJob,
    target?: QueuedWorktreeIdentity
  ): boolean {
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

    if (
      config.projectRoot
      && canonicalizePathForCompare(config.projectRoot) !== job.currentProjectRoot
    ) {
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

    const protectedWorktreePath = target?.canonicalWorktreePath || job.canonicalWorktreePath;
    if (config.panes.some((pane) => (
      typeof pane.worktreePath === 'string'
      && pathsOverlap(pane.worktreePath, protectedWorktreePath)
    ))) {
      this.logger.warn(
        `Skipping background worktree cleanup for ${job.pane.slug}: current config still references ${protectedWorktreePath}`,
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
        currentWorktreePath = canonicalizePathForCompare(
          line.slice('worktree '.length).trim()
        );
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
      const canonicalWorktreePath = canonicalizePathForCompare(worktreePath);
      targets.set(`${repoPath}::${canonicalWorktreePath}`, {
        repoPath,
        worktreePath: canonicalWorktreePath,
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

  private async runPruneManagedWorktrees(
    job: WorktreePruneJob,
    targets = this.getManagedWorktreePruneTargets(job)
  ): Promise<void> {
    if (targets.length === 0) {
      return;
    }

    this.logger.debug(
      `Pruning ${targets.length} old managed worktree${targets.length === 1 ? '' : 's'} for ${job.projectRoot}`,
      'paneActions'
    );
    for (const target of targets) {
      await this.withWorktreeLock(target.canonicalWorktreePath, async () => {
        if (
          this.getCleanupGeneration(target.canonicalWorktreePath)
          !== target.expectedGeneration
        ) {
          this.logger.debug(
            `Managed worktree pruning skipped ${target.canonicalWorktreePath}: cleanup generation changed`,
            'paneActions'
          );
          return;
        }

        if (!this.configAllowsManagedPrune(job, target.canonicalWorktreePath)) {
          return;
        }

        const removeResult = await this.runGitCommand(
          ['worktree', 'remove', target.canonicalWorktreePath],
          job.projectRoot
        );

        if (!removeResult.success) {
          this.logger.warn(
            `Managed worktree pruning skipped ${target.canonicalWorktreePath}: ${removeResult.error}`,
            'paneActions'
          );
        }
      });
    }
  }

  private configAllowsManagedPrune(
    job: WorktreePruneJob,
    canonicalWorktreePath: string
  ): boolean {
    const configPath = job.configPath
      || path.join(job.projectRoot, '.psyche', 'psyche.config.json');
    let config: PsycheConfig;
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8')) as PsycheConfig;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Managed worktree pruning skipped ${canonicalWorktreePath}: could not read current config ${configPath}: ${errorMessage}`,
        'paneActions'
      );
      return false;
    }

    if (!Array.isArray(config.panes)) {
      this.logger.warn(
        `Managed worktree pruning skipped ${canonicalWorktreePath}: current config has no pane list`,
        'paneActions'
      );
      return false;
    }

    if (config.panes.some((pane) => (
      typeof pane.worktreePath === 'string'
      && pathsOverlap(pane.worktreePath, canonicalWorktreePath)
    ))) {
      this.logger.debug(
        `Managed worktree pruning skipped ${canonicalWorktreePath}: current config still references it`,
        'paneActions'
      );
      return false;
    }

    return true;
  }

  private getManagedWorktreePruneTargets(job: WorktreePruneJob): ManagedWorktreePruneTarget[] {
    if (!Number.isInteger(job.maxManagedWorktrees) || job.maxManagedWorktrees < 1) {
      return [];
    }

    const canonicalProjectRoot = canonicalizePathForCompare(job.projectRoot);
    const managedRoot = path.join(canonicalProjectRoot, '.psyche', 'worktrees');
    if (!existsSync(managedRoot)) {
      return [];
    }

    const activeWorktreePaths = job.activePanes
      .map((pane) => pane.worktreePath)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map(canonicalizePathForCompare);

    const managedWorktrees: ManagedWorktreePruneCandidate[] = [];

    for (const entry of readdirSync(managedRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const worktreePath = path.join(managedRoot, entry.name);
      const stats = statSync(worktreePath);
      managedWorktrees.push({
        canonicalWorktreePath: canonicalizePathForCompare(worktreePath),
        mtimeMs: stats.mtimeMs,
      });
    }

    if (managedWorktrees.length <= job.maxManagedWorktrees) {
      return [];
    }

    const activeManagedCount = managedWorktrees.filter((worktree) =>
      activeWorktreePaths.some((activePath) =>
        pathsOverlap(worktree.canonicalWorktreePath, activePath)
      )
    ).length;

    if (activeManagedCount >= job.maxManagedWorktrees) {
      return [];
    }

    const pruneCount = managedWorktrees.length - job.maxManagedWorktrees;

    return managedWorktrees
      .filter((worktree) =>
        !activeWorktreePaths.some((activePath) =>
          pathsOverlap(worktree.canonicalWorktreePath, activePath)
        )
      )
      .sort((left, right) => {
        if (left.mtimeMs !== right.mtimeMs) {
          return left.mtimeMs - right.mtimeMs;
        }

        return left.canonicalWorktreePath.localeCompare(right.canonicalWorktreePath);
      })
      .slice(0, pruneCount)
      .map((target) => ({
        ...target,
        expectedGeneration: this.getCleanupGeneration(target.canonicalWorktreePath),
      }));
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
