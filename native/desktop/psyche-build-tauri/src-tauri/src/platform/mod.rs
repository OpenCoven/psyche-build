use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlatformFamily {
    Unix,
    Windows,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LaunchDescriptor {
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
}

/// A fixture launch selected by the debug-only diagnostics boundary.
///
/// Normal PTY launches must continue to use [`pty_launch_descriptor`], which
/// preserves the user's shell behavior. Diagnostics fixtures are different:
/// their executable is selected by platform code and must be launched
/// directly, without passing through that shell resolution path.
#[cfg(debug_assertions)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TrustedFixtureLaunch {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
}

#[cfg(debug_assertions)]
impl TrustedFixtureLaunch {
    pub(crate) fn into_descriptor(self) -> LaunchDescriptor {
        direct_launch(self.program, self.args)
    }
}

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

fn direct_launch(command: String, args: Vec<String>) -> LaunchDescriptor {
    LaunchDescriptor {
        command,
        args,
        env: Vec::new(),
    }
}

#[cfg(debug_assertions)]
pub(crate) fn diagnostics_fixture_launch(
    args: Vec<String>,
) -> Result<TrustedFixtureLaunch, String> {
    Ok(TrustedFixtureLaunch {
        program: target::diagnostics_shell()?,
        args,
    })
}

#[cfg(all(debug_assertions, unix))]
fn verified_fixed_executable(path: &str) -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;

    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("failed to resolve trusted executable '{path}': {error}"))?;
    let metadata = canonical.metadata().map_err(|error| {
        format!(
            "failed to inspect trusted executable '{}': {error}",
            canonical.display()
        )
    })?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err(format!(
            "trusted executable '{}' is not an executable file",
            canonical.display()
        ));
    }
    Ok(canonical.to_string_lossy().into_owned())
}

fn is_windows_batch_script(command: &str) -> bool {
    Path::new(command)
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
}

fn windows_command_shell_path(command: String) -> String {
    if let Some(path) = command.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{path}");
    }
    command
        .strip_prefix("\\\\?\\")
        .unwrap_or(&command)
        .to_string()
}

fn windows_batch_launch(
    command: String,
    args: Vec<String>,
    comspec: Option<String>,
) -> Result<LaunchDescriptor, String> {
    let comspec = comspec.ok_or_else(|| "COMSPEC is unavailable for batch launch".to_string())?;
    let mut command_line = "\"\"!PSYCHE_LAUNCH_TARGET!\"".to_string();
    let mut env = vec![(
        "PSYCHE_LAUNCH_TARGET".to_string(),
        windows_command_shell_path(command),
    )];
    for (index, argument) in args.into_iter().enumerate() {
        let name = format!("PSYCHE_LAUNCH_ARG_{index}");
        command_line.push_str(&format!(" \"!{name}!\""));
        env.push((name, argument));
    }
    command_line.push('"');

    Ok(LaunchDescriptor {
        command: comspec,
        args: vec![
            "/D".to_string(),
            "/V:ON".to_string(),
            "/S".to_string(),
            "/C".to_string(),
            command_line,
        ],
        env,
    })
}

fn launch_descriptor_for(
    family: PlatformFamily,
    command: String,
    args: Vec<String>,
    login_shell: (String, Vec<String>),
    comspec: Option<String>,
) -> Result<LaunchDescriptor, String> {
    match family {
        PlatformFamily::Windows if is_windows_batch_script(&command) => {
            windows_batch_launch(command, args, comspec)
        }
        PlatformFamily::Windows => Ok(direct_launch(command, args)),
        PlatformFamily::Unix => {
            let (shell, mut shell_args) = login_shell;
            shell_args.push("-c".to_string());
            shell_args.push("exec \"$0\" \"$@\"".to_string());
            shell_args.push(command);
            shell_args.extend(args);
            Ok(direct_launch(shell, shell_args))
        }
    }
}

