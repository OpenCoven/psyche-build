import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
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
  actionStatus?: NonNullable<ControlServerRuntime['actionStatus']>;
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
    actionStatus: overrides.actionStatus,
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
__MERGE_BOTH_TEST_BLOCKS_KEEP_CURRENT_BRANCH_PIPELINE_TEST__
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

__TAKE_OURS_VERBATIM__
    const harness = await startHarness();
    const client = await ControlClient.connect({
      projectRoot: harness.projectRoot, endpoint: harness.endpoint,
      token: harness.operatorToken, clientName: 'test-operator',
    });
    cleanups.push(() => client.close());
__TAKE_OURS_VERBATIM__

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
