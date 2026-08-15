import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
__TAKE_OURS_VERBATIM__

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

async function submit(runtime: ControlRuntime, input: ControlCommand) {
  if (input.kind !== 'lease.grant' || !('grants' in input.payload)) {
    return runtime.submit(input);
  }
  const legacy = input.payload as unknown as {
    actorId: string;
    taskId: string;
    ttlMs: number;
    grants: Extract<ControlCommand, { kind: 'lease.request' }>['payload']['grants'];
  };
  const requestId = `test-request:${input.id}`;
  await runtime.submit({
    ...input,
    id: requestId,
    idempotencyKey: requestId,
    kind: 'lease.request',
    actor: { id: legacy.actorId, kind: 'psyche' },
    payload: { taskId: legacy.taskId, ttlMs: legacy.ttlMs, grants: legacy.grants },
  });
  return runtime.submit({ ...input, payload: { requestId } });
}

async function createBrowserActionHarness(options: {
  resolver?: (input: { snapshotId: string; elementRef: string }) => ReturnType<typeof createCanonicalElementSemantics>;
  actOnBrowser?: ControlHandlers['actOnBrowser'];
  runBrowserScript?: ControlHandlers['runBrowserScript'];
  actorId?: string;
  taskId?: string;
  clock?: () => Date;
  leaseTtlMs?: number;
  readActiveTaskCredential?: (taskId: string) => Promise<ControlTaskCredentialReference | null>;
} = {}) {
  const journal = createMemoryJournal();
  const surfaces = new SurfaceRegistry();
  const actorId = options.actorId ?? 'agent-review';
  const taskId = options.taskId ?? 'task-review';
  const clock = options.clock ?? (() => new Date('2026-08-12T12:00:00.000Z'));
  const tab = surfaces.upsertBrowserTab({
    id: 'tab-review', projectRoot: '/repo', worktreeRoot: '/repo', providerId: 'provider-review',
    webviewLabel: 'review', url: 'https://example.test', title: 'Example', loading: false,
    viewport: { width: 800, height: 600 },
  });
  const capabilityLeases = new CapabilityLeaseStore(clock, 7);
  let approvalId = 0;
  const approvals = new ApprovalStore(
    clock,
    () => `approval-review-${++approvalId}`,
  );
  if (options.actOnBrowser) handlers.actOnBrowser = options.actOnBrowser;
  if (options.runBrowserScript) handlers.runBrowserScript = options.runBrowserScript;
  const runtime = await ControlRuntime.create({
    ownerEpoch: 7, handlers, journal, surfaces, capabilityLeases, approvals,
    readActiveTaskCredential: options.readActiveTaskCredential,
    resolveBrowserElementSemantics: options.resolver
      ?? (() => createCanonicalElementSemantics({ role: 'button', submit: true })),
  });
  const grant = await submit(runtime, command({
    id: 'grant-review', idempotencyKey: 'grant-review', kind: 'lease.grant', ownerEpoch: 7,
    payload: { requestId: 'request-review', actorId, taskId, ttlMs: options.leaseTtlMs ?? 60_000,
      grants: [{ target: { kind: 'browser_tab', id: tab.id, generation: tab.generation },
        capabilities: ['browser.interact', 'browser.history', 'browser.script'] }] },
  }));
  const lease = (grant as { value: { lease: { id: string; revision: number } } }).value.lease;
  return { runtime, journal, surfaces, capabilityLeases, approvals, tab, lease, actorId, taskId };
}

function browserScriptCommand(
  harness: Awaited<ReturnType<typeof createBrowserActionHarness>>,
  id: string,
  source: string,
) {
  return command({
    id, idempotencyKey: id, kind: 'browser.script', ownerEpoch: 7,
    actor: { id: harness.actorId, kind: 'psyche' }, payload: {
      taskId: harness.taskId, leaseId: harness.lease.id, leaseRevision: harness.lease.revision,
      tabId: harness.tab.id, generation: harness.tab.generation, source,
    },
  }) as unknown as Extract<ControlCommand, { kind: 'browser.script' }>;
}

