import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const mainJs = readFileSync(
  join(process.cwd(), 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
);
const PsychePanes = await import(pathToFileURL(join(
  process.cwd(),
  'native/desktop/psyche-build-tauri/web/panes/pane-tree.mjs',
)).href);

function extractFunctionSource(name: string) {
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
  return Function(
    ...Object.keys(dependencies),
    `"use strict"; return (${source});`,
  )(...Object.values(dependencies)) as T;
}

describe('native Files pane layout contract', () => {
  it('keys Files panes through the shared project and workspace layout key', () => {
    const calls: unknown[][] = [];
    const filesPaneKey = compileFunction<(projectId: string, root: string) => string>(
      extractFunctionSource('filesPaneKey'),
      { paneLayoutKey: (...args: unknown[]) => { calls.push(args); return 'layout-key'; } },
    );

    expect(filesPaneKey('project-a', '/worktree')).toBe('layout-key');
    expect(calls).toEqual([['project-a', '/worktree']]);
  });

  it('finds a Files surface by pane id without adding it to threads', () => {
    const first = { id: 'files-a' };
    const second = { id: 'files-b' };
    const filesPanes = new Map([['first', first], ['second', second]]);
    const findFilesPane = compileFunction<(id: string) => typeof first | null>(
      extractFunctionSource('findFilesPaneBySurfaceId'),
      { filesPanes },
    );

    expect(findFilesPane('files-b')).toBe(second);
    expect(findFilesPane('missing')).toBeNull();
  });

  it('removes a Files leaf from the layout keyed by workspaceRoot', () => {
    const terminalLeaf = PsychePanes.createLeaf('terminal-leaf', 'thread-a');
    const filesLeaf = PsychePanes.createLeaf('files-pane', 'files-pane');
    const root = PsychePanes.insertRelative(
      terminalLeaf, 'terminal-leaf', filesLeaf, 'split-a', 'right',
    );
    const key = 'project-a\0/worktree';
    const paneLayouts = new Map([[key, { root, focusedLeafId: 'files-pane' }]]);
    const filesPane = {
      id: 'files-pane', projectId: 'project-a', workspaceRoot: '/worktree', kind: 'files',
    };
    const detachPane = compileFunction<(surface: { id: string }) => string | null>(
      extractFunctionSource('detachThreadPane'),
      {
        canvasSurfaceById: () => filesPane,
        paneLayoutKey: (projectId: string, rootPath: string) => `${projectId}\0${rootPath}`,
        paneLayouts,
        PsychePanes,
      },
    );

    expect(detachPane({ id: filesPane.id })).toBe('thread-a');
    expect(paneLayouts.get(key)?.root).toEqual(terminalLeaf);
    expect(paneLayouts.get(key)?.focusedLeafId).toBe('terminal-leaf');
  });

  it('keeps Files surfaces in a session-local registry outside threads', () => {
    expect(mainJs).toMatch(/var filesPanes = new Map\(\);/);
    expect(extractFunctionSource('canvasSurfaceById')).toMatch(
      /return findThread\(id\) \|\| findFilesPaneBySurfaceId\(id\);/,
    );
    expect(mainJs).not.toMatch(/state\.threads\.push\(filesPane\)/);
  });

  it('places Files to the right of the focused leaf', () => {
    const source = extractFunctionSource('prepareFilesPanePlacement');
    expect(source).toMatch(/PsychePanes\.createLeaf\([\s\S]*?filesPane\.id\)/);
    expect(source).toMatch(/PsychePanes\.insertRelative\([\s\S]*"right"\s*\)/);
  });

  it('preserves an untileable proposed root and maximizes Files', () => {
    const terminalLeaf = PsychePanes.createLeaf('terminal-leaf', 'thread-a');
    const key = 'project-a\0/worktree';
    const paneLayouts = new Map([[
      key,
      { root: terminalLeaf, focusedLeafId: terminalLeaf.id, activeSetId: 'set-a' },
    ]]);
    let counter = 0;
    const prepare = compileFunction<(pane: {
      id: string; projectId: string; workspaceRoot: string;
    }) => { key: string; value: Record<string, unknown> }>(
      extractFunctionSource('prepareFilesPanePlacement'),
      {
        filesPaneKey: () => key,
        paneLayouts,
        PsychePanes,
        nextPaneId: (prefix: string) => `${prefix}-${++counter}`,
        measuredTerminalHost: () => ({ x: 0, y: 0, width: 250, height: 150 }),
        PANE_MINIMUMS: { width: 200, height: 137, separator: 6 },
      },
    );

    const placement = prepare({
      id: 'files-pane', projectId: 'project-a', workspaceRoot: '/worktree',
    });
    expect(PsychePanes.leafIds(placement.value.root)).toEqual([
      'terminal-leaf', 'files-pane',
    ]);
    expect(placement.value.focusedLeafId).toBe('files-pane');
    expect(placement.value.maximizedLeafId).toBe('files-pane');
    expect(placement.value.activeSetId).toBe('set-a');
  });

  it('uses the Files leaf directly when the pane tree has no root', () => {
    const paneLayouts = new Map();
    const prepare = compileFunction<(pane: {
      id: string; projectId: string; workspaceRoot: string;
    }) => { value: { root: unknown; focusedLeafId: string; maximizedLeafId: string | null } }>(
      extractFunctionSource('prepareFilesPanePlacement'),
      {
        filesPaneKey: () => 'layout-key',
        paneLayouts,
        PsychePanes,
        nextPaneId: () => 'unused-split',
        measuredTerminalHost: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        PANE_MINIMUMS: { width: 200, height: 137, separator: 6 },
      },
    );

    const placement = prepare({
      id: 'files-pane', projectId: 'project-a', workspaceRoot: '/worktree',
    });
    expect(placement.value.root).toEqual(
      PsychePanes.createLeaf('files-pane', 'files-pane'),
    );
    expect(placement.value.focusedLeafId).toBe('files-pane');
    expect(placement.value.maximizedLeafId).toBeNull();
  });

  it('keeps Files in a focus-set projection without changing set membership', () => {
    const terminalLeaf = PsychePanes.createLeaf('terminal-leaf', 'thread-a');
    const filesLeaf = PsychePanes.createLeaf('files-pane', 'files-pane');
    const layout = {
      root: PsychePanes.insertRelative(
        terminalLeaf, terminalLeaf.id, filesLeaf, 'split-a', 'right',
      ),
      activeSetId: 'set-a',
    };
    const set = { id: 'set-a', threadIds: ['thread-a'] };
    const scopedPaneRoot = compileFunction<(value: typeof layout) => unknown>(
      extractFunctionSource('scopedPaneRoot'),
      {
        findFocusSet: () => set,
        canvasSurfaceById: (id: string) => id === 'files-pane'
          ? { id, kind: 'files' }
          : { id, kind: 'shell' },
        PsychePanes,
      },
    );

    expect(PsychePanes.leafIds(scopedPaneRoot(layout))).toEqual([
      'terminal-leaf', 'files-pane',
    ]);
    expect(set.threadIds).toEqual(['thread-a']);
  });

  it('clears a stale focus set before adding Files to its projection', () => {
    const terminalLeaf = PsychePanes.createLeaf('terminal-leaf', 'thread-b');
    const filesLeaf = PsychePanes.createLeaf('files-pane', 'files-pane');
    const layout = {
      root: PsychePanes.insertRelative(
        terminalLeaf, terminalLeaf.id, filesLeaf, 'split-a', 'right',
      ),
      activeSetId: 'set-a' as string | null,
    };
    const set = { id: 'set-a', threadIds: ['missing-thread'] };
    const scopedPaneRoot = compileFunction<(value: typeof layout) => unknown>(
      extractFunctionSource('scopedPaneRoot'),
      {
        findFocusSet: () => set,
        canvasSurfaceById: (id: string) => id === 'files-pane'
          ? { id, kind: 'files' }
          : { id, kind: 'shell' },
        PsychePanes,
      },
    );

    expect(scopedPaneRoot(layout)).toBe(layout.root);
    expect(PsychePanes.leafIds(layout.root)).toEqual([
      'terminal-leaf', 'files-pane',
    ]);
    expect(layout.activeSetId).toBeNull();
    expect(set.threadIds).toEqual(['missing-thread']);
  });

  it('renders a surviving Files surface after closing the active terminal', () => {
    const thread = {
      id: 'thread-a', kind: 'shell', projectId: 'project-a', worktreePath: '/worktree',
      closeStarted: false, closing: false, startInFlight: false,
      metricsGeneration: 0, metricsRefreshTimer: 0, term: null,
    };
    const filesPane = {
      id: 'files-pane', kind: 'files', projectId: 'project-a', workspaceRoot: '/worktree',
    };
    const layout = { focusedLeafId: 'terminal-leaf' };
    const state = {
      threads: [thread], activeThreadId: thread.id as string | null, activeFileId: null,
    };
    let renders = 0;
    let threadFocuses = 0;
    const closeThread = compileFunction<(id: string) => boolean>(
      extractFunctionSource('closeThread'),
      {
        findThread: (id: string) => state.threads.find((item) => item.id === id) || null,
        canvasSurfaceById: (id: string) => id === filesPane.id ? filesPane : null,
        canvasThreadIds: () => [],
        forgetThreadInSets: () => undefined,
        detachThreadPane: () => { layout.focusedLeafId = filesPane.id; return filesPane.id; },
        retainFileFocusAfterThreadRemoval: () => false,
        pendingDataBuffers: new Map(),
        stopThreadPty: () => Promise.resolve(true),
        state,
        renderPaneWorkspace: () => { renders += 1; },
        setProjectStatus: () => undefined,
        findProject: () => null,
        refreshSidebar: () => undefined,
        refreshTabs: () => undefined,
        focusThread: () => { threadFocuses += 1; },
      },
    );

    expect(closeThread(thread.id)).toBe(true);
    expect(layout.focusedLeafId).toBe(filesPane.id);
    expect(state.activeThreadId).toBeNull();
    expect(threadFocuses).toBe(0);
    expect(renders).toBe(1);
  });

  it('keeps process-only operations on session lookup boundaries', () => {
    for (const name of [
      'renderPaneNode',
      'activatePaneLayoutFocus',
      'cyclePaneSpan',
      'togglePaneMaximize',
      'detachThreadPane',
    ]) {
      expect(extractFunctionSource(name), name).toContain('canvasSurfaceById');
    }
    const terminalFitSource = extractFunctionSource('scheduleTerminalPaneFits');
    expect(terminalFitSource).toContain('thread.terminalController.scheduleFit()');
    expect(terminalFitSource).not.toContain('canvasSurfaceById');
    for (const name of [
      'handlePtyExit',
      'resolveImageDropTarget',
      'applySetScopeForThread',
    ]) {
      const source = extractFunctionSource(name);
      expect(source, name).toContain('findThread');
      expect(source, name).not.toContain('canvasSurfaceById');
    }
  });
});
