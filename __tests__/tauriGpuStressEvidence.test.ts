import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { validateGpuStressEvidence } from '../scripts/validate-gpu-stress-evidence.mjs';

function exportResult() {
  return {
    startedAt: 0,
    finishedAt: 180_000,
    scenarios: [1, 6, 12, 24].map((paneCount, index) => ({
      paneCount,
      startedAt: index * 45_000,
      finishedAt: (index + 1) * 45_000,
      contextLossSupported: true,
      metrics: {
        beforeMeasurement: {},
        afterMeasurement: processSample(),
      },
    })),
  };
}

function processSample(): { cpuPercent?: number; rssBytes?: number } {
  return { cpuPercent: 120, rssBytes: 1_024 };
}

describe('bounded current GPU stress export validation', () => {
  it('never turns a complete export into physical or latency acceptance', () => {
    const report = validateGpuStressEvidence(JSON.stringify(exportResult()));
    expect(report.status).toBe('incomplete');
    expect(report.findings).toContain('input_to_next_paint_not_measured');
    expect(report.findings).toContain('frame_not_measured');
    expect(report.findings).toContain('physical_recovery_unverified');
    expect(report.scenarios).toEqual([1, 6, 12, 24].map((paneCount) => ({
      paneCount, cpu: 'measured', rss: 'measured', contextLoss: 'requested',
    })));
  });

  it('keeps omitted process samples and unsupported context loss as gaps', () => {
    const value = exportResult();
    value.scenarios[0]!.metrics.afterMeasurement = {};
    value.scenarios[0]!.contextLossSupported = false;
    expect(validateGpuStressEvidence(JSON.stringify(value)).scenarios[0]).toEqual({
      paneCount: 1, cpu: 'not_measured', rss: 'not_measured', contextLoss: 'unsupported',
    });
  });

  it.each([
    null, {}, [], { ...exportResult(), scenarios: [] },
    { ...exportResult(), scenarios: [...exportResult().scenarios].reverse() },
    { ...exportResult(), finishedAt: 600_001 },
    { ...exportResult(), startedAt: -1 },
    { ...exportResult(), finishedAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...exportResult(), secret: '/private/token' },
  ])('rejects malformed or unbounded run evidence without echoing input', (value) => {
    expect(validateGpuStressEvidence(JSON.stringify(value))).toEqual({
      status: 'invalid', findings: ['invalid_export'], scenarios: [],
    });
  });

  it.each([
    { cpuPercent: null }, { cpuPercent: -1 }, { cpuPercent: '1' },
    { rssBytes: 0.5 }, { rssBytes: -1 }, { rssBytes: null },
    { rssBytes: Number.MAX_SAFE_INTEGER + 1 }, { cpuPercent: 1e100 },
    { secret: '/private/token' }, { frameP95: 1 },
  ])('rejects invalid or invented metric fields', (sample) => {
    const value = exportResult();
    const text = JSON.stringify(value).replace(
      JSON.stringify(value.scenarios[0]!.metrics.afterMeasurement), JSON.stringify(sample),
    );
    expect(validateGpuStressEvidence(text).status).toBe('invalid');
    expect(JSON.stringify(validateGpuStressEvidence(text))).not.toContain('private');
  });

  it('rejects overlapping, reversed, truncated, or malformed scenarios', () => {
    for (const mutate of [
      (value: ReturnType<typeof exportResult>) => { value.scenarios[1]!.startedAt = 0; },
      (value: ReturnType<typeof exportResult>) => { value.scenarios[0]!.finishedAt = 0; },
      (value: ReturnType<typeof exportResult>) => { value.scenarios[0]!.startedAt = 90_000; },
      (value: ReturnType<typeof exportResult>) => { value.scenarios[3]!.finishedAt = 190_000; },
    ]) {
      const value = exportResult();
      mutate(value);
      expect(validateGpuStressEvidence(JSON.stringify(value)).status).toBe('invalid');
    }
    for (const text of ['{', 'null', ' '.repeat(65_537), '{"startedAt":1e999}']) {
      expect(validateGpuStressEvidence(text).status).toBe('invalid');
    }
  });

  it('reports only a bounded enum for unavailable files and never prints paths', () => {
    try {
      execFileSync(process.execPath, ['scripts/validate-gpu-stress-evidence.mjs', '/missing/private-token'], {
        encoding: 'utf8', stdio: 'pipe',
      });
      expect.fail('missing file must fail closed');
    } catch (error) {
      const failure = error as { status: number; stdout: string; stderr: string };
      expect(failure.status).toBe(2);
      expect(JSON.parse(failure.stdout)).toEqual({
        status: 'invalid', findings: ['input_unavailable'], scenarios: [],
      });
      expect(failure.stderr).toBe('');
    }
  });

  it('bounds actual file intake and returns incomplete, never success, for valid JSON', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gpu-evidence-'));
    const path = join(directory, 'evidence.json');
    try {
      for (const [text, status] of [
        [JSON.stringify(exportResult()), 1],
        [' '.repeat(65_537), 2],
      ] as const) {
        writeFileSync(path, text);
        try {
          execFileSync(process.execPath, ['scripts/validate-gpu-stress-evidence.mjs', path], {
            encoding: 'utf8', stdio: 'pipe',
          });
          expect.fail('intake cannot grant acceptance');
        } catch (error) {
          const failure = error as { status: number; stdout: string; stderr: string };
          expect(failure.status).toBe(status);
          expect(JSON.parse(failure.stdout).status).toBe(status === 1 ? 'incomplete' : 'invalid');
          expect(failure.stderr).toBe('');
          expect(failure.stdout).not.toContain(directory);
        }
      }
    } finally {
      unlinkSync(path);
      rmdirSync(directory);
    }
  });

  it('keeps the documented observer compatible with read-only bundle exports and the UI promise', async () => {
    const document = readFileSync('docs/GPU-VERIFICATION-MATRIX.md', 'utf8');
    const observer = document.match(/```js\n([\s\S]*?)\n```/)?.[1];
    expect(observer).toBeTruthy();
    const result = await runInNewContext(`
      (async () => {
        const result = ${JSON.stringify(exportResult())};
        const promise = Promise.resolve(result);
        const api = {};
        let receiver, argument;
        Object.defineProperty(api, 'runStressPlan', {
          get: () => function (value) { receiver = this; argument = value; return promise; }
        });
        window.PsycheRuntimeDebug = api;
        ${observer}
        const returned = window.PsycheRuntimeDebug.runStressPlan('original');
        await returned;
        return {
          same: returned === promise,
          restored: window.PsycheRuntimeDebug === api,
          receiver: receiver === api,
          argument,
          state: window.__psycheStressExport.state,
          text: window.__psycheStressExport.text
        };
      })()
    `, { window: {}, TextEncoder });
    expect(result).toMatchObject({
      same: true, restored: true, receiver: true, argument: 'original', state: 'captured',
    });
    expect(validateGpuStressEvidence(result.text).status).toBe('incomplete');
  });

  it('preserves rejection and rejects unsafe retention in the documented observer', async () => {
    const document = readFileSync('docs/GPU-VERIFICATION-MATRIX.md', 'utf8');
    const observer = document.match(/```js\n([\s\S]*?)\n```/)?.[1];
    for (const rejects of [true, false]) {
      const result = await runInNewContext(`
        (async () => {
          const failure = new Error('private');
          const promise = ${rejects ? 'Promise.reject(failure)' : 'Promise.resolve({ secret: "private" })'};
          const api = { runStressPlan: () => promise };
          window.PsycheRuntimeDebug = api;
          ${observer}
          let sameError = false;
          try { await window.PsycheRuntimeDebug.runStressPlan(); }
          catch (error) { sameError = error === failure; }
          return { sameError, state: window.__psycheStressExport.state,
            text: window.__psycheStressExport.text, restored: window.PsycheRuntimeDebug === api };
        })()
      `, { window: {}, TextEncoder });
      expect(result).toEqual({
        sameError: rejects, state: rejects ? 'run_failed' : 'capture_rejected',
        text: null, restored: true,
      });
    }
  });
});
