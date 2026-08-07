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
  updateSettings?: Record<string, unknown>;
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

export interface ProjectPaneConfigTransaction {
  config: ProjectPaneConfig;
  /**
   * Atomically persists the current config while retaining the project-wide
   * lease. This is for lifecycle operations that must make one record durable
   * before a subsequent side effect can run.
   */
  persist: () => Promise<void>;
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

  const resolvedProcessStartIdentity = resolveProcessStartIdentity(pid);
  const processStartIdentity = isSafeProcessStartIdentity(resolvedProcessStartIdentity)
    ? resolvedProcessStartIdentity
    : undefined;
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
  return transactProjectPaneConfig(
    projectRoot,
    async ({ config }) => mutation(config),
    options,
  );
}

/**
 * Runs a config operation while retaining the project-wide lease. Unlike a
 * normal mutation, callers can make an intermediate state durable before a
 * follow-up side effect and compensate while still holding that same lease.
 */
export async function transactProjectPaneConfig<T>(
  projectRoot: string,
  operation: (
    transaction: ProjectPaneConfigTransaction,
  ) => T | Promise<T>,
  options: ProjectPaneConfigLockOptions = {},
): Promise<ProjectPaneConfigMutationResult<T>> {
  const lock = await acquireProjectPaneConfigLock(projectRoot, options);
  try {
    const config = await readProjectPaneConfig(lock.canonicalProjectRoot);
    let persisted = false;
    const persist = async (): Promise<void> => {
      await writeProjectPaneConfig(lock.canonicalProjectRoot, config);
      persisted = true;
    };
    const result = await operation({ config, persist });
    if (!persisted) {
      await persist();
    }
    return { config, result };
  } finally {
    await lock.release();
  }
}

/**
 * Reads a config while holding the cross-process lease without rewriting it.
 * Destructive lifecycle checks use this instead of a no-op mutation so a
 * read-only decision cannot touch the registry's contents or mtime.
 */
export async function readProjectPaneConfigUnderLock(
  projectRoot: string,
  options: ProjectPaneConfigLockOptions = {},
): Promise<ProjectPaneConfig> {
  const lock = await acquireProjectPaneConfigLock(projectRoot, options);
  try {
    return await readProjectPaneConfig(lock.canonicalProjectRoot);
  } finally {
    await lock.release();
  }
}

/**
 * Mutates only the project settings section and retains all unrelated config
 * fields, including settings introduced by newer clients.
 */
export async function mutateProjectPaneSettings<T>(
  projectRoot: string,
  mutation: (
    settings: Record<string, unknown>,
    config: ProjectPaneConfig,
  ) => T | Promise<T>,
  options: ProjectPaneConfigLockOptions = {},
): Promise<ProjectPaneConfigMutationResult<T>> {
  return mutateProjectPaneConfig(projectRoot, async (config) => {
    const settings = mutableConfigSection(config, 'settings');
    const result = await mutation(settings, config);
    config.settings = settings;
    config.lastUpdated = new Date().toISOString();
    return result;
  }, options);
}

/**
 * Mutates only the updater settings section and retains the pane registry and
 * every unrelated config field.
 */
export async function mutateProjectPaneUpdateSettings<T>(
  projectRoot: string,
  mutation: (
    settings: Record<string, unknown>,
    config: ProjectPaneConfig,
  ) => T | Promise<T>,
  options: ProjectPaneConfigLockOptions = {},
): Promise<ProjectPaneConfigMutationResult<T>> {
  return mutateProjectPaneConfig(projectRoot, async (config) => {
    const settings = mutableConfigSection(config, 'updateSettings');
    const result = await mutation(settings, config);
    config.updateSettings = settings;
    config.lastUpdated = new Date().toISOString();
    return result;
  }, options);
}

/**
 * Upserts exact pane records into the fresh locked registry. It never treats
 * an omitted pane from a stale UI array as a deletion.
 */
