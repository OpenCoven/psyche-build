import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlRuntime, type ControlHandlers } from '../src/control/runtime.js';
import { ApprovalStore } from '../src/control/approvals.js';
import { CapabilityLeaseStore } from '../src/control/capabilityLeases.js';
import { SurfaceRegistry } from '../src/control/surfaces.js';
import type { ControlCommand } from '../src/control/types.js';
import { createHostControlPlane } from '../src/control/host.js';

const handlers: ControlHandlers = {
  executeOrchestration: vi.fn(),
  spawnPane: vi.fn(),
  sendPrompt: vi.fn(),
  interruptPane: vi.fn(),
  sendInput: vi.fn(),
  openTerminal: vi.fn(),
  resizePane: vi.fn(),
  focusPane: vi.fn(),
  killPane: vi.fn(),
  respawnPane: vi.fn(),
  openConflictPane: vi.fn(),
  updatePaneOption: vi.fn(),
  updatePaneMeta: vi.fn(),
  launchRitual: vi.fn(),
  launchCovenSession: vi.fn(),
  openCovenSession: vi.fn(),
  runCovenDesktopAction: vi.fn(),
  executeCovenCapability: vi.fn(),
  observePane: vi.fn(),
  actOnPane: vi.fn(),
  inspectBrowser: vi.fn(),
  actOnBrowser: vi.fn(),
  runBrowserScript: vi.fn(),
};

const now = () => new Date('2026-08-12T12:00:00.000Z');

function agentSurfaceHarness() {
  const surfaces = new SurfaceRegistry();
  surfaces.upsertBrowserTab({
    id: 'tab-1', providerId: 'desktop-1', webviewLabel: 'browser-a',
    projectRoot: '/repo', worktreeRoot: '/repo', url: 'https://example.test',
    title: 'Example', loading: false, viewport: { width: 800, height: 600 },
  });
  const capabilityLeases = new CapabilityLeaseStore(now, 7);
  const approvals = new ApprovalStore(now, () => 'approval-1');
  const lease = capabilityLeases.grant({
    requestId: 'request-1', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1',
    ttlMs: 60_000,
    grants: [{
      target: { kind: 'browser_tab', id: 'tab-1', generation: 1 },
      capabilities: ['browser.interact'],
    }],
  });
  const risk = { submit: false };
  const resolveBrowserSnapshot = vi.fn(async (payload: {
    tabId: string; generation: number; snapshotId?: string; action: { kind: string; elementRef?: string };
  }) => {
    if (!payload.snapshotId || !payload.action.elementRef) return undefined;
    return {
      tabId: payload.tabId, generation: payload.generation, snapshotId: payload.snapshotId,
      elementRef: payload.action.elementRef, actionKind: payload.action.kind as 'click', submit: risk.submit,
    };
  });
  return { surfaces, capabilityLeases, approvals, lease, risk, resolveBrowserSnapshot };
}

function browserAction(leaseId: string, overrides: Record<string, unknown> = {}) {
  return command({
    id: 'cmd-click', idempotencyKey: 'idem-click', kind: 'browser.action',
    projectRoot: '/repo', actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
    createdAt: '2026-08-12T12:00:00.000Z',
    payload: {
      taskId: 'task-1', leaseId, leaseRevision: 1,
      tabId: 'tab-1', generation: 1, snapshotId: 'snapshot-1',
      action: {
        kind: 'click', elementRef: 'e17',
        semantic: { role: 'button', name: 'Refresh', submit: false },
      },
    },
    ...overrides,
  }) as unknown as Extract<ControlCommand, { kind: 'browser.action' }>;
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmd-1',
    idempotencyKey: 'idem-1',
    kind: 'pane.takeover',
    projectRoot: '/repo',
    actor: { id: 'human-1', kind: 'human' },
    ownerEpoch: 4,
    createdAt: '2026-08-03T20:00:00.000Z',
    payload: { paneId: '%3' },
    ...overrides,
  } as const;
}

function createMemoryJournal() {
  const events: Array<{ sequence: number; kind: string; payload: Record<string, unknown> }> = [];
  return {
    append: vi.fn(async (kind: string, payload: Record<string, unknown>) => {
      const event = { sequence: events.length + 1, kind, payload };
      events.push(event);
      return event;
    }),
    read: () => [...events],
    findByIdempotencyKey: (key: string) =>
      [...events].reverse().find((event) => event.payload.idempotencyKey === key),
    recoverNonterminalCommands: vi.fn(
      async (): Promise<Array<{ sequence: number; kind: string; payload: Record<string, unknown> }>> => [],
    ),
  };
}

