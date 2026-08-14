import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TOOLS,
  closeMcpControlClients,
  createMcpControlClientForRoot,
  handleMcpRequest,
  setMcpDeps,
} from '../src/mcp/server.js';

const restores: Array<() => void> = [];
afterEach(async () => {
  while (restores.length) restores.pop()!();
  await closeMcpControlClients();
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

function fakeClient(overrides: Record<string, unknown> = {}): any {
  return {
    submit: vi.fn(), getState: vi.fn(), actionStatus: vi.fn(), close: vi.fn(async () => undefined),
    ...overrides,
  };
}

const lease = {
  task_id: 'task-1', lease_id: 'lease-1', lease_revision: 2,
};

describe('agent surface MCP tools', () => {
  it('pins the eight typed control tools and required authorization fields', () => {
    const names = [
      'psyche_control_list', 'psyche_control_lease', 'psyche_pane_observe',
      'psyche_pane_action', 'psyche_browser_inspect', 'psyche_browser_action',
      'psyche_browser_script', 'psyche_control_action_status',
    ];
    expect(names.every((name) => TOOLS.some((tool) => tool.name === name))).toBe(true);

    for (const name of ['psyche_pane_observe', 'psyche_pane_action', 'psyche_browser_inspect',
      'psyche_browser_action', 'psyche_browser_script']) {
      const required = (TOOLS.find((tool) => tool.name === name)!.inputSchema.required ?? []) as string[];
      expect(required).toEqual(expect.arrayContaining(['task_id', 'lease_id', 'lease_revision']));
    }
  });

  it('documents the generic click risk boundary', () => {
    const description = TOOLS.find((tool) => tool.name === 'psyche_browser_action')?.description;
    expect(description).toMatch(/generic click/i);
    expect(description).toMatch(/cannot be perfectly predicted/i);
  });

  it('rejects oversized browser script arguments before client submission', async () => {
    const client = fakeClient();
    inject({ controlClientForRoot: vi.fn(async () => client) });
    const response = await call('psyche_browser_script', {
      ...lease, project_root: '/repo', tab_id: 'tab-1', generation: 1,
      source: 'return args;', args: { text: 'x'.repeat(256 * 1024 + 1) },
    });
    expect(response.error).toMatchObject({ code: -32602 });
    expect(client.submit).not.toHaveBeenCalled();
  });

  it('routes a pane action through the canonical client without forging actor or epoch', async () => {
    const receipt = {
      schema: 'psyche.control.receipt/v1', actionId: 'action-1', state: 'queued',
      resource: { kind: 'pane', id: 'pane-1', generation: 3 }, createdAt: '2026-08-12T00:00:00.000Z',
    };
    const client = fakeClient({
      submit: vi.fn(async () => ({ status: 'succeeded', value: receipt })),
    });
    const controlClientForRoot = vi.fn(async () => client);
    inject({ controlClientForRoot });

    const body = payload(await call('psyche_pane_action', {
      ...lease, project_root: '/repo', pane_id: 'pane-1', generation: 3,
      action: { kind: 'send_text', text: 'hello' },
    }));

    expect(body).toEqual(receipt);
    expect(controlClientForRoot).toHaveBeenCalledWith('/repo');
    const command = client.submit.mock.calls[0][0];
    expect(command).toMatchObject({
      kind: 'pane.action', projectRoot: '/repo',
      payload: {
        taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 2,
        paneId: 'pane-1', generation: 3,
        action: { kind: 'send_text', text: 'hello' },
      },
    });
    expect(command.actor).toBeUndefined();
    expect(command.ownerEpoch).toBeUndefined();
  });

  it('supports request, status, and release but refuses grant and approval operations', async () => {
    const client = fakeClient({ getState: vi.fn(async () => ({
      capabilityLeases: [], leaseRequests: [], resources: [], approvals: [], receipts: [],
    })) });
    inject({ controlClientForRoot: vi.fn(async () => client) });

    for (const operation of ['grant', 'approve']) {
      const response = await call('psyche_control_lease', { operation, task_id: 'task-1' });
      expect(response.error.code).toBe(-32602);
    }
    expect(client.submit).not.toHaveBeenCalled();

    expect(payload(await call('psyche_control_lease', {
      operation: 'status', task_id: 'task-1', request_id: 'request-1', project_root: '/repo',
    }))).toMatchObject({ leases: [], requests: [] });
  });

  it('does not disclose reusable lease credentials through the project listing', async () => {
    const client = fakeClient({ getState: vi.fn(async () => ({
      ownerEpoch: 1, sequence: 1, resources: [], approvals: [], receipts: [],
      capabilityLeases: [{
        id: 'lease-victim', requestId: 'request-victim', revision: 3,
        actorId: 'agent', taskId: 'task-victim', grants: [],
      }],
      leaseRequests: [{ id: 'request-victim', taskId: 'task-victim' }],
    })) });
    inject({ controlClientForRoot: vi.fn(async () => client) });

    const body = payload(await call('psyche_control_list', { project_root: '/repo' }));
    expect(body).not.toHaveProperty('leases');
    expect(body).not.toHaveProperty('lease_requests');
    expect(JSON.stringify(body)).not.toContain('lease-victim');
    expect(JSON.stringify(body)).not.toContain('request-victim');
  });

  it('requires the originating request id to inspect a task lease', async () => {
    const client = fakeClient({ getState: vi.fn(async () => ({
      capabilityLeases: [], leaseRequests: [], resources: [], approvals: [], receipts: [],
    })) });
    inject({ controlClientForRoot: vi.fn(async () => client) });

    const response = await call('psyche_control_lease', {
      operation: 'status', task_id: 'task-victim', project_root: '/repo',
    });
    expect(response.error.code).toBe(-32602);
    expect(client.getState).not.toHaveBeenCalled();
  });

  it('returns a structured lease_missing result for unleased create and kill aliases', async () => {
    const client = fakeClient();
    inject({ controlClientForRoot: vi.fn(async () => client) });

    for (const [name, args] of [
      ['psyche_create_pane', { prompt: 'fix it', agent: 'codex' }],
      ['psyche_kill_pane', { pane_id: 'pane-1', generation: 1 }],
    ] as const) {
      expect(payload(await call(name, args))).toMatchObject({
        status: 'rejected', code: 'lease_missing',
      });
    }
    expect(client.submit).not.toHaveBeenCalled();
  });

  it('uses the connected client canonical root for alias pane creation scope', async () => {
    const client = fakeClient({
      projectRoot: '/canonical/repo',
      submit: vi.fn(async () => ({ status: 'succeeded' })),
    });
    inject({ controlClientForRoot: vi.fn(async () => client) });

    await call('psyche_create_pane', {
      ...lease, project_root: '/symlink/repo', prompt: 'fix it', agent: 'codex',
    });

    expect(client.submit.mock.calls[0][0]).toMatchObject({
      projectRoot: '/canonical/repo',
      payload: { projectId: '/canonical/repo', action: { cwd: '/canonical/repo' } },
    });
  });

  it('canonicalizes once across token load and owner connection retries', async () => {
    const canonicalize = vi.fn(async () => '/canonical/repo');
    const agentToken = vi.fn(async () => 'agent-token');
    const credentialStoreForCanonicalRoot = vi.fn(async () => ({ agentToken } as any));
    const client = fakeClient({ projectRoot: '/canonical/repo' });
    const connect = vi.fn()
      .mockRejectedValueOnce(connectionError('ENOENT'))
      .mockRejectedValueOnce(connectionError('ECONNREFUSED'))
      .mockResolvedValueOnce(client);
    let now = 0;

    const borrowed = await createMcpControlClientForRoot('/symlink/repo', {
      canonicalize,
      credentialStoreForCanonicalRoot,
      connect,
      spawn: vi.fn(() => ({ unref: vi.fn() } as never)),
      now: () => now,
      sleep: async (delay) => { now += delay; },
      entryPath: '/entry.js',
    });

    expect(canonicalize).toHaveBeenCalledOnce();
    expect(credentialStoreForCanonicalRoot).toHaveBeenCalledWith({
      canonicalProjectRoot: '/canonical/repo',
    });
    expect(agentToken).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(3);
    expect(connect.mock.calls.every(([options]) => options.projectRoot === '/canonical/repo')).toBe(true);
    await borrowed.close();
  });

  it('maps an unavailable action transaction to unknown', async () => {
    inject({ controlClientForRoot: vi.fn(async () => fakeClient({
      actionStatus: vi.fn(async () => undefined),
    })) });

    expect(payload(await call('psyche_control_action_status', {
      action_id: 'missing-action', project_root: '/repo',
    }))).toEqual({ status: 'unknown', action_id: 'missing-action' });
  });

  it('releases the control client after every tool operation', async () => {
    const close = vi.fn(async () => undefined);
    inject({ controlClientForRoot: vi.fn(async () => fakeClient({
      close,
      getState: vi.fn(async () => ({
        ownerEpoch: 1, sequence: 0, commands: {}, leases: {}, resources: [],
        capabilityLeases: [], leaseRequests: [], approvals: [], receipts: [],
      })),
    })) });

    await call('psyche_control_list', { project_root: '/repo' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('single-flights 32 concurrent cold starts and closes the shared client once', async () => {
    const canonicalize = vi.fn(async () => '/canonical/repo');
    const underlying = fakeClient({ projectRoot: '/canonical/repo' });
    const connect = vi.fn()
      .mockRejectedValueOnce(connectionError('ENOENT'))
      .mockResolvedValueOnce(underlying);
    const spawn = vi.fn(() => ({ unref: vi.fn() } as never));
    const credentials = { agentToken: vi.fn(async () => 'token') } as any;
    let now = 0;
    const options = {
      canonicalize,
      credentialStoreForCanonicalRoot: vi.fn(async () => credentials),
      connect,
      spawn,
      now: () => now,
      sleep: async (delay: number) => { now += delay; },
      entryPath: '/entry.js',
    };

    const borrowed = await Promise.all(Array.from(
      { length: 32 },
      () => createMcpControlClientForRoot('/repo-link', options),
    ));

    expect(spawn).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(options.credentialStoreForCanonicalRoot).toHaveBeenCalledOnce();
    await Promise.all(borrowed.map((client) => client.close()));
    expect(underlying.close).toHaveBeenCalledOnce();
  });

  it('server cleanup closes an outstanding shared control client', async () => {
    const underlying = fakeClient({ projectRoot: '/canonical/repo' });
    const borrowed = await createMcpControlClientForRoot('/repo', {
      canonicalize: async () => '/canonical/repo',
      credentialStoreForCanonicalRoot: async () => ({ agentToken: async () => 'token' } as any),
      connect: async () => underlying,
      entryPath: '/entry.js',
    });

    await closeMcpControlClients();
    expect(underlying.close).toHaveBeenCalledOnce();
    await borrowed.close();
    expect(underlying.close).toHaveBeenCalledOnce();
  });

  it('coalesces an authentication failure once and allows a fresh later attempt', async () => {
    const authFailure = new Error('authentication_failed: invalid credentials');
    const connect = vi.fn()
      .mockRejectedValueOnce(authFailure)
      .mockResolvedValueOnce(fakeClient({ projectRoot: '/canonical/repo' }));
    const options = {
      canonicalize: async () => '/canonical/repo',
      credentialStoreForCanonicalRoot: async () => ({ agentToken: async () => 'token' } as any),
      connect,
      spawn: vi.fn(),
      entryPath: '/entry.js',
    };

    const first = await Promise.allSettled(Array.from(
      { length: 8 },
      () => createMcpControlClientForRoot('/repo', options),
    ));
    expect(first.every((result) => result.status === 'rejected')).toBe(true);
    expect(connect).toHaveBeenCalledOnce();
    expect(options.spawn).not.toHaveBeenCalled();

    const recovered = await createMcpControlClientForRoot('/repo', options);
    expect(connect).toHaveBeenCalledTimes(2);
    await recovered.close();
  });

  it('contains no direct mutation dependencies', () => {
    const source = readFileSync(new URL('../src/mcp/server.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/spawnBridgePane|killBridgePane|TmuxControl|execFileSync/);
  });
});

function connectionError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
