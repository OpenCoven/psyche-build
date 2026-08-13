import { describe, expect, it } from 'vitest';
import {
  classifyBrowserAction as classifyBrowserActionDirect,
  classifyBrowserScript,
  classifyPaneAction,
  createBrowserPolicyAuthority,
  type BrowserResolvedRiskContext,
} from '../src/control/policy.js';
import type { BrowserSemanticAction, PaneAction } from '../src/control/types.js';

describe('agent control policy', () => {
  const authority = createBrowserPolicyAuthority();
  const classifyBrowserAction = authority.classifyBrowserAction;
  const trustedClick = (submit: boolean): BrowserResolvedRiskContext => (
    authority.resolveFromCanonicalSnapshot({ actionKind: 'click', submit })
  );
  const trustedType = (secret: boolean): BrowserResolvedRiskContext => (
    authority.resolveFromCanonicalSnapshot({ actionKind: 'type', secret })
  );

  it('supports direct classification from semantic metadata', () => {
    expect(classifyBrowserActionDirect({
      kind: 'click',
      semantic: { role: 'button', submit: false },
    })).toEqual({ decision: 'allow', capability: 'browser.interact' });
    expect(classifyBrowserActionDirect({
      kind: 'type',
      semantic: { secret: true },
    })).toMatchObject({ decision: 'approval', capability: 'browser.interact' });
    for (const kind of ['submit', 'upload', 'download', 'permission_response', 'close'] as const) {
      expect(classifyBrowserActionDirect({ kind })).toMatchObject({ decision: 'approval' });
    }
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

  it.each<[BrowserSemanticAction, BrowserResolvedRiskContext | undefined, 'allow' | 'approval', string]>([
    [{ kind: 'click', elementRef: 'button-1', semantic: { role: 'button', submit: false } }, trustedClick(false), 'allow', 'browser.interact'],
    [{ kind: 'click', elementRef: 'submit-1', semantic: { role: 'button', submit: true } }, trustedClick(true), 'approval', 'browser.interact'],
    [{ kind: 'type', elementRef: 'field-1', text: 'hello', semantic: { secret: false } }, trustedType(false), 'allow', 'browser.interact'],
    [{ kind: 'type', elementRef: 'password-1', text: 'redacted-test-value', semantic: { secret: true } }, trustedType(true), 'approval', 'browser.interact'],
    [{ kind: 'select', elementRef: 'select-1', values: ['one'] }, undefined, 'allow', 'browser.interact'],
    [{ kind: 'submit', elementRef: 'form-1' }, undefined, 'approval', 'browser.interact'],
    [{ kind: 'upload', elementRef: 'upload-1', path: 'relative-upload.bin' }, undefined, 'approval', 'browser.interact'],
    [{ kind: 'download', elementRef: 'download-1', destination: 'relative-download.bin' }, undefined, 'approval', 'browser.interact'],
    [{ kind: 'scroll', elementRef: 'region-1', deltaY: 100 }, undefined, 'allow', 'browser.interact'],
    [{ kind: 'focus', elementRef: 'field-1' }, undefined, 'allow', 'browser.interact'],
    [{ kind: 'navigate', url: 'https://example.test' }, undefined, 'allow', 'browser.navigate'],
    [{ kind: 'permission_response', permission: 'camera', origin: 'https://example.test', decision: 'deny' }, undefined, 'approval', 'browser.interact'],
    [{ kind: 'reload' }, undefined, 'allow', 'browser.history'],
    [{ kind: 'back' }, undefined, 'allow', 'browser.history'],
    [{ kind: 'forward' }, undefined, 'allow', 'browser.history'],
    [{ kind: 'screenshot' }, undefined, 'allow', 'browser.screenshot'],
    [{ kind: 'close' }, undefined, 'approval', 'browser.close'],
  ])('classifies browser action $kind as $decision with $capability', (action, context, decision, capability) => {
    expect(classifyBrowserAction(action, context)).toEqual({ decision, capability });
  });

  it('uses trusted click risk instead of caller semantic metadata', () => {
    expect(classifyBrowserAction(
      { kind: 'click', elementRef: 'button', semantic: { submit: false } },
      trustedClick(true),
    ).decision).toBe('approval');
    expect(classifyBrowserAction(
      { kind: 'click', elementRef: 'button', semantic: { submit: true } },
      trustedClick(false),
    ).decision).toBe('allow');
  });

  it('uses trusted type risk instead of caller semantic metadata', () => {
    expect(classifyBrowserAction(
      { kind: 'type', elementRef: 'field', text: 'value', semantic: { secret: false } },
      trustedType(true),
    ).decision).toBe('approval');
    expect(classifyBrowserAction(
      { kind: 'type', elementRef: 'field', text: 'value', semantic: { secret: true } },
      trustedType(false),
    ).decision).toBe('allow');
  });

  it.each([
    ['missing click context', { kind: 'click', elementRef: 'button' }, undefined],
    ['missing type context', { kind: 'type', elementRef: 'field', text: 'value' }, undefined],
    ['nonboolean submit', { kind: 'click', elementRef: 'button' }, { source: 'canonical_snapshot', actionKind: 'click', submit: 'false' }],
    ['nonboolean secret', { kind: 'type', elementRef: 'field', text: 'value' }, { source: 'canonical_snapshot', actionKind: 'type', secret: 0 }],
    ['null context', { kind: 'click', elementRef: 'button' }, null],
    ['non-object context', { kind: 'type', elementRef: 'field', text: 'value' }, 42],
    ['wrong provenance', { kind: 'click', elementRef: 'button' }, { source: 'caller', actionKind: 'click', submit: false }],
    ['wrong action context', { kind: 'click', elementRef: 'button' }, { source: 'canonical_snapshot', actionKind: 'type', secret: false }],
  ] as const)('fails closed for %s', (_label, action, context) => {
    expect(() => classifyBrowserAction(
      action as BrowserSemanticAction,
      context as BrowserResolvedRiskContext | undefined,
    )).toThrowError(expect.objectContaining({ code: 'capability_denied' }));
  });

  it('rejects forged, cloned, round-tripped, and foreign authority contexts', () => {
    const action = { kind: 'click', elementRef: 'button' } as const;
    const valid = trustedClick(true);
    const foreignAuthority = createBrowserPolicyAuthority();
    const foreign = foreignAuthority.resolveFromCanonicalSnapshot({ actionKind: 'click', submit: true });
    const candidates = [
      { source: 'canonical_snapshot', actionKind: 'click', submit: true },
      { ...valid },
      JSON.parse(JSON.stringify(valid)),
      foreign,
    ];

    expect(classifyBrowserAction(action, valid).decision).toBe('approval');
    for (const context of candidates) {
      expect(() => classifyBrowserAction(
        action,
        context as BrowserResolvedRiskContext,
      )).toThrowError(expect.objectContaining({ code: 'capability_denied' }));
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
