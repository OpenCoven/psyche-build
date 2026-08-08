import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { canonicalizePathWithExistingAncestor } from './WorktreePath.js';
import {
  getProcessStartIdentity,
  isProcessAlive,
  isSafeProcessStartIdentity,
  type ProcessStartIdentityResolver,
} from './ProcessIdentity.js';

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_TIMEOUT_MS = 30_000;
const LEASE_FILE_NAME = 'lease.json';
const CHILD_LEASE_FILE_PREFIX = 'child.';

export interface WorktreeOperationLeaseRecord {
  pid: number;
  processStartIdentity?: string;
  /**
   * Effective destructive-child metadata loaded from the nonce-addressed
   * companion record. Both values move together so a reused PID can never
   * keep a stale lease alive.
   */
  childPid?: number;
  childProcessStartIdentity?: string;
  nonce: string;
  canonicalPath: string;
  operation: string;
  acquiredAt: string;
  /**
   * The owner called release while a tracked destructive mutation was still
   * live. Once every tracked mutation identity is gone, the original owner
   * must no longer keep this exact lease from being reclaimed.
   */
  releaseRequested?: boolean;
  /**
   * Written before a separate Git mutation supervisor is spawned. A dead
   * caller must not make this lease stealable during the supervisor's launch
   * window, and a claimed supervisor remains independently verifiable.
   */
  pendingMutation?: PendingGitMutation;
}

export interface LeaseChildProcess {
  pid: number;
  processStartIdentity: string;
}

export interface PendingGitMutation {
  nonce: string;
  deadline: string;
  supervisorPid?: number;
  supervisorProcessStartIdentity?: string;
  claimedAt?: string;
  /**
   * A supervisor that could not confirm its detached Git process group exited
   * leaves this durable diagnostic behind. The pending claim remains live
   * until normal stale-owner recovery can prove every process is gone.
   */
  terminationUnconfirmedAt?: string;
  terminationFailure?: string;
}

export interface PendingGitMutationRequest {
  nonce: string;
  deadline: string;
}

export interface PendingGitMutationLeaseRef {
  lockDir: string;
  leaseNonce: string;
}

interface LeaseProcessTracker {
  /**
   * Records a destructive child before callers wait for its completion.
   * The caller must clear this only from the child's close handler.
   */
  trackChildProcess: (pid: number) => Promise<LeaseChildProcess>;
  clearChildProcess: (child: LeaseChildProcess) => Promise<void>;
  /**
   * Makes an impending supervised Git mutation durable before the helper
   * process exists. The pending deadline closes the parent-death launch gap.
   */
  preparePendingGitMutation: (
    request: PendingGitMutationRequest,
  ) => Promise<void>;
}

export interface WorktreeOperationLeaseRequest {
  worktreePath: string;
  /**
   * The main repository that owns the worktree. This is used only when the
   * worktree can no longer be inspected as a Git worktree.
   */
  projectRoot?: string;
  operation: string;
}

export interface WorktreeOperationLease extends LeaseProcessTracker {
  canonicalProjectRoot: string;
  canonicalWorktreePath: string;
  lockDir: string;
  nonce: string;
  release: () => Promise<void>;
}

/**
 * Serializes every lifecycle mutation for one Psyche project.
 *
 * Exact-path leases protect a single worktree. They cannot protect a root
 * worktree and a child-repository worktree from each other because those paths
 * deliberately have different lock keys. Callers acquire this lease first,
 * then any exact-path leases, to make those compound workspace mutations safe.
 */
export interface ProjectWorktreeLifecycleLease extends LeaseProcessTracker {
  canonicalProjectRoot: string;
  lockDir: string;
  nonce: string;
  release: () => Promise<void>;
}

export interface ProjectWorktreeLifecycleLeaseRequest {
  /**
   * Main project root when it is already known. This is preferred for nested
   * repositories so their lifecycle mutations share the root project's lease.
   */
  projectRoot?: string;
  /**
   * Used to discover the main project root for legacy callers that only know
   * a worktree path.
   */
  worktreePath?: string;
  operation: string;
}

export interface WorktreeOperationLeaseOptions {
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  /**
   * Returns a stable process-start identity for a live PID. An unavailable
   * identity is intentionally treated as uncertain, never stale.
   */
  getProcessStartIdentity?: ProcessStartIdentityResolver;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  now?: () => Date;
  createNonce?: () => string;
}

interface LeasePaths {
  canonicalProjectRoot: string;
  canonicalWorktreePath: string;
  locksDir: string;
  lockDir: string;
  lockKey: string;
}

interface ProjectLifecycleLeasePaths {
  canonicalProjectRoot: string;
  runtimeDir: string;
  lockDir: string;
}

interface LockReadResult {
  record?: WorktreeOperationLeaseRecord;
  missing: boolean;
}

interface ChildLeaseRecord {
  nonce: string;
  pid: number;
  processStartIdentity: string;
}

interface ChildLeaseReadResult {
  child?: LeaseChildProcess;
  missing: boolean;
  invalid: boolean;
}

const PROJECT_LIFECYCLE_LOCK_DIRECTORY_NAME = 'project-worktree-lifecycle.lock';

