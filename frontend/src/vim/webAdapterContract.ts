/**
 * Web adapter contract for the shared Vim semantic core (v1).
 *
 * Browser/web slice of the Comprehensive Vim Support design
 * (OpenCoven/psyche-build#224, Bead `psyche-no8.2`; canonical outcome gh-246).
 * This slice is contract-only: it defines and validates how the Vue browser
 * terminal and dashboard must classify raw key events before any future
 * integration may act on them. It deliberately does NOT wire the classifier
 * into `frontend/src/components/Terminal.vue` or `Dashboard.vue`, and it
 * never touches the `/api/keys` transport or native input behavior.
 *
 * Gate rule (normative, adversarially tested):
 * - Chrome mode OFF: every key event classifies as `passthrough` carrying the
 *   exact original event reference. No key — including the `F6` trigger and
 *   `Esc` — ever produces a semantic op while the gate is off.
 * - Chrome mode ON: only the allowed chrome navigation op set below may be
 *   produced. Anything else is `unsupported` (consumed, no side effects). A
 *   pending or unsupported sequence never falls through to a PTY or text
 *   input, so consumed results never carry a replayable event.
 *
 * Entering chrome mode is intentionally outside this classifier. The design
 * resolves the configured trigger (`F6` by default) at a separate precedence
 * level before "active Psyche chrome mode", mirroring the desktop adapter,
 * which handles `F6` before xterm. The integration seam owns that trigger and
 * flips the gate; `chrome.enter` is therefore not part of the web op
 * vocabulary, and the shared `chrome-enter-f6` fixture maps to the seam
 * boundary rather than to a classification outcome (proven in
 * `__tests__/vimWebAdapterContract.test.ts`).
 *
 * Vocabulary alignment: the op set mirrors the v1 `VimAction` union of
 * `@opencoven/psyche-vim-core` minus `chrome.enter`, key normalization mirrors
 * `normalizeKeyboardEvent`, and the fixture version is pinned to `'vim/v1'`.
 * The alignment is enforced by tests instead of an import because the
 * frontend package's dependencies must not change in this slice. A fixture
 * version unknown to this contract is a conformance failure, never silently
 * accepted drift.
 */

/** Schema version of the web adapter contract. Bump only with a reviewed contract change. */
export const WEB_ADAPTER_CONTRACT_VERSION = 1 as const;

/**
 * The single shared Vim conformance fixture version this contract implements.
 * Must stay identical to the `version` field of the fixture documents under
 * `protocol-fixtures/vim/v1/` and to `VIM_ACCEPTANCE_FIXTURE_VERSION`.
 */
export const WEB_ADAPTER_FIXTURE_VERSION = 'vim/v1' as const;

export type WebAdapterFixtureVersion = typeof WEB_ADAPTER_FIXTURE_VERSION;

/**
 * Structural subset of a DOM `KeyboardEvent` used for classification. Real
 * DOM events satisfy it as-is; extra own fields are part of the opaque
 * passthrough payload and are never read, persisted, or logged here.
 */
export interface WebKeyEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly metaKey?: boolean;
}

