import { describe, it, expect } from 'vitest';
import {
  VIM_SEMANTIC_CONTRACT_VERSION,
  VIM_CONTRACT_FIXTURE_VERSION,
  VIM_CHROME_MODES,
  assertChromeOpReachable,
  chromeModeGuard,
  isChromeScopedOp,
  normalizedKeyToken,
  validateOpFixture,
  validateOpFixtures,
  validateSemanticOp,
  type VimChromeGuardDecision,
  type VimNormalizedKeyInput,
} from '../src/vim/semanticContract.js';

/** Builds a minimal valid fixture; every field can be overridden per test. */
function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fixtureVersion: VIM_CONTRACT_FIXTURE_VERSION,
    id: 'fixture-default',
    context: 'disabled',
    input: { key: 'h', bytes: 'h' },
    expected: { disposition: 'passthrough', passthroughBytes: 'h' },
    ...overrides,
  };
}

function assertInvalid(run: () => unknown, expectedMessagePart: string): void {
  let threw: unknown;
  try {
    run();
  } catch (error) {
    threw = error;
  }
  expect(threw).toBeInstanceOf(TypeError);
  expect((threw as TypeError | undefined)?.message).toContain(expectedMessagePart);
}

describe('vim semantic contract versioning', () => {
  it('exposes the v1 contract version and shared fixture version', () => {
    expect(VIM_SEMANTIC_CONTRACT_VERSION).toBe(1);
    // Must stay identical to #227's VIM_ACCEPTANCE_FIXTURE_VERSION and the
    // protocol-fixtures/vim/v1/ documents owned by #223.
    expect(VIM_CONTRACT_FIXTURE_VERSION).toBe('vim/v1');
  });

  it('bounds the chrome-mode state vocabulary', () => {
    expect([...VIM_CHROME_MODES]).toEqual(['inactive', 'active-normal', 'active-search']);
  });

  it('normalizes key chords deterministically', () => {
    expect(normalizedKeyToken({ key: 'h' })).toBe('h');
    expect(normalizedKeyToken({ key: 'G' })).toBe('G');
    expect(normalizedKeyToken({ key: 'u', modifiers: ['ctrl'] })).toBe('<C-u>');
    expect(normalizedKeyToken({ key: 'x', modifiers: ['ctrl', 'shift'] })).toBe('<C-S-x>');
    expect(normalizedKeyToken({ key: 'u', modifiers: [] })).toBe('u');
  });
});

describe('chromeModeGuard: chrome-mode-off passthrough invariant', () => {
  const inactiveCases: Array<{ label: string; input: VimNormalizedKeyInput }> = [
    { label: 'chrome focus key', input: { key: 'h' } },
    { label: 'chrome guarded close key', input: { key: 'x' } },
    { label: 'chrome search key', input: { key: '/' } },
    { label: 'chrome pane prefix chord', input: { key: 'w', modifiers: ['ctrl'] } },
    { label: 'chrome exit key', input: { key: 'Esc' } },
    { label: 'unmapped key', input: { key: 'q' } },
    { label: 'unmapped control chord', input: { key: 'h', modifiers: ['ctrl'] } },
  ];

  for (const { label, input } of inactiveCases) {
    it(`classifies ${label} as terminal passthrough, never a semantic op, while chrome mode is inactive`, () => {
      const decision: VimChromeGuardDecision = chromeModeGuard(input, 'inactive');
      expect(decision.classification).toBe('terminal-passthrough');
      expect(decision.reason).toBe('chrome-mode-inactive');
      expect(decision.op).toBeUndefined();
    });
  }

  it('refuses to execute chrome ops from an inactive chrome-mode state', () => {
    const guardedClose = { kind: 'chrome', op: 'guarded-close' } as const;
    expect(() => assertChromeOpReachable(guardedClose, 'inactive')).toThrow(TypeError);
    expect(() => assertChromeOpReachable(guardedClose, 'inactive')).toThrow(
      /not reachable while chrome mode is inactive/,
    );
  });

  it('does not treat non-chrome semantic ops as chrome-scoped', () => {
    const deleteLine = { kind: 'edit', op: 'delete-line' } as const;
    expect(isChromeScopedOp(deleteLine)).toBe(false);
    expect(() => assertChromeOpReachable(deleteLine, 'inactive')).not.toThrow();
  });
});

