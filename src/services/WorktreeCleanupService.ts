import { execFileSync, spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import type { PsycheConfig, PsychePane } from '../types.js';
import { triggerHook } from '../utils/hooks.js';
import { getPaneBranchName } from '../utils/git.js';
import { detectAllWorktrees } from '../utils/worktreeDiscovery.js';
import { LogService } from './LogService.js';
import {
  acquireProjectWorktreeLifecycleLease,
  acquireWorktreeOperationLease,
  type ProjectWorktreeLifecycleLease,
} from './WorktreeOperationLease.js';
import { canonicalizePathWithExistingAncestor } from './WorktreePath.js';
import {
  paneReferencesWorktree,
  pathsOverlap,
} from '../utils/paneWorktreeReference.js';
import {
  readProjectPaneConfigUnderLock,
} from './ProjectPaneConfig.js';
import {
  describeLiveTmuxWorktreeGuard,
  inspectLiveTmuxWorktreeConsumers,
} from './LiveTmuxWorktreeGuard.js';
import {
  findBlockingWorktreeRecoveryMarker,
} from './WorktreeRecoveryMarker.js';

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
  /**
   * The session config that must not reference this worktree before rollback.
   * Defaults to mainRepoPath for legacy callers.
   */
  configProjectRoot?: string;
  startingOid?: string;
  creatorNonce?: string;
}

export interface WorktreeRollbackResult {
  success: boolean;
  error?: string;
}

export interface CreatedWorktreeIdentity {
  canonicalWorktreePath: string;
  branchName: string;
  startingOid: string;
  createdOid: string;
  creatorNonce: string;
  mainRepoPath: string;
  deleteBranch: boolean;
  configProjectRoot: string;
}

export interface WorktreeCreationReservation {
  canonicalWorktreePath: string;
  creatorNonce: string;
  /**
   * Makes complete/cancel intentionally non-destructive for an uncertain
   * lifecycle. A recovery marker must later be acknowledged by an operator.
   */
  retain: () => void;
  recordCreatedWorktree: (input: {
    branchName: string;
    startingOid: string;
    createdOid: string;
    deleteBranch: boolean;
    configProjectRoot?: string;
  }) => CreatedWorktreeIdentity;
  rollbackCreatedWorktree: (
    identity: CreatedWorktreeIdentity,
  ) => Promise<WorktreeRollbackResult>;
  complete: () => Promise<void>;
  cancel: () => Promise<void>;
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
  mainRepoPath: string;
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
  blockedByActiveReuseReservation: boolean;
}

interface ManagedWorktreePruneCandidate {
  canonicalWorktreePath: string;
  mtimeMs: number;
}

export interface WorktreeReuseReservation {
  canonicalWorktreePath: string;
  /**
   * Prevents any later automatic complete/cancel path from releasing this
   * reservation after a possibly-live pane could not be made durable.
   */
  retain: () => void;
  complete: () => Promise<void>;
  cancel: () => Promise<void>;
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
  private activeReuseReservations = new Map<string, number>();
  private logger = LogService.getInstance();

  static getInstance(): WorktreeCleanupService {
    if (!WorktreeCleanupService.instance) {
      WorktreeCleanupService.instance = new WorktreeCleanupService();
    }
    return WorktreeCleanupService.instance;
  }

  async withWorktreeReuseReservation<T>(
    worktreePath: string,
    operation: (canonicalWorktreePath: string) => Promise<T> | T,
    projectRoot?: string,
    projectLifecycleLease?: ProjectWorktreeLifecycleLease,
  ): Promise<T> {
    const reservation = await this.beginWorktreeReuseReservation(
      worktreePath,
      projectRoot,
      projectLifecycleLease,
    );
    let completed = false;

    try {
      const result = await operation(reservation.canonicalWorktreePath);
      await reservation.complete();
      completed = true;
      return result;
    } finally {
      if (!completed) {
        await reservation.cancel();
      }
    }
  }

