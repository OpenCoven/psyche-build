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
  it('strictly projects untrusted page snapshots into provider-owned canonical snapshots', () => {
    const canonicalize = Function(`return (${functionSource(main, 'canonicalizeBrowserSemanticSnapshot')});`)();
    const pair = {
      tab: { id: 'tab-1', title: 'Trusted title', loading: false },
      project: {}, browser: {}, worktreePath: '/worktree',
    };
    const page = {
      schema: 'psyche.browser.snapshot/v1', snapshotId: 'page-id', url: 'https://evil.invalid',
      viewport: { width: 800, height: 600 }, truncated: false,
      nodes: [{ ref: 'e1', role: 'button', name: 'Save', bounds: { x: 1, y: 2, width: 3, height: 4, clipped: false } }],
    };
    const snapshot = canonicalize(page, pair, { actionId: 'trusted-id', generation: 7 }, 1_000);
    expect(snapshot).toMatchObject({
      schema: 'psyche.browser.snapshot/v1', id: 'trusted-id', tabId: 'tab-1', generation: 7,
      title: 'Trusted title', loading: false, capturedAt: new Date(1_000).toISOString(),
      expiresAt: new Date(31_000).toISOString(), opaqueFrames: 0,
    });
    expect(snapshot).not.toHaveProperty('snapshotId');
    expect(snapshot.nodes[0]).toEqual({
      ref: 'e1', role: 'button', name: 'Save', bounds: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(() => canonicalize({ ...page, injected: 'secret' }, pair, { actionId: 'a', generation: 7 }, 1_000)).toThrow(/unknown field/);
    expect(() => canonicalize({ ...page, nodes: [{ ...page.nodes[0], injected: 'secret' }] }, pair, { actionId: 'a', generation: 7 }, 1_000)).toThrow(/unknown field/);
    expect(() => canonicalize({ ...page, nodes: Array.from({ length: 2_001 }, () => page.nodes[0]) }, pair, { actionId: 'a', generation: 7 }, 1_000)).toThrow(/maximum/);
  });

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

  it('installs the trusted automation source at document initialization and awaits Finished natively', () => {
    expect(lib).toContain('.initialization_script(automation_source)');
    expect(lib).toMatch(/async fn browser_navigate[\s\S]*oneshot::channel[\s\S]*Duration::from_secs\(30\)[\s\S]*receiver/);
    expect(lib).toContain('BROWSER_NAVIGATION_WAITERS');
    expect(lib).not.toContain('BROWSER_NAVIGATION_TOKENS');
    expect(lib).toContain('webview.close()');
    expect(lib).toContain('browser navigation timed out');
    expect(lib).toContain('loadRequest');
    expect(lib).toContain('navigation_identity');
    expect(lib).toContain('terminal_url');
    expect(lib).not.toContain('browser_urls_equivalent');
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
      'browserLabelForTab', 'browserAutomationDispatchScript', 'canonicalizeBrowserSemanticSnapshot',
      `return (${functionSource(main, 'handleBrowserProviderEffect')});`,
    )(
      () => pair,
      () => ({ liveGeneration: 2, nativeLabel: 'native' }),
      async (_project: unknown, result: unknown) => { completions.push(result); },
      async () => true, async () => ({}), async () => ({}), () => 'label', () => '', () => ({}),
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
      'browserLabelForTab', 'browserAutomationDispatchScript', 'canonicalizeBrowserSemanticSnapshot',
      `return (${functionSource(main, 'handleBrowserProviderEffect')});`,
    )(
      () => pair,
      () => lifecycle,
      async (_project: unknown, result: unknown) => { completions.push(result); },
      install, awaitResult, dispatch, () => 'label', () => 'dispatch-script', (value: unknown) => value,
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

  it('cancels eval waiters and reports timeouts as ambiguous unknown outcomes', async () => {
    vi.useFakeTimers();
    try {
      const waiters = new Map();
      const awaitResult = Function(
        'browserAutomationWaiters',
        `return (${functionSource(main, 'awaitBrowserAutomationResult')});`,
      )(waiters);
      const timedOut = awaitResult({ actionId: 'timeout', tabId: 'tab', generation: 1 });
      const rejection = expect(timedOut).rejects.toMatchObject({ code: 'effect_unknown', ambiguous: true });
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
      expect(waiters.size).toBe(0);

      const cancelled = awaitResult({ actionId: 'cancel', tabId: 'tab', generation: 1 });
      cancelled.cancel(new Error('eval rejected'));
      await expect(cancelled).rejects.toThrow('eval rejected');
      expect(waiters.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