/** Normalized key token shape, structurally identical to the shared core's. */
export interface NormalizedWebKey {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

/** Bounded pending sequence prefixes, mirroring the shared core's vocabulary. */
export type WebPendingPrefix = '' | 'g' | 'Ctrl-w';

/** Adapter state owned by the integration between key events. */
export interface WebAdapterState {
  /**
   * The chrome-mode gate. `false` means every event classifies as
   * passthrough; the gate only turns on through an explicit user action at
   * the integration seam (the configured trigger), never through this module.
   */
  readonly chromeMode: boolean;
  /** Scoped chrome search is active (entered with `/`, left with `Esc`). */
  readonly search: boolean;
  /** Incomplete pending prefix, cleared on every reset boundary. */
  readonly pending: WebPendingPrefix;
}

/** Canonical disabled/reset state: gate off, nothing pending. */
export const WEB_ADAPTER_INITIAL_STATE: WebAdapterState = Object.freeze({
  chromeMode: false,
  search: false,
  pending: '',
});

export const WEB_PANE_DIRECTIONS = ['left', 'down', 'up', 'right'] as const;

export type WebPaneDirection = (typeof WEB_PANE_DIRECTIONS)[number];

export const WEB_RESIZE_DIRECTIONS = ['grow', 'shrink', 'narrow', 'widen'] as const;

export type WebResizeDirection = (typeof WEB_RESIZE_DIRECTIONS)[number];

/**
 * The complete set of semantic ops the web adapter may produce while chrome
 * mode is ON. This is exactly the shared v1 chrome action vocabulary minus
 * `chrome.enter`, which belongs to the trigger seam, never to classification.
 */
export const WEB_ADAPTER_OP_KINDS = [
  'chrome.exit',
  'focus.first',
  'focus.last',
  'focus.activate',
  'focus.move',
  'pane.focus',
  'pane.cycle',
  'pane.equalize',
  'pane.split-horizontal',
  'pane.split-vertical',
  'pane.resize',
  'search.open',
  'search.next',
  'search.previous',
  'target.close',
  'target.refresh',
  'help.open',
] as const;

export type WebOpKind = (typeof WEB_ADAPTER_OP_KINDS)[number];

/** One semantic op for the web adapter, shaped like the shared core's actions. */
export type WebSemanticOp =
  | { readonly kind: 'chrome.exit' }
  | { readonly kind: 'focus.first' }
  | { readonly kind: 'focus.last' }
  | { readonly kind: 'focus.activate' }
  | { readonly kind: 'focus.move'; readonly direction: WebPaneDirection }
  | { readonly kind: 'pane.focus'; readonly direction: WebPaneDirection }
  | { readonly kind: 'pane.cycle' }
  | { readonly kind: 'pane.equalize' }
  | { readonly kind: 'pane.split-horizontal' }
  | { readonly kind: 'pane.split-vertical' }
  | { readonly kind: 'pane.resize'; readonly direction: WebResizeDirection }
  | { readonly kind: 'search.open' }
  | { readonly kind: 'search.next' }
  | { readonly kind: 'search.previous' }
  | { readonly kind: 'target.close' }
  | { readonly kind: 'target.refresh' }
  | { readonly kind: 'help.open' };

/** Bounded disposition vocabulary, mirroring the shared core. */
export const WEB_ADAPTER_DISPOSITIONS = ['passthrough', 'pending', 'action', 'unsupported'] as const;

export type WebAdapterDisposition = (typeof WEB_ADAPTER_DISPOSITIONS)[number];

/**
 * One classification outcome. Only `passthrough` carries the original event;
 * consumed outcomes (pending, action, unsupported) type-reject any event so a
 * consumed key can never be replayed into `/api/keys` or a text input.
 */
export type WebAdapterResult =
  | { readonly disposition: 'passthrough'; readonly pending: ''; readonly op?: never; readonly event: WebKeyEvent }
  | {
      readonly disposition: 'pending';
      readonly pending: Exclude<WebPendingPrefix, ''>;
      readonly op?: never;
      readonly event?: never;
    }
  | { readonly disposition: 'action'; readonly pending: ''; readonly op: WebSemanticOp; readonly event?: never }
  | { readonly disposition: 'unsupported'; readonly pending: ''; readonly op?: never; readonly event?: never };

/** One key-event classification step: the next state and the classification. */
export interface WebAdapterClassification {
  readonly state: WebAdapterState;
  readonly result: WebAdapterResult;
}

/**
 * Sequence timeout settings the integration must enforce at its own deadline.
 * This module stays time-free: it owns no clock, so the integration applies
 * the reset on expiry, clamped to the design bounds.
 */
export const WEB_ADAPTER_SEQUENCE_TIMEOUT_MS_DEFAULT = 1_000;
export const WEB_ADAPTER_SEQUENCE_TIMEOUT_MS_MIN = 250;
export const WEB_ADAPTER_SEQUENCE_TIMEOUT_MS_MAX = 3_000;

const FOCUS_DIRECTIONS: ReadonlyMap<string, WebPaneDirection> = new Map([
  ['h', 'left'],
  ['j', 'down'],
  ['k', 'up'],
  ['l', 'right'],
]);

const RESIZE_DIRECTIONS: ReadonlyMap<string, WebResizeDirection> = new Map([
  ['+', 'grow'],
  ['-', 'shrink'],
  ['<', 'narrow'],
  ['>', 'widen'],
]);

/** Per-kind allowed fields; the `Record` forces coverage of every op kind. */
const OP_FIELDS: Readonly<Record<WebOpKind, readonly string[]>> = {
  'chrome.exit': ['kind'],
  'focus.first': ['kind'],
  'focus.last': ['kind'],
  'focus.activate': ['kind'],
  'focus.move': ['kind', 'direction'],
  'pane.focus': ['kind', 'direction'],
  'pane.cycle': ['kind'],
  'pane.equalize': ['kind'],
  'pane.split-horizontal': ['kind'],
  'pane.split-vertical': ['kind'],
  'pane.resize': ['kind', 'direction'],
  'search.open': ['kind'],
  'search.next': ['kind'],
  'search.previous': ['kind'],
  'target.close': ['kind'],
  'target.refresh': ['kind'],
  'help.open': ['kind'],
};

function resultInvalid(message: string): never {
  throw new TypeError(`Invalid web adapter result: ${message}`);
}

function stateInvalid(message: string): never {
  throw new TypeError(`Invalid web adapter state: ${message}`);
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
    if (!allowed.includes(key)) resultInvalid(`${where} has unknown field ${JSON.stringify(key)}`);
  }
}

