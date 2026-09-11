import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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

    expect(source).toContain('function presentGpuDiagnosticsRows');
    expect(source).toContain('function deterministicGpuDiagnosticsJson');
    expect(source).toContain('gpu-diagnostics-fallback');
    expect(source).toContain('stress_authorized');
    expect(source).toContain('stressAuthorized');
    expect(source).toContain('render diagnostics are not authorized');
    expect(source).toMatch(/if \(value === undefined \|\| value === null \|\| value === ""\) return;/);
    expect(source).not.toContain('gpuDiagnosticsRowsEl.appendChild(term);\\n      description.textContent = "N/A"');
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
