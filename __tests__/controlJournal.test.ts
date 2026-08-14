import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-journal-'));
    roots.push(root);
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
          leaseId: 'lease-1',
          leaseRevision: 2,
        }),
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
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-journal-'));
    roots.push(root);
    const journal = await ControlJournal.open(root, 3);
    await journal.append('command.requested', { commandId: 'c1', idempotencyKey: 'i1' });
    await journal.append('command.succeeded', { commandId: 'c1', idempotencyKey: 'i1' });
    const reopened = await ControlJournal.open(root, 3);
    expect(reopened.sequence).toBe(2);
    expect(reopened.findByIdempotencyKey('i1')?.kind).toBe('command.succeeded');
  });

  it('recovers a reused command id by the nonterminal idempotency key', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-journal-'));
    roots.push(root);
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
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-journal-'));
    roots.push(root);
    const journal = await ControlJournal.open(root, 1);
    await journal.append('command.requested', { commandId: 'c1' });
    await appendFile(journal.path, '{"sequence":2');
    const reopened = await ControlJournal.open(root, 1);
    expect(reopened.sequence).toBe(1);
    expect(await readFile(reopened.path, 'utf8')).toMatch(/\n$/);
  });

  it('rejects corruption before the final line', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-journal-'));
    roots.push(root);
    const runtime = path.join(root, '.psyche', 'runtime');
    await mkdir(runtime, { recursive: true });
    await writeFile(path.join(runtime, 'events.ndjson'), '{"sequence":1}\nnot-json\n');
    await expect(ControlJournal.open(root, 1)).rejects.toThrow('journal corruption');
  });

  it('preserves a committed multibyte event when truncating an incomplete final line', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-journal-'));
    roots.push(root);
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
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-journal-'));
    roots.push(root);
    const journal = await ControlJournal.open(root, 1);
    journal.subscribe(() => { throw new Error('listener boom'); });
    await expect(journal.append('command.requested', { commandId: 'c1' }))
      .resolves.toMatchObject({ sequence: 1 });
    const reopened = await ControlJournal.open(root, 1);
    expect(reopened.sequence).toBe(1);
  });

  it('tolerates trailing blank lines in the journal file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-journal-'));
    roots.push(root);
    const journal = await ControlJournal.open(root, 1);
    await journal.append('command.requested', { commandId: 'c1' });
    await appendFile(journal.path, '\n');
    const reopened = await ControlJournal.open(root, 1);
    expect(reopened.sequence).toBe(1);
  });
});
