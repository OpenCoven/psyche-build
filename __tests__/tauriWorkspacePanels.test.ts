import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const mainJs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8'
);
const indexHtml = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/index.html'),
  'utf8'
);
const sessionsBundle = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/sessions.bundle.js'),
  'utf8'
);
const panesBundle = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/panes.bundle.js'),
  'utf8'
);
const inputBundle = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/input.bundle.js'),
  'utf8'
);
const statusBundle = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/status.bundle.js'),
  'utf8'
);
const stylesCss = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/styles.css'),
  'utf8'
);
const tauriLib = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8'
);
const tauriPackage = JSON.parse(
  readFileSync(join(repoRoot, 'native/macos/psyche-build-tauri/package.json'), 'utf8')
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

  it('keeps a Git-only dock with Changes and Commit', () => {
    expect(indexHtml).not.toContain('class="dock-tab"');
    expect(stylesCss).not.toMatch(/\.dock-tab\s*\{/);
    expect(stylesCss).not.toContain('--dock-tabs-h');
    expect(indexHtml).not.toContain('data-browser-column-toggle');
    expect(indexHtml).toContain('class="panel panel-git"');
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
    expect(sidebar).toContain('data-sidebar-tab="sessions"');
    expect(sidebar).toContain('data-sidebar-tab="files"');
    expect(sidebar).toContain('id="file-tree"');
    // File tabs belong to the file view now, not the whole terminal area.
    const fileView = indexHtml.slice(indexHtml.indexOf('class="file-view"'));
    expect(fileView.slice(0, fileView.indexOf('</div>') + 6)).toContain('id="tab-strip"');
    // ...but its markup still exists, inside the git panel, with the element
    // ids the diff renderer writes into.
    const gitPanel = indexHtml.slice(indexHtml.indexOf('class="panel panel-git"'));
    for (const id of ['git-view', 'diffs-summary', 'diffs-refresh', 'diff-files', 'diff-rows']) {
      expect(gitPanel).toContain(`id="${id}"`);
    }
  });

  it('pins a repository-local Tauri 2 CLI for native builds', () => {
    expect(tauriPackage.scripts['build:web']).toBe(
      'esbuild web/editor/editor-entry.js --bundle --minify --format=iife --global-name=PsycheCodeEditor --outfile=web/editor.bundle.js && esbuild web/sessions/session-entry.js --bundle --minify --format=iife --global-name=PsycheSessions --outfile=web/sessions.bundle.js && esbuild web/panes/pane-entry.js --bundle --minify --format=iife --global-name=PsychePanes --outfile=web/panes.bundle.js && esbuild web/input/input-entry.js --bundle --minify --format=iife --global-name=PsycheTerminalInput --outfile=web/input.bundle.js && esbuild web/diffs/diff-entry.js --bundle --minify --format=iife --global-name=PsycheDiffs --outfile=web/diffs.bundle.js && esbuild web/status/status-entry.js --bundle --minify --format=iife --global-name=PsycheStatus --outfile=web/status.bundle.js'
    );
    expect(tauriPackage.scripts.build).toBe('pnpm build:web && tauri build');
    expect(tauriPackage.scripts.dev).toBe('pnpm build:web && tauri dev');
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
        /function closeThread\(id, options\)[\s\S]{0,700}thread\.kind === "web"[\s\S]{0,120}state\.activeThreadId === id[\s\S]{0,120}markActiveSurface\("terminal"\)/
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
      expect(mainJs).toMatch(/function setDockGitCount\(count\)[\s\S]*gitChangesCountEl\.textContent/);
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

  describe('dock to canvas', () => {
    it('moves one live surface rather than rendering it twice', () => {
      // Two renderings of the git panel could diverge; one element with two
      // possible homes cannot.
      expect(indexHtml).toContain('id="git-surface"');
      expect(mainJs).toMatch(/function dockGitSurface\(\)[\s\S]*gitPanelEl\.appendChild\(gitSurfaceEl\)/);
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

    it('offers pop-out and drag from the same control', () => {
      expect(indexHtml).toMatch(/id="git-pop-out"[\s\S]*draggable="true"/);
      expect(mainJs).toMatch(/gitPopOutBtn\.addEventListener\("click"[\s\S]*popOutGitPane\(\)/);
      expect(mainJs).toMatch(/gitPopOutBtn\.addEventListener\("dragstart"[\s\S]*text\/x-psyche-tool/);
    });

    it('lands a dropped tool where it was dropped', () => {
      expect(mainJs).toMatch(/terminalHost\.addEventListener\("drop"[\s\S]*popOutGitPane\(target\)/);
      expect(mainJs).toMatch(/movePaneTo\(id, dropTarget\.threadId, dropTarget\.position\)/);
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
      expect(mainJs).toMatch(/function closeToolPane\(thread\)[\s\S]*dockGitSurface\(\)[\s\S]*detachThreadPane\(thread\)/);
    });

    it('files a tool pane as a tool, not an agent', () => {
      const sidebarModel = readFileSync(
        join(repoRoot, 'native/macos/psyche-build-tauri/web/sessions/sidebar-model.mjs'),
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

    it('keeps the current dock pop-out as a compatibility caller', () => {
      expect(mainJs).toMatch(
        /function popOutGitPane\(dropTarget\)[\s\S]*return openOrFocusGitPane\(dropTarget\)/,
      );
    });

    it('returns the shared surface to the dock when the newly active scope has no owner', () => {
      const source = functionSource('syncGitSurfaceForActiveScope');
      expect(source).toMatch(
        /var project = activeProject\(\);[\s\S]*gitPaneThread\(project\.id, activeWorkspaceRoot\(project\)\)/,
      );
      expect(source).toMatch(/if \(!thread\) dockGitSurface\(\);/);
      expect(source).toMatch(/else syncGitDockChrome\(\);/);
      expect(functionSource('dockGitSurface')).toContain('syncGitDockChrome();');
      expect(functionSource('renderPaneWorkspace')).toMatch(
        /stageBrowserSurface\(\);[\s\S]*syncGitSurfaceForActiveScope\(\);[\s\S]*terminalHost\.replaceChildren\(\);/,
      );

      function runForActiveScope(owner: unknown) {
        const calls: string[] = [];
        const syncActiveScope = Function(
          'activeProject', 'activeWorkspaceRoot', 'gitPaneThread',
          'dockGitSurface', 'syncGitDockChrome',
          `"use strict"; return (${source});`,
        )(
          () => ({ id: 'next-project' }),
          () => '/next-worktree',
          (projectId: string, workspaceRoot: string) => {
            calls.push(`lookup:${projectId}:${workspaceRoot}`);
            return owner;
          },
          () => { calls.push('dock'); },
          () => { calls.push('chrome'); },
        ) as () => void;
        syncActiveScope();
        return calls;
      }

      expect(runForActiveScope(null)).toEqual([
        'lookup:next-project:/next-worktree', 'dock',
      ]);
      expect(runForActiveScope({ id: 'git-next' })).toEqual([
        'lookup:next-project:/next-worktree', 'chrome',
      ]);
    });

    it('keeps the shared surface mounted in a Git pane owned by the newly active scope', () => {
      expect(functionSource('renderPaneNode')).toMatch(
        /thread\.kind === "git" && thread\.toolBody && gitSurfaceEl[\s\S]*thread\.toolBody\.appendChild\(gitSurfaceEl\)/,
      );
    });

    it('drops late Git refreshes after the active worktree changes', () => {
      const source = functionSource('gitPanelRequestMatches');
      expect(functionSource('renderGitPanel')).toContain(
        'var panelGeneration = gitPanelRequestGate.next();',
      );
      expect(functionSource('renderGitPanel')).toContain(
        'if (!gitPanelRequestMatches(projectId, workspaceRoot, panelGeneration)) return;',
      );

      let active = { id: 'project-a', root: '/worktree-a' };
      let generation = 1;
      const matches = Function(
        'activeProject', 'activeWorkspaceRoot', 'gitPanelRequestGate',
        `"use strict"; return (${source});`,
      )(
        () => active,
        (project: typeof active) => project.root,
        { isCurrent: (candidate: number) => candidate === generation },
      ) as (projectId: string, workspaceRoot: string, candidate: number) => boolean;

      expect(matches('project-a', '/worktree-a', 1)).toBe(true);
      active = { id: 'project-a', root: '/worktree-b' };
      expect(matches('project-a', '/worktree-a', 1)).toBe(false);
      active = { id: 'project-b', root: '/worktree-a' };
      expect(matches('project-a', '/worktree-a', 1)).toBe(false);
      generation = 2;
      expect(matches('project-b', '/worktree-a', 1)).toBe(false);
    });

    it('does not paint a late Git response from the previous worktree', async () => {
      const source = functionSource('renderGitPanel');
      let active = { id: 'project-a', root: '/worktree-a' };
      let generation = 0;
      let resolveA!: (value: { is_repo: boolean; files: unknown[] }) => void;
      const gitViewEl = {
        innerHTML: '',
        appendChild: () => undefined,
      };
      const renderGitPanel = Function(
        'gitViewEl', 'gitPanelRequestGate', 'activeProject', 'panelMessage',
        'activeWorkspaceRoot', 'gitBranchEl', 'gitRemoteWebUrl',
        'gitOpenRemoteBtn', 'invoke', 'gitPanelRequestMatches', 'setDockGitCount',
        'document', 'escapeHtml', 'shortenRelPath', 'openUrl',
        `"use strict"; return (${source});`,
      )(
        gitViewEl,
        { next: () => ++generation },
        () => active,
        (view: typeof gitViewEl, message: string) => { view.innerHTML = message; },
        (project: typeof active) => project.root,
        { textContent: '' },
        null,
        { disabled: false },
        (command: string, args: { root: string }) => {
          if (command === 'git_status' && args.root === '/worktree-a') {
            return new Promise((resolve) => { resolveA = resolve; });
          }
          if (command === 'git_status' && args.root === '/worktree-b') {
            return Promise.resolve({ is_repo: false, files: [] });
          }
          throw new Error(`unexpected ${command} for ${args.root}`);
        },
        (projectId: string, workspaceRoot: string, candidate: number) =>
          candidate === generation && active.id === projectId && active.root === workspaceRoot,
        () => undefined,
        { createElement: () => ({}) },
        (value: string) => value,
        (value: string) => value,
        null,
      ) as () => Promise<void>;

      const slowA = renderGitPanel();
      active = { id: 'project-b', root: '/worktree-b' };
      await renderGitPanel();
      expect(gitViewEl.innerHTML).toBe('Not a git repository.');

      resolveA({ is_repo: true, files: [] });
      await slowA;
      expect(gitViewEl.innerHTML).toBe('Not a git repository.');
    });

    it('does not start git log after git status becomes stale', async () => {
      const source = functionSource('renderGitPanel');
      let active = { id: 'project-a', root: '/worktree-a' };
      let generation = 0;
      const requests: string[] = [];
      const renderGitPanel = Function(
        'gitViewEl', 'gitPanelRequestGate', 'activeProject', 'panelMessage',
        'activeWorkspaceRoot', 'gitBranchEl', 'gitRemoteWebUrl',
        'gitOpenRemoteBtn', 'invoke', 'gitPanelRequestMatches', 'setDockGitCount',
        'document', 'escapeHtml', 'shortenRelPath', 'openUrl',
        `"use strict"; return (${source});`,
      )(
        { innerHTML: '', appendChild: () => undefined },
        { next: () => ++generation },
        () => active,
        () => undefined,
        (project: typeof active) => project.root,
        { textContent: '' },
        null,
        { disabled: false },
        (command: string) => {
          requests.push(command);
          if (command === 'git_status') {
            active = { id: 'project-b', root: '/worktree-b' };
            return Promise.resolve({ is_repo: true, files: [] });
          }
          return Promise.resolve([]);
        },
        (projectId: string, workspaceRoot: string, candidate: number) =>
          candidate === generation && active.id === projectId && active.root === workspaceRoot,
        () => undefined,
        { createElement: () => ({}) },
        (value: string) => value,
        (value: string) => value,
        null,
      ) as () => Promise<void>;

      await renderGitPanel();
      expect(requests).toEqual(['git_status']);
    });

    it('deduplicates a Git pane in the active scope before allocation', async () => {
      const source = functionSource('openOrFocusGitPane');
      const calls: string[] = [];
      const existing = { id: 'git-existing' };
      const openOrFocusGitPane = Function(
        'activeProject', 'setStatus', 'activeWorkspaceRoot', 'gitPaneThread',
        'showTerminalView', 'revealGitPane', 'focusThread', 'makeThreadId', 'preparePanePlacement', 'commitPanePlacement',
        'state', 'noteStatusActivity', 'mountToolPane', 'movePaneTo',
        'syncGitDockChrome', 'refreshSidebar', 'saveWorkspaceSoon',
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
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
      ) as () => Promise<typeof existing>;

      await expect(openOrFocusGitPane()).resolves.toBe(existing);
      expect(calls).toEqual(['focus:git-existing']);
    });

    it('cancels before allocating Git state when leaving a dirty file is declined', async () => {
      const source = functionSource('openOrFocusGitPane');
      const calls: string[] = [];
      const state = { threads: [] as unknown[] };
      const openOrFocusGitPane = Function(
        'activeProject', 'setStatus', 'activeWorkspaceRoot', 'gitPaneThread',
        'showTerminalView', 'revealGitPane', 'focusThread', 'makeThreadId', 'preparePanePlacement', 'commitPanePlacement',
        'state', 'noteStatusActivity', 'mountToolPane', 'movePaneTo',
        'syncGitDockChrome', 'refreshSidebar', 'saveWorkspaceSoon',
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
        () => { calls.push('move'); },
        () => { calls.push('chrome'); },
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
        'state', 'noteStatusActivity', 'mountToolPane', 'movePaneTo',
        'syncGitDockChrome', 'refreshSidebar', 'saveWorkspaceSoon',
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
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
      ) as () => Promise<typeof existing>;

      await expect(openOrFocusGitPane()).resolves.toBe(existing);
      expect(calls).toEqual([
        'lookup:project-b:/worktree-b', 'reveal', 'focus:git-project-b',
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
        'state', 'noteStatusActivity', 'mountToolPane', 'movePaneTo',
        'syncGitDockChrome', 'refreshSidebar', 'saveWorkspaceSoon',
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
        () => undefined,
        () => { calls.push('chrome'); },
        () => { calls.push('sidebar'); },
        () => { calls.push('save'); },
      ) as () => Promise<{ id: string; projectId: string; worktreePath: string }>;

      await expect(openOrFocusGitPane()).resolves.toMatchObject({
        id: 'git-new', projectId: 'project-b', worktreePath: '/worktree-b',
      });
      expect(state.threads).toHaveLength(1);
      expect(calls).toEqual([
        'lookup:project-b:/worktree-b', 'place:git-new:project-b:/worktree-b',
        'commit', 'activity', 'mount', 'focus:git-new', 'chrome', 'sidebar', 'save',
      ]);
    });

    it('does not mutate pane state when placement fails', async () => {
      const source = functionSource('openOrFocusGitPane');
      const state = { threads: [] as unknown[] };
      const calls: string[] = [];
      const openOrFocusGitPane = Function(
        'activeProject', 'setStatus', 'activeWorkspaceRoot', 'gitPaneThread',
        'showTerminalView', 'revealGitPane', 'focusThread', 'makeThreadId', 'preparePanePlacement', 'commitPanePlacement',
        'state', 'noteStatusActivity', 'mountToolPane', 'movePaneTo',
        'syncGitDockChrome', 'refreshSidebar', 'saveWorkspaceSoon',
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
        () => undefined,
        () => { calls.push('chrome'); },
        () => { calls.push('sidebar'); },
        () => { calls.push('save'); },
      ) as () => Promise<null>;

      await expect(openOrFocusGitPane()).resolves.toBeNull();
      expect(state.threads).toEqual([]);
      expect(calls).toEqual(['status:Not enough space for another pane']);
    });
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
