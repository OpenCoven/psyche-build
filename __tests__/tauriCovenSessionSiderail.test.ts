import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});

const repoRoot = process.cwd();
const mainJs = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
);
const styles = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/styles.css'),
  'utf8',
);
const indexHtml = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/index.html'),
  'utf8',
);
/**
 * The `PsycheSessions` global the shell sees is the *bundle*, and session-entry
 * re-exports two modules into it. Standing in with only the session model made
 * the rail renderer look like it could not reach `attentionLabel` when in the
 * app it always can, so the stand-in is assembled the same way the bundle is.
 */
const PsycheSessions = {
  ...(await import(pathToFileURL(join(
    repoRoot,
    'native/desktop/psyche-build-tauri/web/sessions/session-model.mjs',
  )).href)),
  ...(await import(pathToFileURL(join(
    repoRoot,
    'native/desktop/psyche-build-tauri/web/sessions/attention.mjs',
  )).href)),
  ...(await import(pathToFileURL(join(
    repoRoot,
    'native/desktop/psyche-build-tauri/web/sessions/sidebar-model.mjs',
  )).href)),
  ...(await import(pathToFileURL(join(
    repoRoot,
    'native/desktop/psyche-build-tauri/web/sessions/project-appearance.mjs',
  )).href)),
};

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

function decodeHtml(value: string) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

type Listener = (event: FakeEvent) => unknown;

class FakeStyle {
  private readonly properties = new Map<string, string>();
  left = '';
  top = '';
  maxWidth = '';
  maxHeight = '';

  setProperty(name: string, value: string) {
    this.properties.set(name, String(value));
  }

  getPropertyValue(name: string) {
    return this.properties.get(name) ?? '';
  }

  removeProperty(name: string) {
    this.properties.delete(name);
  }
}

class FakeEvent {
  target: FakeElement;
  key: string;
  shiftKey: boolean;
  clientX: number;
  clientY: number;
  propagationStopped = false;
  defaultPrevented = false;

  constructor(
    target: FakeElement,
    key = '',
    options: { shiftKey?: boolean; clientX?: number; clientY?: number } = {},
  ) {
    this.target = target;
    this.key = key;
    this.shiftKey = Boolean(options.shiftKey);
    this.clientX = options.clientX ?? 0;
    this.clientY = options.clientY ?? 0;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeElement {
  readonly tagName: string;
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly innerHtmlAssignments: string[] = [];
  readonly style = new FakeStyle();
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  className = '';
  title = '';
  type = '';
  value = '';
  disabled = false;
  spellcheck = true;
  autocomplete = '';
  focused = false;
  selected = false;
  hidden = false;
  private rect = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
  };
  private ownText = '';
  private html = '';

  constructor(tagName: string, private readonly ownerDocument: FakeDocument | null = null) {
    this.tagName = tagName.toUpperCase();
  }

  get classList() {
    return {
      contains: (name: string) => this.className.split(/\s+/).includes(name),
      add: (name: string) => {
        if (!this.className.split(/\s+/).includes(name)) {
          this.className = `${this.className} ${name}`.trim();
        }
      },
      remove: (name: string) => {
        this.className = this.className
          .split(/\s+/)
          .filter((candidate) => candidate && candidate !== name)
          .join(' ');
      },
    };
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.clearFocusWithinChildren();
    this.ownText = String(value);
    this.html = '';
    this.children = [];
  }

  get innerHTML() {
    return this.html;
  }

  set innerHTML(value: string) {
    this.clearFocusWithinChildren();
    this.html = String(value);
    this.ownText = '';
    this.children = [];
    this.innerHtmlAssignments.push(this.html);
    if (!this.html) return;

    // The production local-session row deliberately retains its existing
    // markup path. Parse only that small fixed shape.
    const title = /<span class="session-title">([\s\S]*?)<\/span>/.exec(this.html);
    const sub = /<span class="session-sub">([\s\S]*?)<\/span>/.exec(this.html);
    if (!title || !sub) return;
    // The glyph carries git-state classes, so keep the class list verbatim
    // rather than flattening it back to the bare hook.
    const glyph = /<span class="(session-glyph[^"]*)"[^>]*>([\s\S]*?)<\/span>/.exec(this.html);
    if (glyph) {
      const glyphElement = new FakeElement('span');
      glyphElement.className = glyph[1];
      glyphElement.textContent = decodeHtml(glyph[2]);
      this.appendChild(glyphElement);
    }
    const text = new FakeElement('span');
    text.className = 'session-text';
    const titleRow = new FakeElement('span');
    titleRow.className = 'session-title-row';
    const titleElement = new FakeElement('span');
    titleElement.className = 'session-title';
    titleElement.textContent = decodeHtml(title[1]);
    titleRow.appendChild(titleElement);
    if (this.html.includes('class="session-oncanvas"')) {
      const onCanvas = new FakeElement('span');
      onCanvas.className = 'session-oncanvas';
      titleRow.appendChild(onCanvas);
    }
    // Focus-set membership swatches, one per set the pane belongs to.
    for (const match of this.html.matchAll(
      /<span class="session-set-swatch" data-set="(\d)" title="([^"]*)"/g,
    )) {
      const swatch = new FakeElement('span');
      swatch.className = 'session-set-swatch';
      swatch.dataset.set = match[1];
      swatch.title = decodeHtml(match[2]);
      titleRow.appendChild(swatch);
    }
    const subElement = new FakeElement('span');
    subElement.className = 'session-sub';
    subElement.textContent = decodeHtml(sub[1]);
    text.appendChild(titleRow);
    text.appendChild(subElement);
    this.appendChild(text);
    const stateWrap = new FakeElement('span');
    stateWrap.className = 'session-state';
    const dot = new FakeElement('span');
    dot.className = 'session-dot';
    stateWrap.appendChild(dot);
    const chip = /<span class="session-chip(?: muted)?">([\s\S]*?)<\/span>/.exec(this.html);
    if (chip) {
      const chipElement = new FakeElement('span');
      chipElement.className = 'session-chip';
      chipElement.textContent = decodeHtml(chip[1]);
      stateWrap.appendChild(chipElement);
    }
    this.appendChild(stateWrap);
    if (this.html.includes('class="session-close"')) {
      const close = new FakeElement('button');
      close.className = 'session-close';
      close.textContent = '×';
      this.appendChild(close);
    }
  }

  appendChild(child: FakeElement) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement) {
    const index = this.children.indexOf(child);
    if (index === -1) throw new Error('child not found');
    if (child.contains(this.ownerDocument?.activeElement ?? null) && this.ownerDocument) {
      if (this.ownerDocument.activeElement) this.ownerDocument.activeElement.focused = false;
      this.ownerDocument.activeElement = null;
    }
    this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  get isConnected(): boolean {
    if (this.parentNode) return this.parentNode.isConnected;
    return this.ownerDocument?.isConnectedRoot(this) ?? false;
  }

  get parentElement() {
    return this.parentNode;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  replaceChildren(...children: FakeElement[]) {
    this.clearFocusWithinChildren();
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
    this.ownText = '';
    this.html = '';
    children.forEach((child) => this.appendChild(child));
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  focus() {
    if (this.ownerDocument?.activeElement) this.ownerDocument.activeElement.focused = false;
    this.focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  contains(candidate: FakeElement | null): boolean {
    if (!candidate) return false;
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  private clearFocusWithinChildren() {
    const activeElement = this.ownerDocument?.activeElement ?? null;
    if (activeElement !== this && this.contains(activeElement) && this.ownerDocument) {
      activeElement!.focused = false;
      this.ownerDocument.activeElement = null;
    }
  }

  select() {
    this.selected = true;
  }

  click() {
    const event = new FakeEvent(this);
    for (let element: FakeElement | null = this; element; element = element.parentElement) {
      for (const listener of element.listeners.get('click') ?? []) {
        void listener(event);
      }
      if (event.propagationStopped) break;
    }
  }

  matches(selector: string) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector === '[data-tree-item]') return Boolean(this.dataset.treeItem);
    if (/^[a-z]+$/i.test(selector)) return this.tagName === selector.toUpperCase();
    const attributeSelector = /^([a-z]+)\[([^=\]]+)="([^"]*)"\]$/i.exec(selector);
    if (attributeSelector) {
      return this.tagName === attributeSelector[1].toUpperCase()
        && this.getAttribute(attributeSelector[2]) === attributeSelector[3];
    }
    return false;
  }

  closest(selector: string): FakeElement | null {
    for (let element: FakeElement | null = this; element; element = element.parentElement) {
      if (element.matches(selector)) return element;
    }
    return null;
  }

  addEventListener(name: string, listener: Listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  setBoundingClientRect(rect: Partial<typeof this.rect>) {
    this.rect = {
      ...this.rect,
      ...rect,
    };
    if (!('right' in rect)) this.rect.right = this.rect.left + this.rect.width;
    if (!('bottom' in rect)) this.rect.bottom = this.rect.top + this.rect.height;
    if (!('width' in rect)) this.rect.width = this.rect.right - this.rect.left;
    if (!('height' in rect)) this.rect.height = this.rect.bottom - this.rect.top;
  }

  getBoundingClientRect() {
    return { ...this.rect };
  }

  async emit(
    name: string,
    options: {
      target?: FakeElement;
      key?: string;
      shiftKey?: boolean;
      clientX?: number;
      clientY?: number;
    } = {},
  ) {
    const event = new FakeEvent(options.target ?? this, options.key, options);
    for (const listener of this.listeners.get(name) ?? []) {
      await listener(event);
    }
    return event;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const classSelector = selector.startsWith('.') ? selector.slice(1) : null;
    const treeItemSelector = selector === '[data-tree-item]';
    const tagSelector = !classSelector && !treeItemSelector && /^[a-z]+$/i.test(selector)
      ? selector.toUpperCase()
      : null;
    const attributeSelector = !classSelector && !treeItemSelector
      ? /^([a-z]+)\[([^=\]]+)="([^"]*)"\]$/i.exec(selector)
      : null;
    if (!classSelector && !treeItemSelector && !tagSelector && !attributeSelector) {
      throw new Error(`unsupported selector ${selector}`);
    }
    const matches: FakeElement[] = [];
    const visit = (element: FakeElement) => {
      if (classSelector && element.classList.contains(classSelector)) matches.push(element);
      if (treeItemSelector && element.dataset.treeItem) matches.push(element);
      if (tagSelector && element.tagName === tagSelector) matches.push(element);
      if (attributeSelector &&
          element.tagName === attributeSelector[1].toUpperCase() &&
          element.getAttribute(attributeSelector[2]) === attributeSelector[3]) {
        matches.push(element);
      }
      element.children.forEach(visit);
    };
    this.children.forEach(visit);
    return matches;
  }
}

class FakeDocument {
  readonly body: FakeElement;
  readonly created: FakeElement[] = [];
  private readonly connectedRoots = new Set<FakeElement>();
  private readonly listeners = new Map<string, Listener[]>();
  activeElement: FakeElement | null = null;

  constructor() {
    this.body = new FakeElement('body', this);
    this.connectRoot(this.body);
  }

  connectRoot(element: FakeElement) {
    this.connectedRoots.add(element);
  }

  isConnectedRoot(element: FakeElement) {
    return this.connectedRoots.has(element);
  }

  createElement(tagName: string) {
    const element = new FakeElement(tagName, this);
    this.created.push(element);
    return element;
  }

