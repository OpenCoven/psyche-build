import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
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
      'effectivePaneRoot',
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
      effectiveRoot: (value: typeof layout) => unknown,
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
      (value) => value && value.root,
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
    expect(mainJs).toMatch(/var PANE_MINIMUMS = \{ width: 200, height: 137, separator: 6 \};/);
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
    expect(createThread).toMatch(/opts\.worktreePath \|\| launch\.cwd \|\| launch\.projectRoot/);
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

  it('focuses from pane chrome without duplicating body focus or racing close', () => {
    const thread = { id: 'thread-a' };
    const bodyTarget = { id: 'body-target' };
    const closeTarget = { id: 'close-target' };
    const headerTarget = { id: 'header-target', closest: () => null };
    // Any other header button — focusing on its pointerdown would detach the
    // pane before pointerup and swallow the click it was about to receive.
    const spanTarget = { id: 'span-target', closest: (sel: string) => sel === 'button' ? spanTarget : null };
    const body = { contains: (target: unknown) => target === bodyTarget };
    const close = { contains: (target: unknown) => target === closeTarget };
    const state = { activeThreadId: 'thread-b' };
    const focused: string[] = [];
    const handlePanePointerDown = compileFunction<(
      value: typeof thread,
      bodyElement: typeof body,
      closeElement: typeof close,
      event: { target: unknown },
    ) => void>(functionSource('handlePanePointerDown'), {
      state,
      focusThread: (id: string) => { focused.push(id); },
    });

    handlePanePointerDown(thread, body, close, { target: bodyTarget });
    handlePanePointerDown(thread, body, close, { target: closeTarget });
    handlePanePointerDown(thread, body, close, { target: spanTarget });
    expect(focused).toEqual([]);
    handlePanePointerDown(thread, body, close, { target: headerTarget });
    expect(focused).toEqual([thread.id]);
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

  it('refreshes the minimap in the empty-layout branch while a file stays active', () => {
    const calls: string[] = [];
    const activeFile = { id: 'file-a' };
    const terminalHost = {
      children: ['stale-pane'],
      replaceChildren: () => {
        terminalHost.children = [];
        calls.push('clear');
      },
    };
    const renderPaneWorkspace = compileFunction<() => void>(functionSource('renderPaneWorkspace'), {
      terminalHost,
      stageBrowserSurface: () => { calls.push('stage'); },
      activePaneLayout: () => null,
      renderTerminalEmptyState: () => { calls.push('empty'); },
      renderPaneMinimap: (layout: unknown, file: unknown) => {
        expect(layout).toBeNull();
        expect(file).toBe(activeFile);
        calls.push('minimap');
      },
      findOpenFile: (id: string | null) => {
        expect(id).toBe('file-a');
        return activeFile;
      },
      state: { activeFileId: 'file-a' },
    });

    renderPaneWorkspace();
    expect(terminalHost.children).toEqual([]);
    expect(calls).toEqual(['stage', 'clear', 'empty', 'minimap']);
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

  it('does not deduplicate a hidden Coven thread when ensuring a workspace', async () => {
    const project = { id: 'project', worktrees: [{ path: '/repo' }] };
    const thread = {
      id: 'thread-a', projectId: project.id, worktreePath: '/repo',
      kind: 'coven-chat', status: 'running', hidden: true, pane: { id: 'pane-a' },
    };
    const state = { threads: [thread] };
    let focused = 0;
    let spawned = 0;
    const replacement = { ...thread, id: 'thread-b', hidden: false };
    const ensureProjectCoven = compileFunction<(value: typeof project) => Promise<typeof replacement>>(
      functionSource('ensureProjectCoven'),
      {
        selectedWorktree: () => project.worktrees[0],
        state,
        focusThread: async () => { focused += 1; },
        spawnCovenThread: async () => { spawned += 1; return replacement; },
        covenEnsureFlights: new Map(),
      },
    );

    await expect(ensureProjectCoven(project)).resolves.toBe(replacement);
    expect(thread.hidden).toBe(true);
    expect({ focused, spawned }).toEqual({ focused: 0, spawned: 1 });
  });

  it('keeps mounted pane metadata current for status and rename changes', () => {
    const attributes = new Map<string, string>();
    const paneAttributes = new Map<string, string>();
    const thread = {
      id: 'thread-a', projectId: 'project', name: 'Psyche', status: 'starting',
      pane: {
        dataset: {} as Record<string, string>,
        setAttribute: (name: string, value: string) => paneAttributes.set(name, value),
        removeAttribute: (name: string) => { paneAttributes.delete(name); },
      },
      paneTitle: { textContent: '' },
      paneClose: { setAttribute: (name: string, value: string) => attributes.set(name, value) },
    };
    const applyPaneStatus = compileFunction<(element: unknown, status: string) => void>(
      functionSource('applyPaneStatus'),
      {},
    );
    const syncThreadPaneMetadata = compileFunction<(value: typeof thread) => void>(
      functionSource('syncThreadPaneMetadata'),
      {
        applyPaneStatus,
        threadLaneLabel: () => 'main',
        // No pane tree in this harness: the span/maximise controls have nothing
        // to reflect, which is exactly the detached-pane case.
        paneLayoutForThread: () => null,
        PsychePanes: { findLeafByThreadId: () => null },
        syncPaneSpanControl: () => undefined,
        syncPaneMaxControl: () => undefined,
      },
    );
    thread.status = 'running';
    syncThreadPaneMetadata(thread);
    expect(thread.pane.dataset.status).toBe('running');
    expect(paneAttributes.get('aria-description')).toBe('Status: running');

    thread.status = 'exited';
    syncThreadPaneMetadata(thread);
    expect(thread.pane.dataset.status).toBe('exited');
    expect(paneAttributes.get('aria-description')).toBe('Status: exited');

    thread.status = 'paused';
    syncThreadPaneMetadata(thread);
    expect('status' in thread.pane.dataset).toBe(false);
    expect(paneAttributes.has('aria-description')).toBe(false);

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
    expect(functionSource('handlePtyExit')).toMatch(/thread\.status = "exited";[\s\S]*syncThreadPaneMetadata\(thread\)/);
    expect(functionSource('spawnPty')).toMatch(/already running[\s\S]*thread\.ptyStarted = true/);
  });

  it('creates a shell only after validating the active project, worktree, and terminal reveal', async () => {
    const calls: string[] = [];
    const visible = deferred<boolean>();
    const project = { id: 'project', root: '/repo' };
    const worktree = { path: '/repo' };
    const acceptedCreate = compileFunction<() => Promise<{ kind: string } | null>>(
      functionSource('createTerminalPane'),
      {
        activeProject: () => {
          calls.push('project');
          return project;
        },
        selectedWorktree: (candidate: { id: string; root: string }) => {
          calls.push(`worktree:${candidate.id}`);
          return worktree;
        },
        showTerminalView: async () => {
          calls.push('show:start');
          const result = await visible.promise;
          calls.push(`show:end:${result}`);
          return result;
        },
        spawnShellThread: (candidate: { id: string; root: string }) => {
          calls.push(`spawn:${candidate.id}`);
          return { kind: 'shell' };
        },
        setStatus: () => {
          calls.push('status');
        },
      },
    );
    const pendingCreate = acceptedCreate();
    await Promise.resolve();
    expect(calls).toEqual(['project', 'worktree:project', 'show:start']);
    visible.resolve(true);
    await expect(pendingCreate).resolves.toEqual({ kind: 'shell' });
    expect(calls).toEqual(['project', 'worktree:project', 'show:start', 'show:end:true', 'spawn:project']);
  });

  it('cancels shell creation when terminal reveal is rejected by dirty-file flow', async () => {
    const calls: string[] = [];
    const createTerminalPane = compileFunction<() => Promise<null>>(
      functionSource('createTerminalPane'),
      {
        activeProject: () => ({ id: 'project', root: '/repo' }),
        selectedWorktree: () => ({ path: '/repo' }),
        showTerminalView: async () => {
          calls.push('show:false');
          return false;
        },
        spawnShellThread: () => {
          calls.push('spawn');
          return { kind: 'wrong' };
        },
        setStatus: () => {
          calls.push('status');
        },
      },
    );

    await expect(createTerminalPane()).resolves.toBeNull();
    expect(calls).toEqual(['show:false']);
  });

  it('warns instead of creating a shell when there is no active project', async () => {
    const calls: string[] = [];
    const createTerminalPane = compileFunction<() => Promise<null>>(
      functionSource('createTerminalPane'),
      {
        activeProject: () => null,
        selectedWorktree: () => {
          calls.push('worktree');
          return { path: '/repo' };
        },
        showTerminalView: async () => {
          calls.push('show');
          return true;
        },
        spawnShellThread: () => {
          calls.push('spawn');
          return { kind: 'wrong' };
        },
        setStatus: (text: string, level: string) => {
          calls.push(`status:${level}:${text}`);
        },
      },
    );

    await expect(createTerminalPane()).resolves.toBeNull();
    expect(calls).toEqual(['status:warn:Open a project before starting a terminal']);
  });

  it('warns instead of creating a shell when no worktree path is available', async () => {
    const calls: string[] = [];
    const createTerminalPane = compileFunction<() => Promise<null>>(
      functionSource('createTerminalPane'),
      {
        activeProject: () => ({ id: 'project', root: '/repo' }),
        selectedWorktree: () => ({ branch: 'main' }),
        showTerminalView: async () => {
          calls.push('show');
          return true;
        },
        spawnShellThread: () => {
          calls.push('spawn');
          return { kind: 'wrong' };
        },
        setStatus: (text: string, level: string) => {
          calls.push(`status:${level}:${text}`);
        },
      },
    );

    await expect(createTerminalPane()).resolves.toBeNull();
    expect(calls).toEqual(['status:warn:Select an available worktree before starting a terminal']);
  });

  it('cancels a queued PTY start when the thread closes before animation frame', () => {
    const project = { id: 'project', root: '/repo' };
    const state = { threads: [] as Array<Record<string, unknown>>, activeThreadId: null as string | null };
    const pendingDataBuffers = new Map([['thread-a', [new Uint8Array([1])]]]);
    let frame: (() => void) | null = null;
    let starts = 0;
    let stops = 0;
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
    const closeThread = compileFunction<(id: string) => boolean>(functionSource('closeThread'), {
      forgetThreadInSets: () => undefined,
      findThread: () => thread,
      detachThreadPane: () => null,
      retainFileFocusAfterThreadRemoval: () => false,
      pendingDataBuffers,
      stopThreadPty: () => { stops += 1; return Promise.resolve(true); },
      state,
      renderPaneWorkspace: () => undefined,
      setProjectStatus: () => undefined,
      findProject: () => project,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      focusThread: () => undefined,
    });
    expect(closeThread('thread-a')).toBe(true);
    expect(frame).not.toBeNull();
    (frame as unknown as () => void)();
    expect(starts).toBe(0);
    expect(stops).toBe(1);
    expect(state.threads).toEqual([]);
    expect(thread.closing).toBe(true);
    expect(pendingDataBuffers.has('thread-a')).toBe(false);
  });

  it('stops a remotely started PTY when close wins the in-flight start race', async () => {
    const start = deferred<void>();
    const project = { id: 'project' };
    const thread = {
      id: 'thread-a', projectId: project.id, worktreePath: '/repo',
      launch: {
        command: '/bin/zsh', args: [], env: {}, projectRoot: '/repo', cwd: '/repo',
        launchKind: null, covenSessionId: null,
      },
      status: 'starting', spawning: true,
      closing: false, closeStarted: false, startInFlight: false,
      stopRequested: false, ptyStarted: false, term: null, fit: null,
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
    const stopThreadPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
      functionSource('stopThreadPty'), { invoke },
    );
    const spawnPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
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
        stopThreadPty,
      },
    );
    const starting = spawnPty(thread);
    expect(thread.startInFlight).toBe(true);
    const closeThread = compileFunction<(id: string) => boolean>(functionSource('closeThread'), {
      forgetThreadInSets: () => undefined,
      findThread: () => thread,
      detachThreadPane: () => null,
      retainFileFocusAfterThreadRemoval: () => false,
      pendingDataBuffers,
      stopThreadPty,
      state,
      renderPaneWorkspace: () => undefined,
      setProjectStatus: () => undefined,
      findProject: () => project,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      focusThread: () => undefined,
    });
    expect(closeThread(thread.id)).toBe(true);
    start.resolve();
    await expect(starting).resolves.toBe(false);
    expect(stopCalls).toBe(1);
    expect(thread.status).toBe('starting');
    expect(thread.startInFlight).toBe(false);
    expect(state.threads).toEqual([]);
    expect(pendingDataBuffers.has(thread.id)).toBe(false);
  });

  it('retains file focus when closing the active underlying pane', () => {
    const project = {
      id: 'project',
      lastActiveThreadId: 'thread-a',
      selectedWorktreePath: '/repo',
    };
    const threadA = {
      id: 'thread-a',
      kind: 'shell',
      projectId: project.id,
      worktreePath: '/repo',
      closeStarted: false,
      closing: false,
      startInFlight: false,
      term: { dispose: () => undefined },
    };
    const threadB = {
      id: 'thread-b',
      kind: 'shell',
      projectId: project.id,
      worktreePath: '/repo-next',
      closeStarted: false,
      closing: false,
      startInFlight: false,
      term: { dispose: () => undefined },
    };
    const state = {
      threads: [threadA, threadB],
      activeThreadId: threadA.id as string | null,
      activeFileId: 'file-a',
    };
    const fileFocus = { returnThreadId: threadA.id as string | null };
    const retainFileFocusAfterThreadRemoval = compileFunction<
      (removedThreadId: string, nextThreadId: string | null, projectId: string | null) => boolean
    >(functionSource('retainFileFocusAfterThreadRemoval'), {
      state,
      fileFocus,
      findProject: (id: string) => (id === project.id ? project : null),
      findThread: (id: string) => state.threads.find((thread) => thread.id === id) || null,
    });
    let renders = 0;
    let focused = 0;
    const closeThread = compileFunction<(id: string) => boolean>(functionSource('closeThread'), {
      forgetThreadInSets: () => undefined,
      findThread: (id: string) => state.threads.find((thread) => thread.id === id) || null,
      detachThreadPane: () => threadB.id,
      retainFileFocusAfterThreadRemoval,
      pendingDataBuffers: new Map(),
      stopThreadPty: () => Promise.resolve(true),
      state,
      fileFocus,
      renderPaneWorkspace: () => { renders += 1; },
      setProjectStatus: () => undefined,
      findProject: () => project,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      focusThread: () => { focused += 1; },
    });

    expect(closeThread(threadA.id)).toBe(true);
    expect(focused).toBe(0);
    expect(state.activeFileId).toBe('file-a');
    expect(state.activeThreadId).toBe(threadB.id);
    expect(fileFocus.returnThreadId).toBe(threadB.id);
    expect(project.lastActiveThreadId).toBe(threadB.id);
    expect(project.selectedWorktreePath).toBe(threadB.worktreePath);
    expect(renders).toBe(1);
    expect(state.threads).toEqual([threadB]);
  });

  it('retains file focus when hiding the active underlying pane', () => {
    const project = {
      id: 'project',
      lastActiveThreadId: 'thread-a',
      selectedWorktreePath: '/repo',
    };
    const threadA = {
      id: 'thread-a',
      kind: 'shell',
      projectId: project.id,
      worktreePath: '/repo',
      hidden: false,
    };
    const threadB = {
      id: 'thread-b',
      kind: 'shell',
      projectId: project.id,
      worktreePath: '/repo-next',
      hidden: false,
    };
    const state = {
      threads: [threadA, threadB],
      activeThreadId: threadA.id as string | null,
      activeFileId: 'file-a',
    };
    const fileFocus = { returnThreadId: threadA.id as string | null };
    const retainFileFocusAfterThreadRemoval = compileFunction<
      (removedThreadId: string, nextThreadId: string | null, projectId: string | null) => boolean
    >(functionSource('retainFileFocusAfterThreadRemoval'), {
      state,
      fileFocus,
      findProject: (id: string) => (id === project.id ? project : null),
      findThread: (id: string) => state.threads.find((thread) => thread.id === id) || null,
    });
    let renders = 0;
    let focused = 0;
    const hideThread = compileFunction<(id: string) => boolean>(functionSource('hideThread'), {
      findThread: (id: string) => state.threads.find((thread) => thread.id === id) || null,
      detachThreadPane: () => threadB.id,
      retainFileFocusAfterThreadRemoval,
      state,
      fileFocus,
      focusThread: () => { focused += 1; },
      renderPaneWorkspace: () => { renders += 1; },
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
    });

    expect(hideThread(threadA.id)).toBe(true);
    expect(focused).toBe(0);
    expect(state.activeFileId).toBe('file-a');
    expect(state.activeThreadId).toBe(threadB.id);
    expect(fileFocus.returnThreadId).toBe(threadB.id);
    expect(project.lastActiveThreadId).toBe(threadB.id);
    expect(project.selectedWorktreePath).toBe(threadB.worktreePath);
    expect(threadA.hidden).toBe(true);
    expect(renders).toBe(1);
  });

  it('clears file-focus project metadata when there is no replacement pane', () => {
    const project = {
      id: 'project',
      lastActiveThreadId: 'thread-a',
      selectedWorktreePath: '/repo',
    };
    const threadA = {
      id: 'thread-a',
      kind: 'shell',
      projectId: project.id,
      worktreePath: '/repo',
      closeStarted: false,
      closing: false,
      startInFlight: false,
      term: { dispose: () => undefined },
    };
    const state = {
      threads: [threadA],
      activeThreadId: threadA.id as string | null,
      activeFileId: 'file-a',
    };
    const fileFocus = { returnThreadId: threadA.id as string | null };
    const retainFileFocusAfterThreadRemoval = compileFunction<
      (removedThreadId: string, nextThreadId: string | null, projectId: string | null) => boolean
    >(functionSource('retainFileFocusAfterThreadRemoval'), {
      state,
      fileFocus,
      findProject: (id: string) => (id === project.id ? project : null),
      findThread: (id: string) => state.threads.find((thread) => thread.id === id) || null,
    });
    const closeThread = compileFunction<(id: string) => boolean>(functionSource('closeThread'), {
      forgetThreadInSets: () => undefined,
      findThread: (id: string) => state.threads.find((thread) => thread.id === id) || null,
      detachThreadPane: () => null,
      retainFileFocusAfterThreadRemoval,
      pendingDataBuffers: new Map(),
      stopThreadPty: () => Promise.resolve(true),
      state,
      renderPaneWorkspace: () => undefined,
      setProjectStatus: () => undefined,
      findProject: (id: string) => (id === project.id ? project : null),
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      focusThread: () => undefined,
    });

    expect(closeThread(threadA.id)).toBe(true);
    expect(state.activeThreadId).toBeNull();
    expect(fileFocus.returnThreadId).toBeNull();
    expect(project.lastActiveThreadId).toBeNull();
    expect(project.selectedWorktreePath).toBe('/repo');
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

  it('renders an active-project worktree switch exactly once at coordinator level', async () => {
    const project = { id: 'project', selectedWorktreePath: '/old', lastActiveThreadId: null as string | null };
    const thread = { id: 'thread-a' };
    const state = { activeProjectId: project.id, activeThreadId: null as string | null };
    let renders = 0;
    let refreshes = 0;
    const renderPaneWorkspace = () => { renders += 1; };
    const activatePaneLayoutFocus = compileFunction<(
      value: typeof project, path: string,
    ) => void>(functionSource('activatePaneLayoutFocus'), {
      paneLayoutFor: () => ({
        root: PsychePanes.createLeaf('leaf-a', thread.id),
        focusedLeafId: 'leaf-a',
      }),
      PsychePanes,
      findThread: () => thread,
      state,
      renderPaneWorkspace,
      refreshStatusController: () => { refreshes += 1; },
    });
    const activateProjectWorktree = compileFunction<(
      value: typeof project, path: string,
    ) => Promise<boolean>>(functionSource('activateProjectWorktree'), {
      showTerminalView: async () => true,
      state,
      setActiveProject: async () => true,
      activatePaneLayoutFocus,
      renderPaneWorkspace,
      renderPanel: () => undefined,
      currentPanel: () => 'browser',
      loadAgentSkills: () => undefined,
      refreshSidebar: () => undefined,
      syncProjectBrowser: () => undefined,
      saveWorkspaceSoon: () => undefined,
      refreshStatusController: () => { refreshes += 1; },
    });

    await expect(activateProjectWorktree(project, '/target')).resolves.toBe(true);
    expect(project.selectedWorktreePath).toBe('/target');
    expect(state.activeThreadId).toBe(thread.id);
    expect(renders).toBe(1);
    expect(refreshes).toBe(1);
  });

  it('refreshes an inactive-project worktree switch once after nested project activation', async () => {
    const project = {
      id: 'project',
      selectedWorktreePath: '/old',
      lastActiveThreadId: 'thread-a',
    };
    const state = {
      activeProjectId: 'other',
      activeThreadId: null as string | null,
      threads: [{
        id: 'thread-a',
        projectId: project.id,
        worktreePath: '/target',
        hidden: false,
      }],
    };
    const options = { ensureCoven: false };
    const focusCalls: Array<{ id: string; options: Record<string, unknown> | undefined }> = [];
    let refreshes = 0;
    const setActiveProject = compileFunction<(
      id: string,
      callOptions?: Record<string, unknown>,
    ) => Promise<boolean>>(functionSource('setActiveProject'), {
      state,
      showTerminalView: async () => true,
      findProject: () => project,
      restoreProjectLayout: () => undefined,
      loadAgentSkills: () => undefined,
      activeWorkspaceRoot: (value: typeof project) => value.selectedWorktreePath,
      focusThread: async (id: string, focusOptions?: Record<string, unknown>) => {
        focusCalls.push({ id, options: focusOptions });
        state.activeThreadId = id;
        return true;
      },
      renderPaneWorkspace: () => undefined,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      syncProjectBrowser: () => undefined,
      ensureProjectCoven: async () => null,
      setStatus: () => undefined,
      saveWorkspaceSoon: () => undefined,
      refreshStatusController: () => { refreshes += 1; },
    });
    const activateProjectWorktree = compileFunction<(
      value: typeof project,
      path: string,
      callOptions?: Record<string, unknown>,
    ) => Promise<boolean>>(functionSource('activateProjectWorktree'), {
      showTerminalView: async () => true,
      state,
      setActiveProject,
      activatePaneLayoutFocus: () => undefined,
      renderPaneWorkspace: () => undefined,
      renderPanel: () => undefined,
      currentPanel: () => 'browser',
      loadAgentSkills: () => undefined,
      refreshSidebar: () => undefined,
      syncProjectBrowser: () => undefined,
      saveWorkspaceSoon: () => undefined,
      refreshStatusController: () => { refreshes += 1; },
    });

    await expect(activateProjectWorktree(project, '/target', options)).resolves.toBe(true);
    expect(state.activeProjectId).toBe(project.id);
    expect(state.activeThreadId).toBe('thread-a');
    expect(project.selectedWorktreePath).toBe('/target');
    expect(focusCalls).toEqual([
      { id: 'thread-a', options: { ensureCoven: false, refreshStatus: false } },
    ]);
    expect(refreshes).toBe(1);
    expect(options).toEqual({ ensureCoven: false });
  });

  it('refreshes direct focusThread by default and allows batched suppression', async () => {
    const state = { activeProjectId: 'project', activeThreadId: null as string | null };
    const project = {
      id: 'project',
      lastActiveThreadId: null as string | null,
      selectedWorktreePath: null as string | null,
    };
    const thread = {
      id: 'thread-a',
      kind: 'shell',
      projectId: project.id,
      worktreePath: '/repo',
      status: 'running',
      term: { focus: () => undefined },
    };
    let refreshes = 0;
    const focusThread = compileFunction<(
      id: string,
      options?: { refreshStatus?: boolean },
    ) => Promise<boolean>>(functionSource('focusThread'), {
      findThread: (id: string) => (id === thread.id ? thread : null),
      showTerminalView: async () => true,
      markActiveSurface: () => undefined,
      state,
      findProject: () => project,
      paneLayoutFor: () => null,
      PsychePanes,
      renderPaneWorkspace: () => undefined,
      refreshSidebar: () => undefined,
      requestAnimationFrame: (callback: () => void) => callback(),
      scheduleVisiblePaneFit: () => undefined,
      syncBrowserBounds: () => undefined,
      setProjectStatus: () => undefined,
      statusLevel: () => 'ok',
      refreshStatusController: () => { refreshes += 1; },
    });

    await expect(focusThread(thread.id)).resolves.toBe(true);
    await expect(focusThread(thread.id, { refreshStatus: false })).resolves.toBe(true);
    expect(state.activeThreadId).toBe(thread.id);
    expect(project.lastActiveThreadId).toBe(thread.id);
    expect(project.selectedWorktreePath).toBe('/repo');
    expect(refreshes).toBe(1);
  });

  it('refreshes direct setActiveProject once while honoring suppressed outer refresh', async () => {
    const createSetActiveProject = (
      state: {
        activeProjectId: string;
        activeThreadId: string | null;
        threads: Array<Record<string, unknown>>;
      },
      project: {
        id: string;
        selectedWorktreePath: string;
        lastActiveThreadId: string | null;
      },
      focusCalls: Array<{ id: string; options: Record<string, unknown> | undefined }>,
      refreshes: { count: number },
    ) => compileFunction<(
      id: string,
      callOptions?: Record<string, unknown>,
    ) => Promise<boolean>>(functionSource('setActiveProject'), {
      state,
      showTerminalView: async () => true,
      findProject: () => project,
      restoreProjectLayout: () => undefined,
      loadAgentSkills: () => undefined,
      activeWorkspaceRoot: (value: typeof project) => value.selectedWorktreePath,
      focusThread: async (id: string, focusOptions?: Record<string, unknown>) => {
        focusCalls.push({ id, options: focusOptions });
        state.activeThreadId = id;
        return true;
      },
      renderPaneWorkspace: () => undefined,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      syncProjectBrowser: () => undefined,
      ensureProjectCoven: async () => null,
      setStatus: () => undefined,
      saveWorkspaceSoon: () => undefined,
      refreshStatusController: () => { refreshes.count += 1; },
    });

    const directProject = {
      id: 'project',
      selectedWorktreePath: '/repo',
      lastActiveThreadId: 'thread-a',
    };

    const defaultState = {
      activeProjectId: 'other',
      activeThreadId: null as string | null,
      threads: [{
        id: 'thread-a',
        projectId: directProject.id,
        worktreePath: '/repo',
        hidden: false,
      }],
    };
    const defaultOptions = { ensureCoven: false };
    const defaultFocusCalls: Array<{ id: string; options: Record<string, unknown> | undefined }> = [];
    const defaultRefreshes = { count: 0 };
    const setActiveProject = createSetActiveProject(
      defaultState,
      directProject,
      defaultFocusCalls,
      defaultRefreshes,
    );

    await expect(setActiveProject(directProject.id, defaultOptions)).resolves.toBe(true);
    expect(defaultState.activeProjectId).toBe(directProject.id);
    expect(defaultFocusCalls).toEqual([
      { id: 'thread-a', options: { ensureCoven: false, refreshStatus: false } },
    ]);
    expect(defaultRefreshes.count).toBe(1);
    expect(defaultOptions).toEqual({ ensureCoven: false });

    const suppressedState = {
      activeProjectId: 'other',
      activeThreadId: null as string | null,
      threads: [{
        id: 'thread-a',
        projectId: directProject.id,
        worktreePath: '/repo',
        hidden: false,
      }],
    };
    const suppressedOptions = { refreshStatus: false };
    const suppressedFocusCalls: Array<{ id: string; options: Record<string, unknown> | undefined }> = [];
    const suppressedRefreshes = { count: 0 };
    const suppressedSetActiveProject = createSetActiveProject(
      suppressedState,
      directProject,
      suppressedFocusCalls,
      suppressedRefreshes,
    );

    await expect(
      suppressedSetActiveProject(directProject.id, suppressedOptions),
    ).resolves.toBe(true);
    expect(suppressedFocusCalls).toEqual([
      { id: 'thread-a', options: { refreshStatus: false } },
    ]);
    expect(suppressedRefreshes.count).toBe(0);
    expect(suppressedOptions).toEqual({ refreshStatus: false });
  });

  it('accepts guarded /new-thread creation only after revealing the terminal', async () => {
    const terminalHost = { hidden: true };
    let spawned = 0;
    const runNewThreadCommand = compileFunction<() => Promise<{ kind: string } | null>>(
      functionSource('runNewThreadCommand'),
      {
        spawnCovenThread: async () => {
          terminalHost.hidden = false;
          expect(terminalHost.hidden).toBe(false);
          spawned += 1;
          return { kind: 'coven-chat' };
        },
      },
    );
    await expect(runNewThreadCommand()).resolves.toEqual({ kind: 'coven-chat' });
    expect(spawned).toBe(1);
    expect(mainJs).toMatch(/cmd: "\/new-thread"[\s\S]*?run: runNewThreadCommand/);
  });

  it('cancels /new-thread without creating a thread or PTY', async () => {
    let spawned = 0;
    const runNewThreadCommand = compileFunction<() => Promise<null>>(
      functionSource('runNewThreadCommand'),
      {
        spawnCovenThread: async () => null,
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

  describe('span and focus modes', () => {
    type Leaf = { type: 'leaf'; id: string; threadId: string };
    type Layout = {
      root: Record<string, unknown>;
      focusedLeafId: string | null;
      spanMode?: string | null;
      spanRoot?: unknown;
      spanSignature?: string | null;
      maximizedLeafId?: string | null;
      activeSetId?: string | null;
    };

    function tree(): Record<string, unknown> {
      return {
        type: 'split', id: 'split-1', orientation: 'column', ratio: 0.5,
        first: { type: 'leaf', id: 'leaf-a', threadId: 'thread-a' },
        second: { type: 'leaf', id: 'leaf-b', threadId: 'thread-b' },
      };
    }

    type FocusSet = { id: string; index: number; name: string; key: string; threadIds: string[] };

    function compileModeHelpers(
      layout: Layout,
      extras: Record<string, unknown> = {},
      sets: FocusSet[] = [],
    ) {
      const factory = Function(
        'PsychePanes', 'activePaneLayout', 'paneLayoutFor', 'state',
        'focusThread', 'renderPaneWorkspace', 'seedSets',
        `"use strict";
         var SPAN_ORIENTATION = { column: "row", row: "column" };
         var focusSets = seedSets;
         var findFocusSet = ${functionSource('findFocusSet')};
         var scopedPaneRoot = ${functionSource('scopedPaneRoot')};
         var spanSignature = ${functionSource('spanSignature')};
         var effectivePaneRoot = ${functionSource('effectivePaneRoot')};
         var paneLayoutForThread = ${functionSource('paneLayoutForThread')};
         var cyclePaneSpan = ${functionSource('cyclePaneSpan')};
         var togglePaneMaximize = ${functionSource('togglePaneMaximize')};
         var exitPaneMaximize = ${functionSource('exitPaneMaximize')};
         return { effectivePaneRoot, scopedPaneRoot, cyclePaneSpan, togglePaneMaximize,
                  exitPaneMaximize };`,
      );
      return factory(
        PsychePanes,
        () => layout,
        () => layout,
        { activeThreadId: 'thread-a', ...(extras.state as object ?? {}) },
        extras.focusThread ?? (() => undefined),
        extras.renderPaneWorkspace ?? (() => undefined),
        sets,
      ) as {
        effectivePaneRoot: (value: Layout) => Record<string, unknown> | null;
        scopedPaneRoot: (value: Layout) => Record<string, unknown> | null;
        cyclePaneSpan: (thread: { id: string }) => void;
        togglePaneMaximize: (thread: { id: string }) => void;
        exitPaneMaximize: () => boolean;
      };
    }

    it('resolves the recorded return pane, then focused pane, then first pane', () => {
      const layout: Layout = { root: tree(), focusedLeafId: 'leaf-b' };
      const threads = new Map([
        ['thread-a', {
          id: 'thread-a', projectId: 'project', worktreePath: '/repo', hidden: false,
        }],
        ['thread-b', {
          id: 'thread-b', projectId: 'project', worktreePath: '/repo', hidden: false,
        }],
      ]);
      const project = { id: 'project' };
      const fileFocusThreadIsAvailable = compileFunction<
        (
          thread: Record<string, unknown> | null,
          root: Record<string, unknown>,
          value: typeof project,
          workspaceRoot: string,
        ) => boolean
      >(functionSource('fileFocusThreadIsAvailable'), { PsychePanes });
      const resolveFileFocusThreadId = compileFunction<
        (preferredId?: string | null) => string | null
      >(functionSource('resolveFileFocusThreadId'), {
        activeProject: () => project,
        activeWorkspaceRoot: () => '/repo',
        activePaneLayout: () => layout,
        scopedPaneRoot: (value: Layout) => value.root,
        findThread: (id: string) => threads.get(id) || null,
        PsychePanes,
        fileFocusThreadIsAvailable,
      });

      expect(resolveFileFocusThreadId('thread-a')).toBe('thread-a');
      threads.get('thread-a')!.hidden = true;
      expect(resolveFileFocusThreadId('thread-a')).toBe('thread-b');
      layout.focusedLeafId = 'leaf-missing';
      expect(resolveFileFocusThreadId('thread-a')).toBe('thread-b');
      threads.get('thread-b')!.hidden = true;
      expect(resolveFileFocusThreadId('thread-a')).toBeNull();
    });

    it('lists the active file before pane entries in the minimap helper', () => {
      const threads = new Map([
        ['thread-a', { id: 'thread-a', name: 'Agent', status: 'running' }],
        [
          'thread-b',
          {
            id: 'thread-b',
            name: 'Tests',
            status: 'running',
            needsAttention: true,
            attentionReason: 'waiting-on-user',
          },
        ],
      ]);
      const layout: Layout = {
        root: PsychePanes.insertBelow(
          PsychePanes.createLeaf('leaf-a', 'thread-a'),
          'leaf-a',
          PsychePanes.createLeaf('leaf-b', 'thread-b'),
          'split-a',
        ),
        focusedLeafId: 'leaf-a',
      };
      const paneMinimapItems = compileFunction<
        (value: Layout, activeFile: { id: string; name: string; rel: string } | null) => Array<unknown>
      >(functionSource('paneMinimapItems'), {
        scopedPaneRoot: (value: Layout) => value.root,
        PsychePanes,
        findThread: (id: string) => threads.get(id) || null,
        PsycheSessions: { attentionLabel: () => 'Waiting for you' },
      });

      expect(paneMinimapItems(layout, {
        id: 'file-a',
        name: 'Button.tsx',
        rel: 'src/Button.tsx',
      })).toEqual([
        {
          kind: 'file',
          id: 'file-a',
          label: 'Button.tsx',
          detail: 'src/Button.tsx',
          current: true,
          thread: null,
        },
        {
          kind: 'pane',
          id: 'thread-a',
          label: 'Agent',
          detail: 'running',
          current: false,
          thread: threads.get('thread-a'),
        },
        {
          kind: 'pane',
          id: 'thread-b',
          label: 'Tests',
          detail: 'running · Waiting for you',
          current: false,
          thread: threads.get('thread-b'),
        },
      ]);
    });

      it('cycles tiled → full column → full row → tiled without editing the tiled tree', () => {
        const layout: Layout = { root: tree(), focusedLeafId: 'leaf-a' };
        const snapshot = JSON.stringify(layout.root);
        const helpers = compileModeHelpers(layout);

      expect(helpers.effectivePaneRoot(layout)).toBe(layout.root);

      helpers.cyclePaneSpan({ id: 'thread-a' });
      expect(layout.spanMode).toBe('column');
      // Mode "column" means the pane gets a column, so the top split runs across.
      expect(helpers.effectivePaneRoot(layout)).toMatchObject({ orientation: 'row' });

      helpers.cyclePaneSpan({ id: 'thread-a' });
      expect(layout.spanMode).toBe('row');
      expect(helpers.effectivePaneRoot(layout)).toMatchObject({ orientation: 'column' });

      helpers.cyclePaneSpan({ id: 'thread-a' });
      expect(layout.spanMode).toBeNull();
      expect(helpers.effectivePaneRoot(layout)).toBe(layout.root);
      expect(JSON.stringify(layout.root)).toBe(snapshot);
    });

    it('restarts the cycle when a different pane is spanned', () => {
      const layout: Layout = { root: tree(), focusedLeafId: 'leaf-a' };
      const helpers = compileModeHelpers(layout, { state: { activeThreadId: 'thread-a' } });

      helpers.cyclePaneSpan({ id: 'thread-a' });
      helpers.cyclePaneSpan({ id: 'thread-a' });
      expect(layout.spanMode).toBe('row');

      // Spanning a different pane starts from the first mode again rather than
      // inheriting where the previous pane had got to — otherwise one click on
      // a fresh pane could land it straight back in tiled.
      helpers.cyclePaneSpan({ id: 'thread-b' });
      expect(layout.spanMode).toBe('column');
      expect(layout.focusedLeafId).toBe('leaf-b');
    });

    it('caches the derived tree until membership or the spanned pane changes', () => {
      const layout: Layout = { root: tree(), focusedLeafId: 'leaf-a', spanMode: 'column' };
      const helpers = compileModeHelpers(layout);

      const first = helpers.effectivePaneRoot(layout);
      // Same inputs: the same object, so a divider drag on it survives a render.
      expect(helpers.effectivePaneRoot(layout)).toBe(first);

      layout.focusedLeafId = 'leaf-b';
      expect(helpers.effectivePaneRoot(layout)).not.toBe(first);
    });

    it('renders only the maximised pane and restores the tiling on exit', () => {
      const layout: Layout = { root: tree(), focusedLeafId: 'leaf-a' };
      const helpers = compileModeHelpers(layout);

      helpers.togglePaneMaximize({ id: 'thread-b' });
      expect(layout.maximizedLeafId).toBe('leaf-b');
      const maximized = helpers.effectivePaneRoot(layout) as unknown as Leaf;
      expect(maximized.type).toBe('leaf');
      expect(maximized.threadId).toBe('thread-b');

      expect(helpers.exitPaneMaximize()).toBe(true);
      expect(layout.maximizedLeafId).toBeNull();
      expect(helpers.effectivePaneRoot(layout)).toBe(layout.root);
      // Nothing to leave: esc must fall through to the next cascade step.
      expect(helpers.exitPaneMaximize()).toBe(false);
    });

    it('drops a maximised pane that is no longer in the tree', () => {
      const layout: Layout = {
        root: tree(), focusedLeafId: 'leaf-a', maximizedLeafId: 'leaf-gone',
      };
      const helpers = compileModeHelpers(layout);

      expect(helpers.effectivePaneRoot(layout)).toBe(layout.root);
      expect(layout.maximizedLeafId).toBeNull();
    });

    it('maximising wins over spanning, so focus mode is always one pane', () => {
      const layout: Layout = {
        root: tree(), focusedLeafId: 'leaf-a', spanMode: 'column', maximizedLeafId: 'leaf-a',
      };
      const helpers = compileModeHelpers(layout);

      expect((helpers.effectivePaneRoot(layout) as unknown as Leaf).type).toBe('leaf');
    });

    it('resizes the derived tree while spanning so visible dividers move', () => {
      expect(functionSource('updateActiveSplit'))
        .toMatch(/var spanning = Boolean\(layout\.spanMode\)[\s\S]*if \(spanning\) layout\.spanRoot = nextRoot;/);
    });

    describe('focus-set scoping', () => {
      const set = (threadIds: string[]): FocusSet => ({
        id: 'set-1', index: 1, name: 'Set 1', key: 'k', threadIds,
      });

      it('draws only the set\'s panes without editing the tiling', () => {
        const layout: Layout = { root: tree(), focusedLeafId: 'leaf-a', activeSetId: 'set-1' };
        const snapshot = JSON.stringify(layout.root);
        const helpers = compileModeHelpers(layout, {}, [set(['thread-b'])]);

        const scoped = helpers.effectivePaneRoot(layout) as unknown as Leaf;
        expect(scoped.type).toBe('leaf');
        expect(scoped.threadId).toBe('thread-b');
        expect(JSON.stringify(layout.root)).toBe(snapshot);
      });

      it('stops scoping when the set has lost every pane', () => {
        const layout: Layout = { root: tree(), focusedLeafId: 'leaf-a', activeSetId: 'set-1' };
        const helpers = compileModeHelpers(layout, {}, [set([])]);

        expect(helpers.effectivePaneRoot(layout)).toBe(layout.root);
        expect(layout.activeSetId).toBeNull();
      });

      it('stops scoping when the set names panes that are no longer tiled', () => {
        const layout: Layout = { root: tree(), focusedLeafId: 'leaf-a', activeSetId: 'set-1' };
        const helpers = compileModeHelpers(layout, {}, [set(['thread-gone'])]);

        expect(helpers.effectivePaneRoot(layout)).toBe(layout.root);
        expect(layout.activeSetId).toBeNull();
      });

      it('ignores an activeSetId that names no set at all', () => {
        const layout: Layout = { root: tree(), focusedLeafId: 'leaf-a', activeSetId: 'ghost' };
        const helpers = compileModeHelpers(layout, {}, []);

        expect(helpers.effectivePaneRoot(layout)).toBe(layout.root);
        expect(layout.activeSetId).toBeNull();
      });

      it('spans within the set, not around it', () => {
        // Three panes, two of them in the set: spanning inside the set must
        // stack only the set's other member beside the spanned pane.
        const root = PsychePanes.insertBelow(
          tree(), 'leaf-b', PsychePanes.createLeaf('leaf-c', 'thread-c'), 'split-2',
        );
        const layout: Layout = {
          root, focusedLeafId: 'leaf-a', spanMode: 'column', activeSetId: 'set-1',
        };
        const helpers = compileModeHelpers(layout, {}, [set(['thread-a', 'thread-c'])]);

        const spanned = helpers.effectivePaneRoot(layout);
        expect(PsychePanes.leafIds(spanned)).toEqual(['leaf-a', 'leaf-c']);
      });

      it('keeps focus mode above scoping — one pane means one pane', () => {
        const layout: Layout = {
          root: tree(), focusedLeafId: 'leaf-a', activeSetId: 'set-1', maximizedLeafId: 'leaf-a',
        };
        const helpers = compileModeHelpers(layout, {}, [set(['thread-b'])]);

        const shown = helpers.effectivePaneRoot(layout) as unknown as Leaf;
        expect(shown.threadId).toBe('thread-a');
      });
    });
  });

  describe('pane frame', () => {
    it('gives terminal headers six tracks and web/tool panes their own five-track override', () => {
      expect(stylesCss).toMatch(
        /\.terminal-pane-header\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto auto auto;/s,
      );
      expect(stylesCss).toMatch(
        /\.terminal-pane:is\(\.is-web,\s*\.is-tool\)\s+\.terminal-pane-header\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto auto;/s,
      );
      expect(functionSource('mountTerminal')).toMatch(
        /header\.appendChild\(glyph\);[\s\S]*header\.appendChild\(label\);[\s\S]*header\.appendChild\(attention\);[\s\S]*header\.appendChild\(span\);[\s\S]*header\.appendChild\(maximize\);[\s\S]*header\.appendChild\(close\)/,
      );
    });

    it('degrades on its own width rather than the window\'s', () => {
      expect(stylesCss).toMatch(/\.terminal-pane\s*\{[^}]*container-type:\s*inline-size;[^}]*container-name:\s*pane;/s);
      expect(stylesCss).toMatch(/@container pane \(max-width: 460px\)\s*\{\s*\.terminal-pane-meta\s*\{\s*display:\s*none;/);
      expect(stylesCss).toMatch(/@container pane \(max-width: 300px\)/);
    });

    it('keeps the CSS pane floor and the tree\'s minimums in agreement', () => {
      expect(stylesCss).toMatch(/--pane-min-w:\s*200px;/);
      expect(stylesCss).toMatch(/--pane-min-h:\s*137px;/);
      expect(stylesCss).toMatch(/\.terminal-pane\s*\{[^}]*min-width:\s*var\(--pane-min-w\);[^}]*min-height:\s*var\(--pane-min-h\);/s);
    });

    it('renders exception status as pane glow instead of a header status chip', () => {
      expect(functionSource('mountTerminal')).not.toContain('terminal-pane-status');
      expect(functionSource('mountBrowserPane')).not.toContain('terminal-pane-status');
      expect(functionSource('mountToolPane')).not.toContain('terminal-pane-status');
      expect(stylesCss).not.toMatch(/\.terminal-pane-status\b/);
      expect(stylesCss).toMatch(
        /\.terminal-pane\[data-status="starting"\]\s*\{\s*--pane-status-rgb:\s*251,\s*191,\s*36;\s*\}/,
      );
      expect(stylesCss).toMatch(
        /\.terminal-pane\[data-status="failed"\]\s*\{\s*--pane-status-rgb:\s*248,\s*113,\s*113;\s*\}/,
      );
      expect(stylesCss).toMatch(
        /\.terminal-pane\[data-status="exited"\]\s*\{\s*--pane-status-rgb:\s*138,\s*132,\s*153;\s*\}/,
      );
      expect(stylesCss).not.toMatch(/\[data-status="running"\]/);
      expect(stylesCss).toMatch(
        /\.terminal-pane:is\(\[data-status="starting"\], \[data-status="failed"\], \[data-status="exited"\]\):not\(\.needs-attention\)\s*\{[^}]*box-shadow:\s*0 0 0 1px rgba\(var\(--pane-status-rgb\), 0\.2\),\s*0 0 12px rgba\(var\(--pane-status-rgb\), 0\.24\);/s,
      );
      expect(stylesCss).toMatch(
        /\.terminal-pane\.focused:is\(\[data-status="starting"\], \[data-status="failed"\], \[data-status="exited"\]\):not\(\.needs-attention\)\s*\{[^}]*border-color:\s*rgba\(var\(--rgb-accent\), 0\.55\);[^}]*box-shadow:\s*0 0 0 1px rgba\(var\(--rgb-accent\), 0\.22\),\s*0 0 12px rgba\(var\(--pane-status-rgb\), 0\.24\);/s,
      );
      expect(stylesCss).not.toMatch(
        /\.terminal-pane:is\(\[data-status="starting"\], \[data-status="failed"\], \[data-status="exited"\]\):not\(\.needs-attention\)\s*\{[^}]*animation:/s,
      );
      expect(stylesCss).not.toMatch(
        /\.terminal-pane\.focused:is\(\[data-status="starting"\], \[data-status="failed"\], \[data-status="exited"\]\):not\(\.needs-attention\)\s*\{[^}]*animation:/s,
      );
    });

    it('renders a tiled status glow through its branch without leaking pane content', async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({
          viewport: { width: 500, height: 220 },
          deviceScaleFactor: 1,
        });
        await page.setContent(`
          <style>${stylesCss}</style>
          <style>
            html, body {
              margin: 0;
              background: rgb(0, 0, 0) !important;
            }
            #probe-stage {
              width: 406px;
              height: 137px;
              margin: 40px;
            }
            #probe-stage > .terminal-pane-split {
              width: 100%;
              height: 100%;
            }
            #probe-stage .terminal-pane {
              background: rgb(0, 0, 0);
            }
          </style>
          <div id="probe-stage"></div>
        `);

        await page.evaluate((renderSource) => {
          const browserDocument = (globalThis as any).document;
          const makePane = (id: string, status: string) => {
            const pane = browserDocument.createElement('div');
            pane.className = 'terminal-pane';
            pane.dataset.threadId = id;
            pane.dataset.status = status;
            return pane;
          };
          const firstPane = makePane('thread-failed', 'failed');
          const leakProbe = browserDocument.createElement('div');
          Object.assign(leakProbe.style, {
            position: 'absolute',
            top: '50px',
            right: '-6px',
            width: '6px',
            height: '20px',
            background: 'rgb(0, 255, 0)',
          });
          firstPane.appendChild(leakProbe);

          const threads = new Map([
            ['thread-failed', { kind: 'term', pane: firstPane }],
            ['thread-running', { kind: 'term', pane: makePane('thread-running', 'running') }],
          ]);
          const findThread = (id: string) => threads.get(id);
          const browserSurface = null;
          const gitSurfaceEl = null;
          const createPaneDivider = () => {
            const divider = browserDocument.createElement('div');
            divider.className = 'terminal-pane-divider is-row';
            return divider;
          };
          const renderPaneNode = eval(`(${renderSource})`);
          const root = {
            id: 'split-a',
            type: 'split',
            orientation: 'row',
            ratio: 0.5,
            first: { id: 'leaf-a', type: 'leaf', threadId: 'thread-failed' },
            second: { id: 'leaf-b', type: 'leaf', threadId: 'thread-running' },
          };
          browserDocument.getElementById('probe-stage')?.appendChild(
            renderPaneNode(root, new Map([['split-a', 0.5]])),
          );
        }, functionSource('renderPaneNode'));

        const branchOverflow = await page.locator('.terminal-pane-branch').first().evaluate(
          (branch) => (globalThis as any).getComputedStyle(branch).overflow as string,
        );
        const paneOverflow = await page.locator('.terminal-pane[data-status="failed"]').evaluate(
          (pane) => (globalThis as any).getComputedStyle(pane).overflow as string,
        );
        const screenshot = await page.screenshot();
        const pixels = await page.evaluate(async (source) => {
          const browserDocument = (globalThis as any).document;
          const image = new (globalThis as any).Image();
          image.src = source;
          await image.decode();
          const canvas = browserDocument.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('missing canvas context');
          context.drawImage(image, 0, 0);
          return Array.from<number>(
            context.getImageData(241, 90, 4, 20).data as ArrayLike<number>,
          );
        }, `data:image/png;base64,${screenshot.toString('base64')}`);
        const rgba = Array.from(
          { length: pixels.length / 4 },
          (_, index) => pixels.slice(index * 4, index * 4 + 4),
        );
        const strongestRed = rgba.reduce(
          (best, pixel) => (
            pixel[0] - Math.max(pixel[1], pixel[2])
              > best[0] - Math.max(best[1], best[2])
              ? pixel
              : best
          ),
          [0, 0, 0, 0],
        );

        expect(branchOverflow).toBe('visible');
        expect(paneOverflow).toBe('hidden');
        expect(strongestRed[0]).toBeGreaterThan(strongestRed[1] + 4);
        expect(Math.max(...rgba.map((pixel) => pixel[1]))).toBeLessThan(100);
      } finally {
        await browser.close();
      }
    }, 15_000);

    it('double-clicking the header enters focus mode, but not on its buttons', () => {
      expect(functionSource('mountTerminal')).toMatch(
        /header\.addEventListener\("dblclick"[\s\S]*closest\("button"\)\) return;[\s\S]*togglePaneMaximize\(thread\)/,
      );
    });
  });
});
