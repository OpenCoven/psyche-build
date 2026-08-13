import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const root = new URL('../native/desktop/psyche-build-tauri/', import.meta.url);
const main = readFileSync(new URL('web/main.js', root), 'utf8');
const html = readFileSync(new URL('web/index.html', root), 'utf8');
const packageJson = readFileSync(new URL('package.json', root), 'utf8');
const lib = readFileSync(new URL('src-tauri/src/lib.rs', root), 'utf8');

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  const asyncStart = source.indexOf(`async function ${name}(`);
  const index = asyncStart >= 0 ? asyncStart : start;
  if (index < 0) throw new Error(`missing ${name}`);
  const body = source.indexOf('{', index);
  let depth = 0;
  for (let cursor = body; cursor < source.length; cursor += 1) {
    if (source[cursor] === '{') depth += 1;
    if (source[cursor] === '}' && --depth === 0) return source.slice(index, cursor + 1);
  }
  throw new Error(`unterminated ${name}`);
}

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
    expect(lib).toContain('with_webview');
    expect(lib).toContain('takeSnapshotWithConfiguration_completionHandler');
    expect(lib).toContain('NSBitmapImageFileType::PNG');
    expect(lib).toContain('BASE64_STANDARD.encode');
    expect(lib).not.toContain('capture_desktop');
  });

  it('completes exact-tab generation mismatches immediately', async () => {
    const completions: unknown[] = [];
    const pair = { project: { root: '/project' }, tab: {} };
    const handler = Function(
      'browserControlPairByTabId', 'browserTabLifecycle', 'completeBrowserProviderEffect',
      'installBrowserAutomationForPair', 'awaitBrowserAutomationResult', 'invoke',
      'browserLabelForTab', 'browserAutomationDispatchScript',
      `return (${functionSource(main, 'handleBrowserProviderEffect')});`,
    )(
      () => pair,
      () => ({ liveGeneration: 2, nativeLabel: 'native' }),
      async (_project: unknown, result: unknown) => { completions.push(result); },
      async () => true, async () => ({}), async () => ({}), () => 'label', () => '',
    );

    await expect(handler({ payload: { actionId: 'a1', tabId: 'tab', projectRoot: '/project', generation: 1 } })).resolves.toBe(false);
    expect(completions).toEqual([{ actionId: 'a1', status: 'failed', code: 'resource_replaced', message: 'browser tab generation was replaced' }]);
  });

  it('serializes inspect and rejects a generation replaced during automation install', async () => {
    const completions: unknown[] = [];
    const pair = { project: { root: '/project' }, tab: {} };
    const lifecycle = { liveGeneration: 1, nativeLabel: 'native', navigationTail: null as Promise<void> | null };
    let finishInstall!: () => void;
    const installFlight = new Promise<void>((resolve) => { finishInstall = resolve; });
    const install = vi.fn(async () => installFlight);
    const dispatch = vi.fn(async () => ({}));
    const awaitResult = vi.fn(async () => ({ schema: 'psyche.browser.snapshot/v1' }));
    const handler = Function(
      'browserControlPairByTabId', 'browserTabLifecycle', 'completeBrowserProviderEffect',
      'installBrowserAutomationForPair', 'awaitBrowserAutomationResult', 'invoke',
      'browserLabelForTab', 'browserAutomationDispatchScript',
      `return (${functionSource(main, 'handleBrowserProviderEffect')});`,
    )(
      () => pair,
      () => lifecycle,
      async (_project: unknown, result: unknown) => { completions.push(result); },
      install, awaitResult, dispatch, () => 'label', () => 'dispatch-script',
    );

    const effectFlight = handler({
      payload: {
        actionId: 'a2', tabId: 'tab', projectRoot: '/project', generation: 1,
        operation: { kind: 'inspect' },
      },
    });
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    expect(lifecycle.navigationTail).toBeInstanceOf(Promise);

    lifecycle.liveGeneration = 2;
    finishInstall();

    await expect(effectFlight).resolves.toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(awaitResult).not.toHaveBeenCalled();
    expect(completions).toEqual([{
      actionId: 'a2', status: 'failed', code: 'resource_replaced',
      message: 'browser tab generation was replaced',
    }]);
  });
});