  async beginWorktreeReuseReservation(
    worktreePath: string,
    projectRoot?: string,
    projectLifecycleLease?: ProjectWorktreeLifecycleLease,
  ): Promise<WorktreeReuseReservation> {
    const canonicalWorktreePath = canonicalizePathWithExistingAncestor(worktreePath);
    const ownedProjectLifecycleLease = projectLifecycleLease
      ? undefined
      : await acquireProjectWorktreeLifecycleLease({
        projectRoot,
        worktreePath: canonicalWorktreePath,
        operation: 'reuse',
      });
    const releaseLock = await this.acquireWorktreeLock(canonicalWorktreePath);
    let operationLease: Awaited<ReturnType<typeof acquireWorktreeOperationLease>> | undefined;

    try {
      operationLease = await acquireWorktreeOperationLease({
        worktreePath: canonicalWorktreePath,
        projectRoot,
        operation: 'reuse',
      });
      const generation = this.incrementCleanupGeneration(canonicalWorktreePath);
      const recoveryMarker = findBlockingWorktreeRecoveryMarker(
        projectRoot || operationLease.canonicalProjectRoot,
        canonicalWorktreePath,
      );
      if (recoveryMarker.blocked) {
        throw new Error(
          `Worktree requires operator recovery before reuse: ${recoveryMarker.reason}`,
        );
      }
      if (!this.isReusableWorktree(canonicalWorktreePath)) {
        throw new Error(
          `Worktree is no longer available for reuse at ${canonicalWorktreePath}`
        );
      }
      this.addActiveReuseReservation(canonicalWorktreePath);

      this.logger.debug(
        `Reserved ${canonicalWorktreePath} for reuse (generation ${generation})`,
        'paneActions'
      );

      let settlePromise: Promise<void> | undefined;
      let retained = false;
      const settle = (outcome: 'completed' | 'canceled'): Promise<void> => {
        if (retained) {
          return Promise.resolve();
        }
        if (!settlePromise) {
          this.removeActiveReuseReservation(canonicalWorktreePath);
          settlePromise = operationLease!.release()
            .finally(releaseLock)
            .then(async () => {
              await ownedProjectLifecycleLease?.release();
              this.logger.debug(
                `Reuse reservation ${outcome} for ${canonicalWorktreePath}`,
                'paneActions'
              );
            });
        }
        return settlePromise;
      };

      return {
        canonicalWorktreePath,
        retain: () => {
          retained = true;
          this.logger.warn(
            `Retained reuse reservation for operator recovery at ${canonicalWorktreePath}`,
            'paneActions',
          );
        },
        complete: () => settle('completed'),
        cancel: () => settle('canceled'),
      };
    } catch (error) {
      await operationLease?.release();
      releaseLock();
      await ownedProjectLifecycleLease?.release();
      throw error;
    }
  }

  enqueueCleanup(job: WorktreeCleanupJob): void {
    if (!job.pane.worktreePath) {
      return;
    }

    const canonicalWorktreePath = canonicalizePathWithExistingAncestor(job.pane.worktreePath);
    const generation = this.incrementCleanupGeneration(canonicalWorktreePath);
    if (this.isWorktreeReuseReserved(canonicalWorktreePath)) {
      this.logger.warn(
        `Skipping background worktree cleanup for ${job.pane.slug}: worktree is actively reserved for reuse`,
        'paneActions',
        job.pane.id
      );
      return;
    }

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
    const canonicalWorktreePath = canonicalizePathWithExistingAncestor(worktreePath);
    await this.withWorktreeLock(canonicalWorktreePath, async () => {
      const generation = this.incrementCleanupGeneration(canonicalWorktreePath);
      this.logger.debug(
        `Canceled stale cleanup generation for ${canonicalWorktreePath} (generation ${generation})`,
        'paneActions'
      );
    });
  }

