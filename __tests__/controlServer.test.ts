import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthenticatedControlIdentity,
  ControlPrincipal,
} from '../src/control/credentials.js';
import { createControlCredentialStore } from '../src/control/credentials.js';
import { ControlJournal } from '../src/control/journal.js';
import {
  ControlRuntime,
  type ControlHandlers,
  type RuntimeJournal,
} from '../src/control/runtime.js';
import { ControlServer, createControlServerForTest } from '../src/control/server.js';
import type { ControlCommandInput } from '../src/control/types.js';

const TEST_ARTIFACTS_ROOT = path.join(process.cwd(), '.control-server-test-artifacts');
const INTERNAL_IDEMPOTENCY_PREFIX = 'psyche-control-idempotency-v1';

let testRoots: string[] = [];

async function testProject(): Promise<string> {
  await mkdir(TEST_ARTIFACTS_ROOT, { recursive: true });
  const root = path.join(TEST_ARTIFACTS_ROOT, `project-${randomBytes(6).toString('hex')}`);
  await mkdir(root);
  testRoots.push(root);
  return realpath(root);
}

afterEach(async () => {
  await Promise.all(testRoots.map((root) => rm(root, { recursive: true, force: true })));
  testRoots = [];
});

afterAll(async () => {
  await rm(TEST_ARTIFACTS_ROOT, { recursive: true, force: true }).catch(() => undefined);
});

function authenticatedTask(
  taskId: string,
  subjectId: string,
): AuthenticatedControlIdentity {
  const principal: ControlPrincipal = {
    id: `task-subject:${subjectId}`,
    kind: 'agent',
    capabilities: ['read', 'mutate'],
  };
  return {
    principal,
    taskBinding: { taskId, subjectId },
  };
}

const operator: ControlPrincipal = {
  id: 'operator',
  kind: 'operator',
  capabilities: ['read', 'mutate', 'delegate'],
};

function leaseRequest(
  projectRoot: string,
  id: string,
  idempotencyKey: string,
  taskId: string,
): Extract<ControlCommandInput, { kind: 'lease.request' }> {
  return {
    id,
    idempotencyKey,
    kind: 'lease.request',
    projectRoot,
    createdAt: '2026-08-14T20:00:00.000Z',
    payload: { taskId, ttlMs: 60_000, grants: [] },
  };
}

function paneSpawn(
  projectRoot: string,
  id: string,
  idempotencyKey: string,
  cwd: string,
): Extract<ControlCommandInput, { kind: 'pane.spawn' }> {
  return {
    id,
    idempotencyKey,
    kind: 'pane.spawn',
    projectRoot,
    createdAt: '2026-08-14T20:00:00.000Z',
    payload: { cwd },
  };
}

function handlers(overrides: Partial<ControlHandlers> = {}): ControlHandlers {
  return {
    executeOrchestration: async () => undefined,
    spawnPane: async () => undefined,
    sendPrompt: async () => undefined,
    interruptPane: async () => undefined,
    sendInput: async () => undefined,
    openTerminal: async () => undefined,
    resizePane: async () => undefined,
    focusPane: async () => undefined,
    killPane: async () => undefined,
    respawnPane: async () => undefined,
    openConflictPane: async () => undefined,
    updatePaneOption: async () => undefined,
    updatePaneMeta: async () => undefined,
    launchRitual: async () => undefined,
    launchCovenSession: async () => undefined,
    openCovenSession: async () => undefined,
    runCovenDesktopAction: async () => undefined,
    executeCovenCapability: async () => undefined,
    observePane: async () => undefined,
    actOnPane: async () => undefined,
    inspectBrowser: async () => undefined,
    actOnBrowser: async () => undefined,
    runBrowserScript: async () => undefined,
    ...overrides,
  };
}

