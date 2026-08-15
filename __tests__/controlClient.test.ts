import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlServer, type ControlServerRuntime } from '../src/control/server.js';
import { createControlCredentialStore } from '../src/control/credentials.js';
import { ControlClient } from '../src/control/client.js';

interface Harness {
  server: ControlServer;
  endpoint: string;
  projectRoot: string;
  operatorToken: string;
  submit: ReturnType<typeof vi.fn>;
}

let cleanups: Array<() => Promise<void>> = [];
let tempRoots: string[] = [];

function socketPath(): string {
  return path.join(tmpdir(), `psyche-ctl-${randomBytes(6).toString('hex')}.sock`);
}

function welcomeFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    type: 'welcome',
    requestId: 'welcome',
    projectRoot: '/canonical/project',
    ownerEpoch: 7,
    principal: {
      id: 'agent',
      kind: 'agent',
      capabilities: ['read', 'mutate'],
    },
    ...overrides,
  };
}

async function startWelcomeFrameServer(frame: Record<string, unknown>): Promise<{
  endpoint: string;
  closed: Promise<void>;
}> {
  const endpoint = socketPath();
  let acceptedSocket: Socket | undefined;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const server = createServer((socket) => {
    acceptedSocket = socket;
    socket.once('close', () => markClosed());
    socket.once('data', () => {
      socket.write(`${JSON.stringify(frame)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  cleanups.push(async () => {
    acceptedSocket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { endpoint, closed };
}

async function startErrorResponseServer(code: string, message: string): Promise<string> {
  const endpoint = socketPath();
  let acceptedSocket: Socket | undefined;
  const server = createServer((socket) => {
    acceptedSocket = socket;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (request.type === 'hello') {
          socket.write(`${JSON.stringify(welcomeFrame())}\n`);
        } else {
          socket.write(`${JSON.stringify({
            version: 1,
            type: 'error',
            requestId: request.requestId,
            code,
            message,
          })}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  cleanups.push(async () => {
    acceptedSocket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return endpoint;
}

async function startDedicatedReadServer(): Promise<{
  endpoint: string;
  requests: Record<string, unknown>[];
}> {
  const endpoint = socketPath();
  const requests: Record<string, unknown>[] = [];
  let acceptedSocket: Socket | undefined;
  const server = createServer((socket) => {
    acceptedSocket = socket;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (request.type === 'hello') {
          socket.write(`${JSON.stringify(welcomeFrame({
            taskBinding: { taskId: 'task-alpha' },
          }))}\n`);
          continue;
        }
        requests.push(request);
        if (request.type === 'task.resources.get') {
          socket.write(`${JSON.stringify({
            version: 1,
            type: 'task.resources.result',
            requestId: request.requestId,
            ownerEpoch: 7,
            sequence: 11,
            resources: [],
          })}\n`);
        } else if (request.type === 'lease.status.get') {
          socket.write(`${JSON.stringify({
            version: 1,
            type: 'lease.status.result',
            requestId: request.requestId,
            requests: [],
            leases: [],
          })}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  cleanups.push(async () => {
    acceptedSocket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { endpoint, requests };
}

async function startHarness(overrides: {
  submit?: ControlServerRuntime['submit'];
  ownerEpoch?: number;
  snapshot?: ControlServerRuntime['snapshot'];
  readEvents?: ControlServerRuntime['readEvents'];
  operatorCommandPolicy?: 'disabled' | 'trusted-test-only';
} = {}): Promise<Harness> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'psyche-ctl-proj-'));
  tempRoots.push(projectRoot);

  const submit = vi.fn(overrides.submit
    ?? (async (command) => ({ status: 'succeeded' as const, value: { actorKind: command.actor.kind } })));
  const runtime: ControlServerRuntime = {
    submit: submit as unknown as ControlServerRuntime['submit'],
    snapshot: overrides.snapshot ?? (() => ({
      ownerEpoch: overrides.ownerEpoch ?? 7, sequence: 2, commands: {}, leases: {},
      resources: [], capabilityLeases: [], leaseRequests: [], approvals: [], receipts: [],
    })),
    readEvents: overrides.readEvents ?? ((after) => ({
      events: [{ sequence: after + 1, kind: 'command.requested', payload: {} }],
      nextSequence: after + 1,
      gap: false,
    })),
  };

  const credentials = await createControlCredentialStore({
    projectRoot,
    filePath: path.join(projectRoot, 'creds.json'),
  });
  const endpoint = socketPath();
  const server = await ControlServer.start({
    endpoint,
    projectRoot,
    ownerEpoch: overrides.ownerEpoch ?? 7,
    runtime,
    credentials,
    operatorCommandPolicy: overrides.operatorCommandPolicy ?? 'trusted-test-only',
  });
  cleanups.push(() => server.close());

  return {
    server,
    endpoint,
    projectRoot,
    operatorToken: await credentials.operatorToken(),
    submit: submit as unknown as ReturnType<typeof vi.fn>,
  };
}

afterEach(async () => {
  await Promise.all(cleanups.map((fn) => fn().catch(() => undefined)));
  cleanups = [];
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

function inputCommand(id: string): Parameters<ControlClient['submit']>[0] {
  return {
    id,
    idempotencyKey: `idem-${id}`,
    kind: 'pane.resize',
    projectRoot: '/will-be-overwritten',
    createdAt: new Date().toISOString(),
    payload: { paneId: '%1', cols: 80, rows: 24 },
  };
}

describe('ControlClient over the socket transport', () => {
  it('disables bearer-token operator commands unless a native authority broker opts in', async () => {
    const harness = await startHarness({ operatorCommandPolicy: 'disabled' });
    const client = await ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: harness.operatorToken,
      clientName: 'untrusted-operator',
    });
    cleanups.push(() => client.close());

    await expect(client.submit(inputCommand('disabled-operator'))).resolves.toMatchObject({
      status: 'rejected', code: 'operator_authority_unavailable',
    });
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it('aborts and closes a socket that accepts but never sends welcome', async () => {
    const endpoint = socketPath();
    let markConnected!: () => void;
    let markClosed!: () => void;
    const connected = new Promise<void>((resolve) => { markConnected = resolve; });
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const server = createServer((socket) => {
      markConnected();
      socket.on('data', () => undefined);
      socket.once('close', () => markClosed());
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });
    cleanups.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const controller = new AbortController();
    const pending = ControlClient.connectCanonical({
      projectRoot: '/canonical/project', endpoint, token: 'secret', clientName: 'deadline-test',
      signal: controller.signal,
    });
    await connected;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    await closed;
  });

  it('rejects and closes a welcome bound to a different task', async () => {
    const server = await startWelcomeFrameServer(welcomeFrame({
      taskBinding: { taskId: 'task-alpha' },
    }));

    await expect(ControlClient.connectCanonical({
      projectRoot: '/canonical/project',
      endpoint: server.endpoint,
      token: 'task-alpha-token',
      clientName: 'task-beta-client',
      taskBinding: { taskId: 'task-beta' },
    })).rejects.toThrow('welcome task binding does not match the requested task');
    await server.closed;
  });

  it.each([
    ['version', { version: 2 }],
    ['requestId', { requestId: 'not-welcome' }],
    ['projectRoot', { projectRoot: '' }],
    ['principal', {
      principal: { id: 'agent', kind: 'unknown', capabilities: ['read', 'mutate'] },
    }],
    ['ownerEpoch', { ownerEpoch: 0 }],
    ['taskBinding', { taskBinding: { taskId: 'task-alpha', injected: true } }],
    ['oversized taskBinding', { taskBinding: { taskId: 't'.repeat(257) } }],
  ])('rejects and closes a malformed welcome %s', async (_field, overrides) => {
    const server = await startWelcomeFrameServer(welcomeFrame(overrides));

    await expect(ControlClient.connectCanonical({
      projectRoot: '/canonical/project',
      endpoint: server.endpoint,
      token: 'task-alpha-token',
      clientName: 'malformed-welcome-client',
    })).rejects.toThrow('invalid welcome frame');
    await server.closed;
  });

  it('learns the owner epoch and principal from welcome', async () => {
    const harness = await startHarness();
    const client = await ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: harness.operatorToken,
      clientName: 'test-operator',
    });
    cleanups.push(() => client.close());

    expect(client.ownerEpoch).toBe(7);
    expect(client.principal).toMatchObject({ kind: 'operator' });
    expect(client.projectRoot).toContain(path.basename(harness.projectRoot));
  });

  it('submits a command and returns the runtime outcome with canonical project root', async () => {
    const harness = await startHarness();
    const client = await ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: harness.operatorToken,
      clientName: 'test-operator',
    });
    cleanups.push(() => client.close());

    const outcome = await client.submit(inputCommand('cmd-1'));
    expect(outcome).toMatchObject({ status: 'succeeded', value: { actorKind: 'human' } });
    expect(harness.submit).toHaveBeenCalledTimes(1);
    const submitted = harness.submit.mock.calls[0][0];
    expect(submitted.projectRoot).toBe(client.projectRoot);
    expect(submitted.ownerEpoch).toBe(7);
    expect(submitted.actor).toMatchObject({ kind: 'human' });
  });

  it('reads snapshot state and event pages', async () => {
    const harness = await startHarness();
    const client = await ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: harness.operatorToken,
      clientName: 'test-operator',
    });
    cleanups.push(() => client.close());

    await expect(client.getState()).resolves.toMatchObject({ ownerEpoch: 7, sequence: 2 });
    await expect(client.readEvents(0)).resolves.toMatchObject({ nextSequence: 1, gap: false });
  });

  it('sends dedicated reads without a caller-supplied task ID', async () => {
    const server = await startDedicatedReadServer();
    const client = await ControlClient.connectCanonical({
      projectRoot: '/canonical/project',
      endpoint: server.endpoint,
      token: 'task-alpha-token',
      clientName: 'task-alpha',
      taskBinding: { taskId: 'task-alpha' },
    });
    cleanups.push(() => client.close());

    await expect(client.taskResources()).resolves.toEqual({
      ownerEpoch: 7,
      sequence: 11,
      resources: [],
    });
    await expect(client.leaseStatus('request-alpha')).resolves.toEqual({
      requests: [],
      leases: [],
    });
    await expect(client.leaseStatus('request-alpha', 'lease-alpha')).resolves.toEqual({
      requests: [],
      leases: [],
    });
    expect(server.requests).toEqual([
      {
        version: 1,
        type: 'task.resources.get',
        requestId: 'req-1',
      },
      {
        version: 1,
        type: 'lease.status.get',
        requestId: 'req-2',
        leaseRequestId: 'request-alpha',
      },
      {
        version: 1,
        type: 'lease.status.get',
        requestId: 'req-3',
        leaseRequestId: 'request-alpha',
        leaseId: 'lease-alpha',
      },
    ]);
  });

  it.each([
    ['operator_required', 'only an operator may perform this request'],
    ['task_binding_required', 'task-bound control credential required'],
    ['task_binding_mismatch', 'command task does not match authenticated task'],
  ])('preserves the %s response code on client errors', async (code, message) => {
    const endpoint = await startErrorResponseServer(code, message);
    const client = await ControlClient.connectCanonical({
      projectRoot: '/canonical/project',
      endpoint,
      token: 'token',
      clientName: 'coded-error-client',
    });
    cleanups.push(() => client.close());

    await expect(client.getState()).rejects.toMatchObject({
      code,
      message: `${code}: ${message}`,
    });
  });

  it('preserves structured errors from dedicated reads', async () => {
    const endpoint = await startErrorResponseServer(
      'task_binding_required',
      'task-bound control credential required',
    );
    const client = await ControlClient.connectCanonical({
      projectRoot: '/canonical/project',
      endpoint,
      token: 'shared-token',
      clientName: 'shared-agent',
    });
    cleanups.push(() => client.close());

    await expect(client.taskResources()).rejects.toMatchObject({
      code: 'task_binding_required',
      message: 'task_binding_required: task-bound control credential required',
    });
    await expect(client.leaseStatus('request-alpha')).rejects.toMatchObject({
      code: 'task_binding_required',
      message: 'task_binding_required: task-bound control credential required',
    });
  });

  it('constructs lease, approval, and action-status helper envelopes', async () => {
    const harness = await startHarness();
    const client = await ControlClient.connect({
      projectRoot: harness.projectRoot, endpoint: harness.endpoint,
      token: harness.operatorToken, clientName: 'test-operator',
    });
    cleanups.push(() => client.close());
    await client.requestLease({
      id: 'request-1', idempotencyKey: 'request-1', kind: 'lease.request', projectRoot: '/ignored',
      createdAt: '2026-08-12T12:00:00.000Z', payload: { taskId: 'task-1', ttlMs: 60_000, grants: [] },
    });
    await client.resolveApproval({
      id: 'resolve-1', idempotencyKey: 'resolve-1', kind: 'approval.resolve', projectRoot: '/ignored',
      createdAt: '2026-08-12T12:00:00.000Z',
      payload: { approvalId: 'approval-1', payloadDigest: 'a'.repeat(64), decision: 'approve' },
    });
    await expect(client.actionStatus('missing')).resolves.toBeUndefined();
    expect(harness.submit.mock.calls.map(([submitted]) => submitted.kind))
      .toEqual(['lease.request', 'approval.resolve']);
  });

  it('bounds missing action history lookup to the recent journal window', async () => {
    const readEvents = vi.fn((after: number, limit?: number) => ({
      events: Array.from({ length: limit ?? 0 }, (_, index) => ({
        sequence: after + index + 1, kind: 'command.succeeded', payload: {},
      })),
      nextSequence: after + (limit ?? 0),
      gap: false,
    }));
    const harness = await startHarness({
      snapshot: () => ({
        ownerEpoch: 7, sequence: 50_000, commands: {}, leases: {}, resources: [],
        capabilityLeases: [], leaseRequests: [], approvals: [], receipts: [],
      }),
      readEvents,
    });
    const client = await ControlClient.connect({
      projectRoot: harness.projectRoot, endpoint: harness.endpoint,
      token: harness.operatorToken, clientName: 'bounded-history',
    });
    cleanups.push(() => client.close());

    await expect(client.actionStatus('too-old-or-missing')).resolves.toBeUndefined();
    expect(readEvents.mock.calls.length).toBeLessThanOrEqual(4);
    expect(readEvents.mock.calls[0][0]).toBeGreaterThanOrEqual(49_000);
  });

  it('recovers a recent receipt from the bounded tail of a large journal', async () => {
    const receipt = {
      schema: 'psyche.control.receipt/v1' as const,
      actionId: 'recent-large-journal', state: 'succeeded' as const,
      resource: { kind: 'pane' as const, id: 'pane-1', generation: 1 },
      createdAt: '2026-08-12T12:00:00.000Z', completedAt: '2026-08-12T12:00:01.000Z',
    };
    const readEvents = vi.fn((after: number) => ({
      events: [{ sequence: after + 1, kind: 'command.succeeded', payload: { receipt } }],
      nextSequence: after + 1,
      gap: false,
    }));
    const harness = await startHarness({
      snapshot: () => ({
        ownerEpoch: 7, sequence: 50_000, commands: {}, leases: {}, resources: [],
        capabilityLeases: [], leaseRequests: [], approvals: [], receipts: [],
      }),
      readEvents,
    });
    const client = await ControlClient.connect({
      projectRoot: harness.projectRoot, endpoint: harness.endpoint,
      token: harness.operatorToken, clientName: 'recent-history',
    });
    cleanups.push(() => client.close());

    await expect(client.actionStatus(receipt.actionId)).resolves.toEqual(receipt);
    expect(readEvents).toHaveBeenCalledOnce();
    expect(readEvents.mock.calls[0][0]).toBe(49_000);
  });

  it.each([
    ['failed', 'effect_failed'],
    ['unknown', 'effect_unknown'],
    ['failed', 'action_validation_failed'],
    ['failed', 'action_invalidated'],
    ['failed', 'approval_expired'],
  ] as const)('recovers %s action status from the journal after receipt eviction', async (state, code) => {
    const receipt = {
      schema: 'psyche.control.receipt/v1' as const,
      actionId: `evicted-${code}`, state,
      resource: { kind: 'browser_tab' as const, id: 'tab-1', generation: 1 },
      createdAt: '2026-08-12T12:00:00.000Z', completedAt: '2026-08-12T12:00:01.000Z',
      code,
    };
    const harness = await startHarness({
      readEvents: () => ({
        events: [{ sequence: 9, kind: state === 'failed' ? 'command.failed' : 'command.unknown', payload: { receipt } }],
        nextSequence: 9, gap: false,
      }),
    });
    const client = await ControlClient.connect({ projectRoot: harness.projectRoot, endpoint: harness.endpoint,
      token: harness.operatorToken, clientName: 'test-operator' });
    cleanups.push(() => client.close());
    await expect(client.actionStatus(`evicted-${code}`)).resolves.toEqual(receipt);
  });

  it('rejects a connection whose declared project root does not match the owner', async () => {
    const harness = await startHarness();
    const otherRoot = await mkdtemp(path.join(tmpdir(), 'psyche-ctl-other-'));
    tempRoots.push(otherRoot);

    await expect(ControlClient.connect({
      projectRoot: otherRoot,
      endpoint: harness.endpoint,
      token: harness.operatorToken,
      clientName: 'test-operator',
    })).rejects.toThrow(/project_mismatch/);
  });

  it('rejects an invalid token at connect', async () => {
    const harness = await startHarness();
    await expect(ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: 'wrong-token',
      clientName: 'test-operator',
    })).rejects.toThrow(/unauthorized/);
  });

  it('rejects in-flight requests when the connection drops and never resolves them', async () => {
    let release: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => { release = resolve; });
    const harness = await startHarness({
      submit: (async () => {
        await hang;
        return { status: 'succeeded' as const };
      }) as ControlServerRuntime['submit'],
    });
    const client = await ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: harness.operatorToken,
      clientName: 'test-operator',
    });

    const pending = client.submit(inputCommand('cmd-hang'));
    const rejection = expect(pending).rejects.toThrow(/closed/);
    await harness.server.close();
    await rejection;
    release?.();
  });

  it('rejects an unknown command kind as bad_request without reaching the runtime', async () => {
    const harness = await startHarness();
    const client = await ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: harness.operatorToken,
      clientName: 'test-operator',
    });
    cleanups.push(() => client.close());

    const bogus = {
      ...inputCommand('cmd-bogus'),
      kind: 'pane.nonexistent',
    } as unknown as Parameters<ControlClient['submit']>[0];
    const outcome = await client.submit(bogus);
    expect(outcome).toMatchObject({ status: 'rejected', code: 'bad_request' });
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it('closes cleanly and resolves close() even after the socket is gone', async () => {
    const harness = await startHarness();
    const client = await ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: harness.operatorToken,
      clientName: 'test-operator',
    });
    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
  });
});
