import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPtyClient,
  disposePtyClient,
  routePtyBatch,
} from '../native/desktop/psyche-build-tauri/web/runtime/pty-client';

const repoRoot = process.cwd();
const libRs = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8',
);
const mainJs = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
);
const COVEN_SESSION_ID = '12345678-1234-4abc-8def-1234567890ab';
const DUPLICATE_COVEN_SESSION_ID = '87654321-4321-4cba-8fed-0987654321ba';
const runtimeThreadIds = new Set<string>();

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
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises(times = 2) {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

afterEach(() => {
  runtimeThreadIds.forEach((threadId) => disposePtyClient(threadId));
  runtimeThreadIds.clear();
  vi.restoreAllMocks();
});

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

describe('Tauri Coven launch project scope', () => {
  it('registers the canonical project path command and requires validated PTY roots', () => {
    expect(libRs).toMatch(/fn canonical_project_path\s*\(\s*root\s*:\s*String\s*\)/);
    expect(libRs).toMatch(/tauri::generate_handler!\s*\[[\s\S]*canonical_project_path\s*,/);
    expect(libRs).toMatch(/pub cwd:\s*Option<String>/);
    expect(libRs).toMatch(/pub launch_kind:\s*Option<String>/);
    expect(libRs).toMatch(/pub coven_session_id:\s*Option<String>/);
    expect(libRs).toMatch(/pub coven_path:\s*Option<String>/);
    expect(libRs).toMatch(/fn validate_coven_launch_with\s*\(/);
    expect(libRs).toMatch(/fn validate_coven_launch\s*\(/);

    const ptyStart = libRs.slice(
      libRs.indexOf('fn pty_start'),
      libRs.indexOf('#[tauri::command]', libRs.indexOf('fn pty_start') + 1),
    );
    expect(ptyStart).toContain('prepare_pty_start(&options)');
    expect(ptyStart).toContain('validate_coven_launch(&options)');
    expect(ptyStart.indexOf('prepare_pty_start(&options)')).toBeLessThan(
      ptyStart.indexOf('validate_coven_launch(&options)'),
    );
    expect(ptyStart.indexOf('validate_coven_launch(&options)')).toBeLessThan(
      ptyStart.indexOf('.openpty('),
    );
    expect(ptyStart).toContain('resolved_cwd.configure_command_cwd(&mut cmd)');
    const prepareStart = libRs.slice(
      libRs.indexOf('fn prepare_pty_start'),
      libRs.indexOf('#[tauri::command]', libRs.indexOf('fn prepare_pty_start')),
    );
    expect(prepareStart.indexOf('PendingPtyStart::reserve')).toBeLessThan(
      prepareStart.indexOf('projectRoot is required'),
    );
  });

  it('canonicalizes before project deduplication and reports unavailable paths', () => {
    const canonical = functionSource('canonicalProjectPath');
    expect(canonical).toContain('invoke("canonical_project_path"');
    expect(canonical).toContain('Project path is unavailable: ');
    expect(canonical).toContain('return null');

    const addProject = functionSource('addProject');
    const canonicalize = addProject.indexOf('await canonicalProjectPath(rootPath)');
    const deduplicate = addProject.indexOf('state.projects.find');
    expect(canonicalize).toBeGreaterThanOrEqual(0);
    expect(deduplicate).toBeGreaterThan(canonicalize);
  });

  it('canonicalizes saved roots concurrently before restoring projects', () => {
    const boot = functionSource('boot');
    expect(boot).toContain('restoreSavedProjects');

    const canonicalize = boot.indexOf('restoreSavedProjects');
    const discover = boot.indexOf('refreshProjectWorktrees');
    expect(canonicalize).toBeGreaterThanOrEqual(0);
    expect(discover).toBeGreaterThan(canonicalize);
  });

  it('passively restores a saved workspace without launching Coven', async () => {
    const saved = {
      activeProjectId: 'restored-a',
      projects: [
        { id: 'saved-a', root: '/saved/a' },
        { id: 'saved-b', root: '/saved/b' },
      ],
    };
    const restoredProjects = [
      {
        id: 'restored-a',
        root: '/repo/a',
        selectedWorktreePath: '/repo/a/worktrees/feature-a',
        worktrees: [
          { path: '/repo/a', collapsed: false },
          { path: '/repo/a/worktrees/feature-a', collapsed: true },
        ],
        layout: { mode: 'split', side: 'right', splitFrac: 0.62 },
        browsersByWorktree: {},
      },
      {
        id: 'restored-b',
        root: '/repo/b',
        selectedWorktreePath: '/repo/b',
        worktrees: [{ path: '/repo/b', collapsed: false }],
        layout: { mode: 'terminal', side: 'right', splitFrac: 0.6 },
        browsersByWorktree: {},
      },
    ];
    const calls: string[] = [];
    const refreshes = new Map(
      restoredProjects.map((project) => [project.id, deferred<void>()]),
    );
    const state = {
      env: {},
      projects: [] as Array<Record<string, any>>,
      activeProjectId: null as string | null,
    };
    let addProjectRoot: string | null = null;
    let ensureProjectCovenCalls = 0;
    const boot = compileFunction<(env: Record<string, string>) => Promise<void>>(
      functionSource('boot'),
      {
        state,
        installTerminalImageDrop: async () => { calls.push('installTerminalImageDrop'); },
        statusController: null,
        loadSavedWorkspace: async () => saved,
        settings: { maxProjects: 5 },
        HARD_MAX_PROJECTS: 10,
        isRestoringWorkspace: false,
        restoreSavedProjects: async (
          projects: Array<Record<string, unknown>>,
          activeProjectId: string,
          limit: number,
        ) => {
          calls.push(`restoreSavedProjects:${projects.length}:${activeProjectId}:${limit}`);
          return { projects: restoredProjects, activeProjectId: 'restored-a' };
        },
        activeProject: () => {
          calls.push('activeProject');
          return state.projects.find((project) => project.id === state.activeProjectId) || null;
        },
        restoreProjectLayout: (project: { id: string }) => { calls.push(`restoreProjectLayout:${project.id}`); },
        refreshProjectWorktrees: (project: { id: string }) => {
          calls.push(`refreshProjectWorktrees:${project.id}`);
          const refresh = refreshes.get(project.id);
          if (!refresh) throw new Error(`missing refresh for ${project.id}`);
          return refresh.promise;
        },
        addProject: async (root: string) => {
          addProjectRoot = root;
          calls.push(`addProject:${root}`);
          return null;
        },
        currentBrowserTab: (project: { id: string } | null) => {
          calls.push(`currentBrowserTab:${project ? project.id : 'null'}`);
          return null;
        },
        navigateBrowser: () => { throw new Error('navigateBrowser should not run'); },
        refreshSidebar: () => { calls.push('refreshSidebar'); },
        refreshTabs: () => { calls.push('refreshTabs'); },
        renderBrowserTabs: () => { calls.push('renderBrowserTabs'); },
        syncProjectBrowser: () => { calls.push('syncProjectBrowser'); },
        loadAgentSkills: () => { calls.push('loadAgentSkills'); },
        saveWorkspaceNow: () => { calls.push('saveWorkspaceNow'); },
        startCovenPolling: () => { calls.push('startCovenPolling'); },
        paneMetricsPollTimer: 0,
        clearInterval: () => { calls.push('clearInterval'); },
        setInterval: (_callback: () => void, ms: number) => {
          calls.push(`setInterval:${ms}`);
          return 1;
        },
        refreshVisiblePaneMetrics: () => { calls.push('refreshVisiblePaneMetrics'); },
        refreshStatusController: null,
        ensureProjectCoven: async () => {
          ensureProjectCovenCalls += 1;
          throw new Error('ensureProjectCoven must not run');
        },
      },
    );

    let bootSettled = false;
    const bootPromise = boot({ repo_root: '/boot/root', home: '/home/tester' })
      .finally(() => { bootSettled = true; });
    await flushPromises();

    expect(ensureProjectCovenCalls).toBe(0);
    expect(addProjectRoot).toBeNull();
    expect(state.env).toEqual({ repo_root: '/boot/root', home: '/home/tester' });
    expect(state.projects).toEqual(restoredProjects);
    expect(state.activeProjectId).toBe('restored-a');
    expect(calls).toEqual([
      'installTerminalImageDrop',
      'restoreSavedProjects:2:restored-a:5',
      'activeProject',
      'restoreProjectLayout:restored-a',
      'refreshProjectWorktrees:restored-a',
      'refreshProjectWorktrees:restored-b',
    ]);
    expect(bootSettled).toBe(false);
    expect(calls).not.toContain('currentBrowserTab:restored-a');
    expect(calls).not.toContain('refreshSidebar');
    expect(calls).not.toContain('refreshTabs');
    expect(calls).not.toContain('renderBrowserTabs');
    expect(calls).not.toContain('syncProjectBrowser');
    expect(calls).not.toContain('loadAgentSkills');
    expect(calls).not.toContain('saveWorkspaceNow');
    expect(calls).not.toContain('startCovenPolling');

    refreshes.get('restored-a')!.resolve();
    await flushPromises();

    expect(calls).toEqual([
      'installTerminalImageDrop',
      'restoreSavedProjects:2:restored-a:5',
      'activeProject',
      'restoreProjectLayout:restored-a',
      'refreshProjectWorktrees:restored-a',
      'refreshProjectWorktrees:restored-b',
    ]);
    expect(bootSettled).toBe(false);
    expect(calls).not.toContain('currentBrowserTab:restored-a');
    expect(calls).not.toContain('refreshSidebar');
    expect(calls).not.toContain('refreshTabs');
    expect(calls).not.toContain('renderBrowserTabs');
    expect(calls).not.toContain('syncProjectBrowser');
    expect(calls).not.toContain('loadAgentSkills');
    expect(calls).not.toContain('saveWorkspaceNow');
    expect(calls).not.toContain('startCovenPolling');

    refreshes.get('restored-b')!.resolve();
    await bootPromise;

    expect(calls).toEqual([
      'installTerminalImageDrop',
      'restoreSavedProjects:2:restored-a:5',
      'activeProject',
      'restoreProjectLayout:restored-a',
      'refreshProjectWorktrees:restored-a',
      'refreshProjectWorktrees:restored-b',
      'currentBrowserTab:restored-a',
      'restoreProjectLayout:restored-a',
      'refreshSidebar',
      'refreshTabs',
      'renderBrowserTabs',
      'syncProjectBrowser',
      'loadAgentSkills',
      'saveWorkspaceNow',
      'startCovenPolling',
      'setInterval:15000',
      'refreshVisiblePaneMetrics',
    ]);
    expect(bootSettled).toBe(true);
    expect(calls.indexOf('startCovenPolling')).toBeGreaterThan(
      calls.indexOf('refreshProjectWorktrees:restored-b'),
    );
  });

  it('passively boots the repo root without launching Coven when no workspace is saved', async () => {
    const project = {
      id: 'fresh-project',
      root: '/repo/root',
      selectedWorktreePath: '/repo/root',
      worktrees: [{ path: '/repo/root', collapsed: false }],
      layout: { mode: 'terminal', side: 'right', splitFrac: 0.6 },
      browsersByWorktree: {},
    };
    const calls: string[] = [];
    const state = {
      env: {},
      projects: [] as Array<Record<string, any>>,
      activeProjectId: null as string | null,
    };
    let addProjectRoot: string | null = null;
    let ensureProjectCovenCalls = 0;
    const boot = compileFunction<(env: Record<string, string>) => Promise<void>>(
      functionSource('boot'),
      {
        state,
        installTerminalImageDrop: async () => { calls.push('installTerminalImageDrop'); },
        statusController: null,
        loadSavedWorkspace: async () => null,
        settings: { maxProjects: 5 },
        HARD_MAX_PROJECTS: 10,
        isRestoringWorkspace: false,
        restoreSavedProjects: async () => {
          throw new Error('restoreSavedProjects should not run without saved projects');
        },
        activeProject: () => {
          throw new Error('activeProject should not run without saved projects');
        },
        restoreProjectLayout: (value: { id: string }) => { calls.push(`restoreProjectLayout:${value.id}`); },
        refreshProjectWorktrees: async () => {
          throw new Error('refreshProjectWorktrees should be owned by addProject');
        },
        addProject: async (root: string) => {
          addProjectRoot = root;
          calls.push(`addProject:${root}`);
          state.projects = [project];
          state.activeProjectId = project.id;
          return project;
        },
        currentBrowserTab: (value: { id: string } | null) => {
          calls.push(`currentBrowserTab:${value ? value.id : 'null'}`);
          return null;
        },
        navigateBrowser: () => { throw new Error('navigateBrowser should not run'); },
        refreshSidebar: () => { calls.push('refreshSidebar'); },
        refreshTabs: () => { calls.push('refreshTabs'); },
        renderBrowserTabs: () => { calls.push('renderBrowserTabs'); },
        syncProjectBrowser: () => { calls.push('syncProjectBrowser'); },
        loadAgentSkills: () => { calls.push('loadAgentSkills'); },
        saveWorkspaceNow: () => { calls.push('saveWorkspaceNow'); },
        startCovenPolling: () => { calls.push('startCovenPolling'); },
        paneMetricsPollTimer: 0,
        clearInterval: () => { calls.push('clearInterval'); },
        setInterval: (_callback: () => void, ms: number) => {
          calls.push(`setInterval:${ms}`);
          return 1;
        },
        refreshVisiblePaneMetrics: () => { calls.push('refreshVisiblePaneMetrics'); },
        refreshStatusController: null,
        ensureProjectCoven: async () => {
          ensureProjectCovenCalls += 1;
          throw new Error('ensureProjectCoven must not run');
        },
      },
    );

    await boot({ repo_root: '/repo/root', home: '/home/tester' });

    expect(ensureProjectCovenCalls).toBe(0);
    expect(addProjectRoot).toBe('/repo/root');
    expect(state.env).toEqual({ repo_root: '/repo/root', home: '/home/tester' });
    expect(state.projects).toEqual([project]);
    expect(state.activeProjectId).toBe('fresh-project');
    expect(calls).toEqual([
      'installTerminalImageDrop',
      'addProject:/repo/root',
      'currentBrowserTab:fresh-project',
      'restoreProjectLayout:fresh-project',
      'refreshSidebar',
      'refreshTabs',
      'renderBrowserTabs',
      'syncProjectBrowser',
      'loadAgentSkills',
      'saveWorkspaceNow',
      'startCovenPolling',
      'setInterval:15000',
      'refreshVisiblePaneMetrics',
    ]);
    expect(calls.indexOf('startCovenPolling')).toBeGreaterThan(
      calls.indexOf('restoreProjectLayout:fresh-project'),
    );
  });

  it('keeps protected launch kinds limited to Coven-only launches across the JS/Rust contract', () => {
    expect(libRs).toContain('if !matches!(launch_kind, "coven-chat" | "coven-attach")');

    const spawnAgentThread = functionSource('spawnAgentThread');
    expect(spawnAgentThread).toContain('launchKind: null');

    const covenChatLaunch = functionSource('covenChatLaunch');
    expect(covenChatLaunch).toContain('launchKind: "coven-chat"');
  });

  it('deduplicates canonical aliases while preserving the active project identity', async () => {
    let nextId = 0;
    const migrateProjectRoot = compileFunction<(
      project: Record<string, any>, oldRoot: string, canonicalRoot: string,
    ) => Record<string, any>>(functionSource('migrateProjectRoot'), {});
    const mergeRestoredProject = compileFunction<(
      target: Record<string, any>, incoming: Record<string, any>, preferIncoming: boolean,
    ) => Record<string, any>>(functionSource('mergeRestoredProject'), {});
    const restoreSavedProjects = compileFunction<(
      projects: Array<Record<string, unknown>>,
      activeId: string,
      limit: number,
    ) => Promise<{ projects: Array<Record<string, unknown>>; activeProjectId: string | null }>>(
      functionSource('restoreSavedProjects'),
      {
        sanitizeSavedProject: (saved: Record<string, unknown>) => ({ ...saved }),
        canonicalProjectPath: async (root: string) => ({
          '/alias/repo': '/real/repo',
          '/real/repo': '/real/repo',
          '/other': '/other',
        }[root] || null),
        migrateProjectRoot,
        mergeRestoredProject,
        makeProjectId: () => `generated-${nextId += 1}`,
      },
    );

    const result = await restoreSavedProjects([
      {
        id: 'first', root: '/alias/repo', selectedWorktreePath: '/alias/repo', worktrees: [],
        browsersByWorktree: { '/alias/repo': { tabs: [{ id: 'first-tab' }], activeTabId: 'first-tab' } },
      },
      {
        id: 'active-alias', root: '/real/repo', selectedWorktreePath: '/real/repo', worktrees: [],
        browsersByWorktree: { '/real/repo': { tabs: [{ id: 'active-tab' }], activeTabId: 'active-tab' } },
      },
      { id: 'first', root: '/other' },
      { id: 'invalid', root: '/missing' },
    ], 'active-alias', 10);

    expect(result.projects).toHaveLength(2);
    expect(result.projects[0]).toMatchObject({ id: 'first', root: '/real/repo' });
    expect(result.projects[1]).toMatchObject({ id: 'generated-1', root: '/other' });
    expect((result.projects[0] as any).browsersByWorktree['/real/repo']).toEqual({
      tabs: [{ id: 'first-tab' }, { id: 'active-tab' }],
      activeTabId: 'active-tab',
    });
    expect(result.activeProjectId).toBe('first');
  });

  it('rekeys root-scoped state when an alias migrates to its canonical root', () => {
    const migrateProjectRoot = compileFunction<(
      project: Record<string, any>, oldRoot: string, canonicalRoot: string,
    ) => Record<string, any>>(functionSource('migrateProjectRoot'), {});
    const browser = {
      tabs: [{ id: 'tab-1', url: 'https://example.test', history: ['https://example.test'] }],
      activeTabId: 'tab-1',
    };
    const project = {
      root: '/alias/repo',
      selectedWorktreePath: '/alias/repo/packages/app',
      worktrees: [
        { path: '/alias/repo', collapsed: true },
        { path: '/alias/repo/packages/app', collapsed: false },
        { path: '/linked', collapsed: false },
      ],
      browsersByWorktree: {
        '/alias/repo': browser,
        '/alias/repo/packages/app': { tabs: [{ id: 'nested-tab' }], activeTabId: 'nested-tab' },
        '/linked': { tabs: [{ id: 'linked-tab' }], activeTabId: 'linked-tab' },
      },
    };

    migrateProjectRoot(project, '/alias/repo', '/real/repo');

    expect(project.root).toBe('/real/repo');
    expect(project.selectedWorktreePath).toBe('/real/repo/packages/app');
    expect(project.worktrees).toEqual([
      { path: '/real/repo', collapsed: true },
      { path: '/real/repo/packages/app', collapsed: false },
      { path: '/linked', collapsed: false },
    ]);
    expect(project.browsersByWorktree).toEqual({
      '/real/repo': browser,
      '/real/repo/packages/app': { tabs: [{ id: 'nested-tab' }], activeTabId: 'nested-tab' },
      '/linked': { tabs: [{ id: 'linked-tab' }], activeTabId: 'linked-tab' },
    });
  });

  it('merges every browser and worktree key with the active source winning collisions', () => {
    const mergeRestoredProject = compileFunction<(
      target: Record<string, any>, incoming: Record<string, any>, preferIncoming: boolean,
    ) => Record<string, any>>(functionSource('mergeRestoredProject'), {});
    const target = {
      root: '/real/repo', selectedWorktreePath: '/real/repo', layout: { mode: 'terminal' },
      worktrees: [
        { path: '/real/repo/nested', collapsed: false },
        { path: '/external', collapsed: false },
      ],
      browsersByWorktree: {
        '/real/repo/nested': { tabs: [{ id: 'same', title: 'old' }], activeTabId: 'same' },
        '/external': { tabs: [{ id: 'external-old' }], activeTabId: 'external-old' },
      },
    };
    const incoming = {
      root: '/real/repo', selectedWorktreePath: '/external', layout: { mode: 'browser' },
      worktrees: [
        { path: '/real/repo/nested', collapsed: true },
        { path: '/incoming-external', collapsed: true },
      ],
      browsersByWorktree: {
        '/real/repo/nested': {
          tabs: [{ id: 'same', title: 'active' }, { id: 'new' }], activeTabId: 'new',
        },
        '/incoming-external': { tabs: [{ id: 'incoming-tab' }], activeTabId: 'incoming-tab' },
      },
    };

    mergeRestoredProject(target, incoming, true);

    expect(target.selectedWorktreePath).toBe('/external');
    expect(target.layout).toEqual({ mode: 'browser' });
    expect(target.worktrees).toEqual([
      { path: '/real/repo/nested', collapsed: true },
      { path: '/external', collapsed: false },
      { path: '/incoming-external', collapsed: true },
    ]);
    expect(target.browsersByWorktree).toEqual({
      '/real/repo/nested': {
        tabs: [{ id: 'same', title: 'active' }, { id: 'new' }], activeTabId: 'new',
      },
      '/external': { tabs: [{ id: 'external-old' }], activeTabId: 'external-old' },
      '/incoming-external': { tabs: [{ id: 'incoming-tab' }], activeTabId: 'incoming-tab' },
    });
  });
});

describe('native Coven launch routing', () => {
  it('prefers crypto.randomUUID for exact Coven session identity', () => {
    const randomUUID = () => COVEN_SESSION_ID;
    const makeCovenSessionId = compileFunction<() => string | null>(
      functionSource('makeCovenSessionId'),
      {
        window: {
          crypto: {
            randomUUID,
            getRandomValues: () => { throw new Error('fallback must not run'); },
          },
        },
        setStatus: () => { throw new Error('error status must not run'); },
      },
    );

    expect(makeCovenSessionId()).toBe(COVEN_SESSION_ID);
  });

  it('formats a secure RFC4122 v4 UUID fallback with version and variant bits', () => {
    const bytes = Uint8Array.from([
      0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x00, 0x77,
      0x00, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
    ]);
    const makeCovenSessionId = compileFunction<() => string | null>(
      functionSource('makeCovenSessionId'),
      {
        window: {
          crypto: {
            getRandomValues: (target: Uint8Array) => {
              target.set(bytes);
              return target;
            },
          },
        },
        setStatus: () => { throw new Error('error status must not run'); },
        Uint8Array,
      },
    );

    const sessionId = makeCovenSessionId();
    expect(sessionId).toBe('00112233-4455-4077-8099-aabbccddeeff');
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('fails visibly when secure UUID generation is unavailable', () => {
    const statuses: Array<[string, string]> = [];
    const makeCovenSessionId = compileFunction<() => string | null>(
      functionSource('makeCovenSessionId'),
      {
        window: {},
        setStatus: (message: string, level: string) => { statuses.push([message, level]); },
      },
    );

    expect(makeCovenSessionId()).toBeNull();
    expect(statuses).toEqual([['Secure session ID generation is unavailable', 'error']]);
  });

  it('builds a Coven chat descriptor scoped to the project and selected worktree', () => {
    const state = { env: { coven_path: '/opt/homebrew/bin/coven' } };
    const project = { root: '/repo', selectedWorktreePath: '/repo/.worktrees/feature' };
    const covenChatLaunch = compileFunction<(
      value: typeof project,
      worktreePath?: string,
    ) => Record<string, unknown>>(
      functionSource('covenChatLaunch'),
      {
        state,
        selectedWorktree: () => { throw new Error('explicit worktree path should win'); },
        makeCovenSessionId: () => COVEN_SESSION_ID,
      },
    );

    expect(covenChatLaunch(project, project.selectedWorktreePath)).toEqual({
      command: '/opt/homebrew/bin/coven',
      args: ['code', '--session-id', COVEN_SESSION_ID],
      env: { COVEN_SESSION_SOURCE: 'psyche-build' },
      projectRoot: '/repo',
      cwd: '/repo/.worktrees/feature',
      kind: 'coven-chat',
      launchKind: 'coven-chat',
      covenSessionId: COVEN_SESSION_ID,
      metricsProvider: 'coven',
    });
  });

  it('does not create a thread when secure session identity cannot be generated', async () => {
    const project = { id: 'project', root: '/repo', selectedWorktreePath: '/repo' };
    let creates = 0;
    const spawnCovenThread = compileFunction<(value: typeof project) => Promise<null>>(
      functionSource('spawnCovenThread'),
      {
        state: { env: { coven_path: '/bin/coven' } },
        activeProject: () => project,
        selectedWorktree: () => ({ path: '/repo' }),
        setStatus: () => undefined,
        showTerminalView: async () => true,
        requestAnimationFrame: (callback: () => void) => callback(),
        covenChatLaunch: () => null,
        createThread: () => { creates += 1; },
      },
    );

    await expect(spawnCovenThread(project)).resolves.toBeNull();
    expect(creates).toBe(0);
  });

  it('duplicates Coven chat threads with a fresh secure session launch', () => {
    const project = { id: 'project', root: '/repo' };
    const originalLaunch = {
      command: '/bin/coven',
      args: ['code', '--session-id', COVEN_SESSION_ID],
      env: { TOKEN: 'before' },
      projectRoot: '/repo',
      cwd: '/repo/wt',
      launchKind: 'coven-chat',
      covenSessionId: COVEN_SESSION_ID,
      metricsProvider: 'coven',
    };
    const covenChatLaunch = compileFunction<(
      value: { root: string },
      path: string,
    ) => Record<string, unknown> | null>(
      functionSource('covenChatLaunch'),
      {
        selectedWorktree: () => { throw new Error('expected explicit worktree path'); },
        makeCovenSessionId: () => DUPLICATE_COVEN_SESSION_ID,
        state: { env: { coven_path: '/bin/coven' } },
      },
    );
    let created: Record<string, any> | null = null;
    const duplicateThread = compileFunction<(
      value: Record<string, any>,
    ) => Record<string, any> | null>(
      functionSource('duplicateThread'),
      {
        findProject: () => project,
        covenChatLaunch,
        createThread: (options: Record<string, any>) => {
          created = options;
          return options;
        },
      },
    );

    const duplicate = duplicateThread({
      id: 'thread-1',
      projectId: project.id,
      name: 'Coven',
      kind: 'coven-chat',
      worktreePath: '/repo/wt',
      status: 'running',
      launch: originalLaunch,
    });

    expect(created).toMatchObject({
      project,
      name: 'Coven copy',
      kind: 'coven-chat',
      worktreePath: '/repo/wt',
    });
    expect(duplicate?.launch).toEqual({
      command: '/bin/coven',
      args: ['code', '--session-id', DUPLICATE_COVEN_SESSION_ID],
      env: { COVEN_SESSION_SOURCE: 'psyche-build' },
      projectRoot: '/repo',
      cwd: '/repo/wt',
      kind: 'coven-chat',
      launchKind: 'coven-chat',
      covenSessionId: DUPLICATE_COVEN_SESSION_ID,
      metricsProvider: 'coven',
    });
    expect(originalLaunch).toEqual({
      command: '/bin/coven',
      args: ['code', '--session-id', COVEN_SESSION_ID],
      env: { TOKEN: 'before' },
      projectRoot: '/repo',
      cwd: '/repo/wt',
      launchKind: 'coven-chat',
      covenSessionId: COVEN_SESSION_ID,
      metricsProvider: 'coven',
    });
  });

  it('does not create a duplicate Coven chat thread when secure session generation fails', () => {
    const project = { id: 'project', root: '/repo' };
    const statuses: Array<{ text: string; tone: string | undefined }> = [];
    const makeCovenSessionId = compileFunction<() => string | null>(
      functionSource('makeCovenSessionId'),
      {
        window: { crypto: null },
        setStatus: (text: string, tone?: string) => { statuses.push({ text, tone }); },
      },
    );
    const covenChatLaunch = compileFunction<(
      value: { root: string },
      path: string,
    ) => Record<string, unknown> | null>(
      functionSource('covenChatLaunch'),
      {
        selectedWorktree: () => { throw new Error('expected explicit worktree path'); },
        makeCovenSessionId,
        state: { env: { coven_path: '/bin/coven' } },
      },
    );
    let creates = 0;
    const duplicateThread = compileFunction<(
      value: Record<string, any>,
    ) => Record<string, any> | null>(
      functionSource('duplicateThread'),
      {
        findProject: () => project,
        covenChatLaunch,
        createThread: () => {
          creates += 1;
          return { id: 'unexpected' };
        },
      },
    );

    expect(duplicateThread({
      id: 'thread-1',
      projectId: project.id,
      name: 'Coven',
      kind: 'coven-chat',
      worktreePath: '/repo/wt',
      status: 'running',
      launch: {
        command: '/bin/coven',
        args: ['code', '--session-id', COVEN_SESSION_ID],
        env: {},
        projectRoot: '/repo',
        cwd: '/repo/wt',
        launchKind: 'coven-chat',
        covenSessionId: COVEN_SESSION_ID,
        metricsProvider: 'coven',
      },
    })).toBeNull();
    expect(creates).toBe(0);
    expect(statuses).toEqual([
      { text: 'Secure session ID generation is unavailable', tone: 'error' },
    ]);
  });

  it('does not relabel an attached Coven session as Psyche-owned', async () => {
    const project = { id: 'project', root: '/repo', selectedWorktreePath: '/repo/wt' };
    const session = { id: 'safe-session', title: 'Existing session', cwd: '/repo/wt' };
    let descriptor: Record<string, unknown> | null = null;
    const openCovenSession = compileFunction<(
      value: typeof project,
      attached: typeof session,
    ) => Promise<Record<string, unknown> | null>>(functionSource('openCovenSession'), {
      PsycheSessions: { isSafeCovenSessionId: () => true },
      setStatus: () => undefined,
      state: { env: { coven_path: '/bin/coven' } },
      findCovenAttachment: () => null,
      covenAttachKey: () => 'project:safe-session',
      covenAttachInFlight: new Map(),
      covenWorktreeForSession: () => ({ path: '/repo/wt' }),
      activateProjectWorktree: async () => true,
      waitForTerminalLayout: async () => undefined,
      createThread: (options: Record<string, unknown>) => {
        descriptor = options;
        return options;
      },
    });

    await openCovenSession(project, session);

    expect(descriptor).toMatchObject({
      command: '/bin/coven',
      args: ['attach', 'safe-session'],
      launchKind: 'coven-attach',
      covenSessionId: 'safe-session',
    });
    expect(descriptor).not.toHaveProperty('env');
    expect(JSON.stringify(descriptor)).not.toContain('COVEN_SESSION_SOURCE');
  });

  it('copies one launch descriptor onto the thread and starts from that copy only', async () => {
    const state = { threads: [] as Array<Record<string, any>>, activeThreadId: null };
    let frame: (() => void) | null = null;
    const calls: Array<Record<string, any>> = [];
    const launch = {
      command: '/bin/coven', args: ['code', '--session-id', COVEN_SESSION_ID],
      env: { TOKEN: 'before' }, projectRoot: '/repo', cwd: '/repo/wt',
      launchKind: 'coven-chat', covenSessionId: COVEN_SESSION_ID, metricsProvider: 'coven',
    };
    const createThread = compileFunction<(opts: Record<string, any>) => Record<string, any>>(
      functionSource('createThread'),
      {
        makeThreadId: () => 'thread-1',
        activeProject: () => null,
        activeWorkspaceRoot: () => null,
        preparePanePlacement: () => ({ key: 'layout', value: {} }),
        setStatus: () => undefined,
        commitPanePlacement: () => undefined,
        state,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        mountTerminal: () => undefined,
        focusThread: () => undefined,
        requestAnimationFrame: (callback: () => void) => { frame = callback; },
        isLiveThread: (thread: Record<string, any>) => state.threads.includes(thread),
        spawnPty: (thread: Record<string, any>) => { calls.push(thread); },
        loadingPaneMetrics: compileFunction(
          functionSource('loadingPaneMetrics'),
          {},
        ),
      },
    );
    const thread = createThread({
      project: { id: 'project' }, worktreePath: '/repo/wt', kind: 'coven-chat', launch,
    });
    launch.args.push('mutated');
    launch.env.TOKEN = 'after';
    expect(thread.launch).toEqual({
      command: '/bin/coven', args: ['code', '--session-id', COVEN_SESSION_ID],
      env: { TOKEN: 'before' }, projectRoot: '/repo', cwd: '/repo/wt',
      launchKind: 'coven-chat', covenSessionId: COVEN_SESSION_ID, metricsProvider: 'coven',
    });
    expect(thread).toMatchObject({
      metricsGeneration: 0,
      metrics: {
        phase: 'loading',
        provider: 'coven',
        sessionId: COVEN_SESSION_ID,
        model: null,
        contextUsed: null,
        contextLimit: null,
        cumulativeInputTokens: null,
        cumulativeOutputTokens: null,
        cacheCreationTokens: null,
        cacheReadTokens: null,
        spendUsd: null,
        costKind: 'unknown',
        updatedAt: null,
        stale: false,
        error: null,
        canSwitchModel: false,
      },
      metricsRefreshTimer: 0,
    });
    expect(frame).not.toBeNull();
    (frame as unknown as () => void)();
    expect(calls).toEqual([thread]);

    const invoked: Array<Record<string, any>> = [];
    const spawnPty = compileFunction<(value: Record<string, any>) => Promise<boolean>>(
      functionSource('spawnPty'),
      {
        ...spawnPtyRuntimeDeps,
        isLiveThread: () => true,
        invoke: async (_name: string, payload: Record<string, any>) => { invoked.push(payload); },
        pendingDataBuffers: new Map(),
        syncThreadPaneMetadata: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        state: { activeThreadId: null },
        findProject: () => null,
        setProjectStatus: () => undefined,
        setStatus: () => undefined,
        refreshCovenSessions: () => Promise.resolve(),
      },
    );
    thread.command = '/bin/wrong';
    thread.args = ['wrong'];
    thread.env = { WRONG: 'yes' };
    await spawnPty(thread);
    expect(invoked[0]).toEqual({
      options: expect.objectContaining({
        threadId: 'thread-1', thread_id: 'thread-1',
        projectRoot: '/repo', project_root: '/repo', cwd: '/repo/wt',
        launchKind: 'coven-chat', launch_kind: 'coven-chat',
        covenSessionId: COVEN_SESSION_ID, coven_session_id: COVEN_SESSION_ID,
        command: '/bin/coven', args: ['code', '--session-id', COVEN_SESSION_ID],
        env: { TOKEN: 'before' },
      }),
    });
    expect((invoked[0].options as Record<string, unknown>)).not.toHaveProperty('metricsProvider');
  });

  it('falls back to opts.metricsProvider when launch omits it and preserves launch precedence', () => {
    const createThread = compileFunction<(opts: Record<string, any>) => Record<string, any>>(
      functionSource('createThread'),
      {
        makeThreadId: () => 'thread-1',
        activeProject: () => null,
        activeWorkspaceRoot: () => null,
        preparePanePlacement: () => ({ key: 'layout', value: {} }),
        setStatus: () => undefined,
        commitPanePlacement: () => undefined,
        state: { threads: [], activeThreadId: null },
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        mountTerminal: () => undefined,
        focusThread: () => undefined,
        requestAnimationFrame: () => undefined,
        isLiveThread: () => true,
        spawnPty: () => undefined,
      },
    );

    const fallbackThread = createThread({
      project: { id: 'project' },
      worktreePath: '/repo/wt',
      metricsProvider: 'agent',
      launch: {
        command: '/bin/coven',
        args: ['attach', COVEN_SESSION_ID],
        env: {},
        projectRoot: '/repo',
        cwd: '/repo/wt',
        launchKind: 'coven-attach',
        covenSessionId: COVEN_SESSION_ID,
      },
    });
    expect(fallbackThread.launch.metricsProvider).toBe('agent');

    const explicitThread = createThread({
      project: { id: 'project' },
      worktreePath: '/repo/wt',
      metricsProvider: 'agent',
      launch: {
        command: '/bin/coven',
        args: ['attach', COVEN_SESSION_ID],
        env: {},
        projectRoot: '/repo',
        cwd: '/repo/wt',
        launchKind: 'coven-attach',
        covenSessionId: COVEN_SESSION_ID,
        metricsProvider: 'coven',
      },
    });
    expect(explicitThread.launch.metricsProvider).toBe('coven');
  });

  it('validates Coven before revealing or mutating the terminal workspace', async () => {
    const state = {
      env: { coven_path: null },
      threads: [] as Array<Record<string, unknown>>,
    };
    let shown = 0;
    let created = 0;
    let status = '';
    const spawnCovenThread = compileFunction<(project: Record<string, unknown>) => Promise<null>>(
      functionSource('spawnCovenThread'),
      {
        state,
        activeProject: () => ({ id: 'project', root: '/repo' }),
        setStatus: (message: string) => { status = message; },
        showTerminalView: async () => { shown += 1; return true; },
        requestAnimationFrame: (callback: () => void) => callback(),
        covenChatLaunch: () => { throw new Error('must not build launch'); },
        createThread: () => { created += 1; },
      },
    );

    await expect(spawnCovenThread({ id: 'project', root: '/repo' })).resolves.toBeNull();
    expect(status).toBe('Coven CLI not found — install @opencoven/cli and restart Psyche');
    expect({ shown, created, threads: state.threads.length }).toEqual({ shown: 0, created: 0, threads: 0 });
  });

  it('reveals the terminal, waits one frame, then creates Coven', async () => {
    const order: string[] = [];
    const project = { id: 'project', root: '/repo' };
    const spawnCovenThread = compileFunction<(value: typeof project) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnCovenThread'),
      {
        state: { env: { coven_path: '/bin/coven' } },
        activeProject: () => project,
        selectedWorktree: () => ({ path: '/repo' }),
        setStatus: () => undefined,
        showTerminalView: async () => { order.push('show'); return true; },
        requestAnimationFrame: (callback: () => void) => { order.push('frame'); callback(); },
        covenChatLaunch: () => ({
          command: '/bin/coven',
          args: ['code', '--session-id', COVEN_SESSION_ID],
          cwd: '/repo',
          launchKind: 'coven-chat',
          covenSessionId: COVEN_SESSION_ID,
          metricsProvider: 'coven',
        }),
        createThread: (options: Record<string, unknown>) => { order.push('create'); return options; },
      },
    );

    const thread = await spawnCovenThread(project);
    expect(order).toEqual(['show', 'frame', 'create']);
    expect(thread).toMatchObject({ project, kind: 'coven-chat', name: 'Coven' });
  });

  it('coalesces concurrent explicit ensures through one animation-frame launch', async () => {
    const project = { id: 'project', root: '/repo', selectedWorktreePath: '/repo/wt' };
    const state = {
      env: { coven_path: '/bin/coven' },
      threads: [] as Array<Record<string, unknown>>,
    };
    const frames: Array<() => void> = [];
    let creates = 0;
    const spawnCovenThread = compileFunction<(value: typeof project, path?: string) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnCovenThread'),
      {
        state,
        activeProject: () => project,
        selectedWorktree: () => ({ path: project.selectedWorktreePath }),
        setStatus: () => undefined,
        showTerminalView: async () => true,
        requestAnimationFrame: (callback: () => void) => { frames.push(callback); },
        covenChatLaunch: (_value: typeof project, path: string) => ({
          command: '/bin/coven',
          args: ['code', '--session-id', COVEN_SESSION_ID],
          cwd: path,
          launchKind: 'coven-chat',
          covenSessionId: COVEN_SESSION_ID,
          metricsProvider: 'coven',
        }),
        createThread: (options: Record<string, unknown>) => {
          creates += 1;
          return options;
        },
      },
    );
    const covenEnsureFlights = new Map<string, Promise<Record<string, unknown> | null>>();
    const ensureProjectCoven = compileFunction<(value: typeof project) => Promise<Record<string, unknown> | null>>(
      functionSource('ensureProjectCoven'),
      {
        selectedWorktree: () => ({ path: project.selectedWorktreePath }),
        state,
        focusThread: async () => undefined,
        spawnCovenThread,
        covenEnsureFlights,
      },
    );

    const first = ensureProjectCoven(project);
    const second = ensureProjectCoven(project);
    expect(first).toBe(second);
    await Promise.resolve();
    expect(frames).toHaveLength(1);
    frames[0]();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(creates).toBe(1);
    expect(covenEnsureFlights.size).toBe(0);
  });

  it('cleans a rejected explicit ensure so the user can retry', async () => {
    const project = { id: 'project', root: '/repo' };
    const covenEnsureFlights = new Map<string, Promise<unknown>>();
    let attempts = 0;
    const ensureProjectCoven = compileFunction<(value: typeof project) => Promise<unknown>>(
      functionSource('ensureProjectCoven'),
      {
        selectedWorktree: () => ({ path: '/repo/wt' }),
        state: { threads: [] },
        focusThread: async () => undefined,
        spawnCovenThread: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('launch failed');
          return { id: 'retry' };
        },
        covenEnsureFlights,
      },
    );

    const rejected = ensureProjectCoven(project);
    expect(covenEnsureFlights.size).toBe(1);
    await expect(rejected).rejects.toThrow('launch failed');
    expect(covenEnsureFlights.size).toBe(0);
    await expect(ensureProjectCoven(project)).resolves.toEqual({ id: 'retry' });
    expect(attempts).toBe(2);
  });

  it('drops a launch when the active project changes during the frame wait', async () => {
    const project = { id: 'project', root: '/repo', selectedWorktreePath: '/repo/wt' };
    let active = project;
    let frame: (() => void) | null = null;
    let creates = 0;
    const spawnCovenThread = compileFunction<(value: typeof project) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnCovenThread'),
      {
        state: { env: { coven_path: '/bin/coven' } },
        activeProject: () => active,
        selectedWorktree: (value: typeof project) => ({ path: value.selectedWorktreePath }),
        setStatus: () => undefined,
        showTerminalView: async () => true,
        requestAnimationFrame: (callback: () => void) => { frame = callback; },
        covenChatLaunch: () => ({
          command: '/bin/coven',
          args: ['code', '--session-id', COVEN_SESSION_ID],
          cwd: '/repo/wt',
          launchKind: 'coven-chat',
          covenSessionId: COVEN_SESSION_ID,
          metricsProvider: 'coven',
        }),
        createThread: () => { creates += 1; return {}; },
      },
    );

    const pending = spawnCovenThread(project);
    await Promise.resolve();
    active = { id: 'other', root: '/other', selectedWorktreePath: '/other' };
    expect(frame).not.toBeNull();
    (frame as unknown as () => void)();
    await expect(pending).resolves.toBeNull();
    expect(creates).toBe(0);
  });

  it('drops a launch when the active project is rehydrated onto another worktree', async () => {
    const project = { id: 'project', root: '/repo', selectedWorktreePath: '/repo/one' };
    let active = project;
    let frame: (() => void) | null = null;
    let creates = 0;
    const spawnCovenThread = compileFunction<(value: typeof project) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnCovenThread'),
      {
        state: { env: { coven_path: '/bin/coven' } },
        activeProject: () => active,
        selectedWorktree: (value: typeof project) => ({ path: value.selectedWorktreePath }),
        setStatus: () => undefined,
        showTerminalView: async () => true,
        requestAnimationFrame: (callback: () => void) => { frame = callback; },
        covenChatLaunch: () => ({
          command: '/bin/coven',
          args: ['code', '--session-id', COVEN_SESSION_ID],
          cwd: '/repo/one',
          launchKind: 'coven-chat',
          covenSessionId: COVEN_SESSION_ID,
          metricsProvider: 'coven',
        }),
        createThread: () => { creates += 1; return {}; },
      },
    );

    const pending = spawnCovenThread(project);
    await Promise.resolve();
    active = { id: project.id, root: project.root, selectedWorktreePath: '/repo/two' };
    expect(frame).not.toBeNull();
    (frame as unknown as () => void)();
    await expect(pending).resolves.toBeNull();
    expect(creates).toBe(0);
  });

  it('drops a launch when the selected worktree changes during the frame wait', async () => {
    const project = { id: 'project', root: '/repo', selectedWorktreePath: '/repo/one' };
    let frame: (() => void) | null = null;
    let creates = 0;
    const spawnCovenThread = compileFunction<(value: typeof project) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnCovenThread'),
      {
        state: { env: { coven_path: '/bin/coven' } },
        activeProject: () => project,
        selectedWorktree: (value: typeof project) => ({ path: value.selectedWorktreePath }),
        setStatus: () => undefined,
        showTerminalView: async () => true,
        requestAnimationFrame: (callback: () => void) => { frame = callback; },
        covenChatLaunch: () => ({
          command: '/bin/coven',
          args: ['code', '--session-id', COVEN_SESSION_ID],
          cwd: '/repo/one',
          launchKind: 'coven-chat',
          covenSessionId: COVEN_SESSION_ID,
          metricsProvider: 'coven',
        }),
        createThread: () => { creates += 1; return {}; },
      },
    );

    const pending = spawnCovenThread(project);
    await Promise.resolve();
    project.selectedWorktreePath = '/repo/two';
    expect(frame).not.toBeNull();
    (frame as unknown as () => void)();
    await expect(pending).resolves.toBeNull();
    expect(creates).toBe(0);
  });

  it('does not launch Coven when the project picker adds a project', async () => {
    const project = { id: 'project', root: '/repo', name: 'repo' };
    let pickerLaunches = 0;
    const openProjectPicker = compileFunction<() => Promise<void>>(
      functionSource('openProjectPicker'),
      {
        dialogOpen: async () => '/repo',
        state: { env: { home: '/home' } },
        addProject: async () => project,
        ensureProjectCoven: async () => { pickerLaunches += 1; return null; },
        setProjectStatus: () => { throw new Error('setProjectStatus should not be called'); },
        writeToActive: () => undefined,
      },
    );
    await openProjectPicker();
    expect(pickerLaunches).toBe(0);
  });

  it('does not launch Coven when activating a project without a visible pane', async () => {
    const project = { id: 'project', root: '/repo', name: 'repo' };
    const state = { activeProjectId: 'other', threads: [], activeThreadId: 'stale-thread' as string | null };
    let renderCalls = 0;
    let sidebarCalls = 0;
    let tabCalls = 0;
    let syncCalls = 0;
    let activationLaunches = 0;
    const setActiveProject = compileFunction<(id: string) => Promise<boolean>>(
      functionSource('setActiveProject'),
      {
        state,
        showTerminalView: async () => true,
        findProject: () => project,
        restoreProjectLayout: () => undefined,
        loadAgentSkills: () => undefined,
        activeWorkspaceRoot: () => '/repo',
        focusThread: async () => true,
        renderPaneWorkspace: () => { renderCalls += 1; },
        refreshSidebar: () => { sidebarCalls += 1; },
        refreshTabs: () => { tabCalls += 1; },
        syncProjectBrowser: () => { syncCalls += 1; },
        ensureProjectCoven: async () => { activationLaunches += 1; return null; },
        setStatus: () => { throw new Error('setStatus should not be called'); },
        saveWorkspaceSoon: () => undefined,
      },
    );
    await setActiveProject(project.id);
    expect(state.activeThreadId).toBeNull();
    expect(renderCalls).toBe(1);
    expect(sidebarCalls).toBe(1);
    expect(tabCalls).toBe(1);
    expect(syncCalls).toBe(2);
    expect(activationLaunches).toBe(0);
  });

  it('deduplicates only a visible live Coven chat in the exact workspace', async () => {
    const project = { id: 'project', root: '/repo' };
    const running = {
      id: 'running', projectId: project.id, worktreePath: '/repo/wt',
      kind: 'coven-chat', status: 'running', hidden: false, closing: false,
    };
    const starting = {
      id: 'starting', projectId: project.id, worktreePath: '/repo/wt',
      kind: 'coven-chat', status: 'starting', hidden: false, closing: false,
    };
    const state = { threads: [
      { ...running, id: 'hidden', hidden: true },
      { ...running, id: 'failed', status: 'failed' },
      { ...running, id: 'exited', status: 'exited' },
      { ...running, id: 'closing', closing: true },
      { ...running, id: 'other', worktreePath: '/repo/other' },
      starting,
    ] };
    let focused = '';
    let spawned = 0;
    const spawnedThread = { ...running, id: 'spawned' };
    const ensureProjectCoven = compileFunction<(value: typeof project) => Promise<typeof running>>(
      functionSource('ensureProjectCoven'),
      {
        selectedWorktree: () => ({ path: '/repo/wt' }),
        state,
        focusThread: async (id: string) => { focused = id; },
        spawnCovenThread: async () => { spawned += 1; return spawnedThread; },
        covenEnsureFlights: new Map(),
      },
    );
    await expect(ensureProjectCoven(project)).resolves.toBe(starting);
    expect({ focused, spawned }).toEqual({ focused: 'starting', spawned: 0 });

    state.threads = state.threads.map((thread) => (
      thread.id === 'starting' ? running : thread
    ));
    await ensureProjectCoven(project);
    expect({ focused, spawned }).toEqual({ focused: 'running', spawned: 0 });

    state.threads = state.threads.filter((thread) => (
      thread.id !== 'starting' && thread.id !== 'running'
    ));
    await expect(ensureProjectCoven(project)).resolves.toBe(spawnedThread);
    expect(spawned).toBe(1);
  });

  it('retains one pane through fail, retry, exit, and retry lifecycle transitions', async () => {
    const project = { id: 'project' };
    const writes: string[] = [];
    const thread = {
      id: 'thread-1', projectId: project.id, worktreePath: '/repo', name: 'Coven',
      launch: {
        command: '/bin/coven', args: ['code', '--session-id', COVEN_SESSION_ID], env: {}, projectRoot: '/repo', cwd: '/repo',
        launchKind: 'coven-chat', covenSessionId: COVEN_SESSION_ID, metricsProvider: 'coven',
      },
      status: 'starting', spawning: true, closing: false, closeStarted: false,
      startInFlight: false, stopRequested: false, ptyStarted: false,
      term: { cols: 120, rows: 40, write: (value: string) => writes.push(value) },
    };
    const state = { threads: [thread], activeThreadId: thread.id };
    const pendingDataBuffers = new Map<string, Uint8Array[]>();
    const starts: Array<'fail' | 'run' | 'cleanup'> = ['fail', 'run', 'cleanup', 'run'];
    const invoke = async (command: string) => {
      if (command !== 'pty_start') return undefined;
      const outcome = starts.shift();
      if (outcome === 'fail') throw new Error('coven unavailable');
      if (outcome === 'cleanup') throw new Error("thread 'thread-1' cleanup in progress");
      return undefined;
    };
    const dependencies = {
      ...spawnPtyRuntimeDeps,
      invoke,
      isLiveThread: (value: typeof thread) => state.threads.includes(value) && !value.closing,
      pendingDataBuffers,
      syncThreadPaneMetadata: () => undefined,
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      state,
      setProjectStatus: () => undefined,
      findProject: () => project,
      setStatus: () => undefined,
      stopThreadPty: () => Promise.resolve(false),
      refreshCovenSessions: () => Promise.resolve(),
    };
    const spawnPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
      functionSource('spawnPty'), dependencies,
    );
    const retryThread = compileFunction<(id: string) => Promise<boolean>>(
      functionSource('retryThread'), {
        findThread: () => thread,
        isLiveThread: dependencies.isLiveThread,
        spawnPty,
      },
    );
    const handlePtyExit = compileFunction<(payload: { thread_id: string }) => boolean>(
      functionSource('handlePtyExit'), {
        clearThreadAttention: () => undefined,
        findThread: () => thread,
        syncThreadPaneMetadata: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        state,
        setProjectStatus: () => undefined,
        findProject: () => project,
      },
    );

    await expect(spawnPty(thread)).resolves.toBe(false);
    expect(thread.status).toBe('failed');
    expect(state.threads).toEqual([thread]);
    await expect(retryThread(thread.id)).resolves.toBe(true);
    expect(thread.status).toBe('running');
    expect(handlePtyExit({ thread_id: thread.id })).toBe(true);
    expect(thread.status).toBe('exited');
    expect(thread.startInFlight).toBe(false);
    await expect(retryThread(thread.id)).resolves.toBe(false);
    expect(thread.status).toBe('exited');
    expect(thread.ptyStarted).toBe(false);
    await expect(retryThread(thread.id)).resolves.toBe(true);
    expect(thread.status).toBe('running');
    expect(state.threads).toEqual([thread]);
    expect(writes.join('')).toContain('[pty_start error]');
    expect(writes.join('')).toContain('[process exited]');
  });

  it('prevents rapid double retry while a retry start is in flight', async () => {
    let resolveStart: (() => void) | null = null;
    let starts = 0;
    const thread = {
      id: 'thread-1', projectId: 'project', status: 'failed', spawning: false,
      closing: false, closeStarted: false, startInFlight: false, stopRequested: false,
      ptyStarted: false, launch: {
        command: '/bin/coven', args: ['code', '--session-id', COVEN_SESSION_ID], env: {}, projectRoot: '/repo', cwd: '/repo',
        launchKind: 'coven-chat', covenSessionId: COVEN_SESSION_ID, metricsProvider: 'coven',
      }, term: null,
    };
    const state = { threads: [thread], activeThreadId: thread.id };
    const spawnPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
      functionSource('spawnPty'), {
        ...spawnPtyRuntimeDeps,
        invoke: () => { starts += 1; return new Promise<void>((resolve) => { resolveStart = resolve; }); },
        isLiveThread: (value: typeof thread) => state.threads.includes(value) && !value.closing,
        pendingDataBuffers: new Map(),
        syncThreadPaneMetadata: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        state,
        setProjectStatus: () => undefined,
        findProject: () => ({ id: 'project' }),
        setStatus: () => undefined,
        stopThreadPty: () => Promise.resolve(false),
        refreshCovenSessions: () => Promise.resolve(),
      },
    );
    const retryThread = compileFunction<(id: string) => Promise<boolean>>(
      functionSource('retryThread'), {
        findThread: () => thread,
        isLiveThread: (value: typeof thread) => state.threads.includes(value) && !value.closing,
        spawnPty,
      },
    );

    const first = retryThread(thread.id);
    await expect(retryThread(thread.id)).resolves.toBe(false);
    expect(starts).toBe(1);
    expect(thread.status).toBe('starting');
    (resolveStart as unknown as () => void)();
    await expect(first).resolves.toBe(true);
  });

  it('revalidates an attachment before retrying its PTY', async () => {
    const source = functionSource('retryThread');
    expect(source).toContain('await refreshCovenSessions()');
    expect(source).toContain('covenDiscovery.phase === "ready"');
    expect(source).toContain('session.id === thread.launch.covenSessionId');
    expect(source.indexOf('await refreshCovenSessions()')).toBeLessThan(
      source.indexOf('spawnPty(thread)'),
    );

    const thread = {
      id: 'attached', projectId: 'alpha', status: 'failed', startInFlight: false,
      closeStarted: false,
      launch: { launchKind: 'coven-attach', covenSessionId: 'gone' },
    };
    let spawns = 0;
    const statuses: Array<[string, string]> = [];
    const retryThread = compileFunction<(id: string) => Promise<boolean>>(
      source,
      {
        findThread: () => thread,
        findProject: () => ({ id: 'alpha', root: '/alpha' }),
        refreshCovenSessions: async () => undefined,
        covenDiscovery: { phase: 'ready' },
        covenSessionsForProject: () => [],
        setStatus: (message: string, level: string) => { statuses.push([message, level]); },
        spawnPty: () => { spawns += 1; return Promise.resolve(true); },
      },
    );

    await expect(retryThread(thread.id)).resolves.toBe(false);
    expect(spawns).toBe(0);
    expect(statuses).toEqual([[
      'Coven session is no longer available; refresh the rail before retrying', 'warn',
    ]]);
  });

  it('adopts an already-running Rust PTY response as the live retry', async () => {
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const ackedSequences: number[] = [];
    runtimeThreadIds.add('thread-1');
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'pty_start') throw new Error('PTY already running for thread');
      if (command === 'pty_ack') ackedSequences.push(args?.sequence as number);
      return undefined;
    });
    const controller = createPtyClient({
      threadId: 'thread-1',
      invoke,
      visible: true,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });
    await controller.markPtyStarted();
    expect(routePtyBatch({
      threadId: 'thread-1',
      sequence: 1,
      bytes: [1],
      byteCount: 1,
    })).toBe(true);
    writes[0].callback();
    await flushPromises();
    expect(routePtyBatch({
      threadId: 'thread-1',
      sequence: 2,
      bytes: [2],
      byteCount: 1,
    })).toBe(true);
    writes[1].callback();
    await flushPromises();

    const thread = {
      id: 'thread-1', projectId: 'project', status: 'failed', spawning: false,
      closing: false, closeStarted: false, startInFlight: false, stopRequested: true,
      ptyStarted: false, launch: {
        command: '/bin/coven', args: ['code', '--session-id', COVEN_SESSION_ID], env: {}, projectRoot: '/repo', cwd: '/repo',
        launchKind: 'coven-chat', covenSessionId: COVEN_SESSION_ID, metricsProvider: 'coven',
      }, term: { cols: 120, rows: 40, write: () => undefined },
      terminalController: controller,
    };
    const state = { threads: [thread], activeThreadId: thread.id };
    const projectLevels: string[] = [];
    const spawnPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
      functionSource('spawnPty'), {
        ...spawnPtyRuntimeDeps,
        invoke,
        isLiveThread: (value: typeof thread) => state.threads.includes(value) && !value.closing,
        syncThreadPaneMetadata: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        state,
        setProjectStatus: (_project: unknown, level: string) => { projectLevels.push(level); },
        findProject: () => ({ id: 'project' }),
        setStatus: () => undefined,
        stopThreadPty: () => Promise.resolve(false),
        refreshCovenSessions: () => Promise.resolve(),
      },
    );

    await expect(spawnPty(thread)).resolves.toBe(true);
    expect(thread.status).toBe('running');
    expect(thread.ptyStarted).toBe(true);
    expect(thread.stopRequested).toBe(false);
    expect(projectLevels).toEqual(['ok']);
    expect(routePtyBatch({
      threadId: 'thread-1',
      sequence: 3,
      bytes: [3],
      byteCount: 1,
    })).toBe(true);
    expect(Array.from(writes[2].bytes)).toEqual([3]);
    writes[2].callback();
    await flushPromises();
    expect(ackedSequences).toEqual([1, 2, 3]);
  });

  it('resets stale runtime state only when a PTY retry actually starts', async () => {
    const source = functionSource('spawnPty');
    expect(source).toMatch(
      /thread\.lastOutputAt = 0;[\s\S]{0,80}thread\.isWorking = false;[\s\S]{0,80}thread\.sidebarStatusKey = "busy";/,
    );
    expect(source).toMatch(
      /attentionTracker\.forget\(thread\.id\);[\s\S]{0,80}thread\.needsAttention = false;[\s\S]{0,80}thread\.attentionReason = null;[\s\S]{0,80}syncThreadAttentionChrome\(thread\);/,
    );

    const refreshSnapshots: Array<Record<string, unknown>> = [];
    const chromeSnapshots: Array<Record<string, unknown>> = [];
    const forgotten: string[] = [];
    const thread = {
      id: 'thread-1', projectId: 'project', status: 'failed', spawning: false,
      closing: false, closeStarted: false, startInFlight: false, stopRequested: true,
      ptyStarted: false, lastOutputAt: 12_345, isWorking: true, sidebarStatusKey: 'attention',
      needsAttention: true, attentionReason: 'question',
      launch: {
        command: '/bin/zsh', args: [], env: {}, projectRoot: '/repo', cwd: '/repo',
        launchKind: 'shell', covenSessionId: null,
      }, term: null, terminalController: null as Record<string, unknown> | null,
    };
    const state = { threads: [thread], activeThreadId: null };
    const spawnPty = compileFunction<(value: typeof thread) => Promise<boolean>>(source, {
      attentionTracker: {
        forget: (id: string) => { forgotten.push(id); },
      },
      syncThreadAttentionChrome: (value: typeof thread) => {
        chromeSnapshots.push({
          needsAttention: value.needsAttention,
          attentionReason: value.attentionReason,
        });
      },
      ensureThreadPtyController(current: typeof thread) {
        if (current.terminalController) return current.terminalController;
        const controller = {
          prepareForPtyStart: () => 1,
          restoreAfterFailedPtyStart: () => undefined,
          adoptRunningPty: () => Promise.resolve(false),
          markPtyStarted: () => Promise.resolve(false),
          stopPtyDelivery: () => undefined,
          dispose: () => undefined,
        };
        current.terminalController = controller;
        return controller;
      },
      invoke: async () => undefined,
      isLiveThread: (value: typeof thread) => state.threads.includes(value) && !value.closing,
      pendingDataBuffers: new Map(),
      syncThreadPaneMetadata: () => undefined,
      refreshSidebar: () => {
        refreshSnapshots.push({
          lastOutputAt: thread.lastOutputAt,
          isWorking: thread.isWorking,
          sidebarStatusKey: thread.sidebarStatusKey,
          needsAttention: thread.needsAttention,
          attentionReason: thread.attentionReason,
          status: thread.status,
          spawning: thread.spawning,
        });
      },
      refreshTabs: () => undefined,
      state,
      setProjectStatus: () => undefined,
      findProject: () => ({ id: 'project' }),
      setStatus: () => undefined,
      stopThreadPty: () => Promise.resolve(false),
      refreshCovenSessions: () => Promise.resolve(),
    });

    await expect(spawnPty(thread)).resolves.toBe(true);
    expect(forgotten).toEqual(['thread-1']);
    expect(chromeSnapshots[0]).toEqual({
      needsAttention: false,
      attentionReason: null,
    });
    expect(refreshSnapshots[0]).toEqual({
      lastOutputAt: 0,
      isWorking: false,
      sidebarStatusKey: 'busy',
      needsAttention: false,
      attentionReason: null,
      status: 'starting',
      spawning: true,
    });

    const guarded = {
      ...thread,
      id: 'thread-2',
      startInFlight: true,
      stopRequested: true,
      lastOutputAt: 77,
      isWorking: true,
      sidebarStatusKey: 'active',
      needsAttention: true,
      attentionReason: 'turn',
    };
    state.threads.push(guarded);
    await expect(spawnPty(guarded)).resolves.toBe(false);
    expect(guarded).toMatchObject({
      lastOutputAt: 77,
      isWorking: true,
      sidebarStatusKey: 'active',
      needsAttention: true,
      attentionReason: 'turn',
      stopRequested: true,
    });
    expect(forgotten).toEqual(['thread-1']);
  });

  it('resets stop coordination for retry and stops the retried PTY once on close', async () => {
    const calls: string[] = [];
    const thread = {
      id: 'thread-1', projectId: 'project', worktreePath: '/repo', status: 'exited',
      spawning: false, closing: false, closeStarted: false, startInFlight: false,
      stopRequested: true, ptyStarted: false,
      launch: {
        command: '/bin/coven', args: ['code', '--session-id', COVEN_SESSION_ID], env: {}, projectRoot: '/repo', cwd: '/repo',
        launchKind: 'coven-chat', covenSessionId: COVEN_SESSION_ID, metricsProvider: 'coven',
      }, term: { cols: 120, rows: 40, dispose: () => { calls.push('dispose'); } },
    };
    const state = { threads: [thread], activeThreadId: thread.id };
    const invoke = async (command: string) => { calls.push(command); };
    const stopThreadPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
      functionSource('stopThreadPty'), { invoke },
    );
    const spawnPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
      functionSource('spawnPty'), {
        ...spawnPtyRuntimeDeps,
        invoke,
        isLiveThread: (value: typeof thread) => state.threads.includes(value) && !value.closing,
        pendingDataBuffers: new Map(),
        syncThreadPaneMetadata: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        state,
        setProjectStatus: () => undefined,
        findProject: () => ({ id: 'project' }),
        setStatus: () => undefined,
        stopThreadPty,
        refreshCovenSessions: () => Promise.resolve(),
      },
    );
    const retryThread = compileFunction<(id: string) => Promise<boolean>>(
      functionSource('retryThread'), {
        findThread: () => thread,
        isLiveThread: (value: typeof thread) => state.threads.includes(value) && !value.closing,
        spawnPty,
      },
    );
    const closeThread = compileFunction<(id: string) => boolean>(functionSource('closeThread'), {
      forgetThreadInSets: () => undefined,
      findThread: () => thread,
      detachThreadPane: () => null,
      retainFileFocusAfterThreadRemoval: () => false,
      pendingDataBuffers: new Map(),
      stopThreadPty,
      state,
      renderPaneWorkspace: () => undefined,
      setProjectStatus: () => undefined,
      findProject: () => ({ id: 'project' }),
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      focusThread: () => undefined,
    });

    await expect(retryThread(thread.id)).resolves.toBe(true);
    expect(thread.stopRequested).toBe(false);
    expect(closeThread(thread.id)).toBe(true);
    expect(closeThread(thread.id)).toBe(false);
    expect(calls.filter((call) => call === 'pty_stop')).toHaveLength(1);
    expect(calls.filter((call) => call === 'dispose')).toHaveLength(1);
    expect(state.threads).toEqual([]);
  });

  it.each(['failed', 'exited'])('issues one guarded stop when closing a retained %s pane', (status) => {
    const thread = {
      id: 'thread-1', projectId: 'project', worktreePath: '/repo', status,
      spawning: false, closing: false, closeStarted: false, startInFlight: false,
      stopRequested: false, ptyStarted: false, term: null,
    };
    const state = { threads: [thread], activeThreadId: thread.id };
    let stopCalls = 0;
    const closeThread = compileFunction<(id: string) => boolean>(functionSource('closeThread'), {
      forgetThreadInSets: () => undefined,
      findThread: () => thread,
      detachThreadPane: () => null,
      retainFileFocusAfterThreadRemoval: () => false,
      pendingDataBuffers: new Map(),
      stopThreadPty: () => { stopCalls += 1; return Promise.resolve(true); },
      state,
      renderPaneWorkspace: () => undefined,
      setProjectStatus: () => undefined,
      findProject: () => ({ id: 'project' }),
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      focusThread: () => undefined,
    });

    expect(closeThread(thread.id)).toBe(true);
    expect(stopCalls).toBe(1);
    expect(state.threads).toEqual([]);
  });

  it('keeps a rejected PTY stop guarded and reports the failure once', async () => {
    const warnings: string[] = [];
    const thread = { id: 'thread-1', stopRequested: false };
    let stopCalls = 0;
    const stopThreadPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
      functionSource('stopThreadPty'), {
        invoke: async () => { stopCalls += 1; throw new Error('stop unavailable'); },
        console: { warn: (message: string) => { warnings.push(message); } },
      },
    );

    await expect(stopThreadPty(thread)).resolves.toBe(false);
    await expect(stopThreadPty(thread)).resolves.toBe(false);
    expect(stopCalls).toBe(1);
    expect(thread.stopRequested).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('thread-1');
    expect(warnings[0]).toContain('stop unavailable');
  });

  it('stops once when close wins a start and ignores late lifecycle callbacks', async () => {
    let resolveStart: (() => void) | null = null;
    let stopCalls = 0;
    const thread = {
      id: 'thread-1', projectId: 'project', worktreePath: '/repo', status: 'starting',
      spawning: true, closing: false, closeStarted: false, startInFlight: false,
      stopRequested: false, ptyStarted: false,
      launch: {
        command: '/bin/coven', args: ['code', '--session-id', COVEN_SESSION_ID], env: {}, projectRoot: '/repo', cwd: '/repo',
        launchKind: 'coven-chat', covenSessionId: COVEN_SESSION_ID, metricsProvider: 'coven',
      }, term: { cols: 120, rows: 40, dispose: () => undefined },
    };
    const state = { threads: [thread], activeThreadId: thread.id };
    const invoke = (command: string) => {
      if (command === 'pty_start') return new Promise<void>((resolve) => { resolveStart = resolve; });
      if (command === 'pty_stop') stopCalls += 1;
      return Promise.resolve();
    };
    const isLiveThread = (value: typeof thread) => state.threads.includes(value) && !value.closing;
    const stopThreadPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
      functionSource('stopThreadPty'), { invoke },
    );
    const spawnPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
      functionSource('spawnPty'), {
        ...spawnPtyRuntimeDeps,
        invoke, isLiveThread, stopThreadPty,
        pendingDataBuffers: new Map(),
        syncThreadPaneMetadata: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        state,
        setProjectStatus: () => undefined,
        findProject: () => ({ id: 'project' }),
        setStatus: () => undefined,
      },
    );
    const closeThread = compileFunction<(id: string) => boolean>(functionSource('closeThread'), {
      forgetThreadInSets: () => undefined,
      findThread: () => state.threads.find((value) => value.id === thread.id) || null,
      detachThreadPane: () => null,
      retainFileFocusAfterThreadRemoval: () => false,
      pendingDataBuffers: new Map(),
      stopThreadPty,
      state,
      renderPaneWorkspace: () => undefined,
      setProjectStatus: () => undefined,
      findProject: () => ({ id: 'project' }),
      refreshSidebar: () => undefined,
      refreshTabs: () => undefined,
      focusThread: () => undefined,
    });
    const handlePtyExit = compileFunction<(payload: { thread_id: string }) => boolean>(
      functionSource('handlePtyExit'), {
        clearThreadAttention: () => undefined,
        findThread: () => state.threads.find((value) => value.id === thread.id) || null,
        syncThreadPaneMetadata: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        state,
        setProjectStatus: () => undefined,
        findProject: () => ({ id: 'project' }),
      },
    );

    const starting = spawnPty(thread);
    expect(closeThread(thread.id)).toBe(true);
    expect(closeThread(thread.id)).toBe(false);
    (resolveStart as unknown as () => void)();
    await expect(starting).resolves.toBe(false);
    expect(stopCalls).toBe(1);
    expect(handlePtyExit({ thread_id: thread.id })).toBe(false);
    expect(state.threads).toEqual([]);
  });

  it.each(['resolve', 'already-running'])(
    'does not resurrect an exited PTY when its start later settles via %s',
    async (settlement) => {
      let resolveStart: (() => void) | null = null;
      let rejectStart: ((error: Error) => void) | null = null;
      let starts = 0;
      const thread = {
        id: 'thread-1', projectId: 'project', status: 'starting', spawning: true,
        closing: false, closeStarted: false, startInFlight: false, exitDuringStart: false,
        stopRequested: false, ptyStarted: false, launch: {
          command: '/bin/coven', args: ['code', '--session-id', COVEN_SESSION_ID], env: {}, projectRoot: '/repo', cwd: '/repo',
          launchKind: 'coven-chat', covenSessionId: COVEN_SESSION_ID, metricsProvider: 'coven',
        }, term: { cols: 120, rows: 40, write: () => undefined },
      };
      const state = { threads: [thread], activeThreadId: thread.id };
      const isLiveThread = (value: typeof thread) => state.threads.includes(value) && !value.closing;
      const spawnPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
        functionSource('spawnPty'), {
          ...spawnPtyRuntimeDeps,
          invoke: () => {
            starts += 1;
            return new Promise<void>((resolve, reject) => {
              resolveStart = resolve;
              rejectStart = reject;
            });
          },
          isLiveThread,
          pendingDataBuffers: new Map(),
          syncThreadPaneMetadata: () => undefined,
          refreshSidebar: () => undefined,
          refreshTabs: () => undefined,
          state,
          setProjectStatus: () => undefined,
          findProject: () => ({ id: 'project' }),
          setStatus: () => undefined,
          stopThreadPty: () => Promise.resolve(false),
        },
      );
      const retryThread = compileFunction<(id: string) => Promise<boolean>>(
        functionSource('retryThread'), {
          findThread: () => thread,
          isLiveThread,
          spawnPty,
        },
      );
      const handlePtyExit = compileFunction<(payload: { thread_id: string }) => boolean>(
        functionSource('handlePtyExit'), {
          clearThreadAttention: () => undefined,
          findThread: () => thread,
          syncThreadPaneMetadata: () => undefined,
          refreshSidebar: () => undefined,
          refreshTabs: () => undefined,
          state,
          setProjectStatus: () => undefined,
          findProject: () => ({ id: 'project' }),
        },
      );

      const starting = spawnPty(thread);
      expect(thread.startInFlight).toBe(true);
      expect(handlePtyExit({ thread_id: thread.id })).toBe(true);
      expect(thread.status).toBe('exited');
      expect(thread.startInFlight).toBe(true);
      await expect(retryThread(thread.id)).resolves.toBe(false);
      expect(starts).toBe(1);

      if (settlement === 'resolve') {
        (resolveStart as unknown as () => void)();
      } else {
        (rejectStart as unknown as (error: Error) => void)(new Error('PTY already running for thread'));
      }
      await expect(starting).resolves.toBe(false);
      expect(thread.startInFlight).toBe(false);
      expect(thread.status).toBe('exited');
      expect(thread.ptyStarted).toBe(false);
      expect(thread.exitDuringStart).toBe(false);
      expect(starts).toBe(1);
    },
  );

  it('offers retry from the pane menu only for failed and exited panes', () => {
    const source = functionSource('mountTerminal');

    // The header dropped its retry button, so the pane's context menu is the
    // only place the action can live - the sidebar row cannot carry it, since
    // exited rows are hidden from the rail.
    expect(source).not.toContain('terminal-pane-retry');
    expect(source).toMatch(
      /thread\.status === "exited" \|\| thread\.status === "failed"[\s\S]*label: "Retry"/
    );
    expect(source).toMatch(/label: "Retry"[\s\S]*retryThread\(thread\.id\)/);

    // The in-flight guard that the old hidden-button logic enforced still lives
    // in retryThread itself, which its own lifecycle tests cover.
    expect(functionSource('retryThread')).toMatch(/thread\.startInFlight \|\| thread\.closeStarted/);
    expect(functionSource('retryThread')).toMatch(
      /thread\.status !== "exited" && thread\.status !== "failed"/
    );
  });

  it('keeps Coven available only through explicit guarded launch surfaces', () => {
    expect(mainJs).toContain('Launch a lane — Coven, a shell, or a browser');
    expect(mainJs).not.toContain('No terminal pane yet — opening Psyche…');
    expect(mainJs).not.toMatch(/canvas-empty-sub[\s\S]{0,200}Psyche TUI/);
    expect(mainJs).not.toMatch(/function\s+ensureProjectPsyche\s*\(/);
    expect(mainJs).not.toMatch(/function\s+spawnDefaultThread(?:In)?\s*\(/);
    expect(mainJs).toMatch(/cmd:\s*"\/new-thread"[\s\S]*?run:\s*runNewThreadCommand/);
    expect(mainJs).toMatch(/cmd:\s*"\/new-shell"[\s\S]*?run:\s*runNewShellCommand/);
    expect(mainJs).toMatch(/cmd:\s*"\/new-psyche"[\s\S]*?run:\s*runNewPsycheCommand/);
    expect(functionSource('runNewThreadCommand')).toContain(
      'return ensureProjectCoven(activeProject());',
    );
    expect(functionSource('runNewShellCommand')).toMatch(/return createTerminalPane\(\);/);
    expect(functionSource('runNewPsycheCommand')).toMatch(/spawnPsycheThread/);
    expect(functionSource('spawnAgentThread')).toMatch(
      /if \(entry\.id === "coven-code"\) \{[\s\S]*return ensureProjectCoven\(project\);[\s\S]*\}\s*if \(!\(await showTerminalView\(\)\)\) return null;/,
    );
    expect(functionSource('setActiveProject')).not.toContain('ensureProjectCoven');
    expect(functionSource('setActiveProject')).not.toContain('ensureCoven');
    expect(functionSource('openProjectPicker')).not.toContain('ensureProjectCoven');
    expect(functionSource('boot')).not.toContain('ensureProjectCoven');
    expect(mainJs).toContain('label: "Open Coven Terminal"');
    expect(mainJs).toMatch(
      /label: "Open Coven Terminal"[\s\S]*await ensureProjectCoven\(project\);/,
    );
    expect(mainJs).toMatch(/\/new-thread[\s\S]*\/new-shell[\s\S]*\/new-psyche/);
  });
});
