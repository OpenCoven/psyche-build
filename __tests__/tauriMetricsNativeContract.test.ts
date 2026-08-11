import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const libSourcePath = resolve(
  process.cwd(),
  'native/macos/psyche-build-tauri/src-tauri/src/lib.rs',
);
const mainSourcePath = resolve(
  process.cwd(),
  'native/macos/psyche-build-tauri/web/main.js',
);
const cargoTomlPath = resolve(
  process.cwd(),
  'native/macos/psyche-build-tauri/src-tauri/Cargo.toml',
);
const covenSessionsPath = resolve(
  process.cwd(),
  'native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs',
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
  const match = new RegExp(`(?:pub\\s+)?(?:async\\s+)?fn\\s+${functionName}\\s*\\(`).exec(source);
  expect(match?.index ?? -1).toBeGreaterThanOrEqual(0);
  const start = match!.index;
  const bodyStart = source.indexOf('{', start);
  return source.slice(start, bodyStart + bracedBody(source, start).length);
}

describe('Tauri workspace metrics native contract', () => {
  test('wires PTY identity retention and the async metrics command', async () => {
    const [libSource, cargoToml, mainSource, covenSessions] = await Promise.all([
      readFile(libSourcePath, 'utf8'),
      readFile(cargoTomlPath, 'utf8'),
      readFile(mainSourcePath, 'utf8'),
      readFile(covenSessionsPath, 'utf8'),
    ]);

    expect(cargoToml).toMatch(/\bsysinfo = "0\.36\.1"/);

    expect(libSource).toMatch(
      /struct\s+PtySession\s*\{[\s\S]*pid\s*:\s*Option<u32>\s*,[\s\S]*spawn_time_unix_secs\s*:\s*u64\s*,[\s\S]*\}/,
    );
    expect(libSource).toMatch(/mod\s+metrics\s*;/);
    expect(libSource).toMatch(
      /use\s+metrics::\{[\s\S]*MetricsCollector[\s\S]*MetricsScope[\s\S]*MetricsSnapshot[\s\S]*TrackedPty[\s\S]*\}\s*;/,
    );
    expect(libSource).toMatch(
      /#\[derive\(Clone,\s*Default\)\]\s*struct\s+MetricsState\s*\{[\s\S]*collector\s*:\s*Arc<Mutex<MetricsCollector>>[\s\S]*\}/,
    );

    const ptyStart = functionBody(libSource, 'pty_start');
    expect(ptyStart).toMatch(
      /let\s+spawn_time_unix_secs\s*=\s*SystemTime::now\(\)[\s\S]*?duration_since\(UNIX_EPOCH\)[\s\S]*?as_secs\(\)\s*;/,
    );
    expect(ptyStart).toMatch(
      /let\s+mut\s+child\s*=\s*pair\.slave\.spawn_command\(cmd\)\.map_err\(\|e\| e\.to_string\(\)\)\?\s*;\s*let\s+pid\s*=\s*child\.process_id\(\)\s*;/,
    );
    expect(ptyStart).toMatch(
      /PtySession\s*\{[\s\S]*writer:\s*Arc::new\(Mutex::new\(writer\)\)\s*,[\s\S]*pid,\s*[\s\S]*spawn_time_unix_secs,\s*[\s\S]*\}/,
    );

    const workspaceMetrics = functionBody(libSource, 'workspace_metrics');
    expect(libSource).toMatch(
      /#\[tauri::command\]\s*async\s+fn\s+workspace_metrics\s*\(\s*state:\s*State<'_,\s*MetricsState>\s*,\s*scope:\s*Option<MetricsScope>\s*,?\s*\)\s*->\s*Result<MetricsSnapshot,\s*String>/,
    );
    expect(workspaceMetrics).toMatch(
      /let\s+tracked(?:_ptys|_sessions)\s*=\s*\{\s*let\s+guard\s*=\s*SESSIONS\.lock\(\)\s*;[\s\S]*?filter_map\(\s*\|\(thread_id,\s*session\)\|\s*\{[\s\S]*?session\.pid\.map\(\|pid\|\s*\{[\s\S]*?TrackedPty::new\(\s*thread_id\.clone\(\)\s*,\s*pid\s*,\s*session\.spawn_time_unix_secs\s*\)[\s\S]*?\}\)[\s\S]*?\}\s*\)[\s\S]*?\}/,
    );
    expect(workspaceMetrics).toMatch(/let\s+collector\s*=\s*state\.collector\.clone\(\)\s*;/);
    expect(workspaceMetrics).toMatch(/tauri::async_runtime::spawn_blocking\s*\(\s*move\s*\|\|\s*\{/);
    expect(workspaceMetrics).toMatch(/collector\s*\.\s*lock\(\)/);
    expect(workspaceMetrics).toMatch(
      /\.snapshot\(\s*std::process::id\(\)\s*,\s*&tracked_sessions\s*,\s*scope\s*\)/,
    );
    expect(workspaceMetrics).toContain('metrics collector task failed:');

    const runBody = functionBody(libSource, 'run');
    expect(runBody).toContain('.manage(MetricsState::default())');
    const metricsStateRegistrationIndex = runBody.indexOf('.manage(MetricsState::default())');
    const invokeHandlerIndex = runBody.indexOf('.invoke_handler(');
    expect(metricsStateRegistrationIndex).toBeGreaterThanOrEqual(0);
    expect(invokeHandlerIndex).toBeGreaterThanOrEqual(0);
    expect(metricsStateRegistrationIndex).toBeLessThan(invokeHandlerIndex);
    expect(libSource).toMatch(
      /tauri::generate_handler!\s*\[[\s\S]*git_log,\s*workspace_metrics,\s*[\s\S]*\]/,
    );

    expect(covenSessions).toMatch(
      /struct\s+CovenSessionSummary\s*\{[\s\S]*model:\s*Option<String>,[\s\S]*current_task:\s*Option<String>,[\s\S]*input_tokens:\s*Option<u64>,[\s\S]*output_tokens:\s*Option<u64>,[\s\S]*\}/,
    );
    expect(covenSessions).toContain('const MAX_JAVASCRIPT_SAFE_INTEGER_U64: u64 = 9_007_199_254_740_991;');
    expect(covenSessions).toMatch(
      /fn\s+optional_javascript_safe_u64\s*\(\s*fields:\s*&Map<String,\s*Value>\s*,\s*camel_case:\s*&str\s*,\s*snake_case:\s*&str\s*,?\s*\)\s*->\s*Option<u64>\s*\{/,
    );
    expect(covenSessions).toContain('.and_then(Value::as_u64)');
    expect(covenSessions).toContain(
      '.filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER_U64)',
    );
    expect(covenSessions).toMatch(
      /model:\s*optional_string\(fields,\s*"model",\s*"model"\)\?,[\s\S]*current_task:\s*optional_string\(fields,\s*"currentTask",\s*"current_task"\)\?,[\s\S]*input_tokens:\s*optional_javascript_safe_u64\(fields,\s*"inputTokens",\s*"input_tokens"\),[\s\S]*output_tokens:\s*optional_javascript_safe_u64\(fields,\s*"outputTokens",\s*"output_tokens"\),/,
    );

    expect(mainSource).toMatch(
      /function\s+createThread\s*\([\s\S]*startedAt:\s*Date\.now\(\)\s*,[\s\S]*finishedAt:\s*null\s*,[\s\S]*exitCode:\s*null\s*,/,
    );

    expect(mainSource).toMatch(
      /function\s+spawnPty\s*\([\s\S]*thread\.startedAt\s*=\s*Date\.now\(\)\s*;[\s\S]*thread\.finishedAt\s*=\s*null\s*;[\s\S]*thread\.exitCode\s*=\s*null\s*;/,
    );
    expect(mainSource).toMatch(
      /function\s+spawnPty\s*\([\s\S]*thread\.ptyStarted\s*=\s*false\s*;[\s\S]*thread\.status\s*=\s*"failed"\s*;[\s\S]*thread\.finishedAt\s*=\s*Date\.now\(\)\s*;[\s\S]*thread\.exitCode\s*=\s*null\s*;/,
    );

    expect(mainSource).toMatch(
      /function\s+handlePtyExit\s*\([\s\S]*var\s+stoppedByUser\s*=\s*thread\.stopRequested\s*;/,
    );
    expect(mainSource).toMatch(
      /function\s+handlePtyExit\s*\([\s\S]*thread\.finishedAt\s*=\s*Date\.now\(\)\s*;[\s\S]*thread\.exitCode\s*=\s*payload\.code == null \? null : payload\.code\s*;/,
    );
    expect(mainSource).toMatch(
      /function\s+handlePtyExit\s*\([\s\S]*thread\.status\s*=\s*"exited"\s*;[\s\S]*if\s*\(!stoppedByUser\s*&&\s*payload\.code != null\s*&&\s*payload\.code !== 0\)\s*\{[\s\S]*thread\.status\s*=\s*"failed"\s*;/,
    );
  });
});
