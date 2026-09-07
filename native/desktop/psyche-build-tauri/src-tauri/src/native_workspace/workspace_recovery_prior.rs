//! Recovering a workspace that already existed before the save.
//!
//! One half of the recovery layer. When a save fails partway through and a
//! prior workspace was present, there are bytes to put back, and these eight
//! functions decide whether to put them back or to let the new document stand.
//!
//! The `certify_*` functions each answer one question about what is on disk —
//! is the pending rollback intact, did the forward commit land, does the
//! remaining marker still describe the prior file — and the `resolve_*` and
//! `*_decision` functions choose an action from those answers.
//!
//! **It calls no function that stays in the parent.** Everything it invokes is
//! either in this module or in a sibling child module, and the three items it
//! borrows from the parent — `SecureWorkspaceDir`,
//! `WorkspaceRecoveryDecision`, `WORKSPACE_RECOVERY_DECISION_ATTEMPTS` — are a
//! type, an enum and a constant, not behaviour. Nothing here reaches back into
//! the save path, which matters because a recovery decision that re-entered
//! the transaction it is recovering from would be very hard to reason about.
//!
//! The other half, initial-workspace recovery, has no call edges to or from
//! this module at all. The two are entered from
//! `finish_prior_workspace_transaction` and
//! `finish_initial_workspace_transaction` respectively, so the `had_workspace`
//! branch that #372 gave a name at the transaction level is the same seam that
//! separates these files.

use std::fs::File;
use std::path::Path;

use super::secure_fs::{regular_file_exists, unlink_workspace_path};
use super::workspace_artifact_io::{
    read_workspace_artifact_bytes, validate_workspace_artifact_bytes,
    verify_opened_workspace_artifact, verify_workspace_artifact_bytes,
};
use super::workspace_restore::{read_workspace_restore_source_bytes, restore_workspace_backup_in};
use super::{SecureWorkspaceDir, WorkspaceRecoveryDecision, WORKSPACE_RECOVERY_DECISION_ATTEMPTS};

pub(super) fn resolve_prior_workspace_after_commit_failure(
    workspace_dir: &SecureWorkspaceDir,
    source_file: &File,
    expected_bytes: &[u8],
    prior_bytes: &[u8],
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    forward_path: &Path,
    failure: String,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    recreate_pending_rollback: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let pending_error = match certify_prior_pending_recovery(
        workspace_dir,
        prior_bytes,
        parent,
        pending_path,
        sync_parent_directory,
    ) {
        Ok(()) => return Err(failure),
        Err(error) => error,
    };

    let rollback_error = match certify_prior_workspace_rollback(
        workspace_dir,
        prior_bytes,
        path,
        parent,
        pending_path,
        committed_path,
        sync_parent_directory,
        restore_workspace_backup,
        recreate_pending_rollback,
    ) {
        Ok(()) => return Err(failure),
        Err(error) => error,
    };

    let forward_error = match certify_prior_workspace_forward(
        workspace_dir,
        source_file,
        expected_bytes,
        path,
        parent,
        pending_path,
        committed_path,
        forward_path,
        true,
        sync_parent_directory,
    ) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };

    let final_rollback_error = match certify_prior_workspace_rollback(
        workspace_dir,
        prior_bytes,
        path,
        parent,
        pending_path,
        committed_path,
        sync_parent_directory,
        restore_workspace_backup,
        recreate_pending_rollback,
    ) {
        Ok(()) => {
            return Err(format!(
                "{failure}; pending recovery certification failed: {pending_error}; \
                 initial rollback certification failed: {rollback_error}; \
                 forward certification failed: {forward_error}"
            ))
        }
        Err(error) => error,
    };

    match certify_prior_workspace_from_remaining_rollback(
        workspace_dir,
        prior_bytes,
        path,
        parent,
        pending_path,
        committed_path,
        sync_parent_directory,
        restore_workspace_backup,
    ) {
        Ok(()) => Err(format!(
            "{failure}; pending recovery certification failed: {pending_error}; \
             initial rollback certification failed: {rollback_error}; \
             forward certification failed: {forward_error}; \
             final rollback certification failed: {final_rollback_error}"
        )),
        Err(remaining_rollback_error) => {
            let resolution_failure = format!(
                "{failure}; pending recovery certification failed: {pending_error}; \
                 initial rollback certification failed: {rollback_error}; \
                 forward certification failed: {forward_error}; \
                 final rollback certification failed: {final_rollback_error}; \
                 remaining rollback resolution failed: {remaining_rollback_error}"
            );
            resolve_prior_workspace_durable_decision(
                workspace_dir,
                source_file,
                expected_bytes,
                prior_bytes,
                path,
                parent,
                pending_path,
                committed_path,
                forward_path,
                resolution_failure,
                sync_parent_directory,
                restore_workspace_backup,
                recreate_pending_rollback,
            )
        }
    }
}

