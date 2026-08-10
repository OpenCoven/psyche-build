import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const webRoot = join(repoRoot, 'native/macos/psyche-build-tauri/web');
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
      /<div class="footer-stack" id="footer-stack">[\s\S]*<footer class="composer" id="composer">[\s\S]*<section class="status-detail" id="status-detail"[\s\S]*<footer class="status-bar" id="status-bar"[\s\S]*<div class="status-more-menu" id="status-more-menu"[\s\S]*<div class="status-live" id="status-live"[\s\S]*<div class="status-alert" id="status-alert"/
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
      /<footer class="status-bar" id="status-bar" aria-label="Workspace status">/
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
      /id="status-more-button"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-controls="status-more-menu"/
    );
    expect(indexHtml).toMatch(
      /<div class="status-more-menu" id="status-more-menu" role="menu" aria-label="Status options" hidden>/
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
  });
});
