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

describe('Tauri physical terminal panes', () => {
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
