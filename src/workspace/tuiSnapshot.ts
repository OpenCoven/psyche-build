import path from 'node:path';

import type { CovenSessionSummary } from '../daemon/protocol.js';
import type { PsychePane, SidebarProject } from '../types.js';
import {
  buildWorkspaceSnapshot,
  readProjectWorktrees,
  type GitWorktreeSnapshotInput,
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

interface ProjectSeed {
  root: string;
  title: string;
  isPrimary: boolean;
}

export function buildTuiWorkspaceSnapshot(
  input: BuildTuiWorkspaceSnapshotInput,
): WorkspaceSnapshot {
  const primaryRoot = normalizeRoot(input.primaryProjectRoot);
  const projects = collectProjects(input, primaryRoot);
  const seenSessions = new Set<string>();

  return buildWorkspaceSnapshot({
    revision: input.revision,
    projects: projects.map((project) => ({
      id: project.root,
      root: project.root,
      title: project.title,
      worktrees: readWorktreesForProject(project.root, input),
      panes: projectPanes(project.root, input.panes, primaryRoot),
      covenSessions: projectCovenSessions(project.root, input.covenSessionsByProject, seenSessions),
    })),
  });
}

function collectProjects(
  input: BuildTuiWorkspaceSnapshotInput,
  primaryRoot: string,
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

  for (const projectRoot of input.covenSessionsByProject?.keys() ?? []) {
    upsertProject(seeds, normalizeRoot(projectRoot), undefined, false);
  }

  return [...seeds.values()].sort((left, right) => {
    if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
    return left.title.localeCompare(right.title) || left.root.localeCompare(right.root);
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

  if (existing.title === fallbackProjectTitle(root) && normalizedTitle !== existing.title) {
    existing.title = normalizedTitle;
  }
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
    .sort((left, right) => left.pane.paneId.localeCompare(right.pane.paneId) || left.index - right.index)
    .map(({ pane, projectRoot: paneProjectRoot }) => ({
      id: pane.paneId,
      cwd: pane.worktreePath?.trim() ? normalizeRoot(pane.worktreePath) : paneProjectRoot,
      title: pane.displayName?.trim() || pane.slug || pane.id,
      kind: pane.agent ? 'agent' : 'terminal',
      agent: pane.agent,
      status: pane.agentStatus ?? 'running',
      needsAttention: pane.needsAttention,
      lastActivity: normalizePaneLastActivity(pane.lastAgentCheck),
    }));
}

function projectCovenSessions(
  projectRoot: string,
  grouped: ReadonlyMap<string, readonly CovenSessionSummary[]> | undefined,
  seenSessions: Set<string>,
): CovenSessionSummary[] {
  if (!grouped) return [];
  const sessions = getResolvedMapValue(grouped, projectRoot) ?? [];

  return sessions
    .filter((session) => {
      if (seenSessions.has(session.id)) return false;
      seenSessions.add(session.id);
      return true;
    })
    .map((session) => ({
      ...session,
      projectRoot,
      cwd: session.cwd?.trim() ? normalizeRoot(session.cwd) : undefined,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizePaneLastActivity(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function normalizeRoot(projectRoot: string): string {
  return path.resolve(projectRoot);
}

function normalizeProjectTitle(title: string | undefined, projectRoot: string): string {
  const trimmed = title?.trim();
  return trimmed || fallbackProjectTitle(projectRoot);
}

function fallbackProjectTitle(projectRoot: string): string {
  return path.basename(projectRoot) || 'project';
}