describe('chromeModeGuard: chrome-mode-active classification', () => {
  it('maps bound keys to chrome semantic ops only while chrome mode is active', () => {
    const decision = chromeModeGuard({ key: 'h' }, 'active-normal');
    expect(decision.classification).toBe('chrome-semantic');
    if (decision.classification === 'chrome-semantic') {
      expect(decision.op).toEqual({ kind: 'chrome', op: 'focus-move', direction: 'left' });
      expect(() => assertChromeOpReachable(decision.op, 'active-normal')).not.toThrow();
    }
  });

  it('classifies guarded close as a chrome request, not a direct action', () => {
    const decision = chromeModeGuard({ key: 'x' }, 'active-normal');
    expect(decision).toMatchObject({
      classification: 'chrome-semantic',
      op: { kind: 'chrome', op: 'guarded-close' },
    });
  });

  it('normalizes control chords before table lookup', () => {
    const decision = chromeModeGuard({ key: 'u', modifiers: ['ctrl'] }, 'active-normal');
    expect(decision).toMatchObject({
      classification: 'chrome-semantic',
      op: { kind: 'chrome', op: 'page-move', direction: 'up' },
    });
  });

  it('classifies prefix initiators as pending, not as an op', () => {
    expect(chromeModeGuard({ key: 'g' }, 'active-normal').classification).toBe('chrome-pending');
    const paneChord = chromeModeGuard({ key: 'w', modifiers: ['ctrl'] }, 'active-normal');
    expect(paneChord.classification).toBe('chrome-pending');
    expect(paneChord.op).toBeUndefined();
  });

  it('consumes unmapped keys without side effects while chrome mode is active', () => {
    const unmapped: VimNormalizedKeyInput[] = [
      { key: 'q' },
      { key: 'h', modifiers: ['ctrl'] },
      { key: 'F12' },
    ];
    for (const input of unmapped) {
      const decision = chromeModeGuard(input, 'active-normal');
      expect(decision.classification).toBe('chrome-unsupported');
      expect(decision.op).toBeUndefined();
    }
    // The same key is passthrough again once chrome mode exits.
    expect(chromeModeGuard({ key: 'q' }, 'inactive').classification).toBe('terminal-passthrough');
  });

  it('fails closed on malformed guard input', () => {
    assertInvalid(() => chromeModeGuard({ key: '' }, 'active-normal'), 'must be a string of length 1..');
    assertInvalid(
      () => chromeModeGuard({ key: 'h', modifiers: ['caps-lock' as never] }, 'active-normal'),
      'unknown modifier',
    );
  });
});

