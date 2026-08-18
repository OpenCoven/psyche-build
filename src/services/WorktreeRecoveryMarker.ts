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
  listPaneSlugOwnershipRecords,
  quarantinePaneSlugOwnershipRecord,
  removePaneSlugOwnershipRecord,
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

/**
 * The destructive cleanup marker is target-project-wide. The linked slug
 * quarantine remains session-local, so unrelated sessions share cleanup
 * authority without sharing pane names.
 *
 * Lock order is target recovery -> session slug. The target marker is written
 * only after the slug record is durable, so a crash can leave an
 * over-conservative slug quarantine but never an unguarded cleanup target.
 */
export async function writeWorktreeRecoveryMarker(
  request: WorktreeRecoveryMarkerRequest,
): Promise<{ marker: WorktreeRecoveryMarker; path: string }> {
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
  const id = recoveryMarkerId(projectRoot, worktreePath, request.pane, recoveryId);
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
    let slugLock: Awaited<ReturnType<typeof acquireProjectPaneSlugAllocationLock>>
      | undefined;
    if (request.pane.slug) {
      slugLock = await acquireProjectPaneSlugAllocationLock(sessionProjectRoot);
    }
    try {
      if (request.pane.slug) {
        await quarantinePaneSlugOwnershipRecord({
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
      }
      const directory = worktreeRecoveryMarkerDirectory(projectRoot);
      const markerPath = path.join(directory, `${id}.json`);
      await mkdir(directory, { recursive: true });
      await atomicWriteJson(markerPath, marker);
      return { marker, path: markerPath };
    } finally {
      await slugLock?.release();
    }
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
 * The session argument remains for API compatibility but is intentionally not
 * used to scope destructive recovery.
 */
export function findBlockingWorktreeRecoveryMarker(
  sessionProjectRoot: string,
  targetProjectRoot: string,
  targetWorktreePath: string,
): BlockingWorktreeRecoveryMarker {
  return findBlockingRecoveryMarker(
    sessionProjectRoot,
    targetProjectRoot,
    targetWorktreePath,
    false,
  );
}

export function findBlockingWorktreeReuseRecoveryMarker(
  sessionProjectRoot: string,
  targetProjectRoot: string,
  targetWorktreePath: string,
): BlockingWorktreeRecoveryMarker {
  return findBlockingRecoveryMarker(
    sessionProjectRoot,
    targetProjectRoot,
    targetWorktreePath,
    true,
  );
}

function findBlockingRecoveryMarker(
  sessionProjectRoot: string,
  targetProjectRoot: string,
  targetWorktreePath: string,
  allowReusablePaneQuarantines: boolean,
): BlockingWorktreeRecoveryMarker {
  const targetProject = canonicalizePathWithExistingAncestor(targetProjectRoot);
  const sessionProject = canonicalizePathWithExistingAncestor(sessionProjectRoot);
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
        && !(allowReusablePaneQuarantines && marker.allowWorktreeReuse === true)
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
  pane: { id: string; paneId: string },
  recoveryId: string,
): string {
  return createHash('sha256')
    .update(`${projectRoot}\0${worktreePath}\0${pane.id}\0${pane.paneId}\0${recoveryId}`)
    .digest('hex');
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
