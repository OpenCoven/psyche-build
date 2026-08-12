import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

class FakeEvent {
  target: FakeElement;
  key: string;
  propagationStopped = false;
  defaultPrevented = false;

  constructor(target: FakeElement, key = '') {
    this.target = target;
    this.key = key;
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
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  className = '';
  title = '';
  type = '';
  value = '';
  spellcheck = true;
  autocomplete = '';
  focused = false;
  selected = false;
  hidden = false;
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
    this.ownText = String(value);
    this.html = '';
    this.children = [];
  }

  get innerHTML() {
    return this.html;
  }

  set innerHTML(value: string) {
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
    this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  get isConnected() {
    return this.parentNode !== null;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  replaceChildren(...children: FakeElement[]) {
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
    this.focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  select() {
    this.selected = true;
  }

  addEventListener(name: string, listener: Listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  async emit(name: string, options: { target?: FakeElement; key?: string } = {}) {
    const event = new FakeEvent(options.target ?? this, options.key);
    for (const listener of this.listeners.get(name) ?? []) {
      await listener(event);
    }
    return event;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (!selector.startsWith('.')) throw new Error(`unsupported selector ${selector}`);
    const className = selector.slice(1);
    const matches: FakeElement[] = [];
    const visit = (element: FakeElement) => {
      if (element.classList.contains(className)) matches.push(element);
      element.children.forEach(visit);
    };
    this.children.forEach(visit);
    return matches;
  }
}

class FakeDocument {
  readonly created: FakeElement[] = [];
  activeElement: FakeElement | null = null;

  createElement(tagName: string) {
    const element = new FakeElement(tagName, this);
    this.created.push(element);
    return element;
  }
}

type Project = {
  id: string;
  name: string;
  root: string;
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
  };
  worktreePath?: string;
  kind?: string;
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
  phase?: string;
  message?: string | null;
  stale?: boolean;
  filter?: string;
  activeProjectId?: string | null;
  activeThreadId?: string | null;
  openCovenSession?: (project: Project, session: RemoteSession) => unknown;
  realEdit?: boolean;
  canvasThreadIds?: string[];
  focusSets?: Array<{ id: string; index: number; name: string; key: string; threadIds: string[] }>;
  scopingSet?: { id: string; name: string; threadIds: string[] } | null;
  setPicking?: { key: string; picked: string[] } | null;
} = {}) {
  const document = new FakeDocument();
  const sessionListEl = new FakeElement('div');
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
  const focusThread = vi.fn().mockResolvedValue(undefined);
  const closeThread = vi.fn();
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
  const setStatus = vi.fn();
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
  const paneGlyphFor = (kind: string) =>
    kind === 'shell' ? '❯_' : kind === 'web' ? '◍' : '✳';

  const sources = [
    'var SESSION_CLOSE_SECONDS = 3;',
    'var armedSessionClose = null;',
    'var focusSets = seedFocusSets;',
    'var setPicking = seedSetPicking;',
    extractFunctionSource(mainJs, 'paneLayoutKey'),
    extractFunctionSource(mainJs, 'findFocusSet'),
    extractFunctionSource(mainJs, 'setsForThread'),
    extractFunctionSource(mainJs, 'isPicked'),
    extractFunctionSource(mainJs, 'toggleSetPick'),
    extractFunctionSource(mainJs, 'isDormantThread'),
    extractFunctionSource(mainJs, 'covenRootDepth'),
    extractFunctionSource(mainJs, 'covenProjectCandidate'),
    extractFunctionSource(mainJs, 'compareCovenProjectCandidates'),
    extractFunctionSource(mainJs, 'covenSessionAssignments'),
    extractFunctionSource(mainJs, 'covenSessionsForProject'),
    extractFunctionSource(mainJs, 'covenInlineState'),
    extractFunctionSource(mainJs, 'covenToneClass'),
    extractFunctionSource(mainJs, 'sessionGitState'),
    extractFunctionSource(mainJs, 'sessionLaneLabel'),
    extractFunctionSource(mainJs, 'sessionSetSwatches'),
    extractFunctionSource(mainJs, 'disarmSessionClose'),
    extractFunctionSource(mainJs, 'armSessionClose'),
    extractFunctionSource(mainJs, 'threadCovenSessionId'),
    extractFunctionSource(mainJs, 'isReusableCovenAttachment'),
    extractFunctionSource(mainJs, 'createCovenSessionRow'),
    extractFunctionSource(mainJs, 'renderSessionList'),
  ];
  const harness = Function(
    'document', 'sessionListEl', 'editingContext', 'sessionFilter', 'state',
    'covenDiscovery', 'PsycheSessions', 'sessionStatusClass', 'shortenRoot',
    'escapeHtml', 'setActiveProject', 'focusThread', 'closeThread', 'hideThread',
    'renameThread', 'editLabelInline', 'openCovenSession', 'setStatus',
    'canvasThreadIds', 'paneGlyphFor', 'setInterval', 'clearInterval',
    'seedFocusSets', 'seedSetPicking', 'refreshSidebar', 'activeFocusSet',
    'removeFromFocusSet', 'applySetScopeForThread', 'activateFocusSet', 'clearFocusSet',
    `"use strict"; ${sources.join('\n')}; return {
      render: renderSessionList,
      setFilter: function (value) { sessionFilter = value; },
      setDiscovery: function (value) { covenDiscovery = value; },
      armSessionClose: armSessionClose,
      disarmSessionClose: disarmSessionClose,
      toggleSetPick: toggleSetPick,
      picked: function () { return setPicking ? setPicking.picked.slice() : null; }
    };`,
  )(
    document,
    sessionListEl,
    null,
    options.filter ?? '',
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
    hideThread,
    renameThread,
    editLabelInlineImpl,
    openCovenSession,
    setStatus,
    canvasThreadIds,
    paneGlyphFor,
    setInterval,
    clearInterval,
    focusSets,
    options.setPicking ?? null,
    () => { harness.render(); },
    () => scopingSet,
    removeFromFocusSet,
    applySetScopeForThread,
    activateFocusSet,
    clearFocusSet,
  ) as {
    render: () => void;
    setFilter: (value: string) => void;
    setDiscovery: (value: typeof discovery) => void;
    armSessionClose: (
      wrapper: FakeElement, close: FakeElement, thread: { id: string; name: string },
    ) => void;
    disarmSessionClose: () => void;
    toggleSetPick: (threadId: string) => void;
    picked: () => string[] | null;
  };

  return {
    ...harness,
    document,
    sessionListEl,
    state,
    discovery,
    focusSets,
    removeFromFocusSet,
    applySetScopeForThread,
    activateFocusSet,
    clearFocusSet,
    setActiveProject,
    focusThread,
    closeThread,
    hideThread,
    renameThread,
    editLabelInline,
    openCovenSession,
    setStatus,
    canvasThreadIds,
  };
}

function textOf(elements: FakeElement[]) {
  return elements.map((element) => element.textContent);
}

describe('Tauri Coven session project rail', () => {
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

  it('renders local and daemon sessions as distinct subsections and identities', () => {
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
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-subsection-label')))
      .toEqual(['Agents', 'Coven']);
    expect(renderer.sessionListEl.querySelector('.session-row')?.dataset.threadId)
      .toBe('attached');
    const covenRow = renderer.sessionListEl.querySelector('.session-coven-row');
    expect(covenRow?.dataset.sessionId).toBe('remote');
    expect(covenRow?.title).toBe('Focus attachment');
    const badges = renderer.sessionListEl.querySelectorAll('.session-attention-badge');
    expect(badges).not.toHaveLength(0);
    expect(badges.at(-1)?.title).toBe('Waiting for input');
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

    expect(renderer.sessionListEl.querySelectorAll('.session-coven-row')).toHaveLength(1);
    expect(renderer.sessionListEl.querySelector('.session-coven-row')?.dataset.sessionId)
      .toBe('visible');
    expect(renderer.sessionListEl.querySelectorAll('.session-row').map((row) => row.dataset.threadId))
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
    expect(renderer.sessionListEl.querySelectorAll('.session-coven-row')).toHaveLength(1);
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-attention-badge')))
      .toEqual(['1', '1', '!']);
  });

  it.each([
    [parentProject, taskProject],
    [taskProject, parentProject],
  ])('assigns an overlapping worktree session to its exact saved project regardless of project order',
    (...projects) => {
      const renderer = createRenderer({ projects, sessions: [ownedWorktreeSession] });

      renderer.render();

      expect(renderer.sessionListEl.querySelectorAll('.session-coven-row')).toHaveLength(1);
      expect(renderer.sessionListEl.querySelector('.session-coven-row')?.dataset.sessionId)
        .toBe('owned-worktree-session');
      expect(textOf(renderer.sessionListEl.querySelectorAll('.session-group-head')))
        .toEqual(['Task']);
    });

  it('keeps a worktree session under its parent when only the parent project is saved', () => {
    const renderer = createRenderer({
      projects: [parentProject],
      sessions: [ownedWorktreeSession],
    });

    renderer.render();

    expect(renderer.sessionListEl.querySelectorAll('.session-coven-row')).toHaveLength(1);
    expect(renderer.sessionListEl.querySelector('.session-coven-row')?.dataset.sessionId)
      .toBe('owned-worktree-session');
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-group-head')))
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

      expect(renderer.sessionListEl.querySelectorAll('.session-coven-row')).toHaveLength(1);
      expect(renderer.sessionListEl.querySelector('.session-coven-row')?.dataset.sessionId)
        .toBe('owned-worktree-session');
      expect(textOf(renderer.sessionListEl.querySelectorAll('.session-group-head')))
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

      expect(renderer.sessionListEl.querySelectorAll('.session-coven-row')).toHaveLength(1);
      expect(textOf(renderer.sessionListEl.querySelectorAll('.session-group-head')))
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

      expect(renderer.sessionListEl.querySelectorAll('.session-coven-row')).toHaveLength(0);
      expect(renderer.sessionListEl.querySelectorAll('.session-group-head')).toHaveLength(0);
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

    expect(renderer.sessionListEl.querySelectorAll('.session-coven-row')).toHaveLength(0);
    expect(renderer.sessionListEl.querySelectorAll('.session-group-head')).toHaveLength(0);
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

    expect(renderer.sessionListEl.querySelectorAll('.session-coven-row')).toHaveLength(1);
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-group-head')))
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

    expect(renderer.sessionListEl.querySelectorAll('.session-coven-row')).toHaveLength(1);
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-group-head')))
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

      expect(renderer.sessionListEl.querySelectorAll('.session-coven-row')).toHaveLength(1);
      expect(textOf(renderer.sessionListEl.querySelectorAll('.session-group-head')))
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
    const row = renderer.sessionListEl.querySelector('.session-coven-row');
    expect(row?.title).toBe('Attach');
    await row?.emit('click');
    expect(renderer.openCovenSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'alpha' }),
      expect.objectContaining({ id: 'remote' }),
    );
    expect(extractFunctionSource(mainJs, 'createCovenSessionRow'))
      .not.toContain('typeof openCovenSession');
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
    expect(renderer.sessionListEl.querySelector('.session-coven-row')).not.toBeNull();
    expect(renderer.sessionListEl.querySelectorAll('.session-inline-state')).toHaveLength(1);
    expect(renderer.sessionListEl.querySelector('.session-inline-state')?.textContent)
      .toContain('Daemon offline');
    expect(renderer.sessionListEl.querySelector('.session-inline-state')?.className)
      .toContain('coven-tone-warn');
  });

  it('renders one global loading state across filtered nonmatching projects', () => {
    const renderer = createRenderer({
      projects: [
        { id: 'alpha', name: 'Alpha', root: '/alpha' },
        { id: 'beta', name: 'Beta', root: '/beta' },
      ],
      phase: 'loading',
      filter: 'not-a-project',
    });

    renderer.render();
    expect(renderer.sessionListEl.querySelectorAll('.session-inline-state')).toHaveLength(1);
    expect(renderer.sessionListEl.querySelector('.session-inline-state')?.textContent)
      .toBe('Loading Coven sessions');
    expect(renderer.sessionListEl.querySelector('.session-group')).toBeNull();
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
      .toEqual(['live', 'starting', 'crashed']);
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

  it('groups local threads by pane kind, in input order, without empty project headers', () => {
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
    expect(groups).toHaveLength(1);
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-subsection-label')))
      .toEqual(['Agents', 'Shells']);
    expect(groups[0].querySelectorAll('.session-row').map((row) => row.dataset.threadId))
      .toEqual(['attached', 'local']);
  });

  it('renders one global error across filtered nonmatching projects', () => {
    const renderer = createRenderer({
      projects: [
        { id: 'alpha', name: 'Alpha', root: '/alpha' },
        { id: 'beta', name: 'Beta', root: '/beta' },
      ],
      phase: 'error',
      message: 'Discovery failed',
      filter: 'not-a-project',
    });

    renderer.render();
    expect(renderer.sessionListEl.querySelectorAll('.session-inline-state')).toHaveLength(1);
    expect(renderer.sessionListEl.querySelector('.session-inline-state')?.textContent)
      .toBe('Discovery failed');
    expect(renderer.sessionListEl.querySelector('.session-group')).toBeNull();
    expect(renderer.sessionListEl.querySelector('.session-empty')).toBeNull();
  });

  it('treats idle discovery as silent and preserves the filtered empty state', () => {
    const renderer = createRenderer({
      projects: [
        { id: 'alpha', name: 'Alpha', root: '/alpha' },
        { id: 'beta', name: 'Beta', root: '/beta' },
      ],
      phase: 'idle',
      filter: 'not-a-project',
    });

    renderer.render();
    expect(renderer.sessionListEl.querySelector('.session-inline-state')).toBeNull();
    expect(renderer.sessionListEl.querySelector('.session-empty')?.textContent)
      .toBe('No sessions match “not-a-project”');
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
    const worktrees = renderer.sessionListEl.querySelectorAll('.session-worktree-group');
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].querySelector('.session-row')?.dataset.threadId).toBe('local-feature');
    const badges = renderer.sessionListEl.querySelectorAll('.session-attention-badge');
    expect(textOf(badges)).toEqual(['2', '2', '!']);
    expect(badges[0].getAttribute('aria-label')).toBe('2 sessions need attention');
    expect(badges[1].getAttribute('aria-label'))
      .toBe('2 sessions need attention in this worktree');
    expect(badges[2].title).toBe('Waiting for input');
  });

  it('omits a project when its only worktree session is hidden', () => {
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
    expect(groups).toHaveLength(1);
    expect(groups[0].textContent).toContain('Beta');
    expect(renderer.sessionListEl.textContent).not.toContain('Alpha');
    expect(renderer.sessionListEl.querySelectorAll('.session-worktree-group')).toHaveLength(1);
    expect(renderer.sessionListEl.querySelector('.session-row')?.dataset.threadId)
      .toBe('visible-beta');
  });

  it('keeps unresolved sessions visible because their fallback group is populated', () => {
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

    expect(renderer.sessionListEl.querySelectorAll('.session-worktree-group')).toHaveLength(1);
    expect(renderer.sessionListEl.querySelector('.session-worktree-head')?.title)
      .toBe('Sessions with no available worktree');
    expect(renderer.sessionListEl.querySelector('.session-row')?.dataset.threadId).toBe('orphan');
  });

  it('searches local and daemon session metadata', () => {
    const renderer = createRenderer({
      threads: [{ id: 'local', projectId: 'alpha', name: 'Review locally', status: 'running' }],
      sessions: [{
        id: 'daemon', projectRoot: '/alpha', title: 'Ship release', status: 'waiting',
        labels: ['source:psyche-build'],
      }],
    });

    renderer.setFilter('ship');
    renderer.render();
    expect(renderer.sessionListEl.querySelector('.session-coven-row')?.dataset.sessionId)
      .toBe('daemon');

    renderer.setFilter('review');
    renderer.render();
    expect(renderer.sessionListEl.querySelector('.session-row')?.dataset.threadId).toBe('local');
  });

  it('does not reveal an empty worktree when its branch matches the search', () => {
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
    });

    renderer.setFilter('main');
    renderer.render();

    expect(renderer.sessionListEl.querySelector('.session-worktree-group')).toBeNull();
    expect(renderer.sessionListEl.querySelector('.session-empty')?.textContent)
      .toBe('No sessions match “main”');
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
    expect(localRow.tagName).toBe('BUTTON');
    expect(localRow.type).toBe('button');
    expect(localRow.parentNode).toBe(wrapper);
    expect(close?.parentNode).toBe(wrapper);
    expect(localRow.querySelector('.session-close')).toBeNull();
    expect(localRow.getAttribute('role')).toBeNull();
    expect(localRow.getAttribute('aria-selected')).toBeNull();
    expect(localRow.classList.contains('active')).toBe(true);
    expect(localRow.getAttribute('aria-current')).toBe('true');
    await localRow.emit('click');
    expect(renderer.setActiveProject).toHaveBeenCalledWith('alpha');
    expect(renderer.focusThread).toHaveBeenCalledWith('local');

    const closeEvent = await close?.emit('click');
    expect(renderer.hideThread).toHaveBeenCalledWith('local');
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
      .toBe('No matching projects, worktrees, or panes.');
  });

  it('marks rows that hold a pane-tree leaf and detaches them without killing the process', async () => {
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
    expect(close?.title).toBe('Hide the pane — the session keeps running');

    // hideThread detaches the leaf and leaves the PTY running, so the row stays
    // reopenable rather than being a destructive close.
    await close?.emit('click');
    expect(renderer.hideThread).toHaveBeenCalledWith('local');
    expect(renderer.closeThread).not.toHaveBeenCalled();
  });

  it('omits the canvas marker for rows with no pane on the canvas', () => {
    const renderer = createRenderer({
      threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
    });
    renderer.render();

    const wrapper = renderer.sessionListEl.querySelector('.session-row-wrap');
    expect(wrapper?.querySelector('.session-row')?.querySelector('.session-oncanvas')).toBeNull();
    expect(wrapper?.querySelector('.session-close')?.title).toBe('Hide session');
  });

  it('leads each row with the lane\'s git state and names the branch in the meta line', () => {
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

    const glyph = renderer.sessionListEl.querySelector('.session-glyph');
    expect(glyph?.textContent).toBe('±');
    expect(glyph?.className).toContain('git-dirty');
    // Colour is never the only carrier: the tooltip says the same thing.
    const html = renderer.sessionListEl.querySelector('.session-row')?.innerHTML ?? '';
    expect(html).toContain('title="Uncommitted changes"');
    // The kind lives in the meta line now that the glyph carries git state.
    expect(renderer.sessionListEl.querySelector('.session-sub')?.textContent)
      .toBe('shell · feat/tiling');
  });

  it('marks a clean lane without implying there is work in it', () => {
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

    const glyph = renderer.sessionListEl.querySelector('.session-glyph');
    expect(glyph?.textContent).toBe('⎇');
    expect(glyph?.className).toContain('git-clean');
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

    it('turns rows into checkboxes while picking, without focusing anything', async () => {
      const renderer = createRenderer({
        threads,
        setPicking: { key, picked: ['local'] },
      });
      renderer.render();

      const rows = renderer.sessionListEl.querySelectorAll('.session-row');
      expect(rows[0].classList.contains('is-picked')).toBe(true);
      expect(rows[0].getAttribute('aria-pressed')).toBe('true');
      expect(rows[1].classList.contains('is-picking')).toBe(true);
      expect(rows[1].getAttribute('aria-pressed')).toBe('false');
      expect(rows[1].title).toBe('Include Other in the set');

      await rows[1].emit('click');

      // Picking must not drag the canvas around under the user.
      expect(renderer.focusThread).not.toHaveBeenCalled();
      expect(renderer.picked()).toEqual(['local', 'other']);
    });

    it('turns × into "remove from set" while a set scopes the canvas', async () => {
      const renderer = createRenderer({
        threads,
        focusSets: [memberSet],
        scopingSet: { id: 'set-1', name: 'Review', threadIds: ['local'] },
      });
      renderer.render();

      const wrappers = renderer.sessionListEl.querySelectorAll('.session-row-wrap');
      const close = wrappers[0].querySelector('.session-close');
      expect(close?.title).toBe('Remove from Review — the pane stays open');

      await close?.emit('click');

      expect(renderer.removeFromFocusSet).toHaveBeenCalledWith('set-1', 'local');
      // The pane is not going anywhere — only its membership changed.
      expect(renderer.hideThread).not.toHaveBeenCalled();
      expect(renderer.closeThread).not.toHaveBeenCalled();
    });

    it('leaves × as hide for a pane the scoping set does not contain', async () => {
      const renderer = createRenderer({
        threads,
        focusSets: [memberSet],
        scopingSet: { id: 'set-1', name: 'Review', threadIds: ['local'] },
      });
      renderer.render();

      const wrappers = renderer.sessionListEl.querySelectorAll('.session-row-wrap');
      await wrappers[1].querySelector('.session-close')?.emit('click');

      expect(renderer.hideThread).toHaveBeenCalledWith('other');
      expect(renderer.removeFromFocusSet).not.toHaveBeenCalled();
    });

    it('returns to all panes when the project header is clicked', async () => {
      const renderer = createRenderer({ threads, focusSets: [memberSet] });
      renderer.render();

      await renderer.sessionListEl.querySelector('.session-group-head')?.emit('click');

      expect(renderer.clearFocusSet).toHaveBeenCalled();
    });
  });

  describe('timed close confirm', () => {
    function armed() {
      const renderer = createRenderer({
        threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
      });
      renderer.render();
      const wrapper = renderer.sessionListEl.querySelector('.session-row-wrap')!;
      const close = wrapper.querySelector('.session-close')!;
      renderer.armSessionClose(wrapper, close, { id: 'local', name: 'Local' });
      return { renderer, wrapper, close };
    }

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('replaces the × with a counting confirm instead of closing', () => {
      const { renderer, wrapper, close } = armed();

      const confirm = wrapper.querySelector('.session-close-confirm');
      expect(confirm?.textContent).toBe('Close · 3');
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

    it('cancels itself when the countdown runs out', () => {
      const { renderer, wrapper, close } = armed();

      vi.advanceTimersByTime(3000);

      expect(wrapper.querySelector('.session-close-confirm')).toBeNull();
      expect(close.hidden).toBe(false);
      expect(renderer.closeThread).not.toHaveBeenCalled();
    });

    it('drops an armed confirm when the sidebar re-renders under it', () => {
      const { renderer, wrapper } = armed();

      renderer.render();

      expect(wrapper.querySelector('.session-close-confirm')).toBeNull();
      expect(renderer.closeThread).not.toHaveBeenCalled();
      // The stale interval must not resurrect anything after the re-render.
      vi.advanceTimersByTime(5000);
      expect(renderer.closeThread).not.toHaveBeenCalled();
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
    expect(close?.parentNode).toBe(wrapper);
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
    expect(activation?.getAttribute('tabindex')).toBeNull();
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
    expect(rerenderedActivation?.getAttribute('tabindex')).toBeNull();
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
    expect(styles).toMatch(/\.session-row-wrap:focus-within\s+\.session-close/);
    expect(styles).toMatch(/\.session-close:focus-visible\s*\{[^}]*opacity:\s*1;[^}]*outline:/s);
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
    expect(styles).toMatch(/\.session-close-confirm\s*\{[^}]*animation:\s*close-confirm-slide/s);
    expect(styles).toMatch(/\.session-row-wrap\s*\{[^}]*position:\s*relative;/s);
    expect(styles).toMatch(/\.session-row\.inline-edit-hidden\s*\{[^}]*visibility:\s*hidden;/s);
    expect(styles).toMatch(/\.session-row-wrap\s*>\s*\.inline-edit\s*\{[^}]*position:\s*absolute;/s);
    expect(styles).toContain('.session-coven-row');
    expect(styles).toContain('.coven-tone-ok');
    expect(styles).toContain('.session-inline-state');
    const rendererSource = extractFunctionSource(mainJs, 'renderSessionList');
    expect(rendererSource).toContain('PsycheSessions.buildProjectRailModel');
    expect(rendererSource).toContain('project, localRows, remoteRows, currentSearchQuery');
    expect(rendererSource).toContain('covenDiscovery');
    expect(rendererSource).toContain('createCovenSessionRow');
    expect(rendererSource).not.toContain('treeitem');
    expect(rendererSource).not.toContain('aria-selected');
  });

  it('uses honest navigation semantics instead of an unimplemented ARIA tree', () => {
    expect(indexHtml).toContain(
      '<div class="session-list" id="session-list" role="navigation" aria-label="Sessions grouped by project"></div>',
    );
    expect(indexHtml).not.toMatch(/id="session-list"[^>]*role="tree"/);
    const rendererSource = extractFunctionSource(mainJs, 'renderSessionList');
    expect(rendererSource).not.toContain('role", "treeitem');
    expect(rendererSource).not.toContain('aria-selected');
  });
});
