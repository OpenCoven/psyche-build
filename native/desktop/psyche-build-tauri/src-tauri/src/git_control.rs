//! Reading Git state without trusting the repository that supplies it.
//!
//! #197 slice 4. Every Git command the desktop exposes — status, diff, log,
//! worktrees — runs a subprocess against a directory the user chose, so the
//! repository is untrusted input. Most of this module is the checking that
//! makes running `git` there safe rather than the running itself.
//!
//! Three things it defends against, none of which is obvious from a command
//! name. A repository can configure filter, diff and merge drivers that
//! execute arbitrary programs, so config is read through an isolated
//! environment rather than inherited. A `.git` directory can be swapped for a
//! symlink or a reparse point between one command and the next, so directory
//! identity is verified by handle rather than by path. And a worktree can
//! point its `gitdir` anywhere, so a linked worktree is accepted only after
//! its root is confirmed.
//!
//! `git_dir_for_worktree` classifies the `.git` marker with
//! `symlink_metadata` (which does not follow symlinks or reparse points,
//! unlike `Path::is_dir`/`Path::is_file`) and reads a linked worktree's
//! `.git` file through `GitMetadataDirectory`, the same TOCTOU-safe,
//! size-bounded primitive used elsewhere in this module. It is reachable
//! from the `git_log` command with a caller-chosen root, and the directory
//! it returns is used to build the `index` and `objects` paths that are read
//! afterwards, so both checks matter.
//!
//! That is why the Windows file-identity helpers live here: they exist to
//! answer "is this the same directory I checked a moment ago", which is a Git
//! safety question rather than a filesystem utility.
//!
//! `linked_worktree_roots` and `verified_worktree_root` were measured into
//! three separate #197 slice 3 steps and excluded from all of them, because
//! worktree identity belongs to this capability and has callers beyond PTY.
//! `pty_cwd` reached back into the crate root for them; now it imports them.

use super::*;

pub(crate) fn linked_worktree_roots(project_root: &Path) -> Result<Vec<PathBuf>, String> {
    let root = project_root
        .to_str()
        .ok_or_else(|| "project root is not valid UTF-8".to_string())?;
    let raw = run_git_metadata(root, &["worktree", "list", "--porcelain"])?;
    Ok(parse_git_worktrees(&raw)
        .into_iter()
        .filter(|worktree| !worktree.bare && !worktree.prunable && !worktree.missing)
        .filter_map(|worktree| {
            let canonical = Path::new(&worktree.path).canonicalize().ok()?;
            canonical.is_dir().then_some(canonical)
        })
        .collect())
}

pub(crate) fn verified_worktree_root(project_root: &str, cwd: &Path) -> Result<PathBuf, String> {
    let canonical_root = canonical_project_root(project_root)?;
    let canonical_cwd = cwd
        .canonicalize()
        .map_err(|e| format!("PTY cwd '{}': {}", cwd.display(), e))?;
    if canonical_cwd.starts_with(&canonical_root) {
        return Ok(canonical_root);
    }
    linked_worktree_roots(&canonical_root)?
        .into_iter()
        .filter(|root| canonical_cwd.starts_with(root))
        .max_by_key(|root| root.components().count())
        .ok_or_else(|| {
            format!(
                "PTY cwd is outside the project and its linked worktrees: {}",
                cwd.display()
            )
        })
}

#[cfg(test)]
fn git_repository_config_available(root: &str) -> Result<bool, String> {
    let out = git_command(root)
        .args(["rev-parse", "--git-dir"])
        .output()
        .map_err(|e| format!("git: {}", e))?;
    Ok(out.status.success())
}

#[cfg(any(windows, test))]
fn has_windows_verbatim_disk_prefix(encoded: &[u16]) -> bool {
    const VERBATIM_PREFIX: [u16; 4] = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];

    encoded.starts_with(&VERBATIM_PREFIX)
        && encoded.get(4).is_some_and(|unit| {
            (b'A' as u16..=b'Z' as u16).contains(unit) || (b'a' as u16..=b'z' as u16).contains(unit)
        })
        && encoded.get(5) == Some(&(b':' as u16))
        && encoded.get(6) == Some(&(b'\\' as u16))
}

fn git_subprocess_root(root: &Path) -> Cow<'_, Path> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        let encoded = root.as_os_str().encode_wide().collect::<Vec<_>>();
        if has_windows_verbatim_disk_prefix(&encoded) {
            return Cow::Owned(PathBuf::from(OsString::from_wide(&encoded[4..])));
        }
    }

    Cow::Borrowed(root)
}

fn git_command(root: &str) -> std::process::Command {
    #[cfg(test)]
    TEST_GIT_COMMAND_COUNT.with(|count| *count.borrow_mut() += 1);
    let mut command = std::process::Command::new("git");
    command.current_dir(git_subprocess_root(Path::new(root)).as_ref());
    #[cfg(test)]
    TEST_GIT_ENV_OVERRIDES.with(|overrides| {
        for (key, value) in overrides.borrow().iter() {
            match value {
                Some(value) => {
                    command.env(key, value);
                }
                None => {
                    command.env_remove(key);
                }
            }
        }
    });
    // Inspection must retain repository/global paths without inheriting
    // command-scope configuration supplied by the parent process.
    command.env_remove("GIT_CONFIG_PARAMETERS");
    command.env_remove("GIT_CONFIG_COUNT");
    command
}

fn git_worktree_config_enabled(root: &str) -> Result<bool, String> {
    let out = git_command(root)
        .args([
            "config",
            "--local",
            "--includes",
            "--bool",
            "--default=false",
            "extensions.worktreeConfig",
        ])
        .output()
        .map_err(|e| format!("git: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8(out.stderr)
            .map_err(|err| format!("git config returned invalid UTF-8 stderr: {err}"))?
            .trim()
            .to_string();
        return Err(if stderr.is_empty() {
            format!(
                "git config extensions.worktreeConfig query failed with status {}",
                out.status
            )
        } else {
            format!(
                "git config extensions.worktreeConfig query failed: {}",
                stderr
            )
        });
    }
    match String::from_utf8(out.stdout)
        .map_err(|err| format!("git config returned invalid UTF-8 stdout: {err}"))?
        .trim()
    {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(
            "git config extensions.worktreeConfig query returned a non-boolean value".to_string(),
        ),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GitFilterDriverKind {
    Clean,
    Process,
    Required,
}

#[derive(Default)]
struct GitFilterScopeConfig {
    values: HashMap<String, String>,
}

impl GitFilterScopeConfig {
    fn value(&self, key: &str) -> Option<String> {
        self.values.get(key).cloned()
    }

    fn bool(&self, key: &str) -> Result<Option<bool>, String> {
        let Some(value) = self.values.get(key) else {
            return Ok(None);
        };
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "true" | "yes" | "on" | "1" => Ok(Some(true)),
            "false" | "no" | "off" | "0" => Ok(Some(false)),
            _ => Err(format!(
                "git config {key} query returned a non-boolean value"
            )),
        }
    }

    fn driver_names(&self) -> Result<Vec<(String, GitFilterDriverKind)>, String> {
        let mut drivers = Vec::new();
        for key in self.values.keys() {
            let Some(rest) = key.strip_prefix("filter.") else {
                continue;
            };
            let (driver, kind) = if let Some(driver) = rest.strip_suffix(".clean") {
                (driver, GitFilterDriverKind::Clean)
            } else if let Some(driver) = rest.strip_suffix(".process") {
                (driver, GitFilterDriverKind::Process)
            } else if let Some(driver) = rest.strip_suffix(".required") {
                (driver, GitFilterDriverKind::Required)
            } else {
                continue;
            };
            if driver.is_empty() {
                return Err("git config returned an empty filter driver name".to_string());
            }
            drivers.push((driver.to_string(), kind));
        }
        Ok(drivers)
    }
}

fn git_filter_config_for_scope(root: &str, scope: &str) -> Result<GitFilterScopeConfig, String> {
    #[cfg(test)]
    TEST_GIT_FILTER_SCOPE_QUERIES.with(|queries| queries.borrow_mut().push(scope.to_string()));
    let out = git_command(root)
        .args([
            "config",
            scope,
            "--includes",
            "--null",
            "--get-regexp",
            r"^filter\..*\.(clean|process|required)$",
        ])
        .output()
        .map_err(|e| format!("git: {}", e))?;
    if !out.status.success() {
        if out.status.code() == Some(1) {
            return Ok(GitFilterScopeConfig::default());
        }
        let stderr = String::from_utf8(out.stderr)
            .map_err(|err| format!("git config returned invalid UTF-8 stderr: {err}"))?
            .trim()
            .to_string();
        return Err(if stderr.is_empty() {
            format!("git config filter query failed with status {}", out.status)
        } else {
            format!("git config filter query failed: {}", stderr)
        });
    }

    let mut config = GitFilterScopeConfig::default();
    for record in out
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let Some(separator) = record.iter().position(|byte| *byte == b'\n') else {
            return Err("git config filter query returned malformed output".to_string());
        };
        let (key_bytes, value_bytes) = record.split_at(separator);
        let key = std::str::from_utf8(key_bytes)
            .map_err(|_| "git config filter query returned invalid UTF-8 keys".to_string())?;
        let value = std::str::from_utf8(&value_bytes[1..]).map_err(|err| {
            format!("git config {key} query returned invalid UTF-8 stdout: {err}")
        })?;
        config.values.insert(key.to_string(), value.to_string());
    }
    Ok(config)
}

#[derive(Debug, PartialEq, Eq)]
struct GitFilterDriverOverride {
    driver: String,
    clean: Option<String>,
    process: Option<String>,
    required: Option<bool>,
    repository_clean: bool,
    repository_process: bool,
}

fn git_filter_driver_override_from_scopes(
    driver: String,
    repository_clean: bool,
    repository_process: bool,
    system: &GitFilterScopeConfig,
    global: &GitFilterScopeConfig,
) -> Result<GitFilterDriverOverride, String> {
    let clean_key = format!("filter.{driver}.clean");
    let process_key = format!("filter.{driver}.process");
    let required_key = format!("filter.{driver}.required");
    Ok(GitFilterDriverOverride {
        clean: global
            .value(&clean_key)
            .or_else(|| system.value(&clean_key)),
        process: global
            .value(&process_key)
            .or_else(|| system.value(&process_key)),
        required: match global.bool(&required_key)? {
            Some(value) => Some(value),
            None => system.bool(&required_key)?,
        },
        repository_clean,
        repository_process,
        driver,
    })
}

#[cfg(test)]
fn git_filter_driver_override(
    root: &str,
    driver: String,
    repository_clean: bool,
    repository_process: bool,
) -> Result<GitFilterDriverOverride, String> {
    let system = git_filter_config_for_scope(root, "--system")?;
    let global = git_filter_config_for_scope(root, "--global")?;
    git_filter_driver_override_from_scopes(
        driver,
        repository_clean,
        repository_process,
        &system,
        &global,
    )
}

#[cfg(test)]
fn git_filter_driver_overrides(root: &str) -> Result<Vec<GitFilterDriverOverride>, String> {
    if !git_repository_config_available(root)? {
        return Ok(Vec::new());
    }

    let local = git_filter_config_for_scope(root, "--local")?;
    let mut drivers = local.driver_names()?;
    // Without extensions.worktreeConfig, `git config --worktree` falls back to
    // local config instead of reporting an unavailable worktree scope. Only
    // query worktree-owned config when the repository explicitly enables it.
    if git_worktree_config_enabled(root)? {
        drivers.extend(git_filter_config_for_scope(root, "--worktree")?.driver_names()?);
    }
    let system = git_filter_config_for_scope(root, "--system")?;
    let global = git_filter_config_for_scope(root, "--global")?;
    drivers.sort_by(|left, right| left.0.cmp(&right.0));
    let mut driver_sources: Vec<(String, bool, bool)> = Vec::new();
    for (driver, kind) in drivers {
        if driver_sources.last().map(|entry| entry.0.as_str()) != Some(driver.as_str()) {
            driver_sources.push((driver, false, false));
        }
        let entry = driver_sources.last_mut().expect("driver entry must exist");
        match kind {
            GitFilterDriverKind::Clean => entry.1 = true,
            GitFilterDriverKind::Process => entry.2 = true,
            GitFilterDriverKind::Required => {}
        }
    }
    driver_sources
        .into_iter()
        .map(|(driver, repository_clean, repository_process)| {
            git_filter_driver_override_from_scopes(
                driver,
                repository_clean,
                repository_process,
                &system,
                &global,
            )
        })
        .collect()
}

fn git_trusted_filter_driver_overrides(root: &str) -> Result<Vec<GitFilterDriverOverride>, String> {
    let system = git_filter_config_for_scope(root, "--system")?;
    let global = git_filter_config_for_scope(root, "--global")?;
    let mut drivers = system.driver_names()?;
    drivers.extend(global.driver_names()?);
    drivers.sort_by(|left, right| left.0.cmp(&right.0));
    drivers.dedup_by(|left, right| left.0 == right.0);
    drivers
        .into_iter()
        .map(|(driver, _)| {
            git_filter_driver_override_from_scopes(driver, false, false, &system, &global)
        })
        .collect()
}

fn git_url_rewrite_config_for_scope(
    root: &str,
    scope: &str,
) -> Result<Vec<(String, String)>, String> {
    let out = git_command(root)
        .args([
            "config",
            scope,
            "--includes",
            "--null",
            "--get-regexp",
            r"^url\..*\.insteadof$",
        ])
        .output()
        .map_err(|e| format!("git: {}", e))?;
    if !out.status.success() {
        if out.status.code() == Some(1) {
            return Ok(Vec::new());
        }
        let stderr = String::from_utf8(out.stderr)
            .map_err(|err| format!("git config returned invalid UTF-8 stderr: {err}"))?
            .trim()
            .to_string();
        return Err(if stderr.is_empty() {
            format!(
                "git config URL rewrite query failed with status {}",
                out.status
            )
        } else {
            format!("git config URL rewrite query failed: {}", stderr)
        });
    }

    let mut values = Vec::new();
    for record in out
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let Some(separator) = record.iter().position(|byte| *byte == b'\n') else {
            return Err("git config URL rewrite query returned malformed output".to_string());
        };
        let (key_bytes, value_bytes) = record.split_at(separator);
        let key = std::str::from_utf8(key_bytes)
            .map_err(|_| "git config URL rewrite query returned invalid UTF-8 keys".to_string())?;
        let value = std::str::from_utf8(&value_bytes[1..]).map_err(|err| {
            format!("git config {key} query returned invalid UTF-8 stdout: {err}")
        })?;
        values.push((key.to_string(), value.to_string()));
    }
    Ok(values)
}

fn git_trusted_url_rewrite_config(root: &str) -> Result<Vec<(String, String)>, String> {
    let mut values = git_url_rewrite_config_for_scope(root, "--system")?;
    values.extend(git_url_rewrite_config_for_scope(root, "--global")?);
    Ok(values)
}

fn git_metadata_output(root: &str, args: &[&str]) -> Result<std::process::Output, String> {
    git_command(root)
        .args(args)
        .output()
        .map_err(|e| format!("git: {}", e))
}

fn run_git_metadata(root: &str, args: &[&str]) -> Result<String, String> {
    let out = git_metadata_output(root, args)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git {:?} failed", args)
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn normalize_git_metadata_path(path: &Path) -> PathBuf {
    use std::path::Component;

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let can_pop = matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                );
                if can_pop {
                    normalized.pop();
                } else if !path.is_absolute() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        normalized
    }
}

fn resolve_git_path(root: &Path, raw: &str) -> PathBuf {
    let path = PathBuf::from(raw.trim());
    if path.is_absolute() {
        normalize_git_metadata_path(&path)
    } else {
        normalize_git_metadata_path(&root.join(path))
    }
}

const MAX_LINKED_WORKTREE_GITDIR_FILE_BYTES: u64 = 64 * 1024;

enum GitMarkerKind {
    Directory,
    File,
    Missing,
}

/// Classifies a candidate `.git` marker without following symlinks or
/// reparse points: `symlink_metadata` never follows the final path
/// component, unlike `Path::is_dir`/`Path::is_file`, which call
/// `metadata()` and do.
fn git_marker_kind(dot_git: &Path, label: &str) -> Result<GitMarkerKind, String> {
    match std::fs::symlink_metadata(dot_git) {
        Ok(metadata) => {
            if metadata_is_link_like(&metadata) {
                return Err(format!(
                    "{label} is a symlink, which is not a supported marker"
                ));
            }
            if metadata.is_dir() {
                Ok(GitMarkerKind::Directory)
            } else if metadata.is_file() {
                Ok(GitMarkerKind::File)
            } else {
                Err(format!("{label} is not a regular file or directory"))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(GitMarkerKind::Missing),
        Err(error) => Err(format!("inspect {label}: {error}")),
    }
}

fn git_dir_for_worktree(root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let mut current = Some(root);
    while let Some(candidate) = current {
        let dot_git = candidate.join(".git");
        let label = "worktree .git marker";
        match git_marker_kind(&dot_git, label)? {
            GitMarkerKind::Directory => {
                // Unlike the `File` branch below, this only returns a path;
                // it does not open or pin the `.git` directory itself. That
                // is safe: every production caller resolves this path and
                // then immediately opens it with a no-follow
                // (`O_NOFOLLOW`/reparse-point-rejecting) handle before
                // reading anything from inside it (see
                // `GitInspectionRepository::snapshot`'s `git_dir_handle`).
                // A `.git` marker swapped for a symlink between this
                // classification and that open fails closed there rather
                // than being followed, so no separate pin is needed here.
                return Ok((candidate.to_path_buf(), dot_git));
            }
            GitMarkerKind::File => {
                // Reuse the hardened, TOCTOU-safe, size-bounded reader:
                // opening the parent directory and the child file with
                // O_NOFOLLOW (or the platform equivalent) rejects a
                // marker that is, or becomes, a symlink between the
                // classification above and this read.
                let label = "linked worktree Git directory marker";
                let directory = GitMetadataDirectory::open(candidate, "worktree directory")?;
                let bytes = directory
                    .read_file(".git", label, MAX_LINKED_WORKTREE_GITDIR_FILE_BYTES)
                    .map_err(|error| error.into_message(label))?;
                directory.validate("worktree directory")?;
                let text =
                    String::from_utf8(bytes).map_err(|_| format!("{label} is not valid UTF-8"))?;
                let raw = text
                    .trim()
                    .strip_prefix("gitdir:")
                    .ok_or_else(|| "linked worktree .git file is malformed".to_string())?
                    .trim();
                let git_dir = resolve_git_path(candidate, raw);
                return Ok((candidate.to_path_buf(), git_dir));
            }
            GitMarkerKind::Missing => {}
        }
        current = candidate.parent();
    }
    Err("not a Git worktree".to_string())
}

fn git_repository_paths(root: &Path) -> Result<(Option<PathBuf>, PathBuf), String> {
    if root.join(".git").is_dir() || root.join(".git").is_file() {
        return git_dir_for_worktree(root).map(|(work_tree, git_dir)| (Some(work_tree), git_dir));
    }
    if root.join("HEAD").is_file()
        && (root.join("objects").is_dir() || root.join("commondir").is_file())
    {
        return Ok((None, root.to_path_buf()));
    }
    git_dir_for_worktree(root).map(|(work_tree, git_dir)| (Some(work_tree), git_dir))
}

#[cfg(test)]
fn git_common_dir(git_dir: &Path) -> Result<PathBuf, String> {
    let commondir = git_dir.join("commondir");
    if !commondir.is_file() {
        return Ok(git_dir.to_path_buf());
    }
    let raw = std::fs::read_to_string(&commondir)
        .map_err(|e| format!("read Git common directory: {e}"))?;
    Ok(resolve_git_path(git_dir, &raw))
}

const MAX_GIT_COMMONDIR_FILE_BYTES: u64 = 4 * 1024;

/// Bounds a plain, unpacked `HEAD` file (`ref: refs/heads/<name>\n` or a
/// bare object id): real Git HEAD contents are at most a few hundred
/// bytes, so this is generous headroom, not a soft limit meant to be hit.
const MAX_GIT_HEAD_BYTES: u64 = 4 * 1024;
const MAX_GIT_INDEX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_GIT_LOOSE_REF_BYTES: u64 = 4 * 1024;
const MAX_GIT_PACKED_REFS_BYTES: u64 = 64 * 1024 * 1024;

/// Same resolution as [`git_common_dir`], but classifies the `commondir`
/// marker via the pinned directory handle's own no-follow, fd-relative
/// open, rather than a second, separate path-based stat. Existence,
/// symlink-ness, and directory-ness are all classified by the same
/// `openat`/`NtCreateFile` call that performs the read, so nothing about
/// the marker's type can be decided from a lookup that could itself have
/// raced against a swap of the resolved Git directory or the marker
/// inside it. This closes the same TOCTOU window `git_dir_for_worktree`
/// already defends against for the `.git` marker itself: a hostile
/// repository swapping its Git directory, or the `commondir` file inside
/// it, for a symlink between resolution and this read must not redirect
/// where the common directory is believed to live.
fn git_common_dir_pinned(handle: &GitMetadataDirectory, git_dir: &Path) -> Result<PathBuf, String> {
    let label = "Git commondir file";
    match handle.read_file("commondir", label, MAX_GIT_COMMONDIR_FILE_BYTES) {
        Ok(bytes) => {
            let raw =
                String::from_utf8(bytes).map_err(|_| format!("{label} is not valid UTF-8"))?;
            Ok(resolve_git_path(git_dir, &raw))
        }
        Err(GitMetadataReadError::NotFound) => Ok(git_dir.to_path_buf()),
        Err(error) => Err(error.into_message(label)),
    }
}

fn is_valid_git_ref_name(name: &str) -> bool {
    if name == "@"
        || !name.contains('/')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.contains("..")
        || name.contains("@{")
        || name.contains("//")
    {
        return false;
    }
    if name.split('/').any(|component| {
        component.is_empty() || component.starts_with('.') || component.ends_with(".lock")
    }) {
        return false;
    }
    !name.bytes().any(|byte| {
        byte < b' '
            || byte == 0x7f
            || matches!(byte, b' ' | b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
    })
}

fn git_oid_hex_len(object_format: Option<&str>) -> usize {
    if object_format == Some("sha256") {
        64
    } else {
        40
    }
}

fn is_valid_git_oid(value: &str, object_format: Option<&str>) -> bool {
    value.len() == git_oid_hex_len(object_format)
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn collect_loose_refs(
    directory: &GitMetadataDirectory,
    directory_label: &str,
    prefix: &str,
    refs: &mut HashMap<String, GitRefValue>,
    object_format: Option<&str>,
) -> Result<(), String> {
    for file_name in directory.list_entries(directory_label)? {
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if name.ends_with(".lock") {
            continue;
        }
        let ref_name = format!("{prefix}/{name}");
        let child_directory_label = format!("Git ref directory {ref_name}");
        match directory.open_directory(name, &child_directory_label) {
            Ok(child_directory) => {
                collect_loose_refs(
                    &child_directory,
                    &child_directory_label,
                    &ref_name,
                    refs,
                    object_format,
                )?;
                continue;
            }
            Err(GitMetadataReadError::NotFound) => continue,
            Err(GitMetadataReadError::Other(error))
                if error == format!("{child_directory_label} is not a real directory") => {}
            Err(error) => return Err(error.into_message(&child_directory_label)),
        }
        if !is_valid_git_ref_name(&ref_name) {
            continue;
        }
        let ref_label = format!("Git ref {ref_name}");
        let value = String::from_utf8(
            directory
                .read_file(name, &ref_label, MAX_GIT_LOOSE_REF_BYTES)
                .map_err(|error| error.into_message(&ref_label))?,
        )
        .map_err(|_| format!("{ref_label} is not valid UTF-8"))?;
        let value = value.trim();
        if let Some(target) = value.strip_prefix("ref: ") {
            refs.insert(ref_name, GitRefValue::Symbolic(target.to_string()));
        } else if is_valid_git_oid(value, object_format) {
            refs.insert(ref_name, GitRefValue::Direct(value.to_string()));
        }
    }
    directory.validate_path_identity(directory_label, "while being read")?;
    Ok(())
}

enum GitRefValue {
    Direct(String),
    Symbolic(String),
}

fn snapshot_git_refs(
    common_dir: &GitMetadataDirectory,
    object_format: Option<&str>,
) -> Result<HashMap<String, GitRefValue>, String> {
    snapshot_git_refs_with_hook(common_dir, object_format, || ())
}

fn snapshot_git_refs_with_hook<F, G>(
    common_dir: &GitMetadataDirectory,
    object_format: Option<&str>,
    after_common_dir_open: F,
) -> Result<HashMap<String, GitRefValue>, String>
where
    F: FnOnce() -> G,
{
    let mut refs = HashMap::new();
    let _hook_guard = after_common_dir_open();
    let packed_refs_label = "packed Git refs";
    match common_dir.read_file("packed-refs", packed_refs_label, MAX_GIT_PACKED_REFS_BYTES) {
        Ok(bytes) => {
            let packed = String::from_utf8(bytes)
                .map_err(|_| format!("{packed_refs_label} is not valid UTF-8"))?;
            for line in packed.lines() {
                if line.is_empty() || line.starts_with('#') || line.starts_with('^') {
                    continue;
                }
                if let Some((oid, name)) = line.split_once(' ') {
                    refs.insert(name.to_string(), GitRefValue::Direct(oid.to_string()));
                }
            }
        }
        Err(GitMetadataReadError::NotFound) => {}
        Err(error) => return Err(error.into_message(packed_refs_label)),
    }
    let refs_directory_label = "Git refs directory";
    match common_dir.open_directory("refs", refs_directory_label) {
        Ok(refs_directory) => {
            collect_loose_refs(
                &refs_directory,
                refs_directory_label,
                "refs",
                &mut refs,
                object_format,
            )?;
        }
        Err(GitMetadataReadError::NotFound) => {}
        Err(error) => return Err(error.into_message(refs_directory_label)),
    }
    common_dir.validate_path_identity("Git common directory", "while being read")?;
    Ok(refs)
}

const MAX_GIT_SHALLOW_BYTES: u64 = 16 * 1024 * 1024;
const MAX_GIT_INFO_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_GIT_REFTABLE_LIST_BYTES: u64 = 1024 * 1024;
const MAX_GIT_REFTABLE_TABLES: usize = 4096;
const MAX_GIT_REFTABLE_TABLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_GIT_REFTABLE_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Copy)]
struct GitReftableSnapshotLimits {
    list_bytes: u64,
    tables: usize,
    table_bytes: u64,
    total_bytes: u64,
}

const GIT_REFTABLE_SNAPSHOT_LIMITS: GitReftableSnapshotLimits = GitReftableSnapshotLimits {
    list_bytes: MAX_GIT_REFTABLE_LIST_BYTES,
    tables: MAX_GIT_REFTABLE_TABLES,
    table_bytes: MAX_GIT_REFTABLE_TABLE_BYTES,
    total_bytes: MAX_GIT_REFTABLE_TOTAL_BYTES,
};

fn read_optional_git_metadata_file(
    directory: &GitMetadataDirectory,
    name: &str,
    label: &str,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, String> {
    match directory.read_file(name, label, max_bytes) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(GitMetadataReadError::NotFound) => Ok(None),
        Err(error) => Err(error.into_message(label)),
    }
}

fn validate_git_shallow(bytes: &[u8], object_format: Option<&str>) -> Result<(), String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "invalid Git shallow boundary: content is not UTF-8".to_string())?;
    if text.is_empty()
        || text
            .lines()
            .any(|oid| !is_valid_git_oid(oid, object_format))
    {
        return Err("invalid Git shallow boundary".to_string());
    }
    Ok(())
}

