import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createChromeMachine,
  normalizeKeyboardEvent,
  type VimAction,
  type VimFixtureDocument,
} from '@opencoven/psyche-vim-core';
import { describe, expect, it } from 'vitest';
import {
  WEB_ADAPTER_CONTRACT_VERSION,
  WEB_ADAPTER_FIXTURE_VERSION,
  WEB_ADAPTER_INITIAL_STATE,
  WEB_ADAPTER_OP_KINDS,
  classifyWebKeyEvent,
  clearWebAdapterPending,
  normalizeWebKeyEvent,
  resetWebAdapter,
  safeWebAdapterState,
  validateWebAdapterResult,
  validateWebAdapterState,
  type WebAdapterResult,
  type WebAdapterState,
  type WebKeyEvent,
  type WebSemanticOp,
} from '../frontend/src/vim/webAdapterContract.js';

const fixtures = JSON.parse(
  readFileSync(join(process.cwd(), 'protocol-fixtures/vim/v1/chrome.json'), 'utf8'),
) as VimFixtureDocument;

function key(
  key: string,
  modifiers: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {},
): WebKeyEvent {
  return {
    key,
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
    metaKey: modifiers.meta ?? false,
  };
}

const ON: WebAdapterState = { chromeMode: true, search: false, pending: '' };
const SEARCH: WebAdapterState = { chromeMode: true, search: true, pending: '' };

/** Maps a web op onto the shared core's v1 action shape for drift comparison. */
function toVimAction(op: WebSemanticOp): VimAction {
  switch (op.kind) {
    case 'focus.move':
      return { type: op.kind, direction: op.direction };
    case 'pane.focus':
      return { type: op.kind, direction: op.direction };
    case 'pane.resize':
      return { type: op.kind, direction: op.direction };
    case 'chrome.exit':
    case 'focus.first':
    case 'focus.last':
    case 'focus.activate':
      return { type: op.kind };
    case 'pane.cycle':
    case 'pane.equalize':
    case 'pane.split-horizontal':
    case 'pane.split-vertical':
      return { type: op.kind };
    default:
      return { type: op.kind };
  }
}

const KEY_CLASSES: readonly WebKeyEvent[] = [
  key('h'), key('H'), key('5'), key('/'), key('?'), key(' '), key('n'), key('N'), key('g'), key('G'),
  key('Escape'), key('Enter'), key('Tab'), key('Backspace'), key('ArrowUp'), key('ArrowLeft'),
  key('F1'), key('F6'), key('F12'),
  key('c', { ctrl: true }), key('u', { ctrl: true }), key('w', { ctrl: true }),
  key('h', { ctrl: true, shift: true }), key('a', { alt: true }), key('c', { meta: true }),
  key('g', { shift: true }), key('/', { shift: true }),
  key('Shift'), key('Control'), key('Alt'), key('Meta'), key('CapsLock'),
  key('Process'), key('Unidentified'), key('Dead'), key('MediaPlayPause'),
];

const SINGLE_KEY_OPS: readonly { name: string; event: WebKeyEvent; op: WebSemanticOp }[] = [
  { name: 'h moves focus left', event: key('h'), op: { kind: 'focus.move', direction: 'left' } },
  { name: 'j moves focus down', event: key('j'), op: { kind: 'focus.move', direction: 'down' } },
  { name: 'k moves focus up', event: key('k'), op: { kind: 'focus.move', direction: 'up' } },
  { name: 'l moves focus right', event: key('l'), op: { kind: 'focus.move', direction: 'right' } },
  { name: 'G moves to the last item', event: key('G', { shift: true }), op: { kind: 'focus.last' } },
  { name: 'Enter activates the focused target', event: key('Enter'), op: { kind: 'focus.activate' } },
  { name: 'x requests a guarded close', event: key('x'), op: { kind: 'target.close' } },
  { name: 'r requests refresh', event: key('r'), op: { kind: 'target.refresh' } },
  { name: '? opens target-aware help', event: key('?', { shift: true }), op: { kind: 'help.open' } },
];

