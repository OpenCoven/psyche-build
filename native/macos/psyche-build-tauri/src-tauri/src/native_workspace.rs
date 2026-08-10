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
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

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
    let _process_lock = WORKSPACE_IO_MUTEX.lock();
    let Some(parent) = path.parent() else {
        return Err(format!(
            "workspace path has no parent directory: {}",
            path.display()
        ));
    };
    if !parent.exists() {
        return Ok(None);
    }
    let _file_lock = WorkspaceFileLock::shared(path)?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("workspace path has no file name: {}", path.display()))?
        .to_string_lossy();
    let pending_path = workspace_rollback_pending_path(parent, &file_name);
    if pending_path.exists() {
        return Err(format!(
            "workspace recovery required: pending rollback '{}' must be restored before loading '{}'",
            pending_path.display(),
            path.display()
        ));
    }
    load_workspace_from_locked(path)
}

fn load_workspace_from_locked(path: &Path) -> Result<Option<Value>, String> {
    let mut bytes = Vec::new();
    match File::open(path) {
        Ok(mut file) => {
            file.read_to_end(&mut bytes)
                .map_err(|e| format!("read workspace '{}': {}", path.display(), e))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("open workspace '{}': {}", path.display(), e)),
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
        restore_workspace_backup,
        create_rollback_backup,
        rename_workspace_path,
    )
}

fn save_workspace_to_inner<F, G, H, I, J>(
    path: &Path,
    value: &Value,
    before_rename: F,
    mut sync_parent_directory: G,
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
    let parent = path
        .parent()
        .ok_or_else(|| format!("workspace path has no parent directory: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("create workspace parent '{}': {}", parent.display(), e))?;
    #[cfg(unix)]
    {
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).map_err(|e| {
            format!(
                "set workspace parent permissions '{}': {}",
                parent.display(),
                e
            )
        })?;
    }

    let _process_lock = WORKSPACE_IO_MUTEX.lock();
    let _file_lock = WorkspaceFileLock::exclusive(path)?;

    let file_name = path
        .file_name()
        .ok_or_else(|| format!("workspace path has no file name: {}", path.display()))?
        .to_string_lossy()
        .to_string();
    let pending_path = workspace_rollback_pending_path(parent, &file_name);
    let committed_path = workspace_rollback_committed_path(parent, &file_name);

    let cleanup_committed = if pending_path.exists() {
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
        cleanup_committed_rollback(committed_path.as_path(), parent, &mut sync_parent_directory);
    }
    cleanup_rollback_candidates(parent, &file_name, &mut sync_parent_directory);

    validate_workspace(value)
        .map_err(|e| format!("validate workspace '{}': {}", path.display(), e))?;

    let temp_path = workspace_temp_path(parent, &file_name);
    let mut temp_file = open_temp_file(&temp_path)?;
    let mut temp_guard = TempFileGuard::new(temp_path.clone());

    let bytes = serde_json::to_vec(value)
        .map_err(|e| format!("serialize workspace '{}': {}", path.display(), e))?;
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

    if let Err(replace_error) = rename_workspace_path(temp_guard.path.as_path(), path) {
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
            cleanup_committed_rollback(
                committed_path.as_path(),
                parent,
                &mut sync_parent_directory,
            );
        }
    }
    Ok(())
}

#[cfg(unix)]
fn open_temp_file(path: &Path) -> Result<File, String> {
    open_new_workspace_file(path, "temp")
}

fn open_new_workspace_file(path: &Path, context: &str) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    options.mode(0o600);
    options
        .open(path)
        .map_err(|e| format!("create workspace {context} '{}': {}", path.display(), e))
}

#[cfg(not(unix))]
fn open_temp_file(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("create workspace temp '{}': {}", path.display(), e))
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
) {
    let prefix = workspace_rollback_candidate_prefix(file_name);
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let mut removed = false;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(&prefix) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if (file_type.is_file() || file_type.is_symlink()) && fs::remove_file(entry.path()).is_ok()
        {
            removed = true;
        }
    }
    if removed {
        let _ = sync_parent_directory(parent);
    }
}

