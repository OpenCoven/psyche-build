import { normalizeKeyboardEvent } from './normalize.js';
import type {
  KeyboardEventLike,
  NormalizedKey,
  VimAction,
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
  if (typeof trigger !== 'string') {
    return trigger ?? { key: 'F6', ctrl: false, alt: false, shift: false, meta: false };
  }

  const parts = trigger.split('-');
  const key = parts.pop();
  if (!key) throw new TypeError('Chrome trigger must include a key');

  return {
    key: key.length === 1 ? key.toLowerCase() : key,
    ctrl: parts.includes('Ctrl'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
    meta: parts.includes('Meta'),
  };
}

function keysEqual(left: NormalizedKey, right: NormalizedKey): boolean {
  return left.key === right.key
    && left.ctrl === right.ctrl
    && left.alt === right.alt
    && left.shift === right.shift
    && left.meta === right.meta;
}

function actionResult(context: VimContext, action: VimAction): VimResult {
  return { disposition: 'action', context, pending: '', actions: [action] };
}

function result(context: VimContext, pending = ''): VimResult {
  return { disposition: pending ? 'pending' : 'unsupported', context, pending, actions: [] };
}

const focusDirections: Readonly<Record<string, 'left' | 'down' | 'up' | 'right'>> = {
  h: 'left',
  j: 'down',
  k: 'up',
  l: 'right',
};

const paneResize: Readonly<Record<string, 'grow' | 'shrink' | 'narrow' | 'widen'>> = {
  '+': 'grow',
  '-': 'shrink',
  '<': 'narrow',
  '>': 'widen',
};

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

  function snapshot(): VimResult {
    return {
      disposition: pending ? 'pending' : 'unsupported',
      context,
      pending,
      actions: [],
    };
  }

  function setPending(nextPending: string): VimResult {
    pending = nextPending;
    pendingStartedAt = now();
    return { disposition: 'pending', context, pending, actions: [] };
  }

  function unsupported(): VimResult {
    clearPending();
    return result(context);
  }

  function handleChromeNormal(input: NormalizedKey): VimResult {
    if (input.key === 'Escape') {
      clearPending();
      context = 'passthrough';
      return actionResult(context, { type: 'chrome.exit' });
    }

    if (pending === 'g') {
      if (input.key === 'g' && !input.ctrl && !input.alt && !input.meta) {
        clearPending();
        return actionResult(context, { type: 'focus.first' });
      }
      return unsupported();
    }

    if (pending === 'Ctrl-w') {
      if (!input.ctrl && !input.alt && !input.meta && input.key in focusDirections) {
        clearPending();
        return actionResult(context, { type: 'pane.focus', direction: focusDirections[input.key]! });
      }
      if (!input.ctrl && !input.alt && !input.meta && input.key === 'w') {
        clearPending();
        return actionResult(context, { type: 'pane.cycle' });
      }
      if (!input.ctrl && !input.alt && !input.meta && input.key in paneResize) {
        clearPending();
        return actionResult(context, { type: 'pane.resize', direction: paneResize[input.key]! });
      }
      if (!input.ctrl && !input.alt && !input.meta && input.key === '=') {
        clearPending();
        return actionResult(context, { type: 'pane.equalize' });
      }
      if (!input.ctrl && !input.alt && !input.meta && input.key === 's') {
        clearPending();
        return actionResult(context, { type: 'pane.split-horizontal' });
      }
      if (!input.ctrl && !input.alt && !input.meta && input.key === 'v') {
        clearPending();
        return actionResult(context, { type: 'pane.split-vertical' });
      }
      return unsupported();
    }

    if (input.ctrl && !input.alt && !input.meta && input.key === 'w') return setPending('Ctrl-w');
    if (!input.ctrl && !input.alt && !input.meta && input.key === 'g' && input.shift) {
      return actionResult(context, { type: 'focus.last' });
    }
    if (!input.ctrl && !input.alt && !input.meta && input.key === 'g') return setPending('g');
    if (!input.ctrl && !input.alt && !input.meta && input.key in focusDirections) {
      return actionResult(context, { type: 'focus.move', direction: focusDirections[input.key]! });
    }
    if (!input.ctrl && !input.alt && !input.meta && input.key === 'Enter') {
      return actionResult(context, { type: 'focus.activate' });
    }
    if (!input.ctrl && !input.alt && !input.meta && input.key === '/') {
      context = 'chrome-search';
      return actionResult(context, { type: 'search.open' });
    }
    if (!input.ctrl && !input.alt && !input.meta && input.key === 'x') return actionResult(context, { type: 'target.close' });
    if (!input.ctrl && !input.alt && !input.meta && input.key === 'r') return actionResult(context, { type: 'target.refresh' });
    if (!input.ctrl && !input.alt && !input.meta && input.key === '?') return actionResult(context, { type: 'help.open' });
    return unsupported();
  }

  function handleChromeSearch(input: NormalizedKey): VimResult {
    if (input.key === 'Escape') {
      clearPending();
      context = 'passthrough';
      return actionResult(context, { type: 'chrome.exit' });
    }
    if (!input.ctrl && !input.alt && !input.meta && input.key === 'n' && !input.shift) {
      return actionResult(context, { type: 'search.next' });
    }
    if (!input.ctrl && !input.alt && !input.meta && input.key === 'n' && input.shift) {
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
