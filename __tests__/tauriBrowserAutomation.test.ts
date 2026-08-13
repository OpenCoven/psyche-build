import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeBrowserActionPostcondition } from '../src/control/runtime.js';

// @ts-expect-error Native web runtime is plain JavaScript by design.
import { browserAutomationSource, dispatchBrowserAutomation, installBrowserAutomation } from '../native/desktop/psyche-build-tauri/web/control/browser-automation.mjs';
// @ts-expect-error Native validation seam is plain JavaScript by design.
import { validateBrowserSnapshot } from '../native/desktop/psyche-build-tauri/web/control/browser-snapshot-validation.mjs';

type Rect = { x: number; y: number; width: number; height: number };

class FixtureElement {
  tagName: string;
  children: FixtureElement[] = [];
  parentElement: FixtureElement | null = null;
  ownerDocument!: FixtureDocument;
  textContent = '';
  hidden = false;
  disabled = false;
  checked = false;
  selected = false;
  value = '';
  type = '';
  labels: FixtureElement[] = [];
  options: FixtureElement[] = [];
  selectedIndex = -1;
  events: string[] = [];
  focused = false;
  submitted = false;
  rect: Rect = { x: 10, y: 10, width: 100, height: 24 };
  style = { display: 'block', visibility: 'visible', opacity: '1' };
  private attributes = new Map<string, string>();
  constructor(tagName: string, attributes: Record<string, string> = {}, text = '') {
    this.tagName = tagName.toUpperCase(); this.textContent = text;
    for (const [name, value] of Object.entries(attributes)) this.setAttribute(name, value);
    this.type = attributes.type ?? '';
  }
  append(...children: FixtureElement[]) {
    for (const child of children) { child.parentElement = this; this.children.push(child); }
    return this;
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  getBoundingClientRect() {
    return { ...this.rect, top: this.rect.y, left: this.rect.x,
      right: this.rect.x + this.rect.width, bottom: this.rect.y + this.rect.height };
  }
  dispatchEvent(event: { type: string }) { this.events.push(event.type); return true; }
  focus() { this.focused = true; this.ownerDocument.activeElement = this; this.events.push('focus'); }
  click() { this.events.push('click'); }
  scrollBy(options: { left?: number; top?: number }) {
    this.scrollLeft += options.left ?? 0; this.scrollTop += options.top ?? 0; this.events.push('scroll');
  }
  requestSubmit() { this.submitted = true; this.events.push('submit'); }
  scrollLeft = 0;
  scrollTop = 0;
}

class FixtureDocument {
  documentElement: FixtureElement;
  body: FixtureElement;
  title = 'Fixture page';
  location = { href: 'https://fixture.test/page' };
  defaultView: object | null = null;
  activeElement: FixtureElement | null = null;
  constructor(...children: FixtureElement[]) {
    this.body = new FixtureElement('body').append(...children);
    this.documentElement = new FixtureElement('html').append(this.body);
    const attach = (element: FixtureElement) => {
      element.ownerDocument = this; for (const child of element.children) attach(child);
    };
    attach(this.documentElement);
  }
  getElementById(id: string) {
    let found: FixtureElement | null = null;
    const visit = (element: FixtureElement) => {
      if (element.getAttribute('id') === id) found = element;
      for (const child of element.children) visit(child);
    };
    visit(this.documentElement); return found;
  }
  contains(candidate: FixtureElement) {
    let found = false;
    const visit = (element: FixtureElement) => {
      if (element === candidate) found = true;
      for (const child of element.children) visit(child);
    };
    visit(this.documentElement); return found;
  }
}

function fixtureGlobal(document: FixtureDocument) {
  const globalObject = { document, innerWidth: 800, innerHeight: 600,
    location: document.location, getComputedStyle: (element: FixtureElement) => element.style,
    Event: class { bubbles: boolean; cancelable: boolean; constructor(readonly type: string, options: any = {}) {
      this.bubbles = options.bubbles === true; this.cancelable = options.cancelable === true;
    } },
    InputEvent: class { bubbles: boolean; cancelable: boolean; data: string | null; inputType: string;
      constructor(readonly type: string, options: any = {}) { this.bubbles = options.bubbles === true;
        this.cancelable = options.cancelable === true; this.data = options.data ?? null; this.inputType = options.inputType ?? ''; } },
  };
  document.defaultView = globalObject; return globalObject;
}

function buildSemanticFixture() {
  const labelled = new FixtureElement('span', { id: 'labelled-name' }, 'Account settings');
  const button = new FixtureElement('button', { 'aria-label': 'Primary action',
    'aria-labelledby': 'labelled-name', title: 'Title fallback' }, 'Visible fallback');
  const link = new FixtureElement('a', { href: '/docs' }, 'Read docs');
  const nestedText = new FixtureElement('span', {}, 'Remember me');
  const checkbox = new FixtureElement('input', { type: 'checkbox' }); checkbox.checked = true;
  const nestedLabel = new FixtureElement('label').append(nestedText, checkbox); checkbox.labels = [nestedLabel];
  const select = new FixtureElement('select', { title: 'Theme' });
  const dark = new FixtureElement('option', { value: 'dark' }, 'Dark');
  select.options = [dark]; select.selectedIndex = 0; select.value = 'dark';
  const textarea = new FixtureElement('textarea', { 'aria-label': 'Notes' }); textarea.value = 'bounded notes';
  const password = new FixtureElement('input', { type: 'password', 'aria-label': 'Password' });
  password.value = 'do-not-leak';
  const disabled = new FixtureElement('button', {}, 'Unavailable'); disabled.disabled = true;
  const hidden = new FixtureElement('button', {}, 'Hidden'); hidden.hidden = true;
  const clipped = new FixtureElement('button', {}, 'Outside viewport');
  clipped.rect = { x: 900, y: 10, width: 50, height: 20 };
  const frame = new FixtureElement('iframe', { title: 'Payments frame' });
  Object.defineProperty(frame, 'contentDocument', { get() { throw new Error('cross origin'); } });
  return new FixtureDocument(labelled, button, link, nestedLabel, select, textarea,
    password, disabled, hidden, clipped, frame);
}

describe('bounded browser automation runtime', () => {
  it('keeps installation idempotent and snapshot IDs unique across fixed-clock documents', () => {
    const firstDocument = buildSemanticFixture(); const globalObject = fixtureGlobal(firstDocument);
    const crypto = { randomUUID: (() => { let id = 0; return () => `session-${++id}`; })() };
    const firstRuntime = installBrowserAutomation(globalObject, { now: () => 1_000, crypto });
    expect(installBrowserAutomation(globalObject, { now: () => 1_000, crypto })).toBe(firstRuntime);
    const first = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    globalObject.document = buildSemanticFixture();
    const secondRuntime = installBrowserAutomation(globalObject, { now: () => 1_000, crypto });
    const second = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    expect(secondRuntime).not.toBe(firstRuntime);
    expect(second.snapshotId).not.toBe(first.snapshotId);
  });

  it('caps visited nonsemantic nodes and bounds URL and title strings', () => {
    const root = new FixtureElement('div');
    for (let index = 0; index < 2_100; index += 1) root.append(new FixtureElement('div'));
    root.append(new FixtureElement('button', {}, 'must not be visited'));
    const document = new FixtureDocument(root); document.title = 't'.repeat(5_000);
    document.location.href = `https://fixture.test/${'u'.repeat(8_000)}`;
    const snapshot = dispatchBrowserAutomation(fixtureGlobal(document), { kind: 'snapshot' });
    expect(snapshot.visited).toBeLessThanOrEqual(2_000);
    expect(snapshot.nodes.some((node: { name: string }) => node.name === 'must not be visited')).toBe(false);
    expect(new TextEncoder().encode(snapshot.url).byteLength).toBeLessThanOrEqual(2_048);
    expect(new TextEncoder().encode(snapshot.title).byteLength).toBeLessThanOrEqual(512);
  });

  it('inherits hidden, aria-hidden, inert, and disabled semantics and exposes headings and images', () => {
    const hiddenParent = new FixtureElement('div'); hiddenParent.hidden = true;
    hiddenParent.append(new FixtureElement('button', {}, 'hidden descendant'));
    const ariaParent = new FixtureElement('div', { 'aria-hidden': 'true' })
      .append(new FixtureElement('a', { href: '/' }, 'aria hidden descendant'));
    const inertParent = new FixtureElement('div', { inert: '' })
      .append(new FixtureElement('button', {}, 'inert descendant'));
    const heading = new FixtureElement('h2', {}, 'Overview');
    const image = new FixtureElement('img', { alt: 'Architecture diagram' });
    const ariaDisabled = new FixtureElement('button', { 'aria-disabled': 'true' }, 'Locked');
    const snapshot = dispatchBrowserAutomation(fixtureGlobal(new FixtureDocument(
      hiddenParent, ariaParent, inertParent, heading, image, ariaDisabled)), { kind: 'snapshot' });
    expect(snapshot.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'heading', name: 'Overview' }),
      expect.objectContaining({ role: 'img', name: 'Architecture diagram' }),
      expect.objectContaining({ role: 'button', name: 'Locked', state: expect.objectContaining({ disabled: true }) }),
    ]));
    expect(snapshot.nodes.map((node: { name: string }) => node.name)).not.toEqual(expect.arrayContaining([
      'hidden descendant', 'aria hidden descendant', 'inert descendant',
    ]));
  });

  it('uses matching native input roles and button value names', () => {
    const search = new FixtureElement('input', { type: 'search', value: 'query' }); search.value = 'query';
    const number = new FixtureElement('input', { type: 'number', 'aria-label': 'Count' });
    const range = new FixtureElement('input', { type: 'range', 'aria-label': 'Volume' });
    const submit = new FixtureElement('input', { type: 'submit', value: 'Launch' }); submit.value = 'Launch';
    const snapshot = dispatchBrowserAutomation(fixtureGlobal(new FixtureDocument(search, number, range, submit)), { kind: 'snapshot' });
    expect(snapshot.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'searchbox' }), expect.objectContaining({ role: 'spinbutton', name: 'Count' }),
      expect.objectContaining({ role: 'slider', name: 'Volume' }), expect.objectContaining({ role: 'button', name: 'Launch' }),
    ]));
  });

  it('traverses same-origin frames and marks inaccessible frames opaque', () => {
    const sameOrigin = new FixtureElement('iframe', { title: 'Same origin' });
    Object.defineProperty(sameOrigin, 'contentDocument', { value: new FixtureDocument(new FixtureElement('button', {}, 'Frame action')) });
    const inaccessible = new FixtureElement('iframe', { title: 'Cross origin' });
    Object.defineProperty(inaccessible, 'contentDocument', { get() { throw new Error('cross origin'); } });
    const snapshot = dispatchBrowserAutomation(fixtureGlobal(new FixtureDocument(sameOrigin, inaccessible)), { kind: 'snapshot' });
    expect(snapshot.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'iframe', name: 'Same origin', opaque: false }),
      expect.objectContaining({ role: 'button', name: 'Frame action' }),
      expect.objectContaining({ role: 'iframe', name: 'Cross origin', opaque: true }),
    ]));
  });

  it('offsets nested same-origin frame bounds and invalidates refs when a frame document changes', () => {
    const action = new FixtureElement('button', {}, 'Nested action'); action.rect = { x: 3, y: 4, width: 40, height: 20 };
    const inner = new FixtureElement('iframe', { title: 'Inner' }); inner.rect = { x: 7, y: 8, width: 100, height: 80 };
    Object.defineProperty(inner, 'contentDocument', { writable: true, value: new FixtureDocument(action) });
    const outer = new FixtureElement('iframe', { title: 'Outer' }); outer.rect = { x: 100, y: 50, width: 200, height: 150 };
    Object.defineProperty(outer, 'contentDocument', { writable: true, value: new FixtureDocument(inner) });
    const globalObject = fixtureGlobal(new FixtureDocument(outer));
    const snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    expect(snapshot.nodes.find((node: { name: string }) => node.name === 'Nested action')?.bounds)
      .toMatchObject({ x: 110, y: 62 });
    Object.defineProperty(inner, 'contentDocument', { writable: true, value: new FixtureDocument(action) });
    expect(() => dispatchBrowserAutomation(globalObject, {
      kind: 'resolve', snapshotId: snapshot.snapshotId,
      ref: snapshot.nodes.find((node: { name: string }) => node.name === 'Nested action').ref,
    })).toThrowError(expect.objectContaining({ code: 'snapshot_stale' }));
  });

  it('clips same-origin frame descendants against every ancestor frame and the top viewport', () => {
    const visibleAction = new FixtureElement('button', {}, 'Visible clipped action');
    visibleAction.rect = { x: 10, y: 10, width: 20, height: 20 };
    const outsideFrame = new FixtureElement('button', {}, 'Outside frame');
    outsideFrame.rect = { x: 120, y: 10, width: 20, height: 20 };
    const outsideViewport = new FixtureElement('button', {}, 'Outside viewport through frame');
    outsideViewport.rect = { x: 60, y: 10, width: 20, height: 20 };
    const inner = new FixtureElement('iframe', { title: 'Clipped inner' });
    inner.rect = { x: 40, y: 0, width: 50, height: 50 };
    Object.defineProperty(inner, 'contentDocument', {
      value: new FixtureDocument(visibleAction, outsideFrame, outsideViewport),
    });
    const outer = new FixtureElement('iframe', { title: 'Clipped outer' });
    outer.rect = { x: 740, y: 20, width: 80, height: 80 };
    Object.defineProperty(outer, 'contentDocument', { value: new FixtureDocument(inner) });
    const snapshot = dispatchBrowserAutomation(fixtureGlobal(new FixtureDocument(outer)), { kind: 'snapshot' });
    expect(snapshot.nodes.map((node: { name: string }) => node.name)).toContain('Visible clipped action');
    expect(snapshot.nodes.map((node: { name: string }) => node.name)).not.toEqual(expect.arrayContaining([
      'Outside frame', 'Outside viewport through frame',
    ]));
  });

  it('rejects forged, malformed, oversized, duplicate-ref, and secret-bearing snapshots', () => {
    const valid = dispatchBrowserAutomation(fixtureGlobal(buildSemanticFixture()), {
      kind: 'snapshot', tabId: 'tab-1', generation: 7, documentId: 'doc-1',
    });
    expect(validateBrowserSnapshot(valid, { tabId: 'tab-1', generation: 7, documentId: 'doc-1' })).toEqual(valid);
    const invalid = [
      { ...valid, schema: 'forged' },
      { ...valid, generation: 8 },
      { ...valid, documentId: 'other' },
      { ...valid, title: 'x'.repeat(513) },
      { ...valid, nodes: [...valid.nodes, { ...valid.nodes[0] }] },
      { ...valid, nodes: valid.nodes.map((node: { state: object }) => ({ ...node,
        state: 'secret' in node.state ? { ...node.state, value: 'forged-secret' } : node.state })) },
    ];
    for (const candidate of invalid) expect(() => validateBrowserSnapshot(candidate,
      { tabId: 'tab-1', generation: 7, documentId: 'doc-1' })).toThrow();
  });
  it('rejects unknown keys and non-sequential preorder refs', () => {
    const valid = dispatchBrowserAutomation(fixtureGlobal(buildSemanticFixture()), {
      kind: 'snapshot', tabId: 'tab-1', generation: 7, documentId: 'doc-1',
    });
    const swapped = { ...valid, nodes: valid.nodes.map((node: object, index: number) =>
      index === 0 ? { ...node, ref: 'e2' } : index === 1 ? { ...node, ref: 'e1' } : node) };
    expect(() => validateBrowserSnapshot({ ...valid, attacker: true },
      { tabId: 'tab-1', generation: 7, documentId: 'doc-1' })).toThrow();
    expect(() => validateBrowserSnapshot({ ...valid, nodes: [{ ...valid.nodes[0], attacker: true }] },
      { tabId: 'tab-1', generation: 7, documentId: 'doc-1' })).toThrow();
    expect(() => validateBrowserSnapshot(swapped,
      { tabId: 'tab-1', generation: 7, documentId: 'doc-1' })).toThrow();
  });

  it('keeps the complete encoded snapshot below the native two MiB ceiling', () => {
    for (const count of [1_998, 1_999]) {
      const nodes = Array.from({ length: count }, () => {
        const input = new FixtureElement('input', { 'aria-label': 'n'.repeat(512), type: 'text' });
        input.value = 'v'.repeat(512);
        return input;
      });
      const snapshot = dispatchBrowserAutomation(fixtureGlobal(new FixtureDocument(...nodes)), {
        kind: 'snapshot', tabId: 'tab-budget', generation: 9, documentId: 'doc-budget',
      });
      expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeLessThan(2 * 1024 * 1024);
      expect(snapshot.nodes.length).toBeLessThanOrEqual(2_000);
      expect(snapshot.truncated).toBe(true);
      expect(validateBrowserSnapshot(snapshot, {
        tabId: 'tab-budget', generation: 9, documentId: 'doc-budget',
      })).toEqual(snapshot);
    }
  });
  it('emits a self-contained runtime source that installs the namespaced API', () => {
    const globalObject = fixtureGlobal(buildSemanticFixture());
    Function('window', browserAutomationSource())(globalObject);
    expect((globalObject as typeof globalObject & { __PSYCHE_AUTOMATION__: unknown }).__PSYCHE_AUTOMATION__)
      .toEqual(expect.objectContaining({ dispatch: expect.any(Function) }));
  });
  it('returns preorder semantic refs with bounded names, state, bounds, and opaque frames', () => {
    const globalObject = fixtureGlobal(buildSemanticFixture()); installBrowserAutomation(globalObject);
    const snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot', tabId: 'tab-1', generation: 4 });
    expect(snapshot).toMatchObject({ schema: 'psyche.browser.snapshot/v1', tabId: 'tab-1', generation: 4,
      url: 'https://fixture.test/page', title: 'Fixture page', viewport: { width: 800, height: 600 }, truncated: false });
    expect(snapshot.nodes[0]).toMatchObject({ ref: 'e1', role: 'button', name: 'Primary action' });
    expect(snapshot.nodes[1]).toMatchObject({ ref: 'e2', role: 'link', name: 'Read docs' });
    expect(snapshot.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'checkbox', name: 'Remember me', state: expect.objectContaining({ checked: true }) }),
      expect.objectContaining({ role: 'combobox', name: 'Theme', state: expect.objectContaining({ value: 'dark' }) }),
      expect.objectContaining({ role: 'textbox', name: 'Notes', state: expect.objectContaining({ value: 'bounded notes' }) }),
      expect.objectContaining({ role: 'textbox', name: 'Password', state: { secret: true, valuePresent: true } }),
      expect.objectContaining({ role: 'button', name: 'Unavailable', state: expect.objectContaining({ disabled: true }) }),
      expect.objectContaining({ role: 'iframe', name: 'Payments frame', opaque: true }),
    ]));
    expect(JSON.stringify(snapshot)).not.toContain('do-not-leak');
    expect(snapshot.nodes.some((node: { name: string }) => node.name === 'Hidden')).toBe(false);
    expect(snapshot.nodes.some((node: { name: string }) => node.name === 'Outside viewport')).toBe(false);
    for (const node of snapshot.nodes) expect(node.bounds).toEqual(expect.objectContaining({
      x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number) }));
  });

  it('enforces 2,000 nodes, depth 32, and a UTF-8 byte-safe 512-byte name cap', () => {
    const nodes = Array.from({ length: 2_050 }, (_, index) =>
      new FixtureElement('button', {}, index === 0 ? '🧠'.repeat(200) : `button ${index}`));
    const depthRoot = new FixtureElement('div'); let cursor = depthRoot;
    for (let depth = 0; depth < 40; depth += 1) {
      const next = new FixtureElement(depth === 39 ? 'button' : 'div', {}, 'too deep');
      cursor.append(next); cursor = next;
    }
    const snapshot = dispatchBrowserAutomation(fixtureGlobal(new FixtureDocument(...nodes, depthRoot)), { kind: 'snapshot' });
    expect(snapshot.nodes.length).toBeLessThanOrEqual(2_000); expect(snapshot.visited).toBe(2_000);
    expect(snapshot.truncated).toBe(true);
    expect(new TextEncoder().encode(snapshot.nodes[0].name).byteLength).toBeLessThanOrEqual(512);
    expect(snapshot.nodes[0].name.endsWith('\uFFFD')).toBe(false);
    expect(snapshot.nodes.some((node: { name: string }) => node.name === 'too deep')).toBe(false);
  });

  it.each(['new snapshot', 'navigation', 'document replacement', 'timeout'])(
    'makes old refs snapshot_stale after %s', (cause) => {
      let now = 1_000; const globalObject = fixtureGlobal(buildSemanticFixture());
      installBrowserAutomation(globalObject, { now: () => now });
      const first = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
      if (cause === 'new snapshot') dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
      if (cause === 'navigation') dispatchBrowserAutomation(globalObject, { kind: 'navigation' });
      if (cause === 'document replacement') globalObject.document = buildSemanticFixture();
      if (cause === 'timeout') now += 30_000;
      expect(() => dispatchBrowserAutomation(globalObject, {
        kind: 'resolve', snapshotId: first.snapshotId, ref: 'e1',
      })).toThrowError(expect.objectContaining({ code: 'snapshot_stale' }));
    },
  );

  it('uses current stored refs for focus, type, select, scroll, and click in browser event order', () => {
    const input = new FixtureElement('input', { type: 'text', 'aria-label': 'Name' }); input.value = 'old';
    const select = new FixtureElement('select', { 'aria-label': 'Theme' });
    const light = new FixtureElement('option', { value: 'light' }, 'Light');
    const dark = new FixtureElement('option', { value: 'dark' }, 'Dark');
    Object.assign(light, { value: 'light', selected: false }); Object.assign(dark, { value: 'dark', selected: false });
    select.options = [light, dark]; select.value = 'light';
    const region = new FixtureElement('div', { role: 'main', 'aria-label': 'Region' });
    const button = new FixtureElement('button', {}, 'Continue');
    const globalObject = fixtureGlobal(new FixtureDocument(input, select, region, button));
    let snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    const ref = (name: string) => snapshot.nodes.find((node: { name: string }) => node.name === name).ref;

    expect(dispatchBrowserAutomation(globalObject, { kind: 'focus', snapshotId: snapshot.snapshotId, ref: ref('Name') }))
      .toMatchObject({ focused: true });
    snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    expect(dispatchBrowserAutomation(globalObject, { kind: 'type', snapshotId: snapshot.snapshotId, ref: ref('Name'), text: 'new',
      expectedRisk: { documentId: snapshot.documentId, submit: null, formId: null, secret: false } }))
      .toMatchObject({ secret: false, value: 'new' });
    expect(input.events).toEqual(['focus', 'focus', 'beforeinput', 'input', 'change']);
    snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    dispatchBrowserAutomation(globalObject, { kind: 'type', snapshotId: snapshot.snapshotId, ref: ref('Name'), text: '+', append: true,
      expectedRisk: { documentId: snapshot.documentId, submit: null, formId: null, secret: false } });
    expect(input.value).toBe('new+');
    snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    expect(dispatchBrowserAutomation(globalObject, { kind: 'select', snapshotId: snapshot.snapshotId,
      ref: ref('Theme'), values: ['dark'] })).toMatchObject({ values: ['dark'] });
    expect(select.events).toEqual(['input', 'change']);
    snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    expect(dispatchBrowserAutomation(globalObject, { kind: 'scroll', snapshotId: snapshot.snapshotId,
      ref: ref('Region'), deltaX: 2, deltaY: 5 })).toMatchObject({ scrollLeft: 2, scrollTop: 5 });
    snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    expect(dispatchBrowserAutomation(globalObject, { kind: 'click', snapshotId: snapshot.snapshotId,
      ref: ref('Continue'), expectedRisk: { documentId: snapshot.documentId, submit: false, formId: null, secret: null } }))
      .toMatchObject({ clicked: true, submit: false });
    expect(button.events).toEqual(['focus', 'click']);
  });

  it('identifies submit intent before effect, invalidates afterward, and never returns secret text', () => {
    const password = new FixtureElement('input', { type: 'password', 'aria-label': 'Password' });
    const submit = new FixtureElement('button', { type: 'submit' }, 'Pay now');
    const form = new FixtureElement('form', { role: 'form', 'aria-label': 'Checkout' }).append(password, submit);
    Object.assign(password, { form }); Object.assign(submit, { form });
    const globalObject = fixtureGlobal(new FixtureDocument(form));
    let snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    let passwordRef = snapshot.nodes.find((node: { name: string }) => node.name === 'Password').ref;
    const result = dispatchBrowserAutomation(globalObject, {
      kind: 'type', snapshotId: snapshot.snapshotId, ref: passwordRef, text: 'ultra-secret',
      expectedRisk: { documentId: snapshot.documentId, submit: null, formId: null, secret: true },
    });
    expect(JSON.stringify(result)).not.toContain('ultra-secret');
    snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    passwordRef = snapshot.nodes.find((node: { name: string }) => node.name === 'Password').ref;
    const submitRef = snapshot.nodes.find((node: { name: string }) => node.name === 'Pay now').ref;
    const binding = dispatchBrowserAutomation(globalObject, { kind: 'resolve', actionKind: 'click',
      snapshotId: snapshot.snapshotId, ref: submitRef });
    const clicked = dispatchBrowserAutomation(globalObject, { kind: 'click', snapshotId: snapshot.snapshotId, ref: submitRef,
      expectedRisk: { documentId: binding.documentId, submit: binding.submit, formId: binding.formId, secret: binding.secret } });
    expect(clicked).toMatchObject({ clicked: true, submit: true });
    expect(() => dispatchBrowserAutomation(globalObject, {
      kind: 'focus', snapshotId: snapshot.snapshotId, ref: passwordRef,
    })).toThrowError(expect.objectContaining({ code: 'snapshot_stale' }));
  });

  it.each(['hidden', 'disabled', 'detached', 'replaced'])(
    'rejects a %s stored element before any effect', (condition) => {
      const button = new FixtureElement('button', {}, 'Action');
      const document = new FixtureDocument(button); const globalObject = fixtureGlobal(document);
      const snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
      if (condition === 'hidden') button.hidden = true;
      if (condition === 'disabled') button.disabled = true;
      if (condition === 'detached') document.body.children = [];
      if (condition === 'replaced') document.body.children[0] = new FixtureElement('button', {}, 'Action');
      expect(() => dispatchBrowserAutomation(globalObject, {
        kind: 'click', snapshotId: snapshot.snapshotId, ref: 'e1',
      })).toThrowError(expect.objectContaining({ code: condition === 'disabled' ? 'element_disabled' : 'snapshot_stale' }));
      expect(button.events).toEqual([]);
    },
  );

  it.each(['upload', 'download', 'permission_response'])(
    'fails unsupported native-only %s before page effect', (kind) => {
      const upload = new FixtureElement('input', { type: 'file', 'aria-label': 'Upload' });
      const globalObject = fixtureGlobal(new FixtureDocument(upload));
      const snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
      expect(() => dispatchBrowserAutomation(globalObject, {
        kind, snapshotId: snapshot.snapshotId, ref: 'e1', path: '/secret/path', destination: '/secret/out',
      })).toThrowError(expect.objectContaining({ code: 'backend_unavailable' }));
      expect(upload.events).toEqual([]);
    },
  );

  it('rejects submit and secret TOCTOU changes against immutable expected risk before effect', () => {
    const input = new FixtureElement('input', { type: 'text', 'aria-label': 'Value' }); input.value = 'old';
    const button = new FixtureElement('button', { type: 'button' }, 'Continue');
    const form = new FixtureElement('form').append(input, button); Object.assign(button, { form });
    const globalObject = fixtureGlobal(new FixtureDocument(form));
    let snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot', documentId: 'doc-1' });
    const buttonRef = snapshot.nodes.find((node: { name: string }) => node.name === 'Continue').ref;
    button.type = 'submit';
    expect(() => dispatchBrowserAutomation(globalObject, { kind: 'click', snapshotId: snapshot.snapshotId,
      ref: buttonRef, documentId: 'doc-1', expectedRisk: {
        documentId: 'doc-1', submit: false, formId: null, secret: null,
      } }))
      .toThrowError(expect.objectContaining({ code: 'approval_identity_mismatch' }));
    expect(button.events).toEqual([]);
    snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot', documentId: 'doc-1' });
    input.type = 'password';
    expect(() => dispatchBrowserAutomation(globalObject, { kind: 'type', snapshotId: snapshot.snapshotId,
      ref: snapshot.nodes.find((node: { name: string }) => node.name === 'Value').ref,
      documentId: 'doc-1', expectedRisk: {
        documentId: 'doc-1', submit: null, formId: null, secret: false,
      }, text: 'new' }))
      .toThrowError(expect.objectContaining({ code: 'approval_identity_mismatch' }));
    expect(input.value).toBe('old'); expect(input.events).toEqual([]);
  });

  it('keeps a non-submit button inside a form bound to a null form identity', () => {
    const button = new FixtureElement('button', { type: 'button' }, 'Continue');
    const form = new FixtureElement('form').append(button); Object.assign(button, { form });
    const globalObject = fixtureGlobal(new FixtureDocument(form));
    const runtime = installBrowserAutomation(globalObject);
    const snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot', documentId: 'doc-1' });
    const ref = snapshot.nodes.find((node: { name: string }) => node.name === 'Continue').ref;
    const binding = dispatchBrowserAutomation(globalObject, {
      kind: 'resolve', actionKind: 'click', snapshotId: snapshot.snapshotId, ref,
    });
    expect(binding).toMatchObject({ submit: false, formId: null });
    expect(dispatchBrowserAutomation(globalObject, { kind: 'click', snapshotId: snapshot.snapshotId, ref,
      expectedRisk: { documentId: 'doc-1', submit: false, formId: null, secret: null } }))
      .toMatchObject({ clicked: true, submit: false });
    expect(runtime.formSequence).toBe(0);
  });

  it('binds an explicit submit action to the same canonical form through effect time', () => {
    const firstForm = new FixtureElement('form');
    const secondForm = new FixtureElement('form');
    const button = new FixtureElement('button', { type: 'submit' }, 'Submit');
    firstForm.append(button); Object.assign(button, { form: firstForm });
    const globalObject = fixtureGlobal(new FixtureDocument(firstForm, secondForm));
    const snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot', documentId: 'doc-1' });
    const ref = snapshot.nodes.find((node: { name: string }) => node.name === 'Submit').ref;
    const binding = dispatchBrowserAutomation(globalObject, {
      kind: 'resolve', actionKind: 'submit', snapshotId: snapshot.snapshotId, ref,
    });
    expect(binding).toMatchObject({ submit: true, formId: expect.any(String), documentId: 'doc-1' });
    Object.assign(button, { form: secondForm });
    expect(() => dispatchBrowserAutomation(globalObject, {
      kind: 'submit', snapshotId: snapshot.snapshotId, ref, expectedRisk: {
        documentId: binding.documentId, submit: binding.submit, formId: binding.formId, secret: binding.secret,
      },
    })).toThrowError(expect.objectContaining({ code: 'approval_identity_mismatch' }));
    expect(button.events).toEqual([]);
  });

  it('fails before effect when a containing frame becomes hidden or clipped', () => {
    const button = new FixtureElement('button', {}, 'Framed');
    const frame = new FixtureElement('iframe', { title: 'Frame' });
    Object.defineProperty(frame, 'contentDocument', { value: new FixtureDocument(button) });
    const globalObject = fixtureGlobal(new FixtureDocument(frame));
    const snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    frame.hidden = true;
    expect(() => dispatchBrowserAutomation(globalObject, { kind: 'click', snapshotId: snapshot.snapshotId,
      ref: snapshot.nodes.find((node: { name: string }) => node.name === 'Framed').ref,
      expectedRisk: { documentId: snapshot.documentId, submit: false, formId: null, secret: null } }))
      .toThrowError(expect.objectContaining({ code: 'snapshot_stale' }));
    expect(button.events).toEqual([]);
  });

  it('recomputes nested frame geometry immediately before effect', () => {
    const button = new FixtureElement('button', {}, 'Nested'); button.rect = { x: 4, y: 4, width: 20, height: 20 };
    const inner = new FixtureElement('iframe', { title: 'Inner' }); inner.rect = { x: 5, y: 5, width: 40, height: 40 };
    Object.defineProperty(inner, 'contentDocument', { value: new FixtureDocument(button) });
    const outer = new FixtureElement('iframe', { title: 'Outer' }); outer.rect = { x: 10, y: 10, width: 80, height: 80 };
    Object.defineProperty(outer, 'contentDocument', { value: new FixtureDocument(inner) });
    const globalObject = fixtureGlobal(new FixtureDocument(outer));
    const snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    outer.rect = { x: 790, y: 10, width: 5, height: 80 };
    expect(() => dispatchBrowserAutomation(globalObject, { kind: 'click', snapshotId: snapshot.snapshotId,
      ref: snapshot.nodes.find((node: { name: string }) => node.name === 'Nested').ref,
      expectedRisk: { documentId: snapshot.documentId, submit: false, formId: null, secret: null } }))
      .toThrowError(expect.objectContaining({ code: 'snapshot_stale' }));
    expect(button.events).toEqual([]);
  });

  it('invalidates refs after type events mutate history or replace DOM and after simple mutations', () => {
    for (const mutation of ['history', 'dom', 'none'] as const) {
      const input = new FixtureElement('input', { type: 'text', 'aria-label': 'Input' });
      const document = new FixtureDocument(input); const globalObject = fixtureGlobal(document);
      input.dispatchEvent = (event: { type: string }) => {
        input.events.push(event.type);
        if (event.type === 'input' && mutation === 'history') document.location.href += '#changed';
        if (event.type === 'change' && mutation === 'dom') document.body.children = [];
        return true;
      };
      const snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
      const ref = snapshot.nodes.find((node: { name: string }) => node.name === 'Input').ref;
      expect(dispatchBrowserAutomation(globalObject, { kind: 'type', snapshotId: snapshot.snapshotId, ref,
        text: 'new', expectedRisk: { documentId: snapshot.documentId, submit: null, formId: null, secret: false } }))
        .toMatchObject({ secret: false, value: 'new' });
      expect(() => dispatchBrowserAutomation(globalObject, { kind: 'focus', snapshotId: snapshot.snapshotId, ref }))
        .toThrowError(expect.objectContaining({ code: 'snapshot_stale' }));
    }
  });

  it('returns the final select state after page handlers change the selection', () => {
    const select = new FixtureElement('select', { 'aria-label': 'Theme' });
    const light = new FixtureElement('option', { value: 'light' }, 'Light');
    const dark = new FixtureElement('option', { value: 'dark' }, 'Dark');
    Object.assign(light, { value: 'light', selected: true }); Object.assign(dark, { value: 'dark', selected: false });
    select.options = [light, dark]; select.value = 'light';
    select.dispatchEvent = (event: { type: string }) => {
      if (event.type === 'input') { light.selected = true; dark.selected = false; select.value = 'light'; }
      return true;
    };
    const globalObject = fixtureGlobal(new FixtureDocument(select));
    const snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    const ref = snapshot.nodes.find((node: { name: string }) => node.name === 'Theme').ref;
    expect(dispatchBrowserAutomation(globalObject, {
      kind: 'select', snapshotId: snapshot.snapshotId, ref, values: ['dark'],
    })).toEqual({ values: ['light'] });
  });

  it('reports ambiguous post-effect select evidence if handlers detach the control', () => {
    const select = new FixtureElement('select', { 'aria-label': 'Theme' });
    const dark = new FixtureElement('option', { value: 'dark' }, 'Dark');
    Object.assign(dark, { value: 'dark', selected: false }); select.options = [dark];
    const document = new FixtureDocument(select); const globalObject = fixtureGlobal(document);
    select.dispatchEvent = () => { document.body.children = []; return true; };
    const snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    const ref = snapshot.nodes.find((node: { name: string }) => node.name === 'Theme').ref;
    expect(() => dispatchBrowserAutomation(globalObject, {
      kind: 'select', snapshotId: snapshot.snapshotId, ref, values: ['dark'],
    })).toThrowError(expect.objectContaining({ code: 'effect_unknown' }));
    expect(() => dispatchBrowserAutomation(globalObject, {
      kind: 'focus', snapshotId: snapshot.snapshotId, ref,
    })).toThrowError(expect.objectContaining({ code: 'snapshot_stale' }));
  });

  it('emits exact beforeinput, input, and change properties and rejects contenteditable before focus', () => {
    const input = new FixtureElement('input', { type: 'text', 'aria-label': 'Input' }); input.value = 'old';
    const editable = new FixtureElement('div', { role: 'textbox', 'aria-label': 'Editor' });
    Object.assign(editable, { isContentEditable: true });
    const seen: Array<Record<string, unknown>> = [];
    input.dispatchEvent = (event: any) => { seen.push({ type: event.type, bubbles: event.bubbles,
      cancelable: event.cancelable, data: event.data, inputType: event.inputType }); return true; };
    const globalObject = fixtureGlobal(new FixtureDocument(input, editable));
    let snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    expect(dispatchBrowserAutomation(globalObject, { kind: 'type', snapshotId: snapshot.snapshotId,
      ref: snapshot.nodes.find((node: { name: string }) => node.name === 'Input').ref, text: 'new',
      expectedRisk: { documentId: snapshot.documentId, submit: null, formId: null, secret: false } }))
      .toMatchObject({ value: 'new' });
    expect(seen).toEqual([
      { type: 'beforeinput', bubbles: true, cancelable: true, data: 'new', inputType: 'insertReplacementText' },
      { type: 'input', bubbles: true, cancelable: false, data: 'new', inputType: 'insertReplacementText' },
      { type: 'change', bubbles: true, cancelable: false, data: undefined, inputType: undefined },
    ]);
    snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    expect(() => dispatchBrowserAutomation(globalObject, { kind: 'type', snapshotId: snapshot.snapshotId,
      ref: snapshot.nodes.find((node: { name: string }) => node.name === 'Editor').ref, text: 'x',
      expectedRisk: { documentId: snapshot.documentId, submit: null, formId: null, secret: false } }))
      .toThrowError(expect.objectContaining({ code: 'invalid_action' }));
    expect(editable.events).toEqual([]); expect(editable.textContent).toBe('');
  });

  it.each([
    { label: 'nonsecret success', secret: false, canceled: false,
      expected: { kind: 'type', secret: false, value: 'new' } },
    { label: 'secret success', secret: true, canceled: false,
      expected: { kind: 'type', secret: true, valuePresent: true } },
    { label: 'nonsecret canceled', secret: false, canceled: true,
      expected: { kind: 'type', secret: false, canceled: true } },
    { label: 'secret canceled', secret: true, canceled: true,
      expected: { kind: 'type', secret: true, canceled: true, valuePresent: true } },
  ] as const)('round-trips real producer evidence through the trusted normalizer: $label', ({ secret, canceled, expected }) => {
    const input = new FixtureElement('input', { type: secret ? 'password' : 'text', 'aria-label': 'Input' });
    input.value = 'old';
    if (canceled) input.dispatchEvent = (event: { type: string }) => event.type !== 'beforeinput';
    const globalObject = fixtureGlobal(new FixtureDocument(input));
    const snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    const ref = snapshot.nodes.find((node: { name: string }) => node.name === 'Input').ref;
    const produced = dispatchBrowserAutomation(globalObject, { kind: 'type', snapshotId: snapshot.snapshotId,
      ref, text: 'new', expectedRisk: {
        documentId: snapshot.documentId, submit: null, formId: null, secret,
      } });
    expect(normalizeBrowserActionPostcondition('type', produced)).toEqual(expected);
  });

  it('rejects incompatible controls and canceled beforeinput with zero mutation events', () => {
    const button = new FixtureElement('button', {}, 'Not text');
    const input = new FixtureElement('input', { type: 'text', 'aria-label': 'Input' }); input.value = 'old';
    input.dispatchEvent = (event: { type: string }) => { input.events.push(event.type); return event.type !== 'beforeinput'; };
    const globalObject = fixtureGlobal(new FixtureDocument(button, input));
    let snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    expect(() => dispatchBrowserAutomation(globalObject, { kind: 'type', snapshotId: snapshot.snapshotId,
      ref: snapshot.nodes.find((node: { name: string }) => node.name === 'Not text').ref,
      expectedRisk: { documentId: snapshot.documentId, submit: null, formId: null, secret: false }, text: 'x' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_action' }));
    expect(button.events).toEqual([]);
    snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    expect(dispatchBrowserAutomation(globalObject, { kind: 'type', snapshotId: snapshot.snapshotId,
      ref: snapshot.nodes.find((node: { name: string }) => node.name === 'Input').ref,
      expectedRisk: { documentId: snapshot.documentId, submit: null, formId: null, secret: false }, text: 'new' }))
      .toEqual({ canceled: true, secret: false });
    expect(input.value).toBe('old'); expect(input.events).toEqual(['focus', 'beforeinput']);
  });

  it('preserves cancellable beforeinput metadata when InputEvent is unavailable', () => {
    const input = new FixtureElement('input', { type: 'text', 'aria-label': 'Input' }); input.value = 'old';
    const seen: Array<Record<string, unknown>> = [];
    input.dispatchEvent = (event: any) => { seen.push({ type: event.type, bubbles: event.bubbles,
      cancelable: event.cancelable, data: event.data, inputType: event.inputType }); return false; };
    const globalObject = fixtureGlobal(new FixtureDocument(input));
    delete (globalObject as { InputEvent?: unknown }).InputEvent;
    const snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    const ref = snapshot.nodes.find((node: { name: string }) => node.name === 'Input').ref;
    expect(dispatchBrowserAutomation(globalObject, { kind: 'type', snapshotId: snapshot.snapshotId,
      ref, text: 'new', expectedRisk: {
        documentId: snapshot.documentId, submit: null, formId: null, secret: false,
      } })).toEqual({ canceled: true, secret: false });
    expect(input.value).toBe('old');
    expect(seen).toEqual([{ type: 'beforeinput', bubbles: true, cancelable: true,
      data: 'new', inputType: 'insertReplacementText' }]);
    expect(() => dispatchBrowserAutomation(globalObject, {
      kind: 'focus', snapshotId: snapshot.snapshotId, ref,
    })).toThrowError(expect.objectContaining({ code: 'snapshot_stale' }));
  });

  it.each(['focus', 'select', 'scroll'] as const)('invalidates the consumed snapshot after %s', (kind) => {
    const element = kind === 'select'
      ? new FixtureElement('select', { 'aria-label': 'Target' })
      : kind === 'scroll' ? new FixtureElement('div', { role: 'main', 'aria-label': 'Target' })
        : new FixtureElement('input', { type: 'text', 'aria-label': 'Target' });
    if (kind === 'select') {
      const option = new FixtureElement('option', { value: 'chosen' }, 'Chosen');
      Object.assign(option, { value: 'chosen', selected: false }); element.options = [option];
    }
    const globalObject = fixtureGlobal(new FixtureDocument(element));
    const snapshot = dispatchBrowserAutomation(globalObject, { kind: 'snapshot' });
    const ref = snapshot.nodes.find((node: { name: string }) => node.name === 'Target').ref;
    const request = kind === 'select' ? { kind, values: ['chosen'] }
      : kind === 'scroll' ? { kind, deltaX: 1, deltaY: 2 } : { kind };
    dispatchBrowserAutomation(globalObject, { ...request, snapshotId: snapshot.snapshotId, ref });
    expect(() => dispatchBrowserAutomation(globalObject, {
      kind: 'focus', snapshotId: snapshot.snapshotId, ref,
    })).toThrowError(expect.objectContaining({ code: 'snapshot_stale' }));
  });
});

describe('native browser snapshots', () => {
  const nativeLib = readFileSync(join(process.cwd(), 'native/desktop/psyche-build-tauri/src-tauri/src/lib.rs'), 'utf8');
  it('uses the child WKWebView snapshot API with a 4 MiB raw PNG bound', () => {
    expect(nativeLib).toContain('fn browser_snapshot');
    expect(nativeLib).toContain('takeSnapshotWithConfiguration_completionHandler');
    expect(nativeLib).toContain('4 * 1024 * 1024');
    expect(nativeLib).toMatch(/pngBase64|png_base64/); expect(nativeLib).toMatch(/width/); expect(nativeLib).toMatch(/height/);
  });
  it('has a stable unsupported-platform result and no desktop coordinate capture', () => {
    expect(nativeLib).toContain('backend_unavailable');
    expect(nativeLib).not.toMatch(/CGWindowListCreateImage|screencapture|capture_screen/);
  });
  it('dispatches typed fixed-runtime actions in the named isolated world without accepting script source', () => {
    expect(nativeLib).toContain('fn browser_action');
    expect(nativeLib).toContain('evaluateJavaScript_inFrame_inContentWorld_completionHandler');
    expect(nativeLib).toContain('com.opencoven.psyche.browser-inspection');
    expect(nativeLib).not.toMatch(/struct BrowserActionRequest[\s\S]{0,800}(source|script_source):/);
  });
});
