import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createTauriStressHarness,
  type TauriStressRuntimeHost,
} from '../native/desktop/psyche-build-tauri/web/runtime/stress-runtime-adapter';
import type {
  StressResource,
} from '../native/desktop/psyche-build-tauri/web/runtime/stress-harness';
import type {
  RuntimePerformanceSnapshot,
} from '../native/desktop/psyche-build-tauri/web/runtime/performance-metrics';

const root = process.cwd();
const main = readFileSync(
  join(root, 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
);

function functionSource(name: string) {
  const asyncStart = main.indexOf(`async function ${name}(`);
  const syncStart = main.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = main.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < main.length; index += 1) {
    if (main[index] === '{') depth += 1;
    if (main[index] === '}') depth -= 1;
    if (depth === 0) return main.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>,
) {
  return Function(
    ...Object.keys(dependencies),
    `"use strict"; return (${source});`,
  )(...Object.values(dependencies)) as T;
}

type BrowserTitleEvent = {
  payload: {
    label: string;
    url: string;
    title: string;
    generation: number;
    navigationToken: string;
  };
};

function diagnosticsBrowserTitleHarness(
  url: string,
  diagnosticsFixture: boolean,
  activeFixture = true,
) {
  const tab = {
    id: 'tab-1',
    url,
    title: 'Original title',
    created: true,
    diagnosticsFixture,
  };
  const browser = { activeTabId: tab.id, tabs: [tab] };
  const project = {
    id: 'project-1',
    browsersByWorktree: { '/workspace': browser },
  };
  const pane = {
    id: 'browser-pane',
    projectId: project.id,
    worktreePath: '/workspace',
  };
  const lifecycle = {
    generation: 1,
    pendingGeneration: 0,
    liveGeneration: 1,
    liveUrl: url,
    liveNavigationToken: 'fixture-token',
    eventUrl: url,
    nativeLabel: 'browser-label',
    viewLive: true,
    replacementOperation: null,
  };
  const browserUrlsMatch = compileFunction<
    (left: string, right: string) => boolean
  >(functionSource('browserUrlsMatch'), {});
  const browserNativeUrl = compileFunction<
    (value: string) => string | null
  >(functionSource('browserNativeUrl'), {});
  const browserNativeEventContext = compileFunction<
    (label: string, eventUrl: string | null, navigationToken: string) => unknown
  >(functionSource('browserNativeEventContext'), {
    browserTabForNativeLabel: (label: string) => label === 'browser-label'
      ? { project, worktreePath: '/workspace', browser, tab }
      : null,
    findProject: (projectId: string) => projectId === project.id ? project : null,
    browserTabLifecycle: () => lifecycle,
    browserTabIsClosing: () => false,
    findBrowserPane: () => pane,
    findThread: (threadId: string) => threadId === pane.id ? pane : null,
    browserPaneIsClosing: () => false,
    browserUrlsMatch,
  });
  const browserTitleEventContext = compileFunction<
    (payload: BrowserTitleEvent['payload']) => unknown
  >(functionSource('browserTitleEventContext'), {
    activeDiagnosticsBrowserFixture: activeFixture ? { browser, project, tab } : null,
    browserNativeUrl,
    browserNativeEventContext,
    browserTabLifecycle: () => lifecycle,
    browserUrlsMatch,
  });
  const calls: string[] = [];
  const handleBrowserTitle = compileFunction<
    (event: BrowserTitleEvent) => boolean
  >(functionSource('handleBrowserTitle'), {
    browserTitleEventContext,
    state: { activeProjectId: project.id },
    activeWorkspaceRoot: () => '/workspace',
    renderBrowserTabs: () => calls.push('render'),
    saveWorkspaceSoon: () => calls.push('save'),
    publishBrowserControlResource: async () => {
      calls.push('publish');
    },
  });

  return { browser, calls, handleBrowserTitle, project, tab };
}

function abortError(): Error {
  const error = new Error('stress run cancelled');
  error.name = 'AbortError';
  return error;
}

function abortableWait(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError());
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(signal.reason ?? abortError()),
      { once: true },
    );
  });
}

