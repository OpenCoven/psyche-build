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
    taskResources: vi.fn(async () => ({
      ownerEpoch: 3, sequence: 9, resources: [],
    })),
    leaseStatus: vi.fn(async () => ({ requests: [], leases: [] })),
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

  it('does not advertise or dispatch deferred task action status', async () => {
    expect(TOOLS.some((tool) => tool.name === 'psyche_control_action_status')).toBe(false);
    await expect(call('psyche_control_action_status', {
      action_id: 'action-1',
      project_root: '/repo',
    })).resolves.toMatchObject({
      error: { code: -32601, message: 'Unknown tool: psyche_control_action_status' },
    });
  });

  it('documents exactly the tools it implements', async () => {
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const documented = [...new Set(
      [...readme.matchAll(/`(psyche_[a-z_]+)`/g)].map((match) => match[1]),
    )].sort();
    expect(documented).toEqual(TOOLS.map((tool) => tool.name).sort());
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
      taskResources: vi.fn(async () => {
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
    const fake = client({ taskResources: vi.fn(async () => ({
      ownerEpoch: 1, sequence: 1,
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
    const fake = client({
      taskBinding: { taskId: 'task' },
      submit: vi.fn(async () => ({ status: 'succeeded', value: receipt })),
    });
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
    const fake = client({
      taskBinding: { taskId: 'task-1' },
      submit: vi.fn(async () => ({ status: 'succeeded' })),
    });
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
});
