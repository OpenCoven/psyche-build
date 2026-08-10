use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::Value;

#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};

const WORKSPACE_VERSION: i64 = 3;
const WORKSPACE_FILE_RELATIVE: &str = ".psyche/macos-app/workspace-v3.json";
const WORKSPACE_ROLLBACK_COPY_LIMIT: u64 = 16 * 1024 * 1024;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static WORKSPACE_IO_MUTEX: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

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
    if !validate_workspace_parent_for_load(path)? {
        return Ok(None);
    }
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("workspace path has no file name: {}", path.display()))?
        .to_string_lossy()
        .to_string();
    let pending_path = workspace_rollback_pending_path(parent, &file_name);
    let committed_path = workspace_rollback_committed_path(parent, &file_name);

    validate_workspace_artifact_paths(path, parent, &file_name)?;
    let shared_lock = WorkspaceFileLock::shared(path)?;
    validate_workspace_artifact_paths(path, parent, &file_name)?;
    let requires_recovery = regular_file_exists(&pending_path, "workspace pending rollback")?
        || regular_file_exists(&committed_path, "workspace committed rollback")?
        || rollback_candidates_exist(parent, &file_name)?;
    if !requires_recovery {
        return load_workspace_from_locked(path);
    }

    drop(shared_lock);
    before_exclusive_recovery()?;
    let _exclusive_lock = WorkspaceFileLock::exclusive(path)?;
    validate_workspace_artifact_paths(path, parent, &file_name)?;

    let mut sync_directory = sync_parent_directory;
    if regular_file_exists(&pending_path, "workspace pending rollback")? {
        let cleanup_committed = recover_pending_workspace(
            path,
            parent,
            pending_path.as_path(),
            committed_path.as_path(),
            &mut sync_directory,
            &mut restore_workspace_backup,
            &mut rename_workspace_path,
        )?;
        if cleanup_committed {
            let _ =
                cleanup_committed_rollback(committed_path.as_path(), parent, &mut sync_directory);
        }
    } else {
        let _ = cleanup_committed_rollback(committed_path.as_path(), parent, &mut sync_directory);
    }
    cleanup_rollback_candidates(parent, &file_name, &mut sync_directory)?;
    load_workspace_from_locked(path)
}

fn load_workspace_from_locked(path: &Path) -> Result<Option<Value>, String> {
    let mut bytes = Vec::new();
    match open_existing_regular_file(path, "workspace", false)? {
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
        sync_parent_directory,
        sync_parent_directory,
        restore_workspace_backup,
        create_rollback_backup,
        rename_workspace_path,
    )
}