  /**
   * Reserves a planned worktree before allocation. The same lease remains held
   * until the pane record is durable or guarded rollback has finished.
   */
  async beginWorktreeCreation(
    worktreePath: string,
    mainRepoPath: string,
    projectLifecycleLease?: ProjectWorktreeLifecycleLease,
  ): Promise<WorktreeCreationReservation> {
    const canonicalWorktreePath = canonicalizePathWithExistingAncestor(worktreePath);
    const ownedProjectLifecycleLease = projectLifecycleLease
      ? undefined
      : await acquireProjectWorktreeLifecycleLease({
        projectRoot: mainRepoPath,
        worktreePath: canonicalWorktreePath,
        operation: 'create',
      });
    const releaseLock = await this.acquireWorktreeLock(canonicalWorktreePath);
    let operationLease: Awaited<ReturnType<typeof acquireWorktreeOperationLease>> | undefined;

    try {
      operationLease = await acquireWorktreeOperationLease({
        worktreePath: canonicalWorktreePath,
        projectRoot: mainRepoPath,
        operation: 'create',
      });
      this.incrementCleanupGeneration(canonicalWorktreePath);
      const recoveryMarker = findBlockingWorktreeRecoveryMarker(
        mainRepoPath,
        canonicalWorktreePath,
      );
      if (recoveryMarker.blocked) {
        throw new Error(
          `Worktree requires operator recovery before creation: ${recoveryMarker.reason}`,
        );
      }

      let settlePromise: Promise<void> | undefined;
      let retained = false;
      const settle = (): Promise<void> => {
        if (retained) {
          return Promise.resolve();
        }
        if (!settlePromise) {
          settlePromise = operationLease!.release()
            .finally(releaseLock)
            .then(() => ownedProjectLifecycleLease?.release());
        }
        return settlePromise;
      };

      return {
        canonicalWorktreePath,
        creatorNonce: operationLease.nonce,
        retain: () => {
          retained = true;
          this.logger.warn(
            `Retained creation reservation for operator recovery at ${canonicalWorktreePath}`,
            'paneActions',
          );
        },
        recordCreatedWorktree: ({
          branchName,
          startingOid,
          createdOid,
          deleteBranch,
          configProjectRoot = mainRepoPath,
        }) => ({
          canonicalWorktreePath,
          branchName,
          startingOid,
          createdOid,
          creatorNonce: operationLease!.nonce,
          mainRepoPath,
          deleteBranch,
          configProjectRoot,
        }),
        rollbackCreatedWorktree: async (identity) => {
          return this.rollbackCreatedWorktreeWhileLeased(
            identity,
            operationLease!.nonce,
          );
        },
        complete: settle,
        cancel: settle,
      };
    } catch (error) {
      await operationLease?.release();
      releaseLock();
      await ownedProjectLifecycleLease?.release();
      throw error;
    }
  }

  async rollbackCreatedWorktree(
    job: CreatedWorktreeRollbackJob
  ): Promise<WorktreeRollbackResult> {
    const canonicalWorktreePath = canonicalizePathWithExistingAncestor(job.worktreePath);
    return this.withProjectLifecycleLease(
      job.mainRepoPath,
      canonicalWorktreePath,
      'rollback',
      async (projectLifecycleLease) => this.withWorktreeLifecycleLock(
        canonicalWorktreePath,
        job.mainRepoPath,
        'rollback',
        async () => this.rollbackCreatedWorktreeWhileLeased({
          canonicalWorktreePath,
          branchName: job.branchName,
          startingOid: job.startingOid || job.branchOid,
          createdOid: job.branchOid,
          creatorNonce: job.creatorNonce || '',
          mainRepoPath: job.mainRepoPath,
          deleteBranch: job.deleteBranch,
          configProjectRoot: job.configProjectRoot || job.mainRepoPath,
        }),
        projectLifecycleLease,
      ),
    );
  }

