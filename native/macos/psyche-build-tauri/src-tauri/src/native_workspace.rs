#[cfg(test)]
use std::cell::RefCell;
#[cfg(any(test, not(unix)))]
use std::fs;
use std::fs::File;
#[cfg(not(unix))]
use std::fs::OpenOptions;
#[cfg(test)]
use std::io::Seek;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::Value;

#[cfg(unix)]
use std::ffi::{CStr, CString, OsStr, OsString};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::{OsStrExt, OsStringExt};

const WORKSPACE_VERSION: i64 = 3;
const WORKSPACE_FILE_RELATIVE: &str = ".psyche/macos-app/workspace-v3.json";
const WORKSPACE_ROLLBACK_COPY_LIMIT: u64 = 16 * 1024 * 1024;
const ABSENT_ROLLBACK_MARKER: &[u8] = b"psyche-workspace-absent-rollback-v1\n";
const ABSENT_FORWARD_MARKER: &[u8] = b"psyche-workspace-forward-commit-v1\n";
const ABSENT_MARKER_SIZE_LIMIT: u64 = 128;
const WORKSPACE_RECOVERY_DECISION_ATTEMPTS: usize = 3;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static WORKSPACE_IO_MUTEX: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkspaceRecoveryDecision {
    Rollback,
    Forward,
}

pub(crate) fn workspace_path_from_home() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is not set".to_string())?;
    Ok(Path::new(&home).join(WORKSPACE_FILE_RELATIVE))
}

pub(crate) fn validate_workspace(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Err("workspace document must be a JSON object".to_string());
    };

    match object.get("version").and_then(|version| version.as_i64()) {
        Some(WORKSPACE_VERSION) => {}
        Some(other) => {
            return Err(format!(
                "unsupported workspace version: {other} (expected {WORKSPACE_VERSION})"
            ))
        }
        None => return Err("workspace version must be the integer 3".to_string()),
    }

    for field in ["projects", "sessions", "paneLayouts"] {
        match object.get(field) {
            Some(Value::Array(_)) => {}
            Some(_) => return Err(format!("workspace field '{field}' must be an array")),
            None => return Err(format!("workspace field '{field}' is missing")),
        }
    }

    Ok(())
}

pub(crate) fn load_workspace_from(path: &Path) -> Result<Option<Value>, String> {
    load_workspace_from_inner(path, || Ok(()))
}

fn load_workspace_from_inner<F>(
    path: &Path,
    before_exclusive_recovery: F,
) -> Result<Option<Value>, String>
where
    F: FnOnce() -> Result<(), String>,
{
    let _process_lock = WORKSPACE_IO_MUTEX.lock();
    let Some(parent) = path.parent() else {
        return Err(format!(
            "workspace path has no parent directory: {}",
            path.display()
        ));
    };
    let Some(workspace_dir) = SecureWorkspaceDir::open_for_load(path)? else {
        return Ok(None);
    };
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("workspace path has no file name: {}", path.display()))?
        .to_string_lossy()
        .to_string();
    let pending_path = workspace_rollback_pending_path(parent, &file_name);
    let committed_path = workspace_rollback_committed_path(parent, &file_name);
    let absent_pending_path = workspace_absent_rollback_pending_path(parent, &file_name);
    let absent_committed_path = workspace_absent_rollback_committed_path(parent, &file_name);
    let forward_path = workspace_forward_rollback_path(parent, &file_name);

    let shared_lock = WorkspaceFileLock::shared(&workspace_dir, path)?;
    validate_workspace_artifact_paths(&workspace_dir, path, parent, &file_name)?;
    let requires_recovery =
        regular_file_exists(&workspace_dir, &pending_path, "workspace pending rollback")?
            || regular_file_exists(
                &workspace_dir,
                &absent_pending_path,
                "workspace absent pending rollback",
            )?
            || regular_file_exists(
                &workspace_dir,
                &committed_path,
                "workspace committed rollback",
            )?
            || regular_file_exists(
                &workspace_dir,
                &absent_committed_path,
                "workspace absent committed rollback",
            )?
            || regular_file_exists(&workspace_dir, &forward_path, "workspace forward rollback")?
            || rollback_candidates_exist(&workspace_dir, parent, &file_name)?;
    if !requires_recovery {
        return load_workspace_from_locked_in(&workspace_dir, path);
    }

    drop(shared_lock);
    before_exclusive_recovery()?;
    let _exclusive_lock = WorkspaceFileLock::exclusive(&workspace_dir, path)?;
    validate_workspace_artifact_paths(&workspace_dir, path, parent, &file_name)?;

    let mut sync_directory = sync_workspace_directory;
    recover_pending_rollback_state(
        &workspace_dir,
        path,
        parent,
        pending_path.as_path(),
        committed_path.as_path(),
        absent_pending_path.as_path(),
        absent_committed_path.as_path(),
        forward_path.as_path(),
        &mut sync_directory,
        &mut restore_workspace_backup_in,
        &mut rename_workspace_path_in,
    )?;
    cleanup_committed_rollback(
        &workspace_dir,
        committed_path.as_path(),
        parent,
        &mut sync_directory,
    )?;
    cleanup_committed_rollback(
        &workspace_dir,
        absent_committed_path.as_path(),
        parent,
        &mut sync_directory,
    )?;
    cleanup_forward_rollback(
        &workspace_dir,
        forward_path.as_path(),
        parent,
        &mut sync_directory,
    )?;
    cleanup_rollback_candidates(&workspace_dir, parent, &file_name, &mut sync_directory)?;
    load_workspace_from_locked_in(&workspace_dir, path)
}

#[cfg(test)]
fn load_workspace_from_locked(path: &Path) -> Result<Option<Value>, String> {
    let Some(workspace_dir) = SecureWorkspaceDir::open_for_load(path)? else {
        return Ok(None);
    };
    load_workspace_from_locked_in(&workspace_dir, path)
}

fn load_workspace_from_locked_in(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
) -> Result<Option<Value>, String> {
    let mut bytes = Vec::new();
    match open_existing_regular_file(workspace_dir, path, "workspace", false)? {
        Some(mut file) => {
            file.read_to_end(&mut bytes)
                .map_err(|e| format!("read workspace '{}': {}", path.display(), e))?;
        }
        None => return Ok(None),
    }

    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("parse workspace '{}': {}", path.display(), e))?;
    validate_workspace(&value)
        .map_err(|e| format!("validate workspace '{}': {}", path.display(), e))?;
    Ok(Some(value))
}

pub(crate) fn save_workspace_to(path: &Path, value: &Value) -> Result<(), String> {
    save_workspace_to_inner(
        path,
        value,
        |_| Ok(()),
        |_| Ok(()),
        |_| Ok(()),
        sync_workspace_directory,
        restore_workspace_backup_in,
        create_rollback_backup_in,
        create_rollback_backup_in,
        rename_workspace_path_in,
    )
}

