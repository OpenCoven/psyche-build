import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fixtureStore } from './helpers/appSupportFixture.js';

const { build } = createRequire(path.join(process.cwd(), 'native/desktop/psyche-build-tauri/package.json'))('esbuild') as { build: (options: Record<string, unknown>) => Promise<unknown> };
let directory: string;
let worker: string;
const projects: string[] = [];
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'psyche-support-worker-'));
  worker = path.join(directory, 'worker.cjs');
  await build({ entryPoints: ['src/diagnostics/supportBundleWorker.ts'], outfile: worker,
    platform: 'node', format: 'cjs', bundle: true, minify: true, logLevel: 'silent' });
});
afterEach(async () => { await Promise.all(projects.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function root() {
  const result = await mkdtemp(path.join(os.tmpdir(), 'psyche-support-worker-project-'));
  projects.push(result); return realpath(result);
}
async function run(input: string): Promise<Record<string, any>> {
  const child = spawn(process.execPath, [worker, '--native-store'], { cwd: directory,
    env: { PATH: path.dirname(process.execPath), HOME: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = ''; let errors = ''; let output = '';
  let requestedRoot = '';
  try { requestedRoot = JSON.parse(input.split('\n')[0]).projectRoot; } catch { /* malformed-request fixture */ }
  child.stdout.on('data', async chunk => {
    pending += String(chunk);
    expect(Buffer.byteLength(pending)).toBeLessThan(256 * 1024);
    for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
      const message = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      if (message.kind === 'persist') {
        try {
          const written = await fixtureStore(requestedRoot)(message.request);
          child.stdin.write(JSON.stringify({ kind: 'persisted', ok: true, written }) + '\n');
        } catch { child.stdin.write(JSON.stringify({ kind: 'persisted', ok: false, code: 'write_failed' }) + '\n'); }
      } else {
        expect(message.kind).toBe('result'); output = JSON.stringify(message.result); child.stdin.end();
      }
    }
  });
  child.stderr.on('data', chunk => { errors += String(chunk); });
  child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') errors += 'stdin_failed'; });
  child.stdin.write(input);
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  expect(errors).toBe('');
  expect(code).toBe(0);
  expect(Buffer.byteLength(output)).toBeLessThan(16384);
  return JSON.parse(output);
}
describe('embedded support worker', () => {
  it('runs outside a source checkout with no installed CLI and saves a bounded private bundle', async () => {
    const provider = path.join(directory, '.local/bin/claude');
    await mkdir(path.dirname(provider), { recursive: true });
    await writeFile(provider, '#!/bin/sh\nprintf executed > "$0.executed"\n', { mode: 0o755 });
    const result = await run(JSON.stringify({ projectRoot: await root(), sourceSha: '2'.repeat(40), releaseVersion: '0.0.3' }) + '\n');
    expect(result.state).toBe('saved');
    const text = await readFile(result.path, 'utf8');
    expect(JSON.parse(text).schema).toBe('psyche.diagnostics/v1');
    expect(text).not.toContain(directory);
    expect(JSON.parse(text).providers.count).toBeGreaterThanOrEqual(1);
    await expect(access(provider + '.executed')).rejects.toHaveProperty('code', 'ENOENT');
  });
  it.each([{ name: 'malformed JSON', input: '{not json}\n' }, { name: 'oversized input', input: 'x'.repeat(16385) }, { name: 'relative root', input: JSON.stringify({ projectRoot: 'relative' }) + '\n' }])('refuses $name', async ({ input }) => {
    expect(await run(input)).toEqual({ state: 'failed', code: 'invalid_request' });
  });
  it('honors cooperative cancellation received while collection starts', async () => {
    const input = JSON.stringify({ projectRoot: await root(), sourceSha: '2'.repeat(40), releaseVersion: '0.0.3' });
    expect(await run(input + '\ncancel\n')).toEqual({ state: 'cancelled', code: 'cancelled' });
  });
  it('rejects caller-supplied graphics strings rather than exporting arbitrary text', async () => {
    expect(await run(JSON.stringify({ projectRoot: await root(), sourceSha: '2'.repeat(40), releaseVersion: '0.0.3',
      graphics: { engine: 'PRIVATE_INPUT_476', accelerated: 'unknown' } }) + '\n')).toEqual({ state: 'failed', code: 'invalid_request' });
  });
});
