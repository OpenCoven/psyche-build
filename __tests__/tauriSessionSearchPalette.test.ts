import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const webRoot = join(repoRoot, 'native/desktop/psyche-build-tauri/web');
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
const mainJs = readFileSync(join(webRoot, 'main.js'), 'utf8');
const stylesCss = readFileSync(join(webRoot, 'styles.css'), 'utf8');

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionSource(source: string, name: string) {
  const match = new RegExp(
    `(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`,
  ).exec(source);
  if (!match || match.index === undefined) throw new Error(`missing function ${name}`);

  const bodyStart = source.indexOf('{', match.index + match[0].length);
  if (bodyStart === -1) throw new Error(`missing body for ${name}`);

  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }

  throw new Error(`unterminated function ${name}`);
}

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(...names, `"use strict"; return (${source});`)(...values) as T;
}

function compileSessionSearchController(
  dependencies: Record<string, unknown>,
  options: { activation?: 'real' | 'dependency'; inputListener?: boolean } = {},
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  const activationSource = options.activation === 'real'
    ? `
      ${functionSource(mainJs, 'snapshotSetScopePresentation')}
      ${functionSource(mainJs, 'restoreSetScopePresentation')}
      ${functionSource(mainJs, 'runSessionSearchPick')}
    `
    : '';
  const inputSource = options.inputListener ? listenerSource(mainJs, 'input') : '';
  return Function(
    ...names,
    `"use strict";
      var sessionSearchActivationGeneration = 0;
      ${activationSource}
      ${functionSource(mainJs, 'runPalettePick')}
      ${inputSource}
      return { runPalettePick: runPalettePick };
    `,
  )(...values) as {
    runPalettePick: (pick: Record<string, unknown>, mode?: string) => Promise<void>;
  };
}

