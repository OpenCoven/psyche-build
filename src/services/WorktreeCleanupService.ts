import { execFileSync, spawn } from 'child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'fs';
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
  type WorktreeOperationLease,
} from './WorktreeOperationLease.js';
import {
  isGitMutationSupervisorLease,
  runGitMutationWithSupervisor,
  type GitMutationSupervisorResult,
  type GitMutationSupervisorLease,
} from './GitMutationSupervisor.js';
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
  findBlockingWorktreeReuseRecoveryMarker,
  writeWorktreeRecoveryMarker,
} from './WorktreeRecoveryMarker.js';

export interface WorktreeCleanupJob {
  pane: PsychePane;
  paneProjectRoot: string;
  mainRepoPath: string;
  configPath: string;
  currentProjectRoot: string;
  deleteBranch: boolean;
}

/**
 * What Git and the filesystem jointly say about a worktree after a removal
 * attempt. `git worktree remove` deletes the tree first and the registration
 * second, and keeps going after a failed delete, so a fault inside Git's write
 * (a read-only subdirectory, a killed process, a full disk) can leave any
 * combination behind:
 *
 * - `removed`: unregistered and gone. Nothing to do.
 * - `intact`: registered, present, Git link present. Git refused before
 *   writing, or never ran; ordinary preservation. This includes a worktree a
 *   killed Git left with some committed files deleted but its link intact:
 *   Git then refuses every later non-forced removal as dirty, which loses
 *   nothing (the files are on the branch) but stays stuck until an operator
 *   restores or force-removes it.
 * - `registration_only`: registered but the directory is gone. Non-forced
 *   `git worktree remove` reconciles this by deleting only the administrative
 *   entry; no user file exists to lose.
 * - `partially_removed`: positive evidence Git began removing a tree that is
 *   still present — registered without its `.git` link, unregistered while its
 *   link names this repository's now-missing administrative entry, or
 *   unregistered right after a removal the caller saw start from a registered
 *   worktree. recovery_required, with advice to inspect and then remove or
 *   restore.
 * - `unregistered`: present, not registered, and no evidence a removal ran (a
 *   plain directory, a link into another repository). recovery_required with a
 *   neutral reason and no deletion advice: it may be a healthy worktree.
 * - `unknown`: the registration could not be read. Never acted on.
 */
export type WorktreeRemovalState =
  | 'removed'
  | 'intact'
  | 'registration_only'
  | 'partially_removed'
  | 'unregistered'
  | 'unknown';

/**
 * The worktree's `.git` entry: absent, a link to this repository's
 * administrative entry that no longer exists, or anything else (a live link, a
 * link into another repository, a directory, an unreadable entry).
 */
export type WorktreeGitLink = 'missing' | 'orphaned' | 'other';

export function classifyWorktreeRemovalState(observed: {
  registered: boolean | undefined;
  directoryPresent: boolean;
  gitLink: WorktreeGitLink;
  /** The caller saw this path registered immediately before running Git's removal. */
  removalObserved?: boolean;
}): WorktreeRemovalState {
  if (observed.registered === undefined) return 'unknown';
  if (!observed.directoryPresent) {
    return observed.registered ? 'registration_only' : 'removed';
  }
  if (observed.registered) {
    return observed.gitLink === 'missing' ? 'partially_removed' : 'intact';
  }
  return observed.gitLink === 'orphaned' || observed.removalObserved === true
    ? 'partially_removed'
    : 'unregistered';
}

/** Anything at the path counts as present; only ENOENT proves absence. */
function pathEntryPresent(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    return !isMissingPathError(error);
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

/** A Git link file is a single short line; anything larger is not one. */
const MAX_GIT_LINK_BYTES = 4096;

export function inspectWorktreeGitLink(
  canonicalWorktreePath: string,
  repoPath: string,
): WorktreeGitLink {
  const linkPath = path.join(canonicalWorktreePath, '.git');
  let content: string;
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isFile() || stat.size > MAX_GIT_LINK_BYTES) return 'other';
    content = readFileSync(linkPath, 'utf8');
  } catch (error) {
    return isMissingPathError(error) ? 'missing' : 'other';
  }
  const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(content);
  if (!match) return 'other';
  const adminDir = path.resolve(canonicalWorktreePath, match[1]);
  const adminParent = path.dirname(adminDir);
  const ownedByRepo = path.basename(adminParent) === 'worktrees'
    && canonicalizePathWithExistingAncestor(path.dirname(adminParent))
      === canonicalizePathWithExistingAncestor(path.join(repoPath, '.git'));
  if (!ownedByRepo) return 'other';
  return pathEntryPresent(adminDir) ? 'other' : 'orphaned';
}