const CTRL_W_OPS: readonly { name: string; event: WebKeyEvent; op: WebSemanticOp }[] = [
  { name: 'Ctrl-w h focuses the left pane', event: key('h'), op: { kind: 'pane.focus', direction: 'left' } },
  { name: 'Ctrl-w j focuses the pane below', event: key('j'), op: { kind: 'pane.focus', direction: 'down' } },
  { name: 'Ctrl-w k focuses the pane above', event: key('k'), op: { kind: 'pane.focus', direction: 'up' } },
  { name: 'Ctrl-w l focuses the right pane', event: key('l'), op: { kind: 'pane.focus', direction: 'right' } },
  { name: 'Ctrl-w w cycles panes', event: key('w'), op: { kind: 'pane.cycle' } },
  { name: 'Ctrl-w = equalizes the layout', event: key('='), op: { kind: 'pane.equalize' } },
  { name: 'Ctrl-w s splits horizontally', event: key('s'), op: { kind: 'pane.split-horizontal' } },
  { name: 'Ctrl-w v splits vertically', event: key('v'), op: { kind: 'pane.split-vertical' } },
  { name: 'Ctrl-w + grows the pane', event: key('+', { shift: true }), op: { kind: 'pane.resize', direction: 'grow' } },
  { name: 'Ctrl-w - shrinks the pane', event: key('-'), op: { kind: 'pane.resize', direction: 'shrink' } },
  { name: 'Ctrl-w < narrows the pane', event: key('<', { shift: true }), op: { kind: 'pane.resize', direction: 'narrow' } },
  { name: 'Ctrl-w > widens the pane', event: key('>', { shift: true }), op: { kind: 'pane.resize', direction: 'widen' } },
];

const BAD_EVENTS: readonly { name: string; event: unknown }[] = [
  { name: 'null', event: null },
  { name: 'undefined', event: undefined },
  { name: 'a string', event: 'F6' },
  { name: 'a number', event: 42 },
  { name: 'an array', event: [] },
  { name: 'an object without a key', event: { ctrlKey: false } },
  { name: 'a non-string key', event: { key: 6 } },
  { name: 'an empty key', event: { key: '' } },
  { name: 'a non-boolean modifier', event: { key: 'h', ctrlKey: 1 } },
];