pub(crate) fn pty_launch_descriptor(
    command: Option<String>,
    args: Option<Vec<String>>,
) -> Result<LaunchDescriptor, String> {
    let default = default_shell();
    let command = command.unwrap_or_else(|| default.0.clone());
    let args = args.unwrap_or_else(|| default.1.clone());
    if command == default.0 && args == default.1 {
        return Ok(direct_launch(command, args));
    }

    #[cfg(unix)]
    let family = PlatformFamily::Unix;
    #[cfg(target_os = "windows")]
    let family = PlatformFamily::Windows;
    #[cfg(unix)]
    let comspec = None;
    #[cfg(target_os = "windows")]
    let comspec = Some(target::command_processor());

    launch_descriptor_for(family, command, args, default, comspec)
}

fn non_empty(value: Option<OsString>) -> Option<OsString> {
    value.filter(|value| !value.is_empty())
}

fn home_directory_for(
    family: PlatformFamily,
    home: Option<OsString>,
    user_profile: Option<OsString>,
) -> Option<OsString> {
    match family {
        PlatformFamily::Unix => non_empty(home),
        PlatformFamily::Windows => non_empty(user_profile).or_else(|| non_empty(home)),
    }
}

fn psyche_user_config_directory_for(
    family: PlatformFamily,
    home: Option<OsString>,
    user_profile: Option<OsString>,
) -> Option<PathBuf> {
    home_directory_for(family, home, user_profile)
        .map(|home| PathBuf::from(home).join(".config").join("psyche"))
}

pub fn home_directory() -> Option<String> {
    #[cfg(unix)]
    let family = PlatformFamily::Unix;
    #[cfg(target_os = "windows")]
    let family = PlatformFamily::Windows;

    home_directory_for(
        family,
        std::env::var_os("HOME"),
        std::env::var_os("USERPROFILE"),
    )
    .and_then(|home| home.into_string().ok())
}

