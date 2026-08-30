import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const sourcePath = resolve(
  process.cwd(),
  'native/desktop/psyche-build-tauri/src-tauri/src/lib.rs',
);

function functionBody(source: string, name: string): string {
  const signature = new RegExp(`\\bfn\\s+${name}\\s*\\(`).exec(source);
  const start = signature?.index ?? -1;
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not find function body for ${name}`);
}

describe('Tauri PTY caller security contract', () => {
  test('rejects PTY access from embedded external webviews', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const guard = functionBody(source, 'ensure_trusted_pty_caller');

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
      const command = functionBody(source, name);
      expect(command).toMatch(/webview\s*:\s*tauri::Webview/);
      expect(command).toContain('ensure_trusted_pty_caller(webview.label())?;');
    }
  });
});
