import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_INK_CHROME_TRIGGER,
  EXISTING_INK_BINDINGS,
  MAX_INK_KEY_LENGTH,
  RESERVED_INK_CHORDS,
  VIM_INK_FIXTURE_VERSION,
  VIM_INK_PRECEDENCE_TABLE,
  VIM_INK_PRECEDENCE_VERSION,
  VIM_INK_SEMANTIC_OPS,
  isClaimableInkTrigger,
  resolveKeyForInk,
  validateChromeTriggerForInk,
  type VimInkKey,
  type VimInkModifierClass,
  type VimInkResolution,
  type VimInkSemanticOpEntry,
  type VimInkSurfaceState,
} from '../src/vim/inkPrecedence.js';
import { describe, expect, it } from 'vitest';

function inkKey(
  key: string,
  modifiers: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {},
): VimInkKey {
  return {
    key,
    ctrl: modifiers.ctrl ?? false,
    alt: modifiers.alt ?? false,
    shift: modifiers.shift ?? false,
    meta: modifiers.meta ?? false,
  };
}

function modifiersFor(modifiers: VimInkModifierClass): Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> {
  switch (modifiers) {
    case 'plain':
      return {};
    case 'shift':
      return { shift: true };
    case 'ctrl':
      return { ctrl: true };
    case 'plain-or-shift':
    case 'any':
      return {};
  }
}

/** Minimal surface state satisfying exactly the given binding guards. */
function surfaceForGuards(guards: readonly string[]): VimInkSurfaceState {
  const surface: {
    paneSelected?: boolean;
    desktopUsePaneSelected?: boolean;
    projectActionAvailable?: boolean;
    controlPanePresent?: boolean;
    devMode?: boolean;
    startupPrimerVisible?: boolean;
    loading?: boolean;
  } = {};
  for (const guard of guards) {
    switch (guard) {
      case 'pane-selected':
        surface.paneSelected = true;
        break;
      case 'desktop-use-pane-selected':
        surface.desktopUsePaneSelected = true;
        break;
      case 'project-action-available':
        surface.projectActionAvailable = true;
        break;
      case 'control-pane-present':
        surface.controlPanePresent = true;
        break;
      case 'dev-mode':
        surface.devMode = true;
        break;
      case 'startup-primer-visible':
        surface.startupPrimerVisible = true;
        break;
      case 'not-loading':
        surface.loading = false;
        break;
      default:
        throw new Error(`unexpected guard ${guard}`);
    }
  }
  return surface;
}

/** Surface where every static guard is satisfied, mirroring a fully available chain. */
const FULL_SURFACE: VimInkSurfaceState = {
  paneSelected: true,
  desktopUsePaneSelected: true,
  projectActionAvailable: true,
  controlPanePresent: true,
  devMode: true,
  startupPrimerVisible: true,
  loading: false,
};

