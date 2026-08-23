import { describe, expect, it, vi } from 'vitest';

import {
  createGhClient,
  PROJECT_README_MARKER,
  PROJECT_VIEWS,
} from '../scripts/beads-project-sync/github.mjs';
import type {
  GhRun,
  GhRunOptions,
  GhRunResult,
} from '../scripts/beads-project-sync/github.mjs';
import type { ReconciliationAdapters } from '../scripts/beads-project-sync/reconcile.mjs';

const owner = 'OpenCoven';
const repo = 'psyche-build';
const token = 'github_pat_DO_NOT_LEAK';
const apiHeaders = [
  '-H',
  'Accept: application/vnd.github+json',
  '-H',
  'X-GitHub-Api-Version: 2026-03-10',
];

interface RunCall {
  command: string;
  args: readonly string[];
  options: GhRunOptions;
}

function success(value: unknown = {}): GhRunResult {
  return {
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: '',
    exitCode: 0,
  };
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

function projectDiscovery(projects: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return success({
    data: {
      organization: {
        id: 'ORG_node',
        projectsV2: {
          nodes: projects,
          pageInfo: { hasNextPage, endCursor },
        },
      },
      repository: { id: 'REPO_node' },
    },
  });
}

describe('createGhClient', () => {
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

  it('paginates all bead-labeled repository issues including closed issues and parses managed markers', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      body: managedBody(`pb-${index + 1}`),
      state: index === 0 ? 'closed' : 'open',
      assignees: index === 0 ? [{ login: 'octocat' }] : [],
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
        {
          number: 102,
          title: 'Managed final issue',
          body: managedBody('pb-102'),
          state: 'open',
          assignees: [],
        },
      ]),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    const issues = await client.listManagedIssues();

    expect(issues).toHaveLength(101);
    expect(issues[0]).toMatchObject({
      beadId: 'pb-1',
      number: 1,
      state: 'closed',
      assignee: 'octocat',
    });
    expect(issues.at(-1)).toMatchObject({ beadId: 'pb-102', number: 102 });
    expect(runner.calls.map((call) => call.args)).toEqual([
      [
        'api',
        `repos/${owner}/${repo}/issues?state=all&labels=bead&per_page=100&page=1`,
        '--method',
        'GET',
        ...apiHeaders,
      ],
      [
        'api',
        `repos/${owner}/${repo}/issues?state=all&labels=bead&per_page=100&page=2`,
        '--method',
        'GET',
        ...apiHeaders,
      ],
    ]);
  });

  it('rejects duplicate markers in one issue and duplicate managed bead IDs across issues', async () => {
    const duplicateInBody = createRunner([
      success([{
        number: 5,
        body: `${managedBody('pb-5')}\n<!-- psyche-bead-sync:v1 bead-id=pb-shadow -->`,
        state: 'open',
        title: 'duplicate',
      }]),
    ]);
    await expect(
      createGhClient({ run: duplicateInBody.run, owner, repo, token }).listManagedIssues(),
    ).rejects.toThrow(/issue #5.*duplicate managed markers/i);

    const duplicateAcrossIssues = createRunner([
      success([
        { number: 6, body: managedBody('pb-6'), state: 'open', title: 'first' },
        { number: 7, body: managedBody('pb-6'), state: 'open', title: 'second' },
      ]),
    ]);
    await expect(
      createGhClient({ run: duplicateAcrossIssues.run, owner, repo, token }).listManagedIssues(),
    ).rejects.toThrow(/duplicate managed bead id.*pb-6/i);
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
          id: 'P-managed',
          number: 7,
          title: 'Renamed inventory',
          readme: `${PROJECT_README_MARKER}\n# Public Beads`,
          public: true,
          url: 'https://github.com/orgs/OpenCoven/projects/7',
        },
      ]),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    await expect(client.discoverProject()).resolves.toMatchObject({
      id: 'P-managed',
      number: 7,
      title: 'Renamed inventory',
    });
    const payload = parseStdin(runner.calls[0]!);
    expect(runner.calls[0]?.args).toEqual(['api', 'graphql', '--input', '-']);
    expect(payload.variables).toEqual({ owner, repo, cursor: null });
    expect(payload.query).toMatch(/projectsV2\(first:\s*100,\s*after:\s*\$cursor\)/u);
    expect(payload.query).toMatch(/\breadme\b/u);
  });

  it('creates an absent Project, sets it public, links the repository, and updates the README', async () => {
    const readme = `${PROJECT_README_MARKER}\n# Public Beads`;
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
      success({ data: { linkProjectV2ToRepository: { repository: { id: 'REPO_node' } } } }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    const project = await client.ensureProject({ title: 'Public Beads', readme });

    expect(project).toMatchObject({ id: 'P-new', number: 12, public: true, readme });
    expect(runner.calls).toHaveLength(4);
    expect(parseStdin(runner.calls[1]!)).toMatchObject({
      variables: { ownerId: 'ORG_node', title: 'Public Beads' },
    });
    expect(parseStdin(runner.calls[1]!).query).toMatch(/mutation CreateManagedProject/u);
    expect(parseStdin(runner.calls[2]!)).toMatchObject({
      variables: { projectId: 'P-new', public: true, readme },
    });
    expect(parseStdin(runner.calls[2]!).query).toMatch(/mutation UpdateManagedProject/u);
    expect(parseStdin(runner.calls[3]!)).toMatchObject({
      variables: { projectId: 'P-new', repositoryId: 'REPO_node' },
    });
    for (const call of runner.calls.slice(1)) {
      expect(call.args).toEqual(['api', 'graphql', '--input', '-']);
      expect(call.args.join(' ')).not.toContain(readme);
    }
  });

  it('discovers fields/options and provisions the required Status and custom field definitions', async () => {
    const runner = createRunner([
      projectDiscovery([{
        id: 'P-fields',
        number: 8,
        title: 'Public Beads',
        readme: PROJECT_README_MARKER,
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
    const client = createGhClient({ run: runner.run, owner, repo, token });
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

  it('creates or updates the six managed views through GraphQL with exact layouts and filters', async () => {
    const runner = createRunner([
      projectDiscovery([{
        id: 'P-views',
        number: 9,
        title: 'Public Beads',
        readme: PROJECT_README_MARKER,
        public: true,
      }]),
      success({ data: { node: { views: {
        nodes: [
          { id: 'V-overview', name: 'Overview', layout: 'BOARD_LAYOUT', filter: 'old:true' },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } }),
      ...Array.from({ length: 6 }, () => success({ data: {} })),
      success({ data: { node: { views: {
        nodes: PROJECT_VIEWS.map((view, index) => ({ id: `V-${index}`, ...view })),
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });
    await client.discoverProject();

    const views = await client.ensureViews();

    expect(views.map(({ name, layout, filter }) => ({ name, layout, filter }))).toEqual(PROJECT_VIEWS);
    const mutationCalls = runner.calls.slice(2, 8);
    expect(mutationCalls).toHaveLength(6);
    expect(parseStdin(mutationCalls[0]!)).toMatchObject({
      variables: {
        input: {
          projectId: 'P-views',
          viewId: 'V-overview',
          name: 'Overview',
          layout: 'TABLE_LAYOUT',
          filter: '',
        },
      },
    });
    expect(parseStdin(mutationCalls[0]!).query).toMatch(/mutation UpdateManagedProjectView/u);
    expect(mutationCalls.slice(1).map((call) => {
      const payload = parseStdin(call);
      expect(payload.query).toMatch(/mutation CreateManagedProjectView/u);
      return payload.variables;
    })).toEqual(PROJECT_VIEWS.slice(1).map((view) => ({
      input: { projectId: 'P-views', ...view },
    })));
  });

  it('creates, updates, closes, reopens, labels, and assigns issues with JSON stdin', async () => {
    const body = [
      '<!-- psyche-bead-sync:v1 bead-id=pb-42 -->',
      '## Bead',
      '- Type: `feature`',
      '- Priority: P1',
      '- Blocked: yes',
    ].join('\n');
    const runner = createRunner([
      success({ number: 42 }),
      success({ number: 42 }),
      success({ number: 42 }),
      success({ number: 42 }),
      success({ number: 42 }),
      success({ number: 42 }),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });

    await expect(
      client.createIssue({ title: '[pb-42] Work', body, assignee: 'octocat' }),
    ).resolves.toMatchObject({ number: 42 });
    await client.updateIssue({
      issueNumber: 42,
      title: '[pb-42] Updated',
      body,
      state: 'open',
      assignee: null,
    });
    await client.closeIssue({ issueNumber: 42 });
    await client.reopenIssue({ issueNumber: 42 });
    await client.labelIssue({ issueNumber: 42, labels: ['bead', 'priority:P2'] });
    await client.assignIssue({ issueNumber: 42, assignee: 'hubot' });

    expect(runner.calls.map((call) => call.args)).toEqual([
      ['api', `repos/${owner}/${repo}/issues`, '--method', 'POST', ...apiHeaders, '--input', '-'],
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
    expect(parseStdin(runner.calls[1]!)).toEqual({
      title: '[pb-42] Updated',
      body,
      state: 'open',
      labels: ['bead', 'bead:feature', 'priority:P1', 'status:blocked'],
      assignees: [],
    });
    expect(parseStdin(runner.calls[2]!)).toEqual({ state: 'closed' });
    expect(parseStdin(runner.calls[3]!)).toEqual({ state: 'open' });
    expect(parseStdin(runner.calls[4]!)).toEqual({ labels: ['bead', 'priority:P2'] });
    expect(parseStdin(runner.calls[5]!)).toEqual({ assignees: ['hubot'] });
  });

  it('adds one project item per invocation and updates each requested field in its own invocation', async () => {
    const project = {
      id: 'P-items',
      number: 14,
      title: 'Public Beads',
      readme: PROJECT_README_MARKER,
      public: true,
      url: 'https://github.com/orgs/OpenCoven/projects/14',
    };
    const runner = createRunner([
      projectDiscovery([project]),
      success({ id: 'ITEM-42' }),
      success({}),
      success({}),
      success({}),
      success({}),
      success({}),
      success({}),
    ]);
    const client = createGhClient({ run: runner.run, owner, repo, token });
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

    expect(runner.calls[1]).toEqual({
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
    expect(runner.calls.slice(2).map((call) => call.args)).toEqual([
      ['project', 'item-edit', '--id', 'ITEM-42', '--project-id', 'P-items', '--field-id', 'F-id', '--text', 'pb-42'],
      ['project', 'item-edit', '--id', 'ITEM-42', '--project-id', 'P-items', '--field-id', 'F-status', '--single-select-option-id', 'O-blocked'],
      ['project', 'item-edit', '--id', 'ITEM-42', '--project-id', 'P-items', '--field-id', 'F-priority', '--single-select-option-id', 'O-p1'],
      ['project', 'item-edit', '--id', 'ITEM-42', '--project-id', 'P-items', '--field-id', 'F-type', '--single-select-option-id', 'O-feature'],
      ['project', 'item-edit', '--id', 'ITEM-42', '--project-id', 'P-items', '--field-id', 'F-parent', '--text', 'Public launch'],
      ['project', 'item-edit', '--id', 'ITEM-42', '--project-id', 'P-items', '--field-id', 'F-updated', '--date', '2026-08-22'],
    ]);
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

  it('maps reconciliation parent/blocker operations and archive/restore names directly', async () => {
    const project = {
      id: 'P-rel',
      number: 15,
      title: 'Public Beads',
      readme: PROJECT_README_MARKER,
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
    const client = createGhClient({ run: runner.run, owner, repo, token });
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
    const client = createGhClient({ run: runner.run, owner, repo, token });

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
});
