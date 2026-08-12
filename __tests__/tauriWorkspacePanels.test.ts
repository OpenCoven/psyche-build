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

function idCount(id: string): number {
  return indexHtml.match(new RegExp(`id="${id}"`, 'g'))?.length ?? 0;
}

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

describe('Tauri workspace panels', () => {
  it('keeps every composer control inside one canonical footer', () => {
    for (const id of [
      'composer',
      'composer-mic',
      'composer-call',
      'composer-send',
      'scope-menu',
      'scope-desc-pane',
      'scope-desc-project',
      'scope-desc-agents',
      'call-bar',
      'call-target',
      'call-note',
      'call-timer',
      'call-mute',
      'call-end',
      'palette',
    ]) {
      expect(idCount(id), `${id} should occur exactly once`).toBe(1);
    }

    const composerStart = indexHtml.indexOf('<footer class="composer" id="composer">');
    const composerEnd = indexHtml.indexOf('</footer>', composerStart);
    const composer = indexHtml.slice(composerStart, composerEnd + '</footer>'.length);

    for (const id of [
      'composer-mic',
      'composer-call',
      'composer-send',
      'scope-menu',
      'call-bar',
      'palette',
    ]) {
      expect(composer).toContain(`id="${id}"`);
    }
  });

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
