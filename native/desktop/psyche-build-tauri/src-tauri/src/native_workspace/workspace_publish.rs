//! Atomic publication: staging a new document and committing the swap.
//!
//! The write half of the workspace transaction. `stage_and_publish_workspace`
//! writes the document to a temp file, opens a rollback marker, verifies the
//! inode and renames it into place; `mark_rollback_committed` then promotes
//! the pending marker to committed, which is the point the save becomes
//! durable.
//!
//! **It publishes; it does not decide.** Nothing here inspects markers to work
//! out what state a workspace was left in. That is the recovery layer, still
//! in the parent, which calls `mark_rollback_committed` once it has decided.
//!
//! Eleven of the twenty-two functions in this set\'s dependency closure stayed
//! behind. `sync_parent_directory` alone has sixteen callers outside
//! publication, and the artifact read helpers are shared with the load path.
//! They are layers beneath publication rather than parts of it.
//!
//! Watch the parameter names here. `sync_parent_directory`,
//! `create_rollback_backup` and `recreate_pending_rollback` are closure
//! parameters in these functions *and* free functions elsewhere in the module.
//! The imports below name only what is genuinely called, and the compiler —
//! not a name match — decided which those are.

#[cfg(test)]
use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::Path;

use super::secure_fs::{
    hard_link_workspace_path, open_new_workspace_file, regular_file_exists,
    require_new_regular_file_path, verify_opened_regular_file,
};
use super::workspace_paths::workspace_temp_path;
use super::workspace_restore::create_rollback_backup_in;
use super::{
    create_absent_rollback_marker_in, read_workspace_artifact_bytes, restore_prior_workspace_state,
    rollback_workspace_after_failed_save, workspace_file_exists_in, SecureWorkspaceDir,
    TempFileGuard,
};

#[cfg(test)]
use super::POST_VERIFICATION_PRE_RENAME_REPLACEMENT;

/// What a published save hands to its commit phase.
///
/// The publication sequence has to tell the commit phase four things it cannot
/// re-derive: which rollback marker the transaction opened (a prior workspace
/// and an absent one use different pairs), whether there was a prior workspace
/// at all, its bytes if so, and the temp file still open for the identity
/// checks that follow. Returning them as one named value keeps the seam
/// readable; as a tuple it is five anonymous positions.
pub(super) struct PublishedWorkspace<'a> {
    /// The published file, still open, for post-publication verification.
    pub(super) file: File,
    /// Whether a workspace existed before this save.
    pub(super) had_workspace: bool,
    /// The rollback marker this transaction opened, and its committed name.
    pub(super) pending_path: &'a Path,
    pub(super) committed_path: &'a Path,
    /// The prior document, retained only when there was one to restore.
    pub(super) prior_bytes: Option<Vec<u8>>,
}

