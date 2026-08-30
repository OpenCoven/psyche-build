/**
 * Versioned Ink input-precedence contract for opt-in Vim support (v1).
 *
 * Vim Slice 3 (OpenCoven/psyche-build#225, Bead psyche-no8.3) attaches the
 * shared cross-platform Vim contract at the TOP of the existing Ink
 * `useInputHandling` precedence chain. This module is the pure, deterministic
 * decision model for that attachment point: for one normalized key and one
 * snapshot of existing-chain state it returns exactly which layer owns the
 * key. It is contract-only — it performs no I/O, reads no clock, keeps no
 * state, and does not import Ink, React, tmux, PTY, or the terminal in any
 * way. The future runtime integration calls it at the top of the
 * `useInputHandling` input handler and must obey its outcome:
 *
 * - `chrome-op`        — the Vim layer operates chrome mode itself
 *                        (enter on the configured trigger, exit on Esc);
 * - `semantic-op`      — the Vim layer claims the key and routes ONE shared
 *                        semantic action (or a bounded sequence prefix) from
 *                        the `vim/v1` chrome keymap;
 * - `existing-binding` — the Vim layer claims nothing; the key proceeds down
 *                        the existing chain exactly as before, and the named
 *                        existing binding describes what the chain already
 *                        does with it;
 * - `passthrough`      — nobody claims the key; it is delivered unchanged to
 *                        the focused surface/PTY;
 * - `rejected`         — the Vim layer consumes the key with NO side effects
 *                        (unknown key inside chrome mode, or a fail-closed
 *                        inconsistent snapshot). A pending or unsupported
 *                        chrome sequence never falls through into a terminal
 *                        or text input.
 *
 * Disabled mode short-circuits the chrome and semantic stages entirely: with
 * `vimEnabled: false` the resolver never returns `chrome-op`, `semantic-op`,
 * or `rejected` (except for the fail-closed inconsistent-snapshot guard), and
 * for every key other than the claimable chrome trigger its answer is
 * identical to the enabled-but-not-in-chrome answer (tested identity). The
 * trigger itself is also short-circuited while disabled, so enabling the
 * feature changes behavior only when the trigger is pressed and only until
 * chrome mode is exited.
 *
 * Evaluation order (see `VIM_INK_PRECEDENCE_TABLE`):
 *
 *   1. pre-adapter modal/busy gate  → existing chain owns everything
 *   2. reserved lifecycle chord     → Ctrl+C quit confirmation, every mode
 *   3. chrome-mode gate             → chrome-op
 *   4. vim semantic ops             → semantic-op | rejected
 *   5. existing Ink bindings        → existing-binding
 *   6. terminal passthrough         → passthrough
 *
 * Chrome mode must never bypass lifecycle, confirmation, or dirty-file
 * guards; that is why the reserved chord sits above the chrome gate and why
 * `rejected` consumes unknown keys instead of letting them reach a binding
 * or a terminal.
 *
 * The semantic action vocabulary below mirrors the shared `vim/v1` core
 * (`@opencoven/psyche-vim-core`, `VimAction`) one-for-one so the integration
 * routes each resolved action through the shared machine and the existing
 * pane, project, popup, settings, and lifecycle paths catalogued in
 * `docs/vim/INK-PARITY-CONTRACT.md`. This slice introduces no new action
 * path. The semantic machine stays authoritative for pending sequence state,
 * sequence timeout, and chrome context; adapters feed this resolver a
 * snapshot (`chromeContext`, `pendingSequence`) rather than letting it track
 * state, which keeps this module deterministic and clock-free.
 */

/** Schema version of this precedence contract. Bump only with a reviewed contract change. */
export const VIM_INK_PRECEDENCE_VERSION = 1 as const;

/**
 * The shared Vim conformance fixture version the Ink adapter must implement.
 * Must stay identical to the `version` declared by the fixture documents
 * under `protocol-fixtures/vim/v1/` and to `VIM_ACCEPTANCE_FIXTURE_VERSION`
 * in `src/vim/acceptanceManifest.ts`. Any other version fails the Ink
 * conformance gate instead of silently accepting drift.
 */
export const VIM_INK_FIXTURE_VERSION = 'vim/v1' as const;

/** Maximum accepted length of a normalized key name. */
export const MAX_INK_KEY_LENGTH = 32;