  addEventListener(name: string, listener: Listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  async emit(
    name: string,
    options: {
      target?: FakeElement;
      key?: string;
      shiftKey?: boolean;
      clientX?: number;
      clientY?: number;
    } = {},
  ) {
    const event = new FakeEvent(options.target ?? this.body, options.key, options);
    for (const listener of this.listeners.get(name) ?? []) {
      await listener(event);
    }
    return event;
  }

  querySelector() {
    return null;
  }
}

type Project = {
  id: string;
  name: string;
  root: string;
  collapsed?: boolean;
  selectedWorktreePath?: string;
  worktrees?: Array<{
    path: string;
    branch: string | null;
    is_main: boolean;
    dirty: boolean;
    missing: boolean;
    prunable?: boolean;
    bare?: boolean;
    collapsed?: boolean;
  }>;
};
type LocalThread = {
  id: string;
  projectId: string;
  name: string;
  needsAttention?: boolean;
  status?: string;
  spawning?: boolean;
  hidden?: boolean;
  launch?: {
    covenSessionId?: string | null;
    launchKind?: string | null;
    command?: string;
    args?: string[];
  };
  worktreePath?: string;
  kind?: string;
  lastOutputAt?: number;
  isWorking?: boolean;
};
type RemoteSession = {
  id: string;
  projectRoot: string;
  labels?: string[];
  title?: string;
  harness?: string;
  status?: string;
  updatedAt?: string;
  cwd?: string;
};

function createRenderer(options: {
  projects?: Project[];
  threads?: LocalThread[];
  sessions?: RemoteSession[];
  projectAppearances?: Record<string, { accent?: string; glyph?: string }>;
  phase?: string;
  message?: string | null;
  stale?: boolean;
  composerQuery?: string;
  activeProjectId?: string | null;
  activeThreadId?: string | null;
  openCovenSession?: (project: Project, session: RemoteSession) => unknown;
  invoke?: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  refreshCovenSessions?: (options?: { force?: boolean }) => Promise<unknown>;
  openProjectAppearancePopover?: (project: Project, anchor: FakeElement) => unknown;
  realEdit?: boolean;
  canvasThreadIds?: string[];
  focusSets?: Array<{ id: string; index: number; name: string; key: string; threadIds: string[] }>;
  scopingSet?: { id: string; name: string; threadIds: string[] } | null;
  setPicking?: { key: string; picked: string[] } | null;
  selectedSessionKey?: string;
  typeFilter?: string;
  localStorageReadError?: unknown;
  localStorageWriteError?: unknown;
} = {}) {
  const document = new FakeDocument();
  const sessionListEl = new FakeElement('div', document);
  const composerInputEl = new FakeElement('textarea', document);
  document.connectRoot(sessionListEl);
  document.connectRoot(composerInputEl);
  composerInputEl.value = options.composerQuery ?? '';
  const projectAppearancesKey = 'psyche.tauri.project-appearances.v1';
  const storage = new Map<string, string>();
  if (options.projectAppearances) {
    storage.set(projectAppearancesKey, JSON.stringify(options.projectAppearances));
  }
  const localStorage = {
    getItem: vi.fn((key: string) => {
      if (options.localStorageReadError && key === projectAppearancesKey) {
        throw options.localStorageReadError;
      }
      return storage.get(key) ?? null;
    }),
    setItem: vi.fn((key: string, value: string) => {
      if (options.localStorageWriteError) throw options.localStorageWriteError;
      storage.set(key, String(value));
    }),
  };
  const state = {
    env: { home: '/Users/val' },
    projects: options.projects ?? [{ id: 'alpha', name: 'Alpha', root: '/alpha' }],
    threads: options.threads ?? [],
    activeProjectId: options.activeProjectId ?? null,
    activeThreadId: options.activeThreadId ?? null,
  };
  const discovery = {
    phase: options.phase ?? 'ready',
    sessionsByProject: PsycheSessions.groupCovenSessions(options.sessions ?? []),
    message: options.message ?? null,
    requestId: 1,
    refreshedAt: 1,
    stale: options.stale ?? false,
  };
  const setActiveProject = vi.fn().mockResolvedValue(true);
  const activateProjectWorktree = vi.fn(async (project: Project) => {
    await setActiveProject(project.id);
    return true;
  });
  const findThread = (id: string | null | undefined) =>
    state.threads.find((thread) => thread.id === id) ?? null;
  const findProject = (id: string | null | undefined) =>
    state.projects.find((project) => project.id === id) ?? null;
  const focusThread = vi.fn().mockResolvedValue(undefined);
  const closeThread = vi.fn();
  const closeBrowserPane = vi.fn();
  const hideThread = vi.fn();
  const editLabelInline = vi.fn();
  const renameThread = vi.fn((id: string, value: string) => {
    const thread = state.threads.find((candidate) => candidate.id === id);
    if (!thread) return false;
    thread.name = value.trim();
    return true;
  });
  const realEditLabelInline = Function(
    'document', 'editingContext', 'requestAnimationFrame',
    `"use strict"; ${extractFunctionSource(mainJs, 'editLabelInline')}; return editLabelInline;`,
  )(
    document,
    null,
    (callback: () => void) => callback(),
  ) as (element: FakeElement, surface: string, editOptions: unknown) => void;
  const editLabelInlineImpl = options.realEdit ? realEditLabelInline : editLabelInline;
  const openCovenSession = vi.fn(options.openCovenSession ?? (() => Promise.resolve()));
  const invoke = vi.fn(options.invoke ?? (() => Promise.resolve()));
  const refreshCovenSessions = vi.fn(options.refreshCovenSessions ?? (() => Promise.resolve()));
  const setStatus = vi.fn();
  const statusAlertEl = new FakeElement('div', document);
  statusAlertEl.setAttribute('role', 'alert');
  const toastEl = new FakeElement('div', document);
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  const toastTimeouts: number[] = [];
  const onCanvasIds = options.canvasThreadIds ?? [];
  const canvasThreadIds = vi.fn(() => onCanvasIds);
  // Focus sets: the membership model is real (setsForThread / isPicked run from
  // main.js), while the actions that need a live pane layout are spied.
  const focusSets = options.focusSets ?? [];
  const scopingSet = options.scopingSet ?? null;
  const removeFromFocusSet = vi.fn();
  const applySetScopeForThread = vi.fn();
  const activateFocusSet = vi.fn();
  const clearFocusSet = vi.fn();
  const settings = {
    selectedSessionKey: options.selectedSessionKey ?? '',
    sessionFilter: options.typeFilter ?? 'all',
    sidebarTab: 'sessions',
  };
  const saveSettings = vi.fn();
  const saveWorkspaceSoon = vi.fn();
  const setSessionTypeFilter = vi.fn();
  const openSessionContextMenu = vi.fn();
  const openProjectAppearancePopover = vi.fn(
    options.openProjectAppearancePopover ?? (() => undefined),
  );
  const paneGlyphFor = (kind: string) =>
    kind === 'shell' ? '❯_' : kind === 'web' ? '◍' : '✳';

  const sources = [
    'var SESSION_CLOSE_SECONDS = 3;',
    'var armedSessionClose = null;',
    'var covenSessionCloseFlights = new Set();',
    'var covenSessionMutationGeneration = 0;',
    'var PROJECT_APPEARANCES_KEY = "psyche.tauri.project-appearances.v1";',
    'var focusSets = seedFocusSets;',
    'var setPicking = seedSetPicking;',
    'var deferredStatusMessages = [];',
    'var statusAlertEl = seedStatusAlertEl;',
    'var toastEl = seedToastEl;',
    'var toastTimer = 0;',
    'var sessionTreeFocusKey = "";',
    'var isRestoringWorkspace = false;',
    extractFunctionSource(mainJs, 'toast'),
    extractFunctionSource(mainJs, 'showStatusError'),
    extractFunctionSource(mainJs, 'queueDeferredStatus'),
    extractFunctionSource(mainJs, 'flushDeferredStatusMessages'),
    extractFunctionSource(mainJs, 'loadProjectAppearances'),
    'var projectAppearances = loadProjectAppearances();',
    extractFunctionSource(mainJs, 'paneLayoutKey'),
    extractFunctionSource(mainJs, 'findFocusSet'),
    extractFunctionSource(mainJs, 'setsForThread'),
    extractFunctionSource(mainJs, 'isPicked'),
    extractFunctionSource(mainJs, 'toggleSetPick'),
    extractFunctionSource(mainJs, 'isDormantThread'),
    extractFunctionSource(mainJs, 'syncLocalSidebarStatusKeys'),
    extractFunctionSource(mainJs, 'covenRootDepth'),
    extractFunctionSource(mainJs, 'covenProjectCandidate'),
    extractFunctionSource(mainJs, 'compareCovenProjectCandidates'),
    extractFunctionSource(mainJs, 'covenSessionAssignments'),
    extractFunctionSource(mainJs, 'covenSessionsForProject'),
    extractFunctionSource(mainJs, 'covenInlineState'),
    extractFunctionSource(mainJs, 'covenToneClass'),
    extractFunctionSource(mainJs, 'sessionLaneLabel'),
    extractFunctionSource(mainJs, 'disarmSessionClose'),
    extractFunctionSource(mainJs, 'armSessionClose'),
    extractFunctionSource(mainJs, 'closeCovenSession'),
    extractFunctionSource(mainJs, 'threadCovenSessionId'),
    // createCovenSessionRow is gone on this branch and isReusableCovenAttachment
    // is not on renderSessionList's path any more — the sidebar tree below
    // reaches attachment state through covenRowAttached instead.
    extractFunctionSource(mainJs, 'covenRowAttached'),
    'var sessionTypeFilter = seedSessionTypeFilter;',
    extractFunctionSource(mainJs, 'attachTooltip'),
    extractFunctionSource(mainJs, 'appendHighlightedText'),
    extractFunctionSource(mainJs, 'createDisclosure'),
    extractFunctionSource(mainJs, 'createStatusIndicator'),
    extractFunctionSource(mainJs, 'createCategoryLabel'),
    extractFunctionSource(mainJs, 'createSessionRow'),
    extractFunctionSource(mainJs, 'createBranchGroup'),
    extractFunctionSource(mainJs, 'createProjectGroup'),
    extractFunctionSource(mainJs, 'visibleSessionTreeItems'),
    extractFunctionSource(mainJs, 'focusSessionTreeItem'),
    extractFunctionSource(mainJs, 'parentSessionTreeItem'),
    extractFunctionSource(mainJs, 'firstChildSessionTreeItem'),
    extractFunctionSource(mainJs, 'toggleSessionTreeDisclosure'),
    extractFunctionSource(mainJs, 'activateSessionTreeItem'),
    extractFunctionSource(mainJs, 'handleSessionTreeKeydown'),
    extractFunctionSource(mainJs, 'restoreSessionTreeFocus'),
    extractFunctionSource(mainJs, 'threadIsToolPane'),
    extractFunctionSource(mainJs, 'sessionCloseLabel'),
    extractFunctionSource(mainJs, 'localSessionContextActions'),
    'var projectAppearancePopover = null;',
    'var projectAppearancePopoverRestoreKey = "";',
    extractFunctionSource(mainJs, 'closeProjectAppearancePopover'),
    extractFunctionSource(mainJs, 'projectAppearanceContextActions'),
    extractFunctionSource(mainJs, 'saveProjectAppearances'),
    extractFunctionSource(mainJs, 'applyProjectAppearance'),
    extractFunctionSource(mainJs, 'renderSessionList'),
  ];
  const harness = Function(
    'document', 'sessionListEl', 'editingContext', 'state',
    'covenDiscovery', 'PsycheSessions', 'sessionStatusClass', 'shortenRoot',
    'escapeHtml', 'setActiveProject', 'focusThread', 'closeThread', 'closeBrowserPane',
    'requestThreadClose', 'hideThread', 'renameThread', 'editLabelInline',
    'openCovenSession', 'setStatus',
    'canvasThreadIds', 'paneGlyphFor', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    'seedFocusSets', 'seedSetPicking', 'refreshSidebar', 'activeFocusSet',
    'removeFromFocusSet', 'applySetScopeForThread', 'activateFocusSet', 'clearFocusSet',
    'settings', 'saveSettings', 'seedSessionTypeFilter', 'findThread', 'findProject',
    'saveWorkspaceSoon', 'activateProjectWorktree', 'showProjectFiles', 'setSessionTypeFilter',
    'openSessionContextMenu', 'openProjectAppearancePopover',
    'invoke', 'refreshCovenSessions', 'localStorage', 'seedStatusAlertEl', 'seedToastEl',
    `"use strict"; ${sources.join('\n')}; return {
      render: function () {
        renderSessionList();
        flushDeferredStatusMessages();
      },
      setDiscovery: function (value) { covenDiscovery = value; },
      armSessionClose: armSessionClose,
      disarmSessionClose: disarmSessionClose,
      closeCovenSession: closeCovenSession,
      handleTreeKeydown: handleSessionTreeKeydown,
      toggleSetPick: toggleSetPick,
      picked: function () { return setPicking ? setPicking.picked.slice() : null; },
      saveProjectAppearances: saveProjectAppearances,
      applyProjectAppearance: applyProjectAppearance,
      projectAppearances: function () { return projectAppearances; },
      sessionTreeFocusKey: function () { return sessionTreeFocusKey; },
      setProjectAppearancePopover: function (popover, restoreKey) {
        projectAppearancePopover = popover;
        projectAppearancePopoverRestoreKey = restoreKey || "";
      }
    };`,
  )(
    document,
    sessionListEl,
    null,
    state,
    discovery,
    PsycheSessions,
    (thread: LocalThread) => thread.spawning || thread.status === 'starting'
      ? 'starting'
      : thread.status === 'running'
        ? 'running'
        : thread.status === 'exited' ? 'exited' : '',
    (root: string) => root,
    (value: string) => String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;'),
    setActiveProject,
    focusThread,
    closeThread,
    closeBrowserPane,
    (thread: { id: string; kind?: string } | null) => {
      if (!thread) return Promise.resolve(false);
      if (thread.kind === 'web') return Promise.resolve(closeBrowserPane(thread));
      return Promise.resolve(closeThread(thread.id));
    },
    hideThread,
    renameThread,
    editLabelInlineImpl,
    openCovenSession,
    setStatus,
    canvasThreadIds,
    paneGlyphFor,
    setInterval,
    clearInterval,
    (_callback: () => void, delay: number) => {
      toastTimeouts.push(delay);
      return 1;
    },
    () => undefined,
    focusSets,
    options.setPicking ?? null,
    () => { harness.render(); },
    () => scopingSet,
    removeFromFocusSet,
    applySetScopeForThread,
    activateFocusSet,
    clearFocusSet,
    settings,
    saveSettings,
    settings.sessionFilter,
    findThread,
    findProject,
    saveWorkspaceSoon,
    activateProjectWorktree,
    () => Promise.resolve(false),
    setSessionTypeFilter,
    openSessionContextMenu,
    openProjectAppearancePopover,
    invoke,
    refreshCovenSessions,
    localStorage,
    statusAlertEl,
    toastEl,
  ) as {
    render: () => void;
    setDiscovery: (value: typeof discovery) => void;
    armSessionClose: (
      host: FakeElement, close: FakeElement, label: string, onConfirm: () => unknown,
    ) => void;
    disarmSessionClose: (options?: { restoreFocus?: boolean }) => void;
    closeCovenSession: (session: RemoteSession) => Promise<boolean>;
    handleTreeKeydown: (event: FakeEvent) => void;
    toggleSetPick: (threadId: string) => void;
    picked: () => string[] | null;
    saveProjectAppearances: () => boolean;
    applyProjectAppearance: (
      project: Project | null | undefined,
      patch: { accent?: string | null; glyph?: string | null } | null,
    ) => boolean;
    projectAppearances: () => Record<string, { accent?: string; glyph?: string }>;
    sessionTreeFocusKey: () => string;
    setProjectAppearancePopover: (popover: FakeElement | null, restoreKey?: string) => void;
    settings: typeof settings;
    saveSettings: typeof saveSettings;
    saveWorkspaceSoon: typeof saveWorkspaceSoon;
  };

  return {
    ...harness,
    document,
    sessionListEl,
    composerInputEl,
    state,
    discovery,
    focusSets,
    removeFromFocusSet,
    applySetScopeForThread,
    activateFocusSet,
    clearFocusSet,
    settings,
    saveSettings,
    saveWorkspaceSoon,
    setSessionTypeFilter,
    openSessionContextMenu,
    setActiveProject,
    activateProjectWorktree,
    focusThread,
    closeThread,
    hideThread,
    renameThread,
    editLabelInline,
    openCovenSession,
    invoke,
    localStorage,
    refreshCovenSessions,
    setStatus,
    statusAlertEl,
    toastEl,
    toastTimeouts,
    canvasThreadIds,
    openProjectAppearancePopover,
  };
}

function createSessionContextMenuHarness() {
  const document = new FakeDocument();
  const sessionListEl = new FakeElement('div', document);
  document.connectRoot(sessionListEl);

  const project = new FakeElement('div', document);
  project.className = 'session-project';
  project.dataset.treeItem = 'project';
  project.dataset.projectId = 'psyche';
  project.dataset.treeKey = 'project:psyche';
  project.setAttribute('tabindex', '0');
  sessionListEl.appendChild(project);

  const openProjectAppearancePopover = vi.fn();
  const windowValue = { innerWidth: 1280, innerHeight: 720 };
  const projectValue = { id: 'psyche', name: 'PSYCHE-BUILD', root: '/repo/psyche-build' };
  const harness = Function(
    'document', 'window', 'sessionListEl', 'findProject', 'openProjectAppearancePopover',
    `"use strict";
    var sessionTreeFocusKey = "";
    var projectAppearancePopover = null;
    function closeProjectAppearancePopover() {}
    var sessionContextMenu = null;
    var sessionContextMenuRestoreKey = "";
    ${extractFunctionSource(mainJs, 'visibleSessionTreeItems')}
    ${extractFunctionSource(mainJs, 'focusSessionTreeItem')}
    ${extractFunctionSource(mainJs, 'parentSessionTreeItem')}
    ${extractFunctionSource(mainJs, 'firstChildSessionTreeItem')}
    ${extractFunctionSource(mainJs, 'toggleSessionTreeDisclosure')}
    ${extractFunctionSource(mainJs, 'activateSessionTreeItem')}
    ${extractFunctionSource(mainJs, 'restoreSessionTreeFocus')}
    ${extractFunctionSource(mainJs, 'projectAppearanceContextActions')}
    ${extractFunctionSource(mainJs, 'closeSessionContextMenu')}
    ${extractFunctionSource(mainJs, 'openSessionContextMenu')}
    ${extractFunctionSource(mainJs, 'handleSessionTreeKeydown')}
    return {
      closeSessionContextMenu: closeSessionContextMenu,
      handleTreeKeydown: handleSessionTreeKeydown,
      sessionContextMenu: function () { return sessionContextMenu; },
      sessionTreeFocusKey: function () { return sessionTreeFocusKey; }
    };`,
  )(
    document,
    windowValue,
    sessionListEl,
    (id: string) => (id === projectValue.id ? projectValue : null),
    openProjectAppearancePopover,
  ) as {
    closeSessionContextMenu: (options?: { restoreFocus?: boolean }) => void;
    handleTreeKeydown: (event: FakeEvent) => void;
    sessionContextMenu: () => FakeElement | null;
    sessionTreeFocusKey: () => string;
  };

  return {
    ...harness,
    document,
    sessionListEl,
    project,
    openProjectAppearancePopover,
  };
}

function textOf(elements: FakeElement[]) {
  return elements.map((element) => element.textContent);
}

function descendants(element: FakeElement) {
  const result: FakeElement[] = [];
  const visit = (node: FakeElement) => {
    result.push(node);
    node.children.forEach(visit);
  };
  element.children.forEach(visit);
  return result;
}

/**
 * This branch folds Coven sessions into the unified session tree, so the
 * bespoke `.session-coven-row` builder is gone. A Coven row is now a
 * `.session-row` carrying dataset.sessionId; a local pane carries
 * dataset.threadId. These two helpers keep the assertions below expressed in
 * terms of what a row *is* rather than which builder happened to make it, so
 * they survive the next rendering change too.
 */
function covenRows(element: FakeElement) {
  return element.querySelectorAll('.session-row').filter((row) => row.dataset.sessionId);
}

function localRows(element: FakeElement) {
  return element.querySelectorAll('.session-row').filter((row) => row.dataset.threadId);
}

function projectNamesWithRows(element: FakeElement) {
  return element.querySelectorAll('.session-project')
    .filter((project) => Boolean(project.querySelector('.session-row')))
    .map((project) => project.querySelector('.session-project-name')?.textContent ?? '');
}

describe('Tauri Coven session project rail', () => {
  it('renders project, branch, category, and unified session rows with counts', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const renderer = createRenderer({
      projects: [{
        id: 'psyche',
        name: 'PSYCHE-BUILD',
        root: '/repo/psyche-build',
        collapsed: false,
        selectedWorktreePath: '/repo/psyche-wt',
        worktrees: [{
          path: '/repo/psyche-wt',
          branch: 'feat/web-pane-attention',
          is_main: false,
          collapsed: false,
          dirty: true,
          missing: false,
        }],
      }],
      threads: [
        {
          id: 'shell-7', projectId: 'psyche', worktreePath: '/repo/psyche-wt',
          name: 'shell 7', kind: 'shell', status: 'running', lastOutputAt: 1,
        },
        {
          id: 'shell-8-api', projectId: 'psyche', worktreePath: '/repo/psyche-wt',
          name: 'shell 8', kind: 'shell', status: 'running',
          launch: { command: 'pnpm', args: ['dev'] }, lastOutputAt: 9_999,
        },
        {
          id: 'shell-8-tests', projectId: 'psyche', worktreePath: '/repo/psyche-wt',
          name: 'shell 8', kind: 'shell', status: 'running',
          launch: { command: 'vitest', args: ['--watch'] }, lastOutputAt: 1,
        },
        {
          id: 'shell-9', projectId: 'psyche', worktreePath: '/repo/psyche-wt',
          name: 'shell 9', kind: 'shell', status: 'running', needsAttention: true,
        },
        {
          id: 'shell-10', projectId: 'psyche', worktreePath: '/repo/psyche-wt',
          name: 'shell 10', kind: 'shell', status: 'running', lastOutputAt: 9_999,
        },
      ],
      activeProjectId: 'psyche',
      activeThreadId: 'shell-10',
    });

    renderer.render();

    expect(renderer.sessionListEl.getAttribute('role')).toBe('tree');
    expect(renderer.sessionListEl.querySelector('.session-project-head')?.textContent)
      .toContain('PSYCHE-BUILD');
    expect(renderer.sessionListEl.querySelector('.session-project-head')?.textContent)
      .toContain('5');
    const projectHead = renderer.sessionListEl.querySelector('.session-project-head');
    const projectGroup = renderer.sessionListEl.querySelector('.session-project');
    const automaticAccentIds = new Set(PsycheSessions.PROJECT_ACCENTS.map(
      (accent: { id: string }) => accent.id,
    ));
    expect(projectGroup?.classList.contains('is-current')).toBe(true);
    expect(projectGroup?.dataset.projectAppearance).toBe('automatic');
    expect(automaticAccentIds.has(projectGroup?.dataset.projectAccent ?? '')).toBe(true);
    expect(projectHead?.style.getPropertyValue('--project-accent-rgb')).toBe(
      PsycheSessions.PROJECT_ACCENTS.find(
        (accent: { id: string; rgb: string }) => accent.id === projectGroup?.dataset.projectAccent,
      )?.rgb,
    );
    expect(projectHead?.textContent).not.toContain('CURRENT');
    expect(renderer.sessionListEl.querySelector('.session-current-badge')).toBeNull();
    expect(renderer.sessionListEl.querySelector('.session-project-glyph')).toBeNull();
    expect(renderer.sessionListEl.querySelector('.session-branch-head')?.textContent)
      .toContain('feat/web-pane-attention');
    expect(renderer.sessionListEl.querySelector('.session-category-label')?.textContent)
      .toContain('Shells');
    expect(renderer.sessionListEl.querySelector('.session-category-label')?.textContent)
      .toContain('5');
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-title'))).toEqual([
      'shell 10',
      'shell 9',
      'shell 8 · pnpm dev',
      'shell 7',
      'shell 8 · vitest --watch',
    ]);
    expect(renderer.sessionListEl.querySelector('.is-selected')?.textContent)
      .toContain('shell 10');

    const project = renderer.sessionListEl.querySelector('.session-project');
    const branch = renderer.sessionListEl.querySelector('.session-branch');
    const session = renderer.sessionListEl.querySelector('.session-row');
    expect(project?.getAttribute('role')).toBe('treeitem');
    expect(project?.getAttribute('aria-level')).toBe('1');
    expect(project?.getAttribute('aria-expanded')).toBe('true');
    expect(project?.getAttribute('aria-label')).toContain('5 sessions');
    expect(branch?.getAttribute('role')).toBe('treeitem');
    expect(branch?.getAttribute('aria-level')).toBe('2');
    expect(branch?.getAttribute('aria-expanded')).toBe('true');
    expect(branch?.getAttribute('aria-label')).toContain('5 sessions');
    expect(session?.getAttribute('role')).toBe('treeitem');
    expect(session?.getAttribute('aria-level')).toBe('3');
    expect(session?.getAttribute('aria-current')).toBe('true');
    expect(renderer.sessionListEl.querySelectorAll('.session-status-label').map(
      (label) => label.textContent,
    )).toEqual(['ACTIVE', 'REPLY', 'ACTIVE', 'IDLE', 'IDLE']);
    expect(renderer.sessionListEl.querySelector('.session-status')?.getAttribute('aria-label'))
      .toContain('process is alive');
    expect(renderer.sessionListEl.querySelector('.session-project-children')?.getAttribute('role'))
      .toBe('group');
    expect(renderer.sessionListEl.querySelector('.session-branch-children')?.getAttribute('role'))
      .toBe('group');
    expect(renderer.sessionListEl.querySelector('.session-category')?.getAttribute('role'))
      .toBe('none');
    const treeItems = renderer.sessionListEl.querySelectorAll('[data-tree-item]');
    expect(treeItems.filter((item) => item.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(session?.getAttribute('tabindex')).toBe('0');
    expect(renderer.sessionListEl.querySelector('.session-project-head')?.dataset.tooltip)
      .toBe('/repo/psyche-build');
    expect(renderer.document.created.flatMap((element) => element.innerHtmlAssignments))
      .toEqual([]);
  });

  it('renders customized project appearance datasets, accent, and glyph', () => {
    const renderer = createRenderer({
      projects: [{
        id: 'psyche',
        name: 'PSYCHE-BUILD',
        root: '/repo/psyche-build',
        collapsed: false,
        selectedWorktreePath: '/repo/psyche-build',
        worktrees: [{
          path: '/repo/psyche-build',
          branch: 'main',
          is_main: true,
          collapsed: false,
          dirty: false,
          missing: false,
        }],
      }],
      projectAppearances: {
        '/repo/psyche-build': { accent: 'violet', glyph: 'spark' },
      },
      threads: [{
        id: 'shell',
        projectId: 'psyche',
        worktreePath: '/repo/psyche-build',
        name: 'shell',
        kind: 'shell',
        status: 'running',
      }],
      activeProjectId: 'psyche',
    });

    renderer.render();

    const projectGroup = renderer.sessionListEl.querySelector('.session-project');
    const projectHead = renderer.sessionListEl.querySelector('.session-project-head');
    const glyph = renderer.sessionListEl.querySelector('.session-project-glyph');

    expect(projectGroup?.dataset.projectAccent).toBe('violet');
    expect(projectGroup?.dataset.projectAppearance).toBe('custom');
    expect(projectHead?.style.getPropertyValue('--project-accent-rgb')).toBe('145 111 235');
    expect(glyph?.textContent).toBe('✦');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps project header accent styles on slash-alpha rgb syntax', () => {
    const projectHeaderStyles = styles.match(
      /\/\* -------- Project header appearance bands --------[\s\S]*?\.session-project-head \.session-project-count \{[\s\S]*?\n\}/,
    )?.[0] ?? '';

    expect(projectHeaderStyles).toContain(
      'rgb(var(--project-accent-rgb) / var(--project-band-border-alpha, 0.16))',
    );
    expect(projectHeaderStyles.match(/rgb\(var\(--project-accent-rgb\)\s*\/\s*/g) ?? [])
      .toHaveLength(10);
    expect(projectHeaderStyles).not.toContain('rgba(var(--project-accent-rgb),');
  });

  it('renders projects and surfaces deferred appearance load failures', () => {
    const renderer = createRenderer({
      projects: [{
        id: 'alpha',
        name: 'Alpha',
        root: '/alpha',
        collapsed: false,
        selectedWorktreePath: '/alpha',
        worktrees: [{
          path: '/alpha',
          branch: 'main',
          is_main: true,
          collapsed: false,
          dirty: false,
          missing: false,
        }],
      }],
      threads: [{
        id: 'shell',
        projectId: 'alpha',
        worktreePath: '/alpha',
        name: 'shell',
        kind: 'shell',
        status: 'running',
      }],
      activeProjectId: 'alpha',
      localStorageReadError: new Error('storage unavailable'),
    });

    renderer.render();

    const projectGroup = renderer.sessionListEl.querySelector('.session-project');
    const projectHead = renderer.sessionListEl.querySelector('.session-project-head');

    expect(projectGroup).not.toBeNull();
    expect(projectGroup?.dataset.projectAppearance).toBe('automatic');
    expect(projectHead?.textContent).toContain('Alpha');
    expect(renderer.projectAppearances()).toEqual({});
    expect(renderer.statusAlertEl.textContent).toBe(
      'project appearance load failed: Error: storage unavailable',
    );
    expect(renderer.toastEl.textContent).toBe(
      'project appearance load failed: Error: storage unavailable',
    );
    expect(renderer.toastEl.classList.contains('is-visible')).toBe(true);
    expect(renderer.toastEl.getAttribute('aria-hidden')).toBe('true');
    expect(renderer.toastTimeouts).toEqual([6000]);
    expect([
      renderer.statusAlertEl,
      renderer.toastEl,
    ].filter((element) => element.getAttribute('aria-hidden') !== 'true'))
      .toEqual([renderer.statusAlertEl]);
    expect(renderer.setStatus).not.toHaveBeenCalled();
  });

  it('preserves in-memory project appearances and rerenders after save failures', () => {
    const renderer = createRenderer({
      projects: [{
        id: 'alpha',
        name: 'Alpha',
        root: '/alpha',
        collapsed: false,
        selectedWorktreePath: '/alpha',
        worktrees: [{
          path: '/alpha',
          branch: 'main',
          is_main: true,
          collapsed: false,
          dirty: false,
          missing: false,
        }],
      }],
      threads: [{
        id: 'shell',
        projectId: 'alpha',
        worktreePath: '/alpha',
        name: 'shell',
        kind: 'shell',
        status: 'running',
      }],
      localStorageWriteError: new Error('disk full'),
    });

    renderer.render();
    const project = renderer.sessionListEl.querySelector('.session-project');
    project?.focus();

    expect(renderer.applyProjectAppearance(renderer.state.projects[0], { accent: 'violet' })).toBe(true);

    const rerenderedProject = renderer.sessionListEl.querySelector('.session-project');
    const rerenderedHead = renderer.sessionListEl.querySelector('.session-project-head');

    expect(renderer.statusAlertEl.textContent).toBe(
      'project appearance save failed: Error: disk full',
    );
    expect(renderer.toastEl.textContent).toBe(
      'project appearance save failed: Error: disk full',
    );
    expect(renderer.toastEl.classList.contains('is-visible')).toBe(true);
    expect(renderer.toastEl.getAttribute('aria-hidden')).toBe('true');
    expect(renderer.toastTimeouts).toEqual([6000]);
    expect([
      renderer.statusAlertEl,
      renderer.toastEl,
    ].filter((element) => element.getAttribute('aria-hidden') !== 'true'))
      .toEqual([renderer.statusAlertEl]);
    expect(renderer.setStatus).not.toHaveBeenCalled();
    expect(renderer.projectAppearances()).toEqual({
      '/alpha': { accent: 'violet' },
    });
    expect(rerenderedProject?.dataset.projectAccent).toBe('violet');
    expect(rerenderedHead?.style.getPropertyValue('--project-accent-rgb')).toBe('145 111 235');
    expect(renderer.document.activeElement).toBe(rerenderedProject);
  });

  it('opens a project header context menu with customize appearance anchored to the treeitem', async () => {
    const renderer = createRenderer({
      projects: [{
        id: 'psyche',
        name: 'PSYCHE-BUILD',
        root: '/repo/psyche-build',
        collapsed: false,
        selectedWorktreePath: '/repo/psyche-build',
        worktrees: [{
          path: '/repo/psyche-build',
          branch: 'main',
          is_main: true,
          collapsed: false,
          dirty: false,
          missing: false,
        }],
      }],
      threads: [{
        id: 'shell',
        projectId: 'psyche',
        worktreePath: '/repo/psyche-build',
        name: 'shell',
        kind: 'shell',
        status: 'running',
      }],
    });

    renderer.render();
    const projectHead = renderer.sessionListEl.querySelector('.session-project-head');
    const projectTreeitem = renderer.sessionListEl.querySelector('.session-project');
    const sessionTreeitem = renderer.sessionListEl.querySelector('.session-row');

    sessionTreeitem?.focus();
    renderer.handleTreeKeydown(new FakeEvent(sessionTreeitem!, 'a'));
    expect(renderer.sessionTreeFocusKey()).toBe(sessionTreeitem?.dataset.treeKey);

    await projectHead?.emit('contextmenu', {
      target: projectHead ?? undefined,
      clientX: 160,
      clientY: 48,
    });

    expect(projectTreeitem?.dataset.projectId).toBe('psyche');
    expect(renderer.openSessionContextMenu).toHaveBeenCalledTimes(1);
    const [, actions, anchor] = renderer.openSessionContextMenu.mock.calls[0];
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ label: 'Customize appearance' });
    expect(anchor).toBe(projectTreeitem);
    expect(renderer.sessionTreeFocusKey()).toBe(projectTreeitem?.dataset.treeKey);

    actions[0].run();
    expect(renderer.openProjectAppearancePopover).toHaveBeenCalledWith(
      renderer.state.projects[0],
      projectTreeitem,
    );
  });

