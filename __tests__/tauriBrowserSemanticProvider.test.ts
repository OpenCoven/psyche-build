import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { installBrowserAutomation } from '../native/desktop/psyche-build-tauri/web/control/browser-automation.mjs';

const root = new URL('../native/desktop/psyche-build-tauri/', import.meta.url);
const main = readFileSync(new URL('web/main.js', root), 'utf8');
const html = readFileSync(new URL('web/index.html', root), 'utf8');
const packageJson = readFileSync(new URL('package.json', root), 'utf8');
const lib = readFileSync(new URL('src-tauri/src/lib.rs', root), 'utf8');
const tauriBuild = readFileSync(new URL('src-tauri/build.rs', root), 'utf8');

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
    const canonicalize = Function(
      'browserAutomationSnapshotRefs',
      `return (${functionSource(main, 'canonicalizeBrowserSemanticSnapshot')});`,
    )(new Map());
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

  it('closes only a newly created blank view when native navigation setup fails', () => {
    expect(lib).toMatch(/if let Err\(error\) =\s*start_browser_navigation\(&webview,[\s\S]*?cleanup_created_browser_after_setup_failure\(created,[\s\S]*?webview\.close\(\)/);
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
      'browserProviderOperationPreflight', 'runBrowserLifecycleOperation',
      `return (${functionSource(main, 'handleBrowserProviderEffect')});`,
    )(
      () => pair,
      () => ({ liveGeneration: 2, nativeLabel: 'native' }),
      async (_project: unknown, result: unknown) => { completions.push(result); },
      async () => true, async () => ({}), async () => ({}), () => 'label', () => '', () => ({}),
      () => 'page', vi.fn(),
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
      'browserProviderOperationPreflight', 'runBrowserLifecycleOperation',
      `return (${functionSource(main, 'handleBrowserProviderEffect')});`,
    )(
      () => pair,
      () => lifecycle,
      async (_project: unknown, result: unknown) => { completions.push(result); },
      install, awaitResult, dispatch, () => 'label', () => 'dispatch-script', (value: unknown) => value,
      () => 'page', vi.fn(),
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

  it('destroys and quarantines a timed-out native script child at five seconds', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const completions: unknown[] = [];
      const snapshots = new Map([['snapshot', { tabId: 'tab', generation: 1 }]]);
      const pair = { project: { root: '/project' }, browser: {}, worktreePath: '/project', tab: { id: 'tab' } };
      const lifecycle: any = {
        liveGeneration: 1, controlGeneration: 1, pendingGeneration: 0,
        nativeLabel: 'native', navigationTail: null, automationSource: 'source',
      };
      const invoke = vi.fn(async (command: string) => { calls.push(command); return {}; });
      const remove = vi.fn(async () => { calls.push('remove'); return true; });
      const invalidateNavigation = vi.fn(() => { calls.push('invalidate-navigation'); });
      const quarantine = Function(
        'browserTabLifecycle', 'invalidateBrowserAutomation', 'removeBrowserControlResource',
        'browserAutomationSnapshotRefs', 'invalidateBrowserNavigation', 'invoke', 'browserLabelForTab',
        `return (${functionSource(main, 'quarantineBrowserAutomation')});`,
      )(
        () => lifecycle, async () => { calls.push('invalidate-page'); return true; }, remove,
        snapshots, invalidateNavigation, invoke, () => 'project:tab:1',
      );
      const dispatch = vi.fn(async (command: string) => {
        if (command !== 'browser_script') return {};
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        throw Object.assign(new Error('effect_unknown'), { code: 'effect_unknown' });
      });
      const normalizeScriptError = Function(
        `return (${functionSource(main, 'browserNativeScriptError')});`,
      )();
      const handler = Function(
        'browserControlPairByTabId', 'browserTabLifecycle', 'completeBrowserProviderEffect',
        'browserProviderOperationPreflight', 'runBrowserLifecycleOperation', 'installBrowserAutomationForPair',
        'awaitBrowserAutomationResult', 'invoke', 'browserLabelForTab', 'PsycheControl',
        'browserAutomationDispatchScript', 'canonicalizeBrowserSemanticSnapshot', 'canonicalizeBrowserScriptResult',
        'canonicalizeBrowserActionResult', 'quarantineBrowserAutomation', 'browserNativeScriptError',
        `return (${functionSource(main, 'handleBrowserProviderEffect')});`,
      )(
        () => pair, () => lifecycle,
        async (_project: unknown, result: unknown) => { completions.push(result); },
        () => 'page', vi.fn(), async () => true, vi.fn(),
        dispatch, () => 'project:tab:1', { browserAutomationSource: () => '' }, () => 'dispatch-script',
        vi.fn(), (value: unknown) => value, vi.fn(), quarantine, normalizeScriptError,
      );
      const flight = handler({ payload: {
        actionId: 'hung-script', tabId: 'tab', projectRoot: '/project', generation: 1,
        operation: { kind: 'script', source: 'while (true) {}' },
      } });
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(5_000);
      const completionCountAtFiveSeconds = completions.length;
      await vi.advanceTimersByTimeAsync(10_000);
      await flight;

      expect(completionCountAtFiveSeconds).toBe(1);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(invoke.mock.calls.filter(([command]) => command === 'browser_destroy')).toHaveLength(1);
      expect(remove).toHaveBeenCalledOnce();
      expect(snapshots.size).toBe(0);
      expect(lifecycle).toMatchObject({ liveGeneration: 0, controlGeneration: 0, nativeLabel: null });
      expect(completions).toEqual([expect.objectContaining({
        actionId: 'hung-script', status: 'unknown', code: 'effect_unknown',
      })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('quarantines a tab after ambiguous script execution and never reports deterministic failure', async () => {
    const completions: unknown[] = [];
    const pair = { project: { root: '/project' }, browser: {}, worktreePath: '/project', tab: {} };
    const lifecycle: { liveGeneration: number; controlGeneration: number; pendingGeneration: number; nativeLabel: string | null; navigationTail: null } = {
      liveGeneration: 1, controlGeneration: 1, pendingGeneration: 0, nativeLabel: 'native', navigationTail: null,
    };
    const quarantine = vi.fn(async () => {
      lifecycle.liveGeneration = 0;
      lifecycle.controlGeneration = 0;
      lifecycle.nativeLabel = null;
      return true;
    });
    const dispatch = vi.fn(async () => {
      throw Object.assign(new Error('script-source-secret result-secret'), { code: 'effect_unknown', ambiguous: true });
    });
    const normalizeScriptError = Function(
      `return (${functionSource(main, 'browserNativeScriptError')});`,
    )();
    const handler = Function(
      'browserControlPairByTabId', 'browserTabLifecycle', 'completeBrowserProviderEffect',
      'browserProviderOperationPreflight', 'runBrowserLifecycleOperation', 'installBrowserAutomationForPair',
      'awaitBrowserAutomationResult', 'invoke', 'browserLabelForTab', 'PsycheControl',
      'browserAutomationDispatchScript', 'canonicalizeBrowserSemanticSnapshot', 'canonicalizeBrowserScriptResult',
      'canonicalizeBrowserActionResult', 'quarantineBrowserAutomation', 'browserNativeScriptError',
      `return (${functionSource(main, 'handleBrowserProviderEffect')});`,
    )(
      () => pair, () => lifecycle,
      async (_project: unknown, result: unknown) => { completions.push(result); },
      () => 'page', vi.fn(), async () => true,
      vi.fn(),
      dispatch, () => 'label', { browserAutomationSource: () => '' }, () => 'dispatch-script',
      vi.fn(), vi.fn(), vi.fn(), quarantine, normalizeScriptError,
    );
    await handler({ payload: {
      actionId: 'script-timeout', tabId: 'tab', projectRoot: '/project', generation: 1,
      operation: { kind: 'script', source: 'await lateMutation()' },
    } });
    expect(quarantine).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(completions).toEqual([expect.objectContaining({
      actionId: 'script-timeout', status: 'unknown', code: 'effect_unknown',
    })]);
    expect(completions).not.toContainEqual(expect.objectContaining({ status: 'failed' }));
    expect(JSON.stringify(completions)).not.toContain('script-source-secret');
    expect(JSON.stringify(completions)).not.toContain('result-secret');
    expect(lifecycle).toMatchObject({ liveGeneration: 0, controlGeneration: 0, nativeLabel: null });
  });

  it('quarantines only ambiguous browser script outcomes', async () => {
    const completeBrowserProviderEffect = vi.fn(async (_project: unknown, _result: unknown) => true);
    const quarantineBrowserAutomation = vi.fn(async () => true);
    const pair = { project: { root: '/project' }, browser: {}, worktreePath: '/project', tab: {} };
    const lifecycle = { liveGeneration: 1, controlGeneration: 1, pendingGeneration: 0, nativeLabel: 'native', navigationTail: null };
    const failures = [
      Object.assign(new Error('mutation_not_allowed: secret'), { code: 'mutation_not_allowed' }),
      Object.assign(new Error('effect_unknown: secret'), { code: 'effect_unknown' }),
    ];
    const invoke = vi.fn(async (command: string) => {
      if (command === 'browser_script') throw failures.shift();
      return {};
    });
    const normalizeScriptError = Function(
      `return (${functionSource(main, 'browserNativeScriptError')});`,
    )();
    const handler = Function(
      'browserControlPairByTabId', 'browserTabLifecycle', 'completeBrowserProviderEffect',
      'browserProviderOperationPreflight', 'runBrowserLifecycleOperation', 'installBrowserAutomationForPair',
      'awaitBrowserAutomationResult', 'invoke', 'browserLabelForTab', 'PsycheControl',
      'browserAutomationDispatchScript', 'canonicalizeBrowserSemanticSnapshot', 'canonicalizeBrowserScriptResult',
      'canonicalizeBrowserActionResult', 'quarantineBrowserAutomation', 'browserNativeScriptError',
      `return (${functionSource(main, 'handleBrowserProviderEffect')});`,
    )(
      () => pair, () => lifecycle, completeBrowserProviderEffect,
      () => 'page', vi.fn(), async () => true, vi.fn(),
      invoke, () => 'label', { browserAutomationSource: () => '' }, () => 'dispatch-script',
      vi.fn(), vi.fn(), vi.fn(), quarantineBrowserAutomation, normalizeScriptError,
    );

    for (const actionId of ['deterministic', 'ambiguous']) {
      await handler({ payload: {
        actionId, tabId: 'tab', projectRoot: '/project', generation: 1,
        operation: { kind: 'script', source: 'return null;' },
      } });
    }

    expect(quarantineBrowserAutomation).toHaveBeenCalledTimes(1);
    expect(completeBrowserProviderEffect).toHaveBeenCalledTimes(2);
    expect(completeBrowserProviderEffect.mock.calls[0][1]).toMatchObject({ status: 'failed', code: 'mutation_not_allowed' });
    expect(completeBrowserProviderEffect.mock.calls[1][1]).toMatchObject({ status: 'unknown', code: 'effect_unknown' });
  });

  it.each([
    ['upload', { elementRef: 'e1', path: '/project/secret.txt' }],
    ['download', { elementRef: 'e1', destination: '/project/download.txt' }],
  ])('validates exact snapshot and ref before failing unsupported native %s without dispatch', async (kind, actionFields) => {
    const snapshotRefs = new Map([['canonical-1', {
      rawSnapshotId: 'raw-1', tabId: 'tab', generation: 1,
      expiresAt: Date.now() + 30_000, refs: new Set(['e1']),
    }]]);
    const invoke = vi.fn();
    const install = vi.fn();
    const completions: any[] = [];
    const pair = { project: { root: '/project' }, browser: {}, worktreePath: '/project', tab: {} };
    const lifecycle = { liveGeneration: 1, pendingGeneration: 0, nativeLabel: 'native', navigationTail: null };
    const resolveNativeTarget = Function(
      'browserAutomationSnapshotRefs',
      `return (${functionSource(main, 'resolveBrowserNativeElementTarget')});`,
    )(snapshotRefs);
    const preflight = Function(
      'resolveBrowserNativeElementTarget',
      `return (${functionSource(main, 'browserProviderOperationPreflight')});`,
    )(resolveNativeTarget);
    const handler = Function(
      'browserControlPairByTabId', 'state', 'browserControlProviders', 'browserTabLifecycle',
      'completeBrowserProviderEffect', 'browserProviderOperationPreflight', 'runBrowserLifecycleOperation',
      'installBrowserAutomationForPair', 'awaitBrowserAutomationResult', 'invoke', 'browserLabelForTab',
      'PsycheControl', 'browserAutomationDispatchScript', 'canonicalizeBrowserSemanticSnapshot',
      `return (${functionSource(main, 'handleBrowserProviderEffect')});`,
    )(
      () => pair, { projects: [] }, new Map(), () => lifecycle,
      async (_project: unknown, value: unknown) => { completions.push(value); }, preflight, vi.fn(),
      install, vi.fn(), invoke, vi.fn(), { browserAutomationSource: vi.fn() }, vi.fn(), vi.fn(),
    );

    for (const [snapshotId, elementRef, code] of [
      ['stale', 'e1', 'snapshot_stale'],
      ['canonical-1', 'missing', 'element_missing'],
      ['canonical-1', 'e1', 'backend_unavailable'],
    ]) {
      await handler({ payload: {
        actionId: `${kind}-${code}`, tabId: 'tab', projectRoot: '/project', generation: 1,
        operation: { kind: 'action', snapshotId, action: { kind, ...actionFields, elementRef } },
      } });
    }

    expect(completions.map((entry) => entry.code)).toEqual([
      'snapshot_stale', 'element_missing', 'backend_unavailable',
    ]);
    expect(invoke).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('/project/');
  });

  it('fails permission responses before page or native dispatch', async () => {
    const invoke = vi.fn();
    const install = vi.fn();
    const completions: any[] = [];
    const pair = { project: { root: '/project' }, browser: {}, worktreePath: '/project', tab: {} };
    const lifecycle = { liveGeneration: 1, pendingGeneration: 0, nativeLabel: 'native', navigationTail: null };
    const preflight = Function(
      'resolveBrowserNativeElementTarget',
      `return (${functionSource(main, 'browserProviderOperationPreflight')});`,
    )(vi.fn());
    const handler = Function(
      'browserControlPairByTabId', 'state', 'browserControlProviders', 'browserTabLifecycle',
      'completeBrowserProviderEffect', 'browserProviderOperationPreflight', 'runBrowserLifecycleOperation',
      'installBrowserAutomationForPair', 'awaitBrowserAutomationResult', 'invoke', 'browserLabelForTab',
      'PsycheControl', 'browserAutomationDispatchScript', 'canonicalizeBrowserSemanticSnapshot',
      `return (${functionSource(main, 'handleBrowserProviderEffect')});`,
    )(
      () => pair, { projects: [] }, new Map(), () => lifecycle,
      async (_project: unknown, value: unknown) => { completions.push(value); }, preflight, vi.fn(),
      install, vi.fn(), invoke, vi.fn(), { browserAutomationSource: vi.fn() }, vi.fn(), vi.fn(),
    );
    await handler({ payload: {
      actionId: 'permission', tabId: 'tab', projectRoot: '/project', generation: 1,
      operation: { kind: 'action', action: {
        kind: 'permission_response', permission: 'camera', origin: 'https://example.test', decision: 'deny',
      } },
    } });
    expect(completions).toEqual([expect.objectContaining({ code: 'backend_unavailable' })]);
    expect(invoke).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('strictly projects page action results without forwarding forged payloads', () => {
    const snapshots = new Map([['snap', {
      tabId: 'tab', generation: 1, expiresAt: Date.now() + 1_000,
      semantics: new Map([['e1', { secret: true }]]),
    }]]);
    const project = Function(
      'browserAutomationSnapshotRefs',
      `return (${functionSource(main, 'canonicalizeBrowserActionResult')});`,
    )(snapshots);
    const effect = { tabId: 'tab', generation: 1, operation: {
      kind: 'action', snapshotId: 'snap', action: { kind: 'type', elementRef: 'e1', text: 'agent-secret' },
    } };
    expect(project(effect, { valuePresent: true, secret: true })).toEqual({ valuePresent: true, secret: true });
    for (const forged of [
      { valuePresent: true, secret: true, leaked: 'page-secret' },
      { valuePresent: true, secret: 'page-secret' },
      Object.assign(Object.create({ leaked: 'page-secret' }), { valuePresent: true, secret: true }),
    ]) expect(() => project(effect, forged)).toThrowError(expect.objectContaining({ code: 'automation_failed' }));

    snapshots.set('scroll-snap', {
      tabId: 'tab', generation: 1, expiresAt: Date.now() + 1_000,
      semantics: new Map([['e2', { secret: false }]]),
    });
    const scrollEffect = { tabId: 'tab', generation: 1, operation: {
      kind: 'action', snapshotId: 'scroll-snap', action: { kind: 'scroll', elementRef: 'e2', deltaX: 1, deltaY: 2 },
    } };
    expect(project(scrollEffect, { scrolled: true })).toEqual({ scrolled: true });
    expect(() => project(scrollEffect, { scrolled: true, scrollLeft: 8675309 }))
      .toThrowError(expect.objectContaining({ code: 'automation_failed' }));

    snapshots.set('select-snap', {
      tabId: 'tab', generation: 1, expiresAt: Date.now() + 1_000,
      semantics: new Map([['e3', { secret: false }]]),
    });
    const selectEffect = { tabId: 'tab', generation: 1, operation: {
      kind: 'action', snapshotId: 'select-snap', action: { kind: 'select', elementRef: 'e3', values: ['missing-secret-value'] },
    } };
    expect(project(selectEffect, { selected: true })).toEqual({ selected: true });
    expect(JSON.stringify(project(selectEffect, { selected: true }))).not.toContain('missing-secret-value');
  });

  it('uses only the initialization-captured caller-bound automation receipt bridge', () => {
    const source = functionSource(main, 'browserAutomationDispatchScript');
    expect(source).toContain('__PSYCHE_AUTOMATION__.dispatchAndEmit');
    expect(source).not.toContain('__TAURI__');
    expect(source).not.toContain('.emit');
  });

  it('registers a caller-bound native automation result command without generic event authority', () => {
    expect(lib).toMatch(
      /#\[tauri::command\]\s*fn browser_automation_result\(\s*webview:\s*tauri::Webview,\s*authorizations:\s*State<'_, BrowserAutomationAuthorizations>,\s*result:\s*BrowserAutomationResultPayload,\s*\)\s*->\s*Result<\(\),\s*String>/,
    );
    const commandStart = lib.indexOf('fn browser_automation_result(');
    const commandEnd = lib.indexOf('\n}\n', commandStart);
    const command = lib.slice(commandStart, commandEnd);
    expect(command).toContain('webview.label()');
    expect(command).toContain('authorizations.consume(webview.label(), &result.correlation())');
    expect(command).toMatch(/\.emit_to\(\s*"main",\s*"browser:automation-result"/);
    expect(command).not.toMatch(/\bevent:\s*String/);
    expect(command).not.toMatch(/\blabel:\s*String/);
    expect(tauriBuild).toContain('"browser_automation_result"');
    expect(main).toMatch(/invoke\("browser_eval", \{[\s\S]*automationReceipt: \{ actionId: effect\.actionId, tabId: effect\.tabId, generation: effect\.generation \}/);
    expect(lib).toContain('.manage(BrowserAutomationAuthorizations::default())');
  });

  it('does not let a prepatched page emitter encode numeric data in an action receipt', async () => {
    const originalInvoke = vi.fn();
    const forgedInvoke = vi.fn();
    const coreApi = { invoke: originalInvoke };
    const button: any = {
      tagName: 'BUTTON', children: [], textContent: 'Safe', parentElement: null, isConnected: true,
      attributes: {}, getAttribute: () => null, hasAttribute: () => false,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }),
      click: vi.fn(() => { coreApi.invoke = forgedInvoke as typeof originalInvoke; }), focus: vi.fn(), dispatchEvent: vi.fn(() => true),
    };
    const body: any = { ...button, tagName: 'BODY', textContent: '', children: [button], click: vi.fn() };
    button.parentElement = body;
    const window: any = {
      __TAURI__: { core: coreApi }, document: { body, documentElement: body },
      innerWidth: 100, innerHeight: 100, location: { href: 'https://example.test/' },
      Date, URL, Event: class { constructor(public type: string) {} },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    };
    const api = installBrowserAutomation(window);
    const snapshot = api.dispatch({ type: 'snapshot' });
    const build = Function(
      'resolveBrowserAutomationSnapshotId',
      `return (${functionSource(main, 'browserAutomationDispatchScript')});`,
    )(() => snapshot.snapshotId);
    coreApi.invoke = vi.fn((_command: string, payload: unknown) => forgedInvoke(8675309, payload));
    await Function('window', `return ${build({
      actionId: 'action', tabId: 'tab', generation: 1,
      operation: { kind: 'action', snapshotId: 'snap', action: { kind: 'click', elementRef: 'e1' } },
    })}`)(window);
    expect(originalInvoke).toHaveBeenCalledWith('browser_automation_result', {
      result: expect.objectContaining({ value: { clicked: true } }),
    });
    expect(forgedInvoke).not.toHaveBeenCalled();
    expect(JSON.stringify(originalInvoke.mock.calls)).not.toContain('8675309');
    expect(snapshot.nodes[0]).toMatchObject({ role: 'button' });
  });

  it('does not retry emission when the trusted result emitter rejects after a successful effect', async () => {
    const invoke = vi.fn(async () => { throw new Error('transport rejected'); });
    const click = vi.fn();
    const button: any = {
      tagName: 'BUTTON', children: [], textContent: 'Save', parentElement: null, isConnected: true,
      attributes: {}, getAttribute: () => null, hasAttribute: () => false,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }),
      click, focus: vi.fn(), dispatchEvent: vi.fn(() => true),
    };
    const body: any = { ...button, tagName: 'BODY', textContent: '', children: [button], click: vi.fn() };
    button.parentElement = body;
    const globalObject: any = {
      __TAURI__: { core: { invoke } }, document: { body, documentElement: body },
      innerWidth: 100, innerHeight: 100, location: { href: 'https://example.test/' },
      Date, URL, Event: class { constructor(public type: string) {} },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    };
    const api = installBrowserAutomation(globalObject);
    const snapshot = api.dispatch({ type: 'snapshot' });
    await expect(api.dispatchAndEmit(
      { type: 'action', snapshotId: snapshot.snapshotId, action: { kind: 'click', elementRef: 'e1' } },
      { actionId: 'action', tabId: 'tab', generation: 1 },
    )).rejects.toThrow('transport rejected');
    expect(click).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('browser_automation_result', {
      result: expect.objectContaining({ value: { clicked: true } }),
    });
  });
});
