import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearStorageFaults, injectStorageFault, temporaryLeftovers } from './helpers/storageFaults.js';

vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./helpers/storageFaults.js')).faultyFsPromises(await importOriginal()));
vi.mock('node:fs', async (importOriginal) =>
  (await import('./helpers/storageFaults.js')).faultyFs(await importOriginal()));

const { AtomicWriteOutsideRootError, atomicWriteFile, atomicWriteFileSync, atomicWriteJson } =
  await import('../src/utils/atomicWrite.js');

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

  it('keeps an existing target\'s permission bits when no mode is given', async () => {
    await chmod(target, 0o600);
    await atomicWriteFile(target, NEXT);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    atomicWriteFileSync(target, PRIOR);
    expect((await stat(target)).mode & 0o777).toBe(0o600);

    await chmod(target, 0o640);
    await atomicWriteFile(target, NEXT);
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it('an explicit mode wins over the existing target\'s bits', async () => {
    await chmod(target, 0o644);
    await atomicWriteFile(target, NEXT, { mode: 0o600 });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it('followSymlinks replaces the linked file and keeps the link', async () => {
    const realDir = path.join(dir, 'dotfiles');
    await mkdir(realDir);
    const realTarget = path.join(realDir, 'settings.json');
    await writeFile(realTarget, PRIOR, 'utf8');
    await chmod(realTarget, 0o600);
    const link = path.join(dir, 'linked.json');
    await symlink(realTarget, link);

    await atomicWriteFile(link, NEXT, { followSymlinks: true });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(realTarget);
    expect(await readFile(realTarget, 'utf8')).toBe(NEXT);
    expect((await stat(realTarget)).mode & 0o777).toBe(0o600);

    atomicWriteFileSync(link, PRIOR, { followSymlinks: true });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(realTarget, 'utf8')).toBe(PRIOR);
    expect(temporaryLeftovers(await readdir(realDir))).toEqual([]);
    expect(temporaryLeftovers(await readdir(dir))).toEqual([]);
  });

  it('followSymlinks on a full disk keeps the linked bytes and cleans the temp beside the real target', async () => {
    const realDir = path.join(dir, 'dotfiles');
    await mkdir(realDir);
    const realTarget = path.join(realDir, 'settings.json');
    await writeFile(realTarget, PRIOR, 'utf8');
    const link = path.join(dir, 'linked.json');
    await symlink(realTarget, link);

    const fault = injectStorageFault({ code: 'ENOSPC', afterBytes: 10, match: (p) => tempOnly(p) && path.basename(p).startsWith('.settings.json.') });
    await expect(atomicWriteFile(link, NEXT, { followSymlinks: true })).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(fault.landed).toBe(1);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(realTarget, 'utf8')).toBe(PRIOR);
    expect(temporaryLeftovers(await readdir(realDir))).toEqual([]);
  });

  it('without followSymlinks a link at the target is replaced, never followed', async () => {
    const outside = path.join(dir, 'outside.json');
    await writeFile(outside, PRIOR, 'utf8');
    const link = path.join(dir, 'private.json');
    await symlink(outside, link);

    await atomicWriteFile(link, NEXT);
    expect((await lstat(link)).isSymbolicLink()).toBe(false);
    expect(await readFile(link, 'utf8')).toBe(NEXT);
    expect(await readFile(outside, 'utf8')).toBe(PRIOR);
  });

  it('a planted symlink lends no mode, and setuid bits are never copied', async () => {
    const outside = path.join(dir, 'loose.json');
    await writeFile(outside, PRIOR, 'utf8');
    await chmod(outside, 0o777);
    const link = path.join(dir, 'epoch.json');
    await symlink(outside, link);

    await atomicWriteFile(link, NEXT);
    expect((await lstat(link)).isSymbolicLink()).toBe(false);
    // Created fresh under umask, not 0777 borrowed from the link's target.
    expect((await stat(link)).mode & 0o777).not.toBe(0o777);
    expect((await stat(link)).mode & 0o002).toBe(0);

    await chmod(target, 0o4755);
    await atomicWriteFile(target, NEXT);
    expect((await stat(target)).mode & 0o7777).toBe(0o755);
  });

  it('followSymlinks creates the file a dangling link names and keeps the link', async () => {
    const realDir = path.join(dir, 'dotfiles');
    await mkdir(realDir);
    const missing = path.join(realDir, 'not-yet.json');
    const link = path.join(dir, 'dangling.json');
    await symlink(missing, link);

    await atomicWriteFile(link, NEXT, { followSymlinks: true });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(missing, 'utf8')).toBe(NEXT);

    const relativeMissing = path.join(realDir, 'relative.json');
    const relativeLink = path.join(dir, 'relative-link.json');
    await symlink(path.join('dotfiles', 'relative.json'), relativeLink);
    atomicWriteFileSync(relativeLink, PRIOR, { followSymlinks: true });
    expect((await lstat(relativeLink)).isSymbolicLink()).toBe(true);
    expect(await readFile(relativeMissing, 'utf8')).toBe(PRIOR);
  });

  it('followSymlinks raises ELOOP on a symlink loop and leaves the links alone', async () => {
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    await symlink(b, a);
    await symlink(a, b);

    await expect(atomicWriteFile(a, NEXT, { followSymlinks: true })).rejects.toMatchObject({ code: 'ELOOP' });
    expect(() => atomicWriteFileSync(a, NEXT, { followSymlinks: true }))
      .toThrow(expect.objectContaining({ code: 'ELOOP' }));
    expect((await lstat(a)).isSymbolicLink()).toBe(true);
    expect((await lstat(b)).isSymbolicLink()).toBe(true);
    expect(temporaryLeftovers(await readdir(dir))).toEqual([]);
  });

  it('followSymlinks within a root refuses a link that leaves it and follows one that stays', async () => {
    const project = path.join(dir, 'project');
    await mkdir(path.join(project, '.psyche'), { recursive: true });
    const outside = path.join(dir, 'user-file.txt');
    await writeFile(outside, PRIOR, 'utf8');
    const escaping = path.join(project, '.psyche', 'settings.json');
    await symlink(outside, escaping);

    const refused = await atomicWriteFile(escaping, NEXT, { followSymlinks: { within: project } })
      .then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(AtomicWriteOutsideRootError);
    expect((refused as Error).message).not.toContain(dir);
    expect(() => atomicWriteFileSync(escaping, NEXT, { followSymlinks: { within: project } }))
      .toThrow(AtomicWriteOutsideRootError);
    expect(await readFile(outside, 'utf8')).toBe(PRIOR);
    expect((await lstat(escaping)).isSymbolicLink()).toBe(true);

    const inside = path.join(project, 'shared.json');
    await writeFile(inside, PRIOR, 'utf8');
    const staying = path.join(project, '.psyche', 'rituals.json');
    await symlink(inside, staying);
    await atomicWriteFile(staying, NEXT, { followSymlinks: { within: project } });
    expect((await lstat(staying)).isSymbolicLink()).toBe(true);
    expect(await readFile(inside, 'utf8')).toBe(NEXT);
  });
});
