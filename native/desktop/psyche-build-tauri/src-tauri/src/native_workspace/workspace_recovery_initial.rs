//! Recovering a workspace that did not exist before the save.
//!
//! The other half of the recovery layer from `workspace_recovery_prior`. With
//! no prior workspace there are no bytes to restore, so the choice is between
//! durably re-establishing the absence and completing the forward commit — and
//! the awkward cases are the ones where the marker that would say which is
//! itself missing or unreadable.
//!
//! `certify_*` and `*_decision` read what is on disk and choose;
//! `durably_*` and `restore_*` carry the choice out. Two of them are named
//! `*_without_marker` because they run when the marker write failed, which is
//! exactly when there is least evidence to work from.
//!
//! **No call edges connect this module to `workspace_recovery_prior`, in
//! either direction.** The two halves are entered from
//! `finish_initial_workspace_transaction` and
//! `finish_prior_workspace_transaction` respectively, so the `had_workspace`
//! branch that #372 named at the transaction level partitions the recovery
//! layer as well. That was measured, not assumed, before either half moved.

use std::fs::File;
use std::path::Path;

use super::secure_fs::{
    open_existing_regular_file, regular_file_exists, unlink_workspace_path,
    verify_opened_regular_file,
};
use super::workspace_absent_marker::{
    absent_rollback_resolution, create_absent_rollback_marker_in, declare_absent_forward_commit,
    declare_absent_rollback,
};
use super::workspace_artifact_io::{
    read_workspace_artifact_bytes, validate_workspace_artifact_bytes,
    verify_opened_workspace_artifact, verify_workspace_artifact_bytes,
};
use super::workspace_artifact_sweep::cleanup_forward_rollback;
use super::workspace_restore::restore_workspace_backup_in;
use super::{
    ensure_forward_workspace, restore_prior_workspace_state, AbsentRollbackInterpretation,
    AbsentRollbackResolution, SecureWorkspaceDir, WorkspaceRecoveryDecision,
    WORKSPACE_RECOVERY_DECISION_ATTEMPTS,
};

#[cfg(test)]
use super::{run_marker_file_fault, MarkerFileOperation, ABSENT_FORWARD_MARKER};

/// Removes a workspace artifact if it is present, tolerating absence.
///
/// Moved here from the parent in the same change that extracted the recovery
/// dispatcher: once initial-workspace recovery moved out, this had no callers
/// left in `native_workspace.rs` at all, and every one of its eight uses is in
/// this file.
fn unlink_existing_regular_workspace_path(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    context: &str,
) -> Result<(), String> {
    if !regular_file_exists(workspace_dir, path, context)? {
        return Ok(());
    }
    unlink_workspace_path(workspace_dir, path, context)
        .map_err(|error| format!("remove {context} '{}': {}", path.display(), error))
}

pub(super) fn resolve_initial_workspace_after_marker_failure(
    workspace_dir: &SecureWorkspaceDir,
    source_file: &File,
    expected_bytes: &[u8],
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    forward_path: &Path,
    failure: String,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let (forward_evidence, observation_error) = match initial_workspace_recovery_decision(
        workspace_dir,
        source_file,
        expected_bytes,
        pending_path,
        committed_path,
        forward_path,
    ) {
        Ok(Some(WorkspaceRecoveryDecision::Forward)) => (true, None),
        Ok(_) => (false, None),
        Err(error) => (false, Some(error)),
    };
    let certification_error = match certify_initial_forward_recovery(
        workspace_dir,
        source_file,
        expected_bytes,
        path,
        parent,
        pending_path,
        committed_path,
        forward_path,
        sync_parent_directory,
    ) {
        Ok(true) => return Ok(()),
        Ok(false) => "no forward recovery marker remains".to_string(),
        Err(error) => error,
    };
    let certification_error = match observation_error {
        Some(error) => {
            format!("{certification_error}; forward decision inspection failed: {error}")
        }
        None => certification_error,
    };

    let forward_error = match durably_commit_initial_workspace_without_marker(
        workspace_dir,
        source_file,
        expected_bytes,
        path,
        parent,
        pending_path,
        committed_path,
        forward_path,
        sync_parent_directory,
    ) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };

    match durably_restore_initial_absence_without_marker(
        workspace_dir,
        path,
        parent,
        pending_path,
        committed_path,
        sync_parent_directory,
    ) {
        Ok(()) => {
            let cleanup_error = match cleanup_forward_rollback(
                workspace_dir,
                forward_path,
                parent,
                sync_parent_directory,
            ) {
                Ok(()) => String::new(),
                Err(error) => format!("; forward cleanup after durable rollback: {error}"),
            };
            Err(format!(
                "{failure}; forward marker certification failed: {certification_error}; \
                 markerless forward resolution failed: {forward_error}{cleanup_error}"
            ))
        }
        Err(rollback_error) if forward_evidence => {
            match restore_observed_initial_forward_recovery(
                workspace_dir,
                source_file,
                expected_bytes,
                path,
                parent,
                forward_path,
                sync_parent_directory,
            ) {
                Ok(()) => Ok(()),
                Err(restore_error) => reassert_initial_forward_recovery_decision(
                    workspace_dir,
                    source_file,
                    expected_bytes,
                    path,
                    parent,
                    pending_path,
                    committed_path,
                    forward_path,
                    sync_parent_directory,
                )
                .map_err(|reassert_error| {
                    format!(
                        "{failure}; forward marker certification failed: {certification_error}; \
                         markerless forward resolution failed: {forward_error}; \
                         markerless rollback resolution failed: {rollback_error}; \
                         restore observed forward recovery failed: {restore_error}; \
                         durable forward reassertion failed: {reassert_error}"
                    )
                }),
            }
        }
        Err(rollback_error) => Err(format!(
            "{failure}; forward marker certification failed: {certification_error}; \
             markerless forward resolution failed: {forward_error}; \
             markerless rollback resolution failed: {rollback_error}"
        )),
    }
}