fn read_git_shallow(common_dir: &GitMetadataDirectory) -> Result<Option<Vec<u8>>, String> {
    read_optional_git_metadata_file(
        common_dir,
        "shallow",
        "Git shallow boundary",
        MAX_GIT_SHALLOW_BYTES,
    )
}

fn snapshot_git_shallow(
    common_dir: &GitMetadataDirectory,
    destination: &Path,
    object_format: Option<&str>,
) -> Result<(), String> {
    snapshot_git_shallow_with_hook(common_dir, destination, object_format, || ())
}

fn snapshot_git_shallow_with_hook<F, G>(
    common_dir: &GitMetadataDirectory,
    destination: &Path,
    object_format: Option<&str>,
    after_common_dir_open: F,
) -> Result<(), String>
where
    F: FnOnce() -> G,
{
    let _hook_guard = after_common_dir_open();
    let Some(bytes) = read_git_shallow(common_dir)? else {
        return Ok(());
    };
    validate_git_shallow(&bytes, object_format)?;
    std::fs::write(destination.join("shallow"), bytes)
        .map_err(|e| format!("snapshot Git shallow boundary: {e}"))
}

#[cfg(any(windows, test))]
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0010;

#[cfg(any(windows, test))]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

#[cfg(windows)]
fn metadata_is_reparse_like(metadata: &std::fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_like(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn metadata_is_link_like(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink() || metadata_is_reparse_like(metadata)
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WindowsGitMetadataState {
    volume_serial_number: u32,
    file_index: u64,
    file_attributes: u32,
    file_size: u64,
    last_write_time: u64,
}

#[cfg(any(windows, test))]
fn windows_git_metadata_same_identity(
    before: WindowsGitMetadataState,
    after: WindowsGitMetadataState,
) -> bool {
    before.volume_serial_number == after.volume_serial_number
        && before.file_index == after.file_index
}

#[cfg(any(windows, test))]
fn windows_git_metadata_file_state_matches(
    before: WindowsGitMetadataState,
    after: WindowsGitMetadataState,
) -> bool {
    windows_git_metadata_same_identity(before, after)
        && before.file_attributes == after.file_attributes
        && before.file_size == after.file_size
        && before.last_write_time == after.last_write_time
}

#[cfg(any(windows, test))]
fn windows_git_metadata_directory_state_matches(
    before: WindowsGitMetadataState,
    after: WindowsGitMetadataState,
) -> bool {
    windows_git_metadata_same_identity(before, after)
        && before.file_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
            == after.file_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
}

#[cfg(all(not(unix), not(windows)))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct OtherGitMetadataState {
    length: u64,
    modified: SystemTime,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsFileTime {
    low_date_time: u32,
    high_date_time: u32,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsByHandleFileInformation {
    file_attributes: u32,
    creation_time: WindowsFileTime,
    last_access_time: WindowsFileTime,
    last_write_time: WindowsFileTime,
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsUnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsObjectAttributes {
    length: u32,
    root_directory: *mut std::ffi::c_void,
    object_name: *mut WindowsUnicodeString,
    attributes: u32,
    security_descriptor: *mut std::ffi::c_void,
    security_quality_of_service: *mut std::ffi::c_void,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsIoStatusBlock {
    status: isize,
    information: usize,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetFileInformationByHandle(
        file: *mut std::ffi::c_void,
        information: *mut WindowsByHandleFileInformation,
    ) -> i32;
}

#[cfg(windows)]
#[link(name = "ntdll")]
extern "system" {
    fn NtCreateFile(
        file_handle: *mut *mut std::ffi::c_void,
        desired_access: u32,
        object_attributes: *mut WindowsObjectAttributes,
        io_status_block: *mut WindowsIoStatusBlock,
        allocation_size: *mut i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *mut std::ffi::c_void,
        ea_length: u32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

#[cfg(all(not(unix), not(windows)))]
fn other_git_metadata_state(
    metadata: &std::fs::Metadata,
    label: &str,
) -> Result<OtherGitMetadataState, String> {
    Ok(OtherGitMetadataState {
        length: metadata.len(),
        modified: metadata
            .modified()
            .map_err(|error| format!("inspect {label} modification time: {error}"))?,
    })
}

#[cfg(windows)]
fn windows_git_metadata_handle_state(
    file: &std::fs::File,
    label: &str,
) -> Result<WindowsGitMetadataState, String> {
    use std::os::windows::io::AsRawHandle;

    let mut information = std::mem::MaybeUninit::<WindowsByHandleFileInformation>::uninit();
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if succeeded == 0 {
        return Err(format!(
            "inspect open {label}: {}",
            std::io::Error::last_os_error()
        ));
    }
    let information = unsafe { information.assume_init() };
    Ok(WindowsGitMetadataState {
        volume_serial_number: information.volume_serial_number,
        file_index: (u64::from(information.file_index_high) << 32)
            | u64::from(information.file_index_low),
        file_attributes: information.file_attributes,
        file_size: (u64::from(information.file_size_high) << 32)
            | u64::from(information.file_size_low),
        last_write_time: (u64::from(information.last_write_time.high_date_time) << 32)
            | u64::from(information.last_write_time.low_date_time),
    })
}

#[cfg(any(test, windows))]
fn windows_git_metadata_child_share_mode() -> u32 {
    const FILE_SHARE_READ: u32 = 0x0001;
    const FILE_SHARE_DELETE: u32 = 0x0004;

    FILE_SHARE_READ | FILE_SHARE_DELETE
}

#[cfg(any(test, windows))]
fn windows_git_metadata_open_error(label: &str, error: u32) -> GitMetadataReadError {
    const ERROR_FILE_NOT_FOUND: u32 = 2;
    const ERROR_PATH_NOT_FOUND: u32 = 3;
    const ERROR_SHARING_VIOLATION: u32 = 32;

    if matches!(error, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
        GitMetadataReadError::NotFound
    } else if error == ERROR_SHARING_VIOLATION {
        format!("{label} changed while being read").into()
    } else {
        format!(
            "open {label}: {}",
            std::io::Error::from_raw_os_error(error as i32)
        )
        .into()
    }
}

#[cfg(windows)]
fn windows_open_directory_no_follow(path: &Path, label: &str) -> Result<std::fs::File, String> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_LIST_DIRECTORY: u32 = 0x0001;
    const FILE_TRAVERSE: u32 = 0x0020;
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const FILE_SHARE_READ: u32 = 0x0001;
    const FILE_SHARE_WRITE: u32 = 0x0002;
    const FILE_SHARE_DELETE: u32 = 0x0004;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .access_mode(FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    options
        .open(path)
        .map_err(|error| format!("open {label} '{}': {error}", path.display()))
}

#[cfg(windows)]
fn windows_open_relative_no_follow(
    directory: &std::fs::File,
    name: &str,
    label: &str,
) -> Result<std::fs::File, GitMetadataReadError> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle};

    const FILE_GENERIC_READ: u32 = 0x0012_0089;
    const FILE_OPEN: u32 = 0x0001;
    const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0020;
    const FILE_NON_DIRECTORY_FILE: u32 = 0x0040;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const OBJ_CASE_INSENSITIVE: u32 = 0x0040;

    let mut name = name.encode_utf16().collect::<Vec<_>>();
    if name.iter().any(|unit| *unit == 0) {
        return Err(format!("{label} has an invalid file name").into());
    }
    let byte_length = name
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| format!("{label} has an invalid file name"))?;
    let mut unicode_name = WindowsUnicodeString {
        length: byte_length,
        maximum_length: byte_length,
        buffer: name.as_mut_ptr(),
    };
    let mut object_attributes = WindowsObjectAttributes {
        length: u32::try_from(std::mem::size_of::<WindowsObjectAttributes>())
            .expect("Windows object attributes size fits u32"),
        root_directory: directory.as_raw_handle(),
        object_name: &mut unicode_name,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: std::ptr::null_mut(),
        security_quality_of_service: std::ptr::null_mut(),
    };
    let mut io_status = WindowsIoStatusBlock {
        status: 0,
        information: 0,
    };
    let mut handle = std::ptr::null_mut();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            FILE_GENERIC_READ,
            &mut object_attributes,
            &mut io_status,
            std::ptr::null_mut(),
            0,
            windows_git_metadata_child_share_mode(),
            FILE_OPEN,
            FILE_SYNCHRONOUS_IO_NONALERT | FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
            0,
        )
    };
    if status < 0 {
        let error = unsafe { RtlNtStatusToDosError(status) };
        return Err(windows_git_metadata_open_error(label, error));
    }
    if handle.is_null() {
        return Err(format!("open {label}: Windows returned an invalid handle").into());
    }
    Ok(unsafe { std::fs::File::from_raw_handle(handle) })
}

#[cfg(windows)]
fn windows_open_relative_directory_no_follow(
    directory: &std::fs::File,
    name: &str,
    label: &str,
) -> Result<std::fs::File, GitMetadataReadError> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle};

    const FILE_LIST_DIRECTORY: u32 = 0x0001;
    const FILE_TRAVERSE: u32 = 0x0020;
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const FILE_OPEN: u32 = 0x0001;
    const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0020;
    const FILE_DIRECTORY_FILE: u32 = 0x0001;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const OBJ_CASE_INSENSITIVE: u32 = 0x0040;

    let mut name = name.encode_utf16().collect::<Vec<_>>();
    if name.iter().any(|unit| *unit == 0) {
        return Err(format!("{label} has an invalid file name").into());
    }
    let byte_length = name
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| format!("{label} has an invalid file name"))?;
    let mut unicode_name = WindowsUnicodeString {
        length: byte_length,
        maximum_length: byte_length,
        buffer: name.as_mut_ptr(),
    };
    let mut object_attributes = WindowsObjectAttributes {
        length: u32::try_from(std::mem::size_of::<WindowsObjectAttributes>())
            .expect("Windows object attributes size fits u32"),
        root_directory: directory.as_raw_handle(),
        object_name: &mut unicode_name,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: std::ptr::null_mut(),
        security_quality_of_service: std::ptr::null_mut(),
    };
    let mut io_status = WindowsIoStatusBlock {
        status: 0,
        information: 0,
    };
    let mut handle = std::ptr::null_mut();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            &mut object_attributes,
            &mut io_status,
            std::ptr::null_mut(),
            0,
            windows_git_metadata_child_share_mode(),
            FILE_OPEN,
            FILE_SYNCHRONOUS_IO_NONALERT | FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
            0,
        )
    };
    if status < 0 {
        let error = unsafe { RtlNtStatusToDosError(status) };
        return Err(windows_git_metadata_open_error(label, error));
    }
    if handle.is_null() {
        return Err(format!("open {label}: Windows returned an invalid handle").into());
    }
    Ok(unsafe { std::fs::File::from_raw_handle(handle) })
}

#[derive(Debug, Eq, PartialEq)]
enum GitMetadataReadError {
    TooLarge,
    /// The child does not exist, determined the same way the read itself
    /// resolves the child (relative to the pinned directory handle, not a
    /// second, separately racy path lookup). Only meaningful for optional
    /// markers like `commondir`; required markers like `HEAD` still treat
    /// this as an error via [`Self::into_message`].
    NotFound,
    Other(String),
}

impl From<String> for GitMetadataReadError {
    fn from(error: String) -> Self {
        Self::Other(error)
    }
}

impl GitMetadataReadError {
    fn into_message(self, label: &str) -> String {
        match self {
            Self::TooLarge => format!("{label} is too large"),
            Self::NotFound => format!("{label} does not exist"),
            Self::Other(error) => error,
        }
    }
}

#[cfg(all(not(unix), not(windows)))]
fn read_bounded_git_metadata_file(
    path: &Path,
    label: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, GitMetadataReadError> {
    let before = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(GitMetadataReadError::NotFound);
        }
        Err(error) => return Err(format!("inspect {label}: {error}").into()),
    };
    if metadata_is_link_like(&before) || !before.is_file() {
        return Err(format!("{label} is not a regular file").into());
    }
    if before.len() > max_bytes {
        return Err(GitMetadataReadError::TooLarge);
    }
    let path_before_state = other_git_metadata_state(&before, label)?;

    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    let mut file = options
        .open(path)
        .map_err(|error| format!("open {label}: {error}"))?;
    let handle_before_metadata = file
        .metadata()
        .map_err(|error| format!("inspect open {label}: {error}"))?;
    if metadata_is_link_like(&handle_before_metadata) || !handle_before_metadata.is_file() {
        return Err(format!("{label} is not a regular file").into());
    }
    if handle_before_metadata.len() > max_bytes {
        return Err(GitMetadataReadError::TooLarge);
    }
    let handle_before_state = other_git_metadata_state(&handle_before_metadata, label)?;
    if path_before_state != handle_before_state {
        return Err(format!("{label} changed while being opened").into());
    }

    let read_limit = max_bytes
        .checked_add(1)
        .ok_or_else(|| format!("{label} byte limit is invalid"))?;
    let initial_capacity = usize::try_from(handle_before_metadata.len())
        .map_err(|_| GitMetadataReadError::TooLarge)?;
    let mut bytes = Vec::with_capacity(initial_capacity);
    std::io::Read::by_ref(&mut file)
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read {label}: {error}"))?;

    let handle_after_metadata = file
        .metadata()
        .map_err(|error| format!("inspect open {label} after reading: {error}"))?;
    if metadata_is_link_like(&handle_after_metadata) || !handle_after_metadata.is_file() {
        return Err(format!("{label} changed while being read").into());
    }
    let handle_after_state = other_git_metadata_state(&handle_after_metadata, label)?;
    if handle_before_state != handle_after_state {
        return Err(format!("{label} changed while being read").into());
    }
    let bytes_read = u64::try_from(bytes.len()).map_err(|_| GitMetadataReadError::TooLarge)?;
    if bytes_read > max_bytes {
        return Err(GitMetadataReadError::TooLarge);
    }

    let after = std::fs::symlink_metadata(path)
        .map_err(|error| format!("inspect {label} after reading: {error}"))?;
    if metadata_is_link_like(&after) || !after.is_file() {
        return Err(format!("{label} changed while being read").into());
    }
    let path_after_state = other_git_metadata_state(&after, label)?;
    if path_before_state != path_after_state || path_after_state != handle_after_state {
        return Err(format!("{label} changed while being read").into());
    }
    Ok(bytes)
}

fn validate_git_metadata_child_name(name: &str, label: &str) -> Result<(), String> {
    if name.is_empty() || Path::new(name).file_name().and_then(OsStr::to_str) != Some(name) {
        return Err(format!("{label} has an invalid file name"));
    }
    Ok(())
}

#[cfg(test)]
fn record_git_metadata_read_limit(max_bytes: u64) {
    TEST_GIT_METADATA_READ_LIMITS.with(|limits| limits.borrow_mut().push(max_bytes));
}

#[cfg(not(test))]
fn record_git_metadata_read_limit(_max_bytes: u64) {}

#[cfg(any(target_os = "macos", target_os = "ios"))]
unsafe fn git_directory_errno_location() -> *mut i32 {
    libc::__error()
}

#[cfg(any(target_os = "linux", target_os = "android"))]
unsafe fn git_directory_errno_location() -> *mut i32 {
    libc::__errno_location()
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "linux",
    target_os = "android"
)))]
unsafe fn git_directory_errno_location() -> *mut i32 {
    std::ptr::null_mut()
}

#[cfg(unix)]
fn clear_git_directory_errno() {
    unsafe {
        let errno = git_directory_errno_location();
        if !errno.is_null() {
            *errno = 0;
        }
    }
}

#[cfg(unix)]
fn git_directory_errno() -> Option<i32> {
    unsafe {
        let errno = git_directory_errno_location();
        (!errno.is_null()).then(|| *errno)
    }
}

#[cfg(unix)]
fn git_metadata_directory_entries(
    directory: &std::fs::File,
    label: &str,
) -> Result<Vec<std::ffi::OsString>, String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStringExt;

    let current = CString::new(".").expect("static directory name");
    let duplicate = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            current.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if duplicate < 0 {
        return Err(format!(
            "open {label} stream: {}",
            std::io::Error::last_os_error()
        ));
    }
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        let error = std::io::Error::last_os_error();
        unsafe {
            libc::close(duplicate);
        }
        return Err(format!("read {label}: {error}"));
    }
    let mut entries = Vec::new();
    let mut read_error = None;
    loop {
        clear_git_directory_errno();
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            if let Some(errno) = git_directory_errno().filter(|errno| *errno != 0) {
                read_error = Some(std::io::Error::from_raw_os_error(errno));
            }
            break;
        }
        let bytes = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        entries.push(std::ffi::OsString::from_vec(bytes.to_vec()));
    }
    let close_error = if unsafe { libc::closedir(stream) } != 0 {
        Some(std::io::Error::last_os_error())
    } else {
        None
    };
    if let Some(error) = read_error {
        return Err(format!("read {label}: {error}"));
    }
    if let Some(error) = close_error {
        return Err(format!("close {label} stream: {}", error));
    }
    Ok(entries)
}

#[cfg(not(unix))]
fn git_metadata_path_entries(path: &Path, label: &str) -> Result<Vec<std::ffi::OsString>, String> {
    std::fs::read_dir(path)
        .map_err(|error| format!("read {label}: {error}"))?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name())
                .map_err(|error| format!("read {label} entry: {error}"))
        })
        .collect()
}

#[cfg(unix)]
struct GitMetadataDirectory {
    path: PathBuf,
    directory: std::fs::File,
    state: FileState,
}

#[cfg(unix)]
impl GitMetadataDirectory {
    fn open(path: &Path, label: &str) -> Result<Self, String> {
        let directory = open_directory_no_follow(path, label)?;
        let state =
            file_state(&directory).map_err(|error| format!("inspect open {label}: {error}"))?;
        if state.mode & u32::from(libc::S_IFMT) != u32::from(libc::S_IFDIR) {
            return Err(format!("{label} is not a real directory"));
        }
        Ok(Self {
            path: path.to_path_buf(),
            directory,
            state,
        })
    }

    fn read_file(
        &self,
        name: &str,
        label: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>, GitMetadataReadError> {
        record_git_metadata_read_limit(max_bytes);
        validate_git_metadata_child_name(name, label)?;
        let name = CString::new(name).map_err(|_| format!("{label} has an invalid file name"))?;
        let fd = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(libc::ELOOP)) {
                return Err(format!("{label} is not a regular file").into());
            }
            if matches!(error.raw_os_error(), Some(libc::ENOENT)) {
                return Err(GitMetadataReadError::NotFound);
            }
            return Err(format!("open {label}: {error}").into());
        }
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        let before = file_state(&file).map_err(|error| format!("inspect open {label}: {error}"))?;
        if before.mode & u32::from(libc::S_IFMT) != u32::from(libc::S_IFREG) {
            return Err(format!("{label} is not a regular file").into());
        }
        if before.size > max_bytes {
            return Err(GitMetadataReadError::TooLarge);
        }

        let read_limit = max_bytes
            .checked_add(1)
            .ok_or_else(|| format!("{label} byte limit is invalid"))?;
        let initial_capacity =
            usize::try_from(before.size).map_err(|_| GitMetadataReadError::TooLarge)?;
        let mut bytes = Vec::with_capacity(initial_capacity);
        std::io::Read::by_ref(&mut file)
            .take(read_limit)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("read {label}: {error}"))?;

        let after = file_state(&file)
            .map_err(|error| format!("inspect open {label} after reading: {error}"))?;
        if before != after {
            return Err(format!("{label} changed while being read").into());
        }
        let bytes_read = u64::try_from(bytes.len()).map_err(|_| GitMetadataReadError::TooLarge)?;
        if bytes_read > max_bytes {
            return Err(GitMetadataReadError::TooLarge);
        }
        Ok(bytes)
    }

    fn open_directory(&self, name: &str, label: &str) -> Result<Self, GitMetadataReadError> {
        use std::os::fd::{AsRawFd, FromRawFd};

        validate_git_metadata_child_name(name, label)?;
        let child_name = name.to_string();
        let name = CString::new(name).map_err(|_| format!("{label} has an invalid file name"))?;
        let fd = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY
                    | libc::O_CLOEXEC
                    | libc::O_DIRECTORY
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(libc::ELOOP)) {
                return Err(format!("{label} is not a real directory").into());
            }
            if matches!(error.raw_os_error(), Some(libc::ENOENT)) {
                return Err(GitMetadataReadError::NotFound);
            }
            if matches!(error.raw_os_error(), Some(libc::ENOTDIR)) {
                return Err(format!("{label} is not a real directory").into());
            }
            return Err(format!("open {label}: {error}").into());
        }
        let directory = unsafe { std::fs::File::from_raw_fd(fd) };
        let state =
            file_state(&directory).map_err(|error| format!("inspect open {label}: {error}"))?;
        if state.mode & u32::from(libc::S_IFMT) != u32::from(libc::S_IFDIR) {
            return Err(format!("{label} is not a real directory").into());
        }
        Ok(Self {
            path: self.path.join(child_name),
            directory,
            state,
        })
    }

    fn list_entries(&self, label: &str) -> Result<Vec<std::ffi::OsString>, String> {
        git_metadata_directory_entries(&self.directory, label)
    }

    fn validate(&self, label: &str) -> Result<(), String> {
        let after = file_state(&self.directory)
            .map_err(|error| format!("inspect open {label} after reading: {error}"))?;
        if !same_identity(self.state, after)
            || after.mode & u32::from(libc::S_IFMT) != u32::from(libc::S_IFDIR)
        {
            return Err(format!("{label} changed while being read"));
        }
        Ok(())
    }

    fn validate_path_identity(&self, label: &str, action: &str) -> Result<(), String> {
        let reopened = Self::open(&self.path, label)
            .map_err(|error| format!("{label} changed {action}: {error}"))?;
        if !same_identity(self.state, reopened.state)
            || reopened.state.mode & u32::from(libc::S_IFMT) != u32::from(libc::S_IFDIR)
        {
            return Err(format!("{label} changed {action}"));
        }
        Ok(())
    }
}

#[cfg(windows)]
struct GitMetadataDirectory {
    path: PathBuf,
    directory: std::fs::File,
    state: WindowsGitMetadataState,
}

#[cfg(windows)]
impl GitMetadataDirectory {
    fn open(path: &Path, label: &str) -> Result<Self, String> {
        let directory = windows_open_directory_no_follow(path, label)?;
        let state = windows_git_metadata_handle_state(&directory, label)?;
        if state.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || state.file_attributes & FILE_ATTRIBUTE_DIRECTORY == 0
        {
            return Err(format!("{label} is not a real directory"));
        }
        Ok(Self {
            path: path.to_path_buf(),
            directory,
            state,
        })
    }

    fn read_file(
        &self,
        name: &str,
        label: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>, GitMetadataReadError> {
        record_git_metadata_read_limit(max_bytes);

        validate_git_metadata_child_name(name, label)?;
        let mut file = windows_open_relative_no_follow(&self.directory, name, label)?;
        let before = windows_git_metadata_handle_state(&file, label)?;
        if before.file_attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 {
            return Err(format!("{label} is not a regular file").into());
        }
        if before.file_size > max_bytes {
            return Err(GitMetadataReadError::TooLarge);
        }

        let read_limit = max_bytes
            .checked_add(1)
            .ok_or_else(|| format!("{label} byte limit is invalid"))?;
        let initial_capacity =
            usize::try_from(before.file_size).map_err(|_| GitMetadataReadError::TooLarge)?;
        let mut bytes = Vec::with_capacity(initial_capacity);
        std::io::Read::by_ref(&mut file)
            .take(read_limit)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("read {label}: {error}"))?;

        let after = windows_git_metadata_handle_state(&file, label)?;
        if !windows_git_metadata_file_state_matches(before, after)
            || after.file_attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)
                != 0
        {
            return Err(format!("{label} changed while being read").into());
        }
        let bytes_read = u64::try_from(bytes.len()).map_err(|_| GitMetadataReadError::TooLarge)?;
        if bytes_read > max_bytes {
            return Err(GitMetadataReadError::TooLarge);
        }
        Ok(bytes)
    }

    fn open_directory(&self, name: &str, label: &str) -> Result<Self, GitMetadataReadError> {
        validate_git_metadata_child_name(name, label)?;
        let directory = windows_open_relative_directory_no_follow(&self.directory, name, label)?;
        let state = windows_git_metadata_handle_state(&directory, label)?;
        if state.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || state.file_attributes & FILE_ATTRIBUTE_DIRECTORY == 0
        {
            return Err(format!("{label} is not a real directory").into());
        }
        Ok(Self {
            path: self.path.join(name),
            directory,
            state,
        })
    }

    fn list_entries(&self, label: &str) -> Result<Vec<std::ffi::OsString>, String> {
        git_metadata_path_entries(&self.path, label)
    }

    fn validate(&self, label: &str) -> Result<(), String> {
        let after = windows_git_metadata_handle_state(&self.directory, label)?;
        if !windows_git_metadata_directory_state_matches(self.state, after)
            || after.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || after.file_attributes & FILE_ATTRIBUTE_DIRECTORY == 0
        {
            return Err(format!("{label} changed while being read"));
        }
        Ok(())
    }

    fn validate_path_identity(&self, label: &str, action: &str) -> Result<(), String> {
        let reopened = Self::open(&self.path, label)
            .map_err(|error| format!("{label} changed {action}: {error}"))?;
        if !windows_git_metadata_directory_state_matches(self.state, reopened.state) {
            return Err(format!("{label} changed {action}"));
        }
        Ok(())
    }
}

