import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlRuntime, type CanonicalBrowserSnapshotResolver, type ControlHandlers } from '../src/control/runtime.js';
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
      capabilities: ['browser.interact', 'browser.screenshot', 'browser.navigate', 'browser.history', 'browser.close'],
    }],
  });
  const risk = { submit: false, formId: null as string | null };
  const resolveBrowserSnapshot = vi.fn<CanonicalBrowserSnapshotResolver>(async (payload) => {
    if (!payload.snapshotId || !payload.action.elementRef) return undefined;
    return {
      tabId: payload.tabId, generation: payload.generation, snapshotId: payload.snapshotId,
      elementRef: payload.action.elementRef, actionKind: payload.action.kind as never, documentId: 'document-1',
      submit: risk.submit, formId: risk.submit ? (risk.formId ?? 'form-1') : null, secret: null,
    };
  });
  const scriptContext = { documentId: 'document-1', documentToken: 'token-1', navigationEpoch: 1,
    navigationUrl: 'https://example.test' };
  const resolveBrowserScriptContext = vi.fn(async (payload: any) => ({
    tabId: payload.tabId, generation: payload.generation, ...scriptContext,
  }));
  return { surfaces, capabilityLeases, approvals, lease, risk, resolveBrowserSnapshot,
    scriptContext, resolveBrowserScriptContext };
}

function browserScript(leaseId: string, overrides: Record<string, unknown> = {}) {
  return command({
    id: 'cmd-script', idempotencyKey: 'idem-script', kind: 'browser.script',
    projectRoot: '/repo', actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
    createdAt: '2026-08-12T12:00:00.000Z',
    payload: { taskId: 'task-1', leaseId, leaseRevision: 1,
      tabId: 'tab-1', generation: 1, source: 'return args.answer', args: { answer: 42 } },
    ...overrides,
  }) as unknown as Extract<ControlCommand, { kind: 'browser.script' }>;
}

function paneObservationHarness() {
  const surfaces = new SurfaceRegistry();
  surfaces.upsertPane({
    id: 'pane-1', tmuxPaneId: '%3', projectRoot: '/repo', worktreeRoot: '/repo',
    writable: true, outputSequence: 6,
  });
  const capabilityLeases = new CapabilityLeaseStore(now, 7);
  const approvals = new ApprovalStore(now, () => 'approval-pane');
  const lease = capabilityLeases.grant({
    requestId: 'request-pane-observe', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1',
    ttlMs: 60_000,
    grants: [{
      target: { kind: 'pane', id: 'pane-1', generation: 1 },
      capabilities: ['pane.observe'],
    }],
  });
  return { surfaces, capabilityLeases, approvals, lease };
}

function paneObserveCommand(leaseId: string) {
  return command({
    id: 'cmd-observe', idempotencyKey: 'idem-observe', kind: 'pane.observe',
    projectRoot: '/repo', actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
    createdAt: '2026-08-12T12:00:00.000Z',
    payload: {
      taskId: 'task-1', leaseId, leaseRevision: 1,
      paneId: 'pane-1', generation: 1, afterSequence: 4,
    },
  }) as unknown as Extract<ControlCommand, { kind: 'pane.observe' }>;
}

function paneActionHarness(capability: 'pane.focus' | 'pane.resize') {
  const surfaces = new SurfaceRegistry();
  surfaces.upsertPane({
    id: 'pane-1', tmuxPaneId: '%3', projectRoot: '/repo', worktreeRoot: '/repo',
    writable: true, outputSequence: 0,
  });
  const capabilityLeases = new CapabilityLeaseStore(now, 7);
  const approvals = new ApprovalStore(now, () => 'approval-pane-action');
  const lease = capabilityLeases.grant({
    requestId: `request-${capability}`, actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1',
    ttlMs: 60_000,
    grants: [{ target: { kind: 'pane', id: 'pane-1', generation: 1 }, capabilities: [capability] }],
  });
  return { surfaces, capabilityLeases, approvals, lease };
}

