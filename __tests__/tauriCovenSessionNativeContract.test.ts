import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const covenSessionsSourcePath = resolve(
  process.cwd(),
  'native/desktop/psyche-build-tauri/src-tauri/src/coven_sessions.rs',
);
const libSourcePath = resolve(
  process.cwd(),
  'native/desktop/psyche-build-tauri/src-tauri/src/lib.rs',
);
const mainSourcePath = resolve(
  process.cwd(),
  'native/desktop/psyche-build-tauri/web/main.js',
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
  test('wires Psyche provenance through native Coven Code and attach launch seams', async () => {
    const [mainSource, libSource] = await Promise.all([
      readFile(mainSourcePath, 'utf8'),
      readFile(libSourcePath, 'utf8'),
    ]);
    const codeStart = mainSource.indexOf('function covenCodeLaunch');
    const codeEnd = mainSource.indexOf('async function spawnCovenThread', codeStart);
    expect(codeStart).toBeGreaterThanOrEqual(0);
    expect(codeEnd).toBeGreaterThan(codeStart);
    const codeLaunch = mainSource.slice(codeStart, codeEnd);
    expect(codeLaunch).toContain('env: { COVEN_SESSION_SOURCE: "psyche-build" }');

    const applyLaunchEnv = functionBody(libSource, 'apply_launch_env');
    expect(applyLaunchEnv).toContain('launch_kind == Some("coven-attach")');
    expect(applyLaunchEnv).toContain('cmd.env_remove(COVEN_SESSION_SOURCE)');

    const ptyStart = functionBody(libSource, 'pty_start_blocking');
    expect(ptyStart.indexOf('prepare_pty_start(&options)?')).toBeLessThan(
      ptyStart.indexOf('validate_coven_launch(&options)?'),
    );
  });

  test('registers non-blocking Coven discovery under the coven_sessions command', async () => {
    const [covenSessionsSource, libSource] = await Promise.all([
      readFile(covenSessionsSourcePath, 'utf8'),
      readFile(libSourcePath, 'utf8'),
    ]);

    expect(covenSessionsSource).toMatch(
      /#\[tauri::command\][\s\S]*?fn\s+coven_sessions\s*\([\s\S]*?project_roots\s*:\s*Vec<String>\s*,[\s\S]*?project_scopes\s*:\s*Option<Vec<CovenProjectScope>>\s*,?[\s\S]*?\)\s*->\s*CovenSessionsResponse/,
    );
    expect(covenSessionsSource).toMatch(
      /#\[serde\(rename_all\s*=\s*"camelCase"\)\][\s\S]*struct\s+CovenProjectScope\s*\{[\s\S]*project_root\s*:\s*String[\s\S]*worktree_roots\s*:\s*Vec<String>/,
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
    expect(closure).toMatch(
      /discover\s*\(\s*&env\s*,\s*&home\s*,\s*project_roots\s*,\s*project_scopes\s*\)/,
    );

    expect(libSource).toMatch(
      /use\s+coven_sessions::\{\s*coven_session_kill\s*,\s*coven_sessions\s*\}\s*;/,
    );
    expect(libSource).toMatch(
      /tauri::generate_handler!\s*\[[\s\S]*?app_environment\s*,\s*coven_sessions\s*,/,
    );
    expect(libSource).not.toMatch(/load_coven_sessions\s*\(/);
    expect(libSource).toMatch(/fn\s+validate_coven_launch\(/);
    expect(libSource).toMatch(/fn\s+resolve_pty_cwd\(/);
    expect(libSource).toMatch(/fn\s+linked_worktree_roots\(/);
    expect(libSource).toMatch(/cmd\.env_remove\("TMUX"\)/);
  });

  test('registers a non-blocking native Coven session kill command', async () => {
    const [covenSessionsSource, libSource] = await Promise.all([
      readFile(covenSessionsSourcePath, 'utf8'),
      readFile(libSourcePath, 'utf8'),
    ]);

    expect(covenSessionsSource).toMatch(
      /#\[tauri::command\][\s\S]*?fn\s+coven_session_kill\s*\(\s*session_id\s*:\s*String\s*,?\s*\)\s*->\s*Result<\(\),\s*String>/,
    );
    const command = functionBody(covenSessionsSource, 'coven_session_kill');
    expect(command).toMatch(/tauri::async_runtime::spawn_blocking\s*\(\s*move\s*\|\|\s*\{/);
    const closure = blockingClosureBody(command);
    expect(closure).toMatch(/is_safe_session_id\s*\(\s*&session_id\s*\)/);
    expect(closure).toMatch(
      /try_kill_coven_session\s*\(\s*&endpoint\s*,\s*&session_id\s*\)/,
    );

    expect(libSource).toMatch(
      /use\s+coven_sessions::\{\s*coven_session_kill\s*,\s*coven_sessions\s*\}\s*;/,
    );
    expect(libSource).toMatch(
      /tauri::generate_handler!\s*\[[\s\S]*?coven_sessions\s*,\s*coven_session_kill\s*,/,
    );
  });

  test('shares one wall-clock deadline across health and session requests', async () => {
    const source = await readFile(covenSessionsSourcePath, 'utf8');
    const loadBody = functionBody(source, 'try_load_coven_sessions');
    const requestBody = functionBody(source, 'request_endpoint');

    expect(loadBody).toMatch(/let\s+deadline\s*=\s*Instant::now\(\)\s*\+\s*EXCHANGE_TIMEOUT/);
    expect(loadBody).toMatch(
      /request_endpoint\s*\(\s*endpoint\s*,\s*HttpMethod::Get\s*,\s*"\/api\/v1\/health"\s*,\s*deadline\s*\)/,
    );
    expect(loadBody).toMatch(
      /request_endpoint\s*\(\s*endpoint\s*,\s*HttpMethod::Get\s*,\s*"\/api\/v1\/sessions"\s*,\s*deadline\s*\)/,
    );
    expect(requestBody).toMatch(/deadline\s*:\s*Instant/);
    expect(requestBody).not.toMatch(/Instant::now\(\)\s*\+\s*EXCHANGE_TIMEOUT/);
  });
});