#[cfg(all(not(unix), not(windows)))]
struct GitMetadataDirectory {
    path: PathBuf,
    state: OtherGitMetadataState,
}

#[cfg(all(not(unix), not(windows)))]
impl GitMetadataDirectory {
    fn open(path: &Path, label: &str) -> Result<Self, String> {
        let metadata =
            std::fs::symlink_metadata(path).map_err(|error| format!("inspect {label}: {error}"))?;
        if metadata_is_link_like(&metadata) || !metadata.is_dir() {
            return Err(format!("{label} is not a real directory"));
        }
        let state = other_git_metadata_state(&metadata, label)?;
        Ok(Self {
            path: path.to_path_buf(),
            state,
        })
    }

    fn read_file(
        &self,
        name: &str,
        label: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>, GitMetadataReadError> {
        record_git_metadata_read_limit(max_bytes);
        validate_git_metadata_child_name(name, label)?;
        read_bounded_git_metadata_file(&self.path.join(name), label, max_bytes)
    }

    fn validate(&self, label: &str) -> Result<(), String> {
        let metadata = std::fs::symlink_metadata(&self.path)
            .map_err(|error| format!("inspect {label} after reading: {error}"))?;
        if metadata_is_link_like(&metadata) || !metadata.is_dir() {
            return Err(format!("{label} changed while being read"));
        }
        let after = other_git_metadata_state(&metadata, label)?;
        if self.state != after {
            return Err(format!("{label} changed while being read"));
        }
        Ok(())
    }

    fn open_directory(&self, name: &str, label: &str) -> Result<Self, GitMetadataReadError> {
        validate_git_metadata_child_name(name, label)?;
        let path = self.path.join(name);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(GitMetadataReadError::NotFound);
            }
            Err(error) => return Err(format!("inspect {label}: {error}").into()),
        };
        if metadata_is_link_like(&metadata) || !metadata.is_dir() {
            return Err(format!("{label} is not a real directory").into());
        }
        let state = other_git_metadata_state(&metadata, label)?;
        Ok(Self { path, state })
    }

    fn list_entries(&self, label: &str) -> Result<Vec<std::ffi::OsString>, String> {
        git_metadata_path_entries(&self.path, label)
    }

    fn validate_path_identity(&self, label: &str, action: &str) -> Result<(), String> {
        let reopened = Self::open(&self.path, label)
            .map_err(|error| format!("{label} changed {action}: {error}"))?;
        if self.state != reopened.state {
            return Err(format!("{label} changed {action}"));
        }
        Ok(())
    }
}

fn open_git_info_directory(
    git_dir: &GitMetadataDirectory,
) -> Result<Option<GitMetadataDirectory>, String> {
    match git_dir.open_directory("info", "Git info directory") {
        Ok(directory) => Ok(Some(directory)),
        Err(GitMetadataReadError::NotFound) => Ok(None),
        Err(error) => Err(error.into_message("Git info directory")),
    }
}

fn read_git_info_file_from_handle(
    git_dir: &GitMetadataDirectory,
    name: &str,
) -> Result<Option<Vec<u8>>, String> {
    let Some(info_dir) = open_git_info_directory(git_dir)? else {
        return Ok(None);
    };
    read_optional_git_metadata_file(
        &info_dir,
        name,
        &format!("Git info/{name}"),
        MAX_GIT_INFO_FILE_BYTES,
    )
}

#[cfg(test)]
fn read_git_info_file(git_dir: &Path, name: &str) -> Result<Option<Vec<u8>>, String> {
    let git_dir = GitMetadataDirectory::open(git_dir, "Git directory")?;
    read_git_info_file_from_handle(&git_dir, name)
}

fn snapshot_git_info_file(
    source_git_dir: &GitMetadataDirectory,
    destination: &Path,
    name: &str,
) -> Result<(), String> {
    let Some(bytes) = read_git_info_file_from_handle(source_git_dir, name)? else {
        return Ok(());
    };
    let info_dir = destination.join("info");
    std::fs::create_dir_all(&info_dir)
        .map_err(|e| format!("create isolated Git info directory: {e}"))?;
    std::fs::write(info_dir.join(name), bytes).map_err(|e| format!("snapshot Git info/{name}: {e}"))
}

fn snapshot_trusted_git_info(
    source_git_dir: &GitMetadataDirectory,
    destination: &Path,
) -> Result<(), String> {
    snapshot_trusted_git_info_with_hook(source_git_dir, destination, || ())
}

fn snapshot_trusted_git_info_with_hook<F, G>(
    source_git_dir: &GitMetadataDirectory,
    destination: &Path,
    after_common_dir_open: F,
) -> Result<(), String>
where
    F: FnOnce() -> G,
{
    let _hook_guard = after_common_dir_open();
    snapshot_git_info_file(source_git_dir, destination, "attributes")?;
    snapshot_git_info_file(source_git_dir, destination, "exclude")
}

fn resolve_git_ref(refs: &HashMap<String, GitRefValue>, name: &str) -> Option<String> {
    let mut current = name;
    let mut remaining = refs.len().saturating_add(1);
    while remaining > 0 {
        match refs.get(current)? {
            GitRefValue::Direct(oid) => return Some(oid.clone()),
            GitRefValue::Symbolic(target) => current = target,
        }
        remaining -= 1;
    }
    None
}

fn is_valid_git_reftable_table_name(name: &str) -> bool {
    fn is_windows_device_alias(stem: &str) -> bool {
        let stem = stem.trim_end_matches(|character| character == ' ' || character == '.');
        if ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"]
            .iter()
            .any(|alias| stem.eq_ignore_ascii_case(alias))
        {
            return true;
        }

        let bytes = stem.as_bytes();
        let Some(prefix) = bytes.get(..3) else {
            return false;
        };
        if !prefix.eq_ignore_ascii_case(b"COM") && !prefix.eq_ignore_ascii_case(b"LPT") {
            return false;
        }

        matches!(
            &stem[3..],
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
        )
    }

    if name.ends_with([' ', '.'])
        || name.chars().any(|character| {
            character.is_ascii_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return false;
    }

    let Some(stem) = name
        .strip_suffix(".ref")
        .or_else(|| name.strip_suffix(".log"))
    else {
        return false;
    };

    !stem.is_empty() && !is_windows_device_alias(name.split('.').next().unwrap_or_default())
}

fn snapshot_git_reftable_with_limits_and_hook<F, G>(
    source: &Path,
    destination: &Path,
    limits: GitReftableSnapshotLimits,
    after_directory_open: F,
) -> Result<(), String>
where
    F: FnOnce() -> G,
{
    let directory = GitMetadataDirectory::open(source, "Git reftable directory")?;
    let hook_guard = after_directory_open();

    let list_label = "Git reftable table list";
    let list_bytes = directory
        .read_file("tables.list", list_label, limits.list_bytes)
        .map_err(|error| error.into_message(list_label))?;
    let tables = std::str::from_utf8(&list_bytes)
        .map_err(|_| "Git reftable table list is not UTF-8".to_string())?;
    let mut names = Vec::new();
    for table in tables.lines().filter(|table| !table.is_empty()) {
        if names.len() >= limits.tables {
            return Err("Git reftable table list contains too many tables".to_string());
        }
        if Path::new(table).file_name().and_then(OsStr::to_str) != Some(table) {
            return Err("Git reftable table list contains an invalid path".to_string());
        }
        if !is_valid_git_reftable_table_name(table) {
            return Err("Git reftable table list contains an invalid table name".to_string());
        }
        names.push(table);
    }

    let mut snapshots = Vec::with_capacity(names.len());
    let mut total_bytes = 0_u64;
    for table in names {
        let remaining_bytes = limits
            .total_bytes
            .checked_sub(total_bytes)
            .ok_or_else(|| "Git reftable aggregate size is too large".to_string())?;
        let read_limit = limits.table_bytes.min(remaining_bytes);
        let aggregate_limited = remaining_bytes < limits.table_bytes;
        let label = format!("Git reftable table {table}");
        let bytes = match directory.read_file(table, &label, read_limit) {
            Ok(bytes) => bytes,
            Err(GitMetadataReadError::TooLarge) if aggregate_limited => {
                return Err("Git reftable aggregate size is too large".to_string());
            }
            Err(error) => return Err(error.into_message(&label)),
        };
        let table_bytes = u64::try_from(bytes.len())
            .map_err(|_| "Git reftable aggregate size overflowed".to_string())?;
        total_bytes = total_bytes
            .checked_add(table_bytes)
            .ok_or_else(|| "Git reftable aggregate size overflowed".to_string())?;
        if total_bytes > limits.total_bytes {
            return Err("Git reftable aggregate size is too large".to_string());
        }
        snapshots.push((table.to_string(), bytes));
    }

    drop(hook_guard);
    directory.validate("Git reftable directory")?;

    std::fs::create_dir_all(destination)
        .map_err(|error| format!("create isolated Git reftable directory: {error}"))?;
    for (table, bytes) in snapshots {
        std::fs::write(destination.join(&table), bytes)
            .map_err(|error| format!("snapshot Git reftable table {table}: {error}"))?;
    }
    std::fs::write(destination.join("tables.list"), list_bytes)
        .map_err(|error| format!("snapshot Git reftable table list: {error}"))
}

fn snapshot_git_reftable_with_limits(
    source: &Path,
    destination: &Path,
    limits: GitReftableSnapshotLimits,
) -> Result<(), String> {
    snapshot_git_reftable_with_limits_and_hook(source, destination, limits, || ())
}

fn snapshot_git_reftable(source: &Path, destination: &Path) -> Result<(), String> {
    snapshot_git_reftable_with_limits(source, destination, GIT_REFTABLE_SNAPSHOT_LIMITS)
}

fn snapshot_git_index(
    git_dir: &GitMetadataDirectory,
    destination_git_dir: &Path,
) -> Result<(), String> {
    let Some(bytes) =
        read_optional_git_metadata_file(git_dir, "index", "Git index", MAX_GIT_INDEX_BYTES)?
    else {
        return Ok(());
    };
    std::fs::write(destination_git_dir.join("index"), bytes)
        .map_err(|error| format!("snapshot Git index: {error}"))
}

struct GitAlternatesHandoff {}

const MAX_GIT_OBJECT_FILE_BYTES: u64 = 1024 * 1024 * 1024;

fn snapshot_git_objects(
    objects_directory: &GitMetadataDirectory,
    destination_git_dir: &Path,
) -> Result<(), String> {
    let mut visited = std::collections::HashSet::new();
    snapshot_git_objects_from_directory(
        objects_directory,
        &destination_git_dir.join("objects"),
        &mut visited,
    )
}

fn snapshot_git_objects_from_directory(
    objects_directory: &GitMetadataDirectory,
    destination_objects_dir: &Path,
    visited: &mut std::collections::HashSet<PathBuf>,
) -> Result<(), String> {
    if !visited.insert(objects_directory.path.clone()) {
        return Ok(());
    }
    std::fs::create_dir_all(destination_objects_dir)
        .map_err(|error| format!("create isolated Git objects directory: {error}"))?;
    copy_git_objects_directory_tree(
        objects_directory,
        destination_objects_dir,
        "Git objects directory",
    )?;
    snapshot_git_alternate_object_directories(objects_directory, destination_objects_dir, visited)
}

fn copy_git_objects_directory_tree(
    source_directory: &GitMetadataDirectory,
    destination_directory: &Path,
    label: &str,
) -> Result<(), String> {
    for entry in source_directory.list_entries(label)? {
        let name = entry
            .to_str()
            .ok_or_else(|| format!("{label} contains a non-utf8 entry name"))?;
        if name == "alternates"
            && source_directory
                .path
                .file_name()
                .and_then(std::ffi::OsStr::to_str)
                == Some("info")
        {
            continue;
        }
        let child_label = format!("{label} entry {name}");
        match source_directory.open_directory(name, &child_label) {
            Ok(child_directory) => {
                let child_destination = destination_directory.join(name);
                std::fs::create_dir_all(&child_destination)
                    .map_err(|error| format!("create isolated {child_label}: {error}"))?;
                copy_git_objects_directory_tree(
                    &child_directory,
                    &child_destination,
                    &child_label,
                )?;
                child_directory.validate(&child_label)?;
            }
            Err(GitMetadataReadError::NotFound) => {
                return Err(format!("{child_label} disappeared while being read"));
            }
            Err(_) => {
                let bytes = source_directory
                    .read_file(name, &child_label, MAX_GIT_OBJECT_FILE_BYTES)
                    .map_err(|error| error.into_message(&child_label))?;
                std::fs::write(destination_directory.join(name), bytes)
                    .map_err(|error| format!("write isolated {child_label}: {error}"))?;
            }
        }
    }
    source_directory.validate(label)
}

fn snapshot_git_alternate_object_directories(
    objects_directory: &GitMetadataDirectory,
    destination_objects_dir: &Path,
    visited: &mut std::collections::HashSet<PathBuf>,
) -> Result<(), String> {
    let info_directory =
        match objects_directory.open_directory("info", "Git objects info directory") {
            Ok(directory) => directory,
            Err(GitMetadataReadError::NotFound) => return Ok(()),
            Err(error) => return Err(error.into_message("Git objects info directory")),
        };
    let alternates = match info_directory.read_file(
        "alternates",
        "Git alternates file",
        MAX_GIT_INFO_FILE_BYTES,
    ) {
        Ok(bytes) => bytes,
        Err(GitMetadataReadError::NotFound) => return Ok(()),
        Err(error) => return Err(error.into_message("Git alternates file")),
    };
    let alternates = String::from_utf8(alternates)
        .map_err(|_| "Git alternates file is not valid utf-8".to_string())?;
    for alternate in alternates
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        let alternate_path = Path::new(alternate);
        let alternate_path = if alternate_path.is_absolute() {
            normalize_git_metadata_path(alternate_path)
        } else {
            normalize_git_metadata_path(&objects_directory.path.join(alternate_path))
        };
        let alternate_directory =
            GitMetadataDirectory::open(&alternate_path, "Git alternate objects directory")?;
        snapshot_git_objects_from_directory(
            &alternate_directory,
            destination_objects_dir,
            visited,
        )?;
    }
    info_directory.validate("Git objects info directory")?;
    Ok(())
}

fn isolated_git_metadata_command(root: &str, git_dir: &Path) -> std::process::Command {
    let mut command = git_command(root);
    command
        .env("GIT_DIR", git_dir)
        .env("GIT_OBJECT_DIRECTORY", git_dir.join("objects"))
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_CONFIG_SYSTEM", git_dir.join("empty-config"))
        .env("GIT_CONFIG_GLOBAL", git_dir.join("empty-config"))
        .env_remove("GIT_CONFIG_NOSYSTEM");
    command
}

