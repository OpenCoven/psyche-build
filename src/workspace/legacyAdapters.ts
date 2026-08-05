import type {
  PaneSnapshot as LegacyPaneSnapshot,
  Project as LegacyProject,
} from '../services/bridge/wireProtocol.js';
import type {
  PaneSnapshot,
  WorkspaceSnapshot,
} from './snapshot.js';

export interface LegacyWorkspaceReadModel {
  projects: LegacyProject[];
  panes: LegacyPaneSnapshot[];
}

/**
 * Project the revisioned workspace contract into the pre-worktree bridge
 * lists. The returned objects are newly allocated and intentionally contain
 * no command or mutation handles.
 */
export function workspaceToLegacyReadModel(
  workspace: WorkspaceSnapshot,
): LegacyWorkspaceReadModel {
  const projects: LegacyProject[] = [];
  const panes: LegacyPaneSnapshot[] = [];

  for (const project of workspace.projects) {
    projects.push({
      id: project.id,
      displayName: project.title,
      attentionCount: project.attentionCount,
    });

    for (const worktree of project.worktrees) {
      for (const pane of worktree.panes) {
        panes.push(toLegacyPane(pane, project.id, project.title, worktree.path));
      }
    }
    for (const pane of project.projectPanes) {
      panes.push(toLegacyPane(pane, project.id, project.title, null));
    }
  }

  return { projects, panes };
}

function toLegacyPane(
  pane: PaneSnapshot,
  projectId: string,
  projectName: string,
  worktreePath: string | null,
): LegacyPaneSnapshot {
  return {
    id: pane.id,
    displayName: pane.title || pane.id,
    kind: pane.kind,
    projectId,
    projectName,
    worktreePath,
    agent: pane.agent || null,
    status: legacyPaneStatus(pane.status),
  };
}

function legacyPaneStatus(status: string): LegacyPaneSnapshot['status'] {
  if (['starting', 'running', 'working', 'analyzing'].includes(status)) return 'working';
  if (status === 'idle') return 'idle';
  if (status === 'waiting') return 'waiting';
  return 'unknown';
}
