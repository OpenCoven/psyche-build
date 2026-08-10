use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
use linux as target;
#[cfg(target_os = "macos")]
use macos as target;
#[cfg(target_os = "windows")]
use windows as target;

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
compile_error!("the desktop runtime supports macOS, Windows, and Linux");

#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct RuntimePlatformInfo {
    pub os: &'static str,
    pub arch: &'static str,
    pub webview_engine: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webview_version: Option<String>,
}

#[allow(dead_code)]
impl RuntimePlatformInfo {
    fn from_parts(
        os: &'static str,
        arch: &'static str,
        webview_engine: &'static str,
        webview_version: Option<String>,
    ) -> Self {
        Self {
            os,
            arch,
            webview_engine,
            webview_version,
        }
    }
}

#[allow(dead_code)]
pub fn runtime_info() -> RuntimePlatformInfo {
    target::runtime_info()
}

pub fn default_shell() -> (String, Vec<String>) {
    target::default_shell()
}

pub fn augmented_path() -> OsString {
    target::augmented_path()
}

pub fn configure_window(app: &tauri::App) -> Result<(), String> {
    target::configure_window(app)
}

fn split_and_deduplicate_paths(path: &OsStr) -> Vec<PathBuf> {
    let mut parts = Vec::new();
    for part in std::env::split_paths(path) {
        if !part.as_os_str().is_empty() && !parts.iter().any(|existing| existing == &part) {
            parts.push(part);
        }
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_info_omits_an_unavailable_webview_version() {
        let info = RuntimePlatformInfo::from_parts("linux", "x86_64", "WebKitGTK", None);
        assert_eq!(info.webview_engine, "WebKitGTK");
        assert_eq!(info.webview_version, None);
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            serde_json::json!({
                "os": "linux",
                "arch": "x86_64",
                "webview_engine": "WebKitGTK"
            })
        );
    }

    #[test]
    fn environment_paths_round_trip_with_platform_separators() {
        let input =
            std::env::join_paths([std::path::Path::new("one"), std::path::Path::new("two")])
                .unwrap();
        assert_eq!(split_and_deduplicate_paths(&input).len(), 2);
    }

    #[test]
    fn environment_paths_are_deduplicated_without_string_separators() {
        let input = std::env::join_paths([
            std::path::Path::new("one"),
            std::path::Path::new("one"),
            std::path::Path::new("two"),
        ])
        .unwrap();
        assert_eq!(
            split_and_deduplicate_paths(&input),
            vec![
                std::path::PathBuf::from("one"),
                std::path::PathBuf::from("two")
            ]
        );
    }
}