  it('renders daemon-backed Coven sessions inside Agents with Coven metadata', () => {
    const renderer = createRenderer({
      projects: [{
        id: 'coven-cave',
        name: 'COVEN-CAVE',
        root: '/repo/coven-cave',
        collapsed: false,
        selectedWorktreePath: '/repo/coven-cave',
        worktrees: [{
          path: '/repo/coven-cave', branch: 'main',
          is_main: true,
          collapsed: false, dirty: false, missing: false,
        }],
      }],
      sessions: [{
        id: 'coven-1', projectRoot: '/repo/coven-cave',
        cwd: '/repo/coven-cave', title: 'Agent Coven',
        harness: 'codex', status: 'running',
        labels: ['source:psyche-build'],
      }],
    });

    renderer.render();

    expect(renderer.sessionListEl.querySelector('.session-category-label')?.textContent)
      .toContain('Agents');
    expect(renderer.sessionListEl.querySelector('.session-title')?.textContent)
      .toBe('Agent Coven');
    expect(renderer.sessionListEl.querySelector('.session-meta')?.textContent)
      .toContain('Coven');
    expect(renderer.sessionListEl.querySelector('.session-meta')?.textContent)
      .toContain('codex');
    expect(renderer.sessionListEl.querySelector('.session-status')?.textContent)
      .toContain('BUSY');
    // The session above renders, but as a unified row: the point of this
    // assertion is that the retired bespoke builder produced nothing, so it
    // deliberately queries the legacy class rather than covenRows().
    expect(renderer.sessionListEl.querySelectorAll('.session-coven-row')).toHaveLength(0);
    expect(covenRows(renderer.sessionListEl)).toHaveLength(1);
  });

  it('renders a structurally owned project, branch, category, and session tree', () => {
    const renderer = createRenderer({
      threads: [{
        id: 'local',
        projectId: 'alpha',
        name: 'Local',
        kind: 'shell',
        status: 'running',
        worktreePath: '/alpha',
      }],
      sessions: [{
        id: 'daemon',
        projectRoot: '/alpha',
        cwd: '/alpha',
        title: 'Daemon',
        status: 'waiting',
        labels: ['source:psyche-build'],
      }],
    });

    renderer.render();

    const projectItems = renderer.sessionListEl.children.filter(
      (child) => child.getAttribute('role') === 'treeitem',
    );
    expect(projectItems).toHaveLength(1);
    expect(projectItems[0].dataset.treeItem).toBe('project');

    const projectGroups = projectItems[0].children.filter(
      (child) => child.getAttribute('role') === 'group',
    );
    expect(projectGroups).toHaveLength(1);
    const branchItems = projectGroups[0].children.filter(
      (child) => child.getAttribute('role') === 'treeitem',
    );
    expect(branchItems).toHaveLength(1);
    expect(branchItems[0].dataset.treeItem).toBe('branch');

    const branchGroups = branchItems[0].children.filter(
      (child) => child.getAttribute('role') === 'group',
    );
    expect(branchGroups).toHaveLength(1);
    expect(branchGroups[0].children.length).toBeGreaterThan(0);
    expect(branchGroups[0].children.every(
      (child) => child.getAttribute('role') === 'none'
        && child.classList.contains('session-category'),
    )).toBe(true);

    const sessionItems = descendants(branchGroups[0]).filter(
      (child) => child.getAttribute('role') === 'treeitem',
    );
    expect(sessionItems).toHaveLength(2);
    expect(sessionItems.every(
      (item) => item.dataset.treeItem === 'session'
        && item.getAttribute('aria-level') === '3'
        && item.tagName !== 'BUTTON',
    )).toBe(true);

    const localSession = sessionItems.find((item) => item.dataset.threadId === 'local');
    const close = localSession?.querySelector('.session-close');
    expect(close?.tagName).toBe('BUTTON');
    expect(close?.parentNode).toBe(localSession);
    expect(branchGroups[0].children).not.toContain(close);
  });

  it('persists project and branch disclosure state', async () => {
    const renderer = createRenderer({
      projects: [{
        id: 'psyche',
        name: 'PSYCHE-BUILD',
        root: '/repo/psyche-build',
        collapsed: false,
        selectedWorktreePath: '/repo/psyche-wt',
        worktrees: [{
          path: '/repo/psyche-wt',
          branch: 'feat/tree',
          is_main: false,
          collapsed: false,
          dirty: false,
          missing: false,
        }],
      }],
      threads: [{
        id: 'shell', projectId: 'psyche', worktreePath: '/repo/psyche-wt',
        name: 'shell', kind: 'shell', status: 'running',
      }],
    });

    renderer.render();
    const disclosures = renderer.sessionListEl.querySelectorAll('.session-disclosure');
    await disclosures[1].emit('click');
    expect(renderer.state.projects[0].worktrees?.[0].collapsed).toBe(true);
    expect(renderer.sessionListEl.querySelector('.session-branch')?.getAttribute('aria-expanded'))
      .toBe('false');

    await renderer.sessionListEl.querySelector('.session-disclosure')?.emit('click');
    expect(renderer.state.projects[0].collapsed).toBe(true);
    expect(renderer.sessionListEl.querySelector('.session-project')?.getAttribute('aria-expanded'))
      .toBe('false');
    expect(renderer.saveWorkspaceSoon).toHaveBeenCalledTimes(2);
  });

  it('activates focused project treeitems on Enter and toggles them on Space', async () => {
    const renderer = createRenderer({
      projects: [{
        id: 'psyche',
        name: 'PSYCHE-BUILD',
        root: '/repo/psyche-build',
        collapsed: false,
        selectedWorktreePath: '/repo/psyche-wt',
        worktrees: [{
          path: '/repo/psyche-wt',
          branch: 'feat/tree',
          is_main: false,
          collapsed: false,
          dirty: false,
          missing: false,
        }],
      }],
      threads: [{
        id: 'shell',
        projectId: 'psyche',
        worktreePath: '/repo/psyche-wt',
        name: 'shell',
        kind: 'shell',
        status: 'running',
      }],
    });

    renderer.render();
    const project = renderer.sessionListEl.querySelector('.session-project');
    expect(project).not.toBeNull();

    project?.focus();
    const enter = new FakeEvent(project!, 'Enter');
    renderer.handleTreeKeydown(enter);
    await Promise.resolve();
    const currentProject = renderer.sessionListEl.querySelector('.session-project');
    currentProject?.focus();
    const space = new FakeEvent(currentProject!, ' ');
    renderer.handleTreeKeydown(space);

    expect(enter?.defaultPrevented).toBe(true);
    expect(space?.defaultPrevented).toBe(true);
    expect(renderer.clearFocusSet).toHaveBeenCalledOnce();
    expect(renderer.setActiveProject).toHaveBeenCalledOnce();
    expect(renderer.setActiveProject).toHaveBeenCalledWith('psyche');
    expect(renderer.state.projects[0].collapsed).toBe(true);
    expect(renderer.saveWorkspaceSoon).toHaveBeenCalledOnce();
  });

  it('opens focused project treeitem context menus from keyboard shortcuts', () => {
    const renderer = createRenderer({
      projects: [{
        id: 'psyche',
        name: 'PSYCHE-BUILD',
        root: '/repo/psyche-build',
        collapsed: false,
        selectedWorktreePath: '/repo/psyche-build',
        worktrees: [{
          path: '/repo/psyche-build',
          branch: 'main',
          is_main: true,
          collapsed: false,
          dirty: false,
          missing: false,
        }],
      }],
      threads: [{
        id: 'shell',
        projectId: 'psyche',
        worktreePath: '/repo/psyche-build',
        name: 'shell',
        kind: 'shell',
        status: 'running',
      }],
    });

    renderer.render();
    const project = renderer.sessionListEl.querySelector('.session-project');
    expect(project).not.toBeNull();

    project?.focus();
    const contextMenu = new FakeEvent(project!, 'ContextMenu');
    renderer.handleTreeKeydown(contextMenu);

    expect(contextMenu.defaultPrevented).toBe(true);
    expect(contextMenu.propagationStopped).toBe(true);
    expect(renderer.openSessionContextMenu).toHaveBeenCalledTimes(1);
    expect(renderer.openSessionContextMenu.mock.calls[0][2]).toBe(project);
    expect(renderer.openSessionContextMenu.mock.calls[0][1][0]).toMatchObject({
      label: 'Customize appearance',
    });

    renderer.openSessionContextMenu.mockClear();
    const shiftF10 = new FakeEvent(project!, 'F10', { shiftKey: true });
    renderer.handleTreeKeydown(shiftF10);

    expect(shiftF10.defaultPrevented).toBe(true);
    expect(shiftF10.propagationStopped).toBe(true);
    expect(renderer.openSessionContextMenu).toHaveBeenCalledTimes(1);
    expect(renderer.openSessionContextMenu.mock.calls[0][2]).toBe(project);
    expect(renderer.openSessionContextMenu.mock.calls[0][1][0]).toMatchObject({
      label: 'Customize appearance',
    });
  });

  it('restores the project treeitem when a keyboard-opened context menu closes', () => {
    const harness = createSessionContextMenuHarness();

    harness.project.focus();
    const contextMenu = new FakeEvent(harness.project, 'ContextMenu');
    harness.handleTreeKeydown(contextMenu);

    expect(contextMenu.defaultPrevented).toBe(true);
    expect(contextMenu.propagationStopped).toBe(true);
    expect(harness.sessionTreeFocusKey()).toBe(harness.project.dataset.treeKey);

    const menu = harness.sessionContextMenu();
    const firstItem = menu?.querySelector('button');
    expect(firstItem).not.toBeNull();
    expect(harness.document.activeElement).toBe(firstItem);

    harness.closeSessionContextMenu();

    expect(harness.document.activeElement).toBe(harness.project);
    expect(harness.project.focused).toBe(true);
  });

