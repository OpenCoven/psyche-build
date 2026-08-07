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

export interface WorktreeOperationLeaseRecord {
  pid: number;
  processStartIdentity?: string;
  nonce: string;
  canonicalPath: string;
  operation: string;
  acquiredAt: string;
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

export interface WorktreeOperationLease {
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
export interface ProjectWorktreeLifecycleLease {
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
  const deadline = Date.now() + timeoutMs;
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
        )) {
          const quarantined = await quarantineDeadLease(
            paths,
            current.record,
            isOwnerProcessAlive,
            resolveProcessStartIdentity,
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
    release: async () => {
      await releaseOwnedLease(paths.lockDir, nonce);
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
  const deadline = Date.now() + timeoutMs;
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
        )) {
          if (await quarantineProjectLifecycleLease(
            paths,
            current.record,
            isOwnerProcessAlive,
            resolveProcessStartIdentity,
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
    release: async () => {
      await releaseOwnedLease(paths.lockDir, nonce);
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

async function readLeaseRecord(lockDir: string): Promise<LockReadResult> {
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

async function quarantineDeadLease(
  paths: LeasePaths,
  record: WorktreeOperationLeaseRecord,
  isOwnerProcessAlive: (pid: number) => boolean,
  resolveProcessStartIdentity: ProcessStartIdentityResolver,
): Promise<boolean> {
  // Check immediately before the atomic move. A live lease is never moved.
  if (!isLeaseOwnerStale(record, isOwnerProcessAlive, resolveProcessStartIdentity)) {
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
): Promise<boolean> {
  if (!isLeaseOwnerStale(record, isOwnerProcessAlive, resolveProcessStartIdentity)) {
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

/**
 * Releasing by rename prevents a waiting contender from racing a recursive
 * delete of the active lock directory. Once moved to its nonce-specific
 * tombstone, the lease is no longer acquirable; tombstone cleanup is best
 * effort and cannot block the lifecycle transaction's completion.
 */
async function releaseOwnedLease(
  lockDir: string,
  nonce: string,
): Promise<void> {
  const current = await readLeaseRecord(lockDir);
  if (!current.record || current.record.nonce !== nonce) {
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
    && typeof record.canonicalPath === 'string'
    && typeof record.operation === 'string'
    && typeof record.acquiredAt === 'string'
  );
}

function isSafeNonce(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isLeaseOwnerStale(
  record: WorktreeOperationLeaseRecord,
  isOwnerProcessAlive: (pid: number) => boolean,
  resolveProcessStartIdentity: ProcessStartIdentityResolver,
): boolean {
  if (!isOwnerProcessAlive(record.pid)) {
    return true;
  }

  if (!record.processStartIdentity) {
    return false;
  }

  const currentIdentity = resolveProcessStartIdentity(record.pid);
  return (
    isSafeProcessStartIdentity(currentIdentity)
    && currentIdentity !== record.processStartIdentity
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
