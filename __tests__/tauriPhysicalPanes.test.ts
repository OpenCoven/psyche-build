import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const mainJs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);
const stylesCss = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/styles.css'),
  'utf8',
);
const PsychePanes = await import(pathToFileURL(join(
  repoRoot,
  'native/macos/psyche-build-tauri/web/panes/pane-tree.mjs',
)).href);

function functionSource(name: string) {
  const asyncStart = mainJs.indexOf(`async function ${name}(`);
  const syncStart = mainJs.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = mainJs.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainJs.length; index += 1) {
    if (mainJs[index] === '{') depth += 1;
    if (mainJs[index] === '}') depth -= 1;
    if (depth === 0) return mainJs.slice(start, index + 1);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeEventTarget {
  className = '';
  dataset: Record<string, string> = {};
  tabIndex = -1;
  parentElement: { getBoundingClientRect: () => Record<string, number> } | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  focusCalls = 0;

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  addEventListener(name: string, listener: (event: Record<string, unknown>) => void) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: (event: Record<string, unknown>) => void) {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name: string, event: Record<string, unknown>) {
    this.listeners.get(name)?.forEach((listener) => listener(event));
  }

  focus() {
    this.focusCalls += 1;
  }
}

describe('Tauri physical terminal panes', () => {
  it('makes pane dividers accessible and resizable by pointer and keyboard', () => {
    const windowTarget = new FakeEventTarget();
    const divider = new FakeEventTarget();
    const layout = { root: {} };
    const updates: Array<[string, number]> = [];
    const createPaneDivider = compileFunction<(
      node: { id: string }, ratio: number,
    ) => FakeEventTarget>(functionSource('createPaneDivider'), {
      document: { createElement: () => divider },
      window: windowTarget,
      activePaneLayout: () => layout,
      updateActiveSplit: (splitId: string, ratio: number) => updates.push([splitId, ratio]),
    });

    createPaneDivider({ id: 'split-a' }, 0.42);
    expect(divider.className).toBe('terminal-pane-divider');
    expect(divider.dataset.splitId).toBe('split-a');
    expect(divider.tabIndex).toBe(0);
    expect(Object.fromEntries(divider.attributes)).toMatchObject({
      role: 'separator',
      'aria-orientation': 'horizontal',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '42',
    });

    divider.parentElement = {
      getBoundingClientRect: () => ({ top: 100, height: 200 }),
    };
    let prevented = 0;
    divider.dispatch('pointerdown', {
      pointerId: 7, preventDefault: () => { prevented += 1; },
    });
    divider.parentElement = null;
    windowTarget.dispatch('pointermove', { pointerId: 7, clientY: 250 });
    expect(prevented).toBe(1);
    expect(updates).toEqual([['split-a', 0.75]]);
    windowTarget.dispatch('pointercancel', { pointerId: 7 });
    expect(windowTarget.listeners.get('pointermove')?.size).toBe(0);
    expect(windowTarget.listeners.get('pointerup')?.size).toBe(0);
    expect(windowTarget.listeners.get('pointercancel')?.size).toBe(0);

    divider.dispatch('keydown', {
      key: 'ArrowUp', shiftKey: false, preventDefault: () => { prevented += 1; },
    });
    const replacement = new FakeEventTarget();
    const createReplacementDivider = compileFunction<(
      node: { id: string }, ratio: number,
    ) => FakeEventTarget>(functionSource('createPaneDivider'), {
      document: { createElement: () => replacement },
      window: windowTarget,
      activePaneLayout: () => layout,
      updateActiveSplit: (splitId: string, nextRatio: number) => updates.push([splitId, nextRatio]),
    });
    createReplacementDivider({ id: 'split-a' }, 0.38);
    replacement.dispatch('keydown', {
      key: 'ArrowDown', shiftKey: true, preventDefault: () => { prevented += 1; },
    });
    replacement.dispatch('keydown', {
      key: 'Home', shiftKey: false, preventDefault: () => { prevented += 1; },
    });
    expect(updates.slice(1)).toEqual([
      ['split-a', 0.38],
      ['split-a', 0.39],
    ]);
    expect(prevented).toBe(3);
  });

  it('ignores pointer resizing when the split has no measurable height', () => {
    const windowTarget = new FakeEventTarget();
    const divider = new FakeEventTarget();
    const layout = { root: {} };
    const updates: number[] = [];
    divider.parentElement = {
      getBoundingClientRect: () => ({ top: 20, height: 0 }),
    };
    const createPaneDivider = compileFunction<(
      node: { id: string }, ratio: number,
    ) => FakeEventTarget>(functionSource('createPaneDivider'), {
      document: { createElement: () => divider },
      window: windowTarget,
      activePaneLayout: () => layout,
      updateActiveSplit: (_splitId: string, ratio: number) => updates.push(ratio),
    });
    createPaneDivider({ id: 'split-zero' }, 0.5);
    divider.dispatch('pointerdown', { pointerId: 3, preventDefault: () => undefined });
    windowTarget.dispatch('pointermove', { pointerId: 3, clientY: 40 });
    windowTarget.dispatch('pointerup', { pointerId: 3 });
    expect(updates).toEqual([]);
    expect(windowTarget.listeners.get('pointermove')?.size || 0).toBe(0);
  });

  it('ignores stale layouts and unrelated pointers during divider drags', () => {
    const windowTarget = new FakeEventTarget();
    const divider = new FakeEventTarget();
    const originalLayout = { root: {} };
    let currentLayout = originalLayout;
    const updates: number[] = [];
    divider.parentElement = {
      getBoundingClientRect: () => ({ top: 20, height: 100 }),
    };
    const createPaneDivider = compileFunction<(
      node: { id: string }, ratio: number,
    ) => FakeEventTarget>(functionSource('createPaneDivider'), {
      document: { createElement: () => divider },
      window: windowTarget,
      activePaneLayout: () => currentLayout,
      updateActiveSplit: (_splitId: string, ratio: number) => updates.push(ratio),
    });
    createPaneDivider({ id: 'split-stale' }, 0.5);
    divider.dispatch('pointerdown', { pointerId: 11, preventDefault: () => undefined });
    windowTarget.dispatch('pointermove', { pointerId: 12, clientY: 70 });
    expect(updates).toEqual([]);
    expect(windowTarget.listeners.get('pointermove')?.size).toBe(1);

    currentLayout = { root: {} };
    windowTarget.dispatch('pointermove', { pointerId: 11, clientY: 70 });
    expect(updates).toEqual([]);
    expect(windowTarget.listeners.get('pointermove')?.size).toBe(0);
    expect(windowTarget.listeners.get('blur')?.size || 0).toBe(0);

    currentLayout = originalLayout;
    divider.parentElement = {
      getBoundingClientRect: () => ({ top: 20, height: 100 }),
    };
    divider.dispatch('pointerdown', { pointerId: 13, preventDefault: () => undefined });
    windowTarget.dispatch('blur', {});
    expect(windowTarget.listeners.get('pointermove')?.size).toBe(0);

    divider.dispatch('pointerdown', { pointerId: 14, preventDefault: () => undefined });
    windowTarget.dispatch('pointermove', { pointerId: 14, clientY: Number.NaN });
    windowTarget.dispatch('pointermove', { pointerId: 14, clientY: Number.POSITIVE_INFINITY });
    windowTarget.dispatch('pointerup', { pointerId: 14 });
    expect(updates).toEqual([]);
  });

  it('resizes only the active layout without changing its focused leaf', () => {
    const leafA = PsychePanes.createLeaf('leaf-a', 'thread-a');
    const leafB = PsychePanes.createLeaf('leaf-b', 'thread-b');
    const layout = {
      root: PsychePanes.insertBelow(leafA, 'leaf-a', leafB, 'split-a'),
      focusedLeafId: 'leaf-b',
    };
    let renders = 0;
    const otherDivider = new FakeEventTarget();
    otherDivider.dataset.splitId = 'split-other';
    const replacementDivider = new FakeEventTarget();
    replacementDivider.dataset.splitId = 'split-a';
    const focusPaneDivider = compileFunction<(splitId: string) => boolean>(
      functionSource('focusPaneDivider'),
      {
        terminalHost: { querySelectorAll: () => [otherDivider, replacementDivider] },
      },
    );
    const updateActiveSplit = compileFunction<(
      splitId: string, ratio: number, expectedLayout?: typeof layout, restoreFocus?: boolean,
    ) => boolean>(
      functionSource('updateActiveSplit'),
      {
        activePaneLayout: () => layout,
        PsychePanes,
        renderPaneWorkspace: () => { renders += 1; },
        focusPaneDivider,
      },
    );
    expect(updateActiveSplit('split-a', Number.NaN)).toBe(false);
    expect(updateActiveSplit('split-a', Number.POSITIVE_INFINITY)).toBe(false);
    expect(updateActiveSplit('split-a', 0.8, { ...layout })).toBe(false);
    expect(updateActiveSplit('split-a', 0.7, layout, true)).toBe(true);
    expect(layout.root).toMatchObject({ id: 'split-a', ratio: 0.7 });
    expect(layout.focusedLeafId).toBe('leaf-b');
    expect(renders).toBe(1);
    expect(otherDivider.focusCalls).toBe(0);
    expect(replacementDivider.focusCalls).toBe(1);
  });

  it('coalesces visible pane fitting to one animation frame and fits every leaf', () => {
    expect(mainJs).toMatch(/var visiblePaneFitFrame = 0;/);
    expect(mainJs).not.toMatch(/fitActiveTerm/);
    const queued: Array<() => void> = [];
    const terminalHost = { hidden: false };
    let layout: { root: Record<string, unknown> } | null = { root: { type: 'leaf' } };
    const fits: string[] = [];
    const warnings: unknown[][] = [];
    const paneFitFactory = Function(
      'requestAnimationFrame',
      'terminalHost',
      'activePaneLayout',
      'PsychePanes',
      'measuredTerminalHost',
      'PANE_MINIMUMS',
      'findThread',
      'console',
      `"use strict";
       var visiblePaneFitFrame = 0;
       var fitVisiblePanes = ${functionSource('fitVisiblePanes')};
       var scheduleVisiblePaneFit = ${functionSource('scheduleVisiblePaneFit')};
       return { fitVisiblePanes, scheduleVisiblePaneFit };`,
    ) as (
      raf: (callback: () => void) => number,
      host: typeof terminalHost,
      activeLayout: () => typeof layout,
      panes: { layoutRects: () => { leaves: Array<{ threadId: string }> } },
      measure: () => Record<string, number>,
      minimums: Record<string, number>,
      find: (id: string) => { fit: { fit: () => void } },
      logger: { warn: (...args: unknown[]) => void },
    ) => { fitVisiblePanes: () => void; scheduleVisiblePaneFit: () => void };
    const paneFit = paneFitFactory(
      (callback) => { queued.push(callback); return queued.length; },
      terminalHost,
      () => layout,
      {
        layoutRects: () => ({
          leaves: [
            { threadId: 'thread-a' },
            { threadId: 'thread-b' },
            { threadId: 'thread-c' },
          ],
        }),
      },
      () => ({ x: 0, y: 0, width: 800, height: 600 }),
      { width: 320, height: 120, separator: 6 },
      (id: string) => ({
        fit: {
          fit: () => {
            fits.push(id);
            if (id === 'thread-b') throw new Error('fit failed');
          },
        },
      }),
      { warn: (...args: unknown[]) => warnings.push(args) },
    );
    const scheduleVisiblePaneFit = paneFit.scheduleVisiblePaneFit;
    scheduleVisiblePaneFit();
    scheduleVisiblePaneFit();
    expect(queued).toHaveLength(1);
    queued.shift()?.();
    expect(fits).toEqual(['thread-a', 'thread-b', 'thread-c']);
    expect(warnings).toHaveLength(1);

    terminalHost.hidden = true;
    scheduleVisiblePaneFit();
    expect(queued).toHaveLength(1);
    queued.shift()?.();
    expect(fits).toHaveLength(3);

    terminalHost.hidden = false;
    layout = null;
    scheduleVisiblePaneFit();
    expect(queued).toHaveLength(1);
    queued.shift()?.();
    expect(fits).toHaveLength(3);

    layout = { root: { type: 'leaf' } };
    scheduleVisiblePaneFit();
    expect(queued).toHaveLength(1);
    queued.shift()?.();
    expect(fits).toHaveLength(6);
  });

  it('keeps pane topology process-local and keys it by project and worktree', () => {
    expect(mainJs).toMatch(/var paneLayouts = new Map\(\);/);
    expect(mainJs).toMatch(/var paneCounter = 0;/);
    expect(mainJs).toMatch(/var PANE_MINIMUMS = \{ width: 320, height: 120, separator: 6 \};/);
    expect(functionSource('paneLayoutKey')).toMatch(/projectId[\s\S]*worktreePath/);
    expect(functionSource('preparePanePlacement')).toMatch(/PsychePanes\.createLeaf/);
    expect(functionSource('preparePanePlacement')).toMatch(/PsychePanes\.insertBelow/);
    expect(functionSource('preparePanePlacement')).toMatch(/PsychePanes\.canFit/);
    expect(functionSource('detachThreadPane')).toMatch(/PsychePanes\.removeLeaf/);
    expect(functionSource('persistableProject')).not.toMatch(/paneLayouts|paneLeafId/);
    expect(mainJs).not.toMatch(/paneLeafId/);
  });

  it('reserves geometry before mutating the thread list', () => {
    const createThread = functionSource('createThread');
    expect(createThread).toMatch(/opts\.worktreePath \|\| opts\.projectRoot \|\|\s*\(project && activeWorkspaceRoot\(project\)\)/);
    expect(createThread.indexOf('preparePanePlacement(')).toBeGreaterThan(-1);
    expect(createThread.indexOf('preparePanePlacement(')).toBeLessThan(
      createThread.indexOf('state.threads.push(thread)'),
    );
    expect(createThread).toMatch(/Not enough space for another terminal pane/);
    expect(createThread).toMatch(/commitPanePlacement\(placement\)[\s\S]*state\.threads\.push\(thread\)/);
  });

  it('mounts each xterm in a persistent labelled pane shell', () => {
    const mountTerminal = functionSource('mountTerminal');
    expect(mountTerminal).toMatch(/className = "terminal-pane"/);
    expect(mountTerminal).toMatch(/pane\.dataset\.threadId = thread\.id/);
    expect(mountTerminal).toMatch(/className = "terminal-pane-header"/);
    expect(mountTerminal).toMatch(/title\.id = "terminal-pane-title-" \+ thread\.id/);
    expect(mountTerminal).toMatch(/pane\.setAttribute\("aria-labelledby", title\.id\)/);
    expect(mountTerminal).toMatch(/className = "terminal-pane-body"/);
    expect(mountTerminal).toMatch(/className = "term-instance"/);
    expect(mountTerminal).toMatch(/title = "Stop and close terminal"/);
    expect(mountTerminal).toMatch(/"Stop and close " \+ thread\.name/);
    expect(mountTerminal).toMatch(/thread\.pane = pane[\s\S]*thread\.host = container[\s\S]*renderPaneWorkspace\(\)/);
    expect(mountTerminal).not.toMatch(/terminalHost\.appendChild\(container\)/);
  });

  it('projects pane-tree layout ratios into a simultaneous DOM tree', () => {
    expect(functionSource('renderPaneNode')).toMatch(/terminal-pane-split/);
    expect(functionSource('renderPaneNode')).toMatch(/terminal-pane-branch/);
    expect(functionSource('renderPaneNode')).toMatch(/createPaneDivider\(node, ratio\)/);
    expect(functionSource('renderPaneWorkspace')).toMatch(/PsychePanes\.layoutRects/);
    expect(functionSource('renderPaneWorkspace')).toMatch(/split\.ratio/);
    expect(functionSource('renderPaneWorkspace')).toMatch(/scheduleVisiblePaneFit\(\)/);
    expect(stylesCss).not.toMatch(/\.term-instance\.active\s*\{\s*visibility:\s*visible/);
    expect(stylesCss).toMatch(/\.terminal-pane\.focused/);
    expect(stylesCss).toMatch(/\.terminal-pane-body/);
  });

  it('renders file tabs without depending on terminal thread visibility', () => {
    expect(functionSource('refreshTabs')).not.toMatch(/activeProjectThreads/);
  });

  it('preserves focus when detaching a background leaf', () => {
    const leafA = PsychePanes.createLeaf('a', 'thread-a');
    const leafB = PsychePanes.createLeaf('b', 'thread-b');
    const leafC = PsychePanes.createLeaf('c', 'thread-c');
    const root = PsychePanes.insertBelow(
      PsychePanes.insertBelow(leafA, 'a', leafB, 'split-1'),
      'a',
      leafC,
      'split-2',
    );
    const key = 'project\0worktree';
    const paneLayouts = new Map([[key, { root, focusedLeafId: 'a' }]]);
    const paneLayoutKey = () => key;
    const detachThreadPane = compileFunction<(thread: {
      id: string; projectId: string; worktreePath: string;
    }) => string | null>(functionSource('detachThreadPane'), {
      paneLayoutKey,
      paneLayouts,
      PsychePanes,
    });

    expect(detachThreadPane({
      id: 'thread-b', projectId: 'project', worktreePath: 'worktree',
    })).toBe('thread-c');
    expect(paneLayouts.get(key)?.focusedLeafId).toBe('a');

    let counter = 0;
    const preparePanePlacement = compileFunction<(
      threadId: string, projectId: string, worktreePath: string,
    ) => { value: { root: typeof root; focusedLeafId: string } } | null>(
      functionSource('preparePanePlacement'),
      {
        paneLayoutKey,
        paneLayouts,
        PsychePanes,
        nextPaneId: (prefix: string) => `${prefix}-${++counter}`,
        measuredTerminalHost: () => ({ x: 0, y: 0, width: 800, height: 500 }),
        PANE_MINIMUMS: { width: 320, height: 120, separator: 6 },
      },
    );
    const placement = preparePanePlacement('thread-d', 'project', 'worktree');
    expect(placement?.value.root).toMatchObject({
      type: 'split',
      first: {
        type: 'split',
        first: { threadId: 'thread-a' },
        second: { threadId: 'thread-d' },
      },
      second: { threadId: 'thread-c' },
    });
  });

  it('reopens a hidden matching Psyche thread instead of spawning another PTY', () => {
    const project = { id: 'project', worktrees: [{ path: '/repo' }] };
    const thread = {
      id: 'thread-a', projectId: project.id, worktreePath: '/repo',
      kind: 'psyche', status: 'running', hidden: true, pane: { id: 'pane-a' },
    };
    const originalPane = thread.pane;
    const state = { threads: [thread], activeProjectId: project.id, activeThreadId: null as string | null };
    let paneCommitted = 0;
    let focused = 0;
    let spawned = 0;
    const reopenThread = compileFunction<(id: string) => boolean>(
      functionSource('reopenThread'),
      {
        findThread: () => thread,
        preparePanePlacement: () => ({ key: 'project\0/repo', value: { root: {}, focusedLeafId: 'a' } }),
        setStatus: () => undefined,
        commitPanePlacement: () => { paneCommitted += 1; },
        findProject: () => project,
        activeWorkspaceRoot: () => '/repo',
        state,
        renderPaneWorkspace: () => undefined,
        refreshSidebar: () => undefined,
      },
    );
    const ensureProjectPsyche = compileFunction<(value: typeof project) => typeof thread>(
      functionSource('ensureProjectPsyche'),
      {
        selectedWorktree: () => project.worktrees[0],
        state,
        reopenThread,
        focusThread: () => { focused += 1; },
        spawnDefaultThreadIn: () => { spawned += 1; return null; },
      },
    );

    expect(ensureProjectPsyche(project)).toBe(thread);
    expect(thread.hidden).toBe(false);
    expect(thread.pane).toBe(originalPane);
    expect(state.activeThreadId).toBe(thread.id);
    expect({ paneCommitted, focused, spawned }).toEqual({ paneCommitted: 1, focused: 0, spawned: 0 });
  });

  it('keeps mounted pane metadata current for status and rename changes', () => {
    const attributes = new Map<string, string>();
    const thread = {
      id: 'thread-a', projectId: 'project', name: 'Psyche', status: 'starting',
      paneTitle: { textContent: '' },
      paneStatus: { textContent: '' },
      paneClose: { setAttribute: (name: string, value: string) => attributes.set(name, value) },
    };
    const syncThreadPaneMetadata = compileFunction<(value: typeof thread) => void>(
      functionSource('syncThreadPaneMetadata'),
      {},
    );
    thread.status = 'running';
    syncThreadPaneMetadata(thread);
    expect(thread.paneStatus.textContent).toBe('running');
    thread.status = 'exited';
    syncThreadPaneMetadata(thread);
    expect(thread.paneStatus.textContent).toBe('exited');

    const renameThread = compileFunction<(id: string, name: string) => boolean>(
      functionSource('renameThread'),
      {
        findThread: () => thread,
        syncThreadPaneMetadata,
        saveWorkspaceSoon: () => undefined,
        state: { activeThreadId: null },
        setProjectStatus: () => undefined,
        findProject: () => ({ id: 'project' }),
        statusLevel: () => 'ok',
      },
    );
    expect(renameThread(thread.id, 'Renamed')).toBe(true);
    expect(thread.paneTitle.textContent).toBe('Renamed');
    expect(attributes.get('aria-label')).toBe('Stop and close Renamed');

    expect(functionSource('spawnPty')).toMatch(/thread\.status = "running";[\s\S]*syncThreadPaneMetadata\(thread\)/);
    expect(functionSource('spawnPty')).toMatch(/thread\.status = "exited";[\s\S]*syncThreadPaneMetadata\(thread\)/);
    expect(functionSource('spawnPty')).toMatch(/already running[\s\S]*thread\.ptyStarted = true/);
  });

  it('guards contextual terminal creation behind dirty-file navigation', async () => {
    const terminalHost = { hidden: true };
    let spawned = 0;
    let focused = 0;
    const prepareAccepted = compileFunction<() => Promise<boolean>>(
      functionSource('prepareDefaultThreadCreation'),
      {
        showTerminalView: async () => { terminalHost.hidden = false; return true; },
      },
    );
    const acceptedCreate = compileFunction<() => Promise<boolean | null>>(
      functionSource('createContextualTab'),
      {
        currentLayout: () => 'split',
        markActiveSurface: () => undefined,
        activeSurface: 'terminal',
        prepareDefaultThreadCreation: prepareAccepted,
        openBlankBrowserTab: () => undefined,
        spawnDefaultThread: () => {
          expect(terminalHost.hidden).toBe(false);
          spawned += 1;
          focused += 1;
        },
      },
    );
    await expect(acceptedCreate()).resolves.toBe(true);
    expect(spawned).toBe(1);
    expect(focused).toBe(1);

    terminalHost.hidden = true;
    const canceledCreate = compileFunction<() => Promise<boolean | null>>(
      functionSource('createContextualTab'),
      {
        currentLayout: () => 'split',
        markActiveSurface: () => undefined,
        activeSurface: 'terminal',
        prepareDefaultThreadCreation: async () => false,
        openBlankBrowserTab: () => undefined,
        spawnDefaultThread: () => { spawned += 1; },
      },
    );
    await expect(canceledCreate()).resolves.toBeNull();
    expect(terminalHost.hidden).toBe(true);
    expect(spawned).toBe(1);
    expect(focused).toBe(1);
  });

  it('cancels a queued PTY start when the thread closes before animation frame', () => {
    const project = { id: 'project', root: '/repo' };
    const state = { threads: [] as Array<Record<string, unknown>>, activeThreadId: null as string | null };
    const pendingDataBuffers = new Map([['thread-a', [new Uint8Array([1])]]]);
    let frame: (() => void) | null = null;
    let starts = 0;
    const isLiveThread = (thread: Record<string, unknown>) =>
      state.threads.includes(thread) && thread.closing !== true;
    const createThread = compileFunction<(options: Record<string, unknown>) => Record<string, unknown>>(
      functionSource('createThread'),
      {
        makeThreadId: () => 'thread-a',
        activeProject: () => project,
        activeWorkspaceRoot: () => project.root,
        preparePanePlacement: () => ({ key: 'layout', value: {} }),
        setStatus: () => undefined,
        commitPanePlacement: () => undefined,
        state,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        mountTerminal: (thread: Record<string, unknown>) => {
          thread.fit = { fit: () => undefined };
          thread.term = { dispose: () => undefined };
        },
        focusThread: () => undefined,
        requestAnimationFrame: (callback: () => void) => { frame = callback; },
        isLiveThread,
        spawnPty: () => { starts += 1; },
      },
    );
    const thread = createThread({ project, command: '/bin/zsh' });
    pendingDataBuffers.set('thread-a', [new Uint8Array([1])]);
    const closeThread = compileFunction<(id: string) => void>(functionSource('closeThread'), {
      findThread: () => thread,
      detachThreadPane: () => null,
      pendingDataBuffers,
      invoke: async () => undefined,
      state,
      renderPaneWorkspace: () => undefined,
      setProjectStatus: () => undefined,
      findProject: () => project,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      focusThread: () => undefined,
    });
    closeThread('thread-a');
    expect(frame).not.toBeNull();
    (frame as unknown as () => void)();
    expect(starts).toBe(0);
    expect(state.threads).toEqual([]);
    expect(thread.closing).toBe(true);
    expect(pendingDataBuffers.has('thread-a')).toBe(false);
  });

  it('stops a remotely started PTY when close wins the in-flight start race', async () => {
    const start = deferred<void>();
    const project = { id: 'project' };
    const thread = {
      id: 'thread-a', projectId: project.id, worktreePath: '/repo',
      command: '/bin/zsh', args: [], env: {}, status: 'starting', spawning: true,
      closing: false, startInFlight: false, term: null, fit: null,
    };
    const state = { threads: [thread], activeThreadId: thread.id };
    const pendingDataBuffers = new Map([[thread.id, [new Uint8Array([1])]]]);
    let stopCalls = 0;
    const invoke = (command: string) => {
      if (command === 'pty_start') return start.promise;
      if (command === 'pty_stop') stopCalls += 1;
      return Promise.resolve();
    };
    const isLiveThread = (candidate: typeof thread) =>
      state.threads.includes(candidate) && !candidate.closing;
    const spawnPty = compileFunction<(value: typeof thread, root: string) => Promise<boolean>>(
      functionSource('spawnPty'),
      {
        invoke,
        isLiveThread,
        pendingDataBuffers,
        syncThreadPaneMetadata: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        state,
        setProjectStatus: () => undefined,
        findProject: () => project,
        setStatus: () => undefined,
      },
    );
    const starting = spawnPty(thread, '/repo');
    expect(thread.startInFlight).toBe(true);
    const closeThread = compileFunction<(id: string) => void>(functionSource('closeThread'), {
      findThread: () => thread,
      detachThreadPane: () => null,
      pendingDataBuffers,
      invoke,
      state,
      renderPaneWorkspace: () => undefined,
      setProjectStatus: () => undefined,
      findProject: () => project,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      focusThread: () => undefined,
    });
    closeThread(thread.id);
    start.resolve();
    await expect(starting).resolves.toBe(false);
    expect(stopCalls).toBeGreaterThanOrEqual(2);
    expect(thread.status).toBe('starting');
    expect(thread.startInFlight).toBe(false);
    expect(state.threads).toEqual([]);
    expect(pendingDataBuffers.has(thread.id)).toBe(false);
  });

  it('guards inactive-project hidden-session reopen behind dirty-file cancellation', async () => {
    const state = { activeProjectId: 'active-project' };
    const project = { id: 'inactive-project', selectedWorktreePath: '/old' };
    let projectSwitches = 0;
    let reopenCalls = 0;
    const activateProjectWorktree = compileFunction<(
      value: typeof project, path: string,
    ) => Promise<boolean>>(functionSource('activateProjectWorktree'), {
      showTerminalView: async () => false,
      state,
      setActiveProject: async () => { projectSwitches += 1; return true; },
      activatePaneLayoutFocus: () => undefined,
      renderPaneWorkspace: () => undefined,
      renderPanel: () => undefined,
      currentPanel: () => 'browser',
      loadAgentSkills: () => undefined,
      refreshSidebar: () => undefined,
      syncProjectBrowser: () => undefined,
      saveWorkspaceSoon: () => undefined,
    });
    const reopenThreadsForWorkspace = compileFunction<(
      value: typeof project, path: string,
    ) => Promise<number>>(functionSource('reopenThreadsForWorkspace'), {
      activateProjectWorktree,
      reopenThreads: () => { reopenCalls += 1; return 1; },
      state,
      focusThread: async () => true,
    });

    await expect(reopenThreadsForWorkspace(project, '/target')).resolves.toBe(0);
    expect(state.activeProjectId).toBe('active-project');
    expect(project.selectedWorktreePath).toBe('/old');
    expect({ projectSwitches, reopenCalls }).toEqual({ projectSwitches: 0, reopenCalls: 0 });
  });

  it('activates an inactive project worktree before reopening its hidden sessions', async () => {
    const state = { activeProjectId: 'active-project' };
    const project = { id: 'inactive-project', selectedWorktreePath: '/old' };
    const calls: string[] = [];
    const activateProjectWorktree = compileFunction<(
      value: typeof project, path: string,
    ) => Promise<boolean>>(functionSource('activateProjectWorktree'), {
      showTerminalView: async () => { calls.push('terminal'); return true; },
      state,
      setActiveProject: async (id: string) => {
        calls.push(`project:${id}`);
        state.activeProjectId = id;
        return true;
      },
      activatePaneLayoutFocus: () => { calls.push('focus'); },
      renderPaneWorkspace: () => { calls.push('panes'); },
      renderPanel: () => { calls.push('panel'); },
      currentPanel: () => 'browser',
      loadAgentSkills: () => { calls.push('skills'); },
      refreshSidebar: () => { calls.push('sidebar'); },
      syncProjectBrowser: () => { calls.push('browser'); },
      saveWorkspaceSoon: () => { calls.push('save'); },
    });
    let reopened = 0;
    const reopenThreadsForWorkspace = compileFunction<(
      value: typeof project, path: string,
    ) => Promise<number>>(functionSource('reopenThreadsForWorkspace'), {
      activateProjectWorktree,
      reopenThreads: (projectId: string, path: string) => {
        expect({ projectId, path }).toEqual({ projectId: project.id, path: '/target' });
        reopened += 1;
        (state as { activeProjectId: string; activeThreadId?: string }).activeThreadId = 'hidden-thread';
        return 2;
      },
      state,
      focusThread: async (id: string) => { calls.push(`focus:${id}`); return true; },
    });

    await expect(reopenThreadsForWorkspace(project, '/target')).resolves.toBe(2);
    expect(state.activeProjectId).toBe(project.id);
    expect(project.selectedWorktreePath).toBe('/target');
    expect(reopened).toBe(1);
    expect(calls).toEqual([
      'terminal', `project:${project.id}`, 'panes', 'panel',
      'skills', 'sidebar', 'browser', 'save', 'focus:hidden-thread',
    ]);
  });

  it('accepts guarded /new-thread creation only after revealing the terminal', async () => {
    const terminalHost = { hidden: true };
    let spawned = 0;
    const runNewThreadCommand = compileFunction<() => Promise<{ kind: string } | null>>(
      functionSource('runNewThreadCommand'),
      {
        prepareDefaultThreadCreation: async () => {
          terminalHost.hidden = false;
          return true;
        },
        spawnDefaultThread: () => {
          expect(terminalHost.hidden).toBe(false);
          spawned += 1;
          return { kind: 'shell' };
        },
      },
    );
    await expect(runNewThreadCommand()).resolves.toEqual({ kind: 'shell' });
    expect(spawned).toBe(1);
    expect(mainJs).toMatch(/cmd: "\/new-thread"[\s\S]*?run: runNewThreadCommand/);
  });

  it('cancels /new-thread without creating a thread or PTY', async () => {
    let spawned = 0;
    const runNewThreadCommand = compileFunction<() => Promise<null>>(
      functionSource('runNewThreadCommand'),
      {
        prepareDefaultThreadCreation: async () => false,
        spawnDefaultThread: () => { spawned += 1; return { kind: 'wrong' }; },
      },
    );
    await expect(runNewThreadCommand()).resolves.toBeNull();
    expect(spawned).toBe(0);
  });

  it('accepts guarded /new-psyche creation with its distinct spawn path', async () => {
    const terminalHost = { hidden: true };
    let spawned = 0;
    const runNewPsycheCommand = compileFunction<() => Promise<{ kind: string } | null>>(
      functionSource('runNewPsycheCommand'),
      {
        prepareDefaultThreadCreation: async () => {
          terminalHost.hidden = false;
          return true;
        },
        spawnPsycheThread: () => {
          expect(terminalHost.hidden).toBe(false);
          spawned += 1;
          return { kind: 'psyche' };
        },
      },
    );
    await expect(runNewPsycheCommand()).resolves.toEqual({ kind: 'psyche' });
    expect(spawned).toBe(1);
    expect(mainJs).toMatch(/cmd: "\/new-psyche"[\s\S]*?run: runNewPsycheCommand/);
  });

  it('cancels /new-psyche without creating a thread or PTY', async () => {
    let spawned = 0;
    const runNewPsycheCommand = compileFunction<() => Promise<null>>(
      functionSource('runNewPsycheCommand'),
      {
        prepareDefaultThreadCreation: async () => false,
        spawnPsycheThread: () => { spawned += 1; return { kind: 'wrong' }; },
      },
    );
    await expect(runNewPsycheCommand()).resolves.toBeNull();
    expect(spawned).toBe(0);
  });
});
