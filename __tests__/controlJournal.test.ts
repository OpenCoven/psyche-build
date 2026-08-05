import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlJournal } from '../src/control/journal.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ControlJournal', () => {
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
