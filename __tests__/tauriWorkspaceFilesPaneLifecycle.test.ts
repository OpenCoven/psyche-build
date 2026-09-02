import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withFilesScopeSelectionHelper } from './tauriMainHarness';

const mainJs = readFileSync(
  join(process.cwd(), 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
);

function extractFunctionSource(name: string) {
  const asyncStart = mainJs.indexOf(`async function ${name}(`);
  const syncStart = mainJs.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const paramsStart = mainJs.indexOf('(', start);
  let paramsDepth = 0;
  let bodyStart = -1;
  for (let index = paramsStart; index < mainJs.length; index += 1) {
    if (mainJs[index] === '(') paramsDepth += 1;
    if (mainJs[index] === ')') paramsDepth -= 1;
    if (paramsDepth === 0) {
      bodyStart = mainJs.indexOf('{', index);
      break;
    }
  }
  let depth = 0;
  for (let index = bodyStart; index < mainJs.length; index += 1) {
    if (mainJs[index] === '{') depth += 1;
    if (mainJs[index] === '}') depth -= 1;
    if (depth === 0) return mainJs.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function compileFunction<T extends (...args: never[]) => unknown>(
  name: string,
  dependencies: Record<string, unknown>,
) {
  const resolvedDependencies = withFilesScopeSelectionHelper(
    extractFunctionSource,
    dependencies,
  );
  const names = Object.keys(resolvedDependencies);
  return Function(
    ...names,
    `"use strict"; return (${extractFunctionSource(name)});`,
  )(...Object.values(resolvedDependencies)) as T;
}

describe('native Files pane lifecycle', () => {
  it('reserves restored generated ids before allocating new pane ids', () => {
    const paneIdSequence = compileFunction<(id: string) => bigint>(
      'paneIdSequence',
      { BigInt },
    );
    const nextPaneId = compileFunction<(prefix: string) => string>(
      'nextPaneId',
      { paneCounter: 9007199254740991n },
    );
    const restoredIds: string[] = [];
    const restoredTrees: unknown[] = [];
    const project = { id: 'project-a' };
    const filesPanes = new Map<string, Record<string, unknown>>();
    const paneLayouts = new Map<string, Record<string, unknown>>();
    const restorePersistedFilesPanes = compileFunction<
      (savedPanes: Array<Record<string, unknown>>) => void
    >('restorePersistedFilesPanes', {
      filesPanes,
      findProject: () => project,
      filesPaneKey: (projectId: string, root: string) => `${projectId}\0${root}`,
      reservePaneId: (id: string) => { restoredIds.push(id); },
    });
    const restorePersistedPaneLayouts = compileFunction<
      (savedLayouts: Array<Record<string, any>>, restoredIds: Set<string>) => void
    >('restorePersistedPaneLayouts', {
      paneLayouts,
      findProject: () => project,
      paneLayoutKey: (projectId: string, root: string) => `${projectId}\0${root}`,
      reservePaneTreeIds: (root: unknown) => { restoredTrees.push(root); },
      PsychePanes: {
        leafIds: () => ['leaf-15'],
        findLeafById: () => ({ threadId: 'files-12' }),
      },
    });
    const tree = { type: 'leaf', id: 'leaf-15', threadId: 'files-12' };

    restorePersistedFilesPanes([
      { id: 'files-12', projectId: project.id, workspaceRoot: '/repo', hidden: false },
    ]);
    restorePersistedPaneLayouts([
      { projectId: project.id, worktreePath: '/repo', root: tree, focusedLeafId: 'leaf-15' },
    ], new Set(['files-12']));

    expect(paneIdSequence('files-12')).toBe(12n);
    expect(paneIdSequence('split-9007199254740992')).toBe(9007199254740992n);
    expect(paneIdSequence('files-invalid')).toBe(0n);
    expect(nextPaneId('leaf')).toBe('leaf-9007199254740992');
    expect(nextPaneId('leaf')).toBe('leaf-9007199254740993');
    expect(restoredIds).toEqual(['files-12']);
    expect(restoredTrees).toEqual([tree]);
  });

  it('creates one stable Files surface per worktree and commits its first placement', () => {
    const filesPanes = new Map<string, Record<string, unknown>>();
    const placements: unknown[] = [];
    const ensureFilesPane = compileFunction<
      (project: { id: string }, workspaceRoot: string) => Record<string, unknown>
    >('ensureFilesPane', {
      filesPanes,
      filesPaneKey: (projectId: string, root: string) => `${projectId}\0${root}`,
      nextPaneId: () => 'files-1',
      state: { activeThreadId: 'thread-a', threads: [] },
      prepareFilesPanePlacement: (pane: unknown) => ({ key: 'layout', value: pane }),
      commitPanePlacement: (placement: unknown) => { placements.push(placement); },
      mountFilesPane: () => ({ id: 'pane' }),
    });

    const first = ensureFilesPane({ id: 'project-a' }, '/worktree-a');
    const again = ensureFilesPane({ id: 'project-a' }, '/worktree-a');
    const other = ensureFilesPane({ id: 'project-a' }, '/worktree-b');

    expect(first).toMatchObject({
      id: 'files-1', kind: 'files', projectId: 'project-a', workspaceRoot: '/worktree-a',
      activeFileId: null, previousFocusedSessionId: 'thread-a',
    });
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(filesPanes.size).toBe(2);
    expect(placements).toHaveLength(2);
  });

  it('restores layouts that include visible persisted Files panes', async () => {
    const project = { id: 'project-a', lastActiveThreadId: null };
    const state = { projects: [project], threads: [] as Record<string, any>[], activeThreadId: null as string | null };
    const filesPanes = new Map<string, Record<string, unknown>>();
    const paneLayouts = new Map<string, Record<string, unknown>>();
    const restorePersistedFilesPanes = compileFunction<
      (savedPanes: Array<Record<string, unknown>>) => void
    >('restorePersistedFilesPanes', {
      filesPanes,
      findProject: () => project,
      filesPaneKey: (projectId: string, root: string) => `${projectId}\0${root}`,
      reservePaneId: () => undefined,
    });
    const restorePersistedPaneLayouts = compileFunction<
      (savedLayouts: Array<Record<string, unknown>>, restoredIds: Set<string>) => void
    >('restorePersistedPaneLayouts', {
      paneLayouts,
      findProject: () => project,
      paneLayoutKey: (projectId: string, root: string) => `${projectId}\0${root}`,
      reservePaneTreeIds: () => undefined,
      PsychePanes: {
        leafIds: () => ['leaf-thread', 'leaf-files'],
        findLeafById: (_root: unknown, leafId: string) => (
          leafId === 'leaf-thread'
            ? { threadId: 'thread-a' }
            : leafId === 'leaf-files'
              ? { threadId: 'files-a' }
              : null
        ),
      },
    });
    const restorePersistedSessions = compileFunction<
      (saved: Record<string, any>, liveSessionIds: string[]) => Promise<Record<string, unknown>>
    >('restorePersistedSessions', {
      PsycheWorkspace: {
        reconcileSessions: () => ({
          sessions: [{
            id: 'thread-a',
            projectId: project.id,
            worktreePath: '/repo',
            hidden: false,
            persistentLive: false,
            status: 'exited',
          }],
          unknownLiveIds: [],
        }),
      },
      window: {
        PsycheWorkspace: {
          reconcileSessions: () => ({
            sessions: [{
              id: 'thread-a',
              projectId: project.id,
              worktreePath: '/repo',
              hidden: false,
              persistentLive: false,
              status: 'exited',
            }],
            unknownLiveIds: [],
          }),
        },
      },
      state,
      findProject: () => project,
      restoredSessionThread: (descriptor: Record<string, any>) => ({
        id: descriptor.id,
        projectId: descriptor.projectId,
        worktreePath: descriptor.worktreePath,
        hidden: descriptor.hidden,
        ptyStarted: true,
        status: 'exited',
      }),
      restorePersistedFilesPanes,
      filesPanes,
      restorePersistedPaneLayouts,
      ensureRestoredSessionPlacements: () => undefined,
      mountTerminal: () => undefined,
      invoke: async () => [],
      attachThreadClient: () => undefined,
      findThread: (id: string) => state.threads.find((thread) => thread.id === id) || null,
    });

    await restorePersistedSessions({
      sessions: [],
      filesPanes: [{ id: 'files-a', projectId: project.id, workspaceRoot: '/repo', hidden: false }],
      paneLayouts: [{
        projectId: project.id,
        worktreePath: '/repo',
        root: {
          type: 'split',
          id: 'split-a',
          first: { type: 'leaf', id: 'leaf-thread', threadId: 'thread-a' },
          second: { type: 'leaf', id: 'leaf-files', threadId: 'files-a' },
        },
        focusedLeafId: 'leaf-files',
      }],
      activeThreadId: null,
    }, []);

    expect(paneLayouts.get(`${project.id}\0/repo`)).toEqual({
      root: {
        type: 'split',
        id: 'split-a',
        first: { type: 'leaf', id: 'leaf-thread', threadId: 'thread-a' },
        second: { type: 'leaf', id: 'leaf-files', threadId: 'files-a' },
      },
      focusedLeafId: 'leaf-files',
    });
  });

  it('reopens a hidden Files pane when the active file is selected again', async () => {
    const file = { id: 'file-a', projectId: 'project-a', workspaceRoot: '/repo' };
    const project = { id: 'project-a' };
    const calls: string[] = [];
    const activateFileTab = compileFunction<(id: string) => Promise<boolean>>(
      'activateFileTab',
      {
        findOpenFile: () => file,
        state: { activeFileId: file.id },
        findProject: () => project,
        ensureFilesPane: () => { calls.push('ensure'); },
        fileEditor: { focus: () => { calls.push('focus'); } },
        activateFileTabNow: () => { calls.push('activate'); return true; },
      },
    );

    await expect(activateFileTab(file.id)).resolves.toBe(true);
    expect(calls).toEqual(['ensure', 'focus']);
  });

  it('scopes file tabs by both project and worktree', () => {
    const files = [
      { id: 'a', projectId: 'p', workspaceRoot: '/one' },
      { id: 'b', projectId: 'p', workspaceRoot: '/two' },
      { id: 'c', projectId: 'q', workspaceRoot: '/one' },
    ];
    const projectFiles = compileFunction<
      (projectId: string, workspaceRoot: string) => typeof files
    >('projectFiles', {
      state: { activeProjectId: 'p', openFiles: files },
      activeProject: () => ({ id: 'p' }),
      activeWorkspaceRoot: () => '/one',
      workspaceModel: () => ({
        workspaceFiles: (openFiles: typeof files, projectId: string, root: string) =>
          openFiles.filter((file) => file.projectId === projectId && file.workspaceRoot === root),
      }),
    });

    expect(projectFiles('p', '/one').map((file) => file.id)).toEqual(['a']);
    expect(projectFiles('p', '/two').map((file) => file.id)).toEqual(['b']);
  });

  it('removes a Files surface, collapses its leaf, and stages the shared editor', () => {
    const pane = {
      id: 'files-a', projectId: 'p', workspaceRoot: '/one',
      pane: { remove: () => undefined }, host: { id: 'host-a' }, activeFileId: 'a',
    };
    const filesPanes = new Map([['p\0/one', pane]]);
    const staging = { appendChildCalls: [] as unknown[], appendChild(node: unknown) { this.appendChildCalls.push(node); } };
    const fileViewEl = { hidden: false, parentElement: pane.host };
    const rendered: unknown[] = [];
    const removeFilesPaneNow = compileFunction<(surface: typeof pane) => string | null>(
      'removeFilesPaneNow',
      {
        filesPaneKey: () => 'p\0/one', filesPanes,
        detachThreadPane: () => 'thread-next',
        fileSurfaceStagingEl: staging, fileViewEl,
        clearFileFocusPresentation: () => { fileViewEl.hidden = true; },
        state: { activeFileId: 'a' },
        renderPaneWorkspace: () => { rendered.push('render'); },
        focusThread: (id: string) => { rendered.push(id); },
        refreshTabs: () => undefined,
      },
    );

    expect(removeFilesPaneNow(pane)).toBe('thread-next');
    expect(filesPanes.size).toBe(0);
    expect(staging.appendChildCalls).toEqual([fileViewEl]);
    expect(fileViewEl.hidden).toBe(true);
    expect(rendered).toContain('render');
  });

  it('does not stage or hide another worktree pane editor when removing an inactive pane', () => {
    const pane = {
      id: 'files-a', projectId: 'p', workspaceRoot: '/one',
      pane: { remove: () => undefined }, host: { id: 'host-a' }, activeFileId: 'a',
    };
    const activeHost = { id: 'host-b' };
    const fileViewEl = { hidden: false, parentElement: activeHost };
    let staged = 0;
    let cleared = 0;
    const removeFilesPaneNow = compileFunction<(surface: typeof pane) => string | null>(
      'removeFilesPaneNow',
      {
        filesPaneKey: () => 'p\0/one', filesPanes: new Map([['p\0/one', pane]]),
        detachThreadPane: () => null,
        fileSurfaceStagingEl: { appendChild: () => { staged += 1; } }, fileViewEl,
        clearFileFocusPresentation: () => { cleared += 1; },
        state: { activeFileId: 'other-worktree-file' },
        renderPaneWorkspace: () => undefined,
        refreshTabs: () => undefined,
      },
    );

    removeFilesPaneNow(pane);
    expect({ staged, cleared, hidden: fileViewEl.hidden }).toEqual({
      staged: 0, cleared: 0, hidden: false,
    });
  });

  it('guards every dirty tab before atomically closing a Files pane', async () => {
    const pane = { id: 'files-a', projectId: 'p', workspaceRoot: '/one' };
    const files = [{ id: 'a' }, { id: 'b' }];
    const state = { openFiles: files.slice() };
    let removed = 0;
    const closeFilesPane = compileFunction<(surface: typeof pane) => Promise<boolean>>(
      'closeFilesPane',
      {
        fileNavigationInFlight: false, fileDecisionInFlight: null,
        filesForPane: () => files,
        guardDirtyFiles: async () => false,
        state,
        removeFilesPaneNow: () => { removed += 1; },
      },
    );

    await expect(closeFilesPane(pane)).resolves.toBe(false);
    expect(state.openFiles).toEqual(files);
    expect(removed).toBe(0);
  });

  it('removes all pane tabs only after the pane-wide guard succeeds', async () => {
    const pane = { id: 'files-a', projectId: 'p', workspaceRoot: '/one' };
    const files = [{ id: 'a' }, { id: 'b' }];
    const other = { id: 'other' };
    const state = { openFiles: [...files, other] };
    let removed: unknown = null;
    const closeFilesPane = compileFunction<(surface: typeof pane) => Promise<boolean>>(
      'closeFilesPane',
      {
        fileNavigationInFlight: false, fileDecisionInFlight: null,
        filesForPane: () => files,
        guardDirtyFiles: async (guarded: unknown[]) => guarded.length === files.length,
        state,
        removeFilesPaneNow: (surface: unknown) => { removed = surface; },
      },
    );

    await expect(closeFilesPane(pane)).resolves.toBe(true);
    expect(state.openFiles).toEqual([other]);
    expect(removed).toBe(pane);
  });

  it('selects the nearest scoped neighbor and removes the pane after its final tab', () => {
    const source = extractFunctionSource('closeFileTab');
    expect(source).toMatch(/filesForPane\(filesPane\)/);
    expect(source).toMatch(/nextFileIdAfterClose/);
    expect(source).toMatch(/removeFilesPaneNow\(filesPane\)/);
    expect(source.indexOf('await guardDirtyFile(file)')).toBeLessThan(source.indexOf('state.openFiles ='));
  });

  it('opens and reuses a worktree Files pane without registering a fake thread', () => {
    const source = extractFunctionSource('openFileTab');
    expect(source).toMatch(/if \(!project \|\| project\.closing\) return false/);
    expect(source).toMatch(/ensureFilesPane\(project, workspaceRoot\)/);
    expect(source).toMatch(/f\.workspaceRoot === workspaceRoot/);
    expect(source).toMatch(/filesPane\.activeFileId = file\.id/);
    expect(source).toMatch(/catch \(err\) \{[\s\S]*file\.error = String\(err\)/);
    expect(mainJs).not.toMatch(/state\.threads\.push\(filesPane\)/);
  });

  it('does not leave a partial file record when project teardown wins pane creation', async () => {
    const project = { id: 'p', root: '/repo', closing: false };
    const state = { openFiles: [] as Array<Record<string, unknown>> };
    let reads = 0;
    const openFileTab = compileFunction<(
      path: string,
      candidateProject: { id: string; root: string; closing: boolean },
    ) => Promise<boolean>>(
      'openFileTab',
      {
        activeProject: () => project,
        activeWorkspaceRoot: () => '/repo',
        state,
        fileNavigationInFlight: false,
        fileDecisionInFlight: null,
        ensureFilesPane: () => {
          project.closing = true;
          return null;
        },
        relativeToRoot: () => 'README.md',
        window: {
          PsycheCodeEditor: {
            languageForPath: () => 'markdown',
            createFileBuffer: () => ({}),
          },
        },
        invoke: async () => {
          reads += 1;
          return {};
        },
        activateFileTabNow: () => true,
        renderFileView: () => undefined,
        fileCounter: 0,
      },
    );

    await expect(openFileTab('/repo/README.md', project)).resolves.toBe(false);
    expect(state.openFiles).toEqual([]);
    expect(reads).toBe(0);
  });

  it('restores scoped Files selection on project/worktree switches and removes project panes', () => {
    expect(extractFunctionSource('setActiveProject')).toMatch(
      /restoreFilesPaneSelection\(project, workspaceRoot\)/,
    );
    expect(extractFunctionSource('activatePaneLayoutFocus')).toMatch(
      /restoreFilesPaneSelection\(project, worktreePath\)/,
    );
    expect(extractFunctionSource('removeProject')).toMatch(
      /projectFilesPanes[\s\S]*removeFilesPaneNow/,
    );
  });

  it('reveals a failed dirty save in its inactive worktree before aborting pane-wide removal', async () => {
    const project = {
      id: 'p', root: '/repo', selectedWorktreePath: '/active', lastActiveThreadId: 'thread-active',
    };
    const activeHost = { id: 'active-host' };
    const ownerHost = { id: 'owner-host' };
    const activePane = {
      id: 'files-active', kind: 'files', projectId: 'p', workspaceRoot: '/active',
      activeFileId: 'active-file', host: activeHost,
    };
    const ownerPane = {
      id: 'files-owner', kind: 'files', projectId: 'p', workspaceRoot: '/inactive',
      activeFileId: 'failed-file', host: ownerHost,
    };
    const failedFile = {
      id: 'failed-file', projectId: 'p', workspaceRoot: '/inactive', dirty: true,
      savePromise: Promise.resolve({ backendSucceeded: false, canContinue: false }),
    };
    const activeFile = {
      id: 'active-file', projectId: 'p', workspaceRoot: '/active', dirty: false,
    };
    const state: {
      activeProjectId: string;
      activeThreadId: string | null;
      activeFileId: string;
      projects: typeof project[];
      openFiles: Array<typeof activeFile | typeof failedFile>;
      threads: Array<Record<string, unknown>>;
    } = {
      activeProjectId: 'p', activeThreadId: 'thread-active', activeFileId: activeFile.id,
      projects: [project], openFiles: [activeFile, failedFile],
      threads: [
        { id: 'thread-active', projectId: 'p', worktreePath: '/active', kind: 'shell', hidden: false },
        { id: 'thread-owner', projectId: 'p', worktreePath: '/inactive', kind: 'shell', hidden: false },
      ],
    };
    const filesPanes = new Map([
      ['p\0/active', activePane],
      ['p\0/inactive', ownerPane],
    ]);
    const paneLayouts = new Map([
      ['p\0/active', { root: { id: 'active-layout' } }],
      ['p\0/inactive', { root: { id: 'owner-layout' } }],
    ]);
    const fileViewEl = { hidden: false, parentElement: activeHost };
    const filesPaneKey = (projectId: string, root: string) => `${projectId}\0${root}`;
    const findProject = () => project;
    const findOpenFile = (id: string) => state.openFiles.find((file) => file.id === id) || null;
    let filesScopeInvalidations = 0;
    const invalidateFilesPanelRender = () => {
      filesScopeInvalidations += 1;
      return filesScopeInvalidations;
    };
    const renderPaneWorkspace = () => {
      const pane = filesPanes.get(filesPaneKey(project.id, project.selectedWorktreePath));
      if (pane) fileViewEl.parentElement = pane.host;
    };
    const focusCanvasSurface = (pane: typeof activePane) => {
      project.selectedWorktreePath = pane.workspaceRoot;
      state.activeProjectId = pane.projectId;
      state.activeThreadId = null;
      return true;
    };
    const enterFileFocus = compileFunction<(file: typeof failedFile) => boolean>(
      'enterFileFocus',
      {
        state, fileFocus: { returnThreadId: 'thread-active' }, fileViewEl, filesPanes,
        filesPaneKey, focusCanvasSurface, syncPaneMetricsVisibility: () => undefined,
        syncAllPtyVisibility: () => undefined,
        activePaneLayout: () => paneLayouts.get(filesPaneKey(project.id, project.selectedWorktreePath)),
        renderPaneMinimap: () => undefined,
      },
    );
    const activateFileTabNow = compileFunction<(id: string) => boolean>(
      'activateFileTabNow',
      {
        findOpenFile, findProject, state,
        invalidateFilesPanelRender,
        ensureFilesPane: (_project: typeof project, root: string) =>
          filesPanes.get(filesPaneKey(project.id, root)),
        renderPaneWorkspace, enterFileFocus,
        markActiveSurface: () => undefined, refreshTabs: () => undefined,
        renderFileView: () => undefined,
      },
    );
    const revealFileForDecision = compileFunction<(file: typeof failedFile) => boolean>(
      'revealFileForDecision',
      {
        findOpenFile, findProject, state,
        invalidateFilesPanelRender,
        activeWorkspaceRoot: () => project.selectedWorktreePath,
        clearPassiveCovenPaneFocus: () => undefined, renderPaneWorkspace,
        renderGitSurface: () => undefined, loadAgentSkills: () => undefined,
        syncProjectBrowser: () => undefined, saveWorkspaceSoon: () => undefined,
        activateFileTabNow, refreshSidebar: () => undefined,
      },
    );
    const guardDirtyFile = compileFunction<(file: typeof failedFile) => Promise<boolean>>(
      'guardDirtyFile',
      {
        revealFileForDecision, restoreFileEditorFocus: () => undefined,
        showFileDecision: () => Promise.resolve('cancel'), discardFile: () => undefined,
        saveFile: () => Promise.resolve({ backendSucceeded: false, canContinue: false }),
      },
    );
    const guardDirtyFiles = compileFunction<(files: typeof failedFile[]) => Promise<boolean>>(
      'guardDirtyFiles', { guardDirtyFile },
    );

    const beforeFiles = state.openFiles.slice();
    const beforePaneCount = filesPanes.size;
    const beforeLayoutCount = paneLayouts.size;
    const canRemove = await guardDirtyFiles([failedFile]);
    if (canRemove) state.openFiles = [];

    expect(canRemove).toBe(false);
    expect(project.selectedWorktreePath).toBe('/inactive');
    expect(fileViewEl.parentElement).toBe(ownerHost);
    expect(ownerPane.activeFileId).toBe(failedFile.id);
    expect(state.activeFileId).toBe(failedFile.id);
    expect(state.openFiles).toEqual(beforeFiles);
    expect(filesPanes.size).toBe(beforePaneCount);
    expect(paneLayouts.size).toBe(beforeLayoutCount);
    expect(filesScopeInvalidations).toBe(1);
  });

  it('cleans final-tab ownership and lets the next Files pane capture a fresh terminal', async () => {
    const file = { id: 'file-a', projectId: 'p', workspaceRoot: '/one' };
    const host = { id: 'files-host' };
    const pane = {
      id: 'files-a', kind: 'files', projectId: 'p', workspaceRoot: '/one',
      activeFileId: file.id as string | null, previousFocusedSessionId: 'terminal-old',
      host, pane: { remove: () => undefined },
    };
    const state = {
      activeFileId: file.id as string | null,
      activeThreadId: null as string | null,
      openFiles: [file],
    };
    const filesPanes = new Map([['p\0/one', pane]]);
    const fileViewEl = { hidden: false, parentElement: host };
    let detached = 0;
    let staged = 0;
    const clearFileFocusPresentation = () => {
      state.activeFileId = null;
      fileViewEl.hidden = true;
    };
    const removeFilesPaneNow = compileFunction<(surface: typeof pane) => string | null>(
      'removeFilesPaneNow',
      {
        fileViewEl, detachThreadPane: () => { detached += 1; return 'terminal-next'; },
        filesPanes, filesPaneKey: () => 'p\0/one', state, clearFileFocusPresentation,
        fileSurfaceStagingEl: { appendChild: () => { staged += 1; } },
        refreshTabs: () => undefined, renderPaneWorkspace: () => undefined,
        focusThread: (id: string) => { state.activeThreadId = id; return true; },
      },
    );
    const closeFileTab = compileFunction<(id: string) => Promise<boolean>>(
      'closeFileTab',
      {
        findOpenFile: () => file, fileNavigationInFlight: false, fileDecisionInFlight: null,
        guardDirtyFile: async () => true, filesPanes, filesPaneKey: () => 'p\0/one',
        filesForPane: () => state.openFiles,
        nextFileIdAfterClose: () => null,
        state, removeFilesPaneNow, projectFiles: () => state.openFiles,
        clearFileFocusPresentation, clearPassiveCovenPaneFocus: () => undefined,
        refreshTabs: () => undefined, renderPaneWorkspace: () => undefined,
        activateFileTabNow: () => undefined,
      },
    );

    await expect(closeFileTab(file.id)).resolves.toBe(true);
    expect(state.openFiles).toEqual([]);
    expect(state.activeFileId).toBeNull();
    expect(pane.activeFileId).toBeNull();
    expect(pane.previousFocusedSessionId).toBeNull();
    expect(filesPanes.size).toBe(0);
    expect({ detached, staged, hidden: fileViewEl.hidden }).toEqual({
      detached: 1, staged: 1, hidden: true,
    });

    const freshPane = {
      id: 'files-fresh', kind: 'files', projectId: 'p', workspaceRoot: '/one',
      previousFocusedSessionId: null as string | null,
    };
    state.activeThreadId = 'terminal-fresh';
    const rememberFilesPaneReturnThread = compileFunction<(surface: typeof freshPane) => string | null>(
      'rememberFilesPaneReturnThread',
      {
        state,
        findThread: (id: string) => ({
          id, kind: 'shell', projectId: 'p', worktreePath: '/one', hidden: false, status: 'running',
        }),
        fileFocus: { returnThreadId: null },
      },
    );
    expect(rememberFilesPaneReturnThread(freshPane)).toBe('terminal-fresh');
    expect(freshPane.previousFocusedSessionId).toBe('terminal-fresh');
  });

  it('keeps per-worktree terminal return targets current and falls back when one is removed', async () => {
    const paneOne = {
      id: 'files-one', kind: 'files', projectId: 'p', workspaceRoot: '/one',
      previousFocusedSessionId: null as string | null,
    };
    const paneTwo = {
      id: 'files-two', kind: 'files', projectId: 'p', workspaceRoot: '/two',
      previousFocusedSessionId: null as string | null,
    };
    const threads = new Map([
      ['terminal-a', { id: 'terminal-a', kind: 'shell', projectId: 'p', worktreePath: '/one', hidden: false, status: 'running' }],
      ['terminal-b', { id: 'terminal-b', kind: 'shell', projectId: 'p', worktreePath: '/one', hidden: false, status: 'running' }],
      ['terminal-two', { id: 'terminal-two', kind: 'shell', projectId: 'p', worktreePath: '/two', hidden: false, status: 'running' }],
    ]);
    const state = { activeThreadId: 'terminal-a' as string | null, activeFileId: 'file-one' };
    const fileFocus = { returnThreadId: null as string | null };
    const rememberFilesPaneReturnThread = compileFunction<(surface: typeof paneOne) => string | null>(
      'rememberFilesPaneReturnThread',
      { state, findThread: (id: string) => threads.get(id), fileFocus },
    );

    rememberFilesPaneReturnThread(paneOne);
    state.activeThreadId = 'terminal-b';
    rememberFilesPaneReturnThread(paneOne);
    state.activeThreadId = 'terminal-two';
    rememberFilesPaneReturnThread(paneTwo);
    expect(paneOne.previousFocusedSessionId).toBe('terminal-b');
    expect(paneTwo.previousFocusedSessionId).toBe('terminal-two');

    const focused: string[] = [];
    let currentPane = paneOne;
    const returnFromFileFocus = compileFunction<() => Promise<boolean>>(
      'returnFromFileFocus',
      {
        filesPaneHasCanvasFocus: () => true,
        activeFilesPane: () => currentPane,
        findOpenFile: () => ({ id: state.activeFileId }), state, fileFocus,
        resolveFileFocusThreadId: (preferred: string | null) =>
          preferred && threads.has(preferred) ? preferred : 'terminal-a',
        showTerminalView: async () => true, clearPassiveCovenPaneFocus: () => undefined,
        activePaneLayout: () => null, focusThread: async (id: string) => {
          focused.push(id); return true;
        },
        renderPaneMinimap: () => undefined, refreshSidebar: () => undefined,
        renderPaneWorkspace: () => undefined,
      },
    );

    await returnFromFileFocus();
    currentPane = paneTwo;
    await returnFromFileFocus();
    threads.delete('terminal-b');
    const retainFileFocusAfterThreadRemoval = compileFunction<
      (removedId: string, nextId: string, projectId: string) => boolean
    >('retainFileFocusAfterThreadRemoval', {
      state, fileFocus, filesPanes: new Map([
        ['p\0/one', paneOne], ['p\0/two', paneTwo],
      ]),
      filesPaneHasCanvasFocus: () => true,
      findProject: () => null,
    });
    expect(retainFileFocusAfterThreadRemoval('terminal-b', 'terminal-a', 'p')).toBe(true);
    expect(paneOne.previousFocusedSessionId).toBeNull();
    currentPane = paneOne;
    await returnFromFileFocus();
    expect(focused).toEqual(['terminal-b', 'terminal-two', 'terminal-a']);
  });

  it('does not retain Files focus when a selected file is behind the focused terminal', () => {
    const state = { activeThreadId: 'terminal-a', activeFileId: 'file-one' };
    const fileFocus = { returnThreadId: 'terminal-a' as string | null };
    const pane = {
      id: 'files-one', previousFocusedSessionId: 'terminal-a' as string | null,
    };
    const retainFileFocusAfterThreadRemoval = compileFunction<
      (removedId: string, nextId: string, projectId: string) => boolean
    >('retainFileFocusAfterThreadRemoval', {
      state,
      fileFocus,
      filesPanes: new Map([['p\0/one', pane]]),
      filesPaneHasCanvasFocus: () => false,
      findProject: () => null,
    });

    expect(retainFileFocusAfterThreadRemoval('terminal-a', 'terminal-b', 'p')).toBe(false);
    expect(state.activeThreadId).toBe('terminal-a');
    expect(fileFocus.returnThreadId).toBe('terminal-a');
    expect(pane.previousFocusedSessionId).toBe('terminal-a');
  });
});
