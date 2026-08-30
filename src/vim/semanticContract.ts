/**
 * Versioned Vim semantic contract (v1) — the epic-level vocabulary shared by
 * every Psyche Vim surface.
 *
 * This module is the executable contract for OpenCoven/psyche-build#222
 * (Bead psyche-no8): one versioned semantic contract that desktop, browser/web,
 * the Ink TUI, and iOS all implement, so that Vim input stays opt-in, terminal
 * bytes stay byte-exact outside explicit chrome mode, and host-owned
 * consequential actions stay routed through typed authority paths instead of
 * editor shortcuts.
 *
 * Ownership boundaries inside the epic:
 * - This module (#222 epic contract): the semantic-op vocabulary, the bounded
 *   fixture shape, the strict fixture validator, and the chrome-mode guard.
 * - OpenCoven/psyche-build#223 (Bead psyche-no8.1) owns the executable state
 *   machine, the conformance fixture documents under `protocol-fixtures/vim/v1/`,
 *   the settings schema, and the desktop reference adapter.
 * - OpenCoven/psyche-build#227 (Bead psyche-no8.5) owns the cross-platform
 *   acceptance manifest (`src/vim/acceptanceManifest.ts`) and
 *   `docs/vim/ACCEPTANCE-MATRIX.md`.
 * - `docs/vim/VIM-EPIC-CHARTER.md` is the human-readable contract charter.
 *
 * Design source: docs/superpowers/specs/2026-08-12-comprehensive-vim-support-design.md
 * (approved design). Canonical outcome: OpenCoven/psyche-build#246.
 *
 * The contract is fail-closed: `validateOpFixture` rejects unknown fields,
 * unknown or out-of-vocabulary ops, unbounded payloads, and dispositions that
 * would let a semantic action leak out of its context. Chrome-scoped ops are
 * only reachable through `chromeModeGuard` when chrome mode is active; every
 * event classified outside chrome mode is a terminal-passthrough byte event,
 * never a semantic op.
 */

/** Semantic contract schema version. Bump only with an explicit, reviewed contract change. */
export const VIM_SEMANTIC_CONTRACT_VERSION = 1 as const;

/**
 * The single shared conformance fixture version. Must stay identical to the
 * fixture documents under `protocol-fixtures/vim/v1/` (owned by
 * OpenCoven/psyche-build#223) and to `VIM_ACCEPTANCE_FIXTURE_VERSION` in
 * `src/vim/acceptanceManifest.ts` (owned by #227). Any drift fails the
 * conformance gate instead of being silently accepted.
 */
export const VIM_CONTRACT_FIXTURE_VERSION = 'vim/v1' as const;

export type VimContractFixtureVersion = typeof VIM_CONTRACT_FIXTURE_VERSION;

/* ------------------------------------------------------------------ *
 * Bounded payload limits
 * ------------------------------------------------------------------ */

/** Maximum accepted length of one fixture id. */
export const MAX_FIXTURE_ID_LENGTH = 128;
/** Maximum accepted length of one normalized key token (e.g. `<C-w>`). */
export const MAX_KEY_TOKEN_LENGTH = 16;
/** Maximum accepted length of one terminal byte payload carried by a fixture. */
export const MAX_INPUT_BYTES_LENGTH = 256;
/** Maximum accepted count prefix on one semantic op. */
export const MAX_OP_COUNT = 1000;
/** Maximum accepted length of one register name token. */
export const MAX_REGISTER_NAME_LENGTH = 1;
/** Maximum accepted length of one search pattern. */
export const MAX_SEARCH_PATTERN_LENGTH = 512;
/** Maximum accepted length of one Ex command argument string. */
export const MAX_EX_ARGS_LENGTH = 512;
/** Maximum accepted line number in an Ex command range. */
export const MAX_EX_LINE_NUMBER = 1_000_000_000;
/** Maximum accepted pane resize step. */
export const MAX_PANE_RESIZE_STEP = 10;
/** Maximum accepted length of one accessibility/status message. */
export const MAX_STATUS_MESSAGE_LENGTH = 256;
/** Maximum accepted number of semantic ops emitted by one fixture input. */
export const MAX_OPS_PER_FIXTURE = 16;
/** Maximum accepted number of fixtures in one conformance set. */
export const MAX_FIXTURES_PER_SET = 512;

/* ------------------------------------------------------------------ *
 * Contexts
 * ------------------------------------------------------------------ */

/**
 * Bounded context vocabulary. `disabled` and `passthrough` are the two
 * contexts in which Vim support must never change existing behavior; the
 * `chrome-*` contexts are the explicit F6 chrome mode; the `editor-*`
 * contexts are the embedded editor's Vim modes.
 */
export const VIM_CONTEXTS = [
  'disabled',
  'passthrough',
  'chrome-normal',
  'chrome-search',
  'editor-normal',
  'editor-insert',
  'editor-replace',
  'editor-visual-char',
  'editor-visual-line',
  'editor-visual-block',
  'editor-operator-pending',
  'editor-search',
  'editor-command-line',
] as const;

export type VimContext = (typeof VIM_CONTEXTS)[number];

/** Contexts in which every event must classify as terminal passthrough. */
export const VIM_PASSTHROUGH_CONTEXTS = ['disabled', 'passthrough'] as const;

/** Explicit chrome-mode contexts (reachable only after the chrome trigger). */
export const VIM_CHROME_CONTEXTS = ['chrome-normal', 'chrome-search'] as const;

/** Embedded-editor Vim contexts. */
export const VIM_EDITOR_CONTEXTS = [
  'editor-normal',
  'editor-insert',
  'editor-replace',
  'editor-visual-char',
  'editor-visual-line',
  'editor-visual-block',
  'editor-operator-pending',
  'editor-search',
  'editor-command-line',
] as const;

