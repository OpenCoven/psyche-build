import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppSupportBundle } from './helpers/appSupportFixture.js';

const injected = vi.hoisted(() => ({ fault: '', abort: null as AbortController | null, configRead: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (injected.fault === 'scope' && String(args[0]).endsWith('worktree-recovery')) injected.configRead = true;
      if (injected.fault === 'collector' && String(args[0]).endsWith('worktree-recovery')) throw Object.assign(new Error('PRIVATE_SYNTHETIC_476'), { code: 'EACCES' });
      return actual.readdir(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (String(args[0]).includes('/support-bundles/')) {
        if (injected.fault === 'full' || injected.fault === 'denied') {
          throw Object.assign(new Error('/PRIVATE_SYNTHETIC_STORAGE_476'), { code: injected.fault === 'full' ? 'ENOSPC' : 'EACCES' });
        }
        if (injected.fault === 'before_commit') {
          await actual.writeFile(...args); injected.abort!.abort(); return;
        }
      }
      return actual.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      if (injected.fault === 'after_commit' && String(args[1]).includes('/support-bundles/')) injected.abort!.abort();
    },
  };
});
const roots: string[] = [];
async function project() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'psyche-support-fault-')));
  roots.push(root); return root;
}
afterEach(async () => {
  injected.fault = ''; injected.abort = null; injected.configRead = false;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function request(projectRoot: string) { return { projectRoot, releaseVersion: '0.0.3', sourceSha: '3'.repeat(40) }; }
describe('support storage failures at the real persistence boundary', () => {
  it('exports a truthful omission when a collector fails but the rest of the bundle can be saved', async () => {
    const root = await project(); injected.fault = 'collector';
    const result = await createAppSupportBundle(request(root));
    expect(result.state).toBe('saved');
    expect(result.categories).toContainEqual({ category: 'persistence', disposition: 'omitted', reason: 'collection_failed' });
    const bundle = JSON.parse(await readFile(result.path!, 'utf8'));
    expect(bundle.errors).toContainEqual(expect.objectContaining({ collector: 'persistence', code: 'collection_failed' }));
    expect(bundle.records).toContainEqual(expect.objectContaining({ component: 'persistence', event: 'omitted', attributes: { state: 'unavailable' } }));
  });
  it('refuses a symlinked runtime boundary before reading project diagnostic inputs', async () => {
    const root = await project(), outside = await project();
    await mkdir(path.join(outside, 'runtime'));
    await writeFile(path.join(outside, 'psyche.config.json'), '{"panes":[]}');
    await symlink(outside, path.join(root, '.psyche'));
    injected.fault = 'scope';
    expect(await createAppSupportBundle(request(root))).toEqual({ state: 'failed', code: 'write_failed' });
    expect(injected.configRead).toBe(false);
  });
  it.each(['full', 'denied'])('reports %s storage without damaging an existing bundle or copying the error', async fault => {
    const root = await project();
    const prior = await createAppSupportBundle(request(root));
    const bytes = await readFile(prior.path!);
    injected.fault = fault;
    const result = await createAppSupportBundle(request(root));
    expect(result).toEqual({ state: 'failed', code: 'write_failed' });
    expect(await readFile(prior.path!)).toEqual(bytes);
    expect((await readdir(path.dirname(prior.path!))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
  it('cancels after writing the temporary file but before rename and removes only that temporary file', async () => {
    const root = await project(); injected.fault = 'before_commit'; injected.abort = new AbortController();
    expect(await createAppSupportBundle(request(root), injected.abort.signal)).toEqual({ state: 'cancelled', code: 'cancelled' });
    expect(await readdir(path.join(root, '.psyche/runtime/support-bundles'))).toEqual([]);
  });
  it('returns the saved file when cancellation arrives after the commit point', async () => {
    const root = await project(); injected.fault = 'after_commit'; injected.abort = new AbortController();
    const result = await createAppSupportBundle(request(root), injected.abort.signal);
    expect(result.state).toBe('saved');
    expect(JSON.parse(await readFile(result.path!, 'utf8')).schema).toBe('psyche.diagnostics/v1');
  });
});
