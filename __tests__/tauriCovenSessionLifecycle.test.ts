import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as PsycheSessions from '../native/desktop/psyche-build-tauri/web/sessions/session-model.mjs';

const webRoot = join(process.cwd(), 'native/desktop/psyche-build-tauri');
const mainJs = readFileSync(join(webRoot, 'web/main.js'), 'utf8');
const nativeLib = readFileSync(join(webRoot, 'src-tauri/src/lib.rs'), 'utf8');
const sessionModel = readFileSync(join(webRoot, 'web/sessions/session-model.mjs'), 'utf8');

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionSource(source: string, name: string) {
  const match = new RegExp(
    `(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`
  ).exec(source);
  if (!match || match.index === undefined) throw new Error(`missing function ${name}`);

  const bodyStart = source.indexOf('{', match.index + match[0].length);
  if (bodyStart === -1) throw new Error(`missing body for ${name}`);

  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
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

function compileOpenCovenSession<T extends (...args: never[]) => unknown>(
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(
    ...names,
    `"use strict";
     ${functionSource(mainJs, 'waitForTerminalLayout')}
     ${functionSource(mainJs, 'threadCovenSessionId')}
     ${functionSource(mainJs, 'isReusableCovenAttachment')}
     ${functionSource(mainJs, 'findCovenAttachment')}
     ${functionSource(mainJs, 'covenWorktreeForSession')}
     return (${functionSource(mainJs, 'openCovenSession')});`,
  )(...values) as T;
}

function compileOpenWithProjectActivation<T extends (...args: never[]) => unknown>(
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(
    ...names,
    `"use strict";
     const guardActiveFileBoundary = async () => true;
     ${functionSource(mainJs, 'waitForTerminalLayout')}
     ${functionSource(mainJs, 'threadCovenSessionId')}
     ${functionSource(mainJs, 'isReusableCovenAttachment')}
     ${functionSource(mainJs, 'findCovenAttachment')}
     ${functionSource(mainJs, 'covenWorktreeForSession')}
     ${functionSource(mainJs, 'setActiveProject')}
     ${functionSource(mainJs, 'activateProjectWorktree')}
     return (${functionSource(mainJs, 'openCovenSession')});`,
  )(...values) as T;
}

function compileCovenRowAttached<T extends (...args: never[]) => unknown>() {
  return Function(
    `"use strict";
     ${functionSource(mainJs, 'threadCovenSessionId')}
     return (${functionSource(mainJs, 'covenRowAttached')});`,
  )() as T;
}

function attachedThread(overrides: Record<string, any> = {}) {
  return {
    id: 'attached',
    projectId: 'alpha',
    hidden: false,
    closeStarted: false,
    status: 'running',
    worktreePath: '/alpha',
    launch: {
      launchKind: 'coven-attach',
      covenSessionId: 'remote',
      ...(overrides.launch || {}),
    },
    ...overrides,
  };
}

function discoveryHarness(
  projects: Array<Record<string, unknown>>,
  visibilityState = 'visible',
) {
  const requests: Array<{
    command: string;
    args: unknown;
    resolve: (value: unknown) => void;
  }> = [];
  const invoke = (command: string, args: unknown) => new Promise((resolve) => {
    requests.push({ command, args, resolve });
  });
  const statusSamples: Array<Record<string, unknown>> = [];
  let statusRefreshes = 0;
  let now = 1000;
  const performance = { now: () => { now += 25; return now; } };
  const create = new Function(
    'PsycheSessions',
    'invoke',
    'initialProjects',
    'initialVisibilityState',
    'noteStatusCovenSample',
    'refreshStatusController',
    'performance',
    `
      var state = { projects: initialProjects };
      var document = { visibilityState: initialVisibilityState };
      var covenDiscovery = PsycheSessions.createCovenDiscoveryState();
      var covenDiscoveryFlight = null;
      var covenSessionCloseFlights = new Set();
      var covenSessionMutationGeneration = 0;
      function renderSessionList() {}
      function setStatus() {}
      ${functionSource(mainJs, 'covenDiscoveryScopes')}
      ${functionSource(mainJs, 'covenDiscoveryRoots')}
      ${functionSource(mainJs, 'refreshCovenSessions')}
      ${functionSource(mainJs, 'closeCovenSession')}
      return {
        refresh: refreshCovenSessions,
        close: closeCovenSession,
        setProjects: function (projects) { state.projects = projects; },
        setVisibility: function (value) { document.visibilityState = value; },
        discovery: function () { return covenDiscovery; },
      };
    `,
  );
  const harness = create(
    PsycheSessions,
    invoke,
    projects,
    visibilityState,
    (sample: Record<string, unknown>) => { statusSamples.push(sample); },
    () => { statusRefreshes += 1; return Promise.resolve(null); },
    performance,
  );
  return { ...harness, requests, statusSamples, statusRefreshes: () => statusRefreshes } as {
    refresh: (options?: { force?: boolean }) => Promise<unknown>;
    close: (session: { id: string }) => Promise<boolean>;
    setProjects: (projects: Array<Record<string, unknown>>) => void;
    setVisibility: (value: string) => void;
    discovery: () => ReturnType<typeof PsycheSessions.createCovenDiscoveryState>;
    requests: typeof requests;
    statusSamples: typeof statusSamples;
    statusRefreshes: () => number;
  };
}

describe('macOS Coven session lifecycle boundary', () => {
  it('discovers every project and available worktree root in one bounded request', () => {
    const refresh = functionSource(mainJs, 'refreshCovenSessions');
    expect(refresh).toContain('covenDiscoveryRoots()');
    expect(refresh).toContain('invoke("coven_sessions"');
    expect(refresh).toContain('projectRoots: roots');
    expect(refresh).toContain('PsycheSessions.beginCovenRequest');
    expect(refresh).toContain('PsycheSessions.applyCovenResponse');
  });

  it('polls only with visible open projects and invalidates on project removal', () => {
    expect(mainJs).toContain('var COVEN_POLL_MS = 5000;');
    expect(functionSource(mainJs, 'startCovenPolling')).toContain(
      'document.visibilityState === "hidden" || state.projects.length === 0'
    );
    expect(functionSource(mainJs, 'handleVisibilityChange')).toMatch(
      /hidden[\s\S]*saveWorkspaceNow\(\)[\s\S]*stopCovenPolling\(\)/
    );
    expect(functionSource(mainJs, 'handleVisibilityChange')).toMatch(
      /else[\s\S]*startCovenPolling\(\)/
    );
    expect(functionSource(mainJs, 'removeProject')).toContain(
      'PsycheSessions.invalidateCovenRequests'
    );
  });

  it('keeps remote records outside local thread state', () => {
    expect(functionSource(mainJs, 'refreshCovenSessions')).not.toContain('state.threads');
  });

  it('skips a queued refresh after the window hides or the last project closes', async () => {
    const hidden = discoveryHarness([{ root: '/alpha', worktrees: [] }]);
    hidden.setVisibility('hidden');
    const hiddenRefresh = hidden.refresh();
    hidden.requests.forEach((request) => request.resolve({ status: 'ready', sessions: [] }));
    await hiddenRefresh;
    expect(hidden.requests).toHaveLength(0);

    const empty = discoveryHarness([{ root: '/alpha', worktrees: [] }]);
    empty.setProjects([]);
    const emptyRefresh = empty.refresh();
    empty.requests.forEach((request) => request.resolve({ status: 'ready', sessions: [] }));
    await emptyRefresh;
    expect(empty.requests).toHaveLength(0);
  });

  it('allows an explicit forced refresh while hidden', async () => {
    const harness = discoveryHarness([{ root: '/alpha', worktrees: [] }], 'hidden');

    const forced = harness.refresh({ force: true });

    expect(harness.requests.map((request) => request.command)).toEqual(['coven_sessions']);
    harness.requests[0].resolve({ status: 'ready', sessions: [] });
    await forced;
  });

  it('coalesces concurrent forced refreshes for the same owned roots', async () => {
    const harness = discoveryHarness([{ root: '/alpha', worktrees: [] }], 'hidden');

    const first = harness.refresh({ force: true });
    const second = harness.refresh({ force: true });
    expect(harness.requests).toHaveLength(1);

    harness.requests[0].resolve({ status: 'ready', sessions: [] });
    await Promise.resolve();
    expect(harness.requests).toHaveLength(1);
    await Promise.all([first, second]);
  });

  it('coalesces concurrent refreshes for the same owned root set', async () => {
    const harness = discoveryHarness([{
      root: '/alpha',
      worktrees: [{ path: '/alpha-linked', missing: false, prunable: false, bare: false }],
    }]);

    const first = harness.refresh();
    const second = harness.refresh();
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0].args).toEqual({
      projectRoots: ['/alpha', '/alpha-linked'],
      projectScopes: [{
        projectRoot: '/alpha',
        worktreeRoots: ['/alpha-linked'],
      }],
    });
    harness.requests[0].resolve({ status: 'ready', sessions: [] });
    await Promise.all([first, second]);
  });

  it('waits for a pre-kill discovery flight before forcing an authoritative refresh', async () => {
    const harness = discoveryHarness([{ root: '/alpha', worktrees: [] }]);
    const preKill = harness.refresh();
    expect(harness.requests.map((request) => request.command)).toEqual(['coven_sessions']);

    const closing = harness.close({ id: 'coven-1' });
    expect(harness.requests.map((request) => request.command)).toEqual([
      'coven_sessions',
      'coven_session_kill',
    ]);
    harness.requests[1].resolve(null);
    await Promise.resolve();
    expect(harness.requests).toHaveLength(2);

    harness.requests[0].resolve({
      status: 'ready',
      sessions: [{
        id: 'coven-1', projectRoot: '/alpha', status: 'running',
        labels: ['source:psyche-build'],
      }],
    });
    await preKill;
    await Promise.resolve();
    expect(harness.requests.map((request) => request.command)).toEqual([
      'coven_sessions',
      'coven_session_kill',
      'coven_sessions',
    ]);

    harness.requests[2].resolve({ status: 'ready', sessions: [] });
    await expect(closing).resolves.toBe(true);
    expect(harness.discovery().sessionsByProject.get('/alpha') ?? []).toHaveLength(0);
  });

  it('preserves a forced post-kill refresh when visibility changes while awaiting discovery', async () => {
    const harness = discoveryHarness([{ root: '/alpha', worktrees: [] }]);
    const preKill = harness.refresh();
    const closing = harness.close({ id: 'coven-1' });
    harness.requests[1].resolve(null);
    await Promise.resolve();

    harness.setVisibility('hidden');
    harness.requests[0].resolve({
      status: 'ready',
      sessions: [{
        id: 'coven-1', projectRoot: '/alpha', status: 'running',
        labels: ['source:psyche-build'],
      }],
    });
    await preKill;
    await Promise.resolve();

    expect(harness.requests.map((request) => request.command)).toEqual([
      'coven_sessions',
      'coven_session_kill',
      'coven_sessions',
    ]);
    harness.requests[2].resolve({ status: 'ready', sessions: [] });
    await expect(closing).resolves.toBe(true);
    expect(harness.discovery().sessionsByProject.get('/alpha') ?? []).toHaveLength(0);
  });

  it('starts a later discovery after each independently completed kill', async () => {
    const harness = discoveryHarness([{ root: '/alpha', worktrees: [] }]);

    const closeA = harness.close({ id: 'coven-a' });
    expect(harness.requests.map((request) => request.command)).toEqual(['coven_session_kill']);
    harness.requests[0].resolve(null);
    await Promise.resolve();
    expect(harness.requests.map((request) => request.command)).toEqual([
      'coven_session_kill',
      'coven_sessions',
    ]);

    const closeB = harness.close({ id: 'coven-b' });
    expect(harness.requests.map((request) => request.command)).toEqual([
      'coven_session_kill',
      'coven_sessions',
      'coven_session_kill',
    ]);
    harness.requests[2].resolve(null);
    await Promise.resolve();
    expect(harness.requests).toHaveLength(3);

    harness.requests[1].resolve({
      status: 'ready',
      sessions: [
        { id: 'coven-a', projectRoot: '/alpha', status: 'running' },
        { id: 'coven-b', projectRoot: '/alpha', status: 'running' },
      ],
    });
    await vi.waitFor(() => {
      expect(harness.requests.map((request) => request.command)).toEqual([
        'coven_session_kill',
        'coven_sessions',
        'coven_session_kill',
        'coven_sessions',
      ]);
    });

    harness.requests[3].resolve({ status: 'ready', sessions: [] });
    await expect(Promise.all([closeA, closeB])).resolves.toEqual([true, true]);
    expect(harness.requests).toHaveLength(4);
    expect(harness.discovery().sessionsByProject.get('/alpha') ?? []).toHaveLength(0);
  });

  it('coalesces an in-flight ownership set after project and worktree reordering', async () => {
    const harness = discoveryHarness([
      { root: '/alpha', worktrees: [{ path: '/alpha-b' }, { path: '/alpha-a' }] },
      { root: '/beta', worktrees: [] },
    ]);
    const first = harness.refresh();
    harness.setProjects([
      { root: '/beta', worktrees: [] },
      { root: '/alpha', worktrees: [{ path: '/alpha-a' }, { path: '/alpha-b' }] },
    ]);
    const second = harness.refresh();

    expect(harness.requests).toHaveLength(1);
    harness.requests[0].resolve({ status: 'ready', sessions: [] });
    await Promise.all([first, second]);
  });

  it('starts a new request when ownership roots change', async () => {
    const harness = discoveryHarness([{ root: '/alpha', worktrees: [] }]);
    const first = harness.refresh();
    harness.setProjects([{ root: '/beta', worktrees: [] }]);
    const second = harness.refresh();

    expect(harness.requests).toHaveLength(2);
    harness.requests[1].resolve({ status: 'ready', sessions: [] });
    harness.requests[0].resolve({ status: 'ready', sessions: [] });
    await Promise.all([first, second]);
  });

  it('ignores a late response from an older ownership-root request', async () => {
    const harness = discoveryHarness([{ root: '/alpha', worktrees: [] }]);
    const first = harness.refresh();
    harness.setProjects([{ root: '/beta', worktrees: [] }]);
    const second = harness.refresh();

    harness.requests[1].resolve({
      status: 'ready',
      sessions: [{
        id: 'new', projectRoot: '/beta', status: 'running', labels: ['source:psyche-build'],
      }],
    });
    await second;
    harness.requests[0].resolve({
      status: 'ready',
      sessions: [{
        id: 'old', projectRoot: '/alpha', status: 'running', labels: ['source:psyche-build'],
      }],
    });
    await first;

    expect(harness.discovery().sessionsByProject.has('/alpha')).toBe(false);
    expect(harness.discovery().sessionsByProject.get('/beta')?.[0].id).toBe('new');
  });

  it('reports footer Coven health only for the request that still owns discovery state', async () => {
    {
      const harness = discoveryHarness([{ root: '/alpha', worktrees: [] }]);
      const first = harness.refresh();
      harness.setProjects([{ root: '/beta', worktrees: [] }]);
      const second = harness.refresh();

      harness.requests[1].resolve({
        status: 'error',
        sessions: [],
        message: 'new fail',
      });
      await second;
      harness.requests[0].resolve({
        status: 'ready',
        sessions: [{ id: 'old', projectRoot: '/alpha', status: 'running' }],
      });
      await first;

      expect(harness.statusSamples).toEqual([
        expect.objectContaining({
          phase: 'error',
          error: 'new fail',
          refreshedAt: expect.any(Number),
          latencyMs: expect.any(Number),
        }),
      ]);
      expect(harness.statusRefreshes()).toBe(1);
    }

    {
      const harness = discoveryHarness([{ root: '/alpha', worktrees: [] }]);
      const first = harness.refresh();
      harness.setProjects([{ root: '/beta', worktrees: [] }]);
      const second = harness.refresh();

      harness.requests[1].resolve({
        status: 'ready',
        sessions: [{ id: 'new', projectRoot: '/beta', status: 'running' }],
      });
      await second;
      harness.requests[0].resolve(Promise.reject(new Error('stale fail')));
      await first;

      expect(harness.statusSamples).toEqual([
        expect.objectContaining({
          phase: 'ready',
          error: '',
          refreshedAt: expect.any(Number),
          latencyMs: expect.any(Number),
        }),
      ]);
      expect(harness.statusRefreshes()).toBe(1);
    }
  });

  it('retains stored local Coven identity when creating threads', () => {
    const source = functionSource(mainJs, 'createThread');
    expect(source).toContain('covenSessionId: opts.covenSessionId || null');
    expect(source).toContain('metricsProvider: opts.metricsProvider || null');
  });

  it('keeps native Coven create and attach outside daemon/tmux mutation paths', () => {
    const create = functionSource(mainJs, 'covenChatLaunch');
    const attach = functionSource(mainJs, 'openCovenSession');
    const nativeCovenSource = `${create}\n${attach}`;
    expect(nativeCovenSource).not.toMatch(
      /coven\.session\.open|openProjectCovenSession|createTmuxPane|sendTmuxCommand|TMUX_TMPDIR/
    );
    expect(nativeCovenSource).toContain('args: ["code", "--session-id", sessionId]');
    expect(nativeCovenSource).toContain('args: ["attach", session.id]');
  });

  it('reserves attach identity and releases it on settle', () => {
    const source = functionSource(mainJs, 'openCovenSession');
    expect(mainJs).toContain('var covenAttachInFlight = new Map();');
    expect(source).toContain('covenAttachInFlight.set(key, opening)');
    expect(source).toContain('PsycheSessions.isSafeCovenSessionId(session.id)');
    expect(source).toContain('args: ["attach", session.id]');
    expect(source).toContain('launchKind: "coven-attach"');
    expect(source).toContain('covenSessionId: session.id');
    expect(source).toContain('metricsProvider: session.harness || "coven"');
    expect(source).toContain('.finally(function ()');
    expect(source).not.toMatch(/coven\.session\.open|openProjectCovenSession|tmux/i);
  });

  it('focuses or reopens an existing attachment before reserving a new one', () => {
    const source = functionSource(mainJs, 'openCovenSession');
    expect(source.indexOf('existing.hidden')).toBeLessThan(source.indexOf('covenAttachInFlight.set'));
    expect(source.indexOf('focusThread(existing.id)')).toBeLessThan(
      source.indexOf('covenAttachInFlight.set'),
    );
  });

  it('defines its terminal layout wait in production with one animation frame', async () => {
    const source = functionSource(mainJs, 'waitForTerminalLayout');
    expect(source).toContain('return new Promise(function (resolve)');
    expect(source).toContain('requestAnimationFrame(resolve)');
    let frameCalls = 0;
    const waitForTerminalLayout = compileFunction<() => Promise<void>>(source, {
      requestAnimationFrame: (callback: () => void) => { frameCalls += 1; callback(); },
    });
    await expect(waitForTerminalLayout()).resolves.toBeUndefined();
    expect(frameCalls).toBe(1);
  });

  it('coalesces attach calls before project switching or pane creation begins', async () => {
    const project = {
      id: 'alpha', root: '/alpha', selectedWorktreePath: '/alpha',
      worktrees: [{ path: '/alpha', is_main: true }],
    };
    const session = {
      id: 'remote', projectRoot: '/alpha', cwd: '/alpha', title: 'Durable session',
    };
    let resolveProject: ((value: boolean) => void) | null = null;
    let resolveCreate: ((value: unknown) => void) | null = null;
    let projectSwitches = 0;
    let creates = 0;
    let createdOptions: Record<string, unknown> | null = null;
    const state = {
      env: { coven_path: '/bin/coven' }, activeProjectId: 'other', threads: [],
    };
    const covenAttachInFlight = new Map<string, Promise<unknown>>();
    const covenAttachKey = compileFunction<(p: typeof project, s: typeof session) => string>(
      functionSource(mainJs, 'covenAttachKey'), {},
    );
    const openCovenSession = compileOpenCovenSession<(
      p: typeof project, s: typeof session,
    ) => Promise<unknown>>({
      PsycheSessions,
      state,
      setStatus: () => undefined,
      activateProjectWorktree: (_project: typeof project, path: string) => {
        projectSwitches += 1;
        project.selectedWorktreePath = path;
        return new Promise<boolean>((resolve) => { resolveProject = resolve; });
      },
      requestAnimationFrame: (callback: () => void) => callback(),
      reopenThread: () => true,
      focusThread: async () => undefined,
      covenAttachKey,
      covenAttachInFlight,
      selectedWorktree: () => project.worktrees[0],
      createThread: (options: Record<string, unknown>) => {
        creates += 1;
        createdOptions = options;
        return new Promise((resolve) => { resolveCreate = resolve; });
      },
    });

    const first = openCovenSession(project, session);
    const second = openCovenSession(project, session);
    expect(second).toBe(first);
    expect(covenAttachInFlight.size).toBe(1);
    expect({ projectSwitches, creates }).toEqual({ projectSwitches: 0, creates: 0 });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ projectSwitches, creates }).toEqual({ projectSwitches: 1, creates: 0 });
    (resolveProject as unknown as (value: boolean) => void)(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(creates).toBe(1);
    expect(createdOptions).toMatchObject({
      project,
      name: 'Durable session',
      kind: 'coven-attach',
      command: '/bin/coven',
      args: ['attach', 'remote'],
      projectRoot: '/alpha',
      cwd: '/alpha',
      worktreePath: '/alpha',
      launchKind: 'coven-attach',
      covenSessionId: 'remote',
    });
    const created = { id: 'attached' };
    (resolveCreate as unknown as (value: unknown) => void)(created);
    await expect(first).resolves.toBe(created);
    expect(covenAttachInFlight.size).toBe(0);
  });

  it('reuses an attached session after the reservation settles', async () => {
    const project = {
      id: 'alpha', root: '/alpha', selectedWorktreePath: '/alpha',
      worktrees: [{ path: '/alpha' }],
    };
    const session = {
      id: 'remote', projectRoot: '/alpha', cwd: '/alpha', title: 'Durable session',
    };
    const state = {
      env: { coven_path: '/bin/coven' }, activeProjectId: 'alpha',
      threads: [] as Array<Record<string, any>>,
    };
    const covenAttachInFlight = new Map<string, Promise<unknown>>();
    const covenAttachKey = compileFunction<(p: typeof project, s: typeof session) => string>(
      functionSource(mainJs, 'covenAttachKey'), {},
    );
    let nextThreadId = 0;
    let createCalls = 0;
    const createThread = compileFunction<(options: Record<string, any>) => Record<string, any>>(
      functionSource(mainJs, 'createThread'),
      {
        makeThreadId: () => `thread-${nextThreadId += 1}`,
        activeProject: () => project,
        activeWorkspaceRoot: () => project.selectedWorktreePath,
        preparePanePlacement: () => ({ key: 'layout', value: {} }),
        setStatus: () => undefined,
        commitPanePlacement: () => undefined,
        state,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        mountTerminal: () => undefined,
        focusThread: () => undefined,
        requestAnimationFrame: () => undefined,
        isLiveThread: () => true,
        spawnPty: () => undefined,
      },
    );
    const openCovenSession = compileOpenCovenSession<(
      p: typeof project, s: typeof session,
    ) => Promise<Record<string, any> | null>>({
      PsycheSessions,
      state,
      setStatus: () => undefined,
      activateProjectWorktree: async (_project: typeof project, path: string) => {
        project.selectedWorktreePath = path;
        return true;
      },
      requestAnimationFrame: (callback: () => void) => callback(),
      reopenThread: () => true,
      focusThread: async () => true,
      covenAttachKey,
      covenAttachInFlight,
      selectedWorktree: () => project.worktrees[0],
      createThread: (options: Record<string, any>) => {
        createCalls += 1;
        return createThread(options);
      },
    });

    const first = await openCovenSession(project, session);
    expect(first?.launch).toMatchObject({
      launchKind: 'coven-attach',
      covenSessionId: 'remote',
    });
    expect(covenAttachInFlight.size).toBe(0);

    const second = await openCovenSession(project, session);
    expect(second).toBe(first);
    expect(createCalls).toBe(1);
    expect(state.threads).toHaveLength(1);
  });

  it.each(['exited', 'failed'])(
    'creates a new attachment when the canonical prior attachment is %s',
    async (status) => {
    const project = {
      id: 'alpha', root: '/alpha', selectedWorktreePath: '/alpha',
      worktrees: [{ path: '/alpha', is_main: true }],
    };
    const session = {
      id: 'remote', projectRoot: '/alpha', cwd: '/alpha', title: 'Durable session',
    };
    const stale = attachedThread({ id: 'stale-attachment', status });
    const state = {
      env: { coven_path: '/bin/coven' }, activeProjectId: 'alpha', threads: [stale],
    };
    let creates = 0;
    let focuses = 0;
    const openCovenSession = compileOpenCovenSession<(
      p: typeof project, s: typeof session,
    ) => Promise<unknown>>({
      PsycheSessions,
      state,
      setStatus: () => undefined,
      activateProjectWorktree: async () => true,
      requestAnimationFrame: (callback: () => void) => callback(),
      reopenThread: () => true,
      focusThread: async () => { focuses += 1; return true; },
      covenAttachKey: () => 'alpha\nremote',
      covenAttachInFlight: new Map(),
      selectedWorktree: () => project.worktrees[0],
      createThread: () => { creates += 1; return { id: 'replacement' }; },
    });

    await expect(openCovenSession(project, session)).resolves.toEqual({ id: 'replacement' });
    expect({ creates, focuses }).toEqual({ creates: 1, focuses: 0 });
    },
  );

  it('selects the most-specific owned worktree for an overlapping session cwd', async () => {
    const project = {
      id: 'alpha', root: '/repo', selectedWorktreePath: '/repo',
      worktrees: [{ path: '/repo' }, { path: '/repo/feature' }],
    };
    const session = {
      id: 'remote', projectRoot: '/repo', cwd: '/repo/feature/packages/app',
      harness: 'codex',
    };
    let createdOptions: Record<string, unknown> | null = null;
    const openCovenSession = compileOpenCovenSession<(
      p: typeof project, s: typeof session,
    ) => Promise<unknown>>({
      PsycheSessions,
      state: { env: { coven_path: '/bin/coven' }, activeProjectId: 'alpha', threads: [] },
      setStatus: () => undefined,
      activateProjectWorktree: async (_project: typeof project, path: string) => {
        project.selectedWorktreePath = path;
        return true;
      },
      requestAnimationFrame: (callback: () => void) => callback(),
      covenAttachKey: () => 'alpha\nremote',
      covenAttachInFlight: new Map(),
      selectedWorktree: () => project.worktrees[0],
      createThread: (options: Record<string, unknown>) => {
        createdOptions = options;
        return { id: 'attached' };
      },
    });

    await expect(openCovenSession(project, session)).resolves.toEqual({ id: 'attached' });
    expect(createdOptions).toMatchObject({
      cwd: '/repo/feature/packages/app',
      worktreePath: '/repo/feature',
      metricsProvider: 'codex',
    });
  });

  it('marks nested-launch attachments as focus targets in session rows', () => {
    const covenRowAttached = compileCovenRowAttached<(
      state: { threads: unknown[] }, projectId: string, sessionId: string,
    ) => boolean>();

    expect(covenRowAttached({ threads: [attachedThread()] }, 'alpha', 'remote')).toBe(true);
    expect(covenRowAttached({ threads: [attachedThread({ closeStarted: true })] }, 'alpha', 'remote'))
      .toBe(false);
    expect(covenRowAttached({ threads: [attachedThread()] }, 'beta', 'remote')).toBe(false);
    expect(covenRowAttached({ threads: [attachedThread({ status: 'exited' })] }, 'alpha', 'remote'))
      .toBe(false);
    expect(covenRowAttached({ threads: [attachedThread({ status: 'failed' })] }, 'alpha', 'remote'))
      .toBe(false);
  });

  it('renders coven session rows through the sidebar tree, not a bespoke row builder', () => {
    expect(mainJs).not.toContain('function createCovenSessionRow(');
    expect(mainJs).toContain('covenRowAttached(state, project.id, rowModel.id)');
  });

  it('activates the exact worktree before reopening and focusing an existing attachment', async () => {
    const project = {
      id: 'alpha', root: '/alpha', selectedWorktreePath: '/alpha',
      worktrees: [{ path: '/alpha' }, { path: '/alpha-feature' }],
    };
    const session = { id: 'remote', projectRoot: '/alpha' };
    const existing = attachedThread({ hidden: true, worktreePath: '/alpha-feature' });
    const state = {
      env: { coven_path: '/bin/coven' }, activeProjectId: 'alpha', threads: [existing],
    };
    const calls: string[] = [];
    const openCovenSession = compileOpenCovenSession<(
      p: typeof project, s: typeof session,
    ) => Promise<unknown>>({
      PsycheSessions,
      state,
      setStatus: () => undefined,
      findThread: (id: string) => state.threads.find((thread) => thread.id === id) || null,
      activateProjectWorktree: async (_project: typeof project, path: string) => {
        calls.push(`activate:${path}`);
        project.selectedWorktreePath = path;
        return true;
      },
      requestAnimationFrame: (callback: () => void) => { calls.push('layout'); callback(); },
      reopenThread: () => { calls.push('reopen'); return true; },
      focusThread: async () => { calls.push('focus'); return true; },
      covenAttachKey: () => 'unused',
      covenAttachInFlight: new Map(),
      selectedWorktree: () => project.worktrees[0],
      createThread: () => { throw new Error('must not create'); },
    });

    await expect(openCovenSession(project, session)).resolves.toBe(existing);
    expect(calls).toEqual(['activate:/alpha-feature', 'layout', 'reopen', 'focus']);
    expect(project.selectedWorktreePath).toBe('/alpha-feature');
  });

  it('abandons an existing attachment that closes during its worktree switch', async () => {
    const project = { id: 'alpha', root: '/alpha', worktrees: [{ path: '/alpha-feature' }] };
    const session = { id: 'remote', projectRoot: '/alpha' };
    const existing = attachedThread({ hidden: true, worktreePath: '/alpha-feature' });
    const state = {
      env: { coven_path: '/bin/coven' }, activeProjectId: 'alpha', threads: [existing],
    };
    let resolveActivation: ((value: boolean) => void) | null = null;
    let reopened = 0;
    let focused = 0;
    const openCovenSession = compileOpenCovenSession<(
      p: typeof project, s: typeof session,
    ) => Promise<unknown>>({
      PsycheSessions,
      state,
      setStatus: () => undefined,
      findThread: (id: string) => state.threads.find((thread) => thread.id === id) || null,
      activateProjectWorktree: () => new Promise<boolean>((resolve) => {
        resolveActivation = resolve;
      }),
      requestAnimationFrame: (callback: () => void) => callback(),
      reopenThread: () => { reopened += 1; return true; },
      focusThread: async () => { focused += 1; return true; },
      covenAttachKey: () => 'unused',
      covenAttachInFlight: new Map(),
    });

    const opening = openCovenSession(project, session);
    await new Promise((resolve) => setTimeout(resolve, 0));
    existing.closeStarted = true;
    state.threads = [];
    (resolveActivation as unknown as (value: boolean) => void)(true);
    await expect(opening).resolves.toBeNull();
    expect({ reopened, focused }).toEqual({ reopened: 0, focused: 0 });
  });

  it('returns null when an existing attachment cannot be focused', async () => {
    const project = { id: 'alpha', root: '/alpha', worktrees: [{ path: '/alpha' }] };
    const session = { id: 'remote', projectRoot: '/alpha' };
    const existing = attachedThread();
    const state = {
      env: { coven_path: '/bin/coven' }, activeProjectId: 'alpha', threads: [existing],
    };
    const openCovenSession = compileOpenCovenSession<(
      p: typeof project, s: typeof session,
    ) => Promise<unknown>>({
      PsycheSessions,
      state,
      setStatus: () => undefined,
      findThread: () => existing,
      activateProjectWorktree: async () => true,
      requestAnimationFrame: (callback: () => void) => callback(),
      reopenThread: () => true,
      focusThread: async () => false,
      covenAttachKey: () => 'unused',
      covenAttachInFlight: new Map(),
    });

    await expect(openCovenSession(project, session)).resolves.toBeNull();
  });

  it('does not launch default Coven while selecting an inactive hidden attachment', async () => {
    const project = {
      id: 'alpha', root: '/alpha', selectedWorktreePath: '/alpha',
      worktrees: [{ path: '/alpha' }, { path: '/alpha-feature' }],
    };
    const session = { id: 'remote', projectRoot: '/alpha' };
    const existing = attachedThread({ hidden: true, worktreePath: '/alpha-feature' });
    const state = {
      env: { coven_path: '/bin/coven' }, activeProjectId: 'other', activeThreadId: null,
      threads: [existing],
    };
    const openCovenSession = compileOpenWithProjectActivation<(
      p: typeof project, s: typeof session,
    ) => Promise<unknown>>({
      PsycheSessions,
      state,
      setStatus: () => undefined,
      showTerminalView: async () => true,
      findProject: () => project,
      restoreProjectLayout: () => undefined,
      clearPassiveCovenPaneFocus: () => undefined,
      loadAgentSkills: () => undefined,
      activeWorkspaceRoot: () => project.selectedWorktreePath,
      focusThread: async () => true,
      renderPaneWorkspace: () => undefined,
      renderGitSurface: () => false,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      syncProjectBrowser: () => undefined,
      saveWorkspaceSoon: () => undefined,
      activatePaneLayoutFocus: () => undefined,
      renderPanel: () => undefined,
      currentPanel: () => 'browser',
      requestAnimationFrame: (callback: () => void) => callback(),
      reopenThread: () => true,
      covenAttachKey: () => 'unused',
      covenAttachInFlight: new Map(),
    });
    await expect(openCovenSession(project, session)).resolves.toBe(existing);
    expect(project.selectedWorktreePath).toBe('/alpha-feature');
  });

  it('does not launch default Coven while creating an attachment in an inactive project', async () => {
    const project = {
      id: 'alpha', root: '/repo', selectedWorktreePath: '/repo',
      worktrees: [{ path: '/repo' }, { path: '/repo/feature' }],
    };
    const session = {
      id: 'remote', projectRoot: '/repo', cwd: '/repo/feature/packages/app',
    };
    const state = {
      env: { coven_path: '/bin/coven' }, activeProjectId: 'other', activeThreadId: null,
      threads: [],
    };
    let createdOptions: Record<string, unknown> | null = null;
    const openCovenSession = compileOpenWithProjectActivation<(
      p: typeof project, s: typeof session,
    ) => Promise<unknown>>({
      PsycheSessions,
      state,
      setStatus: () => undefined,
      showTerminalView: async () => true,
      findProject: () => project,
      restoreProjectLayout: () => undefined,
      clearPassiveCovenPaneFocus: () => undefined,
      loadAgentSkills: () => undefined,
      activeWorkspaceRoot: () => project.selectedWorktreePath,
      focusThread: async () => true,
      renderPaneWorkspace: () => undefined,
      renderGitSurface: () => false,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      syncProjectBrowser: () => undefined,
      saveWorkspaceSoon: () => undefined,
      activatePaneLayoutFocus: () => undefined,
      renderPanel: () => undefined,
      currentPanel: () => 'browser',
      requestAnimationFrame: (callback: () => void) => callback(),
      reopenThread: () => true,
      covenAttachKey: () => 'alpha\nremote',
      covenAttachInFlight: new Map(),
      selectedWorktree: () => project.worktrees[0],
      createThread: (options: Record<string, unknown>) => {
        createdOptions = options;
        return { id: 'attached' };
      },
    });
    await expect(openCovenSession(project, session)).resolves.toEqual({ id: 'attached' });
    expect(project.selectedWorktreePath).toBe('/repo/feature');
    expect(createdOptions).toMatchObject({ worktreePath: '/repo/feature' });
  });

  it('rejects invalid or unavailable attach targets before reservation', async () => {
    const project = { id: 'alpha', root: '/alpha', worktrees: [{ path: '/alpha' }] };
    const statuses: string[] = [];
    const covenAttachInFlight = new Map();
    const openCovenSession = compileOpenCovenSession<(
      p: typeof project, s: { id: string },
    ) => Promise<unknown>>({
      PsycheSessions,
      state: { env: {}, activeProjectId: null, threads: [] },
      setStatus: (message: string) => { statuses.push(message); },
      showTerminalView: () => { throw new Error('must not switch'); },
      covenAttachKey: () => { throw new Error('must not reserve'); },
      covenAttachInFlight,
    });

    await expect(openCovenSession(project, { id: '../unsafe' })).resolves.toBeNull();
    await expect(openCovenSession(project, { id: 'safe-id' })).resolves.toBeNull();
    expect(covenAttachInFlight.size).toBe(0);
    expect(statuses).toEqual([
      'Invalid Coven session',
      'Coven CLI not found — install @opencoven/cli and restart Psyche',
    ]);
  });

  it('retains native discovery and the session model adapter', () => {
    expect(nativeLib).toContain('coven_sessions,');
    expect(sessionModel).toContain('export function createCovenDiscoveryState');
    expect(mainJs).toContain(
      'document.addEventListener("visibilitychange", handleVisibilityChange);'
    );
  });
});
