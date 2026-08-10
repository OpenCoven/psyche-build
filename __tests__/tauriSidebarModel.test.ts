import { describe, expect, it } from 'vitest';

import {
  SIDEBAR_ACTIVE_WINDOW_MS,
  SIDEBAR_FILTERS,
  buildSidebarProjectModel,
  deriveCovenSidebarStatus,
  deriveLocalSidebarStatus,
  localSidebarSelectionKey,
  matchTextRanges,
  normalizeSidebarFilter,
  sidebarSelectionKey,
  sidebarTailIsWorking,
} from '../native/macos/psyche-build-tauri/web/sessions/sidebar-model.mjs';

const baseProject = {
  id: 'psyche',
  name: 'PSYCHE-BUILD',
  root: '/repo/psyche-build',
  collapsed: false,
  selectedWorktreePath: '/repo/psyche-build-wt',
  worktrees: [{
    path: '/repo/psyche-build-wt',
    branch: 'feat/web-pane-attention',
    collapsed: false,
    dirty: true,
    missing: false,
  }],
};

function localSession(id: string, values: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    kind: 'shell',
    status: 'running',
    worktreePath: '/repo/psyche-build-wt',
    ...values,
  };
}

function covenSession(id: string, values: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    harness: 'Coven',
    status: 'running',
    cwd: '/repo/psyche-build-wt',
    projectRoot: '/repo/psyche-build',
    ...values,
  };
}

function rowTitlesById(result: ReturnType<typeof buildSidebarProjectModel>) {
  return Object.fromEntries(
    result.branches.flatMap((branch) => (
      branch.categories.flatMap((category) => (
        category.rows.map((row) => [row.id, row.title] as const)
      ))
    )),
  );
}

