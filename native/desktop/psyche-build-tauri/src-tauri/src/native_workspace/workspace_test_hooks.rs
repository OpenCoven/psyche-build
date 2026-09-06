//! Test entry points into the workspace transaction.
//!
//! Seventeen functions that exist only to let tests drive a save or load with
//! a chosen step replaced or made to fail. They call into the transaction the
//! way production does, differing only in which closure they pass.
//!
//! They were interleaved with production code in `native_workspace.rs` —
//! roughly four hundred lines of scaffolding sitting between the functions it
//! exercises, in a module whose other contents are symlink and TOCTOU
//! defences. Nothing here runs in a shipped binary.
//!
//! **Fault hooks are not here on purpose.** `run_marker_file_fault` and
//! `run_post_initial_forward_sync_fault` are also `#[cfg(test)]`, but
//! production functions call them, so they stay beside the code they fault —
//! the same placement `workspace_restore` and `workspace_publish` already use
//! for theirs. What moved is only what tests call directly.
//!
//! The per-function `#[cfg(test)]` attributes are gone because the `mod`
//! declaration carries the gate; the bodies are otherwise unchanged.

use std::path::Path;

use serde_json::Value;

use super::secure_fs::rename_workspace_path_in;
use super::workspace_restore::{create_rollback_backup_in, restore_workspace_backup_in};
use super::{
    load_workspace_from_inner, load_workspace_from_locked_in, save_workspace_to,
    save_workspace_to_inner, sync_workspace_directory, workspace_file_exists_in,
    MarkerFileFaultMode, MarkerFileFaultPlan, PostInitialForwardSyncFault,
    RestoreCandidateFileOperation, SecureWorkspaceDir, MARKER_FILE_FAULT,
    POST_INITIAL_FORWARD_SYNC_FAULT, POST_RESTORE_VERIFICATION_PRE_RENAME_REPLACEMENT,
    POST_VERIFICATION_PRE_RENAME_REPLACEMENT, TRUSTED_RESTORE_CANDIDATE_FAILURE,
};

pub(super) fn load_workspace_from_locked(path: &Path) -> Result<Option<Value>, String> {
    let Some(workspace_dir) = SecureWorkspaceDir::open_for_load(path)? else {
        return Ok(None);
    };
    load_workspace_from_locked_in(&workspace_dir, path)
}

pub(super) fn workspace_file_exists(path: &Path) -> Result<bool, String> {
    let Some(workspace_dir) = SecureWorkspaceDir::open_for_load(path)? else {
        return Ok(false);
    };
    workspace_file_exists_in(&workspace_dir, path)
}

pub(super) fn sync_parent_directory_standalone(parent: &Path) -> Result<(), String> {
    let path = parent.join("workspace-v3.json");
    let workspace_dir = SecureWorkspaceDir::open_for_load(&path)?
        .ok_or_else(|| format!("workspace parent '{}' is missing", parent.display()))?;
    workspace_dir.sync()
}

pub(super) fn sync_parent_directory(_parent: &Path) -> Result<(), String> {
    Ok(())
}

