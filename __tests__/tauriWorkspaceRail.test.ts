import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const indexHtml = readFileSync(join(root, 'native/macos/psyche-build-tauri/web/index.html'), 'utf8');
const mainJs = readFileSync(join(root, 'native/macos/psyche-build-tauri/web/main.js'), 'utf8');
const styles = readFileSync(join(root, 'native/macos/psyche-build-tauri/web/styles.css'), 'utf8');
const tauri = readFileSync(join(root, 'native/macos/psyche-build-tauri/src-tauri/src/lib.rs'), 'utf8');
const sessionModel = readFileSync(
  join(root, 'native/macos/psyche-build-tauri/web/sessions/session-model.mjs'),
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

describe('Tauri project/worktree/pane rail', () => {
  it('ships pinned sidebar controls and honest navigation semantics contracts', () => {
    expect(indexHtml).toContain('class="sidebar-controls"');
    expect(indexHtml).toContain('class="session-search-wrap has-tooltip"');
    expect(indexHtml).toContain('<kbd class="session-search-key">/</kbd>');
    expect(indexHtml).not.toContain('session-filter-btn');

    const filterRowMatch = indexHtml.match(
      /<div class="session-filter-row" role="toolbar" aria-label="Filter sessions">([\s\S]*?)<\/div>\s*<div class="sr-only" id="session-status-legend">/,
    );
    expect(filterRowMatch).not.toBeNull();
    const filterRow = filterRowMatch?.[1] ?? '';
    expect(filterRow.match(/class="session-filter(?:\s|")/g)?.length).toBe(5);
    for (const filter of ['all', 'agents', 'shells', 'active', 'attention']) {
      expect(indexHtml).toContain(`data-session-filter="${filter}"`);
    }
    const attentionIndex = filterRow.indexOf('data-session-filter="attention"');
    const legendIndex = filterRow.indexOf('class="session-legend-button has-tooltip"');
    expect(attentionIndex).toBeGreaterThan(-1);
    expect(legendIndex).toBeGreaterThan(attentionIndex);
    expect(indexHtml).toContain('id="session-status-legend"');
    expect(indexHtml).toMatch(
      /<div class="session-filter-row" role="toolbar" aria-label="Filter sessions">[\s\S]*class="session-legend-button has-tooltip"[\s\S]*<\/div>\s*<div class="sr-only" id="session-status-legend">/,
    );
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
    expect(indexHtml).toMatch(/id="sidebar-collapse"[^>]*aria-label="Collapse sidebar"/);
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
    expect(mainJs).toMatch(/project\.selectedWorktreePath\s*=\s*project\.root/);
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
    const selection = activateWorktree.indexOf('project.selectedWorktreePath = worktreePath;');
    expect(selection).toBeGreaterThan(-1);
    for (const sync of [
      'renderPaneWorkspace();',
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
    expect(worktreeContextMenu).toContain('label: "Open Coven Terminal"');
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
    expect(mainJs).toContain('event.key === "/"');
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
    expect(renderSessionList).toContain(
      'armSessionClose(row, close, thread.name, function () {',
    );
    expect(renderSessionList).toContain('closeThread(thread.id);');
    expect(renderSessionList).toContain(
      '{ label: "Hide", run: function () { hideThread(thread.id); } },',
    );
  });

  it('wires visit-local search, persisted filters, summaries, and shortcut guidance', () => {
    expect(indexHtml).toMatch(/id="session-search"[^>]*aria-keyshortcuts="\/"/);
    expect(indexHtml).toContain('data-tooltip="Press / to search sessions"');
    expect(mainJs).toContain('var sidebarTab = settings.sidebarTab;');
    expect(mainJs).toContain('var sessionTypeFilter = settings.sessionFilter;');
    expect(mainJs).toContain('function setSessionTypeFilter(value, options)');
    expect(mainJs).toContain('settings.sessionFilter = sessionTypeFilter;');
    expect(mainJs).toContain('setSidebarTab(settings.sidebarTab, { persist: false });');
    expect(mainJs).toContain('setSessionTypeFilter(settings.sessionFilter, { persist: false });');
    expect(mainJs).toContain('PsycheSessions.matchTextRanges');
    expect(mainJs).toContain('session-result-summary');
    expect(mainJs).toContain('Clear search');
    expect(mainJs).toContain('Reset filter');
    expect(mainJs).not.toContain('settings.sessionSearch');
    expect(styles).toMatch(/\.session-filter\.is-active\s*\{/);
    expect(styles).toMatch(/\.session-search-key\s*\{/);
  });

  it('validates sidebar settings and persists collapsed project state', () => {
    const loadSettingsSource = functionSource(mainJs, 'loadSettings');
    const saveSettingsSource = functionSource(mainJs, 'saveSettings');
    const persistableProjectSource = functionSource(mainJs, 'persistableProject');
    const sanitizeSavedProjectSource = functionSource(mainJs, 'sanitizeSavedProject');
    const mergeRestoredProjectSource = functionSource(mainJs, 'mergeRestoredProject');

    expect(loadSettingsSource).toMatch(/sidebarTab:\s*"sessions"/);
    expect(loadSettingsSource).toMatch(/sessionFilter:\s*"all"/);
    expect(loadSettingsSource).toMatch(/selectedSessionKey:\s*""/);
    expect(loadSettingsSource).toMatch(
      /sidebarTab:\s*saved\.sidebarTab\s*===\s*"files"\s*\?\s*"files"\s*:\s*"sessions"/,
    );
    expect(loadSettingsSource).toContain('PsycheSessions.normalizeSidebarFilter(saved.sessionFilter)');
    expect(loadSettingsSource).toMatch(
      /selectedSessionKey:\s*typeof saved\.selectedSessionKey\s*===\s*"string"\s*\?\s*saved\.selectedSessionKey\.slice\(0,\s*1024\)\s*:\s*""/,
    );

    expect(saveSettingsSource).toMatch(
      /settings\.sidebarTab\s*=\s*settings\.sidebarTab\s*===\s*"files"\s*\?\s*"files"\s*:\s*"sessions"/,
    );
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
    expect(mainJs).toContain('label: "Open Coven Terminal"');
    expect(mainJs).toContain('" hidden session"');
    expect(styles).toMatch(/\.session-context-menu\s*\{/);
    expect(styles).toMatch(/\.session-context-item\.danger\s*\{/);
  });
});