/** Normalized key form: the exact shape the shared core's `NormalizedKey` uses. */
export interface VimInkKey {
  /** Key name: single characters lowercase (`g`), named keys verbatim (`Enter`, `Escape`, `F6`, `ArrowUp`). */
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

/** Adapter-visible Vim chrome state. `inactive` covers disabled and enabled-not-entered. */
export type VimInkChromeContext = 'inactive' | 'chrome-normal' | 'chrome-search';

/**
 * Chrome-mode lifecycle operations the Vim layer performs itself. No product
 * state changes here beyond the mode transition the shared machine owns.
 */
export type VimInkChromeOp = 'chrome.enter' | 'chrome.exit';

/**
 * Semantic actions routable from Ink chrome mode. One-for-one mirror of the
 * shared core's `VimAction` chrome vocabulary (`packages/vim-core`); the
 * runtime adapter must hand each action to the existing pane, project,
 * popup, settings, and lifecycle paths listed in
 * `docs/vim/INK-PARITY-CONTRACT.md` instead of creating parallel commands.
 */
export type VimInkSemanticAction =
  | { readonly type: 'focus.move'; readonly direction: 'left' | 'down' | 'up' | 'right' }
  | { readonly type: 'focus.first' }
  | { readonly type: 'focus.last' }
  | { readonly type: 'focus.activate' }
  | { readonly type: 'pane.focus'; readonly direction: 'left' | 'down' | 'up' | 'right' }
  | { readonly type: 'pane.cycle' }
  | { readonly type: 'pane.equalize' }
  | { readonly type: 'pane.split-horizontal' }
  | { readonly type: 'pane.split-vertical' }
  | { readonly type: 'pane.resize'; readonly direction: 'grow' | 'shrink' | 'narrow' | 'widen' }
  | { readonly type: 'search.open' }
  | { readonly type: 'search.next' }
  | { readonly type: 'search.previous' }
  | { readonly type: 'target.close' }
  | { readonly type: 'target.refresh' }
  | { readonly type: 'help.open' };

/**
 * A bounded in-progress sequence prefix. Only the two prefixes the shared
 * `vim/v1` chrome machine starts are valid; any other value fails closed.
 */
export type VimInkPendingSequence = '' | 'g' | 'Ctrl-w';

/**
 * Modifier class of one keymap or binding entry, mirroring the shared core's
 * exact-modifier checks:
 *
 * - `plain`          — every modifier false;
 * - `shift`          — shift only;
 * - `ctrl`           — ctrl only;
 * - `plain-or-shift` — ctrl/alt/meta false, shift ignored (for characters
 *                      whose typed form already differs under shift, e.g.
 *                      `?`, `:`, `+`, `<`, `>`);
 * - `any`            — modifier-insensitive (the existing chain matches the
 *                      raw `key.return` / arrow flags without modifiers).
 */
export type VimInkModifierClass = 'plain' | 'shift' | 'ctrl' | 'plain-or-shift' | 'any';

/** Static availability guards mirrored from the `useInputHandling` chain. */
export type VimInkExistingBindingGuard =
  | 'pane-selected'
  | 'desktop-use-pane-selected'
  | 'project-action-available'
  | 'control-pane-present'
  | 'dev-mode'
  | 'startup-primer-visible'
  /** Inverse guard: bound only while the chain is not loading/running a command. */
  | 'not-loading';

/**
 * Existing-chain availability inputs the adapter already knows. Every field
 * is optional; `undefined` behaves like `false`. Dynamic runtime state the
 * chain evaluates per key (project action availability, pane existence) is
 * snapshotted here, never recomputed by this module.
 */
export interface VimInkSurfaceState {
  /**
   * True while a pre-adapter Ink modal owns input: the hook's `ignoreInput`
   * gate (which already covers the hooks prompt and the pair banner), an
   * active tmux popup, active inline rename, the active colon-command
   * buffer, or an active prompt (quit-confirm, file-copy, command). The
   * adapter must not run and chrome mode must not be entered or continued.
   */
  readonly inputGated?: boolean;
  /** True while `isCreatingPane || runningCommand || isUpdating || isLoading`. */
  readonly busy?: boolean;
  readonly paneSelected?: boolean;
  readonly desktopUsePaneSelected?: boolean;
  readonly projectActionAvailable?: boolean;
  readonly controlPanePresent?: boolean;
  readonly devMode?: boolean;
  readonly startupPrimerVisible?: boolean;
  readonly loading?: boolean;
}

/** One enumerated existing Ink binding from the `useInputHandling` chain. */
export interface VimInkExistingBinding {
  /** Stable contract id of the existing behavior. */
  readonly id: string;
  readonly key: string;
  readonly modifiers: VimInkModifierClass;
  /** Static guards; the binding applies only when every guard is satisfied. */
  readonly guards: readonly VimInkExistingBindingGuard[];
  /**
   * The existing action path this binding already runs, named so semantic
   * actions are reused through it. Never a new action path.
   */
  readonly actionPath: string;
}

/**
 * The existing Ink bindings the Vim layer must never shadow outside chrome
 * mode, in `useInputHandling` evaluation order (first match wins, exactly
 * like the chain). Letter keys are normalized: `Shift+H` is `h` + `shift`.
 * Runtime guards the chain evaluates per event (pane existence, project
 * action availability) are declared as guards and snapshotted via
 * `VimInkSurfaceState`; this module never recomputes them.
 */
export const EXISTING_INK_BINDINGS: readonly VimInkExistingBinding[] = Object.freeze([
  {
    id: 'commands.colon-mode',
    key: ':',
    modifiers: 'plain-or-shift',
    guards: [],
    actionPath: 'useInputHandling colonBufferRef accumulator (":pair", ":devices")',
  },
  {
    id: 'layout.toggle-side-panel',
    key: 'z',
    modifiers: 'plain',
    guards: [],
    actionPath: 'useInputHandling onToggleSidePanel()',
  },
  {
    id: 'navigation.focus-up',
    key: 'ArrowUp',
    modifiers: 'any',
    guards: [],
    actionPath: 'useInputHandling setSelectedIndex / findCardInDirection("up")',
  },
  {
    id: 'navigation.focus-down',
    key: 'ArrowDown',
    modifiers: 'any',
    guards: [],
    actionPath: 'useInputHandling setSelectedIndex / findCardInDirection("down")',
  },
  {
    id: 'navigation.focus-left',
    key: 'ArrowLeft',
    modifiers: 'any',
    guards: [],
    actionPath: 'useInputHandling setSelectedIndex / findCardInDirection("left")',
  },
  {
    id: 'navigation.focus-right',
    key: 'ArrowRight',
    modifiers: 'any',
    guards: [],
    actionPath: 'useInputHandling setSelectedIndex / findCardInDirection("right")',
  },
  {
    id: 'panes.dev-source-from-pane',
    key: 'd',
    modifiers: 'shift',
    guards: ['startup-primer-visible'],
    actionPath: 'useInputHandling setDevSourceFromPane (startup primer shortcut)',
  },
  {
    id: 'panes.desktop-use-screenshot',
    key: 'g',
    modifiers: 'plain',
    guards: ['desktop-use-pane-selected'],
    actionPath: 'useInputHandling sendDesktopUseQuickAction("screenshot")',
  },
  {
    id: 'panes.desktop-use-inspect',
    key: 'o',
    modifiers: 'plain',
    guards: ['desktop-use-pane-selected'],
    actionPath: 'useInputHandling sendDesktopUseQuickAction("inspect")',
  },
  {
    id: 'panes.desktop-use-permissions',
    key: 'v',
    modifiers: 'plain',
    guards: ['desktop-use-pane-selected'],
    actionPath: 'useInputHandling sendDesktopUseQuickAction("permissions")',
  },
  {
    id: 'panes.desktop-use-approve',
    key: 'y',
    modifiers: 'plain',
    guards: ['desktop-use-pane-selected'],
    actionPath: 'useInputHandling sendDesktopUseQuickAction("approve")',
  },
  {
    id: 'panes.desktop-use-deny',
    key: 'x',
    modifiers: 'shift',
    guards: ['desktop-use-pane-selected'],
    actionPath: 'useInputHandling sendDesktopUseQuickAction("deny")',
  },
  {
    id: 'panes.remote-shortcut-a',
    key: 'a',
    modifiers: 'plain',
    guards: ['pane-selected'],
    actionPath: 'useInputHandling executePaneShortcut("a", pane)',
  },
  {
    id: 'panes.remote-shortcut-b',
    key: 'b',
    modifiers: 'plain',
    guards: ['pane-selected'],
    actionPath: 'useInputHandling executePaneShortcut("b", pane)',
  },
  {
    id: 'panes.remote-shortcut-f',
    key: 'f',
    modifiers: 'plain',
    guards: ['pane-selected'],
    actionPath: 'useInputHandling executePaneShortcut("f", pane)',
  },
  {
    id: 'panes.remote-shortcut-A',
    key: 'a',
    modifiers: 'shift',
    guards: ['pane-selected'],
    actionPath: 'useInputHandling executePaneShortcut("A", pane)',
  },
  {
    id: 'panes.remote-shortcut-m',
    key: 'm',
    modifiers: 'plain',
    guards: ['pane-selected'],
    actionPath: 'useInputHandling executePaneShortcut("m", pane)',
  },
  {
    id: 'projects.settings-popup',
    key: 's',
    modifiers: 'plain',
    guards: [],
    actionPath: 'popupManager.launchSettingsPopup(...)',
  },
  {
    id: 'panes.logs-popup',
    key: 'l',
    modifiers: 'plain',
    guards: [],
    actionPath: 'popupManager.launchLogsPopup(...)',
  },
  {
    id: 'panes.ritual-menu',
    key: 'u',
    modifiers: 'plain',
    guards: [],
    actionPath: 'useInputHandling handleRitualMenu()',
  },
  {
    id: 'panes.toggle-visibility',
    key: 'h',
    modifiers: 'plain',
    guards: [],
    actionPath: 'executePaneShortcut("h", pane) / status message when no pane is selected',
  },
  {
    id: 'panes.toggle-others-visibility',
    key: 'h',
    modifiers: 'shift',
    guards: [],
    actionPath: 'executePaneShortcut("H", pane) / status message when no pane is selected',
  },
  {
    id: 'projects.toggle-visibility',
    key: 'p',
    modifiers: 'shift',
    guards: [],
    actionPath: 'executePaneShortcut("P", pane) / toggleProjectPanesVisibility()',
  },
  {
    id: 'panes.inline-rename',
    key: 'e',
    modifiers: 'plain',
    guards: [],
    actionPath: 'useInputHandling startInlineRenameForSelection()',
  },
  {
    id: 'help.shortcuts-popup',
    key: '?',
    modifiers: 'plain-or-shift',
    guards: [],
    actionPath: 'popupManager.launchShortcutsPopup(...) (reused as the mode-aware help surface)',
  },
  {
    id: 'layout.reset-layout',
    key: 'l',
    modifiers: 'shift',
    guards: ['control-pane-present'],
    actionPath: 'enforceControlPaneSize(controlPaneId, width, { forceLayout: true })',
  },
  {
    id: 'dev.demo-toasts',
    key: 't',
    modifiers: 'shift',
    guards: [],
    actionPath: 'StateManager.showToast(...) demo cycle',
  },
  {
    id: 'lifecycle.quit',
    key: 'q',
    modifiers: 'plain',
    guards: [],
    actionPath: 'useInputHandling cleanExit()',
  },
  {
    id: 'panes.dev-shortcut-S',
    key: 's',
    modifiers: 'shift',
    guards: ['dev-mode', 'pane-selected'],
    actionPath: 'useInputHandling executePaneShortcut("S", pane)',
  },
  {
    id: 'panes.reopen-worktrees',
    key: 'r',
    modifiers: 'plain',
    guards: [],
    actionPath: 'useInputHandling reopenClosedWorktreesInProject(...)',
  },
  {
    id: 'projects.add',
    key: 'p',
    modifiers: 'plain',
    guards: ['not-loading'],
    actionPath: 'useInputHandling handleAddProjectToSidebar(...)',
  },
  {
    id: 'projects.add-shift-fallback',
    key: 'n',
    modifiers: 'shift',
    guards: ['not-loading'],
    actionPath: 'useInputHandling handleAddProjectToSidebar(...) (Shift+N fallback)',
  },
  {
    id: 'projects.remove',
    key: 'r',
    modifiers: 'shift',
    guards: ['not-loading'],
    actionPath: 'useInputHandling handleRemoveProjectFromSidebar(...)',
  },
  {
    id: 'panes.new-agent',
    key: 'n',
    modifiers: 'plain',
    guards: ['not-loading'],
    actionPath: 'useInputHandling handleCreateAgentPane(...)',
  },
  {
    id: 'panes.new-terminal',
    key: 't',
    modifiers: 'plain',
    guards: ['not-loading'],
    actionPath: 'useInputHandling handleCreateTerminalPane(...)',
  },
  {
    id: 'panes.new-desktop-use',
    key: 'd',
    modifiers: 'plain',
    guards: ['not-loading'],
    actionPath: 'useInputHandling handleCreateDesktopUsePane(...)',
  },
  {
    id: 'panes.open-coven-session',
    key: 'o',
    modifiers: 'plain',
    guards: ['not-loading'],
    actionPath: 'useInputHandling handleOpenCovenSession(...)',
  },
  {
    id: 'projects.activate-action',
    key: 'Enter',
    modifiers: 'any',
    guards: ['not-loading', 'project-action-available'],
    actionPath: 'useInputHandling getProjectActionByIndex(...) handler (new-agent/terminal/remove-project)',
  },
  {
    id: 'panes.pane-shortcut-j',
    key: 'j',
    modifiers: 'plain',
    guards: ['pane-selected'],
    actionPath: 'useInputHandling executePaneShortcut("j", pane)',
  },
  {
    id: 'panes.pane-shortcut-x',
    key: 'x',
    modifiers: 'plain',
    guards: ['pane-selected'],
    actionPath: 'useInputHandling executePaneShortcut("x", pane)',
  },
  {
    id: 'panes.open-pane-menu',
    key: 'Enter',
    modifiers: 'any',
    guards: ['pane-selected'],
    actionPath: 'useInputHandling openPaneMenu(pane)',
  },
]);

/** One chrome-mode semantic keymap entry, mirroring the shared `vim/v1` chrome machine. */
export interface VimInkSemanticOpEntry {
  /** Chrome context this entry applies in. */
  readonly context: Exclude<VimInkChromeContext, 'inactive'>;
  /** Required pending prefix, or `''` for entries that start a fresh resolution. */
  readonly pending: VimInkPendingSequence;
  readonly key: string;
  readonly modifiers: VimInkModifierClass;
  /** What the semantic layer does with the key when this entry matches. */
  readonly then:
    | { readonly disposition: 'action'; readonly action: VimInkSemanticAction }
    | { readonly disposition: 'pending'; readonly pending: Exclude<VimInkPendingSequence, ''> };
}

function actionEntry(
  context: Exclude<VimInkChromeContext, 'inactive'>,
  pending: VimInkPendingSequence,
  key: string,
  modifiers: VimInkModifierClass,
  action: VimInkSemanticAction,
): VimInkSemanticOpEntry {
  return { context, pending, key, modifiers, then: { disposition: 'action', action } };
}

function pendingEntry(
  context: Exclude<VimInkChromeContext, 'inactive'>,
  pending: VimInkPendingSequence,
  key: string,
  modifiers: VimInkModifierClass,
  nextPending: Exclude<VimInkPendingSequence, ''>,
): VimInkSemanticOpEntry {
  return { context, pending, key, modifiers, then: { disposition: 'pending', pending: nextPending } };
}

const PLAIN_FOCUS_DIRECTIONS = ['h', 'j', 'k', 'l'] as const;
const FOCUS_DIRECTION_BY_KEY = { h: 'left', j: 'down', k: 'up', l: 'right' } as const;
const RESIZE_BY_KEY = { '+': 'grow', '-': 'shrink', '<': 'narrow', '>': 'widen' } as const;

/**
 * The chrome-mode semantic keymap for Ink, in evaluation order. Entries are
 * keyed exactly like the shared `vim/v1` chrome machine
 * (`packages/vim-core/src/chrome-machine.ts`); keep both in sync. Esc exits
 * chrome mode at the chrome gate (stage 3), not here. Keys with `alt` or
 * `meta` set never match and are rejected inside chrome mode, exactly like
 * the shared machine's exact-modifier checks.
 */
export const VIM_INK_SEMANTIC_OPS: readonly VimInkSemanticOpEntry[] = Object.freeze([
  // chrome-normal, fresh resolution: sequence starters first (mirrors machine order)
  pendingEntry('chrome-normal', '', 'g', 'plain', 'g'),
  pendingEntry('chrome-normal', '', 'w', 'ctrl', 'Ctrl-w'),
  actionEntry('chrome-normal', '', 'g', 'shift', { type: 'focus.last' }),
  ...PLAIN_FOCUS_DIRECTIONS.map((key) =>
    actionEntry('chrome-normal', '', key, 'plain', {
      type: 'focus.move',
      direction: FOCUS_DIRECTION_BY_KEY[key],
    }),
  ),
  actionEntry('chrome-normal', '', 'Enter', 'plain', { type: 'focus.activate' }),
  actionEntry('chrome-normal', '', '/', 'plain', { type: 'search.open' }),
  actionEntry('chrome-normal', '', 'x', 'plain', { type: 'target.close' }),
  actionEntry('chrome-normal', '', 'r', 'plain', { type: 'target.refresh' }),
  actionEntry('chrome-normal', '', '?', 'shift', { type: 'help.open' }),
  // chrome-normal, pending 'g'
  actionEntry('chrome-normal', 'g', 'g', 'plain', { type: 'focus.first' }),
  // chrome-normal, pending 'Ctrl-w'
  ...PLAIN_FOCUS_DIRECTIONS.map((key) =>
    actionEntry('chrome-normal', 'Ctrl-w', key, 'plain', {
      type: 'pane.focus',
      direction: FOCUS_DIRECTION_BY_KEY[key],
    }),
  ),
  actionEntry('chrome-normal', 'Ctrl-w', 'w', 'plain', { type: 'pane.cycle' }),
  ...(['+', '-', '<', '>'] as const).map((key) =>
    actionEntry('chrome-normal', 'Ctrl-w', key, 'plain-or-shift', {
      type: 'pane.resize',
      direction: RESIZE_BY_KEY[key],
    }),
  ),
  actionEntry('chrome-normal', 'Ctrl-w', '=', 'plain', { type: 'pane.equalize' }),
  actionEntry('chrome-normal', 'Ctrl-w', 's', 'plain', { type: 'pane.split-horizontal' }),
  actionEntry('chrome-normal', 'Ctrl-w', 'v', 'plain', { type: 'pane.split-vertical' }),
  // chrome-search, fresh resolution
  actionEntry('chrome-search', '', 'n', 'plain', { type: 'search.next' }),
  actionEntry('chrome-search', '', 'n', 'shift', { type: 'search.previous' }),
]);

/** One reserved lifecycle chord that stays above the chrome gate in every mode. */
export interface VimInkReservedChord {
  readonly id: string;
  readonly key: string;
  readonly modifiers: VimInkModifierClass;
  readonly actionPath: string;
}

/**
 * Reserved lifecycle chords the chrome trigger and chrome mode can never
 * claim. Ctrl+C quit confirmation is a lifecycle guard: chrome mode must not
 * bypass it, and trigger rebinding must never target it
 * (`validateChromeTriggerForInk` fails closed on such a configuration).
 */
export const RESERVED_INK_CHORDS: readonly VimInkReservedChord[] = Object.freeze([
  {
    id: 'lifecycle.quit-confirm',
    key: 'c',
    modifiers: 'ctrl',
    actionPath: 'useInputHandling Ctrl+C quit confirmation, then cleanExit()',
  },
]);

/** The default chrome trigger, identical to the shared core's default. */
export const DEFAULT_INK_CHROME_TRIGGER: VimInkKey = Object.freeze({
  key: 'F6',
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
});

/** One ordered stage of the Ink precedence chain this contract governs. */
export interface VimInkPrecedenceStage {
  readonly order: 1 | 2 | 3 | 4 | 5 | 6;
  readonly stage:
    | 'pre-adapter-gate'
    | 'reserved-chord'
    | 'chrome-mode-gate'
    | 'vim-semantic-ops'
    | 'existing-ink-bindings'
    | 'terminal-passthrough';
  /** What claims a key at this stage. */
  readonly claims: string;
}

/**
 * The explicit precedence table. Stages 3–4 are short-circuited when Vim is
 * disabled: the resolver answers from stages 5–6 only, so existing behavior
 * is unchanged.
 */
export const VIM_INK_PRECEDENCE_TABLE: readonly VimInkPrecedenceStage[] = Object.freeze([
  {
    order: 1,
    stage: 'pre-adapter-gate',
    claims:
      'Active Ink modals and busy states (ignoreInput incl. hooks prompt and pair banner, tmux popups, inline rename, colon buffer, prompts, running command) — the adapter must not run; the existing chain owns every key',
  },
  {
    order: 2,
    stage: 'reserved-chord',
    claims:
      'Ctrl+C quit confirmation — reserved lifecycle chord above the chrome trigger in every mode',
  },
  {
    order: 3,
    stage: 'chrome-mode-gate',
    claims:
      'The configured chrome trigger enters chrome mode when inactive; Esc exits while it is active. Short-circuited when Vim is disabled',
  },
  {
    order: 4,
    stage: 'vim-semantic-ops',
    claims:
      'Chrome-mode keys mapped to shared vim/v1 semantic actions or bounded pending prefixes; unknown keys are rejected (consumed, no side effects). Short-circuited when Vim is disabled',
  },
  {
    order: 5,
    stage: 'existing-ink-bindings',
    claims:
      'The enumerated existing useInputHandling bindings — unchanged, never shadowed outside chrome mode',
  },
  {
    order: 6,
    stage: 'terminal-passthrough',
    claims: 'Keys claimed by nobody are delivered unchanged to the focused surface/PTY',
  },
]);

/** The typed resolution outcomes of `resolveKeyForInk`. */
export type VimInkOutcome = 'chrome-op' | 'semantic-op' | 'existing-binding' | 'passthrough' | 'rejected';

/** Bounded reasons a key is rejected inside chrome mode. */
export type VimInkRejectionReason = 'unsupported-in-chrome' | 'inconsistent-snapshot';

/** The full result of one precedence resolution. */
export type VimInkResolution =
  | {
      readonly outcome: 'chrome-op';
      readonly stage: 'chrome-mode-gate';
      readonly op: VimInkChromeOp;
    }
  | {
      readonly outcome: 'semantic-op';
      readonly stage: 'vim-semantic-ops';
      readonly result:
        | { readonly disposition: 'action'; readonly action: VimInkSemanticAction }
        | { readonly disposition: 'pending'; readonly pending: Exclude<VimInkPendingSequence, ''> };
    }
  | {
      readonly outcome: 'existing-binding';
      readonly stage: 'pre-adapter-gate' | 'reserved-chord' | 'existing-ink-bindings';
      readonly binding: string;
    }
  | {
      readonly outcome: 'passthrough';
      readonly stage: 'terminal-passthrough';
    }
  | {
      readonly outcome: 'rejected';
      readonly stage: 'vim-semantic-ops';
      readonly reason: VimInkRejectionReason;
    };

/** Snapshot of adapter and existing-chain state handed to `resolveKeyForInk`. */
export interface VimInkResolveContext {
  /** Whether opt-in Vim mode is enabled in settings. */
  readonly vimEnabled: boolean;
  /** Current Vim chrome state owned by the shared semantic machine. */
  readonly chromeContext: VimInkChromeContext;
  /** Pending sequence snapshot owned by the shared machine; `''` when none. */
  readonly pendingSequence?: VimInkPendingSequence;
  /** Configured chrome trigger; defaults to `DEFAULT_INK_CHROME_TRIGGER` (F6). */
  readonly trigger?: VimInkKey;
  /** Existing-chain availability snapshot; every field defaults to false. */
  readonly surface?: VimInkSurfaceState;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new TypeError(`Invalid Ink Vim precedence input: ${message}`);
}

/** Validates a normalized key; fails closed on malformed structure. */
function assertValidKey(value: unknown, where: string): asserts value is VimInkKey {
  if (!isPlainObject(value)) fail(`${where} must be an object`);
  const { key, ctrl, alt, shift, meta } = value as Record<string, unknown>;
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_INK_KEY_LENGTH) {
    fail(`${where}.key must be a non-empty string of at most ${MAX_INK_KEY_LENGTH} characters`);
  }
  if (typeof ctrl !== 'boolean' || typeof alt !== 'boolean' || typeof shift !== 'boolean' || typeof meta !== 'boolean') {
    fail(`${where} modifiers must all be booleans`);
  }
}

