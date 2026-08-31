import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const mainJs = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8'
);
const indexHtml = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/index.html'),
  'utf8'
);
const sessionsBundle = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/sessions.bundle.js'),
  'utf8'
);
const panesBundle = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/panes.bundle.js'),
  'utf8'
);
const inputBundle = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/input.bundle.js'),
  'utf8'
);
const statusBundle = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/status.bundle.js'),
  'utf8'
);
const PsychePanes = await import(pathToFileURL(join(
  repoRoot,
  'native/desktop/psyche-build-tauri/web/panes/pane-tree.mjs',
)).href);
const stylesCss = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/styles.css'),
  'utf8'
);
const tauriLib = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8'
);
const tauriPackage = JSON.parse(
  readFileSync(join(repoRoot, 'native/desktop/psyche-build-tauri/package.json'), 'utf8')
) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

function functionSource(name: string) {
  const asyncStart = mainJs.indexOf(`async function ${name}(`);
  const syncStart = mainJs.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing ${name}`);
  const bodyStart = mainJs.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < mainJs.length; i += 1) {
    if (mainJs[i] === '{') depth += 1;
    if (mainJs[i] === '}') depth -= 1;
    if (depth === 0) return mainJs.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function compileExtractedFunction<T>(
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

function compileCloseThreadPaneDependencies(
  findThread: (id: string) => Record<string, unknown> | null,
) {
  const findFilesPaneBySurfaceId = compileExtractedFunction<(id: string) => null>(
    'findFilesPaneBySurfaceId',
    { filesPanes: new Map() },
  );
  const canvasSurfaceById = compileExtractedFunction<(id: string) => Record<string, unknown> | null>(
    'canvasSurfaceById',
    { findThread, findFilesPaneBySurfaceId },
  );
  const paneLayoutKey = compileExtractedFunction<
    (projectId: string, worktreePath: string) => string
  >('paneLayoutKey', {});
  const paneLayoutFor = compileExtractedFunction<
    (projectId: string, worktreePath: string) => Record<string, unknown> | null
  >('paneLayoutFor', { paneLayouts: new Map(), paneLayoutKey });
  const paneLayoutForThread = compileExtractedFunction<
    (surface: Record<string, unknown> | null) => Record<string, unknown> | null
  >('paneLayoutForThread', { paneLayoutFor });
  const findFocusSet = compileExtractedFunction<(id: string) => null>(
    'findFocusSet',
    { focusSets: [] },
  );
  const scopedPaneRoot = compileExtractedFunction<
    (layout: Record<string, unknown>) => unknown
  >('scopedPaneRoot', { findFocusSet, canvasSurfaceById, PsychePanes });
  const paneFocusEligible = compileExtractedFunction<
    (layout: Record<string, unknown> | null, threadId: string) => boolean
  >('paneFocusEligible', { scopedPaneRoot, PsychePanes });
  const browserPaneLifecycle = compileExtractedFunction<
    (thread: object | null) => { tearingDown: boolean }
  >('browserPaneLifecycle', { browserPaneLifecycleStates: new WeakMap() });
  const browserPaneIsClosing = compileExtractedFunction<(thread: object | null) => boolean>(
    'browserPaneIsClosing',
    { browserPaneLifecycle },
  );
  const paneSurfaceFocusEligible = compileExtractedFunction<
    (layout: Record<string, unknown> | null, surface: Record<string, unknown> | null) => boolean
  >('paneSurfaceFocusEligible', { browserPaneIsClosing, paneFocusEligible });
  const resolvePaneFocusSuccessor = compileExtractedFunction<
    (
      layout: Record<string, unknown> | null,
      preferredId: string | null,
      threadsOnly?: boolean,
    ) => string | null
  >('resolvePaneFocusSuccessor', {
    canvasSurfaceById,
    paneSurfaceFocusEligible,
    scopedPaneRoot,
    PsychePanes,
  });
  return {
    canvasSurfaceById,
    paneLayoutForThread,
    paneSurfaceFocusEligible,
    resolvePaneFocusSuccessor,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Tauri workspace panels', () => {
  it('registers a scoped pane-session metrics command', () => {
    expect(tauriLib).toContain('mod pane_metrics;');
    expect(tauriLib).toMatch(
      /fn pane_session_metrics\([\s\S]*project_root:\s*String[\s\S]*cwd:\s*String[\s\S]*session_id:\s*String/,
    );
    expect(tauriLib).toMatch(/\n\s*pane_session_metrics,/);
    expect(tauriLib).toMatch(/open_pty_cwd\(&project_root,\s*&cwd\)/);
    expect(tauriLib).toMatch(/is_safe_session_id\(&session_id\)/);
  });

  it('scopes filesystem reads to the active project root', () => {
    expect(mainJs).toMatch(
      /invoke\("fs_list_dir",\s*\{\s*root:\s*root,\s*path:\s*dirPath\s*\}\)/
    );
    expect(mainJs).toMatch(
      /invoke\("fs_read_text",\s*\{\s*root:\s*workspaceRoot,\s*path:\s*path\s*\}\)/
    );
    expect(tauriLib).toMatch(/fn\s+fs_list_dir\(root:\s*String,\s*path:\s*String\)/);
    expect(tauriLib).toMatch(/fn\s+fs_read_text\(root:\s*String,\s*path:\s*String\)/);
    expect(tauriLib).toMatch(/fn\s+resolve_project_path\(/);
    expect(tauriLib).toMatch(/fn\s+validate_git_relative_path\(/);
  });

  it('registers workspace reads and conflict-safe file saves without Git mutations', () => {
    for (const command of [
      'fs_list_dir',
      'fs_read_text',
      'fs_write_text',
      'git_status',
      'git_diff',
      'git_log',
    ]) {
      expect(tauriLib).toMatch(new RegExp(`\\n\\s*${command},`));
    }
    expect(tauriLib).not.toMatch(
      /#\[tauri::command\][\s\S]{0,80}fn\s+git_(?:add|commit|merge|push|reset|clean)\b/
    );
  });

  it('returns structured workspace diffs capped at two MiB', () => {
    expect(tauriLib).toMatch(/const\s+MAX_DIFF_BYTES:\s*usize\s*=\s*2\s*\*\s*1024\s*\*\s*1024/);
    expect(tauriLib).toMatch(/pub\s+struct\s+GitDiffResult\s*\{[\s\S]*pub\s+text:\s*String,[\s\S]*pub\s+bytes:\s*u64,[\s\S]*pub\s+lines:\s*u64,[\s\S]*pub\s+truncated:\s*bool/);
    expect(tauriLib).toMatch(/fn\s+bounded_diff\(text:\s*String\)\s*->\s*GitDiffResult/);
    expect(tauriLib).toMatch(/fn\s+git_diff\([\s\S]{0,120}\)\s*->\s*Result<GitDiffResult,\s*String>/);
    expect(tauriLib).not.toMatch(/text\.lines\(\)\.take\(2000\)/);
  });

  it('keeps Git pane-only with Changes and Commit', () => {
    expect(indexHtml).not.toContain('class="dock-tab"');
    expect(stylesCss).not.toMatch(/\.dock-tab\s*\{/);
    expect(stylesCss).not.toContain('--dock-tabs-h');
    expect(indexHtml).not.toContain('data-browser-column-toggle');
    expect(indexHtml).not.toContain('class="git-dock dock"');
    expect(indexHtml).not.toContain('id="splitter"');
    expect(indexHtml).not.toContain('id="rail-right"');
    expect(indexHtml).not.toContain('id="dock-collapse"');
    expect(indexHtml).not.toContain('id="git-pop-out"');
    expect(indexHtml).not.toContain('id="git-dock-back"');
    expect(indexHtml).not.toContain('data-dock=');
    expect(indexHtml).not.toContain('data-panel=');
    expect(indexHtml).toMatch(/id="git-surface-staging"[\s\S]*id="git-surface"/);
    expect(indexHtml.match(/id="git-surface"/g)).toHaveLength(1);
    expect(indexHtml).toContain('data-git-tab="changes"');
    expect(indexHtml).toContain('data-git-tab="commit"');
    // Diffs is no longer a tab of its own...
    expect(indexHtml).not.toContain('data-panel-btn="diffs"');
    // ...and Files left the dock entirely for the sidebar.
    expect(indexHtml).not.toContain('data-panel-btn="files"');
    const sidebar = indexHtml.slice(
      indexHtml.indexOf('class="rail sidebar"'),
      indexHtml.indexOf('</aside>'),
    );
    expect(sidebar).not.toContain('aria-label="Sidebar sections"');
    expect(sidebar).not.toContain('data-sidebar-tab=');
    expect(sidebar).toContain('id="files-back"');
    expect(sidebar).toContain('id="file-tree"');
    // File tabs belong to the file view now, not the whole terminal area.
    const fileView = indexHtml.slice(indexHtml.indexOf('class="file-view"'));
    expect(fileView.slice(0, fileView.indexOf('</div>') + 6)).toContain('id="tab-strip"');
    // ...but its markup still exists, inside the git panel, with the element
    // ids the diff renderer writes into.
    const gitPanel = indexHtml.slice(indexHtml.indexOf('id="git-surface"'));
    for (const id of ['git-view', 'diffs-summary', 'diffs-refresh', 'diff-files', 'diff-rows']) {
      expect(gitPanel).toContain(`id="${id}"`);
    }
  });

  it('pins a repository-local Tauri 2 CLI for native builds', () => {
    expect(tauriPackage.scripts['build:web']).toBe('node scripts/build-web.mjs');
    expect(tauriPackage.scripts['build:web:debug']).toBe('node scripts/build-web.mjs --debug');
    expect(tauriPackage.scripts.build).toBe('pnpm build:web && tauri build');
    expect(tauriPackage.scripts.dev).toBe('pnpm build:web:debug && tauri dev');
    expect(tauriPackage.devDependencies['@tauri-apps/cli']).toMatch(/^2\./);
  });

  it('loads the committed web bundles before the application shell', () => {
    const editorScript = '<script src="./editor.bundle.js" defer></script>';
    const diffsScript = '<script src="./diffs.bundle.js" defer></script>';
    const sessionsScript = '<script src="./sessions.bundle.js" defer></script>';
    const panesScript = '<script src="./panes.bundle.js" defer></script>';
    const inputScript = '<script src="./input.bundle.js" defer></script>';
    const statusScript = '<script src="./status.bundle.js" defer></script>';
    const mainScript = '<script src="./main.js" defer></script>';

    expect(indexHtml).toContain(editorScript);
    expect(indexHtml).toContain(diffsScript);
    expect(indexHtml).toContain(sessionsScript);
    expect(indexHtml).toContain(panesScript);
    expect(indexHtml).toContain(inputScript);
    expect(indexHtml).toContain(statusScript);
    expect(indexHtml).toContain(mainScript);
    expect(indexHtml.indexOf(editorScript)).toBeLessThan(indexHtml.indexOf(diffsScript));
    expect(indexHtml.indexOf(diffsScript)).toBeLessThan(indexHtml.indexOf(sessionsScript));
    expect(indexHtml.indexOf(sessionsScript)).toBeLessThan(indexHtml.indexOf(panesScript));
    expect(indexHtml.indexOf(panesScript)).toBeLessThan(indexHtml.indexOf(inputScript));
    expect(indexHtml.indexOf(inputScript)).toBeLessThan(indexHtml.indexOf(mainScript));
    expect(indexHtml.indexOf(panesScript)).toBeLessThan(indexHtml.indexOf(statusScript));
    expect(indexHtml.indexOf(statusScript)).toBeLessThan(indexHtml.indexOf(mainScript));
    expect(sessionsBundle.length).toBeGreaterThan(0);
    expect(sessionsBundle).toContain('PsycheSessions');
    expect(panesBundle.length).toBeGreaterThan(0);
    expect(panesBundle).toContain('PsychePanes');
    expect(inputBundle.length).toBeGreaterThan(0);
    expect(inputBundle).toContain('PsycheTerminalInput');
    expect(statusBundle.length).toBeGreaterThan(0);
    expect(statusBundle).toContain('PsycheStatus');
    expect(statusBundle).toContain('createStatusController');
  });

  describe('Web canvas pane', () => {
    it('moves Web from the top band into the canvas pane lifecycle', () => {
      expect(indexHtml).not.toContain('class="browser-band"');
      expect(indexHtml).not.toContain('id="browser-band-resize"');
      expect(indexHtml).toContain('id="browser-surface-staging"');
      expect(mainJs).toMatch(/function createBrowserPane\(/);
      expect(mainJs).toMatch(/kind:\s*"web"/);
      expect(mainJs).toMatch(/preparePanePlacement\(id, project\.id, worktreePath\)/);
      expect(mainJs).toMatch(/function closeBrowserPane\(/);
    });

    it('reveals the canvas before measuring a new Web pane placement', () => {
      expect(mainJs).toMatch(
        /async function createBrowserPane\(project\)[\s\S]*await showTerminalView\(\)[\s\S]*preparePanePlacement\(id, project\.id, worktreePath\)/
      );
    });

    it('keeps a visible Web pane painted when another canvas pane has focus', () => {
      const boundsFunction = mainJs.match(
        /function visibleBrowserBounds\(\)\s*\{[\s\S]*?\n  \}/
      )?.[0];
      expect(boundsFunction).toBeTruthy();
      expect(boundsFunction).toContain('preview.isConnected');
      expect(boundsFunction).toContain('browserSurface.parentElement !== pane.browserBody');
      expect(boundsFunction).toContain('preview.getBoundingClientRect()');
      expect(boundsFunction).not.toContain('state.activeThreadId');
      expect(mainJs).toMatch(
        /function mountBrowserPane\(thread\)[\s\S]*pane\.appendChild\(body\);[\s\S]*pane\.appendChild\(createPaneFooter\(thread\)\)/,
      );
    });

    it('returns contextual shortcuts to terminal mode through every Web close path', () => {
      expect(mainJs).toMatch(
        /function closeThread\(id, options\)[\s\S]{0,160}var wasActive = state\.activeThreadId === id;[\s\S]{0,120}thread\.kind === "web" && wasActive[\s\S]{0,120}markActiveSurface\("terminal"\)/
      );
    });

    it('has no browser-band or browser-column layout state', () => {
      expect(stylesCss).not.toContain('--browser-band');
      expect(stylesCss).not.toContain('.browser-band');
      expect(mainJs).not.toContain('setBandHeight');
      expect(mainJs).not.toContain('setBrowserColumn');
      expect(mainJs).not.toContain('data-browser-column-toggle');
    });
  });

  describe('git panel tabs', () => {
    it('uses the same segmented switch as the sidebar', () => {
      expect(indexHtml).toContain('data-git-tab="changes"');
      expect(indexHtml).toContain('data-git-tab="commit"');
      // Same class as the sidebar's Sessions/Files switch: one control to learn.
      expect(indexHtml).toMatch(/class="sidebar-tabs dock-tabs-segmented"/);
      expect(indexHtml).toMatch(/class="sidebar-tab is-active" data-git-tab="changes"/);
    });

    it('shows exactly one section at a time', () => {
      expect(mainJs).toMatch(/function setGitTab\(name\)[\s\S]*changes\.hidden = gitTab !== "changes"/);
      expect(mainJs).toMatch(/function setGitTab\(name\)[\s\S]*commit\.hidden = gitTab !== "commit"/);
      expect(mainJs).toMatch(/function setGitTab\(name\)[\s\S]*aria-selected/);
    });

    it('mirrors the changed-file count onto the Changes tab', () => {
      expect(indexHtml).toContain('id="git-changes-count"');
      expect(mainJs).toMatch(/function setGitChangesCount\(count\)[\s\S]*gitChangesCountEl\.textContent/);
    });
  });

  describe('sidebar footer', () => {
    it('drops the permanent key hints the help overlay already documents', () => {
      expect(indexHtml).not.toContain('sidebar-hints');
      expect(stylesCss).not.toContain('.sidebar-hints');
      expect(indexHtml).toContain('id="help-overlay"');
    });

    it('collapses appearance to a single row with a theme swatch', () => {
      expect(indexHtml).toContain('class="appearance-swatch"');
      expect(stylesCss).toMatch(/\.sidebar-settings > summary\s*\{[^}]*height: 22px;/s);
      expect(stylesCss).toMatch(/\.appearance-swatch\s*\{[^}]*background: var\(--accent\);/s);
    });
  });

  describe('hunk expansion', () => {
    it('lets a caller widen the diff, with the width clamped', () => {
      expect(tauriLib).toMatch(/fn git_diff\([\s\S]*context: Option<u32>/);
      expect(tauriLib).toMatch(/args\.push\(format!\("-U\{\}", lines\.min\(MAX_DIFF_CONTEXT\)\)\)/);
      // The value reaches a subprocess argument, so it is bounded rather than
      // passed through.
      expect(tauriLib).toMatch(/const MAX_DIFF_CONTEXT: u32 = \d+;/);
    });

    it('caches a widened diff apart from the narrow one', () => {
      // Same file at 3 lines of context and at 400 are different documents;
      // sharing a key would re-serve the narrow one after expanding.
      expect(mainJs).toMatch(/function diffCacheKey\(projectId, workspaceRoot, path, staged, context\)/);
      expect(mainJs).toMatch(/\(context === undefined \|\| context === null \? "default" : context\)/);
    });

    it('expands from the separator and re-fetches at the new width', () => {
      expect(mainJs).toMatch(/expand\.className = "diff-sep-expand"/);
      expect(mainJs).toMatch(/diffContext = Math\.min\(2000, widest \+ 3\)/);
      expect(mainJs).toMatch(/expand\.addEventListener\("click"[\s\S]*?refreshSelectedDiff\(\)/);
      expect(mainJs).toMatch(/context: diffContext,/);
    });

    it('starts every newly selected file narrow again', () => {
      // An expansion belongs to the view you expanded, not to the panel.
      expect(mainJs).toMatch(/if \(!\(options && options\.keepContext\)\) diffContext = null;/);
    });
  });

  describe('staged Git canvas surface', () => {
    it('moves one live surface rather than rendering it twice', () => {
      // Two renderings of the git panel could diverge; one element with two
      // possible homes cannot.
      expect(indexHtml).toContain('id="git-surface"');
      expect(mainJs).toMatch(/function stageGitSurface\(\)[\s\S]*gitSurfaceStagingEl\.appendChild\(gitSurfaceEl\)/);
      expect(mainJs).toMatch(/thread\.kind === "git" && thread\.toolBody && gitSurfaceEl/);
      // Only one git surface exists in the markup.
      expect(indexHtml.match(/id="git-surface"/g)).toHaveLength(1);
    });

    it('keeps Git actions inside the shared surface', () => {
      expect(indexHtml).toContain('class="git-pane-toolbar"');
      expect(indexHtml).toMatch(
        /id="git-surface"[\s\S]*id="git-branch"[\s\S]*id="git-open-remote"[\s\S]*id="git-refresh"/,
      );
      expect(stylesCss).toMatch(
        /\.panel-git-body\s*\{[^}]*grid-template-rows:\s*auto\s+auto\s+minmax\(0,\s*1fr\);/,
      );
    });

    it('shares one drop indicator with the pane drag', () => {
      // A second visual language for the same gesture would be noise.
      expect(mainJs).toMatch(/function showPaneDropIndicator\(rect, position\)/);
      expect(mainJs).toMatch(/var showIndicator = showPaneDropIndicator;/);
      expect(mainJs.match(/className = "pane-drop-indicator"/g)).toHaveLength(1);
    });

    it('hands the surface back before the pane is torn down', () => {
      // Removing the pane first would take the surface out of the document
      // with it.
      const close = functionSource('closeThread');
      expect(close.indexOf('stageGitSurface();')).toBeGreaterThan(-1);
      expect(close.indexOf('stageGitSurface();')).toBeLessThan(
        close.indexOf('detachThreadPane(thread)'),
      );
    });

    it('files a tool pane as a tool, not an agent', () => {
      const sidebarModel = readFileSync(
        join(repoRoot, 'native/desktop/psyche-build-tauri/web/sessions/sidebar-model.mjs'),
        'utf8'
      );
      expect(sidebarModel).toMatch(/const TOOL_KINDS = \['git', 'web'\];/);
      expect(sidebarModel).toMatch(
        /buildCategory\('Tools', '◍', toolRows, normalizedQuery\)/,
      );
      expect(sidebarModel).toMatch(
        /row\.type === 'agents' && !isToolRow\(row\)/,
      );
    });
  });

  describe('Git pane ownership', () => {
    it('offers tool-owned sidebar actions without PTY mutations or stop wording', () => {
      const actionsFor = Function(
        `"use strict";
         var sessionCloseLabel = ${functionSource('sessionCloseLabel')};
         var threadIsToolPane = ${functionSource('threadIsToolPane')};
         return (${functionSource('localSessionContextActions')});`,
      )() as (
        thread: Record<string, unknown>,
        memberships: unknown[],
        callbacks: Record<string, () => void>,
      ) => Array<{ label: string }>;
      const callbacks = {
        focus: () => undefined,
        showSet: () => undefined,
        removeSet: () => undefined,
        rename: () => undefined,
        duplicate: () => undefined,
        interrupt: () => undefined,
        hide: () => undefined,
        close: () => undefined,
      };

      expect(actionsFor(
        { kind: 'git', name: 'Git', status: 'running' },
        [{ name: 'Focus set' }],
        callbacks,
      ).map((action) => action.label)).toEqual([
        'Focus', 'Hide', 'Close Git pane',
      ]);
      expect(actionsFor(
        { kind: 'web', name: 'Web', status: 'running' },
        [],
        callbacks,
      ).map((action) => action.label)).toEqual([
        'Focus', 'Hide', 'Close Web pane',
      ]);
    });

    it('coalesces one scoped status snapshot across Changes and Commit', async () => {
      const status = deferred<{ is_repo: boolean; files: unknown[] }>();
      const statusCalls: string[] = [];
      const paints: Array<{ panel: string; status: unknown; generation: number }> = [];
      let refreshGeneration = 0;
      let gitGeneration = 0;
      let diffGeneration = 0;
      let detailGeneration = 0;
      const gates = {
        refresh: {
          next: () => ++refreshGeneration,
          isCurrent: (candidate: number) => candidate === refreshGeneration,
        },
        git: { next: () => ++gitGeneration },
        diff: { next: () => ++diffGeneration },
        detail: { next: () => ++detailGeneration },
      };
      const project = { id: 'project-a', root: '/worktree-a' };
      const factory = Function(
        'activeProject', 'activeWorkspaceRoot', 'gitPaneIsVisible', 'invoke',
        'gitRefreshRequestGate', 'gitPanelRequestGate', 'diffPanelRequestGate',
        'diffRequestGate', 'setGitChangesCount', 'prepareGitSurfaceRefresh',
        'gitSurfaceRequestMatches', 'renderGitPanel', 'renderDiffsPanel', 'renderGitSurfaceError',
        `"use strict";
         var gitRefreshFlight = null;
         return (${functionSource('renderGitSurface')});`,
      );
      const renderGitSurface = factory(
        () => project,
        (value: typeof project) => value.root,
        () => true,
        (command: string, args: { root: string }) => {
          statusCalls.push(`${command}:${args.root}`);
          return status.promise;
        },
        gates.refresh,
        gates.git,
        gates.diff,
        gates.detail,
        () => undefined,
        () => undefined,
        () => true,
        (_project: unknown, _root: string, snapshot: unknown, generation: number) => {
          paints.push({ panel: 'commit', status: snapshot, generation });
        },
        (_project: unknown, _root: string, snapshot: unknown, generation: number) => {
          paints.push({ panel: 'changes', status: snapshot, generation });
        },
        () => undefined,
      ) as () => Promise<void>;

      const first = renderGitSurface();
      const second = renderGitSurface();
      expect(second).toBe(first);
      expect(statusCalls).toEqual(['git_status:/worktree-a']);

      const snapshot = { is_repo: true, files: [{ path: 'a.ts' }] };
      status.resolve(snapshot);
      await first;
      expect(paints).toEqual([
        { panel: 'changes', status: snapshot, generation: 1 },
        { panel: 'commit', status: snapshot, generation: 1 },
      ]);
      expect({ refreshGeneration, gitGeneration, diffGeneration, detailGeneration })
        .toEqual({ refreshGeneration: 1, gitGeneration: 1, diffGeneration: 1, detailGeneration: 1 });
    });

    it('invalidates a hidden Git request and reopens with exactly one fresh refresh', async () => {
      const pending = deferred<{ is_repo: boolean; files: unknown[] }>();
      const project = { id: 'project-a', root: '/worktree-a' };
      let visible = true;
      let statusCalls = 0;
      const paints: string[] = [];
      const badgeCounts: number[] = [];
      function gate() {
        let generation = 0;
        return {
          next: () => ++generation,
          isCurrent: (candidate: number) => candidate === generation,
        };
      }
      const refreshGate = gate();
      const gitGate = gate();
      const diffGate = gate();
      const detailGate = gate();
      const api = Function(
        'activeProject', 'activeWorkspaceRoot', 'gitPaneIsVisible', 'invoke',
        'gitRefreshRequestGate', 'gitPanelRequestGate', 'diffPanelRequestGate',
        'diffRequestGate', 'setGitChangesCount', 'prepareGitSurfaceRefresh',
        'gitSurfaceRequestMatches', 'renderGitPanel', 'renderDiffsPanel', 'renderGitSurfaceError',
        `"use strict";
         var gitRefreshFlight = null;
         var suspendDiffRequests = function () {
           diffPanelRequestGate.next();
           diffRequestGate.next();
         };
         var suspendGitRequests = ${functionSource('suspendGitRequests')};
         var renderGitSurface = ${functionSource('renderGitSurface')};
         return { renderGitSurface, suspendGitRequests };`,
      )(
        () => project,
        (value: typeof project) => value.root,
        () => visible,
        () => {
          statusCalls += 1;
          if (statusCalls === 1) return pending.promise;
          if (statusCalls === 2) {
            return Promise.resolve({
              is_repo: true,
              files: [{ path: 'fresh-a.ts' }, { path: 'fresh-b.ts' }],
            });
          }
          return Promise.reject(new Error('status unavailable'));
        },
        refreshGate,
        gitGate,
        diffGate,
        detailGate,
        (count: number) => { badgeCounts.push(count); },
        () => undefined,
        (_projectId: string, _root: string, generation: number) =>
          refreshGate.isCurrent(generation) && visible,
        () => { paints.push('commit'); },
        () => { paints.push('changes'); },
        () => undefined,
      ) as {
        renderGitSurface: () => Promise<void>;
        suspendGitRequests: () => void;
      };

      const stale = api.renderGitSurface();
      visible = false;
      api.suspendGitRequests();
      pending.resolve({ is_repo: true, files: [{ path: 'stale.ts' }] });
      await stale;
      expect(paints).toEqual([]);

      visible = true;
      const reopened = api.renderGitSurface();
      expect(api.renderGitSurface()).toBe(reopened);
      await reopened;
      expect(statusCalls).toBe(2);
      expect(paints).toEqual(['changes', 'commit']);
      expect(badgeCounts.at(-1)).toBe(2);

      project.id = 'project-b';
      project.root = '/worktree-b';
      const failed = api.renderGitSurface();
      expect(badgeCounts.at(-1)).toBe(0);
      await failed;
      expect(statusCalls).toBe(3);
      expect(badgeCounts.at(-1)).toBe(0);
      expect(functionSource('hideThread')).toContain('suspendGitRequests()');
      expect(functionSource('reopenThread')).toContain('renderGitSurface()');
    });

    it('supersedes pending history when Changes requests an authoritative refresh', async () => {
      const oldLog = deferred<void>();
      const project = { id: 'project-a', root: '/worktree-a' };
      let refreshGeneration = 0;
      let gitGeneration = 0;
      let diffGeneration = 0;
      let detailGeneration = 0;
      let statusCalls = 0;
      const paints: string[] = [];
      const refreshGate = {
        next: () => ++refreshGeneration,
        isCurrent: (candidate: number) => candidate === refreshGeneration,
      };
      const renderGitSurface = Function(
        'activeProject', 'activeWorkspaceRoot', 'gitPaneIsVisible', 'invoke',
        'gitRefreshRequestGate', 'gitPanelRequestGate', 'diffPanelRequestGate',
        'diffRequestGate', 'setGitChangesCount', 'prepareGitSurfaceRefresh',
        'gitSurfaceRequestMatches', 'renderGitPanel', 'renderDiffsPanel', 'renderGitSurfaceError',
        `"use strict";
         var gitRefreshFlight = null;
         return (${functionSource('renderGitSurface')});`,
      )(
        () => project,
        (value: typeof project) => value.root,
        () => true,
        () => {
          statusCalls += 1;
          return Promise.resolve({
            marker: statusCalls === 1 ? 'A' : 'B',
            is_repo: true,
            files: statusCalls === 1 ? [{ path: 'old.ts' }] : [{ path: 'new.ts' }],
          });
        },
        refreshGate,
        { next: () => ++gitGeneration },
        { next: () => ++diffGeneration },
        { next: () => ++detailGeneration },
        () => undefined,
        () => undefined,
        (_projectId: string, _root: string, generation: number) =>
          refreshGate.isCurrent(generation),
        async (
          _project: unknown,
          _root: string,
          status: { marker: string },
          _gitGeneration: number,
          generation: number,
        ) => {
          if (status.marker === 'A') await oldLog.promise;
          if (refreshGate.isCurrent(generation)) paints.push(`commit:${status.marker}`);
        },
        (
          _project: unknown,
          _root: string,
          status: { marker: string },
        ) => { paints.push(`changes:${status.marker}`); },
        () => undefined,
      ) as (options?: { force?: boolean }) => Promise<void>;
      const refreshDiffs = Function(
        'activeProject', 'invalidateProjectDiffs', 'renderGitSurface',
        `"use strict"; return (${functionSource('refreshDiffs')});`,
      )(
        () => project,
        () => undefined,
        renderGitSurface,
      ) as () => void;

      const stale = renderGitSurface();
      await Promise.resolve();
      await Promise.resolve();
      expect(paints).toEqual(['changes:A']);

      refreshDiffs();
      expect(statusCalls).toBe(2);
      const current = renderGitSurface();
      await current;
      expect(paints).toEqual(['changes:A', 'changes:B', 'commit:B']);

      oldLog.resolve();
      await stale;
      expect(paints).toEqual(['changes:A', 'changes:B', 'commit:B']);
    });

    it('keeps a successful status badge when history loading fails', async () => {
      let badge = 3;
      const messages: string[] = [];
      const renderGitPanel = Function(
        'gitViewEl', 'gitSurfaceRequestMatches', 'gitPanelRequestMatches',
        'invoke', 'setGitChangesCount', 'panelMessage',
        `"use strict"; return (${functionSource('renderGitPanel')});`,
      )(
        {},
        () => true,
        () => true,
        async () => { throw new Error('history unavailable'); },
        (count: number) => { badge = count; },
        (_element: unknown, message: string) => { messages.push(message); },
      ) as (
        project: { id: string },
        root: string,
        status: { is_repo: boolean; files: unknown[] },
        panelGeneration: number,
        refreshGeneration: number,
      ) => Promise<void>;

      await renderGitPanel(
        { id: 'project-a' },
        '/worktree-a',
        { is_repo: true, files: [{}, {}, {}] },
        1,
        1,
      );
      expect(messages).toEqual(['Error: history unavailable']);
      expect(badge).toBe(3);
    });

    it('scopes lookup to project and worktree', () => {
      const source = functionSource('gitPaneThread');
      expect(source).toContain('thread.projectId === projectId');
      expect(source).toContain('thread.worktreePath === workspaceRoot');
      expect(source).toContain('!thread.closing');
    });

    it('focuses an existing owner before allocating a pane', () => {
      const source = functionSource('openOrFocusGitPane');
      expect(source).toContain('var project = activeProject();');
      expect(source).toContain('var workspaceRoot = activeWorkspaceRoot(project);');
      expect(source).toMatch(/gitPaneThread\(project\.id, workspaceRoot\)/);
      expect(source).toMatch(
        /if \(existing\) \{[\s\S]*revealGitPane\(existing\);[\s\S]*await focusThread\(existing\.id\);[\s\S]*return existing;/,
      );
      expect(source).toContain('preparePanePlacement(id, project.id, workspaceRoot)');
    });

    it('uses pane membership as the only Git visibility contract', () => {
      const visible = functionSource('gitPaneIsVisible');
      expect(visible).toContain('gitPaneThread(project.id, workspaceRoot)');
      expect(visible).toContain('canvasThreadIds().indexOf(thread.id) !== -1');
      expect(functionSource('currentDiffRequestMatches')).toContain('gitPaneIsVisible(project)');
    });

    it('keeps the shared surface mounted in a Git pane owned by the newly active scope', () => {
      expect(functionSource('renderPaneNode')).toMatch(
        /thread\.kind === "git" && thread\.toolBody && gitSurfaceEl[\s\S]*thread\.toolBody\.appendChild\(gitSurfaceEl\)/,
      );
    });

    it('owns status and invalidation at the Git refresh coordinator', () => {
      const surface = functionSource('renderGitSurface');
      expect(surface).toContain('invoke("git_status", { root: workspaceRoot })');
      expect(surface.match(/invoke\("git_status"/g)).toHaveLength(1);
      expect(surface).toContain('gitSurfaceRequestMatches(projectId, workspaceRoot, refreshGeneration)');
      expect(functionSource('renderGitPanel')).not.toContain('invoke("git_status"');
      expect(functionSource('renderGitPanel')).not.toMatch(
        /setGitChangesCount\(\(status\.files \|\| \[\]\)\.length\)/,
      );
      expect(functionSource('renderDiffsPanel')).not.toContain('invoke("git_status"');
      expect(functionSource('suspendGitRequests')).toContain('gitRefreshRequestGate.next()');
      expect(functionSource('suspendGitRequests')).toContain('gitPanelRequestGate.next()');
      expect(functionSource('suspendGitRequests')).toContain('suspendDiffRequests()');
    });

    it('keys diff list and detail continuations to the captured worktree root', () => {
      const panel = functionSource('renderDiffsPanel');
      expect(panel).toContain('function renderDiffsPanel(project, workspaceRoot, status');
      expect(panel).toContain(
        'diffPanelRequestMatches(projectId, workspaceRoot, panelGeneration)',
      );
      expect(panel).toContain(
        'diffCacheKey(projectId, workspaceRoot, f.path, stagedDiffFor(f), diffContext)',
      );
      expect(panel).toContain(
        'showDiff(project, target, { workspaceRoot: workspaceRoot })',
      );

      const detail = functionSource('showDiff');
      expect(detail).toContain('var workspaceRoot = options && options.workspaceRoot');
      expect(detail.indexOf('var currentProject = activeProject();')).toBeLessThan(
        detail.indexOf('if (!(options && options.keepContext)) diffContext = null;'),
      );
      expect(detail).toContain('root: workspaceRoot');
      expect(detail).toContain(
        'currentDiffRequestMatches(project.id, workspaceRoot, key, generation)',
      );

      const matcher = functionSource('currentDiffRequestMatches');
      expect(matcher).toContain('activeWorkspaceRoot(project) === workspaceRoot');
    });

    it('deduplicates a Git pane in the active scope before allocation', async () => {
      const source = functionSource('openOrFocusGitPane');
      const calls: string[] = [];
      const existing = { id: 'git-existing' };
      const openOrFocusGitPane = Function(
        'activeProject', 'setStatus', 'activeWorkspaceRoot', 'gitPaneThread',
        'showTerminalView', 'revealGitPane', 'focusThread', 'makeThreadId', 'preparePanePlacement', 'commitPanePlacement',
        'state', 'noteStatusActivity', 'mountToolPane',
        'renderGitSurface', 'refreshSidebar', 'saveWorkspaceSoon',
        `"use strict"; return (${source});`,
      )(
        () => ({ id: 'project-a' }),
        () => undefined,
        () => '/worktree-a',
        () => existing,
        async () => true,
        () => undefined,
        async (id: string) => { calls.push(`focus:${id}`); },
        () => { calls.push('allocate'); return 'git-new'; },
        () => { calls.push('place'); return null; },
        () => undefined,
        { threads: [] },
        () => undefined,
        () => undefined,
        () => { calls.push('render'); },
        () => undefined,
        () => undefined,
      ) as () => Promise<typeof existing>;

      await expect(openOrFocusGitPane()).resolves.toBe(existing);
      expect(calls).toEqual(['focus:git-existing', 'render']);
    });

    it('reopens a hidden Git owner before revealing and focusing without allocating a duplicate', async () => {
      const source = functionSource('openOrFocusGitPane');
      const calls: string[] = [];
      const existing = { id: 'git-existing', hidden: true };
      const state = { threads: [existing] };
      const openOrFocusGitPane = Function(
        'activeProject', 'setStatus', 'activeWorkspaceRoot', 'gitPaneThread',
        'showTerminalView', 'reopenThread', 'revealGitPane', 'focusThread',
        'makeThreadId', 'preparePanePlacement', 'commitPanePlacement',
        'state', 'noteStatusActivity', 'mountToolPane',
        'renderGitSurface', 'refreshSidebar', 'saveWorkspaceSoon',
        `"use strict"; return (${source});`,
      )(
        () => ({ id: 'project-a' }),
        () => undefined,
        () => '/worktree-a',
        () => existing,
        async () => true,
        (id: string) => {
          calls.push(`reopen:${id}`);
          existing.hidden = false;
          calls.push('render');
          return true;
        },
        () => { calls.push('reveal'); },
        async (id: string) => { calls.push(`focus:${id}`); },
        () => { calls.push('allocate'); return 'git-new'; },
        () => { calls.push('place'); return null; },
        () => { calls.push('commit'); },
        state,
        () => { calls.push('activity'); },
        () => { calls.push('mount'); },
        () => { calls.push('render'); },
        () => { calls.push('sidebar'); },
        () => { calls.push('save'); },
      ) as () => Promise<typeof existing>;

      await expect(openOrFocusGitPane()).resolves.toBe(existing);
      expect(existing.hidden).toBe(false);
      expect(state.threads).toEqual([existing]);
      expect(calls).toEqual([
        'reopen:git-existing', 'render', 'reveal', 'focus:git-existing',
      ]);
    });

    it('cancels before allocating Git state when leaving a dirty file is declined', async () => {
      const source = functionSource('openOrFocusGitPane');
      const calls: string[] = [];
      const state = { threads: [] as unknown[] };
      const openOrFocusGitPane = Function(
        'activeProject', 'setStatus', 'activeWorkspaceRoot', 'gitPaneThread',
        'showTerminalView', 'revealGitPane', 'focusThread', 'makeThreadId', 'preparePanePlacement', 'commitPanePlacement',
        'state', 'noteStatusActivity', 'mountToolPane',
        'renderGitSurface', 'refreshSidebar', 'saveWorkspaceSoon',
        `"use strict"; return (${source});`,
      )(
        () => ({ id: 'project-a' }),
        () => undefined,
        () => '/worktree-a',
        () => { calls.push('lookup'); return null; },
        async () => { calls.push('guard'); return false; },
        () => { calls.push('reveal'); },
        async () => { calls.push('focus'); },
        () => { calls.push('allocate'); return 'git-new'; },
        () => { calls.push('place'); return { id: 'placement' }; },
        () => { calls.push('commit'); },
        state,
        () => { calls.push('activity'); },
        () => { calls.push('mount'); },
        () => { calls.push('render'); },
        () => { calls.push('sidebar'); },
        () => { calls.push('save'); },
      ) as () => Promise<null>;

      await expect(openOrFocusGitPane()).resolves.toBeNull();
      expect(state.threads).toEqual([]);
      expect(calls).toEqual(['guard']);
    });

    it('rechecks scope and deduplicates after the terminal transition', async () => {
      const source = functionSource('openOrFocusGitPane');
      const calls: string[] = [];
      let project = { id: 'project-a' };
      const existing = { id: 'git-project-b' };
      const openOrFocusGitPane = Function(
        'activeProject', 'setStatus', 'activeWorkspaceRoot', 'gitPaneThread',
        'showTerminalView', 'revealGitPane', 'focusThread', 'makeThreadId', 'preparePanePlacement', 'commitPanePlacement',
        'state', 'noteStatusActivity', 'mountToolPane',
        'renderGitSurface', 'refreshSidebar', 'saveWorkspaceSoon',
        `"use strict"; return (${source});`,
      )(
        () => project,
        () => undefined,
        (value: typeof project) => value.id === 'project-a' ? '/worktree-a' : '/worktree-b',
        (projectId: string, workspaceRoot: string) => {
          calls.push(`lookup:${projectId}:${workspaceRoot}`);
          return projectId === 'project-b' ? existing : null;
        },
        async () => { project = { id: 'project-b' }; return true; },
        () => { calls.push('reveal'); },
        async (id: string) => { calls.push(`focus:${id}`); },
        () => { calls.push('allocate'); return 'git-new'; },
        () => { calls.push('place'); return null; },
        () => { calls.push('commit'); },
        { threads: [] },
        () => undefined,
        () => undefined,
        () => { calls.push('render'); },
        () => undefined,
        () => undefined,
      ) as () => Promise<typeof existing>;

      await expect(openOrFocusGitPane()).resolves.toBe(existing);
      expect(calls).toEqual([
        'lookup:project-b:/worktree-b', 'reveal', 'focus:git-project-b', 'render',
      ]);
    });

    it('reveals an existing Git pane excluded by the current focus set', () => {
      const layout = {
        root: {
          type: 'split', id: 'split', orientation: 'column', ratio: 0.5,
          first: { type: 'leaf', id: 'git-leaf', threadId: 'git' },
          second: { type: 'leaf', id: 'other-leaf', threadId: 'other' },
        },
        focusedLeafId: 'other-leaf', activeSetId: 'other-set',
        spanRoot: { stale: true }, spanSignature: 'stale', maximizedLeafId: null,
      };
      const revealGitPane = Function(
        'paneLayoutForThread', 'PsychePanes', 'seedSets',
        `"use strict";
         var focusSets = seedSets;
         var findFocusSet = ${functionSource('findFocusSet')};
         return (${functionSource('revealGitPane')});`,
      )(
        () => layout,
        {
          findLeafByThreadId(root: typeof layout.root, threadId: string) {
            return threadId === 'git' ? root.first : root.second;
          },
        },
        [{ id: 'other-set', threadIds: ['other'] }],
      ) as (thread: { id: string }) => boolean;

      expect(revealGitPane({ id: 'git' })).toBe(true);
      expect(layout.activeSetId).toBeNull();
      expect(layout.spanRoot).toBeNull();
      expect(layout.spanSignature).toBeNull();
    });

    it('leaves compatible scope intact but clears another pane\'s maximize state before focusing Git', () => {
      const layout = {
        root: {
          type: 'split', id: 'split', orientation: 'column', ratio: 0.5,
          first: { type: 'leaf', id: 'git-leaf', threadId: 'git' },
          second: { type: 'leaf', id: 'other-leaf', threadId: 'other' },
        },
        focusedLeafId: 'other-leaf', activeSetId: 'shared-set',
        spanRoot: { keep: true }, spanSignature: 'keep', maximizedLeafId: 'other-leaf',
      };
      const revealGitPane = Function(
        'paneLayoutForThread', 'PsychePanes', 'seedSets',
        `"use strict";
         var focusSets = seedSets;
         var findFocusSet = ${functionSource('findFocusSet')};
         return (${functionSource('revealGitPane')});`,
      )(
        () => layout,
        {
          findLeafByThreadId(root: typeof layout.root, threadId: string) {
            return threadId === 'git' ? root.first : root.second;
          },
        },
        [{ id: 'shared-set', threadIds: ['git', 'other'] }],
      ) as (thread: { id: string }) => boolean;

      expect(revealGitPane({ id: 'git' })).toBe(true);
      expect(layout.activeSetId).toBe('shared-set');
      expect(layout.spanRoot).toEqual({ keep: true });
      expect(layout.spanSignature).toBe('keep');
      expect(layout.maximizedLeafId).toBeNull();
    });

    it('allocates a separate Git pane for another scope', async () => {
      const source = functionSource('openOrFocusGitPane');
      const calls: string[] = [];
      const state = { threads: [] as Array<{ id: string; projectId: string; worktreePath: string }> };
      const openOrFocusGitPane = Function(
        'activeProject', 'setStatus', 'activeWorkspaceRoot', 'gitPaneThread',
        'showTerminalView', 'revealGitPane', 'focusThread', 'makeThreadId', 'preparePanePlacement', 'commitPanePlacement',
        'state', 'noteStatusActivity', 'mountToolPane',
        'renderGitSurface', 'refreshSidebar', 'saveWorkspaceSoon',
        `"use strict"; return (${source});`,
      )(
        () => ({ id: 'project-b' }),
        () => undefined,
        () => '/worktree-b',
        (projectId: string, workspaceRoot: string) => {
          calls.push(`lookup:${projectId}:${workspaceRoot}`);
          return null;
        },
        async () => true,
        () => undefined,
        async (id: string) => { calls.push(`focus:${id}`); },
        () => 'git-new',
        (id: string, projectId: string, workspaceRoot: string) => {
          calls.push(`place:${id}:${projectId}:${workspaceRoot}`);
          return { id };
        },
        () => { calls.push('commit'); },
        state,
        () => { calls.push('activity'); },
        () => { calls.push('mount'); },
        () => { calls.push('render'); },
        () => { calls.push('sidebar'); },
        () => { calls.push('save'); },
      ) as () => Promise<{ id: string; projectId: string; worktreePath: string }>;

      await expect(openOrFocusGitPane()).resolves.toMatchObject({
        id: 'git-new', projectId: 'project-b', worktreePath: '/worktree-b',
      });
      expect(state.threads).toHaveLength(1);
      expect(calls).toEqual([
        'lookup:project-b:/worktree-b', 'place:git-new:project-b:/worktree-b',
        'commit', 'activity', 'mount', 'focus:git-new', 'render', 'sidebar', 'save',
      ]);
    });

    it('does not mutate pane state when placement fails', async () => {
      const source = functionSource('openOrFocusGitPane');
      const state = { threads: [] as unknown[] };
      const calls: string[] = [];
      const openOrFocusGitPane = Function(
        'activeProject', 'setStatus', 'activeWorkspaceRoot', 'gitPaneThread',
        'showTerminalView', 'revealGitPane', 'focusThread', 'makeThreadId', 'preparePanePlacement', 'commitPanePlacement',
        'state', 'noteStatusActivity', 'mountToolPane',
        'renderGitSurface', 'refreshSidebar', 'saveWorkspaceSoon', 'showPanePlacementWarning',
        `"use strict"; return (${source});`,
      )(
        () => ({ id: 'project-a' }),
        (message: string) => { calls.push(`status:${message}`); },
        () => '/worktree-a',
        () => null,
        async () => true,
        () => undefined,
        async () => { calls.push('focus'); },
        () => 'git-new',
        () => null,
        () => { calls.push('commit'); },
        state,
        () => { calls.push('activity'); },
        () => { calls.push('mount'); },
        () => { calls.push('render'); },
        () => { calls.push('sidebar'); },
        () => { calls.push('save'); },
        (message: string) => { calls.push(`status:${message}`); },
      ) as () => Promise<null>;

      await expect(openOrFocusGitPane()).resolves.toBeNull();
      expect(state.threads).toEqual([]);
      expect(calls).toEqual(['status:Not enough space for another pane']);
    });

    it('keeps a full-canvas Cmd+G reopen failure visible and accessible without mutation', async () => {
      expect(indexHtml).toMatch(/id="toast"[^>]*role="status"[^>]*aria-live="polite"/);
      expect(indexHtml).not.toMatch(/id="toast"[^>]*hidden/);
      const inactiveToastCss = stylesCss.match(/\.toast\s*\{([^}]*)\}/s)?.[1] ?? '';
      const visibleToastCss = stylesCss.match(/\.toast\.is-visible\s*\{([^}]*)\}/s)?.[1] ?? '';
      expect(inactiveToastCss).not.toMatch(/display:\s*none/);
      expect(inactiveToastCss).toMatch(/position:\s*absolute/);
      expect(inactiveToastCss).toMatch(/width:\s*1px/);
      expect(inactiveToastCss).toMatch(/height:\s*1px/);
      expect(inactiveToastCss).toMatch(/clip:\s*rect\(0 0 0 0\)/);
      expect(inactiveToastCss).toMatch(/clip-path:\s*inset\(50%\)/);
      expect(visibleToastCss).toMatch(/display:\s*flex/);
      expect(visibleToastCss).toMatch(/right:\s*16px/);
      expect(visibleToastCss).toMatch(/padding:\s*8px 13px/);
      const warning = 'Not enough space for another pane';
      const classes = new Set<string>();
      const attributes = new Map([
        ['role', 'status'],
        ['aria-live', 'polite'],
      ]);
      const liveStatus = {
        hidden: false,
        textContent: '',
        role: 'status',
        ariaLive: 'polite',
        getAttribute: (name: string) => attributes.get(name) ?? null,
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        removeAttribute: (name: string) => attributes.delete(name),
        classList: {
          add: (name: string) => classes.add(name),
          remove: (name: string) => classes.delete(name),
          contains: (name: string) => classes.has(name),
        },
      };
      let now = 0;
      let nextTimerId = 1;
      const timers = new Map<number, { callback: () => void; dueAt: number }>();
      const setTimer = (callback: () => void, delay: number) => {
        const id = nextTimerId++;
        timers.set(id, { callback, dueAt: now + delay });
        return id;
      };
      const advanceClock = (milliseconds: number) => {
        now += milliseconds;
        for (const [id, timer] of [...timers]) {
          if (timer.dueAt <= now) {
            timers.delete(id);
            timer.callback();
          }
        }
      };
      const toast = Function(
        'toastEl', 'setTimeout', 'clearTimeout',
        `"use strict"; var toastTimer = 0; return (${functionSource('toast')});`,
      )(liveStatus, setTimer, (id: number) => timers.delete(id)) as (message: string, duration?: number) => void;
      const showPanePlacementWarning = Function(
        'setStatus', 'toast',
        `"use strict"; return (${functionSource('showPanePlacementWarning')});`,
      )(() => undefined, toast) as (message: string) => void;
      const state = {
        activeProjectId: 'project-a',
        activeThreadId: 'shell-a',
        threads: [{
          id: 'git-hidden', projectId: 'project-a', worktreePath: '/worktree-a',
          kind: 'git', hidden: true,
        }],
      };
      const project = { id: 'project-a' };
      const reopenThread = Function(
        'findThread', 'findProject', 'state', 'activeWorkspaceRoot', 'preparePanePlacement',
        'setStatus', 'noteStatusActivity', 'commitPanePlacement', 'createPaneFooter',
        'revealGitPane', 'renderPaneWorkspace', 'renderGitSurface', 'refreshSidebar',
        `"use strict"; return (${functionSource('reopenThread')});`,
      )(
        (id: string) => state.threads.find((thread) => thread.id === id),
        () => project,
        state,
        () => '/worktree-a',
        () => null,
        () => undefined,
        () => undefined,
        () => { throw new Error('must not commit placement'); },
        () => { throw new Error('must not create footer'); },
        () => { throw new Error('must not reveal Git'); },
        () => { throw new Error('must not render workspace'); },
        () => { throw new Error('must not render Git'); },
        () => { throw new Error('must not refresh sidebar'); },
      ) as (id: string) => boolean;
      const openOrFocusGitPane = Function(
        'activeProject', 'setStatus', 'activeWorkspaceRoot', 'gitPaneThread',
        'showTerminalView', 'reopenThread', 'revealGitPane', 'focusThread',
        'makeThreadId', 'preparePanePlacement', 'commitPanePlacement', 'state',
        'noteStatusActivity', 'mountToolPane', 'renderGitSurface', 'refreshSidebar',
        'saveWorkspaceSoon', 'showPanePlacementWarning',
        `"use strict"; return (${functionSource('openOrFocusGitPane')});`,
      )(
        () => project,
        () => undefined,
        () => '/worktree-a',
        () => state.threads[0],
        async () => true,
        reopenThread,
        () => { throw new Error('must not reveal Git'); },
        async () => { throw new Error('must not focus Git'); },
        () => 'git-new',
        () => null,
        () => { throw new Error('must not commit placement'); },
        state,
        () => undefined,
        () => { throw new Error('must not mount Git'); },
        () => { throw new Error('must not render Git'); },
        () => { throw new Error('must not refresh sidebar'); },
        () => { throw new Error('must not save workspace'); },
        showPanePlacementWarning,
      ) as () => Promise<null>;
      const routeGitPaneShortcut = Function(
        'isTextEntryTarget', 'gitPaneShortcutBlocked', 'openOrFocusGitPane',
        `"use strict"; return (${functionSource('routeGitPaneShortcut')});`,
      )(() => false, () => false, openOrFocusGitPane) as (event: Record<string, unknown>) => boolean;
      let prevented = false;
      const before = JSON.stringify(state);

      expect(routeGitPaneShortcut({
        key: 'g', code: 'KeyG', metaKey: true, ctrlKey: false, altKey: false,
        shiftKey: false, target: { tagName: 'BODY' }, preventDefault: () => { prevented = true; },
      })).toBe(true);
      await Promise.resolve();
      await Promise.resolve();

      expect(prevented).toBe(true);
      expect(liveStatus.textContent).toBe(warning);
      expect(liveStatus.classList.contains('is-visible')).toBe(true);
      expect(JSON.stringify(state)).toBe(before);
      advanceClock(3_000);
      expect(liveStatus.textContent).toBe(warning);
      expect(liveStatus.classList.contains('is-visible')).toBe(true);
      advanceClock(3_001);
      expect(liveStatus.textContent).toBe('');
      expect(liveStatus.classList.contains('is-visible')).toBe(false);
    });
  });

  it('removes dock layout persistence, chrome, and shortcuts atomically', () => {
    for (const token of ['.git-dock', '.dock-mini', '.dock-collapse', '--split-frac', '--terminal-col']) {
      expect(stylesCss).not.toContain(token);
    }
    expect(functionSource('persistableProject')).not.toContain('layout:');
    expect(functionSource('sanitizeSavedProject')).not.toContain('saved.layout');
    expect(mainJs).not.toContain('applyLayout');
    expect(mainJs).not.toContain('toggleDock');
    expect(mainJs).not.toContain('panelIsVisible');
    expect(mainJs).not.toContain('cmd: "/split"');
    expect(mainJs).not.toMatch(/e\.key === "\\\\"/);
    expect(mainJs).not.toMatch(/e\.code === "KeyB" && e\.altKey/);
    expect(stylesCss).not.toContain('@keyframes browser-pane-in');
  });

  it('stages Git before every shared close path and preserves the Git close label', async () => {
    const calls: string[] = [];
    const attributes = new Map<string, string>();
    const thread = {
      id: 'git',
      projectId: 'project',
      worktreePath: '/repo',
      name: 'Git',
      kind: 'git',
      status: '',
      closing: false,
      closeStarted: false,
      metricsGeneration: 0,
      metricsRefreshTimer: 0,
      startInFlight: false,
      term: null,
      pane: null,
      paneTitle: null,
      paneMeta: null,
      paneClose: {
        title: 'stale',
        setAttribute: (name: string, value: string) => attributes.set(name, value),
      },
    };
    const state = { threads: [thread], activeThreadId: thread.id };
    const findThread = (id: string) => (
      state.threads.find((candidate) => candidate.id === id) || null
    );
    const paneFocusDependencies = compileCloseThreadPaneDependencies(findThread);
    const closeThread = Function(
      'findThread', 'canvasSurfaceById', 'paneLayoutForThread', 'paneSurfaceFocusEligible',
      'resolvePaneFocusSuccessor', 'PsychePanes',
      'markActiveSurface', 'stageGitSurface', 'suspendGitRequests', 'clearTimeout',
      'noteStatusActivity', 'pendingDataBuffers', 'forgetThreadInSets',
      'detachThreadPane', 'stopThreadPty', 'state',
      'retainFileFocusAfterThreadRemoval', 'renderPaneWorkspace',
      'setProjectStatus', 'findProject', 'focusThread', 'refreshSidebar', 'refreshTabs',
      'isPersistentThread', 'invoke', 'saveWorkspaceNow', 'setStatus',
      `"use strict"; return (${functionSource('closeThread')});`,
    )(
      findThread,
      paneFocusDependencies.canvasSurfaceById,
      paneFocusDependencies.paneLayoutForThread,
      paneFocusDependencies.paneSurfaceFocusEligible,
      paneFocusDependencies.resolvePaneFocusSuccessor,
      PsychePanes,
      () => undefined,
      () => { calls.push('stage'); },
      () => { calls.push('suspend'); },
      () => undefined,
      () => undefined,
      new Map(),
      () => undefined,
      () => { calls.push('detach'); return null; },
      () => { calls.push('stop'); return Promise.resolve(true); },
      state,
      () => false,
      () => undefined,
      () => undefined,
      () => ({ id: 'project' }),
      () => undefined,
      () => undefined,
      () => undefined,
      () => false,
      async () => undefined,
      async () => true,
      () => undefined,
    ) as (id: string) => Promise<boolean>;

    await expect(closeThread(thread.id)).resolves.toBe(true);
    expect(calls.slice(0, 3)).toEqual(['suspend', 'stage', 'detach']);
    expect(calls).not.toContain('stop');

    const syncThreadPaneMetadata = Function(
      'applyPaneStatus', 'syncPaneBranchStatusChrome', 'syncPaneFooter',
      'paneLayoutForThread', 'PsychePanes', 'syncPaneSpanControl', 'syncPaneMaxControl',
      'sessionCloseLabel',
      `"use strict"; return (${functionSource('syncThreadPaneMetadata')});`,
    )(
      () => '',
      () => undefined,
      () => undefined,
      () => null,
      {},
      () => undefined,
      () => undefined,
      (value: typeof thread) => value.kind === 'git' ? 'Close Git pane' : `Stop and close ${value.name}`,
    ) as (value: typeof thread) => void;
    syncThreadPaneMetadata(thread);
    expect(thread.paneClose.title).toBe('Close Git pane');
    expect(attributes.get('aria-label')).toBe('Close Git pane');

    expect(functionSource('closeToolPane')).toContain('closeThread(thread.id)');
    expect(functionSource('renderSessionList')).toContain('requestThreadClose(thread)');
    expect(functionSource('requestThreadClose')).toContain('closeThread(thread.id)');
    expect(mainJs).toMatch(
      /cmd: "\/close"[\s\S]{0,180}requestThreadClose\(findThread\(state\.activeThreadId\)\)/,
    );
  });

  describe('voice call bar', () => {
    function compile(deps: Record<string, unknown> = {}) {
      const bar = { hidden: true, classList: { toggle: () => undefined } };
      const els: Record<string, any> = {
        'call-bar': bar,
        'call-target': { textContent: '' },
        'call-timer': { textContent: '' },
        'call-note': { textContent: '' },
        'call-mute': { textContent: '', setAttribute: () => undefined, addEventListener: () => undefined },
        'call-end': { addEventListener: () => undefined },
        'composer-call': { setAttribute: () => undefined, addEventListener: () => undefined },
      };
      const source = [
        'formatCallTime', 'paintCallBar', 'startCall', 'endCall', 'toggleCallMute',
      ].map((name) => functionSourceOf(name)).join('\n');
      const factory = Function(
        'document', 'findThread', 'state', 'setInterval', 'clearInterval', 'Date',
        `"use strict";
         var callBarEl = document.getElementById('call-bar');
         var callTargetEl = document.getElementById('call-target');
         var callTimerEl = document.getElementById('call-timer');
         var callNoteEl = document.getElementById('call-note');
         var callMuteBtn = document.getElementById('call-mute');
         var callEndBtn = document.getElementById('call-end');
         var composerCallEl = document.getElementById('composer-call');
         var callState = { active: false, startedAt: 0, muted: false, timer: 0 };
         ${source}
         return { formatCallTime, startCall, endCall, toggleCallMute, callState, els: {
           bar: callBarEl, target: callTargetEl, note: callNoteEl, mute: callMuteBtn } };`,
      );
      return factory(
        { getElementById: (id: string) => els[id] ?? null },
        () => ({ name: 'codex-review' }),
        { activeThreadId: 't1' },
        () => 1,
        () => undefined,
        Date,
        ...Object.values(deps),
      ) as any;
    }

    function functionSourceOf(name: string) {
      const start = mainJs.indexOf(`function ${name}(`);
      if (start === -1) throw new Error(`missing ${name}`);
      const bodyStart = mainJs.indexOf('{', start);
      let depth = 0;
      for (let i = bodyStart; i < mainJs.length; i += 1) {
        if (mainJs[i] === '{') depth += 1;
        if (mainJs[i] === '}') depth -= 1;
        if (depth === 0) return mainJs.slice(start, i + 1);
      }
      throw new Error(`unterminated ${name}`);
    }

    it('formats elapsed time as m:ss', () => {
      const api = compile();
      expect(api.formatCallTime(0)).toBe('0:00');
      expect(api.formatCallTime(9_000)).toBe('0:09');
      expect(api.formatCallTime(61_000)).toBe('1:01');
      expect(api.formatCallTime(600_000)).toBe('10:00');
      // A clock that ran backwards would print a negative time.
      expect(api.formatCallTime(-5_000)).toBe('0:00');
    });

    it('names the focused pane and says plainly that nothing is transmitting', () => {
      const api = compile();
      api.startCall();
      expect(api.els.target.textContent).toBe('codex-review');
      // There is no getUserMedia, recogniser or audio path in this app; the bar
      // must not imply an agent is listening.
      expect(api.els.note.textContent).toMatch(/no voice transport/i);
      // Assert on the API entry points, not the words: the comment above
      // startCall names them precisely to say they are absent.
      expect(mainJs).not.toMatch(/navigator\.mediaDevices/);
      expect(mainJs).not.toMatch(/new\s+(?:webkit)?SpeechRecognition\s*\(/);
      expect(mainJs).not.toMatch(/\.getUserMedia\s*\(/);
    });

    it('starts unmuted, toggles, and resets the control when the call ends', () => {
      const api = compile();
      api.startCall();
      expect(api.els.mute.textContent).toBe('Mute');
      expect(api.toggleCallMute()).toBe(true);
      expect(api.els.mute.textContent).toBe('Unmute');
      api.endCall();
      // Painted while hidden, or the next call opens reading "Unmute".
      expect(api.els.mute.textContent).toBe('Mute');
    });

    it('is idempotent at both ends', () => {
      const api = compile();
      expect(api.startCall()).toBe(true);
      expect(api.startCall()).toBe(false);
      expect(api.endCall()).toBe(true);
      expect(api.endCall()).toBe(false);
      // Muting a call that is not running is a no-op, not a state change.
      expect(api.toggleCallMute()).toBe(false);
    });

    it('ends on esc, after the more transient layers', () => {
      expect(mainJs).toMatch(/if \(armedSessionClose\) \{ disarmSessionClose\(\); return; \}[\s\S]*if \(endCall\(\)\) return;/);
    });

    it('sits above the composer so the composer never moves', () => {
      expect(indexHtml).toContain('id="call-bar"');
      expect(stylesCss).toMatch(/\.call-bar\s*\{[^}]*bottom: calc\(100% - 4px\);/s);
      // Muting stops the waveform -- the one honest thing it can show.
      expect(stylesCss).toMatch(/\.call-bar\.is-muted \.call-wave i\s*\{[^}]*animation: none;/s);
    });
  });
});
