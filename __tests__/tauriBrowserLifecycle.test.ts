import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const webRoot = join(repoRoot, 'native/macos/psyche-build-tauri');
const mainJs = readFileSync(join(webRoot, 'web/main.js'), 'utf8');
const nativeLib = readFileSync(join(webRoot, 'src-tauri/src/lib.rs'), 'utf8');

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionSource(source: string, name: string) {
  const match = new RegExp(
    `(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`
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
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
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

function rustFunctionSource(source: string, name: string) {
  const match = new RegExp(
    `(?:#\\[tauri::command\\]\\s*)*(?:pub\\s+)?fn\\s+${escapeRegExp(name)}\\s*\\(`
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
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
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

type BrowserNavigationTab = {
  id: string;
  url: string;
  created: boolean;
  loading: boolean;
  title: string;
  history: string[];
  historyIndex: number;
};

type BrowserTabFixture = {
  id: string;
  created: boolean;
};

type BrowserProjectFixture = {
  browsersByWorktree: Record<string, {
    activeTabId: string;
    tabs: BrowserTabFixture[];
  }>;
};

type IdentifiedBrowserProjectFixture = BrowserProjectFixture & {
  id: string;
};

type DormantBrowserTabFixture = {
  id: string;
  url: string;
  created: boolean;
  history: string[];
  historyIndex: number;
};

type ActiveDormantBrowserTabFixture = {
  id: string;
  created: boolean;
  url: string;
};

type BrowserPaneThreadFixture = {
  id: string;
  kind: string;
  projectId: string;
  worktreePath: string;
};

type PersistedBrowserTabFixture = BrowserNavigationTab & {
  loading: boolean;
};

function browserLifecycleHarness() {
  const tabStates = new WeakMap<object, {
    closing: boolean;
    generation: number;
    invalidationGeneration: number;
    navigationTail: Promise<void> | null;
    nativeLabel: string | null;
    pendingGeneration: number;
    pendingUrl: string | null;
    liveGeneration: number;
    liveUrl: string | null;
    eventUrl: string | null;
    viewLive: boolean;
    navigationSnapshot: {
      url: string;
      title: string;
      history: string[];
      historyIndex: number;
    } | null;
  }>();
  const paneStates = new WeakMap<object, { tearingDown: boolean }>();
  const browserTabLifecycle = (tab: object | null) => {
    if (!tab) {
      return {
        closing: false,
        generation: 0,
        invalidationGeneration: 0,
        navigationTail: null,
        nativeLabel: null,
        pendingGeneration: 0,
        pendingUrl: null,
        liveGeneration: 0,
        liveUrl: null,
        eventUrl: null,
        viewLive: false,
        navigationSnapshot: null,
      };
    }
    let lifecycle = tabStates.get(tab);
    if (!lifecycle) {
      lifecycle = {
        closing: false,
        generation: 0,
        invalidationGeneration: 0,
        navigationTail: null,
        nativeLabel: null,
        pendingGeneration: 0,
        pendingUrl: null,
        liveGeneration: 0,
        liveUrl: null,
        eventUrl: null,
        viewLive: (tab as { created?: boolean }).created === true,
        navigationSnapshot: null,
      };
      tabStates.set(tab, lifecycle);
    }
    return lifecycle;
  };
  const browserPaneLifecycle = (pane: object | null) => {
    if (!pane) return { tearingDown: false };
    let lifecycle = paneStates.get(pane);
    if (!lifecycle) {
      lifecycle = { tearingDown: false };
      paneStates.set(pane, lifecycle);
    }
    return lifecycle;
  };
  return {
    browserTabLifecycle,
    browserPaneLifecycle,
    browserTabIsClosing: (tab: object | null) => !!tab && browserTabLifecycle(tab).closing,
    browserPaneIsClosing: (pane: ({ closing?: boolean; closeStarted?: boolean } & object) | null) =>
      !!pane && (
        pane.closing === true ||
        pane.closeStarted === true ||
        browserPaneLifecycle(pane).tearingDown
      ),
    beginBrowserNavigation: (tab: object) => {
      const lifecycle = browserTabLifecycle(tab);
      lifecycle.generation += 1;
      return lifecycle.generation;
    },
    invalidateBrowserNavigation: (tab: object) => {
      const lifecycle = browserTabLifecycle(tab);
      lifecycle.generation += 1;
      lifecycle.invalidationGeneration += 1;
      lifecycle.pendingGeneration = 0;
      lifecycle.pendingUrl = null;
      lifecycle.eventUrl = null;
      lifecycle.navigationSnapshot = null;
      return lifecycle.generation;
    },
  };
}

function browserNavigationDependencies(
  project: { id: string },
  browser: { activeTabId: string; tabs: BrowserNavigationTab[] },
  tab: BrowserNavigationTab,
  invoke: (command: string, args: Record<string, unknown>) => Promise<void>,
  lifecycle = browserLifecycleHarness(),
) {
  const pane = {
    id: 'web-pane',
    kind: 'web',
    projectId: project.id,
    worktreePath: '/workspace',
    closing: false,
    closeStarted: false,
  };
  return {
    ...lifecycle,
    state: { activeProjectId: project.id },
    activeProject: () => project,
    activeWorkspaceRoot: () => '/workspace',
    createBrowserPane: async () => pane,
    ensureBrowserModel: () => browser,
    currentBrowserTab: () => tab,
    createBrowserTab: (): BrowserNavigationTab | null => null,
    findBrowserPane: () => pane,
    findThread: () => pane,
    visibleBrowserBounds: () => ({ x: 1, y: 2, w: 3, h: 4 }),
    normaliseUrl: (url: string) => url,
    browserUrlsMatch: (left: string, right: string) => left === right,
    tabTitle: (url: string) => url,
    renderBrowserTabs: () => {},
    updateBrowserControls: () => {},
    browserLabelForTab: (value: typeof project, browserTab: BrowserNavigationTab) =>
      `${value.id}:${browserTab.id}`,
    invoke,
    previewEmpty: { hidden: false },
    syncUrlInput: () => {},
    syncProjectBrowser: () => {},
    syncBrowserBounds: () => {},
    saveWorkspaceSoon: () => {},
    nativeBrowserLabel: (label: string) => label,
    markBrowserTabLoaded: () => {},
    writeToActive: (_text: string) => {},
    setTimeout: (_callback: () => void) => 0,
    setStatus: () => {},
    browserNavigationOwnsVisiblePane: () => true,
    browserNavigationIsCurrent: (context: {
      tab: BrowserNavigationTab;
      pane: typeof pane;
      browser: typeof browser;
      generation: number;
    }) => (
      !lifecycle.browserTabIsClosing(context.tab) &&
      !lifecycle.browserPaneIsClosing(context.pane) &&
      lifecycle.browserTabLifecycle(context.tab).generation === context.generation &&
      context.browser.tabs.includes(context.tab)
    ),
    discardObsoleteBrowserNavigation: async (context: {
      tab: BrowserNavigationTab;
      browser: typeof browser;
      label: string;
      previousTitle: string;
    }) => {
      lifecycle.invalidateBrowserNavigation(context.tab);
      await invoke('browser_destroy', { label: context.label });
      if (context.browser.tabs.includes(context.tab)) {
        context.tab.created = false;
        context.tab.loading = false;
        context.tab.title = context.previousTitle;
      }
      return true;
    },
  };
}

function browserNativeEventHandlers(options: {
  lifecycle: ReturnType<typeof browserLifecycleHarness>;
  project: { id: string; browsersByWorktree?: Record<string, unknown> };
  worktreePath: string;
  browser: { activeTabId: string; tabs: BrowserNavigationTab[] };
  tab: BrowserNavigationTab;
  pane: BrowserPaneThreadFixture | null;
  state?: { activeProjectId: string };
  calls?: string[];
  nativeLabel?: string;
}) {
  const {
    lifecycle,
    project,
    worktreePath,
    browser,
    tab,
  } = options;
  const state = options.state ?? { activeProjectId: project.id };
  const calls = options.calls ?? [];
  const nativeLabel = options.nativeLabel ?? 'native-tab-a';
  let pane = options.pane;
  const browserUrlsMatch = compileFunction<
    (left: string, right: string) => boolean
  >(functionSource(mainJs, 'browserUrlsMatch'), {});
  const browserNativeEventContext = compileFunction<
    (nativeLabel: string, url: string) => {
      project: typeof project;
      worktreePath: string;
      browser: typeof browser;
      tab: typeof tab;
    } | null
  >(functionSource(mainJs, 'browserNativeEventContext'), {
    browserTabForNativeLabel: (label: string) => label === nativeLabel
      ? { project, worktreePath, browser, tab }
      : null,
    browserTabLifecycle: lifecycle.browserTabLifecycle,
    browserTabIsClosing: lifecycle.browserTabIsClosing,
    browserPaneIsClosing: lifecycle.browserPaneIsClosing,
    findProject: (projectId: string) => projectId === project.id ? project : null,
    findBrowserPane: () => pane,
    findThread: (threadId: string) => pane?.id === threadId ? pane : null,
    browserUrlsMatch,
  });
  const markBrowserTabLoaded = compileFunction<
    (nativeLabel: string, url: string, title: string) => boolean
  >(functionSource(mainJs, 'markBrowserTabLoaded'), {
    browserNativeEventContext,
    state,
    activeWorkspaceRoot: () => worktreePath,
    renderBrowserTabs: () => calls.push('render'),
    syncUrlInput: () => calls.push('url'),
    saveWorkspaceSoon: () => calls.push('save'),
    tabTitle: (url: string) => `title:${url}`,
  });
  const handleBrowserPageLoad = compileFunction<
    (event: { payload: { label: string; url: string; phase: string } }) => boolean
  >(functionSource(mainJs, 'handleBrowserPageLoad'), {
    browserNativeEventContext,
    markBrowserTabLoaded,
    state,
    activeWorkspaceRoot: () => worktreePath,
    renderBrowserTabs: () => calls.push('render'),
    updateBrowserControls: () => calls.push('controls'),
  });
  const handleBrowserTitle = compileFunction<
    (event: { payload: { label: string; url: string; title: string } }) => boolean
  >(functionSource(mainJs, 'handleBrowserTitle'), {
    markBrowserTabLoaded,
  });
  return {
    calls,
    handleBrowserPageLoad,
    handleBrowserTitle,
    setPane(nextPane: BrowserPaneThreadFixture | null) {
      pane = nextPane;
    },
  };
}

function tauriHandlerNames(source: string) {
  const match = /\.invoke_handler\(tauri::generate_handler!\[(?<body>[\s\S]*?)\]\)/.exec(source);
  if (!match?.groups?.body) throw new Error('missing tauri handler list');

  return match.groups.body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .map((line) => line.replace(/,$/, ''));
}

describe('Tauri native browser lifecycle', () => {
  it('documents the browser lifecycle source contract', () => {
    const destroyBrowserWebview = rustFunctionSource(nativeLib, 'destroy_browser_webview');
    expect(destroyBrowserWebview).toMatch(
      /^fn destroy_browser_webview\(app: &AppHandle, label: Option<String>\) -> Result<\(\), String> \{\n\s*let label = safe_browser_label\(label\);\n\s*if let Some\(webview\) = app\.get_webview\(&label\) \{\n\s*webview\.close\(\)\.map_err\(\|error\| error\.to_string\(\)\)\?;\n\s*\}\n\s*Ok\(\(\)\)\n\}$/s,
    );

    const browserDestroy = rustFunctionSource(nativeLib, 'browser_destroy');
    expect(browserDestroy).toMatch(
      /^#\[tauri::command\]\nfn browser_destroy\(app: AppHandle, label: Option<String>\) -> Result<\(\), String> \{\n\s*destroy_browser_webview\(&app, label\)\n\}$/s,
    );

    const browserDestroyMany = rustFunctionSource(nativeLib, 'browser_destroy_many');
    expect(nativeLib).toContain(
      '#[derive(Serialize)]\n#[serde(rename_all = "camelCase")]\nstruct BrowserDestroyFailure',
    );
    expect(nativeLib).toContain('struct BrowserDestroyManyOutcome');
    expect(nativeLib).toContain('destroyed: Vec<String>');
    expect(nativeLib).toContain('failures: Vec<BrowserDestroyFailure>');
    expect(browserDestroyMany).toContain('#[tauri::command]\nfn browser_destroy_many(');
    expect(browserDestroyMany).toContain(') -> BrowserDestroyManyOutcome {');
    expect(browserDestroyMany).toContain('for label in labels {');
    expect(browserDestroyMany).toContain(
      'match destroy_browser_webview(&app, Some(label.clone())) {',
    );
    expect(browserDestroyMany).toContain('Ok(()) => outcome.destroyed.push(label)');
    expect(browserDestroyMany).toContain(
      '.push(BrowserDestroyFailure { label, error })',
    );
    expect(browserDestroyMany).not.toContain('?;');

    const handlers = tauriHandlerNames(nativeLib);
    const first = handlers.indexOf('browser_hide_all_except');
    const last = handlers.indexOf('browser_reload');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
    expect(
      handlers.slice(first, last + 1),
    ).toEqual([
      'browser_hide_all_except',
      'browser_destroy',
      'browser_destroy_many',
      'browser_reload',
    ]    );

    expect(mainJs).toContain('var browserTabLifecycleStates = new WeakMap();');
    expect(mainJs).toContain('var browserPaneLifecycleStates = new WeakMap();');
    const navigationCurrent = functionSource(mainJs, 'browserNavigationIsCurrent');
    expect(navigationCurrent).toContain(
      'browserTabLifecycle(context.tab).generation !== context.generation',
    );
    expect(navigationCurrent).toContain(
      'context.browser.tabs.indexOf(context.tab) === -1',
    );
    expect(navigationCurrent).toContain(
      'findThread(context.pane.id) !== context.pane',
    );
    expect(navigationCurrent).toContain(
      'findBrowserPane(context.project.id, context.worktreePath) === context.pane',
    );
    const discardObsoleteNavigation = functionSource(
      mainJs,
      'discardObsoleteBrowserNavigation',
    );
    expect(discardObsoleteNavigation).toContain(
      'await invoke("browser_destroy", { label: context.label })',
    );
    expect(discardObsoleteNavigation).toContain('context.tab.created = false');
  });

  it('destroys a browser view before removing its tab state', async () => {
    const calls: string[] = [];
    const project: IdentifiedBrowserProjectFixture = {
      id: 'project-a',
      browsersByWorktree: {
        '/workspace': {
          activeTabId: 'tab-a',
          tabs: [
            { id: 'tab-a', created: true },
            { id: 'tab-b', created: true },
          ],
        },
      },
    };
    const closeBrowserTab = compileFunction<
      (project: IdentifiedBrowserProjectFixture, tabId: string) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserTab'), {
      ...browserLifecycleHarness(),
      activeProject: () => project,
      ensureBrowserModel: (value: typeof project) => value.browsersByWorktree['/workspace'],
      invoke: async (command: string, args: { label: string }) => {
        calls.push(`${command}:${args.label}:${project.browsersByWorktree['/workspace'].tabs.length}`);
      },
      browserLabelForTab: (value: typeof project, tab: { id: string }) => `${value.id}:${tab.id}`,
      setStatus: () => {},
      renderBrowserTabs: () => calls.push('render'),
      syncProjectBrowser: () => calls.push('sync'),
      saveWorkspaceSoon: () => calls.push('save'),
    });

    await expect(closeBrowserTab(project, 'tab-a')).resolves.toBe(true);
    expect(calls).toEqual([
      'browser_destroy:project-a:tab-a:2',
      'render',
      'sync',
      'save',
    ]);
    expect(project.browsersByWorktree['/workspace']).toMatchObject({
      activeTabId: 'tab-b',
      tabs: [{ id: 'tab-b' }],
    });
  });

  it('retains tab state and reports native browser destruction failures', async () => {
    const statuses: Array<[string, string]> = [];
    const project: IdentifiedBrowserProjectFixture = {
      id: 'project-a',
      browsersByWorktree: {
        '/workspace': {
          activeTabId: 'tab-a',
          tabs: [{ id: 'tab-a', created: true }],
        },
      },
    };
    const closeBrowserTab = compileFunction<
      (project: IdentifiedBrowserProjectFixture, tabId: string) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserTab'), {
      ...browserLifecycleHarness(),
      activeProject: () => project,
      ensureBrowserModel: (value: typeof project) => value.browsersByWorktree['/workspace'],
      invoke: async () => { throw new Error('native unavailable'); },
      browserLabelForTab: () => 'project-a:tab-a',
      setStatus: (text: string, level: string) => statuses.push([text, level]),
      renderBrowserTabs: () => { throw new Error('must not render'); },
      syncProjectBrowser: () => { throw new Error('must not sync'); },
      saveWorkspaceSoon: () => { throw new Error('must not save'); },
    });

    await expect(closeBrowserTab(project, 'tab-a')).resolves.toBe(false);
    expect(project.browsersByWorktree['/workspace']).toMatchObject({
      activeTabId: 'tab-a',
      tabs: [{ id: 'tab-a', created: true }],
    });
    expect(statuses).toEqual([[
      'browser tab close failed: Error: native unavailable',
      'error',
    ]]);
  });

  it('does not remove a successor when duplicate tab closes resolve concurrently', async () => {
    const destroyResolvers: Array<() => void> = [];
    const calls: string[] = [];
    const project: IdentifiedBrowserProjectFixture = {
      id: 'project-a',
      browsersByWorktree: {
        '/workspace': {
          activeTabId: 'tab-a',
          tabs: [
            { id: 'tab-a', created: true },
            { id: 'tab-b', created: true },
            { id: 'tab-c', created: true },
          ],
        },
      },
    };
    const closeBrowserTab = compileFunction<
      (project: IdentifiedBrowserProjectFixture, tabId: string) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserTab'), {
      ...browserLifecycleHarness(),
      activeProject: () => project,
      ensureBrowserModel: (value: typeof project) => value.browsersByWorktree['/workspace'],
      invoke: (command: string, args: { label: string }) => {
        calls.push(`${command}:${args.label}`);
        return new Promise<void>((resolve) => destroyResolvers.push(resolve));
      },
      browserLabelForTab: (value: typeof project, tab: { id: string }) => `${value.id}:${tab.id}`,
      setStatus: () => {},
      renderBrowserTabs: () => calls.push('render'),
      syncProjectBrowser: () => calls.push('sync'),
      saveWorkspaceSoon: () => calls.push('save'),
    });

    const firstClose = closeBrowserTab(project, 'tab-b');
    const duplicateClose = closeBrowserTab(project, 'tab-b');
    await Promise.resolve();
    await expect(duplicateClose).resolves.toBe(false);
    expect(destroyResolvers).toHaveLength(1);

    destroyResolvers[0]();
    await expect(firstClose).resolves.toBe(true);

    expect(project.browsersByWorktree['/workspace']).toEqual({
      activeTabId: 'tab-a',
      tabs: [
        { id: 'tab-a', created: true },
        { id: 'tab-c', created: true },
      ],
    });
    expect(calls).toEqual([
      'browser_destroy:project-a:tab-b',
      'render',
      'sync',
      'save',
    ]);
  });

  it('blocks activation and navigation while a tab close is pending', async () => {
    let resolveDestroy!: () => void;
    const lifecycle = browserLifecycleHarness();
    const calls: string[] = [];
    const project = {
      id: 'project-a',
      browsersByWorktree: {
        '/workspace': {
          activeTabId: 'tab-b',
          tabs: [
            {
              id: 'tab-a',
              created: true,
              loading: false,
              url: 'https://old.example',
              title: 'Old',
              history: ['https://old.example'],
              historyIndex: 0,
            },
            {
              id: 'tab-b',
              created: true,
              loading: false,
              url: 'https://active.example',
              title: 'Active',
              history: ['https://active.example'],
              historyIndex: 0,
            },
          ],
        },
      },
    };
    const browser = project.browsersByWorktree['/workspace'];
    const tab = browser.tabs[0];
    const closeBrowserTab = compileFunction<
      (value: typeof project, tabId: string) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserTab'), {
      ...lifecycle,
      activeProject: () => project,
      ensureBrowserModel: () => browser,
      invoke: (command: string) => {
        calls.push(command);
        return new Promise<void>((resolve) => { resolveDestroy = resolve; });
      },
      browserLabelForTab: () => 'project-a:tab-a',
      setStatus: () => {},
      renderBrowserTabs: () => calls.push('render'),
      syncProjectBrowser: () => calls.push('sync'),
      saveWorkspaceSoon: () => calls.push('save'),
    });
    const activateBrowserTab = compileFunction<
      (value: typeof project, tabId: string) => Promise<boolean>
    >(functionSource(mainJs, 'activateBrowserTab'), {
      ...lifecycle,
      activeProject: () => project,
      activeWorkspaceRoot: () => '/workspace',
      ensureBrowserModel: () => browser,
      findBrowserPane: () => null,
      markActiveSurface: () => calls.push('surface'),
      renderBrowserTabs: () => calls.push('activate-render'),
      syncProjectBrowser: () => calls.push('activate-sync'),
      saveWorkspaceSoon: () => calls.push('activate-save'),
      restoreDormantBrowserTab: async () => true,
    });
    const navigationDependencies = browserNavigationDependencies(
      project,
      browser,
      tab,
      async (command) => { calls.push(`navigate:${command}`); },
    );
    Object.assign(navigationDependencies, lifecycle, {
      createBrowserPane: async () => {
        calls.push('create-pane');
        return null;
      },
    });
    const navigateBrowser = compileFunction<
      (url: string, options: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'navigateBrowser'), navigationDependencies);

    const closing = closeBrowserTab(project, tab.id);
    await Promise.resolve();

    await expect(activateBrowserTab(project, tab.id)).resolves.toBe(false);
    await expect(navigateBrowser('https://new.example', { tabId: tab.id })).resolves.toBe(false);
    await expect(closeBrowserTab(project, tab.id)).resolves.toBe(false);
    expect(browser.activeTabId).toBe('tab-b');
    expect(browser.tabs).toContain(tab);
    expect(calls).toEqual(['browser_destroy']);

    resolveDestroy();
    await expect(closing).resolves.toBe(true);
    expect(browser.tabs).not.toContain(tab);
    expect(calls).toEqual(['browser_destroy', 'render', 'sync', 'save']);
  });

  it('destroys a native view created by navigation that became obsolete during tab close', async () => {
    let resolveNavigation!: () => void;
    let resolveClose!: () => void;
    let destroyCalls = 0;
    const lifecycle = browserLifecycleHarness();
    const calls: string[] = [];
    const project = { id: 'project-a' };
    const tab: BrowserNavigationTab = {
      id: 'tab-a',
      created: true,
      loading: false,
      url: 'https://old.example',
      title: 'Saved title',
      history: ['https://old.example'],
      historyIndex: 0,
    };
    const successor: BrowserNavigationTab = {
      id: 'tab-b',
      created: true,
      loading: false,
      url: 'https://successor.example',
      title: 'Successor',
      history: ['https://successor.example'],
      historyIndex: 0,
    };
    const browser = { activeTabId: tab.id, tabs: [tab, successor] };
    const pane = {
      id: 'web-pane',
      kind: 'web',
      projectId: project.id,
      worktreePath: '/workspace',
      closing: false,
      closeStarted: false,
    };
    const invoke = (command: string): Promise<void> => {
      calls.push(command);
      if (command === 'browser_navigate') {
        return new Promise<void>((resolve) => { resolveNavigation = resolve; });
      }
      if (command === 'browser_destroy') {
        destroyCalls += 1;
        if (destroyCalls === 1) {
          return new Promise<void>((resolve) => { resolveClose = resolve; });
        }
      }
      return Promise.resolve();
    };
    const navigationDependencies = browserNavigationDependencies(project, browser, tab, invoke);
    Object.assign(navigationDependencies, lifecycle, {
      createBrowserPane: async () => pane,
      findBrowserPane: () => pane,
      findThread: () => pane,
      browserNavigationIsCurrent: (context: {
        tab: BrowserNavigationTab;
        browser: typeof browser;
        generation: number;
      }) => (
        !lifecycle.browserTabIsClosing(context.tab) &&
        lifecycle.browserTabLifecycle(context.tab).generation === context.generation &&
        context.browser.tabs.includes(context.tab)
      ),
      discardObsoleteBrowserNavigation: async (context: {
        tab: BrowserNavigationTab;
        browser: typeof browser;
        label: string;
        previousTitle: string;
      }) => {
        lifecycle.invalidateBrowserNavigation(context.tab);
        await invoke('browser_destroy');
        if (context.browser.tabs.includes(context.tab)) {
          context.tab.created = false;
          context.tab.loading = false;
          context.tab.title = context.previousTitle;
        }
        return true;
      },
    });
    const navigateBrowser = compileFunction<
      (url: string, options: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'navigateBrowser'), navigationDependencies);
    const closeBrowserTab = compileFunction<
      (value: typeof project, tabId: string) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserTab'), {
      ...lifecycle,
      activeProject: () => project,
      ensureBrowserModel: () => browser,
      invoke,
      browserLabelForTab: () => 'project-a:tab-a',
      setStatus: () => {},
      renderBrowserTabs: () => {},
      syncProjectBrowser: () => {},
      saveWorkspaceSoon: () => {},
    });

    const navigation = navigateBrowser('https://new.example', { tabId: tab.id });
    await Promise.resolve();
    const queuedNavigation = navigateBrowser('https://queued.example', { tabId: tab.id });
    await Promise.resolve();
    expect(calls).toEqual(['browser_navigate']);
    const closing = closeBrowserTab(project, tab.id);
    await Promise.resolve();
    expect(calls).toEqual(['browser_navigate', 'browser_destroy']);

    resolveClose();
    await expect(closing).resolves.toBe(true);
    expect(browser.tabs).toEqual([successor]);
    expect(browser.activeTabId).toBe(successor.id);

    resolveNavigation();
    await expect(navigation).resolves.toBe(false);
    await expect(queuedNavigation).resolves.toBe(false);
    expect(calls).toEqual(['browser_navigate', 'browser_destroy', 'browser_destroy']);
    expect(tab).toMatchObject({
      url: 'https://old.example',
      history: ['https://old.example'],
      historyIndex: 0,
    });
  });

  it('awaits restoration when active close promotes a dormant saved tab', async () => {
    let resolveRestoration!: () => void;
    const calls: string[] = [];
    const dormantTab = {
      id: 'tab-b',
      created: false,
      url: 'https://example.org',
      title: 'Example',
      history: ['https://example.com', 'https://example.org'],
      historyIndex: 1,
    };
    const project = {
      id: 'project-a',
      browsersByWorktree: {
        '/workspace': {
          activeTabId: 'tab-a',
          tabs: [
            { id: 'tab-a', created: true, url: 'https://old.example' },
            dormantTab,
          ],
        },
      },
    };
    const closeBrowserTab = compileFunction<
      (value: typeof project, tabId: string) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserTab'), {
      ...browserLifecycleHarness(),
      activeProject: () => project,
      ensureBrowserModel: (value: typeof project) => value.browsersByWorktree['/workspace'],
      invoke: async (command: string) => { calls.push(command); },
      browserLabelForTab: () => 'project-a:tab-a',
      setStatus: () => {},
      renderBrowserTabs: () => calls.push('render'),
      syncProjectBrowser: () => calls.push('sync'),
      saveWorkspaceSoon: () => calls.push('save'),
      restoreDormantBrowserTab: async (_: typeof project, tab: typeof dormantTab) => {
        calls.push(`restore:${tab.id}`);
        await new Promise<void>((resolve) => {
          resolveRestoration = () => {
            tab.created = true;
            resolve();
          };
        });
        return true;
      },
    });

    const closing = closeBrowserTab(project, 'tab-a');
    let settled = false;
    closing.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(project.browsersByWorktree['/workspace']).toMatchObject({
      activeTabId: 'tab-b',
      tabs: [{ id: 'tab-b', created: false }],
    });
    expect(dormantTab.history).toEqual(['https://example.com', 'https://example.org']);
    expect(dormantTab.historyIndex).toBe(1);
    expect(calls).toEqual(['browser_destroy', 'render', 'sync', 'save', 'restore:tab-b']);

    resolveRestoration();
    await expect(closing).resolves.toBe(true);
    expect(dormantTab.created).toBe(true);
    expect(dormantTab.history).toEqual(['https://example.com', 'https://example.org']);
    expect(dormantTab.historyIndex).toBe(1);
  });

  it('hydrates persisted browser tabs as dormant and restores an inactive tab on activation', async () => {
    const sanitizeBrowserModel = compileFunction<
      (saved: { tabs: PersistedBrowserTabFixture[]; activeTabId: string }) => {
        tabs: PersistedBrowserTabFixture[];
        activeTabId: string;
      }
    >(functionSource(mainJs, 'sanitizeBrowserModel'), {
      HARD_MAX_BROWSER_TABS_PER_PROJECT: 8,
      makeBrowserTabId: () => 'generated-tab',
      tabTitle: (url: string) => url,
      clampInt: (value: number) => value,
    });
    const browser = sanitizeBrowserModel({
      activeTabId: 'tab-a',
      tabs: [
        {
          id: 'tab-a',
          url: 'https://example.com',
          title: 'Example',
          history: ['https://example.com'],
          historyIndex: 0,
          created: true,
          loading: true,
        },
        {
          id: 'tab-b',
          url: 'https://example.org/current',
          title: 'Current page',
          history: ['https://example.org', 'https://example.org/current'],
          historyIndex: 1,
          created: true,
          loading: true,
        },
      ],
    });

    expect(browser).toEqual({
      activeTabId: 'tab-a',
      tabs: [
        {
          id: 'tab-a',
          url: 'https://example.com',
          title: 'Example',
          history: ['https://example.com'],
          historyIndex: 0,
          created: false,
          loading: false,
        },
        {
          id: 'tab-b',
          url: 'https://example.org/current',
          title: 'Current page',
          history: ['https://example.org', 'https://example.org/current'],
          historyIndex: 1,
          created: false,
          loading: false,
        },
      ],
    });

    const project = { browsersByWorktree: { '/workspace': browser } };
    const calls: string[] = [];
    const activateBrowserTab = compileFunction<
      (value: typeof project, tabId: string) => Promise<boolean>
    >(functionSource(mainJs, 'activateBrowserTab'), {
      ...browserLifecycleHarness(),
      activeProject: () => project,
      activeWorkspaceRoot: () => '/workspace',
      findBrowserPane: () => null,
      ensureBrowserModel: () => browser,
      markActiveSurface: () => calls.push('surface'),
      renderBrowserTabs: () => calls.push('render'),
      syncProjectBrowser: () => calls.push('sync'),
      saveWorkspaceSoon: () => calls.push('save'),
      restoreDormantBrowserTab: async (_: typeof project, tab: PersistedBrowserTabFixture) => {
        calls.push(`restore:${tab.id}:${tab.url}`);
        tab.created = true;
        return true;
      },
    });

    await expect(activateBrowserTab(project, 'tab-b')).resolves.toBe(true);
    expect(browser.activeTabId).toBe('tab-b');
    expect(calls).toEqual([
      'surface',
      'render',
      'sync',
      'save',
      'restore:tab-b:https://example.org/current',
    ]);
    expect(browser.tabs[1]).toMatchObject({
      created: true,
      title: 'Current page',
      history: ['https://example.org', 'https://example.org/current'],
      historyIndex: 1,
    });
  });

  it('restores saved dormant URLs without changing their browser history', async () => {
    const navigations: Array<[string, Record<string, unknown>]> = [];
    const tab: DormantBrowserTabFixture = {
      id: 'tab-a',
      url: 'https://example.com',
      created: false,
      history: ['https://example.com', 'https://example.org'],
      historyIndex: 1,
    };
    const restoreDormantBrowserTab = compileFunction<
      (project: unknown, tab: DormantBrowserTabFixture) => Promise<boolean>
    >(functionSource(mainJs, 'restoreDormantBrowserTab'), {
      ...browserLifecycleHarness(),
      activeWorkspaceRoot: () => '/workspace',
      findBrowserPane: () => null,
      navigateBrowser: async (url: string, options: Record<string, unknown>) => {
        navigations.push([url, options]);
        await Promise.resolve();
        tab.created = true;
        return true;
      },
    });

    await expect(restoreDormantBrowserTab({}, tab)).resolves.toBe(true);
    expect(navigations).toEqual([[
      'https://example.com',
      { tabId: 'tab-a', preserveHistory: true },
    ]]);
    expect(tab.history).toEqual(['https://example.com', 'https://example.org']);
    expect(tab.historyIndex).toBe(1);
  });

  it('waits for deferred native browser navigation before resolving successfully', async () => {
    let resolveNavigation!: () => void;
    const nativeNavigation = new Promise<void>((resolve) => {
      resolveNavigation = resolve;
    });
    const calls: string[] = [];
    const project = { id: 'project-a' };
    const tab: BrowserNavigationTab = {
      id: 'tab-a',
      url: 'https://old.example',
      created: false,
      loading: false,
      title: 'Old',
      history: ['https://old.example'],
      historyIndex: 0,
    };
    const browser = { activeTabId: tab.id, tabs: [tab] };
    const navigateBrowser = compileFunction<
      (url: string, options: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'navigateBrowser'), browserNavigationDependencies(
      project,
      browser,
      tab,
      (command) => {
        calls.push(command);
        return command === 'browser_navigate' ? nativeNavigation : Promise.resolve();
      },
    ));

    const navigation = navigateBrowser('https://example.com', { tabId: tab.id });
    let settled = false;
    navigation.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(['browser_navigate']);
    expect(settled).toBe(false);
    expect(tab).toMatchObject({ created: false, url: 'https://old.example' });

    resolveNavigation();
    await expect(navigation).resolves.toBe(true);
    expect(tab).toMatchObject({ created: true, url: 'https://example.com' });
    expect(tab.history).toEqual(['https://old.example', 'https://example.com']);
  });

  it('updates project A metadata without resurfacing A after switching to project B', async () => {
    let resolveNavigation!: () => void;
    const state = { activeProjectId: 'project-a' };
    const projectA = {
      id: 'project-a',
      selectedWorktreePath: '/workspace-a',
    };
    const projectB = {
      id: 'project-b',
      selectedWorktreePath: '/workspace-b',
    };
    const tabA: BrowserNavigationTab = {
      id: 'tab-a',
      url: 'https://old-a.example',
      created: false,
      loading: false,
      title: 'Old A',
      history: ['https://old-a.example'],
      historyIndex: 0,
    };
    const tabB: BrowserNavigationTab = {
      id: 'tab-b',
      url: 'https://b.example',
      created: true,
      loading: false,
      title: 'B',
      history: ['https://b.example'],
      historyIndex: 0,
    };
    const browserA = { activeTabId: tabA.id, tabs: [tabA] };
    const browserB = { activeTabId: tabB.id, tabs: [tabB] };
    const paneA = {
      id: 'web-pane-a',
      kind: 'web',
      projectId: projectA.id,
      worktreePath: projectA.selectedWorktreePath,
      hidden: false,
    };
    const paneB = {
      id: 'web-pane-b',
      kind: 'web',
      projectId: projectB.id,
      worktreePath: projectB.selectedWorktreePath,
      hidden: false,
    };
    const nativeCalls: Array<[string, Record<string, unknown>]> = [];
    const controlCalls: string[] = [];
    let visibleLabel: string | null = null;
    const activeProject = () => state.activeProjectId === projectA.id ? projectA : projectB;
    const activeWorkspaceRoot = (project: typeof projectA | typeof projectB) =>
      project.selectedWorktreePath;
    const ensureBrowserModel = (project: typeof projectA | typeof projectB) =>
      project.id === projectA.id ? browserA : browserB;
    const findBrowserPane = (projectId: string, worktreePath: string) => {
      if (projectId === projectA.id && worktreePath === projectA.selectedWorktreePath) return paneA;
      if (projectId === projectB.id && worktreePath === projectB.selectedWorktreePath) return paneB;
      return null;
    };
    const findThread = (threadId: string) => {
      if (threadId === paneA.id) return paneA;
      if (threadId === paneB.id) return paneB;
      return null;
    };
    const currentBrowserTab = (project: typeof projectA | typeof projectB) => {
      const browser = ensureBrowserModel(project);
      return browser.tabs.find((tab) => tab.id === browser.activeTabId) ?? null;
    };
    const browserLabelForTab = (
      project: typeof projectA | typeof projectB,
      tab: BrowserNavigationTab,
    ) => `${project.id}:${tab.id}`;
    const visibleBrowserBounds = () => ({ x: 10, y: 20, w: 300, h: 200 });
    const invoke = (
      command: string,
      args: Record<string, unknown>,
    ): Promise<void> => {
      nativeCalls.push([command, args]);
      if (command === 'browser_navigate') {
        return new Promise<void>((resolve) => {
          resolveNavigation = () => {
            visibleLabel = String(args.label);
            resolve();
          };
        });
      }
      if (command === 'browser_hide_all_except') {
        visibleLabel = typeof args.label === 'string' ? args.label : null;
      }
      return Promise.resolve();
    };
    const browserNavigationOwnsVisiblePane = compileFunction<
      (context: {
        project: typeof projectA;
        worktreePath: string;
        pane: typeof paneA;
      }) => boolean
    >(functionSource(mainJs, 'browserNavigationOwnsVisiblePane'), {
      state,
      activeProject,
      activeWorkspaceRoot,
      findBrowserPane,
      findThread,
      browserPaneIsClosing: browserLifecycleHarness().browserPaneIsClosing,
      visibleBrowserBounds,
    });
    const syncBrowserBounds = compileFunction<
      () => void
    >(functionSource(mainJs, 'syncBrowserBounds'), {
      activeProject,
      currentBrowserTab,
      browserLabelForTab,
      visibleBrowserBounds,
      invoke,
    });
    const dependencies = browserNavigationDependencies(
      projectA,
      browserA,
      tabA,
      invoke,
    );
    Object.assign(dependencies, {
      state,
      activeProject,
      activeWorkspaceRoot,
      ensureBrowserModel,
      currentBrowserTab,
      createBrowserPane: async () => paneA,
      findBrowserPane,
      findThread,
      visibleBrowserBounds,
      browserLabelForTab,
      renderBrowserTabs: () => controlCalls.push(`render:${state.activeProjectId}`),
      updateBrowserControls: () => controlCalls.push(`controls:${state.activeProjectId}`),
      syncUrlInput: () => controlCalls.push(`url:${state.activeProjectId}`),
      syncProjectBrowser: () => {
        controlCalls.push(`sync:${state.activeProjectId}`);
        syncBrowserBounds();
      },
      syncBrowserBounds,
      browserNavigationOwnsVisiblePane,
    });
    const navigateBrowser = compileFunction<
      (url: string, options: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'navigateBrowser'), dependencies);

    const navigation = navigateBrowser('https://new-a.example', { tabId: tabA.id });
    await Promise.resolve();
    await Promise.resolve();
    expect(nativeCalls).toEqual([[
      'browser_navigate',
      {
        label: 'project-a:tab-a',
        url: 'https://new-a.example',
        x: 10,
        y: 20,
        w: 300,
        h: 200,
      },
    ]]);

    state.activeProjectId = projectB.id;
    syncBrowserBounds();
    const controlsBeforeCompletion = controlCalls.slice();

    resolveNavigation();
    await expect(navigation).resolves.toBe(true);

    expect(tabA).toMatchObject({
      created: true,
      url: 'https://new-a.example',
      title: 'https://new-a.example',
      history: ['https://old-a.example', 'https://new-a.example'],
      historyIndex: 1,
    });
    expect(browserB.activeTabId).toBe(tabB.id);
    expect(controlCalls).toEqual(controlsBeforeCompletion);
    expect(visibleLabel).toBe('project-b:tab-b');
    expect(nativeCalls.slice(1)).toEqual([
      ['browser_hide_all_except', { label: 'project-b:tab-b' }],
      ['browser_set_bounds', {
        label: 'project-b:tab-b',
        x: 10,
        y: 20,
        w: 300,
        h: 200,
      }],
      ['browser_hide_all_except', { label: 'project-b:tab-b' }],
      ['browser_set_bounds', {
        label: 'project-b:tab-b',
        x: 10,
        y: 20,
        w: 300,
        h: 200,
      }],
    ]);
  });

  it('does not reactivate an abandoned project or worktree when queued navigation begins', async () => {
    let resolveFirst!: () => void;
    const state = {
      activeProjectId: 'project-a',
      threads: [] as BrowserPaneThreadFixture[],
    };
    const projectA = {
      id: 'project-a',
      selectedWorktreePath: '/workspace-a',
    };
    const projectB = {
      id: 'project-b',
      selectedWorktreePath: '/workspace-b',
    };
    const tabA: BrowserNavigationTab = {
      id: 'tab-a',
      url: 'https://old-a.example',
      created: true,
      loading: false,
      title: 'Old A',
      history: ['https://old-a.example'],
      historyIndex: 0,
    };
    const browserA = { activeTabId: tabA.id, tabs: [tabA] };
    const paneA: BrowserPaneThreadFixture = {
      id: 'web-pane-a',
      kind: 'web',
      projectId: projectA.id,
      worktreePath: projectA.selectedWorktreePath,
    };
    const paneB: BrowserPaneThreadFixture = {
      id: 'web-pane-b',
      kind: 'web',
      projectId: projectB.id,
      worktreePath: projectB.selectedWorktreePath,
    };
    state.threads.push(paneA, paneB);
    const nativeCalls: string[] = [];
    const paneCalls: string[] = [];
    const activeProject = () => state.activeProjectId === projectA.id ? projectA : projectB;
    const activeWorkspaceRoot = (project: typeof projectA | typeof projectB) =>
      project.selectedWorktreePath;
    const findBrowserPane = (projectId: string, worktreePath: string) =>
      state.threads.find((pane) =>
        pane.projectId === projectId && pane.worktreePath === worktreePath
      ) ?? null;
    const dependencies = browserNavigationDependencies(
      projectA,
      browserA,
      tabA,
      (command, args) => {
        if (command !== 'browser_navigate') return Promise.resolve();
        nativeCalls.push(String(args.url));
        if (args.url === 'https://first.example') {
          return new Promise<void>((resolve) => { resolveFirst = resolve; });
        }
        return Promise.resolve();
      },
    );
    Object.assign(dependencies, {
      state,
      activeProject,
      activeWorkspaceRoot,
      findProject: (projectId: string) => projectId === projectA.id
        ? projectA
        : projectId === projectB.id ? projectB : null,
      ensureBrowserModel: () => browserA,
      findBrowserPane,
      findThread: (threadId: string) =>
        state.threads.find((pane) => pane.id === threadId) ?? null,
      createBrowserPane: async (project: typeof projectA) => {
        paneCalls.push(`create:${project.id}:${project.selectedWorktreePath}`);
        state.activeProjectId = project.id;
        const existing = findBrowserPane(project.id, project.selectedWorktreePath);
        if (existing) return existing;
        const pane = {
          id: `web-pane-${state.threads.length}`,
          kind: 'web',
          projectId: project.id,
          worktreePath: project.selectedWorktreePath,
        };
        state.threads.push(pane);
        return pane;
      },
      browserNavigationOwnsVisiblePane: () => false,
      syncBrowserBounds: () => {},
    });
    const navigateBrowser = compileFunction<
      (url: string, options: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'navigateBrowser'), dependencies);

    const first = navigateBrowser('https://first.example', { tabId: tabA.id });
    const second = navigateBrowser('https://second.example', { tabId: tabA.id });
    await Promise.resolve();
    await Promise.resolve();
    expect(nativeCalls).toEqual(['https://first.example']);

    state.activeProjectId = projectB.id;
    projectA.selectedWorktreePath = '/workspace-a-other';
    const panesAfterSwitch = state.threads.slice();
    const paneCallCountAfterSwitch = paneCalls.length;

    resolveFirst();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);

    expect(state.activeProjectId).toBe(projectB.id);
    expect(activeWorkspaceRoot(activeProject())).toBe('/workspace-b');
    expect(state.threads).toEqual(panesAfterSwitch);
    expect(paneCalls).toHaveLength(paneCallCountAfterSwitch);
    expect(nativeCalls).toEqual(['https://first.example']);
  });

  it('rejects delayed native events from superseded navigation and accepts current events', () => {
    const lifecycle = browserLifecycleHarness();
    const project = {
      id: 'project-a',
      browsersByWorktree: {} as Record<string, unknown>,
    };
    const tab: BrowserNavigationTab = {
      id: 'tab-a',
      url: 'https://first.example',
      created: true,
      loading: true,
      title: 'First title',
      history: ['https://first.example'],
      historyIndex: 0,
    };
    const browser = { activeTabId: tab.id, tabs: [tab] };
    project.browsersByWorktree['/workspace'] = browser;
    const pane: BrowserPaneThreadFixture = {
      id: 'web-pane',
      kind: 'web',
      projectId: project.id,
      worktreePath: '/workspace',
    };
    Object.assign(lifecycle.browserTabLifecycle(tab), {
      generation: 2,
      nativeLabel: 'native-tab-a',
      pendingGeneration: 2,
      pendingUrl: 'https://second.example',
      liveGeneration: 1,
      liveUrl: 'https://first.example',
      eventUrl: null,
      viewLive: true,
    });
    const handlers = browserNativeEventHandlers({
      lifecycle,
      project,
      worktreePath: '/workspace',
      browser,
      tab,
      pane,
    });

    expect(handlers.handleBrowserPageLoad({
      payload: {
        label: 'native-tab-a',
        url: 'https://first.example',
        phase: 'started',
      },
    })).toBe(false);
    expect(handlers.handleBrowserPageLoad({
      payload: {
        label: 'native-tab-a',
        url: 'https://first.example',
        phase: 'finished',
      },
    })).toBe(false);
    expect(handlers.handleBrowserTitle({
      payload: {
        label: 'native-tab-a',
        url: 'https://first.example',
        title: 'Stale first title',
      },
    })).toBe(false);
    expect(handlers.handleBrowserTitle({
      payload: {
        label: 'stale-native-label',
        url: 'https://second.example',
        title: 'Stale label title',
      },
    })).toBe(false);
    expect(tab).toMatchObject({
      url: 'https://first.example',
      title: 'First title',
      loading: true,
    });
    expect(handlers.calls).toEqual([]);

    lifecycle.browserTabLifecycle(tab).pendingGeneration = 1;
    expect(handlers.handleBrowserPageLoad({
      payload: {
        label: 'native-tab-a',
        url: 'https://second.example',
        phase: 'started',
      },
    })).toBe(false);
    lifecycle.browserTabLifecycle(tab).pendingGeneration = 2;

    expect(handlers.handleBrowserPageLoad({
      payload: {
        label: 'native-tab-a',
        url: 'https://second.example',
        phase: 'started',
      },
    })).toBe(true);
    expect(tab.loading).toBe(true);
    expect(handlers.handleBrowserPageLoad({
      payload: {
        label: 'native-tab-a',
        url: 'https://second.example',
        phase: 'finished',
      },
    })).toBe(true);
    expect(handlers.handleBrowserTitle({
      payload: {
        label: 'native-tab-a',
        url: 'https://second.example',
        title: 'Current second title',
      },
    })).toBe(true);
    expect(tab).toMatchObject({
      url: 'https://second.example',
      title: 'Current second title',
      loading: false,
    });
    expect(handlers.calls).toEqual([
      'render',
      'controls',
      'render',
      'url',
      'save',
      'render',
      'url',
      'save',
    ]);
  });

  it('ignores native events for dormant tabs and destroyed pane views', () => {
    const lifecycle = browserLifecycleHarness();
    const project = {
      id: 'project-a',
      browsersByWorktree: {} as Record<string, unknown>,
    };
    const tab: BrowserNavigationTab = {
      id: 'tab-a',
      url: 'https://saved.example',
      created: false,
      loading: false,
      title: 'Saved title',
      history: ['https://saved.example'],
      historyIndex: 0,
    };
    const browser = { activeTabId: tab.id, tabs: [tab] };
    project.browsersByWorktree['/workspace'] = browser;
    const pane: BrowserPaneThreadFixture = {
      id: 'web-pane',
      kind: 'web',
      projectId: project.id,
      worktreePath: '/workspace',
    };
    Object.assign(lifecycle.browserTabLifecycle(tab), {
      generation: 1,
      nativeLabel: 'native-tab-a',
      liveGeneration: 1,
      liveUrl: tab.url,
      viewLive: false,
    });
    const handlers = browserNativeEventHandlers({
      lifecycle,
      project,
      worktreePath: '/workspace',
      browser,
      tab,
      pane,
    });
    const finishedEvent = {
      payload: {
        label: 'native-tab-a',
        url: tab.url,
        phase: 'finished',
      },
    };

    expect(handlers.handleBrowserPageLoad(finishedEvent)).toBe(false);
    expect(handlers.handleBrowserTitle({
      payload: {
        label: 'native-tab-a',
        url: tab.url,
        title: 'Stale title',
      },
    })).toBe(false);

    tab.created = true;
    Object.assign(lifecycle.browserTabLifecycle(tab), {
      viewLive: true,
      liveGeneration: 1,
    });
    lifecycle.browserTabLifecycle(tab).closing = true;
    expect(handlers.handleBrowserPageLoad(finishedEvent)).toBe(false);
    lifecycle.browserTabLifecycle(tab).closing = false;
    lifecycle.browserPaneLifecycle(pane).tearingDown = true;
    expect(handlers.handleBrowserPageLoad(finishedEvent)).toBe(false);
    lifecycle.browserPaneLifecycle(pane).tearingDown = false;
    handlers.setPane(null);
    expect(handlers.handleBrowserPageLoad(finishedEvent)).toBe(false);
    expect(tab).toMatchObject({
      url: 'https://saved.example',
      title: 'Saved title',
      loading: false,
    });
    expect(handlers.calls).toEqual([]);
  });

  it('accepts current page-load and title events before native navigation settles', async () => {
    let resolveNavigation!: () => void;
    const lifecycle = browserLifecycleHarness();
    const project = {
      id: 'project-a',
      browsersByWorktree: {} as Record<string, unknown>,
    };
    const tab: BrowserNavigationTab = {
      id: 'tab-a',
      url: 'https://old.example',
      created: false,
      loading: false,
      title: 'Old title',
      history: ['https://old.example'],
      historyIndex: 0,
    };
    const browser = { activeTabId: tab.id, tabs: [tab] };
    project.browsersByWorktree['/workspace'] = browser;
    const dependencies = browserNavigationDependencies(
      project,
      browser,
      tab,
      (command) => command === 'browser_navigate'
        ? new Promise<void>((resolve) => { resolveNavigation = resolve; })
        : Promise.resolve(),
      lifecycle,
    );
    const navigateBrowser = compileFunction<
      (url: string, options: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'navigateBrowser'), dependencies);
    const handlers = browserNativeEventHandlers({
      lifecycle,
      project,
      worktreePath: '/workspace',
      browser,
      tab,
      pane: dependencies.findBrowserPane() as BrowserPaneThreadFixture,
      nativeLabel: 'project-a:tab-a',
    });

    const navigation = navigateBrowser('https://current.example', { tabId: tab.id });
    let settled = false;
    navigation.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();

    expect(handlers.handleBrowserPageLoad({
      payload: {
        label: 'project-a:tab-a',
        url: 'https://current.example',
        phase: 'started',
      },
    })).toBe(true);
    expect(handlers.handleBrowserPageLoad({
      payload: {
        label: 'project-a:tab-a',
        url: 'https://current.example',
        phase: 'finished',
      },
    })).toBe(true);
    expect(handlers.handleBrowserTitle({
      payload: {
        label: 'project-a:tab-a',
        url: 'https://current.example',
        title: 'Current title',
      },
    })).toBe(true);
    expect(settled).toBe(false);
    expect(tab).toMatchObject({
      created: false,
      loading: false,
      url: 'https://current.example',
      title: 'Current title',
    });

    resolveNavigation();
    await expect(navigation).resolves.toBe(true);
    expect(tab).toMatchObject({
      created: true,
      loading: false,
      url: 'https://current.example',
      title: 'Current title',
    });
    expect(tab).not.toHaveProperty('pendingGeneration');
    expect(tab).not.toHaveProperty('pendingUrl');
    expect(tab).not.toHaveProperty('nativeLabel');
    expect(tab).not.toHaveProperty('liveGeneration');
    expect(tab).not.toHaveProperty('liveUrl');
    expect(tab).not.toHaveProperty('eventUrl');
    expect(tab).not.toHaveProperty('viewLive');
    expect(tab).not.toHaveProperty('navigationSnapshot');
  });

  it('serializes rapid same-tab navigation when the first succeeds and the second fails', async () => {
    let resolveFirst!: () => void;
    let rejectSecond!: (error: Error) => void;
    const fallbackTimers: Array<() => void> = [];
    let loadedCalls = 0;
    const commands: string[] = [];
    const nativeCalls: Array<{ command: string; url?: unknown }> = [];
    const project = { id: 'project-a' };
    const tab: BrowserNavigationTab = {
      id: 'tab-a',
      url: 'https://old.example',
      created: false,
      loading: false,
      title: 'Old title',
      history: ['https://old.example'],
      historyIndex: 0,
    };
    const browser = { activeTabId: tab.id, tabs: [tab] };
    const dependencies = browserNavigationDependencies(
      project,
      browser,
      tab,
      (command, args) => {
        commands.push(command);
        if (command !== 'browser_navigate') return Promise.resolve();
        nativeCalls.push({ command, url: args.url });
        if (args.url === 'https://first.example') {
          return new Promise<void>((resolve) => { resolveFirst = resolve; });
        }
        return new Promise<void>((_resolve, reject) => { rejectSecond = reject; });
      },
    );
    dependencies.setTimeout = (callback: () => void) => {
      fallbackTimers.push(callback);
      return fallbackTimers.length;
    };
    dependencies.markBrowserTabLoaded = () => {
      loadedCalls += 1;
      tab.loading = false;
    };
    const navigateBrowser = compileFunction<
      (url: string, options: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'navigateBrowser'), dependencies);

    const first = navigateBrowser('https://first.example', { tabId: tab.id });
    const second = navigateBrowser('https://second.example', { tabId: tab.id });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeCalls).toEqual([{
      command: 'browser_navigate',
      url: 'https://first.example',
    }]);

    resolveFirst();
    await expect(first).resolves.toBe(true);
    await Promise.resolve();
    expect(nativeCalls).toEqual([
      { command: 'browser_navigate', url: 'https://first.example' },
      { command: 'browser_navigate', url: 'https://second.example' },
    ]);

    rejectSecond(new Error('second navigation failed'));
    await expect(second).resolves.toBe(false);
    expect(tab).toMatchObject({
      created: true,
      loading: false,
      url: 'https://first.example',
      title: 'https://first.example',
      history: ['https://old.example', 'https://first.example'],
      historyIndex: 1,
    });
    expect(fallbackTimers).toHaveLength(1);
    fallbackTimers.forEach((callback) => callback());
    await Promise.resolve();
    expect(tab.loading).toBe(false);
    expect(loadedCalls).toBe(0);
    expect(commands).not.toContain('browser_destroy');
    expect(tab).not.toHaveProperty('generation');
    expect(tab).not.toHaveProperty('invalidationGeneration');
    expect(tab).not.toHaveProperty('navigationTail');
  });

  it('serializes rapid same-tab navigation when the first fails and the second succeeds', async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: () => void;
    const commands: string[] = [];
    const nativeCalls: Array<{ command: string; url?: unknown }> = [];
    const project = { id: 'project-a' };
    const tab: BrowserNavigationTab = {
      id: 'tab-a',
      url: 'https://old.example',
      created: false,
      loading: false,
      title: 'Old title',
      history: ['https://old.example'],
      historyIndex: 0,
    };
    const browser = { activeTabId: tab.id, tabs: [tab] };
    const navigateBrowser = compileFunction<
      (url: string, options: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'navigateBrowser'), browserNavigationDependencies(
      project,
      browser,
      tab,
      (command, args) => {
        commands.push(command);
        if (command !== 'browser_navigate') return Promise.resolve();
        nativeCalls.push({ command, url: args.url });
        if (args.url === 'https://first.example') {
          return new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
        }
        return new Promise<void>((resolve) => { resolveSecond = resolve; });
      },
    ));

    const first = navigateBrowser('https://first.example', { tabId: tab.id });
    const second = navigateBrowser('https://second.example', { tabId: tab.id });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeCalls).toEqual([{
      command: 'browser_navigate',
      url: 'https://first.example',
    }]);

    rejectFirst(new Error('first navigation failed'));
    await expect(first).resolves.toBe(false);
    await Promise.resolve();
    expect(nativeCalls).toEqual([
      { command: 'browser_navigate', url: 'https://first.example' },
      { command: 'browser_navigate', url: 'https://second.example' },
    ]);

    resolveSecond();
    await expect(second).resolves.toBe(true);
    expect(tab).toMatchObject({
      created: true,
      url: 'https://second.example',
      title: 'https://second.example',
      history: ['https://old.example', 'https://second.example'],
      historyIndex: 1,
    });
    expect(commands).not.toContain('browser_destroy');
    expect(tab).not.toHaveProperty('generation');
    expect(tab).not.toHaveProperty('invalidationGeneration');
    expect(tab).not.toHaveProperty('navigationTail');
  });

  it('keeps dormant restoration pending until native navigation creates the tab', async () => {
    let resolveNavigation!: () => void;
    const nativeNavigation = new Promise<void>((resolve) => {
      resolveNavigation = resolve;
    });
    const project = { id: 'project-a' };
    const tab: BrowserNavigationTab = {
      id: 'tab-a',
      url: 'https://example.com',
      created: false,
      loading: false,
      title: 'Example',
      history: ['https://example.com', 'https://example.org'],
      historyIndex: 1,
    };
    const browser = { activeTabId: tab.id, tabs: [tab] };
    const navigateBrowser = compileFunction<
      (url: string, options: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'navigateBrowser'), browserNavigationDependencies(
      project,
      browser,
      tab,
      (command) => command === 'browser_navigate' ? nativeNavigation : Promise.resolve(),
    ));
    const restoreDormantBrowserTab = compileFunction<
      (value: typeof project, valueTab: BrowserNavigationTab) => Promise<boolean>
    >(functionSource(mainJs, 'restoreDormantBrowserTab'), {
      ...browserLifecycleHarness(),
      activeWorkspaceRoot: () => '/workspace',
      findBrowserPane: () => null,
      navigateBrowser,
    });

    const restoration = restoreDormantBrowserTab(project, tab);
    let settled = false;
    restoration.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(tab.created).toBe(false);

    resolveNavigation();
    await expect(restoration).resolves.toBe(true);
    expect(tab.created).toBe(true);
    expect(tab.history).toEqual(['https://example.com', 'https://example.org']);
    expect(tab.historyIndex).toBe(1);
  });

  async function expectLatestDormantSelectionWins(
    completionOrder: ['tab-a' | 'tab-b', 'tab-a' | 'tab-b'],
  ) {
    const project = { id: 'project-a' };
    const pane = {
      id: 'web-pane',
      kind: 'web',
      projectId: project.id,
      worktreePath: '/workspace',
      closing: false,
      closeStarted: false,
    };
    const tabA: BrowserNavigationTab = {
      id: 'tab-a',
      url: 'https://a.example',
      created: false,
      loading: false,
      title: 'A',
      history: ['https://a.example'],
      historyIndex: 0,
    };
    const tabB: BrowserNavigationTab = {
      id: 'tab-b',
      url: 'https://b.example',
      created: false,
      loading: false,
      title: 'B',
      history: ['https://b.example'],
      historyIndex: 0,
    };
    const browser = { activeTabId: tabA.id, tabs: [tabA, tabB] };
    const pending = new Map<string, () => void>();
    const dependencies = browserNavigationDependencies(
      project,
      browser,
      tabA,
      (command, args) => {
        if (command !== 'browser_navigate') return Promise.resolve();
        const tabId = String(args.label).split(':').at(-1) ?? '';
        return new Promise<void>((resolve) => { pending.set(tabId, resolve); });
      },
    );
    Object.assign(dependencies, {
      createBrowserPane: async () => pane,
      findBrowserPane: () => pane,
      findThread: () => pane,
    });
    const navigateBrowser = compileFunction<
      (url: string, options: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'navigateBrowser'), dependencies);
    const lifecycle = browserLifecycleHarness();
    const restoreDormantBrowserTab = compileFunction<
      (value: typeof project, tab: BrowserNavigationTab) => Promise<boolean>
    >(functionSource(mainJs, 'restoreDormantBrowserTab'), {
      ...lifecycle,
      activeWorkspaceRoot: () => '/workspace',
      findBrowserPane: () => pane,
      navigateBrowser,
    });
    const activateBrowserTab = compileFunction<
      (value: typeof project, tabId: string) => Promise<boolean>
    >(functionSource(mainJs, 'activateBrowserTab'), {
      ...lifecycle,
      activeProject: () => project,
      activeWorkspaceRoot: () => '/workspace',
      findBrowserPane: () => pane,
      ensureBrowserModel: () => browser,
      markActiveSurface: () => {},
      renderBrowserTabs: () => {},
      syncProjectBrowser: () => {},
      saveWorkspaceSoon: () => {},
      restoreDormantBrowserTab,
    });

    const activateA = activateBrowserTab(project, tabA.id);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(pending.has(tabA.id)).toBe(true);

    const activateB = activateBrowserTab(project, tabB.id);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(pending.has(tabB.id)).toBe(true);
    expect(browser.activeTabId).toBe(tabB.id);

    pending.get(completionOrder[0])?.();
    await Promise.resolve();
    pending.get(completionOrder[1])?.();
    await Promise.all([activateA, activateB]);

    expect(browser.activeTabId).toBe(tabB.id);
    expect(tabA.created).toBe(true);
    expect(tabB.created).toBe(true);
  }

  it('keeps dormant tab B selected when A restoration completes before B', async () => {
    await expectLatestDormantSelectionWins(['tab-a', 'tab-b']);
  });

  it('keeps dormant tab B selected when B restoration completes before A', async () => {
    await expectLatestDormantSelectionWins(['tab-b', 'tab-a']);
  });

  it('preserves title, URL, history, and created state after native navigation failure', async () => {
    const writes: string[] = [];
    const project = { id: 'project-a' };
    const tab: BrowserNavigationTab = {
      id: 'tab-a',
      url: 'https://old.example',
      created: true,
      loading: false,
      title: 'Saved title',
      history: ['https://old.example', 'https://older.example'],
      historyIndex: 1,
    };
    const browser = { activeTabId: tab.id, tabs: [tab] };
    const dependencies = browserNavigationDependencies(
      project,
      browser,
      tab,
      async (command) => {
        if (command === 'browser_navigate') throw new Error('native unavailable');
      },
    );
    dependencies.writeToActive = (text: string) => writes.push(text);
    const navigateBrowser = compileFunction<
      (url: string, options: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'navigateBrowser'), dependencies);

    await expect(navigateBrowser('https://example.com', { tabId: tab.id })).resolves.toBe(false);
    expect(tab).toMatchObject({
      created: true,
      loading: false,
      title: 'Saved title',
      url: 'https://old.example',
      history: ['https://old.example', 'https://older.example'],
      historyIndex: 1,
    });
    expect(writes).toEqual(['\r\n\x1b[31m[browser_navigate]\x1b[0m Error: native unavailable\r\n']);
  });

  it('does not create or mutate tabs for an explicitly requested missing tab', async () => {
    const calls: string[] = [];
    const project = { id: 'project-a' };
    const tab: BrowserNavigationTab = {
      id: 'tab-a',
      url: 'https://old.example',
      created: false,
      loading: false,
      title: 'Old',
      history: ['https://old.example'],
      historyIndex: 0,
    };
    const browser = { activeTabId: tab.id, tabs: [tab] };
    const dependencies = browserNavigationDependencies(
      project,
      browser,
      tab,
      async (command) => { calls.push(command); },
    );
    dependencies.createBrowserPane = async () => {
      calls.push('create-pane');
      return {
        id: 'web-pane',
        kind: 'web',
        projectId: project.id,
        worktreePath: '/workspace',
        closing: false,
        closeStarted: false,
      };
    };
    dependencies.createBrowserTab = () => {
      calls.push('create-tab');
      return tab;
    };
    const navigateBrowser = compileFunction<
      (url: string, options: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'navigateBrowser'), dependencies);

    await expect(navigateBrowser('https://example.com', { tabId: 'missing' })).resolves.toBe(false);
    expect(calls).toEqual([]);
    expect(browser).toEqual({ activeTabId: 'tab-a', tabs: [tab] });
    expect(tab).toMatchObject({
      created: false,
      loading: false,
      url: 'https://old.example',
      history: ['https://old.example'],
      historyIndex: 0,
    });
  });

  it('does not restore missing, blank, or already-created browser tabs', async () => {
    const restoreDormantBrowserTab = compileFunction<
      (project: unknown, tab: { created?: boolean; url?: string; id?: string } | null) => Promise<boolean>
    >(functionSource(mainJs, 'restoreDormantBrowserTab'), {
      ...browserLifecycleHarness(),
      activeWorkspaceRoot: () => '/workspace',
      findBrowserPane: () => null,
      navigateBrowser: async () => { throw new Error('must not navigate'); },
    });

    await expect(restoreDormantBrowserTab({}, null)).resolves.toBe(false);
    await expect(restoreDormantBrowserTab({}, { id: 'created', url: 'https://example.com', created: true })).resolves.toBe(false);
    await expect(restoreDormantBrowserTab({}, { id: 'blank', url: 'about:blank', created: false })).resolves.toBe(false);
    await expect(restoreDormantBrowserTab({}, { id: 'missing-url', created: false })).resolves.toBe(false);
  });

  it('activates valid tabs and lazily restores dormant ones', async () => {
    const calls: string[] = [];
    const project: BrowserProjectFixture = {
      browsersByWorktree: {
        '/workspace': {
          activeTabId: 'old',
          tabs: [{ id: 'old', created: true }, { id: 'dormant', created: false }],
        },
      },
    };
    const activateBrowserTab = compileFunction<
      (project: BrowserProjectFixture, tabId: string) => Promise<boolean>
    >(functionSource(mainJs, 'activateBrowserTab'), {
      ...browserLifecycleHarness(),
      activeProject: () => project,
      activeWorkspaceRoot: () => '/workspace',
      findBrowserPane: () => null,
      ensureBrowserModel: (value: typeof project) => value.browsersByWorktree['/workspace'],
      markActiveSurface: () => calls.push('surface'),
      renderBrowserTabs: () => calls.push('render'),
      syncProjectBrowser: () => calls.push('sync'),
      saveWorkspaceSoon: () => calls.push('save'),
      restoreDormantBrowserTab: async (_: typeof project, tab: { id: string }) => {
        calls.push(`restore:${tab.id}`);
      },
    });

    await expect(activateBrowserTab(project, 'dormant')).resolves.toBe(true);
    await expect(activateBrowserTab(project, 'missing')).resolves.toBe(false);
    expect(project.browsersByWorktree['/workspace'].activeTabId).toBe('dormant');
    expect(calls).toEqual(['surface', 'render', 'sync', 'save', 'restore:dormant']);
  });

  it('restores an existing active dormant tab when reopening a browser pane', async () => {
    const calls: string[] = [];
    const project = { id: 'project-a' };
    const activeTab: ActiveDormantBrowserTabFixture = { id: 'tab-a', created: false, url: 'https://example.com' };
    const browser = { tabs: [activeTab], activeTabId: activeTab.id };
    const openBlankBrowserTab = compileFunction<
      (options?: { requireNew?: boolean }) => Promise<ActiveDormantBrowserTabFixture | null>
    >(functionSource(mainJs, 'openBlankBrowserTab'), {
      ...browserLifecycleHarness(),
      activeProject: () => project,
      activeWorkspaceRoot: () => '/workspace',
      findBrowserPane: () => null,
      createBrowserPane: async () => ({ id: 'web-pane' }),
      markActiveSurface: () => calls.push('surface'),
      ensureBrowserModel: () => browser,
      createBrowserTab: () => { throw new Error('must not create'); },
      renderBrowserTabs: () => calls.push('render'),
      syncProjectBrowser: () => calls.push('sync'),
      restoreDormantBrowserTab: async (_: typeof project, tab: typeof activeTab) => {
        calls.push(`restore:${tab.id}`);
        tab.created = true;
      },
      currentBrowserTab: () => activeTab,
      urlInput: { focus: () => calls.push('focus') },
    });

    await expect(openBlankBrowserTab()).resolves.toBe(activeTab);
    expect(calls).toEqual(['surface', 'render', 'sync', 'restore:tab-a', 'focus']);
  });

  it('invalidates in-flight navigation and blocks navigation or new tabs during pane teardown', async () => {
    let resolveNavigation!: () => void;
    let resolveTeardown!: (outcome: {
      destroyed: string[];
      failures: Array<{ label: string; error: string }>;
    }) => void;
    const lifecycle = browserLifecycleHarness();
    let panePresent = true;
    const calls: string[] = [];
    const thread = {
      id: 'web-pane',
      kind: 'web',
      projectId: 'project-a',
      worktreePath: '/workspace',
      closing: false,
      closeStarted: false,
    };
    const project = { id: 'project-a' };
    const tab: BrowserNavigationTab = {
      id: 'tab-a',
      created: true,
      loading: false,
      url: 'https://old.example',
      title: 'Saved title',
      history: ['https://old.example'],
      historyIndex: 0,
    };
    const browser = { activeTabId: tab.id, tabs: [tab] };
    const invoke = (
      command: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push(command);
      if (command === 'browser_navigate') {
        return new Promise<void>((resolve) => { resolveNavigation = resolve; });
      }
      if (command === 'browser_destroy_many') {
        return new Promise((resolve) => { resolveTeardown = resolve; });
      }
      if (command === 'browser_destroy') {
        expect(args).toEqual({ label: 'project-a:tab-a' });
        return Promise.resolve();
      }
      return Promise.resolve();
    };
    const navigationDependencies = browserNavigationDependencies(
      project,
      browser,
      tab,
      invoke as (command: string, args: Record<string, unknown>) => Promise<void>,
    );
    Object.assign(navigationDependencies, lifecycle, {
      activeWorkspaceRoot: () => '/workspace',
      createBrowserPane: async () => {
        if (!panePresent) throw new Error('queued navigation recreated the removed pane');
        return thread;
      },
      findBrowserPane: () => panePresent ? thread : null,
      findThread: () => panePresent ? thread : null,
      browserNavigationIsCurrent: (context: {
        tab: BrowserNavigationTab;
        pane: typeof thread;
        browser: typeof browser;
        generation: number;
      }) => (
        !lifecycle.browserTabIsClosing(context.tab) &&
        !lifecycle.browserPaneIsClosing(context.pane) &&
        lifecycle.browserTabLifecycle(context.tab).generation === context.generation &&
        context.browser.tabs.includes(context.tab)
      ),
      discardObsoleteBrowserNavigation: async (context: {
        tab: BrowserNavigationTab;
        browser: typeof browser;
        label: string;
        previousTitle: string;
      }) => {
        lifecycle.invalidateBrowserNavigation(context.tab);
        await invoke('browser_destroy', { label: context.label });
        if (context.browser.tabs.includes(context.tab)) {
          context.tab.created = false;
          context.tab.loading = false;
          context.tab.title = context.previousTitle;
        }
        return true;
      },
    });
    const navigateBrowser = compileFunction<
      (url: string, options: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'navigateBrowser'), navigationDependencies);
    const closeBrowserPane = compileFunction<
      (value: typeof thread) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserPane'), {
      ...lifecycle,
      findProject: () => project,
      ensureBrowserModel: () => browser,
      invoke,
      browserLabelForTab: () => 'project-a:tab-a',
      setStatus: () => {},
      saveWorkspaceSoon: () => calls.push('save'),
      stageBrowserSurface: () => calls.push('stage'),
      closeThread: () => {
        calls.push('close');
        panePresent = false;
        thread.closeStarted = true;
        thread.closing = true;
        return true;
      },
      state: { activeThreadId: 'web-pane' },
      markActiveSurface: () => calls.push('surface'),
    });
    const openBlankBrowserTab = compileFunction<
      (options?: { requireNew?: boolean }) => Promise<BrowserNavigationTab | null>
    >(functionSource(mainJs, 'openBlankBrowserTab'), {
      ...lifecycle,
      activeProject: () => project,
      activeWorkspaceRoot: () => '/workspace',
      findBrowserPane: () => thread,
      createBrowserPane: async () => { throw new Error('must not create pane'); },
      markActiveSurface: () => { throw new Error('must not activate'); },
      ensureBrowserModel: () => browser,
      createBrowserTab: () => { throw new Error('must not create tab'); },
      renderBrowserTabs: () => {},
      syncProjectBrowser: () => {},
      restoreDormantBrowserTab: async () => false,
      currentBrowserTab: () => tab,
      urlInput: null,
    });

    const navigation = navigateBrowser('https://new.example', { tabId: tab.id });
    await Promise.resolve();
    const queuedNavigation = navigateBrowser('https://queued.example', { tabId: tab.id });
    await Promise.resolve();
    expect(calls).toEqual(['browser_navigate']);
    const closing = closeBrowserPane(thread);
    await Promise.resolve();

    await expect(navigateBrowser('https://blocked.example', { tabId: tab.id })).resolves.toBe(false);
    await expect(openBlankBrowserTab({ requireNew: true })).resolves.toBeNull();
    await expect(closeBrowserPane(thread)).resolves.toBe(false);
    expect(calls).toEqual(['browser_navigate']);

    resolveNavigation();
    await expect(navigation).resolves.toBe(false);
    await expect(queuedNavigation).resolves.toBe(false);
    await Promise.resolve();
    expect(calls).toEqual([
      'browser_navigate',
      'browser_destroy',
      'browser_destroy_many',
    ]);

    resolveTeardown({
      destroyed: ['project-a:tab-a'],
      failures: [],
    });
    await expect(closing).resolves.toBe(true);
    expect(tab).toMatchObject({
      created: false,
      loading: false,
      url: 'https://old.example',
      history: ['https://old.example'],
      historyIndex: 0,
    });

    expect(tab).toMatchObject({
      created: false,
      loading: false,
      title: 'Saved title',
      url: 'https://old.example',
      history: ['https://old.example'],
      historyIndex: 0,
    });
    expect(calls).toEqual([
      'browser_navigate',
      'browser_destroy',
      'browser_destroy_many',
      'save',
      'stage',
      'close',
      'surface',
    ]);
  });

  it('drains stale navigation cleanup before partial pane recovery recreates its native label', async () => {
    let resolveNavigation!: () => void;
    const lifecycle = browserLifecycleHarness();
    const calls: string[] = [];
    const statuses: Array<[string, string]> = [];
    const thread = {
      id: 'web-pane',
      kind: 'web',
      projectId: 'project-a',
      worktreePath: '/workspace',
      closing: false,
      closeStarted: false,
    };
    const project = { id: 'project-a' };
    const tab: BrowserNavigationTab = {
      id: 'tab-a',
      created: true,
      loading: false,
      url: 'https://saved.example',
      title: 'Saved title',
      history: ['https://saved.example'],
      historyIndex: 0,
    };
    const failedTab: BrowserNavigationTab = {
      id: 'tab-b',
      created: true,
      loading: false,
      url: 'https://failed.example',
      title: 'Failed tab',
      history: ['https://failed.example'],
      historyIndex: 0,
    };
    const browser = { activeTabId: tab.id, tabs: [tab, failedTab] };
    const nativeViews = new Set(['project-a:tab-a', 'project-a:tab-b']);
    const invoke = (
      command: string,
      args: { labels?: string[]; label?: string; url?: string },
    ): Promise<unknown> => {
      if (command === 'browser_navigate' && args.url === 'https://new.example') {
        calls.push(`navigate:${args.label}`);
        return new Promise<void>((resolve) => { resolveNavigation = resolve; });
      }
      if (command === 'browser_destroy') {
        calls.push(`destroy:${args.label}`);
        nativeViews.delete(String(args.label));
        return Promise.resolve();
      }
      if (command === 'browser_destroy_many') {
        calls.push(`destroy-many:${args.labels?.join(',')}`);
        nativeViews.delete('project-a:tab-a');
        return Promise.resolve({
          destroyed: ['project-a:tab-a'],
          failures: [{
            label: 'project-a:tab-b',
            error: 'tab-b destroy failed',
          }],
        });
      }
      if (command === 'browser_navigate') {
        calls.push(`recover:${args.label}`);
        nativeViews.add(String(args.label));
        return Promise.resolve();
      }
      throw new Error(`unexpected command ${command}`);
    };
    const navigationDependencies = browserNavigationDependencies(
      project,
      browser,
      tab,
      invoke as (command: string, args: Record<string, unknown>) => Promise<void>,
    );
    Object.assign(navigationDependencies, lifecycle, {
      activeWorkspaceRoot: () => '/workspace',
      createBrowserPane: async () => thread,
      findBrowserPane: () => thread,
      findThread: () => thread,
      discardObsoleteBrowserNavigation: async (context: {
        tab: BrowserNavigationTab;
        browser: typeof browser;
        label: string;
        previousTitle: string;
      }) => {
        lifecycle.invalidateBrowserNavigation(context.tab);
        await invoke('browser_destroy', { label: context.label });
        if (context.browser.tabs.includes(context.tab)) {
          context.tab.created = false;
          context.tab.loading = false;
          context.tab.title = context.previousTitle;
        }
        return true;
      },
    });
    const navigateBrowser = compileFunction<
      (url: string, options: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'navigateBrowser'), navigationDependencies);
    const closeBrowserPane = compileFunction<
      (value: typeof thread) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserPane'), {
      ...lifecycle,
      findProject: () => project,
      ensureBrowserModel: () => browser,
      invoke,
      browserLabelForTab: (_: typeof project, value: BrowserNavigationTab) =>
        `${project.id}:${value.id}`,
      nativeBrowserLabel: (label: string) => label,
      setStatus: (text: string, level: string) => statuses.push([text, level]),
      saveWorkspaceSoon: () => calls.push('save'),
      stageBrowserSurface: () => calls.push('stage'),
      closeThread: () => { calls.push('close'); return true; },
      syncProjectBrowser: () => calls.push('sync'),
      state: { activeThreadId: 'web-pane' },
      markActiveSurface: () => calls.push('surface'),
    });

    const navigation = navigateBrowser('https://new.example', { tabId: tab.id });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['navigate:project-a:tab-a']);

    const closing = closeBrowserPane(thread);
    let closeSettled = false;
    closing.then(() => { closeSettled = true; });
    await Promise.resolve();
    await Promise.resolve();

    expect(closeSettled).toBe(false);
    expect(calls).toEqual(['navigate:project-a:tab-a']);
    await expect(navigateBrowser('https://blocked.example', { tabId: tab.id })).resolves.toBe(false);

    resolveNavigation();
    await expect(navigation).resolves.toBe(false);
    await expect(closing).resolves.toBe(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(tab).toMatchObject({
      created: true,
      loading: false,
      url: 'https://saved.example',
      history: ['https://saved.example'],
      historyIndex: 0,
    });
    expect(failedTab.created).toBe(true);
    expect(nativeViews).toEqual(new Set(['project-a:tab-a', 'project-a:tab-b']));
    expect(calls).toEqual([
      'navigate:project-a:tab-a',
      'destroy:project-a:tab-a',
      'destroy-many:project-a:tab-a,project-a:tab-b',
      'recover:project-a:tab-a',
      'sync',
      'save',
    ]);
    expect(statuses).toEqual([[
      'browser pane close failed; native close failures: project-a:tab-b: tab-b destroy failed; recreated 1/1 confirmed-destroyed live tabs',
      'error',
    ]]);
  });

  it('recovers a retained live pane after stale cleanup and destroy-many transport rejection', async () => {
    let resolveNavigation!: () => void;
    const lifecycle = browserLifecycleHarness();
    const calls: string[] = [];
    const statuses: Array<[string, string]> = [];
    const thread: BrowserPaneThreadFixture = {
      id: 'web-pane',
      kind: 'web',
      projectId: 'project-a',
      worktreePath: '/workspace',
    };
    const project = { id: 'project-a' };
    const tab: BrowserNavigationTab = {
      id: 'tab-a',
      created: true,
      loading: false,
      url: 'https://saved.example/current',
      title: 'Saved current title',
      history: ['https://saved.example', 'https://saved.example/current'],
      historyIndex: 1,
    };
    const browser = { activeTabId: tab.id, tabs: [tab] };
    const nativeViews = new Set(['project-a:tab-a']);
    const invoke = (
      command: string,
      args: { labels?: string[]; label?: string; url?: string },
    ): Promise<unknown> => {
      if (command === 'browser_navigate' && args.url === 'https://new.example') {
        calls.push(`navigate:${args.url}`);
        return new Promise<void>((resolve) => { resolveNavigation = resolve; });
      }
      if (command === 'browser_destroy') {
        calls.push(`destroy:${args.label}`);
        nativeViews.delete(String(args.label));
        return Promise.resolve();
      }
      if (command === 'browser_destroy_many') {
        calls.push(`destroy-many:${args.labels?.join(',')}`);
        return Promise.reject(new Error('ipc disconnected'));
      }
      if (command === 'browser_navigate') {
        calls.push(`recover:${args.label}:${args.url}`);
        nativeViews.add(String(args.label));
        return Promise.resolve();
      }
      throw new Error(`unexpected command ${command}`);
    };
    const navigationDependencies = browserNavigationDependencies(
      project,
      browser,
      tab,
      invoke as (command: string, args: Record<string, unknown>) => Promise<void>,
      lifecycle,
    );
    Object.assign(navigationDependencies, {
      createBrowserPane: async () => thread,
      findBrowserPane: () => thread,
      findThread: () => thread,
      discardObsoleteBrowserNavigation: async (context: {
        tab: BrowserNavigationTab;
        browser: typeof browser;
        label: string;
        previousTitle: string;
      }) => {
        lifecycle.invalidateBrowserNavigation(context.tab);
        await invoke('browser_destroy', { label: context.label });
        if (context.browser.tabs.includes(context.tab)) {
          context.tab.created = false;
          context.tab.loading = false;
          context.tab.title = context.previousTitle;
        }
        return true;
      },
    });
    const navigateBrowser = compileFunction<
      (url: string, options: Record<string, unknown>) => Promise<boolean>
    >(functionSource(mainJs, 'navigateBrowser'), navigationDependencies);
    const closeBrowserPane = compileFunction<
      (value: BrowserPaneThreadFixture) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserPane'), {
      ...lifecycle,
      findProject: () => project,
      ensureBrowserModel: () => browser,
      invoke,
      browserLabelForTab: (_: typeof project, value: BrowserNavigationTab) =>
        `${project.id}:${value.id}`,
      nativeBrowserLabel: (label: string) => label,
      setStatus: (text: string, level: string) => statuses.push([text, level]),
      saveWorkspaceSoon: () => calls.push('save'),
      stageBrowserSurface: () => calls.push('stage'),
      closeThread: () => { calls.push('close'); return true; },
      syncProjectBrowser: () => calls.push('sync'),
      state: { activeThreadId: thread.id },
      markActiveSurface: () => calls.push('surface'),
    });

    const navigation = navigateBrowser('https://new.example', { tabId: tab.id });
    await Promise.resolve();
    await Promise.resolve();
    const closing = closeBrowserPane(thread);
    await Promise.resolve();
    expect(calls).toEqual(['navigate:https://new.example']);

    resolveNavigation();
    await expect(navigation).resolves.toBe(false);
    await expect(closing).resolves.toBe(false);

    expect(browser.activeTabId).toBe(tab.id);
    expect(tab).toEqual({
      id: 'tab-a',
      created: true,
      loading: false,
      url: 'https://saved.example/current',
      title: 'Saved current title',
      history: ['https://saved.example', 'https://saved.example/current'],
      historyIndex: 1,
    });
    expect(nativeViews).toEqual(new Set(['project-a:tab-a']));
    expect(calls).toEqual([
      'navigate:https://new.example',
      'destroy:project-a:tab-a',
      'destroy-many:project-a:tab-a',
      'recover:project-a:tab-a:https://saved.example/current',
      'sync',
      'save',
    ]);
    expect(statuses).toEqual([[
      'browser pane close failed before structured teardown outcome: Error: ipc disconnected; recreated 1/1 missing live tabs',
      'error',
    ]]);
  });

  it('destroys pane views before staging and preserves tabs as dormant', async () => {
    const calls: string[] = [];
    const thread: BrowserPaneThreadFixture = { id: 'web-pane', kind: 'web', projectId: 'project-a', worktreePath: '/workspace' };
    const project = { id: 'project-a' };
    const tabs = [
      { id: 'tab-a', created: true, loading: true },
      { id: 'tab-b', created: true, loading: false },
    ];
    const closeBrowserPane = compileFunction<
      (thread: BrowserPaneThreadFixture) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserPane'), {
      ...browserLifecycleHarness(),
      findProject: () => project,
      ensureBrowserModel: () => ({ tabs, activeTabId: 'tab-a' }),
      invoke: async (command: string, args: { labels: string[] }) => {
        calls.push(`${command}:${args.labels.join(',')}`);
        return { destroyed: args.labels, failures: [] };
      },
      browserLabelForTab: (_: typeof project, tab: { id: string }) => `${project.id}:${tab.id}`,
      setStatus: () => {},
      saveWorkspaceSoon: () => calls.push('save'),
      stageBrowserSurface: () => calls.push('stage'),
      closeThread: () => { calls.push('close'); return true; },
      state: { activeThreadId: 'web-pane' },
      markActiveSurface: (surface: string) => calls.push(`surface:${surface}`),
    });

    await expect(closeBrowserPane(thread)).resolves.toBe(true);
    expect(calls).toEqual([
      'browser_destroy_many:project-a:tab-a,project-a:tab-b',
      'save',
      'stage',
      'close',
      'surface:terminal',
    ]);
    expect(tabs).toEqual([
      { id: 'tab-a', created: false, loading: false },
      { id: 'tab-b', created: false, loading: false },
    ]);
  });

  it('skips native pane destruction for zero tabs and clears the pane guard on transport failure', async () => {
    const thread: BrowserPaneThreadFixture = { id: 'web-pane', kind: 'web', projectId: 'project-a', worktreePath: '/workspace' };
    const project = { id: 'project-a' };
    const emptyCalls: string[] = [];
    const emptyCloseBrowserPane = compileFunction<
      (thread: BrowserPaneThreadFixture) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserPane'), {
      ...browserLifecycleHarness(),
      findProject: () => project,
      ensureBrowserModel: () => ({ tabs: [] }),
      invoke: async () => emptyCalls.push('invoke'),
      browserLabelForTab: () => 'unused',
      setStatus: () => {},
      saveWorkspaceSoon: () => emptyCalls.push('save'),
      stageBrowserSurface: () => emptyCalls.push('stage'),
      closeThread: () => { emptyCalls.push('close'); return true; },
      state: { activeThreadId: null },
      markActiveSurface: () => {},
    });
    await expect(emptyCloseBrowserPane(thread)).resolves.toBe(true);
    expect(emptyCalls).toEqual(['save', 'stage', 'close']);

    const tabs = [{ id: 'tab-a', created: true, loading: true }];
    const statuses: Array<[string, string]> = [];
    const failureCalls: string[] = [];
    const lifecycle = browserLifecycleHarness();
    const failedCloseBrowserPane = compileFunction<
      (thread: BrowserPaneThreadFixture) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserPane'), {
      ...lifecycle,
      findProject: () => project,
      ensureBrowserModel: () => ({ tabs }),
      invoke: async (command: string) => {
        failureCalls.push(command);
        throw new Error('native unavailable');
      },
      browserLabelForTab: () => 'project-a:tab-a',
      setStatus: (text: string, level: string) => statuses.push([text, level]),
      saveWorkspaceSoon: () => failureCalls.push('save'),
      stageBrowserSurface: () => failureCalls.push('stage'),
      closeThread: () => { failureCalls.push('close'); return true; },
      syncProjectBrowser: () => failureCalls.push('sync'),
      state: { activeThreadId: 'web-pane' },
      markActiveSurface: () => failureCalls.push('surface'),
    });
    await expect(failedCloseBrowserPane(thread)).resolves.toBe(false);
    expect(tabs).toEqual([{ id: 'tab-a', created: true, loading: true }]);
    expect(failureCalls).toEqual(['browser_destroy_many']);
    expect(lifecycle.browserPaneLifecycle(thread).tearingDown).toBe(false);
    expect(statuses).toEqual([[
      'browser pane close failed before structured teardown outcome: Error: native unavailable',
      'error',
    ]]);
  });

  it('removes phantom-live state when partial pane teardown cannot be fully recovered', async () => {
    const thread: BrowserPaneThreadFixture = {
      id: 'web-pane',
      kind: 'web',
      projectId: 'project-a',
      worktreePath: '/workspace',
    };
    const project = { id: 'project-a' };
    const tabs = [
      {
        id: 'tab-a',
        created: true,
        loading: true,
        url: 'https://a.example/current',
        title: 'A current',
        history: ['https://a.example', 'https://a.example/current'],
        historyIndex: 1,
      },
      {
        id: 'tab-b',
        created: true,
        loading: false,
        url: 'https://b.example',
        title: 'B home',
        history: ['https://b.example'],
        historyIndex: 0,
      },
    ];
    const browser = { tabs, activeTabId: 'tab-a' };
    const nativeViews = new Set(['project-a:tab-a', 'project-a:tab-b']);
    const calls: string[] = [];
    const statuses: Array<[string, string]> = [];
    const closeBrowserPane = compileFunction<
      (value: BrowserPaneThreadFixture) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserPane'), {
      ...browserLifecycleHarness(),
      findProject: () => project,
      ensureBrowserModel: () => browser,
      invoke: async (command: string, args: { labels?: string[]; label?: string }) => {
        if (command === 'browser_destroy_many') {
          calls.push(`${command}:${args.labels?.join(',')}`);
          nativeViews.delete('project-a:tab-a');
          return {
            destroyed: ['project-a:tab-a'],
            failures: [{
              label: 'project-a:tab-b',
              error: 'destroy failed at project-a:tab-b',
            }],
          };
        }
        if (command === 'browser_navigate') {
          calls.push(`${command}:${args.label}`);
          if (args.label === 'project-a:tab-a') {
            throw new Error('tab-a restore unavailable');
          }
          nativeViews.add(String(args.label));
          return;
        }
        throw new Error(`unexpected command ${command}`);
      },
      browserLabelForTab: (_: typeof project, tab: { id: string }) => `${project.id}:${tab.id}`,
      nativeBrowserLabel: (label: string) => label,
      setStatus: (text: string, level: string) => statuses.push([text, level]),
      saveWorkspaceSoon: () => calls.push('save'),
      stageBrowserSurface: () => calls.push('stage'),
      closeThread: () => { calls.push('close'); return true; },
      syncProjectBrowser: () => calls.push('sync'),
      state: { activeThreadId: 'web-pane' },
      markActiveSurface: () => calls.push('surface'),
    });

    await expect(closeBrowserPane(thread)).resolves.toBe(false);
    expect(browser.activeTabId).toBe('tab-a');
    expect(tabs).toEqual([
      {
        id: 'tab-a',
        created: false,
        loading: false,
        url: 'https://a.example/current',
        title: 'A current',
        history: ['https://a.example', 'https://a.example/current'],
        historyIndex: 1,
      },
      {
        id: 'tab-b',
        created: true,
        loading: false,
        url: 'https://b.example',
        title: 'B home',
        history: ['https://b.example'],
        historyIndex: 0,
      },
    ]);
    expect(tabs.every((tab) => !tab.created || nativeViews.has(`project-a:${tab.id}`))).toBe(true);
    expect(calls).toEqual([
      'browser_destroy_many:project-a:tab-a,project-a:tab-b',
      'browser_navigate:project-a:tab-a',
      'sync',
      'save',
    ]);
    expect(statuses).toEqual([[
      'browser pane close failed; native close failures: project-a:tab-b: destroy failed at project-a:tab-b; recreated 0/1 confirmed-destroyed live tabs; recreation failures: tab-a: Error: tab-a restore unavailable',
      'error',
    ]]);
  });

  it('reconciles the original live tabs and active tab after partial pane teardown', async () => {
    const thread: BrowserPaneThreadFixture = {
      id: 'web-pane',
      kind: 'web',
      projectId: 'project-a',
      worktreePath: '/workspace',
    };
    const project = { id: 'project-a' };
    const tabs = [
      {
        id: 'tab-a',
        created: true,
        loading: true,
        url: 'https://a.example',
        title: 'A home',
        history: ['https://a.example'],
        historyIndex: 0,
      },
      {
        id: 'tab-b',
        created: true,
        loading: false,
        url: 'https://b.example/current',
        title: 'B current',
        history: ['https://b.example', 'https://b.example/current'],
        historyIndex: 1,
      },
      {
        id: 'tab-c',
        created: false,
        loading: false,
        url: 'https://c.example',
        title: 'C dormant',
        history: ['https://c.example'],
        historyIndex: 0,
      },
    ];
    const browser = { tabs, activeTabId: 'tab-b' };
    const nativeViews = new Set(['project-a:tab-a', 'project-a:tab-b']);
    const calls: string[] = [];
    const statuses: Array<[string, string]> = [];
    const closeBrowserPane = compileFunction<
      (value: BrowserPaneThreadFixture) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserPane'), {
      ...browserLifecycleHarness(),
      findProject: () => project,
      ensureBrowserModel: () => browser,
      invoke: async (command: string, args: { labels?: string[]; label?: string }) => {
        if (command === 'browser_destroy_many') {
          calls.push(`${command}:${args.labels?.join(',')}`);
          nativeViews.delete('project-a:tab-a');
          return {
            destroyed: ['project-a:tab-a', 'project-a:tab-c'],
            failures: [{
              label: 'project-a:tab-b',
              error: 'destroy failed at project-a:tab-b',
            }],
          };
        }
        if (command === 'browser_navigate') {
          calls.push(`${command}:${args.label}`);
          nativeViews.add(String(args.label));
          return;
        }
        throw new Error(`unexpected command ${command}`);
      },
      browserLabelForTab: (_: typeof project, tab: { id: string }) => `${project.id}:${tab.id}`,
      nativeBrowserLabel: (label: string) => label,
      setStatus: (text: string, level: string) => statuses.push([text, level]),
      saveWorkspaceSoon: () => calls.push('save'),
      stageBrowserSurface: () => calls.push('stage'),
      closeThread: () => { calls.push('close'); return true; },
      syncProjectBrowser: () => calls.push('sync'),
      state: { activeThreadId: 'web-pane' },
      markActiveSurface: () => calls.push('surface'),
    });

    await expect(closeBrowserPane(thread)).resolves.toBe(false);
    expect(browser.activeTabId).toBe('tab-b');
    expect(tabs).toEqual([
      {
        id: 'tab-a',
        created: true,
        loading: false,
        url: 'https://a.example',
        title: 'A home',
        history: ['https://a.example'],
        historyIndex: 0,
      },
      {
        id: 'tab-b',
        created: true,
        loading: false,
        url: 'https://b.example/current',
        title: 'B current',
        history: ['https://b.example', 'https://b.example/current'],
        historyIndex: 1,
      },
      {
        id: 'tab-c',
        created: false,
        loading: false,
        url: 'https://c.example',
        title: 'C dormant',
        history: ['https://c.example'],
        historyIndex: 0,
      },
    ]);
    expect(nativeViews).toEqual(new Set(['project-a:tab-a', 'project-a:tab-b']));
    expect(calls).toEqual([
      'browser_destroy_many:project-a:tab-a,project-a:tab-b,project-a:tab-c',
      'browser_navigate:project-a:tab-a',
      'sync',
      'save',
    ]);
    expect(statuses).toEqual([[
      'browser pane close failed; native close failures: project-a:tab-b: destroy failed at project-a:tab-b; recreated 1/1 confirmed-destroyed live tabs',
      'error',
    ]]);
  });

  it('routes every thread close entry point through native-aware teardown', async () => {
    const requestThreadClose = compileFunction<
      (thread: { id: string; kind: string } | null) => Promise<boolean>
    >(functionSource(mainJs, 'requestThreadClose'), {
      closeBrowserPane: async () => true,
      closeThread: () => true,
    });
    await expect(requestThreadClose(null)).resolves.toBe(false);
    await expect(requestThreadClose({ id: 'web', kind: 'web' })).resolves.toBe(true);
    await expect(requestThreadClose({ id: 'shell', kind: 'shell' })).resolves.toBe(true);

    expect(functionSource(mainJs, 'armSessionClose')).toContain('var result = onConfirm();');
    expect(mainJs).toContain('return requestThreadClose(thread);');
    expect(mainJs).toContain('requestThreadClose(findThread(state.activeThreadId))');
    expect(mainJs).toMatch(
      /btn\.addEventListener\("click", async function \(event\) \{ if \(event\.target.*await closeBrowserTab\(project, tab\.id\); else await activateBrowserTab\(project, tab\.id\); \}\)/,
    );
  });
});
