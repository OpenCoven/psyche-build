import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from '../utils/atomicWrite.js';
import {
  acquireProjectPaneSlugAllocationLock,
  acquireProjectWorktreeRecoveryLock,
} from './ProjectPaneConfig.js';
import {
  findBlockingPaneSlugOwnership,
  isPaneSlugOwnerStale,
  listPaneSlugOwnershipRecords,
  readPaneSlugOwnershipRecord,
  quarantinePaneSlugOwnershipRecord,
  removePaneSlugOwnershipRecord,
  type PaneSlugOwnershipRecord,
  type PaneSlugOwnershipState,
} from './PaneSlugRegistry.js';
import { canonicalizePathWithExistingAncestor } from './WorktreePath.js';

const RECOVERY_DIRECTORY_NAME = 'worktree-recovery';
const RECOVERY_MARKER_VERSION = 5;

export interface WorktreeRecoveryMarker {
  version: number;
  id: string;
  recoveryId?: string;
  generation?: string;
  sessionProjectRoot?: string;
  projectRoot: string;
  worktreePath: string;
  pane: {
    id: string;
    paneId: string;
    slug?: string;
  };
  allowWorktreeReuse?: boolean;
  paneOwnershipState?: PaneSlugOwnershipState;
  operation: string;
  reason: string;
  createdAt: string;
  operatorInstructions: string;
}

export interface WorktreeRecoveryMarkerRequest {
  recoveryId?: string;
  sessionProjectRoot?: string;
  projectRoot: string;
  worktreePath: string;
  pane: {
    id: string;
    paneId: string;
    slug?: string;
  };
  allowWorktreeReuse?: boolean;
  operation: string;
  reason: string;
}

export interface BlockingWorktreeRecoveryMarker {
  blocked: boolean;
  reason?: string;
  marker?: WorktreeRecoveryMarker;
}

export interface WorktreeRecoveryMarkerWriteResult {
  marker: WorktreeRecoveryMarker;
  path: string;
  state: 'complete' | 'target-marker-only';
  warning?: string;
}

/**
 * The destructive cleanup marker is target-project-wide. The linked slug
 * quarantine remains session-local, so unrelated sessions share cleanup
 * authority without sharing pane names.
 *
 * Lock order is target recovery -> session slug. The target marker is written
 * before the session quarantine, so every crash prefix remains fail-closed for
 * destructive target-project cleanup.
 */
