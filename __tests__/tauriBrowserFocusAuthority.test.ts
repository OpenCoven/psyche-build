import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const nativeLib = readFileSync(
  join(process.cwd(), 'native/desktop/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8',
).replace(/\r\n/g, '\n');

function focusInitializationScript() {
  const functionStart = nativeLib.indexOf('fn browser_focus_initialization_script(');
  expect(functionStart).toBeGreaterThanOrEqual(0);
  const rawStart = nativeLib.indexOf('r#"', functionStart);
  const rawEnd = nativeLib.indexOf('"#', rawStart + 3);
  expect(rawStart).toBeGreaterThan(functionStart);
  expect(rawEnd).toBeGreaterThan(rawStart);
  const template = nativeLib
    .slice(rawStart + 3, rawEnd)
    .replaceAll('{{', '\u0000')
    .replaceAll('}}', '}')
    .replaceAll('\u0000', '{');
  const invocation = '})({}, {}, {}, {});';
  expect(template.endsWith(invocation)).toBe(true);
  return template.slice(0, -invocation.length)
    + '})("psyche-browser-project-a", 7, "native-token", "opaque-focus-nonce");';
}

function installFocusHarness() {
  const emitted: Array<{ target: string; name: string; payload: Record<string, unknown> }> = [];
  const pageEmitted: Array<{ target: string; name: string; payload: Record<string, unknown> }> = [];
  const windowListeners = new Map<string, (event: { isTrusted: boolean }) => void>();
  const documentListeners = new Map<string, (event: { isTrusted: boolean }) => void>();
  const trustedEventApi = {
    emitTo(target: string, name: string, payload: Record<string, unknown>) {
      emitted.push({ target, name, payload });
    },
  };
  let focused = true;
  const windowObject: Record<string, unknown> & {
    top?: unknown;
    __TAURI__: { event: typeof trustedEventApi };
    addEventListener: (name: string, listener: (event: { isTrusted: boolean }) => void) => void;
  } = {
    __TAURI__: { event: trustedEventApi },
    addEventListener(name, listener) {
      windowListeners.set(name, listener);
    },
  };
  windowObject.top = windowObject;
  const documentObject = {
    readyState: 'loading',
    visibilityState: 'visible',
    hasFocus: () => focused,
    addEventListener(name: string, listener: (event: { isTrusted: boolean }) => void) {
      documentListeners.set(name, listener);
    },
  };
  const originalWindowKeys = Object.keys(windowObject).sort();

  Function('window', 'document', 'location', focusInitializationScript())(
    windowObject,
    documentObject,
    { href: 'https://current.example/path' },
  );

  windowObject.__TAURI__.event.emitTo = (target, name, payload) => {
    pageEmitted.push({ target, name, payload });
  };

  return {
    emitted,
    pageEmitted,
    windowListeners,
    documentListeners,
    windowObject,
    originalWindowKeys,
    setFocused(value: boolean) {
      focused = value;
    },
  };
}

describe('Tauri browser focus authority', () => {
  it('keeps focus credentials sealed in an initialization-script closure', () => {
    const script = focusInitializationScript();
    const harness = installFocusHarness();

    expect(script).not.toMatch(
      /(?:window|globalThis|document)\s*(?:\.|\[)[^\n=]*(?:FOCUS|focusNonce|navigationToken|generation)[^\n=]*=/,
    );
    expect(Object.keys(harness.windowObject).sort()).toEqual(harness.originalWindowKeys);
    const pageGlobals = JSON.stringify({ ...harness.windowObject, top: null });
    expect(pageGlobals).not.toContain('opaque-focus-nonce');
    expect(pageGlobals).not.toContain('native-token');
  });

  it('ignores synthetic focus and verifies the document is actually focused', () => {
    const harness = installFocusHarness();
    const reportWindowFocus = harness.windowListeners.get('focus');
    const reportElementFocus = harness.documentListeners.get('focusin');

    expect(reportWindowFocus).toBeTypeOf('function');
    expect(reportElementFocus).toBeTypeOf('function');
    reportWindowFocus!({ isTrusted: false });
    harness.setFocused(false);
    reportElementFocus!({ isTrusted: true });

    expect(harness.emitted).toEqual([]);
    expect(harness.pageEmitted).toEqual([]);
  });

  it('uses the emitter captured before page monkeypatching for trusted focus', () => {
    const harness = installFocusHarness();

    harness.windowListeners.get('focus')!({ isTrusted: true });

    expect(harness.pageEmitted).toEqual([]);
    expect(harness.emitted).toEqual([{
      target: 'main',
      name: 'browser:focus',
      payload: {
        label: 'psyche-browser-project-a',
        url: 'https://current.example/path',
        generation: 7,
        navigationToken: 'native-token',
        focusNonce: 'opaque-focus-nonce',
      },
    }]);
  });

  it('requires the opaque native focus nonce in the trusted main-page guard', () => {
    expect(nativeLib).toContain('focus_nonce: String');
    const mainJs = readFileSync(
      join(process.cwd(), 'native/desktop/psyche-build-tauri/web/main.js'),
      'utf8',
    );
    expect(mainJs).toContain('payload.focusNonce !== lifecycle.liveFocusNonce');
    expect(mainJs).toContain('lifecycle.liveFocusNonce = String(nativeNavigation.focusNonce)');
  });
});
