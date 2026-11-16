import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHelpModalController, createSupportBundleController } from '../native/desktop/psyche-build-tauri/web/support/support-controller.mjs';

class Element {
  hidden = false; disabled = false; visible = true; textContent = ''; attributes = new Map();
  listeners = new Map<string, ((event?: any) => unknown)[]>();
  constructor(readonly doc: { activeElement: Element | null }) {}
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(event: string, callback: (event?: any) => unknown) { this.listeners.set(event, [...this.listeners.get(event) ?? [], callback]); }
  removeEventListener(event: string, callback: (event?: any) => unknown) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(x => x !== callback)); }
  focus() { if (!this.disabled && this.visible) this.doc.activeElement = this; }
  getClientRects() { return this.visible ? [{}] : []; }
  click() { if (!this.disabled) for (const callback of this.listeners.get('click') ?? []) void callback(); }
  key(key: string, shiftKey = false) { for (const callback of this.listeners.get('keydown') ?? []) callback({ key, shiftKey, preventDefault() {}, stopPropagation() {} }); }
}
const saved = { id: '1', state: 'saved', result: { state: 'saved', code: 'saved', fileName: 'psyche-support-20261116T000000Z-111111111111.json',
  bundleStatus: 'partial', redactedFields: 2, omittedFields: 3, bytes: 2048, retentionFailures: 0,
  categories: [{ category: 'receipts', disposition: 'omitted', reason: 'owner_unavailable' }, { category: 'terminal', disposition: 'omitted', reason: 'content_excluded' }] } };
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function setup(invoke: (name: string, args?: any) => Promise<any>) {
  const doc: { activeElement: Element | null } = { activeElement: null };
  const names = ['dialog', 'status', 'summary', 'create', 'cancel', 'reveal', 'close'] as const;
  const elements = Object.fromEntries(names.map(name => [name, new Element(doc)])) as Record<typeof names[number], Element>;
  const trigger = new Element(doc); trigger.focus();
  const controller = createSupportBundleController({ elements, invoke, getProject: () => ({ root: '/fixture', panes: 2 }), getActiveElement: () => doc.activeElement });
  return { ...elements, controller, doc, trigger };
}
afterEach(() => vi.useRealTimers());
describe('support bundle application controller', () => {
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