function expectedRuntimeIdempotencyKey(
  projectRoot: string,
  identity: AuthenticatedControlIdentity,
  callerKey: string,
): string {
  const hash = createHash('sha256');
  const components = identity.taskBinding
    ? [
        INTERNAL_IDEMPOTENCY_PREFIX,
        'project',
        projectRoot,
        'principal-kind',
        identity.principal.kind,
        'task',
        identity.taskBinding.taskId,
        'subject',
        identity.taskBinding.subjectId,
        'principal',
        identity.principal.id,
        'caller',
        callerKey,
      ]
    : [
        INTERNAL_IDEMPOTENCY_PREFIX,
        'project',
        projectRoot,
        'principal-kind',
        identity.principal.kind,
        'principal',
        identity.principal.id,
        'caller',
        callerKey,
      ];
  for (const component of components) {
    const bytes = Buffer.from(component, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return `${INTERNAL_IDEMPOTENCY_PREFIX}:${hash.digest('hex')}`;
}

function wrapJournal(
  journal: ControlJournal,
  append: RuntimeJournal['append'],
): RuntimeJournal {
  return {
    append,
    read: (afterSequence, limit) => journal.read(afterSequence, limit),
    findByIdempotencyKey: (key) => journal.findByIdempotencyKey(key),
    recoverNonterminalCommands: () => journal.recoverNonterminalCommands(),
  };
}

describe('control server runtime integration', () => {
  it('does not execute a frame queued after a terminal connection failure', async () => {
    const root = await testProject();
    const endpoint = `.control-server-${randomBytes(6).toString('hex')}.sock`;
    const snapshot = vi.fn(() => ({
      ownerEpoch: 1,
      sequence: 0,
      commands: {},
      leases: {},
      resources: [],
      capabilityLeases: [],
      leaseRequests: [],
      approvals: [],
      receipts: [],
    }));
    const credentials = await createControlCredentialStore({
      projectRoot: root,
      filePath: path.join(root, 'control-credentials.json'),
      stateRoot: path.join(root, '.control-state'),
    });
    const server = await ControlServer.start({
      endpoint,
      projectRoot: root,
      ownerEpoch: 1,
      credentials,
      operatorCommandPolicy: 'trusted-test-only',
      runtime: {
        submit: async () => ({ status: 'succeeded', value: undefined }),
        snapshot,
        readEvents: () => ({ events: [], nextSequence: 0, gap: false }),
      },
    });
    const socket = createConnection(endpoint);
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    let responses = '';
    const welcomed = new Promise<void>((resolve) => {
      socket.on('data', (chunk: string) => {
        responses += chunk;
        if (responses.includes('"type":"welcome"')) resolve();
      });
    });

    try {
      await once(socket, 'connect');
      socket.write(`${JSON.stringify({
        version: 1,
        type: 'hello',
        requestId: 'hello',
        token: await credentials.operatorToken(),
        clientName: 'queued-frame-test',
        projectRoot: root,
      })}\n`);
      await welcomed;

      const closed = once(socket, 'close');
      socket.write('{"version":1,"type":\n');
      socket.write(`${JSON.stringify({
        version: 1,
        type: 'state.get',
        requestId: 'must-not-run',
      })}\n`);
      await closed;

      expect(responses).toContain('"code":"bad_request"');
      expect(responses).not.toContain('"requestId":"must-not-run"');
      expect(snapshot).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  it('keeps operator idempotency project-wide in runtime snapshots and the journal', async () => {
    const root = await testProject();
    const journal = await ControlJournal.open(root, 1);
    const spawnPane = vi.fn(async (payload: { cwd: string }) => ({ cwd: payload.cwd }));
    const runtime = await ControlRuntime.create({
      ownerEpoch: 1,
      handlers: handlers({ spawnPane }),
      journal,
    });
    const authority = createControlServerForTest({
      runtime,
      ownerEpoch: 1,
      projectRoot: root,
    });
    const callerKey = 'operator-project-key';

    const first = await authority.submitAs(
      operator,
      paneSpawn(root, 'operator-command-a', callerKey, '/operator/a'),
    );
    const replay = await authority.submitAs(
      operator,
      paneSpawn(root, 'operator-command-b', callerKey, '/operator/b'),
    );

    expect(first).toEqual({ status: 'succeeded', value: { cwd: '/operator/a' } });
    expect(replay).toEqual(first);
    expect(spawnPane).toHaveBeenCalledOnce();
    expect(runtime.snapshot().commands['operator-command-a']?.command.idempotencyKey)
      .toBe(callerKey);
    expect(journal.read(0).filter((event) => event.kind === 'command.requested'))
      .toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ idempotencyKey: callerKey }),
        }),
      ]);
  });

  it('dedupes only within one authenticated task subject and isolates other tasks and rotated subjects', async () => {
    const root = await testProject();
    const journal = await ControlJournal.open(root, 1);
    const runtime = await ControlRuntime.create({
      ownerEpoch: 1,
      handlers: handlers(),
      journal,
    });
    const authority = createControlServerForTest({
      runtime,
      ownerEpoch: 1,
      projectRoot: root,
    });
    const callerKey = 'shared-client-key';
    const alpha = authenticatedTask('task-alpha', 'subject-alpha');
    const beta = authenticatedTask('task-beta', 'subject-beta');
    const rotated = authenticatedTask('task-alpha', 'subject-alpha-rotated');

    const first = await authority.submitAs(
      alpha,
      leaseRequest(root, 'command-alpha', callerKey, 'task-alpha'),
    );
    const secondTask = await authority.submitAs(
      beta,
      leaseRequest(root, 'command-beta', callerKey, 'task-beta'),
    );
    const rotatedSubject = await authority.submitAs(
      rotated,
      leaseRequest(root, 'command-rotated', callerKey, 'task-alpha'),
    );
    const replay = await authority.submitAs(
      alpha,
      leaseRequest(root, 'command-alpha-replay', callerKey, 'task-alpha'),
    );

    expect(first).toEqual({ status: 'succeeded', value: { requestId: 'command-alpha' } });
    expect(secondTask).toEqual({ status: 'succeeded', value: { requestId: 'command-beta' } });
    expect(rotatedSubject).toEqual({ status: 'succeeded', value: { requestId: 'command-rotated' } });
    expect(replay).toEqual(first);

    const requested = journal.read(0).filter((event) => event.kind === 'command.requested');
    expect(requested.map((event) => event.payload.idempotencyKey)).toEqual([
      expectedRuntimeIdempotencyKey(root, alpha, callerKey),
      expectedRuntimeIdempotencyKey(root, beta, callerKey),
      expectedRuntimeIdempotencyKey(root, rotated, callerKey),
    ]);
    for (const event of requested) {
      const internalKey = String(event.payload.idempotencyKey);
      expect(internalKey).toMatch(/^psyche-control-idempotency-v1:[0-9a-f]{64}$/);
      expect(internalKey).not.toContain(callerKey);
      expect(internalKey).not.toContain('task-alpha');
      expect(internalKey).not.toContain('task-beta');
      expect(internalKey).not.toContain('subject-alpha');
      expect(internalKey).not.toContain('subject-beta');
      expect(internalKey).not.toContain('subject-alpha-rotated');
    }
  });

  it('isolates concurrently pending outcomes by authenticated task subject', async () => {
    const root = await testProject();
    const journal = await ControlJournal.open(root, 1);
    let releaseAlpha!: () => void;
    let markAlphaRequested!: () => void;
    let markBetaRequested!: () => void;
    const alphaGate = new Promise<void>((resolve) => { releaseAlpha = resolve; });
    const alphaRequested = new Promise<void>((resolve) => { markAlphaRequested = resolve; });
    const betaRequested = new Promise<void>((resolve) => { markBetaRequested = resolve; });
    const gatedJournal = wrapJournal(journal, async (kind, payload) => {
      const event = await journal.append(kind, payload);
      if (kind === 'command.requested' && payload.commandId === 'command-alpha') {
        markAlphaRequested();
        await alphaGate;
      }
      if (kind === 'command.requested' && payload.commandId === 'command-beta') {
        markBetaRequested();
      }
      return event;
    });
    const runtime = await ControlRuntime.create({
      ownerEpoch: 1,
      handlers: handlers(),
      journal: gatedJournal,
    });
    const authority = createControlServerForTest({
      runtime,
      ownerEpoch: 1,
      projectRoot: root,
    });
    const callerKey = 'shared-pending-key';

    const alphaPromise = authority.submitAs(
      authenticatedTask('task-alpha', 'subject-alpha'),
      leaseRequest(root, 'command-alpha', callerKey, 'task-alpha'),
    );
    await alphaRequested;
    const betaPromise = authority.submitAs(
      authenticatedTask('task-beta', 'subject-beta'),
      leaseRequest(root, 'command-beta', callerKey, 'task-beta'),
    );
    const sawBetaRequest = await Promise.race([
      betaRequested.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    releaseAlpha();

    expect(sawBetaRequest).toBe(true);
    await expect(alphaPromise).resolves.toEqual({
      status: 'succeeded',
      value: { requestId: 'command-alpha' },
    });
    await expect(betaPromise).resolves.toEqual({
      status: 'succeeded',
      value: { requestId: 'command-beta' },
    });
  });
});
