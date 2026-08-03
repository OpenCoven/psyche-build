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
      /invoke\("fs_read_text",\s*\{\s*root:\s*project\.root,\s*path:\s*path\s*\}\)/
    );
    expect(tauriLib).toMatch(/fn\s+fs_list_dir\(root:\s*String,\s*path:\s*String\)/);
    expect(tauriLib).toMatch(/fn\s+fs_read_text\(root:\s*String,\s*path:\s*String\)/);
    expect(tauriLib).toMatch(/fn\s+resolve_project_path\(/);
    expect(tauriLib).toMatch(/fn\s+validate_git_relative_path\(/);
  });

  it('registers only read-only workspace commands', () => {
    for (const command of ['fs_list_dir', 'fs_read_text', 'git_status', 'git_diff', 'git_log']) {
      expect(tauriLib).toMatch(new RegExp(`\\n\\s*${command},`));
    }
    expect(tauriLib).not.toMatch(
      /#\[tauri::command\][\s\S]{0,80}fn\s+git_(?:add|commit|merge|push|reset|clean)\b/
    );
  });

  it('exposes the four right-rail panels', () => {
    for (const panel of ['browser', 'files', 'diffs', 'git']) {
      expect(indexHtml).toContain(`data-panel-btn="${panel}"`);
    }
  });

  it('pins a repository-local Tauri 2 CLI for native builds', () => {
    expect(tauriPackage.scripts.build).toBe('tauri build');
    expect(tauriPackage.scripts.dev).toBe('tauri dev');
    expect(tauriPackage.devDependencies['@tauri-apps/cli']).toMatch(/^2\./);
  });
});