fn resolve_isolated_git_attribute_source_with_hook<F>(
    root: &str,
    git_dir: &Path,
    before_spawn: &mut F,
) -> Result<Option<String>, String>
where
    F: FnMut(),
{
    let mut command = isolated_git_metadata_command(root, git_dir);
    before_spawn();
    let output = command
        .args(["rev-parse", "--verify", "HEAD"])
        .output()
        .map_err(|e| format!("resolve isolated Git attribute source: {e}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let source = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if source.is_empty() {
        Ok(None)
    } else {
        Ok(Some(source))
    }
}

fn create_empty_git_attribute_source_with_hook<F>(
    root: &str,
    git_dir: &Path,
    before_spawn: &mut F,
) -> Result<String, String>
where
    F: FnMut(),
{
    let mut command = isolated_git_metadata_command(root, git_dir);
    before_spawn();
    let mut child = command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .args(["hash-object", "-t", "tree", "-w", "--stdin"])
        .spawn()
        .map_err(|e| format!("create empty Git attribute tree: {e}"))?;
    drop(child.stdin.take());
    let output = child
        .wait_with_output()
        .map_err(|e| format!("create empty Git attribute tree: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "create empty Git attribute tree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn is_null_git_oid(value: &str, object_format: Option<&str>) -> bool {
    value.len() == git_oid_hex_len(object_format) && value.bytes().all(|byte| byte == b'0')
}

fn snapshotted_git_attribute_source(
    actual_head: &str,
    refs: &HashMap<String, GitRefValue>,
    object_format: Option<&str>,
) -> Option<String> {
    let head = actual_head.trim();
    if let Some(name) = head.strip_prefix("ref: ") {
        return resolve_git_ref(refs, name).filter(|oid| !is_null_git_oid(oid, object_format));
    }
    (!head.is_empty() && !is_null_git_oid(head, object_format)).then(|| head.to_string())
}

fn validate_git_ref_storage(
    ref_storage: &str,
    detected_format: Result<String, String>,
) -> Result<(), String> {
    match ref_storage {
        "files" => Ok(()),
        "reftable" => match detected_format {
            Ok(format) if format.trim() == "reftable" => Ok(()),
            Ok(format) => Err(format!(
                "installed Git does not support reftable ref storage: reported {}",
                format.trim()
            )),
            Err(error) => Err(format!(
                "installed Git does not support reftable ref storage: {error}"
            )),
        },
        _ => Err(format!("unsupported Git ref storage: {ref_storage}")),
    }
}

fn normalize_git_line_ending_config(key: &str, value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    let normalized = match key {
        "core.autocrlf" => match value.as_str() {
            "" | "true" | "yes" | "on" | "1" => "true",
            "false" | "no" | "off" | "0" => "false",
            "input" => "input",
            _ => return Err("git config core.autocrlf has an invalid value".to_string()),
        },
        "core.eol" => match value.as_str() {
            "lf" => "lf",
            "crlf" => "crlf",
            "native" => "native",
            _ => return Err("git config core.eol has an invalid value".to_string()),
        },
        "core.safecrlf" => match value.as_str() {
            "" | "true" | "yes" | "on" | "1" => "true",
            "false" | "no" | "off" | "0" => "false",
            "warn" => "warn",
            _ => return Err("git config core.safecrlf has an invalid value".to_string()),
        },
        _ => return Err("unsupported Git line-ending config key".to_string()),
    };
    Ok(normalized.to_string())
}

fn git_inspection_line_ending_config(root: &str) -> Result<Vec<(String, String)>, String> {
    const LINE_ENDING_CONFIG_PATTERN: &str = r"^core\.(autocrlf|eol|safecrlf)$";
    let out = git_metadata_output(
        root,
        &[
            "config",
            "--includes",
            "--null",
            "--get-regexp",
            LINE_ENDING_CONFIG_PATTERN,
        ],
    )?;
    if !out.status.success() {
        if out.status.code() == Some(1) {
            return Ok(Vec::new());
        }
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let mut values = HashMap::new();
    for record in out
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let separator = record
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(|| "git config query returned malformed output".to_string())?;
        let key = std::str::from_utf8(&record[..separator])
            .map_err(|_| "git config query returned invalid UTF-8 keys".to_string())?
            .to_ascii_lowercase();
        let value = std::str::from_utf8(&record[separator + 1..])
            .map_err(|_| format!("git config {key} returned invalid UTF-8"))?;
        values.insert(key.clone(), normalize_git_line_ending_config(&key, value)?);
    }
    Ok(values.into_iter().collect())
}

fn git_inspection_config_is_multi_valued(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.starts_with("remote.") && (key.ends_with(".url") || key.ends_with(".fetch"))
}

fn git_inspection_repository_config(root: &str) -> Result<Vec<(String, String)>, String> {
    const SAFE_CONFIG_PATTERN: &str = r"^(core\.(repositoryformatversion|filemode|ignorecase|symlinks|precomposeunicode)|extensions\.(objectformat|refstorage)|branch\..*\.(remote|merge)|remote\..*\.(url|fetch))$";
    let mut scalar_values = HashMap::new();
    let mut multi_values = Vec::new();
    let mut scopes = vec!["--local"];
    if git_worktree_config_enabled(root)? {
        scopes.push("--worktree");
    }
    for scope in scopes {
        let out = git_metadata_output(
            root,
            &[
                "config",
                scope,
                "--includes",
                "--null",
                "--get-regexp",
                SAFE_CONFIG_PATTERN,
            ],
        )?;
        if !out.status.success() {
            if out.status.code() == Some(1) {
                continue;
            }
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        for record in out
            .stdout
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty())
        {
            let separator = record
                .iter()
                .position(|byte| *byte == b'\n')
                .ok_or_else(|| "git config query returned malformed output".to_string())?;
            let key = std::str::from_utf8(&record[..separator])
                .map_err(|_| "git config query returned invalid UTF-8 keys".to_string())?
                .to_string();
            let value = std::str::from_utf8(&record[separator + 1..])
                .map_err(|_| format!("git config {key} returned invalid UTF-8"))?
                .to_string();
            if git_inspection_config_is_multi_valued(&key) {
                multi_values.push((key, value));
            } else {
                scalar_values.insert(key, value);
            }
        }
    }
    // Preserve only validated, non-executable EOL conversion semantics from
    // the complete effective config. safecrlf travels with autocrlf/eol
    // because it governs diagnostics for the same irreversible conversions.
    // Encoding conversion policy remains outside this deliberately narrow
    // contract.
    for (key, value) in git_inspection_line_ending_config(root)? {
        scalar_values.insert(key, value);
    }
    let mut values = scalar_values.into_iter().collect::<Vec<_>>();
    values.extend(multi_values);
    Ok(values)
}

struct GitInspectionRepository {
    git_dir: tempfile::TempDir,
    work_tree: Option<PathBuf>,
    index: Option<PathBuf>,
    attribute_source: Option<String>,
    config: Vec<(String, String)>,
}

impl GitInspectionRepository {
    fn snapshot(
        root: &str,
        head_override: Option<&str>,
        config: Vec<(String, String)>,
    ) -> Result<Self, String> {
        Self::snapshot_with_handoff_hook(root, head_override, config, &mut || {})
    }

    fn snapshot_with_handoff_hook<F>(
        root: &str,
        head_override: Option<&str>,
        config: Vec<(String, String)>,
        before_git_spawn: &mut F,
    ) -> Result<Self, String>
    where
        F: FnMut(),
    {
        let (work_tree, actual_git_dir) = git_repository_paths(Path::new(root))?;
        // Pin the Git directory's identity with a no-follow handle at the
        // point it is resolved, and thread that handle through every read
        // this snapshot takes from inside it (commondir, HEAD), rather than
        // re-deriving and trusting plain paths a second time. This closes
        // the same TOCTOU window `git_dir_for_worktree` already defends
        // against for the `.git` marker: a hostile repository swapping its
        // Git directory, or a file inside it, for a symlink between
        // resolution and these reads must not redirect them.
        let git_dir_handle = GitMetadataDirectory::open(&actual_git_dir, "Git directory")?;
        let common_dir = git_common_dir_pinned(&git_dir_handle, &actual_git_dir)?;
        let common_dir_handle = GitMetadataDirectory::open(&common_dir, "Git common directory")?;
        let common_objects_handle = common_dir_handle
            .open_directory("objects", "Git objects directory")
            .map_err(|error| error.into_message("Git objects directory"))?;
        let ref_storage = config
            .iter()
            .find_map(|(key, value)| (key == "extensions.refstorage").then_some(value.as_str()))
            .unwrap_or("files");
        let detected_format = if ref_storage == "reftable" {
            run_git_metadata(root, &["rev-parse", "--show-ref-format"])
        } else {
            Ok(String::new())
        };
        validate_git_ref_storage(ref_storage, detected_format)?;
        let object_format = config
            .iter()
            .find_map(|(key, value)| (key == "extensions.objectformat").then_some(value));
        if object_format.is_some_and(|value| !matches!(value.as_str(), "sha1" | "sha256")) {
            return Err("unsupported Git object format".to_string());
        }
        let refs = if ref_storage == "files" {
            snapshot_git_refs(&common_dir_handle, object_format.map(String::as_str))?
        } else {
            HashMap::new()
        };
        let head_label = "Git HEAD";
        let actual_head = String::from_utf8(
            git_dir_handle
                .read_file("HEAD", head_label, MAX_GIT_HEAD_BYTES)
                .map_err(|error| error.into_message(head_label))?,
        )
        .map_err(|_| format!("{head_label} is not valid UTF-8"))?;
        git_dir_handle.validate("Git directory")?;
        let expected_head = head_override
            .filter(|head| {
                !head.is_empty() && !is_null_git_oid(head, object_format.map(String::as_str))
            })
            .map(str::to_string);
        let mut attribute_source = match (
            expected_head.as_deref(),
            snapshotted_git_attribute_source(
                &actual_head,
                &refs,
                object_format.map(String::as_str),
            ),
        ) {
            (Some(expected), Some(actual)) if expected == actual => Some(expected.to_string()),
            (_, actual) => actual,
        };

        let git_dir = tempfile::Builder::new()
            .prefix("psyche-git-inspection-")
            .tempdir()
            .map_err(|e| format!("create isolated Git inspection directory: {e}"))?;
        std::fs::create_dir_all(git_dir.path().join("objects"))
            .map_err(|e| format!("create isolated Git object directory: {e}"))?;
        std::fs::create_dir_all(git_dir.path().join("objects/info"))
            .map_err(|e| format!("create isolated Git object info directory: {e}"))?;
        let index = work_tree.as_ref().map(|_| git_dir.path().join("index"));
        if work_tree.is_some() {
            snapshot_git_index(&git_dir_handle, git_dir.path())?;
        }
        std::fs::create_dir_all(git_dir.path().join("refs"))
            .map_err(|e| format!("create isolated Git refs directory: {e}"))?;
        let repository_format_version = config
            .iter()
            .find_map(|(key, value)| (key == "core.repositoryformatversion").then_some(value))
            .map(String::as_str)
            .unwrap_or("0");
        if !matches!(repository_format_version, "0" | "1") {
            return Err("unsupported Git repository format version".to_string());
        }
        let mut isolated_config = format!(
            "[core]\n\trepositoryformatversion = {repository_format_version}\n\tbare = {}\n\tfsmonitor = false\n",
            if work_tree.is_some() { "false" } else { "true" }
        );
        if let Some(object_format) = object_format {
            isolated_config.push_str(&format!("[extensions]\n\tobjectformat = {object_format}\n"));
        }
        if ref_storage == "reftable" {
            isolated_config.push_str("[extensions]\n\trefStorage = reftable\n");
        }
        std::fs::write(git_dir.path().join("config"), isolated_config)
            .map_err(|e| format!("write isolated Git config: {e}"))?;
        std::fs::write(git_dir.path().join("empty-config"), "")
            .map_err(|e| format!("write isolated empty Git config: {e}"))?;
        snapshot_trusted_git_info(&common_dir_handle, git_dir.path())?;
        std::fs::write(git_dir.path().join("HEAD"), actual_head)
            .map_err(|e| format!("write isolated Git HEAD: {e}"))?;
        snapshot_git_shallow(
            &common_dir_handle,
            git_dir.path(),
            object_format.map(String::as_str),
        )?;
        snapshot_git_objects(&common_objects_handle, git_dir.path())?;
        if ref_storage == "reftable" {
            snapshot_git_reftable(
                &common_dir.join("reftable"),
                &git_dir.path().join("reftable"),
            )?;
        } else {
            let mut packed_refs = Vec::new();
            for (name, value) in refs {
                match value {
                    GitRefValue::Direct(oid) => packed_refs.push((name, oid)),
                    GitRefValue::Symbolic(target) => {
                        let destination = git_dir.path().join(&name);
                        if let Some(parent) = destination.parent() {
                            std::fs::create_dir_all(parent)
                                .map_err(|e| format!("create isolated Git ref directory: {e}"))?;
                        }
                        std::fs::write(destination, format!("ref: {target}\n"))
                            .map_err(|e| format!("snapshot symbolic Git ref {name}: {e}"))?;
                    }
                }
            }
            packed_refs.sort_by(|left, right| left.0.cmp(&right.0));
            std::fs::write(
                git_dir.path().join("packed-refs"),
                format!(
                    "# pack-refs with: fully-peeled sorted\n{}",
                    packed_refs
                        .into_iter()
                        .map(|(name, oid)| format!("{oid} {name}\n"))
                        .collect::<String>()
                ),
            )
            .map_err(|e| format!("snapshot Git refs: {e}"))?;
        }
        if attribute_source.is_none() {
            attribute_source = resolve_isolated_git_attribute_source_with_hook(
                root,
                git_dir.path(),
                before_git_spawn,
            )?;
        }
        if attribute_source.is_none() {
            attribute_source = Some(create_empty_git_attribute_source_with_hook(
                root,
                git_dir.path(),
                before_git_spawn,
            )?);
        }

        Ok(Self {
            git_dir,
            work_tree,
            index,
            attribute_source,
            config,
        })
    }

    fn prepare_subprocess_handoff(&self) -> Result<GitAlternatesHandoff, String> {
        Ok(GitAlternatesHandoff {})
    }
}

struct GitInspectionPolicy {
    filter_drivers: Vec<GitFilterDriverOverride>,
}

impl GitInspectionPolicy {
    fn new(root: &str) -> Result<Self, String> {
        Ok(Self {
            // Inspection replays only trusted system/global filter commands.
            // Repository-local/worktree config is snapshotted separately and
            // never gets to shadow those inherited filter fallbacks by name.
            filter_drivers: git_trusted_filter_driver_overrides(root)?,
        })
    }
}

struct GitInspection<'a> {
    root: &'a str,
    policy: Arc<GitInspectionPolicy>,
    repository: GitInspectionRepository,
}

impl<'a> GitInspection<'a> {
    fn new(root: &'a str) -> Result<Self, String> {
        let config = git_inspection_repository_config(root)?;
        Self::with_policy_and_snapshot(
            root,
            Arc::new(GitInspectionPolicy::new(root)?),
            None,
            config,
        )
    }

    fn with_policy(
        root: &'a str,
        policy: Arc<GitInspectionPolicy>,
        head: Option<&str>,
    ) -> Result<Self, String> {
        let config = git_inspection_repository_config(root)?;
        Self::with_policy_and_snapshot(root, policy, head, config)
    }

    fn with_policy_and_snapshot(
        root: &'a str,
        policy: Arc<GitInspectionPolicy>,
        head: Option<&str>,
        config: Vec<(String, String)>,
    ) -> Result<Self, String> {
        Ok(Self {
            root,
            policy,
            repository: GitInspectionRepository::snapshot(root, head, config)?,
        })
    }

    fn git_command_with_config(&self, extra_config: &[(String, String)]) -> std::process::Command {
        let mut command = git_command(self.root);
        command
            .env("GIT_DIR", self.repository.git_dir.path())
            .env(
                "GIT_OBJECT_DIRECTORY",
                self.repository.git_dir.path().join("objects"),
            )
            .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_SYSTEM",
                self.repository.git_dir.path().join("empty-config"),
            )
            .env(
                "GIT_CONFIG_GLOBAL",
                self.repository.git_dir.path().join("empty-config"),
            )
            .env_remove("GIT_CONFIG_NOSYSTEM");
        if let Some(work_tree) = &self.repository.work_tree {
            command.env("GIT_WORK_TREE", git_subprocess_root(work_tree).as_ref());
        } else {
            command.env_remove("GIT_WORK_TREE");
        }
        if let Some(index) = &self.repository.index {
            command.env("GIT_INDEX_FILE", git_subprocess_root(index).as_ref());
        } else {
            command.env_remove("GIT_INDEX_FILE");
        }
        // Preserve gitlink commit/index reporting without launching Git inside
        // populated submodules, whose repository config is not isolated here.
        command.arg("-c").arg("diff.ignoreSubmodules=dirty");
        if let Some(source) = &self.repository.attribute_source {
            command.env("GIT_ATTR_SOURCE", source);
        } else {
            command.env_remove("GIT_ATTR_SOURCE");
        }
        for (key, value) in &self.repository.config {
            command.arg("-c").arg(format!("{key}={value}"));
        }
        for (key, value) in extra_config {
            command.arg("-c").arg(format!("{key}={value}"));
        }
        for driver in &self.policy.filter_drivers {
            let has_trusted_command = driver.clean.is_some() || driver.process.is_some();
            let required = if has_trusted_command && driver.required.unwrap_or(false) {
                "true"
            } else {
                "false"
            };
            if let Some(clean) = &driver.clean {
                command
                    .arg("-c")
                    .arg(format!("filter.{}.clean={clean}", driver.driver));
            }
            if let Some(process) = &driver.process {
                command
                    .arg("-c")
                    .arg(format!("filter.{}.process={process}", driver.driver));
            }
            command
                .arg("-c")
                .arg(format!("filter.{}.required={required}", driver.driver));
        }
        command
    }

    fn execute(&self, args: &[&str]) -> Result<String, String> {
        self.execute_with_config(args, &[])
    }

    fn execute_with_config(
        &self,
        args: &[&str],
        extra_config: &[(String, String)],
    ) -> Result<String, String> {
        let mut command = self.git_command_with_config(extra_config);
        let _alternates_handoff = self.repository.prepare_subprocess_handoff()?;
        let out = command
            .args(args)
            .output()
            .map_err(|e| format!("git: {}", e))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if err.is_empty() {
                format!("git {:?} failed", args)
            } else {
                err
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    fn config_value(&self, key: &str) -> Option<&str> {
        self.repository
            .config
            .iter()
            .find_map(|(candidate, value)| (candidate == key).then_some(value.as_str()))
    }

    fn first_non_empty_config_value_after_last_empty_reset(&self, key: &str) -> Option<&str> {
        let last_reset = self
            .repository
            .config
            .iter()
            .rposition(|(candidate, value)| candidate == key && value.is_empty());
        let Some(last_reset) = last_reset else {
            return self.config_value(key).filter(|value| !value.is_empty());
        };
        self.repository.config[last_reset + 1..]
            .iter()
            .find_map(|(candidate, value)| {
                (candidate == key && !value.is_empty()).then_some(value.as_str())
            })
    }
}

fn run_git(root: &str, args: &[&str]) -> Result<String, String> {
    GitInspection::new(root)?.execute(args)
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct GitWorktree {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
    pub is_main: bool,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    pub lock_reason: Option<String>,
    pub prunable: bool,
    pub prune_reason: Option<String>,
    pub dirty: bool,
    pub missing: bool,
}

fn parse_git_worktrees(raw: &str) -> Vec<GitWorktree> {
    raw.split("\n\n")
        .filter_map(|block| {
            let mut worktree = GitWorktree {
                path: String::new(),
                head: String::new(),
                branch: None,
                is_main: false,
                detached: false,
                bare: false,
                locked: false,
                lock_reason: None,
                prunable: false,
                prune_reason: None,
                dirty: false,
                missing: false,
            };
            for line in block.lines() {
                let (key, value) = line.split_once(' ').unwrap_or((line, ""));
                match key {
                    "worktree" => worktree.path = value.to_string(),
                    "HEAD" => worktree.head = value.to_string(),
                    "branch" => {
                        worktree.branch = Some(
                            value
                                .strip_prefix("refs/heads/")
                                .unwrap_or(value)
                                .to_string(),
                        )
                    }
                    "detached" => worktree.detached = true,
                    "bare" => worktree.bare = true,
                    "locked" => {
                        worktree.locked = true;
                        if !value.is_empty() {
                            worktree.lock_reason = Some(value.to_string());
                        }
                    }
                    "prunable" => {
                        worktree.prunable = true;
                        worktree.missing = true;
                        if !value.is_empty() {
                            worktree.prune_reason = Some(value.to_string());
                        }
                    }
                    _ => {}
                }
            }
            (!worktree.path.is_empty()).then_some(worktree)
        })
        .enumerate()
        .map(|(index, mut worktree)| {
            worktree.is_main = index == 0;
            worktree
        })
        .collect()
}

#[tauri::command]
pub(crate) fn git_worktrees(root: String) -> Result<Vec<GitWorktree>, String> {
    let root = canonical_project_root(&root)?.to_string_lossy().to_string();
    let policy = Arc::new(GitInspectionPolicy::new(&root)?);
    let raw = run_git_metadata(&root, &["worktree", "list", "--porcelain"])?;
    let mut worktrees = parse_git_worktrees(&raw);
    for worktree in &mut worktrees {
        if worktree.prunable || worktree.bare {
            continue;
        }
        let status =
            GitInspection::with_policy(&worktree.path, Arc::clone(&policy), Some(&worktree.head))
                .and_then(|inspection| {
                    inspection.execute(&["status", "--porcelain=v1", "--untracked-files=normal"])
                });
        match status {
            Ok(status) => worktree.dirty = !status.trim().is_empty(),
            Err(_) => worktree.missing = true,
        }
    }
    Ok(worktrees)
}

/// git@github.com:owner/repo.git and https://github.com/owner/repo.git both
/// normalise to a browsable https URL.
fn remote_to_web_url(remote: &str) -> Option<String> {
    let r = remote.trim().trim_end_matches(".git");
    if let Some(rest) = r.strip_prefix("git@") {
        let mut parts = rest.splitn(2, ':');
        let host = parts.next()?;
        let path = parts.next()?;
        return Some(format!("https://{}/{}", host, path));
    }
    if r.starts_with("https://") || r.starts_with("http://") {
        return Some(r.to_string());
    }
    if let Some(rest) = r.strip_prefix("ssh://git@") {
        return Some(format!("https://{}", rest));
    }
    None
}

#[derive(Debug, Serialize, Clone)]
pub struct GitFileEntry {
    pub path: String,
    /// Two-character porcelain code, e.g. " M", "A ", "??".
    pub code: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileEntry>,
    pub remote_url: Option<String>,
    pub web_url: Option<String>,
}

#[tauri::command]
pub(crate) fn git_status(root: String) -> Result<GitStatus, String> {
    let root = canonical_project_root(&root)?.to_string_lossy().to_string();
    let inside =
        run_git_metadata(&root, &["rev-parse", "--is-inside-work-tree"]).unwrap_or_default();
    if inside.trim() != "true" {
        return Ok(GitStatus {
            is_repo: false,
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
            remote_url: None,
            web_url: None,
        });
    }
    let trusted_url_rewrites = git_trusted_url_rewrite_config(&root)?;
    let inspection = GitInspection::new(&root)?;

    let prefix = inspection
        .execute(&["rev-parse", "--show-prefix"])?
        .trim()
        .to_string();
    let raw = inspection.execute(&[
        "status",
        "--porcelain",
        "-b",
        "--untracked-files=all",
        "--",
        ".",
    ])?;
    let mut branch = None;
    let mut upstream = None;
    let (mut ahead, mut behind) = (0u32, 0u32);
    let mut files = Vec::new();

    for line in raw.lines() {
        if let Some(head) = line.strip_prefix("## ") {
            // "main...origin/main [ahead 1, behind 2]" | "No commits yet on main"
            let (refs, track) = match head.find(" [") {
                Some(i) => (&head[..i], &head[i..]),
                None => (head, ""),
            };
            let mut it = refs.splitn(2, "...");
            branch = it
                .next()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            upstream = it.next().map(|s| s.trim().to_string());
            for (key, slot) in [("ahead ", &mut ahead), ("behind ", &mut behind)] {
                if let Some(i) = track.find(key) {
                    let tail = &track[i + key.len()..];
                    let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
                    *slot = digits.parse().unwrap_or(0);
                }
            }
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let code = line[..2].to_string();
        // Renames read "R  old -> new"; the new path is what the user cares about.
        let rest = &line[3..];
        let repo_path = match rest.split(" -> ").last() {
            Some(p) => p.to_string(),
            None => rest.to_string(),
        };
        let path = if prefix.is_empty() {
            repo_path
        } else {
            let Some(relative) = repo_path.strip_prefix(&prefix) else {
                continue;
            };
            relative.to_string()
        };
        let index = code.chars().next().unwrap_or(' ');
        let worktree = code.chars().nth(1).unwrap_or(' ');
        files.push(GitFileEntry {
            path,
            untracked: code == "??",
            staged: index != ' ' && index != '?',
            unstaged: worktree != ' ' && worktree != '?',
            code,
        });
    }

    let remote_url = inspection
        .first_non_empty_config_value_after_last_empty_reset("remote.origin.url")
        .map(|_| {
            // `git remote get-url` ignores command-scope `-c remote.*` values,
            // but `ls-remote --get-url` resolves the same fetch URL without
            // consulting live repository config.
            inspection
                .execute_with_config(&["ls-remote", "--get-url", "origin"], &trusted_url_rewrites)
        })
        .transpose()?
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty());
    let web_url = remote_url.as_deref().and_then(remote_to_web_url);

    Ok(GitStatus {
        is_repo: true,
        branch,
        upstream,
        ahead,
        behind,
        files,
        remote_url,
        web_url,
    })
}

const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Serialize, Clone)]
pub struct GitDiffResult {
    pub text: String,
    pub bytes: u64,
    pub lines: u64,
    pub truncated: bool,
}

fn bounded_diff(text: String) -> GitDiffResult {
    let bytes = text.len();
    let lines = text.lines().count() as u64;
    if bytes <= MAX_DIFF_BYTES {
        return GitDiffResult {
            text,
            bytes: bytes as u64,
            lines,
            truncated: false,
        };
    }

    let mut end = MAX_DIFF_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    GitDiffResult {
        text: text[..end].to_string(),
        bytes: bytes as u64,
        lines,
        truncated: true,
    }
}

/// Upper bound on `-U` context lines a caller may request.
const MAX_DIFF_CONTEXT: u32 = 2000;

#[tauri::command]
pub(crate) fn git_diff(
    root: String,
    path: Option<String>,
    staged: Option<bool>,
    context: Option<u32>,
) -> Result<GitDiffResult, String> {
    let root = canonical_project_root(&root)?.to_string_lossy().to_string();
    let mut args: Vec<String> = vec![
        "--no-pager".into(),
        "diff".into(),
        "--no-color".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        "--relative".into(),
    ];
    // Context lines, for expanding a hunk in place. Clamped rather than passed
    // through: the value reaches a subprocess argument, and an unbounded one
    // would let the caller ask git to render an arbitrarily large diff.
    if let Some(lines) = context {
        args.push(format!("-U{}", lines.min(MAX_DIFF_CONTEXT)));
    }
    if staged.unwrap_or(false) {
        args.push("--cached".into());
    }
    if let Some(p) = path.as_ref() {
        validate_git_relative_path(p)?;
        args.push("--".into());
        args.push(p.clone());
    } else {
        args.push("--".into());
        args.push(".".into());
    }
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = run_git(&root, &refs)?;
    if !out.trim().is_empty() {
        return Ok(bounded_diff(out));
    }
    // An untracked file has no diff; show it as an all-additions block instead
    // of an empty pane.
    if let Some(p) = path {
        let full = resolve_project_path(&root, &p)?;
        if full.is_file() {
            if let Ok(text) = std::fs::read_to_string(&full) {
                let mut s = format!("--- /dev/null\n+++ b/{}\n", p);
                for line in text.lines() {
                    s.push('+');
                    s.push_str(line);
                    s.push('\n');
                }
                return Ok(bounded_diff(s));
            }
        }
    }
    Ok(bounded_diff(out))
}

#[derive(Debug, Serialize, Clone)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub relative: String,
}

#[tauri::command]
pub(crate) fn git_log(root: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    let root = canonical_project_root(&root)?.to_string_lossy().to_string();
    let n = limit.unwrap_or(30).clamp(1, 200).to_string();
    let raw = run_git(
        &root,
        &[
            "--no-pager",
            "log",
            "-n",
            &n,
            "--pretty=format:%H\x1f%h\x1f%s\x1f%an\x1f%ar",
        ],
    )?;
    Ok(raw
        .lines()
        .filter_map(|line| {
            let mut f = line.split('\x1f');
            Some(GitCommit {
                hash: f.next()?.to_string(),
                short: f.next()?.to_string(),
                subject: f.next()?.to_string(),
                author: f.next()?.to_string(),
                relative: f.next().unwrap_or("").to_string(),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    // Shared test fixtures stay with `workspace_panel_tests`: the remaining
    // tests there still use them — `TempTree` seventeen times, `path_text`
    // thirty-four — so moving them would strand those rather than tidy this.
    use super::*;
    use crate::workspace_panel_tests::{
        create_test_symlink, marker_command, path_text, shell_path, shell_single_quote,
        trusted_normalizing_clean_command, write_marker_executable, TempTree, TestSymlinkKind,
    };
    use std::ffi::{OsStr, OsString};
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(windows)]
    use std::os::windows::fs::{symlink_dir, symlink_file};

    #[cfg(unix)]
    struct ReftableSourceSwapGuard {
        source: PathBuf,
        parked: PathBuf,
        replacement: PathBuf,
    }

    #[cfg(unix)]
    impl Drop for ReftableSourceSwapGuard {
        fn drop(&mut self) {
            std::fs::rename(&self.source, &self.replacement).unwrap();
            std::fs::rename(&self.parked, &self.source).unwrap();
        }
    }

    struct TestGitEnvOverrideGuard {
        previous: Vec<(OsString, Option<OsString>)>,
    }

    impl TestGitEnvOverrideGuard {
        fn set(overrides: &[(&str, Option<&OsStr>)]) -> Self {
            let overrides = overrides
                .iter()
                .map(|(key, value)| {
                    (
                        OsString::from(key),
                        value.map(std::borrow::ToOwned::to_owned),
                    )
                })
                .collect();
            let previous = TEST_GIT_ENV_OVERRIDES
                .with(|slot| std::mem::replace(&mut *slot.borrow_mut(), overrides));
            Self { previous }
        }
    }

    impl Drop for TestGitEnvOverrideGuard {
        fn drop(&mut self) {
            TEST_GIT_ENV_OVERRIDES.with(|slot| {
                *slot.borrow_mut() = std::mem::take(&mut self.previous);
            });
        }
    }

    struct DirectoryReplacementGuard {
        path: PathBuf,
        parked: PathBuf,
    }

    impl Drop for DirectoryReplacementGuard {
        fn drop(&mut self) {
            if std::fs::remove_file(&self.path).is_err() {
                let _ = std::fs::remove_dir(&self.path);
            }
            let _ = std::fs::rename(&self.parked, &self.path);
        }
    }

    fn snapshot_test_git_refs(
        common_dir: &Path,
        object_format: Option<&str>,
    ) -> Result<HashMap<String, GitRefValue>, String> {
        let handle = GitMetadataDirectory::open(common_dir, "Git common directory")?;
        snapshot_git_refs(&handle, object_format)
    }

    #[test]
    fn git_subprocess_root_requires_ascii_drive_letters() {
        let prefix = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
        let mut ascii_drive = prefix.to_vec();
        ascii_drive.extend([b'C' as u16, b':' as u16, b'\\' as u16]);
        let mut non_ascii_drive = prefix.to_vec();
        non_ascii_drive.extend([0x0141, b':' as u16, b'\\' as u16]);

        assert!(has_windows_verbatim_disk_prefix(&ascii_drive));
        assert!(!has_windows_verbatim_disk_prefix(&non_ascii_drive));
    }

    #[cfg(windows)]
    #[test]
    fn git_subprocess_root_removes_only_verbatim_disk_prefixes() {
        assert_eq!(
            git_subprocess_root(Path::new(r"\\?\C:\workspace\project")).as_ref(),
            Path::new(r"C:\workspace\project")
        );
        assert_eq!(
            git_subprocess_root(Path::new(r"\\?\UNC\server\share\project")).as_ref(),
            Path::new(r"\\?\UNC\server\share\project")
        );
        assert_eq!(
            git_subprocess_root(Path::new(r"C:\workspace\project")).as_ref(),
            Path::new(r"C:\workspace\project")
        );
    }

    #[test]
    fn git_filter_driver_overrides_respect_includes_and_prefer_global_over_system_per_key() {
        let tree = TempTree::new("git-filter-scope-precedence");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let system_config = tree.root.join("system.gitconfig");
        let system_include = tree.root.join("system-filter.cfg");
        let global_config = home.join(".gitconfig");
        let global_include = tree.root.join("global-filter.cfg");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        run_test_git(&project, &["init", "-q"]);
        std::fs::write(
            &system_include,
            "[filter \"trusted-mixed\"]\n\tclean = system-clean --mode normalize\n\tprocess = system-process --mode normalize\n\trequired = true\n",
        )
        .unwrap();
        run_test_git(
            &project,
            &[
                "config",
                "--file",
                path_text(&system_config),
                "include.path",
                path_text(&system_include),
            ],
        );
        std::fs::write(
            &global_include,
            "[filter \"trusted-mixed\"]\n\tprocess = global-process --mode normalize\n\trequired = false\n",
        )
        .unwrap();
        run_test_git(
            &project,
            &[
                "config",
                "--file",
                path_text(&global_config),
                "include.path",
                path_text(&global_include),
            ],
        );

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_SYSTEM", Some(system_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", None),
        ]);

        let config = git_filter_driver_override(
            path_text(&project),
            "trusted-mixed".to_string(),
            true,
            true,
        )
        .unwrap();

        assert_eq!(config.driver, "trusted-mixed");
        assert!(config.repository_clean);
        assert!(config.repository_process);
        assert_eq!(
            config.clean.as_deref(),
            Some("system-clean --mode normalize")
        );
        assert_eq!(
            config.process.as_deref(),
            Some("global-process --mode normalize")
        );
        assert_eq!(config.required, Some(false));
    }

    #[test]
    fn git_status_reads_each_filter_config_scope_once() {
        let tree = TempTree::new("git-filter-query-count");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "filter.first.clean", "first-clean"]);
        run_test_git(
            &tree.root,
            &["config", "filter.second.process", "second-process"],
        );
        TEST_GIT_FILTER_SCOPE_QUERIES.with(|queries| queries.borrow_mut().clear());

        git_status(path_text(&tree.root).to_string()).unwrap();

        let queries = TEST_GIT_FILTER_SCOPE_QUERIES.with(|queries| queries.borrow().clone());
        assert!(
            !queries.iter().any(|query| query == "--local"),
            "repository filter config must not be loaded into the inspection policy: {queries:?}"
        );
        for scope in ["--system", "--global"] {
            assert_eq!(
                queries
                    .iter()
                    .filter(|query| query.as_str() == scope)
                    .count(),
                1,
                "{scope} filter config must be read once per git_status operation: {queries:?}"
            );
        }
    }

    #[test]
    fn git_worktrees_reuses_one_filter_policy_for_all_worktrees() {
        let tree = TempTree::new("git-worktree-filter-query-count");
        let linked_one = tree.root.join("linked-one");
        let linked_two = tree.root.join("linked-two");
        let repository = tree.root.join("repository");
        std::fs::create_dir_all(&repository).unwrap();
        run_test_git(&repository, &["init", "-q"]);
        run_test_git(&repository, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &repository,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(repository.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&repository, &["add", "tracked.txt"]);
        run_test_git(&repository, &["commit", "-qm", "baseline"]);
        run_test_git(
            &repository,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "linked-one",
                path_text(&linked_one),
            ],
        );
        run_test_git(
            &repository,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "linked-two",
                path_text(&linked_two),
            ],
        );
        TEST_GIT_FILTER_SCOPE_QUERIES.with(|queries| queries.borrow_mut().clear());
        TEST_GIT_COMMAND_COUNT.with(|count| *count.borrow_mut() = 0);

        let worktrees = git_worktrees(path_text(&repository).to_string()).unwrap();

        assert_eq!(worktrees.len(), 3);
        let command_count = TEST_GIT_COMMAND_COUNT.with(|count| *count.borrow());
        assert_eq!(
            command_count,
            15,
            "worktree inspection should reuse three shared policy/list queries while snapshotting two repository config scopes, effective line endings, and one status process per worktree"
        );
        let queries = TEST_GIT_FILTER_SCOPE_QUERIES.with(|queries| queries.borrow().clone());
        for scope in ["--system", "--global"] {
            assert_eq!(
                queries
                    .iter()
                    .filter(|query| query.as_str() == scope)
                    .count(),
                1,
                "{scope} filter config must be snapshotted once for the complete worktree operation: {queries:?}"
            );
        }
    }

    #[test]
    fn git_worktrees_preserves_linked_worktree_sha256_and_filemode_config() {
        let tree = TempTree::new("git-worktree-sha256-filemode");
        let repository = tree.root.join("repository");
        let linked = tree.root.join("linked");
        std::fs::create_dir_all(&repository).unwrap();
        run_test_git(&repository, &["init", "-q", "--object-format=sha256"]);
        run_test_git(&repository, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &repository,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&repository, &["config", "core.filemode", "false"]);
        std::fs::write(repository.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&repository, &["add", "tracked.txt"]);
        run_test_git(&repository, &["commit", "-qm", "baseline"]);
        run_test_git(
            &repository,
            &["worktree", "add", "-q", "-b", "linked", path_text(&linked)],
        );
        #[cfg(unix)]
        std::fs::set_permissions(
            linked.join("tracked.txt"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();

        let worktrees = git_worktrees(path_text(&repository).to_string()).unwrap();
        let linked_status = worktrees
            .iter()
            .find(|worktree| worktree.branch.as_deref() == Some("linked"))
            .expect("linked worktree must be reported");

        assert!(
            !linked_status.missing,
            "SHA-256 linked worktree inspection must succeed"
        );
        assert!(
            !linked_status.dirty,
            "linked worktree inspection must preserve core.filemode=false"
        );
    }

    #[test]
    fn git_status_and_diff_preserve_effective_global_crlf_normalization() {
        let tree = TempTree::new("git-global-crlf-normalization");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            &global_config,
            "[core]\n\tautocrlf = true\n\teol = crlf\n\tsafecrlf = true\n",
        )
        .unwrap();
        run_test_git(&project, &["init", "-q"]);
        std::fs::write(
            project.join(".gitattributes"),
            b"/.gitattributes -text\r\ntracked.txt text\r\n",
        )
        .unwrap();
        std::fs::write(project.join("tracked.txt"), b"first\r\nsecond\r\n").unwrap();

        let env = [
            ("HOME", path_text(&home)),
            ("GIT_CONFIG_GLOBAL", path_text(&global_config)),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ];
        run_test_git_with_env(&project, &["add", ".gitattributes", "tracked.txt"], &env);
        run_test_git_with_env(
            &project,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
            &env,
        );
        std::fs::write(project.join("tracked.txt"), b"first\r\nsecond\r\n").unwrap();
        let raw_status =
            run_test_git_stdout_with_env(&project, &["status", "--porcelain", "--", "."], &env);
        assert!(
            raw_status.trim().is_empty(),
            "effective global CRLF normalization must keep raw status clean: {raw_status:?}"
        );

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);
        let status = git_status(path_text(&project).to_string()).unwrap();
        let diff = git_diff(path_text(&project).to_string(), None, Some(false), None).unwrap();

        assert!(
            status.files.is_empty(),
            "isolated CRLF status files: {:?}",
            status.files
        );
        assert!(diff.text.is_empty(), "isolated CRLF diff: {:?}", diff.text);
        assert_eq!(diff.bytes, 0);
    }

    #[test]
    fn git_status_and_diff_preserve_local_line_endings_after_root_canonicalization() {
        let tree = TempTree::new("git-canonical-root-line-endings");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            &global_config,
            "[core]\n\tautocrlf = true\n\teol = crlf\n\tsafecrlf = true\n",
        )
        .unwrap();
        run_test_git(&project, &["init", "-q"]);
        run_test_git(&project, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &project,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&project, &["config", "core.autocrlf", "false"]);
        std::fs::write(project.join("tracked.txt"), b"first\nsecond\nthird\n").unwrap();
        run_test_git(&project, &["add", "tracked.txt"]);
        run_test_git(&project, &["commit", "-qm", "baseline"]);

        std::fs::write(project.join("tracked.txt"), b"first\nsecond\nthird\n").unwrap();
        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);
        let status = git_status(path_text(&project).to_string()).unwrap();
        assert!(
            status.files.is_empty(),
            "canonicalized inspection must preserve local core.autocrlf=false: {:?}",
            status.files
        );

        std::fs::write(project.join("tracked.txt"), b"first\nchanged\nthird\n").unwrap();
        let diff = git_diff(
            path_text(&project).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            Some(0),
        )
        .unwrap();
        assert!(diff.text.contains("-second"));
        assert!(diff.text.contains("+changed"));
        assert!(!diff.text.contains("-first"));
        assert!(!diff.text.contains("+first"));
        assert!(!diff.text.contains("-third"));
        assert!(!diff.text.contains("+third"));
    }

    #[test]
    fn git_inspection_snapshots_only_effective_line_ending_config() {
        let tree = TempTree::new("git-effective-line-ending-config");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            &global_config,
            "[core]\n\tautocrlf = true\n\teol = crlf\n\tsafecrlf = warn\n\tcheckRoundtripEncoding = SHIFT-JIS\n",
        )
        .unwrap();
        run_test_git(&project, &["init", "-q"]);
        run_test_git(&project, &["config", "core.autocrlf", "input"]);
        run_test_git(&project, &["config", "core.eol", "lf"]);

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);
        let config = git_inspection_repository_config(path_text(&project)).unwrap();
        let values = config.into_iter().collect::<HashMap<_, _>>();

        assert_eq!(
            values.get("core.autocrlf").map(String::as_str),
            Some("input")
        );
        assert_eq!(values.get("core.eol").map(String::as_str), Some("lf"));
        assert_eq!(
            values.get("core.safecrlf").map(String::as_str),
            Some("warn")
        );
        assert!(
            !values.contains_key("core.checkroundtripencoding"),
            "encoding conversion policy is outside the line-ending snapshot contract"
        );
    }

    #[test]
    fn git_worktrees_preserve_worktree_specific_crlf_normalization() {
        let tree = TempTree::new("git-worktree-crlf-normalization");
        let repository = tree.root.join("repository");
        let linked = tree.root.join("linked");
        std::fs::create_dir_all(&repository).unwrap();
        run_test_git(&repository, &["init", "-q"]);
        run_test_git(&repository, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &repository,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&repository, &["config", "core.autocrlf", "false"]);
        run_test_git(&repository, &["config", "core.eol", "lf"]);
        std::fs::write(repository.join(".gitattributes"), "tracked.txt text\n").unwrap();
        std::fs::write(repository.join("tracked.txt"), "first\nsecond\n").unwrap();
        run_test_git(&repository, &["add", ".gitattributes", "tracked.txt"]);
        run_test_git(&repository, &["commit", "-qm", "baseline"]);
        run_test_git(
            &repository,
            &["config", "extensions.worktreeConfig", "true"],
        );
        run_test_git(
            &repository,
            &["worktree", "add", "-q", "-b", "linked", path_text(&linked)],
        );
        run_test_git(&linked, &["config", "--worktree", "core.autocrlf", "true"]);
        run_test_git(&linked, &["config", "--worktree", "core.eol", "crlf"]);
        std::fs::remove_file(linked.join("tracked.txt")).unwrap();
        run_test_git(&linked, &["checkout", "HEAD", "--", "tracked.txt"]);
        assert_eq!(
            std::fs::read(linked.join("tracked.txt")).unwrap(),
            b"first\r\nsecond\r\n"
        );
        let raw_status =
            run_test_git_stdout_with_env(&linked, &["status", "--porcelain", "--", "."], &[]);
        assert!(
            raw_status.trim().is_empty(),
            "linked worktree CRLF normalization must keep raw status clean: {raw_status:?}"
        );

        let worktrees = git_worktrees(path_text(&repository).to_string()).unwrap();
        let linked_status = worktrees
            .iter()
            .find(|worktree| worktree.branch.as_deref() == Some("linked"))
            .expect("linked worktree must be reported");

        assert!(!linked_status.missing);
        assert!(
            !linked_status.dirty,
            "linked worktree inspection must preserve worktree-specific line endings"
        );
    }

    #[test]
    fn git_worktrees_handles_an_unborn_sha256_head() {
        let tree = TempTree::new("git-worktree-unborn-sha256");
        run_test_git(&tree.root, &["init", "-q", "--object-format=sha256"]);
        let policy = Arc::new(GitInspectionPolicy::new(path_text(&tree.root)).unwrap());
        let zero_oid = "0".repeat(64);

        let inspection =
            GitInspection::with_policy(path_text(&tree.root), policy, Some(&zero_oid)).unwrap();
        let attribute_source = inspection
            .repository
            .attribute_source
            .as_deref()
            .expect("unborn repositories must use an isolated empty attribute tree");

        assert!(
            attribute_source.chars().any(|character| character != '0'),
            "all-zero SHA-256 HEAD must not be used as an attribute source"
        );
        assert_eq!(attribute_source.len(), 64);
    }

    #[test]
    fn stale_worktree_head_override_cannot_change_dirty_semantics() {
        let tree = TempTree::new("git-stale-worktree-head-override");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            &global_config,
            format!(
                "[filter \"trusted-normalize\"]\n\tclean = {}\n\trequired = true\n",
                trusted_normalizing_clean_command()
            ),
        )
        .unwrap();
        run_test_git(&project, &["init", "-q"]);
        run_test_git(&project, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &project,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(project.join("tracked.txt"), "same content\n").unwrap();

        let env = [
            ("HOME", path_text(&home)),
            ("GIT_CONFIG_GLOBAL", path_text(&global_config)),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ];
        run_test_git_with_env(&project, &["add", "tracked.txt"], &env);
        run_test_git_with_env(&project, &["commit", "-qm", "baseline"], &env);
        let stale_head = run_test_git_stdout_with_env(&project, &["rev-parse", "HEAD"], &env)
            .trim()
            .to_string();

        std::fs::write(
            project.join(".gitattributes"),
            "tracked.txt filter=trusted-normalize\n",
        )
        .unwrap();
        std::fs::write(project.join("tracked.txt"), "same content   \n").unwrap();
        run_test_git_with_env(&project, &["add", ".gitattributes", "tracked.txt"], &env);
        run_test_git_with_env(&project, &["commit", "-qm", "attributes"], &env);
        let current_head = run_test_git_stdout_with_env(&project, &["rev-parse", "HEAD"], &env)
            .trim()
            .to_string();
        let raw_status =
            run_test_git_stdout_with_env(&project, &["status", "--porcelain", "--", "."], &env);
        assert!(
            raw_status.trim().is_empty(),
            "current attributes should keep the repository clean: {raw_status:?}"
        );

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);
        let policy = Arc::new(GitInspectionPolicy::new(path_text(&project)).unwrap());
        let inspection =
            GitInspection::with_policy(path_text(&project), policy, Some(&stale_head)).unwrap();
        let status = inspection
            .execute(&["status", "--porcelain=v1", "--untracked-files=normal"])
            .unwrap();

        assert_eq!(
            inspection.repository.attribute_source.as_deref(),
            Some(current_head.as_str()),
            "stale worktree-list HEAD metadata must not override the snapshotted attribute source"
        );
        assert!(
            status.trim().is_empty(),
            "stale worktree-list HEAD metadata must not change dirty semantics"
        );
    }

    #[test]
    fn resolves_pty_cwd_inside_project_or_verified_linked_worktree() {
        let tree = TempTree::new("pty-cwd-contained");
        let project = tree.root.join("project");
        let nested = project.join("packages").join("app");
        let linked = tree.root.join("linked-review");
        let linked_nested = linked.join("crates").join("native");
        std::fs::create_dir_all(&nested).unwrap();
        run_test_git(&project, &["init", "-q"]);
        run_test_git(&project, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &project,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&project, &["commit", "--allow-empty", "-qm", "baseline"]);
        run_test_git(
            &project,
            &["worktree", "add", "-q", "-b", "review", path_text(&linked)],
        );
        std::fs::create_dir_all(&linked_nested).unwrap();

        assert_eq!(
            resolve_pty_cwd_with_worktrees(path_text(&project), path_text(&nested), &[]).unwrap(),
            nested.canonicalize().unwrap(),
        );
        assert_eq!(
            resolve_pty_cwd_with_worktrees(
                path_text(&project),
                path_text(&linked_nested),
                &[linked.canonicalize().unwrap()],
            )
            .unwrap(),
            linked_nested.canonicalize().unwrap(),
        );
        assert_eq!(
            resolve_pty_cwd(path_text(&project), path_text(&linked_nested)).unwrap(),
            linked_nested.canonicalize().unwrap(),
        );
    }

    #[test]
    fn rejects_unrelated_missing_and_file_pty_cwds() {
        let tree = TempTree::new("pty-cwd-rejected");
        let project = tree.root.join("project");
        let sibling = tree.root.join("sibling");
        let file = project.join("README.md");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(&file, "not a directory\n").unwrap();

        assert!(
            resolve_pty_cwd_with_worktrees(path_text(&project), path_text(&sibling), &[]).is_err()
        );
        assert!(resolve_pty_cwd(path_text(&project), path_text(&sibling)).is_err());
        assert!(resolve_pty_cwd_with_worktrees(
            path_text(&project),
            path_text(&project.join("missing")),
            &[],
        )
        .is_err());
        assert!(
            resolve_pty_cwd_with_worktrees(path_text(&project), path_text(&file), &[]).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_pty_cwd_symlinks_that_escape_the_project() {
        use std::os::unix::fs::symlink;

        let tree = TempTree::new("pty-cwd-symlink");
        let project = tree.root.join("project");
        let outside = tree.root.join("outside");
        let link = project.join("escape");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, &link).unwrap();

        assert!(
            resolve_pty_cwd_with_worktrees(path_text(&project), path_text(&link), &[]).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn opened_pty_cwd_cannot_retarget_after_rename_and_symlink_swap() {
        use std::os::unix::fs::symlink;

        let tree = TempTree::new("pty-cwd-handle");
        let project = tree.root.join("project");
        let original = project.join("workspace");
        let moved = project.join("workspace-moved");
        let outside = tree.root.join("outside");
        std::fs::create_dir_all(&original).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let opened =
            open_pty_cwd_with_worktrees(path_text(&project), path_text(&original), &[]).unwrap();
        std::fs::rename(&original, &moved).unwrap();
        symlink(&outside, &original).unwrap();

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 10,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/pwd");
        command.arg("-P");
        opened.configure_command_cwd(&mut command).unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(opened);
        drop(pair.slave);
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut reader = pair.master.try_clone_reader().unwrap();
        std::thread::spawn(move || {
            let mut output = String::new();
            reader.read_to_string(&mut output).unwrap();
            sender.send(output).unwrap();
        });
        let writer = pair.master.take_writer().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        drop(writer);
        let status = child.wait().unwrap();
        assert!(status.success(), "portable-pty child failed: {status}");
        drop(pair.master);
        let actual = receiver.recv().unwrap();
        assert_eq!(actual.trim(), path_text(&moved.canonicalize().unwrap()));
        assert_ne!(actual.trim(), path_text(&outside.canonicalize().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_an_unavailable_pty_cwd_locator_before_command_construction() {
        let tree = TempTree::new("pty-cwd-locator");
        let project = tree.root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let mut opened =
            open_pty_cwd_with_worktrees(path_text(&project), path_text(&project), &[]).unwrap();
        opened.spawn_path = tree.root.join("unavailable-locator");
        let mut command = CommandBuilder::new("/bin/pwd");

        let error = opened.configure_command_cwd(&mut command).unwrap_err();

        assert!(error.contains("stable PTY cwd locator is unavailable"));
        assert!(command.get_cwd().is_none());
    }

    fn test_git_command(root: &Path) -> std::process::Command {
        let mut command = std::process::Command::new("git");
        command
            .current_dir(root)
            .env_remove("GIT_CONFIG_COUNT")
            .env_remove("GIT_CONFIG_PARAMETERS");
        command
    }

    fn run_test_git_with_env(root: &Path, args: &[&str], env: &[(&str, &str)]) {
        let output = test_git_command(root)
            .envs(env.iter().copied())
            .args(args)
            .output()
            .expect("git must run in tests");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn run_test_git(root: &Path, args: &[&str]) {
        run_test_git_with_env(root, args, &[]);
    }
    fn run_test_git_stdout_with_env(root: &Path, args: &[&str], env: &[(&str, &str)]) -> String {
        let output = test_git_command(root)
            .envs(env.iter().copied())
            .args(args)
            .output()
            .expect("git must run in tests");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).expect("git stdout must be UTF-8 in tests")
    }

    #[test]
    fn git_file_paths_must_be_relative_and_cannot_traverse() {
        assert!(validate_git_relative_path("src/main.rs").is_ok());
        assert!(validate_git_relative_path("../secret.txt").is_err());
        assert!(validate_git_relative_path("src/../../secret.txt").is_err());
        assert!(validate_git_relative_path("/tmp/secret.txt").is_err());
    }

    #[test]
    fn git_status_does_not_execute_a_repository_fsmonitor() {
        let tree = TempTree::new("git-fsmonitor");
        let hook = tree.root.join("fsmonitor.sh");
        let marker = tree.root.join("fsmonitor-ran");
        write_marker_executable(&hook);
        run_test_git(&tree.root, &["init", "-q"]);
        let configured_fsmonitor = marker_command(&hook, &marker);
        run_test_git(
            &tree.root,
            &["config", "core.fsmonitor", &configured_fsmonitor],
        );

        let repository_fsmonitor = run_test_git_stdout_with_env(
            &tree.root,
            &["config", "--local", "--get", "core.fsmonitor"],
            &[],
        );
        assert_eq!(repository_fsmonitor.trim(), configured_fsmonitor);
        let inspection = GitInspection::new(path_text(&tree.root)).unwrap();
        assert_eq!(
            inspection
                .execute(&["config", "--get-all", "core.fsmonitor"])
                .unwrap(),
            "false\n",
            "isolated inspection must replace repository fsmonitor configuration"
        );

        git_status(path_text(&tree.root).to_string()).unwrap();

        assert!(!marker.exists());
    }

    #[test]
    fn git_status_reports_a_non_repository_without_error() {
        let tree = TempTree::new("git-status-non-repository");

        let status = git_status(path_text(&tree.root).to_string()).unwrap();

        assert!(!status.is_repo);
        assert!(status.files.is_empty());
    }

    #[test]
    fn git_status_preserves_branch_upstream_and_remote_metadata() {
        let tree = TempTree::new("git-status-metadata");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        let branch = run_test_git_stdout_with_env(&tree.root, &["branch", "--show-current"], &[])
            .trim()
            .to_string();
        run_test_git(
            &tree.root,
            &[
                "remote",
                "add",
                "origin",
                "https://example.invalid/repo.git",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "update-ref",
                &format!("refs/remotes/origin/{branch}"),
                "HEAD",
            ],
        );
        run_test_git(
            &tree.root,
            &["config", &format!("branch.{branch}.remote"), "origin"],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                &format!("branch.{branch}.merge"),
                &format!("refs/heads/{branch}"),
            ],
        );

        let status = git_status(path_text(&tree.root).to_string()).unwrap();
        let expected_upstream = format!("origin/{branch}");

        assert_eq!(status.branch.as_deref(), Some(branch.as_str()));
        assert_eq!(status.upstream.as_deref(), Some(expected_upstream.as_str()));
        assert_eq!(
            status.remote_url.as_deref(),
            Some("https://example.invalid/repo.git")
        );
    }

    #[test]
    fn git_inspection_preserves_ordered_remote_urls_and_fetch_refspecs() {
        let tree = TempTree::new("git-remote-multivalue");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://first.invalid/repo.git",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://second.invalid/repo.git",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.fetch",
                "+refs/heads/main:refs/remotes/origin/main",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.fetch",
                "+refs/heads/release:refs/remotes/origin/release",
            ],
        );

        let config = git_inspection_repository_config(path_text(&tree.root)).unwrap();
        let urls = config
            .iter()
            .filter(|(key, _)| key == "remote.origin.url")
            .map(|(_, value)| value.as_str())
            .collect::<Vec<_>>();
        let fetch = config
            .iter()
            .filter(|(key, _)| key == "remote.origin.fetch")
            .map(|(_, value)| value.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            urls,
            vec![
                "https://first.invalid/repo.git",
                "https://second.invalid/repo.git",
            ]
        );
        assert_eq!(
            fetch,
            vec![
                "+refs/heads/main:refs/remotes/origin/main",
                "+refs/heads/release:refs/remotes/origin/release",
            ]
        );

        let status = git_status(path_text(&tree.root).to_string()).unwrap();
        assert_eq!(
            status.remote_url.as_deref(),
            Some("https://first.invalid/repo.git")
        );
    }

    #[test]
    fn git_status_uses_first_origin_url_after_empty_reset() {
        let tree = TempTree::new("git-remote-url-after-reset");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://first.invalid/repo.git",
            ],
        );
        run_test_git(&tree.root, &["config", "--add", "remote.origin.url", ""]);
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://later.invalid/repo.git",
            ],
        );

        let status = git_status(path_text(&tree.root).to_string()).unwrap();

        assert_eq!(
            status.remote_url.as_deref(),
            Some("https://later.invalid/repo.git")
        );
    }

    #[test]
    fn git_status_omits_origin_url_after_trailing_empty_reset() {
        let tree = TempTree::new("git-remote-url-trailing-reset");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://first.invalid/repo.git",
            ],
        );
        run_test_git(&tree.root, &["config", "--add", "remote.origin.url", ""]);

        let status = git_status(path_text(&tree.root).to_string()).unwrap();

        assert_eq!(status.remote_url, None);
        assert_eq!(status.web_url, None);
    }

    #[test]
    fn git_inspection_preserves_remote_subsection_case() {
        let tree = TempTree::new("git-remote-subsection-case");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.Origin.url",
                "https://uppercase.invalid/repo.git",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://lowercase-first.invalid/repo.git",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://lowercase-second.invalid/repo.git",
            ],
        );

        let config = git_inspection_repository_config(path_text(&tree.root)).unwrap();
        let urls = config
            .iter()
            .filter(|(key, _)| key.ends_with(".url"))
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect::<Vec<_>>();

        assert_eq!(
            urls,
            vec![
                ("remote.Origin.url", "https://uppercase.invalid/repo.git",),
                (
                    "remote.origin.url",
                    "https://lowercase-first.invalid/repo.git",
                ),
                (
                    "remote.origin.url",
                    "https://lowercase-second.invalid/repo.git",
                ),
            ]
        );

        let status = git_status(path_text(&tree.root).to_string()).unwrap();
        assert_eq!(
            status.remote_url.as_deref(),
            Some("https://lowercase-first.invalid/repo.git")
        );
    }

    #[test]
    fn git_inspection_preserves_a_loose_remote_head_symbolic_ref() {
        let tree = TempTree::new("git-symbolic-remote-head");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        run_test_git(&tree.root, &["branch", "-M", "main"]);
        run_test_git(
            &tree.root,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        run_test_git(
            &tree.root,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );

        let inspection = GitInspection::new(path_text(&tree.root)).unwrap();

        assert_eq!(
            inspection
                .execute(&["symbolic-ref", "refs/remotes/origin/HEAD"])
                .unwrap()
                .trim(),
            "refs/remotes/origin/main"
        );
        assert_eq!(
            inspection
                .execute(&["rev-parse", "refs/remotes/origin/HEAD"])
                .unwrap()
                .trim(),
            run_test_git_stdout_with_env(&tree.root, &["rev-parse", "HEAD"], &[]).trim()
        );
        assert!(git_status(path_text(&tree.root).to_string()).is_ok());
    }

    #[test]
    fn git_status_resolves_origin_url_through_trusted_global_instead_of_rules() {
        let tree = TempTree::new("git-status-remote-url-rewrite");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            &global_config,
            "[url \"git@github.com:\"]\n\tinsteadOf = gh:\n",
        )
        .unwrap();

        run_test_git(&project, &["init", "-q"]);
        run_test_git(&project, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &project,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(project.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&project, &["add", "tracked.txt"]);
        run_test_git(&project, &["commit", "-qm", "baseline"]);
        run_test_git(&project, &["remote", "add", "origin", "gh:owner/repo.git"]);

        let env = [
            ("HOME", path_text(&home)),
            ("GIT_CONFIG_GLOBAL", path_text(&global_config)),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ];
        let raw_remote =
            run_test_git_stdout_with_env(&project, &["remote", "get-url", "origin"], &env);
        assert_eq!(raw_remote.trim(), "git@github.com:owner/repo.git");

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);

        let status = git_status(path_text(&project).to_string()).unwrap();

        assert_eq!(
            status.remote_url.as_deref(),
            Some("git@github.com:owner/repo.git")
        );
        assert_eq!(
            status.web_url.as_deref(),
            Some("https://github.com/owner/repo")
        );
    }

    #[test]
    fn git_ref_snapshot_ignores_populated_lockfiles() {
        let tree = TempTree::new("git-ref-lockfile");
        let common_dir = tree.root.join("common");
        let heads = common_dir.join("refs/heads");
        std::fs::create_dir_all(&heads).unwrap();
        std::fs::write(
            heads.join("main"),
            "1111111111111111111111111111111111111111\n",
        )
        .unwrap();
        std::fs::write(
            heads.join("main.lock"),
            "2222222222222222222222222222222222222222\n",
        )
        .unwrap();

        let refs = snapshot_test_git_refs(&common_dir, None).unwrap();

        assert!(matches!(
            refs.get("refs/heads/main"),
            Some(GitRefValue::Direct(oid))
                if oid == "1111111111111111111111111111111111111111"
        ));
        assert!(!refs.contains_key("refs/heads/main.lock"));
    }

    #[test]
    fn git_ref_snapshot_ignores_invalid_files_and_keeps_valid_symbolic_refs() {
        let tree = TempTree::new("git-invalid-ref-file");
        let common_dir = tree.root.join("common");
        let remote_refs = common_dir.join("refs/remotes/origin");
        std::fs::create_dir_all(&remote_refs).unwrap();
        std::fs::write(
            remote_refs.join("main"),
            "1111111111111111111111111111111111111111\n",
        )
        .unwrap();
        std::fs::write(remote_refs.join("HEAD"), "ref: refs/remotes/origin/main\n").unwrap();
        std::fs::write(
            remote_refs.join("bad..name"),
            "2222222222222222222222222222222222222222\n",
        )
        .unwrap();

        let refs = snapshot_test_git_refs(&common_dir, None).unwrap();

        assert!(matches!(
            refs.get("refs/remotes/origin/HEAD"),
            Some(GitRefValue::Symbolic(target)) if target == "refs/remotes/origin/main"
        ));
        assert!(!refs.contains_key("refs/remotes/origin/bad..name"));
    }

    #[test]
    fn git_ref_snapshot_skips_malformed_sha256_loose_refs() {
        let tree = TempTree::new("git-invalid-sha256-ref-file");
        let common_dir = tree.root.join("common");
        let tag_refs = common_dir.join("refs/tags");
        std::fs::create_dir_all(&tag_refs).unwrap();
        std::fs::write(
            tag_refs.join("good"),
            "1111111111111111111111111111111111111111111111111111111111111111\n",
        )
        .unwrap();
        std::fs::write(tag_refs.join("bad"), "22222222222222222222\n").unwrap();

        let refs = snapshot_test_git_refs(&common_dir, Some("sha256")).unwrap();

        assert!(matches!(
            refs.get("refs/tags/good"),
            Some(GitRefValue::Direct(oid))
                if oid == "1111111111111111111111111111111111111111111111111111111111111111"
        ));
        assert!(!refs.contains_key("refs/tags/bad"));
    }

    #[test]
    fn git_ref_snapshot_rejects_common_dir_replacement_after_open() {
        let tree = TempTree::new("git-ref-common-dir-swap");
        let common_dir = tree.root.join("common");
        let parked = tree.root.join("parked-common");
        let replacement = tree.root.join("replacement-common");
        std::fs::create_dir_all(common_dir.join("refs/heads")).unwrap();
        std::fs::create_dir_all(replacement.join("refs/heads")).unwrap();
        std::fs::write(
            common_dir.join("refs/heads/main"),
            "1111111111111111111111111111111111111111\n",
        )
        .unwrap();
        std::fs::write(
            replacement.join("refs/heads/main"),
            "2222222222222222222222222222222222222222\n",
        )
        .unwrap();

        let handle = GitMetadataDirectory::open(&common_dir, "Git common directory").unwrap();
        let error = match snapshot_git_refs_with_hook(&handle, None, || {
            std::fs::rename(&common_dir, &parked).unwrap();
            assert!(create_test_symlink(
                TestSymlinkKind::Directory,
                &replacement,
                &common_dir,
            ));
            DirectoryReplacementGuard {
                path: common_dir.clone(),
                parked: parked.clone(),
            }
        }) {
            Ok(_) => panic!("a replaced Git common directory must be rejected"),
            Err(error) => error,
        };

        assert!(error.contains("Git ref"));
        assert!(error.contains("changed while being read"));
    }

    #[test]
    fn git_ref_snapshot_rejects_symlinked_packed_refs() {
        let tree = TempTree::new("git-symlinked-packed-refs");
        let common_dir = tree.root.join("common");
        let outside = tree.root.join("outside-packed-refs");
        std::fs::create_dir_all(&common_dir).unwrap();
        std::fs::write(
            &outside,
            "1111111111111111111111111111111111111111 refs/heads/main\n",
        )
        .unwrap();
        if !create_test_symlink(
            TestSymlinkKind::File,
            &outside,
            &common_dir.join("packed-refs"),
        ) {
            return;
        }

        let error = match snapshot_test_git_refs(&common_dir, None) {
            Ok(_) => panic!("a symlinked packed-refs file must be rejected"),
            Err(error) => error,
        };

        assert!(error.contains("packed Git refs"));
        assert!(error.contains("regular file"));
    }

    #[test]
    fn git_status_and_diff_ignore_unrelated_malformed_loose_refs() {
        let tree = TempTree::new("git-malformed-loose-ref");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::create_dir_all(tree.root.join(".git/refs/tags")).unwrap();
        std::fs::write(tree.root.join(".git/refs/tags/bad"), "not-an-oid\n").unwrap();
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let raw_status =
            run_test_git_stdout_with_env(&tree.root, &["status", "--porcelain", "--", "."], &[]);
        assert!(
            raw_status.contains(" M tracked.txt"),
            "raw git status should ignore unrelated malformed loose refs: {raw_status:?}"
        );
        let raw_diff = run_test_git_stdout_with_env(
            &tree.root,
            &["diff", "--no-color", "--relative", "--", "tracked.txt"],
            &[],
        );
        assert!(
            raw_diff.contains("+after"),
            "raw git diff should ignore unrelated malformed loose refs: {raw_diff:?}"
        );

        let status = git_status(path_text(&tree.root).to_string()).unwrap();
        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert_eq!(
            status.files.len(),
            1,
            "unexpected malformed-ref status files: {:?}",
            status.files
        );
        assert_eq!(status.files[0].path, "tracked.txt");
        assert!(status.files[0].unstaged);
        assert!(diff.text.contains("+after"));
    }

    #[test]
    fn parent_inspection_does_not_execute_populated_submodule_helpers() {
        let tree = TempTree::new("git-submodule-inspection");
        let parent = tree.root.join("parent");
        let source = tree.root.join("submodule-source");
        let submodule = parent.join("vendor/submodule");
        let filter_helper = tree.root.join("submodule-filter.sh");
        let filter_marker = tree.root.join("submodule-filter-ran");
        let fsmonitor_helper = tree.root.join("submodule-fsmonitor.sh");
        let fsmonitor_marker = tree.root.join("submodule-fsmonitor-ran");
        std::fs::create_dir_all(&parent).unwrap();
        std::fs::create_dir_all(&source).unwrap();
        write_marker_executable(&filter_helper);
        write_marker_executable(&fsmonitor_helper);

        run_test_git(&source, &["init", "-q"]);
        run_test_git(&source, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &source,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&source, &["config", "core.autocrlf", "false"]);
        std::fs::write(source.join("tracked.txt"), "baseline\n").unwrap();
        std::fs::write(
            source.join(".gitattributes"),
            "tracked.txt filter=malicious-submodule\n",
        )
        .unwrap();
        run_test_git(&source, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(&source, &["commit", "-qm", "baseline"]);

        run_test_git(&parent, &["init", "-q"]);
        run_test_git(&parent, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &parent,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&parent, &["config", "core.autocrlf", "false"]);
        run_test_git(
            &parent,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                path_text(&source),
                "vendor/submodule",
            ],
        );
        run_test_git(&submodule, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &submodule,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&submodule, &["config", "core.autocrlf", "false"]);
        run_test_git(&parent, &["commit", "-qam", "add submodule"]);
        run_test_git(
            &submodule,
            &[
                "config",
                "filter.malicious-submodule.clean",
                &format!("{}; cat", marker_command(&filter_helper, &filter_marker)),
            ],
        );
        run_test_git(
            &submodule,
            &["config", "filter.malicious-submodule.required", "true"],
        );
        run_test_git(
            &submodule,
            &[
                "config",
                "core.fsmonitor",
                &marker_command(&fsmonitor_helper, &fsmonitor_marker),
            ],
        );
        std::fs::write(submodule.join("tracked.txt"), "dirty\n").unwrap();

        let raw_trace = tree.root.join("raw-parent-status-trace.json");
        run_test_git_with_env(
            &parent,
            &["status", "--porcelain"],
            &[("GIT_TRACE2_EVENT", path_text(&raw_trace))],
        );
        let raw_submodule_status = std::fs::read_to_string(&raw_trace)
            .is_ok_and(|trace| trace.contains("\"hierarchy\":\"status/status\""));
        let raw_fsmonitor_executed = fsmonitor_marker.exists();
        assert!(
            raw_submodule_status || raw_fsmonitor_executed,
            "raw parent status must either trace populated-submodule inspection or execute its configured fsmonitor"
        );
        if raw_fsmonitor_executed {
            std::fs::remove_file(&fsmonitor_marker).unwrap();
        }
        run_test_git(&submodule, &["config", "--unset", "core.fsmonitor"]);
        run_test_git(&submodule, &["diff", "--no-color"]);
        assert!(filter_marker.exists());
        std::fs::remove_file(&filter_marker).unwrap();
        run_test_git(
            &submodule,
            &[
                "config",
                "core.fsmonitor",
                &marker_command(&fsmonitor_helper, &fsmonitor_marker),
            ],
        );

        let hardened_trace = tree.root.join("hardened-parent-inspection-trace.json");
        {
            let _git_env = TestGitEnvOverrideGuard::set(&[(
                "GIT_TRACE2_EVENT",
                Some(hardened_trace.as_os_str()),
            )]);

            let status = git_status(path_text(&parent).to_string()).unwrap();
            assert!(
                status.files.is_empty(),
                "unexpected parent status files: {:?}",
                status.files
            );
            assert!(!filter_marker.exists());
            assert!(!fsmonitor_marker.exists());

            let diff = git_diff(path_text(&parent).to_string(), None, Some(false), None).unwrap();
            assert!(diff.text.is_empty());
            assert!(!filter_marker.exists());
            assert!(!fsmonitor_marker.exists());

            let worktrees = git_worktrees(path_text(&parent).to_string()).unwrap();
            assert_eq!(worktrees.len(), 1);
            assert!(!worktrees[0].dirty);
            assert!(!filter_marker.exists());
            assert!(!fsmonitor_marker.exists());

            run_test_git(&submodule, &["add", "tracked.txt"]);
            run_test_git(&submodule, &["commit", "-qm", "advance submodule"]);
            if filter_marker.exists() {
                std::fs::remove_file(&filter_marker).unwrap();
            }
            if fsmonitor_marker.exists() {
                std::fs::remove_file(&fsmonitor_marker).unwrap();
            }

            let status = git_status(path_text(&parent).to_string()).unwrap();
            assert_eq!(
                status.files.len(),
                1,
                "unexpected reftable status files: {:?}",
                status.files
            );
            assert_eq!(status.files[0].path, "vendor/submodule");
            assert!(status.files[0].unstaged);
            assert!(!filter_marker.exists());
            assert!(!fsmonitor_marker.exists());

            let diff = git_diff(path_text(&parent).to_string(), None, Some(false), None).unwrap();
            assert!(diff.text.contains("Subproject commit"));
            assert!(!filter_marker.exists());
            assert!(!fsmonitor_marker.exists());

            let worktrees = git_worktrees(path_text(&parent).to_string()).unwrap();
            assert!(worktrees[0].dirty);
            assert!(!filter_marker.exists());
            assert!(!fsmonitor_marker.exists());

            run_test_git(&parent, &["add", "vendor/submodule"]);

            let status = git_status(path_text(&parent).to_string()).unwrap();
            assert_eq!(status.files.len(), 1);
            assert!(status.files[0].staged);
            assert!(!status.files[0].unstaged);
            assert!(!filter_marker.exists());
            assert!(!fsmonitor_marker.exists());

            let diff = git_diff(path_text(&parent).to_string(), None, Some(true), None).unwrap();
            assert!(diff.text.contains("Subproject commit"));
            assert!(!filter_marker.exists());
            assert!(!fsmonitor_marker.exists());

            let worktrees = git_worktrees(path_text(&parent).to_string()).unwrap();
            assert!(worktrees[0].dirty);
            assert!(!filter_marker.exists());
            assert!(!fsmonitor_marker.exists());
        }
        if let Ok(hardened_trace) = std::fs::read_to_string(hardened_trace) {
            assert!(
                !hardened_trace.contains("\"hierarchy\":\"status/status\""),
                "hardened parent inspection must not launch status inside populated submodules"
            );
        }
    }

    #[test]
    fn git_inspection_preserves_sha256_repository_format() {
        let tree = TempTree::new("git-sha256-inspection");
        run_test_git(&tree.root, &["init", "-q", "--object-format=sha256"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
    }

    #[test]
    fn git_inspection_supports_object_paths_with_path_list_separators() {
        let tree = TempTree::new("git-alternate-separator");
        let separator = if cfg!(windows) { ';' } else { ':' };
        let repository = tree.root.join(format!("repository{separator}objects"));
        std::fs::create_dir_all(&repository).unwrap();
        run_test_git(&repository, &["init", "-q"]);
        run_test_git(&repository, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &repository,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(repository.join("tracked.txt"), "before\n").unwrap();
        run_test_git(&repository, &["add", "tracked.txt"]);
        run_test_git(&repository, &["commit", "-qm", "baseline"]);
        std::fs::write(repository.join("tracked.txt"), "after\n").unwrap();

        let diff = git_diff(
            path_text(&repository).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
    }

    #[test]
    fn isolated_git_log_preserves_linked_worktree_shallow_boundary() {
        let tree = TempTree::new("git-shallow-linked-worktree");
        let source = tree.root.join("source");
        let shallow = tree.root.join("shallow");
        let linked = tree.root.join("linked");
        std::fs::create_dir_all(&source).unwrap();
        run_test_git(&source, &["init", "-q"]);
        run_test_git(&source, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &source,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        for subject in ["first", "second", "third"] {
            std::fs::write(source.join("tracked.txt"), format!("{subject}\n")).unwrap();
            run_test_git(&source, &["add", "tracked.txt"]);
            run_test_git(&source, &["commit", "-qm", subject]);
        }
        run_test_git(
            &tree.root,
            &[
                "clone",
                "-q",
                "--depth=2",
                &format!("file://{}", path_text(&source)),
                path_text(&shallow),
            ],
        );
        run_test_git(
            &shallow,
            &[
                "worktree",
                "add",
                "-q",
                "--detach",
                path_text(&linked),
                "HEAD",
            ],
        );

        let (_, linked_git_dir) = git_dir_for_worktree(&linked).unwrap();
        let common_dir = git_common_dir(&linked_git_dir).unwrap();
        assert!(common_dir.join("shallow").is_file());
        assert!(!linked_git_dir.join("shallow").exists());

        let inspection = GitInspection::new(path_text(&linked)).unwrap();
        std::fs::remove_file(common_dir.join("shallow")).unwrap();
        let log = inspection
            .execute(&["--no-pager", "log", "--pretty=format:%s"])
            .unwrap();

        assert_eq!(log.lines().collect::<Vec<_>>(), ["third", "second"]);
    }

    #[test]
    fn git_inspection_rejects_malformed_shallow_boundaries() {
        let tree = TempTree::new("git-invalid-shallow");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::write(tree.root.join(".git/shallow"), "../not-an-object\n").unwrap();

        let error = match GitInspection::new(path_text(&tree.root)) {
            Ok(_) => panic!("malformed shallow metadata must be rejected"),
            Err(error) => error,
        };

        assert!(error.contains("invalid Git shallow boundary"));
    }

    #[test]
    fn git_shallow_snapshot_anchors_to_open_common_directory() {
        let tree = TempTree::new("git-shallow-anchored-common-dir");
        let common_dir = tree.root.join("common");
        let parked = tree.root.join("parked-common");
        let replacement = tree.root.join("replacement-common");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(&common_dir).unwrap();
        std::fs::create_dir_all(&replacement).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(
            common_dir.join("shallow"),
            "1111111111111111111111111111111111111111\n",
        )
        .unwrap();
        std::fs::write(
            replacement.join("shallow"),
            "2222222222222222222222222222222222222222\n",
        )
        .unwrap();

        let handle = GitMetadataDirectory::open(&common_dir, "Git common directory").unwrap();
        snapshot_git_shallow_with_hook(&handle, &destination, None, || {
            std::fs::rename(&common_dir, &parked).unwrap();
            assert!(create_test_symlink(
                TestSymlinkKind::Directory,
                &replacement,
                &common_dir,
            ));
            DirectoryReplacementGuard {
                path: common_dir.clone(),
                parked: parked.clone(),
            }
        })
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(destination.join("shallow")).unwrap(),
            "1111111111111111111111111111111111111111\n"
        );
    }

    #[test]
    fn git_attribute_source_snapshot_uses_snapshotted_objects_after_objects_swap() {
        let tree = TempTree::new("git-attribute-source-object-snapshot");
        let source = tree.root.join("source");
        let parked = tree.root.join("parked-objects");
        let replacement = tree.root.join("replacement-objects");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&replacement).unwrap();

        let init = std::process::Command::new("git")
            .current_dir(&source)
            .args(["init", "-q", "-b", "main", "--ref-format=reftable"])
            .output()
            .expect("git init must run in tests");
        if !init.status.success() {
            assert!(
                !String::from_utf8_lossy(&init.stderr).trim().is_empty(),
                "Git without reftable support must reject the requested ref format clearly"
            );
            return;
        }
        run_test_git(&source, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &source,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(source.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&source, &["add", "tracked.txt"]);
        run_test_git(&source, &["commit", "-qm", "baseline"]);
        let expected_head = run_test_git_stdout_with_env(&source, &["rev-parse", "HEAD"], &[])
            .trim()
            .to_string();

        let config = git_inspection_repository_config(path_text(&source)).unwrap();
        let objects_dir = source.join(".git/objects");
        let mut restore = None;
        let snapshot = GitInspectionRepository::snapshot_with_handoff_hook(
            path_text(&source),
            Some("stale-head-override"),
            config,
            &mut || {
                if restore.is_some() {
                    return;
                }
                std::fs::rename(&objects_dir, &parked).unwrap();
                assert!(create_test_symlink(
                    TestSymlinkKind::Directory,
                    &replacement,
                    &objects_dir,
                ));
                restore = Some(DirectoryReplacementGuard {
                    path: objects_dir.clone(),
                    parked: parked.clone(),
                });
            },
        )
        .unwrap();
        drop(restore);

        assert_eq!(
            snapshot.attribute_source.as_deref(),
            Some(expected_head.as_str())
        );
    }

    #[test]
    fn git_info_snapshot_anchors_to_open_common_directory() {
        let tree = TempTree::new("git-info-anchored-common-dir");
        let common_dir = tree.root.join("common");
        let parked = tree.root.join("parked-common");
        let replacement = tree.root.join("replacement-common");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(common_dir.join("info")).unwrap();
        std::fs::create_dir_all(replacement.join("info")).unwrap();
        std::fs::write(common_dir.join("info/attributes"), "tracked.txt text\n").unwrap();
        std::fs::write(replacement.join("info/attributes"), "tracked.txt binary\n").unwrap();

        let handle = GitMetadataDirectory::open(&common_dir, "Git common directory").unwrap();
        snapshot_trusted_git_info_with_hook(&handle, &destination, || {
            std::fs::rename(&common_dir, &parked).unwrap();
            assert!(create_test_symlink(
                TestSymlinkKind::Directory,
                &replacement,
                &common_dir,
            ));
            DirectoryReplacementGuard {
                path: common_dir.clone(),
                parked: parked.clone(),
            }
        })
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(destination.join("info/attributes")).unwrap(),
            "tracked.txt text\n"
        );
    }

    fn tiny_git_reftable_snapshot_limits() -> GitReftableSnapshotLimits {
        GitReftableSnapshotLimits {
            list_bytes: 32,
            tables: 2,
            table_bytes: 8,
            total_bytes: 12,
        }
    }

    const TEST_REFTABLE_TABLE_ONE: &str = "table-alpha.ref";
    const TEST_REFTABLE_TABLE_TWO: &str = "table-beta.log";
    const TEST_REFTABLE_TABLE_THREE: &str = "table-gamma.ref";
    const REPRESENTATIVE_GIT_REFTABLE_TABLE: &str = "0x000000000001-0x000000000002-3b8de075.ref";
    const SPEC_GIT_REFTABLE_LOG: &str = "00000001-00000001-RANDOM1.log";
    const SAFE_ARBITRARY_GIT_REFTABLE_TABLE: &str = "réftable-随机-7Kp9.ref";
    const SAFE_DECOMPOSED_GIT_REFTABLE_TABLE: &str = "re\u{301}ftable.ref";

    fn write_test_reftable_table_list(source: &Path, names: &[&str]) {
        let mut list = names.join("\n");
        list.push('\n');
        std::fs::write(source.join("tables.list"), list).unwrap();
    }

    fn invalid_git_reftable_table_names() -> Vec<String> {
        let mut names = [
            "NUL.ref",
            "COM1.ref",
            "COM1.any.ref",
            "cOm\u{00b9}.ref",
            "COM\u{00b2}.any.ref",
            "com\u{00b3}.log",
            "nul.any.log",
            "CLOCK$.ref",
            "CONIN$.log",
            "CONOUT$.any.ref",
            "LPT9.log",
            "LpT\u{00b9}.log",
            "LPT\u{00b2}.any.log",
            "lpt\u{00b3}.ref",
            "NUL .ref",
            "safe.ref.",
            "safe.ref ",
            "missing-extension",
            "uppercase.REF",
            "uppercase.LOG",
            "other.txt",
            ".ref",
            ".log",
            "nested/name.ref",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
        for forbidden in ['<', '>', ':', '"', '/', '\\', '|', '?', '*'] {
            names.push(format!("bad{forbidden}name.ref"));
        }
        for control in ['\0', '\u{0001}', '\u{001f}', '\u{007f}'] {
            names.push(format!("bad{control}name.log"));
        }
        names
    }

    #[test]
    fn git_reftable_table_name_validation_accepts_safe_git_names() {
        for name in [
            REPRESENTATIVE_GIT_REFTABLE_TABLE,
            SPEC_GIT_REFTABLE_LOG,
            SAFE_ARBITRARY_GIT_REFTABLE_TABLE,
            SAFE_DECOMPOSED_GIT_REFTABLE_TABLE,
        ] {
            assert!(
                is_valid_git_reftable_table_name(name),
                "unexpectedly rejected {name}"
            );
        }
    }

    #[test]
    fn git_reftable_table_name_validation_rejects_unsafe_names() {
        for name in invalid_git_reftable_table_names() {
            assert!(
                !is_valid_git_reftable_table_name(&name),
                "unexpectedly accepted {name}"
            );
        }
    }

    #[test]
    fn git_reftable_snapshot_rejects_invalid_table_names_without_publication() {
        for name in invalid_git_reftable_table_names() {
            let tree = TempTree::new("git-reftable-invalid-table-name");
            let source = tree.root.join("source");
            let destination = tree.root.join("destination");
            std::fs::create_dir_all(&source).unwrap();
            write_test_reftable_table_list(&source, &[&name]);

            let error = snapshot_git_reftable_with_limits(
                &source,
                &destination,
                tiny_git_reftable_snapshot_limits(),
            )
            .unwrap_err();

            assert!(
                error.contains("invalid table name") || error.contains("invalid path"),
                "{name}: {error}"
            );
            assert!(!destination.exists(), "{name} must not be published");
        }
    }

    #[test]
    fn git_reftable_windows_child_share_mode_allows_read_and_delete_but_not_write() {
        let share_mode = windows_git_metadata_child_share_mode();

        assert_ne!(share_mode & 0x0001, 0, "read sharing must remain enabled");
        assert_eq!(share_mode & 0x0002, 0, "write sharing must be disabled");
        assert_ne!(share_mode & 0x0004, 0, "delete sharing must remain enabled");
    }

    #[test]
    fn git_reftable_windows_sharing_violation_reports_change() {
        assert_eq!(
            windows_git_metadata_open_error("Git reftable table list", 32)
                .into_message("Git reftable table list"),
            "Git reftable table list changed while being read"
        );
    }

    #[test]
    fn git_metadata_windows_directory_state_ignores_mutable_size_and_time() {
        let before = WindowsGitMetadataState {
            volume_serial_number: 7,
            file_index: 11,
            file_attributes: FILE_ATTRIBUTE_DIRECTORY,
            file_size: 23,
            last_write_time: 29,
        };
        let after = WindowsGitMetadataState {
            file_size: 31,
            last_write_time: 37,
            ..before
        };

        assert!(windows_git_metadata_directory_state_matches(before, after));
    }

    #[test]
    fn git_metadata_windows_directory_state_rejects_identity_reparse_and_type_changes() {
        let directory = WindowsGitMetadataState {
            volume_serial_number: 7,
            file_index: 11,
            file_attributes: FILE_ATTRIBUTE_DIRECTORY,
            file_size: 23,
            last_write_time: 29,
        };

        assert!(!windows_git_metadata_directory_state_matches(
            directory,
            WindowsGitMetadataState {
                volume_serial_number: 13,
                ..directory
            }
        ));
        assert!(!windows_git_metadata_directory_state_matches(
            directory,
            WindowsGitMetadataState {
                file_index: 17,
                ..directory
            }
        ));
        assert!(!windows_git_metadata_directory_state_matches(
            directory,
            WindowsGitMetadataState {
                file_attributes: FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT,
                ..directory
            }
        ));
        assert!(!windows_git_metadata_directory_state_matches(
            directory,
            WindowsGitMetadataState {
                file_attributes: 0,
                ..directory
            }
        ));
    }

    #[test]
    fn git_metadata_windows_file_state_compares_size_and_time() {
        let file = WindowsGitMetadataState {
            volume_serial_number: 7,
            file_index: 11,
            file_attributes: 0,
            file_size: 23,
            last_write_time: 29,
        };

        assert!(windows_git_metadata_file_state_matches(file, file));
        assert!(!windows_git_metadata_file_state_matches(
            file,
            WindowsGitMetadataState {
                file_size: 31,
                ..file
            }
        ));
        assert!(!windows_git_metadata_file_state_matches(
            file,
            WindowsGitMetadataState {
                last_write_time: 37,
                ..file
            }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn git_reftable_snapshot_anchors_children_to_open_directory() {
        let tree = TempTree::new("git-reftable-anchored-directory");
        let source = tree.root.join("source");
        let parked = tree.root.join("parked");
        let replacement = tree.root.join("replacement");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&replacement).unwrap();
        write_test_reftable_table_list(&source, &[TEST_REFTABLE_TABLE_ONE]);
        std::fs::write(source.join(TEST_REFTABLE_TABLE_ONE), b"orig").unwrap();
        write_test_reftable_table_list(&replacement, &[TEST_REFTABLE_TABLE_ONE]);
        std::fs::write(replacement.join(TEST_REFTABLE_TABLE_ONE), b"evil").unwrap();

        snapshot_git_reftable_with_limits_and_hook(
            &source,
            &destination,
            tiny_git_reftable_snapshot_limits(),
            || {
                std::fs::rename(&source, &parked).unwrap();
                std::fs::rename(&replacement, &source).unwrap();
                ReftableSourceSwapGuard {
                    source: source.clone(),
                    parked: parked.clone(),
                    replacement: replacement.clone(),
                }
            },
        )
        .unwrap();

        assert_eq!(
            std::fs::read(destination.join(TEST_REFTABLE_TABLE_ONE)).unwrap(),
            b"orig"
        );
    }

    #[cfg(unix)]
    #[test]
    fn git_reftable_snapshot_rejects_fifo_table_promptly() {
        use std::os::unix::fs::OpenOptionsExt;

        let tree = TempTree::new("git-reftable-fifo-table");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        let fifo = source.join(TEST_REFTABLE_TABLE_ONE);
        std::fs::create_dir_all(&source).unwrap();
        write_test_reftable_table_list(&source, &[TEST_REFTABLE_TABLE_ONE]);
        let fifo_path = c_path(&fifo).unwrap();
        let created = unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) };
        assert_eq!(
            created,
            0,
            "create test FIFO: {}",
            std::io::Error::last_os_error()
        );

        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            let result = snapshot_git_reftable_with_limits(
                &source,
                &destination,
                tiny_git_reftable_snapshot_limits(),
            );
            sender.send(result).unwrap();
        });

        let result = match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(result) => result,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let unblock = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .custom_flags(libc::O_NONBLOCK)
                    .open(&fifo)
                    .unwrap();
                let _ = receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("FIFO reader must unblock for test cleanup");
                drop(unblock);
                worker.join().unwrap();
                panic!("Git reftable FIFO open blocked instead of failing promptly");
            }
            Err(error) => panic!("Git reftable FIFO worker disconnected: {error}"),
        };
        worker.join().unwrap();

        let error = result.unwrap_err();
        assert!(error.contains("not a regular file"));
    }

    #[test]
    fn git_reftable_snapshot_copies_valid_bounded_files() {
        let tree = TempTree::new("git-reftable-valid-snapshot");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        write_test_reftable_table_list(&source, &[TEST_REFTABLE_TABLE_ONE]);
        std::fs::write(source.join(TEST_REFTABLE_TABLE_ONE), b"table").unwrap();

        snapshot_git_reftable_with_limits(
            &source,
            &destination,
            tiny_git_reftable_snapshot_limits(),
        )
        .unwrap();

        assert_eq!(
            std::fs::read(destination.join(TEST_REFTABLE_TABLE_ONE)).unwrap(),
            b"table"
        );
        assert_eq!(
            std::fs::read(destination.join("tables.list")).unwrap(),
            format!("{TEST_REFTABLE_TABLE_ONE}\n").as_bytes()
        );
    }

    #[test]
    fn git_reftable_snapshot_rejects_oversized_table_list() {
        let tree = TempTree::new("git-reftable-large-list");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("tables.list"), vec![b'x'; 33]).unwrap();

        let error = snapshot_git_reftable_with_limits(
            &source,
            &destination,
            tiny_git_reftable_snapshot_limits(),
        )
        .unwrap_err();

        assert!(error.contains("table list is too large"));
        assert!(!destination.exists());
    }

    #[test]
    fn git_reftable_snapshot_rejects_excessive_table_count() {
        let tree = TempTree::new("git-reftable-table-count");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        write_test_reftable_table_list(
            &source,
            &[
                TEST_REFTABLE_TABLE_ONE,
                TEST_REFTABLE_TABLE_TWO,
                TEST_REFTABLE_TABLE_THREE,
            ],
        );
        let limits = GitReftableSnapshotLimits {
            list_bytes: 64,
            ..tiny_git_reftable_snapshot_limits()
        };

        let error = snapshot_git_reftable_with_limits(&source, &destination, limits).unwrap_err();

        assert!(error.contains("too many tables"));
        assert!(!destination.exists());
    }

    #[test]
    fn git_reftable_snapshot_rejects_oversized_table() {
        let tree = TempTree::new("git-reftable-large-table");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        write_test_reftable_table_list(&source, &[TEST_REFTABLE_TABLE_ONE]);
        std::fs::write(source.join(TEST_REFTABLE_TABLE_ONE), b"123456789").unwrap();

        let error = snapshot_git_reftable_with_limits(
            &source,
            &destination,
            tiny_git_reftable_snapshot_limits(),
        )
        .unwrap_err();

        assert!(error.contains(&format!("table {TEST_REFTABLE_TABLE_ONE} is too large")));
        assert!(!destination.exists());
    }

    #[test]
    fn git_reftable_snapshot_rejects_aggregate_overflow() {
        let tree = TempTree::new("git-reftable-aggregate-size");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        write_test_reftable_table_list(
            &source,
            &[TEST_REFTABLE_TABLE_ONE, TEST_REFTABLE_TABLE_TWO],
        );
        std::fs::write(source.join(TEST_REFTABLE_TABLE_ONE), b"12345678").unwrap();
        std::fs::write(source.join(TEST_REFTABLE_TABLE_TWO), b"12345678").unwrap();

        let error = snapshot_git_reftable_with_limits(
            &source,
            &destination,
            tiny_git_reftable_snapshot_limits(),
        )
        .unwrap_err();

        assert!(error.contains("aggregate size"));
        assert!(!destination.exists());
    }

    #[test]
    fn git_reftable_snapshot_caps_reads_to_remaining_aggregate_budget() {
        let tree = TempTree::new("git-reftable-remaining-budget");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        write_test_reftable_table_list(
            &source,
            &[TEST_REFTABLE_TABLE_ONE, TEST_REFTABLE_TABLE_TWO],
        );
        std::fs::write(source.join(TEST_REFTABLE_TABLE_ONE), b"12345678").unwrap();
        std::fs::write(source.join(TEST_REFTABLE_TABLE_TWO), b"12345").unwrap();
        TEST_GIT_METADATA_READ_LIMITS.with(|limits| limits.borrow_mut().clear());

        let error = snapshot_git_reftable_with_limits(
            &source,
            &destination,
            tiny_git_reftable_snapshot_limits(),
        )
        .unwrap_err();

        let read_limits =
            TEST_GIT_METADATA_READ_LIMITS.with(|limits| std::mem::take(&mut *limits.borrow_mut()));
        assert_eq!(read_limits, vec![32, 8, 4]);
        assert_eq!(error, "Git reftable aggregate size is too large");
        assert!(!destination.exists());
    }

    #[test]
    fn git_reftable_snapshot_rejects_linked_tables_when_supported() {
        let tree = TempTree::new("git-reftable-linked-table");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        let linked = tree.root.join("linked.ref");
        std::fs::create_dir_all(&source).unwrap();
        write_test_reftable_table_list(&source, &[TEST_REFTABLE_TABLE_ONE]);
        std::fs::write(&linked, b"linked").unwrap();
        if !create_test_symlink(
            TestSymlinkKind::File,
            &linked,
            &source.join(TEST_REFTABLE_TABLE_ONE),
        ) {
            return;
        }

        let error = snapshot_git_reftable_with_limits(
            &source,
            &destination,
            tiny_git_reftable_snapshot_limits(),
        )
        .unwrap_err();

        assert!(error.contains("not a regular file"));
        assert!(!destination.exists());
    }

    #[test]
    fn git_dir_for_worktree_rejects_a_symlinked_git_directory_marker() {
        let tree = TempTree::new("git-dir-for-worktree-symlinked-dir");
        let root = tree.root.join("root");
        let outside = tree.root.join("outside-git-dir");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        if !create_test_symlink(TestSymlinkKind::Directory, &outside, &root.join(".git")) {
            return;
        }

        let error = git_dir_for_worktree(&root).unwrap_err();

        assert!(error.contains("symlink"), "unexpected error: {error}");
    }

    #[test]
    fn git_dir_for_worktree_rejects_a_symlinked_git_file_marker() {
        let tree = TempTree::new("git-dir-for-worktree-symlinked-file");
        let root = tree.root.join("root");
        let outside = tree.root.join("outside-gitdir-marker");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&outside, "gitdir: ../elsewhere\n").unwrap();
        if !create_test_symlink(TestSymlinkKind::File, &outside, &root.join(".git")) {
            return;
        }

        let error = git_dir_for_worktree(&root).unwrap_err();

        assert!(error.contains("symlink"), "unexpected error: {error}");
    }

    #[test]
    fn git_dir_for_worktree_rejects_an_oversized_linked_worktree_marker() {
        let tree = TempTree::new("git-dir-for-worktree-oversized-marker");
        let root = tree.root.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let oversized = "gitdir: ".to_string()
            + &"a".repeat((MAX_LINKED_WORKTREE_GITDIR_FILE_BYTES + 1) as usize);
        std::fs::write(root.join(".git"), oversized).unwrap();

        let error = git_dir_for_worktree(&root).unwrap_err();

        assert!(error.contains("too large"), "unexpected error: {error}");
    }

    #[test]
    fn git_inspection_rejects_a_symlinked_head_marker() {
        let tree = TempTree::new("git-inspection-symlinked-head");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);

        let outside = tree.root.join("outside-head");
        std::fs::write(&outside, "ref: refs/heads/main\n").unwrap();
        std::fs::remove_file(tree.root.join(".git/HEAD")).unwrap();
        if !create_test_symlink(
            TestSymlinkKind::File,
            &outside,
            &tree.root.join(".git/HEAD"),
        ) {
            return;
        }

        // Call the repository snapshot directly rather than through
        // `GitInspection::new`: the config-gathering step ahead of it shells
        // out to the real `git` binary, which itself refuses a repository
        // whose HEAD marker was replaced with a symlink (with an unrelated
        // "not a git repository" style error) before this crate's own
        // pinned-handle read is ever reached. Bypassing that lets this test
        // isolate the guarantee this fix actually adds: `snapshot`'s own
        // read of HEAD must reject a symlinked marker rather than follow it.
        let error = match GitInspectionRepository::snapshot(path_text(&tree.root), None, Vec::new())
        {
            Ok(_) => panic!("a symlinked HEAD marker must be rejected"),
            Err(error) => error,
        };

        // The pinned read classifies the marker with a no-follow check and
        // rejects anything other than a regular file before ever opening
        // it, so a symlink surfaces as "not a regular file" rather than
        // being silently followed.
        assert!(
            error.contains("not a regular file"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn git_inspection_rejects_a_symlinked_commondir_marker() {
        let tree = TempTree::new("git-inspection-symlinked-commondir");
        let source = tree.root.join("source");
        let linked = tree.root.join("linked");
        std::fs::create_dir_all(&source).unwrap();
        run_test_git(&source, &["init", "-q"]);
        run_test_git(&source, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &source,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(source.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&source, &["add", "tracked.txt"]);
        run_test_git(&source, &["commit", "-qm", "baseline"]);
        run_test_git(
            &source,
            &[
                "worktree",
                "add",
                "-q",
                "--detach",
                path_text(&linked),
                "HEAD",
            ],
        );

        let (_, linked_git_dir) = git_dir_for_worktree(&linked).unwrap();
        let real_commondir = linked_git_dir.join("commondir");
        assert!(real_commondir.is_file());
        let outside = tree.root.join("outside-commondir");
        std::fs::copy(&real_commondir, &outside).unwrap();
        std::fs::remove_file(&real_commondir).unwrap();
        if !create_test_symlink(TestSymlinkKind::File, &outside, &real_commondir) {
            return;
        }

        let error = match GitInspection::new(path_text(&linked)) {
            Ok(_) => panic!("a symlinked commondir marker must be rejected"),
            Err(error) => error,
        };

        // The pinned read classifies the marker via the same no-follow,
        // fd-relative open that performs the read, so a symlink surfaces
        // as "not a regular file" rather than being silently followed or
        // misclassified by a separate, racy path-based check.
        assert!(
            error.contains("not a regular file"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn git_inspection_rejects_a_worktree_whose_git_directory_marker_is_a_symlink() {
        // `git_dir_for_worktree_rejects_a_symlinked_git_directory_marker`
        // already proves `git_dir_for_worktree` itself rejects this in
        // isolation. This test proves the same guarantee holds at the
        // entrypoint external callers actually use,
        // `GitInspectionRepository::snapshot`, which resolves the path via
        // `git_dir_for_worktree` internally: a symlinked `.git` directory
        // marker must still be rejected once routed through the full
        // snapshot call, not merely when calling the classification helper
        // directly. It does not, by itself, exercise a marker swapped
        // *between* that classification and `snapshot`'s later no-follow
        // open of the resolved Git directory (`git_dir_handle`); that
        // narrower race window is closed structurally by `open_directory_no_follow`
        // using `O_NOFOLLOW`, which fails closed rather than following a
        // symlink regardless of when the swap happens.
        let tree = TempTree::new("git-inspection-symlinked-git-directory");
        let root = tree.root.join("root");
        let outside = tree.root.join("outside-git-dir");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        if !create_test_symlink(TestSymlinkKind::Directory, &outside, &root.join(".git")) {
            return;
        }

        let error = match GitInspectionRepository::snapshot(path_text(&root), None, Vec::new()) {
            Ok(_) => panic!("a symlinked .git directory marker must be rejected"),
            Err(error) => error,
        };

        assert!(error.contains("symlink"), "unexpected error: {error}");
    }

    #[test]
    fn git_inspection_uses_snapshotted_index_after_git_dir_replacement() {
        let tree = TempTree::new("git-index-handoff-dir-swap");
        let source = tree.root.join("source");
        let linked = tree.root.join("linked");
        let parked = tree.root.join("parked-linked-git-dir");
        let replacement = tree.root.join("replacement-linked-git-dir");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&replacement).unwrap();
        run_test_git(&source, &["init", "-q"]);
        run_test_git(&source, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &source,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(source.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&source, &["add", "tracked.txt"]);
        run_test_git(&source, &["commit", "-qm", "baseline"]);
        run_test_git(
            &source,
            &["worktree", "add", "-q", "-b", "linked", path_text(&linked)],
        );

        std::fs::write(linked.join("tracked.txt"), "after\n").unwrap();
        let inspection = GitInspection::new(path_text(&linked)).unwrap();
        let (_, linked_git_dir) = git_dir_for_worktree(&linked).unwrap();
        std::fs::rename(&linked_git_dir, &parked).unwrap();
        if !create_test_symlink(TestSymlinkKind::Directory, &replacement, &linked_git_dir) {
            std::fs::rename(&parked, &linked_git_dir).unwrap();
            return;
        }
        let _restore = DirectoryReplacementGuard {
            path: linked_git_dir.clone(),
            parked: parked.clone(),
        };

        let status = inspection
            .execute(&["status", "--porcelain", "--", "tracked.txt"])
            .unwrap();

        assert!(
            status.contains(" M tracked.txt"),
            "unexpected status: {status:?}"
        );
    }

    #[test]
    fn git_inspection_uses_snapshotted_objects_after_common_dir_replacement() {
        let tree = TempTree::new("git-object-snapshot-dir-swap");
        let parked = tree.root.join("parked-common-git-dir");
        let replacement = tree.root.join("replacement-common-git-dir");
        std::fs::create_dir_all(replacement.join("objects")).unwrap();
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        let expected_head = run_test_git_stdout_with_env(&tree.root, &["rev-parse", "HEAD"], &[])
            .trim()
            .to_string();

        let inspection = GitInspection::new(path_text(&tree.root)).unwrap();
        let common_dir = tree.root.join(".git");
        std::fs::rename(&common_dir, &parked).unwrap();
        if !create_test_symlink(TestSymlinkKind::Directory, &replacement, &common_dir) {
            std::fs::rename(&parked, &common_dir).unwrap();
            return;
        }
        let _restore = DirectoryReplacementGuard {
            path: common_dir.clone(),
            parked: parked.clone(),
        };

        let head = inspection.execute(&["rev-parse", "HEAD"]).unwrap();

        assert_eq!(head.trim(), expected_head);
    }

    #[test]
    fn git_inspection_preserves_reftable_refs_when_supported() {
        let tree = TempTree::new("git-reftable-inspection");
        let init = std::process::Command::new("git")
            .current_dir(&tree.root)
            .args(["init", "-q", "-b", "main", "--ref-format=reftable"])
            .output()
            .expect("git init must run in tests");
        if !init.status.success() {
            assert!(
                !String::from_utf8_lossy(&init.stderr).trim().is_empty(),
                "Git without reftable support must reject the requested ref format clearly"
            );
            return;
        }
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&tree.root, &["config", "core.autocrlf", "false"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let status = git_status(path_text(&tree.root).to_string()).unwrap();
        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();
        let log = git_log(path_text(&tree.root).to_string(), Some(1)).unwrap();

        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "tracked.txt");
        assert!(diff.text.contains("+after"));
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "baseline");
    }

    #[test]
    fn git_log_succeeds_for_a_bare_repository() {
        let tree = TempTree::new("git-log-bare");
        let source = tree.root.join("source");
        let bare = tree.root.join("bare.git");
        std::fs::create_dir_all(&source).unwrap();
        run_test_git(&source, &["init", "-q"]);
        run_test_git(&source, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &source,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(source.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&source, &["add", "tracked.txt"]);
        run_test_git(&source, &["commit", "-qm", "baseline"]);
        run_test_git(
            &tree.root,
            &["clone", "--bare", path_text(&source), path_text(&bare)],
        );

        let log = git_log(path_text(&bare).to_string(), Some(1)).unwrap();

        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "baseline");
    }

    #[test]
    fn git_log_does_not_misclassify_worktree_files_as_a_bare_repository() {
        let tree = TempTree::new("git-log-worktree-bare-markers");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("HEAD"), "tracked worktree file\n").unwrap();
        std::fs::create_dir_all(tree.root.join("objects")).unwrap();
        std::fs::write(
            tree.root.join("objects/tracked.txt"),
            "tracked worktree file\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "HEAD", "objects/tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);

        let log = git_log(path_text(&tree.root).to_string(), Some(1)).unwrap();

        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "baseline");
    }

    #[test]
    fn git_log_does_not_execute_repository_signature_verifier_from_local_include() {
        let tree = TempTree::new("git-log-signature-verifier");
        let helper = tree.root.join("signature-verifier.sh");
        let marker = tree.root.join("signature-verifier-ran");
        let include = tree.root.join("signature-verifier.cfg");
        std::fs::write(
            &helper,
            format!(
                "#!/bin/sh\ntouch {}\n",
                shell_single_quote(&shell_path(&marker))
            ),
        )
        .unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&tree.root, &["config", "commit.gpgSign", "false"]);
        run_test_git(&tree.root, &["commit", "--allow-empty", "-qm", "baseline"]);

        let unsigned =
            run_test_git_stdout_with_env(&tree.root, &["cat-file", "commit", "HEAD"], &[]);
        let (headers, message) = unsigned
            .split_once("\n\n")
            .expect("commit object must contain headers and a message");
        let signed = format!(
            "{headers}\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\n{message}"
        );
        let mut hash = std::process::Command::new("git")
            .current_dir(&tree.root)
            .args(["hash-object", "-t", "commit", "-w", "--stdin"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("git hash-object must run in tests");
        hash.stdin
            .take()
            .expect("git hash-object stdin must be piped")
            .write_all(signed.as_bytes())
            .unwrap();
        let hash = hash.wait_with_output().unwrap();
        assert!(
            hash.status.success(),
            "git hash-object failed: {}",
            String::from_utf8_lossy(&hash.stderr)
        );
        let signed_oid = String::from_utf8(hash.stdout).unwrap();
        run_test_git(&tree.root, &["update-ref", "HEAD", signed_oid.trim()]);

        std::fs::write(
            &include,
            format!(
                "[log]\n\tshowSignature = true\n[gpg]\n\tformat = openpgp\n\tprogram = {}\n",
                shell_path(&helper)
            ),
        )
        .unwrap();
        run_test_git(&tree.root, &["config", "include.path", path_text(&include)]);

        let raw = std::process::Command::new("git")
            .current_dir(&tree.root)
            .args(["--no-pager", "log", "-n", "1", "--pretty=format:%s"])
            .output()
            .expect("git log must run in tests");
        assert!(
            raw.status.success(),
            "raw git log positive control must succeed: {}",
            String::from_utf8_lossy(&raw.stderr)
        );
        assert!(
            marker.exists(),
            "raw git log must execute the repository-selected signature verifier"
        );
        std::fs::remove_file(&marker).unwrap();

        let log = git_log(path_text(&tree.root).to_string(), Some(1)).unwrap();

        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "baseline");
        assert!(
            !marker.exists(),
            "hardened git_log must ignore repository signature-verification config"
        );
    }

    #[test]
    fn git_status_and_diff_preserve_trusted_global_attributes_in_reftable_repositories() {
        let tree = TempTree::new("git-reftable-global-clean-filter");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        let helper = tree.root.join("shadow-reftable-clean-filter.sh");
        let marker = tree.root.join("shadow-reftable-clean-filter-ran");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        write_marker_executable(&helper);
        std::fs::write(
            &global_config,
            format!(
                "[filter \"trusted-normalize\"]\n\tclean = {}\n\trequired = true\n",
                trusted_normalizing_clean_command()
            ),
        )
        .unwrap();

        let init = std::process::Command::new("git")
            .current_dir(&project)
            .args(["init", "-q", "-b", "main", "--ref-format=reftable"])
            .output()
            .expect("git init must run in tests");
        if !init.status.success() {
            let stderr = String::from_utf8_lossy(&init.stderr);
            assert!(
                stderr.contains("reftable")
                    || stderr.contains("ref-format")
                    || stderr.contains("unknown option"),
                "Git without reftable support must fail the exact reftable capability probe clearly: {}",
                stderr.trim()
            );
            eprintln!("skipping reftable-only regression: {}", stderr.trim());
            return;
        }
        run_test_git(&project, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &project,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&project, &["config", "core.autocrlf", "false"]);
        std::fs::write(
            project.join(".gitattributes"),
            "tracked.txt filter=trusted-normalize\n",
        )
        .unwrap();
        std::fs::write(project.join("tracked.txt"), "same content   \n").unwrap();

        let env = [
            ("HOME", path_text(&home)),
            ("GIT_CONFIG_GLOBAL", path_text(&global_config)),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ];
        run_test_git_with_env(&project, &["add", "tracked.txt", ".gitattributes"], &env);
        run_test_git_with_env(&project, &["commit", "-qm", "baseline"], &env);

        run_test_git(
            &project,
            &[
                "config",
                "filter.trusted-normalize.clean",
                &format!("{}; cat", marker_command(&helper, &marker)),
            ],
        );
        run_test_git(
            &project,
            &["config", "filter.trusted-normalize.required", "true"],
        );
        std::fs::write(project.join("tracked.txt"), "same content\t\t\t\n").unwrap();

        let raw_status =
            run_test_git_stdout_with_env(&project, &["status", "--porcelain", "--", "."], &env);
        assert!(
            !raw_status.trim().is_empty(),
            "shadowing local clean filter should dirty raw git status in reftable repos: {raw_status:?}"
        );
        if marker.exists() {
            std::fs::remove_file(&marker).unwrap();
        }

        let raw_diff = run_test_git_stdout_with_env(
            &project,
            &["diff", "--no-color", "--relative", "--", "tracked.txt"],
            &env,
        );
        assert!(
            !raw_diff.trim().is_empty(),
            "shadowing local clean filter should dirty raw git diff in reftable repos: {raw_diff:?}"
        );
        assert!(
            marker.exists(),
            "shadowing local clean filter should execute during raw git diff in reftable repos"
        );
        std::fs::remove_file(&marker).unwrap();

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);

        let status = git_status(path_text(&project).to_string()).unwrap();
        assert!(
            status.files.is_empty(),
            "isolated git_status must preserve committed reftable attributes: {:?}",
            status.files
        );

        let diff = git_diff(path_text(&project).to_string(), None, Some(false), None).unwrap();
        assert!(
            diff.text.is_empty(),
            "isolated git_diff must preserve committed reftable attributes"
        );
        assert_eq!(diff.bytes, 0);
        assert_eq!(diff.lines, 0);
        assert!(!diff.truncated);
        assert!(
            !marker.exists(),
            "isolated inspection must keep blocking repo-owned executable filters in reftable repos"
        );
    }

    #[test]
    fn reftable_probe_failures_return_an_explicit_unsupported_error() {
        let error =
            validate_git_ref_storage("reftable", Err("unknown option".to_string())).unwrap_err();

        assert_eq!(
            error,
            "installed Git does not support reftable ref storage: unknown option"
        );
    }

    #[test]
    fn git_diff_does_not_execute_repository_clean_filter() {
        let tree = TempTree::new("git-clean-filter");
        let helper = tree.root.join("clean-filter.sh");
        let marker = tree.root.join("clean-filter-ran");
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=psyche-clean\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                "filter.psyche-clean.clean",
                &format!("{}; cat", marker_command(&helper, &marker)),
            ],
        );
        run_test_git(
            &tree.root,
            &["config", "filter.psyche-clean.required", "true"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let output = std::process::Command::new("git")
            .current_dir(&tree.root)
            .args(["diff", "--no-color", "--relative", "--", "tracked.txt"])
            .output()
            .expect("git diff must run in tests");
        assert!(
            output.status.success(),
            "raw git diff positive control must succeed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("+after"),
            "raw git diff positive control must include the tracked change"
        );
        assert!(
            marker.exists(),
            "raw git diff positive control must execute the configured clean filter"
        );
        std::fs::remove_file(&marker).unwrap();

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
        assert!(
            !marker.exists(),
            "hardened git_diff must not execute repository clean filters"
        );
    }

    #[test]
    fn git_diff_does_not_execute_command_scope_clean_filter() {
        let tree = TempTree::new("git-command-clean-filter");
        let helper = tree.root.join("command-clean-filter.sh");
        let marker = tree.root.join("command-clean-filter-ran");
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=command-clean\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let command = format!("{}; cat", marker_command(&helper, &marker));
        let env = [
            ("GIT_CONFIG_COUNT", "2"),
            ("GIT_CONFIG_KEY_0", "filter.command-clean.clean"),
            ("GIT_CONFIG_VALUE_0", command.as_str()),
            ("GIT_CONFIG_KEY_1", "filter.command-clean.required"),
            ("GIT_CONFIG_VALUE_1", "true"),
        ];
        let raw_diff = run_test_git_stdout_with_env(
            &tree.root,
            &["diff", "--no-color", "--relative", "--", "tracked.txt"],
            &env,
        );
        assert!(raw_diff.contains("+after"));
        assert!(
            marker.exists(),
            "raw git diff must execute the command-scope clean filter"
        );
        std::fs::remove_file(&marker).unwrap();

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("GIT_CONFIG_COUNT", Some(OsStr::new("2"))),
            (
                "GIT_CONFIG_KEY_0",
                Some(OsStr::new("filter.command-clean.clean")),
            ),
            ("GIT_CONFIG_VALUE_0", Some(command.as_ref())),
            (
                "GIT_CONFIG_KEY_1",
                Some(OsStr::new("filter.command-clean.required")),
            ),
            ("GIT_CONFIG_VALUE_1", Some(OsStr::new("true"))),
        ]);

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
        assert!(
            !marker.exists(),
            "hardened git_diff must not execute command-scope clean filters"
        );
    }

    #[test]
    fn git_diff_does_not_execute_git_config_parameters_clean_filter() {
        let tree = TempTree::new("git-parameters-clean-filter");
        let helper = tree.root.join("parameters-clean-filter.sh");
        let marker = tree.root.join("parameters-clean-filter-ran");
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=parameters-clean\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let command = format!("{}; cat", marker_command(&helper, &marker));
        let parameters = format!(
            "'filter.parameters-clean.clean'='{}' 'filter.parameters-clean.required'='true'",
            command.replace('\'', "'\\''")
        );
        let env = [("GIT_CONFIG_PARAMETERS", parameters.as_str())];
        let raw_diff = run_test_git_stdout_with_env(
            &tree.root,
            &["diff", "--no-color", "--relative", "--", "tracked.txt"],
            &env,
        );
        assert!(raw_diff.contains("+after"));
        assert!(
            marker.exists(),
            "raw git diff must execute the GIT_CONFIG_PARAMETERS clean filter"
        );
        std::fs::remove_file(&marker).unwrap();

        let _git_env =
            TestGitEnvOverrideGuard::set(&[("GIT_CONFIG_PARAMETERS", Some(parameters.as_ref()))]);
        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
        assert!(
            !marker.exists(),
            "hardened git_diff must not execute GIT_CONFIG_PARAMETERS clean filters"
        );
    }

    #[test]
    fn git_diff_neutralizes_repository_required_only_filter() {
        let tree = TempTree::new("git-required-only-filter");
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=required-only\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        run_test_git(
            &tree.root,
            &["config", "filter.required-only.required", "true"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let raw = std::process::Command::new("git")
            .current_dir(&tree.root)
            .args(["diff", "--no-color", "--relative", "--", "tracked.txt"])
            .output()
            .expect("git diff must run in tests");
        assert!(
            !raw.status.success(),
            "raw git diff must reject a required filter without a command"
        );

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
    }

    #[test]
    fn git_status_and_diff_restore_trusted_global_clean_filters_under_local_shadow() {
        let tree = TempTree::new("git-global-clean-filter");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        let helper = tree.root.join("shadow-clean-filter.sh");
        let marker = tree.root.join("shadow-clean-filter-ran");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        write_marker_executable(&helper);
        std::fs::write(
            &global_config,
            format!(
                "[filter \"trusted-normalize\"]\n\tclean = {}\n\trequired = true\n",
                trusted_normalizing_clean_command()
            ),
        )
        .unwrap();

        run_test_git(&project, &["init", "-q"]);
        run_test_git(&project, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &project,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&project, &["config", "core.autocrlf", "false"]);
        std::fs::write(
            project.join(".gitattributes"),
            "tracked.txt filter=trusted-normalize\n",
        )
        .unwrap();
        std::fs::write(project.join("tracked.txt"), "same content   \n").unwrap();

        let env = [
            ("HOME", path_text(&home)),
            ("GIT_CONFIG_GLOBAL", path_text(&global_config)),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ];
        run_test_git_with_env(&project, &["add", "tracked.txt", ".gitattributes"], &env);
        run_test_git_with_env(&project, &["commit", "-qm", "baseline"], &env);

        let raw_status =
            run_test_git_stdout_with_env(&project, &["status", "--porcelain", "--", "."], &env);
        assert!(
            raw_status.trim().is_empty(),
            "trusted global clean filter should start with a clean raw git status: {raw_status:?}"
        );

        std::fs::write(project.join("tracked.txt"), "same content   \n").unwrap();
        let raw_status =
            run_test_git_stdout_with_env(&project, &["status", "--porcelain", "--", "."], &env);
        assert!(
            raw_status.trim().is_empty(),
            "trusted global clean filter should keep raw git status clean: {raw_status:?}"
        );

        run_test_git(
            &project,
            &[
                "config",
                "filter.trusted-normalize.clean",
                &format!("{}; cat", marker_command(&helper, &marker)),
            ],
        );
        run_test_git(
            &project,
            &["config", "filter.trusted-normalize.required", "true"],
        );
        std::fs::write(project.join("tracked.txt"), "same content\t\t\n").unwrap();

        let raw_status =
            run_test_git_stdout_with_env(&project, &["status", "--porcelain", "--", "."], &env);
        assert!(
            !raw_status.trim().is_empty(),
            "shadowing local clean filter should dirty raw git status: {raw_status:?}"
        );
        if marker.exists() {
            std::fs::remove_file(&marker).unwrap();
        }

        std::fs::write(project.join("tracked.txt"), "same content\t\t\t\n").unwrap();
        let raw_diff = run_test_git_stdout_with_env(
            &project,
            &["diff", "--no-color", "--relative", "--", "tracked.txt"],
            &env,
        );
        assert!(
            !raw_diff.trim().is_empty(),
            "shadowing local clean filter should dirty raw git diff: {raw_diff:?}"
        );
        assert!(
            marker.exists(),
            "shadowing local clean filter should execute during raw git diff"
        );
        std::fs::remove_file(&marker).unwrap();

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);

        let overrides = git_filter_driver_overrides(path_text(&project)).unwrap();
        assert_eq!(
            overrides,
            vec![GitFilterDriverOverride {
                driver: "trusted-normalize".to_string(),
                clean: Some(trusted_normalizing_clean_command().to_string()),
                process: None,
                required: Some(true),
                repository_clean: true,
                repository_process: false,
            }]
        );

        let status = git_status(path_text(&project).to_string()).unwrap();
        assert!(
            status.files.is_empty(),
            "isolated trusted-filter status files: {:?}",
            status.files
        );

        let diff = git_diff(path_text(&project).to_string(), None, Some(false), None).unwrap();
        assert!(diff.text.is_empty());
        assert_eq!(diff.bytes, 0);
        assert_eq!(diff.lines, 0);
        assert!(!diff.truncated);
        assert!(
            !marker.exists(),
            "hardened git inspection must not execute the shadowing local clean filter"
        );
    }

    #[test]
    fn git_status_and_diff_preserve_trusted_worktree_info_attributes() {
        let tree = TempTree::new("git-worktree-info-attributes");
        let repository = tree.root.join("repository");
        let linked = tree.root.join("linked");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        std::fs::create_dir_all(&repository).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            &global_config,
            format!(
                "[filter \"trusted-normalize\"]\n\tclean = {}\n\trequired = true\n",
                trusted_normalizing_clean_command()
            ),
        )
        .unwrap();

        run_test_git(&repository, &["init", "-q"]);
        run_test_git(&repository, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &repository,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(repository.join("tracked.txt"), "seed\n").unwrap();
        run_test_git(&repository, &["add", "tracked.txt"]);
        run_test_git(&repository, &["commit", "-qm", "seed"]);
        run_test_git(
            &repository,
            &["worktree", "add", "-q", "-b", "linked", path_text(&linked)],
        );

        let (_, linked_git_dir) = git_dir_for_worktree(&linked).unwrap();
        let common_git_dir = git_common_dir(&linked_git_dir).unwrap();
        std::fs::create_dir_all(common_git_dir.join("info")).unwrap();
        std::fs::write(
            common_git_dir.join("info/attributes"),
            "tracked.txt filter=trusted-normalize\n",
        )
        .unwrap();
        std::fs::write(linked.join("tracked.txt"), "same content   \n").unwrap();

        let env = [
            ("HOME", path_text(&home)),
            ("GIT_CONFIG_GLOBAL", path_text(&global_config)),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ];
        run_test_git_with_env(&linked, &["add", "tracked.txt"], &env);
        run_test_git_with_env(&linked, &["commit", "-qm", "baseline"], &env);

        std::fs::write(linked.join("tracked.txt"), "same content\t\t\t\n").unwrap();
        let raw_status =
            run_test_git_stdout_with_env(&linked, &["status", "--porcelain", "--", "."], &env);
        assert!(
            raw_status.trim().is_empty(),
            "worktree info/attributes should keep raw git status clean: {raw_status:?}"
        );
        let raw_diff = run_test_git_stdout_with_env(
            &linked,
            &["diff", "--no-color", "--relative", "--", "."],
            &env,
        );
        assert!(
            raw_diff.trim().is_empty(),
            "worktree info/attributes should keep raw git diff clean: {raw_diff:?}"
        );

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);
        let status = git_status(path_text(&linked).to_string()).unwrap();
        let diff = git_diff(path_text(&linked).to_string(), None, Some(false), None).unwrap();

        assert!(status.files.is_empty());
        assert!(diff.text.is_empty());
        assert_eq!(diff.bytes, 0);
        assert_eq!(diff.lines, 0);
        assert!(!diff.truncated);
    }

    #[test]
    fn git_status_and_diff_preserve_trusted_worktree_info_exclude() {
        let tree = TempTree::new("git-worktree-info-exclude");
        let repository = tree.root.join("repository");
        let linked = tree.root.join("linked");
        std::fs::create_dir_all(&repository).unwrap();

        run_test_git(&repository, &["init", "-q"]);
        run_test_git(&repository, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &repository,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(repository.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&repository, &["add", "tracked.txt"]);
        run_test_git(&repository, &["commit", "-qm", "baseline"]);
        run_test_git(
            &repository,
            &["worktree", "add", "-q", "-b", "linked", path_text(&linked)],
        );

        let (_, linked_git_dir) = git_dir_for_worktree(&linked).unwrap();
        let common_git_dir = git_common_dir(&linked_git_dir).unwrap();
        std::fs::create_dir_all(common_git_dir.join("info")).unwrap();
        std::fs::write(common_git_dir.join("info/exclude"), "ignored.txt\n").unwrap();
        std::fs::write(linked.join("ignored.txt"), "ignored\n").unwrap();

        let raw_status =
            run_test_git_stdout_with_env(&linked, &["status", "--porcelain", "--", "."], &[]);
        assert!(
            raw_status.trim().is_empty(),
            "worktree info/exclude should hide ignored untracked files from raw git status: {raw_status:?}"
        );

        let status = git_status(path_text(&linked).to_string()).unwrap();
        let diff = git_diff(path_text(&linked).to_string(), None, Some(false), None).unwrap();

        assert!(status.files.is_empty());
        assert!(diff.text.is_empty());
        assert_eq!(diff.bytes, 0);
        assert_eq!(diff.lines, 0);
        assert!(!diff.truncated);
    }

    #[test]
    fn git_info_metadata_rejects_symlinked_info_directory_when_supported() {
        let tree = TempTree::new("git-info-linked-dir");
        let git_dir = tree.root.join("source.git");
        let outside_info = tree.root.join("outside-info");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::create_dir_all(&outside_info).unwrap();
        std::fs::write(outside_info.join("attributes"), "tracked.txt text\n").unwrap();
        if !create_test_symlink(
            TestSymlinkKind::Directory,
            &outside_info,
            &git_dir.join("info"),
        ) {
            return;
        }

        let error = read_git_info_file(&git_dir, "attributes").unwrap_err();

        assert!(error.contains("Git info directory"));
        assert!(error.contains("real directory"));
    }

    #[test]
    fn git_info_metadata_rejects_symlinked_child_files_when_supported() {
        for name in ["attributes", "exclude"] {
            let label = format!("git-info-linked-file-{name}");
            let tree = TempTree::new(&label);
            let git_dir = tree.root.join("source.git");
            let info_dir = git_dir.join("info");
            let outside = tree.root.join(format!("outside-{name}"));
            std::fs::create_dir_all(&info_dir).unwrap();
            std::fs::write(&outside, format!("{name}\n")).unwrap();
            if !create_test_symlink(TestSymlinkKind::File, &outside, &info_dir.join(name)) {
                return;
            }

            let error = read_git_info_file(&git_dir, name).unwrap_err();

            assert!(error.contains(&format!("Git info/{name}")));
            assert!(error.contains("regular file"));
        }
    }

    #[test]
    fn git_diff_does_not_execute_repository_clean_filter_from_local_include() {
        let tree = TempTree::new("git-clean-filter-include");
        let helper = tree.root.join("clean-filter-include.sh");
        let marker = tree.root.join("clean-filter-include-ran");
        let include = tree.root.join("filter-include.cfg");
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=psyche-include\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        std::fs::write(
            &include,
            format!(
                "[filter \"psyche-include\"]\n\tclean = {}; cat\n\trequired = true\n",
                marker_command(&helper, &marker)
            ),
        )
        .unwrap();
        run_test_git(&tree.root, &["config", "include.path", path_text(&include)]);
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let output = std::process::Command::new("git")
            .current_dir(&tree.root)
            .args(["diff", "--no-color", "--relative", "--", "tracked.txt"])
            .output()
            .expect("git diff must run in tests");
        assert!(
            output.status.success(),
            "raw git diff positive control must succeed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        assert!(
            marker.exists(),
            "raw git diff positive control must execute the included clean filter"
        );
        std::fs::remove_file(&marker).unwrap();

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
        assert!(
            !marker.exists(),
            "hardened git_diff must not execute repository clean filters loaded through local includes"
        );
    }

    #[test]
    fn git_diff_does_not_execute_repository_diff_helpers() {
        let tree = TempTree::new("git-external-diff");
        let helper = tree.root.join("external-diff.sh");
        let marker = tree.root.join("external-diff-ran");
        write_marker_executable(&helper);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        run_test_git(
            &tree.root,
            &["config", "diff.external", &marker_command(&helper, &marker)],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        run_test_git(
            &tree.root,
            &["diff", "--no-color", "--relative", "--", "tracked.txt"],
        );
        assert!(
            marker.exists(),
            "unhardened git diff must execute the configured helper"
        );
        std::fs::remove_file(&marker).unwrap();

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
        assert!(!marker.exists());
    }

    #[test]
    fn git_diff_does_not_execute_repository_process_filter() {
        let tree = TempTree::new("git-process-filter");
        let helper = tree.root.join("process-filter.sh");
        let marker = tree.root.join("process-filter-ran");
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=psyche-process\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                "filter.psyche-process.process",
                &marker_command(&helper, &marker),
            ],
        );
        run_test_git(
            &tree.root,
            &["config", "filter.psyche-process.required", "true"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let output = std::process::Command::new("git")
            .current_dir(&tree.root)
            .args(["diff", "--no-color", "--relative", "--", "tracked.txt"])
            .output()
            .expect("git diff must run in tests");
        assert!(
            marker.exists(),
            "unhardened raw git diff must execute the configured process filter (status: {}, stderr: {})",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        std::fs::remove_file(&marker).unwrap();

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
        assert!(
            !marker.exists(),
            "hardened git_diff must not execute repository process filters"
        );
    }

    #[test]
    fn git_diff_does_not_execute_repository_process_filter_from_worktree_include() {
        let tree = TempTree::new("git-process-filter-worktree-include");
        let helper = tree.root.join("process-filter-worktree-include.sh");
        let marker = tree.root.join("process-filter-worktree-include-ran");
        let include = tree.root.join("worktree-filter-include.cfg");
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=psyche-worktree-include\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        run_test_git(&tree.root, &["config", "extensions.worktreeConfig", "true"]);
        std::fs::write(
            &include,
            format!(
                "[filter \"psyche-worktree-include\"]\n\tprocess = {}\n\trequired = true\n",
                marker_command(&helper, &marker)
            ),
        )
        .unwrap();
        run_test_git(
            &tree.root,
            &["config", "--worktree", "include.path", path_text(&include)],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let output = std::process::Command::new("git")
            .current_dir(&tree.root)
            .args(["diff", "--no-color", "--relative", "--", "tracked.txt"])
            .output()
            .expect("git diff must run in tests");
        assert!(
            marker.exists(),
            "raw git diff positive control must execute the worktree-included process filter (status: {}, stderr: {})",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        std::fs::remove_file(&marker).unwrap();

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
        assert!(
            !marker.exists(),
            "hardened git_diff must not execute repository process filters loaded through worktree includes"
        );
    }

    #[test]
    fn git_inspection_does_not_execute_a_filter_added_after_policy_construction() {
        let tree = TempTree::new("git-filter-policy-race");
        let helper = if cfg!(windows) {
            tree.root.join("late-filter.bat")
        } else {
            tree.root.join("late-filter.sh")
        };
        let marker = tree.root.join("late-filter-ran");
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=late-filter\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);

        let inspection = GitInspection::new(path_text(&tree.root)).unwrap();

        run_test_git(
            &tree.root,
            &[
                "config",
                "filter.late-filter.clean",
                &format!("{}; cat", marker_command(&helper, &marker)),
            ],
        );
        run_test_git(
            &tree.root,
            &["config", "filter.late-filter.required", "true"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let diff = inspection
            .execute(&[
                "--no-pager",
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--relative",
                "--",
                "tracked.txt",
            ])
            .unwrap();

        assert!(diff.contains("+after"));
        assert!(
            !marker.exists(),
            "an inspection must not reread repository filter config after its policy is constructed"
        );
    }

    #[test]
    fn git_inspection_does_not_read_attributes_added_after_policy_construction() {
        let tree = TempTree::new("git-attribute-policy-race");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        let helper = if cfg!(windows) {
            tree.root.join("trusted-late-filter.bat")
        } else {
            tree.root.join("trusted-late-filter.sh")
        };
        let marker = tree.root.join("trusted-late-filter-ran");
        std::fs::create_dir_all(&home).unwrap();
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::write(
            &global_config,
            format!(
                "[filter \"trusted-late-filter\"]\n\tclean = {}; cat\n\trequired = true\n",
                marker_command(&helper, &marker)
            ),
        )
        .unwrap();
        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);

        let inspection = GitInspection::new(path_text(&tree.root)).unwrap();

        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=trusted-late-filter\n",
        )
        .unwrap();
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();
        let diff = inspection
            .execute(&[
                "--no-pager",
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--relative",
                "--",
                "tracked.txt",
            ])
            .unwrap();

        assert!(diff.contains("+after"));
        assert!(
            !marker.exists(),
            "an inspection must keep using its immutable attribute tree"
        );
    }

    #[test]
    fn git_status_and_diff_stay_inside_a_nested_project_root() {
        let tree = TempTree::new("git-scope");
        let project = tree.root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(tree.root.join("outside.txt"), "outside baseline\n").unwrap();
        std::fs::write(project.join("inside.txt"), "inside baseline\n").unwrap();
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&tree.root, &["config", "core.autocrlf", "false"]);
        run_test_git(&tree.root, &["add", "."]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::write(tree.root.join("outside.txt"), "outside changed\n").unwrap();
        std::fs::write(project.join("inside.txt"), "inside changed\n").unwrap();

        let status = git_status(path_text(&project).to_string()).unwrap();
        assert_eq!(
            status.files.len(),
            1,
            "unexpected nested-root status files: {:?}",
            status.files
        );
        assert_eq!(status.files[0].path, "inside.txt");

        let diff = git_diff(
            path_text(&project).to_string(),
            Some("inside.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();
        assert!(diff.text.contains("+inside changed"));
        assert!(!diff.text.contains("outside changed"));
        assert!(!diff.truncated);
        assert_eq!(diff.bytes, diff.text.len() as u64);
        assert_eq!(diff.lines, diff.text.lines().count() as u64);
    }

    #[test]
    fn bounded_diffs_stop_before_a_split_utf8_character() {
        let mut full = "a".repeat(MAX_DIFF_BYTES - 1);
        full.push('💖');

        let diff = bounded_diff(full);

        assert!(diff.truncated);
        assert_eq!(diff.text.len(), MAX_DIFF_BYTES - 1);
        assert_eq!(diff.bytes, (MAX_DIFF_BYTES + 3) as u64);
        assert_eq!(diff.lines, 1);
        assert!(std::str::from_utf8(diff.text.as_bytes()).is_ok());
    }

    #[test]
    fn caps_large_tracked_git_diffs_with_full_result_metadata() {
        let tree = TempTree::new("large-tracked-diff");
        let target = tree.root.join("large.txt");
        std::fs::write(&target, b"baseline\n").unwrap();
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&tree.root, &["config", "core.autocrlf", "false"]);
        run_test_git(&tree.root, &["add", "large.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::write(&target, b"changed payload\n".repeat(180_000)).unwrap();

        let full = run_git(
            path_text(&tree.root),
            &[
                "--no-pager",
                "diff",
                "--no-color",
                "--relative",
                "--",
                "large.txt",
            ],
        )
        .unwrap();
        assert!(full.len() > MAX_DIFF_BYTES);

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("large.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.truncated);
        assert!(diff.text.len() <= MAX_DIFF_BYTES);
        assert_eq!(
            diff.bytes,
            full.len() as u64,
            "full diff prefix: {:?}; bounded diff prefix: {:?}",
            full.lines().take(8).collect::<Vec<_>>(),
            diff.text.lines().take(8).collect::<Vec<_>>()
        );
        assert_eq!(diff.lines, full.lines().count() as u64);
        assert!(diff.bytes > diff.text.len() as u64);
        assert!(diff.lines > diff.text.lines().count() as u64);
        assert!(std::str::from_utf8(diff.text.as_bytes()).is_ok());
    }

    #[test]
    fn caps_large_untracked_diffs_with_the_same_byte_contract() {
        let tree = TempTree::new("large-untracked-diff");
        run_test_git(&tree.root, &["init", "-q"]);
        let target = tree.root.join("untracked.txt");
        let contents = "untracked payload\n".repeat(150_000);
        std::fs::write(&target, &contents).unwrap();
        let full = format!(
            "--- /dev/null\n+++ b/untracked.txt\n{}",
            contents
                .lines()
                .map(|line| format!("+{line}\n"))
                .collect::<String>()
        );

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("untracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(full.len() > MAX_DIFF_BYTES);
        assert!(diff.truncated);
        assert!(diff.text.len() <= MAX_DIFF_BYTES);
        assert_eq!(diff.bytes, full.len() as u64);
        assert_eq!(diff.lines, full.lines().count() as u64);
        assert!(diff.lines > diff.text.lines().count() as u64);
        assert!(std::str::from_utf8(diff.text.as_bytes()).is_ok());
    }

    #[test]
    fn returns_complete_structured_diff_for_a_small_untracked_file() {
        let tree = TempTree::new("small-untracked-diff");
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("notes.txt"), "one\ntwo\n").unwrap();

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("notes.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();
        let expected = "--- /dev/null\n+++ b/notes.txt\n+one\n+two\n";

        assert_eq!(diff.text, expected);
        assert_eq!(diff.bytes, expected.len() as u64);
        assert_eq!(diff.lines, expected.lines().count() as u64);
        assert!(!diff.truncated);
    }

    #[test]
    fn git_diff_widens_context_and_clamps_the_request() {
        let tree = TempTree::new("git-diff-context");
        run_test_git(&tree.root, &["init", "--quiet"]);
        run_test_git(&tree.root, &["config", "core.autocrlf", "false"]);
        let mut body = String::new();
        for index in 0..40 {
            body.push_str(&format!("line {}\n", index));
        }
        std::fs::write(tree.root.join("wide.txt"), &body).unwrap();
        run_test_git(&tree.root, &["add", "-A"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=t@e",
                "-c",
                "user.name=t",
                "commit",
                "-m",
                "seed",
                "--quiet",
            ],
        );
        let edited = body.replace("line 20\n", "line twenty\n");
        std::fs::write(tree.root.join("wide.txt"), edited).unwrap();

        let narrow = git_diff(
            path_text(&tree.root).to_string(),
            Some("wide.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();
        let wide = git_diff(
            path_text(&tree.root).to_string(),
            Some("wide.txt".to_string()),
            Some(false),
            Some(30),
        )
        .unwrap();
        // More context means more surrounding lines for the same one-line edit.
        assert!(
            wide.text.lines().count() > narrow.text.lines().count(),
            "narrow diff: {:?}; wide diff: {:?}",
            narrow.text,
            wide.text
        );

        // Beyond the cap the request is clamped, not honoured: the argument
        // reaches a subprocess and an unbounded one is not ours to forward.
        let clamped = git_diff(
            path_text(&tree.root).to_string(),
            Some("wide.txt".to_string()),
            Some(false),
            Some(u32::MAX),
        )
        .unwrap();
        assert!(clamped.text.contains("line twenty"));
    }

    #[test]
    fn parses_linked_detached_locked_and_prunable_worktrees() {
        let worktrees = parse_git_worktrees(
            "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n\
             worktree /external/review\nHEAD def\ndetached\nlocked in use\n\n\
             worktree /missing\nHEAD 000\nprunable gitdir file points to non-existent location\n\n",
        );

        assert_eq!(worktrees.len(), 3);
        assert!(worktrees[0].is_main);
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
        assert!(worktrees[1].detached);
        assert_eq!(worktrees[1].lock_reason.as_deref(), Some("in use"));
        assert!(worktrees[2].prunable);
        assert!(worktrees[2].missing);
    }
}
