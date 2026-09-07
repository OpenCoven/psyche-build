//! Keeping the workspace directory's transaction artifacts safe and tidy.
//!
//! Two jobs. `validate_workspace_artifact_paths` checks the *type* of every
//! name a save will touch, and the `cleanup_*` functions remove what a
//! previous transaction left behind. Between them sits
//! `rollback_candidate_paths`, which enumerates candidates by prefix because
//! their names carry a pid and counter and so cannot be derived.
//!
//! Read `validate_workspace_artifact_paths` carefully: it does **not** require
//! those names to be free. It calls `regular_file_exists` and discards the
//! boolean, so a name that is already a regular file passes. What it rejects
//! is a name that exists as something else — a symlink, a directory, a fifo.
//! It is a type-confusion defence run before the save touches anything, not a
//! precondition that the directory be clean, and a pre-existing lock or
//! rollback marker is expected rather than fatal.
//!
//! Three of these were measured into step 2 and deliberately left out of
//! `workspace_paths`: they consult the filesystem through `secure_fs` and take
//! a `SecureWorkspaceDir`, so moving them there would have cost that module
//! the no-I/O property that makes its boundary checkable. This is where they
//! belong instead.
//!
//! `sync_parent_directory` is a closure parameter here, not the free function
//! of the same name in the parent. That distinction is load-bearing: importing
//! the free function would bind a different item under a different `cfg`.

use std::path::{Path, PathBuf};

use super::secure_fs::{regular_file_exists, unlink_workspace_path, workspace_directory_entries};
use super::workspace_paths::{
    workspace_absent_rollback_committed_path, workspace_absent_rollback_pending_path,
    workspace_forward_rollback_path, workspace_lock_path, workspace_rollback_candidate_prefix,
    workspace_rollback_committed_path, workspace_rollback_pending_path,
};
use super::SecureWorkspaceDir;

pub(super) fn validate_workspace_artifact_paths(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    parent: &Path,
    file_name: &str,
) -> Result<(), String> {
    regular_file_exists(workspace_dir, path, "workspace")?;
    regular_file_exists(
        workspace_dir,
        &workspace_lock_path(parent, file_name),
        "workspace lock",
    )?;
    regular_file_exists(
        workspace_dir,
        &workspace_rollback_pending_path(parent, file_name),
        "workspace pending rollback",
    )?;
    regular_file_exists(
        workspace_dir,
        &workspace_rollback_committed_path(parent, file_name),
        "workspace committed rollback",
    )?;
    regular_file_exists(
        workspace_dir,
        &workspace_absent_rollback_pending_path(parent, file_name),
        "workspace absent pending rollback",
    )?;
    regular_file_exists(
        workspace_dir,
        &workspace_absent_rollback_committed_path(parent, file_name),
        "workspace absent committed rollback",
    )?;
    regular_file_exists(
        workspace_dir,
        &workspace_forward_rollback_path(parent, file_name),
        "workspace forward rollback",
    )?;
    validate_rollback_candidates(workspace_dir, parent, file_name)?;
    Ok(())
}

pub(super) fn cleanup_rollback_candidates(
    workspace_dir: &SecureWorkspaceDir,
    parent: &Path,
    file_name: &str,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let mut removed = false;
    for candidate in rollback_candidate_paths(workspace_dir, parent, file_name)? {
        unlink_workspace_path(workspace_dir, &candidate, "workspace rollback candidate").map_err(
            |error| {
                format!(
                    "remove workspace rollback candidate '{}': {}",
                    candidate.display(),
                    error
                )
            },
        )?;
        removed = true;
    }
    if removed {
        sync_parent_directory(workspace_dir, parent).map_err(|error| {
            format!(
                "sync removal of workspace rollback candidates in '{}': {}",
                parent.display(),
                error
            )
        })?;
    }
    Ok(())
}

pub(super) fn rollback_candidates_exist(
    workspace_dir: &SecureWorkspaceDir,
    parent: &Path,
    file_name: &str,
) -> Result<bool, String> {
    Ok(!rollback_candidate_paths(workspace_dir, parent, file_name)?.is_empty())
}

fn validate_rollback_candidates(
    workspace_dir: &SecureWorkspaceDir,
    parent: &Path,
    file_name: &str,
) -> Result<(), String> {
    rollback_candidate_paths(workspace_dir, parent, file_name).map(|_| ())
}

fn rollback_candidate_paths(
    workspace_dir: &SecureWorkspaceDir,
    parent: &Path,
    file_name: &str,
) -> Result<Vec<PathBuf>, String> {
    let prefix = workspace_rollback_candidate_prefix(file_name);
    let mut candidates = Vec::new();
    for name in workspace_directory_entries(workspace_dir, parent)? {
        if !name.to_string_lossy().starts_with(prefix.as_str()) {
            continue;
        }
        let candidate = parent.join(name);
        if !regular_file_exists(workspace_dir, &candidate, "workspace rollback candidate")? {
            return Err(format!(
                "workspace rollback candidate '{}' disappeared",
                candidate.display()
            ));
        }
        candidates.push(candidate);
    }
    Ok(candidates)
}

pub(super) fn cleanup_committed_rollback(
    workspace_dir: &SecureWorkspaceDir,
    committed_path: &Path,
    parent: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    cleanup_rollback_artifact(
        workspace_dir,
        committed_path,
        parent,
        "workspace committed rollback",
        "committed workspace rollback",
        sync_parent_directory,
    )
}

pub(super) fn cleanup_absent_pending_rollback(
    workspace_dir: &SecureWorkspaceDir,
    pending_path: &Path,
    parent: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    cleanup_rollback_artifact(
        workspace_dir,
        pending_path,
        parent,
        "workspace absent pending rollback",
        "absent pending workspace rollback",
        sync_parent_directory,
    )
}

fn cleanup_rollback_artifact(
    workspace_dir: &SecureWorkspaceDir,
    artifact_path: &Path,
    parent: &Path,
    context: &str,
    description: &str,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if !regular_file_exists(workspace_dir, artifact_path, context)? {
        return Ok(());
    }
    unlink_workspace_path(workspace_dir, artifact_path, context).map_err(|error| {
        format!(
            "remove {description} '{}': {}",
            artifact_path.display(),
            error
        )
    })?;
    sync_parent_directory(workspace_dir, parent).map_err(|error| {
        format!(
            "sync removal of {description} '{}': {}",
            artifact_path.display(),
            error
        )
    })?;
    Ok(())
}

pub(super) fn cleanup_forward_rollback(
    workspace_dir: &SecureWorkspaceDir,
    forward_path: &Path,
    parent: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if !regular_file_exists(workspace_dir, forward_path, "workspace forward rollback")? {
        return Ok(());
    }
    unlink_workspace_path(workspace_dir, forward_path, "workspace forward rollback").map_err(
        |error| {
            format!(
                "remove workspace forward rollback '{}': {}",
                forward_path.display(),
                error
            )
        },
    )?;
    sync_parent_directory(workspace_dir, parent).map_err(|error| {
        format!(
            "sync removal of workspace forward rollback '{}': {}",
            forward_path.display(),
            error
        )
    })
}
