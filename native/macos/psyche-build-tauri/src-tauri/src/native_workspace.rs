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
    )
}

fn save_workspace_to_inner<F, G, H>(
    path: &Path,
    value: &Value,
    before_rename: F,
    mut sync_parent_directory: G,
    mut restore_workspace_backup: H,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
    G: FnMut(&Path) -> Result<(), String>,
    H: FnMut(&Path, &Path) -> Result<(), String>,
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
    let temp_path = workspace_temp_path(parent, &file_name);
    let recovery_path = workspace_recovery_path(parent, &file_name);

    if recovery_path.exists() {
        restore_workspace_backup(recovery_path.as_path(), path).map_err(|e| {
            format!(
                "restore pending workspace recovery '{}' to '{}': {}",
                recovery_path.display(),
                path.display(),
                e
            )
        })?;
        sync_parent_directory(parent)?;
    }

    validate_workspace(value)
        .map_err(|e| format!("validate workspace '{}': {}", path.display(), e))?;

    let mut temp_file = open_temp_file(&temp_path)?;
    let mut temp_guard = TempFileGuard::new(temp_path.clone());
    let mut rollback_guard = if workspace_file_exists(path)? {
        Some(create_rollback_backup(path, &recovery_path)?)
    } else {
        None
    };

    let write_result = (|| -> Result<(), String> {
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

        before_rename(temp_guard.path.as_path())?;

        fs::rename(temp_guard.path.as_path(), path)
            .map_err(|e| format!("replace workspace '{}': {}", path.display(), e))?;
        Ok(())
    })();

    match write_result {
        Ok(()) => {
            temp_guard.commit();
        }
        Err(err) => return Err(err),
    }

    if let Err(save_error) = sync_parent_directory(parent) {
        if let Err(restore_error) = rollback_workspace_after_sync_failure(
            path,
            recovery_path.as_path(),
            rollback_guard.as_mut(),
            &mut restore_workspace_backup,
        ) {
            if let Some(guard) = rollback_guard.as_mut() {
                guard.preserve();
                return Err(format!(
                    "{save_error}; rollback restoration failed: {restore_error}; recovery copy preserved at '{}'",
                    recovery_path.display()
                ));
            }
            return Err(format!(
                "{save_error}; rollback restoration failed: {restore_error}"
            ));
        }
        sync_parent_directory(parent).map_err(|rollback_sync_error| {
            format!(
                "{save_error}; rollback restored the previous workspace but parent sync failed: {rollback_sync_error}"
            )
        })?;
        temp_guard.commit();
        return Err(save_error);
    }

    if let Some(guard) = rollback_guard.as_mut() {
        guard.remove()?;
        sync_parent_directory(parent)?;
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

fn workspace_recovery_path(parent: &Path, file_name: &str) -> PathBuf {
    parent.join(format!(".{file_name}.psyche-recovery"))
}

fn workspace_file_exists(path: &Path) -> Result<bool, String> {
    match fs::metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("stat workspace '{}': {}", path.display(), e)),
    }
}

fn create_rollback_backup(path: &Path, backup_path: &Path) -> Result<RollbackBackupGuard, String> {
    match fs::hard_link(path, backup_path) {
        Ok(()) => Ok(RollbackBackupGuard::new(backup_path.to_path_buf())),
        Err(link_error) => {
            copy_rollback_backup(path, backup_path).map_err(|copy_error| {
                format!(
                    "create rollback backup '{}' from '{}': {} (hard link failed: {})",
                    backup_path.display(),
                    path.display(),
                    copy_error,
                    link_error
                )
            })?;
            Ok(RollbackBackupGuard::new(backup_path.to_path_buf()))
        }
    }
}

fn copy_rollback_backup(path: &Path, backup_path: &Path) -> Result<(), String> {
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
    let mut backup = open_new_workspace_file(backup_path, "rollback backup")?;
    let copied = std::io::copy(&mut source, &mut backup)
        .map_err(|e| format!("copy rollback backup '{}': {}", backup_path.display(), e))?;
    if copied != metadata.len() {
        return Err(format!(
            "copy rollback backup '{}' truncated: copied {} of {} bytes",
            backup_path.display(),
            copied,
            metadata.len()
        ));
    }
    backup
        .sync_all()
        .map_err(|e| format!("sync rollback backup '{}': {}", backup_path.display(), e))?;
    Ok(())
}

fn restore_workspace_backup(backup_path: &Path, path: &Path) -> Result<(), String> {
    fs::rename(backup_path, path).map_err(|e| {
        format!(
            "restore workspace from recovery copy '{}' to '{}': {}",
            backup_path.display(),
            path.display(),
            e
        )
    })
}

fn rollback_workspace_after_sync_failure(
    path: &Path,
    rollback_path: &Path,
    rollback_guard: Option<&mut RollbackBackupGuard>,
    restore_workspace_backup: &mut impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if rollback_guard.is_some() {
        restore_workspace_backup(rollback_path, path)?;
        if let Some(guard) = rollback_guard {
            guard.commit();
        }
    } else if path.exists() {
        fs::remove_file(path)
            .map_err(|e| format!("remove failed workspace '{}': {}", path.display(), e))?;
    }
    Ok(())
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

struct RollbackBackupGuard {
    path: PathBuf,
    committed: bool,
}

impl RollbackBackupGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }

    fn preserve(&mut self) {
        self.committed = true;
    }

    fn remove(&mut self) -> Result<(), String> {
        fs::remove_file(&self.path).map_err(|e| {
            format!(
                "remove workspace recovery copy '{}': {}",
                self.path.display(),
                e
            )
        })?;
        self.commit();
        Ok(())
    }
}