pub(super) fn workspace_save_to_test_hook<F, G, H>(
    path: &Path,
    value: &Value,
    before_rename: F,
    mut sync_transaction_directory: G,
    mut restore_workspace_backup: H,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
    G: FnMut(&Path) -> Result<(), String>,
    H: FnMut(&Path, &Path) -> Result<(), String>,
{
    save_workspace_to_inner(
        path,
        value,
        before_rename,
        |_| Ok(()),
        |_| Ok(()),
        move |workspace_dir, parent| {
            sync_transaction_directory(parent)?;
            workspace_dir.sync()
        },
        move |workspace_dir, backup, destination| {
            restore_workspace_backup(backup, destination)?;
            restore_workspace_backup_in(workspace_dir, backup, destination)
        },
        create_rollback_backup_in,
        create_rollback_backup_in,
        rename_workspace_path_in,
    )
}

pub(super) fn workspace_save_to_test_hook_before_publication<F>(
    path: &Path,
    value: &Value,
    before_publication: F,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    save_workspace_to_inner(
        path,
        value,
        |_| Ok(()),
        before_publication,
        |_| Ok(()),
        sync_workspace_directory,
        restore_workspace_backup_in,
        create_rollback_backup_in,
        create_rollback_backup_in,
        rename_workspace_path_in,
    )
}

pub(super) fn workspace_save_to_test_marker_file_fault(
    path: &Path,
    value: &Value,
    mode: MarkerFileFaultMode,
) -> (Result<(), String>, usize) {
    MARKER_FILE_FAULT.with(|fault| {
        assert!(
            fault.borrow().is_none(),
            "marker file fault already installed"
        );
        *fault.borrow_mut() = Some(MarkerFileFaultPlan {
            mode,
            armed: false,
            failures: 0,
        });
    });

    let result = save_workspace_to(path, value);
    let failures = MARKER_FILE_FAULT.with(|fault| {
        fault
            .borrow_mut()
            .take()
            .expect("marker file fault must remain installed")
            .failures
    });
    (result, failures)
}

pub(super) fn workspace_save_to_test_marker_and_directory_faults<G, I>(
    path: &Path,
    value: &Value,
    mode: MarkerFileFaultMode,
    mut sync_transaction_directory: G,
    mut recreate_pending_rollback: I,
) -> (Result<(), String>, usize)
where
    G: FnMut(&Path) -> Result<(), String>,
    I: FnMut(&Path, &Path) -> Result<(), String>,
{
    MARKER_FILE_FAULT.with(|fault| {
        assert!(
            fault.borrow().is_none(),
            "marker file fault already installed"
        );
        *fault.borrow_mut() = Some(MarkerFileFaultPlan {
            mode,
            armed: false,
            failures: 0,
        });
    });

    let result = save_workspace_to_inner(
        path,
        value,
        |_| Ok(()),
        |_| Ok(()),
        |_| Ok(()),
        move |workspace_dir, parent| {
            sync_transaction_directory(parent)?;
            workspace_dir.sync()
        },
        restore_workspace_backup_in,
        create_rollback_backup_in,
        move |workspace_dir, source, destination| {
            recreate_pending_rollback(source, destination)?;
            create_rollback_backup_in(workspace_dir, source, destination)
        },
        rename_workspace_path_in,
    );
    let failures = MARKER_FILE_FAULT.with(|fault| {
        fault
            .borrow_mut()
            .take()
            .expect("marker file fault must remain installed")
            .failures
    });
    (result, failures)
}

pub(super) fn workspace_save_to_test_swap_after_final_verification_before_rename(
    path: &Path,
    value: &Value,
    replacement: Vec<u8>,
) -> Result<(), String> {
    POST_VERIFICATION_PRE_RENAME_REPLACEMENT.with(|pending| {
        assert!(
            pending.borrow().is_none(),
            "post-verification pre-rename fault already installed"
        );
        *pending.borrow_mut() = Some(replacement);
    });

    let result = save_workspace_to(path, value);
    let missed = POST_VERIFICATION_PRE_RENAME_REPLACEMENT
        .with(|pending| pending.borrow_mut().take().is_some());
    if missed {
        Err("expected post-verification pre-rename fault point was not reached".to_string())
    } else {
        result
    }
}

pub(super) fn with_restore_candidate_swap<T>(
    replacement: Vec<u8>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    POST_RESTORE_VERIFICATION_PRE_RENAME_REPLACEMENT.with(|pending| {
        assert!(
            pending.borrow().is_none(),
            "post-restore-verification pre-rename fault already installed"
        );
        *pending.borrow_mut() = Some(replacement);
    });

    let result = operation();
    let missed = POST_RESTORE_VERIFICATION_PRE_RENAME_REPLACEMENT
        .with(|pending| pending.borrow_mut().take().is_some());
    if missed {
        Err("expected post-restore-verification pre-rename fault point was not reached".to_string())
    } else {
        result
    }
}

pub(super) fn with_restore_candidate_swap_and_trusted_retry_failure<T>(
    replacement: Vec<u8>,
    failure: RestoreCandidateFileOperation,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    TRUSTED_RESTORE_CANDIDATE_FAILURE.with(|pending| {
        assert!(
            pending.borrow().is_none(),
            "trusted restore candidate fault already installed"
        );
        *pending.borrow_mut() = Some(failure);
    });

    let result = with_restore_candidate_swap(replacement, operation);
    let missed = TRUSTED_RESTORE_CANDIDATE_FAILURE.with(|pending| pending.borrow_mut().take());
    if let Some(missed) = missed {
        return Err(format!(
            "expected trusted restore candidate {missed:?} fault point was not reached"
        ));
    }
    result
}

pub(super) fn workspace_save_to_test_post_initial_forward_sync_fault(
    path: &Path,
    value: &Value,
    fault: PostInitialForwardSyncFault,
) -> Result<(), String> {
    POST_INITIAL_FORWARD_SYNC_FAULT.with(|pending| {
        assert!(
            pending.borrow().is_none(),
            "post-initial-forward-sync fault already installed"
        );
        *pending.borrow_mut() = Some(fault);
    });

    let result = save_workspace_to(path, value);
    let missed =
        POST_INITIAL_FORWARD_SYNC_FAULT.with(|pending| pending.borrow_mut().take().is_some());
    if missed {
        Err("expected post-initial-forward-sync fault point was not reached".to_string())
    } else {
        result
    }
}

pub(super) fn workspace_save_to_test_hook_with_recreation_fault<G, I>(
    path: &Path,
    value: &Value,
    mut sync_transaction_directory: G,
    mut recreate_pending_rollback: I,
) -> Result<(), String>
where
    G: FnMut(&Path) -> Result<(), String>,
    I: FnMut(&Path, &Path) -> Result<(), String>,
{
    save_workspace_to_inner(
        path,
        value,
        |_| Ok(()),
        |_| Ok(()),
        |_| Ok(()),
        move |workspace_dir, parent| {
            sync_transaction_directory(parent)?;
            workspace_dir.sync()
        },
        restore_workspace_backup_in,
        create_rollback_backup_in,
        move |workspace_dir, source, destination| {
            recreate_pending_rollback(source, destination)?;
            create_rollback_backup_in(workspace_dir, source, destination)
        },
        rename_workspace_path_in,
    )
}

pub(super) fn load_workspace_from_test_hook<F>(
    path: &Path,
    before_exclusive_recovery: F,
) -> Result<Option<Value>, String>
where
    F: FnOnce() -> Result<(), String>,
{
    load_workspace_from_inner(path, before_exclusive_recovery)
}

pub(super) fn workspace_save_to_test_hook_with_backup<F, G, H, I>(
    path: &Path,
    value: &Value,
    before_rename: F,
    mut sync_transaction_directory: G,
    mut restore_workspace_backup: H,
    create_rollback_backup: I,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
    G: FnMut(&Path) -> Result<(), String>,
    H: FnMut(&Path, &Path) -> Result<(), String>,
    I: FnOnce(&Path, &Path) -> Result<(), String>,
{
    save_workspace_to_inner(
        path,
        value,
        before_rename,
        |_| Ok(()),
        |_| Ok(()),
        move |workspace_dir, parent| {
            sync_transaction_directory(parent)?;
            workspace_dir.sync()
        },
        move |workspace_dir, backup, destination| {
            restore_workspace_backup(backup, destination)?;
            restore_workspace_backup_in(workspace_dir, backup, destination)
        },
        move |workspace_dir, source, backup| {
            create_rollback_backup(source, backup)?;
            create_rollback_backup_in(workspace_dir, source, backup)
        },
        create_rollback_backup_in,
        rename_workspace_path_in,
    )
}

pub(super) fn workspace_save_to_test_hook_with_ops<F, G, H, I, J>(
    path: &Path,
    value: &Value,
    before_rename: F,
    mut sync_transaction_directory: G,
    mut restore_workspace_backup: H,
    create_rollback_backup: I,
    mut rename_workspace_path: J,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
    G: FnMut(&Path) -> Result<(), String>,
    H: FnMut(&Path, &Path) -> Result<(), String>,
    I: FnOnce(&Path, &Path) -> Result<(), String>,
    J: FnMut(&Path, &Path) -> Result<(), String>,
{
    save_workspace_to_inner(
        path,
        value,
        before_rename,
        |_| Ok(()),
        |_| Ok(()),
        move |workspace_dir, parent| {
            sync_transaction_directory(parent)?;
            workspace_dir.sync()
        },
        move |workspace_dir, backup, destination| {
            restore_workspace_backup(backup, destination)?;
            restore_workspace_backup_in(workspace_dir, backup, destination)
        },
        move |workspace_dir, source, backup| {
            create_rollback_backup(source, backup)?;
            create_rollback_backup_in(workspace_dir, source, backup)
        },
        create_rollback_backup_in,
        move |workspace_dir, source, destination| {
            rename_workspace_path(source, destination)?;
            rename_workspace_path_in(workspace_dir, source, destination)
        },
    )
}

pub(super) fn workspace_save_to_test_hook_with_parent_sync<G>(
    path: &Path,
    value: &Value,
    sync_created_directory: G,
) -> Result<(), String>
where
    G: FnMut(&Path) -> Result<(), String>,
{
    save_workspace_to_inner(
        path,
        value,
        |_| Ok(()),
        |_| Ok(()),
        sync_created_directory,
        sync_workspace_directory,
        restore_workspace_backup_in,
        create_rollback_backup_in,
        create_rollback_backup_in,
        rename_workspace_path_in,
    )
}
