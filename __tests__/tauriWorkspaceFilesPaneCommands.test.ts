import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

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
  return Function(
    ...Object.keys(dependencies),
    `"use strict"; return (${extractFunctionSource(name)});`,
  )(...Object.values(dependencies)) as T;
}

function keyEvent(key: string, options: Record<string, unknown> = {}) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...options,
  };
}

describe('native Files pane commands and dirty boundaries', () => {
  it('keeps Files leaves out of terminal pane numbering', async () => {
    const threads = new Map([
      ['terminal-a', { id: 'terminal-a' }],
      ['terminal-b', { id: 'terminal-b' }],
    ]);
    const leaves = [
      { id: 'leaf-a', threadId: 'terminal-a' },
      { id: 'leaf-files', threadId: 'files-pane' },
      { id: 'leaf-b', threadId: 'terminal-b' },
    ];
    const canvasThreadIds = compileFunction<() => string[]>('canvasThreadIds', {
      activePaneLayout: () => ({ root: { leaves } }),
      PsychePanes: {
        leafIds: () => leaves.map((leaf) => leaf.id),
        findLeafById: (_root: unknown, id: string) => leaves.find((leaf) => leaf.id === id),
      },
      findThread: (id: string) => threads.get(id) || null,
    });
    const focused: string[] = [];
    const routeGlobalShortcut = compileFunction<
      (event: ReturnType<typeof keyEvent>) => Promise<void>
    >('routeGlobalShortcut', {
      routeAgentPickerModalKeydown: () => false,
      routeGitPaneShortcut: () => false,
      routeFilesShortcut: () => false,
      canvasThreadIds,
      activePaneLayout: () => ({ root: { leaves }, activeSetId: null }),
      paneFocusEligible: () => true,
      focusThread: async (id: string) => { focused.push(id); return true; },
    });
    const event = keyEvent('2', { ctrlKey: true });

    expect(canvasThreadIds()).toEqual(['terminal-a', 'terminal-b']);
    await routeGlobalShortcut(event);
    expect(focused).toEqual(['terminal-b']);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('routes file commands only while the current Files surface owns canvas focus', () => {
    const calls: string[] = [];
    let focused = false;
    const route = compileFunction<(event: ReturnType<typeof keyEvent>) => boolean>(
      'routeFilesShortcut',
      {
        filesPaneHasCanvasFocus: () => focused,
        returnFromFileFocus: () => { calls.push('escape'); },
        handleExplicitFileSave: () => { calls.push('save'); },
        closeFileTab: (id: string) => { calls.push(`close:${id}`); },
        switchTab: (delta: number) => { calls.push(`switch:${delta}`); },
        projectFiles: () => [{ id: 'one' }, { id: 'two' }],
        activateFileTab: (id: string) => { calls.push(`activate:${id}`); },
        state: { activeFileId: 'two' },
      },
    );

    const inactiveSave = keyEvent('s', { metaKey: true });
    expect(route(inactiveSave)).toBe(false);
    expect(inactiveSave.preventDefault).not.toHaveBeenCalled();
    expect(calls).toEqual([]);

    focused = true;
    const number = keyEvent('2', { metaKey: true });
    expect(route(number)).toBe(true);
    expect(number.preventDefault).toHaveBeenCalledOnce();
    expect(calls).toEqual(['activate:two']);

    const missing = keyEvent('9', { metaKey: true });
    expect(route(missing)).toBe(true);
    expect(missing.preventDefault).toHaveBeenCalledOnce();

    expect(route(keyEvent('w', { metaKey: true }))).toBe(true);
    expect(route(keyEvent('s', { metaKey: true }))).toBe(true);
    expect(route(keyEvent('Escape'))).toBe(true);
    expect(calls).toEqual(['activate:two', 'close:two', 'save', 'escape']);
  });

  it('switches to an already-open dirty tab without prompting or changing its buffer', async () => {
    const dirty = { id: 'dirty', text: 'unsaved', dirty: true };
    let activated: string | null = null;
    const activate = compileFunction<(id: string) => Promise<boolean>>('activateFileTab', {
      findOpenFile: (id: string) => id === dirty.id ? dirty : null,
      state: { activeFileId: 'other' },
      fileEditor: { focus: vi.fn() },
      fileNavigationInFlight: false,
      fileDecisionInFlight: null,
      guardDirtyFile: () => { throw new Error('tab activation must not guard'); },
      activateFileTabNow: (id: string) => { activated = id; return true; },
    });

    await expect(activate(dirty.id)).resolves.toBe(true);
    expect(activated).toBe(dirty.id);
    expect(dirty).toMatchObject({ text: 'unsaved', dirty: true });
  });

  it('keeps non-destructive project and worktree selection outside dirty guards', () => {
    expect(extractFunctionSource('setActiveProject')).not.toContain('guardActiveFileBoundary');
    expect(extractFunctionSource('activateProjectWorktree')).not.toContain('guardActiveFileBoundary');
    expect(extractFunctionSource('addProject')).not.toContain('guardActiveFileBoundary');
    expect(extractFunctionSource('removeProject')).toMatch(
      /await guardDirtyFiles\(projectOpenFiles\)[\s\S]*if \(!canRemove\) return false;/,
    );
    expect(extractFunctionSource('closeFilesPane')).toMatch(
      /await guardDirtyFiles\(files\)[\s\S]*if \(!canClose\) return false;[\s\S]*state\.openFiles =/,
    );
  });

  it('blocks browser unload for dirty or pending files without stopping live status polling', () => {
    type BeforeUnloadEventStub = {
      preventDefault: ReturnType<typeof vi.fn>;
      returnValue: boolean | undefined;
    };
    for (const inactive of [
      { id: 'inactive-dirty', dirty: true, savePromise: null, workspaceRoot: '/inactive' },
      { id: 'inactive-pending', dirty: false, savePromise: Promise.resolve(), workspaceRoot: '/inactive' },
    ]) {
      const event: BeforeUnloadEventStub = { preventDefault: vi.fn(), returnValue: undefined };
      const stop = vi.fn();
      const handler = compileFunction<(event: BeforeUnloadEventStub) => boolean | undefined>(
        'handleWindowBeforeUnload',
        {
          state: {
            openFiles: [
              { id: 'active', dirty: false, savePromise: null, workspaceRoot: '/active' },
              inactive,
            ],
          },
          saveWorkspaceNow: vi.fn().mockResolvedValue(true),
          statusController: { stop },
          destroyingWindow: false,
        },
      );

      expect(handler(event)).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.returnValue).toBe(true);
      expect(stop).not.toHaveBeenCalled();
    }
  });

  it('allows a clean browser unload without prematurely stopping status polling', () => {
    type CleanUnloadEventStub = {
      preventDefault: ReturnType<typeof vi.fn>;
      returnValue: boolean | undefined;
    };
    const event: CleanUnloadEventStub = { preventDefault: vi.fn(), returnValue: undefined };
    const stop = vi.fn();
    const saveWorkspaceNow = vi.fn().mockResolvedValue(true);
    const handler = compileFunction<(value: CleanUnloadEventStub) => boolean | undefined>(
      'handleWindowBeforeUnload',
      {
        state: { openFiles: [{ id: 'clean', dirty: false, savePromise: null }] },
        saveWorkspaceNow,
        statusController: { stop },
        destroyingWindow: false,
      },
    );

    expect(handler(event)).toBeUndefined();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(saveWorkspaceNow).toHaveBeenCalledOnce();
  });

  it('accepts only live process-backed panes as the Escape destination', () => {
    const available = compileFunction<
      (thread: Record<string, unknown> | null, root: unknown, project: { id: string }, workspace: string, allowCoven: boolean) => boolean
    >('fileFocusThreadIsAvailable', {
      PsychePanes: { findLeafByThreadId: () => ({ id: 'leaf' }) },
    });
    const base = {
      id: 'terminal', projectId: 'p', worktreePath: '/w', kind: 'shell',
      hidden: false, closing: false, status: 'running',
    };

    expect(available(base, {}, { id: 'p' }, '/w', false)).toBe(true);
    expect(available({ ...base, kind: 'web' }, {}, { id: 'p' }, '/w', false)).toBe(false);
    expect(available({ ...base, kind: 'git' }, {}, { id: 'p' }, '/w', false)).toBe(false);
    expect(available({ ...base, status: 'exited' }, {}, { id: 'p' }, '/w', false)).toBe(false);
    expect(available({ ...base, closing: true }, {}, { id: 'p' }, '/w', false)).toBe(false);
  });

  it('falls back to the nearest live process-backed pane in layout order', () => {
    type Thread = {
      id: string;
      projectId: string;
      worktreePath: string;
      kind: string;
      hidden: boolean;
      closing: boolean;
      status: string;
    };
    const project = { id: 'p' };
    const filesPane = { id: 'files', projectId: 'p', workspaceRoot: '/w' };
    const makeThread = (id: string, overrides: Partial<Thread> = {}): Thread => ({
      id, projectId: 'p', worktreePath: '/w', kind: 'shell', hidden: false,
      closing: false, status: 'running', ...overrides,
    });

    function resolve(order: string[], threadList: Thread[]) {
      const leaves = order.map((threadId, index) => ({ id: `leaf-${index}`, threadId }));
      const root = { leaves };
      const threads = new Map(threadList.map((thread) => [thread.id, thread]));
      const PsychePanes = {
        leafIds: () => leaves.map((leaf) => leaf.id),
        findLeafById: (_root: unknown, id: string) => leaves.find((leaf) => leaf.id === id) || null,
        findLeafByThreadId: (_root: unknown, id: string) =>
          leaves.find((leaf) => leaf.threadId === id) || null,
      };
      const available = compileFunction<
        (thread: Thread | null, root: unknown, project: { id: string }, workspace: string, allowCoven: boolean) => boolean
      >('fileFocusThreadIsAvailable', { PsychePanes });
      const resolveFocus = compileFunction<(preferredId: string | null, allowCoven: boolean) => string | null>(
        'resolveFileFocusThreadId',
        {
          activeProject: () => project,
          activePaneLayout: () => ({ root, focusedLeafId: PsychePanes.findLeafByThreadId(root, 'files')?.id }),
          scopedPaneRoot: () => root,
          activeWorkspaceRoot: () => '/w',
          activeFilesPane: () => filesPane,
          findThread: (id: string) => threads.get(id) || null,
          fileFocusThreadIsAvailable: available,
          PsychePanes,
        },
      );
      return resolveFocus(null, false);
    }

    expect(resolve(
      ['a', 'b', 'unavailable-c', 'files'],
      [makeThread('a'), makeThread('b'), makeThread('unavailable-c', { hidden: true })],
    )).toBe('b');
    expect(resolve(['a', 'files', 'b'], [makeThread('a'), makeThread('b')])).toBe('a');
    expect(resolve(
      ['a', 'files', 'b'],
      [makeThread('a', { status: 'exited' }), makeThread('b')],
    )).toBe('b');
  });

  it('uses the guarded pane-close path directly and keeps middle-click on guarded tab close', () => {
    const mountSource = extractFunctionSource('mountFilesPane');
    expect(mountSource).toContain('closeFilesPane(filesPane)');
    expect(mountSource).not.toContain('typeof closeFilesPane');
    expect(extractFunctionSource('refreshTabs')).toMatch(
      /addEventListener\("auxclick"[\s\S]*e\.button !== 1[\s\S]*await closeFileTab\(file\.id\)/,
    );
  });
});
