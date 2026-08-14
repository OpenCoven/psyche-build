use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const SESSION_ID_MAX: usize = 96;
const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NativeLaunchKind {
    Shell,
    Psyche,
    CovenChat,
    CovenAttach,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeSessionCreate {
    pub(crate) id: String,
    pub(crate) project_root: String,
    pub(crate) cwd: String,
    pub(crate) launch_kind: NativeLaunchKind,
    pub(crate) coven_session_id: Option<String>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= SESSION_ID_MAX
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

pub(crate) fn session_name(id: &str) -> Result<String, String> {
    if !valid_id(id) {
        return Err("invalid native session id".to_string());
    }
    let encoded = id
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("psyche-{encoded}"))
}

fn session_id_from_name(name: &str) -> Option<String> {
    let encoded = name.strip_prefix("psyche-")?;
    if encoded.is_empty() || encoded.len() % 2 != 0 {
        return None;
    }
    let bytes = (0..encoded.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&encoded[index..index + 2], 16).ok())
        .collect::<Option<Vec<_>>>()?;
    let id = String::from_utf8(bytes).ok()?;
    valid_id(&id).then_some(id)
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) fn native_socket_path() -> Result<PathBuf, String> {
    let home = crate::platform::home_directory()
        .ok_or_else(|| "home directory is unavailable".to_string())?;
    Ok(PathBuf::from(home)
        .join(".psyche")
        .join("macos-app")
        .join("native-sessions.sock"))
}