function hasExactModifiers(
  input: NormalizedWebKey,
  expected: Pick<NormalizedWebKey, 'ctrl' | 'alt' | 'shift' | 'meta'>,
): boolean {
  return input.ctrl === expected.ctrl && input.alt === expected.alt
    && input.shift === expected.shift && input.meta === expected.meta;
}

const plain = { ctrl: false, alt: false, shift: false, meta: false } as const;
const shiftOnly = { ctrl: false, alt: false, shift: true, meta: false } as const;
const ctrlOnly = { ctrl: true, alt: false, shift: false, meta: false } as const;

function validateWebKeyEvent(value: unknown, where: string): void {
  if (!isPlainObject(value)) resultInvalid(`${where} must be an object`);
  if (typeof value.key !== 'string' || value.key.length === 0) {
    resultInvalid(`${where} must carry a non-empty string key`);
  }
  for (const modifier of ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'] as const) {
    const present = value[modifier];
    if (present !== undefined && typeof present !== 'boolean') {
      resultInvalid(`${where} modifier ${modifier} must be a boolean`);
    }
  }
}

/**
 * Normalizes a key event exactly like the shared core's
 * `normalizeKeyboardEvent` (alias `Esc`/`Spacebar`, case-fold single
 * characters, read only the cross-platform modifier flags). Throws
 * `TypeError` on malformed events instead of guessing.
 */
export function normalizeWebKeyEvent(event: WebKeyEvent): NormalizedWebKey {
  validateWebKeyEvent(event, 'web adapter key event');
  const keyAliases: Readonly<Record<string, string>> = { Esc: 'Escape', Spacebar: ' ' };
  const aliasedKey = keyAliases[event.key] ?? event.key;
  const key = aliasedKey.length === 1 ? aliasedKey.toLowerCase() : aliasedKey;
  return {
    key,
    ctrl: event.ctrlKey === true,
    alt: event.altKey === true,
    shift: event.shiftKey === true,
    meta: event.metaKey === true,
  };
}

