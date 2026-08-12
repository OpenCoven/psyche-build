import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const repoRoot = process.cwd();
const webRoot = join(repoRoot, 'native/macos/psyche-build-tauri/web');
const statusRoot = join(webRoot, 'status');
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
const stylesCss = readFileSync(join(webRoot, 'styles.css'), 'utf8');
const mainJs = readFileSync(join(webRoot, 'main.js'), 'utf8');
const statusBundle = readFileSync(join(webRoot, 'status.bundle.js'), 'utf8');

interface BrowserGlobal extends Record<string, unknown> {
  window: BrowserGlobal;
  self: BrowserGlobal;
  globalThis: BrowserGlobal;
  PsycheStatus?: Record<string, unknown>;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionSource(source: string, name: string) {
  const match = new RegExp(
    `(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`
  ).exec(source);
  if (!match || match.index === undefined) throw new Error(`missing function ${name}`);

  const bodyStart = source.indexOf('{', match.index + match[0].length);
  if (bodyStart === -1) throw new Error(`missing body for ${name}`);

  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }

  throw new Error(`unterminated function ${name}`);
}

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(...names, `"use strict"; return (${source});`)(...values) as T;
}

function compileBuildStatusController<T extends (...args: never[]) => unknown>(
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(
    ...names,
    `"use strict";
     ${functionSource(mainJs, 'isProcessBackedThread')}
     ${functionSource(mainJs, 'statusThreadSnapshot')}
     ${functionSource(mainJs, 'statusCovenSessionSnapshot')}
     ${functionSource(mainJs, 'readStructuredAgentToolCallCount')}
     ${functionSource(mainJs, 'getStatusContext')}
     return (${functionSource(mainJs, 'buildStatusController')});`,
  )(...values) as T;
}