fn initial_workspace_recovery_decision(
    workspace_dir: &SecureWorkspaceDir,
    source_file: &File,
    expected_bytes: &[u8],
    pending_path: &Path,
    committed_path: &Path,
    forward_path: &Path,
) -> Result<Option<WorkspaceRecoveryDecision>, String> {
    match absent_rollback_resolution(workspace_dir, pending_path, committed_path)? {
        AbsentRollbackInterpretation::Resolved(AbsentRollbackResolution::Rollback) => {
            Ok(Some(WorkspaceRecoveryDecision::Rollback))
        }
        AbsentRollbackInterpretation::Resolved(AbsentRollbackResolution::Forward {
            require_candidate,
        }) => {
            if require_candidate {
                verify_opened_regular_file(
                    workspace_dir,
                    source_file,
                    forward_path,
                    "workspace forward rollback",
                )?;
                verify_workspace_artifact_bytes(
                    workspace_dir,
                    forward_path,
                    expected_bytes,
                    "workspace forward rollback",
                )?;
            }
            Ok(Some(WorkspaceRecoveryDecision::Forward))
        }
        AbsentRollbackInterpretation::Missing | AbsentRollbackInterpretation::Ambiguous => Ok(None),
    }
}

fn reassert_initial_forward_recovery_decision(
    workspace_dir: &SecureWorkspaceDir,
    source_file: &File,
    expected_bytes: &[u8],
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    forward_path: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let mut failures = Vec::new();
    for _ in 0..WORKSPACE_RECOVERY_DECISION_ATTEMPTS {
        if !regular_file_exists(
            workspace_dir,
            pending_path,
            "workspace absent pending rollback",
        )? && !regular_file_exists(
            workspace_dir,
            committed_path,
            "workspace absent committed rollback",
        )? {
            if let Err(error) = create_absent_rollback_marker_in(workspace_dir, pending_path) {
                failures.push(error);
                continue;
            }
        }
        if let Err(error) =
            declare_absent_forward_commit(workspace_dir, pending_path, committed_path)
        {
            failures.push(error);
            continue;
        }
        match restore_observed_initial_forward_recovery(
            workspace_dir,
            source_file,
            expected_bytes,
            path,
            parent,
            forward_path,
            sync_parent_directory,
        ) {
            Ok(()) => return Ok(()),
            Err(error) => failures.push(error),
        }
    }

    match initial_workspace_recovery_decision(
        workspace_dir,
        source_file,
        expected_bytes,
        pending_path,
        committed_path,
        forward_path,
    )? {
        Some(WorkspaceRecoveryDecision::Forward) => {
            verify_opened_workspace_artifact(
                workspace_dir,
                source_file,
                path,
                expected_bytes,
                "workspace temp",
            )?;
            Ok(())
        }
        Some(WorkspaceRecoveryDecision::Rollback) | None => Err(format!(
            "forward recovery decision did not remain durable after reassertion: {}",
            failures.join("; ")
        )),
    }
}

fn restore_observed_initial_forward_recovery(
    workspace_dir: &SecureWorkspaceDir,
    source_file: &File,
    expected_bytes: &[u8],
    path: &Path,
    parent: &Path,
    forward_path: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    verify_opened_workspace_artifact(
        workspace_dir,
        source_file,
        forward_path,
        expected_bytes,
        "workspace forward rollback",
    )?;
    if verify_opened_workspace_artifact(
        workspace_dir,
        source_file,
        path,
        expected_bytes,
        "workspace temp",
    )
    .is_err()
    {
        restore_workspace_backup_in(workspace_dir, forward_path, path).map_err(|error| {
            format!(
                "restore observed forward workspace '{}' from '{}': {}",
                path.display(),
                forward_path.display(),
                error
            )
        })?;
    }
    verify_opened_workspace_artifact(
        workspace_dir,
        source_file,
        path,
        expected_bytes,
        "workspace temp",
    )?;
    sync_parent_directory(workspace_dir, parent).map_err(|error| {
        format!(
            "sync restored observed forward workspace '{}': {}",
            path.display(),
            error
        )
    })?;
    verify_opened_workspace_artifact(
        workspace_dir,
        source_file,
        path,
        expected_bytes,
        "workspace temp",
    )
}

