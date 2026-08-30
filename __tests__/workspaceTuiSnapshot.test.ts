import { describe, expect, it } from 'vitest';

import type { CovenSessionSummary } from '../src/daemon/protocol.js';
import type { PsychePane, SidebarProject } from '../src/types.js';
import type {
  GitWorktreeSnapshotInput,
  PaneSnapshot,
  ReadonlyWorkspaceSnapshot,
  RitualPublicationSnapshot,
  WorkspaceSnapshot,
} from '../src/workspace/snapshot.js';
import type { TuiWorkspaceSnapshotInput } from '../src/workspace/tuiSnapshot.js';
import * as tuiSnapshotModule from '../src/workspace/tuiSnapshot.js';

const {
  buildTuiWorkspaceSnapshot,
  createTuiWorkspaceProvider,
  TuiWorkspaceState,
} = tuiSnapshotModule;

type MutableWorkspaceSnapshot = ReturnType<typeof buildTuiWorkspaceSnapshot>;

function createTuiWorkspaceState(
  options?: { initialRevision?: number },
): InstanceType<typeof TuiWorkspaceState> {
  expect(typeof TuiWorkspaceState).toBe('function');
  return new TuiWorkspaceState(options);
}

function assertReadonlyTuiWorkspaceStateSnapshotTypes(): void {
  const state = createTuiWorkspaceState();
  const snapshot: ReadonlyWorkspaceSnapshot = state.snapshot(trackerInput());

  void JSON.stringify(snapshot);

  // @ts-expect-error TuiWorkspaceState snapshots are deeply readonly.
  snapshot.revision = 99;
  // @ts-expect-error TuiWorkspaceState snapshots are deeply readonly.
  snapshot.projects.push(project(snapshot, '/repo/primary'));

  const sidebar = project(snapshot, '/repo/sidebar');
  // @ts-expect-error TuiWorkspaceState snapshots are deeply readonly.
  sidebar.worktrees[1]!.branch = 'mutated';
  // @ts-expect-error TuiWorkspaceState snapshots are deeply readonly.
  sidebar.worktrees[1]!.panes[0]!.title = 'mutated';

  const current: ReadonlyWorkspaceSnapshot | undefined = state.current();
  if (!current) return;

  void JSON.stringify(current);

  // @ts-expect-error TuiWorkspaceState current snapshots are deeply readonly.
  current.projects[0] = project(snapshot, '/repo/primary');
}

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

function project<Snapshot extends { projects: readonly { root: string }[] }>(
  snapshot: Snapshot,
  root: string,
): Snapshot['projects'][number] {
  const match = snapshot.projects.find((candidate) => candidate.root === root);
  expect(match).toBeDefined();
  return match!;
}

function worktreePaneIds(snapshotPanes: readonly Pick<PaneSnapshot, 'id'>[]): string[] {
  return snapshotPanes.map((candidate) => candidate.id);
}

function trackerInput(
  overrides: Partial<TuiWorkspaceSnapshotInput> = {},
): TuiWorkspaceSnapshotInput {
  return {
    primaryProjectRoot: '/repo/primary',
    primaryProjectName: 'Primary',
    sidebarProjects: [
      { projectRoot: '/repo/sidebar', projectName: 'Sidebar' },
      { projectRoot: '/repo/zeta', projectName: 'Zeta' },
    ],
    panes: [
      pane({
        id: 'primary-shell',
        slug: 'primary-shell',
        paneId: '%2',
        projectRoot: '/repo/primary',
        worktreePath: '/repo/primary/.psyche/worktrees/feature',
        type: 'shell',
      }),
      pane({
        id: 'sidebar-review',
        slug: 'sidebar-review',
        paneId: '%9',
        projectRoot: '/repo/sidebar',
        worktreePath: '/repo/sidebar/.psyche/worktrees/review',
        displayName: 'Sidebar Review',
        agent: 'codex',
        agentStatus: 'working',
        needsAttention: true,
        lastAgentCheck: Date.parse('2026-08-09T05:00:00.000Z'),
      }),
    ],
    covenSessionsByProject: new Map([
      ['/repo/primary', [
        session({
          id: 'session-a',
          projectRoot: '/repo/primary',
          cwd: '/repo/primary',
          title: 'Primary Session',
          harness: 'codex',
          status: 'running',
          updatedAt: '2026-08-09T00:00:01.000Z',
        }),
      ]],
      ['/repo/sidebar', [
        session({
          id: 'session-b',
          projectRoot: '/repo/sidebar',
          cwd: '/repo/sidebar/.psyche/worktrees/review',
          title: 'Sidebar Session',
          harness: 'claude',
          status: 'waiting',
          updatedAt: '2026-08-09T00:00:02.000Z',
        }),
        session({
          id: 'session-c',
          projectRoot: '/repo/sidebar',
          cwd: '/repo/sidebar',
          title: 'Sidebar Shell Session',
          harness: 'codex',
          status: 'running',
          updatedAt: '2026-08-09T00:00:03.000Z',
        }),
      ]],
    ]),
    worktreesByProjectRoot: new Map([
      ['/repo/primary', [
        worktree('/repo/primary', { isMain: true, branch: 'main' }),
        worktree('/repo/primary/.psyche/worktrees/feature', { branch: 'feature' }),
      ]],
      ['/repo/sidebar', [
        worktree('/repo/sidebar', { isMain: true, branch: 'main' }),
        worktree('/repo/sidebar/.psyche/worktrees/review', { branch: 'review' }),
      ]],
      ['/repo/zeta', [
        worktree('/repo/zeta', { isMain: true, branch: 'main' }),
      ]],
    ]),
    ...overrides,
  };
}

