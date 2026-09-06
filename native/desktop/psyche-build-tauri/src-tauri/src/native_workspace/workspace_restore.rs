//! Rollback backup creation and workspace restore.
//!
//! Saving a workspace is a transaction: before the new document replaces the
//! old one, the old one is copied to a rollback backup, and if any later step
//! fails the backup is restored. This module owns both halves of that — the
//! backup side (`create_rollback_backup*`, snapshot candidates) and the
//! restore side (`restore_workspace_backup*`, restore candidates and their
//! publication).
//!
//! **It executes restores; it does not decide them.** Nothing here inspects
//! rollback markers to work out which recovery a workspace needs. That
//! reasoning lives in the recovery layer still in the parent, which calls in
//! here once it has decided. Keeping the decision out means these functions
//! can be read as a straight sequence of filesystem steps.
//!
//! **The artifact read and verify helpers stayed behind on purpose.**
//! `read_bounded_workspace_file` and `verify_opened_workspace_artifact` look
//! like members of this set — the dependency closure pulls them in — but they
//! are shared: the load path, the save path and the recovery layer all use
//! them, in one case with ten callers outside this module. They are a layer
//! beneath restore rather than part of it, and moving them here would have
//! named a shared utility after one of its consumers.
//!
//! Six functions are `#[cfg(test)]`: four test doubles and two fault-injection
//! hooks. They carry their gates with them, and the three parent items only
//! they use are imported under a matching `#[cfg(test)]` — a mismatch there is
//! what broke the Windows build in #366.

#[cfg(test)]
use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::Path;

use super::secure_fs::{
    hard_link_workspace_path, open_existing_regular_file, open_new_workspace_file,
    regular_file_exists, rename_workspace_path_in, require_new_regular_file_path,
    verify_opened_regular_file,
};
use super::workspace_paths::{workspace_restore_candidate_path, workspace_rollback_candidate_path};
use super::{
    read_bounded_workspace_file, verify_opened_workspace_artifact, SecureWorkspaceDir,
    TempFileGuard, WORKSPACE_DOCUMENT_SIZE_LIMIT,
};

#[cfg(test)]
use super::{
    RestoreCandidateFileOperation, POST_RESTORE_VERIFICATION_PRE_RENAME_REPLACEMENT,
    TRUSTED_RESTORE_CANDIDATE_FAILURE,
};

#[cfg(test)]
pub(super) fn create_rollback_backup(_path: &Path, _backup_path: &Path) -> Result<(), String> {
    Ok(())
}

pub(super) fn create_rollback_backup_in(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    backup_path: &Path,
) -> Result<(), String> {
    create_rollback_backup_with_in(
        workspace_dir,
        path,
        backup_path,
        hard_link_workspace_path,
        std::io::copy,
    )
}

pub(super) fn read_workspace_restore_source_bytes(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    context: &str,
) -> Result<Vec<u8>, String> {
    let Some(mut file) = open_existing_regular_file(workspace_dir, path, context, false)? else {
        return Err(format!("{context} '{}' is missing", path.display()));
    };
    let metadata = file
        .metadata()
        .map_err(|error| format!("inspect {context} '{}': {}", path.display(), error))?;
    let bytes = read_bounded_workspace_file(&mut file, path, context)?;
    if bytes.len() as u64 != metadata.len() {
        return Err(format!(
            "read {context} '{}' changed length: read {} of {} bytes",
            path.display(),
            bytes.len(),
            metadata.len()
        ));
    }
    verify_opened_regular_file(workspace_dir, &file, path, context)?;
    Ok(bytes)
}

#[cfg(test)]
pub(super) fn create_rollback_backup_with<F, G>(
    path: &Path,
    backup_path: &Path,
    hard_link: F,
    copy_file: G,
) -> Result<(), String>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
    G: FnOnce(&mut File, &mut File) -> std::io::Result<u64>,
{
    let workspace_dir = SecureWorkspaceDir::open_for_load(path)?
        .ok_or_else(|| format!("workspace parent '{}' is missing", path.display()))?;
    create_rollback_backup_with_in(
        &workspace_dir,
        path,
        backup_path,
        |_, source, destination| hard_link(source, destination),
        copy_file,
    )
}

