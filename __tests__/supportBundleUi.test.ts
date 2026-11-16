import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSupportBundleController } from '../native/desktop/psyche-build-tauri/web/support/support-controller.mjs';

class Element {
  hidden = false; disabled = false; textContent = ''; attributes = new Map();
  listeners = new Map<string, (() => unknown)[]>();
  constructor(readonly doc: { activeElement: Element | null }) {}
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(event: string, callback: () => unknown) { this.listeners.set(event, [...this.listeners.get(event) ?? [], callback]); }
  removeEventListener(event: string, callback: () => unknown) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(x => x !== callback)); }
  focus() { this.doc.activeElement = this; }
  click() { if (!this.disabled) for (const callback of this.listeners.get('click') ?? []) void callback(); }
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
});
