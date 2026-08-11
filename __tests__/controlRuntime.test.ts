import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlRuntime, type ControlHandlers } from '../src/control/runtime.js';

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
};

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
  });

  it('returns the prior outcome for a duplicate idempotency key', async () => {
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4,
      handlers,
      journal: createMemoryJournal(),
    });
    const first = await runtime.submit(command());
    const second = await runtime.submit(command({ id: 'cmd-2' }));
    expect(second).toEqual(first);
    expect(runtime.events().filter((event) => event.kind === 'command.requested'))
      .toHaveLength(1);
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
    await expect(queued).resolves.toMatchObject({
      status: 'rejected',
      code: 'automation_preempted',
    });
    await expect(takeover).resolves.toMatchObject({ status: 'succeeded' });
    expect(handlers.sendPrompt).not.toHaveBeenCalled();
  });
});
