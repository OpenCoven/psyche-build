//! Explicit local candidate profile, established before plugins or WebViews exist.
//! This is storage/routing isolation, not an OS sandbox for terminal commands.
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const IDENTIFIER: &str = "dev.opencoven.psyche.acceptance";
static PROFILE: OnceLock<Profile> = OnceLock::new();

pub struct Profile {
    pub root: PathBuf,
    pub main_store: [u8; 16],
    pub browser_store: [u8; 16],
    _lock: std::fs::File,
}

pub fn profile() -> Option<&'static Profile> {
    PROFILE.get()
}

pub fn active() -> bool {
    profile().is_some()
}

pub fn require_local_project(path: &Path) -> Result<(), String> {
    if let Some(profile) = profile() {
        if !is_local_project(&profile.root, path) {
            return Err("acceptance projects must be inside the profile projects directory".into());
        }
    }
    Ok(())
}

fn is_local_project(root: &Path, path: &Path) -> bool {
    let projects = root.join("projects");
    path.starts_with(&projects)
        && path != projects
        && !path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
}

pub fn command_allowed(command: &str) -> bool {
    !active()
        || !(command.starts_with("control_")
            || command.starts_with("coven_")
            || command == "agent_skills")
}

pub fn initialize(identifier: &str) -> Result<bool, String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let opted_in = args
        .iter()
        .any(|arg| arg == "--acceptance-profile" || arg == "--acceptance-prepare");
    let prepare = args
        .first()
        .is_some_and(|arg| arg == "--acceptance-prepare");
    if identifier != IDENTIFIER {
        if opted_in {
            return Err("acceptance profile requires the acceptance candidate identifier".into());
        }
        return Ok(false);
    }
    if !opted_in || args.len() != 2 || (!prepare && args[0] != "--acceptance-profile") {
        return Err("acceptance candidate requires --acceptance-profile ABSOLUTE_ROOT".into());
    }
    #[cfg(not(target_os = "macos"))]
    return Err("native acceptance profiles require macOS 14 or newer".into());
    #[cfg(target_os = "macos")]
    {
        // Do not allow Wry's pre-14 fallback to the default website data store.
        let output = std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .env_clear()
            .output()
            .map_err(|_| "cannot establish macOS version")?;
        let major = std::str::from_utf8(&output.stdout)
            .ok()
            .and_then(|version| version.split('.').next()?.parse::<u32>().ok());
        if !output.status.success() || major.is_none_or(|major| major < 14) {
            return Err("native acceptance profiles require verified macOS 14 or newer".into());
        }
        let root = Path::new(&args[1]);
        if !prepare {
            for (key, directory) in [("HOME", "home"), ("CFFIXED_USER_HOME", "home")] {
                if std::env::var_os(key).as_deref() != Some(root.join(directory).as_os_str()) {
                    return Err(
                        "acceptance launch requires profile HOME and CFFIXED_USER_HOME before exec"
                            .into(),
                    );
                }
            }
        }
        if root.join("run/tmux.sock").as_os_str().len() >= 104 {
            return Err("acceptance root is too long for the macOS Unix socket limit".into());
        }
        let profile = open_profile(root)?;
        set_environment(&profile)?;
        PROFILE
            .set(profile)
            .map_err(|_| "acceptance profile already initialized")?;
        Ok(prepare)
    }
}

