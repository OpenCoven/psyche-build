import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createCovenClient, type CovenClient } from '../daemon/bridge.js';

export type CovenSessionVisibilityStatus =
  | 'created'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'orphaned'
  | 'archived'
  | string;

export interface CovenSessionVisibility {
  id: string;
  projectRoot: string;
  cwd?: string;
  harness?: string;
  title?: string;
  status?: CovenSessionVisibilityStatus;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string;
}

export type CovenSessionsSource =
  | 'coven daemon API'
  | 'coven sessions --json --all'
  | 'coven sessions --json';

export type CovenSessionsLoadState =
  | {
      status: 'ready';
      sessions: CovenSessionVisibility[];
      source: CovenSessionsSource;
      loadedAt: string;
    }
  | {
      status: 'empty';
      sessions: [];
      source: CovenSessionsSource;
      loadedAt: string;
    }
  | {
      status: 'unavailable';
      sessions: [];
      reason: string;
      loadedAt: string;
    };

export interface ListCovenSessionsOptions {
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ListCovenDaemonSessionsOptions {
  client?: Pick<CovenClient, 'listSessions'>;
}

export async function listCovenSessionsFromDaemon(
  options: ListCovenDaemonSessionsOptions = {},
): Promise<CovenSessionsLoadState> {
  try {
    const client = options.client || createCovenClient();
    const sessions = await client.listSessions();
    const loadedAt = new Date().toISOString();
    return sessions.length > 0
      ? { status: 'ready', sessions, source: 'coven daemon API', loadedAt }
      : { status: 'empty', sessions: [], source: 'coven daemon API', loadedAt };
  } catch (error) {
    return {
      status: 'unavailable',
      sessions: [],
      reason: describeCovenUnavailable(error),
      loadedAt: new Date().toISOString(),
    };
  }
}

export function parseCovenSessionsJson(stdout: string): CovenSessionVisibility[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  const parsed = JSON.parse(trimmed) as unknown;
  const rawSessions = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.sessions)
      ? parsed.sessions
      : [];

  return rawSessions.flatMap((raw) => {
    const session = normalizeCovenSession(raw);
    return session ? [session] : [];
  });
}

export async function listCovenSessionsFromCli(
  options: ListCovenSessionsOptions = {},
): Promise<CovenSessionsLoadState> {
  const command = options.command || 'coven';
  const timeoutMs = options.timeoutMs ?? 1_500;

  try {
    const result = await listCovenSessionsJson(command, {
      cwd: options.cwd,
      timeout: timeoutMs,
      env: options.env,
    });
    const sessions = parseCovenSessionsJson(result.stdout);
    const loadedAt = new Date().toISOString();
    return sessions.length > 0
      ? { status: 'ready', sessions, source: result.source, loadedAt }
      : { status: 'empty', sessions: [], source: result.source, loadedAt };
  } catch (error) {
    return {
      status: 'unavailable',
      sessions: [],
      reason: describeCovenUnavailable(error),
      loadedAt: new Date().toISOString(),
    };
  }
}