function reorderedEquivalentTrackerInput(): TuiWorkspaceSnapshotInput {
  return trackerInput({
    primaryProjectRoot: '/repo/primary/./',
    sidebarProjects: [
      { projectRoot: '/repo/zeta/./', projectName: 'Zeta' },
      { projectRoot: '/repo/sidebar/../sidebar', projectName: 'Sidebar' },
    ],
    panes: [
      pane({
        id: 'sidebar-review',
        slug: 'sidebar-review',
        paneId: '%9',
        projectRoot: '/repo/sidebar/../sidebar',
        worktreePath: '/repo/sidebar/.psyche/worktrees/review/../review',
        displayName: 'Sidebar Review',
        agent: 'codex',
        agentStatus: 'working',
        needsAttention: true,
        lastAgentCheck: Date.parse('2026-08-09T05:00:00.000Z'),
      }),
      pane({
        id: 'primary-shell',
        slug: 'primary-shell',
        paneId: '%2',
        projectRoot: '/repo/primary/./',
        worktreePath: '/repo/primary/.psyche/worktrees/feature/./',
        type: 'shell',
      }),
    ],
    covenSessionsByProject: new Map([
      ['/repo/sidebar/../sidebar', [
        session({
          id: 'session-c',
          projectRoot: '/repo/sidebar/../sidebar',
          cwd: '/repo/sidebar',
          title: 'Sidebar Shell Session',
          harness: 'codex',
          status: 'running',
          updatedAt: '2026-08-09T00:00:03.000Z',
        }),
        session({
          id: 'session-b',
          projectRoot: '/repo/sidebar',
          cwd: '/repo/sidebar/.psyche/worktrees/review',
          title: 'Sidebar Session',
          harness: 'claude',
          status: 'waiting',
          updatedAt: '2026-08-09T00:00:02.000Z',
        }),
      ]],
      ['/repo/primary/./', [
        session({
          id: 'session-a',
          projectRoot: '/repo/primary/./',
          cwd: '/repo/primary',
          title: 'Primary Session',
          harness: 'codex',
          status: 'running',
          updatedAt: '2026-08-09T00:00:01.000Z',
        }),
      ]],
    ]),
    worktreesByProjectRoot: new Map([
      ['/repo/zeta/./', [
        worktree('/repo/zeta', { isMain: true, branch: 'main' }),
      ]],
      ['/repo/sidebar/../sidebar', [
        worktree('/repo/sidebar/.psyche/worktrees/review/./', {
          branch: 'review',
          head: 'head:/repo/sidebar/.psyche/worktrees/review',
        }),
        worktree('/repo/sidebar', { isMain: true, branch: 'main' }),
      ]],
      ['/repo/primary/./', [
        worktree('/repo/primary/.psyche/worktrees/feature/./', {
          branch: 'feature',
          head: 'head:/repo/primary/.psyche/worktrees/feature',
        }),
        worktree('/repo/primary', { isMain: true, branch: 'main' }),
      ]],
    ]),
  });
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

  describe('TUI workspace snapshot revision tracker', () => {
    it('normalizes incomplete live Coven visibility records for publication', () => {
      const normalizeCovenSessionsForPublication = (
        tuiSnapshotModule as Record<string, unknown>
      ).normalizeCovenSessionsForPublication as
        | ((sessions: readonly Record<string, unknown>[]) => CovenSessionSummary[])
        | undefined;
      expect(typeof normalizeCovenSessionsForPublication).toBe('function');
      if (!normalizeCovenSessionsForPublication) return;

      expect(normalizeCovenSessionsForPublication([{
        id: ' coven-live ',
        projectRoot: ' /repo/coven-only ',
        harness: ' ',
        title: ' ',
        status: 'unexpected',
        createdAt: 'not-a-date',
        updatedAt: '2026-08-09T00:01:00Z',
      }])).toEqual([{
        id: 'coven-live',
        projectRoot: '/repo/coven-only',
        harness: '',
        title: 'coven-live',
        status: 'created',
        createdAt: '2026-08-09T00:01:00.000Z',
        updatedAt: '2026-08-09T00:01:00.000Z',
      }]);
    });

    it('groups live StateManager Coven sessions into a Coven-only provider project', async () => {
      const groupCovenSessionsByProject = (
        tuiSnapshotModule as Record<string, unknown>
      ).groupCovenSessionsByProject as
        | ((sessions: readonly CovenSessionSummary[]) => Map<string, CovenSessionSummary[]>)
        | undefined;
      expect(typeof groupCovenSessionsByProject).toBe('function');
      if (!groupCovenSessionsByProject) return;

      const liveSession = session({
        id: 'coven-only-session',
        projectRoot: '/repo/coven-only',
        title: 'Coven-only work',
        status: 'waiting',
      });
      const runningSession = session({
        id: 'coven-only-running',
        projectRoot: '/repo/coven-only',
        title: 'Coven-only running work',
      });
      const provider = createTuiWorkspaceProvider({
        primaryProjectRoot: '/repo/primary',
        primaryProjectName: 'Primary',
        panes: () => [],
        covenSessionsByProject: () => groupCovenSessionsByProject([
          liveSession,
          runningSession,
        ]),
        worktreesByProjectRoot: () => new Map([
          ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
          ['/repo/coven-only', []],
        ]),
      });

      const snapshot = await provider();
      const covenOnly = project(snapshot, '/repo/coven-only');

      expect(covenOnly.worktrees).toEqual([]);
      expect(covenOnly.runningCount).toBe(1);
      expect(covenOnly.attentionCount).toBe(1);
      expect(covenOnly.projectPanes).toContainEqual(expect.objectContaining({
        id: 'coven-only-session',
        title: 'Coven-only work',
        agent: 'coven-code',
        status: 'waiting',
      }));
    });

    it('creates the stable canonical provider used by the production bridge', async () => {
      let panes: PsychePane[] = [];
      let sidebarProjects: SidebarProject[] = [
        { projectRoot: '/repo/sidebar', projectName: 'Sidebar' },
      ];
      const provider = createTuiWorkspaceProvider({
        primaryProjectRoot: '/repo/primary',
        primaryProjectName: 'Primary',
        panes: () => panes,
        sidebarProjects: () => sidebarProjects,
        worktreesByProjectRoot: () => new Map([
          ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
          ['/repo/sidebar', [worktree('/repo/sidebar', { isMain: true, branch: 'main' })]],
        ]),
      });

      const first = await provider();
      const repeated = await provider();

      expect(repeated).toBe(first);
      expect(first.revision).toBe(1);
      expect(first.projects.map((candidate) => candidate.root)).toEqual([
        '/repo/primary',
        '/repo/sidebar',
      ]);

      panes = [
        pane({
          id: 'sidebar-agent',
          slug: 'sidebar-agent',
          paneId: '%9',
          projectRoot: '/repo/sidebar',
          worktreePath: '/repo/sidebar',
          displayName: 'Review',
          agentStatus: 'waiting',
          needsAttention: true,
        }),
      ];
      sidebarProjects = [...sidebarProjects];

      const changed = await provider();

      expect(changed.revision).toBe(2);
      expect(project(changed, '/repo/sidebar').attentionCount).toBe(1);
    });

    it('publishes composed ritual metadata scoped to the projects the host publishes', async () => {
      const loadedRoots: string[] = [];
      const provider = createTuiWorkspaceProvider({
        primaryProjectRoot: '/repo/primary',
        primaryProjectName: 'Primary',
        panes: () => [],
        sidebarProjects: () => [{ projectRoot: '/repo/sidebar', projectName: 'Sidebar' }],
        worktreesByProjectRoot: () => new Map([
          ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
          ['/repo/sidebar', [worktree('/repo/sidebar', { isMain: true, branch: 'main' })]],
        ]),
        loadRituals: (projectRoot) => {
          loadedRoots.push(projectRoot);
          return {
            state: 'available',
            rituals: [{
              id: 'release-checklist',
              displayName: 'Release checklist',
              description: 'Prepare a release safely.',
              scope: 'project',
            }],
          };
        },
      });

      const snapshot = await provider();

      // Reads are steered only by canonical published roots, never by a client.
      expect(loadedRoots.sort()).toEqual(['/repo/primary', '/repo/sidebar']);
      for (const published of snapshot.projects) {
        expect(published.rituals).toEqual({
          state: 'available',
          rituals: [{
            id: 'release-checklist',
            displayName: 'Release checklist',
            description: 'Prepare a release safely.',
            scope: 'project',
          }],
        });
      }
      expect(JSON.stringify(snapshot)).not.toContain('"command"');
    });

    it('degrades a failing ritual read to an explicit unavailable listing', async () => {
      const provider = createTuiWorkspaceProvider({
        primaryProjectRoot: '/repo/primary',
        primaryProjectName: 'Primary',
        panes: () => [],
        worktreesByProjectRoot: () => new Map([
          ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
        ]),
        loadRituals: (projectRoot) => {
          if (projectRoot === '/repo/primary') {
            throw new Error('ritual store exploded');
          }
          return { state: 'empty', rituals: [] };
        },
      });

      const snapshot = await provider();

      expect(snapshot.projects).toHaveLength(1);
      expect(snapshot.projects[0]!.rituals).toEqual({ state: 'unavailable', rituals: [] });
    });

    it('publishes every project as unavailable when no ritual loader is wired', async () => {
      const provider = createTuiWorkspaceProvider({
        primaryProjectRoot: '/repo/primary',
        primaryProjectName: 'Primary',
        panes: () => [],
        worktreesByProjectRoot: () => new Map([
          ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
        ]),
      });

      const snapshot = await provider();

      expect(snapshot.projects[0]!.rituals).toEqual({ state: 'unavailable', rituals: [] });
    });

    it('bumps the workspace revision when a published ritual listing changes', async () => {
      const listings: RitualPublicationSnapshot[] = [{
        state: 'empty',
        rituals: [],
      }, {
        state: 'available',
        rituals: [{
          id: 'release-checklist',
          displayName: 'Release checklist',
          scope: 'project',
        }],
      }];
      let read = 0;
      // Reads 1 and 2 see the same listing; read 3 sees it change.
      const readSequence = [0, 0, 1];
      const provider = createTuiWorkspaceProvider({
        primaryProjectRoot: '/repo/primary',
        primaryProjectName: 'Primary',
        panes: () => [],
        worktreesByProjectRoot: () => new Map([
          ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
        ]),
        loadRituals: () => listings[readSequence[Math.min(read++, readSequence.length - 1)]]!,
      });

      const first = await provider();
      const unchanged = await provider();
      const changed = await provider();

      expect(first.revision).toBe(1);
      expect(unchanged).toBe(first);
      expect(changed.revision).toBe(2);
      expect(project(changed, '/repo/primary').rituals).toEqual(listings[1]);
    });

    it('serializes concurrent provider reads so revisions follow request order', async () => {
      let resolveFirstRead: (() => void) | undefined;
      const firstRead = new Promise<void>((resolve) => {
        resolveFirstRead = resolve;
      });
      let readCount = 0;
      const provider = createTuiWorkspaceProvider({
        primaryProjectRoot: '/repo/primary',
        primaryProjectName: 'Primary',
        panes: async () => {
          readCount += 1;
          if (readCount === 1) {
            await firstRead;
            return [];
          }
          return [
            pane({
              id: 'new-pane',
              slug: 'new-pane',
              paneId: '%9',
              projectRoot: '/repo/primary',
              worktreePath: '/repo/primary',
            }),
          ];
        },
        worktreesByProjectRoot: () => new Map([
          ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
        ]),
      });

      const firstRequest = provider();
      const secondRequest = provider();
      await Promise.resolve();
      expect(readCount).toBe(1);

      resolveFirstRead?.();
      const first = await firstRequest;
      const second = await secondRequest;

      expect(first.revision).toBe(1);
      expect(project(first, '/repo/primary').worktrees[0].panes).toEqual([]);
      expect(second.revision).toBe(2);
      expect(project(second, '/repo/primary').worktrees[0].panes).toContainEqual(
        expect.objectContaining({ id: '%9' }),
      );
    });

    it('caches asynchronous worktree discovery across repeated reads', async () => {
      const loadedRoots: string[] = [];
      const provider = createTuiWorkspaceProvider({
        primaryProjectRoot: '/repo/primary',
        primaryProjectName: 'Primary',
        panes: () => [],
        sidebarProjects: () => [
          { projectRoot: '/repo/sidebar', projectName: 'Sidebar' },
        ],
        loadWorktrees: async (projectRoot) => {
          loadedRoots.push(projectRoot);
          return [worktree(projectRoot, { isMain: true, branch: 'main' })];
        },
        worktreeCacheTtlMs: 1_000,
      });

      await provider();
      await provider();

      expect(loadedRoots).toEqual(['/repo/primary', '/repo/sidebar']);
    });

    it('keeps stale sidebar projects when their worktrees cannot be read', async () => {
      const readErrors: Array<{ projectRoot: string; error: unknown }> = [];
      const provider = createTuiWorkspaceProvider({
        primaryProjectRoot: '/repo/primary',
        primaryProjectName: 'Primary',
        panes: () => [],
        sidebarProjects: () => [
          { projectRoot: '/repo/stale', projectName: 'Stale' },
        ],
        loadWorktrees: async (projectRoot) => {
          if (projectRoot === '/repo/stale') {
            throw new Error('project moved');
          }
          return [worktree('/repo/primary', { isMain: true, branch: 'main' })];
        },
        onWorktreeReadError: (projectRoot, error) => {
          readErrors.push({ projectRoot, error });
        },
      });

      const snapshot = await provider();

      expect(snapshot.projects.map((candidate) => candidate.root)).toEqual([
        '/repo/primary',
        '/repo/stale',
      ]);
      expect(project(snapshot, '/repo/primary').worktrees).toHaveLength(1);
      expect(project(snapshot, '/repo/stale').worktrees).toEqual([]);
      expect(readErrors).toEqual([
        {
          projectRoot: '/repo/stale',
          error: expect.objectContaining({ message: 'project moved' }),
        },
      ]);
    });

    it('starts at revision 0 and returns revision 1 for the first snapshot', () => {
      const state = createTuiWorkspaceState();

      expect(state.current()).toBeUndefined();

      const snapshot = state.snapshot({
        primaryProjectRoot: '/repo/primary',
        primaryProjectName: 'Primary',
        panes: [],
        worktreesByProjectRoot: new Map([
          ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
        ]),
      });

      expect(snapshot.revision).toBe(1);
      expect(state.current()).toBe(snapshot);
    });

    it('reuses the same frozen snapshot object for identical and canonically equivalent content', () => {
      const state = createTuiWorkspaceState();

      const first = state.snapshot(trackerInput());
      const repeated = state.snapshot(trackerInput());
      const reorderedEquivalent = state.snapshot(reorderedEquivalentTrackerInput());

      expect(repeated).toBe(first);
      expect(reorderedEquivalent).toBe(first);
      expect(reorderedEquivalent.revision).toBe(1);
    });

    it('increments exactly once when canonical content changes and then stays stable across reads', () => {
      const state = createTuiWorkspaceState();

      const first = state.snapshot(trackerInput());
      const changed = state.snapshot(trackerInput({
        panes: [
          pane({
            id: 'primary-shell',
            slug: 'primary-shell',
            paneId: '%2',
            projectRoot: '/repo/primary',
            worktreePath: '/repo/primary/.psyche/worktrees/feature',
            type: 'shell',
          }),
          pane({
            id: 'sidebar-review',
            slug: 'sidebar-review',
            paneId: '%9',
            projectRoot: '/repo/sidebar',
            worktreePath: '/repo/sidebar/.psyche/worktrees/review',
            displayName: 'Sidebar Review',
            agent: 'codex',
            agentStatus: 'waiting',
            needsAttention: true,
            lastAgentCheck: Date.parse('2026-08-09T05:00:00.000Z'),
          }),
        ],
      }));
      const repeatedChanged = state.snapshot(trackerInput({
        panes: [
          pane({
            id: 'sidebar-review',
            slug: 'sidebar-review',
            paneId: '%9',
            projectRoot: '/repo/sidebar',
            worktreePath: '/repo/sidebar/.psyche/worktrees/review',
            displayName: 'Sidebar Review',
            agent: 'codex',
            agentStatus: 'waiting',
            needsAttention: true,
            lastAgentCheck: Date.parse('2026-08-09T05:00:00.000Z'),
          }),
          pane({
            id: 'primary-shell',
            slug: 'primary-shell',
            paneId: '%2',
            projectRoot: '/repo/primary',
            worktreePath: '/repo/primary/.psyche/worktrees/feature',
            type: 'shell',
          }),
        ],
      }));

      expect(changed).not.toBe(first);
      expect(changed.revision).toBe(2);
      expect(repeatedChanged).toBe(changed);
      expect(repeatedChanged.revision).toBe(2);
    });

    it('current does not build or increment before or after snapshots', () => {
      const state = createTuiWorkspaceState();

      expect(state.current()).toBeUndefined();
      expect(state.current()).toBeUndefined();

      const first = state.snapshot(trackerInput());
      expect(state.current()).toBe(first);
      expect(state.current()?.revision).toBe(1);

      const second = state.snapshot(trackerInput({
        primaryProjectName: 'Primary Workspace',
      }));
      expect(second.revision).toBe(2);
      expect(state.current()).toBe(second);
      expect(state.current()?.revision).toBe(2);
    });

    it('isolates current state from caller mutation after snapshot', () => {
      const state = createTuiWorkspaceState();
      const input = trackerInput();

      const snapshot = state.snapshot(input);

      (input.sidebarProjects as SidebarProject[]).push({
        projectRoot: '/repo/after',
        projectName: 'After',
      });
      input.panes[0].slug = 'mutated-slug';
      input.panes[0].displayName = 'Mutated';
      const sidebarSessions = input.covenSessionsByProject?.get('/repo/sidebar');
      if (sidebarSessions?.[0]) sidebarSessions[0].title = 'Mutated session';
      const sidebarWorktrees = input.worktreesByProjectRoot?.get('/repo/sidebar');
      if (sidebarWorktrees?.[0]) sidebarWorktrees[0].branch = 'mutated-branch';

      const current = state.current();

      expect(current).toBe(snapshot);
      expect(current?.projects.map((candidate) => candidate.root)).toEqual([
        '/repo/primary',
        '/repo/sidebar',
        '/repo/zeta',
      ]);
      expect(project(current!, '/repo/primary').worktrees[1].panes[0]?.title).toBe('primary-shell');
      expect(project(current!, '/repo/sidebar').worktrees[0].branch).toBe('main');
      expect(project(current!, '/repo/sidebar').worktrees[1].panes).toContainEqual(
        expect.objectContaining({
          id: 'session-b',
          title: 'Sidebar Session',
        }),
      );
    });

    it('freezes returned snapshots deeply', () => {
      const snapshot = createTuiWorkspaceState().snapshot(trackerInput());
      // Test-only cast so runtime freeze assertions stay separate from the
      // compile-time readonly assertions above.
      const mutableSnapshot = snapshot as WorkspaceSnapshot;
      const sidebar = project(snapshot, '/repo/sidebar');
      const mutableSidebar = project(mutableSnapshot, '/repo/sidebar');
      const reviewWorktree = sidebar.worktrees[1]!;
      const reviewPane = reviewWorktree.panes[0]!;
      const mutableReviewWorktree = mutableSidebar.worktrees[1]!;

      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.projects)).toBe(true);
      expect(Object.isFrozen(sidebar)).toBe(true);
      expect(Object.isFrozen(sidebar.worktrees)).toBe(true);
      expect(Object.isFrozen(reviewWorktree)).toBe(true);
      expect(Object.isFrozen(reviewWorktree.panes)).toBe(true);
      expect(Object.isFrozen(reviewPane)).toBe(true);

      expect(() => {
        mutableSnapshot.revision = 99;
      }).toThrow(TypeError);
      expect(() => {
        mutableSnapshot.projects.push(project(mutableSnapshot, '/repo/primary'));
      }).toThrow(TypeError);
      expect(() => {
        mutableReviewWorktree.branch = 'mutated';
      }).toThrow(TypeError);
      expect(() => {
        mutableReviewWorktree.panes[0]!.title = 'mutated';
      }).toThrow(TypeError);
    });

    it('throws a clear error when a change would exceed Number.MAX_SAFE_INTEGER', () => {
      const state = createTuiWorkspaceState({ initialRevision: Number.MAX_SAFE_INTEGER });

      expect(() => state.snapshot(trackerInput())).toThrowError(
        'TuiWorkspaceState revision overflow: cannot exceed Number.MAX_SAFE_INTEGER.',
      );
      expect(state.current()).toBeUndefined();
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

  it('associates child and external Coven worktree sessions with their owning project', () => {
    const childWorktree = '/repo/primary/.psyche/worktrees/feature';
    const externalWorktree = '/external/primary-review';
    const snapshot = buildTuiWorkspaceSnapshot({
      revision: 14,
      primaryProjectRoot: '/repo/primary',
      primaryProjectName: 'Primary',
      panes: [],
      covenSessionsByProject: new Map([
        [childWorktree, [
          session({
            id: 'child-session',
            projectRoot: childWorktree,
            cwd: `${childWorktree}/packages/app`,
          }),
        ]],
        [externalWorktree, [
          session({
            id: 'external-session',
            projectRoot: externalWorktree,
            cwd: `${externalWorktree}/packages/app`,
          }),
        ]],
      ]),
      worktreesByProjectRoot: new Map([
        ['/repo/primary', [
          worktree('/repo/primary', { isMain: true, branch: 'main' }),
          worktree(childWorktree, { branch: 'feature' }),
          worktree(externalWorktree, { branch: 'review' }),
        ]],
      ]),
      readWorktrees: () => [],
    });

    expect(snapshot.projects.map((candidate) => candidate.root)).toEqual(['/repo/primary']);
    const primary = project(snapshot, '/repo/primary');
    expect(primary.worktrees.find((candidate) => candidate.path === childWorktree)?.panes)
      .toContainEqual(expect.objectContaining({ id: 'child-session', kind: 'coven-session' }));
    expect(primary.worktrees.find((candidate) => candidate.path === externalWorktree)?.panes)
      .toContainEqual(expect.objectContaining({ id: 'external-session', kind: 'coven-session' }));
  });

  it('canonicalizes Coven-only worktree aliases with explicit worktree maps', () => {
    const mainRoot = '/repo/coven-only';
    const childWorktree = `${mainRoot}/.psyche/worktrees/feature`;
    const externalWorktree = '/external/coven-only-review';
    const build = (
      groupedSessions: Map<string, CovenSessionSummary[]>,
      covenWorktreeEntries: Array<[string, GitWorktreeSnapshotInput[]]>,
    ) => buildTuiWorkspaceSnapshot({
      revision: 14,
      primaryProjectRoot: '/repo/primary',
      primaryProjectName: 'Primary',
      panes: [],
      covenSessionsByProject: groupedSessions,
      worktreesByProjectRoot: new Map([
        ['/repo/primary', [worktree('/repo/primary', { isMain: true, branch: 'main' })]],
        ...covenWorktreeEntries,
      ]),
      readWorktrees: () => [],
    });
    const sessions = new Map([
      [mainRoot, [
        session({
          id: 'main-session',
          projectRoot: mainRoot,
          cwd: `${mainRoot}/packages/app`,
        }),
      ]],
      [childWorktree, [
        session({
          id: 'child-session',
          projectRoot: childWorktree,
          cwd: `${childWorktree}/packages/app`,
        }),
      ]],
      [externalWorktree, [
        session({
          id: 'external-session',
          projectRoot: externalWorktree,
          cwd: `${externalWorktree}/packages/app`,
        }),
      ]],
    ]);
    const mainAlias = [
      worktree(mainRoot, { isMain: true, branch: 'main' }),
      worktree(childWorktree, { branch: 'feature' }),
      worktree(externalWorktree, {
        branch: 'review',
        locked: true,
        lockReason: 'manual review',
        prunable: true,
        pruneReason: 'stale gitdir',
      }),
    ];
    const externalAlias = [
      worktree(mainRoot, { isMain: true, branch: 'main' }),
      worktree(childWorktree, { branch: 'feature' }),
      worktree(externalWorktree, {
        branch: 'review',
        bare: true,
        dirty: true,
        missing: true,
      }),
    ];

    const ordered = build(sessions, [
      [mainRoot, mainAlias],
      [externalWorktree, externalAlias],
    ]);
    const reversed = build(new Map([...sessions].reverse()), [
      [externalWorktree, [...externalAlias].reverse()],
      [mainRoot, [...mainAlias].reverse()],
    ]);

    expect(ordered).toEqual(reversed);
    expect(ordered.projects.map((candidate) => candidate.root)).toEqual([
      '/repo/primary',
      mainRoot,
    ]);

    const covenOnly = project(ordered, mainRoot);
    expect(covenOnly.title).toBe('coven-only');
    expect(covenOnly.worktrees.map((candidate) => candidate.path)).toEqual([
      mainRoot,
      externalWorktree,
      childWorktree,
    ].sort((left, right) => {
      if (left === mainRoot) return -1;
      if (right === mainRoot) return 1;
      return left.localeCompare(right);
    }));
    expect(covenOnly.worktrees.find((candidate) => candidate.path === mainRoot)?.panes)
      .toContainEqual(expect.objectContaining({ id: 'main-session', kind: 'coven-session' }));
    expect(covenOnly.worktrees.find((candidate) => candidate.path === childWorktree)?.panes)
      .toContainEqual(expect.objectContaining({ id: 'child-session', kind: 'coven-session' }));
    expect(covenOnly.worktrees.find((candidate) => candidate.path === externalWorktree))
      .toMatchObject({
        bare: true,
        locked: true,
        lockReason: 'manual review',
        prunable: true,
        pruneReason: 'stale gitdir',
        dirty: true,
        missing: true,
        panes: [expect.objectContaining({
          id: 'external-session',
          kind: 'coven-session',
        })],
      });
  });

  it('discovers and reuses Coven-only linked-worktree ownership without an explicit worktree map', () => {
    const mainRoot = '/repo-main';
    const linkedWorktree = '/repo-wt';
    const readRoots: string[] = [];
    const snapshot = buildTuiWorkspaceSnapshot({
      revision: 14,
      primaryProjectRoot: '/repo/primary',
      primaryProjectName: 'Primary',
      panes: [],
      covenSessionsByProject: new Map([
        [linkedWorktree, [
          session({
            id: 'linked-session',
            projectRoot: linkedWorktree,
            cwd: `${linkedWorktree}/packages/app`,
          }),
        ]],
      ]),
      readWorktrees: (projectRoot) => {
        readRoots.push(projectRoot);
        if (projectRoot === '/repo/primary') {
          return [worktree('/repo/primary', { isMain: true, branch: 'main' })];
        }
        if (projectRoot === linkedWorktree) {
          return [
            worktree(mainRoot, { isMain: true, branch: 'main' }),
            worktree(linkedWorktree, { branch: 'feature' }),
          ];
        }
        throw new Error(`redundant worktree scan: ${projectRoot}`);
      },
    });

    expect(snapshot.projects.map((candidate) => candidate.root)).toEqual([
      '/repo/primary',
      mainRoot,
    ]);
    expect(snapshot.projects.some((candidate) => candidate.root === linkedWorktree)).toBe(false);
    expect(project(snapshot, mainRoot).worktrees).toEqual([
      expect.objectContaining({
        path: mainRoot,
        isMain: true,
      }),
      expect.objectContaining({
        path: linkedWorktree,
        isMain: false,
        panes: [expect.objectContaining({ id: 'linked-session' })],
      }),
    ]);
    expect(readRoots).toEqual(['/repo/primary', linkedWorktree]);
  });

  it('uses the most-specific published worktree owner for Coven sessions', () => {
    const snapshot = buildTuiWorkspaceSnapshot({
      revision: 14,
      primaryProjectRoot: '/repo/primary',
      primaryProjectName: 'Primary',
      sidebarProjects: [
        { projectRoot: '/external/shared/nested', projectName: 'Nested' },
      ],
      panes: [],
      covenSessionsByProject: new Map([
        ['/external/shared', [
          session({
            id: 'nested-session',
            projectRoot: '/external/shared',
            cwd: '/external/shared/nested/packages/app',
          }),
        ]],
      ]),
      worktreesByProjectRoot: new Map([
        ['/repo/primary', [
          worktree('/repo/primary', { isMain: true, branch: 'main' }),
          worktree('/external/shared', { branch: 'shared' }),
        ]],
        ['/external/shared/nested', [
          worktree('/external/shared/nested', { isMain: true, branch: 'main' }),
        ]],
      ]),
      readWorktrees: () => [],
    });

    expect(project(snapshot, '/repo/primary').worktrees[1].panes).toEqual([]);
    expect(project(snapshot, '/external/shared/nested').worktrees[0].panes)
      .toContainEqual(expect.objectContaining({ id: 'nested-session', kind: 'coven-session' }));
  });

  it('uses provider worktree discovery for ownership without rescanning owned worktrees', async () => {
    const externalWorktree = '/external/primary-review';
    const loadedRoots: string[] = [];
    const provider = createTuiWorkspaceProvider({
      primaryProjectRoot: '/repo/primary',
      primaryProjectName: 'Primary',
      panes: () => [],
      covenSessionsByProject: () => new Map([
        [externalWorktree, [
          session({
            id: 'external-session',
            projectRoot: externalWorktree,
            cwd: `${externalWorktree}/packages/app`,
          }),
        ]],
        ['/repo/coven-only', [
          session({
            id: 'coven-only-session',
            projectRoot: '/repo/coven-only',
          }),
        ]],
      ]),
      loadWorktrees: async (projectRoot) => {
        loadedRoots.push(projectRoot);
        if (projectRoot === '/repo/primary') {
          return [
            worktree('/repo/primary', { isMain: true, branch: 'main' }),
            worktree(externalWorktree, { branch: 'review' }),
          ];
        }
        return [];
      },
    });

    const snapshot = await provider();

    expect(snapshot.projects.map((candidate) => candidate.root)).toEqual([
      '/repo/primary',
      '/repo/coven-only',
    ]);
    expect(project(snapshot, '/repo/primary').worktrees[1].panes)
      .toContainEqual(expect.objectContaining({ id: 'external-session', kind: 'coven-session' }));
    expect(project(snapshot, '/repo/coven-only').projectPanes)
      .toContainEqual(expect.objectContaining({ id: 'coven-only-session', kind: 'coven-session' }));
    expect(loadedRoots).toEqual(['/repo/primary', '/repo/coven-only']);
  });

  it('canonicalizes provider-discovered Coven-only worktree aliases', async () => {
    const mainRoot = '/repo/coven-only';
    const childWorktree = `${mainRoot}/.psyche/worktrees/feature`;
    const externalWorktree = '/external/coven-only-review';
    const loadedRoots: string[] = [];
    const covenWorktrees = [
      worktree(mainRoot, { isMain: true, branch: 'main' }),
      worktree(childWorktree, { branch: 'feature' }),
      worktree(externalWorktree, { branch: 'review' }),
    ];
    const provider = createTuiWorkspaceProvider({
      primaryProjectRoot: '/repo/primary',
      primaryProjectName: 'Primary',
      panes: () => [],
      covenSessionsByProject: () => new Map([
        [externalWorktree, [
          session({
            id: 'external-session',
            projectRoot: externalWorktree,
            cwd: `${externalWorktree}/packages/app`,
          }),
        ]],
        [mainRoot, [
          session({
            id: 'main-session',
            projectRoot: mainRoot,
            cwd: `${mainRoot}/packages/app`,
          }),
        ]],
        [childWorktree, [
          session({
            id: 'child-session',
            projectRoot: childWorktree,
            cwd: `${childWorktree}/packages/app`,
          }),
        ]],
      ]),
      loadWorktrees: async (projectRoot) => {
        loadedRoots.push(projectRoot);
        if (projectRoot === '/repo/primary') {
          return [worktree('/repo/primary', { isMain: true, branch: 'main' })];
        }
        return covenWorktrees;
      },
    });

    const snapshot = await provider();

    expect(snapshot.projects.map((candidate) => candidate.root)).toEqual([
      '/repo/primary',
      mainRoot,
    ]);
    const covenOnly = project(snapshot, mainRoot);
    expect(covenOnly.worktrees.find((candidate) => candidate.path === mainRoot)?.panes)
      .toContainEqual(expect.objectContaining({ id: 'main-session' }));
    expect(covenOnly.worktrees.find((candidate) => candidate.path === childWorktree)?.panes)
      .toContainEqual(expect.objectContaining({ id: 'child-session' }));
    expect(covenOnly.worktrees.find((candidate) => candidate.path === externalWorktree)?.panes)
      .toContainEqual(expect.objectContaining({ id: 'external-session' }));
    expect(loadedRoots[0]).toBe('/repo/primary');
    expect(loadedRoots.slice(1)).toEqual(expect.arrayContaining([
      mainRoot,
      externalWorktree,
    ]));
    expect(loadedRoots).toHaveLength(3);
  });

  it('starts unrelated missing-root discovery concurrently', async () => {
    const missingRoots = ['/repo/slow-a', '/repo/slow-b'];
    const startedRoots: string[] = [];
    const completedRoots: string[] = [];
    const releaseSlowLoads: Array<() => void> = [];
    const slowLoadGates = missingRoots.map(() => new Promise<void>((resolve) => {
      releaseSlowLoads.push(resolve);
    }));
    let markBothStarted = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const provider = createTuiWorkspaceProvider({
      primaryProjectRoot: '/repo/primary',
      primaryProjectName: 'Primary',
      panes: () => [],
      covenSessionsByProject: () => new Map(missingRoots.map((projectRoot, index) => [
        projectRoot,
        [session({
          id: `slow-session-${index}`,
          projectRoot,
        })],
      ])),
      loadWorktrees: async (projectRoot) => {
        if (projectRoot === '/repo/primary') {
          return [worktree(projectRoot, { isMain: true, branch: 'main' })];
        }
        startedRoots.push(projectRoot);
        if (startedRoots.length === missingRoots.length) markBothStarted();
        await slowLoadGates[missingRoots.indexOf(projectRoot)];
        completedRoots.push(projectRoot);
        return [worktree(projectRoot, { isMain: true, branch: 'main' })];
      },
    });

    const pendingSnapshot = provider();
    const startedConcurrently = await Promise.race([
      bothStarted.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    releaseSlowLoads[1]();
    releaseSlowLoads[0]();
    const snapshot = await pendingSnapshot;

    expect(startedConcurrently).toBe(true);
    expect(startedRoots).toEqual(missingRoots);
    expect(completedRoots).toEqual([...missingRoots].reverse());
    expect(snapshot.projects.map((candidate) => candidate.root)).toEqual([
      '/repo/primary',
      ...missingRoots,
    ]);
  });

  it('never exceeds the missing-root discovery concurrency bound', async () => {
    const missingRoots = Array.from(
      { length: 8 },
      (_, index) => `/repo/slow-${index}`,
    );
    let activeLoads = 0;
    let maxActiveLoads = 0;
    const provider = createTuiWorkspaceProvider({
      primaryProjectRoot: '/repo/primary',
      primaryProjectName: 'Primary',
      panes: () => [],
      covenSessionsByProject: () => new Map(missingRoots.map((projectRoot, index) => [
        projectRoot,
        [session({
          id: `slow-session-${index}`,
          projectRoot,
        })],
      ])),
      loadWorktrees: async (projectRoot) => {
        if (projectRoot === '/repo/primary') {
          return [worktree(projectRoot, { isMain: true, branch: 'main' })];
        }
        activeLoads += 1;
        maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        activeLoads -= 1;
        return [worktree(projectRoot, { isMain: true, branch: 'main' })];
      },
    });

    await provider();

    expect(maxActiveLoads).toBe(2);
  });

  it('bounds provider discovery fan-out across aliases while loading unrelated roots', async () => {
    const mainRoot = '/repo/coven-only';
    const aliasRoots = [
      mainRoot,
      ...Array.from(
        { length: 8 },
        (_, index) => `${mainRoot}/.psyche/worktrees/feature-${index}`,
      ),
      '/external/coven-only-review',
    ];
    const unrelatedRoots = ['/repo/other-a', '/repo/other-b'];
    const loadedRoots: string[] = [];
    const provider = createTuiWorkspaceProvider({
      primaryProjectRoot: '/repo/primary',
      primaryProjectName: 'Primary',
      sidebarProjects: () => [
        { projectRoot: '/repo/sidebar', projectName: 'Sidebar' },
      ],
      panes: () => [],
      covenSessionsByProject: () => new Map([
        ...aliasRoots.map((projectRoot, index) => [
          projectRoot,
          [session({
            id: `alias-session-${index}`,
            projectRoot,
            cwd: `${projectRoot}/packages/app`,
          })],
        ] as const),
        ...unrelatedRoots.map((projectRoot, index) => [
          projectRoot,
          [session({
            id: `unrelated-session-${index}`,
            projectRoot,
          })],
        ] as const),
      ]),
      loadWorktrees: async (projectRoot) => {
        loadedRoots.push(projectRoot);
        if (projectRoot === '/repo/primary' || projectRoot === '/repo/sidebar') {
          return [worktree(projectRoot, { isMain: true, branch: 'main' })];
        }
        if (aliasRoots.includes(projectRoot)) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          return [
            worktree(mainRoot, { isMain: true, branch: 'main' }),
            ...aliasRoots.slice(1).map((worktreeRoot) => worktree(worktreeRoot, {
              branch: 'feature',
            })),
            worktree('/external/coven-only-review', {
              branch: 'review',
              locked: true,
              lockReason: 'manual review',
            }),
            worktree('/external/coven-only-review', {
              branch: 'review',
              bare: true,
              dirty: true,
              missing: true,
            }),
          ];
        }
        if (unrelatedRoots.includes(projectRoot)) {
          return [worktree(projectRoot, { isMain: true, branch: 'main' })];
        }
        throw new Error(`unexpected worktree scan: ${projectRoot}`);
      },
      worktreeCacheTtlMs: 1_000,
    });

    const first = await provider();
    const repeated = await provider();

    expect(repeated).toBe(first);
    expect(first.projects.map((candidate) => candidate.root)).toEqual([
      '/repo/primary',
      '/repo/sidebar',
      mainRoot,
      ...unrelatedRoots,
    ]);
    const aliasLoads = loadedRoots.filter((projectRoot) => aliasRoots.includes(projectRoot));
    expect(aliasLoads.length).toBeGreaterThan(0);
    expect(aliasLoads.length).toBeLessThanOrEqual(2);
    expect(loadedRoots).toEqual(expect.arrayContaining([
      '/repo/primary',
      '/repo/sidebar',
      ...unrelatedRoots,
    ]));
    expect(loadedRoots).toHaveLength(4 + aliasLoads.length);
    expect(project(first, mainRoot).worktrees.find(
      (candidate) => candidate.path === '/external/coven-only-review',
    )).toMatchObject({
      bare: true,
      locked: true,
      lockReason: 'manual review',
      dirty: true,
      missing: true,
    });
  });

  it('keeps undiscoverable Coven-only roots standalone and recoverable', async () => {
    const readErrors: Array<{ projectRoot: string; error: unknown }> = [];
    const provider = createTuiWorkspaceProvider({
      primaryProjectRoot: '/repo/primary',
      primaryProjectName: 'Primary',
      panes: () => [],
      covenSessionsByProject: () => new Map([
        ['/outside/standalone', [
          session({
            id: 'standalone-session',
            projectRoot: '/outside/standalone',
          }),
        ]],
      ]),
      loadWorktrees: async (projectRoot) => {
        if (projectRoot === '/outside/standalone') {
          throw new Error('not a Git worktree');
        }
        return [worktree('/repo/primary', { isMain: true, branch: 'main' })];
      },
      onWorktreeReadError: (projectRoot, error) => {
        readErrors.push({ projectRoot, error });
      },
    });

    const snapshot = await provider();

    expect(snapshot.projects.map((candidate) => candidate.root)).toEqual([
      '/repo/primary',
      '/outside/standalone',
    ]);
    expect(project(snapshot, '/outside/standalone')).toMatchObject({
      worktrees: [],
      projectPanes: [expect.objectContaining({
        id: 'standalone-session',
        kind: 'coven-session',
        recoverability: 'missing-worktree',
      })],
    });
    expect(readErrors).toEqual([{
      projectRoot: '/outside/standalone',
      error: expect.objectContaining({ message: 'not a Git worktree' }),
    }]);
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
