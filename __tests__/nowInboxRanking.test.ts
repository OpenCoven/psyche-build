import { describe, expect, it } from 'vitest';

import { WORKSPACE_SNAPSHOT_FIXTURE } from '../protocol-fixtures/fixtures.js';
import {
  MAX_PANES_PER_CONTAINER,
  MAX_WORKSPACE_PANES_TOTAL,
  MAX_WORKSPACE_PROJECTS,
  MAX_WORKTREES_PER_PROJECT,
  NOW_INBOX_ENTRY_LIMIT,
  NOW_INBOX_RANKING_VERSION,
  nowInboxBucketOf,
  projectNowInboxEntries,
  rankNowInbox,
  validateWorkspaceSnapshot,
  WORKSPACE_STRING_LIMITS,
} from '../src/mobile/nowInboxRanking.js';
import type {
  PaneSnapshot,
  ProjectSnapshot,
  WorktreeSnapshot,
  WorkspaceSnapshot,
} from '../src/workspace/snapshot.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function pane(overrides: Partial<PaneSnapshot> = {}): PaneSnapshot {
  return {
    id: '%1',
    cwd: '/repo',
    title: 'implementation',
    kind: 'terminal',
    agent: undefined,
    status: 'exited',
    needsAttention: false,
    lastActivity: undefined,
    recoverability: 'healthy',
    ...overrides,
  };
}

function worktree(overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    path: '/repo',
    head: '0123456789abcdef0123456789abcdef01234567',
    branch: 'main',
    isMain: true,
    detached: false,
    bare: false,
    locked: false,
    lockReason: undefined,
    prunable: false,
    pruneReason: undefined,
    dirty: false,
    missing: false,
    panes: [],
    runningCount: 0,
    attentionCount: 0,
    ...overrides,
  };
}

function project(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    id: 'project-1',
    root: '/repo',
    title: 'psyche-build',
    worktrees: [],
    projectPanes: [],
    runningCount: 0,
    attentionCount: 0,
    ...overrides,
  };
}

