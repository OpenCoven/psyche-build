import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const covenSessionsSourcePath = resolve(
  process.cwd(),
  'native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs',
);
const libSourcePath = resolve(
  process.cwd(),
  'native/macos/psyche-build-tauri/src-tauri/src/lib.rs',
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

function blockingClosureBody(command: string): string {
  const spawnBlocking = command.indexOf('tauri::async_runtime::spawn_blocking');
  expect(spawnBlocking).toBeGreaterThanOrEqual(0);

  const closure = command.indexOf('move ||', spawnBlocking);
  expect(closure).toBeGreaterThanOrEqual(0);
  return bracedBody(command, closure);
}

describe('Tauri Coven session native contract', () => {
  test('registers non-blocking Coven discovery under the coven_sessions command', async () => {
    const [covenSessionsSource, libSource] = await Promise.all([
      readFile(covenSessionsSourcePath, 'utf8'),
      readFile(libSourcePath, 'utf8'),
    ]);

    expect(covenSessionsSource).toMatch(
      /#\[tauri::command\]\s*pub\(crate\)\s+async\s+fn\s+coven_sessions\s*\(\s*project_roots\s*:\s*Vec\s*<\s*String\s*>\s*\)\s*->\s*CovenSessionsResponse/,
    );

    const command = functionBody(covenSessionsSource, 'coven_sessions');
    expect(command).not.toContain('std::env::vars()');
    expect(command).toMatch(/tauri::async_runtime::spawn_blocking\s*\(\s*move\s*\|\|\s*\{/);
    expect(command).toMatch(/\.await/);

    const closure = blockingClosureBody(command);
    for (const key of ['COVEN_SOCKET', 'COVEN_HOME', 'COVEN_URL', 'COVEN_PORT']) {
      expect(closure).toMatch(new RegExp(`std::env::var_os\\s*\\(\\s*"${key}"\\s*\\)`));
    }
    expect(closure).toMatch(/home_path\s*\(\s*std::env::var_os\s*\(\s*"HOME"\s*\)\s*\)/);
    expect(closure).toMatch(/discover\s*\(\s*&env\s*,\s*&home\s*,\s*project_roots\s*\)/);

    expect(libSource).toMatch(/use\s+coven_sessions::coven_sessions\s*;/);
    expect(libSource).toMatch(
      /tauri::generate_handler!\s*\[[\s\S]*?app_environment\s*,\s*coven_sessions\s*,/,
    );
    expect(libSource).not.toMatch(/load_coven_sessions\s*\(/);
  });
});
