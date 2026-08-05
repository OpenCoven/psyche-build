import { describe, expect, it, vi } from 'vitest';

import { readDaemonWorkspaceSnapshot } from '../../src/daemon/workspace.js';

describe('daemon workspace snapshot', () => {
  it('projects panes and Coven sessions under their owning worktrees', async () => {
    const readWorktrees = vi.fn(() => [
      {
        path: '/repo',
        head: 'abc123',
        branch: 'main',
        isMain: true,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
        dirty: false,
        missing: false,
      },
      {
        path: '/repo/.worktrees/feature',
        head: 'def456',
        branch: 'feature',
        isMain: false,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
        dirty: true,
        missing: false,
      },
    ]);

    const snapshot = await readDaemonWorkspaceSnapshot('/repo', {
      revision: () => 42,
      readWorktrees,
      listPanes: async () => [{
        id: '%7',
        cwd: '/repo/.worktrees/feature',
        branch: 'feature',
        agent: 'codex',
        title: 'Implement rail',
      }],
      listCovenSessions: async () => [{
        id: 'session-1',
        projectRoot: '/repo',
        cwd: '/repo',
        harness: 'coven-code',
        title: 'Review',
        status: 'waiting',
        createdAt: '2026-08-04T00:00:00Z',
        updatedAt: '2026-08-04T00:01:00Z',
      }],
    });

    expect(readWorktrees).toHaveBeenCalledWith('/repo');
    expect(snapshot).toMatchObject({
      revision: 42,
      projects: [{
        id: '/repo',
        root: '/repo',
        title: 'repo',
        runningCount: 1,
        attentionCount: 1,
        worktrees: [
          {
            path: '/repo',
            branch: 'main',
            panes: [{ id: 'session-1', kind: 'coven-session', needsAttention: true }],
          },
          {
            path: '/repo/.worktrees/feature',
            branch: 'feature',
            dirty: true,
            panes: [{ id: '%7', kind: 'agent', agent: 'codex' }],
          },
        ],
      }],
    });
  });

  it('keeps the tmux projection available when Coven is offline', async () => {
    const snapshot = await readDaemonWorkspaceSnapshot('/repo', {
      revision: () => 7,
      readWorktrees: () => [],
      listPanes: async () => [{ id: '%1', cwd: '/repo', title: 'shell' }],
      listCovenSessions: async () => {
        throw new Error('coven unavailable');
      },
    });

    expect(snapshot.projects[0].projectPanes).toEqual([
      expect.objectContaining({ id: '%1', kind: 'terminal' }),
    ]);
  });
});
