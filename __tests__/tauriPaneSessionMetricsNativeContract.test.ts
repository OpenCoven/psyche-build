import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const libSourcePath = resolve(
  process.cwd(),
  'native/desktop/psyche-build-tauri/src-tauri/src/lib.rs',
);

function bracedBody(source: string, start: number): string {
  const bodyStart = source.indexOf('{', start);
  expect(bodyStart).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index + 1);
  }

  throw new Error('Could not find the end of the braced block');
}

function functionBody(source: string, functionName: string): string {
  const start = source.indexOf(`fn ${functionName}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf('{', start);
  return source.slice(start, bodyStart + bracedBody(source, start).length);
}

describe('Tauri pane session metrics native contract', () => {
  test('loads Coven metrics off the IPC thread and preserves validation', async () => {
    const libSource = await readFile(libSourcePath, 'utf8');

    expect(libSource).toMatch(
      /#\[tauri::command\][\s\S]*?async\s+fn\s+pane_session_metrics\s*\([\s\S]*?project_root\s*:\s*String\s*,[\s\S]*?cwd\s*:\s*String\s*,[\s\S]*?session_id\s*:\s*String\s*,?[\s\S]*?\)\s*->\s*Result<PaneSessionMetrics,\s*String>/,
    );
    expect(libSource).toMatch(/\n\s*pane_session_metrics,/);

    const command = functionBody(libSource, 'pane_session_metrics');
    expect(command).toMatch(
      /is_safe_session_id\(&session_id\)[\s\S]*open_pty_cwd\(&project_root,\s*&cwd\)[\s\S]*which_on_path\("coven"\)/,
    );
    expect(command).toMatch(/tauri::async_runtime::spawn_blocking\s*\(\s*move\s*\|\|\s*\{/);
    expect(command).toMatch(/pane_metrics::load_coven_metrics\s*\(/);
    expect(command).toMatch(/std::ffi::OsStr::new\(&path\)/);
    expect(command).toMatch(/\.await/);
    expect(command).toMatch(/Ok\(metrics\)\s*=>\s*metrics/);
    expect(command).toMatch(
      /Err\(error\)\s*=>\s*Err\(format!\("failed to join Coven metrics task: \{error\}"\)\)/,
    );
  });
});
