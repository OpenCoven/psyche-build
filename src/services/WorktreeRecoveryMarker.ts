import { createHash } from 'node:crypto';
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
const RECOVERY_MARKER_VERSION = 1;

export interface WorktreeRecoveryMarker {
  version: number;
  id: string;
  projectRoot: string;
  worktreePath: string;
  pane: {
    id: string;
    paneId: string;
  };
  operation: string;
  reason: string;
  createdAt: string;
  operatorInstructions: string;
}

export interface WorktreeRecoveryMarkerRequest {
  projectRoot: string;
  worktreePath: string;
  pane: {
    id: string;
    paneId: string;
  };
  operation: string;
  reason: string;
}

export interface BlockingWorktreeRecoveryMarker {
  blocked: boolean;
  reason?: string;
  marker?: WorktreeRecoveryMarker;
}

/**
 * Recovery markers live in the project runtime directory, never beside a
 * pane config or inside a worktree that may need to be removed. They keep
 * later cleanup attempts conservative after a live pane could not be tracked.
 */
export async function writeWorktreeRecoveryMarker(
  request: WorktreeRecoveryMarkerRequest,
): Promise<{ marker: WorktreeRecoveryMarker; path: string }> {
  const projectRoot = canonicalizePathWithExistingAncestor(request.projectRoot);
  const worktreePath = canonicalizePathWithExistingAncestor(request.worktreePath);
  const id = recoveryMarkerId(projectRoot, worktreePath, request.pane);
  const marker: WorktreeRecoveryMarker = {
    version: RECOVERY_MARKER_VERSION,
    id,
    projectRoot,
    worktreePath,
    pane: {
      id: request.pane.id,
      paneId: request.pane.paneId,
    },
    operation: request.operation,
    reason: request.reason,
    createdAt: new Date().toISOString(),
    operatorInstructions: [
      `Inspect tmux pane ${request.pane.paneId} before changing ${worktreePath}.`,
      `After reconciling the pane registry, run \`psyche recover --project "${projectRoot}" --acknowledge ${id}\`.`,
      'Until that explicit acknowledgement, Psyche will refuse destructive worktree cleanup.',
    ].join(' '),
  };
  const directory = worktreeRecoveryMarkerDirectory(projectRoot);
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
  projectRoot: string,
  targetWorktreePath: string,
): BlockingWorktreeRecoveryMarker {
  const directory = worktreeRecoveryMarkerDirectory(projectRoot);
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
    if (pathsOverlap(marker.worktreePath, target)) {
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
): string {
  return createHash('sha256')
    .update(`${projectRoot}\0${worktreePath}\0${pane.id}\0${pane.paneId}`)
    .digest('hex');
}

function isWorktreeRecoveryMarker(value: unknown): value is WorktreeRecoveryMarker {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const marker = value as Partial<WorktreeRecoveryMarker>;
  return (
    marker.version === RECOVERY_MARKER_VERSION
    && typeof marker.id === 'string'
    && /^[a-f0-9]{64}$/.test(marker.id)
    && typeof marker.projectRoot === 'string'
    && typeof marker.worktreePath === 'string'
    && typeof marker.pane?.id === 'string'
    && typeof marker.pane?.paneId === 'string'
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