pub fn psyche_user_config_directory() -> Option<PathBuf> {
    #[cfg(unix)]
    let family = PlatformFamily::Unix;
    #[cfg(target_os = "windows")]
    let family = PlatformFamily::Windows;

    psyche_user_config_directory_for(
        family,
        std::env::var_os("HOME"),
        std::env::var_os("USERPROFILE"),
    )
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

    #[cfg(debug_assertions)]
    #[test]
    fn diagnostics_fixture_launch_is_absolute_and_bypasses_the_normal_shell_wrapper() {
        let launch =
            diagnostics_fixture_launch(vec!["-c".to_string(), "printf fixture".to_string()])
                .unwrap();
        assert!(Path::new(&launch.program).is_absolute());

        let descriptor = launch.clone().into_descriptor();
        assert_eq!(descriptor.command, launch.program);
        assert_eq!(descriptor.args, launch.args);
        assert!(descriptor.env.is_empty());
        assert!(!descriptor
            .args
            .iter()
            .any(|arg| arg == "exec \"$0\" \"$@\""));
    }

    #[test]
    fn windows_native_executable_launches_directly() {
        let descriptor = launch_descriptor_for(
            PlatformFamily::Windows,
            r"C:\Program Files\node.exe".to_string(),
            vec![
                r"C:\repo with spaces\dist\index.js".to_string(),
                "two words".to_string(),
            ],
            ("/bin/ignored".to_string(), vec!["-l".to_string()]),
            Some(r"C:\Windows\System32\cmd.exe".to_string()),
        )
        .unwrap();

        assert_eq!(
            descriptor,
            LaunchDescriptor {
                command: r"C:\Program Files\node.exe".to_string(),
                args: vec![
                    r"C:\repo with spaces\dist\index.js".to_string(),
                    "two words".to_string(),
                ],
                env: Vec::new(),
            }
        );
    }

    #[test]
    fn windows_batch_script_uses_comspec_without_interpolating_raw_arguments() {
        for extension in ["cmd", "BAT"] {
            for (target, shell_target) in [
                (
                    format!(r"\\?\C:\repo & tools\launch.{extension}"),
                    format!(r"C:\repo & tools\launch.{extension}"),
                ),
                (
                    format!(r"\\?\UNC\server\share\launch.{extension}"),
                    format!(r"\\server\share\launch.{extension}"),
                ),
            ] {
                let raw_args = vec![
                    "plain".to_string(),
                    "two words".to_string(),
                    "a&b %PATH% \"quoted\" !bang!".to_string(),
                ];
                let descriptor = launch_descriptor_for(
                    PlatformFamily::Windows,
                    target.clone(),
                    raw_args.clone(),
                    ("/bin/ignored".to_string(), vec!["-l".to_string()]),
                    Some(r"C:\Windows\System32\cmd.exe".to_string()),
                )
                .unwrap();

                assert_eq!(descriptor.command, r"C:\Windows\System32\cmd.exe");
                assert_eq!(
                    descriptor.args,
                    vec![
                        "/D".to_string(),
                        "/V:ON".to_string(),
                        "/S".to_string(),
                        "/C".to_string(),
                        concat!(
                            "\"\"!PSYCHE_LAUNCH_TARGET!\" ",
                            "\"!PSYCHE_LAUNCH_ARG_0!\" ",
                            "\"!PSYCHE_LAUNCH_ARG_1!\" ",
                            "\"!PSYCHE_LAUNCH_ARG_2!\"\""
                        )
                        .to_string(),
                    ]
                );
                assert_eq!(
                    descriptor.env,
                    vec![
                        ("PSYCHE_LAUNCH_TARGET".to_string(), shell_target),
                        ("PSYCHE_LAUNCH_ARG_0".to_string(), raw_args[0].clone()),
                        ("PSYCHE_LAUNCH_ARG_1".to_string(), raw_args[1].clone()),
                        ("PSYCHE_LAUNCH_ARG_2".to_string(), raw_args[2].clone()),
                    ]
                );
                assert!(!descriptor.args.join(" ").contains("repo & tools"));
                assert!(!descriptor.args.join(" ").contains("%PATH%"));
            }
        }
    }

    #[test]
    fn unix_target_launch_uses_login_shell_positional_arguments() {
        let descriptor = launch_descriptor_for(
            PlatformFamily::Unix,
            "/opt/node bin/node".to_string(),
            vec![
                "/repo with spaces/dist/index.js".to_string(),
                "literal $HOME; echo unsafe".to_string(),
            ],
            ("/bin/zsh".to_string(), vec!["-l".to_string()]),
            None,
        )
        .unwrap();

        assert_eq!(
            descriptor,
            LaunchDescriptor {
                command: "/bin/zsh".to_string(),
                args: vec![
                    "-l".to_string(),
                    "-c".to_string(),
                    "exec \"$0\" \"$@\"".to_string(),
                    "/opt/node bin/node".to_string(),
                    "/repo with spaces/dist/index.js".to_string(),
                    "literal $HOME; echo unsafe".to_string(),
                ],
                env: Vec::new(),
            }
        );
    }

    #[test]
    fn windows_home_uses_userprofile_when_home_is_missing() {
        assert_eq!(
            home_directory_for(
                PlatformFamily::Windows,
                None,
                Some(OsString::from(r"C:\Users\tester")),
            ),
            Some(OsString::from(r"C:\Users\tester"))
        );
    }

    #[test]
    fn windows_home_prefers_userprofile_and_builds_the_shared_config_directory() {
        let home = Some(OsString::from(r"C:\Users\fallback"));
        let user_profile = Some(OsString::from(r"C:\Users\primary"));

        assert_eq!(
            home_directory_for(PlatformFamily::Windows, home.clone(), user_profile.clone(),),
            user_profile.clone()
        );
        assert_eq!(
            psyche_user_config_directory_for(PlatformFamily::Windows, home, user_profile),
            Some(
                PathBuf::from(r"C:\Users\primary")
                    .join(".config")
                    .join("psyche")
            )
        );
    }

    #[test]
    fn unix_home_directory_ignores_userprofile_when_building_the_config_directory() {
        let home = Some(OsString::from("/home/dev"));
        let user_profile = Some(OsString::from("/ignored/profile"));

        assert_eq!(
            home_directory_for(PlatformFamily::Unix, home.clone(), user_profile),
            home.clone()
        );
        assert_eq!(
            psyche_user_config_directory_for(
                PlatformFamily::Unix,
                home,
                Some(OsString::from("/ignored/profile")),
            ),
            Some(PathBuf::from("/home/dev").join(".config").join("psyche"))
        );
    }
}
