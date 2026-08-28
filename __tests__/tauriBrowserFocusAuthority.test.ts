import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const nativeLib = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8',
).replace(/\r\n/g, '\n');
const nativeFocusPath = join(
  repoRoot,
  'native/desktop/psyche-build-tauri/src-tauri/src/browser_focus.rs',
);
const nativeFocus = existsSync(nativeFocusPath)
  ? readFileSync(nativeFocusPath, 'utf8').replace(/\r\n/g, '\n')
  : '';
const mainJs = readFileSync(
  join(repoRoot, 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
);
const browserCapability = JSON.parse(readFileSync(
  join(
    repoRoot,
    'native/desktop/psyche-build-tauri/src-tauri/capabilities/browser-app-shortcuts.json',
  ),
  'utf8',
)) as { permissions?: string[] };
const titleCapabilityPath = join(
  repoRoot,
  'native/desktop/psyche-build-tauri/src-tauri/capabilities/browser-title-reporting.json',
);
const titleCapability = existsSync(titleCapabilityPath)
  ? JSON.parse(readFileSync(titleCapabilityPath, 'utf8')) as { permissions?: string[] }
  : null;

describe('Tauri browser focus authority', () => {
  it('removes focus credentials, initialization scripts, and page focus listeners', () => {
    expect(nativeLib).not.toContain('browser_focus_initialization_script');
    expect(nativeLib).not.toContain('focus_nonce');
    expect(nativeLib).not.toContain('.initialization_script(focus_script)');
    expect(nativeLib).not.toContain('window.addEventListener("focus"');
    expect(nativeLib).not.toContain('document.addEventListener("focusin"');
    expect(mainJs).not.toContain('focusNonce');
  });

  it('gives remote pages no direct event permission or focus command seam', () => {
    expect(browserCapability.permissions).not.toContain('core:event:allow-emit');
    expect(browserCapability.permissions).not.toContain('core:event:allow-emit-to');
    expect(browserCapability.permissions).not.toContain('allow-browser-report-title');
    expect(titleCapability?.permissions).toEqual(['allow-browser-report-title']);
    expect(nativeLib).toContain('fn browser_report_title(');
    expect(nativeLib).not.toMatch(/fn browser_(?:report_)?focus\s*\(/);
  });

  it('installs native callbacks for supported desktop webviews and fails closed elsewhere', () => {
    expect(nativeFocus).toContain('#[cfg(target_os = "macos")]');
    expect(nativeFocus).toContain('NSClickGestureRecognizer');
    expect(nativeFocus).toContain('bounded_browser_focus_title');
    expect(nativeFocus).toContain('.title()');
    expect(nativeFocus).toContain('#[cfg(target_os = "windows")]');
    expect(nativeFocus).toContain('add_GotFocus');
    expect(nativeFocus).toContain('SourceChangedEventHandler');
    expect(nativeFocus).toContain('add_SourceChanged');
    expect(nativeFocus).toContain('IsNewDocument');
    expect(nativeFocus).toContain('DocumentTitle');
    expect(nativeFocus).toContain('emit_to("main", "browser:route", payload)');
    expect(nativeFocus).toContain('remove_GotFocus');
    expect(nativeFocus).toContain('remove_SourceChanged');
    expect(nativeFocus).toContain('BROWSER_WINDOWS_FOCUS_REGISTRATIONS');
    expect(nativeFocus).toContain('#[cfg(target_os = "linux")]');
    expect(nativeFocus).toContain('connect_focus_in_event');
    expect(nativeFocus).toContain('connect_button_press_event');
    expect(nativeFocus).toContain('#[cfg(not(any(');
    expect(nativeFocus).toContain('native browser focus callbacks are unsupported');
  });

  it('emits focus only from the native registry with the current native URL and bounded title', () => {
    expect(nativeFocus).toContain('BROWSER_NATIVE_FOCUS_VIEWS');
    expect(nativeFocus).toContain('resolve_browser_native_focus');
    expect(nativeFocus).toContain('pub(crate) title: String');
    expect(nativeFocus).toContain('title: bounded_browser_focus_title(current_title)');
    expect(nativeFocus).toContain('emit_to("main", "browser:focus"');
    expect(nativeFocus).toContain('emit_to("main", "browser:route"');
    expect(nativeFocus).toContain('registration_id');
    expect(nativeFocus).toContain('.URL()');
    expect(nativeFocus).toContain('CoreWebView2');
    expect(nativeFocus).toContain('emit_windows_browser_native_focus');
    expect(nativeFocus).toContain('.uri()');
  });
});