/** Contexts whose semantic ops are chrome-scoped. */
export const VIM_CHROME_MODES = ['inactive', 'active-normal', 'active-search'] as const;

export type VimChromeModeState = (typeof VIM_CHROME_MODES)[number];

/* ------------------------------------------------------------------ *
 * Normalized key inputs
 * ------------------------------------------------------------------ */

/** Bounded modifier vocabulary for normalized key chords. */
export const VIM_KEY_MODIFIERS = ['ctrl', 'alt', 'meta', 'shift'] as const;

export type VimKeyModifier = (typeof VIM_KEY_MODIFIERS)[number];

/** Short modifier codes used in Vim-style key notation, in canonical order. */
const MODIFIER_CODES: Readonly<Record<VimKeyModifier, string>> = {
  ctrl: 'C',
  alt: 'A',
  meta: 'M',
  shift: 'S',
};

/**
 * One normalized key input: the platform-agnostic key name (case-sensitive,
 * e.g. `h`, `G`, `Enter`, `Esc`, `F6`) plus the active modifier chord, and —
 * for terminal-originated events — the exact byte sequence that carried it.
 * Raw platform events never reach this contract directly; adapters normalize
 * first (raw event -> normalized key token -> semantic state machine).
 */
export interface VimNormalizedKeyInput {
  readonly key: string;
  readonly modifiers?: readonly VimKeyModifier[];
  /** Exact terminal bytes for the event, when the source is a terminal stream. */
  readonly bytes?: string;
}

/**
 * Renders the canonical Vim-notation token for a normalized key input
 * (e.g. `{ key: 'u', modifiers: ['ctrl'] }` -> `<C-u>`). Modifier order is
 * canonical (`C-A-M-S`) so identical chords always produce identical tokens.
 */
export function normalizedKeyToken(input: VimNormalizedKeyInput): string {
  const modifiers = input.modifiers ?? [];
  const codes = VIM_KEY_MODIFIERS.filter((modifier) => modifiers.includes(modifier)).map(
    (modifier) => MODIFIER_CODES[modifier],
  );
  if (codes.length === 0) return input.key;
  return `<${codes.join('-')}-${input.key}>`;
}

/* ------------------------------------------------------------------ *
 * Semantic-op vocabulary
 * ------------------------------------------------------------------ */

/** Semantic capability groups. Every op belongs to exactly one kind. */
export const VIM_OP_KINDS = [
  'motion',
  'edit',
  'search',
  'ex',
  'chrome',
  'persistence',
  'accessibility',
] as const;

export type VimOpKind = (typeof VIM_OP_KINDS)[number];

/** Editor motion ops (character, word/WORD, line, paragraph, document, find/till, search). */
export const VIM_MOTION_OPS = [
  'char-left',
  'char-right',
  'line-up',
  'line-down',
  'word-forward',
  'word-backward',
  'word-end',
  'word-forward-big',
  'word-backward-big',
  'word-end-big',
  'line-start',
  'line-start-nonspace',
  'line-end',
  'document-first-line',
  'document-last-line',
  'paragraph-backward',
  'paragraph-forward',
  'matching-delimiter',
  'find-char-forward',
  'find-char-backward',
  'till-char-forward',
  'till-char-backward',
  'repeat-find',
  'repeat-find-reverse',
  'search-motion',
] as const;

export type VimMotionOpName = (typeof VIM_MOTION_OPS)[number];

/** Editor edit ops: mode entry, operator application, direct edits, undo/redo, macros. */
export const VIM_EDIT_OPS = [
  'insert-before',
  'insert-after',
  'insert-line-below',
  'insert-line-above',
  'replace-mode-enter',
  'delete-char-forward',
  'delete-char-backward',
  'delete-line',
  'delete',
  'change',
  'yank',
  'indent',
  'outdent',
  'case-toggle',
  'case-upper',
  'case-lower',
  'join',
  'format',
  'put-after',
  'put-before',
  'replace-char',
  'increment-number',
  'decrement-number',
  'undo',
  'redo',
  'repeat-last-change',
  'record-macro',
  'replay-macro',
] as const;

export type VimEditOpName = (typeof VIM_EDIT_OPS)[number];

/** Editor search ops. Chrome search is a separate, chrome-scoped surface. */
export const VIM_SEARCH_OPS = [
  'search-forward',
  'search-backward',
  'search-next',
  'search-previous',
  'search-word-under-cursor',
  'clear-search-highlight',
] as const;

export type VimSearchOpName = (typeof VIM_SEARCH_OPS)[number];

/**
 * Bounded Ex command vocabulary. Unknown or malformed Ex commands never
 * execute shell code; the executable grammar is refined by the editor core
 * (OpenCoven/psyche-build#223), but the contract bounds the vocabulary here.
 */
export const VIM_EX_COMMANDS = [
  'write',
  'write-all',
  'quit',
  'quit-force',
  'quit-all',
  'quit-all-force',
  'write-quit',
  'write-exit',
  'edit',
  'buffer-next',
  'buffer-previous',
  'buffer-switch',
  'nohlsearch',
  'set-option',
  'substitute',
] as const;

export type VimExCommandName = (typeof VIM_EX_COMMANDS)[number];

/** Options accepted by `:set`; anything else is rejected by the contract. */
export const VIM_EX_SETTABLE_OPTIONS = [
  'number',
  'nonumber',
  'relativenumber',
  'norelativenumber',
  'ignorecase',
  'noignorecase',
  'smartcase',
  'nosmartcase',
  'wrap',
  'nowrap',
] as const;

