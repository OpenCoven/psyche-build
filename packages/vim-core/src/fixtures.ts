import type { NormalizedKey, VimAction, VimContext, VimDisposition } from './types.js';

export interface VimFixtureTrace {
  readonly id: string;
  readonly context: VimContext;
  readonly sequence: readonly Partial<NormalizedKey>[];
  readonly disposition: VimDisposition;
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

function invalid(message: string): never {
  throw new TypeError(`Invalid Vim fixture: ${message}`);
}

function validateAction(action: unknown, traceId: string): void {
  if (!action || typeof action !== 'object' || !('type' in action) || typeof action.type !== 'string') {
    invalid(`${traceId} has an action without a type`);
  }
  if (!actionTypes.has(action.type as VimAction['type'])) invalid(`${traceId} has an unknown action ${action.type}`);
  if ((action.type === 'focus.move' || action.type === 'pane.focus') && (!('direction' in action) || !directions.has(String(action.direction)))) {
    invalid(`${traceId} has an invalid direction for ${action.type}`);
  }
  if (action.type === 'pane.resize' && (!('direction' in action) || !resizeDirections.has(String(action.direction)))) {
    invalid(`${traceId} has an invalid direction for pane.resize`);
  }
}

/** Validates bounded, versioned conformance traces before a platform consumes them. */
export function validateVimFixtures(document: unknown): asserts document is VimFixtureDocument {
  if (!document || typeof document !== 'object') invalid('document must be an object');
  const candidate = document as Record<string, unknown>;
  if (candidate.version !== 'vim/v1') invalid('document must declare version vim/v1');
  if (!Array.isArray(candidate.traces)) invalid('document must contain traces');

  const ids = new Set<string>();
  for (const entry of candidate.traces) {
    const trace = entry as Record<string, unknown>;
    if (!trace || typeof trace !== 'object') invalid('trace must be an object');
    if (typeof trace.id !== 'string' || trace.id.length === 0) invalid('trace must have an id');
    if (ids.has(trace.id)) invalid(`duplicate id ${trace.id}`);
    ids.add(trace.id);
    if (!contexts.has(trace.context as VimContext)) invalid(`${trace.id} has an unknown context`);
    if (!Object.hasOwn(trace, 'disposition') || !dispositions.has(trace.disposition as VimDisposition)) {
      invalid(`${trace.id} has an absent or unknown disposition`);
    }
    if (!Array.isArray(trace.sequence)) invalid(`${trace.id} must have a sequence`);
    if (trace.sequence.length > 32) invalid(`${trace.id} sequence exceeds 32 tokens`);
    for (const token of trace.sequence) {
      if (!token || typeof token !== 'object' || typeof token.key !== 'string') invalid(`${trace.id} has an invalid token`);
    }
    if (!Array.isArray(trace.actions)) invalid(`${trace.id} must have actions`);
    for (const action of trace.actions) validateAction(action, trace.id);
  }
}

export const validateChromeFixtures = validateVimFixtures;
