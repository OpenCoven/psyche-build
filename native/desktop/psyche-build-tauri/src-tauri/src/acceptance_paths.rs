//! Filesystem admission policy for the explicit native acceptance profile.
use std::path::{Path, PathBuf};

pub fn validate_root(path: &Path) -> Result<PathBuf, String> {
    use std::os::unix::fs::MetadataExt;
    use std::path::Component;
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        || !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("psyche-acceptance-") && name.len() > 18)
    {
        return Err(
            "acceptance root must be an explicit absolute psyche-acceptance-* directory".into(),
        );
    }
    let parent = path.parent().ok_or("acceptance root has no parent")?;
    let mut current = PathBuf::new();
    for component in parent.components() {
        current.push(component);
        let metadata =
            std::fs::symlink_metadata(&current).map_err(|_| "acceptance ancestor unavailable")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.mode() & 0o022 != 0 {
            return Err("acceptance ancestors must be real, non-shared directories".into());
        }
    }
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.mode() & 0o077 != 0 {
            return Err("acceptance root collides with non-private storage".into());
        }
        if metadata.uid()
            != std::fs::metadata(parent)
                .map_err(|_| "acceptance parent unavailable")?
                .uid()
        {
            return Err("acceptance root owner differs from parent".into());
        }
    }
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn fixture(name: &str) -> PathBuf {
        let root = std::env::current_dir().unwrap().join(format!(
            ".acceptance-path-test-{}-{name}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        root
    }

    #[test]
    fn accepts_new_explicit_private_profile() {
        let parent = fixture("new");
        let path = parent.join("psyche-acceptance-one");
        assert_eq!(validate_root(&path).unwrap(), path);
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn rejects_default_relative_shared_and_traversal_paths() {
        let parent = fixture("reject");
        for path in [
            PathBuf::from("psyche-acceptance-relative"),
            parent.join(".psyche"),
            parent.join("..").join("psyche-acceptance-escape"),
            parent.clone(),
        ] {
            assert!(validate_root(&path).is_err());
        }
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(validate_root(&parent.join("psyche-acceptance-shared")).is_err());
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn rejects_symlink_parent_and_existing_leaf_collision() {
        let parent = fixture("link");
        let link = parent.join("link");
        symlink(&parent, &link).unwrap();
        assert!(validate_root(&link.join("psyche-acceptance-linked")).is_err());
        let path = parent.join("psyche-acceptance-existing");
        fs::write(&path, "not a profile").unwrap();
        assert!(validate_root(&path).is_err());
        fs::remove_file(path).unwrap();
        fs::remove_file(link).unwrap();
        fs::remove_dir(parent).unwrap();
    }
}
