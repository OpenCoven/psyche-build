import { mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from './utils/deferred.js';
import {
  COMPACTED_OUTCOME_CODE,
  ControlJournal,
  exactCommandOutcomeDigest,
  setDurableOutcomePublicationTestHooksForTesting,
} from '../src/control/journal.js';
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

function openTerminalCommand(idempotencyKey: string, ownerEpoch = 4, title = idempotencyKey): ControlCommand {
  return {
    id: `cmd-${idempotencyKey}-${ownerEpoch}`, idempotencyKey, kind: 'pane.terminal.open',
    projectRoot: '/repo', actor: { id: 'human-1', kind: 'human' }, ownerEpoch,
    createdAt: '2026-08-17T20:00:00.000Z', payload: { cwd: '/repo', title },
  };
}

async function newRoot(): Promise<string> {
  const root = path.join(process.cwd(), '.test-artifacts', `psyche-compaction-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  roots.push(root);
  return root;
}

async function appendCompactionPressure(journal: ControlJournal, prefix: string): Promise<void> {
  for (let index = 0; index < 1_001; index += 1) {
    await journal.append('unrelated.event', { id: `${prefix}-${index}` });
  }
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
  it('preserves an open transaction older than the cutoff and recovers it as unknown', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const handlers = makeHandlers();
    const effect = vi.fn(async () => ({ paneId: '%must-not-run' }));
    handlers.openTerminal = effect;
    const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers, journal });
    const openCommand = openTerminalCommand('open-before-cutoff');
    await journal.append('command.requested', {
      commandId: openCommand.id, idempotencyKey: openCommand.idempotencyKey,
      kind: openCommand.kind, ownerEpoch: openCommand.ownerEpoch,
    });
    await appendCompactionPressure(journal, 'open-filler');
    expect(journal.sequence).toBe(1_002);
    await (runtime as any).compactJournal(journal);
    expect(journal.firstSequence).toBe(3);
    const durableFile = JSON.parse(
      await readFile(path.join(root, '.psyche', 'runtime', 'snapshot.json'), 'utf8'),
    ) as { openTransactions?: unknown[] };
    expect(durableFile.openTransactions).toContainEqual({
      sequence: 1, commandId: openCommand.id, idempotencyKey: openCommand.idempotencyKey,
      kind: 'command.requested',
    });
    const reopened = await ControlJournal.open(root, 5);
    const restarted = await ControlRuntime.create({ ownerEpoch: 5, handlers, journal: reopened });
    await expect(restarted.submit({ ...openCommand, ownerEpoch: 5 }))
      .resolves.toMatchObject({ status: 'unknown', code: 'recovered-nonterminal' });
    expect(effect).not.toHaveBeenCalled();
  }, 90_000);

  it('fails closed when a compacted open transaction snapshot loses its cutoff', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const handlers = makeHandlers();
    const effect = vi.fn(async () => ({ paneId: '%must-not-run' }));
    handlers.openTerminal = effect;
    const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers, journal });
    const openCommand = openTerminalCommand('open-malformed-snapshot');
    await journal.append('command.requested', {
      commandId: openCommand.id,
      idempotencyKey: openCommand.idempotencyKey,
      kind: openCommand.kind,
      ownerEpoch: openCommand.ownerEpoch,
    });
    await appendCompactionPressure(journal, 'malformed-snapshot-filler');
    await (runtime as any).compactJournal(journal);

    const snapshotPath = path.join(root, '.psyche', 'runtime', 'snapshot.json');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as Record<string, unknown>;
    delete snapshot.coveredSequence;
    await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf8');

    const reopened = await ControlJournal.open(root, 5);
    await expect(ControlRuntime.create({ ownerEpoch: 5, handlers, journal: reopened }))
      .rejects.toThrow('durable snapshot corruption');
    expect(effect).not.toHaveBeenCalled();
  }, 90_000);

  it('persists a redacted durable snapshot projection and replays its compact marker', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const handlers = makeHandlers();
    handlers.openTerminal = vi.fn(async () => ({ paneId: '%browser-result-secret-script-result-secret' }));
    const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers, journal });
    await runtime.submit(openTerminalCommand('redacted-command', 4, 'terminal-input-secret prompt-secret'));
    const exactSidecar = await readFile(storedOutcomePath(root, 'redacted-command'), 'utf8');
    expect(exactSidecar).toContain('browser-result-secret');
    const resourceCommand = providerUpsert('redacted-resource') as Extract<
      ControlCommand, { kind: 'provider.resource.upsert' }
    >;
    await runtime.submit({
      ...resourceCommand,
      payload: { resource: { ...resourceCommand.payload.resource, title: 'resource-value-secret' } },
    });
    await appendCompactionPressure(journal, 'redacted-filler');
    await (runtime as any).compactJournal(journal);
    const serialized = await readFile(path.join(root, '.psyche', 'runtime', 'snapshot.json'), 'utf8');
    for (const secret of ['terminal-input-secret', 'prompt-secret', 'browser-result-secret',
      'script-result-secret', 'resource-value-secret']) expect(serialized).not.toContain(secret);
    const durableFile = JSON.parse(serialized) as {
      snapshot: unknown; completedTransactions: Array<{ idempotencyKey: string }>;
    };
    expect(durableFile.snapshot).toEqual({ ownerEpoch: 4, sequence: journal.sequence });
    expect(durableFile.completedTransactions).toContainEqual(expect.objectContaining({
      idempotencyKey: 'redacted-command',
    }));
    const compactedSidecar = await readFile(storedOutcomePath(root, 'redacted-command'), 'utf8');
    expect(compactedSidecar).not.toContain('browser-result-secret');
    expect(JSON.parse(compactedSidecar)).toEqual({
      idempotencyKey: 'redacted-command',
      outcome: {
        status: 'unknown',
        code: COMPACTED_OUTCOME_CODE,
        message: 'command completed; exact outcome was compacted',
      },
    });
    const reopened = await ControlJournal.open(root, 5);
    const restarted = await ControlRuntime.create({ ownerEpoch: 5, handlers, journal: reopened });
    const callsBefore = vi.mocked(handlers.openTerminal).mock.calls.length;
    await expect(restarted.submit(openTerminalCommand('redacted-command', 5))).resolves.toEqual({
      status: 'unknown',
      code: COMPACTED_OUTCOME_CODE,
      message: 'command completed; exact outcome was compacted',
    });
    expect(handlers.openTerminal).toHaveBeenCalledTimes(callsBefore);
  }, 90_000);

  it('accepts a compact marker while the original terminal event is still retained', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const handlers = makeHandlers();
    let effects = 0;
    handlers.openTerminal = vi.fn(async () => ({ paneId: `%marker-${++effects}` }));
    const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers, journal });
    const command = openTerminalCommand('marker-before-journal-compact');
    await runtime.submit(command);
    await appendCompactionPressure(journal, 'marker-retained-filler');

    const markerPublished = createDeferred<void>();
    const releaseJournalCompact = createDeferred<void>();
    setDurableOutcomePublicationTestHooksForTesting({
      beforeCompactRename: async () => {
        markerPublished.resolve();
        await releaseJournalCompact.promise;
      },
    });
    const compacting = (runtime as any).compactJournal(journal);
    await markerPublished.promise;

    (runtime as any).outcomesByIdempotencyKey.delete(command.idempotencyKey);
    await expect(runtime.submit({ ...command, id: 'marker-before-journal-compact-retry' }))
      .resolves.toMatchObject({ status: 'unknown', code: COMPACTED_OUTCOME_CODE });
    expect(effects).toBe(1);

    releaseJournalCompact.resolve();
    await compacting;
    expect(journal.firstSequence).toBeGreaterThan(1);
  }, 90_000);

  it('does not compact a key whose latest terminal is above the cutoff', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers: makeHandlers(), journal });
    const key = 'newer-terminal-above-cutoff';
    await runtime.submit(takeover(key));
    await appendCompactionPressure(journal, 'newer-terminal-filler');

    const newer = {
      status: 'succeeded',
      value: { actorId: 'human-newer', revision: 2 },
    } as const;
    await journal.append('command.requested', {
      commandId: 'cmd-newer-terminal',
      idempotencyKey: key,
      kind: 'pane.takeover',
      ownerEpoch: 4,
    });
    const newerTerminal = await journal.append('command.succeeded', {
      commandId: 'cmd-newer-terminal',
      idempotencyKey: key,
      status: newer.status,
      value: newer.value,
      outcomeDigest: exactCommandOutcomeDigest(newer),
    });
    await journal.storeOutcome(key, newer);

    const coveredSequence = journal.sequence - 1_000;
    expect(newerTerminal.sequence).toBeGreaterThan(coveredSequence);
    await (runtime as any).compactJournal(journal);

    await expect(journal.loadOutcome(key)).resolves.toEqual(newer);
    expect(journal.firstSequence).toBe(coveredSequence + 1);
    (runtime as any).outcomesByIdempotencyKey.delete(key);
    await expect(runtime.submit({ ...takeover(key), id: 'cmd-newer-terminal-retry' }))
      .resolves.toEqual(newer);
  }, 90_000);

  it('retains journal evidence and the latest exact retry when a newer terminal publishes during compaction', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers: makeHandlers(), journal });
    const key = 'outcome-cas-mismatch';
    await runtime.submit(takeover(key));
    await appendCompactionPressure(journal, 'outcome-cas-filler');

    const snapshotReady = createDeferred<void>();
    const releaseSnapshot = createDeferred<void>();
    setDurableOutcomePublicationTestHooksForTesting({
      beforeSnapshotRename: async () => {
        snapshotReady.resolve();
        await releaseSnapshot.promise;
      },
    });
    const compacting = (runtime as any).compactJournal(journal);
    await snapshotReady.promise;

    const newer = {
      status: 'succeeded',
      value: { actorId: 'human-newer', revision: 3 },
    } as const;
    await (runtime as any).appendTerminal(
      { ...takeover(key), id: 'outcome-cas-mismatch-newer' },
      newer,
    );
    releaseSnapshot.resolve();
    await compacting;

    expect((runtime as any).compactionBlockedByDurability).toBe(true);
    expect(journal.firstSequence).toBe(1);
    expect(journal.read(0).some((event) => event.payload.idempotencyKey === key)).toBe(true);
    await expect(journal.loadOutcome(key)).resolves.toEqual(newer);
    (runtime as any).outcomesByIdempotencyKey.delete(key);
    const sequenceBeforeRetry = journal.sequence;
    await expect(runtime.submit({ ...takeover(key), id: 'outcome-cas-mismatch-retry' }))
      .resolves.toEqual(newer);
    expect(journal.sequence).toBe(sequenceBeforeRetry);
  }, 90_000);

  it('retains journal evidence and exact retries when marker compare-and-replace mismatches', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers: makeHandlers(), journal });
    const key = 'outcome-cas-deferred';
    const first = await runtime.submit(takeover(key));
    await appendCompactionPressure(journal, 'outcome-cas-deferred-filler');

    const replace = journal.replaceOutcomeIfMatches.bind(journal);
    vi.spyOn(journal, 'replaceOutcomeIfMatches').mockImplementation(
      async (idempotencyKey, expectedDigest, replacement) => (
        idempotencyKey === key
          ? false
          : replace(idempotencyKey, expectedDigest, replacement)
      ),
    );

    await (runtime as any).compactJournal(journal);

    expect((runtime as any).compactionBlockedByDurability).toBe(true);
    expect(journal.firstSequence).toBe(1);
    expect(journal.read(0).some((event) => event.payload.idempotencyKey === key)).toBe(true);
    await expect(journal.loadOutcome(key)).resolves.toEqual(first);
    (runtime as any).outcomesByIdempotencyKey.delete(key);
    const sequenceBeforeRetry = journal.sequence;
    await expect(runtime.submit({ ...takeover(key), id: 'outcome-cas-deferred-retry' }))
      .resolves.toEqual(first);
    expect(journal.sequence).toBe(sequenceBeforeRetry);
  }, 90_000);

  it('retains journal evidence and blocks fresh effects when marker publication fails', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const handlers = makeHandlers();
    let effects = 0;
    handlers.openTerminal = vi.fn(async () => ({ paneId: `%failure-${++effects}` }));
    const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers, journal });
    const command = openTerminalCommand('marker-publication-failure');
    const first = await runtime.submit(command);
    const terminalSequence = journal.findByIdempotencyKey(command.idempotencyKey)?.sequence ?? 0;
    await appendCompactionPressure(journal, 'marker-failure-filler');

    const replace = journal.replaceOutcomeIfMatches.bind(journal);
    let failMarker = true;
    vi.spyOn(journal, 'replaceOutcomeIfMatches').mockImplementation(
      async (idempotencyKey, expectedDigest, replacement) => {
      if (
        failMarker
        && idempotencyKey === command.idempotencyKey
        && replacement.status === 'unknown'
        && replacement.code === COMPACTED_OUTCOME_CODE
      ) {
        throw new Error('injected compact marker publication failure');
      }
      return replace(idempotencyKey, expectedDigest, replacement);
      },
    );

    await (runtime as any).compactJournal(journal);
    expect((runtime as any).compactionBlockedByDurability).toBe(true);
    expect(journal.firstSequence).toBeLessThanOrEqual(terminalSequence);
    expect(await journal.loadOutcome(command.idempotencyKey)).toEqual(first);

    const sequenceBeforeBlocked = journal.sequence;
    await expect(runtime.submit(openTerminalCommand('marker-failure-fresh')))
      .resolves.toMatchObject({ status: 'rejected', code: 'durability_unavailable' });
    expect(journal.sequence).toBe(sequenceBeforeBlocked);
    expect(effects).toBe(1);

    failMarker = false;
    await expect(runtime.submit(openTerminalCommand('marker-failure-recovered')))
      .resolves.toMatchObject({ status: 'succeeded' });
    expect((runtime as any).compactionBlockedByDurability).toBe(false);
    expect(journal.firstSequence).toBeGreaterThan(terminalSequence);

    const reopened = await ControlJournal.open(root, 5);
    const restarted = await ControlRuntime.create({ ownerEpoch: 5, handlers, journal: reopened });
    await expect(restarted.submit(openTerminalCommand(command.idempotencyKey, 5)))
      .resolves.toMatchObject({ status: 'unknown', code: COMPACTED_OUTCOME_CODE });
    expect(effects).toBe(2);
  }, 90_000);

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
    await runtime.submit(takeover('idem-dropped'));
    await appendCompactionPressure(journal, 'idem-later');
    await (runtime as any).compactJournal(journal);

    const reopened = await ControlJournal.open(root, 5);
    const restarted = await ControlRuntime.create({
      ownerEpoch: 5, handlers: makeHandlers(), journal: reopened,
    });
    const sequenceBefore = reopened.sequence;

    const replayed = await restarted.submit(takeover('idem-dropped'));

    expect(replayed).toMatchObject({ status: 'unknown', code: COMPACTED_OUTCOME_CODE });
    expect(reopened.sequence).toBe(sequenceBefore);
  }, 90_000);

  it('aborts compaction when a covered replay discovers a missing sidecar', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4, handlers: makeHandlers(), journal,
    });

    const first = await runtime.submit(takeover('idem-race'));
    await appendCompactionPressure(journal, 'idem-race-later');
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
    await expect(restarted.submit(takeover('idem-race')))
      .resolves.toMatchObject({ status: 'unknown', code: COMPACTED_OUTCOME_CODE });
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

    await appendCompactionPressure(journal, 'legacy-surface-attestation-later');
    await (restarted as any).compactJournal(journal);
    expect(journal.firstSequence).toBeGreaterThan(2);

    const reopened = await ControlJournal.open(root, 6);
    const restartedAgain = await ControlRuntime.create({
      ownerEpoch: 6, handlers: makeHandlers(), journal: reopened,
    });
    const sequenceBeforeRestartRetry = reopened.sequence;
    await expect(restartedAgain.submit({ ...command, id: 'legacy-surface-attestation-restart-retry' }))
      .resolves.toMatchObject({ status: 'unknown', code: COMPACTED_OUTCOME_CODE });
    expect(reopened.sequence).toBe(sequenceBeforeRestartRetry);
  }, 90_000);

  it('aborts compaction when a covered replay hits a retained outcome read error', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 4);
    const runtime = await ControlRuntime.create({
      ownerEpoch: 4, handlers: makeHandlers(), journal,
    });

    await runtime.submit(takeover('idem-read-race'));
    await appendCompactionPressure(journal, 'idem-read-race-later');
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
    await expect(runtime.submit(takeover('idem-read-race')))
      .resolves.toMatchObject({ status: 'unknown', code: COMPACTED_OUTCOME_CODE });
    expect(journal.sequence).toBe(sequenceBeforeRetry);

    const reopened = await ControlJournal.open(root, 5);
    const restarted = await ControlRuntime.create({
      ownerEpoch: 5, handlers: makeHandlers(), journal: reopened,
    });
    const sequenceBeforeRestart = reopened.sequence;
    await expect(restarted.submit(takeover('idem-read-race')))
      .resolves.toMatchObject({ status: 'unknown', code: COMPACTED_OUTCOME_CODE });
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

    await appendCompactionPressure(journal, 'surface-compaction-later');

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

    await appendCompactionPressure(journal, 'surface-compaction-digest-later');

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
