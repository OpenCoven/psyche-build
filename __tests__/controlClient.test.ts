import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
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

async function startHarness(overrides: {
  submit?: ControlServerRuntime['submit'];
  ownerEpoch?: number;
  snapshot?: ControlServerRuntime['snapshot'];
  readEvents?: ControlServerRuntime['readEvents'];
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

  it.each([
    ['failed', 'effect_failed'],
    ['unknown', 'effect_unknown'],
    ['failed', 'action_validation_failed'],
    ['failed', 'action_invalidated'],
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
