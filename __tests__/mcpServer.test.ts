import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlResponseError } from '../src/control/client.js';
import {
  MCP_CONTROL_ERROR_CODE,
  SERVER_NAME,
  TOOLS,
  handleMcpRequest,
  setMcpDeps,
} from '../src/mcp/server.js';

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
  vi.restoreAllMocks();
});

function inject(next: Parameters<typeof setMcpDeps>[0]): void {
  restores.push(setMcpDeps(next));
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return handleMcpRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  });
}

function payload(response: any): any {
  return JSON.parse(response.result.content[0].text);
}

function client(overrides: Record<string, unknown> = {}): any {
  return {
    submit: vi.fn(),
    getState: vi.fn(async () => ({
      ownerEpoch: 3, sequence: 9, commands: {}, leases: {},
      resources: [], capabilityLeases: [], leaseRequests: [], approvals: [], receipts: [],
    })),
    actionStatus: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('MCP tool registry', () => {
  it('advertises the psyche server name', async () => {
    const response = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect((response as any).result.serverInfo.name).toBe(SERVER_NAME);
  });

  it('lists exactly the canonical tools and compatibility aliases', async () => {
    const response = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((response as any).result.tools.map((tool: any) => tool.name).sort()).toEqual([
      'psyche_browser_action',
      'psyche_browser_inspect',
      'psyche_browser_script',
      'psyche_control_action_status',
      'psyche_control_lease',
      'psyche_control_list',
      'psyche_create_pane',
      'psyche_execute_task',
      'psyche_get_pane_output',
      'psyche_kill_pane',
      'psyche_list_panes',
      'psyche_list_rituals',
      'psyche_list_worktrees',
      'psyche_pane_action',
      'psyche_pane_observe',
    ]);
  });

  it('documents exactly the tools it implements', async () => {
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const documented = [...new Set(
      [...readme.matchAll(/`(psyche_[a-z_]+)`/g)].map((match) => match[1]),
    )].sort();
    expect(documented).toEqual(TOOLS.map((tool) => tool.name).sort());
  });

  it('includes all orchestration tools under psyche_ naming', async () => {
    const response = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (response as any).result.tools.map((tool: any) => tool.name);
    for (const required of [
      'psyche_list_panes',
      'psyche_execute_task',
      'psyche_create_pane',
      'psyche_kill_pane',
      'psyche_get_pane_output',
      'psyche_list_rituals',
      'psyche_list_worktrees',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('contains no STUB or wiring-in-progress claims in descriptions', async () => {
    const response = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    for (const tool of (response as any).result.tools) {
      expect(tool.description).not.toMatch(/STUB/i);
      expect(tool.description).not.toMatch(/wiring in progress/i);
    }
  });

  it('returns method errors and ignores notifications', async () => {
    expect((await call('psyche_nope')).error.code).toBe(-32601);
    expect(await handleMcpRequest({
      jsonrpc: '2.0', method: 'notifications/initialized',
    })).toBeNull();
  });
});

describe('MCP canonical delegation and read-only helpers', () => {
  it.each([
    'task_binding_required',
    'task_binding_mismatch',
    'resource_not_found',
  ])('maps control response error %s to a numeric JSON-RPC server error', async (code) => {
    const fake = client({
      getState: vi.fn(async () => {
        throw new ControlResponseError(code, `${code}: control request failed`);
      }),
    });
    inject({ controlClientForRoot: vi.fn(async () => fake) });

    await expect(call('psyche_list_panes', { project_root: '/repo' })).resolves.toMatchObject({
      error: {
        code: MCP_CONTROL_ERROR_CODE,
        message: `${code}: control request failed`,
        data: { code },
      },
    });
  });

  it('lists panes from the control snapshot', async () => {
    const fake = client({ getState: vi.fn(async () => ({
      ownerEpoch: 1, sequence: 1, commands: {}, leases: {}, capabilityLeases: [],
      leaseRequests: [], approvals: [], receipts: [],
      resources: [
        { kind: 'pane', id: 'pane-1', generation: 2 },
        { kind: 'browser_tab', id: 'tab-1', generation: 1 },
      ],
    })) });
    inject({ controlClientForRoot: vi.fn(async () => fake) });

    expect(payload(await call('psyche_list_panes', { project_root: '/repo' }))).toMatchObject({
      project_root: '/repo', count: 1, panes: [{ kind: 'pane', id: 'pane-1', generation: 2 }],
    });
  });

  it('uses injected read-only ritual and worktree functions', async () => {
    const listRitualsForRoot = vi.fn(async () => ({ builtin: [{ id: 'start' }], project: [] }));
    const listWorktreesForRoot = vi.fn(async () => [{ path: '/repo', head: 'abc' }]);
    inject({ listRitualsForRoot, listWorktreesForRoot });

    expect(payload(await call('psyche_list_rituals', { project_root: '/repo' })).count).toBe(1);
    expect(payload(await call('psyche_list_worktrees', { project_root: '/repo' }))).toMatchObject({
      count: 1, worktrees: [{ path: '/repo', head: 'abc' }],
    });
    expect(listRitualsForRoot).toHaveBeenCalledWith('/repo');
    expect(listWorktreesForRoot).toHaveBeenCalledWith('/repo');
  });

  it('translates create and kill aliases to leased canonical pane actions', async () => {
    const receipt = {
      schema: 'psyche.control.receipt/v1', actionId: 'a', state: 'queued',
      resource: { kind: 'project', id: '/repo' }, createdAt: 'now',
    };
    const fake = client({ submit: vi.fn(async () => ({ status: 'succeeded', value: receipt })) });
    inject({ controlClientForRoot: vi.fn(async () => fake), randomId: () => 'command-1' });
    const auth = { task_id: 'task', lease_id: 'lease', lease_revision: 1 };

    expect(payload(await call('psyche_create_pane', {
      ...auth, project_root: '/repo', prompt: 'fix auth', agent: 'codex',
    }))).toEqual(receipt);
    expect(payload(await call('psyche_kill_pane', {
      ...auth, project_root: '/repo', pane_id: 'pane-1', generation: 2,
    }))).toEqual(receipt);

    expect(fake.submit.mock.calls[0][0]).toMatchObject({
      kind: 'pane.action', payload: {
        taskId: 'task', leaseId: 'lease', leaseRevision: 1,
        projectId: '/repo', action: { kind: 'create', agent: 'codex', prompt: 'fix auth' },
      },
    });
    expect(fake.submit.mock.calls[1][0]).toMatchObject({
      kind: 'pane.action', payload: {
        paneId: 'pane-1', generation: 2, action: { kind: 'close' },
      },
    });
  });

  it('requires and forwards project lease authority for task execution', async () => {
    const fake = client({ submit: vi.fn(async () => ({ status: 'succeeded' })) });
    inject({ controlClientForRoot: vi.fn(async () => fake), randomId: () => 'id-1' });

    expect(payload(await call('psyche_execute_task', {
      project_root: '/repo', prompt: 'test', lanes: [{ id: 'one', mode: 'terminal' }],
    }))).toMatchObject({ status: 'rejected', code: 'lease_missing' });
    expect(fake.submit).not.toHaveBeenCalled();

    await call('psyche_execute_task', {
      project_root: '/repo', prompt: 'test', lanes: [{ id: 'one', mode: 'terminal' }],
      task_id: 'task-1', lease_id: 'lease-1', lease_revision: 2,
    });
    expect(fake.submit).toHaveBeenCalledOnce();
    expect(fake.submit.mock.calls[0][0]).toMatchObject({
      kind: 'orchestration.execute', payload: {
        taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 2,
        request: { taskId: 'task-1', projectRoot: '/repo', prompt: 'test' },
      },
    });
  });

  it('delegates multi-lane execute_task with normalized task request', async () => {
    const outcome = {
      status: 'succeeded' as const,
      value: { taskId: 'task-2', status: 'completed' },
    };
    const fake = client({ submit: vi.fn(async () => outcome) });
    inject({ controlClientForRoot: vi.fn(async () => fake), randomId: () => 'id-2' });
    const auth = { task_id: 'task-2', lease_id: 'lease-2', lease_revision: 1 };

    const response = await call('psyche_execute_task', {
      ...auth, project_root: '/repo', prompt: 'Fix tests',
      lanes: [
        { id: 'codex', mode: 'isolated-worktree', agent: 'codex' },
        { id: 'claude', mode: 'isolated-worktree', agent: 'claude' },
      ],
      concurrency: 2,
    });

    expect(payload(response)).toEqual(outcome);
    expect(fake.submit).toHaveBeenCalledOnce();
    const submitted = fake.submit.mock.calls[0][0];
    expect(submitted.kind).toBe('orchestration.execute');
    expect(submitted.payload.request).toMatchObject({
      taskId: 'task-2',
      projectRoot: '/repo',
      prompt: 'Fix tests',
      concurrency: 2,
      lanes: [
        { id: 'codex', mode: 'isolated-worktree', agent: 'codex' },
        { id: 'claude', mode: 'isolated-worktree', agent: 'claude' },
      ],
    });
  });

  it('maps a rejected orchestration outcome to a JSON-RPC control error', async () => {
    const fake = client({
      submit: vi.fn(async () => ({
        status: 'rejected',
        code: 'capability_denied',
        message: 'lease is stale',
      })),
    });
    inject({ controlClientForRoot: vi.fn(async () => fake) });

    await expect(call('psyche_execute_task', {
      project_root: '/repo',
      prompt: 'Fix tests',
      lanes: [{ id: 'terminal', mode: 'terminal' }],
      task_id: 'task-1',
      lease_id: 'lease-1',
      lease_revision: 1,
    })).resolves.toMatchObject({
      error: {
        code: MCP_CONTROL_ERROR_CODE,
        message: 'lease is stale',
        data: { code: 'capability_denied' },
      },
    });
  });

  it('translates create_pane to a single-lane pane action via control owner', async () => {
    const receipt = {
      schema: 'psyche.control.receipt/v1', actionId: 'b', state: 'queued',
      resource: { kind: 'pane', id: 'pane-new' }, createdAt: 'now',
    };
    const fake = client({ submit: vi.fn(async () => ({ status: 'succeeded', value: receipt })) });
    inject({ controlClientForRoot: vi.fn(async () => fake), randomId: () => 'cmd-2' });
    const auth = { task_id: 'task-3', lease_id: 'lease-3', lease_revision: 1 };

    const result = payload(await call('psyche_create_pane', {
      ...auth, project_root: '/repo', prompt: 'implement auth', agent: 'claude',
      branch: 'feat/auth', title: 'Auth work',
    }));
    expect(result).toEqual({ status: 'succeeded', value: receipt });

    const submitted = fake.submit.mock.calls[0][0];
    expect(submitted.kind).toBe('pane.action');
    expect(submitted.payload.action).toMatchObject({
      kind: 'create',
      agent: 'claude',
      prompt: 'implement auth',
      branch: 'feat/auth',
      title: 'Auth work',
    });
    expect(submitted.payload.projectId).toBe('/repo');
  });

  it('kill_pane sends close action without worktree or branch deletion', async () => {
    const receipt = {
      schema: 'psyche.control.receipt/v1', actionId: 'c', state: 'queued',
      resource: { kind: 'pane', id: 'pane-1' }, createdAt: 'now',
    };
    const fake = client({ submit: vi.fn(async () => ({ status: 'succeeded', value: receipt })) });
    inject({ controlClientForRoot: vi.fn(async () => fake), randomId: () => 'cmd-3' });
    const auth = { task_id: 'task-4', lease_id: 'lease-4', lease_revision: 1 };

    const result = payload(await call('psyche_kill_pane', {
      ...auth, project_root: '/repo', pane_id: 'pane-1', generation: 3,
    }));
    expect(result).toEqual({ status: 'succeeded', value: receipt });

    const submitted = fake.submit.mock.calls[0][0];
    expect(submitted.kind).toBe('pane.action');
    expect(submitted.payload).toMatchObject({
      paneId: 'pane-1',
      generation: 3,
      action: { kind: 'close' },
    });
    // Close action must NOT include worktree or branch deletion directives
    expect(submitted.payload.action).not.toHaveProperty('deleteWorktree');
    expect(submitted.payload.action).not.toHaveProperty('deleteBranch');
  });

  it('kill_pane requires pane_id and generation', async () => {
    const fake = client({ submit: vi.fn() });
    inject({ controlClientForRoot: vi.fn(async () => fake) });
    const auth = { task_id: 'task-5', lease_id: 'lease-5', lease_revision: 1 };

    const noPaneId = await call('psyche_kill_pane', {
      ...auth, project_root: '/repo', generation: 1,
    });
    expect(noPaneId.error.code).toBe(-32602);

    const noGeneration = await call('psyche_kill_pane', {
      ...auth, project_root: '/repo', pane_id: 'pane-1',
    });
    expect(noGeneration.error.code).toBe(-32602);
    expect(fake.submit).not.toHaveBeenCalled();
  });

  it('execute_task rejects when no lanes are provided', async () => {
    const fake = client({ submit: vi.fn() });
    inject({ controlClientForRoot: vi.fn(async () => fake) });
    const auth = { task_id: 'task-6', lease_id: 'lease-6', lease_revision: 1 };

    const result = await call('psyche_execute_task', {
      ...auth, project_root: '/repo', prompt: 'test', lanes: [],
    });
    expect(result.error.code).toBe(-32602);
    expect(fake.submit).not.toHaveBeenCalled();
  });

  it('create_pane requires prompt and agent', async () => {
    const fake = client({ submit: vi.fn() });
    inject({ controlClientForRoot: vi.fn(async () => fake) });
    const auth = { task_id: 'task-7', lease_id: 'lease-7', lease_revision: 1 };

    const noPrompt = await call('psyche_create_pane', {
      ...auth, project_root: '/repo', agent: 'claude',
    });
    expect(noPrompt.error.code).toBe(-32602);

    const noAgent = await call('psyche_create_pane', {
      ...auth, project_root: '/repo', prompt: 'fix tests',
    });
    expect(noAgent.error.code).toBe(-32602);
    expect(fake.submit).not.toHaveBeenCalled();
  });
});
