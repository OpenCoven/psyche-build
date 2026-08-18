import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const mainJs = readFileSync(
  join(process.cwd(), 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
);
const PsychePanes = await import(pathToFileURL(join(
  process.cwd(),
  'native/desktop/psyche-build-tauri/web/panes/pane-tree.mjs',
)).href);

function functionSource(source: string, name: string) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const syncStart = source.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  if (bodyStart === -1) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>,
) {
  const resolvedDependencies = { saveWorkspaceSoon: () => undefined, ...dependencies };
  const names = Object.keys(resolvedDependencies);
  const values = Object.values(resolvedDependencies);
  return Function(...names, `"use strict"; return (${source});`)(...values) as T;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function compilePaneFocusDependencies(
  state: { threads: Array<{ id: string; projectId: string; worktreePath: string }> },
) {
  const paneLayoutKey = compileFunction<(projectId: string, worktreePath: string) => string>(
    functionSource(mainJs, 'paneLayoutKey'),
    {},
  );
  const paneLayouts = new Map<string, { root: unknown; focusedLeafId: string | null }>();
  state.threads.forEach((thread) => {
    const key = paneLayoutKey(thread.projectId, thread.worktreePath);
    const leaf = PsychePanes.createLeaf(`leaf-${thread.id}`, thread.id);
    const layout = paneLayouts.get(key);
    if (!layout) {
      paneLayouts.set(key, { root: leaf, focusedLeafId: leaf.id });
      return;
    }
    layout.root = PsychePanes.insertBelow(
      layout.root,
      layout.focusedLeafId!,
      leaf,
      `split-${thread.id}`,
    );
  });
  const paneLayoutFor = compileFunction<
    (projectId: string, worktreePath: string) => { root: unknown } | null
  >(functionSource(mainJs, 'paneLayoutFor'), { paneLayouts, paneLayoutKey });
  const paneLayoutForThread = compileFunction<
    (surface: { projectId: string; worktreePath: string } | null) => { root: unknown } | null
  >(functionSource(mainJs, 'paneLayoutForThread'), { paneLayoutFor });
  const findThread = (id: string) => state.threads.find((thread) => thread.id === id) ?? null;
  const findFilesPaneBySurfaceId = compileFunction<(id: string) => null>(
    functionSource(mainJs, 'findFilesPaneBySurfaceId'),
    { filesPanes: new Map() },
  );
  const canvasSurfaceById = compileFunction<(id: string) => unknown>(
    functionSource(mainJs, 'canvasSurfaceById'),
    { findThread, findFilesPaneBySurfaceId },
  );
  const findFocusSet = compileFunction<(id: string) => null>(
    functionSource(mainJs, 'findFocusSet'),
    { focusSets: [] },
  );
  const scopedPaneRoot = compileFunction<(layout: { root: unknown }) => unknown>(
    functionSource(mainJs, 'scopedPaneRoot'),
    { findFocusSet, canvasSurfaceById, PsychePanes },
  );
  const paneFocusEligible = compileFunction<
    (layout: { root: unknown } | null, threadId: string) => boolean
  >(functionSource(mainJs, 'paneFocusEligible'), { scopedPaneRoot, PsychePanes });
  const browserPaneLifecycle = compileFunction<
    (thread: object | null) => { tearingDown: boolean }
  >(functionSource(mainJs, 'browserPaneLifecycle'), {
    browserPaneLifecycleStates: new WeakMap(),
  });
  const browserPaneIsClosing = compileFunction<(thread: object | null) => boolean>(
    functionSource(mainJs, 'browserPaneIsClosing'),
    { browserPaneLifecycle },
  );
  const paneSurfaceFocusEligible = compileFunction<
    (layout: { root: unknown } | null, surface: object | null) => boolean
  >(functionSource(mainJs, 'paneSurfaceFocusEligible'), {
    browserPaneIsClosing,
    paneFocusEligible,
  });
  return {
    paneLayoutFor,
    paneLayoutForThread,
    paneFocusEligible,
    paneSurfaceFocusEligible,
    PsychePanes,
  };
}

function focusDependencies(
  state: { activeThreadId: string | null; activeProjectId: string | null; threads: any[] },
  showTerminalView: () => Promise<boolean>,
  requestAnimationFrame: (callback: () => void) => number,
) {
  return {
    findThread: (id: string) => state.threads.find((thread) => thread.id === id) ?? null,
    isDormantThread: (thread: { status?: string }) => thread.status === 'exited',
    showTerminalView,
    focusedTerminalThreadForRender: () => null,
    withTerminalFocusReportToken: (
      _thread: unknown,
      _report: string,
      _policy: string,
      action: () => unknown,
    ) => action(),
    markActiveSurface: vi.fn(),
    state,
    findProject: () => ({ id: 'project-1' }),
    activeWorkspaceRoot: () => '/repo',
    ...compilePaneFocusDependencies(state),
    renderPaneWorkspace: vi.fn(),
    renderGitSurface: vi.fn(),
    refreshSidebar: vi.fn(),
    requestAnimationFrame,
    isLiveThread: (thread: unknown) => state.threads.includes(thread),
    terminalHost: { hidden: false, contains: () => true },
    scheduleTerminalPaneFits: vi.fn(),
    scheduleBrowserBounds: vi.fn(),
    setProjectStatus: vi.fn(),
    statusLevel: () => 'ok',
    refreshStatusController: vi.fn(),
  };
}

describe('Tauri thread focus activation', () => {
  it('returns false without selecting a thread that becomes stale during file navigation', async () => {
    const thread = {
      id: 'thread-1',
      projectId: 'project-1',
      worktreePath: '/repo',
      kind: 'shell',
      status: 'running',
      hidden: false,
      closing: false,
      closeStarted: false,
      pane: {},
      terminalController: { focus: vi.fn() },
    };
    const state = {
      activeThreadId: 'thread-existing',
      activeProjectId: 'project-1',
      threads: [thread],
    };
    const navigation = deferred<boolean>();
    const frames: Array<() => void> = [];
    const dependencies = focusDependencies(
      state,
      () => navigation.promise,
      (callback) => { frames.push(callback); return frames.length; },
    );
    const focusThread = compileFunction<
      (id: string, options?: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'focusThread'), dependencies);

    const activation = focusThread(thread.id);
    thread.status = 'exited';
    state.threads = [];
    navigation.resolve(true);

    await expect(activation).resolves.toBe(false);
    expect(state.activeThreadId).toBe('thread-existing');
    expect(dependencies.markActiveSurface).not.toHaveBeenCalled();
    expect(dependencies.renderPaneWorkspace).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
    expect(thread.terminalController.focus).not.toHaveBeenCalled();
  });

  it('can render and select a live thread without queueing terminal autofocus', async () => {
    const thread = {
      id: 'thread-1',
      projectId: 'project-1',
      worktreePath: '/repo',
      kind: 'shell',
      status: 'running',
      hidden: false,
      closing: false,
      closeStarted: false,
      pane: {},
      terminalController: { focus: vi.fn() },
    };
    const state = {
      activeThreadId: null,
      activeProjectId: 'project-1',
      threads: [thread],
    };
    const frames: Array<() => void> = [];
    const dependencies = focusDependencies(
      state,
      async () => true,
      (callback) => { frames.push(callback); return frames.length; },
    );
    const focusThread = compileFunction<
      (id: string, options?: { focusTerminal?: boolean }) => Promise<boolean>
    >(functionSource(mainJs, 'focusThread'), dependencies);

    await expect(focusThread(thread.id, { focusTerminal: false })).resolves.toBe(true);
    expect(state.activeThreadId).toBe(thread.id);
    expect(dependencies.renderPaneWorkspace).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);

    frames.shift()!();
    expect(thread.terminalController.focus).not.toHaveBeenCalled();
    expect(dependencies.scheduleTerminalPaneFits).toHaveBeenCalledTimes(1);
    expect(dependencies.scheduleBrowserBounds).toHaveBeenCalledTimes(1);
  });

  it.each(['exited', 'failed'])(
    'can reveal retained output from a visible %s pane',
    async (status) => {
      const thread = {
        id: 'thread-1',
        projectId: 'project-1',
        worktreePath: '/repo',
        kind: 'shell',
        status,
        hidden: false,
        closing: false,
        closeStarted: false,
        pane: {},
        terminalController: { focus: vi.fn() },
      };
      const state = {
        activeThreadId: null,
        activeProjectId: 'project-1',
        threads: [thread],
      };
      const frames: Array<() => void> = [];
      const dependencies = focusDependencies(
        state,
        async () => true,
        (callback) => { frames.push(callback); return frames.length; },
      );
      const focusThread = compileFunction<(id: string) => Promise<boolean>>(
        functionSource(mainJs, 'focusThread'),
        dependencies,
      );

      await expect(focusThread(thread.id)).resolves.toBe(true);
      expect(state.activeThreadId).toBe(thread.id);
      expect(dependencies.renderPaneWorkspace).toHaveBeenCalledTimes(1);
      expect(frames).toHaveLength(1);
    },
  );

  it('retains terminal autofocus by default for live threads', async () => {
    const thread = {
      id: 'thread-1',
      projectId: 'project-1',
      worktreePath: '/repo',
      kind: 'shell',
      status: 'running',
      hidden: false,
      closing: false,
      closeStarted: false,
      pane: {},
      terminalController: { focus: vi.fn() },
    };
    const state = {
      activeThreadId: null,
      activeProjectId: 'project-1',
      threads: [thread],
    };
    const frames: Array<() => void> = [];
    const dependencies = focusDependencies(
      state,
      async () => true,
      (callback) => { frames.push(callback); return frames.length; },
    );
    const focusThread = compileFunction<(id: string) => Promise<boolean>>(
      functionSource(mainJs, 'focusThread'),
      dependencies,
    );

    await expect(focusThread(thread.id)).resolves.toBe(true);
    frames.shift()!();
    expect(thread.terminalController.focus).toHaveBeenCalledTimes(1);
  });
});
