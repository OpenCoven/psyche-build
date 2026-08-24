import { describe, expect, it, vi } from 'vitest';

import {
  createGhClient as createGhClientImplementation,
  PROJECT_VIEWS,
} from '../scripts/beads-project-sync/github.mjs';
import type {
  GhRun,
  GhRunOptions,
  GhRunResult,
  ManagedIssueSnapshot,
} from '../scripts/beads-project-sync/github.mjs';
import {
  applyReconciliation,
  planReconciliation,
} from '../scripts/beads-project-sync/reconcile.mjs';
import type {
  ReconciliationAdapters,
  ReconciliationPlan,
} from '../scripts/beads-project-sync/reconcile.mjs';
import type { PublicBead } from '../scripts/beads-project-sync/sanitize.mjs';

const owner = 'OpenCoven';
const repo = 'psyche-build';
const projectNodeId = 'PVT_kwDOECXnmc4BhMIA';
const repositoryIdentity = `${owner}/${repo}`;
const repositoryUrl = `https://api.github.com/repos/${repositoryIdentity}`;
const boundProjectReadmeMarker =
  '<!-- psyche-beads-project-sync:v1 project-readme repository=OpenCoven/psyche-build -->';
const token = 'github_pat_DO_NOT_LEAK';
const apiHeaders = [
  '-H',
  'Accept: application/vnd.github+json',
  '-H',
  'X-GitHub-Api-Version: 2026-03-10',
  '--include',
];

type TestGhClientOptions = Omit<
  Parameters<typeof createGhClientImplementation>[0],
  'mutationMode' | 'trustedIssueAuthors'
> & {
  mutationMode?: 'lease-required' | 'trusted-setup';
  trustedIssueAuthors?: readonly string[];
};

function createGhClient(options: TestGhClientOptions) {
  return createGhClientImplementation({
    ...options,
    trustedIssueAuthors: options.trustedIssueAuthors ?? ['BunsDev'],
    mutationMode: options.mutationMode ?? 'trusted-setup',
  });
}

interface RunCall {
  command: string;
  args: readonly string[];
  options: GhRunOptions;
}

interface ScheduledTimer {
  callback: () => void;
  milliseconds: number;
  cleared: boolean;
  unref: ReturnType<typeof vi.fn>;
}

function success(value: unknown = {}): GhRunResult {
  return {
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: '',
    exitCode: 0,
  };
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(`HTTP ${status} ${message}`), { status });
}

function createRunner(
  responses: readonly (GhRunResult | Error | ((call: RunCall) => GhRunResult | Promise<GhRunResult>))[],
): { calls: RunCall[]; run: GhRun } {
  const calls: RunCall[] = [];
  let index = 0;

  return {
    calls,
    async run(command, args, options) {
      const call = { command, args: [...args], options: { ...options } };
      calls.push(call);
      const response = responses[index++];
      if (response == null) {
        throw new Error(`Unexpected runner call ${command} ${args.join(' ')}`);
      }
      if (response instanceof Error) {
        throw response;
      }
      return typeof response === 'function' ? response(call) : response;
    },
  };
}

function parseStdin(call: RunCall): Record<string, unknown> {
  expect(call.options.stdin).toBeTypeOf('string');
  return JSON.parse(call.options.stdin ?? '') as Record<string, unknown>;
}

function createApplyLockBackend() {
  const calls: RunCall[] = [];
  const commits = new Map<string, Record<string, unknown>>([
    ['main', { sha: 'BASE', tree: { sha: 'TREE' }, message: 'base' }],
  ]);
  let lockSha: string | null = null;
  let nextCommit = 0;
  let nextCommitFailure: Error | null = null;
  let nextRefReadHook: (() => void) | null = null;
  let activeRefReads = 0;
  let maxConcurrentRefReads = 0;

  const run: GhRun = async (command, args, options) => {
    const call = { command, args: [...args], options: { ...options } };
    calls.push(call);
    const endpoint = args[1];
    const methodIndex = args.indexOf('--method');
    const method = methodIndex === -1 ? 'GET' : args[methodIndex + 1];

    if (endpoint === `repos/${owner}/${repo}/git/ref/tags/psyche-beads-project-sync-lock`) {
      if (lockSha == null) {
        throw httpError(404, 'not found');
      }
      activeRefReads += 1;
      maxConcurrentRefReads = Math.max(maxConcurrentRefReads, activeRefReads);
      try {
        const hook = nextRefReadHook;
        nextRefReadHook = null;
        hook?.();
        await Promise.resolve();
        return success({ object: { sha: lockSha } });
      } finally {
        activeRefReads -= 1;
      }
    }
    if (endpoint?.startsWith(`repos/${owner}/${repo}/git/commits/`) && method === 'GET') {
      const sha = endpoint.split('/').at(-1) ?? '';
      return success(commits.get(sha));
    }
    if (endpoint === `repos/${owner}/${repo}/git/commits` && method === 'POST') {
      if (nextCommitFailure) {
        const failure = nextCommitFailure;
        nextCommitFailure = null;
        throw failure;
      }
      const body = parseStdin(call);
      const sha = `LOCK-${++nextCommit}`;
      commits.set(sha, { sha, ...body, tree: { sha: body.tree } });
      return success({ sha, tree: { sha: body.tree } });
    }
    if (endpoint === `repos/${owner}/${repo}/git/refs` && method === 'POST') {
      if (lockSha != null) {
        throw httpError(422, 'Reference already exists');
      }
      lockSha = String(parseStdin(call).sha);
      return success({ object: { sha: lockSha } });
    }
    if (
      endpoint === `repos/${owner}/${repo}/git/refs/tags/psyche-beads-project-sync-lock`
      && method === 'PATCH'
    ) {
      const nextSha = String(parseStdin(call).sha);
      const next = commits.get(nextSha);
      if (next?.parents == null || !Array.isArray(next.parents) || next.parents[0] !== lockSha) {
        throw httpError(422, 'Update is not a fast forward');
      }
      lockSha = nextSha;
      return success({ object: { sha: lockSha } });
    }
    throw new Error(`Unexpected runner call ${command} ${args.join(' ')}`);
  };

  return {
    calls,
    commits,
    run,
    currentSha() {
      return lockSha;
    },
    maxConcurrentRefReads() {
      return maxConcurrentRefReads;
    },
    currentState() {
      const message = String(commits.get(lockSha ?? '')?.message ?? '');
      return JSON.parse(message.replace(/^psyche-beads-project-lock:v1 /u, '')) as {
        state: string;
        owner: string;
        runId: string;
        leaseId: string;
        expiresAt: number;
      };
    },
    failNextCommit(error: Error) {
      nextCommitFailure = error;
    },
    onNextRefRead(callback: () => void) {
      nextRefReadHook = callback;
    },
    stealLock(state: {
      owner: string;
      runId: string;
      leaseId: string;
      acquiredAt: number;
      expiresAt: number;
    }) {
      const sha = `STOLEN-${++nextCommit}`;
      commits.set(sha, {
        sha,
        tree: { sha: 'TREE' },
        parents: lockSha == null ? [] : [lockSha],
        message: `psyche-beads-project-lock:v1 ${JSON.stringify({
          version: 1,
          state: 'acquired',
          ...state,
        })}`,
      });
      lockSha = sha;
    },
  };
}

function createTimerHarness() {
  const timers: ScheduledTimer[] = [];
  return {
    timers,
    setTimer(callback: () => void, milliseconds: number) {
      const timer: ScheduledTimer = {
        callback,
        milliseconds,
        cleared: false,
        unref: vi.fn(),
      };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer: unknown) {
      (timer as ScheduledTimer).cleared = true;
    },
  };
}

function managedBody(id: string, extra = ''): string {
  return [
    `<!-- psyche-bead-sync:v1 bead-id=${id} -->`,
    '## Bead',
    '- Type: `feature`',
    '- Status: `open`',
    '- Priority: P1',
    '- Blocked: no',
    extra,
  ].filter(Boolean).join('\n');
}

function trustedIssue<T extends Record<string, unknown>>(issue: T): T & {
  author_association: 'NONE';
  user: { login: 'BunsDev' };
} {
  return {
    ...issue,
    author_association: 'NONE',
    user: { login: 'BunsDev' },
  };
}