#[cfg(target_os = "macos")]
fn open_profile(root: &Path) -> Result<Profile, String> {
    use sha2::{Digest, Sha256};
    use std::fs::{self, OpenOptions};
    use std::io::{Read, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};

    let root = crate::acceptance_paths::validate_root(root)?;
    let fresh = !root.exists();
    if !fresh && fs::symlink_metadata(root.join("profile.v1")).is_err() {
        return Err("existing directory is not an acceptance profile".into());
    }
    if fresh {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .map_err(|_| "acceptance root creation collided")?;
    }
    let metadata = fs::symlink_metadata(&root).map_err(|_| "acceptance root unavailable")?;
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err("acceptance root must be owned by the current user".into());
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root.join("profile.lock"))
        .map_err(|_| "acceptance lock unavailable")?;
    let lock_meta = lock.metadata().map_err(|_| "acceptance lock unavailable")?;
    if !lock_meta.is_file()
        || lock_meta.nlink() != 1
        || lock_meta.uid() != metadata.uid()
        || lock_meta.mode() & 0o077 != 0
    {
        return Err("acceptance lock is not private".into());
    }
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("acceptance profile is already in use".into());
    }
    let path_digest: [u8; 32] = Sha256::digest(root.as_os_str().as_encoded_bytes()).into();
    let marker = root.join("profile.v1");
    let mut nonce = [0u8; 32];
    if fresh {
        getrandom::getrandom(&mut nonce).map_err(|_| "acceptance entropy unavailable")?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&marker)
            .map_err(|_| "acceptance marker collision")?;
        file.write_all(&path_digest)
            .and_then(|_| file.write_all(&nonce))
            .and_then(|_| file.sync_all())
            .map_err(|_| "acceptance marker write failed")?;
        for directory in [
            "home", "config", "data", "cache", "run", "projects", "scratch",
        ] {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(root.join(directory))
                .map_err(|_| "acceptance directory creation collided")?;
        }
    } else {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&marker)
            .map_err(|_| "existing directory is not an acceptance profile")?;
        let meta = file
            .metadata()
            .map_err(|_| "acceptance marker unavailable")?;
        if !meta.is_file()
            || meta.len() != 64
            || meta.nlink() != 1
            || meta.uid() != metadata.uid()
            || meta.mode() & 0o077 != 0
        {
            return Err("acceptance marker is not private".into());
        }
        let mut stored_path = [0u8; 32];
        file.read_exact(&mut stored_path)
            .and_then(|_| file.read_exact(&mut nonce))
            .map_err(|_| "acceptance marker is incomplete")?;
        if stored_path != path_digest {
            return Err("copied or relocated acceptance profile rejected".into());
        }
    }
    // Storage paths are not project fixtures: never follow a planted link on
    // restart. The ordinary workspace layer retains its stronger fd-relative
    // checks for writes. Same-user concurrent tampering is not sandboxed here.
    for directory in ["home", "config", "data", "cache", "run", "scratch"] {
        reject_storage_links(&root.join(directory), metadata.uid(), &mut 100_000)?;
    }
    for directory in [
        "home", "config", "data", "cache", "run", "projects", "scratch",
    ] {
        let meta = fs::symlink_metadata(root.join(directory))
            .map_err(|_| "acceptance directory missing")?;
        if !meta.is_dir()
            || meta.file_type().is_symlink()
            || meta.uid() != metadata.uid()
            || meta.mode() & 0o077 != 0
        {
            return Err("acceptance directory is not private".into());
        }
    }
    // Domain separation keeps external browser origins out of the cockpit store.
    let store = |domain: &[u8]| {
        let mut digest = Sha256::new();
        digest.update(path_digest);
        digest.update(nonce);
        digest.update(domain);
        let mut id: [u8; 16] = digest.finalize()[..16].try_into().unwrap();
        id[6] = (id[6] & 0x0f) | 0x40;
        id[8] = (id[8] & 0x3f) | 0x80;
        id
    };
    Ok(Profile {
        root,
        main_store: store(b"cockpit"),
        browser_store: store(b"browser"),
        _lock: lock,
    })
}