function keysEqual(left: VimInkKey, right: VimInkKey): boolean {
  return (
    left.key === right.key &&
    left.ctrl === right.ctrl &&
    left.alt === right.alt &&
    left.shift === right.shift &&
    left.meta === right.meta
  );
}

/**
 * Whether one concrete normalized key matches a declared modifier class.
 * `alt` or `meta` never match any class except `any`, mirroring the shared
 * core's exact-modifier checks.
 */
function matchesModifierClass(candidate: VimInkKey, declared: VimInkModifierClass): boolean {
  switch (declared) {
    case 'plain':
      return !candidate.ctrl && !candidate.alt && !candidate.shift && !candidate.meta;
    case 'shift':
      return candidate.shift && !candidate.ctrl && !candidate.alt && !candidate.meta;
    case 'ctrl':
      return candidate.ctrl && !candidate.alt && !candidate.shift && !candidate.meta;
    case 'plain-or-shift':
      return !candidate.ctrl && !candidate.alt && !candidate.meta;
    case 'any':
      return true;
  }
}

/**
 * Whether one exact key is claimed by a binding/chord declared with a
 * modifier class: `plain-or-shift` claims both unshifted and shifted forms
 * of its key, `any` claims every modifier form, and exact classes claim
 * exactly their form. Used by the trigger-claimability check below.
 */
