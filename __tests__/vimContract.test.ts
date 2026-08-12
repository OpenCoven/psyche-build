import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createChromeMachine,
  normalizeKeyboardEvent,
  validateVimFixtures,
  type VimFixtureDocument,
  type VimInputResult,
  type NormalizedKey,
} from '@opencoven/psyche-vim-core';
import { describe, expect, it } from 'vitest';

const fixturePath = join(process.cwd(), 'protocol-fixtures/vim/v1/chrome.json');
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8')) as VimFixtureDocument;
const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

function key(key: string, modifiers: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) {
  return {
    key,
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
    metaKey: modifiers.meta ?? false,
  };
}

function prepareTraceMachine(context: VimFixtureDocument['traces'][number]['context']) {
  const machine = createChromeMachine({ enabled: context !== 'disabled', now: () => 0 });
  if (context === 'chrome-normal' || context === 'chrome-search') machine.handle(key('F6'));
  if (context === 'chrome-search') machine.handle(key('/'));
  return machine;
}

describe('Vim v1 chrome contract', () => {
  it('validates the versioned chrome traces', () => {
    expect(() => validateVimFixtures(fixtures)).not.toThrow();
  });

  it.each(fixtures.traces)('replays fixture $id through the chrome machine', (trace) => {
    const machine = prepareTraceMachine(trace.context);
    const result = trace.sequence.reduce(
      (_previous, token) => machine.handle(key(token.key!, token)),
      machine.snapshot(),
    );

    expect(result).toEqual({
      disposition: trace.disposition,
      context: trace.expected.context,
      pending: trace.expected.pending,
      actions: trace.actions,
    });
  });

  it('keeps the private core out of production dependencies', () => {
    expect(rootPackage.dependencies['@opencoven/psyche-vim-core']).toBeUndefined();
    expect(rootPackage.devDependencies['@opencoven/psyche-vim-core']).toBe('workspace:*');
  });

  it('normalizes keyboard modifiers without platform imports', () => {
    expect(normalizeKeyboardEvent(key('H', { ctrl: true, shift: true }))).toEqual({
      key: 'h',
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
    });
  });

  it('enters chrome mode with F6 and exits on Escape without passthrough', () => {
    const event = key('F6');
    const machine = createChromeMachine({ enabled: true, now: () => 0 });

    expect(machine.handle(event)).toMatchObject({
      disposition: 'action',
      context: 'chrome-normal',
      pending: '',
      actions: [{ type: 'chrome.enter' }],
    });

    const exit = machine.handle(key('Escape'));
    expect(exit).toMatchObject({
      disposition: 'action',
      context: 'passthrough',
      pending: '',
      actions: [{ type: 'chrome.exit' }],
    });
    expect(exit.event).toBeUndefined();
  });

  it('passes disabled input through as its original event', () => {
    const event = key('F6');
    const result = createChromeMachine({ enabled: false, now: () => 0 }).handle(event);

    expect(result).toMatchObject({
      disposition: 'passthrough',
      context: 'disabled',
      pending: '',
      actions: [],
    });
    expect(result.event).toBe(event);
  });

  it('types input results so only passthrough includes the original event', () => {
    const result: VimInputResult = createChromeMachine({ enabled: false }).handle(key('F6'));
    if (result.disposition === 'passthrough') expect(result.event).toBeDefined();
    else expect(result.event).toBeUndefined();

    // @ts-expect-error Consumed keys must never be replayed by an adapter.
    const invalidResult: VimInputResult = {
      disposition: 'action',
      context: 'chrome-normal',
      pending: '',
      actions: [],
      event: key('x'),
    };
    void invalidResult;
  });

  it('emits focus.first for g g', () => {
    const machine = createChromeMachine({ enabled: true, now: () => 0 });
    machine.handle(key('F6'));

    expect(machine.handle(key('g'))).toMatchObject({ disposition: 'pending', pending: 'g' });
    expect(machine.handle(key('g'))).toMatchObject({
      disposition: 'action',
      pending: '',
      actions: [{ type: 'focus.first' }],
    });
  });

  it('distinguishes shifted G and N after normalization', () => {
    const machine = createChromeMachine({ enabled: true, now: () => 0 });
    machine.handle(key('F6'));

    expect(machine.handle(key('G', { shift: true }))).toMatchObject({
      disposition: 'action',
      actions: [{ type: 'focus.last' }],
    });

    machine.handle(key('/'));
    expect(machine.handle(key('N', { shift: true }))).toMatchObject({
      disposition: 'action',
      actions: [{ type: 'search.previous' }],
    });
  });

  it('emits pane.focus-left for Ctrl-w h', () => {
    const machine = createChromeMachine({ enabled: true, now: () => 0 });
    machine.handle(key('F6'));

    expect(machine.handle(key('w', { ctrl: true }))).toMatchObject({
      disposition: 'pending',
      pending: 'Ctrl-w',
    });
    expect(machine.handle(key('h'))).toMatchObject({
      disposition: 'action',
      pending: '',
      actions: [{ type: 'pane.focus', direction: 'left' }],
    });
  });

  it('consumes unsupported chrome prefixes', () => {
    const machine = createChromeMachine({ enabled: true, now: () => 0 });
    machine.handle(key('F6'));
    machine.handle(key('g'));

    const unsupported = machine.handle(key('x'));
    expect(unsupported).toMatchObject({
      disposition: 'unsupported',
      context: 'chrome-normal',
      pending: '',
      actions: [],
    });
    expect(unsupported.event).toBeUndefined();
  });

  it('requires exact modifiers for normal and destructive mappings', () => {
    const machine = createChromeMachine({ enabled: true, now: () => 0 });
    machine.handle(key('F6'));

    expect(machine.handle(key('g'))).toMatchObject({ disposition: 'pending', pending: 'g' });
    expect(machine.handle(key('G', { shift: true }))).toMatchObject({ disposition: 'unsupported', actions: [] });
    expect(machine.handle(key('H', { shift: true }))).toMatchObject({ disposition: 'unsupported', actions: [] });
    expect(machine.handle(key('X', { shift: true }))).toMatchObject({ disposition: 'unsupported', actions: [] });
    expect(machine.handle(key('w', { ctrl: true, shift: true }))).toMatchObject({ disposition: 'unsupported', actions: [] });
  });

  it('does not treat inherited object properties as focus mappings', () => {
    const machine = createChromeMachine({ enabled: true, now: () => 0 });
    machine.handle(key('F6'));

    expect(machine.handle(key('toString'))).toMatchObject({ disposition: 'unsupported', actions: [] });
  });

  it('resets pending keys on timeout and focus loss', () => {
    let time = 0;
    const machine = createChromeMachine({ enabled: true, timeoutMs: 1_000, now: () => time });
    machine.handle(key('F6'));
    machine.handle(key('g'));

    time = 1_001;
    expect(machine.handle(key('g'))).toMatchObject({ disposition: 'pending', pending: 'g', actions: [] });

    machine.focusLost();
    expect(machine.handle(key('g'))).toMatchObject({ disposition: 'pending', pending: 'g', actions: [] });
  });

  it('rejects malformed fixture traces', () => {
    const trace = fixtures.traces[0]!;
    expect(() => validateVimFixtures({ ...fixtures, traces: [trace, trace] })).toThrow(/duplicate/i);
    expect(() => validateVimFixtures({ ...fixtures, traces: [{ ...trace, context: 'unknown' }] })).toThrow(/context/i);
    expect(() => validateVimFixtures({ ...fixtures, traces: [{ ...trace, actions: [{ type: 'unknown' }] }] })).toThrow(/action/i);
    expect(() => validateVimFixtures({ ...fixtures, traces: [{ ...trace, disposition: undefined }] })).toThrow(/disposition/i);
    expect(() => validateVimFixtures({ ...fixtures, traces: [{ ...trace, sequence: Array(33).fill({ key: 'g' }) }] })).toThrow(/32/i);
    expect(() => validateVimFixtures({ ...fixtures, traces: [{ ...trace, sequence: [{ key: 'g', ctrl: 'true' }] }] })).toThrow(/modifier/i);
    expect(() => validateVimFixtures({ ...fixtures, traces: Array.from({ length: 257 }, (_, index) => ({ ...trace, id: `trace-${index}` })) })).toThrow(/trace count/i);
    expect(() => validateVimFixtures({ ...fixtures, traces: [{ ...trace, actions: Array(33).fill({ type: 'focus.first' }) }] })).toThrow(/action count/i);
    expect(() => validateVimFixtures({ ...fixtures, traces: [{ ...trace, id: 'x'.repeat(257) }] })).toThrow(/string/i);
  });

  it('rejects ambiguous string and malformed object triggers', () => {
    expect(() => createChromeMachine({ enabled: true, trigger: 'Ctrl-Ctrl-F6' })).toThrow(/duplicate/i);
    expect(() => createChromeMachine({ enabled: true, trigger: 'Ctrl-Hyper-F6' })).toThrow(/unknown/i);
    expect(() => createChromeMachine({
      enabled: true,
      trigger: { key: 'F6', ctrl: false, alt: false, shift: false } as unknown as NormalizedKey,
    })).toThrow(/trigger/i);
  });
});
