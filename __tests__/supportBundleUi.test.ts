import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHelpModalController, createSupportBundleController } from '../native/desktop/psyche-build-tauri/web/support/support-controller.mjs';

class Element {
  hidden = false; disabled = false; visible = true; inert = false; textContent = ''; attributes = new Map();
  ownerDocument?: Element; defaultView?: Element; parentElement?: { children: Element[] };
  querySelector?: (selector: string) => Element | null;
  listeners = new Map<string, ((event?: any) => unknown)[]>();
  constructor(readonly doc: { activeElement: Element | null }) {}
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(event: string, callback: (event?: any) => unknown) { this.listeners.set(event, [...this.listeners.get(event) ?? [], callback]); }
  removeEventListener(event: string, callback: (event?: any) => unknown) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(x => x !== callback)); }
  focus() { if (!this.disabled && this.visible && !this.inert) this.doc.activeElement = this; }
  getClientRects() { return this.visible ? [{}] : []; }
  click() { if (!this.disabled) for (const callback of this.listeners.get('click') ?? []) void callback(); }
  emit(type: string, event: any = {}) {
    for (const callback of this.listeners.get(type) ?? []) { callback(event); if (event.immediateStopped) break; }
    return event;
  }
  key(key: string, shiftKey = false) {
    return this.emit('keydown', { key, shiftKey, defaultPrevented: false, immediateStopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() { this.immediateStopped = true; } });
  }
}
const saved = { id: '1', state: 'saved', result: { state: 'saved', code: 'saved', fileName: 'psyche-support-20261116T000000Z-111111111111.json',
  bundleStatus: 'partial', redactedFields: 2, omittedFields: 3, bytes: 2048, retentionFailures: 0,
  categories: [{ category: 'receipts', disposition: 'omitted', reason: 'owner_unavailable' }, { category: 'terminal', disposition: 'omitted', reason: 'content_excluded' }] } };
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function setup(invoke: (name: string, args?: any) => Promise<any>, globalScope = false) {
  const doc: { activeElement: Element | null } = { activeElement: null };
  const names = ['dialog', 'status', 'summary', 'create', 'cancel', 'reveal', 'close'] as const;
  const elements = Object.fromEntries(names.map(name => [name, new Element(doc)])) as Record<typeof names[number], Element>;
  const trigger = new Element(doc); trigger.focus();
  const events = new Element(doc), activation = new Element(doc), background = new Element(doc), locked = new Element(doc);
  locked.inert = true;
  if (globalScope) {
    events.defaultView = activation; elements.dialog.ownerDocument = events;
    elements.dialog.parentElement = { children: [trigger, background, locked, elements.dialog] };
    elements.dialog.hidden = true;
  }
  const controller = createSupportBundleController({ elements, invoke, getProject: () => ({ root: '/fixture', panes: 2 }), getActiveElement: () => doc.activeElement });
  return { ...elements, controller, doc, trigger, events, activation, background, locked };
}
afterEach(() => vi.useRealTimers());
describe('support bundle application controller', () => {
  it.each(['help', 'support'])('yields %s keyboard/focus containment to a higher native modal and resumes afterward', surface => {
    const ui = setup(async () => saved, true);
    const nativeSave = new Element(ui.doc), nativeModal = new Element(ui.doc);
    let higherModal: Element | null = nativeModal;
    ui.events.querySelector = selector => selector === 'dialog:modal' ? higherModal : null;
    const help = surface === 'help' ? createHelpModalController({ dialog: ui.dialog, trigger: ui.trigger,
      action: ui.create, close: ui.close, getActiveElement: () => ui.doc.activeElement }) : null;
    // Only the selected overlay owns the visible element in this fixture.
    if (help) ui.controller.dispose();
    if (help) help.setOpen(true); else ui.controller.open(ui.trigger);
    nativeSave.focus(); ui.events.emit('focusin'); ui.activation.emit('focus');
    expect(ui.doc.activeElement).toBe(nativeSave);
    for (const key of ['Enter', 'Tab', 'Escape']) {
      const event = ui.activation.key(key);
      expect(event.immediateStopped).toBe(false); expect(event.defaultPrevented).toBe(false);
      expect(ui.dialog.hidden).toBe(false);
    }
    higherModal = null; ui.doc.activeElement = ui.background; ui.events.emit('focusin');
    expect(ui.doc.activeElement).toBe(ui.create);
    expect(ui.activation.key('Tab', true).defaultPrevented).toBe(true);
    expect(ui.doc.activeElement).toBe(ui.close);
    if (help) help.dispose(); else ui.controller.dispose();
  });
  it('contains focus after native reactivation and keeps background controls inert until closure', () => {
    const ui = setup(async () => saved, true); ui.controller.open(ui.trigger);
    expect(ui.background.inert).toBe(true); expect(ui.trigger.inert).toBe(true);
    ui.doc.activeElement = ui.background; ui.activation.emit('focus');
    expect(ui.doc.activeElement).toBe(ui.create);
    ui.doc.activeElement = ui.background; expect(ui.activation.key('Tab').defaultPrevented).toBe(true);
    expect(ui.doc.activeElement).toBe(ui.create);
    ui.activation.key('Tab', true); expect(ui.doc.activeElement).toBe(ui.close);
    ui.activation.key('Escape');
    expect(ui.dialog.hidden).toBe(true); expect(ui.background.inert).toBe(false);
    expect(ui.locked.inert).toBe(true); expect(ui.doc.activeElement).toBe(ui.trigger);
    ui.controller.dispose();
  });
  it('blocks background keyboard handlers while visible and removes global containment on disposal', () => {
    const ui = setup(async () => saved, true); const backgroundKey = vi.fn();
    ui.activation.addEventListener('keydown', backgroundKey); ui.controller.open(ui.trigger);
    ui.activation.key('Enter'); expect(backgroundKey).not.toHaveBeenCalled();
    ui.controller.dispose(); expect(ui.background.inert).toBe(false);
    ui.background.focus(); ui.activation.emit('focus'); expect(ui.doc.activeElement).toBe(ui.background);
    ui.activation.key('Enter'); expect(backgroundKey).toHaveBeenCalledTimes(1);
  });
  it('contains Help focus outside its overlay and restores pre-existing background inert state', () => {
    const doc: { activeElement: Element | null } = { activeElement: null };
    const dialog = new Element(doc), trigger = new Element(doc), action = new Element(doc), close = new Element(doc);
    const events = new Element(doc), activation = new Element(doc), background = new Element(doc);
    events.defaultView = activation; dialog.ownerDocument = events; dialog.parentElement = { children: [trigger, background, dialog] };
    dialog.hidden = true; trigger.focus();
    const controller = createHelpModalController({ dialog, trigger, action, close, getActiveElement: () => doc.activeElement });
    controller.setOpen(true); expect(background.inert).toBe(true);
    doc.activeElement = background; events.emit('focusin'); expect(doc.activeElement).toBe(action);
    doc.activeElement = background; activation.key('Tab', true); expect(doc.activeElement).toBe(close);
    activation.key('Escape'); expect(dialog.hidden).toBe(true); expect(background.inert).toBe(false); expect(doc.activeElement).toBe(trigger);
  });

  it('does not steal focus when closing an already-closed Help dialog, and restores prior focus when its trigger is hidden', () => {
    const doc: { activeElement: Element | null } = { activeElement: null };
    const dialog = new Element(doc), trigger = new Element(doc), action = new Element(doc), close = new Element(doc), terminal = new Element(doc);
    dialog.hidden = true; terminal.focus();
    const controller = createHelpModalController({ dialog, trigger, action, close, getActiveElement: () => doc.activeElement });
    controller.setOpen(false); expect(doc.activeElement).toBe(terminal);
    trigger.visible = false;
    controller.setOpen(true); expect(doc.activeElement).toBe(action);
    controller.setOpen(false); expect(doc.activeElement).toBe(terminal);
  });
  it('moves Help focus to its action, traps Tab, and restores the visible Help trigger on Escape', () => {
    const doc: { activeElement: Element | null } = { activeElement: null };
    const dialog = new Element(doc), trigger = new Element(doc), action = new Element(doc), close = new Element(doc);
    trigger.focus();
    const controller = createHelpModalController({ dialog, trigger, action, close, getActiveElement: () => doc.activeElement });
    controller.setOpen(true);
    expect(doc.activeElement).toBe(action);
    dialog.key('Tab', true); expect(doc.activeElement).toBe(close);
    dialog.key('Tab'); expect(doc.activeElement).toBe(action);
    dialog.key('Escape'); expect(dialog.hidden).toBe(true); expect(doc.activeElement).toBe(trigger);
  });
  it('opens accessibly, displays collection progress and prevents duplicate starts', async () => {
    let resolve!: (value: any) => void;
    const pending = new Promise(r => { resolve = r; });
    const invoke = vi.fn(() => pending);
    const ui = setup(invoke); ui.controller.open();
    expect(ui.dialog.hidden).toBe(false);
    expect(ui.doc.activeElement).toBe(ui.create);
    ui.create.click(); ui.create.click();
    expect(ui.status.textContent).toContain('Collecting');
    expect(ui.cancel.disabled).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('support_bundle_start', { root: '/fixture', panes: 2 });
    resolve(saved); await flush(); ui.controller.dispose();
  });
  it('presents saved redaction and omission accounting and reveals only by native job identity', async () => {
    const invoke = vi.fn(async name => name === 'support_bundle_reveal' ? undefined : saved);
    const ui = setup(invoke); ui.controller.open(); ui.create.click(); await flush();
    expect(ui.status.textContent).toContain('Saved');
    expect(ui.summary.textContent).toContain('Receipts: omitted');
    expect(ui.summary.textContent).toContain('Terminal content: omitted');
    expect(ui.summary.textContent).toContain('2');
    expect(ui.reveal.disabled).toBe(false);
    ui.reveal.click(); await flush();
    expect(invoke).toHaveBeenLastCalledWith('support_bundle_reveal', { id: '1' });
    ui.controller.close(); expect(ui.doc.activeElement).toBe(ui.trigger);
    ui.controller.dispose();
  });
  it('carries a cancellation requested before start resolves and preserves a committed save', async () => {
    let resolve!: (value: any) => void;
    const first = new Promise(r => { resolve = r; });
    const invoke = vi.fn((name: string) => name === 'support_bundle_start' ? first : Promise.resolve(saved));
    const ui = setup(invoke); ui.controller.open(); ui.create.click(); ui.cancel.click();
    expect(ui.status.textContent).toContain('Cancelling');
    resolve({ id: '1', state: 'collecting' }); await flush();
    expect(invoke).toHaveBeenCalledWith('support_bundle_cancel', { id: '1' });
    expect(ui.status.textContent).toContain('Saved');
    ui.controller.dispose();
  });
  it('shows actionable missing-runtime failure without leaking a rejected exception', async () => {
    const ui = setup(async () => { throw new Error('node_unavailable /PRIVATE_SYNTHETIC_PATH'); });
    ui.controller.open(); ui.create.click(); await flush();
    expect(ui.status.textContent).toContain('Node.js');
    expect(ui.status.textContent).not.toContain('PRIVATE_SYNTHETIC_PATH');
    expect(ui.create.disabled).toBe(false);
    expect(ui.reveal.disabled).toBe(true);
    ui.controller.dispose();
  });
  it('polls native status and keeps cancellation terminal without a false saved file', async () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async (name: string) => name === 'support_bundle_start'
      ? { id: '1', state: 'collecting' } : { id: '1', state: 'cancelled', result: { state: 'cancelled', code: 'cancelled' } });
    const ui = setup(invoke); ui.controller.open(); ui.create.click(); await flush();
    await vi.advanceTimersByTimeAsync(150);
    expect(ui.status.textContent).toContain('Cancelled');
    expect(ui.reveal.disabled).toBe(true);
    expect(ui.create.disabled).toBe(false);
    ui.controller.dispose();
  });
  it('returns focus to the visible Help trigger when its launching menu closes', () => {
    const ui = setup(async () => saved);
    const help = new Element(ui.doc);
    ui.controller.open(help);
    ui.controller.close();
    expect(ui.doc.activeElement).toBe(help);
    ui.controller.dispose();
  });
  it('does not arm polling after disposal while start is pending', async () => {
    vi.useFakeTimers();
    let resolve!: (value: any) => void;
    const ui = setup(() => new Promise(r => { resolve = r; }));
    ui.controller.open(); ui.create.click(); ui.controller.dispose();
    resolve({ id: '1', state: 'collecting' }); await flush();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['poll', 'cancel'])('ignores a stale %s response after a retry starts a newer native job', async operation => {
    vi.useFakeTimers();
    let resolveOld!: (value: any) => void;
    const old = new Promise(r => { resolveOld = r; });
    let starts = 0;
    const invoke = vi.fn(async (name: string, args?: any) => {
      if (name === 'support_bundle_start') return { id: String(++starts), state: 'collecting' };
      if (args?.id === '1' && name === `support_bundle_${operation === 'poll' ? 'status' : 'cancel'}`) return old;
      if (args?.id === '1') return saved;
      return { id: '2', state: 'cancelling' };
    });
    const ui = setup(invoke); ui.controller.open(); ui.create.click(); await flush();
    if (operation === 'poll') {
      await vi.advanceTimersByTimeAsync(100);
      ui.cancel.click(); await flush();
    } else {
      ui.cancel.click(); await flush();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(ui.status.textContent).toContain('Saved');
    ui.create.click(); await flush();
    resolveOld(saved); await flush();
    expect(ui.status.textContent).toContain('Collecting');
    expect(ui.cancel.disabled).toBe(false);
    expect(ui.reveal.disabled).toBe(true);
    ui.cancel.click(); await flush();
    expect(invoke).toHaveBeenLastCalledWith('support_bundle_cancel', { id: '2' });
    ui.controller.dispose();
  });
  it('keeps an enabled modal focus target while cancellation is pending and when reopened', async () => {
    const pending = new Promise(() => {});
    const ui = setup(async name => name === 'support_bundle_start' ? { id: '1', state: 'collecting' } : pending);
    ui.controller.open(); ui.create.click(); await flush();
    ui.cancel.click(); await flush();
    expect(ui.doc.activeElement?.disabled).toBe(false);
    ui.controller.close(); ui.controller.open(ui.trigger);
    expect(ui.doc.activeElement).toBe(ui.close);
    ui.controller.dispose();
  });
});