/// Writes the new document to a temp file and publishes it over the workspace.
///
/// Extracted from `save_workspace_to_inner` so the publication sequence can be
/// read as one unit: stage, open the rollback transaction, verify, rename,
/// sync.
///
/// Rollback is guaranteed from the point the pending marker is durable, not
/// from the point the transaction opens. Once the first `sync_parent_directory`
/// succeeds, every later failure — the inode check, the rename, the final sync
/// — calls `rollback_workspace_after_failed_save` before returning. Before that
/// sync, failures return without rolling back: `create_forward_rollback_in` and
/// the sync itself propagate directly.
///
/// That asymmetry is the design, not a gap. A marker that was never synced may
/// not have reached the disk, so there is nothing a rollback here could rely on
/// having found. Whatever did land is resolved by
/// `recover_pending_rollback_state`, which runs at the start of the next save
/// before anything is written.
///
/// `TempFileGuard` lives and dies inside this function. It unlinks the temp
/// file unless committed, and the commit happens here after the rename, so the
/// guard never crosses the boundary and the cleanup point is unchanged.
#[allow(clippy::too_many_arguments)]
pub(super) fn stage_and_publish_workspace<'a>(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    parent: &Path,
    file_name: &str,
    bytes: &[u8],
    pending_path: &'a Path,
    committed_path: &'a Path,
    absent_pending_path: &'a Path,
    absent_committed_path: &'a Path,
    forward_path: &Path,
    before_rename: impl FnOnce(&Path) -> Result<(), String>,
    before_publication: impl FnOnce(&Path) -> Result<(), String>,
    create_rollback_backup: impl FnOnce(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    rename_workspace_path: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<PublishedWorkspace<'a>, String> {
    let temp_path = workspace_temp_path(parent, file_name);
    let mut temp_file = open_temp_file_in(workspace_dir, &temp_path)?;
    let mut temp_guard = TempFileGuard::new(workspace_dir, temp_path.clone());

    temp_file.write_all(bytes).map_err(|e| {
        format!(
            "write workspace temp '{}': {}",
            temp_guard.path.display(),
            e
        )
    })?;
    temp_file.flush().map_err(|e| {
        format!(
            "flush workspace temp '{}': {}",
            temp_guard.path.display(),
            e
        )
    })?;
    temp_file
        .sync_all()
        .map_err(|e| format!("sync workspace temp '{}': {}", temp_guard.path.display(), e))?;

    before_rename(temp_guard.path.as_path())?;

    let had_workspace = workspace_file_exists_in(workspace_dir, path)?;
    let (transaction_pending_path, transaction_committed_path, prior_workspace_bytes) =
        if had_workspace {
            create_rollback_backup(workspace_dir, path, pending_path)?;
            (
                pending_path,
                committed_path,
                Some(read_workspace_artifact_bytes(
                    workspace_dir,
                    pending_path,
                    "workspace pending rollback",
                )?),
            )
        } else {
            create_absent_rollback_marker_in(workspace_dir, absent_pending_path)?;
            (absent_pending_path, absent_committed_path, None)
        };
    create_forward_rollback_in(
        workspace_dir,
        &temp_file,
        temp_guard.path.as_path(),
        forward_path,
    )?;
    if let Err(error) = sync_parent_directory(workspace_dir, parent) {
        return Err(format!(
            "publish pending workspace rollback '{}': {}",
            transaction_pending_path.display(),
            error
        ));
    }

    if let Err(identity_error) = verify_opened_regular_file(
        workspace_dir,
        &temp_file,
        temp_guard.path.as_path(),
        "workspace temp",
    ) {
        let restore_error = rollback_workspace_after_failed_save(
            workspace_dir,
            path,
            parent,
            transaction_pending_path,
            transaction_committed_path,
            sync_parent_directory,
            restore_workspace_backup,
            rename_workspace_path,
        );
        if let Err(restore_error) = restore_error {
            return Err(format!("{identity_error}; {restore_error}"));
        }
        return Err(identity_error);
    }

    if let Err(replace_error) = publish_opened_workspace_file(
        workspace_dir,
        &temp_file,
        temp_guard.path.as_path(),
        path,
        "workspace temp",
        "workspace",
        before_publication,
        rename_workspace_path,
    ) {
        let restore_error = rollback_workspace_after_failed_save(
            workspace_dir,
            path,
            parent,
            transaction_pending_path,
            transaction_committed_path,
            sync_parent_directory,
            restore_workspace_backup,
            rename_workspace_path,
        );
        if let Err(restore_error) = restore_error {
            return Err(format!("{replace_error}; {restore_error}"));
        }
        return Err(replace_error);
    }
    temp_guard.commit();

    if let Err(save_error) = sync_parent_directory(workspace_dir, parent) {
        if let Err(restore_error) = rollback_workspace_after_failed_save(
            workspace_dir,
            path,
            parent,
            transaction_pending_path,
            transaction_committed_path,
            sync_parent_directory,
            restore_workspace_backup,
            rename_workspace_path,
        ) {
            return Err(format!("{save_error}; {restore_error}"));
        }
        return Err(save_error);
    }

    Ok(PublishedWorkspace {
        file: temp_file,
        had_workspace,
        pending_path: transaction_pending_path,
        committed_path: transaction_committed_path,
        prior_bytes: prior_workspace_bytes,
    })
}

