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

class FakeStyle {
  private readonly properties = new Map<string, string>();

  setProperty(name: string, value: string) {
    this.properties.set(name, value);
  }

  getPropertyValue(name: string) {
    return this.properties.get(name) ?? '';
  }
}

class FakeElement {
  readonly tagName: string;
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
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

  focus() {
    this.focused = true;
  }
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

    const showProjectFiles = compileFunction<
      (projectId: string) => Promise<boolean>
    >('showProjectFiles', {
      findProject: (projectId: string) => (projectId === project.id ? project : null),
      setActiveProject,
      state,
      setSidebarView,
      sidebarFilesReturnProjectId: null,
    });

    const pending = showProjectFiles(project.id);
    expect(setActiveProject).toHaveBeenCalledWith(project.id);
    expect(setSidebarView).not.toHaveBeenCalled();
    expect(project.selectedWorktreePath).toBe('/repo/worktrees/feature');

    continueActivation();

    await expect(pending).resolves.toBe(true);
    expect(setSidebarView).toHaveBeenCalledOnce();
    expect(setSidebarView).toHaveBeenCalledWith('files');
    expect(project.selectedWorktreePath).toBe('/repo/worktrees/feature');
    expect(functionSource('showProjectFiles')).toContain('sidebarFilesReturnProjectId = project.id;');
  });

  it('returns false when project activation fails and never switches the sidebar view', async () => {
    const setSidebarView = vi.fn();
    const showProjectFiles = compileFunction<
      (projectId: string) => Promise<boolean>
    >('showProjectFiles', {
      findProject: () => ({ id: 'project-1', selectedWorktreePath: '/repo' }),
      setActiveProject: vi.fn().mockResolvedValue(false),
      state: { activeProjectId: '' },
      setSidebarView,
      sidebarFilesReturnProjectId: null,
    });

    await expect(showProjectFiles('project-1')).resolves.toBe(false);
    expect(setSidebarView).not.toHaveBeenCalled();
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

  it('wires project Files clicks without reusing the removed zero-visible-session guard', () => {
    const renderSessionList = functionSource('renderSessionList');
    const projectFilesBlock = between(
      renderSessionList,
      'projectParts.files.addEventListener("pointerdown"',
      'projectParts.head.addEventListener("contextmenu"',
    );

    expect(renderSessionList).not.toContain('if (projectModel.visibleCount === 0) return;');
    expect(projectFilesBlock).toContain('event.stopPropagation();');
    expect(projectFilesBlock).toContain('event.preventDefault();');
    expect(projectFilesBlock).toContain('showProjectFiles(project.id);');
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
    expect(mainJs).toMatch(/onRailClick\("files-back", function \(\) \{\s*showSessionsSidebar\(\);\s*\}\);/);
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
