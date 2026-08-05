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
});
