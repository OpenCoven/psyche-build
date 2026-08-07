import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from '../utils/atomicWrite.js';
import type { PsychePane } from '../types.js';
import {
  getProcessStartIdentity,
  isProcessAlive,
  isSafeProcessStartIdentity,
  type ProcessStartIdentityResolver,
} from './ProcessIdentity.js';

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_TIMEOUT_MS = 30_000;
const LOCK_DIRECTORY_NAME = 'pane-config.lock';
const LOCK_RECORD_NAME = 'lease.json';

export type ProjectPaneConfigPane = Record<string, unknown> | PsychePane;

export interface ProjectPaneConfig extends Record<string, unknown> {
  projectName?: string;
  projectRoot?: string;
  panes?: ProjectPaneConfigPane[];
  settings?: Record<string, unknown>;
  lastUpdated?: string;
}

export interface ProjectPaneConfigLockRecord {
  pid: number;
  processStartIdentity?: string;
  nonce: string;
  acquiredAt: string;
}

export interface ProjectPaneConfigLock {
  canonicalProjectRoot: string;
  lockDir: string;
  nonce: string;
  release: () => Promise<void>;
}

export interface ProjectPaneConfigLockOptions {
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  getProcessStartIdentity?: ProcessStartIdentityResolver;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  now?: () => Date;
  createNonce?: () => string;
}

export interface ProjectPaneConfigMutationResult<T> {
  config: ProjectPaneConfig;
  result: T;
}

export class ProjectPaneConfigError extends Error {
  readonly code: 'config_unreadable' | 'config_corrupt';

  constructor(
    code: 'config_unreadable' | 'config_corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectPaneConfigError';
    this.code = code;
  }
}

interface ConfigLockPaths {
  canonicalProjectRoot: string;
  runtimeDir: string;
  lockDir: string;
}

interface LockReadResult {
  record?: ProjectPaneConfigLockRecord;
  missing: boolean;
}

/**
 * Acquires the project-wide pane-config lease. The lock lives outside every
 * managed worktree so deleting a worktree cannot accidentally release it.
 */
