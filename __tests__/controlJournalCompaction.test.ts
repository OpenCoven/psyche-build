import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlJournal } from '../src/control/journal.js';
import { ControlRuntime, type ControlHandlers } from '../src/control/runtime.js';
import type { ControlCommand } from '../src/control/types.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makeHandlers(): ControlHandlers {
  return {
    executeOrchestration: vi.fn(), spawnPane: vi.fn(), sendPrompt: vi.fn(), interruptPane: vi.fn(),
    sendInput: vi.fn(), openTerminal: vi.fn(), resizePane: vi.fn(), focusPane: vi.fn(),
    killPane: vi.fn(), respawnPane: vi.fn(), openConflictPane: vi.fn(), updatePaneOption: vi.fn(),
    updatePaneMeta: vi.fn(), launchRitual: vi.fn(), launchCovenSession: vi.fn(),
    openCovenSession: vi.fn(), runCovenDesktopAction: vi.fn(), executeCovenCapability: vi.fn(),
    observePane: vi.fn(), actOnPane: vi.fn(), inspectBrowser: vi.fn(), actOnBrowser: vi.fn(),
    runBrowserScript: vi.fn(),
  };
}

function takeover(idempotencyKey: string): ControlCommand {
  return {
    id: `cmd-${idempotencyKey}`,
    idempotencyKey,
    kind: 'pane.takeover',
    projectRoot: '/repo',
    actor: { id: 'human-1', kind: 'human' },
    ownerEpoch: 4,
    createdAt: '2026-08-03T20:00:00.000Z',
    payload: { paneId: '%3' },
  } as ControlCommand;
}

async function newRoot(): Promise<string> {
  const root = path.join(process.cwd(), '.test-artifacts', `psyche-compaction-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  roots.push(root);
  return root;
}

describe('control journal compaction', () => {
  it('keeps idempotency dedup across a compaction and restart', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4, handlers: makeHandlers(), journal,
    });

    const first = await runtime.submit(takeover('idem-keep'));
    expect(first.status).toBe('succeeded');

    // Compact everything this owner wrote, preserving the dedup window in the
    // snapshot the way the runtime's own compaction does.
    const covered = journal.sequence;
    await journal.writeSnapshot({
      snapshot: runtime.snapshot(),
      coveredSequence: covered,
      outcomes: { 'idem-keep': first },
      receiptRecords: [],
    });
    await journal.compact(covered);
    expect(journal.read(0)).toEqual([]);

    const reopened = await ControlJournal.open(root, 5);
    const restarted = await ControlRuntime.create({
      ownerEpoch: 5, handlers: makeHandlers(), journal: reopened,
    });
    const sequenceBefore = reopened.sequence;

    const replayed = await restarted.submit(takeover('idem-keep'));

    expect(replayed).toEqual(first);
    // A replayed key must not write anything new.
    expect(reopened.sequence).toBe(sequenceBefore);
  });

  it('deduplicates a key after hot eviction, compaction, and restart', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4, handlers: makeHandlers(), journal,
    });
    const first = await runtime.submit(takeover('idem-dropped'));

    for (let index = 0; index < 1_001; index += 1) {
      await runtime.submit(takeover(`idem-later-${index}`));
    }

    // Compact away the whole tail and omit the evicted key from the snapshot:
    // the durable sidecar outcome is now the only authoritative record.
    const covered = journal.sequence;
    await journal.writeSnapshot({
      snapshot: runtime.snapshot(), coveredSequence: covered, outcomes: {}, receiptRecords: [],
    });
    await journal.compact(covered);
    expect(journal.read(0)).toEqual([]);

    const reopened = await ControlJournal.open(root, 5);
    const restarted = await ControlRuntime.create({
      ownerEpoch: 5, handlers: makeHandlers(), journal: reopened,
    });
    const sequenceBefore = reopened.sequence;

    const replayed = await restarted.submit(takeover('idem-dropped'));

    expect(replayed).toEqual(first);
    expect(reopened.sequence).toBe(sequenceBefore);
  }, 90_000);

  it('reports a gap to a reader resuming below the retained window', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4, handlers: makeHandlers(), journal,
    });
    await runtime.submit(takeover('idem-1'));
    await runtime.submit(takeover('idem-2'));

    expect(runtime.readEvents(0).gap).toBe(false);

    const covered = journal.sequence - 1;
    await journal.writeSnapshot({
      snapshot: runtime.snapshot(), coveredSequence: covered, outcomes: {}, receiptRecords: [],
    });
    await journal.compact(covered);

    expect(runtime.readEvents(0).gap).toBe(true);
    // A reader already at the retained head is still contiguous.
    expect(runtime.readEvents(covered).gap).toBe(false);
  });
});
