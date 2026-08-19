import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../native/desktop/psyche-build-tauri/', import.meta.url);
const lib = readFileSync(new URL('src-tauri/src/lib.rs', root), 'utf8');

function cfgFunction(platform: 'windows' | 'linux', name: string): string {
  const marker = `#[cfg(target_os = "${platform}")]\nasync fn ${name}(`;
  const start = lib.indexOf(marker);
  if (start < 0) throw new Error(`missing ${platform} ${name}`);
  return rustBlock(start);
}

function rustItem(marker: string): string {
  const start = lib.indexOf(marker);
  if (start < 0) throw new Error(`missing ${marker}`);
  return rustBlock(start);
}

function rustBlock(start: number): string {
  const body = lib.indexOf('{', start);
  let depth = 0;
  for (let cursor = body; cursor < lib.length; cursor += 1) {
    if (lib[cursor] === '{') depth += 1;
    if (lib[cursor] === '}' && --depth === 0) return lib.slice(start, cursor + 1);
  }
  throw new Error(`unterminated Rust block at ${start}`);
}

describe('Tauri cross-platform browser navigation', () => {
  it('uses WebView2 native navigation IDs and removes both event handlers', () => {
    const source = cfgFunction('windows', 'start_browser_navigation');

    expect(source).toContain('NavigationStartingEventHandler');
    expect(source).toContain('NavigationCompletedEventHandler');
    expect(source).toContain('add_NavigationStarting');
    expect(source).toContain('add_NavigationCompleted');
    expect(source).toContain('.Navigate(');
    expect(source).toContain('NavigationId');
    expect(source).toContain('IsSuccess');
    expect(source).toContain('WebErrorStatus');
    expect(lib).toContain('remove_NavigationStarting');
    expect(lib).toContain('remove_NavigationCompleted');
    const registration = rustItem('struct BrowserWindowsNavigationRegistration');
    expect(registration).toMatch(/native_view[\s\S]*generation[\s\S]*token[\s\S]*navigation_id/);
    const completion = source.slice(
      source.indexOf('let completed ='),
      source.indexOf('let mut starting_registration_token'),
    );
    expect(completion.indexOf('browser_windows_completion_matches'))
      .toBeLessThan(completion.indexOf('take_windows_browser_navigation'));
  });

  it('uses an owned monotonic WebKitGTK state for redirects and replacements', () => {
    const source = cfgFunction('linux', 'start_browser_navigation');

    expect(source).toContain('connect_load_changed');
    expect(source).toContain('connect_load_failed');
    expect(source).toContain('connect_load_failed_with_tls_errors');
    expect(source).toContain('.load_uri(');
    expect(lib).toContain('NEXT_BROWSER_LINUX_NAVIGATION_SEQUENCE');
    const registration = rustItem('struct BrowserLinuxNavigationRegistration');
    expect(registration).toMatch(/native_view[\s\S]*generation[\s\S]*token[\s\S]*sequence[\s\S]*phase/);
    expect(registration).toContain('requested_url');
    expect(lib).toContain('BrowserLinuxNavigationPhase::Redirected');
    expect(lib).toContain('browser navigation signal order was ambiguous');
    expect(lib).toContain('browser navigation was replaced before completion');
    expect(lib).toContain('disconnect_linux_browser_navigation_signals');
  });

  it('correlates completion to label, live view, generation, token, and native identity', () => {
    const resolve = rustItem('fn resolve_browser_navigation(');
    const takeWaiter = rustItem('fn take_browser_navigation_waiter(');
    expect(resolve).toMatch(
      /fn resolve_browser_navigation\([\s\S]*label: &str,[\s\S]*generation: u64,[\s\S]*token: &str,[\s\S]*native_view: usize,[\s\S]*navigation_identity: u64/,
    );
    expect(takeWaiter).toMatch(
      /waiter\.generation == generation[\s\S]*waiter\.token == token[\s\S]*waiter\.native_view == Some\(native_view\)[\s\S]*waiter\.navigation_identity == Some\(identity\)/,
    );
    expect(lib).toContain('retire_matching_browser_focus_identity');
  });

  it('detaches native navigation callbacks on completion, timeout, retirement, and close', () => {
    const retire = rustItem('fn retire_browser_webview_for_navigation(');
    const destroy = rustItem('fn destroy_browser_webview(');
    const navigate = rustItem('async fn browser_navigate(');
    expect(lib).toContain('detach_browser_navigation_callbacks');
    expect(retire).toMatch(/webview\.close\(\)[\s\S]*detach_browser_navigation_callbacks\(&webview, label\)/);
    expect(destroy).toMatch(/webview\.close\(\)[\s\S]*detach_browser_navigation_callbacks\(&webview, &label\)/);
    expect(lib).toContain('close_browser_webview_transactionally');
    expect(navigate).toMatch(/Err\(_\) => \{[\s\S]*retire_browser_webview_for_navigation\(&app, &label\)[\s\S]*browser navigation timed out/);
    expect(navigate).toMatch(/Ok\(Ok\(Err\(error\)\)\) => \{[\s\S]*retire_browser_webview_for_navigation\(&app, &label\)/);
  });

  it('keeps native focus installed for successful live views and removes the non-macOS stub', () => {
    const navigate = lib.slice(
      lib.indexOf('async fn browser_navigate('),
      lib.indexOf('fn browser_set_bounds('),
    );
    expect(navigate.indexOf('install_browser_native_focus_callback'))
      .toBeLessThan(navigate.indexOf('start_browser_navigation'));
    expect(lib).not.toContain(
      'backend_unavailable: exact browser navigation identity is unsupported',
    );
    expect(lib).toContain('Url::parse("about:blank")');
    expect(lib).toContain('WebviewUrl::External(initial_url)');
  });
});