#[cfg(target_os = "macos")]
fn reject_storage_links(path: &Path, uid: u32, remaining: &mut usize) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    *remaining = remaining
        .checked_sub(1)
        .ok_or("acceptance storage exceeds validation bound")?;
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "acceptance storage unavailable")?;
    if metadata.file_type().is_symlink()
        || metadata.uid() != uid
        || metadata.mode() & 0o022 != 0
        || (metadata.is_file() && metadata.nlink() != 1)
    {
        return Err("acceptance storage contains a link or foreign owner".into());
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|_| "acceptance storage unavailable")? {
            reject_storage_links(
                &entry.map_err(|_| "acceptance storage unavailable")?.path(),
                uid,
                remaining,
            )?;
        }
    }
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn root(name: &str) -> PathBuf {
        std::env::current_dir()
            .unwrap()
            .join(format!("psyche-acceptance-{}-{name}", std::process::id()))
    }

    #[test]
    fn project_admission_rejects_profile_state_outside_and_parent_traversal() {
        let root = Path::new("/acceptance");
        assert!(is_local_project(
            root,
            Path::new("/acceptance/projects/repo")
        ));
        for path in [
            "/acceptance/projects",
            "/acceptance/home",
            "/personal/repo",
            "/acceptance/projects/../home",
            "/acceptance/projects-other/repo",
        ] {
            assert!(!is_local_project(root, Path::new(path)));
        }
    }

    #[test]
    fn profile_restarts_preserve_distinct_stores_and_reject_live_collision() {
        let root = root("restart");
        let first = open_profile(&root).unwrap();
        let main = first.main_store;
        let browser = first.browser_store;
        assert_ne!(main, browser);
        assert!(open_profile(&root).is_err());
        drop(first);
        // Other tests fork concurrently. CLOEXEC descriptors can briefly remain
        // open in their pre-exec child; production correctly refuses that overlap.
        let second = (0..100)
            .find_map(|_| match open_profile(&root) {
                Ok(profile) => Some(profile),
                Err(_) => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    None
                }
            })
            .expect("profile lock should release after child exec");
        assert_eq!(main, second.main_store);
        assert_eq!(browser, second.browser_store);
        drop(second);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unmarked_copied_shared_and_symlinked_state() {
        let root = root("negative");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(open_profile(&root).is_err());
        assert!(!root.join("profile.lock").exists());
        fs::remove_dir(&root).unwrap();
        drop(open_profile(&root).unwrap());
        let copied = root.with_file_name(format!("psyche-acceptance-{}-copy", std::process::id()));
        fs::create_dir(&copied).unwrap();
        fs::set_permissions(&copied, fs::Permissions::from_mode(0o700)).unwrap();
        fs::copy(root.join("profile.v1"), copied.join("profile.v1")).unwrap();
        assert!(open_profile(&copied).is_err());
        fs::remove_dir_all(copied).unwrap();
        symlink(root.join("projects"), root.join("home/linked")).unwrap();
        assert!(open_profile(&root).is_err());
        fs::remove_file(root.join("home/linked")).unwrap();
        fs::set_permissions(root.join("cache"), fs::Permissions::from_mode(0o777)).unwrap();
        assert!(open_profile(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
#[cfg(target_os = "macos")]
fn set_environment(profile: &Profile) -> Result<(), String> {
    // Called before the runtime creates threads. No inherited credential, proxy,
    // provider, shell startup, Git config, or developer injection variable survives.
    for (key, _) in std::env::vars_os() {
        std::env::remove_var(key);
    }
    for (key, value) in [
        ("HOME", "home"),
        ("CFFIXED_USER_HOME", "home"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_DATA_HOME", "data"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_RUNTIME_DIR", "run"),
        ("TMPDIR", "scratch"),
    ] {
        std::env::set_var(key, profile.root.join(value));
    }
    for (key, value) in [
        (
            "PATH",
            "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
        ),
        ("SHELL", "/bin/bash"),
        ("LANG", "en_US.UTF-8"),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_CONFIG_GLOBAL", "/dev/null"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_ATTR_NOSYSTEM", "1"),
        ("PSYCHE_NATIVE_WORKSPACE_V2", "1"),
    ] {
        std::env::set_var(key, value);
    }
    std::env::set_current_dir(profile.root.join("projects"))
        .map_err(|_| "acceptance cwd unavailable".into())
}