describe('validateOpFixture: accept', () => {
  it('accepts a byte-exact passthrough fixture and narrows the type', () => {
    const candidate: unknown = fixture({
      id: 'disabled-h-passthrough',
      context: 'disabled',
      input: { key: 'h', bytes: 'h' },
      expected: { disposition: 'passthrough', passthroughBytes: 'h' },
    });
    validateOpFixture(candidate);
    expect(candidate.context).toBe('disabled');
    expect(candidate.expected.disposition).toBe('passthrough');
  });

  it('accepts a chrome action fixture with a bounded op', () => {
    const candidate: unknown = fixture({
      id: 'chrome-h-focus-move',
      context: 'chrome-normal',
      input: { key: 'h' },
      expected: {
        disposition: 'action',
        ops: [{ kind: 'chrome', op: 'focus-move', direction: 'left' }],
        stateAfter: 'chrome-normal',
      },
    });
    expect(() => validateOpFixture(candidate)).not.toThrow();
  });

  it('accepts editor edits, bounded search, and host-routed persistence ops', () => {
    const candidates: unknown[] = [
      fixture({
        id: 'editor-2dd',
        context: 'editor-normal',
        input: { key: 'd' },
        expected: { disposition: 'action', ops: [{ kind: 'edit', op: 'delete-line', count: 2 }] },
      }),
      fixture({
        id: 'editor-find-till',
        context: 'editor-operator-pending',
        input: { key: 't' },
        expected: {
          disposition: 'action',
          ops: [{ kind: 'motion', op: 'till-char-forward', char: 'x' }],
        },
      }),
      fixture({
        id: 'editor-search-forward',
        context: 'editor-search',
        input: { key: '/' },
        expected: {
          disposition: 'action',
          ops: [{ kind: 'search', op: 'search-forward', pattern: 'recovery' }],
        },
      }),
      fixture({
        id: 'ex-wq-through-host-authority',
        context: 'editor-command-line',
        input: { key: '<Enter>' },
        expected: {
          disposition: 'action',
          ops: [
            {
              kind: 'persistence',
              op: 'save-close-request',
              route: 'host-authority',
              scope: 'focused',
            },
          ],
        },
      }),
    ];
    expect(() => validateOpFixtures(candidates)).not.toThrow();
  });

  it('accepts guarded Ex substitution and chrome accessibility announcements', () => {
    const candidates: unknown[] = [
      fixture({
        id: 'ex-substitute-range',
        context: 'editor-command-line',
        input: { key: '<Enter>' },
        expected: {
          disposition: 'action',
          ops: [
            {
              kind: 'ex',
              command: 'substitute',
              args: 'stale/recovered/g',
              range: { from: 1, to: 10 },
            },
          ],
        },
      }),
      fixture({
        id: 'chrome-guarded-close-announce',
        context: 'chrome-normal',
        input: { key: 'x' },
        expected: {
          disposition: 'action',
          ops: [
            { kind: 'chrome', op: 'guarded-close' },
            { kind: 'accessibility', op: 'announce-status', message: 'Close requested; awaiting confirmation.' },
          ],
        },
      }),
    ];
    expect(() => validateOpFixtures(candidates)).not.toThrow();
  });

  it('accepts an unsupported chrome key fixture that resets and reports', () => {
    const candidate: unknown = fixture({
      id: 'chrome-q-unsupported',
      context: 'chrome-normal',
      input: { key: 'q' },
      expected: { disposition: 'unsupported', resetPending: true, statusMessage: 'Not a chrome command.' },
    });
    expect(() => validateOpFixture(candidate)).not.toThrow();
  });
});

