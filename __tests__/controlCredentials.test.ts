import { createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import {
  access,
  link,
  mkdtemp,
  mkdir,
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
  issueControlTaskToken,
  issueControlTaskTokenForCanonicalRoot,
  type AuthenticatedControlIdentity,
  type ControlCredentialStore,
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

function taskBindingDirectory(filePath: string): string {
  return path.join(path.dirname(filePath), 'control-task-bindings');
}

function taskBindingFilePath(filePath: string, token: string): string {
  const digest = createHash('sha256').update(token, 'utf8').digest('hex');
  return path.join(taskBindingDirectory(filePath), `${digest}.json`);
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
  readEvents: ControlServerRuntime['readEvents'] = () => ({
    events: [], nextSequence: 0, gap: false,
  }),
): ControlServerRuntime {
  return {
    submit,
    snapshot: () => snapshot ?? ({
      ownerEpoch: 1, sequence: 0, commands: {}, leases: {}, resources: [],
      capabilityLeases: [], leaseRequests: [], approvals: [], receipts: [],
    }),
    readEvents,
  };
}

function authenticatedIdentity(
  principal: ControlPrincipal,
  taskId?: string,
): AuthenticatedControlIdentity {
  return {
    ...principal,
    principal,
    ...(taskId === undefined ? {} : { taskBinding: { taskId } }),
  };
}

async function connectLines(endpoint: string): Promise<{
  socket: Socket;
  send(value: unknown): void;
  next(): Promise<Record<string, unknown>>;
}> {
  const socket = connect(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let buffer = '';
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line); else lines.push(line);
      newline = buffer.indexOf('\n');
    }
  });
  return {
    socket,
    send: (value) => socket.write(`${JSON.stringify(value)}\n`),
    next: async () => JSON.parse(
      lines.shift() ?? await new Promise<string>((resolve) => waiters.push(resolve)),
    ) as Record<string, unknown>,
  };
}

function taskSensitiveInputs(taskId: string): ControlCommandInput[] {
  const base = {
    projectRoot: '/canonical/project',
    createdAt: '2026-08-14T12:00:00.000Z',
  };
  return [
    {
      ...base,
      id: 'lease-request',
      idempotencyKey: 'lease-request',
      kind: 'lease.request',
      payload: { taskId, ttlMs: 60_000, grants: [] },
    },
    {
      ...base,
      id: 'lease-release',
      idempotencyKey: 'lease-release',
      kind: 'lease.release',
      payload: { taskId, leaseId: 'lease-1', leaseRevision: 1 },
    },
    {
      ...base,
      id: 'pane-action',
      idempotencyKey: 'pane-action',
      kind: 'pane.action',
      payload: {
        taskId,
        leaseId: 'lease-1',
        leaseRevision: 1,
        paneId: 'pane-1',
        generation: 1,
        action: { kind: 'focus' },
      },
    },
  ];
}