  private async rollbackCreatedWorktreeWhileLeased(
    identity: CreatedWorktreeIdentity,
    requiredCreatorNonce?: string,
  ): Promise<WorktreeRollbackResult> {
    if (
      requiredCreatorNonce !== undefined
      && identity.creatorNonce !== requiredCreatorNonce
    ) {
      return {
        success: false,
        error: 'newly created worktree ownership nonce changed before rollback',
      };
    }

    let stillReferenced = false;
    try {
      const config = await readProjectPaneConfigUnderLock(identity.configProjectRoot);
      const panes = Array.isArray(config.panes) ? config.panes : [];
      stillReferenced = panes.some((pane) => (
        paneReferencesWorktree(pane, identity.canonicalWorktreePath)
      ));
    } catch (error) {
      return {
        success: false,
        error: `could not read current pane config before rollback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    if (stillReferenced) {
      return {
        success: false,
        error: 'newly created worktree is referenced by current pane config',
      };
    }

    const recoveryMarker = findBlockingWorktreeRecoveryMarker(
      identity.mainRepoPath,
      identity.canonicalWorktreePath,
    );
    if (recoveryMarker.blocked) {
      return {
        success: false,
        error: `newly created worktree has an unresolved recovery marker: ${recoveryMarker.reason}`,
      };
    }

    const mappedBranch = this.getWorktreeBranch(
      identity.mainRepoPath,
      identity.canonicalWorktreePath,
    );
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

    const currentOid = this.getBranchOid(identity.mainRepoPath, identity.branchName);
    if (!currentOid.success || currentOid.output !== identity.createdOid) {
      return {
        success: false,
        error: 'newly created branch identity changed before rollback',
      };
    }

    // `git worktree remove` is deliberately the final dirtiness check. A
    // status precheck races with hooks, editors, and agents writing after the
    // check; Git's non-forced removal is the atomic authority. In particular,
    // do not delete ignored user files such as .env to make a rollback pass.
    const tmuxGuard = inspectLiveTmuxWorktreeConsumers(
      identity.canonicalWorktreePath,
    );
    if (tmuxGuard.state !== 'safe') {
      return {
        success: false,
        error: `refusing rollback while ${describeLiveTmuxWorktreeGuard(tmuxGuard)}`,
      };
    }

    const removeResult = this.runGitTextSync(
      ['worktree', 'remove', identity.canonicalWorktreePath],
      identity.mainRepoPath
    );
    if (!removeResult.success) {
      const error = `failed to remove newly created worktree; preserved worktree and branch at ${identity.canonicalWorktreePath}: ${removeResult.error}`;
      this.logger.warn(
        error,
        'paneActions',
      );
      return {
        success: false,
        error,
      };
    }

    const afterRemoval = this.getWorktreeBranch(
      identity.mainRepoPath,
      identity.canonicalWorktreePath,
    );
    if (!afterRemoval.success || afterRemoval.found) {
      return {
        success: false,
        error: afterRemoval.success
          ? 'newly created worktree removal could not be confirmed'
          : `could not confirm newly created worktree removal: ${afterRemoval.error}`,
      };
    }

    if (!identity.deleteBranch) {
      return { success: true };
    }

    const branchOidBeforeDelete = this.getBranchOid(
      identity.mainRepoPath,
      identity.branchName,
    );
    if (
      !branchOidBeforeDelete.success
      || branchOidBeforeDelete.output !== identity.createdOid
    ) {
      return {
        success: false,
        error: 'newly created branch identity changed before rollback deletion',
      };
    }

    const deleteResult = this.runGitTextSync(
      ['branch', '-D', identity.branchName],
      identity.mainRepoPath
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

    let allWorktreesRemoved = false;
    await this.withProjectLifecycleLease(
      job.mainRepoPath,
      job.canonicalWorktreePath,
      'cleanup',
      async (projectLifecycleLease) => {
        allWorktreesRemoved = await this.withWorktreeLifecycleLock(
          job.canonicalWorktreePath,
          job.mainRepoPath,
          'cleanup',
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
                : await this.withWorktreeLifecycleLock(
                  target.canonicalWorktreePath,
                  target.repoPath,
                  'cleanup',
                  removeTarget,
                  projectLifecycleLease,
                );

              // Nested worktree removal must succeed before the parent can be
              // removed; otherwise a reused nested worktree could be deleted with
              // its parent directory.
              if (!removed) {
                return false;
              }
            }

            return true;
          },
          projectLifecycleLease,
        );

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
      },
    );

    // The hook should run after deletion is attempted, regardless of outcome.
    await triggerHook('worktree_removed', job.paneProjectRoot, job.pane);

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

  private addActiveReuseReservation(canonicalWorktreePath: string): void {
    this.activeReuseReservations.set(
      canonicalWorktreePath,
      (this.activeReuseReservations.get(canonicalWorktreePath) || 0) + 1
    );
  }

  private removeActiveReuseReservation(canonicalWorktreePath: string): void {
    const count = this.activeReuseReservations.get(canonicalWorktreePath) || 0;
    if (count <= 1) {
      this.activeReuseReservations.delete(canonicalWorktreePath);
      return;
    }
    this.activeReuseReservations.set(canonicalWorktreePath, count - 1);
  }

  private isWorktreeReuseReserved(canonicalWorktreePath: string): boolean {
    for (const [reservedPath, count] of this.activeReuseReservations) {
      if (count > 0 && pathsOverlap(reservedPath, canonicalWorktreePath)) {
        return true;
      }
    }
    return false;
  }

  private getCleanupGeneration(canonicalWorktreePath: string): number {
    return this.cleanupGenerations.get(canonicalWorktreePath) || 0;
  }

  private async withWorktreeLifecycleLock<T>(
    canonicalWorktreePath: string,
    projectRoot: string,
    operation: 'cleanup' | 'prune' | 'rollback',
    callback: () => Promise<T> | T,
    projectLifecycleLease?: ProjectWorktreeLifecycleLease,
  ): Promise<T> {
    const ownedProjectLifecycleLease = projectLifecycleLease
      ? undefined
      : await acquireProjectWorktreeLifecycleLease({
        projectRoot,
        worktreePath: canonicalWorktreePath,
        operation,
      });
    try {
      return await this.withWorktreeLock(canonicalWorktreePath, async () => {
        const lease = await acquireWorktreeOperationLease({
          worktreePath: canonicalWorktreePath,
          projectRoot,
          operation,
        });
        try {
          return await callback();
        } finally {
          await lease.release();
        }
      });
    } finally {
      await ownedProjectLifecycleLease?.release();
    }
  }

  private async withProjectLifecycleLease<T>(
    projectRoot: string,
    worktreePath: string,
    operation: 'cleanup' | 'prune' | 'rollback',
    callback: (lease: ProjectWorktreeLifecycleLease) => Promise<T> | T,
  ): Promise<T> {
    const lease = await acquireProjectWorktreeLifecycleLease({
      projectRoot,
      worktreePath,
      operation,
    });
    try {
      return await callback(lease);
    } finally {
      await lease.release();
    }
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
      const canonicalTargetPath = canonicalizePathWithExistingAncestor(target.worktreePath);
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
      mainRepoPath: job.mainRepoPath,
      canonicalWorktreePath,
      branchName,
      branchOid: rootIdentity.branchOid,
      configPath: job.configPath,
      currentProjectRoot: canonicalizePathWithExistingAncestor(job.currentProjectRoot),
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
    const protectedWorktreePath = target?.canonicalWorktreePath || job.canonicalWorktreePath;
    if (this.isWorktreeReuseReserved(protectedWorktreePath)) {
      this.logger.warn(
        `Skipping background worktree cleanup for ${job.pane.slug}: ${protectedWorktreePath} is actively reserved for reuse`,
        'paneActions',
        job.pane.id
      );
      return false;
    }

    const recoveryMarker = findBlockingWorktreeRecoveryMarker(
      job.mainRepoPath,
      protectedWorktreePath,
    );
    if (recoveryMarker.blocked) {
      this.logger.warn(
        `Skipping background worktree cleanup for ${job.pane.slug}: ${recoveryMarker.reason}`,
        'paneActions',
        job.pane.id,
      );
      return false;
    }

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

    const tmuxGuard = inspectLiveTmuxWorktreeConsumers(
      target.canonicalWorktreePath,
    );
    if (tmuxGuard.state !== 'safe') {
      this.logger.warn(
        `Skipping worktree removal for ${job.pane.slug}: ${describeLiveTmuxWorktreeGuard(tmuxGuard)}`,
        'paneActions',
        job.pane.id,
      );
      return false;
    }

    const removeResult = await this.runGitCommand(
      ['worktree', 'remove', target.canonicalWorktreePath],
      target.repoPath
    );

    if (!removeResult.success) {
      this.logger.warn(
        `Worktree removal preserved ${target.canonicalWorktreePath} for ${job.pane.slug} in ${target.repoPath}: ${removeResult.error}`,
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
      && canonicalizePathWithExistingAncestor(config.projectRoot) !== job.currentProjectRoot
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
      paneReferencesWorktree(pane, protectedWorktreePath)
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
        currentWorktreePath = canonicalizePathWithExistingAncestor(
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
      const canonicalWorktreePath = canonicalizePathWithExistingAncestor(worktreePath);
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
    await this.withProjectLifecycleLease(
      job.projectRoot,
      targets[0].canonicalWorktreePath,
      'prune',
      async (projectLifecycleLease) => {
        for (const target of targets) {
          await this.withWorktreeLifecycleLock(
            target.canonicalWorktreePath,
            job.projectRoot,
            'prune',
            async () => {
              if (
                target.blockedByActiveReuseReservation
                || this.isWorktreeReuseReserved(target.canonicalWorktreePath)
              ) {
                this.logger.debug(
                  `Managed worktree pruning skipped ${target.canonicalWorktreePath}: worktree is actively reserved for reuse`,
                  'paneActions'
                );
                return;
              }

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

              const recoveryMarker = findBlockingWorktreeRecoveryMarker(
                job.projectRoot,
                target.canonicalWorktreePath,
              );
              if (recoveryMarker.blocked) {
                this.logger.warn(
                  `Managed worktree pruning skipped ${target.canonicalWorktreePath}: ${recoveryMarker.reason}`,
                  'paneActions',
                );
                return;
              }

              const tmuxGuard = inspectLiveTmuxWorktreeConsumers(
                target.canonicalWorktreePath,
              );
              if (tmuxGuard.state !== 'safe') {
                this.logger.warn(
                  `Managed worktree pruning skipped ${target.canonicalWorktreePath}: ${describeLiveTmuxWorktreeGuard(tmuxGuard)}`,
                  'paneActions',
                );
                return;
              }

              const removeResult = await this.runGitCommand(
                ['worktree', 'remove', target.canonicalWorktreePath],
                job.projectRoot
              );

              if (!removeResult.success) {
                this.logger.warn(
                  `Managed worktree pruning skipped ${target.canonicalWorktreePath}: preserved dirty or inaccessible worktree: ${removeResult.error}`,
                  'paneActions'
                );
              }
            },
            projectLifecycleLease,
          );
        }
      },
    );
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
      paneReferencesWorktree(pane, canonicalWorktreePath)
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

    const canonicalProjectRoot = canonicalizePathWithExistingAncestor(job.projectRoot);
    const managedRoot = path.join(canonicalProjectRoot, '.psyche', 'worktrees');
    if (!existsSync(managedRoot)) {
      return [];
    }

    const managedWorktrees: ManagedWorktreePruneCandidate[] = [];

    for (const entry of readdirSync(managedRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const worktreePath = path.join(managedRoot, entry.name);
      const stats = statSync(worktreePath);
      managedWorktrees.push({
        canonicalWorktreePath: canonicalizePathWithExistingAncestor(worktreePath),
        mtimeMs: stats.mtimeMs,
      });
    }

    if (managedWorktrees.length <= job.maxManagedWorktrees) {
      return [];
    }

    const activeManagedCount = managedWorktrees.filter((worktree) =>
      job.activePanes.some((pane) =>
        paneReferencesWorktree(pane, worktree.canonicalWorktreePath)
      )
    ).length;

    if (activeManagedCount >= job.maxManagedWorktrees) {
      return [];
    }

    const pruneCount = managedWorktrees.length - job.maxManagedWorktrees;

    return managedWorktrees
      .filter((worktree) =>
        !job.activePanes.some((pane) =>
          paneReferencesWorktree(pane, worktree.canonicalWorktreePath)
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
        blockedByActiveReuseReservation: this.isWorktreeReuseReserved(
          target.canonicalWorktreePath
        ),
      }));
  }

  private runGitCommand(args: string[], cwd: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn('git', args, {
        cwd,
        shell: false,
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