/** Validates an unknown value as one {@link WebSemanticOp}. */
export function validateWebSemanticOp(value: unknown): WebSemanticOp {
  if (!isPlainObject(value)) resultInvalid('semantic op must be an object');
  const kind = value.kind;
  if (typeof kind !== 'string' || !WEB_ADAPTER_OP_KINDS.includes(kind as WebOpKind)) {
    resultInvalid(`semantic op has unknown kind ${JSON.stringify(kind)}`);
  }
  const opKind = kind as WebOpKind;
  rejectUnknownFields(value, OP_FIELDS[opKind], 'semantic op');
  if (opKind === 'focus.move' || opKind === 'pane.focus') {
    validateDirection(value, WEB_PANE_DIRECTIONS, opKind);
  } else if (opKind === 'pane.resize') {
    validateDirection(value, WEB_RESIZE_DIRECTIONS, opKind);
  }
  return value as WebSemanticOp;
}

function validateDirection(
  value: Record<string, unknown>,
  allowed: readonly string[],
  kind: WebOpKind,
): void {
  const direction = value.direction;
  if (typeof direction !== 'string' || !allowed.includes(direction)) {
    resultInvalid(`semantic op ${JSON.stringify(kind)} has unknown direction ${JSON.stringify(direction)}`);
  }
}

function isPendingPrefix(value: unknown): value is WebPendingPrefix {
  return value === '' || value === 'g' || value === 'Ctrl-w';
}

/** Validates an unknown value as a strict {@link WebAdapterState}. */
export function validateWebAdapterState(value: unknown): WebAdapterState {
  if (!isPlainObject(value)) stateInvalid('state must be an object');
  for (const key of Object.keys(value)) {
    if (!['chromeMode', 'search', 'pending'].includes(key)) {
      stateInvalid(`state has unknown field ${JSON.stringify(key)}`);
    }
  }
  if (typeof value.chromeMode !== 'boolean') stateInvalid('state field chromeMode must be a boolean');
  if (typeof value.search !== 'boolean') stateInvalid('state field search must be a boolean');
  if (!isPendingPrefix(value.pending)) {
    stateInvalid(`state has unknown pending sequence ${JSON.stringify(value.pending)}`);
  }
  if (!value.chromeMode && (value.search || value.pending !== '')) {
    stateInvalid('state with the gate off cannot retain a search context or pending sequence');
  }
  if (value.search && value.pending !== '') {
    stateInvalid('state in scoped search cannot retain a pending sequence');
  }
  return { chromeMode: value.chromeMode, search: value.search, pending: value.pending };
}

/**
 * Validates an unknown value as a {@link WebAdapterState}, falling back to the
 * canonical disabled state on any failure, so invalid persisted or restored
 * state degrades to disabled/default behavior instead of throwing.
 */
export function safeWebAdapterState(value: unknown): WebAdapterState {
  try {
    return validateWebAdapterState(value);
  } catch {
    return WEB_ADAPTER_INITIAL_STATE;
  }
}

/**
 * Validates an unknown value as a strict {@link WebAdapterResult}. The
 * envelope (disposition, pending, op, event) is exact; the passthrough event
 * payload stays opaque beyond requiring a readable key, because the contract
 * guarantees identity preservation, not payload minimization.
 */
