import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from '../utils/atomicWrite.js';
import { canonicalizePathWithExistingAncestor } from './WorktreePath.js';

const RECOVERY_DIRECTORY_NAME = 'worktree-recovery';
const RECOVERY_MARKER_VERSION = 4;

export interface WorktreeRecoveryMarker {
  version: number;
  id: string;
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
 * Recovery markers live beside the pane registry that owns the pane slug,
 * never inside a target worktree that may need to be removed. The marker
 * separately records the target project/worktree identity for cleanup checks.
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
  const generation = randomUUID();
  const id = recoveryMarkerId(projectRoot, worktreePath, request.pane, generation);
  const marker: WorktreeRecoveryMarker = {
    version: RECOVERY_MARKER_VERSION,
    id,
    generation,
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
      `After reconciling the pane registry, run \`psyche recover --project "${sessionProjectRoot}" --acknowledge ${id}\`.`,
      'Until that explicit acknowledgement, Psyche will refuse destructive worktree cleanup.',
    ].join(' '),
  };
  const directory = worktreeRecoveryMarkerDirectory(sessionProjectRoot);
  const markerPath = path.join(directory, `${id}.json`);
  await mkdir(directory, { recursive: true });
  await atomicWriteJson(markerPath, marker);
  return { marker, path: markerPath };
}

export async function listWorktreeRecoveryMarkers(
  projectRoot: string,
): Promise<WorktreeRecoveryMarker[]> {
  const directory = worktreeRecoveryMarkerDirectory(projectRoot);
  let entries: string[];
  try {
    entries = await (await import('node:fs/promises')).readdir(directory);
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
    const raw = await (await import('node:fs/promises')).readFile(
      path.join(directory, entry),
      'utf8',
    );
    const parsed = JSON.parse(raw) as unknown;
    if (!isWorktreeRecoveryMarker(parsed)) {
      throw new Error(`Invalid worktree recovery marker: ${path.join(directory, entry)}`);
    }
    markers.push(parsed);
  }
  return markers.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function listQuarantinedPaneSlugs(
  projectRoot: string,
): Promise<string[]> {
  const markers = await listWorktreeRecoveryMarkers(projectRoot);
  return Array.from(new Set(markers.flatMap((marker) => (
    marker.pane.slug ? [marker.pane.slug] : []
  )))).sort();
}

/**
 * Acknowledge is intentionally explicit and does not attempt to kill panes,
 * edit pane config, or release a live process's lease. It only removes the
 * durable block after an operator has completed those checks.
 */
export async function acknowledgeWorktreeRecoveryMarker(
  projectRoot: string,
  markerId: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(markerId)) {
    throw new Error('Recovery marker ID must be a SHA-256 hex identifier');
  }
  const markerPath = path.join(
    worktreeRecoveryMarkerDirectory(projectRoot),
    `${markerId}.json`,
  );
  try {
    await rm(markerPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Cleanup paths use this synchronous conservative check immediately before a
 * destructive Git command. A malformed or unreadable marker is itself a
 * reason to stop: silently ignoring it would defeat crash recovery.
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
  const canonicalSessionProjectRoot = canonicalizePathWithExistingAncestor(
    sessionProjectRoot,
  );
  const directory = worktreeRecoveryMarkerDirectory(canonicalSessionProjectRoot);
  if (!existsSync(directory)) {
    return { blocked: false };
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

  const target = canonicalizePathWithExistingAncestor(targetWorktreePath);
  const targetProject = canonicalizePathWithExistingAncestor(targetProjectRoot);
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
      marker.version === RECOVERY_MARKER_VERSION
      && canonicalizePathWithExistingAncestor(marker.sessionProjectRoot!)
        !== canonicalSessionProjectRoot
    ) {
      return {
        blocked: true,
        reason: `recovery marker ${markerPath} belongs to another session project`,
      };
    }
    if (
      canonicalizePathWithExistingAncestor(marker.projectRoot) === targetProject
      &&
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

function recoveryMarkerId(
  projectRoot: string,
  worktreePath: string,
  pane: { id: string; paneId: string },
  generation: string,
): string {
  return createHash('sha256')
    .update(`${projectRoot}\0${worktreePath}\0${pane.id}\0${pane.paneId}\0${generation}`)
    .digest('hex');
}

function isWorktreeRecoveryMarker(value: unknown): value is WorktreeRecoveryMarker {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const marker = value as Partial<WorktreeRecoveryMarker>;
  return (
    (marker.version === 1 || marker.version === 2 || marker.version === RECOVERY_MARKER_VERSION)
    && typeof marker.id === 'string'
    && /^[a-f0-9]{64}$/.test(marker.id)
    && (
      marker.version === 1
      || (
        typeof marker.generation === 'string'
        && /^[0-9a-f-]{36}$/i.test(marker.generation)
      )
      && (
        marker.version !== RECOVERY_MARKER_VERSION
        || typeof marker.sessionProjectRoot === 'string'
      )
    )
    && typeof marker.projectRoot === 'string'
    && typeof marker.worktreePath === 'string'
    && typeof marker.pane?.id === 'string'
    && typeof marker.pane?.paneId === 'string'
    && (
      marker.version !== RECOVERY_MARKER_VERSION
      || marker.pane.slug === undefined
      || typeof marker.pane.slug === 'string'
    )
    && (
      marker.version !== RECOVERY_MARKER_VERSION
      || marker.allowWorktreeReuse === undefined
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
