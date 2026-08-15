import { normalizeKeyboardEvent } from './normalize.js';
import type {
  KeyboardEventLike,
  NormalizedKey,
  VimAction,
  VimConsumedResult,
  VimContext,
  VimInputResult,
  VimResult,
} from './types.js';

const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 3_000;

export interface ChromeMachineOptions {
  readonly enabled: boolean;
  readonly trigger?: string | NormalizedKey;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface ChromeMachine {
  handle(event: KeyboardEventLike): VimInputResult;
  /** Clears an incomplete sequence without changing chrome mode. */
  focusLost(): VimResult;
  /** Clears an incomplete sequence without changing chrome mode. */
  reset(): VimResult;
  snapshot(): VimResult;
}

function parseTrigger(trigger: string | NormalizedKey | undefined): NormalizedKey {
  if (trigger === undefined) return { key: 'F6', ctrl: false, alt: false, shift: false, meta: false };

  if (typeof trigger !== 'string') {
    const candidate = trigger as unknown as Record<string, unknown>;
    if (typeof candidate.key !== 'string' || candidate.key.length === 0
      || typeof candidate.ctrl !== 'boolean' || typeof candidate.alt !== 'boolean'
      || typeof candidate.shift !== 'boolean' || typeof candidate.meta !== 'boolean') {
      throw new TypeError('Chrome trigger object must contain a key and boolean modifiers');
    }
    return normalizeKeyboardEvent({
      key: candidate.key,
      ctrlKey: candidate.ctrl,
      altKey: candidate.alt,
      shiftKey: candidate.shift,
      metaKey: candidate.meta,
    });
  }

  const parts = trigger.split('-');
  const key = parts.at(-1);
  const modifiers = parts.slice(0, -1);
  if (!key || new Set(['Ctrl', 'Alt', 'Shift', 'Meta']).has(key)) {
    throw new TypeError('Chrome trigger must include a non-modifier key');
  }

  const allowedModifiers = new Set(['Ctrl', 'Alt', 'Shift', 'Meta']);
  const seenModifiers = new Set<string>();
  for (const modifier of modifiers) {
    if (!allowedModifiers.has(modifier)) throw new TypeError(`Chrome trigger has unknown modifier ${modifier}`);
    if (seenModifiers.has(modifier)) throw new TypeError(`Chrome trigger has duplicate modifier ${modifier}`);
    seenModifiers.add(modifier);
  }

  return normalizeKeyboardEvent({
    key,
    ctrlKey: seenModifiers.has('Ctrl'),
    altKey: seenModifiers.has('Alt'),
    shiftKey: seenModifiers.has('Shift'),
    metaKey: seenModifiers.has('Meta'),
  });
}

function keysEqual(left: NormalizedKey, right: NormalizedKey): boolean {
  return left.key === right.key
    && left.ctrl === right.ctrl
    && left.alt === right.alt
    && left.shift === right.shift
    && left.meta === right.meta;
}

function actionResult(context: VimContext, action: VimAction): VimConsumedResult {
  return { disposition: 'action', context, pending: '', actions: [action] };
}

function result(context: VimContext, pending = ''): VimConsumedResult {
  return { disposition: pending ? 'pending' : 'unsupported', context, pending, actions: [] };
}

const focusDirections = new Map<string, 'left' | 'down' | 'up' | 'right'>([
  ['h', 'left'], ['j', 'down'], ['k', 'up'], ['l', 'right'],
]);

const paneResize = new Map<string, 'grow' | 'shrink' | 'narrow' | 'widen'>([
  ['+', 'grow'], ['-', 'shrink'], ['<', 'narrow'], ['>', 'widen'],
]);

function hasExactModifiers(input: NormalizedKey, expected: Pick<NormalizedKey, 'ctrl' | 'alt' | 'shift' | 'meta'>): boolean {
  return input.ctrl === expected.ctrl && input.alt === expected.alt
    && input.shift === expected.shift && input.meta === expected.meta;
}

const plain = { ctrl: false, alt: false, shift: false, meta: false } as const;
const shiftOnly = { ctrl: false, alt: false, shift: true, meta: false } as const;
const ctrlOnly = { ctrl: true, alt: false, shift: false, meta: false } as const;

/**
 * Pure reference state machine for opt-in application chrome navigation.
 * Platform adapters decide where to route a returned passthrough event.
 */
export function createChromeMachine(options: ChromeMachineOptions): ChromeMachine {
  const timeoutMs = options.timeoutMs ?? 1_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`Chrome sequence timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}ms`);
  }

  const now = options.now ?? Date.now;
  const trigger = parseTrigger(options.trigger);
  let context: VimContext = options.enabled ? 'passthrough' : 'disabled';
  let pending = '';
  let pendingStartedAt: number | undefined;

  function clearPending(): void {
    pending = '';
    pendingStartedAt = undefined;
  }

  function snapshot(): VimConsumedResult {
    return {
      disposition: pending ? 'pending' : 'unsupported',
      context,
      pending,
      actions: [],
    };
  }

  function setPending(nextPending: string): VimConsumedResult {
    pending = nextPending;
    pendingStartedAt = now();
    return { disposition: 'pending', context, pending, actions: [] };
  }

  function unsupported(): VimConsumedResult {
    clearPending();
    return result(context);
  }

  function handleChromeNormal(input: NormalizedKey): VimConsumedResult {
    if (input.key === 'Escape' && hasExactModifiers(input, plain)) {
      clearPending();
      context = 'passthrough';
      return actionResult(context, { type: 'chrome.exit' });
    }

    if (pending === 'g') {
      if (input.key === 'g' && hasExactModifiers(input, plain)) {
        clearPending();
        return actionResult(context, { type: 'focus.first' });
      }
      return unsupported();
    }

    if (pending === 'Ctrl-w') {
      const direction = focusDirections.get(input.key);
      if (hasExactModifiers(input, plain) && direction) {
        clearPending();
        return actionResult(context, { type: 'pane.focus', direction });
      }
      if (hasExactModifiers(input, plain) && input.key === 'w') {
        clearPending();
        return actionResult(context, { type: 'pane.cycle' });
      }
      const resize = paneResize.get(input.key);
      if ((hasExactModifiers(input, plain) || hasExactModifiers(input, shiftOnly)) && resize) {
        clearPending();
        return actionResult(context, { type: 'pane.resize', direction: resize });
      }
      if (hasExactModifiers(input, plain) && input.key === '=') {
        clearPending();
        return actionResult(context, { type: 'pane.equalize' });
      }
      if (hasExactModifiers(input, plain) && input.key === 's') {
        clearPending();
        return actionResult(context, { type: 'pane.split-horizontal' });
      }
      if (hasExactModifiers(input, plain) && input.key === 'v') {
        clearPending();
        return actionResult(context, { type: 'pane.split-vertical' });
      }
      return unsupported();
    }

    if (hasExactModifiers(input, ctrlOnly) && input.key === 'w') return setPending('Ctrl-w');
    if (hasExactModifiers(input, shiftOnly) && input.key === 'g') {
      return actionResult(context, { type: 'focus.last' });
    }
    if (hasExactModifiers(input, plain) && input.key === 'g') return setPending('g');
    const direction = focusDirections.get(input.key);
    if (hasExactModifiers(input, plain) && direction) {
      return actionResult(context, { type: 'focus.move', direction });
    }
    if (hasExactModifiers(input, plain) && input.key === 'Enter') {
      return actionResult(context, { type: 'focus.activate' });
    }
    if (hasExactModifiers(input, plain) && input.key === '/') {
      context = 'chrome-search';
      return actionResult(context, { type: 'search.open' });
    }
    if (hasExactModifiers(input, plain) && input.key === 'x') return actionResult(context, { type: 'target.close' });
    if (hasExactModifiers(input, plain) && input.key === 'r') return actionResult(context, { type: 'target.refresh' });
    if (hasExactModifiers(input, shiftOnly) && input.key === '?') return actionResult(context, { type: 'help.open' });
    return unsupported();
  }

  function handleChromeSearch(input: NormalizedKey): VimConsumedResult {
    if (input.key === 'Escape' && hasExactModifiers(input, plain)) {
      clearPending();
      context = 'passthrough';
      return actionResult(context, { type: 'chrome.exit' });
    }
    if (hasExactModifiers(input, plain) && input.key === 'n') {
      return actionResult(context, { type: 'search.next' });
    }
    if (hasExactModifiers(input, shiftOnly) && input.key === 'n') {
      return actionResult(context, { type: 'search.previous' });
    }
    return unsupported();
  }

  return {
    handle(event) {
      const input = normalizeKeyboardEvent(event);
      if (context === 'disabled') {
        return { disposition: 'passthrough', context, pending: '', actions: [], event };
      }

      if (pendingStartedAt !== undefined && now() - pendingStartedAt >= timeoutMs) clearPending();

      if (context === 'passthrough') {
        if (keysEqual(input, trigger)) {
          context = 'chrome-normal';
          return actionResult(context, { type: 'chrome.enter' });
        }
        return { disposition: 'passthrough', context, pending: '', actions: [], event };
      }

      return context === 'chrome-normal' ? handleChromeNormal(input) : handleChromeSearch(input);
    },
    focusLost() {
      clearPending();
      return snapshot();
    },
    reset() {
      clearPending();
      return snapshot();
    },
    snapshot,
  };
}
