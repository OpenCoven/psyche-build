import { describe, expect, test } from 'vitest';
import { readDesktopCommandSurface } from './support/desktopCompositionRoot.js';
import {
  desktopFunctionBody,
  desktopSourceDefining,
} from './support/desktopRustSurface.js';

describe('Tauri pane session metrics native contract', () => {
  test('loads Coven metrics off the IPC thread and preserves validation', () => {
    // Registration stays on the command surface: that assertion is about the
    // IPC handler list, which does not move with the command body.
    expect(readDesktopCommandSurface()).toMatch(/\n\s*pane_session_metrics,/);

    // Signature and attribute adjacency need the owning file, because a body
    // slice starts at `fn` and cannot see `#[tauri::command]` above it.
    expect(desktopSourceDefining('pane_session_metrics')).toMatch(
      /#\[tauri::command\][\s\S]*?async\s+fn\s+pane_session_metrics\s*\([\s\S]*?project_root\s*:\s*String\s*,[\s\S]*?cwd\s*:\s*String\s*,[\s\S]*?session_id\s*:\s*String\s*,?[\s\S]*?\)\s*->\s*Result<PaneSessionMetrics,\s*String>/,
    );

    const command = desktopFunctionBody('pane_session_metrics');
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
