import { describe, expect, it, vi } from 'vitest';

import {
  browserAutomationSource,
  dispatchBrowserAutomation,
  installBrowserAutomation,
} from '../native/desktop/psyche-build-tauri/web/control/browser-automation.mjs';

type FakeNode = {
  nodeType: number;
  tagName: string;
  type?: string;
  value?: string;
  disabled?: boolean;
  hidden?: boolean;
  checked?: boolean;
  selected?: boolean;
  labels?: FakeNode[];
  textContent: string;
  children: FakeNode[];
  parentElement: FakeNode | null;
  attributes: Record<string, string>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number };
  click: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
};

function node(tagName: string, options: Partial<FakeNode> & { attrs?: Record<string, string>; rect?: [number, number, number, number] } = {}): FakeNode {
  const attrs = options.attrs ?? {};
  const [x, y, width, height] = options.rect ?? [0, 0, 100, 20];
  const result: FakeNode = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    textContent: options.textContent ?? '',
    children: [],
    parentElement: null,
    attributes: attrs,
    getAttribute: (name) => attrs[name] ?? null,
    hasAttribute: (name) => Object.hasOwn(attrs, name),
    getBoundingClientRect: () => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height }),
    click: vi.fn(),
    focus: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    ...options,
  };
  for (const child of result.children) child.parentElement = result;
  return result;
}

function fixture(now = 1_000) {
  const button = node('button', { textContent: ' Save changes ' });
  const link = node('a', { textContent: 'Documentation', attrs: { href: '/docs' } });
  const password = node('input', { type: 'password', value: 'top-secret', attrs: { 'aria-label': 'Password' } });
  const checkbox = node('input', { type: 'checkbox', checked: true, attrs: { 'aria-label': 'Remember me' } });
  const option = node('option', { textContent: 'Blue', selected: true });
  const select = node('select', { value: 'blue', attrs: { 'aria-label': 'Colour' }, children: [option] });
  const textarea = node('textarea', { value: 'bounded notes', attrs: { 'aria-label': 'Notes' } });
  const associatedLabel = node('label', { textContent: 'User name' });
  const labelledInput = node('input', { type: 'text', value: 'val', labels: [associatedLabel] });
  const hidden = node('button', { textContent: 'Invisible', hidden: true });
  const disabled = node('button', { textContent: 'Disabled', disabled: true });
  const clipped = node('button', { textContent: 'Corner', rect: [780, 590, 50, 40] });
  const frame = node('iframe', { attrs: { title: 'Remote account' } });
  Object.defineProperty(frame, 'contentDocument', { get() { throw new Error('cross origin'); } });
  const body = node('body', { children: [button, link, checkbox, select, textarea, password, labelledInput, hidden, disabled, clipped, frame] });
  const byId = new Map<string, FakeNode>();
  const globalObject = {
    document: { body, documentElement: body, getElementById: (id: string) => byId.get(id) ?? null },
    innerWidth: 800,
    innerHeight: 600,
    location: { href: 'https://example.test/account' },
    Event: class { constructor(public type: string, public init?: unknown) {} },
    Date: { now: () => now },
    getComputedStyle: (element: FakeNode) => ({
      display: element.attributes['data-display'] ?? 'block',
      visibility: element.attributes['data-visibility'] ?? 'visible',
    }),
  };
  return { globalObject, button, password, checkbox, hidden, disabled, frame };
}

