import path from 'node:path';

import { listProjectCovenSessions, createCovenClient } from './bridge.js';
import { listPanes } from './panes.js';
import type { CovenSessionSummary, PaneSummary } from './protocol.js';
import { listAvailableRituals, type RitualDefinition } from '../utils/rituals.js';
import {
  buildWorkspaceSnapshot,
  normalizeWorkspaceRoot,
  normalizeWorkspaceWorktrees,
  readProjectWorktrees,
  type GitWorktreeSnapshotInput,
  type RitualSnapshot,
  type WorkspaceSnapshot,
} from '../workspace/snapshot.js';

export interface DaemonWorkspaceDeps {
  revision: () => number;
  readWorktrees: (projectRoot: string) => GitWorktreeSnapshotInput[];
  listPanes: (projectRoot: string) => Promise<PaneSummary[]>;
  listCovenSessions: (projectRoot: string) => Promise<CovenSessionSummary[]>;
  listRituals?: (projectRoot: string) => RitualDefinition[];
}

const MAX_PUBLISHED_RITUALS = 50;

const defaultDeps: DaemonWorkspaceDeps = {
  revision: Date.now,
  readWorktrees: readProjectWorktrees,
  listPanes,
  listCovenSessions: (projectRoot) => listProjectCovenSessions(projectRoot, createCovenClient()),
  listRituals: listAvailableRituals,
};

/** Build the canonical GUI projection from the same state used by CLI commands. */
export async function readDaemonWorkspaceSnapshot(
  projectRoot: string,
  deps: DaemonWorkspaceDeps = defaultDeps,
): Promise<WorkspaceSnapshot> {
  const normalizedProjectRoot = normalizeWorkspaceRoot(projectRoot);
  const worktrees = normalizeWorkspaceWorktrees(
    normalizedProjectRoot,
    deps.readWorktrees(projectRoot),
  );
  const covenRoots = Array.from(new Set([
    normalizedProjectRoot,
    ...worktrees
      .filter((worktree) => !worktree.missing)
      .map((worktree) => worktree.path),
  ]));
  const [panes, covenGroups] = await Promise.all([
    deps.listPanes(normalizedProjectRoot),
    Promise.all(covenRoots.map((root) => deps.listCovenSessions(root).catch(() => []))),
  ]);
  const covenSessions = Array.from(
    new Map(covenGroups.flat().map((session) => [session.id, session])).values(),
  );
  const listRituals = deps.listRituals ?? listAvailableRituals;
  const rituals = listRituals(normalizedProjectRoot)
    .slice(0, MAX_PUBLISHED_RITUALS)
    .map(projectRitualSnapshot);

  return buildWorkspaceSnapshot({
    revision: deps.revision(),
    projects: [{
      id: normalizedProjectRoot,
      root: normalizedProjectRoot,
      title: path.basename(normalizedProjectRoot),
      rituals,
      worktrees,
      panes: panes.map((pane) => ({
        id: pane.id,
        cwd: pane.cwd,
        title: pane.title,
        kind: pane.agent ? 'agent' : 'terminal',
        agent: pane.agent,
        status: 'running',
      })),
      covenSessions,
    }],
  });
}

function projectRitualSnapshot(ritual: RitualDefinition): RitualSnapshot {
  return {
    id: ritual.id,
    displayName: ritual.name,
    ...(ritual.description ? { description: ritual.description } : {}),
  };
}