fn certify_initial_forward_recovery(
    workspace_dir: &SecureWorkspaceDir,
    source_file: &File,
    expected_bytes: &[u8],
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    forward_path: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<bool, String> {
    let AbsentRollbackInterpretation::Resolved(AbsentRollbackResolution::Forward {
        require_candidate,
    }) = absent_rollback_resolution(workspace_dir, pending_path, committed_path)?
    else {
        return Ok(false);
    };

    let mut marker_found = false;
    for marker_path in [pending_path, committed_path] {
        let Some(marker) = open_existing_regular_file(
            workspace_dir,
            marker_path,
            "workspace absent rollback marker",
            true,
        )?
        else {
            continue;
        };
        marker_found = true;
        #[cfg(test)]
        let mut marker = marker;
        #[cfg(test)]
        run_marker_file_fault(
            MarkerFileOperation::Sync,
            &mut marker,
            marker_path,
            ABSENT_FORWARD_MARKER,
        )?;
        marker.sync_all().map_err(|error| {
            format!(
                "certify absent workspace forward marker '{}': {}",
                marker_path.display(),
                error
            )
        })?;
        verify_opened_regular_file(
            workspace_dir,
            &marker,
            marker_path,
            "workspace absent rollback marker",
        )?;
    }
    if !marker_found {
        return Ok(false);
    }
    sync_parent_directory(workspace_dir, parent).map_err(|error| {
        format!(
            "sync certified absent workspace forward marker '{}': {}",
            committed_path.display(),
            error
        )
    })?;
    if !matches!(
        absent_rollback_resolution(workspace_dir, pending_path, committed_path)?,
        AbsentRollbackInterpretation::Resolved(AbsentRollbackResolution::Forward { .. })
    ) {
        return Err(
            "absent workspace marker changed while certifying forward recovery".to_string(),
        );
    }

    let has_forward =
        regular_file_exists(workspace_dir, forward_path, "workspace forward rollback")?;
    if require_candidate && !has_forward {
        return Err(format!(
            "workspace forward rollback '{}' is missing",
            forward_path.display()
        ));
    }
    if has_forward {
        verify_opened_regular_file(
            workspace_dir,
            source_file,
            forward_path,
            "workspace forward rollback",
        )?;
        verify_workspace_artifact_bytes(
            workspace_dir,
            forward_path,
            expected_bytes,
            "workspace forward rollback",
        )?;
    }

    if regular_file_exists(workspace_dir, path, "workspace")? {
        verify_opened_workspace_artifact(
            workspace_dir,
            source_file,
            path,
            expected_bytes,
            "workspace temp",
        )?;
    } else if !has_forward {
        return Err(format!(
            "forward workspace '{}' and rollback '{}' are both missing",
            path.display(),
            forward_path.display()
        ));
    }
    Ok(true)
}

fn durably_commit_initial_workspace_without_marker(
    workspace_dir: &SecureWorkspaceDir,
    source_file: &File,
    expected_bytes: &[u8],
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    forward_path: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    verify_opened_regular_file(
        workspace_dir,
        source_file,
        forward_path,
        "workspace forward rollback",
    )?;
    verify_workspace_artifact_bytes(
        workspace_dir,
        forward_path,
        expected_bytes,
        "workspace forward rollback",
    )?;
    ensure_forward_workspace(workspace_dir, path, forward_path, true)?;
    verify_opened_workspace_artifact(
        workspace_dir,
        source_file,
        path,
        expected_bytes,
        "workspace temp",
    )?;
    unlink_existing_regular_workspace_path(
        workspace_dir,
        pending_path,
        "workspace absent pending rollback",
    )?;
    unlink_existing_regular_workspace_path(
        workspace_dir,
        committed_path,
        "workspace absent committed rollback",
    )?;
    sync_parent_directory(workspace_dir, parent).map_err(|error| {
        format!(
            "sync markerless forward workspace '{}': {}",
            path.display(),
            error
        )
    })?;
    if regular_file_exists(
        workspace_dir,
        pending_path,
        "workspace absent pending rollback",
    )? || regular_file_exists(
        workspace_dir,
        committed_path,
        "workspace absent committed rollback",
    )? {
        return Err("absent workspace marker reappeared after markerless forward sync".to_string());
    }
    verify_opened_workspace_artifact(
        workspace_dir,
        source_file,
        path,
        expected_bytes,
        "workspace temp",
    )
}

fn durably_restore_initial_absence_without_marker(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    unlink_existing_regular_workspace_path(workspace_dir, path, "workspace")?;
    unlink_existing_regular_workspace_path(
        workspace_dir,
        pending_path,
        "workspace absent pending rollback",
    )?;
    unlink_existing_regular_workspace_path(
        workspace_dir,
        committed_path,
        "workspace absent committed rollback",
    )?;
    sync_parent_directory(workspace_dir, parent).map_err(|error| {
        format!(
            "sync markerless restoration of absent workspace '{}': {}",
            path.display(),
            error
        )
    })?;
    if regular_file_exists(workspace_dir, path, "workspace")?
        || regular_file_exists(
            workspace_dir,
            pending_path,
            "workspace absent pending rollback",
        )?
        || regular_file_exists(
            workspace_dir,
            committed_path,
            "workspace absent committed rollback",
        )?
    {
        return Err(
            "initial workspace state reappeared after markerless rollback sync".to_string(),
        );
    }
    Ok(())
}

pub(super) fn durably_restore_initial_absence(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    declare_absent_rollback(workspace_dir, pending_path, committed_path)?;
    let recovery_path =
        if regular_file_exists(workspace_dir, pending_path, "workspace pending rollback")? {
            pending_path
        } else if regular_file_exists(
            workspace_dir,
            committed_path,
            "workspace committed rollback",
        )? {
            committed_path
        } else {
            return Err(format!(
                "cannot durably restore prior absence because neither marker '{}' nor '{}' remains",
                pending_path.display(),
                committed_path.display()
            ));
        };
    restore_prior_workspace_state(workspace_dir, recovery_path, path, restore_workspace_backup)?;
    sync_parent_directory(workspace_dir, parent).map_err(|error| {
        format!(
            "retry sync of restored absent workspace '{}': {}",
            path.display(),
            error
        )
    })
}

pub(super) fn recover_workspace_from_forward_candidate(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    parent: &Path,
    forward_path: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let forward_bytes =
        read_workspace_artifact_bytes(workspace_dir, forward_path, "workspace forward rollback")?;
    validate_workspace_artifact_bytes(&forward_bytes, forward_path, "workspace forward rollback")?;

    let workspace_matches = if regular_file_exists(workspace_dir, path, "workspace")? {
        read_workspace_artifact_bytes(workspace_dir, path, "workspace")? == forward_bytes
    } else {
        false
    };
    if !workspace_matches {
        restore_workspace_backup_in(workspace_dir, forward_path, path).map_err(|error| {
            format!(
                "restore forward workspace '{}' from '{}': {}",
                path.display(),
                forward_path.display(),
                error
            )
        })?;
    }
    sync_parent_directory(workspace_dir, parent).map_err(|error| {
        format!(
            "sync forward workspace '{}': {}; forward recovery retained at '{}'",
            path.display(),
            error,
            forward_path.display()
        )
    })?;
    verify_workspace_artifact_bytes(
        workspace_dir,
        forward_path,
        &forward_bytes,
        "workspace forward rollback",
    )?;
    verify_workspace_artifact_bytes(workspace_dir, path, &forward_bytes, "workspace")
}

pub(super) fn recover_ambiguous_initial_workspace(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    forward_path: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let forward_error = match recover_workspace_from_forward_candidate(
        workspace_dir,
        path,
        parent,
        forward_path,
        sync_parent_directory,
    ) {
        Ok(()) => {
            unlink_existing_regular_workspace_path(
                workspace_dir,
                pending_path,
                "workspace absent pending rollback",
            )?;
            unlink_existing_regular_workspace_path(
                workspace_dir,
                committed_path,
                "workspace absent committed rollback",
            )?;
            sync_parent_directory(workspace_dir, parent).map_err(|error| {
                format!(
                    "sync removal of ambiguous absent workspace markers in '{}': {}",
                    parent.display(),
                    error
                )
            })?;
            if regular_file_exists(
                workspace_dir,
                pending_path,
                "workspace absent pending rollback",
            )? || regular_file_exists(
                workspace_dir,
                committed_path,
                "workspace absent committed rollback",
            )? {
                return Err(
                    "ambiguous absent workspace marker reappeared after forward recovery"
                        .to_string(),
                );
            }
            return Ok(());
        }
        Err(error) => error,
    };

    match durably_restore_initial_absence_without_marker(
        workspace_dir,
        path,
        parent,
        pending_path,
        committed_path,
        sync_parent_directory,
    ) {
        Ok(()) => Ok(()),
        Err(rollback_error) => Err(format!(
            "ambiguous absent workspace forward resolution failed: {forward_error}; \
             rollback resolution failed: {rollback_error}"
        )),
    }
}