describe('validateOpFixture: reject', () => {
  it('rejects an unknown fixture version', () => {
    assertInvalid(
      () => validateOpFixture(fixture({ fixtureVersion: 'vim/v2' })),
      'fixture must declare fixtureVersion',
    );
  });

  it('rejects unknown fields at every level', () => {
    assertInvalid(() => validateOpFixture(fixture({ extra: true })), 'unknown field "extra"');
    assertInvalid(
      () => validateOpFixture(fixture({ input: { key: 'h', bytes: 'h', passthrough: true } })),
      'unknown field "passthrough"',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({ expected: { disposition: 'passthrough', passthroughBytes: 'h', severity: 'high' } }),
        ),
      'unknown field "severity"',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            context: 'editor-normal',
            input: { key: 'd' },
            expected: {
              disposition: 'action',
              ops: [{ kind: 'edit', op: 'delete-line', target: 'line' }],
            },
          }),
        ),
      'unknown field "target"',
    );
  });

  it('rejects unknown contexts, dispositions, op kinds, op names, and Ex commands', () => {
    assertInvalid(() => validateOpFixture(fixture({ context: 'chrome-visual' })), 'unknown context');
    assertInvalid(
      () => validateOpFixture(fixture({ expected: { disposition: 'restart' } })),
      'unknown disposition',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            context: 'editor-normal',
            input: { key: 'z' },
            expected: { disposition: 'action', ops: [{ kind: 'warp', op: 'teleport' }] },
          }),
        ),
      'unknown kind "warp"',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            context: 'editor-normal',
            input: { key: 'z' },
            expected: { disposition: 'action', ops: [{ kind: 'edit', op: 'teleport' }] },
          }),
        ),
      'unknown edit op "teleport"',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            context: 'editor-command-line',
            input: { key: '<Enter>' },
            expected: { disposition: 'action', ops: [{ kind: 'ex', command: 'shell' }] },
          }),
        ),
      'unknown Ex command "shell"',
    );
  });

  it('enforces the opt-in invariant: disabled and passthrough contexts never emit ops', () => {
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            context: 'disabled',
            input: { key: 'x' },
            expected: { disposition: 'action', ops: [{ kind: 'chrome', op: 'guarded-close' }] },
          }),
        ),
      'must classify as passthrough',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            context: 'passthrough',
            input: { key: 'h' },
            expected: { disposition: 'pending' },
          }),
        ),
      'must classify as passthrough',
    );
    assertInvalid(
      () => validateOpFixture(fixture({ expected: { disposition: 'passthrough', ops: [] } })),
      'with disposition passthrough must not carry ops',
    );
  });

  it('requires actions to carry ops and forbids ops on other dispositions', () => {
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            context: 'editor-normal',
            input: { key: 'd' },
            expected: { disposition: 'action', ops: [] },
          }),
        ),
      'requires a non-empty ops array',
    );
    assertInvalid(
      () => validateOpFixture(fixture({ expected: { disposition: 'pending', ops: [] } })),
      'with disposition pending must not carry ops',
    );
  });

  it('enforces byte-exact terminal passthrough', () => {
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            id: 'passthrough-mutated',
            input: { key: 'h', bytes: 'h' },
            expected: { disposition: 'passthrough', passthroughBytes: 'i' },
          }),
        ),
      'byte-identical',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            id: 'passthrough-missing-bytes',
            input: { key: '<Esc>', bytes: '\u001b' },
            expected: { disposition: 'passthrough' },
          }),
        ),
      'requires passthroughBytes',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            id: 'action-with-passthrough-bytes',
            context: 'chrome-normal',
            input: { key: 'x' },
            expected: {
              disposition: 'action',
              ops: [{ kind: 'chrome', op: 'guarded-close' }],
              passthroughBytes: 'x',
            },
          }),
        ),
      'with disposition action must not carry passthroughBytes',
    );
  });

  it('requires unsupported outcomes to reset pending state and show a bounded explanation', () => {
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({ expected: { disposition: 'unsupported', resetPending: false, statusMessage: 'nope' } }),
        ),
      'requires resetPending: true',
    );
    assertInvalid(
      () => validateOpFixture(fixture({ expected: { disposition: 'unsupported', resetPending: true } })),
      'requires statusMessage',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            expected: { disposition: 'unsupported', resetPending: true, statusMessage: 'x'.repeat(257) },
          }),
        ),
      'must be a string of length 1..256',
    );
  });

  it('keeps chrome ops chrome-scoped and editor ops editor-scoped', () => {
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            context: 'editor-normal',
            input: { key: 'x' },
            expected: { disposition: 'action', ops: [{ kind: 'chrome', op: 'guarded-close' }] },
          }),
        ),
      'allowed kinds here: motion, edit, search, ex, persistence, accessibility',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            context: 'chrome-normal',
            input: { key: 'd' },
            expected: { disposition: 'action', ops: [{ kind: 'edit', op: 'delete-line' }] },
          }),
        ),
      'allowed kinds here: chrome, accessibility',
    );
  });

  it('enforces bounded payloads on every op kind', () => {
    const build = (op: Record<string, unknown>): (() => void) => () =>
      validateOpFixture(
        fixture({
          context: 'editor-normal',
          input: { key: 'd' },
          expected: { disposition: 'action', ops: [op] },
        }),
      );

    assertInvalid(build({ kind: 'edit', op: 'delete', count: 0 }), 'must be an integer in 1..1000');
    assertInvalid(build({ kind: 'edit', op: 'delete', count: 1001 }), 'must be an integer in 1..1000');
    assertInvalid(build({ kind: 'edit', op: 'delete', count: 1.5 }), 'must be an integer in 1..1000');
    assertInvalid(build({ kind: 'motion', op: 'find-char-forward' }), 'char is required');
    assertInvalid(build({ kind: 'motion', op: 'find-char-forward', char: 'xy' }), 'exactly one character');
    assertInvalid(build({ kind: 'motion', op: 'char-left', char: 'x' }), 'must not carry char');
    assertInvalid(build({ kind: 'edit', op: 'yank', register: 'ab' }), 'single register name character');
    assertInvalid(build({ kind: 'edit', op: 'undo', register: 'a' }), 'must not carry register');
    assertInvalid(build({ kind: 'search', op: 'search-backward' }), 'requires pattern');
    assertInvalid(
      build({ kind: 'search', op: 'search-forward', pattern: 'p'.repeat(513) }),
      'must be a string of length 1..512',
    );
    assertInvalid(build({ kind: 'ex', command: 'write', args: 'injected.txt' }), 'must not carry args');
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            context: 'editor-command-line',
            input: { key: '<Enter>' },
            expected: {
              disposition: 'action',
              ops: [{ kind: 'ex', command: 'set-option', args: 'shell' }],
            },
          }),
        ),
      'is not a settable option',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            context: 'editor-command-line',
            input: { key: '<Enter>' },
            expected: {
              disposition: 'action',
              ops: [{ kind: 'ex', command: 'write', range: { from: 1, to: 2 } }],
            },
          }),
        ),
      'must not carry range',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            context: 'editor-command-line',
            input: { key: '<Enter>' },
            expected: {
              disposition: 'action',
              ops: [{ kind: 'ex', command: 'substitute', args: 'a/b', range: { from: 9, to: 2 } }],
            },
          }),
        ),
      'range.from must not exceed range.to',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            context: 'chrome-normal',
            input: { key: 'w', modifiers: ['ctrl'] },
            expected: {
              disposition: 'action',
              ops: [{ kind: 'chrome', op: 'pane-resize', direction: 'right', step: 11 }],
            },
          }),
        ),
      'must be an integer in 1..10',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            context: 'chrome-normal',
            input: { key: 'w', modifiers: ['ctrl'] },
            expected: { disposition: 'action', ops: [{ kind: 'chrome', op: 'pane-create' }] },
          }),
        ),
      'requires orientation',
    );
  });

  it('routes persistence ops through host authority and bounds their scope', () => {
    const build = (op: Record<string, unknown>): (() => void) => () =>
      validateOpFixture(
        fixture({
          context: 'editor-command-line',
          input: { key: '<Enter>' },
          expected: { disposition: 'action', ops: [op] },
        }),
      );

    assertInvalid(
      build({ kind: 'persistence', op: 'save-request', route: 'direct-fs', scope: 'focused' }),
      'must route through "host-authority"',
    );
    assertInvalid(
      build({ kind: 'persistence', op: 'save-request', scope: 'focused' }),
      'must route through "host-authority"',
    );
    assertInvalid(
      build({ kind: 'persistence', op: 'save-request', route: 'host-authority', scope: 'workspace' }),
      'scope must be one of focused, all',
    );
    assertInvalid(
      build({ kind: 'persistence', op: 'save-request', route: 'host-authority', scope: 'focused', force: true }),
      'must not carry force',
    );
    assertInvalid(
      build({ kind: 'persistence', op: 'save-close-request', route: 'host-authority', scope: 'all' }),
      'scope must be one of focused',
    );
  });

  it('bounds fixture ids, inputs, op arity, and modifiers', () => {
    assertInvalid(
      () => validateOpFixture(fixture({ id: 'x'.repeat(129) })),
      'must be a string of length 1..128',
    );
    assertInvalid(
      () => validateOpFixture(fixture({ input: { key: 'x'.repeat(17) } })),
      'must be a string of length 1..16',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            input: { key: 'h', modifiers: ['ctrl', 'ctrl'] },
            expected: { disposition: 'passthrough' },
          }),
        ),
      'duplicate modifier',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            input: { key: 'h', bytes: 'b'.repeat(257) },
            expected: { disposition: 'passthrough', passthroughBytes: 'b'.repeat(257) },
          }),
        ),
      'must be a string of length 1..256',
    );
    assertInvalid(
      () =>
        validateOpFixture(
          fixture({
            context: 'chrome-normal',
            input: { key: 'x' },
            expected: {
              disposition: 'action',
              ops: Array.from({ length: 17 }, () => ({
                kind: 'accessibility',
                op: 'announce-status',
                message: 'm',
              })),
            },
          }),
        ),
      'ops count exceeds 16',
    );
  });
});