function snapshotOf(projects: readonly ProjectSnapshot[]): WorkspaceSnapshot {
  return { revision: 7, projects: [...projects] };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function reversedClone(input: WorkspaceSnapshot): WorkspaceSnapshot {
  return {
    revision: input.revision,
    projects: [...input.projects].reverse().map((item) => ({
      ...item,
      worktrees: [...item.worktrees]
        .reverse()
        .map((worktreeItem) => ({
          ...worktreeItem,
          panes: [...worktreeItem.panes].reverse(),
        })),
      projectPanes: [...item.projectPanes].reverse(),
    })),
  };
}

function problemCodes(problems: readonly { code: string; path: string }[]): string[] {
  return problems.map((problem) => `${problem.code}@${problem.path}`);
}

// ---------------------------------------------------------------------------
// Bucket assignment
// ---------------------------------------------------------------------------

describe('nowInboxBucketOf', () => {
  it('ranks Needs You above Running regardless of status', () => {
    expect(nowInboxBucketOf({ status: 'running', needsAttention: true })).toBe('needs-you');
    expect(nowInboxBucketOf({ status: 'waiting', needsAttention: true })).toBe('needs-you');
  });

  it('ranks every host-running status as Running when nothing needs attention', () => {
    for (const status of ['starting', 'running', 'working', 'analyzing']) {
      expect(nowInboxBucketOf({ status })).toBe('running');
      expect(nowInboxBucketOf({ status, needsAttention: false })).toBe('running');
    }
  });

  it('ranks exited and unknown statuses as Recent', () => {
    expect(nowInboxBucketOf({ status: 'exited' })).toBe('recent');
    expect(nowInboxBucketOf({ status: 'waiting', needsAttention: false })).toBe('recent');
  });
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

describe('projectNowInboxEntries', () => {
  it('flattens panes across projects, worktrees, and project-level panes', () => {
    const input = snapshotOf([
      project({
        id: 'project-a',
        title: 'Alpha',
        worktrees: [
          worktree({
            path: '/a/main',
            branch: 'main',
            panes: [
              pane({ id: '%1', status: 'running', lastActivity: '2026-08-03T02:12:00.000Z' }),
            ],
          }),
        ],
        projectPanes: [
          pane({ id: '%9', kind: 'terminal', recoverability: 'missing-worktree' }),
        ],
      }),
    ]);

    const entries = projectNowInboxEntries(input);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      projectId: 'project-a',
      projectTitle: 'Alpha',
      worktreePath: '/a/main',
      worktreeBranch: 'main',
      paneId: '%1',
      bucket: 'running',
    });
    expect(entries[1]).toMatchObject({
      worktreePath: null,
      worktreeBranch: null,
      paneId: '%9',
      bucket: 'recent',
    });
    expect(new Set(entries.map((entry) => entry.entryId)).size).toBe(2);
  });

  it('defaults an absent title to an empty string and a bad timestamp to null', () => {
    const input = snapshotOf([
      project({
        worktrees: [
          worktree({
            panes: [pane({ title: undefined, lastActivity: 'not-a-timestamp' })],
          }),
        ],
      }),
    ]);
    expect(projectNowInboxEntries(input)[0]).toMatchObject({
      title: '',
      lastActivity: null,
      bucket: 'recent',
    });
  });
});

// ---------------------------------------------------------------------------
// Ranking order
// ---------------------------------------------------------------------------

describe('rankNowInbox ordering', () => {
  function mixedSnapshot(): WorkspaceSnapshot {
    return snapshotOf([
      project({
        id: 'beta',
        title: 'Beta',
        worktrees: [
          worktree({
            path: '/beta/feature',
            branch: 'feature',
            panes: [
              pane({
                id: '%10',
                kind: 'agent',
                status: 'running',
                lastActivity: '2026-08-03T01:00:00.000Z',
              }),
            ],
          }),
        ],
      }),
      project({
        id: 'alpha',
        title: 'Alpha',
        worktrees: [
          worktree({
            path: '/alpha/review',
            branch: 'review',
            panes: [
              pane({
                id: 'coven:review',
                kind: 'coven-session',
                status: 'waiting',
                needsAttention: true,
                lastActivity: '2026-08-03T02:17:18.000Z',
              }),
            ],
          }),
        ],
        projectPanes: [
          pane({
            id: '%9',
            title: 'orphaned pane',
            recoverability: 'missing-worktree',
            lastActivity: '2026-08-03T03:00:00.000Z',
          }),
        ],
      }),
      project({
        id: 'gamma',
        title: 'Gamma',
        worktrees: [
          worktree({
            path: '/gamma/main',
            panes: [pane({ id: '%3', status: 'exited', lastActivity: '2026-08-03T04:00:00.000Z' })],
          }),
        ],
      }),
    ]);
  }

  it('orders Needs You, then Running, then Recent across projects', () => {
    const ranking = rankNowInbox(mixedSnapshot());
    expect(ranking.version).toBe(NOW_INBOX_RANKING_VERSION);
    expect(ranking.snapshotRevision).toBe(7);
    expect(ranking.entries.map((entry) => entry.entryId)).toEqual([
      'alpha\u001f/alpha/review\u001fcoven:review',
      'beta\u001f/beta/feature\u001f%10',
      'gamma\u001f/gamma/main\u001f%3',
      'alpha\u001f\u001f%9',
    ]);
    expect(ranking.entries.map((entry) => entry.bucket)).toEqual([
      'needs-you',
      'running',
      'recent',
      'recent',
    ]);
    expect(ranking.bucketCounts).toEqual({ 'needs-you': 1, running: 1, recent: 2 });
    expect(ranking.totalPaneCount).toBe(4);
    expect(ranking.truncated).toBe(false);
  });

  it('orders recency descending within a bucket with unknown timestamps last', () => {
    const input = snapshotOf([
      project({
        worktrees: [
          worktree({ path: '/p/w1', panes: [pane({ id: '%1', status: 'exited' })] }),
          worktree({
            path: '/p/w2',
            panes: [pane({ id: '%2', status: 'exited', lastActivity: '2026-08-03T01:00:00.000Z' })],
          }),
          worktree({
            path: '/p/w3',
            panes: [pane({ id: '%3', status: 'exited', lastActivity: '2026-08-03T05:00:00.000Z' })],
          }),
        ],
      }),
    ]);
    expect(rankNowInbox(input).entries.map((entry) => entry.paneId)).toEqual(['%3', '%2', '%1']);
  });

  it('breaks full ties by project id, then worktree path, then pane id', () => {
    const at = '2026-08-03T02:00:00.000Z';
    const input = snapshotOf([
      project({
        id: 'zeta',
        worktrees: [worktree({ path: '/z/w1', panes: [pane({ id: '%2', lastActivity: at })] })],
      }),
      project({
        id: 'alpha',
        worktrees: [
          worktree({ path: '/a/w10', panes: [pane({ id: '%1', lastActivity: at })] }),
          worktree({ path: '/a/w2', panes: [pane({ id: '%9', lastActivity: at })] }),
        ],
        projectPanes: [pane({ id: '%0', lastActivity: at })],
      }),
    ]);
    const ranking = rankNowInbox(input);
    expect(ranking.entries.map((entry) => entry.entryId)).toEqual([
      'alpha\u001f\u001f%0',
      'alpha\u001f/a/w10\u001f%1',
      'alpha\u001f/a/w2\u001f%9',
      'zeta\u001f/z/w1\u001f%2',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('rankNowInbox determinism', () => {
  it('returns deep-equal rankings for equal input regardless of array order', () => {
    const at = (minutes: number) => `2026-08-03T02:${String(minutes).padStart(2, '0')}:00.000Z`;
    const input = snapshotOf([
      project({
        id: 'project-b',
        title: 'Beta',
        worktrees: [
          worktree({
            path: '/b/w1',
            panes: [
              pane({ id: '%1', status: 'running', lastActivity: at(5) }),
              pane({ id: '%2', status: 'waiting', needsAttention: true, lastActivity: at(1) }),
            ],
          }),
          worktree({
            path: '/b/w2',
            panes: [pane({ id: '%3', lastActivity: at(9) })],
          }),
        ],
        projectPanes: [pane({ id: '%4' })],
      }),
      project({
        id: 'project-a',
        title: 'A',
        worktrees: [
          worktree({
            path: '/a/w1',
            panes: [pane({ id: '%5', status: 'running', lastActivity: at(3) })],
          }),
        ],
      }),
    ]);

    const first = rankNowInbox(input);
    const second = rankNowInbox(input);
    const reordered = rankNowInbox(reversedClone(input));

    expect(first).toEqual(second);
    expect(first).toEqual(reordered);
  });

  it('does not mutate or require mutability of the input snapshot', () => {
    const input = deepFreeze(
      snapshotOf([
        project({
          worktrees: [worktree({ panes: [pane({ id: '%1', status: 'running' })] })],
        }),
      ]),
    ) as WorkspaceSnapshot;
    expect(() => rankNowInbox(input)).not.toThrow();
    expect(rankNowInbox(input).entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

function snapshotWithPanes(total: number): WorkspaceSnapshot {
  const projects: ProjectSnapshot[] = [];
  let remaining = total;
  while (remaining > 0) {
    const take = Math.min(remaining, 100);
    const projectIndex = projects.length;
    projects.push(
      project({
        id: `project-${projectIndex}`,
        worktrees: [
          worktree({
            path: `/project-${projectIndex}/w`,
            panes: Array.from({ length: take }, (_value, paneIndex) =>
              pane({ id: `%${paneIndex}` })),
          }),
        ],
      }),
    );
    remaining -= take;
  }
  return { revision: 1, projects };
}

describe('rankNowInbox bounds', () => {
  it('truncates to the default limit and keeps pre-truncation totals observable', () => {
    const input = snapshotWithPanes(NOW_INBOX_ENTRY_LIMIT + 40);
    const ranking = rankNowInbox(input);
    expect(ranking.entries).toHaveLength(NOW_INBOX_ENTRY_LIMIT);
    expect(ranking.totalPaneCount).toBe(NOW_INBOX_ENTRY_LIMIT + 40);
    expect(ranking.truncated).toBe(true);
    const bucketTotal = Object.values(ranking.bucketCounts).reduce((sum, count) => sum + count, 0);
    expect(bucketTotal).toBe(NOW_INBOX_ENTRY_LIMIT + 40);
  });

  it('clamps an oversized explicit limit to NOW_INBOX_ENTRY_LIMIT', () => {
    const ranking = rankNowInbox(snapshotWithPanes(300), { limit: 10_000 });
    expect(ranking.entries).toHaveLength(NOW_INBOX_ENTRY_LIMIT);
    expect(ranking.truncated).toBe(true);
  });

  it('honors small and zero limits while keeping totals', () => {
    const input = snapshotWithPanes(10);
    expect(rankNowInbox(input, { limit: 3 }).entries).toHaveLength(3);
    const empty = rankNowInbox(input, { limit: 0 });
    expect(empty.entries).toEqual([]);
    expect(empty.truncated).toBe(true);
    expect(empty.totalPaneCount).toBe(10);
    expect(empty.bucketCounts).toEqual({ 'needs-you': 0, running: 0, recent: 10 });
  });

  it('rejects malformed limits instead of coercing them', () => {
    const input = snapshotWithPanes(1);
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5']) {
      expect(() => rankNowInbox(input, { limit: invalid as number })).toThrow(TypeError);
    }
  });
});

// ---------------------------------------------------------------------------
// Strict validation
// ---------------------------------------------------------------------------

function fixtureSnapshot(): Record<string, unknown> {
  return structuredClone(WORKSPACE_SNAPSHOT_FIXTURE.workspace) as unknown as Record<
    string,
    unknown
  >;
}

describe('validateWorkspaceSnapshot', () => {
  it('accepts a minimal snapshot and the canonical protocol fixture', () => {
    expect(validateWorkspaceSnapshot({ revision: 0, projects: [] })).toEqual([]);
    expect(validateWorkspaceSnapshot(WORKSPACE_SNAPSHOT_FIXTURE.workspace)).toEqual([]);
  });

  it('accepts known optional fields that are explicitly undefined', () => {
    const input = snapshotOf([
      project({
        worktrees: [
          worktree({
            lockReason: undefined,
            pruneReason: undefined,
            panes: [
              pane({ agent: undefined, needsAttention: undefined, lastActivity: undefined }),
            ],
          }),
        ],
      }),
    ]);
    expect(validateWorkspaceSnapshot(input)).toEqual([]);
  });

  it('rejects non-object input', () => {
    for (const invalid of [null, undefined, 42, 'snapshot', [], true]) {
      const problems = validateWorkspaceSnapshot(invalid);
      expect(problems).toHaveLength(1);
      expect(problems[0].code).toBe('invalid-snapshot');
    }
  });

  it('rejects unknown fields at every level, even when their value is undefined', () => {
    const rootLevel = fixtureSnapshot();
    rootLevel.extra = undefined;
    expect(problemCodes(validateWorkspaceSnapshot(rootLevel))).toContain('unknown-field@');

    const projectLevel = fixtureSnapshot();
    (projectLevel.projects as Record<string, unknown>[])[0].sneaky = 'value';
    expect(problemCodes(validateWorkspaceSnapshot(projectLevel))).toContain(
      'unknown-field@projects[0]',
    );

    const paneLevel = fixtureSnapshot();
    (paneLevel.projects as Record<string, unknown>[])[0].worktrees = [
      {
        ...((WORKSPACE_SNAPSHOT_FIXTURE.workspace.projects[0].worktrees[0] ?? {}) as object),
        panes: [
          {
            ...WORKSPACE_SNAPSHOT_FIXTURE.workspace.projects[0].worktrees[0].panes[0],
            hostile: true,
          },
        ],
      },
    ];
    expect(problemCodes(validateWorkspaceSnapshot(paneLevel))).toContain(
      'unknown-field@projects[0].worktrees[0].panes[0]',
    );
  });

  it('rejects missing required fields with a precise locator', () => {
    expect(problemCodes(validateWorkspaceSnapshot({ projects: [] }))).toEqual([
      'missing-field@revision',
    ]);

    const missingPaneStatus = {
      revision: 1,
      projects: [
        project({
          worktrees: [
            worktree({ panes: [{ id: '%1', cwd: '/repo', kind: 'terminal' } as unknown as PaneSnapshot] }),
          ],
        }),
      ],
    };
    expect(problemCodes(validateWorkspaceSnapshot(missingPaneStatus))).toContain(
      'missing-field@projects[0].worktrees[0].panes[0].status',
    );
  });

  it('rejects wrong types, invalid enums, and non-canonical timestamps', () => {
    const input = {
      revision: -1,
      projects: [
        project({
          id: 7 as unknown as string,
          runningCount: 'many' as unknown as number,
          worktrees: [
            worktree({
              isMain: 'yes' as unknown as boolean,
              panes: [
                pane({
                  status: 42 as unknown as string,
                  kind: 'shell' as unknown as PaneSnapshot['kind'],
                  recoverability: 'unknown' as unknown as PaneSnapshot['recoverability'],
                  needsAttention: 'yes' as unknown as boolean,
                  lastActivity: '2026-08-03 02:12:00',
                }),
              ],
            }),
          ],
        }),
      ],
    };
    expect(problemCodes(validateWorkspaceSnapshot(input))).toEqual([
      'invalid-field@revision',
      'invalid-field@projects[0].id',
      'invalid-field@projects[0].runningCount',
      'invalid-field@projects[0].worktrees[0].isMain',
      'invalid-field@projects[0].worktrees[0].panes[0].status',
      'invalid-field@projects[0].worktrees[0].panes[0].kind',
      'invalid-field@projects[0].worktrees[0].panes[0].recoverability',
      'invalid-field@projects[0].worktrees[0].panes[0].needsAttention',
      'invalid-field@projects[0].worktrees[0].panes[0].lastActivity',
    ]);
  });

  it('rejects offset (non-Z-form) ISO timestamps', () => {
    const input = snapshotOf([
      project({
        worktrees: [
          worktree({ panes: [pane({ lastActivity: '2026-08-03T02:12:00+02:00' })] }),
        ],
      }),
    ]);
    expect(problemCodes(validateWorkspaceSnapshot(input))).toEqual([
      'invalid-field@projects[0].worktrees[0].panes[0].lastActivity',
    ]);
  });

  it('rejects oversized arrays with one bounds problem and no enumeration', () => {
    const tooManyProjects = {
      revision: 1,
      projects: Array.from({ length: MAX_WORKSPACE_PROJECTS + 1 }, () => project()),
    };
    expect(problemCodes(validateWorkspaceSnapshot(tooManyProjects))).toEqual([
      'exceeds-bound@projects',
    ]);

    const tooManyWorktrees = snapshotOf([
      project({
        worktrees: Array.from({ length: MAX_WORKTREES_PER_PROJECT + 1 }, (_value, index) =>
          worktree({ path: `/w${index}` })),
      }),
    ]);
    expect(problemCodes(validateWorkspaceSnapshot(tooManyWorktrees))).toEqual([
      'exceeds-bound@projects[0].worktrees',
    ]);

    const tooManyPanes = snapshotOf([
      project({
        worktrees: [
          worktree({
            panes: Array.from({ length: MAX_PANES_PER_CONTAINER + 1 }, (_value, index) =>
              pane({ id: `%${index}` })),
          }),
        ],
      }),
    ]);
    expect(problemCodes(validateWorkspaceSnapshot(tooManyPanes))).toEqual([
      'exceeds-bound@projects[0].worktrees[0].panes',
    ]);
  });

  it('rejects a total pane count above the workspace bound', () => {
    const perProject = 65;
    const input = {
      revision: 1,
      projects: Array.from(
        { length: Math.ceil((MAX_WORKSPACE_PANES_TOTAL + 1) / perProject) },
        (_value, projectIndex) =>
          project({
            id: `project-${projectIndex}`,
            projectPanes: Array.from({ length: perProject }, (_paneValue, paneIndex) =>
              pane({ id: `%${projectIndex}.${paneIndex}` })),
          }),
      ),
    };
    const problems = validateWorkspaceSnapshot(input);
    expect(problems).toHaveLength(1);
    expect(problems[0].code).toBe('exceeds-bound');
  });

  it('rejects oversized strings with exact locators', () => {
    const input = snapshotOf([
      project({
        id: 'x'.repeat(WORKSPACE_STRING_LIMITS.id + 1),
        worktrees: [
          worktree({
            panes: [pane({ status: 'x'.repeat(WORKSPACE_STRING_LIMITS.status + 1) })],
          }),
        ],
      }),
    ]);
    expect(problemCodes(validateWorkspaceSnapshot(input))).toContain('exceeds-bound@projects[0].id');
    expect(problemCodes(validateWorkspaceSnapshot(input))).toContain(
      'exceeds-bound@projects[0].worktrees[0].panes[0].status',
    );
  });

  it('accepts a valid mixed snapshot across containers', () => {
    const valid = snapshotOf([
      project({
        worktrees: [
          worktree({
            panes: [
              pane({
                id: '%3',
                kind: 'agent',
                agent: 'coven-code',
                status: 'running',
                needsAttention: false,
                lastActivity: '2026-08-03T02:12:00.000Z',
              }),
            ],
            runningCount: 1,
          }),
        ],
        projectPanes: [
          pane({ id: '%9', recoverability: 'missing-worktree' }),
        ],
      }),
    ]);
    expect(validateWorkspaceSnapshot(valid)).toEqual([]);
  });
});
