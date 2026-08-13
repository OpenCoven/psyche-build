import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../native/desktop/psyche-build-tauri/', import.meta.url);
const main = readFileSync(new URL('web/main.js', root), 'utf8');
const html = readFileSync(new URL('web/index.html', root), 'utf8');
const packageJson = readFileSync(new URL('package.json', root), 'utf8');
const lib = readFileSync(new URL('src-tauri/src/lib.rs', root), 'utf8');

describe('Tauri semantic browser provider lifecycle', () => {
  it('builds and loads the committed PsycheControl bundle', () => {
    expect(packageJson).toContain('--global-name=PsycheControl');
    expect(packageJson).toContain('--outfile=web/control.bundle.js');
    expect(html).toContain('<script src="./control.bundle.js" defer></script>');
  });

  it('injects semantic automation after a finished page load through browser_eval', () => {
    expect(main).toMatch(/handleBrowserPageLoad[\s\S]*phase === "finished"[\s\S]*installBrowserAutomationForPair/);
    expect(main).toMatch(/installBrowserAutomationForPair[\s\S]*invoke\("browser_eval"/);
    expect(main).toContain('PsycheControl.browserAutomationSource()');
    expect(main).toContain('invalidateBrowserAutomation');
  });

  it('publishes exact typed tab resources and correlates inspect results', () => {
    expect(main).toContain('control_provider_start');
    expect(main).toContain('control_provider_upsert');
    expect(main).toContain('control_provider_remove');
    expect(main).toContain('control:provider-effect-request');
    expect(main).toContain('browser:automation-result');
    expect(main).toContain('control_provider_complete');
    expect(main).toContain('browserControlPairByTabId(effect.tabId, effect.projectRoot)');
    expect(main).toMatch(/tabId[\s\S]*generation[\s\S]*nativeLabel[\s\S]*worktreeRoot/);
    expect(main).not.toMatch(/currentBrowserTab\([^)]*\)[\s\S]{0,300}provider-effect-request/);
  });

  it('exposes only an exact-child bounded native screenshot command', () => {
    expect(lib).toContain('fn browser_snapshot(');
    expect(lib).toContain('MAX_BROWSER_SNAPSHOT_BYTES');
    expect(lib).toContain('backend_unavailable');
    expect(lib).toContain('get_webview(&label)');
    expect(lib).not.toContain('capture_desktop');
  });
});