fn certify_prior_workspace_from_remaining_rollback(
    workspace_dir: &SecureWorkspaceDir,
    prior_bytes: &[u8],
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let mut failures = Vec::new();
    for (recovery_path, context) in [
        (pending_path, "workspace pending rollback"),
        (committed_path, "workspace committed rollback"),
    ] {
        match regular_file_exists(workspace_dir, recovery_path, context) {
            Ok(false) => {
                failures.push(format!(
                    "{context} '{}' is missing",
                    recovery_path.display()
                ));
                continue;
            }
            Err(error) => {
                failures.push(error);
                continue;
            }
            Ok(true) => {}
        }
        if let Err(error) =
            verify_workspace_artifact_bytes(workspace_dir, recovery_path, prior_bytes, context)
        {
            failures.push(error);
            continue;
        }
        if let Err(error) = restore_workspace_backup(workspace_dir, recovery_path, path) {
            failures.push(format!(
                "restore prior workspace '{}' from remaining {context} '{}': {}",
                path.display(),
                recovery_path.display(),
                error
            ));
            continue;
        }
        if let Err(error) = sync_parent_directory(workspace_dir, parent) {
            failures.push(format!(
                "sync prior workspace '{}' restored from remaining {context} '{}': {}",
                path.display(),
                recovery_path.display(),
                error
            ));
            continue;
        }
        if let Err(error) =
            verify_workspace_artifact_bytes(workspace_dir, recovery_path, prior_bytes, context)
        {
            failures.push(error);
            continue;
        }
        if let Err(error) =
            verify_workspace_artifact_bytes(workspace_dir, path, prior_bytes, "workspace")
        {
            failures.push(error);
            continue;
        }
        return Ok(());
    }
    Err(failures.join("; "))
}

fn resolve_prior_workspace_durable_decision(
    workspace_dir: &SecureWorkspaceDir,
    source_file: &File,
    expected_bytes: &[u8],
    prior_bytes: &[u8],
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    forward_path: &Path,
    failure: String,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    recreate_pending_rollback: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let mut failures = vec![failure];
    for _ in 0..WORKSPACE_RECOVERY_DECISION_ATTEMPTS {
        match prior_workspace_recovery_decision(
            workspace_dir,
            source_file,
            expected_bytes,
            prior_bytes,
            pending_path,
            committed_path,
            forward_path,
        )? {
            Some(WorkspaceRecoveryDecision::Forward) => {
                match certify_prior_workspace_forward(
                    workspace_dir,
                    source_file,
                    expected_bytes,
                    path,
                    parent,
                    pending_path,
                    committed_path,
                    forward_path,
                    true,
                    sync_parent_directory,
                ) {
                    Ok(()) => return Ok(()),
                    Err(error) => failures.push(error),
                }
            }
            Some(WorkspaceRecoveryDecision::Rollback) => {
                match certify_prior_workspace_rollback(
                    workspace_dir,
                    prior_bytes,
                    path,
                    parent,
                    pending_path,
                    committed_path,
                    sync_parent_directory,
                    restore_workspace_backup,
                    recreate_pending_rollback,
                ) {
                    Ok(()) => return Err(failures.join("; ")),
                    Err(error) => failures.push(error),
                }
            }
            None => return Err(failures.join("; ")),
        }
    }

    match prior_workspace_recovery_decision(
        workspace_dir,
        source_file,
        expected_bytes,
        prior_bytes,
        pending_path,
        committed_path,
        forward_path,
    )? {
        Some(WorkspaceRecoveryDecision::Forward) => {
            let final_error = certify_prior_workspace_forward(
                workspace_dir,
                source_file,
                expected_bytes,
                path,
                parent,
                pending_path,
                committed_path,
                forward_path,
                false,
                sync_parent_directory,
            )
            .err();
            if final_error.is_none() {
                return Ok(());
            }
            verify_opened_workspace_artifact(
                workspace_dir,
                source_file,
                forward_path,
                expected_bytes,
                "workspace forward rollback",
            )?;
            verify_opened_workspace_artifact(
                workspace_dir,
                source_file,
                path,
                expected_bytes,
                "workspace",
            )?;
            Ok(())
        }
        Some(WorkspaceRecoveryDecision::Rollback) => {
            certify_prior_workspace_rollback(
                workspace_dir,
                prior_bytes,
                path,
                parent,
                pending_path,
                committed_path,
                sync_parent_directory,
                restore_workspace_backup,
                recreate_pending_rollback,
            )
            .map_err(|error| {
                format!(
                    "{}; final rollback recovery decision certification failed: {error}",
                    failures.join("; ")
                )
            })?;
            Err(failures.join("; "))
        }
        None => Err(failures.join("; ")),
    }
}

