import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const repoRoot = process.cwd();
const tauriRoot = join(repoRoot, 'native/desktop/psyche-build-tauri');
const panesRoot = join(repoRoot, 'native/desktop/psyche-build-tauri/web/panes');
const footerModule = await import(pathToFileURL(join(panesRoot, 'pane-footer.mjs')).href);
const paneTreeModule = await import(pathToFileURL(join(panesRoot, 'pane-tree.mjs')).href);
const tauriPackage = JSON.parse(readFileSync(join(tauriRoot, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};
const cargoToml = readFileSync(join(tauriRoot, 'src-tauri/Cargo.toml'), 'utf8');
const defaultCapability = JSON.parse(
  readFileSync(join(tauriRoot, 'src-tauri/capabilities/default.json'), 'utf8')
) as { permissions: string[] };
const nativeLib = readFileSync(join(tauriRoot, 'src-tauri/src/lib.rs'), 'utf8');

const {
  FOOTER_TIERS,
  footerItems,
  footerTier,
  formatContext,
  formatSpend,
  hiddenFooterKeys,
  isAgentPaneKind,
  shouldApplyMetricsResponse,
} = footerModule;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionSource(source: string, name: string) {
  const match = new RegExp(
    `(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`
  ).exec(source);
  if (!match || match.index === undefined) throw new Error(`missing function ${name}`);

  const bodyStart = source.indexOf('{', match.index + match[0].length);
  if (bodyStart === -1) throw new Error(`missing body for ${name}`);

  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }

  throw new Error(`unterminated function ${name}`);
}

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(...names, `"use strict"; return (${source});`)(...values) as T;
}

describe('pane footer model', () => {
  it('uses only core controls for non-agent panes', () => {
    const base = {
      branch: 'feat/footer',
      worktreeLabel: 'footer-pane',
      worktreePath: '/repo/.worktrees/footer-pane',
      paneId: 'thread-1',
    };

    expect(footerItems({ ...base, kind: 'shell' }).map((item: { key: string }) => item.key))
      .toEqual(['branch', 'worktree', 'pane']);
    expect(footerItems({ ...base, kind: 'web' }).map((item: { key: string }) => item.key))
      .toEqual(['branch', 'worktree', 'pane']);
    expect(footerItems({ ...base, kind: 'git' }).map((item: { key: string }) => item.key))
      .toEqual(['branch', 'worktree', 'pane']);
    expect(footerItems({ ...base, kind: 'psyche' }).map((item: { key: string }) => item.key))
      .toEqual(['branch', 'worktree', 'pane']);
    expect(isAgentPaneKind('shell')).toBe(false);
    expect(isAgentPaneKind('web')).toBe(false);
    expect(isAgentPaneKind('git')).toBe(false);
    expect(isAgentPaneKind('psyche')).toBe(false);
  });

  it('treats only allowlisted pane kinds as agent-backed', () => {
    expect([
      'coven-chat',
      'coven-attach',
      'agent-copilot',
      'agent-codex',
      'agent-anthropic',
      'agent-grok-build',
    ].every((kind) => isAgentPaneKind(kind))).toBe(true);
  });

  it('orders agent controls and formats unavailable metrics', () => {
    const items = footerItems({
      kind: 'coven-chat',
      branch: 'feat/footer',
      worktreeLabel: 'footer-pane',
      worktreePath: '/repo/.worktrees/footer-pane',
      paneId: 'thread-1',
      metrics: {
        phase: 'ready',
        provider: 'coven',
        sessionId: 'session-1',
        model: null,
        contextUsed: null,
        contextLimit: null,
        spendUsd: 0.375,
        updatedAt: '2026-08-10T20:00:00Z',
        stale: false,
        error: null,
        canSwitchModel: false,
      },
    });

    expect(items.map((item: { key: string }) => item.key)).toEqual([
      'branch',
      'worktree',
      'model',
      'session',
      'context',
      'spend',
    ]);
    expect(items.find((item: { key: string }) => item.key === 'model')?.value).toBe('—');
    expect(items.find((item: { key: string }) => item.key === 'context')?.value).toBe('—');
    expect(items.find((item: { key: string }) => item.key === 'spend')?.value).toBe('$0.38');
  });

  it('uses deterministic pane-width tiers', () => {
    expect(footerTier(760)).toBe(FOOTER_TIERS.FULL);
    expect(footerTier(650)).toBe(FOOTER_TIERS.NO_SESSION);
    expect(footerTier(570)).toBe(FOOTER_TIERS.NO_SPEND);
    expect(footerTier(490)).toBe(FOOTER_TIERS.NO_CONTEXT);
    expect(footerTier(410)).toBe(FOOTER_TIERS.CORE);
    expect(footerTier(280)).toBe(FOOTER_TIERS.COMPACT);
  });

  it('moves only collapsed controls into overflow', () => {
    expect(hiddenFooterKeys(FOOTER_TIERS.FULL, true)).toEqual([]);
    expect(hiddenFooterKeys(FOOTER_TIERS.NO_SESSION, true)).toEqual(['session']);
    expect(hiddenFooterKeys(FOOTER_TIERS.NO_SPEND, true)).toEqual(['session', 'spend']);
    expect(hiddenFooterKeys(FOOTER_TIERS.NO_CONTEXT, true))
      .toEqual(['session', 'spend', 'context']);
    expect(hiddenFooterKeys(FOOTER_TIERS.CORE, true))
      .toEqual(['session', 'spend', 'context', 'model']);
    expect(hiddenFooterKeys(FOOTER_TIERS.COMPACT, false)).toEqual(['pane']);
  });

  it('formats only real context and spend values', () => {
    expect(formatContext(42_000, 100_000)).toBe('42%');
    expect(formatContext(150, 100)).toBe('100%');
    expect(formatContext(null, 100_000)).toBe('—');
    expect(formatContext(42_000, null)).toBe('—');
    expect(formatSpend(0)).toBe('$0.00');
    expect(formatSpend(1.256)).toBe('$1.26');
    expect(formatSpend(null)).toBe('—');
  });

  it('uses session truncation and the expected footer actions', () => {
    const items = footerItems({
      kind: 'coven-chat',
      branch: 'feat/footer',
      worktreeLabel: 'footer-pane',
      worktreePath: '/repo/.worktrees/footer-pane',
      paneId: 'thread-1',
      metrics: {
        phase: 'ready',
        provider: 'coven',
        sessionId: '12345678-1234-5678-9abc-def012345678',
        model: 'gpt-5',
        contextUsed: 42_000,
        contextLimit: 100_000,
        spendUsd: 0.375,
        updatedAt: '2026-08-10T20:00:00Z',
        stale: false,
        error: null,
        canSwitchModel: true,
      },
    });

    expect(items.map((item: { action: string }) => item.action)).toEqual([
      'copy',
      'reveal',
      'switch-model',
      'copy',
      'usage',
      'usage',
    ]);
    expect(items.find((item: { key: string }) => item.key === 'session')).toMatchObject({
      value: '12345678',
      fullValue: '12345678-1234-5678-9abc-def012345678',
    });
  });

  it('keeps missing session ids semantically empty and truthfully labelled', () => {
    const item = footerItems({
      kind: 'coven-chat',
      branch: 'feat/footer',
      worktreeLabel: 'footer-pane',
      worktreePath: '/repo/.worktrees/footer-pane',
      paneId: 'thread-1',
      metrics: {
        phase: 'ready',
        provider: 'coven',
        sessionId: null,
        model: 'gpt-5',
        contextUsed: 42_000,
        contextLimit: 100_000,
        spendUsd: 0.375,
        updatedAt: '2026-08-10T20:00:00Z',
        stale: false,
        error: null,
        canSwitchModel: true,
      },
    }).find((entry: { key: string }) => entry.key === 'session');

    expect(item).toMatchObject({
      value: '—',
      fullValue: '',
      a11yValue: 'not reported',
      action: 'copy',
    });
  });

  it('uses ellipses while agent metrics are loading or idle', () => {
    for (const phase of ['idle', 'loading'] as const) {
      const items = footerItems({
        kind: 'coven-chat',
        branch: 'feat/footer',
        worktreeLabel: 'footer-pane',
        worktreePath: '/repo/.worktrees/footer-pane',
        paneId: 'thread-1',
        metrics: {
          phase,
          provider: 'coven',
          sessionId: 'session-1',
          model: 'gpt-5',
          contextUsed: 1,
          contextLimit: 2,
          spendUsd: 0.1,
          updatedAt: null,
          stale: false,
          error: null,
          canSwitchModel: false,
        },
      });

      expect(items.filter((item: { key: string }) => ['model', 'session', 'context', 'spend'].includes(item.key))
        .map((item: { value: string }) => item.value)).toEqual(['…', '…', '…', '…']);
      expect(items.find((item: { key: string }) => item.key === 'session')).toMatchObject({
        a11yValue: 'loading',
      });
    }
  });

  it('rejects metrics from the wrong thread, generation, or session binding', () => {
    const thread = {
      id: 'thread-1',
      metricsGeneration: 4,
      launch: { covenSessionId: 'session-new' },
    };

    expect(shouldApplyMetricsResponse(thread, {
      threadId: 'thread-1', generation: 4, sessionId: 'session-new',
    })).toBe(true);
    expect(shouldApplyMetricsResponse(thread, {
      threadId: 'thread-2', generation: 4, sessionId: 'session-new',
    })).toBe(false);
    expect(shouldApplyMetricsResponse(thread, {
      threadId: 'thread-1', generation: 3, sessionId: 'session-new',
    })).toBe(false);
    expect(shouldApplyMetricsResponse(thread, {
      threadId: 'thread-1', generation: 4, sessionId: 'session-old',
    })).toBe(false);
  });
});

