import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const libRs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8',
);
const mainJs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);

function functionSource(name: string) {
  const asyncStart = mainJs.indexOf(`async function ${name}(`);
  const syncStart = mainJs.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = mainJs.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainJs.length; index += 1) {
    if (mainJs[index] === '{') depth += 1;
    if (mainJs[index] === '}') depth -= 1;
    if (depth === 0) return mainJs.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

describe('Tauri Coven launch project scope', () => {
  it('registers the canonical project path command and requires validated PTY roots', () => {
    expect(libRs).toMatch(/fn canonical_project_path\s*\(\s*root\s*:\s*String\s*\)/);
    expect(libRs).toMatch(/tauri::generate_handler!\s*\[[\s\S]*canonical_project_path\s*,/);
    expect(libRs).toMatch(/pub cwd:\s*Option<String>/);
    expect(libRs).toMatch(/pub launch_kind:\s*Option<String>/);
    expect(libRs).toMatch(/pub coven_session_id:\s*Option<String>/);

    const ptyStart = libRs.slice(
      libRs.indexOf('fn pty_start'),
      libRs.indexOf('#[tauri::command]', libRs.indexOf('fn pty_start') + 1),
    );
    expect(ptyStart).toContain('resolve_pty_cwd(');
    expect(ptyStart).toContain('projectRoot is required');
  });

  it('canonicalizes before project deduplication and reports unavailable paths', () => {
    const canonical = functionSource('canonicalProjectPath');
    expect(canonical).toContain('invoke("canonical_project_path"');
    expect(canonical).toContain('Project path is unavailable: ');
    expect(canonical).toContain('return null');

    const addProject = functionSource('addProject');
    const canonicalize = addProject.indexOf('await canonicalProjectPath(rootPath)');
    const deduplicate = addProject.indexOf('state.projects.find');
    expect(canonicalize).toBeGreaterThanOrEqual(0);
    expect(deduplicate).toBeGreaterThan(canonicalize);
  });

  it('canonicalizes saved roots concurrently before restoring projects', () => {
    const boot = functionSource('boot');
    expect(boot).toMatch(/await Promise\.all\s*\(\s*saved\.projects\.map/);
    expect(boot).toContain('sanitizeSavedProject');
    expect(boot).toContain('canonicalProjectPath');
    expect(boot).toMatch(/selectedWorktreePath\s*===\s*previousRoot/);
    expect(boot).toMatch(/\.filter\s*\(\s*Boolean\s*\)\.slice/);

    const canonicalize = boot.indexOf('canonicalProjectPath');
    const discover = boot.indexOf('refreshProjectWorktrees');
    expect(canonicalize).toBeGreaterThanOrEqual(0);
    expect(discover).toBeGreaterThan(canonicalize);
  });
});