/**
 * A fixed description of how Git ended. Git's stderr carries absolute paths
 * and free text, so it never enters a durable marker.
 */
function describeExit(result: CommandResult): string {
  return typeof result.exitCode === 'number'
    ? `exited with code ${result.exitCode}`
    : 'ended without an exit code';
}

const ORPHAN_SCAN_MAX_DEPTH = 6;
const ORPHAN_SCAN_MAX_ENTRIES = 20_000;
const ORPHAN_SCAN_SKIPPED = new Set(['node_modules', 'vendor', '.pnpm']);

/**
 * Nested directories under `root` whose `.git` link names a
 * `<repo>/.git/worktrees/<id>` admin entry that no longer exists: what an
 * interrupted nested `git worktree remove` leaves behind. Bounded in depth and
 * entries, skips hidden and dependency directories like worktree discovery,
 * and reads only link files. Unreadable directories are skipped.
 */
export function findOrphanedNestedWorktreeLinks(
  root: string,
): Array<{ repoPath: string; worktreePath: string; depth: number }> {
  const found: Array<{ repoPath: string; worktreePath: string; depth: number }> = [];
  let budget = ORPHAN_SCAN_MAX_ENTRIES;
  const visit = (directory: string, depth: number) => {
    if (depth > ORPHAN_SCAN_MAX_DEPTH) return;
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (--budget < 0) return;
      if (!entry.isDirectory() || entry.name.startsWith('.') || ORPHAN_SCAN_SKIPPED.has(entry.name)) {
        continue;
      }
      const child = path.join(directory, entry.name);
      const adminDir = readGitLinkTarget(child);
      if (adminDir && path.basename(path.dirname(adminDir)) === 'worktrees'
        && path.basename(path.dirname(path.dirname(adminDir))) === '.git') {
        const repoPath = path.dirname(path.dirname(path.dirname(adminDir)));
        if (inspectWorktreeGitLink(child, repoPath) === 'orphaned') {
          found.push({ repoPath, worktreePath: child, depth });
        }
      }
      visit(child, depth + 1);
    }
  };
  visit(root, 1);
  return found;
}

/** The absolute admin directory a `.git` link file names, if it is one. */
function readGitLinkTarget(directory: string): string | undefined {
  const linkPath = path.join(directory, '.git');
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isFile() || stat.size > MAX_GIT_LINK_BYTES) return undefined;
    const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(linkPath, 'utf8'));
    return match ? path.resolve(directory, match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** Recovery markers name a pane; cleanup paths without one use these. */
const ROLLBACK_MARKER_PANE = { id: 'worktree-rollback', paneId: 'uncreated', slug: 'rollback' };
const PRUNE_MARKER_PANE = { id: 'managed-worktree-prune', paneId: 'none', slug: 'managed prune' };

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
  recoveryId?: string;
}

export interface WorktreeCreationReservation {
  canonicalWorktreePath: string;
  creatorNonce: string;
  /**
   * Makes complete/cancel intentionally non-destructive for an uncertain
   * lifecycle. A recovery marker must later be acknowledged by an operator.
   */
  retain: () => RetainedWorktreeReservation | void;
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
  /**
   * Executes a Git mutation under this reservation's exact-path and
   * project-wide filesystem leases.
   */
  runGitMutation: (
    args: readonly string[],
    cwd: string,
  ) => Promise<GitMutationSupervisorResult>;
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
  /** Git's exit code when Git ran and exited; absent when it never ran. */
  exitCode?: number | null;
}

interface GitTextResult extends CommandResult {
  output?: string;
}

type MutationLease = Pick<
  WorktreeOperationLease | ProjectWorktreeLifecycleLease,
  | 'trackChildProcess'
  | 'clearChildProcess'
  | 'lockDir'
  | 'nonce'
  | 'preparePendingGitMutation'
>;

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
  retain: () => RetainedWorktreeReservation | void;
  complete: () => Promise<void>;
  cancel: () => Promise<void>;
}

