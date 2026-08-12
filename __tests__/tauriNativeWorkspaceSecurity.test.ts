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

  test('acquires workspace locks before inspecting recovery artifacts', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const load = functionBody(source, 'load_workspace_from_inner');
    const save = functionBody(source, 'save_workspace_to_inner');

    expect(load.indexOf('WorkspaceFileLock::shared')).toBeLessThan(
      load.indexOf('validate_workspace_artifact_paths'),
    );
    expect(save.indexOf('WorkspaceFileLock::exclusive')).toBeLessThan(
      save.indexOf('validate_workspace_artifact_paths'),
    );
  });

  test('validates the complete workspace before filesystem mutation', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const save = functionBody(source, 'save_workspace_to_inner');

    const validation = save.indexOf('validate_workspace(value)');
    expect(validation).toBeGreaterThanOrEqual(0);
    for (const mutation of [
      'SecureWorkspaceDir::prepare_for_save',
      'WorkspaceFileLock::exclusive',
      'recover_pending_rollback_state',
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

  test('keeps distinct publication fault boundaries around the final temp inode check', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const save = functionBody(source, 'save_workspace_to_inner');
    const publish = functionBody(source, 'publish_opened_workspace_file');

    const tempSync = save.indexOf('.sync_all()');
    const publication = save.indexOf('publish_opened_workspace_file');
    const prevalidationHook = publish.indexOf('before_publication(source)');
    const revalidation = publish.indexOf('verify_opened_regular_file');
    const postvalidationHook = publish.indexOf('run_post_verification_pre_rename_fault(source)');
    const rename = publish.indexOf('rename(workspace_dir, source, destination)');
    const installedValidation = publish.indexOf('verify_opened_regular_file', revalidation + 1);

    expect(tempSync).toBeGreaterThanOrEqual(0);
    expect(publication).toBeGreaterThan(tempSync);
    expect(prevalidationHook).toBeGreaterThanOrEqual(0);
    expect(prevalidationHook).toBeLessThan(revalidation);
    expect(postvalidationHook).toBeGreaterThan(revalidation);
    expect(rename).toBeGreaterThan(postvalidationHook);
    expect(installedValidation).toBeGreaterThan(rename);
    expect(save.slice(tempSync, publication)).not.toContain('drop(temp_file)');
    expect(publish.slice(revalidation, rename)).not.toContain('regular_file_exists');
  });

  test('pins rollback restore candidates across the exact check-to-rename window', async () => {
    const source = await readFile(sourcePath, 'utf8');

    expect(source).toContain('run_post_restore_verification_pre_rename_fault');
    const restore = functionBody(source, 'restore_workspace_backup_in');
    const publish = functionBody(source, 'publish_opened_restore_candidate');
    const finalCheck = publish.indexOf('verify_opened_workspace_artifact');
    const exactWindowHook = publish.indexOf(
      'run_post_restore_verification_pre_rename_fault(source)',
    );
    const rename = publish.indexOf('rename(workspace_dir, source, destination)');
    const installedCheck = publish.indexOf(
      'verify_opened_workspace_artifact',
      finalCheck + 1,
    );

    expect(restore).toContain('publish_opened_restore_candidate');
    expect(restore).toContain('read_workspace_restore_source_bytes');
    expect(restore).toContain('create_restore_candidate_from_bytes');
    expect(finalCheck).toBeGreaterThanOrEqual(0);
    expect(exactWindowHook).toBeGreaterThan(finalCheck);
    expect(rename).toBeGreaterThan(exactWindowHook);
    expect(installedCheck).toBeGreaterThan(rename);
    expect(publish.slice(finalCheck, rename)).not.toContain('regular_file_exists');
  });

  test('requires directory durability before initial forward certification succeeds', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const commit = functionBody(source, 'commit_initial_workspace_forward');
    const finish = functionBody(source, 'finish_initial_workspace_forward');
    const certify = functionBody(source, 'certify_initial_forward_recovery');

    const commitMarker = commit.indexOf('declare_absent_forward_commit');
    const finishCall = commit.indexOf('finish_initial_workspace_forward');
    const commitDirectorySync = finish.indexOf('sync_parent_directory(workspace_dir, parent)');
    const certifiedMarkerSync = certify.indexOf('marker.sync_all()');
    const certifiedDirectorySync = certify.indexOf('sync_parent_directory(workspace_dir, parent)');

    expect(commitMarker).toBeGreaterThanOrEqual(0);
    expect(finishCall).toBeGreaterThan(commitMarker);
    expect(commitDirectorySync).toBeGreaterThanOrEqual(0);
    expect(certifiedMarkerSync).toBeGreaterThanOrEqual(0);
    expect(certifiedDirectorySync).toBeGreaterThan(certifiedMarkerSync);
  });

  test('revalidates normal initial-save success after its final directory sync', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const finish = functionBody(source, 'finish_initial_workspace_forward');
    const resolve = functionBody(source, 'resolve_initial_workspace_after_marker_failure');

    const directorySync = finish.indexOf('sync_parent_directory(workspace_dir, parent)');
    const postSyncFault = finish.indexOf('run_post_initial_forward_sync_fault');
    const resolution = finish.indexOf('resolve_initial_workspace_after_marker_failure');

    expect(directorySync).toBeGreaterThanOrEqual(0);
    expect(postSyncFault).toBeGreaterThan(directorySync);
    expect(resolution).toBeGreaterThan(postSyncFault);
    expect(resolve).toContain('certify_initial_forward_recovery');
  });

  test('uses durable recovery decisions for API results and restart repair', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const initial = functionBody(source, 'resolve_initial_workspace_after_marker_failure');
    const prior = functionBody(source, 'resolve_prior_workspace_after_commit_failure');
    const resolvePrior = functionBody(source, 'resolve_prior_workspace_durable_decision');
    const restore = functionBody(source, 'restore_workspace_backup_in');
    const startup = functionBody(source, 'certify_prior_committed_recovery');

    expect(source).toContain('enum WorkspaceRecoveryDecision');
    expect(source).not.toContain('observe_prior_workspace_restart_outcome');
    expect(initial).toContain('initial_workspace_recovery_decision');
    expect(initial).toContain('reassert_initial_forward_recovery_decision');
    expect(prior).toContain('resolve_prior_workspace_durable_decision');
    expect(resolvePrior).toContain('prior_workspace_recovery_decision');
    expect(resolvePrior).toContain('certify_prior_workspace_forward');
    expect(resolvePrior).toContain('certify_prior_workspace_rollback');

    const reserve = restore.indexOf('pinned reserve workspace restore candidate');
    const attempts = restore.indexOf('for attempt in 0..2');
    const fallback = restore.lastIndexOf('reserve_file');
    expect(reserve).toBeGreaterThanOrEqual(0);
    expect(reserve).toBeLessThan(attempts);
    expect(fallback).toBeGreaterThan(attempts);
    expect(startup).toContain('restore_workspace_backup_in(workspace_dir, committed_path, path)');
  });
});
