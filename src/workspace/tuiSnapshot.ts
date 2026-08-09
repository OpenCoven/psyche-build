import path from 'node:path';

import type { CovenSessionSummary } from '../daemon/protocol.js';
import type { PsychePane, SidebarProject } from '../types.js';
import {
  buildWorkspaceSnapshot,
  type DeepReadonly,
  normalizeIsoDateString,
  normalizeIsoEpochMilliseconds,
  normalizeWorkspaceRoot,
  readProjectWorktrees,
  type GitWorktreeSnapshotInput,
  type ReadonlyWorkspaceSnapshot,
  type WorkspacePaneInput,
  type WorkspaceProjectInput,
  type WorkspaceSnapshot,
} from './snapshot.js';

export interface BuildTuiWorkspaceSnapshotInput {
  revision: number;
  primaryProjectRoot: string;
  primaryProjectName: string;
  sidebarProjects?: readonly SidebarProject[];
  panes: readonly PsychePane[];
  covenSessionsByProject?: ReadonlyMap<string, readonly CovenSessionSummary[]>;
  worktreesByProjectRoot?: ReadonlyMap<string, readonly GitWorktreeSnapshotInput[]>;
  readWorktrees?: (projectRoot: string) => GitWorktreeSnapshotInput[];
}

export type TuiWorkspaceSnapshotInput = Omit<BuildTuiWorkspaceSnapshotInput, 'revision'>;

interface ProjectSeed {
  root: string;
  title: string;
  isPrimary: boolean;
}

export class TuiWorkspaceState {
  #revision: number;
  #snapshot: ReadonlyWorkspaceSnapshot | undefined;
  #canonicalContent: string | undefined;

  constructor(options: { initialRevision?: number } = {}) {
    this.#revision = normalizeInitialRevision(options.initialRevision);
  }

