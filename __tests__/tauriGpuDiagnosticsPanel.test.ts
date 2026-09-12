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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('Tauri GPU diagnostics panel', () => {
  it.each(['disposal', 'cancelled setup', 'ordinary close'] as const)(
    'confirms diagnostics shutdown without changing ordinary close semantics: %s', async (scenario) => {
    const thread = {
      id: 'diagnostic-terminal', kind: 'shell', projectId: 'project',
      ptyStarted: true, ptyGeneration: 7, status: 'running',
      stopRequested: false, closeStarted: false, closing: false,
      metricsGeneration: 0, terminalController: { dispose: vi.fn() },
    };
    const state = { threads: [thread], activeThreadId: null };
    const resources = new Map();
    const handles = new Map();
    const controller = new AbortController();
    let stopSucceeds = scenario === 'cancelled setup';
    const invoke = vi.fn(async (command: string) => {
      if (command === 'diagnostics_spawn_fixture' && scenario === 'cancelled setup') {
        controller.abort(new Error('setup cancelled'));
      }
      if (command === 'pty_current_generation') return 7;
      if (command === 'pty_stop' && !stopSucceeds) throw new Error('native stop rejected');
    });
    const restore = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const source = readWebFile('main.js');
    const deps = {
      state, invoke, findThread: (id: string) => state.threads.find((t) => t.id === id),
      isPersistentThread: () => false, setStatus: vi.fn(),
      forgetThreadInSets: vi.fn(), detachThreadPane: vi.fn(),
      renderPaneWorkspace: vi.fn(), refreshSidebar: vi.fn(), refreshTabs: vi.fn(),
      controller,
      gpuDiagnosticsStressResources: resources,
      gpuDiagnosticsStressCleanupHandles: handles,
      restoreGpuDiagnosticsStressWorkspace: restore,
      beginGpuDiagnosticsStressWorkspace: () => ({ projectId: 'project', worktreePath: '/workspace' }),
      assertGpuDiagnosticsStressOperationCurrent: () => {},
      gpuDiagnosticsStressOperationIsCurrent: () => true,
      findProject: () => ({ id: 'project' }), activeWorkspaceRoot: () => '/workspace',
      createThread: async () => thread, ensureThreadPtyController: () => thread.terminalController,
      isLiveThread: () => true, syncThreadPaneMetadata: () => {},
    };
    const factory = Function(...Object.keys(deps), `
      ${['stopThreadPty', 'closeThread', 'closeGpuDiagnosticsStressThread', 'throwIfGpuDiagnosticsStressAborted',
        'createGpuDiagnosticsStressResource', 'createGpuDiagnosticsStressTerminal']
        .map((name) => functionSource(source, name)).join('\n')}
      return {
        create: () => createGpuDiagnosticsStressTerminal(0, "steady", controller.signal),
        close: (id) => closeThread(id, { focus: false, persist: false }),
      };
    `)(...Object.values(deps)) as {
      create(): Promise<{ dispose(): Promise<void>; forceDispose(): Promise<void> }>;
      close(id: string): Promise<boolean>;
    };
    try {
      if (scenario === 'cancelled setup') {
        await expect(factory.create()).rejects.toThrow('setup cancelled');
        expect(state.threads).toEqual([]);
        expect(invoke.mock.calls.filter(([command]) => command === 'pty_stop')).toHaveLength(1);
        return;
      }
      if (scenario === 'ordinary close') {
        await expect(factory.close(thread.id)).resolves.toBe(true);
        expect(state.threads).toEqual([]);
        return;
      }
      const resource = await factory.create();
      await expect(resource.dispose()).rejects.toThrow('diagnostics cleanup and forced cleanup failed');
      expect(state.threads).toEqual([thread]);
      expect(thread.terminalController.dispose).not.toHaveBeenCalled();
      expect(resources.get(thread.id)).toEqual({ kind: 'terminal', thread });
      expect(handles.get(thread.id)).toBe(resource);
      expect(restore).not.toHaveBeenCalled();
      await expect(resource.forceDispose()).rejects.toThrow('cleanup was not confirmed');
      expect(thread.closeStarted).toBe(false);
      expect(thread.stopRequested).toBe(false);
      stopSucceeds = true;
      await resource.forceDispose();
      expect(invoke.mock.calls.filter(([command]) => command === 'pty_stop')).toHaveLength(4);
      expect(invoke).toHaveBeenLastCalledWith('pty_stop', {
        threadId: thread.id, thread_id: thread.id, generation: 7,
      });
      expect(state.threads).toEqual([]);
      expect(resources.size).toBe(0);
      expect(handles.size).toBe(0);
      expect(restore).toHaveBeenCalledOnce();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('restores the loaded editor document and Files pane after closing a synthetic tab', async () => {
    const project = { id: 'project', selectedWorktreePath: '/workspace' };
    const files = ['A', 'B', 'diagnostic'].map((id) => ({
      id, text: `document ${id}`, projectId: project.id, workspaceRoot: '/workspace',
    }));
    const state = {
      activeProjectId: project.id, activeThreadId: null, activeFileId: 'A',
      openFiles: [...files], threads: [],
    };
    const pane = { activeFileId: 'A' };
    const workspace = {
      projectId: project.id, activeProjectId: project.id, worktreePath: '/workspace',
      selectedWorktreePath: '/workspace', activeThreadId: null, activeFileId: 'A',
      activeSurface: 'terminal', focusedSurface: 'file', focusedFileId: 'A',
      sidebarWidth: null, sidebarOpen: true, layoutKey: 'layout', layout: null,
      threadIds: [], fileIds: ['A', 'B'],
    };
    let document = '';
    const deps = {
      state, findProject: () => project,
      findOpenFile: (id: string) => state.openFiles.find((file) => file.id === id),
      filesPanes: new Map([['files', pane]]), filesPaneKey: () => 'files',
      filesForPane: () => state.openFiles,
      ensureFilesPane: () => pane, assignSelectedWorktreePath: () => {},
      fileFocus: {}, fileViewEl: { hidden: true },
      focusCanvasSurface: () => {}, syncPaneMetricsVisibility: () => {},
      syncAllPtyVisibility: () => {}, renderPaneMinimap: () => {}, activePaneLayout: () => null,
      renderPaneWorkspace: () => {}, markActiveSurface: () => {}, refreshTabs: () => {},
      renderFileChrome: () => {}, guardDirtyFile: async () => true,
      fileEditor: { focus: () => {}, setDocument: (value: { text: string }) => { document = value.text; } },
      gpuDiagnosticsStressResources: new Map(), gpuDiagnosticsStressWorkspace: workspace,
      activeWorkspaceRoot: () => '/workspace', discardGpuDiagnosticsStressWorkspace: () => {},
      paneLayouts: new Map(), setSidebarOpen: () => {},
      refreshSidebar: () => {}, renderBrowserTabs: () => {}, syncUrlInput: () => {},
    };
    const source = readWebFile('main.js');
    const api = Function(...Object.keys(deps), `
      var loadedEditorFileId = null, activeSurface = "terminal";
      var fileNavigationInFlight = false, fileDecisionInFlight = false;
      ${['enterFileFocus', 'isEditableFile', 'renderFileView', 'activateFileTabNow',
        'activateFileTab', 'closeFileTab', 'gpuDiagnosticsStressWorkspaceIsUnchanged',
        'restoreGpuDiagnosticsStressWorkspace'].map((name) => functionSource(source, name)).join('\n')}
      return { activateFileTab, closeFileTab, restoreGpuDiagnosticsStressWorkspace };
    `)(...Object.values(deps)) as {
      activateFileTab(id: string): Promise<boolean>;
      closeFileTab(id: string): Promise<boolean>;
      restoreGpuDiagnosticsStressWorkspace(): Promise<void>;
    };
    await api.activateFileTab('diagnostic');
    expect(document).toBe('document diagnostic');
    await api.closeFileTab('diagnostic');
    expect([state.activeFileId, pane.activeFileId, document]).toEqual(['B', 'B', 'document B']);
    await api.restoreGpuDiagnosticsStressWorkspace();
    expect([state.activeFileId, pane.activeFileId, document]).toEqual(['A', 'A', 'document A']);
  });

  it('does not present live stress resources as cleanup recovery during an active run', () => {
    const retry = { hidden: false, disabled: false };
    const progress = { textContent: 'Scenario running' };
    const render = compileFunction<() => void>(readWebFile('main.js'), 'renderGpuDiagnostics', {
      gpuDiagnosticsReport: {}, gpuDiagnosticsStressAdaptersAvailable: () => true,
      gpuDiagnosticsStressResources: new Map([['live', {}]]),
      gpuDiagnosticsStressWorkspace: {}, gpuDiagnosticsStressController: new AbortController(),
      gpuDiagnosticsStressRecoveryFlight: null, presentGpuDiagnosticsRows: () => {},
      gpuDiagnosticsStatusEl: null, gpuDiagnosticsFallbackEl: null,
      gpuDiagnosticsStressControlsEl: null, gpuDiagnosticsRunStressEl: null,
      gpuDiagnosticsCancelStressEl: null, gpuDiagnosticsRetryCleanupEl: retry,
      gpuDiagnosticsProgressEl: progress, gpuDiagnosticsStressAuthorized: true,
    });
    render();
    expect(retry).toEqual({ hidden: true, disabled: true });
    expect(progress.textContent).toBe('Scenario running');
  });

  it.each([false, true])('rejects cleanup callbacks until the run settles (aborted: %s)', async (aborted) => {
    const controller = new AbortController();
    if (aborted) controller.abort();
    const forceDispose = vi.fn();
    const restore = vi.fn();
    const retry = compileFunction<() => Promise<void>>(readWebFile('main.js'), 'retryGpuDiagnosticsStressCleanup', {
      gpuDiagnosticsStressController: controller, gpuDiagnosticsStressRecoveryFlight: null,
      gpuDiagnosticsStressCleanupHandles: new Map([['live', { forceDispose }]]),
      gpuDiagnosticsStressResources: new Map(),
      restoreGpuDiagnosticsStressWorkspace: restore, renderGpuDiagnostics: () => {},
    });
    await expect(retry()).rejects.toThrow('stress run is still active');
    expect(forceDispose).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

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

  it('fails closed for malformed reports and enables Run only with installed adapters, no active run, and no owned cleanup', () => {
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
    expect(isGpuDiagnosticsStressRunEnabled(true, true, false, true)).toBe(false);
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
      /if \(!thread\) \{\s*await restoreGpuDiagnosticsStressWorkspace\(workspace\);\s*throw new Error/,
    );
    expect(terminalAdapter).toMatch(
      /catch \(error\) \{[\s\S]*await restoreGpuDiagnosticsStressWorkspace\(workspace\);[\s\S]*throw error;/,
    );
    expect(terminalAdapter).toMatch(
      /try \{\s*var controller = ensureThreadPtyController\(thread\);/,
    );
  });

  it('routes completed cleanup through restoration recovery', () => {
    const source = readWebFile('main.js');
    const resourceFactory = source.slice(
      source.indexOf('function createGpuDiagnosticsStressResource'),
      source.indexOf('async function closeGpuDiagnosticsStressThread'),
    );

    expect(resourceFactory).toContain('var cleanupCompleted = false;');
    expect(resourceFactory).toContain(
      'if (cleanupCompleted) return finish();',
    );
  });

  it('waits for forced cleanup and restoration before rejecting graceful disposal', async () => {
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

      let settled = false;
      const disposal = resource.dispose().catch((error: unknown) => {
        settled = true;
        throw error;
      });
      await Promise.resolve();
      expect(resources.has('diagnostic-tab')).toBe(true);
      expect(restorationCalls).toEqual([]);
      expect(settled).toBe(false);

      resolveForceCleanup();
      await expect(disposal).rejects.toThrow('graceful cleanup failed');

      expect(resources.has('diagnostic-tab')).toBe(false);
      expect(restorationCalls).toEqual(['restored']);
    } finally {
      restoreGlobals();
    }
  });

  it('returns force cleanup only after workspace restoration completes', async () => {
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
        ) => { forceDispose(): Promise<void> }
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
        () => forceCleanup,
      );

      const completed = resource.forceDispose();
      expect(completed).toBeInstanceOf(Promise);
      expect(resources.has('diagnostic-tab')).toBe(true);
      expect(restorationCalls).toEqual([]);

      resolveForceCleanup();
      await completed;

      expect(resources.has('diagnostic-tab')).toBe(false);
      expect(restorationCalls).toEqual(['restored']);
    } finally {
      restoreGlobals();
    }
  });

  it('retries rejected focus restoration before releasing cleanup ownership', async () => {
    const resources = new Map();
    const cleanupHandles = new Map();
    const browser = {
      activeTabId: 'diagnostic-tab',
      tabs: [{ id: 'user-tab' }, { id: 'diagnostic-tab' }],
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
    const workspace = Object.freeze({
      projectId: project.id,
      worktreePath: '/workspace',
      selectedWorktreePath: '/workspace',
      activeProjectId: project.id,
      activeThreadId: null,
      activeFileId: null,
      activeSurface: 'browser',
      focusedSurface: 'browser',
      focusedThreadId: null,
      focusedFileId: null,
      focusedBrowserTabId: 'user-tab',
      sidebarOpen: true,
      sidebarWidth: null,
      layoutKey: 'project-a:/workspace',
      layout: null,
      threadIds: Object.freeze([]),
      fileIds: Object.freeze([]),
      browserPaneId: 'browser-pane',
      browserActiveTabId: 'user-tab',
    });
    let disposalAttempts = 0;
    let forceDisposalAttempts = 0;
    let discardAttempts = 0;
    let focusAttempts = 0;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const restoreGlobals = installGpuDiagnosticsGlobals({
      gpuDiagnosticsStressResources: resources,
      gpuDiagnosticsStressCleanupHandles: cleanupHandles,
      gpuDiagnosticsStressRecoveryFlight: null,
    });

    try {
      const restoreGpuDiagnosticsStressWorkspace = compileFunction<
        (
          workspace: object,
          resourceId?: string,
          resource?: Record<string, unknown>,
        ) => Promise<void>
      >(readWebFile('main.js'), 'restoreGpuDiagnosticsStressWorkspace', {
        gpuDiagnosticsStressWorkspace: workspace,
        gpuDiagnosticsStressResources: resources,
        activeSurface: 'browser',
        findProject: () => project,
        gpuDiagnosticsStressWorkspaceIsUnchanged: () => true,
        discardGpuDiagnosticsStressWorkspace: () => {
          discardAttempts += 1;
        },
        paneLayouts: new Map(),
        cloneGpuDiagnosticsLayout: (layout: unknown) => layout,
        scheduleSidebarWidth: () => {},
        setSidebarOpen: () => {},
        assignActiveProjectId: () => {},
        state,
        renderPaneWorkspace: () => {},
        refreshSidebar: () => {},
        refreshTabs: () => {},
        renderBrowserTabs: () => {},
        syncUrlInput: () => {},
        findOpenFile: () => null,
        activateFileTab: async () => false,
        findThread: () => null,
        focusThread: async () => false,
        activateBrowserTab: async () => {
          focusAttempts += 1;
          if (focusAttempts === 1) throw new Error('browser focus rejected');
          return true;
        },
      });
      const createGpuDiagnosticsStressResource = compileFunction<
        (
          id: string,
          record: Record<string, unknown>,
          dispose: () => Promise<void>,
          forceDispose: () => Promise<void>,
          workspace?: object,
        ) => { dispose(): Promise<void>; forceDispose(): Promise<void> }
      >(readWebFile('main.js'), 'createGpuDiagnosticsStressResource', {
        throwIfGpuDiagnosticsStressAborted: () => {},
        gpuDiagnosticsStressResources: resources,
        gpuDiagnosticsStressCleanupHandles: cleanupHandles,
        restoreGpuDiagnosticsStressWorkspace,
      });
      const retryGpuDiagnosticsStressCleanup = compileFunction<
        () => Promise<void>
      >(readWebFile('main.js'), 'retryGpuDiagnosticsStressCleanup', {
        gpuDiagnosticsStressController: null,
        gpuDiagnosticsStressRecoveryFlight: null,
        gpuDiagnosticsStressCleanupHandles: cleanupHandles,
        gpuDiagnosticsStressResources: resources,
        restoreGpuDiagnosticsStressWorkspace,
        renderGpuDiagnostics: () => {},
      });
      const resource = createGpuDiagnosticsStressResource(
        'diagnostic-tab',
        { kind: 'browser' },
        async () => {
          disposalAttempts += 1;
        },
        async () => {
          forceDisposalAttempts += 1;
        },
        workspace,
      );

      await expect(resource.dispose()).rejects.toThrow('browser focus rejected');
      expect(disposalAttempts).toBe(1);
      expect(forceDisposalAttempts).toBe(0);
      expect(focusAttempts).toBe(1);
      expect(discardAttempts).toBe(0);
      expect(resources.has('diagnostic-tab')).toBe(true);
      expect(cleanupHandles.has('diagnostic-tab')).toBe(true);
      expect(isGpuDiagnosticsStressRunEnabled(true, true, false, resources.size > 0))
        .toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        '[psyche:graphics] diagnostics workspace restoration failed: Error: browser focus rejected',
      );

      await retryGpuDiagnosticsStressCleanup();

      expect(focusAttempts).toBe(2);
      expect(discardAttempts).toBe(1);
      expect(disposalAttempts).toBe(1);
      expect(forceDisposalAttempts).toBe(0);
      expect(resources.size).toBe(0);
      expect(cleanupHandles.size).toBe(0);
      expect(isGpuDiagnosticsStressRunEnabled(true, true, false, resources.size > 0))
        .toBe(true);
    } finally {
      restoreGlobals();
      errorSpy.mockRestore();
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

  it('keeps Run non-runnable after graceful and forced cleanup fail until owned recovery retries', async () => {
    const resources = new Map();
    const cleanupHandles = new Map();
    const restorationCalls: string[] = [];
    let forceAttempts = 0;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const restoreGlobals = installGpuDiagnosticsGlobals({
      gpuDiagnosticsStressResources: resources,
      gpuDiagnosticsStressCleanupHandles: cleanupHandles,
      gpuDiagnosticsStressRecoveryFlight: null,
    });
    try {
      const createGpuDiagnosticsStressResource = compileFunction<
        (
          id: string,
          record: Record<string, unknown>,
          dispose: () => Promise<void>,
          forceDispose: () => Promise<void>,
        ) => { dispose(): Promise<void> }
      >(readWebFile('main.js'), 'createGpuDiagnosticsStressResource', {
        throwIfGpuDiagnosticsStressAborted: () => {},
        restoreGpuDiagnosticsStressWorkspace: async () => {
          restorationCalls.push('restored');
        },
      });
      const retryGpuDiagnosticsStressCleanup = compileFunction<
        () => Promise<void>
      >(readWebFile('main.js'), 'retryGpuDiagnosticsStressCleanup', {
        gpuDiagnosticsStressController: null,
        restoreGpuDiagnosticsStressWorkspace: async () => {
          restorationCalls.push('restored');
        },
        renderGpuDiagnostics: () => {},
      });
      const resource = createGpuDiagnosticsStressResource(
        'diagnostic-tab',
        { kind: 'browser' },
        async () => {
          throw new Error('graceful cleanup failed');
        },
        async () => {
          forceAttempts += 1;
          if (forceAttempts === 1) throw new Error('forced cleanup failed');
        },
      );

      await expect(resource.dispose()).rejects.toThrow(
        'diagnostics cleanup and forced cleanup failed',
      );
      expect(resources.has('diagnostic-tab')).toBe(true);
      expect(cleanupHandles.has('diagnostic-tab')).toBe(true);
      expect(restorationCalls).toEqual([]);
      expect(isGpuDiagnosticsStressRunEnabled(true, true, false, resources.size > 0))
        .toBe(false);

      await retryGpuDiagnosticsStressCleanup();

      expect(forceAttempts).toBe(2);
      expect(resources.size).toBe(0);
      expect(cleanupHandles.size).toBe(0);
      expect(restorationCalls).toEqual(['restored']);
      expect(isGpuDiagnosticsStressRunEnabled(true, true, false, resources.size > 0))
        .toBe(true);
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

    expect(workspaceGuard).toContain('activeWorkspaceRoot(project) !== snapshot.worktreePath');
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
        invalidateGpuDiagnosticsStressOperations: () => 1,
      });
      const restoreGpuDiagnosticsStressWorkspace = compileFunction<
        () => Promise<void>
      >(readWebFile('main.js'), 'restoreGpuDiagnosticsStressWorkspace', {
        findProject: () => project,
        gpuDiagnosticsStressWorkspaceIsUnchanged: () => true,
        activeSurface: 'browser',
        discardGpuDiagnosticsStressWorkspace: () => {
          (globalThis as Record<string, unknown>).gpuDiagnosticsStressWorkspace = null;
        },
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
        activateBrowserTab: async () => true,
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

  it.each([
    ['terminal', ['thread:terminal-thread']],
    ['browser', ['browser:user-tab']],
  ] as const)(
    'restores the original %s focus instead of an editor selection',
    async (focusedSurface, expectedCalls) => {
      const resources = new Map();
      const browser = {
        activeTabId: 'diagnostic-tab',
        tabs: [{ id: 'user-tab' }, { id: 'diagnostic-tab' }],
      };
      const project = {
        id: 'project-a',
        selectedWorktreePath: '/workspace',
        closing: false,
        browsersByWorktree: { '/workspace': browser },
      };
      const state = {
        activeProjectId: project.id,
        activeThreadId: 'diagnostic-thread',
        activeFileId: 'editor-selected',
        threads: [{ id: 'terminal-thread' }],
        openFiles: [{ id: 'editor-selected' }],
      };
      const calls: string[] = [];
      const restoreGlobals = installGpuDiagnosticsGlobals({
        gpuDiagnosticsStressResources: resources,
        gpuDiagnosticsStressWorkspace: {
          projectId: project.id,
          worktreePath: '/workspace',
          selectedWorktreePath: '/workspace',
          activeProjectId: project.id,
          activeThreadId: 'terminal-thread',
          activeFileId: 'editor-selected',
          activeSurface: focusedSurface,
          focusedSurface,
          focusedThreadId: 'terminal-thread',
          focusedFileId: 'editor-selected',
          focusedBrowserTabId: 'user-tab',
          sidebarOpen: true,
          sidebarWidth: null,
          layoutKey: 'project-a:/workspace',
          layout: null,
          threadIds: ['terminal-thread'],
          fileIds: ['editor-selected'],
          browserPaneId: 'browser-pane',
          browserActiveTabId: 'user-tab',
        },
      });
      try {
        const restoreGpuDiagnosticsStressWorkspace = compileFunction<
          () => Promise<void>
        >(readWebFile('main.js'), 'restoreGpuDiagnosticsStressWorkspace', {
          findProject: () => project,
          gpuDiagnosticsStressWorkspaceIsUnchanged: () => true,
          activeSurface: 'terminal',
          discardGpuDiagnosticsStressWorkspace: () => {
            (globalThis as Record<string, unknown>).gpuDiagnosticsStressWorkspace = null;
          },
          paneLayouts: new Map(),
          cloneGpuDiagnosticsLayout: (layout: unknown) => layout,
          scheduleSidebarWidth: () => {},
          setSidebarOpen: () => {},
          assignActiveProjectId: () => {},
          state,
          renderPaneWorkspace: () => {},
          refreshSidebar: () => {},
          refreshTabs: () => {},
          renderBrowserTabs: () => {},
          syncUrlInput: () => {},
          findOpenFile: (id: string) => state.openFiles.find((file) => file.id === id) ?? null,
          activateFileTab: async (id: string) => {
            calls.push(`file:${id}`);
            return true;
          },
          findThread: (id: string) => state.threads.find((thread) => thread.id === id) ?? null,
          focusThread: async (id: string) => {
            calls.push(`thread:${id}`);
            return true;
          },
          activateBrowserTab: async (_project: unknown, id: string) => {
            calls.push(`browser:${id}`);
            return true;
          },
        });

        await restoreGpuDiagnosticsStressWorkspace();

        expect(state.activeFileId).toBe('editor-selected');
        expect(browser.activeTabId).toBe('user-tab');
        expect(calls).toEqual(expectedCalls);
      } finally {
        restoreGlobals();
      }
    },
  );

  it('discards a drifted workspace snapshot so the next run captures the current workspace', async () => {
    const resources = new Map();
    const staleProject = {
      id: 'project-a',
      selectedWorktreePath: '/stale',
      closing: false,
      browsersByWorktree: {},
    };
    const currentProject = {
      id: 'project-b',
      selectedWorktreePath: '/current',
      closing: false,
      browsersByWorktree: {},
    };
    const state = {
      activeProjectId: currentProject.id,
      activeThreadId: null,
      activeFileId: null,
      threads: [],
      openFiles: [],
    };
    const staleWorkspace = {
      projectId: staleProject.id,
      worktreePath: '/stale',
      selectedWorktreePath: '/stale',
      activeProjectId: staleProject.id,
      activeThreadId: null,
      activeFileId: null,
      activeSurface: 'terminal',
      sidebarOpen: true,
      sidebarWidth: null,
      layoutKey: 'project-a:/stale',
      layout: null,
      threadIds: [],
      fileIds: [],
      browserPaneId: null,
      browserActiveTabId: null,
    };
    const restoreGlobals = installGpuDiagnosticsGlobals({
      gpuDiagnosticsStressResources: resources,
      gpuDiagnosticsStressWorkspace: staleWorkspace,
      gpuDiagnosticsStressOperationGeneration: 1,
      activeSurface: 'terminal',
      window: {
        getComputedStyle: () => ({
          getPropertyValue: () => '240',
        }),
      },
      document: { documentElement: {} },
    });
    try {
      const globals = globalThis as Record<string, unknown>;
      const restoreGpuDiagnosticsStressWorkspace = compileFunction<
        () => Promise<void>
      >(readWebFile('main.js'), 'restoreGpuDiagnosticsStressWorkspace', {
        findProject: () => staleProject,
        gpuDiagnosticsStressWorkspaceIsUnchanged: () => false,
        discardGpuDiagnosticsStressWorkspace: () => {
          globals.gpuDiagnosticsStressWorkspace = null;
        },
      });
      const beginGpuDiagnosticsStressWorkspace = compileFunction<
        () => { projectId: string; worktreePath: string }
      >(readWebFile('main.js'), 'beginGpuDiagnosticsStressWorkspace', {
        activeProject: () => currentProject,
        activeWorkspaceRoot: () => '/current',
        paneLayoutKey: () => 'project-b:/current',
        paneLayouts: new Map(),
        cloneGpuDiagnosticsLayout: (layout: unknown) => layout,
        state,
        sidebarOpen: () => true,
        findBrowserPane: () => null,
        invalidateGpuDiagnosticsStressOperations: () => 2,
      });

      await restoreGpuDiagnosticsStressWorkspace();

      expect(globals.gpuDiagnosticsStressWorkspace).toBeNull();
      expect(beginGpuDiagnosticsStressWorkspace()).toMatchObject({
        projectId: currentProject.id,
        worktreePath: '/current',
      });
    } finally {
      restoreGlobals();
    }
  });

  it('does not mutate or dereference a workspace after queued layout work is invalidated', () => {
    const workspace = {
      operationGeneration: 1,
      layoutKey: 'project-a:/workspace',
    };
    const calls: string[] = [];
    let queuedLayout: (() => void) | undefined;
    const restoreGlobals = installGpuDiagnosticsGlobals({
      gpuDiagnosticsStressWorkspace: workspace,
      gpuDiagnosticsStressLayoutGeneration: null,
    });
    try {
      const resizeGpuDiagnosticsStressWorkspace = compileFunction<
        (step: number, geometry: { splitRatios: readonly number[]; sidebarWidth: number }) => void
      >(readWebFile('main.js'), 'resizeGpuDiagnosticsStressWorkspace', {
        captureGpuDiagnosticsStressOperation: () => workspace,
        gpuDiagnosticsStressOperationIsCurrent: (
          candidate: unknown,
          generation: number,
        ) => candidate === (globalThis as Record<string, unknown>).gpuDiagnosticsStressWorkspace
          && generation === 1,
        terminalFrameScheduler: {
          schedule(_key: string, callback: () => void) {
            queuedLayout = callback;
          },
        },
        paneLayouts: new Map(),
        applyGpuDiagnosticsStressSplitRatios: () => calls.push('ratios'),
        setSidebarOpen: () => calls.push('sidebar-open'),
        scheduleSidebarWidth: () => calls.push('sidebar-width'),
        renderPaneWorkspace: () => calls.push('workspace'),
        scheduleTerminalPaneFits: () => calls.push('terminal-fits'),
        scheduleBrowserBounds: () => calls.push('browser-bounds'),
      });

      resizeGpuDiagnosticsStressWorkspace(0, {
        splitRatios: [0.5],
        sidebarWidth: 240,
      });
      (globalThis as Record<string, unknown>).gpuDiagnosticsStressWorkspace = null;

      expect(() => queuedLayout?.()).not.toThrow();
      expect(calls).toEqual([]);
    } finally {
      restoreGlobals();
    }
  });

  it('rejects an old-generation focus completion while the next generation still focuses', async () => {
    const oldWorkspace = { operationGeneration: 1 };
    const nextWorkspace = { operationGeneration: 2 };
    const resources = new Map([
      ['terminal', { kind: 'terminal', thread: { id: 'terminal-thread' } }],
    ]);
    const lateFocus = deferred<boolean>();
    let focusCalls = 0;
    let focusOptions: { isCurrent?: () => boolean } | undefined;
    const restoreGlobals = installGpuDiagnosticsGlobals({
      gpuDiagnosticsStressWorkspace: oldWorkspace,
      gpuDiagnosticsStressResources: resources,
    });

    try {
      const focusGpuDiagnosticsStressResource = compileFunction<
        (id: string, signal?: AbortSignal) => Promise<void>
      >(readWebFile('main.js'), 'focusGpuDiagnosticsStressResource', {
        throwIfGpuDiagnosticsStressAborted: () => {},
        captureGpuDiagnosticsStressOperation: () => (
          (globalThis as Record<string, unknown>).gpuDiagnosticsStressWorkspace
        ),
        assertGpuDiagnosticsStressOperationCurrent: (
          workspace: unknown,
          _signal?: AbortSignal,
        ) => {
          if (workspace !== (globalThis as Record<string, unknown>).gpuDiagnosticsStressWorkspace) {
            throw new Error('diagnostics stress operation was invalidated');
          }
        },
        gpuDiagnosticsStressOperationIsCurrent: (workspace: unknown) => (
          workspace === (globalThis as Record<string, unknown>).gpuDiagnosticsStressWorkspace
        ),
        focusThread: async (_id: string, options?: { isCurrent?: () => boolean }) => {
          focusCalls += 1;
          focusOptions = options;
          return focusCalls === 1 ? lateFocus.promise : true;
        },
      });

      const staleFocus = focusGpuDiagnosticsStressResource('terminal');
      (globalThis as Record<string, unknown>).gpuDiagnosticsStressWorkspace = nextWorkspace;
      expect(focusOptions?.isCurrent?.()).toBe(false);
      lateFocus.resolve(true);

      await expect(staleFocus).rejects.toThrow('diagnostics stress operation was invalidated');
      await expect(focusGpuDiagnosticsStressResource('terminal')).resolves.toBeUndefined();
      expect(focusCalls).toBe(2);
    } finally {
      restoreGlobals();
    }
  });

  it('does not let a late old-generation invalidation change a new diagnostics workspace', () => {
    const oldWorkspace = { operationGeneration: 1 };
    const nextWorkspace = { operationGeneration: 2 };
    const globals = globalThis as Record<string, unknown>;
    const restoreGlobals = installGpuDiagnosticsGlobals({
      gpuDiagnosticsStressWorkspace: oldWorkspace,
      gpuDiagnosticsStressOperationGeneration: 1,
    });
    try {
      const createGpuDiagnosticsStressAdapterHost = compileFunction<
        () => {
          captureLateOperationGeneration(): number | null;
          invalidateLateOperation(operation: 'window', generation: number | null): void;
        }
      >(readWebFile('main.js'), 'createGpuDiagnosticsStressAdapterHost', {
        createGpuDiagnosticsStressTerminal: async () => ({}),
        createGpuDiagnosticsStressEditor: async () => ({}),
        createGpuDiagnosticsStressBrowser: async () => ({}),
        focusGpuDiagnosticsStressResource: async () => {},
        resizeGpuDiagnosticsStressWorkspace: () => {},
        setGpuDiagnosticsStressResourceVisibility: async () => {},
        loseGpuDiagnosticsStressGraphicsContext: async () => false,
        restoreGpuDiagnosticsStressGraphicsContext: async () => {},
        gpuDiagnosticsStressOperationIsCurrent: (
          workspace: { operationGeneration: number } | null,
          generation: number,
        ) => workspace === globals.gpuDiagnosticsStressWorkspace
          && generation === globals.gpuDiagnosticsStressOperationGeneration,
        invalidateGpuDiagnosticsStressOperations: () => {
          globals.gpuDiagnosticsStressOperationGeneration = (
            globals.gpuDiagnosticsStressOperationGeneration as number
          ) + 1;
        },
      });
      const host = createGpuDiagnosticsStressAdapterHost();
      const oldGeneration = host.captureLateOperationGeneration();

      globals.gpuDiagnosticsStressWorkspace = nextWorkspace;
      globals.gpuDiagnosticsStressOperationGeneration = 2;
      host.invalidateLateOperation('window', oldGeneration);

      expect(globals.gpuDiagnosticsStressOperationGeneration).toBe(2);
      expect(globals.gpuDiagnosticsStressWorkspace).toBe(nextWorkspace);
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