const IDENTITY_KEYS: readonly { label: string; key: VimInkKey }[] = [
  { label: 'reserved Ctrl+C', key: inkKey('c', { ctrl: true }) },
  { label: 'colon command', key: inkKey(':') },
  { label: 'side panel toggle', key: inkKey('z') },
  { label: 'arrow up', key: inkKey('ArrowUp') },
  { label: 'arrow down', key: inkKey('ArrowDown') },
  { label: 'arrow left', key: inkKey('ArrowLeft') },
  { label: 'arrow right', key: inkKey('ArrowRight') },
  { label: 'plain h', key: inkKey('h') },
  { label: 'plain j', key: inkKey('j') },
  { label: 'plain k', key: inkKey('k') },
  { label: 'plain l', key: inkKey('l') },
  { label: 'plain q (quit)', key: inkKey('q') },
  { label: 'plain s (settings)', key: inkKey('s') },
  { label: 'plain r (reopen)', key: inkKey('r') },
  { label: 'plain n (new agent)', key: inkKey('n') },
  { label: 'plain t (new terminal)', key: inkKey('t') },
  { label: 'plain d (new desktop-use)', key: inkKey('d') },
  { label: 'plain o (open session)', key: inkKey('o') },
  { label: 'plain e (rename)', key: inkKey('e') },
  { label: 'plain u (rituals)', key: inkKey('u') },
  { label: 'plain a', key: inkKey('a') },
  { label: 'plain m', key: inkKey('m') },
  { label: 'plain p (add project)', key: inkKey('p') },
  { label: 'shift h', key: inkKey('h', { shift: true }) },
  { label: 'shift l', key: inkKey('l', { shift: true }) },
  { label: 'shift p', key: inkKey('p', { shift: true }) },
  { label: 'shift n', key: inkKey('n', { shift: true }) },
  { label: 'shift r', key: inkKey('r', { shift: true }) },
  { label: 'shift s', key: inkKey('s', { shift: true }) },
  { label: 'shift t', key: inkKey('t', { shift: true }) },
  { label: 'shift a', key: inkKey('a', { shift: true }) },
  { label: 'shift x', key: inkKey('x', { shift: true }) },
  { label: 'shift d (primer)', key: inkKey('d', { shift: true }) },
  { label: 'question mark', key: inkKey('?') },
  { label: 'slash', key: inkKey('/') },
  { label: 'Enter', key: inkKey('Enter') },
  { label: 'Escape', key: inkKey('Escape') },
  { label: 'plain g (sequence starter)', key: inkKey('g') },
  { label: 'shift g (G)', key: inkKey('g', { shift: true }) },
  { label: 'ctrl w (sequence starter)', key: inkKey('w', { ctrl: true }) },
  { label: 'resize +', key: inkKey('+') },
  { label: 'resize -', key: inkKey('-') },
  { label: 'resize <', key: inkKey('<') },
  { label: 'resize >', key: inkKey('>') },
  { label: 'resize =', key: inkKey('=') },
  { label: 'unknown letter', key: inkKey('Ω') },
  { label: 'digit', key: inkKey('1') },
  { label: 'unbound function key', key: inkKey('F7') },
  { label: 'alt h', key: inkKey('h', { alt: true }) },
  { label: 'meta k', key: inkKey('k', { meta: true }) },
];

const EXISTING_OR_PASSTHROUGH: readonly VimInkResolution['outcome'][] = ['existing-binding', 'passthrough'];