function createFrameDriver() {
  let nextHandle = 1;
  const callbacks = new Map<number, (timestamp: number) => void>();
  return {
    request(callback: (timestamp: number) => void) {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle: number) {
      callbacks.delete(handle);
    },
    flush(timestamp: number) {
      const entries = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of entries) callback(timestamp);
    },
    pending() {
      return callbacks.size;
    },
  };
}

function resource(id: string, disposed: string[]): StressResource {
  return {
    id,
    async dispose() {
      disposed.push(id);
    },
  };
}

type FocusState = {
  returnThreadId?: string | null;
};

type FilesPaneState = {
  previousFocusedSessionId?: string | null;
};

type ProjectState = {
  id: string;
  lastActiveThreadId?: string | null;
};

async function createProductionRunScopeFixture(
  fileFocus: FocusState,
  filesPane: FilesPaneState,
  project: ProjectState = { id: 'project-1' },
) {
  const workspaceRoot = '/workspace';
  const layoutKey = `${project.id}\0${workspaceRoot}`;
  const paneLayouts = new Map([[layoutKey, { root: {} }]]);
  const filesPanes = new Map([[layoutKey, filesPane]]);
  const state = {
    activeThreadId: 'terminal-before',
    activeFileId: null as string | null,
  };
  const styleValues = new Map([['--sidebar-w', '320px']]);
  const prepareRun = compileFunction<() => Promise<StressResource>>(
    functionSource('prepareDiagnosticsStressRun'),
    {
      diagnosticsStressContext: null,
      activeDiagnosticsBrowserFixture: null,
      activeProject: () => project,
      activeWorkspaceRoot: () => workspaceRoot,
      showTerminalView: async () => true,
      paneLayoutKey: () => layoutKey,
      paneLayouts,
      filesPaneKey: () => layoutKey,
      filesPanes,
      fileFocus,
      state,
      document: {
        documentElement: {
          style: {
            getPropertyValue: (name: string) => styleValues.get(name) ?? '',
            setProperty: (name: string, value: string) => styleValues.set(name, value),
            removeProperty: (name: string) => styleValues.delete(name),
          },
        },
      },
      renderPaneWorkspace: () => undefined,
      findOpenFile: () => null,
      findThread: () => null,
      activateFileTabNow: () => true,
      restoreFileEditorFocus: () => undefined,
      focusThread: async () => true,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      scheduleTerminalPaneFits: () => undefined,
      scheduleBrowserBounds: () => undefined,
      saveWorkspaceSoon: () => undefined,
    },
  );
  return {
    prepareRun,
    fileFocus,
    filesPane,
    project,
  };
}

function createHost(overrides: Partial<TauriStressRuntimeHost> = {}) {
  const disposed: string[] = [];
  const commands: string[] = [];
  const clearedIntervals: unknown[] = [];
  const frames = createFrameDriver();
  let now = 0;
  let terminalCount = 0;
  let editorCount = 0;
  let browserCount = 0;
  const host: TauriStressRuntimeHost = {
    authorized: true,
    async prepareRun() {
      return resource('run-scope', disposed);
    },
    async createTerminal() {
      const id = `terminal-${terminalCount}`;
      terminalCount += 1;
      return resource(id, disposed);
    },
    async createEditor() {
      const id = `editor-${editorCount}`;
      editorCount += 1;
      return resource(id, disposed);
    },
    async createBrowser() {
      const id = `browser-${browserCount}`;
      browserCount += 1;
      return resource(id, disposed);
    },
    async focus() {},
    resize() {},
    async setVisible() {},
    async loseGraphicsContext() {
      return true;
    },
    async invoke(command) {
      commands.push(command);
      if (command === 'pty_transport_metrics') return [];
      if (command === 'runtime_process_metrics') return {};
      return undefined;
    },
    schedulerSnapshot() {
      return { pendingCallbacks: 0, coalescedVisualUpdates: 0 };
    },
    rendererSnapshots() {
      return [];
    },
    async sleep(ms, signal) {
      if (signal.aborted) throw signal.reason ?? abortError();
      now += ms;
      frames.flush(now);
    },
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
    now: () => now,
    setInterval() {
      return Symbol('metrics-interval');
    },
    clearInterval(handle) {
      clearedIntervals.push(handle);
    },
    onProgress() {},
    ...overrides,
  };
  return {
    host,
    disposed,
    commands,
    clearedIntervals,
    frames,
    get now() {
      return now;
    },
    set now(value: number) {
      now = value;
    },
  };
}

