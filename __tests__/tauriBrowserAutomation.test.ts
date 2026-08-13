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
    expect(snapshot.nodes).toHaveLength(2_000);
    expect(snapshot.nodes.every((entry: { name?: string }) => new TextEncoder().encode(entry.name ?? '').length <= 512)).toBe(true);
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
