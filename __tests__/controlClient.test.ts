import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlServer, type ControlServerRuntime } from '../src/control/server.js';
import { createControlCredentialStore } from '../src/control/credentials.js';
import { ControlClient } from '../src/control/client.js';

interface Harness {
  server: ControlServer;
  endpoint: string;
  projectRoot: string;
  operatorToken: string;
  agentToken: string;
  submit: ReturnType<typeof vi.fn>;
}

let cleanups: Array<() => Promise<void>> = [];
let tempRoots: string[] = [];

function socketPath(): string {
  return path.join(tmpdir(), `psyche-ctl-${randomBytes(6).toString('hex')}.sock`);
}

async function startHarness(overrides: {
  submit?: ControlServerRuntime['submit'];
  ownerEpoch?: number;
  snapshot?: ControlServerRuntime['snapshot'];
  actionStatus?: NonNullable<ControlServerRuntime['actionStatus']>;
} = {}): Promise<Harness> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'psyche-ctl-proj-'));
  tempRoots.push(projectRoot);

  const submit = vi.fn(overrides.submit
    ?? (async (command) => ({ status: 'succeeded' as const, value: { actorKind: command.actor.kind } })));
  const runtime: ControlServerRuntime = {
    submit: submit as unknown as ControlServerRuntime['submit'],
    snapshot: overrides.snapshot
      ?? (() => ({ ownerEpoch: overrides.ownerEpoch ?? 7, sequence: 2, commands: {}, leases: {} })),
    readEvents: (after) => ({
      events: [{ sequence: after + 1, kind: 'command.requested', payload: {} }],
      nextSequence: after + 1,
      gap: false,
    }),
    actionStatus: overrides.actionStatus,
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
  });
  cleanups.push(() => server.close());

  return {
    server,
    endpoint,
    projectRoot,
    operatorToken: await credentials.operatorToken(),
    agentToken: await credentials.agentToken(),
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
  it('aborts a stalled welcome handshake and closes the Unix socket', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'psyche-stalled-proj-'));
    tempRoots.push(projectRoot);
    const endpoint = socketPath();
    let peerClosed!: () => void;
    const closed = new Promise<void>((resolve) => { peerClosed = resolve; });
    let peerAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => { peerAccepted = resolve; });
    let peer: import('node:net').Socket | undefined;
    const server = createServer((socket) => {
      peer = socket;
      peerAccepted();
      socket.on('error', () => undefined);
      socket.once('close', peerClosed);
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    cleanups.push(async () => {
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const controller = new AbortController();
    const connecting = ControlClient.connect({
      projectRoot, endpoint, token: 'token', clientName: 'stalled', signal: controller.signal,
    });
    await accepted;
    controller.abort();
    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ])).resolves.toBe(true);
  });
  it('serializes pipelined hello and following frames in wire order', async () => {
    const harness = await startHarness();
    const socket = connect(harness.endpoint);
    socket.setEncoding('utf8');
    const responses = new Promise<string[]>((resolve, reject) => {
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.trim().split('\n');
        if (lines.length >= 2) resolve(lines);
      });
      socket.on('error', reject);
    });
    socket.write(`${JSON.stringify({
      version: 1, type: 'hello', requestId: 'hello', token: harness.operatorToken,
      clientName: 'pipeline', projectRoot: harness.projectRoot,
    })}\n${JSON.stringify({ version: 1, type: 'state.get', requestId: 'state-pipeline' })}\n`);
    const lines = (await responses).map((line) => JSON.parse(line));
    expect(lines.map(({ type }) => type)).toEqual(['welcome', 'state.result']);
    socket.destroy();
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

  it('projects exact recent receipt paths only to operators across agent reconnects', async () => {
    const recentReceipt = {
      commandId: 'cmd-private', actionKind: 'browser.action' as const, outcome: 'succeeded' as const,
      timestamp: '2026-08-14T12:00:00.000Z', agentId: 'agent-1', taskId: 'task-1',
      projectRoot: '/repo-private', worktreeRoot: '/worktree-private',
      resource: { kind: 'browser_tab' as const, id: 'tab-1', generation: 1 },
      redacted: true as const, result: 'result_unavailable' as const,
    };
    const harness = await startHarness({ snapshot: () => ({
      ownerEpoch: 7, sequence: 2, commands: {}, leases: {}, receipts: [recentReceipt],
    }) });
    const operator = await ControlClient.connect({ projectRoot: harness.projectRoot, endpoint: harness.endpoint,
      token: harness.operatorToken, clientName: 'operator' });
    cleanups.push(() => operator.close());
    expect(await operator.getState()).toMatchObject({ receipts: [recentReceipt] });

    for (const clientName of ['agent-first', 'agent-reconnected']) {
      const agent = await ControlClient.connect({ projectRoot: harness.projectRoot, endpoint: harness.endpoint,
        token: harness.agentToken, clientName });
      const state = await agent.getState();
      expect(state).not.toHaveProperty('receipts');
      const serialized = JSON.stringify(state);
      for (const secret of ['/repo-private', '/worktree-private', 'screenshot', 'secret', 'value', 'https://private.test']) {
        expect(serialized).not.toContain(secret);
      }
      await agent.close();
    }
  });

  it('builds typed lease and approval helper commands while the server stamps actor and epoch', async () => {
    const harness = await startHarness();
    const client = await ControlClient.connect({
      projectRoot: harness.projectRoot, endpoint: harness.endpoint,
      token: harness.operatorToken, clientName: 'test-operator',
    });
    cleanups.push(() => client.close());

    await client.requestLease({
      id: 'cmd-request', idempotencyKey: 'idem-request',
      createdAt: '2026-08-12T12:00:00.000Z',
      payload: { taskId: 'task-1', ttlMs: 1000, grants: [] },
    });
    await client.releaseLease({
      id: 'cmd-release', idempotencyKey: 'idem-release',
      createdAt: '2026-08-12T12:00:00.000Z',
      payload: { taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1 },
    });
    await client.resolveApproval({
      id: 'cmd-resolve', idempotencyKey: 'idem-resolve',
      createdAt: '2026-08-12T12:00:00.000Z',
      payload: { approvalId: 'approval-1', payloadDigest: '0'.repeat(64), decision: 'approve' },
    });

    expect(harness.submit.mock.calls.map(([submitted]) => ({
      kind: submitted.kind, actor: submitted.actor.kind, ownerEpoch: submitted.ownerEpoch,
    }))).toEqual([
      { kind: 'lease.request', actor: 'human', ownerEpoch: 7 },
      { kind: 'lease.release', actor: 'human', ownerEpoch: 7 },
      { kind: 'approval.resolve', actor: 'human', ownerEpoch: 7 },
    ]);
  });

  it('gets canonical action status without scanning snapshot receipts', async () => {
    const harness = await startHarness({
      actionStatus: (actionId) => actionId === 'action-1'
        ? {
            schema: 'psyche.control.receipt/v1', actionId, state: 'approval_required',
            resource: { kind: 'browser_tab', id: 'tab-1', generation: 2 },
            createdAt: '2026-08-12T12:00:00.000Z', code: 'approval_required',
          }
        : undefined,
    });
    const client = await ControlClient.connect({
      projectRoot: harness.projectRoot, endpoint: harness.endpoint,
      token: harness.operatorToken, clientName: 'test-operator',
    });
    cleanups.push(() => client.close());
    await expect(client.actionStatus('action-1')).resolves.toMatchObject({
      actionId: 'action-1', state: 'approval_required',
    });
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it.each(['lease.grant', 'lease.revoke', 'approval.resolve'] as const)(
    'rejects agent %s before runtime dispatch',
    async (kind) => {
      const harness = await startHarness();
      const client = await ControlClient.connect({
        projectRoot: harness.projectRoot, endpoint: harness.endpoint,
        token: harness.agentToken, clientName: 'test-agent',
      });
      cleanups.push(() => client.close());
      const payload = kind === 'lease.grant'
        ? { requestId: 'r', actorId: 'agent', taskId: 'task', ttlMs: 1, grants: [] }
        : kind === 'lease.revoke'
          ? { leaseId: 'lease-1' }
          : { approvalId: 'approval-1', payloadDigest: '0'.repeat(64), decision: 'approve' as const };
      const outcome = await client.submit({
        id: `cmd-${kind}`, idempotencyKey: `idem-${kind}`, kind,
        projectRoot: harness.projectRoot, createdAt: '2026-08-12T12:00:00.000Z', payload,
      } as Parameters<ControlClient['submit']>[0]);
      expect(outcome).toMatchObject({ status: 'rejected', code: 'agent_mutation_denied' });
      expect(harness.submit).not.toHaveBeenCalled();
    },
  );

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