fn create_rollback_backup_with_in<F, G>(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    backup_path: &Path,
    hard_link: F,
    copy_file: G,
) -> Result<(), String>
where
    F: FnOnce(&SecureWorkspaceDir, &Path, &Path) -> std::io::Result<()>,
    G: FnOnce(&mut File, &mut File) -> std::io::Result<u64>,
{
    if !regular_file_exists(workspace_dir, path, "workspace rollback source")? {
        return Err(format!(
            "workspace rollback source '{}' is missing",
            path.display()
        ));
    }
    require_new_regular_file_path(workspace_dir, backup_path, "workspace pending rollback")?;
    let candidate_path = workspace_rollback_candidate_path(backup_path)?;
    let candidate_guard = create_snapshot_candidate_with_in(
        workspace_dir,
        path,
        &candidate_path,
        hard_link,
        copy_file,
    )
    .map_err(|error| {
        format!(
            "create pending rollback '{}' from '{}': {}",
            backup_path.display(),
            path.display(),
            error
        )
    })?;
    hard_link_workspace_path(workspace_dir, &candidate_path, backup_path).map_err(|e| {
        format!(
            "publish rollback candidate '{}' as pending '{}': {}",
            candidate_path.display(),
            backup_path.display(),
            e
        )
    })?;
    if !regular_file_exists(workspace_dir, backup_path, "workspace pending rollback")? {
        return Err(format!(
            "workspace pending rollback '{}' is missing after publication",
            backup_path.display()
        ));
    }
    drop(candidate_guard);
    Ok(())
}

fn create_snapshot_candidate_with_in<'a, F, G>(
    workspace_dir: &'a SecureWorkspaceDir,
    path: &Path,
    candidate_path: &Path,
    hard_link: F,
    copy_file: G,
) -> Result<TempFileGuard<'a>, String>
where
    F: FnOnce(&SecureWorkspaceDir, &Path, &Path) -> std::io::Result<()>,
    G: FnOnce(&mut File, &mut File) -> std::io::Result<u64>,
{
    if !regular_file_exists(workspace_dir, path, "workspace snapshot source")? {
        return Err(format!(
            "workspace snapshot source '{}' is missing",
            path.display()
        ));
    }
    require_new_regular_file_path(
        workspace_dir,
        candidate_path,
        "workspace snapshot candidate",
    )?;
    match hard_link(workspace_dir, path, candidate_path) {
        Ok(()) => {
            let guard = TempFileGuard::new(workspace_dir, candidate_path.to_path_buf());
            let file = open_existing_regular_file(
                workspace_dir,
                candidate_path,
                "workspace snapshot candidate",
                false,
            )?
            .ok_or_else(|| {
                format!(
                    "workspace snapshot candidate '{}' disappeared",
                    candidate_path.display()
                )
            })?;
            file.sync_all().map_err(|e| {
                format!(
                    "sync workspace snapshot candidate '{}': {}",
                    candidate_path.display(),
                    e
                )
            })?;
            return Ok(guard);
        }
        Err(link_error) => copy_snapshot_candidate(workspace_dir, path, candidate_path, copy_file)
            .map_err(|copy_error| format!("{} (hard link failed: {})", copy_error, link_error)),
    }
}

fn copy_snapshot_candidate<'a, G>(
    workspace_dir: &'a SecureWorkspaceDir,
    path: &Path,
    candidate_path: &Path,
    copy_file: G,
) -> Result<TempFileGuard<'a>, String>
where
    G: FnOnce(&mut File, &mut File) -> std::io::Result<u64>,
{
    let mut source = open_existing_regular_file(workspace_dir, path, "rollback source", false)?
        .ok_or_else(|| format!("rollback source '{}' is missing", path.display()))?;
    let metadata = source
        .metadata()
        .map_err(|e| format!("inspect rollback source '{}': {}", path.display(), e))?;
    if metadata.len() > WORKSPACE_DOCUMENT_SIZE_LIMIT {
        return Err(format!(
            "workspace '{}' is too large for rollback copy: {} bytes (limit {})",
            path.display(),
            metadata.len(),
            WORKSPACE_DOCUMENT_SIZE_LIMIT
        ));
    }
    let mut candidate =
        open_new_workspace_file(workspace_dir, candidate_path, "snapshot candidate")?;
    let candidate_guard = TempFileGuard::new(workspace_dir, candidate_path.to_path_buf());
    let copy_result = (|| -> Result<(), String> {
        let copied = copy_file(&mut source, &mut candidate).map_err(|e| {
            format!(
                "copy workspace snapshot candidate '{}': {}",
                candidate_path.display(),
                e
            )
        })?;
        if copied != metadata.len() {
            return Err(format!(
                "copy workspace snapshot candidate '{}' truncated: copied {} of {} bytes",
                candidate_path.display(),
                copied,
                metadata.len()
            ));
        }
        candidate.sync_all().map_err(|e| {
            format!(
                "sync workspace snapshot candidate '{}': {}",
                candidate_path.display(),
                e
            )
        })
    })();
    drop(candidate);
    copy_result?;
    Ok(candidate_guard)
}