export async function writeWorktreeRecoveryMarker(
  request: WorktreeRecoveryMarkerRequest,
  options: {
    persistPaneQuarantine?: typeof quarantinePaneSlugOwnershipRecord;
  } = {},
): Promise<WorktreeRecoveryMarkerWriteResult> {
  if (request.allowWorktreeReuse && !request.pane.slug) {
    throw new Error('Reusable recovery quarantine requires a pane slug');
  }
  const projectRoot = canonicalizePathWithExistingAncestor(request.projectRoot);
  const sessionProjectRoot = canonicalizePathWithExistingAncestor(
    request.sessionProjectRoot || projectRoot,
  );
  const worktreePath = canonicalizePathWithExistingAncestor(request.worktreePath);
  const recoveryId = request.recoveryId || randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(recoveryId)) {
    throw new Error('Worktree recovery ID must be a UUID');
  }
  const id = recoveryMarkerId(projectRoot, worktreePath, recoveryId);
  const marker: WorktreeRecoveryMarker = {
    version: RECOVERY_MARKER_VERSION,
    id,
    recoveryId,
    generation: recoveryId,
    sessionProjectRoot,
    projectRoot,
    worktreePath,
    pane: {
      id: request.pane.id,
      paneId: request.pane.paneId,
      ...(request.pane.slug ? { slug: request.pane.slug } : {}),
    },
    ...(request.allowWorktreeReuse ? { allowWorktreeReuse: true } : {}),
    ...(request.pane.slug
      ? { paneOwnershipState: 'provisional' as const }
      : {}),
    operation: request.operation,
    reason: request.reason,
    createdAt: new Date().toISOString(),
    operatorInstructions: [
      `Inspect tmux pane ${request.pane.paneId} before changing ${worktreePath}.`,
      ...(request.pane.slug
        ? [`Treat pane slug ${request.pane.slug} as occupied until reconciliation completes.`]
        : []),
      `After reconciling the pane registry, run \`psyche recover --project "${projectRoot}" --acknowledge ${id}\`.`,
      'Until that explicit acknowledgement, Psyche will refuse destructive worktree cleanup.',
    ].join(' '),
  };
  const targetLock = await acquireProjectWorktreeRecoveryLock(projectRoot);
  try {
    const directory = worktreeRecoveryMarkerDirectory(projectRoot);
    const markerPath = path.join(directory, `${id}.json`);
    await mkdir(directory, { recursive: true });
    await atomicWriteJson(markerPath, marker);

    let slugLock: Awaited<ReturnType<typeof acquireProjectPaneSlugAllocationLock>>
      | undefined;
    if (request.pane.slug) {
      slugLock = await acquireProjectPaneSlugAllocationLock(sessionProjectRoot);
    }
    try {
      if (request.pane.slug) {
        try {
          await (
            options.persistPaneQuarantine ?? quarantinePaneSlugOwnershipRecord
          )({
            sessionProjectRoot,
            recoveryId,
            projectRoot,
            worktreePath,
            slug: request.pane.slug,
            pane: {
              id: request.pane.id,
              paneId: request.pane.paneId,
            },
            operation: request.operation,
            reason: request.reason,
            targetMarkerId: id,
          });
        } catch (error) {
          return {
            marker,
            path: markerPath,
            state: 'target-marker-only',
            warning: `target cleanup remains blocked, but pane slug ${request.pane.slug} was not quarantined in session ${sessionProjectRoot}: ${errorMessage(error)}`,
          };
        }
        const completedMarker: WorktreeRecoveryMarker = {
          ...marker,
          paneOwnershipState: 'quarantined',
        };
        try {
          await atomicWriteJson(markerPath, completedMarker);
        } catch (error) {
          return {
            marker,
            path: markerPath,
            state: 'target-marker-only',
            warning: `pane slug ${request.pane.slug} was quarantined, but target marker ${id} remains provisional until reconciliation rewrites it: ${errorMessage(error)}`,
          };
        }
        return {
          marker: completedMarker,
          path: markerPath,
          state: 'complete',
        };
      }
      return {
        marker,
        path: markerPath,
        state: 'complete',
      };
    } finally {
      await slugLock?.release();
    }

  } finally {
    await targetLock.release();
  }
}

export async function writeProvisionalPaneSlugCleanupBlockerUnderLock(
  record: PaneSlugOwnershipRecord,
): Promise<{ marker: WorktreeRecoveryMarker; path: string }> {
  const marker = buildPaneSlugCleanupMarker(record, 'provisional');
  const directory = worktreeRecoveryMarkerDirectory(record.projectRoot);
  const markerPath = path.join(directory, `${marker.id}.json`);
  await mkdir(directory, { recursive: true });
  await atomicWriteJson(markerPath, marker);
  return { marker, path: markerPath };
}

