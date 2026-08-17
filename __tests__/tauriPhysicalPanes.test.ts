import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FrameScheduler } from '../native/desktop/psyche-build-tauri/web/runtime/frame-scheduler';

const repoRoot = process.cwd();
const mainJs = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
);
const stylesCss = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/styles.css'),
  'utf8',
);
const PsychePanes = await import(pathToFileURL(join(
  repoRoot,
  'native/desktop/psyche-build-tauri/web/panes/pane-tree.mjs',
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

function renderPaneWorkspaceCalls(name: string) {
  return (functionSource(name).match(/renderPaneWorkspace\([^;]*\);/g) || [])
    .map((call) => call.replace(/\s+/g, ' '));
}

function cssDeclarations(selector: string) {
  const source = stylesCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const normalizedSelector = selector.replace(/\s+/g, ' ').trim();
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  const declarations = new Map<string, string>();
  let found = false;
  for (const match of source.matchAll(rulePattern)) {
    if (match[1].replace(/\s+/g, ' ').trim() !== normalizedSelector) continue;
    found = true;
    for (const declaration of match[2].split(';').map((item) => item.trim()).filter(Boolean)) {
      const separator = declaration.indexOf(':');
      declarations.set(
        declaration.slice(0, separator).trim(),
        declaration.slice(separator + 1).replace(/\s+/g, ' ').trim(),
      );
    }
  }
  if (found) return declarations;
  throw new Error(`missing CSS rule ${selector}`);
}

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>,
) {
  const resolvedDependencies = {
    createThreadPtyIoQueue: () => ({
      closed: false,
      inputTail: Promise.resolve(),
      pendingInputBytes: 0,
      pendingInputWrites: 0,
      pendingResize: null,
      resizeFlight: null,
    }),
    saveWorkspaceSoon: () => undefined,
    saveWorkspaceNow: async () => true,
    scheduleBrowserBounds: () => undefined,
    isPersistentThread: (thread: Record<string, any>) =>
      ['shell', 'psyche', 'coven-code', 'coven-attach'].includes(thread?.launch?.launchKind),
    nativeSessionRequest: (thread: Record<string, any>) => ({ id: thread.id }),
    invoke: async () => [],
    attachThreadClient: dependencies.spawnPty || (() => Promise.resolve(true)),
    ...dependencies,
  };
  const names = Object.keys(resolvedDependencies);
  const values = Object.values(resolvedDependencies);
  return Function(...names, `"use strict"; return (${source});`)(...values) as T;
}

const spawnPtyRuntimeDeps = {
  attentionTracker: { forget: () => undefined },
  syncThreadAttentionChrome: () => undefined,
  ensureThreadPtyController(thread: Record<string, unknown>) {
    if (thread.terminalController) return thread.terminalController;
    const controller = {
      prepareForPtyStart: () => 1,
      restoreAfterFailedPtyStart: () => undefined,
      adoptRunningPty: () => Promise.resolve(false),
      markPtyStarted: () => Promise.resolve(false),
      stopPtyDelivery: () => undefined,
      dispose: () => undefined,
    };
    thread.terminalController = controller;
    return controller;
  },
};

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

type FocusReportPolicy = 'suppress' | 'allow';
type FocusReportToken = {
  report: string;
  policy: FocusReportPolicy;
};
type PaneFocusThread = {
  id: string;
  kind: string;
  projectId: string;
  worktreePath: string;
  status: string;
  closing?: boolean;
  closeStarted?: boolean;
  hidden?: boolean;
  metricsGeneration?: number;
  metricsRefreshTimer?: number;
  startInFlight?: boolean;
  pane: { id: string } | null;
  host: { contains: (node: unknown) => boolean } | null;
  term: { blur: () => void; focus: () => void; dispose?: () => void } | null;
  terminalController?: {
    blur: () => void;
    focus: () => void;
    dispose?: () => void;
  } | null;
  internalFocusReportTokens?: FocusReportToken[];
};

function compileFocusTokenRuntime() {
  const isTerminalFocusReport = compileFunction<(data: unknown) => boolean>(
    functionSource('isTerminalFocusReport'),
    {},
  );
  const beginTerminalFocusReportToken = compileFunction<(
    thread: PaneFocusThread | null,
    report: string,
    policy: FocusReportPolicy,
  ) => FocusReportToken | null>(functionSource('beginTerminalFocusReportToken'), {
    isTerminalFocusReport,
  });
  const clearTerminalFocusReportToken = compileFunction<(
    thread: PaneFocusThread | null,
    token: FocusReportToken | null,
  ) => void>(functionSource('clearTerminalFocusReportToken'), {});
  const consumeTerminalFocusReportToken = compileFunction<(
    thread: PaneFocusThread | null,
    report: string,
  ) => FocusReportToken | null>(functionSource('consumeTerminalFocusReportToken'), {
    clearTerminalFocusReportToken,
  });
  const shouldSuppressTerminalData = compileFunction<(
    thread: PaneFocusThread | null,
    data: unknown,
  ) => boolean>(functionSource('consumeTerminalDataSuppression'), {
    isTerminalFocusReport,
    consumeTerminalFocusReportToken,
  });
  const withTerminalFocusReportToken = compileFunction<(<T>(
    thread: PaneFocusThread | null,
    report: string,
    policy: FocusReportPolicy,
    action: () => T,
  ) => T)>(functionSource('withTerminalFocusReportToken'), {
    beginTerminalFocusReportToken,
    clearTerminalFocusReportToken,
  });

  return {
    isTerminalFocusReport,
    beginTerminalFocusReportToken,
    clearTerminalFocusReportToken,
    shouldSuppressTerminalData,
    withTerminalFocusReportToken,
  };
}

function createPaneFocusHarness(
  threads: PaneFocusThread[],
  activeThreadId: string,
  activeElement: unknown = null,
) {
  threads.forEach((thread) => {
    if (thread.terminalController) return;
    thread.terminalController = {
      blur: () => thread.term?.blur(),
      focus: () => thread.term?.focus(),
      dispose: () => thread.term?.dispose?.(),
    };
  });
  const tokens = compileFocusTokenRuntime();
  const queued: Array<() => void> = [];
  const documentRef = { activeElement };
  const state = {
    activeProjectId: 'project-a',
    activeThreadId,
    activeFileId: null as string | null,
    threads,
  };
  const project = {
    id: 'project-a',
    root: '/repo',
    lastActiveThreadId: activeThreadId as string | null,
    selectedWorktreePath: '/repo' as string | null,
  };
  const attachedPanes = new Set(
    threads.map((thread) => thread.pane).filter((pane) => pane !== null),
  );
  const terminalHost = {
    hidden: false,
    contains: (pane: unknown) => attachedPanes.has(pane as { id: string }),
    replaceChildren: () => undefined,
    appendChild: () => undefined,
  };
  const requestAnimationFrame = (callback: () => void) => {
    queued.push(callback);
    return queued.length;
  };
  const isLiveThread = (thread: PaneFocusThread | null) => (
    Boolean(thread) && !thread?.closing && state.threads.includes(thread as PaneFocusThread)
  );
  const focusedTerminalThreadForRender = compileFunction<
    () => PaneFocusThread | null
  >(functionSource('focusedTerminalThreadForRender'), {
    document: documentRef,
    state,
  });
  const restoreRenderedTerminalFocus = compileFunction<(
    thread: PaneFocusThread | null,
  ) => void>(functionSource('restoreRenderedTerminalFocus'), {
    requestAnimationFrame,
    isLiveThread,
    state,
    terminalHost,
    withTerminalFocusReportToken: tokens.withTerminalFocusReportToken,
  });
  const renderPaneWorkspace = compileFunction<(
    options?: {
      focusTargetThread?: PaneFocusThread | null;
      preserveTerminalFocus?: boolean;
    },
  ) => void>(functionSource('renderPaneWorkspace'), {
    terminalHost,
    focusedTerminalThreadForRender,
    withTerminalFocusReportToken: tokens.withTerminalFocusReportToken,
    stageBrowserSurface: () => undefined,
    stageGitSurface: () => undefined,
    activePaneLayout: () => null,
    renderTerminalEmptyState: () => undefined,
    renderPaneMinimap: () => undefined,
    filesPaneHasCanvasFocus: () => false,
    findOpenFile: () => null,
    state,
    restoreRenderedTerminalFocus,
    syncAllPtyVisibility: () => undefined,
  });
  const focusThread = compileFunction<(
    id: string,
    options?: { refreshStatus?: boolean },
  ) => Promise<boolean>>(functionSource('focusThread'), {
    findThread: (id: string) => state.threads.find((thread) => thread.id === id) || null,
    showTerminalView: async () => true,
    focusedTerminalThreadForRender,
    markActiveSurface: () => undefined,
    state,
    findProject: (id: string) => id === project.id ? project : null,
    activeWorkspaceRoot: (value: typeof project) => value.selectedWorktreePath,
    paneLayoutFor: () => null,
    PsychePanes: { findLeafByThreadId: () => null },
    withTerminalFocusReportToken: tokens.withTerminalFocusReportToken,
    renderPaneWorkspace,
    renderGitSurface: () => false,
    refreshSidebar: () => undefined,
    requestAnimationFrame,
    scheduleTerminalPaneFits: () => undefined,
    isLiveThread,
    terminalHost,
    syncBrowserBounds: () => undefined,
    setProjectStatus: () => undefined,
    statusLevel: () => 'ok',
    refreshStatusController: () => undefined,
  });

  return {
    ...tokens,
    attachedPanes,
    documentRef,
    focusThread,
    focusedTerminalThreadForRender,
    project,
    queued,
    renderPaneWorkspace,
    state,
    terminalHost,
  };
}

describe('Tauri physical terminal panes', () => {
  it('keeps one canonical terminal controller reference per pane', () => {
    expect(mainJs).not.toContain('ptyClient');
  });

  it('bounds and serializes PTY input while delegating resize ownership', () => {
    const send = functionSource('sendToThread');
    const mount = functionSource('mountTerminal');

    expect(mainJs).toContain('var MAX_PENDING_PTY_INPUT_BYTES = 1024 * 1024;');
    expect(mainJs).toContain('var MAX_PENDING_PTY_INPUT_WRITES = 256;');
    expect(send).toContain('pendingBytes + encoded.length > MAX_PENDING_PTY_INPUT_BYTES');
    expect(send).toContain('pendingWrites >= MAX_PENDING_PTY_INPUT_WRITES');
    expect(send).toContain('var previous = queue.inputTail;');
    expect(send).toContain('queue.inputTail = result.then');
    expect(mainJs).not.toContain('function scheduleThreadPtyResize(');
    expect(mount).toContain('PsycheRuntime.createTerminalPaneController({');
    expect(mount).not.toContain('invoke("pty_resize"');
  });

  it('quarantines queued input across PTY exit and restart', async () => {
    const handleExit = functionSource('handlePtyExit');
    expect(handleExit).toContain('thread.ptyIoQueue.closed = true;');
    expect(handleExit).toContain('thread.ptyIoQueue = {');
    const firstWrite = deferred<void>();
    const calls: number[][] = [];
    const createThreadPtyIoQueue = compileFunction<() => Record<string, unknown>>(
      functionSource('createThreadPtyIoQueue'),
      {},
    );
    const resetThreadPtyIoQueue = (thread: Record<string, unknown>) => {
      (thread.ptyIoQueue as { closed: boolean }).closed = true;
      thread.ptyIoQueue = createThreadPtyIoQueue();
    };
    const sendToThread = compileFunction<(
      thread: Record<string, unknown>, text: string,
    ) => Promise<boolean>>(functionSource('sendToThread'), {
      createThreadPtyIoQueue,
      MAX_PENDING_PTY_INPUT_BYTES: 1024 * 1024,
      MAX_PENDING_PTY_INPUT_WRITES: 256,
      noteThreadInput: () => undefined,
      invoke: (_command: string, args: { bytes: number[] }) => {
        calls.push(args.bytes);
        return calls.length === 1 ? firstWrite.promise : Promise.resolve();
      },
    });
    const thread = {
      id: 'thread-a', kind: 'shell', term: null,
      ptyIoQueue: createThreadPtyIoQueue(),
    };

    const oldFirst = sendToThread(thread, 'a');
    const oldQueued = sendToThread(thread, 'b');
    await Promise.resolve();
    expect(calls).toEqual([[97]]);

    resetThreadPtyIoQueue(thread);
    await expect(sendToThread(thread, 'c')).resolves.toBe(true);
    expect(calls).toEqual([[97], [99]]);

    firstWrite.resolve();
    await expect(oldFirst).resolves.toBe(true);
    await expect(oldQueued).resolves.toBe(false);
    expect(calls).toEqual([[97], [99]]);
  });

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

  it('accumulates repeated divider keys before one coalesced pane-tree frame', () => {
    const leafA = PsychePanes.createLeaf('leaf-a', 'thread-a');
    const leafB = PsychePanes.createLeaf('leaf-b', 'thread-b');
    const layout = {
      root: PsychePanes.insertBelow(leafA, 'leaf-a', leafB, 'split-a'),
      focusedLeafId: 'leaf-a',
    };
    const frames: Array<(timestamp: number) => void> = [];
    const scheduler = new FrameScheduler((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const renderPaneWorkspace = vi.fn();
    const focusPaneDivider = vi.fn(() => true);
    const saveWorkspaceSoon = vi.fn();
    const schedulePaneTreeLayout = compileFunction<(
      focusSplitId?: string | null,
    ) => void>(functionSource('schedulePaneTreeLayout'), {
      pendingPaneDividerFocusId: null,
      terminalFrameScheduler: scheduler,
      renderPaneWorkspace,
      focusPaneDivider,
      saveWorkspaceSoon,
    });
    const updateActiveSplit = compileFunction<(
      splitId: string,
      ratio: number,
      expectedLayout?: typeof layout,
      restoreFocus?: boolean,
    ) => boolean>(functionSource('updateActiveSplit'), {
      activePaneLayout: () => layout,
      PsychePanes,
      schedulePaneTreeLayout,
    });
    const divider = new FakeEventTarget();
    const createPaneDivider = compileFunction<(
      node: typeof layout.root,
      ratio: number,
    ) => FakeEventTarget>(functionSource('createPaneDivider'), {
      document: { createElement: () => divider },
      window: new FakeEventTarget(),
      activePaneLayout: () => layout,
      updateActiveSplit,
    });
    createPaneDivider(layout.root, layout.root.ratio);

    divider.dispatch('keydown', {
      key: 'ArrowDown', shiftKey: false, preventDefault: () => undefined,
    });
    divider.dispatch('keydown', {
      key: 'ArrowDown', shiftKey: false, preventDefault: () => undefined,
    });

    expect(layout.root.ratio).toBeCloseTo(0.58);
    expect(frames).toHaveLength(1);
    expect(renderPaneWorkspace).not.toHaveBeenCalled();

    frames.shift()!(16);
    expect(renderPaneWorkspace).toHaveBeenCalledTimes(1);
    expect(focusPaneDivider).toHaveBeenCalledOnce();
    expect(focusPaneDivider).toHaveBeenCalledWith('split-a');
    expect(saveWorkspaceSoon).toHaveBeenCalledTimes(1);
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
        schedulePaneTreeLayout: (splitId: string | null) => {
          renders += 1;
          if (splitId) focusPaneDivider(splitId);
        },
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

  it('delegates visible pane fitting to each keyed controller', () => {
    expect(mainJs).not.toMatch(/var visiblePaneFitFrame = 0;/);
    expect(mainJs).not.toMatch(/fitActiveTerm/);
    const fits: string[] = [];
    const scheduleTerminalPaneFits = compileFunction<() => void>(
      functionSource('scheduleTerminalPaneFits'),
      {
        state: {
          threads: [
            { terminalController: { scheduleFit: () => fits.push('thread-a') } },
            { terminalController: null },
            { terminalController: { scheduleFit: () => fits.push('thread-c') } },
          ],
        },
      },
    );
    scheduleTerminalPaneFits();
    expect(fits).toEqual(['thread-a', 'thread-c']);
  });

  it('keeps pane topology process-local and keys it by project and worktree', () => {
    expect(mainJs).toMatch(/var paneLayouts = new Map\(\);/);
    expect(mainJs).toMatch(/var paneCounter = 0n;/);
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
    expect(createThread).not.toMatch(/internalPaneRenderDepth/);
    expect(mainJs).not.toMatch(
      /internalPaneRenderDepth|beginPaneRenderFocusSuppression|endPaneRenderFocusSuppression/,
    );
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
    expect(mountTerminal).not.toContain('aria-labelledby');
    expect(mountTerminal).toMatch(/className = "terminal-pane-body"/);
    expect(mountTerminal).toMatch(/className = "term-instance"/);
    expect(mountTerminal).toMatch(/title = "Stop and close terminal"/);
    expect(mountTerminal).toMatch(/"Stop and close " \+ thread\.name/);
    expect(mountTerminal).toMatch(
      /thread\.pane = pane[\s\S]*thread\.host = container[\s\S]*renderPaneWorkspace\(\{ preserveTerminalFocus: false \}\)/,
    );
    expect(mountTerminal).not.toMatch(/terminalHost\.appendChild\(container\)/);
  });

  it('classifies every pane workspace render by caller intent', () => {
    const transitionOnly = [
      'activateProjectWorktree',
      'setActiveProject',
      'mountToolPane',
      'mountBrowserPane',
      'mountTerminal',
      'reopenThread',
      'hideFilesPane',
      'reopenFilesPane',
      'removeProject',
      'returnFromFileFocus',
      'revealFileForDecision',
      'closeFileTab',
    ];
    for (const name of transitionOnly) {
      expect(renderPaneWorkspaceCalls(name), name).toEqual([
        'renderPaneWorkspace({ preserveTerminalFocus: false });',
      ]);
    }

    const preserveOnly = [
      'movePaneTo',
      'schedulePaneTreeLayout',
      'restoreSetScopePresentation',
      'cyclePaneSpan',
      'togglePaneMaximize',
      'exitPaneMaximize',
      'refreshSidebar',
      'removeFilesPaneNow',
      'activateFileTabNow',
    ];
    for (const name of preserveOnly) {
      expect(renderPaneWorkspaceCalls(name), name).toEqual([
        'renderPaneWorkspace();',
      ]);
    }

    expect(renderPaneWorkspaceCalls('focusThread')).toEqual([
      'renderPaneWorkspace({ focusTargetThread: thread });',
    ]);
    expect(renderPaneWorkspaceCalls('closeToolPane')).toEqual([]);
    expect(renderPaneWorkspaceCalls('closeThread')).toEqual([
      'renderPaneWorkspace({ preserveTerminalFocus: false });',
      'renderPaneWorkspace();',
      'renderPaneWorkspace({ preserveTerminalFocus: false });',
      'renderPaneWorkspace({ preserveTerminalFocus: false });',
      'renderPaneWorkspace();',
    ]);
    expect(renderPaneWorkspaceCalls('hideThread')).toEqual([
      'renderPaneWorkspace({ preserveTerminalFocus: false });',
      'renderPaneWorkspace();',
    ]);

    const expectedCallCount =
      transitionOnly.length + preserveOnly.length + 1 + 5 + 2 + 1 + 1;
    expect((mainJs.match(/renderPaneWorkspace\(/g) || []).length - 1).toBe(
      expectedCallCount,
    );

    const createThread = functionSource('createThread');
    expect(createThread.indexOf('mountTerminal(thread)')).toBeLessThan(
      createThread.indexOf('refreshSidebar()'),
    );
    expect(functionSource('removeProject')).toMatch(
      /var preserveTerminalFocus = state\.activeProjectId !== id;[\s\S]*closeThread\(tid, \{\s*focus: false,\s*preserveTerminalFocus: preserveTerminalFocus,\s*\}\)/,
    );
  });

  it('uses exact one-shot focus report tokens with independent identities', () => {
    const runtime = compileFocusTokenRuntime();
    const thread: PaneFocusThread = {
      id: 'thread-token',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      pane: null,
      host: null,
      term: null,
    };

    expect(runtime.isTerminalFocusReport('\x1b[I')).toBe(true);
    expect(runtime.isTerminalFocusReport('\x1b[O')).toBe(true);
    expect(runtime.isTerminalFocusReport('\x1b[I\x1b[O')).toBe(false);
    expect(runtime.isTerminalFocusReport('\x1b[Iordinary text')).toBe(false);
    expect(runtime.isTerminalFocusReport(new Uint8Array([0x1b, 0x5b, 0x49]))).toBe(false);
    expect(runtime.shouldSuppressTerminalData(thread, '\x1b[I')).toBe(false);

    runtime.withTerminalFocusReportToken(thread, '\x1b[O', 'suppress', () => {
      expect(runtime.shouldSuppressTerminalData(thread, '\x1b[O')).toBe(true);
      expect(runtime.shouldSuppressTerminalData(thread, '\x1b[O')).toBe(false);
    });

    runtime.withTerminalFocusReportToken(thread, '\x1b[I', 'suppress', () => {
      expect(runtime.shouldSuppressTerminalData(thread, '\x1b[Iordinary text')).toBe(false);
      expect(runtime.shouldSuppressTerminalData(thread, '\x1b[I\x1b[O')).toBe(false);
      expect(runtime.shouldSuppressTerminalData(thread, '\x1b[I')).toBe(true);
    });

    runtime.withTerminalFocusReportToken(thread, '\x1b[I', 'suppress', () => {
      runtime.withTerminalFocusReportToken(thread, '\x1b[I', 'allow', () => {
        expect(runtime.shouldSuppressTerminalData(thread, '\x1b[I')).toBe(false);
      });
      expect(runtime.shouldSuppressTerminalData(thread, '\x1b[I')).toBe(true);
    });

    const suppress = runtime.beginTerminalFocusReportToken(
      thread, '\x1b[O', 'suppress',
    );
    const allow = runtime.beginTerminalFocusReportToken(thread, '\x1b[O', 'allow');
    runtime.clearTerminalFocusReportToken(thread, suppress);
    expect(thread.internalFocusReportTokens).toEqual([allow]);
    expect(runtime.shouldSuppressTerminalData(thread, '\x1b[O')).toBe(false);
    expect(thread.internalFocusReportTokens).toBeUndefined();

    expect(runtime.withTerminalFocusReportToken(
      thread, '\x1b[I', 'suppress', () => 42,
    )).toBe(42);
    expect(thread.internalFocusReportTokens).toBeUndefined();
    expect(runtime.shouldSuppressTerminalData(thread, '\x1b[I')).toBe(false);

    const actionError = new Error('focus failed');
    expect(() => runtime.withTerminalFocusReportToken(
      thread,
      '\x1b[I',
      'allow',
      () => { throw actionError; },
    )).toThrow(actionError);
    expect(thread.internalFocusReportTokens).toBeUndefined();
  });

  it('checks focus report tokens before writing xterm input to the PTY', () => {
    const mountTerminal = functionSource('mountTerminal');
    expect(mountTerminal).toMatch(
      /onData: function \(data\) \{\s*routeTerminalData\(thread, data\);\s*\}/,
    );
  });

  it('skips pure rerender focus restoration while the terminal canvas is hidden', () => {
    const thread: PaneFocusThread = {
      id: 'thread-hidden-restore',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      pane: { id: 'pane-hidden-restore' },
      host: { contains: () => false },
      term: { blur: () => undefined, focus: () => { throw new Error('unexpected focus'); } },
    };
    const queued: Array<() => void> = [];
    let tokenCalls = 0;
    let focusCalls = 0;
    const terminalHost = {
      hidden: false,
      contains: () => true,
    };
    const restoreRenderedTerminalFocus = compileFunction<(
      target: PaneFocusThread | null,
    ) => void>(functionSource('restoreRenderedTerminalFocus'), {
      requestAnimationFrame(callback: () => void) {
        queued.push(callback);
      },
      isLiveThread: () => true,
      state: { activeThreadId: thread.id },
      terminalHost,
      withTerminalFocusReportToken: (
        _target: PaneFocusThread | null,
        _report: string,
        _policy: FocusReportPolicy,
        action: () => void,
      ) => {
        tokenCalls += 1;
        return action();
      },
    });
    thread.term = { blur: () => undefined, focus: () => { focusCalls += 1; } };

    restoreRenderedTerminalFocus(thread);
    expect(queued).toHaveLength(1);

    terminalHost.hidden = true;
    queued.shift()?.();

    expect(focusCalls).toBe(0);
    expect(tokenCalls).toBe(0);
    expect(thread.internalFocusReportTokens).toBeUndefined();
  });

  it('suppresses only the synchronous blur and focus reports during a pure rerender', () => {
    const activeElement = { id: 'active-source' };
    const pane = { id: 'pane-source' };
    const thread: PaneFocusThread = {
      id: 'thread-source',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      pane,
      host: { contains: (node: unknown) => node === activeElement },
      term: null,
    };
    const harness = createPaneFocusHarness([thread], thread.id, activeElement);
    const events: string[] = [];
    thread.term = {
      blur: () => {
        events.push(`blur:${harness.shouldSuppressTerminalData(thread, '\x1b[O')}`);
        harness.documentRef.activeElement = null;
      },
      focus: () => {
        events.push(`focus:${harness.shouldSuppressTerminalData(thread, '\x1b[I')}`);
        harness.documentRef.activeElement = activeElement;
      },
    };
    harness.terminalHost.replaceChildren = () => {
      events.push('replace');
    };

    harness.renderPaneWorkspace();
    expect(events).toEqual(['blur:true', 'replace']);
    expect(harness.shouldSuppressTerminalData(thread, '\x1b[O')).toBe(false);
    expect(thread.internalFocusReportTokens).toBeUndefined();
    expect(harness.queued).toHaveLength(1);

    harness.queued.shift()?.();
    expect(events).toEqual(['blur:true', 'replace', 'focus:true']);
    expect(harness.shouldSuppressTerminalData(thread, '\x1b[O')).toBe(false);
    expect(harness.shouldSuppressTerminalData(thread, '\x1b[I')).toBe(false);
    expect(thread.internalFocusReportTokens).toBeUndefined();
  });

  it('keeps refreshSidebar focus-preserving across its workspace rerender', () => {
    const activeElement = { id: 'refresh-source' };
    const thread: PaneFocusThread = {
      id: 'thread-refresh',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      pane: { id: 'pane-refresh' },
      host: { contains: (node: unknown) => node === activeElement },
      term: null,
    };
    const harness = createPaneFocusHarness([thread], thread.id, activeElement);
    const reports: Array<[string, boolean]> = [];
    thread.term = {
      blur: () => {
        reports.push([
          'source-out',
          harness.shouldSuppressTerminalData(thread, '\x1b[O'),
        ]);
        harness.documentRef.activeElement = null;
      },
      focus: () => {
        reports.push([
          'source-in',
          harness.shouldSuppressTerminalData(thread, '\x1b[I'),
        ]);
        harness.documentRef.activeElement = activeElement;
      },
    };
    const refreshSidebar = compileFunction<() => void>(
      functionSource('refreshSidebar'),
      {
        refreshTabs: () => undefined,
        renderSessionList: () => undefined,
        renderPaneWorkspace: harness.renderPaneWorkspace,
        syncComposerChrome: () => undefined,
        syncDaemonStatus: () => undefined,
        syncSessionListScroll: () => undefined,
      },
    );

    refreshSidebar();
    expect(reports).toEqual([['source-out', true]]);
    expect(harness.queued).toHaveLength(1);

    harness.queued.shift()?.();
    expect(reports).toEqual([
      ['source-out', true],
      ['source-in', true],
    ]);
    expect(thread.internalFocusReportTokens).toBeUndefined();
  });

  it('allows source focus-out before creating and explicitly focusing a new pane', async () => {
    const sourceElement = { id: 'creation-source' };
    const targetElement = { id: 'creation-target' };
    const source: PaneFocusThread = {
      id: 'thread-source',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      pane: { id: 'pane-source' },
      host: { contains: (node: unknown) => node === sourceElement },
      term: null,
    };
    const harness = createPaneFocusHarness([source], source.id, sourceElement);
    const reports: Array<[string, boolean]> = [];
    let sourceFocusCalls = 0;
    let target: PaneFocusThread | null = null;
    source.term = {
      blur: () => {
        reports.push([
          'source-out',
          harness.shouldSuppressTerminalData(source, '\x1b[O'),
        ]);
        harness.documentRef.activeElement = null;
      },
      focus: () => {
        sourceFocusCalls += 1;
        harness.documentRef.activeElement = sourceElement;
      },
    };

    const createThread = compileFunction<(
      options: Record<string, unknown>,
    ) => Promise<PaneFocusThread | null>>(functionSource('createThread'), {
      makeThreadId: () => 'thread-target',
      activeProject: () => harness.project,
      activeWorkspaceRoot: () => '/repo',
      preparePanePlacement: () => ({ key: 'layout', value: {} }),
      commitPanePlacement: () => undefined,
      setStatus: () => undefined,
      state: harness.state,
      refreshSidebar: () => harness.renderPaneWorkspace(),
      refreshTabs: () => undefined,
      mountTerminal: (thread: PaneFocusThread) => {
        target = thread;
        const pane = { id: 'pane-target' };
        thread.pane = pane;
        thread.host = { contains: (node: unknown) => node === targetElement };
        thread.term = {
          blur: () => undefined,
          focus: () => {
            reports.push([
              'target-in',
              harness.shouldSuppressTerminalData(thread, '\x1b[I'),
            ]);
            harness.documentRef.activeElement = targetElement;
          },
        };
        thread.terminalController = {
          blur: () => thread.term?.blur(),
          focus: () => thread.term?.focus(),
          dispose: () => thread.term?.dispose?.(),
        };
        harness.attachedPanes.add(pane);
        harness.renderPaneWorkspace({ preserveTerminalFocus: false });
      },
      focusThread: harness.focusThread,
      requestAnimationFrame: (callback: () => void) => {
        harness.queued.push(callback);
        return harness.queued.length;
      },
      isLiveThread: (thread: PaneFocusThread) => (
        !thread.closing && harness.state.threads.includes(thread)
      ),
      spawnPty: () => undefined,
    });

    await expect(createThread({
      project: harness.project,
      command: '/bin/zsh',
      name: 'New pane',
    })).resolves.toBe(target);
    await Promise.resolve();
    await Promise.resolve();
    while (harness.queued.length) harness.queued.shift()?.();

    expect(reports).toEqual([
      ['source-out', false],
      ['target-in', false],
    ]);
    expect(sourceFocusCalls).toBe(0);
    expect(harness.state.activeThreadId).toBe('thread-target');
    expect(source.internalFocusReportTokens).toBeUndefined();
    const createdTarget = target as PaneFocusThread | null;
    expect(createdTarget).not.toBeNull();
    expect(createdTarget?.internalFocusReportTokens).toBeUndefined();
  });

  it('explicitly blurs the focused source and allows both switch reports', async () => {
    const activeElement = { id: 'active-source' };
    const source: PaneFocusThread = {
      id: 'thread-source',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      pane: { id: 'pane-source' },
      host: { contains: (node: unknown) => node === activeElement },
      term: null,
    };
    const target: PaneFocusThread = {
      id: 'thread-target',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      pane: { id: 'pane-target' },
      host: { contains: () => false },
      term: null,
    };
    const harness = createPaneFocusHarness([source, target], source.id, activeElement);
    const events: string[] = [];
    const reports: Array<[string, boolean]> = [];
    source.term = {
      blur: () => {
        events.push(`blur:${harness.state.activeThreadId}`);
        reports.push([
          'source-out',
          harness.shouldSuppressTerminalData(source, '\x1b[O'),
        ]);
        harness.documentRef.activeElement = null;
      },
      focus: () => {
        events.push('unexpected-source-focus');
      },
    };
    target.term = {
      blur: () => {
        events.push('unexpected-target-blur');
      },
      focus: () => {
        events.push('focus:thread-target');
        reports.push([
          'target-in',
          harness.shouldSuppressTerminalData(target, '\x1b[I'),
        ]);
      },
    };
    harness.terminalHost.replaceChildren = () => {
      events.push(`replace:${harness.state.activeThreadId}`);
    };

    await expect(harness.focusThread(target.id)).resolves.toBe(true);
    expect(events).toEqual([
      'blur:thread-source',
      'replace:thread-target',
    ]);
    expect(reports).toEqual([['source-out', false]]);
    expect(harness.shouldSuppressTerminalData(source, '\x1b[O')).toBe(false);
    expect(harness.queued).toHaveLength(1);

    harness.queued.shift()?.();
    expect(events).toEqual([
      'blur:thread-source',
      'replace:thread-target',
      'focus:thread-target',
    ]);
    expect(reports).toEqual([
      ['source-out', false],
      ['target-in', false],
    ]);
    expect(source.internalFocusReportTokens).toBeUndefined();
    expect(target.internalFocusReportTokens).toBeUndefined();
  });

  it('allows explicit focus-out and focus-in when refocusing the current target', async () => {
    const activeElement = { id: 'same-target' };
    const thread: PaneFocusThread = {
      id: 'thread-current',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      pane: { id: 'pane-current' },
      host: { contains: (node: unknown) => node === activeElement },
      term: null,
    };
    const harness = createPaneFocusHarness([thread], thread.id, activeElement);
    const reports: Array<[string, boolean]> = [];
    thread.term = {
      blur: () => {
        reports.push([
          'target-out',
          harness.shouldSuppressTerminalData(thread, '\x1b[O'),
        ]);
        harness.documentRef.activeElement = null;
      },
      focus: () => {
        reports.push([
          'target-in',
          harness.shouldSuppressTerminalData(thread, '\x1b[I'),
        ]);
        harness.documentRef.activeElement = activeElement;
      },
    };

    await expect(harness.focusThread(thread.id)).resolves.toBe(true);
    expect(reports).toEqual([['target-out', false]]);
    expect(harness.queued).toHaveLength(1);

    harness.queued.shift()?.();
    expect(reports).toEqual([
      ['target-out', false],
      ['target-in', false],
    ]);
    expect(thread.internalFocusReportTokens).toBeUndefined();
  });

  it('blurs an active hidden pane before removal and only focuses its validated successor', async () => {
    const sourceElement = { id: 'hide-source' };
    const targetElement = { id: 'hide-target' };
    const source: PaneFocusThread = {
      id: 'thread-hide-source',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      hidden: false,
      metricsGeneration: 0,
      metricsRefreshTimer: 0,
      pane: { id: 'pane-hide-source' },
      host: { contains: (node: unknown) => node === sourceElement },
      term: null,
    };
    const target: PaneFocusThread = {
      id: 'thread-hide-target',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      hidden: false,
      pane: { id: 'pane-hide-target' },
      host: { contains: (node: unknown) => node === targetElement },
      term: null,
    };
    const harness = createPaneFocusHarness(
      [source, target],
      source.id,
      sourceElement,
    );
    const events: string[] = [];
    source.term = {
      blur: () => {
        events.push(
          `source-out:${harness.shouldSuppressTerminalData(source, '\x1b[O')}`,
        );
        harness.documentRef.activeElement = null;
      },
      focus: () => {
        events.push('unexpected-source-focus');
      },
    };
    target.term = {
      blur: () => {
        events.push('unexpected-target-blur');
      },
      focus: () => {
        events.push(
          `target-in:${harness.shouldSuppressTerminalData(target, '\x1b[I')}`,
        );
        harness.documentRef.activeElement = targetElement;
      },
    };

    const key = 'project-a\0/repo';
    const root = PsychePanes.insertBelow(
      PsychePanes.createLeaf('leaf-source', source.id),
      'leaf-source',
      PsychePanes.createLeaf('leaf-target', target.id),
      'split-hide',
    );
    const paneLayouts = new Map([[key, {
      root,
      focusedLeafId: 'leaf-source',
    }]]);
    const detachThreadPaneImpl = compileFunction<(
      thread: PaneFocusThread,
    ) => string | null>(functionSource('detachThreadPane'), {
      focusedTerminalThreadForRender: harness.focusedTerminalThreadForRender,
      withTerminalFocusReportToken: harness.withTerminalFocusReportToken,
      paneLayoutKey: () => key,
      paneLayouts,
      PsychePanes,
    });
    const detachThreadPane = (thread: PaneFocusThread) => {
      const nextThreadId = detachThreadPaneImpl(thread);
      events.push('detach');
      if (thread.pane) harness.attachedPanes.delete(thread.pane);
      harness.documentRef.activeElement = null;
      return nextThreadId;
    };
    const hideThread = compileFunction<(id: string) => boolean>(
      functionSource('hideThread'),
      {
        findThread: (id: string) => (
          harness.state.threads.find((thread) => thread.id === id) || null
        ),
        detachThreadPane,
        retainFileFocusAfterThreadRemoval: () => false,
        state: harness.state,
        focusThread: harness.focusThread,
        renderPaneWorkspace: harness.renderPaneWorkspace,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
      },
    );

    expect(hideThread(source.id)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    while (harness.queued.length) harness.queued.shift()?.();

    expect(events).toEqual([
      'source-out:false',
      'detach',
      'target-in:false',
    ]);
    expect(source.hidden).toBe(true);
    expect(harness.state.activeThreadId).toBe(target.id);
    expect(source.internalFocusReportTokens).toBeUndefined();
    expect(target.internalFocusReportTokens).toBeUndefined();
  });

  it('allows focus-out when closing the active pane without a successor', async () => {
    const sourceElement = { id: 'close-source' };
    const source: PaneFocusThread = {
      id: 'thread-close-source',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      closing: false,
      closeStarted: false,
      metricsGeneration: 0,
      metricsRefreshTimer: 0,
      startInFlight: false,
      pane: { id: 'pane-close-source' },
      host: { contains: (node: unknown) => node === sourceElement },
      term: null,
    };
    const harness = createPaneFocusHarness([source], source.id, sourceElement);
    const events: string[] = [];
    source.term = {
      blur: () => {
        events.push(
          `source-out:${harness.shouldSuppressTerminalData(source, '\x1b[O')}`,
        );
        harness.documentRef.activeElement = null;
      },
      focus: () => {
        events.push('unexpected-source-focus');
      },
      dispose: () => {
        events.push('dispose');
      },
    };

    const key = 'project-a\0/repo';
    const paneLayouts = new Map([[key, {
      root: PsychePanes.createLeaf('leaf-source', source.id),
      focusedLeafId: 'leaf-source',
    }]]);
    const detachThreadPaneImpl = compileFunction<(
      thread: PaneFocusThread,
    ) => string | null>(functionSource('detachThreadPane'), {
      focusedTerminalThreadForRender: harness.focusedTerminalThreadForRender,
      withTerminalFocusReportToken: harness.withTerminalFocusReportToken,
      paneLayoutKey: () => key,
      paneLayouts,
      PsychePanes,
    });
    const closeThread = compileFunction<(id: string) => Promise<boolean>>(
      functionSource('closeThread'),
      {
        forgetThreadInSets: () => undefined,
        findThread: (id: string) => (
          harness.state.threads.find((thread) => thread.id === id) || null
        ),
        detachThreadPane: (thread: PaneFocusThread) => {
          const nextThreadId = detachThreadPaneImpl(thread);
          events.push('detach');
          if (thread.pane) harness.attachedPanes.delete(thread.pane);
          harness.documentRef.activeElement = null;
          return nextThreadId;
        },
        retainFileFocusAfterThreadRemoval: () => false,
        pendingDataBuffers: new Map(),
        stopThreadPty: () => Promise.resolve(true),
        state: harness.state,
        renderPaneWorkspace: harness.renderPaneWorkspace,
        setProjectStatus: () => undefined,
        findProject: () => harness.project,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        focusThread: () => {
          events.push('unexpected-target-focus');
        },
      },
    );

    await expect(closeThread(source.id)).resolves.toBe(true);
    expect(events).toEqual([
      'dispose',
      'source-out:false',
      'detach',
    ]);
    expect(harness.state.activeThreadId).toBeNull();
    expect(harness.queued).toHaveLength(0);
    expect(source.internalFocusReportTokens).toBeUndefined();
  });

  it('allows focus-out without restoring the old worktree layout', async () => {
    const sourceElement = { id: 'worktree-source' };
    const source: PaneFocusThread = {
      id: 'thread-worktree-source',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/old',
      status: 'running',
      pane: { id: 'pane-worktree-source' },
      host: { contains: (node: unknown) => node === sourceElement },
      term: null,
    };
    const target: PaneFocusThread = {
      id: 'thread-worktree-target',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/target',
      status: 'running',
      pane: { id: 'pane-worktree-target' },
      host: { contains: () => false },
      term: { blur: () => undefined, focus: () => undefined },
    };
    const harness = createPaneFocusHarness(
      [source, target],
      source.id,
      sourceElement,
    );
    const reports: Array<[string, boolean]> = [];
    source.term = {
      blur: () => {
        reports.push([
          'source-out',
          harness.shouldSuppressTerminalData(source, '\x1b[O'),
        ]);
        harness.documentRef.activeElement = null;
      },
      focus: () => {
        reports.push(['unexpected-source-in', false]);
      },
    };
    const activateProjectWorktree = compileFunction<(
      project: typeof harness.project,
      worktreePath: string,
    ) => Promise<boolean>>(functionSource('activateProjectWorktree'), {
      showTerminalView: async () => true,
      state: harness.state,
      setActiveProject: async () => {
        throw new Error('unexpected project switch');
      },
      activatePaneLayoutFocus: (
        _project: typeof harness.project,
        worktreePath: string,
      ) => {
        expect(worktreePath).toBe('/target');
        harness.state.activeThreadId = target.id;
      },
      renderPaneWorkspace: harness.renderPaneWorkspace,
      renderGitSurface: () => false,
      renderPanel: () => undefined,
      currentPanel: () => 'browser',
      loadAgentSkills: () => undefined,
      refreshSidebar: () => undefined,
      syncProjectBrowser: () => undefined,
      saveWorkspaceSoon: () => undefined,
      refreshStatusController: () => undefined,
    });

    await expect(
      activateProjectWorktree(harness.project, '/target'),
    ).resolves.toBe(true);
    expect(reports).toEqual([['source-out', false]]);
    expect(harness.queued).toHaveLength(0);
    expect(harness.state.activeThreadId).toBe(target.id);
    expect(source.internalFocusReportTokens).toBeUndefined();
  });

  it('preserves the focused terminal while removing an inactive project', async () => {
    const activeProject = { id: 'active-project' };
    const removedProject = { id: 'removed-project' };
    const removedThread = {
      id: 'removed-thread',
      projectId: removedProject.id,
    };
    const state = {
      activeProjectId: activeProject.id,
      activeThreadId: 'active-thread',
      activeFileId: null as string | null,
      projects: [activeProject, removedProject],
      threads: [removedThread],
      openFiles: [] as Array<{ id: string; projectId: string }>,
    };
    const closeOptions: Array<Record<string, unknown> | undefined> = [];
    const removeProject = compileFunction<(
      id: string,
    ) => Promise<boolean>>(functionSource('removeProject'), {
      findProject: (id: string) => (
        state.projects.find((project) => project.id === id) || null
      ),
      state,
      fileNavigationInFlight: false,
      fileDecisionInFlight: false,
      guardDirtyFiles: async () => true,
      covenDiscovery: {},
      PsycheSessions: {
        invalidateCovenRequests: (value: unknown) => value,
      },
      closeThread: (
        _id: string,
        options?: Record<string, unknown>,
      ) => {
        closeOptions.push(options);
        return true;
      },
      fileViewEl: null,
      terminalHost: null,
      startCovenPolling: () => undefined,
      setActiveProject: async () => true,
      renderPaneWorkspace: () => undefined,
      setStatus: () => undefined,
      refreshTabs: () => undefined,
      syncPaneMetricsVisibility: () => undefined,
      syncProjectBrowser: () => undefined,
      saveWorkspaceSoon: () => undefined,
      refreshStatusController: () => undefined,
    });

    await expect(removeProject(removedProject.id)).resolves.toBe(true);
    expect(closeOptions).toEqual([{
      focus: false,
      preserveTerminalFocus: true,
    }]);
    expect(state.activeProjectId).toBe(activeProject.id);
    expect(state.activeThreadId).toBe('active-thread');
  });

  it('skips explicit target focus while the terminal canvas is hidden before RAF', async () => {
    const state = { activeProjectId: 'project', activeThreadId: null as string | null };
    const project = {
      id: 'project',
      lastActiveThreadId: null as string | null,
      selectedWorktreePath: null as string | null,
    };
    const thread = {
      id: 'thread-hidden-focus',
      kind: 'shell',
      projectId: project.id,
      worktreePath: '/repo',
      status: 'running',
      pane: { id: 'pane-hidden-focus' },
      term: { blur: () => undefined, focus: () => undefined },
    };
    const queued: Array<() => void> = [];
    const tokenCalls: Array<{ report: string; policy: FocusReportPolicy }> = [];
    let focusCalls = 0;
    const terminalHost = {
      hidden: false,
      contains: () => true,
    };
    thread.term = { blur: () => undefined, focus: () => { focusCalls += 1; } };

    const focusThread = compileFunction<(
      id: string,
      options?: { refreshStatus?: boolean },
    ) => Promise<boolean>>(functionSource('focusThread'), {
      findThread: (id: string) => (id === thread.id ? thread : null),
      showTerminalView: async () => true,
      focusedTerminalThreadForRender: () => null,
      markActiveSurface: () => undefined,
      state,
      findProject: () => project,
      activeWorkspaceRoot: (value: typeof project) => value.selectedWorktreePath,
      paneLayoutFor: () => null,
      PsychePanes,
      renderPaneWorkspace: () => undefined,
      renderGitSurface: () => false,
      withTerminalFocusReportToken: (
        _thread: typeof thread,
        report: string,
        policy: FocusReportPolicy,
        action: () => void,
      ) => {
        tokenCalls.push({ report, policy });
        return action();
      },
      refreshSidebar: () => undefined,
      requestAnimationFrame: (callback: () => void) => {
        queued.push(callback);
      },
      scheduleTerminalPaneFits: () => undefined,
      isLiveThread: () => true,
      terminalHost,
      syncBrowserBounds: () => undefined,
      setProjectStatus: () => undefined,
      statusLevel: () => 'ok',
      refreshStatusController: () => undefined,
    });

    await expect(focusThread(thread.id)).resolves.toBe(true);
    expect(queued).toHaveLength(1);

    terminalHost.hidden = true;
    queued.shift()?.();

    expect(focusCalls).toBe(0);
    expect(tokenCalls).toEqual([]);
  });

  it('skips a superseded focus callback and never synthesizes blur for its target', async () => {
    const activeElement = { id: 'active-source' };
    const source: PaneFocusThread = {
      id: 'thread-a',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      pane: { id: 'pane-a' },
      host: { contains: (node: unknown) => node === activeElement },
      term: null,
    };
    const targetB: PaneFocusThread = {
      id: 'thread-b',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      pane: { id: 'pane-b' },
      host: { contains: () => false },
      term: null,
    };
    const targetC: PaneFocusThread = {
      id: 'thread-c',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      pane: { id: 'pane-c' },
      host: { contains: () => false },
      term: null,
    };
    const harness = createPaneFocusHarness(
      [source, targetB, targetC],
      source.id,
      activeElement,
    );
    const events: string[] = [];
    source.term = {
      blur: () => {
        events.push(
          `blur:a:${harness.shouldSuppressTerminalData(source, '\x1b[O')}`,
        );
        harness.documentRef.activeElement = null;
      },
      focus: () => {
        events.push('focus:a');
      },
    };
    targetB.term = {
      blur: () => {
        events.push(
          `blur:b:${harness.shouldSuppressTerminalData(targetB, '\x1b[O')}`,
        );
      },
      focus: () => {
        events.push(
          `focus:b:${harness.shouldSuppressTerminalData(targetB, '\x1b[I')}`,
        );
      },
    };
    targetC.term = {
      blur: () => {
        events.push(
          `blur:c:${harness.shouldSuppressTerminalData(targetC, '\x1b[O')}`,
        );
      },
      focus: () => {
        events.push(
          `focus:c:${harness.shouldSuppressTerminalData(targetC, '\x1b[I')}`,
        );
      },
    };

    const focusB = harness.focusThread(targetB.id);
    const focusC = harness.focusThread(targetC.id);
    await expect(Promise.all([focusB, focusC])).resolves.toEqual([true, true]);
    expect(harness.queued).toHaveLength(2);

    harness.queued.splice(0).forEach((callback) => callback());
    expect(events).toEqual([
      'blur:a:false',
      'focus:c:false',
    ]);
    expect(harness.state.activeThreadId).toBe(targetC.id);
    expect(targetB.internalFocusReportTokens).toBeUndefined();
    expect(targetC.internalFocusReportTokens).toBeUndefined();
  });

  it('does not focus or grant a token to stale, closed, incomplete, or detached targets', async () => {
    const scenarios = [
      'inactive',
      'removed',
      'closing',
      'missing-term',
      'missing-pane',
      'detached',
    ] as const;

    for (const scenario of scenarios) {
      const source: PaneFocusThread = {
        id: `source-${scenario}`,
        kind: 'shell',
        projectId: 'project-a',
        worktreePath: '/repo',
        status: 'running',
        pane: { id: `pane-source-${scenario}` },
        host: { contains: () => false },
        term: { blur: () => undefined, focus: () => undefined },
      };
      const target: PaneFocusThread = {
        id: `target-${scenario}`,
        kind: 'shell',
        projectId: 'project-a',
        worktreePath: '/repo',
        status: 'running',
        pane: { id: `pane-target-${scenario}` },
        host: { contains: () => false },
        term: null,
      };
      const harness = createPaneFocusHarness([source, target], source.id);
      let focusCalls = 0;
      target.term = {
        blur: () => undefined,
        focus: () => {
          focusCalls += 1;
          harness.shouldSuppressTerminalData(target, '\x1b[I');
        },
      };

      await expect(harness.focusThread(target.id)).resolves.toBe(true);
      expect(harness.queued).toHaveLength(1);
      if (scenario === 'inactive') harness.state.activeThreadId = source.id;
      if (scenario === 'removed') harness.state.threads = [source];
      if (scenario === 'closing') target.closing = true;
      if (scenario === 'missing-term') target.term = null;
      if (scenario === 'missing-pane') target.pane = null;
      if (scenario === 'detached' && target.pane) {
        harness.attachedPanes.delete(target.pane);
      }

      harness.queued.shift()?.();
      expect(focusCalls, scenario).toBe(0);
      expect(target.internalFocusReportTokens, scenario).toBeUndefined();
    }
  });

  it('cleans rerender tokens while surfacing blur, render, and focus errors', () => {
    const activeElement = { id: 'active-source' };
    const blurThread: PaneFocusThread = {
      id: 'thread-blur-error',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      pane: { id: 'pane-blur-error' },
      host: { contains: (node: unknown) => node === activeElement },
      term: null,
    };
    const blurHarness = createPaneFocusHarness(
      [blurThread],
      blurThread.id,
      activeElement,
    );
    const blurError = new Error('blur failed');
    let blurReplaceCalls = 0;
    blurThread.term = {
      blur: () => { throw blurError; },
      focus: () => undefined,
    };
    blurHarness.terminalHost.replaceChildren = () => {
      blurReplaceCalls += 1;
    };

    expect(() => blurHarness.renderPaneWorkspace()).toThrow(blurError);
    expect(blurReplaceCalls).toBe(0);
    expect(blurThread.internalFocusReportTokens).toBeUndefined();
    expect(blurHarness.shouldSuppressTerminalData(blurThread, '\x1b[O')).toBe(false);
    expect(blurHarness.queued).toHaveLength(1);
    blurHarness.queued.shift()?.();
    expect(blurThread.internalFocusReportTokens).toBeUndefined();

    const renderThread: PaneFocusThread = {
      id: 'thread-render-error',
      kind: 'shell',
      projectId: 'project-a',
      worktreePath: '/repo',
      status: 'running',
      pane: { id: 'pane-render-error' },
      host: { contains: (node: unknown) => node === activeElement },
      term: null,
    };
    const renderHarness = createPaneFocusHarness(
      [renderThread],
      renderThread.id,
      activeElement,
    );
    const renderError = new Error('replace failed');
    const focusError = new Error('focus failed');
    renderThread.term = {
      blur: () => {
        expect(
          renderHarness.shouldSuppressTerminalData(renderThread, '\x1b[O'),
        ).toBe(true);
      },
      focus: () => { throw focusError; },
    };
    renderHarness.terminalHost.replaceChildren = () => {
      throw renderError;
    };

    expect(() => renderHarness.renderPaneWorkspace()).toThrow(renderError);
    expect(renderThread.internalFocusReportTokens).toBeUndefined();
    expect(renderHarness.queued).toHaveLength(1);
    expect(() => renderHarness.queued.shift()?.()).toThrow(focusError);
    expect(renderThread.internalFocusReportTokens).toBeUndefined();
    expect(renderHarness.shouldSuppressTerminalData(renderThread, '\x1b[I')).toBe(false);
  });

  it('uses the shared accessible-name fallback for terminal, Web, and tool panes', () => {
    for (const mount of ['mountTerminal', 'mountBrowserPane', 'mountToolPane']) {
      const source = functionSource(mount);
      expect(source).not.toContain('aria-labelledby');
      expect(source).toMatch(
        /thread\.pane = pane[\s\S]*thread\.paneTitle = title[\s\S]*syncThreadPaneMetadata\(thread\)/,
      );
    }
    expect(functionSource('syncThreadPaneMetadata')).toMatch(
      /applyPaneStatus\(thread\.pane, thread\.status\)[\s\S]*thread\.pane\.setAttribute\(\s*"aria-label"/,
    );
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
    expect(functionSource('renderPaneWorkspace')).toMatch(/scheduleTerminalPaneFits\(\)/);
    expect(stylesCss).not.toMatch(/\.term-instance\.active\s*\{\s*visibility:\s*visible/);
    expect(stylesCss).toMatch(/\.terminal-pane\.focused/);
    expect(stylesCss).toMatch(/\.terminal-pane-body/);
  });

  it('does not render file minimap chrome when a terminal owns canvas focus', () => {
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
      focusedTerminalThreadForRender: () => null,
      withTerminalFocusReportToken: (
        _thread: unknown,
        _report: string,
        _policy: FocusReportPolicy,
        action: () => unknown,
      ) => action(),
      stageBrowserSurface: () => { calls.push('stage'); },
      stageGitSurface: () => { calls.push('stage-git'); },
      activePaneLayout: () => null,
      renderTerminalEmptyState: () => { calls.push('empty'); },
      renderPaneMinimap: (layout: unknown, file: unknown) => {
        expect(layout).toBeNull();
        expect(file).toBeNull();
        calls.push('minimap');
      },
      filesPaneHasCanvasFocus: () => false,
      findOpenFile: (id: string | null) => {
        expect(id).toBe('file-a');
        return activeFile;
      },
      syncAllPtyVisibility: () => { calls.push('visibility'); },
      state: { activeFileId: 'file-a' },
      restoreRenderedTerminalFocus: () => undefined,
    });

    renderPaneWorkspace();
    expect(terminalHost.children).toEqual([]);
    expect(calls).toEqual(['stage', 'stage-git', 'clear', 'empty', 'minimap', 'visibility']);

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
      kind: 'coven-code', status: 'running', hidden: true, pane: { id: 'pane-a' },
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
    const branch = {
      classList: { contains: (name: string) => name === 'terminal-pane-branch' },
      dataset: {} as Record<string, string>,
      firstElementChild: null as null | {
        classList: { contains: (name: string) => boolean };
        dataset: Record<string, string>;
      },
    };
    const paneClasses = new Set(['terminal-pane']);
    const thread = {
      id: 'thread-a', projectId: 'project', name: 'Psyche', status: 'starting',
      pane: {
        dataset: {} as Record<string, string>,
        classList: { contains: (name: string) => paneClasses.has(name) },
        parentElement: branch,
        setAttribute: (name: string, value: string) => paneAttributes.set(name, value),
        removeAttribute: (name: string) => { paneAttributes.delete(name); },
      },
      paneTitle: { textContent: '' },
      paneClose: { setAttribute: (name: string, value: string) => attributes.set(name, value) },
    };
    branch.firstElementChild = thread.pane;
    const applyPaneStatus = compileFunction<(element: unknown, status: string) => string>(
      functionSource('applyPaneStatus'),
      {},
    );
    const syncPaneBranchStatusChrome = compileFunction<(element: unknown) => void>(
      functionSource('syncPaneBranchStatusChrome'),
      {},
    );
    const syncThreadPaneMetadata = compileFunction<(value: typeof thread) => void>(
      functionSource('syncThreadPaneMetadata'),
      {
        applyPaneStatus,
        syncPaneBranchStatusChrome,
        threadLaneLabel: () => 'main',
        // No pane tree in this harness: the span/maximise controls have nothing
        // to reflect, which is exactly the detached-pane case.
        paneLayoutForThread: () => null,
        PsychePanes: { findLeafByThreadId: () => null },
        syncPaneSpanControl: () => undefined,
        syncPaneMaxControl: () => undefined,
        sessionCloseLabel: (value: typeof thread) => `Stop and close ${value.name}`,
      },
    );
    syncThreadPaneMetadata(thread);
    expect(thread.pane.dataset.status).toBe('starting');
    expect(paneAttributes.get('aria-label')).toBe('Psyche, status starting');
    expect(paneAttributes.get('aria-description')).toBe('Status: starting');
    expect(branch.dataset.status).toBe('starting');

    thread.status = 'running';
    syncThreadPaneMetadata(thread);
    expect(thread.pane.dataset.status).toBe('running');
    expect(paneAttributes.get('aria-label')).toBe('Psyche, status running');
    expect(paneAttributes.get('aria-description')).toBe('Status: running');
    expect('status' in branch.dataset).toBe(false);

    thread.status = 'failed';
    syncThreadPaneMetadata(thread);
    expect(thread.pane.dataset.status).toBe('failed');
    expect(paneAttributes.get('aria-label')).toBe('Psyche, status failed');
    expect(paneAttributes.get('aria-description')).toBe('Status: failed');
    expect(branch.dataset.status).toBe('failed');

    thread.status = 'exited';
    syncThreadPaneMetadata(thread);
    expect(thread.pane.dataset.status).toBe('exited');
    expect(paneAttributes.get('aria-label')).toBe('Psyche, status exited');
    expect(paneAttributes.get('aria-description')).toBe('Status: exited');
    expect(branch.dataset.status).toBe('exited');

    thread.status = 'paused';
    syncThreadPaneMetadata(thread);
    expect('status' in thread.pane.dataset).toBe(false);
    expect(paneAttributes.get('aria-label')).toBe('Psyche');
    expect(paneAttributes.has('aria-description')).toBe(false);
    expect('status' in branch.dataset).toBe(false);

    thread.status = '';
    syncThreadPaneMetadata(thread);
    expect('status' in thread.pane.dataset).toBe(false);
    expect(paneAttributes.get('aria-label')).toBe('Psyche');
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
    thread.status = 'running';
    expect(renameThread(thread.id, 'Renamed')).toBe(true);
    expect(thread.paneTitle.textContent).toBe('Renamed');
    expect(paneAttributes.get('aria-label')).toBe('Renamed, status running');
    expect(paneAttributes.get('aria-description')).toBe('Status: running');
    expect(attributes.get('aria-label')).toBe('Stop and close Renamed');

    expect(functionSource('spawnPty')).toMatch(/thread\.status = "running";[\s\S]*syncThreadPaneMetadata\(thread\)/);
    expect(functionSource('handlePtyExit')).toMatch(/thread\.status = persistentLive \? "failed" : "exited";[\s\S]*syncThreadPaneMetadata\(thread\)/);
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

  it('cancels a queued PTY start when the thread closes before animation frame', async () => {
    const project = { id: 'project', root: '/repo' };
    const state = { threads: [] as Array<Record<string, unknown>>, activeThreadId: null as string | null };
    let frame: (() => void) | null = null;
    let starts = 0;
    let stops = 0;
    let disposed = 0;
    const isLiveThread = (thread: Record<string, unknown>) =>
      state.threads.includes(thread) && thread.closing !== true;
    const createThread = compileFunction<(options: Record<string, unknown>) => Promise<Record<string, unknown>>>(
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
          thread.terminalController = { dispose: () => { disposed += 1; } };
        },
        focusThread: () => undefined,
        requestAnimationFrame: (callback: () => void) => { frame = callback; },
        isLiveThread,
        spawnPty: () => { starts += 1; },
      },
    );
    const thread = await createThread({ project, command: '/bin/zsh' });
    const closeThread = compileFunction<(id: string) => Promise<boolean>>(functionSource('closeThread'), {
      forgetThreadInSets: () => undefined,
      findThread: () => thread,
      detachThreadPane: () => null,
      retainFileFocusAfterThreadRemoval: () => false,
      stopThreadPty: () => { stops += 1; return Promise.resolve(true); },
      state,
      renderPaneWorkspace: () => undefined,
      setProjectStatus: () => undefined,
      findProject: () => project,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      focusThread: () => undefined,
    });
    await expect(closeThread('thread-a')).resolves.toBe(true);
    expect(frame).not.toBeNull();
    (frame as unknown as () => void)();
    expect(starts).toBe(0);
    expect(stops).toBe(1);
    expect(disposed).toBe(1);
    expect(state.threads).toEqual([]);
    expect(thread.closing).toBe(true);
  });

  it('stops a remotely started PTY when close wins the in-flight start race', async () => {
    const start = deferred<void>();
    const project = { id: 'project' };
    let controllerDisposals = 0;
    const thread = {
      id: 'thread-a', projectId: project.id, worktreePath: '/repo',
      launch: {
        command: '/bin/zsh', args: [], env: {}, projectRoot: '/repo', cwd: '/repo',
        launchKind: null, covenSessionId: null,
      },
      status: 'starting', spawning: true,
      closing: false, closeStarted: false, startInFlight: false,
      stopRequested: false, ptyStarted: false, term: null, fit: null,
      terminalController: {
        prepareForPtyStart: () => 1,
        restoreAfterFailedPtyStart: () => undefined,
        adoptRunningPty: () => Promise.resolve(false),
        markPtyStarted: () => Promise.resolve(false),
        stopPtyDelivery: () => undefined,
        dispose: () => { controllerDisposals += 1; },
      },
    };
    const state = { threads: [thread], activeThreadId: thread.id };
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
        ...spawnPtyRuntimeDeps,
        invoke,
        isLiveThread,
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
    const closeThread = compileFunction<(id: string) => Promise<boolean>>(functionSource('closeThread'), {
      forgetThreadInSets: () => undefined,
      findThread: () => thread,
      detachThreadPane: () => null,
      retainFileFocusAfterThreadRemoval: () => false,
      stopThreadPty,
      state,
      renderPaneWorkspace: () => undefined,
      setProjectStatus: () => undefined,
      findProject: () => project,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      focusThread: () => undefined,
    });
    await expect(closeThread(thread.id)).resolves.toBe(true);
    start.resolve();
    await expect(starting).resolves.toBe(false);
    expect(stopCalls).toBe(1);
    expect(controllerDisposals).toBe(1);
    expect(thread.status).toBe('starting');
    expect(thread.startInFlight).toBe(false);
    expect(state.threads).toEqual([]);
  });

  it('retains file focus when closing the active underlying pane', async () => {
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
      filesPaneHasCanvasFocus: () => true,
    });
    let renders = 0;
    let focused = 0;
    const closeThread = compileFunction<(id: string) => Promise<boolean>>(functionSource('closeThread'), {
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

    await expect(closeThread(threadA.id)).resolves.toBe(true);
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
      filesPaneHasCanvasFocus: () => true,
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

  it('focuses the next live terminal when closing a terminal with a file still selected', async () => {
    const project = { id: 'project', lastActiveThreadId: 'thread-a', selectedWorktreePath: '/repo' };
    const threadA = {
      id: 'thread-a', kind: 'shell', projectId: project.id, worktreePath: '/repo',
      closeStarted: false, closing: false, startInFlight: false,
      metricsGeneration: 0, metricsRefreshTimer: 0, term: { dispose: () => undefined },
    };
    const threadB = {
      id: 'thread-b', kind: 'shell', projectId: project.id, worktreePath: '/repo',
      closeStarted: false, closing: false, startInFlight: false,
      metricsGeneration: 0, metricsRefreshTimer: 0, term: { dispose: () => undefined },
    };
    const state = {
      threads: [threadA, threadB], activeThreadId: threadA.id as string | null,
      activeFileId: 'file-a',
    };
    const retainFileFocusAfterThreadRemoval = compileFunction<
      (removedThreadId: string, nextThreadId: string | null, projectId: string) => boolean
    >(functionSource('retainFileFocusAfterThreadRemoval'), {
      state,
      filesPaneHasCanvasFocus: () => false,
      fileFocus: { returnThreadId: threadA.id },
      filesPanes: new Map(),
      findProject: () => project,
      findThread: (id: string) => state.threads.find((thread) => thread.id === id) || null,
    });
    const focused: string[] = [];
    const closeThread = compileFunction<(id: string) => Promise<boolean>>(functionSource('closeThread'), {
      forgetThreadInSets: () => undefined,
      findThread: (id: string) => state.threads.find((thread) => thread.id === id) || null,
      detachThreadPane: () => 'files-pane',
      retainFileFocusAfterThreadRemoval,
      canvasThreadIds: () => [threadB.id],
      canvasSurfaceById: () => ({ id: 'files-pane', kind: 'files' }),
      pendingDataBuffers: new Map(),
      stopThreadPty: () => Promise.resolve(true),
      state,
      renderPaneWorkspace: () => undefined,
      setProjectStatus: () => undefined,
      findProject: () => project,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      focusThread: (id: string) => { focused.push(id); return true; },
    });

    await expect(closeThread(threadA.id)).resolves.toBe(true);
    expect(focused).toEqual([threadB.id]);
    expect(state.activeThreadId).toBeNull();
  });

  it('focuses the next live terminal when hiding a terminal with a file still selected', () => {
    const threadA = {
      id: 'thread-a', kind: 'shell', projectId: 'project', worktreePath: '/repo',
      hidden: false, metricsGeneration: 0, metricsRefreshTimer: 0,
    };
    const threadB = {
      id: 'thread-b', kind: 'shell', projectId: 'project', worktreePath: '/repo',
      hidden: false, metricsGeneration: 0, metricsRefreshTimer: 0,
    };
    const state = {
      threads: [threadA, threadB], activeThreadId: threadA.id as string | null,
      activeFileId: 'file-a',
    };
    const retainFileFocusAfterThreadRemoval = compileFunction<
      (removedThreadId: string, nextThreadId: string | null, projectId: string) => boolean
    >(functionSource('retainFileFocusAfterThreadRemoval'), {
      state,
      filesPaneHasCanvasFocus: () => false,
      fileFocus: { returnThreadId: threadA.id },
      filesPanes: new Map(),
      findProject: () => null,
      findThread: (id: string) => state.threads.find((thread) => thread.id === id) || null,
    });
    const focused: string[] = [];
    const hideThread = compileFunction<(id: string) => boolean>(functionSource('hideThread'), {
      findThread: (id: string) => state.threads.find((thread) => thread.id === id) || null,
      detachThreadPane: () => 'files-pane',
      retainFileFocusAfterThreadRemoval,
      canvasThreadIds: () => [threadB.id],
      state,
      focusThread: (id: string) => { focused.push(id); return true; },
      renderPaneWorkspace: () => undefined,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
    });

    expect(hideThread(threadA.id)).toBe(true);
    expect(focused).toEqual([threadB.id]);
    expect(state.activeThreadId).toBeNull();
  });

  it('clears file-focus project metadata when there is no replacement pane', async () => {
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
      filesPaneHasCanvasFocus: () => true,
    });
    const closeThread = compileFunction<(id: string) => Promise<boolean>>(functionSource('closeThread'), {
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

    await expect(closeThread(threadA.id)).resolves.toBe(true);
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
      renderGitSurface: () => false,
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
      renderGitSurface: () => { calls.push('panel'); return true; },
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
      'terminal', `project:${project.id}`,
      'skills', 'sidebar', 'browser', 'save', 'focus:hidden-thread',
    ]);
  });

  it('renders an active-project worktree switch exactly once at coordinator level', async () => {
    const project = { id: 'project', selectedWorktreePath: '/old', lastActiveThreadId: null as string | null };
    const thread = { id: 'thread-a' };
    const state = { activeProjectId: project.id, activeThreadId: null as string | null };
    let renders = 0;
    let gitRenders = 0;
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
      clearPassiveCovenPaneFocus: () => undefined,
      renderPaneWorkspace,
      refreshStatusController: () => { refreshes += 1; },
    });
    const activateProjectWorktree = compileFunction<(
      value: typeof project, path: string,
    ) => Promise<boolean>>(functionSource('activateProjectWorktree'), {
      guardActiveFileBoundary: async () => true,
      showTerminalView: async () => true,
      state,
      setActiveProject: async () => true,
      activatePaneLayoutFocus,
      renderPaneWorkspace,
      renderGitSurface: () => { gitRenders += 1; return true; },
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
    expect(gitRenders).toBe(1);
    expect(refreshes).toBe(1);
  });

  it('does not focus a Coven layout leaf during passive worktree selection', async () => {
    const project = { id: 'project', selectedWorktreePath: '/old', lastActiveThreadId: 'shell-a' };
    const thread = { id: 'thread-coven', kind: 'coven-attach' };
    const state = { activeProjectId: project.id, activeThreadId: 'stale-thread' as string | null };
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
      clearPassiveCovenPaneFocus: () => undefined,
      renderPaneWorkspace,
      refreshStatusController: () => { refreshes += 1; },
    });
    const activateProjectWorktree = compileFunction<(
      value: typeof project, path: string,
    ) => Promise<boolean>>(functionSource('activateProjectWorktree'), {
      guardActiveFileBoundary: async () => true,
      showTerminalView: async () => true,
      state,
      setActiveProject: async () => true,
      activatePaneLayoutFocus,
      renderPaneWorkspace,
      renderGitSurface: () => false,
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
    expect(project.lastActiveThreadId).toBe('shell-a');
    expect(state.activeThreadId).toBeNull();
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
    const options = { refreshStatus: true };
    const focusCalls: Array<{ id: string; options: Record<string, unknown> | undefined }> = [];
    let paneRenders = 0;
    let gitRenders = 0;
    let refreshes = 0;
    const setActiveProject = compileFunction<(
      id: string,
      callOptions?: Record<string, unknown>,
    ) => Promise<boolean>>(functionSource('setActiveProject'), {
      state,
      guardActiveFileBoundary: async () => true,
      showTerminalView: async () => true,
      findProject: () => project,
      restoreProjectLayout: () => undefined,
      clearPassiveCovenPaneFocus: () => undefined,
      loadAgentSkills: () => undefined,
      activeWorkspaceRoot: (value: typeof project) => value.selectedWorktreePath,
      focusThread: async (id: string, focusOptions?: Record<string, unknown>) => {
        focusCalls.push({ id, options: focusOptions });
        state.activeThreadId = id;
        paneRenders += 1;
        return true;
      },
      renderPaneWorkspace: () => { paneRenders += 1; },
      renderGitSurface: () => { gitRenders += 1; return true; },
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      syncProjectBrowser: () => undefined,
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
      renderPaneWorkspace: () => { paneRenders += 1; },
      renderGitSurface: () => { gitRenders += 1; return true; },
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
      { id: 'thread-a', options: { refreshStatus: false } },
    ]);
    expect(paneRenders).toBe(1);
    expect(gitRenders).toBe(1);
    expect(refreshes).toBe(1);
    expect(options).toEqual({ refreshStatus: true });
  });

  it('does not restore a visible local Coven pane during passive project activation', async () => {
    const project = {
      id: 'project',
      selectedWorktreePath: '/target',
      lastActiveThreadId: 'thread-chat',
    };
    const state = {
      activeProjectId: 'other',
      activeThreadId: 'stale-thread' as string | null,
      threads: [
        {
          id: 'thread-chat',
          kind: 'coven-code',
          projectId: project.id,
          worktreePath: '/target',
          hidden: false,
        },
        {
          id: 'thread-attach',
          kind: 'coven-attach',
          projectId: project.id,
          worktreePath: '/target',
          hidden: false,
        },
      ],
    };
    const focusCalls: Array<{ id: string; options: Record<string, unknown> | undefined }> = [];
    let renderCalls = 0;
    let sidebarCalls = 0;
    let tabCalls = 0;
    let syncCalls = 0;
    const setActiveProject = compileFunction<(
      id: string,
      callOptions?: Record<string, unknown>,
    ) => Promise<boolean>>(functionSource('setActiveProject'), {
      state,
      guardActiveFileBoundary: async () => true,
      showTerminalView: async () => true,
      findProject: () => project,
      restoreProjectLayout: () => undefined,
      clearPassiveCovenPaneFocus: () => undefined,
      loadAgentSkills: () => undefined,
      activeWorkspaceRoot: (value: typeof project) => value.selectedWorktreePath,
      focusThread: async (id: string, focusOptions?: Record<string, unknown>) => {
        focusCalls.push({ id, options: focusOptions });
        state.activeThreadId = id;
        return true;
      },
      renderPaneWorkspace: () => { renderCalls += 1; },
      renderGitSurface: () => false,
      refreshSidebar: () => { sidebarCalls += 1; },
      refreshTabs: () => { tabCalls += 1; },
      syncProjectBrowser: () => { syncCalls += 1; },
      saveWorkspaceSoon: () => undefined,
    });

    await expect(setActiveProject(project.id)).resolves.toBe(true);
    expect(state.activeProjectId).toBe(project.id);
    expect(state.activeThreadId).toBeNull();
    expect(project.lastActiveThreadId).toBeNull();
    expect(focusCalls).toEqual([]);
    expect(renderCalls).toBe(1);
    expect(sidebarCalls).toBe(1);
    expect(tabCalls).toBe(1);
    expect(syncCalls).toBe(2);
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
      pane: { id: 'pane-a' },
      hidden: false,
      closing: false,
      closeStarted: false,
      term: { blur: () => undefined, focus: () => undefined },
    };
    let refreshes = 0;
    const focusThread = compileFunction<(
      id: string,
      options?: { refreshStatus?: boolean },
    ) => Promise<boolean>>(functionSource('focusThread'), {
      findThread: (id: string) => (id === thread.id ? thread : null),
      isDormantThread: () => false,
      showTerminalView: async () => true,
      focusedTerminalThreadForRender: () => null,
      markActiveSurface: () => undefined,
      state,
      findProject: () => project,
      activeWorkspaceRoot: (value: typeof project) => value.selectedWorktreePath,
      paneLayoutFor: () => null,
      PsychePanes,
      renderPaneWorkspace: () => undefined,
      withTerminalFocusReportToken: (
        _thread: unknown,
        _report: string,
        _policy: FocusReportPolicy,
        action: () => unknown,
      ) => action(),
      renderGitSurface: () => false,
      refreshSidebar: () => undefined,
      requestAnimationFrame: (callback: () => void) => callback(),
      scheduleTerminalPaneFits: () => undefined,
      isLiveThread: () => true,
      terminalHost: { contains: () => true },
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

  it('refreshes the Git owner once when direct focus changes project and worktree scope', async () => {
    const oldProject = {
      id: 'project-a',
      selectedWorktreePath: '/worktree-a',
      lastActiveThreadId: null as string | null,
    };
    const nextProject = {
      id: 'project-b',
      selectedWorktreePath: '/worktree-b-old',
      lastActiveThreadId: null as string | null,
    };
    const state = {
      activeProjectId: oldProject.id,
      activeThreadId: 'thread-a' as string | null,
    };
    const thread = {
      id: 'thread-b',
      kind: 'shell',
      projectId: nextProject.id,
      worktreePath: '/worktree-b',
      status: 'running',
      term: null,
    };
    let generation = 1;
    const renderedScopes: string[] = [];
    const activeProject = () => state.activeProjectId === nextProject.id ? nextProject : oldProject;
    const activeWorkspaceRoot = (project: typeof oldProject) => project.selectedWorktreePath;
    const requestMatches = compileFunction<(
      projectId: string,
      workspaceRoot: string,
      candidate: number,
    ) => boolean>(functionSource('gitPanelRequestMatches'), {
      activeProject,
      activeWorkspaceRoot,
      gitPanelRequestGate: { isCurrent: (candidate: number) => candidate === generation },
      gitPaneIsVisible: () => true,
    });
    const focusThread = compileFunction<(id: string) => Promise<boolean>>(
      functionSource('focusThread'), {
        findThread: (id: string) => id === thread.id ? thread : null,
        showTerminalView: async () => true,
        focusedTerminalThreadForRender: () => null,
        markActiveSurface: () => undefined,
        state,
        findProject: (id: string) => id === nextProject.id ? nextProject : null,
        activeWorkspaceRoot,
        paneLayoutFor: () => null,
        PsychePanes,
        renderPaneWorkspace: () => undefined,
        renderGitSurface: () => {
          generation += 1;
          renderedScopes.push(`${state.activeProjectId}:${nextProject.selectedWorktreePath}`);
          return true;
        },
        refreshSidebar: () => undefined,
        withTerminalFocusReportToken: (
          _thread: unknown,
          _report: string,
          _policy: FocusReportPolicy,
          action: () => unknown,
        ) => action(),
        requestAnimationFrame: (callback: () => void) => callback(),
        scheduleTerminalPaneFits: () => undefined,
        isLiveThread: () => true,
        terminalHost: { hidden: false, contains: () => true },
        syncBrowserBounds: () => undefined,
        setProjectStatus: () => undefined,
        statusLevel: () => 'ok',
        refreshStatusController: () => undefined,
      },
    );

    const oldGeneration = generation;
    await expect(focusThread(thread.id)).resolves.toBe(true);
    expect(renderedScopes).toEqual(['project-b:/worktree-b']);
    expect(requestMatches('project-a', '/worktree-a', oldGeneration)).toBe(false);
    expect(requestMatches('project-b', '/worktree-b', generation)).toBe(true);

    await expect(focusThread(thread.id)).resolves.toBe(true);
    expect(renderedScopes).toEqual(['project-b:/worktree-b']);
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
      guardActiveFileBoundary: async () => true,
      showTerminalView: async () => true,
      findProject: () => project,
      restoreProjectLayout: () => undefined,
      clearPassiveCovenPaneFocus: () => undefined,
      loadAgentSkills: () => undefined,
      activeWorkspaceRoot: (value: typeof project) => value.selectedWorktreePath,
      focusThread: async (id: string, focusOptions?: Record<string, unknown>) => {
        focusCalls.push({ id, options: focusOptions });
        state.activeThreadId = id;
        return true;
      },
      renderPaneWorkspace: () => undefined,
      renderGitSurface: () => false,
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

  it('routes /new-thread through ensureProjectCoven(activeProject())', async () => {
    const project = { id: 'project', root: '/repo' };
    let ensured: typeof project | null = null;
    const result = { kind: 'coven-code' };
    const runNewThreadCommand = compileFunction<() => Promise<typeof result | null>>(
      functionSource('runNewThreadCommand'),
      {
        activeProject: () => project,
        ensureProjectCoven: async (value: typeof project | null) => {
          ensured = value;
          return result;
        },
      },
    );
    await expect(runNewThreadCommand()).resolves.toBe(result);
    expect(ensured).toBe(project);
    expect(mainJs).toMatch(/cmd: "\/new-thread"[\s\S]*?run: runNewThreadCommand/);
  });

  it('resolves null from /new-thread when there is no active project', async () => {
    let ensured: null = null;
    const runNewThreadCommand = compileFunction<() => Promise<null>>(
      functionSource('runNewThreadCommand'),
      {
        activeProject: () => null,
        ensureProjectCoven: async (value: null) => {
          ensured = value;
          return null;
        },
      },
    );
    await expect(runNewThreadCommand()).resolves.toBeNull();
    expect(ensured).toBeNull();
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

    it('resolves the recorded return pane, then an available pane when Files is absent', () => {
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
        activeFilesPane: () => null,
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
        /header\.appendChild\(glyph\);[\s\S]*header\.appendChild\(label\);[\s\S]*header\.appendChild\(attention\);[\s\S]*header\.appendChild\(hide\);[\s\S]*header\.appendChild\(maximize\);[\s\S]*header\.appendChild\(close\)/,
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
      const legacyStatusToken = ['terminal', 'pane', 'status'].join('-');
      const startingSelector =
        '.terminal-pane-branch[data-status="starting"]';
      const failedSelector =
        '.terminal-pane-branch[data-status="failed"]';
      const exitedSelector =
        '.terminal-pane-branch[data-status="exited"]';
      const glowSelector =
        '.terminal-pane-branch:is([data-status="starting"], [data-status="failed"], [data-status="exited"])';
      const rootStartingSelector =
        '.terminal-host > .terminal-pane[data-status="starting"]:not(.needs-attention)';
      const rootFailedSelector =
        '.terminal-host > .terminal-pane[data-status="failed"]:not(.needs-attention)';
      const rootExitedSelector =
        '.terminal-host > .terminal-pane[data-status="exited"]:not(.needs-attention)';
      const rootGlowSelector =
        '.terminal-host > .terminal-pane:is([data-status="starting"], [data-status="failed"], [data-status="exited"]):not(.needs-attention)';
      const focusedRootGlowSelector =
        '.terminal-host > .terminal-pane.focused:is([data-status="starting"], [data-status="failed"], [data-status="exited"]):not(.needs-attention)';

      expect(functionSource('mountTerminal')).not.toContain(legacyStatusToken);
      expect(functionSource('mountBrowserPane')).not.toContain(legacyStatusToken);
      expect(functionSource('mountToolPane')).not.toContain(legacyStatusToken);
      expect(stylesCss).not.toContain(legacyStatusToken);
      expect(stylesCss).not.toMatch(/\.terminal-pane-branch:has\(/);
      expect(cssDeclarations(startingSelector).get('--pane-status-rgb')).toBe('251, 191, 36');
      expect(cssDeclarations(failedSelector).get('--pane-status-rgb')).toBe('248, 113, 113');
      expect(cssDeclarations(exitedSelector).get('--pane-status-rgb')).toBe('138, 132, 153');
      expect(cssDeclarations(rootStartingSelector).get('--pane-status-rgb')).toBe('251, 191, 36');
      expect(cssDeclarations(rootFailedSelector).get('--pane-status-rgb')).toBe('248, 113, 113');
      expect(cssDeclarations(rootExitedSelector).get('--pane-status-rgb')).toBe('138, 132, 153');
      expect(stylesCss).not.toMatch(/\[data-status="running"\]/);
      expect(cssDeclarations(glowSelector)).toEqual(new Map([
        ['position', 'relative'],
        ['z-index', '1'],
        ['border-radius', '4px'],
        [
          'box-shadow',
          '0 0 0 1px rgba(var(--pane-status-rgb), 0.2), 0 0 12px rgba(var(--pane-status-rgb), 0.24)',
        ],
      ]));
      expect(cssDeclarations(rootGlowSelector)).toEqual(new Map([
        [
          'box-shadow',
          '0 0 0 1px rgba(var(--pane-status-rgb), 0.2), 0 0 12px rgba(var(--pane-status-rgb), 0.24)',
        ],
      ]));
      expect(cssDeclarations(focusedRootGlowSelector)).toEqual(new Map([
        ['border-color', 'rgba(var(--rgb-accent), 0.55)'],
        [
          'box-shadow',
          '0 0 0 1px rgba(var(--rgb-accent), 0.22), 0 0 12px rgba(var(--pane-status-rgb), 0.24)',
        ],
      ]));
      expect(cssDeclarations('.terminal-pane.focused')).toEqual(new Map([
        ['border-color', 'rgba(var(--rgb-accent), 0.55)'],
        ['box-shadow', '0 0 0 1px rgba(var(--rgb-accent), 0.22)'],
      ]));
      expect(() => cssDeclarations(
        '.terminal-pane:is([data-status="starting"], [data-status="failed"], [data-status="exited"]):not(.needs-attention)',
      )).toThrow();
      expect(() => cssDeclarations(
        '.terminal-pane.focused:is([data-status="starting"], [data-status="failed"], [data-status="exited"]):not(.needs-attention)',
      )).toThrow();
    });

    it('double-clicking the header enters focus mode, but not on its buttons', () => {
      expect(functionSource('mountTerminal')).toMatch(
        /header\.addEventListener\("dblclick"[\s\S]*closest\("button"\)\) return;[\s\S]*togglePaneMaximize\(thread\)/,
      );
    });
  });
});
