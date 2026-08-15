import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { ControlClient } from '../../src/control/client.js';
import {
  createControlCredentialStore,
  issueControlTaskToken,
} from '../../src/control/credentials.js';
import { ControlJournal } from '../../src/control/journal.js';
import { ControlRuntime, type ControlHandlers } from '../../src/control/runtime.js';
import { ControlServer } from '../../src/control/server.js';
import { SurfaceRegistry, type PaneSurface } from '../../src/control/surfaces.js';
import type {
  CapabilityLease,
  CapabilityLeaseGrantItem,
} from '../../src/control/capabilityLeases.js';
import type { CommandOutcome, ControlCommandInput } from '../../src/control/types.js';
import type {
  McpControlClient,
  McpTaskBinding,
} from '../../src/mcp/server.js';

const TEST_ARTIFACTS_ROOT = path.join(
  process.cwd(),
  '.psyche-task-scoped-control-tests',
);
const OWNER_EPOCH = 7;

type TaskName = 'alpha' | 'beta';

export interface TaskScopedControlHarness {
  readonly root: string;
  readonly endpoint: string;
  readonly resources: Readonly<Record<TaskName, PaneSurface>>;
  readonly bindings: Readonly<Record<TaskName, McpTaskBinding>>;
  clientFor(task: TaskName | 'unbound'): Promise<McpControlClient>;
  requestLease(
    task: TaskName,
    requestId: string,
    grants: readonly CapabilityLeaseGrantItem[],
  ): Promise<CommandOutcome>;
  grantLease(requestId: string): Promise<CapabilityLease>;
  close(): Promise<void>;
}

export async function startTaskScopedControlHarness(): Promise<TaskScopedControlHarness> {
  await mkdir(TEST_ARTIFACTS_ROOT, { recursive: true });
  const createdRoot = await mkdtemp(path.join(TEST_ARTIFACTS_ROOT, 'project-'));
  const root = await realpath(createdRoot);
  const endpoint = path.join(
    process.cwd(),
    `.psyche-${path.basename(createdRoot).slice('project-'.length)}.sock`,
  );
  const credentials = await createControlCredentialStore({ projectRoot: root });
  const bindings = {
    alpha: {
      taskId: 'task-alpha',
      token: await issueControlTaskToken({ projectRoot: root, taskId: 'task-alpha' }),
      canonicalProjectRoot: root,
    },
    beta: {
      taskId: 'task-beta',
      token: await issueControlTaskToken({ projectRoot: root, taskId: 'task-beta' }),
      canonicalProjectRoot: root,
    },
  } as const;
  const surfaces = new SurfaceRegistry();
  const resources = {
    alpha: surfaces.upsertPane({
      id: 'pane-alpha',
      projectRoot: root,
      worktreeRoot: path.join(root, '.worktrees', 'alpha'),
      tmuxPaneId: '%1',
      title: 'Alpha',
      agent: 'alpha-agent',
      writable: true,
      outputSequence: 1,
    }),
    beta: surfaces.upsertPane({
      id: 'pane-beta',
      projectRoot: root,
      worktreeRoot: path.join(root, '.worktrees', 'beta'),
      tmuxPaneId: '%2',
      title: 'Beta',
      agent: 'beta-agent',
      writable: true,
      outputSequence: 2,
    }),
  } as const;
  const runtime = await ControlRuntime.create({
    ownerEpoch: OWNER_EPOCH,
    handlers: noOpHandlers(),
    journal: await ControlJournal.open(root, OWNER_EPOCH),
    surfaces,
  });
  const server = await ControlServer.start({
    endpoint,
    projectRoot: root,
    ownerEpoch: OWNER_EPOCH,
    runtime,
    credentials,
    operatorCommandPolicy: 'trusted-test-only',
  });
  const clients: ControlClient[] = [];

  const connectClient = async (task: TaskName | 'unbound'): Promise<ControlClient> => {
    const binding = task === 'unbound' ? undefined : bindings[task];
    const client = await ControlClient.connect({
      projectRoot: root,
      endpoint,
      token: binding?.token ?? await credentials.agentToken(),
      clientName: `mcp-${task}`,
      ...(binding === undefined ? {} : {
        taskBinding: { taskId: binding.taskId },
      }),
    });
    clients.push(client);
    return client;
  };
  const alpha = await connectClient('alpha');
  const beta = await connectClient('beta');
  const operator = await ControlClient.connect({
    projectRoot: root,
    endpoint,
    token: await credentials.operatorToken(),
    clientName: 'test-operator',
  });
  clients.push(operator);

  let commandSequence = 0;
  const command = (
    kind: ControlCommandInput['kind'],
    payload: unknown,
    id?: string,
  ): ControlCommandInput => {
    const commandId = id ?? `harness-command-${++commandSequence}`;
    return {
      id: commandId,
      idempotencyKey: commandId,
      kind,
      projectRoot: root,
      createdAt: new Date().toISOString(),
      payload,
    } as ControlCommandInput;
  };

  return {
    root,
    endpoint,
    resources,
    bindings,
    clientFor: connectClient,
    requestLease(task, requestId, grants) {
      const binding = bindings[task];
      const client = task === 'alpha' ? alpha : beta;
      return client.submit(command('lease.request', {
        taskId: binding.taskId,
        ttlMs: 60_000,
        grants,
      }, requestId));
    },
    async grantLease(requestId) {
      const outcome = await operator.submit(command('lease.grant', { requestId }));
      if (outcome.status !== 'succeeded') {
        throw new Error(`failed to grant test lease: ${outcome.code}`);
      }
      return (outcome.value as { lease: CapabilityLease }).lease;
    },
    async close() {
      await Promise.allSettled(clients.map((client) => client.close()));
      await server.close();
      await rm(root, { recursive: true, force: true });
      await rm(TEST_ARTIFACTS_ROOT, { recursive: true, force: true });
    },
  };
}

function noOpHandlers(): ControlHandlers {
  const noOp = async (): Promise<void> => undefined;
  return {
    executeOrchestration: noOp,
    spawnPane: noOp,
    sendPrompt: noOp,
    interruptPane: noOp,
    sendInput: noOp,
    openTerminal: noOp,
    resizePane: noOp,
    focusPane: noOp,
    killPane: noOp,
    respawnPane: noOp,
    openConflictPane: noOp,
    updatePaneOption: noOp,
    updatePaneMeta: noOp,
    launchRitual: noOp,
    launchCovenSession: noOp,
    openCovenSession: noOp,
    runCovenDesktopAction: noOp,
    executeCovenCapability: noOp,
    observePane: noOp,
    actOnPane: noOp,
    inspectBrowser: noOp,
    actOnBrowser: noOp,
    runBrowserScript: noOp,
  };
}