export interface RetainedWorktreeReservation {
  associateRecoveryMarker: (marker: {
    path: string;
    generation?: string;
  }) => void;
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
    recoveryProjectRoot?: string,
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
      const targetProjectRoot = projectRoot || operationLease.canonicalProjectRoot;
      const recoveryMarker = findBlockingWorktreeReuseRecoveryMarker(
        recoveryProjectRoot || targetProjectRoot,
        targetProjectRoot,
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
      let retainedHandle: RetainedWorktreeReservation | undefined;
      const settle = (
        outcome: 'completed' | 'canceled' | 'recovery acknowledged',
        force = false,
      ): Promise<void> => {
        if (retained && !force) {
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
          retainedHandle ??= {
            associateRecoveryMarker: (marker) => {
              void waitForRecoveryMarkerAcknowledgement(marker.path)
                .then(async () => {
                  let retryAttempt = 0;
                  while (true) {
                    try {
                      retained = false;
                      await settle('recovery acknowledged', true);
                      return;
                    } catch (error) {
                      retryAttempt += 1;
                      retained = true;
                      settlePromise = undefined;
                      if (shouldLogSettlementRetry(retryAttempt)) {
                        this.logger.error(
                          `Failed to settle retained reuse reservation after recovery acknowledgement: ${
                            error instanceof Error ? error.message : String(error)
                          }`,
                          'paneActions',
                        );
                      }
                      await waitForSettlementRetry(retryAttempt);
                    }
                  }
                })
                .catch((error) => {
                  this.logger.error(
                    `Failed to monitor retained reuse reservation recovery marker: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                    'paneActions',
                  );
                });
            },
          };
          return retainedHandle;
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
      // A worktree Git no longer registers but whose directory survives is what
      // an owner killed inside `git worktree remove` leaves behind. Capture
      // refuses it, which is right, but refusing silently would strand the
      // remaining files with no record. Publish recovery_required instead,
      // checking every removal target against its own repository.
      const unresolvedTargets = job.configPath && job.currentProjectRoot
        ? this.getWorktreeRemovalTargets(job.pane, job.mainRepoPath)
          .filter((target) => this.nextAttemptRecoveryState(target) !== undefined)
        : [];
      if (unresolvedTargets.length > 0) {
        this.cleanupQueue = this.cleanupQueue
          .then(() => this.recordPartialRemovalOnNextAttempt(job, unresolvedTargets))
          .catch((error) => {
            const errorObj = error instanceof Error ? error : new Error(String(error));
            this.logger.error(
              `Could not record partially removed worktree for ${job.pane.slug}: ${errorObj.message}`,
              'paneActions',
              job.pane.id,
              errorObj
            );
          });
      }
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
    recoveryProjectRoot?: string,
    authorizedRecoveryId?: string,
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
        recoveryProjectRoot || mainRepoPath,
        mainRepoPath,
        canonicalWorktreePath,
        authorizedRecoveryId,
      );
      if (recoveryMarker.blocked) {
        throw new Error(
          `Worktree requires operator recovery before creation: ${recoveryMarker.reason}`,
        );
      }

      let settlePromise: Promise<void> | undefined;
      let retained = false;
      let retainedHandle: RetainedWorktreeReservation | undefined;
      const settle = (force = false): Promise<void> => {
        if (retained && !force) {
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
          retainedHandle ??= {
            associateRecoveryMarker: (marker) => {
              void waitForRecoveryMarkerAcknowledgement(marker.path)
                .then(async () => {
                  let retryAttempt = 0;
                  while (true) {
                    try {
                      retained = false;
                      await settle(true);
                      return;
                    } catch (error) {
                      retryAttempt += 1;
                      retained = true;
                      settlePromise = undefined;
                      if (shouldLogSettlementRetry(retryAttempt)) {
                        this.logger.error(
                          `Failed to settle retained creation reservation after recovery acknowledgement: ${
                            error instanceof Error ? error.message : String(error)
                          }`,
                          'paneActions',
                        );
                      }
                      await waitForSettlementRetry(retryAttempt);
                    }
                  }
                })
                .catch((error) => {
                  this.logger.error(
                    `Failed to monitor retained creation reservation recovery marker: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                    'paneActions',
                  );
                });
            },
          };
          return retainedHandle;
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
          ...(authorizedRecoveryId ? { recoveryId: authorizedRecoveryId } : {}),
        }),
        rollbackCreatedWorktree: async (identity) => {
          return this.rollbackCreatedWorktreeWhileLeased(
            identity,
            operationLease!.nonce,
            [
              operationLease!,
              ...(projectLifecycleLease
                ? [projectLifecycleLease]
                : ownedProjectLifecycleLease
                  ? [ownedProjectLifecycleLease]
                  : []),
            ],
          );
        },
        runGitMutation: (args, cwd) => runGitMutationWithSupervisor({
          args,
          cwd,
          leases: [
            operationLease!,
            ...(projectLifecycleLease
              ? [projectLifecycleLease]
              : ownedProjectLifecycleLease
                ? [ownedProjectLifecycleLease]
                : []),
          ].map((lease): GitMutationSupervisorLease => ({
            lockDir: lease.lockDir,
            leaseNonce: lease.nonce,
            preparePendingGitMutation: lease.preparePendingGitMutation,
          })),
        }),
        complete: () => settle(),
        cancel: () => settle(),
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
        async (worktreeLease) => this.rollbackCreatedWorktreeWhileLeased(
          {
            canonicalWorktreePath,
            branchName: job.branchName,
            startingOid: job.startingOid || job.branchOid,
            createdOid: job.branchOid,
            creatorNonce: job.creatorNonce || '',
            mainRepoPath: job.mainRepoPath,
            deleteBranch: job.deleteBranch,
            configProjectRoot: job.configProjectRoot || job.mainRepoPath,
          },
          undefined,
          [projectLifecycleLease, worktreeLease],
        ),
        projectLifecycleLease,
      ),
    );
  }

  private async rollbackCreatedWorktreeWhileLeased(
    identity: CreatedWorktreeIdentity,
    requiredCreatorNonce?: string,
    mutationLeases: readonly MutationLease[] = [],
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
      identity.configProjectRoot,
      identity.mainRepoPath,
      identity.canonicalWorktreePath,
      identity.recoveryId,
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

    const removeResult = await this.runGitCommand(
      ['worktree', 'remove', identity.canonicalWorktreePath],
      identity.mainRepoPath,
      mutationLeases,
    );
    if (!removeResult.success) {
      let outcome: Awaited<ReturnType<WorktreeCleanupService['reportFailedRemoval']>>;
      try {
        outcome = await this.reportFailedRemoval(
          ROLLBACK_MARKER_PANE,
          identity.mainRepoPath,
          identity.mainRepoPath,
          identity.canonicalWorktreePath,
          removeResult,
        );
      } catch (error) {
        return {
          success: false,
          error: `recovery_required: newly created worktree was partially removed and its recovery marker could not be written; preserved remaining files and branch at ${identity.canonicalWorktreePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (outcome === 'unverified') {
        return {
          success: false,
          error: `removal state unverified for newly created worktree ${identity.canonicalWorktreePath}; Git reported failure and its worktree list could not be read; no recovery marker written`,
        };
      }
      if (outcome === 'recovery_required') {
        return {
          success: false,
          error: `recovery_required: removal of newly created worktree ${identity.canonicalWorktreePath} did not leave it intact; preserved remaining files and branch`,
        };
      }
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

    const deleteResult = await this.runGitCommand(
      [
        'update-ref',
        '-d',
        `refs/heads/${identity.branchName}`,
        identity.createdOid,
      ],
      identity.mainRepoPath,
      mutationLeases,
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
          async (rootWorktreeLease) => {
            if (
              !this.canRunDestructiveCleanup(job)
              || !this.haveUnchangedQueuedBranchOids(job)
            ) {
              return false;
            }

            for (const target of job.worktreeTargets) {
              const removeTarget = (worktreeLease: WorktreeOperationLease) => (
                this.removeValidatedWorktreeTarget(
                  job,
                  target,
                  [projectLifecycleLease, worktreeLease],
                )
              );
              const removed = target.canonicalWorktreePath === job.canonicalWorktreePath
                ? await removeTarget(rootWorktreeLease)
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
          await this.withWorktreeLifecycleLock(
            job.canonicalWorktreePath,
            job.mainRepoPath,
            'cleanup',
            async (worktreeLease) => {
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
                [
                  'update-ref',
                  '-d',
                  `refs/heads/${target.branchName}`,
                  target.branchOid,
                ],
                target.repoPath,
                [projectLifecycleLease, worktreeLease],
              );
              if (!deleteBranchResult.success) {
                this.logger.warn(
                  `Branch deletion reported an error for ${job.pane.slug} in ${target.repoPath}: ${deleteBranchResult.error}`,
                  'paneActions',
                  job.pane.id
                );
              }
            }
            },
            projectLifecycleLease,
          );
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
    callback: (lease: WorktreeOperationLease) => Promise<T> | T,
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
          return await callback(lease);
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
      job.currentProjectRoot,
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
    target: QueuedWorktreeIdentity,
    mutationLeases: readonly MutationLease[],
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
      target.repoPath,
      mutationLeases,
    );

    if (!removeResult.success) {
      // Git can fail after it has begun writing. Only a worktree it left whole
      // is "preserved"; anything else must be reported, never retried. The
      // target was verified registered under these leases just before Git ran.
      const outcome = await this.reportFailedRemoval(
        job.pane,
        job.mainRepoPath,
        target.repoPath,
        target.canonicalWorktreePath,
        removeResult,
      );
      if (outcome !== 'preserved') {
        return false;
      }
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

  private inspectWorktreeRemovalState(
    repoPath: string,
    canonicalWorktreePath: string,
    removalObserved = false,
  ): WorktreeRemovalState {
    const registration = this.getWorktreeBranch(repoPath, canonicalWorktreePath);
    return classifyWorktreeRemovalState({
      registered: registration.success ? registration.found === true : undefined,
      directoryPresent: pathEntryPresent(canonicalWorktreePath),
      gitLink: inspectWorktreeGitLink(canonicalWorktreePath, repoPath),
      removalObserved,
    });
  }

  /**
   * After a failed `git worktree remove`, decides whether the ordinary
   * "preserved" report is true. `recovery_required` means a marker was
   * written; `unverified` means the state could not be read and no marker
   * exists; only `preserved` lets the caller report preservation. Throws only
   * when a required recovery marker could not be written; nothing is deleted
   * either way.
   */
  private async reportFailedRemoval(
    pane: { id: string; paneId: string; slug?: string },
    markerProjectRoot: string,
    repoPath: string,
    canonicalWorktreePath: string,
    removeResult: CommandResult,
    removalObserved = true,
  ): Promise<'recovery_required' | 'unverified' | 'preserved'> {
    const state = this.inspectWorktreeRemovalState(
      repoPath,
      canonicalWorktreePath,
      removalObserved,
    );
    if (state === 'unknown') {
      this.logger.warn(
        `Worktree removal state unverified for ${canonicalWorktreePath} (${pane.slug ?? pane.id}): Git reported failure and its worktree list could not be read; nothing further was changed`,
        'paneActions',
        pane.id,
      );
      return 'unverified';
    }
    // `unregistered` here means the path was not registered before Git ran
    // either, so Git had nothing of ours to begin removing: plain preservation.
    if (state !== 'partially_removed') {
      return 'preserved';
    }
    await this.publishPartialRemovalRecovery(
      pane,
      markerProjectRoot,
      canonicalWorktreePath,
      state,
      `git worktree remove ${describeExit(removeResult)} after it began removing a registered worktree`,
    );
    return 'recovery_required';
  }

  /**
   * The recovery state a next attempt should record for one removal target,
   * or undefined. The pane's own worktree gets a marker for any unexplained
   * unregistered directory; a nested target only with positive evidence that
   * its own repository began removing it, so a submodule or a nested checkout
   * that was never one of our worktrees is left alone.
   */
  private nextAttemptRecoveryState(
    target: WorktreeRemovalTarget,
  ): 'partially_removed' | 'unregistered' | undefined {
    const state = this.inspectWorktreeRemovalState(target.repoPath, target.worktreePath);
    if (state === 'partially_removed') return state;
    if (state === 'unregistered' && target.depth === 0) return state;
    return undefined;
  }

  /**
   * Next-attempt half of partial-removal recovery. Runs under the same project
   * and worktree leases a removal would take, so a removal still live in
   * another process is never mistaken for a half-removed tree, and re-reads the
   * state under them. It never mutates Git or the filesystem beyond the marker.
   */
  private async recordPartialRemovalOnNextAttempt(
    job: WorktreeCleanupJob,
    targets: readonly WorktreeRemovalTarget[],
  ): Promise<void> {
    await this.withProjectLifecycleLease(
      job.mainRepoPath,
      targets[0]!.worktreePath,
      'cleanup',
      async (projectLifecycleLease) => {
        for (const target of targets) {
          await this.withWorktreeLifecycleLock(
            target.worktreePath,
            job.mainRepoPath,
            'cleanup',
            async () => {
              const recoveryMarker = findBlockingWorktreeRecoveryMarker(
                job.currentProjectRoot,
                job.mainRepoPath,
                target.worktreePath,
              );
              if (recoveryMarker.blocked) {
                this.logger.warn(
                  `Skipping background worktree cleanup for ${job.pane.slug}: ${recoveryMarker.reason}`,
                  'paneActions',
                  job.pane.id,
                );
                return;
              }
              const state = this.nextAttemptRecoveryState(target);
              if (!state) {
                return;
              }
              await this.publishPartialRemovalRecovery(
                job.pane,
                job.mainRepoPath,
                target.worktreePath,
                state,
                'found on a later cleanup attempt',
              );
            },
            projectLifecycleLease,
          );
        }
      },
    );
    this.logger.debug(
      `Finished background worktree cleanup for ${job.pane.slug}`,
      'paneActions',
      job.pane.id
    );
  }

  /**
   * recovery_required for a worktree path Git no longer fully owns. The marker
   * blocks every later destructive cleanup and reuse of the path until an
   * operator acknowledges it through `psyche recover`; the remaining files and
   * the branch are left exactly as they are. Only a state with positive
   * evidence of a removal carries advice to remove the directory.
   */
  private async publishPartialRemovalRecovery(
    pane: { id: string; paneId: string; slug?: string },
    projectRoot: string,
    canonicalWorktreePath: string,
    state: 'partially_removed' | 'unregistered',
    detail: string,
  ): Promise<void> {
    const reason = state === 'partially_removed'
      ? `worktree partially removed; ${detail}. Remaining files and the branch were preserved. `
        + 'Inspect what remains, copy anything needed, then remove or restore the directory '
        + 'before acknowledging.'
      : `unregistered directory at pane path; ${detail}. Git does not list it as a worktree `
        + 'of this repository and there is no evidence a removal ran. Nothing was changed; '
        + 'verify before acknowledging.';
    const { marker } = await writeWorktreeRecoveryMarker({
      projectRoot,
      worktreePath: canonicalWorktreePath,
      pane: { id: pane.id, paneId: pane.paneId },
      operation: 'cleanup',
      reason,
    });
    this.logger.warn(
      `recovery_required: ${canonicalWorktreePath} for ${pane.slug ?? pane.id} is ${state.replace('_', ' ')}; `
        + `preserved remaining files and branch; recovery marker ${marker.id} requires operator acknowledgement`,
      'paneActions',
      pane.id,
    );
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

    // Discovery asks Git about each nested checkout, so a nested worktree an
    // interrupted removal left with a link to its repository's deleted admin
    // entry is invisible to it. Keep those as targets: capture then refuses
    // the whole cleanup (Git does not register them) and the next-attempt
    // check reclassifies each one, instead of the root being removed around
    // a half-removed child nobody recorded.
    const known = new Set(Array.from(targets.values(), (target) => target.worktreePath));
    for (const orphan of findOrphanedNestedWorktreeLinks(pane.worktreePath)) {
      if (!known.has(canonicalizePathWithExistingAncestor(orphan.worktreePath))) {
        addTarget(orphan.repoPath, orphan.worktreePath, orphan.depth);
      }
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
            async (worktreeLease) => {
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
                job.configPath
                  ? path.dirname(path.dirname(job.configPath))
                  : job.projectRoot,
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

              const registeredBefore = this.getWorktreeBranch(
                job.projectRoot,
                target.canonicalWorktreePath,
              );
              const removeResult = await this.runGitCommand(
                ['worktree', 'remove', target.canonicalWorktreePath],
                job.projectRoot,
                [projectLifecycleLease, worktreeLease],
              );

              if (!removeResult.success) {
                let outcome: Awaited<ReturnType<WorktreeCleanupService['reportFailedRemoval']>>;
                try {
                  outcome = await this.reportFailedRemoval(
                    PRUNE_MARKER_PANE,
                    job.projectRoot,
                    job.projectRoot,
                    target.canonicalWorktreePath,
                    removeResult,
                    registeredBefore.success && registeredBefore.found === true,
                  );
                } catch (error) {
                  this.logger.error(
                    `Managed worktree pruning left ${target.canonicalWorktreePath} partially removed and could not record recovery_required: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                    'paneActions',
                  );
                  return;
                }
                if (outcome !== 'preserved') {
                  return;
                }
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

  private runGitCommand(
    args: string[],
    cwd: string,
    mutationLeases: readonly MutationLease[] = [],
  ): Promise<CommandResult> {
    const uniqueMutationLeases = Array.from(new Set(mutationLeases));
    const supervisedLeases = uniqueMutationLeases
      .filter((lease) => (
        typeof lease.preparePendingGitMutation === 'function'
        && typeof lease.lockDir === 'string'
        && typeof lease.nonce === 'string'
      ))
      .map((lease): GitMutationSupervisorLease => ({
        lockDir: lease.lockDir,
        leaseNonce: lease.nonce,
        preparePendingGitMutation: lease.preparePendingGitMutation,
      }));

    // Real lifecycle leases always expose the pending-mutation protocol. The
    // direct-child fallback keeps legacy/injected test leases usable while
    // never weakening production cleanup, prune, rollback, or branch delete.
    if (
      supervisedLeases.length === uniqueMutationLeases.length
      && supervisedLeases.every(isGitMutationSupervisorLease)
    ) {
      return runGitMutationWithSupervisor({
        args,
        cwd,
        leases: supervisedLeases,
      }).then((result) => (
        result.exitCode === 0
          ? { success: true }
          : {
            success: false,
            exitCode: result.exitCode,
            error: result.stderr
              || `git ${args.join(' ')} failed with exit code ${
                result.exitCode ?? 'unknown'
              }`,
          }
      )).catch((error) => ({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }

    return new Promise((resolve) => {
      const child = spawn('git', args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let stderr = '';
      let childError: Error | undefined;
      let childTrackingError: Error | undefined;
      const trackedLeases = Array.from(
        new Set(uniqueMutationLeases.filter((lease): lease is MutationLease => (
          typeof lease.trackChildProcess === 'function'
          && typeof lease.clearChildProcess === 'function'
        ))),
      );
      let trackedChildren: Array<{
        lease: MutationLease;
        child: Awaited<ReturnType<MutationLease['trackChildProcess']>>;
      }> = [];

      // A destructive Git child is made visible in every filesystem lease
      // before this function waits for it. If the owner dies during the
      // mutation, a contender can therefore retain the lease until the child
      // exits (or its process-start identity proves the PID was reused).
      const tracking = Promise.all(trackedLeases.map(async (lease) => ({
        lease,
        child: await lease.trackChildProcess(child.pid || 0),
      }))).then((children) => {
        trackedChildren = children;
      }).catch((error) => {
        childTrackingError = error instanceof Error ? error : new Error(String(error));
        try {
          child.kill();
        } catch {
          // The close handler below remains the authority for clearing any
          // child metadata that was successfully registered.
        }
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('error', (error: Error) => {
        childError = error;
      });

      child.on('close', async (code: number | null) => {
        await tracking;
        try {
          await Promise.all(trackedChildren.map(({ lease, child: trackedChild }) => (
            lease.clearChildProcess(trackedChild)
          )));
        } catch (error) {
          resolve({
            success: false,
            error: `could not clear destructive Git child lease metadata: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          return;
        }

        if (childTrackingError) {
          resolve({
            success: false,
            error: childTrackingError.message,
          });
          return;
        }
        if (childError) {
          resolve({
            success: false,
            error: childError.message,
          });
          return;
        }
        if (code === 0) {
          resolve({ success: true });
          return;
        }

        resolve({
          success: false,
          exitCode: code,
          error:
            stderr.trim() ||
            `git ${args.join(' ')} failed with exit code ${code ?? 'unknown'}`,
        });
      });
    });
  }
}

async function waitForRecoveryMarkerAcknowledgement(
  markerPath: string,
): Promise<void> {
  while (existsSync(markerPath)) {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 50);
      timeout.unref?.();
    });
  }
}

async function waitForSettlementRetry(attempt: number): Promise<void> {
  const delay = Math.min(50 * (2 ** Math.min(attempt - 1, 7)), 5_000);
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, delay);
    timeout.unref?.();
  });
}

function shouldLogSettlementRetry(attempt: number): boolean {
  return attempt <= 3 || (attempt & (attempt - 1)) === 0;
}