/**
 * Acquires an exclusive, filesystem-backed lease for a single worktree.
 *
 * The lock directory is rooted in the main project's runtime state rather
 * than the target worktree, so deleting the worktree cannot delete its lease.
 */
export async function acquireWorktreeOperationLease(
  request: WorktreeOperationLeaseRequest,
  options: WorktreeOperationLeaseOptions = {},
): Promise<WorktreeOperationLease> {
  if (!request.operation.trim()) {
    throw new Error('A worktree operation lease requires an operation name');
  }


  const paths = await resolveLeasePaths(request);
  const pid = options.pid ?? process.pid;
  const isOwnerProcessAlive = options.isProcessAlive ?? isProcessAlive;
  const resolveProcessStartIdentity = options.getProcessStartIdentity ?? getProcessStartIdentity;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const createNonce = options.createNonce ?? randomUUID;

  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('worktree operation lease pollIntervalMs must be greater than zero');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('worktree operation lease timeoutMs must not be negative');
  }

  await mkdir(paths.locksDir, { recursive: true });

  const nonce = createNonce();
  if (!isSafeNonce(nonce)) {
    throw new Error('worktree operation lease nonce contains unsupported characters');
  }

  const resolvedProcessStartIdentity = resolveProcessStartIdentity(pid);
  const processStartIdentity = isSafeProcessStartIdentity(resolvedProcessStartIdentity)
    ? resolvedProcessStartIdentity
    : undefined;
  const record: WorktreeOperationLeaseRecord = {
    pid,
    ...(processStartIdentity
      ? { processStartIdentity }
      : {}),
    nonce,
    canonicalPath: paths.canonicalWorktreePath,
    operation: request.operation,
    acquiredAt: now().toISOString(),
  };
  const candidateDir = path.join(
    paths.locksDir,
    `${paths.lockKey}.candidate.${nonce}`,
  );
  const candidateRecordPath = path.join(candidateDir, LEASE_FILE_NAME);
  const deadline = now().getTime() + timeoutMs;
  let acquired = false;
  let lastWaitReason = 'another worktree operation is in progress';

  try {
    await mkdir(candidateDir);
    await writeLeaseRecord(candidateRecordPath, record);

    while (true) {
      try {
        await rename(candidateDir, paths.lockDir);
        acquired = true;
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') {
          throw error;
        }
      }

      const current = await readLeaseRecord(paths.lockDir);
      if (current.record) {
        if (isLeaseOwnerStale(
          current.record,
          isOwnerProcessAlive,
          resolveProcessStartIdentity,
          now(),
        )) {
          const quarantined = await quarantineDeadLease(
            paths,
            current.record,
            isOwnerProcessAlive,
            resolveProcessStartIdentity,
            now,
          );
          if (quarantined) {
            continue;
          }
          lastWaitReason = `stale lease recovery is in progress for pid ${current.record.pid}`;
        } else {
          lastWaitReason = `lease is held by live or unverifiable pid ${current.record.pid}`;
        }
      } else if (current.missing) {
        lastWaitReason = 'lease was released while waiting';
      } else {
        // A lock without valid owner metadata must not be removed: its creator
        // may still be live, and a malformed lock has no PID to verify.
        lastWaitReason = 'lease metadata is unavailable or invalid';
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Timed out waiting for worktree operation lease for ${paths.canonicalWorktreePath}: ${lastWaitReason}`,
        );
      }
      await sleep(Math.min(pollIntervalMs, remainingMs));
    }
  } finally {
    if (!acquired) {
      await rm(candidateDir, { recursive: true, force: true });
    }
  }

  return {
    canonicalProjectRoot: paths.canonicalProjectRoot,
    canonicalWorktreePath: paths.canonicalWorktreePath,
    lockDir: paths.lockDir,
    nonce,
    ...createLeaseProcessTracker(
      paths.lockDir,
      nonce,
      resolveProcessStartIdentity,
      now,
    ),
    release: async () => {
      await releaseOwnedLease(
        paths.lockDir,
        nonce,
        isOwnerProcessAlive,
        resolveProcessStartIdentity,
      );
    },
  };
}


/**
 * Acquires the project-wide lifecycle lease before a caller takes any
 * worktree-specific lease. The lock is rooted outside managed worktrees, so
 * an in-flight removal cannot remove its own coordination state.
 */
export async function acquireProjectWorktreeLifecycleLease(
  request: ProjectWorktreeLifecycleLeaseRequest,
  options: WorktreeOperationLeaseOptions = {},
): Promise<ProjectWorktreeLifecycleLease> {
  if (!request.operation.trim()) {
    throw new Error('A project worktree lifecycle lease requires an operation name');
  }

  const paths = await resolveProjectLifecycleLeasePaths(request);
  const pid = options.pid ?? process.pid;
  const isOwnerProcessAlive = options.isProcessAlive ?? isProcessAlive;
  const resolveProcessStartIdentity = options.getProcessStartIdentity ?? getProcessStartIdentity;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const createNonce = options.createNonce ?? randomUUID;

  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('project worktree lifecycle lease pollIntervalMs must be greater than zero');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('project worktree lifecycle lease timeoutMs must not be negative');
  }

  await mkdir(paths.runtimeDir, { recursive: true });
  const nonce = createNonce();
  if (!isSafeNonce(nonce)) {
    throw new Error('project worktree lifecycle lease nonce contains unsupported characters');
  }

  const resolvedProcessStartIdentity = resolveProcessStartIdentity(pid);
  const processStartIdentity = isSafeProcessStartIdentity(resolvedProcessStartIdentity)
    ? resolvedProcessStartIdentity
    : undefined;
  const record: WorktreeOperationLeaseRecord = {
    pid,
    ...(processStartIdentity ? { processStartIdentity } : {}),
    nonce,
    canonicalPath: paths.canonicalProjectRoot,
    operation: request.operation,
    acquiredAt: now().toISOString(),
  };
  const candidateDir = path.join(
    paths.runtimeDir,
    `${PROJECT_LIFECYCLE_LOCK_DIRECTORY_NAME}.candidate.${nonce}`,
  );
  const candidateRecordPath = path.join(candidateDir, LEASE_FILE_NAME);
  const deadline = now().getTime() + timeoutMs;
  let acquired = false;
  let lastWaitReason = 'another project worktree lifecycle mutation is in progress';

  try {
    await mkdir(candidateDir);
    await writeLeaseRecord(candidateRecordPath, record);

    while (true) {
      try {
        await rename(candidateDir, paths.lockDir);
        acquired = true;
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') {
          throw error;
        }
      }

      const current = await readLeaseRecord(paths.lockDir);
      if (current.record) {
        if (isLeaseOwnerStale(
          current.record,
          isOwnerProcessAlive,
          resolveProcessStartIdentity,
          now(),
        )) {
          if (await quarantineProjectLifecycleLease(
            paths,
            current.record,
            isOwnerProcessAlive,
            resolveProcessStartIdentity,
            now,
          )) {
            continue;
          }
          lastWaitReason = `stale lifecycle lease recovery is in progress for pid ${current.record.pid}`;
        } else {
          lastWaitReason = `lifecycle lease is held by live or unverifiable pid ${current.record.pid}`;
        }
      } else if (current.missing) {
        lastWaitReason = 'lifecycle lease was released while waiting';
      } else {
        lastWaitReason = 'lifecycle lease metadata is unavailable or invalid';
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Timed out waiting for project worktree lifecycle lease for ${paths.canonicalProjectRoot}: ${lastWaitReason}`,
        );
      }
      await sleep(Math.min(pollIntervalMs, remainingMs));
    }
  } finally {
    if (!acquired) {
      await rm(candidateDir, { recursive: true, force: true });
    }
  }

  return {
    canonicalProjectRoot: paths.canonicalProjectRoot,
    lockDir: paths.lockDir,
    nonce,
    ...createLeaseProcessTracker(
      paths.lockDir,
      nonce,
      resolveProcessStartIdentity,
      now,
    ),
    release: async () => {
      await releaseOwnedLease(
        paths.lockDir,
        nonce,
        isOwnerProcessAlive,
        resolveProcessStartIdentity,
      );
    },
  };
}

