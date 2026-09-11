import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isGpuDiagnosticsContextLossConfirmed,
  installDiagnosticsStressAdapters,
  isGpuDiagnosticsStressRunEnabled,
  presentGpuDiagnosticRows,
  type DiagnosticsStressAdapterHost,
} from '../native/desktop/psyche-build-tauri/web/runtime/diagnostics-stress-adapters';

const webRoot = join(process.cwd(), 'native/desktop/psyche-build-tauri/web');

function readWebFile(path: string): string {
  return readFileSync(join(webRoot, path), 'utf8');
}

function elementHtml(html: string, id: string): string {
  const match = html.match(new RegExp(`<([a-z0-9-]+)[^>]+id="${id}"[\\s\\S]*?</\\1>`, 'i'))
    ?? html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`, 'i'));
  expect(match, `${id} should exist`).not.toBeNull();
  return match?.[0] ?? '';
}

describe('Tauri GPU diagnostics panel', () => {
  it('installs runnable stress adapters only for an exact native debug authorization report', async () => {
    const calls: string[] = [];
    const host: DiagnosticsStressAdapterHost = {
      async createTerminal(index, fixture) {
        calls.push(`terminal:${index}:${fixture}`);
        return { id: 'terminal-1', dispose() {}, forceDispose() {} };
      },
      async createEditor(document) {
        calls.push(`editor:${document.name}`);
        return { id: 'editor-1', dispose() {}, forceDispose() {} };
      },
      async createBrowser(page) {
        calls.push(`browser:${page.title}`);
        return { id: 'browser-1', dispose() {}, forceDispose() {} };
      },
      async focus(id) {
        calls.push(`focus:${id}`);
      },
      resize(step) {
        calls.push(`resize:${step}`);
      },
      async setVisible(id, visible) {
        calls.push(`visible:${id}:${visible}`);
      },
      async cycleWindow() {
        calls.push('cycle-window');
      },
      async loseGraphicsContext() {
        calls.push('lose-context');
        return true;
      },
      resetMetrics() {
        calls.push('reset-metrics');
      },
      snapshotMetrics() {
        return { rssBytes: 512 };
      },
      sleep() {
        return Promise.resolve();
      },
      requestFrame() {
        return 1;
      },
      cancelFrame() {},
      now() {
        return 1;
      },
      onProgress() {},
    };
    const target: { PsycheDiagnosticsStressAdapters?: unknown } = {};

    expect(installDiagnosticsStressAdapters(
      target,
      { debugBuild: true, stressAuthorized: false },
      host,
    )).toBe(false);
    expect(target.PsycheDiagnosticsStressAdapters).toBeUndefined();

    expect(installDiagnosticsStressAdapters(
      target,
      { debugBuild: true, stressAuthorized: true },
      host,
    )).toBe(true);
    const adapters = target.PsycheDiagnosticsStressAdapters as {
      authorized: boolean;
      createTerminal(index: number, fixture: 'steady', signal: AbortSignal): Promise<{ id: string }>;
    };
    expect(adapters.authorized).toBe(true);
    await expect(adapters.createTerminal(0, 'steady', new AbortController().signal))
      .resolves.toMatchObject({ id: 'terminal-1' });
    expect(calls).toContain('terminal:0:steady');
  });

  it('fails closed for malformed reports and enables Run only with installed adapters and no active run', () => {
    const target: { PsycheDiagnosticsStressAdapters?: unknown } = {
      PsycheDiagnosticsStressAdapters: { stale: true },
    };
    const host = {} as DiagnosticsStressAdapterHost;

    expect(installDiagnosticsStressAdapters(
      target,
      { debugBuild: 'true', stressAuthorized: true },
      host,
    )).toBe(false);
    expect(target.PsycheDiagnosticsStressAdapters).toBeUndefined();
    expect(isGpuDiagnosticsStressRunEnabled(true, true, false)).toBe(true);
    expect(isGpuDiagnosticsStressRunEnabled(false, true, false)).toBe(false);
    expect(isGpuDiagnosticsStressRunEnabled(true, false, false)).toBe(false);
    expect(isGpuDiagnosticsStressRunEnabled(true, true, true)).toBe(false);
  });

  it('omits metrics without a production producer while retaining present native process metrics', () => {
    expect(presentGpuDiagnosticRows({
      acceleration: 'accelerated',
      frameAverageMs: 10,
      frameP95Ms: 20,
      ipcLatencyMs: 4,
      queueHighWater: 7,
      cpuPercent: 22.5,
      rssBytes: 4096,
    })).toEqual([
      ['acceleration', 'Acceleration', 'accelerated'],
      ['cpuPercent', 'CPU percent', 22.5],
      ['rssBytes', 'Resident memory', 4096],
    ]);
  });

  it('treats only the diagnostic page context-lost acknowledgement as supported', () => {
    const title = 'Psyche render diagnostics · 6 panes';

    expect(isGpuDiagnosticsContextLossConfirmed(`${title} · context-lost`, title)).toBe(true);
    expect(isGpuDiagnosticsContextLossConfirmed(`${title} · context-unavailable`, title)).toBe(false);
    expect(isGpuDiagnosticsContextLossConfirmed(
      `${title} · context-loss-unconfirmed`,
      title,
    )).toBe(false);
    expect(isGpuDiagnosticsContextLossConfirmed('unrelated title', title)).toBe(false);
  });

  it('stops a fixture that starts after its diagnostics pane has been closed', () => {
    const source = readWebFile('main.js');
    const terminalAdapter = source.slice(
      source.indexOf('async function createGpuDiagnosticsStressTerminal'),
      source.indexOf('async function createGpuDiagnosticsStressEditor'),
    );

    expect(terminalAdapter).toMatch(
      /if \(!isLiveThread\(thread\)[\s\S]*await stopThreadPty\(thread\)/,
    );
    expect(terminalAdapter).toContain(
      'new Error("diagnostics terminal cleanup was not confirmed")',
    );
  });

  it('keeps force disposal available when graceful diagnostics cleanup rejects', () => {
    const source = readWebFile('main.js');
    const resourceFactory = source.slice(
      source.indexOf('function createGpuDiagnosticsStressResource'),
      source.indexOf('async function closeGpuDiagnosticsStressThread'),
    );

    expect(resourceFactory).toContain('var cleanupCompleted = false;');
    expect(resourceFactory).toMatch(/if \(cleanupCompleted\) return;/);
  });

  it('restores diagnostics workspace state only when pre-existing resources remain exact', () => {
    const source = readWebFile('main.js');
    const workspaceGuard = source.slice(
      source.indexOf('function gpuDiagnosticsStressWorkspaceIsUnchanged'),
      source.indexOf('async function restoreGpuDiagnosticsStressWorkspace'),
    );

    expect(workspaceGuard).toContain('state.threads.length !== snapshot.threadIds.length');
    expect(workspaceGuard).toContain('state.openFiles.length !== snapshot.fileIds.length');
  });

  it('cleans diagnostic browser tabs in their original worktree', () => {
    const source = readWebFile('main.js');
    const cleanup = source.slice(
      source.indexOf('async function cleanupGpuDiagnosticsStressBrowserResources'),
      source.indexOf('async function createGpuDiagnosticsStressBrowser'),
    );

    expect(cleanup).toContain('closeBrowserTab(project, tab.id, pane.worktreePath)');
  });

  it('adds a development titlebar action and hidden accessible diagnostics panel', () => {
    const html = readWebFile('index.html');
    const button = elementHtml(html, 'gpu-diagnostics-toggle');
    const panel = elementHtml(html, 'gpu-diagnostics-panel');
    const status = elementHtml(html, 'gpu-diagnostics-status');

    expect(button).toContain('aria-controls="gpu-diagnostics-panel"');
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain('GPU diagnostics');
    expect(panel).toContain('hidden');
    expect(panel).toContain('role="dialog"');
    expect(status).toContain('role="status"');
    expect(status).toContain('aria-live="polite"');
  });

  it('keeps scenario controls hidden in markup until runtime authorization enables them', () => {
    const html = readWebFile('index.html');
    const controls = elementHtml(html, 'gpu-diagnostics-stress-controls');
    const runButton = elementHtml(html, 'gpu-diagnostics-run-stress');

    expect(controls).toContain('hidden');
    expect(runButton).toContain('disabled');
  });

  it('renders only present diagnostic rows, prominent software fallback, and deterministic copy JSON', () => {
    const source = readWebFile('main.js');

    expect(source).toContain('presentGpuDiagnosticRows');
    expect(source).toContain('function deterministicGpuDiagnosticsJson');
    expect(source).toContain('gpu-diagnostics-fallback');
    expect(source).toContain('stress_authorized');
    expect(source).toContain('stressAuthorized');
    expect(source).toContain('render diagnostics are not authorized');
    expect(source).not.toContain('["frameAverageMs", "Frame average"]');
    expect(source).not.toContain('["frameP95Ms", "Frame p95"]');
    expect(source).not.toContain('["ipcLatencyMs", "IPC latency"]');
    expect(source).not.toContain('["queueHighWater", "Queue high-water"]');
  });

  it('routes diagnostics copy and stress failures through readable status errors', () => {
    const source = readWebFile('main.js');

    expect(source).toContain(
      'copyGpuDiagnosticsJson().catch(function (error) { showStatusError(String(error && error.message || error)); })',
    );
    expect(source).toContain(
      'runGpuDiagnosticsStress().catch(function (error) { showStatusError(String(error && error.message || error)); })',
    );
    expect(source).not.toContain('toast(String(error && error.message || error), "error")');
  });

  it('rejects copy when clipboard writers are unavailable instead of claiming success', () => {
    const source = readWebFile('main.js');

    expect(source).toContain('throw new Error("clipboard support is unavailable")');
    expect(source.indexOf('throw new Error("clipboard support is unavailable")'))
      .toBeLessThan(source.indexOf('"Diagnostics JSON copied."'));
  });

  it('restores focus to the titlebar toggle when the diagnostics panel closes', () => {
    const source = readWebFile('main.js');

    expect(source).toContain('} else if (gpuDiagnosticsToggleEl.focus) {');
    expect(source).toContain('gpuDiagnosticsToggleEl.focus();');
    expect(source).toContain('if (gpuDiagnosticsPanelEl && !gpuDiagnosticsPanelEl.hidden) { setGpuDiagnosticsOpen(false); return; }');
  });

  it('uses the compositor transition helper and does not add layout-triggering transitions', () => {
    const source = readWebFile('main.js');
    const css = readWebFile('styles.css');

    expect(source).toMatch(/beginCompositorTransition\(gpuDiagnosticsPanelEl\)/);
    expect(css).toMatch(/\.gpu-diagnostics-panel[\s\S]*transition-property:\s*opacity, transform/);
    expect(css).not.toMatch(/gpu-diagnostics[\s\S]{0,120}transition:\s*(?:all|height|width|top|left|right|bottom|margin|padding)/);
  });

  it('keeps the diagnostics titlebar label unclipped by the chrome button base width', () => {
    const css = readWebFile('styles.css');

    expect(css).toMatch(/\.chrome-btn\.agent-control-toggle\s*\{\s*width:\s*auto;\s*padding-inline:\s*9px;\s*\}/);
    expect(css).toMatch(/\.chrome-btn\.gpu-diagnostics-toggle\s*\{\s*width:\s*auto;\s*padding-inline:\s*9px;\s*\}/);
  });
});
