use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::RuntimePlatformInfo;

#[allow(dead_code)]
pub(super) fn runtime_info() -> RuntimePlatformInfo {
    RuntimePlatformInfo::from_parts(
        std::env::consts::OS,
        std::env::consts::ARCH,
        "WebView2",
        tauri::webview_version().ok(),
    )
}

pub(super) fn default_shell() -> (String, Vec<String>) {
    if std::env::var_os("PSModulePath")
        .filter(|value| !value.is_empty())
        .is_some()
    {
        if let Some(powershell) = find_powershell() {
            return (powershell, vec!["-NoLogo".to_string()]);
        }
    }

    (command_processor(), Vec::new())
}

#[cfg(debug_assertions)]
pub(super) fn diagnostics_shell() -> Result<String, String> {
    find_powershell().ok_or_else(|| {
        "no verified PowerShell executable was found in PATH or known system locations".to_string()
    })
}

pub(super) fn command_processor() -> String {
    let comspec = std::env::var_os("COMSPEC")
        .filter(|shell| !shell.is_empty())
        .map(|shell| shell.to_string_lossy().to_string())
        .unwrap_or_else(|| "cmd.exe".to_string());
    comspec
}

pub(super) fn augmented_path() -> OsString {
    std::env::var_os("PATH").unwrap_or_default()
}

pub(super) fn configure_window(_app: &tauri::App) -> Result<(), String> {
    Ok(())
}

fn find_powershell() -> Option<String> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    for directory in std::env::split_paths(&path) {
        for executable in ["pwsh.exe", "powershell.exe"] {
            if let Some(found) = verified_executable(directory.join(executable)) {
                return Some(found);
            }
        }
    }

    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        let candidate = Path::new(&program_files)
            .join("PowerShell")
            .join("7")
            .join("pwsh.exe");
        if let Some(found) = verified_executable(candidate) {
            return Some(found);
        }
    }

    let system_root = std::env::var_os("SystemRoot")?;
    verified_executable(
        Path::new(&system_root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe"),
    )
}

fn verified_executable(candidate: PathBuf) -> Option<String> {
    let canonical = candidate.canonicalize().ok()?;
    canonical
        .is_file()
        .then(|| canonical.to_string_lossy().to_string())
}
