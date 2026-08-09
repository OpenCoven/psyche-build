import path from 'node:path';

import type { CovenSessionSummary } from '../daemon/protocol.js';
import type { PsychePane, SidebarProject } from '../types.js';
import type { CovenSessionVisibility } from '../utils/covenSessions.js';
import {
  buildWorkspaceSnapshot,
  type DeepReadonly,
  normalizeIsoDateString,
  normalizeIsoEpochMilliseconds,
  normalizeWorkspaceRoot,
  normalizeWorkspaceWorktrees,
  readProjectWorktrees,
  readProjectWorktreesAsync,
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

type MaybePromise<Value> = Value | Promise<Value>;

export interface TuiWorkspaceProviderOptions {
  primaryProjectRoot: string;
  primaryProjectName: string;
  panes: () => MaybePromise<readonly PsychePane[]>;
  sidebarProjects?: () => MaybePromise<readonly SidebarProject[]>;
  covenSessionsByProject?: () => MaybePromise<
    ReadonlyMap<string, readonly CovenSessionSummary[]>
  >;
  worktreesByProjectRoot?: () => MaybePromise<
    ReadonlyMap<string, readonly GitWorktreeSnapshotInput[]>
  >;
  loadWorktrees?: (
    projectRoot: string,
  ) => MaybePromise<readonly GitWorktreeSnapshotInput[]>;
  worktreeCacheTtlMs?: number;
  onWorktreeReadError?: (projectRoot: string, error: unknown) => void;
  state?: TuiWorkspaceState;
}

interface ProjectSeed {
  root: string;
  title: string;
  isPrimary: boolean;
}

const COVEN_SESSION_STATUSES = new Set<CovenSessionSummary['status']>([
  'starting',
  'running',
  'waiting',
  'completed',
  'failed',
  'killed',
  'orphaned',
  'created',
  'archived',
]);

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

export function createTuiWorkspaceProvider(
  options: TuiWorkspaceProviderOptions,
): () => Promise<ReadonlyWorkspaceSnapshot> {
  const state = options.state ?? new TuiWorkspaceState();
  const worktreeCache = new Map<string, {
    expiresAt: number;
    value: readonly GitWorktreeSnapshotInput[];
  }>();
  const worktreeCacheTtlMs = Math.max(0, options.worktreeCacheTtlMs ?? 1_000);
  const loadWorktrees = options.loadWorktrees ?? readProjectWorktreesAsync;
  let providerQueue: Promise<void> = Promise.resolve();

  const readSnapshot = async (): Promise<ReadonlyWorkspaceSnapshot> => {
    const [
      panes,
      sidebarProjects,
      covenSessionsByProject,
      providedWorktreesByProjectRoot,
    ] = await Promise.all([
      options.panes(),
      options.sidebarProjects?.(),
      options.covenSessionsByProject?.(),
      options.worktreesByProjectRoot?.(),
    ]);

    const workspaceInput = {
      primaryProjectRoot: options.primaryProjectRoot,
      primaryProjectName: options.primaryProjectName,
      panes,
      sidebarProjects,
      covenSessionsByProject,
    };
    const primaryRoot = normalizeRoot(workspaceInput.primaryProjectRoot);
    const publishedProjects = collectPublishedProjects(
      { ...workspaceInput, revision: 0 },
      primaryRoot,
    );
    let worktreesByProjectRoot = providedWorktreesByProjectRoot
      ?? await loadProviderWorktrees(
        publishedProjects.map((project) => project.root),
        loadWorktrees,
        worktreeCache,
        worktreeCacheTtlMs,
        options.onWorktreeReadError,
      );
    const covenOnlyCandidateRoots = collectCovenOnlyCandidateRoots(
      covenSessionsByProject,
      publishedProjects,
      worktreesByProjectRoot,
    );

    if (!providedWorktreesByProjectRoot) {
      const missingRoots = covenOnlyCandidateRoots
        .filter((projectRoot) => !hasResolvedMapKey(worktreesByProjectRoot, projectRoot));
      if (missingRoots.length > 0) {
        const additionalWorktrees = await loadProviderWorktrees(
          missingRoots,
          loadWorktrees,
          worktreeCache,
          worktreeCacheTtlMs,
          options.onWorktreeReadError,
        );
        worktreesByProjectRoot = mergeWorktreesByProjectRoot([
          ...worktreesByProjectRoot,
          ...additionalWorktrees,
        ]);
      }
    }

    const canonicalCovenOwnership = canonicalizeCovenOnlyWorktrees(
      worktreesByProjectRoot,
      covenOnlyCandidateRoots,
    );
    const associatedCovenSessions = deduplicateCovenSessionsByProject(
      associateCovenSessionsWithPublishedProjects(
        covenSessionsByProject,
        mergeProjectSeeds(
          publishedProjects,
          canonicalCovenOwnership.canonicalRoots,
        ),
        canonicalCovenOwnership.worktreesByProjectRoot,
      ),
    );

    return state.snapshot({
      ...workspaceInput,
      covenSessionsByProject: associatedCovenSessions,
      worktreesByProjectRoot: canonicalCovenOwnership.worktreesByProjectRoot,
    });
  };

  return () => {
    const result = providerQueue.then(readSnapshot);
    providerQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export function normalizeCovenSessionsForPublication(
  sessions: readonly CovenSessionVisibility[],
): CovenSessionSummary[] {
  return sessions.flatMap((session) => {
    const id = session.id.trim();
    const projectRoot = session.projectRoot.trim();
    if (!id || !projectRoot) return [];

    const archivedAt = normalizeIsoDateString(session.archivedAt);
    const createdAt = normalizeIsoDateString(session.createdAt);
    const updatedAt = normalizeIsoDateString(session.updatedAt);
    const normalizedStatus = session.status?.trim();
    const status = archivedAt
      ? 'archived'
      : COVEN_SESSION_STATUSES.has(normalizedStatus as CovenSessionSummary['status'])
        ? normalizedStatus as CovenSessionSummary['status']
        : 'created';

    return [{
      id,
      projectRoot: normalizeRoot(projectRoot),
      cwd: session.cwd?.trim() ? normalizeRoot(session.cwd) : undefined,
      harness: session.harness?.trim() ?? '',
      title: session.title?.trim() || id,
      status,
      createdAt: createdAt || updatedAt || archivedAt || '',
      updatedAt: updatedAt || archivedAt || createdAt || '',
      archivedAt: archivedAt || undefined,
    }];
  });
}

export function groupCovenSessionsByProject(
  sessions: readonly CovenSessionSummary[],
): Map<string, CovenSessionSummary[]> {
  const grouped = new Map<string, CovenSessionSummary[]>();
  for (const session of normalizeCovenSessionsForPublication(sessions)) {
    const projectSessions = grouped.get(session.projectRoot) ?? [];
    projectSessions.push(session);
    grouped.set(session.projectRoot, projectSessions);
  }
  return grouped;
}

async function loadProviderWorktrees(
  projectRoots: readonly string[],
  loadWorktrees: (
    projectRoot: string,
  ) => MaybePromise<readonly GitWorktreeSnapshotInput[]>,
  cache: Map<string, {
    expiresAt: number;
    value: readonly GitWorktreeSnapshotInput[];
  }>,
  cacheTtlMs: number,
  onError: ((projectRoot: string, error: unknown) => void) | undefined,
): Promise<Map<string, readonly GitWorktreeSnapshotInput[]>> {
  const entries = await Promise.all(projectRoots.map(async (projectRoot) => {
    const cached = cache.get(projectRoot);
    if (cached && cached.expiresAt > Date.now()) {
      return [projectRoot, cached.value] as const;
    }

    let value: readonly GitWorktreeSnapshotInput[];
    try {
      value = await loadWorktrees(projectRoot);
    } catch (error) {
      if (!onError) throw error;
      onError(projectRoot, error);
      value = [];
    }

    const cachedValue = value.map((worktree) => ({ ...worktree }));
    cache.set(projectRoot, {
      expiresAt: Date.now() + cacheTtlMs,
      value: cachedValue,
    });
    return [projectRoot, cachedValue] as const;
  }));

  return new Map(entries);
}

export function buildTuiWorkspaceSnapshot(
  input: BuildTuiWorkspaceSnapshotInput,
): WorkspaceSnapshot {
  const primaryRoot = normalizeRoot(input.primaryProjectRoot);
  const publishedProjects = collectPublishedProjects(input, primaryRoot);
  const discoveredWorktrees = mergeWorktreesByProjectRoot([
    ...(input.worktreesByProjectRoot ?? []),
    ...publishedProjects.map((project) => [
      project.root,
      readWorktreesForProject(project.root, input),
    ] as const),
  ]);
  const covenOnlyCandidateRoots = collectCovenOnlyCandidateRoots(
    input.covenSessionsByProject,
    publishedProjects,
    discoveredWorktrees,
  );
  const canonicalCovenOwnership = canonicalizeCovenOnlyWorktrees(
    discoveredWorktrees,
    covenOnlyCandidateRoots,
  );
  const covenSessionsByProject = deduplicateCovenSessionsByProject(
    associateCovenSessionsWithPublishedProjects(
      input.covenSessionsByProject,
      mergeProjectSeeds(
        publishedProjects,
        canonicalCovenOwnership.canonicalRoots,
      ),
      canonicalCovenOwnership.worktreesByProjectRoot,
    ),
  );
  const projects = collectProjects(input, primaryRoot, covenSessionsByProject);

  return buildWorkspaceSnapshot({
    revision: input.revision,
    projects: projects.map((project) => ({
      id: project.root,
      root: project.root,
      title: project.title,
      worktrees: [
        ...(getResolvedMapValue(
          canonicalCovenOwnership.worktreesByProjectRoot,
          project.root,
        )
          ?? readWorktreesForProject(project.root, input)),
      ],
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
  const seeds = new Map(
    collectPublishedProjects(input, primaryRoot)
      .map((project) => [project.root, project]),
  );

  for (const projectRoot of covenSessionsByProject.keys()) {
    upsertProject(seeds, normalizeRoot(projectRoot), undefined, false);
  }

  return sortProjects(seeds);
}

function collectPublishedProjects(
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

  return sortProjects(seeds);
}

function sortProjects(seeds: ReadonlyMap<string, ProjectSeed>): ProjectSeed[] {
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

function hasResolvedMapKey<Value>(
  entries: ReadonlyMap<string, Value>,
  key: string,
): boolean {
  for (const candidateKey of entries.keys()) {
    if (normalizeRoot(candidateKey) === key) return true;
  }
  return false;
}

function collectCovenOnlyCandidateRoots(
  grouped: ReadonlyMap<string, readonly CovenSessionSummary[]> | undefined,
  publishedProjects: readonly ProjectSeed[],
  worktreesByProjectRoot: ReadonlyMap<string, readonly GitWorktreeSnapshotInput[]>,
): string[] {
  const publishedRoots = new Set(publishedProjects.map((project) => project.root));
  return [...associateCovenSessionsWithPublishedProjects(
    grouped,
    publishedProjects,
    worktreesByProjectRoot,
  ).keys()]
    .map(normalizeRoot)
    .filter((projectRoot) => !publishedRoots.has(projectRoot))
    .sort(compareStrings);
}

function mergeProjectSeeds(
  publishedProjects: readonly ProjectSeed[],
  covenOnlyRoots: readonly string[],
): ProjectSeed[] {
  const seeds = new Map(
    publishedProjects.map((project) => [project.root, { ...project }]),
  );
  for (const projectRoot of covenOnlyRoots) {
    upsertProject(seeds, projectRoot, undefined, false);
  }
  return sortProjects(seeds);
}

function mergeWorktreesByProjectRoot(
  entries: Iterable<readonly [string, readonly GitWorktreeSnapshotInput[]]>,
): Map<string, readonly GitWorktreeSnapshotInput[]> {
  const worktreesByRoot = new Map<string, GitWorktreeSnapshotInput[]>();
  for (const [projectRoot, worktrees] of entries) {
    const normalizedRoot = normalizeRoot(projectRoot);
    const combined = worktreesByRoot.get(normalizedRoot) ?? [];
    combined.push(...worktrees.map((worktree) => ({ ...worktree })));
    worktreesByRoot.set(normalizedRoot, combined);
  }

  return new Map(
    [...worktreesByRoot.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([projectRoot, worktrees]) => {
        const reportedMainRoots = uniqueSortedStrings(
          worktrees
            .filter((worktree) => worktree.isMain)
            .map((worktree) => normalizeRoot(worktree.path)),
        );
        const normalizationRoot = reportedMainRoots.length === 1
          ? reportedMainRoots[0]
          : projectRoot;
        return [
          projectRoot,
          normalizeWorkspaceWorktrees(normalizationRoot, worktrees),
        ] as const;
      }),
  );
}

function canonicalizeCovenOnlyWorktrees(
  worktreesByProjectRoot: ReadonlyMap<string, readonly GitWorktreeSnapshotInput[]>,
  candidateRoots: readonly string[],
): {
  canonicalRoots: string[];
  worktreesByProjectRoot: Map<string, readonly GitWorktreeSnapshotInput[]>;
} {
  const normalizedWorktrees = mergeWorktreesByProjectRoot(worktreesByProjectRoot);
  const entries = [...normalizedWorktrees.entries()].map(([projectRoot, worktrees]) => ({
    projectRoot,
    worktrees,
    signature: worktreeSetSignature(worktrees),
  }));
  const canonicalRootByCandidate = new Map<string, string>();
  const canonicalRootsBySignature = new Map<string, Set<string>>();

  for (const candidateRoot of uniqueSortedStrings(candidateRoots.map(normalizeRoot))) {
    const matchingEntries = entries.filter((entry) => (
      entry.projectRoot === candidateRoot
      || entry.worktrees.some((worktree) => normalizeRoot(worktree.path) === candidateRoot)
    ));
    const mainRoots = uniqueSortedStrings(
      matchingEntries.flatMap((entry) => (
        entry.worktrees
          .filter((worktree) => worktree.isMain)
          .map((worktree) => normalizeRoot(worktree.path))
      )),
    );
    const canonicalRoot = mainRoots.length === 1 ? mainRoots[0] : candidateRoot;
    canonicalRootByCandidate.set(candidateRoot, canonicalRoot);

    for (const entry of matchingEntries) {
      if (!entry.signature) continue;
      const roots = canonicalRootsBySignature.get(entry.signature) ?? new Set<string>();
      roots.add(canonicalRoot);
      canonicalRootsBySignature.set(entry.signature, roots);
    }
  }

  const canonicalRootBySignature = new Map(
    [...canonicalRootsBySignature.entries()]
      .flatMap(([signature, roots]) => {
        const canonicalRoot = roots.size === 1
          ? roots.values().next().value
          : undefined;
        return canonicalRoot ? [[signature, canonicalRoot] as const] : [];
      }),
  );
  const rekeyedEntries: Array<readonly [string, readonly GitWorktreeSnapshotInput[]]> = [];
  for (const entry of entries) {
    const signatureCanonicalRoot = entry.signature
      ? canonicalRootBySignature.get(entry.signature)
      : undefined;
    rekeyedEntries.push([
      signatureCanonicalRoot
        ?? canonicalRootByCandidate.get(entry.projectRoot)
        ?? entry.projectRoot,
      entry.worktrees,
    ]);
  }
  const canonicalWorktrees = mergeWorktreesByProjectRoot(rekeyedEntries);

  return {
    canonicalRoots: uniqueSortedStrings(
      [...canonicalRootByCandidate.values()],
    ),
    worktreesByProjectRoot: canonicalWorktrees,
  };
}

function worktreeSetSignature(
  worktrees: readonly GitWorktreeSnapshotInput[],
): string | undefined {
  const paths = uniqueSortedStrings(
    worktrees.map((worktree) => normalizeRoot(worktree.path)),
  );
  return paths.length > 0 ? JSON.stringify(paths) : undefined;
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
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
  const winners = new Map<string, {
    ownerRoot: string;
    session: CovenSessionSummary;
  }>();

  for (const [ownerRoot, sessions] of grouped) {
    const normalizedOwnerRoot = normalizeRoot(ownerRoot);
    for (const session of sessions) {
      const normalized = normalizeCovenSession(session);
      const current = winners.get(normalized.id);
      const duplicateOrder = current
        ? compareCovenSessionDuplicates(normalized, current.session)
        : -1;
      if (
        !current
        || duplicateOrder < 0
        || (
          duplicateOrder === 0
          && compareStrings(normalizedOwnerRoot, current.ownerRoot) < 0
        )
      ) {
        winners.set(normalized.id, {
          ownerRoot: normalizedOwnerRoot,
          session: normalized,
        });
      }
    }
  }

  const byProject = new Map<string, CovenSessionSummary[]>();
  for (const winner of [...winners.values()].sort(
    (left, right) => compareStrings(left.session.id, right.session.id),
  )) {
    const projectSessions = byProject.get(winner.ownerRoot) ?? [];
    const session = winner.session;
    projectSessions.push(session);
    byProject.set(winner.ownerRoot, projectSessions);
  }

  return byProject;
}

function associateCovenSessionsWithPublishedProjects(
  grouped: ReadonlyMap<string, readonly CovenSessionSummary[]> | undefined,
  projects: readonly ProjectSeed[],
  worktreesByProjectRoot: ReadonlyMap<string, readonly GitWorktreeSnapshotInput[]>,
): Map<string, CovenSessionSummary[]> {
  if (!grouped) return new Map<string, CovenSessionSummary[]>();

  const owners = projects.flatMap((project) => {
    const worktreePaths = new Set([
      project.root,
      ...(getResolvedMapValue(worktreesByProjectRoot, project.root) ?? [])
        .map((worktree) => normalizeRoot(worktree.path)),
    ]);
    return [...worktreePaths].map((worktreePath) => ({
      projectRoot: project.root,
      worktreePath,
    }));
  });
  const associated = new Map<string, CovenSessionSummary[]>();

  for (const [groupedRoot, sessions] of grouped) {
    for (const session of sessions) {
      const ownerRoot = mostSpecificCovenSessionOwner(session, owners)
        ?? normalizeRoot(groupedRoot);
      const projectSessions = associated.get(ownerRoot) ?? [];
      projectSessions.push(session);
      associated.set(ownerRoot, projectSessions);
    }
  }

  return associated;
}

function mostSpecificCovenSessionOwner(
  session: CovenSessionSummary,
  owners: readonly { projectRoot: string; worktreePath: string }[],
): string | undefined {
  const sessionPaths = [session.cwd, session.projectRoot]
    .flatMap((candidate) => candidate?.trim() ? [normalizeRoot(candidate)] : []);
  let winner: { projectRoot: string; worktreePath: string } | undefined;

  for (const owner of owners) {
    if (!sessionPaths.some((sessionPath) => (
      isPathInsideOrEqual(owner.worktreePath, sessionPath)
    ))) continue;

    if (!winner || compareWorktreeOwners(owner, winner) < 0) {
      winner = owner;
    }
  }

  return winner?.projectRoot;
}

function compareWorktreeOwners(
  left: { projectRoot: string; worktreePath: string },
  right: { projectRoot: string; worktreePath: string },
): number {
  const depthDifference = pathDepth(right.worktreePath) - pathDepth(left.worktreePath);
  if (depthDifference) return depthDifference;

  const lengthDifference = right.worktreePath.length - left.worktreePath.length;
  if (lengthDifference) return lengthDifference;

  return compareStrings(left.projectRoot, right.projectRoot)
    || compareStrings(left.worktreePath, right.worktreePath);
}

function pathDepth(value: string): number {
  return normalizeRoot(value).split(path.sep).filter(Boolean).length;
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(normalizeRoot(parent), normalizeRoot(candidate));
  return relative === ''
    || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
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
