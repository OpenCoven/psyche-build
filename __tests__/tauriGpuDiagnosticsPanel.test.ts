import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

function functionSource(source: string, name: string): string {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match || match.index === undefined) throw new Error(`missing function ${name}`);

  const bodyStart = source.indexOf('{', match.index + match[0].length);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function compileFunction<T>(
  source: string,
  name: string,
  dependencies: Record<string, unknown> = {},
): T {
  const keys = Object.keys(dependencies);
  return Function(...keys, `"use strict"; return (${functionSource(source, name)});`)(
    ...keys.map((key) => dependencies[key]),
  ) as T;
}

function installGpuDiagnosticsGlobals(values: Record<string, unknown>): () => void {
  const target = globalThis as Record<string, unknown>;
  const prior = Object.entries(values).map(([key]) => ({
    key,
    exists: Object.prototype.hasOwnProperty.call(target, key),
    value: target[key],
  }));
  Object.assign(target, values);
  return () => {
    for (const entry of prior) {
      if (entry.exists) target[entry.key] = entry.value;
      else delete target[entry.key];
    }
  };
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

  it('does not translate alternate native diagnostics authorization properties', () => {
    const source = readWebFile('main.js');
    const normalizer = source.slice(
      source.indexOf('function normalizeNativeDiagnostics'),
      source.indexOf('function presentGpuDiagnosticsRows'),
    );

    expect(normalizer).not.toContain('report.debug_build');
    expect(normalizer).not.toContain('report.stress_authorized');
  });

  it('rejects malformed nested native process reports before stress authorization', () => {
    const normalizeNativeDiagnostics = compileFunction<
      (report: unknown) => Record<string, unknown>
    >(readWebFile('main.js'), 'normalizeNativeDiagnostics');
    const report = {
      os: 'macos',
      arch: 'aarch64',
      engine: 'WKWebView',
      debugBuild: true,
      stressAuthorized: true,
    };

    expect(normalizeNativeDiagnostics({
      ...report,
      process: { cpuPercent: 10, rssBytes: 512 },
    })).toEqual({
      ...report,
      process: { cpuPercent: 10, rssBytes: 512 },
    });
    expect(normalizeNativeDiagnostics({
      ...report,
      process: { cpuPercent: 0 },
    })).toEqual({
      ...report,
      process: { cpuPercent: 0 },
    });
    expect(normalizeNativeDiagnostics({
      ...report,
      process: { rssBytes: 0 },
    })).toEqual({
      ...report,
      process: { rssBytes: 0 },
    });

    for (const process of [
      { cpu_percent: 10 },
      { rss_bytes: 512 },
      { cpuPercent: 10, extra: true },
      { cpuPercent: -1 },
      { cpuPercent: Number.NaN },
      { cpuPercent: Number.POSITIVE_INFINITY },
      { rssBytes: -1 },
      { rssBytes: 1.5 },
      { rssBytes: Number.MAX_SAFE_INTEGER + 1 },
      { cpuPercent: '10' },
      Object.assign(Object.create(null), { cpuPercent: 10 }),
    ]) {
      expect(normalizeNativeDiagnostics({ ...report, process })).toEqual({});
    }
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

  it('restores or clears the workspace snapshot after every terminal setup failure', () => {
    const source = readWebFile('main.js');
    const terminalAdapter = source.slice(
      source.indexOf('async function createGpuDiagnosticsStressTerminal'),
      source.indexOf('async function createGpuDiagnosticsStressEditor'),
    );

    expect(terminalAdapter).toMatch(
      /if \(!thread\) \{\s*await restoreGpuDiagnosticsStressWorkspace\(\);\s*throw new Error/,
    );
    expect(terminalAdapter).toMatch(
      /catch \(error\) \{[\s\S]*await restoreGpuDiagnosticsStressWorkspace\(\);[\s\S]*throw error;/,
    );
    expect(terminalAdapter).toMatch(
      /try \{\s*var controller = ensureThreadPtyController\(thread\);/,
    );
  });

  it('keeps force disposal available when graceful diagnostics cleanup rejects', () => {
    const source = readWebFile('main.js');
    const resourceFactory = source.slice(
      source.indexOf('function createGpuDiagnosticsStressResource'),
      source.indexOf('async function closeGpuDiagnosticsStressThread'),
    );

    expect(resourceFactory).toContain('var cleanupCompleted = false;');
    expect(resourceFactory).toContain(
      'if (cleanupCompleted) return forceFlight || Promise.resolve();',
    );
  });

  it('waits for force cleanup to settle before removing a resource and restoring workspace', async () => {
    let resolveForceCleanup!: () => void;
    const forceCleanup = new Promise<void>((resolve) => {
      resolveForceCleanup = resolve;
    });
    const resources = new Map();
    const restorationCalls: string[] = [];
    const restoreGlobals = installGpuDiagnosticsGlobals({
      gpuDiagnosticsStressResources: resources,
    });
    try {
      const createGpuDiagnosticsStressResource = compileFunction<
        (
          id: string,
          record: Record<string, unknown>,
          dispose: () => Promise<void>,
          forceDispose: () => Promise<void>,
        ) => { dispose(): Promise<void>; forceDispose(): void }
      >(readWebFile('main.js'), 'createGpuDiagnosticsStressResource', {
        throwIfGpuDiagnosticsStressAborted: () => {},
        restoreGpuDiagnosticsStressWorkspace: async () => {
          restorationCalls.push('restored');
        },
      });
      const resource = createGpuDiagnosticsStressResource(
        'diagnostic-tab',
        { kind: 'browser' },
        async () => {
          throw new Error('graceful cleanup failed');
        },
        () => forceCleanup,
      );

      await expect(resource.dispose()).rejects.toThrow('graceful cleanup failed');
      expect(resources.has('diagnostic-tab')).toBe(true);
      expect(restorationCalls).toEqual([]);

      resolveForceCleanup();
      await forceCleanup;
      await Promise.resolve();
      await Promise.resolve();

      expect(resources.has('diagnostic-tab')).toBe(false);
      expect(restorationCalls).toEqual(['restored']);
    } finally {
      restoreGlobals();
    }
  });

  it('keeps a failed force cleanup tracked until a later retry settles', async () => {
    const resources = new Map();
    const restorationCalls: string[] = [];
    let attempts = 0;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const restoreGlobals = installGpuDiagnosticsGlobals({
      gpuDiagnosticsStressResources: resources,
    });
    try {
      const createGpuDiagnosticsStressResource = compileFunction<
        (
          id: string,
          record: Record<string, unknown>,
          dispose: () => Promise<void>,
          forceDispose: () => Promise<void>,
        ) => { forceDispose(): void }
      >(readWebFile('main.js'), 'createGpuDiagnosticsStressResource', {
        throwIfGpuDiagnosticsStressAborted: () => {},
        restoreGpuDiagnosticsStressWorkspace: async () => {
          restorationCalls.push('restored');
        },
      });
      const resource = createGpuDiagnosticsStressResource(
        'diagnostic-tab',
        { kind: 'browser' },
        async () => {},
        async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('force cleanup failed');
        },
      );

      resource.forceDispose();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(resources.has('diagnostic-tab')).toBe(true);
      expect(restorationCalls).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(
        '[psyche:graphics] diagnostics force cleanup failed: Error: force cleanup failed',
      );

      resource.forceDispose();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(attempts).toBe(2);
      expect(resources.has('diagnostic-tab')).toBe(false);
      expect(restorationCalls).toEqual(['restored']);
    } finally {
      restoreGlobals();
      errorSpy.mockRestore();
    }
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

  it('restores the pre-existing browser active tab after diagnostic tab cleanup', () => {
    const source = readWebFile('main.js');
    const snapshot = source.slice(
      source.indexOf('function beginGpuDiagnosticsStressWorkspace'),
      source.indexOf('function gpuDiagnosticsStressWorkspaceIsUnchanged'),
    );
    const restore = source.slice(
      source.indexOf('async function restoreGpuDiagnosticsStressWorkspace'),
      source.indexOf('function createGpuDiagnosticsStressResource'),
    );

    expect(snapshot).toContain('browserPaneId');
    expect(snapshot).toContain('browserActiveTabId');
    expect(restore).toContain('browser.activeTabId = snapshot.browserActiveTabId');
  });

  it('restores a dormant browser selection without a mounted browser pane or deleted tabs', async () => {
    const resources = new Map();
    const browser = {
      activeTabId: 'user-tab',
      tabs: [
        { id: 'user-tab', created: false, url: 'https://example.test' },
        { id: 'diagnostic-tab', created: true, url: 'about:blank' },
      ],
    };
    const project = {
      id: 'project-a',
      selectedWorktreePath: '/workspace',
      closing: false,
      browsersByWorktree: { '/workspace': browser },
    };
    const state = {
      activeProjectId: project.id,
      activeThreadId: null,
      activeFileId: null,
      threads: [],
      openFiles: [],
    };
    const calls: string[] = [];
    const restoreGlobals = installGpuDiagnosticsGlobals({
      gpuDiagnosticsStressResources: resources,
      gpuDiagnosticsStressWorkspace: null,
      activeSurface: 'browser',
      window: {
        getComputedStyle: () => ({
          getPropertyValue: () => '240',
        }),
      },
      document: { documentElement: {} },
    });
    try {
      const globals = globalThis as Record<string, unknown>;
      const beginGpuDiagnosticsStressWorkspace = compileFunction<
        () => { browserPaneId: string | null; browserActiveTabId: string | null }
      >(readWebFile('main.js'), 'beginGpuDiagnosticsStressWorkspace', {
        activeProject: () => project,
        activeWorkspaceRoot: () => '/workspace',
        paneLayoutKey: () => 'project-a:/workspace',
        paneLayouts: new Map(),
        cloneGpuDiagnosticsLayout: (layout: unknown) => layout,
        state,
        sidebarOpen: () => true,
        findBrowserPane: () => null,
      });
      const restoreGpuDiagnosticsStressWorkspace = compileFunction<
        () => Promise<void>
      >(readWebFile('main.js'), 'restoreGpuDiagnosticsStressWorkspace', {
        findProject: () => project,
        gpuDiagnosticsStressWorkspaceIsUnchanged: () => true,
        paneLayouts: new Map(),
        cloneGpuDiagnosticsLayout: (layout: unknown) => layout,
        scheduleSidebarWidth: () => {},
        setSidebarOpen: () => {},
        assignActiveProjectId: () => {},
        state,
        findBrowserPane: () => null,
        ensureBrowserModel: () => browser,
        renderPaneWorkspace: () => calls.push('workspace'),
        refreshSidebar: () => calls.push('sidebar'),
        refreshTabs: () => calls.push('tabs'),
        renderBrowserTabs: () => calls.push('browser-tabs'),
        syncUrlInput: () => calls.push('url'),
        findOpenFile: () => null,
        activateFileTab: async () => false,
        findThread: () => null,
        focusThread: async () => false,
      });

      expect(beginGpuDiagnosticsStressWorkspace()).toMatchObject({
        browserPaneId: null,
        browserActiveTabId: 'user-tab',
      });
      browser.activeTabId = 'diagnostic-tab';
      await restoreGpuDiagnosticsStressWorkspace();

      expect(browser.activeTabId).toBe('user-tab');
      expect(calls).toEqual([
        'workspace',
        'sidebar',
        'tabs',
        'browser-tabs',
        'url',
      ]);
      browser.tabs.splice(1, 1);
      browser.activeTabId = 'user-tab';
      globals.gpuDiagnosticsStressWorkspace = {
        projectId: project.id,
        worktreePath: '/workspace',
        selectedWorktreePath: '/workspace',
        activeProjectId: project.id,
        activeThreadId: null,
        activeFileId: null,
        activeSurface: 'terminal',
        sidebarOpen: true,
        sidebarWidth: null,
        layoutKey: 'project-a:/workspace',
        layout: null,
        threadIds: [],
        fileIds: [],
        browserPaneId: null,
        browserActiveTabId: 'deleted-tab',
      };
      await restoreGpuDiagnosticsStressWorkspace();

      expect(browser).toEqual({
        activeTabId: 'user-tab',
        tabs: [{ id: 'user-tab', created: false, url: 'https://example.test' }],
      });
    } finally {
      restoreGlobals();
    }
  });

  it('cleans diagnostic browser tabs in their original worktree', () => {
    const source = readWebFile('main.js');
    const cleanup = source.slice(
      source.indexOf('async function cleanupGpuDiagnosticsStressBrowserResources'),
      source.indexOf('async function createGpuDiagnosticsStressBrowser'),
    );

    expect(cleanup).toContain('closeBrowserTab(project, tab.id, pane.worktreePath)');
  });

  it('does not claim a user browser pane that appears during diagnostics setup', () => {
    const source = readWebFile('main.js');
    const browserAdapter = source.slice(
      source.indexOf('async function createGpuDiagnosticsStressBrowser'),
      source.indexOf('async function focusGpuDiagnosticsStressResource'),
    );

    expect(browserAdapter).toContain('onCreated: function (candidate)');
    expect(browserAdapter).toContain('createdPane === pane');
    expect(browserAdapter).not.toContain('createdPane: !existingPane');
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
    expect(source).not.toContain('stress_authorized');
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