function classClaimsKey(declared: VimInkModifierClass, candidate: VimInkKey): boolean {
  switch (declared) {
    case 'any':
      return true;
    case 'plain-or-shift':
      return !candidate.ctrl && !candidate.meta;
    default:
      return matchesModifierClass(candidate, declared);
  }
}

/**
 * Whether the configured chrome trigger is claimable at the chrome gate: it
 * must not collide with a reserved lifecycle chord, and it must not collide
 * with ANY enumerated existing Ink binding in ANY surface state (guards are
 * treated as satisfied for this check, so a rebound trigger can never shadow
 * an existing shortcut in some mode). A trigger that fails this check is a
 * misconfiguration: the resolver leaves the key to the existing chain and
 * `validateChromeTriggerForInk` rejects the setting, which per the shared
 * contract falls back to the default trigger/disabled behavior.
 */
export function isClaimableInkTrigger(trigger: VimInkKey): boolean {
  for (const chord of RESERVED_INK_CHORDS) {
    if (chord.key === trigger.key && classClaimsKey(chord.modifiers, trigger)) return false;
  }
  for (const binding of EXISTING_INK_BINDINGS) {
    if (binding.key === trigger.key && classClaimsKey(binding.modifiers, trigger)) return false;
  }
  return true;
}

function guardSatisfied(
  guard: VimInkExistingBindingGuard,
  surface: VimInkSurfaceState,
): boolean {
  switch (guard) {
    case 'pane-selected':
      return surface.paneSelected === true;
    case 'desktop-use-pane-selected':
      return surface.desktopUsePaneSelected === true;
    case 'project-action-available':
      return surface.projectActionAvailable === true;
    case 'control-pane-present':
      return surface.controlPanePresent === true;
    case 'dev-mode':
      return surface.devMode === true;
    case 'startup-primer-visible':
      return surface.startupPrimerVisible === true;
    case 'not-loading':
      return surface.loading !== true;
  }
}