fn rename_regular_workspace_path(
    workspace_dir: &SecureWorkspaceDir,
    source: &Path,
    destination: &Path,
    source_context: &str,
    destination_context: &str,
    rename: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if !regular_file_exists(workspace_dir, source, source_context)? {
        return Err(format!(
            "{source_context} '{}' is missing",
            source.display()
        ));
    }
    regular_file_exists(workspace_dir, destination, destination_context)?;
    rename(workspace_dir, source, destination)?;
    if !regular_file_exists(workspace_dir, destination, destination_context)? {
        return Err(format!(
            "{destination_context} '{}' is missing after rename",
            destination.display()
        ));
    }
    Ok(())
}

fn publish_opened_workspace_file(
    workspace_dir: &SecureWorkspaceDir,
    source_file: &File,
    source: &Path,
    destination: &Path,
    source_context: &str,
    destination_context: &str,
    before_publication: impl FnOnce(&Path) -> Result<(), String>,
    rename: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if !regular_file_exists(workspace_dir, source, source_context)? {
        return Err(format!(
            "{source_context} '{}' is missing",
            source.display()
        ));
    }
    regular_file_exists(workspace_dir, destination, destination_context)?;
    before_publication(source)?;
    verify_opened_regular_file(workspace_dir, source_file, source, source_context)?;
    #[cfg(test)]
    run_post_verification_pre_rename_fault(source)?;
    rename(workspace_dir, source, destination)?;
    verify_opened_regular_file(workspace_dir, source_file, destination, source_context).map_err(
        |error| {
            format!(
                "verify published {destination_context} '{}': {}",
                destination.display(),
                error
            )
        },
    )
}

#[cfg(test)]
pub(super) fn open_temp_file(path: &Path) -> Result<File, String> {
    let workspace_dir = SecureWorkspaceDir::open_for_load(path)?
        .ok_or_else(|| format!("workspace parent '{}' is missing", path.display()))?;
    open_temp_file_in(&workspace_dir, path)
}

fn open_temp_file_in(workspace_dir: &SecureWorkspaceDir, path: &Path) -> Result<File, String> {
    open_new_workspace_file(workspace_dir, path, "temp")
}

fn create_forward_rollback_in(
    workspace_dir: &SecureWorkspaceDir,
    source_file: &File,
    source_path: &Path,
    forward_path: &Path,
) -> Result<(), String> {
    require_new_regular_file_path(workspace_dir, forward_path, "workspace forward rollback")?;
    hard_link_workspace_path(workspace_dir, source_path, forward_path).map_err(|error| {
        format!(
            "create workspace forward rollback '{}' from '{}': {}",
            forward_path.display(),
            source_path.display(),
            error
        )
    })?;
    verify_opened_regular_file(
        workspace_dir,
        source_file,
        forward_path,
        "workspace forward rollback",
    )
}

pub(super) fn mark_rollback_committed(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    pending_path: &Path,
    committed_path: &Path,
    parent: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    rename_workspace_path: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let mut recreate_pending_rollback = create_rollback_backup_in;
    mark_rollback_committed_with(
        workspace_dir,
        path,
        pending_path,
        committed_path,
        parent,
        sync_parent_directory,
        restore_workspace_backup,
        &mut recreate_pending_rollback,
        rename_workspace_path,
    )
}

