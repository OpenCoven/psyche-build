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

function optionalFunctionSource(source: string, name: string, fallback: string) {
  return source.includes(`function ${name}(`)
    ? extractFunctionSource(source, name)
    : fallback;
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

  constructor(tagName: string) {
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
    // markup path. Parse only that small fixed shape; remote rows must use the
    // DOM/textContent path and never reach this parser.
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

  createElement(tagName: string) {
    const element = new FakeElement(tagName);
    this.created.push(element);
    return element;
  }
}

type Project = { id: string; name: string; root: string };
type LocalThread = {
  id: string;
  projectId: string;
  name: string;
  status?: string;
  spawning?: boolean;
  covenSessionId?: string | null;
};
type RemoteSession = {
  id: string;
  projectRoot: string;
  title?: string;
  harness?: string;
  status?: string;
  updatedAt?: string;
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
    optionalFunctionSource(
      mainJs,
      'covenInlineState',
      'function covenInlineState() { return null; }',
    ),
    optionalFunctionSource(
      mainJs,
      'covenToneClass',
      'function covenToneClass() { return ""; }',
    ),
    extractFunctionSource(mainJs, 'renderSessionList'),
  ];
  const harness = Function(
    'document', 'sessionListEl', 'editingContext', 'sessionFilter', 'state',
    'covenDiscovery', 'PsycheSessions', 'sessionStatusClass', 'shortenRoot',
    'escapeHtml', 'setActiveProject', 'focusThread', 'closeThread',
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
  it('renders project-scoped Psyche and Coven subsections in model sort order', () => {
    const renderer = createRenderer({
      projects: [
        { id: 'alpha', name: 'Alpha', root: '/alpha' },
        { id: 'beta', name: 'Beta', root: '/beta' },
      ],
      threads: [{ id: 'local-1', projectId: 'alpha', name: 'Local plan', status: 'running' }],
      sessions: [
        { id: 'done', projectRoot: '/alpha', title: 'Done remote', status: 'completed', updatedAt: '2026-08-04T12:00:00Z' },
        { id: 'live', projectRoot: '/alpha', title: 'Live remote', harness: 'coven-code', status: 'running', updatedAt: '2026-08-04T10:00:00Z' },
        { id: 'beta-only', projectRoot: '/beta', title: 'Beta remote', status: 'waiting' },
      ],
    });

    renderer.render();

    const groups = renderer.sessionListEl.querySelectorAll('.session-group');
    expect(groups).toHaveLength(2);
    expect(textOf(groups[0].querySelectorAll('.session-subsection-label'))).toEqual(['Psyche', 'Coven']);
    expect(groups[0].querySelectorAll('.session-row').map((row) => (
      row.dataset.threadId ?? row.dataset.covenSessionId
    ))).toEqual(['local-1', 'live', 'done']);
    expect(groups[1].querySelectorAll('.session-coven-row').map((row) => row.dataset.covenSessionId))
      .toEqual(['beta-only']);
    expect(groups[0].textContent).not.toContain('Beta remote');
  });

  it('omits a healthy empty Coven subsection and still renders remote-only projects', () => {
    const localOnly = createRenderer({
      threads: [{ id: 'local', projectId: 'alpha', name: 'Local', status: 'running' }],
    });
    localOnly.render();
    expect(textOf(localOnly.sessionListEl.querySelectorAll('.session-subsection-label')))
      .toEqual(['Psyche']);

    const remoteOnly = createRenderer({
      sessions: [{ id: 'remote', projectRoot: '/alpha', title: 'Remote', status: 'running' }],
    });
    remoteOnly.render();
    expect(textOf(remoteOnly.sessionListEl.querySelectorAll('.session-subsection-label')))
      .toEqual(['Coven']);
    expect(remoteOnly.sessionListEl.querySelector('.session-coven-row')?.dataset.covenSessionId)
      .toBe('remote');
  });

  it('delegates project, local-title, and remote field searches to the shared model', () => {
    const renderer = createRenderer({
      projects: [{ id: 'alpha', name: 'Alpha Project', root: '/alpha' }],
      threads: [{ id: 'local', projectId: 'alpha', name: 'Review locally', status: 'running' }],
      sessions: [{
        id: 'remote-id', projectRoot: '/alpha', title: 'Ship release',
        harness: 'coven-code', status: 'waiting',
      }],
    });

    for (const query of ['alpha', 'review', 'ship', 'coven-code', 'waiting', 'remote-id']) {
      renderer.setFilter(query);
      renderer.render();
      expect(renderer.sessionListEl.querySelectorAll('.session-group'), query).toHaveLength(1);
    }
    renderer.setFilter('alpha');
    renderer.render();
    expect(renderer.sessionListEl.querySelectorAll('.session-row')).toHaveLength(2);

    renderer.setFilter('missing');
    renderer.render();
    expect(renderer.sessionListEl.querySelector('.session-group')).toBeNull();
    expect(renderer.sessionListEl.querySelector('.session-empty')?.textContent)
      .toBe('No sessions match “missing”');
  });

  it.each([
    ['loading', null, 'Coven — loading…', null],
    ['unavailable', 'private ignored detail', 'Coven unavailable', 'Coven daemon is not running; run `coven daemon start`'],
    ['incompatible', 'private ignored detail', 'Coven update required', 'Coven daemon API update required'],
    ['error', 'private ignored detail', 'Coven could not load', 'Coven sessions could not be loaded'],
  ])('renders the %s inline state exactly once per project', (phase, message, copy, title) => {
    const renderer = createRenderer({
      projects: [
        { id: 'alpha', name: 'Alpha', root: '/alpha' },
        { id: 'beta', name: 'Beta', root: '/beta' },
      ],
      phase,
      message,
    });

    renderer.render();

    const states = renderer.sessionListEl.querySelectorAll('.session-inline-state');
    expect(states).toHaveLength(2);
    expect(textOf(states)).toEqual([copy, copy]);
    expect(states.map((state) => state.title || null)).toEqual([title, title]);
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-subsection-label')))
      .toEqual(['Coven', 'Coven']);
  });

  it('does not turn state copy into a search result and replaces errors on ready recovery', () => {
    const renderer = createRenderer({ phase: 'error', filter: 'could not load' });
    renderer.render();
    expect(renderer.sessionListEl.querySelector('.session-group')).toBeNull();

    renderer.setFilter('alpha');
    renderer.render();
    expect(renderer.sessionListEl.querySelector('.session-inline-state')?.textContent)
      .toBe('Coven could not load');
    expect(renderer.sessionListEl.querySelector('.session-empty')).toBeNull();

    renderer.setFilter('');
    renderer.setDiscovery({
      phase: 'ready',
      sessionsByProject: PsycheSessions.groupCovenSessions([
        { id: 'recovered', projectRoot: '/alpha', title: 'Recovered', status: 'running' },
      ]),
      message: null,
      requestId: 2,
      refreshedAt: 2,
    });
    renderer.render();
    expect(renderer.sessionListEl.querySelector('.session-inline-state')).toBeNull();
    expect(renderer.sessionListEl.querySelector('.session-coven-row')?.dataset.covenSessionId)
      .toBe('recovered');
  });

  it('marks only the active non-exited local attachment and reports remote open failures', async () => {
    const renderer = createRenderer({
      activeThreadId: 'attached',
      threads: [{
        id: 'attached', projectId: 'alpha', name: 'Attachment', status: 'running',
        covenSessionId: 'remote',
      }],
      sessions: [{ id: 'remote', projectRoot: '/alpha', title: 'Remote', status: 'waiting' }],
      openCovenSession: () => Promise.reject(new Error('private payload')),
    });
    renderer.render();
    const remote = renderer.sessionListEl.querySelector('.session-coven-row');
    expect(remote?.classList.contains('active')).toBe(true);
    expect(remote?.getAttribute('aria-current')).toBe('true');
    expect(remote?.getAttribute('aria-selected')).toBeNull();
    expect(remote?.getAttribute('role')).toBeNull();

    await remote?.emit('click');
    await Promise.resolve();
    expect(renderer.openCovenSession).toHaveBeenCalledWith(
      renderer.state.projects[0],
      expect.objectContaining({ id: 'remote' }),
    );
    expect(renderer.setStatus).toHaveBeenCalledWith('Coven session could not be opened', 'error');
    expect(remote?.querySelector('.session-close')).toBeNull();
    await remote?.emit('dblclick');
    expect(renderer.closeThread).not.toHaveBeenCalled();
    expect(renderer.editLabelInline).not.toHaveBeenCalled();
  });

  it('does not mark an exited attachment active', () => {
    const renderer = createRenderer({
      activeThreadId: 'attached',
      threads: [{
        id: 'attached', projectId: 'alpha', name: 'Attachment', status: 'exited',
        covenSessionId: 'remote',
      }],
      sessions: [{ id: 'remote', projectRoot: '/alpha', title: 'Remote', status: 'running' }],
    });
    renderer.render();
    const remote = renderer.sessionListEl.querySelector('.session-coven-row');
    expect(remote?.classList.contains('active')).toBe(false);
    expect(remote?.getAttribute('aria-current')).toBeNull();
    expect(remote?.getAttribute('aria-selected')).toBeNull();
  });

  it('uses textContent for all daemon text and presents fixed status classes', () => {
    const maliciousTitle = '<img src=x onerror=alert(1)>';
    const renderer = createRenderer({
      sessions: [{
        id: 'script:onerror', projectRoot: '/alpha', title: maliciousTitle,
        harness: '  coven-code  ', status: '  Custom State  ',
      }],
    });
    renderer.render();
    const remote = renderer.sessionListEl.querySelector('.session-coven-row');
    expect(remote?.dataset.covenSessionId).toBe('script:onerror');
    expect(remote?.querySelector('.session-title')?.textContent).toBe(maliciousTitle);
    expect(remote?.querySelector('.session-coven-meta')?.textContent)
      .toBe('coven-code · custom state · script:onerror');
    expect(remote?.querySelector('.session-coven-status')?.textContent).toBe('custom state');
    expect(remote?.querySelector('.session-coven-harness')?.textContent).toBe('coven-code');
    expect(remote?.querySelector('.session-coven-id')?.textContent).toBe('script:onerror');
    expect(remote?.classList.contains('coven-tone-neutral')).toBe(true);
    expect(remote?.getAttribute('aria-label')).toContain('custom state');
    expect(renderer.document.created.some((element) => element.tagName === 'IMG')).toBe(false);
    expect(renderer.document.created.flatMap((element) => element.innerHtmlAssignments))
      .not.toContain(expect.stringContaining(maliciousTitle));
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
    expect(renderer.closeThread).toHaveBeenCalledWith('local');
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
    expect(empty.sessionListEl.querySelector('.session-empty')?.textContent)
      .toBe('No sessions yet — ⌘T opens one.');
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
  });

  it('defines restrained labels, metadata, inline state, fixed tones, and reduced motion', () => {
    expect(styles).toMatch(/\.session-subsection-label\s*\{[^}]*text-transform:\s*uppercase;[^}]*letter-spacing:/s);
    expect(styles).toMatch(/\.session-coven-meta\s*\{[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis;/s);
    expect(styles).toMatch(/\.session-inline-state\s*\{/);
    for (const tone of ['ok', 'warn', 'muted', 'danger', 'neutral']) {
      expect(styles).toContain(`.coven-tone-${tone}`);
    }
    expect(styles).toMatch(/\.session-coven-meta\s*\{[^}]*color:\s*var\(--muted\);/s);
    expect(styles).not.toMatch(/\.coven-tone-(?:ok|warn|muted|danger|neutral)\s+\.session-coven-meta/);
    expect(styles).toMatch(/\.coven-tone-ok\s+\.session-coven-status\s*\{[^}]*color:\s*var\(--ok\);/s);
    expect(styles).toMatch(/\.session-row-wrap\s*\{[^}]*position:\s*relative;/s);
    expect(styles).toMatch(/\.session-row\.inline-edit-hidden\s*\{[^}]*visibility:\s*hidden;/s);
    expect(styles).toMatch(/\.session-row-wrap\s*>\s*\.inline-edit\s*\{[^}]*position:\s*absolute;/s);
    expect(styles).toMatch(/\.session-row-wrap:focus-within\s+\.session-close/);
    expect(styles).toMatch(/\.session-close:focus-visible\s*\{[^}]*opacity:\s*1;[^}]*outline:/s);
    expect(styles).toMatch(/\.session-row-wrap:hover\s+\.session-row:not\(\.active\)/);
    expect(styles).not.toMatch(/\.session-row-wrap:hover\s+\.session-row\s*\{/);
    expect(styles).toMatch(/\.session-coven-row\.coven-starting\s+\.session-dot\s*\{[^}]*animation:/s);
    expect(styles).not.toMatch(/waiting[^}]*animation:/s);
    expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.session-coven-row\.coven-starting/s);
    const rendererSource = extractFunctionSource(mainJs, 'renderSessionList');
    expect(rendererSource).toContain('PsycheSessions.filterProjectSessions');
    expect(rendererSource).toContain('PsycheSessions.statusPresentation');
    expect(rendererSource).not.toMatch(/"coven-tone-"\s*\+\s*presentation\.tone/);
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
