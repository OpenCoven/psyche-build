import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { createAppSupportBundle, type AppSupportRequest, type AppSupportResult } from './supportBundleApp.js';
import type { NativeSupportStore, WrittenSupportBundle } from './supportBundleStore.js';

// The embedded worker accepts one bounded request and fixed cancellation
// messages. No executable, destination, environment or raw content is accepted.
const controller = new AbortController();
let pending = Buffer.alloc(0);
let received = 0;
let running = false;
let done = false;
let badControl = false;
const invalidResult = { state: 'failed', code: 'invalid_request' } as const;
const nativeMode = process.argv.includes('--native-store');
let persistence: { resolve: (written: WrittenSupportBundle) => void; reject: (error: Error) => void } | undefined;
const nativeStore: NativeSupportStore = (request) => new Promise((resolve, reject) => {
  if (!nativeMode || persistence) { reject(new Error('secure store unavailable')); return; }
  persistence = { resolve, reject };
  process.stdout.write(JSON.stringify({ kind: 'persist', request }) + '\n');
});
function finish(result: AppSupportResult): void {
  if (done) return;
  done = true;
  process.stdout.write(JSON.stringify(nativeMode ? { kind: 'result', result } : result) + '\n');
  process.stdin.destroy();
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function valid(value: unknown): value is AppSupportRequest {
  if (!record(value) || !only(value, ['projectRoot', 'releaseVersion', 'sourceSha', 'graphics', 'lifecycle', 'updater'])) return false;
  if (typeof value.projectRoot !== 'string' || value.projectRoot.length > 8192 || !path.isAbsolute(value.projectRoot)) return false;
  if (typeof value.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(value.sourceSha) || /^0+$/.test(value.sourceSha)) return false;
  if (typeof value.releaseVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,32})?$/.test(value.releaseVersion)) return false;
  if (value.graphics !== undefined && (!record(value.graphics) || !only(value.graphics, ['engine', 'accelerated'])
    || !['wkwebview', 'webview2', 'webkitgtk'].includes(String(value.graphics.engine)) || value.graphics.accelerated !== 'unknown')) return false;
  if (value.lifecycle !== undefined && (!record(value.lifecycle) || !only(value.lifecycle, ['panes'])
    || !Number.isSafeInteger(value.lifecycle.panes) || Number(value.lifecycle.panes) < 0 || Number(value.lifecycle.panes) > 10000)) return false;
  if (value.updater !== undefined && (!record(value.updater) || !only(value.updater, ['state', 'checksEnabled'])
    || typeof value.updater.checksEnabled !== 'boolean' || !['disabled', 'available', 'unknown', 'unavailable'].includes(String(value.updater.state)))) return false;
  return true;
}
async function collect(value: unknown): Promise<void> {
  try {
    if (!valid(value) || await realpath(value.projectRoot) !== value.projectRoot || !(await stat(value.projectRoot)).isDirectory()) {
      finish(invalidResult); return;
    }
    const result = await createAppSupportBundle(value, controller.signal, nativeMode ? nativeStore : undefined);
    // A committed write remains saved if a later cancellation races with it.
    finish(badControl && result.state !== 'saved' ? invalidResult : result);
  } catch { finish(invalidResult); }
}
function invalid(): void {
  badControl = true;
  controller.abort();
  const waiting = persistence; persistence = undefined;
  waiting?.reject(new Error('invalid persistence control'));
  if (!running) finish(invalidResult);
}
process.stdin.on('data', (chunk: Buffer) => {
  if (done) return;
  received += chunk.length;
  // The initial request is small. A valid native acknowledgement can contain
  // up to 4096 retention names; bound that separate phase without stranding it.
  const budget = nativeMode && running ? 300 * 1024 : 16384;
  if (received > budget) { invalid(); return; }
  pending = Buffer.concat([pending, chunk]);
  while (pending.includes(10)) {
    const end = pending.indexOf(10);
    const line = pending.subarray(0, end).toString('utf8');
    pending = pending.subarray(end + 1);
    if (running) {
      if (line === 'cancel') controller.abort();
      else if (nativeMode && persistence) {
        let response: unknown;
        try { response = JSON.parse(line); } catch { invalid(); return; }
        const waiting = persistence; persistence = undefined;
        if (!record(response) || response.kind !== 'persisted') { waiting.reject(new Error('invalid persistence response')); invalid(); return; }
        if (response.ok === true && record(response.written)) waiting.resolve(response.written as unknown as WrittenSupportBundle);
        else waiting.reject(new Error(response.code === 'cancelled' ? 'cancelled' : 'write_failed'));
      }
      else invalid();
    } else {
      let value: unknown;
      try { value = JSON.parse(line); } catch { invalid(); return; }
      running = true;
      void collect(value);
    }
  }
});
process.stdin.on('end', () => { if (!running || pending.length || persistence) invalid(); });
process.stdin.on('error', invalid);