fn ensure_native_session_dir(socket: &Path) -> Result<(), String> {
    let parent = socket
        .parent()
        .ok_or_else(|| "native session socket has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn build_create_args(
    socket: &Path,
    request: &NativeSessionCreate,
    command: &str,
    args: &[String],
) -> Result<Vec<String>, String> {
    let name = session_name(&request.id)?;
    if matches!(
        request.launch_kind,
        NativeLaunchKind::CovenChat | NativeLaunchKind::CovenAttach
    ) {
        let id = request
            .coven_session_id
            .as_deref()
            .ok_or_else(|| "Coven launch requires a session id".to_string())?;
        if !crate::coven_sessions::is_safe_session_id(id) {
            return Err("Coven session id is unsafe".to_string());
        }
    }
    let shell_command = std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    Ok(vec![
        "-S".into(),
        socket.to_string_lossy().into_owned(),
        "new-session".into(),
        "-d".into(),
        "-s".into(),
        name,
        "-c".into(),
        request.cwd.clone(),
        shell_command,
    ])
}

pub(crate) fn build_list_args(socket: &Path) -> Vec<String> {
    vec![
        "-S".into(),
        socket.to_string_lossy().into_owned(),
        "list-sessions".into(),
        "-F".into(),
        "#{session_name}".into(),
    ]
}

pub(crate) fn build_stop_args(socket: &Path, id: &str) -> Result<Vec<String>, String> {
    Ok(vec![
        "-S".into(),
        socket.to_string_lossy().into_owned(),
        "kill-session".into(),
        "-t".into(),
        session_name(id)?,
    ])
}

pub(crate) fn build_capture_args(socket: &Path, id: &str) -> Result<Vec<String>, String> {
    Ok(vec![
        "-S".into(),
        socket.to_string_lossy().into_owned(),
        "capture-pane".into(),
        "-p".into(),
        "-e".into(),
        "-S".into(),
        "-".into(),
        "-t".into(),
        session_name(id)?,
    ])
}

pub(crate) fn build_attach_args(socket: &Path, id: &str) -> Result<Vec<String>, String> {
    Ok(vec![
        "-S".into(),
        socket.to_string_lossy().into_owned(),
        "attach-session".into(),
        "-d".into(),
        "-t".into(),
        session_name(id)?,
    ])
}

fn ensure_trusted_caller(label: &str) -> Result<(), String> {
    if label == "main" {
        return Ok(());
    }
    Err(format!(
        "native session storage is only available to trusted webview 'main'; rejected caller '{label}'"
    ))
}

fn tmux_output(args: Vec<String>) -> Result<Output, String> {
    let tmux = crate::which_on_path("tmux")
        .ok_or_else(|| "tmux is unavailable; install tmux and restart Psyche".to_string())?;
    Command::new(tmux)
        .args(args)
        .output()
        .map_err(|error| format!("failed to run tmux: {error}"))
}

fn tmux_error(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

#[tauri::command]
pub(crate) fn native_session_create(
    webview: tauri::Webview,
    request: NativeSessionCreate,
) -> Result<(), String> {
    ensure_trusted_caller(webview.label())?;
    let opened_cwd = crate::open_pty_cwd(&request.project_root, &request.cwd)?;
    let mut canonical_request = request;
    canonical_request.cwd = opened_cwd.canonical_path.to_string_lossy().into_owned();
    let (command, args) = crate::native_launch_command(&canonical_request)?;
    let socket = native_socket_path()?;
    ensure_native_session_dir(&socket)?;
    let output = tmux_output(build_create_args(
        &socket,
        &canonical_request,
        &command,
        &args,
    )?)?;
    drop(opened_cwd);
    if output.status.success() {
        Ok(())
    } else {
        Err(tmux_error(&output))
    }
}

#[tauri::command]
pub(crate) fn native_session_list(webview: tauri::Webview) -> Result<Vec<String>, String> {
    ensure_trusted_caller(webview.label())?;
    let output = tmux_output(build_list_args(&native_socket_path()?))?;
    if !output.status.success() {
        let stderr = tmux_error(&output);
        if stderr.contains("no server running") || stderr.contains("failed to connect") {
            return Ok(Vec::new());
        }
        return Err(stderr);
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(session_id_from_name)
        .collect())
}

#[tauri::command]
pub(crate) fn native_session_stop(webview: tauri::Webview, id: String) -> Result<(), String> {
    ensure_trusted_caller(webview.label())?;
    let output = tmux_output(build_stop_args(&native_socket_path()?, &id)?)?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = tmux_error(&output);
    if stderr.contains("can't find session") || stderr.contains("no server running") {
        return Ok(());
    }
    Err(format!("failed to stop native session {id}: {stderr}"))
}

#[tauri::command]
pub(crate) fn native_session_capture(
    webview: tauri::Webview,
    id: String,
) -> Result<Vec<u8>, String> {
    ensure_trusted_caller(webview.label())?;
    let output = tmux_output(build_capture_args(&native_socket_path()?, &id)?)?;
    if !output.status.success() {
        return Err(tmux_error(&output));
    }
    if output.stdout.len() > MAX_CAPTURE_BYTES {
        return Err("native session capture exceeds maximum size".to_string());
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::{
        build_attach_args, build_capture_args, build_create_args, build_list_args, build_stop_args,
        session_name, shell_quote, NativeLaunchKind, NativeSessionCreate,
    };
    use std::path::Path;

    fn request(kind: NativeLaunchKind) -> NativeSessionCreate {
        NativeSessionCreate {
            id: "session-1".to_string(),
            project_root: "/repo".to_string(),
            cwd: "/repo/worktree".to_string(),
            launch_kind: kind,
            coven_session_id: None,
        }
    }

    #[test]
    fn uses_an_explicit_isolated_socket_for_every_tmux_operation() {
        let socket = Path::new("/tmp/psyche-native.sock");
        assert_eq!(
            &build_list_args(socket)[0..2],
            ["-S", "/tmp/psyche-native.sock"]
        );
        assert_eq!(
            &build_stop_args(socket, "session-1").unwrap()[0..2],
            ["-S", "/tmp/psyche-native.sock"]
        );
        assert_eq!(
            &build_capture_args(socket, "session-1").unwrap()[0..2],
            ["-S", "/tmp/psyche-native.sock"]
        );
        assert_eq!(
            &build_create_args(socket, &request(NativeLaunchKind::Shell), "/bin/zsh", &[]).unwrap()
                [0..2],
            ["-S", "/tmp/psyche-native.sock"]
        );
    }

    #[test]
    fn derives_bounded_opaque_tmux_names() {
        assert_eq!(
            session_name("session-1").unwrap(),
            "psyche-73657373696f6e2d31"
        );
        assert!(session_name("bad id").is_err());
        assert!(session_name(&"x".repeat(97)).is_err());
    }

    #[test]
    fn quotes_each_trusted_command_argument() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn coven_launch_requires_a_safe_session_id() {
        for kind in [NativeLaunchKind::CovenChat, NativeLaunchKind::CovenAttach] {
            let mut launch = request(kind);
            launch.coven_session_id = Some("valid:session-1".to_string());
            assert!(build_create_args(
                Path::new("/tmp/socket"),
                &launch,
                "/usr/local/bin/coven",
                &[]
            )
            .is_ok());
            launch.coven_session_id = Some("../unsafe".to_string());
            assert!(build_create_args(
                Path::new("/tmp/socket"),
                &launch,
                "/usr/local/bin/coven",
                &[]
            )
            .is_err());
        }
    }

    #[test]
    fn attach_uses_the_owned_socket_and_stable_session_name() {
        assert_eq!(
            build_attach_args(Path::new("/tmp/native.sock"), "session-1").unwrap(),
            vec![
                "-S",
                "/tmp/native.sock",
                "attach-session",
                "-d",
                "-t",
                "psyche-73657373696f6e2d31",
            ]
        );
    }
}