function projectDiscovery(projects: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return success({
    data: {
      organization: {
        id: 'ORG_node',
        projectsV2: {
          nodes: projects.map((rawProject) => {
            const project = rawProject as Record<string, unknown>;
            return {
              ...project,
              repositories: project.repositories ?? {
                nodes: [{ id: 'REPO_node' }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              items: project.items ?? { totalCount: 0 },
            };
          }),
          pageInfo: { hasNextPage, endCursor },
        },
      },
      repository: { id: 'REPO_node' },
    },
  });
}

function projectItemsPage(
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return success({
    data: {
      node: {
        items: {
          nodes,
          pageInfo: { hasNextPage, endCursor },
        },
      },
    },
  });
}

function linkedRepositoriesPage(
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return success({
    data: {
      node: {
        repositories: {
          nodes,
          pageInfo: { hasNextPage, endCursor },
        },
      },
    },
  });
}

describe('createGhClient', () => {
  it('allows managed issue snapshots to include a parent issue number', () => {
    const snapshot: ManagedIssueSnapshot = {
      beadId: 'pb-child',
      number: 2,
      title: 'Child',
      body: managedBody('pb-child'),
      state: 'open',
      assignees: [],
      labels: ['bead', 'bead:task', 'priority:P1'],
      renderHash: null,
      projectItem: null,
      parentIssueNumber: 1,
      blockerIssueNumbers: [],
      parentIssue: {
        id: 1,
        nodeId: 'issue-node-1',
        number: 1,
        repository: repositoryIdentity,
      },
      blockerIssues: [],
      repository: repositoryIdentity,
    };

    expect(snapshot.parentIssueNumber).toBe(1);
  });

  it('verifies gh authentication plus repository and organization access with safe argument arrays', async () => {
    const runner = createRunner([success(''), success({ id: 1 }), success({ id: 2 })]);
    const client = createGhClient({ run: runner.run, owner, repo, token });
    const adapters: ReconciliationAdapters = client;

    await expect(client.verifyAccess()).resolves.toEqual({
      organization: { id: 2 },
      repository: { id: 1 },
    });
    expect(adapters).toBe(client);

    expect(runner.calls).toEqual([
      {
        command: 'gh',
        args: ['auth', 'status', '--hostname', 'github.com', '--active'],
        options: { env: { GH_TOKEN: token } },
      },
      {
        command: 'gh',
        args: ['api', `repos/${owner}/${repo}`, '--method', 'GET', ...apiHeaders],
        options: { env: { GH_TOKEN: token } },
      },
      {
        command: 'gh',
        args: ['api', `orgs/${owner}`, '--method', 'GET', ...apiHeaders],
        options: { env: { GH_TOKEN: token } },
      },
    ]);
    expect(JSON.stringify(runner.calls.map((call) => call.args))).not.toContain(token);
  });

  it('paginates all repository issues including closed issues and parses managed markers', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => trustedIssue({
      number: index + 1,
      title: `Issue ${index + 1}`,
      body: managedBody(`pb-${index + 1}`),
      state: index === 0 ? 'closed' : 'open',
      assignees: index === 0 ? [{ login: 'zeta' }, { login: 'octocat' }] : [],
      html_url: `https://github.com/${owner}/${repo}/issues/${index + 1}`,
    }));
    const runner = createRunner([
      success(firstPage),
      success([
        {
          number: 101,
          title: 'Manual bead label',
          body: 'No management marker.',
          state: 'open',
        },
        trustedIssue({
          number: 102,
          title: 'Managed final issue',
          body: managedBody('pb-102'),
          state: 'open',
          assignees: [],
        }),
        {
          number: 103,
          title: 'Pull request with a copied marker',
          body: managedBody('pb-pr'),
          state: 'closed',
          pull_request: { url: `https://api.github.com/repos/${owner}/${repo}/pulls/103` },
        },
      ]),
      projectDiscovery([]),
      ...Array.from({ length: 101 }, () => [
        httpError(404, 'parent not found'),
        success([]),
      ]).flat(),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    const issues = await client.listManagedIssues();

    expect(issues).toHaveLength(101);
    expect(issues[0]).toMatchObject({
      beadId: 'pb-1',
      number: 1,
      state: 'closed',
      assignees: ['octocat', 'zeta'],
    });
    expect(issues.at(-1)).toMatchObject({ beadId: 'pb-102', number: 102 });
    expect(runner.calls.slice(0, 2).map((call) => call.args)).toEqual([
      [
        'api',
        `repos/${owner}/${repo}/issues?state=all&per_page=100&page=1`,
        '--method',
        'GET',
        ...apiHeaders,
      ],
      [
        'api',
        `repos/${owner}/${repo}/issues?state=all&per_page=100&page=2`,
        '--method',
        'GET',
        ...apiHeaders,
      ],
    ]);
    expect(parseStdin(runner.calls[2]!).query).toMatch(/query DiscoverManagedProject/u);
    expect(runner.calls).toHaveLength(205);
  });

  it('discovers a marked issue without the bead label and plans repair instead of a duplicate', async () => {
    const bead: PublicBead = {
      id: 'pb-label-drift',
      title: 'Repair label drift',
      description: 'Keep the existing managed issue.',
      design: null,
      specId: null,
      acceptanceCriteria: '- The issue is reused.',
      notes: null,
      status: 'open',
      priority: 0,
      type: 'task',
      blocked: false,
      labels: [],
      parentId: null,
      blockedByIds: [],
      githubAssignee: null,
      createdAt: '2026-08-20T00:00:00Z',
      updatedAt: '2026-08-20T00:00:00Z',
      closedAt: null,
    };
    const firstRun = planReconciliation({
      inventory: [bead],
      existingIssues: [],
      readme: null,
      renderContext: {
        repositoryIdentity,
        sourceRepositoryUrl: `https://github.com/${repositoryIdentity}`,
      },
    });
    const createOperation = firstRun.operations.find(
      (operation) => operation.type === 'createIssue',
    );
    expect(createOperation?.type).toBe('createIssue');

    const runner = createRunner([
      success([trustedIssue({
        number: 77,
        title: createOperation?.type === 'createIssue' ? createOperation.title : null,
        body: createOperation?.type === 'createIssue' ? createOperation.body : null,
        state: 'open',
        assignees: [],
        labels: [{ name: 'bead:task' }, { name: 'priority:P0' }],
      })]),
      projectDiscovery([]),
      httpError(404, 'parent not found'),
      success([]),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    const existingIssues = await client.listManagedIssues();
    const plan = planReconciliation({
      inventory: [bead],
      existingIssues,
      readme: null,
      renderContext: {
        repositoryIdentity,
        sourceRepositoryUrl: `https://github.com/${repositoryIdentity}`,
      },
    });

    expect(existingIssues).toEqual([
      expect.objectContaining({
        beadId: 'pb-label-drift',
        number: 77,
        labels: ['bead:task', 'priority:P0'],
      }),
    ]);
    expect(plan.summary.createIssueCount).toBe(0);
    expect(plan.summary.updateIssueCount).toBe(0);
    expect(plan.summary.labelIssueCount).toBe(1);
    expect(plan.operations).toContainEqual(expect.objectContaining({
      type: 'labelIssue',
      beadId: 'pb-label-drift',
      issueNumber: 77,
    }));
  });

  it('plans no mutations for a deferred bead loaded from Backlog on the second run', async () => {
    const bead: PublicBead = {
      id: 'pb-deferred',
      title: 'Defer the public mirror task',
      description: 'Keep deferred work in the Project backlog.',
      design: null,
      specId: null,
      acceptanceCriteria: '- Repeated syncs are idempotent.',
      notes: null,
      status: 'deferred',
      priority: 2,
      type: 'task',
      blocked: false,
      labels: [],
      parentId: null,
      blockedByIds: [],
      githubAssignee: null,
      createdAt: '2026-08-20T00:00:00Z',
      updatedAt: '2026-08-22T12:30:00Z',
      closedAt: null,
    };
    const renderContext = {
      repositoryIdentity,
      sourceRepositoryUrl: `https://github.com/${repositoryIdentity}`,
    };
    const firstRun = planReconciliation({
      inventory: [bead],
      existingIssues: [],
      readme: null,
      renderContext,
    });
    const createOperation = firstRun.operations.find(
      (operation) => operation.type === 'createIssue',
    );
    const readmeOperation = firstRun.operations.find(
      (operation) => operation.type === 'updateReadme',
    );
    expect(createOperation?.type).toBe('createIssue');
    expect(readmeOperation?.type).toBe('updateReadme');

    const issueUrl = `https://github.com/${repositoryIdentity}/issues/78`;
    const runner = createRunner([
      success([trustedIssue({
        node_id: 'ISSUE-deferred',
        number: 78,
        title: createOperation?.type === 'createIssue' ? createOperation.title : null,
        body: createOperation?.type === 'createIssue' ? createOperation.body : null,
        state: 'open',
        assignees: [],
        labels: [{ name: 'bead' }, { name: 'bead:task' }, { name: 'priority:P2' }],
        html_url: issueUrl,
      })]),
      projectDiscovery([{
        id: projectNodeId,
        number: 23,
        title: 'Public Beads',
        readme: boundProjectReadmeMarker,
        public: true,
      }]),
      projectItemsPage([{
        id: 'ITEM-deferred',
        isArchived: false,
        content: { id: 'ISSUE-deferred', url: issueUrl },
        fieldValues: {
          nodes: [
            { text: 'pb-deferred', field: { name: 'Bead ID' } },
            { name: 'Backlog', field: { name: 'Status' } },
            { name: 'P2', field: { name: 'Priority' } },
            { name: 'Task', field: { name: 'Bead Type' } },
            { date: '2026-08-22', field: { name: 'Source Updated' } },
          ],
        },
      }]),
      httpError(404, 'parent not found'),
      success([]),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });
    const existingIssues = await client.listManagedIssues();

    const secondRun = planReconciliation({
      inventory: [bead],
      existingIssues,
      readme: {
        body: readmeOperation?.type === 'updateReadme' ? readmeOperation.body : null,
      },
      renderContext,
    });

    expect(secondRun.operations).toEqual([]);
  });

  it('rejects duplicate markers in one issue and duplicate managed bead IDs across issues', async () => {
    const duplicateInBody = createRunner([
      success([trustedIssue({
        number: 5,
        body: `${managedBody('pb-5')}\n<!-- psyche-bead-sync:v1 bead-id=pb-shadow -->`,
        state: 'open',
        title: 'duplicate',
      })]),
    ]);
    await expect(
      createGhClient({ run: duplicateInBody.run, owner, repo, token }).listManagedIssues(),
    ).rejects.toThrow(/issue #5.*duplicate managed markers/i);

    const duplicateAcrossIssues = createRunner([
      success([
        trustedIssue({ number: 6, body: managedBody('pb-6'), state: 'open', title: 'first' }),
        trustedIssue({ number: 7, body: managedBody('pb-6'), state: 'open', title: 'second' }),
      ]),
    ]);
    await expect(
      createGhClient({ run: duplicateAcrossIssues.run, owner, repo, token }).listManagedIssues(),
    ).rejects.toThrow(/duplicate managed bead id.*pb-6/i);
  });

  it('uses the pinned author login instead of mutable author association', async () => {
    const runner = createRunner([
      success([
        {
          number: 20,
          title: 'Attacker collision',
          body: `${managedBody('pb-owned')}\n<!-- psyche-bead-sync:v1 bead-id=pb-shadow -->`,
          state: 'open',
          author_association: 'MEMBER',
          user: { login: 'public-attacker' },
        },
        trustedIssue({
          number: 21,
          title: 'Trusted owner marker',
          body: managedBody('pb-owned'),
          state: 'open',
        }),
      ]),
      projectDiscovery([]),
      httpError(404, 'parent not found'),
      success([]),
      httpError(404, 'parent not found'),
      success([]),
    ]);
    const client = createGhClient({
      run: runner.run,
      owner,
      repo,
      token,
      trustedIssueAuthors: ['bunsdev'],
    });

    await expect(client.listManagedIssues()).resolves.toEqual([
      expect.objectContaining({ beadId: 'pb-owned', number: 21 }),
    ]);
  });

  it('still rejects duplicate markers from the trusted author case-insensitively', async () => {
    const runner = createRunner([
      success([
        trustedIssue({
          number: 30,
          title: 'First trusted marker',
          body: managedBody('pb-duplicate'),
          state: 'open',
        }),
        {
          number: 31,
          title: 'Second trusted marker',
          body: managedBody('pb-duplicate'),
          state: 'open',
          author_association: 'COLLABORATOR',
          user: { login: 'bUnSdEv' },
        },
      ]),
    ]);

    await expect(
      createGhClient({ run: runner.run, owner, repo, token }).listManagedIssues(),
    ).rejects.toThrow(/duplicate managed bead id.*pb-duplicate/i);
  });

  it('discovers legacy issue markers when a new issue marker is configured', async () => {
    const runner = createRunner([
      success([trustedIssue({
        number: 8,
        title: '[pb-legacy] Legacy managed issue',
        body: managedBody('pb-legacy'),
        state: 'open',
        assignees: [],
      })]),
      projectDiscovery([]),
      httpError(404, 'parent not found'),
      success([]),
    ]);
    const client = createGhClient({
      run: runner.run,
      owner,
      repo,
      token,
      projectMarker: 'custom-project-sync:v2',
      issueMarker: 'custom-issue-sync:v2',
      legacyProjectMarkers: ['psyche-bead-sync:v1'],
      legacyIssueMarkers: ['psyche-bead-sync:v1'],
    });

    await expect(client.listManagedIssues()).resolves.toEqual([
      expect.objectContaining({
        beadId: 'pb-legacy',
        number: 8,
      }),
    ]);
  });

  it('loads paginated project items, custom fields, parents, and blockers from GitHub fixtures', async () => {
    const firstBody = [
      '<!-- psyche-bead-sync:v1 bead-id=pb-1 -->',
      '## Bead',
      '- Type: `feature`',
      '- Status: `in_progress`',
      '- Priority: P1',
      '- Blocked: yes',
    ].join('\n');
    const secondBody = [
      '<!-- psyche-bead-sync:v1 bead-id=pb-2 -->',
      '## Bead',
      '- Type: `task`',
      '- Status: `closed`',
      '- Priority: P2',
      '- Blocked: no',
    ].join('\n');
    const firstUrl = `https://github.com/${owner}/${repo}/issues/1`;
    const secondUrl = `https://github.com/${owner}/${repo}/issues/2`;
    const runner = createRunner([
      projectDiscovery([{
        id: projectNodeId,
        number: 16,
        title: 'Public Beads',
        readme: boundProjectReadmeMarker,
        public: true,
      }]),
      success([
        trustedIssue({
          node_id: 'ISSUE-node-1',
          number: 1,
          title: 'First',
          body: firstBody,
          state: 'open',
          assignees: [],
          html_url: firstUrl,
        }),
        trustedIssue({
          node_id: 'ISSUE-node-2',
          number: 2,
          title: 'Second',
          body: secondBody,
          state: 'closed',
          assignees: [],
          html_url: secondUrl,
        }),
      ]),
      projectItemsPage([{
        id: 'ITEM-1',
        isArchived: false,
        content: { id: 'ISSUE-node-1', url: firstUrl },
        fieldValues: {
          nodes: [
            { text: 'pb-1', field: { name: 'Bead ID' } },
            { name: 'Blocked', field: { name: 'Status' } },
            { name: 'P1', field: { name: 'Priority' } },
            { name: 'Feature', field: { name: 'Bead Type' } },
            { text: 'Launch', field: { name: 'Parent Goal' } },
            { date: '2026-08-22', field: { name: 'Source Updated' } },
          ],
        },
      }], true, 'ITEM-CURSOR'),
      projectItemsPage([{
        id: 'ITEM-2',
        isArchived: true,
        content: { id: 'different-node', url: secondUrl },
        fieldValues: {
          nodes: [
            { text: 'pb-2', field: { name: 'Bead ID' } },
            { name: 'Done', field: { name: 'Status' } },
            { name: 'P2', field: { name: 'Priority' } },
            { name: 'Task', field: { name: 'Bead Type' } },
          ],
        },
      }]),
      httpError(404, 'parent not found'),
      success([{
        id: 1002,
        node_id: 'ISSUE-node-2',
        number: 2,
        repository_url: repositoryUrl,
      }]),
      success({
        id: 1001,
        node_id: 'ISSUE-node-1',
        number: 1,
        repository_url: repositoryUrl,
      }),
      success([]),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });
    await client.discoverProject();

    await expect(client.listManagedIssues()).resolves.toEqual([
      expect.objectContaining({
        beadId: 'pb-1',
        projectItem: {
          id: 'ITEM-1',
          archived: false,
          fields: {
            beadId: 'pb-1',
            status: 'in_progress',
            blocked: true,
            done: false,
            priority: 1,
            type: 'feature',
            parentGoal: 'Launch',
            sourceUpdated: '2026-08-22',
          },
        },
        parentIssueNumber: null,
        blockerIssueNumbers: [2],
        parentIssue: null,
        blockerIssues: [{
          id: 1002,
          nodeId: 'ISSUE-node-2',
          number: 2,
          repository: repositoryIdentity,
        }],
      }),
      expect.objectContaining({
        beadId: 'pb-2',
        projectItem: {
          id: 'ITEM-2',
          archived: true,
          fields: {
            beadId: 'pb-2',
            status: 'closed',
            blocked: false,
            done: true,
            priority: 2,
            type: 'task',
          },
        },
        parentIssueNumber: 1,
        blockerIssueNumbers: [],
        parentIssue: {
          id: 1001,
          nodeId: 'ISSUE-node-1',
          number: 1,
          repository: repositoryIdentity,
        },
        blockerIssues: [],
      }),
    ]);

    const itemQueries = runner.calls.slice(2, 4).map(parseStdin);
    expect(itemQueries.map((payload) => payload.variables)).toEqual([
      { projectId: projectNodeId, cursor: null },
      { projectId: projectNodeId, cursor: 'ITEM-CURSOR' },
    ]);
    expect(itemQueries[0]?.query).toMatch(
      /items\(first:\s*100,\s*after:\s*\$cursor,\s*archivedStates:\s*\[ARCHIVED,\s*NOT_ARCHIVED\]\)/u,
    );
    expect(itemQueries[0]?.query).toMatch(/\bisArchived\b/u);
    expect(itemQueries[0]?.query).toMatch(/\bfieldValues\(first:\s*100\)/u);
    expect(runner.calls.slice(4).map((call) => call.args[1])).toEqual([
      `repos/${owner}/${repo}/issues/1/parent`,
      `repos/${owner}/${repo}/issues/1/dependencies/blocked_by?per_page=100&page=1`,
      `repos/${owner}/${repo}/issues/2/parent`,
      `repos/${owner}/${repo}/issues/2/dependencies/blocked_by?per_page=100&page=1`,
    ]);
  });

  it('ensures every managed label and sends label definitions through stdin', async () => {
    const runner = createRunner([
      success([{ name: 'bead' }, { name: 'priority:P0' }]),
      ...Array.from({ length: 10 }, () => success({})),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    const labels = await client.ensureLabels();

    expect(labels.map((label) => label.name)).toEqual([
      'bead',
      'bead:epic',
      'bead:feature',
      'bead:task',
      'priority:P0',
      'priority:P1',
      'priority:P2',
      'priority:P3',
      'priority:P4',
      'status:blocked',
    ]);
    expect(runner.calls[0]?.args).toEqual([
      'api',
      `repos/${owner}/${repo}/labels?per_page=100&page=1`,
      '--method',
      'GET',
      ...apiHeaders,
    ]);
    expect(runner.calls[1]?.args).toEqual([
      'api',
      `repos/${owner}/${repo}/labels`,
      '--method',
      'POST',
      ...apiHeaders,
      '--input',
      '-',
    ]);
    expect(parseStdin(runner.calls[1]!)).toEqual({
      name: 'bead:epic',
      color: '8250df',
      description: 'Mirrored Beads epic',
    });
    expect(runner.calls.flatMap((call) => call.args)).not.toContain(token);
  });

  it('re-reads label identity after an applied-then-transport failure', async () => {
    const transportFailure = Object.assign(new Error('request failed'), { code: 'ECONNRESET' });
    const runner = createRunner([
      success([
        { name: 'bead' },
        { name: 'bead:epic' },
        { name: 'bead:feature' },
        { name: 'bead:task' },
        { name: 'priority:P0' },
        { name: 'priority:P1' },
        { name: 'priority:P2' },
        { name: 'priority:P3' },
        { name: 'priority:P4' },
      ]),
      transportFailure,
      success({ name: 'status:blocked' }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    await expect(client.ensureLabels()).resolves.toEqual(expect.any(Array));
    expect(runner.calls.filter((call) => call.args.includes('POST'))).toHaveLength(1);
    expect(runner.calls[2]?.args[1]).toBe(
      `repos/${owner}/${repo}/labels/status%3Ablocked`,
    );
  });

  it('discovers the managed Project by README marker and never by title alone', async () => {
    const runner = createRunner([
      projectDiscovery([
        {
          id: 'P-title-only',
          number: 3,
          title: 'Public Beads',
          readme: 'Manual project with the same title.',
          public: true,
          url: 'https://github.com/orgs/OpenCoven/projects/3',
        },
        {
          id: projectNodeId,
          number: 11,
          title: 'Renamed inventory',
          readme: `${boundProjectReadmeMarker}\n# Public Beads`,
          public: true,
          url: 'https://github.com/orgs/OpenCoven/projects/11',
        },
      ]),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });

    await expect(client.discoverProject()).resolves.toMatchObject({
      id: projectNodeId,
      number: 11,
      title: 'Renamed inventory',
    });
    const payload = parseStdin(runner.calls[0]!);
    expect(runner.calls[0]?.args).toEqual(['api', 'graphql', '--include', '--input', '-']);
    expect(payload.variables).toEqual({ owner, repo, cursor: null });
    expect(payload.query).toMatch(/projectsV2\(first:\s*100,\s*after:\s*\$cursor\)/u);
    expect(payload.query).toMatch(/\breadme\b/u);
    expect(payload.query).toMatch(/\brepositories\(first:\s*100/u);
    expect(payload.query).toMatch(/\bitems\(first:\s*1/u);
  });

  it('reuses one Project discovery snapshot throughout a sync run', async () => {
    const project = {
      id: projectNodeId,
      number: 11,
      title: 'Public Beads',
      readme: `${boundProjectReadmeMarker}\n# Public Beads`,
      public: true,
      url: 'https://github.com/orgs/OpenCoven/projects/11',
    };
    const runner = createRunner([
      projectDiscovery([project]),
      projectDiscovery([project]),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });

    await expect(client.discoverProject()).resolves.toMatchObject({ id: projectNodeId });
    await expect(client.ensureProject({
      title: project.title,
      readme: project.readme,
    })).resolves.toMatchObject({ id: projectNodeId });

    expect(runner.calls).toHaveLength(1);
  });

  it('invalidates Project discovery state and repairs from a fresh post-lock snapshot', async () => {
    const title = 'Public Beads';
    const readme = `${boundProjectReadmeMarker}\n# Public Beads`;
    const stale = {
      id: projectNodeId,
      number: 11,
      title,
      readme,
      public: true,
      url: 'https://github.com/orgs/OpenCoven/projects/11',
    };
    const changed = {
      ...stale,
      title: 'Changed while waiting for the lock',
      readme: `${boundProjectReadmeMarker}\n# Changed while waiting`,
    };
    const runner = createRunner([
      projectDiscovery([stale]),
      projectDiscovery([changed]),
      success({
        data: {
          updateProjectV2: {
            projectV2: { ...changed, title, readme },
          },
        },
      }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });

    await expect(client.discoverProject()).resolves.toMatchObject({ title });
    await expect(client.refreshProject()).resolves.toMatchObject({
      title: 'Changed while waiting for the lock',
    });
    await expect(client.ensureProject({ title, readme })).resolves.toMatchObject({
      title,
      readme,
    });

    expect(runner.calls.filter((call) =>
      String(parseStdin(call).query ?? '').includes('query DiscoverManagedProject')
    )).toHaveLength(2);
    expect(parseStdin(runner.calls[2]!)).toMatchObject({
      variables: { projectId: projectNodeId, title, readme },
    });
  });

  it('uses repository binding when an unbound marked Project is linked elsewhere', async () => {
    const runner = createRunner([
      projectDiscovery([
        {
          id: 'P-foreign-marker',
          number: 4,
          title: 'Foreign marker',
          readme: '<!-- psyche-beads-project-sync:v1 project-readme repository=OpenCoven/other -->',
          public: true,
        },
        {
          id: 'P-unlinked',
          number: 5,
          title: 'Unlinked marker',
          readme: '<!-- psyche-beads-project-sync:v1 project-readme -->',
          public: true,
          repositories: {
            nodes: [{ id: 'OTHER_REPO' }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
        {
          id: projectNodeId,
          number: 11,
          title: 'Linked marker',
          readme: '<!-- psyche-beads-project-sync:v1 project-readme repository=OpenCoven/psyche-build -->',
          public: true,
        },
      ]),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });

    await expect(client.discoverProject()).resolves.toMatchObject({
      id: projectNodeId,
      number: 11,
    });
  });

  it('discovers the default-marked Project when a custom project marker is configured', async () => {
    const runner = createRunner([
      projectDiscovery([{
        id: projectNodeId,
        number: 11,
        title: 'Existing Public Beads',
        readme: `${boundProjectReadmeMarker}\n# Existing Public Beads`,
        public: true,
        url: 'https://github.com/orgs/OpenCoven/projects/11',
      }]),
    ]);
    const client = createGhClient({
      run: runner.run,
      owner,
      repo,
      token,
      projectNodeId,
      projectMarker: 'custom-project-sync:v2',
      legacyProjectMarkers: ['prior-project-sync:v1'],
    });

    await expect(client.discoverProject()).resolves.toMatchObject({
      id: projectNodeId,
      number: 11,
    });
  });

  it('migrates a legacy marked Project instead of creating a duplicate Project', async () => {
    const legacyProject = {
      id: projectNodeId,
      number: 11,
      title: 'Legacy Public Beads',
      readme:
        '<!-- psyche-bead-sync:v1 project-readme repository=OpenCoven/psyche-build -->\n# Legacy Public Beads',
      public: true,
      url: 'https://github.com/orgs/OpenCoven/projects/11',
    };
    const desiredReadme =
      '<!-- custom-project-sync:v2 project-readme repository=OpenCoven/psyche-build -->\n# Public Beads';
    const runner = createRunner([
      projectDiscovery([legacyProject]),
      success({
        data: {
          updateProjectV2: {
            projectV2: {
              ...legacyProject,
              readme: desiredReadme,
            },
          },
        },
      }),
      linkedRepositoriesPage([{ id: 'REPO_node' }]),
    ]);
    const client = createGhClient({
      run: runner.run,
      owner,
      repo,
      token,
      projectNodeId,
      projectMarker: 'custom-project-sync:v2',
      issueMarker: 'custom-issue-sync:v2',
      legacyProjectMarkers: ['psyche-bead-sync:v1'],
      legacyIssueMarkers: ['psyche-bead-sync:v1'],
    });

    await expect(client.ensureProject({
      title: 'Public Beads',
      readme: desiredReadme,
    })).resolves.toMatchObject({
      id: projectNodeId,
      readme: desiredReadme,
    });
    expect(runner.calls.some((call) =>
      String(parseStdin(call).query ?? '').includes('mutation CreateManagedProject')
    )).toBe(false);
    expect(runner.calls.some((call) =>
      String(parseStdin(call).query ?? '').includes('mutation UpdateManagedProject')
    )).toBe(true);
  });

  it('repairs the pinned repository-bound renamed Project and relinks it', async () => {
    const renamed = {
      id: projectNodeId,
      number: 11,
      title: 'Former public inventory title',
      readme: `${boundProjectReadmeMarker}\n# Former title`,
      public: true,
      repositories: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      items: { totalCount: 2 },
    };
    const title = 'Psyche Build: Goals & Implementation';
    const readme = `${boundProjectReadmeMarker}\n# ${title}`;
    const runner = createRunner([
      projectDiscovery([renamed]),
      success({
        data: {
          updateProjectV2: {
            projectV2: { ...renamed, title, readme },
          },
        },
      }),
      success({ data: { linkProjectV2ToRepository: { repository: { id: 'REPO_node' } } } }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });

    await expect(client.ensureProject({ title, readme })).resolves.toMatchObject({
      id: projectNodeId,
      title,
      readme,
    });
    expect(runner.calls.some((call) =>
      String(parseStdin(call).query ?? '').includes('mutation CreateManagedProject')
    )).toBe(false);
    expect(parseStdin(runner.calls[1]!)).toMatchObject({
      variables: {
        projectId: projectNodeId,
        title,
        readme,
      },
    });
    expect(parseStdin(runner.calls[2]!)).toMatchObject({
      variables: {
        projectId: projectNodeId,
        repositoryId: 'REPO_node',
      },
    });
  });

  it('repairs a missing README marker when the pinned public Project remains repository-linked', async () => {
    const title = 'Psyche Build: Goals & Implementation';
    const readme = `${boundProjectReadmeMarker}\n# ${title}`;
    const linked = {
      id: projectNodeId,
      number: 11,
      title,
      readme: '# README marker was removed',
      public: true,
    };
    const runner = createRunner([
      projectDiscovery([linked]),
      success({
        data: {
          updateProjectV2: {
            projectV2: { ...linked, readme },
          },
        },
      }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });

    await expect(client.ensureProject({ title, readme })).resolves.toMatchObject({
      id: projectNodeId,
      readme,
    });
    expect(parseStdin(runner.calls[1]!)).toMatchObject({
      variables: { projectId: projectNodeId, title, readme },
    });
  });

  it('ignores a duplicate repository marker on another Project when the pinned Project matches', async () => {
    const runner = createRunner([
      projectDiscovery([
        {
          id: 'P-duplicate',
          number: 12,
          title: 'Duplicate',
          readme:
            '<!-- custom-project-sync:v2 project-readme repository=OpenCoven/psyche-build -->',
          public: true,
        },
        {
          id: projectNodeId,
          number: 11,
          title: 'Pinned',
          readme:
            '<!-- custom-project-sync:v2 project-readme repository=OpenCoven/psyche-build -->',
          public: true,
        },
      ]),
    ]);
    const client = createGhClient({
      run: runner.run,
      owner,
      repo,
      token,
      projectNodeId,
      projectMarker: 'custom-project-sync:v2',
      issueMarker: 'custom-issue-sync:v2',
      legacyProjectMarkers: ['psyche-bead-sync:v1'],
      legacyIssueMarkers: ['psyche-bead-sync:v1'],
    });

    await expect(client.discoverProject()).resolves.toMatchObject({
      id: projectNodeId,
      number: 11,
    });
  });

  it('ignores a wrong-ID marked private Project without mutating it', async () => {
    const runner = createRunner([
      projectDiscovery([{
        id: 'PVT_wrong',
        number: 12,
        title: 'Wrong private Project',
        readme: boundProjectReadmeMarker,
        public: false,
      }]),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });

    await expect(client.discoverProject()).resolves.toBeNull();
    expect(runner.calls).toHaveLength(1);
    expect(parseStdin(runner.calls[0]!).query).toMatch(/query DiscoverManagedProject/u);
  });

  it('fails closed on the private pinned Project before any mutation', async () => {
    const runner = createRunner([
      projectDiscovery([{
        id: projectNodeId,
        number: 11,
        title: 'Pinned private Project',
        readme: boundProjectReadmeMarker,
        public: false,
      }]),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });

    await expect(client.discoverProject()).rejects.toThrow(
      /private.*manual maintainer review.*visibility/i,
    );
    expect(runner.calls).toHaveLength(1);
  });

  it('bootstraps an absent Project and returns its node ID for maintainers to pin', async () => {
    const readme = '<!-- psyche-beads-project-sync:v1 project-readme repository=OpenCoven/psyche-build -->\n# Public Beads';
    const runner = createRunner([
      projectDiscovery([]),
      success({ data: { createProjectV2: { projectV2: {
        id: 'P-new',
        number: 12,
        title: 'Public Beads',
        readme: '',
        public: false,
        url: 'https://github.com/orgs/OpenCoven/projects/12',
      } } } }),
      success({ data: { updateProjectV2: { projectV2: { id: 'P-new', public: true, readme } } } }),
      linkedRepositoriesPage([]),
      success({ data: { linkProjectV2ToRepository: { repository: { id: 'REPO_node' } } } }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, bootstrap: true });

    const project = await client.ensureProject({ title: 'Public Beads', readme });

    expect(project).toMatchObject({ id: 'P-new', number: 12, public: true, readme });
    expect(runner.calls).toHaveLength(5);
    expect(parseStdin(runner.calls[1]!)).toMatchObject({
      variables: { ownerId: 'ORG_node', title: 'Public Beads' },
    });

    expect(parseStdin(runner.calls[1]!).query).toMatch(/mutation CreateManagedProject/u);
    expect(parseStdin(runner.calls[2]!)).toMatchObject({
      variables: { projectId: 'P-new', title: 'Public Beads', readme },
    });
    expect(parseStdin(runner.calls[2]!).query).toMatch(/mutation UpdateManagedProject/u);
    expect(parseStdin(runner.calls[2]!).query).toMatch(/public:\s*true/u);
    expect(parseStdin(runner.calls[4]!)).toMatchObject({
      variables: { projectId: 'P-new', repositoryId: 'REPO_node' },
    });
    for (const call of runner.calls.slice(1)) {
      expect(call.args).toEqual(['api', 'graphql', '--include', '--input', '-']);
      expect(call.args.join(' ')).not.toContain(readme);
    }
  });

  it('bootstrap mode refuses to adopt an existing marked private Project', async () => {
    const runner = createRunner([
      projectDiscovery([{
        id: 'P-private-existing',
        number: 20,
        title: 'Public Beads',
        readme: boundProjectReadmeMarker,
        public: false,
      }]),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, bootstrap: true });

    await expect(client.ensureProject({
      title: 'Public Beads',
      readme: `${boundProjectReadmeMarker}\n# Public Beads`,
    })).rejects.toThrow(/existing marked Project.*pin.*node ID/i);
    expect(runner.calls).toHaveLength(1);
  });

  it('fails closed instead of adopting a preexisting pristine unmarked Project', async () => {
    const readme = '<!-- psyche-beads-project-sync:v1 project-readme repository=OpenCoven/psyche-build -->\n# Public Beads';
    const pristine = {
      id: 'P-crash-window',
      number: 20,
      title: 'Public Beads',
      readme: '',
      public: false,
      closed: false,
      repositories: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      items: { totalCount: 0 },
    };
    const runner = createRunner([
      projectDiscovery([pristine]),
      success({
        data: {
          updateProjectV2: {
            projectV2: { ...pristine, readme, public: true },
          },
        },
      }),
      success({ data: { linkProjectV2ToRepository: { repository: { id: 'REPO_node' } } } }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, bootstrap: true });

    await expect(client.ensureProject({ title: 'Public Beads', readme })).rejects.toThrow(
      /unmarked Project.*manual recovery.*delete it and rerun/i,
    );
    expect(runner.calls.some((call) =>
      String(parseStdin(call).query ?? '').includes('mutation CreateManagedProject')
    )).toBe(false);
    expect(runner.calls.some((call) =>
      String(parseStdin(call).query ?? '').includes('mutation UpdateManagedProject')
    )).toBe(false);
  });

  it('does not recover a non-pristine unmarked Project with the same title', async () => {
    const readme = '<!-- psyche-beads-project-sync:v1 project-readme repository=OpenCoven/psyche-build -->\n# Public Beads';
    const occupied = {
      id: 'P-manual',
      number: 21,
      title: 'Public Beads',
      readme: '',
      public: false,
      closed: false,
      repositories: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      items: { totalCount: 1 },
    };
    const created = {
      id: 'P-new-safe',
      number: 22,
      title: 'Public Beads',
      readme: '',
      public: false,
      closed: false,
    };
    const runner = createRunner([
      projectDiscovery([occupied]),
      success({ data: { createProjectV2: { projectV2: created } } }),
      success({
        data: {
          updateProjectV2: {
            projectV2: { ...created, readme, public: true },
          },
        },
      }),
      linkedRepositoriesPage([]),
      success({ data: { linkProjectV2ToRepository: { repository: { id: 'REPO_node' } } } }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, bootstrap: true });

    await expect(client.ensureProject({ title: 'Public Beads', readme })).resolves.toMatchObject({
      id: 'P-new-safe',
    });
    expect(runner.calls.filter((call) =>
      String(parseStdin(call).query ?? '').includes('mutation CreateManagedProject')
    )).toHaveLength(1);
  });

  it('verifies and repairs repository linking for an existing marked Project', async () => {
    const readme = `${boundProjectReadmeMarker}\n# Public Beads`;
    const existing = {
      id: projectNodeId,
      number: 11,
      title: 'Public Beads',
      readme,
      public: true,
      repositories: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    const runner = createRunner([
      projectDiscovery([existing]),
      success({ data: { linkProjectV2ToRepository: { repository: { id: 'REPO_node' } } } }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });

    await expect(client.ensureProject({ title: 'Public Beads', readme })).resolves.toMatchObject({
      id: projectNodeId,
      number: 11,
      title: 'Public Beads',
      readme,
      public: true,
    });
    expect(parseStdin(runner.calls[1]!)).toMatchObject({
      variables: { projectId: projectNodeId, repositoryId: 'REPO_node' },
    });
  });

  it('resumes a marker-written Project after repository linking failed without creating a duplicate', async () => {
    const readme = `${boundProjectReadmeMarker}\n# Public Beads`;
    const existing = {
      id: projectNodeId,
      number: 11,
      title: 'Public Beads',
      readme,
      public: true,
      repositories: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    const firstRunner = createRunner([
      projectDiscovery([existing]),
      httpError(503, 'link response lost'),
      linkedRepositoriesPage([]),
    ]);
    const firstClient = createGhClient({
      run: firstRunner.run,
      owner,
      repo,
      token,
      projectNodeId,
    });

    await expect(firstClient.ensureProject({ title: 'Public Beads', readme })).rejects.toMatchObject({
      kind: 'ambiguous',
    });

    const restartRunner = createRunner([
      projectDiscovery([existing]),
      success({ data: { linkProjectV2ToRepository: { repository: { id: 'REPO_node' } } } }),
    ]);
    const restartedClient = createGhClient({
      run: restartRunner.run,
      owner,
      repo,
      token,
      projectNodeId,
    });

    await expect(restartedClient.ensureProject({ title: 'Public Beads', readme })).resolves.toMatchObject({
      id: projectNodeId,
    });
    expect([...firstRunner.calls, ...restartRunner.calls].some((call) =>
      String(parseStdin(call).query ?? '').includes('mutation CreateManagedProject')
    )).toBe(false);
  });

  it('re-reads a newly created Project by name after an applied-then-5xx response', async () => {
    const readme = `${boundProjectReadmeMarker}\n# Public Beads`;
    const transient = Object.assign(new Error('HTTP 503 project response lost'), { status: 503 });
    const created = {
      id: 'P-applied',
      number: 18,
      title: 'Public Beads',
      readme: '',
      public: false,
      closed: false,
      repositories: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    const runner = createRunner([
      projectDiscovery([]),
      transient,
      projectDiscovery([created]),
      success({ data: { updateProjectV2: { projectV2: { ...created, readme, public: true } } } }),
      success({ data: { linkProjectV2ToRepository: { repository: { id: 'REPO_node' } } } }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, bootstrap: true });

    await expect(client.ensureProject({ title: 'Public Beads', readme })).resolves.toMatchObject({
      id: 'P-applied',
      readme,
      public: true,
    });
    expect(runner.calls.filter((call) =>
      String(parseStdin(call).query ?? '').includes('mutation CreateManagedProject'),
    )).toHaveLength(1);
  });

  it('re-reads a newly created Project after an applied-then-transport failure', async () => {
    const readme = `${boundProjectReadmeMarker}\n# Public Beads`;
    const transportFailure = Object.assign(new Error('request failed'), { code: 'ECONNRESET' });
    const created = {
      id: 'P-transport-applied',
      number: 19,
      title: 'Public Beads',
      readme: '',
      public: false,
      closed: false,
      repositories: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    const runner = createRunner([
      projectDiscovery([]),
      transportFailure,
      projectDiscovery([created]),
      success({ data: { updateProjectV2: { projectV2: { ...created, readme, public: true } } } }),
      success({ data: { linkProjectV2ToRepository: { repository: { id: 'REPO_node' } } } }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, bootstrap: true });

    await expect(client.ensureProject({ title: 'Public Beads', readme })).resolves.toMatchObject({
      id: 'P-transport-applied',
      readme,
      public: true,
    });
    expect(runner.calls.filter((call) =>
      String(parseStdin(call).query ?? '').includes('mutation CreateManagedProject'),
    )).toHaveLength(1);
  });

  it('blocks a duplicate when a prior create leaves an unmarked orphan across restart', async () => {
    const readme = `${boundProjectReadmeMarker}\n# Public Beads`;
    const transportFailure = Object.assign(new Error('request failed'), { code: 'ECONNRESET' });
    const orphan = {
      id: 'P-restart-orphan',
      number: 24,
      title: 'Public Beads',
      readme: '',
      public: false,
      closed: false,
      repositories: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      items: { totalCount: 0 },
    };
    const firstRunner = createRunner([
      projectDiscovery([]),
      transportFailure,
      httpError(403, 'recovery read forbidden'),
    ]);
    const firstClient = createGhClient({
      run: firstRunner.run,
      owner,
      repo,
      token,
      bootstrap: true,
    });

    await expect(firstClient.ensureProject({ title: 'Public Beads', readme })).rejects.toMatchObject({
      kind: 'ambiguous',
    });
    expect(firstRunner.calls.filter((call) =>
      String(parseStdin(call).query ?? '').includes('mutation CreateManagedProject'),
    )).toHaveLength(1);

    const restartRunner = createRunner([
      projectDiscovery([orphan]),
      success({
        data: {
          updateProjectV2: {
            projectV2: { ...orphan, readme, public: true },
          },
        },
      }),
      success({ data: { linkProjectV2ToRepository: { repository: { id: 'REPO_node' } } } }),
    ]);
    const restartedClient = createGhClient({
      run: restartRunner.run,
      owner,
      repo,
      token,
      bootstrap: true,
    });

    await expect(restartedClient.ensureProject({ title: 'Public Beads', readme })).rejects.toThrow(
      /unmarked Project.*manual recovery.*delete it and rerun/i,
    );
    expect(restartRunner.calls.some((call) =>
      String(parseStdin(call).query ?? '').includes('mutation CreateManagedProject')
    )).toBe(false);
    expect(restartRunner.calls.some((call) =>
      String(parseStdin(call).query ?? '').includes('mutation UpdateManagedProject')
    )).toBe(false);
  });

  it('discovers fields/options and provisions the required Status and custom field definitions', async () => {
    const runner = createRunner([
      projectDiscovery([{
        id: projectNodeId,
        number: 8,
        title: 'Public Beads',
        readme: boundProjectReadmeMarker,
        public: true,
        url: 'https://github.com/orgs/OpenCoven/projects/8',
      }]),
      success({ data: { node: { fields: {
        nodes: [{
          __typename: 'ProjectV2SingleSelectField',
          id: 'F-status',
          name: 'Status',
          dataType: 'SINGLE_SELECT',
          options: [{ id: 'O-old', name: 'Todo' }],
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } }),
      success({ data: { updateProjectV2Field: { projectV2Field: {
        id: 'F-status',
        name: 'Status',
        options: [],
      } } } }),
      ...Array.from({ length: 5 }, (_, index) => success({
        data: { createProjectV2Field: { projectV2Field: { id: `F-${index}` } } },
      })),
      success({ data: { node: { fields: {
        nodes: [
          {
            __typename: 'ProjectV2SingleSelectField',
            id: 'F-status',
            name: 'Status',
            dataType: 'SINGLE_SELECT',
            options: ['Backlog', 'Ready', 'In Progress', 'Blocked', 'Done']
              .map((name, index) => ({ id: `S-${index}`, name })),
          },
          {
            __typename: 'ProjectV2SingleSelectField',
            id: 'F-priority',
            name: 'Priority',
            dataType: 'SINGLE_SELECT',
            options: ['P0', 'P1', 'P2', 'P3', 'P4']
              .map((name, index) => ({ id: `P-${index}`, name })),
          },
          {
            __typename: 'ProjectV2SingleSelectField',
            id: 'F-type',
            name: 'Bead Type',
            dataType: 'SINGLE_SELECT',
            options: ['Epic', 'Feature', 'Task', 'Bug', 'Chore', 'Decision']
              .map((name, index) => ({ id: `T-${index}`, name })),
          },
          { __typename: 'ProjectV2Field', id: 'F-id', name: 'Bead ID', dataType: 'TEXT' },
          { __typename: 'ProjectV2Field', id: 'F-parent', name: 'Parent Goal', dataType: 'TEXT' },
          { __typename: 'ProjectV2Field', id: 'F-updated', name: 'Source Updated', dataType: 'DATE' },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });
    await client.discoverProject();

    const fields = await client.ensureFields();

    expect([...fields.keys()]).toEqual([
      'Status',
      'Priority',
      'Bead Type',
      'Bead ID',
      'Parent Goal',
      'Source Updated',
    ]);
    expect(parseStdin(runner.calls[2]!)).toMatchObject({
      variables: {
        fieldId: 'F-status',
        options: [
          { name: 'Backlog', color: 'GRAY', description: '' },
          { name: 'Ready', color: 'BLUE', description: '' },
          { name: 'In Progress', color: 'YELLOW', description: '' },
          { name: 'Blocked', color: 'RED', description: '' },
          { name: 'Done', color: 'GREEN', description: '' },
        ],
      },
    });
    expect(runner.calls.slice(3, 8).map((call) => {
      const variables = parseStdin(call).variables as { input: { name: string } };
      return variables.input.name;
    })).toEqual(['Priority', 'Bead Type', 'Bead ID', 'Parent Goal', 'Source Updated']);
  });

  it('preserves existing single-select option IDs while adding missing options idempotently', async () => {
    const statusOptions = ['Backlog', 'Ready', 'In Progress', 'Blocked']
      .map((name, index) => ({ id: `S-${index}`, name }));
    const allFields = [
      {
        __typename: 'ProjectV2SingleSelectField',
        id: 'F-status',
        name: 'Status',
        dataType: 'SINGLE_SELECT',
        options: [...statusOptions, { id: 'S-done', name: 'Done' }],
      },
      {
        __typename: 'ProjectV2SingleSelectField',
        id: 'F-priority',
        name: 'Priority',
        dataType: 'SINGLE_SELECT',
        options: ['P0', 'P1', 'P2', 'P3', 'P4']
          .map((name, index) => ({ id: `P-${index}`, name })),
      },
      {
        __typename: 'ProjectV2SingleSelectField',
        id: 'F-type',
        name: 'Bead Type',
        dataType: 'SINGLE_SELECT',
        options: ['Epic', 'Feature', 'Task', 'Bug', 'Chore', 'Decision']
          .map((name, index) => ({ id: `T-${index}`, name })),
      },
      { __typename: 'ProjectV2Field', id: 'F-id', name: 'Bead ID', dataType: 'TEXT' },
      { __typename: 'ProjectV2Field', id: 'F-parent', name: 'Parent Goal', dataType: 'TEXT' },
      { __typename: 'ProjectV2Field', id: 'F-updated', name: 'Source Updated', dataType: 'DATE' },
    ];
    const fieldsPage = (nodes: unknown[]) => success({ data: { node: { fields: {
      nodes,
      pageInfo: { hasNextPage: false, endCursor: null },
    } } } });
    const runner = createRunner([
      projectDiscovery([{
        id: projectNodeId,
        number: 18,
        title: 'Public Beads',
        readme: boundProjectReadmeMarker,
        public: true,
      }]),
      fieldsPage([
        { ...allFields[0], options: statusOptions },
        ...allFields.slice(1),
      ]),
      success({ data: { updateProjectV2Field: { projectV2Field: allFields[0] } } }),
      fieldsPage(allFields),
      fieldsPage(allFields),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });
    await client.discoverProject();

    await client.ensureFields();
    await client.ensureFields();

    const updates = runner.calls.filter((call) =>
      String(parseStdin(call).query ?? '').includes('mutation UpdateManagedProjectField')
    );
    expect(updates).toHaveLength(1);
    expect(parseStdin(updates[0]!)).toMatchObject({
      variables: {
        fieldId: 'F-status',
        options: [
          { id: 'S-0', name: 'Backlog', color: 'GRAY', description: '' },
          { id: 'S-1', name: 'Ready', color: 'BLUE', description: '' },
          { id: 'S-2', name: 'In Progress', color: 'YELLOW', description: '' },
          { id: 'S-3', name: 'Blocked', color: 'RED', description: '' },
          { name: 'Done', color: 'GREEN', description: '' },
        ],
      },
    });
  });

  it('re-reads a custom field by name after an applied-then-5xx create', async () => {
    const transient = Object.assign(new Error('HTTP 503 field response lost'), { status: 503 });
    const fields = [
      {
        __typename: 'ProjectV2SingleSelectField',
        id: 'F-status',
        name: 'Status',
        dataType: 'SINGLE_SELECT',
        options: ['Backlog', 'Ready', 'In Progress', 'Blocked', 'Done']
          .map((name, index) => ({ id: `S-${index}`, name })),
      },
      {
        __typename: 'ProjectV2SingleSelectField',
        id: 'F-priority',
        name: 'Priority',
        dataType: 'SINGLE_SELECT',
        options: ['P0', 'P1', 'P2', 'P3', 'P4']
          .map((name, index) => ({ id: `P-${index}`, name })),
      },
      {
        __typename: 'ProjectV2SingleSelectField',
        id: 'F-type',
        name: 'Bead Type',
        dataType: 'SINGLE_SELECT',
        options: ['Epic', 'Feature', 'Task', 'Bug', 'Chore', 'Decision']
          .map((name, index) => ({ id: `T-${index}`, name })),
      },
      { __typename: 'ProjectV2Field', id: 'F-id', name: 'Bead ID', dataType: 'TEXT' },
      { __typename: 'ProjectV2Field', id: 'F-parent', name: 'Parent Goal', dataType: 'TEXT' },
      { __typename: 'ProjectV2Field', id: 'F-updated', name: 'Source Updated', dataType: 'DATE' },
    ];
    const fieldsPage = (nodes: unknown[]) => success({ data: { node: { fields: {
      nodes,
      pageInfo: { hasNextPage: false, endCursor: null },
    } } } });
    const runner = createRunner([
      projectDiscovery([{
        id: projectNodeId,
        number: 19,
        title: 'Public Beads',
        readme: boundProjectReadmeMarker,
        public: true,
      }]),
      fieldsPage(fields.filter((field) => field.name !== 'Bead ID')),
      transient,
      fieldsPage(fields),
      fieldsPage(fields),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });
    await client.discoverProject();

    await expect(client.ensureFields()).resolves.toEqual(expect.any(Map));
    expect(runner.calls.filter((call) =>
      String(parseStdin(call).query ?? '').includes('mutation CreateManagedProjectField'),
    )).toHaveLength(1);
  });

  it('creates or updates the six managed views through GraphQL with exact layouts and filters', async () => {
    const runner = createRunner([
      projectDiscovery([{
        id: projectNodeId,
        number: 9,
        title: 'Public Beads',
        readme: boundProjectReadmeMarker,
        public: true,
      }]),
      success({ data: { node: { views: {
        nodes: [
          { id: 'V-overview', name: 'Overview', layout: 'BOARD_LAYOUT', filter: 'old:true' },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } }),
      success({ data: { updateProjectV2View: { projectV2View: {
        id: 'V-overview',
        ...PROJECT_VIEWS[0],
      } } } }),
      ...PROJECT_VIEWS.slice(1).flatMap((view, index) => [
        success({ data: { createProjectV2View: { projectV2View: {
          id: `V-${index + 1}`,
          name: view.name,
          layout: view.layout,
          filter: '',
        } } } }),
        success({ data: { updateProjectV2View: { projectV2View: {
          id: `V-${index + 1}`,
          ...view,
        } } } }),
      ]),
      success({ data: { node: { views: {
        nodes: PROJECT_VIEWS.map((view, index) => ({ id: `V-${index}`, ...view })),
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });
    await client.discoverProject();

    const views = await client.ensureViews();
    expect(views.map(({ name, layout, filter }) => ({ name, layout, filter }))).toEqual(PROJECT_VIEWS);
    const mutationCalls = runner.calls.slice(2, -1);
    expect(mutationCalls).toHaveLength(11);
    expect(parseStdin(mutationCalls[0]!)).toMatchObject({
      variables: {
        input: {
          viewId: 'V-overview',
          name: 'Overview',
          layout: 'TABLE_LAYOUT',
          filter: '',
        },
      },
    });
    expect(parseStdin(mutationCalls[0]!).query).toMatch(/mutation UpdateManagedProjectView/u);
    for (const [index, view] of PROJECT_VIEWS.slice(1).entries()) {
      const createPayload = parseStdin(mutationCalls[(index * 2) + 1]!);
      expect(createPayload.query).toMatch(/mutation CreateManagedProjectView/u);
      expect(createPayload.variables).toEqual({
        input: {
          projectId: projectNodeId,
          name: view.name,
          layout: view.layout,
        },
      });

      const filterPayload = parseStdin(mutationCalls[(index * 2) + 2]!);
      expect(filterPayload.query).toMatch(/mutation UpdateManagedProjectView/u);
      expect(filterPayload.variables).toEqual({
        input: {
          viewId: `V-${index + 1}`,
          filter: view.filter,
        },
      });
    }
  });

  it('rechecks lease ownership between a compound view create and filter update', async () => {
    const backend = createApplyLockBackend();
    const timerHarness = createTimerHarness();
    const businessCalls: RunCall[] = [];
    const run: GhRun = async (command, args, options) => {
      if (args[0] !== 'api' || args[1] !== 'graphql') {
        return backend.run(command, args, options);
      }
      const call = { command, args: [...args], options: { ...options } };
      businessCalls.push(call);
      const query = String(parseStdin(call).query ?? '');
      if (query.includes('query DiscoverManagedProject')) {
        return projectDiscovery([{
          id: projectNodeId,
          number: 11,
          title: 'Public Beads',
          readme: boundProjectReadmeMarker,
          public: true,
        }]);
      }
      if (query.includes('query DiscoverManagedProjectViews')) {
        return success({ data: { node: { views: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } });
      }
      if (query.includes('mutation CreateManagedProjectView')) {
        backend.stealLock({
          owner: 'contender',
          runId: 'other-run',
          leaseId: 'other-lease',
          acquiredAt: 20_000,
          expiresAt: 80_000,
        });
        return success({ data: { createProjectV2View: { projectV2View: {
          id: 'V-created',
          name: PROJECT_VIEWS[0]?.name,
          layout: PROJECT_VIEWS[0]?.layout,
          filter: '',
        } } } });
      }
      throw new Error(`Unexpected business GraphQL request: ${query}`);
    };
    const client = createGhClient({
      run,
      owner,
      repo,
      token,
      projectNodeId,
      mutationMode: 'lease-required',
      now: () => 10_000,
      setTimer: timerHarness.setTimer,
      clearTimer: timerHarness.clearTimer,
    });
    const handle = await client.acquireApplyLock({
      owner: 'test',
      runId: 'view-fence',
      leaseId: 'view-lease',
      ttlMs: 60_000,
    });
    const lease = client.startApplyLockLease(handle);

    try {
      await client.discoverProject();
      await expect(client.ensureViews()).rejects.toThrow(/lease.*lost|ownership/i);
    } finally {
      await lease.stop();
    }

    expect(businessCalls.filter((call) =>
      String(parseStdin(call).query ?? '').includes('mutation CreateManagedProjectView')
    )).toHaveLength(1);
    expect(businessCalls.some((call) =>
      String(parseStdin(call).query ?? '').includes('mutation UpdateManagedProjectView')
    )).toBe(false);
  });

  it('rechecks lease ownership between Project repair and repository relinking', async () => {
    const backend = createApplyLockBackend();
    const timerHarness = createTimerHarness();
    const businessCalls: RunCall[] = [];
    const desiredTitle = 'Public Beads';
    const desiredReadme = `${boundProjectReadmeMarker}\n# Public Beads`;
    const stale = {
      id: projectNodeId,
      number: 11,
      title: 'Renamed',
      readme: `${boundProjectReadmeMarker}\n# Renamed`,
      public: true,
      repositories: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    const run: GhRun = async (command, args, options) => {
      if (args[0] !== 'api' || args[1] !== 'graphql') {
        return backend.run(command, args, options);
      }
      const call = { command, args: [...args], options: { ...options } };
      businessCalls.push(call);
      const query = String(parseStdin(call).query ?? '');
      if (query.includes('query DiscoverManagedProject')) {
        return projectDiscovery([stale]);
      }
      if (query.includes('mutation UpdateManagedProject')) {
        backend.stealLock({
          owner: 'contender',
          runId: 'other-run',
          leaseId: 'other-lease',
          acquiredAt: 20_000,
          expiresAt: 80_000,
        });
        return success({ data: { updateProjectV2: { projectV2: {
          ...stale,
          title: desiredTitle,
          readme: desiredReadme,
        } } } });
      }
      throw new Error(`Unexpected business GraphQL request: ${query}`);
    };
    const client = createGhClient({
      run,
      owner,
      repo,
      token,
      projectNodeId,
      mutationMode: 'lease-required',
      now: () => 10_000,
      setTimer: timerHarness.setTimer,
      clearTimer: timerHarness.clearTimer,
    });
    const handle = await client.acquireApplyLock({
      owner: 'test',
      runId: 'project-fence',
      leaseId: 'project-lease',
      ttlMs: 60_000,
    });
    const lease = client.startApplyLockLease(handle);

    try {
      await client.discoverProject();
      await expect(client.ensureProject({
        title: desiredTitle,
        readme: desiredReadme,
      })).rejects.toThrow(/lease.*lost|ownership/i);
    } finally {
      await lease.stop();
    }

    expect(businessCalls.filter((call) =>
      String(parseStdin(call).query ?? '').includes('mutation UpdateManagedProject')
    )).toHaveLength(1);
    expect(businessCalls.some((call) =>
      String(parseStdin(call).query ?? '').includes('mutation LinkManagedProjectRepository')
    )).toBe(false);
  });

  it('re-reads a Project view by name after an applied-then-5xx create', async () => {
    const transient = Object.assign(new Error('HTTP 503 view response lost'), { status: 503 });
    const existingViews = PROJECT_VIEWS
      .filter((view) => view.name !== 'Backlog')
      .map((view, index) => ({ id: `V-existing-${index}`, ...view }));
    const createdBacklog = {
      id: 'V-backlog',
      name: 'Backlog',
      layout: 'BOARD_LAYOUT',
      filter: '',
    };
    const viewsPage = (nodes: unknown[]) => success({ data: { node: { views: {
      nodes,
      pageInfo: { hasNextPage: false, endCursor: null },
    } } } });
    const runner = createRunner([
      projectDiscovery([{
        id: projectNodeId,
        number: 20,
        title: 'Public Beads',
        readme: boundProjectReadmeMarker,
        public: true,
      }]),
      viewsPage(existingViews),
      transient,
      viewsPage([...existingViews, createdBacklog]),
      success({ data: { updateProjectV2View: { projectV2View: {
        ...createdBacklog,
        filter: 'status:Backlog',
      } } } }),
      viewsPage(PROJECT_VIEWS.map((view, index) => ({ id: `V-${index}`, ...view }))),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });
    await client.discoverProject();

    await expect(client.ensureViews()).resolves.toHaveLength(6);
    expect(runner.calls.filter((call) =>
      String(parseStdin(call).query ?? '').includes('mutation CreateManagedProjectView'),
    )).toHaveLength(1);
    expect(parseStdin(runner.calls[4]!).variables).toEqual({
      input: { viewId: 'V-backlog', filter: 'status:Backlog' },
    });
  });

  it('creates, replaces, clears, closes, reopens, labels, and assigns issues with JSON stdin', async () => {
    const body = [
      '<!-- psyche-bead-sync:v1 bead-id=pb-42 -->',
      '## Bead',
      '- Type: `feature`',
      '- Priority: P1',
      '- Blocked: yes',
    ].join('\n');
    const runner = createRunner([
      success({ number: 42 }),
      success(trustedIssue({ number: 42, body })),
      success({ number: 42 }),
      success({ number: 42 }),
      success({ number: 42 }),
      success({ number: 42 }),
      success({ number: 42 }),
      success({ number: 42 }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    await expect(
      client.createIssue({ title: '[pb-42] Work', body, assignees: ['octocat'] }),
    ).resolves.toMatchObject({ number: 42 });
    await client.updateIssue({
      issueNumber: 42,
      title: '[pb-42] Updated',
      body,
      state: 'open',
      assignees: ['BunsDev'],
    });
    await client.updateIssue({
      issueNumber: 42,
      title: '[pb-42] Cleared',
      body,
      state: 'open',
      assignees: [],
    });
    await client.closeIssue({ issueNumber: 42 });
    await client.reopenIssue({ issueNumber: 42 });
    await client.labelIssue({ issueNumber: 42, labels: ['bead', 'priority:P2'] });
    await client.assignIssue({ issueNumber: 42, assignee: 'hubot' });

    expect(runner.calls.map((call) => call.args)).toEqual([
      ['api', `repos/${owner}/${repo}/issues`, '--method', 'POST', ...apiHeaders, '--input', '-'],
      ['api', `repos/${owner}/${repo}/issues/42`, '--method', 'GET', ...apiHeaders],
      ['api', `repos/${owner}/${repo}/issues/42`, '--method', 'PATCH', ...apiHeaders, '--input', '-'],
      ['api', `repos/${owner}/${repo}/issues/42`, '--method', 'PATCH', ...apiHeaders, '--input', '-'],
      ['api', `repos/${owner}/${repo}/issues/42`, '--method', 'PATCH', ...apiHeaders, '--input', '-'],
      ['api', `repos/${owner}/${repo}/issues/42`, '--method', 'PATCH', ...apiHeaders, '--input', '-'],
      ['api', `repos/${owner}/${repo}/issues/42`, '--method', 'PATCH', ...apiHeaders, '--input', '-'],
      ['api', `repos/${owner}/${repo}/issues/42`, '--method', 'PATCH', ...apiHeaders, '--input', '-'],
    ]);
    expect(parseStdin(runner.calls[0]!)).toEqual({
      title: '[pb-42] Work',
      body,
      labels: ['bead', 'bead:feature', 'priority:P1', 'status:blocked'],
      assignees: ['octocat'],
    });
    expect(parseStdin(runner.calls[2]!)).toEqual({
      title: '[pb-42] Updated',
      body,
      state: 'open',
      labels: ['bead', 'bead:feature', 'priority:P1', 'status:blocked'],
      assignees: ['BunsDev'],
    });
    expect(parseStdin(runner.calls[3]!)).toEqual({
      title: '[pb-42] Cleared',
      body,
      state: 'open',
      labels: ['bead', 'bead:feature', 'priority:P1', 'status:blocked'],
      assignees: [],
    });
    expect(parseStdin(runner.calls[4]!)).toEqual({ state: 'closed' });
    expect(parseStdin(runner.calls[5]!)).toEqual({ state: 'open' });
    expect(parseStdin(runner.calls[6]!)).toEqual({ labels: ['bead', 'priority:P2'] });
    expect(parseStdin(runner.calls[7]!)).toEqual({ assignees: ['hubot'] });
  });

  it('rejects a created managed issue when its reread actor is outside the pinned allowlist', async () => {
    const body = managedBody('pb-untrusted-create');
    const runner = createRunner([
      success({ number: 91 }),
      success({
        number: 91,
        body,
        author_association: 'MEMBER',
        user: { login: 'collaborator-attacker' },
      }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    await expect(client.createIssue({
      beadId: 'pb-untrusted-create',
      title: '[pb-untrusted-create] Verify actor',
      body,
    })).rejects.toThrow(/created issue.*actor|trusted issue author|ownership/i);
    expect(runner.calls[1]?.args).toContain(`repos/${owner}/${repo}/issues/91`);
  });

  it('adds one project item and batches each requested field set into one GraphQL invocation', async () => {
    const project = {
      id: projectNodeId,
      number: 14,
      title: 'Public Beads',
      readme: boundProjectReadmeMarker,
      public: true,
      url: 'https://github.com/orgs/OpenCoven/projects/14',
    };
    const runner = createRunner([
      projectDiscovery([project]),
      projectItemsPage([]),
      success({ id: 'ITEM-42' }),
      success({}),
      success({}),
      success({}),
      success({}),
      success({}),
      success({}),
      success({}),
      success({}),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });
    await client.discoverProject();
    client.setFieldContext(new Map([
      ['Status', { id: 'F-status', name: 'Status', dataType: 'SINGLE_SELECT', options: new Map([['Blocked', 'O-blocked']]) }],
      ['Priority', { id: 'F-priority', name: 'Priority', dataType: 'SINGLE_SELECT', options: new Map([['P1', 'O-p1']]) }],
      ['Bead Type', { id: 'F-type', name: 'Bead Type', dataType: 'SINGLE_SELECT', options: new Map([['Feature', 'O-feature']]) }],
      ['Bead ID', { id: 'F-id', name: 'Bead ID', dataType: 'TEXT', options: new Map() }],
      ['Parent Goal', { id: 'F-parent', name: 'Parent Goal', dataType: 'TEXT', options: new Map() }],
      ['Source Updated', { id: 'F-updated', name: 'Source Updated', dataType: 'DATE', options: new Map() }],
    ]));

    await expect(client.ensureProjectItem({ issueNumber: 42 })).resolves.toEqual({ id: 'ITEM-42' });
    await client.setFields({
      itemId: 'ITEM-42',
      fields: {
        beadId: 'pb-42',
        status: 'open',
        priority: 1,
        type: 'feature',
        blocked: true,
        parentGoal: 'Public launch',
        sourceUpdated: '2026-08-22T12:30:00Z',
      },
    });
    await client.setFields({
      itemId: 'ITEM-42',
      fields: {
        parentGoal: null,
        sourceUpdated: '2026-08-23',
      },
    });

    expect(runner.calls[2]).toEqual({
      command: 'gh',
      args: [
        'project',
        'item-add',
        '14',
        '--owner',
        owner,
        '--url',
        `https://github.com/${owner}/${repo}/issues/42`,
        '--format',
        'json',
      ],
      options: { env: { GH_TOKEN: token } },
    });
    const fieldUpdates = runner.calls.slice(3);
    expect(fieldUpdates).toHaveLength(2);
    for (const call of fieldUpdates) {
      expect(call.args).toEqual(['api', 'graphql', '--include', '--input', '-']);
      expect(parseStdin(call).query).toMatch(/mutation UpdateManagedProjectItemFields/u);
    }
    expect(parseStdin(fieldUpdates[0]!)).toMatchObject({
      variables: {
        projectId: projectNodeId,
        itemId: 'ITEM-42',
        fieldId0: 'F-id',
        value0: 'pb-42',
        fieldId1: 'F-status',
        value1: 'O-blocked',
        fieldId2: 'F-priority',
        value2: 'O-p1',
        fieldId3: 'F-type',
        value3: 'O-feature',
        fieldId4: 'F-parent',
        value4: 'Public launch',
        fieldId5: 'F-updated',
        value5: '2026-08-22',
      },
    });
    expect(parseStdin(fieldUpdates[1]!)).toMatchObject({
      variables: {
        projectId: projectNodeId,
        itemId: 'ITEM-42',
        fieldId0: 'F-parent',
        fieldId1: 'F-updated',
        value1: '2026-08-23',
      },
    });
  });

  it('bounds GraphQL-backed invocations across end-to-end item reconciliation', async () => {
    const calls: RunCall[] = [];
    let addedItemCount = 0;
    const run: GhRun = async (command, args, options) => {
      const call = { command, args: [...args], options: { ...options } };
      calls.push(call);
      if (args[0] === 'project' && args[1] === 'item-add') {
        addedItemCount += 1;
        return success({ id: `ITEM-${addedItemCount}` });
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        return success({});
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = String(parseStdin(call).query ?? '');
        if (query.includes('query DiscoverManagedProject')) {
          return projectDiscovery([{
            id: projectNodeId,
            number: 25,
            title: 'Public Beads',
            readme: boundProjectReadmeMarker,
            public: true,
          }]);
        }
        if (query.includes('query DiscoverManagedProjectItems')) {
          return projectItemsPage([]);
        }
        if (query.includes('mutation UpdateManagedProjectItemFields')) {
          return success({ data: {} });
        }
      }
      throw new Error(`Unexpected runner call ${command} ${args.join(' ')}`);
    };
    const client = createGhClient({ run, owner, repo, token, projectNodeId });
    await client.discoverProject();
    client.setFieldContext(new Map([
      ['Status', { id: 'F-status', name: 'Status', dataType: 'SINGLE_SELECT', options: new Map([['Backlog', 'O-backlog']]) }],
      ['Priority', { id: 'F-priority', name: 'Priority', dataType: 'SINGLE_SELECT', options: new Map([['P1', 'O-p1']]) }],
      ['Bead Type', { id: 'F-type', name: 'Bead Type', dataType: 'SINGLE_SELECT', options: new Map([['Task', 'O-task']]) }],
      ['Bead ID', { id: 'F-id', name: 'Bead ID', dataType: 'TEXT', options: new Map() }],
      ['Parent Goal', { id: 'F-parent', name: 'Parent Goal', dataType: 'TEXT', options: new Map() }],
      ['Source Updated', { id: 'F-updated', name: 'Source Updated', dataType: 'DATE', options: new Map() }],
    ]));
    const fields = {
      beadId: 'pb-placeholder',
      status: 'open',
      priority: 1,
      type: 'task',
      parentGoal: null,
      sourceUpdated: '2026-08-24T00:00:00Z',
    };

    const operationCounts = {
      createIssue: 0,
      updateIssue: 0,
      labelIssue: 0,
      closeIssue: 0,
      ensureProjectItem: 2,
      restoreItem: 0,
      setFields: 2,
      syncParent: 0,
      syncBlocker: 0,
      archiveItem: 0,
      updateReadme: 0,
    };
    const plan: ReconciliationPlan = {
      inventory: [],
      renderContext: {
        repositoryIdentity,
        sourceRepositoryUrl: `https://github.com/${repositoryIdentity}`,
      },
      managedIssuesByBeadId: new Map(),
      summary: {
        sourceTotal: 0,
        sourceActive: 0,
        sourceClosed: 0,
        managedTotal: 0,
        managedOpenCount: 0,
        defaultMaxCloseCount: 5,
        createIssueCount: 0,
        updateIssueCount: 0,
        labelIssueCount: 0,
        closeIssueCount: 0,
        ensureProjectItemCount: 2,
        restoreItemCount: 0,
        setFieldsCount: 2,
        syncParentCount: 0,
        syncBlockerCount: 0,
        archiveItemCount: 0,
        updateReadmeCount: 0,
        visibilityDrift: false,
        operationCounts,
        closureCandidates: [],
      },
      operations: [
        {
          type: 'ensureProjectItem',
          phase: 'ensureProjectItems',
          beadId: 'pb-one',
          issueNumber: 101,
        },
        {
          type: 'ensureProjectItem',
          phase: 'ensureProjectItems',
          beadId: 'pb-two',
          issueNumber: 102,
        },
        {
          type: 'setFields',
          phase: 'setFields',
          beadId: 'pb-one',
          fields: { ...fields, beadId: 'pb-one' },
        },
        {
          type: 'setFields',
          phase: 'setFields',
          beadId: 'pb-two',
          fields: { ...fields, beadId: 'pb-two' },
        },
      ],
    };

    await applyReconciliation(plan, client);

    const graphqlBackedCalls = calls.filter((call) =>
      call.args[0] === 'project'
      || (call.args[0] === 'api' && call.args[1] === 'graphql')
    );
    expect(graphqlBackedCalls).toHaveLength(6);
    expect(graphqlBackedCalls.filter((call) =>
      String(call.options.stdin ?? '').includes('query DiscoverManagedProjectItems')
    )).toHaveLength(1);
    expect(graphqlBackedCalls.filter((call) =>
      String(call.options.stdin ?? '').includes('mutation UpdateManagedProjectItemFields')
    )).toHaveLength(2);
  });

  it('re-reads a Project item by issue identity after an applied-then-5xx add', async () => {
    const transient = Object.assign(new Error('HTTP 503 item response lost'), { status: 503 });
    const issueUrl = `https://github.com/${owner}/${repo}/issues/42`;
    const runner = createRunner([
      projectDiscovery([{
        id: projectNodeId,
        number: 21,
        title: 'Public Beads',
        readme: boundProjectReadmeMarker,
        public: true,
      }]),
      projectItemsPage([]),
      transient,
      projectItemsPage([{
        id: 'ITEM-applied',
        isArchived: false,
        content: { id: 'ISSUE-42', url: issueUrl },
        fieldValues: { nodes: [] },
      }]),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });
    await client.discoverProject();

    await expect(client.ensureProjectItem({ issueNumber: 42 })).resolves.toEqual({
      id: 'ITEM-applied',
    });
    expect(runner.calls.filter((call) => call.args[0] === 'project'
      && call.args[1] === 'item-add')).toHaveLength(1);
  });

  it('sends one batched field mutation and stops after its first failure', async () => {
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let activeEdits = 0;
    let maxActiveEdits = 0;
    const failed = Object.assign(new Error('HTTP 422 invalid field value'), { status: 422 });
    const runner = createRunner([
      projectDiscovery([{
        id: projectNodeId,
        number: 17,
        title: 'Public Beads',
        readme: boundProjectReadmeMarker,
        public: true,
      }]),
      async () => {
        activeEdits += 1;
        maxActiveEdits = Math.max(maxActiveEdits, activeEdits);
        firstStarted?.();
        await firstGate;
        activeEdits -= 1;
        throw failed;
      },
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });
    await client.discoverProject();
    client.setFieldContext(new Map([
      ['Status', { id: 'F-status', name: 'Status', dataType: 'SINGLE_SELECT', options: new Map([['Backlog', 'O-backlog']]) }],
      ['Priority', { id: 'F-priority', name: 'Priority', dataType: 'SINGLE_SELECT', options: new Map([['P1', 'O-p1']]) }],
      ['Bead ID', { id: 'F-id', name: 'Bead ID', dataType: 'TEXT', options: new Map() }],
    ]));

    const settingFields = client.setFields({
      itemId: 'ITEM-sequential',
      fields: {
        beadId: 'pb-sequential',
        status: 'open',
        priority: 1,
      },
    });
    await started;
    const callsBeforeFailure = runner.calls.length;
    releaseFirst?.();

    await expect(settingFields).rejects.toThrow(/invalid field value/i);
    expect(callsBeforeFailure).toBe(2);
    expect(runner.calls).toHaveLength(2);
    expect(maxActiveEdits).toBe(1);
  });

  it('adds/removes sub-issue and blocked-by relationships with database IDs', async () => {
    const runner = createRunner([
      success({}),
      success({}),
      success({}),
      success({}),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    await client.addSubIssue({ parentIssueNumber: 10, subIssueId: 2001 });
    await client.removeSubIssue({ parentIssueNumber: 10, subIssueId: 2001 });
    await client.addBlockedBy({ issueNumber: 20, blockerIssueId: 3001 });
    await client.removeBlockedBy({ issueNumber: 20, blockerIssueId: 3001 });

    expect(runner.calls.map((call) => call.args)).toEqual([
      ['api', `repos/${owner}/${repo}/issues/10/sub_issues`, '--method', 'POST', ...apiHeaders, '--input', '-'],
      ['api', `repos/${owner}/${repo}/issues/10/sub_issue`, '--method', 'DELETE', ...apiHeaders, '--input', '-'],
      ['api', `repos/${owner}/${repo}/issues/20/dependencies/blocked_by`, '--method', 'POST', ...apiHeaders, '--input', '-'],
      ['api', `repos/${owner}/${repo}/issues/20/dependencies/blocked_by/3001`, '--method', 'DELETE', ...apiHeaders],
    ]);
    expect(parseStdin(runner.calls[0]!)).toEqual({ sub_issue_id: 2001 });
    expect(parseStdin(runner.calls[1]!)).toEqual({ sub_issue_id: 2001 });
    expect(parseStdin(runner.calls[2]!)).toEqual({ issue_id: 3001 });
  });

  it('re-reads relationships after applied-then-5xx adds without repeating POST requests', async () => {
    const transientSubIssue = Object.assign(new Error('HTTP 503 sub-issue response lost'), { status: 503 });
    const transientBlocker = Object.assign(new Error('HTTP 503 blocker response lost'), { status: 503 });
    const runner = createRunner([
      transientSubIssue,
      success([{ id: 2001, number: 2 }]),
      transientBlocker,
      success([{ id: 3001, number: 3 }]),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    await expect(client.addSubIssue({
      parentIssueNumber: 10,
      subIssueId: 2001,
    })).resolves.toMatchObject({ id: 2001 });
    await expect(client.addBlockedBy({
      issueNumber: 20,
      blockerIssueId: 3001,
    })).resolves.toMatchObject({ id: 3001 });

    expect(runner.calls.filter((call) => call.args.includes('POST'))).toHaveLength(2);
    expect(runner.calls.map((call) => call.args[1])).toEqual([
      `repos/${owner}/${repo}/issues/10/sub_issues`,
      `repos/${owner}/${repo}/issues/10/sub_issues?per_page=100&page=1`,
      `repos/${owner}/${repo}/issues/20/dependencies/blocked_by`,
      `repos/${owner}/${repo}/issues/20/dependencies/blocked_by?per_page=100&page=1`,
    ]);
  });

  it.each([
    {
      name: 'sub-issue',
      invoke: (client: ReturnType<typeof createGhClient>) => client.removeSubIssue({
        parentIssueNumber: 10,
        subIssueId: 2001,
        parentRepository: 'OpenCoven/parent-repo',
      }),
      deleteEndpoint: 'repos/OpenCoven/parent-repo/issues/10/sub_issue',
      readEndpoint: 'repos/OpenCoven/parent-repo/issues/10/sub_issues?per_page=100&page=1',
    },
    {
      name: 'blocked-by',
      invoke: (client: ReturnType<typeof createGhClient>) => client.removeBlockedBy({
        issueNumber: 20,
        blockerIssueId: 3001,
      }),
      deleteEndpoint: `repos/${owner}/${repo}/issues/20/dependencies/blocked_by/3001`,
      readEndpoint:
        `repos/${owner}/${repo}/issues/20/dependencies/blocked_by?per_page=100&page=1`,
    },
  ])('confirms an applied $name delete after a transport failure', async ({
    invoke,
    deleteEndpoint,
    readEndpoint,
  }) => {
    const transportFailure = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const runner = createRunner([transportFailure, success([])]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    await expect(invoke(client)).resolves.toBeNull();
    expect(runner.calls.map((call) => call.args[1])).toEqual([
      deleteEndpoint,
      readEndpoint,
    ]);
    expect(runner.calls.filter((call) => call.args.includes('DELETE'))).toHaveLength(1);
  });

  it.each([
    {
      name: 'sub-issue',
      invoke: (client: ReturnType<typeof createGhClient>) => client.removeSubIssue({
        parentIssueNumber: 10,
        subIssueId: 2001,
        parentRepository: 'OpenCoven/parent-repo',
      }),
      relationship: { id: 2001, node_id: 'ISSUE-child', number: 2 },
    },
    {
      name: 'blocked-by',
      invoke: (client: ReturnType<typeof createGhClient>) => client.removeBlockedBy({
        issueNumber: 20,
        blockerIssueId: 3001,
      }),
      relationship: { id: 3001, node_id: 'ISSUE-blocker', number: 3 },
    },
  ])('surfaces ambiguity when a failed $name delete leaves the relationship present', async ({
    invoke,
    relationship,
  }) => {
    const transient = Object.assign(new Error('HTTP 503 delete response lost'), { status: 503 });
    const runner = createRunner([transient, success([relationship])]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    await expect(invoke(client)).rejects.toMatchObject({
      kind: 'ambiguous',
      status: 503,
    });
    expect(runner.calls.filter((call) => call.args.includes('DELETE'))).toHaveLength(1);
  });

  it.each([
    (client: ReturnType<typeof createGhClient>) => client.removeSubIssue({
      parentIssueNumber: 10,
      subIssueId: 2001,
    }),
    (client: ReturnType<typeof createGhClient>) => client.removeBlockedBy({
      issueNumber: 20,
      blockerIssueId: 3001,
    }),
  ])('treats a missing relationship delete as idempotent success', async (invoke) => {
    const runner = createRunner([httpError(404, 'Not Found')]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    await expect(invoke(client)).resolves.toBeNull();
    expect(runner.calls).toHaveLength(1);
  });

  it('maps reconciliation parent/blocker operations and archive/restore names directly', async () => {
    const project = {
      id: projectNodeId,
      number: 15,
      title: 'Public Beads',
      readme: boundProjectReadmeMarker,
      public: true,
    };
    const runner = createRunner([
      projectDiscovery([project]),
      success({ id: 1002 }),
      success({}),
      success({}),
      success({ id: 1003 }),
      success({}),
      success({ id: 1004 }),
      success({}),
      success({}),
      success({}),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });
    await client.discoverProject();

    await client.syncParent({
      issueNumber: 2,
      parentIssueNumber: 11,
      currentParentIssueNumber: 10,
    });
    await client.syncBlocker({
      issueNumber: 2,
      blockerIssueNumbers: [4],
      currentBlockerIssueNumbers: [3],
    });
    await client.archiveItem({ itemId: 'ITEM-2' });
    await client.restoreItem({ itemId: 'ITEM-2' });

    expect(runner.calls.at(-2)?.args).toEqual([
      'project',
      'item-archive',
      '15',
      '--owner',
      owner,
      '--id',
      'ITEM-2',
    ]);
    expect(runner.calls.at(-1)?.args).toEqual([
      'project',
      'item-archive',
      '15',
      '--owner',
      owner,
      '--id',
      'ITEM-2',
      '--undo',
    ]);
    expect(runner.calls.some((call) => call.args.some((arg) => arg.endsWith('/sub_issue')))).toBe(true);
    expect(runner.calls.some((call) => call.args.some((arg) => arg.endsWith('/sub_issues')))).toBe(true);
    expect(runner.calls.some((call) => call.args.some((arg) => arg.includes('dependencies/blocked_by')))).toBe(true);
  });

  it('uses preserved repository and database identity for foreign parent and blocker cleanup', async () => {
    const runner = createRunner([
      success({ id: 1002 }),
      success({}),
      success({}),
      success({}),
      success({ id: 1004 }),
      success({}),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    await client.syncParent({
      issueNumber: 2,
      parentIssueNumber: 10,
      currentParentIssueNumber: null,
      currentParentIssue: {
        id: 9010,
        nodeId: 'FOREIGN-PARENT',
        number: 10,
        repository: 'OtherOrg/other-repo',
      },
    });
    await client.syncBlocker({
      issueNumber: 2,
      blockerIssueNumbers: [4],
      currentBlockerIssueNumbers: [4],
      currentBlockerIssues: [{
        id: 9004,
        nodeId: 'FOREIGN-BLOCKER',
        number: 4,
        repository: 'OtherOrg/other-repo',
      }],
    });

    expect(runner.calls.map((call) => call.args[1])).toEqual([
      `repos/${owner}/${repo}/issues/2`,
      'repos/OtherOrg/other-repo/issues/10/sub_issue',
      `repos/${owner}/${repo}/issues/10/sub_issues`,
      `repos/${owner}/${repo}/issues/2/dependencies/blocked_by/9004`,
      `repos/${owner}/${repo}/issues/4`,
      `repos/${owner}/${repo}/issues/2/dependencies/blocked_by`,
    ]);
  });

  it('retries only rate limits and transient server failures with bounded attempts', async () => {
    const transient = Object.assign(new Error('HTTP 503 service unavailable'), { status: 503 });
    const rateLimit = Object.assign(new Error('HTTP 403 API rate limit exceeded'), { status: 403 });
    const runner = createRunner([
      transient,
      transient,
      success(''),
      rateLimit,
      success({ id: 1 }),
      success({ id: 2 }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    await client.verifyAccess();

    expect(runner.calls.filter((call) => call.args[0] === 'auth')).toHaveLength(3);
    expect(runner.calls.filter((call) => call.args.includes(`repos/${owner}/${repo}`))).toHaveLength(2);

    const validation = Object.assign(new Error('HTTP 422 validation failed'), { status: 422 });
    const noRetryRunner = createRunner([validation]);
    await expect(
      createGhClient({ run: noRetryRunner.run, owner, repo, token }).createIssue({
        title: 'invalid',
        body: managedBody('pb-invalid'),
      }),
    ).rejects.toThrow(/validation failed/i);
    expect(noRetryRunner.calls).toHaveLength(1);

    const permission = Object.assign(new Error('HTTP 403 resource not accessible'), { status: 403 });
    const permissionRunner = createRunner([permission]);
    await expect(
      createGhClient({ run: permissionRunner.run, owner, repo, token }).verifyAccess(),
    ).rejects.toThrow(/resource not accessible/i);
    expect(permissionRunner.calls).toHaveLength(1);
  });

  it('honors Retry-After and X-RateLimit-Reset metadata with injected bounded waits', async () => {
    const waits: number[] = [];
    const retryAfter = Object.assign(new Error('HTTP 429 slow down'), {
      status: 429,
      headers: { 'Retry-After': '2' },
    });
    const rateLimitReset = Object.assign(new Error('HTTP 403 API rate limit exceeded'), {
      status: 403,
      headers: { 'X-RateLimit-Reset': '13' },
    });
    const runner = createRunner([
      retryAfter,
      success(''),
      rateLimitReset,
      success({ id: 1 }),
      success({ id: 2 }),
    ]);
    const client = createGhClient({
      run: runner.run,
      owner,
      repo,
      token,
      bootstrap: true,
      now: () => 10_000,
      maxRetryWaitMs: 2_500,
      sleep(milliseconds) {
        waits.push(milliseconds);
      },
    });

    await client.verifyAccess();

    expect(waits).toEqual([2_000, 2_500]);
  });

  it('retries rate-limited ambiguous creates without rereading because rejection is definite', async () => {
    const waits: number[] = [];
    const body = managedBody('pb-rate-limited-create');
    const rateLimit = Object.assign(new Error('HTTP 429 slow down'), {
      status: 429,
      headers: { 'Retry-After': '2' },
    });
    const runner = createRunner([
      rateLimit,
      success({ number: 88 }),
      success(trustedIssue({ number: 88, body })),
    ]);
    const client = createGhClient({
      run: runner.run,
      owner,
      repo,
      token,
      sleep(milliseconds) {
        waits.push(milliseconds);
      },
    });

    await expect(client.createIssue({
      beadId: 'pb-rate-limited-create',
      title: '[pb-rate-limited-create] Retry safely',
      body,
    })).resolves.toMatchObject({ number: 88 });
    expect(waits).toEqual([2_000]);
    expect(runner.calls.filter((call) =>
      call.args.includes('--method') && call.args.includes('POST')
    )).toHaveLength(2);
    expect(runner.calls.some((call) =>
      call.args.includes(`repos/${owner}/${repo}/issues?state=all&per_page=100&page=1`)
    )).toBe(false);
  });

  it('retries GraphQL creates after rate-limit rejection without a discovery reread', async () => {
    const waits: number[] = [];
    const readme = `${boundProjectReadmeMarker}\n# Public Beads`;
    const rateLimit = Object.assign(new Error('HTTP 403 API rate limit exceeded'), {
      status: 403,
      headers: { 'X-RateLimit-Reset': '13' },
    });
    const runner = createRunner([
      projectDiscovery([]),
      rateLimit,
      success({ data: { createProjectV2: { projectV2: {
        id: 'P-rate-retry',
        number: 31,
        title: 'Public Beads',
        readme,
        public: true,
      } } } }),
      linkedRepositoriesPage([{ id: 'REPO_node' }]),
    ]);
    const client = createGhClient({
      run: runner.run,
      owner,
      repo,
      token,
      bootstrap: true,
      now: () => 10_000,
      sleep(milliseconds) {
        waits.push(milliseconds);
      },
    });

    await expect(client.ensureProject({ title: 'Public Beads', readme })).resolves.toMatchObject({
      id: 'P-rate-retry',
    });
    expect(waits).toEqual([3_000]);
    expect(runner.calls.filter((call) =>
      String(parseStdin(call).query ?? '').includes('mutation CreateManagedProject')
    )).toHaveLength(2);
    expect(runner.calls.filter((call) =>
      String(parseStdin(call).query ?? '').includes('query DiscoverManagedProject')
    )).toHaveLength(1);
  });

  it('serializes two lock contenders with atomic ref creation', async () => {
    const calls: RunCall[] = [];
    const commits = new Map<string, Record<string, unknown>>([
      ['main', { sha: 'BASE', tree: { sha: 'TREE' }, message: 'base' }],
    ]);
    let lockSha: string | null = null;
    let nextCommit = 0;
    const run: GhRun = async (command, args, options) => {
      const call = { command, args: [...args], options: { ...options } };
      calls.push(call);
      const endpoint = args[1];
      const methodIndex = args.indexOf('--method');
      const method = methodIndex === -1 ? 'GET' : args[methodIndex + 1];
      if (endpoint === `repos/${owner}/${repo}/git/ref/tags/psyche-beads-project-sync-lock`) {
        if (lockSha == null) {
          throw httpError(404, 'not found');
        }
        return success({ object: { sha: lockSha } });
      }
      if (endpoint?.startsWith(`repos/${owner}/${repo}/git/commits/`) && method === 'GET') {
        const sha = endpoint.split('/').at(-1) ?? '';
        return success(commits.get(sha));
      }
      if (endpoint === `repos/${owner}/${repo}/git/commits` && method === 'POST') {
        const body = parseStdin(call);
        const sha = `LOCK-${++nextCommit}`;
        commits.set(sha, { sha, ...body, tree: { sha: body.tree } });
        return success({ sha, tree: { sha: body.tree } });
      }
      if (endpoint === `repos/${owner}/${repo}/git/refs` && method === 'POST') {
        if (lockSha != null) {
          throw httpError(422, 'Reference already exists');
        }
        lockSha = String(parseStdin(call).sha);
        return success({ object: { sha: lockSha } });
      }
      throw new Error(`Unexpected runner call ${command} ${args.join(' ')}`);
    };
    const first = createGhClient({ run, owner, repo, token });
    const second = createGhClient({ run, owner, repo, token });

    const results = await Promise.allSettled([
      first.acquireApplyLock({
        owner: 'local-cli',
        runId: 'run-1',
        leaseId: 'lease-1',
        ttlMs: 60_000,
      }),
      second.acquireApplyLock({
        owner: 'github-actions',
        runId: 'run-2',
        leaseId: 'lease-2',
        ttlMs: 60_000,
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(String(
      (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    )).toMatch(/lock.*held|contention/i);
    expect(calls.filter((call) => call.args.includes('POST')
      && call.args.includes(`repos/${owner}/${repo}/git/refs`))).toHaveLength(2);
  });

  it('takes over an expired lock with a non-forced fast-forward and releases only its owner', async () => {
    const acquiredMessage = `psyche-beads-project-lock:v1 ${JSON.stringify({
      version: 1,
      state: 'acquired',
      owner: 'local-cli',
      runId: 'new-run',
      leaseId: 'new-lease',
      acquiredAt: 10_000,
      expiresAt: 70_000,
    })}`;
    const runner = createRunner([
      success({ object: { sha: 'LOCK-old' } }),
      success({ sha: 'LOCK-old', tree: { sha: 'TREE' }, message:
        `psyche-beads-project-lock:v1 ${JSON.stringify({
          version: 1,
          state: 'acquired',
          owner: 'github-actions',
          runId: 'old-run',
          leaseId: 'old-lease',
          acquiredAt: 1_000,
          expiresAt: 2_000,
        })}` }),
      success({ sha: 'LOCK-new', tree: { sha: 'TREE' } }),
      success({ object: { sha: 'LOCK-new' } }),
      success({ object: { sha: 'LOCK-new' } }),
      success({ sha: 'LOCK-new', tree: { sha: 'TREE' }, message: acquiredMessage }),
      success({ object: { sha: 'LOCK-new' } }),
      success({ sha: 'LOCK-new', tree: { sha: 'TREE' }, message: acquiredMessage }),
      success({ sha: 'LOCK-released', tree: { sha: 'TREE' } }),
      success({ object: { sha: 'LOCK-released' } }),
    ]);
    const client = createGhClient({
      run: runner.run,
      owner,
      repo,
      token,
      projectNodeId,
      now: () => 10_000,
    });

    const handle = await client.acquireApplyLock({
      owner: 'local-cli',
      runId: 'new-run',
      leaseId: 'new-lease',
      ttlMs: 60_000,
    });
    await expect(client.releaseApplyLock({
      ...handle,
      leaseId: 'not-the-owner',
    })).rejects.toThrow(/ownership/i);
    await expect(client.releaseApplyLock(handle)).resolves.toBeUndefined();

    const updates = runner.calls.filter((call) =>
      call.args.includes(`repos/${owner}/${repo}/git/refs/tags/psyche-beads-project-sync-lock`)
      && call.args.includes('PATCH')
    );
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(parseStdin(update)).toMatchObject({ force: false });
    }
  });

  it('renews a long apply, blocks a contender, releases the renewed lease, and stops heartbeats', async () => {
    const backend = createApplyLockBackend();
    const timers = createTimerHarness();
    let currentTime = 1_000;
    const first = createGhClient({
      run: backend.run,
      owner,
      repo,
      token,
      now: () => currentTime,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const handle = await first.acquireApplyLock({
      owner: 'local-cli',
      runId: 'long-run',
      leaseId: 'long-lease',
      ttlMs: 90,
    });
    const lease = first.startApplyLockLease(handle);

    expect(timers.timers).toHaveLength(1);
    expect(timers.timers[0]?.milliseconds).toBe(30);
    expect(timers.timers[0]?.unref).toHaveBeenCalledOnce();

    currentTime = 1_031;
    timers.timers[0]?.callback();
    await expect(lease.assertOwned()).resolves.toBeUndefined();
    expect(backend.currentState().expiresAt).toBe(1_121);

    currentTime = 1_100;
    const contender = createGhClient({
      run: backend.run,
      owner,
      repo,
      token,
      now: () => currentTime,
    });
    await expect(contender.acquireApplyLock({
      owner: 'github-actions',
      runId: 'contender-run',
      leaseId: 'contender-lease',
      ttlMs: 90,
    })).rejects.toThrow(/lock is held/i);

    await expect(lease.release()).resolves.toBeUndefined();
    expect(backend.currentState()).toMatchObject({
      state: 'released',
      owner: 'local-cli',
      runId: 'long-run',
      leaseId: 'long-lease',
    });
    expect(timers.timers.at(-1)?.cleared).toBe(true);

    const callCountAfterRelease = backend.calls.length;
    for (const timer of timers.timers) {
      timer.callback();
    }
    await Promise.resolve();
    expect(backend.calls).toHaveLength(callCountAfterRelease);
  });

  it('makes renewal transport failure terminal before the next reconciliation mutation', async () => {
    const backend = createApplyLockBackend();
    let currentTime = 2_000;
    const client = createGhClient({
      run: backend.run,
      owner,
      repo,
      token,
      now: () => currentTime,
    });
    const handle = await client.acquireApplyLock({
      owner: 'local-cli',
      runId: 'transport-run',
      leaseId: 'transport-lease',
      ttlMs: 90,
    });
    const lease = client.startApplyLockLease(handle);
    backend.failNextCommit(
      Object.assign(new Error(`socket reset while using ${token}`), { code: 'ECONNRESET' }),
    );
    currentTime = 2_031;

    await expect(lease.renewNow()).rejects.toThrow(/lease.*lost/i);

    const bead: PublicBead = {
      id: 'pb-lease-guard',
      title: 'Guard the next mutation',
      description: null,
      design: null,
      specId: null,
      acceptanceCriteria: null,
      notes: null,
      status: 'open',
      priority: 1,
      type: 'task',
      blocked: false,
      labels: [],
      parentId: null,
      blockedByIds: [],
      githubAssignee: null,
      createdAt: '2026-08-24T00:00:00Z',
      updatedAt: '2026-08-24T00:00:00Z',
      closedAt: null,
    };
    const plan = planReconciliation({
      inventory: [bead],
      existingIssues: [],
      readme: null,
      renderContext: {
        repositoryIdentity,
        sourceRepositoryUrl: `https://github.com/${repositoryIdentity}`,
      },
    });
    const callsBeforeApply = backend.calls.length;

    let applyFailure: unknown;
    try {
      await applyReconciliation(plan, client);
    } catch (error) {
      applyFailure = error;
    }
    expect(applyFailure).toBeInstanceOf(Error);
    expect(String((applyFailure as { cause?: unknown }).cause)).toMatch(/lease.*lost/i);
    expect(backend.calls.slice(callsBeforeApply).some((call) =>
      call.args.includes(`repos/${owner}/${repo}/issues`)
    )).toBe(false);
    expect(String(await lease.failure())).not.toContain(token);

    await expect(lease.release()).resolves.toBeUndefined();
  });

  it('serializes ownership revalidation with a heartbeat that becomes due mid-read', async () => {
    const backend = createApplyLockBackend();
    const timers = createTimerHarness();
    let currentTime = 2_500;
    const client = createGhClient({
      run: backend.run,
      owner,
      repo,
      token,
      now: () => currentTime,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const handle = await client.acquireApplyLock({
      owner: 'local-cli',
      runId: 'serialized-run',
      leaseId: 'serialized-lease',
      ttlMs: 90,
    });
    const lease = client.startApplyLockLease(handle);
    currentTime = 2_531;
    backend.onNextRefRead(() => {
      timers.timers[0]?.callback();
    });

    await expect(lease.assertOwned()).resolves.toBeUndefined();
    await expect(lease.renewNow()).resolves.toMatchObject({
      leaseId: 'serialized-lease',
    });
    expect(lease.failure()).toBeNull();
    expect(backend.maxConcurrentRefReads()).toBe(1);
    expect(backend.currentState()).toMatchObject({
      state: 'acquired',
      leaseId: 'serialized-lease',
      expiresAt: 2_621,
    });
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it('keeps the renewal deadline fixed across ownership revalidations', async () => {
    const backend = createApplyLockBackend();
    const timers = createTimerHarness();
    let currentTime = 4_000;
    const client = createGhClient({
      run: backend.run,
      owner,
      repo,
      token,
      now: () => currentTime,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const handle = await client.acquireApplyLock({
      owner: 'local-cli',
      runId: 'deadline-run',
      leaseId: 'deadline-lease',
      ttlMs: 90,
    });
    const lease = client.startApplyLockLease(handle);
    expect(timers.timers.at(-1)?.milliseconds).toBe(30);

    currentTime = 4_010;
    await lease.assertOwned();

    expect(timers.timers.at(-1)?.milliseconds).toBe(20);
    await lease.release();
  });

  it('detects a stolen ref before mutation and refuses to release the contender lease', async () => {
    const backend = createApplyLockBackend();
    const client = createGhClient({
      run: backend.run,
      owner,
      repo,
      token,
      now: () => 3_000,
    });
    const handle = await client.acquireApplyLock({
      owner: 'local-cli',
      runId: 'stolen-run',
      leaseId: 'stolen-lease',
      ttlMs: 90,
    });
    const lease = client.startApplyLockLease(handle);
    backend.stealLock({
      owner: 'github-actions',
      runId: 'other-run',
      leaseId: 'other-lease',
      acquiredAt: 3_001,
      expiresAt: 4_000,
    });

    await expect(lease.assertOwned()).rejects.toThrow(/lease.*lost|ownership/i);
    await expect(lease.release()).rejects.toThrow(/ownership/i);
    expect(backend.currentState()).toMatchObject({
      state: 'acquired',
      leaseId: 'other-lease',
    });
  });

  it('reports the fine-grained Contents permission contract on lock preflight 403s', async () => {
    const runner = createRunner([
      Object.assign(new Error(`HTTP 403 resource not accessible by ${token}`), { status: 403 }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });

    let thrown: unknown;
    try {
      await client.acquireApplyLock({
        owner: 'local-cli',
        runId: 'permission-run',
        leaseId: 'permission-lease',
      });
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).toMatch(/BEADS_PROJECT_TOKEN/i);
    expect(String(thrown)).toMatch(/Contents:\s*read and write/i);
    expect(String(thrown)).toMatch(/Issues:\s*read and write/i);
    expect(String(thrown)).toMatch(/Metadata:\s*read/i);
    expect(String(thrown)).toMatch(/Projects:\s*read and write/i);
    expect(String(thrown)).not.toContain(token);
    expect(runner.calls).toHaveLength(1);
  });

  it('redacts tokens from lock API failures', async () => {
    const runner = createRunner([
      httpError(404, 'not found'),
      success({ sha: 'BASE', tree: { sha: 'TREE' }, message: 'base' }),
      Object.assign(new Error(`HTTP 422 invalid lock ${token}`), { status: 422 }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });

    let thrown: unknown;
    try {
      await client.acquireApplyLock({
        owner: 'local-cli',
        runId: 'run-redacted',
        leaseId: 'lease-redacted',
        ttlMs: 60_000,
      });
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toMatch(/invalid lock/i);
    expect(String(thrown)).not.toContain(token);
  });

  it('parses gh api response headers so production retries honor server timing', async () => {
    const waits: number[] = [];
    const runner = createRunner([
      success(''),
      {
        stdout: 'HTTP/2.0 429 Too Many Requests\r\nRetry-After: 3\r\n\r\n{"message":"slow down"}',
        stderr: 'HTTP 429 slow down',
        exitCode: 1,
      },
      {
        stdout: 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":1}',
        stderr: '',
        exitCode: 0,
      },
      success({ id: 2 }),
    ]);
    const client = createGhClient({
      run: runner.run,
      owner,
      repo,
      token,
      maxRetryWaitMs: 5_000,
      sleep(milliseconds) {
        waits.push(milliseconds);
      },
    });

    await expect(client.verifyAccess()).resolves.toEqual({
      repository: { id: 1 },
      organization: { id: 2 },
    });
    expect(waits).toEqual([3_000]);
  });

  it('uses rate-limit headers from GraphQL error responses', async () => {
    const waits: number[] = [];
    const runner = createRunner([
      {
        stdout: [
          'HTTP/2.0 200 OK',
          'X-RateLimit-Reset: 13',
          '',
          JSON.stringify({
            errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
          }),
        ].join('\r\n'),
        stderr: '',
        exitCode: 0,
      },
      projectDiscovery([]),
    ]);
    const client = createGhClient({
      run: runner.run,
      owner,
      repo,
      token,
      projectNodeId,
      now: () => 10_000,
      sleep(milliseconds) {
        waits.push(milliseconds);
      },
    });

    await expect(client.discoverProject()).resolves.toBeNull();
    expect(waits).toEqual([3_000]);
  });

  it('retries transport failures for safe reads and idempotent updates', async () => {
    const waits: number[] = [];
    const transport = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const runner = createRunner([
      transport(),
      success(''),
      transport(),
      success({ id: 1 }),
      success({ id: 2 }),
      transport(),
      success({ number: 42 }),
    ]);
    const client = createGhClient({
      run: runner.run,
      owner,
      repo,
      token,
      sleep(milliseconds) {
        waits.push(milliseconds);
      },
    });

    await client.verifyAccess();
    await client.updateIssue({
      issueNumber: 42,
      title: '[pb-42] Safe update',
      body: managedBody('pb-42'),
      state: 'open',
    });

    expect(runner.calls.filter((call) => call.args[0] === 'auth')).toHaveLength(2);
    expect(runner.calls.filter((call) => call.args.includes(`repos/${owner}/${repo}`))).toHaveLength(2);
    expect(runner.calls.filter((call) =>
      call.args.includes(`repos/${owner}/${repo}/issues/42`)
    )).toHaveLength(2);
    expect(waits).toEqual([25, 25, 25]);
  });

  it('recognizes gh CLI EOF output as a retryable transport failure', async () => {
    const runner = createRunner([
      {
        stdout: '',
        stderr: 'Post "https://api.github.com/graphql": EOF',
        exitCode: 1,
      },
      success([]),
    ]);
    const sleep = vi.fn(async () => {});
    const client = createGhClient({ run: runner.run, owner, repo, token, sleep });

    await expect(client.listRepositoryIssues()).resolves.toEqual([]);
    expect(runner.calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('re-reads issue identity after an applied-then-5xx create without repeating the POST', async () => {
    const transient = Object.assign(new Error('HTTP 503 response lost'), { status: 503 });
    const body = managedBody('pb-applied');
    const runner = createRunner([
      transient,
      success([trustedIssue({
        number: 77,
        node_id: 'ISSUE-77',
        title: '[pb-applied] Applied',
        body,
        state: 'open',
        html_url: `https://github.com/${owner}/${repo}/issues/77`,
      })]),
      success(trustedIssue({
        number: 77,
        body,
      })),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });

    await expect(client.createIssue({
      beadId: 'pb-applied',
      title: '[pb-applied] Applied',
      body,
    })).resolves.toMatchObject({ number: 77 });
    expect(runner.calls.filter((call) => call.args.includes('--method')
      && call.args.includes('POST'))).toHaveLength(1);
    expect(runner.calls[1]?.args).toContain(
      `repos/${owner}/${repo}/issues?state=all&per_page=100&page=1`,
    );
    expect(runner.calls[2]?.args).toContain(`repos/${owner}/${repo}/issues/77`);
  });

  it('re-reads issue identity after an applied-then-transport failure without repeating the POST', async () => {
    const transportFailure = Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' });
    const body = managedBody('pb-transport-applied');
    const runner = createRunner([
      transportFailure,
      success([trustedIssue({
        number: 78,
        node_id: 'ISSUE-78',
        title: '[pb-transport-applied] Applied',
        body,
        state: 'open',
        html_url: `https://github.com/${owner}/${repo}/issues/78`,
      })]),
      success(trustedIssue({
        number: 78,
        body,
      })),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    await expect(client.createIssue({
      beadId: 'pb-transport-applied',
      title: '[pb-transport-applied] Applied',
      body,
    })).resolves.toMatchObject({ number: 78 });
    expect(runner.calls.filter((call) => call.args.includes('--method')
      && call.args.includes('POST'))).toHaveLength(1);
    expect(runner.calls[1]?.args).toContain(
      `repos/${owner}/${repo}/issues?state=all&per_page=100&page=1`,
    );
    expect(runner.calls[2]?.args).toContain(`repos/${owner}/${repo}/issues/78`);
  });

  it.each([
    Object.assign(new Error('request failed'), { code: 'ECONNRESET' }),
    Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' }),
    new Error('ECONNRESET'),
    new Error('ETIMEDOUT'),
    new Error('socket hang up'),
    new Error('aborted'),
    Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
  ])('surfaces structured ambiguity when transport failure %s cannot be verified', async (failure) => {
    const runner = createRunner([failure, success([])]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    await expect(client.createIssue({
      beadId: 'pb-transport-unknown',
      title: '[pb-transport-unknown] Unknown',
      body: managedBody('pb-transport-unknown'),
    })).rejects.toMatchObject({
      kind: 'ambiguous',
      status: undefined,
    });
    expect(runner.calls).toHaveLength(2);
  });

  it('surfaces structured ambiguity when a retryable issue create cannot be verified', async () => {
    const transient = Object.assign(new Error('HTTP 503 response lost'), { status: 503 });
    const runner = createRunner([transient, success([])]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    await expect(client.createIssue({
      beadId: 'pb-unknown',
      title: '[pb-unknown] Unknown',
      body: managedBody('pb-unknown'),
    })).rejects.toMatchObject({
      kind: 'ambiguous',
      status: 503,
    });
    expect(runner.calls).toHaveLength(2);
  });

  it('surfaces GraphQL errors without exposing tokens or logging full records', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runner = createRunner([
      success({
        errors: [{
          type: 'FORBIDDEN',
          message: `permission denied for ${token}`,
          path: ['organization', 'projectsV2', 'nodes', 0],
          extensions: { record: { body: 'full private record' } },
        }],
      }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token, projectNodeId });

    let thrown: unknown;
    try {
      await client.discoverProject();
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toMatch(/permission denied/i);
    expect(String(thrown)).not.toContain(token);
    expect(String(thrown)).not.toContain('full private record');
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('redacts tokens from one-shot mutation failures', async () => {
    const failure = Object.assign(
      new Error(`HTTP 422 invalid dependency for ${token}`),
      { status: 422 },
    );
    const runner = createRunner([failure]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    let thrown: unknown;
    try {
      await client.removeBlockedBy({ issueNumber: 20, blockerIssueId: 3001 });
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toMatch(/invalid dependency/i);
    expect(String(thrown)).not.toContain(token);
  });
});