function bindingMatches(
  binding: VimInkExistingBinding,
  key: VimInkKey,
  surface: VimInkSurfaceState,
): boolean {
  return (
    binding.key === key.key &&
    matchesModifierClass(key, binding.modifiers) &&
    binding.guards.every((guard) => guardSatisfied(guard, surface))
  );
}

/**
 * Outcome the existing chain produces for one key with one surface snapshot:
 * the first matching existing binding (chain evaluation order), else
 * passthrough. Used for the disabled short-circuit, for enabled-but-inactive
 * keys the chrome gate does not claim, and for gated/reserved chords.
 */
function existingChainOutcome(key: VimInkKey, surface: VimInkSurfaceState): VimInkResolution {
  const binding = EXISTING_INK_BINDINGS.find((entry) => bindingMatches(entry, key, surface));
  if (binding) {
    return { outcome: 'existing-binding', stage: 'existing-ink-bindings', binding: binding.id };
  }
  return { outcome: 'passthrough', stage: 'terminal-passthrough' };
}

function resolveSemanticOp(
  context: Exclude<VimInkChromeContext, 'inactive'>,
  pending: VimInkPendingSequence,
  key: VimInkKey,
): VimInkResolution {
  const entry = VIM_INK_SEMANTIC_OPS.find(
    (candidate) =>
      candidate.context === context &&
      candidate.pending === pending &&
      candidate.key === key.key &&
      matchesModifierClass(key, candidate.modifiers),
  );
  if (!entry) {
    return { outcome: 'rejected', stage: 'vim-semantic-ops', reason: 'unsupported-in-chrome' };
  }
  return { outcome: 'semantic-op', stage: 'vim-semantic-ops', result: entry.then };
}