impl Drop for RollbackBackupGuard {
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

    fn recovery_path(path: &Path) -> PathBuf {
        workspace_recovery_path(
            path.parent().expect("parent"),
            &path.file_name().expect("file name").to_string_lossy(),
        )
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
        assert!(!recovery_path(&path).exists());
    }

    #[test]
    fn native_workspace_tests_restores_previous_file_on_parent_sync_failure() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_value();
        fs::write(&path, serde_json::to_vec(&original).expect("serialize"))
            .expect("write original workspace");
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

        assert_eq!(err, "parent sync failed");

        let restored = load_workspace_from(&path)
            .expect("load")
            .expect("workspace still exists");
        assert_eq!(restored, original);

        let parent = path.parent().expect("parent");
        assert!(cleanup_artifacts(parent).is_empty());
        assert!(!recovery_path(&path).exists());
    }

    #[test]
    fn native_workspace_tests_preserves_recovery_copy_when_restore_fails() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_value();
        let original_bytes = serde_json::to_vec(&original).expect("serialize original");
        fs::write(&path, &original_bytes).expect("write original workspace");
        let updated = workspace_with_project("updated");
        let recovery = recovery_path(&path);

        let err = workspace_save_to_test_hook(
            &path,
            &updated,
            |_| Ok(()),
            |_| Err("parent sync failed".to_string()),
            |backup, destination| {
                assert_eq!(backup, recovery);
                assert_eq!(destination, path);
                Err("injected restore failure".to_string())
            },
        )
        .expect_err("restore failure should fail");

        assert!(err.contains("parent sync failed"));
        assert!(err.contains("injected restore failure"));
        assert!(err.contains(&recovery.display().to_string()));
        assert_eq!(
            fs::read(&recovery).expect("retained recovery copy"),
            original_bytes
        );
        assert_eq!(
            load_workspace_from(&path)
                .expect("load replacement")
                .expect("replacement exists"),
            updated
        );
        assert!(cleanup_artifacts(path.parent().expect("parent")).is_empty());
    }

    #[test]
    fn native_workspace_tests_recovers_recovery_copy_before_later_save() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_value();
        let original_bytes = serde_json::to_vec(&original).expect("serialize original");
        fs::write(&path, &original_bytes).expect("write original workspace");
        let first_update = workspace_with_project("first");
        let later_update = workspace_with_project("later");
        let recovery = recovery_path(&path);

        workspace_save_to_test_hook(
            &path,
            &first_update,
            |_| Ok(()),
            |_| Err("parent sync failed".to_string()),
            |backup, destination| {
                assert_eq!(backup, recovery);
                assert_eq!(destination, path);
                Err("injected restore failure".to_string())
            },
        )
        .expect_err("restore failure should fail");

        assert_eq!(
            load_workspace_from(&path)
                .expect("load failed save")
                .expect("workspace exists"),
            first_update
        );
        assert_eq!(
            fs::read(&recovery).expect("retained recovery copy"),
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
        assert!(!recovery.exists());
    }

    #[test]
    fn native_workspace_tests_repeated_restore_failure_keeps_recovery_copy() {
        let (_dir, path) = temp_workspace_path();
        let original = workspace_value();
        let original_bytes = serde_json::to_vec(&original).expect("serialize original");
        fs::write(&path, &original_bytes).expect("write original workspace");
        let first_update = workspace_with_project("first");
        let second_update = workspace_with_project("second");
        let recovery = recovery_path(&path);

        workspace_save_to_test_hook(
            &path,
            &first_update,
            |_| Ok(()),
            |_| Err("parent sync failed".to_string()),
            |backup, destination| {
                assert_eq!(backup, recovery);
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
                assert_eq!(backup, recovery);
                assert_eq!(destination, path);
                Err("injected restore failure".to_string())
            },
        )
        .expect_err("second restore failure should fail");
        assert!(first_restore_error.contains("restore pending workspace recovery"));
        assert!(first_restore_error.contains("injected restore failure"));

        let second_restore_error = workspace_save_to_test_hook(
            &path,
            &second_update,
            |_| Ok(()),
            |_| Ok(()),
            |backup, destination| {
                assert_eq!(backup, recovery);
                assert_eq!(destination, path);
                Err("injected restore failure".to_string())
            },
        )
        .expect_err("repeated restore failure should still fail");
        assert!(second_restore_error.contains("restore pending workspace recovery"));
        assert!(second_restore_error.contains("injected restore failure"));

        assert_eq!(
            fs::read(&recovery).expect("retained recovery copy"),
            original_bytes
        );
        assert_eq!(
            load_workspace_from(&path)
                .expect("load blocked save")
                .expect("workspace exists"),
            first_update
        );
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
                    if sync_calls == 1 {
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
        assert!(!recovery_path(&path).exists());
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
                    if sync_calls == 1 {
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