describe('Vim Ink precedence v1', () => {
  describe('disabled-mode identity', () => {
    it.each(IDENTITY_KEYS)('is unchanged for $label', ({ key }) => {
      for (const surface of [{}, FULL_SURFACE] as const) {
        const disabled = resolveKeyForInk(key, { vimEnabled: false, chromeContext: 'inactive', surface });
        const enabledInactive = resolveKeyForInk(key, { vimEnabled: true, chromeContext: 'inactive', surface });
        expect(disabled).toEqual(enabledInactive);
        expect(EXISTING_OR_PASSTHROUGH).toContain(disabled.outcome);
      }
    });

    it('claims only the chrome trigger differently when enabled but not in chrome mode', () => {
      // Disabled: the trigger itself is short-circuited.
      expect(resolveKeyForInk(inkKey('F6'), { vimEnabled: false, chromeContext: 'inactive' })).toEqual({
        outcome: 'passthrough',
        stage: 'terminal-passthrough',
      });
      // Enabled and inactive: the claimable trigger enters chrome mode.
      expect(resolveKeyForInk(inkKey('F6'), { vimEnabled: true, chromeContext: 'inactive' })).toEqual({
        outcome: 'chrome-op',
        stage: 'chrome-mode-gate',
        op: 'chrome.enter',
      });
    });

    it('never claims a key for the semantic layer while disabled', () => {
      for (const entry of VIM_INK_SEMANTIC_OPS) {
        const key = inkKey(entry.key, modifiersFor(entry.modifiers));
        const resolution = resolveKeyForInk(key, { vimEnabled: false, chromeContext: entry.context, pendingSequence: entry.pending });
        if (entry.pending === '') {
          expect(EXISTING_OR_PASSTHROUGH).toContain(resolution.outcome);
        } else {
          // A pending sequence must never fall through, even while disabled.
          expect(resolution).toEqual({ outcome: 'rejected', stage: 'vim-semantic-ops', reason: 'inconsistent-snapshot' });
        }
      }
      expect(resolveKeyForInk(inkKey('F6'), { vimEnabled: false, chromeContext: 'inactive' })).toEqual({
        outcome: 'passthrough',
        stage: 'terminal-passthrough',
      });
    });
  });

  describe('chrome-mode gate', () => {
    it.each([
      { label: 'default trigger F6 enters chrome mode', key: inkKey('F6'), context: 'inactive' as const, trigger: undefined, expected: { outcome: 'chrome-op', stage: 'chrome-mode-gate', op: 'chrome.enter' } },
      { label: 'rebound trigger F2 enters chrome mode', key: inkKey('F2'), context: 'inactive' as const, trigger: inkKey('F2'), expected: { outcome: 'chrome-op', stage: 'chrome-mode-gate', op: 'chrome.enter' } },
      { label: 'non-trigger F2 is passthrough under the default trigger', key: inkKey('F2'), context: 'inactive' as const, trigger: undefined, expected: { outcome: 'passthrough', stage: 'terminal-passthrough' } },
      { label: 'shift-modified trigger does not enter', key: inkKey('F6', { shift: true }), context: 'inactive' as const, trigger: undefined, expected: { outcome: 'passthrough', stage: 'terminal-passthrough' } },
      { label: 'ctrl-modified trigger does not enter', key: inkKey('F6', { ctrl: true }), context: 'inactive' as const, trigger: undefined, expected: { outcome: 'passthrough', stage: 'terminal-passthrough' } },
      { label: 'trigger press inside chrome mode is rejected, not a double-enter', key: inkKey('F6'), context: 'chrome-normal' as const, trigger: undefined, expected: { outcome: 'rejected', stage: 'vim-semantic-ops', reason: 'unsupported-in-chrome' } },
      { label: 'trigger press inside chrome search is rejected', key: inkKey('F6'), context: 'chrome-search' as const, trigger: undefined, expected: { outcome: 'rejected', stage: 'vim-semantic-ops', reason: 'unsupported-in-chrome' } },
      { label: 'Esc exits chrome-normal', key: inkKey('Escape'), context: 'chrome-normal' as const, trigger: undefined, expected: { outcome: 'chrome-op', stage: 'chrome-mode-gate', op: 'chrome.exit' } },
      { label: 'Esc exits chrome-search', key: inkKey('Escape'), context: 'chrome-search' as const, trigger: undefined, expected: { outcome: 'chrome-op', stage: 'chrome-mode-gate', op: 'chrome.exit' } },
      { label: 'Esc exits chrome mode even with a pending sequence', key: inkKey('Escape'), context: 'chrome-normal' as const, trigger: undefined, pendingSequence: 'g' as const, expected: { outcome: 'chrome-op', stage: 'chrome-mode-gate', op: 'chrome.exit' } },
      { label: 'Esc outside chrome mode is not a chrome op', key: inkKey('Escape'), context: 'inactive' as const, trigger: undefined, expected: { outcome: 'passthrough', stage: 'terminal-passthrough' } },
    ])('$label', ({ key, context, trigger, pendingSequence, expected }) => {
      expect(resolveKeyForInk(key, { vimEnabled: true, chromeContext: context, trigger, pendingSequence })).toEqual(expected);
    });

    it.each([
      { label: 'does not enter while input-gated', key: inkKey('F6'), surface: { inputGated: true } },
      { label: 'does not enter while busy', key: inkKey('F6'), surface: { busy: true } },
    ])('$label', ({ key, surface }) => {
      expect(resolveKeyForInk(key, { vimEnabled: true, chromeContext: 'inactive', surface })).toEqual({
        outcome: 'existing-binding',
        stage: 'pre-adapter-gate',
        binding: 'chain.input-gate',
      });
    });

    it('keeps chrome keys behind the pre-adapter gate', () => {
      expect(
        resolveKeyForInk(inkKey('h'), { vimEnabled: true, chromeContext: 'chrome-normal', surface: { inputGated: true } }),
      ).toEqual({ outcome: 'existing-binding', stage: 'pre-adapter-gate', binding: 'chain.input-gate' });
    });

    it('keeps the reserved Ctrl+C chord above chrome mode in every state', () => {
      const expected = { outcome: 'existing-binding', stage: 'reserved-chord', binding: 'lifecycle.quit-confirm' };
      expect(resolveKeyForInk(inkKey('c', { ctrl: true }), { vimEnabled: false, chromeContext: 'inactive' })).toEqual(expected);
      expect(resolveKeyForInk(inkKey('c', { ctrl: true }), { vimEnabled: true, chromeContext: 'inactive' })).toEqual(expected);
      expect(resolveKeyForInk(inkKey('c', { ctrl: true }), { vimEnabled: true, chromeContext: 'chrome-normal' })).toEqual(expected);
    });

    describe('trigger claimability', () => {
      it('accepts function-key triggers', () => {
        expect(() => validateChromeTriggerForInk(inkKey('F6'))).not.toThrow();
        expect(() => validateChromeTriggerForInk(inkKey('F2'))).not.toThrow();
        expect(isClaimableInkTrigger(inkKey('F6'))).toBe(true);
      });

      it.each([
        { label: 'reserved Ctrl+C', trigger: inkKey('c', { ctrl: true }) },
        { label: 'existing binding colon', trigger: inkKey(':') },
        { label: 'existing binding h', trigger: inkKey('h') },
        { label: 'existing binding q', trigger: inkKey('q') },
        { label: 'shifted existing binding H', trigger: inkKey('h', { shift: true }) },
      ])('rejects $label as a trigger', ({ trigger }) => {
        expect(() => validateChromeTriggerForInk(trigger)).toThrow(TypeError);
        expect(isClaimableInkTrigger(trigger)).toBe(false);
      });

      it('leaves keys of an unclaimable trigger with the existing chain', () => {
        expect(
          resolveKeyForInk(inkKey('h'), { vimEnabled: true, chromeContext: 'inactive', trigger: inkKey('h') }),
        ).toEqual({ outcome: 'existing-binding', stage: 'existing-ink-bindings', binding: 'panes.toggle-visibility' });
        expect(
          resolveKeyForInk(inkKey('c', { ctrl: true }), { vimEnabled: true, chromeContext: 'inactive', trigger: inkKey('c', { ctrl: true }) }),
        ).toEqual({ outcome: 'existing-binding', stage: 'reserved-chord', binding: 'lifecycle.quit-confirm' });
      });
    });
  });

  describe('existing-binding precedence is preserved (no shadowing)', () => {
    it.each(
      EXISTING_INK_BINDINGS.map((binding) => ({ label: binding.id, binding })),
    )('$label stays with the existing chain outside chrome mode', ({ binding }) => {
      const key = inkKey(binding.key, modifiersFor(binding.modifiers));
      const surface = surfaceForGuards(binding.guards);
      const expected = { outcome: 'existing-binding', stage: 'existing-ink-bindings', binding: binding.id };
      expect(resolveKeyForInk(key, { vimEnabled: false, chromeContext: 'inactive', surface })).toEqual(expected);
      expect(resolveKeyForInk(key, { vimEnabled: true, chromeContext: 'inactive', surface })).toEqual(expected);
    });

    it.each([
      {
        label: 'h keeps pane visibility outside chrome and moves focus inside',
        key: inkKey('h'),
        surface: undefined,
        outside: { outcome: 'existing-binding', stage: 'existing-ink-bindings', binding: 'panes.toggle-visibility' },
        inside: { outcome: 'semantic-op', stage: 'vim-semantic-ops', result: { disposition: 'action', action: { type: 'focus.move', direction: 'left' } } },
      },
      {
        label: 'r keeps worktree reopen outside chrome and refreshes target inside',
        key: inkKey('r'),
        surface: undefined,
        outside: { outcome: 'existing-binding', stage: 'existing-ink-bindings', binding: 'panes.reopen-worktrees' },
        inside: { outcome: 'semantic-op', stage: 'vim-semantic-ops', result: { disposition: 'action', action: { type: 'target.refresh' } } },
      },
      {
        label: 'n keeps agent creation outside chrome and is rejected in chrome-normal',
        key: inkKey('n'),
        surface: { loading: false },
        outside: { outcome: 'existing-binding', stage: 'existing-ink-bindings', binding: 'panes.new-agent' },
        inside: { outcome: 'rejected', stage: 'vim-semantic-ops', reason: 'unsupported-in-chrome' },
      },
      {
        label: '? keeps the shortcuts popup outside chrome and opens help inside',
        key: inkKey('?', { shift: true }),
        outside: { outcome: 'existing-binding', stage: 'existing-ink-bindings', binding: 'help.shortcuts-popup' },
        inside: { outcome: 'semantic-op', stage: 'vim-semantic-ops', result: { disposition: 'action', action: { type: 'help.open' } } },
      },
      {
        label: 'Enter keeps the pane menu outside chrome and activates focus inside',
        key: inkKey('Enter'),
        surface: { paneSelected: true },
        outside: { outcome: 'existing-binding', stage: 'existing-ink-bindings', binding: 'panes.open-pane-menu' },
        inside: { outcome: 'semantic-op', stage: 'vim-semantic-ops', result: { disposition: 'action', action: { type: 'focus.activate' } } },
      },
      {
        label: 'q keeps quit outside chrome and is consumed inside (no lifecycle bypass)',
        key: inkKey('q'),
        surface: undefined,
        outside: { outcome: 'existing-binding', stage: 'existing-ink-bindings', binding: 'lifecycle.quit' },
        inside: { outcome: 'rejected', stage: 'vim-semantic-ops', reason: 'unsupported-in-chrome' },
      },
      {
        label: 'j keeps the pane shortcut outside chrome and moves focus inside',
        key: inkKey('j'),
        surface: { paneSelected: true },
        outside: { outcome: 'existing-binding', stage: 'existing-ink-bindings', binding: 'panes.pane-shortcut-j' },
        inside: { outcome: 'semantic-op', stage: 'vim-semantic-ops', result: { disposition: 'action', action: { type: 'focus.move', direction: 'down' } } },
      },
      {
        label: 'x keeps the pane shortcut outside chrome and requests guarded close inside',
        key: inkKey('x'),
        surface: { paneSelected: true },
        outside: { outcome: 'existing-binding', stage: 'existing-ink-bindings', binding: 'panes.pane-shortcut-x' },
        inside: { outcome: 'semantic-op', stage: 'vim-semantic-ops', result: { disposition: 'action', action: { type: 'target.close' } } },
      },
      {
        label: 'slash is passthrough outside chrome and opens search inside',
        key: inkKey('/'),
        surface: undefined,
        outside: { outcome: 'passthrough', stage: 'terminal-passthrough' },
        inside: { outcome: 'semantic-op', stage: 'vim-semantic-ops', result: { disposition: 'action', action: { type: 'search.open' } } },
      },
      {
        label: 'arrow left keeps navigation outside chrome and is consumed inside',
        key: inkKey('ArrowLeft'),
        surface: undefined,
        outside: { outcome: 'existing-binding', stage: 'existing-ink-bindings', binding: 'navigation.focus-left' },
        inside: { outcome: 'rejected', stage: 'vim-semantic-ops', reason: 'unsupported-in-chrome' },
      },
    ])('$label', ({ key, surface, outside, inside }) => {
      expect(resolveKeyForInk(key, { vimEnabled: true, chromeContext: 'inactive', surface })).toEqual(outside);
      expect(resolveKeyForInk(key, { vimEnabled: true, chromeContext: 'chrome-normal', surface })).toEqual(inside);
    });

    it.each([
      { label: 'j without a selected pane', key: inkKey('j'), surface: undefined },
      { label: 'L without a control pane', key: inkKey('l', { shift: true }), surface: undefined },
      { label: 'S outside dev mode', key: inkKey('s', { shift: true }), surface: undefined },
      { label: 'n while loading', key: inkKey('n'), surface: { loading: true } },
    ])('$label falls through to passthrough', ({ key, surface }) => {
      expect(resolveKeyForInk(key, { vimEnabled: true, chromeContext: 'inactive', surface })).toEqual({
        outcome: 'passthrough',
        stage: 'terminal-passthrough',
      });
    });

    it('respects chain order for guarded Enter variants', () => {
      expect(
        resolveKeyForInk(inkKey('Enter'), {
          vimEnabled: true,
          chromeContext: 'inactive',
          surface: { loading: false, projectActionAvailable: true },
        }),
      ).toEqual({ outcome: 'existing-binding', stage: 'existing-ink-bindings', binding: 'projects.activate-action' });
      expect(
        resolveKeyForInk(inkKey('Enter'), { vimEnabled: true, chromeContext: 'inactive', surface: { paneSelected: true } }),
      ).toEqual({ outcome: 'existing-binding', stage: 'existing-ink-bindings', binding: 'panes.open-pane-menu' });
    });

    it('prefers the desktop-use quick action for shared letters when that pane is selected', () => {
      expect(
        resolveKeyForInk(inkKey('g'), { vimEnabled: true, chromeContext: 'inactive', surface: { desktopUsePaneSelected: true } }),
      ).toEqual({ outcome: 'existing-binding', stage: 'existing-ink-bindings', binding: 'panes.desktop-use-screenshot' });
      expect(
        resolveKeyForInk(inkKey('g'), { vimEnabled: true, chromeContext: 'inactive' }),
      ).toEqual({ outcome: 'passthrough', stage: 'terminal-passthrough' });
    });
  });

  describe('semantic ops mirror the shared vim/v1 chrome keymap', () => {
    it.each(
      VIM_INK_SEMANTIC_OPS.map((entry, index) => ({
        label: `${index + 1}: ${entry.context}${entry.pending ? ` after ${entry.pending}` : ''} "${entry.key}"`,
        entry,
      })),
    )('$label resolves as mapped', ({ entry }: { entry: VimInkSemanticOpEntry }) => {
      const key = inkKey(entry.key, modifiersFor(entry.modifiers));
      expect(
        resolveKeyForInk(key, {
          vimEnabled: true,
          chromeContext: entry.context,
          pendingSequence: entry.pending,
        }),
      ).toEqual({ outcome: 'semantic-op', stage: 'vim-semantic-ops', result: entry.then });
    });

    it('resolves the full Ctrl-w pane sequence through the pending snapshot', () => {
      const prefix = resolveKeyForInk(inkKey('w', { ctrl: true }), { vimEnabled: true, chromeContext: 'chrome-normal' });
      expect(prefix).toEqual({
        outcome: 'semantic-op',
        stage: 'vim-semantic-ops',
        result: { disposition: 'pending', pending: 'Ctrl-w' },
      });
      expect(
        resolveKeyForInk(inkKey('k'), {
          vimEnabled: true,
          chromeContext: 'chrome-normal',
          pendingSequence: 'Ctrl-w',
        }),
      ).toEqual({
        outcome: 'semantic-op',
        stage: 'vim-semantic-ops',
        result: { disposition: 'action', action: { type: 'pane.focus', direction: 'up' } },
      });
      expect(
        resolveKeyForInk(inkKey('g'), {
          vimEnabled: true,
          chromeContext: 'chrome-normal',
          pendingSequence: 'g',
        }),
      ).toEqual({
        outcome: 'semantic-op',
        stage: 'vim-semantic-ops',
        result: { disposition: 'action', action: { type: 'focus.first' } },
      });
    });
  });

  describe('unknown key rejection inside chrome mode', () => {
    it.each([
      { label: 'unmapped letter q', key: inkKey('q') },
      { label: 'unmapped letter s', key: inkKey('s') },
      { label: 'colon', key: inkKey(':') },
      { label: 'digit', key: inkKey('1') },
      { label: 'unknown unicode', key: inkKey('Ω') },
      { label: 'arrow key', key: inkKey('ArrowUp') },
      { label: 'unbound function key', key: inkKey('F7') },
      { label: 'alt-modified h', key: inkKey('h', { alt: true }) },
      { label: 'meta-modified k', key: inkKey('k', { meta: true }) },
    ])('rejects $label in chrome-normal without side effects', ({ key }) => {
      expect(resolveKeyForInk(key, { vimEnabled: true, chromeContext: 'chrome-normal' })).toEqual({
        outcome: 'rejected',
        stage: 'vim-semantic-ops',
        reason: 'unsupported-in-chrome',
      });
    });

    it.each([
      { label: 'plain a', key: inkKey('a') },
      { label: 'question mark', key: inkKey('?') },
      { label: 'Enter', key: inkKey('Enter') },
      { label: 'arrow down', key: inkKey('ArrowDown') },
    ])('rejects $label in chrome-search (the shared machine owns search input)', ({ key }) => {
      expect(resolveKeyForInk(key, { vimEnabled: true, chromeContext: 'chrome-search' })).toEqual({
        outcome: 'rejected',
        stage: 'vim-semantic-ops',
        reason: 'unsupported-in-chrome',
      });
    });

    it.each([
      { label: 'invalid Ctrl-w continuation q', key: inkKey('q'), pending: 'Ctrl-w' as const },
      { label: 'invalid Ctrl-w continuation g', key: inkKey('g'), pending: 'Ctrl-w' as const },
      { label: 'invalid g continuation x', key: inkKey('x'), pending: 'g' as const },
      { label: 'alt-modified Ctrl-w continuation h', key: inkKey('h', { alt: true }), pending: 'Ctrl-w' as const },
    ])('rejects $label without falling through to the chain', ({ key, pending }) => {
      expect(
        resolveKeyForInk(key, { vimEnabled: true, chromeContext: 'chrome-normal', pendingSequence: pending }),
      ).toEqual({ outcome: 'rejected', stage: 'vim-semantic-ops', reason: 'unsupported-in-chrome' });
    });

    it.each([
      { label: 'pending without chrome mode while enabled', context: { vimEnabled: true, chromeContext: 'inactive' as const, pendingSequence: 'Ctrl-w' as const } },
      { label: 'pending while disabled', context: { vimEnabled: false, chromeContext: 'chrome-normal' as const, pendingSequence: 'g' as const } },
      { label: 'pending while disabled and inactive', context: { vimEnabled: false, chromeContext: 'inactive' as const, pendingSequence: 'g' as const } },
    ])('fails closed on $label', ({ context }) => {
      expect(resolveKeyForInk(inkKey('h'), context)).toEqual({
        outcome: 'rejected',
        stage: 'vim-semantic-ops',
        reason: 'inconsistent-snapshot',
      });
    });

    it('passes unknown keys through outside chrome mode instead of rejecting them', () => {
      expect(resolveKeyForInk(inkKey('Ω'), { vimEnabled: true, chromeContext: 'inactive' })).toEqual({
        outcome: 'passthrough',
        stage: 'terminal-passthrough',
      });
      expect(resolveKeyForInk(inkKey('F7'), { vimEnabled: false, chromeContext: 'inactive' })).toEqual({
        outcome: 'passthrough',
        stage: 'terminal-passthrough',
      });
    });
  });

  describe('fail-closed input validation', () => {
    it.each([
      { label: 'empty key name', key: inkKey('') },
      { label: 'oversized key name', key: inkKey('K'.repeat(MAX_INK_KEY_LENGTH + 1)) },
      { label: 'missing modifier fields', key: { key: 'h' } as unknown as VimInkKey },
      { label: 'non-boolean modifier', key: { key: 'h', ctrl: 1, alt: false, shift: false, meta: false } as unknown as VimInkKey },
    ])('throws TypeError for $label', ({ key }) => {
      expect(() => resolveKeyForInk(key, { vimEnabled: true, chromeContext: 'inactive' })).toThrow(TypeError);
    });

    it('throws TypeError for an unknown pending sequence value', () => {
      expect(() =>
        resolveKeyForInk(inkKey('h'), {
          vimEnabled: true,
          chromeContext: 'chrome-normal',
          pendingSequence: 'dd' as unknown as 'g',
        }),
      ).toThrow(TypeError);
    });

    it('throws TypeError for an unknown chrome context', () => {
      expect(() =>
        resolveKeyForInk(inkKey('h'), {
          vimEnabled: true,
          chromeContext: 'editor' as unknown as 'inactive',
        }),
      ).toThrow(TypeError);
    });

    it('throws TypeError for a missing vimEnabled flag', () => {
      expect(() =>
        resolveKeyForInk(inkKey('h'), { chromeContext: 'inactive' } as unknown as Parameters<typeof resolveKeyForInk>[1]),
      ).toThrow(TypeError);
    });
  });

  describe('determinism and static tables', () => {
    const PROBE_KEYS = [
      inkKey('F6'),
      inkKey('h'),
      inkKey('w', { ctrl: true }),
      inkKey('Escape'),
      inkKey('c', { ctrl: true }),
      inkKey('Ω'),
    ];

    it('returns identical resolutions for repeated identical inputs', () => {
      for (const key of PROBE_KEYS) {
        const contexts = [
          { vimEnabled: false, chromeContext: 'inactive' as const },
          { vimEnabled: true, chromeContext: 'inactive' as const },
          { vimEnabled: true, chromeContext: 'chrome-normal' as const },
          { vimEnabled: true, chromeContext: 'chrome-normal' as const, pendingSequence: 'Ctrl-w' as const },
        ];
        for (const context of contexts) {
          const first = resolveKeyForInk(key, context);
          for (let i = 0; i < 25; i += 1) {
            expect(resolveKeyForInk(key, context)).toEqual(first);
          }
        }
      }
    });

    it('freezes the exported tables', () => {
      expect(Object.isFrozen(VIM_INK_PRECEDENCE_TABLE)).toBe(true);
      expect(Object.isFrozen(VIM_INK_SEMANTIC_OPS)).toBe(true);
      expect(Object.isFrozen(EXISTING_INK_BINDINGS)).toBe(true);
      expect(Object.isFrozen(RESERVED_INK_CHORDS)).toBe(true);
      expect(Object.isFrozen(DEFAULT_INK_CHROME_TRIGGER)).toBe(true);
    });

    it('declares the ordered precedence table', () => {
      expect(VIM_INK_PRECEDENCE_TABLE.map((stage) => stage.order)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new Set(VIM_INK_PRECEDENCE_TABLE.map((stage) => stage.stage)).size).toBe(6);
    });

    it('keeps binding ids unique', () => {
      expect(new Set(EXISTING_INK_BINDINGS.map((binding) => binding.id)).size).toBe(EXISTING_INK_BINDINGS.length);
    });

    it('stays pinned to the shared vim/v1 fixture version', () => {
      expect(VIM_INK_PRECEDENCE_VERSION).toBe(1);
      expect(VIM_INK_FIXTURE_VERSION).toBe('vim/v1');
      const fixture = JSON.parse(
        readFileSync(join(process.cwd(), 'protocol-fixtures/vim/v1/chrome.json'), 'utf8'),
      ) as { version: string };
      expect(fixture.version).toBe(VIM_INK_FIXTURE_VERSION);
    });
  });
});