const VALID_PENDING_SEQUENCES: readonly VimInkPendingSequence[] = ['', 'g', 'Ctrl-w'];

/**
 * Resolves one normalized key against the Ink precedence chain snapshot.
 * Pure and deterministic: same inputs, same frozen outcome, no clock, no
 * state. Throws `TypeError` on structurally malformed inputs (fail closed);
 * semantic-level mismatches are `rejected` outcomes, never exceptions.
 */
export function resolveKeyForInk(key: unknown, context: VimInkResolveContext): VimInkResolution {
  assertValidKey(key, 'key');
  if (!isPlainObject(context)) fail('context must be an object');
  const { vimEnabled, chromeContext, pendingSequence, trigger, surface } = context as Record<string, unknown>;
  if (typeof vimEnabled !== 'boolean') fail('context.vimEnabled must be a boolean');
  if (chromeContext !== 'inactive' && chromeContext !== 'chrome-normal' && chromeContext !== 'chrome-search') {
    fail('context.chromeContext must be "inactive", "chrome-normal", or "chrome-search"');
  }
  const rawPending = pendingSequence ?? '';
  if (typeof rawPending !== 'string' || !(VALID_PENDING_SEQUENCES as readonly string[]).includes(rawPending)) {
    fail('context.pendingSequence must be "", "g", or "Ctrl-w"');
  }
  const pending = rawPending as VimInkPendingSequence;
  if (trigger !== undefined) assertValidKey(trigger, 'context.trigger');
  const resolvedSurface: VimInkSurfaceState = isPlainObject(surface) ? (surface as VimInkSurfaceState) : {};
  const resolvedTrigger: VimInkKey = trigger ?? DEFAULT_INK_CHROME_TRIGGER;

  // Fail-closed guard: a pending chrome sequence must never fall through to
  // the chain or a terminal, even if the adapter reports an inconsistent
  // snapshot (pending without chrome mode, or any state while disabled).
  if (pending !== '' && (chromeContext === 'inactive' || !vimEnabled)) {
    return { outcome: 'rejected', stage: 'vim-semantic-ops', reason: 'inconsistent-snapshot' };
  }

  // Stage 1: pre-adapter modal/busy gate — existing behavior, unchanged.
  if (resolvedSurface.inputGated === true || resolvedSurface.busy === true) {
    return { outcome: 'existing-binding', stage: 'pre-adapter-gate', binding: 'chain.input-gate' };
  }

  // Stage 2: reserved lifecycle chord — above chrome in every mode.
  for (const chord of RESERVED_INK_CHORDS) {
    if (chord.key === key.key && matchesModifierClass(key, chord.modifiers)) {
      return { outcome: 'existing-binding', stage: 'reserved-chord', binding: chord.id };
    }
  }

  // Disabled short-circuit: stages 3–4 never run; stages 5–6 answer.
  if (!vimEnabled) {
    return existingChainOutcome(key, resolvedSurface);
  }

  // Stage 3: chrome-mode gate. The trigger is only claimable when it does
  // not collide with a reserved chord or an existing binding; a colliding
  // (misconfigured) trigger stays with the existing chain.
  if (chromeContext === 'inactive') {
    if (keysEqual(key, resolvedTrigger) && isClaimableInkTrigger(resolvedTrigger)) {
      return { outcome: 'chrome-op', stage: 'chrome-mode-gate', op: 'chrome.enter' };
    }
    return existingChainOutcome(key, resolvedSurface);
  }
  if (key.key === 'Escape' && matchesModifierClass(key, 'plain')) {
    return { outcome: 'chrome-op', stage: 'chrome-mode-gate', op: 'chrome.exit' };
  }

  // Stage 4: vim semantic ops (chrome mode is active).
  return resolveSemanticOp(chromeContext, pending, key);
}

