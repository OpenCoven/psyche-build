use std::ffi::OsString;
use std::path::{Path, PathBuf};

use tauri::Manager;
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

use super::{split_and_deduplicate_paths, RuntimePlatformInfo};

#[allow(dead_code)]
pub(super) fn runtime_info() -> RuntimePlatformInfo {
    RuntimePlatformInfo::from_parts(
        std::env::consts::OS,
        std::env::consts::ARCH,
        "WKWebView",
        tauri::webview_version().ok(),
    )
}

pub(super) fn default_shell() -> (String, Vec<String>) {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    (shell, vec!["-l".to_string()])
}

pub(super) fn augmented_path() -> OsString {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut parts = split_and_deduplicate_paths(&existing);

    for extra in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        push_unique_path(&mut parts, PathBuf::from(extra));
    }

    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        for suffix in [
            ".cargo/bin",
            ".local/bin",
            ".volta/bin",
            ".bun/bin",
            ".rbenv/shims",
            ".pyenv/shims",
        ] {
            push_path_if_dir(&mut parts, home.join(suffix));
        }
        if let Some(nvm_bin) = newest_nvm_node_bin(&home) {
            push_path_if_dir(&mut parts, nvm_bin);
        }
    }

    std::env::join_paths(&parts).unwrap_or(existing)
}

pub(super) fn configure_window(app: &tauri::App) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = apply_vibrancy(
            &window,
            NSVisualEffectMaterial::HudWindow,
            Some(NSVisualEffectState::Active),
            Some(10.0),
        );
    }
    Ok(())
}

fn push_unique_path(parts: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !parts.iter().any(|path| path == &candidate) {
        parts.push(candidate);
    }
}

fn push_path_if_dir(parts: &mut Vec<PathBuf>, candidate: PathBuf) {
    if candidate.is_dir() {
        push_unique_path(parts, candidate);
    }
}

fn newest_nvm_node_bin(home: &Path) -> Option<PathBuf> {
    let versions_dir = home.join(".nvm").join("versions").join("node");
    let mut newest: Option<((u32, u32, u32), PathBuf)> = None;
    for entry in std::fs::read_dir(versions_dir).ok()? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(version) = parse_nvm_node_version(&name.to_string_lossy()) else {
            continue;
        };
        if newest
            .as_ref()
            .map_or(true, |(current, _)| version > *current)
        {
            newest = Some((version, path));
        }
    }
    newest.map(|(_, path)| path.join("bin"))
}

fn parse_nvm_node_version(name: &str) -> Option<(u32, u32, u32)> {
    let trimmed = name.strip_prefix('v').unwrap_or(name);
    let mut parts = trimmed.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}
