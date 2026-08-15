import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TOOLS,
  MCP_CONTROL_ERROR_CODE,
  closeMcpControlClients,
  createMcpControlClientForRoot,
  handleMcpRequest,
  parseMcpArgs,
  setMcpDeps,
} from '../src/mcp/server.js';
import { ControlResponseError } from '../src/control/client.js';
import {
  startTaskScopedControlHarness,
  type TaskScopedControlHarness,
} from './helpers/taskScopedControlHarness.js';

const restores: Array<() => void> = [];
const harnesses: TaskScopedControlHarness[] = [];
afterEach(async () => {
  while (restores.length) restores.pop()!();
  await closeMcpControlClients();
  await Promise.allSettled(harnesses.splice(0).map((harness) => harness.close()));
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
    submit: vi.fn(), getState: vi.fn(), taskResources: vi.fn(), leaseStatus: vi.fn(),
    actionStatus: vi.fn(), close: vi.fn(async () => undefined),
    ...overrides,
  };
}

const lease = {
  task_id: 'task-1', lease_id: 'lease-1', lease_revision: 2,
};

describe('MCP task binding bootstrap', () => {
  it('keeps MCP unbound only when no binding input is present', () => {
    expect(parseMcpArgs([], {})).toEqual({});
  });

  it('parses task identity from CLI and token only from the environment', () => {
    expect(parseMcpArgs(['--task-id', 'task-alpha'], {
      PSYCHE_CONTROL_TASK_ID: 'task-env',
      PSYCHE_CONTROL_TASK_TOKEN: 'alpha-token',
    })).toEqual({
      taskBinding: { taskId: 'task-alpha', token: 'alpha-token' },
    });
    expect(parseMcpArgs([], {
      PSYCHE_CONTROL_TASK_ID: 'task-env',
      PSYCHE_CONTROL_TASK_TOKEN: 'env-token',
    })).toEqual({
      taskBinding: { taskId: 'task-env', token: 'env-token' },
    });
  });

  it('rejects missing and explicitly blank CLI task IDs without falling back to the environment', () => {
    expect(() => parseMcpArgs(['--task-id'], {
      PSYCHE_CONTROL_TASK_ID: 'task-env',
      PSYCHE_CONTROL_TASK_TOKEN: 'env-token',
    })).toThrow(/requires a value/i);
    expect(() => parseMcpArgs(['--task-id', ''], {})).toThrow(/task id/i);
    expect(() => parseMcpArgs(['--task-id', '   '], {})).toThrow(/task id/i);
  });

  it('fails closed when either task-binding environment variable is explicitly blank', () => {
    const secret = 'never-print-this-environment-token';
    const environments: NodeJS.ProcessEnv[] = [
      { PSYCHE_CONTROL_TASK_ID: '' },
      { PSYCHE_CONTROL_TASK_ID: '   ' },
      { PSYCHE_CONTROL_TASK_TOKEN: '' },
      { PSYCHE_CONTROL_TASK_TOKEN: '   ' },
      { PSYCHE_CONTROL_TASK_ID: '', PSYCHE_CONTROL_TASK_TOKEN: secret },
      { PSYCHE_CONTROL_TASK_ID: 'task-alpha', PSYCHE_CONTROL_TASK_TOKEN: '' },
      { PSYCHE_CONTROL_TASK_ID: 'task-alpha', PSYCHE_CONTROL_TASK_TOKEN: '   ' },
      { PSYCHE_CONTROL_TASK_ID: '   ', PSYCHE_CONTROL_TASK_TOKEN: secret },
      { PSYCHE_CONTROL_TASK_ID: '', PSYCHE_CONTROL_TASK_TOKEN: '' },
      { PSYCHE_CONTROL_TASK_ID: '   ', PSYCHE_CONTROL_TASK_TOKEN: '   ' },
    ];
    for (const env of environments) {
      let rejection: unknown;
      try {
        parseMcpArgs([], env);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(TypeError);
      expect(String(rejection)).not.toContain(secret);
    }
  });

  it('requires both task identity values or neither without exposing the token', () => {
    const token = 'never-print-this-task-token';
    expect(() => parseMcpArgs(['--task-id', 'task-alpha'], {}))
      .toThrow(/task token/i);
    expect(() => parseMcpArgs([], { PSYCHE_CONTROL_TASK_TOKEN: token }))
      .toThrow(/task id/i);
    for (const args of [
      () => parseMcpArgs(['--task-id', 'task-alpha'], {}),
      () => parseMcpArgs([], { PSYCHE_CONTROL_TASK_TOKEN: token }),
    ]) {
      try {
        args();
      } catch (error) {
        expect(String(error)).not.toContain(token);
      }
    }
  });

  it('accepts 256-character task IDs and rejects 257 characters', () => {
    const token = 'task-token';
    const accepted = 'a'.repeat(256);
    expect(parseMcpArgs(['--task-id', accepted], {
      PSYCHE_CONTROL_TASK_TOKEN: token,
    })).toEqual({ taskBinding: { taskId: accepted, token } });
    expect(() => parseMcpArgs(['--task-id', 'a'.repeat(257)], {
      PSYCHE_CONTROL_TASK_TOKEN: token,
    })).toThrow(/256/);
  });
});

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
      expect(required).toEqual(expect.arrayContaining(['lease_id', 'lease_revision']));
      expect(required).not.toContain('task_id');
    }
    expect(TOOLS.find((tool) => tool.name === 'psyche_control_lease')?.inputSchema.required)
      .toEqual(['operation']);
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
      taskBinding: { taskId: 'task-1' },
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

  it('derives mutation task identity from the bound client and rejects supplied mismatches', async () => {
    const client = fakeClient({
      taskBinding: { taskId: 'task-alpha' },
      submit: vi.fn(async () => ({ status: 'succeeded' })),
    });
    inject({ controlClientForRoot: vi.fn(async () => client) });

    await call('psyche_pane_action', {
      project_root: '/repo',
      lease_id: 'lease-alpha',
      lease_revision: 1,
      pane_id: 'pane-alpha',
      generation: 1,
      action: { kind: 'send_text', text: 'hello' },
    });
    expect(client.submit).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ taskId: 'task-alpha' }),
    }));

    client.submit.mockClear();
    const response = await call('psyche_pane_action', {
      project_root: '/repo',
      task_id: 'task-beta',
      lease_id: 'lease-alpha',
      lease_revision: 1,
      pane_id: 'pane-alpha',
      generation: 1,
      action: { kind: 'send_text', text: 'hello' },
    });
    expect(response.error).toMatchObject({ code: -32602 });
    expect(client.submit).not.toHaveBeenCalled();
  });

  it('supports request, status, and release but refuses grant and approval operations', async () => {
    const client = fakeClient({
      leaseStatus: vi.fn(async () => ({ leases: [], requests: [] })),
    });
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
    const client = fakeClient({ taskResources: vi.fn(async () => ({
      ownerEpoch: 1, sequence: 1, resources: [], approvals: [], receipts: [],
    })) });
    inject({ controlClientForRoot: vi.fn(async () => client) });

    const body = payload(await call('psyche_control_list', { project_root: '/repo' }));
    expect(body).not.toHaveProperty('leases');
    expect(body).not.toHaveProperty('lease_requests');
    expect(JSON.stringify(body)).not.toContain('lease-victim');
    expect(JSON.stringify(body)).not.toContain('request-victim');
  });

  it('requires the originating request id to inspect a task lease', async () => {
    const client = fakeClient({
      leaseStatus: vi.fn(async () => ({ leases: [], requests: [] })),
    });
    inject({ controlClientForRoot: vi.fn(async () => client) });

    const response = await call('psyche_control_lease', {
      operation: 'status', task_id: 'task-victim', project_root: '/repo',
    });
    expect(response.error.code).toBe(-32602);
    expect(client.leaseStatus).not.toHaveBeenCalled();
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
      taskBinding: { taskId: 'task-1' },
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
      taskResources: vi.fn(async () => ({
        ownerEpoch: 1, sequence: 0, resources: [],
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
    await Promise.all(borrowed.slice(0, -1).map((client) => client.close()));
    expect(underlying.close).not.toHaveBeenCalled();
    await borrowed.at(-1)!.close();
    expect(underlying.close).toHaveBeenCalledOnce();
  });

  it('partitions shared clients by task ID and token fingerprint', async () => {
    const canonicalize = vi.fn(async () => '/canonical/repo');
    const clients = [
      fakeClient({ projectRoot: '/canonical/repo', taskBinding: { taskId: 'task-alpha' } }),
      fakeClient({ projectRoot: '/canonical/repo', taskBinding: { taskId: 'task-alpha' } }),
      fakeClient({ projectRoot: '/canonical/repo', taskBinding: { taskId: 'task-beta' } }),
    ];
    const connect = vi.fn()
      .mockResolvedValueOnce(clients[0])
      .mockResolvedValueOnce(clients[1])
      .mockResolvedValueOnce(clients[2]);
    const options = {
      canonicalize,
      credentialStoreForCanonicalRoot: vi.fn(),
      connect,
      entryPath: '/entry.js',
    };

    const alphaOne = await createMcpControlClientForRoot('/repo', {
      ...options,
      taskBinding: { taskId: 'task-alpha', token: 'alpha-token-one' },
    });
    const alphaTwo = await createMcpControlClientForRoot('/repo', {
      ...options,
      taskBinding: { taskId: 'task-alpha', token: 'alpha-token-two' },
    });
    const alphaOneAgain = await createMcpControlClientForRoot('/repo', {
      ...options,
      taskBinding: { taskId: 'task-alpha', token: 'alpha-token-one' },
    });
    const beta = await createMcpControlClientForRoot('/repo', {
      ...options,
      taskBinding: { taskId: 'task-beta', token: 'beta-token' },
    });

    expect(connect).toHaveBeenCalledTimes(3);
    expect(connect.mock.calls.map(([options]) => options.taskBinding)).toEqual([
      { taskId: 'task-alpha' },
      { taskId: 'task-alpha' },
      { taskId: 'task-beta' },
    ]);
    expect(options.credentialStoreForCanonicalRoot).not.toHaveBeenCalled();
    expect(alphaOne.taskBinding).toEqual({ taskId: 'task-alpha' });
    expect(alphaTwo.taskBinding).toEqual({ taskId: 'task-alpha' });
    expect(alphaOneAgain.taskBinding).toEqual({ taskId: 'task-alpha' });
    expect(beta.taskBinding).toEqual({ taskId: 'task-beta' });

    await alphaOne.close();
    expect(clients[0].close).not.toHaveBeenCalled();
    await Promise.all([alphaOneAgain.close(), alphaTwo.close(), beta.close()]);
    expect(clients[0].close).toHaveBeenCalledOnce();
    expect(clients[1].close).toHaveBeenCalledOnce();
    expect(clients[2].close).toHaveBeenCalledOnce();
  });

  it('does not let a different token borrow authority for the same claimed task', async () => {
    const alpha = fakeClient({
      projectRoot: '/canonical/repo',
      taskBinding: { taskId: 'task-alpha' },
    });
    const authenticationFailure = new Error('authentication_failed: invalid credentials');
    const connect = vi.fn(async (options) => {
      if (options.token === 'alpha-token') return alpha;
      throw authenticationFailure;
    });
    const options = {
      canonicalize: async () => '/canonical/repo',
      credentialStoreForCanonicalRoot: vi.fn(),
      connect,
      entryPath: '/entry.js',
    };

    const borrowed = await createMcpControlClientForRoot('/repo', {
      ...options,
      taskBinding: { taskId: 'task-alpha', token: 'alpha-token' },
    });
    await expect(createMcpControlClientForRoot('/repo', {
      ...options,
      taskBinding: { taskId: 'task-alpha', token: 'beta-or-invalid-token' },
    })).rejects.toBe(authenticationFailure);

    expect(connect).toHaveBeenCalledTimes(2);
    await borrowed.close();
  });

  it('keeps a shared connection alive when one borrower receives a control response error', async () => {
    let resolveResources!: (value: {
      ownerEpoch: number;
      sequence: number;
      resources: never[];
    }) => void;
    const pendingResources = new Promise<{
      ownerEpoch: number;
      sequence: number;
      resources: never[];
    }>((resolve) => { resolveResources = resolve; });
    const underlying = fakeClient({
      projectRoot: '/canonical/repo',
      taskBinding: { taskId: 'task-alpha' },
      getState: vi.fn(async () => {
        throw new ControlResponseError(
          'task_binding_required',
          'task_binding_required: task-bound control credential required',
        );
      }),
      taskResources: vi.fn(() => pendingResources),
    });
    const options = {
      canonicalize: async () => '/canonical/repo',
      connect: vi.fn(async () => underlying),
      entryPath: '/entry.js',
      taskBinding: { taskId: 'task-alpha', token: 'alpha-token' },
    };
    const [failingBorrower, activeBorrower] = await Promise.all([
      createMcpControlClientForRoot('/repo', options),
      createMcpControlClientForRoot('/repo', options),
    ]);

    const activeRequest = activeBorrower.taskResources();
    await expect(failingBorrower.getState()).rejects.toMatchObject({
      code: 'task_binding_required',
    });
    expect(underlying.close).not.toHaveBeenCalled();

    resolveResources({ ownerEpoch: 1, sequence: 2, resources: [] });
    await expect(activeRequest).resolves.toMatchObject({ sequence: 2 });
    await failingBorrower.close();
    expect(underlying.close).not.toHaveBeenCalled();
    await activeBorrower.close();
    expect(underlying.close).toHaveBeenCalledOnce();
  });

  it('invalidates and reconnects after a transport failure', async () => {
    const transportFailure = new Error('control connection closed');
    const failedClient = fakeClient({
      projectRoot: '/canonical/repo',
      taskBinding: { taskId: 'task-alpha' },
      getState: vi.fn(async () => { throw transportFailure; }),
    });
    const recoveredClient = fakeClient({
      projectRoot: '/canonical/repo',
      taskBinding: { taskId: 'task-alpha' },
      getState: vi.fn(async () => ({ ownerEpoch: 2 })),
    });
    const connect = vi.fn()
      .mockResolvedValueOnce(failedClient)
      .mockResolvedValueOnce(recoveredClient);
    const options = {
      canonicalize: async () => '/canonical/repo',
      connect,
      entryPath: '/entry.js',
      taskBinding: { taskId: 'task-alpha', token: 'alpha-token' },
    };

    const failedBorrower = await createMcpControlClientForRoot('/repo', options);
    await expect(failedBorrower.getState()).rejects.toBe(transportFailure);
    expect(failedClient.close).toHaveBeenCalledOnce();

    const recoveredBorrower = await createMcpControlClientForRoot('/repo', options);
    await expect(recoveredBorrower.getState()).resolves.toMatchObject({ ownerEpoch: 2 });
    expect(connect).toHaveBeenCalledTimes(2);

    await Promise.all([failedBorrower.close(), recoveredBorrower.close()]);
    expect(recoveredClient.close).toHaveBeenCalledOnce();
  });

  it('validates bootstrap task bindings before connecting without exposing the token', async () => {
    const token = 'bootstrap-token-must-stay-secret';
    const connect = vi.fn(async () => fakeClient({ projectRoot: '/canonical/repo' }));
    const oversized = createMcpControlClientForRoot('/repo', {
      canonicalize: async () => '/canonical/repo',
      connect,
      entryPath: '/entry.js',
      taskBinding: { taskId: 'a'.repeat(257), token },
    });

    await expect(oversized).rejects.toThrow(/256/);
    await expect(oversized).rejects.not.toThrow(token);
    await expect(createMcpControlClientForRoot('/repo', {
      canonicalize: async () => '/canonical/repo',
      connect,
      entryPath: '/entry.js',
      taskBinding: { taskId: 'task-alpha', token: '   ' },
    })).rejects.toThrow(/task token/i);
    expect(connect).not.toHaveBeenCalled();
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

describe('task-scoped MCP control integration', () => {
  async function harness(): Promise<TaskScopedControlHarness> {
    const started = await startTaskScopedControlHarness();
    harnesses.push(started);
    return started;
  }

  function bind(
    started: TaskScopedControlHarness,
    task: 'alpha' | 'beta' | 'unbound',
  ): void {
    inject({ controlClientForRoot: () => started.clientFor(task) });
  }

  it('hides pending targets and lists only active alpha-leased resources', async () => {
    const started = await harness();
    const alphaGrant = [{
      target: {
        kind: 'pane' as const,
        id: started.resources.alpha.id,
        generation: started.resources.alpha.generation,
      },
      capabilities: ['pane.observe' as const],
    }];
    const betaGrant = [{
      target: {
        kind: 'pane' as const,
        id: started.resources.beta.id,
        generation: started.resources.beta.generation,
      },
      capabilities: ['pane.observe' as const],
    }];
    await started.requestLease('alpha', 'request-alpha', alphaGrant);
    await started.requestLease('beta', 'request-beta', betaGrant);
    bind(started, 'alpha');

    expect(payload(await call('psyche_control_list', {
      project_root: started.root,
    }))).toMatchObject({
      resources: [],
      approvals: [],
      receipts: [],
    });
    expect(payload(await call('psyche_list_panes', {
      project_root: started.root,
    }))).toMatchObject({ count: 0, panes: [] });

    await started.grantLease('request-alpha');
    await started.grantLease('request-beta');

    expect(payload(await call('psyche_control_list', {
      project_root: started.root,
    }))).toMatchObject({
      resources: [expect.objectContaining({ id: started.resources.alpha.id })],
      approvals: [],
      receipts: [],
    });
    expect(payload(await call('psyche_list_panes', {
      project_root: started.root,
    }))).toMatchObject({
      count: 1,
      panes: [expect.objectContaining({ id: started.resources.alpha.id })],
    });
  });

  it('keeps beta lease status invisible to alpha and rejects a supplied mismatch', async () => {
    const started = await harness();
    const alphaGrant = [{
      target: {
        kind: 'pane' as const,
        id: started.resources.alpha.id,
        generation: started.resources.alpha.generation,
      },
      capabilities: ['pane.observe' as const],
    }];
    const betaGrant = [{
      target: {
        kind: 'pane' as const,
        id: started.resources.beta.id,
        generation: started.resources.beta.generation,
      },
      capabilities: ['pane.observe' as const],
    }];
    await started.requestLease('alpha', 'request-alpha-status', alphaGrant);
    await started.requestLease('beta', 'request-beta-status', betaGrant);
    await started.requestLease('beta', 'request-beta-pending', betaGrant);
    const alphaLease = await started.grantLease('request-alpha-status');
    const betaLease = await started.grantLease('request-beta-status');
    bind(started, 'alpha');

    expect(payload(await call('psyche_control_lease', {
      operation: 'status',
      request_id: 'request-alpha-status',
      lease_id: alphaLease.id,
      project_root: started.root,
    }))).toMatchObject({
      requests: [],
      leases: [expect.objectContaining({ id: alphaLease.id })],
    });
    expect(payload(await call('psyche_control_lease', {
      operation: 'status',
      request_id: 'request-beta-pending',
      project_root: started.root,
    }))).toEqual({ requests: [], leases: [] });
    expect(payload(await call('psyche_control_lease', {
      operation: 'status',
      request_id: 'request-beta-status',
      lease_id: betaLease.id,
      project_root: started.root,
    }))).toEqual({ requests: [], leases: [] });

    const mismatch = await call('psyche_control_lease', {
      operation: 'status',
      task_id: 'task-beta',
      request_id: 'request-alpha-status',
      project_root: started.root,
    });
    expect(mismatch.error).toMatchObject({ code: -32602 });
  });

  it('surfaces task_binding_required for an unbound shared-agent client', async () => {
    const started = await harness();
    bind(started, 'unbound');

    expect((await call('psyche_control_list', {
      project_root: started.root,
    })).error).toMatchObject({
      code: MCP_CONTROL_ERROR_CODE,
      data: { code: 'task_binding_required' },
    });
    expect(payload(await call('psyche_control_lease', {
      operation: 'request',
      ttl_ms: 60_000,
      grants: [{
        target: {
          kind: 'pane',
          id: started.resources.alpha.id,
          generation: started.resources.alpha.generation,
        },
        capabilities: ['pane.observe'],
      }],
      project_root: started.root,
    }))).toMatchObject({
      status: 'rejected',
      code: 'task_binding_required',
    });
  });

  it('allows alpha to request and release its own lease without task_id arguments', async () => {
    const started = await harness();
    bind(started, 'alpha');

    const requested = payload(await call('psyche_control_lease', {
      operation: 'request',
      ttl_ms: 60_000,
      grants: [{
        target: {
          kind: 'pane',
          id: started.resources.alpha.id,
          generation: started.resources.alpha.generation,
        },
        capabilities: ['pane.observe'],
      }],
      project_root: started.root,
    }));
    expect(requested).toMatchObject({
      status: 'succeeded',
      value: { requestId: expect.any(String) },
    });
    const granted = await started.grantLease(requested.value.requestId);

    expect(payload(await call('psyche_control_lease', {
      operation: 'release',
      lease_id: granted.id,
      lease_revision: granted.revision,
      project_root: started.root,
    }))).toMatchObject({ status: 'succeeded' });
    expect(payload(await call('psyche_control_lease', {
      operation: 'status',
      request_id: requested.value.requestId,
      project_root: started.root,
    }))).toEqual({ requests: [], leases: [] });
  });
});

function connectionError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
