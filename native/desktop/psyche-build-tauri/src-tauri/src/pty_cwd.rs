//! Resolving and safely opening a PTY's working directory.
//!
//! #197 slice 3, the first half of "start and attach". Given a project root
//! and a requested working directory, this decides whether the request is
//! inside the project and opens it without following a symlink out.
//!
//! **Nothing here spawns anything.** It resolves paths, opens directories and
//! validates what it opened; the launch that uses the result lives in the
//! crate root. That is the property worth preserving: a cwd check that could
//! start a process would be much harder to reason about.
//!
//! `OpenedPtyCwd` and `open_pty_cwd_candidate` are both `cfg`-gated pairs, one
//! definition per platform, because Unix keeps an open descriptor to defeat a
//! rename between check and use while Windows canonicalizes a path instead.
//! Each pair moved whole.
//!
//! `open_pty_cwd` calls `linked_worktree_roots` to accept a cwd inside a
//! linked worktree. Worktree identity is #197 slice 4's concern and has
//! callers beyond this one, so it is a dependency rather than a member; since
//! slice 4 it lives in `git_control` and is imported like any other.

use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

use super::canonical_project_root;
// Worktree identity moved to `git_control` in #197 slice 4. This module's
// header called it a dependency rather than a member; it now imports it as
// one instead of reaching through the crate root.
use super::git_control::linked_worktree_roots;

// Unix resolves the opened directory through its descriptor; Windows
// canonicalizes a path instead, so these are gated to match their callers.
#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

#[cfg(unix)]
#[derive(Debug)]
pub(crate) struct OpenedPtyCwd {
    _directory: std::fs::File,
    pub(crate) spawn_path: PathBuf,
    pub(crate) canonical_path: PathBuf,
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
pub(crate) struct OpenedPtyCwd {
    project_root: String,
    requested_cwd: String,
    pub(crate) canonical_path: PathBuf,
}

impl OpenedPtyCwd {
    pub(crate) fn configure_command_cwd(&self, command: &mut CommandBuilder) -> Result<(), String> {
        #[cfg(unix)]
        {
            if !locator_matches_open_directory(&self.spawn_path, &self._directory) {
                return Err(format!(
                    "stable PTY cwd locator is unavailable: {}",
                    self.spawn_path.display()
                ));
            }
            command.cwd(&self.spawn_path);
        }
        #[cfg(target_os = "windows")]
        {
            let canonical_path =
                canonical_windows_pty_cwd_for_spawn(&self.project_root, &self.requested_cwd)?;
            command.cwd(canonical_path);
        }
        Ok(())
    }
}

#[cfg(unix)]
fn locator_matches_open_directory(locator: &Path, directory: &std::fs::File) -> bool {
    let Ok(locator_metadata) = locator.metadata() else {
        return false;
    };
    let Ok(directory_metadata) = directory.metadata() else {
        return false;
    };
    locator_metadata.is_dir()
        && locator_metadata.dev() == directory_metadata.dev()
        && locator_metadata.ino() == directory_metadata.ino()
}

fn validate_opened_pty_cwd(
    canonical_root: &Path,
    canonical_candidate: &Path,
    linked_worktrees: &[PathBuf],
    cwd: &str,
) -> Result<(), String> {
    if canonical_candidate.starts_with(canonical_root) {
        return Ok(());
    }

    for worktree in linked_worktrees {
        let canonical_worktree = match worktree.canonicalize() {
            Ok(path) if path.is_dir() => path,
            _ => continue,
        };
        if canonical_candidate.starts_with(canonical_worktree) {
            return Ok(());
        }
    }

    Err(format!(
        "PTY cwd is outside the project and its linked worktrees: {}",
        cwd
    ))
}

#[cfg(unix)]
fn directory_path_from_handle(directory: &std::fs::File, cwd: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let mut buffer = vec![0u8; libc::PATH_MAX as usize];
        let result = unsafe {
            libc::fcntl(
                directory.as_raw_fd(),
                libc::F_GETPATH,
                buffer.as_mut_ptr() as *mut libc::c_void,
            )
        };
        if result == -1 {
            return Err(format!(
                "PTY cwd '{}': {}",
                cwd,
                std::io::Error::last_os_error()
            ));
        }
        let length = buffer
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(buffer.len());
        return Ok(PathBuf::from(std::ffi::OsStr::from_bytes(
            &buffer[..length],
        )));
    }

    #[cfg(not(target_os = "macos"))]
    {
        std::fs::read_link(format!("/proc/self/fd/{}", directory.as_raw_fd()))
            .map_err(|e| format!("PTY cwd '{}': {}", cwd, e))
    }
}