const BAD_RESULTS: readonly { name: string; value: unknown }[] = [
  { name: 'null', value: null },
  { name: 'undefined', value: undefined },
  { name: 'a number', value: 7 },
  { name: 'an array', value: [] },
  { name: 'an empty object', value: {} },
  { name: 'an unknown field', value: { disposition: 'unsupported', pending: '', extra: true } },
  { name: 'an unknown disposition', value: { disposition: 'maybe', pending: '' } },
  { name: 'a passthrough without an event', value: { disposition: 'passthrough', pending: '' } },
  { name: 'a passthrough with an op', value: { disposition: 'passthrough', pending: '', op: { kind: 'help.open' } } },
  { name: 'a passthrough with a stale pending sequence', value: { disposition: 'passthrough', pending: 'g', event: key('h') } },
  { name: 'a passthrough event without a key', value: { disposition: 'passthrough', pending: '', event: { ctrlKey: false } } },
  { name: 'a passthrough event with a non-string key', value: { disposition: 'passthrough', pending: '', event: { key: 6 } } },
  { name: 'a passthrough event with a non-boolean modifier', value: { disposition: 'passthrough', pending: '', event: { key: 'h', ctrlKey: 'yes' } } },
  { name: 'a pending result with an empty sequence', value: { disposition: 'pending', pending: '' } },
  { name: 'a pending result with an unknown prefix', value: { disposition: 'pending', pending: 'Ctrl-x' } },
  { name: 'a pending result carrying an event', value: { disposition: 'pending', pending: 'g', event: key('g') } },
  { name: 'a pending result carrying an op', value: { disposition: 'pending', pending: 'g', op: { kind: 'help.open' } } },
  { name: 'an action without an op', value: { disposition: 'action', pending: '' } },
  { name: 'an action with the forbidden chrome.enter op', value: { disposition: 'action', pending: '', op: { kind: 'chrome.enter' } } },
  { name: 'an action with an unknown op kind', value: { disposition: 'action', pending: '', op: { kind: 'pane.delete' } } },
  { name: 'an action with an unknown op field', value: { disposition: 'action', pending: '', op: { kind: 'help.open', extra: 1 } } },
  { name: 'a focus.move without a direction', value: { disposition: 'action', pending: '', op: { kind: 'focus.move' } } },
  { name: 'a focus.move with an unknown direction', value: { disposition: 'action', pending: '', op: { kind: 'focus.move', direction: 'in' } } },
  { name: 'a pane.resize with a pane direction', value: { disposition: 'action', pending: '', op: { kind: 'pane.resize', direction: 'left' } } },
  { name: 'an action with a stale pending sequence', value: { disposition: 'action', pending: 'g', op: { kind: 'help.open' } } },
  { name: 'an action carrying an event', value: { disposition: 'action', pending: '', op: { kind: 'help.open' }, event: key('h') } },
  { name: 'an unsupported result carrying an op', value: { disposition: 'unsupported', pending: '', op: { kind: 'help.open' } } },
  { name: 'an unsupported result with a pending sequence', value: { disposition: 'unsupported', pending: 'g' } },
];

const BAD_STATES: readonly { name: string; value: unknown }[] = [
  { name: 'null', value: null },
  { name: 'undefined', value: undefined },
  { name: 'a number', value: 5 },
  { name: 'a string', value: 'on' },
  { name: 'an array', value: [] },
  { name: 'an empty object', value: {} },
  { name: 'a non-boolean gate', value: { chromeMode: 'yes', search: false, pending: '' } },
  { name: 'a missing search flag', value: { chromeMode: true, pending: '' } },
  { name: 'an unknown field', value: { chromeMode: true, search: false, pending: '', extra: 1 } },
  { name: 'an unknown pending sequence', value: { chromeMode: true, search: false, pending: 'Ctrl-x' } },
  { name: 'a gate-off state with a pending sequence', value: { chromeMode: false, search: false, pending: 'g' } },
  { name: 'a gate-off state with a search context', value: { chromeMode: false, search: true, pending: '' } },
  { name: 'a search state with a pending sequence', value: { chromeMode: true, search: true, pending: 'g' } },
];