export function validateWebAdapterResult(value: unknown): WebAdapterResult {
  if (!isPlainObject(value)) resultInvalid('result must be an object');
  rejectUnknownFields(value, ['disposition', 'pending', 'op', 'event'], 'result');
  const disposition = value.disposition;
  if (typeof disposition !== 'string' || !WEB_ADAPTER_DISPOSITIONS.includes(disposition as WebAdapterDisposition)) {
    resultInvalid(`result has unknown disposition ${JSON.stringify(disposition)}`);
  }
  if (disposition === 'passthrough') {
    if (value.pending !== '') resultInvalid('passthrough result must carry an empty pending sequence');
    if (value.op !== undefined) resultInvalid('passthrough result must not carry a semantic op');
    validateWebKeyEvent(value.event, 'passthrough result event');
    return value as WebAdapterResult;
  }
  if (value.event !== undefined) {
    resultInvalid(`${disposition} results are consumed and must never carry a replayable event`);
  }
  if (disposition === 'pending') {
    if (value.pending !== 'g' && value.pending !== 'Ctrl-w') {
      resultInvalid(`pending result has unknown pending sequence ${JSON.stringify(value.pending)}`);
    }
    if (value.op !== undefined) resultInvalid('pending result must not carry a semantic op');
    return value as WebAdapterResult;
  }
  if (value.pending !== '') resultInvalid(`${disposition} result must carry an empty pending sequence`);
  if (disposition === 'action') {
    if (value.op === undefined) resultInvalid('action result must carry a semantic op');
    validateWebSemanticOp(value.op);
  } else if (value.op !== undefined) {
    resultInvalid('unsupported result must not carry a semantic op');
  }
  return value as WebAdapterResult;
}

function passthroughResult(event: WebKeyEvent): WebAdapterResult {
  return Object.freeze({ disposition: 'passthrough', pending: '', event });
}

function pendingResult(pending: Exclude<WebPendingPrefix, ''>): WebAdapterResult {
  return Object.freeze({ disposition: 'pending', pending });
}

function actionResult(op: WebSemanticOp): WebAdapterResult {
  return Object.freeze({ disposition: 'action', pending: '', op: Object.freeze(op) });
}

function unsupportedResult(): WebAdapterResult {
  return Object.freeze({ disposition: 'unsupported', pending: '' });
}

function onState(pending: WebPendingPrefix): WebAdapterState {
  return Object.freeze({ chromeMode: true, search: false, pending });
}

const SEARCH_STATE: WebAdapterState = Object.freeze({ chromeMode: true, search: true, pending: '' });

function stepChromeNormal(state: WebAdapterState, input: NormalizedWebKey): WebAdapterClassification {
  const consume = (result: WebAdapterResult, next: WebAdapterState): WebAdapterClassification =>
    ({ state: next, result });

  if (input.key === 'Escape' && hasExactModifiers(input, plain)) {
    return consume(actionResult({ kind: 'chrome.exit' }), WEB_ADAPTER_INITIAL_STATE);
  }

  if (state.pending === 'g') {
    if (input.key === 'g' && hasExactModifiers(input, plain)) {
      return consume(actionResult({ kind: 'focus.first' }), onState(''));
    }
    return consume(unsupportedResult(), onState(''));
  }

  if (state.pending === 'Ctrl-w') {
    const focusDirection = FOCUS_DIRECTIONS.get(input.key);
    if (hasExactModifiers(input, plain) && focusDirection) {
      return consume(actionResult({ kind: 'pane.focus', direction: focusDirection }), onState(''));
    }
    if (hasExactModifiers(input, plain) && input.key === 'w') {
      return consume(actionResult({ kind: 'pane.cycle' }), onState(''));
    }
    const resize = RESIZE_DIRECTIONS.get(input.key);
    if ((hasExactModifiers(input, plain) || hasExactModifiers(input, shiftOnly)) && resize) {
      return consume(actionResult({ kind: 'pane.resize', direction: resize }), onState(''));
    }
    if (hasExactModifiers(input, plain) && input.key === '=') {
      return consume(actionResult({ kind: 'pane.equalize' }), onState(''));
    }
    if (hasExactModifiers(input, plain) && input.key === 's') {
      return consume(actionResult({ kind: 'pane.split-horizontal' }), onState(''));
    }
    if (hasExactModifiers(input, plain) && input.key === 'v') {
      return consume(actionResult({ kind: 'pane.split-vertical' }), onState(''));
    }
    return consume(unsupportedResult(), onState(''));
  }

  if (hasExactModifiers(input, ctrlOnly) && input.key === 'w') {
    return consume(pendingResult('Ctrl-w'), onState('Ctrl-w'));
  }
  if (hasExactModifiers(input, shiftOnly) && input.key === 'g') {
    return consume(actionResult({ kind: 'focus.last' }), onState(''));
  }
  if (hasExactModifiers(input, plain) && input.key === 'g') {
    return consume(pendingResult('g'), onState('g'));
  }
  const direction = FOCUS_DIRECTIONS.get(input.key);
  if (hasExactModifiers(input, plain) && direction) {
    return consume(actionResult({ kind: 'focus.move', direction }), onState(''));
  }
  if (hasExactModifiers(input, plain) && input.key === 'Enter') {
    return consume(actionResult({ kind: 'focus.activate' }), onState(''));
  }
  if (hasExactModifiers(input, plain) && input.key === '/') {
    return consume(actionResult({ kind: 'search.open' }), SEARCH_STATE);
  }
  if (hasExactModifiers(input, plain) && input.key === 'x') {
    return consume(actionResult({ kind: 'target.close' }), onState(''));
  }
  if (hasExactModifiers(input, plain) && input.key === 'r') {
    return consume(actionResult({ kind: 'target.refresh' }), onState(''));
  }
  if (hasExactModifiers(input, shiftOnly) && input.key === '?') {
    return consume(actionResult({ kind: 'help.open' }), onState(''));
  }
  return consume(unsupportedResult(), onState(''));
}

