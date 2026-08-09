import { describe, expect, it } from 'vitest';

import type { CovenSessionSummary } from '../src/daemon/protocol.js';
import type { PsychePane, SidebarProject } from '../src/types.js';
import type { GitWorktreeSnapshotInput, PaneSnapshot } from '../src/workspace/snapshot.js';
import { buildTuiWorkspaceSnapshot } from '../src/workspace/tuiSnapshot.js';

function worktree(
  worktreePath: string,
  overrides: Partial<GitWorktreeSnapshotInput> = {},
): GitWorktreeSnapshotInput {
  return {
    path: worktreePath,
    head: overrides.head ?? `head:${worktreePath}`,
    branch: overrides.branch ?? (overrides.isMain ? 'main' : undefined),
    isMain: overrides.isMain ?? false,
    detached: overrides.detached ?? false,
    bare: overrides.bare ?? false,
    locked: overrides.locked ?? false,
    lockReason: overrides.lockReason,
    prunable: overrides.prunable ?? false,
    pruneReason: overrides.pruneReason,
    dirty: overrides.dirty ?? false,
    missing: overrides.missing ?? false,
  };
}

function pane(overrides: Partial<PsychePane> & Pick<PsychePane, 'id' | 'slug' | 'paneId'>): PsychePane {
  return {
    prompt: overrides.prompt ?? '',
    ...overrides,
  };
}

function session(
  overrides: Partial<CovenSessionSummary> & Pick<CovenSessionSummary, 'id' | 'projectRoot'>,
): CovenSessionSummary {
  return {
    id: overrides.id,
    projectRoot: overrides.projectRoot,
    cwd: overrides.cwd,
    harness: overrides.harness ?? 'coven-code',
    title: overrides.title ?? overrides.id,
    status: overrides.status ?? 'running',
    createdAt: overrides.createdAt ?? '2026-08-09T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-08-09T00:01:00.000Z',
    archivedAt: overrides.archivedAt,
  };
}

function project(snapshot: ReturnType<typeof buildTuiWorkspaceSnapshot>, root: string) {
  const match = snapshot.projects.find((candidate) => candidate.root === root);
  expect(match).toBeDefined();
  return match!;
}

function worktreePaneIds(snapshotPanes: PaneSnapshot[]): string[] {
  return snapshotPanes.map((candidate) => candidate.id);
}

