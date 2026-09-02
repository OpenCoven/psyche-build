import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const indexHtml = readFileSync(join(root, 'native/desktop/psyche-build-tauri/web/index.html'), 'utf8');
const mainJs = readFileSync(join(root, 'native/desktop/psyche-build-tauri/web/main.js'), 'utf8');
const styles = readFileSync(join(root, 'native/desktop/psyche-build-tauri/web/styles.css'), 'utf8');
const packagedTitlebarMark = readFileSync(
  join(root, 'native/desktop/psyche-build-tauri/web/assets/opencoven-mark.png'),
);
const tauri = readFileSync(join(root, 'native/desktop/psyche-build-tauri/src-tauri/src/lib.rs'), 'utf8');
const sessionModel = readFileSync(
  join(root, 'native/desktop/psyche-build-tauri/web/sessions/session-model.mjs'),
  'utf8',
);

function functionSource(source: string, name: string) {
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

function titlebarHtml(source: string) {
  const match = source.match(/<header class="titlebar"[\s\S]*?<\/header>/);
  if (!match) throw new Error('missing titlebar');
  return match[0];
}

function sidebarHeadHtml(source: string) {
  const match = source.match(/<div class="sidebar-head">([\s\S]*?)<\/div>/);
  if (!match) throw new Error('missing sidebar-head');
  return match[0];
}

function buttonHtml(source: string, id: string) {
  const match = source.match(
    new RegExp(`<button[^>]*id="${escapeRegExp(id)}"[^>]*>[\\s\\S]*?<\\/button>`),
  );
  if (!match) throw new Error(`missing button ${id}`);
  return match[0];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  name: string,
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(
    ...names,
    `"use strict"; return (${functionSource(source, name)});`,
  )(...values) as T;
}

function ruleBlock(source: string, selector: string) {
  const match = source.match(
    new RegExp(`(^|\\n)${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, 's'),
  );
  return match?.[2] ?? null;
}

function createMockButton() {
  const attributes = new Map<string, string>();
  return {
    hidden: false,
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
  };
}

describe('Tauri project/worktree/pane rail', () => {
  it('uses an accessible Hide pane control in every canvas-pane header', () => {
    expect(mainJs).toMatch(/function createPaneHideButton\(surface\)/);
    const hideControl = functionSource(mainJs, 'createPaneHideButton');
    expect(hideControl).toContain('terminal-pane-hide');
    expect(hideControl).toContain('"Hide pane"');
    expect(hideControl).toContain('hideCanvasSurface(surface)');

    for (const name of ['mountToolPane', 'mountFilesPane', 'mountBrowserPane', 'mountTerminal']) {
      const mount = functionSource(mainJs, name);
      expect(mount).toContain('createPaneHideButton(');
      expect(mount).not.toContain('cyclePaneSpan(');
    }
    expect(styles).toContain('.terminal-pane-hide');
    expect(styles).not.toContain('.terminal-pane-span');
  });

  it('ships the Dia-inspired two-zone native shell and pinned sidebar controls', () => {
    const titlebar = titlebarHtml(indexHtml);
    const sidebarHead = sidebarHeadHtml(indexHtml);
    const railNewSessionButton = buttonHtml(sidebarHead, 'rail-new-tab');
    const filesBackButton = buttonHtml(indexHtml, 'files-back');

    expect(indexHtml).toContain('class="sidebar-controls" id="sidebar-session-controls"');
    expect(indexHtml).toContain('class="sidebar-settings" id="sidebar-settings"');
    expect(indexHtml).toContain('class="sidebar-resize"');
    expect(indexHtml).toMatch(
      /id="sidebar-resize"[^>]*role="separator"[^>]*aria-orientation="vertical"/,
    );
    expect(titlebar).toContain('class="titlebar-sidebar"');
    expect(titlebar).toContain('class="titlebar-workspace"');
    expect(titlebar).toContain('src="./assets/opencoven-mark.png"');
    expect(titlebar).toContain('class="titlebar-brand-fallback">O</span>');
    expect(titlebar).toContain('id="titlebar-brand-mark"');
    expect(titlebar).toMatch(/id="titlebar-brand-mark"[^>]*alt=""/);
    expect(titlebar).toContain('class="titlebar-brand-name">Psyche</span>');
    expect(titlebar).toContain('id="sidebar-collapse"');
    expect(indexHtml).not.toMatch(/\sonerror=/);
    for (const removedId of [
      'daemon-status',
      'shell-status',
      'help-toggle',
      'back',
      'forward',
      'reload',
      'url',
      'open-external',
    ]) {
      expect(titlebar).not.toContain(`id="${removedId}"`);
    }

    expect(indexHtml).not.toContain('id="session-search"');
    expect(styles).not.toMatch(/\.session-search(?:\s|\{|\.)/);
    expect(styles).not.toMatch(/\.session-search-wrap(?:\s|\{|\.)/);

    expect(sidebarHead).toContain('id="rail-new-tab"');
    expect(sidebarHead).not.toContain('id="sidebar-collapse"');
    expect(indexHtml).not.toContain('session-filter-btn');
    expect(indexHtml).not.toContain('aria-label="Sidebar sections"');
    expect(indexHtml).not.toContain('data-sidebar-tab=');
    expect(railNewSessionButton).toContain('new-session-button');
    expect(railNewSessionButton).toContain('aria-label="Create a new session"');
    expect(railNewSessionButton).toContain('aria-haspopup="menu"');
    expect(railNewSessionButton).toContain('aria-expanded="false"');
    expect(railNewSessionButton).toContain('aria-controls="new-pane-menu"');
    expect(railNewSessionButton).toContain('New Session');
    expect(railNewSessionButton).not.toContain('<svg');
    expect(filesBackButton).toContain('aria-label="Back to Sessions"');
    expect(filesBackButton).toContain('‹ Sessions');

    const filterRowMatch = indexHtml.match(
      /<div class="session-filter-row" role="toolbar" aria-label="Filter sessions">([\s\S]*?)<\/div>/,
    );
    expect(filterRowMatch).not.toBeNull();
    const filterRow = filterRowMatch?.[1] ?? '';
    expect(filterRow.match(/class="session-filter(?:\s|")/g)?.length).toBe(5);
    for (const filter of ['all', 'agents', 'shells', 'active', 'attention']) {
      expect(indexHtml).toContain(`data-session-filter="${filter}"`);
    }
    const attentionIndex = filterRow.indexOf('data-session-filter="attention"');
    expect(attentionIndex).toBeGreaterThan(-1);
    expect(indexHtml).not.toContain('session-legend-button');
    expect(indexHtml).not.toContain('session-status-legend');
    expect(indexHtml).not.toContain('Session status legend');
    expect(indexHtml).toMatch(
      /id="session-list"[^>]*role="tree"[^>]*aria-label="Sessions by project, branch, and category"/,
    );
    const renderSessionList = functionSource(mainJs, 'renderSessionList');
    expect(renderSessionList).toContain('sessionListEl.setAttribute("role", "tree")');
    expect(renderSessionList).toMatch(
      /sessionListEl\.setAttribute\(\s*"aria-label",\s*"Sessions by project, branch, and category"\s*\)/,
    );
    expect(renderSessionList).toContain('sessionListEl.setAttribute("aria-multiselectable", "true")');
    expect(renderSessionList).toContain('sessionListEl.removeAttribute("aria-multiselectable")');
    expect(indexHtml).toMatch(/id="rail-new-tab"[^>]*aria-label="Create a new session"/);
    expect(indexHtml).toMatch(/id="files-back"[^>]*aria-label="Back to Sessions"/);
    expect(titlebar).toMatch(/id="sidebar-collapse"[^>]*aria-label="Collapse sidebar"/);
  });

  it('ships a browser-loadable OpenCoven titlebar mark asset', () => {
    expect(packagedTitlebarMark.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(packagedTitlebarMark.length).toBeGreaterThan(10000);
  });

  it('removes a failed decorative titlebar mark through CSP-safe boot wiring', () => {
    expect(mainJs).toContain('initializeTitlebarBrandMark();');
    const initializeTitlebarBrandMark = compileFunction<() => void>(
      mainJs,
      'initializeTitlebarBrandMark',
      {
        document: {
          getElementById() {
            return failedAfterLoad;
          },
        },
      },
    );
    const errorListeners: Array<() => void> = [];
    const failedAfterLoad = {
      complete: false,
      naturalWidth: 18,
      remove: vi.fn(),
      addEventListener(
        event: string,
        listener: () => void,
        options?: { once?: boolean },
      ) {
        expect(event).toBe('error');
        expect(options).toEqual({ once: true });
        errorListeners.push(listener);
      },
    };

    initializeTitlebarBrandMark();
    expect(failedAfterLoad.remove).not.toHaveBeenCalled();
    expect(errorListeners).toHaveLength(1);
    errorListeners[0]();
    expect(failedAfterLoad.remove).toHaveBeenCalledTimes(1);

    const failedBeforeBoot = {
      complete: true,
      naturalWidth: 0,
      remove: vi.fn(),
      addEventListener: vi.fn(),
    };
    compileFunction<() => void>(mainJs, 'initializeTitlebarBrandMark', {
      document: {
        getElementById() {
          return failedBeforeBoot;
        },
      },
    })();
    expect(failedBeforeBoot.addEventListener).toHaveBeenCalledWith(
      'error',
      expect.any(Function),
      { once: true },
    );
    expect(failedBeforeBoot.remove).toHaveBeenCalledTimes(1);
  });

  it('retains browser controls under the browser surface but not in the native titlebar', () => {
    const titlebar = titlebarHtml(indexHtml);
    const browserSurface = indexHtml.match(
      /<div class="browser-surface" id="browser-surface">[\s\S]*?<div id="preview"/,
    )?.[0] ?? '';

    for (const id of ['back', 'forward', 'reload', 'url', 'open-external']) {
      expect(browserSurface).toContain(`id="${id}"`);
      expect(titlebar).not.toContain(`id="${id}"`);
    }
  });

  it('marks both titlebar zones as drag regions while keeping the sidebar toggle clickable', () => {
    const titlebar = titlebarHtml(indexHtml);
    const sidebarShell = titlebar.match(/<div class="titlebar-sidebar"[\s\S]*?<\/div>/)?.[0] ?? '';

    expect(titlebar).toContain('<header class="titlebar" data-tauri-drag-region>');
    expect(titlebar).toContain('<div class="titlebar-sidebar" data-tauri-drag-region>');
    expect(titlebar).toContain('<div class="titlebar-workspace" data-tauri-drag-region>');
    expect(sidebarShell).toContain('<span class="traffic-gutter" aria-hidden="true"></span>');
    expect(ruleBlock(styles, '.titlebar-sidebar-toggle')).toMatch(/-webkit-app-region:\s*no-drag;/);
  });

  it('keeps the workspace flex-aligned and the sidebar toggle fully inside it', () => {
    expect(styles).toMatch(
      /\.titlebar-workspace\s*\{[\s\S]*?position:\s*relative;[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;[\s\S]*?padding:\s*0 12px 0 10px;/,
    );
    expect(ruleBlock(styles, '.titlebar-sidebar-toggle')).toMatch(/position:\s*relative;/);
    expect(ruleBlock(styles, '.titlebar-sidebar-toggle')).toMatch(/left:\s*auto;/);
    expect(ruleBlock(styles, '.titlebar-sidebar-toggle')).toMatch(/top:\s*auto;/);
    expect(ruleBlock(styles, '.titlebar-sidebar-toggle')).toMatch(/transform:\s*none;/);
    expect(ruleBlock(styles, '.app[data-sidebar="collapsed"] .titlebar-workspace')).toMatch(
      /padding-left:\s*calc\(var\(--titlebar-pad-l\)\s*-\s*var\(--mini-rail-w\)\s*\+\s*10px\);/,
    );
  });

  it('uses the updated 44px titlebar height and 24px OpenCoven brand badge', () => {
    expect(ruleBlock(styles, ':root')).toMatch(/--titlebar-h:\s*44px;/);
    expect(ruleBlock(styles, '.titlebar-brand-icon')).toMatch(/width:\s*24px;/);
    expect(ruleBlock(styles, '.titlebar-brand-icon')).toMatch(/height:\s*24px;/);
    expect(ruleBlock(styles, '.titlebar-brand-icon')).toMatch(/background:\s*#050505;/);
    expect(ruleBlock(styles, '.titlebar-brand-mark')).toMatch(/object-fit:\s*contain;/);
  });

  it('keeps the agent control button intrinsically sized to its label', () => {
    expect(ruleBlock(styles, '.chrome-btn.agent-control-toggle')).toMatch(/width:\s*auto;/);
    expect(ruleBlock(styles, '.chrome-btn.agent-control-toggle')).toMatch(
      /padding-inline:\s*9px;/,
    );
  });

  it('makes visible brand descendants non-interactive so direct clicks resolve to the drag-region shell', () => {
    const titlebar = titlebarHtml(indexHtml);

    expect(titlebar).toContain('<span class="titlebar-brand" data-tauri-drag-region>');
    expect(titlebar).toContain('<span class="titlebar-brand-icon" aria-hidden="true">');
    expect(titlebar).toContain('<span class="titlebar-brand-name">Psyche</span>');
    expect(ruleBlock(styles, '.titlebar-brand-icon')).toMatch(/pointer-events:\s*none;/);
    expect(ruleBlock(styles, '.titlebar-brand-name')).toMatch(/pointer-events:\s*none;/);
  });

  it('syncs both sidebar toggle controls with the collapsed state', () => {
    const sidebarCollapseEl = createMockButton();
    const sidebarExpandEl = createMockButton();
    const syncSidebarToggleState = compileFunction<
      (collapsed: boolean) => void
    >(mainJs, 'syncSidebarToggleState', {
      sidebarCollapseEl,
      sidebarExpandEl,
    });

    syncSidebarToggleState(true);
    expect(sidebarCollapseEl.getAttribute('aria-label')).toBe('Expand sidebar');
    expect(sidebarCollapseEl.getAttribute('aria-pressed')).toBe('true');
    expect(sidebarExpandEl.hidden).toBe(false);
    expect(sidebarExpandEl.getAttribute('aria-label')).toBe('Expand sidebar');
    expect(sidebarExpandEl.getAttribute('aria-pressed')).toBe('true');

    syncSidebarToggleState(false);
    expect(sidebarCollapseEl.getAttribute('aria-label')).toBe('Collapse sidebar');
    expect(sidebarCollapseEl.getAttribute('aria-pressed')).toBe('false');
    expect(sidebarExpandEl.hidden).toBe(true);
    expect(sidebarExpandEl.getAttribute('aria-label')).toBe('Expand sidebar');
    expect(sidebarExpandEl.getAttribute('aria-pressed')).toBe('false');
  });

  it('routes sidebar state changes and handlers through the shared toggle helper', () => {
    const closeNewPaneMenu = vi.fn();
    const scheduleSidebarLayout = vi.fn();
    const appEl = { dataset: { sidebar: 'open' as 'open' | 'collapsed' } };
    const setSidebarOpen = compileFunction<(open: boolean) => void>(mainJs, 'setSidebarOpen', {
      appEl,
      pendingSidebarOpen: null,
      closeNewPaneMenu,
      scheduleSidebarLayout,
    });

    setSidebarOpen(true);
    setSidebarOpen(false);
    expect(closeNewPaneMenu).toHaveBeenCalledTimes(1);
    expect(scheduleSidebarLayout).toHaveBeenCalledTimes(2);
    expect(mainJs).toContain('onRailClick("sidebar-collapse", function () { toggleSidebar(); });');
    expect(mainJs).toContain('onRailClick("sidebar-expand", function () { setSidebarOpen(true); });');
  });

  it('keeps the collapsed sidebar rail inert outside its explicit expand control', () => {
    expect(mainJs).toContain(
      'onRailClick("sidebar-expand", function () { setSidebarOpen(true); });',
    );
    expect(mainJs).not.toContain('sidebarMiniEl.addEventListener("click"');
  });

  it('discovers canonical Git worktrees through a read-only native command', () => {
    expect(tauri).toMatch(/fn\s+git_worktrees\(root:\s*String\)\s*->\s*Result<Vec<GitWorktree>/);
    expect(tauri).toMatch(/"worktree",\s*"list",\s*"--porcelain"/);
    expect(tauri).toMatch(/\n\s*git_worktrees,/);
  });

  it('refreshes worktrees without replacing local presentation state', () => {
    expect(mainJs).toMatch(/function\s+refreshProjectWorktrees\(project\)/);
    expect(mainJs).toMatch(/invoke\("git_worktrees",\s*\{\s*root:\s*project\.root\s*\}\)/);
    expect(mainJs).toMatch(/project\.worktrees\s*=\s*mergeWorktreePresentationState\(/);
  });

  it('ships workspace v2 enabled with an environment rollback switch', () => {
    expect(tauri).toMatch(/native_workspace_v2:\s*bool/);
    expect(tauri).toMatch(/feature_flag_enabled\("PSYCHE_NATIVE_WORKSPACE_V2",\s*true\)/);
    expect(mainJs).toMatch(/state\.env\.native_workspace_v2\s*===\s*false/);
    expect(mainJs).toMatch(/assignSelectedWorktreePath\(project,\s*project\.root\)/);
  });

  it('renders project, worktree, then pane rows and scopes new panes to selection', () => {
    expect(mainJs).toMatch(/session-project/);
    expect(mainJs).toMatch(/session-branch/);
    expect(mainJs).toMatch(/PsycheSessions\.buildSidebarProjectModel/);
    expect(sessionModel).toMatch(/session\?\.worktreePath/);
    expect(sessionModel).toMatch(/owningWorktree\(worktrees, cwd\)/);
    expect(mainJs).toMatch(/function\s+selectedWorktree\(project\)/);
    expect(mainJs).toMatch(/projectRoot:\s*project\s*&&\s*project\.root/);
    expect(mainJs).toMatch(/cwd:\s*worktree\s*&&\s*worktree\.path/);
    expect(styles).toMatch(/\.session-worktree-head\s*\{/);
    expect(styles).toMatch(/\.session-worktree-group\s*\{/);
  });

  it('builds the sessions tree through reusable DOM helpers', () => {
    for (const helper of [
      'attachTooltip',
      'createDisclosure',
      'createStatusIndicator',
      'createCategoryLabel',
      'createSessionRow',
      'createBranchGroup',
      'createProjectGroup',
    ]) {
      expect(mainJs).toContain(`function ${helper}(`);
    }
    const renderer = functionSource(mainJs, 'renderSessionList');
    expect(renderer).toContain('projectParts.disclosure.addEventListener("click"');
    expect(renderer).toContain('branchParts.disclosure.addEventListener("click"');
    expect(renderer).toContain('saveWorkspaceSoon();');
    expect(renderer).toContain('settings.selectedSessionKey = rowModel.selectionKey;');
    expect(renderer).toContain('saveSettings();');
  });

  it('scopes browser tabs to the selected worktree and migrates project browser state', () => {
    expect(mainJs).toMatch(/browsersByWorktree/);
    expect(mainJs).toMatch(/ensureBrowserModel\(project,\s*workspaceRoot\)/);
    expect(mainJs).toMatch(/workspaceRoot\s*\|\|\s*activeWorkspaceRoot\(project\)/);
    expect(mainJs).toMatch(/saved\.browsersByWorktree/);
    expect(mainJs).toMatch(/saved\.browser/);

    const activateWorktree = functionSource(mainJs, 'activateProjectWorktree');
    const selection = activateWorktree.indexOf(
      'assignSelectedWorktreePath(project, worktreePath);',
    );
    expect(selection).toBeGreaterThan(-1);
    for (const sync of [
      'renderPaneWorkspace({ preserveTerminalFocus: false });',
      'renderGitSurface();',
      'refreshSidebar();',
      'syncProjectBrowser();',
      'saveWorkspaceSoon();',
    ]) {
      expect(activateWorktree.indexOf(sync)).toBeGreaterThan(selection);
    }

    const renderSessionList = functionSource(mainJs, 'renderSessionList');
    const clickStart = renderSessionList.indexOf('branchParts.group.addEventListener("click"');
    const clickEnd = renderSessionList.indexOf('branchParts.group.addEventListener("dblclick"');
    expect(renderSessionList.slice(clickStart, clickEnd)).toContain(
      'await activateProjectWorktree(project, worktree.path)',
    );

    const contextMenuStart = renderSessionList.indexOf(
      'branchParts.head.addEventListener("contextmenu"',
    );
    const contextMenuEnd = renderSessionList.indexOf(
      'if (branchModel.expanded) {',
    );
    const worktreeContextMenu = renderSessionList.slice(contextMenuStart, contextMenuEnd);
    expect(worktreeContextMenu).toContain('label: "Open Coven CLI"');
    expect(worktreeContextMenu).toContain(
      'await activateProjectWorktree(project, worktree.path)',
    );
  });

  it('supports keyboard traversal, collapse controls, and attention badges', () => {
    for (const helper of [
      'visibleSessionTreeItems',
      'focusSessionTreeItem',
      'parentSessionTreeItem',
      'firstChildSessionTreeItem',
      'toggleSessionTreeDisclosure',
      'activateSessionTreeItem',
      'handleSessionTreeKeydown',
    ]) {
      expect(mainJs).toContain(`function ${helper}(`);
    }
    expect(mainJs).toContain('sessionListEl.addEventListener("keydown", handleSessionTreeKeydown)');
    expect(mainJs).toContain('event.key === "ArrowDown"');
    expect(mainJs).toContain('event.key === "ArrowUp"');
    expect(mainJs).toContain('event.key === "Home"');
    expect(mainJs).toContain('event.key === "End"');
    expect(mainJs).toContain('event.key === "ArrowLeft"');
    expect(mainJs).toContain('event.key === "ArrowRight"');
    expect(mainJs).toContain('event.key === "Enter"');
    expect(mainJs).toContain('event.key === " "');
    expect(mainJs).toContain('event.key === "Escape"');
    expect(mainJs).toContain('"[data-tree-item]"');
    expect(mainJs).not.toContain('"[data-tree-item], .session-close"');
    expect(mainJs).toContain('row.setAttribute("aria-keyshortcuts", "Delete")');
    expect(mainJs).toContain('close.setAttribute("tabindex", "-1")');
    expect(mainJs).toContain('if (event.key !== "Delete") return;');
    expect(mainJs).toContain('armLocalClose();');
    expect(mainJs).not.toContain('dismissLocalRow');
    expect(mainJs).toContain('if (index === -1) return;');
    expect(mainJs).toContain('session-attention-badge');
    expect(styles).toMatch(/\.session-attention-badge\s*\{/);

    const closeRule = styles.match(/\.session-close\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(closeRule).toMatch(/opacity:\s*1;/);
    expect(styles).not.toMatch(
      /\.session-row-wrap:(?:hover|focus-within)\s+\.session-close[^}]*opacity:/,
    );
    expect(styles).not.toMatch(/\.session-close:focus-visible\s*\{[^}]*opacity:/);

    const renderSessionList = functionSource(mainJs, 'renderSessionList');
    expect(renderSessionList).toContain('function armLocalClose()');
    expect(renderSessionList).toContain('armSessionClose(');
    expect(renderSessionList).toContain('"inspected Coven recovery for " + thread.name');
    expect(renderSessionList).toContain('return requestThreadClose(thread);');
    expect(renderSessionList).toContain('return resolveCovenLaunchRecovery(thread);');
    expect(renderSessionList).toContain('resolvesCovenRecovery ? "Resolve" : "Close"');
    expect(renderSessionList).toContain('localSessionContextActions(');
    expect(renderSessionList).toContain('hide: function () { hideThread(thread.id); }');
  });

  it('wires persisted sidebar filters and summaries without the removed search chrome', () => {
    const renderSessionList = functionSource(mainJs, 'renderSessionList');

    expect(indexHtml).not.toContain('session-search');
    expect(mainJs).not.toContain('var sessionSearchEl');
    expect(mainJs).not.toContain('var sessionFilter');
    expect(mainJs).not.toContain('var sessionSearchRestoreKey');
    expect(mainJs).not.toContain('sessionSearchEl.addEventListener');
    expect(mainJs).not.toContain('sessionSearchEl.focus()');
    expect(mainJs).not.toContain('sessionSearchEl.select()');
    expect(mainJs).not.toMatch(/\bsidebarTab\b/);
    expect(mainJs).toContain('var sidebarView = "sessions";');
    expect(mainJs).toContain('function setSidebarView(name)');
    expect(mainJs).toContain('var sessionTypeFilter = settings.sessionFilter;');
    expect(mainJs).toContain('function setSessionTypeFilter(value, options)');
    expect(mainJs).toContain('settings.sessionFilter = sessionTypeFilter;');
    expect(mainJs).toContain('setSidebarView("sessions");');
    expect(mainJs).toContain('setSessionTypeFilter(settings.sessionFilter, { persist: false });');
    expect(mainJs).toContain('Reset filter');
    expect(mainJs).not.toContain('Clear search');
    expect(mainJs).not.toContain('settings.sessionSearch');
    expect(renderSessionList).toContain('var currentSearchQuery = "";');
    expect(renderSessionList).not.toContain('var needle =');
    expect(renderSessionList).toContain('sessionTypeFilter !== "all"');
    expect(renderSessionList).toContain('"No sessions match the " + sessionTypeFilter + " filter."');
    expect(styles).toMatch(/\.session-filter\.is-active\s*\{/);
  });

  it('validates sidebar settings and persists collapsed project state', () => {
    const loadSettingsSource = functionSource(mainJs, 'loadSettings');
    const saveSettingsSource = functionSource(mainJs, 'saveSettings');
    const persistableProjectSource = functionSource(mainJs, 'persistableProject');
    const sanitizeSavedProjectSource = functionSource(mainJs, 'sanitizeSavedProject');
    const mergeRestoredProjectSource = functionSource(mainJs, 'mergeRestoredProject');

    expect(loadSettingsSource).not.toContain('sidebarTab');
    expect(loadSettingsSource).toMatch(/sessionFilter:\s*"all"/);
    expect(loadSettingsSource).toMatch(/selectedSessionKey:\s*""/);
    expect(loadSettingsSource).toContain('PsycheSessions.normalizeSidebarFilter(saved.sessionFilter)');
    expect(loadSettingsSource).toMatch(
      /selectedSessionKey:\s*typeof saved\.selectedSessionKey\s*===\s*"string"\s*\?\s*saved\.selectedSessionKey\.slice\(0,\s*1024\)\s*:\s*""/,
    );

    expect(saveSettingsSource).not.toContain('sidebarTab');
    expect(saveSettingsSource).toContain(
      'settings.sessionFilter = PsycheSessions.normalizeSidebarFilter(settings.sessionFilter)',
    );
    expect(saveSettingsSource).toMatch(
      /settings\.selectedSessionKey\s*=\s*typeof settings\.selectedSessionKey\s*===\s*"string"\s*\?\s*settings\.selectedSessionKey\.slice\(0,\s*1024\)\s*:\s*""/,
    );

    expect(persistableProjectSource).toContain('collapsed: !!project.collapsed');
    expect(sanitizeSavedProjectSource).toContain('collapsed: saved.collapsed === true');
    expect(mergeRestoredProjectSource).toMatch(
      /if\s*\(preferIncoming\)\s*\{[\s\S]*target\.collapsed\s*=\s*incoming\.collapsed;/,
    );
  });

  it('offers reversible session context actions and labels destructive close explicitly', () => {
    expect(mainJs).toMatch(/function\s+hideThread\(id\)/);
    expect(mainJs).toMatch(/function\s+reopenThreads\(projectId,\s*worktreePath\)/);
    expect(mainJs).toMatch(/function\s+duplicateThread\(thread\)/);
    expect(mainJs).toMatch(/row\.addEventListener\("contextmenu"/);
    expect(mainJs).toContain('label: "Hide"');
    expect(mainJs).toContain('label: "Interrupt"');
    expect(mainJs).toContain('label: "Stop and close"');
    expect(mainJs).toContain('label: "Open Coven CLI"');
    expect(mainJs).toContain('" hidden session"');
    expect(styles).toMatch(/\.session-context-menu\s*\{/);
    expect(styles).toMatch(/\.session-context-item\.danger\s*\{/);
  });
});