export async function upsertProjectPaneConfigPanes(
  projectRoot: string,
  panesToUpsert: readonly ProjectPaneConfigPane[],
  options: ProjectPaneConfigLockOptions = {},
): Promise<ProjectPaneConfigMutationResult<ProjectPaneConfigPane[]>> {
  return mutateProjectPaneConfig(projectRoot, (config) => {
    const panes = Array.isArray(config.panes) ? [...config.panes] : [];

    for (const nextPane of panesToUpsert) {
      const index = findPaneRecordIndex(panes, nextPane);
      if (index === -1) {
        panes.push(nextPane);
      } else {
        panes[index] = {
          ...asRecord(panes[index]),
          ...asRecord(nextPane),
        };
      }
    }

    config.panes = panes;
    config.lastUpdated = new Date().toISOString();
    return panes;
  }, options);
}

/**
 * Removes only explicitly named psyche pane IDs from the fresh locked
 * registry. IDs absent from an in-memory UI snapshot are never inferred as
 * removals.
 */
export async function removeProjectPaneConfigPanes(
  projectRoot: string,
  paneIds: Iterable<string>,
  options: ProjectPaneConfigLockOptions = {},
): Promise<ProjectPaneConfigMutationResult<ProjectPaneConfigPane[]>> {
  const ids = new Set(
    Array.from(paneIds).filter((paneId) => typeof paneId === 'string' && paneId.length > 0),
  );

  return mutateProjectPaneConfig(projectRoot, (config) => {
    const panes = Array.isArray(config.panes) ? config.panes : [];
    const remaining = panes.filter((pane) => {
      const id = paneRecordId(pane);
      return !id || !ids.has(id);
    });
    config.panes = remaining;
    config.lastUpdated = new Date().toISOString();
    return remaining;
  }, options);
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

  const config = parsed as ProjectPaneConfig;
  if (config.panes !== undefined && !Array.isArray(config.panes)) {
    throw new ProjectPaneConfigError(
      'config_corrupt',
      `${configPath} has a non-array panes field`,
    );
  }
  for (const key of ['settings', 'updateSettings'] as const) {
    const value = config[key];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new ProjectPaneConfigError(
        'config_corrupt',
        `${configPath} has a non-object ${key} field`,
      );
    }
  }

  return config;
}

export function projectPaneConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.psyche', 'psyche.config.json');
}

/**
 * Derives the project root for the canonical shared pane/settings config.
 * Callers receiving an arbitrary file path must not use it as a substitute
 * for this cross-process registry.
 */
export function projectRootFromPaneConfigPath(configPath: string): string | undefined {
  const resolved = path.resolve(configPath);
  if (
    path.basename(resolved) !== 'psyche.config.json'
    || path.basename(path.dirname(resolved)) !== '.psyche'
  ) {
    return undefined;
  }
  return path.dirname(path.dirname(resolved));
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

async function writeProjectPaneConfig(
  canonicalProjectRoot: string,
  config: ProjectPaneConfig,
): Promise<void> {
  const configPath = projectPaneConfigPath(canonicalProjectRoot);
  await mkdir(path.dirname(configPath), { recursive: true });
  await atomicWriteJson(configPath, config);
}

function mutableConfigSection(
  config: ProjectPaneConfig,
  key: 'settings' | 'updateSettings',
): Record<string, unknown> {
  const value = config[key];
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectPaneConfigError(
      'config_corrupt',
      `${key} in ${projectPaneConfigPath(String(config.projectRoot || 'project'))} is not a JSON object`,
    );
  }
  return { ...(value as Record<string, unknown>) };
}

function asRecord(value: ProjectPaneConfigPane): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function paneRecordId(value: ProjectPaneConfigPane): string | undefined {
  const id = asRecord(value).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function findPaneRecordIndex(
  panes: readonly ProjectPaneConfigPane[],
  nextPane: ProjectPaneConfigPane,
): number {
  const id = paneRecordId(nextPane);
  if (!id) {
    return -1;
  }
  return panes.findIndex((pane) => paneRecordId(pane) === id);
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
    isSafeProcessStartIdentity(currentIdentity)
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
