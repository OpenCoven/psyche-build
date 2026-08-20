import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createTauriStressHarness,
  type TauriStressRuntimeHost,
} from '../native/desktop/psyche-build-tauri/web/runtime/stress-runtime-adapter';
import type {
  StressResource,
} from '../native/desktop/psyche-build-tauri/web/runtime/stress-harness';

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

async function createProductionRunScopeFixture(
  fileFocus: FocusState,
  filesPane: FilesPaneState,
) {
  const project = { id: 'project-1' };
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

  it('restores pre-existing production editor focus state after a successful run', async () => {
    const production = await createProductionRunScopeFixture(
      { returnThreadId: 'terminal-before' },
      { previousFocusedSessionId: 'terminal-before' },
    );
    const state = createHost();
    state.host.prepareRun = production.prepareRun;
    state.host.createEditor = async () => {
      production.fileFocus.returnThreadId = 'diagnostics-terminal';
      production.filesPane.previousFocusedSessionId = 'diagnostics-terminal';
      return resource('editor', state.disposed);
    };

    await createTauriStressHarness(state.host).run();

    expect(production.fileFocus.returnThreadId).toBe('terminal-before');
    expect(production.filesPane.previousFocusedSessionId).toBe('terminal-before');
  });

  it('restores absent production editor focus properties after a failed run', async () => {
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
      return resource('editor', state.disposed);
    };

    await expect(createTauriStressHarness(state.host).run())
      .rejects.toThrow('layout failed');

    expect(Object.hasOwn(production.fileFocus, 'returnThreadId')).toBe(false);
    expect(Object.hasOwn(production.filesPane, 'previousFocusedSessionId')).toBe(false);
  });

  it('restores explicitly undefined production editor focus state after cancellation', async () => {
    let warmupStarted!: () => void;
    const warmup = new Promise<void>((resolve) => {
      warmupStarted = resolve;
    });
    const production = await createProductionRunScopeFixture(
      { returnThreadId: undefined },
      { previousFocusedSessionId: undefined },
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
    expect(main).toContain('window.PsycheRenderStress = runtimeStressHarness;');
    expect(main).toContain('await installRuntimeStressHarness();');
  });
});