describe('validateOpFixtures: set-level rules', () => {
  it('accepts a bounded conformance set', () => {
    const set: unknown = [
      fixture({
        id: 'case-disabled-h',
        context: 'disabled',
        input: { key: 'h', bytes: 'h' },
        expected: { disposition: 'passthrough', passthroughBytes: 'h' },
      }),
      fixture({
        id: 'case-chrome-h',
        context: 'chrome-normal',
        input: { key: 'h' },
        expected: { disposition: 'action', ops: [{ kind: 'chrome', op: 'focus-move', direction: 'left' }] },
      }),
    ];
    expect(() => validateOpFixtures(set)).not.toThrow();
  });

  it('rejects empty sets, non-arrays, duplicate ids, and duplicate cases', () => {
    assertInvalid(() => validateOpFixtures([]), 'must contain at least one fixture');
    assertInvalid(() => validateOpFixtures({ nope: true }), 'fixture set must be an array');
    assertInvalid(() => validateOpFixtures([fixture(), fixture()]), 'duplicate fixture id');
    assertInvalid(
      () =>
        validateOpFixtures([
          fixture({
            id: 'case-a',
            context: 'chrome-normal',
            input: { key: 'x' },
            expected: { disposition: 'action', ops: [{ kind: 'chrome', op: 'guarded-close' }] },
          }),
          fixture({
            id: 'case-b',
            context: 'chrome-normal',
            input: { key: 'x' },
            expected: {
              disposition: 'unsupported',
              resetPending: true,
              statusMessage: 'no',
            },
          }),
        ]),
      'duplicate case "chrome-normal::x"',
    );
    const oversized = Array.from({ length: 513 }, (_, index) =>
      fixture({
        id: `generated-${index}`,
        context: 'disabled',
        input: { key: `k${index}`, bytes: 'x' },
        expected: { disposition: 'passthrough', passthroughBytes: 'x' },
      }),
    );
    assertInvalid(() => validateOpFixtures(oversized), 'exceeds 512 fixtures');
  });
});

describe('validateSemanticOp: standalone op validation', () => {
  it('accepts a valid chrome op and rejects unknown shapes', () => {
    expect(() => validateSemanticOp({ kind: 'chrome', op: 'focus-first' })).not.toThrow();
    assertInvalid(() => validateSemanticOp(null), 'must be an object');
    assertInvalid(
      () => validateSemanticOp({ kind: 'chrome', op: 'teleport' }),
      'unknown chrome op "teleport"',
    );
    assertInvalid(
      () => validateSemanticOp({ kind: 'chrome', op: 'focus-move' }),
      'requires direction',
    );
    assertInvalid(
      () => validateSemanticOp({ kind: 'persistence', op: 'close-request', route: 'host-authority' }),
      'scope must be one of',
    );
  });
});
