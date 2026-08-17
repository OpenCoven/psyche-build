import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = join(process.cwd(), 'native/desktop/psyche-build-tauri/web');
const mainJs = readFileSync(join(webRoot, 'main.js'), 'utf8');
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
const stylesCss = readFileSync(join(webRoot, 'styles.css'), 'utf8');

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

class FakeElement {
  tagName = '';
  className = '';
  id = '';
  type = '';
  title = '';
  textContent = '';
  tabIndex = 0;
  innerHTML = '';
  focusCalls = 0;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  listeners = new Map<string, Array<(event: Record<string, unknown>) => unknown>>();

  appendChild(child: FakeElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  addEventListener(name: string, listener: (event: Record<string, unknown>) => unknown) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches = (element: FakeElement) => {
      if (selector === '[role="tab"]') return element.attributes.get('role') === 'tab';
      if (selector.startsWith('.')) return element.className.split(/\s+/).includes(selector.slice(1));
      return false;
    };
    return this.children.flatMap((child) => [
      ...(matches(child) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  focus() {
    this.focusCalls += 1;
  }
}

describe('native Files pane view', () => {
  it('keeps exactly one reusable file editor host in neutral staging', () => {
    expect(indexHtml.match(/id="file-view"/g)).toHaveLength(1);
    expect(indexHtml.match(/id="file-editor-host"/g)).toHaveLength(1);
    expect(indexHtml).toMatch(
      /id="file-surface-staging"[^>]*hidden[\s\S]*id="file-view"/,
    );
    const terminalArea = indexHtml.slice(
      indexHtml.indexOf('<section class="terminal-area">'),
      indexHtml.indexOf('</section>', indexHtml.indexOf('<section class="terminal-area">')),
    );
    expect(terminalArea).not.toContain('id="file-view"');
  });

  it('mounts the reusable file view inside a semantic Files pane body', () => {
    const source = extractFunctionSource('mountFilesPane');
    expect(source).toMatch(/pane\.className\s*=\s*"terminal-pane is-files"/);
    expect(source).toMatch(/pane\.dataset\.surfaceId\s*=\s*filesPane\.id/);
    expect(source).toMatch(/pane\.setAttribute\("aria-label",\s*"Files pane"\)/);
    expect(source).toMatch(/body\.appendChild\(fileViewEl\)/);
    expect(source).not.toMatch(/cloneNode|createFileEditor/);
  });

  it('reparents the existing file view when mounting a Files surface', () => {
    const fileView = new FakeElement();
    fileView.id = 'file-view';
    const mountFilesPane = compileFunction<(surface: Record<string, unknown>) => FakeElement>(
      extractFunctionSource('mountFilesPane'),
      {
        document: { createElement: () => new FakeElement() },
        fileViewEl: fileView,
        createPaneHideButton: () => new FakeElement(),
        togglePaneMaximize: () => undefined,
        closeFilesPane: () => undefined,
        focusCanvasSurface: () => undefined,
      },
    );
    const surface: Record<string, unknown> = {
      id: 'files-a', projectId: 'project-a', workspaceRoot: '/worktree', kind: 'files',
    };

    const pane = mountFilesPane(surface);
    const body = pane.children[1];
    expect(pane.className).toBe('terminal-pane is-files');
    expect(pane.attributes.get('aria-label')).toBe('Files pane');
    expect(pane.dataset.surfaceId).toBe('files-a');
    expect(body.children).toEqual([fileView]);
    expect(fileView.parentElement).toBe(body);
    expect(surface.pane).toBe(pane);
    expect(surface.host).toBe(body);
  });

  it('keeps file tabs and editor controls inside the one reusable file view', () => {
    const fileViewStart = indexHtml.indexOf('id="file-view"');
    const fileViewEnd = indexHtml.indexOf('</div>\n      </div>', fileViewStart);
    const fileView = indexHtml.slice(fileViewStart, fileViewEnd);
    expect(fileView).toContain('id="tab-strip"');
    expect(fileView).toContain('id="file-save"');
    expect(fileView).toContain('id="file-editor-host"');
    expect(fileView).toMatch(/id="tab-strip"[^>]*role="tablist"[^>]*aria-label="Open files"/);
    expect(mainJs.match(/PsycheCodeEditor\.createFileEditor\(/g)).toHaveLength(1);
  });

  it('renders semantic file tabs with roving focus state', () => {
    const source = extractFunctionSource('refreshTabs');
    expect(source).toMatch(/tab\.setAttribute\("role",\s*"tab"\)/);
    expect(source).toMatch(/tab\.setAttribute\("aria-selected",\s*isActive \? "true" : "false"\)/);
    expect(source).toMatch(/tab\.tabIndex\s*=\s*isActive \? 0 : -1/);
  });

  it('wires Files hide, maximize, and delegated close controls', () => {
    const source = extractFunctionSource('mountFilesPane');
    expect(source).toMatch(/createPaneHideButton\(filesPane\)/);
    expect(source).not.toMatch(/cyclePaneSpan\(filesPane\)/);
    expect(source).toMatch(/togglePaneMaximize\(filesPane\)/);
    expect(source).toMatch(/closeFilesPane\(filesPane\)/);
  });

  it('repositions and maximizes Files from non-button header gestures', () => {
    const fileView = new FakeElement();
    const calls: Array<unknown> = [];
    const mountFilesPane = compileFunction<(surface: Record<string, unknown>) => FakeElement>(
      extractFunctionSource('mountFilesPane'),
      {
        document: {
          createElement: (tagName: string) => Object.assign(new FakeElement(), { tagName }),
        },
        fileViewEl: fileView,
        createPaneHideButton: () => new FakeElement(),
        startPaneReposition: (surface: unknown, event: unknown) => calls.push(['reposition', surface, event]),
        togglePaneMaximize: (surface: unknown) => calls.push(['maximize', surface]),
        closeFilesPane: () => undefined,
        focusCanvasSurface: () => undefined,
      },
    );
    const surface = { id: 'files-a', workspaceRoot: '/worktree', kind: 'files' };
    const pane = mountFilesPane(surface);
    const header = pane.children[0];
    const pointerdown = header.listeners.get('pointerdown')?.[0];
    const dblclick = header.listeners.get('dblclick')?.[0];
    const pointerEvent = {
      target: { closest: () => null },
    };
    const buttonEvent = {
      preventDefault: () => {
        throw new Error('preventDefault should not run for button targets');
      },
      target: { closest: () => ({}) },
    };
    let prevented = 0;
    const dblclickEvent = {
      preventDefault: () => { prevented += 1; },
      target: { closest: () => null },
    };

    expect(pointerdown).toBeTypeOf('function');
    expect(dblclick).toBeTypeOf('function');

    pointerdown?.(pointerEvent);
    dblclick?.(dblclickEvent);
    expect(prevented).toBe(1);
    expect(calls).toEqual([
      ['reposition', surface, pointerEvent],
      ['maximize', surface],
    ]);

    calls.length = 0;
    prevented = 0;
    pointerdown?.(buttonEvent);
    dblclick?.(buttonEvent);
    expect(prevented).toBe(0);
    expect(calls).toEqual([]);
  });

  it('hides Files non-destructively and restores it when a file is selected', () => {
    const filesPaneFactory = extractFunctionSource('ensureFilesPane');
    const hide = extractFunctionSource('hideFilesPane');
    const restore = extractFunctionSource('reopenFilesPane');
    const dispatch = extractFunctionSource('hideCanvasSurface');

    expect(filesPaneFactory).toContain('hidden: false');
    expect(filesPaneFactory).toContain('reopenFilesPane(existing)');
    expect(hide).toContain('detachThreadPane(filesPane)');
    expect(hide).toContain('filesPane.hidden = true');
    expect(hide).not.toContain('removeFilesPaneNow(filesPane)');
    expect(restore).toContain('prepareFilesPanePlacement(filesPane)');
    expect(restore).toContain('filesPane.hidden = false');
    expect(restore).toContain('commitPanePlacement(placement)');
    expect(dispatch).toContain('hideFilesPane(surface)');
    expect(dispatch).toContain('hideThread(surface.id)');
  });

  it('activates Files through the generic canvas focus seam without terminal focus', () => {
    const mountSource = extractFunctionSource('mountFilesPane');
    const focusSource = extractFunctionSource('focusCanvasSurface');
    expect(mountSource).toMatch(/focusCanvasSurface\(filesPane\)/);
    expect(focusSource).toMatch(/surface\.kind\s*!==\s*"files"[\s\S]*focusThread\(surface\.id\)/);
    expect(focusSource).toMatch(/state\.activeThreadId\s*=\s*null/);
    expect(focusSource).not.toMatch(/\.term\.focus\(|sendToThread/);
  });

  it('transfers the focused class from the active canvas leaf', () => {
    const source = extractFunctionSource('renderPaneWorkspace');
    expect(source).toMatch(
      /var focused = leaf\.id === layout\.focusedLeafId;[\s\S]*surface\.pane\.classList\.toggle\("focused", focused\)/,
    );
    expect(source).toMatch(/surface\.pane\.setAttribute\("aria-current", focused \? "true" : "false"\)/);
    expect(source).not.toMatch(
      /thread\.pane\.classList\.toggle\("focused",\s*thread\.id\s*===\s*state\.activeThreadId\)/,
    );
  });

  it('focuses Files as a canvas leaf without focusing terminal input', () => {
    const state = { activeProjectId: 'project-a', activeThreadId: 'thread-a' as string | null };
    const layout = { root: {}, focusedLeafId: 'terminal-leaf' };
    const toggles: Record<string, boolean> = {};
    const surfaces = {
      'thread-a': {
        id: 'thread-a', pane: {
          classList: { toggle: (_name: string, on: boolean) => { toggles.terminal = on; } },
          setAttribute: () => undefined,
        },
      },
      'files-a': {
        id: 'files-a', kind: 'files', projectId: 'project-a', workspaceRoot: '/worktree',
        pane: {
          classList: { toggle: (_name: string, on: boolean) => { toggles.files = on; } },
          setAttribute: () => undefined,
        },
      },
    };
    let terminalFocuses = 0;
    const focusCanvasSurface = compileFunction<(surface: typeof surfaces['files-a']) => boolean>(
      extractFunctionSource('focusCanvasSurface'),
      {
        focusThread: () => { terminalFocuses += 1; },
        findProject: () => ({ id: 'project-a', selectedWorktreePath: '' }),
        assignSelectedWorktreePath: (
          project: { selectedWorktreePath: string },
          worktreePath: string,
        ) => {
          project.selectedWorktreePath = worktreePath;
          return true;
        },
        state,
        paneLayoutFor: () => layout,
        PsychePanes: {
          findLeafByThreadId: () => ({ id: 'files-leaf', threadId: 'files-a' }),
          leafIds: () => ['terminal-leaf', 'files-leaf'],
          findLeafById: (_root: unknown, id: string) => id === 'files-leaf'
            ? { id, threadId: 'files-a' }
            : { id, threadId: 'thread-a' },
        },
        canvasSurfaceById: (id: keyof typeof surfaces) => surfaces[id],
        refreshSidebar: () => undefined,
      },
    );

    expect(focusCanvasSurface(surfaces['files-a'])).toBe(true);
    expect(layout.focusedLeafId).toBe('files-leaf');
    expect(state.activeThreadId).toBeNull();
    expect(toggles).toEqual({ terminal: false, files: true });
    expect(terminalFocuses).toBe(0);
  });

  it('distinguishes an open file from Files owning canvas focus', () => {
    const filesPane = {
      id: 'files-a', kind: 'files', projectId: 'project-a', workspaceRoot: '/worktree-a',
    };
    const terminalPane = { id: 'thread-a', kind: 'shell' };
    const layout = { root: {}, focusedLeafId: 'terminal-leaf' };
    const filesPaneHasCanvasFocus = compileFunction<(pane: typeof filesPane) => boolean>(
      extractFunctionSource('filesPaneHasCanvasFocus'),
      {
        state: { activeProjectId: 'project-a' },
        findProject: () => ({ id: 'project-a' }),
        activeWorkspaceRoot: () => '/worktree-a',
        paneLayoutForThread: () => layout,
        PsychePanes: {
          findLeafById: () => ({ id: layout.focusedLeafId, threadId: 'thread-a' }),
        },
        canvasSurfaceById: (id: string) => id === filesPane.id ? filesPane : terminalPane,
      },
    );

    expect(filesPaneHasCanvasFocus(filesPane)).toBe(false);
    layout.focusedLeafId = 'files-leaf';
    Object.assign(layout.root, { focusedSurfaceId: filesPane.id });
    const focusedPredicate = compileFunction<(pane: typeof filesPane) => boolean>(
      extractFunctionSource('filesPaneHasCanvasFocus'),
      {
        state: { activeProjectId: 'project-a' },
        findProject: () => ({ id: 'project-a' }),
        activeWorkspaceRoot: () => '/worktree-a',
        paneLayoutForThread: () => layout,
        PsychePanes: {
          findLeafById: () => ({ id: layout.focusedLeafId, threadId: 'files-a' }),
        },
        canvasSurfaceById: (id: string) => id === filesPane.id ? filesPane : terminalPane,
      },
    );
    expect(focusedPredicate(filesPane)).toBe(true);
  });

  it('rejects a focused Files layout from another project or worktree', () => {
    const filesPane = {
      id: 'files-a', kind: 'files', projectId: 'project-a', workspaceRoot: '/worktree-a',
    };
    const activeProject = { id: 'project-b', root: '/repo-b', selectedWorktreePath: '/worktree-b' };
    const state = { activeFileId: 'file-a', activeProjectId: activeProject.id };
    const filesPaneHasCanvasFocus = compileFunction<() => boolean>(
      extractFunctionSource('filesPaneHasCanvasFocus'),
      {
        state,
        findOpenFile: () => ({
          id: 'file-a', projectId: filesPane.projectId, workspaceRoot: filesPane.workspaceRoot,
        }),
        filesPanes: new Map([['pane-key', filesPane]]),
        filesPaneKey: () => 'pane-key',
        findProject: (id: string) => id === activeProject.id ? activeProject : null,
        activeWorkspaceRoot: () => activeProject.selectedWorktreePath,
        paneLayoutForThread: () => ({ root: {}, focusedLeafId: 'files-leaf' }),
        PsychePanes: { findLeafById: () => ({ id: 'files-leaf', threadId: filesPane.id }) },
        canvasSurfaceById: () => filesPane,
      },
    );

    expect(filesPaneHasCanvasFocus()).toBe(false);
    activeProject.id = 'project-a';
    state.activeProjectId = activeProject.id;
    expect(filesPaneHasCanvasFocus()).toBe(false);
  });

  it('renders tab controls and sibling file-specific close controls with one roving tab stop', () => {
    expect(extractFunctionSource('refreshTabs')).toContain('file-tab-item');
    const tabStrip = new FakeElement();
    const files = [
      { id: 'file-a', rel: 'a.ts', name: 'a.ts', dirty: false },
      { id: 'file-b', rel: 'b.ts', name: 'b.ts', dirty: true },
    ];
    const refreshTabs = compileFunction<() => void>(extractFunctionSource('refreshTabs'), {
      editingContext: null,
      tabStripEl: tabStrip,
      projectFiles: () => files,
      state: { activeFileId: 'file-b' },
      document: {
        createElement: (tagName: string) => Object.assign(new FakeElement(), { tagName }),
      },
      escapeHtml: (value: string) => value,
      activateFileTab: async () => true,
      closeFileTab: async () => true,
      scheduleTabMeasurements: () => undefined,
    });

    refreshTabs();
    expect(tabStrip.children).toHaveLength(2);
    for (const [index, item] of tabStrip.children.entries()) {
      const tab = item.children.find((child) => child.attributes.get('role') === 'tab');
      const close = item.children.find((child) => child.className === 'close');
      expect(item.className).toContain('file-tab-item');
      expect(tab?.tagName).toBe('button');
      expect(tab?.tabIndex).toBe(index === 1 ? 0 : -1);
      expect(tab?.attributes.get('aria-selected')).toBe(index === 1 ? 'true' : 'false');
      expect(tab?.listeners.has('keydown')).toBe(true);
      expect(close?.tagName).toBe('button');
      expect(close?.parentElement).toBe(item);
      expect(close?.parentElement).not.toBe(tab);
      expect(close?.tabIndex).toBe(-1);
      expect(close?.attributes.get('aria-label')).toBe(`Close ${files[index].name}`);
      expect(item.listeners.has('auxclick')).toBe(true);
    }
  });

  it('activates and focuses file tabs with ArrowLeft, ArrowRight, Home, and End', async () => {
    expect(mainJs).toContain('function handleFileTabKeydown');
    const activations: string[] = [];
    const focused: string[] = [];
    const files = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const handleFileTabKeydown = compileFunction<
      (event: { key: string; preventDefault(): void }, fileId: string) => Promise<boolean>
    >(extractFunctionSource('handleFileTabKeydown'), {
      projectFiles: () => files,
      activateFileTab: async (id: string) => { activations.push(id); return true; },
      focusFileTabControl: (id: string) => { focused.push(id); return true; },
    });

    for (const [key, from, expected] of [
      ['ArrowLeft', 'a', 'c'],
      ['ArrowRight', 'c', 'a'],
      ['Home', 'b', 'a'],
      ['End', 'b', 'c'],
    ]) {
      let prevented = false;
      await expect(handleFileTabKeydown({
        key,
        preventDefault: () => { prevented = true; },
      }, from)).resolves.toBe(true);
      expect(prevented).toBe(true);
      expect(activations.at(-1)).toBe(expected);
      expect(focused.at(-1)).toBe(expected);
    }
  });

  it('connects the active Files frame and header glow without a CodeMirror outline', () => {
    expect(stylesCss).toMatch(
      /\.terminal-pane\.is-files\.focused\s*\{[^}]*border-color:[^}]*box-shadow:[^}]*rgba\(var\(--rgb-accent\)/s,
    );
    expect(stylesCss).toMatch(
      /\.terminal-pane\.is-files\.focused[^\{]*\.terminal-pane-header\s*\{[^}]*background:/s,
    );
    expect(stylesCss).toMatch(
      /\.file-editor-host \.cm-editor\.cm-focused\s*\{[^}]*outline:\s*none[^}]*box-shadow:\s*none/s,
    );
  });

  it('lets the mounted file view fill its pane body without old overlay placement', () => {
    expect(stylesCss).toMatch(/\.terminal-pane\.is-files\s*\{[^}]*grid-template-rows:/s);
    expect(stylesCss).toMatch(/\.files-pane-body\s*\{[^}]*min-width:\s*0[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    expect(stylesCss).toMatch(/\.files-pane-body > \.file-view\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/s);
    expect(stylesCss).not.toMatch(/\.file-view\s*\{\s*grid-row:/);
    expect(stylesCss).not.toContain('.terminal-area.is-file-focused .file-view');
    expect(mainJs).not.toContain('is-file-focused');
  });
});
