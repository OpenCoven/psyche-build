import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const repoRoot = process.cwd();
const tauriRoot = join(repoRoot, 'native/macos/psyche-build-tauri');
const panesRoot = join(repoRoot, 'native/macos/psyche-build-tauri/web/panes');
const footerModule = await import(pathToFileURL(join(panesRoot, 'pane-footer.mjs')).href);
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
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);
const stylesCss = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/styles.css'),
  'utf8',
);

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
    const thread = { id: 'thread-a' };
    const calls: string[] = [];
    const handlePaneFooterItemClick = compileFunction<(
      threadValue: typeof thread,
      item: Record<string, unknown>,
      event: { stopPropagation: () => void },
      fromOverflowMenu?: boolean,
    ) => unknown>(functionSource(mainJs, 'handlePaneFooterItemClick'), {
      closePaneFooterMenu: (_thread: typeof thread, restoreFocus: boolean) => {
        calls.push(`close-menu:${restoreFocus}`);
        if (restoreFocus) calls.push('focus-trigger');
      },
      runPaneFooterAction: () => {
        calls.push('run-action');
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
      stopPropagation: () => { calls.push('stop:visible'); },
    }, false);
    expect(calls).toEqual([
      'stop:visible',
      'run-action',
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
      stopPropagation: () => { calls.push('stop:overflow'); },
    }, true);
    expect(calls).toEqual([
      'stop:overflow',
      'run-action',
      'close-menu:true',
      'focus-trigger',
      'focus-pane',
    ]);
  });
});

describe('pane footer integration contract', () => {
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

    expect(worktree).toMatch(/worktree\.path === thread\.worktreePath/);
    expect(worktree).toMatch(/path:\s*thread\.worktreePath \|\| null/);
    expect(worktree).toMatch(/branch:\s*null/);
    expect(state).toMatch(/PsychePanes\.isAgentPaneKind\(thread\.kind\)/);
    expect(state).toMatch(/thread\.launch\.metricsProvider \|\| "agent"/);
    expect(state).toMatch(/thread\.launch\.covenSessionId/);
    expect(state).toMatch(/phase:\s*"ready"/);
    expect(state).toMatch(/costKind:\s*"unknown"/);
    expect(state).toContain('Session metrics are not reported by this harness');
    expect(state).toMatch(/canSwitchModel:\s*false/);
    expect(state).not.toContain('"loading"');
  });

  it('uses the launch-owned Coven identity and provider in footer state', () => {
    const paneFooterState = compileFunction<(thread: Record<string, unknown>) => Record<string, any>>(
      functionSource(mainJs, 'paneFooterState'),
      {
        threadWorktree: () => ({ path: '/repo', branch: 'feat/footer' }),
        PsychePanes: { isAgentPaneKind: () => true },
        shortenRoot: (value: string) => value,
      },
    );

    expect(paneFooterState({
      id: 'thread-1',
      kind: 'coven-chat',
      worktreePath: '/repo',
      metrics: null,
      launch: {
        covenSessionId: '12345678-1234-4abc-8def-1234567890ab',
        metricsProvider: 'coven',
      },
    }).metrics).toMatchObject({
      provider: 'coven',
      sessionId: '12345678-1234-4abc-8def-1234567890ab',
    });
  });

  it('uses one truthful dispatcher for all footer actions', () => {
    const dispatcher = functionSource(mainJs, 'runPaneFooterAction');

    expect(functionSource(mainJs, 'paneFooterActionValue'))
      .toMatch(/typeof item\.fullValue === "string" \? item\.fullValue : ""/);
    expect(dispatcher).toMatch(/item\.action === "copy"[\s\S]*copyPaneFooterValue\(item\.label,\s*paneFooterActionValue\(item\)\)/);
    expect(dispatcher).toMatch(/item\.action === "reveal"[\s\S]*revealPaneWorktree\(paneFooterActionValue\(item\)\)/);
    expect(dispatcher).toMatch(/item\.action === "usage"[\s\S]*toast\(item\.label \+ " is not reported"\)/);
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
    expect(create).toMatch(/handlePaneFooterItemClick\(thread, item, event, role === "menuitem"\)/);
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
    expect(sync).toMatch(/document\.addEventListener\("pointerdown", onOutsidePointerDown, true\)/);
    expect(sync).toMatch(/document\.addEventListener\("keydown", onMenuKeyDown, true\)/);
    expect(sync).toMatch(/function onOutsidePointerDown[\s\S]*closePaneFooterMenu\(thread,\s*false\)/);
  });

  it('syncs and releases footer resources with the pane lifecycle', () => {
    expect(functionSource(mainJs, 'syncThreadPaneMetadata')).toMatch(/syncPaneFooter\(thread\)/);
    const detach = functionSource(mainJs, 'detachThreadPane');
    expect(detach).toMatch(/thread\.paneFooterObserver\.disconnect\(\)/);
    expect(detach).toMatch(/thread\.paneFooter = null/);
    expect(detach).toMatch(/thread\.paneFooterItems = null/);
    expect(detach).toMatch(/thread\.paneFooterOverflow = null/);
  });
});
