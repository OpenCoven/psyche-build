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

  it('leaves the dock with git alone, files on the left and the browser in its own column', () => {
    expect(indexHtml).toContain('data-panel-btn="git"');
    // The browser is a column between the canvas and the dock, toggled rather
    // than switched to, so it is no longer a dock panel.
    expect(indexHtml).not.toContain('data-panel-btn="browser"');
    expect(indexHtml).toContain('data-browser-column-toggle');
    expect(indexHtml).toContain('id="browser-column"');
    const column = indexHtml.slice(indexHtml.indexOf('id="browser-column"'));
    expect(column.slice(0, column.indexOf('</section>'))).toContain('class="panel panel-browser"');
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
      'esbuild web/editor/editor-entry.js --bundle --minify --format=iife --global-name=PsycheCodeEditor --outfile=web/editor.bundle.js && esbuild web/sessions/session-entry.js --bundle --minify --format=iife --global-name=PsycheSessions --outfile=web/sessions.bundle.js && esbuild web/panes/pane-entry.js --bundle --minify --format=iife --global-name=PsychePanes --outfile=web/panes.bundle.js && esbuild web/diffs/diff-entry.js --bundle --minify --format=iife --global-name=PsycheDiffs --outfile=web/diffs.bundle.js'
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

  describe('browser band', () => {
    it('spans the top of the workbench instead of sitting in a column', () => {
      expect(indexHtml).toContain('<section class="browser-band" id="browser-column"');
      // Row 1, every column: the band is centred on the workbench by covering
      // it, so the canvas and the tools dock both sit underneath.
      expect(stylesCss).toMatch(
        /\.detail\[data-layout="split"\] \.browser-band\s*\{\s*grid-column: 1 \/ -1; grid-row: 1;/
      );
      expect(stylesCss).toMatch(/grid-template-rows: var\(--browser-band\) minmax\(var\(--terminal-min-y\), 1fr\);/);
    });

    it('has one home, so nothing is left that could move it to another edge', () => {
      expect(stylesCss).not.toContain('data-browser-side');
      expect(mainJs).not.toContain('BROWSER_SIDES');
      expect(mainJs).not.toContain('cycleBrowserSide');
    });

    it('resizes from its lower edge only, in pixels', () => {
      expect(indexHtml).toContain('id="browser-band-resize"');
      expect(stylesCss).toMatch(/\.browser-band-resize\s*\{[^}]*cursor: row-resize;/s);
      expect(mainJs).toMatch(/function setBandHeight\(px\)[\s\S]*--browser-band/);
      // Bounds have to follow, or the native child webview keeps the old rect.
      expect(mainJs).toMatch(/function setBandHeight\(px\)[\s\S]*syncBrowserBounds\(\)/);
    });

    it('is no longer one of the panels the dock switches between', () => {
      expect(stylesCss).not.toMatch(/\.detail\[data-panel="browser"\] \.panel-browser/);
      expect(stylesCss).toMatch(/\.browser-band \.panel-browser\s*\{[^}]*display: grid;/s);
      // The band is a flex column; without a flex basis the preview is 0-high.
      expect(stylesCss).toMatch(/\.browser-band \.panel-browser\s*\{[^}]*flex: 1 1 auto;[^}]*min-height: 0;/s);
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
});
