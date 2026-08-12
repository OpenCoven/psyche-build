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

function browserNavigationDependencies(
  project: { id: string },
  browser: { activeTabId: string; tabs: BrowserNavigationTab[] },
  tab: BrowserNavigationTab,
  invoke: (command: string, args: Record<string, unknown>) => Promise<void>,
) {
  return {
    activeProject: () => project,
    createBrowserPane: async () => ({ id: 'web-pane' }),
    ensureBrowserModel: () => browser,
    currentBrowserTab: () => tab,
    createBrowserTab: (): BrowserNavigationTab | null => null,
    visibleBrowserBounds: () => ({ x: 1, y: 2, w: 3, h: 4 }),
    normaliseUrl: (url: string) => url,
    tabTitle: (url: string) => url,
    renderBrowserTabs: () => {},
    updateBrowserControls: () => {},
    browserLabelForTab: (value: typeof project, browserTab: BrowserNavigationTab) =>
      `${value.id}:${browserTab.id}`,
    invoke,
    previewEmpty: { hidden: false },
    syncUrlInput: () => {},
    saveWorkspaceSoon: () => {},
    nativeBrowserLabel: (label: string) => label,
    markBrowserTabLoaded: () => {},
    writeToActive: (_text: string) => {},
    setTimeout: () => 0,
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
    expect(browserDestroyMany).toContain('#[tauri::command]\nfn browser_destroy_many(');
    expect(browserDestroyMany).toContain('for label in labels {');
    expect(browserDestroyMany).toContain('destroy_browser_webview(&app, Some(label))?;');

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
    >(functionSource(mainJs, 'restoreDormantBrowserTab'), { navigateBrowser });

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

  it('returns false after native navigation failure without changing browser history', async () => {
    const writes: string[] = [];
    const project = { id: 'project-a' };
    const tab: BrowserNavigationTab = {
      id: 'tab-a',
      url: 'https://old.example',
      created: false,
      loading: false,
      title: 'Old',
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
      created: false,
      loading: false,
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
      return { id: 'web-pane' };
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
      activeProject: () => project,
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
      findProject: () => project,
      ensureBrowserModel: () => ({ tabs, activeTabId: 'tab-a' }),
      invoke: async (command: string, args: { labels: string[] }) => {
        calls.push(`${command}:${args.labels.join(',')}`);
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

  it('skips native pane destruction for zero tabs and retains state on failure', async () => {
    const thread: BrowserPaneThreadFixture = { id: 'web-pane', kind: 'web', projectId: 'project-a', worktreePath: '/workspace' };
    const project = { id: 'project-a' };
    const emptyCalls: string[] = [];
    const emptyCloseBrowserPane = compileFunction<
      (thread: BrowserPaneThreadFixture) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserPane'), {
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
    const failedCloseBrowserPane = compileFunction<
      (thread: BrowserPaneThreadFixture) => Promise<boolean>
    >(functionSource(mainJs, 'closeBrowserPane'), {
      findProject: () => project,
      ensureBrowserModel: () => ({ tabs }),
      invoke: async () => { throw new Error('native unavailable'); },
      browserLabelForTab: () => 'project-a:tab-a',
      setStatus: (text: string, level: string) => statuses.push([text, level]),
      saveWorkspaceSoon: () => failureCalls.push('save'),
      stageBrowserSurface: () => failureCalls.push('stage'),
      closeThread: () => { failureCalls.push('close'); return true; },
      state: { activeThreadId: 'web-pane' },
      markActiveSurface: () => failureCalls.push('surface'),
    });
    await expect(failedCloseBrowserPane(thread)).resolves.toBe(false);
    expect(tabs).toEqual([{ id: 'tab-a', created: true, loading: true }]);
    expect(failureCalls).toEqual([]);
    expect(statuses).toEqual([[
      'browser pane close failed: Error: native unavailable',
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

    expect(functionSource(mainJs, 'armSessionClose')).toContain('requestThreadClose(thread)');
    expect(mainJs).toContain('requestThreadClose(findThread(state.activeThreadId))');
    expect(mainJs).toMatch(
      /btn\.addEventListener\("click", async function \(event\) \{ if \(event\.target.*await closeBrowserTab\(project, tab\.id\); else await activateBrowserTab\(project, tab\.id\); \}\)/,
    );
  });
});