fn cleanup_committed_rollback(
    committed_path: &Path,
    parent: &Path,
    sync_parent_directory: &mut impl FnMut(&Path) -> Result<(), String>,
) {
    if fs::remove_file(committed_path).is_ok() {
        let _ = sync_parent_directory(parent);
    }
}

fn workspace_file_exists(path: &Path) -> Result<bool, String> {
    match fs::metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("stat workspace '{}': {}", path.display(), e)),
    }
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
    let candidate_path = workspace_rollback_candidate_path(backup_path)?;
    let mut candidate_guard =
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
    fs::rename(&candidate_path, backup_path).map_err(|e| {
        format!(
            "publish rollback candidate '{}' as pending '{}': {}",
            candidate_path.display(),
            backup_path.display(),
            e
        )
    })?;
    candidate_guard.commit();
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
    match hard_link(path, candidate_path) {
        Ok(()) => {
            let guard = TempFileGuard::new(candidate_path.to_path_buf());
            File::open(candidate_path)
                .and_then(|file| file.sync_all())
                .map_err(|e| {
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
    let metadata =
        fs::metadata(path).map_err(|e| format!("stat workspace '{}': {}", path.display(), e))?;
    if metadata.len() > WORKSPACE_ROLLBACK_COPY_LIMIT {
        return Err(format!(
            "workspace '{}' is too large for rollback copy: {} bytes (limit {})",
            path.display(),
            metadata.len(),
            WORKSPACE_ROLLBACK_COPY_LIMIT
        ));
    }
    let mut source = File::open(path)
        .map_err(|e| format!("open rollback source '{}': {}", path.display(), e))?;
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
    let candidate_path = workspace_restore_candidate_path(path)?;
    let mut candidate_guard = create_snapshot_candidate_with(
        backup_path,
        &candidate_path,
        |source, destination| fs::hard_link(source, destination),
        std::io::copy,
    )?;
    fs::rename(&candidate_path, path).map_err(|e| {
        format!(
            "restore workspace from pending rollback '{}' to '{}': {}",
            backup_path.display(),
            path.display(),
            e
        )
    })?;
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
    if committed_path.exists() {
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
    if pending_path.exists() {
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
            cleanup_committed_rollback(committed_path, parent, sync_parent_directory);
        }
        Ok(())
    } else if path.exists() {
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
    if let Err(error) = rename_workspace_path(pending_path, committed_path) {
        if pending_path.exists() {
            return Err(format!(
                "mark pending rollback '{}' as committed '{}': {}; pending rollback retained at '{}'",
                pending_path.display(),
                committed_path.display(),
                error,
                pending_path.display()
            ));
        }
        if committed_path.exists() {
            return Ok(sync_parent_directory(parent).is_ok());
        }
        return Err(format!(
            "mark pending rollback '{}' as committed '{}': {}; rollback marker is missing",
            pending_path.display(),
            committed_path.display(),
            error
        ));
    }

    let marker_sync_error = match sync_parent_directory(parent) {
        Ok(()) => return Ok(true),
        Err(error) => error,
    };

    match rename_workspace_path(committed_path, pending_path) {
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
        Err(revert_error) if pending_path.exists() => Err(format!(
            "sync committed rollback marker '{}': {}; reverting marker failed: {}; pending rollback retained at '{}'",
            committed_path.display(),
            marker_sync_error,
            revert_error,
            pending_path.display()
        )),
        Err(_) if committed_path.exists() => {
            Ok(sync_parent_directory(parent).is_ok())
        }
        Err(revert_error) => Err(format!(
            "sync committed rollback marker '{}': {}; reverting marker failed: {}; rollback marker is missing",
            committed_path.display(),
            marker_sync_error,
            revert_error
        )),
    }
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
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        options.mode(0o600);
        let file = options
            .open(&lock_path)
            .map_err(|e| format!("open workspace lock '{}': {}", lock_path.display(), e))?;
        #[cfg(unix)]
        {
            fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600)).map_err(|e| {
                format!(
                    "set workspace lock permissions '{}': {}",
                    lock_path.display(),
                    e
                )
            })?;
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
    File::open(parent)
        .and_then(|file| file.sync_all())
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
    sync_parent_directory: G,
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
        restore_workspace_backup,
        create_rollback_backup,
        rename_workspace_path,
    )
}

#[cfg(test)]
fn workspace_save_to_test_hook_with_backup<F, G, H, I>(
    path: &Path,
    value: &Value,
    before_rename: F,
    sync_parent_directory: G,
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
    sync_parent_directory: G,
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
    use std::os::unix::fs::PermissionsExt;
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
    fn native_workspace_tests_rejects_invalid_json() {
        let (_dir, path) = temp_workspace_path();
        fs::write(&path, b"{not json").expect("write invalid json");

        let err = load_workspace_from(&path).expect_err("load should fail");
        assert!(err.contains("parse workspace"));
    }

    #[test]
    fn native_workspace_tests_load_requires_pending_recovery() {
        let (_dir, path) = temp_workspace_path();
        fs::write(
            &path,
            serde_json::to_vec(&workspace_with_project("unrecovered")).expect("serialize"),
        )
        .expect("write workspace");
        let pending = pending_path(&path);
        fs::write(
            &pending,
            serde_json::to_vec(&workspace_with_project("previous")).expect("serialize"),
        )
        .expect("write pending rollback");

        let error = load_workspace_from(&path).expect_err("pending rollback must block load");

        assert!(error.contains("recovery required"));
        assert!(error.contains(&pending.display().to_string()));
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
        let load_error = load_workspace_from(&path).expect_err("pending must block load");
        assert!(load_error.contains("recovery required"));
    }

    #[test]
    fn native_workspace_tests_unconfirmed_committed_marker_keeps_old_bytes() {
        let (_dir, path) = temp_workspace_path();
        let previous_bytes =
            serde_json::to_vec(&workspace_with_project("previous")).expect("serialize previous");
        fs::write(&path, &previous_bytes).expect("write previous workspace");
        let pending = pending_path(&path);
        let committed = committed_path(&path);
        let updated = workspace_with_project("updated");
        let mut sync_calls = 0;

        workspace_save_to_test_hook_with_ops(
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
        .expect("save cannot report failure after pending became unavailable");

        assert!(!pending.exists());
        assert_eq!(
            fs::read(&committed).expect("read retained committed rollback"),
            previous_bytes
        );
        assert_eq!(
            load_workspace_from(&path)
                .expect("load updated workspace")
                .expect("workspace exists"),
            updated
        );

        let later = workspace_with_project("later");
        workspace_save_to_test_hook(
            &path,
            &later,
            |_| {
                assert_eq!(
                    load_workspace_from_locked(&path)
                        .expect("load updated workspace before later save")
                        .expect("workspace exists"),
                    updated
                );
                Ok(())
            },
            sync_parent_directory,
            restore_workspace_backup,
        )
        .expect("later save must clean committed without restoring it");
        assert_eq!(
            load_workspace_from(&path)
                .expect("load later workspace")
                .expect("workspace exists"),
            later
        );
        assert!(!committed.exists());
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

        let load_error = load_workspace_from(&path).expect_err("pending must block load");
        assert!(load_error.contains("recovery required"));
        assert_eq!(
            fs::read(&pending).expect("retained pending rollback"),
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
        let load_error = load_workspace_from(&path).expect_err("pending must block load");
        assert!(load_error.contains("recovery required"));
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
    fn native_workspace_tests_reader_waits_for_rollback_to_finish() {
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
                restore_workspace_backup,
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
        assert_eq!(
            writer.join().expect("join writer"),
            Err("parent sync failed".to_string())
        );
        assert_eq!(
            reader
                .join()
                .expect("join reader")
                .expect("read workspace")
                .expect("workspace exists"),
            original
        );
    }

    #[test]
    fn native_workspace_tests_creates_secure_permissions_on_unix() {
        let (_dir, path) = temp_parent_workspace_path();
        let value = workspace_value();

        save_workspace_to(&path, &value).expect("save workspace");

        #[cfg(unix)]
        {
            let parent = path.parent().expect("parent");
            let parent_mode = fs::metadata(parent).expect("metadata").permissions().mode() & 0o777;
            let file_mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
            let lock_mode = fs::metadata(workspace_lock_path(parent, "workspace-v3.json"))
                .expect("lock metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(parent_mode, 0o700);
            assert_eq!(file_mode, 0o600);
            assert_eq!(lock_mode, 0o600);
        }
    }
}