async function resolveLeasePaths(
  request: WorktreeOperationLeaseRequest,
): Promise<LeasePaths> {
  const canonicalWorktreePath = canonicalizePathWithExistingAncestor(request.worktreePath);
  const discoveredProjectRoot = await discoverMainProjectRoot(canonicalWorktreePath);
  const canonicalProjectRoot = discoveredProjectRoot
    ?? (
      request.projectRoot
        ? canonicalizePathWithExistingAncestor(request.projectRoot)
        : undefined
    );

  if (!canonicalProjectRoot) {
    throw new Error(
      `Could not resolve a main project root for worktree operation lease: ${canonicalWorktreePath}`,
    );
  }


  const runtimeDir = canonicalizePathWithExistingAncestor(
    path.join(canonicalProjectRoot, '.psyche', 'runtime'),
  );
  if (isPathWithin(runtimeDir, canonicalWorktreePath)) {
    throw new Error(
      `Refusing to store a worktree operation lease inside its target worktree: ${canonicalWorktreePath}`,
    );
  }

  const lockKey = createHash('sha256')
    .update(canonicalWorktreePath)
    .digest('hex');
  const locksDir = path.join(runtimeDir, 'worktree-locks');

  return {
    canonicalProjectRoot,
    canonicalWorktreePath,
    locksDir,
    lockDir: path.join(locksDir, `${lockKey}.lock`),
    lockKey,
  };
}


async function resolveProjectLifecycleLeasePaths(
  request: ProjectWorktreeLifecycleLeaseRequest,
): Promise<ProjectLifecycleLeasePaths> {
  const canonicalProjectRoot = request.projectRoot
    ? canonicalizePathWithExistingAncestor(request.projectRoot)
    : request.worktreePath
      ? await discoverMainProjectRoot(
        canonicalizePathWithExistingAncestor(request.worktreePath),
      )
      : undefined;

  if (!canonicalProjectRoot) {
    throw new Error(
      'Could not resolve a main project root for project worktree lifecycle lease',
    );
  }

  const runtimeDir = path.join(canonicalProjectRoot, '.psyche', 'runtime');
  return {
    canonicalProjectRoot,
    runtimeDir,
    lockDir: path.join(runtimeDir, PROJECT_LIFECYCLE_LOCK_DIRECTORY_NAME),
  };
}

