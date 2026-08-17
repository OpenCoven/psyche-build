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
  activeElement: FakeElement | null;
  readonly body: FakeElement;

  constructor() {
    this.body = new FakeElement('body', this);
    this.activeElement = this.body;
  }

  createElement(tagName: string) {
    return new FakeElement(tagName, this);
  }

  registerElement(id: string, element: FakeElement) {
    element.attachDocument(this);
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
  ownerDocument: FakeDocument | null = null;
  parentNode: FakeElement | null = null;
  className = '';
  textContent = '';
  title = '';
  type = '';
  focused = false;
  hidden = false;

  constructor(tagName: string, ownerDocument: FakeDocument | null = null) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get classList() {
    return {
      contains: (name: string) => this.className.split(/\s+/).includes(name),
    };
  }

  attachDocument(document: FakeDocument) {
    this.ownerDocument = document;
    this.children.forEach((child) => child.attachDocument(document));
  }

  appendChild(child: FakeElement) {
    child.parentNode = this;
    if (this.ownerDocument) child.attachDocument(this.ownerDocument);
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]) {
    this.releaseFocusedDescendant();
    this.children.forEach((child) => {
      child.parentNode = null;
    });
    this.children.splice(0, this.children.length);
    children.forEach((child) => this.appendChild(child));
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  contains(candidate: FakeElement | null): boolean {
    if (!candidate) return false;
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
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
    const activeElement = this.ownerDocument?.activeElement;
    if (activeElement) activeElement.focused = false;
    this.focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const visit = (element: FakeElement) => {
      const matchesSelector = selector === '[data-tree-item]'
        ? Boolean(element.dataset.treeItem)
        : selector === '[data-project-files]'
          ? Boolean(element.dataset.projectFiles)
          : selector === 'button'
            ? element.tagName === 'BUTTON'
            : selector.startsWith('.')
              ? element.classList.contains(selector.slice(1))
              : false;
      if (matchesSelector) matches.push(element);
      element.children.forEach(visit);
    };
    this.children.forEach(visit);
    return matches;
  }

  private releaseFocusedDescendant() {
    const activeElement = this.ownerDocument?.activeElement ?? null;
    if (!activeElement || !this.contains(activeElement)) return;
    activeElement.focused = false;
    if (this.ownerDocument) this.ownerDocument.activeElement = this.ownerDocument.body;
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
    var sidebarView = "sessions";
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

function compileFilesNavigationRenderHarness(initial: {
  activeProjectId: string;
  sidebarView: string;
  projects: FilesPanelProject[];
  activationResults?: Record<string, boolean>;
  document?: FakeDocument;
  sidebarSessionControlsEl?: { hidden: boolean } | null;
  sessionListEl?: { hidden: boolean } | null;
  sidebarFilesEl?: { hidden: boolean } | null;
  requestAnimationFrame?: (callback: () => void) => number;
}) {
  return Function(
    'seedActiveProjectId',
    'seedSidebarView',
    'projects',
    'activationResults',
    'document',
    'seedSidebarSessionControlsEl',
    'seedSessionListEl',
    'seedSidebarFilesEl',
    'requestAnimationFrame',
    `"use strict";
    var state = { activeProjectId: seedActiveProjectId };
    var sidebarView = seedSidebarView;
    var sidebarFilesReturnProjectId = null;
    var sidebarSessionControlsEl = seedSidebarSessionControlsEl;
    var sessionListEl = seedSessionListEl;
    var sidebarFilesEl = seedSidebarFilesEl;
    var syncCount = 0;
    function findProject(id) {
      return projects.find(function (project) { return project.id === id; }) || null;
    }
    function syncFilesPanelScope() {
      syncCount += 1;
      return true;
    }
    function closeNewPaneMenu() {}
    async function setActiveProject(id) {
      if (activationResults &&
          Object.prototype.hasOwnProperty.call(activationResults, id) &&
          !activationResults[id]) {
        return false;
      }
      if (state.activeProjectId === id) return true;
      state.activeProjectId = id;
      syncFilesPanelScope();
      return true;
    }
    ${functionSource('setSidebarView')}
    ${functionSource('showProjectFiles')}
    return {
      showProjectFiles: showProjectFiles,
      getSyncCount: function () { return syncCount; },
    };`,
  )(
    initial.activeProjectId,
    initial.sidebarView,
    initial.projects,
    initial.activationResults ?? null,
    initial.document ?? new FakeDocument(),
    initial.sidebarSessionControlsEl ?? null,
    initial.sessionListEl ?? null,
    initial.sidebarFilesEl ?? null,
    initial.requestAnimationFrame ?? ((callback: () => void) => {
      callback();
      return 1;
    }),
  ) as {
    showProjectFiles: (projectId: string) => Promise<boolean>;
    getSyncCount: () => number;
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

function registerSessionListScrollHandler(dependencies: {
  sessionListEl: FakeElement;
  ptyRuntime?: unknown;
  syncSessionListScroll: () => void;
  document: FakeDocument;
  terminalFrameScheduler: {
    schedule: (key: string, callback: () => void) => unknown;
  };
  renderSessionList: (options?: Record<string, unknown>) => void;
}) {
  const scrollRegistration = between(
    mainJs,
    'if (sessionListEl) {\n    sessionListEl.__psycheVirtualRuntime = ptyRuntime;',
    '  var sidebarView = "sessions";',
  );
  return Function(
    'sessionListEl',
    'ptyRuntime',
    'syncSessionListScroll',
    'document',
    'terminalFrameScheduler',
    'renderSessionList',
    `"use strict";
    ${scrollRegistration}
    return sessionListEl;`,
  )(
    dependencies.sessionListEl,
    dependencies.ptyRuntime,
    dependencies.syncSessionListScroll,
    dependencies.document,
    dependencies.terminalFrameScheduler,
    dependencies.renderSessionList,
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

type FilesPanelProject = {
  id: string;
  root: string;
  selectedWorktreePath?: string;
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function compileFilesPanelRequestHarness(initial: {
  activeProject: FilesPanelProject | null;
  sidebarView?: string;
  filesPanelGeneration?: number;
  activeWorkspaceRoot?: (project: FilesPanelProject) => string;
}) {
  return Function(
    'seedActiveProject',
    'activeWorkspaceRoot',
    'seedSidebarView',
    'seedFilesPanelGeneration',
    `"use strict";
    var currentProject = seedActiveProject;
    var sidebarView = seedSidebarView;
    var filesPanelGeneration = seedFilesPanelGeneration;
    function activeProject() {
      return currentProject;
    }
    ${functionSource('filesPanelRequestMatches')}
    return {
      filesPanelRequestMatches: filesPanelRequestMatches,
      setActiveProject: function (project) { currentProject = project; },
      setSidebarView: function (view) { sidebarView = view; },
      setFilesPanelGeneration: function (generation) { filesPanelGeneration = generation; },
    };`,
  )(
    initial.activeProject,
    initial.activeWorkspaceRoot ?? ((project: FilesPanelProject) => project.selectedWorktreePath || project.root),
    initial.sidebarView ?? 'files',
    initial.filesPanelGeneration ?? 0,
  ) as {
    filesPanelRequestMatches: (generation: number, projectId: string, workspaceRoot: string) => boolean;
    setActiveProject: (project: FilesPanelProject | null) => void;
    setSidebarView: (view: string) => void;
    setFilesPanelGeneration: (generation: number) => void;
  };
}

function compileRenderFilesPanelHarness(dependencies: {
  activeProject: FilesPanelProject | null;
  appendDirInto: (
    fileRows: Array<Record<string, unknown>>,
    root: string,
    dirPath: string,
    depth: number,
  ) => Promise<void>;
  fileTreeEl?: { firstChild: unknown } | null;
  filesCrumbEl?: { textContent: string };
  sidebarView?: string;
  filesPanelGeneration?: number;
  sidebarFilesReturnProjectId?: string | null;
  activeWorkspaceRoot?: (project: FilesPanelProject) => string;
  panelMessage?: (el: { firstChild: unknown }, text: string, cls?: string) => unknown;
  shortenRoot?: (workspaceRoot: string) => string;
  renderFileRows?: (fileRows: Array<Record<string, unknown>>) => unknown;
  renderSessionList?: (options: Record<string, unknown>) => unknown;
  restoreSessionTreeFocus?: (key: string) => boolean;
  document?: { getElementById: (id: string) => { focus?: () => void } | null };
  requestAnimationFrame?: (callback: () => void) => number;
}) {
  return Function(
    'seedFileTreeEl',
    'seedFilesCrumbEl',
    'seedSidebarView',
    'seedFilesPanelGeneration',
    'seedSidebarFilesReturnProjectId',
    'seedActiveProject',
    'panelMessage',
    'activeWorkspaceRoot',
    'shortenRoot',
    'appendDirInto',
    'renderFileRows',
    'renderSessionList',
    'restoreSessionTreeFocus',
    'document',
    'requestAnimationFrame',
    `"use strict";
    var fileTreeEl = seedFileTreeEl;
    var filesCrumbEl = seedFilesCrumbEl;
    var sidebarView = seedSidebarView;
    var filesPanelGeneration = seedFilesPanelGeneration;
    var sidebarFilesReturnProjectId = seedSidebarFilesReturnProjectId;
    var renderedFileRows = [];
    var fileVirtualFocusKey = "";
    var sessionListEl = null;
    var currentProject = seedActiveProject;
    function activeProject() {
      return currentProject;
    }
    function setSidebarView(name) {
      sidebarView = name === "files" ? "files" : "sessions";
      return sidebarView;
    }
    function invalidateFilesPanelRender() {
      filesPanelGeneration += 1;
      return filesPanelGeneration;
    }
    function filesPanelRequestMatches(generation, projectId, workspaceRoot) {
      var project = activeProject();
      return sidebarView === "files" &&
        generation === filesPanelGeneration &&
        !!project && project.id === projectId &&
        activeWorkspaceRoot(project) === workspaceRoot;
    }
    ${functionSource('syncFilesPanelScope')}
    ${functionSource('renderFilesPanel')}
    ${functionSource('showSessionsSidebar')}
    return {
      renderFilesPanel: renderFilesPanel,
      syncFilesPanelScope: syncFilesPanelScope,
      showSessionsSidebar: showSessionsSidebar,
      getRenderedFileRows: function () { return renderedFileRows; },
      getFilesPanelGeneration: function () { return filesPanelGeneration; },
      getSidebarView: function () { return sidebarView; },
      setActiveProject: function (project) { currentProject = project; },
    };`,
  )(
    dependencies.fileTreeEl ?? { firstChild: null },
    dependencies.filesCrumbEl ?? { textContent: '' },
    dependencies.sidebarView ?? 'files',
    dependencies.filesPanelGeneration ?? 0,
    dependencies.sidebarFilesReturnProjectId ?? null,
    dependencies.activeProject,
    dependencies.panelMessage ?? (() => undefined),
    dependencies.activeWorkspaceRoot ?? ((project: FilesPanelProject) => project.selectedWorktreePath || project.root),
    dependencies.shortenRoot ?? ((workspaceRoot: string) => workspaceRoot),
    dependencies.appendDirInto,
    dependencies.renderFileRows ?? (() => undefined),
    dependencies.renderSessionList ?? (() => undefined),
    dependencies.restoreSessionTreeFocus ?? (() => true),
    dependencies.document ?? { getElementById: () => null },
    dependencies.requestAnimationFrame ?? ((callback: () => void) => {
      callback();
      return 1;
    }),
  ) as {
    renderFilesPanel: () => Promise<boolean | void>;
    syncFilesPanelScope: () => Promise<boolean | void> | false;
    showSessionsSidebar: () => boolean;
    getRenderedFileRows: () => Array<Record<string, unknown>>;
    getFilesPanelGeneration: () => number;
    getSidebarView: () => string;
    setActiveProject: (project: FilesPanelProject | null) => void;
  };
}

function compileRenderSessionListFocusHarness(initial: {
  document?: FakeDocument;
  sessionListEl?: FakeElement;
  projects: FilesPanelProject[];
  activeProjectId?: string;
  sessionTreeFocusKey?: string;
}) {
  const documentRef = initial.document ?? new FakeDocument();
  const sessionListRef = initial.sessionListEl ?? new FakeElement('div', documentRef);
  return Function(
    'document',
    'sessionListEl',
    'seedProjects',
    'seedActiveProjectId',
    'seedSessionTreeFocusKey',
    `"use strict";
    var editingContext = null;
    var projectAppearancePopover = null;
    var projectAppearancePopoverRestoreKey = "";
    var armedSessionClose = null;
    var setPicking = null;
    var sessionTypeFilter = "all";
    var sessionTreeFocusKey = seedSessionTreeFocusKey;
    var projectAppearances = {};
    var isRestoringWorkspace = false;
    var state = {
      projects: seedProjects,
      threads: [],
      activeProjectId: seedActiveProjectId,
      activeThreadId: null,
    };
    var settings = { selectedSessionKey: "" };
    var covenDiscovery = { phase: "ready" };
    function closeProjectAppearancePopover() {}
    function syncLocalSidebarStatusKeys() {}
    function disarmSessionClose() {}
    function covenInlineState() { return null; }
    function canvasThreadIds() { return []; }
    function covenSessionAssignments() { return new Map(); }
    function covenSessionsForProject() { return []; }
    function saveSettings() {}
    function findThread() { return null; }
    function refreshSidebar() {}
    function saveWorkspaceSoon() {}
    function clearFocusSet() {}
    function setActiveProject() { return Promise.resolve(true); }
    function showProjectFiles() { return Promise.resolve(true); }
    function openSessionContextMenu() {}
    function activateProjectWorktree() { return Promise.resolve(true); }
    function createProjectGroup(projectModel, options) {
      var group = document.createElement("div");
      group.className = "session-project" + (options.current ? " is-current" : "");
      group.dataset.treeItem = "project";
      group.dataset.treeKey = projectModel.key;
      group.dataset.projectId = projectModel.project.id;
      var head = document.createElement("div");
      head.className = "session-project-head";
      var disclosure = document.createElement("button");
      disclosure.className = "session-disclosure";
      var files = document.createElement("button");
      files.className = "session-project-files";
      files.dataset.projectFiles = projectModel.project.id;
      files.textContent = "Files";
      head.appendChild(disclosure);
      head.appendChild(files);
      var children = document.createElement("div");
      children.className = "session-project-children";
      group.appendChild(head);
      return {
        group: group,
        head: head,
        disclosure: disclosure,
        files: files,
        children: children,
      };
    }
    var PsycheSessions = {
      buildSidebarProjectModel: function (options) {
        return {
          key: "project:" + options.project.id,
          title: options.project.id,
          titleMatches: [],
          expanded: false,
          autoExpanded: false,
          count: 0,
          attentionCount: 0,
          visibleCount: 1,
          branches: [],
          project: options.project,
        };
      },
      resolveProjectAppearance: function () {
        return {
          accent: { id: "violet", rgb: "120 90 200" },
          customized: false,
          glyph: null,
        };
      },
    };
    ${functionSource('renderSessionList')}
    return {
      renderSessionList: renderSessionList,
      projectFilesButtons: function () {
        return sessionListEl.querySelectorAll("[data-project-files]");
      },
      treeItems: function () {
        return sessionListEl.querySelectorAll("[data-tree-item]");
      },
      sessionTreeFocusKey: function () {
        return sessionTreeFocusKey;
      },
    };`,
  )(
    documentRef,
    sessionListRef,
    initial.projects,
    initial.activeProjectId ?? '',
    initial.sessionTreeFocusKey ?? '',
  ) as {
    renderSessionList: (options?: Record<string, unknown>) => void;
    projectFilesButtons: () => FakeElement[];
    treeItems: () => FakeElement[];
    sessionTreeFocusKey: () => string;
  };
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

  it('moves keyboard/click project Files focus to files-back after activation', async () => {
    const document = new FakeDocument();
    const sidebarSessionControlsEl = document.createElement('div');
    const sessionListEl = document.createElement('div');
    const sidebarFilesEl = document.createElement('div');
    sidebarFilesEl.hidden = true;
    const filesBack = document.registerElement('files-back', document.createElement('button'));
    sidebarFilesEl.appendChild(filesBack);
    const origin = document.createElement('button');
    origin.dataset.projectFiles = 'project-1';
    sessionListEl.appendChild(origin);
    origin.focus();

    const navigation = compileFilesNavigationRenderHarness({
      activeProjectId: '',
      sidebarView: 'sessions',
      projects: [{ id: 'project-1', root: '/repo/one' }],
      document,
      sidebarSessionControlsEl,
      sessionListEl,
      sidebarFilesEl,
    });

    await expect(navigation.showProjectFiles('project-1')).resolves.toBe(true);
    expect(sidebarSessionControlsEl.hidden).toBe(true);
    expect(sessionListEl.hidden).toBe(true);
    expect(sidebarFilesEl.hidden).toBe(false);
    expect(document.activeElement).toBe(filesBack);
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

  it('does not steal focus when project Files activation fails', async () => {
    const document = new FakeDocument();
    const sidebarSessionControlsEl = document.createElement('div');
    const sessionListEl = document.createElement('div');
    const sidebarFilesEl = document.createElement('div');
    sidebarFilesEl.hidden = true;
    const filesBack = document.registerElement('files-back', document.createElement('button'));
    sidebarFilesEl.appendChild(filesBack);
    const origin = document.createElement('button');
    origin.dataset.projectFiles = 'project-1';
    sessionListEl.appendChild(origin);
    origin.focus();

    const navigation = compileFilesNavigationRenderHarness({
      activeProjectId: '',
      sidebarView: 'sessions',
      projects: [{ id: 'project-1', root: '/repo/one' }],
      activationResults: { 'project-1': false },
      document,
      sidebarSessionControlsEl,
      sessionListEl,
      sidebarFilesEl,
    });

    await expect(navigation.showProjectFiles('project-1')).resolves.toBe(false);
    expect(sidebarSessionControlsEl.hidden).toBe(false);
    expect(sessionListEl.hidden).toBe(false);
    expect(sidebarFilesEl.hidden).toBe(true);
    expect(document.activeElement).toBe(origin);
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

  it('keeps project titles ahead of fixed count and Files controls so narrow sidebars can truncate them', () => {
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
      title: 'Potion Laboratory With A Very Long Name',
      titleMatches: [],
      expanded: true,
      autoExpanded: false,
      count: 12,
      attentionCount: 0,
      project: {
        id: 'project-1',
        root: '/repo/potion-lab',
      },
    }, {
      current: false,
      tabindex: '-1',
    });

    const titleIndex = projectGroup.head.children.findIndex(
      (child) => child.className === 'session-project-name',
    );
    const countIndex = projectGroup.head.children.findIndex(
      (child) => child.className === 'session-project-count',
    );
    const filesIndex = projectGroup.head.children.findIndex(
      (child) => child.className === 'session-project-files',
    );
    const titleRule = ruleBlock('.session-project-name');
    const countRule = styles.match(
      /\.session-project-count,\s*\.session-branch-count,\s*\.session-category-count\s*\{([^}]*)\}/s,
    )?.[1] ?? '';
    const filesRule = ruleBlock('.session-project-files');

    expect(titleIndex).toBeGreaterThan(-1);
    expect(countIndex).toBeGreaterThan(titleIndex);
    expect(filesIndex).toBeGreaterThan(countIndex);
    expect(titleRule).toMatch(/min-width:\s*0;/);
    expect(titleRule).toMatch(/overflow:\s*hidden;/);
    expect(titleRule).toMatch(/text-overflow:\s*ellipsis;/);
    expect(titleRule).toMatch(/white-space:\s*nowrap;/);
    expect(countRule).toMatch(/flex:\s*none;/);
    expect(filesRule).toMatch(/flex:\s*none;/);
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
    const invalidateFilesPanelRender = vi.fn();
    const restoreSessionTreeFocus = vi.fn().mockReturnValue(false);
    const getElementById = vi.fn();
    const showSessionsSidebar = compileFunction<() => boolean>('showSessionsSidebar', {
      invalidateFilesPanelRender,
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
      restoreSessionTreeFocus,
      document: { getElementById },
    });

    expect(showSessionsSidebar()).toBe(true);
    expect(invalidateFilesPanelRender).toHaveBeenCalledOnce();
    rafCallback();
    expect(focus).toHaveBeenCalledOnce();
    expect(restoreSessionTreeFocus).not.toHaveBeenCalled();
    expect(getElementById).not.toHaveBeenCalled();
  });

  it('falls back to tree focus restoration when the originating Files button is missing and the tree can take focus', () => {
    let rafCallback: () => void = () => {
      throw new Error('expected requestAnimationFrame callback');
    };
    const focus = vi.fn();
    const restoreSessionTreeFocus = vi.fn().mockReturnValue(true);
    const invalidateFilesPanelRender = vi.fn();
    const setSidebarView = vi.fn();
    const renderSessionList = vi.fn();
    const showSessionsSidebar = compileFunction<() => boolean>('showSessionsSidebar', {
      invalidateFilesPanelRender,
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
      document: {
        getElementById: vi.fn((id: string) => id === 'rail-new-tab' ? { focus } : null),
      },
    });

    expect(showSessionsSidebar()).toBe(true);
    expect(invalidateFilesPanelRender).toHaveBeenCalledOnce();
    expect(setSidebarView).toHaveBeenCalledWith('sessions');
    expect(renderSessionList).toHaveBeenCalledWith({ preserveFocus: false });
    expect(functionSource('showSessionsSidebar')).toContain('sidebarFilesReturnProjectId = null;');
    rafCallback();
    expect(restoreSessionTreeFocus).toHaveBeenCalledWith('');
    expect(focus).not.toHaveBeenCalled();
  });

  it('focuses the New Session trigger when the originating Files button is missing and tree focus restoration fails', () => {
    let rafCallback: () => void = () => {
      throw new Error('expected requestAnimationFrame callback');
    };
    const focus = vi.fn();
    const restoreSessionTreeFocus = vi.fn().mockReturnValue(false);
    const showSessionsSidebar = compileFunction<() => boolean>('showSessionsSidebar', {
      invalidateFilesPanelRender: vi.fn(),
      sidebarFilesReturnProjectId: 'missing-project',
      setSidebarView: vi.fn(),
      renderSessionList: vi.fn(),
      requestAnimationFrame: (callback: () => void) => {
        rafCallback = callback;
        return 1;
      },
      sessionListEl: {
        querySelectorAll: () => [{ dataset: { projectFiles: 'project-2' }, focus: vi.fn() }],
      },
      restoreSessionTreeFocus,
      document: {
        getElementById: vi.fn((id: string) => id === 'rail-new-tab' ? { focus } : null),
      },
    });

    expect(showSessionsSidebar()).toBe(true);
    rafCallback();
    expect(restoreSessionTreeFocus).toHaveBeenCalledWith('');
    expect(focus).toHaveBeenCalledOnce();
  });

  it('restores focus to the replacement project Files button after rerendering the session list', () => {
    const document = new FakeDocument();
    const sessionListEl = document.createElement('div');
    const harness = compileRenderSessionListFocusHarness({
      document,
      sessionListEl,
      projects: [
        { id: 'project-1', root: '/repo/one' },
        { id: 'project-2', root: '/repo/two' },
      ],
      activeProjectId: 'project-1',
    });

    harness.renderSessionList();
    const originalButton = harness.projectFilesButtons().find(
      (button) => button.dataset.projectFiles === 'project-1',
    );

    expect(originalButton).toBeDefined();
    originalButton!.focus();

    harness.renderSessionList();

    const replacementButton = harness.projectFilesButtons().find(
      (button) => button.dataset.projectFiles === 'project-1',
    );
    const activeTreeItem = harness.treeItems().find(
      (item) => item.dataset.treeKey === 'project:project-1',
    );

    expect(replacementButton).toBeDefined();
    expect(replacementButton).not.toBe(originalButton);
    expect(document.activeElement).toBe(replacementButton);
    expect(harness.sessionTreeFocusKey()).toBe('project:project-1');
    expect(activeTreeItem?.getAttribute('tabindex')).toBe('0');
  });

  it('restores focus to the replacement project Files button after a scroll-style rerender request', () => {
    const document = new FakeDocument();
    const sessionListEl = document.createElement('div');
    const harness = compileRenderSessionListFocusHarness({
      document,
      sessionListEl,
      projects: [
        { id: 'project-a', root: '/repo/one' },
        { id: 'project-b', root: '/repo/two' },
      ],
      activeProjectId: 'project-a',
    });

    harness.renderSessionList();
    const originalButton = harness.projectFilesButtons().find(
      (button) => button.dataset.projectFiles === 'project-a',
    );

    expect(originalButton).toBeDefined();
    originalButton!.focus();

    harness.renderSessionList({
      preserveFocus: false,
      restoreFocusKey: '',
      restoreProjectFilesId: 'project-a',
    });

    const replacementButton = harness.projectFilesButtons().find(
      (button) => button.dataset.projectFiles === 'project-a',
    );
    const activeTreeItem = harness.treeItems().find(
      (item) => item.dataset.treeKey === 'project:project-a',
    );

    expect(replacementButton).toBeDefined();
    expect(replacementButton).not.toBe(originalButton);
    expect(document.activeElement).toBe(replacementButton);
    expect(harness.sessionTreeFocusKey()).toBe('project:project-a');
    expect(activeTreeItem?.getAttribute('tabindex')).toBe('0');
  });

  it('captures focused project Files buttons during virtualized session scroll rerenders', async () => {
    const document = new FakeDocument();
    const sessionListEl = document.createElement('div');
    const harness = compileRenderSessionListFocusHarness({
      document,
      sessionListEl,
      projects: [
        { id: 'project-a', root: '/repo/one' },
        { id: 'project-b', root: '/repo/two' },
      ],
      activeProjectId: 'project-a',
    });
    const syncSessionListScroll = vi.fn();
    const scheduledKeys: string[] = [];
    const renderSessionList = vi.fn((options?: Record<string, unknown>) => {
      harness.renderSessionList(options);
    });

    registerSessionListScrollHandler({
      document,
      sessionListEl,
      ptyRuntime: null,
      syncSessionListScroll,
      terminalFrameScheduler: {
        schedule: (key: string, callback: () => void) => {
          scheduledKeys.push(key);
          callback();
          return key;
        },
      },
      renderSessionList,
    });

    harness.renderSessionList();
    const originalButton = harness.projectFilesButtons().find(
      (button) => button.dataset.projectFiles === 'project-a',
    );
    const virtualSessionList = sessionListEl as FakeElement & {
      __psycheVirtualState?: { virtualized: boolean };
    };

    expect(originalButton).toBeDefined();
    originalButton!.focus();
    virtualSessionList.__psycheVirtualState = { virtualized: true };

    await sessionListEl.emit('scroll');

    const replacementButton = harness.projectFilesButtons().find(
      (button) => button.dataset.projectFiles === 'project-a',
    );

    expect(syncSessionListScroll).toHaveBeenCalledOnce();
    expect(scheduledKeys).toEqual(['collection:sessions']);
    expect(renderSessionList).toHaveBeenCalledOnce();
    expect(renderSessionList).toHaveBeenCalledWith({
      preserveFocus: false,
      restoreFocusKey: '',
      restoreProjectFilesId: 'project-a',
    });
    expect(replacementButton).toBeDefined();
    expect(replacementButton).not.toBe(originalButton);
    expect(document.activeElement).toBe(replacementButton);
  });

  it('keeps tree focus restoration ahead of project Files buttons for focused tree items', () => {
    const document = new FakeDocument();
    const sessionListEl = document.createElement('div');
    const harness = compileRenderSessionListFocusHarness({
      document,
      sessionListEl,
      projects: [{ id: 'project-1', root: '/repo/one' }],
      activeProjectId: 'project-1',
    });

    harness.renderSessionList();
    const originalTreeItem = harness.treeItems()[0];
    originalTreeItem?.focus();

    harness.renderSessionList();

    const replacementTreeItem = harness.treeItems()[0];
    const replacementButton = harness.projectFilesButtons()[0];

    expect(replacementTreeItem).toBeDefined();
    expect(replacementTreeItem).not.toBe(originalTreeItem);
    expect(document.activeElement).toBe(replacementTreeItem);
    expect(replacementButton?.focused).toBe(false);
  });

  it('matches only the current Files render scope', () => {
    const project = {
      id: 'project-1',
      root: '/repo',
      selectedWorktreePath: '/repo/worktrees/feature',
    };
    const harness = compileFilesPanelRequestHarness({
      activeProject: project,
      sidebarView: 'files',
      filesPanelGeneration: 3,
    });

    expect(
      harness.filesPanelRequestMatches(3, project.id, project.selectedWorktreePath),
    ).toBe(true);
    expect(
      harness.filesPanelRequestMatches(2, project.id, project.selectedWorktreePath),
    ).toBe(false);
    expect(
      harness.filesPanelRequestMatches(3, 'project-2', project.selectedWorktreePath),
    ).toBe(false);
    expect(harness.filesPanelRequestMatches(3, project.id, project.root)).toBe(false);

    harness.setSidebarView('sessions');
    expect(
      harness.filesPanelRequestMatches(3, project.id, project.selectedWorktreePath),
    ).toBe(false);

    harness.setSidebarView('files');
    harness.setActiveProject(null);
    expect(
      harness.filesPanelRequestMatches(3, project.id, project.selectedWorktreePath),
    ).toBe(false);
  });

  it('guards Files rendering and scope refreshes in source', () => {
    const renderFilesPanelSource = functionSource('renderFilesPanel');
    const showSessionsSidebarSource = functionSource('showSessionsSidebar');

    expect(renderFilesPanelSource).toContain('if (!fileTreeEl) return false;');
    expect(renderFilesPanelSource).toContain(
      'var generation = options && options.generation !== undefined',
    );
    expect(renderFilesPanelSource).toContain('renderedFileRows = [];');
    expect(renderFilesPanelSource).toContain('panelMessage(fileTreeEl, "Loading files…");');
    expect(renderFilesPanelSource).toContain(
      'if (!filesPanelRequestMatches(generation, project.id, workspaceRoot)) return false;',
    );
    expect(renderFilesPanelSource.indexOf('await appendDirInto(fileRows, workspaceRoot, workspaceRoot, 0);'))
      .toBeLessThan(
        renderFilesPanelSource.indexOf(
          'if (!filesPanelRequestMatches(generation, project.id, workspaceRoot)) return false;',
        ),
      );
    expect(showSessionsSidebarSource).toContain('invalidateFilesPanelRender();');
    expect(showSessionsSidebarSource.indexOf('invalidateFilesPanelRender();'))
      .toBeLessThan(showSessionsSidebarSource.indexOf('setSidebarView("sessions");'));
    expect(functionSource('assignActiveProjectId')).toContain('syncFilesPanelScope();');
    expect(functionSource('assignSelectedWorktreePath')).toContain('syncFilesPanelScope();');
    expect(functionSource('setActiveProject')).not.toContain('renderFilesPanel');
    expect(functionSource('activateProjectWorktree')).not.toContain('renderFilesPanel');
    const setSidebarViewSource = functionSource('setSidebarView');
    expect(setSidebarViewSource).toContain('if (enteringFiles) {');
    expect(setSidebarViewSource).toContain('document.getElementById("files-back")');
    expect(setSidebarViewSource).toContain('syncFilesPanelScope();');
    expect(setSidebarViewSource.indexOf('document.getElementById("files-back")'))
      .toBeLessThan(setSidebarViewSource.indexOf('syncFilesPanelScope();'));
  });

  it('routes active project and selected worktree mutations through the central scope seams', () => {
    const syncFilesPanelScope = vi.fn();
    const state = { activeProjectId: 'project-1' };
    const assignActiveProjectId = compileFunction<
      (projectId: string | null) => boolean
    >('assignActiveProjectId', {
      state,
      resetAgentControlProject: vi.fn(),
      findProject: () => null,
      syncFilesPanelScope,
    });

    expect(assignActiveProjectId(null)).toBe(true);
    expect(state.activeProjectId).toBeNull();
    expect(syncFilesPanelScope).toHaveBeenCalledOnce();
    expect(assignActiveProjectId(null)).toBe(false);
    expect(syncFilesPanelScope).toHaveBeenCalledOnce();

    [
      'activatePaneLayoutFocus',
      'activateProjectWorktree',
      'refreshProjectWorktrees',
      'focusCanvasSurface',
      'focusThread',
      'retainFileFocusAfterThreadRemoval',
      'activateFileTabNow',
      'revealFileForDecision',
      'migrateProjectRoot',
      'mergeRestoredProject',
    ].forEach((name) => {
      expect(functionSource(name)).not.toMatch(/project\.selectedWorktreePath\s*=/);
    });
    expect(functionSource('mergeRestoredProject')).toContain(
      'assignSelectedWorktreePath(target, incoming.selectedWorktreePath);',
    );
    [
      'setActiveProject',
      'focusCanvasSurface',
      'focusThread',
      'removeProject',
      'activateFileTabNow',
      'revealFileForDecision',
      'addProject',
      'boot',
    ].forEach((name) => {
      expect(functionSource(name)).toContain('assignActiveProjectId(');
    });
  });

  it('clears old rows immediately when a direct Files scope sync starts', async () => {
    const nextRead = createDeferred<void>();
    const messages: string[] = [];
    const fileTree = { firstChild: null as unknown };
    const panel = compileRenderFilesPanelHarness({
      activeProject: {
        id: 'project-1',
        root: '/repo/one',
      },
      fileTreeEl: fileTree,
      panelMessage: (element, text) => {
        messages.push(text);
        element.firstChild = { message: text };
      },
      appendDirInto: async (fileRows, root) => {
        if (root === '/repo/one') {
          fileRows.push({
            key: '/repo/one/old.ts',
            entry: { path: '/repo/one/old.ts', name: 'old.ts' },
            depth: 0,
          });
          return;
        }
        await nextRead.promise;
        fileRows.push({
          key: '/repo/two/new.ts',
          entry: { path: '/repo/two/new.ts', name: 'new.ts' },
          depth: 0,
        });
      },
      renderFileRows: (fileRows) => {
        fileTree.firstChild = fileRows[0] ?? null;
      },
    });

    await expect(panel.renderFilesPanel()).resolves.toBe(true);
    expect(panel.getRenderedFileRows()).toHaveLength(1);

    panel.setActiveProject({ id: 'project-2', root: '/repo/two' });
    const pendingSync = panel.syncFilesPanelScope();

    expect(pendingSync).not.toBe(false);
    expect(panel.getRenderedFileRows()).toEqual([]);
    expect(messages.at(-1)).toBe('Loading files…');
    expect(fileTree.firstChild).toEqual({ message: 'Loading files…' });

    nextRead.resolve();
    await expect(pendingSync).resolves.toBe(true);
    expect(panel.getRenderedFileRows()).toEqual([
      {
        key: '/repo/two/new.ts',
        entry: { path: '/repo/two/new.ts', name: 'new.ts' },
        depth: 0,
      },
    ]);
  });

  it('replaces final-project rows with the no-project state', async () => {
    const messages: string[] = [];
    const fileTree = { firstChild: null as unknown };
    const filesCrumb = { textContent: 'old scope' };
    const panel = compileRenderFilesPanelHarness({
      activeProject: { id: 'project-1', root: '/repo/one' },
      fileTreeEl: fileTree,
      filesCrumbEl: filesCrumb,
      panelMessage: (element, text) => {
        messages.push(text);
        element.firstChild = { message: text };
      },
      appendDirInto: async (fileRows) => {
        fileRows.push({
          key: '/repo/one/old.ts',
          entry: { path: '/repo/one/old.ts', name: 'old.ts' },
          depth: 0,
        });
      },
      renderFileRows: (fileRows) => {
        fileTree.firstChild = fileRows[0] ?? null;
      },
    });

    await expect(panel.renderFilesPanel()).resolves.toBe(true);
    panel.setActiveProject(null);

    await expect(panel.syncFilesPanelScope()).resolves.toBe(false);
    expect(panel.getRenderedFileRows()).toEqual([]);
    expect(filesCrumb.textContent).toBe('');
    expect(messages.at(-1)).toBe('No project open — ⌘O to add one.');
    expect(fileTree.firstChild).toEqual({
      message: 'No project open — ⌘O to add one.',
    });
  });

  it('removes stale file buttons before a same-scope refresh resolves', async () => {
    const refreshRead = createDeferred<void>();
    const openFileTab = vi.fn();
    let readCount = 0;
    let visibleButtons: Array<{ click: () => void }> = [];
    const fileTree = { firstChild: null as unknown };
    const panel = compileRenderFilesPanelHarness({
      activeProject: { id: 'project-1', root: '/repo/one' },
      fileTreeEl: fileTree,
      panelMessage: (element, text) => {
        visibleButtons = [];
        element.firstChild = { message: text };
      },
      appendDirInto: async (fileRows) => {
        readCount += 1;
        if (readCount > 1) await refreshRead.promise;
        fileRows.push({
          key: '/repo/one/file.ts',
          entry: { path: '/repo/one/file.ts', name: 'file.ts' },
          depth: 0,
        });
      },
      renderFileRows: (fileRows) => {
        visibleButtons = fileRows.map((fileRow) => ({
          click: () => openFileTab(
            (fileRow.entry as { path: string }).path,
          ),
        }));
        fileTree.firstChild = visibleButtons[0] ?? null;
      },
    });

    await expect(panel.renderFilesPanel()).resolves.toBe(true);
    expect(visibleButtons).toHaveLength(1);

    const pendingRefresh = panel.renderFilesPanel();
    expect(visibleButtons).toEqual([]);
    visibleButtons[0]?.click();
    expect(openFileTab).not.toHaveBeenCalled();

    refreshRead.resolve();
    await expect(pendingRefresh).resolves.toBe(true);
    expect(visibleButtons).toHaveLength(1);
  });

  it('applies only the newest rows across rapid project scope changes', async () => {
    const reads = new Map<string, ReturnType<typeof createDeferred<void>>>();
    const pendingRows = new Map<string, Array<Record<string, unknown>>>();
    const renderFileRows = vi.fn();
    const panel = compileRenderFilesPanelHarness({
      activeProject: { id: 'project-1', root: '/repo/one' },
      appendDirInto: (fileRows, root) => {
        const deferred = createDeferred<void>();
        reads.set(root, deferred);
        pendingRows.set(root, fileRows);
        return deferred.promise;
      },
      renderFileRows,
    });

    const firstScope = panel.syncFilesPanelScope();
    panel.setActiveProject({ id: 'project-2', root: '/repo/two' });
    const secondScope = panel.syncFilesPanelScope();
    panel.setActiveProject({ id: 'project-3', root: '/repo/three' });
    const newestScope = panel.syncFilesPanelScope();

    pendingRows.get('/repo/two')?.push({
      key: '/repo/two/stale.ts',
      entry: { path: '/repo/two/stale.ts', name: 'stale.ts' },
      depth: 0,
    });
    reads.get('/repo/two')?.resolve();
    await expect(secondScope).resolves.toBe(false);

    pendingRows.get('/repo/three')?.push({
      key: '/repo/three/current.ts',
      entry: { path: '/repo/three/current.ts', name: 'current.ts' },
      depth: 0,
    });
    reads.get('/repo/three')?.resolve();
    await expect(newestScope).resolves.toBe(true);

    pendingRows.get('/repo/one')?.push({
      key: '/repo/one/stale.ts',
      entry: { path: '/repo/one/stale.ts', name: 'stale.ts' },
      depth: 0,
    });
    reads.get('/repo/one')?.resolve();
    await expect(firstScope).resolves.toBe(false);

    expect(renderFileRows).toHaveBeenCalledOnce();
    expect(panel.getRenderedFileRows()).toEqual([
      {
        key: '/repo/three/current.ts',
        entry: { path: '/repo/three/current.ts', name: 'current.ts' },
        depth: 0,
      },
    ]);
  });

  it('renders once when showProjectFiles activates a new project while Files is already open', async () => {
    const navigation = compileFilesNavigationRenderHarness({
      activeProjectId: 'project-1',
      sidebarView: 'files',
      projects: [
        { id: 'project-1', root: '/repo/one' },
        { id: 'project-2', root: '/repo/two' },
      ],
    });

    await expect(navigation.showProjectFiles('project-2')).resolves.toBe(true);
    expect(navigation.getSyncCount()).toBe(1);
  });

  it('ignores an older deferred Files render after a newer render wins', async () => {
    const pendingAppends: Array<{
      release: (rows: Array<Record<string, unknown>>) => void;
    }> = [];
    const renderFileRows = vi.fn((fileRows: Array<Record<string, unknown>>) => {
      fileTree.firstChild = fileRows.length ? { rendered: true } : null;
    });
    const fileTree = { firstChild: null as unknown };
    const panel = compileRenderFilesPanelHarness({
      activeProject: {
        id: 'project-1',
        root: '/repo',
        selectedWorktreePath: '/repo/worktrees/feature',
      },
      fileTreeEl: fileTree,
      renderFileRows,
      appendDirInto: (fileRows) => {
        const deferred = createDeferred<void>();
        pendingAppends.push({
          release(rows) {
            fileRows.push(...rows);
            deferred.resolve();
          },
        });
        return deferred.promise;
      },
    });

    const olderRender = panel.renderFilesPanel();
    const newerRender = panel.renderFilesPanel();

    expect(pendingAppends).toHaveLength(2);

    pendingAppends[1].release([{ key: '/repo/newer.ts', entry: { path: '/repo/newer.ts', name: 'newer.ts' }, depth: 0 }]);
    await expect(newerRender).resolves.toBe(true);
    expect(renderFileRows).toHaveBeenCalledTimes(1);
    expect(panel.getRenderedFileRows()).toEqual([
      { key: '/repo/newer.ts', entry: { path: '/repo/newer.ts', name: 'newer.ts' }, depth: 0 },
    ]);

    pendingAppends[0].release([{ key: '/repo/older.ts', entry: { path: '/repo/older.ts', name: 'older.ts' }, depth: 0 }]);
    await expect(olderRender).resolves.toBe(false);
    expect(renderFileRows).toHaveBeenCalledTimes(1);
    expect(panel.getRenderedFileRows()).toEqual([
      { key: '/repo/newer.ts', entry: { path: '/repo/newer.ts', name: 'newer.ts' }, depth: 0 },
    ]);
  });

  it('ignores a deferred Files render after returning to Sessions', async () => {
    const pendingAppend = createDeferred<void>();
    const renderFileRows = vi.fn((fileRows: Array<Record<string, unknown>>) => {
      fileTree.firstChild = fileRows.length ? { rendered: true } : null;
    });
    const fileTree = { firstChild: null as unknown };
    let appendRows: Array<Record<string, unknown>> | null = null;
    const panel = compileRenderFilesPanelHarness({
      activeProject: {
        id: 'project-1',
        root: '/repo',
        selectedWorktreePath: '/repo/worktrees/feature',
      },
      fileTreeEl: fileTree,
      renderFileRows,
      appendDirInto: (fileRows) => {
        appendRows = fileRows;
        return pendingAppend.promise;
      },
    });

    const pendingRender = panel.renderFilesPanel();

    expect(panel.showSessionsSidebar()).toBe(true);

    expect(appendRows).not.toBeNull();
    appendRows!.push({
      key: '/repo/stale.ts',
      entry: { path: '/repo/stale.ts', name: 'stale.ts' },
      depth: 0,
    });
    pendingAppend.resolve();

    await expect(pendingRender).resolves.toBe(false);
    expect(panel.getSidebarView()).toBe('sessions');
    expect(renderFileRows).not.toHaveBeenCalled();
    expect(panel.getRenderedFileRows()).toEqual([]);
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
