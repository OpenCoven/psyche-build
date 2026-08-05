import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const repoRoot = process.cwd();
const mainJs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);
const styles = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/styles.css'),
  'utf8',
);
const indexHtml = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/index.html'),
  'utf8',
);
const PsycheSessions = await import(
  pathToFileURL(join(
    repoRoot,
    'native/macos/psyche-build-tauri/web/sessions/session-model.mjs',
  )).href,
);

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
    const dot = new FakeElement('span');
    dot.className = 'session-dot';
    const text = new FakeElement('span');
    text.className = 'session-text';
    const titleElement = new FakeElement('span');
    titleElement.className = 'session-title';
    titleElement.textContent = decodeHtml(title[1]);
    const subElement = new FakeElement('span');
    subElement.className = 'session-sub';
    subElement.textContent = decodeHtml(sub[1]);
    text.appendChild(titleElement);
    text.appendChild(subElement);
    this.appendChild(dot);
    this.appendChild(text);
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
  covenSessionId?: string | null;
  worktreePath?: string;
  kind?: string;
};
type RemoteSession = {
  id: string;
  projectRoot: string;
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
  filter?: string;
  activeProjectId?: string | null;
  activeThreadId?: string | null;
  openCovenSession?: (project: Project, session: RemoteSession) => unknown;
  realEdit?: boolean;
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

  const sources = [
    'function covenInlineState() { return null; }',
    'function covenToneClass() { return ""; }',
    extractFunctionSource(mainJs, 'renderSessionList'),
  ];
  const harness = Function(
    'document', 'sessionListEl', 'editingContext', 'sessionFilter', 'state',
    'covenDiscovery', 'PsycheSessions', 'sessionStatusClass', 'shortenRoot',
    'escapeHtml', 'setActiveProject', 'focusThread', 'closeThread', 'hideThread',
    'renameThread', 'editLabelInline', 'openCovenSession', 'setStatus',
    `"use strict"; ${sources.join('\n')}; return {
      render: renderSessionList,
      setFilter: function (value) { sessionFilter = value; },
      setDiscovery: function (value) { covenDiscovery = value; }
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
  ) as {
    render: () => void;
    setFilter: (value: string) => void;
    setDiscovery: (value: typeof discovery) => void;
  };

  return {
    ...harness,
    document,
    sessionListEl,
    state,
    discovery,
    setActiveProject,
    focusThread,
    closeThread,
    hideThread,
    renameThread,
    editLabelInline,
    openCovenSession,
    setStatus,
  };
}

function textOf(elements: FakeElement[]) {
  return elements.map((element) => element.textContent);
}

describe('Tauri Coven session project rail', () => {
  it('renders only local threads in input order while preserving open project headers', () => {
    const renderer = createRenderer({
      projects: [
        { id: 'alpha', name: 'Alpha', root: '/alpha' },
        { id: 'beta', name: 'Beta', root: '/beta' },
      ],
      threads: [
        { id: 'local', projectId: 'alpha', name: 'Local plan', status: 'running' },
        {
          id: 'attached', projectId: 'alpha', name: 'Existing attachment', status: 'running',
          kind: 'coven', covenSessionId: 'alpha-daemon',
        },
      ],
      sessions: [
        { id: 'alpha-daemon', projectRoot: '/alpha', title: 'Alpha daemon', status: 'running' },
        { id: 'beta-daemon', projectRoot: '/beta', title: 'Beta daemon', status: 'waiting' },
      ],
    });

    renderer.render();

    const groups = renderer.sessionListEl.querySelectorAll('.session-group');
    expect(groups).toHaveLength(2);
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-subsection-label')))
      .toEqual(['Psyche']);
    expect(groups[0].querySelectorAll('.session-row').map((row) => row.dataset.threadId))
      .toEqual(['local', 'attached']);
    expect(renderer.sessionListEl.querySelectorAll('.session-coven-row')).toHaveLength(0);
    expect(renderer.sessionListEl.textContent).not.toContain('Alpha daemon');
    expect(renderer.sessionListEl.textContent).not.toContain('Beta daemon');
  });

  it('does not let a daemon-only project change the normal empty worktree presentation', () => {
    const renderer = createRenderer({
      sessions: [{ id: 'daemon', projectRoot: '/alpha', title: 'Remote', status: 'running' }],
    });

    renderer.render();

    expect(renderer.sessionListEl.querySelector('.session-coven-row')).toBeNull();
    expect(renderer.sessionListEl.textContent).not.toContain('Remote');
    expect(renderer.sessionListEl.querySelector('.session-worktree-empty')?.textContent)
      .toBe('No panes — select and press ⌘T');
    expect(renderer.openCovenSession).not.toHaveBeenCalled();
  });

  it('keeps local worktree ownership and attention independent of daemon sessions', () => {
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
      }],
    });

    renderer.render();

    const worktrees = renderer.sessionListEl.querySelectorAll('.session-worktree-group');
    expect(worktrees).toHaveLength(2);
    expect(worktrees[0].querySelectorAll('.session-row')).toHaveLength(0);
    expect(worktrees[1].querySelector('.session-row')?.dataset.threadId).toBe('local-feature');
    const badges = renderer.sessionListEl.querySelectorAll('.session-attention-badge');
    expect(textOf(badges)).toEqual(['1', '1']);
    expect(badges[0].getAttribute('aria-label')).toBe('1 sessions need attention');
    expect(badges[1].getAttribute('aria-label'))
      .toBe('1 sessions need attention in this worktree');
  });

  it('searches only local thread metadata', () => {
    const renderer = createRenderer({
      threads: [{ id: 'local', projectId: 'alpha', name: 'Review locally', status: 'running' }],
      sessions: [{
        id: 'daemon', projectRoot: '/alpha', title: 'Ship release', status: 'waiting',
      }],
    });

    renderer.setFilter('ship');
    renderer.render();
    expect(renderer.sessionListEl.querySelector('.session-group')).toBeNull();
    expect(renderer.sessionListEl.querySelector('.session-empty')?.textContent)
      .toBe('No sessions match “ship”');

    renderer.setFilter('review');
    renderer.render();
    expect(renderer.sessionListEl.querySelector('.session-row')?.dataset.threadId).toBe('local');
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
    expect(empty.sessionListEl.querySelector('.session-worktree-empty')?.textContent)
      .toBe('No panes — select and press ⌘T');
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

  it('keeps local row controls and a local-only render path', () => {
    expect(styles).toMatch(/\.session-subsection-label\s*\{[^}]*text-transform:\s*uppercase;[^}]*letter-spacing:/s);
    expect(styles).toMatch(/\.session-row-wrap\s*\{[^}]*position:\s*relative;/s);
    expect(styles).toMatch(/\.session-row\.inline-edit-hidden\s*\{[^}]*visibility:\s*hidden;/s);
    expect(styles).toMatch(/\.session-row-wrap\s*>\s*\.inline-edit\s*\{[^}]*position:\s*absolute;/s);
    expect(styles).toMatch(/\.session-row-wrap:focus-within\s+\.session-close/);
    expect(styles).toMatch(/\.session-close:focus-visible\s*\{[^}]*opacity:\s*1;[^}]*outline:/s);
    expect(styles).toMatch(/\.session-row-wrap:hover\s+\.session-row:not\(\.active\)/);
    expect(styles).not.toMatch(/\.session-row-wrap:hover\s+\.session-row\s*\{/);
    expect(styles).toMatch(/\.session-row-wrap\s*\{[^}]*position:\s*relative;/s);
    expect(styles).toMatch(/\.session-row\.inline-edit-hidden\s*\{[^}]*visibility:\s*hidden;/s);
    expect(styles).toMatch(/\.session-row-wrap\s*>\s*\.inline-edit\s*\{[^}]*position:\s*absolute;/s);
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
