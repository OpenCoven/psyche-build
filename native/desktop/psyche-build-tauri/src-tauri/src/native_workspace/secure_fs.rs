//! Syscall and file-descriptor primitives for workspace persistence.
//!
//! These twenty functions are the symlink and TOCTOU defences that every
//! workspace read and write funnels through. They were extracted from
//! `native_workspace.rs` as a dependency-closed set of *free functions*: no
//! function here calls a free function in the parent module, which is what
//! makes the boundary meaningful rather than cosmetic.
//!
//! The set is closed, not independent. It still borrows two types from the
//! parent, `SecureWorkspaceDir` and `PinnedDirectory`, which carry the pinned
//! directory descriptors these syscalls resolve names against. Those imports
//! are named explicitly rather than glob-imported, so the remaining coupling
//! is visible at the top of the file instead of being asserted in a comment.
//!
//! They stay `pub(super)`. All twenty were private to `native_workspace`
//! before the move, and widening a symlink defence to `pub(crate)` as a side
//! effect of relocating it would be a real change to the security surface.
//!
//! `__tests__/tauriNativeWorkspaceSecurity.test.ts` asserts these bodies by
//! reading the module directory, so the assertions follow the functions here
//! rather than tracking a path.

#[cfg(any(test, not(unix)))]
use std::fs;
use std::fs::File;
#[cfg(not(unix))]
use std::fs::OpenOptions;
use std::path::Path;

#[cfg(unix)]
use std::ffi::{CStr, CString, OsStr, OsString};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::{OsStrExt, OsStringExt};

use super::{PinnedDirectory, SecureWorkspaceDir};

#[cfg(unix)]
pub(super) fn c_name(name: &OsStr) -> Result<CString, String> {
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
pub(super) fn open_directory_path_no_follow_optional(
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
pub(super) fn open_directory_component(
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
pub(super) fn set_secure_directory_permissions_fd(
    directory: &File,
    path: &Path,
) -> Result<(), String> {
    if unsafe { libc::fchmod(directory.as_raw_fd(), 0o700) } != 0 {
        return Err(format!(
            "set workspace directory permissions '{}': {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

pub(super) fn regular_file_exists(
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

pub(super) fn require_new_regular_file_path(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
    context: &str,
) -> Result<(), String> {
    if regular_file_exists(workspace_dir, path, context)? {
        return Err(format!("{context} '{}' already exists", path.display()));
    }
    Ok(())
}

pub(super) fn open_existing_regular_file(
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

pub(super) fn open_new_workspace_file(
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

pub(super) fn workspace_directory_entries(
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

pub(super) fn unlink_workspace_path(
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

pub(super) fn hard_link_workspace_path(
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

pub(super) fn rename_workspace_path_in(
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

pub(super) fn verify_opened_regular_file(
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

pub(super) fn open_workspace_lock(
    workspace_dir: &SecureWorkspaceDir,
    path: &Path,
) -> Result<File, String> {
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