describe('Tauri stress runtime adapter', () => {
  it('runs the fixed plan through production host operations and releases its run scope', async () => {
    const state = createHost();
    const harness = createTauriStressHarness(state.host);

    expect(harness.running()).toBe(false);
    const result = await harness.run();

    expect(result.scenarios.map((scenario) => scenario.paneCount)).toEqual([1, 6, 12, 24]);
    expect(state.commands.filter((command) => command === 'diagnostics_cycle_window'))
      .toHaveLength(4);
    expect(state.disposed).toHaveLength(52);
    expect(state.disposed.at(-1)).toBe('run-scope');
    expect(state.clearedIntervals).toHaveLength(1);
    expect(state.frames.pending()).toBe(0);
    expect(harness.running()).toBe(false);
  });

  it('reports accepted stress metric snapshots as collection recovery boundaries', async () => {
    const reportSuccess = vi.fn();
    const state = createHost({ reportSuccess });

    await createTauriStressHarness(state.host).run();

    expect(reportSuccess).toHaveBeenCalledWith('stress metrics snapshot');
  });

  it('records completed production focus and resize input-to-next-paint samples', async () => {
    const state = createHost();

    const result = await createTauriStressHarness(state.host).run();

    for (const scenario of result.scenarios) {
      const interactions =
        (scenario.metrics.afterMeasurement as RuntimePerformanceSnapshot).interactions;
      expect(interactions.focusToNextPaintMs).toBeGreaterThan(0);
      expect(interactions.resizeToNextPaintMs).toBeGreaterThan(0);
      expect(interactions.focusToNextPaintMs).toBe(interactions.resizeToNextPaintMs);
    }
    expect(state.frames.pending()).toBe(0);
  });

  it('cancels through the same resource and collector cleanup path', async () => {
    let warmupStarted!: () => void;
    const warmup = new Promise<void>((resolve) => {
      warmupStarted = resolve;
    });
    const state = createHost({
      async sleep(_ms, signal) {
        warmupStarted();
        await abortableWait(signal);
      },
    });
    const harness = createTauriStressHarness(state.host);
    const run = harness.run();
    await warmup;

    expect(harness.cancel()).toBe(true);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.disposed).toEqual([
      'browser-0',
      'editor-0',
      'terminal-0',
      'run-scope',
    ]);
    expect(state.clearedIntervals).toHaveLength(1);
    expect(state.frames.pending()).toBe(0);
  });

  it('rejects cancellation during final-scenario cleanup after disposing every resource', async () => {
    let finalCleanupStarted!: () => void;
    const finalCleanup = new Promise<void>((resolve) => {
      finalCleanupStarted = resolve;
    });
    let releaseFinalCleanup!: () => void;
    const finalCleanupRelease = new Promise<void>((resolve) => {
      releaseFinalCleanup = resolve;
    });
    const state = createHost();
    let browserCount = 0;
    state.host.createBrowser = async () => {
      const id = `browser-${browserCount}`;
      browserCount += 1;
      return {
        id,
        async dispose() {
          if (id === 'browser-3') {
            finalCleanupStarted();
            await finalCleanupRelease;
          }
          state.disposed.push(id);
        },
      };
    };
    const harness = createTauriStressHarness(state.host);
    const run = harness.run();
    await finalCleanup;

    expect(harness.cancel()).toBe(true);
    releaseFinalCleanup();

    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.disposed).toHaveLength(52);
    expect(state.disposed.at(-1)).toBe('run-scope');
    expect(state.clearedIntervals).toHaveLength(1);
    expect(state.frames.pending()).toBe(0);
    expect(harness.running()).toBe(false);
  });

  it('cleans adapter and scenario resources after a production operation fails', async () => {
    const state = createHost({
      resize() {
        throw new Error('layout failed');
      },
    });
    const harness = createTauriStressHarness(state.host);

    await expect(harness.run()).rejects.toThrow('layout failed');
    expect(state.disposed).toEqual([
      'browser-0',
      'editor-0',
      'terminal-0',
      'run-scope',
    ]);
    expect(state.clearedIntervals).toHaveLength(1);
    expect(state.frames.pending()).toBe(0);
  });

  it('restores pre-existing production focus state after a successful run', async () => {
    const production = await createProductionRunScopeFixture(
      { returnThreadId: 'terminal-before' },
      { previousFocusedSessionId: 'terminal-before' },
      { id: 'project-1', lastActiveThreadId: 'terminal-before' },
    );
    const state = createHost();
    state.host.prepareRun = production.prepareRun;
    state.host.createEditor = async () => {
      production.fileFocus.returnThreadId = 'diagnostics-terminal';
      production.filesPane.previousFocusedSessionId = 'diagnostics-terminal';
      production.project.lastActiveThreadId = 'diagnostics-terminal';
      return resource('editor', state.disposed);
    };

    await createTauriStressHarness(state.host).run();

    expect(production.fileFocus.returnThreadId).toBe('terminal-before');
    expect(production.filesPane.previousFocusedSessionId).toBe('terminal-before');
    expect(production.project.lastActiveThreadId).toBe('terminal-before');
  });

  it('restores absent production focus properties after a failed run', async () => {
    const production = await createProductionRunScopeFixture({}, {});
    const state = createHost({
      resize() {
        throw new Error('layout failed');
      },
    });
    state.host.prepareRun = production.prepareRun;
    state.host.createEditor = async () => {
      production.fileFocus.returnThreadId = 'diagnostics-terminal';
      production.filesPane.previousFocusedSessionId = 'diagnostics-terminal';
      production.project.lastActiveThreadId = 'diagnostics-terminal';
      return resource('editor', state.disposed);
    };

    await expect(createTauriStressHarness(state.host).run())
      .rejects.toThrow('layout failed');

    expect(Object.hasOwn(production.fileFocus, 'returnThreadId')).toBe(false);
    expect(Object.hasOwn(production.filesPane, 'previousFocusedSessionId')).toBe(false);
    expect(Object.hasOwn(production.project, 'lastActiveThreadId')).toBe(false);
  });

  it('restores explicitly undefined production focus state after cancellation', async () => {
    let warmupStarted!: () => void;
    const warmup = new Promise<void>((resolve) => {
      warmupStarted = resolve;
    });
    const production = await createProductionRunScopeFixture(
      { returnThreadId: undefined },
      { previousFocusedSessionId: undefined },
      { id: 'project-1', lastActiveThreadId: undefined },
    );
    const state = createHost({
      async sleep(_ms, signal) {
        warmupStarted();
        await abortableWait(signal);
      },
    });
    state.host.prepareRun = production.prepareRun;
    state.host.createEditor = async () => {
      production.fileFocus.returnThreadId = 'diagnostics-terminal';
      production.filesPane.previousFocusedSessionId = 'diagnostics-terminal';
      production.project.lastActiveThreadId = 'diagnostics-terminal';
      return resource('editor', state.disposed);
    };
    const harness = createTauriStressHarness(state.host);
    const run = harness.run();
    await warmup;

    expect(harness.cancel()).toBe(true);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(Object.hasOwn(production.fileFocus, 'returnThreadId')).toBe(true);
    expect(production.fileFocus.returnThreadId).toBeUndefined();
    expect(Object.hasOwn(production.filesPane, 'previousFocusedSessionId')).toBe(true);
    expect(production.filesPane.previousFocusedSessionId).toBeUndefined();
    expect(Object.hasOwn(production.project, 'lastActiveThreadId')).toBe(true);
    expect(production.project.lastActiveThreadId).toBeUndefined();
  });

  it('rejects authorization before preparing or allocating runtime resources', async () => {
    let prepareCalls = 0;
    const state = createHost({
      authorized: false,
      async prepareRun() {
        prepareCalls += 1;
        return resource('run-scope', []);
      },
    });

    await expect(createTauriStressHarness(state.host).run())
      .rejects.toThrow('render diagnostics are not authorized');
    expect(prepareCalls).toBe(0);
    expect(state.clearedIntervals).toHaveLength(0);
  });

  it('exports and installs the adapter with real desktop pane, native, editor, and browser paths', () => {
    const runtimeEntry = readFileSync(
      join(root, 'native/desktop/psyche-build-tauri/web/runtime/runtime-entry.ts'),
      'utf8',
    );

    expect(runtimeEntry).toContain(
      "export { createTauriStressHarness } from './stress-runtime-adapter';",
    );
    expect(main).toContain('async function installRuntimeStressHarness()');
    expect(main).toContain('var report = await invoke("runtime_diagnostics");');
    expect(main).toContain(
      'if (!report || report.debugBuild !== true || report.stressAuthorized !== true) return null;',
    );
    expect(main).toContain('ptyRuntime.createTauriStressHarness({');
    expect(main).toContain('prepareRun: prepareDiagnosticsStressRun');
    expect(main).toContain('createTerminal: createDiagnosticsTerminalFixture');
    expect(main).toContain('createEditor: createDiagnosticsEditorFixture');
    expect(main).toContain('createBrowser: createDiagnosticsBrowserFixture');
    expect(main).toContain('beginGraphicsDiagnosticsInteraction("focus")');
    expect(main).toContain('completeGraphicsDiagnosticsInteraction("focus"');
    expect(main).toContain('beginGraphicsDiagnosticsInteraction("resize")');
    expect(main).toContain('completeGraphicsDiagnosticsInteraction("resize"');
    expect(main).toContain('resize: applyDiagnosticsStressGeometry');
    expect(main).toContain('setVisible: setDiagnosticsStressSurfaceVisible');
    expect(main).toContain('loseGraphicsContext: loseDiagnosticsBrowserContext');
    expect(main).toContain('invoke("diagnostics_spawn_fixture"');
    expect(main).toContain('invoke("browser_eval"');
    expect(main.match(/requirePtyStop: true/g)).toHaveLength(2);
    expect(main).toMatch(
      /var pane = null;\s*var tab = null;\s*try \{\s*pane = await createBrowserPane/,
    );
    expect(main).not.toContain('!existingPane && browser.tabs.length === 0');
    expect(main).toContain(
      'window.PsycheRenderStress = graphicsDiagnosticsStressController;',
    );
    expect(main).toContain('await installRuntimeStressHarness();');
    expect(main).toContain('function runGraphicsDiagnosticsStressScenario()');
    expect(main).toContain('graphicsDiagnosticsStressController.run()');
    expect(main).toContain('function cancelGraphicsDiagnosticsStressScenario()');
    expect(main).toContain('graphicsDiagnosticsStressController.cancel()');
    expect(main).toContain(
      'graphicsDiagnosticsScenarioEl.hidden = report.stressAuthorized !== true;',
    );
    expect(main).toContain(
      'graphicsDiagnosticsScenarioEl.inert = report.stressAuthorized !== true;',
    );
    expect(main).toContain('updateGraphicsDiagnosticsStressProgress(progress);');
    expect(main).toContain(
      'window.dispatchEvent(new CustomEvent("psyche:render-stress-progress"',
    );
  });

  it('accepts packaged fixture context loss through the browser title event path', async () => {
    const diagnosticsBrowserFixtureUrl = compileFunction<
      (page: { url: string }) => string
    >(functionSource('diagnosticsBrowserFixtureUrl'), {
      window: {
        location: {
          href: 'tauri://localhost/index.html',
        },
      },
    });
    const page = {
      url: 'diagnostics-fixture.html?paneCount=12',
      title: 'Psyche render diagnostics · 12 panes',
    };
    expect(diagnosticsBrowserFixtureUrl(page)).toBe(
      'tauri://localhost/diagnostics-fixture.html?paneCount=12',
    );

    const fixtureUrl = diagnosticsBrowserFixtureUrl(page);
    const titleHarness = diagnosticsBrowserTitleHarness(fixtureUrl, true);
    titleHarness.tab.title = page.title;
    const fixture = {
      project: titleHarness.project,
      browser: titleHarness.browser,
      tab: titleHarness.tab,
      page,
    };
    const calls: Array<[string, Record<string, unknown>]> = [];
    const loseDiagnosticsBrowserContext = compileFunction<() => Promise<boolean>>(
      functionSource('loseDiagnosticsBrowserContext'),
      {
        activeDiagnosticsBrowserFixture: fixture,
        browserLabelForTab: () => 'browser-label',
        invoke: async (command: string, args: Record<string, unknown>) => {
          calls.push([command, args]);
          expect(titleHarness.handleBrowserTitle({
            payload: {
              label: 'browser-label',
              url: fixtureUrl,
              title: `  ${page.title} · context-lost  `,
              generation: 1,
              navigationToken: 'fixture-token',
            },
          })).toBe(true);
        },
        setTimeout,
      },
    );

    await expect(loseDiagnosticsBrowserContext()).resolves.toBe(true);
    expect(calls).toEqual([
      [
        'browser_eval',
        {
          label: 'browser-label',
          script: 'window.losePsycheDiagnosticsContext && window.losePsycheDiagnosticsContext();',
        },
      ],
    ]);
    expect(titleHarness.tab.title).toBe(`${page.title} · context-lost`);
    expect(titleHarness.calls).toEqual(['render', 'save', 'publish']);
    const createBrowserSource = functionSource('createDiagnosticsBrowserFixture');
    expect(createBrowserSource).toContain('diagnosticsBrowserFixtureUrl(page)');
    expect(createBrowserSource).not.toContain('document.write');
  });

  it.each([
    ['an unmarked browser tab', 'tauri://localhost/diagnostics-fixture.html?paneCount=12', false, true],
    ['an inactive diagnostics tab', 'tauri://localhost/diagnostics-fixture.html?paneCount=12', true, false],
    ['an unrelated local path', 'tauri://localhost/index.html', true, true],
    ['an unrelated local origin', 'tauri://localhost:1420/diagnostics-fixture.html?paneCount=12', true, true],
    ['an unrelated Tauri host', 'tauri://untrusted.invalid/diagnostics-fixture.html?paneCount=12', true, true],
  ])('rejects packaged title events from %s', (_case, url, diagnosticsFixture, activeFixture) => {
    const harness = diagnosticsBrowserTitleHarness(url, diagnosticsFixture, activeFixture);

    expect(harness.handleBrowserTitle({
      payload: {
        label: 'browser-label',
        url,
        title: 'Rejected title',
        generation: 1,
        navigationToken: 'fixture-token',
      },
    })).toBe(false);
    expect(harness.tab.title).toBe('Original title');
    expect(harness.calls).toEqual([]);
  });
});