describe('web adapter contract: chrome mode off', () => {
  it.each(KEY_CLASSES)('classifies $key as passthrough with the original event', (event) => {
    const step = classifyWebKeyEvent(WEB_ADAPTER_INITIAL_STATE, event);

    expect(step.result).toEqual({ disposition: 'passthrough', pending: '', event });
    expect(step.result.disposition).toBe('passthrough');
    expect(step.result.event).toBe(event);
    expect(step.result.op).toBeUndefined();
    expect(step.state).toEqual(WEB_ADAPTER_INITIAL_STATE);
  });

  it('passes the F6 trigger through: entry belongs to the trigger seam, not classification', () => {
    // The shared core, when enabled, resolves F6 at the trigger precedence
    // level; the web classifier models the "active chrome mode" level below
    // it, so with the gate off F6 is an ordinary function key.
    const machine = createChromeMachine({ enabled: true, now: () => 0 });
    expect(machine.handle(key('F6'))).toMatchObject({ disposition: 'action', actions: [{ type: 'chrome.enter' }] });

    const web = classifyWebKeyEvent(WEB_ADAPTER_INITIAL_STATE, key('F6'));
    expect(web.result.disposition).toBe('passthrough');
    expect(web.result.event).toBeDefined();
    expect('op' in web.result).toBe(false);
  });

  it('never produces a semantic op for keys that are ops while chrome mode is on', () => {
    const chromeVocabularyKeys: readonly WebKeyEvent[] = [
      key('h'), key('j'), key('k'), key('l'), key('g'), key('G', { shift: true }),
      key('Enter'), key('/'), key('n'), key('N', { shift: true }), key('x'), key('r'),
      key('?', { shift: true }), key('w', { ctrl: true }), key('Escape'),
    ];
    for (const event of chromeVocabularyKeys) {
      const step = classifyWebKeyEvent(WEB_ADAPTER_INITIAL_STATE, event);
      expect(step.result.disposition).toBe('passthrough');
      expect('op' in step.result).toBe(false);
    }
  });

  it.each(BAD_EVENTS)('type-rejects $name as key events', ({ event }) => {
    expect(() => classifyWebKeyEvent(WEB_ADAPTER_INITIAL_STATE, event as WebKeyEvent)).toThrow(TypeError);
  });

  it('type-rejects malformed adapter state instead of guessing', () => {
    expect(() => classifyWebKeyEvent({ chromeMode: 'off' } as unknown as WebAdapterState, key('h'))).toThrow(TypeError);
  });

  it('refuses state objects that keep a pending sequence or search context while off', () => {
    expect(() => validateWebAdapterState({ chromeMode: false, search: false, pending: 'g' })).toThrow(TypeError);
    expect(() => validateWebAdapterState({ chromeMode: false, search: true, pending: '' })).toThrow(TypeError);
  });
});

