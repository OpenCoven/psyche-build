//! The absent-workspace marker protocol.
//!
//! When a save creates a workspace where none existed, there is no prior file
//! to copy into a rollback backup. The transaction records that fact in a
//! marker file instead, and these seven functions are the only code that
//! writes or reads one: `create_absent_rollback_marker_in` and
//! `declare_absent_*` write, `absent_rollback_resolution` and
//! `read_absent_marker_resolution` read.
//!
//! Every write goes through `write_absent_marker`, which re-opens and verifies
//! the file it just wrote before returning. That is why the marker payloads
//! and their size limit live here: nothing else in the tree should be
//! producing bytes that this protocol will later parse.
//!
//! **The vocabulary is deliberately split.** `AbsentMarkerRead` moved because
//! only this module uses it. `AbsentRollbackResolution` and
//! `AbsentRollbackInterpretation` did not, because three recovery functions in
//! the parent read them — they are the protocol's output type, and the
//! recovery layer is the consumer. They should follow recovery when it moves,
//! not lead it.
//!
//! `run_marker_file_fault` also stayed. It faults marker writes, so by subject
//! it belongs here, but `certify_initial_forward_recovery` calls it too;
//! importing it downward keeps the dependency in the same direction as every
//! other module here rather than adding a `#[cfg(test)]` import back up.

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use super::secure_fs::{
    open_existing_regular_file, open_new_workspace_file, verify_opened_regular_file,
};
use super::{
    AbsentRollbackInterpretation, AbsentRollbackResolution, SecureWorkspaceDir, TempFileGuard,
    ABSENT_FORWARD_MARKER,
};

#[cfg(test)]
use super::{run_marker_file_fault, MarkerFileOperation};

const ABSENT_ROLLBACK_MARKER: &[u8] = b"psyche-workspace-absent-rollback-v1\n";

const ABSENT_MARKER_SIZE_LIMIT: u64 = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AbsentMarkerRead {
    Missing,
    Resolved(AbsentRollbackResolution),
    Malformed,
}

pub(super) fn create_absent_rollback_marker_in(
    workspace_dir: &SecureWorkspaceDir,
    marker_path: &Path,
) -> Result<(), String> {
    let mut marker = open_new_workspace_file(workspace_dir, marker_path, "absent rollback marker")?;
    let mut marker_guard = TempFileGuard::new(workspace_dir, marker_path.to_path_buf());
    write_absent_marker(
        workspace_dir,
        &mut marker,
        marker_path,
        ABSENT_ROLLBACK_MARKER,
    )?;
    marker_guard.commit();
    Ok(())
}

fn write_absent_marker(
    workspace_dir: &SecureWorkspaceDir,
    marker: &mut File,
    marker_path: &Path,
    payload: &[u8],
) -> Result<(), String> {
    marker.set_len(0).map_err(|error| {
        format!(
            "truncate absent workspace rollback marker '{}': {}",
            marker_path.display(),
            error
        )
    })?;
    #[cfg(test)]
    run_marker_file_fault(MarkerFileOperation::Write, marker, marker_path, payload)?;
    marker.write_all(payload).map_err(|error| {
        format!(
            "write absent workspace rollback marker '{}': {}",
            marker_path.display(),
            error
        )
    })?;
    marker.flush().map_err(|error| {
        format!(
            "flush absent workspace rollback marker '{}': {}",
            marker_path.display(),
            error
        )
    })?;
    #[cfg(test)]
    run_marker_file_fault(MarkerFileOperation::Sync, marker, marker_path, payload)?;
    marker.sync_all().map_err(|error| {
        format!(
            "sync absent workspace rollback marker '{}': {}",
            marker_path.display(),
            error
        )
    })?;
    verify_opened_regular_file(
        workspace_dir,
        marker,
        marker_path,
        "workspace absent rollback marker",
    )
}

pub(super) fn declare_absent_forward_commit(
    workspace_dir: &SecureWorkspaceDir,
    pending_path: &Path,
    committed_path: &Path,
) -> Result<(), String> {
    declare_absent_resolution(
        workspace_dir,
        pending_path,
        committed_path,
        ABSENT_FORWARD_MARKER,
        "forward workspace commit",
    )
}

pub(super) fn declare_absent_rollback(
    workspace_dir: &SecureWorkspaceDir,
    pending_path: &Path,
    committed_path: &Path,
) -> Result<(), String> {
    declare_absent_resolution(
        workspace_dir,
        pending_path,
        committed_path,
        ABSENT_ROLLBACK_MARKER,
        "workspace rollback",
    )
}

