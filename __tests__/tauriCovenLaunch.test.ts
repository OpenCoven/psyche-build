import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const libRs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8',
);
const mainJs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);

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
  it('builds a Coven chat descriptor scoped to the project and selected worktree', () => {
    const state = { env: { coven_path: '/opt/homebrew/bin/coven' } };
    const project = { root: '/repo', selectedWorktreePath: '/repo/.worktrees/feature' };
    const covenChatLaunch = compileFunction<(value: typeof project) => Record<string, unknown>>(
      functionSource('covenChatLaunch'),
      {
        state,
        selectedWorktree: () => ({ path: project.selectedWorktreePath }),
      },
    );

    expect(covenChatLaunch(project)).toEqual({
      command: '/opt/homebrew/bin/coven',
      args: ['chat'],
      env: {},
      projectRoot: '/repo',
      cwd: '/repo/.worktrees/feature',
      kind: 'coven-chat',
      launchKind: 'coven-chat',
      covenSessionId: null,
    });
  });

  it('copies one launch descriptor onto the thread and starts from that copy only', async () => {
    const state = { threads: [] as Array<Record<string, any>>, activeThreadId: null };
    let frame: (() => void) | null = null;
    const calls: Array<Record<string, any>> = [];
    const launch = {
      command: '/bin/coven', args: ['chat'], env: { TOKEN: 'before' },
      projectRoot: '/repo', cwd: '/repo/wt', launchKind: 'coven-chat', covenSessionId: null,
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
      },
    );
    const thread = createThread({
      project: { id: 'project' }, worktreePath: '/repo/wt', kind: 'coven-chat', launch,
    });
    launch.args.push('mutated');
    launch.env.TOKEN = 'after';
    expect(thread.launch).toEqual({
      command: '/bin/coven', args: ['chat'], env: { TOKEN: 'before' },
      projectRoot: '/repo', cwd: '/repo/wt', launchKind: 'coven-chat', covenSessionId: null,
    });
    expect(frame).not.toBeNull();
    (frame as unknown as () => void)();
    expect(calls).toEqual([thread]);

    const invoked: Array<Record<string, any>> = [];
    const spawnPty = compileFunction<(value: Record<string, any>) => Promise<boolean>>(
      functionSource('spawnPty'),
      {
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
        covenSessionId: null, coven_session_id: null,
        command: '/bin/coven', args: ['chat'], env: { TOKEN: 'before' },
      }),
    });
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
        covenChatLaunch: () => ({ command: '/bin/coven', args: ['chat'] }),
        createThread: (options: Record<string, unknown>) => { order.push('create'); return options; },
      },
    );

    const thread = await spawnCovenThread(project);
    expect(order).toEqual(['show', 'frame', 'create']);
    expect(thread).toMatchObject({ project, kind: 'coven-chat', name: 'Coven' });
  });

  it('coalesces concurrent automatic ensures through one animation-frame launch', async () => {
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
          command: '/bin/coven', args: ['chat'], cwd: path,
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

  it('cleans a rejected automatic ensure so the workspace can retry', async () => {
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
        covenChatLaunch: () => ({ command: '/bin/coven', args: ['chat'] }),
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
        covenChatLaunch: () => ({ command: '/bin/coven', args: ['chat'] }),
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
        covenChatLaunch: () => ({ command: '/bin/coven', args: ['chat'] }),
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

  it('does not overwrite picker or activation errors when Coven creation returns null', async () => {
    const project = { id: 'project', root: '/repo', name: 'repo' };
    const pickerStatuses: string[] = [];
    const openProjectPicker = compileFunction<() => Promise<void>>(
      functionSource('openProjectPicker'),
      {
        dialogOpen: async () => '/repo',
        state: { env: { home: '/home' } },
        addProject: async () => project,
        ensureProjectCoven: async () => null,
        setProjectStatus: () => { pickerStatuses.push('ok'); },
        writeToActive: () => undefined,
      },
    );
    await openProjectPicker();
    expect(pickerStatuses).toEqual([]);

    const activationStatuses: string[] = [];
    const setActiveProject = compileFunction<(id: string) => Promise<boolean>>(
      functionSource('setActiveProject'),
      {
        state: { activeProjectId: 'other', threads: [], activeThreadId: null },
        showTerminalView: async () => true,
        findProject: () => project,
        restoreProjectLayout: () => undefined,
        loadAgentSkills: () => undefined,
        activeWorkspaceRoot: () => '/repo',
        focusThread: async () => true,
        renderPaneWorkspace: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        syncProjectBrowser: () => undefined,
        ensureProjectCoven: async () => null,
        setStatus: (text: string) => { activationStatuses.push(text); },
        saveWorkspaceSoon: () => undefined,
      },
    );
    await setActiveProject(project.id);
    expect(activationStatuses).toEqual([]);
  });

  it('marks picker and activation ready only after Coven creation succeeds', async () => {
    const project = { id: 'project', root: '/repo', name: 'repo' };
    const pickerStatuses: string[] = [];
    const openProjectPicker = compileFunction<() => Promise<void>>(
      functionSource('openProjectPicker'),
      {
        dialogOpen: async () => '/repo',
        state: { env: { home: '/home' } },
        addProject: async () => project,
        ensureProjectCoven: async () => ({ id: 'coven' }),
        setProjectStatus: (_value: unknown, status: string) => { pickerStatuses.push(status); },
        writeToActive: () => undefined,
      },
    );
    await openProjectPicker();
    expect(pickerStatuses).toEqual(['ok']);

    const activationStatuses: string[] = [];
    const setActiveProject = compileFunction<(id: string) => Promise<boolean>>(
      functionSource('setActiveProject'),
      {
        state: { activeProjectId: 'other', threads: [], activeThreadId: null },
        showTerminalView: async () => true,
        findProject: () => project,
        restoreProjectLayout: () => undefined,
        loadAgentSkills: () => undefined,
        activeWorkspaceRoot: () => '/repo',
        focusThread: async () => true,
        renderPaneWorkspace: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        syncProjectBrowser: () => undefined,
        ensureProjectCoven: async () => ({ id: 'coven' }),
        setStatus: (text: string) => { activationStatuses.push(text); },
        saveWorkspaceSoon: () => undefined,
      },
    );
    await setActiveProject(project.id);
    expect(activationStatuses).toEqual(['no pane — launching Coven…']);

    const ready: string[] = [];
    const setProjectStatus = compileFunction<(value: typeof project, level: string) => void>(
      functionSource('setProjectStatus'),
      {
        activeProject: () => project,
        setStatus: (text: string) => { ready.push(text); },
      },
    );
    setProjectStatus(project, 'ok');
    expect(ready).toEqual(['Coven is ready']);
  });

  it('deduplicates only a visible live Coven chat in the exact workspace', async () => {
    const project = { id: 'project', root: '/repo' };
    const matching = {
      id: 'matching', projectId: project.id, worktreePath: '/repo/wt',
      kind: 'coven-chat', status: 'running', hidden: false,
    };
    const state = { threads: [
      { ...matching, id: 'hidden', hidden: true },
      { ...matching, id: 'exited', status: 'exited' },
      { ...matching, id: 'other', worktreePath: '/repo/other' },
      matching,
    ] };
    let focused = '';
    let spawned = 0;
    const ensureProjectCoven = compileFunction<(value: typeof project) => Promise<typeof matching>>(
      functionSource('ensureProjectCoven'),
      {
        selectedWorktree: () => ({ path: '/repo/wt' }),
        state,
        focusThread: async (id: string) => { focused = id; },
        spawnCovenThread: async () => { spawned += 1; return matching; },
        covenEnsureFlights: new Map(),
      },
    );
    await expect(ensureProjectCoven(project)).resolves.toBe(matching);
    expect({ focused, spawned }).toEqual({ focused: 'matching', spawned: 0 });

    state.threads = state.threads.filter((thread) => thread.id !== 'matching');
    await ensureProjectCoven(project);
    expect(spawned).toBe(1);
  });

  it('retains one pane through fail, retry, exit, and retry lifecycle transitions', async () => {
    const project = { id: 'project' };
    const writes: string[] = [];
    const thread = {
      id: 'thread-1', projectId: project.id, worktreePath: '/repo', name: 'Coven',
      launch: {
        command: '/bin/coven', args: ['chat'], env: {}, projectRoot: '/repo', cwd: '/repo',
        launchKind: 'coven-chat', covenSessionId: null,
      },
      status: 'starting', spawning: true, closing: false, closeStarted: false,
      startInFlight: false, stopRequested: false, ptyStarted: false,
      term: { cols: 120, rows: 40, write: (value: string) => writes.push(value) },
    };
    const state = { threads: [thread], activeThreadId: thread.id };
    const pendingDataBuffers = new Map<string, Uint8Array[]>();
    const starts: Array<'fail' | 'run'> = ['fail', 'run', 'run'];
    const invoke = async (command: string) => {
      if (command !== 'pty_start') return undefined;
      if (starts.shift() === 'fail') throw new Error('coven unavailable');
      return undefined;
    };
    const dependencies = {
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
        command: '/bin/coven', args: ['chat'], env: {}, projectRoot: '/repo', cwd: '/repo',
        launchKind: 'coven-chat', covenSessionId: null,
      }, term: null,
    };
    const state = { threads: [thread], activeThreadId: thread.id };
    const spawnPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
      functionSource('spawnPty'), {
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

  it('adopts an already-running Rust PTY response as the live retry', async () => {
    const writes: Uint8Array[] = [];
    const thread = {
      id: 'thread-1', projectId: 'project', status: 'failed', spawning: false,
      closing: false, closeStarted: false, startInFlight: false, stopRequested: true,
      ptyStarted: false, launch: {
        command: '/bin/coven', args: ['chat'], env: {}, projectRoot: '/repo', cwd: '/repo',
        launchKind: 'coven-chat', covenSessionId: null,
      }, term: { cols: 120, rows: 40, write: (value: Uint8Array) => writes.push(value) },
    };
    const state = { threads: [thread], activeThreadId: thread.id };
    const buffered = new Uint8Array([1, 2, 3]);
    const pendingDataBuffers = new Map([[thread.id, [buffered]]]);
    const projectLevels: string[] = [];
    const spawnPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
      functionSource('spawnPty'), {
        invoke: async () => { throw new Error('PTY already running for thread'); },
        isLiveThread: (value: typeof thread) => state.threads.includes(value) && !value.closing,
        pendingDataBuffers,
        syncThreadPaneMetadata: () => undefined,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        state,
        setProjectStatus: (_project: unknown, level: string) => { projectLevels.push(level); },
        findProject: () => ({ id: 'project' }),
        setStatus: () => undefined,
        stopThreadPty: () => Promise.resolve(false),
      },
    );

    await expect(spawnPty(thread)).resolves.toBe(true);
    expect(thread.status).toBe('running');
    expect(thread.ptyStarted).toBe(true);
    expect(thread.stopRequested).toBe(false);
    expect(writes).toEqual([buffered]);
    expect(pendingDataBuffers.has(thread.id)).toBe(false);
    expect(projectLevels).toEqual(['ok']);
  });

  it('resets stop coordination for retry and stops the retried PTY once on close', async () => {
    const calls: string[] = [];
    const thread = {
      id: 'thread-1', projectId: 'project', worktreePath: '/repo', status: 'exited',
      spawning: false, closing: false, closeStarted: false, startInFlight: false,
      stopRequested: true, ptyStarted: false,
      launch: {
        command: '/bin/coven', args: ['chat'], env: {}, projectRoot: '/repo', cwd: '/repo',
        launchKind: 'coven-chat', covenSessionId: null,
      }, term: { cols: 120, rows: 40, dispose: () => { calls.push('dispose'); } },
    };
    const state = { threads: [thread], activeThreadId: thread.id };
    const invoke = async (command: string) => { calls.push(command); };
    const stopThreadPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
      functionSource('stopThreadPty'), { invoke },
    );
    const spawnPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
      functionSource('spawnPty'), {
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
      findThread: () => thread,
      detachThreadPane: () => null,
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
      findThread: () => thread,
      detachThreadPane: () => null,
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
        command: '/bin/coven', args: ['chat'], env: {}, projectRoot: '/repo', cwd: '/repo',
        launchKind: 'coven-chat', covenSessionId: null,
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
      findThread: () => state.threads.find((value) => value.id === thread.id) || null,
      detachThreadPane: () => null,
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
          command: '/bin/coven', args: ['chat'], env: {}, projectRoot: '/repo', cwd: '/repo',
          launchKind: 'coven-chat', covenSessionId: null,
        }, term: { cols: 120, rows: 40, write: () => undefined },
      };
      const state = { threads: [thread], activeThreadId: thread.id };
      const isLiveThread = (value: typeof thread) => state.threads.includes(value) && !value.closing;
      const spawnPty = compileFunction<(value: typeof thread) => Promise<boolean>>(
        functionSource('spawnPty'), {
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

  it('shows one retry control only for failed and exited panes', () => {
    const retry = { hidden: false, setAttribute: () => undefined };
    const attributes = new Map<string, string>();
    const thread = {
      name: 'Coven', status: 'starting', paneTitle: { textContent: '' },
      paneStatus: { textContent: '' }, paneRetry: retry,
      paneClose: { setAttribute: (key: string, value: string) => attributes.set(key, value) },
    };
    const syncThreadPaneMetadata = compileFunction<(value: typeof thread) => void>(
      functionSource('syncThreadPaneMetadata'), {},
    );
    syncThreadPaneMetadata(thread);
    expect(retry.hidden).toBe(true);
    thread.status = 'failed';
    syncThreadPaneMetadata(thread);
    expect(retry.hidden).toBe(false);
    thread.status = 'running';
    syncThreadPaneMetadata(thread);
    expect(retry.hidden).toBe(true);
    thread.status = 'exited';
    (thread as typeof thread & { startInFlight: boolean }).startInFlight = true;
    syncThreadPaneMetadata(thread);
    expect(retry.hidden).toBe(true);
    (thread as typeof thread & { startInFlight: boolean }).startInFlight = false;
    syncThreadPaneMetadata(thread);
    expect(retry.hidden).toBe(false);
    expect(attributes.get('aria-label')).toBe('Stop and close Coven');

    const mount = functionSource('mountTerminal');
    expect(mount.match(/className = "terminal-pane-retry"/g)).toHaveLength(1);
    expect(mount).toMatch(/retry\.addEventListener\("click", function \(event\) \{[\s\S]*event\.stopPropagation\(\);[\s\S]*retryThread\(thread\.id\)/);
  });

  it('routes native defaults to Coven while retaining explicit shell and Psyche commands', () => {
    expect(mainJs).toContain('Launch a lane — Coven, a shell, or a browser');
    expect(mainJs).not.toContain('No terminal pane yet — opening Psyche…');
    expect(mainJs).not.toMatch(/canvas-empty-sub[\s\S]{0,200}Psyche TUI/);
    expect(mainJs).not.toMatch(/function\s+ensureProjectPsyche\s*\(/);
    expect(mainJs).not.toMatch(/function\s+spawnDefaultThread(?:In)?\s*\(/);
    expect(mainJs).toMatch(/cmd:\s*"\/new-thread"[\s\S]*?run:\s*runNewThreadCommand/);
    expect(mainJs).toMatch(/cmd:\s*"\/new-shell"[\s\S]*?run:\s*runNewShellCommand/);
    expect(mainJs).toMatch(/cmd:\s*"\/new-psyche"[\s\S]*?run:\s*runNewPsycheCommand/);
    expect(functionSource('runNewThreadCommand')).toMatch(/spawnCovenThread/);
    expect(functionSource('runNewShellCommand')).toMatch(/spawnShellThread/);
    expect(functionSource('runNewPsycheCommand')).toMatch(/spawnPsycheThread/);
    expect(functionSource('setActiveProject')).toMatch(/await ensureProjectCoven\(project\)/);
    expect(functionSource('setActiveProject')).toMatch(
      /var covenThread = await ensureProjectCoven\(project\);[\s\S]*if \(covenThread\) setStatus\("no pane — launching Coven…"/,
    );
    expect(functionSource('openProjectPicker')).toMatch(/await ensureProjectCoven\(project\)/);
    expect(functionSource('boot')).toMatch(/await ensureProjectCoven\(project\)/);
    expect(mainJs).toContain('label: "Open Coven Terminal"');
    expect(mainJs).toMatch(/ensureProjectCoven\(project\)/);
    expect(mainJs).toMatch(/\/new-thread[\s\S]*\/new-shell[\s\S]*\/new-psyche/);
  });
});
