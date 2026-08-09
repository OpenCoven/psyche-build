import { execFileSync } from 'node:child_process';
import path from 'node:path';

import type { CovenSessionSummary } from '../daemon/protocol.js';

export type WorkspacePaneKind = 'agent' | 'terminal' | 'coven-session';
export type WorkspaceRecoverability = 'healthy' | 'missing-worktree';

export interface GitWorktreeSnapshotInput {
  path: string;
  head: string;
  branch?: string;
  isMain: boolean;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  pruneReason?: string;
  dirty: boolean;
  missing: boolean;
}

export interface WorkspacePaneInput {
  id: string;
  cwd: string;
  title?: string;
  kind: Exclude<WorkspacePaneKind, 'coven-session'>;
  agent?: string;
  status: string;
  needsAttention?: boolean;
  lastActivity?: string;
}

export interface PaneSnapshot extends Omit<WorkspacePaneInput, 'kind'> {
  kind: WorkspacePaneKind;
  recoverability: WorkspaceRecoverability;
}

export interface WorktreeSnapshot extends GitWorktreeSnapshotInput {
  panes: PaneSnapshot[];
  runningCount: number;
  attentionCount: number;
}

export interface ProjectSnapshot {
  id: string;
  root: string;
  title: string;
  worktrees: WorktreeSnapshot[];
  projectPanes: PaneSnapshot[];
  runningCount: number;
  attentionCount: number;
}

export interface WorkspaceSnapshot {
  revision: number;
  projects: ProjectSnapshot[];
}

export interface WorkspaceProjectInput {
  id: string;
  root: string;
  title: string;
  worktrees: GitWorktreeSnapshotInput[];
  panes: WorkspacePaneInput[];
  covenSessions?: CovenSessionSummary[];
}

export interface BuildWorkspaceSnapshotInput {
  revision: number;
  projects: WorkspaceProjectInput[];
}

const ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_ZONED_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function parseGitWorktreePorcelain(raw: string): GitWorktreeSnapshotInput[] {
  const blocks = raw
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block, index) => {
    const record: GitWorktreeSnapshotInput = {
      path: '',
      head: '',
      isMain: index === 0,
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
      dirty: false,
      missing: false,
    };

    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(' ');
      const key = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? '' : line.slice(separator + 1);
      switch (key) {
        case 'worktree':
          record.path = value;
          break;
        case 'HEAD':
          record.head = value;
          break;
        case 'branch':
          record.branch = value.replace(/^refs\/heads\//, '');
          break;
        case 'detached':
          record.detached = true;
          break;
        case 'bare':
          record.bare = true;
          break;
        case 'locked':
          record.locked = true;
          if (value) record.lockReason = value;
          break;
        case 'prunable':
          record.prunable = true;
          record.missing = true;
          if (value) record.pruneReason = value;
          break;
      }
    }

    return record;
  }).filter((record) => record.path.length > 0);
}

export type GitRunner = (cwd: string, args: string[]) => string;

export function readProjectWorktrees(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): GitWorktreeSnapshotInput[] {
  const worktrees = parseGitWorktreePorcelain(
    runGit(projectRoot, ['worktree', 'list', '--porcelain']),
  );

  return worktrees.map((worktree) => {
    if (worktree.prunable || worktree.bare) return worktree;
    try {
      const status = runGit(worktree.path, [
        'status',
        '--porcelain=v1',
        '--untracked-files=normal',
      ]);
      return { ...worktree, dirty: status.trim().length > 0 };
    } catch {
      return { ...worktree, missing: true };
    }
  });
}

function defaultGitRunner(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function buildWorkspaceSnapshot(input: BuildWorkspaceSnapshotInput): WorkspaceSnapshot {
  return {
    revision: input.revision,
    projects: input.projects.map(buildProjectSnapshot),
  };
}

export function normalizeIsoDateString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (ISO_DATE_ONLY.test(trimmed)) return undefined;

  const match = ISO_ZONED_DATE_TIME.exec(trimmed);
  if (!match) return undefined;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    return undefined;
  }

  if (offset !== 'Z') {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return undefined;
    }
  }

  const date = new Date(trimmed);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function normalizeIsoEpochMilliseconds(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function buildProjectSnapshot(project: WorkspaceProjectInput): ProjectSnapshot {
  const worktrees: WorktreeSnapshot[] = project.worktrees.map((worktree) => ({
    ...worktree,
    panes: [],
    runningCount: 0,
    attentionCount: 0,
  }));
  const projectPanes: PaneSnapshot[] = [];

  const panes: PaneSnapshot[] = [
    ...project.panes.map((pane): PaneSnapshot => ({
      ...pane,
      recoverability: 'healthy',
    })),
    ...(project.covenSessions ?? []).map(covenSessionPane),
  ];

  for (const pane of panes) {
    const worktree = mostSpecificWorktree(worktrees, pane.cwd);
    if (worktree) {
      worktree.panes.push(pane);
      if (isRunning(pane.status)) worktree.runningCount += 1;
      if (pane.needsAttention) worktree.attentionCount += 1;
    } else {
      projectPanes.push({ ...pane, recoverability: 'missing-worktree' });
    }
  }

  return {
    id: project.id,
    root: project.root,
    title: project.title,
    worktrees,
    projectPanes,
    runningCount:
      worktrees.reduce((count, worktree) => count + worktree.runningCount, 0)
      + projectPanes.filter((pane) => isRunning(pane.status)).length,
    attentionCount:
      worktrees.reduce((count, worktree) => count + worktree.attentionCount, 0)
      + projectPanes.filter((pane) => pane.needsAttention).length,
  };
}

function covenSessionPane(session: CovenSessionSummary): PaneSnapshot {
  const cwd = trimmedString(session.cwd);
  const id = trimmedString(session.id);
  return {
    id: id ?? session.id,
    cwd: cwd ? path.resolve(cwd) : path.resolve(session.projectRoot.trim()),
    title: trimmedString(session.title) ?? '',
    kind: 'coven-session',
    agent: trimmedString(session.harness) ?? '',
    status: trimmedString(session.status) ?? '',
    needsAttention: trimmedString(session.status) === 'waiting',
    lastActivity: normalizeIsoDateString(session.updatedAt),
    recoverability: 'healthy',
  };
}

function mostSpecificWorktree(
  worktrees: WorktreeSnapshot[],
  cwd: string,
): WorktreeSnapshot | undefined {
  return worktrees
    .filter((worktree) => isInsideOrEqual(worktree.path, cwd))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isRunning(status: string): boolean {
  return ['starting', 'running', 'working', 'analyzing'].includes(status);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function trimmedString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