fn declare_absent_resolution(
    workspace_dir: &SecureWorkspaceDir,
    pending_path: &Path,
    committed_path: &Path,
    payload: &[u8],
    resolution: &str,
) -> Result<(), String> {
    let mut marker_found = false;
    for marker_path in [pending_path, committed_path] {
        let Some(mut marker) = open_existing_regular_file(
            workspace_dir,
            marker_path,
            "workspace absent rollback marker",
            true,
        )?
        else {
            continue;
        };
        marker_found = true;
        write_absent_marker(workspace_dir, &mut marker, marker_path, payload)?;
    }
    if marker_found {
        Ok(())
    } else {
        Err(format!(
            "cannot declare {resolution} because neither marker '{}' nor '{}' remains",
            pending_path.display(),
            committed_path.display()
        ))
    }
}

pub(super) fn absent_rollback_resolution(
    workspace_dir: &SecureWorkspaceDir,
    pending_path: &Path,
    committed_path: &Path,
) -> Result<AbsentRollbackInterpretation, String> {
    let pending = read_absent_marker_resolution(workspace_dir, pending_path, false)?;
    let committed = read_absent_marker_resolution(workspace_dir, committed_path, true)?;
    if matches!(
        pending,
        AbsentMarkerRead::Resolved(AbsentRollbackResolution::Rollback)
    ) || matches!(
        committed,
        AbsentMarkerRead::Resolved(AbsentRollbackResolution::Rollback)
    ) {
        return Ok(AbsentRollbackInterpretation::Resolved(
            AbsentRollbackResolution::Rollback,
        ));
    }
    if matches!(
        pending,
        AbsentMarkerRead::Resolved(AbsentRollbackResolution::Forward {
            require_candidate: true
        })
    ) || matches!(
        committed,
        AbsentMarkerRead::Resolved(AbsentRollbackResolution::Forward {
            require_candidate: true
        })
    ) {
        return Ok(AbsentRollbackInterpretation::Resolved(
            AbsentRollbackResolution::Forward {
                require_candidate: true,
            },
        ));
    }
    if matches!(
        pending,
        AbsentMarkerRead::Resolved(AbsentRollbackResolution::Forward {
            require_candidate: false
        })
    ) || matches!(
        committed,
        AbsentMarkerRead::Resolved(AbsentRollbackResolution::Forward {
            require_candidate: false
        })
    ) {
        return Ok(AbsentRollbackInterpretation::Resolved(
            AbsentRollbackResolution::Forward {
                require_candidate: false,
            },
        ));
    }
    if matches!(pending, AbsentMarkerRead::Malformed)
        || matches!(committed, AbsentMarkerRead::Malformed)
    {
        return Ok(AbsentRollbackInterpretation::Ambiguous);
    }
    Ok(AbsentRollbackInterpretation::Missing)
}

fn read_absent_marker_resolution(
    workspace_dir: &SecureWorkspaceDir,
    marker_path: &Path,
    legacy_forward: bool,
) -> Result<AbsentMarkerRead, String> {
    let Some(mut marker) = open_existing_regular_file(
        workspace_dir,
        marker_path,
        "workspace absent rollback marker",
        false,
    )?
    else {
        return Ok(AbsentMarkerRead::Missing);
    };
    let marker_size = marker
        .metadata()
        .map_err(|error| {
            format!(
                "inspect absent workspace rollback marker '{}': {}",
                marker_path.display(),
                error
            )
        })?
        .len();
    if marker_size > ABSENT_MARKER_SIZE_LIMIT {
        return Ok(AbsentMarkerRead::Malformed);
    }
    let mut payload = Vec::with_capacity(marker_size as usize);
    marker.read_to_end(&mut payload).map_err(|error| {
        format!(
            "read absent workspace rollback marker '{}': {}",
            marker_path.display(),
            error
        )
    })?;
    match payload.as_slice() {
        ABSENT_ROLLBACK_MARKER => Ok(AbsentMarkerRead::Resolved(
            AbsentRollbackResolution::Rollback,
        )),
        ABSENT_FORWARD_MARKER => Ok(AbsentMarkerRead::Resolved(
            AbsentRollbackResolution::Forward {
                require_candidate: true,
            },
        )),
        [] if legacy_forward => Ok(AbsentMarkerRead::Resolved(
            AbsentRollbackResolution::Forward {
                require_candidate: false,
            },
        )),
        [] => Ok(AbsentMarkerRead::Resolved(
            AbsentRollbackResolution::Rollback,
        )),
        _ => Ok(AbsentMarkerRead::Malformed),
    }
}
