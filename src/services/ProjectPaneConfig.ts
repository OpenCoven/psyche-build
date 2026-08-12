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
import type { PaneLayout } from '../types.js';
import { reconcilePaneLayout, seedPaneLayout } from '../layout/PaneLayoutTree.js';
import {
  getProcessStartIdentity,
  isProcessAlive,
  isSafeProcessStartIdentity,
  type ProcessStartIdentityResolver,
} from './ProcessIdentity.js';
import { findTmuxResourceConflict } from './TmuxResourceOwnership.js';
import {
  isTmuxServerIdentity,
  sameTmuxServerIdentity,
  type TmuxServerIdentity,
} from './TmuxServerIdentity.js';

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

export interface ProjectPaneConfigPaneIdentity {
  id: string;
  paneId: string;
  tmuxServerIdentity?: TmuxServerIdentity;
}

export type ProjectPaneConfigIdentityRemovalGuard = (
  panes: readonly ProjectPaneConfigPane[],
  exactPanes: readonly ProjectPaneConfigPane[],
) => void | Promise<void>;

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
      await releaseOwnedConfigLock(paths.lockDir, nonce);
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
      assertUniquePaneIds(config.panes, projectPaneConfigPath(lock.canonicalProjectRoot));
      reconcileProjectPaneLayout(config);
      await writeProjectPaneConfig(lock.canonicalProjectRoot, config);
      persisted = true;
    };
    const result = await operation({ config, persist });
    if (!persisted) {
      await persist();
    }

    /**
     * The pane registry is the source of truth for ownership. Every durable
     * registry transaction therefore also prunes removed leaves and adopts
     * generation-bound records created by callers that predate an explicit
     * placement mutation. Explicit layout insertion still supplies the preferred
     * target and direction before this invariant runs.
     */
    function reconcileProjectPaneLayout(config: ProjectPaneConfig): void {
      const paneIds = (Array.isArray(config.panes) ? config.panes : [])
        .map(paneRecordId)
        .filter((id): id is string => Boolean(id));
      const paneLayout = config.paneLayout;
      if (paneLayout === undefined) {
        if (paneIds.length > 0) {
          config.paneLayout = seedPaneLayout(paneIds);
        }
        return;
      }
      if (!paneLayout || typeof paneLayout !== 'object' || Array.isArray(paneLayout)) {
        return;
      }
      const candidate = paneLayout as PaneLayout;
      if (candidate.version !== 1 || !('root' in candidate)) {
        return;
      }
      config.paneLayout = reconcilePaneLayout(candidate, paneIds);
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
 * Adds exact pane records into the fresh locked registry. A pane ID is a
 * durable lifecycle identity, so a collision is never silently treated as an
 * update to another creation attempt.
 */
export async function upsertProjectPaneConfigPanes(
  projectRoot: string,
  panesToUpsert: readonly ProjectPaneConfigPane[],
  options: ProjectPaneConfigLockOptions = {},
): Promise<ProjectPaneConfigMutationResult<ProjectPaneConfigPane[]>> {
  return mutateProjectPaneConfig(projectRoot, (config) => {
    const panes = Array.isArray(config.panes) ? [...config.panes] : [];
    const existingIds = new Set(
      panes
        .map(paneRecordId)
        .filter((id): id is string => Boolean(id)),
    );
    const requestedIds = new Set<string>();

    for (const nextPane of panesToUpsert) {
      const id = paneRecordId(nextPane);
      if (!id) {
        throw new Error('Cannot persist pane without an ID');
      }
      if (existingIds.has(id) || requestedIds.has(id)) {
        throw new Error(`Duplicate pane ID "${id}" cannot replace an existing pane record`);
      }
      requestedIds.add(id);
      panes.push(nextPane);
    }

    config.panes = panes;
    config.lastUpdated = new Date().toISOString();
    return panes;
  }, options);
}

/**
 * Retains a pane record without ever replacing another record that happens to
 * share its ID. This is used only for recovery after a failed lifecycle
 * persistence: an already-durable exact identity is accepted as success.
 */
export async function ensureProjectPaneConfigPane(
  projectRoot: string,
  pane: ProjectPaneConfigPane,
  options: ProjectPaneConfigLockOptions = {},
): Promise<ProjectPaneConfigMutationResult<ProjectPaneConfigPane>> {
  const expected = paneRecordIdentity(pane);
  if (!expected) {
    throw new Error('Cannot retain pane recovery record without an exact ID and pane ID');
  }

  return transactProjectPaneConfig(projectRoot, async ({ config, persist }) => {
    const panes = Array.isArray(config.panes) ? [...config.panes] : [];
    assertUniquePaneIds(panes, projectPaneConfigPath(projectRoot));

    const existing = panes.find((candidate) => paneRecordId(candidate) === expected.id);
    if (existing) {
      if (!hasPaneRecordIdentity(existing, expected)) {
        throw new Error(
          `Pane identity conflict for "${expected.id}": existing pane ID changed before recovery`,
        );
      }
      return existing;
    }

    panes.push(pane);
    config.panes = panes;
    config.lastUpdated = new Date().toISOString();
    await persist();
    return pane;
  }, options);
}

/**
 * Rebinds one exact persisted record to a replacement tmux pane ID. The
 * originating `{ id, paneId }` must still be current while the config lease is
 * held; otherwise a concurrent rebind wins and this operation refuses to
 * overwrite it.
 */
export async function replaceProjectPaneConfigPaneIdentity(
  projectRoot: string,
  expected: ProjectPaneConfigPaneIdentity,
  replacement: ProjectPaneConfigPane,
  options: ProjectPaneConfigLockOptions = {},
): Promise<ProjectPaneConfigMutationResult<ProjectPaneConfigPane>> {
  const replacementIdentity = paneRecordIdentity(replacement);
  if (!replacementIdentity || replacementIdentity.id !== expected.id) {
    throw new Error('Pane identity replacement requires the same non-empty pane ID');
  }
  const replacementRecord = asRecord(replacement);
  const replacementGeneration = tmuxServerIdentityOf(
    replacementRecord.tmuxServerIdentity,
  );
  if (!replacementGeneration) {
    throw new Error(
      'Pane identity replacement requires the new tmux server generation',
    );
  }

  return transactProjectPaneConfig(projectRoot, async ({ config, persist }) => {
    const panes = Array.isArray(config.panes) ? [...config.panes] : [];
    assertUniquePaneIds(panes, projectPaneConfigPath(projectRoot));
    const exactIndex = panes.findIndex((candidate) => hasPaneRecordIdentity(candidate, expected));

    if (exactIndex === -1) {
      const current = panes.find((candidate) => paneRecordId(candidate) === expected.id);
      if (current && hasPaneRecordIdentity(current, replacementIdentity)) {
        return current;
      }
      throw new Error(
        `Pane identity conflict for "${expected.id}": expected tmux pane "${expected.paneId}" is no longer current`,
      );
    }

    const currentRecord = asRecord(panes[exactIndex]);
    const next: Record<string, unknown> = {
      ...currentRecord,
      id: expected.id,
      paneId: replacementIdentity.paneId,
      tmuxServerIdentity: replacementGeneration,
      ...(
        typeof replacementRecord.worktreePath === 'string'
          ? { worktreePath: replacementRecord.worktreePath }
          : {}
      ),
    };
    reconcileReplacedPaneTmuxResources(
      next,
      currentRecord,
      replacementGeneration,
    );
    panes[exactIndex] = next;
    config.panes = panes;
    config.lastUpdated = new Date().toISOString();
    await persist();
    return next;
  }, options);
}

/**
 * A primary-pane rebind is a new allocation, not an inheritance of every
 * resource the old pane record happened to contain. Retain only background
 * resources whose own (or old primary fallback) generation proves that they
 * still belong to the replacement server.
 */
function reconcileReplacedPaneTmuxResources(
  next: Record<string, unknown>,
  previous: Record<string, unknown>,
  replacementGeneration: TmuxServerIdentity,
): void {
  const previousPrimaryGeneration = tmuxServerIdentityOf(
    previous.tmuxServerIdentity,
  );

  if (!resourceHasReplacementGeneration(
    previous,
    'testTmuxServerIdentity',
    previousPrimaryGeneration,
    replacementGeneration,
  )) {
    delete next.testWindowId;
    delete next.testPaneId;
    delete next.testTmuxServerIdentity;
    delete next.testStatus;
    delete next.testOutput;
  }

  if (!resourceHasReplacementGeneration(
    previous,
    'devTmuxServerIdentity',
    previousPrimaryGeneration,
    replacementGeneration,
  )) {
    delete next.devWindowId;
    delete next.devPaneId;
    delete next.devTmuxServerIdentity;
    delete next.devStatus;
    delete next.devUrl;
  }

  const recoveries = Array.isArray(previous.backgroundWindowRecoveries)
    ? previous.backgroundWindowRecoveries.filter((recovery) => {
      if (!recovery || typeof recovery !== 'object') {
        return false;
      }
      const recoveryGeneration = tmuxServerIdentityOf(
        (recovery as Record<string, unknown>).tmuxServerIdentity,
      ) ?? previousPrimaryGeneration;
      return Boolean(
        recoveryGeneration
        && sameTmuxServerIdentity(recoveryGeneration, replacementGeneration),
      );
    })
    : [];
  if (recoveries.length > 0) {
    next.backgroundWindowRecoveries = recoveries;
  } else {
    delete next.backgroundWindowRecoveries;
  }
}

function resourceHasReplacementGeneration(
  previous: Record<string, unknown>,
  generationField: 'testTmuxServerIdentity' | 'devTmuxServerIdentity',
  previousPrimaryGeneration: TmuxServerIdentity | undefined,
  replacementGeneration: TmuxServerIdentity,
): boolean {
  const hasResource = generationField === 'testTmuxServerIdentity'
    ? typeof previous.testWindowId === 'string' || typeof previous.testPaneId === 'string'
    : typeof previous.devWindowId === 'string' || typeof previous.devPaneId === 'string';
  if (!hasResource) {
    return true;
  }
  const resourceGeneration = tmuxServerIdentityOf(previous[generationField])
    ?? previousPrimaryGeneration;
  return Boolean(
    resourceGeneration
    && sameTmuxServerIdentity(resourceGeneration, replacementGeneration),
  );
}

function tmuxServerIdentityOf(value: unknown): TmuxServerIdentity | undefined {
  return isTmuxServerIdentity(value) ? value : undefined;
}

/**
 * Applies only the property-level intent between two snapshots of one already
 * persisted pane. This is for lifecycle follow-up fields (for example
 * orchestration metadata) that arrive after the initial pane record is
 * durable. Concurrent writers can add agentSession or future fields without
 * being overwritten by a stale full-record upsert.
 */
export async function persistProjectPaneConfigPaneDelta(
  projectRoot: string,
  originatingPane: ProjectPaneConfigPane,
  nextPane: ProjectPaneConfigPane,
  options: ProjectPaneConfigLockOptions = {},
): Promise<ProjectPaneConfigMutationResult<ProjectPaneConfigPane>> {
  const originatingId = paneRecordId(originatingPane);
  const nextId = paneRecordId(nextPane);
  if (!originatingId || originatingId !== nextId) {
    throw new Error('Pane property delta requires matching persisted pane IDs');
  }

  return mutateProjectPaneConfig(projectRoot, (config) => {
    const panes = Array.isArray(config.panes) ? [...config.panes] : [];
    const index = panes.findIndex((pane) => paneRecordId(pane) === originatingId);
    if (index === -1) {
      throw new Error(
        `Cannot apply pane property delta: persisted pane "${originatingId}" no longer exists`,
      );
    }

    const delta = getPanePropertyDelta(originatingPane, nextPane);
    const merged = delta
      ? applyPanePropertyDelta(panes[index], delta)
      : panes[index];
    panes[index] = merged;
    config.panes = panes;
    config.lastUpdated = new Date().toISOString();
    return merged;
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

/**
 * Removes pane records only when every requested `{ id, paneId }` identity is
 * still exact under one config lease. Destructive callers use this after a
 * verified tmux teardown so a concurrent rebind cannot lose its replacement.
 */
export async function removeProjectPaneConfigPaneIdentities(
  projectRoot: string,
  identities: Iterable<ProjectPaneConfigPaneIdentity>,
  options: ProjectPaneConfigLockOptions = {},
): Promise<ProjectPaneConfigMutationResult<ProjectPaneConfigPane[]>> {
  return compareAndRemoveProjectPaneConfigPaneIdentities(
    projectRoot,
    identities,
    undefined,
    options,
  );
}

/**
 * Checks every exact `{ id, paneId }` identity and optionally runs a
 * destructive guard while the same config lease is held. This prevents a
 * stale UI record from killing or deleting a concurrent replacement pane.
 */
export async function compareAndRemoveProjectPaneConfigPaneIdentities(
  projectRoot: string,
  identities: Iterable<ProjectPaneConfigPaneIdentity>,
  beforeRemove: ProjectPaneConfigIdentityRemovalGuard | undefined,
  options: ProjectPaneConfigLockOptions = {},
): Promise<ProjectPaneConfigMutationResult<ProjectPaneConfigPane[]>> {
  const expected = Array.from(identities);
  const expectedById = new Map<string, ProjectPaneConfigPaneIdentity>();
  for (const identity of expected) {
    if (
      !identity
      || typeof identity.id !== 'string'
      || !identity.id
      || typeof identity.paneId !== 'string'
      || !identity.paneId
      || (
        identity.tmuxServerIdentity !== undefined
        && !isTmuxServerIdentity(identity.tmuxServerIdentity)
      )
      || expectedById.has(identity.id)
    ) {
      throw new Error('Pane identity removal requires unique non-empty IDs and pane IDs');
    }
    expectedById.set(identity.id, identity);
  }

  return transactProjectPaneConfig(projectRoot, async ({ config, persist }) => {
    const panes = Array.isArray(config.panes) ? [...config.panes] : [];
    for (const identity of expectedById.values()) {
      const current = panes.find((pane) => paneRecordId(pane) === identity.id);
      if (!current || !hasPaneRecordIdentity(current, identity)) {
        throw new Error(
          `Pane identity conflict for "${identity.id}": expected tmux pane "${identity.paneId}" is no longer current`,
        );
      }
    }

    const exactPanes = Array.from(expectedById.values()).map((identity) => (
      panes.find((pane) => hasPaneRecordIdentity(pane, identity))!
    ));
    await beforeRemove?.(panes, exactPanes);
    config.panes = panes.filter((pane) => {
      const identity = paneRecordIdentity(pane);
      return !identity || !expectedById.has(identity.id);
    });
    config.lastUpdated = new Date().toISOString();
    await persist();
    return config.panes;
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
  assertUniquePaneIds(config.panes, configPath);
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

function paneRecordIdentity(
  value: ProjectPaneConfigPane,
): ProjectPaneConfigPaneIdentity | undefined {
  const id = paneRecordId(value);
  if (!id) {
    return undefined;
  }
  const paneId = asRecord(value).paneId;
  const tmuxServerIdentity = tmuxServerIdentityOf(
    asRecord(value).tmuxServerIdentity,
  );
  return {
    id,
    paneId: typeof paneId === 'string' && paneId.length > 0 ? paneId : id,
    ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
  };
}

function hasPaneRecordIdentity(
  value: ProjectPaneConfigPane,
  expected: ProjectPaneConfigPaneIdentity,
): boolean {
  const identity = paneRecordIdentity(value);
  if (
    !identity
    || identity.id !== expected.id
    || identity.paneId !== expected.paneId
  ) {
    return false;
  }

  if (!identity.tmuxServerIdentity || !expected.tmuxServerIdentity) {
    return (
      identity.tmuxServerIdentity === undefined
      && expected.tmuxServerIdentity === undefined
    );
  }

  return sameTmuxServerIdentity(
    identity.tmuxServerIdentity,
    expected.tmuxServerIdentity,
  );
}

function assertUniquePaneIds(
  panes: readonly ProjectPaneConfigPane[] | undefined,
  configPath: string,
): void {
  if (!panes) {
    return;
  }

  const seen = new Set<string>();
  for (const pane of panes) {
    const id = paneRecordId(pane);
    if (!id) {
      continue;
    }
    if (seen.has(id)) {
      throw new ProjectPaneConfigError(
        'config_corrupt',
        `${configPath} contains duplicate pane ID "${id}"`,
      );
    }
    seen.add(id);
  }

  const tmuxConflict = findTmuxResourceConflict(
    panes as readonly (Pick<PsychePane, 'id'> & Record<string, unknown>)[],
  );
  if (tmuxConflict) {
    throw new ProjectPaneConfigError(
      'config_corrupt',
      `${configPath} contains duplicate tmux ${tmuxConflict.resource.kind} ID "${
        tmuxConflict.resource.id
      }" owned by panes "${tmuxConflict.firstOwnerId}" and "${
        tmuxConflict.secondOwnerId
      }" in the same server generation`,
    );
  }
}

interface PanePropertyDelta {
  changed: Map<string, unknown>;
  deleted: Set<string>;
}

function getPanePropertyDelta(
  originatingPane: ProjectPaneConfigPane,
  nextPane: ProjectPaneConfigPane,
): PanePropertyDelta | undefined {
  const originating = asRecord(originatingPane);
  const next = asRecord(nextPane);
  const changed = new Map<string, unknown>();
  const deleted = new Set<string>();
  const properties = new Set([
    ...Object.keys(originating),
    ...Object.keys(next),
  ]);

  for (const property of properties) {
    if (property === 'id') {
      continue;
    }

    const hadOriginatingValue = hasOwnProperty(originating, property);
    const hasNextValue = hasOwnProperty(next, property);
    const originatingValue = originating[property];
    const nextValue = next[property];

    if (
      hadOriginatingValue
      && originatingValue !== undefined
      && (!hasNextValue || nextValue === undefined)
    ) {
      deleted.add(property);
      continue;
    }

    if (
      hasNextValue
      && nextValue !== undefined
      && (
        !hadOriginatingValue
        || originatingValue === undefined
        || !panePropertyValuesEqual(originatingValue, nextValue)
      )
    ) {
      changed.set(property, nextValue);
    }
  }

  return changed.size > 0 || deleted.size > 0
    ? { changed, deleted }
    : undefined;
}

function applyPanePropertyDelta(
  freshPane: ProjectPaneConfigPane,
  delta: PanePropertyDelta,
): ProjectPaneConfigPane {
  const merged = {
    ...asRecord(freshPane),
  };
  for (const property of delta.deleted) {
    delete merged[property];
  }
  for (const [property, value] of delta.changed) {
    merged[property] = value;
  }
  return merged;
}

function hasOwnProperty(value: object, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function panePropertyValuesEqual(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
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

/**
 * Move a verified owned lock out of the acquisition name before deleting it.
 * A recursive rm of the live lock path can race a waiting contender on macOS,
 * producing ENOTEMPTY and leaving an apparently active lock behind. Rename is
 * atomic, so the lock is released once this succeeds; deletion is best effort.
 */
async function releaseOwnedConfigLock(
  lockDir: string,
  nonce: string,
): Promise<void> {
  const current = await readLockRecord(lockDir);
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
    // The ownership lock has already been atomically released. A later
    // runtime cleanup may remove this nonce-specific tombstone safely.
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
