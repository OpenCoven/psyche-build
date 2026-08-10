use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const WORKSPACE_VERSION: i64 = 3;
const WORKSPACE_FILE_RELATIVE: &str = ".psyche/macos-app/workspace-v3.json";

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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
    save_workspace_to_inner(path, value, |_| Ok(()))
}

fn save_workspace_to_inner<F>(path: &Path, value: &Value, before_rename: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    validate_workspace(value)
        .map_err(|e| format!("validate workspace '{}': {}", path.display(), e))?;

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

    let file_name = path
        .file_name()
        .ok_or_else(|| format!("workspace path has no file name: {}", path.display()))?
        .to_string_lossy()
        .to_string();
    let temp_path = workspace_temp_path(parent, &file_name);
    let mut temp_file = open_temp_file(&temp_path)?;
    let temp_guard = TempFileGuard::new(temp_path.clone());

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

    sync_parent_directory(parent)?;
    Ok(())
}

#[cfg(unix)]
fn open_temp_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    options.mode(0o600);
    options
        .open(path)
        .map_err(|e| format!("create workspace temp '{}': {}", path.display(), e))
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

    fn commit(mut self) {
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
fn workspace_save_to_test_hook<F>(
    path: &Path,
    value: &Value,
    before_rename: F,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    save_workspace_to_inner(path, value, before_rename)
}

pub(crate) fn workspace_default_path() -> Result<PathBuf, String> {
    workspace_path_from_home()
}

#[tauri::command]
pub(crate) fn workspace_load() -> Result<Option<Value>, String> {
    load_workspace_from(&workspace_default_path()?)
}

#[tauri::command]
pub(crate) fn workspace_save(value: Value) -> Result<(), String> {
    save_workspace_to(&workspace_default_path()?, &value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
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

    #[test]
    fn native_workspace_tests_valid_round_trip() {
        let (_dir, path) = temp_workspace_path();
        let value = workspace_value();

        save_workspace_to(&path, &value).expect("save workspace");

        let loaded = load_workspace_from(&path)
            .expect("load workspace")
            .expect("workspace exists");
        assert_eq!(loaded, value);
        assert!(temp_files(path.parent().expect("parent"))
            .iter()
            .all(|name| !name.contains(".psyche-save-")));
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

        let err = workspace_save_to_test_hook(&path, &value, |temp| {
            assert!(temp
                .file_name()
                .expect("temp file name")
                .to_string_lossy()
                .contains(".psyche-save-"));
            Err("controlled failure".to_string())
        })
        .expect_err("hook should fail");

        assert_eq!(err, "controlled failure");
        assert!(temp_files(path.parent().expect("parent"))
            .iter()
            .all(|name| !name.contains(".psyche-save-")));
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
            assert_eq!(parent_mode, 0o700);
            assert_eq!(file_mode, 0o600);
        }
    }
}
