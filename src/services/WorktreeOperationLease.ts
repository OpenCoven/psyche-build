import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_TIMEOUT_MS = 30_000;
const LEASE_FILE_NAME = 'lease.json';

export interface WorktreeOperationLeaseRecord {
  pid: number;
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

export interface WorktreeOperationLeaseOptions {
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
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

interface LockReadResult {
  record?: WorktreeOperationLeaseRecord;
  missing: boolean;
}

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
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
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

  const record: WorktreeOperationLeaseRecord = {
    pid,
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
        if (!isProcessAlive(current.record.pid)) {
          const quarantined = await quarantineDeadLease(
            paths,
            current.record,
            isProcessAlive,
          );
          if (quarantined) {
            continue;
          }
          lastWaitReason = `stale lease recovery is in progress for pid ${current.record.pid}`;
        } else {
          lastWaitReason = `lease is held by live pid ${current.record.pid}`;
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
      const current = await readLeaseRecord(paths.lockDir);
      if (!current.record || current.record.nonce !== nonce) {
        return;
      }
      await rm(paths.lockDir, { recursive: true, force: true });
    },
  };
}

async function resolveLeasePaths(
  request: WorktreeOperationLeaseRequest,
): Promise<LeasePaths> {
  const canonicalWorktreePath = await canonicalizePath(request.worktreePath);
  const discoveredProjectRoot = await discoverMainProjectRoot(canonicalWorktreePath);
  const canonicalProjectRoot = discoveredProjectRoot
    ?? (request.projectRoot ? await canonicalizePath(request.projectRoot) : undefined);

  if (!canonicalProjectRoot) {
    throw new Error(
      `Could not resolve a main project root for worktree operation lease: ${canonicalWorktreePath}`,
    );
  }

  const runtimeDir = await canonicalizePathWithExistingAncestor(
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

async function canonicalizePath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await realpath(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return resolved;
    }
    throw error;
  }
}

async function canonicalizePathWithExistingAncestor(value: string): Promise<string> {
  const unresolvedSegments: string[] = [];
  let candidate = path.resolve(value);

  while (true) {
    try {
      return path.join(await realpath(candidate), ...unresolvedSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }

      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return path.resolve(value);
      }
      unresolvedSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }
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
  return root ? canonicalizePath(root) : undefined;
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
  isProcessAlive: (pid: number) => boolean,
): Promise<boolean> {
  // Check immediately before the atomic move. A live lease is never moved.
  if (isProcessAlive(record.pid)) {
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
    && typeof record.canonicalPath === 'string'
    && typeof record.operation === 'string'
    && typeof record.acquiredAt === 'string'
  );
}

function isSafeNonce(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves that a process with this PID exists; treating it as
    // dead could steal a lease owned by another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
