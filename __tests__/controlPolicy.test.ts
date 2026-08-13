import { describe, expect, it } from 'vitest';
import {
  classifyBrowserAction,
  classifyBrowserScript,
  classifyPaneAction,
  createCanonicalElementSemantics,
  type CanonicalElementSemantics,
} from '../src/control/policy.js';
import type { PaneAction } from '../src/control/types.js';

describe('agent control policy', () => {
  it('classifies canonical click and secret metadata through the direct API', () => {
    expect(classifyBrowserAction({
      kind: 'click',
      semantic: createCanonicalElementSemantics({ role: 'button', submit: false }),
    })).toEqual({ decision: 'allow', capability: 'browser.interact' });
    expect(classifyBrowserAction({
      kind: 'click',
      semantic: createCanonicalElementSemantics({ role: 'button', submit: true }),
    })).toEqual({ decision: 'approval', capability: 'browser.interact' });
    expect(classifyBrowserAction({
      kind: 'type',
      semantic: createCanonicalElementSemantics({ secret: true }),
    })).toMatchObject({ decision: 'approval', capability: 'browser.interact' });
    expect(classifyBrowserAction({
      kind: 'type',
      semantic: createCanonicalElementSemantics({ secret: false }),
    })).toEqual({ decision: 'allow', capability: 'browser.interact' });
  });

  it.each<[PaneAction, 'allow' | 'approval', string]>([
    [{ kind: 'send_text', text: 'status' }, 'allow', 'pane.input'],
    [{ kind: 'send_keys', keys: ['Enter'] }, 'allow', 'pane.input'],
    [{ kind: 'interrupt', key: 'C-c' }, 'allow', 'pane.interrupt'],
    [{ kind: 'focus' }, 'allow', 'pane.focus'],
    [{ kind: 'resize', cols: 120, rows: 40 }, 'allow', 'pane.resize'],
    [{ kind: 'close' }, 'approval', 'pane.close'],
    [{ kind: 'create', cwd: 'project-relative', title: 'Agent' }, 'allow', 'pane.create'],
  ])('classifies pane action $kind as $decision with $capability', (action, decision, capability) => {
    expect(classifyPaneAction(action)).toEqual({ decision, capability });
  });

  it.each([
    ['select', 'allow', 'browser.interact'],
    ['scroll', 'allow', 'browser.interact'],
    ['focus', 'allow', 'browser.interact'],
    ['submit', 'approval', 'browser.interact'],
    ['upload', 'approval', 'browser.interact'],
    ['download', 'approval', 'browser.interact'],
    ['permission_response', 'approval', 'browser.interact'],
    ['navigate', 'allow', 'browser.navigate'],
    ['reload', 'allow', 'browser.history'],
    ['back', 'allow', 'browser.history'],
    ['forward', 'allow', 'browser.history'],
    ['screenshot', 'allow', 'browser.screenshot'],
    ['close', 'approval', 'browser.close'],
  ] as const)('classifies browser %s as %s with %s', (kind, decision, capability) => {
    expect(classifyBrowserAction({ kind })).toEqual({ decision, capability });
  });

  it('rejects raw, cloned, round-tripped, missing, and malformed semantic metadata', () => {
    const canonical = createCanonicalElementSemantics({ role: 'button', submit: false });
    const candidates = [
      { role: 'button', submit: false },
      { ...canonical },
      JSON.parse(JSON.stringify(canonical)),
      undefined,
      null,
      42,
    ];

    for (const semantic of candidates) {
      expect(() => classifyBrowserAction({
        kind: 'click',
        semantic: semantic as CanonicalElementSemantics,
      })).toThrowError(expect.objectContaining({ code: 'capability_denied' }));
    }
  });

  it('rejects malformed canonical semantic source objects', () => {
    for (const input of [
      { role: 'button', submit: false, extra: true },
      { role: 'button', submit: 'false' },
      Object.create({ role: 'button' }),
    ]) {
      expect(() => createCanonicalElementSemantics(input as never)).toThrowError(
        expect.objectContaining({ code: 'capability_denied' }),
      );
    }
  });

  it('always requires approval for browser scripts', () => {
    expect(classifyBrowserScript()).toEqual({
      decision: 'approval',
      capability: 'browser.script',
    });
  });

  it.each([
    ['pane', classifyPaneAction],
    ['browser', classifyBrowserAction],
  ] as const)('fails closed for unknown %s actions', (_surface, classify) => {
    expect(() => classify({ kind: 'future_action' } as never)).toThrowError(
      expect.objectContaining({ code: 'capability_denied' }),
    );
  });

  it.each([
    ['pane', classifyPaneAction],
    ['browser', classifyBrowserAction],
  ] as const)('fails closed with coded errors for malformed %s actions', (_surface, classify) => {
    for (const malformed of [null, undefined, 42, 'click', {}, { semantic: null }]) {
      expect(() => classify(malformed as never)).toThrowError(
        expect.objectContaining({ code: 'capability_denied' }),
      );
    }
  });
});