fn prior_workspace_recovery_decision(
    workspace_dir: &SecureWorkspaceDir,
    source_file: &File,
    expected_bytes: &[u8],
    prior_bytes: &[u8],
    pending_path: &Path,
    committed_path: &Path,
    forward_path: &Path,
) -> Result<Option<WorkspaceRecoveryDecision>, String> {
    if regular_file_exists(workspace_dir, pending_path, "workspace pending rollback")? {
        verify_workspace_artifact_bytes(
            workspace_dir,
            pending_path,
            prior_bytes,
            "workspace pending rollback",
        )?;
        return Ok(Some(WorkspaceRecoveryDecision::Rollback));
    }

    if !regular_file_exists(
        workspace_dir,
        committed_path,
        "workspace committed rollback",
    )? {
        return Ok(None);
    }
    let committed_bytes = read_workspace_restore_source_bytes(
        workspace_dir,
        committed_path,
        "workspace committed rollback",
    )?;
    if regular_file_exists(workspace_dir, forward_path, "workspace forward rollback")? {
        verify_opened_workspace_artifact(
            workspace_dir,
            source_file,
            forward_path,
            expected_bytes,
            "workspace forward rollback",
        )?;
        return Ok(Some(WorkspaceRecoveryDecision::Forward));
    }
    if committed_bytes != prior_bytes {
        return Err(format!(
            "committed rollback '{}' no longer contains the exact prior workspace",
            committed_path.display()
        ));
    }
    Ok(Some(WorkspaceRecoveryDecision::Rollback))
}

fn certify_prior_pending_recovery(
    workspace_dir: &SecureWorkspaceDir,
    prior_bytes: &[u8],
    parent: &Path,
    pending_path: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if !regular_file_exists(workspace_dir, pending_path, "workspace pending rollback")? {
        return Err(format!(
            "workspace pending rollback '{}' is missing",
            pending_path.display()
        ));
    }
    verify_workspace_artifact_bytes(
        workspace_dir,
        pending_path,
        prior_bytes,
        "workspace pending rollback",
    )?;
    sync_parent_directory(workspace_dir, parent).map_err(|error| {
        format!(
            "sync certified pending rollback '{}': {}",
            pending_path.display(),
            error
        )
    })?;
    verify_workspace_artifact_bytes(
        workspace_dir,
        pending_path,
        prior_bytes,
        "workspace pending rollback",
    )
}

fn certify_prior_workspace_rollback(
    workspace_dir: &SecureWorkspaceDir,
    prior_bytes: &[u8],
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    recreate_pending_rollback: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if !regular_file_exists(workspace_dir, pending_path, "workspace pending rollback")? {
        if !regular_file_exists(
            workspace_dir,
            committed_path,
            "workspace committed rollback",
        )? {
            return Err(
                "cannot certify prior workspace rollback because no recovery copy remains"
                    .to_string(),
            );
        }
        recreate_pending_rollback(workspace_dir, committed_path, pending_path).map_err(
            |error| {
                format!(
                    "recreate pending rollback '{}' from '{}': {}",
                    pending_path.display(),
                    committed_path.display(),
                    error
                )
            },
        )?;
    }
    verify_workspace_artifact_bytes(
        workspace_dir,
        pending_path,
        prior_bytes,
        "workspace pending rollback",
    )?;
    restore_workspace_backup(workspace_dir, pending_path, path).map_err(|error| {
        format!(
            "restore prior workspace '{}' from '{}': {}",
            path.display(),
            pending_path.display(),
            error
        )
    })?;
    sync_parent_directory(workspace_dir, parent).map_err(|error| {
        format!(
            "sync certified prior workspace rollback '{}': {}",
            path.display(),
            error
        )
    })?;
    verify_workspace_artifact_bytes(
        workspace_dir,
        pending_path,
        prior_bytes,
        "workspace pending rollback",
    )?;
    verify_workspace_artifact_bytes(workspace_dir, path, prior_bytes, "workspace")
}

