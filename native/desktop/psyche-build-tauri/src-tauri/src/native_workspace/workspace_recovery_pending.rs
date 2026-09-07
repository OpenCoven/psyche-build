//! Deciding which recovery a workspace needs, and running it.
//!
//! The entry point to the recovery layer. `recover_pending_rollback_state`
//! runs before any save or load touches the workspace: it reads the rollback
//! markers left on disk, works out what a previous transaction had got as far
//! as, and dispatches to the half that can finish or undo it.
//!
//! That is why it sits in its own module rather than in either half. It is
//! entered from three unrelated places — the load path, the save path, and the
//! rollback that follows a failed save — and it calls into both
//! `workspace_recovery_initial` and `workspace_recovery_prior`, which have no
//! call edges to each other. Putting it in either would make that half the
//! apparent owner of a decision that precedes the distinction it turns on.
//!
//! `ensure_forward_workspace` and `restore_prior_workspace_state` stayed in
//! the parent. They look like recovery helpers and are called from here, but
//! `commit_initial_workspace_forward` and `rollback_workspace_after_failed_save`
//! call them too, so they are shared with the save path rather than owned by
//! recovery.

use std::path::Path;

use super::secure_fs::regular_file_exists;
use super::workspace_absent_marker::absent_rollback_resolution;
use super::workspace_artifact_sweep::cleanup_committed_rollback;
use super::workspace_publish::mark_rollback_committed;
use super::workspace_recovery_initial::{
    recover_ambiguous_initial_workspace, recover_workspace_from_forward_candidate,
};
use super::workspace_recovery_prior::certify_prior_committed_recovery;
use super::{
    ensure_forward_workspace, restore_prior_workspace_state, AbsentRollbackInterpretation,
    AbsentRollbackResolution, SecureWorkspaceDir,
};

pub(super) fn recover_pending_rollback_state(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    absent_pending_path: &Path,
    absent_committed_path: &Path,
    forward_path: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    rename_workspace_path: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let has_pending =
        regular_file_exists(workspace_dir, pending_path, "workspace pending rollback")?;
    let has_absent_pending = regular_file_exists(
        workspace_dir,
        absent_pending_path,
        "workspace absent pending rollback",
    )?;
    let has_committed = regular_file_exists(
        workspace_dir,
        committed_path,
        "workspace committed rollback",
    )?;
    let has_forward =
        regular_file_exists(workspace_dir, forward_path, "workspace forward rollback")?;
    if has_pending && has_absent_pending {
        return Err(format!(
            "workspace has conflicting pending rollback states at '{}' and '{}'",
            pending_path.display(),
            absent_pending_path.display()
        ));
    }
    if has_pending {
        recover_pending_workspace(
            workspace_dir,
            path,
            parent,
            pending_path,
            committed_path,
            sync_parent_directory,
            restore_workspace_backup,
            rename_workspace_path,
        )?;
    } else {
        match absent_rollback_resolution(workspace_dir, absent_pending_path, absent_committed_path)?
        {
            AbsentRollbackInterpretation::Resolved(AbsentRollbackResolution::Rollback) => {
                if has_absent_pending {
                    recover_pending_workspace(
                        workspace_dir,
                        path,
                        parent,
                        absent_pending_path,
                        absent_committed_path,
                        sync_parent_directory,
                        restore_workspace_backup,
                        rename_workspace_path,
                    )?;
                } else {
                    restore_prior_workspace_state(
                        workspace_dir,
                        absent_committed_path,
                        path,
                        restore_workspace_backup,
                    )?;
                    sync_parent_directory(workspace_dir, parent).map_err(|error| {
                        format!(
                            "sync restored absent workspace '{}': {}; committed rollback retained at '{}'",
                            path.display(),
                            error,
                            absent_committed_path.display()
                        )
                    })?;
                }
            }
            AbsentRollbackInterpretation::Resolved(AbsentRollbackResolution::Forward {
                require_candidate,
            }) => {
                if require_candidate || has_forward {
                    recover_workspace_from_forward_candidate(
                        workspace_dir,
                        path,
                        parent,
                        forward_path,
                        sync_parent_directory,
                    )?;
                } else {
                    ensure_forward_workspace(workspace_dir, path, forward_path, false)?;
                    sync_parent_directory(workspace_dir, parent).map_err(|error| {
                        format!(
                            "sync forward workspace '{}': {}; forward recovery retained at '{}'",
                            path.display(),
                            error,
                            forward_path.display()
                        )
                    })?;
                }
                if has_absent_pending {
                    cleanup_committed_rollback(
                        workspace_dir,
                        absent_pending_path,
                        parent,
                        sync_parent_directory,
                    )?;
                }
            }
            AbsentRollbackInterpretation::Ambiguous => {
                recover_ambiguous_initial_workspace(
                    workspace_dir,
                    path,
                    parent,
                    absent_pending_path,
                    absent_committed_path,
                    forward_path,
                    sync_parent_directory,
                )?;
            }
            AbsentRollbackInterpretation::Missing if has_committed && has_forward => {
                certify_prior_committed_recovery(
                    workspace_dir,
                    path,
                    parent,
                    committed_path,
                    forward_path,
                    sync_parent_directory,
                )?;
            }
            AbsentRollbackInterpretation::Missing => {}
        }
    }
    Ok(())
}

pub(super) fn recover_pending_workspace(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    rename_workspace_path: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    restore_prior_workspace_state(
        workspace_dir,
        pending_path,
        path,
        restore_workspace_backup,
    )
    .map_err(|error| {
        format!(
            "restore pending workspace rollback '{}' to '{}': {}; pending rollback retained at '{}'",
            pending_path.display(),
            path.display(),
            error,
            pending_path.display()
        )
    })?;
    sync_parent_directory(workspace_dir, parent).map_err(|error| {
        format!(
            "sync restored workspace '{}': {}; pending rollback retained at '{}'",
            path.display(),
            error,
            pending_path.display()
        )
    })?;
    if regular_file_exists(
        workspace_dir,
        committed_path,
        "workspace committed rollback",
    )? {
        cleanup_committed_rollback(
            workspace_dir,
            committed_path,
            parent,
            sync_parent_directory,
        )
        .map_err(|error| {
            format!(
                "clean committed rollback '{}' before pending recovery: {}; pending rollback retained at '{}'",
                committed_path.display(),
                error,
                pending_path.display()
            )
        })?;
    }
    mark_rollback_committed(
        workspace_dir,
        path,
        pending_path,
        committed_path,
        parent,
        sync_parent_directory,
        restore_workspace_backup,
        rename_workspace_path,
    )
}
