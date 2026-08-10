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

describe('Tauri workspace panels', () => {
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

  it('exposes the three right-rail panels, with diffs folded into git', () => {
    for (const panel of ['browser', 'files', 'git']) {
      expect(indexHtml).toContain(`data-panel-btn="${panel}"`);
    }
    // Diffs is no longer a tab of its own...
    expect(indexHtml).not.toContain('data-panel-btn="diffs"');
    // ...but its markup still exists, inside the git panel, with the element
    // ids the diff renderer writes into.
    const gitPanel = indexHtml.slice(indexHtml.indexOf('class="panel panel-git"'));
    for (const id of ['git-view', 'diffs-summary', 'diffs-refresh', 'diff-files', 'diff-editor-host']) {
      expect(gitPanel).toContain(`id="${id}"`);
    }
  });

  it('pins a repository-local Tauri 2 CLI for native builds', () => {
    expect(tauriPackage.scripts['build:web']).toBe(
      'esbuild web/editor/editor-entry.js --bundle --minify --format=iife --global-name=PsycheCodeEditor --outfile=web/editor.bundle.js && esbuild web/sessions/session-entry.js --bundle --minify --format=iife --global-name=PsycheSessions --outfile=web/sessions.bundle.js && esbuild web/panes/pane-entry.js --bundle --minify --format=iife --global-name=PsychePanes --outfile=web/panes.bundle.js && esbuild web/workspace/workspace-entry.js --bundle --minify --format=iife --global-name=PsycheWorkspace --outfile=web/workspace.bundle.js'
    );
    expect(tauriPackage.scripts.build).toBe('pnpm build:web && tauri build');
    expect(tauriPackage.scripts.dev).toBe('pnpm build:web && tauri dev');
    expect(tauriPackage.devDependencies['@tauri-apps/cli']).toMatch(/^2\./);
  });

  it('loads the Coven session bundle between the editor and application scripts', () => {
    const editorScript = '<script src="./editor.bundle.js" defer></script>';
    const sessionsScript = '<script src="./sessions.bundle.js" defer></script>';
    const panesScript = '<script src="./panes.bundle.js" defer></script>';
    const mainScript = '<script src="./main.js" defer></script>';

    expect(indexHtml).toContain(editorScript);
    expect(indexHtml).toContain(sessionsScript);
    expect(indexHtml).toContain(panesScript);
    expect(indexHtml).toContain(mainScript);
    expect(indexHtml.indexOf(editorScript)).toBeLessThan(indexHtml.indexOf(sessionsScript));
    expect(indexHtml.indexOf(sessionsScript)).toBeLessThan(indexHtml.indexOf(panesScript));
    expect(indexHtml.indexOf(panesScript)).toBeLessThan(indexHtml.indexOf(mainScript));
    expect(sessionsBundle.length).toBeGreaterThan(0);
    expect(sessionsBundle).toContain('PsycheSessions');
    expect(panesBundle.length).toBeGreaterThan(0);
    expect(panesBundle).toContain('PsychePanes');
  });
});