fn save_workspace_to_inner<F, K, G, H, I, J>(
    path: &Path,
    value: &Value,
    before_rename: F,
    mut sync_created_directory: K,
    mut sync_parent_directory: G,
    mut restore_workspace_backup: H,
    create_rollback_backup: I,
    mut rename_workspace_path: J,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
    K: FnMut(&Path) -> Result<(), String>,
    G: FnMut(&Path) -> Result<(), String>,
    H: FnMut(&Path, &Path) -> Result<(), String>,
    I: FnOnce(&Path, &Path) -> Result<(), String>,
    J: FnMut(&Path, &Path) -> Result<(), String>,
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
    prepare_workspace_parent(path, &mut sync_created_directory)?;

    validate_workspace_artifact_paths(path, parent, &file_name)?;
    let _file_lock = WorkspaceFileLock::exclusive(path)?;
    validate_workspace_artifact_paths(path, parent, &file_name)?;

    let pending_path = workspace_rollback_pending_path(parent, &file_name);
    let committed_path = workspace_rollback_committed_path(parent, &file_name);

    let cleanup_committed = if regular_file_exists(&pending_path, "workspace pending rollback")? {
        recover_pending_workspace(
            path,
            parent,
            pending_path.as_path(),
            committed_path.as_path(),
            &mut sync_parent_directory,
            &mut restore_workspace_backup,
            &mut rename_workspace_path,
        )?
    } else {
        true
    };
    if cleanup_committed {
        cleanup_committed_rollback(committed_path.as_path(), parent, &mut sync_parent_directory)?;
    }
    cleanup_rollback_candidates(parent, &file_name, &mut sync_parent_directory)?;
    validate_workspace_artifact_paths(path, parent, &file_name)?;

    let temp_path = workspace_temp_path(parent, &file_name);
    let mut temp_file = open_temp_file(&temp_path)?;
    let mut temp_guard = TempFileGuard::new(temp_path.clone());

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
    drop(temp_file);

    before_rename(temp_guard.path.as_path())?;

    let had_workspace = workspace_file_exists(path)?;
    if had_workspace {
        create_rollback_backup(path, pending_path.as_path())?;
        if let Err(error) = sync_parent_directory(parent) {
            return Err(format!(
                "publish pending workspace rollback '{}': {}",
                pending_path.display(),
                error
            ));
        }
    }

    if let Err(replace_error) = rename_regular_workspace_path(
        temp_guard.path.as_path(),
        path,
        "workspace temp",
        "workspace",
        &mut rename_workspace_path,
    ) {
        if had_workspace {
            let restore_error = rollback_workspace_after_failed_save(
                path,
                parent,
                pending_path.as_path(),
                committed_path.as_path(),
                &mut sync_parent_directory,
                &mut restore_workspace_backup,
                &mut rename_workspace_path,
            );
            if let Err(restore_error) = restore_error {
                return Err(format!("{replace_error}; {restore_error}"));
            }
        }
        return Err(replace_error);
    }
    temp_guard.commit();

    if let Err(save_error) = sync_parent_directory(parent) {
        if let Err(restore_error) = rollback_workspace_after_failed_save(
            path,
            parent,
            pending_path.as_path(),
            committed_path.as_path(),
            &mut sync_parent_directory,
            &mut restore_workspace_backup,
            &mut rename_workspace_path,
        ) {
            return Err(format!("{save_error}; {restore_error}"));
        }
        return Err(save_error);
    }

    if had_workspace {
        let cleanup_committed = mark_rollback_committed(
            pending_path.as_path(),
            committed_path.as_path(),
            parent,
            &mut sync_parent_directory,
            &mut rename_workspace_path,
        )?;
        if cleanup_committed {
            let _ = cleanup_committed_rollback(
                committed_path.as_path(),
                parent,
                &mut sync_parent_directory,
            );
        }
    }
    Ok(())
}

fn validate_workspace_parent_for_load(path: &Path) -> Result<bool, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("workspace path has no parent directory: {}", path.display()))?;
    validate_app_owned_directory_entries(parent)?;
    directory_exists(parent, "workspace parent")
}

fn prepare_workspace_parent(
    path: &Path,
    sync_created_directory: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("workspace path has no parent directory: {}", path.display()))?;
    validate_app_owned_directory_entries(parent)?;

    let mut missing = Vec::new();
    let mut cursor = parent.to_path_buf();
    loop {
        if directory_exists(&cursor, "workspace parent")? {
            break;
        }
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

    let mut created = Vec::new();
    for directory in missing.into_iter().rev() {
        let containing_parent = directory.parent().ok_or_else(|| {
            format!(
                "workspace directory has no containing parent: {}",
                directory.display()
            )
        })?;
        if !directory_exists(containing_parent, "workspace containing parent")? {
            return Err(format!(
                "workspace containing parent is missing: {}",
                containing_parent.display()
            ));
        }

        match create_workspace_directory(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if !directory_exists(&directory, "workspace parent")? {
                    return Err(format!(
                        "workspace parent disappeared while creating '{}'",
                        directory.display()
                    ));
                }
                sync_created_directory(containing_parent).map_err(|error| {
                    format!(
                        "sync containing directory '{}' for concurrently created '{}': {}",
                        containing_parent.display(),
                        directory.display(),
                        error
                    )
                })?;
                set_secure_directory_permissions(&directory)?;
                sync_created_directory(&directory).map_err(|error| {
                    format!(
                        "sync concurrently created workspace directory '{}': {}",
                        directory.display(),
                        error
                    )
                })?;
                created.push(directory);
                continue;
            }
            Err(error) => {
                return Err(format!(
                    "create workspace directory '{}': {}",
                    directory.display(),
                    error
                ))
            }
        }

        sync_created_directory(containing_parent).map_err(|error| {
            format!(
                "sync containing directory '{}' after creating '{}': {}",
                containing_parent.display(),
                directory.display(),
                error
            )
        })?;
        set_secure_directory_permissions(&directory)?;
        sync_created_directory(&directory).map_err(|error| {
            format!(
                "sync new workspace directory '{}': {}",
                directory.display(),
                error
            )
        })?;
        created.push(directory);
    }

    validate_app_owned_directory_entries(parent)?;
    if !directory_exists(parent, "workspace parent")? {
        return Err(format!("workspace parent is missing: {}", parent.display()));
    }

    for directory in workspace_security_directories(parent) {
        if created.iter().any(|created| created == &directory) {
            continue;
        }
        set_secure_directory_permissions(&directory)?;
    }
    Ok(())
}