describe('web adapter contract: chrome mode on', () => {
  it.each(SINGLE_KEY_OPS)('classifies $name to exactly one allowed op', ({ event, op }) => {
    const step = classifyWebKeyEvent(ON, event);

    expect(step.result).toEqual({ disposition: 'action', pending: '', op });
    expect(step.state).toEqual(ON);
  });

  it.each(CTRL_W_OPS)('classifies $name through the pending pane prefix', ({ event, op }) => {
    const prefix = classifyWebKeyEvent(ON, key('w', { ctrl: true }));
    expect(prefix.result).toEqual({ disposition: 'pending', pending: 'Ctrl-w' });
    expect(prefix.state).toEqual({ chromeMode: true, search: false, pending: 'Ctrl-w' });

    const step = classifyWebKeyEvent(prefix.state, event);
    expect(step.result).toEqual({ disposition: 'action', pending: '', op });
    expect(step.state).toEqual(ON);
  });

  it('moves to the first item through a pending g step', () => {
    const first = classifyWebKeyEvent(ON, key('g'));
    expect(first.result).toEqual({ disposition: 'pending', pending: 'g' });
    expect(first.state).toEqual({ chromeMode: true, search: false, pending: 'g' });

    const second = classifyWebKeyEvent(first.state, key('g'));
    expect(second.result).toEqual({ disposition: 'action', pending: '', op: { kind: 'focus.first' } });
    expect(second.state).toEqual(ON);
  });

  it('opens scoped search and routes next/previous only inside it', () => {
    const open = classifyWebKeyEvent(ON, key('/'));
    expect(open.result).toEqual({ disposition: 'action', pending: '', op: { kind: 'search.open' } });
    expect(open.state).toEqual(SEARCH);

    expect(classifyWebKeyEvent(SEARCH, key('n')).result).toEqual({
      disposition: 'action', pending: '', op: { kind: 'search.next' },
    });
    expect(classifyWebKeyEvent(SEARCH, key('N', { shift: true })).result).toEqual({
      disposition: 'action', pending: '', op: { kind: 'search.previous' },
    });

    // Search is scoped: navigation keys and a nested '/' are consumed, not ops.
    const stray = classifyWebKeyEvent(SEARCH, key('h'));
    expect(stray.result).toEqual({ disposition: 'unsupported', pending: '' });
    expect(stray.state).toEqual(SEARCH);
    const nestedOpen = classifyWebKeyEvent(SEARCH, key('/'));
    expect(nestedOpen.result.disposition).toBe('unsupported');
    expect(nestedOpen.state).toEqual(SEARCH);
  });

  it('exits chrome mode on Escape and turns the gate off without an event', () => {
    const exit = classifyWebKeyEvent(ON, key('Escape'));
    expect(exit.result).toEqual({ disposition: 'action', pending: '', op: { kind: 'chrome.exit' } });
    expect('event' in exit.result).toBe(false);
    expect(exit.state).toEqual(WEB_ADAPTER_INITIAL_STATE);
  });

  it('exits chrome mode from scoped search on Escape', () => {
    const exit = classifyWebKeyEvent(SEARCH, key('Escape'));
    expect(exit.result).toMatchObject({ disposition: 'action', op: { kind: 'chrome.exit' } });
    expect(exit.state).toEqual(WEB_ADAPTER_INITIAL_STATE);
  });

  it('exits chrome mode even when a sequence is pending', () => {
    const pendingG = classifyWebKeyEvent(ON, key('g')).state;
    const exitFromG = classifyWebKeyEvent(pendingG, key('Escape'));
    expect(exitFromG.result).toMatchObject({ disposition: 'action', op: { kind: 'chrome.exit' } });
    expect(exitFromG.state).toEqual(WEB_ADAPTER_INITIAL_STATE);

    const pendingCtrlW = classifyWebKeyEvent(ON, key('w', { ctrl: true })).state;
    const exitFromCtrlW = classifyWebKeyEvent(pendingCtrlW, key('Escape'));
    expect(exitFromCtrlW.result).toMatchObject({ disposition: 'action', op: { kind: 'chrome.exit' } });
    expect(exitFromCtrlW.state).toEqual(WEB_ADAPTER_INITIAL_STATE);
  });

  it('consumes keys outside the allowed op set as unsupported, never passthrough', () => {
    const unsupportedKeys: readonly WebKeyEvent[] = [
      key('q'), key('b'), key('F6'), key('u', { ctrl: true }), key('d', { ctrl: true }),
      key('H', { shift: true }), key('h', { ctrl: true }), key('a', { alt: true }),
      key('Shift'), key('1'), key('Process'),
    ];
    for (const event of unsupportedKeys) {
      const step = classifyWebKeyEvent(ON, event);
      expect(step.result.disposition).toBe('unsupported');
      expect(step.result.disposition).not.toBe('passthrough');
      expect('event' in step.result).toBe(false);
      expect('op' in step.result).toBe(false);
      // Chrome mode stays on; product state is unchanged.
      expect(step.state).toEqual(ON);
    }
  });

  it('consumes page moves as unsupported: they are not in the v1 web vocabulary yet', () => {
    // The approved design lists Ctrl-u/Ctrl-d page moves, but the shared v1
    // action vocabulary does not carry them. The gate must consume rather
    // than invent an op or leak the chord into /api/keys.
    for (const event of [key('u', { ctrl: true }), key('d', { ctrl: true })]) {
      const step = classifyWebKeyEvent(ON, event);
      expect(step.result).toEqual({ disposition: 'unsupported', pending: '' });
    }
  });

  it('resets a pending sequence to empty when an unknown key follows it', () => {
    const gThenJ = classifyWebKeyEvent(classifyWebKeyEvent(ON, key('g')).state, key('j'));
    expect(gThenJ.result).toEqual({ disposition: 'unsupported', pending: '' });
    expect(gThenJ.state).toEqual(ON);

    const ctrlWThenQ = classifyWebKeyEvent(
      classifyWebKeyEvent(ON, key('w', { ctrl: true })).state,
      key('q'),
    );
    expect(ctrlWThenQ.result).toEqual({ disposition: 'unsupported', pending: '' });
    expect(ctrlWThenQ.state).toEqual(ON);

    const ctrlWThenCtrlW = classifyWebKeyEvent(
      classifyWebKeyEvent(ON, key('w', { ctrl: true })).state,
      key('w', { ctrl: true }),
    );
    expect(ctrlWThenCtrlW.result.disposition).toBe('unsupported');
    expect(ctrlWThenCtrlW.state).toEqual(ON);
  });

  it('never lets a consumed sequence fall through as a replayable event', () => {
    let state: WebAdapterState = ON;
    const sequence: readonly WebKeyEvent[] = [
      key('g'), key('j'), key('w', { ctrl: true }), key('q'), key('h'), key('Escape'),
    ];
    for (const event of sequence) {
      const step = classifyWebKeyEvent(state, event);
      state = step.state;
      if (step.result.disposition === 'passthrough') {
        throw new Error(`consumed sequence unexpectedly fell through for ${String(event.key)}`);
      }
      expect('event' in step.result).toBe(false);
    }
    expect(state).toEqual(WEB_ADAPTER_INITIAL_STATE);
  });

  it('types results so only passthrough includes the original event', () => {
    const consumed: WebAdapterResult = classifyWebKeyEvent(ON, key('h')).result;
    expect(consumed.event).toBeUndefined();

    // @ts-expect-error consumed keys must never be replayable by an adapter.
    const replayable: WebAdapterResult = {
      disposition: 'action',
      pending: '',
      op: { kind: 'focus.activate' },
      event: key('x'),
    };
    void replayable;

    // @ts-expect-error chrome.enter is owned by the trigger seam, not the web op vocabulary.
    const enterOp: WebSemanticOp = { kind: 'chrome.enter' };
    void enterOp;
  });
});

