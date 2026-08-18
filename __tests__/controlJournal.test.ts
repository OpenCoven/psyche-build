import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentControlJournalPayload,
  ControlJournal,
  createAgentControlJournalResource,
} from '../src/control/journal.js';
import { createRedactedApprovalEffect } from '../src/control/approvals.js';
import type { ActionReceipt } from '../src/control/types.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newRoot(prefix: string): Promise<string> {
  const root = path.join(process.cwd(), '.test-artifacts', `${prefix}-${randomUUID()}`);
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

describe('ControlJournal', () => {
  it('constructs agent-control records from allowlisted metadata only', () => {
    const built = agentControlJournalPayload({
      kind: 'command.succeeded', commandId: 'script-1', idempotencyKey: 'idem-1',
      status: 'succeeded',
      receipt: {
        schema: 'psyche.control.receipt/v1', actionId: 'script-1', state: 'succeeded',
        resource: createAgentControlJournalResource({ kind: 'browser_tab', id: 'tab-1', generation: 2 }),
        createdAt: '2026-08-12T00:00:00.000Z', sourceDigest: 'digest', sourceBytes: 10,
        resultBytes: 2, durationMs: 1,
      },
    });
    expect(built.payload).toMatchObject({ receipt: {
      sourceDigest: 'digest', sourceBytes: 10, resultBytes: 2, durationMs: 1,
    } });
  });

  it('persists optional receipt ownership metadata across journal replay', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 7);
    const event = agentControlJournalPayload({
      kind: 'command.failed',
      commandId: 'owned-receipt',
      idempotencyKey: 'owned-receipt',
      status: 'failed',
      receipt: {
        schema: 'psyche.control.receipt/v1',
        actionId: 'owned-receipt',
        state: 'failed',
        resource: createAgentControlJournalResource({ kind: 'browser_tab', id: 'tab-1', generation: 2 }),
        createdAt: '2026-08-12T00:00:00.000Z',
        taskId: 'task-1',
        actorId: 'task-subject:subject-1',
        leaseId: 'lease-1',
        leaseRevision: 2,
        completedAt: '2026-08-12T00:00:01.000Z',
        code: 'effect_failed',
      },
    });

    await journal.append(event.kind, event.payload);

    const reopened = await ControlJournal.open(root, 7);
    expect(reopened.read(0)).toContainEqual(expect.objectContaining({
      kind: 'command.failed',
      payload: expect.objectContaining({
        receipt: expect.objectContaining({
          taskId: 'task-1',
          actorId: 'task-subject:subject-1',
          leaseId: 'lease-1',
          leaseRevision: 2,
        }),
      }),
    }));
  });

  it('persists task-bound receipt ownership without a lease tuple across journal replay', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 7);
    const event = agentControlJournalPayload({
      kind: 'command.failed',
      commandId: 'task-owned-receipt',
      idempotencyKey: 'task-owned-receipt',
      status: 'failed',
      receipt: {
        schema: 'psyche.control.receipt/v1',
        actionId: 'task-owned-receipt',
        state: 'failed',
        resource: createAgentControlJournalResource({ kind: 'browser_tab', id: 'tab-1', generation: 2 }),
        createdAt: '2026-08-12T00:00:00.000Z',
        taskId: 'task-1',
        actorId: 'task-subject:subject-1',
        completedAt: '2026-08-12T00:00:01.000Z',
        code: 'action_validation_failed',
      },
    });

    await journal.append(event.kind, event.payload);

    const reopened = await ControlJournal.open(root, 7);
    expect(reopened.read(0)).toContainEqual(expect.objectContaining({
      kind: 'command.failed',
      payload: expect.objectContaining({
        receipt: expect.objectContaining({
          taskId: 'task-1',
          actorId: 'task-subject:subject-1',
          code: 'action_validation_failed',
        }),
      }),
    }));
  });

  it('stores and reloads hashed outcomes for separator-heavy unicode keys', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 7);
    const idempotencyKey = 'panes/漢字/../☕️/retry:key';
    const outcome = { status: 'succeeded', value: { paneId: '%3', ok: true } } as const;

    await journal.storeOutcome(idempotencyKey, outcome);

    const filePath = storedOutcomePath(root, idempotencyKey);
    expect(path.basename(filePath)).toBe(
      createHash('sha256').update(idempotencyKey, 'utf8').digest('hex'),
    );
    await expect(journal.loadOutcome(idempotencyKey)).resolves.toEqual(outcome);
  });

  it('returns undefined for a missing durable outcome', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 7);

    await expect(journal.loadOutcome('missing/結果/☕️')).resolves.toBeUndefined();
  });

  it('rejects malformed durable outcome JSON', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 7);
    const idempotencyKey = 'bad-json';
    const filePath = storedOutcomePath(root, idempotencyKey);

    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, '{not json', 'utf8');

    await expect(journal.loadOutcome(idempotencyKey)).rejects.toThrow('durable outcome JSON corruption');
  });

  it('rejects a durable outcome whose original key does not match the hash lookup', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 7);
    const idempotencyKey = 'expected-key';
    const filePath = storedOutcomePath(root, idempotencyKey);

    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, JSON.stringify({
      idempotencyKey: 'other-key',
      outcome: { status: 'succeeded' },
    }), 'utf8');

    await expect(journal.loadOutcome(idempotencyKey)).rejects.toThrow('durable outcome key mismatch');
  });

  it('rejects a durable outcome whose shape is invalid', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 7);
    const idempotencyKey = 'invalid-outcome';
    const filePath = storedOutcomePath(root, idempotencyKey);

    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, JSON.stringify({
      idempotencyKey,
      outcome: { status: 'failed', code: 7, message: 'not-a-valid-outcome' },
    }), 'utf8');

    await expect(journal.loadOutcome(idempotencyKey)).rejects.toThrow('invalid durable outcome shape');
  });

  it('persists optional approval ownership metadata across journal replay', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 7);
    const event = agentControlJournalPayload({
      kind: 'approval.requested',
      commandId: 'approval-action',
      approvalId: 'approval-1',
      payloadDigest: 'd'.repeat(64),
      taskId: 'task-1',
      actorId: 'task-subject:subject-1',
      subjectId: 'subject-1',
      leaseId: 'lease-1',
      leaseRevision: 2,
      resource: createAgentControlJournalResource({ kind: 'browser_tab', id: 'tab-1', generation: 2 }),
      capability: 'browser.script',
      effect: createRedactedApprovalEffect({ kind: 'script', target: 'digest' }),
    });

    await journal.append(event.kind, event.payload);

    const reopened = await ControlJournal.open(root, 7);
    expect(reopened.read(0)).toContainEqual(expect.objectContaining({
      kind: 'approval.requested',
      payload: expect.objectContaining({
        taskId: 'task-1',
        actorId: 'task-subject:subject-1',
        subjectId: 'subject-1',
        leaseId: 'lease-1',
        leaseRevision: 2,
      }),
    }));
  });

  it('keeps forbidden fields outside the typed agent-control builder contract', () => {
    if (false) {
      agentControlJournalPayload({
        kind: 'command.requested', commandId: 'c', idempotencyKey: 'i',
        commandKind: 'browser.script', ownerEpoch: 1,
        // @ts-expect-error transcript is intentionally forbidden at the journal boundary
        transcript: 'secret',
      });
      agentControlJournalPayload({
        kind: 'approval.requested', commandId: 'c', approvalId: 'a', payloadDigest: 'd',
        resource: createAgentControlJournalResource({ kind: 'browser_tab', id: 'tab', generation: 1 }),
        capability: 'browser.script', effect: createRedactedApprovalEffect({ kind: 'script', target: 'digest' }),
        // @ts-expect-error raw script is intentionally forbidden at the journal boundary
        script: 'return document.cookie',
      });
      const terminal = {
        kind: 'command.failed' as const, commandId: 'c', idempotencyKey: 'i',
        status: 'failed' as const, code: 'surface_command_failed',
      };
      // @ts-expect-error full command outcomes are not accepted at the journal boundary
      agentControlJournalPayload({ ...terminal, outcome: { status: 'failed', code: 'x', message: 'secret' } });
      const fullReceipt: ActionReceipt = {
        schema: 'psyche.control.receipt/v1', actionId: 'c', state: 'failed',
        resource: { kind: 'browser_tab', id: 'tab', generation: 1 },
        createdAt: '2026-08-12T00:00:00.000Z', value: 'secret',
      };
      // @ts-expect-error ActionReceipt remains too broad for the durable journal boundary
      agentControlJournalPayload({ ...terminal, receipt: fullReceipt });
      agentControlJournalPayload({ ...terminal, receipt: {
        schema: 'psyche.control.receipt/v1', actionId: 'c', state: 'failed',
        resource: createAgentControlJournalResource({ kind: 'browser_tab', id: 'tab', generation: 1 }),
        // @ts-expect-error full action receipts are not accepted at the journal boundary
        createdAt: '2026-08-12T00:00:00.000Z', value: 'secret',
      } });
      // @ts-expect-error transcripts are forbidden
      agentControlJournalPayload({ ...terminal, transcript: 'terminal output' });
      // @ts-expect-error page data is forbidden
      agentControlJournalPayload({ ...terminal, page: { text: 'secret' } });
      // @ts-expect-error screenshots are forbidden
      agentControlJournalPayload({ ...terminal, screenshot: 'base64' });
      // @ts-expect-error typed values are forbidden
      agentControlJournalPayload({ ...terminal, typedValue: 'password' });
      // @ts-expect-error scripts are forbidden
      agentControlJournalPayload({ ...terminal, script: 'return secret' });
      // @ts-expect-error cookies are forbidden
      agentControlJournalPayload({ ...terminal, cookie: 'session=secret' });
      // @ts-expect-error headers are forbidden
      agentControlJournalPayload({ ...terminal, header: 'Authorization: secret' });
      // @ts-expect-error absolute paths are forbidden
      agentControlJournalPayload({ ...terminal, absolutePath: '/Users/val/secret.txt' });
      agentControlJournalPayload({ kind: 'approval.requested', commandId: 'c', approvalId: 'a',
        payloadDigest: 'd', resource: createAgentControlJournalResource({ kind: 'project', id: '/repo' }),
        // @ts-expect-error approval effects must be constructor-produced redacted metadata
        capability: 'pane.close', effect: { kind: 'close', target: '/Users/val/secret-repo' } });
      agentControlJournalPayload({ ...terminal, receipt: {
        schema: 'psyche.control.receipt/v1', actionId: 'c', state: 'failed',
        // @ts-expect-error receipt resources must be constructor-produced path-free metadata
        resource: { kind: 'project', id: '/Users/val/secret-repo' },
        createdAt: '2026-08-12T00:00:00.000Z',
      } });
    }
    expect(true).toBe(true);
  });

  it('assigns monotonic sequences and restores idempotency records', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 3);
    await journal.append('command.requested', { commandId: 'c1', idempotencyKey: 'i1' });
    await journal.append('command.succeeded', { commandId: 'c1', idempotencyKey: 'i1' });
    const reopened = await ControlJournal.open(root, 3);
    expect(reopened.sequence).toBe(2);
    expect(reopened.findByIdempotencyKey('i1')?.kind).toBe('command.succeeded');
  });

  it('recovers a reused command id by the nonterminal idempotency key', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 7);
    await journal.append('command.requested', { commandId: 'reused', idempotencyKey: 'old-key' });
    await journal.append('command.succeeded', { commandId: 'reused', idempotencyKey: 'old-key' });
    await journal.append('command.requested', { commandId: 'reused', idempotencyKey: 'new-key' });
    await journal.append('command.running', { commandId: 'reused', idempotencyKey: 'new-key' });

    await expect(journal.recoverNonterminalCommands()).resolves.toEqual([
      expect.objectContaining({ kind: 'command.unknown', payload: expect.objectContaining({
        commandId: 'reused', idempotencyKey: 'new-key', reason: 'recovered-nonterminal',
      }) }),
    ]);
    expect(journal.findByIdempotencyKey('new-key')).toMatchObject({ kind: 'command.unknown' });
  });

  it('truncates only an incomplete final line', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 1);
    await journal.append('command.requested', { commandId: 'c1' });
    await appendFile(journal.path, '{"sequence":2');
    const reopened = await ControlJournal.open(root, 1);
    expect(reopened.sequence).toBe(1);
    expect(await readFile(reopened.path, 'utf8')).toMatch(/\n$/);
  });

  it('rejects corruption before the final line', async () => {
    const root = await newRoot('psyche-journal');
    const runtime = path.join(root, '.psyche', 'runtime');
    await mkdir(runtime, { recursive: true });
    await writeFile(path.join(runtime, 'events.ndjson'), '{"sequence":1}\nnot-json\n');
    await expect(ControlJournal.open(root, 1)).rejects.toThrow('journal corruption');
  });

  it('preserves a committed multibyte event when truncating an incomplete final line', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 1);
    await journal.append('command.requested', { commandId: 'c1', note: 'café ☕ 日本語' });
    await appendFile(journal.path, '{"sequence":2');
    const reopened = await ControlJournal.open(root, 1);
    expect(reopened.sequence).toBe(1);
    expect(reopened.read(0)).toHaveLength(1);
    expect(reopened.read(0)[0].payload.note).toBe('café ☕ 日本語');
    const again = await ControlJournal.open(root, 1);
    expect(again.sequence).toBe(1);
    expect(again.read(0)[0].payload.note).toBe('café ☕ 日本語');
  });

  it('resolves append and keeps the event durable even if a subscriber throws', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 1);
    journal.subscribe(() => { throw new Error('listener boom'); });
    await expect(journal.append('command.requested', { commandId: 'c1' }))
      .resolves.toMatchObject({ sequence: 1 });
    const reopened = await ControlJournal.open(root, 1);
    expect(reopened.sequence).toBe(1);
  });

  it('drops covered events from the file and from memory', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 3);
    for (let index = 1; index <= 6; index += 1) {
      await journal.append('command.succeeded', { commandId: `c${index}`, idempotencyKey: `i${index}` });
    }

    await journal.compact(4);

    expect(journal.firstSequence).toBe(5);
    expect(journal.sequence).toBe(6);
    expect(journal.read(0).map((event) => event.sequence)).toEqual([5, 6]);
    // The dropped keys leave the index with the events themselves.
    expect(journal.findByIdempotencyKey('i1')).toBeUndefined();
    expect(journal.findByIdempotencyKey('i6')?.kind).toBe('command.succeeded');
  });

  it('reopens a compacted journal and keeps appending contiguously', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 3);
    for (let index = 1; index <= 6; index += 1) {
      await journal.append('command.succeeded', { commandId: `c${index}`, idempotencyKey: `i${index}` });
    }
    await journal.compact(4);

    const reopened = await ControlJournal.open(root, 3);
    expect(reopened.firstSequence).toBe(5);
    expect(reopened.sequence).toBe(6);
    expect(reopened.read(0).map((event) => event.sequence)).toEqual([5, 6]);

    const appended = await reopened.append('command.succeeded', { commandId: 'c7', idempotencyKey: 'i7' });
    expect(appended.sequence).toBe(7);

    const again = await ControlJournal.open(root, 3);
    expect(again.read(0).map((event) => event.sequence)).toEqual([5, 6, 7]);
  });

  it('reopens a fully compacted journal at the right head', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 3);
    await journal.append('command.succeeded', { commandId: 'c1', idempotencyKey: 'i1' });
    await journal.append('command.succeeded', { commandId: 'c2', idempotencyKey: 'i2' });

    await journal.compact(2);

    const reopened = await ControlJournal.open(root, 3);
    expect(reopened.read(0)).toEqual([]);
    expect(reopened.sequence).toBe(2);
    expect((await reopened.append('command.succeeded', { commandId: 'c3' })).sequence).toBe(3);
  });

  it('still rejects a hole in the middle of a compacted journal', async () => {
    const root = await newRoot('psyche-journal');
    const runtime = path.join(root, '.psyche', 'runtime');
    await mkdir(runtime, { recursive: true });
    await writeFile(
      path.join(runtime, 'events.ndjson'),
      '{"journal":"psyche.control.journal/v1","firstSequence":5}\n{"sequence":5}\n{"sequence":7}\n',
    );
    await expect(ControlJournal.open(root, 1)).rejects.toThrow('journal corruption');
  });

  it('rejects a journal whose head does not match its declared first sequence', async () => {
    const root = await newRoot('psyche-journal');
    const runtime = path.join(root, '.psyche', 'runtime');
    await mkdir(runtime, { recursive: true });
    await writeFile(
      path.join(runtime, 'events.ndjson'),
      '{"journal":"psyche.control.journal/v1","firstSequence":5}\n{"sequence":6}\n',
    );
    await expect(ControlJournal.open(root, 1)).rejects.toThrow('journal corruption');
  });

  it('ignores a repeated or already-covered compaction', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 3);
    for (let index = 1; index <= 4; index += 1) {
      await journal.append('command.succeeded', { commandId: `c${index}`, idempotencyKey: `i${index}` });
    }
    await journal.compact(3);
    expect(journal.firstSequence).toBe(4);

    // Re-running the same compaction, or one below the head, changes nothing.
    await journal.compact(3);
    await journal.compact(1);

    expect(journal.firstSequence).toBe(4);
    expect(journal.read(0).map((event) => event.sequence)).toEqual([4]);
    const reopened = await ControlJournal.open(root, 3);
    expect(reopened.read(0).map((event) => event.sequence)).toEqual([4]);
  });

  it('serialises compaction against concurrent appends', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 3);
    for (let index = 1; index <= 4; index += 1) {
      await journal.append('command.succeeded', { commandId: `c${index}`, idempotencyKey: `i${index}` });
    }

    // Both are queued on the append tail without awaiting in between.
    const compaction = journal.compact(3);
    const appended = journal.append('command.succeeded', { commandId: 'c5', idempotencyKey: 'i5' });
    await Promise.all([compaction, appended]);

    expect((await appended).sequence).toBe(5);
    const reopened = await ControlJournal.open(root, 3);
    expect(reopened.read(0).map((event) => event.sequence)).toEqual([4, 5]);
  });

  it('round-trips a snapshot file with its durable extras', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 3);
    expect(await journal.loadSnapshot()).toBeUndefined();

    await journal.writeSnapshot({
      snapshot: { ownerEpoch: 3, sequence: 6, commands: {}, leases: {}, resources: [],
        capabilityLeases: [], leaseHistory: [], leaseRequests: [], approvals: [], receipts: [] } as any,
      coveredSequence: 4,
      outcomes: { 'i1': { status: 'succeeded' } as any },
      receiptRecords: [],
    });

    const loaded = await journal.loadSnapshot();
    expect(loaded?.coveredSequence).toBe(4);
    expect(loaded?.outcomes.i1).toMatchObject({ status: 'succeeded' });
  });

  it('tolerates trailing blank lines in the journal file', async () => {
    const root = await newRoot('psyche-journal');
    const journal = await ControlJournal.open(root, 1);
    await journal.append('command.requested', { commandId: 'c1' });
    await appendFile(journal.path, '\n');
    const reopened = await ControlJournal.open(root, 1);
    expect(reopened.sequence).toBe(1);
  });
});