async function requestReviewApproval(harness: Awaited<ReturnType<typeof createBrowserActionHarness>>) {
  const outcome = await submit(harness.runtime, command({
    id: 'approval-action', idempotencyKey: 'approval-action', kind: 'browser.action', ownerEpoch: 7,
    actor: { id: harness.actorId, kind: 'psyche' }, payload: {
      taskId: harness.taskId, leaseId: harness.lease.id, leaseRevision: harness.lease.revision,
      tabId: harness.tab.id, generation: harness.tab.generation, snapshotId: 'snapshot-review',
      action: { kind: 'submit', elementRef: 'element-review' },
    },
  }));
  return (outcome as { value: { approvalId: string; payloadDigest: string } }).value;
}

describe('ControlRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.sendPrompt = vi.fn();
__TAKE_OURS_VERBATIM__
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
    await expect(submit(runtime, command({ ownerEpoch: 3 })))
      .resolves.toMatchObject({ status: 'rejected', code: 'stale_owner_epoch' });
    expect(handlers.sendInput).not.toHaveBeenCalled();
  });

  it('fails closed for missing agent surface generations before any effect handler', async () => {
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4,
      handlers,
      journal: createMemoryJournal(),
    });

    await expect(submit(runtime, command({
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

  it('stores and journals a redacted terminal receipt for initial validation failure', async () => {
    const journal = createMemoryJournal();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal });
    await expect(submit(runtime, command({
      id: 'missing-resource-action', idempotencyKey: 'missing-resource-action', kind: 'browser.action',
      ownerEpoch: 7, actor: { id: 'agent-1', kind: 'psyche' }, payload: {
        taskId: 'task-1', leaseId: 'missing-secret-lease', leaseRevision: 1,
        tabId: 'missing-tab', generation: 9, action: { kind: 'reload' },
      },
    }))).resolves.toMatchObject({ status: 'failed', code: 'action_validation_failed' });
    expect(runtime.snapshot().receipts).toMatchObject([{
      actionId: 'missing-resource-action', state: 'failed', code: 'action_validation_failed',
    }]);
    const terminal = journal.read().at(-1);
    expect(terminal).toMatchObject({
      kind: 'command.failed',
      payload: {
        commandId: 'missing-resource-action', idempotencyKey: 'missing-resource-action',
        receipt: { actionId: 'missing-resource-action', state: 'failed', code: 'action_validation_failed' },
      },
    });
    expect(JSON.stringify(terminal)).not.toContain('missing-secret-lease');
  });

  it('stamps task-bound validation failures with exact subject ownership and omits unprovable lease metadata', async () => {
    const subject: ControlTaskCredentialReference = {
      taskBinding: { taskId: 'task-review', subjectId: 'subject-review' },
      principalId: 'task-subject:subject-review',
    };
    const harness = await createBrowserActionHarness({
      actorId: subject.principalId,
      taskId: subject.taskBinding.taskId,
      readActiveTaskCredential: async (taskId) => (
        taskId === subject.taskBinding.taskId ? subject : null
      ),
    });
    const renewed = harness.capabilityLeases.grant({
      requestId: 'test-request:grant-review',
      actorId: subject.principalId,
      taskId: subject.taskBinding.taskId,
      grantedBy: 'human-1',
      ttlMs: 60_000,
      grants: [{
        target: { kind: 'browser_tab', id: harness.tab.id, generation: harness.tab.generation },
        capabilities: ['browser.interact', 'browser.history', 'browser.script'],
      }],
    });

    await expect(submit(harness.runtime, command({
      id: 'stale-revision-action',
      idempotencyKey: 'stale-revision-action',
      kind: 'browser.action',
      ownerEpoch: 7,
      actor: { id: subject.principalId, kind: 'psyche' },
      payload: {
        taskId: subject.taskBinding.taskId,
        leaseId: harness.lease.id,
        leaseRevision: harness.lease.revision,
        tabId: harness.tab.id,
        generation: harness.tab.generation,
        action: { kind: 'reload' },
      },
    }) as ControlCommand)).resolves.toMatchObject({ status: 'failed', code: 'action_validation_failed' });
    expect(harness.runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: 'stale-revision-action',
      state: 'failed',
      code: 'action_validation_failed',
      taskId: subject.taskBinding.taskId,
      actorId: subject.principalId,
      leaseId: renewed.id,
      leaseRevision: renewed.revision,
    }));

    await submit(harness.runtime, command({
      id: 'replace-resource',
      idempotencyKey: 'replace-resource',
      kind: 'provider.resource.upsert',
      ownerEpoch: 7,
      actor: { id: 'human-1', kind: 'human' },
      payload: { resource: { ...harness.tab, webviewLabel: 'replacement' } },
    }) as ControlCommand);

    await expect(submit(harness.runtime, command({
      id: 'replaced-generation-action',
      idempotencyKey: 'replaced-generation-action',
      kind: 'browser.action',
      ownerEpoch: 7,
      actor: { id: subject.principalId, kind: 'psyche' },
      payload: {
        taskId: subject.taskBinding.taskId,
        leaseId: renewed.id,
        leaseRevision: renewed.revision,
        tabId: harness.tab.id,
        generation: harness.tab.generation,
        action: { kind: 'reload' },
      },
    }) as ControlCommand)).resolves.toMatchObject({ status: 'failed', code: 'action_validation_failed' });
    const replacedReceipt = harness.runtime.snapshot().receipts.find((receipt) => (
      receipt.actionId === 'replaced-generation-action'
    ));
    expect(replacedReceipt).toMatchObject({
      actionId: 'replaced-generation-action',
      state: 'failed',
      code: 'action_validation_failed',
      taskId: subject.taskBinding.taskId,
      actorId: subject.principalId,
    });
    expect(replacedReceipt).not.toHaveProperty('leaseId');
    expect(replacedReceipt).not.toHaveProperty('leaseRevision');
  });

  it('stores a terminal receipt when an existing resource has no matching lease', async () => {
    const surfaces = new SurfaceRegistry();
    const tab = surfaces.upsertBrowserTab({ id: 'unleased-tab', projectRoot: '/repo', worktreeRoot: '/repo',
      providerId: 'provider', webviewLabel: 'unleased', url: 'https://example.test', title: 'Unleased',
      loading: false, viewport: { width: 800, height: 600 } });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), surfaces });
    await expect(submit(runtime, command({ id: 'missing-lease-action', idempotencyKey: 'missing-lease-action',
      kind: 'browser.action', ownerEpoch: 7, actor: { id: 'agent-1', kind: 'psyche' }, payload: {
        taskId: 'task-1', leaseId: 'missing-lease', leaseRevision: 1, tabId: tab.id,
        generation: tab.generation, action: { kind: 'reload' },
      } }))).resolves.toMatchObject({ status: 'failed', code: 'action_validation_failed' });
    expect(runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: 'missing-lease-action', state: 'failed', code: 'action_validation_failed',
    }));
  });

  it('stores trusted task and lease ownership on authorized receipts and journal metadata', async () => {
    const harness = await createBrowserActionHarness();
    await requestReviewApproval(harness);

    expect(harness.runtime.snapshot().approvals).toEqual([expect.objectContaining({
      actionId: 'approval-action',
      taskId: 'task-review',
      actorId: 'agent-review',
      leaseId: harness.lease.id,
      leaseRevision: harness.lease.revision,
    })]);
    expect(harness.runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: 'approval-action',
      state: 'approval_required',
      taskId: 'task-review',
      actorId: 'agent-review',
      leaseId: harness.lease.id,
      leaseRevision: harness.lease.revision,
    }));
    expect(harness.journal.read()).toContainEqual(expect.objectContaining({
      kind: 'approval.requested',
      payload: expect.objectContaining({
        commandId: 'approval-action',
        taskId: 'task-review',
        actorId: 'agent-review',
        leaseId: harness.lease.id,
        leaseRevision: harness.lease.revision,
      }),
    }));
    expect(harness.journal.read()).toContainEqual(expect.objectContaining({
      kind: 'command.succeeded',
      payload: expect.objectContaining({
        commandId: 'approval-action',
        idempotencyKey: 'approval-action',
        receipt: expect.objectContaining({
          actionId: 'approval-action',
          taskId: 'task-review',
          leaseId: harness.lease.id,
          leaseRevision: harness.lease.revision,
        }),
      }),
    }));
  });

  it('invalidates stale task-subject leases and approvals and lets the replacement subject obtain fresh authority', async () => {
    const originalSubject: ControlTaskCredentialReference = {
      taskBinding: { taskId: 'task-review', subjectId: 'subject-one' },
      principalId: 'task-subject:subject-one',
    };
    let activeSubject: ControlTaskCredentialReference | null = originalSubject;
    const harness = await createBrowserActionHarness({
      actorId: originalSubject.principalId,
      taskId: originalSubject.taskBinding.taskId,
      readActiveTaskCredential: async (taskId) => (
        taskId === originalSubject.taskBinding.taskId ? activeSubject : null
      ),
    });
    const approval = await requestReviewApproval(harness);

    const replacementSubject: ControlTaskCredentialReference = {
      taskBinding: { taskId: 'task-review', subjectId: 'subject-two' },
      principalId: 'task-subject:subject-two',
    };
    activeSubject = replacementSubject;

    await expect(submit(harness.runtime, command({
      id: 'resolve-stale-subject',
      idempotencyKey: 'resolve-stale-subject',
      kind: 'approval.resolve',
      ownerEpoch: 7,
      payload: {
        approvalId: approval.approvalId,
        payloadDigest: approval.payloadDigest,
        decision: 'approve',
      },
    }) as ControlCommand)).resolves.toMatchObject({ status: 'failed', code: 'task_subject_inactive' });
    expect(harness.runtime.snapshot().approvals).toEqual([expect.objectContaining({
      id: approval.approvalId,
      actionId: 'approval-action',
      status: 'revoked',
    })]);
    expect(harness.runtime.snapshot().capabilityLeases).toEqual([]);
    expect(harness.runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: 'approval-action',
      state: 'failed',
      code: 'action_invalidated',
    }));

    await expect(submit(harness.runtime, command({
      id: 'stale-request',
      idempotencyKey: 'stale-request',
      kind: 'lease.request',
      ownerEpoch: 7,
      actor: { id: originalSubject.principalId, kind: 'psyche' },
      payload: {
        taskId: originalSubject.taskBinding.taskId,
        ttlMs: 60_000,
        grants: [{
          target: { kind: 'browser_tab', id: harness.tab.id, generation: harness.tab.generation },
          capabilities: ['browser.interact'],
        }],
      },
    }) as ControlCommand)).resolves.toMatchObject({ status: 'failed', code: 'task_subject_inactive' });

    const replacementRequestId = 'replacement-request';
    await expect(submit(harness.runtime, command({
      id: replacementRequestId,
      idempotencyKey: replacementRequestId,
      kind: 'lease.request',
      ownerEpoch: 7,
      actor: { id: replacementSubject.principalId, kind: 'psyche' },
      payload: {
        taskId: replacementSubject.taskBinding.taskId,
        ttlMs: 60_000,
        grants: [{
          target: { kind: 'browser_tab', id: harness.tab.id, generation: harness.tab.generation },
          capabilities: ['browser.history'],
        }],
      },
    }) as ControlCommand)).resolves.toMatchObject({ status: 'succeeded', value: { requestId: replacementRequestId } });

    const granted = await submit(harness.runtime, command({
      id: 'replacement-grant',
      idempotencyKey: 'replacement-grant',
      kind: 'lease.grant',
      ownerEpoch: 7,
      payload: { requestId: replacementRequestId },
    }) as ControlCommand);
    expect(granted).toMatchObject({ status: 'succeeded' });
    const replacementLease = (granted as { value: { lease: { id: string; revision: number } } }).value.lease;

    await expect(submit(harness.runtime, command({
      id: 'replacement-action',
      idempotencyKey: 'replacement-action',
      kind: 'browser.action',
      ownerEpoch: 7,
      actor: { id: replacementSubject.principalId, kind: 'psyche' },
      payload: {
        taskId: replacementSubject.taskBinding.taskId,
        leaseId: replacementLease.id,
        leaseRevision: replacementLease.revision,
        tabId: harness.tab.id,
        generation: harness.tab.generation,
        action: { kind: 'reload' },
      },
    }) as ControlCommand)).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('invalidates an expired approval during snapshot prune and keeps the terminal receipt stable after subject rotation', async () => {
    let now = new Date('2026-08-12T12:00:00.000Z');
    const originalSubject: ControlTaskCredentialReference = {
      taskBinding: { taskId: 'task-review', subjectId: 'subject-one' },
      principalId: 'task-subject:subject-one',
    };
    let activeSubject: ControlTaskCredentialReference | null = originalSubject;
    const harness = await createBrowserActionHarness({
      actorId: originalSubject.principalId,
      taskId: originalSubject.taskBinding.taskId,
      clock: () => now,
      leaseTtlMs: 60_000,
      readActiveTaskCredential: async (taskId) => (
        taskId === originalSubject.taskBinding.taskId ? activeSubject : null
      ),
    });
    const approval = await requestReviewApproval(harness);

    now = new Date('2026-08-12T12:01:01.000Z');
    const pruned = harness.runtime.snapshot();
    expect(pruned.capabilityLeases).toEqual([]);
    expect(pruned.approvals).toEqual([expect.objectContaining({
      id: approval.approvalId,
      actionId: 'approval-action',
      status: 'revoked',
      taskId: originalSubject.taskBinding.taskId,
      actorId: originalSubject.principalId,
      leaseId: harness.lease.id,
      leaseRevision: harness.lease.revision,
    })]);
    expect(pruned.receipts).toContainEqual(expect.objectContaining({
      actionId: 'approval-action',
      state: 'failed',
      code: 'action_invalidated',
      taskId: originalSubject.taskBinding.taskId,
      actorId: originalSubject.principalId,
      leaseId: harness.lease.id,
      leaseRevision: harness.lease.revision,
    }));
    expect(pruned.receipts).not.toContainEqual(expect.objectContaining({
      actionId: 'approval-action',
      state: 'approval_required',
    }));
    await vi.waitFor(() => expect(harness.journal.read()).toContainEqual(expect.objectContaining({
      kind: 'command.failed',
      payload: expect.objectContaining({
        commandId: 'approval-action',
        idempotencyKey: 'approval-action',
        receipt: expect.objectContaining({
          actionId: 'approval-action',
          code: 'action_invalidated',
          taskId: originalSubject.taskBinding.taskId,
          actorId: originalSubject.principalId,
          leaseId: harness.lease.id,
          leaseRevision: harness.lease.revision,
        }),
      }),
    })));
    const invalidationsAfterPrune = harness.journal.read().filter((event) => (
      event.kind === 'command.failed'
      && (event.payload.receipt as { actionId?: string; code?: string } | undefined)?.actionId === 'approval-action'
      && (event.payload.receipt as { actionId?: string; code?: string } | undefined)?.code === 'action_invalidated'
    ));
    expect(invalidationsAfterPrune).toHaveLength(1);

    activeSubject = {
      taskBinding: { taskId: 'task-review', subjectId: 'subject-two' },
      principalId: 'task-subject:subject-two',
    };
    await expect(submit(harness.runtime, command({
      id: 'post-expiry-stale-request',
      idempotencyKey: 'post-expiry-stale-request',
      kind: 'lease.request',
      ownerEpoch: 7,
      actor: { id: originalSubject.principalId, kind: 'psyche' },
      payload: {
        taskId: originalSubject.taskBinding.taskId,
        ttlMs: 60_000,
        grants: [{
          target: { kind: 'browser_tab', id: harness.tab.id, generation: harness.tab.generation },
          capabilities: ['browser.inspect'],
        }],
      },
    }) as ControlCommand)).resolves.toMatchObject({ status: 'failed', code: 'task_subject_inactive' });

    expect(harness.runtime.snapshot().approvals).toEqual([expect.objectContaining({
      id: approval.approvalId,
      status: 'revoked',
    })]);
    expect(harness.runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: 'approval-action',
      state: 'failed',
      code: 'action_invalidated',
    }));
    const journalCountAfterRotation = harness.journal.read().length;
    const invalidationsAfterRotation = harness.journal.read().filter((event) => (
      event.kind === 'command.failed'
      && (event.payload.receipt as { actionId?: string; code?: string } | undefined)?.actionId === 'approval-action'
      && (event.payload.receipt as { actionId?: string; code?: string } | undefined)?.code === 'action_invalidated'
    ));
    expect(invalidationsAfterRotation).toHaveLength(1);
    const repeatedCleanup = harness.runtime.snapshot();
    expect(repeatedCleanup.receipts).not.toContainEqual(expect.objectContaining({
      actionId: 'approval-action',
      state: 'approval_required',
    }));
    expect(harness.journal.read()).toHaveLength(journalCountAfterRotation);
    expect(handlers.actOnBrowser).not.toHaveBeenCalled();
  });

  it('deduplicates approval invalidation when resolve races expiry cleanup', async () => {
    let now = new Date('2026-08-12T12:00:00.000Z');
    const subject: ControlTaskCredentialReference = {
      taskBinding: { taskId: 'task-review', subjectId: 'subject-one' },
      principalId: 'task-subject:subject-one',
    };
    let gateResolveChecks = false;
    let credentialReads = 0;
    let releaseCredential!: () => void;
    const credentialGate = new Promise<ControlTaskCredentialReference | null>((resolve) => {
      releaseCredential = () => resolve(subject);
    });
    const harness = await createBrowserActionHarness({
      actorId: subject.principalId,
      taskId: subject.taskBinding.taskId,
      clock: () => now,
      leaseTtlMs: 60_000,
      readActiveTaskCredential: async (taskId) => {
        if (taskId !== subject.taskBinding.taskId) return null;
        if (!gateResolveChecks) return subject;
        credentialReads += 1;
        return credentialGate;
      },
    });
    const approval = await requestReviewApproval(harness);

    gateResolveChecks = true;
    const resolvePromise = submit(harness.runtime, command({
      id: 'resolve-expiry-race',
      idempotencyKey: 'resolve-expiry-race',
      kind: 'approval.resolve',
      ownerEpoch: 7,
      payload: {
        approvalId: approval.approvalId,
        payloadDigest: approval.payloadDigest,
        decision: 'approve',
      },
    }) as ControlCommand);
    await vi.waitFor(() => expect(credentialReads).toBeGreaterThan(0));

    now = new Date('2026-08-12T12:01:01.000Z');
    expect(harness.runtime.snapshot().capabilityLeases).toEqual([]);

    releaseCredential();
    await expect(resolvePromise).resolves.toMatchObject({ status: 'failed' });
    await vi.waitFor(() => {
      const invalidations = harness.journal.read().filter((event) => (
        event.kind === 'command.failed'
        && (event.payload.receipt as { actionId?: string; code?: string } | undefined)?.actionId === 'approval-action'
        && (event.payload.receipt as { actionId?: string; code?: string } | undefined)?.code === 'action_invalidated'
      ));
      expect(invalidations).toHaveLength(1);
    });
    expect(harness.runtime.snapshot().approvals).toEqual([expect.objectContaining({
      id: approval.approvalId,
      status: 'revoked',
    })]);
    expect(harness.runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: 'approval-action',
      state: 'failed',
      code: 'action_invalidated',
    }));
    expect(harness.runtime.snapshot().receipts).not.toContainEqual(expect.objectContaining({
      actionId: 'approval-action',
      state: 'approval_required',
    }));
    expect(handlers.actOnBrowser).not.toHaveBeenCalled();
  });

  it('revokes automation before accepting human input', async () => {
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4,
      handlers,
      journal: createMemoryJournal(),
    });
    const delegated = runtime.leases.delegate('%3', 'psyche-1', 'task-1', 60_000);
    await submit(runtime, command());
    await submit(runtime, command({
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
    const outcome = await submit(runtime, command({
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
    expect(await submit(runtime, command({
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
    const queued = submit(runtime, command({
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
    const takeover = submit(runtime, command({
      id: 'cmd-takeover',
      idempotencyKey: 'idem-takeover',
      kind: 'pane.takeover',
    }));
    release();
    await expect(queued).resolves.toMatchObject({ status: 'rejected', code: 'agent_mutation_denied' });
    await expect(takeover).resolves.toMatchObject({ status: 'succeeded' });
    expect(handlers.sendPrompt).not.toHaveBeenCalled();
  });

__TAKE_OURS_VERBATIM__
  });
});
