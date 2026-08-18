import { mkdir, rename, rm, symlink, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from './utils/deferred.js';
import { ControlJournal, setDurableOutcomePublicationTestHooksForTesting } from '../src/control/journal.js';
import { ControlRuntime, type ControlHandlers } from '../src/control/runtime.js';
import type { ControlCommand } from '../src/control/types.js';

const roots: string[] = [];
afterEach(async () => {
  setDurableOutcomePublicationTestHooksForTesting(undefined);
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

function storedOutcomePath(root: string, idempotencyKey: string): string {
  return path.join(
    root,
    '.psyche',
    'runtime',
    'outcomes',
    createHash('sha256').update(idempotencyKey, 'utf8').digest('hex'),
  );
}

function providerUpsert(idempotencyKey: string): ControlCommand {
  return {
    id: `provider-${idempotencyKey}`,
    idempotencyKey,
    kind: 'provider.resource.upsert',
    projectRoot: '/repo',
    actor: { id: 'human-1', kind: 'human' },
    ownerEpoch: 4,
    createdAt: '2026-08-03T20:00:00.000Z',
    payload: {
      resource: {
        id: `provider-tab-${idempotencyKey}`,
        projectRoot: '/repo',
        worktreeRoot: '/repo',
        providerId: 'provider-test',
        webviewLabel: 'Provider Tab',
        url: 'https://example.test',
        title: 'Example',
        loading: false,
        viewport: { width: 800, height: 600 },
      },
    },
  } as ControlCommand;
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

    // Compact everything this owner wrote the way the runtime now does: legacy
    // snapshot outcomes stay empty, so restart must replay from the exact
    // durable sidecar.
    const covered = journal.sequence;
    await journal.writeSnapshot({
      snapshot: runtime.snapshot(),
      coveredSequence: covered,
      outcomes: {},
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

  it('aborts compaction when a covered replay discovers a missing sidecar', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4, handlers: makeHandlers(), journal,
    });

    const first = await runtime.submit(takeover('idem-race'));
    for (let index = 0; index < 500; index += 1) {
      await runtime.submit(takeover(`idem-race-later-${index}`));
    }
    const coveredSequence = journal.sequence - 1_000;
    expect(coveredSequence).toBeGreaterThanOrEqual(2);

    const compactReady = createDeferred<void>();
    const releaseCompact = createDeferred<void>();
    setDurableOutcomePublicationTestHooksForTesting({
      beforeCompactRename: async ({ coveredSequence: hookCoveredSequence }) => {
        expect(hookCoveredSequence).toBe(coveredSequence);
        compactReady.resolve();
        await releaseCompact.promise;
      },
    });

    const compacting = (runtime as any).compactJournal(journal);
    await compactReady.promise;

    (runtime as any).outcomesByIdempotencyKey.delete('idem-race');
    await unlink(storedOutcomePath(root, 'idem-race'));
    const replayed = await runtime.submit(takeover('idem-race'));
    expect(replayed).toEqual(first);
    releaseCompact.resolve();
    await compacting;

    expect(journal.firstSequence).toBe(1);
    expect(journal.read(0).filter((event) => (
      event.kind === 'command.succeeded' && event.payload.idempotencyKey === 'idem-race'
    ))).toHaveLength(1);

    setDurableOutcomePublicationTestHooksForTesting(undefined);
    await (runtime as any).compactJournal(journal);
    expect(journal.firstSequence).toBeGreaterThan(2);

    const reopened = await ControlJournal.open(root, 5);
    const restarted = await ControlRuntime.create({
      ownerEpoch: 5, handlers: makeHandlers(), journal: reopened,
    });
    const sequenceBefore = reopened.sequence;
    await expect(restarted.submit(takeover('idem-race'))).resolves.toEqual(first);
    expect(reopened.sequence).toBe(sequenceBefore);
  }, 90_000);

  it('attests a retained pre-digest surface terminal before compacting it away', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const command = providerUpsert('legacy-surface-attestation') as Extract<ControlCommand, { kind: 'provider.resource.upsert' }>;
    const outcome = {
      status: 'succeeded',
      value: { resource: command.payload.resource },
    } as const;
    await journal.append('command.requested', {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      kind: command.kind,
      ownerEpoch: command.ownerEpoch,
    });
    await journal.append('command.succeeded', {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      status: 'succeeded',
    });
    await journal.storeOutcome(command.idempotencyKey, outcome);

    const restarted = await ControlRuntime.create({
      ownerEpoch: 5, handlers: makeHandlers(), journal,
    });
    const attestation = journal.read(0).find((event) => (
      event.kind === 'command.outcome.attested'
      && event.payload.commandId === command.id
      && event.payload.idempotencyKey === command.idempotencyKey
    ));
    expect(attestation?.payload.outcomeDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(attestation?.payload.value).toBeUndefined();

    const sequenceBeforeRetry = journal.sequence;
    await expect(restarted.submit({ ...command, id: 'legacy-surface-attestation-retry' }))
      .resolves.toEqual(outcome);
    expect(journal.sequence).toBe(sequenceBeforeRetry);

    for (let index = 0; index < 500; index += 1) {
      await restarted.submit(takeover(`legacy-surface-attestation-later-${index}`));
    }
    await (restarted as any).compactJournal(journal);
    expect(journal.firstSequence).toBeGreaterThan(2);

    const reopened = await ControlJournal.open(root, 6);
    const restartedAgain = await ControlRuntime.create({
      ownerEpoch: 6, handlers: makeHandlers(), journal: reopened,
    });
    const sequenceBeforeRestartRetry = reopened.sequence;
    await expect(restartedAgain.submit({ ...command, id: 'legacy-surface-attestation-restart-retry' }))
      .resolves.toEqual(outcome);
    expect(reopened.sequence).toBe(sequenceBeforeRestartRetry);
  }, 90_000);

  it('aborts compaction when a covered replay hits a retained outcome read error', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4, handlers: makeHandlers(), journal,
    });

    const first = await runtime.submit(takeover('idem-read-race'));
    for (let index = 0; index < 500; index += 1) {
      await runtime.submit(takeover(`idem-read-race-later-${index}`));
    }
    const coveredSequence = journal.sequence - 1_000;
    expect(coveredSequence).toBeGreaterThanOrEqual(2);

    const runtimeDirectory = path.join(root, '.psyche', 'runtime');
    const outcomesDirectory = path.join(runtimeDirectory, 'outcomes');
    const trustedDirectory = path.join(runtimeDirectory, 'outcomes-private');
    const externalDirectory = path.join(root, 'external-read-error-outcomes');
    await mkdir(externalDirectory, { recursive: true, mode: 0o755 });

    const compactReady = createDeferred<void>();
    const releaseCompact = createDeferred<void>();
    let allowSwap = false;
    let swapped = false;
    setDurableOutcomePublicationTestHooksForTesting({
      beforeCompactRename: async ({ coveredSequence: hookCoveredSequence }) => {
        expect(hookCoveredSequence).toBe(coveredSequence);
        compactReady.resolve();
        await releaseCompact.promise;
      },
      beforeOutcomePathRead: async ({ directoryPath }) => {
        if (!allowSwap || swapped || directoryPath !== outcomesDirectory) return;
        swapped = true;
        await rename(outcomesDirectory, trustedDirectory);
        await symlink(
          externalDirectory,
          outcomesDirectory,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      },
    });

    const compacting = (runtime as any).compactJournal(journal);
    await compactReady.promise;

    allowSwap = true;
    (runtime as any).outcomesByIdempotencyKey.delete('idem-read-race');
    await expect(runtime.submit(takeover('idem-read-race')))
      .rejects.toThrow('durable outcome directory changed during read');
    releaseCompact.resolve();
    await compacting;

    expect(journal.firstSequence).toBe(1);
    expect(journal.read(0).filter((event) => (
      event.kind === 'command.succeeded' && event.payload.idempotencyKey === 'idem-read-race'
    ))).toHaveLength(1);

    setDurableOutcomePublicationTestHooksForTesting(undefined);
    await rm(outcomesDirectory, { recursive: true, force: true });
    await rename(trustedDirectory, outcomesDirectory);

    const sequenceBeforeRetry = journal.sequence;
    await expect(runtime.submit(takeover('idem-read-race'))).resolves.toEqual(first);
    expect(journal.sequence).toBe(sequenceBeforeRetry);

    const reopened = await ControlJournal.open(root, 5);
    const restarted = await ControlRuntime.create({
      ownerEpoch: 5, handlers: makeHandlers(), journal: reopened,
    });
    const sequenceBeforeRestart = reopened.sequence;
    await expect(restarted.submit(takeover('idem-read-race'))).resolves.toEqual(first);
    expect(reopened.sequence).toBe(sequenceBeforeRestart);
  }, 90_000);

  it('verifies exact sidecars for covered surface terminals before compaction drops them', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4, handlers: makeHandlers(), journal,
    });
    const idempotencyKey = 'surface-compaction-precondition';
    const first = await runtime.submit(providerUpsert(idempotencyKey));

    for (let index = 0; index < 500; index += 1) {
      await runtime.submit(takeover(`surface-compaction-later-${index}`));
    }

    const terminalSequence = journal.read(0).find((event) => (
      event.kind === 'command.succeeded' && event.payload.idempotencyKey === idempotencyKey
    ))?.sequence;
    expect(terminalSequence).toBeDefined();
    await unlink(storedOutcomePath(root, idempotencyKey));

    await (runtime as any).compactJournal(journal);

    expect(journal.firstSequence).toBeLessThanOrEqual(terminalSequence as number);
    (runtime as any).outcomesByIdempotencyKey.delete(idempotencyKey);
    const sequenceBeforeRetry = journal.sequence;
    await expect(runtime.submit(providerUpsert(idempotencyKey)))
      .rejects.toThrow('durable outcome sidecar is required');
    expect(journal.sequence).toBe(sequenceBeforeRetry);

    const reopened = await ControlJournal.open(root, 5);
    await expect(ControlRuntime.create({
      ownerEpoch: 5, handlers: makeHandlers(), journal: reopened,
    })).rejects.toThrow('durable outcome sidecar is required');
    expect(reopened.sequence).toBe(sequenceBeforeRetry);
    expect(first).toMatchObject({ status: 'succeeded' });
  }, 90_000);

  it('aborts compaction when a covered terminal sidecar has the right status but the wrong exact value', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4, handlers: makeHandlers(), journal,
    });
    const idempotencyKey = 'surface-compaction-digest-mismatch';
    const command = providerUpsert(idempotencyKey) as Extract<ControlCommand, { kind: 'provider.resource.upsert' }>;
    await runtime.submit(command);

    for (let index = 0; index < 500; index += 1) {
      await runtime.submit(takeover(`surface-compaction-digest-later-${index}`));
    }

    const terminalSequence = journal.read(0).find((event) => (
      event.kind === 'command.succeeded' && event.payload.idempotencyKey === idempotencyKey
    ))?.sequence;
    expect(terminalSequence).toBeDefined();

    await journal.storeOutcome(idempotencyKey, {
      status: 'succeeded',
      value: {
        resource: {
          ...command.payload.resource,
          title: 'Forged Surface Value',
        },
      },
    });

    await (runtime as any).compactJournal(journal);

    expect(journal.firstSequence).toBeLessThanOrEqual(terminalSequence as number);
    (runtime as any).outcomesByIdempotencyKey.delete(idempotencyKey);
    const sequenceBeforeRetry = journal.sequence;
    await expect(runtime.submit({ ...command, id: 'provider-surface-compaction-digest-retry' }))
      .rejects.toThrow('durable outcome sidecar does not match retained terminal event');
    expect(journal.sequence).toBe(sequenceBeforeRetry);
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
