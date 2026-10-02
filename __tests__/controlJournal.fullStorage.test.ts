import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearStorageFaults, injectStorageFault } from './helpers/storageFaults.js';

vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./helpers/storageFaults.js')).faultyFsPromises(await importOriginal()));

const { ControlJournal } = await import('../src/control/journal.js');

const roots: string[] = [];
afterEach(async () => {
  clearStorageFaults();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newRoot(): Promise<string> {
  const root = path.join(process.cwd(), '.test-artifacts', `journal-full-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  roots.push(root);
  return root;
}

const journalPathOf = (root: string) => path.join(root, '.psyche', 'runtime', 'events.ndjson');

describe('control journal append on full storage', () => {
  it.each([
    ['ENOSPC mid-write', { code: 'ENOSPC', afterBytes: 12 }],
    ['EDQUOT mid-write', { code: 'EDQUOT', afterBytes: 12 }],
    ['ENOSPC at fsync', { code: 'ENOSPC', at: 'sync' }],
  ] as const)('%s rolls the torn line back so later appends and reopen keep every prior event', async (_label, spec) => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 1);
    await journal.append('first', { n: 1 });
    await journal.append('second', { n: 2 });
    const journalPath = journalPathOf(root);
    const prior = await readFile(journalPath);

    const fault = injectStorageFault({ ...spec, match: (filePath) => filePath === journalPath });
    await expect(journal.append('lost', { n: 3 })).rejects.toMatchObject({ code: spec.code });
    // At fsync the rollback's own sync fails too; the journal then repairs the
    // length before its next append instead.
    expect(fault.landed).toBeGreaterThanOrEqual(1);
    fault.remove();

    // The failed event was never acknowledged, so it is neither in memory nor on disk.
    expect(journal.sequence).toBe(2);
    expect(await readFile(journalPath)).toEqual(prior);

    // A later append must not bury a torn fragment mid-file, which would make
    // the whole journal unreadable on the next open.
    const third = await journal.append('third', { n: 3 });
    expect(third.sequence).toBe(3);

    const reopened = await ControlJournal.open(root, 2);
    expect(reopened.read(0).map((event) => event.kind)).toEqual(['first', 'second', 'third']);
  });

  it('a failed rollback remembered across compaction never pads the journal with NULs', async () => {
    // Reproduces the review finding: 6 appends, a sync fault (so the rollback's
    // own sync fails and the committed length is remembered), compact(5), then
    // one append. The remembered length predates compaction, so truncating to
    // it would extend the now-shorter file with NUL bytes.
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 1);
    for (let n = 1; n <= 6; n += 1) await journal.append(`event-${n}`, { n, pad: 'x'.repeat(200) });
    const journalPath = journalPathOf(root);

    const fault = injectStorageFault({ code: 'ENOSPC', at: 'sync', match: (filePath) => filePath === journalPath });
    await expect(journal.append('lost', { n: 7 })).rejects.toMatchObject({ code: 'ENOSPC' });
    fault.remove();

    await journal.compact(5);
    const compactedLength = (await readFile(journalPath)).length;
    await journal.append('after-compaction', { n: 7 });

    const raw = await readFile(journalPath);
    expect(raw.includes(0)).toBe(false);
    expect(raw.length).toBeGreaterThan(compactedLength);
    const reopened = await ControlJournal.open(root, 2);
    expect(reopened.read(0).map((event) => event.kind)).toEqual(['event-6', 'after-compaction']);
  });

  it('refuses to append rather than extend a journal shorter than its remembered committed length', async () => {
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 1);
    await journal.append('first', { n: 1 });
    await journal.append('second', { n: 2 });
    const journalPath = journalPathOf(root);

    const fault = injectStorageFault({ code: 'ENOSPC', at: 'sync', match: (filePath) => filePath === journalPath });
    await expect(journal.append('lost', { n: 3 })).rejects.toMatchObject({ code: 'ENOSPC' });
    fault.remove();

    // Something outside this journal shortened the file below what was committed.
    const committed = await readFile(journalPath);
    const { truncate } = await import('node:fs/promises');
    await truncate(journalPath, 10);
    await expect(journal.append('third', { n: 3 })).rejects.toThrow(/refusing to append/);
    const after = await readFile(journalPath);
    expect(after.length).toBe(10);
    expect(after.includes(0)).toBe(false);
    expect(committed.length).toBeGreaterThan(10);
  });

  it('a newline-less tail of valid JSON is uncommitted: not replayed, and truncated on open', async () => {
    // A full disk can stop an append right after the closing brace. If the
    // rollback then also fails and the process restarts, the in-memory
    // rollback position is gone; replay alone must keep the rejected event out.
    const root = await newRoot();
    const journal = await ControlJournal.open(root, 1);
    await journal.append('first', { n: 1 });
    await journal.append('second', { n: 2 });
    const journalPath = journalPathOf(root);
    const committed = await readFile(journalPath);

    const rejected = { sequence: 3, kind: 'rejected', payload: { n: 3 } };
    await appendFile(journalPath, JSON.stringify(rejected), 'utf8');

    const reopened = await ControlJournal.open(root, 2);
    expect(reopened.read(0).map((event) => event.kind)).toEqual(['first', 'second']);
    expect(reopened.sequence).toBe(2);
    expect(await readFile(journalPath)).toEqual(committed);

    const next = await reopened.append('third', { n: 3 });
    expect(next.sequence).toBe(3);
    const again = await ControlJournal.open(root, 3);
    expect(again.read(0).map((event) => event.kind)).toEqual(['first', 'second', 'third']);
  });
});
