import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlCredentialStore } from '../src/control/credentials.js';
import { createControlServerForTest } from '../src/control/server.js';
import type { ControlServerRuntime } from '../src/control/server.js';
import type { ControlCommandInput } from '../src/control/types.js';
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

function stubRuntime(submit: ControlServerRuntime['submit']): ControlServerRuntime {
  return {
    submit,
    snapshot: () => ({ ownerEpoch: 1, sequence: 0, commands: {}, leases: {} }),
    readEvents: () => ({ events: [], nextSequence: 0, gap: false }),
  };
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
});

describe('control server authorization', () => {
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
});
