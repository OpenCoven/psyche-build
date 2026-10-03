import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import {
  CASK_UPGRADE_COMMAND,
  bannerModel,
  createUpdateBannerController,
  renderUpdateBanner,
} from '../native/desktop/psyche-build-tauri/web/update/update-banner.mjs';

const webRoot = join(process.cwd(), 'native/desktop/psyche-build-tauri/web');
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
const mainJs = readFileSync(join(webRoot, 'main.js'), 'utf8');
const SHA = 'c'.repeat(64);

class FakeElement {
  ownerDocument: FakeDocument;
  tagName: string;
  className = '';
  private ownText = '';
  hidden = false;
  disabled = false;
  checked = false;
  type = '';
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<(event: any) => void>>();

  constructor(ownerDocument: FakeDocument, tagName = 'div') {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
  }

  get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }
  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeElement[]) { this.children = nodes; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, listener: (event: any) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
  dispatch(type: string, init: Record<string, unknown> = {}) {
    const event = { type, target: this, preventDefault: vi.fn(), ...init };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  contains(node: unknown): boolean { return node === this || this.descendants().includes(node as FakeElement); }
  focus() { this.ownerDocument.activeElement = this; }
  descendants(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  buttons() { return this.descendants().filter((node) => node.tagName === 'BUTTON'); }
  button(label: string) {
    const found = this.buttons().find((node) => node.textContent === label);
    if (!found) throw new Error(`no button ${label}`);
    return found;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  createElement(tag: string) { return new FakeElement(this, tag); }
}

function available(overrides: Record<string, unknown> = {}) {
  return {
    state: 'available',
    running_version: '0.0.2',
    checks_supported: true,
    checks_enabled: true,
    last_check: '2026-10-03T00:00:00Z',
    install_source: 'homebrew_cask',
    skipped: false,
    dismissed: false,
    available: {
      version: '0.0.3',
      tag: 'v0.0.3',
      release_url: 'https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.3',
      arch: 'aarch64',
      dmg_file: 'Psyche-Build-v0.0.3-aarch64.dmg',
      dmg_sha256: SHA,
    },
    upgraded_from: null,
    ...overrides,
  };
}

async function flush() {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

/** A stand-in for the native commands that keeps skip/dismiss state. */
function nativeMock(initial: ReturnType<typeof available>) {
  let status = { ...initial };
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'update_skip_version') {
      if (args?.version !== status.available?.version) throw new Error('only the version on offer');
      status = { ...status, skipped: true };
    } else if (command === 'update_dismiss') {
      status = { ...status, dismissed: true };
    } else if (command === 'update_set_checks_enabled') {
      status = { ...status, checks_enabled: Boolean(args?.enabled), state: args?.enabled ? 'idle' : 'off', available: null as never };
    } else if (command !== 'update_status') {
      throw new Error(`unexpected ${command}`);
    }
    return status;
  });
  return { invoke, set: (next: ReturnType<typeof available>) => { status = next; } };
}

describe('update banner model', () => {
  it('shows only a verified, unskipped, undismissed newer release', () => {
    expect(bannerModel(available())).toMatchObject({ version: '0.0.3', showCask: true, showDmg: false });
    for (const state of ['disabled', 'off', 'idle', 'checking', 'unreachable', 'oversize', 'invalid_signature',
      'unknown_key', 'non_canonical', 'malformed', 'not_yet_valid', 'expired', 'not_newer']) {
      expect(bannerModel(available({ state }))).toBeNull();
    }
    expect(bannerModel(available({ skipped: true }))).toBeNull();
    expect(bannerModel(available({ dismissed: true }))).toBeNull();
    expect(bannerModel(null)).toBeNull();
  });

  it('fails closed on a release link or version it did not expect', () => {
    const base = available().available;
    expect(bannerModel(available({ available: { ...base, release_url: 'https://evil.example/v0.0.3' } }))).toBeNull();
    expect(bannerModel(available({ available: { ...base, version: '0.0.3<img>' } }))).toBeNull();
    expect(bannerModel(available({ available: { ...base, dmg_sha256: 'nope' }, install_source: 'dmg' }))?.sha256).toBeNull();
  });

  it('chooses instructions by install source and shows both when unknown', () => {
    expect(bannerModel(available({ install_source: 'dmg' }))).toMatchObject({ showCask: false, showDmg: true, sha256: SHA });
    expect(bannerModel(available({ install_source: 'unknown' }))).toMatchObject({ showCask: true, showDmg: true });
    expect(bannerModel(available({ install_source: 'surprise' }))).toMatchObject({ showCask: true, showDmg: true });
  });
});

describe('update banner rendering', () => {
  const handlers = () => ({ copy: vi.fn(), openRelease: vi.fn(), skip: vi.fn(), dismiss: vi.fn() });

  it('renders a Cask notice with a copyable command and no install button', () => {
    const doc = new FakeDocument();
    const container = doc.createElement('section');
    container.hidden = true;
    const h = handlers();
    renderUpdateBanner(container as never, bannerModel(available()), h, doc as never);
    expect(container.hidden).toBe(false);
    expect(container.textContent).toContain('Psyche Build 0.0.3 is available.');
    expect(container.textContent).toContain('You have 0.0.2.');
    expect(container.textContent).toContain(CASK_UPGRADE_COMMAND);
    expect(container.textContent).not.toContain(SHA);
    const labels = container.buttons().map((node) => node.textContent);
    expect(labels).toEqual(['Copy command', 'Skip this version', 'Dismiss']);
    expect(labels.some((label) => /install|restart|update now/i.test(label))).toBe(false);
    for (const node of container.buttons()) expect(node.type).toBe('button');
    container.button('Copy command').dispatch('click');
    expect(h.copy).toHaveBeenCalledWith('brew upgrade --cask psyche-build');
    container.button('Skip this version').dispatch('click');
    expect(h.skip).toHaveBeenCalledWith('0.0.3');
    container.button('Dismiss').dispatch('click');
    expect(h.dismiss).toHaveBeenCalled();
  });

  it('renders a DMG notice with the release page and this architecture\'s SHA-256', () => {
    const doc = new FakeDocument();
    const container = doc.createElement('section');
    const h = handlers();
    renderUpdateBanner(container as never, bannerModel(available({ install_source: 'dmg' })), h, doc as never);
    expect(container.textContent).toContain(`SHA-256 (aarch64): ${SHA}`);
    expect(container.textContent).not.toContain(CASK_UPGRADE_COMMAND);
    container.button('Open release page').dispatch('click');
    expect(h.openRelease).toHaveBeenCalledWith('https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.3');
  });

  it('makes only the title a polite live region and keeps it across renders', () => {
    const doc = new FakeDocument();
    const container = doc.createElement('section');
    const h = handlers();
    expect(renderUpdateBanner(container as never, bannerModel(available({ install_source: 'unknown' })), h, doc as never)).toBe(true);
    const live = container.descendants().filter((node) => node.getAttribute('aria-live') === 'polite');
    expect(live).toHaveLength(1);
    expect(live[0].getAttribute('role')).toBe('status');
    expect(live[0].textContent).toBe('Psyche Build 0.0.3 is available.');
    expect(live[0].textContent).not.toContain(SHA);
    expect(live[0].textContent).not.toContain(CASK_UPGRADE_COMMAND);
    const children = container.children;
    // The same model again changes nothing, so nothing is re-announced.
    expect(renderUpdateBanner(container as never, bannerModel(available({ install_source: 'unknown' })), h, doc as never)).toBe(false);
    expect(container.children).toBe(children);
    // A different model reuses the same live element.
    renderUpdateBanner(container as never, bannerModel(available({ install_source: 'dmg' })), h, doc as never);
    expect(container.children[0]).toBe(live[0]);
  });

  it('hides and empties itself when there is nothing to show', () => {
    const doc = new FakeDocument();
    const container = doc.createElement('section');
    renderUpdateBanner(container as never, bannerModel(available()), handlers(), doc as never);
    renderUpdateBanner(container as never, null, handlers(), doc as never);
    expect(container.hidden).toBe(true);
    expect(container.children).toHaveLength(0);
  });

  it('is a labelled region in the page markup, hidden until needed, with no live region of its own', () => {
    const banner = indexHtml.match(/<section\s+class="update-banner"[\s\S]*?><\/section>/)?.[0] ?? '';
    expect(banner).not.toContain('role="status"');
    expect(banner).not.toContain('aria-live');
    expect(banner).toContain('aria-label="Psyche Build update"');
    expect(banner).toMatch(/\shidden\s/);
    expect(indexHtml).toContain('<script src="./update.bundle.js" defer></script>');
    expect(indexHtml.indexOf('update.bundle.js')).toBeLessThan(indexHtml.indexOf('src="./main.js"'));
  });
});

describe('update banner controller', () => {
  function setup(initial = available()) {
    const doc = new FakeDocument();
    const container = doc.createElement('section');
    container.hidden = true;
    (container as { ownerDocument: FakeDocument }).ownerDocument = doc;
    const checksToggle = doc.createElement('input');
    const checksRow = doc.createElement('label');
    const native = nativeMock(initial);
    const writeText = vi.fn(async () => {});
    const openUrl = vi.fn(async () => {});
    const announce = vi.fn();
    let emit: (() => void) | null = null;
    const listen = vi.fn(async (_event: string, callback: () => void) => { emit = callback; return () => {}; });
    const controller = createUpdateBannerController({
      invoke: native.invoke, listen, container: container as never, checksToggle: checksToggle as never,
      checksRow: checksRow as never, writeText, openUrl, announce,
    });
    return { controller, container, checksToggle, checksRow, native, writeText, openUrl, announce, listen, emit: () => emit?.() };
  }

  it('skips through the native command and stays hidden after a refresh', async () => {
    const { controller, container, native } = setup();
    await controller.refresh();
    expect(container.hidden).toBe(false);
    container.button('Skip this version').dispatch('click');
    await flush();
    expect(native.invoke).toHaveBeenCalledWith('update_skip_version', { version: '0.0.3' });
    expect(container.hidden).toBe(true);
    await controller.refresh();
    expect(container.hidden).toBe(true);
  });

  it('dismisses with the button or Escape, through the native command', async () => {
    const first = setup();
    await first.controller.refresh();
    first.container.button('Dismiss').dispatch('click');
    await flush();
    expect(first.native.invoke).toHaveBeenCalledWith('update_dismiss', undefined);
    expect(first.container.hidden).toBe(true);

    const second = setup();
    await second.controller.refresh();
    const event = second.container.dispatch('keydown', { key: 'Escape' });
    await flush();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(second.native.invoke).toHaveBeenCalledWith('update_dismiss', undefined);
    expect(second.container.hidden).toBe(true);
  });

  it('copies the Cask command and opens only the expected release page', async () => {
    const { controller, container, writeText, announce, openUrl } = setup(available({ install_source: 'unknown' }));
    await controller.refresh();
    container.button('Copy command').dispatch('click');
    container.button('Open release page').dispatch('click');
    await flush();
    expect(writeText).toHaveBeenCalledWith(CASK_UPGRADE_COMMAND);
    expect(announce).toHaveBeenCalledWith('Command copied.');
    expect(openUrl).toHaveBeenCalledWith('https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.3');
    await controller.handlers.openRelease('https://evil.example/');
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it('keeps the banner unchanged when a command is refused', async () => {
    const { controller, container, native } = setup();
    await controller.refresh();
    native.invoke.mockRejectedValueOnce(new Error('refused'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    container.button('Dismiss').dispatch('click');
    await flush();
    warn.mockRestore();
    expect(container.hidden).toBe(false);
  });

  it('puts the checkbox back when turning checks off is refused', async () => {
    const { controller, checksToggle, native } = setup();
    await controller.refresh();
    native.invoke.mockRejectedValueOnce(new Error('refused'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    checksToggle.checked = false;
    checksToggle.dispatch('change');
    await flush();
    warn.mockRestore();
    expect(checksToggle.checked).toBe(true);
  });

  it('returns focus to where it came from when the banner hides under focus', async () => {
    const { controller, container } = setup();
    await controller.refresh();
    const doc = container.ownerDocument;
    const terminal = doc.createElement('div');
    terminal.focus();
    const dismiss = container.button('Dismiss');
    dismiss.focus();
    container.dispatch('focusin', { relatedTarget: terminal });
    dismiss.dispatch('click');
    await flush();
    expect(container.hidden).toBe(true);
    expect(doc.activeElement).toBe(terminal);
  });

  it('falls back to restoreFocus when the previous element is gone', async () => {
    const doc = new FakeDocument();
    const container = doc.createElement('section');
    const native = nativeMock(available());
    const restoreFocus = vi.fn();
    const controller = createUpdateBannerController({ invoke: native.invoke, container: container as never, restoreFocus });
    await controller.refresh();
    const skip = container.button('Skip this version');
    skip.focus();
    container.dispatch('keydown', { key: 'Escape' });
    await flush();
    expect(container.hidden).toBe(true);
    expect(restoreFocus).toHaveBeenCalledTimes(1);
    // Hiding while focus is elsewhere never moves focus.
    const other = setup();
    await other.controller.refresh();
    const outside = other.container.ownerDocument.createElement('div');
    outside.focus();
    other.container.button('Dismiss').dispatch('click');
    await flush();
    expect(other.container.ownerDocument.activeElement).toBe(outside);
  });

  it('shows the checks setting only when supported, and turns checks off', async () => {
    const unsupported = setup(available({ state: 'disabled', checks_supported: false, checks_enabled: false, available: null as never }));
    await unsupported.controller.refresh();
    expect(unsupported.checksRow.hidden).toBe(true);
    expect(unsupported.checksToggle.disabled).toBe(true);

    const { controller, checksRow, checksToggle, native, container } = setup();
    await controller.refresh();
    expect(checksRow.hidden).toBe(false);
    expect(checksToggle.checked).toBe(true);
    checksToggle.checked = false;
    checksToggle.dispatch('change');
    await flush();
    expect(native.invoke).toHaveBeenCalledWith('update_set_checks_enabled', { enabled: false });
    expect(checksToggle.checked).toBe(false);
    expect(container.hidden).toBe(true);
  });

  it('refreshes when the native side reports a finished check', async () => {
    const { controller, container, native, listen, emit } = setup(available({ state: 'idle', available: null as never }));
    await controller.refresh();
    await flush();
    expect(listen).toHaveBeenCalledWith('update:status-changed', expect.any(Function));
    expect(container.hidden).toBe(true);
    native.set(available());
    emit();
    await flush();
    expect(container.hidden).toBe(false);
  });

  it('is wired from main.js with the native invoke, opener and clipboard, and no install path', () => {
    expect(mainJs).toContain('PsycheUpdate.createUpdateBannerController');
    expect(mainJs).toMatch(/invoke:\s*invokeNative/);
    expect(mainJs).toMatch(/openUrl:\s*openUrl/);
    const bundle = readFileSync(join(webRoot, 'update.bundle.js'), 'utf8');
    const sandbox: Record<string, unknown> = {};
    createContext(sandbox);
    runInContext(`${bundle};this.PsycheUpdate = PsycheUpdate;`, sandbox);
    expect(Object.keys(sandbox.PsycheUpdate as object).sort()).toEqual([
      'CASK_UPGRADE_COMMAND', 'bannerModel', 'createUpdateBannerController', 'renderUpdateBanner',
    ]);
    // No relaunch, exit, installer, or download path exists in the banner.
    for (const forbidden of ['relaunch', 'process.exit', 'update_install', 'download(', 'fetch(']) {
      expect(bundle).not.toContain(forbidden);
    }
  });
});
