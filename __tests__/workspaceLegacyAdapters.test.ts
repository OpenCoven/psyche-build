import { describe, expect, it } from 'vitest';

import { WORKSPACE_SNAPSHOT_FIXTURE } from '../protocol-fixtures/fixtures.js';
import { workspaceToLegacyReadModel } from '../src/workspace/legacyAdapters.js';

describe('legacy workspace read adapters', () => {
  it('projects the canonical workspace into legacy project and pane lists', () => {
    if (WORKSPACE_SNAPSHOT_FIXTURE.type !== 'workspace.snapshot.result') return;

    const legacy = workspaceToLegacyReadModel(WORKSPACE_SNAPSHOT_FIXTURE.workspace);

    expect(legacy.projects).toEqual([{
      id: 'project-1',
      displayName: 'psyche-build',
      attentionCount: 1,
    }]);
    expect(legacy.panes.map((pane) => ({
      id: pane.id,
      projectId: pane.projectId,
      worktreePath: pane.worktreePath,
      status: pane.status,
    }))).toEqual([
      { id: '%3', projectId: 'project-1', worktreePath: '/repo', status: 'working' },
      { id: 'coven:review', projectId: 'project-1', worktreePath: '/worktrees/review', status: 'waiting' },
      { id: '%9', projectId: 'project-1', worktreePath: null, status: 'unknown' },
    ]);
  });

  it('is a read-only detached projection', () => {
    if (WORKSPACE_SNAPSHOT_FIXTURE.type !== 'workspace.snapshot.result') return;
    const workspace = WORKSPACE_SNAPSHOT_FIXTURE.workspace;
    const legacy = workspaceToLegacyReadModel(workspace);

    legacy.projects[0].displayName = 'changed by legacy client';
    legacy.panes[0].displayName = 'changed pane';

    expect(workspace.projects[0].title).toBe('psyche-build');
    expect(workspace.projects[0].worktrees[0].panes[0].title).not.toBe('changed pane');
  });
});