fn save_workspace_to_inner<F, L, K, G, H, I, J, M>(
    path: &Path,
    value: &Value,
    before_rename: F,
    before_publication: L,
    mut sync_created_directory: K,
    mut sync_parent_directory: G,
    mut restore_workspace_backup: H,
    create_rollback_backup: I,
    mut recreate_pending_rollback: J,
    mut rename_workspace_path: M,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
    L: FnOnce(&Path) -> Result<(), String>,
    K: FnMut(&Path) -> Result<(), String>,
    G: FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
    H: FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    I: FnOnce(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    J: FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    M: FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
{
    validate_workspace(value)
        .map_err(|e| format!("validate workspace '{}': {}", path.display(), e))?;
    let bytes = serde_json::to_vec(value)
        .map_err(|e| format!("serialize workspace '{}': {}", path.display(), e))?;

    let parent = path
        .parent()
        .ok_or_else(|| format!("workspace path has no parent directory: {}", path.display()))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("workspace path has no file name: {}", path.display()))?
        .to_string_lossy()
        .to_string();
    let _process_lock = WORKSPACE_IO_MUTEX.lock();
    let workspace_dir = SecureWorkspaceDir::prepare_for_save(path, &mut sync_created_directory)?;

    let _file_lock = WorkspaceFileLock::exclusive(&workspace_dir, path)?;
    validate_workspace_artifact_paths(&workspace_dir, path, parent, &file_name)?;

    let pending_path = workspace_rollback_pending_path(parent, &file_name);
    let committed_path = workspace_rollback_committed_path(parent, &file_name);
    let absent_pending_path = workspace_absent_rollback_pending_path(parent, &file_name);
    let absent_committed_path = workspace_absent_rollback_committed_path(parent, &file_name);
    let forward_path = workspace_forward_rollback_path(parent, &file_name);

    recover_pending_rollback_state(
        &workspace_dir,
        path,
        parent,
        pending_path.as_path(),
        committed_path.as_path(),
        absent_pending_path.as_path(),
        absent_committed_path.as_path(),
        forward_path.as_path(),
        &mut sync_parent_directory,
        &mut restore_workspace_backup,
        &mut rename_workspace_path,
    )?;
    cleanup_committed_rollback(
        &workspace_dir,
        committed_path.as_path(),
        parent,
        &mut sync_parent_directory,
    )?;
    cleanup_committed_rollback(
        &workspace_dir,
        absent_committed_path.as_path(),
        parent,
        &mut sync_parent_directory,
    )?;
    cleanup_forward_rollback(
        &workspace_dir,
        forward_path.as_path(),
        parent,
        &mut sync_parent_directory,
    )?;
    cleanup_rollback_candidates(
        &workspace_dir,
        parent,
        &file_name,
        &mut sync_parent_directory,
    )?;
    validate_workspace_artifact_paths(&workspace_dir, path, parent, &file_name)?;

    let temp_path = workspace_temp_path(parent, &file_name);
    let mut temp_file = open_temp_file_in(&workspace_dir, &temp_path)?;
    let mut temp_guard = TempFileGuard::new(&workspace_dir, temp_path.clone());

    temp_file.write_all(&bytes).map_err(|e| {
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

    let had_workspace = workspace_file_exists_in(&workspace_dir, path)?;
    let (transaction_pending_path, transaction_committed_path, prior_workspace_bytes) =
        if had_workspace {
            create_rollback_backup(&workspace_dir, path, pending_path.as_path())?;
            (
                pending_path.as_path(),
                committed_path.as_path(),
                Some(read_workspace_artifact_bytes(
                    &workspace_dir,
                    pending_path.as_path(),
                    "workspace pending rollback",
                )?),
            )
        } else {
            create_absent_rollback_marker_in(&workspace_dir, absent_pending_path.as_path())?;
            (
                absent_pending_path.as_path(),
                absent_committed_path.as_path(),
                None,
            )
        };
    create_forward_rollback_in(
        &workspace_dir,
        &temp_file,
        temp_guard.path.as_path(),
        forward_path.as_path(),
    )?;
    if let Err(error) = sync_parent_directory(&workspace_dir, parent) {
        return Err(format!(
            "publish pending workspace rollback '{}': {}",
            transaction_pending_path.display(),
            error
        ));
    }

    if let Err(identity_error) = verify_opened_regular_file(
        &workspace_dir,
        &temp_file,
        temp_guard.path.as_path(),
        "workspace temp",
    ) {
        let restore_error = rollback_workspace_after_failed_save(
            &workspace_dir,
            path,
            parent,
            transaction_pending_path,
            transaction_committed_path,
            &mut sync_parent_directory,
            &mut restore_workspace_backup,
            &mut rename_workspace_path,
        );
        if let Err(restore_error) = restore_error {
            return Err(format!("{identity_error}; {restore_error}"));
        }
        return Err(identity_error);
    }

    if let Err(replace_error) = publish_opened_workspace_file(
        &workspace_dir,
        &temp_file,
        temp_guard.path.as_path(),
        path,
        "workspace temp",
        "workspace",
        before_publication,
        &mut rename_workspace_path,
    ) {
        let restore_error = rollback_workspace_after_failed_save(
            &workspace_dir,
            path,
            parent,
            transaction_pending_path,
            transaction_committed_path,
            &mut sync_parent_directory,
            &mut restore_workspace_backup,
            &mut rename_workspace_path,
        );
        if let Err(restore_error) = restore_error {
            return Err(format!("{replace_error}; {restore_error}"));
        }
        return Err(replace_error);
    }
    temp_guard.commit();

    if let Err(save_error) = sync_parent_directory(&workspace_dir, parent) {
        if let Err(restore_error) = rollback_workspace_after_failed_save(
            &workspace_dir,
            path,
            parent,
            transaction_pending_path,
            transaction_committed_path,
            &mut sync_parent_directory,
            &mut restore_workspace_backup,
            &mut rename_workspace_path,
        ) {
            return Err(format!("{save_error}; {restore_error}"));
        }
        return Err(save_error);
    }

    let commit_result = mark_rollback_committed_with(
        &workspace_dir,
        path,
        transaction_pending_path,
        transaction_committed_path,
        parent,
        &mut sync_parent_directory,
        &mut restore_workspace_backup,
        &mut recreate_pending_rollback,
        &mut rename_workspace_path,
    );
    if had_workspace {
        return finish_prior_workspace_transaction(
            &workspace_dir,
            &temp_file,
            &bytes,
            prior_workspace_bytes
                .as_deref()
                .expect("existing workspace transaction must retain prior bytes"),
            path,
            parent,
            transaction_pending_path,
            transaction_committed_path,
            forward_path.as_path(),
            commit_result,
            &mut sync_parent_directory,
            &mut restore_workspace_backup,
            &mut recreate_pending_rollback,
        );
    }

    let commit_error = match commit_result {
        Ok(()) => match declare_absent_forward_commit(
            &workspace_dir,
            transaction_pending_path,
            transaction_committed_path,
        ) {
            Ok(()) => {
                return finish_initial_workspace_forward(
                    &workspace_dir,
                    &temp_file,
                    &bytes,
                    path,
                    parent,
                    transaction_pending_path,
                    transaction_committed_path,
                    forward_path.as_path(),
                    &mut sync_parent_directory,
                )
            }
            Err(error) => {
                if let Err(reset_error) = declare_absent_rollback(
                    &workspace_dir,
                    transaction_pending_path,
                    transaction_committed_path,
                ) {
                    let forward_error = commit_initial_workspace_forward(
                        &workspace_dir,
                        &temp_file,
                        &bytes,
                        path,
                        parent,
                        transaction_pending_path,
                        transaction_committed_path,
                        forward_path.as_path(),
                        &mut sync_parent_directory,
                    );
                    return match forward_error {
                        Ok(()) => Ok(()),
                        Err(forward_error) => resolve_initial_workspace_after_marker_failure(
                            &workspace_dir,
                            &temp_file,
                            &bytes,
                            path,
                            parent,
                            transaction_pending_path,
                            transaction_committed_path,
                            forward_path.as_path(),
                            format!(
                                "{error}; {reset_error}; forward resolution failed: {forward_error}"
                            ),
                            &mut sync_parent_directory,
                        ),
                    };
                }
                return match durably_restore_initial_absence(
                    &workspace_dir,
                    path,
                    parent,
                    transaction_pending_path,
                    transaction_committed_path,
                    &mut sync_parent_directory,
                    &mut restore_workspace_backup,
                ) {
                    Ok(()) => Err(error),
                    Err(rollback_error) => resolve_initial_workspace_after_marker_failure(
                        &workspace_dir,
                        &temp_file,
                        &bytes,
                        path,
                        parent,
                        transaction_pending_path,
                        transaction_committed_path,
                        forward_path.as_path(),
                        format!("{error}; restore reset absent rollback failed: {rollback_error}"),
                        &mut sync_parent_directory,
                    ),
                };
            }
        },
        Err(error) => error,
    };

    match rollback_workspace_after_failed_save(
        &workspace_dir,
        path,
        parent,
        transaction_pending_path,
        transaction_committed_path,
        &mut sync_parent_directory,
        &mut restore_workspace_backup,
        &mut rename_workspace_path,
    ) {
        Ok(()) => Err(commit_error),
        Err(rollback_error) => {
            match durably_restore_initial_absence(
                &workspace_dir,
                path,
                parent,
                transaction_pending_path,
                transaction_committed_path,
                &mut sync_parent_directory,
                &mut restore_workspace_backup,
            ) {
                Ok(()) => Err(format!("{commit_error}; {rollback_error}")),
                Err(retry_error) => match commit_initial_workspace_forward(
                    &workspace_dir,
                    &temp_file,
                    &bytes,
                    path,
                    parent,
                    transaction_pending_path,
                    transaction_committed_path,
                    forward_path.as_path(),
                    &mut sync_parent_directory,
                ) {
                    Ok(()) => Ok(()),
                    Err(forward_error) => resolve_initial_workspace_after_marker_failure(
                        &workspace_dir,
                        &temp_file,
                        &bytes,
                        path,
                        parent,
                        transaction_pending_path,
                        transaction_committed_path,
                        forward_path.as_path(),
                        format!(
                            "{commit_error}; {rollback_error}; {retry_error}; forward resolution failed: {forward_error}"
                        ),
                        &mut sync_parent_directory,
                    ),
                },
            }
        }
    }
}

struct SecureWorkspaceDir {
    display_path: PathBuf,
    #[cfg(unix)]
    directory: File,
}

impl SecureWorkspaceDir {
    fn open_for_load(path: &Path) -> Result<Option<Self>, String> {
        let parent = path
            .parent()
            .ok_or_else(|| format!("workspace path has no parent directory: {}", path.display()))?;
        #[cfg(unix)]
        {
            if let Some((home, psyche, app)) = app_owned_workspace_directories(parent) {
                let home_dir = PinnedDirectory {
                    display_path: home.clone(),
                    directory: open_directory_path_no_follow(&home, "HOME")?,
                };
                let Some(psyche_dir) =
                    open_directory_component(&home_dir, &psyche, false, false, &mut |_| Ok(()))?
                else {
                    return Ok(None);
                };
                let Some(app_dir) =
                    open_directory_component(&psyche_dir, &app, false, false, &mut |_| Ok(()))?
                else {
                    return Ok(None);
                };
                return Ok(Some(Self {
                    display_path: parent.to_path_buf(),
                    directory: app_dir.directory,
                }));
            }
            match open_directory_path_no_follow_optional(parent, "workspace parent")? {
                Some(directory) => Ok(Some(Self {
                    display_path: parent.to_path_buf(),
                    directory,
                })),
                None => Ok(None),
            }
        }
        #[cfg(not(unix))]
        {
            match fs::symlink_metadata(parent) {
                Ok(metadata) if metadata.is_dir() => Ok(Some(Self {
                    display_path: parent.to_path_buf(),
                })),
                Ok(_) => Err(format!(
                    "workspace parent '{}' must be a directory",
                    parent.display()
                )),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(format!(
                    "inspect workspace parent '{}': {}",
                    parent.display(),
                    error
                )),
            }
        }
    }

    fn prepare_for_save(
        path: &Path,
        sync_created_directory: &mut impl FnMut(&Path) -> Result<(), String>,
    ) -> Result<Self, String> {
        let parent = path
            .parent()
            .ok_or_else(|| format!("workspace path has no parent directory: {}", path.display()))?;
        #[cfg(unix)]
        {
            if let Some((home, psyche, app)) = app_owned_workspace_directories(parent) {
                let home_dir = PinnedDirectory {
                    display_path: home.clone(),
                    directory: open_directory_path_no_follow(&home, "HOME")?,
                };
                let psyche_dir = open_directory_component(
                    &home_dir,
                    &psyche,
                    true,
                    true,
                    sync_created_directory,
                )?
                .ok_or_else(|| {
                    format!(
                        "app-owned workspace directory '{}' is missing",
                        psyche.display()
                    )
                })?;
                let app_dir = open_directory_component(
                    &psyche_dir,
                    &app,
                    true,
                    true,
                    sync_created_directory,
                )?
                .ok_or_else(|| format!("workspace parent '{}' is missing", parent.display()))?;
                return Ok(Self {
                    display_path: parent.to_path_buf(),
                    directory: app_dir.directory,
                });
            }

            let directory = open_directory_path_no_follow(parent, "workspace parent")?;
            set_secure_directory_permissions_fd(&directory, parent)?;
            directory.sync_all().map_err(|error| {
                format!(
                    "sync workspace directory permissions '{}': {}",
                    parent.display(),
                    error
                )
            })?;
            Ok(Self {
                display_path: parent.to_path_buf(),
                directory,
            })
        }
        #[cfg(not(unix))]
        {
            prepare_workspace_parent_fallback(path, sync_created_directory)?;
            Ok(Self {
                display_path: parent.to_path_buf(),
            })
        }
    }

    #[cfg(unix)]
    fn child_name(&self, path: &Path, context: &str) -> Result<CString, String> {
        if path.parent() != Some(self.display_path.as_path()) {
            return Err(format!(
                "{context} '{}' is outside pinned workspace directory '{}'",
                path.display(),
                self.display_path.display()
            ));
        }
        let name = path
            .file_name()
            .ok_or_else(|| format!("{context} '{}' has no file name", path.display()))?;
        c_name(name).map_err(|error| format!("{context} '{}': {error}", path.display()))
    }

    fn sync(&self) -> Result<(), String> {
        #[cfg(unix)]
        {
            return self.directory.sync_all().map_err(|error| {
                format!(
                    "sync workspace parent '{}': {}",
                    self.display_path.display(),
                    error
                )
            });
        }
        #[cfg(not(unix))]
        {
            Ok(())
        }
    }
}

#[cfg(unix)]
struct PinnedDirectory {
    display_path: PathBuf,
    directory: File,
}

#[cfg(unix)]
fn app_owned_workspace_directories(parent: &Path) -> Option<(PathBuf, PathBuf, PathBuf)> {
    if parent.file_name()? != "macos-app" {
        return None;
    }
    let psyche = parent.parent()?;
    if psyche.file_name()? != ".psyche" {
        return None;
    }
    let home = psyche.parent()?;
    Some((
        home.to_path_buf(),
        psyche.to_path_buf(),
        parent.to_path_buf(),
    ))
}

#[cfg(unix)]
fn c_name(name: &OsStr) -> Result<CString, String> {
    CString::new(name.as_bytes()).map_err(|_| "file name contains a NUL byte".to_string())
}

#[cfg(unix)]
fn c_path(path: &Path) -> Result<CString, String> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| format!("path contains a NUL byte: {}", path.display()))
}

#[cfg(unix)]
fn fstat_fd(file: &File, path: &Path, context: &str) -> Result<libc::stat, String> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(format!(
            "inspect opened {context} '{}': {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { stat.assume_init() })
}

#[cfg(unix)]
fn stat_is_type(stat: &libc::stat, file_type: libc::mode_t) -> bool {
    (stat.st_mode as libc::mode_t & libc::S_IFMT as libc::mode_t) == file_type
}

#[cfg(unix)]
fn same_inode(left: &libc::stat, right: &libc::stat) -> bool {
    left.st_dev == right.st_dev && left.st_ino == right.st_ino
}

#[cfg(unix)]
fn fstatat_child(
    directory: &File,
    name: &CString,
    path: &Path,
    context: &str,
) -> Result<Option<libc::stat>, String> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    let result = unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == 0 {
        return Ok(Some(unsafe { stat.assume_init() }));
    }
    let error = std::io::Error::last_os_error();
    if error.kind() == std::io::ErrorKind::NotFound {
        return Ok(None);
    }
    Err(format!("inspect {context} '{}': {}", path.display(), error))
}

#[cfg(unix)]
fn open_directory_path_no_follow(path: &Path, context: &str) -> Result<File, String> {
    open_directory_path_no_follow_optional(path, context)?
        .ok_or_else(|| format!("{context} '{}' is missing", path.display()))
}

#[cfg(unix)]
fn open_directory_path_no_follow_optional(
    path: &Path,
    context: &str,
) -> Result<Option<File>, String> {
    let path_c = c_path(path)?;
    let fd = unsafe {
        libc::open(
            path_c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        if matches!(error.raw_os_error(), Some(libc::ELOOP)) {
            return Err(format!(
                "{context} '{}' must not be a symlink",
                path.display()
            ));
        }
        return Err(format!("open {context} '{}': {}", path.display(), error));
    }
    let directory = unsafe { File::from_raw_fd(fd) };
    let stat = fstat_fd(&directory, path, context)?;
    if !stat_is_type(&stat, libc::S_IFDIR as libc::mode_t) {
        return Err(format!(
            "opened {context} '{}' must be a directory",
            path.display()
        ));
    }
    Ok(Some(directory))
}

#[cfg(unix)]
fn open_directory_component(
    parent: &PinnedDirectory,
    path: &Path,
    create: bool,
    secure_permissions: bool,
    sync_created_directory: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<Option<PinnedDirectory>, String> {
    if path.parent() != Some(parent.display_path.as_path()) {
        return Err(format!(
            "workspace directory '{}' is outside pinned parent '{}'",
            path.display(),
            parent.display_path.display()
        ));
    }
    let name = c_name(
        path.file_name()
            .ok_or_else(|| format!("workspace directory '{}' has no name", path.display()))?,
    )?;
    let mut created_or_concurrent = false;
    match fstatat_child(
        &parent.directory,
        &name,
        path,
        "app-owned workspace directory",
    )? {
        Some(stat) if stat_is_type(&stat, libc::S_IFLNK as libc::mode_t) => {
            return Err(format!(
                "app-owned workspace directory '{}' must not be a symlink",
                path.display()
            ));
        }
        Some(stat) if !stat_is_type(&stat, libc::S_IFDIR as libc::mode_t) => {
            return Err(format!(
                "app-owned workspace directory '{}' must be a directory",
                path.display()
            ));
        }
        Some(_) => {}
        None if !create => return Ok(None),
        None => {
            if unsafe { libc::mkdirat(parent.directory.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(format!(
                        "create workspace directory '{}': {}",
                        path.display(),
                        error
                    ));
                }
                created_or_concurrent = true;
            } else {
                created_or_concurrent = true;
            }
        }
    }

    let fd = unsafe {
        libc::openat(
            parent.directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(libc::ELOOP)) {
            return Err(format!(
                "app-owned workspace directory '{}' must not be a symlink",
                path.display()
            ));
        }
        return Err(format!(
            "open app-owned workspace directory '{}': {}",
            path.display(),
            error
        ));
    }
    let directory = unsafe { File::from_raw_fd(fd) };
    let stat = fstat_fd(&directory, path, "app-owned workspace directory")?;
    if !stat_is_type(&stat, libc::S_IFDIR as libc::mode_t) {
        return Err(format!(
            "opened app-owned workspace directory '{}' must be a directory",
            path.display()
        ));
    }

    sync_created_directory(&parent.display_path).map_err(|error| {
        format!(
            "sync containing directory '{}' while traversing '{}': {}",
            parent.display_path.display(),
            path.display(),
            error
        )
    })?;
    parent.directory.sync_all().map_err(|error| {
        format!(
            "sync containing directory '{}' while traversing '{}': {}",
            parent.display_path.display(),
            path.display(),
            error
        )
    })?;
    if secure_permissions {
        set_secure_directory_permissions_fd(&directory, path)?;
    }
    if created_or_concurrent {
        sync_created_directory(path).map_err(|error| {
            format!(
                "sync new workspace directory '{}': {}",
                path.display(),
                error
            )
        })?;
    }
    if secure_permissions || created_or_concurrent {
        directory.sync_all().map_err(|error| {
            format!(
                "sync workspace directory permissions '{}': {}",
                path.display(),
                error
            )
        })?;
    }
    Ok(Some(PinnedDirectory {
        display_path: path.to_path_buf(),
        directory,
    }))
}

#[cfg(unix)]
fn set_secure_directory_permissions_fd(directory: &File, path: &Path) -> Result<(), String> {
    if unsafe { libc::fchmod(directory.as_raw_fd(), 0o700) } != 0 {
        return Err(format!(
            "set workspace directory permissions '{}': {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn prepare_workspace_parent_fallback(
    path: &Path,
    sync_created_directory: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("workspace path has no parent directory: {}", path.display()))?;
    let mut missing = Vec::new();
    let mut cursor = parent.to_path_buf();
    while !cursor.exists() {
        missing.push(cursor.clone());
        cursor = cursor
            .parent()
            .ok_or_else(|| {
                format!(
                    "workspace parent has no existing ancestor: {}",
                    parent.display()
                )
            })?
            .to_path_buf();
    }
    for directory in missing.into_iter().rev() {
        fs::create_dir(&directory).map_err(|error| {
            format!(
                "create workspace directory '{}': {}",
                directory.display(),
                error
            )
        })?;
        sync_created_directory(directory.parent().ok_or_else(|| {
            format!(
                "workspace directory '{}' has no parent",
                directory.display()
            )
        })?)?;
        sync_created_directory(&directory)?;
    }
    Ok(())
}

fn validate_workspace_artifact_paths(
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

fn regular_file_exists(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    context: &str,
) -> Result<bool, String> {
    #[cfg(unix)]
    {
        let name = workspace_dir.child_name(path, context)?;
        let Some(stat) = fstatat_child(&workspace_dir.directory, &name, path, context)? else {
            return Ok(false);
        };
        if stat_is_type(&stat, libc::S_IFLNK as libc::mode_t) {
            return Err(format!(
                "{context} '{}' must not be a symlink",
                path.display()
            ));
        }
        if !stat_is_type(&stat, libc::S_IFREG as libc::mode_t) {
            return Err(format!(
                "{context} '{}' must be a regular file",
                path.display()
            ));
        }
        Ok(true)
    }
    #[cfg(not(unix))]
    {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
                "{context} '{}' must not be a symlink",
                path.display()
            )),
            Ok(metadata) if metadata.is_file() => Ok(true),
            Ok(_) => Err(format!(
                "{context} '{}' must be a regular file",
                path.display()
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("inspect {context} '{}': {}", path.display(), error)),
        }
    }
}

fn require_new_regular_file_path(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    context: &str,
) -> Result<(), String> {
    if regular_file_exists(workspace_dir, path, context)? {
        return Err(format!("{context} '{}' already exists", path.display()));
    }
    Ok(())
}

fn open_existing_regular_file(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    context: &str,
    writable: bool,
) -> Result<Option<File>, String> {
    #[cfg(unix)]
    {
        let name = workspace_dir.child_name(path, context)?;
        let Some(before) = fstatat_child(&workspace_dir.directory, &name, path, context)? else {
            return Ok(None);
        };
        if stat_is_type(&before, libc::S_IFLNK as libc::mode_t) {
            return Err(format!(
                "{context} '{}' must not be a symlink",
                path.display()
            ));
        }
        if !stat_is_type(&before, libc::S_IFREG as libc::mode_t) {
            return Err(format!(
                "{context} '{}' must be a regular file",
                path.display()
            ));
        }
        let access = if writable {
            libc::O_RDWR
        } else {
            libc::O_RDONLY
        };
        let fd = unsafe {
            libc::openat(
                workspace_dir.directory.as_raw_fd(),
                name.as_ptr(),
                access | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            if matches!(error.raw_os_error(), Some(libc::ELOOP)) {
                return Err(format!(
                    "{context} '{}' must not be a symlink",
                    path.display()
                ));
            }
            return Err(format!("open {context} '{}': {}", path.display(), error));
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let opened = fstat_fd(&file, path, context)?;
        if !stat_is_type(&opened, libc::S_IFREG as libc::mode_t) {
            return Err(format!(
                "opened {context} '{}' must be a regular file",
                path.display()
            ));
        }
        let Some(current) = fstatat_child(&workspace_dir.directory, &name, path, context)? else {
            return Err(format!(
                "{context} '{}' disappeared while opening",
                path.display()
            ));
        };
        if stat_is_type(&current, libc::S_IFLNK as libc::mode_t) {
            return Err(format!(
                "{context} '{}' became a symlink while opening",
                path.display()
            ));
        }
        if !same_inode(&opened, &current) {
            return Err(format!(
                "{context} '{}' changed while opening",
                path.display()
            ));
        }
        set_secure_regular_file_permissions(&file, path, context)?;
        Ok(Some(file))
    }
    #[cfg(not(unix))]
    {
        if !regular_file_exists(workspace_dir, path, context)? {
            return Ok(None);
        }
        let mut options = OpenOptions::new();
        options.read(true).write(writable);
        options
            .open(path)
            .map(Some)
            .map_err(|error| format!("open {context} '{}': {}", path.display(), error))
    }
}

fn set_secure_regular_file_permissions(
    file: &File,
    path: &Path,
    context: &str,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
            return Err(format!(
                "set {context} permissions '{}': {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
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
fn open_temp_file(path: &Path) -> Result<File, String> {
    let workspace_dir = SecureWorkspaceDir::open_for_load(path)?
        .ok_or_else(|| format!("workspace parent '{}' is missing", path.display()))?;
    open_temp_file_in(&workspace_dir, path)
}

fn open_temp_file_in(workspace_dir: &SecureWorkspaceDir, path: &Path) -> Result<File, String> {
    open_new_workspace_file(workspace_dir, path, "temp")
}

fn open_new_workspace_file(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    context: &str,
) -> Result<File, String> {
    require_new_regular_file_path(workspace_dir, path, &format!("workspace {context}"))?;
    #[cfg(unix)]
    {
        let name = workspace_dir.child_name(path, &format!("workspace {context}"))?;
        let fd = unsafe {
            libc::openat(
                workspace_dir.directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(libc::ELOOP)) {
                return Err(format!(
                    "workspace {context} '{}' must not be a symlink",
                    path.display()
                ));
            }
            return Err(format!(
                "create workspace {context} '{}': {}",
                path.display(),
                error
            ));
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let opened = fstat_fd(&file, path, &format!("workspace {context}"))?;
        if !stat_is_type(&opened, libc::S_IFREG as libc::mode_t) {
            return Err(format!(
                "opened workspace {context} '{}' must be a regular file",
                path.display()
            ));
        }
        set_secure_regular_file_permissions(&file, path, &format!("workspace {context}"))?;
        Ok(file)
    }
    #[cfg(not(unix))]
    {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| {
                format!("create workspace {context} '{}': {}", path.display(), error)
            })?;
        set_secure_regular_file_permissions(&file, path, &format!("workspace {context}"))?;
        Ok(file)
    }
}

fn workspace_temp_path(parent: &Path, file_name: &str) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(
        ".{}.psyche-save-{}-{}",
        file_name,
        std::process::id(),
        counter
    ))
}

fn workspace_lock_path(parent: &Path, file_name: &str) -> PathBuf {
    parent.join(format!(".{file_name}.psyche-lock"))
}

fn workspace_rollback_pending_path(parent: &Path, file_name: &str) -> PathBuf {
    parent.join(format!(".{file_name}.psyche-rollback.pending"))
}

fn workspace_rollback_committed_path(parent: &Path, file_name: &str) -> PathBuf {
    parent.join(format!(".{file_name}.psyche-rollback.committed"))
}

fn workspace_absent_rollback_pending_path(parent: &Path, file_name: &str) -> PathBuf {
    parent.join(format!(".{file_name}.psyche-rollback.absent.pending"))
}

fn workspace_absent_rollback_committed_path(parent: &Path, file_name: &str) -> PathBuf {
    parent.join(format!(".{file_name}.psyche-rollback.absent.committed"))
}

fn workspace_forward_rollback_path(parent: &Path, file_name: &str) -> PathBuf {
    parent.join(format!(".{file_name}.psyche-rollback.forward"))
}

fn workspace_rollback_candidate_prefix(file_name: &str) -> String {
    format!(".{file_name}.psyche-rollback.candidate-")
}

fn workspace_rollback_candidate_path(pending_path: &Path) -> Result<PathBuf, String> {
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

fn workspace_restore_candidate_path(path: &Path) -> Result<PathBuf, String> {
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

fn cleanup_rollback_candidates(
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

fn rollback_candidates_exist(
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

fn workspace_directory_entries(
    workspace_dir: &SecureWorkspaceDir,
    parent: &Path,
) -> Result<Vec<std::ffi::OsString>, String> {
    #[cfg(unix)]
    {
        let current = CString::new(".").expect("static directory name");
        let duplicate = unsafe {
            libc::openat(
                workspace_dir.directory.as_raw_fd(),
                current.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if duplicate < 0 {
            return Err(format!(
                "open workspace parent directory stream '{}': {}",
                parent.display(),
                std::io::Error::last_os_error()
            ));
        }
        let stream = unsafe { libc::fdopendir(duplicate) };
        if stream.is_null() {
            let error = std::io::Error::last_os_error();
            unsafe {
                libc::close(duplicate);
            }
            return Err(format!(
                "read workspace parent for rollback candidates '{}': {}",
                parent.display(),
                error
            ));
        }
        let mut entries = Vec::new();
        loop {
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break;
            }
            let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            entries.push(OsString::from_vec(bytes.to_vec()));
        }
        if unsafe { libc::closedir(stream) } != 0 {
            return Err(format!(
                "close workspace parent directory stream '{}': {}",
                parent.display(),
                std::io::Error::last_os_error()
            ));
        }
        Ok(entries)
    }
    #[cfg(not(unix))]
    {
        fs::read_dir(parent)
            .map_err(|error| {
                format!(
                    "read workspace parent for rollback candidates '{}': {}",
                    parent.display(),
                    error
                )
            })?
            .map(|entry| {
                entry.map(|entry| entry.file_name()).map_err(|error| {
                    format!(
                        "read workspace rollback candidate in '{}': {}",
                        parent.display(),
                        error
                    )
                })
            })
            .collect()
    }
}

fn unlink_workspace_path(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    context: &str,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        let name = workspace_dir.child_name(path, context)?;
        if unsafe { libc::unlinkat(workspace_dir.directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

fn cleanup_committed_rollback(
    workspace_dir: &SecureWorkspaceDir,
    committed_path: &Path,
    parent: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if !regular_file_exists(
        workspace_dir,
        committed_path,
        "workspace committed rollback",
    )? {
        return Ok(());
    }
    unlink_workspace_path(
        workspace_dir,
        committed_path,
        "workspace committed rollback",
    )
    .map_err(|error| {
        format!(
            "remove committed workspace rollback '{}': {}",
            committed_path.display(),
            error
        )
    })?;
    sync_parent_directory(workspace_dir, parent).map_err(|error| {
        format!(
            "sync removal of committed workspace rollback '{}': {}",
            committed_path.display(),
            error
        )
    })?;
    Ok(())
}

fn cleanup_forward_rollback(
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

#[cfg(test)]
fn workspace_file_exists(path: &Path) -> Result<bool, String> {
    let Some(workspace_dir) = SecureWorkspaceDir::open_for_load(path)? else {
        return Ok(false);
    };
    workspace_file_exists_in(&workspace_dir, path)
}

fn workspace_file_exists_in(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
) -> Result<bool, String> {
    regular_file_exists(workspace_dir, path, "workspace")
}

#[cfg(test)]
fn create_rollback_backup(_path: &Path, _backup_path: &Path) -> Result<(), String> {
    Ok(())
}

fn create_rollback_backup_in(
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

fn create_absent_rollback_marker_in(
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

fn read_workspace_artifact_bytes(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    context: &str,
) -> Result<Vec<u8>, String> {
    let Some(mut file) = open_existing_regular_file(workspace_dir, path, context, false)? else {
        return Err(format!("{context} '{}' is missing", path.display()));
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("read {context} '{}': {}", path.display(), error))?;
    Ok(bytes)
}

fn read_workspace_restore_source_bytes(
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
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("read {context} '{}': {}", path.display(), error))?;
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

fn verify_workspace_artifact_bytes(
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

fn verify_opened_workspace_artifact(
    workspace_dir: &SecureWorkspaceDir,
    file: &File,
    path: &Path,
    expected_bytes: &[u8],
    context: &str,
) -> Result<(), String> {
    verify_opened_regular_file(workspace_dir, file, path, context)?;
    verify_workspace_artifact_bytes(workspace_dir, path, expected_bytes, context)
}

fn validate_workspace_artifact_bytes(
    bytes: &[u8],
    path: &Path,
    context: &str,
) -> Result<(), String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("parse {context} '{}': {}", path.display(), error))?;
    validate_workspace(&value)
        .map_err(|error| format!("validate {context} '{}': {}", path.display(), error))
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

fn declare_absent_forward_commit(
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

fn declare_absent_rollback(
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

fn finish_initial_workspace_forward(
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
    let failure = match sync_parent_directory(workspace_dir, parent) {
        Ok(()) => {
            #[cfg(test)]
            run_post_initial_forward_sync_fault(path)?;
            "final initial workspace forward certification failed".to_string()
        }
        Err(error) => format!(
            "sync forward workspace marker '{}': {}",
            committed_path.display(),
            error
        ),
    };
    resolve_initial_workspace_after_marker_failure(
        workspace_dir,
        source_file,
        expected_bytes,
        path,
        parent,
        pending_path,
        committed_path,
        forward_path,
        failure,
        sync_parent_directory,
    )
}

fn commit_initial_workspace_forward(
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
    declare_absent_forward_commit(workspace_dir, pending_path, committed_path)?;
    finish_initial_workspace_forward(
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
}

fn resolve_initial_workspace_after_marker_failure(
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

fn durably_restore_initial_absence(
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

fn finish_prior_workspace_transaction(
    workspace_dir: &SecureWorkspaceDir,
    source_file: &File,
    expected_bytes: &[u8],
    prior_bytes: &[u8],
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    forward_path: &Path,
    commit_result: Result<(), String>,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    recreate_pending_rollback: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    match commit_result {
        Ok(()) => match certify_prior_workspace_forward(
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
        ) {
            Ok(()) => Ok(()),
            Err(error) => resolve_prior_workspace_after_commit_failure(
                workspace_dir,
                source_file,
                expected_bytes,
                prior_bytes,
                path,
                parent,
                pending_path,
                committed_path,
                forward_path,
                format!("final committed workspace certification failed: {error}"),
                sync_parent_directory,
                restore_workspace_backup,
                recreate_pending_rollback,
            ),
        },
        Err(error) => resolve_prior_workspace_after_commit_failure(
            workspace_dir,
            source_file,
            expected_bytes,
            prior_bytes,
            path,
            parent,
            pending_path,
            committed_path,
            forward_path,
            error,
            sync_parent_directory,
            restore_workspace_backup,
            recreate_pending_rollback,
        ),
    }
}

fn resolve_prior_workspace_after_commit_failure(
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

fn certify_prior_workspace_forward(
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

#[cfg(test)]
fn create_rollback_backup_with<F, G>(
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

fn hard_link_workspace_path(
    workspace_dir: &SecureWorkspaceDir,
    source: &Path,
    destination: &Path,
) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let source_name = workspace_dir
            .child_name(source, "workspace hard-link source")
            .map_err(std::io::Error::other)?;
        let destination_name = workspace_dir
            .child_name(destination, "workspace hard-link destination")
            .map_err(std::io::Error::other)?;
        if unsafe {
            libc::linkat(
                workspace_dir.directory.as_raw_fd(),
                source_name.as_ptr(),
                workspace_dir.directory.as_raw_fd(),
                destination_name.as_ptr(),
                0,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::hard_link(source, destination)
    }
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
    if metadata.len() > WORKSPACE_ROLLBACK_COPY_LIMIT {
        return Err(format!(
            "workspace '{}' is too large for rollback copy: {} bytes (limit {})",
            path.display(),
            metadata.len(),
            WORKSPACE_ROLLBACK_COPY_LIMIT
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
fn restore_workspace_backup_standalone(backup_path: &Path, path: &Path) -> Result<(), String> {
    let workspace_dir = SecureWorkspaceDir::open_for_load(path)?
        .ok_or_else(|| format!("workspace parent '{}' is missing", path.display()))?;
    restore_workspace_backup_in(&workspace_dir, backup_path, path)
}

#[cfg(test)]
fn restore_workspace_backup(_backup_path: &Path, _path: &Path) -> Result<(), String> {
    Ok(())
}

fn restore_workspace_backup_in(
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

fn rename_workspace_path_in(
    workspace_dir: &SecureWorkspaceDir,
    source: &Path,
    destination: &Path,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        let source_name = workspace_dir.child_name(source, "workspace rename source")?;
        let destination_name =
            workspace_dir.child_name(destination, "workspace rename destination")?;
        if unsafe {
            libc::renameat(
                workspace_dir.directory.as_raw_fd(),
                source_name.as_ptr(),
                workspace_dir.directory.as_raw_fd(),
                destination_name.as_ptr(),
            )
        } != 0
        {
            return Err(format!(
                "rename workspace path '{}' to '{}': {}",
                source.display(),
                destination.display(),
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    fs::rename(source, destination).map_err(|e| {
        format!(
            "rename workspace path '{}' to '{}': {}",
            source.display(),
            destination.display(),
            e
        )
    })
}

fn recover_pending_rollback_state(
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AbsentRollbackResolution {
    Rollback,
    Forward { require_candidate: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AbsentRollbackInterpretation {
    Missing,
    Resolved(AbsentRollbackResolution),
    Ambiguous,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AbsentMarkerRead {
    Missing,
    Resolved(AbsentRollbackResolution),
    Malformed,
}

fn absent_rollback_resolution(
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

fn ensure_forward_workspace(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    forward_path: &Path,
    require_candidate: bool,
) -> Result<(), String> {
    let Some(forward_file) = open_existing_regular_file(
        workspace_dir,
        forward_path,
        "workspace forward rollback",
        false,
    )?
    else {
        if require_candidate {
            return Err(format!(
                "workspace forward rollback '{}' is missing",
                forward_path.display()
            ));
        }
        if regular_file_exists(workspace_dir, path, "workspace")? {
            return Ok(());
        }
        return Err(format!(
            "forward workspace '{}' and rollback '{}' are both missing",
            path.display(),
            forward_path.display()
        ));
    };

    if !regular_file_exists(workspace_dir, path, "workspace")? {
        hard_link_workspace_path(workspace_dir, forward_path, path).map_err(|error| {
            format!(
                "restore forward workspace '{}' from '{}': {}",
                path.display(),
                forward_path.display(),
                error
            )
        })?;
    }
    verify_opened_regular_file(
        workspace_dir,
        &forward_file,
        path,
        "workspace forward rollback",
    )
}

fn recover_workspace_from_forward_candidate(
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

fn certify_prior_committed_recovery(
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

fn recover_ambiguous_initial_workspace(
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

fn recover_pending_workspace(
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

fn rollback_workspace_after_failed_save(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    sync_parent_directory: &mut impl FnMut(&SecureWorkspaceDir, &Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
    rename_workspace_path: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if regular_file_exists(workspace_dir, pending_path, "workspace pending rollback")? {
        recover_pending_workspace(
            workspace_dir,
            path,
            parent,
            pending_path,
            committed_path,
            sync_parent_directory,
            restore_workspace_backup,
            rename_workspace_path,
        )
        .map_err(|error| format!("rollback restoration failed: {error}"))?;
        Ok(())
    } else if regular_file_exists(
        workspace_dir,
        committed_path,
        "workspace committed rollback",
    )? {
        restore_prior_workspace_state(
            workspace_dir,
            committed_path,
            path,
            restore_workspace_backup,
        )
        .map_err(|error| {
            format!(
                "restore failed workspace '{}' from committed rollback '{}': {}",
                path.display(),
                committed_path.display(),
                error
            )
        })?;
        sync_parent_directory(workspace_dir, parent).map_err(|error| {
            format!(
                "sync restoration of failed workspace '{}' from committed rollback '{}': {}",
                path.display(),
                committed_path.display(),
                error
            )
        })
    } else if regular_file_exists(workspace_dir, path, "workspace")? {
        unlink_workspace_path(workspace_dir, path, "workspace")
            .map_err(|e| format!("remove failed workspace '{}': {}", path.display(), e))?;
        sync_parent_directory(workspace_dir, parent).map_err(|error| {
            format!(
                "sync removal of failed workspace '{}': {}",
                path.display(),
                error
            )
        })
    } else {
        Ok(())
    }
}

fn mark_rollback_committed(
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

fn mark_rollback_committed_with(
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

fn restore_prior_workspace_state(
    workspace_dir: &SecureWorkspaceDir,
    recovery_path: &Path,
    path: &Path,
    restore_workspace_backup: &mut impl FnMut(&SecureWorkspaceDir, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if absent_rollback_marker_path(recovery_path) {
        if regular_file_exists(workspace_dir, path, "workspace")? {
            unlink_workspace_path(workspace_dir, path, "workspace").map_err(|error| {
                format!("remove failed workspace '{}': {}", path.display(), error)
            })?;
        }
        Ok(())
    } else {
        restore_workspace_backup(workspace_dir, recovery_path, path)
    }
}

fn absent_rollback_marker_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.ends_with(".psyche-rollback.absent.pending")
                || name.ends_with(".psyche-rollback.absent.committed")
        })
}

fn verify_opened_regular_file(
    workspace_dir: &SecureWorkspaceDir,
    file: &File,
    path: &Path,
    context: &str,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        let opened = fstat_fd(file, path, context)?;
        if !stat_is_type(&opened, libc::S_IFREG as libc::mode_t) {
            return Err(format!(
                "opened {context} '{}' must be a regular file",
                path.display()
            ));
        }
        let name = workspace_dir.child_name(path, context)?;
        let Some(current) = fstatat_child(&workspace_dir.directory, &name, path, context)? else {
            return Err(format!(
                "{context} '{}' disappeared while opening",
                path.display()
            ));
        };
        if stat_is_type(&current, libc::S_IFLNK as libc::mode_t) {
            return Err(format!(
                "{context} '{}' became a symlink while opening",
                path.display()
            ));
        }
        if !stat_is_type(&current, libc::S_IFREG as libc::mode_t) {
            return Err(format!(
                "{context} '{}' must be a regular file",
                path.display()
            ));
        }
        if !same_inode(&opened, &current) {
            return Err(format!(
                "{context} '{}' changed while opening",
                path.display()
            ));
        }
    }
    #[cfg(not(unix))]
    {
        if !file
            .metadata()
            .map_err(|error| format!("inspect opened {context} '{}': {}", path.display(), error))?
            .is_file()
        {
            return Err(format!(
                "opened {context} '{}' must be a regular file",
                path.display()
            ));
        }
    }
    Ok(())
}

fn open_workspace_lock(workspace_dir: &SecureWorkspaceDir, path: &Path) -> Result<File, String> {
    for _ in 0..8 {
        let exists = regular_file_exists(workspace_dir, path, "workspace lock")?;
        #[cfg(unix)]
        let file = {
            let name = workspace_dir.child_name(path, "workspace lock")?;
            let mut flags = libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC;
            if !exists {
                flags |= libc::O_CREAT | libc::O_EXCL;
            }
            let fd = unsafe {
                libc::openat(
                    workspace_dir.directory.as_raw_fd(),
                    name.as_ptr(),
                    flags,
                    0o600,
                )
            };
            if fd < 0 {
                let error = std::io::Error::last_os_error();
                if (!exists && error.kind() == std::io::ErrorKind::AlreadyExists)
                    || (exists && error.kind() == std::io::ErrorKind::NotFound)
                {
                    continue;
                }
                if matches!(error.raw_os_error(), Some(libc::ELOOP)) {
                    return Err(format!(
                        "workspace lock '{}' must not be a symlink",
                        path.display()
                    ));
                }
                return Err(format!(
                    "open workspace lock '{}': {}",
                    path.display(),
                    error
                ));
            }
            unsafe { File::from_raw_fd(fd) }
        };
        #[cfg(not(unix))]
        let file = {
            let mut options = OpenOptions::new();
            options.read(true).write(true);
            if !exists {
                options.create_new(true);
            }
            match options.open(path) {
                Ok(file) => file,
                Err(error)
                    if (!exists && error.kind() == std::io::ErrorKind::AlreadyExists)
                        || (exists && error.kind() == std::io::ErrorKind::NotFound) =>
                {
                    continue;
                }
                Err(error) => {
                    return Err(format!(
                        "open workspace lock '{}': {}",
                        path.display(),
                        error
                    ));
                }
            }
        };
        verify_opened_regular_file(workspace_dir, &file, path, "workspace lock")?;
        set_secure_regular_file_permissions(&file, path, "workspace lock")?;
        file.sync_all().map_err(|error| {
            format!(
                "sync workspace lock permissions '{}': {}",
                path.display(),
                error
            )
        })?;
        return Ok(file);
    }
    Err(format!(
        "workspace lock '{}' changed repeatedly while opening",
        path.display()
    ))
}

struct WorkspaceFileLock {
    file: File,
}

impl WorkspaceFileLock {
    fn shared(workspace_dir: &SecureWorkspaceDir, path: &Path) -> Result<Self, String> {
        Self::acquire(workspace_dir, path, LockMode::Shared)
    }

    fn exclusive(workspace_dir: &SecureWorkspaceDir, path: &Path) -> Result<Self, String> {
        Self::acquire(workspace_dir, path, LockMode::Exclusive)
    }

    fn acquire(
        workspace_dir: &SecureWorkspaceDir,
        path: &Path,
        mode: LockMode,
    ) -> Result<Self, String> {
        let parent = path
            .parent()
            .ok_or_else(|| format!("workspace path has no parent directory: {}", path.display()))?;
        let file_name = path
            .file_name()
            .ok_or_else(|| format!("workspace path has no file name: {}", path.display()))?
            .to_string_lossy();
        let lock_path = workspace_lock_path(parent, &file_name);
        let file = open_workspace_lock(workspace_dir, &lock_path)?;
        #[cfg(unix)]
        {
            let operation = match mode {
                LockMode::Shared => libc::LOCK_SH,
                LockMode::Exclusive => libc::LOCK_EX,
            };
            loop {
                if unsafe { libc::flock(file.as_raw_fd(), operation) } == 0 {
                    break;
                }
                let error = std::io::Error::last_os_error();
                if error.kind() != std::io::ErrorKind::Interrupted {
                    return Err(format!(
                        "lock workspace lock '{}': {}",
                        lock_path.display(),
                        error
                    ));
                }
            }
        }
        verify_opened_regular_file(workspace_dir, &file, &lock_path, "workspace lock")?;
        Ok(Self { file })
    }
}

impl Drop for WorkspaceFileLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

enum LockMode {
    Shared,
    Exclusive,
}

#[cfg(test)]
fn sync_parent_directory_standalone(parent: &Path) -> Result<(), String> {
    let path = parent.join("workspace-v3.json");
    let workspace_dir = SecureWorkspaceDir::open_for_load(&path)?
        .ok_or_else(|| format!("workspace parent '{}' is missing", parent.display()))?;
    workspace_dir.sync()
}

#[cfg(test)]
fn sync_parent_directory(_parent: &Path) -> Result<(), String> {
    Ok(())
}

fn sync_workspace_directory(
    workspace_dir: &SecureWorkspaceDir,
    _parent: &Path,
) -> Result<(), String> {
    workspace_dir.sync()
}

struct TempFileGuard<'a> {
    workspace_dir: &'a SecureWorkspaceDir,
    path: PathBuf,
    committed: bool,
}

impl<'a> TempFileGuard<'a> {
    fn new(workspace_dir: &'a SecureWorkspaceDir, path: PathBuf) -> Self {
        Self {
            workspace_dir,
            path,
            committed: false,
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for TempFileGuard<'_> {
    fn drop(&mut self) {
        if !self.committed {
            let _ = unlink_workspace_path(self.workspace_dir, &self.path, "workspace temp");
        }
    }
}

#[cfg(test)]
fn workspace_save_to_test_hook<F, G, H>(
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

#[cfg(test)]
fn workspace_save_to_test_hook_before_publication<F>(
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

#[cfg(test)]
thread_local! {
    static POST_VERIFICATION_PRE_RENAME_REPLACEMENT: RefCell<Option<Vec<u8>>> =
        const { RefCell::new(None) };
    static POST_RESTORE_VERIFICATION_PRE_RENAME_REPLACEMENT: RefCell<Option<Vec<u8>>> =
        const { RefCell::new(None) };
    static TRUSTED_RESTORE_CANDIDATE_FAILURE: RefCell<Option<RestoreCandidateFileOperation>> =
        const { RefCell::new(None) };
    static POST_INITIAL_FORWARD_SYNC_FAULT: RefCell<Option<PostInitialForwardSyncFault>> =
        const { RefCell::new(None) };
    static MARKER_FILE_FAULT: RefCell<Option<MarkerFileFaultPlan>> = const { RefCell::new(None) };
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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RestoreCandidateFileOperation {
    Write,
    Sync,
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

#[cfg(test)]
enum PostInitialForwardSyncFault {
    ReplaceWorkspace(Vec<u8>),
}

#[cfg(test)]
fn run_post_initial_forward_sync_fault(path: &Path) -> Result<(), String> {
    POST_INITIAL_FORWARD_SYNC_FAULT.with(|fault| {
        let Some(fault) = fault.borrow_mut().take() else {
            return Ok(());
        };
        match fault {
            PostInitialForwardSyncFault::ReplaceWorkspace(replacement) => {
                fs::remove_file(path).map_err(|error| error.to_string())?;
                fs::write(path, replacement).map_err(|error| error.to_string())
            }
        }
    })
}

#[cfg(test)]
#[derive(Clone, Copy)]
enum MarkerFileFaultMode {
    RepeatedWriteWithPersistedEmptyMarker,
    RepeatedSyncWithPersistedForwardMarker,
    PartialWriteWithPersistedTornMarker,
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum MarkerFileOperation {
    Write,
    Sync,
}

#[cfg(test)]
struct MarkerFileFaultPlan {
    mode: MarkerFileFaultMode,
    armed: bool,
    failures: usize,
}

#[cfg(test)]
fn run_marker_file_fault(
    operation: MarkerFileOperation,
    marker: &mut File,
    marker_path: &Path,
    payload: &[u8],
) -> Result<(), String> {
    MARKER_FILE_FAULT.with(|fault| {
        let mut fault = fault.borrow_mut();
        let Some(plan) = fault.as_mut() else {
            return Ok(());
        };
        match plan.mode {
            MarkerFileFaultMode::RepeatedWriteWithPersistedEmptyMarker => {
                if operation != MarkerFileOperation::Write
                    || (!plan.armed && payload != ABSENT_FORWARD_MARKER)
                {
                    return Ok(());
                }
                plan.armed = true;
                plan.failures += 1;
                if plan.failures == 1 {
                    marker.sync_all().map_err(|error| {
                        format!(
                            "persist empty absent workspace marker '{}': {}",
                            marker_path.display(),
                            error
                        )
                    })?;
                }
                Err(format!(
                    "injected repeated marker write failure #{}",
                    plan.failures
                ))
            }
            MarkerFileFaultMode::RepeatedSyncWithPersistedForwardMarker => {
                if operation != MarkerFileOperation::Sync
                    || (!plan.armed && payload != ABSENT_FORWARD_MARKER)
                {
                    return Ok(());
                }
                plan.armed = true;
                plan.failures += 1;
                marker.set_len(0).map_err(|error| {
                    format!(
                        "reset persisted forward marker '{}': {}",
                        marker_path.display(),
                        error
                    )
                })?;
                marker.rewind().map_err(|error| {
                    format!(
                        "rewind persisted forward marker '{}': {}",
                        marker_path.display(),
                        error
                    )
                })?;
                marker.write_all(ABSENT_FORWARD_MARKER).map_err(|error| {
                    format!(
                        "persist forward marker '{}': {}",
                        marker_path.display(),
                        error
                    )
                })?;
                marker.flush().map_err(|error| {
                    format!(
                        "flush persisted forward marker '{}': {}",
                        marker_path.display(),
                        error
                    )
                })?;
                marker.sync_all().map_err(|error| {
                    format!(
                        "sync persisted forward marker '{}': {}",
                        marker_path.display(),
                        error
                    )
                })?;
                Err(format!(
                    "injected repeated marker file sync failure #{}",
                    plan.failures
                ))
            }
            MarkerFileFaultMode::PartialWriteWithPersistedTornMarker => {
                if operation != MarkerFileOperation::Write
                    || (!plan.armed && payload != ABSENT_FORWARD_MARKER)
                {
                    return Ok(());
                }
                plan.armed = true;
                plan.failures += 1;
                let partial_len = payload.len() / 2;
                marker.write_all(&payload[..partial_len]).map_err(|error| {
                    format!(
                        "persist partial absent workspace marker '{}': {}",
                        marker_path.display(),
                        error
                    )
                })?;
                marker.flush().map_err(|error| {
                    format!(
                        "flush partial absent workspace marker '{}': {}",
                        marker_path.display(),
                        error
                    )
                })?;
                marker.sync_all().map_err(|error| {
                    format!(
                        "sync partial absent workspace marker '{}': {}",
                        marker_path.display(),
                        error
                    )
                })?;
                Err(format!(
                    "injected partial marker write failure #{}",
                    plan.failures
                ))
            }
        }
    })
}

#[cfg(test)]
fn workspace_save_to_test_marker_file_fault(
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

#[cfg(test)]
fn workspace_save_to_test_marker_and_directory_faults<G, I>(
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

#[cfg(test)]
fn workspace_save_to_test_swap_after_final_verification_before_rename(
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

#[cfg(test)]
fn with_restore_candidate_swap<T>(
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

#[cfg(test)]
fn with_restore_candidate_swap_and_trusted_retry_failure<T>(
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

#[cfg(test)]
fn workspace_save_to_test_post_initial_forward_sync_fault(
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

#[cfg(test)]
fn workspace_save_to_test_hook_with_recreation_fault<G, I>(
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

#[cfg(test)]
fn load_workspace_from_test_hook<F>(
    path: &Path,
    before_exclusive_recovery: F,
) -> Result<Option<Value>, String>
where
    F: FnOnce() -> Result<(), String>,
{
    load_workspace_from_inner(path, before_exclusive_recovery)
}

#[cfg(test)]
fn workspace_save_to_test_hook_with_backup<F, G, H, I>(
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

#[cfg(test)]
fn workspace_save_to_test_hook_with_ops<F, G, H, I, J>(
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

#[cfg(test)]
fn workspace_save_to_test_hook_with_parent_sync<G>(
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

pub(crate) fn workspace_default_path() -> Result<PathBuf, String> {
    workspace_path_from_home()
}

#[tauri::command]
pub(crate) fn workspace_load(webview: tauri::Webview) -> Result<Option<Value>, String> {
    ensure_trusted_workspace_caller(webview.label())?;
    load_workspace_from(&workspace_default_path()?)
}

#[tauri::command]
pub(crate) fn workspace_save(webview: tauri::Webview, workspace: Value) -> Result<(), String> {
    ensure_trusted_workspace_caller(webview.label())?;
    save_workspace_to(&workspace_default_path()?, &workspace)
}

fn ensure_trusted_workspace_caller(label: &str) -> Result<(), String> {
    if label == "main" {
        return Ok(());
    }
    Err(format!(
        "workspace storage is only available to trusted webview 'main'; rejected caller '{label}'"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    use std::ffi::CString;
    #[cfg(unix)]
    use std::os::unix::ffi::OsStrExt;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, FileTypeExt, PermissionsExt};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;
    use tempfile::TempDir;

    fn workspace_value() -> Value {
        serde_json::json!({
            "version": 3,
            "projects": [],
            "sessions": [],
            "paneLayouts": [],
        })
    }

    fn temp_path(name: &str) -> (TempDir, PathBuf) {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join(name);
        (dir, path)
    }

    fn temp_workspace_path() -> (TempDir, PathBuf) {
        temp_path("workspace-v3.json")
    }

    fn temp_parent_workspace_path() -> (TempDir, PathBuf) {
        let dir = TempDir::new().expect("tempdir");
        let path = dir
            .path()
            .join(".psyche")
            .join("macos-app")
            .join("workspace-v3.json");
        (dir, path)
    }

    fn temp_files(dir: &Path) -> Vec<String> {
        let mut files = Vec::new();
        for entry in fs::read_dir(dir).expect("read dir") {
            let entry = entry.expect("dir entry");
            files.push(entry.file_name().to_string_lossy().to_string());
        }
        files
    }

    fn cleanup_artifacts(dir: &Path) -> Vec<String> {
        temp_files(dir)
            .into_iter()
            .filter(|name| name.contains(".psyche-save-"))
            .collect()
    }

    fn rollback_artifacts(dir: &Path) -> Vec<String> {
        temp_files(dir)
            .into_iter()
            .filter(|name| name.contains(".psyche-rollback."))
            .collect()
    }

    fn pending_path(path: &Path) -> PathBuf {
        path.parent().expect("parent").join(format!(
            ".{}.psyche-rollback.pending",
            path.file_name().expect("file name").to_string_lossy()
        ))
    }

    fn committed_path(path: &Path) -> PathBuf {
        path.parent().expect("parent").join(format!(
            ".{}.psyche-rollback.committed",
            path.file_name().expect("file name").to_string_lossy()
        ))
    }

    fn absent_pending_path(path: &Path) -> PathBuf {
        path.parent().expect("parent").join(format!(
            ".{}.psyche-rollback.absent.pending",
            path.file_name().expect("file name").to_string_lossy()
        ))
    }

    fn absent_committed_path(path: &Path) -> PathBuf {
        path.parent().expect("parent").join(format!(
            ".{}.psyche-rollback.absent.committed",
            path.file_name().expect("file name").to_string_lossy()
        ))
    }

    fn rollback_candidate_path(path: &Path, suffix: &str) -> PathBuf {
        path.parent().expect("parent").join(format!(
            ".{}.psyche-rollback.candidate-{suffix}",
            path.file_name().expect("file name").to_string_lossy()
        ))
    }

    fn workspace_with_project(id: &str) -> Value {
        serde_json::json!({
            "version": 3,
            "projects": [{"id": id}],
            "sessions": [],
            "paneLayouts": [],
        })
    }

    fn save_clean_workspace(path: &Path, value: &Value) {
        save_workspace_to(path, value).expect("save workspace");
        assert_eq!(
            load_workspace_from(path).expect("finish committed workspace recovery"),
            Some(value.clone())
        );
    }

    #[cfg(unix)]
    fn create_fifo(path: &Path) {
        let path = CString::new(path.as_os_str().as_bytes()).expect("fifo path");
        let result = unsafe { libc::mkfifo(path.as_ptr(), 0o600) };
        assert_eq!(
            result,
            0,
            "mkfifo failed: {}",
            std::io::Error::last_os_error()
        );
    }

    #[test]
    fn native_workspace_tests_trusted_caller_guard() {
        assert_eq!(ensure_trusted_workspace_caller("main"), Ok(()));

        let error = ensure_trusted_workspace_caller("psyche-browser-untrusted")
            .expect_err("browser caller must be rejected");
        assert!(error.contains("trusted webview 'main'"));
        assert!(error.contains("psyche-browser-untrusted"));
    }

    #[test]
    fn native_workspace_tests_valid_round_trip() {
        let (_dir, path) = temp_workspace_path();
        let value = workspace_value();

        save_workspace_to(&path, &value).expect("save workspace");

        let loaded = load_workspace_from(&path)
            .expect("load workspace")
            .expect("workspace exists");
        assert_eq!(loaded, value);
        assert!(cleanup_artifacts(path.parent().expect("parent")).is_empty());
    }

    #[test]
    fn native_workspace_tests_missing_file_returns_none() {
        let (_dir, path) = temp_workspace_path();

        assert_eq!(load_workspace_from(&path).expect("load"), None);
    }

    #[test]
    fn native_workspace_tests_rejects_unsupported_documents() {
        let cases = [
            (
                serde_json::json!(null),
                "workspace document must be a JSON object",
            ),
            (
                serde_json::json!({
                    "version": 2,
                    "projects": [],
                    "sessions": [],
                    "paneLayouts": [],
                }),
                "unsupported workspace version",
            ),
            (
                serde_json::json!({
                    "version": 3,
                    "projects": {},
                    "sessions": [],
                    "paneLayouts": [],
                }),
                "workspace field 'projects' must be an array",
            ),
            (
                serde_json::json!({
                    "version": 3,
                    "projects": [],
                    "sessions": "bad",
                    "paneLayouts": [],
                }),
                "workspace field 'sessions' must be an array",
            ),
            (
                serde_json::json!({
                    "version": 3,
                    "projects": [],
                    "sessions": [],
                    "paneLayouts": {},
                }),
                "workspace field 'paneLayouts' must be an array",
            ),
        ];

        for (value, expected) in cases {
            let err = validate_workspace(&value).expect_err("expected validation failure");
            assert!(err.contains(expected), "expected '{expected}' in '{err}'");
        }
    }

    #[test]
    fn native_workspace_tests_invalid_save_does_not_create_missing_parent() {
        let dir = TempDir::new().expect("tempdir");
        let missing = dir.path().join(".psyche");
        let path = missing.join("macos-app").join("workspace-v3.json");
        let invalid = serde_json::json!({
            "version": 3,
            "projects": [],
            "sessions": {},
            "paneLayouts": [],
        });

        let error = save_workspace_to(&path, &invalid).expect_err("invalid save must fail");

        assert!(error.contains("workspace field 'sessions' must be an array"));
        assert!(!missing.exists());
        assert!(temp_files(dir.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_rejects_symlinked_app_owned_parents() {
        let psyche_case = TempDir::new().expect("tempdir");
        let psyche_outside = psyche_case.path().join("outside");
        fs::create_dir(&psyche_outside).expect("create outside");
        let psyche_sentinel = psyche_outside.join("sentinel");
        fs::write(&psyche_sentinel, b"outside-psyche").expect("write sentinel");
        symlink(&psyche_outside, psyche_case.path().join(".psyche")).expect("symlink .psyche");
        let psyche_path = psyche_case
            .path()
            .join(".psyche")
            .join("macos-app")
            .join("workspace-v3.json");

        let psyche_error =
            save_workspace_to(&psyche_path, &workspace_value()).expect_err("reject .psyche link");

        assert!(psyche_error.contains("symlink"));
        assert_eq!(
            fs::read(&psyche_sentinel).expect("read sentinel"),
            b"outside-psyche"
        );
        assert!(!psyche_outside.join("macos-app").exists());

        let app_case = TempDir::new().expect("tempdir");
        let psyche = app_case.path().join(".psyche");
        fs::create_dir(&psyche).expect("create .psyche");
        let app_outside = app_case.path().join("outside");
        fs::create_dir(&app_outside).expect("create outside");
        fs::set_permissions(&app_outside, fs::Permissions::from_mode(0o755))
            .expect("set outside permissions");
        let outside_mode = fs::metadata(&app_outside)
            .expect("outside metadata")
            .permissions()
            .mode()
            & 0o777;
        let app_sentinel = app_outside.join("sentinel");
        fs::write(&app_sentinel, b"outside-app").expect("write sentinel");
        symlink(&app_outside, psyche.join("macos-app")).expect("symlink macos-app");
        let app_path = psyche.join("macos-app").join("workspace-v3.json");

        let app_error =
            save_workspace_to(&app_path, &workspace_value()).expect_err("reject app link");

        assert!(app_error.contains("symlink"));
        assert_eq!(
            fs::read(&app_sentinel).expect("read sentinel"),
            b"outside-app"
        );
        assert_eq!(
            fs::metadata(&app_outside)
                .expect("outside metadata")
                .permissions()
                .mode()
                & 0o777,
            outside_mode
        );
        assert!(!app_outside.join("workspace-v3.json").exists());
        assert!(!workspace_lock_path(&app_outside, "workspace-v3.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_rejects_symlinked_workspace_and_lock() {
        let workspace_case = TempDir::new().expect("tempdir");
        let workspace_path = workspace_case.path().join("workspace-v3.json");
        let outside_workspace = workspace_case.path().join("outside-workspace.json");
        let outside_bytes =
            serde_json::to_vec(&workspace_with_project("outside")).expect("serialize outside");
        fs::write(&outside_workspace, &outside_bytes).expect("write outside workspace");
        symlink(&outside_workspace, &workspace_path).expect("symlink workspace");

        let workspace_error =
            save_workspace_to(&workspace_path, &workspace_with_project("attempted"))
                .expect_err("reject workspace symlink");

        assert!(workspace_error.contains("symlink"));
        assert!(fs::symlink_metadata(&workspace_path)
            .expect("workspace metadata")
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read(&outside_workspace).expect("read outside workspace"),
            outside_bytes
        );

        let lock_case = TempDir::new().expect("tempdir");
        let lock_workspace = lock_case.path().join("workspace-v3.json");
        let lock_path = workspace_lock_path(lock_case.path(), "workspace-v3.json");
        let outside_lock = lock_case.path().join("outside-lock");
        fs::write(&outside_lock, b"outside-lock").expect("write outside lock");
        fs::set_permissions(&outside_lock, fs::Permissions::from_mode(0o644))
            .expect("set lock permissions");
        let outside_mode = fs::metadata(&outside_lock)
            .expect("lock metadata")
            .permissions()
            .mode()
            & 0o777;
        symlink(&outside_lock, &lock_path).expect("symlink lock");

        let lock_error =
            save_workspace_to(&lock_workspace, &workspace_value()).expect_err("reject lock link");

        assert!(lock_error.contains("symlink"));
        assert_eq!(
            fs::read(&outside_lock).expect("read outside lock"),
            b"outside-lock"
        );
        assert_eq!(
            fs::metadata(&outside_lock)
                .expect("outside lock metadata")
                .permissions()
                .mode()
                & 0o777,
            outside_mode
        );
        assert!(!lock_workspace.exists());
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_rejects_symlinked_rollback_paths() {
        for marker in ["pending", "committed", "candidate", "forward"] {
            let case = TempDir::new().expect("tempdir");
            let path = case.path().join("workspace-v3.json");
            let current_bytes =
                serde_json::to_vec(&workspace_with_project("current")).expect("serialize current");
            fs::write(&path, &current_bytes).expect("write current");
            let outside = case.path().join(format!("outside-{marker}"));
            fs::write(&outside, b"outside-marker").expect("write outside marker");
            let marker_path = match marker {
                "pending" => pending_path(&path),
                "committed" => committed_path(&path),
                "candidate" => rollback_candidate_path(&path, "malicious"),
                "forward" => path
                    .parent()
                    .expect("parent")
                    .join(".workspace-v3.json.psyche-rollback.forward"),
                _ => unreachable!(),
            };
            symlink(&outside, &marker_path).expect("symlink marker");

            let error = load_workspace_from(&path).expect_err("reject rollback symlink");

            assert!(error.contains("symlink"), "{error}");
            assert_eq!(fs::read(&path).expect("read workspace"), current_bytes);
            assert_eq!(
                fs::read(&outside).expect("read outside marker"),
                b"outside-marker"
            );
            assert!(
                fs::symlink_metadata(&marker_path)
                    .expect("marker metadata")
                    .file_type()
                    .is_symlink(),
                "{marker} symlink must remain untouched"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_rejects_symlinked_restore_backup() {
        let case = TempDir::new().expect("tempdir");
        let workspace = case.path().join("workspace-v3.json");
        let workspace_bytes =
            serde_json::to_vec(&workspace_with_project("current")).expect("serialize workspace");
        fs::write(&workspace, &workspace_bytes).expect("write workspace");
        let outside = case.path().join("outside-backup");
        fs::write(&outside, b"outside-backup").expect("write outside backup");
        let backup = case.path().join("rollback.pending");
        symlink(&outside, &backup).expect("symlink backup");

        let error = restore_workspace_backup_standalone(&backup, &workspace)
            .expect_err("reject backup symlink");

        assert!(error.contains("symlink"));
        assert_eq!(
            fs::read(&workspace).expect("read workspace"),
            workspace_bytes
        );
        assert_eq!(
            fs::read(&outside).expect("read outside backup"),
            b"outside-backup"
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_rejects_symlinked_temp_path() {
        let case = TempDir::new().expect("tempdir");
        let outside = case.path().join("outside-temp");
        fs::write(&outside, b"outside-temp").expect("write outside temp");
        let temp = case.path().join(".workspace-v3.json.psyche-save-test");
        symlink(&outside, &temp).expect("symlink temp");

        let error = open_temp_file(&temp).expect_err("reject temp symlink");

        assert!(error.contains("symlink"));
        assert_eq!(
            fs::read(&outside).expect("read outside temp"),
            b"outside-temp"
        );
        assert!(fs::symlink_metadata(&temp)
            .expect("temp metadata")
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_preserves_prevalidation_publication_hook() {
        let (_dir, path) = temp_workspace_path();
        let previous = workspace_with_project("previous");
        fs::write(
            &path,
            serde_json::to_vec(&previous).expect("serialize previous workspace"),
        )
        .expect("write previous workspace");

        let error = workspace_save_to_test_hook_before_publication(
            &path,
            &workspace_with_project("attempted"),
            |temp| {
                assert!(
                    temp.exists(),
                    "prevalidation hook must receive the temp path"
                );
                Err("injected prevalidation publication fault".to_string())
            },
        )
        .expect_err("prevalidation publication fault must abort the save");

        assert!(error.contains("injected prevalidation publication fault"));
        assert_eq!(
            load_workspace_from(&path)
                .expect("restart recovery")
                .expect("previous workspace exists"),
            previous
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_rejects_temp_inode_swap_at_final_publication_boundary() {
        let (_dir, path) = temp_workspace_path();
        let previous = workspace_with_project("previous");
        let previous_bytes =
            serde_json::to_vec_pretty(&previous).expect("serialize previous workspace");
        fs::write(&path, &previous_bytes).expect("write previous workspace");
        let attacker_bytes = serde_json::to_vec(&workspace_with_project("attacker"))
            .expect("serialize attacker workspace");

        let error = workspace_save_to_test_swap_after_final_verification_before_rename(
            &path,
            &workspace_with_project("attempted"),
            attacker_bytes.clone(),
        )
        .expect_err("post-check temp inode swap must fail publication");

        assert!(
            !error.contains("fault point was not reached"),
            "the exact post-check/pre-rename hook must run: {error}"
        );
        assert!(error.contains("workspace temp"), "{error}");
        assert!(error.contains("changed"), "{error}");
        assert_ne!(
            fs::read(&path).expect("read workspace after failed save"),
            attacker_bytes
        );
        assert_eq!(
            load_workspace_from(&path)
                .expect("restart recovery")
                .expect("previous workspace exists"),
            previous
        );
        assert_eq!(
            fs::read(&path).expect("read recovered workspace"),
            previous_bytes
        );
        assert!(cleanup_artifacts(path.parent().expect("parent")).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_in_process_rollback_repairs_exact_window_candidate_swap() {
        let (_dir, path) = temp_workspace_path();
        let previous = workspace_with_project("previous");
        let previous_bytes =
            serde_json::to_vec_pretty(&previous).expect("serialize exact previous workspace");
        fs::write(&path, &previous_bytes).expect("write previous workspace");
        let attacker_bytes = serde_json::to_vec(&workspace_with_project("attacker"))
            .expect("serialize attacker workspace");
        let mut sync_calls = 0;

        let error = with_restore_candidate_swap(attacker_bytes.clone(), || {
            workspace_save_to_test_hook(
                &path,
                &workspace_with_project("updated"),
                |_| Ok(()),
                |_| {
                    sync_calls += 1;
                    if sync_calls == 2 {
                        Err("injected workspace sync failure".to_string())
                    } else {
                        Ok(())
                    }
                },
                restore_workspace_backup,
            )
        })
        .expect_err("failed save must report its original sync failure");

        assert!(
            !error.contains("fault point was not reached"),
            "the exact restore check-to-rename hook must run: {error}"
        );
        assert!(error.contains("injected workspace sync failure"), "{error}");
        assert_eq!(
            fs::read(&path).expect("read in-process rollback"),
            previous_bytes
        );
        assert_ne!(
            fs::read(&path).expect("read non-attacker workspace"),
            attacker_bytes
        );
        assert_eq!(
            load_workspace_from(&path).expect("restart recovery"),
            Some(previous)
        );
        assert_eq!(
            fs::read(&path).expect("read restarted rollback"),
            previous_bytes
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_restart_rollback_repairs_exact_window_candidate_swap() {
        let (_dir, path) = temp_workspace_path();
        let previous = workspace_with_project("previous");
        let previous_bytes =
            serde_json::to_vec_pretty(&previous).expect("serialize exact previous workspace");
        let updated_bytes =
            serde_json::to_vec(&workspace_with_project("updated")).expect("serialize updated");
        let attacker_bytes = serde_json::to_vec(&workspace_with_project("attacker"))
            .expect("serialize attacker workspace");
        fs::write(&path, &updated_bytes).expect("write uncommitted workspace");
        fs::write(pending_path(&path), &previous_bytes).expect("write pending rollback");
        sync_parent_directory_standalone(path.parent().expect("parent"))
            .expect("sync restart state");

        let restarted =
            with_restore_candidate_swap(attacker_bytes.clone(), || load_workspace_from(&path))
                .expect("restart recovery must repair a swapped restore candidate");

        assert_eq!(restarted, Some(previous));
        assert_eq!(
            fs::read(&path).expect("read restarted rollback"),
            previous_bytes
        );
        assert_ne!(
            fs::read(&path).expect("read non-attacker workspace"),
            attacker_bytes
        );
        assert!(rollback_artifacts(path.parent().expect("parent")).is_empty());
    }

    #[test]
    fn native_workspace_tests_initial_forward_decision_survives_repeated_resolution_sync_failures()
    {
        let (_dir, path) = temp_workspace_path();
        let attempted = workspace_with_project("attempted");
        let attempted_bytes =
            serde_json::to_vec(&attempted).expect("serialize attempted workspace");
        let parent = path.parent().expect("parent");
        let file_name = path
            .file_name()
            .expect("file name")
            .to_string_lossy()
            .to_string();
        let pending = workspace_absent_rollback_pending_path(parent, &file_name);
        let committed = workspace_absent_rollback_committed_path(parent, &file_name);
        let forward = workspace_forward_rollback_path(parent, &file_name);
        fs::write(&forward, &attempted_bytes).expect("write durable forward candidate");
        fs::write(&committed, ABSENT_FORWARD_MARKER).expect("write durable forward marker");
        sync_parent_directory_standalone(parent).expect("sync durable forward decision");

        let workspace_dir = SecureWorkspaceDir::open_for_load(&path)
            .expect("open workspace parent")
            .expect("workspace parent exists");
        let source_file = open_existing_regular_file(
            &workspace_dir,
            &forward,
            "workspace forward rollback",
            false,
        )
        .expect("open forward candidate")
        .expect("forward candidate exists");
        let mut sync_calls = 0;
        let result = resolve_initial_workspace_after_marker_failure(
            &workspace_dir,
            &source_file,
            &attempted_bytes,
            &path,
            parent,
            &pending,
            &committed,
            &forward,
            "injected initial decision failure".to_string(),
            &mut |_, _| {
                sync_calls += 1;
                if sync_calls <= 4 {
                    Err(format!(
                        "injected repeated initial resolution sync failure #{sync_calls}"
                    ))
                } else {
                    Ok(())
                }
            },
        );
        drop(source_file);
        drop(workspace_dir);

        assert_eq!(
            fs::read(&path).expect("forward workspace restored in process"),
            attempted_bytes
        );
        assert_eq!(
            load_workspace_from(&path).expect("restart recovery"),
            Some(attempted),
            "the durable forward decision must recover the new workspace after restart"
        );
        assert!(
            result.is_ok(),
            "a forward decision restored after bounded sync failures must return Ok: {result:?}"
        );
        assert!(
            sync_calls >= 5,
            "the resolver must make an explicit durable decision instead of returning from the pathname"
        );
    }

    fn assert_prior_resolver_uses_committed_forward_decision_after_restore_sync_failure(
        observed_workspace_bytes: &[u8],
        observation: &str,
    ) {
        let (_dir, path) = temp_workspace_path();
        let previous = workspace_with_project("previous");
        let previous_bytes =
            serde_json::to_vec_pretty(&previous).expect("serialize exact previous workspace");
        let updated = workspace_with_project("updated");
        let updated_bytes =
            serde_json::to_vec(&updated).expect("serialize exact updated workspace");
        let parent = path.parent().expect("parent");
        let file_name = path
            .file_name()
            .expect("file name")
            .to_string_lossy()
            .to_string();
        let pending = workspace_rollback_pending_path(parent, &file_name);
        let committed = workspace_rollback_committed_path(parent, &file_name);
        let forward = workspace_forward_rollback_path(parent, &file_name);
        fs::write(&path, &previous_bytes).expect("write observed prior workspace");
        fs::write(&committed, &previous_bytes).expect("write committed exact prior");
        fs::write(&forward, &updated_bytes).expect("write durable forward candidate");
        sync_parent_directory_standalone(parent).expect("sync committed forward decision");

        let workspace_dir = SecureWorkspaceDir::open_for_load(&path)
            .expect("open workspace parent")
            .expect("workspace parent exists");
        let source_file = open_existing_regular_file(
            &workspace_dir,
            &forward,
            "workspace forward rollback",
            false,
        )
        .expect("open forward candidate")
        .expect("forward candidate exists");
        let mut sync_calls = 0;
        let mut restore = restore_workspace_backup_in;
        let mut recreate = |_: &SecureWorkspaceDir, _: &Path, _: &Path| -> Result<(), String> {
            Err("injected pending rollback recreation failure".to_string())
        };
        let result = resolve_prior_workspace_after_commit_failure(
            &workspace_dir,
            &source_file,
            &updated_bytes,
            &previous_bytes,
            &path,
            parent,
            &pending,
            &committed,
            &forward,
            "injected committed decision failure".to_string(),
            &mut |_, _| {
                sync_calls += 1;
                match sync_calls {
                    1 => Err("injected forward recovery directory sync failure".to_string()),
                    2 => {
                        fs::remove_file(&path).map_err(|error| {
                            format!(
                                "remove workspace before setting {observation} pathname observation: {error}"
                            )
                        })?;
                        fs::write(&path, observed_workspace_bytes).map_err(|error| {
                            format!(
                                "set {observation} workspace after failed restore directory sync: {error}"
                            )
                        })?;
                        Err("injected restored prior directory sync failure".to_string())
                    }
                    _ => Ok(()),
                }
            },
            &mut restore,
            &mut recreate,
        );
        drop(source_file);
        drop(workspace_dir);

        let restarted = load_workspace_from(&path);
        assert_eq!(
            restarted.expect("restart must resolve the committed forward decision"),
            Some(updated),
            "{observation} pathname observation must not change restart recovery"
        );
        assert!(
            result.is_ok(),
            "{observation} pathname observation must not change the API result: {result:?}"
        );
        assert_eq!(
            fs::read(&path).expect("read restart-selected workspace"),
            updated_bytes
        );
        assert!(
            sync_calls >= 3,
            "the resolver must durably reconcile after the failed restore sync"
        );
    }

    #[test]
    fn native_workspace_tests_prior_resolver_ignores_observed_prior_after_restore_sync_failure() {
        let prior = serde_json::to_vec_pretty(&workspace_with_project("previous"))
            .expect("serialize observed prior");
        assert_prior_resolver_uses_committed_forward_decision_after_restore_sync_failure(
            &prior, "prior",
        );
    }

    #[test]
    fn native_workspace_tests_prior_resolver_ignores_observed_new_after_restore_sync_failure() {
        let updated =
            serde_json::to_vec(&workspace_with_project("updated")).expect("serialize observed new");
        assert_prior_resolver_uses_committed_forward_decision_after_restore_sync_failure(
            &updated, "new",
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_candidate_swap_and_trusted_retry_failure_never_leave_attacker_bytes()
    {
        let (_dir, path) = temp_workspace_path();
        let previous = workspace_with_project("previous");
        let previous_bytes =
            serde_json::to_vec_pretty(&previous).expect("serialize exact previous workspace");
        let updated = workspace_with_project("updated");
        let updated_bytes =
            serde_json::to_vec(&updated).expect("serialize exact updated workspace");
        let attacker_bytes = serde_json::to_vec(&workspace_with_project("attacker"))
            .expect("serialize attacker workspace");
        let parent = path.parent().expect("parent");
        let file_name = path
            .file_name()
            .expect("file name")
            .to_string_lossy()
            .to_string();
        let committed = workspace_rollback_committed_path(parent, &file_name);
        let forward = workspace_forward_rollback_path(parent, &file_name);
        fs::write(&path, &updated_bytes).expect("write uncommitted workspace");
        fs::write(&committed, &previous_bytes).expect("write exact committed prior");
        fs::write(&forward, &updated_bytes).expect("write durable forward candidate");
        sync_parent_directory_standalone(parent).expect("sync committed recovery state");

        let workspace_dir = SecureWorkspaceDir::open_for_load(&path)
            .expect("open workspace parent")
            .expect("workspace parent exists");
        let restored = with_restore_candidate_swap_and_trusted_retry_failure(
            attacker_bytes.clone(),
            RestoreCandidateFileOperation::Write,
            || restore_workspace_backup_in(&workspace_dir, &committed, &path),
        );
        drop(workspace_dir);

        fs::remove_file(&path).expect("simulate crash after the swapped candidate publication");
        fs::write(&path, &attacker_bytes).expect("restore attacker bytes before restart");
        sync_parent_directory_standalone(parent).expect("sync simulated crash state");
        let restarted = load_workspace_from(&path);
        assert!(
            restored.is_ok(),
            "a pinned reserve must repair the swapped candidate after the trusted retry fails: {restored:?}"
        );
        assert_eq!(
            restarted.expect("restart must reconstruct the exact committed prior"),
            Some(previous)
        );
        assert_ne!(
            fs::read(&path).expect("read resolved workspace"),
            attacker_bytes,
            "attacker bytes must never become the authoritative workspace"
        );
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_rejects_non_regular_workspace_targets() {
        let directory_case = TempDir::new().expect("tempdir");
        let directory_path = directory_case.path().join("workspace-v3.json");
        fs::create_dir(&directory_path).expect("create workspace directory");

        let directory_error =
            workspace_file_exists(&directory_path).expect_err("reject workspace directory");
        assert!(directory_error.contains("regular file"));
        assert!(directory_path.is_dir());

        let fifo_case = TempDir::new().expect("tempdir");
        let fifo_path = fifo_case.path().join("workspace-v3.json");
        create_fifo(&fifo_path);

        let fifo_error = workspace_file_exists(&fifo_path).expect_err("reject workspace fifo");
        assert!(fifo_error.contains("regular file"));
        assert!(fs::symlink_metadata(&fifo_path)
            .expect("fifo metadata")
            .file_type()
            .is_fifo());
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_rejects_non_regular_lock_targets() {
        let directory_case = TempDir::new().expect("tempdir");
        let directory_workspace = directory_case.path().join("workspace-v3.json");
        let directory_lock = workspace_lock_path(directory_case.path(), "workspace-v3.json");
        fs::create_dir(&directory_lock).expect("create lock directory");

        let directory_error = save_workspace_to(&directory_workspace, &workspace_value())
            .expect_err("reject lock directory");
        assert!(directory_error.contains("regular file"));
        assert!(directory_lock.is_dir());
        assert!(!directory_workspace.exists());

        let fifo_case = TempDir::new().expect("tempdir");
        let fifo_workspace = fifo_case.path().join("workspace-v3.json");
        let fifo_lock = workspace_lock_path(fifo_case.path(), "workspace-v3.json");
        create_fifo(&fifo_lock);

        let fifo_error =
            save_workspace_to(&fifo_workspace, &workspace_value()).expect_err("reject lock fifo");
        assert!(fifo_error.contains("regular file"));
        assert!(fs::symlink_metadata(&fifo_lock)
            .expect("fifo metadata")
            .file_type()
            .is_fifo());
        assert!(!fifo_workspace.exists());
    }

    #[test]
    fn native_workspace_tests_rejects_invalid_json() {
        let (_dir, path) = temp_workspace_path();
        fs::write(&path, b"{not json").expect("write invalid json");

        let err = load_workspace_from(&path).expect_err("load should fail");
        assert!(err.contains("parse workspace"));
    }

    #[test]
    fn native_workspace_tests_load_recovers_pending_rollback_and_cleans_markers() {
        let (_dir, path) = temp_workspace_path();
        let previous = workspace_with_project("previous");
        fs::write(&path, b"{uncommitted partial workspace").expect("write workspace");
        let pending = pending_path(&path);
        fs::write(&pending, serde_json::to_vec(&previous).expect("serialize"))
            .expect("write pending rollback");
        let committed = committed_path(&path);
        fs::write(
            &committed,
            serde_json::to_vec(&workspace_with_project("stale committed")).expect("serialize"),
        )
        .expect("write committed rollback");
        let candidate = rollback_candidate_path(&path, "partial");
        fs::write(&candidate, b"{partial rollback candidate").expect("write candidate");

        let loaded = load_workspace_from(&path)
            .expect("load must recover pending rollback")
            .expect("workspace exists");

        assert_eq!(loaded, previous);
        assert!(!pending.exists());
        assert!(!committed.exists());
        assert!(!candidate.exists());
    }

    #[test]
    fn native_workspace_tests_load_rechecks_state_after_exclusive_lock_upgrade() {
        let (_dir, path) = temp_workspace_path();
        fs::write(
            &path,
            serde_json::to_vec(&workspace_with_project("uncommitted")).expect("serialize"),
        )
        .expect("write workspace");
        let pending = pending_path(&path);
        fs::write(
            &pending,
            serde_json::to_vec(&workspace_with_project("previous")).expect("serialize"),
        )
        .expect("write pending rollback");
        let committed = committed_path(&path);
        let resolved = workspace_with_project("resolved elsewhere");
        let resolved_bytes = serde_json::to_vec(&resolved).expect("serialize resolved workspace");

        let loaded = load_workspace_from_test_hook(&path, || {
            fs::write(&path, &resolved_bytes).map_err(|error| error.to_string())?;
            fs::rename(&pending, &committed).map_err(|error| error.to_string())?;
            sync_parent_directory_standalone(path.parent().expect("parent"))
        })
        .expect("load after raced recovery")
        .expect("workspace exists");

        assert_eq!(loaded, resolved);
        assert!(!pending.exists());
        assert!(!committed.exists());
    }

    #[test]
    fn native_workspace_tests_pending_recovery_precedes_later_save() {
        let (_dir, path) = temp_workspace_path();
        let previous = workspace_with_project("previous");
        let previous_bytes = serde_json::to_vec(&previous).expect("serialize previous");
        fs::write(
            &path,
            serde_json::to_vec(&workspace_with_project("unrecovered")).expect("serialize"),
        )
        .expect("write workspace");
        let pending = pending_path(&path);
        fs::write(&pending, &previous_bytes).expect("write pending rollback");
        let later = workspace_with_project("later");

        workspace_save_to_test_hook(
            &path,
            &later,
            |_| {
                assert_eq!(
                    fs::read(&path).expect("read recovered workspace"),
                    previous_bytes
                );
                Ok(())
            },
            sync_parent_directory,
            restore_workspace_backup,
        )
        .expect("later save should recover pending first");

        assert_eq!(
            load_workspace_from(&path)
                .expect("load later workspace")
                .expect("workspace exists"),
            later
        );
        assert!(!pending.exists());
    }

    #[test]
    fn native_workspace_tests_failed_pending_restore_leaves_pending_intact() {
        let (_dir, path) = temp_workspace_path();
        let previous_bytes =
            serde_json::to_vec(&workspace_with_project("previous")).expect("serialize previous");
        fs::write(
            &path,
            serde_json::to_vec(&workspace_with_project("unrecovered")).expect("serialize"),
        )
        .expect("write workspace");
        let pending = pending_path(&path);
        fs::write(&pending, &previous_bytes).expect("write pending rollback");

        let error = workspace_save_to_test_hook(
            &path,
            &workspace_with_project("later"),
            |_| Ok(()),
            sync_parent_directory,
            |backup, destination| {
                assert_eq!(backup, pending);
                assert_eq!(destination, path);
                Err("injected restore failure".to_string())
            },
        )
        .expect_err("failed recovery must block the save");

        assert!(error.contains("injected restore failure"));
        assert!(error.contains(&pending.display().to_string()));
        assert_eq!(
            fs::read(&pending).expect("read pending rollback"),
            previous_bytes
        );
    }

    #[test]
    fn native_workspace_tests_committed_rollback_is_cleanup_only() {
        let (_dir, path) = temp_workspace_path();
        fs::write(
            &path,
            serde_json::to_vec(&workspace_with_project("committed")).expect("serialize"),
        )
        .expect("write committed workspace");
        let committed = committed_path(&path);
        fs::write(
            &committed,
            serde_json::to_vec(&workspace_with_project("old")).expect("serialize"),
        )
        .expect("write committed rollback");
        let later = workspace_with_project("later");

        workspace_save_to_test_hook(
            &path,
            &later,
            |temp| {
                assert_eq!(
                    load_workspace_from_locked(&path)
                        .expect("load committed workspace")
                        .expect("workspace exists"),
                    workspace_with_project("committed")
                );
                assert!(temp.exists());
                Ok(())
            },
            sync_parent_directory,
            restore_workspace_backup,
        )
        .expect("committed rollback must not be restored");

        assert_eq!(
            load_workspace_from(&path)
                .expect("load later workspace")
                .expect("workspace exists"),
            later
        );
        assert!(!committed.exists());
    }

    #[test]
    fn native_workspace_tests_marker_rename_failure_preserves_pending() {
        let (_dir, path) = temp_workspace_path();
        let previous = workspace_with_project("previous");
        let previous_bytes = serde_json::to_vec(&previous).expect("serialize previous");
        fs::write(&path, &previous_bytes).expect("write previous workspace");
        let pending = pending_path(&path);
        let committed = committed_path(&path);
        let updated = workspace_with_project("updated");

        let error = workspace_save_to_test_hook_with_ops(
            &path,
            &updated,
            |_| Ok(()),
            sync_parent_directory,
            restore_workspace_backup,
            create_rollback_backup,
            |source, destination| {
                if source == pending && destination == committed {
                    return Err("injected marker rename failure".to_string());
                }
                Ok(())
            },
        )
        .expect_err("marker rename failure must fail with pending preserved");

        assert!(error.contains("injected marker rename failure"));
        assert!(error.contains(&pending.display().to_string()));
        assert_eq!(
            fs::read(&pending).expect("read pending rollback"),
            previous_bytes
        );
        assert_eq!(
            load_workspace_from_locked(&path)
                .expect("load replacement")
                .expect("workspace exists"),
            updated
        );
        assert!(!committed.exists());

        let later = workspace_with_project("later");
        workspace_save_to_test_hook(
            &path,
            &later,
            |_| {
                assert_eq!(
                    fs::read(&path).expect("read recovered workspace"),
                    previous_bytes
                );
                Ok(())
            },
            sync_parent_directory,
            restore_workspace_backup,
        )
        .expect("next save must recover pending rollback");
        assert_eq!(
            load_workspace_from(&path)
                .expect("load later workspace")
                .expect("workspace exists"),
            later
        );
    }

    #[test]
    fn native_workspace_tests_marker_sync_failure_preserves_pending_recovery() {
        let (_dir, path) = temp_workspace_path();
        let previous_bytes =
            serde_json::to_vec(&workspace_with_project("previous")).expect("serialize previous");
        fs::write(&path, &previous_bytes).expect("write previous workspace");
        let pending = pending_path(&path);
        let committed = committed_path(&path);
        let updated = workspace_with_project("updated");
        let mut sync_calls = 0;

        let error = workspace_save_to_test_hook(
            &path,
            &updated,
            |_| Ok(()),
            |_| {
                sync_calls += 1;
                if sync_calls == 3 {
                    Err("injected marker sync failure".to_string())
                } else {
                    Ok(())
                }
            },
            restore_workspace_backup,
        )
        .expect_err("marker sync failure must leave a recoverable failure");

        assert!(error.contains("injected marker sync failure"));
        assert!(error.contains(&pending.display().to_string()));
        assert_eq!(
            fs::read(&pending).expect("read pending rollback"),
            previous_bytes
        );
        assert_eq!(
            fs::read(&committed).expect("read committed rollback"),
            previous_bytes
        );
        assert_eq!(
            load_workspace_from_locked(&path)
                .expect("load replacement")
                .expect("workspace exists"),
            updated
        );
        assert_eq!(
            load_workspace_from(&path)
                .expect("load must recover pending rollback")
                .expect("workspace exists"),
            workspace_with_project("previous")
        );
        assert!(!pending.exists());
    }

    #[test]
    fn native_workspace_tests_failed_marker_preservation_restart_returns_previous_json() {
        let (_dir, path) = temp_workspace_path();
        let previous = workspace_with_project("previous");
        fs::write(
            &path,
            serde_json::to_vec(&previous).expect("serialize previous"),
        )
        .expect("write previous workspace");
        let pending = pending_path(&path);
        let committed = committed_path(&path);
        let mut sync_calls = 0;

        let error = workspace_save_to_test_hook_with_ops(
            &path,
            &workspace_with_project("updated"),
            |_| Ok(()),
            |_| {
                sync_calls += 1;
                if sync_calls == 3 {
                    Err("injected marker durability failure".to_string())
                } else {
                    Ok(())
                }
            },
            restore_workspace_backup,
            create_rollback_backup,
            |source, destination| {
                if source == pending && destination == committed {
                    fs::rename(source, destination).map_err(|error| error.to_string())?;
                    return Err("injected post-rename marker failure".to_string());
                }
                Ok(())
            },
        )
        .expect_err("undurable marker preservation must fail the save");

        assert!(error.contains("injected post-rename marker failure"));
        assert!(error.contains("injected marker durability failure"));
        assert!(pending.exists());
        assert!(committed.exists());

        fs::remove_file(&pending).expect("simulate loss of undurable pending marker");
        sync_parent_directory_standalone(path.parent().expect("parent"))
            .expect("sync simulated restart state");

        assert_eq!(
            load_workspace_from(&path)
                .expect("restart load")
                .expect("workspace exists"),
            previous
        );
    }

    #[test]
    fn native_workspace_tests_reported_marker_rename_failure_never_returns_success() {
        let (_dir, path) = temp_workspace_path();
        let previous = workspace_with_project("previous");
        fs::write(
            &path,
            serde_json::to_vec(&previous).expect("serialize previous"),
        )
        .expect("write previous workspace");
        let pending = pending_path(&path);
        let committed = committed_path(&path);

        let error = workspace_save_to_test_hook_with_ops(
            &path,
            &workspace_with_project("updated"),
            |_| Ok(()),
            sync_parent_directory,
            restore_workspace_backup,
            create_rollback_backup,
            |source, destination| {
                if source == pending && destination == committed {
                    fs::rename(source, destination).map_err(|error| error.to_string())?;
                    return Err("injected post-rename marker failure".to_string());
                }
                Ok(())
            },
        )
        .expect_err("reported marker rename failure must not return success");

        assert!(error.contains("injected post-rename marker failure"));
        assert_eq!(
            load_workspace_from(&path)
                .expect("recovery-aware load")
                .expect("workspace exists"),
            previous
        );
    }

    #[test]
    fn native_workspace_tests_repeated_marker_sync_failure_recovers_previous_bytes() {
        let (_dir, path) = temp_workspace_path();
        let previous_bytes =
            serde_json::to_vec(&workspace_with_project("previous")).expect("serialize previous");
        fs::write(&path, &previous_bytes).expect("write previous workspace");
        let pending = pending_path(&path);
        let committed = committed_path(&path);
        let updated = workspace_with_project("updated");
        let mut sync_calls = 0;

        let error = workspace_save_to_test_hook(
            &path,
            &updated,
            |_| Ok(()),
            |_| {
                sync_calls += 1;
                if sync_calls >= 3 {
                    Err("injected marker sync failure".to_string())
                } else {
                    Ok(())
                }
            },
            restore_workspace_backup,
        )
        .expect_err("save must fail while marker durability remains unavailable");

        assert!(error.contains("injected marker sync failure"));
        assert_eq!(
            fs::read(&pending).expect("read pending rollback"),
            previous_bytes
        );
        assert_eq!(
            fs::read(&committed).expect("read committed rollback"),
            previous_bytes
        );
        assert_eq!(
            load_workspace_from(&path)
                .expect("load must recover the failed save")
                .expect("workspace exists"),
            workspace_with_project("previous")
        );
        assert!(!pending.exists());
        assert!(!committed.exists());
        assert_eq!(
            fs::read(&path).expect("read recovered workspace"),
            previous_bytes
        );
    }

    #[test]
    fn native_workspace_tests_workspace_rename_failure_restores_pending() {
        let (_dir, path) = temp_workspace_path();
        let previous = workspace_with_project("previous");
        fs::write(
            &path,
            serde_json::to_vec(&previous).expect("serialize previous"),
        )
        .expect("write previous workspace");
        let updated = workspace_with_project("updated");

        let error = workspace_save_to_test_hook_with_ops(
            &path,
            &updated,
            |_| Ok(()),
            sync_parent_directory,
            restore_workspace_backup,
            create_rollback_backup,
            |source, destination| {
                if destination == path
                    && source
                        .file_name()
                        .expect("source file name")
                        .to_string_lossy()
                        .contains(".psyche-save-")
                {
                    return Err("injected workspace rename failure".to_string());
                }
                Ok(())
            },
        )
        .expect_err("workspace rename failure must roll back");

        assert!(error.contains("injected workspace rename failure"));
        assert_eq!(
            load_workspace_from(&path)
                .expect("load restored workspace")
                .expect("workspace exists"),
            previous
        );
        assert!(!pending_path(&path).exists());
        assert!(!committed_path(&path).exists());
    }

    #[test]
    fn native_workspace_tests_initial_save_post_publication_error_restores_absence() {
        let (_dir, path) = temp_workspace_path();

        let error = workspace_save_to_test_hook_with_ops(
            &path,
            &workspace_with_project("attempted"),
            |_| Ok(()),
            sync_parent_directory,
            restore_workspace_backup,
            create_rollback_backup,
            |source, destination| {
                if destination == path
                    && source
                        .file_name()
                        .expect("source file name")
                        .to_string_lossy()
                        .contains(".psyche-save-")
                {
                    fs::rename(source, destination).map_err(|error| error.to_string())?;
                    return Err("injected post-publication failure".to_string());
                }
                Ok(())
            },
        )
        .expect_err("reported publication failure must restore prior absence");

        assert!(error.contains("injected post-publication failure"));
        assert!(
            !path.exists(),
            "failed initial save must be absent in-process"
        );
        assert_eq!(
            load_workspace_from(&path).expect("restart recovery"),
            None,
            "failed initial save must remain absent after restart"
        );
        let parent = path.parent().expect("parent");
        assert!(cleanup_artifacts(parent).is_empty());
        assert!(rollback_artifacts(parent).is_empty());
    }

    #[test]
    fn native_workspace_tests_initial_save_marker_rename_failure_restores_absence() {
        let (_dir, path) = temp_workspace_path();
        let pending = absent_pending_path(&path);
        let committed = absent_committed_path(&path);

        let error = workspace_save_to_test_hook_with_ops(
            &path,
            &workspace_with_project("attempted"),
            |_| Ok(()),
            sync_parent_directory,
            restore_workspace_backup,
            create_rollback_backup,
            |source, destination| {
                if source == pending && destination == committed {
                    return Err("injected initial marker rename failure".to_string());
                }
                Ok(())
            },
        )
        .expect_err("initial marker rename failure must restore prior absence");

        assert!(error.contains("injected initial marker rename failure"));
        assert!(
            !path.exists(),
            "failed initial save must be absent in-process"
        );
        assert_eq!(
            load_workspace_from(&path).expect("restart recovery"),
            None,
            "failed initial save must remain absent after restart"
        );
        let parent = path.parent().expect("parent");
        assert!(cleanup_artifacts(parent).is_empty());
        assert!(rollback_artifacts(parent).is_empty());
    }

    #[test]
    fn native_workspace_tests_initial_save_marker_sync_failure_restores_absence() {
        let (_dir, path) = temp_workspace_path();
        let mut sync_calls = 0;

        let error = workspace_save_to_test_hook(
            &path,
            &workspace_with_project("attempted"),
            |_| Ok(()),
            |_| {
                sync_calls += 1;
                if sync_calls == 3 {
                    Err("injected initial marker sync failure".to_string())
                } else {
                    Ok(())
                }
            },
            restore_workspace_backup,
        )
        .expect_err("initial marker sync failure must restore prior absence");

        assert!(error.contains("injected initial marker sync failure"));
        assert!(
            !path.exists(),
            "failed initial save must be absent in-process"
        );
        assert_eq!(
            load_workspace_from(&path).expect("restart recovery"),
            None,
            "failed initial save must remain absent after restart"
        );
        let parent = path.parent().expect("parent");
        assert!(cleanup_artifacts(parent).is_empty());
        assert!(rollback_artifacts(parent).is_empty());
    }

    #[test]
    fn native_workspace_tests_repeated_initial_rollback_sync_failure_resolves_forward() {
        let (_dir, path) = temp_workspace_path();
        let attempted = workspace_with_project("attempted");
        let attempted_bytes =
            serde_json::to_vec(&attempted).expect("serialize attempted workspace");
        let pending = absent_pending_path(&path);
        let committed = absent_committed_path(&path);
        let forward = path
            .parent()
            .expect("parent")
            .join(".workspace-v3.json.psyche-rollback.forward");
        let mut sync_calls = 0;

        let result = workspace_save_to_test_hook_with_recreation_fault(
            &path,
            &attempted,
            |_| {
                sync_calls += 1;
                if (3..=10).contains(&sync_calls) {
                    return Err(format!(
                        "injected repeated directory sync failure #{sync_calls}"
                    ));
                }
                Ok(())
            },
            |source, destination| {
                assert_eq!(source, committed);
                assert_eq!(destination, pending);
                Err("injected pending marker recreation failure".to_string())
            },
        );

        assert!(
            (6..=11).contains(&sync_calls),
            "resolution must use a bounded number of certification, forward, and rollback syncs"
        );
        if result.is_err() {
            fs::write(&path, &attempted_bytes)
                .expect("simulate loss of every undurable rollback/removal");
        } else {
            assert!(forward.exists(), "forward recovery inode must be retained");
            assert!(
                path.exists(),
                "forward resolver must restore the workspace inode"
            );
        }
        sync_parent_directory_standalone(path.parent().expect("parent"))
            .expect("sync simulated restart state");
        let restarted = load_workspace_from(&path).expect("restart recovery");

        assert_eq!(
            result.is_ok(),
            restarted == Some(attempted.clone()),
            "the API result must match the only restart-recoverable state"
        );
        result
            .expect("repeated rollback sync failure must resolve the durable publication forward");
        assert_eq!(restarted, Some(attempted));
        let parent = path.parent().expect("parent");
        assert!(cleanup_artifacts(parent).is_empty());
        assert!(rollback_artifacts(parent).is_empty());
    }

    #[test]
    fn native_workspace_tests_initial_marker_directory_failure_matches_reverted_marker_restart() {
        let (_dir, path) = temp_workspace_path();
        let attempted = workspace_with_project("attempted");
        let pending = absent_pending_path(&path);
        let committed = absent_committed_path(&path);
        let mut sync_calls = 0;
        let mut recreation_calls = 0;

        let (result, marker_failures) = workspace_save_to_test_marker_and_directory_faults(
            &path,
            &attempted,
            MarkerFileFaultMode::RepeatedWriteWithPersistedEmptyMarker,
            |_| {
                sync_calls += 1;
                if (3..=8).contains(&sync_calls) {
                    Err(format!(
                        "injected repeated marker directory sync failure #{sync_calls}"
                    ))
                } else {
                    Ok(())
                }
            },
            |source, destination| {
                recreation_calls += 1;
                assert_eq!(source, committed);
                assert_eq!(destination, pending);
                Err("injected pending marker recreation failure".to_string())
            },
        );

        assert!(
            (6..=10).contains(&sync_calls),
            "resolution must attempt the bounded certification and markerless states"
        );
        assert_eq!(recreation_calls, 1);
        assert_eq!(marker_failures, 1);
        if committed.exists() {
            assert!(!pending.exists());
            fs::rename(&committed, &pending).expect("simulate lost marker rename");
        }
        sync_parent_directory_standalone(path.parent().expect("parent"))
            .expect("sync simulated restart state");

        let restarted = load_workspace_from(&path).expect("restart recovery");
        assert_eq!(
            result.is_ok(),
            restarted == Some(attempted.clone()),
            "the API result must match the reverted-marker restart state"
        );
        if result.is_err() {
            assert_eq!(restarted, None);
        }
    }

    #[test]
    fn native_workspace_tests_cascading_certification_and_markerless_sync_failures_resolve_forward()
    {
        let (_dir, path) = temp_workspace_path();
        let attempted = workspace_with_project("attempted");
        let pending = absent_pending_path(&path);
        let committed = absent_committed_path(&path);
        let forward = path
            .parent()
            .expect("parent")
            .join(".workspace-v3.json.psyche-rollback.forward");
        let mut sync_calls = 0;

        let (result, marker_failures) = workspace_save_to_test_marker_and_directory_faults(
            &path,
            &attempted,
            MarkerFileFaultMode::RepeatedSyncWithPersistedForwardMarker,
            |_| {
                sync_calls += 1;
                if (4..=5).contains(&sync_calls) {
                    Err(format!(
                        "injected repeated markerless directory sync failure #{sync_calls}"
                    ))
                } else {
                    Ok(())
                }
            },
            |_, _| Ok(()),
        );

        assert_eq!(marker_failures, 4);
        assert!(
            (5..=6).contains(&sync_calls),
            "resolver must stop after the bounded markerless and final forward syncs"
        );
        assert!(
            forward.exists(),
            "durable forward inode must remain available"
        );
        assert!(!pending.exists());
        assert!(!committed.exists());
        if !path.exists() {
            fs::hard_link(&forward, &path).expect("simulate reappearing workspace inode");
        }
        if !committed.exists() {
            fs::write(&committed, ABSENT_FORWARD_MARKER)
                .expect("simulate reappearing durable forward marker");
        }
        sync_parent_directory_standalone(path.parent().expect("parent"))
            .expect("sync simulated restart state");

        let restarted = load_workspace_from(&path).expect("restart recovery");
        assert_eq!(
            result.is_ok(),
            restarted == Some(attempted.clone()),
            "the API result must match the forward-recoverable restart state"
        );
        result.expect("forward-recoverable restart state must return success");
        assert_eq!(restarted, Some(attempted));
        let parent = path.parent().expect("parent");
        assert!(cleanup_artifacts(parent).is_empty());
        assert!(rollback_artifacts(parent).is_empty());
    }

    #[test]
    fn native_workspace_tests_repeated_marker_write_failures_match_restart_recovery() {
        let (_dir, path) = temp_workspace_path();
        let attempted = workspace_with_project("attempted");

        let (result, marker_failures) = workspace_save_to_test_marker_file_fault(
            &path,
            &attempted,
            MarkerFileFaultMode::RepeatedWriteWithPersistedEmptyMarker,
        );

        assert_eq!(
            marker_failures, 3,
            "all bounded forward, rollback, and forward marker rewrites must be faulted"
        );
        let restarted = load_workspace_from(&path).expect("restart recovery");
        assert_eq!(
            result.is_ok(),
            restarted == Some(attempted.clone()),
            "the API result must match the restart-recoverable state"
        );
        result.expect("a durable empty committed marker recovers the new workspace forward");
        assert_eq!(restarted, Some(attempted));
    }

    #[test]
    fn native_workspace_tests_repeated_marker_file_sync_failures_match_restart_recovery() {
        let (_dir, path) = temp_workspace_path();
        let attempted = workspace_with_project("attempted");

        let (result, marker_failures) = workspace_save_to_test_marker_file_fault(
            &path,
            &attempted,
            MarkerFileFaultMode::RepeatedSyncWithPersistedForwardMarker,
        );

        assert_eq!(
            marker_failures, 4,
            "all bounded forward, rollback, forward, and certification syncs must be faulted"
        );
        let restarted = load_workspace_from(&path).expect("restart recovery");
        assert_eq!(
            result.is_ok(),
            restarted == Some(attempted.clone()),
            "the API result must match the restart-recoverable state"
        );
        result.expect("a durable forward marker recovers the new workspace forward");
        assert_eq!(restarted, Some(attempted));
    }

    #[test]
    fn native_workspace_tests_initial_final_sync_workspace_swap_matches_restart_result() {
        let (_dir, path) = temp_workspace_path();
        let attempted = workspace_with_project("attempted");
        let swapped = workspace_with_project("swapped-after-final-sync");
        let swapped_bytes = serde_json::to_vec(&swapped).expect("serialize swapped workspace");

        let result = workspace_save_to_test_post_initial_forward_sync_fault(
            &path,
            &attempted,
            PostInitialForwardSyncFault::ReplaceWorkspace(swapped_bytes),
        );

        let restarted = load_workspace_from(&path);
        match result {
            Ok(()) => assert_eq!(
                restarted.expect("successful save must restart cleanly"),
                Some(attempted),
                "Ok must retain the verified new workspace"
            ),
            Err(_) => assert_eq!(
                restarted.expect("failed save must restart cleanly"),
                None,
                "Err must retain prior absence"
            ),
        }
    }

    #[test]
    fn native_workspace_tests_partial_marker_write_matches_initial_restart_result() {
        let (_dir, path) = temp_workspace_path();
        let attempted = workspace_with_project("attempted");

        let (result, marker_failures) = workspace_save_to_test_marker_file_fault(
            &path,
            &attempted,
            MarkerFileFaultMode::PartialWriteWithPersistedTornMarker,
        );

        assert!(
            (1..=4).contains(&marker_failures),
            "torn-marker recovery must remain bounded"
        );
        let restarted = load_workspace_from(&path);
        match result {
            Ok(()) => assert_eq!(
                restarted.expect("successful save must restart cleanly"),
                Some(attempted),
                "Ok must retain the verified new workspace"
            ),
            Err(_) => assert_eq!(
                restarted.expect("failed save must restart cleanly"),
                None,
                "Err must retain prior absence"
            ),
        }
    }

    #[test]
    fn native_workspace_tests_restart_resolves_malformed_internal_marker_with_forward_candidate() {
        let (_dir, path) = temp_workspace_path();
        let attempted = workspace_with_project("attempted");
        let attempted_bytes = serde_json::to_vec(&attempted).expect("serialize attempted");
        fs::write(&path, &attempted_bytes).expect("write workspace");
        let forward = workspace_forward_rollback_path(
            path.parent().expect("parent"),
            path.file_name()
                .expect("file name")
                .to_string_lossy()
                .as_ref(),
        );
        fs::hard_link(&path, &forward).expect("publish forward candidate");
        fs::write(absent_committed_path(&path), b"torn-forward-marker")
            .expect("write malformed committed marker");
        sync_parent_directory_standalone(path.parent().expect("parent"))
            .expect("sync restart state");

        assert_eq!(
            load_workspace_from(&path).expect("malformed internal marker must be resolved"),
            Some(attempted)
        );
        assert_eq!(
            fs::read(&path).expect("read recovered workspace"),
            attempted_bytes
        );
        assert!(rollback_artifacts(path.parent().expect("parent")).is_empty());
    }

    #[test]
    fn native_workspace_tests_prior_marker_cascade_matches_exact_restart_bytes() {
        let (_dir, path) = temp_workspace_path();
        let previous = workspace_with_project("previous");
        let previous_bytes =
            serde_json::to_vec_pretty(&previous).expect("serialize exact previous bytes");
        fs::write(&path, &previous_bytes).expect("write previous workspace");
        let updated = workspace_with_project("updated");
        let updated_bytes = serde_json::to_vec(&updated).expect("serialize updated workspace");
        let mut sync_calls = 0;

        let result = workspace_save_to_test_hook_with_recreation_fault(
            &path,
            &updated,
            |_| {
                sync_calls += 1;
                match sync_calls {
                    3 => Err("injected committed marker sync failure".to_string()),
                    4 => {
                        fs::write(&path, &updated_bytes)
                            .map_err(|error| format!("restore undurable new workspace: {error}"))?;
                        Err("injected fallback rollback sync failure".to_string())
                    }
                    _ => Ok(()),
                }
            },
            |source, destination| {
                assert_eq!(source, committed_path(&path));
                assert_eq!(destination, pending_path(&path));
                Err("injected pending marker recreation failure".to_string())
            },
        );

        assert_eq!(
            sync_calls, 5,
            "the complete failure cascade and bounded forward certification must run"
        );
        let restarted = load_workspace_from(&path).expect("restart recovery");
        match result {
            Ok(()) => {
                assert_eq!(restarted, Some(updated));
                assert_eq!(
                    fs::read(&path).expect("read committed workspace"),
                    updated_bytes
                );
            }
            Err(_) => {
                assert_eq!(restarted, Some(previous));
                assert_eq!(
                    fs::read(&path).expect("read restored prior workspace"),
                    previous_bytes
                );
            }
        }
    }

    #[test]
    fn native_workspace_tests_prior_final_resolution_matches_exact_restart_bytes() {
        let (_dir, path) = temp_workspace_path();
        let previous = workspace_with_project("previous");
        let previous_bytes =
            serde_json::to_vec_pretty(&previous).expect("serialize exact previous bytes");
        fs::write(&path, &previous_bytes).expect("write previous workspace");
        let updated = workspace_with_project("updated");
        let updated_bytes = serde_json::to_vec(&updated).expect("serialize updated workspace");
        let mut sync_calls = 0;
        let mut recreation_calls = 0;

        let result = workspace_save_to_test_hook_with_recreation_fault(
            &path,
            &updated,
            |_| {
                sync_calls += 1;
                match sync_calls {
                    3 => Err("injected committed marker sync failure".to_string()),
                    4 => Err("injected restored rollback sync failure".to_string()),
                    5 => Err("injected forced forward certification sync failure".to_string()),
                    6 => {
                        fs::write(&path, &updated_bytes).map_err(|error| {
                            format!("restore restart-selected forward workspace: {error}")
                        })?;
                        Err("injected final remaining rollback sync failure".to_string())
                    }
                    _ => Ok(()),
                }
            },
            |source, destination| {
                recreation_calls += 1;
                assert_eq!(source, committed_path(&path));
                assert_eq!(destination, pending_path(&path));
                Err(format!(
                    "injected pending rollback recreation failure #{recreation_calls}"
                ))
            },
        );

        assert!(
            (5..=8).contains(&sync_calls),
            "final resolution must remain bounded, observed {sync_calls} syncs"
        );
        assert!(
            (3..=5).contains(&recreation_calls),
            "all rollback recovery copies must be traced, observed {recreation_calls} recreations"
        );
        let restarted = load_workspace_from(&path).expect("restart recovery");
        let restarted_bytes = fs::read(&path).expect("read restarted workspace");
        match result {
            Ok(()) => {
                assert_eq!(restarted, Some(updated));
                assert_eq!(restarted_bytes, updated_bytes);
            }
            Err(_) => {
                assert_eq!(restarted, Some(previous));
                assert_eq!(restarted_bytes, previous_bytes);
            }
        }
    }

    #[test]
    fn native_workspace_tests_prior_bytes_cannot_alias_absent_rollback_state() {
        let (_dir, path) = temp_workspace_path();
        let previous_bytes = b"psyche-workspace-prior-absent-v1\n";
        fs::write(&path, previous_bytes).expect("write prior bytes");

        workspace_save_to_test_hook_with_ops(
            &path,
            &workspace_with_project("attempted"),
            |_| Ok(()),
            sync_parent_directory,
            restore_workspace_backup,
            create_rollback_backup,
            |source, destination| {
                if destination == path
                    && source
                        .file_name()
                        .expect("source file name")
                        .to_string_lossy()
                        .contains(".psyche-save-")
                {
                    fs::rename(source, destination).map_err(|error| error.to_string())?;
                    return Err("injected post-publication failure".to_string());
                }
                Ok(())
            },
        )
        .expect_err("failed replacement must restore exact prior bytes");

        assert_eq!(
            fs::read(&path).expect("read restored prior bytes"),
            previous_bytes
        );
        let restart_error =
            load_workspace_from(&path).expect_err("restart must retain invalid prior bytes");
        assert!(restart_error.contains("parse workspace"), "{restart_error}");
        assert_eq!(
            fs::read(&path).expect("read prior bytes after restart"),
            previous_bytes
        );
    }

    #[test]
    fn native_workspace_tests_absent_rollback_candidates_remain_discoverable() {
        let (_dir, path) = temp_workspace_path();
        let candidate = workspace_rollback_candidate_path(&absent_pending_path(&path))
            .expect("create absent rollback candidate path");

        assert!(candidate
            .file_name()
            .expect("candidate file name")
            .to_string_lossy()
            .starts_with(&workspace_rollback_candidate_prefix("workspace-v3.json")));
    }

    #[test]
    fn native_workspace_tests_partial_candidate_is_removed_without_restore() {
        let (_dir, path) = temp_workspace_path();
        let current = workspace_with_project("current");
        fs::write(
            &path,
            serde_json::to_vec(&current).expect("serialize current"),
        )
        .expect("write current workspace");
        let candidate = rollback_candidate_path(&path, "partial");
        fs::write(&candidate, b"{partial").expect("write partial candidate");
        let later = workspace_with_project("later");

        save_workspace_to(&path, &later).expect("partial candidate must not block save");

        assert_eq!(
            load_workspace_from(&path)
                .expect("load later workspace")
                .expect("workspace exists"),
            later
        );
        assert!(!candidate.exists());
    }

    #[test]
    fn native_workspace_tests_candidate_cleanup_sync_failure_blocks_save() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_with_project("original");
        save_clean_workspace(&path, &original);
        let candidate = rollback_candidate_path(&path, "stale");
        fs::write(&candidate, b"{partial").expect("write stale candidate");
        let mut sync_calls = 0;

        let error = workspace_save_to_test_hook(
            &path,
            &workspace_with_project("updated"),
            |_| Ok(()),
            |_| {
                sync_calls += 1;
                if sync_calls == 1 {
                    Err("injected candidate cleanup sync failure".to_string())
                } else {
                    Ok(())
                }
            },
            restore_workspace_backup,
        )
        .expect_err("candidate cleanup sync failure must block save");

        assert!(error.contains("injected candidate cleanup sync failure"));
        assert_eq!(
            load_workspace_from(&path)
                .expect("load prior workspace")
                .expect("workspace exists"),
            original
        );
    }

    #[test]
    fn native_workspace_tests_invalid_save_preserves_previous_file() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_value();
        fs::write(&path, serde_json::to_vec(&original).expect("serialize"))
            .expect("write original workspace");

        let invalid = serde_json::json!({
            "version": 3,
            "projects": [],
            "sessions": {},
            "paneLayouts": [],
        });

        let err = save_workspace_to(&path, &invalid).expect_err("save should fail");
        assert!(err.contains("workspace field 'sessions' must be an array"));

        let restored = load_workspace_from(&path)
            .expect("load")
            .expect("workspace still exists");
        assert_eq!(restored, original);
    }

    #[test]
    fn native_workspace_tests_cleans_temp_files_on_controlled_failure() {
        let (_dir, path) = temp_workspace_path();
        let value = workspace_value();

        let err = workspace_save_to_test_hook(
            &path,
            &value,
            |temp| {
                assert!(temp
                    .file_name()
                    .expect("temp file name")
                    .to_string_lossy()
                    .contains(".psyche-save-"));
                Err("controlled failure".to_string())
            },
            sync_parent_directory,
            restore_workspace_backup,
        )
        .expect_err("hook should fail");

        assert_eq!(err, "controlled failure");
        assert!(cleanup_artifacts(path.parent().expect("parent")).is_empty());
        assert!(!pending_path(&path).exists());
    }

    #[test]
    fn native_workspace_tests_pending_publish_sync_failure_does_not_mutate_workspace() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_value();
        let original_bytes = serde_json::to_vec(&original).expect("serialize");
        fs::write(&path, &original_bytes).expect("write original workspace");
        let updated = serde_json::json!({
            "version": 3,
            "projects": [{"id": "updated"}],
            "sessions": [],
            "paneLayouts": [],
        });

        let mut sync_calls = 0;
        let err = workspace_save_to_test_hook(
            &path,
            &updated,
            |_| Ok(()),
            |_| {
                sync_calls += 1;
                if sync_calls == 1 {
                    Err("parent sync failed".to_string())
                } else {
                    Ok(())
                }
            },
            restore_workspace_backup,
        )
        .expect_err("sync failure should fail");

        let pending = pending_path(&path);
        assert!(err.contains("publish pending workspace rollback"));
        assert!(err.contains("parent sync failed"));
        assert_eq!(fs::read(&path).expect("read workspace"), original_bytes);
        assert_eq!(
            fs::read(&pending).expect("read pending rollback"),
            original_bytes
        );

        let parent = path.parent().expect("parent");
        assert!(cleanup_artifacts(parent).is_empty());
        assert!(pending.exists());
    }

    #[test]
    fn native_workspace_tests_restores_previous_file_on_new_workspace_sync_failure() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_value();
        fs::write(&path, serde_json::to_vec(&original).expect("serialize"))
            .expect("write original workspace");
        let updated = workspace_with_project("updated");
        let mut sync_calls = 0;

        let err = workspace_save_to_test_hook(
            &path,
            &updated,
            |_| Ok(()),
            |_| {
                sync_calls += 1;
                if sync_calls == 2 {
                    Err("parent sync failed".to_string())
                } else {
                    Ok(())
                }
            },
            restore_workspace_backup,
        )
        .expect_err("new workspace sync failure should roll back");

        assert_eq!(err, "parent sync failed");
        assert_eq!(
            load_workspace_from(&path)
                .expect("load restored workspace")
                .expect("workspace exists"),
            original
        );
        assert!(!pending_path(&path).exists());
        assert!(!committed_path(&path).exists());
    }

    #[test]
    fn native_workspace_tests_successful_save_keeps_durable_commit_marker_until_restart() {
        let (_dir, path) = temp_workspace_path();
        save_clean_workspace(&path, &workspace_value());
        let updated = workspace_with_project("committed");

        let mut sync_calls = 0;
        workspace_save_to_test_hook(
            &path,
            &updated,
            |_| Ok(()),
            |_| {
                sync_calls += 1;
                (sync_calls <= 3)
                    .then_some(())
                    .ok_or_else(|| "unexpected post-commit sync".to_string())
            },
            restore_workspace_backup,
        )
        .expect("save must finish after durably committing its marker");

        assert_eq!(
            load_workspace_from_locked(&path)
                .expect("load committed workspace without recovery")
                .expect("workspace exists"),
            updated
        );
        assert_eq!(sync_calls, 3);
        assert!(committed_path(&path).exists());
        assert!(!pending_path(&path).exists());

        assert_eq!(
            load_workspace_from(&path)
                .expect("restart load committed workspace")
                .expect("workspace exists"),
            updated
        );
        let parent = path.parent().expect("parent");
        assert!(cleanup_artifacts(parent).is_empty());
        assert!(rollback_artifacts(parent).is_empty());
        assert!(!pending_path(&path).exists());
    }

    #[test]
    fn native_workspace_tests_does_not_delete_unclassified_rollback_copy() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_value();
        save_workspace_to(&path, &original).expect("save original");
        let stale = path
            .parent()
            .expect("parent")
            .join(".workspace-v3.json.psyche-rollback-stale");
        fs::write(
            &stale,
            serde_json::to_vec(&workspace_with_project("stale")).expect("serialize stale"),
        )
        .expect("write stale rollback");
        let updated = workspace_with_project("updated");

        save_workspace_to(&path, &updated).expect("save with stale rollback");

        assert_eq!(
            load_workspace_from(&path)
                .expect("load updated workspace")
                .expect("workspace exists"),
            updated
        );
        assert!(stale.exists());
        assert!(rollback_artifacts(path.parent().expect("parent")).is_empty());
        assert!(!pending_path(&path).exists());
    }

    #[test]
    fn native_workspace_tests_partial_fallback_copy_never_becomes_pending() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_with_project("original");
        let original_bytes = serde_json::to_vec(&original).expect("serialize original");
        fs::write(&path, &original_bytes).expect("write original workspace");
        let attempted = workspace_with_project("attempted");

        let err = workspace_save_to_test_hook_with_backup(
            &path,
            &attempted,
            |_| Ok(()),
            sync_parent_directory,
            restore_workspace_backup,
            |source, rollback| {
                create_rollback_backup_with(
                    source,
                    rollback,
                    |_, _| Err(std::io::Error::other("injected hard-link failure")),
                    |source_file, candidate_file| {
                        let mut partial = [0_u8; 8];
                        let read = source_file.read(&mut partial)?;
                        candidate_file.write_all(&partial[..read])?;
                        Err(std::io::Error::other("injected partial copy failure"))
                    },
                )
            },
        )
        .expect_err("partial fallback copy must fail before replacement");

        assert!(err.contains("injected partial copy failure"));
        assert_eq!(
            fs::read(&path).expect("read original workspace"),
            original_bytes
        );
        let parent = path.parent().expect("parent");
        assert!(cleanup_artifacts(parent).is_empty());
        assert!(rollback_artifacts(parent).is_empty());
        assert!(!pending_path(&path).exists());

        let later = workspace_with_project("later");
        save_workspace_to(&path, &later).expect("later save must ignore partial candidate");
        assert_eq!(
            load_workspace_from(&path)
                .expect("load later workspace")
                .expect("workspace exists"),
            later
        );
        assert!(rollback_artifacts(parent).is_empty());
        assert!(!pending_path(&path).exists());
    }

    #[test]
    fn native_workspace_tests_preserves_pending_when_rollback_restore_fails() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_value();
        let original_bytes = serde_json::to_vec(&original).expect("serialize original");
        fs::write(&path, &original_bytes).expect("write original workspace");
        let updated = workspace_with_project("updated");
        let pending = pending_path(&path);
        let mut sync_calls = 0;

        let err = workspace_save_to_test_hook(
            &path,
            &updated,
            |_| Ok(()),
            |_| {
                sync_calls += 1;
                if sync_calls == 2 {
                    Err("parent sync failed".to_string())
                } else {
                    Ok(())
                }
            },
            |backup, destination| {
                assert_eq!(backup, pending);
                assert_eq!(destination, path);
                Err("injected restore failure".to_string())
            },
        )
        .expect_err("restore failure should fail");

        assert!(err.contains("parent sync failed"));
        assert!(err.contains("injected restore failure"));
        assert!(err.contains(&pending.display().to_string()));
        assert_eq!(
            fs::read(&pending).expect("retained pending rollback"),
            original_bytes
        );
        assert_eq!(
            load_workspace_from_locked(&path)
                .expect("load replacement")
                .expect("replacement exists"),
            updated
        );
        assert!(cleanup_artifacts(path.parent().expect("parent")).is_empty());
    }

    #[test]
    fn native_workspace_tests_recovers_pending_before_later_save() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_value();
        let original_bytes = serde_json::to_vec(&original).expect("serialize original");
        fs::write(&path, &original_bytes).expect("write original workspace");
        let first_update = workspace_with_project("first");
        let later_update = workspace_with_project("later");
        let pending = pending_path(&path);
        let mut sync_calls = 0;

        workspace_save_to_test_hook(
            &path,
            &first_update,
            |_| Ok(()),
            |_| {
                sync_calls += 1;
                if sync_calls == 2 {
                    Err("parent sync failed".to_string())
                } else {
                    Ok(())
                }
            },
            |backup, destination| {
                assert_eq!(backup, pending);
                assert_eq!(destination, path);
                Err("injected restore failure".to_string())
            },
        )
        .expect_err("restore failure should fail");

        assert_eq!(
            load_workspace_from(&path)
                .expect("load must recover the failed save")
                .expect("workspace exists"),
            original
        );
        assert!(!pending.exists());
        assert_eq!(
            fs::read(&path).expect("read recovered workspace"),
            original_bytes
        );

        workspace_save_to_test_hook(
            &path,
            &later_update,
            |temp| {
                assert!(temp
                    .file_name()
                    .expect("temp file name")
                    .to_string_lossy()
                    .contains(".psyche-save-"));
                assert_eq!(
                    fs::read(&path).expect("workspace restored before save"),
                    original_bytes
                );
                Ok(())
            },
            sync_parent_directory,
            restore_workspace_backup,
        )
        .expect("later save should recover and succeed");

        assert_eq!(
            load_workspace_from(&path)
                .expect("load recovered save")
                .expect("workspace exists"),
            later_update
        );
        assert!(cleanup_artifacts(path.parent().expect("parent")).is_empty());
        assert!(!pending.exists());
    }

    #[test]
    fn native_workspace_tests_repeated_restore_failure_keeps_pending() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_value();
        let original_bytes = serde_json::to_vec(&original).expect("serialize original");
        fs::write(&path, &original_bytes).expect("write original workspace");
        let first_update = workspace_with_project("first");
        let second_update = workspace_with_project("second");
        let pending = pending_path(&path);
        let mut sync_calls = 0;

        workspace_save_to_test_hook(
            &path,
            &first_update,
            |_| Ok(()),
            |_| {
                sync_calls += 1;
                if sync_calls == 2 {
                    Err("parent sync failed".to_string())
                } else {
                    Ok(())
                }
            },
            |backup, destination| {
                assert_eq!(backup, pending);
                assert_eq!(destination, path);
                Err("injected restore failure".to_string())
            },
        )
        .expect_err("restore failure should fail");

        let first_restore_error = workspace_save_to_test_hook(
            &path,
            &second_update,
            |_| Ok(()),
            |_| Ok(()),
            |backup, destination| {
                assert_eq!(backup, pending);
                assert_eq!(destination, path);
                Err("injected restore failure".to_string())
            },
        )
        .expect_err("second restore failure should fail");
        assert!(first_restore_error.contains("restore pending workspace rollback"));
        assert!(first_restore_error.contains("injected restore failure"));

        let second_restore_error = workspace_save_to_test_hook(
            &path,
            &second_update,
            |_| Ok(()),
            |_| Ok(()),
            |backup, destination| {
                assert_eq!(backup, pending);
                assert_eq!(destination, path);
                Err("injected restore failure".to_string())
            },
        )
        .expect_err("repeated restore failure should still fail");
        assert!(second_restore_error.contains("restore pending workspace rollback"));
        assert!(second_restore_error.contains("injected restore failure"));

        assert_eq!(
            fs::read(&pending).expect("retained pending rollback"),
            original_bytes
        );
        assert_eq!(
            load_workspace_from(&path)
                .expect("load must recover pending rollback")
                .expect("workspace exists"),
            original
        );
        assert!(!pending.exists());
        assert!(cleanup_artifacts(path.parent().expect("parent")).is_empty());
    }

    #[test]
    fn native_workspace_tests_serializes_rollback_before_later_save() {
        let (_dir, path) = temp_workspace_path();
        save_clean_workspace(&path, &workspace_value());
        let first_value = workspace_with_project("first");
        let later_value = workspace_with_project("later");
        let first_path = path.clone();
        let (at_sync_tx, at_sync_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        let first = thread::spawn(move || {
            let mut sync_calls = 0;
            workspace_save_to_test_hook(
                &first_path,
                &first_value,
                |_| Ok(()),
                move |_| {
                    sync_calls += 1;
                    if sync_calls == 2 {
                        at_sync_tx.send(()).expect("signal first sync");
                        release_rx.recv().expect("release rollback");
                        Err("parent sync failed".to_string())
                    } else {
                        Ok(())
                    }
                },
                restore_workspace_backup,
            )
        });
        at_sync_rx.recv().expect("first save reached sync");

        let later_path = path.clone();
        let later_expected = later_value.clone();
        let (later_started_tx, later_started_rx) = mpsc::channel();
        let (later_done_tx, later_done_rx) = mpsc::channel();
        let later = thread::spawn(move || {
            later_started_tx.send(()).expect("signal later save");
            let result = save_workspace_to(&later_path, &later_value);
            later_done_tx.send(()).expect("signal later completion");
            result
        });
        later_started_rx.recv().expect("later save started");
        assert!(later_done_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        release_tx.send(()).expect("release first save");
        assert_eq!(
            first.join().expect("join first save"),
            Err("parent sync failed".to_string())
        );
        later.join().expect("join later save").expect("later save");

        assert_eq!(
            load_workspace_from(&path)
                .expect("load final workspace")
                .expect("final workspace exists"),
            later_expected
        );
        assert!(cleanup_artifacts(path.parent().expect("parent")).is_empty());
        assert!(!pending_path(&path).exists());
    }

    #[test]
    fn native_workspace_tests_concurrent_reader_recovers_failed_save_without_partial_json() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_value();
        save_clean_workspace(&path, &original);
        let writer_path = path.clone();
        let (at_sync_tx, at_sync_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        let writer = thread::spawn(move || {
            let mut sync_calls = 0;
            workspace_save_to_test_hook(
                &writer_path,
                &workspace_with_project("transient"),
                |_| Ok(()),
                move |_| {
                    sync_calls += 1;
                    if sync_calls == 2 {
                        at_sync_tx.send(()).expect("signal first sync");
                        release_rx.recv().expect("release rollback");
                        Err("parent sync failed".to_string())
                    } else {
                        Ok(())
                    }
                },
                |_, _| Err("injected restore failure".to_string()),
            )
        });
        at_sync_rx.recv().expect("writer reached sync");

        let reader_path = path.clone();
        let (reader_started_tx, reader_started_rx) = mpsc::channel();
        let (reader_done_tx, reader_done_rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            reader_started_tx.send(()).expect("signal reader");
            let result = load_workspace_from(&reader_path);
            reader_done_tx.send(()).expect("signal reader completion");
            result
        });
        reader_started_rx.recv().expect("reader started");
        assert!(reader_done_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        release_tx.send(()).expect("release writer");
        let writer_error = writer
            .join()
            .expect("join writer")
            .expect_err("writer must leave pending recovery");
        assert!(writer_error.contains("parent sync failed"));
        assert!(writer_error.contains("injected restore failure"));
        assert_eq!(
            reader
                .join()
                .expect("join reader")
                .expect("read workspace")
                .expect("workspace exists"),
            original
        );
        assert!(!pending_path(&path).exists());
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_artifact_inspection_waits_for_candidate_cleanup_lock() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_with_project("original");
        save_workspace_to(&path, &original).expect("save original");

        for writer in [false, true] {
            let candidate =
                rollback_candidate_path(&path, if writer { "writer" } else { "reader" });
            create_fifo(&candidate);
            let workspace_dir = SecureWorkspaceDir::open_for_load(&path)
                .expect("open workspace directory")
                .expect("workspace directory exists");
            let cleanup_lock =
                WorkspaceFileLock::exclusive(&workspace_dir, &path).expect("lock cleanup");
            let operation_path = path.clone();
            let expected = original.clone();
            let (started_tx, started_rx) = mpsc::channel();
            let (done_tx, done_rx) = mpsc::channel();

            let operation = thread::spawn(move || {
                started_tx.send(()).expect("signal operation start");
                let result = if writer {
                    save_workspace_to(&operation_path, &expected)
                } else {
                    load_workspace_from(&operation_path).map(|_| ())
                };
                done_tx.send(()).expect("signal operation completion");
                result
            });

            started_rx.recv().expect("operation started");
            assert!(
                done_rx.recv_timeout(Duration::from_millis(100)).is_err(),
                "artifact inspection must wait for the cleanup lock"
            );

            unlink_workspace_path(&workspace_dir, &candidate, "workspace rollback candidate")
                .expect("clean candidate");
            workspace_dir.sync().expect("sync candidate cleanup");
            drop(cleanup_lock);

            operation
                .join()
                .expect("join operation")
                .expect("operation after cleanup");
        }
    }

    #[test]
    fn native_workspace_tests_creates_secure_permissions_on_unix() {
        let (_dir, path) = temp_parent_workspace_path();
        let value = workspace_value();

        save_workspace_to(&path, &value).expect("save workspace");

        #[cfg(unix)]
        {
            let parent = path.parent().expect("parent");
            let psyche = parent.parent().expect(".psyche");
            let psyche_mode = fs::metadata(psyche).expect("metadata").permissions().mode() & 0o777;
            let parent_mode = fs::metadata(parent).expect("metadata").permissions().mode() & 0o777;
            let file_mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
            let lock_mode = fs::metadata(workspace_lock_path(parent, "workspace-v3.json"))
                .expect("lock metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(psyche_mode, 0o700);
            assert_eq!(parent_mode, 0o700);
            assert_eq!(file_mode, 0o600);
            assert_eq!(lock_mode, 0o600);
        }
    }

    #[test]
    fn native_workspace_tests_syncs_each_new_workspace_parent_level() {
        let dir = TempDir::new().expect("tempdir");
        let psyche = dir.path().join(".psyche");
        let app = psyche.join("macos-app");
        let path = app.join("workspace-v3.json");
        let mut synced = Vec::new();

        workspace_save_to_test_hook_with_parent_sync(&path, &workspace_value(), |directory| {
            synced.push(directory.to_path_buf());
            sync_parent_directory_standalone(directory)
        })
        .expect("save workspace");

        assert_eq!(
            synced,
            vec![
                dir.path().to_path_buf(),
                psyche.clone(),
                psyche,
                app.clone(),
            ]
        );
        assert!(path.exists());
    }

    #[test]
    fn native_workspace_tests_parent_sync_failure_blocks_first_save() {
        let dir = TempDir::new().expect("tempdir");
        let psyche = dir.path().join(".psyche");
        let path = psyche.join("macos-app").join("workspace-v3.json");
        let mut sync_calls = 0;

        let error = workspace_save_to_test_hook_with_parent_sync(&path, &workspace_value(), |_| {
            sync_calls += 1;
            Err("injected ancestor sync failure".to_string())
        })
        .expect_err("ancestor sync failure must fail first save");

        assert_eq!(sync_calls, 1);
        assert!(error.contains("injected ancestor sync failure"));
        assert!(psyche.exists());
        assert!(!psyche.join("macos-app").exists());
        assert!(!path.exists());
    }

    #[test]
    fn native_workspace_tests_retry_syncs_parent_of_existing_directory_entry() {
        let dir = TempDir::new().expect("tempdir");
        let psyche = dir.path().join(".psyche");
        let app = psyche.join("macos-app");
        let path = app.join("workspace-v3.json");

        let error =
            workspace_save_to_test_hook_with_parent_sync(&path, &workspace_value(), |directory| {
                if directory == psyche && app.exists() {
                    return Err("injected app parent sync failure".to_string());
                }
                sync_parent_directory_standalone(directory)
            })
            .expect_err("first app parent sync must fail");

        assert!(error.contains("injected app parent sync failure"));
        assert!(psyche.exists());
        assert!(app.exists());
        assert!(!path.exists());

        let mut retried_syncs = Vec::new();
        workspace_save_to_test_hook_with_parent_sync(&path, &workspace_value(), |directory| {
            retried_syncs.push(directory.to_path_buf());
            sync_parent_directory_standalone(directory)
        })
        .expect("retry must sync existing directory entries");

        assert_eq!(retried_syncs, vec![dir.path().to_path_buf(), psyche]);
        assert!(path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_save_stays_on_pinned_inode_after_psyche_symlink_replacement() {
        let (_dir, path) = temp_parent_workspace_path();
        let original = workspace_with_project("original");
        save_workspace_to(&path, &original).expect("save original");

        let app = path.parent().expect("macos-app").to_path_buf();
        let psyche = app.parent().expect(".psyche").to_path_buf();
        let home = psyche.parent().expect("home");
        let pinned_psyche = home.join(".psyche-pinned");
        let pinned_path = pinned_psyche.join("macos-app").join("workspace-v3.json");
        let outside = home.join("outside-psyche");
        let outside_app = outside.join("macos-app");
        fs::create_dir_all(&outside_app).expect("create outside app");
        let outside_path = outside_app.join("workspace-v3.json");
        let outside_bytes =
            serde_json::to_vec(&workspace_with_project("outside")).expect("serialize outside");
        fs::write(&outside_path, &outside_bytes).expect("write outside workspace");

        let updated = workspace_with_project("updated");
        workspace_save_to_test_hook(
            &path,
            &updated,
            |_| {
                fs::rename(&psyche, &pinned_psyche).map_err(|error| error.to_string())?;
                symlink(&outside, &psyche).map_err(|error| error.to_string())
            },
            sync_parent_directory,
            restore_workspace_backup,
        )
        .expect("save through pinned directory");

        assert_eq!(
            load_workspace_from(&pinned_path)
                .expect("load pinned workspace")
                .expect("pinned workspace exists"),
            updated
        );
        assert_eq!(
            fs::read(&outside_path).expect("read outside workspace"),
            outside_bytes
        );
        assert_eq!(temp_files(&outside_app), vec!["workspace-v3.json"]);
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_load_stays_on_pinned_inode_after_app_symlink_replacement() {
        let (_dir, path) = temp_parent_workspace_path();
        let previous = workspace_with_project("previous");
        save_workspace_to(&path, &workspace_with_project("uncommitted"))
            .expect("save uncommitted workspace");
        let pending = pending_path(&path);
        fs::write(
            &pending,
            serde_json::to_vec(&previous).expect("serialize previous"),
        )
        .expect("write pending rollback");

        let app = path.parent().expect("macos-app").to_path_buf();
        let psyche = app.parent().expect(".psyche");
        let pinned_app = psyche.join("macos-app-pinned");
        let pinned_path = pinned_app.join("workspace-v3.json");
        let outside_app = psyche.parent().expect("home").join("outside-macos-app");
        fs::create_dir(&outside_app).expect("create outside app");
        let outside_path = outside_app.join("workspace-v3.json");
        let outside_bytes =
            serde_json::to_vec(&workspace_with_project("outside")).expect("serialize outside");
        fs::write(&outside_path, &outside_bytes).expect("write outside workspace");

        let loaded = load_workspace_from_test_hook(&path, || {
            fs::rename(&app, &pinned_app).map_err(|error| error.to_string())?;
            symlink(&outside_app, &app).map_err(|error| error.to_string())
        })
        .expect("load through pinned directory")
        .expect("pinned workspace exists");

        assert_eq!(loaded, previous);
        assert_eq!(
            load_workspace_from(&pinned_path)
                .expect("load recovered pinned workspace")
                .expect("recovered pinned workspace exists"),
            previous
        );
        assert_eq!(
            fs::read(&outside_path).expect("read outside workspace"),
            outside_bytes
        );
        assert_eq!(temp_files(&outside_app), vec!["workspace-v3.json"]);
        assert!(!outside_app
            .join(pending.file_name().expect("pending name"))
            .exists());
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_rollback_stays_on_pinned_inode_after_app_directory_replacement() {
        let (_dir, path) = temp_parent_workspace_path();
        let original = workspace_with_project("original");
        save_clean_workspace(&path, &original);

        let app = path.parent().expect("macos-app").to_path_buf();
        let psyche = app.parent().expect(".psyche");
        let pinned_app = psyche.join("macos-app-pinned");
        let pinned_path = pinned_app.join("workspace-v3.json");
        let replacement_bytes =
            serde_json::to_vec(&workspace_with_project("replacement")).expect("serialize");
        let mut sync_calls = 0;

        let error = workspace_save_to_test_hook(
            &path,
            &workspace_with_project("updated"),
            |_| Ok(()),
            |_| {
                sync_calls += 1;
                if sync_calls == 2 {
                    fs::rename(&app, &pinned_app).map_err(|error| error.to_string())?;
                    fs::create_dir(&app).map_err(|error| error.to_string())?;
                    fs::write(app.join("workspace-v3.json"), &replacement_bytes)
                        .map_err(|error| error.to_string())?;
                    Err("injected parent sync failure".to_string())
                } else {
                    Ok(())
                }
            },
            restore_workspace_backup,
        )
        .expect_err("failed save must roll back through pinned directory");

        assert_eq!(error, "injected parent sync failure");
        assert_eq!(
            load_workspace_from(&pinned_path)
                .expect("load rolled back pinned workspace")
                .expect("rolled back pinned workspace exists"),
            original
        );
        assert_eq!(
            fs::read(app.join("workspace-v3.json")).expect("read replacement workspace"),
            replacement_bytes
        );
        assert_eq!(temp_files(&app), vec!["workspace-v3.json"]);
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_rollback_stays_on_pinned_inode_after_psyche_symlink_replacement() {
        let (_dir, path) = temp_parent_workspace_path();
        let original = workspace_with_project("original");
        save_clean_workspace(&path, &original);

        let app = path.parent().expect("macos-app");
        let psyche = app.parent().expect(".psyche").to_path_buf();
        let home = psyche.parent().expect("home");
        let pinned_psyche = home.join(".psyche-pinned");
        let pinned_path = pinned_psyche.join("macos-app").join("workspace-v3.json");
        let outside = home.join("outside-rollback");
        let outside_app = outside.join("macos-app");
        fs::create_dir_all(&outside_app).expect("create outside app");
        let outside_path = outside_app.join("workspace-v3.json");
        let outside_bytes =
            serde_json::to_vec(&workspace_with_project("outside")).expect("serialize outside");
        fs::write(&outside_path, &outside_bytes).expect("write outside workspace");
        let mut sync_calls = 0;

        let error = workspace_save_to_test_hook(
            &path,
            &workspace_with_project("updated"),
            |_| Ok(()),
            |_| {
                sync_calls += 1;
                if sync_calls == 2 {
                    fs::rename(&psyche, &pinned_psyche).map_err(|error| error.to_string())?;
                    symlink(&outside, &psyche).map_err(|error| error.to_string())?;
                    Err("injected parent sync failure".to_string())
                } else {
                    Ok(())
                }
            },
            restore_workspace_backup,
        )
        .expect_err("failed save must roll back through pinned directory");

        assert_eq!(error, "injected parent sync failure");
        assert_eq!(
            load_workspace_from(&pinned_path)
                .expect("load rolled back pinned workspace")
                .expect("rolled back pinned workspace exists"),
            original
        );
        assert_eq!(
            fs::read(&outside_path).expect("read outside workspace"),
            outside_bytes
        );
        assert_eq!(temp_files(&outside_app), vec!["workspace-v3.json"]);
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_rejects_final_symlink_replacement_after_parent_is_pinned() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_with_project("original");
        save_workspace_to(&path, &original).expect("save original");
        let outside = path.parent().expect("parent").join("outside-workspace");
        let outside_bytes =
            serde_json::to_vec(&workspace_with_project("outside")).expect("serialize outside");
        fs::write(&outside, &outside_bytes).expect("write outside workspace");

        let error = workspace_save_to_test_hook(
            &path,
            &workspace_with_project("updated"),
            |_| {
                fs::remove_file(&path).map_err(|error| error.to_string())?;
                symlink(&outside, &path).map_err(|error| error.to_string())
            },
            sync_parent_directory,
            restore_workspace_backup,
        )
        .expect_err("final workspace symlink must be rejected");

        assert!(error.contains("symlink"), "{error}");
        assert_eq!(
            fs::read(&outside).expect("read outside workspace"),
            outside_bytes
        );
        assert!(fs::symlink_metadata(&path)
            .expect("workspace metadata")
            .file_type()
            .is_symlink());
        assert!(cleanup_artifacts(path.parent().expect("parent")).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn native_workspace_tests_rejects_final_directory_replacement_after_parent_is_pinned() {
        let (_dir, path) = temp_workspace_path();
        save_workspace_to(&path, &workspace_with_project("original")).expect("save original");

        let error = workspace_save_to_test_hook(
            &path,
            &workspace_with_project("updated"),
            |_| {
                fs::remove_file(&path).map_err(|error| error.to_string())?;
                fs::create_dir(&path).map_err(|error| error.to_string())
            },
            sync_parent_directory,
            restore_workspace_backup,
        )
        .expect_err("final workspace directory must be rejected");

        assert!(error.contains("regular file"), "{error}");
        assert!(path.is_dir());
        assert!(cleanup_artifacts(path.parent().expect("parent")).is_empty());
        assert!(rollback_artifacts(path.parent().expect("parent")).is_empty());
    }
}
