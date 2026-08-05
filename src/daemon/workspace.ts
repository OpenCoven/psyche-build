import path from 'node:path';

import { listProjectCovenSessions, createCovenClient } from './bridge.js';
import { listPanes } from './panes.js';
import type { CovenSessionSummary, PaneSummary } from './protocol.js';
import {
  buildWorkspaceSnapshot,
  readProjectWorktrees,
  type GitWorktreeSnapshotInput,
  type WorkspaceSnapshot,
} from '../workspace/snapshot.js';

export interface DaemonWorkspaceDeps {
  revision: () => number;
  readWorktrees: (projectRoot: string) => GitWorktreeSnapshotInput[];
  listPanes: (projectRoot: string) => Promise<PaneSummary[]>;
  listCovenSessions: (projectRoot: string) => Promise<CovenSessionSummary[]>;
}

const defaultDeps: DaemonWorkspaceDeps = {
  revision: Date.now,
  readWorktrees: readProjectWorktrees,
  listPanes,
  listCovenSessions: (projectRoot) => listProjectCovenSessions(projectRoot, createCovenClient()),
};

/** Build the canonical GUI projection from the same state used by CLI commands. */
export async function readDaemonWorkspaceSnapshot(
  projectRoot: string,
  deps: DaemonWorkspaceDeps = defaultDeps,
): Promise<WorkspaceSnapshot> {
  const [panes, covenSessions] = await Promise.all([
    deps.listPanes(projectRoot),
    deps.listCovenSessions(projectRoot).catch(() => []),
  ]);

  return buildWorkspaceSnapshot({
    revision: deps.revision(),
    projects: [{
      id: projectRoot,
      root: projectRoot,
      title: path.basename(projectRoot),
      worktrees: deps.readWorktrees(projectRoot),
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
