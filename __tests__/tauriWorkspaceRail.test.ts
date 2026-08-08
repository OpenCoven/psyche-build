import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
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
    expect(mainJs).toMatch(/session-worktree-group/);
    expect(mainJs).toMatch(/session-worktree-head/);
    expect(mainJs).toMatch(/PsycheSessions\.buildProjectRailModel/);
    expect(sessionModel).toMatch(/session\?\.worktreePath/);
    expect(sessionModel).toMatch(/owningWorktree\(worktrees, cwd\)/);
    expect(mainJs).toMatch(/function\s+selectedWorktree\(project\)/);
    expect(mainJs).toMatch(/projectRoot:\s*worktree\.path/);
    expect(styles).toMatch(/\.session-worktree-head\s*\{/);
    expect(styles).toMatch(/\.session-worktree-group\s*\{/);
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
      'renderPanel(currentPanel());',
      'refreshSidebar();',
      'syncProjectBrowser();',
      'saveWorkspaceSoon();',
    ]) {
      expect(activateWorktree.indexOf(sync)).toBeGreaterThan(selection);
    }

    const renderSessionList = functionSource(mainJs, 'renderSessionList');
    const clickStart = renderSessionList.indexOf('worktreeHead.addEventListener("click"');
    const clickEnd = renderSessionList.indexOf('worktreeHead.addEventListener("dblclick"');
    expect(renderSessionList.slice(clickStart, clickEnd)).toContain(
      'await activateProjectWorktree(project, worktree.path)',
    );

    const contextMenuStart = renderSessionList.indexOf(
      'worktreeHead.addEventListener("contextmenu"',
    );
    const contextMenuEnd = renderSessionList.indexOf(
      'worktreeGroup.appendChild(worktreeHead);',
    );
    const worktreeContextMenu = renderSessionList.slice(contextMenuStart, contextMenuEnd);
    expect(worktreeContextMenu).toContain('label: "Open Psyche Terminal"');
    expect(worktreeContextMenu).toContain(
      'await activateProjectWorktree(project, worktree.path)',
    );
  });

  it('supports keyboard traversal, collapse controls, and attention badges', () => {
    expect(mainJs).toMatch(/sessionListEl\.addEventListener\("keydown"/);
    expect(mainJs).toMatch(/"ArrowDown",\s*"ArrowUp",\s*"Home",\s*"End"/);
    expect(mainJs).toMatch(/event\.key\s*!==\s*"ArrowLeft"[\s\S]*event\.key\s*!==\s*"ArrowRight"/);
    expect(mainJs).toContain('session-attention-badge');
    expect(styles).toMatch(/\.session-attention-badge\s*\{/);
  });

  it('offers reversible session context actions and labels destructive close explicitly', () => {
    expect(mainJs).toMatch(/function\s+hideThread\(id\)/);
    expect(mainJs).toMatch(/function\s+reopenThreads\(projectId,\s*worktreePath\)/);
    expect(mainJs).toMatch(/function\s+duplicateThread\(thread\)/);
    expect(mainJs).toMatch(/row\.addEventListener\("contextmenu"/);
    expect(mainJs).toContain('label: "Hide"');
    expect(mainJs).toContain('label: "Interrupt"');
    expect(mainJs).toContain('label: "Stop and close"');
    expect(mainJs).toContain('label: "Open Psyche Terminal"');
    expect(mainJs).toContain('" hidden session"');
    expect(styles).toMatch(/\.session-context-menu\s*\{/);
    expect(styles).toMatch(/\.session-context-item\.danger\s*\{/);
  });
});
