import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const libSourcePath = resolve(
  process.cwd(),
  'native/macos/psyche-build-tauri/src-tauri/src/lib.rs',
);
const cargoTomlPath = resolve(
  process.cwd(),
  'native/macos/psyche-build-tauri/src-tauri/Cargo.toml',
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
    const [libSource, cargoToml] = await Promise.all([
      readFile(libSourcePath, 'utf8'),
      readFile(cargoTomlPath, 'utf8'),
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
  });
});
