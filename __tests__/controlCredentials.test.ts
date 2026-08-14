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
    leases: {},
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

    expect(server.snapshot(operator)).toBe(sensitive);
    for (const kind of ['agent', 'compatibility'] as const) {
      const snapshot = server.snapshot({ id: kind, kind, capabilities: ['read'] });
      expect(snapshot).toMatchObject({
        ownerEpoch: 1,
        sequence: 2,
        commands: {},
        resources: [],
        capabilityLeases: [],
        leaseRequests: [],
        approvals: [],
        receipts: [],
      });
      expect(JSON.stringify(snapshot)).not.toContain('secret');
    }
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
