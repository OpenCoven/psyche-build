import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const sourcePath = resolve(
  process.cwd(),
  'native/macos/psyche-build-tauri/src-tauri/src/native_workspace.rs',
);

function functionBody(source: string, name: string): string {
  const signature = new RegExp(`\\bfn\\s+${name}(?:<[^>]*>)?\\s*\\(`).exec(source);
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

describe('Tauri native workspace security contract', () => {
  test('checks the injected caller webview before workspace I/O', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const load = functionBody(source, 'workspace_load');
    const save = functionBody(source, 'workspace_save');
    const guard = functionBody(source, 'ensure_trusted_workspace_caller');

    expect(load).toMatch(/webview\s*:\s*tauri::Webview/);
    expect(save).toMatch(/webview\s*:\s*tauri::Webview/);
    for (const command of [load, save]) {
      expect(command).toMatch(/ensure_trusted_workspace_caller\(webview\.label\(\)\)\?/);
      expect(command.indexOf('ensure_trusted_workspace_caller')).toBeLessThan(
        command.indexOf('workspace_default_path'),
      );
    }
    expect(guard).toMatch(/label\s*==\s*"main"/);
    expect(guard).toContain("rejected caller '{label}'");
  });

  test('holds shared and exclusive OS locks with explicit unlock', async () => {
    const source = await readFile(sourcePath, 'utf8');

    expect(source).toMatch(/LockMode::Shared\s*=>\s*libc::LOCK_SH/);
    expect(source).toMatch(/LockMode::Exclusive\s*=>\s*libc::LOCK_EX/);
    expect(source).toMatch(/libc::flock\(file\.as_raw_fd\(\),\s*operation\)/);
    expect(source).toMatch(/libc::flock\(self\.file\.as_raw_fd\(\),\s*libc::LOCK_UN\)/);
    expect(source).toMatch(/options\.mode\(0o600\)/);
  });

  test('validates the complete workspace before filesystem mutation', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const save = functionBody(source, 'save_workspace_to_inner');

    const validation = save.indexOf('validate_workspace(value)');
    expect(validation).toBeGreaterThanOrEqual(0);
    for (const mutation of [
      'prepare_workspace_parent',
      'WorkspaceFileLock::exclusive',
      'recover_pending_workspace',
      'cleanup_rollback_candidates',
      'open_temp_file',
    ]) {
      expect(validation).toBeLessThan(save.indexOf(mutation));
    }
  });

  test('uses no-follow file opens and one-level durable directory creation', async () => {
    const source = await readFile(sourcePath, 'utf8');

    expect(source).toContain('fs::symlink_metadata');
    expect(source).toContain('libc::O_NOFOLLOW');
    expect(source).toContain('libc::O_DIRECTORY');
    expect(source).toMatch(/create_new\(true\)/);
    expect(source).toContain('libc::fchmod');
    expect(source).toMatch(/fs::create_dir\(/);
    expect(source).toMatch(/builder\.recursive\(false\)\.mode\(0o700\)\.create\(path\)/);
    expect(source).not.toMatch(/fs::create_dir_all\(parent\)/);
  });
});
