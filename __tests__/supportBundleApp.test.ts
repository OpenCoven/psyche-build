import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppSupportBundle, type AppSupportRequest } from '../src/diagnostics/supportBundleApp.js';
import { isSupportBundleV1 } from '../src/diagnostics/supportBundle.js';
import { writeSupportBundleFile } from '../src/diagnostics/supportBundleStore.js';

const roots: string[] = [];
async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'psyche-support-app-'));
  roots.push(root);
  // macOS /var is a symlink; application requests use canonical identities.
  return (await import('node:fs/promises')).realpath(root);
}
function request(root: string): AppSupportRequest {
  return { projectRoot: root, releaseVersion: '0.0.3', sourceSha: '1'.repeat(40),
    graphics: { engine: 'wkwebview', accelerated: 'unknown' },
    lifecycle: { panes: 2 }, updater: { checksEnabled: false, state: 'disabled' } };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('application support bundle', () => {
  it('writes the real v1 bundle at 0600 with native facts and explicit category accounting', async () => {
    const root = await project();
    const result = await createAppSupportBundle(request(root));
    expect(result.state).toBe('saved');
    expect(result.path).toBeDefined();
    const text = await readFile(result.path!, 'utf8');
    const bundle = JSON.parse(text);
    expect(isSupportBundleV1(bundle)).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65536);
    expect((await stat(result.path!)).mode & 0o777).toBe(0o600);
    expect(bundle.provenance).toMatchObject({ sourceSha: '1'.repeat(40), verification: 'unverified' });
    expect(bundle.status).toBe('partial');
    expect(bundle.lifecycle).toEqual({ panes: 2, state: 'available' });
    expect(bundle.updater).toEqual({ mode: 'disabled', state: 'disabled' });
    expect(bundle.graphics).toEqual({ engine: 'wkwebview', accelerated: 'unknown', state: 'partial' });
    expect(bundle.receipts).toEqual([]);
    expect(bundle.terminalTail).toEqual([]);
    expect(result.categories).toEqual([
      { category: 'provenance', disposition: 'collected', reason: 'unverified' },
      { category: 'persistence', disposition: 'collected', reason: 'project_recovery_only' },
      { category: 'providers', disposition: 'collected', reason: 'filesystem_only' },
      { category: 'lifecycle', disposition: 'collected', reason: 'counts_only' },
      { category: 'updater', disposition: 'collected', reason: 'native_snapshot' },
      { category: 'graphics', disposition: 'collected', reason: 'engine_only' },
      { category: 'receipts', disposition: 'omitted', reason: 'owner_unavailable' },
      { category: 'terminal', disposition: 'omitted', reason: 'content_excluded' },
    ]);
    expect(bundle.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: 'receipts', event: 'omitted', attributes: { state: 'unavailable' } }),
      expect.objectContaining({ component: 'terminal', event: 'omitted', attributes: { state: 'unsupported' } }),
    ]));
    expect(bundle.redaction.omittedFields).toBe(0);
    expect(result.fileName).toMatch(/^psyche-support-\d{8}T\d{6}Z-[0-9a-f]{12}\.json$/);
  });

  it('omits synthetic private project content and never opens an executable provider', async () => {
    const root = await project();
    await mkdir(path.join(root, '.psyche'));
    const marker = 'PRIVATE_SYNTHETIC_476_DO_NOT_EXPORT';
    await writeFile(path.join(root, '.psyche', 'psyche.config.json'), JSON.stringify({ panes: [], prompt: marker, env: { SECRET: marker } }));
    const result = await createAppSupportBundle({ ...request(root), prompt: marker, receipts: [{ message: marker }] } as AppSupportRequest);
    expect(result.state).toBe('saved');
    const text = await readFile(result.path!, 'utf8');
    expect(text).not.toContain(marker);
    expect(text).not.toContain(root);
    expect(text).not.toContain(os.homedir());
  });

  it('keeps malformed project state local and marks missing native categories as omissions', async () => {
    const root = await project();
    await mkdir(path.join(root, '.psyche'));
    await writeFile(path.join(root, '.psyche', 'psyche.config.json'), '{BROKEN_PRIVATE_476');
    const result = await createAppSupportBundle({ projectRoot: root, releaseVersion: '0.0.3', sourceSha: '1'.repeat(40) });
    expect(result.state).toBe('saved');
    expect(result.categories).toContainEqual({ category: 'graphics', disposition: 'omitted', reason: 'owner_unavailable' });
    expect(result.categories).toContainEqual({ category: 'lifecycle', disposition: 'omitted', reason: 'owner_unavailable' });
    expect(await readFile(result.path!, 'utf8')).not.toContain('BROKEN_PRIVATE_476');
  });

  it('cancels before persistence without creating a bundle', async () => {
    const root = await project();
    const controller = new AbortController();
    controller.abort();
    const result = await createAppSupportBundle(request(root), controller.signal);
    expect(result).toEqual({ state: 'cancelled', code: 'cancelled' });
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses a symlinked project runtime destination without writing outside the project', async () => {
    const root = await project();
    const outside = await project();
    await symlink(outside, path.join(root, '.psyche'));
    expect(await createAppSupportBundle(request(root))).toEqual({ state: 'failed', code: 'write_failed' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('reports a non-directory storage failure with no raw path or exception', async () => {
    const root = await project();
    await writeFile(path.join(root, '.psyche'), 'keep');
    expect(await createAppSupportBundle(request(root))).toEqual({ state: 'failed', code: 'write_failed' });
    expect(await readFile(path.join(root, '.psyche'), 'utf8')).toBe('keep');
  });

  it('honors an aborted write before filesystem effects', async () => {
    const root = await project();
    const controller = new AbortController(); controller.abort();
    await expect(writeSupportBundleFile({ directory: path.join(root, 'new'), filename: 'bundle.json', serialized: '{}', signal: controller.signal })).rejects.toBeDefined();
    expect(await readdir(root)).toEqual([]);
  });

  it('bounds repeated exports with the existing store while preserving unrelated files', async () => {
    const root = await project();
    const first = await createAppSupportBundle(request(root));
    const directory = path.dirname(first.path!);
    await writeFile(path.join(directory, 'keep.txt'), 'unrelated');
    for (let i = 0; i < 12; i++) await createAppSupportBundle(request(root));
    expect((await readdir(directory)).filter(name => name.endsWith('.json')).length).toBeLessThanOrEqual(10);
    expect(await readFile(path.join(directory, 'keep.txt'), 'utf8')).toBe('unrelated');
  });
});
