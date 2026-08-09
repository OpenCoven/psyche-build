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
      {
        path: '/external/review',
        head: '987654',
        branch: 'review',
        isMain: false,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
        dirty: false,
        missing: false,
      },
    ]);

    const listCovenSessions = vi.fn(async (root: string) => root === '/external/review' ? [{
      id: 'external-session',
      projectRoot: '/external/review',
      cwd: '/external/review',
      harness: 'coven-code',
      title: 'External review',
      status: 'running' as const,
      createdAt: '2026-08-04T00:00:00Z',
      updatedAt: '2026-08-04T00:01:00Z',
    }] : [{
      id: 'session-1',
      projectRoot: '/repo',
      cwd: '/repo',
      harness: 'coven-code',
      title: 'Review',
      status: 'waiting' as const,
      createdAt: '2026-08-04T00:00:00Z',
      updatedAt: '2026-08-04T00:01:00Z',
    }]);

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
      listCovenSessions,
    });

    expect(readWorktrees).toHaveBeenCalledWith('/repo');
    expect(listCovenSessions).toHaveBeenCalledTimes(3);
    expect(listCovenSessions).toHaveBeenCalledWith('/external/review');
    expect(snapshot).toMatchObject({
      revision: 42,
      projects: [{
        id: '/repo',
        root: '/repo',
        title: 'repo',
        runningCount: 2,
        attentionCount: 1,
        worktrees: [
          {
            path: '/repo',
            branch: 'main',
            panes: [{ id: 'session-1', kind: 'coven-session', needsAttention: true }],
          },
          {
            path: '/external/review',
            panes: [{ id: 'external-session', kind: 'coven-session' }],
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

  it('normalizes and deduplicates worktree aliases before fetching Coven sessions', async () => {
    const duplicateWorktrees = [
      {
        path: '/repo/w/.',
        head: 'bbbb',
        branch: 'review',
        isMain: false,
        detached: false,
        bare: false,
        locked: true,
        lockReason: 'manual review',
        prunable: true,
        pruneReason: 'gitdir file points to non-existent location',
        dirty: false,
        missing: false,
      },
      {
        path: '/repo/.',
        head: 'aaaa',
        branch: 'main',
        isMain: false,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
        dirty: false,
        missing: false,
      },
      {
        path: '/repo/w',
        head: 'cccc',
        isMain: false,
        detached: true,
        bare: true,
        locked: false,
        prunable: false,
        dirty: true,
        missing: false,
      },
    ];
    const readWorktrees = vi.fn(() => duplicateWorktrees);
    const listCovenSessions = vi.fn(async (_root: string) => []);

    const ordered = await readDaemonWorkspaceSnapshot('/repo', {
      revision: () => 99,
      readWorktrees,
      listPanes: async () => [{ id: '%2', cwd: '/repo/w/packages/app', title: 'review shell' }],
      listCovenSessions,
    });

    const reversed = await readDaemonWorkspaceSnapshot('/repo', {
      revision: () => 99,
      readWorktrees: () => [...duplicateWorktrees].reverse(),
      listPanes: async () => [{ id: '%2', cwd: '/repo/w/packages/app', title: 'review shell' }],
      listCovenSessions: async () => [],
    });

    expect(JSON.stringify(ordered)).toBe(JSON.stringify(reversed));
    expect(listCovenSessions.mock.calls.map(([root]) => root)).toEqual(['/repo', '/repo/w']);
    expect(ordered.projects[0].worktrees.map((worktree) => worktree.path)).toEqual(['/repo', '/repo/w']);
    expect(ordered.projects[0].worktrees[1]).toMatchObject({
      path: '/repo/w',
      panes: [{ id: '%2', kind: 'terminal' }],
      dirty: true,
      locked: true,
      prunable: true,
      bare: true,
    });
  });
});