describe('Tauri sidebar model', () => {
  it('exports the supported filters and activity window', () => {
    expect(SIDEBAR_FILTERS).toEqual(['all', 'agents', 'shells', 'active', 'attention']);
    expect(SIDEBAR_ACTIVE_WINDOW_MS).toBe(8_000);
  });

  it('derives local status with exact precedence, labels, and icons', () => {
    expect(deriveLocalSidebarStatus({
      status: 'exited',
      needsAttention: true,
      spawning: true,
      isWorking: true,
      lastOutputAt: 9_999,
    }, 10_000)).toEqual({
      key: 'exited',
      label: 'EXITED',
      icon: '×',
      tooltip: 'Exited — process has ended',
    });
    expect(deriveLocalSidebarStatus({
      status: 'running',
      needsAttention: true,
      spawning: true,
      isWorking: true,
      lastOutputAt: 9_999,
    }, 10_000)).toEqual({
      key: 'attention',
      label: 'REPLY',
      icon: '!',
      tooltip: 'Attention — waiting for your response',
    });
    expect(deriveLocalSidebarStatus({
      status: 'running',
      spawning: true,
      lastOutputAt: 9_999,
    }, 10_000)).toEqual({
      key: 'busy',
      label: 'BUSY',
      icon: '↻',
      tooltip: 'Busy — process is starting or actively working',
    });
    expect(deriveLocalSidebarStatus({
      status: 'starting',
      needsAttention: false,
      lastOutputAt: 9_999,
    }, 10_000)).toEqual({
      key: 'busy',
      label: 'BUSY',
      icon: '↻',
      tooltip: 'Busy — process is starting or actively working',
    });
    expect(deriveLocalSidebarStatus({
      status: 'running',
      isWorking: true,
      lastOutputAt: 1_000,
    }, 10_000)).toEqual({
      key: 'busy',
      label: 'BUSY',
      icon: '↻',
      tooltip: 'Busy — process is starting or actively working',
    });
    expect(deriveLocalSidebarStatus({
      status: 'running',
      tail: '⠹ compiling…',
      lastOutputAt: 1_000,
    }, 10_000)).toEqual({
      key: 'idle',
      label: 'IDLE',
      icon: '–',
      tooltip: 'Idle — process is alive and ready for input',
    });
    expect(deriveLocalSidebarStatus({
      status: 'running',
      lastOutputAt: 2_000,
    }, 10_000)).toEqual({
      key: 'active',
      label: 'ACTIVE',
      icon: '●',
      tooltip: 'Active — process is alive and recently produced output',
    });
    expect(deriveLocalSidebarStatus({
      status: 'running',
      lastOutputAt: 1_999,
    }, 10_000)).toEqual({
      key: 'idle',
      label: 'IDLE',
      icon: '–',
      tooltip: 'Idle — process is alive and ready for input',
    });
  });

  it('maps Coven statuses to sidebar states', () => {
    expect(deriveCovenSidebarStatus({ status: 'waiting' })).toEqual({
      key: 'attention',
      label: 'REPLY',
      icon: '!',
      tooltip: 'Attention — waiting for your response',
    });
    expect(deriveCovenSidebarStatus({ status: 'starting' }).key).toBe('busy');
    expect(deriveCovenSidebarStatus({ status: 'running' }).key).toBe('busy');
    expect(deriveCovenSidebarStatus({ status: 'failed' }).key).toBe('exited');
    expect(deriveCovenSidebarStatus({ status: 'completed' }).label).toBe('EXITED');
  });

  it('validates filters', () => {
    expect(normalizeSidebarFilter('agents')).toBe('agents');
    expect(normalizeSidebarFilter('ACTIVE')).toBe('active');
    expect(normalizeSidebarFilter(' bad ')).toBe('all');
    expect(normalizeSidebarFilter()).toBe('all');
  });

  it('builds stable Coven and local selection keys', () => {
    expect(sidebarSelectionKey({ source: 'coven', id: 'coven-1' })).toBe('coven:coven-1');
    expect(localSidebarSelectionKey(
      { root: '/repo/psyche-build' },
      {
        id: 'shell-api',
        name: 'shell 8',
        kind: 'shell',
        worktreePath: '/repo/psyche-build-wt',
        launch: { command: '/opt/homebrew/bin/pnpm', args: ['dev', '--host'] },
      },
    )).toBe(
      'psyche:/repo/psyche-build\u0000/repo/psyche-build-wt\u0000shell\u0000shell 8\u0000pnpm dev\u0000shell-api',
    );
    expect(localSidebarSelectionKey(
      { root: '/repo/psyche-build' },
      {
        id: 'shell-no-command',
        name: 'shell 7',
        kind: 'shell',
        worktreePath: '/repo/psyche-build-wt',
      },
    )).toBe(
      'psyche:/repo/psyche-build\u0000/repo/psyche-build-wt\u0000shell\u0000shell 7\u0000shell-no-command\u0000shell-no-command',
    );
  });

  it('groups Coven under Agents and differentiates duplicate shell labels', () => {
    const result = buildSidebarProjectModel({
      project: baseProject,
      localSessions: [
        localSession('shell-api', {
          name: 'shell 8',
          launch: { command: 'pnpm', args: ['dev'] },
          lastOutputAt: 9_000,
        }),
        localSession('shell-tests', {
          name: 'shell 8',
          launch: { command: 'vitest', args: ['--watch'] },
          lastOutputAt: 8_500,
        }),
      ],
      covenSessions: [covenSession('coven-1', { title: 'Agent Coven' })],
      query: '',
      filter: 'all',
      selectedKey: '',
      now: 10_000,
    });

    expect(result.branches).toHaveLength(1);
    expect(result.branches[0].categories.map((category) => category.label)).toEqual([
      'Agents',
      'Shells',
    ]);
    expect(result.branches[0].categories[0].rows[0]).toMatchObject({
      title: 'Agent Coven',
      source: 'coven',
      kind: 'agent',
      type: 'agents',
      meta: expect.stringContaining('Coven'),
    });
    expect(result.branches[0].categories[1].rows.map((row) => row.title)).toEqual([
      'shell 8 · pnpm dev',
      'shell 8 · vitest --watch',
    ]);
  });

  it('uses stable ordinals for duplicate titles without commands regardless of input order', () => {
    const localSessions = [
      localSession('shell-z', {
        name: 'shell 8',
        lastOutputAt: 9_000,
      }),
      localSession('shell-a', {
        name: 'shell 8',
        lastOutputAt: 9_000,
      }),
    ];

    const forward = buildSidebarProjectModel({
      project: baseProject,
      localSessions,
      covenSessions: [],
      query: '',
      filter: 'all',
      selectedKey: '',
      now: 10_000,
    });
    const reversed = buildSidebarProjectModel({
      project: baseProject,
      localSessions: [...localSessions].reverse(),
      covenSessions: [],
      query: '',
      filter: 'all',
      selectedKey: '',
      now: 10_000,
    });

    expect(rowTitlesById(forward)).toEqual({
      'shell-a': 'shell 8 · 1',
      'shell-z': 'shell 8 · 2',
    });
    expect(rowTitlesById(reversed)).toEqual(rowTitlesById(forward));
  });

  it('suffixes duplicate command details deterministically when commands collide', () => {
    const result = buildSidebarProjectModel({
      project: baseProject,
      localSessions: [
        localSession('shell-z', {
          name: 'shell 8',
          launch: { command: 'pnpm', args: ['dev'] },
          lastOutputAt: 9_000,
        }),
        localSession('shell-a', {
          name: 'shell 8',
          launch: { command: 'pnpm', args: ['dev'] },
          lastOutputAt: 9_000,
        }),
      ],
      covenSessions: [],
      query: '',
      filter: 'all',
      selectedKey: '',
      now: 10_000,
    });

    expect(rowTitlesById(result)).toEqual({
      'shell-a': 'shell 8 · pnpm dev · 1',
      'shell-z': 'shell 8 · pnpm dev · 2',
    });
    expect(result.branches[0].categories[0].rows.map((row) => row.selectionKey)).toEqual([
      'psyche:/repo/psyche-build\u0000/repo/psyche-build-wt\u0000shell\u0000shell 8\u0000pnpm dev\u0000shell-a',
      'psyche:/repo/psyche-build\u0000/repo/psyche-build-wt\u0000shell\u0000shell 8\u0000pnpm dev\u0000shell-z',
    ]);
  });

  it('sorts selected, attention, busy, active, idle, exited, then recency and key', () => {
    const sessions = [
      localSession('z-idle', { name: 'idle-z', lastOutputAt: 1_000 }),
      localSession('selected', { name: 'selected', lastOutputAt: 1_000 }),
      localSession('recent-active', { name: 'recent-active', lastOutputAt: 9_000 }),
      localSession('attention', { name: 'attention', needsAttention: true, lastOutputAt: 9_000 }),
      localSession('busy', { name: 'busy', status: 'starting', spawning: true }),
      localSession('exited', { name: 'exited', status: 'exited' }),
      localSession('a-idle', { name: 'idle-a', lastOutputAt: 1_000 }),
    ];
    const selectedKey = localSidebarSelectionKey(baseProject, sessions[1]);
    const result = buildSidebarProjectModel({
      project: baseProject,
      localSessions: sessions,
      covenSessions: [],
      query: '',
      filter: 'all',
      selectedKey,
      now: 10_000,
    });

    expect(result.branches[0].categories[0].rows.map((row) => row.title)).toEqual([
      'selected',
      'attention',
      'busy',
      'recent-active',
      'idle-a',
      'idle-z',
      'exited',
    ]);
  });

  it('searches across project, branch, category, title, id, kind, command, status, harness, cwd, and metadata', () => {
    const baseOptions = {
      project: baseProject,
      localSessions: [
        localSession('shell-tests', {
          name: 'shell 8',
          kind: 'shell',
          cwd: '/repo/psyche-build-wt/packages/ui',
          lastOutputAt: 9_000,
          launch: {
            command: 'vitest',
            args: ['--watch'],
            cwd: '/repo/psyche-build-wt/apps/web',
          },
        }),
        localSession('agent-local', {
          name: 'Planner',
          kind: 'agent',
          lastOutputAt: 0,
        }),
      ],
      covenSessions: [
        covenSession('coven-1', {
          title: 'Agent Coven',
          harness: 'Harness-X',
          cwd: '/repo/psyche-build-wt/services/api',
          status: 'waiting',
        }),
      ],
      filter: 'all',
      selectedKey: '',
      now: 10_000,
    };

    for (const query of [
      'psyche-build',
      '/repo/psyche-build',
      'web-pane-attention',
      '/repo/psyche-build-wt',
      'shells',
      'planner',
      'coven-1',
      'agent',
      'vitest',
      'reply',
      'waiting for your response',
      'harness-x',
      '/packages/ui',
      '/apps/web',
      '/services/api',
      'ready',
    ]) {
      expect(buildSidebarProjectModel({ ...baseOptions, query }).visibleCount).toBeGreaterThan(0);
    }
    expect(buildSidebarProjectModel({ ...baseOptions, query: 'missing' }).visibleCount).toBe(0);
  });

  it('applies filters including Active as busy plus active', () => {
    const result = buildSidebarProjectModel({
      project: baseProject,
      localSessions: [
        localSession('agent-busy', { kind: 'agent', status: 'starting', spawning: true }),
        localSession('shell-active', { kind: 'shell', lastOutputAt: 9_000 }),
        localSession('shell-idle', { kind: 'shell', lastOutputAt: 500 }),
        localSession('shell-attention', { kind: 'shell', needsAttention: true }),
      ],
      covenSessions: [covenSession('coven-attention', { status: 'waiting' })],
      query: '',
      filter: 'active',
      selectedKey: '',
      now: 10_000,
    });

    expect(result.visibleCount).toBe(2);
    expect(result.branches[0].categories.map((category) => category.label)).toEqual([
      'Agents',
      'Shells',
    ]);
    expect(result.branches[0].categories[0].rows.map((row) => row.id)).toEqual(['agent-busy']);
    expect(result.branches[0].categories[1].rows.map((row) => row.id)).toEqual(['shell-active']);

    expect(buildSidebarProjectModel({
      project: baseProject,
      localSessions: [localSession('shell-active', { lastOutputAt: 9_000 })],
      covenSessions: [covenSession('coven-busy')],
      query: '',
      filter: 'agents',
      selectedKey: '',
      now: 10_000,
    }).branches[0].categories.map((category) => category.label)).toEqual(['Agents']);

    expect(buildSidebarProjectModel({
      project: baseProject,
      localSessions: [localSession('shell-attention', { needsAttention: true })],
      covenSessions: [covenSession('coven-attention', { status: 'waiting' })],
      query: '',
      filter: 'attention',
      selectedKey: '',
      now: 10_000,
    }).visibleCount).toBe(2);

    const shellsOnly = buildSidebarProjectModel({
      project: baseProject,
      localSessions: [
        localSession('shell-active', { kind: 'shell', lastOutputAt: 9_000 }),
        localSession('agent-local', { kind: 'agent', lastOutputAt: 9_000 }),
      ],
      covenSessions: [covenSession('coven-attention', { status: 'waiting' })],
      query: '',
      filter: 'shells',
      selectedKey: '',
      now: 10_000,
    });

    expect(shellsOnly.visibleCount).toBe(1);
    expect(shellsOnly.branches[0].categories.map((category) => category.label)).toEqual(['Shells']);
    expect(shellsOnly.branches[0].categories[0].rows.map((row) => row.id)).toEqual(['shell-active']);
  });

  it('exposes stable project, branch, and category keys with count and attention totals', () => {
    const result = buildSidebarProjectModel({
      project: baseProject,
      localSessions: [
        localSession('shell-active', { kind: 'shell', lastOutputAt: 9_000 }),
        localSession('shell-idle', { kind: 'shell', lastOutputAt: 500 }),
        localSession('agent-local', { kind: 'agent', needsAttention: true }),
      ],
      covenSessions: [covenSession('coven-attention', { status: 'waiting' })],
      query: '',
      filter: 'all',
      selectedKey: '',
      now: 10_000,
    });

    expect(result).toMatchObject({
      key: 'project:psyche',
      count: 4,
      visibleCount: 4,
      attentionCount: 2,
    });
    expect(result.branches).toHaveLength(1);
    expect(result.branches[0]).toMatchObject({
      key: 'branch:/repo/psyche-build-wt',
      count: 4,
      attentionCount: 2,
    });
    expect(result.branches[0].categories).toMatchObject([
      { key: 'agents', count: 2 },
      { key: 'shells', count: 2 },
    ]);
  });

  it('sorts same-status rows by recency before key fallback', () => {
    const result = buildSidebarProjectModel({
      project: baseProject,
      localSessions: [
        localSession('active-older', { name: 'active-older', lastOutputAt: 8_500 }),
        localSession('active-newer', { name: 'active-newer', lastOutputAt: 9_000 }),
        localSession('active-oldest', { name: 'active-oldest', lastOutputAt: 8_100 }),
      ],
      covenSessions: [],
      query: '',
      filter: 'all',
      selectedKey: '',
      now: 10_000,
    });

    expect(result.branches[0].categories[0].rows.map((row) => row.id)).toEqual([
      'active-newer',
      'active-older',
      'active-oldest',
    ]);
  });

  it('returns case-insensitive non-overlapping match ranges and highlights project, branch, category, title, and metadata', () => {
    expect(matchTextRanges('Bananana', 'ana')).toEqual([[1, 4], [5, 8]]);
    expect(matchTextRanges('Hello', '')).toEqual([]);
    expect(matchTextRanges('Agent Coven', 'cOv')).toEqual([[6, 9]]);

    const options = {
      project: { ...baseProject, name: 'Agent Garden' },
      localSessions: [
        localSession('shell-agent', {
          name: 'Agent shell',
          launch: { command: 'agent', args: ['watch'] },
          lastOutputAt: 9_000,
        }),
      ],
      covenSessions: [covenSession('agent-coven', { title: 'Agent Coven' })],
      filter: 'all',
      selectedKey: '',
      now: 10_000,
    };
    const result = buildSidebarProjectModel({ ...options, query: 'agent' });

    expect(result.titleMatches).toEqual([[0, 5]]);
    expect(result.branches[0].titleMatches).toEqual([]);
    expect(result.branches[0].categories[0].labelMatches).toEqual([[0, 5]]);
    expect(result.branches[0].categories[0].rows[0].titleMatches).toEqual([[0, 5]]);
    expect(result.branches[0].categories[1].rows[0].metaMatches).toEqual([[0, 5]]);

    const branchResult = buildSidebarProjectModel({ ...options, query: 'web-pane' });

    expect(branchResult.branches[0].title).toBe('feat/web-pane-attention');
    expect(branchResult.branches[0].titleMatches).toEqual([[5, 13]]);
  });

  it('adds exact highlight ranges for searchable status labels', () => {
    const baseOptions = {
      project: baseProject,
      localSessions: [localSession('busy-shell', {
        name: 'busy-shell',
        status: 'starting',
        spawning: true,
      })],
      covenSessions: [covenSession('reply-coven', {
        title: 'reply-coven',
        status: 'waiting',
      })],
      filter: 'all',
      selectedKey: '',
      now: 10_000,
    };

    const busyResult = buildSidebarProjectModel({ ...baseOptions, covenSessions: [], query: 'busy' });
    expect(busyResult.branches[0].categories[0].rows[0].statusMatches).toEqual([[0, 4]]);

    const replyResult = buildSidebarProjectModel({ ...baseOptions, localSessions: [], query: 'reply' });
    expect(replyResult.branches[0].categories[0].rows[0].statusMatches).toEqual([[0, 5]]);
  });

  it('temporarily expands matching collapsed groups without mutating the source project or worktree', () => {
    const project = {
      ...baseProject,
      collapsed: true,
      worktrees: [{ ...baseProject.worktrees[0], collapsed: true }],
    };

    const result = buildSidebarProjectModel({
      project,
      localSessions: [localSession('shell-1', { lastOutputAt: 9_000 })],
      covenSessions: [covenSession('coven-1')],
      query: 'psyche-build',
      filter: 'bad-filter',
      selectedKey: '',
      now: 10_000,
    });

    expect(project.collapsed).toBe(true);
    expect(project.worktrees[0].collapsed).toBe(true);
    expect(result.expanded).toBe(true);
    expect(result.autoExpanded).toBe(true);
    expect(result.branches[0].expanded).toBe(true);
    expect(result.branches[0].autoExpanded).toBe(true);
    expect(result.visibleCount).toBe(2);
  });

  it('keeps unresolved sessions in a virtual Unresolved sessions branch', () => {
    const result = buildSidebarProjectModel({
      project: baseProject,
      localSessions: [localSession('orphan-shell', {
        worktreePath: '/elsewhere/branch',
        lastOutputAt: 9_000,
      })],
      covenSessions: [covenSession('orphan-coven', {
        cwd: '/another/place',
      })],
      query: '',
      filter: 'all',
      selectedKey: '',
      now: 10_000,
    });

    expect(result.branches.map((branch) => branch.title)).toEqual(['Unresolved sessions']);
    expect(result.branches[0]).toMatchObject({
      title: 'Unresolved sessions',
      worktree: expect.objectContaining({ missing: true, virtual: true }),
    });
    expect(result.branches[0].categories[0].rows.map((row) => row.id)).toEqual(['orphan-coven']);
    expect(result.branches[0].categories[1].rows.map((row) => row.id)).toEqual(['orphan-shell']);
  });

  it('exposes the shared working-indicator helper', () => {
    expect(sidebarTailIsWorking('⠹ compiling…')).toBe(true);
    expect(sidebarTailIsWorking('All done.')).toBe(false);
  });
});
