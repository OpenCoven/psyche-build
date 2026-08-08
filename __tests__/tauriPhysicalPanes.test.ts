import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const mainJs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);
const stylesCss = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/styles.css'),
  'utf8',
);

function functionSource(name: string) {
  const asyncStart = mainJs.indexOf(`async function ${name}(`);
  const syncStart = mainJs.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = mainJs.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainJs.length; index += 1) {
    if (mainJs[index] === '{') depth += 1;
    if (mainJs[index] === '}') depth -= 1;
    if (depth === 0) return mainJs.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

describe('Tauri physical terminal panes', () => {
  it('keeps pane topology process-local and keys it by project and worktree', () => {
    expect(mainJs).toMatch(/var paneLayouts = new Map\(\);/);
    expect(mainJs).toMatch(/var paneCounter = 0;/);
    expect(mainJs).toMatch(/var PANE_MINIMUMS = \{ width: 320, height: 120, separator: 6 \};/);
    expect(functionSource('paneLayoutKey')).toMatch(/projectId[\s\S]*worktreePath/);
    expect(functionSource('preparePanePlacement')).toMatch(/PsychePanes\.createLeaf/);
    expect(functionSource('preparePanePlacement')).toMatch(/PsychePanes\.insertBelow/);
    expect(functionSource('preparePanePlacement')).toMatch(/PsychePanes\.canFit/);
    expect(functionSource('detachThreadPane')).toMatch(/PsychePanes\.removeLeaf/);
    expect(functionSource('persistableProject')).not.toMatch(/paneLayouts|paneLeafId/);
    expect(mainJs).not.toMatch(/paneLeafId/);
  });

  it('reserves geometry before mutating the thread list', () => {
    const createThread = functionSource('createThread');
    expect(createThread).toMatch(/opts\.worktreePath \|\| opts\.projectRoot \|\|\s*\(project && activeWorkspaceRoot\(project\)\)/);
    expect(createThread.indexOf('preparePanePlacement(')).toBeGreaterThan(-1);
    expect(createThread.indexOf('preparePanePlacement(')).toBeLessThan(
      createThread.indexOf('state.threads.push(thread)'),
    );
    expect(createThread).toMatch(/Not enough space for another terminal pane/);
    expect(createThread).toMatch(/commitPanePlacement\(placement\)[\s\S]*state\.threads\.push\(thread\)/);
  });

  it('mounts each xterm in a persistent labelled pane shell', () => {
    const mountTerminal = functionSource('mountTerminal');
    expect(mountTerminal).toMatch(/className = "terminal-pane"/);
    expect(mountTerminal).toMatch(/pane\.dataset\.threadId = thread\.id/);
    expect(mountTerminal).toMatch(/className = "terminal-pane-header"/);
    expect(mountTerminal).toMatch(/className = "terminal-pane-body"/);
    expect(mountTerminal).toMatch(/className = "term-instance"/);
    expect(mountTerminal).toMatch(/title = "Stop and close terminal"/);
    expect(mountTerminal).toMatch(/"Stop and close " \+ thread\.name/);
    expect(mountTerminal).toMatch(/thread\.pane = pane[\s\S]*thread\.host = container[\s\S]*renderPaneWorkspace\(\)/);
    expect(mountTerminal).not.toMatch(/terminalHost\.appendChild\(container\)/);
  });

  it('projects pane-tree layout ratios into a simultaneous DOM tree', () => {
    expect(functionSource('renderPaneNode')).toMatch(/terminal-pane-split/);
    expect(functionSource('renderPaneNode')).toMatch(/terminal-pane-branch/);
    expect(functionSource('renderPaneNode')).toMatch(/createPaneDivider\(node, ratio\)/);
    expect(functionSource('renderPaneWorkspace')).toMatch(/PsychePanes\.layoutRects/);
    expect(functionSource('renderPaneWorkspace')).toMatch(/split\.ratio/);
    expect(functionSource('renderPaneWorkspace')).toMatch(/scheduleVisiblePaneFit\(\)/);
    expect(stylesCss).not.toMatch(/\.term-instance\.active\s*\{\s*visibility:\s*visible/);
    expect(stylesCss).toMatch(/\.terminal-pane\.focused/);
    expect(stylesCss).toMatch(/\.terminal-pane-body/);
  });

  it('renders file tabs without depending on terminal thread visibility', () => {
    expect(functionSource('refreshTabs')).not.toMatch(/activeProjectThreads/);
  });
});
