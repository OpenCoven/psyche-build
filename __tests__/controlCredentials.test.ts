import {
  access,
  link,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createControlCredentialStore,
  createControlCredentialStoreForCanonicalRoot,
  type CredentialCreationOps,
} from '../src/control/credentials.js';
import { ControlClient } from '../src/control/client.js';
import { ControlServer, createControlServerForTest } from '../src/control/server.js';
import type { ControlServerRuntime } from '../src/control/server.js';
import type { ControlCommandInput, ControlSnapshot } from '../src/control/types.js';
import type { ControlPrincipal } from '../src/control/credentials.js';
import { createRedactedApprovalEffect } from '../src/control/approvals.js';
import { createTaskScopedControlHarness } from './helpers/taskScopedControlHarness.js';

let tempRoots: string[] = [];

async function tempProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'psyche-cred-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

function delegationInput(): ControlCommandInput {
  return {
    id: 'cmd-delegate',
    idempotencyKey: 'idem-delegate',
    kind: 'pane.delegate',
    projectRoot: '/canonical/project',
    createdAt: new Date().toISOString(),
    payload: { paneId: '%3', automationActorId: 'psyche-1', taskId: 'task-1', ttlMs: 60_000 },
  };
}

function takeoverInput(): ControlCommandInput {
  return {
    id: 'cmd-takeover',
    idempotencyKey: 'idem-takeover',
    kind: 'pane.takeover',
    projectRoot: '/canonical/project',
    createdAt: new Date().toISOString(),
    payload: { paneId: '%3' },
  };
}

function stubRuntime(
  submit: ControlServerRuntime['submit'],
  snapshot?: ControlSnapshot,
): ControlServerRuntime {
  return {
    submit,
    snapshot: () => snapshot ?? ({
      ownerEpoch: 1, sequence: 0, commands: {}, leases: {}, resources: [],
      capabilityLeases: [], leaseRequests: [], approvals: [], receipts: [],
    }),
    readEvents: () => ({ events: [], nextSequence: 0, gap: false }),
  };
}

function sensitiveSnapshot(): ControlSnapshot {
  return {
    ownerEpoch: 1,
    sequence: 2,
    commands: {
      'command-1': {
        command: { payload: { secret: 'command-secret' } },
        outcome: { status: 'succeeded', value: { secret: 'outcome-secret' } },
        sequence: 2,
      },
    },
    leases: {
      'pane-secret': {
        paneId: 'pane-secret',
        actorId: 'agent-secret',
        taskId: 'task-secret',
      },
    },
    resources: [{ id: 'tab-secret' }],
    capabilityLeases: [{ id: 'lease-secret' }],
    leaseRequests: [{ id: 'request-secret' }],
    approvals: [{ id: 'approval-secret' }],
    receipts: [{ id: 'receipt-secret' }],
  } as unknown as ControlSnapshot;
}

