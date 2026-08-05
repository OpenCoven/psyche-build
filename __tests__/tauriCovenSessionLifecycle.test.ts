import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const PsycheSessions = await import(
  pathToFileURL(join(
    process.cwd(),
    'native/macos/psyche-build-tauri/web/sessions/session-model.mjs'
  )).href
);

const mainJs = readFileSync(
  join(process.cwd(), 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8'
);

function extractFunctionSource(source: string, name: string) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const syncStart = source.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
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
  dependencies: Record<string, unknown>
) {
  return Function(
    ...Object.keys(dependencies),
    `"use strict"; return (${source});`
  )(...Object.values(dependencies)) as T;
}

function compileHarness<T extends Record<string, unknown>>(
  sources: string[],
  dependencies: Record<string, unknown>,
  resultSource: string
) {
  return Function(
    ...Object.keys(dependencies),
    `"use strict"; ${sources.join('\n')} return (${resultSource});`
  )(...Object.values(dependencies)) as T;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('native Coven session discovery lifecycle', () => {
  it('declares isolated discovery state and the exact five-second interval', () => {
    expect(mainJs).toMatch(
      /var state = \{[\s\S]*?\n  \};\n\n  var covenDiscovery = PsycheSessions\.createCovenDiscoveryState\(\);\n  var covenPollTimer = null;\n  var COVEN_POLL_MS = 5000;/
    );
    expect(extractFunctionSource(mainJs, 'renderSessionList')).not.toContain(
      'state.threads.push'
    );
  });

  it('refreshes every current project root through the request-id model', async () => {
    const state = { projects: [{ root: '/alpha' }, { root: '/beta/' }] };
    const invoke = vi.fn().mockResolvedValue({
      status: 'ready',
      sessions: [{ id: 'live', projectRoot: '/alpha', status: 'running' }],
    });
    const renderSessionList = vi.fn();
    const harness = compileHarness<{
      refreshCovenSessions: () => Promise<void>;
      discovery: () => ReturnType<typeof PsycheSessions.createCovenDiscoveryState>;
    }>([extractFunctionSource(mainJs, 'refreshCovenSessions')], {
      state,
      invoke,
      renderSessionList,
      PsycheSessions,
      covenDiscovery: PsycheSessions.createCovenDiscoveryState(),
    }, '{ refreshCovenSessions, discovery: function () { return covenDiscovery; } }');

    await harness.refreshCovenSessions();

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('coven_sessions', {
      projectRoots: ['/alpha', '/beta/'],
    });
    expect(harness.discovery()).toMatchObject({ phase: 'ready', requestId: 1 });
    expect(harness.discovery().sessionsByProject.get('/alpha')?.[0]?.id).toBe('live');
    expect(renderSessionList).toHaveBeenCalledTimes(2);
  });

  it('invalidates locally without IPC when there are no projects', async () => {
    const invoke = vi.fn();
    const renderSessionList = vi.fn();
    const harness = compileHarness<{
      refreshCovenSessions: () => Promise<void>;
      discovery: () => ReturnType<typeof PsycheSessions.createCovenDiscoveryState>;
    }>([extractFunctionSource(mainJs, 'refreshCovenSessions')], {
      state: { projects: [] }, invoke, renderSessionList, PsycheSessions,
      covenDiscovery: PsycheSessions.createCovenDiscoveryState(),
    }, '{ refreshCovenSessions, discovery: function () { return covenDiscovery; } }');

    await expect(harness.refreshCovenSessions()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
    expect(harness.discovery()).toMatchObject({ phase: 'idle', requestId: 2 });
    expect(renderSessionList).toHaveBeenCalledTimes(2);
  });

  it('turns thrown native errors into a structured UI error without rejecting', async () => {
    const harness = compileHarness<{
      refreshCovenSessions: () => Promise<void>;
      discovery: () => ReturnType<typeof PsycheSessions.createCovenDiscoveryState>;
    }>([extractFunctionSource(mainJs, 'refreshCovenSessions')], {
      state: { projects: [{ root: '/alpha' }] },
      invoke: vi.fn().mockRejectedValue(new Error('private daemon payload')),
      renderSessionList: vi.fn(),
      PsycheSessions,
      covenDiscovery: PsycheSessions.createCovenDiscoveryState(),
    }, '{ refreshCovenSessions, discovery: function () { return covenDiscovery; } }');

    await expect(harness.refreshCovenSessions()).resolves.toBeUndefined();
    expect(harness.discovery()).toMatchObject({
      phase: 'error', message: 'Coven sessions could not be loaded', requestId: 1,
    });
    expect(extractFunctionSource(mainJs, 'refreshCovenSessions')).not.toMatch(/console\.|writeToActive/);
  });

  it('ignores an older response after a newer refresh', async () => {
    const first = deferred<{ status: string; sessions: Array<Record<string, string>> }>();
    const second = deferred<{ status: string; sessions: Array<Record<string, string>> }>();
    const invoke = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const harness = compileHarness<{
      refreshCovenSessions: () => Promise<void>;
      discovery: () => ReturnType<typeof PsycheSessions.createCovenDiscoveryState>;
    }>([extractFunctionSource(mainJs, 'refreshCovenSessions')], {
      state: { projects: [{ root: '/alpha' }] }, invoke,
      renderSessionList: vi.fn(), PsycheSessions,
      covenDiscovery: PsycheSessions.createCovenDiscoveryState(),
    }, '{ refreshCovenSessions, discovery: function () { return covenDiscovery; } }');

    const oldRefresh = harness.refreshCovenSessions();
    const newRefresh = harness.refreshCovenSessions();
    second.resolve({ status: 'ready', sessions: [{ id: 'new', projectRoot: '/alpha', status: 'running' }] });
    await newRefresh;
    first.resolve({ status: 'ready', sessions: [{ id: 'old', projectRoot: '/alpha', status: 'running' }] });
    await oldRefresh;

    expect(harness.discovery().requestId).toBe(2);
    expect(harness.discovery().sessionsByProject.get('/alpha')?.[0]?.id).toBe('new');
  });

  it('invalidates an in-flight response before project removal and clears locally', async () => {
    const oldResponse = deferred<{ status: string; sessions: Array<Record<string, string>> }>();
    const project = { id: 'p1', root: '/alpha' };
    const state = {
      activeFileId: null, activeProjectId: project.id, activeThreadId: null,
      openFiles: [], projects: [project], threads: [],
    };
    const harness = compileHarness<{
      refreshCovenSessions: () => Promise<void>;
      removeProject: (id: string) => Promise<boolean>;
      discovery: () => ReturnType<typeof PsycheSessions.createCovenDiscoveryState>;
    }>([
      extractFunctionSource(mainJs, 'refreshCovenSessions'),
      extractFunctionSource(mainJs, 'invalidateCovenDiscovery'),
      extractFunctionSource(mainJs, 'requestCovenRefresh'),
      extractFunctionSource(mainJs, 'removeProject'),
    ], {
      state, invoke: vi.fn().mockReturnValue(oldResponse.promise), renderSessionList: vi.fn(),
      PsycheSessions, covenDiscovery: PsycheSessions.createCovenDiscoveryState(),
      isBootstrapping: false, Promise,
      findProject: () => project, fileNavigationInFlight: false, fileDecisionInFlight: null,
      guardDirtyFiles: async () => true, closeThread: () => undefined,
      fileViewEl: { hidden: true }, terminalHost: { hidden: false, children: [] },
      setActiveProject: async () => true, setStatus: () => undefined,
      refreshTabs: () => undefined, syncProjectBrowser: () => undefined,
      saveWorkspaceSoon: () => undefined,
    }, '{ refreshCovenSessions, removeProject, discovery: function () { return covenDiscovery; } }');

    const refreshing = harness.refreshCovenSessions();
    await harness.removeProject(project.id);
    await Promise.resolve();
    expect(harness.discovery()).toMatchObject({ phase: 'idle' });
    oldResponse.resolve({
      status: 'ready',
      sessions: [{ id: 'late', projectRoot: '/alpha', status: 'running' }],
    });
    await refreshing;
    expect(harness.discovery().phase).toBe('idle');
    expect(harness.discovery().sessionsByProject.size).toBe(0);
  });

  it('runs one visible timer immediately and every 5000ms, then stops and restarts cleanly', async () => {
    vi.useFakeTimers();
    try {
      const refreshCovenSessions = vi.fn().mockResolvedValue(undefined);
      const document = { visibilityState: 'visible' };
      const harness = compileHarness<{
        startCovenPolling: () => void;
        stopCovenPolling: () => void;
      }>([
        extractFunctionSource(mainJs, 'stopCovenPolling'),
        extractFunctionSource(mainJs, 'startCovenPolling'),
      ], {
        document, refreshCovenSessions,
        covenPollTimer: null, COVEN_POLL_MS: 5000,
        setInterval, clearInterval, Promise,
      }, '{ startCovenPolling, stopCovenPolling }');

      harness.startCovenPolling();
      await Promise.resolve();
      expect(refreshCovenSessions).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(refreshCovenSessions).toHaveBeenCalledTimes(2);

      harness.startCovenPolling();
      await Promise.resolve();
      expect(refreshCovenSessions).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(1);

      document.visibilityState = 'hidden';
      harness.startCovenPolling();
      expect(vi.getTimerCount()).toBe(0);
      expect(refreshCovenSessions).toHaveBeenCalledTimes(3);

      document.visibilityState = 'visible';
      harness.startCovenPolling();
      await Promise.resolve();
      expect(refreshCovenSessions).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(1);
      harness.stopCovenPolling();
      harness.stopCovenPolling();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses refresh rejection inside the polling interval', async () => {
    vi.useFakeTimers();
    try {
      const refreshCovenSessions = vi.fn().mockRejectedValue(new Error('render failed'));
      const harness = compileHarness<{ startCovenPolling: () => void }>([
        extractFunctionSource(mainJs, 'stopCovenPolling'),
        extractFunctionSource(mainJs, 'startCovenPolling'),
      ], {
        document: { visibilityState: 'visible' }, refreshCovenSessions,
        covenPollTimer: null, COVEN_POLL_MS: 5000,
        setInterval, clearInterval, Promise,
      }, '{ startCovenPolling }');
      harness.startCovenPolling();
      await vi.advanceTimersByTimeAsync(5000);
      expect(refreshCovenSessions).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves and stops when hidden, then starts polling when visible', () => {
    const document = { visibilityState: 'hidden' };
    const saveWorkspaceNow = vi.fn();
    const stopCovenPolling = vi.fn();
    const startCovenPolling = vi.fn();
    const handleVisibilityChange = compileFunction<() => void>(
      extractFunctionSource(mainJs, 'handleVisibilityChange'),
      { document, saveWorkspaceNow, stopCovenPolling, startCovenPolling }
    );

    handleVisibilityChange();
    expect(saveWorkspaceNow).toHaveBeenCalledOnce();
    expect(stopCovenPolling).toHaveBeenCalledOnce();
    expect(startCovenPolling).not.toHaveBeenCalled();

    document.visibilityState = 'visible';
    handleVisibilityChange();
    expect(saveWorkspaceNow).toHaveBeenCalledOnce();
    expect(stopCovenPolling).toHaveBeenCalledOnce();
    expect(startCovenPolling).toHaveBeenCalledOnce();
    expect(mainJs).toContain(
      'document.addEventListener("visibilitychange", handleVisibilityChange);'
    );
  });

  it('refreshes immediately when a project is added after boot', async () => {
    const requestCovenRefresh = vi.fn();
    const state = { projects: [] as Array<Record<string, unknown>>, activeProjectId: null };
    const addProject = compileFunction<(root: string) => Promise<unknown>>(
      extractFunctionSource(mainJs, 'addProject'), {
        state, settings: { maxProjects: 10 }, HARD_MAX_PROJECTS: 10,
        setStatus: vi.fn(), showTerminalView: async () => true,
        makeProjectId: () => 'p1', restoreProjectLayout: vi.fn(),
        refreshSidebar: vi.fn(), syncProjectBrowser: vi.fn(), saveWorkspaceSoon: vi.fn(),
        refreshProjectWorktrees: vi.fn().mockResolvedValue([]),
        isBootstrapping: false, requestCovenRefresh, setActiveProject: vi.fn(),
      }
    );

    await addProject('/alpha');
    expect(state.projects).toHaveLength(1);
    expect(requestCovenRefresh).toHaveBeenCalledOnce();
  });

  it('restores projects before starting one polling batch at boot', async () => {
    const savedProject = { id: 'p1', root: '/alpha', name: 'alpha' };
    const state = {
      env: null as null | Record<string, string>, projects: [] as Array<typeof savedProject>,
      activeProjectId: null as null | string,
    };
    const addProject = vi.fn();
    const startCovenPolling = vi.fn();
    const harness = compileHarness<{
      boot: (env: Record<string, string>) => Promise<void>;
      bootstrapping: () => boolean;
    }>([
      extractFunctionSource(mainJs, 'completeCovenBoot'),
      extractFunctionSource(mainJs, 'boot'),
    ], {
      state, readSavedWorkspace: () => ({ activeProjectId: 'p1', projects: [savedProject] }),
      sanitizeSavedProject: (project: typeof savedProject) => project,
      settings: { maxProjects: 10 }, HARD_MAX_PROJECTS: 10,
      isRestoringWorkspace: false, isBootstrapping: true,
      activeProject: () => state.projects[0] || null,
      restoreProjectLayout: vi.fn(), addProject, ensureProjectPsyche: vi.fn(),
      currentBrowserTab: () => null, navigateBrowser: vi.fn(),
      refreshSidebar: vi.fn(), refreshTabs: vi.fn(), renderBrowserTabs: vi.fn(),
      syncProjectBrowser: vi.fn(), loadAgentSkills: vi.fn(), saveWorkspaceNow: vi.fn(),
      refreshProjectWorktrees: vi.fn().mockResolvedValue([]),
      startCovenPolling,
    }, '{ boot, bootstrapping: function () { return isBootstrapping; } }');

    await harness.boot({ repo_root: '/fallback' });
    expect(state.projects).toEqual([savedProject]);
    expect(addProject).not.toHaveBeenCalled();
    expect(startCovenPolling).toHaveBeenCalledOnce();
    expect(harness.bootstrapping()).toBe(false);
  });
});

describe('native Coven session attachment', () => {
  it('persists optional Coven identity on created threads', () => {
    const state = { threads: [] as Array<Record<string, unknown>> };
    const createThread = compileFunction<
      (opts: Record<string, unknown>) => Record<string, unknown>
    >(extractFunctionSource(mainJs, 'createThread'), {
      makeThreadId: () => 't1', activeProject: () => null, state,
      activeWorkspaceRoot: () => null,
      refreshSidebar: () => undefined, refreshTabs: () => undefined,
      mountTerminal: () => undefined, focusThread: () => undefined,
      requestAnimationFrame: () => 1, spawnPty: () => undefined,
    });

    const thread = createThread({ project: { id: 'p1' }, covenSessionId: 'safe:1' });
    expect(thread.covenSessionId).toBe('safe:1');
  });

  it('guards the active project terminal view before focusing an existing attachment', async () => {
    const existing = { id: 't1', projectId: 'p1', covenSessionId: 'safe:1', status: 'running' };
    const focusThread = vi.fn();
    const showTerminalView = vi.fn().mockResolvedValue(true);
    const setActiveProject = vi.fn();
    const createThread = vi.fn();
    const openCovenSession = compileFunction<
      (project: { id: string; root: string }, session: { id: string }) => Promise<unknown>
    >(extractFunctionSource(mainJs, 'openCovenSession'), {
      PsycheSessions, setActiveProject,
      state: { activeProjectId: 'p1', threads: [existing] },
      showTerminalView, focusThread, createThread,
    });

    await expect(openCovenSession({ id: 'p1', root: '/alpha' }, { id: 'safe:1' }))
      .resolves.toBe(existing);
    expect(showTerminalView).toHaveBeenCalledOnce();
    expect(setActiveProject).not.toHaveBeenCalled();
    expect(focusThread).toHaveBeenCalledWith('t1');
    expect(createThread).not.toHaveBeenCalled();
    expect(showTerminalView.mock.invocationCallOrder[0]).toBeLessThan(focusThread.mock.invocationCallOrder[0]);
  });

  it('does not focus or create when active-project terminal navigation is denied', async () => {
    const showTerminalView = vi.fn().mockResolvedValue(false);
    const setActiveProject = vi.fn();
    const focusThread = vi.fn();
    const createThread = vi.fn();
    const openCovenSession = compileFunction<
      (project: { id: string; root: string }, session: { id: string }) => Promise<unknown>
    >(extractFunctionSource(mainJs, 'openCovenSession'), {
      PsycheSessions, setActiveProject,
      state: { activeProjectId: 'p1', threads: [{
        id: 't1', projectId: 'p1', covenSessionId: 'safe:1', status: 'running',
      }] },
      showTerminalView, focusThread, createThread,
    });

    await expect(openCovenSession({ id: 'p1', root: '/alpha' }, { id: 'safe:1' }))
      .resolves.toBeNull();
    expect(showTerminalView).toHaveBeenCalledOnce();
    expect(setActiveProject).not.toHaveBeenCalled();
    expect(focusThread).not.toHaveBeenCalled();
    expect(createThread).not.toHaveBeenCalled();
  });

  it('creates a safe attachment with discrete command arguments and a trimmed title', async () => {
    const created = { id: 't2' };
    const createThread = vi.fn().mockReturnValue(created);
    const setActiveProject = vi.fn().mockResolvedValue(true);
    const showTerminalView = vi.fn();
    const openCovenSession = compileFunction<
      (project: { id: string; root: string }, session: { id: string; title?: string }) => Promise<unknown>
    >(extractFunctionSource(mainJs, 'openCovenSession'), {
      PsycheSessions, setActiveProject,
      state: { activeProjectId: 'other', threads: [] },
      showTerminalView, focusThread: vi.fn(), createThread,
    });

    await expect(openCovenSession(
      { id: 'p1', root: '/alpha' }, { id: 'session:7', title: '  Review fix  ' }
    )).resolves.toBe(created);
    expect(createThread).toHaveBeenCalledWith({
      project: { id: 'p1', root: '/alpha' },
      name: 'Review fix',
      kind: 'coven',
      command: 'coven',
      args: ['attach', 'session:7'],
      projectRoot: '/alpha',
      covenSessionId: 'session:7',
    });
    expect(setActiveProject).toHaveBeenCalledOnce();
    expect(setActiveProject).toHaveBeenCalledWith('p1');
    expect(showTerminalView).not.toHaveBeenCalled();
  });

  it('rejects unsafe ids and failed activation without create or focus side effects', async () => {
    const createThread = vi.fn();
    const focusThread = vi.fn();
    const setActiveProject = vi.fn().mockResolvedValue(false);
    const openCovenSession = compileFunction<
      (project: { id: string; root: string } | null, session: { id: string }) => Promise<unknown>
    >(extractFunctionSource(mainJs, 'openCovenSession'), {
      PsycheSessions, setActiveProject,
      state: { activeProjectId: 'other', threads: [] },
      showTerminalView: vi.fn(), focusThread, createThread,
    });

    await expect(openCovenSession({ id: 'p1', root: '/alpha' }, { id: 'bad id; rm' }))
      .resolves.toBeNull();
    expect(setActiveProject).not.toHaveBeenCalled();
    await expect(openCovenSession({ id: 'p1', root: '/alpha' }, { id: 'safe-1' }))
      .resolves.toBeNull();
    expect(createThread).not.toHaveBeenCalled();
    expect(focusThread).not.toHaveBeenCalled();
  });

  it('creates a new attachment when the prior matching thread exited', async () => {
    const createThread = vi.fn().mockReturnValue({ id: 'new' });
    const focusThread = vi.fn();
    const openCovenSession = compileFunction<
      (project: { id: string; root: string }, session: { id: string; title: string }) => Promise<unknown>
    >(extractFunctionSource(mainJs, 'openCovenSession'), {
      PsycheSessions, setActiveProject: async () => true,
      state: { activeProjectId: 'other', threads: [{ id: 'old', projectId: 'p1', covenSessionId: 'safe-1', status: 'exited' }] },
      showTerminalView: vi.fn(), focusThread, createThread,
    });

    await openCovenSession({ id: 'p1', root: '/alpha' }, { id: 'safe-1', title: ' ' });
    expect(focusThread).not.toHaveBeenCalled();
    expect(createThread).toHaveBeenCalledWith(expect.objectContaining({
      name: 'safe-1', command: 'coven', args: ['attach', 'safe-1'],
    }));
  });
});