export type VimExSettableOption = (typeof VIM_EX_SETTABLE_OPTIONS)[number];

/**
 * Chrome navigation ops. These are reachable only inside an explicit chrome
 * mode (see `chromeModeGuard`). `guarded-close` is a request: the host's
 * existing close/confirmation gates stay authoritative and are never bypassed.
 */
export const VIM_CHROME_OPS = [
  'focus-move',
  'focus-first',
  'focus-last',
  'page-move',
  'search-open',
  'search-next',
  'search-previous',
  'activate',
  'pane-focus',
  'pane-cycle',
  'pane-resize',
  'pane-equalize',
  'pane-create',
  'guarded-close',
  'retry-refresh',
  'help-open',
  'exit',
] as const;

export type VimChromeOpName = (typeof VIM_CHROME_OPS)[number];

/** Bounded spatial/resize direction vocabulary. */
export const VIM_DIRECTIONS = ['left', 'down', 'up', 'right'] as const;

export type VimDirection = (typeof VIM_DIRECTIONS)[number];

/**
 * Persistence ops. These name durable, consequential requests (save, close,
 * quit). They never execute directly: every op carries
 * `route: 'host-authority'`, meaning the adapter must hand it to the host's
 * existing typed authority/confirmation/receipt/recovery paths. A persistence
 * op executed outside those paths is a contract violation.
 */
export const VIM_PERSISTENCE_OPS = ['save-request', 'close-request', 'save-close-request'] as const;

export type VimPersistenceOpName = (typeof VIM_PERSISTENCE_OPS)[number];

/** The only legal routing label for persistence ops. */
export const VIM_PERSISTENCE_ROUTE = 'host-authority' as const;

export type VimPersistenceRoute = typeof VIM_PERSISTENCE_ROUTE;

/** Accessibility semantics: concise announcements and bounded focus restoration. */
export const VIM_ACCESSIBILITY_OPS = [
  'announce-status',
  'announce-mode',
  'announce-focus',
  'focus-restore',
] as const;

export type VimAccessibilityOpName = (typeof VIM_ACCESSIBILITY_OPS)[number];

/** Bounded fallback targets when focus restoration to the recorded target fails. */
export const VIM_FOCUS_FALLBACKS = ['nearest-pane', 'navigation-container', 'last-focused'] as const;

export type VimFocusFallback = (typeof VIM_FOCUS_FALLBACKS)[number];

/** Motion op: optional bounded count; find/till ops require a single `char`. */
export interface VimMotionOp {
  readonly kind: 'motion';
  readonly op: VimMotionOpName;
  readonly count?: number;
  readonly char?: string;
}

/** Edit op: optional bounded count/register; `replace-char` requires a single `char`. */
export interface VimEditOp {
  readonly kind: 'edit';
  readonly op: VimEditOpName;
  readonly count?: number;
  readonly register?: string;
  readonly char?: string;
}

/** Search op: forward/backward require a bounded `pattern`. */
export interface VimSearchOp {
  readonly kind: 'search';
  readonly op: VimSearchOpName;
  readonly pattern?: string;
  readonly count?: number;
}

/** Ex command op: bounded command name, bounded args, and an optional range. */
export interface VimExOp {
  readonly kind: 'ex';
  readonly command: VimExCommandName;
  readonly args?: string;
  readonly range?: { readonly from: number; readonly to: number };
}

/** Chrome navigation op. Only reachable through an active chrome mode. */
export interface VimChromeOp {
  readonly kind: 'chrome';
  readonly op: VimChromeOpName;
  readonly direction?: VimDirection;
  readonly step?: number;
  readonly orientation?: 'horizontal' | 'vertical';
  readonly count?: number;
}

/** Persistence op: always routed through host-owned authority paths. */
export interface VimPersistenceOp {
  readonly kind: 'persistence';
  readonly op: VimPersistenceOpName;
  readonly route: VimPersistenceRoute;
  readonly scope: 'focused' | 'all' | 'workspace';
  readonly force?: boolean;
}

/** Accessibility op: bounded announcements and focus-restoration fallbacks. */
export interface VimAccessibilityOp {
  readonly kind: 'accessibility';
  readonly op: VimAccessibilityOpName;
  readonly message?: string;
  readonly fallback?: VimFocusFallback;
}

/** The complete v1 semantic-op union. */
export type VimSemanticOp =
  | VimMotionOp
  | VimEditOp
  | VimSearchOp
  | VimExOp
  | VimChromeOp
  | VimPersistenceOp
  | VimAccessibilityOp;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Terminal disposition of one normalized input in one context. */
export const VIM_DISPOSITIONS = ['passthrough', 'pending', 'action', 'unsupported'] as const;

export type VimDisposition = (typeof VIM_DISPOSITIONS)[number];

/** Expected outcome of one fixture input. */
export interface VimExpectedOutcome {
  readonly disposition: VimDisposition;
  /** Semantic ops emitted; required for `action`, forbidden for every other disposition. */
  readonly ops?: readonly VimSemanticOp[];
  /**
   * Required (and strictly equal to `input.bytes`) whenever the fixture's
   * input carries terminal bytes and the disposition is `passthrough`; this is
   * the executable form of the byte-exact terminal-passthrough invariant.
   */
  readonly passthroughBytes?: string;
  /** Context after the input is processed, when it changes. */
  readonly stateAfter?: VimContext;
  /** Whether pending state resets; required `true` for `unsupported`. */
  readonly resetPending?: boolean;
  /** Visible, bounded explanation; required for `unsupported`. */
  readonly statusMessage?: string;
}