describe('control credential store', () => {
  it('mints operator and agent tokens that authenticate to their principals', async () => {
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const store = await createControlCredentialStore({ projectRoot: root, filePath });

    const operatorToken = await store.operatorToken();
    const agentToken = await store.agentToken();

    expect(operatorToken).not.toEqual(agentToken);
    await expect(store.authenticate(operatorToken)).resolves.toMatchObject({ kind: 'operator' });
    await expect(store.authenticate(agentToken)).resolves.toMatchObject({ kind: 'agent' });
    await expect(store.authenticate('not-a-token')).resolves.toBeNull();
    await expect(store.authenticate('')).resolves.toBeNull();
  });

  it('persists the credential file with 0600 mode and reuses it', async () => {
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const first = await createControlCredentialStore({ projectRoot: root, filePath });
    const operatorToken = await first.operatorToken();

    const stats = await stat(filePath);
    expect(stats.mode & 0o777).toBe(0o600);

    const second = await createControlCredentialStore({ projectRoot: root, filePath });
    expect(await second.operatorToken()).toBe(operatorToken);
  });

  it('atomically converges concurrent stores on the on-disk credentials', async () => {
    const root = await tempProject();
    const filePath = path.join(root, '.psyche', 'runtime', 'control-credentials.json');
    const stores = await Promise.all(Array.from(
      { length: 64 },
      () => createControlCredentialStore({ projectRoot: root, filePath }),
    ));
    const tokens = await Promise.all(stores.map(async (store) => ({
      operator: await store.operatorToken(),
      agent: await store.agentToken(),
    })));
    const onDisk = JSON.parse(await readFile(filePath, 'utf8'));

    expect(new Set(tokens.map((token) => token.operator))).toEqual(new Set([onDisk.operatorToken]));
    expect(new Set(tokens.map((token) => token.agent))).toEqual(new Set([onDisk.agentToken]));
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it('rejects a symlink credential target', async () => {
    const root = await tempProject();
    const victim = path.join(root, 'victim.json');
    const filePath = path.join(root, 'control-credentials.json');
    await symlink(victim, filePath);

    const store = await createControlCredentialStore({ projectRoot: root, filePath });
    await expect(store.agentToken()).rejects.toMatchObject({ code: 'credential_path_unsafe' });
  });

  it('rejects a symlink in the credential parent path', async () => {
    const root = await tempProject();
    const outside = await tempProject();
    const linkedParent = path.join(root, '.psyche');
    await symlink(outside, linkedParent);

    const store = await createControlCredentialStore({
      projectRoot: root,
      filePath: path.join(linkedParent, 'runtime', 'control-credentials.json'),
    });
    await expect(store.agentToken()).rejects.toMatchObject({ code: 'credential_path_unsafe' });
  });

  it.each(['write', 'sync', 'close', 'publish'] as const)(
    'removes temporary credential material after an injected %s failure',
    async (failureStep) => {
      const root = await realpath(await tempProject());
      const filePath = path.join(root, 'control-credentials.json');
      const failure = new Error(`injected ${failureStep} failure`);
      let closeCalls = 0;
      const creationOps: CredentialCreationOps = {
        async openTemporary(temporary) {
          const handle = await open(temporary, 'wx', 0o600);
          return {
            async writeFile(data, encoding) {
              if (failureStep === 'write') throw failure;
              return handle.writeFile(data, encoding);
            },
            async sync() {
              if (failureStep === 'sync') throw failure;
              return handle.sync();
            },
            async close() {
              closeCalls += 1;
              if (failureStep === 'close' && closeCalls === 1) {
                throw failure;
              }
              await handle.close().catch(() => undefined);
            },
          };
        },
        async publish(temporary, target) {
          if (failureStep === 'publish') throw failure;
          await link(temporary, target);
        },
        removeTemporary: unlink,
      };
      const store = await createControlCredentialStoreForCanonicalRoot({
        canonicalProjectRoot: root,
        filePath,
        creationOps,
      });

      await expect(store.agentToken()).rejects.toBe(failure);
      await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
      const leftovers = (await readdir(root)).filter((name) => name.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
      expect(closeCalls).toBe(failureStep === 'close' ? 2 : 1);
    },
  );

  it('rereads an atomic publication winner and removes only the losing temporary file', async () => {
    const root = await realpath(await tempProject());
    const filePath = path.join(root, 'control-credentials.json');
    const winner = { operatorToken: 'winner-operator', agentToken: 'winner-agent' };
    const creationOps: CredentialCreationOps = {
      openTemporary: (temporary) => open(temporary, 'wx', 0o600),
      async publish(_temporary, target) {
        await writeFile(target, `${JSON.stringify(winner)}\n`, { mode: 0o600 });
        throw Object.assign(new Error('winner exists'), { code: 'EEXIST' });
      },
      removeTemporary: unlink,
    };
    const store = await createControlCredentialStoreForCanonicalRoot({
      canonicalProjectRoot: root,
      filePath,
      creationOps,
    });

    await expect(store.agentToken()).resolves.toBe(winner.agentToken);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(winner);
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('surfaces losing temporary cleanup failure after validating a publication winner', async () => {
    const root = await realpath(await tempProject());
    const filePath = path.join(root, 'control-credentials.json');
    const winner = { operatorToken: 'winner-operator', agentToken: 'winner-agent' };
    const cleanupFailure = new Error('injected cleanup failure');
    const creationOps: CredentialCreationOps = {
      openTemporary: (temporary) => open(temporary, 'wx', 0o600),
      async publish(_temporary, target) {
        await writeFile(target, `${JSON.stringify(winner)}\n`, { mode: 0o600 });
        throw Object.assign(new Error('winner exists'), { code: 'EEXIST' });
      },
      async removeTemporary() {
        throw cleanupFailure;
      },
    };
    const store = await createControlCredentialStoreForCanonicalRoot({
      canonicalProjectRoot: root,
      filePath,
      creationOps,
    });

    await expect(store.agentToken()).rejects.toBe(cleanupFailure);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(winner);
  });
});

describe('control server authorization', () => {
  it('only exposes surface authority snapshot fields to operators', () => {
    const sensitive = sensitiveSnapshot();
    const server = createControlServerForTest({
      runtime: stubRuntime(vi.fn(), sensitive),
    });
    const operator: ControlPrincipal = {
      id: 'operator', kind: 'operator', capabilities: ['read', 'mutate', 'delegate'],
    };

    expect(server.snapshot(operator)).toEqual(sensitive);
    for (const kind of ['agent', 'compatibility'] as const) {
      const snapshot = server.snapshot({ id: kind, kind, capabilities: ['read'] });
      expect(snapshot).toMatchObject({
        ownerEpoch: 1,
        sequence: 2,
        commands: {},
        leases: {},
        resources: [],
        capabilityLeases: [],
        leaseRequests: [],
        approvals: [],
        receipts: [],
      });
      expect(JSON.stringify(snapshot)).not.toContain('secret');
    }
  });

  it('exposes only proven own-task receipts in a scoped non-operator snapshot', () => {
    const scopedSnapshot = {
      ownerEpoch: 7,
      sequence: 5,
      commands: {},
      leases: {},
      resources: [
        {
          kind: 'pane',
          id: 'pane-own',
          generation: 1,
          projectRoot: '/repo',
          worktreeRoot: '/repo',
          tmuxPaneId: '%1',
          writable: true,
          outputSequence: 1,
        },
        {
          kind: 'browser_tab',
          id: 'tab-own',
          generation: 1,
          projectRoot: '/repo',
          worktreeRoot: '/repo',
          providerId: 'provider-own',
          webviewLabel: 'own',
          url: 'https://own.example',
          title: 'Own',
          loading: false,
          viewport: { width: 1280, height: 720 },
        },
        {
          kind: 'pane',
          id: 'pane-other',
          generation: 1,
          projectRoot: '/repo',
          worktreeRoot: '/repo',
          tmuxPaneId: '%2',
          writable: true,
          outputSequence: 1,
        },
        {
          kind: 'browser_tab',
          id: 'tab-other',
          generation: 1,
          projectRoot: '/repo',
          worktreeRoot: '/repo',
          providerId: 'provider-other',
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
          requestId: 'request-own-tab',
          actorId: 'agent-own',
          taskId: 'task-own',
          grantedBy: 'operator',
          revision: 2,
          ownerEpoch: 7,
          createdAt: '2026-08-12T12:00:00.000Z',
          expiresAt: '2026-08-12T12:01:00.000Z',
          grants: [{ target: { kind: 'browser_tab', id: 'tab-own', generation: 1 }, capabilities: ['browser.interact'] }],
        },
        {
          id: 'lease-other',
          requestId: 'request-other-tab',
          actorId: 'agent-other',
          taskId: 'task-other',
          grantedBy: 'operator',
          revision: 1,
          ownerEpoch: 7,
          createdAt: '2026-08-12T12:00:00.000Z',
          expiresAt: '2026-08-12T12:01:00.000Z',
          grants: [{ target: { kind: 'browser_tab', id: 'tab-other', generation: 1 }, capabilities: ['browser.interact'] }],
        },
      ],
      leaseRequests: [
        {
          id: 'request-own-pane',
          ownerEpoch: 7,
          actorId: 'agent-own',
          taskId: 'task-own',
          status: 'pending' as const,
          createdAt: '2026-08-12T12:00:00.000Z',
          ttlMs: 60_000,
          grants: [{ target: { kind: 'pane', id: 'pane-own', generation: 1 }, capabilities: ['pane.observe'] }],
        },
        {
          id: 'request-other-pane',
          ownerEpoch: 7,
          actorId: 'agent-other',
          taskId: 'task-other',
          status: 'pending' as const,
          createdAt: '2026-08-12T12:00:00.000Z',
          ttlMs: 60_000,
          grants: [{ target: { kind: 'pane', id: 'pane-other', generation: 1 }, capabilities: ['pane.observe'] }],
        },
      ],
      approvals: [
        {
          id: 'approval-own',
          actionId: 'action-own',
          ownerEpoch: 7,
          leaseId: 'lease-own',
          leaseRevision: 2,
          status: 'pending' as const,
          createdAt: '2026-08-12T12:00:00.000Z',
          expiresAt: '2026-08-12T12:05:00.000Z',
          resource: { kind: 'browser_tab', id: 'tab-own', generation: 1 },
          capability: 'browser.interact',
          effect: createRedactedApprovalEffect({ kind: 'submit', target: 'submit-own' }),
          payloadDigest: 'a'.repeat(64),
          executablePayloadDigest: 'b'.repeat(64),
        },
        {
          id: 'approval-other',
          actionId: 'action-other',
          ownerEpoch: 7,
          leaseId: 'lease-other',
          leaseRevision: 1,
          status: 'pending' as const,
          createdAt: '2026-08-12T12:00:00.000Z',
          expiresAt: '2026-08-12T12:05:00.000Z',
          resource: { kind: 'browser_tab', id: 'tab-other', generation: 1 },
          capability: 'browser.interact',
          effect: createRedactedApprovalEffect({ kind: 'submit', target: 'submit-other' }),
          payloadDigest: 'c'.repeat(64),
          executablePayloadDigest: 'd'.repeat(64),
        },
      ],
      receipts: [
        {
          schema: 'psyche.control.receipt/v1',
          actionId: 'action-own',
          state: 'approval_required' as const,
          resource: { kind: 'browser_tab', id: 'tab-own', generation: 1 },
          createdAt: '2026-08-12T12:00:00.000Z',
          taskId: 'task-own',
          leaseId: 'lease-own',
          leaseRevision: 2,
        },
        {
          schema: 'psyche.control.receipt/v1',
          actionId: 'action-other',
          state: 'approval_required' as const,
          resource: { kind: 'browser_tab', id: 'tab-other', generation: 1 },
          createdAt: '2026-08-12T12:00:00.000Z',
          taskId: 'task-other',
          leaseId: 'lease-other',
          leaseRevision: 1,
        },
        {
          schema: 'psyche.control.receipt/v1',
          actionId: 'legacy-action',
          state: 'failed' as const,
          resource: { kind: 'browser_tab', id: 'tab-legacy', generation: 1 },
          createdAt: '2026-08-12T12:00:00.000Z',
          code: 'effect_failed',
        },
      ],
    } satisfies ControlSnapshot;
    const server = createControlServerForTest({ runtime: stubRuntime(vi.fn(), scopedSnapshot) });
    const operator: ControlPrincipal = {
      id: 'operator', kind: 'operator', capabilities: ['read', 'mutate', 'delegate'],
    };

    expect(server.snapshot(operator, { taskId: 'task-own' }).receipts.map((receipt) => receipt.actionId))
      .toEqual(expect.arrayContaining(['action-own', 'action-other', 'legacy-action']));

    const scoped = server.snapshot({ id: 'agent-own', kind: 'agent', capabilities: ['read'] }, { taskId: 'task-own' });
    expect(scoped.resources.map((resource) => resource.id).sort()).toEqual(['pane-own', 'tab-own']);
    expect(scoped.capabilityLeases.map((lease) => lease.id)).toEqual(['lease-own']);
    expect(scoped.leaseRequests.map((request) => request.id)).toEqual(['request-own-pane']);
    expect(scoped.approvals.map((approval) => approval.actionId)).toEqual(['action-own']);
    expect(scoped.receipts).toEqual([expect.objectContaining({
      actionId: 'action-own',
      state: 'approval_required',
    })]);
    expect(scoped.receipts[0]).not.toHaveProperty('taskId');
    expect(scoped.receipts[0]).not.toHaveProperty('leaseId');
    expect(scoped.receipts[0]).not.toHaveProperty('leaseRevision');
  });

  it('passes the authenticated principal into state.get snapshot redaction', async () => {
    const root = await tempProject();
    const endpoint = path.join(root, 'control.sock');
    const credentials = await createControlCredentialStore({
      projectRoot: root,
      filePath: path.join(root, 'control-credentials.json'),
    });
    const sensitive = sensitiveSnapshot();
    const server = await ControlServer.start({
      endpoint,
      projectRoot: root,
      ownerEpoch: 1,
      runtime: stubRuntime(vi.fn(), sensitive),
      credentials,
    });
    const cleanups: Array<() => Promise<void>> = [() => server.close()];

    try {
      const operator = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: await credentials.operatorToken(),
        clientName: 'operator',
      });
      cleanups.unshift(() => operator.close());
      const agent = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: await credentials.agentToken(),
        clientName: 'agent',
      });
      cleanups.unshift(() => agent.close());

      await expect(operator.getState()).resolves.toEqual(sensitive);
      const snapshot = await agent.getState();
      expect(snapshot).toMatchObject({
        ownerEpoch: 1,
        sequence: 2,
        commands: {},
        leases: {},
        resources: [],
        capabilityLeases: [],
        leaseRequests: [],
        approvals: [],
        receipts: [],
      });
      expect(JSON.stringify(snapshot)).not.toContain('secret');
    } finally {
      await Promise.allSettled(cleanups.map(async (close) => close()));
    }
  });

  it('returns only persisted own-task authority and receipts when an agent supplies task scope', async () => {
    const root = await tempProject();
    const endpoint = path.join(root, 'control.sock');
    const harness = await createTaskScopedControlHarness({ projectRoot: root, endpoint });
    const cleanups: Array<() => Promise<void>> = [() => harness.server.close()];

    try {
      const operator = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: await harness.credentials.operatorToken(),
        clientName: 'operator-task-scope',
      });
      cleanups.unshift(() => operator.close());
      const agent = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: await harness.credentials.agentToken(),
        clientName: 'agent-task-scope',
      });
      cleanups.unshift(() => agent.close());

      const operatorSnapshot = await operator.getState();
      expect(Object.values(operatorSnapshot.leases).map((lease) => lease.paneId))
        .toContain(harness.laneOnlyPane.id);
      expect(operatorSnapshot.approvals.map((approval) => approval.actionId))
        .toEqual(expect.arrayContaining([harness.ownApprovalActionId, harness.otherApprovalActionId]));
      expect(operatorSnapshot.receipts.map((receipt) => receipt.actionId))
        .toEqual(expect.arrayContaining([harness.ownApprovalActionId, harness.otherApprovalActionId]));

      await expect(agent.getState()).resolves.toMatchObject({
        commands: {},
        leases: {},
        resources: [],
        capabilityLeases: [],
        leaseRequests: [],
        approvals: [],
        receipts: [],
      });

      const scoped = await agent.getState({ taskId: harness.ownTaskId });
      expect(scoped.commands).toEqual({});
      expect(scoped.leases).toEqual({});
      expect(scoped.resources.map((resource) => resource.id).sort())
        .toEqual([harness.ownPane.id, harness.ownTab.id].sort());
      expect(scoped.resources.map((resource) => resource.id)).not.toContain(harness.laneOnlyPane.id);
      expect(scoped.resources.map((resource) => resource.id)).not.toContain(harness.otherPane.id);
      expect(scoped.resources.map((resource) => resource.id)).not.toContain(harness.otherTab.id);
      expect(scoped.capabilityLeases).toHaveLength(1);
      expect(scoped.capabilityLeases[0]).toMatchObject({
        id: harness.ownTabLease.id,
        requestId: harness.ownTabRequestId,
        taskId: harness.ownTaskId,
      });
      expect(scoped.leaseRequests).toHaveLength(1);
      expect(scoped.leaseRequests[0]).toMatchObject({
        id: harness.ownPaneRequestId,
        taskId: harness.ownTaskId,
      });
      expect(scoped.approvals).toHaveLength(1);
      expect(scoped.approvals[0]).toMatchObject({
        actionId: harness.ownApprovalActionId,
        leaseId: harness.ownTabLease.id,
        leaseRevision: harness.ownTabLease.revision,
      });
      expect(scoped.receipts).toEqual([expect.objectContaining({
        actionId: harness.ownApprovalActionId,
        state: 'approval_required',
      })]);
      expect(scoped.receipts[0]).not.toHaveProperty('taskId');
      expect(scoped.receipts[0]).not.toHaveProperty('leaseId');
      expect(scoped.receipts[0]).not.toHaveProperty('leaseRevision');
    } finally {
      await Promise.allSettled(cleanups.map(async (close) => close()));
    }
  });

  it('rejects agent self-delegation and stamps operator identity', async () => {
    const submit = vi.fn(async (command) => ({ status: 'succeeded' as const, value: command.actor }));
    const server = createControlServerForTest({ runtime: stubRuntime(submit) });

    await expect(server.submitAs(
      { id: 'agent-1', kind: 'agent', capabilities: ['read', 'mutate', 'delegate'] },
      delegationInput(),
    )).resolves.toMatchObject({ status: 'rejected', code: 'delegation_not_authorized' });

    await expect(server.submitAs(
      { id: 'operator-1', kind: 'operator', capabilities: ['read', 'mutate', 'delegate'] },
      delegationInput(),
    )).resolves.toMatchObject({
      status: 'succeeded',
      value: { id: 'operator-1', kind: 'human' },
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each<ControlPrincipal>([
    { id: 'agent-1', kind: 'agent', capabilities: ['read', 'mutate', 'delegate'] },
    { id: 'compat-1', kind: 'compatibility', capabilities: ['read', 'mutate', 'delegate'] },
  ])('rejects delegation and takeover for $kind principals', async (principal) => {
    const submit = vi.fn(async () => ({ status: 'succeeded' as const }));
    const server = createControlServerForTest({ runtime: stubRuntime(submit) });

    await expect(server.submitAs(principal, delegationInput()))
      .resolves.toMatchObject({ status: 'rejected', code: 'delegation_not_authorized' });
    await expect(server.submitAs(principal, takeoverInput()))
      .resolves.toMatchObject({ status: 'rejected', code: 'takeover_not_authorized' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('permits operator takeover', async () => {
    const submit = vi.fn(async (command) => ({ status: 'succeeded' as const, value: command.actor }));
    const server = createControlServerForTest({ runtime: stubRuntime(submit) });

    await expect(server.submitAs(
      { id: 'operator-1', kind: 'operator', capabilities: ['read', 'mutate', 'delegate'] },
      takeoverInput(),
    )).resolves.toMatchObject({ status: 'succeeded', value: { kind: 'human' } });
  });

  it('restricts new authority commands and compatibility access', async () => {
    const submit = vi.fn(async () => ({ status: 'succeeded' as const }));
    const server = createControlServerForTest({ runtime: stubRuntime(submit) });
    const agent: ControlPrincipal = { id: 'agent-1', kind: 'agent', capabilities: ['read', 'mutate', 'delegate'] };
    const compatibility: ControlPrincipal = { id: 'compat-1', kind: 'compatibility', capabilities: ['read', 'mutate'] };
    const base = delegationInput();
    const grant = { ...base, kind: 'lease.grant' as const, payload: { requestId: 'r' } };
    const request = { ...base, kind: 'lease.request' as const, payload: { taskId: 't', ttlMs: 1, grants: [] } };
    await expect(server.submitAs(agent, grant)).resolves.toMatchObject({ status: 'rejected', code: 'operator_required' });
    await expect(server.submitAs(compatibility, request)).resolves.toMatchObject({ status: 'rejected', code: 'compatibility_not_authorized' });
    await expect(server.submitAs(agent, request)).resolves.toMatchObject({ status: 'succeeded' });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each(['pane.spawn', 'pane.kill', 'pane.resize', 'coven.desktop.action'] as const)(
    'blocks agent principals from legacy %s bypass',
    async (kind) => {
      const submit = vi.fn(async () => ({ status: 'succeeded' as const }));
      const server = createControlServerForTest({ runtime: stubRuntime(submit) });
      const legacy = { ...takeoverInput(), kind, payload: {} } as ControlCommandInput;
      await expect(server.submitAs(
        { id: 'agent-1', kind: 'agent', capabilities: ['read', 'mutate', 'delegate'] },
        legacy,
      )).resolves.toMatchObject({ status: 'rejected', code: 'agent_not_authorized' });
      expect(submit).not.toHaveBeenCalled();
    },
  );
});
