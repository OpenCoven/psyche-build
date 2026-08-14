import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlClient } from '../src/control/client.js';
import { createControlCredentialStore } from '../src/control/credentials.js';
import { ControlServer, type ControlServerRuntime } from '../src/control/server.js';
import type { ControlSnapshot } from '../src/control/types.js';
import {
  TOOLS,
  closeMcpControlClients,
  createMcpControlClientForRoot,
  handleMcpRequest,
  setMcpDeps,
} from '../src/mcp/server.js';

const restores: Array<() => void> = [];
let cleanups: Array<() => Promise<void>> = [];
let tempRoots: string[] = [];
afterEach(async () => {
  while (restores.length) restores.pop()!();
  await Promise.allSettled(cleanups.map(async (close) => close()));
  cleanups = [];
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
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

function scopedSnapshot(projectRoot: string): ControlSnapshot {
  return {
    ownerEpoch: 1,
    sequence: 9,
    commands: {
      'approval-own-action': {
        command: { id: 'approval-own-action', payload: { taskId: 'task-own' } },
        outcome: { status: 'succeeded' },
        sequence: 4,
      },
      'approval-other-action': {
        command: { id: 'approval-other-action', payload: { taskId: 'task-other' } },
        outcome: { status: 'succeeded' },
        sequence: 5,
      },
      'receipt-own-action': {
        command: { id: 'receipt-own-action', payload: { taskId: 'task-own' } },
        outcome: { status: 'succeeded' },
        sequence: 6,
      },
      'receipt-other-action': {
        command: { id: 'receipt-other-action', payload: { taskId: 'task-other' } },
        outcome: { status: 'succeeded' },
        sequence: 7,
      },
    },
    leases: {
      'pane-own': {
        paneId: 'pane-own',
        actorId: 'agent',
        actorKind: 'psyche',
        taskId: 'task-own',
        revision: 2,
        expiresAt: '2026-08-12T01:00:00.000Z',
      },
      'pane-other': {
        paneId: 'pane-other',
        actorId: 'agent',
        actorKind: 'psyche',
        taskId: 'task-other',
        revision: 3,
        expiresAt: '2026-08-12T01:00:00.000Z',
      },
    },
    resources: [
      {
        kind: 'pane',
        id: 'pane-own',
        generation: 2,
        projectRoot,
        worktreeRoot: projectRoot,
        tmuxPaneId: '%1',
        writable: true,
        outputSequence: 3,
      },
      {
        kind: 'pane',
        id: 'pane-other',
        generation: 3,
        projectRoot,
        worktreeRoot: projectRoot,
        tmuxPaneId: '%2',
        writable: true,
        outputSequence: 4,
      },
      {
        kind: 'browser_tab',
        id: 'tab-own',
        generation: 4,
        projectRoot,
        worktreeRoot: projectRoot,
        providerId: 'desktop-own',
        webviewLabel: 'own',
        url: 'https://own.example',
        title: 'Own',
        loading: false,
        viewport: { width: 1280, height: 720 },
      },
      {
        kind: 'browser_tab',
        id: 'tab-other',
        generation: 5,
        projectRoot,
        worktreeRoot: projectRoot,
        providerId: 'desktop-other',
        webviewLabel: 'other',
        url: 'https://other.example',
        title: 'Other',
        loading: false,
        viewport: { width: 1280, height: 720 },
      },
    ],
    capabilityLeases: [
      {
        id: 'lease-own',
        requestId: 'request-own',
        revision: 2,
        ownerEpoch: 1,
        actorId: 'agent',
        taskId: 'task-own',
        grantedBy: 'operator',
        grants: [
          {
            target: { kind: 'browser_tab', id: 'tab-own', generation: 4 },
            capabilities: ['browser.inspect'],
          },
        ],
        createdAt: '2026-08-12T00:00:00.000Z',
        expiresAt: '2026-08-12T01:00:00.000Z',
      },
      {
        id: 'lease-other',
        requestId: 'request-other',
        revision: 1,
        ownerEpoch: 1,
        actorId: 'agent',
        taskId: 'task-other',
        grantedBy: 'operator',
        grants: [
          {
            target: { kind: 'browser_tab', id: 'tab-other', generation: 5 },
            capabilities: ['browser.inspect'],
          },
        ],
        createdAt: '2026-08-12T00:00:00.000Z',
        expiresAt: '2026-08-12T01:00:00.000Z',
      },
    ],
    leaseRequests: [
      {
        id: 'request-own',
        ownerEpoch: 1,
        actorId: 'agent',
        taskId: 'task-own',
        status: 'pending',
        createdAt: '2026-08-12T00:00:00.000Z',
        ttlMs: 60_000,
        grants: [
          {
            target: { kind: 'pane', id: 'pane-own', generation: 2 },
            capabilities: ['pane.observe'],
          },
        ],
      },
      {
        id: 'request-other',
        ownerEpoch: 1,
        actorId: 'agent',
        taskId: 'task-other',
        status: 'pending',
        createdAt: '2026-08-12T00:00:00.000Z',
        ttlMs: 60_000,
        grants: [
          {
            target: { kind: 'pane', id: 'pane-other', generation: 3 },
            capabilities: ['pane.observe'],
          },
        ],
      },
    ],
    approvals: [
      {
        id: 'approval-own',
        status: 'pending',
        actionId: 'approval-own-action',
        ownerEpoch: 1,
        leaseId: 'lease-own',
        leaseRevision: 2,
        resource: { kind: 'browser_tab', id: 'tab-own', generation: 4 },
        capability: 'browser.inspect',
        effect: { kind: 'script', target: 'tab-own' },
        executablePayloadDigest: 'a'.repeat(64),
        payloadDigest: 'b'.repeat(64),
        createdAt: '2026-08-12T00:00:00.000Z',
        expiresAt: '2026-08-12T01:00:00.000Z',
      },
      {
        id: 'approval-other',
        status: 'pending',
        actionId: 'approval-other-action',
        ownerEpoch: 1,
        leaseId: 'lease-other',
        leaseRevision: 1,
        resource: { kind: 'browser_tab', id: 'tab-other', generation: 5 },
        capability: 'browser.inspect',
        effect: { kind: 'script', target: 'tab-other' },
        executablePayloadDigest: 'c'.repeat(64),
        payloadDigest: 'd'.repeat(64),
        createdAt: '2026-08-12T00:00:00.000Z',
        expiresAt: '2026-08-12T01:00:00.000Z',
      },
    ],
    receipts: [
      {
        schema: 'psyche.control.receipt/v1',
        actionId: 'receipt-own-action',
        state: 'succeeded',
        resource: { kind: 'pane', id: 'pane-own', generation: 2 },
        createdAt: '2026-08-12T00:00:00.000Z',
      },
      {
        schema: 'psyche.control.receipt/v1',
        actionId: 'receipt-other-action',
        state: 'succeeded',
        resource: { kind: 'pane', id: 'pane-other', generation: 3 },
        createdAt: '2026-08-12T00:00:00.000Z',
      },
    ],
  } as unknown as ControlSnapshot;
}

async function realAgentHarness(
  buildSnapshot: (projectRoot: string) => ControlSnapshot,
): Promise<{ connect: () => Promise<ControlClient>; projectRoot: string }> {
  const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'psyche-mcp-agent-')));
  tempRoots.push(projectRoot);
  const endpoint = path.join(projectRoot, 'control.sock');
  const credentials = await createControlCredentialStore({
    projectRoot,
    filePath: path.join(projectRoot, 'control-credentials.json'),
  });
  const snapshot = buildSnapshot(projectRoot);
  const runtime: ControlServerRuntime = {
    submit: vi.fn(async () => ({ status: 'succeeded' as const })),
    snapshot: () => snapshot,
    readEvents: () => ({ events: [], nextSequence: snapshot.sequence, gap: false }),
  };
  const server = await ControlServer.start({
    endpoint,
    projectRoot,
    ownerEpoch: snapshot.ownerEpoch,
    runtime,
    credentials,
  });
  cleanups.push(() => server.close());
  const token = await credentials.agentToken();
  return {
    projectRoot,
    connect: async () => {
      const client = await ControlClient.connect({
        projectRoot,
        endpoint,
        token,
        clientName: 'agent',
      });
      cleanups.push(() => client.close());
      return client;
    },
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

    const body = payload(await call('psyche_control_list', { project_root: '/repo', task_id: 'task-victim' }));
    expect(body).not.toHaveProperty('leases');
    expect(body).not.toHaveProperty('lease_requests');
    expect(JSON.stringify(body)).not.toContain('lease-victim');
    expect(JSON.stringify(body)).not.toContain('request-victim');
  });

  it('requires task scope for task-scoped read helpers', async () => {
    const client = fakeClient();
    inject({ controlClientForRoot: vi.fn(async () => client) });

    for (const name of ['psyche_control_list', 'psyche_list_panes']) {
      const response = await call(name, { project_root: '/repo' });
      expect(response.error.code).toBe(-32602);
    }
    expect(client.getState).not.toHaveBeenCalled();
  });

  it('keeps own scoped control data visible to an agent while hiding unrelated state', async () => {
    const { connect, projectRoot } = await realAgentHarness(scopedSnapshot);
    inject({ controlClientForRoot: vi.fn(async () => connect()) });

    const listed = payload(await call('psyche_control_list', {
      project_root: projectRoot,
      task_id: 'task-own',
    }));
    expect(listed).toMatchObject({
      project_root: projectRoot,
      resources: [
        { kind: 'pane', id: 'pane-own', generation: 2 },
        { kind: 'browser_tab', id: 'tab-own', generation: 4 },
      ],
      approvals: [{ id: 'approval-own', actionId: 'approval-own-action' }],
      receipts: [{ actionId: 'receipt-own-action' }],
    });
    expect(listed.resources).toHaveLength(2);
    expect(listed.approvals).toHaveLength(1);
    expect(listed.receipts).toHaveLength(1);

    const status = payload(await call('psyche_control_lease', {
      operation: 'status',
      project_root: projectRoot,
      task_id: 'task-own',
      request_id: 'request-own',
    }));
    expect(status).toMatchObject({
      leases: [{ id: 'lease-own', taskId: 'task-own' }],
      requests: [{ id: 'request-own', taskId: 'task-own' }],
    });
    expect(status.leases).toHaveLength(1);
    expect(status.requests).toHaveLength(1);

    const panes = payload(await call('psyche_list_panes', {
      project_root: projectRoot,
      task_id: 'task-own',
    }));
    expect(panes).toMatchObject({
      project_root: projectRoot,
      count: 1,
      panes: [{ kind: 'pane', id: 'pane-own', generation: 2 }],
    });

    for (const body of [listed, status, panes]) {
      for (const hidden of [
        'pane-other',
        'tab-other',
        'lease-other',
        'request-other',
        'approval-other',
        'receipt-other-action',
        'task-other',
      ]) {
        expect(JSON.stringify(body)).not.toContain(hidden);
      }
    }
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

    await call('psyche_control_list', { project_root: '/repo', task_id: 'task-1' });
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