/** One conformance fixture: an input, its starting context, and its expected outcome. */
export interface VimOpFixture {
  /** Must equal `VIM_CONTRACT_FIXTURE_VERSION`; drift fails the gate. */
  readonly fixtureVersion: VimContractFixtureVersion;
  /** Stable, unique id within a fixture set. */
  readonly id: string;
  readonly context: VimContext;
  readonly input: VimNormalizedKeyInput;
  readonly expected: VimExpectedOutcome;
}

/* ------------------------------------------------------------------ *
 * Validation helpers
 * ------------------------------------------------------------------ */

function invalid(message: string): never {
  throw new TypeError(`Invalid Vim semantic contract fixture: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(
  candidate: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(candidate)) {
    if (!allowed.includes(key)) invalid(`${where} has unknown field ${JSON.stringify(key)}`);
  }
}

function validateBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  allowEmpty = false,
): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maxLength) {
    invalid(`${field} must be a string of length 1..${maxLength}`);
  }
}

function validateOptionalCount(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_OP_COUNT) {
    invalid(`${field} must be an integer in 1..${MAX_OP_COUNT}`);
  }
}

function validateOptionalChar(value: unknown, field: string, required: boolean): void {
  if (value === undefined) {
    if (required) invalid(`${field} is required and must be exactly one character`);
    return;
  }
  if (typeof value !== 'string' || value.length !== 1) {
    invalid(`${field} must be exactly one character`);
  }
}

function validateKeyInput(candidate: unknown, where: string): asserts candidate is VimNormalizedKeyInput {  if (!isPlainObject(candidate)) invalid(`${where} must be an object`);
  rejectUnknownFields(candidate, ['key', 'modifiers', 'bytes'], where);
  validateBoundedString(candidate.key, `${where}.key`, MAX_KEY_TOKEN_LENGTH);
  if (candidate.modifiers !== undefined) {
    if (!Array.isArray(candidate.modifiers)) invalid(`${where}.modifiers must be an array`);
    if (candidate.modifiers.length > VIM_KEY_MODIFIERS.length) {
      invalid(`${where}.modifiers exceeds ${VIM_KEY_MODIFIERS.length} entries`);
    }
    const seen = new Set<string>();
    for (const modifier of candidate.modifiers) {
      if (typeof modifier !== 'string' || !VIM_KEY_MODIFIERS.includes(modifier as VimKeyModifier)) {
        invalid(`${where}.modifiers has unknown modifier ${JSON.stringify(modifier)}`);
      }
      if (seen.has(modifier)) invalid(`${where}.modifiers has duplicate modifier ${JSON.stringify(modifier)}`);
      seen.add(modifier);
    }
  }
  if (candidate.bytes !== undefined) {
    validateBoundedString(candidate.bytes, `${where}.bytes`, MAX_INPUT_BYTES_LENGTH, true);
  }
}

const REGISTER_NAME_PATTERN = /^[a-zA-Z0-9"\-_=+*.%\/]$/;

function validateOptionalRegister(value: unknown, field: string): void {
  if (value === undefined) return;
  if (
    typeof value !== 'string' ||
    value.length > MAX_REGISTER_NAME_LENGTH ||
    !REGISTER_NAME_PATTERN.test(value)
  ) {
    invalid(`${field} must be a single register name character`);
  }
}

/* ------------------------------------------------------------------ *
 * Per-kind op validation
 * ------------------------------------------------------------------ */

function validateMotionOp(candidate: Record<string, unknown>, where: string): void {
  rejectUnknownFields(candidate, ['kind', 'op', 'count', 'char'], where);
  const op = candidate.op;
  if (typeof op !== 'string' || !VIM_MOTION_OPS.includes(op as VimMotionOpName)) {
    invalid(`${where} has unknown motion op ${JSON.stringify(op)}`);
  }
  validateOptionalCount(candidate.count, `${where}.count`);
  const findTill = ['find-char-forward', 'find-char-backward', 'till-char-forward', 'till-char-backward'];
  const charRequired = findTill.includes(op);
  if (!charRequired && candidate.char !== undefined) {
    invalid(`${where} (${op}) must not carry char`);
  }
  validateOptionalChar(candidate.char, `${where}.char`, charRequired);
}

function validateEditOp(candidate: Record<string, unknown>, where: string): void {
  rejectUnknownFields(candidate, ['kind', 'op', 'count', 'register', 'char'], where);
  const op = candidate.op;
  if (typeof op !== 'string' || !VIM_EDIT_OPS.includes(op as VimEditOpName)) {
    invalid(`${where} has unknown edit op ${JSON.stringify(op)}`);
  }
  validateOptionalCount(candidate.count, `${where}.count`);
  const registerOps = ['delete', 'change', 'yank', 'put-after', 'put-before', 'record-macro', 'replay-macro'];
  if (!registerOps.includes(op) && candidate.register !== undefined) {
    invalid(`${where} (${op}) must not carry register`);
  }
  validateOptionalRegister(candidate.register, `${where}.register`);
  const charRequired = op === 'replace-char';
  if (!charRequired && candidate.char !== undefined) {
    invalid(`${where} (${op}) must not carry char`);
  }
  validateOptionalChar(candidate.char, `${where}.char`, charRequired);
}

function validateSearchOp(candidate: Record<string, unknown>, where: string): void {
  rejectUnknownFields(candidate, ['kind', 'op', 'pattern', 'count'], where);
  const op = candidate.op;
  if (typeof op !== 'string' || !VIM_SEARCH_OPS.includes(op as VimSearchOpName)) {
    invalid(`${where} has unknown search op ${JSON.stringify(op)}`);
  }
  const patternRequired = op === 'search-forward' || op === 'search-backward';
  if (!patternRequired && candidate.pattern !== undefined) {
    invalid(`${where} (${op}) must not carry pattern`);
  }
  if (patternRequired) {
    if (candidate.pattern === undefined) invalid(`${where} (${op}) requires pattern`);
    validateBoundedString(candidate.pattern, `${where}.pattern`, MAX_SEARCH_PATTERN_LENGTH);
  }
  const countAllowed = op === 'search-next' || op === 'search-previous';
  if (!countAllowed && candidate.count !== undefined) {
    invalid(`${where} (${op}) must not carry count`);
  }
  validateOptionalCount(candidate.count, `${where}.count`);
}

function validateExOp(candidate: Record<string, unknown>, where: string): void {
  rejectUnknownFields(candidate, ['kind', 'command', 'args', 'range'], where);
  const command = candidate.command;
  if (typeof command !== 'string' || !VIM_EX_COMMANDS.includes(command as VimExCommandName)) {
    invalid(`${where} has unknown Ex command ${JSON.stringify(command)}`);
  }
  const argsRequired = ['buffer-switch', 'set-option', 'substitute'].includes(command);
  if (!argsRequired && candidate.args !== undefined) {
    invalid(`${where} (${command}) must not carry args`);
  }
  if (argsRequired) {
    if (candidate.args === undefined) invalid(`${where} (${command}) requires args`);
    validateBoundedString(candidate.args, `${where}.args`, MAX_EX_ARGS_LENGTH);
    if (command === 'set-option' && !VIM_EX_SETTABLE_OPTIONS.includes(candidate.args as VimExSettableOption)) {
      invalid(
        `${where} (set-option) args ${JSON.stringify(candidate.args)} is not a settable option; allowed: ${VIM_EX_SETTABLE_OPTIONS.join(', ')}`,
      );
    }
  }
  if (candidate.range !== undefined) {
    if (command !== 'substitute') invalid(`${where} (${command}) must not carry range`);
    if (!isPlainObject(candidate.range)) invalid(`${where}.range must be an object`);
    rejectUnknownFields(candidate.range, ['from', 'to'], `${where}.range`);
    const { from, to } = candidate.range;
    const lineError = (value: unknown): string | null =>
      typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_EX_LINE_NUMBER
        ? null
        : `must be an integer in 1..${MAX_EX_LINE_NUMBER}`;
    const fromError = lineError(from);
    if (fromError) invalid(`${where}.range.from ${fromError}`);
    const toError = lineError(to);
    if (toError) invalid(`${where}.range.to ${toError}`);
    if ((from as number) > (to as number)) invalid(`${where}.range.from must not exceed range.to`);
  }
}

function validateChromeOp(candidate: Record<string, unknown>, where: string): void {
  rejectUnknownFields(candidate, ['kind', 'op', 'direction', 'step', 'orientation', 'count'], where);
  const op = candidate.op;
  if (typeof op !== 'string' || !VIM_CHROME_OPS.includes(op as VimChromeOpName)) {
    invalid(`${where} has unknown chrome op ${JSON.stringify(op)}`);
  }
  const directionRequired = ['focus-move', 'page-move', 'pane-focus', 'pane-resize'].includes(op);
  if (directionRequired) {
    if (candidate.direction === undefined) invalid(`${where} (${op}) requires direction`);
    if (
      typeof candidate.direction !== 'string' ||
      !VIM_DIRECTIONS.includes(candidate.direction as VimDirection)
    ) {
      invalid(`${where} (${op}) has unknown direction ${JSON.stringify(candidate.direction)}`);
    }
    if (op === 'page-move' && candidate.direction !== 'up' && candidate.direction !== 'down') {
      invalid(`${where} (page-move) direction must be up or down`);
    }
  } else if (candidate.direction !== undefined) {
    invalid(`${where} (${op}) must not carry direction`);
  }
  if (candidate.step !== undefined) {
    if (op !== 'pane-resize') invalid(`${where} (${op}) must not carry step`);
    if (
      typeof candidate.step !== 'number' ||
      !Number.isInteger(candidate.step) ||
      candidate.step < 1 ||
      candidate.step > MAX_PANE_RESIZE_STEP
    ) {
      invalid(`${where}.step must be an integer in 1..${MAX_PANE_RESIZE_STEP}`);
    }
  }
  if (candidate.orientation !== undefined) {
    if (op !== 'pane-create') invalid(`${where} (${op}) must not carry orientation`);
    if (candidate.orientation !== 'horizontal' && candidate.orientation !== 'vertical') {
      invalid(`${where} (pane-create) orientation must be horizontal or vertical`);
    }
  } else if (op === 'pane-create') {
    invalid(`${where} (pane-create) requires orientation`);
  }
  const countAllowed = ['focus-move', 'page-move', 'search-next', 'search-previous', 'pane-cycle'].includes(op);
  if (!countAllowed && candidate.count !== undefined) {
    invalid(`${where} (${op}) must not carry count`);
  }
  validateOptionalCount(candidate.count, `${where}.count`);
}

function validatePersistenceOp(candidate: Record<string, unknown>, where: string): void {
  rejectUnknownFields(candidate, ['kind', 'op', 'route', 'scope', 'force'], where);
  const op = candidate.op;
  if (typeof op !== 'string' || !VIM_PERSISTENCE_OPS.includes(op as VimPersistenceOpName)) {
    invalid(`${where} has unknown persistence op ${JSON.stringify(op)}`);
  }
  if (candidate.route !== VIM_PERSISTENCE_ROUTE) {
    invalid(
      `${where} (${op}) must route through ${JSON.stringify(VIM_PERSISTENCE_ROUTE)}; host-owned consequential actions are never executed by editor shortcuts`,
    );
  }
  const allowedScopes: Record<string, readonly string[]> = {
    'save-request': ['focused', 'all'],
    'close-request': ['focused', 'all', 'workspace'],
    'save-close-request': ['focused'],
  };
  const scope = candidate.scope;
  if (typeof scope !== 'string' || !allowedScopes[op].includes(scope)) {
    invalid(`${where} (${op}) scope must be one of ${allowedScopes[op].join(', ')}`);
  }
  if (candidate.force !== undefined) {
    if (op !== 'close-request') invalid(`${where} (${op}) must not carry force`);
    if (typeof candidate.force !== 'boolean') invalid(`${where}.force must be a boolean`);
  }
}

function validateAccessibilityOp(candidate: Record<string, unknown>, where: string): void {
  rejectUnknownFields(candidate, ['kind', 'op', 'message', 'fallback'], where);
  const op = candidate.op;
  if (typeof op !== 'string' || !VIM_ACCESSIBILITY_OPS.includes(op as VimAccessibilityOpName)) {
    invalid(`${where} has unknown accessibility op ${JSON.stringify(op)}`);
  }
  const messageRequired = op !== 'focus-restore';
  if (messageRequired) {
    if (candidate.message === undefined) invalid(`${where} (${op}) requires message`);
    validateBoundedString(candidate.message, `${where}.message`, MAX_STATUS_MESSAGE_LENGTH);
  } else if (candidate.message !== undefined) {
    invalid(`${where} (focus-restore) must not carry message`);
  }
  if (op === 'focus-restore') {
    const fallback = candidate.fallback;
    if (
      typeof fallback !== 'string' ||
      !VIM_FOCUS_FALLBACKS.includes(fallback as VimFocusFallback)
    ) {
      invalid(`${where} (focus-restore) fallback must be one of ${VIM_FOCUS_FALLBACKS.join(', ')}`);
    }
  } else if (candidate.fallback !== undefined) {
    invalid(`${where} (${op}) must not carry fallback`);
  }
}

/** Strictly validates one semantic op: unknown kinds/ops and unbounded payloads are rejected. */
export function validateSemanticOp(candidate: unknown, where = 'op'): asserts candidate is VimSemanticOp {
  if (!isPlainObject(candidate)) invalid(`${where} must be an object`);
  const kind = candidate.kind;
  if (typeof kind !== 'string' || !VIM_OP_KINDS.includes(kind as VimOpKind)) {
    invalid(`${where} has unknown kind ${JSON.stringify(kind)}`);
  }
  switch (kind) {
    case 'motion':
      validateMotionOp(candidate, where);
      break;
    case 'edit':
      validateEditOp(candidate, where);
      break;
    case 'search':
      validateSearchOp(candidate, where);
      break;
    case 'ex':
      validateExOp(candidate, where);
      break;
    case 'chrome':
      validateChromeOp(candidate, where);
      break;
    case 'persistence':
      validatePersistenceOp(candidate, where);
      break;
    case 'accessibility':
      validateAccessibilityOp(candidate, where);
      break;
    default:
      invalid(`${where} has unknown kind ${JSON.stringify(kind)}`);
  }
}

/** Chrome-scoped ops are only reachable through an active chrome mode. */
export function isChromeScopedOp(op: VimSemanticOp): op is VimChromeOp {
  return op.kind === 'chrome';
}

/* ------------------------------------------------------------------ *
 * Op-fixture validation
 * ------------------------------------------------------------------ */

const OP_KINDS_ALLOWED_IN_CHROME: readonly VimOpKind[] = ['chrome', 'accessibility'];
const OP_KINDS_ALLOWED_IN_EDITOR: readonly VimOpKind[] = [
  'motion',
  'edit',
  'search',
  'ex',
  'persistence',
  'accessibility',
];

function validateExpectedOutcome(
  candidate: unknown,
  context: VimContext,
  input: VimNormalizedKeyInput,
  where: string,
): asserts candidate is VimExpectedOutcome {
  if (!isPlainObject(candidate)) invalid(`${where} must be an object`);
  rejectUnknownFields(
    candidate,
    ['disposition', 'ops', 'passthroughBytes', 'stateAfter', 'resetPending', 'statusMessage'],
    where,
  );
  const disposition = candidate.disposition;
  if (typeof disposition !== 'string' || !VIM_DISPOSITIONS.includes(disposition as VimDisposition)) {
    invalid(
      `${where} has unknown disposition ${JSON.stringify(disposition)}; allowed: ${VIM_DISPOSITIONS.join(', ')}`,
    );
  }
  if (candidate.stateAfter !== undefined) {
    if (
      typeof candidate.stateAfter !== 'string' ||
      !VIM_CONTEXTS.includes(candidate.stateAfter as VimContext)
    ) {
      invalid(`${where}.stateAfter has unknown context ${JSON.stringify(candidate.stateAfter)}`);
    }
  }

  if (disposition === 'action') {
    if (!Array.isArray(candidate.ops) || candidate.ops.length === 0) {
      invalid(`${where} with disposition action requires a non-empty ops array`);
    }
    if (candidate.ops.length > MAX_OPS_PER_FIXTURE) {
      invalid(`${where} ops count exceeds ${MAX_OPS_PER_FIXTURE}`);
    }
    candidate.ops.forEach((op, index) => validateSemanticOp(op, `${where}.ops[${index}]`));
  } else if (candidate.ops !== undefined) {
    invalid(`${where} with disposition ${disposition} must not carry ops`);
  }

  if (disposition === 'unsupported') {
    if (candidate.resetPending !== true) {
      invalid(`${where} with disposition unsupported requires resetPending: true`);
    }
    if (candidate.statusMessage === undefined) {
      invalid(`${where} with disposition unsupported requires statusMessage`);
    }
    validateBoundedString(candidate.statusMessage, `${where}.statusMessage`, MAX_STATUS_MESSAGE_LENGTH);
  } else if (candidate.statusMessage !== undefined && disposition !== 'action') {
    invalid(`${where} with disposition ${disposition} must not carry statusMessage`);
  }

  if (disposition === 'passthrough') {
    if (input.bytes !== undefined) {
      if (candidate.passthroughBytes === undefined) {
        invalid(`${where} passthrough with input.bytes requires passthroughBytes`);
      }
      validateBoundedString(candidate.passthroughBytes, `${where}.passthroughBytes`, MAX_INPUT_BYTES_LENGTH, true);
      if (candidate.passthroughBytes !== input.bytes) {
        invalid(
          `${where} passthroughBytes must be byte-identical to input.bytes (terminal passthrough is byte-exact outside chrome mode)`,
        );
      }
    }
  } else if (candidate.passthroughBytes !== undefined) {
    invalid(`${where} with disposition ${disposition} must not carry passthroughBytes`);
  }

  if (disposition === 'pending' && candidate.resetPending === true) {
    invalid(`${where} with disposition pending must not reset pending state`);
  }
}

/**
 * Strictly validates one op fixture: unknown fields at any level, unknown
 * contexts/dispositions/ops, unbounded payloads, and per-context
 * classification rules are all rejected. In particular:
 *
 * - `disabled` and `passthrough` contexts must classify as byte-exact
 *   terminal passthrough and never emit semantic ops (the opt-in invariant);
 * - chrome contexts may only emit chrome-scoped and accessibility ops;
 * - editor contexts may never emit chrome-scoped ops;
 * - persistence ops must carry `route: 'host-authority'`.
 */
export function validateOpFixture(candidate: unknown): asserts candidate is VimOpFixture {
  if (!isPlainObject(candidate)) invalid('fixture must be an object');
  rejectUnknownFields(candidate, ['fixtureVersion', 'id', 'context', 'input', 'expected'], 'fixture');
  if (candidate.fixtureVersion !== VIM_CONTRACT_FIXTURE_VERSION) {
    invalid(
      `fixture must declare fixtureVersion ${JSON.stringify(VIM_CONTRACT_FIXTURE_VERSION)}, got ${JSON.stringify(candidate.fixtureVersion)}`,
    );
  }
  validateBoundedString(candidate.id, 'fixture.id', MAX_FIXTURE_ID_LENGTH);
  if (typeof candidate.context !== 'string' || !VIM_CONTEXTS.includes(candidate.context as VimContext)) {
    invalid(
      `fixture has unknown context ${JSON.stringify(candidate.context)}; allowed: ${VIM_CONTEXTS.join(', ')}`,
    );
  }
  const context = candidate.context as VimContext;
  const inputCandidate: unknown = candidate.input;
  validateKeyInput(inputCandidate, 'fixture.input');

  const expectedCandidate: unknown = candidate.expected;
  validateExpectedOutcome(expectedCandidate, context, inputCandidate, 'fixture.expected');
  const expected = expectedCandidate;

  if (VIM_PASSTHROUGH_CONTEXTS.includes(context as (typeof VIM_PASSTHROUGH_CONTEXTS)[number])) {
    if (expected.disposition !== 'passthrough') {
      invalid(
        `fixture in context ${context} must classify as passthrough (Vim support is opt-in; behavior outside explicit chrome/editor mode is unchanged)`,
      );
    }
  }
  if (expected.ops !== undefined) {
    const allowedKinds = VIM_CHROME_CONTEXTS.includes(context as (typeof VIM_CHROME_CONTEXTS)[number])
      ? OP_KINDS_ALLOWED_IN_CHROME
      : OP_KINDS_ALLOWED_IN_EDITOR;
    for (const op of expected.ops) {
      if (!allowedKinds.includes(op.kind)) {
        invalid(
          `fixture in context ${context} emitted op kind ${JSON.stringify(op.kind)}; allowed kinds here: ${allowedKinds.join(', ')}`,
        );
      }
    }
  }
}

/**
 * Strictly validates a conformance fixture set: bounded size, unique ids, and
 * no duplicate cases (same starting context plus the same normalized key
 * token). This is the entry point adapters use to validate the documents
 * under `protocol-fixtures/vim/v1/` (owned by OpenCoven/psyche-build#223).
 */
export function validateOpFixtures(
  candidates: unknown,
): asserts candidates is readonly VimOpFixture[] {
  if (!Array.isArray(candidates)) invalid('fixture set must be an array');
  if (candidates.length === 0) invalid('fixture set must contain at least one fixture');
  if (candidates.length > MAX_FIXTURES_PER_SET) {
    invalid(`fixture set exceeds ${MAX_FIXTURES_PER_SET} fixtures`);
  }
  const ids = new Set<string>();
  const cases = new Set<string>();
  candidates.forEach((candidate, index) => {
    validateOpFixture(candidate);
    const fixture = candidate as VimOpFixture;
    if (ids.has(fixture.id)) invalid(`fixture set has duplicate fixture id ${JSON.stringify(fixture.id)}`);
    ids.add(fixture.id);
    const caseKey = `${fixture.context}::${normalizedKeyToken(fixture.input)}`;
    if (cases.has(caseKey)) {
      invalid(`fixture set has duplicate case ${JSON.stringify(caseKey)} (fixture ${JSON.stringify(fixture.id)})`);
    }
    cases.add(caseKey);
  });
}

/* ------------------------------------------------------------------ *
 * Chrome-mode guard
 * ------------------------------------------------------------------ */

/**
 * Chrome key bindings from the approved design's chrome-mode interaction
 * contract. Values are either a chrome semantic op or `'pending-prefix'` for
 * keys that start a multi-key sequence (`g` for `gg`, `<C-w>` for pane
 * chords); sequence completion is the state machine's job, not the guard's.
 *
 * The configured chrome *trigger* (default `F6`) is not in this table: the
 * adapter handles it before the terminal to enter chrome mode, and it is a
 * settings concern owned by OpenCoven/psyche-build#223.
 */
export const CHROME_KEY_BINDINGS: Readonly<Record<string, VimChromeOp | 'pending-prefix'>> = {
  h: { kind: 'chrome', op: 'focus-move', direction: 'left' },
  j: { kind: 'chrome', op: 'focus-move', direction: 'down' },
  k: { kind: 'chrome', op: 'focus-move', direction: 'up' },
  l: { kind: 'chrome', op: 'focus-move', direction: 'right' },
  G: { kind: 'chrome', op: 'focus-last' },
  '<C-u>': { kind: 'chrome', op: 'page-move', direction: 'up' },
  '<C-d>': { kind: 'chrome', op: 'page-move', direction: 'down' },
  '/': { kind: 'chrome', op: 'search-open' },
  n: { kind: 'chrome', op: 'search-next' },
  N: { kind: 'chrome', op: 'search-previous' },
  '<Enter>': { kind: 'chrome', op: 'activate' },
  '<C-w>': 'pending-prefix',
  g: 'pending-prefix',
  x: { kind: 'chrome', op: 'guarded-close' },
  r: { kind: 'chrome', op: 'retry-refresh' },
  '?': { kind: 'chrome', op: 'help-open' },
  '<Esc>': { kind: 'chrome', op: 'exit' },
};

/** How the chrome-mode guard classified one normalized event. */
export type VimChromeGuardClassification =
  | 'terminal-passthrough'
  | 'chrome-pending'
  | 'chrome-unsupported'
  | 'chrome-semantic';

/** One classification decision from `chromeModeGuard`. */
export type VimChromeGuardDecision =
  | {
      /** Chrome mode is inactive: the event is opaque terminal bytes, never a semantic op. */
      readonly classification: 'terminal-passthrough';
      readonly reason: 'chrome-mode-inactive';
      readonly op?: undefined;
    }
  | {
      /** Key starts a multi-key chrome sequence; semantics resolve when it completes. */
      readonly classification: 'chrome-pending';
      readonly reason: 'chrome-mode-active-prefix-key';
      readonly op?: undefined;
    }
  | {
      /** Consumed with no side effects and a visible explanation; never sent to a PTY. */
      readonly classification: 'chrome-unsupported';
      readonly reason: 'chrome-mode-active-unmapped-key';
      readonly op?: undefined;
    }
  | {
      /** Chrome-scoped semantic op, reachable only because chrome mode is active. */
      readonly classification: 'chrome-semantic';
      readonly reason: 'chrome-mode-active-mapped-key';
      readonly op: VimChromeOp;
    };

/**
 * Classifies one normalized event against the current chrome-mode state.
 *
 * Invariants enforced here:
 * - When chrome mode is inactive, EVERY event — including keys that are
 *   chrome bindings — classifies as `terminal-passthrough`: the original
 *   bytes reach the focused surface unmodified and no semantic op is
 *   reachable. Vim support is opt-in; app chrome never intercepts Vim
 *   sequences until the user explicitly enters chrome mode.
 * - When chrome mode is active, mapped keys classify as `chrome-semantic`,
 *   prefix initiators as `chrome-pending`, and every other key as
 *   `chrome-unsupported` (consumed, no side effects). While chrome mode is
 *   active nothing falls through to the PTY: entering and leaving chrome
 *   mode never synthesizes terminal input.
 *
 * Entering chrome mode itself (the configured trigger, default `F6`) is the
 * adapter's responsibility and happens before this guard; the guard only
 * classifies once the chrome-mode state is known.
 */
export function chromeModeGuard(
  input: VimNormalizedKeyInput,
  state: VimChromeModeState,
): VimChromeGuardDecision {
  validateKeyInput(input, 'chromeModeGuard input');
  if (state === 'inactive') {
    return { classification: 'terminal-passthrough', reason: 'chrome-mode-inactive' };
  }
  const token = normalizedKeyToken(input);
  const binding = CHROME_KEY_BINDINGS[token];
  if (binding === undefined) {
    return { classification: 'chrome-unsupported', reason: 'chrome-mode-active-unmapped-key' };
  }
  if (binding === 'pending-prefix') {
    return { classification: 'chrome-pending', reason: 'chrome-mode-active-prefix-key' };
  }
  return { classification: 'chrome-semantic', reason: 'chrome-mode-active-mapped-key', op: binding };
}

/**
 * Fail-closed assertion for action executors: chrome-scoped ops may only be
 * executed while chrome mode is active. Any attempt to execute a chrome op
 * from an inactive chrome-mode state throws instead of silently dispatching.
 */
export function assertChromeOpReachable(op: VimSemanticOp, state: VimChromeModeState): void {
  if (isChromeScopedOp(op) && state === 'inactive') {
    throw new TypeError(
      `Chrome-scoped op ${JSON.stringify(op.op)} is not reachable while chrome mode is inactive: outside explicit chrome mode every event is terminal passthrough`,
    );
  }
}
