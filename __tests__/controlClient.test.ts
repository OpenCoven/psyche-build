import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlServer, type ControlServerRuntime } from '../src/control/server.js';
import {
  createControlCredentialStore,
  issueControlTaskCredential,
  issueControlTaskToken,
} from '../src/control/credentials.js';
import { ControlClient } from '../src/control/client.js';
import {
  cleanupTestControlStatePaths,
  createIsolatedTestControlStatePaths,
  createWorktreeTestControlStatePaths,
  type TestControlStatePaths,
} from './helpers/controlCredentialPaths.js';
import { createRestartActionStatusHarness } from './helpers/restartActionStatusHarness.js';
import { createTaskScopedControlHarness } from './helpers/taskScopedControlHarness.js';

interface Harness {
  server: ControlServer;
  endpoint: string;
  projectRoot: string;
  operatorToken: string;
  agentToken: string;
  submit: ReturnType<typeof vi.fn>;
}

let cleanups: Array<() => Promise<void>> = [];
let externalStateRoots: TestControlStatePaths[] = [];
let tempRoots: string[] = [];

function socketPath(): string {
  return path.join(tmpdir(), `psyche-ctl-${randomBytes(6).toString('hex')}.sock`);
}

function credentialsPath(projectRoot: string): string {
  return path.join(projectRoot, 'creds.json');
}

function controlStateRoot(projectRoot: string): string {
  return path.join(projectRoot, '.control-state');
}

async function workspaceProjectRoot(prefix: string): Promise<string> {
  const fixture = await createWorktreeTestControlStatePaths(prefix);
  externalStateRoots.push(fixture);
  return fixture.projectRoot;
}

async function startHarness(overrides: {
  submit?: ControlServerRuntime['submit'];
  ownerEpoch?: number;
  snapshot?: ControlServerRuntime['snapshot'];
  readEvents?: ControlServerRuntime['readEvents'];
  operatorCommandPolicy?: 'disabled' | 'trusted-test-only';
} = {}): Promise<Harness> {
  const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'psyche-ctl-proj-')));
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
    filePath: credentialsPath(projectRoot),
    stateRoot: controlStateRoot(projectRoot),
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
    agentToken: await credentials.agentToken(),
    submit: submit as unknown as ReturnType<typeof vi.fn>,
  };
}

