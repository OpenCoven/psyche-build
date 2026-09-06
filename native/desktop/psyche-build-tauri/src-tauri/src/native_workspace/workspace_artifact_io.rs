//! Reading and verifying the bytes of a workspace artifact.
//!
//! Five functions the load path, the save path, publication and recovery all
//! share: read an artifact within the size limit, confirm its contents still
//! match what was written, and parse-and-validate a document. Every read of a
//! workspace file in this module goes through one of them.
//!
//! Step 3 (#370) identified these as a group and deliberately left them in the
//! parent rather than filing them under `workspace_restore`, because naming a
//! shared utility after one of its consumers is a boundary in name only.
//! `verify_workspace_artifact_bytes` alone has twenty callers.
//!
//! The size limit is the point of `read_bounded_workspace_file`. It checks the
//! metadata length first and then caps the read itself, because a file can
//! grow between the two, so the metadata check alone would not bound what is
//! actually read into memory.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde_json::Value;

use super::secure_fs::{open_existing_regular_file, verify_opened_regular_file};
use super::{validate_workspace, SecureWorkspaceDir, WORKSPACE_DOCUMENT_SIZE_LIMIT};

pub(super) fn read_workspace_artifact_bytes(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    context: &str,
) -> Result<Vec<u8>, String> {
    let Some(mut file) = open_existing_regular_file(workspace_dir, path, context, false)? else {
        return Err(format!("{context} '{}' is missing", path.display()));
    };
    read_bounded_workspace_file(&mut file, path, context)
}

pub(super) fn read_bounded_workspace_file(
    file: &mut File,
    path: &Path,
    context: &str,
) -> Result<Vec<u8>, String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("inspect {context} '{}': {}", path.display(), error))?;
    if metadata.len() > WORKSPACE_DOCUMENT_SIZE_LIMIT {
        return Err(format!(
            "{context} '{}' is too large: {} bytes (limit {})",
            path.display(),
            metadata.len(),
            WORKSPACE_DOCUMENT_SIZE_LIMIT
        ));
    }

    let capacity = usize::try_from(metadata.len()).map_err(|_| {
        format!(
            "{context} '{}' is too large for this platform",
            path.display()
        )
    })?;
    let mut bytes = Vec::with_capacity(capacity);
    Read::by_ref(file)
        .take(WORKSPACE_DOCUMENT_SIZE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read {context} '{}': {}", path.display(), error))?;
    if bytes.len() as u64 > WORKSPACE_DOCUMENT_SIZE_LIMIT {
        return Err(format!(
            "{context} '{}' exceeded the {} byte limit while reading",
            path.display(),
            WORKSPACE_DOCUMENT_SIZE_LIMIT
        ));
    }
    Ok(bytes)
}

pub(super) fn verify_workspace_artifact_bytes(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    expected_bytes: &[u8],
    context: &str,
) -> Result<(), String> {
    let actual = read_workspace_artifact_bytes(workspace_dir, path, context)?;
    if actual != expected_bytes {
        return Err(format!("{context} '{}' changed contents", path.display()));
    }
    Ok(())
}

pub(super) fn verify_opened_workspace_artifact(
    workspace_dir: &SecureWorkspaceDir,
    file: &File,
    path: &Path,
    expected_bytes: &[u8],
    context: &str,
) -> Result<(), String> {
    verify_opened_regular_file(workspace_dir, file, path, context)?;
    verify_workspace_artifact_bytes(workspace_dir, path, expected_bytes, context)
}

pub(super) fn validate_workspace_artifact_bytes(
    bytes: &[u8],
    path: &Path,
    context: &str,
) -> Result<(), String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("parse {context} '{}': {}", path.display(), error))?;
    validate_workspace(&value)
        .map_err(|error| format!("validate {context} '{}': {}", path.display(), error))
}