async function discoverMainProjectRoot(worktreePath: string): Promise<string | undefined> {
  let commonGitDir: string;
  try {
    commonGitDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
  } catch {
    return undefined;
  }

  const root = projectRootFromCommonGitDir(commonGitDir);
  return root ? canonicalizePathWithExistingAncestor(root) : undefined;
}

function projectRootFromCommonGitDir(commonGitDir: string): string | undefined {
  if (!path.isAbsolute(commonGitDir)) {
    return undefined;
  }

  const segments = commonGitDir.split(path.sep);
  const gitDirectoryIndex = segments.lastIndexOf('.git');
  if (gitDirectoryIndex <= 0) {
    return undefined;
  }

  const prefix = segments.slice(0, gitDirectoryIndex).join(path.sep);
  return prefix || path.parse(commonGitDir).root;
}

function isPathWithin(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

async function writeLeaseRecord(
  recordPath: string,
  record: WorktreeOperationLeaseRecord,
): Promise<void> {
  const handle = await open(recordPath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeChildLeaseRecord(
  recordPath: string,
  record: ChildLeaseRecord,
): Promise<void> {
  const handle = await open(recordPath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLeaseRecord(lockDir: string): Promise<LockReadResult> {
  try {
    const raw = await readFile(path.join(lockDir, LEASE_FILE_NAME), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isLeaseRecord(parsed)) {
      return { record: undefined, missing: false };
    }
    const child = await readChildLeaseRecord(lockDir, parsed.nonce);
    if (child.invalid) {
      // A child file that cannot be verified is intentionally a live/unknown
      // mutation. Do not let a contender steal the lease.
      return { record: undefined, missing: false };
    }
    return {
      record: child.child
        ? {
          ...parsed,
          childPid: child.child.pid,
          childProcessStartIdentity: child.child.processStartIdentity,
        }
        : parsed,
      missing: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { missing: true };
    }
    if (error instanceof SyntaxError) {
      return { missing: false };
    }
    throw error;
  }
}

async function readRawLeaseRecord(lockDir: string): Promise<LockReadResult> {
  try {
    const raw = await readFile(path.join(lockDir, LEASE_FILE_NAME), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return {
      record: isLeaseRecord(parsed) ? parsed : undefined,
      missing: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { missing: true };
    }
    if (error instanceof SyntaxError) {
      return { missing: false };
    }
    throw error;
  }
}

/**
 * Updates lease.json by atomic replacement after verifying the immutable
 * nonce. A stale owner can only ever update its own quarantined directory,
 * never a replacement lease at the active path.
 */
async function updateOwnedLeaseRecord(
  lockDir: string,
  nonce: string,
  mutation: (record: WorktreeOperationLeaseRecord) => WorktreeOperationLeaseRecord,
): Promise<void> {
  const current = await readRawLeaseRecord(lockDir);
  if (!current.record || current.record.nonce !== nonce) {
    throw new Error('Worktree lease ownership changed');
  }

  const next = mutation(current.record);
  if (next.nonce !== nonce) {
    throw new Error('Worktree lease mutation cannot change its ownership nonce');
  }

  const recordPath = path.join(lockDir, LEASE_FILE_NAME);
  const temporaryPath = path.join(
    lockDir,
    `${LEASE_FILE_NAME}.${nonce}.${randomUUID()}.update`,
  );
  try {
    await writeLeaseRecord(temporaryPath, next);
    await rename(temporaryPath, recordPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function isLeaseOwnershipGoneError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Worktree lease ownership changed';
}

function childLeaseRecordPath(lockDir: string, nonce: string): string {
  return path.join(lockDir, `${CHILD_LEASE_FILE_PREFIX}${nonce}.json`);
}

async function readChildLeaseRecord(
  lockDir: string,
  nonce: string,
): Promise<ChildLeaseReadResult> {
  try {
    const raw = await readFile(childLeaseRecordPath(lockDir, nonce), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isChildLeaseRecord(parsed) || parsed.nonce !== nonce) {
      return { missing: false, invalid: true };
    }
    return {
      child: {
        pid: parsed.pid,
        processStartIdentity: parsed.processStartIdentity,
      },
      missing: false,
      invalid: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { missing: true, invalid: false };
    }
    return { missing: false, invalid: true };
  }
}

async function quarantineDeadLease(
  paths: LeasePaths,
  record: WorktreeOperationLeaseRecord,
  isOwnerProcessAlive: (pid: number) => boolean,
  resolveProcessStartIdentity: ProcessStartIdentityResolver,
  now: () => Date,
): Promise<boolean> {
  // Check immediately before the atomic move. A live lease is never moved.
  if (!isLeaseOwnerStale(record, isOwnerProcessAlive, resolveProcessStartIdentity, now())) {
    return false;
  }


  // Keeping the nonce-specific quarantine directory prevents a delayed stale
  // contender from ever renaming a later live lease into this old quarantine.
  const quarantineDir = path.join(
    paths.locksDir,
    `${paths.lockKey}.stale.${record.nonce}`,
  );
  try {
    await rename(paths.lockDir, quarantineDir);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') {
      return false;
    }
    throw error;
  }
}


async function quarantineProjectLifecycleLease(
  paths: ProjectLifecycleLeasePaths,
  record: WorktreeOperationLeaseRecord,
  isOwnerProcessAlive: (pid: number) => boolean,
  resolveProcessStartIdentity: ProcessStartIdentityResolver,
  now: () => Date,
): Promise<boolean> {
  if (!isLeaseOwnerStale(record, isOwnerProcessAlive, resolveProcessStartIdentity, now())) {
    return false;
  }

  const quarantineDir = path.join(
    paths.runtimeDir,
    `${PROJECT_LIFECYCLE_LOCK_DIRECTORY_NAME}.stale.${record.nonce}`,
  );
  try {
    await rename(paths.lockDir, quarantineDir);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') {
      return false;
    }
    throw error;
  }
}

function createLeaseProcessTracker(
  lockDir: string,
  nonce: string,
  resolveProcessStartIdentity: ProcessStartIdentityResolver,
  now: () => Date,
): LeaseProcessTracker {
  return {
    trackChildProcess: async (pid: number): Promise<LeaseChildProcess> => {
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error('Cannot track a destructive Git child without a valid PID');
      }

      const processStartIdentity = resolveProcessStartIdentity(pid);
      if (!isSafeProcessStartIdentity(processStartIdentity)) {
        throw new Error(
          `Cannot track destructive Git child ${pid}: process-start identity is unavailable`,
        );
      }

      const child = { pid, processStartIdentity };
      const current = await readLeaseRecord(lockDir);
      if (!current.record || current.record.nonce !== nonce) {
        throw new Error(
          'Cannot track destructive Git child because worktree lease ownership changed',
        );
      }
      await replaceChildLeaseRecord(lockDir, nonce, child);
      return child;
    },
    clearChildProcess: async (child: LeaseChildProcess): Promise<void> => {
      const current = await readLeaseRecord(lockDir);
      if (
        !current.record
        || current.record.nonce !== nonce
        || current.record.childPid !== child.pid
        || current.record.childProcessStartIdentity !== child.processStartIdentity
      ) {
        return;
      }
      await rm(childLeaseRecordPath(lockDir, nonce), { force: true });
    },
    preparePendingGitMutation: async (
      request: PendingGitMutationRequest,
    ): Promise<void> => {
      await preparePendingGitMutationLease(
        { lockDir, leaseNonce: nonce },
        request,
        now,
      );
    },
  };
}

/**
 * Records a pending supervised mutation before the child process is spawned.
 * This state is deliberately part of lease.json: if the caller dies between
 * persistence and the supervisor's claim, recovery waits for the deadline
 * instead of treating the otherwise-dead parent as authorization to steal.
 */
async function preparePendingGitMutationLease(
  lease: PendingGitMutationLeaseRef,
  request: PendingGitMutationRequest,
  now: () => Date,
): Promise<void> {
  if (!isSafeNonce(request.nonce)) {
    throw new Error('Pending Git mutation nonce contains unsupported characters');
  }
  if (!isFutureOrPresentTimestamp(request.deadline, now())) {
    throw new Error('Pending Git mutation deadline must be a valid future timestamp');
  }

  await updateOwnedLeaseRecord(lease.lockDir, lease.leaseNonce, (record) => {
    const pending = record.pendingMutation;
    if (pending && pending.nonce !== request.nonce) {
      throw new Error('A different Git mutation is already pending on this lease');
    }
    return {
      ...record,
      pendingMutation: {
        nonce: request.nonce,
        deadline: request.deadline,
      },
    };
  });
}

export interface ClaimPendingGitMutationLeaseRequest {
  mutationNonce: string;
  pid?: number;
  processStartIdentity?: string;
  now?: () => Date;
}

/**
 * The supervisor's first durable action. It associates its canonical process
 * identity with the exact pending mutation before it starts Git, making a
 * live helper sufficient to retain a lease even after its parent disappears.
 */
export async function claimPendingGitMutationLease(
  lease: PendingGitMutationLeaseRef,
  request: ClaimPendingGitMutationLeaseRequest,
): Promise<LeaseChildProcess> {
  const pid = request.pid ?? process.pid;
  const processStartIdentity = request.processStartIdentity
    ?? getProcessStartIdentity(pid);
  if (!Number.isInteger(pid) || pid <= 0 || !isSafeProcessStartIdentity(processStartIdentity)) {
    throw new Error('Cannot claim pending Git mutation without a canonical supervisor identity');
  }
  if (!isSafeNonce(request.mutationNonce)) {
    throw new Error('Pending Git mutation nonce contains unsupported characters');
  }

  const now = request.now ?? (() => new Date());
  await updateOwnedLeaseRecord(lease.lockDir, lease.leaseNonce, (record) => {
    const pending = record.pendingMutation;
    if (!pending || pending.nonce !== request.mutationNonce) {
      throw new Error('Pending Git mutation no longer belongs to this supervisor');
    }
    if (
      pending.supervisorPid !== undefined
      && (
        pending.supervisorPid !== pid
        || pending.supervisorProcessStartIdentity !== processStartIdentity
      )
    ) {
      throw new Error('Pending Git mutation is already claimed by another supervisor');
    }
    return {
      ...record,
      pendingMutation: {
        ...pending,
        supervisorPid: pid,
        supervisorProcessStartIdentity: processStartIdentity,
        claimedAt: now().toISOString(),
      },
    };
  });

  return { pid, processStartIdentity };
}

export interface TrackPendingGitMutationChildLeaseRequest {
  mutationNonce: string;
  supervisor: LeaseChildProcess;
  pid: number;
  processStartIdentity?: string;
}

/**
 * Records the actual detached Git process while it is stopped before its
 * first instruction can run. The supervisor remains in pendingMutation; the
 * nonce-addressed child record intentionally names Git, not its supervisor,
 * so a supervisor crash cannot make a live hook-bearing Git command stale.
 */
export async function trackPendingGitMutationChildLease(
  lease: PendingGitMutationLeaseRef,
  request: TrackPendingGitMutationChildLeaseRequest,
): Promise<LeaseChildProcess> {
  if (!isSafeNonce(request.mutationNonce)) {
    throw new Error('Pending Git mutation nonce contains unsupported characters');
  }
  if (
    !Number.isInteger(request.pid)
    || request.pid <= 0
    || !isSafeProcessStartIdentity(request.supervisor.processStartIdentity)
  ) {
    throw new Error('Cannot track pending Git mutation without valid process identities');
  }

  const processStartIdentity = request.processStartIdentity
    ?? getProcessStartIdentity(request.pid);
  if (!isSafeProcessStartIdentity(processStartIdentity)) {
    throw new Error(
      `Cannot track destructive Git child ${request.pid}: process-start identity is unavailable`,
    );
  }

  await updateOwnedLeaseRecord(lease.lockDir, lease.leaseNonce, (record) => {
    const pending = record.pendingMutation;
    if (
      !pending
      || pending.nonce !== request.mutationNonce
      || pending.supervisorPid !== request.supervisor.pid
      || pending.supervisorProcessStartIdentity !== request.supervisor.processStartIdentity
    ) {
      throw new Error('Pending Git mutation no longer belongs to this supervisor');
    }
    return record;
  });

  const child = { pid: request.pid, processStartIdentity };
  await replaceChildLeaseRecord(lease.lockDir, lease.leaseNonce, child);
  return child;
}

/**
 * Removes only the exact Git child companion record after its close event.
 * An old supervisor cannot erase a replacement lease or another child.
 */
export async function clearPendingGitMutationChildLease(
  lease: PendingGitMutationLeaseRef,
  child: LeaseChildProcess,
): Promise<void> {
  const current = await readLeaseRecord(lease.lockDir);
  if (
    !current.record
    || current.record.nonce !== lease.leaseNonce
    || current.record.childPid !== child.pid
    || current.record.childProcessStartIdentity !== child.processStartIdentity
  ) {
    return;
  }
  await rm(childLeaseRecordPath(lease.lockDir, lease.leaseNonce), { force: true });
}

export interface RetainPendingGitMutationLeaseRequest {
  mutationNonce: string;
  supervisor: LeaseChildProcess;
  reason: string;
  now?: () => Date;
}

/**
 * Marks a failed detached-group termination without clearing ownership. This
 * gives operators a durable explanation while normal liveness recovery still
 * waits for the actual Git PID to disappear.
 */
export async function retainPendingGitMutationLease(
  lease: PendingGitMutationLeaseRef,
  request: RetainPendingGitMutationLeaseRequest,
): Promise<void> {
  if (!isSafeNonce(request.mutationNonce)) {
    return;
  }
  const reason = request.reason.replace(/[\r\n\0]/g, ' ').slice(0, 1_024);
  const now = request.now ?? (() => new Date());
  try {
    await updateOwnedLeaseRecord(lease.lockDir, lease.leaseNonce, (record) => {
      const pending = record.pendingMutation;
      if (
        !pending
        || pending.nonce !== request.mutationNonce
        || pending.supervisorPid !== request.supervisor.pid
        || pending.supervisorProcessStartIdentity !== request.supervisor.processStartIdentity
      ) {
        return record;
      }
      return {
        ...record,
        pendingMutation: {
          ...pending,
          terminationUnconfirmedAt: now().toISOString(),
          terminationFailure: reason || 'Could not confirm Git process group termination',
        },
      };
    });
  } catch (error) {
    if (!isLeaseOwnershipGoneError(error)) {
      throw error;
    }
  }
}

export interface ClearPendingGitMutationLeaseRequest {
  mutationNonce: string;
  supervisor?: LeaseChildProcess;
}

/**
 * Clears supervisor ownership only after the Git child has exited. When the
 * supervisor crashed, this intentionally leaves the pending record behind
 * until its deadline so a contender cannot race an uncertain launch.
 */
export async function clearPendingGitMutationLease(
  lease: PendingGitMutationLeaseRef,
  request: ClearPendingGitMutationLeaseRequest,
): Promise<void> {
  if (!isSafeNonce(request.mutationNonce)) {
    return;
  }

  try {
    await updateOwnedLeaseRecord(lease.lockDir, lease.leaseNonce, (record) => {
      const pending = record.pendingMutation;
      if (!pending || pending.nonce !== request.mutationNonce) {
        return record;
      }
      if (!request.supervisor && pending.supervisorPid !== undefined) {
        return record;
      }
      if (
        request.supervisor
        && (
          pending.supervisorPid !== request.supervisor.pid
          || pending.supervisorProcessStartIdentity
            !== request.supervisor.processStartIdentity
        )
      ) {
        return record;
      }
      const next = { ...record };
      delete next.pendingMutation;
      return next;
    });
  } catch (error) {
    if (!isLeaseOwnershipGoneError(error)) {
      throw error;
    }
    return;
  }

}

/**
 * Clears only a pending mutation which was never claimed. This is used when
 * fork itself fails; it cannot erase a helper that claimed before its IPC
 * status reached the parent.
 */
export async function clearUnclaimedPendingGitMutationLease(
  lease: PendingGitMutationLeaseRef,
  mutationNonce: string,
): Promise<void> {
  await clearPendingGitMutationLease(lease, { mutationNonce });
}

/**
 * Child state lives in a nonce-addressed companion record instead of replacing
 * lease.json. If an old owner wakes after a stale lease was quarantined, its
 * old-nonce write cannot alter the replacement lease's metadata.
 */
async function replaceChildLeaseRecord(
  lockDir: string,
  nonce: string,
  child: LeaseChildProcess,
): Promise<void> {
  const recordPath = childLeaseRecordPath(lockDir, nonce);
  const temporaryPath = `${recordPath}.update`;
  try {
    await writeChildLeaseRecord(temporaryPath, {
      nonce,
      pid: child.pid,
      processStartIdentity: child.processStartIdentity,
    });
    await rename(temporaryPath, recordPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/**
 * Releasing by rename prevents a waiting contender from racing a recursive
 * delete of the active lock directory. Once moved to its nonce-specific
 * tombstone, the lease is no longer acquirable; tombstone cleanup is best
 * effort and cannot block the lifecycle transaction's completion.
 */
async function releaseOwnedLease(
  lockDir: string,
  nonce: string,
  isOwnerProcessAlive: (pid: number) => boolean,
  resolveProcessStartIdentity: ProcessStartIdentityResolver,
): Promise<void> {
  const current = await readLeaseRecord(lockDir);
  if (!current.record || current.record.nonce !== nonce) {
    return;
  }
  if (hasLiveOrUnverifiableMutation(
    current.record,
    isOwnerProcessAlive,
    resolveProcessStartIdentity,
    new Date(),
  )) {
    // A caller may reach its finally block after an IPC failure while the
    // detached Git group still runs. Do not turn a normal release attempt
    // into authorization to steal that mutation's lease.
    // The companion child record outlives this caller. Persisting the request
    // changes stale recovery from "wait for the application owner" to "wait
    // only for the tracked mutation identities", so one release call is
    // sufficient when that child exits later.
    try {
      await updateOwnedLeaseRecord(lockDir, nonce, (record) => ({
        ...record,
        releaseRequested: true,
      }));
    } catch (error) {
      if (!isLeaseOwnershipGoneError(error)) {
        throw error;
      }
    }
    return;
  }

  const releasedDir = `${lockDir}.released.${nonce}`;
  try {
    await rename(lockDir, releasedDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') {
      return;
    }
    throw error;
  }

  try {
    await rm(releasedDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    });
  } catch {
    // The lease was released by the atomic rename. A leftover tombstone is
    // not an active lock and can be removed by later runtime maintenance.
  }
}

function isLeaseRecord(value: unknown): value is WorktreeOperationLeaseRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Partial<WorktreeOperationLeaseRecord>;
  return (
    typeof record.pid === 'number'
    && Number.isInteger(record.pid)
    && record.pid > 0
    && typeof record.nonce === 'string'
    && isSafeNonce(record.nonce)
    && (
      record.processStartIdentity === undefined
      || isSafeProcessStartIdentity(record.processStartIdentity)
    )
    && (
      (record.childPid === undefined && record.childProcessStartIdentity === undefined)
      || (
        typeof record.childPid === 'number'
        && Number.isInteger(record.childPid)
        && record.childPid > 0
        && isSafeProcessStartIdentity(record.childProcessStartIdentity)
      )
    )
    && typeof record.canonicalPath === 'string'
    && typeof record.operation === 'string'
    && typeof record.acquiredAt === 'string'
    && (
      record.releaseRequested === undefined
      || typeof record.releaseRequested === 'boolean'
    )
    && (
      record.pendingMutation === undefined
      || isPendingGitMutation(record.pendingMutation)
    )
  );
}

function isPendingGitMutation(value: unknown): value is PendingGitMutation {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const pending = value as Partial<PendingGitMutation>;
  const hasSupervisorPid = pending.supervisorPid !== undefined;
  const hasSupervisorIdentity = pending.supervisorProcessStartIdentity !== undefined;
  return (
    typeof pending.nonce === 'string'
    && isSafeNonce(pending.nonce)
    && typeof pending.deadline === 'string'
    && Number.isFinite(Date.parse(pending.deadline))
    && hasSupervisorPid === hasSupervisorIdentity
    && (
      !hasSupervisorPid
      || (
        typeof pending.supervisorPid === 'number'
        && Number.isInteger(pending.supervisorPid)
        && pending.supervisorPid > 0
        && isSafeProcessStartIdentity(pending.supervisorProcessStartIdentity)
      )
    )
    && (
      pending.claimedAt === undefined
      || typeof pending.claimedAt === 'string'
    )
    && (
      pending.terminationUnconfirmedAt === undefined
      || typeof pending.terminationUnconfirmedAt === 'string'
    )
    && (
      pending.terminationFailure === undefined
      || (
        typeof pending.terminationFailure === 'string'
        && pending.terminationFailure.length <= 1_024
        && !/[\r\n\0]/.test(pending.terminationFailure)
      )
    )
  );
}

function isChildLeaseRecord(value: unknown): value is ChildLeaseRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<ChildLeaseRecord>;
  return (
    typeof record.nonce === 'string'
    && isSafeNonce(record.nonce)
    && typeof record.pid === 'number'
    && Number.isInteger(record.pid)
    && record.pid > 0
    && isSafeProcessStartIdentity(record.processStartIdentity)
  );
}

function isSafeNonce(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isLeaseOwnerStale(
  record: WorktreeOperationLeaseRecord,
  isOwnerProcessAlive: (pid: number) => boolean,
  resolveProcessStartIdentity: ProcessStartIdentityResolver,
  now: Date = new Date(),
): boolean {
  if (record.releaseRequested) {
    // A normal release must not be stranded merely because the originating
    // application remains alive after handing its final destructive child to
    // the lease. Pending launch/supervisor and Git-child identities still
    // block reclaiming until they are conclusively stale.
    return !hasLiveOrUnverifiableMutation(
      record,
      isOwnerProcessAlive,
      resolveProcessStartIdentity,
      now,
    );
  }

  const pending = record.pendingMutation;
  if (pending) {
    // A process may die after persisting pendingMutation but before fork has
    // created the supervisor. Until the declared deadline this is an
    // intentionally unstealable launch window.
    const claimedSupervisor = (
      pending.supervisorPid !== undefined
      && pending.supervisorProcessStartIdentity !== undefined
    );
    if (!claimedSupervisor && isFutureOrPresentTimestamp(pending.deadline, now)) {
      return false;
    }
    if (
      claimedSupervisor
      && !isProcessIdentityStale(
        pending.supervisorPid!,
        pending.supervisorProcessStartIdentity!,
        isOwnerProcessAlive,
        resolveProcessStartIdentity,
      )
    ) {
      return false;
    }
  }

  if (!isProcessIdentityStale(
    record.pid,
    record.processStartIdentity,
    isOwnerProcessAlive,
    resolveProcessStartIdentity,
  )) {
    return false;
  }

  if (
    record.childPid === undefined
    || record.childProcessStartIdentity === undefined
  ) {
    return true;
  }

  return isProcessIdentityStale(
    record.childPid,
    record.childProcessStartIdentity,
    isOwnerProcessAlive,
    resolveProcessStartIdentity,
  );
}

function hasLiveOrUnverifiableMutation(
  record: WorktreeOperationLeaseRecord,
  isOwnerProcessAlive: (pid: number) => boolean,
  resolveProcessStartIdentity: ProcessStartIdentityResolver,
  now: Date,
): boolean {
  const pending = record.pendingMutation;
  if (pending) {
    const claimedSupervisor = (
      pending.supervisorPid !== undefined
      && pending.supervisorProcessStartIdentity !== undefined
    );
    if (!claimedSupervisor && isFutureOrPresentTimestamp(pending.deadline, now)) {
      return true;
    }
    if (
      claimedSupervisor
      && !isProcessIdentityStale(
        pending.supervisorPid!,
        pending.supervisorProcessStartIdentity!,
        isOwnerProcessAlive,
        resolveProcessStartIdentity,
      )
    ) {
      return true;
    }
  }

  return (
    record.childPid !== undefined
    && record.childProcessStartIdentity !== undefined
    && !isProcessIdentityStale(
      record.childPid,
      record.childProcessStartIdentity,
      isOwnerProcessAlive,
      resolveProcessStartIdentity,
    )
  );
}

function isFutureOrPresentTimestamp(value: string, now: Date): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= now.getTime();
}

function isProcessIdentityStale(
  pid: number,
  expectedIdentity: string | undefined,
  isOwnerProcessAlive: (pid: number) => boolean,
  resolveProcessStartIdentity: ProcessStartIdentityResolver,
): boolean {
  if (!isOwnerProcessAlive(pid)) {
    return true;
  }

  if (!expectedIdentity) {
    return false;
  }

  const currentIdentity = resolveProcessStartIdentity(pid);
  return (
    isSafeProcessStartIdentity(currentIdentity)
    && currentIdentity !== expectedIdentity
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
