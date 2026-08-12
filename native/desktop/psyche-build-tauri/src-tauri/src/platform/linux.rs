use std::ffi::OsString;

use super::RuntimePlatformInfo;

#[allow(dead_code)]
pub(super) fn runtime_info() -> RuntimePlatformInfo {
    RuntimePlatformInfo::from_parts(
        std::env::consts::OS,
        std::env::consts::ARCH,
        "WebKitGTK",
        tauri::webview_version().ok(),
    )
}

pub(super) fn default_shell() -> (String, Vec<String>) {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| "/bin/sh".to_string());
    (shell, vec!["-l".to_string()])
}

pub(super) fn augmented_path() -> OsString {
    std::env::var_os("PATH").unwrap_or_default()
}

pub(super) fn configure_window(_app: &tauri::App) -> Result<(), String> {
    Ok(())
}
