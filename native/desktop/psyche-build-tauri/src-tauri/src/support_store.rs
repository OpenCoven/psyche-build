//! Descriptor-relative persistence adapter for the existing v1 store facade.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::ffi::{CStr, CString, OsStr};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

struct Link {
    parent: File,
    name: CString,
    device: u64,
    inode: u64,
}
pub(crate) struct ScopedStore {
    root: PathBuf,
    directory: File,
    links: Vec<Link>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Written {
    pub path: String,
    pub bytes: usize,
    pub removed: Vec<String>,
    pub retention_failures: u32,
}
fn name(value: &OsStr) -> Result<CString, String> {
    CString::new(value.as_bytes()).map_err(|_| "write_failed".into())
}
fn directory_at(parent: &File, child: &CString, create: bool) -> Result<File, String> {
    if create
        && unsafe { libc::mkdirat(parent.as_raw_fd(), child.as_ptr(), 0o700) } != 0
        && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
    {
        return Err("write_failed".into());
    }
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            child.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err("write_failed".into());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn root_directory(root: &Path) -> Result<File, String> {
    if !root.is_absolute() {
        return Err("write_failed".into());
    }
    let mut current = File::open("/").map_err(|_| "write_failed")?;
    for component in root.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(child) => {
                current = directory_at(&current, &name(child)?, false)?;
            }
            _ => return Err("write_failed".into()),
        }
    }
    Ok(current)
}
pub(crate) fn valid_bundle_name(value: &str) -> bool {
    let Some(stem) = value
        .strip_prefix("psyche-support-")
        .and_then(|name| name.strip_suffix(".json"))
    else {
        return false;
    };
    let Some((stamp, digest)) = stem.split_once('-') else {
        return false;
    };
    stamp.len() == 16
        && stamp.as_bytes()[8] == b'T'
        && stamp.as_bytes()[15] == b'Z'
        && stamp
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 8 || index == 15 || byte.is_ascii_digit())
        && digest.len() == 12
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
impl ScopedStore {
    fn open(root: &Path) -> Result<Self, String> {
        Self::open_with_create(root, true)
    }
    fn open_with_create(root: &Path, create: bool) -> Result<Self, String> {
        use std::os::unix::fs::MetadataExt;
        let mut current = root_directory(root)?;
        let mut links = Vec::new();
        for part in [".psyche", "runtime", "support-bundles"] {
            let child = name(OsStr::new(part))?;
            let next = directory_at(&current, &child, create)?;
            let metadata = next.metadata().map_err(|_| "write_failed")?;
            links.push(Link {
                parent: current,
                name: child,
                device: metadata.dev(),
                inode: metadata.ino(),
            });
            current = next;
        }
        Ok(Self {
            root: root.into(),
            directory: current,
            links,
        })
    }
    fn verify_links(&self) -> Result<(), String> {
        for link in &self.links {
            let mut metadata = std::mem::MaybeUninit::<libc::stat>::zeroed();
            if unsafe {
                libc::fstatat(
                    link.parent.as_raw_fd(),
                    link.name.as_ptr(),
                    metadata.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                return Err("write_failed".into());
            }
            let metadata = unsafe { metadata.assume_init() };
            if metadata.st_mode as u32 & libc::S_IFMT as u32 != libc::S_IFDIR as u32
                || metadata.st_dev as u64 != link.device
                || metadata.st_ino as u64 != link.inode
            {
                return Err("write_failed".into());
            }
        }
        Ok(())
    }
    fn remove(&self, child: &str) -> Result<(), String> {
        let child = name(OsStr::new(child))?;
        if unsafe { libc::unlinkat(self.directory.as_raw_fd(), child.as_ptr(), 0) } == 0 {
            Ok(())
        } else {
            Err("write_failed".into())
        }
    }
    fn retire(&self, child: &str) -> Result<(), String> {
        // Claim the actual leaf before inspecting its ownership. A replacement
        // at the public name must never be unlinked on the earlier inspection.
        self.verify_links()?;
        let mut random = [0u8; 16];
        getrandom::getrandom(&mut random).map_err(|_| "write_failed")?;
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let quarantine_name = name(OsStr::new(&format!(".retention-{suffix}")))?;
        if unsafe { libc::mkdirat(self.directory.as_raw_fd(), quarantine_name.as_ptr(), 0o700) }
            != 0
        {
            return Err("write_failed".into());
        }
        let quarantine = directory_at(&self.directory, &quarantine_name, false)?;
        let original = name(OsStr::new(child))?;
        let candidate = name(OsStr::new("candidate"))?;
        let result = (|| {
            if unsafe {
                libc::renameat(
                    self.directory.as_raw_fd(),
                    original.as_ptr(),
                    quarantine.as_raw_fd(),
                    candidate.as_ptr(),
                )
            } != 0
            {
                return Err("write_failed".into());
            }
            if !Self::owned_at(&quarantine, "candidate") {
                // linkat is exclusive: restoration never overwrites a newer
                // public leaf. If restoration cannot proceed, retain the object
                // in quarantine and report a failure rather than deleting it.
                self.restore_unrecognized(&quarantine, &candidate, &original);
                return Err("write_failed".into());
            }
            if unsafe { libc::unlinkat(quarantine.as_raw_fd(), candidate.as_ptr(), 0) } != 0 {
                return Err("write_failed".into());
            }
            Ok(())
        })();
        // Empty only. Unknown or un-restorable contents are always preserved.
        unsafe {
            libc::unlinkat(
                self.directory.as_raw_fd(),
                quarantine_name.as_ptr(),
                libc::AT_REMOVEDIR,
            );
        }
        result
    }
    fn restore_unrecognized(&self, quarantine: &File, candidate: &CString, original: &CString) {
        if unsafe {
            libc::linkat(
                quarantine.as_raw_fd(),
                candidate.as_ptr(),
                self.directory.as_raw_fd(),
                original.as_ptr(),
                0,
            )
        } == 0
        {
            unsafe {
                libc::unlinkat(quarantine.as_raw_fd(), candidate.as_ptr(), 0);
            }
        }
    }
    fn prepare(&self, filename: &str, bytes: &[u8], cancel: &AtomicBool) -> Result<String, String> {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".into());
        }
        self.verify_links()?;
        if !valid_bundle_name(filename) || bytes.len() > 65536 {
            return Err("write_failed".into());
        }
        let mut random = [0u8; 16];
        getrandom::getrandom(&mut random).map_err(|_| "write_failed")?;
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let temporary = format!(".{filename}.{suffix}.tmp");
        let child = name(OsStr::new(&temporary))?;
        let fd = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                child.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err("write_failed".into());
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        let result = (|| {
            if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
                return Err("write_failed".to_string());
            }
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| "write_failed".to_string())?;
            if cancel.load(Ordering::Acquire) {
                return Err("cancelled".into());
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = self.remove(&temporary);
            return Err(error);
        }
        Ok(temporary)
    }
    fn commit(&self, temporary: &str, filename: &str, cancel: &AtomicBool) -> Result<(), String> {
        let result = (|| {
            if cancel.load(Ordering::Acquire) {
                return Err("cancelled".into());
            }
            self.verify_links()?;
            let from = name(OsStr::new(temporary))?;
            let to = name(OsStr::new(filename))?;
            if unsafe {
                libc::renameat(
                    self.directory.as_raw_fd(),
                    from.as_ptr(),
                    self.directory.as_raw_fd(),
                    to.as_ptr(),
                )
            } != 0
            {
                return Err("write_failed".into());
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = self.remove(temporary);
        }
        result
    }
    fn entries(&self) -> Result<(Vec<String>, bool), String> {
        let fd = unsafe { libc::dup(self.directory.as_raw_fd()) };
        if fd < 0 {
            return Err("write_failed".into());
        }
        let pointer = unsafe { libc::fdopendir(fd) };
        if pointer.is_null() {
            unsafe {
                libc::close(fd);
            }
            return Err("write_failed".into());
        }
        struct Directory(*mut libc::DIR);
        impl Drop for Directory {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let directory = Directory(pointer);
        unsafe {
            libc::rewinddir(directory.0);
        }
        let mut entries = Vec::new();
        let mut truncated = false;
        for index in 0..4097 {
            let entry = unsafe { libc::readdir(directory.0) };
            if entry.is_null() {
                break;
            }
            if index == 4096 {
                truncated = true;
                break;
            }
            if let Ok(child) = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_str() {
                if valid_bundle_name(child) {
                    entries.push(child.to_string());
                }
            }
        }
        entries.sort();
        Ok((entries, truncated))
    }
    fn owned(&self, child: &str) -> bool {
        Self::owned_at(&self.directory, child)
    }
    fn owned_at(directory: &File, child: &str) -> bool {
        let Ok(child) = name(OsStr::new(child)) else {
            return false;
        };
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                child.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return false;
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let Ok(metadata) = file.metadata() else {
            return false;
        };
        if !metadata.is_file() || metadata.len() > 256 * 1024 {
            return false;
        }
        let mut data = Vec::new();
        if file.take(256 * 1024 + 1).read_to_end(&mut data).is_err() || data.len() > 256 * 1024 {
            return false;
        }
        serde_json::from_slice::<serde_json::Value>(&data)
            .ok()
            .and_then(|value| {
                value
                    .get("schema")
                    .and_then(|value| value.as_str())
                    .map(|value| value == "psyche.diagnostics/v1")
            })
            .unwrap_or(false)
    }
    fn prune(&self, filename: &str, retained: usize, cancel: &AtomicBool) -> (Vec<String>, u32) {
        if cancel.load(Ordering::Acquire) {
            return (Vec::new(), 0);
        }
        if self.verify_links().is_err() {
            return (Vec::new(), 1);
        }
        let Ok((mut entries, truncated)) = self.entries() else {
            return (Vec::new(), 1);
        };
        entries.retain(|entry| entry != filename);
        let remove_count = entries.len().saturating_sub(retained.saturating_sub(1));
        let mut removed = Vec::new();
        let mut failures = u32::from(truncated);
        for child in entries.into_iter().take(remove_count) {
            if cancel.load(Ordering::Acquire) {
                break;
            }
            if self.verify_links().is_err() {
                failures += 1;
                break;
            }
            if !self.owned(&child) || self.retire(&child).is_err() {
                failures += 1;
            } else {
                removed.push(child);
            }
        }
        (removed, failures)
    }
}

pub(crate) fn persist(
    root: &Path,
    filename: &str,
    serialized: &str,
    retained: usize,
    cancel: &AtomicBool,
) -> Result<Written, String> {
    if cancel.load(Ordering::Acquire) {
        return Err("cancelled".into());
    }
    if !valid_bundle_name(filename) || serialized.len() > 65536 || retained > 10 {
        return Err("write_failed".into());
    }
    let value: serde_json::Value = serde_json::from_str(serialized).map_err(|_| "write_failed")?;
    let digest = format!("{:x}", Sha256::digest(serialized.as_bytes()));
    if value.get("schema").and_then(|value| value.as_str()) != Some("psyche.diagnostics/v1")
        || !filename.ends_with(&format!("-{}.json", &digest[..12]))
    {
        return Err("write_failed".into());
    }
    let store = ScopedStore::open(root)?;
    let temporary = store.prepare(filename, serialized.as_bytes(), cancel)?;
    store.commit(&temporary, filename, cancel)?;
    let (removed, retention_failures) = store.prune(filename, retained, cancel);
    Ok(Written {
        path: store
            .root
            .join(".psyche/runtime/support-bundles")
            .join(filename)
            .to_string_lossy()
            .into_owned(),
        bytes: serialized.len(),
        removed,
        retention_failures,
    })
}

pub(crate) fn inspect_file(root: &Path, filename: &str) -> Result<(File, Vec<u8>), String> {
    use std::os::unix::fs::PermissionsExt;
    if !valid_bundle_name(filename) {
        return Err("support_file_unavailable".into());
    }
    let store = ScopedStore::open_with_create(root, false)?;
    store.verify_links()?;
    let child = name(OsStr::new(filename))?;
    let fd = unsafe {
        libc::openat(
            store.directory.as_raw_fd(),
            child.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err("support_file_unavailable".into());
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata().map_err(|_| "support_file_unavailable")?;
    if !metadata.is_file()
        || metadata.len() > 65536
        || metadata.permissions().mode() & 0o777 != 0o600
    {
        return Err("support_file_unavailable".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| "support_file_unavailable")?;
    if bytes.len() > 65536 {
        return Err("support_file_unavailable".into());
    }
    Ok((file, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    const NAME: &str = "psyche-support-20261116T000000Z-111111111111.json";
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let owner = tempfile::tempdir().unwrap();
        let root = owner.path().canonicalize().unwrap();
        let project = root.join("project");
        let outside = root.join("outside");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&outside).unwrap();
        (owner, project, outside)
    }
    #[test]
    fn support_store_directory_swap_before_creation_never_writes_outside() {
        let (_owner, root, outside) = fixture();
        let store = ScopedStore::open(&root).unwrap();
        if root.join(".psyche").exists() {
            std::fs::rename(root.join(".psyche"), root.join(".psyche-held")).unwrap();
        }
        std::os::unix::fs::symlink(&outside, root.join(".psyche")).unwrap();
        assert!(store
            .prepare(NAME, b"safe", &AtomicBool::new(false))
            .is_err());
        assert_eq!(std::fs::read_dir(outside).unwrap().count(), 0);
    }
    #[test]
    fn support_store_directory_swap_before_commit_refuses_redirection() {
        let (_owner, root, outside) = fixture();
        let store = ScopedStore::open(&root).unwrap();
        let cancel = AtomicBool::new(false);
        let temporary = store.prepare(NAME, b"safe", &cancel).unwrap();
        std::fs::rename(
            root.join(".psyche/runtime"),
            root.join(".psyche/runtime-held"),
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".psyche/runtime")).unwrap();
        std::fs::create_dir(outside.join("support-bundles")).unwrap();
        std::fs::write(
            outside.join("support-bundles").join(&temporary),
            b"outside-sentinel",
        )
        .unwrap();
        assert!(store.commit(&temporary, NAME, &cancel).is_err());
        assert_eq!(
            std::fs::read(outside.join("support-bundles").join(&temporary)).unwrap(),
            b"outside-sentinel"
        );
        assert!(!outside.join("support-bundles").join(NAME).exists());
    }
    #[test]
    fn support_store_retention_preserves_a_leaf_replaced_after_selection() {
        let (_owner, root, _outside) = fixture();
        let store = ScopedStore::open(&root).unwrap();
        let output = root.join(".psyche/runtime/support-bundles").join(NAME);
        std::fs::write(&output, br#"{"schema":"psyche.diagnostics/v1"}"#).unwrap();
        assert!(store.owned(NAME));
        std::fs::write(&output, b"unrelated-work").unwrap();
        assert!(store.retire(NAME).is_err());
        assert_eq!(std::fs::read(&output).unwrap(), b"unrelated-work");
    }
    #[test]
    fn support_store_retention_restoration_never_overwrites_a_concurrent_leaf() {
        let (_owner, root, _outside) = fixture();
        let store = ScopedStore::open(&root).unwrap();
        let directory = root.join(".psyche/runtime/support-bundles");
        let quarantine_path = directory.join(".retention-fixture");
        std::fs::create_dir(&quarantine_path).unwrap();
        std::fs::write(quarantine_path.join("candidate"), b"preserved-unknown").unwrap();
        std::fs::write(directory.join(NAME), b"newer-work").unwrap();
        let quarantine = File::open(&quarantine_path).unwrap();
        store.restore_unrecognized(
            &quarantine,
            &name(OsStr::new("candidate")).unwrap(),
            &name(OsStr::new(NAME)).unwrap(),
        );
        assert_eq!(std::fs::read(directory.join(NAME)).unwrap(), b"newer-work");
        assert_eq!(
            std::fs::read(quarantine_path.join("candidate")).unwrap(),
            b"preserved-unknown"
        );
    }
    #[test]
    fn support_store_retention_refuses_a_replaced_directory() {
        let (_owner, root, outside) = fixture();
        let store = ScopedStore::open(&root).unwrap();
        let cancel = AtomicBool::new(false);
        let temporary = store.prepare(NAME, b"safe", &cancel).unwrap();
        store.commit(&temporary, NAME, &cancel).unwrap();
        std::fs::rename(
            root.join(".psyche/runtime/support-bundles"),
            root.join(".psyche/runtime/held"),
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".psyche/runtime/support-bundles")).unwrap();
        let old = "psyche-support-20261115T000000Z-222222222222.json";
        let owned = br#"{"schema":"psyche.diagnostics/v1"}"#;
        std::fs::write(outside.join(old), owned).unwrap();
        assert!(store.prune(NAME, 0, &cancel).1 > 0);
        assert_eq!(std::fs::read(outside.join(old)).unwrap(), owned);
    }
    #[test]
    fn support_store_preserves_0600_and_the_cancellation_commit_point() {
        use std::os::unix::fs::PermissionsExt;
        let (_owner, root, _outside) = fixture();
        let store = ScopedStore::open(&root).unwrap();
        let cancel = AtomicBool::new(false);
        let temporary = store.prepare(NAME, b"safe", &cancel).unwrap();
        cancel.store(true, Ordering::Release);
        assert!(store.commit(&temporary, NAME, &cancel).is_err());
        cancel.store(false, Ordering::Release);
        let temporary = store.prepare(NAME, b"safe", &cancel).unwrap();
        store.commit(&temporary, NAME, &cancel).unwrap();
        let output = root.join(".psyche/runtime/support-bundles").join(NAME);
        assert_eq!(
            std::fs::metadata(output).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    #[test]
    fn support_store_reuses_v1_retention_ownership_and_preserves_unrelated_files() {
        let (_owner, root, _outside) = fixture();
        let cancel = AtomicBool::new(false);
        let mut latest = String::new();
        for index in 0..13 {
            let serialized = serde_json::json!({ "schema": "psyche.diagnostics/v1", "status": "partial", "fixture": index }).to_string();
            let digest = format!("{:x}", Sha256::digest(serialized.as_bytes()));
            let filename = format!(
                "psyche-support-20261116T0000{index:02}Z-{}.json",
                &digest[..12]
            );
            latest = persist(&root, &filename, &serialized, 10, &cancel)
                .unwrap()
                .path;
        }
        let directory = root.join(".psyche/runtime/support-bundles");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 10);
        std::fs::write(directory.join("unrelated.txt"), b"keep").unwrap();
        let fake = "psyche-support-20261115T000000Z-333333333333.json";
        std::fs::write(directory.join(fake), b"unrelated").unwrap();
        let store = ScopedStore::open(&root).unwrap();
        let (removed, failures) = store.prune(
            Path::new(&latest).file_name().unwrap().to_str().unwrap(),
            10,
            &cancel,
        );
        assert!(removed.is_empty());
        assert!(failures > 0);
        assert_eq!(
            std::fs::read(directory.join("unrelated.txt")).unwrap(),
            b"keep"
        );
        assert_eq!(std::fs::read(directory.join(fake)).unwrap(), b"unrelated");
    }
    #[test]
    fn support_store_rejects_bad_names_schema_digest_and_size_before_mutation() {
        let (_owner, root, _outside) = fixture();
        let cancel = AtomicBool::new(false);
        for (filename, contents) in [
            ("../escape", "{}".to_string()),
            (NAME, "{}".to_string()),
            (NAME, "x".repeat(65537)),
        ] {
            assert!(persist(&root, filename, &contents, 10, &cancel).is_err());
        }
        assert_eq!(std::fs::read_dir(root).unwrap().count(), 0);
    }
}