#[cfg(unix)]
fn open_pty_cwd_candidate(
    candidate: &Path,
    cwd: &str,
    _project_root: &str,
) -> Result<OpenedPtyCwd, String> {
    let directory =
        std::fs::File::open(candidate).map_err(|e| format!("PTY cwd '{}': {}", cwd, e))?;
    let metadata = directory
        .metadata()
        .map_err(|e| format!("PTY cwd '{}': {}", cwd, e))?;
    if !metadata.is_dir() {
        return Err(format!("PTY cwd is not a directory: {}", cwd));
    }
    #[cfg(target_os = "macos")]
    let locator_candidates = vec![PathBuf::from(format!(
        "/.vol/{}/{}",
        metadata.dev(),
        metadata.ino()
    ))];
    #[cfg(not(target_os = "macos"))]
    let locator_candidates = vec![
        PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd())),
        PathBuf::from(format!("/dev/fd/{}", directory.as_raw_fd())),
    ];
    let spawn_path = locator_candidates
        .into_iter()
        .find(|locator| locator_matches_open_directory(locator, &directory))
        .ok_or_else(|| format!("stable PTY cwd locator is unavailable for '{}'", cwd))?;
    let canonical_path = directory_path_from_handle(&directory, cwd)?;
    Ok(OpenedPtyCwd {
        _directory: directory,
        spawn_path,
        canonical_path,
    })
}

#[cfg(target_os = "windows")]
fn open_pty_cwd_candidate(
    candidate: &Path,
    cwd: &str,
    project_root: &str,
) -> Result<OpenedPtyCwd, String> {
    let canonical_path = candidate
        .canonicalize()
        .map_err(|e| format!("PTY cwd '{}': {}", cwd, e))?;
    if !canonical_path.is_dir() {
        return Err(format!("PTY cwd is not a directory: {}", cwd));
    }
    Ok(OpenedPtyCwd {
        project_root: project_root.to_string(),
        requested_cwd: cwd.to_string(),
        canonical_path,
    })
}

#[cfg(target_os = "windows")]
fn canonical_windows_pty_cwd_for_spawn(project_root: &str, cwd: &str) -> Result<PathBuf, String> {
    let canonical_root = canonical_project_root(project_root)?;
    let candidate = pty_cwd_candidate(&canonical_root, cwd);
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|e| format!("PTY cwd '{}': {}", cwd, e))?;
    if !canonical_candidate.is_dir() {
        return Err(format!("PTY cwd is not a directory: {}", cwd));
    }
    if canonical_candidate.starts_with(&canonical_root) {
        return Ok(canonical_candidate);
    }

    let linked_worktrees = linked_worktree_roots(&canonical_root)?;
    validate_opened_pty_cwd(
        &canonical_root,
        &canonical_candidate,
        &linked_worktrees,
        cwd,
    )?;
    Ok(canonical_candidate)
}

fn pty_cwd_candidate(canonical_root: &Path, cwd: &str) -> PathBuf {
    let requested = Path::new(cwd);
    if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        canonical_root.join(requested)
    }
}

// Test-only variant of `open_pty_cwd` that takes the linked worktrees as an
// argument instead of shelling out to `git worktree list`, so the containment
// checks can be exercised without a real multi-worktree repo on disk.
#[cfg(test)]
pub(crate) fn open_pty_cwd_with_worktrees(
    project_root: &str,
    cwd: &str,
    linked_worktrees: &[PathBuf],
) -> Result<OpenedPtyCwd, String> {
    let canonical_root = canonical_project_root(project_root)?;
    let candidate = pty_cwd_candidate(&canonical_root, cwd);
    let opened = open_pty_cwd_candidate(&candidate, cwd, project_root)?;
    validate_opened_pty_cwd(
        &canonical_root,
        &opened.canonical_path,
        linked_worktrees,
        cwd,
    )?;
    Ok(opened)
}

#[cfg(test)]
pub(crate) fn resolve_pty_cwd_with_worktrees(
    project_root: &str,
    cwd: &str,
    linked_worktrees: &[PathBuf],
) -> Result<PathBuf, String> {
    open_pty_cwd_with_worktrees(project_root, cwd, linked_worktrees)
        .map(|opened| opened.canonical_path)
}

pub(crate) fn open_pty_cwd(project_root: &str, cwd: &str) -> Result<OpenedPtyCwd, String> {
    let canonical_root = canonical_project_root(project_root)?;
    let candidate = pty_cwd_candidate(&canonical_root, cwd);
    let opened = open_pty_cwd_candidate(&candidate, cwd, project_root)?;
    if opened.canonical_path.starts_with(&canonical_root) {
        return Ok(opened);
    }

    let linked_worktrees = linked_worktree_roots(&canonical_root)?;
    validate_opened_pty_cwd(
        &canonical_root,
        &opened.canonical_path,
        &linked_worktrees,
        cwd,
    )?;
    Ok(opened)
}

#[cfg(test)]
pub(crate) fn resolve_pty_cwd(project_root: &str, cwd: &str) -> Result<PathBuf, String> {
    open_pty_cwd(project_root, cwd).map(|opened| opened.canonical_path)
}