const mainJs = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
);
const stylesCss = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/styles.css'),
  'utf8',
);

describe('pane metrics refresh contract', () => {
  it('polls visible agent panes only', () => {
    expect(mainJs).toMatch(/function threadWantsMetrics\(thread\)/);
    expect(mainJs).toMatch(
      /function threadWantsMetrics\(thread\)[\s\S]*isLiveThread\(thread\)[\s\S]*thread\.launch\.launchKind === "coven-chat"[\s\S]*thread\.pane\.isConnected[\s\S]*effectiveCanvasThreadIds\(\)\.indexOf\(thread\.id\)/,
    );
    expect(mainJs).toMatch(/setInterval\(refreshVisiblePaneMetrics,\s*15000\)/);
    expect(mainJs).toMatch(/var PANE_METRICS_POLL_MS = 15000;/);
  });

  function metricsEligibility(
    layout: Record<string, any>,
    threads: Record<string, any>[],
    focusSets: Record<string, any>[] = [],
    visibility: { documentHidden?: boolean; terminalHidden?: boolean; mounted?: boolean } = {},
  ) {
    const terminalHost = {
      hidden: Boolean(visibility.terminalHidden),
      isConnected: true,
      contains: (pane: unknown) => visibility.mounted !== false
        && threads.some((thread) => thread.pane === pane),
    };
    const factory = Function(
      'PsychePanes',
      'state',
      'activePaneLayout',
      'seedFocusSets',
      'document',
      'terminalHost',
      `"use strict";
       var focusSets = seedFocusSets;
       var SPAN_ORIENTATION = { column: "row", row: "column" };
       var findFocusSet = ${functionSource(mainJs, 'findFocusSet')};
       var scopedPaneRoot = ${functionSource(mainJs, 'scopedPaneRoot')};
       var spanSignature = ${functionSource(mainJs, 'spanSignature')};
       var effectivePaneRoot = ${functionSource(mainJs, 'effectivePaneRoot')};
       var effectiveCanvasThreadIds = ${functionSource(mainJs, 'effectiveCanvasThreadIds')};
       var isLiveThread = ${functionSource(mainJs, 'isLiveThread')};
       return ${functionSource(mainJs, 'threadWantsMetrics')};`,
    );
    return factory(
      paneTreeModule,
      { threads },
      () => layout,
      focusSets,
      { hidden: Boolean(visibility.documentHidden) },
      terminalHost,
    ) as (thread: Record<string, any>) => boolean;
  }

  function eligibleThread(id: string) {
    return {
      id,
      hidden: false,
      closing: false,
      status: 'running',
      pane: { isConnected: true },
      launch: { launchKind: 'coven-chat', covenSessionId: `session-${id}` },
    };
  }

  it('selects only canonical live, connected Coven sessions with an exact id', () => {
    const eligible = {
      ...eligibleThread('visible'),
      launch: { launchKind: 'coven-chat', covenSessionId: 'session-exact' },
    };
    const layout = { root: paneTreeModule.createLeaf('leaf-visible', 'visible') };
    const threadWantsMetrics = metricsEligibility(layout, [eligible]);

    expect(threadWantsMetrics(eligible)).toBe(true);
    expect(threadWantsMetrics({ ...eligible })).toBe(false);
    expect(threadWantsMetrics({ ...eligible, hidden: true })).toBe(false);
    expect(threadWantsMetrics({ ...eligible, status: 'exited' })).toBe(false);
    eligible.pane.isConnected = false;
    expect(threadWantsMetrics(eligible)).toBe(false);
    eligible.pane.isConnected = true;
    expect(threadWantsMetrics({
      ...eligible,
      launch: { ...eligible.launch, launchKind: 'coven-attach' },
    })).toBe(false);
    expect(threadWantsMetrics({
      ...eligible,
      launch: { ...eligible.launch, covenSessionId: '' },
    })).toBe(false);
  });

  it('excludes panes hidden by maximize and focus-set presentation state', () => {
    const visible = eligibleThread('visible');
    const excluded = eligibleThread('excluded');
    const root = paneTreeModule.insertBelow(
      paneTreeModule.createLeaf('leaf-visible', visible.id),
      'leaf-visible',
      paneTreeModule.createLeaf('leaf-excluded', excluded.id),
      'split-root',
    );
    const layout: {
      root: Record<string, any>;
      focusedLeafId: string;
      maximizedLeafId: string | null;
      activeSetId: string | null;
    } = {
      root,
      focusedLeafId: 'leaf-visible',
      maximizedLeafId: 'leaf-visible',
      activeSetId: null,
    };
    let threadWantsMetrics = metricsEligibility(layout, [visible, excluded]);

    expect(threadWantsMetrics(visible)).toBe(true);
    expect(threadWantsMetrics(excluded)).toBe(false);

    layout.maximizedLeafId = null;
    layout.activeSetId = 'set-visible';
    threadWantsMetrics = metricsEligibility(layout, [visible, excluded], [{
      id: 'set-visible',
      threadIds: [visible.id],
    }]);
    expect(threadWantsMetrics(visible)).toBe(true);
    expect(threadWantsMetrics(excluded)).toBe(false);
  });

  it('requires the document and mounted terminal canvas to be actually visible', () => {
    const visible = eligibleThread('visible');
    const layout = { root: paneTreeModule.createLeaf('leaf-visible', visible.id) };

    expect(metricsEligibility(layout, [visible], [], { documentHidden: true })(visible))
      .toBe(false);
    expect(metricsEligibility(layout, [visible], [], { terminalHidden: true })(visible))
      .toBe(false);
    expect(metricsEligibility(layout, [visible], [], { mounted: false })(visible))
      .toBe(false);
    expect(metricsEligibility(layout, [visible])(visible)).toBe(true);
  });

  it('cancels pending metrics refreshes while hidden and refreshes immediately on resume', () => {
    const threads = [
      { metricsGeneration: 2, metricsRefreshTimer: 17 },
      { metricsGeneration: 5, metricsRefreshTimer: 0 },
    ];
    const documentState = { hidden: true };
    const terminalHost = { hidden: false, isConnected: true };
    const cleared: number[] = [];
    const refreshVisiblePaneMetrics = vi.fn();
    const syncPaneMetricsVisibility = compileFunction<() => boolean>(
      functionSource(mainJs, 'syncPaneMetricsVisibility'),
      {
        document: documentState,
        terminalHost,
        state: { threads },
        clearTimeout: (timer: number) => { cleared.push(timer); },
        refreshVisiblePaneMetrics,
      },
    );

    expect(syncPaneMetricsVisibility()).toBe(false);
    expect(cleared).toEqual([17]);
    expect(threads).toEqual([
      { metricsGeneration: 3, metricsRefreshTimer: 0 },
      { metricsGeneration: 6, metricsRefreshTimer: 0 },
    ]);
    expect(refreshVisiblePaneMetrics).not.toHaveBeenCalled();

    documentState.hidden = false;
    terminalHost.hidden = true;
    threads[0].metricsRefreshTimer = 29;
    expect(syncPaneMetricsVisibility()).toBe(false);
    expect(cleared).toEqual([17, 29]);
    expect(threads[0]).toEqual({ metricsGeneration: 4, metricsRefreshTimer: 0 });

    terminalHost.hidden = false;
    expect(syncPaneMetricsVisibility()).toBe(true);
    expect(refreshVisiblePaneMetrics).toHaveBeenCalledTimes(1);

    expect(functionSource(mainJs, 'handleVisibilityChange'))
      .toMatch(/syncPaneMetricsVisibility\(\)/);
    expect(functionSource(mainJs, 'enterFileFocus'))
      .toMatch(/fileViewEl\.hidden = false;[\s\S]*syncPaneMetricsVisibility\(\)/);
    expect(functionSource(mainJs, 'enterFileFocus'))
      .not.toMatch(/terminalHost\.hidden/);
    expect(functionSource(mainJs, 'clearFileFocusPresentation'))
      .toMatch(/fileViewEl\.hidden = true;[\s\S]*syncPaneMetricsVisibility\(\)/);
    expect(functionSource(mainJs, 'showTerminalView'))
      .not.toMatch(/clearFileFocusPresentation\(\)|terminalHost\.hidden/);
    expect(functionSource(mainJs, 'closeFileTab'))
      .toMatch(/clearFileFocusPresentation\(\)/);
  });

  it('debounces refresh after PTY output and rechecks eligibility', () => {
    expect(mainJs).toMatch(/schedulePaneMetricsRefresh\(thread,\s*1200\)/);
    const callbacks: Array<() => void> = [];
    const cleared: number[] = [];
    const refreshPaneMetrics = vi.fn();
    const wantsMetrics = vi.fn(() => true);
    const schedulePaneMetricsRefresh = compileFunction<
      (thread: { metricsRefreshTimer: number }, delay: number) => void
    >(functionSource(mainJs, 'schedulePaneMetricsRefresh'), {
      threadWantsMetrics: wantsMetrics,
      clearTimeout: (timer: number) => { cleared.push(timer); },
      setTimeout: (callback: () => void, delay: number) => {
        expect(delay).toBe(1200);
        callbacks.push(callback);
        return 42;
      },
      refreshPaneMetrics,
    });
    const thread = { metricsRefreshTimer: 17 };

    schedulePaneMetricsRefresh(thread, 1200);
    expect(cleared).toEqual([17]);
    expect(thread.metricsRefreshTimer).toBe(42);

    wantsMetrics.mockReturnValue(false);
    callbacks[0]();
    expect(thread.metricsRefreshTimer).toBe(0);
    expect(refreshPaneMetrics).not.toHaveBeenCalled();
  });

  it('rejects stale responses and invokes metrics with exact launch identity', async () => {
    const syncPaneFooter = vi.fn();
    const invoke = vi.fn(async () => ({
      provider: 'coven',
      sessionId: 'session-old',
      model: 'gpt-5',
      contextUsed: 1,
      contextLimit: 2,
      cumulativeInputTokens: 3,
      cumulativeOutputTokens: 4,
      cacheCreationTokens: 5,
      cacheReadTokens: 6,
      spendUsd: 0.25,
      costKind: 'local-estimate',
      updatedAt: '2026-08-10T20:00:00Z',
    }));
    const shouldApplyMetricsResponse = vi.fn(() => false);
    const refreshPaneMetrics = compileFunction<(thread: any) => Promise<boolean>>(
      functionSource(mainJs, 'refreshPaneMetrics'),
      {
        threadWantsMetrics: () => true,
        syncPaneFooter,
        invoke,
        PsychePanes: { shouldApplyMetricsResponse },
        metricsErrorState: vi.fn(),
        loadingPaneMetrics: compileFunction(
          functionSource(mainJs, 'loadingPaneMetrics'),
          {},
        ),
      },
    );
    const thread = {
      id: 'thread-1',
      launch: {
        projectRoot: '/repo',
        covenSessionId: 'session-exact',
      },
      worktreePath: '/repo/.worktrees/feature',
      metricsGeneration: 0,
      metrics: null,
    };

    await expect(refreshPaneMetrics(thread)).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledWith('pane_session_metrics', {
      projectRoot: '/repo',
      project_root: '/repo',
      cwd: '/repo/.worktrees/feature',
      sessionId: 'session-exact',
      session_id: 'session-exact',
    });
    expect(shouldApplyMetricsResponse).toHaveBeenCalledWith(thread, {
      threadId: 'thread-1',
      generation: 1,
      sessionId: 'session-old',
    });
    expect((thread.metrics as { phase?: string } | null)?.phase).toBe('loading');
  });

  it('preserves ready values, including zeroes, when a refresh fails', () => {
    const metricsErrorState = compileFunction<(thread: any, error: unknown) => any>(
      functionSource(mainJs, 'metricsErrorState'),
      {
        metricsValue: compileFunction(
          functionSource(mainJs, 'metricsValue'),
          {},
        ),
      },
    );
    const thread = {
      launch: { covenSessionId: 'session-exact' },
      metrics: {
        phase: 'ready',
        provider: 'coven',
        sessionId: 'session-exact',
        model: 'gpt-5',
        contextUsed: 0,
        contextLimit: 100_000,
        cumulativeInputTokens: 0,
        cumulativeOutputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        spendUsd: 0,
        costKind: 'local-estimate',
        updatedAt: '2026-08-10T20:00:00Z',
      },
    };

    expect(metricsErrorState(thread, new Error('offline'))).toMatchObject({
      phase: 'error',
      provider: 'coven',
      sessionId: 'session-exact',
      contextUsed: 0,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      spendUsd: 0,
      costKind: 'local-estimate',
      stale: true,
      error: 'Error: offline',
      canSwitchModel: false,
    });
  });

  it('shows exact values and truthful unreported fields in the usage popover', () => {
    expect(mainJs).toMatch(/function openPaneUsagePopover\(thread,\s*trigger\)/);
    expect(mainJs).toContain('Not reported by Coven');
    expect(mainJs).toContain('Local estimate');
    expect(stylesCss).toContain('.pane-usage-popover');

    const rows: Array<{ label: string; value: string }> = [];
    const popover = {
      className: '',
      attributes: new Map<string, string>(),
      children: [] as unknown[],
      setAttribute(name: string, value: string) { this.attributes.set(name, value); },
      appendChild(child: unknown) { this.children.push(child); },
      focus: vi.fn(),
    };
    const openPaneUsagePopover = compileFunction<(thread: any, trigger: any) => any>(
      functionSource(mainJs, 'openPaneUsagePopover'),
      {
        closePaneFooterPopovers: vi.fn(),
        paneFooterState: () => ({
          metrics: {
            phase: 'ready',
            provider: 'coven',
            sessionId: 'session-exact',
            model: null,
            contextUsed: null,
            contextLimit: null,
            cumulativeInputTokens: 123,
            cumulativeOutputTokens: 45,
            spendUsd: 0.125,
            costKind: 'local-estimate',
            updatedAt: '2026-08-10T20:00:00Z',
            stale: true,
            error: 'refresh failed',
          },
        }),
        document: {
          activeElement: { tagName: 'BODY' },
          createElement: () => popover,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
        paneUsageRow: (label: string, value: string) => {
          const row = { label, value };
          rows.push(row);
          return row;
        },
        positionPaneFooterPopover: vi.fn(),
        paneFooterPopoverTrigger: null,
        paneFooterPopoverThreadId: null,
        paneFooterPopoverCleanup: null,
        paneFooterPopover: null,
        paneFooterPopoverOwner: null,
      },
    );

    openPaneUsagePopover(
      { name: 'Agent pane', paneFooter: {} },
      { isConnected: true },
    );
    expect(rows).toEqual([
      { label: 'Provider', value: 'Coven' },
      { label: 'Model', value: 'Not reported by Coven' },
      { label: 'Session', value: 'session-exact' },
      { label: 'Context', value: 'Not reported by Coven' },
      { label: 'Input tokens', value: '123' },
      { label: 'Output tokens', value: '45' },
      { label: 'Spend', value: '$0.1250 · Local estimate' },
      { label: 'Updated', value: '2026-08-10T20:00:00Z' },
      { label: 'State', value: 'Stale' },
      { label: 'Error', value: 'refresh failed' },
    ]);
    expect(popover.attributes.get('role')).toBe('dialog');
    expect(popover.attributes.get('aria-label')).toBe('Agent pane session usage');
  });
});

describe('pane usage popover lifecycle', () => {
  function popoverHarness() {
    const createElement = () => {
      const element = {
        className: '',
        hidden: false,
        removed: false,
        dataset: {} as Record<string, string>,
        attributes: new Map<string, string>(),
        children: [] as any[],
        style: {},
        setAttribute(name: string, value: string) { this.attributes.set(name, value); },
        appendChild(child: any) { this.children.push(child); return child; },
        contains(target: unknown) {
          return target === this || this.children.includes(target);
        },
        getBoundingClientRect() { return { width: 300 }; },
        focus: vi.fn(),
        remove() { this.removed = true; },
      };
      return element;
    };
    const body = createElement();
    const trigger = createElement();
    const document = {
      activeElement: body,
      createElement,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      querySelectorAll: vi.fn(() => []),
    };
    const threadA = {
      id: 'thread-a',
      name: 'Agent A',
      kind: 'coven-chat',
      paneFooter: createElement(),
      paneFooterItems: createElement(),
      paneFooterOverflow: createElement(),
      createPaneFooterButton: vi.fn(() => createElement()),
    };
    const threadB = {
      id: 'thread-b',
      name: 'Agent B',
      kind: 'coven-chat',
      paneFooter: createElement(),
      paneFooterItems: createElement(),
      paneFooterOverflow: createElement(),
      createPaneFooterButton: vi.fn(() => createElement()),
    };
    const state = { threads: [threadA, threadB] };
    const factory = Function(
      'document',
      'state',
      'PsychePanes',
      'paneFooterState',
      'paneUsageRow',
      'positionPaneFooterPopover',
      'closePaneFooterMenu',
      `"use strict";
       var paneFooterPopoverCleanup = null;
       var paneFooterPopover = null;
       var paneFooterPopoverOwner = null;
       var paneFooterPopoverTrigger = null;
       var paneFooterPopoverThreadId = null;
       var closePaneFooterPopovers = ${functionSource(mainJs, 'closePaneFooterPopovers')};
       var closePaneUsagePopoverForFooter =
         ${functionSource(mainJs, 'closePaneUsagePopoverForFooter')};
       var openPaneUsagePopover = ${functionSource(mainJs, 'openPaneUsagePopover')};
       var syncPaneFooter = ${functionSource(mainJs, 'syncPaneFooter')};
       return {
         openPaneUsagePopover,
         syncPaneFooter,
         currentPopover: function () { return paneFooterPopover; }
       };`,
    );
    const harness = factory(
      document,
      state,
      {
        footerItems: () => [{ key: 'usage' }],
        footerTier: () => 'full',
        isAgentPaneKind: () => true,
        hiddenFooterKeys: () => [],
      },
      () => ({
        metrics: {
          phase: 'loading',
          sessionId: 'session-a',
          model: null,
          contextUsed: null,
          contextLimit: null,
          cumulativeInputTokens: null,
          cumulativeOutputTokens: null,
          spendUsd: null,
          costKind: 'unknown',
          updatedAt: null,
        },
      }),
      () => createElement(),
      vi.fn(),
      vi.fn(),
    ) as {
      openPaneUsagePopover: (
        thread: typeof threadA,
        trigger: ReturnType<typeof createElement>,
      ) => ReturnType<typeof createElement>;
      syncPaneFooter: (thread: typeof threadA) => void;
      currentPopover: () => ReturnType<typeof createElement> | null;
    };
    return { harness, body, trigger, threadA, threadB };
  }

  it('removes an owned usage dialog before rerendering its footer trigger', () => {
    const { harness, trigger, threadA, threadB } = popoverHarness();
    const popover = harness.openPaneUsagePopover(threadA, trigger);

    harness.syncPaneFooter(threadB);
    expect(popover.removed).toBe(false);
    expect(harness.currentPopover()).toBe(popover);

    harness.syncPaneFooter(threadA);
    expect(popover.removed).toBe(true);
    expect(harness.currentPopover()).toBeNull();
  });

  it('owns the dialog with the explicit trigger even when activeElement is body', () => {
    const { harness, trigger, threadA } = popoverHarness();
    const popover = harness.openPaneUsagePopover(threadA, trigger);
    const otherFooter = {};
    const close = vi.fn();
    const handlePointerDown = compileFunction<(event: { target: unknown }) => void>(
      functionSource(mainJs, 'handlePaneFooterPopoverPointerDown'),
      {
        paneFooterPopover: popover,
        paneFooterPopoverTrigger: trigger,
        closePaneFooterPopovers: close,
      },
    );

    handlePointerDown({ target: otherFooter });
    expect(close).toHaveBeenCalledWith(false);
    expect(trigger.contains(otherFooter)).toBe(false);
  });

  it('closes on another footer action without swallowing that action', () => {
    const calls: string[] = [];
    const popover = { contains: () => false };
    const trigger = { contains: () => false };
    const handlePointerDown = compileFunction<(event: {
      target: unknown;
      preventDefault: () => void;
      stopPropagation: () => void;
    }) => void>(functionSource(mainJs, 'handlePaneFooterPopoverPointerDown'), {
      paneFooterPopover: popover,
      paneFooterPopoverTrigger: trigger,
      closePaneFooterPopovers: () => { calls.push('close'); },
    });
    const handleClick = compileFunction<(
      thread: { id: string },
      item: { action: string },
      event: { stopPropagation: () => void },
    ) => boolean>(functionSource(mainJs, 'handlePaneFooterItemClick'), {
      runPaneFooterAction: () => { calls.push('action'); return true; },
      closePaneFooterMenu: () => { calls.push('close-menu'); },
      focusPaneAfterFooterAction: () => { calls.push('focus-pane'); },
    });
    const pointerEvent = {
      target: {},
      preventDefault: () => { calls.push('prevent'); },
      stopPropagation: () => { calls.push('stop-pointer'); },
    };

    handlePointerDown(pointerEvent);
    handleClick(
      { id: 'thread-b' },
      { action: 'copy' },
      { stopPropagation: () => { calls.push('stop-click'); } },
    );

    expect(calls).toEqual([
      'close',
      'stop-click',
      'action',
      'close-menu',
      'focus-pane',
    ]);
  });

  it('keeps pointerdown inside the active trigger or dialog exempt', () => {
    const insidePopover = {};
    const insideTrigger = {};
    const close = vi.fn();
    const handlePointerDown = compileFunction<(event: { target: unknown }) => void>(
      functionSource(mainJs, 'handlePaneFooterPopoverPointerDown'),
      {
        paneFooterPopover: { contains: (target: unknown) => target === insidePopover },
        paneFooterPopoverTrigger: {
          contains: (target: unknown) => target === insideTrigger,
        },
        closePaneFooterPopovers: close,
      },
    );

    handlePointerDown({ target: insidePopover });
    handlePointerDown({ target: insideTrigger });
    expect(close).not.toHaveBeenCalled();
  });
});

describe('pane footer native actions contract', () => {
  it('pins the official clipboard package and Rust plugin at major 2', () => {
    expect(tauriPackage.dependencies['@tauri-apps/plugin-clipboard-manager'])
      .toMatch(/^(\^|~)?2(?:$|\.)/);
    expect(cargoToml).toMatch(/tauri-plugin-clipboard-manager\s*=\s*"2"/);
  });

  it('registers clipboard and reveal permissions plus the clipboard plugin', () => {
    expect(defaultCapability.permissions).toContain('clipboard-manager:allow-write-text');
    expect(defaultCapability.permissions).toContain('opener:allow-reveal-item-in-dir');
    expect(nativeLib).toMatch(/\.plugin\(tauri_plugin_clipboard_manager::init\(\)\)/);
  });

  it('exposes Tauri globals and calls clipboard/reveal APIs from main.js', () => {
    expect(mainJs).toContain('var opener = window.__TAURI__.opener || null;');
    expect(mainJs).toContain('var clipboardManager = window.__TAURI__.clipboardManager || null;');
    expect(mainJs).toContain('await clipboardManager.writeText(value);');
    expect(mainJs).toContain('await opener.revealItemInDir(path);');
  });
});

describe('pane footer native action helpers', () => {
  it('copies a footer value with a success toast', async () => {
    const toast = vi.fn();
    const setStatus = vi.fn();
    const writeText = vi.fn(async () => undefined);
    const copyPaneFooterValue = compileFunction<
      (label: string, value: string | null) => Promise<boolean>
    >(functionSource(mainJs, 'copyPaneFooterValue'), {
      clipboardManager: { writeText },
      toast,
      setStatus,
    });

    await expect(copyPaneFooterValue('Session', 'session-123')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('session-123');
    expect(toast).toHaveBeenCalledWith('Session copied');
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('refuses to copy a missing footer value', async () => {
    const toast = vi.fn();
    const setStatus = vi.fn();
    const writeText = vi.fn(async () => undefined);
    const copyPaneFooterValue = compileFunction<
      (label: string, value: string | null) => Promise<boolean>
    >(functionSource(mainJs, 'copyPaneFooterValue'), {
      clipboardManager: { writeText },
      toast,
      setStatus,
    });

    await expect(copyPaneFooterValue('Session', '')).resolves.toBe(false);
    expect(toast).toHaveBeenCalledWith('Session is not reported');
    expect(writeText).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('reports when clipboard support is unavailable', async () => {
    const toast = vi.fn();
    const setStatus = vi.fn();
    const copyPaneFooterValue = compileFunction<
      (label: string, value: string | null) => Promise<boolean>
    >(functionSource(mainJs, 'copyPaneFooterValue'), {
      clipboardManager: null,
      toast,
      setStatus,
    });

    await expect(copyPaneFooterValue('Session', 'session-123')).resolves.toBe(false);
    expect(setStatus).toHaveBeenCalledWith('Clipboard support is unavailable', 'error');
    expect(toast).not.toHaveBeenCalled();
  });

  it('surfaces clipboard write failures', async () => {
    const toast = vi.fn();
    const setStatus = vi.fn();
    const copyPaneFooterValue = compileFunction<
      (label: string, value: string | null) => Promise<boolean>
    >(functionSource(mainJs, 'copyPaneFooterValue'), {
      clipboardManager: {
        writeText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
      toast,
      setStatus,
    });

    await expect(copyPaneFooterValue('Session', 'session-123')).resolves.toBe(false);
    expect(setStatus).toHaveBeenCalledWith('Copy failed: Error: denied', 'error');
    expect(toast).not.toHaveBeenCalled();
  });

  it('reveals a worktree path via the opener plugin', async () => {
    const setStatus = vi.fn();
    const revealItemInDir = vi.fn(async () => undefined);
    const revealPaneWorktree = compileFunction<
      (path: string | null) => Promise<boolean>
    >(functionSource(mainJs, 'revealPaneWorktree'), {
      opener: { revealItemInDir },
      setStatus,
    });

    await expect(revealPaneWorktree('/repo/.worktrees/feature')).resolves.toBe(true);
    expect(revealItemInDir).toHaveBeenCalledWith('/repo/.worktrees/feature');
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('refuses to reveal a missing worktree path', async () => {
    const setStatus = vi.fn();
    const revealItemInDir = vi.fn(async () => undefined);
    const revealPaneWorktree = compileFunction<
      (path: string | null) => Promise<boolean>
    >(functionSource(mainJs, 'revealPaneWorktree'), {
      opener: { revealItemInDir },
      setStatus,
    });

    await expect(revealPaneWorktree('')).resolves.toBe(false);
    expect(setStatus).toHaveBeenCalledWith('Worktree path is unavailable', 'error');
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it('reports when Finder reveal support is unavailable', async () => {
    const setStatus = vi.fn();
    const revealPaneWorktree = compileFunction<
      (path: string | null) => Promise<boolean>
    >(functionSource(mainJs, 'revealPaneWorktree'), {
      opener: null,
      setStatus,
    });

    await expect(revealPaneWorktree('/repo/.worktrees/feature')).resolves.toBe(false);
    expect(setStatus).toHaveBeenCalledWith('Finder reveal is unavailable', 'error');
  });

  it('surfaces Finder reveal failures', async () => {
    const setStatus = vi.fn();
    const revealPaneWorktree = compileFunction<
      (path: string | null) => Promise<boolean>
    >(functionSource(mainJs, 'revealPaneWorktree'), {
      opener: {
        revealItemInDir: vi.fn(async () => {
          throw new Error('finder blocked');
        }),
      },
      setStatus,
    });

    await expect(revealPaneWorktree('/repo/.worktrees/feature')).resolves.toBe(false);
    expect(setStatus).toHaveBeenCalledWith(
      'Reveal failed: Error: finder blocked',
      'error',
    );
  });

  it('passes only semantic full values into copy actions', async () => {
    const copyPaneFooterValue = vi.fn(async () => false);
    const revealPaneWorktree = vi.fn(async () => false);
    const toast = vi.fn();
    const runPaneFooterAction = compileFunction<
      (thread: unknown, item: Record<string, unknown>) => Promise<boolean> | boolean
    >(functionSource(mainJs, 'runPaneFooterAction'), {
      copyPaneFooterValue,
      revealPaneWorktree,
      toast,
      paneFooterActionValue: compileFunction<(item: Record<string, unknown>) => string>(
        functionSource(mainJs, 'paneFooterActionValue'),
        {},
      ),
    });

    await expect(runPaneFooterAction({}, {
      label: 'Session ID',
      action: 'copy',
      value: '—',
      fullValue: '',
    })).resolves.toBe(false);
    expect(copyPaneFooterValue).toHaveBeenCalledWith('Session ID', '');
    expect(revealPaneWorktree).not.toHaveBeenCalled();
  });
});

describe('pane footer interaction behavior', () => {
  it('wraps ArrowUp/ArrowDown and jumps Home/End across enabled menu items', () => {
    const document = { activeElement: null as object | null };
    const paneFooterMenuItems = compileFunction<
      (menu: { querySelectorAll: (selector: string) => unknown[] }) => Array<{
        disabled?: boolean;
        focus: () => void;
      }>
    >(functionSource(mainJs, 'paneFooterMenuItems'), {});
    const movePaneFooterMenuFocus = compileFunction<
      (
        menu: { querySelectorAll: (selector: string) => unknown[] },
        key: string,
      ) => boolean
    >(functionSource(mainJs, 'movePaneFooterMenuFocus'), {
      document,
      paneFooterMenuItems,
    });

    const focused: string[] = [];
    function createButton(name: string, disabled = false) {
      const button = {
        disabled,
        focus: () => {
          focused.push(name);
          document.activeElement = button;
        },
      };
      return button;
    }

    const first = createButton('first');
    const disabled = createButton('disabled', true);
    const last = createButton('last');
    const menu = {
      querySelectorAll: (selector: string) => (
        selector === '[role="menuitem"]' ? [first, disabled, last] : []
      ),
    };

    document.activeElement = last;
    expect(movePaneFooterMenuFocus(menu, 'ArrowDown')).toBe(true);
    expect(focused.at(-1)).toBe('first');

    document.activeElement = first;
    expect(movePaneFooterMenuFocus(menu, 'ArrowUp')).toBe(true);
    expect(focused.at(-1)).toBe('last');

    document.activeElement = first;
    expect(movePaneFooterMenuFocus(menu, 'End')).toBe(true);
    expect(focused.at(-1)).toBe('last');

    document.activeElement = last;
    expect(movePaneFooterMenuFocus(menu, 'Home')).toBe(true);
    expect(focused.at(-1)).toBe('first');
  });

  it('closes Escape-restored menus back to the overflow trigger', () => {
    const calls: string[] = [];
    const closePaneFooterMenu = compileFunction<
      (
        threadValue: {
          paneFooterMenuCleanup: (() => void) | null;
          paneFooterMenu: { parentNode: { removeChild: (value: unknown) => void } } | null;
          paneFooterOverflow: {
            setAttribute: (name: string, value: string) => void;
            focus: () => void;
          } | null;
        },
        restoreFocus: boolean,
      ) => void
    >(functionSource(mainJs, 'closePaneFooterMenu'), {});
    const handlePaneFooterMenuKeyDown = compileFunction<
      (
        threadValue: {
          paneFooterMenuCleanup: (() => void) | null;
          paneFooterMenu: { parentNode: { removeChild: (value: unknown) => void } } | null;
          paneFooterOverflow: {
            setAttribute: (name: string, value: string) => void;
            focus: () => void;
          } | null;
        },
        menu: unknown,
        event: {
          key: string;
          preventDefault: () => void;
          stopPropagation: () => void;
        },
      ) => boolean
    >(functionSource(mainJs, 'handlePaneFooterMenuKeyDown'), {
      closePaneFooterMenu,
      movePaneFooterMenuFocus: () => false,
    });

    const thread = {
      paneFooterMenuCleanup: () => { calls.push('cleanup'); },
      paneFooterMenu: {
        parentNode: {
          removeChild: () => { calls.push('remove-menu'); },
        },
      },
      paneFooterOverflow: {
        setAttribute: (name: string, value: string) => { calls.push(`${name}:${value}`); },
        focus: () => { calls.push('focus-trigger'); },
      },
    };

    expect(handlePaneFooterMenuKeyDown(thread, {}, {
      key: 'Escape',
      preventDefault: () => { calls.push('prevent-default'); },
      stopPropagation: () => { calls.push('stop-propagation'); },
    })).toBe(true);
    expect(calls).toEqual([
      'prevent-default',
      'stop-propagation',
      'cleanup',
      'remove-menu',
      'aria-expanded:false',
      'focus-trigger',
    ]);
  });

  it('focuses footer chrome on pointerdown but defers inactive visible-button focus until after click action dispatch', () => {
    const thread = { id: 'thread-a' };
    const state = { activeThreadId: 'thread-b' };
    const calls: string[] = [];
    let queuedFocus: (() => void) | null = null;
    const focusPaneAfterFooterAction = compileFunction<(threadValue: typeof thread) => void>(
      functionSource(mainJs, 'focusPaneAfterFooterAction'),
      {
        state,
        focusThread: (id: string) => { calls.push(`focus:${id}`); },
        requestAnimationFrame: (callback: () => void) => {
          calls.push('queue-focus');
          queuedFocus = callback;
        },
      },
    );
    const handlePaneFooterPointerDown = compileFunction<(
      threadValue: typeof thread,
      event: { target: { closest?: (selector: string) => unknown } | null; stopPropagation: () => void },
    ) => void>(functionSource(mainJs, 'handlePaneFooterPointerDown'), {
      state,
      focusThread: (id: string) => { calls.push(`focus:${id}`); },
    });
    const handlePaneFooterItemClick = compileFunction<(
      threadValue: typeof thread,
      item: Record<string, unknown>,
      event: { stopPropagation: () => void },
      fromOverflowMenu?: boolean,
    ) => unknown>(functionSource(mainJs, 'handlePaneFooterItemClick'), {
      closePaneFooterMenu: (_thread: typeof thread, restoreFocus: boolean) => {
        calls.push(`close-menu:${restoreFocus}`);
      },
      runPaneFooterAction: () => {
        calls.push('run-action');
        return true;
      },
      focusPaneAfterFooterAction: (threadValue: typeof thread) => {
        calls.push('schedule-focus');
        focusPaneAfterFooterAction(threadValue);
      },
    });

    const footerChromeTarget = { closest: () => null };
    handlePaneFooterPointerDown(thread, {
      target: footerChromeTarget,
      stopPropagation: () => { calls.push('stop:chrome'); },
    });
    expect(calls).toEqual(['focus:thread-a', 'stop:chrome']);

    calls.length = 0;
    state.activeThreadId = 'thread-b';
    const buttonTarget = {
      closest: (selector: string) => (selector === 'button' ? buttonTarget : null),
    };
    handlePaneFooterPointerDown(thread, {
      target: buttonTarget,
      stopPropagation: () => { calls.push('stop:button'); },
    });
    expect(calls).toEqual(['stop:button']);

    handlePaneFooterItemClick(thread, {
      label: 'Session ID',
      action: 'copy',
      value: '12345678',
      fullValue: 'session-123',
    }, {
      stopPropagation: () => { calls.push('stop:click'); },
    }, false);
    expect(calls).toEqual([
      'stop:button',
      'stop:click',
      'run-action',
      'close-menu:false',
      'schedule-focus',
      'queue-focus',
    ]);
    expect(queuedFocus).not.toBeNull();
    expect(calls).not.toContain('focus:thread-a');

    const flushFocus = queuedFocus as (() => void) | null;
    if (flushFocus) flushFocus();
    expect(calls).toEqual([
      'stop:button',
      'stop:click',
      'run-action',
      'close-menu:false',
      'schedule-focus',
      'queue-focus',
      'focus:thread-a',
    ]);
  });

  it('restores overflow-trigger focus only for overflow menu activations', () => {
    const overflowTrigger = { id: 'overflow-trigger' };
    const visibleTrigger = { id: 'visible-trigger' };
    const menuItem = { id: 'menu-item' };
    const thread = { id: 'thread-a', paneFooterOverflow: overflowTrigger };
    const calls: string[] = [];
    const handlePaneFooterItemClick = compileFunction<(
      threadValue: typeof thread,
      item: Record<string, unknown>,
      event: { currentTarget: unknown; stopPropagation: () => void },
      fromOverflowMenu?: boolean,
    ) => unknown>(functionSource(mainJs, 'handlePaneFooterItemClick'), {
      closePaneFooterMenu: (_thread: typeof thread, restoreFocus: boolean) => {
        calls.push(`close-menu:${restoreFocus}`);
        if (restoreFocus) calls.push('focus-trigger');
      },
      runPaneFooterAction: (_thread: unknown, _item: unknown, trigger: unknown) => {
        calls.push(`run-action:${(trigger as { id: string }).id}`);
        return true;
      },
      focusPaneAfterFooterAction: () => {
        calls.push('focus-pane');
      },
    });

    handlePaneFooterItemClick(thread, {
      label: 'Branch',
      action: 'copy',
      value: 'feat/footer',
      fullValue: 'feat/footer',
    }, {
      currentTarget: visibleTrigger,
      stopPropagation: () => { calls.push('stop:visible'); },
    }, false);
    expect(calls).toEqual([
      'stop:visible',
      'run-action:visible-trigger',
      'close-menu:false',
      'focus-pane',
    ]);

    calls.length = 0;
    handlePaneFooterItemClick(thread, {
      label: 'Session ID',
      action: 'copy',
      value: '12345678',
      fullValue: 'session-123',
    }, {
      currentTarget: menuItem,
      stopPropagation: () => { calls.push('stop:overflow'); },
    }, true);
    expect(calls).toEqual([
      'stop:overflow',
      'run-action:overflow-trigger',
      'close-menu:true',
      'focus-trigger',
      'focus-pane',
    ]);
  });

  it('keeps usage-dialog focus instead of rerendering or restoring overflow focus', () => {
    const calls: string[] = [];
    const handlePaneFooterItemClick = compileFunction<(
      threadValue: { id: string },
      item: Record<string, unknown>,
      event: { currentTarget: unknown; stopPropagation: () => void },
      fromOverflowMenu?: boolean,
    ) => unknown>(functionSource(mainJs, 'handlePaneFooterItemClick'), {
      closePaneFooterMenu: () => { calls.push('close-menu'); },
      runPaneFooterAction: () => {
        calls.push('open-usage');
        return true;
      },
      focusPaneAfterFooterAction: () => { calls.push('focus-pane'); },
    });

    expect(handlePaneFooterItemClick(
      { id: 'thread-a' },
      { action: 'usage', label: 'Context' },
      {
        currentTarget: { id: 'menu-item' },
        stopPropagation: () => { calls.push('stop'); },
      },
      true,
    )).toBe(true);
    expect(calls).toEqual(['stop', 'open-usage']);
  });
});

describe('pane footer integration contract', () => {
  it('bounds popovers vertically and chooses reachable space around the trigger', () => {
    function position(anchorRect: Record<string, number>, naturalHeight: number) {
      const style: Record<string, string> = {};
      const popover = {
        style,
        getBoundingClientRect: () => ({
          width: 180,
          height: Math.min(naturalHeight, Number.parseFloat(style.maxHeight) || naturalHeight),
        }),
      };
      const positionPaneFooterPopover = compileFunction<
        (popoverValue: typeof popover, anchor: {
          getBoundingClientRect: () => Record<string, number>;
        }) => void
      >(functionSource(mainJs, 'positionPaneFooterPopover'), {
        document: { body: { appendChild: vi.fn() } },
        window: { innerWidth: 240, innerHeight: 120 },
      });

      positionPaneFooterPopover(popover, {
        getBoundingClientRect: () => anchorRect,
      });
      return {
        top: Number.parseFloat(style.top),
        maxHeight: Number.parseFloat(style.maxHeight),
      };
    }

    const above = position({ top: 100, bottom: 110, right: 220 }, 180);
    expect(above.maxHeight).toBe(86);
    expect(above.top).toBeGreaterThanOrEqual(8);
    expect(above.top + above.maxHeight).toBeLessThanOrEqual(112);

    const below = position({ top: 10, bottom: 20, right: 220 }, 180);
    expect(below.maxHeight).toBe(86);
    expect(below.top).toBeGreaterThanOrEqual(8);
    expect(below.top + below.maxHeight).toBeLessThanOrEqual(112);

    expect(stylesCss).toMatch(
      /\.pane-footer-popover\s*\{[\s\S]*max-height:\s*calc\(100vh - 16px\)[\s\S]*overflow-y:\s*auto/,
    );
  });

  it('mounts one footer in every physical pane path, including Git', () => {
    expect(mainJs).toMatch(/function createPaneFooter\(thread\)/);
    expect(mainJs).toMatch(/function syncPaneFooter\(thread\)/);
    expect(functionSource(mainJs, 'mountToolPane')).toContain('createPaneFooter(thread)');
    expect(functionSource(mainJs, 'mountTerminal')).toContain('createPaneFooter(thread)');
    expect(functionSource(mainJs, 'mountBrowserPane')).toContain('createPaneFooter(thread)');
  });

  it('uses a fixed third pane row without wrapping and raises the pane floor', () => {
    expect(stylesCss).toMatch(/--pane-foot-h:\s*27px;/);
    expect(stylesCss).toMatch(
      /\.terminal-pane\s*\{[\s\S]*grid-template-rows:\s*var\(--pane-head-h\)\s+minmax\(0,\s*1fr\)\s+var\(--pane-foot-h\)/,
    );
    expect(stylesCss).toMatch(/\.terminal-pane-footer\s*\{[\s\S]*flex-wrap:\s*nowrap/);
    expect(stylesCss).toMatch(/--pane-min-w:\s*200px;/);
    expect(stylesCss).toMatch(/--pane-min-h:\s*137px;/);
    expect(mainJs).toMatch(
      /var PANE_MINIMUMS = \{ width: 200, height: 137, separator: 6 \};/,
    );
  });

  it('builds footer state from the exact worktree and truthful fallback metrics', () => {
    const worktree = functionSource(mainJs, 'threadWorktree');
    const state = functionSource(mainJs, 'paneFooterState');
    const create = functionSource(mainJs, 'createThread');

    expect(worktree).toMatch(/worktree\.path === thread\.worktreePath/);
    expect(worktree).toMatch(/path:\s*thread\.worktreePath \|\| null/);
    expect(worktree).toMatch(/branch:\s*null/);
    expect(state).toMatch(/PsychePanes\.isAgentPaneKind\(thread\.kind\)/);
    expect(state).toMatch(/thread\.launch\.metricsProvider \|\| "agent"/);
    expect(state).toMatch(/thread\.launch\.covenSessionId/);
    expect(state).toMatch(/isEligibleCoven[\s\S]*loadingPaneMetrics\(thread\.launch\)/);
    expect(state).toMatch(/phase:\s*"ready"/);
    expect(state).toMatch(/costKind:\s*"unknown"/);
    expect(state).toContain('Session metrics are not reported by this harness');
    expect(state).toMatch(/canSwitchModel:\s*false/);
    expect(create).toMatch(
      /metrics:\s*launch\.launchKind === "coven-chat" && launch\.covenSessionId[\s\S]*loadingPaneMetrics\(launch\)/,
    );
  });

  it('starts eligible Coven footer metrics in a truthful loading state', () => {
    const paneFooterState = compileFunction<(thread: Record<string, unknown>) => Record<string, any>>(
      functionSource(mainJs, 'paneFooterState'),
      {
        threadWorktree: () => ({ path: '/repo', branch: 'feat/footer' }),
        PsychePanes: { isAgentPaneKind: () => true },
        shortenRoot: (value: string) => value,
        loadingPaneMetrics: compileFunction(
          functionSource(mainJs, 'loadingPaneMetrics'),
          {},
        ),
      },
    );

    expect(paneFooterState({
      id: 'thread-1',
      kind: 'coven-chat',
      worktreePath: '/repo',
      metrics: null,
      launch: {
        launchKind: 'coven-chat',
        covenSessionId: '12345678-1234-4abc-8def-1234567890ab',
        metricsProvider: 'coven',
      },
    }).metrics).toMatchObject({
      phase: 'loading',
      provider: 'coven',
      sessionId: '12345678-1234-4abc-8def-1234567890ab',
      model: null,
      contextUsed: null,
      contextLimit: null,
      spendUsd: null,
      updatedAt: null,
      error: null,
      stale: false,
    });
  });

  it('keeps non-Coven agent fallback behavior unchanged', () => {
    const paneFooterState = compileFunction<(thread: Record<string, unknown>) => Record<string, any>>(
      functionSource(mainJs, 'paneFooterState'),
      {
        threadWorktree: () => ({ path: '/repo', branch: 'feat/footer' }),
        PsychePanes: { isAgentPaneKind: () => true },
        shortenRoot: (value: string) => value,
        loadingPaneMetrics: vi.fn(),
      },
    );

    expect(paneFooterState({
      id: 'thread-2',
      kind: 'agent-copilot',
      worktreePath: '/repo',
      metrics: null,
      launch: { metricsProvider: 'copilot' },
    }).metrics).toMatchObject({
      phase: 'ready',
      provider: 'copilot',
      error: 'Session metrics are not reported by this harness',
    });
  });

  it('uses one truthful dispatcher for all footer actions', () => {
    const dispatcher = functionSource(mainJs, 'runPaneFooterAction');

    expect(functionSource(mainJs, 'paneFooterActionValue'))
      .toMatch(/typeof item\.fullValue === "string" \? item\.fullValue : ""/);
    expect(dispatcher).toMatch(/item\.action === "copy"[\s\S]*copyPaneFooterValue\(item\.label,\s*paneFooterActionValue\(item\)\)/);
    expect(dispatcher).toMatch(/item\.action === "reveal"[\s\S]*revealPaneWorktree\(paneFooterActionValue\(item\)\)/);
    expect(dispatcher).toMatch(
      /item\.action === "usage"[\s\S]*openPaneUsagePopover\(thread,\s*trigger\)/,
    );
    expect(dispatcher).toMatch(/item\.action === "switch-model"[\s\S]*toast\(item\.label \+ " is not reported"\)/);
    expect(dispatcher).not.toMatch(/switchPaneFooterModel|showPaneUsage/);
  });

  it('creates accessible item buttons, observes pane width, and focuses chrome safely', () => {
    const create = functionSource(mainJs, 'createPaneFooter');

    expect(create).toMatch(/className = "terminal-pane-footer"/);
    expect(create).toMatch(/setAttribute\("aria-label", "Pane details"\)/);
    expect(create).toMatch(/className = "terminal-pane-footer-items"/);
    expect(create).toMatch(/className = "terminal-pane-footer-overflow"/);
    expect(create).toMatch(/data-footer-key|dataset\.footerKey/);
    expect(create).toMatch(/paneFooterItemDescription\(item\)/);
    expect(create).toMatch(
      /handlePaneFooterItemClick\(thread, item, event, role === "menuitem"\)/,
    );
    expect(create).toMatch(/syncPaneFooter\(thread,\s*true,\s*event\.currentTarget\)/);
    expect(create).toMatch(/handlePaneFooterPointerDown\(thread, event\)/);
    expect(create).toMatch(/new ResizeObserver[\s\S]*PsychePanes\.footerTier/);
    expect(create).toMatch(/observer\.observe\(thread\.pane \|\| footer\)/);
    expect(create).toMatch(/thread\.paneFooter = footer/);
    expect(create).toMatch(/thread\.paneFooterObserver = observer/);
  });

  it('keeps collapsed controls keyboard reachable in a real overflow menu', () => {
    const sync = functionSource(mainJs, 'syncPaneFooter');
    const moveFocus = functionSource(mainJs, 'movePaneFooterMenuFocus');
    const onMenuKeyDown = functionSource(mainJs, 'handlePaneFooterMenuKeyDown');

    expect(sync).toMatch(/PsychePanes\.footerItems\(paneFooterState\(thread\)\)/);
    expect(sync).toMatch(/PsychePanes\.hiddenFooterKeys\(currentTier, isAgentPaneKind\)/);
    expect(sync).toMatch(/setAttribute\("role", "menu"\)/);
    expect(sync).toMatch(/setAttribute\("role", "menuitem"\)/);
    expect(sync).toMatch(/thread\.createPaneFooterButton\(item, "menuitem"\)/);
    expect(functionSource(mainJs, 'createPaneFooter'))
      .toMatch(/handlePaneFooterItemClick\(thread, item, event, role === "menuitem"\)/);
    expect(moveFocus).toMatch(/key === "ArrowUp"/);
    expect(moveFocus).toMatch(/key === "ArrowDown"/);
    expect(moveFocus).toMatch(/key === "Home"/);
    expect(moveFocus).toMatch(/key === "End"/);
    expect(onMenuKeyDown).toMatch(/event\.key === "Escape"/);
    expect(onMenuKeyDown).toMatch(/closePaneFooterMenu\(thread,\s*true\)/);
    expect(functionSource(mainJs, 'closePaneFooterMenu'))
      .toMatch(/paneFooterMenuTrigger \|\| thread\.paneFooterOverflow[\s\S]*trigger\.focus\(\)/);
    expect(sync).toMatch(/document\.addEventListener\("pointerdown", onOutsidePointerDown, true\)/);
    expect(sync).toMatch(/document\.addEventListener\("keydown", onMenuKeyDown, true\)/);
    expect(sync).toMatch(/function onOutsidePointerDown[\s\S]*closePaneFooterMenu\(thread,\s*false\)/);
  });

  it('syncs and releases footer resources with the pane lifecycle', () => {
    expect(functionSource(mainJs, 'syncThreadPaneMetadata')).toMatch(/syncPaneFooter\(thread\)/);
    expect(functionSource(mainJs, 'syncPaneFooter'))
      .toMatch(/closePaneUsagePopoverForFooter\(thread,\s*false\)[\s\S]*innerHTML = ""/);
    const detach = functionSource(mainJs, 'detachThreadPane');
    expect(detach).toMatch(/thread\.paneFooterObserver\.disconnect\(\)/);
    expect(detach).toMatch(/thread\.paneFooter = null/);
    expect(detach).toMatch(/thread\.paneFooterItems = null/);
    expect(detach).toMatch(/thread\.paneFooterOverflow = null/);
    expect(functionSource(mainJs, 'closeThread'))
      .toMatch(/clearTimeout\(thread\.metricsRefreshTimer\)/);
  });

  it('scopes usage outside-pointer exemptions to the active dialog and trigger', () => {
    const handler = functionSource(mainJs, 'handlePaneFooterPopoverPointerDown');

    expect(handler).toMatch(/paneFooterPopover\.contains\(target\)/);
    expect(handler).toMatch(/paneFooterPopoverTrigger\.contains\(target\)/);
    expect(handler).toMatch(/closePaneFooterPopovers\(false\)/);
    expect(handler).not.toContain('.terminal-pane-footer');
    expect(mainJs).toMatch(
      /document\.addEventListener\("pointerdown", handlePaneFooterPopoverPointerDown, true\)/,
    );
  });
});