function compileSessionSearchPick<T extends (...args: never[]) => unknown>(
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(
    ...names,
    `"use strict";
      ${functionSource(mainJs, 'snapshotSetScopePresentation')}
      ${functionSource(mainJs, 'restoreSetScopePresentation')}
      return (${functionSource(mainJs, 'runSessionSearchPick')});
    `,
  )(...values) as T;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function listenerSource(source: string, eventName: string) {
  const start = source.indexOf(`commandInput.addEventListener("${eventName}"`);
  if (start === -1) throw new Error(`missing command input ${eventName} listener`);
  const end = source.indexOf('\n  });', start);
  if (end === -1) throw new Error(`unterminated command input ${eventName} listener`);
  return source.slice(start, end + 6);
}

function ruleBlock(source: string, selector: string) {
  const match = source.match(
    new RegExp(`(^|\\n)${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, 's'),
  );
  return match?.[2] ?? '';
}

function keydownHarness(value: string) {
  let handler: ((event: {
    key: string;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => void) | undefined;
  const commandInput = {
    value,
    addEventListener(name: string, listener: typeof handler) {
      if (name === 'keydown') handler = listener;
    },
    focus() {},
  };
  Function(
    'commandInput',
    'renderPalette',
    'runPalettePick',
    'hidePalette',
    'syncComposerChrome',
    'runCommand',
    `"use strict";
      var paletteVisible = true;
      var paletteFiltered = [{ kind: "session", cmd: "pick" }];
      var paletteIndex = 0;
      ${listenerSource(mainJs, 'keydown')}
    `,
  )(
    commandInput,
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
  );
  if (!handler) throw new Error('keydown listener was not registered');

  return {
    press(key: string) {
      let defaultPrevented = false;
      let propagationStopped = false;
      handler!({
        key,
        preventDefault() { defaultPrevented = true; },
        stopPropagation() { propagationStopped = true; },
      });
      return { defaultPrevented, propagationStopped };
    },
  };
}

describe('Tauri composer session search palette', () => {
  it('exposes the composer palette as an accessible listbox above the composer', () => {
    expect(indexHtml).toMatch(
      /id="command-input"[\s\S]*?role="combobox"[\s\S]*?aria-controls="palette"[\s\S]*?aria-autocomplete="list"[\s\S]*?aria-expanded="false"/,
    );
    expect(indexHtml).toMatch(
      /<div class="palette" id="palette" role="listbox" aria-label="Composer suggestions" hidden><\/div>/,
    );

    const palette = ruleBlock(stylesCss, '.palette');
    expect(palette).toMatch(/position:\s*absolute;/);
    expect(palette).toMatch(/right:\s*0;/);
    expect(palette).toMatch(/bottom:\s*calc\(100%\s*\+\s*8px\);/);
    expect(palette).toMatch(/left:\s*0;/);
    expect(palette).toMatch(/max-height:\s*min\(360px,\s*45vh\);/);
    expect(palette).toMatch(/overflow:\s*auto;/);
    expect(ruleBlock(stylesCss, '.palette-item.palette-session')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*auto\)\s+minmax\(0,\s*1fr\)\s+auto;/,
    );
    expect(ruleBlock(stylesCss, '.palette-empty')).toMatch(/text-align:\s*center;/);
  });

  it('builds ordered session entries through the shared sidebar model and active filter', () => {
    expect(mainJs).toContain('var PALETTE_SIGILS = "/!%?";');
    const buildEntries = functionSource(mainJs, 'buildSessionSearchEntries');

    expect(buildEntries).toContain('PsycheSessions.buildSidebarProjectModel({');
    expect(buildEntries).toContain('PsycheSessions.flattenSidebarSearchResults(projectModels)');
    expect(buildEntries).toContain('filter: sessionTypeFilter');
    expect(buildEntries).toContain('query: query');
    expect(buildEntries).toContain('covenSessionAssignments()');
    expect(buildEntries).toContain('!thread.hidden && !isDormantThread(thread)');
    expect(buildEntries).toContain('projectModel.visibleCount === 0');
    for (const field of [
      'cmd: result.title',
      'badge: result.status.label',
      'hint: "↵"',
      'kind: "session"',
      'group: "Sessions"',
      'sessionSource: result.source',
      'sessionId: result.id',
      'selectionKey: result.selectionKey',
      'projectId: result.projectId',
    ]) {
      expect(buildEntries).toContain(field);
    }
  });

  it('keeps explicit session searches open and renders accessible results or empty state', () => {
    const openPalette = functionSource(mainJs, 'openPalette');
    const hidePalette = functionSource(mainJs, 'hidePalette');
    const renderPalette = functionSource(mainJs, 'renderPalette');

    expect(openPalette).toContain('commandInput.value.charAt(0)');
    expect(openPalette).toMatch(/if\s*\(sigil === "\?"\)/);
    expect(openPalette).toContain('buildSessionSearchEntries(rest)');
    expect(openPalette).toMatch(/paletteFiltered\.length === 0 && sigil !== "\?"/);
    expect(openPalette).toContain('Math.max(0, paletteFiltered.length - 1)');
    expect(openPalette).toContain('commandInput.setAttribute("aria-expanded", "true")');
    expect(hidePalette).toContain('commandInput.setAttribute("aria-expanded", "false")');
    expect(hidePalette).toContain('commandInput.removeAttribute("aria-activedescendant")');

    expect(renderPalette).toContain('"No matching sessions"');
    expect(renderPalette).toContain('empty.className = "palette-empty"');
    expect(renderPalette).toContain('div.id = "palette-option-" + idx');
    expect(renderPalette).toContain('div.setAttribute("role", "option")');
    expect(renderPalette).toContain('div.setAttribute("aria-selected"');
    expect(renderPalette).toContain('" palette-session"');
    expect(renderPalette).toContain('commandInput.setAttribute("aria-activedescendant", div.id)');
  });

  it('activates session picks only after live local or Coven revalidation', () => {
    const activate = functionSource(mainJs, 'runSessionSearchPick');
    const pick = functionSource(mainJs, 'runPalettePick');

    expect(activate.match(/Session is no longer available/g)).toHaveLength(3);
    expect(activate).toContain('var project = findProject(pick.projectId)');
    expect(activate).toContain('pick.sessionSource === "psyche"');
    expect(activate).toContain('candidate.projectId !== project.id');
    expect(activate).toContain('candidate.hidden');
    expect(activate).toContain('isDormantThread(candidate)');
    expect(activate).toMatch(
      /await activateProjectWorktree\(\s*project,\s*thread\.worktreePath,\s*\{ focusTerminal: false \}\s*\)/,
    );
    expect(activate).toContain('{ focusTerminal: false }');
    expect(activate).toContain('settings.selectedSessionKey = pick.selectionKey');
    expect(activate).toContain('saveSettings()');
    expect(activate).toContain('snapshotSetScopePresentation(thread)');
    expect(activate).toContain('applySetScopeForThread(thread)');
    expect(activate).toContain(
      'restoreSetScopePresentation(previousPresentation, appliedPresentation)',
    );
    expect(activate).toContain('await focusThread(thread.id, { focusTerminal: false })');
    expect(activate).toContain('covenSessionsForProject(project).find');
    expect(activate).toContain('candidate.id === pick.sessionId');
    expect(activate).toContain(
      'await openCovenSession(project, session, { focusTerminal: false })',
    );

    expect(pick).toMatch(/^async function runPalettePick/);
    expect(pick).toContain('pick.kind === "session"');
    expect(pick).toContain('await runSessionSearchPick(pick)');
    expect(pick).toContain('} finally {');
    expect(pick).toContain('sessionSearchActivationGeneration');
    expect(pick).toContain('commandInput.value === activationQuery');
    expect(pick).toContain('if (selected)');
    expect(pick).toContain('commandInput.focus()');
    expect(mainJs).not.toContain('waitForSessionSearchActivationFrames');

    expect(activate.indexOf('applySetScopeForThread(thread)')).toBeLessThan(
      activate.indexOf('await focusThread(thread.id, { focusTerminal: false })'),
    );
    expect(activate.indexOf('await focusThread(thread.id, { focusTerminal: false })')).toBeLessThan(
      activate.indexOf('settings.selectedSessionKey = pick.selectionKey'),
    );
    expect(
      activate.lastIndexOf(
        'await openCovenSession(project, session, { focusTerminal: false })',
      ),
    ).toBeLessThan(
      activate.lastIndexOf('settings.selectedSessionKey = pick.selectionKey'),
    );
  });

  it('applies the target focus set before rendering and restores the prior scope on failure', async () => {
    const project = { id: 'project-1', selectedWorktreePath: '/repo/old' };
    const thread = {
      id: 'thread-1',
      projectId: project.id,
      hidden: false,
      closing: false,
      closeStarted: false,
      status: 'running',
      worktreePath: '/repo/target',
    };
    const state: { activeProjectId: string; activeThreadId: string | null } = {
      activeProjectId: project.id,
      activeThreadId: null,
    };
    const settings = { selectedSessionKey: 'old-selection' };
    const priorSpanRoot = { id: 'prior-span-root' };
    const layout = {
      root: { id: 'layout-root' },
      activeSetId: 'prior-set' as string | null,
      maximizedLeafId: 'prior-maximized' as string | null,
      spanRoot: priorSpanRoot as Record<string, unknown> | null,
      spanSignature: 'prior-span-signature' as string | null,
    };
    const focusResults = [false, true];
    const calls: string[] = [];
    const runSessionSearchPick = compileSessionSearchPick<
      (pick: Record<string, unknown>) => Promise<boolean>
    >({
      findProject: () => project,
      findThread: () => thread,
      isDormantThread: () => false,
      state,
      setActiveProject: async () => true,
      activateProjectWorktree: async (
        _project: typeof project,
        worktreePath: string,
        options?: { focusTerminal?: boolean },
      ) => {
        expect(options).toEqual({ focusTerminal: false });
        calls.push(`navigate:${worktreePath}`);
        project.selectedWorktreePath = worktreePath;
        return true;
      },
      settings,
      saveSettings: () => { calls.push('save'); },
      paneLayoutForThread: () => layout,
      paneLayoutFor: () => layout,
      activeFocusSet: () => (
        layout.activeSetId ? { id: layout.activeSetId } : null
      ),
      applySetScopeForThread: () => {
        calls.push('scope');
        layout.activeSetId = 'target-set';
        layout.maximizedLeafId = null;
        layout.spanRoot = null;
        layout.spanSignature = null;
        return true;
      },
      activateFocusSet: (id: string) => {
        calls.push(`restore:${id}`);
        layout.activeSetId = id;
        return true;
      },
      clearFocusSet: () => {
        calls.push('restore:all');
        layout.activeSetId = null;
        return true;
      },
      renderPaneWorkspace: () => { calls.push('render'); },
      refreshSidebar: () => { calls.push('refresh-sidebar'); },
      focusThread: async (_id: string, options?: { focusTerminal?: boolean }) => {
        expect(options).toEqual({ focusTerminal: false });
        calls.push(`focus:${layout.activeSetId}`);
        const result = focusResults.shift() ?? false;
        if (result) state.activeThreadId = thread.id;
        return result;
      },
      covenSessionsForProject: () => [],
      openCovenSession: async () => null,
      toast: () => undefined,
    });
    const pick = {
      sessionSource: 'psyche',
      sessionId: thread.id,
      projectId: project.id,
      selectionKey: 'psyche:thread-1',
    };

    await expect(runSessionSearchPick(pick)).resolves.toBe(false);
    expect(settings.selectedSessionKey).toBe('old-selection');
    expect(layout).toEqual({
      root: { id: 'layout-root' },
      activeSetId: 'prior-set',
      maximizedLeafId: 'prior-maximized',
      spanRoot: priorSpanRoot,
      spanSignature: 'prior-span-signature',
    });
    expect(calls).toEqual([
      'navigate:/repo/target',
      'scope',
      'focus:target-set',
      'render',
      'refresh-sidebar',
    ]);

    await expect(runSessionSearchPick(pick)).resolves.toBe(true);
    expect(settings.selectedSessionKey).toBe('psyche:thread-1');
    expect(layout.activeSetId).toBe('target-set');
    expect(calls).toEqual([
      'navigate:/repo/target',
      'scope',
      'focus:target-set',
      'render',
      'refresh-sidebar',
      'scope',
      'focus:target-set',
      'save',
    ]);
  });

  it('does not roll back focus-set presentation over newer user changes', async () => {
    const project = { id: 'project-1', selectedWorktreePath: '/repo/target' };
    const thread = {
      id: 'thread-1',
      projectId: project.id,
      hidden: false,
      closing: false,
      closeStarted: false,
      status: 'running',
      worktreePath: '/repo/target',
    };
    const originalSpanRoot = { id: 'original-span' };
    const newerSpanRoot = { id: 'newer-span' };
    const layout = {
      root: { id: 'layout-root' },
      activeSetId: 'prior-set' as string | null,
      maximizedLeafId: 'prior-maximized' as string | null,
      spanRoot: originalSpanRoot as Record<string, unknown> | null,
      spanSignature: 'prior-signature' as string | null,
    };
    const renderPaneWorkspace = vi.fn();
    const refreshSidebar = vi.fn();
    const runSessionSearchPick = compileSessionSearchPick<
      (pick: Record<string, unknown>) => Promise<boolean>
    >({
      findProject: () => project,
      findThread: () => thread,
      isDormantThread: () => false,
      state: { activeProjectId: project.id, activeThreadId: null },
      activateProjectWorktree: async () => true,
      settings: { selectedSessionKey: 'old-selection' },
      saveSettings: vi.fn(),
      paneLayoutForThread: () => layout,
      paneLayoutFor: () => layout,
      activeFocusSet: () => ({ id: 'prior-set' }),
      applySetScopeForThread: () => {
        layout.activeSetId = 'target-set';
        layout.maximizedLeafId = null;
        layout.spanRoot = null;
        layout.spanSignature = null;
        return true;
      },
      activateFocusSet: (id: string) => {
        layout.activeSetId = id;
        layout.maximizedLeafId = null;
        layout.spanRoot = null;
        layout.spanSignature = null;
        return true;
      },
      clearFocusSet: () => true,
      renderPaneWorkspace,
      refreshSidebar,
      focusThread: async () => {
        layout.activeSetId = 'newer-set';
        layout.maximizedLeafId = 'newer-maximized';
        layout.spanRoot = newerSpanRoot;
        layout.spanSignature = 'newer-signature';
        return false;
      },
      covenSessionsForProject: () => [],
      openCovenSession: async () => null,
      toast: vi.fn(),
    });

    await expect(runSessionSearchPick({
      sessionSource: 'psyche',
      sessionId: thread.id,
      projectId: project.id,
      selectionKey: 'psyche:thread-1',
    })).resolves.toBe(false);

    expect(layout).toEqual({
      root: { id: 'layout-root' },
      activeSetId: 'newer-set',
      maximizedLeafId: 'newer-maximized',
      spanRoot: newerSpanRoot,
      spanSignature: 'newer-signature',
    });
    expect(renderPaneWorkspace).not.toHaveBeenCalled();
    expect(refreshSidebar).not.toHaveBeenCalled();
  });

  it.each(['exited', 'failed'])(
    'revalidates after project navigation and refuses a stale %s pane before focus',
    async (status) => {
      const project = { id: 'project-1' };
      const thread = {
        id: 'thread-1',
        projectId: project.id,
        hidden: false,
        closing: false,
        closeStarted: false,
        status: 'running',
      };
      const state = {
        activeProjectId: 'project-2',
        activeThreadId: null,
      };
      const navigation = deferred<boolean>();
      const focusThread = vi.fn();
      const runSessionSearchPick = compileSessionSearchPick<
        (pick: Record<string, unknown>) => Promise<boolean>
      >({
        findProject: () => project,
        findThread: () => thread,
        isDormantThread: (candidate: typeof thread) => candidate.status === 'exited',
        state,
        setActiveProject: async () => true,
        activateProjectWorktree: () => navigation.promise,
        settings: { selectedSessionKey: 'old-selection' },
        saveSettings: vi.fn(),
        activeFocusSet: () => null,
        applySetScopeForThread: vi.fn(),
        activateFocusSet: vi.fn(),
        clearFocusSet: vi.fn(),
        renderPaneWorkspace: vi.fn(),
        focusThread,
        covenSessionsForProject: () => [],
        openCovenSession: async () => null,
        toast: vi.fn(),
      });
      const activation = runSessionSearchPick({
        sessionSource: 'psyche',
        sessionId: thread.id,
        projectId: project.id,
        selectionKey: 'psyche:thread-1',
      });

      thread.status = status;
      navigation.resolve(true);

      await expect(activation).resolves.toBe(false);
      expect(focusThread).not.toHaveBeenCalled();
    },
  );

  it('persists a Coven selection only after open succeeds', async () => {
    const project = { id: 'project-1' };
    const session = { id: 'coven-1' };
    const settings = { selectedSessionKey: 'old-selection' };
    const openResults = [null, { id: 'thread-1' }];
    const saveSettings = vi.fn();
    const runSessionSearchPick = compileSessionSearchPick<
      (pick: Record<string, unknown>) => Promise<boolean>
    >({
      findProject: () => project,
      findThread: () => null,
      isDormantThread: () => false,
      state: { activeProjectId: project.id },
      setActiveProject: async () => true,
      settings,
      saveSettings,
      applySetScopeForThread: () => undefined,
      focusThread: async () => false,
      covenSessionsForProject: () => [session],
      openCovenSession: async () => openResults.shift() ?? null,
      toast: () => undefined,
    });
    const pick = {
      sessionSource: 'coven',
      sessionId: session.id,
      projectId: project.id,
      selectionKey: 'coven:coven-1',
    };

    await expect(runSessionSearchPick(pick)).resolves.toBe(false);
    expect(settings.selectedSessionKey).toBe('old-selection');
    expect(saveSettings).not.toHaveBeenCalled();

    await expect(runSessionSearchPick(pick)).resolves.toBe(true);
    expect(settings.selectedSessionKey).toBe('coven:coven-1');
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it('selects a local search result without terminal autofocus and leaves focus in the composer', async () => {
    const project = { id: 'project-1' };
    const thread = {
      id: 'thread-1',
      projectId: project.id,
      hidden: false,
      closing: false,
      closeStarted: false,
      status: 'running',
    };
    const state: { activeProjectId: string; activeThreadId: string | null } = {
      activeProjectId: project.id,
      activeThreadId: null,
    };
    const frames: Array<() => void> = [];
    let focusOwner = 'none';
    const commandInput = {
      value: '? local',
      focus() { focusOwner = 'composer'; },
    };
    const controller = compileSessionSearchController({
      commandInput,
      findProject: () => project,
      findThread: () => thread,
      isDormantThread: () => false,
      state,
      setActiveProject: async () => true,
      settings: { selectedSessionKey: '' },
      saveSettings: () => undefined,
      paneLayoutForThread: () => null,
      paneLayoutFor: () => null,
      activeFocusSet: () => null,
      applySetScopeForThread: () => undefined,
      activateFocusSet: () => undefined,
      clearFocusSet: () => undefined,
      renderPaneWorkspace: () => undefined,
      refreshSidebar: () => undefined,
      focusThread: async (_id: string, options?: { focusTerminal?: boolean }) => {
        state.activeThreadId = thread.id;
        if (!options || options.focusTerminal !== false) {
          frames.push(() => { focusOwner = 'terminal'; });
        }
        return true;
      },
      covenSessionsForProject: () => [],
      openCovenSession: async () => null,
      toast: () => undefined,
      hidePalette: () => undefined,
      syncComposerChrome: () => undefined,
      runCommand: () => undefined,
    }, { activation: 'real' });

    await controller.runPalettePick({
      kind: 'session',
      sessionSource: 'psyche',
      sessionId: thread.id,
      projectId: project.id,
      selectionKey: 'psyche:thread-1',
    });
    frames.splice(0).forEach((frame) => frame());

    expect(focusOwner).toBe('composer');
    expect(frames).toHaveLength(0);
  });

  it('does not queue Coven terminal autofocus or steal focus after a newer query', async () => {
    const pending = deferred<{ id: string }>();
    const frames: Array<() => void> = [];
    let inputListener: (() => void) | undefined;
    let focusOwner = 'composer';
    let composerFocusCalls = 0;
    const openOptions: Array<{ focusTerminal?: boolean } | undefined> = [];
    const project = { id: 'project-1' };
    const session = { id: 'coven-1' };
    const commandInput = {
      value: '? coven',
      focus() {
        composerFocusCalls += 1;
        focusOwner = 'composer';
      },
      addEventListener(name: string, listener: () => void) {
        if (name === 'input') inputListener = listener;
      },
    };
    const controller = compileSessionSearchController({
      commandInput,
      findProject: () => project,
      findThread: () => null,
      isDormantThread: () => false,
      state: { activeProjectId: project.id },
      setActiveProject: async () => true,
      settings: { selectedSessionKey: '' },
      saveSettings: () => undefined,
      activeFocusSet: () => null,
      applySetScopeForThread: () => undefined,
      activateFocusSet: () => undefined,
      clearFocusSet: () => undefined,
      renderPaneWorkspace: () => undefined,
      focusThread: async () => false,
      covenSessionsForProject: () => [session],
      openCovenSession: (
        _project: typeof project,
        _session: typeof session,
        options?: { focusTerminal?: boolean },
      ) => {
        openOptions.push(options);
        if (!options || options.focusTerminal !== false) {
          frames.push(() => { focusOwner = 'terminal'; });
        }
        return pending.promise;
      },
      toast: () => undefined,
      hidePalette: () => undefined,
      syncComposerChrome: () => undefined,
      runCommand: () => undefined,
      PALETTE_SIGILS: '/!%?',
      openPalette: () => undefined,
    }, { activation: 'real', inputListener: true });

    const activation = controller.runPalettePick({
      kind: 'session',
      sessionSource: 'coven',
      sessionId: session.id,
      projectId: project.id,
      selectionKey: 'coven:coven-1',
    });
    commandInput.value = '? newer query';
    inputListener!();
    pending.resolve({ id: 'thread-1' });
    await activation;

    expect(frames).toHaveLength(0);
    frames.splice(0).forEach((frame) => frame());
    expect(openOptions).toEqual([{ focusTerminal: false }]);
    expect(commandInput.value).toBe('? newer query');
    expect(composerFocusCalls).toBe(0);
    expect(focusOwner).toBe('composer');
  });

  it('does not let an older pick alter newer composer input', async () => {
    const pending = deferred<boolean>();
    let inputListener: (() => void) | undefined;
    const hidePalette = vi.fn();
    const syncComposerChrome = vi.fn();
    const commandInput = {
      value: '? old',
      focus: vi.fn(),
      addEventListener(name: string, listener: () => void) {
        if (name === 'input') inputListener = listener;
      },
    };
    const controller = compileSessionSearchController({
      commandInput,
      runSessionSearchPick: () => pending.promise,
      hidePalette,
      syncComposerChrome,
      runCommand: () => undefined,
      PALETTE_SIGILS: '/!%?',
      openPalette: () => undefined,
    }, { inputListener: true });

    const activation = controller.runPalettePick({
      kind: 'session',
      sessionSource: 'psyche',
    });
    commandInput.value = '? newer input';
    inputListener!();
    expect(syncComposerChrome).toHaveBeenCalledTimes(1);

    pending.resolve(true);
    await activation;

    expect(commandInput.value).toBe('? newer input');
    expect(hidePalette).not.toHaveBeenCalled();
    expect(syncComposerChrome).toHaveBeenCalledTimes(1);
    expect(commandInput.focus).not.toHaveBeenCalled();
  });

  it('invalidates an older same-query pick when a newer pick starts', async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const pending = [first.promise, second.promise];
    const hidePalette = vi.fn();
    const syncComposerChrome = vi.fn();
    const commandInput = {
      value: '? same query',
      focus: vi.fn(),
    };
    const controller = compileSessionSearchController({
      commandInput,
      runSessionSearchPick: () => pending.shift()!,
      hidePalette,
      syncComposerChrome,
      runCommand: () => undefined,
    });
    const pick = { kind: 'session', sessionSource: 'psyche' };

    const olderActivation = controller.runPalettePick(pick);
    const newerActivation = controller.runPalettePick(pick);
    second.resolve(false);
    await newerActivation;
    expect(commandInput.value).toBe('? same query');
    expect(syncComposerChrome).toHaveBeenCalledTimes(1);
    expect(commandInput.focus).toHaveBeenCalledTimes(1);

    first.resolve(true);
    await olderActivation;

    expect(commandInput.value).toBe('? same query');
    expect(hidePalette).not.toHaveBeenCalled();
    expect(syncComposerChrome).toHaveBeenCalledTimes(1);
    expect(commandInput.focus).toHaveBeenCalledTimes(1);
  });

  it('guards empty palette navigation and prevents session queries reaching a PTY', () => {
    const input = listenerSource(mainJs, 'input');
    const keydown = listenerSource(mainJs, 'keydown');
    const runCommand = functionSource(mainJs, 'runCommand');

    expect(input).toContain('commandInput.value.charAt(0)');
    expect(keydown).toContain('var sessionSearchOpen = commandInput.value.charAt(0) === "?";');
    expect(keydown).toMatch(/e\.key === "ArrowDown"[\s\S]*paletteFiltered\.length > 0/);
    expect(keydown).toMatch(/e\.key === "ArrowUp"[\s\S]*paletteFiltered\.length > 0/);
    expect(keydown).toMatch(
      /e\.key === "Enter"[\s\S]*sessionSearchOpen[\s\S]*e\.stopPropagation\(\)[\s\S]*e\.preventDefault\(\)[\s\S]*return;/,
    );
    expect(keydown).toMatch(
      /e\.key === "Tab"[\s\S]*sessionSearchOpen[\s\S]*e\.stopPropagation\(\)[\s\S]*e\.preventDefault\(\)[\s\S]*return;/,
    );
    expect(keydown).toMatch(
      /e\.key === "Escape"[\s\S]*sessionSearchOpen[\s\S]*commandInput\.value = ""[\s\S]*e\.stopPropagation\(\)[\s\S]*hidePalette\(\)[\s\S]*syncComposerChrome\(\)[\s\S]*commandInput\.focus\(\)/,
    );
    expect(runCommand).toMatch(
      /if\s*\(trimmed\.charAt\(0\) === "\?"\)\s*\{[\s\S]*commandInput\.value = trimmed;[\s\S]*openPalette\(trimmed, true\);[\s\S]*syncComposerChrome\(\);[\s\S]*return;/,
    );
  });

  it('stops every captured search key without changing non-search palette propagation', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape']) {
      const searchEvent = keydownHarness('? session').press(key);
      expect(searchEvent.defaultPrevented, key).toBe(true);
      expect(searchEvent.propagationStopped, key).toBe(true);

      const commandEvent = keydownHarness('/command').press(key);
      expect(commandEvent.propagationStopped, key).toBe(false);
    }
  });

  it('announces live result counts and returns focus after session activation', () => {
    const syncComposerChrome = functionSource(mainJs, 'syncComposerChrome');
    const runPalettePick = functionSource(mainJs, 'runPalettePick');

    expect(syncComposerChrome).toContain('rawValue.charAt(0) === "?"');
    expect(syncComposerChrome).toContain('"Search sessions, "');
    expect(syncComposerChrome).toContain('paletteFiltered.length');
    expect(syncComposerChrome).toContain('composerSendEl.hidden = sessionSearchOpen || value.length === 0');
    expect(syncComposerChrome).toContain('composerMicEl.hidden = rawValue.length > 0');
    expect(runPalettePick).toContain('syncComposerChrome()');
    expect(runPalettePick).toContain('commandInput.focus()');
  });
});