#[cfg(test)]
pub(super) fn restore_workspace_backup_standalone(
    backup_path: &Path,
    path: &Path,
) -> Result<(), String> {
    let workspace_dir = SecureWorkspaceDir::open_for_load(path)?
        .ok_or_else(|| format!("workspace parent '{}' is missing", path.display()))?;
    restore_workspace_backup_in(&workspace_dir, backup_path, path)
}

#[cfg(test)]
pub(super) fn restore_workspace_backup(_backup_path: &Path, _path: &Path) -> Result<(), String> {
    Ok(())
}

pub(super) fn restore_workspace_backup_in(
    workspace_dir: &SecureWorkspaceDir,
    backup_path: &Path,
    path: &Path,
) -> Result<(), String> {
    let expected_bytes = read_workspace_restore_source_bytes(
        workspace_dir,
        backup_path,
        "workspace rollback backup",
    )?;
    regular_file_exists(workspace_dir, path, "workspace")?;
    // Retain a separately pinned prior inode until a verified restore has been published.
    let reserve_path = workspace_restore_candidate_path(path)?;
    let mut reserve_guard = create_snapshot_candidate_with_in(
        workspace_dir,
        backup_path,
        &reserve_path,
        hard_link_workspace_path,
        std::io::copy,
    )
    .map_err(|error| {
        format!(
            "create pinned reserve workspace restore candidate '{}' from '{}': {}",
            reserve_path.display(),
            backup_path.display(),
            error
        )
    })?;
    let reserve_file = open_existing_regular_file(
        workspace_dir,
        &reserve_path,
        "pinned reserve workspace restore candidate",
        false,
    )?
    .ok_or_else(|| {
        format!(
            "pinned reserve workspace restore candidate '{}' disappeared",
            reserve_path.display()
        )
    })?;
    verify_opened_workspace_artifact(
        workspace_dir,
        &reserve_file,
        &reserve_path,
        &expected_bytes,
        "pinned reserve workspace restore candidate",
    )?;

    let mut failures = Vec::new();
    for attempt in 0..2 {
        let candidate_path = workspace_restore_candidate_path(path)?;
        let candidate = if attempt == 0 {
            create_snapshot_candidate_with_in(
                workspace_dir,
                backup_path,
                &candidate_path,
                hard_link_workspace_path,
                std::io::copy,
            )
        } else {
            create_restore_candidate_from_bytes(workspace_dir, &candidate_path, &expected_bytes)
        };
        let mut candidate_guard = match candidate {
            Ok(candidate) => candidate,
            Err(error) => {
                failures.push(error);
                continue;
            }
        };
        let candidate_file = match open_existing_regular_file(
            workspace_dir,
            &candidate_path,
            "workspace restore candidate",
            false,
        ) {
            Ok(Some(file)) => file,
            Ok(None) => {
                failures.push(format!(
                    "workspace restore candidate '{}' disappeared",
                    candidate_path.display()
                ));
                continue;
            }
            Err(error) => {
                failures.push(error);
                continue;
            }
        };
        match publish_opened_restore_candidate(
            workspace_dir,
            &candidate_file,
            &expected_bytes,
            &candidate_path,
            path,
            &mut |workspace_dir, source, destination| {
                rename_workspace_path_in(workspace_dir, source, destination).map_err(|e| {
                    format!(
                        "restore workspace from rollback '{}' to '{}': {}",
                        backup_path.display(),
                        path.display(),
                        e
                    )
                })
            },
        ) {
            Ok(()) => {
                candidate_guard.commit();
                return Ok(());
            }
            Err(error) => failures.push(error),
        }
    }

    match publish_opened_restore_candidate(
        workspace_dir,
        &reserve_file,
        &expected_bytes,
        &reserve_path,
        path,
        &mut |workspace_dir, source, destination| {
            rename_workspace_path_in(workspace_dir, source, destination).map_err(|e| {
                format!(
                    "restore workspace from pinned rollback reserve '{}' to '{}': {}",
                    backup_path.display(),
                    path.display(),
                    e
                )
            })
        },
    ) {
        Ok(()) => {
            reserve_guard.commit();
            Ok(())
        }
        Err(error) => {
            failures.push(error);
            Err(format!(
                "restore exact workspace bytes from rollback '{}' failed after bounded pinned publication: {}",
                backup_path.display(),
                failures.join("; ")
            ))
        }
    }
}

