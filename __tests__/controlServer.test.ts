import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedControlIdentity, ControlPrincipal } from '../src/control/credentials.js';
import { ControlJournal } from '../src/control/journal.js';
import {
  ControlRuntime,
  type ControlHandlers,
  type RuntimeJournal,
} from '../src/control/runtime.js';
import { createControlServerForTest } from '../src/control/server.js';
import type { ControlCommandInput } from '../src/control/types.js';

const TEST_ARTIFACTS_ROOT = path.join(process.cwd(), '.control-server-test-artifacts');
const INTERNAL_IDEMPOTENCY_PREFIX = 'psyche-control-idempotency-v1';
const TERMINAL_COMMAND_EVENTS = new Set([
  'command.succeeded',
  'command.failed',
  'command.unknown',
  'command.rejected',
]);

let testRoots: string[] = [];

async function testProject(): Promise<string> {
  await mkdir(TEST_ARTIFACTS_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(TEST_ARTIFACTS_ROOT, 'project-'));
  testRoots.push(root);
  return realpath(root);
}

afterEach(async () => {
  await Promise.all(testRoots.map((root) => rm(root, { recursive: true, force: true })));
  testRoots = [];
});

afterAll(async () => {
  await rm(TEST_ARTIFACTS_ROOT, { recursive: true, force: true });
});

function authenticatedTask(taskId: string): AuthenticatedControlIdentity {
  const principal: ControlPrincipal = {
    id: 'agent',
    kind: 'agent',
    capabilities: ['read', 'mutate'],
  };
  return { ...principal, principal, taskBinding: { taskId } };
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

function expectedTaskIdempotencyKey(
  projectRoot: string,
  taskId: string,
  callerKey: string,
): string {
  const hash = createHash('sha256');
  for (const component of [
    INTERNAL_IDEMPOTENCY_PREFIX,
    'task',
    projectRoot,
    taskId,
    'caller',
    callerKey,
  ]) {
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

describe('control server idempotency scope', () => {
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

  it('isolates completed outcomes by authenticated task and replays the same task', async () => {
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

    const alpha = await authority.submitAs(
      authenticatedTask('task-alpha'),
      leaseRequest(root, 'command-a', callerKey, 'task-alpha'),
    );
    const beta = await authority.submitAs(
      authenticatedTask('task-beta'),
      leaseRequest(root, 'command-b', callerKey, 'task-beta'),
    );
    const alphaReplay = await authority.submitAs(
      authenticatedTask('task-alpha'),
      leaseRequest(root, 'command-a-retry', callerKey, 'task-alpha'),
    );

    expect(alpha).toEqual({ status: 'succeeded', value: { requestId: 'command-a' } });
    expect(beta).toEqual({ status: 'succeeded', value: { requestId: 'command-b' } });
    expect(alphaReplay).toEqual(alpha);

    const requested = journal.read(0).filter((event) => event.kind === 'command.requested');
    expect(requested.map((event) => event.payload.idempotencyKey)).toEqual([
      expectedTaskIdempotencyKey(root, 'task-alpha', callerKey),
      expectedTaskIdempotencyKey(root, 'task-beta', callerKey),
    ]);
    for (const event of requested) {
      const internalKey = String(event.payload.idempotencyKey);
      expect(internalKey).toMatch(/^psyche-control-idempotency-v1:[0-9a-f]{64}$/);
      expect(internalKey).not.toContain(callerKey);
      expect(internalKey).not.toContain('task-alpha');
      expect(internalKey).not.toContain('task-beta');
    }
  });

  it('isolates concurrently pending outcomes by authenticated task', async () => {
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
      if (kind === 'command.requested' && payload.commandId === 'command-a') {
        markAlphaRequested();
        await alphaGate;
      }
      if (kind === 'command.requested' && payload.commandId === 'command-b') {
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
      authenticatedTask('task-alpha'),
      leaseRequest(root, 'command-a', callerKey, 'task-alpha'),
    );
    await alphaRequested;
    const betaPromise = authority.submitAs(
      authenticatedTask('task-beta'),
      leaseRequest(root, 'command-b', callerKey, 'task-beta'),
    );
    const sawBetaRequest = await Promise.race([
      betaRequested.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    releaseAlpha();

    expect(sawBetaRequest).toBe(true);
    await expect(alphaPromise).resolves.toEqual({
      status: 'succeeded',
      value: { requestId: 'command-a' },
    });
    await expect(betaPromise).resolves.toEqual({
      status: 'succeeded',
      value: { requestId: 'command-b' },
    });
  });

  it('isolates journal-recovered outcomes by authenticated task after restart', async () => {
    const root = await testProject();
    const journal = await ControlJournal.open(root, 1);
    const failingJournal = wrapJournal(journal, async (kind, payload) => {
      if (TERMINAL_COMMAND_EVENTS.has(kind) && payload.commandId === 'command-a') {
        throw new Error('simulated terminal journal failure');
      }
      return journal.append(kind, payload);
    });
    const firstRuntime = await ControlRuntime.create({
      ownerEpoch: 1,
      handlers: handlers(),
      journal: failingJournal,
    });
    const firstAuthority = createControlServerForTest({
      runtime: firstRuntime,
      ownerEpoch: 1,
      projectRoot: root,
    });
    const callerKey = 'shared-recovery-key';

    await expect(firstAuthority.submitAs(
      authenticatedTask('task-alpha'),
      leaseRequest(root, 'command-a', callerKey, 'task-alpha'),
    )).rejects.toThrow('simulated terminal journal failure');

    const restartedJournal = await ControlJournal.open(root, 2);
    const restartedRuntime = await ControlRuntime.create({
      ownerEpoch: 2,
      handlers: handlers(),
      journal: restartedJournal,
    });
    const restartedAuthority = createControlServerForTest({
      runtime: restartedRuntime,
      ownerEpoch: 2,
      projectRoot: root,
    });

    const beta = await restartedAuthority.submitAs(
      authenticatedTask('task-beta'),
      leaseRequest(root, 'command-b', callerKey, 'task-beta'),
    );
    const alphaRecovered = await restartedAuthority.submitAs(
      authenticatedTask('task-alpha'),
      leaseRequest(root, 'command-a-retry', callerKey, 'task-alpha'),
    );

    expect(beta).toEqual({ status: 'succeeded', value: { requestId: 'command-b' } });
    expect(alphaRecovered).toEqual({
      status: 'unknown',
      code: 'recovered-nonterminal',
      message: 'command outcome is unknown',
    });
    expect(restartedJournal.read(0)).toContainEqual(expect.objectContaining({
      kind: 'command.unknown',
      payload: expect.objectContaining({
        idempotencyKey: expectedTaskIdempotencyKey(root, 'task-alpha', callerKey),
      }),
    }));
  });
});