function orchestrationInput(options: {
  id: string;
  taskId: string;
  requestTaskId: string;
  requestProjectRoot: string;
  projectRoot?: string;
}): Extract<ControlCommandInput, { kind: 'orchestration.execute' }> {
  return {
    id: options.id,
    idempotencyKey: options.id,
    kind: 'orchestration.execute',
    projectRoot: options.projectRoot ?? '/canonical/project',
    createdAt: '2026-08-14T12:00:00.000Z',
    payload: {
      taskId: options.taskId,
      leaseId: 'lease-1',
      leaseRevision: 1,
      request: {
        taskId: options.requestTaskId,
        projectRoot: options.requestProjectRoot,
        prompt: 'Run the task',
        lanes: [{ id: 'lane-1', mode: 'terminal' }],
      },
    },
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

function scopedReadSnapshot(): ControlSnapshot {
  return {
    ownerEpoch: 7,
    sequence: 41,
    commands: {},
    leases: {},
    resources: [
      {
        id: 'pane-alpha',
        kind: 'pane',
        generation: 1,
        projectRoot: '/canonical/project',
        worktreeRoot: '/canonical/project/.worktrees/alpha',
        tmuxPaneId: '%1',
        title: 'alpha pane',
        writable: true,
        outputSequence: 3,
      },
      {
        id: 'tab-alpha',
        kind: 'browser_tab',
        generation: 3,
        projectRoot: '/canonical/project',
        worktreeRoot: '/canonical/project/.worktrees/alpha',
        providerId: 'desktop-alpha',
        webviewLabel: 'alpha',
        url: 'https://alpha.example.test',
        title: 'alpha tab',
        loading: false,
        viewport: { width: 1280, height: 720 },
      },
      {
        id: 'pane-beta',
        kind: 'pane',
        generation: 1,
        projectRoot: '/canonical/project',
        worktreeRoot: '/canonical/project/.worktrees/beta',
        tmuxPaneId: '%2',
        title: 'beta pane',
        writable: true,
        outputSequence: 4,
      },
      {
        id: 'tab-beta',
        kind: 'browser_tab',
        generation: 4,
        projectRoot: '/canonical/project',
        worktreeRoot: '/canonical/project/.worktrees/beta',
        providerId: 'desktop-beta',
        webviewLabel: 'beta',
        url: 'https://beta.example.test',
        title: 'beta tab',
        loading: false,
        viewport: { width: 1024, height: 768 },
      },
      {
        id: 'pane-stale',
        kind: 'pane',
        generation: 2,
        projectRoot: '/canonical/project',
        worktreeRoot: '/canonical/project/.worktrees/alpha',
        tmuxPaneId: '%3',
        writable: true,
        outputSequence: 5,
      },
      {
        id: 'pane-unreferenced',
        kind: 'pane',
        generation: 1,
        projectRoot: '/canonical/project',
        worktreeRoot: '/canonical/project',
        tmuxPaneId: '%4',
        writable: false,
        outputSequence: 6,
      },
    ],
    leaseRequests: [
      {
        id: 'request-alpha-pending',
        ownerEpoch: 7,
        actorId: 'agent-shared',
        taskId: 'task-alpha',
        status: 'pending',
        createdAt: '2026-08-14T12:00:00.000Z',
        ttlMs: 60_000,
        grants: [
          {
            target: { kind: 'pane', id: 'pane-alpha', generation: 1 },
            capabilities: ['pane.observe'],
          },
          {
            target: { kind: 'pane', id: 'pane-alpha', generation: 1 },
            capabilities: ['pane.focus'],
          },
          {
            target: { kind: 'pane', id: 'pane-stale', generation: 1 },
            capabilities: ['pane.observe'],
          },
        ],
      },
      {
        id: 'request-beta-pending',
        ownerEpoch: 7,
        actorId: 'agent-shared',
        taskId: 'task-beta',
        status: 'pending',
        createdAt: '2026-08-14T12:01:00.000Z',
        ttlMs: 60_000,
        grants: [{
          target: { kind: 'pane', id: 'pane-beta', generation: 1 },
          capabilities: ['pane.observe'],
        }],
      },
    ],
    capabilityLeases: [
      {
        id: 'lease-alpha',
        requestId: 'request-alpha-active',
        revision: 1,
        ownerEpoch: 7,
        actorId: 'agent-shared',
        taskId: 'task-alpha',
        grantedBy: 'operator',
        grants: [
          {
            target: { kind: 'browser_tab', id: 'tab-alpha', generation: 3 },
            capabilities: ['browser.inspect'],
          },
          {
            target: { kind: 'pane', id: 'pane-alpha', generation: 1 },
            capabilities: ['pane.observe'],
          },
          {
            target: { kind: 'pane', id: 'pane-alpha', generation: 1 },
            capabilities: ['pane.focus'],
          },
          {
            target: { kind: 'pane', id: 'pane-stale', generation: 1 },
            capabilities: ['pane.observe'],
          },
        ],
        createdAt: '2026-08-14T12:02:00.000Z',
        expiresAt: '2099-08-14T13:02:00.000Z',
      },
      {
        id: 'lease-beta',
        requestId: 'request-beta-active',
        revision: 2,
        ownerEpoch: 7,
        actorId: 'agent-shared',
        taskId: 'task-beta',
        grantedBy: 'operator',
        grants: [{
          target: { kind: 'browser_tab', id: 'tab-beta', generation: 4 },
          capabilities: ['browser.inspect'],
        }],
        createdAt: '2026-08-14T12:03:00.000Z',
        expiresAt: '2099-08-14T13:03:00.000Z',
      },
      {
        id: 'lease-alpha-expired',
        requestId: 'request-alpha-expired',
        revision: 1,
        ownerEpoch: 7,
        actorId: 'agent-shared',
        taskId: 'task-alpha',
        grantedBy: 'operator',
        grants: [{
          target: { kind: 'pane', id: 'pane-unreferenced', generation: 1 },
          capabilities: ['pane.observe'],
        }],
        createdAt: '2000-01-01T00:00:00.000Z',
        expiresAt: '2000-01-01T00:01:00.000Z',
      },
    ],
    approvals: [],
    receipts: [],
  };
}

describe('control credential store', () => {
  it('issues distinct tokens that authenticate as agents bound to their exact tasks', async () => {
    const root = await tempProject();
    const filePath = path.join(root, '.psyche', 'runtime', 'control-credentials.json');
    const store = await createControlCredentialStore({ projectRoot: root, filePath });

    const alpha = await issueControlTaskToken({
      projectRoot: root,
      taskId: 'task-alpha',
      filePath,
    });
    const beta = await issueControlTaskToken({
      projectRoot: root,
      taskId: 'task-beta',
      filePath,
    });

    expect(alpha).not.toBe(beta);
    await expect(store.authenticate(alpha)).resolves.toMatchObject({
      principal: { kind: 'agent' },
      taskBinding: { taskId: 'task-alpha' },
    });
    await expect(store.authenticate(beta)).resolves.toMatchObject({
      principal: { kind: 'agent' },
      taskBinding: { taskId: 'task-beta' },
    });
  });

  it.each(['', '   '])('rejects blank task IDs (%j)', async (taskId) => {
    const root = await tempProject();

    await expect(issueControlTaskToken({ projectRoot: root, taskId }))
      .rejects.toThrow('taskId must not be blank');
  });

  it('accepts 256-character task IDs and rejects 257-character IDs at issuance', async () => {
    const root = await tempProject();
    const filePath = path.join(root, '.psyche', 'runtime', 'control-credentials.json');
    const store = await createControlCredentialStore({ projectRoot: root, filePath });
    const taskId = 't'.repeat(256);

    const token = await issueControlTaskToken({ projectRoot: root, taskId, filePath });

    await expect(store.authenticate(token)).resolves.toMatchObject({
      taskBinding: { taskId },
    });
    await expect(issueControlTaskToken({
      projectRoot: root,
      taskId: 't'.repeat(257),
      filePath,
    })).rejects.toThrow('taskId must be at most 256 characters');
  });

  it('normalizes task IDs and rejects oversized stored bindings during authentication', async () => {
    const root = await tempProject();
    const filePath = path.join(root, '.psyche', 'runtime', 'control-credentials.json');
    const normalizedToken = await issueControlTaskToken({
      projectRoot: root,
      taskId: '  task-alpha  ',
      filePath,
    });
    const oversizedToken = await issueControlTaskToken({
      projectRoot: root,
      taskId: 'task-beta',
      filePath,
    });
    const store = await createControlCredentialStore({ projectRoot: root, filePath });

    await expect(store.authenticate(normalizedToken)).resolves.toMatchObject({
      taskBinding: { taskId: 'task-alpha' },
    });
    await writeFile(
      taskBindingFilePath(filePath, oversizedToken),
      `${JSON.stringify({ taskId: 't'.repeat(257) })}\n`,
      { mode: 0o600 },
    );
    await expect(store.authenticate(oversizedToken))
      .rejects.toMatchObject({ code: 'credential_path_unsafe' });
  });

  it('stores task bindings in hashed 0600 files without exposing tokens in names', async () => {
    const root = await tempProject();
    const filePath = path.join(root, '.psyche', 'runtime', 'control-credentials.json');
    const token = await issueControlTaskToken({
      projectRoot: root,
      taskId: 'task-alpha',
      filePath,
    });
    const bindingPath = taskBindingFilePath(filePath, token);

    expect(path.basename(bindingPath)).not.toContain(token);
    expect(JSON.parse(await readFile(bindingPath, 'utf8'))).toEqual({ taskId: 'task-alpha' });
    expect((await stat(bindingPath)).mode & 0o777).toBe(0o600);
  });

  it('rejects a symlink in the task-binding parent path', async () => {
    const root = await realpath(await tempProject());
    const outside = await tempProject();
    const filePath = path.join(root, '.psyche', 'runtime', 'control-credentials.json');
    await mkdir(path.dirname(filePath), { recursive: true });
    await symlink(outside, taskBindingDirectory(filePath));

    await expect(issueControlTaskTokenForCanonicalRoot({
      canonicalProjectRoot: root,
      taskId: 'task-alpha',
      filePath,
    })).rejects.toMatchObject({ code: 'credential_path_unsafe' });
  });

  it('rejects a task-binding parent replaced with a symlink before authentication', async () => {
    const root = await tempProject();
    const outside = await tempProject();
    const filePath = path.join(root, '.psyche', 'runtime', 'control-credentials.json');
    const token = await issueControlTaskToken({
      projectRoot: root,
      taskId: 'task-alpha',
      filePath,
    });
    const bindingPath = taskBindingFilePath(filePath, token);
    await writeFile(
      path.join(outside, path.basename(bindingPath)),
      await readFile(bindingPath),
      { mode: 0o600 },
    );
    await rm(taskBindingDirectory(filePath), { recursive: true });
    await symlink(outside, taskBindingDirectory(filePath));
    const store = await createControlCredentialStore({ projectRoot: root, filePath });

    await expect(store.authenticate(token))
      .rejects.toMatchObject({ code: 'credential_path_unsafe' });
  });

  it('rejects a symlink task-binding target during authentication', async () => {
    const root = await tempProject();
    const filePath = path.join(root, '.psyche', 'runtime', 'control-credentials.json');
    const token = await issueControlTaskToken({
      projectRoot: root,
      taskId: 'task-alpha',
      filePath,
    });
    const bindingPath = taskBindingFilePath(filePath, token);
    const victim = path.join(root, 'victim-task-binding.json');
    const victimContents = '{"taskId":"victim"}\n';
    await writeFile(victim, victimContents, { mode: 0o600 });
    await unlink(bindingPath);
    await symlink(victim, bindingPath);
    const store = await createControlCredentialStore({ projectRoot: root, filePath });

    await expect(store.authenticate(token))
      .rejects.toMatchObject({ code: 'credential_path_unsafe' });
    expect(await readFile(victim, 'utf8')).toBe(victimContents);
  });

  it('rejects a malformed task-binding file instead of treating it as unknown', async () => {
    const root = await tempProject();
    const filePath = path.join(root, '.psyche', 'runtime', 'control-credentials.json');
    const token = await issueControlTaskToken({
      projectRoot: root,
      taskId: 'task-alpha',
      filePath,
    });
    await writeFile(taskBindingFilePath(filePath, token), '{}\n', { mode: 0o600 });
    const store = await createControlCredentialStore({ projectRoot: root, filePath });

    await expect(store.authenticate(token))
      .rejects.toMatchObject({ code: 'credential_path_unsafe' });
  });

  it('concurrently issues unique complete task bindings that all authenticate', async () => {
    const root = await realpath(await tempProject());
    const filePath = path.join(root, '.psyche', 'runtime', 'control-credentials.json');
    const taskIds = Array.from({ length: 64 }, (_, index) => `task-${index}`);
    const tokens = await Promise.all(taskIds.map((taskId) => (
      issueControlTaskTokenForCanonicalRoot({
        canonicalProjectRoot: root,
        taskId,
        filePath,
      })
    )));

    expect(new Set(tokens).size).toBe(tokens.length);
    const store = await createControlCredentialStoreForCanonicalRoot({
      canonicalProjectRoot: root,
      filePath,
    });
    const identities = await Promise.all(tokens.map((token) => store.authenticate(token)));
    expect(identities.map((identity) => identity?.taskBinding?.taskId)).toEqual(taskIds);

    const bindingFiles = await readdir(taskBindingDirectory(filePath));
    expect(bindingFiles).toHaveLength(tokens.length);
    expect(bindingFiles.every((name) => /^[a-f0-9]{64}\.json$/.test(name))).toBe(true);
    const persistedTaskIds = await Promise.all(bindingFiles.map(async (name) => {
      const binding = JSON.parse(await readFile(
        path.join(taskBindingDirectory(filePath), name),
        'utf8',
      )) as { taskId: string };
      return binding.taskId;
    }));
    expect(new Set(persistedTaskIds)).toEqual(new Set(taskIds));
  });

  it('mints operator and agent tokens that authenticate to their principals', async () => {
    const root = await tempProject();
    const filePath = path.join(root, 'control-credentials.json');
    const store = await createControlCredentialStore({ projectRoot: root, filePath });

    const operatorToken = await store.operatorToken();
    const agentToken = await store.agentToken();

    expect(operatorToken).not.toEqual(agentToken);
    const operatorIdentity = await store.authenticate(operatorToken);
    const agentIdentity = await store.authenticate(agentToken);
    expect(operatorIdentity).toMatchObject({
      kind: 'operator',
      principal: { kind: 'operator' },
    });
    expect(operatorIdentity?.taskBinding).toBeUndefined();
    expect(agentIdentity).toMatchObject({
      kind: 'agent',
      principal: { kind: 'agent' },
    });
    expect(agentIdentity?.taskBinding).toBeUndefined();
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
  it('preserves legacy direct readEvents(afterSequence, limit) calls', () => {
    const readEvents = vi.fn((afterSequence: number, limit?: number) => ({
      events: [{ afterSequence, limit }],
      nextSequence: afterSequence + 1,
      gap: false,
    }));
    const server = createControlServerForTest({
      runtime: stubRuntime(vi.fn(), undefined, readEvents),
    });

    expect(server.readEvents(0, 10)).toEqual({
      events: [{ afterSequence: 0, limit: 10 }],
      nextSequence: 1,
      gap: false,
    });
    expect(readEvents).toHaveBeenCalledWith(0, 10);
  });

  it('requires operator identity for identity-aware event reads', () => {
    const readEvents = vi.fn((afterSequence: number, limit?: number) => ({
      events: [{ afterSequence, limit }],
      nextSequence: afterSequence + 1,
      gap: false,
    }));
    const server = createControlServerForTest({
      runtime: stubRuntime(vi.fn(), undefined, readEvents),
    });
    const agentIdentity = authenticatedIdentity({
      id: 'agent-1', kind: 'agent', capabilities: ['read', 'mutate'],
    }, 'task-alpha');
    const compatibilityIdentity = authenticatedIdentity({
      id: 'compatibility-1', kind: 'compatibility', capabilities: ['read'],
    });
    const operatorIdentity = authenticatedIdentity({
      id: 'operator-1', kind: 'operator', capabilities: ['read', 'mutate', 'delegate'],
    });

    for (const identity of [agentIdentity, compatibilityIdentity]) {
      expect(() => server.readEvents(identity, 0)).toThrowError(
        expect.objectContaining({
          code: 'operator_required',
          message: 'raw control events require operator authority',
        }),
      );
    }
    expect(server.readEvents(operatorIdentity, 0, 10)).toEqual({
      events: [{ afterSequence: 0, limit: 10 }],
      nextSequence: 1,
      gap: false,
    });
    expect(readEvents).toHaveBeenCalledOnce();
    expect(readEvents).toHaveBeenCalledWith(0, 10);
  });

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

  it('scopes dedicated authority reads to the authenticated task binding', () => {
    const snapshot = scopedReadSnapshot();
    (snapshot.resources[0] as unknown as Record<string, unknown>).futureSecret = 'resource-future-secret';
    (snapshot.leaseRequests[0] as unknown as Record<string, unknown>).futureSecret = 'request-future-secret';
    (snapshot.capabilityLeases[0] as unknown as Record<string, unknown>).futureSecret = 'lease-future-secret';
    const authority = createControlServerForTest({
      ownerEpoch: 7,
      runtime: stubRuntime(vi.fn(), snapshot),
    });
    const agent: ControlPrincipal = {
      id: 'agent-shared', kind: 'agent', capabilities: ['read', 'mutate'],
    };
    const alpha = authenticatedIdentity(agent, 'task-alpha');
    const beta = authenticatedIdentity(agent, 'task-beta');

    const alphaResources = authority.taskResources(alpha);
    expect(alphaResources).toMatchObject({ ownerEpoch: 7, sequence: 41 });
    expect(alphaResources.resources.map((resource) => resource.id))
      .toEqual(['pane-alpha', 'tab-alpha']);
    expect(new Set(alphaResources.resources.map((resource) => resource.id)).size)
      .toBe(alphaResources.resources.length);
    expect(JSON.stringify(alphaResources)).not.toMatch(
      /beta|stale|unreferenced|resource-future-secret/,
    );

    const alphaPending = authority.leaseStatus(alpha, 'request-alpha-pending');
    expect(alphaPending.requests.map((request) => request.id))
      .toEqual(['request-alpha-pending']);
    expect(alphaPending.leases).toEqual([]);
    const alphaActive = authority.leaseStatus(alpha, 'request-alpha-active');
    expect(alphaActive.requests).toEqual([]);
    expect(alphaActive.leases.map((lease) => lease.id)).toEqual(['lease-alpha']);
    expect(authority.leaseStatus(alpha, 'request-alpha-active', 'lease-alpha')
      .leases.map((lease) => lease.id)).toEqual(['lease-alpha']);
    expect(authority.leaseStatus(alpha, 'request-alpha-active', 'lease-beta'))
      .toEqual({ requests: [], leases: [] });

    const missing = authority.leaseStatus(alpha, 'request-missing');
    expect(authority.leaseStatus(alpha, 'request-beta-pending')).toEqual(missing);
    expect(authority.leaseStatus(alpha, 'request-beta-active')).toEqual(missing);
    expect(missing).toEqual({ requests: [], leases: [] });
    expect(authority.leaseStatus(beta, 'request-alpha-active')).toEqual(missing);
    expect(JSON.stringify(alphaPending)).not.toContain('request-future-secret');
    expect(JSON.stringify(alphaActive)).not.toContain('lease-future-secret');

    const sourceViewport = (snapshot.resources.find((resource) => resource.id === 'tab-alpha') as {
      viewport: { width: number };
    }).viewport;
    sourceViewport.width = 1;
    expect((alphaResources.resources.find((resource) => resource.id === 'tab-alpha') as {
      viewport: { width: number };
    }).viewport.width).toBe(1280);
    const sourceRequestCapabilities = (
      snapshot.leaseRequests[0]?.grants[0]?.capabilities
    ) as unknown as string[];
    sourceRequestCapabilities[0] = 'pane.focus';
    expect(alphaPending.requests[0]?.grants[0]?.capabilities).toEqual(['pane.observe']);
    const sourceLeaseTarget = (
      snapshot.capabilityLeases[0]?.grants[0]?.target
    ) as unknown as { id: string };
    sourceLeaseTarget.id = 'tab-mutated';
    expect(alphaActive.leases[0]?.grants[0]?.target)
      .toMatchObject({ id: 'tab-alpha', generation: 3 });
    expect(Object.isFrozen(alphaResources)).toBe(true);
    expect(Object.isFrozen(alphaResources.resources)).toBe(true);
    expect(Object.isFrozen(alphaResources.resources[0])).toBe(true);
    expect(Object.isFrozen(alphaPending.requests[0]?.grants[0]?.target)).toBe(true);
    expect(Object.isFrozen(alphaActive.leases[0]?.grants[0]?.capabilities)).toBe(true);
  });

  it('requires task binding for dedicated authority reads while preserving operator snapshots', () => {
    const snapshot = scopedReadSnapshot();
    const authority = createControlServerForTest({
      ownerEpoch: 7,
      runtime: stubRuntime(vi.fn(), snapshot),
    });
    const unboundAgent = authenticatedIdentity({
      id: 'agent-shared', kind: 'agent', capabilities: ['read', 'mutate'],
    });
    const compatibility = authenticatedIdentity({
      id: 'compatibility', kind: 'compatibility', capabilities: ['read', 'mutate'],
    });
    const operator = authenticatedIdentity({
      id: 'operator', kind: 'operator', capabilities: ['read', 'mutate', 'delegate'],
    });

    for (const identity of [unboundAgent, compatibility, operator]) {
      expect(() => authority.taskResources(identity)).toThrowError(expect.objectContaining({
        code: 'task_binding_required',
        message: 'task-bound control credential required',
      }));
      expect(() => authority.leaseStatus(identity, 'request-alpha-active'))
        .toThrowError(expect.objectContaining({
          code: 'task_binding_required',
          message: 'task-bound control credential required',
        }));
    }
    expect(authority.snapshot(operator)).toEqual(snapshot);
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

  it('returns only the credential-store authenticated task binding over a real socket', async () => {
    const root = await tempProject();
    const endpoint = path.join(root, 'control.sock');
    const filePath = path.join(root, 'control-credentials.json');
    const credentials = await createControlCredentialStore({ projectRoot: root, filePath });
    const taskToken = await issueControlTaskToken({
      projectRoot: root,
      taskId: 'task-alpha',
      filePath,
    });
    const server = await ControlServer.start({
      endpoint,
      projectRoot: root,
      ownerEpoch: 1,
      runtime: stubRuntime(vi.fn()),
      credentials,
    });
    const cleanups: Array<() => Promise<void>> = [() => server.close()];

    try {
      const taskClient = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: taskToken,
        clientName: 'task-alpha',
        taskBinding: { taskId: 'task-alpha' },
      });
      cleanups.unshift(() => taskClient.close());
      const sharedAgent = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: await credentials.agentToken(),
        clientName: 'shared-agent',
      });
      cleanups.unshift(() => sharedAgent.close());

      expect(taskClient.taskBinding).toEqual({ taskId: 'task-alpha' });
      expect(sharedAgent.taskBinding).toBeUndefined();
    } finally {
      await Promise.allSettled(cleanups.map(async (close) => close()));
    }
  });

  it('enforces task-scoped resource and lease-status reads over a real socket', async () => {
    const root = await tempProject();
    const endpoint = path.join(root, 'control.sock');
    const filePath = path.join(root, 'control-credentials.json');
    const baseCredentials = await createControlCredentialStore({ projectRoot: root, filePath });
    const alphaToken = await issueControlTaskToken({
      projectRoot: root,
      taskId: 'task-alpha',
      filePath,
    });
    const betaToken = await issueControlTaskToken({
      projectRoot: root,
      taskId: 'task-beta',
      filePath,
    });
    const compatibilityToken = 'compatibility-token';
    const compatibilityPrincipal: ControlPrincipal = {
      id: 'compatibility',
      kind: 'compatibility',
      capabilities: ['read', 'mutate'],
    };
    const credentials: ControlCredentialStore = {
      authenticate: async (token) => (
        token === compatibilityToken
          ? authenticatedIdentity(compatibilityPrincipal)
          : baseCredentials.authenticate(token)
      ),
      operatorToken: () => baseCredentials.operatorToken(),
      agentToken: () => baseCredentials.agentToken(),
    };
    const snapshot = scopedReadSnapshot();
    const server = await ControlServer.start({
      endpoint,
      projectRoot: root,
      ownerEpoch: 7,
      runtime: stubRuntime(vi.fn(), snapshot),
      credentials,
    });
    const cleanups: Array<() => Promise<void>> = [() => server.close()];

    try {
      const alpha = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: alphaToken,
        clientName: 'task-alpha',
        taskBinding: { taskId: 'task-alpha' },
      });
      cleanups.unshift(() => alpha.close());
      const beta = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: betaToken,
        clientName: 'task-beta',
        taskBinding: { taskId: 'task-beta' },
      });
      cleanups.unshift(() => beta.close());
      const sharedAgent = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: await credentials.agentToken(),
        clientName: 'shared-agent',
      });
      cleanups.unshift(() => sharedAgent.close());
      const compatibility = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: compatibilityToken,
        clientName: 'compatibility',
      });
      cleanups.unshift(() => compatibility.close());
      const operator = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: await credentials.operatorToken(),
        clientName: 'operator',
      });
      cleanups.unshift(() => operator.close());

      await expect(alpha.taskResources()).resolves.toMatchObject({
        ownerEpoch: 7,
        sequence: 41,
        resources: [
          expect.objectContaining({ id: 'pane-alpha', generation: 1 }),
          expect.objectContaining({ id: 'tab-alpha', generation: 3 }),
        ],
      });
      await expect(beta.taskResources()).resolves.toMatchObject({
        resources: [
          expect.objectContaining({ id: 'tab-beta', generation: 4 }),
        ],
      });
      await expect(alpha.leaseStatus('request-alpha-pending')).resolves.toMatchObject({
        requests: [expect.objectContaining({ id: 'request-alpha-pending' })],
        leases: [],
      });
      await expect(alpha.leaseStatus('request-alpha-active', 'lease-alpha'))
        .resolves.toMatchObject({
          requests: [],
          leases: [expect.objectContaining({ id: 'lease-alpha' })],
        });
      const missing = { requests: [], leases: [] };
      await expect(alpha.leaseStatus('request-beta-pending')).resolves.toEqual(missing);
      await expect(alpha.leaseStatus('request-beta-active', 'lease-beta')).resolves.toEqual(missing);
      await expect(alpha.leaseStatus('request-missing')).resolves.toEqual(missing);
      await expect(alpha.leaseStatus('request-alpha-active', 'lease-beta'))
        .resolves.toEqual(missing);

      await expect(sharedAgent.taskResources()).rejects.toMatchObject({
        code: 'task_binding_required',
      });
      await expect(compatibility.leaseStatus('request-alpha-active')).rejects.toMatchObject({
        code: 'task_binding_required',
      });
      await expect(operator.taskResources()).rejects.toMatchObject({
        code: 'task_binding_required',
      });
      await expect(operator.getState()).resolves.toEqual(snapshot);
    } finally {
      await Promise.allSettled(cleanups.map(async (close) => close()));
    }
  });

  it('rejects nested orchestration identity bypasses over a real socket', async () => {
    const root = await tempProject();
    const otherRoot = await tempProject();
    const endpoint = path.join(root, 'control.sock');
    const filePath = path.join(root, 'control-credentials.json');
    const credentials = await createControlCredentialStore({ projectRoot: root, filePath });
    const taskToken = await issueControlTaskToken({
      projectRoot: root,
      taskId: 'task-alpha',
      filePath,
    });
    const submit = vi.fn<ControlServerRuntime['submit']>(
      async () => ({ status: 'succeeded' as const }),
    );
    const server = await ControlServer.start({
      endpoint,
      projectRoot: root,
      ownerEpoch: 1,
      runtime: stubRuntime(submit),
      credentials,
    });
    const cleanups: Array<() => Promise<void>> = [() => server.close()];

    try {
      const taskClient = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: taskToken,
        clientName: 'task-alpha',
        taskBinding: { taskId: 'task-alpha' },
      });
      cleanups.unshift(() => taskClient.close());

      await expect(taskClient.submit(orchestrationInput({
        id: 'nested-task-bypass',
        taskId: 'task-alpha',
        requestTaskId: 'task-beta',
        requestProjectRoot: root,
        projectRoot: root,
      }))).resolves.toMatchObject({
        status: 'rejected',
        code: 'task_binding_mismatch',
      });
      await expect(taskClient.submit(orchestrationInput({
        id: 'nested-project-bypass',
        taskId: 'task-alpha',
        requestTaskId: 'task-alpha',
        requestProjectRoot: otherRoot,
        projectRoot: root,
      }))).resolves.toMatchObject({
        status: 'rejected',
        code: 'project_mismatch',
      });
      expect(submit).not.toHaveBeenCalled();
    } finally {
      await Promise.allSettled(cleanups.map(async (close) => close()));
    }
  });

  it('allows only operators to read raw events over authenticated sockets', async () => {
    const root = await tempProject();
    const endpoint = path.join(root, 'control.sock');
    const baseCredentials = await createControlCredentialStore({
      projectRoot: root,
      filePath: path.join(root, 'control-credentials.json'),
    });
    const compatibilityToken = 'compatibility-token';
    const compatibilityPrincipal: ControlPrincipal = {
      id: 'compatibility',
      kind: 'compatibility',
      capabilities: ['read', 'mutate'],
    };
    const credentials: ControlCredentialStore = {
      authenticate: async (token) => (
        token === compatibilityToken
          ? authenticatedIdentity(compatibilityPrincipal)
          : baseCredentials.authenticate(token)
      ),
      operatorToken: () => baseCredentials.operatorToken(),
      agentToken: () => baseCredentials.agentToken(),
    };
    const readEvents = vi.fn((afterSequence: number, limit?: number) => ({
      events: [{ sequence: afterSequence + 1 }],
      nextSequence: afterSequence + 1,
      gap: limit === 0,
    }));
    const server = await ControlServer.start({
      endpoint,
      projectRoot: root,
      ownerEpoch: 1,
      runtime: stubRuntime(vi.fn(), undefined, readEvents),
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
      const agent = await connectLines(endpoint);
      cleanups.unshift(async () => { agent.socket.destroy(); });
      agent.send({
        version: 1,
        type: 'hello',
        requestId: 'hello-agent',
        token: await credentials.agentToken(),
        clientName: 'agent',
        projectRoot: root,
      });
      expect(await agent.next()).toMatchObject({ type: 'welcome' });
      const compatibility = await ControlClient.connect({
        projectRoot: root,
        endpoint,
        token: compatibilityToken,
        clientName: 'compatibility',
      });
      cleanups.unshift(() => compatibility.close());

      agent.send({
        version: 1,
        type: 'events.read',
        requestId: 'events-agent',
        afterSequence: 37,
        limit: 10,
      });
      expect(await agent.next()).toEqual({
        version: 1,
        type: 'error',
        requestId: 'events-agent',
        code: 'operator_required',
        message: 'raw control events require operator authority',
      });
      await expect(compatibility.readEvents(0, 10)).rejects.toMatchObject({
        code: 'operator_required',
        message: 'operator_required: raw control events require operator authority',
      });
      await expect(operator.readEvents(0, 10)).resolves.toEqual({
        events: [{ sequence: 1 }],
        nextSequence: 1,
        gap: false,
      });
      expect(readEvents).toHaveBeenCalledOnce();
      expect(readEvents).toHaveBeenCalledWith(0, 10);
    } finally {
      await Promise.allSettled(cleanups.map(async (close) => close()));
    }
  });

  it('requires authenticated task scope for task-sensitive non-operator commands', async () => {
    const submit = vi.fn(async () => ({ status: 'succeeded' as const }));
    const server = createControlServerForTest({ runtime: stubRuntime(submit) });
    const agent: ControlPrincipal = {
      id: 'agent-1',
      kind: 'agent',
      capabilities: ['read', 'mutate'],
    };
    const compatibility: ControlPrincipal = {
      id: 'compat-1',
      kind: 'compatibility',
      capabilities: ['read', 'mutate'],
    };
    const alpha = authenticatedIdentity(agent, 'task-alpha');

    for (const command of taskSensitiveInputs('task-beta')) {
      await expect(server.submitAs(alpha, command)).resolves.toMatchObject({
        status: 'rejected',
        code: 'task_binding_mismatch',
      });
      await expect(server.submitAs(agent, command)).resolves.toMatchObject({
        status: 'rejected',
        code: 'task_binding_required',
      });
      await expect(server.submitAs(compatibility, command)).resolves.toMatchObject({
        status: 'rejected',
        code: 'task_binding_required',
      });
    }
    for (const command of taskSensitiveInputs('task-alpha')) {
      await expect(server.submitAs(alpha, command)).resolves.toMatchObject({
        status: 'succeeded',
      });
    }
    await expect(server.submitAs(
      { id: 'operator', kind: 'operator', capabilities: ['read', 'mutate', 'delegate'] },
      taskSensitiveInputs('task-beta')[0],
    )).resolves.toMatchObject({ status: 'succeeded' });
    expect(submit).toHaveBeenCalledTimes(4);
  });

  it('rejects nested orchestration identity mismatches and stamps trusted identity', async () => {
    const submit = vi.fn<ControlServerRuntime['submit']>(
      async () => ({ status: 'succeeded' as const }),
    );
    const server = createControlServerForTest({
      runtime: stubRuntime(submit),
      projectRoot: '/canonical/project',
    });
    const agent: ControlPrincipal = {
      id: 'agent-1',
      kind: 'agent',
      capabilities: ['read', 'mutate'],
    };
    const alpha = authenticatedIdentity(agent, 'task-alpha');

    await expect(server.submitAs(alpha, orchestrationInput({
      id: 'unit-nested-task-bypass',
      taskId: 'task-alpha',
      requestTaskId: 'task-beta',
      requestProjectRoot: '/canonical/project',
    }))).resolves.toMatchObject({
      status: 'rejected',
      code: 'task_binding_mismatch',
    });
    await expect(server.submitAs(alpha, orchestrationInput({
      id: 'unit-nested-project-bypass',
      taskId: 'task-alpha',
      requestTaskId: 'task-alpha',
      requestProjectRoot: '/different/project',
    }))).resolves.toMatchObject({
      status: 'rejected',
      code: 'project_mismatch',
    });
    expect(submit).not.toHaveBeenCalled();

    const canonicalAgentInput = orchestrationInput({
      id: 'unit-canonical-agent',
      taskId: 'task-alpha',
      requestTaskId: 'task-alpha',
      requestProjectRoot: '/canonical/project',
    });
    await expect(server.submitAs(alpha, canonicalAgentInput))
      .resolves.toMatchObject({ status: 'succeeded' });
    const canonicalOperatorInput = orchestrationInput({
      id: 'unit-canonical-operator',
      taskId: 'task-operator',
      requestTaskId: 'task-operator',
      requestProjectRoot: '/canonical/project',
    });
    await expect(server.submitAs(
      { id: 'operator', kind: 'operator', capabilities: ['read', 'mutate', 'delegate'] },
      canonicalOperatorInput,
    )).resolves.toMatchObject({ status: 'succeeded' });

    expect(submit).toHaveBeenCalledTimes(2);
    const submittedInputs = [canonicalAgentInput, canonicalOperatorInput];
    submit.mock.calls.forEach(([submitted], index) => {
      if (submitted.kind !== 'orchestration.execute') {
        throw new Error(`unexpected submitted command kind: ${submitted.kind}`);
      }
      expect(submitted.payload.request).toMatchObject({
        taskId: submitted.payload.taskId,
        projectRoot: '/canonical/project',
      });
      expect(submitted.payload.request).not.toBe(submittedInputs[index]?.payload.request);
    });
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
    await expect(server.submitAs(compatibility, request))
      .resolves.toMatchObject({ status: 'rejected', code: 'task_binding_required' });
    await expect(server.submitAs(authenticatedIdentity(agent, 't'), request))
      .resolves.toMatchObject({ status: 'succeeded' });
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