describe('bounded semantic browser automation', () => {
  it('installs one bounded semantic snapshot with preorder refs and redacted secrets', () => {
    const { globalObject } = fixture();
    const api = installBrowserAutomation(globalObject);

    expect(globalObject).toHaveProperty('__PSYCHE_AUTOMATION__', api);
    const snapshot = api.dispatch({ type: 'snapshot' });

    expect(snapshot.schema).toBe('psyche.browser.snapshot/v1');
    expect(snapshot.url).toBe('https://example.test/account');
    expect(snapshot.nodes.map((entry: { ref: string }) => entry.ref)).toEqual(
      Array.from({ length: 11 }, (_, index) => `e${index + 1}`),
    );
    expect(snapshot.nodes[0]).toMatchObject({ role: 'button', name: 'Save changes' });
    expect(snapshot.nodes[1]).toMatchObject({ role: 'link', name: 'Documentation' });
    expect(snapshot.nodes[2]).toMatchObject({ role: 'checkbox', checked: true });
    expect(snapshot.nodes[3]).toMatchObject({ role: 'combobox', name: 'Colour', value: 'blue' });
    expect(snapshot.nodes[4]).toMatchObject({ role: 'option', name: 'Blue', selected: true });
    expect(snapshot.nodes[5]).toMatchObject({ role: 'textbox', name: 'Notes', value: 'bounded notes' });
    expect(snapshot.nodes[6]).toMatchObject({ role: 'textbox', name: 'Password', secret: true, valuePresent: true });
    expect(snapshot.nodes[6]).not.toHaveProperty('value');
    expect(snapshot.nodes[7]).toMatchObject({ role: 'textbox', name: 'User name', value: 'val' });
    expect(snapshot.nodes[8]).toMatchObject({ role: 'button', disabled: true });
    expect(snapshot.nodes[9]).toMatchObject({ role: 'button', bounds: { x: 780, y: 590, width: 20, height: 10, clipped: true } });
    expect(snapshot.nodes[10]).toMatchObject({ role: 'frame', opaque: true, name: 'Remote account' });
  });

  it('invalidates refs on replacement, expiry, and explicit navigation invalidation', () => {
    let now = 1_000;
    const { globalObject } = fixture();
    globalObject.Date.now = () => now;
    const api = installBrowserAutomation(globalObject, { now: () => now });
    const first = api.dispatch({ type: 'snapshot' });
    api.dispatch({ type: 'snapshot' });
    expect(() => api.dispatch({ type: 'resolve', snapshotId: first.snapshotId, ref: 'e1' })).toThrowError(/snapshot_stale/);

    const current = api.dispatch({ type: 'snapshot' });
    now += 30_000;
    expect(() => api.dispatch({ type: 'resolve', snapshotId: current.snapshotId, ref: 'e1' })).toThrowError(/snapshot_stale/);

    const latest = api.dispatch({ type: 'snapshot' });
    api.invalidate();
    expect(() => api.dispatch({ type: 'resolve', snapshotId: latest.snapshotId, ref: 'e1' })).toThrowError(/snapshot_stale/);

    const beforeReplacement = api.dispatch({ type: 'snapshot' });
    globalObject.document = { ...globalObject.document, documentElement: node('body') };
    expect(() => api.dispatch({ type: 'resolve', snapshotId: beforeReplacement.snapshotId, ref: 'e1' })).toThrowError(/snapshot_stale/);
  });

  it('can inject the same source twice in one document without replacing live state', () => {
    const { globalObject } = fixture();
    const source = browserAutomationSource();
    Function('globalThis', source)(globalObject);
    const installed = globalObject as typeof globalObject & { __PSYCHE_AUTOMATION__: { dispatch(request: Record<string, unknown> & { type: string }): any } };
    const firstApi = installed.__PSYCHE_AUTOMATION__;
    const snapshot = firstApi.dispatch({ type: 'snapshot' });

    expect(() => Function('globalThis', source)(globalObject)).not.toThrow();
    expect(installed.__PSYCHE_AUTOMATION__).toBe(firstApi);
    expect(firstApi.dispatch({ type: 'resolve', snapshotId: snapshot.snapshotId, ref: 'e1' })).toMatchObject({ role: 'button' });
  });

  it('overwrites a configurable page-owned automation impostor instead of trusting it', () => {
    const { globalObject } = fixture();
    const impostor = { schema: 'psyche.browser.automation/v1', dispatch: vi.fn(() => ({ secret: true })), invalidate: vi.fn() };
    Object.defineProperty(globalObject, '__PSYCHE_AUTOMATION__', { configurable: true, value: impostor });

    Function('globalThis', browserAutomationSource())(globalObject);

    expect((globalObject as any).__PSYCHE_AUTOMATION__).not.toBe(impostor);
    expect((globalObject as any).__PSYCHE_AUTOMATION__.dispatch({ type: 'snapshot' })).toMatchObject({
      schema: 'psyche.browser.snapshot/v1',
    });
  });

  it('keeps the trusted initialization install non-configurable before later hostile intrinsic patches', () => {
    const { globalObject } = fixture();
    const source = browserAutomationSource();
    const nativeAssign = Object.assign;
    const nativeDefineProperty = Object.defineProperty;
    const nativeFreeze = Object.freeze;
    const nativeEncode = TextEncoder.prototype.encode;
    const NativeMap = Map;
    const NativeWeakMap = WeakMap;
    const NativeSet = Set;
    const NativeTextEncoder = TextEncoder;
    Function('globalThis', source)(globalObject);
    expect(Object.getOwnPropertyDescriptor(globalObject, '__PSYCHE_AUTOMATION__')?.configurable).toBe(false);
    let result: any;
    try {
      Object.assign = (() => { throw new Error('page Object.assign'); }) as typeof Object.assign;
      Object.defineProperty = (() => { throw new Error('page Object.defineProperty'); }) as typeof Object.defineProperty;
      Object.freeze = (() => { throw new Error('page Object.freeze'); }) as typeof Object.freeze;
      TextEncoder.prototype.encode = (() => { throw new Error('page TextEncoder.encode'); }) as typeof TextEncoder.prototype.encode;
      (globalThis as any).Map = class { constructor() { throw new Error('page Map'); } };
      (globalThis as any).WeakMap = class { constructor() { throw new Error('page WeakMap'); } };
      (globalThis as any).Set = class { constructor() { throw new Error('page Set'); } };
      (globalThis as any).TextEncoder = class { constructor() { throw new Error('page TextEncoder'); } };
      result = (globalObject as any).__PSYCHE_AUTOMATION__.dispatch({ type: 'snapshot' });
    } finally {
      Object.assign = nativeAssign;
      Object.defineProperty = nativeDefineProperty;
      Object.freeze = nativeFreeze;
      NativeTextEncoder.prototype.encode = nativeEncode;
      (globalThis as any).Map = NativeMap;
      (globalThis as any).WeakMap = NativeWeakMap;
      (globalThis as any).Set = NativeSet;
      (globalThis as any).TextEncoder = NativeTextEncoder;
    }
    expect(result).toMatchObject({ schema: 'psyche.browser.snapshot/v1' });
  });

  it('bounds total DOM visits even when 100k siblings are nonsemantic', () => {
    const { globalObject } = fixture();
    let rectReads = 0;
    const siblings = Array.from({ length: 100_000 }, () => {
      const child = node('div');
      child.getBoundingClientRect = () => {
        rectReads += 1;
        return { x: 0, y: 0, width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 };
      };
      return child;
    });
    globalObject.document.body = node('body', { children: siblings });
    globalObject.document.documentElement = globalObject.document.body;

    const snapshot = dispatchBrowserAutomation(globalObject, { type: 'snapshot' });
    expect(rectReads).toBeLessThanOrEqual(2_000);
    expect(snapshot.truncated).toBe(true);
  });

  it('indexes a label flood once and stops at the global visit budget', () => {
    const { globalObject } = fixture();
    const input = node('input', { attrs: { id: 'target' } });
    globalObject.document.body = node('body', { children: [input] });
    globalObject.document.documentElement = globalObject.document.body;
    let labelReads = 0;
    (globalObject.document as any).querySelectorAll = (() => ({
      *[Symbol.iterator]() {
        for (let index = 0; index < 100_000; index += 1) {
          labelReads += 1;
          yield node('label', { textContent: `label-${index}`, attrs: { for: index === 0 ? 'target' : `other-${index}` } });
        }
      },
    })) as any;

    const snapshot = dispatchBrowserAutomation(globalObject, { type: 'snapshot' });
    expect(labelReads).toBe(2_000);
    expect(snapshot.nodes[0]).toMatchObject({ name: 'label-0' });
  });

  it('computes a shared for-label once for duplicate target ids', () => {
    const { globalObject } = fixture();
    let textReads = 0;
    const label = node('label', { attrs: { for: 'duplicate' } });
    Object.defineProperty(label, 'textContent', {
      get() { textReads += 1; return 'Shared label'; },
    });
    const inputs = Array.from({ length: 100 }, () => node('input', { attrs: { id: 'duplicate' } }));
    globalObject.document.body = node('body', { children: inputs });
    globalObject.document.documentElement = globalObject.document.body;
    (globalObject.document as any).querySelectorAll = () => [label];

    const snapshot = dispatchBrowserAutomation(globalObject, { type: 'snapshot' });
    expect(snapshot.nodes).toHaveLength(100);
    expect(snapshot.nodes.every((entry: { name: string }) => entry.name === 'Shared label')).toBe(true);
    expect(textReads).toBe(1);
  });

  it('uses the first supported explicit role token and marks exhausted label indexing truncated', () => {
    const { globalObject } = fixture();
    const button = node('div', { textContent: 'Save', attrs: { role: 'presentation button dialog' } });
    globalObject.document.body = node('body', { children: [button] });
    globalObject.document.documentElement = globalObject.document.body;
    (globalObject.document as any).querySelectorAll = () => ({
      length: 2_001,
      *[Symbol.iterator]() { for (let i = 0; i < 2_001; i += 1) yield node('label'); },
    });
    const snapshot = dispatchBrowserAutomation(globalObject, { type: 'snapshot' });
    expect(snapshot.nodes[0]).toMatchObject({ role: 'button' });
    expect(snapshot.truncated).toBe(true);
  });

  it('omits noninteractive offscreen and zero-size explicit roles', () => {
    const { globalObject } = fixture();
    const heading = node('h2', { textContent: 'Offscreen heading', attrs: { role: 'heading' }, rect: [900, 900, 100, 20] });
    const zero = node('div', { textContent: 'Zero status', attrs: { role: 'status' }, rect: [0, 0, 0, 0] });
    const zeroButton = node('button', { textContent: 'Keyboard target', rect: [0, 0, 0, 0] });
    globalObject.document.body = node('body', { children: [heading, zero, zeroButton] });
    globalObject.document.documentElement = globalObject.document.body;

    const snapshot = dispatchBrowserAutomation(globalObject, { type: 'snapshot' });
    expect(snapshot.nodes).toEqual([expect.objectContaining({ role: 'button', name: 'Keyboard target' })]);
    expect(snapshot.nodes[0].bounds).toMatchObject({ width: 0, height: 0, clipped: true });
  });

  it('bounds node count, depth, and accessible names', () => {
    const { globalObject } = fixture();
    let root = node('button', { attrs: { 'aria-label': 'x'.repeat(800) } });
    for (let index = 0; index < 40; index += 1) root = node('div', { children: [root] });
    globalObject.document.body = node('body', { children: [root, ...Array.from({ length: 2_100 }, (_, i) => node('button', { textContent: `b${i}` }))] });

    const snapshot = dispatchBrowserAutomation(globalObject, { type: 'snapshot' });
    expect(snapshot.nodes.length).toBeLessThanOrEqual(2_000);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.nodes.every((entry: { name?: string }) => new TextEncoder().encode(entry.name ?? '').length <= 512)).toBe(true);
  });

  it('builds fallback names from visible descendants without leaking hidden text', () => {
    const { globalObject } = fixture();
    const visible = node('span', { textContent: 'Visible label' });
    const hiddenSecret = node('span', { textContent: 'hidden-secret', hidden: true });
    const nestedSecret = node('span', { textContent: 'nested-secret' });
    const hiddenTree = node('span', {
      textContent: 'raw nested-secret',
      attrs: { 'aria-hidden': 'true' },
      children: [nestedSecret],
    });
    const displayNone = node('span', { textContent: 'display-secret', attrs: { 'data-display': 'none' } });
    const invisible = node('span', { textContent: 'visibility-secret', attrs: { 'data-visibility': 'hidden' } });
    const offscreen = node('span', { textContent: 'offscreen-secret', rect: [900, 900, 50, 20] });
    const button = node('button', {
      textContent: 'Visible label hidden-secret nested-secret display-secret visibility-secret offscreen-secret',
      children: [visible, hiddenSecret, hiddenTree, displayNone, invisible, offscreen],
    });
    globalObject.document.body = node('body', { children: [button] });
    globalObject.document.documentElement = globalObject.document.body;

    const snapshot = dispatchBrowserAutomation(globalObject, { type: 'snapshot' });
    expect(snapshot.nodes[0]).toMatchObject({ role: 'button', name: 'Visible label' });
  });

  it('stops accessible-name traversal once its output budget is exhausted', () => {
    const { globalObject } = fixture();
    let reads = 0;
    const children = Array.from({ length: 2_500 }, () => {
      const child = node('span');
      Object.defineProperty(child, 'textContent', {
        get() { reads += 1; return 'x'; },
      });
      return child;
    });
    const button = node('button', { children });
    globalObject.document.body = node('body', { children: [button] });
    globalObject.document.documentElement = globalObject.document.body;

    const snapshot = dispatchBrowserAutomation(globalObject, { type: 'snapshot' });
    expect(new TextEncoder().encode(snapshot.nodes[0].name).length).toBeLessThanOrEqual(512);
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(children.length);
  });

  it('resolves an exact current ref without exposing mutation or arbitrary evaluation', () => {
    const { globalObject } = fixture();
    const api = installBrowserAutomation(globalObject);
    const snapshot = api.dispatch({ type: 'snapshot' });
    expect(api.dispatch({ type: 'resolve', snapshotId: snapshot.snapshotId, ref: 'e1' })).toMatchObject({ role: 'button', name: 'Save changes' });
    expect(() => api.dispatch({ type: 'click', snapshotId: snapshot.snapshotId, ref: 'e1' })).toThrowError(/unsupported_operation/);
    expect(() => api.dispatch({ type: 'eval', source: 'globalThis.secret' })).toThrowError(/unsupported_operation/);
  });

  it('emits a self-contained injection source that installs the full API', () => {
    const { globalObject } = fixture();
    Function('globalThis', browserAutomationSource())(globalObject);
    const installed = globalObject as typeof globalObject & { __PSYCHE_AUTOMATION__: { dispatch(request: { type: string }): any } };
    const snapshot = installed.__PSYCHE_AUTOMATION__.dispatch({ type: 'snapshot' });
    expect(snapshot).toMatchObject({ schema: 'psyche.browser.snapshot/v1' });
    expect(snapshot.nodes[0]).toMatchObject({ role: 'button', name: 'Save changes' });
  });
});