  it('activates focused branch treeitems on Enter and toggles them on Space', async () => {
    const renderer = createRenderer({
      projects: [{
        id: 'psyche',
        name: 'PSYCHE-BUILD',
        root: '/repo/psyche-build',
        collapsed: false,
        selectedWorktreePath: '/repo/psyche-wt',
        worktrees: [{
          path: '/repo/psyche-wt',
          branch: 'feat/tree',
          is_main: false,
          collapsed: false,
          dirty: false,
          missing: false,
        }],
      }],
      threads: [{
        id: 'shell',
        projectId: 'psyche',
        worktreePath: '/repo/psyche-wt',
        name: 'shell',
        kind: 'shell',
        status: 'running',
      }],
    });

    renderer.render();
    const branch = renderer.sessionListEl.querySelector('.session-branch');
    expect(branch).not.toBeNull();

    branch?.focus();
    const enter = new FakeEvent(branch!, 'Enter');
    renderer.handleTreeKeydown(enter);
    await Promise.resolve();
    expect(enter?.defaultPrevented).toBe(true);
    expect(renderer.state.projects[0].worktrees?.[0].collapsed).toBe(false);
    expect(renderer.setActiveProject).toHaveBeenCalledWith('psyche');
    expect(renderer.saveWorkspaceSoon).not.toHaveBeenCalled();

    branch?.focus();
    const space = new FakeEvent(branch!, ' ');
    renderer.handleTreeKeydown(space);
    expect(space?.defaultPrevented).toBe(true);
    expect(renderer.state.projects[0].worktrees?.[0].collapsed).toBe(true);
    expect(renderer.sessionListEl.querySelector('.session-branch')?.getAttribute('aria-expanded'))
      .toBe('false');
    expect(renderer.saveWorkspaceSoon).toHaveBeenCalledOnce();
  });

  it('activates branch heads by pointer while disclosures only toggle', async () => {
    const renderer = createRenderer({
      projects: [{
        id: 'psyche',
        name: 'PSYCHE-BUILD',
        root: '/repo/psyche-build',
        collapsed: false,
        selectedWorktreePath: '/repo/psyche-wt',
        worktrees: [{
          path: '/repo/psyche-wt',
          branch: 'feat/tree',
          is_main: false,
          collapsed: false,
          dirty: false,
          missing: false,
        }],
      }],
      threads: [{
        id: 'shell',
        projectId: 'psyche',
        worktreePath: '/repo/psyche-wt',
        name: 'shell',
        kind: 'shell',
        status: 'running',
      }],
    });
    renderer.render();
    const branch = renderer.sessionListEl.querySelector('.session-branch');
    const head = renderer.sessionListEl.querySelector('.session-branch-head');
    const disclosure = renderer.sessionListEl.querySelectorAll('.session-disclosure')[1];

    await branch?.emit('click', { target: head ?? undefined });
    expect(renderer.activateProjectWorktree).toHaveBeenCalledWith(
      renderer.state.projects[0],
      '/repo/psyche-wt',
    );
    expect(renderer.state.projects[0].worktrees?.[0].collapsed).toBe(false);

    renderer.activateProjectWorktree.mockClear();
    await disclosure.emit('click');
    expect(renderer.activateProjectWorktree).not.toHaveBeenCalled();
    expect(renderer.state.projects[0].worktrees?.[0].collapsed).toBe(true);
  });

  it('collapses and expands focused project and branch treeitems with horizontal arrows', async () => {
    const renderer = createRenderer({
      projects: [{
        id: 'psyche',
        name: 'PSYCHE-BUILD',
        root: '/repo/psyche-build',
        collapsed: false,
        selectedWorktreePath: '/repo/psyche-wt',
        worktrees: [{
          path: '/repo/psyche-wt',
          branch: 'feat/tree',
          is_main: false,
          collapsed: false,
          dirty: false,
          missing: false,
        }],
      }],
      threads: [{
        id: 'shell',
        projectId: 'psyche',
        worktreePath: '/repo/psyche-wt',
        name: 'shell',
        kind: 'shell',
        status: 'running',
      }],
    });

    renderer.render();
    const branch = renderer.sessionListEl.querySelector('.session-branch');
    branch?.focus();
    const branchLeft = new FakeEvent(branch!, 'ArrowLeft');
    renderer.handleTreeKeydown(branchLeft);
    expect(branchLeft?.defaultPrevented).toBe(true);
    expect(renderer.state.projects[0].worktrees?.[0].collapsed).toBe(true);

    renderer.sessionListEl.querySelector('.session-branch')?.focus();
    const rerenderedBranch = renderer.sessionListEl.querySelector('.session-branch');
    const branchRight = new FakeEvent(rerenderedBranch!, 'ArrowRight');
    renderer.handleTreeKeydown(branchRight);
    expect(branchRight?.defaultPrevented).toBe(true);
    expect(renderer.state.projects[0].worktrees?.[0].collapsed).toBe(false);

    const project = renderer.sessionListEl.querySelector('.session-project');
    project?.focus();
    const projectLeft = new FakeEvent(project!, 'ArrowLeft');
    renderer.handleTreeKeydown(projectLeft);
    expect(projectLeft?.defaultPrevented).toBe(true);
    expect(renderer.state.projects[0].collapsed).toBe(true);

    const rerenderedProject = renderer.sessionListEl.querySelector('.session-project');
    rerenderedProject?.focus();
    const projectRight = new FakeEvent(rerenderedProject!, 'ArrowRight');
    renderer.handleTreeKeydown(projectRight);
    expect(projectRight?.defaultPrevented).toBe(true);
    expect(renderer.state.projects[0].collapsed).toBe(false);
    expect(renderer.saveWorkspaceSoon).toHaveBeenCalledTimes(4);
  });

