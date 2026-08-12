import type { NormalizedKey, VimAction, VimContext, VimDisposition } from './types.js';

export interface VimFixtureTrace {
  readonly id: string;
  readonly context: VimContext;
  readonly sequence: readonly Partial<NormalizedKey>[];
  readonly disposition: VimDisposition;
  readonly expected: { readonly context: VimContext; readonly pending: string };
  readonly actions: readonly VimAction[];
}

export interface VimFixtureDocument {
  readonly version: 'vim/v1';
  readonly traces: readonly VimFixtureTrace[];
}

const contexts = new Set<VimContext>(['disabled', 'passthrough', 'chrome-normal', 'chrome-search', 'editor']);
const dispositions = new Set<VimDisposition>(['passthrough', 'pending', 'action', 'unsupported']);
const directions = new Set(['left', 'down', 'up', 'right']);
const resizeDirections = new Set(['grow', 'shrink', 'narrow', 'widen']);
const actionTypes = new Set<VimAction['type']>([
  'chrome.enter', 'chrome.exit', 'focus.first', 'focus.last', 'focus.activate',
  'focus.move', 'pane.focus', 'pane.cycle', 'pane.equalize', 'pane.split-horizontal', 'pane.split-vertical',
  'pane.resize', 'search.open', 'search.next', 'search.previous', 'target.close', 'target.refresh', 'help.open',
]);
const MAX_TRACE_COUNT = 256;
const MAX_ACTION_COUNT = 32;
const MAX_STRING_LENGTH = 256;
const modifiers = ['ctrl', 'alt', 'shift', 'meta'] as const;

function invalid(message: string): never {
  throw new TypeError(`Invalid Vim fixture: ${message}`);
}

function validateString(value: unknown, field: string, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > MAX_STRING_LENGTH) {
    invalid(`${field} has an invalid string`);
  }
}

function validateAction(action: unknown, traceId: string): void {
  if (!action || typeof action !== 'object' || !('type' in action) || typeof action.type !== 'string') {
    invalid(`${traceId} has an action without a type`);
  }
  validateString(action.type, `${traceId} action type`);
  if (!actionTypes.has(action.type as VimAction['type'])) invalid(`${traceId} has an unknown action ${action.type}`);
  if ((action.type === 'focus.move' || action.type === 'pane.focus') && (!('direction' in action) || typeof action.direction !== 'string' || !directions.has(action.direction))) {
    invalid(`${traceId} has an invalid direction for ${action.type}`);
  }
  if (action.type === 'pane.resize' && (!('direction' in action) || typeof action.direction !== 'string' || !resizeDirections.has(action.direction))) {
    invalid(`${traceId} has an invalid direction for pane.resize`);
  }
}

/** Validates bounded, versioned conformance traces before a platform consumes them. */
export function validateVimFixtures(document: unknown): asserts document is VimFixtureDocument {
  if (!document || typeof document !== 'object') invalid('document must be an object');
  const candidate = document as Record<string, unknown>;
  if (candidate.version !== 'vim/v1') invalid('document must declare version vim/v1');
  if (!Array.isArray(candidate.traces)) invalid('document must contain traces');
  if (candidate.traces.length > MAX_TRACE_COUNT) invalid(`trace count exceeds ${MAX_TRACE_COUNT}`);

  const ids = new Set<string>();
  for (const entry of candidate.traces) {
    const trace = entry as Record<string, unknown>;
    if (!trace || typeof trace !== 'object') invalid('trace must be an object');
    validateString(trace.id, 'trace id');
    if (ids.has(trace.id)) invalid(`duplicate id ${trace.id}`);
    ids.add(trace.id);
    validateString(trace.context, `${trace.id} context`);
    if (!contexts.has(trace.context as VimContext)) invalid(`${trace.id} has an unknown context`);
    if (!Object.hasOwn(trace, 'disposition') || !dispositions.has(trace.disposition as VimDisposition)) {
      invalid(`${trace.id} has an absent or unknown disposition`);
    }
    validateString(trace.disposition, `${trace.id} disposition`);
    if (!Array.isArray(trace.sequence)) invalid(`${trace.id} must have a sequence`);
    if (trace.sequence.length > 32) invalid(`${trace.id} sequence exceeds 32 tokens`);
    for (const token of trace.sequence) {
      if (!token || typeof token !== 'object') invalid(`${trace.id} has an invalid token`);
      validateString(token.key, `${trace.id} token key`);
      for (const modifier of modifiers) {
        if (Object.hasOwn(token, modifier) && typeof token[modifier] !== 'boolean') {
          invalid(`${trace.id} has an invalid ${modifier} modifier`);
        }
      }
    }
    if (!trace.expected || typeof trace.expected !== 'object') invalid(`${trace.id} must have expected state`);
    const expected = trace.expected as Record<string, unknown>;
    validateString(expected.context, `${trace.id} expected context`);
    if (!contexts.has(expected.context as VimContext)) invalid(`${trace.id} has an unknown expected context`);
    validateString(expected.pending, `${trace.id} expected pending`, true);
    if (!Array.isArray(trace.actions)) invalid(`${trace.id} must have actions`);
    if (trace.actions.length > MAX_ACTION_COUNT) invalid(`${trace.id} action count exceeds ${MAX_ACTION_COUNT}`);
    for (const action of trace.actions) validateAction(action, trace.id);
  }
}

export const validateChromeFixtures = validateVimFixtures;
