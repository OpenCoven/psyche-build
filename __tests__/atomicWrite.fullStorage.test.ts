import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearStorageFaults, injectStorageFault, temporaryLeftovers } from './helpers/storageFaults.js';

vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./helpers/storageFaults.js')).faultyFsPromises(await importOriginal()));
vi.mock('node:fs', async (importOriginal) =>
  (await import('./helpers/storageFaults.js')).faultyFs(await importOriginal()));

const { atomicWriteFile, atomicWriteFileSync, atomicWriteJson } = await import('../src/utils/atomicWrite.js');

const PRIOR = '{"prior":"state that must survive"}\n';
const NEXT = JSON.stringify({ next: 'x'.repeat(4096) });

describe('atomic writes on full storage', () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'psyche-atomic-full-'));
    target = path.join(dir, 'state.json');
    await writeFile(target, PRIOR, 'utf8');
  });

  afterEach(async () => {
    clearStorageFaults();
    await rm(dir, { recursive: true, force: true });
  });

  const tempOnly = (filePath: string) => filePath.endsWith('.tmp');

  it.each(['ENOSPC', 'EDQUOT'] as const)(
    'async: %s after a partial write keeps the prior bytes and leaks no temp file',
    async (code) => {
      const fault = injectStorageFault({ code, afterBytes: 100, match: tempOnly });
      await expect(atomicWriteFile(target, NEXT)).rejects.toMatchObject({ code });
      expect(fault.landed).toBe(1);
      expect(fault.bytesWritten).toBe(100);
      expect(await readFile(target, 'utf8')).toBe(PRIOR);
      expect(temporaryLeftovers(await readdir(dir))).toEqual([]);
    },
  );

  it('async: a full disk reported only at fsync never publishes the unsynced file', async () => {
    const fault = injectStorageFault({ code: 'ENOSPC', at: 'sync', match: tempOnly });
    await expect(atomicWriteJson(target, { next: true })).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(fault.landed).toBe(1);
    expect(await readFile(target, 'utf8')).toBe(PRIOR);
    expect(temporaryLeftovers(await readdir(dir))).toEqual([]);
  });

  it.each(['ENOSPC', 'EDQUOT'] as const)(
    'sync: %s after a partial write keeps the prior bytes and leaks no temp file',
    async (code) => {
      const fault = injectStorageFault({ code, afterBytes: 100, match: tempOnly });
      expect(() => atomicWriteFileSync(target, NEXT)).toThrow(expect.objectContaining({ code }));
      expect(fault.landed).toBe(1);
      expect(await readFile(target, 'utf8')).toBe(PRIOR);
      expect(temporaryLeftovers(await readdir(dir))).toEqual([]);
    },
  );

  it('sync: a full disk reported only at fsync never publishes the unsynced file', async () => {
    const fault = injectStorageFault({ code: 'ENOSPC', at: 'sync', match: tempOnly });
    expect(() => atomicWriteFileSync(target, NEXT)).toThrow(expect.objectContaining({ code: 'ENOSPC' }));
    expect(fault.landed).toBe(1);
    expect(await readFile(target, 'utf8')).toBe(PRIOR);
    expect(temporaryLeftovers(await readdir(dir))).toEqual([]);
  });

  it('still replaces the file whole when storage has room', async () => {
    await atomicWriteFile(target, NEXT);
    expect(await readFile(target, 'utf8')).toBe(NEXT);
    atomicWriteFileSync(target, PRIOR);
    expect(await readFile(target, 'utf8')).toBe(PRIOR);
    expect(temporaryLeftovers(await readdir(dir))).toEqual([]);
  });
});