function stepChromeSearch(input: NormalizedWebKey): WebAdapterClassification {
  const consume = (result: WebAdapterResult, next: WebAdapterState = SEARCH_STATE): WebAdapterClassification =>
    ({ state: next, result });

  if (input.key === 'Escape' && hasExactModifiers(input, plain)) {
    return consume(actionResult({ kind: 'chrome.exit' }), WEB_ADAPTER_INITIAL_STATE);
  }
  if (hasExactModifiers(input, plain) && input.key === 'n') {
    return consume(actionResult({ kind: 'search.next' }));
  }
  if (hasExactModifiers(input, shiftOnly) && input.key === 'n') {
    return consume(actionResult({ kind: 'search.previous' }));
  }
  return consume(unsupportedResult());
}

/**
 * Classifies one raw key event against the chrome-mode gate.
 *
 * With the gate OFF the event is returned as `passthrough` carrying the exact
 * original event reference — the adapter's existing `/api/keys` and native
 * input paths run unchanged. With the gate ON the event classifies against
 * the restricted op set above; anything else is consumed as `unsupported`.
 * Malformed events or states throw `TypeError` instead of guessing.
 */
export function classifyWebKeyEvent(state: WebAdapterState, event: WebKeyEvent): WebAdapterClassification {
  const current = validateWebAdapterState(state);
  validateWebKeyEvent(event, 'web adapter key event');
  if (!current.chromeMode) {
    return { state: WEB_ADAPTER_INITIAL_STATE, result: passthroughResult(event) };
  }
  const input = normalizeWebKeyEvent(event);
  return current.search ? stepChromeSearch(input) : stepChromeNormal(current, input);
}

/**
 * Clears an incomplete pending sequence without leaving chrome mode, for the
 * timeout, focus-loss, and modal-opening reset boundaries. The integration
 * owns the deadline clock; this module stays time-free.
 */
export function clearWebAdapterPending(state: WebAdapterState): WebAdapterState {
  const current = validateWebAdapterState(state);
  if (current.pending === '') return current;
  return current.search ? SEARCH_STATE : onState('');
}

/** Full reset to the canonical disabled state (disable, disposal, replacement). */
export function resetWebAdapter(state: WebAdapterState): WebAdapterState {
  validateWebAdapterState(state);
  return WEB_ADAPTER_INITIAL_STATE;
}