pub(super) fn mark_rollback_committed_with(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    pending_path: &Path,
    committed_path: &Path,
    parent: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    recreate_pending_rollback: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    rename_workspace_path: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if !regular_file_exists(workspace_dir, pending_path, "workspace pending rollback")? {
        return Err(format!(
            "cannot commit workspace rollback because pending marker '{}' is missing",
            pending_path.display()
        ));
    }
    if regular_file_exists(
        workspace_dir,
        committed_path,
        "workspace committed rollback",
    )? {
        return Err(format!(
            "cannot commit pending rollback '{}': committed rollback '{}' already exists",
            pending_path.display(),
            committed_path.display()
        ));
    }

    if let Err(error) = rename_regular_workspace_path(
        workspace_dir,
        pending_path,
        committed_path,
        "workspace pending rollback",
        "workspace committed rollback",
        rename_workspace_path,
    ) {
        if regular_file_exists(workspace_dir, pending_path, "workspace pending rollback")? {
            return Err(format!(
                "mark pending rollback '{}' as committed '{}': {}; pending rollback retained at '{}'",
                pending_path.display(),
                committed_path.display(),
                error,
                pending_path.display()
            ));
        }
        if regular_file_exists(
            workspace_dir,
            committed_path,
            "workspace committed rollback",
        )? {
            return preserve_pending_after_uncertain_commit(
                workspace_dir,
                path,
                pending_path,
                committed_path,
                parent,
                format!(
                    "mark pending rollback '{}' as committed '{}': {}",
                    pending_path.display(),
                    committed_path.display(),
                    error
                ),
                sync_parent_directory,
                restore_workspace_backup,
                recreate_pending_rollback,
            );
        }
        return Err(format!(
            "mark pending rollback '{}' as committed '{}': {}; neither recovery marker remains",
            pending_path.display(),
            committed_path.display(),
            error
        ));
    }

    let marker_sync_error = match sync_parent_directory(workspace_dir, parent) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    preserve_pending_after_uncertain_commit(
        workspace_dir,
        path,
        pending_path,
        committed_path,
        parent,
        format!(
            "sync committed rollback marker '{}': {}",
            committed_path.display(),
            marker_sync_error
        ),
        sync_parent_directory,
        restore_workspace_backup,
        recreate_pending_rollback,
    )
}

fn preserve_pending_after_uncertain_commit(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    pending_path: &Path,
    committed_path: &Path,
    parent: &Path,
    failure: String,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    recreate_pending_rollback: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    match recreate_pending_rollback(workspace_dir, committed_path, pending_path) {
        Ok(()) => match sync_parent_directory(workspace_dir, parent) {
            Ok(()) => Err(format!(
                "{failure}; pending rollback durably preserved at '{}'",
                pending_path.display()
            )),
            Err(sync_error) => restore_prior_workspace_after_uncertain_commit(
                workspace_dir,
                path,
                pending_path,
                committed_path,
                parent,
                format!(
                    "{failure}; sync preserved pending rollback '{}': {}",
                    pending_path.display(),
                    sync_error
                ),
                sync_parent_directory,
                restore_workspace_backup,
            ),
        },
        Err(preserve_error) => restore_prior_workspace_after_uncertain_commit(
            workspace_dir,
            path,
            pending_path,
            committed_path,
            parent,
            format!(
                "{failure}; preserve pending rollback '{}': {}",
                pending_path.display(),
                preserve_error
            ),
            sync_parent_directory,
            restore_workspace_backup,
        ),
    }
}

fn restore_prior_workspace_after_uncertain_commit(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    pending_path: &Path,
    committed_path: &Path,
    parent: &Path,
    failure: String,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
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
                "{failure}; cannot restore prior workspace because neither recovery marker remains"
            ));
        };

    restore_prior_workspace_state(workspace_dir, recovery_path, path, restore_workspace_backup)
        .map_err(|error| {
            format!(
                "{failure}; restore prior workspace '{}' from '{}': {}",
                path.display(),
                recovery_path.display(),
                error
            )
        })?;
    sync_parent_directory(workspace_dir, parent).map_err(|error| {
        format!(
            "{failure}; sync restored prior workspace '{}': {}",
            path.display(),
            error
        )
    })?;
    Err(format!(
        "{failure}; prior workspace restored from '{}'",
        recovery_path.display()
    ))
}

#[cfg(test)]
fn run_post_verification_pre_rename_fault(path: &Path) -> Result<(), String> {
    POST_VERIFICATION_PRE_RENAME_REPLACEMENT.with(|replacement| {
        let Some(replacement) = replacement.borrow_mut().take() else {
            return Ok(());
        };
        fs::remove_file(path).map_err(|error| error.to_string())?;
        fs::write(path, replacement).map_err(|error| error.to_string())
    })
}
