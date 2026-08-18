import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ControlRuntime, type ControlHandlers } from '../src/control/runtime.js';
import { ApprovalStore } from '../src/control/approvals.js';
import { CapabilityLeaseStore } from '../src/control/capabilityLeases.js';
import type { ControlTaskCredentialReference } from '../src/control/credentials.js';
import { ControlJournal } from '../src/control/journal.js';
import { createCanonicalElementSemantics } from '../src/control/policy.js';
import { SurfaceRegistry } from '../src/control/surfaces.js';
import type { ControlCommand } from '../src/control/types.js';

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

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

function openTerminalCommand(idempotencyKey: string, id = `cmd-${idempotencyKey}`): ControlCommand {
  return command({
    id,
    idempotencyKey,
    kind: 'pane.terminal.open',
    payload: { cwd: '/repo', title: 'durable-idempotency-test' },
  }) as ControlCommand;
}

async function newJournalRoot(prefix: string): Promise<string> {
  const root = path.join(process.cwd(), '.test-artifacts', `${prefix}-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  roots.push(root);
  return root;
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
    handlers.observePane = vi.fn();
    handlers.actOnPane = vi.fn();
    handlers.inspectBrowser = vi.fn();
    handlers.actOnBrowser = vi.fn();
    handlers.runBrowserScript = vi.fn();
  });

  it('returns the prior outcome for a duplicate idempotency key', async () => {
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4,
      handlers,
      journal: createMemoryJournal(),
    });
    const first = await submit(runtime, command());
    const second = await submit(runtime, command({ id: 'cmd-2' }));
    expect(second).toEqual(first);
    expect(runtime.events().filter((event) => event.kind === 'command.requested'))
      .toHaveLength(1);
  });

  it('deduplicates an evicted hot-cache key without changing journal sequence', async () => {
    const root = await newJournalRoot('control-runtime');
    let invocations = 0;
    handlers.openTerminal = vi.fn(async () => ({ paneId: `pane-${++invocations}` }));
    const journal = await ControlJournal.open(root, 4);
    const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers, journal });

    const first = await submit(runtime, openTerminalCommand('idem-old', 'old-1'));
    for (let index = 0; index < 1_001; index += 1) {
      await submit(runtime, openTerminalCommand(`idem-later-${index}`, `later-${index}`));
    }

    const sequenceBefore = journal.sequence;
    const callsBefore = invocations;
    const replayed = await submit(runtime, openTerminalCommand('idem-old', 'old-2'));

    expect(replayed).toEqual(first);
    expect(invocations).toBe(callsBefore);
    expect(journal.sequence).toBe(sequenceBefore);
  }, 90_000);

  it('installs one pending promise before an async cold-miss lookup', async () => {
    const root = await newJournalRoot('control-runtime');
    let invocations = 0;
    handlers.openTerminal = vi.fn(async () => ({ paneId: `pane-${++invocations}` }));
    const journal = await ControlJournal.open(root, 4);
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const loadOutcome = vi.spyOn(journal, 'loadOutcome').mockImplementation(async () => {
      await lookupGate;
      return undefined;
    });
    const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers, journal });

    const first = submit(runtime, openTerminalCommand('idem-race', 'race-1'));
    const second = submit(runtime, openTerminalCommand('idem-race', 'race-2'));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(loadOutcome).toHaveBeenCalledTimes(1);

    releaseLookup();
    const [left, right] = await Promise.all([first, second]);

    expect(left).toEqual(right);
    expect(handlers.openTerminal).toHaveBeenCalledTimes(1);
    expect(journal.read(0).filter((event) => (
      event.kind === 'command.requested' && event.payload.idempotencyKey === 'idem-race'
    ))).toHaveLength(1);
  });

  it('deduplicates from the retained terminal tail when sidecar persistence fails', async () => {
    const root = await newJournalRoot('control-runtime');
    let invocations = 0;
    handlers.openTerminal = vi.fn(async () => ({ paneId: `pane-${++invocations}` }));
    const journal = await ControlJournal.open(root, 4);
    vi.spyOn(journal, 'storeOutcome').mockImplementation(async (idempotencyKey) => {
      if (idempotencyKey === 'idem-sidecar-failure') {
        throw new Error('sidecar write failed');
      }
    });
    const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers, journal });

    await expect(submit(runtime, openTerminalCommand('idem-sidecar-failure', 'sidecar-1')))
      .rejects.toThrow('sidecar write failed');
    expect(handlers.openTerminal).toHaveBeenCalledTimes(1);
    expect(journal.findByIdempotencyKey('idem-sidecar-failure')?.kind).toBe('command.succeeded');

    const sequenceBefore = journal.sequence;
    await expect(submit(runtime, openTerminalCommand('idem-sidecar-failure', 'sidecar-2')))
      .resolves.toEqual({ status: 'succeeded', value: { paneId: 'pane-1' } });
    expect(handlers.openTerminal).toHaveBeenCalledTimes(1);
    expect(journal.sequence).toBe(sequenceBefore);
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

  it('fails closed when an agent targets an unknown surface', async () => {
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
      code: 'action_validation_failed',
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

  it('retains exact task-owned receipts beyond the bounded journal status scan', async () => {
    const harness = await createBrowserActionHarness();
    handlers.actOnBrowser = vi.fn(async () => ({ secret: 'returned-only-to-caller' }));
    await submit(harness.runtime, command({
      id: 'action-alpha', idempotencyKey: 'action-alpha', kind: 'browser.action', ownerEpoch: 7,
      actor: { id: harness.actorId, kind: 'psyche' }, payload: {
        taskId: harness.taskId, leaseId: harness.lease.id, leaseRevision: harness.lease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation, action: { kind: 'reload' },
      },
    }));
    const alphaReceipt = harness.runtime.snapshot().receipts.find(
      (receipt) => receipt.actionId === 'action-alpha',
    );
    expect(alphaReceipt).toBeDefined();

    for (let index = 0; index < 1_001; index += 1) {
      await harness.journal.append('unrelated.event', { index });
    }

    expect(harness.runtime.receiptForTask('action-alpha', harness.taskId)).toEqual(alphaReceipt);
    expect(harness.runtime.receiptForTask('action-alpha', 'task-beta')).toBeUndefined();
    expect(harness.runtime.receiptForTask('missing-action', harness.taskId)).toBeUndefined();
    expect(harness.runtime.receipt('action-alpha')).toEqual(alphaReceipt);
    expect(JSON.stringify(alphaReceipt)).not.toContain('returned-only-to-caller');
  });

  it('refreshes receipt retention order and replaces ownership on action ID collisions', async () => {
    const harness = await createBrowserActionHarness({ taskId: 'task-alpha', actorId: 'agent-alpha' });
    handlers.actOnBrowser = vi.fn(async () => ({ ok: true }));
    const act = async (
      actionId: string,
      idempotencyKey: string,
      actorId = harness.actorId,
      taskId = harness.taskId,
      lease = harness.lease,
    ) => submit(harness.runtime, command({
      id: actionId, idempotencyKey, kind: 'browser.action', ownerEpoch: 7,
      actor: { id: actorId, kind: 'psyche' }, payload: {
        taskId, leaseId: lease.id, leaseRevision: lease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation, action: { kind: 'reload' },
      },
    }));

    await act('action-alpha', 'action-alpha:first');
    for (let index = 1; index < 1_000; index += 1) {
      await act(`action-${index}`, `action-${index}`);
    }
    await act('action-alpha', 'action-alpha:refresh');
    await act('action-newest', 'action-newest');

    expect(harness.runtime.receipt('action-1')).toBeUndefined();
    expect(harness.runtime.receiptForTask('action-alpha', 'task-alpha')).toBeDefined();
    expect(harness.runtime.snapshot().receipts.at(-2)?.actionId).toBe('action-alpha');

    const betaGrant = await submit(harness.runtime, command({
      id: 'grant-beta', idempotencyKey: 'grant-beta', kind: 'lease.grant', ownerEpoch: 7,
      payload: {
        requestId: 'request-beta', actorId: 'agent-beta', taskId: 'task-beta', ttlMs: 60_000,
        grants: [{
          target: { kind: 'browser_tab', id: harness.tab.id, generation: harness.tab.generation },
          capabilities: ['browser.history'],
        }],
      },
    }));
    const betaLease = (betaGrant as { value: { lease: { id: string; revision: number } } }).value.lease;
    await act('action-alpha', 'action-alpha:beta', 'agent-beta', 'task-beta', betaLease);

    expect(harness.runtime.receiptForTask('action-alpha', 'task-alpha')).toBeUndefined();
    expect(harness.runtime.receiptForTask('action-alpha', 'task-beta')).toEqual(
      harness.runtime.receipt('action-alpha'),
    );
    expect(harness.runtime.snapshot().receipts.at(-1)).toEqual(harness.runtime.receipt('action-alpha'));
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

  it('records unknown and never retries an ambiguous prompt', async () => {
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
    expect(await runtime.submit(prompt)).toMatchObject({ status: 'unknown' });
    expect(await runtime.submit({ ...prompt, id: 'cmd-2' })).toMatchObject({ status: 'unknown' });
    expect(handlers.sendPrompt).toHaveBeenCalledTimes(1);
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
    await expect(queued).resolves.toMatchObject({
      status: 'rejected',
      code: 'automation_preempted',
    });
    await expect(takeover).resolves.toMatchObject({ status: 'succeeded' });
    expect(handlers.sendPrompt).not.toHaveBeenCalled();
  });

  it('grants exact surface authority and executes an allowed browser action once', async () => {
    handlers.actOnBrowser = vi.fn(async () => ({ pageText: 'sensitive page text' }));
    const journal = createMemoryJournal();
    const surfaces = new SurfaceRegistry();
    surfaces.upsertBrowserTab({
      id: 'tab-1', projectRoot: '/repo', worktreeRoot: '/repo', providerId: 'provider-1',
      webviewLabel: 'old', url: 'https://example.test', title: 'Example', loading: false,
      viewport: { width: 800, height: 600 },
    });
    surfaces.upsertBrowserTab({
      id: 'tab-1', projectRoot: '/repo', worktreeRoot: '/repo', providerId: 'provider-1',
      webviewLabel: 'current', url: 'https://example.test', title: 'Example', loading: false,
      viewport: { width: 800, height: 600 },
    });
    const capabilityLeases = new CapabilityLeaseStore(() => new Date('2026-08-12T12:00:00.000Z'), 7);
    const approvals = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'), () => 'approval-1');
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal, surfaces, capabilityLeases, approvals,
      resolveBrowserElementSemantics: ({ snapshotId, elementRef }) => {
        expect(snapshotId).toBe('snapshot-1');
        expect(elementRef).toBe('e17');
        return createCanonicalElementSemantics({ role: 'button', submit: false, secret: false });
      },
    });
    const grant = await submit(runtime, command({
      id: 'grant-1', idempotencyKey: 'grant-1', ownerEpoch: 7, kind: 'lease.grant',
      payload: {
        requestId: 'request-1', actorId: 'agent-1', taskId: 'task-1', ttlMs: 60_000,
        grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 2 }, capabilities: ['browser.interact'] }],
      },
    }));
    const lease = (grant as { value: { lease: { id: string; revision: number } } }).value.lease;
    const outcome = await submit(runtime, command({
      id: 'cmd-click', idempotencyKey: 'idem-click', kind: 'browser.action', ownerEpoch: 7,
      actor: { id: 'agent-1', kind: 'psyche' }, createdAt: '2026-08-12T12:00:00.000Z',
      payload: {
        taskId: 'task-1', leaseId: lease.id, leaseRevision: lease.revision,
        tabId: 'tab-1', generation: 2, snapshotId: 'snapshot-1',
        action: { kind: 'click', elementRef: 'e17', semantic: { role: 'button', name: 'Refresh', submit: true } },
      },
    }));
    expect(outcome).toMatchObject({ status: 'succeeded', value: { state: 'succeeded' } });
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(1);
    expect(handlers.actOnBrowser).toHaveBeenCalledWith(expect.objectContaining({
      action: { kind: 'click', elementRef: 'e17' },
    }));
    expect(JSON.stringify(runtime.snapshot())).not.toContain('sensitive page text');
    expect(JSON.stringify(journal.read())).not.toContain('sensitive page text');
  });

  it('returns approval_required without holding the resource queue or invoking the handler', async () => {
    const surfaces = new SurfaceRegistry();
    surfaces.upsertBrowserTab({
      id: 'tab-1', projectRoot: '/repo', worktreeRoot: '/repo', providerId: 'provider-1',
      webviewLabel: 'current', url: 'https://example.test', title: 'Example', loading: false,
      viewport: { width: 800, height: 600 },
    });
    const capabilityLeases = new CapabilityLeaseStore(() => new Date('2026-08-12T12:00:00.000Z'), 7);
    const approvals = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'), () => 'approval-1');
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), surfaces, capabilityLeases, approvals,
      resolveBrowserElementSemantics: () => createCanonicalElementSemantics({ role: 'button', submit: true }),
    });
    const grant = await submit(runtime, command({
      id: 'grant-1', idempotencyKey: 'grant-1', ownerEpoch: 7, kind: 'lease.grant',
      payload: {
        requestId: 'request-1', actorId: 'agent-1', taskId: 'task-1', ttlMs: 60_000,
        grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 }, capabilities: ['browser.interact', 'browser.history'] }],
      },
    }));
    const lease = (grant as { value: { lease: { id: string; revision: number } } }).value.lease;
    const outcome = await submit(runtime, command({
      id: 'cmd-submit', idempotencyKey: 'idem-submit', kind: 'browser.action', ownerEpoch: 7,
      actor: { id: 'agent-1', kind: 'psyche' },
      payload: {
        taskId: 'task-1', leaseId: lease.id, leaseRevision: lease.revision,
        tabId: 'tab-1', generation: 1, snapshotId: 'snapshot-1',
        action: { kind: 'submit', elementRef: 'e17' },
      },
    }));
    expect(outcome).toMatchObject({
      status: 'succeeded', value: { state: 'approval_required', approvalId: 'approval-1' },
    });
    expect(handlers.actOnBrowser).not.toHaveBeenCalled();
    await expect(submit(runtime, command({
      id: 'cmd-reload', idempotencyKey: 'idem-reload', kind: 'browser.action', ownerEpoch: 7,
      actor: { id: 'agent-1', kind: 'psyche' }, payload: {
        taskId: 'task-1', leaseId: lease.id, leaseRevision: lease.revision,
        tabId: 'tab-1', generation: 1, action: { kind: 'reload' },
      },
    }))).resolves.toMatchObject({ status: 'succeeded' });
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(1);
  });

  it('rejects agent authority administration', async () => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    for (const kind of ['lease.grant', 'lease.revoke', 'approval.resolve'] as const) {
      const outcome = await submit(runtime, command({
        id: `cmd-${kind}`, idempotencyKey: `idem-${kind}`, kind, ownerEpoch: 7,
        actor: { id: 'agent-1', kind: 'psyche' }, payload: {},
      }));
      expect(outcome).toMatchObject({ status: 'rejected', code: 'operator_required' });
    }
  });

  it('resolves an approval by revalidating the immutable original action', async () => {
    const surfaces = new SurfaceRegistry();
    surfaces.upsertBrowserTab({
      id: 'tab-1', projectRoot: '/repo', worktreeRoot: '/repo', providerId: 'provider-1',
      webviewLabel: 'current', url: 'https://example.test', title: 'Example', loading: false,
      viewport: { width: 800, height: 600 },
    });
    const capabilityLeases = new CapabilityLeaseStore(() => new Date('2026-08-12T12:00:00.000Z'), 7);
    const approvals = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'), () => 'approval-1');
    const resolver = vi.fn(() => createCanonicalElementSemantics({ role: 'button', submit: true }));
    const journal = createMemoryJournal();
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal, surfaces, capabilityLeases, approvals,
      resolveBrowserElementSemantics: resolver,
    });
    const grant = await submit(runtime, command({
      id: 'grant-1', idempotencyKey: 'grant-1', ownerEpoch: 7, kind: 'lease.grant',
      payload: {
        requestId: 'request-1', actorId: 'agent-1', taskId: 'task-1', ttlMs: 60_000,
        grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 }, capabilities: ['browser.interact'] }],
      },
    }));
    const lease = (grant as { value: { lease: { id: string; revision: number } } }).value.lease;
    const original = command({
      id: 'cmd-submit', idempotencyKey: 'idem-submit', kind: 'browser.action', ownerEpoch: 7,
      actor: { id: 'agent-1', kind: 'psyche' },
      payload: {
        taskId: 'task-1', leaseId: lease.id, leaseRevision: lease.revision,
        tabId: 'tab-1', generation: 1, snapshotId: 'snapshot-1',
        action: { kind: 'submit', elementRef: 'e17' },
      },
    });
    const requested = await runtime.submit(original);
    const approval = (requested as { value: { approvalId: string; payloadDigest: string } }).value;
    ((original as unknown as { payload: { action: { elementRef: string } } }).payload.action).elementRef = 'attacker-ref';
    await expect(submit(runtime, command({
      id: 'resolve-bad', idempotencyKey: 'resolve-bad', kind: 'approval.resolve', ownerEpoch: 7,
      payload: { approvalId: approval.approvalId, payloadDigest: '0'.repeat(64), decision: 'approve' },
    }))).resolves.toMatchObject({ status: 'failed', code: 'approval_digest_mismatch' });
    await expect(submit(runtime, command({
      id: 'resolve-good', idempotencyKey: 'resolve-good', kind: 'approval.resolve', ownerEpoch: 7,
      payload: { approvalId: approval.approvalId, payloadDigest: approval.payloadDigest, decision: 'approve' },
    }))).resolves.toMatchObject({ status: 'succeeded', value: { state: 'succeeded' } });
    await expect(runtime.submit(original)).resolves.toMatchObject({
      status: 'succeeded', value: { state: 'succeeded' },
    });
    const recovered = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal,
      surfaces, capabilityLeases, approvals });
    await expect(recovered.submit(original)).resolves.toEqual({ status: 'succeeded' });
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(1);
    expect(handlers.actOnBrowser).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({ elementRef: 'e17' }),
    }));
  });

  it('records an ambiguous browser effect as unknown and never retries it', async () => {
    handlers.actOnBrowser = vi.fn(async () => {
      throw Object.assign(new Error('provider acknowledgement timed out'), {
        code: 'action_timeout', ambiguous: true,
      });
    });
    const surfaces = new SurfaceRegistry();
    surfaces.upsertBrowserTab({
      id: 'tab-1', projectRoot: '/repo', worktreeRoot: '/repo', providerId: 'provider-1',
      webviewLabel: 'current', url: 'https://example.test', title: 'Example', loading: false,
      viewport: { width: 800, height: 600 },
    });
    const capabilityLeases = new CapabilityLeaseStore(() => new Date('2026-08-12T12:00:00.000Z'), 7);
    const journal = createMemoryJournal();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, surfaces, capabilityLeases });
    const grant = await submit(runtime, command({
      id: 'grant-1', idempotencyKey: 'grant-1', ownerEpoch: 7, kind: 'lease.grant',
      payload: { requestId: 'r', actorId: 'agent-1', taskId: 'task-1', ttlMs: 60_000,
        grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 }, capabilities: ['browser.history'] }] },
    }));
    const lease = (grant as { value: { lease: { id: string; revision: number } } }).value.lease;
    const action = command({ id: 'reload', idempotencyKey: 'reload', kind: 'browser.action', ownerEpoch: 7,
      actor: { id: 'agent-1', kind: 'psyche' }, payload: { taskId: 'task-1', leaseId: lease.id,
        leaseRevision: lease.revision, tabId: 'tab-1', generation: 1, action: { kind: 'reload' } } });
    await expect(runtime.submit(action)).resolves.toMatchObject({ status: 'unknown', code: 'effect_unknown' });
    await expect(runtime.submit({ ...action, id: 'reload-again' })).resolves.toMatchObject({ status: 'unknown' });
    const restarted = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, surfaces, capabilityLeases });
    await expect(restarted.submit({ ...action, id: 'reload-after-restart' }))
      .resolves.toMatchObject({ status: 'unknown', code: 'effect_unknown' });
    expect(handlers.actOnBrowser).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['failed', false, 'backend_unavailable'],
    ['unknown', true, 'effect_unknown'],
  ] as const)('finalizes approved original action after %s backend result', async (state, ambiguous, expectedCode) => {
    const harness = await createBrowserActionHarness({
      actOnBrowser: vi.fn(async () => {
        throw Object.assign(new Error('sensitive backend detail'), { code: 'backend_unavailable', ambiguous });
      }),
    });
    const action = command({ id: `final-${state}`, idempotencyKey: `final-${state}`,
      kind: 'browser.action', ownerEpoch: 7, actor: { id: 'agent-review', kind: 'psyche' }, payload: {
        taskId: 'task-review', leaseId: harness.lease.id, leaseRevision: harness.lease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation,
        action: { kind: 'permission_response', permission: 'camera', origin: 'https://example.test', decision: 'allow' },
      } }) as unknown as Extract<ControlCommand, { kind: 'browser.action' }>;
    const requested = await harness.runtime.submit(action);
    const approval = (requested as { value: { approvalId: string; payloadDigest: string } }).value;
    await submit(harness.runtime, command({ id: `resolve-${state}`, idempotencyKey: `resolve-${state}`,
      kind: 'approval.resolve', ownerEpoch: 7, payload: { approvalId: approval.approvalId,
        payloadDigest: approval.payloadDigest, decision: 'approve' } }));
    await expect(harness.runtime.submit(action)).resolves.toMatchObject({
      status: state, code: expectedCode,
    });
    expect(harness.journal.read().filter((event) => event.payload.commandId === action.id).at(-1))
      .toMatchObject({ kind: ambiguous ? 'command.unknown' : 'command.failed' });
    expect(JSON.stringify(harness.journal.read())).not.toContain('sensitive backend detail');
  });

  it('finalizes denied original action identity', async () => {
    const harness = await createBrowserActionHarness();
    const action = command({ id: 'denied-original', idempotencyKey: 'denied-original',
      kind: 'browser.script', ownerEpoch: 7, actor: { id: 'agent-review', kind: 'psyche' }, payload: {
        taskId: 'task-review', leaseId: harness.lease.id, leaseRevision: harness.lease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation, source: 'return deniedSecret',
      } }) as unknown as Extract<ControlCommand, { kind: 'browser.script' }>;
    const requested = await harness.runtime.submit(action);
    const approval = (requested as { value: { approvalId: string; payloadDigest: string } }).value;
    await submit(harness.runtime, command({ id: 'deny-original', idempotencyKey: 'deny-original',
      kind: 'approval.resolve', ownerEpoch: 7, payload: { approvalId: approval.approvalId,
        payloadDigest: approval.payloadDigest, decision: 'deny' } }));
    await expect(harness.runtime.submit(action)).resolves.toMatchObject({
      status: 'failed', code: 'approval_denied',
    });
    expect(JSON.stringify(harness.journal.read())).not.toContain('deniedSecret');
  });

  it('rejects oversized browser scripts before approval or effect dispatch', async () => {
    const harness = await createBrowserActionHarness();
    const action = command({ id: 'oversized-script', idempotencyKey: 'oversized-script',
      kind: 'browser.script', ownerEpoch: 7, actor: { id: 'agent-review', kind: 'psyche' }, payload: {
        taskId: 'task-review', leaseId: harness.lease.id, leaseRevision: harness.lease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation, source: 'x'.repeat(64 * 1024 + 1),
      } }) as unknown as Extract<ControlCommand, { kind: 'browser.script' }>;

    await expect(harness.runtime.submit(action)).resolves.toMatchObject({
      status: 'failed', code: 'script_source_too_large',
    });
    expect(harness.runtime.snapshot().approvals).toHaveLength(0);
    expect(handlers.runBrowserScript).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.runtime.snapshot())).not.toContain('x'.repeat(1_024));
  });

  it('binds each browser script approval to its source digest and stores only bounded metadata', async () => {
    handlers.runBrowserScript = vi.fn(async () => ({
      value: { secretResult: 'returned-only-to-caller' }, resultBytes: 42, durationMs: 7,
    }));
    const harness = await createBrowserActionHarness();
    const makeAction = (id: string, source: string) => command({ id, idempotencyKey: id,
      kind: 'browser.script', ownerEpoch: 7, actor: { id: 'agent-review', kind: 'psyche' }, payload: {
        taskId: 'task-review', leaseId: harness.lease.id, leaseRevision: harness.lease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation, source,
      } }) as unknown as Extract<ControlCommand, { kind: 'browser.script' }>;
    const first = makeAction('script-one', 'return firstSecret;');
    const second = makeAction('script-two', 'return secondSecret;');
    const requested = await harness.runtime.submit(first);
    const firstApproval = (requested as { value: { approvalId: string; payloadDigest: string } }).value;
    const secondApproval = ((await harness.runtime.submit(second)) as {
      value: { approvalId: string; payloadDigest: string };
    }).value;
    expect(secondApproval.approvalId).not.toBe(firstApproval.approvalId);
    expect(secondApproval.payloadDigest).not.toBe(firstApproval.payloadDigest);
    expect(JSON.stringify(harness.runtime.snapshot())).not.toContain('firstSecret');
    expect(JSON.stringify(harness.journal.read())).not.toContain('firstSecret');

    await submit(harness.runtime, command({ id: 'approve-script', idempotencyKey: 'approve-script',
      kind: 'approval.resolve', ownerEpoch: 7, payload: { approvalId: firstApproval.approvalId,
        payloadDigest: firstApproval.payloadDigest, decision: 'approve' } }));
    const completed = await harness.runtime.submit(first);
    expect(completed).toMatchObject({ status: 'succeeded', value: {
      value: { secretResult: 'returned-only-to-caller' }, sourceBytes: 19, resultBytes: 42, durationMs: 7,
    } });
    const stored = harness.runtime.snapshot().receipts.find((receipt) => receipt.actionId === first.id);
    expect(stored).toMatchObject({ sourceBytes: 19, resultBytes: 42, durationMs: 7 });
    expect(stored).not.toHaveProperty('value');
    expect(JSON.stringify(harness.journal.read())).not.toContain('returned-only-to-caller');
    expect(handlers.runBrowserScript).toHaveBeenCalledOnce();
  });

  it('records a document-changing browser script as unknown without retrying or retaining source and result data', async () => {
    handlers.runBrowserScript = vi.fn(async () => {
      throw Object.assign(new Error('script-source-secret result-secret'), {
        code: 'effect_unknown', ambiguous: true, invalidate: true,
      });
    });
    const harness = await createBrowserActionHarness();
    const action = command({ id: 'script-document-change', idempotencyKey: 'script-document-change',
      kind: 'browser.script', ownerEpoch: 7, actor: { id: 'agent-review', kind: 'psyche' }, payload: {
        taskId: 'task-review', leaseId: harness.lease.id, leaseRevision: harness.lease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation,
        source: 'history.pushState({}, "", "/secret-source"); return "result-secret";',
      } }) as unknown as Extract<ControlCommand, { kind: 'browser.script' }>;
    const requested = await harness.runtime.submit(action);
    const approval = (requested as { value: { approvalId: string; payloadDigest: string } }).value;
    await submit(harness.runtime, command({ id: 'approve-document-change', idempotencyKey: 'approve-document-change',
      kind: 'approval.resolve', ownerEpoch: 7, payload: { approvalId: approval.approvalId,
        payloadDigest: approval.payloadDigest, decision: 'approve' } }));

    await expect(harness.runtime.submit(action)).resolves.toMatchObject({ status: 'unknown', code: 'effect_unknown' });
    await expect(harness.runtime.submit({ ...action, id: 'script-document-change-again' }))
      .resolves.toMatchObject({ status: 'unknown', code: 'effect_unknown' });
    expect(handlers.runBrowserScript).toHaveBeenCalledOnce();
    const durable = JSON.stringify({ snapshot: harness.runtime.snapshot(), journal: harness.journal.read() });
    expect(durable).not.toContain('secret-source');
    expect(durable).not.toContain('result-secret');
  });

  it.each([
    'args_too_large',
    'snapshot_too_large',
    'mutation_plan_invalid',
    'mutation_target_stale',
    'mutation_not_allowed',
    'target_unavailable',
  ])('preserves the stable browser script failure code %s', async (code) => {
    handlers.runBrowserScript = vi.fn(async () => {
      throw Object.assign(new Error(`${code}: secret`), { code });
    });
    const harness = await createBrowserActionHarness();
    const id = `stable-script-code-${code}`;
    const action = command({ id, idempotencyKey: id, kind: 'browser.script', ownerEpoch: 7,
      actor: { id: 'agent-review', kind: 'psyche' }, payload: {
        taskId: 'task-review', leaseId: harness.lease.id, leaseRevision: harness.lease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation, source: 'return null;',
      } }) as unknown as Extract<ControlCommand, { kind: 'browser.script' }>;
    const requested = await harness.runtime.submit(action);
    const approval = (requested as { value: { approvalId: string; payloadDigest: string } }).value;

    await submit(harness.runtime, command({
      id: `${id}-approve`,
      idempotencyKey: `${id}-approve`,
      kind: 'approval.resolve',
      ownerEpoch: 7,
      payload: {
        approvalId: approval.approvalId,
        payloadDigest: approval.payloadDigest,
        decision: 'approve',
      },
    }));

    await expect(harness.runtime.submit(action)).resolves.toMatchObject({
      status: 'failed',
      code,
    });
    expect(JSON.stringify(harness.journal.read())).not.toContain('secret');
  });

  it.each([
    ['forged byte count', 'serialization_failed', () => ({ value: { leaked: 'result-secret' }, resultBytes: 0, durationMs: 1 })],
    ['oversized value', 'result_too_large', () => ({ value: 'x'.repeat(256 * 1024 + 1), resultBytes: 0, durationMs: 1 })],
    ['cyclic value', 'serialization_failed', () => { const value: Record<string, unknown> = { leaked: 'result-secret' }; value.self = value; return { value, resultBytes: 0, durationMs: 1 }; }],
    ['function value', 'serialization_failed', () => ({ value: { leaked: () => 'result-secret' }, resultBytes: 0, durationMs: 1 })],
    ['native value', 'serialization_failed', () => ({ value: new Date(), resultBytes: 0, durationMs: 1 })],
    ['unknown envelope keys', 'serialization_failed', () => ({ value: null, resultBytes: 4, durationMs: 1, injected: 'result-secret' })],
    ['excessive duration', 'serialization_failed', () => ({ value: null, resultBytes: 4, durationMs: 5_001 })],
  ])('rejects an untrusted browser script result with %s without retaining it', async (_kind, expectedCode, result) => {
    handlers.runBrowserScript = vi.fn(async () => result());
    const harness = await createBrowserActionHarness();
    const id = `invalid-script-result-${_kind.replaceAll(' ', '-')}`;
    const action = command({ id, idempotencyKey: id, kind: 'browser.script', ownerEpoch: 7,
      actor: { id: 'agent-review', kind: 'psyche' }, payload: {
        taskId: 'task-review', leaseId: harness.lease.id, leaseRevision: harness.lease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation, source: 'return "result-secret";',
      } }) as unknown as Extract<ControlCommand, { kind: 'browser.script' }>;
    const requested = await harness.runtime.submit(action);
    const approval = (requested as { value: { approvalId: string; payloadDigest: string } }).value;
    await expect(submit(harness.runtime, command({ id: `${id}-approve`, idempotencyKey: `${id}-approve`,
      kind: 'approval.resolve', ownerEpoch: 7, payload: { approvalId: approval.approvalId,
        payloadDigest: approval.payloadDigest, decision: 'approve' } })))
      .resolves.toMatchObject({ status: 'failed', code: expectedCode });
    await expect(harness.runtime.submit(action)).resolves.toMatchObject({ status: 'failed', code: expectedCode });
    expect(handlers.runBrowserScript).toHaveBeenCalledOnce();
    const durable = JSON.stringify({ snapshot: harness.runtime.snapshot(), journal: harness.journal.read() });
    expect(durable).not.toContain('result-secret');
    expect(durable).not.toContain('"injected"');
    expect(durable).not.toContain('x'.repeat(1_024));
  });

  it.each([
    ['function', () => ({ callback: () => true })],
    ['native object', () => ({ when: new Date() })],
    ['cycle', () => { const value: Record<string, unknown> = {}; value.self = value; return value; }],
    ['oversized', () => ({ text: 'x'.repeat(256 * 1024 + 1) })],
  ])('rejects %s browser script arguments before approval and dispatch', async (_kind, args) => {
    const harness = await createBrowserActionHarness();
    const id = `invalid-script-args-${_kind.replaceAll(' ', '-')}`;
    const action = command({ id, idempotencyKey: id, kind: 'browser.script', ownerEpoch: 7,
      actor: { id: 'agent-review', kind: 'psyche' }, payload: {
        taskId: 'task-review', leaseId: harness.lease.id, leaseRevision: harness.lease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation, source: 'return args;', args: args(),
      } }) as unknown as Extract<ControlCommand, { kind: 'browser.script' }>;
    await expect(harness.runtime.submit(action)).resolves.toMatchObject({ status: 'failed' });
    expect(harness.runtime.snapshot().approvals).toHaveLength(0);
    expect(handlers.runBrowserScript).not.toHaveBeenCalled();
  });

  it('marks timed out browser scripts unknown without retrying them', async () => {
    vi.useFakeTimers();
    try {
      const runBrowserScript = vi.fn(() => new Promise<never>(() => undefined));
      const harness = await createBrowserActionHarness({ runBrowserScript });
      const action = browserScriptCommand(harness, 'script-timeout', 'return pending;');
      const requested = await harness.runtime.submit(action);
      const approval = (requested as { value: { approvalId: string; payloadDigest: string } }).value;
      const resolution = harness.runtime.submit(command({
        id: 'script-timeout-resolve', idempotencyKey: 'script-timeout-resolve',
        kind: 'approval.resolve', ownerEpoch: 7, payload: {
          approvalId: approval.approvalId, payloadDigest: approval.payloadDigest, decision: 'approve',
        },
      }));

      await vi.advanceTimersByTimeAsync(0);
      expect(runBrowserScript).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(resolution).resolves.toMatchObject({ status: 'unknown', code: 'effect_unknown' });

      const grant = await submit(harness.runtime, command({
        id: 'grant-after-timeout', idempotencyKey: 'grant-after-timeout', kind: 'lease.grant', ownerEpoch: 7,
        payload: { requestId: 'request-after-timeout', actorId: 'agent-review', taskId: 'task-review', ttlMs: 60_000,
          grants: [{ target: { kind: 'browser_tab', id: harness.tab.id, generation: harness.tab.generation },
            capabilities: ['browser.inspect'] }] },
      }));
      const lease = (grant as { value: { lease: { id: string; revision: number } } }).value.lease;
      await expect(harness.runtime.submit(command({
        id: 'inspect-after-timeout', idempotencyKey: 'inspect-after-timeout',
        kind: 'browser.inspect', ownerEpoch: 7, actor: { id: 'agent-review', kind: 'psyche' }, payload: {
          taskId: 'task-review', leaseId: lease.id, leaseRevision: lease.revision,
          tabId: harness.tab.id, generation: harness.tab.generation,
        },
      }))).resolves.toMatchObject({ status: 'unknown', code: 'effect_unknown' });
      expect(handlers.inspectBrowser).not.toHaveBeenCalled();

      expect((harness.runtime as unknown as {
        resourceQueues: Map<string, unknown>;
      }).resourceQueues.size).toBe(1);
      harness.surfaces.upsertBrowserTab({
        id: harness.tab.id, projectRoot: harness.tab.projectRoot, worktreeRoot: harness.tab.worktreeRoot,
        providerId: 'replacement-provider', webviewLabel: 'replacement', url: harness.tab.url,
        title: harness.tab.title, loading: harness.tab.loading, viewport: harness.tab.viewport,
      });
      await harness.runtime.submit(command({
        id: 'prune-stale-quarantine', idempotencyKey: 'prune-stale-quarantine',
        kind: 'orchestration.execute', ownerEpoch: 7, payload: { request: {} },
      }));
      expect((harness.runtime as unknown as {
        resourceQueues: Map<string, unknown>;
      }).resourceQueues.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds pending commands before retaining another unresolved execution', async () => {
    handlers.executeOrchestration = vi.fn(() => new Promise<never>(() => undefined));
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    for (let index = 0; index < 256; index += 1) {
      void runtime.submit(command({
        id: `pending-${index}`, idempotencyKey: `pending-${index}`,
        kind: 'orchestration.execute', ownerEpoch: 7, payload: { request: {} },
      }));
    }

    await expect(runtime.submit(command({
      id: 'pending-overflow', idempotencyKey: 'pending-overflow',
      kind: 'orchestration.execute', ownerEpoch: 7, payload: { request: {} },
    }))).resolves.toMatchObject({ status: 'rejected', code: 'runtime_busy' });
  });

  it('bounds queued effects per resource and recovers capacity after draining', async () => {
    const harness = await createBrowserActionHarness();
    const grant = await submit(harness.runtime, command({
      id: 'grant-inspection', idempotencyKey: 'grant-inspection', kind: 'lease.grant', ownerEpoch: 7,
      payload: { requestId: 'request-inspection', actorId: 'agent-review', taskId: 'task-review', ttlMs: 60_000,
        grants: [{ target: { kind: 'browser_tab', id: harness.tab.id, generation: harness.tab.generation },
          capabilities: ['browser.inspect'] }] },
    }));
    const inspectionLease = (grant as { value: { lease: { id: string; revision: number } } }).value.lease;
    const release = harness.runtime.blockResourceQueue({
      kind: 'browser_tab', id: harness.tab.id, generation: harness.tab.generation,
    });
    const actions = Array.from({ length: 64 }, (_, index) =>
      harness.runtime.submit(command({
        id: `inspect-${index}`, idempotencyKey: `inspect-${index}`,
        kind: 'browser.inspect', ownerEpoch: 7, actor: { id: 'agent-review', kind: 'psyche' }, payload: {
          taskId: 'task-review', leaseId: inspectionLease.id, leaseRevision: inspectionLease.revision,
          tabId: harness.tab.id, generation: harness.tab.generation,
        },
      })),
    );
    const overflow = harness.runtime.submit(command({
      id: 'inspect-overflow', idempotencyKey: 'inspect-overflow',
      kind: 'browser.inspect', ownerEpoch: 7, actor: { id: 'agent-review', kind: 'psyche' }, payload: {
        taskId: 'task-review', leaseId: inspectionLease.id, leaseRevision: inspectionLease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation,
      },
    }));

    await expect(overflow).resolves.toMatchObject({ status: 'failed', code: 'queue_full' });
    release();
    await expect(Promise.all(actions)).resolves.toHaveLength(64);
    await expect(harness.runtime.submit(command({
      id: 'inspect-after-drain', idempotencyKey: 'inspect-after-drain',
      kind: 'browser.inspect', ownerEpoch: 7, actor: { id: 'agent-review', kind: 'psyche' }, payload: {
        taskId: 'task-review', leaseId: inspectionLease.id, leaseRevision: inspectionLease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation,
      },
    }))).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('rejects grants for missing generations and non-canonical project targets', async () => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    await expect(submit(runtime, command({
      id: 'bad-surface', idempotencyKey: 'bad-surface', kind: 'lease.grant', ownerEpoch: 7,
      payload: { requestId: 'r1', actorId: 'a', taskId: 't', ttlMs: 1,
        grants: [{ target: { kind: 'pane', id: 'missing', generation: 9 }, capabilities: ['pane.input'] }] },
    }))).resolves.toMatchObject({ status: 'failed', code: 'resource_missing' });
    await expect(submit(runtime, command({
      id: 'bad-project', idempotencyKey: 'bad-project', kind: 'lease.grant', ownerEpoch: 7,
      payload: { requestId: 'r2', actorId: 'a', taskId: 't', ttlMs: 1,
        grants: [{ target: { kind: 'project', id: '/other' }, capabilities: ['pane.create'] }] },
    }))).resolves.toMatchObject({ status: 'failed', code: 'capability_denied' });
  });

  it('grants only an exact pending request once', async () => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    await expect(submit(runtime, command({
      id: 'missing-grant', idempotencyKey: 'missing-grant', kind: 'lease.grant', ownerEpoch: 7,
      payload: { requestId: 'missing-request' },
    }) as ControlCommand)).resolves.toMatchObject({ status: 'failed', code: 'lease_request_missing' });

    await expect(submit(runtime, command({
      id: 'request-exact', idempotencyKey: 'request-exact', kind: 'lease.request', ownerEpoch: 7,
      actor: { id: 'agent-exact', kind: 'psyche' }, payload: {
        taskId: 'task-exact', ttlMs: 60_000,
        grants: [{ target: { kind: 'project', id: '/repo' }, capabilities: ['pane.create'] }],
      },
    }) as ControlCommand)).resolves.toMatchObject({ status: 'succeeded' });

    const granted = await runtime.submit(command({
      id: 'grant-exact', idempotencyKey: 'grant-exact', kind: 'lease.grant', ownerEpoch: 7,
      payload: {
        requestId: 'request-exact', actorId: 'attacker', taskId: 'forged', ttlMs: 999_999,
        grants: [{ target: { kind: 'project', id: '/other' }, capabilities: ['pane.create'] }],
      },
    }) as ControlCommand);
    expect(granted).toMatchObject({ status: 'succeeded', value: { lease: {
      actorId: 'agent-exact', taskId: 'task-exact',
      grants: [{ target: { kind: 'project', id: '/repo' }, capabilities: ['pane.create'] }],
    } } });
    await expect(submit(runtime, command({
      id: 'grant-exact-again', idempotencyKey: 'grant-exact-again', kind: 'lease.grant', ownerEpoch: 7,
      payload: { requestId: 'request-exact' },
    }) as ControlCommand)).resolves.toMatchObject({ status: 'failed', code: 'lease_request_consumed' });
    expect(runtime.snapshot().capabilityLeases).toHaveLength(1);
  });

  it('rejects hidden lease authority beyond the operator display bounds', async () => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    const grants = Array.from({ length: 33 }, (_, index) => ({
      target: index < 32
        ? { kind: 'project' as const, id: '/repo' }
        : { kind: 'project' as const, id: '/dangerous-overflow' },
      capabilities: ['pane.create' as const],
    }));
    await expect(submit(runtime, command({
      id: 'oversized-request', idempotencyKey: 'oversized-request', kind: 'lease.request', ownerEpoch: 7,
      actor: { id: 'agent-bounded', kind: 'psyche' },
      payload: { taskId: 'task-bounded', ttlMs: 60_000, grants },
    }) as ControlCommand)).resolves.toMatchObject({ status: 'failed', code: 'lease_request_too_large' });
    expect(runtime.snapshot().leaseRequests).toEqual([]);
    await expect(runtime.submit(command({
      id: 'oversized-grant', idempotencyKey: 'oversized-grant', kind: 'lease.grant', ownerEpoch: 7,
      payload: { requestId: 'oversized-request' },
    }) as ControlCommand)).resolves.toMatchObject({ status: 'failed', code: 'lease_request_missing' });
    expect(runtime.snapshot().capabilityLeases).toEqual([]);
  });

  it.each([
    ['capability count', {
      taskId: 'task-bounded',
      grants: [{
        target: { kind: 'project' as const, id: '/repo' },
        capabilities: Array.from({ length: 13 }, () => 'pane.create' as const),
      }],
    }],
    ['request text', {
      taskId: 't'.repeat(129),
      grants: [{
        target: { kind: 'project' as const, id: '/repo' },
        capabilities: ['pane.create' as const],
      }],
    }],
    ['capability text', {
      taskId: 'task-bounded',
      grants: [{
        target: { kind: 'project' as const, id: '/repo' },
        capabilities: [`pane.${'x'.repeat(65)}` as 'pane.create'],
      }],
    }],
  ])('rejects a lease request beyond the %s bound', async (_case, payload) => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    await expect(runtime.submit(command({
      id: `bounded-${_case}`, idempotencyKey: `bounded-${_case}`, kind: 'lease.request', ownerEpoch: 7,
      actor: { id: 'agent-bounded', kind: 'psyche' },
      payload: { ttlMs: 60_000, ...payload },
    }) as ControlCommand)).resolves.toMatchObject({ status: 'failed', code: 'lease_request_too_large' });
    expect(runtime.snapshot().leaseRequests).toEqual([]);
  });

  it('never replaces an existing lease request ID under a new idempotency key', async () => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    const original = command({
      id: 'immutable-request', idempotencyKey: 'immutable-request-v1', kind: 'lease.request', ownerEpoch: 7,
      actor: { id: 'agent-original', kind: 'psyche' }, payload: {
        taskId: 'task-original', ttlMs: 60_000,
        grants: [{ target: { kind: 'project', id: '/repo' }, capabilities: ['pane.create'] }],
      },
    }) as ControlCommand;
    const first = await runtime.submit(original);
    expect(first).toMatchObject({ status: 'succeeded' });
    await expect(runtime.submit(original)).resolves.toEqual(first);
    await expect(runtime.submit({
      ...original,
      idempotencyKey: 'immutable-request-v2',
      payload: {
        taskId: 'task-widened', ttlMs: 60_000,
        grants: [{ target: { kind: 'project', id: '/other' }, capabilities: ['pane.create'] }],
      },
    } as ControlCommand)).resolves.toMatchObject({ status: 'failed', code: 'lease_request_conflict' });
    expect(runtime.snapshot().leaseRequests).toMatchObject([{
      id: 'immutable-request', actorId: 'agent-original', taskId: 'task-original', status: 'pending',
      grants: [{ target: { kind: 'project', id: '/repo' }, capabilities: ['pane.create'] }],
    }]);

    const granted = await runtime.submit(command({
      id: 'immutable-grant', idempotencyKey: 'immutable-grant', kind: 'lease.grant', ownerEpoch: 7,
      payload: { requestId: 'immutable-request' },
    }) as ControlCommand);
    expect(granted).toMatchObject({ status: 'succeeded', value: { lease: {
      actorId: 'agent-original', taskId: 'task-original',
      grants: [{ target: { kind: 'project', id: '/repo' }, capabilities: ['pane.create'] }],
    } } });
    await expect(runtime.submit({
      ...original,
      idempotencyKey: 'immutable-request-after-grant',
    })).resolves.toMatchObject({ status: 'failed', code: 'lease_request_conflict' });
  });

  it('bounds live pending requests while retaining recent collision identities', async () => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    const request = (id: string, taskId = `task-${id}`) => command({
      id, idempotencyKey: `idem-${id}`, kind: 'lease.request', ownerEpoch: 7,
      actor: { id: `agent-${id}`, kind: 'psyche' }, payload: {
        taskId, ttlMs: 60_000,
        grants: [{ target: { kind: 'project', id: '/repo' }, capabilities: ['pane.create'] }],
      },
    }) as ControlCommand;
    const retained = request('retained');
    const retainedOutcome = await runtime.submit(retained);
    for (let index = 1; index < 100; index += 1) {
      await runtime.submit(request(`request-${index}`));
    }

    await expect(runtime.submit(request('request-101')))
      .resolves.toMatchObject({ status: 'failed', code: 'lease_request_capacity' });
    await expect(runtime.submit(retained)).resolves.toEqual(retainedOutcome);
    await expect(runtime.submit({
      ...retained,
      idempotencyKey: 'retained-widened',
      payload: {
        taskId: 'task-widened', ttlMs: 60_000,
        grants: [{ target: { kind: 'project', id: '/other' }, capabilities: ['pane.create'] }],
      },
    } as ControlCommand)).resolves.toMatchObject({ status: 'failed', code: 'lease_request_conflict' });

    const beforeGrant = runtime.snapshot();
    expect(beforeGrant.leaseRequests).toHaveLength(100);
    expect(beforeGrant.leaseRequests).toContainEqual(expect.objectContaining({
      id: 'retained', taskId: 'task-retained', status: 'pending',
    }));
    expect(beforeGrant.leaseRequests).toContainEqual(expect.objectContaining({
      id: 'request-99', status: 'pending',
    }));
    await expect(runtime.submit(command({
      id: 'grant-retained', idempotencyKey: 'grant-retained', kind: 'lease.grant', ownerEpoch: 7,
      payload: { requestId: 'retained' },
    }) as ControlCommand)).resolves.toMatchObject({ status: 'succeeded' });
    expect(runtime.snapshot()).toMatchObject({
      leaseRequests: expect.not.arrayContaining([expect.objectContaining({ id: 'retained' })]),
      capabilityLeases: [expect.objectContaining({ requestId: 'retained', actorId: 'agent-retained' })],
    });
    await expect(runtime.submit(request('request-102')))
      .resolves.toMatchObject({ status: 'succeeded' });
    expect(runtime.snapshot().leaseRequests).toHaveLength(100);
    await expect(runtime.submit({
      ...retained,
      idempotencyKey: 'retained-after-terminal',
    })).resolves.toMatchObject({ status: 'failed', code: 'lease_request_conflict' });
  });

  it('requires a project pane-create lease before orchestration execution', async () => {
    handlers.executeOrchestration = vi.fn(async () => ({ ok: true }));
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    const request = { taskId: 'task-orchestration', projectRoot: '/repo', prompt: 'test',
      lanes: [{ id: 'one', mode: 'terminal' as const }] };
    await expect(submit(runtime, command({ id: 'unleased-orchestration', idempotencyKey: 'unleased-orchestration',
      kind: 'orchestration.execute', ownerEpoch: 7, actor: { id: 'agent-1', kind: 'psyche' },
      payload: { request, taskId: request.taskId, leaseId: 'missing', leaseRevision: 1 } })))
      .resolves.toMatchObject({ status: 'failed', code: 'lease_missing' });
    expect(handlers.executeOrchestration).not.toHaveBeenCalled();

    const granted = await submit(runtime, command({ id: 'grant-orchestration', idempotencyKey: 'grant-orchestration',
      kind: 'lease.grant', ownerEpoch: 7, payload: { requestId: 'request-orchestration', actorId: 'agent-1',
        taskId: request.taskId, ttlMs: 60_000,
        grants: [{ target: { kind: 'project', id: '/repo' }, capabilities: ['pane.create'] }] } }));
    const lease = (granted as { value: { lease: { id: string; revision: number } } }).value.lease;
    await expect(submit(runtime, command({ id: 'leased-orchestration', idempotencyKey: 'leased-orchestration',
      kind: 'orchestration.execute', ownerEpoch: 7, actor: { id: 'agent-1', kind: 'psyche' },
      payload: { request, taskId: request.taskId, leaseId: lease.id, leaseRevision: lease.revision } })))
      .resolves.toMatchObject({ status: 'succeeded' });
    expect(handlers.executeOrchestration).toHaveBeenCalledOnce();
  });

  it('revalidates lease expiry before an approved effect', async () => {
    let now = new Date('2026-08-12T12:00:00.000Z');
    const clock = () => now;
    const surfaces = new SurfaceRegistry();
    surfaces.upsertBrowserTab({ id: 'tab-1', projectRoot: '/repo', worktreeRoot: '/repo', providerId: 'p',
      webviewLabel: 'w', url: 'https://example.test', title: 'Example', loading: false,
      viewport: { width: 800, height: 600 } });
    const capabilityLeases = new CapabilityLeaseStore(clock, 7);
    const approvals = new ApprovalStore(clock, () => 'approval-expiry');
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(),
      surfaces, capabilityLeases, approvals,
      resolveBrowserElementSemantics: () => createCanonicalElementSemantics({ role: 'button', submit: true }) });
    const grant = await submit(runtime, command({ id: 'g', idempotencyKey: 'g', kind: 'lease.grant', ownerEpoch: 7,
      payload: { requestId: 'r', actorId: 'agent-1', taskId: 'task-1', ttlMs: 60_000,
        grants: [{ target: { kind: 'browser_tab', id: 'tab-1', generation: 1 }, capabilities: ['browser.interact'] }] } }));
    const lease = (grant as { value: { lease: { id: string; revision: number } } }).value.lease;
    const requested = await submit(runtime, command({ id: 'a', idempotencyKey: 'a', kind: 'browser.action', ownerEpoch: 7,
      actor: { id: 'agent-1', kind: 'psyche' }, payload: { taskId: 'task-1', leaseId: lease.id,
        leaseRevision: lease.revision, tabId: 'tab-1', generation: 1, snapshotId: 's',
        action: { kind: 'submit', elementRef: 'e' } } }));
    const approval = (requested as { value: { approvalId: string; payloadDigest: string } }).value;
    now = new Date('2026-08-12T12:01:01.000Z');
    await expect(submit(runtime, command({ id: 'resolve', idempotencyKey: 'resolve', kind: 'approval.resolve', ownerEpoch: 7,
      payload: { approvalId: approval.approvalId, payloadDigest: approval.payloadDigest, decision: 'approve' } })))
      .resolves.toMatchObject({ status: 'failed', code: 'lease_expired' });
    expect(handlers.actOnBrowser).not.toHaveBeenCalled();
  });

  it('revokes matching authority on provider removal, pane takeover, and owner restart', async () => {
    const surfaces = new SurfaceRegistry();
    const tab = surfaces.upsertBrowserTab({ id: 'tab-1', projectRoot: '/repo', worktreeRoot: '/repo', providerId: 'p',
      webviewLabel: 'w', url: 'https://example.test', title: 'Example', loading: false,
      viewport: { width: 800, height: 600 } });
    const pane = surfaces.upsertPane({ id: 'pane-1', projectRoot: '/repo', worktreeRoot: '/repo', tmuxPaneId: '%1',
      writable: true, outputSequence: 0 });
    const capabilityLeases = new CapabilityLeaseStore(() => new Date('2026-08-12T12:00:00.000Z'), 7);
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), surfaces, capabilityLeases });
    for (const [requestId, target, capabilities] of [
      ['tab-r', { kind: 'browser_tab', id: tab.id, generation: tab.generation }, ['browser.history']],
      ['pane-r', { kind: 'pane', id: pane.id, generation: pane.generation }, ['pane.input']],
    ] as const) {
      await submit(runtime, command({ id: requestId, idempotencyKey: requestId, kind: 'lease.grant', ownerEpoch: 7,
        payload: { requestId, actorId: 'agent-1', taskId: 'task-1', ttlMs: 60_000, grants: [{ target, capabilities }] } }));
    }
    await submit(runtime, command({ id: 'remove', idempotencyKey: 'remove', kind: 'provider.resource.remove', ownerEpoch: 7,
      payload: { id: tab.id, generation: tab.generation } }));
    expect(runtime.snapshot().capabilityLeases).toHaveLength(1);
    await submit(runtime, command({ id: 'takeover', idempotencyKey: 'takeover', kind: 'pane.takeover', ownerEpoch: 7,
      payload: { paneId: pane.id } }));
    expect(runtime.snapshot().capabilityLeases).toHaveLength(0);

    capabilityLeases.grant({ requestId: 'old-owner', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator',
      ttlMs: 60_000, grants: [{ target: { kind: 'project', id: '/repo' }, capabilities: ['pane.create'] }] });
    const restarted = await ControlRuntime.create({ ownerEpoch: 8, handlers, journal: createMemoryJournal(),
      capabilityLeases });
    expect(restarted.snapshot().capabilityLeases).toHaveLength(0);
  });

  it('removes only the exact provider resource named by a remove frame', async () => {
    const surfaces = new SurfaceRegistry();
    const first = surfaces.upsertBrowserTab({ id: 'tab-1', projectRoot: '/repo', worktreeRoot: '/repo',
      providerId: 'desktop-1', webviewLabel: 'one', url: 'https://one.test', title: 'One', loading: false,
      viewport: { width: 800, height: 600 } });
    const second = surfaces.upsertBrowserTab({ id: 'tab-2', projectRoot: '/repo', worktreeRoot: '/repo',
      providerId: 'desktop-1', webviewLabel: 'two', url: 'https://two.test', title: 'Two', loading: false,
      viewport: { width: 800, height: 600 } });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(), surfaces });

    await submit(runtime, command({ id: 'remove-one', idempotencyKey: 'remove-one',
      kind: 'provider.resource.remove', ownerEpoch: 7,
      payload: { id: first.id, generation: first.generation } }));

    expect(runtime.surfaces.get(first.id)).toBeUndefined();
    expect(runtime.surfaces.get(second.id)).toEqual(second);
  });

  it('uses blockPaneQueue as an alias for the current pane resource queue', async () => {
    const surfaces = new SurfaceRegistry();
    const pane = surfaces.upsertPane({ id: 'pane-shared', projectRoot: '/repo', worktreeRoot: '/repo',
      tmuxPaneId: '%9', writable: true, outputSequence: 0 });
    const capabilityLeases = new CapabilityLeaseStore(() => new Date('2026-08-12T12:00:00.000Z'), 7);
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(),
      surfaces, capabilityLeases });
    const grant = await submit(runtime, command({ id: 'grant-pane', idempotencyKey: 'grant-pane',
      kind: 'lease.grant', ownerEpoch: 7, payload: { requestId: 'pane-request', actorId: 'agent-1',
        taskId: 'task-1', ttlMs: 60_000, grants: [{ target: { kind: 'pane', id: pane.id,
          generation: pane.generation }, capabilities: ['pane.input'] }] } }));
    const lease = (grant as { value: { lease: { id: string; revision: number } } }).value.lease;
    const release = runtime.blockPaneQueue(pane.id);
    const pending = submit(runtime, command({ id: 'pane-action', idempotencyKey: 'pane-action',
      kind: 'pane.action', ownerEpoch: 7, actor: { id: 'agent-1', kind: 'psyche' }, payload: {
        taskId: 'task-1', leaseId: lease.id, leaseRevision: lease.revision, paneId: pane.id,
        generation: pane.generation, action: { kind: 'send_text', text: 'status' },
      } }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(handlers.actOnPane).not.toHaveBeenCalled();
    release();
    await expect(pending).resolves.toMatchObject({ status: 'succeeded' });
    expect(handlers.actOnPane).toHaveBeenCalledTimes(1);
  });

  it('serializes legacy pane commands and pane.action on one resource queue', async () => {
    let releaseResize!: () => void;
    handlers.resizePane = vi.fn(() => new Promise<void>((resolve) => { releaseResize = resolve; }));
    const surfaces = new SurfaceRegistry();
    const pane = surfaces.upsertPane({ id: 'pane-serialized', projectRoot: '/repo', worktreeRoot: '/repo',
      tmuxPaneId: '%10', writable: true, outputSequence: 0 });
    const capabilityLeases = new CapabilityLeaseStore(() => new Date('2026-08-12T12:00:00.000Z'), 7);
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal(),
      surfaces, capabilityLeases });
    const grant = await submit(runtime, command({ id: 'grant-serialized', idempotencyKey: 'grant-serialized',
      kind: 'lease.grant', ownerEpoch: 7, payload: { requestId: 'serialized-request', actorId: 'agent-1',
        taskId: 'task-1', ttlMs: 60_000, grants: [{ target: { kind: 'pane', id: pane.id,
          generation: pane.generation }, capabilities: ['pane.input'] }] } }));
    const lease = (grant as { value: { lease: { id: string; revision: number } } }).value.lease;
    const legacy = submit(runtime, command({ id: 'legacy-resize', idempotencyKey: 'legacy-resize',
      kind: 'pane.resize', ownerEpoch: 7, payload: { paneId: pane.id, cols: 100, rows: 30 } }));
    await vi.waitFor(() => expect(handlers.resizePane).toHaveBeenCalledTimes(1));
    const surface = submit(runtime, command({ id: 'surface-input', idempotencyKey: 'surface-input',
      kind: 'pane.action', ownerEpoch: 7, actor: { id: 'agent-1', kind: 'psyche' }, payload: {
        taskId: 'task-1', leaseId: lease.id, leaseRevision: lease.revision, paneId: pane.id,
        generation: pane.generation, action: { kind: 'send_text', text: 'after resize' },
      } }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(handlers.actOnPane).not.toHaveBeenCalled();
    releaseResize();
    await expect(legacy).resolves.toMatchObject({ status: 'succeeded' });
    await expect(surface).resolves.toMatchObject({ status: 'succeeded' });
    expect(handlers.actOnPane).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(
      (runtime as unknown as { resourceQueues: Map<string, unknown> }).resourceQueues.size,
    ).toBe(0));
  });

  it('journals a bounded redacted receipt for failed surface effects', async () => {
    const actOnBrowser = vi.fn(async () => {
      throw Object.assign(new Error('password=do-not-persist'), { code: 'secret-backend-code' });
    });
    const { runtime, journal, tab, lease } = await createBrowserActionHarness({ actOnBrowser });
    await expect(submit(runtime, command({ id: 'failed-effect', idempotencyKey: 'failed-effect',
      kind: 'browser.action', ownerEpoch: 7, actor: { id: 'agent-review', kind: 'psyche' }, payload: {
        taskId: 'task-review', leaseId: lease.id, leaseRevision: lease.revision, tabId: tab.id,
        generation: tab.generation, action: { kind: 'reload' },
      } }))).resolves.toMatchObject({ status: 'failed', code: 'effect_failed' });
    const serialized = JSON.stringify(journal.read());
    expect(serialized).not.toContain('password=do-not-persist');
    expect(serialized).not.toContain('secret-backend-code');
    expect(journal.read().at(-1)?.payload).toMatchObject({
      receipt: { actionId: 'failed-effect', state: 'failed', code: 'effect_failed' },
    });
  });

  it('rejects future owner epochs before administrative mutation', async () => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    const administrative = [
      command({ id: 'future-grant', idempotencyKey: 'future-grant', kind: 'lease.grant', ownerEpoch: 8,
        payload: { requestId: 'future', actorId: 'agent-1', taskId: 'task-1', ttlMs: 60_000,
          grants: [{ target: { kind: 'project', id: '/repo' }, capabilities: ['pane.create'] }] } }),
      command({ id: 'future-revoke', idempotencyKey: 'future-revoke', kind: 'lease.revoke', ownerEpoch: 8,
        payload: { leaseId: 'lease-missing' } }),
      command({ id: 'future-resolve', idempotencyKey: 'future-resolve', kind: 'approval.resolve', ownerEpoch: 8,
        payload: { approvalId: 'approval-missing', payloadDigest: 'a'.repeat(64), decision: 'approve' } }),
      command({ id: 'future-upsert', idempotencyKey: 'future-upsert', kind: 'provider.resource.upsert', ownerEpoch: 8,
        payload: { resource: { id: 'future-tab', kind: 'browser_tab', generation: 1, projectRoot: '/repo',
          worktreeRoot: '/repo', providerId: 'provider', webviewLabel: 'future', url: 'https://example.test',
          title: 'Future', loading: false, viewport: { width: 800, height: 600 } } } }),
      command({ id: 'future-remove', idempotencyKey: 'future-remove', kind: 'provider.resource.remove', ownerEpoch: 8,
        payload: { id: 'future-tab', generation: 1 } }),
    ];
    for (const administrativeCommand of administrative) {
      await expect(runtime.submit(administrativeCommand))
        .resolves.toMatchObject({ status: 'rejected', code: 'stale_owner_epoch' });
    }
    expect(runtime.snapshot().capabilityLeases).toHaveLength(0);
    expect(runtime.snapshot().resources).toHaveLength(0);
  });

  it('rejects an agent lease renewal without changing the revision', async () => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    const payload = { requestId: 'renewal', actorId: 'agent-1', taskId: 'task-1', ttlMs: 60_000,
      grants: [{ target: { kind: 'project' as const, id: '/repo' }, capabilities: ['pane.create' as const] }] };
    await submit(runtime, command({ id: 'initial-grant', idempotencyKey: 'initial-grant',
      kind: 'lease.grant', ownerEpoch: 7, payload }));
    await expect(submit(runtime, command({ id: 'agent-renewal', idempotencyKey: 'agent-renewal',
      kind: 'lease.grant', ownerEpoch: 7, actor: { id: 'agent-1', kind: 'psyche' }, payload })))
      .resolves.toMatchObject({ status: 'rejected', code: 'operator_required' });
    expect(runtime.snapshot().capabilityLeases).toMatchObject([{ revision: 1 }]);
  });

  it('fails approval resumption after a lease revision changes', async () => {
    const harness = await createBrowserActionHarness();
    const approval = await requestReviewApproval(harness);
    harness.capabilityLeases.grant({
      requestId: 'test-request:grant-review', actorId: 'agent-review', taskId: 'task-review',
      grantedBy: 'human-1', ttlMs: 60_000,
      grants: [{ target: { kind: 'browser_tab', id: harness.tab.id, generation: harness.tab.generation },
        capabilities: ['browser.interact', 'browser.history', 'browser.script'] }],
    });
    await expect(submit(harness.runtime, command({ id: 'resolve-revision', idempotencyKey: 'resolve-revision',
      kind: 'approval.resolve', ownerEpoch: 7, payload: { approvalId: approval.approvalId,
        payloadDigest: approval.payloadDigest, decision: 'approve' } })))
      .resolves.toMatchObject({ status: 'failed', code: 'lease_revision_mismatch' });
    expect(harness.runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: 'approval-action', state: 'failed', code: 'action_invalidated',
    }));
    expect(harness.runtime.snapshot().receipts).not.toContainEqual(expect.objectContaining({
      actionId: 'approval-action', state: 'approval_required',
    }));
    expect(harness.journal.read()).toContainEqual(expect.objectContaining({
      kind: 'command.failed', payload: expect.objectContaining({
        commandId: 'approval-action', idempotencyKey: 'approval-action',
        receipt: expect.objectContaining({ actionId: 'approval-action', code: 'action_invalidated' }),
      }),
    }));
    expect(handlers.actOnBrowser).not.toHaveBeenCalled();
  });

  it('replaces approval_required immediately when its lease is revoked', async () => {
    const harness = await createBrowserActionHarness();
    await requestReviewApproval(harness);
    await submit(harness.runtime, command({ id: 'revoke-review', idempotencyKey: 'revoke-review',
      kind: 'lease.revoke', ownerEpoch: 7, payload: { leaseId: harness.lease.id } }));
    expect(harness.runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: 'approval-action', state: 'failed', code: 'action_invalidated',
    }));
    expect(harness.journal.read()).toContainEqual(expect.objectContaining({
      kind: 'command.failed', payload: expect.objectContaining({
        commandId: 'approval-action', idempotencyKey: 'approval-action',
        receipt: expect.objectContaining({ code: 'action_invalidated' }),
      }),
    }));
  });

  it('terminalizes passive approval expiry during snapshot polling', async () => {
    let now = new Date('2026-08-12T12:00:00.000Z');
    const clock = () => now;
    const journal = createMemoryJournal();
    const surfaces = new SurfaceRegistry();
    const tab = surfaces.upsertBrowserTab({ id: 'expiry-tab', projectRoot: '/repo', worktreeRoot: '/repo',
      providerId: 'provider', webviewLabel: 'expiry', url: 'https://example.test', title: 'Expiry',
      loading: false, viewport: { width: 800, height: 600 } });
    const capabilityLeases = new CapabilityLeaseStore(clock, 7);
    const approvals = new ApprovalStore(clock, () => 'passive-expiry');
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, surfaces,
      capabilityLeases, approvals });
    const grant = await submit(runtime, command({ id: 'expiry-grant', idempotencyKey: 'expiry-grant',
      kind: 'lease.grant', ownerEpoch: 7, payload: { requestId: 'expiry-request', actorId: 'agent-expiry',
        taskId: 'task-expiry', ttlMs: 10 * 60_000, grants: [{ target: { kind: 'browser_tab', id: tab.id,
          generation: tab.generation }, capabilities: ['browser.script'] }] } }));
    const lease = (grant as { value: { lease: { id: string; revision: number } } }).value.lease;
    await submit(runtime, command({ id: 'expiring-action', idempotencyKey: 'expiring-action',
      kind: 'browser.script', ownerEpoch: 7, actor: { id: 'agent-expiry', kind: 'psyche' }, payload: {
        taskId: 'task-expiry', leaseId: lease.id, leaseRevision: lease.revision, tabId: tab.id,
        generation: tab.generation, source: 'return window.localStorage.secretToken',
      } }));
    expect(runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: 'expiring-action', state: 'approval_required',
    }));
    now = new Date('2026-08-12T12:05:01.000Z');
    const snapshot = runtime.snapshot();
    expect(snapshot.receipts).toContainEqual(expect.objectContaining({
      actionId: 'expiring-action', state: 'failed', code: 'approval_expired',
    }));
    await vi.waitFor(() => expect(journal.read()).toContainEqual(expect.objectContaining({
      kind: 'command.failed', payload: expect.objectContaining({
        commandId: 'expiring-action', idempotencyKey: 'expiring-action',
        receipt: expect.objectContaining({ actionId: 'expiring-action', code: 'approval_expired' }),
      }),
    })));
    expect(JSON.stringify(snapshot)).not.toContain('secretToken');
    expect(JSON.stringify(journal.read())).not.toContain('secretToken');
    expect(handlers.runBrowserScript).not.toHaveBeenCalled();
    await expect(submit(runtime, command({ id: 'late-resolve', idempotencyKey: 'late-resolve',
      kind: 'approval.resolve', ownerEpoch: 7, payload: { approvalId: 'passive-expiry',
        payloadDigest: 'a'.repeat(64), decision: 'approve' } })))
      .resolves.toMatchObject({ status: 'failed' });
    expect(runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: 'expiring-action', state: 'failed', code: 'approval_expired',
    }));
  });

  it('terminalizes expired approval A when approval-requiring B arrives without polling', async () => {
    let now = new Date('2026-08-12T12:00:00.000Z');
    let approvalId = 0;
    const clock = () => now;
    const journal = createMemoryJournal();
    const surfaces = new SurfaceRegistry();
    const tab = surfaces.upsertBrowserTab({ id: 'rolling-expiry-tab', projectRoot: '/repo',
      worktreeRoot: '/repo', providerId: 'provider', webviewLabel: 'rolling',
      url: 'https://example.test', title: 'Rolling', loading: false,
      viewport: { width: 800, height: 600 } });
    const capabilityLeases = new CapabilityLeaseStore(clock, 7);
    const approvals = new ApprovalStore(clock, () => `rolling-approval-${++approvalId}`);
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal, surfaces,
      capabilityLeases, approvals });
    const grant = await submit(runtime, command({ id: 'rolling-grant', idempotencyKey: 'rolling-grant',
      kind: 'lease.grant', ownerEpoch: 7, payload: { requestId: 'rolling-request', actorId: 'rolling-agent',
        taskId: 'rolling-task', ttlMs: 10 * 60_000, grants: [{ target: { kind: 'browser_tab', id: tab.id,
          generation: tab.generation }, capabilities: ['browser.script'] }] } }));
    const lease = (grant as { value: { lease: { id: string; revision: number } } }).value.lease;
    const scriptAction = (id: string, source: string) => command({ id, idempotencyKey: id,
      kind: 'browser.script', ownerEpoch: 7, actor: { id: 'rolling-agent', kind: 'psyche' }, payload: {
        taskId: 'rolling-task', leaseId: lease.id, leaseRevision: lease.revision, tabId: tab.id,
        generation: tab.generation, source,
      } });
    await expect(runtime.submit(scriptAction('rolling-a', 'return secretA')))
      .resolves.toMatchObject({ status: 'succeeded', value: { state: 'approval_required' } });
    now = new Date('2026-08-12T12:05:01.000Z');
    await expect(runtime.submit(scriptAction('rolling-b', 'return secretB')))
      .resolves.toMatchObject({ status: 'succeeded', value: { state: 'approval_required' } });
    expect(runtime.snapshot().receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: 'rolling-a', state: 'failed', code: 'approval_expired' }),
      expect.objectContaining({ actionId: 'rolling-b', state: 'approval_required' }),
    ]));
    await vi.waitFor(() => expect(journal.read()).toContainEqual(expect.objectContaining({
      kind: 'command.failed', payload: expect.objectContaining({
        commandId: 'rolling-a', idempotencyKey: 'rolling-a',
        receipt: expect.objectContaining({ actionId: 'rolling-a', code: 'approval_expired' }),
      }),
    })));
    expect(JSON.stringify(runtime.snapshot())).not.toContain('secretA');
    expect(JSON.stringify(journal.read())).not.toContain('secretA');
    expect(JSON.stringify(journal.read())).not.toContain('secretB');
    expect(handlers.runBrowserScript).not.toHaveBeenCalled();
  });

  it('rejects approval substitution while retaining only payload hashes', async () => {
    const harness = await createBrowserActionHarness();
    const first = command({ id: 'substitution-action', idempotencyKey: 'substitution-first',
      kind: 'browser.script', ownerEpoch: 7, actor: { id: 'agent-review', kind: 'psyche' }, payload: {
        taskId: 'task-review', leaseId: harness.lease.id, leaseRevision: harness.lease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation, source: 'return secretAlpha',
      } }) as unknown as Extract<ControlCommand, { kind: 'browser.script' }>;
    await expect(harness.runtime.submit(first))
      .resolves.toMatchObject({ status: 'succeeded', value: { state: 'approval_required' } });
    await expect(harness.runtime.submit({ ...first, idempotencyKey: 'substitution-second',
      payload: { ...first.payload, source: 'return secretBeta' } }))
      .resolves.toMatchObject({ status: 'failed', code: 'approval_action_conflict' });
    expect(harness.runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: 'substitution-action', state: 'approval_required',
    }));
    expect(harness.runtime.snapshot().approvals).toHaveLength(1);
    const serialized = JSON.stringify(harness.runtime.snapshot());
    expect(serialized).not.toContain('secretAlpha');
    expect(serialized).not.toContain('secretBeta');
    expect(serialized).toContain('executablePayloadDigest');
  });

  it.each([
    ['secret text',
      { kind: 'type', elementRef: 'secret-field', text: 'alpha' },
      { kind: 'type', elementRef: 'secret-field', text: 'beta' }],
    ['same-basename upload',
      { kind: 'upload', elementRef: 'upload', path: '/first/same.txt' },
      { kind: 'upload', elementRef: 'upload', path: '/second/same.txt' }],
    ['permission decision',
      { kind: 'permission_response', permission: 'camera', origin: 'https://example.test', decision: 'allow' },
      { kind: 'permission_response', permission: 'camera', origin: 'https://example.test', decision: 'deny' }],
  ] as const)('binds approval to complete canonical %s payload', async (_label, firstAction, secondAction) => {
    const harness = await createBrowserActionHarness({
      resolver: () => createCanonicalElementSemantics({ role: 'textbox', submit: false, secret: true }),
    });
    const action = command({ id: 'canonical-substitution', idempotencyKey: 'canonical-first',
      kind: 'browser.action', ownerEpoch: 7, actor: { id: 'agent-review', kind: 'psyche' }, payload: {
        taskId: 'task-review', leaseId: harness.lease.id, leaseRevision: harness.lease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation,
        ...('elementRef' in firstAction ? { snapshotId: 'snapshot-review' } : {}), action: firstAction,
      } }) as unknown as Extract<ControlCommand, { kind: 'browser.action' }>;
    await expect(harness.runtime.submit(action))
      .resolves.toMatchObject({ status: 'succeeded', value: { state: 'approval_required' } });
    const substituted = { ...action, idempotencyKey: 'canonical-second', payload: {
      ...action.payload,
      ...('elementRef' in secondAction ? { snapshotId: 'snapshot-review' } : {}),
      action: secondAction,
    } } as unknown as Extract<ControlCommand, { kind: 'browser.action' }>;
    await expect(harness.runtime.submit(substituted))
      .resolves.toMatchObject({ status: 'failed', code: 'approval_action_conflict' });
    expect(harness.runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: 'canonical-substitution', state: 'approval_required',
    }));
    expect(handlers.actOnBrowser).not.toHaveBeenCalled();
  });

  it('exposes distinct sanitized permission decisions in approval snapshot and journal', async () => {
    const harness = await createBrowserActionHarness();
    const permission = (id: string, decision: 'allow' | 'deny') => command({ id, idempotencyKey: id,
      kind: 'browser.action', ownerEpoch: 7, actor: { id: 'agent-review', kind: 'psyche' }, payload: {
        taskId: 'task-review', leaseId: harness.lease.id, leaseRevision: harness.lease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation,
        action: { kind: 'permission_response', permission: 'camera',
          origin: 'https://user:pass@example.test/path?token=secret#fragment', decision },
      } });
    await harness.runtime.submit(permission('allow-permission', 'allow'));
    await harness.runtime.submit(permission('deny-permission', 'deny'));
    const approvals = harness.runtime.snapshot().approvals;
    expect(approvals.map((approval) => approval.effect.target)).toEqual([
      'allow camera for https://example.test/path',
      'deny camera for https://example.test/path',
    ]);
    expect(approvals[0].payloadDigest).not.toBe(approvals[1].payloadDigest);
    const serialized = JSON.stringify(harness.journal.read());
    expect(serialized).toContain('allow camera for https://example.test/path');
    expect(serialized).toContain('deny camera for https://example.test/path');
    expect(serialized).not.toContain('user:pass');
    expect(serialized).not.toContain('token=secret');
    expect(serialized).not.toContain('#fragment');
  });

  it.each([
    'camera token=runtimeSecret',
    'camera\nruntimeSecret',
    'camera\u0000runtimeSecret',
    'x'.repeat(65),
  ])('does not leak unsafe permission label through snapshot or journal', async (permissionLabel) => {
    const harness = await createBrowserActionHarness();
    await submit(harness.runtime, command({ id: `unsafe-${permissionLabel.length}`,
      idempotencyKey: `unsafe-${permissionLabel.length}-${permissionLabel.charCodeAt(0)}`,
      kind: 'browser.action', ownerEpoch: 7, actor: { id: 'agent-review', kind: 'psyche' }, payload: {
        taskId: 'task-review', leaseId: harness.lease.id, leaseRevision: harness.lease.revision,
        tabId: harness.tab.id, generation: harness.tab.generation,
        action: { kind: 'permission_response', permission: permissionLabel,
          origin: 'https://example.test', decision: 'allow' },
      } }));
    expect(harness.runtime.snapshot().approvals[0]?.effect.target).toBe('[redacted]');
    expect(JSON.stringify(harness.runtime.snapshot())).not.toContain(permissionLabel);
    expect(JSON.stringify(harness.journal.read())).not.toContain(permissionLabel);
  });

  it('revokes old authority when provider upsert replaces a browser binding', async () => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    const resource = { id: 'replace-tab', kind: 'browser_tab' as const, generation: 1,
      projectRoot: '/repo', worktreeRoot: '/repo', providerId: 'provider', webviewLabel: 'first',
      url: 'https://example.test', title: 'Replace', loading: false,
      viewport: { width: 800, height: 600 } };
    await submit(runtime, command({ id: 'upsert-first', idempotencyKey: 'upsert-first',
      kind: 'provider.resource.upsert', ownerEpoch: 7, payload: { resource } }));
    const grant = await submit(runtime, command({ id: 'replace-grant', idempotencyKey: 'replace-grant',
      kind: 'lease.grant', ownerEpoch: 7, payload: { requestId: 'replace-request', actorId: 'replace-agent',
        taskId: 'replace-task', ttlMs: 60_000, grants: [{ target: { kind: 'browser_tab', id: resource.id,
          generation: 1 }, capabilities: ['browser.script'] }] } }));
    const lease = (grant as { value: { lease: { id: string; revision: number } } }).value.lease;
    await submit(runtime, command({ id: 'replace-action', idempotencyKey: 'replace-action',
      kind: 'browser.script', ownerEpoch: 7, actor: { id: 'replace-agent', kind: 'psyche' }, payload: {
        taskId: 'replace-task', leaseId: lease.id, leaseRevision: lease.revision, tabId: resource.id,
        generation: 1, source: 'return replacementSecret',
      } }));
    await submit(runtime, command({ id: 'upsert-replacement', idempotencyKey: 'upsert-replacement',
      kind: 'provider.resource.upsert', ownerEpoch: 7,
      payload: { resource: { ...resource, webviewLabel: 'second' } } }));
    expect(runtime.snapshot().capabilityLeases).toHaveLength(0);
    expect(runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: 'replace-action', state: 'failed', code: 'action_invalidated',
    }));
    expect(JSON.stringify(runtime.snapshot())).not.toContain('replacementSecret');
  });

  it.each([
    [{ projectRoot: '/other', worktreeRoot: '/other' }, 'cross-project'],
    [{ projectRoot: '/repo', worktreeRoot: '/outside' }, 'cross-worktree'],
  ])('rejects provider registration outside owner scope: %s', async (scope, label) => {
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers, journal: createMemoryJournal() });
    await expect(submit(runtime, command({ id: label, idempotencyKey: label,
      kind: 'provider.resource.upsert', ownerEpoch: 7, payload: { resource: {
        id: label, kind: 'browser_tab', generation: 1, ...scope, providerId: 'provider',
        webviewLabel: label, url: 'https://example.test', title: label, loading: false,
        viewport: { width: 800, height: 600 },
      } } }))).resolves.toMatchObject({ status: 'failed', code: 'resource_scope_mismatch' });
    expect(runtime.snapshot().resources).toHaveLength(0);
  });

  it('fails approval resumption after the resource generation changes', async () => {
    const harness = await createBrowserActionHarness();
    const approval = await requestReviewApproval(harness);
    harness.surfaces.upsertBrowserTab({ ...harness.tab, webviewLabel: 'replacement' });
    await expect(submit(harness.runtime, command({ id: 'resolve-generation', idempotencyKey: 'resolve-generation',
      kind: 'approval.resolve', ownerEpoch: 7, payload: { approvalId: approval.approvalId,
        payloadDigest: approval.payloadDigest, decision: 'approve' } })))
      .resolves.toMatchObject({ status: 'failed', code: 'resource_replaced' });
    expect(harness.runtime.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: 'approval-action', state: 'failed', code: 'action_invalidated',
    }));
    expect(harness.journal.read()).toContainEqual(expect.objectContaining({
      kind: 'command.failed', payload: expect.objectContaining({
        commandId: 'approval-action', receipt: expect.objectContaining({ code: 'action_invalidated' }),
      }),
    }));
    expect(handlers.actOnBrowser).not.toHaveBeenCalled();
  });

  it.each([
    ['snapshot identity', 'snapshot_replaced'],
    ['element reference', 'element_ref_missing'],
  ])('fails approval resumption after the %s changes', async (_label, code) => {
    let activeSnapshot = 'snapshot-review';
    let activeElement = 'element-review';
    const harness = await createBrowserActionHarness({
      resolver: (input) => {
        if (input.snapshotId !== activeSnapshot || input.elementRef !== activeElement) {
          throw Object.assign(new Error('semantic identity changed'), { code });
        }
        return createCanonicalElementSemantics({ role: 'button', submit: true });
      },
    });
    const approval = await requestReviewApproval(harness);
    if (code === 'snapshot_replaced') activeSnapshot = 'replacement-snapshot';
    else activeElement = 'replacement-element';
    await expect(submit(harness.runtime, command({ id: `resolve-${code}`, idempotencyKey: `resolve-${code}`,
      kind: 'approval.resolve', ownerEpoch: 7, payload: { approvalId: approval.approvalId,
        payloadDigest: approval.payloadDigest, decision: 'approve' } })))
      .resolves.toMatchObject({ status: 'failed', code: 'action_invalidated' });
    expect(handlers.actOnBrowser).not.toHaveBeenCalled();
  });

  it('fails approval resumption after an owner epoch restart', async () => {
    const harness = await createBrowserActionHarness();
    const approval = await requestReviewApproval(harness);
    const restarted = await ControlRuntime.create({ ownerEpoch: 8, handlers, journal: createMemoryJournal(),
      surfaces: harness.surfaces, capabilityLeases: harness.capabilityLeases, approvals: harness.approvals });
    await expect(restarted.submit(command({ id: 'resolve-restarted', idempotencyKey: 'resolve-restarted',
      kind: 'approval.resolve', ownerEpoch: 8, payload: { approvalId: approval.approvalId,
        payloadDigest: approval.payloadDigest, decision: 'approve' } })))
      .resolves.toMatchObject({ status: 'failed', code: 'approval_denied' });
    expect(handlers.actOnBrowser).not.toHaveBeenCalled();
  });

  it('invalidates restart-pending approval receipts once and rehydrates the terminal status', async () => {
    const harness = await createBrowserActionHarness();
    await requestReviewApproval(harness);

    const restarted = await ControlRuntime.create({
      ownerEpoch: 8,
      handlers,
      journal: harness.journal,
      surfaces: harness.surfaces,
      capabilityLeases: harness.capabilityLeases,
      approvals: harness.approvals,
    });

    expect(restarted.snapshot()).toMatchObject({
      capabilityLeases: [],
      approvals: [expect.objectContaining({
        actionId: 'approval-action',
        status: 'revoked',
      })],
      receipts: [expect.objectContaining({
        actionId: 'approval-action',
        state: 'failed',
        code: 'action_invalidated',
        taskId: 'task-review',
        leaseId: harness.lease.id,
        leaseRevision: harness.lease.revision,
      })],
    });
    expect(restarted.snapshot().receipts).not.toContainEqual(expect.objectContaining({
      actionId: 'approval-action',
      state: 'approval_required',
    }));
    await expect(restarted.submit(command({
      id: 'approval-action-retry',
      idempotencyKey: 'approval-action',
      kind: 'browser.action',
      ownerEpoch: 8,
      actor: { id: 'agent-review', kind: 'psyche' },
      payload: {
        taskId: 'task-review',
        leaseId: harness.lease.id,
        leaseRevision: harness.lease.revision,
        tabId: harness.tab.id,
        generation: harness.tab.generation,
        snapshotId: 'snapshot-review',
        action: { kind: 'submit', elementRef: 'element-review' },
      },
    }))).resolves.toMatchObject({ status: 'failed', code: 'action_invalidated' });

    const invalidations = harness.journal.read().filter((event) => (
      event.kind === 'command.failed'
      && (event.payload.receipt as { actionId?: string; code?: string } | undefined)?.actionId === 'approval-action'
      && (event.payload.receipt as { actionId?: string; code?: string } | undefined)?.code === 'action_invalidated'
    ));
    expect(invalidations).toHaveLength(1);

    const eventsAfterFirstRestart = harness.journal.read().length;
    const restartedAgain = await ControlRuntime.create({ ownerEpoch: 9, handlers, journal: harness.journal });
    expect(harness.journal.read()).toHaveLength(eventsAfterFirstRestart);
    expect(restartedAgain.snapshot().receipts).toContainEqual(expect.objectContaining({
      actionId: 'approval-action',
      state: 'failed',
      code: 'action_invalidated',
    }));
  });
});

describe('ControlRuntime pane barrier retention', () => {
  /** Seeds a takeover barrier for a pane without going through a command. */
  function seedBarrier(runtime: ControlRuntime, paneId: string, generation = 1) {
    (runtime as any).paneBarrierGenerations.set(paneId, generation);
  }

  function barriers(runtime: ControlRuntime): Map<string, number> {
    return (runtime as any).paneBarrierGenerations;
  }

  function prune(runtime: ControlRuntime) {
    (runtime as any).pruneInactiveResourceQueues();
  }

  it('releases the barrier of a pane with no surface and no queue', async () => {
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), surfaces: new SurfaceRegistry(),
    });
    seedBarrier(runtime, '%9');

    prune(runtime);

    expect(barriers(runtime).has('%9')).toBe(false);
  });

  it('keeps the barrier of a pane that still has a surface', async () => {
    const surfaces = new SurfaceRegistry();
    surfaces.upsertPane({
      id: '%9', projectRoot: '/repo', worktreeRoot: '/repo', tmuxPaneId: '%9',
      writable: true, outputSequence: 0,
    });
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), surfaces,
    });
    seedBarrier(runtime, '%9', 3);

    prune(runtime);

    expect(barriers(runtime).get('%9')).toBe(3);
  });

  it('keeps the barrier of a surfaceless pane that still has a queue', async () => {
    const runtime = await ControlRuntime.create({
      ownerEpoch: 7, handlers, journal: createMemoryJournal(), surfaces: new SurfaceRegistry(),
    });
    seedBarrier(runtime, '%9', 2);
    // A queue created while the pane had a surface keeps that generation in its
    // key, so pruning must match on pane id rather than rebuilding the key.
    (runtime as any).queueForResource({ kind: 'pane', id: '%9', generation: 5 });

    prune(runtime);

    expect(barriers(runtime).get('%9')).toBe(2);
  });
});
