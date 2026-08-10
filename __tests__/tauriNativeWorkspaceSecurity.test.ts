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
    const openLock = functionBody(source, 'open_workspace_lock');

    expect(source).toMatch(/LockMode::Shared\s*=>\s*libc::LOCK_SH/);
    expect(source).toMatch(/LockMode::Exclusive\s*=>\s*libc::LOCK_EX/);
    expect(source).toMatch(/libc::flock\(file\.as_raw_fd\(\),\s*operation\)/);
    expect(source).toMatch(/libc::flock\(self\.file\.as_raw_fd\(\),\s*libc::LOCK_UN\)/);
    expect(openLock).toContain('libc::openat');
    expect(openLock).toContain('workspace_dir.directory.as_raw_fd()');
    expect(openLock).toContain('libc::O_NOFOLLOW');
    expect(openLock).toContain('libc::O_CLOEXEC');
    expect(openLock).toContain('0o600');
  });

  test('validates the complete workspace before filesystem mutation', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const save = functionBody(source, 'save_workspace_to_inner');

    const validation = save.indexOf('validate_workspace(value)');
    expect(validation).toBeGreaterThanOrEqual(0);
    for (const mutation of [
      'SecureWorkspaceDir::prepare_for_save',
      'WorkspaceFileLock::exclusive',
      'recover_pending_workspace',
      'cleanup_rollback_candidates',
      'open_temp_file_in',
    ]) {
      expect(validation).toBeLessThan(save.indexOf(mutation));
    }
  });

  test('pins HOME and traverses app storage with descriptor-relative syscalls', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const prepare = functionBody(source, 'prepare_for_save');
    const component = functionBody(source, 'open_directory_component');

    expect(source).toContain('struct SecureWorkspaceDir');
    expect(prepare).toContain('open_directory_path_no_follow(&home, "HOME")');
    expect(prepare).toContain('open_directory_component');
    expect(source).toContain('libc::fstat(');
    expect(source).toContain('libc::fstatat(');
    expect(source).toContain('libc::AT_SYMLINK_NOFOLLOW');
    expect(source).toContain('libc::O_NOFOLLOW');
    expect(source).toContain('libc::O_DIRECTORY');
    expect(source).toContain('libc::O_CLOEXEC');
    expect(component).toContain('libc::mkdirat');
    expect(component).toContain('libc::openat');
    expect(component).toContain('set_secure_directory_permissions_fd');
    expect(component).toContain('parent.directory.sync_all()');
    expect(component).toContain('directory.sync_all()');
  });

  test('keeps every workspace artifact operation relative to the pinned directory', async () => {
    const source = await readFile(sourcePath, 'utf8');

    expect(functionBody(source, 'open_existing_regular_file')).toContain('libc::openat');
    expect(functionBody(source, 'open_new_workspace_file')).toContain('libc::openat');
    expect(functionBody(source, 'rename_workspace_path_in')).toContain('libc::renameat');
    expect(functionBody(source, 'hard_link_workspace_path')).toContain('libc::linkat');
    expect(functionBody(source, 'unlink_workspace_path')).toContain('libc::unlinkat');
    expect(functionBody(source, 'workspace_directory_entries')).toContain('libc::fdopendir');
  });
});
