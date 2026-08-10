import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const indexHtml = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/index.html'),
  'utf8'
);
const mainJs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8'
);

const DICE_BROWSER_URL =
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1&pp=ygUJcmljayByb2xsoAcB0gcJCckLAYcqIYzv';

describe('Tauri browser dice shortcut', () => {
  it('adds the surprise button directly before open-external in the browser toolbar', () => {
    const browserBar = indexHtml.slice(
      indexHtml.indexOf('<header class="pane-header browser-bar">'),
      indexHtml.indexOf('</header>', indexHtml.indexOf('<header class="pane-header browser-bar">'))
    );

    expect(browserBar).toContain(
      '<button id="open-surprise" class="icon-btn ghost-btn" title="Open surprise in new tab" aria-label="Open surprise in new tab">'
    );
    expect(browserBar).toContain(
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
    );
    expect(browserBar.indexOf('id="open-surprise"')).toBeLessThan(browserBar.indexOf('id="open-external"'));
  });

  it('wires the fixed dice URL through openDiceBrowserTab and the click handler', () => {
    expect(mainJs).toContain(
      'var DICE_BROWSER_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1&pp=ygUJcmljayByb2xsoAcB0gcJCckLAYcqIYzv";'
    );
    expect(mainJs).toMatch(
      /async function openDiceBrowserTab\(\)\s*\{\s*var tab = await openBlankBrowserTab\(\);\s*if \(!tab\) return;\s*await navigateBrowser\(DICE_BROWSER_URL, \{ tabId: tab\.id \}\);\s*\}/
    );
    expect(mainJs).toContain(
      'document.getElementById("open-surprise").addEventListener("click", openDiceBrowserTab);'
    );
  });

  it('leaves open-surprise enabled even when the active browser tab is blank', () => {
    const controls = mainJs.match(/function updateBrowserControls\(\)\s*\{[\s\S]*?\n  \}/)?.[0];
    expect(controls).toBeTruthy();
    expect(controls).not.toContain('open-surprise');
  });
});