pub(super) fn certify_prior_workspace_forward(
    workspace_dir: &SecureWorkspaceDir,
    source_file: &File,
    expected_bytes: &[u8],
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    forward_path: &Path,
    force_sync: bool,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    verify_opened_workspace_artifact(
        workspace_dir,
        source_file,
        forward_path,
        expected_bytes,
        "workspace forward rollback",
    )?;

    let mut mutated = false;
    if let Err(path_error) = verify_opened_workspace_artifact(
        workspace_dir,
        source_file,
        path,
        expected_bytes,
        "workspace",
    ) {
        restore_workspace_backup_in(workspace_dir, forward_path, path).map_err(|error| {
            format!(
                "{path_error}; restore forward workspace '{}' from '{}': {}",
                path.display(),
                forward_path.display(),
                error
            )
        })?;
        mutated = true;
    }
    if regular_file_exists(workspace_dir, pending_path, "workspace pending rollback")? {
        unlink_workspace_path(workspace_dir, pending_path, "workspace pending rollback").map_err(
            |error| {
                format!(
                    "remove pending rollback '{}' for forward certification: {}",
                    pending_path.display(),
                    error
                )
            },
        )?;
        mutated = true;
    }
    regular_file_exists(
        workspace_dir,
        committed_path,
        "workspace committed rollback",
    )?;
    if force_sync || mutated {
        sync_parent_directory(workspace_dir, parent).map_err(|error| {
            format!(
                "sync certified forward workspace '{}': {}",
                path.display(),
                error
            )
        })?;
    }
    if regular_file_exists(workspace_dir, pending_path, "workspace pending rollback")? {
        return Err(format!(
            "pending rollback '{}' reappeared after forward certification",
            pending_path.display()
        ));
    }
    verify_opened_workspace_artifact(
        workspace_dir,
        source_file,
        forward_path,
        expected_bytes,
        "workspace forward rollback",
    )?;
    verify_opened_workspace_artifact(
        workspace_dir,
        source_file,
        path,
        expected_bytes,
        "workspace",
    )
}

pub(super) fn certify_prior_committed_recovery(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    parent: &Path,
    committed_path: &Path,
    forward_path: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let committed_bytes = read_workspace_restore_source_bytes(
        workspace_dir,
        committed_path,
        "workspace committed rollback",
    )?;
    let forward_bytes =
        read_workspace_artifact_bytes(workspace_dir, forward_path, "workspace forward rollback")?;
    let workspace_bytes = read_workspace_artifact_bytes(workspace_dir, path, "workspace")?;
    let certified_bytes = if workspace_bytes == forward_bytes {
        validate_workspace_artifact_bytes(
            &forward_bytes,
            forward_path,
            "workspace forward rollback",
        )?;
        forward_bytes.as_slice()
    } else if workspace_bytes == committed_bytes {
        committed_bytes.as_slice()
    } else {
        restore_workspace_backup_in(workspace_dir, committed_path, path).map_err(
            |rollback_error| {
                format!(
                    "workspace '{}' matches neither committed rollback '{}' nor forward candidate '{}'; \
                     restore exact prior workspace failed: {rollback_error}",
                    path.display(),
                    committed_path.display(),
                    forward_path.display()
                )
            },
        )?;
        sync_parent_directory(workspace_dir, parent).map_err(|rollback_error| {
            format!(
                "sync exact prior workspace '{}' reconstructed from committed rollback '{}': \
                 {rollback_error}",
                path.display(),
                committed_path.display()
            )
        })?;
        verify_workspace_artifact_bytes(
            workspace_dir,
            committed_path,
            &committed_bytes,
            "workspace committed rollback",
        )?;
        verify_workspace_artifact_bytes(workspace_dir, path, &committed_bytes, "workspace")?;
        return Ok(());
    };

    sync_parent_directory(workspace_dir, parent).map_err(|error| {
        format!(
            "sync certified committed workspace recovery '{}': {}",
            path.display(),
            error
        )
    })?;
    verify_workspace_artifact_bytes(
        workspace_dir,
        committed_path,
        &committed_bytes,
        "workspace committed rollback",
    )?;
    verify_workspace_artifact_bytes(
        workspace_dir,
        forward_path,
        &forward_bytes,
        "workspace forward rollback",
    )?;
    verify_workspace_artifact_bytes(workspace_dir, path, certified_bytes, "workspace")
}