fn workspace_security_directories(parent: &Path) -> Vec<PathBuf> {
    if parent.file_name().is_some_and(|name| name == "macos-app") {
        if let Some(psyche) = parent.parent() {
            if psyche.file_name().is_some_and(|name| name == ".psyche") {
                return vec![psyche.to_path_buf(), parent.to_path_buf()];
            }
        }
    }
    vec![parent.to_path_buf()]
}

fn validate_app_owned_directory_entries(parent: &Path) -> Result<(), String> {
    for directory in workspace_security_directories(parent) {
        let _ = directory_exists(&directory, "app-owned workspace directory")?;
    }
    Ok(())
}

#[cfg(unix)]
fn create_workspace_directory(path: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(false).mode(0o700).create(path)
}

#[cfg(not(unix))]
fn create_workspace_directory(path: &Path) -> std::io::Result<()> {
    fs::create_dir(path)
}

fn directory_exists(path: &Path, context: &str) -> Result<bool, String> {
    let Some(metadata) = symlink_metadata_if_exists(path, context)? else {
        return Ok(false);
    };
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Err(format!(
            "{context} '{}' must not be a symlink",
            path.display()
        ));
    }
    if !file_type.is_dir() {
        return Err(format!(
            "{context} '{}' must be a directory",
            path.display()
        ));
    }
    Ok(true)
}

fn regular_file_exists(path: &Path, context: &str) -> Result<bool, String> {
    let Some(metadata) = symlink_metadata_if_exists(path, context)? else {
        return Ok(false);
    };
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Err(format!(
            "{context} '{}' must not be a symlink",
            path.display()
        ));
    }
    if !file_type.is_file() {
        return Err(format!(
            "{context} '{}' must be a regular file",
            path.display()
        ));
    }
    Ok(true)
}

fn require_new_regular_file_path(path: &Path, context: &str) -> Result<(), String> {
    let Some(metadata) = symlink_metadata_if_exists(path, context)? else {
        return Ok(());
    };
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Err(format!(
            "{context} '{}' must not be a symlink",
            path.display()
        ));
    }
    if !file_type.is_file() {
        return Err(format!(
            "{context} '{}' must be a regular file",
            path.display()
        ));
    }
    Err(format!("{context} '{}' already exists", path.display()))
}

fn symlink_metadata_if_exists(path: &Path, context: &str) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("inspect {context} '{}': {}", path.display(), error)),
    }
}

fn validate_workspace_artifact_paths(
    path: &Path,
    parent: &Path,
    file_name: &str,
) -> Result<(), String> {
    regular_file_exists(path, "workspace")?;
    regular_file_exists(&workspace_lock_path(parent, file_name), "workspace lock")?;
    regular_file_exists(
        &workspace_rollback_pending_path(parent, file_name),
        "workspace pending rollback",
    )?;
    regular_file_exists(
        &workspace_rollback_committed_path(parent, file_name),
        "workspace committed rollback",
    )?;
    validate_rollback_candidates(parent, file_name)?;
    Ok(())
}

fn open_existing_regular_file(
    path: &Path,
    context: &str,
    writable: bool,
) -> Result<Option<File>, String> {
    if !regular_file_exists(path, context)? {
        return Ok(None);
    }
    let mut options = OpenOptions::new();
    options.read(true).write(writable);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!("open {context} '{}': {}", path.display(), error));
        }
    };
    verify_opened_regular_file(&file, path, context)?;
    Ok(Some(file))
}

fn open_directory_no_follow(path: &Path, context: &str) -> Result<File, String> {
    if !directory_exists(path, context)? {
        return Err(format!("{context} '{}' is missing", path.display()));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY);
    let file = options
        .open(path)
        .map_err(|error| format!("open {context} '{}': {}", path.display(), error))?;
    verify_opened_directory(&file, path, context)?;
    Ok(file)
}