fn create_restore_candidate_from_bytes<'a>(
    workspace_dir: &'a SecureWorkspaceDir,
    candidate_path: &Path,
    expected_bytes: &[u8],
) -> Result<TempFileGuard<'a>, String> {
    let mut candidate =
        open_new_workspace_file(workspace_dir, candidate_path, "restore candidate")?;
    let candidate_guard = TempFileGuard::new(workspace_dir, candidate_path.to_path_buf());
    #[cfg(test)]
    run_trusted_restore_candidate_fault(RestoreCandidateFileOperation::Write, candidate_path)?;
    candidate.write_all(expected_bytes).map_err(|error| {
        format!(
            "write trusted workspace restore candidate '{}': {}",
            candidate_path.display(),
            error
        )
    })?;
    candidate.flush().map_err(|error| {
        format!(
            "flush trusted workspace restore candidate '{}': {}",
            candidate_path.display(),
            error
        )
    })?;
    #[cfg(test)]
    run_trusted_restore_candidate_fault(RestoreCandidateFileOperation::Sync, candidate_path)?;
    candidate.sync_all().map_err(|error| {
        format!(
            "sync trusted workspace restore candidate '{}': {}",
            candidate_path.display(),
            error
        )
    })?;
    Ok(candidate_guard)
}

fn publish_opened_restore_candidate(
    workspace_dir: &SecureWorkspaceDir,
    source_file: &File,
    expected_bytes: &[u8],
    source: &Path,
    destination: &Path,
    rename: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if !regular_file_exists(workspace_dir, source, "workspace restore candidate")? {
        return Err(format!(
            "workspace restore candidate '{}' is missing",
            source.display()
        ));
    }
    regular_file_exists(workspace_dir, destination, "workspace")?;
    verify_opened_workspace_artifact(
        workspace_dir,
        source_file,
        source,
        expected_bytes,
        "workspace restore candidate",
    )?;
    #[cfg(test)]
    run_post_restore_verification_pre_rename_fault(source)?;
    rename(workspace_dir, source, destination)?;
    verify_opened_workspace_artifact(
        workspace_dir,
        source_file,
        destination,
        expected_bytes,
        "workspace restore candidate",
    )
    .map_err(|error| {
        format!(
            "verify restored workspace '{}': {}",
            destination.display(),
            error
        )
    })
}

#[cfg(test)]
fn run_post_restore_verification_pre_rename_fault(path: &Path) -> Result<(), String> {
    POST_RESTORE_VERIFICATION_PRE_RENAME_REPLACEMENT.with(|replacement| {
        let Some(replacement) = replacement.borrow_mut().take() else {
            return Ok(());
        };
        fs::remove_file(path).map_err(|error| error.to_string())?;
        fs::write(path, replacement).map_err(|error| error.to_string())
    })
}

#[cfg(test)]
fn run_trusted_restore_candidate_fault(
    operation: RestoreCandidateFileOperation,
    path: &Path,
) -> Result<(), String> {
    TRUSTED_RESTORE_CANDIDATE_FAILURE.with(|fault| {
        let mut fault = fault.borrow_mut();
        if *fault != Some(operation) {
            return Ok(());
        }
        *fault = None;
        Err(format!(
            "injected trusted restore candidate {operation:?} failure '{}'",
            path.display()
        ))
    })
}
