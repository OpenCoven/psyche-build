//! Bind Finder selection to the already inspected file identity.
use objc2::rc::Retained;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSArray, NSString, NSURL};
use std::fs::File;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

pub(super) fn reference(file: &File) -> Result<Retained<NSURL>, String> {
    let mut buffer = [0i8; libc::PATH_MAX as usize];
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } != 0 {
        return Err("reveal_failed".into());
    }
    let path = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
        .to_str()
        .map_err(|_| "reveal_failed")?;
    let reference = NSURL::fileURLWithPath(&NSString::from_str(path))
        .fileReferenceURL()
        .ok_or("reveal_failed")?;
    // Validate the captured reference while the inspected descriptor stays open.
    // Only this same object reference is handed to Finder, never a later path.
    let resolved = reference
        .filePathURL()
        .and_then(|url| url.path())
        .ok_or("reveal_failed")?;
    let captured = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(resolved.to_string())
        .map_err(|_| "reveal_failed")?;
    let expected = file.metadata().map_err(|_| "reveal_failed")?;
    let actual = captured.metadata().map_err(|_| "reveal_failed")?;
    if actual.dev() != expected.dev() || actual.ino() != expected.ino() || !actual.is_file() {
        return Err("reveal_failed".into());
    }
    Ok(reference)
}

pub(super) fn show(file: &File) -> Result<(), String> {
    let reference = reference(file)?;
    let urls = NSArray::from_retained_slice(&[reference]);
    NSWorkspace::new().activateFileViewerSelectingURLs(&urls);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn support_bundle_reveal_keeps_inspected_identity_after_directory_replacement() {
        let owner = tempfile::tempdir().unwrap();
        let directory = owner.path().join("support");
        let outside = owner.path().join("outside");
        std::fs::create_dir(&directory).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let file = directory.join("bundle.json");
        std::fs::write(&file, b"verified-bundle").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(outside.join("bundle.json"), b"outside-sentinel").unwrap();
        let opened = File::open(&file).unwrap();
        let reference = reference(&opened).unwrap();
        std::fs::rename(&directory, owner.path().join("held")).unwrap();
        std::os::unix::fs::symlink(&outside, &directory).unwrap();
        let resolved = reference.filePathURL().unwrap().path().unwrap().to_string();
        assert_eq!(std::fs::read(resolved).unwrap(), b"verified-bundle");
    }
}