fn verify_opened_regular_file(file: &File, path: &Path, context: &str) -> Result<(), String> {
    let opened = file
        .metadata()
        .map_err(|error| format!("inspect opened {context} '{}': {}", path.display(), error))?;
    if !opened.file_type().is_file() {
        return Err(format!(
            "opened {context} '{}' must be a regular file",
            path.display()
        ));
    }
    let current = fs::symlink_metadata(path)
        .map_err(|error| format!("reinspect {context} '{}': {}", path.display(), error))?;
    if current.file_type().is_symlink() {
        return Err(format!(
            "{context} '{}' became a symlink while opening",
            path.display()
        ));
    }
    if !current.file_type().is_file() {
        return Err(format!(
            "{context} '{}' must be a regular file",
            path.display()
        ));
    }
    verify_opened_identity(&opened, &current, path, context)
}

fn verify_opened_directory(file: &File, path: &Path, context: &str) -> Result<(), String> {
    let opened = file
        .metadata()
        .map_err(|error| format!("inspect opened {context} '{}': {}", path.display(), error))?;
    if !opened.file_type().is_dir() {
        return Err(format!(
            "opened {context} '{}' must be a directory",
            path.display()
        ));
    }
    let current = fs::symlink_metadata(path)
        .map_err(|error| format!("reinspect {context} '{}': {}", path.display(), error))?;
    if current.file_type().is_symlink() {
        return Err(format!(
            "{context} '{}' became a symlink while opening",
            path.display()
        ));
    }
    if !current.file_type().is_dir() {
        return Err(format!(
            "{context} '{}' must be a directory",
            path.display()
        ));
    }
    verify_opened_identity(&opened, &current, path, context)
}

