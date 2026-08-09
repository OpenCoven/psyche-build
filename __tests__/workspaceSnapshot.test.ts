import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceSnapshot,
  normalizeIsoDateString,
  parseGitWorktreePorcelain,
  readProjectWorktrees,
  readProjectWorktreesAsync,
} from '../src/workspace/snapshot.js';

describe('workspace snapshot', () => {
  it('parses main, detached, locked, and prunable worktrees', () => {
    expect(parseGitWorktreePorcelain([
      'worktree /repo',
      'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'branch refs/heads/main',
      '',
      'worktree /external/review',
      'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'detached',
      'locked in use',
      '',
      'worktree /repo/.psyche/worktrees/stale',
      'HEAD 0000000000000000000000000000000000000000',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n'))).toEqual([
      {
        path: '/repo',
        head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
        path: '/external/review',
        head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        isMain: false,
        detached: true,
        bare: false,
        locked: true,
        lockReason: 'in use',
        prunable: false,
        dirty: false,
        missing: false,
      },
      {
        path: '/repo/.psyche/worktrees/stale',
        head: '0000000000000000000000000000000000000000',
        isMain: false,
        detached: false,
        bare: false,
        locked: false,
        prunable: true,
        pruneReason: 'gitdir file points to non-existent location',
        dirty: false,
        missing: true,
      },
    ]);
  });

  it('reads dirty state for every usable worktree without assuming its location', () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const worktrees = readProjectWorktrees('/repo', (cwd, args) => {
      calls.push({ cwd, args });
      if (args.join(' ') === 'worktree list --porcelain') {
        return [
          'worktree /repo',
          'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'branch refs/heads/main',
          '',
          'worktree /external/review',
          'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'branch refs/heads/feat/review',
          '',
        ].join('\n');
      }
      return cwd === '/external/review' ? ' M src/index.ts\n' : '';
    });

    expect(worktrees.map((worktree) => ({ path: worktree.path, dirty: worktree.dirty }))).toEqual([
      { path: '/repo', dirty: false },
      { path: '/external/review', dirty: true },
    ]);
    expect(calls).toEqual([
      { cwd: '/repo', args: ['worktree', 'list', '--porcelain'] },
      { cwd: '/repo', args: ['status', '--porcelain=v1', '--untracked-files=normal'] },
      { cwd: '/external/review', args: ['status', '--porcelain=v1', '--untracked-files=normal'] },
    ]);
  });

  it('reads worktrees asynchronously without blocking the caller', async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const worktrees = await readProjectWorktreesAsync('/repo', async (cwd, args) => {
      calls.push({ cwd, args });
      if (args.join(' ') === 'worktree list --porcelain') {
        return [
          'worktree /repo',
          'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'branch refs/heads/main',
          '',
          'worktree /external/review',
          'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'branch refs/heads/feat/review',
          '',
        ].join('\n');
      }
      return cwd === '/external/review' ? ' M src/index.ts\n' : '';
    });

    expect(worktrees.map((worktree) => ({ path: worktree.path, dirty: worktree.dirty }))).toEqual([
      { path: '/repo', dirty: false },
      { path: '/external/review', dirty: true },
    ]);
    expect(calls[0]).toEqual({
      cwd: '/repo',
      args: ['worktree', 'list', '--porcelain'],
    });
    expect(calls.slice(1)).toEqual(expect.arrayContaining([
      { cwd: '/repo', args: ['status', '--porcelain=v1', '--untracked-files=normal'] },
      { cwd: '/external/review', args: ['status', '--porcelain=v1', '--untracked-files=normal'] },
    ]));
  });

  it('groups local panes and Coven sessions under the most specific worktree', () => {
    const snapshot = buildWorkspaceSnapshot({
      revision: 7,
      projects: [
        {
          id: 'project-1',
          root: '/repo',
          title: 'psyche-build',
          worktrees: parseGitWorktreePorcelain([
            'worktree /repo',
            'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'branch refs/heads/main',
            '',
            'worktree /external/review',
            'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            'branch refs/heads/feat/review',
            '',
          ].join('\n')),
          panes: [
            {
              id: '%1',
              cwd: '/repo',
              title: 'main shell',
              kind: 'terminal',
              status: 'running',
              needsAttention: false,
            },
            {
              id: '%2',
              cwd: '/external/review/packages/app',
              title: 'review agent',
              kind: 'agent',
              agent: 'codex',
              status: 'waiting',
              needsAttention: true,
            },
          ],
          covenSessions: [
            {
              id: 'coven-1',
              projectRoot: '/repo',
              cwd: '/external/review',
              harness: 'claude',
              title: 'Coven review',
              status: 'running',
              createdAt: '2026-08-04T00:00:00Z',
              updatedAt: '2026-08-04T00:01:00Z',
            },
            {
              id: 'coven-unresolved',
              projectRoot: '/repo',
              cwd: '/tmp/missing-worktree',
              harness: 'codex',
              title: 'Detached session',
              status: 'waiting',
              createdAt: '2026-08-04T00:00:00Z',
              updatedAt: '2026-08-04T00:01:00Z',
            },
          ],
        },
      ],
    });

    expect(snapshot.revision).toBe(7);
    expect(snapshot.projects[0]).toMatchObject({
      id: 'project-1',
      runningCount: 2,
      attentionCount: 2,
    });
    expect(snapshot.projects[0].worktrees[0]).toMatchObject({
      path: '/repo',
      branch: 'main',
      runningCount: 1,
      attentionCount: 0,
      panes: [{ id: '%1', kind: 'terminal' }],
    });
    expect(snapshot.projects[0].worktrees[1]).toMatchObject({
      path: '/external/review',
      branch: 'feat/review',
      runningCount: 1,
      attentionCount: 1,
      panes: [
        { id: '%2', kind: 'agent', agent: 'codex' },
        {
          id: 'coven-1',
          kind: 'coven-session',
          agent: 'claude',
          lastActivity: '2026-08-04T00:01:00.000Z',
        },
      ],
    });
    expect(snapshot.projects[0].projectPanes).toEqual([
      expect.objectContaining({
        id: 'coven-unresolved',
        kind: 'coven-session',
        recoverability: 'missing-worktree',
      }),
    ]);
  });

  it('canonicalizes duplicate worktree aliases into one stable conservative snapshot', () => {
    const build = (worktrees: Array<{
      path: string;
      head: string;
      branch?: string;
      isMain: boolean;
      detached: boolean;
      bare: boolean;
      locked: boolean;
      lockReason?: string;
      prunable: boolean;
      pruneReason?: string;
      dirty: boolean;
      missing: boolean;
    }>) => buildWorkspaceSnapshot({
      revision: 9,
      projects: [
        {
          id: 'project-1',
          root: '/repo',
          title: 'psyche-build',
          worktrees,
          panes: [
            {
              id: '%2',
              cwd: '/repo/w/packages/app',
              title: 'review shell',
              kind: 'terminal',
              status: 'running',
            },
          ],
        },
      ],
    });

    const ordered = build([
      {
        path: '/repo/w/.',
        head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
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
        head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
        head: 'cccccccccccccccccccccccccccccccccccccccc',
        isMain: false,
        detached: true,
        bare: true,
        locked: false,
        prunable: false,
        dirty: true,
        missing: true,
      },
    ]);

    const reversed = build([
      {
        path: '/repo/w',
        head: 'cccccccccccccccccccccccccccccccccccccccc',
        isMain: false,
        detached: true,
        bare: true,
        locked: false,
        prunable: false,
        dirty: true,
        missing: true,
      },
      {
        path: '/repo/.',
        head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
        path: '/repo/w/.',
        head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
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
    ]);

    expect(JSON.stringify(ordered)).toBe(JSON.stringify(reversed));

    const project = ordered.projects[0];
    expect(project.worktrees).toHaveLength(2);
    expect(project.worktrees.map((worktree) => worktree.path)).toEqual(['/repo', '/repo/w']);
    expect(project.worktrees[0]).toMatchObject({
      path: '/repo',
      branch: 'main',
      isMain: true,
    });
    expect(project.worktrees[1]).toMatchObject({
      path: '/repo/w',
      head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      branch: 'review',
      detached: false,
      bare: true,
      locked: true,
      lockReason: 'manual review',
      prunable: true,
      pruneReason: 'gitdir file points to non-existent location',
      dirty: true,
      missing: true,
      panes: [{ id: '%2', kind: 'terminal' }],
    });
  });

  it('normalizes valid Coven updatedAt timestamps and omits invalid ones', () => {
    const snapshot = buildWorkspaceSnapshot({
      revision: 8,
      projects: [
        {
          id: 'project-1',
          root: '/repo',
          title: 'psyche-build',
          worktrees: parseGitWorktreePorcelain([
            'worktree /repo',
            'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'branch refs/heads/main',
            '',
          ].join('\n')),
          panes: [],
          covenSessions: [
            {
              id: 'valid-coven',
              projectRoot: '/repo',
              cwd: '/repo',
              harness: 'claude',
              title: 'Valid',
              status: 'running',
              createdAt: '2026-08-04T00:00:00Z',
              updatedAt: '2026-08-04T00:01:00Z',
            },
            {
              id: 'invalid-coven',
              projectRoot: '/repo',
              cwd: '/repo',
              harness: 'codex',
              title: 'Invalid',
              status: 'waiting',
              createdAt: '2026-08-04T00:00:00Z',
              updatedAt: 'not-a-date',
            },
          ],
        },
      ],
    });

    expect(snapshot.projects[0].worktrees[0].panes).toHaveLength(2);
    expect(snapshot.projects[0].worktrees[0].panes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'invalid-coven',
        kind: 'coven-session',
        lastActivity: undefined,
      }),
      expect.objectContaining({
        id: 'valid-coven',
        kind: 'coven-session',
        lastActivity: '2026-08-04T00:01:00.000Z',
      }),
    ]));
  });

  it('rejects timezone-less datetimes and normalizes explicit Z/offset timestamps identically', () => {
    expect(normalizeIsoDateString(' 2026-08-04T00:01:00 ')).toBeUndefined();
    expect(normalizeIsoDateString('2026-08-04T00:01:00Z'))
      .toBe('2026-08-04T00:01:00.000Z');
    expect(normalizeIsoDateString('2026-08-04T02:01:00+02:00'))
      .toBe('2026-08-04T00:01:00.000Z');
  });
});