function executeBrowserBundle(source: string): BrowserGlobal {
  const browserGlobal = createContext({ console }) as BrowserGlobal;
  browserGlobal.window = browserGlobal;
  browserGlobal.self = browserGlobal;
  browserGlobal.globalThis = browserGlobal;
  runInContext(source, browserGlobal, { filename: 'status.bundle.js' });
  return browserGlobal;
}

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

  it('ships the bundled footer status module before main boot and registers the browser global contract', () => {
    const statusScript = '<script src="./status.bundle.js" defer></script>';
    const mainScript = '<script src="./main.js" defer></script>';
    const browserGlobal = executeBrowserBundle(statusBundle);
    const shipped = browserGlobal.PsycheStatus as Record<string, unknown> | undefined;

    expect(indexHtml).toContain(statusScript);
    expect(indexHtml.indexOf(statusScript)).toBeLessThan(indexHtml.indexOf(mainScript));
    expect(browserGlobal.window).toBe(browserGlobal);
    expect(browserGlobal.self).toBe(browserGlobal);
    expect(browserGlobal.globalThis).toBe(browserGlobal);
    expect(shipped).toBeTruthy();
    expect(browserGlobal.window.PsycheStatus).toBe(shipped);
    expect(Array.isArray(shipped?.DEFAULT_METRIC_ORDER)).toBe(true);
    expect(typeof shipped?.createStatusController).toBe('function');
    expect(typeof shipped?.METRICS).toBe('object');
    expect(typeof shipped?.summarizeWorkspace).toBe('function');
    expect(typeof shipped?.formatLiveDiagnostics).toBe('function');
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

  it('renames invokeNative and preserves invoke success/failure instrumentation without swallowing rejections', async () => {
    expect(mainJs).toContain('var invokeNative = window.__TAURI__.core.invoke;');
    expect(mainJs).not.toMatch(/var invoke = window\.__TAURI__\.core\.invoke;/);

    const operationCalls: Array<[string, number, boolean]> = [];
    const performance = {
      values: [12, 29, 40, 58],
      now() {
        return this.values.shift() ?? 0;
      },
    };
    const successInvoke = compileFunction<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >(functionSource(mainJs, 'invoke'), {
      invokeNative: async (_command: string, args?: Record<string, unknown>) => args?.ok,
      statusController: {
        noteOperation(command: string, duration: number, ok: boolean) {
          operationCalls.push([command, duration, ok]);
        },
      },
      performance,
      Promise,
    });

    await expect(successInvoke('git_worktrees', { ok: 'done' })).resolves.toBe('done');
    expect(operationCalls).toEqual([['git_worktrees', 17, true]]);

    const rejection = new Error('boom');
    const failureInvoke = compileFunction<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >(functionSource(mainJs, 'invoke'), {
      invokeNative: async () => {
        throw rejection;
      },
      statusController: {
        noteOperation(command: string, duration: number, ok: boolean) {
          operationCalls.push([command, duration, ok]);
        },
      },
      performance,
      Promise,
    });

    await expect(failureInvoke('pty_start')).rejects.toBe(rejection);
    expect(operationCalls[1]).toEqual(['pty_start', 18, false]);
  });

  it('creates the footer controller with exact hosts, raw workspace metrics polling, live context mapping, and explicit clipboard fallback', async () => {
    const idRequests: string[] = [];
    const selectorRequests: string[] = [];
    const nodes = new Map<string, { id?: string; selector?: string }>([
      ['status-bar', { id: 'status-bar' }],
      ['status-metrics', { id: 'status-metrics' }],
      ['status-detail', { id: 'status-detail' }],
      ['status-detail-title', { id: 'status-detail-title' }],
      ['status-detail-body', { id: 'status-detail-body' }],
      ['status-detail-close', { id: 'status-detail-close' }],
      ['status-detail-pin', { id: 'status-detail-pin' }],
      ['status-detail-copy', { id: 'status-detail-copy' }],
      ['status-more-button', { id: 'status-more-button' }],
      ['status-more-menu', { id: 'status-more-menu' }],
      ['status-live', { id: 'status-live' }],
      ['status-alert', { id: 'status-alert' }],
      ['.status-bar-trailing', { selector: '.status-bar-trailing' }],
    ]);
    const scopeButtons = [
      { id: 'status-scope-workspace' },
      { id: 'status-scope-focused' },
      { id: 'status-detail-scope-workspace' },
      { id: 'status-detail-scope-focused' },
    ];
    const controller = { kind: 'status-controller' };
    const createCalls: Array<Record<string, unknown>> = [];
    const invokeNativeCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const project = { id: 'project-1', root: '/repo', worktrees: [{ path: '/repo' }] };
    const sessions = [
      {
        id: 'live',
        title: 'Live',
        harness: 'claude',
        model: 'claude-sonnet',
        currentTask: 'Review',
        inputTokens: 12,
        outputTokens: 7,
        status: 'running',
        createdAt: '2026-08-10T00:00:00Z',
      },
      {
        id: 'done',
        title: 'Done',
        status: 'completed',
        archivedAt: '2026-08-10T01:00:00Z',
      },
    ];
    const state = {
      activeThreadId: 'agent',
      agentToolCalls: 9,
      threads: [
        {
          id: 'agent',
          name: 'Agent',
          kind: 'coven-chat',
          status: 'running',
          launch: { covenSessionId: 'live' },
          needsAttention: true,
          startedAt: 10,
          finishedAt: null,
          exitCode: null,
        },
        {
          id: 'shell',
          name: 'Shell',
          kind: 'shell',
          status: 'exited',
          launch: {},
          needsAttention: false,
          startedAt: 5,
          finishedAt: 15,
          exitCode: 0,
        },
        {
          id: 'web',
          name: 'Web',
          kind: 'web',
          status: 'running',
          needsAttention: false,
          startedAt: 1,
          finishedAt: null,
          exitCode: null,
        },
        {
          id: 'git',
          name: 'Git',
          kind: 'git',
          status: '',
          needsAttention: false,
          startedAt: null,
          finishedAt: null,
          exitCode: null,
        },
      ],
    };
    const buildStatusController = compileBuildStatusController<() => unknown>({
      window: {
        PsycheStatus: {
          createStatusController(options: Record<string, unknown>) {
            createCalls.push(options);
            return controller;
          },
        },
      },
      document: {
        getElementById(id: string) {
          idRequests.push(id);
          return nodes.get(id) ?? null;
        },
        querySelector(selector: string) {
          selectorRequests.push(selector);
          return nodes.get(selector) ?? null;
        },
        querySelectorAll(selector: string) {
          selectorRequests.push(selector);
          return scopeButtons;
        },
      },
      localStorage: {
        getItem() { return null; },
        setItem() { return undefined; },
      },
      navigator: {},
      invokeNative: async (command: string, args: Record<string, unknown>) => {
        invokeNativeCalls.push({ command, args });
        return { ok: true, command, args };
      },
      state,
      activeProject: () => project,
      allCovenSessionsForProject: (inputProject: unknown) => {
        expect(inputProject).toBe(project);
        return sessions;
      },
      covenSessionsForProject: () => {
        throw new Error('live-only helper must not power controller context');
      },
      Promise,
    });

    expect(buildStatusController()).toBe(controller);
    expect(createCalls).toHaveLength(1);
    expect(((mainJs.match(/PsycheStatus\.createStatusController\(/g)) ?? []).length).toBe(1);
    expect(idRequests).toEqual([
      'status-bar',
      'status-metrics',
      'status-detail',
      'status-detail-title',
      'status-detail-body',
      'status-detail-close',
      'status-detail-pin',
      'status-detail-copy',
      'status-more-button',
      'status-more-menu',
      'status-live',
      'status-alert',
    ]);
    expect(selectorRequests).toEqual([
      '.status-bar-trailing',
      '.status-scope-btn, .status-detail-scope-btn',
    ]);

    const options = createCalls[0];
    expect((options.elements as Record<string, unknown>).bar).toEqual({ id: 'status-bar' });
    expect((options.elements as Record<string, unknown>).metrics).toEqual({ id: 'status-metrics' });
    expect((options.elements as Record<string, unknown>).detail).toEqual({ id: 'status-detail' });
    expect((options.elements as Record<string, unknown>).detailTitle).toEqual({ id: 'status-detail-title' });
    expect((options.elements as Record<string, unknown>).detailBody).toEqual({ id: 'status-detail-body' });
    expect((options.elements as Record<string, unknown>).close).toEqual({ id: 'status-detail-close' });
    expect((options.elements as Record<string, unknown>).pin).toEqual({ id: 'status-detail-pin' });
    expect((options.elements as Record<string, unknown>).copy).toEqual({ id: 'status-detail-copy' });
    expect((options.elements as Record<string, unknown>).scopeButtons).toBe(scopeButtons);
    expect((options.elements as Record<string, unknown>).more).toEqual({ id: 'status-more-button' });
    expect((options.elements as Record<string, unknown>).moreMenu).toEqual({ id: 'status-more-menu' });
    expect((options.elements as Record<string, unknown>).live).toEqual({ id: 'status-live' });
    expect((options.elements as Record<string, unknown>).alert).toEqual({ id: 'status-alert' });
    expect((options.elements as Record<string, unknown>).trailing).toEqual({
      selector: '.status-bar-trailing',
    });

    const fetchMetrics = options.fetchMetrics as (scope?: { threadId?: string }) => Promise<unknown>;
    await expect(fetchMetrics()).resolves.toMatchObject({
      ok: true,
      command: 'workspace_metrics',
      args: { scope: null },
    });
    await expect(fetchMetrics({ threadId: 'agent' })).resolves.toMatchObject({
      ok: true,
      command: 'workspace_metrics',
      args: { scope: { threadId: 'agent' } },
    });
    expect(invokeNativeCalls).toEqual([
      { command: 'workspace_metrics', args: { scope: null } },
      { command: 'workspace_metrics', args: { scope: { threadId: 'agent' } } },
    ]);
    expect(mainJs).not.toMatch(/invoke\s*\(\s*["']workspace_metrics["']/);

    const getContext = options.getContext as () => Record<string, unknown>;
    expect(functionSource(mainJs, 'isProcessBackedThread')).toContain('thread.launch');
    expect(getContext()).toEqual({
      activeThreadId: 'agent',
      threads: [
        {
          id: 'agent',
          name: 'Agent',
          kind: 'coven-chat',
          status: 'running',
          covenSessionId: 'live',
          processBacked: true,
          needsAttention: true,
          startedAt: 10,
          finishedAt: null,
          exitCode: null,
        },
        {
          id: 'shell',
          name: 'Shell',
          kind: 'shell',
          status: 'exited',
          covenSessionId: null,
          processBacked: true,
          needsAttention: false,
          startedAt: 5,
          finishedAt: 15,
          exitCode: 0,
        },
        {
          id: 'web',
          name: 'Web',
          kind: 'web',
          status: 'running',
          covenSessionId: null,
          processBacked: false,
          needsAttention: false,
          startedAt: 1,
          finishedAt: null,
          exitCode: null,
        },
        {
          id: 'git',
          name: 'Git',
          kind: 'git',
          status: '',
          covenSessionId: null,
          processBacked: false,
          needsAttention: false,
          startedAt: null,
          finishedAt: null,
          exitCode: null,
        },
      ],
      covenSessions: sessions,
      agentToolCalls: 9,
    });

    state.agentToolCalls = Number.NaN;
    expect(getContext()).not.toHaveProperty('agentToolCalls');

    const copyText = options.copyText as (text: string) => Promise<void>;
    await expect(copyText('diagnostics')).rejects.toThrow('Clipboard API unavailable');

    const written: string[] = [];
    const withClipboard = compileBuildStatusController<() => unknown>({
      window: {
        PsycheStatus: {
          createStatusController(options: Record<string, unknown>) {
            return options;
          },
        },
      },
      document: {
        getElementById(id: string) {
          return nodes.get(id) ?? null;
        },
        querySelector(selector: string) {
          return nodes.get(selector) ?? null;
        },
        querySelectorAll() {
          return scopeButtons;
        },
      },
      localStorage: {
        getItem() { return null; },
        setItem() { return undefined; },
      },
      navigator: {
        clipboard: {
          writeText(text: string) {
            written.push(text);
            return Promise.resolve();
          },
        },
      },
      invokeNative: async () => null,
      state,
      activeProject: () => project,
      allCovenSessionsForProject: () => sessions,
      Promise,
    });
    const clipboardOptions = withClipboard() as Record<string, unknown>;
    await expect((clipboardOptions.copyText as (text: string) => Promise<void>)('copied')).resolves.toBeUndefined();
    expect(written).toEqual(['copied']);
  });

  it('surfaces missing footer bundle initialization failures while preserving the boot guard', () => {
    const warnings: string[] = [];
    const alert = { id: 'status-alert', textContent: '' };
    const buildStatusController = compileBuildStatusController<() => unknown>({
      window: {},
      document: {
        getElementById(id: string) {
          return id === 'status-alert' ? alert : null;
        },
        querySelector() {
          throw new Error('bundle guard should return before querying the footer shell');
        },
        querySelectorAll() {
          throw new Error('bundle guard should return before querying scope buttons');
        },
      },
      console: {
        warn(message: string) {
          warnings.push(message);
        },
      },
      localStorage: {
        getItem() { return null; },
        setItem() { return undefined; },
      },
      navigator: {},
      invokeNative: async () => null,
      state: { activeThreadId: null, threads: [] },
      activeProject: () => null,
      allCovenSessionsForProject: () => [],
      Promise,
    });

    expect(buildStatusController()).toBeNull();
    expect(alert.textContent).toBe('Workspace status unavailable: status bundle missing.');
    expect(warnings).toEqual([
      '[status controller] footer status bundle missing; window.PsycheStatus.createStatusController unavailable',
    ]);

    const source = functionSource(mainJs, 'buildStatusController');
    expect(source).toMatch(/if \(!PsycheStatus \|\| typeof PsycheStatus\.createStatusController !== "function"\)/);
    expect(source).toContain('statusAlert.textContent = "Workspace status unavailable: status bundle missing.";');
    expect(source).toContain('[status controller] footer status bundle missing; window.PsycheStatus.createStatusController unavailable');
  });

  it('feeds PTY, Coven, visibility, focus, project/worktree, and lifecycle events into the controller while keeping the rail live-only', () => {
    const refreshCoven = functionSource(mainJs, 'refreshCovenSessions');

    // The liveness guard used to be spelled `!thread || thread.closing` inline.
    // isLiveThread() is that plus a membership check against state.threads, so
    // it is strictly stronger; the assertion tracks the helper rather than the
    // literal it replaced.
    expect(mainJs).toMatch(
      /listen\("pty:data"[\s\S]*var bytes = new Uint8Array\(payload\.bytes\);[\s\S]*if \(!isLiveThread\(thread\)\) return;[\s\S]*noteStatusPtyData\(payload\.thread_id,\s*bytes\);/s
    );
    expect(refreshCoven).toMatch(/performance\.now\(\)/);
    expect(refreshCoven).toMatch(
      /noteStatusCovenSample\(\{[\s\S]*phase:\s*covenDiscovery\.phase[\s\S]*latencyMs:[\s\S]*refreshedAt:\s*covenDiscovery\.refreshedAt[\s\S]*error:/s
    );
    expect(functionSource(mainJs, 'handleVisibilityChange')).toMatch(
      /else[\s\S]*startCovenPolling\(\)[\s\S]*refreshStatusController\(\)/s
    );
    expect(functionSource(mainJs, 'focusThread')).toContain('refreshStatusController();');
    expect(functionSource(mainJs, 'handlePtyExit')).toContain('refreshStatusController();');
    expect(functionSource(mainJs, 'activatePaneLayoutFocus')).not.toContain('refreshStatusController();');
    expect(functionSource(mainJs, 'activateProjectWorktree')).toContain('refreshStatusController();');
    expect(functionSource(mainJs, 'refreshProjectWorktrees')).toContain('refreshStatusController();');
    expect(functionSource(mainJs, 'removeProject')).toContain('refreshStatusController();');
    expect(functionSource(mainJs, 'addProject')).toContain('refreshStatusController();');
    expect(mainJs).toMatch(
      /document\.addEventListener\("pointerdown", function \(\) \s*\{\s*noteStatusActivity\(\);\s*\}, true\);/
    );
    expect(mainJs).toMatch(
      /document\.addEventListener\("keydown", function \(\) \s*\{\s*noteStatusActivity\(\);\s*\}, true\);/
    );

    for (const name of [
      'createThread',
      'createBrowserPane',
      'openOrFocusGitPane',
      'closeThread',
      'hideThread',
      'reopenThread',
      'retryThread',
    ]) {
      expect(functionSource(mainJs, name)).toContain('noteStatusActivity();');
    }
    expect(mainJs).not.toContain('function popOutGitPane(');
    expect(functionSource(mainJs, 'openOrFocusGitPane')).toContain('renderGitSurface();');

    expect(functionSource(mainJs, 'boot')).toMatch(
      /state\.env = env \|\| \{\};[\s\S]*statusController[\s\S]*statusController\.start\(\);/s
    );
    expect(mainJs).toMatch(
      /window\.addEventListener\("beforeunload", function \(\) \{[\s\S]*saveWorkspaceNow\(\);[\s\S]*if \(statusController\) statusController\.stop\(\);[\s\S]*\}\);/s
    );
    expect(functionSource(mainJs, 'covenSessionsForProject')).toContain('covenSessionAssignments()');
    expect(functionSource(mainJs, 'covenSessionsForProject')).toContain('owned.get(project.id) || []');
    expect(functionSource(mainJs, 'covenSessionsForProject')).not.toContain('allSessionsByProject');
    expect(functionSource(mainJs, 'allCovenSessionsForProject')).toContain('allSessionsByProject.get(root) || []');
  });
});