async function listCovenSessionsJson(
  command: string,
  options: { cwd?: string; timeout: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; source: CovenSessionsSource }> {
  try {
    return {
      stdout: await execFileText(command, ['sessions', '--json', '--all'], options),
      source: 'coven sessions --json --all',
    };
  } catch (error) {
    if (isCommandMissing(error)) {
      throw error;
    }
    if (isExecFileTimeoutError(error)) {
      throw error;
    }
  }

  return {
    stdout: await execFileText(command, ['sessions', '--json'], options),
    source: 'coven sessions --json',
  };
}

export async function filterCovenSessionsForProjectRoots(
  sessions: CovenSessionVisibility[],
  projectRoots: string[],
): Promise<CovenSessionVisibility[]> {
  const scopedRoots = await realpathExisting(projectRoots);
  if (scopedRoots.length === 0) return [];

  const visible: CovenSessionVisibility[] = [];
  for (const session of sessions) {
    const candidateRoot = session.projectRoot || session.cwd;
    if (!candidateRoot) continue;

    const realSessionRoot = await realpathExistingOne(candidateRoot);
    if (!realSessionRoot) continue;

    if (scopedRoots.some((root) => isPathInsideOrEqual(root, realSessionRoot))) {
      visible.push({ ...session, projectRoot: realSessionRoot });
    }
  }

  return visible;
}

export function groupCovenSessionsByProject(
  sessions: CovenSessionVisibility[],
): Map<string, CovenSessionVisibility[]> {
  const grouped = new Map<string, CovenSessionVisibility[]>();
  for (const session of sessions) {
    const root = path.resolve(session.projectRoot);
    const current = grouped.get(root) || [];
    current.push(session);
    grouped.set(root, current);
  }
  return grouped;
}

export function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function covenSessionsForProject(
  projectRoot: string,
  sessions: CovenSessionVisibility[],
): CovenSessionVisibility[] {
  return sessions.filter((session) => isPathInsideOrEqual(projectRoot, session.projectRoot));
}

export function pickCovenSessionToOpen(
  projectRoot: string,
  sessions: CovenSessionVisibility[],
): CovenSessionVisibility | undefined {
  return covenSessionsForProject(projectRoot, sessions)
    .sort(compareCovenSessionsForOpen)[0];
}

function normalizeCovenSession(raw: unknown): CovenSessionVisibility | null {
  if (!isRecord(raw)) return null;

  const id = stringValue(raw.id);
  const projectRoot = stringValue(raw.projectRoot) || stringValue(raw.project_root) || stringValue(raw.root);
  if (!id || !projectRoot) return null;

  const archivedAt = stringValue(raw.archivedAt) || stringValue(raw.archived_at);

  return {
    id,
    projectRoot,
    cwd: stringValue(raw.cwd),
    harness: stringValue(raw.harness),
    title: stringValue(raw.title) || id,
    status: archivedAt ? 'archived' : stringValue(raw.status),
    createdAt: stringValue(raw.createdAt) || stringValue(raw.created_at),
    updatedAt: stringValue(raw.updatedAt) || stringValue(raw.updated_at),
    archivedAt,
  };
}

function compareCovenSessionsForOpen(
  left: CovenSessionVisibility,
  right: CovenSessionVisibility,
): number {
  return sessionTimestamp(right) - sessionTimestamp(left);
}

function sessionTimestamp(session: CovenSessionVisibility): number {
  return Math.max(
    parseTimestamp(session.updatedAt),
    parseTimestamp(session.createdAt),
    parseTimestamp(session.archivedAt),
  );
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function execFileText(
  command: string,
  args: string[],
  options: { cwd?: string; timeout: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function realpathExisting(paths: string[]): Promise<string[]> {
  const unique = Array.from(new Set(paths.filter(Boolean).map((value) => path.resolve(value))));
  const resolved = await Promise.all(unique.map(realpathExistingOne));
  return resolved.filter((value): value is string => !!value);
}

async function realpathExistingOne(value: string): Promise<string | null> {
  try {
    return await realpath(value);
  } catch {
    return null;
  }
}

function describeCovenUnavailable(error: unknown): string {
  if (isRecord(error)) {
    const code = stringValue(error.code);
    if (code === 'ENOENT') return 'coven CLI not found';
    if (code === 'ETIMEDOUT') return 'coven sessions --json timed out';

    const signal = stringValue(error.signal);
    if (signal === 'SIGTERM') return 'coven sessions --json timed out';

    const message = stringValue(error.message);
    if (message) return message.split('\n')[0] || 'coven sessions --json failed';
  }

  return error instanceof Error
    ? error.message.split('\n')[0] || 'coven sessions --json failed'
    : 'coven sessions --json unavailable';
}

function isCommandMissing(error: unknown): boolean {
  return isRecord(error) && stringValue(error.code) === 'ENOENT';
}

function isExecFileTimeoutError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (stringValue(error.code) === 'ETIMEDOUT') return true;
  return error.killed === true;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