function paneActionCommand(
  leaseId: string,
  action: { kind: 'focus' } | { kind: 'resize'; cols: number; rows: number },
) {
  return command({
    id: `cmd-${action.kind}`, idempotencyKey: `idem-${action.kind}`, kind: 'pane.action',
    projectRoot: '/repo', actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
    createdAt: '2026-08-12T12:00:00.000Z',
    payload: {
      taskId: 'task-1', leaseId, leaseRevision: 1,
      paneId: 'pane-1', generation: 1, action,
    },
  }) as unknown as Extract<ControlCommand, { kind: 'pane.action' }>;
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
    handlers.actOnBrowser = vi.fn(async (payload) => {
      switch (payload.action.kind) {
        case 'focus': return { focused: true };
        case 'type': return { secret: false, value: payload.action.text };
        case 'select': return { values: payload.action.values };
        case 'scroll': return { scrollLeft: 1, scrollTop: 2 };
        case 'submit': return { submitted: true, submit: true, url: 'https://example.test', title: 'Example' };
        case 'navigate': case 'reload': case 'back': case 'forward':
          return { url: 'https://example.test', title: 'Example' };
        case 'screenshot': return { pngBase64: 'iVBORw==', width: 1, height: 1,
          navigationEpoch: 1, navigationUrl: 'https://example.test' };
        case 'close': return { closed: true };
        default: return { clicked: true, submit: false, url: 'https://example.test', title: 'Example' };
      }
    });
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
    handlers.actOnBrowser = vi.fn(() => new Promise((resolve) => { release = () => resolve({
      clicked: true, submit: false, url: 'https://example.test', title: 'Example',
    }); }));
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

  it('passes immutable command IDs to browser handlers for distinct actions under one task', async () => {
    const deps = agentSurfaceHarness();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers,
      journal: createMemoryJournal(), ...deps });
    await runtime.submit(browserAction(deps.lease.id, { id: 'action-a', idempotencyKey: 'idem-a' }));
    await runtime.submit(browserAction(deps.lease.id, { id: 'action-b', idempotencyKey: 'idem-b' }));
    expect(vi.mocked(handlers.actOnBrowser).mock.calls.map((call) => call[1]))
      .toEqual(['action-a', 'action-b']);
  });

  it('returns pane observation text live while excluding it from journal, snapshot, and status', async () => {
    const deps = paneObservationHarness();
    const marker = 'LIVE_ONLY_MARKER';
    handlers.observePane = vi.fn(async () => ({
      paneId: 'pane-1', fromSequence: 5, nextSequence: 7,
      text: `hello ${marker}`, bytes: 22, truncated: false,
    }));
    const journal = createMemoryJournal();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });

    const outcome = await runtime.submit(paneObserveCommand(deps.lease.id));
    expect(outcome).toEqual({
      status: 'succeeded',
      value: {
        paneId: 'pane-1', fromSequence: 5, nextSequence: 7,
        text: `hello ${marker}`, bytes: 22, truncated: false,
      },
    });
    expect(JSON.stringify(journal.read())).not.toContain(marker);
    expect(JSON.stringify(journal.read())).not.toContain('"text"');
    expect(JSON.stringify(runtime.snapshot())).not.toContain(marker);
    expect(JSON.stringify(runtime.actionStatus('cmd-observe'))).not.toContain(marker);
  });

  it('shares an in-flight live observation but replay after restart exposes receipt only', async () => {
    const deps = paneObservationHarness();
    let release!: (value: unknown) => void;
    handlers.observePane = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const journal = createMemoryJournal();
    const firstRuntime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    const input = paneObserveCommand(deps.lease.id);
    const first = firstRuntime.submit(input);
    await vi.waitFor(() => expect(handlers.observePane).toHaveBeenCalledTimes(1));
    const pendingRetry = firstRuntime.submit(input);
    release({
      paneId: 'pane-1', fromSequence: 5, nextSequence: 7,
      text: 'EPHEMERAL_REPLAY_MARKER', bytes: 23, truncated: false,
    });
    const live = await first;
    await expect(pendingRetry).resolves.toEqual(live);

    handlers.observePane = vi.fn();
    const restarted = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    const replayed = await restarted.submit(input);
    expect(JSON.stringify(replayed)).not.toContain('EPHEMERAL_REPLAY_MARKER');
    expect(replayed).toMatchObject({
      status: 'succeeded', value: { actionId: 'cmd-observe', state: 'succeeded' },
    });
    expect(handlers.observePane).not.toHaveBeenCalled();
  });

  it('does not pass through arbitrary values from other surface handlers', async () => {
    const deps = agentSurfaceHarness();
    handlers.actOnBrowser = vi.fn(async () => ({ text: 'OTHER_HANDLER_SECRET' }));
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps,
    });
    const outcome = await runtime.submit(browserAction(deps.lease.id));
    expect(JSON.stringify(outcome)).not.toContain('OTHER_HANDLER_SECRET');
    expect(outcome).toMatchObject({ status: 'unknown', code: 'effect_unknown' });
  });

  it.each([
    {
      kind: 'focus' as const,
      capability: 'pane.focus' as const,
      handlerValue: {
        paneId: 'pane-1', generation: 1, focused: true, cols: 120, rows: 40,
        secret: 'FOCUS_SECRET',
      },
      expected: { paneId: 'pane-1', generation: 1, focused: true },
    },
    {
      kind: 'resize' as const,
      capability: 'pane.resize' as const,
      handlerValue: {
        paneId: 'pane-1', generation: 1, focused: true, cols: 120, rows: 40,
        secret: 'RESIZE_SECRET',
      },
      expected: { paneId: 'pane-1', generation: 1, cols: 120, rows: 40 },
    },
  ])('persists only allowlisted $kind postconditions in live/status/journal/replay receipts', async (testCase) => {
    const deps = paneActionHarness(testCase.capability);
    handlers.actOnPane = vi.fn(async () => testCase.handlerValue);
    const journal = createMemoryJournal();
    const input = paneActionCommand(
      deps.lease.id,
      testCase.kind === 'focus' ? { kind: 'focus' } : { kind: 'resize', cols: 120, rows: 40 },
    );
    const first = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    const outcome = await first.submit(input);
    expect(outcome).toMatchObject({
      status: 'succeeded', value: { state: 'succeeded', value: testCase.expected },
    });
    expect(first.actionStatus(input.id)).toMatchObject({ value: testCase.expected });
    expect(JSON.stringify(journal.read())).not.toContain(`${testCase.kind.toUpperCase()}_SECRET`);
    expect(JSON.stringify(journal.read())).toContain(JSON.stringify(testCase.expected));

    handlers.actOnPane = vi.fn();
    const restarted = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    await expect(restarted.submit(input)).resolves.toMatchObject({
      status: 'succeeded', value: { state: 'succeeded', value: testCase.expected },
    });
    expect(handlers.actOnPane).not.toHaveBeenCalled();
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

  it('normalizes and persists an exact bounded browser action postcondition', async () => {
    const deps = agentSurfaceHarness();
    handlers.actOnBrowser = vi.fn(async () => ({ clicked: true, submit: false,
      url: 'https://example.test/after', title: 'After' }));
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    await expect(runtime.submit(browserAction(deps.lease.id))).resolves.toMatchObject({
      status: 'succeeded', value: { value: { kind: 'click', clicked: true, submit: false,
        url: 'https://example.test/after', title: 'After' } },
    });
    expect(runtime.actionStatus('cmd-click')).toMatchObject({
      value: { kind: 'click', clicked: true, submit: false },
    });
  });

  it('rejects oversized browser postconditions instead of preserving provider values', async () => {
    const deps = agentSurfaceHarness();
    handlers.actOnBrowser = vi.fn(async () => ({ clicked: true, submit: false,
      url: `https://example.test/${'x'.repeat(3000)}`, title: 'After' }));
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    await expect(runtime.submit(browserAction(deps.lease.id))).resolves.toMatchObject({
      status: 'unknown', code: 'effect_unknown',
    });
  });

  it.each([
    ['nonsecret success without value', { secret: false }],
    ['secret success without valuePresent', { secret: true }],
    ['nonsecret success with contradictory valuePresent', { secret: false, value: 'new', valuePresent: true }],
    ['secret success leaking value', { secret: true, valuePresent: true, value: 'secret' }],
    ['nonsecret canceled with mutated value', { secret: false, canceled: true, value: 'new' }],
    ['secret canceled without valuePresent', { secret: true, canceled: true }],
    ['non-canceled success with canceled false', { secret: false, value: 'new', canceled: false }],
  ])('marks contradictory type evidence unknown: %s', async (_label, evidence) => {
    const deps = agentSurfaceHarness();
    deps.resolveBrowserSnapshot.mockImplementation(async (payload) => ({
      tabId: payload.tabId, generation: payload.generation, snapshotId: payload.snapshotId!,
      elementRef: 'elementRef' in payload.action ? payload.action.elementRef : '', actionKind: 'type',
      documentId: 'document-1', submit: null, formId: null, secret: false,
    }));
    handlers.actOnBrowser = vi.fn(async () => evidence);
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    await expect(runtime.submit(browserAction(deps.lease.id, {
      payload: { ...browserAction(deps.lease.id).payload,
        action: { kind: 'type', elementRef: 'e17', text: 'new' } },
    }))).resolves.toMatchObject({ status: 'unknown', code: 'effect_unknown' });
    expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'unknown', code: 'effect_unknown' });
  });

  it.each(['click', 'close'] as const)('rejects provider-supplied %s postcondition kind even when the rest is valid', async (kind) => {
    const deps = agentSurfaceHarness();
    handlers.actOnBrowser = vi.fn(async () => ({ kind, clicked: true, submit: false,
      url: 'https://example.test', title: 'Example' }));
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    await expect(runtime.submit(browserAction(deps.lease.id))).resolves.toMatchObject({
      status: 'unknown', code: 'effect_unknown',
    });
  });

  it.each([
    ['focus', { kind: 'focus', elementRef: 'e17' }, { focused: true }],
    ['type', { kind: 'type', elementRef: 'e17', text: 'new' }, { secret: false, value: 'new' }],
    ['select', { kind: 'select', elementRef: 'e17', values: ['one'] }, { values: ['one'] }],
    ['scroll', { kind: 'scroll', elementRef: 'e17', deltaY: 1 }, { scrollLeft: 0, scrollTop: 1 }],
    ['click', { kind: 'click', elementRef: 'e17' }, { clicked: true, submit: false,
      url: 'https://example.test', title: 'Example' }],
    ['submit', { kind: 'submit', elementRef: 'e17' }, { submitted: true, submit: true,
      url: 'https://example.test', title: 'Example' }],
    ['navigate', { kind: 'navigate', url: 'https://example.test/next' }, {
      url: 'https://example.test/next', title: 'Next' }],
    ['reload', { kind: 'reload' }, { url: 'https://example.test', title: 'Example' }],
    ['back', { kind: 'back' }, { url: 'https://example.test/back', title: 'Back' }],
    ['forward', { kind: 'forward' }, { url: 'https://example.test/forward', title: 'Forward' }],
    ['screenshot', { kind: 'screenshot' }, { pngBase64: 'iVBORw==', width: 1, height: 1,
      navigationEpoch: 1, navigationUrl: 'https://example.test' }],
    ['close', { kind: 'close' }, { closed: true }],
  ] as const)('rejects a provider kind field for commanded %s evidence', async (actionKind, action, evidence) => {
    const deps = agentSurfaceHarness();
    deps.resolveBrowserSnapshot.mockImplementation(async (payload) => {
      if (!payload.snapshotId || !('elementRef' in payload.action)) return undefined;
      const kind = payload.action.kind;
      return {
        tabId: payload.tabId, generation: payload.generation, snapshotId: payload.snapshotId,
        elementRef: payload.action.elementRef, actionKind: kind as never, documentId: 'document-1',
        submit: kind === 'click' || kind === 'submit' ? kind === 'submit' : null,
        formId: kind === 'submit' ? 'form-1' : null,
        secret: kind === 'type' ? false : null,
      };
    });
    handlers.actOnBrowser = vi.fn(async () => ({ ...evidence,
      kind: actionKind === 'close' ? 'click' : 'close' }));
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    const base = browserAction(deps.lease.id);
    const payload = { ...base.payload, action } as Record<string, unknown>;
    if (!('elementRef' in action)) delete payload.snapshotId;
    await runtime.submit(browserAction(deps.lease.id, {
      id: `cmd-kind-${actionKind}`, idempotencyKey: `idem-kind-${actionKind}`, payload,
    }));
    const approval = deps.approvals.snapshot()[0];
    if (approval) {
      await runtime.submit(command({
        id: `approve-kind-${actionKind}`, idempotencyKey: `approve-kind-${actionKind}`,
        kind: 'approval.resolve', actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
        payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
      }));
    }
    expect(runtime.actionStatus(`cmd-kind-${actionKind}`)).toMatchObject({
      state: 'unknown', code: 'effect_unknown',
    });
  });

  it.each([
    ['focus', { kind: 'focus', elementRef: 'e17' }, { focused: true }, false],
    ['type text', { kind: 'type', elementRef: 'e17', text: 'typed-secret' },
      { secret: false, value: 'typed-secret' }, false],
    ['type secret', { kind: 'type', elementRef: 'e17', text: 'typed-secret' },
      { secret: true, valuePresent: true }, true],
    ['type canceled', { kind: 'type', elementRef: 'e17', text: 'typed-secret' },
      { secret: false, canceled: true }, false],
    ['type secret canceled', { kind: 'type', elementRef: 'e17', text: 'typed-secret' },
      { secret: true, canceled: true, valuePresent: true }, true],
    ['select', { kind: 'select', elementRef: 'e17', values: ['selected-secret'] },
      { values: ['selected-secret'] }, false],
    ['scroll', { kind: 'scroll', elementRef: 'e17', deltaY: 7 },
      { scrollLeft: 3, scrollTop: 7 }, false],
    ['click', { kind: 'click', elementRef: 'e17' }, { clicked: true, submit: false,
      url: 'https://private.example/click', title: 'Private click title' }, false],
    ['submit', { kind: 'submit', elementRef: 'e17' }, { submitted: true, submit: true,
      url: 'https://private.example/submit', title: 'Private submit title' }, false],
    ['navigate', { kind: 'navigate', url: 'https://private.example/navigate' }, {
      url: 'https://private.example/navigate', title: 'Private navigate title' }, false],
    ['reload', { kind: 'reload' }, { url: 'https://private.example/reload', title: 'Private reload title' }, false],
    ['back', { kind: 'back' }, { url: 'https://private.example/back', title: 'Private back title' }, false],
    ['forward', { kind: 'forward' }, { url: 'https://private.example/forward', title: 'Private forward title' }, false],
    ['screenshot', { kind: 'screenshot' }, { pngBase64: 'c2NyZWVuc2hvdC1zZWNyZXQ=', width: 2, height: 2,
      navigationEpoch: 9, navigationUrl: 'https://private.example/screenshot' }, false],
    ['close', { kind: 'close' }, { closed: true }, false],
  ] as const)('keeps %s evidence live but redacts it from journal and replay', async (label, action, evidence, secret) => {
    const deps = agentSurfaceHarness();
    deps.resolveBrowserSnapshot.mockImplementation(async (payload) => {
      if (!payload.snapshotId || !('elementRef' in payload.action)) return undefined;
      const kind = payload.action.kind;
      return {
        tabId: payload.tabId, generation: payload.generation, snapshotId: payload.snapshotId,
        elementRef: payload.action.elementRef, actionKind: kind as never, documentId: 'document-1',
        submit: kind === 'click' || kind === 'submit' ? kind === 'submit' : null,
        formId: kind === 'submit' ? 'form-1' : null,
        secret: kind === 'type' ? secret : null,
      };
    });
    handlers.actOnBrowser = vi.fn(async () => evidence);
    const journal = createMemoryJournal();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    const base = browserAction(deps.lease.id);
    const payload = { ...base.payload, action } as Record<string, unknown>;
    if (!('elementRef' in action)) delete payload.snapshotId;
    const original = browserAction(deps.lease.id, {
      id: `private-${label}`, idempotencyKey: `private-${label}`, payload,
    });
    await runtime.submit(original);
    const approval = deps.approvals.snapshot()[0];
    if (approval) await runtime.submit(command({
      id: `approve-private-${label}`, idempotencyKey: `approve-private-${label}`,
      kind: 'approval.resolve', actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
    }));
    expect(runtime.actionStatus(original.id)).toMatchObject({ state: 'succeeded', value: { kind: action.kind, ...evidence } });
    const terminal = [...journal.read()].reverse().find((event) => event.payload.commandId === original.id)!;
    expect(terminal.payload).toMatchObject({ receipt: { value: {
      kind: action.kind, result: 'result_unavailable',
    } } });
    expect(JSON.stringify(terminal.payload)).not.toContain('private.example');
    expect(JSON.stringify(terminal.payload)).not.toContain('typed-secret');
    expect(JSON.stringify(terminal.payload)).not.toContain('selected-secret');
    expect(JSON.stringify(terminal.payload)).not.toContain('c2NyZWVuc2hvdC1zZWNyZXQ=');

    const effectCount = vi.mocked(handlers.actOnBrowser).mock.calls.length;
    await expect(runtime.submit(original)).resolves.toMatchObject({ status: 'succeeded', value: {
      actionId: original.id, value: { kind: action.kind, result: 'result_unavailable' },
    } });
    const restarted = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    await expect(restarted.submit(original)).resolves.toMatchObject({ status: 'succeeded', value: {
      actionId: original.id, value: { kind: action.kind, result: 'result_unavailable' },
    } });
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(effectCount);
  });

  it('downgrades legacy durable browser evidence to result_unavailable during rehydration', async () => {
    const journal = createMemoryJournal();
    await journal.append('command.succeeded', {
      commandId: 'legacy-browser', idempotencyKey: 'legacy-browser', status: 'succeeded',
      receipt: {
        schema: 'psyche.control.receipt/v1', actionId: 'legacy-browser', state: 'succeeded',
        resource: { kind: 'browser_tab', id: 'tab-1', generation: 1 },
        createdAt: '2026-08-12T12:00:00.000Z', completedAt: '2026-08-12T12:00:01.000Z',
        value: { kind: 'click', clicked: true, submit: false,
          url: 'https://legacy-private.example', title: 'Legacy private title' },
      },
    });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal });
    expect(runtime.actionStatus('legacy-browser')).toEqual(expect.objectContaining({
      value: { kind: 'click', result: 'result_unavailable' },
    }));
    expect(JSON.stringify(runtime.actionStatus('legacy-browser'))).not.toContain('legacy-private');
  });

  it.each([
    ['legacy', { sourceDigest: 'a'.repeat(64), sourceBytes: 1, resultBytes: 0,
      durationMs: 1, outcome: 'failed', privateSource: 'legacy secret' }],
    ['malformed', { sourceDigest: 'a'.repeat(64), sourceBytes: 1, argsBytes: 1,
      resultBytes: 0, durationMs: 1, outcome: 'future' }],
  ])('drops %s script summaries safely during replay', async (_label, value) => {
    const journal = createMemoryJournal();
    await journal.append('command.failed', {
      commandId: `script-${_label}`, idempotencyKey: `script-${_label}`, status: 'failed',
      code: 'script_execution_failed', receipt: {
        schema: 'psyche.control.receipt/v1', actionId: `script-${_label}`, state: 'failed',
        code: 'script_execution_failed', resource: { kind: 'browser_tab', id: 'tab-1', generation: 1 },
        createdAt: '2026-08-12T12:00:00.000Z', completedAt: '2026-08-12T12:00:01.000Z', value,
      },
    });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal });
    expect(runtime.actionStatus(`script-${_label}`)).toMatchObject({ state: 'failed', code: 'script_execution_failed' });
    expect(runtime.actionStatus(`script-${_label}`)).not.toHaveProperty('value');
    expect(JSON.stringify(runtime.actionStatus(`script-${_label}`))).not.toContain('legacy secret');
  });

  it.each([
    ['outcome', 'failed', 'script_execution_failed', { sourceDigest: 'a'.repeat(64), sourceBytes: 1,
      argsBytes: 1, resultBytes: 0, durationMs: 1, outcome: 'succeeded' }],
    ['failure-bytes', 'failed', 'script_execution_failed', { sourceDigest: 'a'.repeat(64), sourceBytes: 1,
      argsBytes: 1, resultBytes: 1, durationMs: 1, outcome: 'failed' }],
    ['timeout', 'failed', 'action_timeout', { sourceDigest: 'a'.repeat(64), sourceBytes: 1,
      argsBytes: 1, resultBytes: 0, durationMs: 4_999, outcome: 'failed' }],
    ['unknown-code', 'unknown', 'other_unknown', { sourceDigest: 'a'.repeat(64), sourceBytes: 1,
      argsBytes: 1, resultBytes: 0, durationMs: 1, outcome: 'unknown' }],
    ['missing-failed-code', 'failed', undefined, { sourceDigest: 'a'.repeat(64), sourceBytes: 1,
      argsBytes: 1, resultBytes: 0, durationMs: 1, outcome: 'failed' }],
    ['succeeded-code', 'succeeded', 'unexpected', { sourceDigest: 'a'.repeat(64), sourceBytes: 1,
      argsBytes: 1, resultBytes: 1, durationMs: 1, outcome: 'succeeded' }],
  ] as const)('drops contradictory %s script summaries during replay', async (label, state, code, value) => {
    const journal = createMemoryJournal();
    await journal.append('command.failed', { commandId: `contradictory-${label}`,
      idempotencyKey: `contradictory-${label}`, status: 'failed', ...(code ? { code } : {}), receipt: {
        schema: 'psyche.control.receipt/v1', actionId: `contradictory-${label}`, state, code,
        resource: { kind: 'browser_tab', id: 'tab-1', generation: 1 },
        createdAt: '2026-08-12T12:00:00.000Z', completedAt: '2026-08-12T12:00:01.000Z', value,
      } });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal });
    expect(runtime.actionStatus(`contradictory-${label}`)?.value).toBeUndefined();
  });

  it.each([
    ['kind-state', 'command.failed', 'failed', 'script_execution_failed', 'cmd-kind-state', 'succeeded', undefined, 'succeeded'],
    ['payload-status', 'command.failed', 'succeeded', 'script_execution_failed', 'cmd-payload-status', 'failed', 'script_execution_failed', 'failed'],
    ['differing-code', 'command.failed', 'failed', 'script_execution_failed', 'cmd-differing-code', 'failed', 'action_timeout', 'failed'],
    ['action-id', 'command.failed', 'failed', 'script_execution_failed', 'other-action', 'failed', 'script_execution_failed', 'failed'],
    ['unknown-failed', 'command.unknown', 'unknown', 'effect_unknown', 'cmd-unknown-failed', 'failed', 'script_execution_failed', 'failed'],
    ['succeeded-code', 'command.succeeded', 'succeeded', 'unexpected', 'cmd-succeeded-code', 'succeeded', 'unexpected', 'succeeded'],
  ] as const)('does not let contradictory outer %s receipts override terminal replay', async (
    label, kind, status, outerCode, receiptActionId, receiptState, receiptCode, summaryOutcome,
  ) => {
    const commandId = `cmd-${label}`;
    const journal = createMemoryJournal();
    await journal.append(kind, { commandId, idempotencyKey: commandId, status, code: outerCode,
      receipt: { schema: 'psyche.control.receipt/v1', actionId: receiptActionId, state: receiptState,
        ...(receiptCode ? { code: receiptCode } : {}),
        resource: { kind: 'browser_tab', id: 'tab-1', generation: 1 },
        createdAt: '2026-08-12T12:00:00.000Z', completedAt: '2026-08-12T12:00:01.000Z',
        value: { sourceDigest: 'a'.repeat(64), sourceBytes: 1, argsBytes: 1,
          resultBytes: summaryOutcome === 'succeeded' ? 1 : 0,
          durationMs: receiptCode === 'action_timeout' ? 5_000 : 1, outcome: summaryOutcome },
      } });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal });
    expect(runtime.actionStatus(commandId)).toBeUndefined();
    const replayed = (runtime as unknown as { outcomesByCommandId: Map<string, { status: string; code?: string }> })
      .outcomesByCommandId.get(commandId);
    expect(replayed).toMatchObject({ status: kind === 'command.succeeded' ? 'succeeded'
      : kind === 'command.unknown' ? 'unknown' : 'failed',
      ...(kind === 'command.succeeded' ? {} : { code: outerCode }) });
  });

  it('normalizes actual submit and screenshot provider postconditions into exact receipts', async () => {
    const deps = agentSurfaceHarness();
    deps.resolveBrowserSnapshot.mockImplementation(async (payload) => ({
      tabId: payload.tabId, generation: payload.generation, snapshotId: payload.snapshotId!,
      elementRef: 'elementRef' in payload.action ? payload.action.elementRef : '',
      actionKind: 'submit', documentId: 'document-1',
      submit: true, formId: 'form-1', secret: null,
    }));
    handlers.actOnBrowser = vi.fn(async (payload) => payload.action.kind === 'submit'
      ? { submitted: true, submit: true, url: 'https://example.test/after', title: 'After' }
      : { pngBase64: 'iVBORw==', width: 1, height: 1, navigationEpoch: 4,
          navigationUrl: 'https://example.test/after' });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    await runtime.submit(browserAction(deps.lease.id, {
      payload: { ...browserAction(deps.lease.id).payload, action: { kind: 'submit', elementRef: 'e17' } },
    }));
    const approval = deps.approvals.snapshot()[0]!;
    await expect(runtime.submit(command({
      id: 'approve-submit', idempotencyKey: 'approve-submit', kind: 'approval.resolve',
      actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
    }))).resolves.toMatchObject({ status: 'succeeded', value: { value: {
      kind: 'submit', submitted: true, submit: true, url: 'https://example.test/after', title: 'After',
    } } });
    const screenshotPayload = { ...browserAction(deps.lease.id).payload,
      action: { kind: 'screenshot' as const } };
    delete (screenshotPayload as { snapshotId?: string }).snapshotId;
    await expect(runtime.submit(browserAction(deps.lease.id, {
      id: 'screenshot-action', idempotencyKey: 'screenshot-action',
      payload: screenshotPayload,
    }))).resolves.toMatchObject({ status: 'succeeded', value: { value: {
      kind: 'screenshot', pngBase64: 'iVBORw==', width: 1, height: 1, navigationEpoch: 4,
    } } });
  });

  it('marks missing screenshot evidence unknown after provider dispatch', async () => {
    const deps = agentSurfaceHarness();
    handlers.actOnBrowser = vi.fn(async () => undefined);
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    const screenshotPayload = { ...browserAction(deps.lease.id).payload,
      action: { kind: 'screenshot' as const } };
    delete (screenshotPayload as { snapshotId?: string }).snapshotId;
    await expect(runtime.submit(browserAction(deps.lease.id, {
      payload: screenshotPayload,
    }))).resolves.toMatchObject({ status: 'unknown', code: 'effect_unknown' });
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
      'cmd-click',
      expect.objectContaining({ submit: true, snapshotId: 'snapshot-1', elementRef: 'e17' }),
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

  it.each([
    { action: { kind: 'click', elementRef: 'e17' }, binding: { submit: false, secret: null } },
    { action: { kind: 'type', elementRef: 'e17', text: 'value' }, binding: { submit: null, formId: null, secret: false } },
    { action: { kind: 'submit', elementRef: 'e17' }, binding: { submit: true, formId: null, secret: null } },
  ] as const)('rejects incomplete exact $action.kind risk identity fields', async ({ action, binding }) => {
    const deps = agentSurfaceHarness();
    deps.resolveBrowserSnapshot.mockResolvedValueOnce({
      tabId: 'tab-1', generation: 1, snapshotId: 'snapshot-1', elementRef: 'e17',
      actionKind: action.kind, ...binding,
    } as never);
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
        tabId: 'tab-1', generation: 1, snapshotId: 'snapshot-1', elementRef: 'e17', actionKind: 'click',
        documentId: 'document-1', submit: false, formId: null, secret: null,
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
    handlers.actOnBrowser = vi.fn(() => new Promise((resolve) => { releaseEffect = () => resolve({
      clicked: true, submit: true, url: 'https://example.test', title: 'Example',
    }); }));
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
    expect(runtime.snapshot().receipts?.find(({ commandId }) => commandId === 'cmd-click'))
      .toMatchObject({ outcome: 'queued' });
    releaseQueue();
    await vi.waitFor(() => expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'running' }));
    expect(runtime.snapshot().receipts?.find(({ commandId }) => commandId === 'cmd-click'))
      .toMatchObject({ outcome: 'running' });
    releaseEffect();
    await resolving;
    expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'succeeded' });
    expect(runtime.snapshot().receipts?.filter(({ commandId }) => commandId === 'cmd-click')).toHaveLength(1);
  });

  it('expires passive approvals on snapshot and promptly releases pending command scope', async () => {
    let currentTime = new Date('2026-08-12T12:00:00.000Z');
    const deps = agentSurfaceHarness();
    deps.risk.submit = true;
    deps.approvals = new ApprovalStore(() => currentTime, () => 'approval-expiring');
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    await runtime.submit(browserAction(deps.lease.id));
    const approval = deps.approvals.snapshot()[0]!;
    const internals = runtime as unknown as {
      pendingApprovals: Map<string, unknown>;
      receiptScopes: Map<string, unknown>;
    };
    expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'approval_required' });
    expect(internals.pendingApprovals.size).toBe(1);
    expect(internals.receiptScopes.size).toBe(1);

    currentTime = new Date(Date.parse(approval.expiresAt) + 1);
    expect(runtime.snapshot().approvals).toEqual([expect.objectContaining({ id: approval.id, status: 'expired' })]);
    expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'expired' });
    expect(runtime.snapshot().receipts).toEqual([expect.objectContaining({ commandId: 'cmd-click', outcome: 'expired' })]);
    expect(internals.pendingApprovals.size).toBe(0);
    expect(internals.receiptScopes.size).toBe(0);

    await expect(runtime.submit(command({
      id: 'resolve-expired', idempotencyKey: 'resolve-expired', kind: 'approval.resolve',
      actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
    }))).resolves.toMatchObject({ status: 'failed', code: 'approval_missing' });
    await runtime.submit(browserAction(deps.lease.id));
    expect(internals.pendingApprovals.size).toBe(0);
    expect(internals.receiptScopes.size).toBe(0);
    expect(deps.approvals.snapshot()).toEqual([expect.objectContaining({ status: 'expired' })]);
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

  it('binds approval to the original canonical form identity across consume and queue resume', async () => {
    const deps = agentSurfaceHarness();
    let formId = 'form-1';
    deps.resolveBrowserSnapshot.mockImplementation(async (payload) => ({
      tabId: payload.tabId, generation: payload.generation, snapshotId: payload.snapshotId!,
      elementRef: 'elementRef' in payload.action ? payload.action.elementRef : '',
      actionKind: 'click', documentId: 'document-1',
      submit: true, formId, secret: null,
    }));
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    await runtime.submit(browserAction(deps.lease.id));
    const approval = deps.approvals.snapshot()[0]!;
    formId = 'form-2';
    await expect(runtime.submit(command({
      id: 'cmd-form-change', idempotencyKey: 'idem-form-change', kind: 'approval.resolve',
      actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
    }))).resolves.toMatchObject({ status: 'failed', code: 'approval_identity_mismatch' });
    expect(handlers.actOnBrowser).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'generic click becomes submit', initial: { submit: false, formId: null, secret: null },
      changed: { submit: true, formId: 'form-2', secret: null }, action: { kind: 'click', elementRef: 'e17' } },
    { name: 'text input becomes password', initial: { submit: null, formId: null, secret: false },
      changed: { submit: null, formId: null, secret: true }, action: { kind: 'type', elementRef: 'e17', text: 'secret' } },
  ])('fails queued low-risk action before effect when $name', async ({ initial, changed, action }) => {
    const deps = agentSurfaceHarness();
    let risk: { submit: boolean | null; formId: string | null; secret: boolean | null } = initial;
    deps.resolveBrowserSnapshot.mockImplementation(async (payload) => ({
      tabId: payload.tabId, generation: payload.generation, snapshotId: payload.snapshotId!,
      elementRef: 'elementRef' in payload.action ? payload.action.elementRef : '',
      actionKind: payload.action.kind as never,
      documentId: 'document-1', ...risk,
    }));
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    const release = runtime.blockResourceQueue('browser_tab:tab-1:1');
    const pending = runtime.submit(browserAction(deps.lease.id, {
      payload: { ...browserAction(deps.lease.id).payload, action },
    }));
    await vi.waitFor(() => expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'queued' }));
    risk = changed;
    release();
    await expect(pending).resolves.toMatchObject({ status: 'failed', code: 'approval_identity_mismatch' });
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

  it('revokes exact pane leases and approvals when provider reconciliation removes it', async () => {
    const surfaces = new SurfaceRegistry();
    surfaces.upsertPane({
      id: 'pane-1', tmuxPaneId: '%3', projectRoot: '/repo', worktreeRoot: '/repo',
      writable: true, outputSequence: 0,
    });
    const capabilityLeases = new CapabilityLeaseStore(now, 7);
    const approvals = new ApprovalStore(now, () => 'approval-reconcile');
    const lease = capabilityLeases.grant({
      requestId: 'request-reconcile', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1',
      ttlMs: 60_000,
      grants: [{ target: { kind: 'pane', id: 'pane-1', generation: 1 }, capabilities: ['pane.close'] }],
    });
    approvals.request({
      actionId: 'close-reconcile', ownerEpoch: 7, leaseId: lease.id, leaseRevision: 1,
      resource: { kind: 'pane', id: 'pane-1', generation: 1 }, capability: 'pane.close',
      effect: { kind: 'close', target: 'pane' }, actionPayload: { action: { kind: 'close' } },
    });
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), surfaces, capabilityLeases, approvals,
    });
    runtime.revokeSurfaceAuthority({ kind: 'pane', id: 'pane-1', generation: 1 });
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

  it('rejects operator command upserts over pane identities without mutating authority', async () => {
    const surfaces = new SurfaceRegistry();
    const pane = surfaces.upsertPane({ id: 'shared-1', tmuxPaneId: '%3', projectRoot: '/repo',
      worktreeRoot: '/repo', writable: true, outputSequence: 0 });
    const capabilityLeases = new CapabilityLeaseStore(now, 7);
    const lease = capabilityLeases.grant({ requestId: 'pane-lease', actorId: 'agent-1',
      taskId: 'task-1', grantedBy: 'operator-1', ttlMs: 60_000,
      grants: [{ target: { kind: 'pane', id: pane.id, generation: pane.generation },
        capabilities: ['pane.observe'] }] });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers,
      journal: createMemoryJournal(), surfaces, capabilityLeases });
    const outcome = await runtime.submit(command({ id: 'collision-upsert',
      idempotencyKey: 'collision-upsert', kind: 'provider.resource.upsert',
      actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
      payload: { resource: { id: pane.id, kind: 'browser_tab', generation: pane.generation,
        providerId: 'desktop-1', webviewLabel: 'browser-a', projectRoot: '/repo',
        worktreeRoot: '/repo', url: 'https://example.test', title: 'Example', loading: false,
        viewport: { width: 800, height: 600 } } } }));
    expect(outcome).toMatchObject({ status: 'failed', code: 'resource_collision' });
    expect(surfaces.get(pane.id)).toBe(pane);
    expect(capabilityLeases.snapshot()).toEqual([lease]);
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
    expect(second.actionStatus('cmd-click')).toMatchObject({ state: 'unknown', code: 'effect_unknown' });
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
    ['generation', { generation: 99 }, 'resource_replaced', 0],
    ['lease revision', { leaseRevision: 99 }, 'lease_revision_mismatch', 1],
  ])('creates exactly one redacted receipt and terminal event for %s revalidation failure', async (_label, payloadOverride, code, recentCount) => {
    const deps = agentSurfaceHarness();
    const journal = createMemoryJournal();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    await runtime.submit(browserAction(deps.lease.id, {
      payload: { ...browserAction(deps.lease.id).payload, ...payloadOverride },
    }));
    expect(runtime.actionStatus('cmd-click')).toMatchObject({ state: 'failed', code });
    expect(runtime.snapshot().receipts?.filter(({ commandId }) => commandId === 'cmd-click')).toHaveLength(recentCount);
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
    expect(runtime.snapshot().receipts?.map(({ commandId }) => commandId)).toEqual(['cmd-click']);
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
    expect(JSON.stringify(runtime.events())).not.toContain('sensitive backend detail');
  });

  it('rejects oversized UTF-8 browser script source before requesting approval', async () => {
    const deps = agentSurfaceHarness();
    const lease = deps.capabilityLeases.grant({
      requestId: 'request-script', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1', ttlMs: 60_000,
      grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 }, capabilities: ['browser.script'] }],
    });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    await expect(runtime.submit(browserScript(lease.id, {
      payload: { ...browserScript(lease.id).payload, source: 'é'.repeat(32_769) },
    }))).resolves.toMatchObject({ status: 'failed', code: 'script_source_too_large' });
    expect(deps.approvals.snapshot()).toEqual([]);
    expect(handlers.runBrowserScript).not.toHaveBeenCalled();
  });

  it.each([
    ['oversized', 'x'.repeat(256 * 1024)],
    ['non-finite', Number.NaN],
    ['non-plain', new Date('2026-08-12T12:00:00.000Z')],
    ['undefined', undefined],
  ])('rejects %s browser script arguments before approval or effect', async (_label, args) => {
    const deps = agentSurfaceHarness();
    const lease = deps.capabilityLeases.grant({
      requestId: 'request-script', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1', ttlMs: 60_000,
      grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 }, capabilities: ['browser.script'] }],
    });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    const script = browserScript(lease.id);
    await expect(runtime.submit(browserScript(lease.id, {
      payload: { ...script.payload, args },
    }))).resolves.toMatchObject({ status: 'failed', code: expect.stringMatching(/^script_args_(invalid|too_large)$/) });
    expect(deps.approvals.snapshot()).toEqual([]);
    expect(deps.resolveBrowserScriptContext).not.toHaveBeenCalled();
    expect(handlers.runBrowserScript).not.toHaveBeenCalled();
  });

  it('rejects cyclic and accessor browser script arguments without evaluating them', async () => {
    const deps = agentSurfaceHarness();
    const lease = deps.capabilityLeases.grant({
      requestId: 'request-script', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1', ttlMs: 60_000,
      grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 }, capabilities: ['browser.script'] }],
    });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const getter = vi.fn(() => 'secret');
    const accessor = {};
    Object.defineProperty(accessor, 'secret', { enumerable: true, get: getter });
    for (const args of [cyclic, accessor]) {
      const script = browserScript(lease.id);
      await expect(runtime.submit(browserScript(lease.id, {
        id: `cmd-${args === cyclic ? 'cycle' : 'accessor'}`,
        idempotencyKey: `idem-${args === cyclic ? 'cycle' : 'accessor'}`,
        payload: { ...script.payload, args },
      }))).resolves.toMatchObject({ status: 'failed', code: 'script_args_invalid' });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(deps.approvals.snapshot()).toEqual([]);
    expect(handlers.runBrowserScript).not.toHaveBeenCalled();
  });

  it('consumes a one-shot script approval and returns only bounded live result metadata', async () => {
    const deps = agentSurfaceHarness();
    const lease = deps.capabilityLeases.grant({
      requestId: 'request-script', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1', ttlMs: 60_000,
      grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 }, capabilities: ['browser.script'] }],
    });
    handlers.runBrowserScript = vi.fn(async () => ({ value: { answer: 42 }, byteCount: 13, durationMs: 7 }));
    const journal = createMemoryJournal();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    await runtime.submit(browserScript(lease.id));
    const approval = deps.approvals.snapshot()[0]!;
    const outcome = await runtime.submit(command({
      id: 'resolve-script', idempotencyKey: 'resolve-script', kind: 'approval.resolve', ownerEpoch: 7,
      actor: { id: 'operator-1', kind: 'human' },
      payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
    }));
    expect(outcome).toMatchObject({ status: 'succeeded', value: { value: { answer: 42 }, byteCount: 13, durationMs: 7 } });
    expect(runtime.actionStatus('cmd-script')).toMatchObject({ state: 'succeeded', value: {
      sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/), sourceBytes: 18,
      argsBytes: 13, resultBytes: 13, durationMs: 7, outcome: 'succeeded',
    } });
    expect(JSON.stringify(runtime.events())).not.toContain('return args.answer');
    expect(JSON.stringify(runtime.events())).not.toContain('"answer":42');
    const restarted = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    expect(restarted.actionStatus('cmd-script')).toMatchObject({ state: 'succeeded', value: {
      sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/), sourceBytes: 18,
      argsBytes: 13, resultBytes: 13, durationMs: 7, outcome: 'succeeded',
    } });
    await expect(restarted.submit(browserScript(lease.id))).resolves.toMatchObject({
      status: 'succeeded', value: { state: 'succeeded', value: { resultBytes: 13, outcome: 'succeeded' } },
    });
  });

  it('requires a distinct approval for every browser script invocation', async () => {
    const deps = agentSurfaceHarness(); let sequence = 0;
    deps.approvals = new ApprovalStore(now, () => `approval-script-${++sequence}`);
    const lease = deps.capabilityLeases.grant({
      requestId: 'request-script', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1', ttlMs: 60_000,
      grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 }, capabilities: ['browser.script'] }],
    });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
    await runtime.submit(browserScript(lease.id));
    const first = deps.approvals.snapshot()[0]!;
    await runtime.submit(command({
      id: 'deny-script', idempotencyKey: 'deny-script', kind: 'approval.resolve', ownerEpoch: 7,
      actor: { id: 'operator-1', kind: 'human' },
      payload: { approvalId: first.id, payloadDigest: first.payloadDigest, decision: 'deny' },
    }));
    await runtime.submit(browserScript(lease.id, {
      id: 'cmd-script-2', idempotencyKey: 'idem-script-2',
    }));
    expect(deps.approvals.snapshot()).toEqual([
      expect.objectContaining({ id: 'approval-script-1', status: 'denied' }),
      expect.objectContaining({ id: 'approval-script-2', status: 'pending' }),
    ]);
    expect(handlers.runBrowserScript).not.toHaveBeenCalled();
  });

  it('binds script approval to the exact preflight document token and revalidates before dispatch', async () => {
    const deps = agentSurfaceHarness();
    const lease = deps.capabilityLeases.grant({
      requestId: 'request-script', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1', ttlMs: 60_000,
      grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 }, capabilities: ['browser.script'] }],
    });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps } as any);
    await runtime.submit(browserScript(lease.id));
    const approval = deps.approvals.snapshot()[0]!;
    deps.scriptContext.documentToken = 'token-2';
    const outcome = await runtime.submit(command({
      id: 'resolve-script-context', idempotencyKey: 'resolve-script-context', kind: 'approval.resolve', ownerEpoch: 7,
      actor: { id: 'operator-1', kind: 'human' },
      payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
    }));
    expect(outcome).toMatchObject({ status: 'failed', code: 'approval_identity_mismatch' });
    expect(handlers.runBrowserScript).not.toHaveBeenCalled();
    expect(deps.resolveBrowserScriptContext).toHaveBeenCalledTimes(2);
  });

  it('preserves the broker action_timeout without retry when an approved script exceeds five seconds', async () => {
    vi.useFakeTimers();
    try {
      const deps = agentSurfaceHarness();
      const lease = deps.capabilityLeases.grant({
        requestId: 'request-script', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1', ttlMs: 60_000,
        grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 }, capabilities: ['browser.script'] }],
      });
      handlers.runBrowserScript = vi.fn(() => new Promise((_resolve, reject) => setTimeout(() => reject(Object.assign(
        new Error('provider detail'), { code: 'action_timeout', ambiguous: true, noRetry: true, durationMs: 5_000 },
      )), 5_000)));
      const journal = createMemoryJournal();
      const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
      await runtime.submit(browserScript(lease.id));
      const approval = deps.approvals.snapshot()[0]!;
      const pending = runtime.submit(command({
        id: 'resolve-script', idempotencyKey: 'resolve-script', kind: 'approval.resolve', ownerEpoch: 7,
        actor: { id: 'operator-1', kind: 'human' },
        payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
      }));
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toMatchObject({ status: 'failed', code: 'action_timeout' });
      expect(runtime.actionStatus('cmd-script')).toMatchObject({ state: 'failed', code: 'action_timeout', value: {
        sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/), sourceBytes: 18, argsBytes: 13,
        resultBytes: 0, durationMs: 5_000, outcome: 'failed',
      } });
      const restarted = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
      expect(restarted.actionStatus('cmd-script')).toEqual(runtime.actionStatus('cmd-script'));
      expect(JSON.stringify(runtime.events())).not.toMatch(/return args\.answer|"answer":42|token-1|example\.test/);
      expect(handlers.runBrowserScript).toHaveBeenCalledTimes(1);
      await runtime.submit(browserScript(lease.id));
      expect(handlers.runBrowserScript).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([undefined, 4_999, 5_001])(
    'canonicalizes defensive action_timeout duration %s before journal replay',
    async (durationMs) => {
      const deps = agentSurfaceHarness();
      const lease = deps.capabilityLeases.grant({
        requestId: 'request-script', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1', ttlMs: 60_000,
        grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 }, capabilities: ['browser.script'] }],
      });
      handlers.runBrowserScript = vi.fn(async () => {
        throw Object.assign(new Error('invalid provider timeout'), {
          code: 'action_timeout', ambiguous: true, noRetry: true,
          ...(durationMs === undefined ? {} : { durationMs }),
        });
      });
      const journal = createMemoryJournal();
      const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
      await runtime.submit(browserScript(lease.id));
      const approval = deps.approvals.snapshot()[0]!;
      await expect(runtime.submit(command({
        id: 'resolve-script', idempotencyKey: 'resolve-script', kind: 'approval.resolve', ownerEpoch: 7,
        actor: { id: 'operator-1', kind: 'human' },
        payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
      }))).resolves.toMatchObject({ status: 'failed', code: 'action_timeout' });
      expect(runtime.actionStatus('cmd-script')).toMatchObject({ state: 'failed', code: 'action_timeout', value: {
        resultBytes: 0, durationMs: 5_000, outcome: 'failed',
      } });
      const restarted = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
      expect(restarted.actionStatus('cmd-script')).toEqual(runtime.actionStatus('cmd-script'));
    },
  );

  it('persists replacement-at-deadline script ambiguity as effect_unknown', async () => {
    const deps = agentSurfaceHarness();
    const lease = deps.capabilityLeases.grant({
      requestId: 'request-script', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1', ttlMs: 60_000,
      grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 }, capabilities: ['browser.script'] }],
    });
    handlers.runBrowserScript = vi.fn(async () => {
      throw Object.assign(new Error('document replaced at deadline'), {
        code: 'effect_unknown', ambiguous: true, noRetry: true, durationMs: 23,
      });
    });
    const journal = createMemoryJournal();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    await runtime.submit(browserScript(lease.id));
    const approval = deps.approvals.snapshot()[0]!;
    await expect(runtime.submit(command({
      id: 'resolve-script', idempotencyKey: 'resolve-script', kind: 'approval.resolve', ownerEpoch: 7,
      actor: { id: 'operator-1', kind: 'human' },
      payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
    }))).resolves.toMatchObject({ status: 'unknown', code: 'effect_unknown' });
    expect(runtime.actionStatus('cmd-script')).toMatchObject({ state: 'unknown', code: 'effect_unknown', value: {
      sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/), sourceBytes: 18, argsBytes: 13,
      resultBytes: 0, durationMs: 23, outcome: 'unknown',
    } });
    const restarted = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    expect(restarted.actionStatus('cmd-script')).toEqual(runtime.actionStatus('cmd-script'));
    expect(JSON.stringify(runtime.events())).not.toMatch(/return args\.answer|"answer":42|token-1|example\.test/);
    expect(handlers.runBrowserScript).toHaveBeenCalledTimes(1);
  });

  it('persists a redacted failed script summary across restart', async () => {
    const deps = agentSurfaceHarness();
    const lease = deps.capabilityLeases.grant({
      requestId: 'request-script', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1', ttlMs: 60_000,
      grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 }, capabilities: ['browser.script'] }],
    });
    handlers.runBrowserScript = vi.fn(async () => {
      throw Object.assign(new Error('private failure detail'), { code: 'script_execution_failed', durationMs: 17 });
    });
    const journal = createMemoryJournal();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    await runtime.submit(browserScript(lease.id));
    const approval = deps.approvals.snapshot()[0]!;
    await expect(runtime.submit(command({
      id: 'resolve-script', idempotencyKey: 'resolve-script', kind: 'approval.resolve', ownerEpoch: 7,
      actor: { id: 'operator-1', kind: 'human' },
      payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
    }))).resolves.toMatchObject({ status: 'failed', code: 'script_execution_failed' });
    expect(runtime.actionStatus('cmd-script')).toMatchObject({ state: 'failed', value: {
      sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/), sourceBytes: 18, argsBytes: 13,
      resultBytes: 0, durationMs: 17, outcome: 'failed',
    } });
    const restarted = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    expect(restarted.actionStatus('cmd-script')).toEqual(runtime.actionStatus('cmd-script'));
    expect(JSON.stringify(runtime.events())).not.toMatch(/private failure detail|return args\.answer|"answer":42|token-1/);
  });

  it('accepts authoritative native success metadata delivered after five seconds', async () => {
    vi.useFakeTimers();
    try {
      const deps = agentSurfaceHarness();
      const lease = deps.capabilityLeases.grant({
        requestId: 'request-script', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator-1', ttlMs: 60_000,
        grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 }, capabilities: ['browser.script'] }],
      });
      handlers.runBrowserScript = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve({
        value: 'late transport', byteCount: 16, durationMs: 4_999,
      }), 5_100)));
      const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps });
      await runtime.submit(browserScript(lease.id));
      const approval = deps.approvals.snapshot()[0]!;
      const pending = runtime.submit(command({
        id: 'resolve-script', idempotencyKey: 'resolve-script', kind: 'approval.resolve', ownerEpoch: 7,
        actor: { id: 'operator-1', kind: 'human' },
        payload: { approvalId: approval.id, payloadDigest: approval.payloadDigest, decision: 'approve' },
      }));
      await vi.advanceTimersByTimeAsync(5_100);
      await expect(pending).resolves.toMatchObject({ status: 'succeeded', value: {
        value: 'late transport', byteCount: 16, durationMs: 4_999,
      } });
    } finally {
      vi.useRealTimers();
    }
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
      receipts: [expect.objectContaining({ commandId: 'cmd-click', actionKind: 'browser.action',
        agentId: 'agent-1', taskId: 'task-1', outcome: 'succeeded', redacted: true,
        resource: { id: 'tab-1', kind: 'browser_tab', generation: 1 } })],
    });
    const receipt = runtime.snapshot().receipts?.[0];
    if (!receipt) throw new Error('expected redacted receipt');
    expect(receipt).not.toHaveProperty('value');
    expect(receipt).not.toHaveProperty('code');
    expect(receipt).not.toHaveProperty('message');
    expect(JSON.stringify(runtime.snapshot().receipts)).not.toMatch(/url|title|screenshot|elementRef|script|secret|message|code|value/);
    for (const secret of ['https://example.test', 'Refresh', 'snapshot-1', '"elementRef":"e17"']) {
      expect(serialized).not.toContain(secret);
    }
    const journal = JSON.stringify(runtime.events());
    for (const secret of ['https://example.test', 'Refresh', 'snapshot-1', '"elementRef":"e17"', '/repo']) {
      expect(journal).not.toContain(secret);
    }
  });

  it('retains immutable exact receipt provenance after more than 1000 later command records are evicted', async () => {
    const deps = agentSurfaceHarness();
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), ...deps,
    });
    await runtime.submit(browserAction(deps.lease.id));
    for (let index = 0; index < 1_005; index += 1) {
      await runtime.submit(command({
        id: `later-${index}`, idempotencyKey: `later-idem-${index}`,
        kind: 'pane.takeover', actor: { id: 'operator-1', kind: 'human' }, ownerEpoch: 7,
        payload: { paneId: `missing-${index}` },
      }));
    }
    expect(runtime.snapshot().commands).not.toHaveProperty('cmd-click');
    expect(runtime.snapshot().receipts).toEqual([expect.objectContaining({
      commandId: 'cmd-click', actionKind: 'browser.action', outcome: 'succeeded',
      agentId: 'agent-1', taskId: 'task-1', projectRoot: '/repo', worktreeRoot: '/repo',
      resource: { kind: 'browser_tab', id: 'tab-1', generation: 1 },
      redacted: true, result: 'result_unavailable',
    })]);
  });

  it('does not expose prior-owner receipt summaries after journal replay', async () => {
    const deps = agentSurfaceHarness();
    const journal = createMemoryJournal();
    const first = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, ...deps });
    await first.submit(browserAction(deps.lease.id));
    expect(first.snapshot().receipts).toHaveLength(1);
    const restarted = await ControlRuntime.create({ ownerEpoch: 8, handlers, journal,
      surfaces: deps.surfaces, capabilityLeases: deps.capabilityLeases, approvals: deps.approvals });
    expect(restarted.snapshot().receipts).toEqual([]);
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
