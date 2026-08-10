import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const panesRoot = join(repoRoot, 'native/macos/psyche-build-tauri/web/panes');
const footerModule = await import(pathToFileURL(join(panesRoot, 'pane-footer.mjs')).href);

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
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);
const stylesCss = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/styles.css'),
  'utf8',
);

describe.skip('pane footer integration contract', () => {
  it('mounts one footer in terminal and Web panes', () => {
    expect(mainJs).toMatch(/function createPaneFooter\(thread\)/);
    expect(mainJs).toMatch(/function mountTerminal\(thread\)[\s\S]*createPaneFooter\(thread\)/);
    expect(mainJs).toMatch(/function mountBrowserPane\(thread\)[\s\S]*createPaneFooter\(thread\)/);
  });

  it('uses a fixed third pane row without wrapping', () => {
    expect(stylesCss).toMatch(
      /\.terminal-pane\s*\{[\s\S]*grid-template-rows:\s*var\(--pane-head-h\)\s+minmax\(0,\s*1fr\)\s+27px/,
    );
    expect(stylesCss).toMatch(/\.terminal-pane-footer\s*\{[\s\S]*flex-wrap:\s*nowrap/);
  });
});