describe('shared v1 fixture alignment', () => {
  it('pins the shared fixture version and the contract version', () => {
    expect(WEB_ADAPTER_FIXTURE_VERSION).toBe(fixtures.version);
    expect(WEB_ADAPTER_FIXTURE_VERSION).toBe('vim/v1');
    expect(WEB_ADAPTER_CONTRACT_VERSION).toBe(1);
  });

  it('exposes exactly the shared v1 chrome vocabulary minus chrome.enter', () => {
    expect([...WEB_ADAPTER_OP_KINDS].sort()).toEqual([
      'chrome.exit', 'focus.activate', 'focus.first', 'focus.last', 'focus.move',
      'help.open', 'pane.cycle', 'pane.equalize', 'pane.focus', 'pane.resize',
      'pane.split-horizontal', 'pane.split-vertical', 'search.next', 'search.open',
      'search.previous', 'target.close', 'target.refresh',
    ].sort());
    expect(WEB_ADAPTER_OP_KINDS).not.toContain('chrome.enter');
  });

  it.each(fixtures.traces)('replays fixture $id through the web gate', (trace) => {
    if (trace.context === 'passthrough' || trace.context === 'disabled') {
      // chrome-enter-f6: the trigger seam enters chrome mode in the shared
      // core, while the web classifier with the gate off passes F6 through.
      const machine = createChromeMachine({ enabled: trace.context !== 'disabled', now: () => 0 });
      const coreResult = machine.handle(key(trace.sequence[0]?.key ?? 'F6'));
      expect(coreResult.actions).toEqual(trace.actions);

      const web = classifyWebKeyEvent(WEB_ADAPTER_INITIAL_STATE, key(trace.sequence[0]?.key ?? 'F6'));
      expect(web.result.disposition).toBe('passthrough');
      expect('op' in web.result).toBe(false);
      return;
    }

    let state: WebAdapterState = trace.context === 'chrome-search' ? SEARCH : ON;
    let last: WebAdapterResult | undefined;
    for (const token of trace.sequence) {
      const step = classifyWebKeyEvent(state, key(token.key!, token));
      state = step.state;
      last = step.result;
    }

    expect(last).toBeDefined();
    expect(last!.disposition).toBe(trace.disposition);
    expect(last!.pending).toBe(trace.expected.pending);
    if (last!.disposition === 'action') {
      expect(toVimAction(last!.op)).toEqual(trace.actions[0]);
    } else {
      expect(trace.actions).toEqual([]);
    }
  });

  it.each([
    key('h'), key('H'), key('Esc'), key('Spacebar'), key('Enter'), key('F6'), key('g', { ctrl: true, shift: true }),
  ])('normalizes $key exactly like the shared core', (event) => {
    expect(normalizeWebKeyEvent(event)).toEqual(normalizeKeyboardEvent(event));
  });

  it('stays a pure module: no runtime imports and no DOM references', () => {
    const source = readFileSync(join(process.cwd(), 'frontend/src/vim/webAdapterContract.ts'), 'utf8');
    expect(source.match(/^import\s/m)).toBeNull();
    expect(source.match(/\brequire\(/)).toBeNull();
    expect(source.match(/\b(document|window)\./)).toBeNull();
  });
});

describe('strict web adapter validators', () => {
  it('accepts every emitted result shape', () => {
    expect(validateWebAdapterResult({ disposition: 'passthrough', pending: '', event: key('q') }))
      .toMatchObject({ disposition: 'passthrough' });
    expect(validateWebAdapterResult({ disposition: 'pending', pending: 'Ctrl-w' }))
      .toMatchObject({ disposition: 'pending' });
    expect(validateWebAdapterResult({ disposition: 'action', pending: '', op: { kind: 'help.open' } }))
      .toMatchObject({ disposition: 'action' });
    expect(validateWebAdapterResult({ disposition: 'unsupported', pending: '' }))
      .toMatchObject({ disposition: 'unsupported' });
  });

  it.each(BAD_RESULTS)('rejects $name', ({ value }) => {
    expect(() => validateWebAdapterResult(value)).toThrow(TypeError);
  });

  it('accepts the canonical states', () => {
    expect(validateWebAdapterState(WEB_ADAPTER_INITIAL_STATE)).toEqual(WEB_ADAPTER_INITIAL_STATE);
    expect(validateWebAdapterState(ON)).toEqual(ON);
    expect(validateWebAdapterState(SEARCH)).toEqual(SEARCH);
    expect(validateWebAdapterState({ chromeMode: true, search: false, pending: 'Ctrl-w' }))
      .toEqual({ chromeMode: true, search: false, pending: 'Ctrl-w' });
  });

  it.each(BAD_STATES)('rejects $name as adapter state', ({ value }) => {
    expect(() => validateWebAdapterState(value)).toThrow(TypeError);
  });

  it('falls back to the disabled state for invalid persisted state', () => {
    expect(safeWebAdapterState('nonsense')).toEqual(WEB_ADAPTER_INITIAL_STATE);
    expect(safeWebAdapterState({ chromeMode: false, search: true, pending: '' })).toEqual(WEB_ADAPTER_INITIAL_STATE);
    expect(safeWebAdapterState(SEARCH)).toEqual(SEARCH);
    expect(() => safeWebAdapterState(null)).not.toThrow();
  });

  it('clears pending sequences without leaving chrome mode', () => {
    expect(clearWebAdapterPending({ chromeMode: true, search: false, pending: 'Ctrl-w' }))
      .toEqual({ chromeMode: true, search: false, pending: '' });
    expect(clearWebAdapterPending(SEARCH)).toEqual(SEARCH);
    expect(clearWebAdapterPending(WEB_ADAPTER_INITIAL_STATE)).toEqual(WEB_ADAPTER_INITIAL_STATE);
  });

  it('resets fully to the canonical disabled state', () => {
    expect(resetWebAdapter(SEARCH)).toEqual(WEB_ADAPTER_INITIAL_STATE);
    expect(resetWebAdapter({ chromeMode: true, search: false, pending: 'g' })).toEqual(WEB_ADAPTER_INITIAL_STATE);
  });
});