export async function removePaneSlugCleanupBlocker(
  record: Pick<
    PaneSlugOwnershipRecord,
    'projectRoot' | 'worktreePath' | 'recoveryId' | 'targetMarkerId'
  >,
): Promise<boolean> {
  const targetRoot = canonicalizePathWithExistingAncestor(record.projectRoot);
  const markerId = record.targetMarkerId || recoveryMarkerId(
    targetRoot,
    canonicalizePathWithExistingAncestor(record.worktreePath),
    record.recoveryId,
  );
  const targetLock = await acquireProjectWorktreeRecoveryLock(targetRoot);
  try {
    const marker = await readMarkerIfPresent(targetRoot, markerId);
    if (!marker || marker.recoveryId !== record.recoveryId) {
      return false;
    }
    try {
      await rm(path.join(
        worktreeRecoveryMarkerDirectory(targetRoot),
        `${markerId}.json`,
      ));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  } finally {
    await targetLock.release();
  }
}

export async function ensurePaneSlugCleanupBlocker(
  record: PaneSlugOwnershipRecord,
): Promise<void> {
  const expectedId = recoveryMarkerId(
    record.projectRoot,
    record.worktreePath,
    record.recoveryId,
  );
  const targetLock = await acquireProjectWorktreeRecoveryLock(record.projectRoot);
  try {
    const existing = await readMarkerIfPresent(record.projectRoot, expectedId);
    if (existing?.recoveryId === record.recoveryId) {
      return;
    }
    const marker = buildPaneSlugCleanupMarker(record, record.state);
    const directory = worktreeRecoveryMarkerDirectory(record.projectRoot);
    await mkdir(directory, { recursive: true });
    await atomicWriteJson(path.join(directory, `${marker.id}.json`), marker);
  } finally {
    await targetLock.release();
  }
}

export async function listWorktreeRecoveryMarkers(
  projectRoot: string,
): Promise<WorktreeRecoveryMarker[]> {
  const directory = worktreeRecoveryMarkerDirectory(projectRoot);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const markers: WorktreeRecoveryMarker[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const markerPath = path.join(directory, entry);
    const parsed = JSON.parse(await readFile(markerPath, 'utf8')) as unknown;
    if (!isWorktreeRecoveryMarker(parsed)) {
      throw new Error(`Invalid worktree recovery marker: ${markerPath}`);
    }
    markers.push(parsed);
  }
  return markers.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function listQuarantinedPaneSlugs(
  sessionProjectRoot: string,
): Promise<string[]> {
  const records = await listPaneSlugOwnershipRecords(sessionProjectRoot);
  const legacyMarkers = await listWorktreeRecoveryMarkers(sessionProjectRoot);
  return Array.from(new Set([
    ...records.flatMap((record) => (
      record.state === 'quarantined' ? [record.slug] : []
    )),
    ...legacyMarkers.flatMap((marker) => (
      marker.version < RECOVERY_MARKER_VERSION && marker.pane.slug
        ? [marker.pane.slug]
        : []
    )),
  ])).sort();
}

/**
 * Acknowledgement coordinates the target marker and its originating
 * session-local slug record. Both namespace locks make concurrent
 * acknowledgement idempotent; each record is removed at most once.
 */
export async function acknowledgeWorktreeRecoveryMarker(
  projectRoot: string,
  markerId: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(markerId)) {
    throw new Error('Recovery marker ID must be a SHA-256 hex identifier');
  }
  const suppliedRoot = canonicalizePathWithExistingAncestor(projectRoot);
  const directMarker = await readMarkerIfPresent(suppliedRoot, markerId);
  const suppliedRecords = await listPaneSlugOwnershipRecords(suppliedRoot);
  const linkedRecord = suppliedRecords.find(
    (record) => record.targetMarkerId === markerId,
  );
  const targetRoot = directMarker?.projectRoot || linkedRecord?.projectRoot;
  if (!targetRoot) {
    return false;
  }

  const targetLock = await acquireProjectWorktreeRecoveryLock(targetRoot);
  try {
    const marker = await readMarkerIfPresent(targetRoot, markerId);
    const sessionProjectRoot = marker?.sessionProjectRoot
      || linkedRecord?.sessionProjectRoot;
    let slugLock: Awaited<ReturnType<typeof acquireProjectPaneSlugAllocationLock>>
      | undefined;
    if (sessionProjectRoot) {
      slugLock = await acquireProjectPaneSlugAllocationLock(sessionProjectRoot);
    }
    try {
      let removed = false;
      const recoveryId = marker?.recoveryId || linkedRecord?.recoveryId;
      if (sessionProjectRoot && recoveryId) {
        const currentRecord = await readPaneSlugOwnershipRecord(
          sessionProjectRoot,
          recoveryId,
        );
        if (
          currentRecord?.state === 'provisional'
          && !isPaneSlugOwnerStale(currentRecord)
        ) {
          throw new Error(
            `Pane slug recovery ${recoveryId} is still owned by an active producer`,
          );
        }
        if (currentRecord?.state === 'provisional') {
          throw new Error(
            `Pane slug recovery ${recoveryId} requires restart reconciliation before acknowledgement`,
          );
        }
        removed = await removePaneSlugOwnershipRecord(
          sessionProjectRoot,
          recoveryId,
        ) || removed;
      }
      try {
        await rm(path.join(
          worktreeRecoveryMarkerDirectory(targetRoot),
          `${markerId}.json`,
        ));
        removed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      return removed;
    } finally {
      await slugLock?.release();
    }
  } finally {
    await targetLock.release();
  }
}

/**
 * Cleanup authority always comes from the target project's durable namespace.
 * The current session registry is also checked by recovery ID so a missing
 * target marker cannot make that session's provisional ownership fail open.
 */
export function findBlockingWorktreeRecoveryMarker(
  sessionProjectRoot: string,
  targetProjectRoot: string,
  targetWorktreePath: string,
  authorizedRecoveryId?: string,
): BlockingWorktreeRecoveryMarker {
  return findBlockingRecoveryMarker(
    sessionProjectRoot,
    targetProjectRoot,
    targetWorktreePath,
    false,
    authorizedRecoveryId,
  );
}

export function findBlockingWorktreeReuseRecoveryMarker(
  sessionProjectRoot: string,
  targetProjectRoot: string,
  targetWorktreePath: string,
  authorizedRecoveryId?: string,
): BlockingWorktreeRecoveryMarker {
  return findBlockingRecoveryMarker(
    sessionProjectRoot,
    targetProjectRoot,
    targetWorktreePath,
    true,
    authorizedRecoveryId,
  );
}

function findBlockingRecoveryMarker(
  sessionProjectRoot: string,
  targetProjectRoot: string,
  targetWorktreePath: string,
  allowReusablePaneQuarantines: boolean,
  authorizedRecoveryId?: string,
): BlockingWorktreeRecoveryMarker {
  const targetProject = canonicalizePathWithExistingAncestor(targetProjectRoot);
  const sessionProject = canonicalizePathWithExistingAncestor(sessionProjectRoot);
  const ownership = findBlockingPaneSlugOwnership(
    sessionProject,
    targetProject,
    targetWorktreePath,
    allowReusablePaneQuarantines,
    authorizedRecoveryId,
  );
  if (ownership.blocked) {
    return {
      blocked: true,
      reason: ownership.reason,
    };
  }
  const directories = Array.from(new Set([
    worktreeRecoveryMarkerDirectory(targetProject),
    worktreeRecoveryMarkerDirectory(sessionProject),
  ]));
  if (!directories.some((directory) => existsSync(directory))) {
    return { blocked: false };
  }

  const target = canonicalizePathWithExistingAncestor(targetWorktreePath);
  for (const directory of directories) {
    if (!existsSync(directory)) {
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch (error) {
      return {
        blocked: true,
        reason: `could not read recovery marker directory: ${errorMessage(error)}`,
      };
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const markerPath = path.join(directory, entry);
      let marker: unknown;
      try {
        marker = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown;
      } catch (error) {
        return {
          blocked: true,
          reason: `could not read recovery marker ${markerPath}: ${errorMessage(error)}`,
        };
      }
      if (!isWorktreeRecoveryMarker(marker)) {
        return {
          blocked: true,
          reason: `invalid recovery marker ${markerPath}`,
        };
      }
      if (
        canonicalizePathWithExistingAncestor(marker.projectRoot) !== targetProject
      ) {
        if (directory === worktreeRecoveryMarkerDirectory(targetProject)) {
          return {
            blocked: true,
            reason: `recovery marker ${markerPath} belongs to another target project`,
          };
        }
        continue;
      }
      if (
        pathsOverlap(marker.worktreePath, target)
        && marker.recoveryId !== authorizedRecoveryId
        && !(
          allowReusablePaneQuarantines
          && marker.allowWorktreeReuse === true
          && marker.paneOwnershipState !== 'provisional'
        )
      ) {
        return {
          blocked: true,
          marker,
          reason: `recovery marker ${marker.id} requires operator acknowledgement`,
        };
      }
    }
  }

  return { blocked: false };
}

export function worktreeRecoveryMarkerDirectory(projectRoot: string): string {
  return path.join(
    canonicalizePathWithExistingAncestor(projectRoot),
    '.psyche',
    'runtime',
    RECOVERY_DIRECTORY_NAME,
  );
}

async function readMarkerIfPresent(
  projectRoot: string,
  markerId: string,
): Promise<WorktreeRecoveryMarker | undefined> {
  try {
    const parsed = JSON.parse(await readFile(
      path.join(worktreeRecoveryMarkerDirectory(projectRoot), `${markerId}.json`),
      'utf8',
    )) as unknown;
    if (!isWorktreeRecoveryMarker(parsed)) {
      throw new Error(`Invalid worktree recovery marker ${markerId}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function recoveryMarkerId(
  projectRoot: string,
  worktreePath: string,
  recoveryId: string,
): string {
  return createHash('sha256')
    .update(`${projectRoot}\0${worktreePath}\0${recoveryId}`)
    .digest('hex');
}

function buildPaneSlugCleanupMarker(
  record: PaneSlugOwnershipRecord,
  state: PaneSlugOwnershipState,
): WorktreeRecoveryMarker {
  const projectRoot = canonicalizePathWithExistingAncestor(record.projectRoot);
  const sessionProjectRoot = canonicalizePathWithExistingAncestor(
    record.sessionProjectRoot,
  );
  const worktreePath = canonicalizePathWithExistingAncestor(record.worktreePath);
  const id = recoveryMarkerId(projectRoot, worktreePath, record.recoveryId);
  return {
    version: RECOVERY_MARKER_VERSION,
    id,
    recoveryId: record.recoveryId,
    generation: record.recoveryId,
    sessionProjectRoot,
    projectRoot,
    worktreePath,
    pane: {
      id: record.pane.id,
      paneId: record.pane.paneId || 'unresolved',
      slug: record.slug,
    },
    ...(state === 'quarantined' ? { allowWorktreeReuse: true } : {}),
    paneOwnershipState: state,
    operation: record.operation,
    reason: record.reason || (
      state === 'provisional'
        ? 'pane slug ownership is provisional'
        : 'pane slug ownership requires reconciliation'
    ),
    createdAt: record.createdAt,
    operatorInstructions: [
      `Inspect pane ownership recovery ${record.recoveryId} before changing ${worktreePath}.`,
      `Treat pane slug ${record.slug} as occupied until reconciliation completes.`,
      `After reconciling the pane registry, run \`psyche recover --project "${projectRoot}" --acknowledge ${id}\`.`,
      'Until that explicit acknowledgement, Psyche will refuse destructive worktree cleanup.',
    ].join(' '),
  };
}

function isWorktreeRecoveryMarker(value: unknown): value is WorktreeRecoveryMarker {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const marker = value as Partial<WorktreeRecoveryMarker>;
  return (
    (
      marker.version === 1
      || marker.version === 2
      || marker.version === 4
      || marker.version === RECOVERY_MARKER_VERSION
    )
    && typeof marker.id === 'string'
    && /^[a-f0-9]{64}$/.test(marker.id)
    && (
      marker.version !== RECOVERY_MARKER_VERSION
      || (
        typeof marker.recoveryId === 'string'
        && /^[0-9a-f-]{36}$/i.test(marker.recoveryId)
        && marker.generation === marker.recoveryId
        && typeof marker.sessionProjectRoot === 'string'
      )
    )
    && typeof marker.projectRoot === 'string'
    && typeof marker.worktreePath === 'string'
    && typeof marker.pane?.id === 'string'
    && typeof marker.pane?.paneId === 'string'
    && (
      marker.pane.slug === undefined
      || typeof marker.pane.slug === 'string'
    )
    && (
      marker.allowWorktreeReuse === undefined
      || typeof marker.allowWorktreeReuse === 'boolean'
    )
    && (
      marker.paneOwnershipState === undefined
      || marker.paneOwnershipState === 'provisional'
      || marker.paneOwnershipState === 'quarantined'
    )
    && (
      marker.allowWorktreeReuse !== true
      || (
        typeof marker.pane.slug === 'string'
        && marker.pane.slug.length > 0
      )
    )
    && typeof marker.operation === 'string'
    && typeof marker.reason === 'string'
    && typeof marker.createdAt === 'string'
    && typeof marker.operatorInstructions === 'string'
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathInsideOrEqual(left, right) || isPathInsideOrEqual(right, left);
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
