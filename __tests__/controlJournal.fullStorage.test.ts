import { mkdir, readFile, rm } from 'node:fs/promises';
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
});