#[cfg(unix)]
fn verify_opened_identity(
    opened: &fs::Metadata,
    current: &fs::Metadata,
    path: &Path,
    context: &str,
) -> Result<(), String> {
    if opened.dev() != current.dev() || opened.ino() != current.ino() {
        return Err(format!(
            "{context} '{}' changed while opening",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn verify_opened_identity(
    _opened: &fs::Metadata,
    _current: &fs::Metadata,
    _path: &Path,
    _context: &str,
) -> Result<(), String> {
    Ok(())
}

fn set_secure_directory_permissions(path: &Path) -> Result<(), String> {
    let directory = open_directory_no_follow(path, "workspace directory")?;
    #[cfg(unix)]
    {
        if unsafe { libc::fchmod(directory.as_raw_fd(), 0o700) } != 0 {
            return Err(format!(
                "set workspace directory permissions '{}': {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
    }
    directory.sync_all().map_err(|error| {
        format!(
            "sync workspace directory permissions '{}': {}",
            path.display(),
            error
        )
    })
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
    source: &Path,
    destination: &Path,
    source_context: &str,
    destination_context: &str,
    rename: &mut impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if !regular_file_exists(source, source_context)? {
        return Err(format!(
            "{source_context} '{}' is missing",
            source.display()
        ));
    }
    regular_file_exists(destination, destination_context)?;
    rename(source, destination)?;
    if !regular_file_exists(destination, destination_context)? {
        return Err(format!(
            "{destination_context} '{}' is missing after rename",
            destination.display()
        ));
    }
    Ok(())
}

fn open_temp_file(path: &Path) -> Result<File, String> {
    open_new_workspace_file(path, "temp")
}

fn open_new_workspace_file(path: &Path, context: &str) -> Result<File, String> {
    require_new_regular_file_path(path, &format!("workspace {context}"))?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    let file = options
        .open(path)
        .map_err(|e| format!("create workspace {context} '{}': {}", path.display(), e))?;
    verify_opened_regular_file(&file, path, &format!("workspace {context}"))?;
    set_secure_regular_file_permissions(&file, path, &format!("workspace {context}"))?;
    Ok(file)
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
    let prefix = pending_name.strip_suffix("pending").ok_or_else(|| {
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
    parent: &Path,
    file_name: &str,
    sync_parent_directory: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let mut removed = false;
    for candidate in rollback_candidate_paths(parent, file_name)? {
        fs::remove_file(&candidate).map_err(|error| {
            format!(
                "remove workspace rollback candidate '{}': {}",
                candidate.display(),
                error
            )
        })?;
        removed = true;
    }
    if removed {
        let _ = sync_parent_directory(parent);
    }
    Ok(())
}

fn rollback_candidates_exist(parent: &Path, file_name: &str) -> Result<bool, String> {
    Ok(!rollback_candidate_paths(parent, file_name)?.is_empty())
}

fn validate_rollback_candidates(parent: &Path, file_name: &str) -> Result<(), String> {
    rollback_candidate_paths(parent, file_name).map(|_| ())
}

fn rollback_candidate_paths(parent: &Path, file_name: &str) -> Result<Vec<PathBuf>, String> {
    let prefix = workspace_rollback_candidate_prefix(file_name);
    let entries = fs::read_dir(parent).map_err(|error| {
        format!(
            "read workspace parent for rollback candidates '{}': {}",
            parent.display(),
            error
        )
    })?;
    let mut candidates = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "read workspace rollback candidate in '{}': {}",
                parent.display(),
                error
            )
        })?;
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with(prefix.as_str())
        {
            continue;
        }
        let candidate = entry.path();
        if !regular_file_exists(&candidate, "workspace rollback candidate")? {
            return Err(format!(
                "workspace rollback candidate '{}' disappeared",
                candidate.display()
            ));
        }
        candidates.push(candidate);
    }
    Ok(candidates)
}

fn cleanup_committed_rollback(
    committed_path: &Path,
    parent: &Path,
    sync_parent_directory: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), String> {
    if !regular_file_exists(committed_path, "workspace committed rollback")? {
        return Ok(());
    }
    fs::remove_file(committed_path).map_err(|error| {
        format!(
            "remove committed workspace rollback '{}': {}",
            committed_path.display(),
            error
        )
    })?;
    let _ = sync_parent_directory(parent);
    Ok(())
}

fn workspace_file_exists(path: &Path) -> Result<bool, String> {
    regular_file_exists(path, "workspace")
}

fn create_rollback_backup(path: &Path, backup_path: &Path) -> Result<(), String> {
    create_rollback_backup_with(
        path,
        backup_path,
        |source, destination| fs::hard_link(source, destination),
        std::io::copy,
    )
}

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
    if !regular_file_exists(path, "workspace rollback source")? {
        return Err(format!(
            "workspace rollback source '{}' is missing",
            path.display()
        ));
    }
    require_new_regular_file_path(backup_path, "workspace pending rollback")?;
    let candidate_path = workspace_rollback_candidate_path(backup_path)?;
    let candidate_guard =
        create_snapshot_candidate_with(path, &candidate_path, hard_link, copy_file).map_err(
            |error| {
                format!(
                    "create pending rollback '{}' from '{}': {}",
                    backup_path.display(),
                    path.display(),
                    error
                )
            },
        )?;
    fs::hard_link(&candidate_path, backup_path).map_err(|e| {
        format!(
            "publish rollback candidate '{}' as pending '{}': {}",
            candidate_path.display(),
            backup_path.display(),
            e
        )
    })?;
    if !regular_file_exists(backup_path, "workspace pending rollback")? {
        return Err(format!(
            "workspace pending rollback '{}' is missing after publication",
            backup_path.display()
        ));
    }
    drop(candidate_guard);
    Ok(())
}

fn create_snapshot_candidate_with<F, G>(
    path: &Path,
    candidate_path: &Path,
    hard_link: F,
    copy_file: G,
) -> Result<TempFileGuard, String>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
    G: FnOnce(&mut File, &mut File) -> std::io::Result<u64>,
{
    if !regular_file_exists(path, "workspace snapshot source")? {
        return Err(format!(
            "workspace snapshot source '{}' is missing",
            path.display()
        ));
    }
    require_new_regular_file_path(candidate_path, "workspace snapshot candidate")?;
    match hard_link(path, candidate_path) {
        Ok(()) => {
            let guard = TempFileGuard::new(candidate_path.to_path_buf());
            let file =
                open_existing_regular_file(candidate_path, "workspace snapshot candidate", false)?
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
        Err(link_error) => copy_snapshot_candidate(path, candidate_path, copy_file)
            .map_err(|copy_error| format!("{} (hard link failed: {})", copy_error, link_error)),
    }
}

fn copy_snapshot_candidate<G>(
    path: &Path,
    candidate_path: &Path,
    copy_file: G,
) -> Result<TempFileGuard, String>
where
    G: FnOnce(&mut File, &mut File) -> std::io::Result<u64>,
{
    let mut source = open_existing_regular_file(path, "rollback source", false)?
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
    let mut candidate = open_new_workspace_file(candidate_path, "snapshot candidate")?;
    let candidate_guard = TempFileGuard::new(candidate_path.to_path_buf());
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

fn restore_workspace_backup(backup_path: &Path, path: &Path) -> Result<(), String> {
    if !regular_file_exists(backup_path, "workspace rollback backup")? {
        return Err(format!(
            "workspace rollback backup '{}' is missing",
            backup_path.display()
        ));
    }
    regular_file_exists(path, "workspace")?;
    let candidate_path = workspace_restore_candidate_path(path)?;
    let mut candidate_guard = create_snapshot_candidate_with(
        backup_path,
        &candidate_path,
        |source, destination| fs::hard_link(source, destination),
        std::io::copy,
    )?;
    rename_regular_workspace_path(
        &candidate_path,
        path,
        "workspace restore candidate",
        "workspace",
        &mut |source, destination| {
            fs::rename(source, destination).map_err(|e| {
                format!(
                    "restore workspace from pending rollback '{}' to '{}': {}",
                    backup_path.display(),
                    path.display(),
                    e
                )
            })
        },
    )?;
    candidate_guard.commit();
    Ok(())
}

fn rename_workspace_path(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|e| {
        format!(
            "rename workspace path '{}' to '{}': {}",
            source.display(),
            destination.display(),
            e
        )
    })
}

fn recover_pending_workspace(
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    sync_parent_directory: &mut impl FnMut(&Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&Path, &Path) -> Result<(), String>,
    rename_workspace_path: &mut impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<bool, String> {
    restore_workspace_backup(pending_path, path).map_err(|error| {
        format!(
            "restore pending workspace rollback '{}' to '{}': {}; pending rollback retained at '{}'",
            pending_path.display(),
            path.display(),
            error,
            pending_path.display()
        )
    })?;
    sync_parent_directory(parent).map_err(|error| {
        format!(
            "sync restored workspace '{}': {}; pending rollback retained at '{}'",
            path.display(),
            error,
            pending_path.display()
        )
    })?;
    if regular_file_exists(committed_path, "workspace committed rollback")? {
        fs::remove_file(committed_path).map_err(|error| {
            format!(
                "remove committed rollback '{}' before pending recovery: {}; pending rollback retained at '{}'",
                committed_path.display(),
                error,
                pending_path.display()
            )
        })?;
        let _ = sync_parent_directory(parent);
    }
    mark_rollback_committed(
        pending_path,
        committed_path,
        parent,
        sync_parent_directory,
        rename_workspace_path,
    )
}

fn rollback_workspace_after_failed_save(
    path: &Path,
    parent: &Path,
    pending_path: &Path,
    committed_path: &Path,
    sync_parent_directory: &mut impl FnMut(&Path) -> Result<(), String>,
    restore_workspace_backup: &mut impl FnMut(&Path, &Path) -> Result<(), String>,
    rename_workspace_path: &mut impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if regular_file_exists(pending_path, "workspace pending rollback")? {
        let cleanup_committed = recover_pending_workspace(
            path,
            parent,
            pending_path,
            committed_path,
            sync_parent_directory,
            restore_workspace_backup,
            rename_workspace_path,
        )
        .map_err(|error| format!("rollback restoration failed: {error}"))?;
        if cleanup_committed {
            let _ = cleanup_committed_rollback(committed_path, parent, sync_parent_directory);
        }
        Ok(())
    } else if regular_file_exists(path, "workspace")? {
        fs::remove_file(path)
            .map_err(|e| format!("remove failed workspace '{}': {}", path.display(), e))?;
        sync_parent_directory(parent).map_err(|error| {
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
    pending_path: &Path,
    committed_path: &Path,
    parent: &Path,
    sync_parent_directory: &mut impl FnMut(&Path) -> Result<(), String>,
    rename_workspace_path: &mut impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<bool, String> {
    if !regular_file_exists(pending_path, "workspace pending rollback")? {
        return Ok(false);
    }
    if regular_file_exists(committed_path, "workspace committed rollback")? {
        return Err(format!(
            "cannot commit pending rollback '{}': committed rollback '{}' already exists",
            pending_path.display(),
            committed_path.display()
        ));
    }

    if let Err(error) = rename_regular_workspace_path(
        pending_path,
        committed_path,
        "workspace pending rollback",
        "workspace committed rollback",
        rename_workspace_path,
    ) {
        if regular_file_exists(pending_path, "workspace pending rollback")? {
            return Err(format!(
                "mark pending rollback '{}' as committed '{}': {}; pending rollback retained at '{}'",
                pending_path.display(),
                committed_path.display(),
                error,
                pending_path.display()
            ));
        }
        if regular_file_exists(committed_path, "workspace committed rollback")? {
            if sync_parent_directory(parent).is_ok() {
                return Ok(true);
            }
            return preserve_pending_after_uncertain_commit(
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
            );
        }
        return Ok(false);
    }

    let marker_sync_error = match sync_parent_directory(parent) {
        Ok(()) => return Ok(true),
        Err(error) => error,
    };
    if regular_file_exists(pending_path, "workspace pending rollback")? {
        return Err(format!(
            "sync committed rollback marker '{}': {}; pending rollback already exists at '{}'",
            committed_path.display(),
            marker_sync_error,
            pending_path.display()
        ));
    }

    match rename_regular_workspace_path(
        committed_path,
        pending_path,
        "workspace committed rollback",
        "workspace pending rollback",
        rename_workspace_path,
    ) {
        Ok(()) => {
            let revert_sync_result = sync_parent_directory(parent);
            let mut message = format!(
                "sync committed rollback marker '{}': {}; pending rollback restored at '{}'",
                committed_path.display(),
                marker_sync_error,
                pending_path.display()
            );
            if let Err(error) = revert_sync_result {
                message.push_str(&format!(" but parent sync failed: {error}"));
            }
            Err(message)
        }
        Err(revert_error)
            if regular_file_exists(pending_path, "workspace pending rollback")? =>
        {
            Err(format!(
                "sync committed rollback marker '{}': {}; reverting marker failed: {}; pending rollback retained at '{}'",
                committed_path.display(),
                marker_sync_error,
                revert_error,
                pending_path.display()
            ))
        }
        Err(revert_error)
            if regular_file_exists(committed_path, "workspace committed rollback")? =>
        {
            preserve_pending_after_uncertain_commit(
                pending_path,
                committed_path,
                parent,
                format!(
                    "sync committed rollback marker '{}': {}; reverting marker failed: {}",
                    committed_path.display(),
                    marker_sync_error,
                    revert_error
                ),
                sync_parent_directory,
            )
        }
        Err(_) => Ok(false),
    }
}

fn preserve_pending_after_uncertain_commit(
    pending_path: &Path,
    committed_path: &Path,
    parent: &Path,
    failure: String,
    sync_parent_directory: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<bool, String> {
    match create_rollback_backup(committed_path, pending_path) {
        Ok(()) => {
            let sync_error = sync_parent_directory(parent).err();
            let mut message = format!(
                "{failure}; pending rollback restored at '{}'",
                pending_path.display()
            );
            if let Some(error) = sync_error {
                message.push_str(&format!(" but parent sync failed: {error}"));
            }
            Err(message)
        }
        Err(_preserve_error) => {
            let _ = sync_parent_directory(parent);
            Ok(false)
        }
    }
}

fn open_workspace_lock(path: &Path) -> Result<File, String> {
    for _ in 0..8 {
        let exists = regular_file_exists(path, "workspace lock")?;
        let mut options = OpenOptions::new();
        options.read(true).write(true);
        if exists {
            #[cfg(unix)]
            options.custom_flags(libc::O_NOFOLLOW);
        } else {
            options.create_new(true);
            #[cfg(unix)]
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }

        let file = match options.open(path) {
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
                ))
            }
        };
        verify_opened_regular_file(&file, path, "workspace lock")?;
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
    fn shared(path: &Path) -> Result<Self, String> {
        Self::acquire(path, LockMode::Shared)
    }

    fn exclusive(path: &Path) -> Result<Self, String> {
        Self::acquire(path, LockMode::Exclusive)
    }

    fn acquire(path: &Path, mode: LockMode) -> Result<Self, String> {
        let parent = path
            .parent()
            .ok_or_else(|| format!("workspace path has no parent directory: {}", path.display()))?;
        let file_name = path
            .file_name()
            .ok_or_else(|| format!("workspace path has no file name: {}", path.display()))?
            .to_string_lossy();
        let lock_path = workspace_lock_path(parent, &file_name);
        let file = open_workspace_lock(&lock_path)?;
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
        verify_opened_regular_file(&file, &lock_path, "workspace lock")?;
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

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<(), String> {
    open_directory_no_follow(parent, "workspace parent")?
        .sync_all()
        .map_err(|e| format!("sync workspace parent '{}': {}", parent.display(), e))
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<(), String> {
    Ok(())
}

struct TempFileGuard {
    path: PathBuf,
    committed: bool,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
fn workspace_save_to_test_hook<F, G, H>(
    path: &Path,
    value: &Value,
    before_rename: F,
    sync_transaction_directory: G,
    restore_workspace_backup: H,
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
        sync_parent_directory,
        sync_transaction_directory,
        restore_workspace_backup,
        create_rollback_backup,
        rename_workspace_path,
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
    sync_transaction_directory: G,
    restore_workspace_backup: H,
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
        sync_parent_directory,
        sync_transaction_directory,
        restore_workspace_backup,
        create_rollback_backup,
        rename_workspace_path,
    )
}

#[cfg(test)]
fn workspace_save_to_test_hook_with_ops<F, G, H, I, J>(
    path: &Path,
    value: &Value,
    before_rename: F,
    sync_transaction_directory: G,
    restore_workspace_backup: H,
    create_rollback_backup: I,
    rename_workspace_path: J,
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
        sync_parent_directory,
        sync_transaction_directory,
        restore_workspace_backup,
        create_rollback_backup,
        rename_workspace_path,
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
        sync_created_directory,
        sync_parent_directory,
        restore_workspace_backup,
        create_rollback_backup,
        rename_workspace_path,
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
        for marker in ["pending", "committed", "candidate"] {
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

        let error =
            restore_workspace_backup(&backup, &workspace).expect_err("reject backup symlink");

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
            sync_parent_directory(path.parent().expect("parent"))
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
                fs::rename(source, destination).map_err(|e| e.to_string())
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
    fn native_workspace_tests_marker_sync_failure_reverts_to_pending() {
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
        assert!(!committed.exists());
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
    fn native_workspace_tests_failed_marker_reversion_recovers_previous_bytes() {
        let (_dir, path) = temp_workspace_path();
        let previous_bytes =
            serde_json::to_vec(&workspace_with_project("previous")).expect("serialize previous");
        fs::write(&path, &previous_bytes).expect("write previous workspace");
        let pending = pending_path(&path);
        let committed = committed_path(&path);
        let updated = workspace_with_project("updated");
        let mut sync_calls = 0;

        let error = workspace_save_to_test_hook_with_ops(
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
            create_rollback_backup,
            |source, destination| {
                if source == committed && destination == pending {
                    return Err("injected marker revert failure".to_string());
                }
                fs::rename(source, destination).map_err(|e| e.to_string())
            },
        )
        .expect_err("save must fail when marker sync and reversion both fail");

        assert!(error.contains("injected marker sync failure"));
        assert!(error.contains("injected marker revert failure"));
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
                fs::rename(source, destination).map_err(|e| e.to_string())
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
    fn native_workspace_tests_cleanup_sync_failure_after_commit_returns_success() {
        let (_dir, path) = temp_workspace_path();
        save_workspace_to(&path, &workspace_value()).expect("save original");
        let updated = workspace_with_project("committed");

        let mut sync_calls = 0;
        workspace_save_to_test_hook(
            &path,
            &updated,
            |_| Ok(()),
            |_| {
                sync_calls += 1;
                if sync_calls == 4 {
                    Err("cleanup parent sync failed".to_string())
                } else {
                    Ok(())
                }
            },
            restore_workspace_backup,
        )
        .expect("cleanup durability failure must not fail a committed save");

        assert_eq!(
            load_workspace_from(&path)
                .expect("load committed workspace")
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
        save_workspace_to(&path, &workspace_value()).expect("save original");
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
        save_workspace_to(&path, &original).expect("save original");
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
            sync_parent_directory(directory)
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
}