/**
 * Validates a configured chrome trigger for Ink: structurally valid, and
 * never colliding with a reserved lifecycle chord or an enumerated existing
 * Ink binding. Fails closed with `TypeError` so an invalid persisted setting
 * falls back to the default trigger instead of stealing an existing
 * shortcut.
 */
export function validateChromeTriggerForInk(trigger: unknown): asserts trigger is VimInkKey {
  assertValidKey(trigger, 'trigger');
  if (!isClaimableInkTrigger(trigger)) {
    fail('trigger collides with a reserved chord or an existing Ink binding');
  }
}

function assertUniqueSequences(): void {
  const seen = new Set<string>();
  for (const entry of VIM_INK_SEMANTIC_OPS) {
    const identity = `${entry.context}|${entry.pending}|${entry.key}|${entry.modifiers}`;
    if (seen.has(identity)) fail(`duplicate semantic op entry ${identity}`);
    seen.add(identity);
  }
  // A looser class must not share (context, pending, key) with an exact
  // class, or evaluation order would silently shadow the exact entry.
  for (const entry of VIM_INK_SEMANTIC_OPS) {
    if (entry.modifiers === 'plain-or-shift' || entry.modifiers === 'any') {
      for (const other of VIM_INK_SEMANTIC_OPS) {
        if (
          other !== entry &&
          other.context === entry.context &&
          other.pending === entry.pending &&
          other.key === entry.key &&
          (other.modifiers === 'plain' || other.modifiers === 'shift' || other.modifiers === 'ctrl')
        ) {
          fail(`looser modifier class shadows an exact entry at ${entry.context}/${entry.pending}/${entry.key}`);
        }
      }
    }
  }
}

function assertBindingTable(): void {
  const seen = new Set<string>();
  for (const binding of EXISTING_INK_BINDINGS) {
    const identity = `${binding.key}|${binding.modifiers}`;
    if (binding.key.length === 0 || binding.key.length > MAX_INK_KEY_LENGTH) {
      fail(`existing binding ${binding.id} has an invalid key`);
    }
    if (binding.actionPath.length === 0) fail(`existing binding ${binding.id} has no action path`);
    const key2 = `${identity}|${binding.guards.join(',')}`;
    if (seen.has(key2)) fail(`duplicate existing binding entry ${binding.id}`);
    seen.add(key2);
  }
}

// Load-time self-check: the tables are static, so any drift fails fast and
// deterministically instead of surfacing as a runtime precedence bug.
assertUniqueSequences();
assertBindingTable();
