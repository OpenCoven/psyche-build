import path from 'node:path';

import { listProjectCovenSessions, createCovenClient } from './bridge.js';
import { listPanes } from './panes.js';
import type { CovenSessionSummary, PaneSummary } from './protocol.js';
import { readProjectRitualPublication } from '../workspace/ritualPublication.js';
import {
  buildWorkspaceSnapshot,
  normalizeWorkspaceRoot,
  normalizeWorkspaceWorktrees,
  readProjectWorktrees,
  type GitWorktreeSnapshotInput,
  type RitualPublicationSnapshot,
  type WorkspaceSnapshot,
} from '../workspace/snapshot.js';

export interface DaemonWorkspaceDeps {
  revision: () => number;
  readWorktrees: (projectRoot: string) => GitWorktreeSnapshotInput[];
  listPanes: (projectRoot: string) => Promise<PaneSummary[]>;
  listCovenSessions: (projectRoot: string) => Promise<CovenSessionSummary[]>;
  /** Composes the bounded ritual publication for the canonical project. */
  ritualPublication?: (projectRoot: string) => RitualPublicationSnapshot;
}

const defaultDeps: DaemonWorkspaceDeps = {
  revision: Date.now,
  readWorktrees: readProjectWorktrees,
  listPanes,
  listCovenSessions: (projectRoot) => listProjectCovenSessions(projectRoot, createCovenClient()),
  ritualPublication: readProjectRitualPublication,
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

  return buildWorkspaceSnapshot({
    revision: deps.revision(),
    projects: [{
      id: normalizedProjectRoot,
      root: normalizedProjectRoot,
      title: path.basename(normalizedProjectRoot),
      // The canonical selected project is the only scope rituals are read
      // for; the publication is bounded and sanitized by its builder.
      rituals: (deps.ritualPublication ?? readProjectRitualPublication)(normalizedProjectRoot),
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
