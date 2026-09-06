//! The workspace's path vocabulary.
//!
//! Every on-disk artifact the persistence layer creates — the workspace file
//! itself, its lock, the four rollback markers, the forward-commit marker, and
//! the temp, candidate and restore scratch names — is named by a function in
//! this module. Collecting them here means the naming scheme can be read in
//! one place instead of inferred from format strings scattered across eight
//! thousand lines.
//!
//! Two properties are worth preserving deliberately, because both are easy to
//! lose and neither is enforced by the compiler.
//!
//! **This module performs no I/O.** These functions derive names; they never
//! ask the filesystem whether the names exist. That is what lets them be
//! called freely, in any order, without a `SecureWorkspaceDir` and without
//! TOCTOU consequences. `validate_workspace_artifact_paths` and
//! `rollback_candidate_paths` were considered for this module and deliberately
//! left in the parent: they consult the filesystem through `secure_fs`, so
//! moving them here would have made the boundary a label rather than a fact.
//!
//! **It borrows nothing from the parent.** It owns `WORKSPACE_FILE_RELATIVE`
//! and `TEMP_COUNTER` outright, because no code outside this set used either.
//! There is no `use super::` at the top of this file, and adding one should be
//! treated as a signal that the moved code has stopped being pure derivation.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const WORKSPACE_FILE_RELATIVE: &str = ".psyche/macos-app/workspace-v3.json";

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) fn workspace_default_path() -> Result<PathBuf, String> {
    workspace_path_from_home()
}

fn workspace_path_from_home() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is not set".to_string())?;
    Ok(Path::new(&home).join(WORKSPACE_FILE_RELATIVE))
}

pub(super) fn workspace_temp_path(parent: &Path, file_name: &str) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(
        ".{}.psyche-save-{}-{}",
        file_name,
        std::process::id(),
        counter
    ))
}

pub(super) fn workspace_lock_path(parent: &Path, file_name: &str) -> PathBuf {
    parent.join(format!(".{file_name}.psyche-lock"))
}

pub(super) fn workspace_rollback_pending_path(parent: &Path, file_name: &str) -> PathBuf {
    parent.join(format!(".{file_name}.psyche-rollback.pending"))
}

pub(super) fn workspace_rollback_committed_path(parent: &Path, file_name: &str) -> PathBuf {
    parent.join(format!(".{file_name}.psyche-rollback.committed"))
}

pub(super) fn workspace_absent_rollback_pending_path(parent: &Path, file_name: &str) -> PathBuf {
    parent.join(format!(".{file_name}.psyche-rollback.absent.pending"))
}

pub(super) fn workspace_absent_rollback_committed_path(parent: &Path, file_name: &str) -> PathBuf {
    parent.join(format!(".{file_name}.psyche-rollback.absent.committed"))
}

pub(super) fn workspace_forward_rollback_path(parent: &Path, file_name: &str) -> PathBuf {
    parent.join(format!(".{file_name}.psyche-rollback.forward"))
}

pub(super) fn absent_rollback_marker_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.ends_with(".psyche-rollback.absent.pending")
                || name.ends_with(".psyche-rollback.absent.committed")
        })
}

pub(super) fn workspace_rollback_candidate_prefix(file_name: &str) -> String {
    format!(".{file_name}.psyche-rollback.candidate-")
}

pub(super) fn workspace_rollback_candidate_path(pending_path: &Path) -> Result<PathBuf, String> {
    let parent = pending_path.parent().ok_or_else(|| {
        format!(
            "workspace rollback path has no parent directory: {}",
            pending_path.display()
        )
    })?;
    let pending_name = pending_path
        .file_name()
        .ok_or_else(|| {
            format!(
                "workspace rollback path has no file name: {}",
                pending_path.display()
            )
        })?
        .to_string_lossy();
    let prefix = pending_name
        .strip_suffix("absent.pending")
        .or_else(|| pending_name.strip_suffix("pending"))
        .ok_or_else(|| {
            format!(
                "workspace pending rollback has an unexpected name: {}",
                pending_path.display()
            )
        })?;
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    Ok(parent.join(format!(
        "{prefix}candidate-{}-{}",
        std::process::id(),
        counter
    )))
}

pub(super) fn workspace_restore_candidate_path(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("workspace path has no parent directory: {}", path.display()))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("workspace path has no file name: {}", path.display()))?
        .to_string_lossy();
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    Ok(parent.join(format!(
        ".{file_name}.psyche-restore-{}-{counter}",
        std::process::id()
    )))
}