describe('TUI workspace snapshot adapter', () => {
  it('includes primary and sidebar projects exactly once even when they are empty', () => {
    const snapshot = buildTuiWorkspaceSnapshot({
      revision: 11,
      primaryProjectRoot: '/repo/primary',
      primaryProjectName: 'Primary',
      sidebarProjects: [
        { projectRoot: '/repo/zeta', projectName: 'Zeta' },
        { projectRoot: '/repo/alpha', projectName: 'Alpha' },
        { projectRoot: '/repo/primary', projectName: 'Primary copy' },
      ] satisfies SidebarProject[],
      panes: [],
      worktreesByProjectRoot: new Map([
        ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
        ['/repo/alpha', [worktree('/repo/alpha', { isMain: true, branch: 'main' })]],
        ['/repo/zeta', [worktree('/repo/zeta', { isMain: true, branch: 'main' })]],
      ]),
    });

    expect(snapshot.revision).toBe(11);
    expect(snapshot.projects.map((candidate) => ({
      root: candidate.root,
      title: candidate.title,
      worktreeCount: candidate.worktrees.length,
      runningCount: candidate.runningCount,
      attentionCount: candidate.attentionCount,
    }))).toEqual([
      {
        root: '/repo/primary',
        title: 'Primary',
        worktreeCount: 1,
        runningCount: 0,
        attentionCount: 0,
      },
      {
        root: '/repo/alpha',
        title: 'Alpha',
        worktreeCount: 1,
        runningCount: 0,
        attentionCount: 0,
      },
      {
        root: '/repo/zeta',
        title: 'Zeta',
        worktreeCount: 1,
        runningCount: 0,
        attentionCount: 0,
      },
    ]);
  });

  it('maps panes to their declared project or the primary fallback and associates the most specific worktree', () => {
    const validLastAgentCheck = Date.parse('2026-08-09T05:00:00.000Z');

    const snapshot = buildTuiWorkspaceSnapshot({
      revision: 12,
      primaryProjectRoot: '/repo/primary',
      primaryProjectName: 'Primary',
      sidebarProjects: [{ projectRoot: '/repo/secondary', projectName: 'Secondary' }],
      panes: [
        pane({
          id: 'config-secondary',
          slug: 'review-agent',
          paneId: '%9',
          projectRoot: '/repo/secondary',
          projectName: 'Secondary',
          worktreePath: '/repo/secondary/.psyche/worktrees/review',
          displayName: 'Review Agent',
          agent: 'codex',
          agentStatus: 'waiting',
          needsAttention: true,
          lastAgentCheck: validLastAgentCheck,
        }),
        pane({
          id: 'config-primary',
          slug: 'feature-shell',
          paneId: '%2',
          worktreePath: '/repo/primary/.psyche/worktrees/feature',
          type: 'shell',
        }),
        pane({
          id: 'config-root',
          slug: 'build',
          paneId: '%5',
          projectRoot: '/repo/primary',
          displayName: 'Build',
          agent: 'claude',
          agentStatus: 'analyzing',
        }),
      ],
      worktreesByProjectRoot: new Map([
        ['/repo/secondary', [
          worktree('/repo/secondary', { isMain: true, branch: 'main' }),
          worktree('/repo/secondary/.psyche/worktrees/review', { branch: 'review' }),
        ]],
        ['/repo/primary', [
          worktree('/repo/primary', { isMain: true, branch: 'main' }),
          worktree('/repo/primary/.psyche/worktrees/feature', { branch: 'feature' }),
        ]],
      ]),
    });

    const primary = project(snapshot, '/repo/primary');
    const secondary = project(snapshot, '/repo/secondary');

    expect(primary.runningCount).toBe(1);
    expect(primary.attentionCount).toBe(0);
    expect(primary.worktrees.map((candidate) => ({
      path: candidate.path,
      paneIds: worktreePaneIds(candidate.panes),
    }))).toEqual([
      { path: '/repo/primary', paneIds: ['%5'] },
      { path: '/repo/primary/.psyche/worktrees/feature', paneIds: ['%2'] },
    ]);
    expect(primary.worktrees[0].panes[0]).toMatchObject({
      id: '%5',
      cwd: '/repo/primary',
      title: 'Build',
      kind: 'agent',
      agent: 'claude',
      status: 'analyzing',
    });
    expect(primary.worktrees[1].panes[0]).toMatchObject({
      id: '%2',
      cwd: '/repo/primary/.psyche/worktrees/feature',
      title: 'feature-shell',
      kind: 'terminal',
      status: 'unknown',
    });

    expect(secondary.runningCount).toBe(0);
    expect(secondary.attentionCount).toBe(1);
    expect(secondary.worktrees[1].panes[0]).toMatchObject({
      id: '%9',
      cwd: '/repo/secondary/.psyche/worktrees/review',
      title: 'Review Agent',
      kind: 'agent',
      agent: 'codex',
      status: 'waiting',
      needsAttention: true,
      lastActivity: new Date(validLastAgentCheck).toISOString(),
    });
  });

  it('maps missing pane status to unknown without inflating running counts', () => {
    const snapshot = buildTuiWorkspaceSnapshot({
      revision: 12,
      primaryProjectRoot: '/repo/primary',
      primaryProjectName: 'Primary',
      panes: [
        pane({
          id: 'shell-pane',
          slug: 'shell-pane',
          paneId: '%2',
          projectRoot: '/repo/primary',
          type: 'shell',
        }),
      ],
      worktreesByProjectRoot: new Map([
        ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
      ]),
    });

    const primary = project(snapshot, '/repo/primary');
    expect(primary.runningCount).toBe(0);
    expect(primary.worktrees[0].panes).toEqual([
      expect.objectContaining({
        id: '%2',
        kind: 'terminal',
        status: 'unknown',
      }),
    ]);
  });

  it('keeps panes on unknown worktrees recoverable at the project level and omits invalid activity timestamps', () => {
    const outOfRangeLastAgentCheck = 8_640_000_000_000_001;

    const snapshot = buildTuiWorkspaceSnapshot({
      revision: 13,
      primaryProjectRoot: '/repo/primary',
      primaryProjectName: 'Primary',
      panes: [
        pane({
          id: 'missing-worktree-pane',
          slug: 'missing-worktree',
          paneId: '%8',
          projectRoot: '/repo/primary',
          worktreePath: '/outside/unpublished-worktree',
          agent: 'codex',
          agentStatus: 'working',
          lastAgentCheck: Number.POSITIVE_INFINITY,
        }),
        pane({
          id: 'negative-timestamp-pane',
          slug: 'negative-timestamp',
          paneId: '%3',
          projectRoot: '/repo/primary',
          agent: 'codex',
          agentStatus: 'idle',
          lastAgentCheck: -10,
        }),
        pane({
          id: 'zero-timestamp-pane',
          slug: 'zero-timestamp',
          paneId: '%1',
          projectRoot: '/repo/primary',
          agent: 'codex',
          agentStatus: 'idle',
          lastAgentCheck: 0,
        }),
        pane({
          id: 'overflow-timestamp-pane',
          slug: 'overflow-timestamp',
          paneId: '%4',
          projectRoot: '/repo/primary',
          agent: 'codex',
          agentStatus: 'idle',
          lastAgentCheck: outOfRangeLastAgentCheck,
        }),
      ],
      worktreesByProjectRoot: new Map([
        ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
      ]),
    });

    const primary = project(snapshot, '/repo/primary');
    expect(primary.projectPanes).toContainEqual(expect.objectContaining({
      id: '%8',
      cwd: '/outside/unpublished-worktree',
      recoverability: 'missing-worktree',
      lastActivity: undefined,
    }));
    expect(primary.worktrees[0].panes).toEqual([
      expect.objectContaining({ id: '%1', lastActivity: undefined }),
      expect.objectContaining({ id: '%3', lastActivity: undefined }),
      expect.objectContaining({ id: '%4', lastActivity: undefined }),
    ]);
  });

  it('deduplicates supplied Coven sessions and remains deterministic across input ordering', () => {
    const sessions = [
      session({
        id: 'session-b',
        projectRoot: '/repo/sidebar',
        cwd: '/repo/sidebar/.psyche/worktrees/beta',
        harness: 'claude',
        status: 'waiting',
        updatedAt: '2026-08-09T01:02:03.000Z',
      }),
      session({
        id: 'session-a',
        projectRoot: '/repo/primary',
        cwd: '/repo/primary',
        harness: 'codex',
        status: 'running',
        updatedAt: '2026-08-09T00:00:01.000Z',
      }),
    ];

    const build = (panes: PsychePane[], sidebarProjects: SidebarProject[], groupedSessions: Map<string, CovenSessionSummary[]>) => (
      buildTuiWorkspaceSnapshot({
        revision: 14,
        primaryProjectRoot: '/repo/primary',
        primaryProjectName: 'Primary',
        panes,
        sidebarProjects,
        covenSessionsByProject: groupedSessions,
        worktreesByProjectRoot: new Map([
          ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
          ['/repo/sidebar', [
            worktree('/repo/sidebar', { isMain: true, branch: 'main' }),
            worktree('/repo/sidebar/.psyche/worktrees/beta', { branch: 'beta' }),
          ]],
        ]),
      })
    );

    const ordered = build(
      [
        pane({ id: 'p2', slug: 'two', paneId: '%2', projectRoot: '/repo/sidebar', agent: 'codex', agentStatus: 'working' }),
        pane({ id: 'p1', slug: 'one', paneId: '%1', projectRoot: '/repo/sidebar', type: 'shell' }),
      ],
      [
        { projectRoot: '/repo/sidebar', projectName: 'Sidebar' },
      ],
      new Map([
        ['/repo/sidebar', [sessions[0], sessions[0]]],
        ['/repo/primary', [sessions[1]]],
      ]),
    );

    const reversed = build(
      [
        pane({ id: 'p1', slug: 'one', paneId: '%1', projectRoot: '/repo/sidebar', type: 'shell' }),
        pane({ id: 'p2', slug: 'two', paneId: '%2', projectRoot: '/repo/sidebar', agent: 'codex', agentStatus: 'working' }),
      ],
      [
        { projectRoot: '/repo/sidebar', projectName: 'Sidebar' },
        { projectRoot: '/repo/primary', projectName: 'Primary duplicate' },
      ],
      new Map([
        ['/repo/primary', [sessions[1]]],
        ['/repo/sidebar', [sessions[0]]],
      ]),
    );

    expect(ordered).toEqual(reversed);

    const primary = project(ordered, '/repo/primary');
    const sidebar = project(ordered, '/repo/sidebar');

    expect(primary.worktrees[0].panes).toContainEqual(expect.objectContaining({
      id: 'session-a',
      kind: 'coven-session',
      lastActivity: '2026-08-09T00:00:01.000Z',
    }));
    expect(sidebar.worktrees[1].panes).toContainEqual(expect.objectContaining({
      id: 'session-b',
      kind: 'coven-session',
      needsAttention: true,
      lastActivity: '2026-08-09T01:02:03.000Z',
    }));
    expect(sidebar.worktrees[0].panes.map((candidate) => candidate.id)).toEqual(['%1', '%2']);
    expect(sidebar.worktrees[1].panes.filter((candidate) => candidate.id === 'session-b')).toHaveLength(1);
  });

  it('selects the same duplicate Coven record regardless of grouped-map order', () => {
    const duplicatePrimary = session({
      id: 'session-dup',
      projectRoot: '/repo/primary',
      cwd: '/repo/primary',
      harness: 'zeta',
      title: 'Zulu',
      status: 'waiting',
      updatedAt: '2026-08-09T01:02:03.000Z',
    });
    const duplicateSidebar = session({
      id: 'session-dup',
      projectRoot: '/repo/sidebar',
      cwd: '/repo/sidebar/.psyche/worktrees/beta',
      harness: 'alpha',
      title: 'Alpha',
      status: 'running',
      updatedAt: '2026-08-09T01:02:03.000Z',
    });

    const build = (groupedSessions: Map<string, CovenSessionSummary[]>) => (
      buildTuiWorkspaceSnapshot({
        revision: 15,
        primaryProjectRoot: '/repo/primary',
        primaryProjectName: 'Primary',
        sidebarProjects: [{ projectRoot: '/repo/sidebar', projectName: 'Sidebar' }],
        panes: [],
        covenSessionsByProject: groupedSessions,
        worktreesByProjectRoot: new Map([
          ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
          ['/repo/sidebar', [
            worktree('/repo/sidebar', { isMain: true, branch: 'main' }),
            worktree('/repo/sidebar/.psyche/worktrees/beta', { branch: 'beta' }),
          ]],
        ]),
      })
    );

    const ordered = build(new Map([
      ['/repo/primary', [duplicatePrimary]],
      ['/repo/sidebar', [duplicateSidebar]],
    ]));
    const reversed = build(new Map([
      ['/repo/sidebar', [duplicateSidebar]],
      ['/repo/primary', [duplicatePrimary]],
    ]));

    expect(ordered).toEqual(reversed);

    const primary = project(ordered, '/repo/primary');
    const sidebar = project(ordered, '/repo/sidebar');

    expect(primary.worktrees[0].panes).toContainEqual(expect.objectContaining({
      id: 'session-dup',
      kind: 'coven-session',
      title: 'Zulu',
      agent: 'zeta',
      status: 'waiting',
      needsAttention: true,
      lastActivity: '2026-08-09T01:02:03.000Z',
    }));
    expect(sidebar.worktrees[1].panes.filter((candidate) => candidate.id === 'session-dup')).toHaveLength(0);
  });

  it('emits byte-equivalent snapshots for whitespace-equivalent duplicate Coven records', () => {
    const canonical = session({
      id: 'session-dup',
      projectRoot: '/repo/sidebar',
      cwd: '/repo/sidebar/.psyche/worktrees/beta',
      harness: 'claude',
      title: 'Review lane',
      status: 'waiting',
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T01:02:03.000Z',
    });
    const whitespaceEquivalent = session({
      id: 'session-dup',
      projectRoot: '  /repo/sidebar  ',
      cwd: '  /repo/sidebar/.psyche/worktrees/beta  ',
      harness: '  claude  ',
      title: '  Review lane  ',
      status: '  waiting  ' as CovenSessionSummary['status'],
      createdAt: ' 2026-08-09T00:00:00+00:00 ',
      updatedAt: ' 2026-08-09T03:02:03+02:00 ',
      archivedAt: ' not-a-date ',
    });

    const build = (groupedSessions: Map<string, CovenSessionSummary[]>) => (
      buildTuiWorkspaceSnapshot({
        revision: 16,
        primaryProjectRoot: '/repo/primary',
        primaryProjectName: 'Primary',
        sidebarProjects: [{ projectRoot: '/repo/sidebar', projectName: 'Sidebar' }],
        panes: [],
        covenSessionsByProject: groupedSessions,
        worktreesByProjectRoot: new Map([
          ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
          ['/repo/sidebar', [
            worktree('/repo/sidebar', { isMain: true, branch: 'main' }),
            worktree('/repo/sidebar/.psyche/worktrees/beta', { branch: 'beta' }),
          ]],
        ]),
      })
    );

    const ordered = build(new Map([
      ['/repo/sidebar', [whitespaceEquivalent, canonical]],
    ]));
    const reversed = build(new Map([
      ['/repo/sidebar', [canonical, whitespaceEquivalent]],
    ]));

    expect(JSON.stringify(ordered)).toBe(JSON.stringify(reversed));

    const sidebar = project(ordered, '/repo/sidebar');
    expect(sidebar.worktrees[1].panes).toContainEqual(expect.objectContaining({
      id: 'session-dup',
      cwd: '/repo/sidebar/.psyche/worktrees/beta',
      title: 'Review lane',
      kind: 'coven-session',
      agent: 'claude',
      status: 'waiting',
      needsAttention: true,
      lastActivity: '2026-08-09T01:02:03.000Z',
    }));
  });

  it('selects the same non-primary project title and ordering regardless of sidebar/pane order', () => {
    const build = (sidebarProjects: SidebarProject[], panes: PsychePane[]) => (
      buildTuiWorkspaceSnapshot({
        revision: 17,
        primaryProjectRoot: '/repo/primary',
        primaryProjectName: 'Primary',
        sidebarProjects,
        panes,
        worktreesByProjectRoot: new Map([
          ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
          ['/repo/sidebar', [worktree('/repo/sidebar', { isMain: true, branch: 'main' })]],
          ['/repo/zeta', [worktree('/repo/zeta', { isMain: true, branch: 'main' })]],
        ]),
      })
    );

    const ordered = build(
      [
        { projectRoot: '/repo/zeta', projectName: 'Zeta' },
        { projectRoot: '/repo/sidebar', projectName: 'Zulu' },
        { projectRoot: '/repo/primary', projectName: 'Primary duplicate' },
      ],
      [
        pane({ id: 'sidebar-pane-a', slug: 'one', paneId: '%1', projectRoot: '/repo/sidebar', projectName: 'Alpha' }),
        pane({ id: 'sidebar-pane-z', slug: 'two', paneId: '%3', projectRoot: '/repo/sidebar', projectName: 'Zulu' }),
        pane({ id: 'primary-pane', slug: 'main', paneId: '%2', projectRoot: '/repo/primary', projectName: 'Wrong primary' }),
      ],
    );
    const reversed = build(
      [
        { projectRoot: '/repo/primary', projectName: 'Primary duplicate' },
        { projectRoot: '/repo/sidebar', projectName: 'Zulu' },
        { projectRoot: '/repo/zeta', projectName: 'Zeta' },
      ],
      [
        pane({ id: 'sidebar-pane-z', slug: 'two', paneId: '%3', projectRoot: '/repo/sidebar', projectName: 'Zulu' }),
        pane({ id: 'primary-pane', slug: 'main', paneId: '%2', projectRoot: '/repo/primary', projectName: 'Wrong primary' }),
        pane({ id: 'sidebar-pane-a', slug: 'one', paneId: '%1', projectRoot: '/repo/sidebar', projectName: 'Alpha' }),
      ],
    );

    expect(ordered).toEqual(reversed);
    expect(ordered.projects.map((candidate) => ({
      root: candidate.root,
      title: candidate.title,
    }))).toEqual([
      { root: '/repo/primary', title: 'Primary' },
      { root: '/repo/sidebar', title: 'Alpha' },
      { root: '/repo/zeta', title: 'Zeta' },
    ]);
  });
});
