import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const webRoot = join(repoRoot, 'native/macos/psyche-build-tauri/web');
const statusRoot = join(webRoot, 'status');
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
const stylesCss = readFileSync(join(webRoot, 'styles.css'), 'utf8');

function footerSection(source: string) {
  const marker = '/* -------- Footer status -------- */';
  const start = source.indexOf(marker);
  if (start === -1) throw new Error('missing footer status css section');
  const next = source.indexOf('/* --------', start + marker.length);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

describe('Tauri footer status bar shell', () => {
  it('wraps the composer, detail panel, and status rail in one footer stack', () => {
    const order = [
      'id="footer-stack"',
      'id="composer"',
      'id="status-detail"',
      'id="status-bar"',
      'id="status-more-menu"',
      'id="status-live"',
      'id="status-alert"',
    ].map((needle) => indexHtml.indexOf(needle));

    for (const index of order) expect(index).toBeGreaterThan(-1);

    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(indexHtml).toMatch(
      /<div class="footer-stack" id="footer-stack">[\s\S]*<footer class="composer" id="composer">[\s\S]*<section class="status-detail" id="status-detail"[\s\S]*<div class="status-bar" id="status-bar"[\s\S]*<div[\s\S]*class="status-more-menu"[\s\S]*id="status-more-menu"[\s\S]*<div class="status-live" id="status-live"[\s\S]*<div class="status-alert" id="status-alert"/
    );
  });

  it('ships the hidden detail host with required controls and live regions', () => {
    expect(indexHtml).toMatch(
      /<section class="status-detail" id="status-detail" aria-label="Workspace metrics" hidden>/
    );
    expect(indexHtml).toContain('id="status-detail-title"');
    expect(indexHtml).toMatch(/id="status-detail-body"[^>]*><\/div>/);
    expect(indexHtml).toMatch(
      /id="status-detail-scope"[^>]*role="group"[^>]*aria-label="Workspace metric scope"/
    );
    expect(indexHtml).toMatch(
      /id="status-detail-scope-workspace"[^>]*aria-pressed="true"[^>]*>Workspace<\/button>/
    );
    expect(indexHtml).toMatch(
      /id="status-detail-scope-focused"[^>]*aria-pressed="false"[^>]*>Focused<\/button>/
    );
    expect(indexHtml).toMatch(/id="status-detail-pin"[^>]*>Pin metric<\/button>/);
    expect(indexHtml).toMatch(/id="status-detail-copy"[^>]*>Copy diagnostics<\/button>/);
    expect(indexHtml).toMatch(
      /id="status-detail-close"[^>]*aria-label="Close workspace metrics"[^>]*>/
    );
    expect(indexHtml).toMatch(
      /id="status-live"[^>]*aria-live="polite"[^>]*aria-atomic="true"/
    );
    expect(indexHtml).toMatch(/id="status-alert"[^>]*role="alert"/);
  });

  it('ships workspace status semantics, compact scope controls, and the more menu host', () => {
    expect(indexHtml).toMatch(
      /<div class="status-bar" id="status-bar" role="group" aria-label="Workspace status">/
    );
    expect(indexHtml).toContain('id="status-metrics"');
    expect(indexHtml).toMatch(/id="status-scope"[^>]*role="group"[^>]*aria-label="Status scope"/);
    expect(indexHtml).toMatch(
      /id="status-scope-workspace"[^>]*aria-pressed="true"[^>]*>Workspace<\/button>/
    );
    expect(indexHtml).toMatch(
      /id="status-scope-focused"[^>]*aria-pressed="false"[^>]*>Focused<\/button>/
    );
    expect(indexHtml).toMatch(
      /id="status-more-button"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*aria-controls="status-more-menu"/
    );
    expect(indexHtml).toMatch(
      /<div[\s\S]*class="status-more-menu"[\s\S]*id="status-more-menu"[\s\S]*role="dialog"[\s\S]*aria-modal="false"[\s\S]*aria-labelledby="status-more-title"[\s\S]*hidden[\s\S]*>/
    );
    expect(indexHtml).toMatch(/id="status-more-title"[^>]*>Status options<\/div>/);
    expect(indexHtml).toMatch(
      /data-metric="connection"[\s\S]*class="status-metric-value" data-connection-state="connecting"[\s\S]*class="status-connection-indicator"[\s\S]*class="status-connection-text">Connecting<\/span>/
    );
    expect(indexHtml).toMatch(
      /data-metric="tasks"[\s\S]*class="status-metric-value">0 Run\s{2}0 Wait<\/span>/
    );
  });

  it('defines the exact 26px footer rail CSS contract', () => {
    expect(stylesCss).toMatch(/--status-h:\s*26px;/);
    expect(stylesCss).toMatch(
      /\.app\s*\{[^}]*grid-template-rows:\s*var\(--titlebar-h\)\s+minmax\(0,\s*1fr\)\s+auto;/s
    );
    expect(stylesCss).toMatch(
      /\.footer-stack\s*\{[^}]*grid-template-rows:\s*var\(--composer-h\)\s+(?:minmax\(0,\s*auto\)|auto)\s+var\(--status-h\);/s
    );
    expect(stylesCss).toMatch(/\.status-bar\s*\{[^}]*display:\s*flex;/s);
    expect(stylesCss).toMatch(/\.status-bar\s*\{[^}]*height:\s*var\(--status-h\);/s);
    expect(stylesCss).toMatch(/\.status-bar\s*\{[^}]*min-height:\s*var\(--status-h\);/s);
    expect(stylesCss).toMatch(/\.status-bar\s*\{[^}]*font-family:\s*var\(--font-mono\);/s);
    expect(stylesCss).toMatch(/\.status-bar\s*\{[^}]*font-size:\s*10px;/s);
    expect(stylesCss).toMatch(/\.status-bar\s*\{[^}]*font-variant-numeric:\s*tabular-nums;/s);
    expect(stylesCss).toMatch(/\.status-bar\s*\{[^}]*overflow:\s*hidden;/s);
    expect(stylesCss).toMatch(
      /\.status-detail\s*\{[^}]*min-height:\s*156px;[^}]*max-height:\s*min\(220px,\s*32vh\);[^}]*overflow:\s*auto;/s
    );
    expect(stylesCss).toMatch(
      /\.status-detail-head\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*height:\s*34px;/s
    );
    expect(stylesCss).toMatch(
      /\.status-more-menu\s*\{[^}]*bottom:\s*calc\(var\(--status-h\)\s*\+\s*8px\);[^}]*width:\s*260px;[^}]*max-width:\s*min\(320px,\s*calc\(100vw - 16px\)\);/s
    );
  });

  it('pins explicit footer stack rows so the hidden detail track collapses cleanly', () => {
    const section = footerSection(stylesCss);

    expect(section).toMatch(/\.footer-stack\s*>\s*\.composer\s*\{[^}]*grid-row:\s*1;/s);
    expect(section).toMatch(/\.footer-stack\s*>\s*\.status-detail\s*\{[^}]*grid-row:\s*2;/s);
    expect(section).toMatch(/\.footer-stack\s*>\s*\.status-bar\s*\{[^}]*grid-row:\s*3;/s);
    expect(section).toMatch(
      /\.status-detail\[hidden\],\s*\.status-more-menu\[hidden\]\s*\{[^}]*display:\s*none;/s
    );
    expect(section).toMatch(/\.status-more-menu\s*\{[^}]*position:\s*absolute;/s);
    expect(section).toMatch(/\.status-live,\s*\.status-alert\s*\{[^}]*position:\s*absolute;/s);
  });

  it('adds a footer-specific narrow breakpoint for the detail header and actions', () => {
    const section = footerSection(stylesCss);

    expect(section).toMatch(
      /\.status-bar-trailing\s*\{[^}]*flex:\s*none;[^}]*min-width:\s*max-content;/s
    );
    expect(section).toMatch(
      /@media \(max-width:\s*760px\)\s*\{[\s\S]*?\.status-detail-head\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;[^}]*height:\s*auto;[^}]*min-height:\s*34px;[^}]*padding:\s*4px 10px;[^}]*row-gap:\s*6px;/s
    );
    expect(section).toMatch(
      /@media \(max-width:\s*760px\)\s*\{[\s\S]*?\.status-detail-actions\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*justify-content:\s*flex-start;[^}]*flex-wrap:\s*wrap;/s
    );
  });

  it('adds narrow CSS fallback hiding only healthy low-priority metrics', () => {
    const section = footerSection(stylesCss);

    for (const metric of ['performance', 'fps', 'activity', 'shells', 'tasks', 'agents']) {
      expect(section).toContain(
        `.status-metric[data-metric="${metric}"]:not([data-severity="warn"]):not([data-severity="danger"])`
      );
    }

    expect(section).toMatch(/@media \(max-width:\s*700px\)\s*\{[\s\S]*display:\s*none;/s);
    expect(section).toMatch(/@media \(max-width:\s*620px\)\s*\{[\s\S]*display:\s*none;/s);
    expect(section).toMatch(/@media \(max-width:\s*540px\)\s*\{[\s\S]*display:\s*none;/s);
    expect(section).not.toContain(
      '.status-metric[data-metric="connection"]:not([data-severity="warn"]):not([data-severity="danger"])'
    );
  });

  it('keeps the footer CSS section minimal and semantic', () => {
    const section = footerSection(stylesCss);

    expect(section).not.toMatch(/gradient/i);
    expect(section).not.toMatch(/backdrop-filter/i);
    expect(section).toMatch(/data-severity="warn"/);
    expect(section).toMatch(/var\(--warn\)/);
    expect(section).toMatch(/data-severity="danger"/);
    expect(section).toMatch(/var\(--error\)/);
  });

  it('defines compact metric widths, detail rows, and keyboard focus states', () => {
    const section = footerSection(stylesCss);

    for (const metric of [
      'connection',
      'agents',
      'shells',
      'tasks',
      'performance',
      'fps',
      'activity',
    ]) {
      expect(section).toMatch(new RegExp(`\\.status-metric\\[data-metric="${metric}"\\]`));
    }

    for (const selector of [
      '.status-agent-row',
      '.status-shell-row',
      '.status-task-group',
      '.status-performance-grid',
      '.status-activity-grid',
      '.status-service-row',
    ]) {
      expect(section).toContain(selector);
    }

    expect(section).toContain('.status-metric:focus-visible');
    expect(section).toContain('.status-scope-btn:focus-visible');
    expect(section).toContain('.status-detail-scope-btn:focus-visible');
    expect(section).toContain('.status-detail-close:focus-visible');
    expect(section).toContain('.status-more-btn:focus-visible');
    expect(section).toContain('.status-connection-indicator');
    expect(section).toContain('.status-metric-value[data-connection-state="connected"]');
    expect(section).toContain('.status-metric-value[data-connection-state="connecting"]');
    expect(section).toContain('.status-metric-value[data-connection-state="degraded"]');
    expect(section).toContain('.status-metric-value[data-connection-state="disconnected"]');
    expect(section).toMatch(/\.status-metric\[data-metric="connection"\]\s*\{[^}]*116px;/s);
    expect(section).toMatch(/\.status-metric\[data-metric="tasks"\]\s*\{[^}]*128px;/s);
    expect(section).toContain('.status-more-open-value');
  });

  it('exports the controller and public footer helpers through the browser entrypoint', async () => {
    const entry = await import(pathToFileURL(join(statusRoot, 'status-entry.js')).href);

    expect(Object.keys(entry).sort()).toEqual([
      'DEFAULT_METRIC_ORDER',
      'METRICS',
      'chooseVisibleMetrics',
      'createActivityTracker',
      'createFrameSampler',
      'createStatusController',
      'evaluateSeverity',
      'formatLiveDiagnostics',
      'median',
      'normalizePreferences',
      'pushTrend',
      'samplingDelay',
      'sparklinePath',
      'summarizeWorkspace',
    ]);
  });

  it('ships controller source contracts for persistence, announcements, Escape, and focused scope fallback', () => {
    const controller = readFileSync(join(statusRoot, 'status-controller.mjs'), 'utf8');

    expect(controller).toContain('createStatusController');
    expect(controller).toContain('ResizeObserver');
    expect(controller).toContain('registerListener');
    expect(controller).toContain('drainCleanup');
    expect(controller).toContain('psyche.tauri.status.v1');
    expect(controller).toContain('Unable to copy diagnostics');
    expect(controller).toMatch(/event\.key === ['"]Escape['"]/);
    expect(controller).toMatch(/=== ['"]focused['"] && !focusedAvailable/);
    expect(controller).toMatch(/setAttribute\(['"]aria-expanded['"]/);
    expect(controller).toContain('Diagnostics copied');
    expect(controller).toContain('Pinned ');
    expect(controller).toContain('Unpinned ');
    expect(controller).toContain('Agent tools');
    expect(controller).toContain('Structured Coven events only');
    expect(controller).not.toContain('menuitem');
    expect(controller).not.toContain('innerHTML');
  });

  it('adds fixed more-button width plus generated menu and panel classes', () => {
    const section = footerSection(stylesCss);

    expect(section).toMatch(
      /\.status-more-btn\s*\{[^}]*width:\s*60px;[^}]*min-width:\s*60px;[^}]*justify-content:\s*center;/s
    );

    for (const selector of [
      '.status-more-row',
      '.status-more-open',
      '.status-more-toggle',
      '.status-more-controls',
      '.status-more-move',
      '.status-performance-cell',
      '.status-activity-cell',
      '.status-sparkline',
      '.status-empty',
    ]) {
      expect(section).toContain(selector);
    }
  });
});