  snapshot(input: TuiWorkspaceSnapshotInput): ReadonlyWorkspaceSnapshot {
    const canonicalSnapshot = buildTuiWorkspaceSnapshot({
      ...input,
      revision: 0,
    });
    const canonicalContent = stableSerialize(canonicalSnapshot);

    if (this.#snapshot && this.#canonicalContent === canonicalContent) {
      return this.#snapshot;
    }

    const snapshot = freezeDeep({
      ...canonicalSnapshot,
      revision: nextRevision(this.#revision),
    });

    this.#revision = snapshot.revision;
    this.#snapshot = snapshot;
    this.#canonicalContent = canonicalContent;
    return snapshot;
  }

  current(): ReadonlyWorkspaceSnapshot | undefined {
    return this.#snapshot;
  }
}

export function buildTuiWorkspaceSnapshot(
  input: BuildTuiWorkspaceSnapshotInput,
): WorkspaceSnapshot {
  const primaryRoot = normalizeRoot(input.primaryProjectRoot);
  const covenSessionsByProject = deduplicateCovenSessionsByProject(input.covenSessionsByProject);
  const projects = collectProjects(input, primaryRoot, covenSessionsByProject);

  return buildWorkspaceSnapshot({
    revision: input.revision,
    projects: projects.map((project) => ({
      id: project.root,
      root: project.root,
      title: project.title,
      worktrees: readWorktreesForProject(project.root, input),
      panes: projectPanes(project.root, input.panes, primaryRoot),
      covenSessions: projectCovenSessions(project.root, covenSessionsByProject),
    })),
  });
}

function collectProjects(
  input: BuildTuiWorkspaceSnapshotInput,
  primaryRoot: string,
  covenSessionsByProject: ReadonlyMap<string, readonly CovenSessionSummary[]>,
): ProjectSeed[] {
  const seeds = new Map<string, ProjectSeed>();
  const primaryTitle = normalizeProjectTitle(input.primaryProjectName, primaryRoot);

  seeds.set(primaryRoot, {
    root: primaryRoot,
    title: primaryTitle,
    isPrimary: true,
  });

  for (const project of input.sidebarProjects ?? []) {
    if (!project?.projectRoot) continue;
    upsertProject(
      seeds,
      normalizeRoot(project.projectRoot),
      project.projectName,
      false,
    );
  }

  for (const pane of input.panes) {
    upsertProject(
      seeds,
      pane.projectRoot?.trim() ? normalizeRoot(pane.projectRoot) : primaryRoot,
      pane.projectName,
      false,
    );
  }

  for (const projectRoot of covenSessionsByProject.keys()) {
    upsertProject(seeds, normalizeRoot(projectRoot), undefined, false);
  }

  return [...seeds.values()].sort((left, right) => {
    if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
    return compareStrings(left.title, right.title) || compareStrings(left.root, right.root);
  });
}

function upsertProject(
  seeds: Map<string, ProjectSeed>,
  root: string,
  title: string | undefined,
  isPrimary: boolean,
): void {
  const normalizedTitle = normalizeProjectTitle(title, root);
  const existing = seeds.get(root);
  if (!existing) {
    seeds.set(root, { root, title: normalizedTitle, isPrimary });
    return;
  }

  if (isPrimary) {
    existing.title = normalizedTitle;
    existing.isPrimary = true;
    return;
  }

  if (existing.isPrimary) return;

  existing.title = preferredProjectTitle(existing.title, normalizedTitle, root);
}

function readWorktreesForProject(
  projectRoot: string,
  input: BuildTuiWorkspaceSnapshotInput,
): GitWorktreeSnapshotInput[] {
  const explicit = input.worktreesByProjectRoot && getResolvedMapValue(
    input.worktreesByProjectRoot,
    projectRoot,
  );
  const worktrees = explicit ?? (input.readWorktrees ?? readProjectWorktrees)(projectRoot);
  return worktrees.map((worktree) => ({
    ...worktree,
    path: normalizeRoot(worktree.path),
  }));
}

function getResolvedMapValue<Value>(
  entries: ReadonlyMap<string, Value>,
  key: string,
): Value | undefined {
  for (const [candidateKey, value] of entries) {
    if (normalizeRoot(candidateKey) === key) {
      return value;
    }
  }
  return undefined;
}

function projectPanes(
  projectRoot: string,
  panes: readonly PsychePane[],
  primaryRoot: string,
): WorkspacePaneInput[] {
  return panes
    .map((pane, index) => ({
      pane,
      index,
      projectRoot: pane.projectRoot?.trim() ? normalizeRoot(pane.projectRoot) : primaryRoot,
    }))
    .filter((entry) => entry.projectRoot === projectRoot)
    .sort((left, right) => compareStrings(left.pane.paneId, right.pane.paneId) || left.index - right.index)
    .map(({ pane, projectRoot: paneProjectRoot }) => ({
      id: pane.paneId,
      cwd: pane.worktreePath?.trim() ? normalizeRoot(pane.worktreePath) : paneProjectRoot,
      title: pane.displayName?.trim() || pane.slug || pane.id,
      kind: pane.agent ? 'agent' : 'terminal',
      agent: pane.agent,
      status: pane.agentStatus ?? 'unknown',
      needsAttention: pane.needsAttention,
      lastActivity: normalizeIsoEpochMilliseconds(pane.lastAgentCheck),
    }));
}

function projectCovenSessions(
  projectRoot: string,
  grouped: ReadonlyMap<string, readonly CovenSessionSummary[]>,
): CovenSessionSummary[] {
  return [...(getResolvedMapValue(grouped, projectRoot) ?? [])]
    .sort((left, right) => compareStrings(left.id, right.id));
}

function normalizeRoot(projectRoot: string): string {
  return normalizeWorkspaceRoot(projectRoot);
}

function normalizeProjectTitle(title: string | undefined, projectRoot: string): string {
  const trimmed = title?.trim();
  return trimmed || fallbackProjectTitle(projectRoot);
}

function fallbackProjectTitle(projectRoot: string): string {
  return path.basename(projectRoot) || 'project';
}

function deduplicateCovenSessionsByProject(
  grouped: ReadonlyMap<string, readonly CovenSessionSummary[]> | undefined,
): Map<string, CovenSessionSummary[]> {
  if (!grouped) return new Map<string, CovenSessionSummary[]>();
  const winners = new Map<string, CovenSessionSummary>();

  for (const sessions of grouped.values()) {
    for (const session of sessions) {
      const normalized = normalizeCovenSession(session);
      const current = winners.get(normalized.id);
      if (!current || compareCovenSessionDuplicates(normalized, current) < 0) {
        winners.set(normalized.id, normalized);
      }
    }
  }

  const byProject = new Map<string, CovenSessionSummary[]>();
  for (const session of [...winners.values()].sort((left, right) => compareStrings(left.id, right.id))) {
    const projectSessions = byProject.get(session.projectRoot) ?? [];
    projectSessions.push(session);
    byProject.set(session.projectRoot, projectSessions);
  }

  return byProject;
}

function normalizeCovenSession(session: CovenSessionSummary): CovenSessionSummary {
  return {
    ...session,
    id: trimmedString(session.id) ?? session.id,
    projectRoot: normalizeRoot(session.projectRoot),
    cwd: session.cwd?.trim() ? normalizeRoot(session.cwd) : undefined,
    title: trimmedString(session.title) ?? '',
    harness: trimmedString(session.harness) ?? '',
    status: (trimmedString(session.status) ?? '') as CovenSessionSummary['status'],
    createdAt: normalizeCanonicalDateField(session.createdAt),
    updatedAt: normalizeCanonicalDateField(session.updatedAt),
    archivedAt: normalizeOptionalCanonicalDateField(session.archivedAt),
  };
}

/**
 * Duplicate Coven IDs must resolve the same way regardless of grouped-map
 * order. Prefer the newest valid updatedAt, then compare normalized
 * projectRoot/cwd/title/harness/status fields, then the remaining normalized
 * record payload as a stable final tie-breaker.
 */
function compareCovenSessionDuplicates(
  left: CovenSessionSummary,
  right: CovenSessionSummary,
): number {
  const updatedAtDifference = compareNumbersDescending(
    updatedAtSortValue(left.updatedAt),
    updatedAtSortValue(right.updatedAt),
  );
  if (updatedAtDifference) return updatedAtDifference;

  const normalizedLeft = normalizedCovenSessionFields(left);
  const normalizedRight = normalizedCovenSessionFields(right);

  return compareStrings(normalizedLeft.projectRoot, normalizedRight.projectRoot)
    || compareStrings(normalizedLeft.cwd, normalizedRight.cwd)
    || compareStrings(normalizedLeft.title, normalizedRight.title)
    || compareStrings(normalizedLeft.harness, normalizedRight.harness)
    || compareStrings(normalizedLeft.status, normalizedRight.status)
    || compareStrings(JSON.stringify(normalizedLeft), JSON.stringify(normalizedRight));
}

function updatedAtSortValue(updatedAt: string): number {
  const normalized = normalizeIsoDateString(updatedAt);
  return normalized ? Date.parse(normalized) : Number.NEGATIVE_INFINITY;
}

function normalizedCovenSessionFields(session: CovenSessionSummary) {
  return {
    id: session.id,
    projectRoot: session.projectRoot,
    cwd: session.cwd ?? '',
    title: session.title,
    harness: session.harness,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    archivedAt: session.archivedAt ?? '',
  };
}

function preferredProjectTitle(current: string, candidate: string, root: string): string {
  const fallback = fallbackProjectTitle(root);
  const currentRank = projectTitleRank(current, fallback);
  const candidateRank = projectTitleRank(candidate, fallback);
  if (candidateRank !== currentRank) return candidateRank < currentRank ? candidate : current;
  return compareStrings(current, candidate) <= 0 ? current : candidate;
}

function projectTitleRank(title: string, fallback: string): number {
  return title === fallback ? 1 : 0;
}

function normalizeCanonicalDateField(value: string): string {
  return normalizeIsoDateString(value) ?? (trimmedString(value) ?? '');
}

function normalizeOptionalCanonicalDateField(value: string | undefined): string | undefined {
  const trimmed = trimmedString(value);
  if (!trimmed) return undefined;
  return normalizeIsoDateString(trimmed);
}

function trimmedString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function compareNumbersDescending(left: number, right: number): number {
  if (left === right) return 0;
  return left > right ? -1 : 1;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeInitialRevision(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('TuiWorkspaceState initialRevision must be a non-negative safe integer.');
  }
  return value;
}

function nextRevision(currentRevision: number): number {
  if (currentRevision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('TuiWorkspaceState revision overflow: cannot exceed Number.MAX_SAFE_INTEGER.');
  }
  return currentRevision + 1;
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(stableSerializeValue(value));
}

function stableSerializeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSerializeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, entry]) => [key, stableSerializeValue(entry)]),
    );
  }
  return value;
}

function freezeDeep<T>(value: T): DeepReadonly<T> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }

  Object.freeze(value);
  for (const nested of Object.values(value)) {
    freezeDeep(nested);
  }
  return value as DeepReadonly<T>;
}