describe('ControlRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.sendPrompt = vi.fn();
    handlers.actOnBrowser = vi.fn();
    handlers.inspectBrowser = vi.fn();
    handlers.actOnPane = vi.fn();
    handlers.observePane = vi.fn();
    handlers.runBrowserScript = vi.fn();
  });

  it('returns the prior outcome for a duplicate idempotency key', async () => {
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4,
      handlers,
      journal: createMemoryJournal(),
    });
    const first = await runtime.submit(command());
    const second = await runtime.submit(command());
    expect(second).toEqual(first);
    expect(runtime.events().filter((event) => event.kind === 'command.requested'))
      .toHaveLength(1);
  });

  it('joins an in-flight exact retry after requested persistence and conflicts on changed identity', async () => {
    const deps = agentSurfaceHarness();
    let release!: () => void;
    handlers.actOnBrowser = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const journal = createMemoryJournal();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    const original = browserAction(deps.lease.id);
    const first = runtime.submit(original);
    await vi.waitFor(() => expect(journal.read().some((event) => (
      event.kind === 'command.requested' && event.payload.commandId === original.id
    ))).toBe(true));
    const retry = runtime.submit(original);
    let retrySettled = false;
    void retry.finally(() => { retrySettled = true; });
    await Promise.resolve();
    expect(retrySettled).toBe(false);
    await expect(runtime.submit(browserAction(deps.lease.id, {
      id: original.id, idempotencyKey: original.idempotencyKey,
      payload: { ...original.payload, action: { kind: 'reload' } },
    }))).resolves.toMatchObject({ status: 'rejected', code: 'command_conflict' });
    release();
    await expect(Promise.all([first, retry])).resolves.toEqual([
      expect.objectContaining({ status: 'succeeded' }),
      expect.objectContaining({ status: 'succeeded' }),
    ]);
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale owner epoch before side effects', async () => {
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4,
      handlers,
      journal: createMemoryJournal(),
    });
    await expect(runtime.submit(command({ ownerEpoch: 3 })))
      .resolves.toMatchObject({ status: 'rejected', code: 'stale_owner_epoch' });
    expect(handlers.sendInput).not.toHaveBeenCalled();
  });

  it('fails closed for missing agent surface generations before any effect handler', async () => {
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4,
      handlers,
      journal: createMemoryJournal(),
    });

    await expect(runtime.submit(command({
      kind: 'pane.observe',
      actor: { id: 'psyche-1', kind: 'psyche' },
      payload: {
        taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
        paneId: 'pane-1', generation: 1,
      },
    }))).resolves.toMatchObject({
      status: 'failed',
      code: 'resource_missing',
    });
    for (const handler of Object.values(handlers)) {
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('revokes automation before accepting human input', async () => {
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4,
      handlers,
      journal: createMemoryJournal(),
    });
    const delegated = runtime.leases.delegate('%3', 'psyche-1', 'task-1', 60_000);
    await runtime.submit(command());
    await runtime.submit(command({
      id: 'cmd-input',
      idempotencyKey: 'idem-input',
      kind: 'pane.input',
      payload: {
        paneId: '%3',
        dataBase64: Buffer.from('status').toString('base64'),
        leaseRevision: delegated.revision + 1,
      },
    }));
    expect(handlers.sendInput).toHaveBeenCalledTimes(1);
    expect(() => runtime.leases.assertAutomation('%3', 'psyche-1', delegated.revision))
      .toThrow('lease revision mismatch');
  });

  it('journals human delegation to a task-bound Psyche actor', async () => {
    const journal = createMemoryJournal();
    const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers, journal });
    const outcome = await runtime.submit(command({
      kind: 'pane.delegate',
      payload: {
        paneId: '%3',
        automationActorId: 'psyche-1',
        taskId: 'task-1',
        ttlMs: 60_000,
      },
    }));
    expect(outcome).toMatchObject({
      status: 'succeeded',
      value: { actorId: 'psyche-1', taskId: 'task-1', revision: 1 },
    });
    expect(journal.read().map((event) => event.kind)).toContain('lease.delegated');
  });

  it('rejects psyche legacy prompt before ambiguous dispatch', async () => {
    handlers.sendPrompt = vi.fn(async () => {
      throw Object.assign(new Error('connection closed'), { ambiguous: true });
    });
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4,
      handlers,
      journal: createMemoryJournal(),
    });
    const lease = runtime.leases.delegate('%3', 'psyche-1', 'task-1', 60_000);
    const prompt = command({
      kind: 'pane.prompt',
      actor: { id: 'psyche-1', kind: 'psyche' },
      payload: {
        promptId: 'prompt-1',
        paneId: '%3',
        utf8: 'continue',
        contentHash: 'e256ee8e7aff6957a781d8328f0f68e26996564c81fa458da59fbca2305138ad',
        submitMode: 'text-and-enter',
        leaseRevision: lease.revision,
      },
    });
    expect(await runtime.submit(prompt)).toMatchObject({ status: 'rejected', code: 'agent_mutation_denied' });
    expect(await runtime.submit(prompt)).toMatchObject({ status: 'rejected', code: 'agent_mutation_denied' });
    expect(handlers.sendPrompt).not.toHaveBeenCalled();
  });

  it('terminalizes an accepted crash-window command as unknown on restart', async () => {
    const journal = createMemoryJournal();
    await journal.append('command.requested', {
      commandId: 'cmd-crash',
      idempotencyKey: 'idem-crash',
    });
    await journal.append('command.accepted', {
      commandId: 'cmd-crash',
      idempotencyKey: 'idem-crash',
    });
    journal.recoverNonterminalCommands = vi.fn(async () => [
      await journal.append('command.unknown', {
        commandId: 'cmd-crash',
        idempotencyKey: 'idem-crash',
        code: 'recovered_ambiguous_command',
      }),
    ]);
    const runtime = await ControlRuntime.create({ ownerEpoch: 5, handlers, journal });
    expect(journal.recoverNonterminalCommands).toHaveBeenCalledTimes(1);
    expect(await runtime.submit(command({
      id: 'cmd-after-restart',
      idempotencyKey: 'idem-crash',
      ownerEpoch: 5,
    }))).toMatchObject({ status: 'unknown' });
    expect(handlers.sendPrompt).not.toHaveBeenCalled();
  });

  it('cancels queued automation before completing takeover', async () => {
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4,
      handlers,
      journal: createMemoryJournal(),
    });
    const lease = runtime.leases.delegate('%3', 'psyche-1', 'task-1', 60_000);
    const release = runtime.blockPaneQueue('%3');
    const queued = runtime.submit(command({
      id: 'cmd-prompt',
      idempotencyKey: 'idem-prompt',
      kind: 'pane.prompt',
      actor: { id: 'psyche-1', kind: 'psyche' },
      payload: {
        promptId: 'prompt-queued',
        paneId: '%3',
        utf8: 'continue',
        contentHash: 'e256ee8e7aff6957a781d8328f0f68e26996564c81fa458da59fbca2305138ad',
        submitMode: 'text-and-enter',
        leaseRevision: lease.revision,
      },
    }));
    const takeover = runtime.submit(command({
      id: 'cmd-takeover',
      idempotencyKey: 'idem-takeover',
      kind: 'pane.takeover',
    }));
    release();
    await expect(queued).resolves.toMatchObject({ status: 'rejected', code: 'agent_mutation_denied' });
    await expect(takeover).resolves.toMatchObject({ status: 'succeeded' });
    expect(handlers.sendPrompt).not.toHaveBeenCalled();
  });

  it('authorizes an exact generation lease and invokes exactly one surface handler', async () => {
    const deps = agentSurfaceHarness();
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps,
    });

    await expect(runtime.submit(browserAction(deps.lease.id))).resolves.toMatchObject({
      status: 'succeeded', value: { state: 'succeeded', actionId: 'cmd-click' },
    });
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(1);
    expect(handlers.inspectBrowser).not.toHaveBeenCalled();
    expect(deps.resolveBrowserSnapshot).toHaveBeenCalledTimes(2);
  });

  it('uses canonical snapshot risk, requests approval without invoking or holding the queue, then resumes immutable intent', async () => {
    const deps = agentSurfaceHarness();
    deps.risk.submit = true;
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps,
    });
    const original = browserAction(deps.lease.id);
    const pending = await runtime.submit(original);
    expect(pending).toMatchObject({
      status: 'succeeded',
      value: { state: 'approval_required', actionId: 'cmd-click', code: 'approval_required' },
    });
    expect(handlers.actOnBrowser).not.toHaveBeenCalled();

    const approval = deps.approvals.snapshot()[0]!;
    (original.payload.action as { elementRef: string }).elementRef = 'attacker';
    const unrelated = runtime.submit(browserAction(deps.lease.id, {
      id: 'cmd-other', idempotencyKey: 'idem-other',
      payload: {
        ...browserAction(deps.lease.id).payload,
        action: { kind: 'scroll', elementRef: 'e18', deltaY: 10 },
      },
    }));
    await expect(unrelated).resolves.toMatchObject({ status: 'succeeded' });

    await expect(runtime.submit(command({
      id: 'cmd-approve', idempotencyKey: 'idem-approve', kind: 'approval.resolve',
      actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
    }))).resolves.toMatchObject({ status: 'succeeded' });
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(2);
    expect(handlers.actOnBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: expect.objectContaining({ elementRef: 'e17' }) }),
    );
    await expect(runtime.submit(browserAction(deps.lease.id))).resolves.toMatchObject({
      status: 'succeeded', value: { state: 'succeeded', actionId: 'cmd-click' },
    });
  });

  it('journals the approved action final receipt for compacted status and replay idempotency', async () => {
    const deps = agentSurfaceHarness();
    deps.risk.submit = true;
    const journal = createMemoryJournal();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    const original = browserAction(deps.lease.id);
    await runtime.submit(original);
    const approval = deps.approvals.snapshot()[0]!;
    await runtime.submit(command({
      id: 'cmd-approve-final', idempotencyKey: 'idem-approve-final', kind: 'approval.resolve',
      actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
    }));
    expect(runtime.actionStatus(original.id)).toMatchObject({ state: 'succeeded', actionId: original.id });

    deps.risk.submit = false;
    for (let index = 0; index < 101; index += 1) {
      await runtime.submit(browserAction(deps.lease.id, {
        id: `cmd-compact-${index}`, idempotencyKey: `idem-compact-${index}`,
        payload: {
          ...browserAction(deps.lease.id).payload,
          action: { kind: 'scroll', elementRef: `compact-${index}`, deltaY: 1 },
        },
      }));
    }
    expect(runtime.actionStatus(original.id)).toMatchObject({ state: 'succeeded', actionId: original.id });

    const effectCount = vi.mocked(handlers.actOnBrowser).mock.calls.length;
    const replayed = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    await expect(replayed.submit(original)).resolves.toMatchObject({
      status: 'succeeded', value: { state: 'succeeded', actionId: original.id },
    });
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(effectCount);
    await expect(replayed.submit(browserAction(deps.lease.id, {
      id: original.id,
      idempotencyKey: original.idempotencyKey,
      payload: { ...original.payload, action: { kind: 'reload' } },
    }))).resolves.toMatchObject({ status: 'rejected', code: 'command_conflict' });
    expect(journal.read().filter((event) => event.payload.commandId === original.id)).toHaveLength(3);
  });

  it('returns unknown consistently when approved action terminal persistence fails', async () => {
    const deps = agentSurfaceHarness();
    deps.risk.submit = true;
    const base = createMemoryJournal();
    let actionTerminalCount = 0;
    const journal = {
      ...base,
      append: vi.fn(async (kind: string, payload: Record<string, unknown>) => {
        if (kind !== 'command.requested' && payload.commandId === 'cmd-click') {
          actionTerminalCount += 1;
          if (actionTerminalCount === 2) throw new Error('disk unavailable');
        }
        return base.append(kind, payload);
      }),
    };
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    await runtime.submit(browserAction(deps.lease.id));
    const approval = deps.approvals.snapshot()[0]!;
    const resolution = runtime.submit(command({
      id: 'approve-persist-fail', idempotencyKey: 'idem-approve-persist-fail', kind: 'approval.resolve',
      actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
    }));
    await expect(Promise.race([
      resolution,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 250)),
    ])).resolves.toMatchObject({ status: 'unknown', code: 'effect_unknown' });
    expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'unknown', code: 'effect_unknown' });
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(1);
  });

  it('cleans completed legacy pane queues and barrier generations', async () => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    for (let index = 0; index < 150; index += 1) {
      await runtime.submit(command({
        id: `takeover-clean-${index}`, idempotencyKey: `idem-takeover-clean-${index}`,
        kind: 'pane.takeover', ownerEpoch: 7, payload: { paneId: `%${index}` },
      }));
    }
    const internal = runtime as unknown as {
      resourceQueues: Map<string, unknown>;
      paneBarrierGenerations: Map<string, number>;
    };
    expect(internal.resourceQueues.size).toBe(0);
    expect(internal.paneBarrierGenerations.size).toBe(0);
  });

  it.each([
    { kind: 'pane', id: '', generation: 1 },
    { kind: 'pane', id: 'pane-1', generation: Number.MAX_SAFE_INTEGER + 1 },
    { kind: 'pane', id: 'pane-1', generation: 1, extra: true },
  ])('ignores malformed replay receipt target %j', async (resource) => {
    const journal = createMemoryJournal();
    await journal.append('command.requested', {
      commandId: 'crafted', idempotencyKey: 'crafted-key', intentDigest: 'digest', kind: 'pane.action',
    });
    await journal.append('command.succeeded', {
      commandId: 'crafted', idempotencyKey: 'crafted-key', status: 'succeeded',
      receipt: {
        schema: 'psyche.control.receipt/v1', actionId: 'crafted', state: 'succeeded',
        resource, createdAt: now().toISOString(), completedAt: now().toISOString(),
      },
    });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal });
    expect(runtime.actionStatus('crafted')).toBeUndefined();
  });

  it('rejects symlink escapes for pane create, browser upload, and browser download before approval or effect', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'psyche-containment-'));
    const projectRoot = path.join(sandbox, 'project');
    const outsideRoot = path.join(sandbox, 'outside');
    try {
      await mkdir(path.join(projectRoot, 'inside'), { recursive: true });
      await mkdir(outsideRoot, { recursive: true });
      await writeFile(path.join(projectRoot, 'inside', 'upload.bin'), 'inside');
      await writeFile(path.join(outsideRoot, 'outside.bin'), 'outside');
      await symlink(outsideRoot, path.join(projectRoot, 'escape'));

      const deps = agentSurfaceHarness();
      let approvalIndex = 0;
      deps.approvals = new ApprovalStore(now, () => `approval-inside-${approvalIndex += 1}`);
      deps.surfaces.upsertBrowserTab({
        id: 'tab-1', providerId: 'desktop-1', webviewLabel: 'browser-a',
        projectRoot, worktreeRoot: projectRoot, url: 'https://example.test',
        title: 'Example', loading: false, viewport: { width: 800, height: 600 },
      });
      const projectLease = deps.capabilityLeases.grant({
        requestId: 'project-request', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1',
        ttlMs: 60_000,
        grants: [{ target: { kind: 'project', id: projectRoot }, capabilities: ['pane.create'] }],
      });
      const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });

      await expect(runtime.submit(command({
        id: 'pane-escape', idempotencyKey: 'idem-pane-escape', kind: 'pane.action',
        projectRoot, actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
        payload: {
          taskId: 'task-1', leaseId: projectLease.id, leaseRevision: 1, projectId: projectRoot,
          action: { kind: 'create', cwd: path.join(projectRoot, 'escape', 'new-pane') },
        },
      }))).resolves.toMatchObject({ status: 'failed', code: 'capability_denied' });

      for (const [id, action] of [
        ['upload-escape', { kind: 'upload', elementRef: 'e17', path: path.join(projectRoot, 'escape', 'outside.bin') }],
        ['download-escape', { kind: 'download', elementRef: 'e17', destination: path.join(projectRoot, 'escape', 'new.bin') }],
      ] as const) {
        await expect(runtime.submit(browserAction(deps.lease.id, {
          id, idempotencyKey: `idem-${id}`, projectRoot,
          payload: { ...browserAction(deps.lease.id).payload, action },
        }))).resolves.toMatchObject({ status: 'failed', code: 'capability_denied' });
      }
      expect(deps.approvals.snapshot()).toEqual([]);
      expect(handlers.actOnPane).not.toHaveBeenCalled();
      expect(handlers.actOnBrowser).not.toHaveBeenCalled();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('accepts in-root pane create, upload, and download targets through containment checks', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'psyche-containment-ok-'));
    const projectRoot = path.join(sandbox, 'project');
    try {
      await mkdir(path.join(projectRoot, 'inside'), { recursive: true });
      await writeFile(path.join(projectRoot, 'inside', 'upload.bin'), 'inside');
      const deps = agentSurfaceHarness();
      let approvalIndex = 0;
      deps.approvals = new ApprovalStore(now, () => `approval-inside-${approvalIndex += 1}`);
      deps.surfaces.upsertBrowserTab({
        id: 'tab-1', providerId: 'desktop-1', webviewLabel: 'browser-a',
        projectRoot, worktreeRoot: projectRoot, url: 'https://example.test',
        title: 'Example', loading: false, viewport: { width: 800, height: 600 },
      });
      const projectLease = deps.capabilityLeases.grant({
        requestId: 'project-ok', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1', ttlMs: 60_000,
        grants: [{ target: { kind: 'project', id: projectRoot }, capabilities: ['pane.create'] }],
      });
      const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
      await expect(runtime.submit(command({
        id: 'pane-inside', idempotencyKey: 'idem-pane-inside', kind: 'pane.action', projectRoot,
        actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
        payload: {
          taskId: 'task-1', leaseId: projectLease.id, leaseRevision: 1, projectId: projectRoot,
          action: { kind: 'create', cwd: path.join(projectRoot, 'inside', 'prospective', 'pane') },
        },
      }))).resolves.toMatchObject({ status: 'succeeded' });
      for (const [id, action] of [
        ['upload-inside', { kind: 'upload', elementRef: 'e17', path: path.join(projectRoot, 'inside', 'upload.bin') }],
        ['download-inside', { kind: 'download', elementRef: 'e17', destination: path.join(projectRoot, 'prospective', 'downloads', 'new.bin') }],
      ] as const) {
        await expect(runtime.submit(browserAction(deps.lease.id, {
          id, idempotencyKey: `idem-${id}`, projectRoot,
          payload: { ...browserAction(deps.lease.id).payload, action },
        }))).resolves.toMatchObject({
          status: 'succeeded', value: { state: 'approval_required', actionId: id },
        });
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('fails closed on dangling symlink ancestors for pane, download, and registered worktree targets', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'psyche-containment-dangling-'));
    const projectRoot = path.join(sandbox, 'project');
    const dangling = path.join(projectRoot, 'dangling');
    try {
      await mkdir(projectRoot, { recursive: true });
      await symlink(path.join(sandbox, 'missing-target'), dangling);
      const deps = agentSurfaceHarness();
      let approvalIndex = 0;
      deps.approvals = new ApprovalStore(now, () => `approval-dangling-${approvalIndex += 1}`);
      deps.surfaces.upsertBrowserTab({
        id: 'tab-1', providerId: 'desktop-1', webviewLabel: 'browser-a',
        projectRoot, worktreeRoot: projectRoot, url: 'https://example.test',
        title: 'Example', loading: false, viewport: { width: 800, height: 600 },
      });
      const projectLease = deps.capabilityLeases.grant({
        requestId: 'project-dangling', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1',
        ttlMs: 60_000,
        grants: [{ target: { kind: 'project', id: projectRoot }, capabilities: ['pane.create'] }],
      });
      const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });

      await expect(runtime.submit(command({
        id: 'pane-dangling', idempotencyKey: 'idem-pane-dangling', kind: 'pane.action', projectRoot,
        actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
        payload: {
          taskId: 'task-1', leaseId: projectLease.id, leaseRevision: 1, projectId: projectRoot,
          action: { kind: 'create', cwd: path.join(dangling, 'pane') },
        },
      }))).resolves.toMatchObject({ status: 'failed', code: 'filesystem_target_unavailable' });

      await expect(runtime.submit(browserAction(deps.lease.id, {
        id: 'download-dangling', idempotencyKey: 'idem-download-dangling', projectRoot,
        payload: {
          ...browserAction(deps.lease.id).payload,
          action: { kind: 'download', elementRef: 'e17', destination: path.join(dangling, 'download.bin') },
        },
      }))).resolves.toMatchObject({ status: 'failed', code: 'filesystem_target_unavailable' });

      deps.surfaces.upsertBrowserTab({
        id: 'tab-1', providerId: 'desktop-1', webviewLabel: 'browser-a',
        projectRoot, worktreeRoot: dangling, url: 'https://example.test',
        title: 'Example', loading: false, viewport: { width: 800, height: 600 },
      });
      await expect(runtime.submit(browserAction(deps.lease.id, {
        id: 'worktree-dangling', idempotencyKey: 'idem-worktree-dangling', projectRoot,
        payload: {
          ...browserAction(deps.lease.id).payload,
          action: { kind: 'download', elementRef: 'e17', destination: path.join(dangling, 'download.bin') },
        },
      }))).resolves.toMatchObject({ status: 'failed', code: 'filesystem_target_unavailable' });
      expect(deps.approvals.snapshot()).toEqual([]);
      expect(handlers.actOnPane).not.toHaveBeenCalled();
      expect(handlers.actOnBrowser).not.toHaveBeenCalled();
      expect(runtime.events().map((event) => JSON.stringify(event))).not.toEqual(
        expect.arrayContaining([expect.stringContaining(dangling)]),
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it.each([
    { kind: 'click', elementRef: 'e1' },
    { kind: 'type', elementRef: 'e1', text: 'value' },
    { kind: 'select', elementRef: 'e1', values: ['one'] },
    { kind: 'scroll', elementRef: 'e1', deltaY: 1 },
    { kind: 'focus', elementRef: 'e1' },
    { kind: 'submit', elementRef: 'e1' },
    { kind: 'upload', elementRef: 'e1', path: 'upload.bin' },
    { kind: 'download', elementRef: 'e1', destination: 'download.bin' },
  ] as const)('fails closed without a canonical $kind element binding', async (action) => {
    const deps = agentSurfaceHarness();
    deps.resolveBrowserSnapshot.mockResolvedValueOnce(undefined);
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    await expect(runtime.submit(browserAction(deps.lease.id, {
      payload: { ...browserAction(deps.lease.id).payload, action },
    }))).resolves.toMatchObject({ status: 'failed', code: 'snapshot_stale' });
    expect(handlers.actOnBrowser).not.toHaveBeenCalled();
  });

  it.each(['tabId', 'generation', 'snapshotId', 'elementRef', 'actionKind'] as const)(
    'rejects a canonical binding with mismatched %s',
    async (field) => {
      const deps = agentSurfaceHarness();
      deps.resolveBrowserSnapshot.mockResolvedValueOnce({
        tabId: 'tab-1', generation: 1, snapshotId: 'snapshot-1', elementRef: 'e17', actionKind: 'click', submit: false,
        [field]: field === 'generation' ? 2 : field === 'actionKind' ? 'type' : 'mismatch',
      });
      const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
      await expect(runtime.submit(browserAction(deps.lease.id))).resolves.toMatchObject({
        status: 'failed', code: 'snapshot_stale',
      });
      expect(handlers.actOnBrowser).not.toHaveBeenCalled();
    },
  );

  it('transitions an approved action through queued, running, and one terminal receipt', async () => {
    const deps = agentSurfaceHarness();
    deps.risk.submit = true;
    let releaseEffect!: () => void;
    handlers.actOnBrowser = vi.fn(() => new Promise<void>((resolve) => { releaseEffect = resolve; }));
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    await runtime.submit(browserAction(deps.lease.id));
    const approval = deps.approvals.snapshot()[0]!;
    const releaseQueue = runtime.blockResourceQueue('browser_tab:tab-1:1');
    const resolving = runtime.submit(command({
      id: 'cmd-resume', idempotencyKey: 'idem-resume', kind: 'approval.resolve',
      actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
    }));
    await vi.waitFor(() => expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'queued' }));
    expect(runtime.snapshot().receipts?.find(({ actionId }) => actionId === 'cmd-click'))
      .toMatchObject({ state: 'queued' });
    releaseQueue();
    await vi.waitFor(() => expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'running' }));
    expect(runtime.snapshot().receipts?.find(({ actionId }) => actionId === 'cmd-click'))
      .toMatchObject({ state: 'running' });
    releaseEffect();
    await resolving;
    expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'succeeded' });
    expect(runtime.snapshot().receipts?.filter(({ actionId }) => actionId === 'cmd-click')).toHaveLength(1);
  });

  it('fails approval resumption when trusted canonical risk changes', async () => {
    const deps = agentSurfaceHarness();
    deps.risk.submit = true;
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps,
    });
    await runtime.submit(browserAction(deps.lease.id));
    const approval = deps.approvals.snapshot()[0]!;
    deps.risk.submit = false;
    await expect(runtime.submit(command({
      id: 'cmd-risk-change', idempotencyKey: 'idem-risk-change', kind: 'approval.resolve',
      actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
    }))).resolves.toMatchObject({ status: 'failed', code: 'approval_identity_mismatch' });
    expect(handlers.actOnBrowser).not.toHaveBeenCalled();
  });

  it('revokes exact surface leases and approvals on human takeover', async () => {
    const surfaces = new SurfaceRegistry();
    surfaces.upsertPane({
      id: 'pane-1', tmuxPaneId: '%3', projectRoot: '/repo', worktreeRoot: '/repo',
      writable: true, outputSequence: 0,
    });
    const capabilityLeases = new CapabilityLeaseStore(now, 7);
    const approvals = new ApprovalStore(now, () => 'approval-pane');
    const lease = capabilityLeases.grant({
      requestId: 'request-pane', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1',
      ttlMs: 60_000,
      grants: [{ target: { kind: 'pane', id: 'pane-1', generation: 1 }, capabilities: ['pane.close'] }],
    });
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(),
      surfaces, capabilityLeases, approvals,
    });
    await runtime.submit(command({
      id: 'cmd-close', idempotencyKey: 'idem-close', kind: 'pane.action',
      actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
      payload: {
        taskId: 'task-1', leaseId: lease.id, leaseRevision: 1,
        paneId: 'pane-1', generation: 1, action: { kind: 'close' },
      },
    }));
    await runtime.submit(command({
      id: 'cmd-human-takeover', idempotencyKey: 'idem-human-takeover',
      kind: 'pane.takeover', ownerEpoch: 7, payload: { paneId: '%3' },
    }));
    expect(capabilityLeases.snapshot()).toEqual([]);
    expect(approvals.snapshot()).toEqual([expect.objectContaining({ status: 'revoked' })]);
  });

  it('revokes old generation authority when a provider replaces a resource binding', async () => {
    const deps = agentSurfaceHarness();
    deps.risk.submit = true;
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps,
    });
    await runtime.submit(browserAction(deps.lease.id));
    await runtime.submit(command({
      id: 'cmd-upsert', idempotencyKey: 'idem-upsert', kind: 'provider.resource.upsert',
      actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: { resource: {
        ...deps.surfaces.get('tab-1'), kind: 'browser_tab',
        id: 'tab-1', generation: 1, providerId: 'desktop-1', webviewLabel: 'browser-b',
        projectRoot: '/repo', worktreeRoot: '/repo', url: 'https://example.test',
        title: 'Example', loading: false, viewport: { width: 800, height: 600 },
      } },
    }));
    expect(deps.capabilityLeases.snapshot()).toEqual([]);
    expect(deps.approvals.snapshot()).toEqual([expect.objectContaining({ status: 'revoked' })]);
  });

  it('records agent lease requests, grants only exact operator authority, and lets the owner release it', async () => {
    const deps = agentSurfaceHarness();
    deps.capabilityLeases.release(deps.lease.id);
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps,
    });
    const grants = [{
      target: { kind: 'browser_tab' as const, id: 'tab-1', generation: 1 },
      capabilities: ['browser.inspect' as const],
    }];
    await expect(runtime.submit(command({
      id: 'request-inspect', idempotencyKey: 'idem-request-inspect', kind: 'lease.request',
      actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
      payload: { taskId: 'task-1', ttlMs: 60_000, grants },
    }))).resolves.toMatchObject({ status: 'succeeded', value: { requestId: 'request-inspect' } });
    const granted = await runtime.submit(command({
      id: 'grant-inspect', idempotencyKey: 'idem-grant-inspect', kind: 'lease.grant',
      actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: {
        requestId: 'request-inspect', actorId: 'agent-1', taskId: 'task-1', ttlMs: 60_000, grants,
      },
    }));
    expect(granted).toMatchObject({ status: 'succeeded', value: { leaseRevision: 1 } });
    const lease = deps.capabilityLeases.snapshot()[0]!;
    await expect(runtime.submit(command({
      id: 'release-inspect', idempotencyKey: 'idem-release-inspect', kind: 'lease.release',
      actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
      payload: { taskId: 'task-1', leaseId: lease.id, leaseRevision: 1 },
    }))).resolves.toMatchObject({ status: 'succeeded' });
    expect(deps.capabilityLeases.snapshot()).toEqual([]);
  });

  it('revokes provider authority and pending approvals when the resource is removed', async () => {
    const deps = agentSurfaceHarness();
    deps.risk.submit = true;
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps,
    });
    await runtime.submit(browserAction(deps.lease.id));
    await runtime.submit(command({
      id: 'remove-tab', idempotencyKey: 'idem-remove-tab', kind: 'provider.resource.remove',
      actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: { id: 'tab-1', generation: 1 },
    }));
    expect(deps.surfaces.get('tab-1')).toBeUndefined();
    expect(deps.capabilityLeases.snapshot()).toEqual([]);
    expect(deps.approvals.snapshot()).toEqual([expect.objectContaining({ status: 'revoked' })]);
  });

  it('recovers the canonical resumed action status and never redispatches after restart', async () => {
    const deps = agentSurfaceHarness();
    deps.risk.submit = true;
    const journal = createMemoryJournal();
    const first = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    const action = browserAction(deps.lease.id);
    await first.submit(action);
    const approval = deps.approvals.snapshot()[0]!;
    await first.submit(command({
      id: 'approve-before-restart', idempotencyKey: 'idem-approve-before-restart',
      kind: 'approval.resolve', actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
    }));
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(1);
    const second = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    await expect(second.submit(action)).resolves.toMatchObject({
      status: 'succeeded', value: { actionId: 'cmd-click', state: 'succeeded' },
    });
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(1);
  });

  it('revokes stale leases and approvals when a new owner epoch starts', async () => {
    const surfaces = new SurfaceRegistry();
    surfaces.upsertBrowserTab({
      id: 'tab-1', providerId: 'desktop-1', webviewLabel: 'browser-a',
      projectRoot: '/repo', worktreeRoot: '/repo', url: 'https://example.test',
      title: 'Example', loading: false, viewport: { width: 800, height: 600 },
    });
    const capabilityLeases = new CapabilityLeaseStore(now, 6);
    const lease = capabilityLeases.grant({
      requestId: 'request-old', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1',
      ttlMs: 60_000,
      grants: [{
        target: { kind: 'browser_tab', id: 'tab-1', generation: 1 },
        capabilities: ['browser.interact'],
      }],
    });
    const approvals = new ApprovalStore(now, () => 'approval-old');
    approvals.request({
      actionId: 'action-old', ownerEpoch: 6, leaseId: lease.id, leaseRevision: 1,
      resource: { kind: 'browser_tab', id: 'tab-1', generation: 1 },
      capability: 'browser.interact', effect: { kind: 'submit', target: 'browser element' },
      actionPayload: { snapshotId: 'snapshot-old', action: { kind: 'submit', elementRef: 'e1' } },
    });
    await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(),
      surfaces, capabilityLeases, approvals,
    });
    expect(capabilityLeases.snapshot()).toEqual([]);
    expect(approvals.snapshot()).toEqual([expect.objectContaining({ status: 'revoked' })]);
  });

  it('reconciles an orphaned approval-required action to unknown on restart without replaying effect', async () => {
    const deps = agentSurfaceHarness();
    deps.risk.submit = true;
    const journal = createMemoryJournal();
    const first = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    await first.submit(browserAction(deps.lease.id));
    expect(first.actionStatus('cmd-click')).toMatchObject({ state: 'approval_required' });

    const second = await ControlRuntime.create({
      ownerEpoch: 8, handlers, journal,
      surfaces: deps.surfaces,
      capabilityLeases: deps.capabilityLeases,
      approvals: new ApprovalStore(now),
      resolveBrowserSnapshot: deps.resolveBrowserSnapshot,
    });
    expect(second.actionStatus('cmd-click')).toMatchObject({ state: 'unknown', code: 'owner_restarted' });
    expect(second.approvals.snapshot()).toEqual([]);
    expect(handlers.actOnBrowser).not.toHaveBeenCalled();
    expect(second.events().filter((event) => (
      event.payload.commandId === 'cmd-click' && event.kind === 'command.unknown'
    ))).toHaveLength(1);
  });

  it.each([
    ['extra enumerable key', { kind: 'pane', id: 'pane-1', generation: 1, path: '/secret' }],
    ['project generation', { kind: 'project', id: '/repo', generation: 1 }],
    ['inherited key', Object.assign(Object.create({ path: '/secret' }), { kind: 'pane', id: 'pane-1', generation: 1 })],
  ])('rejects non-exact runtime lease target: %s', async (_label, target) => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    await expect(runtime.submit(command({
      id: 'bad-exact-target', idempotencyKey: 'idem-bad-exact-target', kind: 'lease.request',
      actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
      payload: { taskId: 'task-1', ttlMs: 1000, grants: [{ target, capabilities: ['pane.observe'] }] },
    }))).resolves.toMatchObject({ status: 'failed', code: 'capability_denied' });
    expect(runtime.snapshot().leaseRequests).toEqual([]);
  });

  it('rejects symbol, nonenumerable, and accessor target properties without invoking accessors', async () => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    const getter = vi.fn(() => 'pane');
    const candidates: object[] = [
      Object.assign({ kind: 'pane', id: 'pane-1', generation: 1 }, { [Symbol('extra')]: true }),
      Object.defineProperty({ kind: 'pane', id: 'pane-1', generation: 1 }, 'path', { value: '/secret' }),
      Object.defineProperty({ id: 'pane-1', generation: 1 }, 'kind', { enumerable: true, get: getter }),
    ];
    for (const [index, target] of candidates.entries()) {
      await runtime.submit(command({
        id: `bad-descriptor-${index}`, idempotencyKey: `idem-bad-descriptor-${index}`, kind: 'lease.request',
        actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
        payload: { taskId: 'task-1', ttlMs: 1000, grants: [{ target, capabilities: ['pane.observe'] }] },
      }));
    }
    expect(getter).not.toHaveBeenCalled();
    expect(runtime.snapshot().leaseRequests).toEqual([]);
  });

  it.each(['lease.grant', 'lease.revoke', 'approval.resolve'] as const)(
    'rejects agent %s authority changes in runtime defense-in-depth',
    async (kind) => {
      const deps = agentSurfaceHarness();
      const runtime = await ControlRuntime.create({
        ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps,
      });
      const payload = kind === 'lease.grant'
        ? { requestId: 'r', actorId: 'agent-1', taskId: 'task-1', ttlMs: 1, grants: [] }
        : kind === 'lease.revoke'
          ? { leaseId: deps.lease.id }
          : { approvalId: 'a', payloadDigest: '0'.repeat(64), decision: 'approve' };
      await expect(runtime.submit(command({
        id: `cmd-${kind}`, idempotencyKey: `idem-${kind}`, kind,
        actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7, payload,
      }))).resolves.toMatchObject({ status: 'rejected', code: 'agent_mutation_denied' });
    },
  );

  it.each([
    'orchestration.execute', 'pane.spawn', 'pane.prompt', 'pane.interrupt', 'pane.delegate', 'pane.takeover',
    'pane.input', 'pane.terminal.open', 'pane.resize', 'pane.focus', 'pane.kill', 'pane.respawn',
    'pane.conflict.open', 'pane.option.update', 'pane.meta.update', 'ritual.launch',
    'coven.session.launch', 'coven.session.open', 'coven.desktop.action', 'coven.capability.execute',
    'lease.grant', 'lease.revoke', 'approval.resolve', 'provider.resource.upsert', 'provider.resource.remove',
  ] as const)('rejects psyche legacy/operator mutation %s before every handler', async (kind) => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    await expect(runtime.submit(command({
      id: `deny-${kind}`, idempotencyKey: `deny-idem-${kind}`, kind,
      actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
    }) as never)).resolves.toMatchObject({ status: 'rejected', code: 'agent_mutation_denied' });
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it('keeps nested resource blockers active until every captured token releases', async () => {
    const deps = agentSurfaceHarness();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    const first = runtime.blockResourceQueue('browser_tab:tab-1:1');
    const second = runtime.blockResourceQueue('browser_tab:tab-1:1');
    const pending = runtime.submit(browserAction(deps.lease.id));
    first();
    await Promise.resolve();
    expect(handlers.actOnBrowser).not.toHaveBeenCalled();
    second();
    await pending;
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(1);
  });

  it('requires lease grants to match a live request including ttl', async () => {
    const deps = agentSurfaceHarness();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    await expect(runtime.submit(command({
      id: 'arbitrary-grant', idempotencyKey: 'idem-arbitrary-grant', kind: 'lease.grant',
      actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: { requestId: 'missing', actorId: 'agent-1', taskId: 'task-1', ttlMs: 1000, grants: [] },
    }))).resolves.toMatchObject({ status: 'failed', code: 'capability_denied' });
    await runtime.submit(command({
      id: 'request-ttl', idempotencyKey: 'idem-request-ttl', kind: 'lease.request',
      actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
      payload: { taskId: 'task-1', ttlMs: 1000, grants: [] },
    }));
    await expect(runtime.submit(command({
      id: 'extend-grant', idempotencyKey: 'idem-extend-grant', kind: 'lease.grant',
      actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: { requestId: 'request-ttl', actorId: 'agent-1', taskId: 'task-1', ttlMs: 2000, grants: [] },
    }))).resolves.toMatchObject({ status: 'failed', code: 'capability_denied' });
  });

  it('rejects pane creation outside the canonical project', async () => {
    const capabilityLeases = new CapabilityLeaseStore(now, 7);
    const lease = capabilityLeases.grant({
      requestId: 'create-request', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1', ttlMs: 1000,
      grants: [{ target: { kind: 'project', id: '/repo' }, capabilities: ['pane.create'] }],
    });
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), capabilityLeases,
    });
    await expect(runtime.submit(command({
      id: 'escape-create', idempotencyKey: 'idem-escape-create', kind: 'pane.action',
      actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7, projectRoot: '/repo',
      payload: { taskId: 'task-1', leaseId: lease.id, leaseRevision: 1, projectId: '/repo', action: { kind: 'create', cwd: '/../escape' } },
    }))).resolves.toMatchObject({ status: 'failed', code: 'capability_denied' });
    expect(handlers.actOnPane).not.toHaveBeenCalled();
  });

  it('rejects cross-project provider resources before registry mutation', async () => {
    const surfaces = new SurfaceRegistry();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), surfaces });
    await expect(runtime.submit(command({
      id: 'cross-project', idempotencyKey: 'idem-cross-project', kind: 'provider.resource.upsert',
      actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7, projectRoot: '/repo',
      payload: { resource: {
        id: 'tab-x', kind: 'browser_tab', generation: 1, providerId: 'desktop', webviewLabel: 'web',
        projectRoot: '/other', worktreeRoot: '/other', url: '', title: '', loading: false,
        viewport: { width: 800, height: 600 },
      } },
    }))).resolves.toMatchObject({ status: 'failed', code: 'capability_denied' });
    expect(surfaces.list()).toEqual([]);
  });

  it('rejects conflicting command id and idempotency-key reuse without a second effect', async () => {
    const deps = agentSurfaceHarness();
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps,
    });
    const first = browserAction(deps.lease.id);
    await runtime.submit(first);
    await expect(runtime.submit(browserAction(deps.lease.id))).resolves.toMatchObject({ status: 'succeeded' });
    await expect(runtime.submit(browserAction(deps.lease.id, {
      payload: { ...first.payload, action: { kind: 'scroll', elementRef: 'e17', deltaY: 20 } },
    }))).resolves.toMatchObject({ status: 'rejected', code: 'command_conflict' });
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(1);
  });

  it('rejects the same command id with a different idempotency key even when intent is identical', async () => {
    const deps = agentSurfaceHarness();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    const first = browserAction(deps.lease.id);
    await runtime.submit(first);
    await expect(runtime.submit({ ...first, idempotencyKey: 'idem-different' })).resolves.toMatchObject({
      status: 'rejected', code: 'command_conflict',
    });
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(1);
  });

  it('rejects the same idempotency key with a different command id even when intent is identical', async () => {
    const deps = agentSurfaceHarness();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    const first = browserAction(deps.lease.id);
    await runtime.submit(first);
    await expect(runtime.submit({ ...first, id: 'cmd-different' })).resolves.toMatchObject({
      status: 'rejected', code: 'command_conflict',
    });
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(1);
  });

  it('reports queued and running action status from the canonical status index', async () => {
    const deps = agentSurfaceHarness();
    let releaseEffect!: () => void;
    handlers.actOnBrowser = vi.fn(() => new Promise<void>((resolve) => { releaseEffect = resolve; }));
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    const releaseQueue = runtime.blockResourceQueue('browser_tab:tab-1:1');
    const pending = runtime.submit(browserAction(deps.lease.id));
    await vi.waitFor(() => expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'queued' }));
    releaseQueue();
    await vi.waitFor(() => expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'running' }));
    releaseEffect();
    await pending;
  });

  it('keeps approval-required and terminal statuses after the recent receipt display window rolls over', async () => {
    const deps = agentSurfaceHarness();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    await runtime.submit(browserAction(deps.lease.id, {
      id: 'cmd-terminal-old', idempotencyKey: 'idem-terminal-old',
    }));
    deps.risk.submit = true;
    await runtime.submit(browserAction(deps.lease.id));
    expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'approval_required' });

    deps.risk.submit = false;
    for (let index = 0; index < 101; index += 1) {
      await runtime.submit(browserAction(deps.lease.id, {
        id: `cmd-new-${index}`, idempotencyKey: `idem-new-${index}`,
        payload: {
          ...browserAction(deps.lease.id).payload,
          action: { kind: 'scroll', elementRef: `element-${index}`, deltaY: 1 },
        },
      }));
    }
    expect(runtime.snapshot().receipts).toHaveLength(100);
    expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'approval_required' });
    expect(runtime.actionStatus('cmd-terminal-old')).toMatchObject({ state: 'succeeded' });
  });

  it.each([
    ['generation', { generation: 99 }, 'resource_replaced'],
    ['lease revision', { leaseRevision: 99 }, 'lease_revision_mismatch'],
  ])('creates exactly one redacted receipt and terminal event for %s revalidation failure', async (_label, payloadOverride, code) => {
    const deps = agentSurfaceHarness();
    const journal = createMemoryJournal();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    await runtime.submit(browserAction(deps.lease.id, {
      payload: { ...browserAction(deps.lease.id).payload, ...payloadOverride },
    }));
    expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'failed', code });
    expect(runtime.snapshot().receipts?.filter(({ actionId }) => actionId === 'cmd-click')).toHaveLength(1);
    expect(runtime.events().filter((event) => (
      event.payload.commandId === 'cmd-click' && event.kind.startsWith('command.') && event.kind !== 'command.requested'
    ))).toHaveLength(1);
    expect(JSON.stringify(runtime.events())).not.toContain('Refresh');
  });

  it('creates one redacted receipt for snapshot-policy and owner failures', async () => {
    const deps = agentSurfaceHarness();
    deps.resolveBrowserSnapshot.mockRejectedValueOnce(Object.assign(new Error('secret page text'), { code: 'snapshot_stale' }));
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    await runtime.submit(browserAction(deps.lease.id));
    await runtime.submit(browserAction(deps.lease.id, {
      id: 'cmd-owner', idempotencyKey: 'idem-owner', ownerEpoch: 6,
    }));
    expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'failed', code: 'snapshot_stale' });
    expect(runtime.actionStatus('cmd-owner')).toMatchObject({ state: 'denied', code: 'owner_restarted' });
    expect(JSON.stringify(runtime.events())).not.toContain('secret page text');
  });

  it('rejects malformed lease target kinds before retaining a request', async () => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    await expect(runtime.submit(command({
      id: 'bad-target', idempotencyKey: 'idem-bad-target', kind: 'lease.request',
      actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
      payload: {
        taskId: 'task-1', ttlMs: 1000,
        grants: [{ target: { kind: 'future', id: 'x', generation: 1 }, capabilities: ['browser.inspect'] }],
      },
    }))).resolves.toMatchObject({ status: 'failed', code: 'capability_denied' });
    expect(runtime.snapshot().leaseRequests).toEqual([]);
  });

  it('maps ambiguous surface dispatch to effect_unknown and never retries it', async () => {
    const deps = agentSurfaceHarness();
    handlers.actOnBrowser = vi.fn(async () => {
      throw Object.assign(new Error('transport included sensitive backend detail'), { ambiguous: true });
    });
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps,
    });
    const action = browserAction(deps.lease.id);
    await expect(runtime.submit(action)).resolves.toEqual({
      status: 'unknown', code: 'effect_unknown', message: 'surface effect outcome is unknown',
    });
    await runtime.submit(action);
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(1);
  });

  it('settles unknown without hanging when terminal persistence fails after effect', async () => {
    const deps = agentSurfaceHarness();
    const journal = createMemoryJournal();
    const append = journal.append;
    journal.append = vi.fn(async (kind, payload) => {
      if (kind.startsWith('command.') && kind !== 'command.requested') throw new Error('disk full');
      return append(kind, payload);
    });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    await expect(Promise.race([
      runtime.submit(browserAction(deps.lease.id)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500)),
    ])).resolves.toMatchObject({ status: 'unknown', code: 'effect_unknown' });
    expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'unknown', code: 'effect_unknown' });
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(1);
  });

  it('publishes only redacted agent-control state', async () => {
    const deps = agentSurfaceHarness();
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps,
    });
    await runtime.submit(browserAction(deps.lease.id));
    const serialized = JSON.stringify(runtime.snapshot());
    expect(runtime.snapshot()).toMatchObject({
      resources: [{ id: 'tab-1', kind: 'browser_tab', generation: 1 }],
      capabilityLeases: [expect.objectContaining({ id: deps.lease.id })],
      leaseRequests: [], approvals: [],
      receipts: [expect.objectContaining({ actionId: 'cmd-click', state: 'succeeded' })],
    });
    for (const secret of ['https://example.test', 'Refresh', 'snapshot-1', '"elementRef":"e17"', '/repo']) {
      expect(serialized).not.toContain(secret);
    }
    const journal = JSON.stringify(runtime.events());
    for (const secret of ['https://example.test', 'Refresh', 'snapshot-1', '"elementRef":"e17"', '/repo']) {
      expect(journal).not.toContain(secret);
    }
  });
});

describe('createHostControlPlane agent-control dependencies', () => {
  it('passes one shared registry, lease store, approval store, and canonical resolver to runtime', async () => {
    const surfaces = new SurfaceRegistry();
    const capabilityLeases = new CapabilityLeaseStore(now, 7);
    const approvals = new ApprovalStore(now);
    const resolveBrowserSnapshot = vi.fn();
    const journal = createMemoryJournal();
    const host = await createHostControlPlane(process.cwd(), {
      handlers,
      ownerLock: vi.fn(async () => ({
        epoch: 7, nonce: 'owner-test', release: vi.fn(async () => undefined),
      })),
      journalOpen: vi.fn(async () => journal),
      bootstrap: vi.fn(async () => undefined),
      surfaces,
      capabilityLeases,
      approvals,
      resolveBrowserSnapshot,
    });
    expect(host.runtime.surfaces).toBe(surfaces);
    expect(host.runtime.capabilityLeases).toBe(capabilityLeases);
    expect(host.runtime.approvals).toBe(approvals);
    await host.close();
  });
});