afterEach(async () => {
  await Promise.all(cleanups.map((fn) => fn().catch(() => undefined)));
  cleanups = [];
  await cleanupTestControlStatePaths(externalStateRoots);
  externalStateRoots = [];
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

function taskScopedAgentCommands(input: {
  projectRoot: string;
  taskId: string;
  leaseId: string;
  leaseRevision: number;
  paneId: string;
  paneGeneration: number;
  tabId: string;
  tabGeneration: number;
  prefix: string;
}): Parameters<ControlClient['submit']>[0][] {
  const createdAt = new Date().toISOString();
  return [
    {
      id: `${input.prefix}-lease-request`,
      idempotencyKey: `${input.prefix}-lease-request`,
      kind: 'lease.request',
      projectRoot: input.projectRoot,
      createdAt,
      payload: { taskId: input.taskId, ttlMs: 60_000, grants: [] },
    },
    {
      id: `${input.prefix}-lease-release`,
      idempotencyKey: `${input.prefix}-lease-release`,
      kind: 'lease.release',
      projectRoot: input.projectRoot,
      createdAt,
      payload: {
        taskId: input.taskId,
        leaseId: input.leaseId,
        leaseRevision: input.leaseRevision,
      },
    },
    {
      id: `${input.prefix}-pane-observe`,
      idempotencyKey: `${input.prefix}-pane-observe`,
      kind: 'pane.observe',
      projectRoot: input.projectRoot,
      createdAt,
      payload: {
        taskId: input.taskId,
        leaseId: input.leaseId,
        leaseRevision: input.leaseRevision,
        paneId: input.paneId,
        generation: input.paneGeneration,
      },
    },
    {
      id: `${input.prefix}-pane-action`,
      idempotencyKey: `${input.prefix}-pane-action`,
      kind: 'pane.action',
      projectRoot: input.projectRoot,
      createdAt,
      payload: {
        taskId: input.taskId,
        leaseId: input.leaseId,
        leaseRevision: input.leaseRevision,
        paneId: input.paneId,
        generation: input.paneGeneration,
        action: { kind: 'focus' },
      },
    },
    {
      id: `${input.prefix}-browser-inspect`,
      idempotencyKey: `${input.prefix}-browser-inspect`,
      kind: 'browser.inspect',
      projectRoot: input.projectRoot,
      createdAt,
      payload: {
        taskId: input.taskId,
        leaseId: input.leaseId,
        leaseRevision: input.leaseRevision,
        tabId: input.tabId,
        generation: input.tabGeneration,
      },
    },
    {
      id: `${input.prefix}-browser-action`,
      idempotencyKey: `${input.prefix}-browser-action`,
      kind: 'browser.action',
      projectRoot: input.projectRoot,
      createdAt,
      payload: {
        taskId: input.taskId,
        leaseId: input.leaseId,
        leaseRevision: input.leaseRevision,
        tabId: input.tabId,
        generation: input.tabGeneration,
        action: { kind: 'reload' },
      },
    },
    {
      id: `${input.prefix}-browser-script`,
      idempotencyKey: `${input.prefix}-browser-script`,
      kind: 'browser.script',
      projectRoot: input.projectRoot,
      createdAt,
      payload: {
        taskId: input.taskId,
        leaseId: input.leaseId,
        leaseRevision: input.leaseRevision,
        tabId: input.tabId,
        generation: input.tabGeneration,
        source: 'return 1;',
      },
    },
    {
      id: `${input.prefix}-orchestration`,
      idempotencyKey: `${input.prefix}-orchestration`,
      kind: 'orchestration.execute',
      projectRoot: input.projectRoot,
      createdAt,
      payload: {
        taskId: input.taskId,
        leaseId: input.leaseId,
        leaseRevision: input.leaseRevision,
        request: {
          taskId: input.taskId,
          projectRoot: input.projectRoot,
          prompt: 'test prompt',
          lanes: [{ id: 'lane-1', mode: 'terminal' }],
        },
      },
    },
  ];
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

  it('fails closed when the welcome task binding does not match the requested task', async () => {
    const harness = await startHarness();
    const taskToken = await issueControlTaskToken({
      projectRoot: harness.projectRoot,
      filePath: credentialsPath(harness.projectRoot),
      taskId: 'task-own',
      stateRoot: controlStateRoot(harness.projectRoot),
    });

    await expect(ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: taskToken,
      clientName: 'mismatched-task-client',
      taskBinding: { taskId: 'task-other' },
    })).rejects.toThrow(/task binding/i);
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
      resource: { kind: 'pane' as const, idDigest: 'd'.repeat(64), generation: 1 },
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

  it('filters task-bound journal fallback by trusted receipt ownership and keeps legacy visible to operators', async () => {
    let scopedReceipt!: {
      schema: 'psyche.control.receipt/v1';
      actionId: string;
      state: 'failed';
      resource: { kind: 'browser_tab'; idDigest: string; generation: number };
      createdAt: string;
      completedAt: string;
      taskId: string;
      actorId: string;
      leaseId: string;
      leaseRevision: number;
      code: string;
    };
    let otherReceipt!: typeof scopedReceipt;
    const legacyReceipt = {
      schema: 'psyche.control.receipt/v1' as const,
      actionId: 'legacy-action',
      state: 'failed' as const,
      resource: { kind: 'browser_tab' as const, idDigest: 'b'.repeat(64), generation: 1 },
      createdAt: '2026-08-12T12:00:00.000Z',
      completedAt: '2026-08-12T12:00:01.000Z',
      code: 'effect_failed',
    };
    const readEvents = vi.fn(() => ({
      events: [
        { sequence: 1, kind: 'command.failed', payload: { receipt: otherReceipt } },
        { sequence: 2, kind: 'command.failed', payload: { receipt: legacyReceipt } },
        { sequence: 3, kind: 'command.failed', payload: { receipt: scopedReceipt } },
      ],
      nextSequence: 3,
      gap: false,
    }));
    const harness = await startHarness({
      snapshot: () => ({
        ownerEpoch: 7, sequence: 3, commands: {}, leases: {}, resources: [],
        capabilityLeases: [], leaseRequests: [], approvals: [], receipts: [],
      }),
      readEvents,
    });
    const issued = await issueControlTaskCredential({
      projectRoot: harness.projectRoot,
      filePath: credentialsPath(harness.projectRoot),
      taskId: 'task-own',
      stateRoot: controlStateRoot(harness.projectRoot),
    });
    scopedReceipt = {
      schema: 'psyche.control.receipt/v1',
      actionId: 'owned-action',
      state: 'failed',
      resource: { kind: 'browser_tab', idDigest: 'a'.repeat(64), generation: 1 },
      createdAt: '2026-08-12T12:00:00.000Z',
      completedAt: '2026-08-12T12:00:01.000Z',
      taskId: 'task-own',
      actorId: issued.principalId,
      leaseId: 'lease-own',
      leaseRevision: 2,
      code: 'effect_failed',
    };
    otherReceipt = {
      ...scopedReceipt,
      actionId: 'other-action',
      taskId: 'task-other',
      actorId: 'task-subject:other-subject',
      leaseId: 'lease-other',
    };
    const agent = await ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: issued.token,
      clientName: 'scoped-agent',
      taskBinding: issued.taskBinding,
    });
    const operator = await ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: harness.operatorToken,
      clientName: 'scoped-operator',
    });
    cleanups.push(() => agent.close(), () => operator.close());

    await expect(agent.actionStatus('owned-action', { taskId: 'task-other' })).resolves.toMatchObject({
      schema: 'psyche.control.receipt/v1',
      actionId: 'owned-action',
      state: 'failed',
      code: 'effect_failed',
    });
    const scoped = await agent.actionStatus('owned-action', { taskId: 'task-other' });
    expect(scoped).toBeDefined();
    expect(scoped).not.toHaveProperty('taskId');
    expect(scoped).not.toHaveProperty('actorId');
    expect(scoped).not.toHaveProperty('leaseId');
    expect(scoped).not.toHaveProperty('leaseRevision');
    await expect(agent.actionStatus('other-action', { taskId: 'task-other' })).resolves.toBeUndefined();
    await expect(agent.actionStatus('legacy-action', { taskId: 'task-other' })).resolves.toBeUndefined();
    await expect(operator.actionStatus('legacy-action')).resolves.toEqual(legacyReceipt);
  });

  it('isolates task-bound browser action receipts when different tasks reuse the same caller key', async () => {
    const projectRoot = await workspaceProjectRoot('psyche-ctl-idempotency-receipts');
    const endpoint = socketPath();
    const harness = await createTaskScopedControlHarness({ projectRoot, endpoint });
    cleanups.push(() => harness.server.close());

    const otherTabLease = harness.runtime.snapshot().capabilityLeases.find((lease) => (
      lease.taskId === harness.otherTaskId
      && lease.grants.some((grant) => (
        grant.target.kind === 'browser_tab' && grant.target.id === harness.otherTab.id
      ))
    ));
    expect(otherTabLease).toBeDefined();

    const ownClient = await ControlClient.connect({
      projectRoot,
      endpoint,
      token: harness.ownTaskToken,
      clientName: 'own-idempotency-scope',
      taskBinding: {
        taskId: harness.ownTaskId,
        subjectId: harness.ownSubjectId,
      },
    });
    const otherClient = await ControlClient.connect({
      projectRoot,
      endpoint,
      token: harness.otherTaskToken,
      clientName: 'other-idempotency-scope',
      taskBinding: {
        taskId: harness.otherTaskId,
        subjectId: harness.otherSubjectId,
      },
    });
    cleanups.push(() => ownClient.close(), () => otherClient.close());

    const sharedKey = 'shared-browser-action-key';
    const createdAt = '2026-08-15T03:15:37.241Z';
    const ownOutcome = await ownClient.submit({
      id: 'own-shared-action',
      idempotencyKey: sharedKey,
      kind: 'browser.action',
      projectRoot,
      createdAt,
      payload: {
        taskId: harness.ownTaskId,
        leaseId: harness.ownTabLease.id,
        leaseRevision: harness.ownTabLease.revision,
        tabId: harness.ownTab.id,
        generation: harness.ownTab.generation,
        snapshotId: 'snapshot-own',
        action: { kind: 'submit', elementRef: 'submit-own' },
      },
    });
    const otherOutcome = await otherClient.submit({
      id: 'other-shared-action',
      idempotencyKey: sharedKey,
      kind: 'browser.action',
      projectRoot,
      createdAt,
      payload: {
        taskId: harness.otherTaskId,
        leaseId: otherTabLease!.id,
        leaseRevision: otherTabLease!.revision,
        tabId: harness.otherTab.id,
        generation: harness.otherTab.generation,
        snapshotId: 'snapshot-other',
        action: { kind: 'submit', elementRef: 'submit-other' },
      },
    });

    expect(ownOutcome).toMatchObject({
      status: 'succeeded',
      value: { actionId: 'own-shared-action', state: 'approval_required' },
    });
    expect(otherOutcome).toMatchObject({
      status: 'succeeded',
      value: { actionId: 'other-shared-action', state: 'approval_required' },
    });
    await expect(ownClient.actionStatus('own-shared-action')).resolves.toMatchObject({
      actionId: 'own-shared-action',
      state: 'approval_required',
    });
    await expect(otherClient.actionStatus('other-shared-action')).resolves.toMatchObject({
      actionId: 'other-shared-action',
      state: 'approval_required',
    });
    await expect(otherClient.actionStatus('own-shared-action')).resolves.toBeUndefined();
  });

  it('replaces restart-stale approval_required status for operators and the owning bound agent', async () => {
    const harness = await createRestartActionStatusHarness({
      projectRoot: await workspaceProjectRoot('psyche-ctl-restart-status'),
    });
    cleanups.push(() => harness.server.close());

    expect(harness.runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: harness.ownActionId,
      state: 'failed',
      code: 'action_invalidated',
      taskId: harness.ownTaskId,
    }));
    expect(harness.runtime.snapshot().receipts).not.toContainEqual(expect.objectContaining({
      actionId: harness.ownActionId,
      state: 'approval_required',
    }));

    const operator = await ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: harness.operatorToken,
      clientName: 'restart-operator',
    });
    const ownAgent = await ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: harness.ownTaskToken,
      clientName: 'restart-own-agent',
      taskBinding: { taskId: harness.ownTaskId },
    });
    const otherAgent = await ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: harness.otherTaskToken,
      clientName: 'restart-other-agent',
      taskBinding: { taskId: harness.otherTaskId },
    });
    cleanups.push(() => operator.close(), () => ownAgent.close(), () => otherAgent.close());

    await expect(operator.actionStatus(harness.ownActionId)).resolves.toMatchObject({
      schema: 'psyche.control.receipt/v1',
      actionId: harness.ownActionId,
      state: 'failed',
      code: 'action_invalidated',
    });
    const scoped = await ownAgent.actionStatus(harness.ownActionId);
    expect(scoped).toMatchObject({
      schema: 'psyche.control.receipt/v1',
      actionId: harness.ownActionId,
      state: 'failed',
      code: 'action_invalidated',
    });
    expect(scoped).not.toHaveProperty('taskId');
    expect(scoped).not.toHaveProperty('leaseId');
    expect(scoped).not.toHaveProperty('leaseRevision');
    await expect(otherAgent.actionStatus(harness.ownActionId)).resolves.toBeUndefined();
    await expect(operator.actionStatus(harness.legacyActionId)).resolves.toMatchObject({
      actionId: harness.legacyActionId,
      state: 'failed',
      code: 'action_invalidated',
    });
    await expect(ownAgent.actionStatus(harness.legacyActionId)).resolves.toBeUndefined();
  });

  it('redacts raw event pages for unbound agents and returns only bound-task receipts with ownership removed', async () => {
    let scopedReceipt!: {
      schema: 'psyche.control.receipt/v1';
      actionId: string;
      state: 'failed';
      resource: { kind: 'browser_tab'; idDigest: string; generation: number };
      createdAt: string;
      completedAt: string;
      taskId: string;
      actorId: string;
      leaseId: string;
      leaseRevision: number;
      code: string;
    };
    let otherReceipt!: typeof scopedReceipt;
    const harness = await startHarness({
      readEvents: () => ({
        events: [
          { sequence: 1, kind: 'command.failed', payload: { receipt: otherReceipt } },
          { sequence: 2, kind: 'command.failed', payload: { receipt: scopedReceipt } },
        ],
        nextSequence: 2,
        gap: false,
      }),
    });
    const rawAgent = await ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: harness.agentToken,
      clientName: 'raw-scoped-reader',
    });
    const issued = await issueControlTaskCredential({
      projectRoot: harness.projectRoot,
      filePath: credentialsPath(harness.projectRoot),
      taskId: 'task-own',
      stateRoot: controlStateRoot(harness.projectRoot),
    });
    scopedReceipt = {
      schema: 'psyche.control.receipt/v1',
      actionId: 'owned-event',
      state: 'failed',
      resource: { kind: 'browser_tab', idDigest: 'c'.repeat(64), generation: 1 },
      createdAt: '2026-08-12T12:00:00.000Z',
      completedAt: '2026-08-12T12:00:01.000Z',
      taskId: 'task-own',
      actorId: issued.principalId,
      leaseId: 'lease-own',
      leaseRevision: 2,
      code: 'effect_failed',
    };
    otherReceipt = {
      ...scopedReceipt,
      actionId: 'other-event',
      taskId: 'task-other',
      actorId: 'task-subject:other-subject',
      leaseId: 'lease-other',
    };
    const boundAgent = await ControlClient.connect({
      projectRoot: harness.projectRoot,
      endpoint: harness.endpoint,
      token: issued.token,
      clientName: 'bound-scoped-reader',
      taskBinding: issued.taskBinding,
    });
    cleanups.push(() => rawAgent.close(), () => boundAgent.close());

    await expect(rawAgent.readEvents(0)).resolves.toMatchObject({ events: [], nextSequence: 2, gap: false });
    const scoped = await boundAgent.readEvents(0, 10, { taskId: 'task-other' });
    expect(scoped.events).toEqual([expect.objectContaining({
      sequence: 2,
      kind: 'command.failed',
      payload: expect.objectContaining({
        receipt: expect.objectContaining({ actionId: 'owned-event', state: 'failed' }),
      }),
    })]);
    expect(JSON.stringify(scoped)).not.toContain(issued.principalId);
    expect(JSON.stringify(scoped)).not.toContain('lease-own');
    expect(JSON.stringify(scoped)).not.toContain('lease-other');
  });

  it('rejects task-sensitive control commands from an unbound shared agent token', async () => {
    const fixture = await createIsolatedTestControlStatePaths('ctu');
    externalStateRoots.push(fixture);
    const root = fixture.projectRoot;
    const endpoint = path.join(root, 'control.sock');
    const harness = await createTaskScopedControlHarness({ projectRoot: root, endpoint });
    cleanups.push(() => harness.server.close());
    const client = await ControlClient.connect({
      projectRoot: root,
      endpoint,
      token: await harness.credentials.agentToken(),
      clientName: 'shared-agent',
    });
    cleanups.push(() => client.close());

    for (const command of taskScopedAgentCommands({
      projectRoot: root,
      taskId: harness.ownTaskId,
      leaseId: harness.ownTabLease.id,
      leaseRevision: harness.ownTabLease.revision,
      paneId: harness.ownPane.id,
      paneGeneration: harness.ownPane.generation,
      tabId: harness.ownTab.id,
      tabGeneration: harness.ownTab.generation,
      prefix: 'unbound',
    })) {
      await expect(client.submit(command)).resolves.toMatchObject({
        status: 'rejected',
        code: 'task_binding_required',
      });
    }
  });

  it('rejects conflicting task ids across task-sensitive control commands for a bound task token', async () => {
    const fixture = await createIsolatedTestControlStatePaths('ctb');
    externalStateRoots.push(fixture);
    const root = fixture.projectRoot;
    const endpoint = path.join(root, 'control.sock');
    const harness = await createTaskScopedControlHarness({ projectRoot: root, endpoint });
    cleanups.push(() => harness.server.close());
    const client = await ControlClient.connect({
      projectRoot: root,
      endpoint,
      token: harness.ownTaskToken,
      clientName: 'bound-agent',
      taskBinding: { taskId: harness.ownTaskId },
    });
    cleanups.push(() => client.close());

    for (const command of taskScopedAgentCommands({
      projectRoot: root,
      taskId: harness.otherTaskId,
      leaseId: harness.ownTabLease.id,
      leaseRevision: harness.ownTabLease.revision,
      paneId: harness.ownPane.id,
      paneGeneration: harness.ownPane.generation,
      tabId: harness.ownTab.id,
      tabGeneration: harness.ownTab.generation,
      prefix: 'conflict',
    })) {
      await expect(client.submit(command)).resolves.toMatchObject({
        status: 'rejected',
        code: 'task_binding_mismatch',
      });
    }
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
      resource: { kind: 'browser_tab' as const, idDigest: 'e'.repeat(64), generation: 1 },
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
    const otherRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'psyche-ctl-other-')));
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