  it('keeps saved collapse state while composer search leaves the sidebar tree unchanged', () => {
    const renderer = createRenderer({
      projects: [{
        id: 'psyche',
        name: 'PSYCHE-BUILD',
        root: '/repo/psyche-build',
        collapsed: true,
        selectedWorktreePath: '/repo/psyche-wt',
        worktrees: [{
          path: '/repo/psyche-wt',
          branch: 'feat/tree',
          is_main: false,
          collapsed: true,
          dirty: false,
          missing: false,
        }],
      }],
      threads: [{
        id: 'shell',
        projectId: 'psyche',
        worktreePath: '/repo/psyche-wt',
        name: 'matching shell',
        kind: 'shell',
        status: 'running',
      }],
      composerQuery: '? matching',
    });

    renderer.render();
    const project = renderer.sessionListEl.querySelector('.session-project');
    const branch = renderer.sessionListEl.querySelector('.session-branch');
    const disclosures = renderer.sessionListEl.querySelectorAll('.session-disclosure');
    expect(renderer.composerInputEl.value).toBe('? matching');
    expect(project?.getAttribute('aria-expanded')).toBe('false');
    expect(branch).toBeNull();
    expect(project?.getAttribute('aria-label')).not.toContain('temporarily expanded for search');
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0].getAttribute('aria-label')).toContain('Expand');
    expect(renderer.state.projects[0].collapsed).toBe(true);
    expect(renderer.state.projects[0].worktrees?.[0].collapsed).toBe(true);
    expect(renderer.saveWorkspaceSoon).not.toHaveBeenCalled();
  });

  it('ignores descendant horizontal arrows on project and branch treeitems', async () => {
    const renderer = createRenderer({
      projects: [{
        id: 'psyche',
        name: 'PSYCHE-BUILD',
        root: '/repo/psyche-build',
        collapsed: false,
        selectedWorktreePath: '/repo/psyche-wt',
        worktrees: [{
          path: '/repo/psyche-wt',
          branch: 'feat/tree',
          is_main: false,
          collapsed: false,
          dirty: false,
          missing: false,
        }],
      }],
      threads: [{
        id: 'shell',
        projectId: 'psyche',
        worktreePath: '/repo/psyche-wt',
        name: 'shell',
        kind: 'shell',
        status: 'running',
      }],
    });

    renderer.render();
    const project = renderer.sessionListEl.querySelector('.session-project');
    const branch = renderer.sessionListEl.querySelector('.session-branch');
    const session = renderer.sessionListEl.querySelector('.session-row');
    const category = renderer.sessionListEl.querySelector('.session-category');
    expect(project).not.toBeNull();
    expect(branch).not.toBeNull();
    expect(session).not.toBeNull();
    expect(category).not.toBeNull();

    session?.focus();
    const projectLeft = await project?.emit('keydown', {
      target: session ?? undefined,
      key: 'ArrowLeft',
    });
    expect(projectLeft?.defaultPrevented).toBe(false);
    expect(renderer.state.projects[0].collapsed).toBe(false);

    const left = await branch?.emit('keydown', { target: session ?? undefined, key: 'ArrowLeft' });
    expect(left?.defaultPrevented).toBe(false);
    expect(renderer.state.projects[0].worktrees?.[0].collapsed).toBe(false);

    const right = await branch?.emit('keydown', {
      target: category ?? undefined,
      key: 'ArrowRight',
    });
    expect(right?.defaultPrevented).toBe(false);
    expect(renderer.state.projects[0].collapsed).toBe(false);
    expect(renderer.state.projects[0].worktrees?.[0].collapsed).toBe(false);
    expect(renderer.saveWorkspaceSoon).not.toHaveBeenCalled();
  });

  it('ships a non-modal project appearance popover contract with fixed presets', () => {
    const popoverSource = extractFunctionSource(mainJs, 'openProjectAppearancePopover');

    expect(mainJs).toContain('function closeProjectAppearancePopover(');
    expect(popoverSource).toContain('project-appearance-popover');
    expect(popoverSource).toContain('setAttribute("role", "dialog")');
    expect(popoverSource).toContain('project.name');
    expect(popoverSource).toContain('PsycheSessions.PROJECT_ACCENTS.forEach');
    expect(popoverSource).toContain('PsycheSessions.PROJECT_GLYPHS.forEach');
    expect(popoverSource).toContain('aria-pressed');
    expect(popoverSource).toContain('Reset to automatic');
    expect(popoverSource).toContain('No glyph');
    expect(popoverSource).not.toMatch(/type\s*=\s*["']color["']/);
    expect(styles).toContain('.project-appearance-popover {');
    expect(styles).toContain('.project-appearance-accent-grid {');
    expect(styles).toContain('.project-appearance-glyph-grid {');
    expect(styles).toContain('.project-appearance-choice[aria-pressed="true"]');
  });

  it('restores the project treeitem when rerender closes the project appearance popover', () => {
    const renderer = createRenderer({
      projects: [{
        id: 'psyche',
        name: 'PSYCHE-BUILD',
        root: '/repo/psyche-build',
        collapsed: false,
        selectedWorktreePath: '/repo/psyche-build',
        worktrees: [{
          path: '/repo/psyche-build',
          branch: 'main',
          is_main: true,
          collapsed: false,
          dirty: false,
          missing: false,
        }],
      }],
      threads: [{
        id: 'shell',
        projectId: 'psyche',
        worktreePath: '/repo/psyche-build',
        name: 'shell',
        kind: 'shell',
        status: 'running',
      }],
    });

    renderer.render();
    const project = renderer.sessionListEl.querySelector('.session-project');
    expect(project).not.toBeNull();

    const popover = new FakeElement('div', renderer.document);
    const choice = new FakeElement('button', renderer.document);
    popover.appendChild(choice);
    renderer.document.body.appendChild(popover);
    choice.focus();
    renderer.setProjectAppearancePopover(popover, project?.dataset.treeKey);

    renderer.render();

    const rerenderedProject = renderer.sessionListEl.querySelector('.session-project');
    expect(renderer.document.activeElement).toBe(rerenderedProject);
    expect(rerenderedProject?.dataset.treeKey).toBe(project?.dataset.treeKey);
  });

  // Fixtures arrived with main's worktree-ownership tests further down, which
  // still use them. They are hoisted above the shared test below because they
  // are describe-scoped consts, not part of any one test body.
  const ownedWorktreeSession = {
    id: 'owned-worktree-session',
    projectRoot: '/repo/.worktrees/task',
    title: 'Owned worktree session',
    status: 'running',
    labels: ['source:psyche-build'],
  };
  const parentProject: Project = {
    id: 'parent',
    name: 'Parent',
    root: '/repo',
    worktrees: [{
      path: '/repo/.worktrees/task',
      branch: 'task',
      is_main: false,
      dirty: false,
      missing: false,
    }],
  };
  const taskProject: Project = {
    id: 'task',
    name: 'Task',
    root: '/repo/.worktrees/task',
    worktrees: [{
      path: '/repo/.worktrees/task',
      branch: 'task',
      is_main: true,
      dirty: false,
      missing: false,
    }],
  };

  // Both sides opened the same test body with different names. The body asserts
  // one 'Agents' category holding both rows, so this branch's "unified" wording
  // is the accurate one — main's "distinct subsections" describes the layout
  // this branch replaced.
  it('renders local and daemon sessions as unified agent rows with distinct identities', () => {
    const renderer = createRenderer({
      threads: [{
        id: 'attached',
        projectId: 'alpha',
        name: 'Attached locally',
        status: 'running',
        kind: 'coven-attach',
        launch: { launchKind: 'coven-attach', covenSessionId: 'remote' },
        worktreePath: '/alpha',
      }],
      sessions: [{
        id: 'remote',
        projectRoot: '/alpha',
        title: 'Durable session',
        status: 'waiting',
        labels: ['source:psyche-build'],
      }],
    });

    renderer.render();
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-category-name')))
      .toEqual(['Agents']);
    const rows = renderer.sessionListEl.querySelectorAll('.session-row');
    expect(rows.map((row) => row.dataset.threadId ?? row.dataset.sessionId))
      .toEqual(['remote', 'attached']);
    expect(rows[0].title).toContain('Focus attachment');
    expect(rows[0].querySelector('.session-status-label')?.textContent).toBe('REPLY');
  });

  it('renders only the one Psyche-owned active Coven row among noisy same-project records', () => {
    const renderer = createRenderer({
      threads: [
        { id: 'local-agent', projectId: 'alpha', name: 'Local agent', status: 'running' },
        {
          id: 'local-shell', projectId: 'alpha', name: 'Local shell', status: 'running',
          kind: 'shell',
        },
      ],
      sessions: [
        ...['completed', 'failed', 'killed', 'orphaned', 'archived'].map((status) => ({
          id: `inactive-${status}`, projectRoot: '/alpha', status,
          labels: ['source:psyche-build'],
        })),
        { id: 'foreign', projectRoot: '/alpha', status: 'running', labels: ['source:foreign'] },
        { id: 'unlabeled', projectRoot: '/alpha', status: 'waiting' },
        {
          id: 'visible', projectRoot: '/alpha', title: 'Visible Coven session', status: 'running',
          labels: ['source:psyche-build'],
        },
      ],
    });

    renderer.render();

    expect(covenRows(renderer.sessionListEl)).toHaveLength(1);
    expect(covenRows(renderer.sessionListEl)[0]?.dataset.sessionId)
      .toBe('visible');
    expect(localRows(renderer.sessionListEl).map((row) => row.dataset.threadId))
      .toEqual(['local-agent', 'local-shell']);
  });

  it('deduplicates the project root from its hydrated main worktree', () => {
    const renderer = createRenderer({
      projects: [{
        id: 'alpha', name: 'Alpha', root: '/alpha',
        worktrees: [{
          path: '/alpha', branch: 'main', is_main: true, dirty: false, missing: false,
        }],
      }],
      sessions: [{
        id: 'remote', projectRoot: '/alpha', status: 'waiting', labels: ['source:psyche-build'],
      }],
    });

    renderer.render();
    expect(renderer.sessionListEl.querySelectorAll('.session-row')
      .filter((row) => Boolean(row.dataset.sessionId))).toHaveLength(1);
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-attention-badge')))
      .toEqual(['!1', '!1']);
    expect(renderer.sessionListEl.querySelector('.session-status-label')?.textContent)
      .toBe('REPLY');
  });

  it.each([
    [parentProject, taskProject],
    [taskProject, parentProject],
  ])('assigns an overlapping worktree session to its exact saved project regardless of project order',
    (...projects) => {
      const renderer = createRenderer({ projects, sessions: [ownedWorktreeSession] });

      renderer.render();

      expect(covenRows(renderer.sessionListEl)).toHaveLength(1);
      expect(covenRows(renderer.sessionListEl)[0]?.dataset.sessionId)
        .toBe('owned-worktree-session');
      expect(projectNamesWithRows(renderer.sessionListEl))
        .toEqual(['Task']);
    });

  it('keeps a worktree session under its parent when only the parent project is saved', () => {
    const renderer = createRenderer({
      projects: [parentProject],
      sessions: [ownedWorktreeSession],
    });

    renderer.render();

    expect(covenRows(renderer.sessionListEl)).toHaveLength(1);
    expect(covenRows(renderer.sessionListEl)[0]?.dataset.sessionId)
      .toBe('owned-worktree-session');
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-project-name')))
      .toEqual(['Parent']);
  });

  it.each([
    [
      { ...ownedWorktreeSession, projectRoot: '/unowned' },
      ownedWorktreeSession,
    ],
    [
      ownedWorktreeSession,
      { ...ownedWorktreeSession, projectRoot: '/unowned' },
    ],
  ])('selects an owned occurrence when duplicate session IDs span discovery buckets',
    (...sessions) => {
      const renderer = createRenderer({ projects: [taskProject], sessions });

      renderer.render();

      expect(covenRows(renderer.sessionListEl)).toHaveLength(1);
      expect(covenRows(renderer.sessionListEl)[0]?.dataset.sessionId)
        .toBe('owned-worktree-session');
      expect(textOf(renderer.sessionListEl.querySelectorAll('.session-project-name')))
        .toEqual(['Task']);
    });

  it.each([
    [
      { ...ownedWorktreeSession, projectRoot: '/verylong' },
      { ...ownedWorktreeSession, projectRoot: '/a/b' },
    ],
    [
      { ...ownedWorktreeSession, projectRoot: '/a/b' },
      { ...ownedWorktreeSession, projectRoot: '/verylong' },
    ],
  ])('selects the deeper exact-root owner for duplicate session IDs regardless of bucket order',
    (...sessions) => {
      const renderer = createRenderer({
        projects: [
          { id: 'long', name: 'Long', root: '/verylong' },
          { id: 'deep', name: 'Deep', root: '/a/b' },
        ],
        sessions,
      });

      renderer.render();

      expect(covenRows(renderer.sessionListEl)).toHaveLength(1);
      expect(projectNamesWithRows(renderer.sessionListEl))
        .toEqual(['Deep']);
    });

  it.each(['missing', 'prunable', 'bare'] as const)(
    'does not assign a session to a parent through a %s worktree',
    (flag) => {
      const renderer = createRenderer({
        projects: [{
          ...parentProject,
          worktrees: [{ ...parentProject.worktrees![0], [flag]: true }],
        }],
        sessions: [ownedWorktreeSession],
      });

      renderer.render();

      expect(covenRows(renderer.sessionListEl)).toHaveLength(0);
      expect(renderer.sessionListEl.querySelectorAll('.session-group-head')).toHaveLength(1);
      expect(textOf(renderer.sessionListEl.querySelectorAll('.session-project-name')))
        .toEqual(['Parent']);
    },
  );

  it.each([
    { id: 'empty-root', name: 'Empty root', root: '' },
    { id: 'missing-root', name: 'Missing root' } as Project,
  ])('does not assign a listed worktree to a project without a usable root', (project) => {
    const renderer = createRenderer({
      projects: [{ ...project, worktrees: parentProject.worktrees }],
      sessions: [ownedWorktreeSession],
    });

    renderer.render();

    expect(covenRows(renderer.sessionListEl)).toHaveLength(0);
    expect(renderer.sessionListEl.querySelectorAll('.session-group-head')).toHaveLength(1);
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-project-name')))
      .toEqual([project.name]);
  });

  it('keeps exact-root ownership even when the matching project worktree is flagged', () => {
    const renderer = createRenderer({
      projects: [{
        ...taskProject,
        worktrees: [{ ...taskProject.worktrees![0], missing: true, prunable: true, bare: true }],
      }],
      sessions: [ownedWorktreeSession],
    });

    renderer.render();

    expect(covenRows(renderer.sessionListEl)).toHaveLength(1);
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-project-name')))
      .toEqual(['Task']);
  });

  it('uses path-component depth when same-rank parents list one worktree', () => {
    const renderer = createRenderer({
      projects: [
        { ...parentProject, id: 'long', name: 'Long', root: '/verylong' },
        { ...parentProject, id: 'deep', name: 'Deep', root: '/a/b' },
      ],
      sessions: [ownedWorktreeSession],
    });

    renderer.render();

    expect(covenRows(renderer.sessionListEl)).toHaveLength(1);
    expect(projectNamesWithRows(renderer.sessionListEl))
      .toEqual(['Deep']);
  });

  it.each([
    [
      { ...parentProject, id: 'shallow', name: 'Shallow' },
      {
        ...parentProject,
        id: 'deep',
        name: 'Deep',
        root: '/repo/nested',
      },
      'Deep',
    ],
    [
      { ...parentProject, id: 'z-parent', name: 'Lexical Z', root: '/same/a' },
      { ...parentProject, id: 'a-parent', name: 'Lexical A', root: '/same/b' },
      'Lexical A',
    ],
  ])('breaks same-rank ownership ties deterministically', (first, second, expectedOwner) => {
    [
      [first, second],
      [second, first],
    ].forEach((projects) => {
      const renderer = createRenderer({ projects, sessions: [ownedWorktreeSession] });

      renderer.render();

      expect(covenRows(renderer.sessionListEl)).toHaveLength(1);
      expect(projectNamesWithRows(renderer.sessionListEl))
        .toEqual([expectedOwner]);
    });
  });

  it('labels unattached daemon rows and opens their distinct Coven identity', async () => {
    const renderer = createRenderer({
      sessions: [{
        id: 'remote', projectRoot: '/alpha', title: 'Durable session', status: 'running',
        labels: ['source:psyche-build'],
      }],
    });

    renderer.render();
    const row = renderer.sessionListEl.querySelectorAll('.session-row')
      .find((candidate) => candidate.dataset.sessionId === 'remote');
    expect(row?.title).toContain('Attach');
    await row?.emit('click');
    expect(renderer.settings.selectedSessionKey).toBe('coven:remote');
    expect(renderer.saveSettings).toHaveBeenCalled();
    expect(renderer.openCovenSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'alpha' }),
      expect.objectContaining({ id: 'remote' }),
    );
    expect(mainJs).not.toContain('function createCovenSessionRow(');
  });

  it('keeps stale rows visible with one discovery status line', () => {
    const renderer = createRenderer({
      sessions: [{
        id: 'remote', projectRoot: '/alpha', title: 'Remote', status: 'running',
        labels: ['source:psyche-build'],
      }],
      phase: 'unavailable',
      message: 'Daemon offline',
      stale: true,
    });

    renderer.render();
    expect(renderer.sessionListEl.querySelectorAll('.session-row')
      .some((row) => row.dataset.sessionId === 'remote')).toBe(true);
    expect(renderer.sessionListEl.querySelectorAll('.session-inline-state')).toHaveLength(1);
    expect(renderer.sessionListEl.querySelector('.session-inline-state')?.textContent)
      .toContain('Daemon offline');
    expect(renderer.sessionListEl.querySelector('.session-inline-state')?.className)
      .toContain('coven-tone-warn');
  });

  it('renders one global loading state across empty projects while keeping project headers', () => {
    const renderer = createRenderer({
      projects: [
        { id: 'alpha', name: 'Alpha', root: '/alpha' },
        { id: 'beta', name: 'Beta', root: '/beta' },
      ],
      phase: 'loading',
    });

    renderer.render();
    expect(renderer.sessionListEl.querySelectorAll('.session-inline-state')).toHaveLength(1);
    expect(renderer.sessionListEl.querySelector('.session-inline-state')?.textContent)
      .toBe('Loading Coven sessions');
    expect(renderer.sessionListEl.querySelectorAll('.session-group')).toHaveLength(2);
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-project-name')))
      .toEqual(['Alpha', 'Beta']);
    expect(renderer.sessionListEl.querySelectorAll('.session-row')).toHaveLength(0);
    expect(renderer.sessionListEl.querySelector('.session-empty')).toBeNull();
  });

  it('drops exited threads from the rail while keeping failed ones visible', () => {
    const renderer = createRenderer({
      projects: [{ id: 'alpha', name: 'Alpha', root: '/alpha' }],
      threads: [
        { id: 'live', projectId: 'alpha', name: 'Still running', status: 'running' },
        { id: 'starting', projectId: 'alpha', name: 'Booting', status: 'starting' },
        { id: 'crashed', projectId: 'alpha', name: 'Crashed', status: 'failed' },
        { id: 'done', projectId: 'alpha', name: 'Finished', status: 'exited' },
      ],
    });

    renderer.render();

    expect(renderer.sessionListEl.querySelectorAll('.session-row').map((row) => row.dataset.threadId))
      .toEqual(['starting', 'live', 'crashed']);
    expect(renderer.sessionListEl.textContent).not.toContain('Finished');
  });

  it('drops a project group whose threads have all exited', () => {
    const renderer = createRenderer({
      projects: [{ id: 'alpha', name: 'Alpha', root: '/alpha' }],
      threads: [{ id: 'done', projectId: 'alpha', name: 'Finished', status: 'exited' }],
    });

    renderer.render();

    expect(renderer.sessionListEl.querySelector('.session-row')).toBeNull();
  });

  it('groups local threads by pane kind, in input order, while keeping zero-session project headers', () => {
    const renderer = createRenderer({
      projects: [
        { id: 'alpha', name: 'Alpha', root: '/alpha' },
        { id: 'beta', name: 'Beta', root: '/beta' },
      ],
      threads: [
        { id: 'local', projectId: 'alpha', name: 'Local plan', status: 'running' },
        {
          id: 'attached', projectId: 'alpha', name: 'Existing attachment', status: 'running',
          kind: 'coven-attach',
          launch: { launchKind: 'coven-attach', covenSessionId: 'alpha-daemon' },
        },
      ],
    });

    renderer.render();

    const groups = renderer.sessionListEl.querySelectorAll('.session-group');
    expect(groups).toHaveLength(2);
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-project-name')))
      .toEqual(['Alpha', 'Beta']);
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-category-name')))
      .toEqual(['Agents', 'Shells']);
    const populated = groups.find((group) => group.querySelector('.session-row'));
    expect(populated?.querySelectorAll('.session-row').map((row) => row.dataset.threadId))
      .toEqual(['attached', 'local']);
  });

  it('renders one global error across empty projects while keeping project headers', () => {
    const renderer = createRenderer({
      projects: [
        { id: 'alpha', name: 'Alpha', root: '/alpha' },
        { id: 'beta', name: 'Beta', root: '/beta' },
      ],
      phase: 'error',
      message: 'Discovery failed',
    });

    renderer.render();
    expect(renderer.sessionListEl.querySelectorAll('.session-inline-state')).toHaveLength(1);
    expect(renderer.sessionListEl.querySelector('.session-inline-state')?.textContent)
      .toBe('Discovery failed');
    expect(renderer.sessionListEl.querySelectorAll('.session-group')).toHaveLength(2);
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-project-name')))
      .toEqual(['Alpha', 'Beta']);
    expect(renderer.sessionListEl.querySelectorAll('.session-row')).toHaveLength(0);
    expect(renderer.sessionListEl.querySelector('.session-empty')).toBeNull();
  });

  it('treats idle discovery as silent and preserves the type-filter empty state', () => {
    const renderer = createRenderer({
      projects: [
        { id: 'alpha', name: 'Alpha', root: '/alpha' },
        { id: 'beta', name: 'Beta', root: '/beta' },
      ],
      phase: 'idle',
      typeFilter: 'attention',
    });

    renderer.render();
    expect(renderer.sessionListEl.querySelector('.session-inline-state')).toBeNull();
    expect(renderer.sessionListEl.querySelector('.session-empty')?.textContent)
      .toBe('No sessions match the attention filter.');
  });

  it('hides selected empty worktrees while preserving populated worktree ownership and attention', () => {
    const renderer = createRenderer({
      projects: [{
        id: 'alpha', name: 'Alpha', root: '/alpha', selectedWorktreePath: '/alpha',
        worktrees: [
          { path: '/alpha', branch: 'main', is_main: true, dirty: false, missing: false },
          { path: '/alpha-feature', branch: 'feature', is_main: false, dirty: false, missing: false },
        ],
      }],
      threads: [{
        id: 'local-feature', projectId: 'alpha', name: 'Local feature',
        status: 'running', worktreePath: '/alpha-feature', needsAttention: true,
      }],
      sessions: [{
        id: 'daemon-feature', projectRoot: '/alpha-feature', title: 'Daemon feature', status: 'waiting',
        labels: ['source:psyche-build'],
      }],
    });

    renderer.render();
    const worktrees = renderer.sessionListEl.querySelectorAll('.session-branch');
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].querySelectorAll('.session-row')
      .find((row) => row.dataset.threadId === 'local-feature')).toBeDefined();
    const badges = renderer.sessionListEl.querySelectorAll('.session-attention-badge');
    expect(textOf(badges)).toEqual(['!2', '!2']);
    expect(renderer.sessionListEl.querySelector('.session-project-count')?.getAttribute('aria-label'))
      .toBe('2 sessions, 2 need attention');
    expect(renderer.sessionListEl.querySelector('.session-branch-count')?.getAttribute('aria-label'))
      .toBe('2 sessions, 2 need attention');
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-status-label')))
      .toEqual(['REPLY', 'REPLY']);
  });

  it('keeps a project header when its only worktree session is hidden', () => {
    const renderer = createRenderer({
      projects: [
        {
          id: 'alpha', name: 'Alpha', root: '/alpha',
          worktrees: [
            { path: '/alpha', branch: 'main', is_main: true, dirty: false, missing: false },
          ],
        },
        {
          id: 'beta', name: 'Beta', root: '/beta',
          worktrees: [
            { path: '/beta', branch: 'main', is_main: true, dirty: false, missing: false },
          ],
        },
      ],
      threads: [
        {
          id: 'hidden-alpha', projectId: 'alpha', name: 'Hidden Alpha',
          status: 'running', worktreePath: '/alpha', hidden: true,
        },
        {
          id: 'visible-beta', projectId: 'beta', name: 'Visible Beta',
          status: 'running', worktreePath: '/beta',
        },
      ],
    });

    renderer.render();

    const groups = renderer.sessionListEl.querySelectorAll('.session-group');
    expect(groups).toHaveLength(2);
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-project-name')))
      .toEqual(['Alpha', 'Beta']);
    expect(renderer.sessionListEl.textContent).not.toContain('Hidden Alpha');
    expect(renderer.sessionListEl.querySelectorAll('.session-worktree-group')).toHaveLength(1);
    expect(renderer.sessionListEl.querySelector('.session-row')?.dataset.threadId)
      .toBe('visible-beta');
  });

  it('keeps unresolved sessions visible because their fallback group is populated', async () => {
    const renderer = createRenderer({
      projects: [{
        id: 'alpha', name: 'Alpha', root: '/alpha',
        worktrees: [
          { path: '/alpha', branch: 'main', is_main: true, dirty: false, missing: false },
        ],
      }],
      threads: [{
        id: 'orphan', projectId: 'alpha', name: 'Orphan session',
        status: 'running', worktreePath: '/removed/worktree',
      }],
    });

    renderer.render();

    const branch = renderer.sessionListEl.querySelector('.session-worktree-group');
    const head = renderer.sessionListEl.querySelector('.session-worktree-head');
    const disclosure = head?.children[0];
    const row = renderer.sessionListEl.querySelector('.session-row');

    expect(renderer.sessionListEl.querySelectorAll('.session-worktree-group')).toHaveLength(1);
    expect(branch?.getAttribute('aria-disabled')).toBeNull();
    expect(branch?.getAttribute('aria-label')).toContain('sessions with no available worktree');
    expect(head?.title).toBe('Sessions with no available worktree');
    expect(head?.dataset.tooltip).toBe('Sessions with no available worktree');
    expect(disclosure?.getAttribute('aria-disabled')).toBe('true');
    expect(disclosure?.title).toBe('Sessions with no available worktree');
    expect((disclosure as FakeElement | undefined)?.disabled).toBe(true);
    expect(row?.dataset.threadId).toBe('orphan');

    await row?.emit('click');
    expect(renderer.focusThread).toHaveBeenCalledWith('orphan');
  });

  it('keeps missing worktrees activatable only through their session descendants', async () => {
    const renderer = createRenderer({
      projects: [{
        id: 'alpha',
        name: 'Alpha',
        root: '/alpha',
        selectedWorktreePath: '/alpha',
        worktrees: [{
          path: '/alpha/missing',
          branch: 'feat/orphaned',
          is_main: false,
          dirty: false,
          missing: true,
        }],
      }],
      threads: [{
        id: 'missing-session',
        projectId: 'alpha',
        name: 'Missing session',
        status: 'running',
        worktreePath: '/alpha/missing',
      }],
    });

    renderer.render();

    const branch = renderer.sessionListEl.querySelector('.session-worktree-group');
    const head = renderer.sessionListEl.querySelector('.session-worktree-head');
    const disclosure = head?.children[0];
    const row = renderer.sessionListEl.querySelector('.session-row');

    expect(branch?.getAttribute('aria-disabled')).toBeNull();
    expect(branch?.getAttribute('aria-label')).toContain('worktree is missing');
    expect(head?.title).toBe('/alpha/missing — worktree is missing');
    expect(disclosure?.getAttribute('aria-disabled')).toBe('true');
    expect((disclosure as FakeElement | undefined)?.disabled).toBe(true);

    await branch?.emit('click', { target: head ?? undefined });
    expect(renderer.activateProjectWorktree).not.toHaveBeenCalled();

    await row?.emit('click');
    expect(renderer.focusThread).toHaveBeenCalledWith('missing-session');
  });

  it('leaves local and daemon sidebar rows unchanged while composer search owns matching', () => {
    const renderer = createRenderer({
      threads: [{ id: 'local', projectId: 'alpha', name: 'Review locally', status: 'running' }],
      sessions: [{
        id: 'daemon', projectRoot: '/alpha', title: 'Ship release', status: 'waiting',
        labels: ['source:psyche-build'],
      }],
      composerQuery: '? ship',
    });

    renderer.render();
    expect(renderer.sessionListEl.querySelectorAll('.session-row').map((row) =>
      row.dataset.sessionId ?? row.dataset.threadId)).toEqual(['daemon', 'local']);

    renderer.composerInputEl.value = '? review';
    renderer.render();
    expect(renderer.sessionListEl.querySelectorAll('.session-row').map((row) =>
      row.dataset.sessionId ?? row.dataset.threadId)).toEqual(['daemon', 'local']);
  });

  it('renders session metadata without sidebar query highlighting', () => {
    const renderer = createRenderer({
      projects: [{
        id: 'psyche', name: 'PSYCHE-BUILD', root: '/repo/psyche-build',
        worktrees: [{
          path: '/repo/psyche-build', branch: 'feat/agent-search',
          is_main: true, dirty: false, missing: false,
        }],
      }],
      sessions: [{
        id: 'daemon', projectRoot: '/repo/psyche-build', cwd: '/repo/psyche-build',
        title: 'Release agent', harness: 'codex', status: 'waiting',
        labels: ['source:psyche-build'],
      }],
      composerQuery: '? reply',
    });

    renderer.render();

    const status = renderer.sessionListEl.querySelector('.session-status-label');
    expect(status?.textContent).toBe('REPLY');
    expect(descendants(status!).filter((element) => element.tagName === 'MARK')
      .map((element) => element.textContent)).toEqual([]);

    renderer.composerInputEl.value = '? coven';
    renderer.render();
    const meta = renderer.sessionListEl.querySelector('.session-meta');
    expect(meta?.textContent).toContain('Coven');
    expect(descendants(meta!).filter((element) => element.tagName === 'MARK')
      .map((element) => element.textContent)).toEqual([]);
  });

  it('renders accurate filter-only summaries and reset actions', () => {
    const renderer = createRenderer({
      projects: [
        {
          id: 'psyche', name: 'PSYCHE-BUILD', root: '/repo/psyche-build',
          worktrees: [{
            path: '/repo/psyche-build', branch: 'main',
            is_main: true, dirty: false, missing: false,
          }],
        },
        {
          id: 'coven', name: 'COVEN-CAVE', root: '/repo/coven-cave',
          worktrees: [{
            path: '/repo/coven-cave', branch: 'main',
            is_main: true, dirty: false, missing: false,
          }],
        },
        {
          id: 'chat', name: 'CHAT', root: '/repo/chat',
          worktrees: [{
            path: '/repo/chat', branch: 'main',
            is_main: true, dirty: false, missing: false,
          }],
        },
      ],
      threads: [
        { id: 'psyche-shell', projectId: 'psyche', worktreePath: '/repo/psyche-build',
          name: 'Search worker', kind: 'shell', status: 'running' },
        { id: 'chat-agent', projectId: 'chat', worktreePath: '/repo/chat',
          name: 'Search agent', kind: 'agent', status: 'running' },
      ],
      sessions: [{
        id: 'coven-search', projectRoot: '/repo/coven-cave', cwd: '/repo/coven-cave',
        title: 'Search durable', harness: 'Coven', status: 'running',
        labels: ['source:psyche-build'],
      }],
      typeFilter: 'agents',
    });

    renderer.render();
    expect(renderer.sessionListEl.querySelector('.session-result-summary')?.textContent)
      .toContain('2 sessions');
    expect(renderer.sessionListEl.querySelector('.session-result-reset')?.textContent)
      .toBe('Reset filter');
    renderer.sessionListEl.querySelector('.session-result-reset')?.click();
    expect(renderer.setSessionTypeFilter).toHaveBeenCalledWith('all');
  });

  it('keeps composer focus while the sidebar rerenders and restores tree focus by stable key', () => {
    const renderer = createRenderer({
      projects: [{
        id: 'psyche', name: 'PSYCHE-BUILD', root: '/repo/psyche-build',
        worktrees: [{
          path: '/repo/psyche-build', branch: 'main',
          is_main: true, dirty: false, missing: false,
        }],
      }],
      threads: [{
        id: 'shell', projectId: 'psyche', worktreePath: '/repo/psyche-build',
        name: 'Search worker', kind: 'shell', status: 'running',
      }],
    });

    renderer.render();
    const branch = renderer.sessionListEl.querySelector('.session-branch');
    branch?.focus();
    renderer.render();
    expect(renderer.document.activeElement?.dataset.treeKey).toBe(branch?.dataset.treeKey);

    renderer.composerInputEl.focus();
    renderer.render();
    expect(renderer.document.activeElement).toBe(renderer.composerInputEl);
  });

  it('does not clear a valid persisted selection while composer search is open', () => {
    const renderer = createRenderer({
      selectedSessionKey: 'coven:daemon',
      sessions: [{
        id: 'daemon', projectRoot: '/alpha', title: 'Ship release', status: 'waiting',
        labels: ['source:psyche-build'],
      }],
      composerQuery: '? missing',
    });

    renderer.render();

    expect(renderer.settings.selectedSessionKey).toBe('coven:daemon');
    expect(renderer.saveSettings).not.toHaveBeenCalled();
  });

  it('clears a persisted selection after its underlying session disappears', () => {
    const renderer = createRenderer({ selectedSessionKey: 'coven:missing' });

    renderer.render();

    expect(renderer.settings.selectedSessionKey).toBe('');
    expect(renderer.saveSettings).toHaveBeenCalledOnce();
  });

  it('clears an invalid persisted selection even when another local thread is active', () => {
    const renderer = createRenderer({
      selectedSessionKey: 'coven:missing',
      activeThreadId: 'local',
      threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
    });

    renderer.render();

    expect(renderer.settings.selectedSessionKey).toBe('');
    expect(renderer.saveSettings).toHaveBeenCalledOnce();
  });

  it('defers Coven selection validation until discovery has completed', () => {
    const renderer = createRenderer({
      selectedSessionKey: 'coven:not-loaded-yet',
      phase: 'loading',
    });

    renderer.render();

    expect(renderer.settings.selectedSessionKey).toBe('coven:not-loaded-yet');
    expect(renderer.saveSettings).not.toHaveBeenCalled();
  });

  it('does not reveal an empty worktree when composer search matches its branch', () => {
    const renderer = createRenderer({
      projects: [{
        id: 'alpha', name: 'Alpha', root: '/alpha',
        worktrees: [
          { path: '/alpha', branch: 'main', is_main: true, dirty: false, missing: false },
          { path: '/alpha-feature', branch: 'feature', is_main: false, dirty: false, missing: false },
        ],
      }],
      threads: [{
        id: 'feature', projectId: 'alpha', name: 'Feature work',
        status: 'running', worktreePath: '/alpha-feature',
      }],
      composerQuery: '? main',
    });

    renderer.render();

    expect(renderer.sessionListEl.querySelectorAll('.session-worktree-group')).toHaveLength(1);
    expect(renderer.sessionListEl.querySelector('.session-branch-name')?.textContent)
      .toBe('feature');
    expect(renderer.sessionListEl.querySelector('.session-empty')).toBeNull();
  });

  it('keeps sidebar query wiring removed while retaining persisted type filters', () => {
    const rendererSource = extractFunctionSource(mainJs, 'renderSessionList');
    const setTypeFilterSource = extractFunctionSource(mainJs, 'setSessionTypeFilter');

    expect(indexHtml).not.toContain('id="session-search"');
    expect(mainJs).not.toContain('var sessionSearchEl');
    expect(mainJs).not.toContain('var sessionFilter');
    expect(mainJs).not.toContain('sessionSearchEl.addEventListener');
    expect(mainJs).not.toContain('if (event.key === "/")');
    expect(mainJs).not.toContain('if (e.key === "/")');
    expect(mainJs).toContain('var sessionTypeFilter = settings.sessionFilter;');
    expect(setTypeFilterSource).toContain('settings.sessionFilter = sessionTypeFilter');
    expect(rendererSource).toContain('var currentSearchQuery = "";');
    expect(rendererSource).toContain('query: currentSearchQuery');
    expect(rendererSource).toContain('filter: sessionTypeFilter');
    expect(rendererSource).not.toContain('sessionSearch');
  });

  it('uses sibling local controls and preserves activation, keyboard rename, close, and empty behavior', async () => {
    const renderer = createRenderer({
      activeProjectId: 'other',
      activeThreadId: 'local',
      threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
    });
    renderer.render();
    const wrapper = renderer.sessionListEl.querySelector('.session-row-wrap');
    const localRow = renderer.sessionListEl.querySelectorAll('.session-row')[0];
    const close = wrapper?.querySelector('.session-close');
    expect(wrapper?.tagName).toBe('DIV');
    expect(localRow.tagName).toBe('DIV');
    expect(localRow.parentNode).toBe(wrapper);
    expect(close?.parentNode).toBe(localRow);
    expect(localRow.querySelector('.session-close')).toBe(close);
    expect(localRow.getAttribute('role')).toBe('treeitem');
    expect(localRow.getAttribute('aria-selected')).toBe('true');
    expect(localRow.getAttribute('aria-keyshortcuts')).toBe('Delete');
    expect(localRow.classList.contains('active')).toBe(true);
    expect(localRow.getAttribute('aria-current')).toBe('true');
    expect(close?.getAttribute('tabindex')).toBe('-1');
    await localRow.emit('click');
    expect(renderer.settings.selectedSessionKey).toContain('psyche:/alpha');
    expect(renderer.saveSettings).toHaveBeenCalled();
    expect(renderer.setActiveProject).toHaveBeenCalledWith('alpha');
    expect(renderer.focusThread).toHaveBeenCalledWith('local');

    renderer.setActiveProject.mockClear();
    renderer.focusThread.mockClear();
    localRow.focus();
    const enterEvent = new FakeEvent(localRow, 'Enter');
    renderer.handleTreeKeydown(enterEvent);
    expect(enterEvent.defaultPrevented).toBe(true);
    expect(renderer.setActiveProject).toHaveBeenCalledWith('alpha');
    await vi.waitFor(() => {
      expect(renderer.focusThread).toHaveBeenCalledWith('local');
    });

    renderer.setActiveProject.mockClear();
    renderer.focusThread.mockClear();
    close?.focus();
    const closeKeyEvent = await localRow.emit('keydown', {
      target: close ?? undefined,
      key: 'Enter',
    });
    expect(closeKeyEvent.defaultPrevented).toBe(false);
    expect(renderer.setActiveProject).not.toHaveBeenCalled();
    expect(renderer.focusThread).not.toHaveBeenCalled();

    renderer.hideThread.mockClear();
    localRow.focus();
    const deleteEvent = await localRow.emit('keydown', { key: 'Delete' });
    expect(deleteEvent.defaultPrevented).toBe(true);
    expect(renderer.hideThread).not.toHaveBeenCalled();
    expect(renderer.closeThread).not.toHaveBeenCalled();
    expect(localRow.querySelector('.session-close-confirm')?.textContent).toBe('Close · 3');
    expect(renderer.setActiveProject).not.toHaveBeenCalled();
    expect(renderer.focusThread).not.toHaveBeenCalled();

    renderer.hideThread.mockClear();
    const closeEvent = await close?.emit('click');
    expect(renderer.hideThread).not.toHaveBeenCalled();
    expect(renderer.closeThread).not.toHaveBeenCalled();
    expect(localRow.querySelector('.session-close-confirm')?.textContent).toBe('Close · 3');
    expect(closeEvent?.propagationStopped).toBe(true);

    const title = localRow.querySelector('.session-title');
    await localRow.emit('dblclick', { target: title ?? localRow });
    expect(renderer.editLabelInline).toHaveBeenCalledWith(
      title,
      'sidebar',
      expect.objectContaining({ initial: 'Local' }),
    );
    renderer.editLabelInline.mockClear();
    const renameEvent = await localRow.emit('keydown', { key: 'F2' });
    expect(renameEvent.defaultPrevented).toBe(true);
    expect(renameEvent.propagationStopped).toBe(true);
    expect(renderer.editLabelInline).toHaveBeenCalledWith(
      title,
      'sidebar',
      expect.objectContaining({ initial: 'Local' }),
    );

    const empty = createRenderer();
    empty.render();
    expect(empty.sessionListEl.querySelector('.session-worktree-group')).toBeNull();
    expect(empty.sessionListEl.querySelector('.session-empty')?.textContent)
      .toBe('No sessions yet.');
  });

  it('activates focused Coven session treeitems only on Enter', async () => {
    const renderer = createRenderer({
      sessions: [{
        id: 'daemon',
        projectRoot: '/alpha',
        cwd: '/alpha',
        title: 'Daemon',
        status: 'waiting',
        labels: ['source:psyche-build'],
      }],
    });
    renderer.render();
    const row = renderer.sessionListEl.querySelector('.session-row');
    row?.focus();

    const space = new FakeEvent(row!, ' ');
    renderer.handleTreeKeydown(space);
    expect(space?.defaultPrevented).toBe(false);
    expect(renderer.openCovenSession).not.toHaveBeenCalled();

    const enter = new FakeEvent(row!, 'Enter');
    renderer.handleTreeKeydown(enter);
    await Promise.resolve();
    expect(enter?.defaultPrevented).toBe(true);
    expect(renderer.openCovenSession).toHaveBeenCalledOnce();
  });

  it('implements complete roving tree navigation without traversing embedded controls', async () => {
    const renderer = createRenderer({
      projects: [{
        id: 'alpha',
        name: 'Alpha',
        root: '/alpha',
        selectedWorktreePath: '/alpha',
        worktrees: [{
          path: '/alpha',
          branch: 'main',
          is_main: true,
          dirty: false,
          missing: false,
          collapsed: false,
        }],
      }],
      activeProjectId: 'alpha',
      activeThreadId: 'first',
      threads: [
        {
          id: 'first', projectId: 'alpha', worktreePath: '/alpha',
          name: 'First', status: 'running',
        },
        {
          id: 'second', projectId: 'alpha', worktreePath: '/alpha',
          name: 'Second', status: 'running',
        },
      ],
    });
    renderer.render();

    const rows = renderer.sessionListEl.querySelectorAll('.session-row');
    const first = rows.find((row) => row.dataset.threadId === 'first');
    const second = rows.find((row) => row.dataset.threadId === 'second');
    const firstClose = first?.parentNode?.querySelector('.session-close');
    const project = renderer.sessionListEl.querySelector('.session-project');
    const branch = renderer.sessionListEl.querySelector('.session-branch');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(firstClose).toBeDefined();

    project?.focus();
    renderer.handleTreeKeydown(new FakeEvent(project!, 'End'));
    expect(renderer.document.activeElement).toBe(second);
    renderer.handleTreeKeydown(new FakeEvent(second!, 'Home'));
    expect(renderer.document.activeElement).toBe(project);
    renderer.handleTreeKeydown(new FakeEvent(project!, 'ArrowDown'));
    expect(renderer.document.activeElement).toBe(branch);
    renderer.handleTreeKeydown(new FakeEvent(branch!, 'ArrowDown'));
    expect(renderer.document.activeElement).toBe(first);
    renderer.handleTreeKeydown(new FakeEvent(first!, 'ArrowUp'));
    expect(renderer.document.activeElement).toBe(branch);

    renderer.handleTreeKeydown(new FakeEvent(branch!, 'ArrowRight'));
    expect(renderer.document.activeElement).toBe(first);
    renderer.handleTreeKeydown(new FakeEvent(first!, 'ArrowLeft'));
    expect(renderer.document.activeElement).toBe(branch);
    renderer.handleTreeKeydown(new FakeEvent(branch!, 'ArrowLeft'));
    expect(renderer.state.projects[0].worktrees?.[0].collapsed).toBe(true);
    const collapsedBranch = renderer.sessionListEl.querySelector('.session-branch');
    renderer.handleTreeKeydown(new FakeEvent(collapsedBranch!, 'ArrowRight'));
    expect(renderer.state.projects[0].worktrees?.[0].collapsed).toBe(false);

    firstClose?.focus();
    const closeEvent = new FakeEvent(firstClose!, 'ArrowDown');
    renderer.handleTreeKeydown(closeEvent);
    expect(renderer.document.activeElement).toBe(firstClose);
    expect(closeEvent.defaultPrevented).toBe(false);

    const currentProject = renderer.sessionListEl.querySelector('.session-project');
    const currentBranch = renderer.sessionListEl.querySelector('.session-branch');
    currentProject?.focus();
    const space = new FakeEvent(currentProject!, ' ');
    renderer.handleTreeKeydown(space);
    expect(space.defaultPrevented).toBe(true);
    expect(renderer.state.projects[0].collapsed).toBe(true);
    renderer.handleTreeKeydown(new FakeEvent(
      renderer.sessionListEl.querySelector('.session-project')!,
      ' ',
    ));
    expect(renderer.state.projects[0].collapsed).toBe(false);

    const expandedBranch = renderer.sessionListEl.querySelector('.session-branch');
    expandedBranch?.focus();
    const enter = new FakeEvent(expandedBranch!, 'Enter');
    renderer.handleTreeKeydown(enter);
    await Promise.resolve();
    expect(enter.defaultPrevented).toBe(true);
    expect(renderer.activateProjectWorktree).toHaveBeenCalled();
  });

  it('marks rows that hold a pane-tree leaf while keeping close guarded', async () => {
    const renderer = createRenderer({
      activeThreadId: 'local',
      canvasThreadIds: ['local'],
      threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
    });
    renderer.render();

    const wrapper = renderer.sessionListEl.querySelector('.session-row-wrap');
    const row = wrapper?.querySelector('.session-row');
    const close = wrapper?.querySelector('.session-close');
    expect(row?.querySelector('.session-oncanvas')).not.toBeNull();
    expect(close?.title).toBe('Stop and close Local');

    await close?.emit('click');
    expect(renderer.hideThread).not.toHaveBeenCalled();
    expect(renderer.closeThread).not.toHaveBeenCalled();
    expect(row?.querySelector('.session-close-confirm')?.textContent).toBe('Close · 3');
  });

  it('omits the canvas marker for rows with no pane on the canvas', () => {
    const renderer = createRenderer({
      threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
    });
    renderer.render();

    const wrapper = renderer.sessionListEl.querySelector('.session-row-wrap');
    expect(wrapper?.querySelector('.session-row')?.querySelector('.session-oncanvas')).toBeNull();
    expect(wrapper?.querySelector('.session-close')?.title).toBe('Stop and close Local');
  });

  it('moves lane git state to the branch and keeps the row icon type-specific', () => {
    const renderer = createRenderer({
      projects: [{
        id: 'alpha', name: 'Alpha', root: '/alpha',
        worktrees: [{ path: '/alpha/wt', branch: 'feat/tiling', dirty: true }],
      }] as never,
      threads: [{
        id: 'local', projectId: 'alpha', name: 'Local', status: 'running',
        worktreePath: '/alpha/wt',
      }] as never,
    });
    renderer.render();

    expect(renderer.sessionListEl.querySelector('.session-type-icon')?.textContent).toBe('❯_');
    expect(renderer.sessionListEl.querySelector('.session-branch-head')?.textContent)
      .toContain('±');
    expect(renderer.sessionListEl.querySelector('.session-meta')?.textContent).toBe('ready');
  });

  it('uses pane glyphs for local web rows while keeping Coven rows agent-shaped', () => {
    const renderer = createRenderer({
      threads: [{
        id: 'web',
        projectId: 'alpha',
        name: 'Preview',
        kind: 'web',
        status: 'running',
        worktreePath: '/alpha',
      }],
      sessions: [{
        id: 'daemon',
        projectRoot: '/alpha',
        cwd: '/alpha',
        title: 'Daemon',
        status: 'running',
        labels: ['source:psyche-build'],
      }],
    });
    renderer.render();

    const rows = renderer.sessionListEl.querySelectorAll('.session-row');
    const web = rows.find((row) => row.dataset.threadId === 'web');
    const coven = rows.find((row) => row.dataset.sessionId === 'daemon');
    expect(web?.querySelector('.session-type-icon')?.textContent).toBe('◍');
    expect(coven?.querySelector('.session-type-icon')?.textContent).toBe('✳');
  });

  it('does not mark a clean branch as dirty', () => {
    const renderer = createRenderer({
      projects: [{
        id: 'alpha', name: 'Alpha', root: '/alpha',
        worktrees: [{ path: '/alpha/wt', branch: 'main', dirty: false }],
      }] as never,
      threads: [{
        id: 'local', projectId: 'alpha', name: 'Local', status: 'running',
        worktreePath: '/alpha/wt',
      }] as never,
    });
    renderer.render();

    expect(renderer.sessionListEl.querySelector('.session-type-icon')?.textContent).toBe('❯_');
    expect(renderer.sessionListEl.querySelector('.session-branch-head')?.textContent)
      .not.toContain('±');
  });

  it('renders no set swatches for a pane that belongs to no focus set', () => {
    const renderer = createRenderer({
      threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
    });
    renderer.render();

    expect(renderer.sessionListEl.querySelector('.session-row')?.innerHTML ?? '')
      .not.toContain('session-set-swatch');
  });

  describe('focus sets', () => {
    const threads = [
      { id: 'local', projectId: 'alpha', name: 'Local', status: 'running', worktreePath: '/alpha' },
      { id: 'other', projectId: 'alpha', name: 'Other', status: 'running', worktreePath: '/alpha' },
    ] as never;
    // Sets are filed under the pane layout key, which paneLayoutKey builds as
    // projectId + NUL + worktreePath.
    const key = 'alpha /alpha';
    const memberSet = {
      id: 'set-1', index: 2, name: 'Review', key, threadIds: ['local'],
    };

    it('marks membership with the set\'s coloured square and names it', () => {
      const renderer = createRenderer({ threads, focusSets: [memberSet] });
      renderer.render();

      const rows = renderer.sessionListEl.querySelectorAll('.session-row');
      const swatch = rows[0].querySelector('.session-set-swatch');
      expect(swatch?.dataset.set).toBe('2');
      // Colour is never the only carrier — the tooltip names the set.
      expect(swatch?.title).toBe('In Review');
      expect(rows[1].querySelector('.session-set-swatch')).toBeNull();
    });

    it('scopes the canvas to a member\'s set when the row is clicked', async () => {
      const renderer = createRenderer({ threads, focusSets: [memberSet] });
      renderer.render();

      await renderer.sessionListEl.querySelectorAll('.session-row')[0].emit('click');

      expect(renderer.applySetScopeForThread).toHaveBeenCalled();
      expect(renderer.focusThread).toHaveBeenCalledWith('local');
    });

    it('uses aria-selected for picked membership while keeping aria-current on the active row', async () => {
      const renderer = createRenderer({
        threads,
        activeProjectId: 'alpha',
        activeThreadId: 'local',
        setPicking: { key, picked: ['other'] },
      });
      renderer.render();

      const rows = renderer.sessionListEl.querySelectorAll('.session-row');
      expect(renderer.sessionListEl.getAttribute('aria-multiselectable')).toBe('true');
      expect(rows[0].classList.contains('is-picking')).toBe(true);
      expect(rows[0].classList.contains('active')).toBe(true);
      expect(rows[0].getAttribute('aria-current')).toBe('true');
      expect(rows[0].getAttribute('aria-selected')).toBe('false');
      expect(rows[1].classList.contains('is-picking')).toBe(true);
      expect(rows[1].classList.contains('is-picked')).toBe(true);
      expect(rows[1].getAttribute('aria-current')).toBeNull();
      expect(rows[1].getAttribute('aria-selected')).toBe('true');
      expect(rows[0].title).toBe('Include Local in the set');

      await rows[0].emit('click');

      // Picking must not drag the canvas around under the user.
      expect(renderer.focusThread).not.toHaveBeenCalled();
      expect(renderer.picked()).toEqual(['other', 'local']);
    });

    it('removes aria-multiselectable outside picking mode', () => {
      const renderer = createRenderer({ threads });
      renderer.render();

      expect(renderer.sessionListEl.getAttribute('aria-multiselectable')).toBeNull();
    });

    it('keeps × destructive while a set scopes the canvas', async () => {
      vi.useFakeTimers();
      const renderer = createRenderer({
        threads,
        focusSets: [memberSet],
        scopingSet: { id: 'set-1', name: 'Review', threadIds: ['local'] },
      });
      renderer.render();

      const wrappers = renderer.sessionListEl.querySelectorAll('.session-row-wrap');
      const close = wrappers[0].querySelector('.session-close');
      expect(close?.title).toBe('Stop and close Local');

      await close?.emit('click');

      expect(renderer.removeFromFocusSet).not.toHaveBeenCalled();
      expect(renderer.hideThread).not.toHaveBeenCalled();
      expect(renderer.closeThread).not.toHaveBeenCalled();
      expect(wrappers[0].querySelector('.session-close-confirm')?.textContent).toBe('Close · 3');
      vi.useRealTimers();
    });

    it('keeps × destructive for a pane the scoping set does not contain', async () => {
      vi.useFakeTimers();
      const renderer = createRenderer({
        threads,
        focusSets: [memberSet],
        scopingSet: { id: 'set-1', name: 'Review', threadIds: ['local'] },
      });
      renderer.render();

      const wrappers = renderer.sessionListEl.querySelectorAll('.session-row-wrap');
      await wrappers[1].querySelector('.session-close')?.emit('click');

      expect(renderer.hideThread).not.toHaveBeenCalled();
      expect(renderer.removeFromFocusSet).not.toHaveBeenCalled();
      expect(renderer.closeThread).not.toHaveBeenCalled();
      expect(wrappers[1].querySelector('.session-close-confirm')?.textContent).toBe('Close · 3');
      vi.useRealTimers();
    });

    it('arms destructive confirmation when Delete is pressed on the focused row', async () => {
      vi.useFakeTimers();
      const renderer = createRenderer({
        threads,
        focusSets: [memberSet],
        scopingSet: { id: 'set-1', name: 'Review', threadIds: ['local'] },
      });
      renderer.render();

      const wrappers = renderer.sessionListEl.querySelectorAll('.session-row-wrap');
      const row = wrappers[0].querySelector('.session-row');
      const close = wrappers[0].querySelector('.session-close');
      row?.focus();

      const deleteEvent = await row?.emit('keydown', { key: 'Delete' });
      expect(deleteEvent?.defaultPrevented).toBe(true);
      expect(renderer.removeFromFocusSet).not.toHaveBeenCalled();
      expect(renderer.hideThread).not.toHaveBeenCalled();
      expect(renderer.closeThread).not.toHaveBeenCalled();
      expect(wrappers[0].querySelector('.session-close-confirm')?.textContent).toBe('Close · 3');
      expect(renderer.focusThread).not.toHaveBeenCalled();
      expect(close?.getAttribute('tabindex')).toBe('-1');
      vi.useRealTimers();
    });

    it('returns to all panes when the project header is clicked', async () => {
      const renderer = createRenderer({ threads, focusSets: [memberSet] });
      renderer.render();

      const project = renderer.sessionListEl.querySelector('.session-project');
      const head = renderer.sessionListEl.querySelector('.session-group-head');
      await project?.emit('click', { target: head ?? undefined });

      expect(renderer.clearFocusSet).toHaveBeenCalled();
      expect(renderer.setActiveProject).toHaveBeenCalledWith('alpha');
    });
  });

  describe('timed close confirm', () => {
    function armed() {
      const renderer = createRenderer({
        threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
      });
      renderer.render();
      const wrapper = renderer.sessionListEl.querySelector('.session-row-wrap')!;
      const row = wrapper.querySelector('.session-row')!;
      const close = wrapper.querySelector('.session-close')!;
      row.focus();
      renderer.armSessionClose(row, close, 'Local', () => {
        renderer.closeThread('local');
      });
      return { renderer, wrapper, row, close };
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
    });
    afterEach(() => { vi.useRealTimers(); });

    it('replaces the × with a counting confirm instead of closing', () => {
      const { renderer, wrapper, row, close } = armed();

      const confirm = wrapper.querySelector('.session-close-confirm');
      expect(confirm?.textContent).toBe('Close · 3');
      expect(confirm?.getAttribute('aria-label')).toBe('Confirm closing Local');
      expect(confirm?.parentNode).toBe(row);
      expect(close.hidden).toBe(true);
      expect(renderer.closeThread).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(confirm?.textContent).toBe('Close · 2');
    });

    it('closes only on a second, deliberate click', async () => {
      const { renderer, wrapper } = armed();

      const confirm = wrapper.querySelector('.session-close-confirm')!;
      const event = await confirm.emit('click');

      expect(renderer.closeThread).toHaveBeenCalledWith('local');
      expect(event.propagationStopped).toBe(true);
      expect(wrapper.querySelector('.session-close-confirm')).toBeNull();
    });

    it('restores focus only when an async close reports failure', async () => {
      const renderer = createRenderer({
        threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
      });
      renderer.render();
      const wrapper = renderer.sessionListEl.querySelector('.session-row-wrap')!;
      const row = wrapper.querySelector('.session-row')!;
      const close = wrapper.querySelector('.session-close')!;

      renderer.armSessionClose(row, close, 'Local', () => Promise.resolve(false));
      const failedConfirm = wrapper.querySelector('.session-close-confirm')!;
      failedConfirm.focus();
      await failedConfirm.emit('click');
      await Promise.resolve();
      expect(renderer.document.activeElement).toBe(row);

      renderer.armSessionClose(row, close, 'Local', () => Promise.resolve(true));
      const successfulConfirm = wrapper.querySelector('.session-close-confirm')!;
      successfulConfirm.focus();
      await successfulConfirm.emit('click');
      await Promise.resolve();
      expect(renderer.document.activeElement).not.toBe(row);
    });

    it('reports thrown and rejected close failures while restoring focus', async () => {
      const renderer = createRenderer({
        threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
      });
      renderer.render();
      const wrapper = renderer.sessionListEl.querySelector('.session-row-wrap')!;
      const row = wrapper.querySelector('.session-row')!;
      const close = wrapper.querySelector('.session-close')!;

      renderer.armSessionClose(row, close, 'Local', () => {
        throw new Error('sync failure');
      });
      const thrownConfirm = wrapper.querySelector('.session-close-confirm')!;
      thrownConfirm.focus();
      await thrownConfirm.emit('click');
      expect(renderer.setStatus).toHaveBeenLastCalledWith(
        'Failed to close Local: sync failure',
        'error',
      );
      expect(renderer.document.activeElement).toBe(row);

      renderer.armSessionClose(row, close, 'Local', () => Promise.reject(
        new Error('async failure'),
      ));
      const rejectedConfirm = wrapper.querySelector('.session-close-confirm')!;
      rejectedConfirm.focus();
      await rejectedConfirm.emit('click');
      await Promise.resolve();
      expect(renderer.setStatus).toHaveBeenLastCalledWith(
        'Failed to close Local: async failure',
        'error',
      );
      expect(renderer.document.activeElement).toBe(row);
    });

    it('rejects an overdue confirmation click without waiting for timer callbacks', async () => {
      const { renderer, wrapper, row } = armed();
      const confirm = wrapper.querySelector('.session-close-confirm')!;

      vi.setSystemTime(13_001);
      await confirm.emit('click');

      expect(renderer.closeThread).not.toHaveBeenCalled();
      expect(wrapper.querySelector('.session-close-confirm')).toBeNull();
      expect(renderer.document.activeElement === row).toBe(true);
    });

    it('cancels itself when the countdown runs out', () => {
      const { renderer, wrapper, row, close } = armed();

      vi.advanceTimersByTime(3000);

      expect(wrapper.querySelector('.session-close-confirm')).toBeNull();
      expect(close.hidden).toBe(false);
      expect(renderer.closeThread).not.toHaveBeenCalled();
      expect(renderer.document.activeElement).toBe(row);
    });

    it('returns focus after a Delete-armed countdown expires', async () => {
      const renderer = createRenderer({
        threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
      });
      renderer.render();
      const row = renderer.sessionListEl.querySelector('.session-row')!;
      row.focus();

      await row.emit('keydown', { key: 'Delete' });
      expect(renderer.document.activeElement?.classList.contains('session-close-confirm')).toBe(true);

      vi.advanceTimersByTime(3000);

      expect(renderer.document.activeElement).toBe(row);
      expect(row.isConnected).toBe(true);
      expect(renderer.closeThread).not.toHaveBeenCalled();
    });

    it('restores focus to the connected host when Escape disarms confirmation', () => {
      const { renderer, wrapper, row } = armed();

      renderer.disarmSessionClose();

      expect(wrapper.querySelector('.session-close-confirm')).toBeNull();
      expect(renderer.document.activeElement).toBe(row);
      expect(row.isConnected).toBe(true);
      expect(renderer.closeThread).not.toHaveBeenCalled();
    });

    it('makes a non-roving × target the sole roving item after timeout', async () => {
      const renderer = createRenderer({
        threads: [
          { id: 'first', projectId: 'alpha', name: 'First', status: 'running' },
          { id: 'second', projectId: 'alpha', name: 'Second', status: 'running' },
        ],
      });
      renderer.render();
      const row = renderer.sessionListEl.querySelectorAll('.session-row').find(
        (candidate) => candidate.dataset.threadId === 'second',
      )!;
      expect(row.getAttribute('tabindex')).toBe('-1');

      await row.querySelector('.session-close')?.emit('click');
      vi.advanceTimersByTime(3000);

      expect(renderer.document.activeElement === row).toBe(true);
      expect(row.getAttribute('tabindex')).toBe('0');
      expect(renderer.sessionListEl.querySelectorAll('[data-tree-item]').filter(
        (item) => item.getAttribute('tabindex') === '0',
      ).map((item) => item.dataset.treeKey)).toEqual([row.dataset.treeKey]);
    });

    it('makes a non-roving context-menu target the sole roving item after Escape', async () => {
      const renderer = createRenderer({
        threads: [
          { id: 'first', projectId: 'alpha', name: 'First', status: 'running' },
          { id: 'second', projectId: 'alpha', name: 'Second', status: 'running' },
        ],
      });
      renderer.render();
      const row = renderer.sessionListEl.querySelectorAll('.session-row').find(
        (candidate) => candidate.dataset.threadId === 'second',
      )!;

      await row.emit('contextmenu');
      const actions = renderer.openSessionContextMenu.mock.calls[0]?.[1] as Array<{
        label: string;
        run: () => void;
      }>;
      actions.find((action) => action?.label === 'Stop and close')?.run();
      renderer.disarmSessionClose();

      expect(renderer.document.activeElement === row).toBe(true);
      expect(row.getAttribute('tabindex')).toBe('0');
      expect(renderer.sessionListEl.querySelectorAll('[data-tree-item]').filter(
        (item) => item.getAttribute('tabindex') === '0',
      ).map((item) => item.dataset.treeKey)).toEqual([row.dataset.treeKey]);
    });

    it('drops an armed confirm when the sidebar re-renders under it', () => {
      const { renderer, wrapper, row } = armed();

      renderer.render();

      const replacement = renderer.sessionListEl.querySelector('.session-row')!;
      expect(wrapper.querySelector('.session-close-confirm')).toBeNull();
      expect(row.isConnected).toBe(false);
      expect(replacement).not.toBe(row);
      expect(renderer.document.activeElement).toBe(replacement);
      expect(renderer.sessionListEl.querySelectorAll('[data-tree-item]').filter(
        (item) => item.getAttribute('tabindex') === '0',
      )).toHaveLength(1);
      expect(renderer.closeThread).not.toHaveBeenCalled();
      // The stale interval must not resurrect anything after the re-render.
      vi.advanceTimersByTime(5000);
      expect(renderer.closeThread).not.toHaveBeenCalled();
    });

    it('does not steal composer focus when rerender disarms confirmation', async () => {
      const renderer = createRenderer({
        threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
      });
      renderer.render();
      const row = renderer.sessionListEl.querySelector('.session-row')!;
      await row.querySelector('.session-close')?.emit('click');
      expect(row.querySelector('.session-close-confirm')).not.toBeNull();

      renderer.composerInputEl.focus();
      renderer.render();

      expect(renderer.document.activeElement === renderer.composerInputEl).toBe(true);
      expect(renderer.sessionListEl.querySelector('.session-close-confirm')).toBeNull();
    });

    it('does not steal composer focus when an abandoned confirmation times out', async () => {
      const renderer = createRenderer({
        threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
      });
      renderer.render();
      const row = renderer.sessionListEl.querySelector('.session-row')!;
      await row.querySelector('.session-close')?.emit('click');
      renderer.composerInputEl.focus();

      vi.advanceTimersByTime(3000);

      expect(row.querySelector('.session-close-confirm')).toBeNull();
      expect(renderer.document.activeElement === renderer.composerInputEl).toBe(true);
      expect(renderer.document.activeElement === row).toBe(false);
      expect(renderer.sessionListEl.querySelectorAll('[data-tree-item]').filter(
        (item) => item.getAttribute('tabindex') === '0',
      )).toHaveLength(1);
      expect(renderer.closeThread).not.toHaveBeenCalled();
    });

    it('does not steal composer focus when Escape disarms an abandoned confirmation', async () => {
      const renderer = createRenderer({
        threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
      });
      renderer.render();
      const row = renderer.sessionListEl.querySelector('.session-row')!;
      await row.querySelector('.session-close')?.emit('click');
      renderer.composerInputEl.focus();

      renderer.disarmSessionClose();

      expect(row.querySelector('.session-close-confirm')).toBeNull();
      expect(renderer.document.activeElement === renderer.composerInputEl).toBe(true);
      expect(renderer.document.activeElement === row).toBe(false);
      expect(renderer.sessionListEl.querySelectorAll('[data-tree-item]').filter(
        (item) => item.getAttribute('tabindex') === '0',
      )).toHaveLength(1);
      expect(renderer.closeThread).not.toHaveBeenCalled();
    });
  });

  describe('Coven row close control', () => {
    const session: RemoteSession = {
      id: 'coven-1', projectRoot: '/alpha', cwd: '/alpha', title: 'Agent Coven', status: 'running',
      labels: ['source:psyche-build'],
    };

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('stops and refreshes an eligible Coven session only after confirmation succeeds', async () => {
      const renderer = createRenderer({ sessions: [session] });
      renderer.render();
      const row = renderer.sessionListEl.querySelectorAll('.session-row')
        .find((candidate) => candidate.dataset.sessionId === session.id)!;
      const close = row.querySelector('.session-close')!;

      expect(close).not.toBeNull();
      expect(close.title).toBe('Stop and close Agent Coven');
      expect(close.getAttribute('aria-label')).toBe('Stop and close Agent Coven');
      expect(close.getAttribute('tabindex')).toBe('-1');

      const closeEvent = await close.emit('click');
      expect(closeEvent.propagationStopped).toBe(true);
      expect(renderer.openCovenSession).not.toHaveBeenCalled();
      expect(renderer.invoke).not.toHaveBeenCalled();
      expect(row.querySelector('.session-close-confirm')?.textContent).toBe('Close · 3');

      const confirmEvent = await row.querySelector('.session-close-confirm')!.emit('click');
      expect(confirmEvent.propagationStopped).toBe(true);
      await vi.waitFor(() => {
        expect(renderer.invoke).toHaveBeenCalledTimes(1);
        expect(renderer.refreshCovenSessions).toHaveBeenCalledTimes(1);
      });
      expect(renderer.refreshCovenSessions).toHaveBeenCalledWith({
        force: true,
        requiredGeneration: 1,
      });
      expect(renderer.invoke).toHaveBeenCalledWith('coven_session_kill', {
        sessionId: 'coven-1',
        session_id: 'coven-1',
      });
      expect(renderer.openCovenSession).not.toHaveBeenCalled();
      expect(renderer.document.activeElement).not.toBe(row);
    });

    it('retains the Coven row and reports an error when native stop fails', async () => {
      const renderer = createRenderer({
        sessions: [session],
        invoke: () => Promise.reject(new Error('daemon refused')),
      });
      renderer.render();
      const row = renderer.sessionListEl.querySelectorAll('.session-row')
        .find((candidate) => candidate.dataset.sessionId === session.id)!;

      await row.querySelector('.session-close')!.emit('click');
      await row.querySelector('.session-close-confirm')!.emit('click');
      await vi.waitFor(() => {
        expect(renderer.setStatus).toHaveBeenCalledWith(
          'Stop and close failed: Error: daemon refused',
          'error',
        );
      });

      expect(renderer.refreshCovenSessions).not.toHaveBeenCalled();
      expect(renderer.sessionListEl.querySelectorAll('.session-row')
        .some((candidate) => candidate.dataset.sessionId === session.id)).toBe(true);
      expect(renderer.document.activeElement).toBe(row);
      expect(renderer.sessionListEl.querySelectorAll('[data-tree-item]').filter(
        (item) => item.getAttribute('tabindex') === '0',
      )).toHaveLength(1);
    });

    it('does not steal focus moved to the composer while a failed Coven close is pending', async () => {
      let rejectInvoke!: (error: Error) => void;
      const pending = new Promise<never>((_resolve, reject) => { rejectInvoke = reject; });
      const renderer = createRenderer({ sessions: [session], invoke: () => pending });
      renderer.render();
      const row = renderer.sessionListEl.querySelectorAll('.session-row')
        .find((candidate) => candidate.dataset.sessionId === session.id)!;

      await row.querySelector('.session-close')!.emit('click');
      await row.querySelector('.session-close-confirm')!.emit('click');
      renderer.composerInputEl.focus();
      rejectInvoke(new Error('daemon refused'));
      await vi.waitFor(() => expect(renderer.setStatus).toHaveBeenCalled());

      expect(renderer.document.activeElement).toBe(renderer.composerInputEl);
      expect(renderer.document.activeElement).not.toBe(row);
      expect(renderer.refreshCovenSessions).not.toHaveBeenCalled();
    });

    it('deduplicates native stop calls while one session close is in flight', async () => {
      let resolveInvoke!: () => void;
      const pending = new Promise<void>((resolve) => { resolveInvoke = resolve; });
      const renderer = createRenderer({ sessions: [session], invoke: () => pending });

      const first = renderer.closeCovenSession(session);
      const second = renderer.closeCovenSession(session);
      expect(renderer.invoke).toHaveBeenCalledTimes(1);
      expect(await second).toBe(false);
      expect(renderer.refreshCovenSessions).not.toHaveBeenCalled();

      resolveInvoke();
      expect(await first).toBe(true);
      expect(renderer.refreshCovenSessions).toHaveBeenCalledTimes(1);
    });

    it('allows retrying a Coven close after a rejected native request settles', async () => {
      const invoke = vi.fn()
        .mockRejectedValueOnce(new Error('daemon refused'))
        .mockResolvedValueOnce(null);
      const renderer = createRenderer({ sessions: [session], invoke });

      await expect(renderer.closeCovenSession(session)).resolves.toBe(false);
      await expect(renderer.closeCovenSession(session)).resolves.toBe(true);

      expect(renderer.invoke).toHaveBeenCalledTimes(2);
      expect(renderer.refreshCovenSessions).toHaveBeenCalledTimes(1);
      expect(renderer.refreshCovenSessions).toHaveBeenCalledWith({
        force: true,
        requiredGeneration: 1,
      });
    });

    it('guards Delete on a focused Coven row without activating it', async () => {
      const renderer = createRenderer({ sessions: [session] });
      renderer.render();
      const row = renderer.sessionListEl.querySelectorAll('.session-row')
        .find((candidate) => candidate.dataset.sessionId === session.id)!;
      row.focus();

      const event = await row.emit('keydown', { key: 'Delete' });
      expect(event.defaultPrevented).toBe(true);
      expect(renderer.invoke).not.toHaveBeenCalled();
      expect(renderer.openCovenSession).not.toHaveBeenCalled();
      expect(row.querySelector('.session-close-confirm')?.textContent).toBe('Close · 3');

      await row.querySelector('.session-close-confirm')!.emit('click');
      await vi.waitFor(() => expect(renderer.invoke).toHaveBeenCalledTimes(1));
      expect(renderer.openCovenSession).not.toHaveBeenCalled();
    });

    it('offers Attach and guarded Stop and close context actions without row activation', async () => {
      const renderer = createRenderer({ sessions: [session] });
      renderer.render();
      const row = renderer.sessionListEl.querySelectorAll('.session-row')
        .find((candidate) => candidate.dataset.sessionId === session.id)!;

      await row.emit('contextmenu');
      const actions = renderer.openSessionContextMenu.mock.calls[0]?.[1] as Array<{
        label: string;
        danger?: boolean;
        run: () => void;
      }>;
      expect(actions[0]?.label).toBe('Attach');
      const stop = actions.find((action) => action?.label === 'Stop and close');
      expect(stop).toMatchObject({ label: 'Stop and close', danger: true });

      stop?.run();
      expect(renderer.invoke).not.toHaveBeenCalled();
      expect(renderer.openCovenSession).not.toHaveBeenCalled();
      expect(row.querySelector('.session-close-confirm')?.textContent).toBe('Close · 3');
      await row.querySelector('.session-close-confirm')!.emit('click');
      await vi.waitFor(() => expect(renderer.invoke).toHaveBeenCalledTimes(1));
      expect(renderer.openCovenSession).not.toHaveBeenCalled();
    });

    it('labels the first context action Focus attachment for attached Coven rows', async () => {
      const renderer = createRenderer({
        sessions: [session],
        threads: [{
          id: 'attached', projectId: 'alpha', name: 'Agent Coven', status: 'running',
          launch: { covenSessionId: session.id },
        }],
      });
      renderer.render();
      const row = renderer.sessionListEl.querySelectorAll('.session-row')
        .find((candidate) => candidate.dataset.sessionId === session.id)!;

      await row.emit('contextmenu');
      expect(renderer.openSessionContextMenu.mock.calls[0]?.[1]?.[0]?.label)
        .toBe('Focus attachment');
    });

    it('restores roving focus to a Coven row after its confirmation times out', async () => {
      const renderer = createRenderer({ sessions: [session] });
      renderer.render();
      const row = renderer.sessionListEl.querySelectorAll('.session-row')
        .find((candidate) => candidate.dataset.sessionId === session.id)!;
      await row.querySelector('.session-close')!.emit('click');

      vi.advanceTimersByTime(3000);

      expect(renderer.document.activeElement).toBe(row);
      expect(row.getAttribute('tabindex')).toBe('0');
      expect(renderer.invoke).not.toHaveBeenCalled();
    });
  });

  describe('local row close control', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('shows a guarded Stop and close control that closes only after confirmation', async () => {
      const renderer = createRenderer({
        threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
      });
      renderer.render();
      const row = renderer.sessionListEl.querySelector('.session-row')!;
      const close = row.querySelector('.session-close')!;

      expect(close).not.toBeNull();
      expect(close.title).toBe('Stop and close Local');
      expect(close.getAttribute('aria-label')).toBe('Stop and close Local');
      expect(close.getAttribute('tabindex')).toBe('-1');

      const closeEvent = await close.emit('click');
      expect(closeEvent.propagationStopped).toBe(true);
      expect(renderer.closeThread).not.toHaveBeenCalled();
      const confirm = row.querySelector('.session-close-confirm')!;
      expect(confirm.textContent).toBe('Close · 3');

      await confirm.emit('click');
      expect(renderer.closeThread).toHaveBeenCalledTimes(1);
      expect(renderer.closeThread).toHaveBeenCalledWith('local');
      expect(renderer.document.activeElement).toBeNull();
      expect(renderer.document.activeElement).not.toBe(row);
    });

    it('guards Delete on the focused local session row', async () => {
      const renderer = createRenderer({
        threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
      });
      renderer.render();
      const row = renderer.sessionListEl.querySelector('.session-row')!;
      row.focus();

      const event = await row.emit('keydown', { key: 'Delete' });

      expect(event.defaultPrevented).toBe(true);
      expect(renderer.closeThread).not.toHaveBeenCalled();
      expect(row.querySelector('.session-close-confirm')?.textContent).toBe('Close · 3');
    });

    it('routes context-menu Stop and close through the same confirmation', async () => {
      const renderer = createRenderer({
        threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
      });
      renderer.render();
      const row = renderer.sessionListEl.querySelector('.session-row')!;

      await row.emit('contextmenu');
      const actions = renderer.openSessionContextMenu.mock.calls[0]?.[1] as Array<{
        label: string;
        run: () => void;
      }>;
      const stopAndClose = actions.find((action) => action?.label === 'Stop and close');
      expect(stopAndClose).toBeDefined();

      stopAndClose?.run();
      expect(renderer.closeThread).not.toHaveBeenCalled();
      const confirm = row.querySelector('.session-close-confirm')!;
      expect(confirm.textContent).toBe('Close · 3');

      await confirm.emit('click');
      expect(renderer.closeThread).toHaveBeenCalledTimes(1);
      expect(renderer.closeThread).toHaveBeenCalledWith('local');
    });
  });

  it('mounts the real local rename input beside controls and restores activation after settle', async () => {
    const renderer = createRenderer({
      activeThreadId: 'local',
      realEdit: true,
      threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
    });
    renderer.render();

    const wrapper = renderer.sessionListEl.querySelector('.session-row-wrap');
    const activation = wrapper?.querySelector('.session-row');
    const close = wrapper?.querySelector('.session-close');
    const f2Event = await activation?.emit('keydown', { key: 'F2' });
    const input = wrapper?.querySelector('.inline-edit');
    let ancestor = input?.parentNode ?? null;
    let hasButtonAncestor = false;
    while (ancestor) {
      if (ancestor.tagName === 'BUTTON') hasButtonAncestor = true;
      ancestor = ancestor.parentNode;
    }

    expect(f2Event?.defaultPrevented).toBe(true);
    expect(input?.parentNode).toBe(wrapper);
    expect(close?.parentNode).toBe(activation);
    expect(input?.getAttribute('aria-label')).toBe('Session name');
    expect(hasButtonAncestor).toBe(false);
    expect(activation?.classList.contains('inline-edit-hidden')).toBe(true);
    expect(activation?.getAttribute('aria-hidden')).toBe('true');
    expect(activation?.getAttribute('tabindex')).toBe('-1');
    expect(activation?.querySelector('.inline-edit')).toBeNull();

    if (!input) throw new Error('missing local rename input');
    input.value = 'Renamed';
    await input.emit('keydown', { key: 'Enter' });
    expect(renderer.renameThread).toHaveBeenCalledWith('local', 'Renamed');
    expect(activation?.classList.contains('inline-edit-hidden')).toBe(false);
    expect(activation?.getAttribute('aria-hidden')).toBeNull();
    expect(activation?.getAttribute('tabindex')).toBe('0');
    expect(renderer.sessionListEl.querySelector('.session-title')?.textContent).toBe('Renamed');

    const rerenderedWrapper = renderer.sessionListEl.querySelector('.session-row-wrap');
    const rerenderedActivation = rerenderedWrapper?.querySelector('.session-row');
    const rerenderedTitle = rerenderedActivation?.querySelector('.session-title');
    expect(renderer.document.activeElement).toBe(rerenderedActivation);
    await rerenderedActivation?.emit('dblclick', {
      target: rerenderedTitle ?? rerenderedActivation,
    });
    const cancelInput = rerenderedWrapper?.querySelector('.inline-edit');
    expect(rerenderedActivation?.classList.contains('inline-edit-hidden')).toBe(true);
    if (!cancelInput) throw new Error('missing local cancel input');
    cancelInput.value = 'Discarded';
    await cancelInput.emit('keydown', { key: 'Escape' });
    expect(renderer.renameThread).toHaveBeenCalledTimes(1);
    expect(rerenderedActivation?.classList.contains('inline-edit-hidden')).toBe(false);
    expect(rerenderedActivation?.getAttribute('aria-hidden')).toBeNull();
    expect(rerenderedActivation?.getAttribute('tabindex')).toBe('0');
    expect(renderer.sessionListEl.querySelector('.session-title')?.textContent).toBe('Renamed');
    const cancelledActivation = renderer.sessionListEl
      .querySelector('.session-row-wrap')
      ?.querySelector('.session-row');
    expect(renderer.document.activeElement).toBe(cancelledActivation);
  });

  it('keeps local row controls and scoped mixed-source styles', () => {
    expect(styles).toMatch(/\.session-subsection-label\s*\{[^}]*text-transform:\s*uppercase;[^}]*letter-spacing:/s);
    expect(styles).toMatch(/\.session-row-wrap\s*\{[^}]*position:\s*relative;/s);
    expect(styles).toMatch(/\.session-row\.inline-edit-hidden\s*\{[^}]*visibility:\s*hidden;/s);
    expect(styles).toMatch(/\.session-row-wrap\s*>\s*\.inline-edit\s*\{[^}]*position:\s*absolute;/s);
    expect(styles).toMatch(/\.session-close\s*\{[^}]*opacity:\s*1;/s);
    expect(styles).not.toMatch(/\.session-row-wrap:focus-within\s+\.session-close/);
    expect(styles).toMatch(/\.session-close:focus-visible\s*\{[^}]*outline:/s);
    expect(styles).not.toMatch(/\.session-close:focus-visible\s*\{[^}]*opacity:/s);
    expect(styles).toMatch(/\.session-row-wrap:hover\s+\.session-row:not\(\.active\)/);
    expect(styles).not.toMatch(/\.session-row-wrap:hover\s+\.session-row\s*\{/);
    expect(styles).toMatch(
      /\.session-row,\s*\.session-coven-row\s*\{[^}]*padding:\s*6px 8px;[^}]*border-radius:\s*7px;/s,
    );
    // The 44px row is the sidebar's scanning rhythm.
    expect(styles).toMatch(/\.session-row\s*\{\s*min-height:\s*var\(--session-row-h\);/);
    // Selection is a neutral fill; only the focus bar is violet.
    expect(styles).toMatch(/\.session-row\.active\s*\{[^}]*background:\s*var\(--surface-3\);/s);
    expect(styles).toMatch(/\.session-glyph\.git-dirty\s*\{\s*color:\s*var\(--warn\);/);
    expect(styles).toMatch(/\.session-set-swatch\s*\{[^}]*border-radius:\s*2px;/s);
    expect(styles).toMatch(/\.session-disclosure\s*\{[^}]*background:\s*transparent;/s);
    expect(styles).toMatch(
      /\.session-status\s*\{[^}]*flex-direction:\s*row;[^}]*white-space:\s*nowrap;/s,
    );
    expect(styles).toMatch(/\.session-status\.status-attention\s*\{[^}]*color:\s*var\(--warn\);/s);
    expect(styles).toMatch(/\.session-close-confirm\s*\{[^}]*animation:\s*close-confirm-slide/s);
    expect(styles).toMatch(/\.session-row-wrap\s*\{[^}]*position:\s*relative;/s);
    expect(styles).toMatch(/\.session-row\.inline-edit-hidden\s*\{[^}]*visibility:\s*hidden;/s);
    expect(styles).toMatch(/\.session-row-wrap\s*>\s*\.inline-edit\s*\{[^}]*position:\s*absolute;/s);
    expect(styles).toContain('.coven-tone-ok');
    expect(styles).toContain('.session-inline-state');
    const rendererSource = extractFunctionSource(mainJs, 'renderSessionList');
    expect(rendererSource).toContain('PsycheSessions.buildSidebarProjectModel');
    expect(rendererSource).toContain('localSessions: localRows');
    expect(rendererSource).toContain('covenSessions: remoteRows');
    expect(rendererSource).toContain('covenDiscovery');
    expect(rendererSource).toContain('createSessionRow');
    expect(rendererSource).not.toContain('aria-pressed');
    expect(mainJs).not.toContain('function createCovenSessionRow(');
    const rowSource = extractFunctionSource(mainJs, 'createSessionRow');
    const branchSource = extractFunctionSource(mainJs, 'createBranchGroup');
    expect(rowSource).toContain('document.createElement("div")');
    expect(rowSource).not.toContain('document.createElement("button")');
    expect(rowSource).toContain('role", "treeitem');
    expect(rowSource).toContain('aria-selected');
    expect(branchSource).not.toContain('group.setAttribute("aria-disabled", "true")');
    expect(rowSource).toContain('paneGlyphFor(rowModel.kind)');
  });

  it('keeps honest shell sequencing and promotes the rendered list to a tree', () => {
    expect(indexHtml).toContain(
      '<div class="session-list" id="session-list" role="tree" aria-label="Sessions by project, branch, and category"></div>',
    );
    const rendererSource = extractFunctionSource(mainJs, 'renderSessionList');
    expect(rendererSource).toContain('sessionListEl.setAttribute("role", "tree")');
    expect(extractFunctionSource(mainJs, 'createProjectGroup')).toContain('aria-level", "1');
    expect(extractFunctionSource(mainJs, 'createBranchGroup')).toContain('aria-level", "2');
    expect(extractFunctionSource(mainJs, 'createSessionRow')).toContain('aria-level", "3');
  });
});
