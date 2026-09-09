import { describe, expect, test } from 'vitest';
import { desktopFunctionBody } from './support/desktopRustSurface.js';

/**
 * Every PTY command must reject callers from embedded external webviews.
 *
 * This resolves each function by name rather than reading `lib.rs` by path.
 * #197 slice 3 moves the PTY subsystem out of that file; a path-coupled
 * assertion would then fail with *function not found*, which reads as a
 * missing function when the risk this guards is an unguarded one. The two
 * failures must not look alike: only one of them is a security regression.
 */
describe('Tauri PTY caller security contract', () => {
  test('rejects PTY access from embedded external webviews', () => {
    const guard = desktopFunctionBody('ensure_trusted_pty_caller');

    expect(guard).toMatch(/label\s*==\s*"main"/);
    expect(guard).toContain("only available to trusted webview 'main'");
    expect(guard).toContain("rejected caller '{label}'");

    for (const name of [
      'pty_start',
      'pty_attach',
      'pty_write',
      'pty_resize',
      'pty_stop',
      'pty_ack',
      'pty_set_visibility',
      'pty_current_generation',
      'pty_list',
      'pty_transport_metrics',
    ]) {
      const command = desktopFunctionBody(name);
      expect(command).toMatch(/webview\s*:\s*tauri::Webview/);
      expect(command).toContain('ensure_trusted_pty_caller(webview.label())?;');
    }
  });
});