export async function acquireProjectPaneConfigLock(
  projectRoot: string,
  options: ProjectPaneConfigLockOptions = {},
): Promise<ProjectPaneConfigLock> {
  const paths = await resolveConfigLockPaths(projectRoot);
  const pid = options.pid ?? process.pid;
  const isOwnerProcessAlive = options.isProcessAlive ?? isProcessAlive;
  const resolveProcessStartIdentity = options.getProcessStartIdentity ?? getProcessStartIdentity;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const createNonce = options.createNonce ?? randomUUID;

  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('project pane config lock pollIntervalMs must be greater than zero');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('project pane config lock timeoutMs must not be negative');
  }

  await mkdir(paths.runtimeDir, { recursive: true });
  const nonce = createNonce();
  if (!isSafeNonce(nonce)) {
    throw new Error('project pane config lock nonce contains unsupported characters');
  }

  const processStartIdentity = resolveProcessStartIdentity(pid);
  const record: ProjectPaneConfigLockRecord = {
    pid,
    ...(processStartIdentity ? { processStartIdentity } : {}),
    nonce,
    acquiredAt: now().toISOString(),
  };
  const candidateDir = path.join(
    paths.runtimeDir,
    `${LOCK_DIRECTORY_NAME}.candidate.${nonce}`,
  );
  const candidateRecordPath = path.join(candidateDir, LOCK_RECORD_NAME);
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  let lastWaitReason = 'another project config mutation is in progress';

  try {
    await mkdir(candidateDir);
    await writeLockRecord(candidateRecordPath, record);

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

      const current = await readLockRecord(paths.lockDir);
      if (current.record) {
        if (isLockOwnerStale(
          current.record,
          isOwnerProcessAlive,
          resolveProcessStartIdentity,
        )) {
          if (await quarantineStaleLock(
            paths,
            current.record,
            isOwnerProcessAlive,
            resolveProcessStartIdentity,
          )) {
            continue;
          }
          lastWaitReason = `stale config lock recovery is in progress for pid ${current.record.pid}`;
        } else {
          lastWaitReason = `config lock is held by live or unverifiable pid ${current.record.pid}`;
        }
      } else if (current.missing) {
        lastWaitReason = 'config lock was released while waiting';
      } else {
        // A malformed lock could belong to a still-live writer. Without
        // owner metadata, removing it would be an unsafe lock steal.
        lastWaitReason = 'config lock metadata is unavailable or invalid';
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Timed out waiting for project pane config lock for ${paths.canonicalProjectRoot}: ${lastWaitReason}`,
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
      const current = await readLockRecord(paths.lockDir);
      if (!current.record || current.record.nonce !== nonce) {
        return;
      }
      await rm(paths.lockDir, { recursive: true, force: true });
    },
  };
}

/**
 * Reads, mutates, and atomically writes the pane registry while holding the
 * cross-process project config lease. ENOENT is an empty project; unreadable
 * and corrupt files are never replaced.
 */
export async function mutateProjectPaneConfig<T>(
  projectRoot: string,
  mutation: (config: ProjectPaneConfig) => T | Promise<T>,
  options: ProjectPaneConfigLockOptions = {},
): Promise<ProjectPaneConfigMutationResult<T>> {
  const lock = await acquireProjectPaneConfigLock(projectRoot, options);
  try {
    const config = await readProjectPaneConfig(lock.canonicalProjectRoot);
    const result = await mutation(config);
    const configPath = projectPaneConfigPath(lock.canonicalProjectRoot);
    await mkdir(path.dirname(configPath), { recursive: true });
    await atomicWriteJson(configPath, config);
    return { config, result };
  } finally {
    await lock.release();
  }
}

export async function readProjectPaneConfig(
  projectRoot: string,
): Promise<ProjectPaneConfig> {
  const canonicalProjectRoot = await canonicalizePath(projectRoot);
  const configPath = projectPaneConfigPath(canonicalProjectRoot);
  let raw: string;

  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        projectName: path.basename(canonicalProjectRoot),
        projectRoot: canonicalProjectRoot,
        panes: [],
        settings: {},
        lastUpdated: new Date().toISOString(),
      };
    }
    throw new ProjectPaneConfigError(
      'config_unreadable',
      `could not read ${configPath}: ${errorMessage(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ProjectPaneConfigError(
      'config_corrupt',
      `${configPath} is not valid JSON and will not be overwritten: ${errorMessage(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectPaneConfigError(
      'config_corrupt',
      `${configPath} is not a JSON object`,
    );
  }

  return parsed as ProjectPaneConfig;
}

export function projectPaneConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.psyche', 'psyche.config.json');
}

async function resolveConfigLockPaths(projectRoot: string): Promise<ConfigLockPaths> {
  const canonicalProjectRoot = await canonicalizePath(projectRoot);
  const runtimeDir = path.join(canonicalProjectRoot, '.psyche', 'runtime');
  return {
    canonicalProjectRoot,
    runtimeDir,
    lockDir: path.join(runtimeDir, LOCK_DIRECTORY_NAME),
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

async function writeLockRecord(
  recordPath: string,
  record: ProjectPaneConfigLockRecord,
): Promise<void> {
  const handle = await open(recordPath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLockRecord(lockDir: string): Promise<LockReadResult> {
  try {
    const raw = await readFile(path.join(lockDir, LOCK_RECORD_NAME), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return {
      record: isLockRecord(parsed) ? parsed : undefined,
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

async function quarantineStaleLock(
  paths: ConfigLockPaths,
  record: ProjectPaneConfigLockRecord,
  isOwnerProcessAlive: (pid: number) => boolean,
  resolveProcessStartIdentity: ProcessStartIdentityResolver,
): Promise<boolean> {
  if (!isLockOwnerStale(record, isOwnerProcessAlive, resolveProcessStartIdentity)) {
    return false;
  }

  const quarantineDir = path.join(
    paths.runtimeDir,
    `${LOCK_DIRECTORY_NAME}.stale.${record.nonce}`,
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

function isLockRecord(value: unknown): value is ProjectPaneConfigLockRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Partial<ProjectPaneConfigLockRecord>;
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
    && typeof record.acquiredAt === 'string'
  );
}

function isLockOwnerStale(
  record: ProjectPaneConfigLockRecord,
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
    currentIdentity !== undefined
    && currentIdentity !== record.processStartIdentity
  );
}

function isSafeNonce(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
