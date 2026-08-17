import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const root = process.cwd();
const mainJs = readFileSync(join(root, 'native/desktop/psyche-build-tauri/web/main.js'), 'utf8');
const styles = readFileSync(join(root, 'native/desktop/psyche-build-tauri/web/styles.css'), 'utf8');

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
  name: string,
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(
    ...names,
    `"use strict"; return (${functionSource(name)});`,
  )(...values) as T;
}

function between(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  if (startIndex === -1) throw new Error(`missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex);
  if (endIndex === -1) throw new Error(`missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function ruleBlock(selector: string) {
  const match = styles.match(
    new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 's'),
  );
  return match?.[2] ?? '';
}

type Listener = (event: FakeEvent) => unknown;

class FakeStyle {
  private readonly properties = new Map<string, string>();

  setProperty(name: string, value: string) {
    this.properties.set(name, value);
  }

  getPropertyValue(name: string) {
    return this.properties.get(name) ?? '';
  }
}

class FakeEvent {
  propagationStopped = false;
  defaultPrevented = false;

  constructor(readonly target: FakeElement) {}

  stopPropagation() {
    this.propagationStopped = true;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeDocument {
  private readonly elementsById = new Map<string, FakeElement>();

  createElement(tagName: string) {
    return new FakeElement(tagName);
  }

  registerElement(id: string, element: FakeElement) {
    element.setAttribute('id', id);
    this.elementsById.set(id, element);
    return element;
  }

  getElementById(id: string) {
    return this.elementsById.get(id) ?? null;
  }
}

class FakeElement {
  readonly tagName: string;
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly style = new FakeStyle();
  parentNode: FakeElement | null = null;
  className = '';
  textContent = '';
  title = '';
  type = '';
  focused = false;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(child: FakeElement) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(name: string, listener: Listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  async emit(name: string) {
    const event = new FakeEvent(this);
    for (let element: FakeElement | null = this; element; element = element.parentNode) {
      for (const listener of element.listeners.get(name) ?? []) {
        await listener(event);
      }
      if (event.propagationStopped) break;
    }
    return event;
  }

  focus() {
    this.focused = true;
  }
}

function compileShowProjectFilesHarness(
  dependencies: {
    findProject: (projectId: string) => { id: string } | null;
    setActiveProject: (projectId: string) => Promise<boolean>;
    state: { activeProjectId: string };
    setSidebarView: (view: string) => void;
    sidebarFilesReturnProjectId: string | null;
  },
) {
  return Function(
    'findProject',
    'setActiveProject',
    'state',
    'setSidebarView',
    'seedSidebarFilesReturnProjectId',
    `"use strict";
    var sidebarFilesReturnProjectId = seedSidebarFilesReturnProjectId;
    ${functionSource('showProjectFiles')}
    return {
      showProjectFiles: showProjectFiles,
      returnProjectId: function () { return sidebarFilesReturnProjectId; },
    };`,
  )(
    dependencies.findProject,
    dependencies.setActiveProject,
    dependencies.state,
    dependencies.setSidebarView,
    dependencies.sidebarFilesReturnProjectId,
  ) as {
    showProjectFiles: (projectId: string) => Promise<boolean>;
    returnProjectId: () => string | null;
  };
}

function bindProjectGroupInteractions(dependencies: {
  project: { id: string; collapsed?: boolean };
  projectModel: { expanded: boolean; autoExpanded: boolean };
  projectParts: {
    group: FakeElement;
    head: FakeElement;
    disclosure: FakeElement;
    files: FakeElement;
  };
  refreshSidebar: () => void;
  saveWorkspaceSoon: () => void;
  clearFocusSet: () => void;
  setActiveProject: (projectId: string) => unknown;
  showProjectFiles: (projectId: string) => unknown;
}) {
  const projectListeners = between(
    functionSource('renderSessionList'),
    'function setProjectExpanded(expanded) {',
    'projectParts.head.addEventListener("contextmenu"',
  );
  return Function(
    'project',
    'projectModel',
    'projectParts',
    'refreshSidebar',
    'saveWorkspaceSoon',
    'clearFocusSet',
    'setActiveProject',
    'showProjectFiles',
    'targetWithin',
    `"use strict";
    ${projectListeners}`,
  )(
    dependencies.project,
    dependencies.projectModel,
    dependencies.projectParts,
    dependencies.refreshSidebar,
    dependencies.saveWorkspaceSoon,
    dependencies.clearFocusSet,
    dependencies.setActiveProject,
    dependencies.showProjectFiles,
    (event: FakeEvent, element: FakeElement) => {
      for (let node: FakeElement | null = event.target; node; node = node.parentNode) {
        if (node === element) return true;
      }
      return false;
    },
  );
}

function registerFilesBackRailClick(document: FakeDocument, showSessionsSidebar: () => unknown) {
  const filesBackRegistration = between(
    mainJs,
    'onRailClick("files-back"',
    'onRailClick("files-refresh"',
  );
  return Function(
    'document',
    'showSessionsSidebar',
    `"use strict";
    ${functionSource('onRailClick')}
    ${filesBackRegistration}`,
  )(
    document,
    showSessionsSidebar,
  );
}

describe('project Files sidebar navigation', () => {
  it('activates the project before switching to Files and keeps the selected worktree intact', async () => {
    const project = {
      id: 'project-1',
      selectedWorktreePath: '/repo/worktrees/feature',
    };
    const state = { activeProjectId: '' };
    const setSidebarView = vi.fn();
    let continueActivation: () => void = () => {
      throw new Error('expected pending project activation');
    };
    const setActiveProject = vi.fn(() => new Promise<boolean>((resolve) => {
      continueActivation = () => {
        state.activeProjectId = project.id;
        resolve(true);
      };
    }));

    const sidebar = compileShowProjectFilesHarness({
      findProject: (projectId: string) => (projectId === project.id ? project : null),
      setActiveProject,
      state,
      setSidebarView,
      sidebarFilesReturnProjectId: null,
    });

    const pending = sidebar.showProjectFiles(project.id);
    expect(setActiveProject).toHaveBeenCalledWith(project.id);
    expect(setSidebarView).not.toHaveBeenCalled();
    expect(sidebar.returnProjectId()).toBeNull();
    expect(project.selectedWorktreePath).toBe('/repo/worktrees/feature');

    continueActivation();

    await expect(pending).resolves.toBe(true);
    expect(setSidebarView).toHaveBeenCalledOnce();
    expect(setSidebarView).toHaveBeenCalledWith('files');
    expect(sidebar.returnProjectId()).toBe(project.id);
    expect(project.selectedWorktreePath).toBe('/repo/worktrees/feature');
  });

  it('returns false when project activation fails and never switches the sidebar view', async () => {
    const setSidebarView = vi.fn();
    const sidebar = compileShowProjectFilesHarness({
      findProject: () => ({ id: 'project-1', selectedWorktreePath: '/repo' }),
      setActiveProject: vi.fn().mockResolvedValue(false),
      state: { activeProjectId: '' },
      setSidebarView,
      sidebarFilesReturnProjectId: 'return-project',
    });

    await expect(sidebar.showProjectFiles('project-1')).resolves.toBe(false);
    expect(setSidebarView).not.toHaveBeenCalled();
    expect(sidebar.returnProjectId()).toBe('return-project');
  });

  it('returns false without touching sidebar navigation state when the project is missing', async () => {
    const setActiveProject = vi.fn().mockResolvedValue(true);
    const setSidebarView = vi.fn();
    const sidebar = compileShowProjectFilesHarness({
      findProject: () => null,
      setActiveProject,
      state: { activeProjectId: 'project-0' },
      setSidebarView,
      sidebarFilesReturnProjectId: 'return-project',
    });

    await expect(sidebar.showProjectFiles('missing-project')).resolves.toBe(false);
    expect(setActiveProject).not.toHaveBeenCalled();
    expect(setSidebarView).not.toHaveBeenCalled();
    expect(sidebar.returnProjectId()).toBe('return-project');
  });

  it('creates a Files button for every project group with the project-scoped label', () => {
    const createProjectGroup = compileFunction<
      (projectModel: Record<string, unknown>, options: Record<string, unknown>) => {
        head: FakeElement;
        files?: FakeElement;
      }
    >('createProjectGroup', {
      document: {
        createElement: (tagName: string) => new FakeElement(tagName),
      },
      PsycheSessions: {
        resolveProjectAppearance: () => ({
          accent: { id: 'violet', rgb: '120 90 200' },
          customized: false,
          glyph: null,
        }),
      },
      projectAppearances: {},
      createDisclosure: () => new FakeElement('button'),
      appendHighlightedText: (element: FakeElement, value: string) => {
        element.textContent = value;
      },
      attachTooltip: () => undefined,
    });

    const projectGroup = createProjectGroup({
      key: 'project:1',
      title: 'Potion Lab',
      titleMatches: [],
      expanded: true,
      autoExpanded: false,
      count: 0,
      attentionCount: 0,
      project: {
        id: 'project-1',
        root: '/repo/potion-lab',
      },
    }, {
      current: false,
      tabindex: '-1',
    });

    expect(projectGroup.files).toBeDefined();
    expect(projectGroup.files?.type).toBe('button');
    expect(projectGroup.files?.className).toBe('session-project-files');
    expect(projectGroup.files?.dataset.projectFiles).toBe('project-1');
    expect(projectGroup.files?.textContent).toBe('Files');
    expect(projectGroup.files?.getAttribute('aria-label')).toBe(
      'Browse files in Potion Lab',
    );
    expect(projectGroup.head.children.at(-1)).toBe(projectGroup.files);
  });

  it('dispatches project Files button events without selecting or toggling the project group', async () => {
    const document = new FakeDocument();
    const project = {
      id: 'project-1',
      root: '/repo/potion-lab',
      collapsed: false,
    };
    type ProjectGroupModel = {
      key: string;
      title: string;
      titleMatches: string[];
      expanded: boolean;
      autoExpanded: boolean;
      count: number;
      attentionCount: number;
      project: typeof project;
    };
    const projectModel: ProjectGroupModel = {
      key: 'project:1',
      title: 'Potion Lab',
      titleMatches: [],
      expanded: true,
      autoExpanded: false,
      count: 0,
      attentionCount: 0,
      project,
    };
    const createProjectGroup = compileFunction<
      (projectModel: ProjectGroupModel, options: Record<string, unknown>) => {
        group: FakeElement;
        head: FakeElement;
        disclosure: FakeElement;
        files: FakeElement;
      }
    >('createProjectGroup', {
      document,
      PsycheSessions: {
        resolveProjectAppearance: () => ({
          accent: { id: 'violet', rgb: '120 90 200' },
          customized: false,
          glyph: null,
        }),
      },
      projectAppearances: {},
      createDisclosure: () => new FakeElement('button'),
      appendHighlightedText: (element: FakeElement, value: string) => {
        element.textContent = value;
      },
      attachTooltip: () => undefined,
    });
    const projectParts = createProjectGroup(projectModel, {
      current: false,
      tabindex: '-1',
    });
    const clearFocusSet = vi.fn();
    const setActiveProject = vi.fn();
    const refreshSidebar = vi.fn();
    const saveWorkspaceSoon = vi.fn();
    const showProjectFiles = vi.fn().mockResolvedValue(true);

    bindProjectGroupInteractions({
      project,
      projectModel,
      projectParts,
      refreshSidebar,
      saveWorkspaceSoon,
      clearFocusSet,
      setActiveProject,
      showProjectFiles,
    });

    const pointerdown = await projectParts.files.emit('pointerdown');
    expect(pointerdown.propagationStopped).toBe(true);
    expect(pointerdown.defaultPrevented).toBe(false);
    expect(showProjectFiles).not.toHaveBeenCalled();

    const click = await projectParts.files.emit('click');
    expect(click.defaultPrevented).toBe(true);
    expect(click.propagationStopped).toBe(true);
    expect(showProjectFiles).toHaveBeenCalledOnce();
    expect(showProjectFiles).toHaveBeenCalledWith(project.id);
    expect(clearFocusSet).not.toHaveBeenCalled();
    expect(setActiveProject).not.toHaveBeenCalled();
    expect(refreshSidebar).not.toHaveBeenCalled();
    expect(saveWorkspaceSoon).not.toHaveBeenCalled();
    expect(functionSource('renderSessionList')).not.toContain('if (projectModel.visibleCount === 0) return;');
  });

  it('restores focus to the originating project Files button when returning to Sessions', () => {
    let rafCallback: () => void = () => {
      throw new Error('expected requestAnimationFrame callback');
    };
    const focus = vi.fn();
    const showSessionsSidebar = compileFunction<() => boolean>('showSessionsSidebar', {
      sidebarFilesReturnProjectId: 'project-1',
      setSidebarView: vi.fn(),
      renderSessionList: vi.fn(),
      requestAnimationFrame: (callback: () => void) => {
        rafCallback = callback;
        return 1;
      },
      sessionListEl: {
        querySelectorAll: () => [
          { dataset: { projectFiles: 'project-2' }, focus: vi.fn() },
          { dataset: { projectFiles: 'project-1' }, focus },
        ],
      },
      restoreSessionTreeFocus: vi.fn(),
    });

    expect(showSessionsSidebar()).toBe(true);
    rafCallback();
    expect(focus).toHaveBeenCalledOnce();
  });

  it('falls back to tree focus restoration when the originating Files button is missing', () => {
    let rafCallback: () => void = () => {
      throw new Error('expected requestAnimationFrame callback');
    };
    const restoreSessionTreeFocus = vi.fn();
    const setSidebarView = vi.fn();
    const renderSessionList = vi.fn();
    const showSessionsSidebar = compileFunction<() => boolean>('showSessionsSidebar', {
      sidebarFilesReturnProjectId: 'missing-project',
      setSidebarView,
      renderSessionList,
      requestAnimationFrame: (callback: () => void) => {
        rafCallback = callback;
        return 1;
      },
      sessionListEl: {
        querySelectorAll: () => [{ dataset: { projectFiles: 'project-2' }, focus: vi.fn() }],
      },
      restoreSessionTreeFocus,
    });

    expect(showSessionsSidebar()).toBe(true);
    expect(setSidebarView).toHaveBeenCalledWith('sessions');
    expect(renderSessionList).toHaveBeenCalledWith({ preserveFocus: false });
    expect(functionSource('showSessionsSidebar')).toContain('sidebarFilesReturnProjectId = null;');
    rafCallback();
    expect(restoreSessionTreeFocus).toHaveBeenCalledWith('');
  });

  it('routes files-back rail clicks through the registered listener to showSessionsSidebar', async () => {
    const document = new FakeDocument();
    const filesBack = document.registerElement('files-back', new FakeElement('button'));
    const showSessionsSidebar = vi.fn();

    registerFilesBackRailClick(document, showSessionsSidebar);

    await filesBack.emit('click');
    expect(showSessionsSidebar).toHaveBeenCalledOnce();
  });

  it('styles the project Files button as a compact surface control', () => {
    const baseRule = ruleBlock('.session-project-files');
    const hoverRule = ruleBlock('.session-project-files:hover');
    const focusRule = ruleBlock('.session-project-files:focus-visible');

    expect(baseRule).toMatch(/flex:\s*none;/);
    expect(baseRule).toMatch(/padding:\s*3px 6px;/);
    expect(baseRule).toMatch(/border:\s*1px solid var\(--border\);/);
    expect(baseRule).toMatch(/border-radius:\s*6px;/);
    expect(baseRule).toMatch(/background:\s*var\(--surface-2\);/);
    expect(baseRule).toMatch(/color:\s*var\(--text-soft\);/);
    expect(baseRule).toMatch(/font-size:\s*10px;/);
    expect(baseRule).toMatch(/font-weight:\s*600;/);
    expect(baseRule).toMatch(/letter-spacing:\s*normal;/);
    expect(baseRule).toMatch(/text-transform:\s*none;/);
    expect(hoverRule).toMatch(/background:\s*var\(--surface-3\);/);
    expect(hoverRule).toMatch(/color:\s*var\(--text\);/);
    expect(focusRule).toMatch(/outline:\s*none;/);
  });
});
