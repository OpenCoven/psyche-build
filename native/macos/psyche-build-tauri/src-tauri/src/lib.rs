use std::collections::{HashMap, HashSet};
#[cfg(unix)]
use std::ffi::CString;
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl,
};

mod coven_sessions;
mod metrics;
mod pane_metrics;
mod workspace_contract;
use coven_sessions::coven_sessions;
use coven_sessions::is_safe_session_id;
use metrics::{MetricsCollector, MetricsScope, MetricsSnapshot, TrackedPty};
use pane_metrics::PaneSessionMetrics;

const BROWSER_LABEL_PREFIX: &str = "psyche-browser-";
const COVEN_SESSION_SOURCE: &str = "COVEN_SESSION_SOURCE";
const PSYCHE_SESSION_SOURCE: &str = "psyche-build";

fn safe_browser_label(label: Option<String>) -> String {
    let raw = label.unwrap_or_else(|| "default".to_string());
    let safe: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    format!(
        "{}{}",
        BROWSER_LABEL_PREFIX,
        if safe.is_empty() { "default" } else { &safe }
    )
}

// ----------------------------------------------------------------------------
// Multi-PTY backend
// ----------------------------------------------------------------------------

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pid: Option<u32>,
    spawn_time_unix_secs: u64,
}

static SESSIONS: Lazy<Mutex<HashMap<String, PtySession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static STARTING_SESSIONS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static AUGMENTED_PATH: Lazy<String> = Lazy::new(compute_augmented_path);

#[derive(Clone, Default)]
struct MetricsState {
    collector: Arc<Mutex<MetricsCollector>>,
}

#[derive(Debug)]
struct PendingPtyStart {
    thread_id: String,
}

impl PendingPtyStart {
    fn reserve(thread_id: &str) -> Result<Self, String> {
        let sessions = SESSIONS.lock();
        let mut starting = STARTING_SESSIONS.lock();
        if sessions.contains_key(thread_id) || starting.contains(thread_id) {
            return Err(format!("thread '{}' already running", thread_id));
        }
        starting.insert(thread_id.to_string());
        Ok(Self {
            thread_id: thread_id.to_string(),
        })
    }
}

impl Drop for PendingPtyStart {
    fn drop(&mut self) {
        let mut starting = STARTING_SESSIONS.lock();
        starting.remove(&self.thread_id);
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StartOptions {
    pub thread_id: String,
    pub project_root: Option<String>,
    pub cwd: Option<String>,
    pub launch_kind: Option<String>,
    pub coven_session_id: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// Extra environment variables on top of the inherited environment.
    pub env: Option<HashMap<String, String>>,
}

#[cfg(unix)]
#[derive(Debug)]
struct OpenedPtyCwd {
    _directory: std::fs::File,
    spawn_path: PathBuf,
    canonical_path: PathBuf,
}

#[cfg(not(unix))]
#[derive(Debug)]
struct OpenedPtyCwd {
    spawn_path: PathBuf,
    canonical_path: PathBuf,
}

impl OpenedPtyCwd {
    fn configure_command_cwd(&self, command: &mut CommandBuilder) -> Result<(), String> {
        #[cfg(unix)]
        if !locator_matches_open_directory(&self.spawn_path, &self._directory) {
            return Err(format!(
                "stable PTY cwd locator is unavailable: {}",
                self.spawn_path.display()
            ));
        }
        #[cfg(not(unix))]
        if !self.spawn_path.is_dir() {
            return Err(format!(
                "stable PTY cwd locator is unavailable: {}",
                self.spawn_path.display()
            ));
        }
        command.cwd(&self.spawn_path);
        Ok(())
    }
}

#[cfg(unix)]
fn locator_matches_open_directory(locator: &Path, directory: &std::fs::File) -> bool {
    let Ok(locator_metadata) = locator.metadata() else {
        return false;
    };
    let Ok(directory_metadata) = directory.metadata() else {
        return false;
    };
    locator_metadata.is_dir()
        && locator_metadata.dev() == directory_metadata.dev()
        && locator_metadata.ino() == directory_metadata.ino()
}

fn validate_opened_pty_cwd(
    canonical_root: &Path,
    canonical_candidate: &Path,
    linked_worktrees: &[PathBuf],
    cwd: &str,
) -> Result<(), String> {
    if canonical_candidate.starts_with(canonical_root) {
        return Ok(());
    }

    for worktree in linked_worktrees {
        let canonical_worktree = match worktree.canonicalize() {
            Ok(path) if path.is_dir() => path,
            _ => continue,
        };
        if canonical_candidate.starts_with(canonical_worktree) {
            return Ok(());
        }
    }

    Err(format!(
        "PTY cwd is outside the project and its linked worktrees: {}",
        cwd
    ))
}

#[cfg(unix)]
fn directory_path_from_handle(directory: &std::fs::File, cwd: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let mut buffer = vec![0u8; libc::PATH_MAX as usize];
        let result = unsafe {
            libc::fcntl(
                directory.as_raw_fd(),
                libc::F_GETPATH,
                buffer.as_mut_ptr() as *mut libc::c_void,
            )
        };
        if result == -1 {
            return Err(format!(
                "PTY cwd '{}': {}",
                cwd,
                std::io::Error::last_os_error()
            ));
        }
        let length = buffer
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(buffer.len());
        return Ok(PathBuf::from(std::ffi::OsStr::from_bytes(
            &buffer[..length],
        )));
    }

    #[cfg(not(target_os = "macos"))]
    {
        std::fs::read_link(format!("/proc/self/fd/{}", directory.as_raw_fd()))
            .map_err(|e| format!("PTY cwd '{}': {}", cwd, e))
    }
}

#[cfg(unix)]
fn open_pty_cwd_candidate(candidate: &Path, cwd: &str) -> Result<OpenedPtyCwd, String> {
    let directory =
        std::fs::File::open(candidate).map_err(|e| format!("PTY cwd '{}': {}", cwd, e))?;
    let metadata = directory
        .metadata()
        .map_err(|e| format!("PTY cwd '{}': {}", cwd, e))?;
    if !metadata.is_dir() {
        return Err(format!("PTY cwd is not a directory: {}", cwd));
    }
    #[cfg(target_os = "macos")]
    let locator_candidates = vec![PathBuf::from(format!(
        "/.vol/{}/{}",
        metadata.dev(),
        metadata.ino()
    ))];
    #[cfg(not(target_os = "macos"))]
    let locator_candidates = vec![
        PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd())),
        PathBuf::from(format!("/dev/fd/{}", directory.as_raw_fd())),
    ];
    let spawn_path = locator_candidates
        .into_iter()
        .find(|locator| locator_matches_open_directory(locator, &directory))
        .ok_or_else(|| format!("stable PTY cwd locator is unavailable for '{}'", cwd))?;
    let canonical_path = directory_path_from_handle(&directory, cwd)?;
    Ok(OpenedPtyCwd {
        _directory: directory,
        spawn_path,
        canonical_path,
    })
}

#[cfg(not(unix))]
fn open_pty_cwd_candidate(candidate: &Path, cwd: &str) -> Result<OpenedPtyCwd, String> {
    let canonical_path = candidate
        .canonicalize()
        .map_err(|e| format!("PTY cwd '{}': {}", cwd, e))?;
    if !canonical_path.is_dir() {
        return Err(format!("PTY cwd is not a directory: {}", cwd));
    }
    Ok(OpenedPtyCwd {
        spawn_path: canonical_path.clone(),
        canonical_path,
    })
}

fn pty_cwd_candidate(canonical_root: &Path, cwd: &str) -> PathBuf {
    let requested = Path::new(cwd);
    if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        canonical_root.join(requested)
    }
}

// Test-only variant of `open_pty_cwd` that takes the linked worktrees as an
// argument instead of shelling out to `git worktree list`, so the containment
// checks can be exercised without a real multi-worktree repo on disk.
#[cfg(test)]
fn open_pty_cwd_with_worktrees(
    project_root: &str,
    cwd: &str,
    linked_worktrees: &[PathBuf],
) -> Result<OpenedPtyCwd, String> {
    let canonical_root = canonical_project_root(project_root)?;
    let candidate = pty_cwd_candidate(&canonical_root, cwd);
    let opened = open_pty_cwd_candidate(&candidate, cwd)?;
    validate_opened_pty_cwd(
        &canonical_root,
        &opened.canonical_path,
        linked_worktrees,
        cwd,
    )?;
    Ok(opened)
}

#[cfg(test)]
fn resolve_pty_cwd_with_worktrees(
    project_root: &str,
    cwd: &str,
    linked_worktrees: &[PathBuf],
) -> Result<PathBuf, String> {
    open_pty_cwd_with_worktrees(project_root, cwd, linked_worktrees)
        .map(|opened| opened.canonical_path)
}

fn linked_worktree_roots(project_root: &Path) -> Result<Vec<PathBuf>, String> {
    let root = project_root
        .to_str()
        .ok_or_else(|| "project root is not valid UTF-8".to_string())?;
    let raw = run_git(root, &["worktree", "list", "--porcelain"])?;
    Ok(parse_git_worktrees(&raw)
        .into_iter()
        .filter(|worktree| !worktree.bare && !worktree.prunable && !worktree.missing)
        .filter_map(|worktree| {
            let canonical = Path::new(&worktree.path).canonicalize().ok()?;
            canonical.is_dir().then_some(canonical)
        })
        .collect())
}

fn open_pty_cwd(project_root: &str, cwd: &str) -> Result<OpenedPtyCwd, String> {
    let canonical_root = canonical_project_root(project_root)?;
    let candidate = pty_cwd_candidate(&canonical_root, cwd);
    let opened = open_pty_cwd_candidate(&candidate, cwd)?;
    if opened.canonical_path.starts_with(&canonical_root) {
        return Ok(opened);
    }

    let linked_worktrees = linked_worktree_roots(&canonical_root)?;
    validate_opened_pty_cwd(
        &canonical_root,
        &opened.canonical_path,
        &linked_worktrees,
        cwd,
    )?;
    Ok(opened)
}

#[cfg(test)]
fn resolve_pty_cwd(project_root: &str, cwd: &str) -> Result<PathBuf, String> {
    open_pty_cwd(project_root, cwd).map(|opened| opened.canonical_path)
}

fn prepare_pty_start(options: &StartOptions) -> Result<(PendingPtyStart, OpenedPtyCwd), String> {
    let thread_id = options.thread_id.clone();
    let pending_start = PendingPtyStart::reserve(&thread_id)?;
    let project_root = options
        .project_root
        .as_deref()
        .ok_or_else(|| "projectRoot is required".to_string())?;
    let cwd = options.cwd.as_deref().unwrap_or(project_root);
    let resolved_cwd = open_pty_cwd(project_root, cwd)?;
    Ok((pending_start, resolved_cwd))
}

fn has_exact_psyche_source(env: Option<&HashMap<String, String>>) -> bool {
    matches!(env, Some(values) if values.len() == 1
        && values.get(COVEN_SESSION_SOURCE).map(String::as_str) == Some(PSYCHE_SESSION_SOURCE))
}

fn has_no_launch_env(env: Option<&HashMap<String, String>>) -> bool {
    env.map_or(true, HashMap::is_empty)
}

fn validate_coven_launch_with(
    options: &StartOptions,
    resolved_coven: Option<&str>,
) -> Result<(), String> {
    let Some(launch_kind) = options.launch_kind.as_deref() else {
        return Ok(());
    };
    if !matches!(launch_kind, "coven-chat" | "coven-attach") {
        return Err(format!("unsupported launch kind: {launch_kind}"));
    }

    let resolved_coven = resolved_coven.ok_or_else(|| "Coven executable not found".to_string())?;
    if options.command.as_deref() != Some(resolved_coven) {
        return Err("Coven launch command does not match the resolved executable".to_string());
    }

    match launch_kind {
        "coven-chat" => {
            if !has_exact_psyche_source(options.env.as_ref()) {
                return Err(
                    "coven-chat requires exactly COVEN_SESSION_SOURCE=psyche-build".to_string(),
                );
            }
            let session_id = options
                .coven_session_id
                .as_deref()
                .ok_or_else(|| "coven-chat requires a session id".to_string())?;
            if !is_safe_session_id(session_id) {
                return Err("coven-chat session id is unsafe".to_string());
            }
            match options.args.as_deref() {
                Some([verb, flag, argument])
                    if verb == "code" && flag == "--session-id" && argument == session_id =>
                {
                    Ok(())
                }
                _ => Err(
                    "coven-chat requires exactly 'code --session-id' and the validated session id"
                        .to_string(),
                ),
            }
        }
        "coven-attach" => {
            if !has_no_launch_env(options.env.as_ref()) {
                return Err("coven-attach does not accept launch environment entries".to_string());
            }
            let session_id = options
                .coven_session_id
                .as_deref()
                .ok_or_else(|| "coven-attach requires a session id".to_string())?;
            if !is_safe_session_id(session_id) {
                return Err("coven-attach session id is unsafe".to_string());
            }
            match options.args.as_deref() {
                Some([verb, argument]) if verb == "attach" && argument == session_id => Ok(()),
                _ => Err(
                    "coven-attach requires exactly 'attach' and the validated session id"
                        .to_string(),
                ),
            }
        }
        _ => unreachable!("launch kind was checked above"),
    }
}

fn validate_coven_launch(options: &StartOptions) -> Result<(), String> {
    let resolved_coven = which_on_path("coven");
    validate_coven_launch_with(options, resolved_coven.as_deref())
}

fn apply_launch_env(
    cmd: &mut CommandBuilder,
    env: Option<&HashMap<String, String>>,
    launch_kind: Option<&str>,
) {
    if let Some(extra_env) = env {
        for (key, value) in extra_env {
            // Empty-string values are treated as "unset this variable" so the
            // JS layer can scrub TMUX (which tmux uses to detect nesting).
            if value.is_empty() {
                cmd.env_remove(key);
            } else {
                cmd.env(key, value);
            }
        }
    }
    if launch_kind == Some("coven-attach") {
        cmd.env_remove(COVEN_SESSION_SOURCE);
    }
}

#[tauri::command]
fn canonical_project_path(root: String) -> Result<String, String> {
    canonical_project_root(&root).map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
async fn pane_session_metrics(
    project_root: String,
    cwd: String,
    session_id: String,
) -> Result<PaneSessionMetrics, String> {
    if !is_safe_session_id(&session_id) {
        return Err("session id is unsafe".to_string());
    }
    let resolved_cwd = open_pty_cwd(&project_root, &cwd)?;
    let coven = which_on_path("coven").ok_or_else(|| "Coven executable not found".to_string())?;
    let canonical_cwd = resolved_cwd.canonical_path;
    let path = augmented_path().to_string();

    match tauri::async_runtime::spawn_blocking(move || {
        pane_metrics::load_coven_metrics(
            &coven,
            &canonical_cwd,
            &session_id,
            std::ffi::OsStr::new(&path),
        )
    })
    .await
    {
        Ok(metrics) => metrics,
        Err(error) => Err(format!("failed to join Coven metrics task: {error}")),
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PtyDataEvent {
    pub thread_id: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PtyExitEvent {
    pub thread_id: String,
    pub code: Option<i32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BrowserPageLoadEvent {
    pub label: String,
    pub url: String,
    pub phase: String,
}

#[tauri::command]
fn pty_start(app: AppHandle, options: StartOptions) -> Result<(), String> {
    let thread_id = options.thread_id.clone();
    let (pending_start, resolved_cwd) = prepare_pty_start(&options)?;
    validate_coven_launch(&options)?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: options.rows.unwrap_or(40),
            cols: options.cols.unwrap_or(120),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let command = options.command.unwrap_or_else(|| "/bin/zsh".to_string());
    let args = options.args.unwrap_or_else(|| vec!["-l".to_string()]);
    let mut cmd = CommandBuilder::new(command);
    cmd.args(args);
    resolved_cwd.configure_command_cwd(&mut cmd)?;
    // Build a sane child environment. When the .app is launched from
    // Finder/Dock, launchd hands us a stripped PATH that lacks
    // /opt/homebrew/bin, so psyche can't find tmux/git/gh/etc. Augment PATH
    // with the conventional locations, and provide reasonable defaults for
    // TERM / COLORTERM / LANG so xterm.js renders unicode + truecolor.
    cmd.env("PATH", augmented_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("PSYCHE_TAURI", "1");
    cmd.env("PSYCHE_NATIVE_CONTAINER", "1");
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    if std::env::var("LC_ALL").is_err() {
        cmd.env("LC_ALL", "en_US.UTF-8");
    }
    apply_launch_env(
        &mut cmd,
        options.env.as_ref(),
        options.launch_kind.as_deref(),
    );
    // Always make sure TMUX is unset unless something downstream explicitly
    // wants it. Inheriting it from the Tauri parent process makes nested-tmux
    // checks misfire.
    cmd.env_remove("TMUX");
    cmd.env_remove("npm_config_prefix");
    cmd.env_remove("NPM_CONFIG_PREFIX");
    cmd.env_remove("PREFIX");

    let spawn_time_unix_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let pid = child.process_id();
    drop(resolved_cwd);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    {
        let mut guard = SESSIONS.lock();
        guard.insert(
            thread_id.clone(),
            PtySession {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                pid,
                spawn_time_unix_secs,
            },
        );
    }
    drop(pending_start);

    let data_thread_id = thread_id.clone();
    let app_for_data = app.clone();
    let data_thread = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let payload = PtyDataEvent {
                        thread_id: data_thread_id.clone(),
                        bytes: buf[..n].to_vec(),
                    };
                    let _ = app_for_data.emit("pty:data", payload);
                }
                Err(_) => break,
            }
        }
    });

    let exit_thread_id = thread_id.clone();
    let app_for_exit = app.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        {
            let mut guard = SESSIONS.lock();
            guard.remove(&exit_thread_id);
        }
        let code = status.ok().map(|s| s.exit_code() as i32);
        let _ = data_thread.join();
        let _ = app_for_exit.emit(
            "pty:exit",
            PtyExitEvent {
                thread_id: exit_thread_id,
                code,
            },
        );
    });

    Ok(())
}

#[tauri::command]
fn pty_write(thread_id: String, bytes: Vec<u8>) -> Result<(), String> {
    let writer = {
        let guard = SESSIONS.lock();
        let session = guard
            .get(&thread_id)
            .ok_or_else(|| format!("thread '{}' not found", thread_id))?;
        Arc::clone(&session.writer)
    };
    let mut writer = writer.lock();
    writer.write_all(&bytes).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn pty_resize(thread_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let guard = SESSIONS.lock();
    if let Some(session) = guard.get(&thread_id) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_stop(thread_id: String) {
    let mut guard = SESSIONS.lock();
    guard.remove(&thread_id);
}

#[tauri::command]
fn pty_list() -> Vec<String> {
    let guard = SESSIONS.lock();
    guard.keys().cloned().collect()
}

#[tauri::command]
async fn workspace_metrics(
    state: State<'_, MetricsState>,
    scope: Option<MetricsScope>,
) -> Result<MetricsSnapshot, String> {
    let tracked_sessions = {
        let guard = SESSIONS.lock();
        guard
            .iter()
            .filter_map(|(thread_id, session)| {
                session.pid.map(|pid| {
                    TrackedPty::new(thread_id.clone(), pid, session.spawn_time_unix_secs)
                })
            })
            .collect::<Vec<_>>()
    };
    let collector = state.collector.clone();
    let scope = scope.unwrap_or(MetricsScope { thread_id: None });

    tauri::async_runtime::spawn_blocking(move || {
        collector
            .lock()
            .snapshot(std::process::id(), &tracked_sessions, scope)
    })
    .await
    .map_err(|error| format!("metrics collector task failed: {error}"))
}

// ----------------------------------------------------------------------------
// Embedded browser pane (Tauri child Webview)
// ----------------------------------------------------------------------------

fn ensure_browser(
    app: &AppHandle,
    label: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    url: &str,
) -> Result<bool, String> {
    if app.webviews().keys().any(|existing| existing == label) {
        return Ok(false);
    }

    let main = app
        .get_window("main")
        .ok_or_else(|| "main window missing".to_string())?;

    let parsed_url = Url::parse(url).map_err(|e| e.to_string())?;
    let browser_label = label.to_string();
    let app_for_load = app.clone();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed_url)).on_page_load(
        move |webview, payload| {
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            let _ = app_for_load.emit(
                "browser:page-load",
                BrowserPageLoadEvent {
                    label: browser_label.clone(),
                    url: payload.url().to_string(),
                    phase: phase.to_string(),
                },
            );
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let label_json = serde_json::to_string(&browser_label).unwrap_or_else(|_| "null".to_string());
                let script = format!(
                    r#"(function(browserLabel) {{
                      try {{
                        var emit = function(name, payload) {{
                          if (window.__TAURI__ && window.__TAURI__.event) {{
                            window.__TAURI__.event.emit(name, payload);
                          }}
                        }};
                        var title = document.title || location.hostname || location.href;
                        emit("browser:title", {{ label: browserLabel, title: title, url: location.href }});
                        if (!window.__PSYCHE_BROWSER_SHORTCUTS_INSTALLED__) {{
                          window.__PSYCHE_BROWSER_SHORTCUTS_INSTALLED__ = true;
                          window.addEventListener("keydown", function(event) {{
                            try {{
                              if ((event.metaKey || event.ctrlKey) && event.key && event.key.toLowerCase() === "t") {{
                                event.preventDefault();
                                event.stopPropagation();
                                emit("browser:shortcut-terminal-pane", {{ label: browserLabel, url: location.href }});
                              }}
                            }} catch (_) {{}}
                          }}, true);
                          window.addEventListener("pointerdown", function() {{
                            emit("browser:focus", {{ label: browserLabel, url: location.href }});
                          }}, true);
                          window.addEventListener("focusin", function() {{
                            emit("browser:focus", {{ label: browserLabel, url: location.href }});
                          }}, true);
                        }}
                      }} catch (_) {{}}
                    }})({});"#,
                    label_json
                );
                let _ = webview.eval(&script);
            }
        },
    );

    main.add_child(
        builder,
        LogicalPosition::new(x, y),
        LogicalSize::new(w.max(1.0), h.max(1.0)),
    )
    .map_err(|e| e.to_string())?;

    Ok(true)
}

fn hide_webview(webview: &tauri::Webview) -> Result<(), String> {
    webview
        .set_position(LogicalPosition::new(-10000.0, -10000.0))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(1.0, 1.0))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn browser_navigate(
    app: AppHandle,
    label: Option<String>,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let label = safe_browser_label(label);
    let created = ensure_browser(&app, &label, x, y, w, h, &url)?;
    if !created {
        let webview = app
            .get_webview(&label)
            .ok_or_else(|| "browser webview missing".to_string())?;
        webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(LogicalSize::new(w.max(1.0), h.max(1.0)))
            .map_err(|e| e.to_string())?;
        let parsed_url = Url::parse(&url).map_err(|e| e.to_string())?;
        webview.navigate(parsed_url).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn browser_set_bounds(
    app: AppHandle,
    label: Option<String>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let label = safe_browser_label(label);
    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(LogicalSize::new(w.max(1.0), h.max(1.0)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn browser_hide(app: AppHandle, label: Option<String>) -> Result<(), String> {
    let label = safe_browser_label(label);
    if let Some(webview) = app.get_webview(&label) {
        hide_webview(&webview)?;
    }
    Ok(())
}

#[tauri::command]
fn browser_hide_all_except(app: AppHandle, label: Option<String>) -> Result<(), String> {
    let keep = label.map(|raw| safe_browser_label(Some(raw)));
    for (existing_label, webview) in app.webviews() {
        if existing_label.starts_with(BROWSER_LABEL_PREFIX) && Some(existing_label.clone()) != keep
        {
            hide_webview(&webview)?;
        }
    }
    Ok(())
}

fn destroy_browser_webview(app: &AppHandle, label: Option<String>) -> Result<(), String> {
    let label = safe_browser_label(label);
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn browser_destroy(app: AppHandle, label: Option<String>) -> Result<(), String> {
    destroy_browser_webview(&app, label)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserDestroyFailure {
    label: String,
    error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserDestroyManyOutcome {
    destroyed: Vec<String>,
    failures: Vec<BrowserDestroyFailure>,
}

#[tauri::command]
fn browser_destroy_many(app: AppHandle, labels: Vec<String>) -> BrowserDestroyManyOutcome {
    let mut outcome = BrowserDestroyManyOutcome {
        destroyed: Vec::new(),
        failures: Vec::new(),
    };
    for label in labels {
        match destroy_browser_webview(&app, Some(label.clone())) {
            Ok(()) => outcome.destroyed.push(label),
            Err(error) => outcome
                .failures
                .push(BrowserDestroyFailure { label, error }),
        }
    }
    outcome
}

#[tauri::command]
fn browser_reload(app: AppHandle, label: Option<String>) -> Result<(), String> {
    let label = safe_browser_label(label);
    if let Some(webview) = app.get_webview(&label) {
        webview.reload().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn browser_eval(app: AppHandle, label: Option<String>, script: String) -> Result<(), String> {
    let label = safe_browser_label(label);
    if let Some(webview) = app.get_webview(&label) {
        webview.eval(&script).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ----------------------------------------------------------------------------
// Environment introspection so the JS layer can locate `node` + the bundled
// psyche entrypoint when the app is invoked from a worktree (dev mode).
// ----------------------------------------------------------------------------

#[derive(Serialize, Default)]
pub struct AppEnvironment {
    pub home: Option<String>,
    pub repo_root: Option<String>,
    pub psyche_entry: Option<String>,
    pub node_path: Option<String>,
    pub coven_path: Option<String>,
    pub default_shell: String,
    pub native_workspace_v2: bool,
}

fn feature_flag_value(value: Option<&str>, default: bool) -> bool {
    match value {
        Some(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "disabled"
        ),
        None => default,
    }
}

fn feature_flag_enabled(name: &str, default: bool) -> bool {
    feature_flag_value(std::env::var(name).ok().as_deref(), default)
}

#[tauri::command]
fn app_environment() -> AppEnvironment {
    let home = std::env::var("HOME").ok();
    let default_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let native_workspace_v2 = feature_flag_enabled("PSYCHE_NATIVE_WORKSPACE_V2", true);

    // Try to find a `node` on PATH. portable-pty inherits the parent env, so
    // launching `node` from there should work even if PATH munging in spawn
    // misses common Homebrew paths.
    let node_path = which_on_path("node");
    let coven_path = which_on_path("coven");

    // Heuristic: if the binary is being run from a built .app inside a
    // worktree, the worktree root is a couple of levels up from the .app.
    let repo_root = locate_psyche_repo();
    let psyche_entry = repo_root.as_ref().and_then(|root| {
        let candidate = format!("{}/dist/index.js", root);
        if std::path::Path::new(&candidate).exists() {
            Some(candidate)
        } else {
            None
        }
    });

    AppEnvironment {
        home,
        repo_root,
        psyche_entry,
        node_path,
        coven_path,
        default_shell,
        native_workspace_v2,
    }
}

// ----------------------------------------------------------------------------
// Agent harness skills/plugins discovery.
//
// Surfaces the slash commands that an agent harness running in a thread will
// recognise, so the Tauri command bar can autocomplete + invoke them. v1
// covers Claude Code: user/project skills, user/project commands, and
// plugin-supplied skills/commands. Other harnesses can be added by extending
// the match in `agent_skills`.
// ----------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct AgentSkillEntry {
    pub harness: String,
    /// Slash command name including leading slash, e.g. "/security-review"
    /// or "/myplugin:foo".
    pub name: String,
    pub description: String,
    /// "user" | "project" | "plugin"
    pub source: String,
    /// "user" / "project" for non-plugin entries; plugin name for plugins.
    pub origin: String,
    /// "skill" | "command"
    pub kind: String,
    pub path: String,
}

fn agent_skill_source_rank(source: &str) -> u8 {
    match source {
        "project" => 0,
        "user" => 1,
        "plugin" => 2,
        _ => 3,
    }
}

#[tauri::command]
fn agent_skills(harness: Option<String>, project_root: Option<String>) -> Vec<AgentSkillEntry> {
    let harness = harness.unwrap_or_else(|| "claude".to_string());
    let mut out: Vec<AgentSkillEntry> = vec![];
    if harness != "claude" {
        return out;
    }

    if let Ok(home) = std::env::var("HOME") {
        let user_root = Path::new(&home).join(".claude");
        if user_root.is_dir() {
            scan_claude_dir(&user_root, "user", "user", None, &mut out);
        }
        let plugins_root = user_root.join("plugins");
        if plugins_root.is_dir() {
            scan_claude_plugins(&plugins_root, &mut out);
        }
    }
    if let Some(pr) = project_root.as_deref() {
        let proj_claude = Path::new(pr).join(".claude");
        if proj_claude.is_dir() {
            scan_claude_dir(&proj_claude, "project", "project", None, &mut out);
        }
    }

    out.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then(a.kind.cmp(&b.kind))
            .then(agent_skill_source_rank(&a.source).cmp(&agent_skill_source_rank(&b.source)))
            .then(a.source.cmp(&b.source))
    });
    out.dedup_by(|a, b| a.name == b.name && a.kind == b.kind);
    out
}

/// Scan a `.claude` (or plugin root) directory for `commands/*.md` and
/// `skills/<name>/SKILL.md`. `prefix` is prepended to the slash name for
/// plugin-supplied entries (`Some("myplugin")` → `/myplugin:foo`).
fn scan_claude_dir(
    root: &Path,
    source: &str,
    origin: &str,
    prefix: Option<&str>,
    out: &mut Vec<AgentSkillEntry>,
) {
    let commands_dir = root.join("commands");
    if commands_dir.is_dir() {
        if let Ok(rd) = std::fs::read_dir(&commands_dir) {
            for entry in rd.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                if path.extension().and_then(|s| s.to_str()) != Some("md") {
                    continue;
                }
                let stem = match path.file_stem().and_then(|s| s.to_str()) {
                    Some(s) if !s.is_empty() => s.to_string(),
                    _ => continue,
                };
                let name = match prefix {
                    Some(p) => format!("/{}:{}", p, stem),
                    None => format!("/{}", stem),
                };
                out.push(AgentSkillEntry {
                    harness: "claude".into(),
                    name,
                    description: read_md_description(&path).unwrap_or_default(),
                    source: source.into(),
                    origin: origin.into(),
                    kind: "command".into(),
                    path: path.to_string_lossy().to_string(),
                });
            }
        }
    }

    let skills_dir = root.join("skills");
    if skills_dir.is_dir() {
        if let Ok(rd) = std::fs::read_dir(&skills_dir) {
            for entry in rd.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let skill_md = dir.join("SKILL.md");
                if !skill_md.is_file() {
                    continue;
                }
                let skill_name = match dir.file_name().and_then(|s| s.to_str()) {
                    Some(s) if !s.is_empty() => s.to_string(),
                    _ => continue,
                };
                let name = match prefix {
                    Some(p) => format!("/{}:{}", p, skill_name),
                    None => format!("/{}", skill_name),
                };
                out.push(AgentSkillEntry {
                    harness: "claude".into(),
                    name,
                    description: read_md_description(&skill_md).unwrap_or_default(),
                    source: source.into(),
                    origin: origin.into(),
                    kind: "skill".into(),
                    path: skill_md.to_string_lossy().to_string(),
                });
            }
        }
    }
}

/// Find every plugin under `~/.claude/plugins` that ships its own
/// `commands/` or `skills/` subtree, regardless of where Claude's plugin
/// installer actually placed it (layouts vary across versions:
/// `plugins/<name>/`, `plugins/repos/<marketplace>/<name>/`, etc.). We bound
/// the walk so we never recurse into node_modules or git history.
fn scan_claude_plugins(root: &Path, out: &mut Vec<AgentSkillEntry>) {
    fn plugin_name_from_manifest(dir: &Path) -> Option<String> {
        for rel in [
            ".plugin/plugin.json",
            ".claude-plugin/plugin.json",
            "package.json",
        ] {
            let path = dir.join(rel);
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
                continue;
            };
            let Some(name) = json.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            if !name.trim().is_empty() {
                return Some(name.trim().to_string());
            }
        }
        None
    }

    fn walk(dir: &Path, depth: u32, plugin_hint: Option<&str>, out: &mut Vec<AgentSkillEntry>) {
        if depth > 4 {
            return;
        }
        let has_commands = dir.join("commands").is_dir();
        let has_skills = dir.join("skills").is_dir();
        let plugin_name = plugin_hint
            .map(|s| s.to_string())
            .or_else(|| plugin_name_from_manifest(dir))
            .or_else(|| {
                dir.file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| "plugin".to_string());
        if has_commands || has_skills {
            scan_claude_dir(dir, "plugin", &plugin_name, Some(&plugin_name), out);
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in rd.flatten() {
            let path: PathBuf = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default();
            if name.is_empty() || name.starts_with('.') || name == "node_modules" {
                continue;
            }
            walk(&path, depth + 1, None, out);
        }
    }
    walk(root, 0, None, out);
}

/// Pull a one-line description out of a markdown file. Prefers the
/// `description:` key in YAML frontmatter, then the first non-empty,
/// non-heading line.
fn read_md_description(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let mut iter = content.lines();
    let first = iter.next()?;
    if first.trim() == "---" {
        let mut in_fm = true;
        for line in iter.by_ref() {
            if line.trim() == "---" {
                in_fm = false;
                break;
            }
            if let Some(rest) = line.strip_prefix("description:") {
                let value = rest.trim().trim_matches('"').trim_matches('\'').to_string();
                if !value.is_empty() {
                    return Some(truncate_oneline(&value));
                }
            }
        }
        if in_fm {
            return None;
        }
        for line in iter {
            let t = line.trim();
            if !t.is_empty() && !t.starts_with('#') {
                return Some(truncate_oneline(t));
            }
        }
        None
    } else {
        let t = first.trim();
        if !t.is_empty() && !t.starts_with('#') {
            return Some(truncate_oneline(t));
        }
        for line in iter {
            let t = line.trim();
            if !t.is_empty() && !t.starts_with('#') {
                return Some(truncate_oneline(t));
            }
        }
        None
    }
}

fn truncate_oneline(s: &str) -> String {
    let s = s.replace('\r', "");
    let one = s.lines().next().unwrap_or("").trim().to_string();
    if one.chars().count() > 160 {
        one.chars().take(157).collect::<String>() + "…"
    } else {
        one
    }
}

fn augmented_path() -> &'static str {
    AUGMENTED_PATH.as_str()
}

fn compute_augmented_path() -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    let extras = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ];
    let mut parts: Vec<PathBuf> = Vec::new();
    for p in std::env::split_paths(&existing) {
        if !p.as_os_str().is_empty() && !parts.iter().any(|existing| existing == &p) {
            parts.push(p);
        }
    }
    for extra in extras {
        let extra = PathBuf::from(extra);
        if !parts.iter().any(|existing| existing == &extra) {
            parts.push(extra);
        }
    }
    // Plus common user-installed runtime managers on macOS.
    if let Ok(home) = std::env::var("HOME") {
        let home_path = Path::new(&home);
        for suffix in [
            ".cargo/bin",
            ".local/bin",
            ".volta/bin",
            ".bun/bin",
            ".rbenv/shims",
            ".pyenv/shims",
        ] {
            push_path_if_dir(&mut parts, home_path.join(suffix));
        }
        if let Some(nvm_bin) = newest_nvm_node_bin(home_path) {
            push_path_if_dir(&mut parts, nvm_bin);
        }
    }
    std::env::join_paths(&parts)
        .map(|joined| joined.to_string_lossy().to_string())
        .unwrap_or_else(|_| existing.clone())
}

fn push_path_if_dir(parts: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !candidate.is_dir() {
        return;
    }
    if !parts.iter().any(|p| p == &candidate) {
        parts.push(candidate);
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

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        unsafe { libc::faccessat(libc::AT_FDCWD, path.as_ptr(), libc::X_OK, libc::AT_EACCESS) == 0 }
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn executable_in_dir(binary: &str, dir: &Path) -> Option<String> {
    let canonical = dir.join(binary).canonicalize().ok()?;
    if is_executable_file(&canonical) {
        return Some(canonical.to_string_lossy().to_string());
    }
    None
}

#[cfg_attr(not(test), allow(dead_code))]
fn which_on_path_with(binary: &str, path: &std::ffi::OsStr) -> Option<String> {
    std::env::split_paths(path).find_map(|dir| executable_in_dir(binary, &dir))
}

fn which_on_path(binary: &str) -> Option<String> {
    for dir in std::env::split_paths(augmented_path()) {
        if let Some(executable) = executable_in_dir(binary, &dir) {
            return Some(executable);
        }
    }
    None
}

fn locate_psyche_repo() -> Option<String> {
    // Walk up from the current executable looking for a directory that
    // contains both `dist/index.js` and `package.json`.
    let exe = std::env::current_exe().ok()?;
    let mut current = exe.parent()?.to_path_buf();
    for _ in 0..12 {
        let dist = current.join("dist").join("index.js");
        let pkg = current.join("package.json");
        if dist.is_file() && pkg.is_file() {
            return Some(current.to_string_lossy().to_string());
        }
        if !current.pop() {
            break;
        }
    }
    // Fall back to CWD walk.
    let cwd = std::env::current_dir().ok()?;
    let mut current = cwd;
    for _ in 0..12 {
        let dist = current.join("dist").join("index.js");
        let pkg = current.join("package.json");
        if dist.is_file() && pkg.is_file() {
            return Some(current.to_string_lossy().to_string());
        }
        if !current.pop() {
            break;
        }
    }
    None
}

// ----------------------------------------------------------------------------
// Workspace side panels: file tree, diffs, and git/GitHub state.
//
// These back the right-rail panels. File saves are the only working-tree
// mutation and use containment plus optimistic conflict checks.
// ----------------------------------------------------------------------------

/// Cap on file preview size. Big files are truncated rather than refused so the
/// panel still shows a useful head.
const MAX_PREVIEW_BYTES: u64 = 512 * 1024;
static SAVE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static WORKSPACE_SAVE_MUTEX: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

fn canonical_project_root(root: &str) -> Result<PathBuf, String> {
    let canonical = Path::new(root)
        .canonicalize()
        .map_err(|e| format!("project root '{}': {}", root, e))?;
    if !canonical.is_dir() {
        return Err(format!("project root is not a directory: {}", root));
    }
    Ok(canonical)
}

fn resolve_project_path(root: &str, requested: &str) -> Result<PathBuf, String> {
    let canonical_root = canonical_project_root(root)?;
    let requested_path = Path::new(requested);
    let candidate = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        canonical_root.join(requested_path)
    };
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|e| format!("path '{}': {}", requested, e))?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(format!("path is outside project root: {}", requested));
    }
    Ok(canonical_candidate)
}

fn validate_git_relative_path(path: &str) -> Result<(), String> {
    let candidate = Path::new(path);
    if path.is_empty()
        || candidate.is_absolute()
        || candidate.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("git path must stay inside project root: {}", path));
    }
    Ok(())
}

#[derive(Debug, Serialize, Clone)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command]
fn fs_list_dir(root: String, path: String) -> Result<Vec<DirEntryInfo>, String> {
    let dir = resolve_project_path(&root, &path)?;
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", path));
    }
    let mut out: Vec<DirEntryInfo> = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        // .git is noise in a file tree and enormous; the git panel covers it.
        if name == ".git" {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        out.push(DirEntryInfo {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
        });
    }
    // Directories first, then case-insensitive by name.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[derive(Debug, Serialize, Clone)]
pub struct FileText {
    pub path: String,
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
    pub size: u64,
}

#[tauri::command]
fn fs_read_text(root: String, path: String) -> Result<FileText, String> {
    let p = resolve_project_path(&root, &path)?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err(format!("is a directory: {}", path));
    }
    let size = meta.len();
    let mut file = std::fs::File::open(&p).map_err(|e| e.to_string())?;
    let take = size.min(MAX_PREVIEW_BYTES);
    let mut buf = vec![0u8; take as usize];
    let read = file.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(read);

    // A NUL byte in the bounded preview is the usual "this is binary"
    // heuristic. Invalid UTF-8 is also non-editable so a save can never perform
    // a lossy rewrite.
    let binary = buf.contains(&0) || std::str::from_utf8(&buf).is_err();
    let text = if binary {
        String::new()
    } else {
        String::from_utf8_lossy(&buf).to_string()
    };
    Ok(FileText {
        path: p.to_string_lossy().to_string(),
        text,
        truncated: size > take,
        binary,
        size,
    })
}

#[derive(Debug, Serialize, Clone)]
pub struct SavedFileText {
    pub path: String,
    pub text: String,
    pub size: u64,
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileState {
    dev: u64,
    ino: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    size: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
}

#[cfg(unix)]
fn file_state(file: &std::fs::File) -> Result<FileState, String> {
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    Ok(FileState {
        dev: metadata.dev(),
        ino: metadata.ino(),
        mode: metadata.mode(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        size: metadata.size(),
        mtime: metadata.mtime(),
        mtime_nsec: metadata.mtime_nsec(),
        ctime: metadata.ctime(),
        ctime_nsec: metadata.ctime_nsec(),
    })
}

#[cfg(unix)]
fn same_identity(left: FileState, right: FileState) -> bool {
    left.dev == right.dev && left.ino == right.ino
}

#[cfg(unix)]
fn c_path(path: &Path) -> Result<CString, String> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| format!("path contains a NUL byte: {}", path.display()))
}

#[cfg(unix)]
fn c_name(name: &std::ffi::OsStr) -> Result<CString, String> {
    CString::new(name.as_bytes()).map_err(|_| "file name contains a NUL byte".to_string())
}

#[cfg(unix)]
fn open_directory_no_follow(path: &Path, label: &str) -> Result<std::fs::File, String> {
    let path_c = c_path(path)?;
    let fd = unsafe {
        libc::open(
            path_c.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(format!(
            "open {} '{}': {}",
            label,
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn open_target_no_follow(
    parent: &std::fs::File,
    name: &CString,
) -> Result<std::fs::File, std::io::Error> {
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn read_stable_file(file: &mut std::fs::File, path: &str) -> Result<(Vec<u8>, FileState), String> {
    let before = file_state(file)?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("read '{}': {}", path, e))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("read '{}': {}", path, e))?;
    let after = file_state(file)?;
    if before != after {
        return Err(format!("file changed on disk: {}", path));
    }
    Ok((bytes, after))
}

#[cfg(unix)]
fn validate_parent_identity(
    root_input: &str,
    canonical_root: &Path,
    root_state: FileState,
    parent_path: &Path,
    parent_state: FileState,
) -> Result<(), String> {
    let current_root = canonical_project_root(root_input)?;
    if current_root != canonical_root {
        return Err("project root changed while saving".to_string());
    }
    let current_root_file = open_directory_no_follow(&current_root, "project root")?;
    if !same_identity(file_state(&current_root_file)?, root_state) {
        return Err("project root changed while saving".to_string());
    }

    let current_parent = parent_path.canonicalize().map_err(|e| {
        format!(
            "parent changed while saving '{}': {}",
            parent_path.display(),
            e
        )
    })?;
    if !current_parent.starts_with(&current_root) {
        return Err(format!(
            "path is outside project root: {}",
            parent_path.display()
        ));
    }
    if current_parent != parent_path {
        return Err(format!(
            "parent changed while saving: {}",
            parent_path.display()
        ));
    }
    let current_parent_file = open_directory_no_follow(parent_path, "file parent")?;
    if !same_identity(file_state(&current_parent_file)?, parent_state) {
        return Err(format!(
            "parent changed while saving: {}",
            parent_path.display()
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn unlink_temp_at(parent: &std::fs::File, temp_name: &CString) -> Result<(), String> {
    let result = unsafe { libc::unlinkat(parent.as_raw_fd(), temp_name.as_ptr(), 0) };
    if result < 0 {
        return Err(format!(
            "remove temporary save file: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn fs_write_text_with_before_commit<F>(
    root: String,
    path: String,
    text: String,
    expected_text: String,
    before_commit: F,
) -> Result<SavedFileText, String>
where
    F: FnOnce(),
{
    let _save_guard = WORKSPACE_SAVE_MUTEX.lock();
    let canonical_root = canonical_project_root(&root)?;
    let target_path = resolve_project_path(&root, &path)?;
    let parent_path = target_path
        .parent()
        .ok_or_else(|| format!("file has no parent directory: {}", target_path.display()))?;
    let target_name = c_name(
        target_path
            .file_name()
            .ok_or_else(|| format!("file has no name: {}", target_path.display()))?,
    )?;

    let root_file = open_directory_no_follow(&canonical_root, "project root")?;
    let root_state = file_state(&root_file)?;
    let parent_file = open_directory_no_follow(parent_path, "file parent")?;
    let parent_state = file_state(&parent_file)?;
    validate_parent_identity(
        &root,
        &canonical_root,
        root_state,
        parent_path,
        parent_state,
    )?;
    let mut initial_target = open_target_no_follow(&parent_file, &target_name)
        .map_err(|e| format!("open target '{}': {}", path, e))?;
    let initial_state_before = file_state(&initial_target)?;
    if !initial_target
        .metadata()
        .map_err(|e| e.to_string())?
        .is_file()
    {
        return Err(format!("not a regular file: {}", path));
    }
    let (initial_bytes, initial_state) = read_stable_file(&mut initial_target, &path)?;
    if initial_state != initial_state_before {
        return Err(format!("file changed on disk: {}", path));
    }
    let current_text = std::str::from_utf8(&initial_bytes)
        .map_err(|_| format!("file is not valid UTF-8: {}", path))?;
    if current_text != expected_text {
        return Err(format!("file changed on disk: {}", path));
    }

    let (temp_name, mut temp_file) = loop {
        let counter = SAVE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut bytes = target_name.as_bytes().to_vec();
        bytes.extend_from_slice(
            format!(".psyche-save-{}-{}", std::process::id(), counter).as_bytes(),
        );
        let temp_name = CString::new(bytes).expect("validated target name cannot contain NUL");
        let fd = unsafe {
            libc::openat(
                parent_file.as_raw_fd(),
                temp_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                (initial_state.mode & 0o7777) as libc::c_uint,
            )
        };
        if fd >= 0 {
            break (temp_name, unsafe { std::fs::File::from_raw_fd(fd) });
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(format!(
                "create temporary save file for '{}': {}",
                path, error
            ));
        }
    };

    let save_result = (|| -> Result<(), String> {
        temp_file
            .write_all(text.as_bytes())
            .map_err(|e| format!("write temporary save for '{}': {}", path, e))?;
        temp_file
            .flush()
            .map_err(|e| format!("flush temporary save for '{}': {}", path, e))?;
        let chmod_result = unsafe {
            libc::fchmod(
                temp_file.as_raw_fd(),
                (initial_state.mode & 0o7777) as libc::mode_t,
            )
        };
        if chmod_result < 0 {
            return Err(format!(
                "copy permissions for '{}': {}",
                path,
                std::io::Error::last_os_error()
            ));
        }
        temp_file
            .sync_all()
            .map_err(|e| format!("sync temporary save for '{}': {}", path, e))?;

        before_commit();

        validate_parent_identity(
            &root,
            &canonical_root,
            root_state,
            parent_path,
            parent_state,
        )?;
        let mut final_target = open_target_no_follow(&parent_file, &target_name)
            .map_err(|e| format!("file changed on disk: {} ({})", path, e))?;
        if !final_target
            .metadata()
            .map_err(|e| e.to_string())?
            .is_file()
        {
            return Err(format!("file changed on disk: {}", path));
        }
        let final_state_before = file_state(&final_target)?;
        if final_state_before != initial_state {
            return Err(format!("file changed on disk: {}", path));
        }
        let (final_bytes, final_state_after) = read_stable_file(&mut final_target, &path)?;
        if final_state_after != final_state_before || final_bytes != expected_text.as_bytes() {
            return Err(format!("file changed on disk: {}", path));
        }
        drop(final_target);
        drop(temp_file);

        // POSIX rename has an unavoidable final-syscall window against an
        // arbitrary non-cooperating writer. This is optimistic protection for
        // trusted local editor and coding-agent saves; descriptor-relative
        // rename keeps that window contained to the validated parent.
        let rename_result = unsafe {
            libc::renameat(
                parent_file.as_raw_fd(),
                temp_name.as_ptr(),
                parent_file.as_raw_fd(),
                target_name.as_ptr(),
            )
        };
        if rename_result < 0 {
            return Err(format!(
                "replace '{}': {}",
                path,
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    })();

    if let Err(save_error) = save_result {
        let cleanup_result = unlink_temp_at(&parent_file, &temp_name);
        drop(initial_target);
        return match cleanup_result {
            Ok(()) => Err(save_error),
            Err(cleanup_error) => Err(format!("{}; {}", save_error, cleanup_error)),
        };
    }

    drop(initial_target);
    Ok(SavedFileText {
        path: target_path.to_string_lossy().to_string(),
        size: text.len() as u64,
        text,
    })
}

#[tauri::command]
fn fs_write_text(
    root: String,
    path: String,
    text: String,
    expected_text: String,
) -> Result<SavedFileText, String> {
    #[cfg(unix)]
    {
        return fs_write_text_with_before_commit(root, path, text, expected_text, || {});
    }
    #[cfg(not(unix))]
    {
        let _ = (root, path, text, expected_text);
        Err("workspace file saves require POSIX descriptor-relative operations".to_string())
    }
}

fn run_git(root: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|e| format!("git: {}", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git {:?} failed", args)
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct GitWorktree {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
    pub is_main: bool,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    pub lock_reason: Option<String>,
    pub prunable: bool,
    pub prune_reason: Option<String>,
    pub dirty: bool,
    pub missing: bool,
}

fn parse_git_worktrees(raw: &str) -> Vec<GitWorktree> {
    raw.split("\n\n")
        .filter_map(|block| {
            let mut worktree = GitWorktree {
                path: String::new(),
                head: String::new(),
                branch: None,
                is_main: false,
                detached: false,
                bare: false,
                locked: false,
                lock_reason: None,
                prunable: false,
                prune_reason: None,
                dirty: false,
                missing: false,
            };
            for line in block.lines() {
                let (key, value) = line.split_once(' ').unwrap_or((line, ""));
                match key {
                    "worktree" => worktree.path = value.to_string(),
                    "HEAD" => worktree.head = value.to_string(),
                    "branch" => {
                        worktree.branch = Some(
                            value
                                .strip_prefix("refs/heads/")
                                .unwrap_or(value)
                                .to_string(),
                        )
                    }
                    "detached" => worktree.detached = true,
                    "bare" => worktree.bare = true,
                    "locked" => {
                        worktree.locked = true;
                        if !value.is_empty() {
                            worktree.lock_reason = Some(value.to_string());
                        }
                    }
                    "prunable" => {
                        worktree.prunable = true;
                        worktree.missing = true;
                        if !value.is_empty() {
                            worktree.prune_reason = Some(value.to_string());
                        }
                    }
                    _ => {}
                }
            }
            (!worktree.path.is_empty()).then_some(worktree)
        })
        .enumerate()
        .map(|(index, mut worktree)| {
            worktree.is_main = index == 0;
            worktree
        })
        .collect()
}

#[tauri::command]
fn git_worktrees(root: String) -> Result<Vec<GitWorktree>, String> {
    let root = canonical_project_root(&root)?.to_string_lossy().to_string();
    let raw = run_git(&root, &["worktree", "list", "--porcelain"])?;
    let mut worktrees = parse_git_worktrees(&raw);
    for worktree in &mut worktrees {
        if worktree.prunable || worktree.bare {
            continue;
        }
        match run_git(
            &worktree.path,
            &["status", "--porcelain=v1", "--untracked-files=normal"],
        ) {
            Ok(status) => worktree.dirty = !status.trim().is_empty(),
            Err(_) => worktree.missing = true,
        }
    }
    Ok(worktrees)
}

/// git@github.com:owner/repo.git and https://github.com/owner/repo.git both
/// normalise to a browsable https URL.
fn remote_to_web_url(remote: &str) -> Option<String> {
    let r = remote.trim().trim_end_matches(".git");
    if let Some(rest) = r.strip_prefix("git@") {
        let mut parts = rest.splitn(2, ':');
        let host = parts.next()?;
        let path = parts.next()?;
        return Some(format!("https://{}/{}", host, path));
    }
    if r.starts_with("https://") || r.starts_with("http://") {
        return Some(r.to_string());
    }
    if let Some(rest) = r.strip_prefix("ssh://git@") {
        return Some(format!("https://{}", rest));
    }
    None
}

#[derive(Debug, Serialize, Clone)]
pub struct GitFileEntry {
    pub path: String,
    /// Two-character porcelain code, e.g. " M", "A ", "??".
    pub code: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileEntry>,
    pub remote_url: Option<String>,
    pub web_url: Option<String>,
}

#[tauri::command]
fn git_status(root: String) -> Result<GitStatus, String> {
    let root = canonical_project_root(&root)?.to_string_lossy().to_string();
    let inside = run_git(&root, &["rev-parse", "--is-inside-work-tree"]).unwrap_or_default();
    if inside.trim() != "true" {
        return Ok(GitStatus {
            is_repo: false,
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
            remote_url: None,
            web_url: None,
        });
    }

    let prefix = run_git(&root, &["rev-parse", "--show-prefix"])?
        .trim()
        .to_string();
    let raw = run_git(
        &root,
        &[
            "status",
            "--porcelain",
            "-b",
            "--untracked-files=all",
            "--",
            ".",
        ],
    )?;
    let mut branch = None;
    let mut upstream = None;
    let (mut ahead, mut behind) = (0u32, 0u32);
    let mut files = Vec::new();

    for line in raw.lines() {
        if let Some(head) = line.strip_prefix("## ") {
            // "main...origin/main [ahead 1, behind 2]" | "No commits yet on main"
            let (refs, track) = match head.find(" [") {
                Some(i) => (&head[..i], &head[i..]),
                None => (head, ""),
            };
            let mut it = refs.splitn(2, "...");
            branch = it
                .next()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            upstream = it.next().map(|s| s.trim().to_string());
            for (key, slot) in [("ahead ", &mut ahead), ("behind ", &mut behind)] {
                if let Some(i) = track.find(key) {
                    let tail = &track[i + key.len()..];
                    let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
                    *slot = digits.parse().unwrap_or(0);
                }
            }
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let code = line[..2].to_string();
        // Renames read "R  old -> new"; the new path is what the user cares about.
        let rest = &line[3..];
        let repo_path = match rest.split(" -> ").last() {
            Some(p) => p.to_string(),
            None => rest.to_string(),
        };
        let path = if prefix.is_empty() {
            repo_path
        } else {
            let Some(relative) = repo_path.strip_prefix(&prefix) else {
                continue;
            };
            relative.to_string()
        };
        let index = code.chars().next().unwrap_or(' ');
        let worktree = code.chars().nth(1).unwrap_or(' ');
        files.push(GitFileEntry {
            path,
            untracked: code == "??",
            staged: index != ' ' && index != '?',
            unstaged: worktree != ' ' && worktree != '?',
            code,
        });
    }

    let remote_url = run_git(&root, &["remote", "get-url", "origin"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let web_url = remote_url.as_deref().and_then(remote_to_web_url);

    Ok(GitStatus {
        is_repo: true,
        branch,
        upstream,
        ahead,
        behind,
        files,
        remote_url,
        web_url,
    })
}

const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Serialize, Clone)]
pub struct GitDiffResult {
    pub text: String,
    pub bytes: u64,
    pub lines: u64,
    pub truncated: bool,
}

fn bounded_diff(text: String) -> GitDiffResult {
    let bytes = text.len();
    let lines = text.lines().count() as u64;
    if bytes <= MAX_DIFF_BYTES {
        return GitDiffResult {
            text,
            bytes: bytes as u64,
            lines,
            truncated: false,
        };
    }

    let mut end = MAX_DIFF_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    GitDiffResult {
        text: text[..end].to_string(),
        bytes: bytes as u64,
        lines,
        truncated: true,
    }
}

/// Upper bound on `-U` context lines a caller may request.
const MAX_DIFF_CONTEXT: u32 = 2000;

#[tauri::command]
fn git_diff(
    root: String,
    path: Option<String>,
    staged: Option<bool>,
    context: Option<u32>,
) -> Result<GitDiffResult, String> {
    let root = canonical_project_root(&root)?.to_string_lossy().to_string();
    let mut args: Vec<String> = vec![
        "--no-pager".into(),
        "diff".into(),
        "--no-color".into(),
        "--relative".into(),
    ];
    // Context lines, for expanding a hunk in place. Clamped rather than passed
    // through: the value reaches a subprocess argument, and an unbounded one
    // would let the caller ask git to render an arbitrarily large diff.
    if let Some(lines) = context {
        args.push(format!("-U{}", lines.min(MAX_DIFF_CONTEXT)));
    }
    if staged.unwrap_or(false) {
        args.push("--cached".into());
    }
    if let Some(p) = path.as_ref() {
        validate_git_relative_path(p)?;
        args.push("--".into());
        args.push(p.clone());
    } else {
        args.push("--".into());
        args.push(".".into());
    }
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = run_git(&root, &refs)?;
    if !out.trim().is_empty() {
        return Ok(bounded_diff(out));
    }
    // An untracked file has no diff; show it as an all-additions block instead
    // of an empty pane.
    if let Some(p) = path {
        let full = resolve_project_path(&root, &p)?;
        if full.is_file() {
            if let Ok(text) = std::fs::read_to_string(&full) {
                let mut s = format!("--- /dev/null\n+++ b/{}\n", p);
                for line in text.lines() {
                    s.push('+');
                    s.push_str(line);
                    s.push('\n');
                }
                return Ok(bounded_diff(s));
            }
        }
    }
    Ok(bounded_diff(out))
}

#[derive(Debug, Serialize, Clone)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub relative: String,
}

#[tauri::command]
fn git_log(root: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    let root = canonical_project_root(&root)?.to_string_lossy().to_string();
    let n = limit.unwrap_or(30).clamp(1, 200).to_string();
    let raw = run_git(
        &root,
        &[
            "--no-pager",
            "log",
            "-n",
            &n,
            "--pretty=format:%H\x1f%h\x1f%s\x1f%an\x1f%ar",
        ],
    )?;
    Ok(raw
        .lines()
        .filter_map(|line| {
            let mut f = line.split('\x1f');
            Some(GitCommit {
                hash: f.next()?.to_string(),
                short: f.next()?.to_string(),
                subject: f.next()?.to_string(),
                author: f.next()?.to_string(),
                relative: f.next().unwrap_or("").to_string(),
            })
        })
        .collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(MetricsState::default())
        .invoke_handler(tauri::generate_handler![
            pty_start,
            pane_session_metrics,
            canonical_project_path,
            pty_write,
            pty_resize,
            pty_stop,
            pty_list,
            browser_navigate,
            browser_set_bounds,
            browser_hide,
            browser_hide_all_except,
            browser_destroy,
            browser_destroy_many,
            browser_reload,
            browser_eval,
            app_environment,
            coven_sessions,
            agent_skills,
            fs_list_dir,
            fs_read_text,
            fs_write_text,
            git_status,
            git_worktrees,
            git_diff,
            git_log,
            workspace_metrics,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{
                    apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
                };
                if let Some(window) = app.get_webview_window("main") {
                    let _ = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::HudWindow,
                        Some(NSVisualEffectState::Active),
                        Some(10.0),
                    );
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod workspace_panel_tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock must be after the Unix epoch")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "psyche-workspace-panels-{}-{}-{}",
                label,
                std::process::id(),
                nonce
            ));
            std::fs::create_dir_all(&root).expect("temporary tree must be created");
            Self { root }
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn path_text(path: &Path) -> &str {
        path.to_str().expect("test paths must be UTF-8")
    }

    #[cfg(unix)]
    fn write_test_executable(path: &Path, mode: u32) {
        std::fs::write(path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn resolves_the_first_executable_on_path_to_its_canonical_path() {
        let tree = TempTree::new("coven-path-order");
        let first = tree.root.join("first");
        let second = tree.root.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        write_test_executable(&first.join("real-coven"), 0o700);
        symlink(first.join("real-coven"), first.join("coven")).unwrap();
        write_test_executable(&second.join("coven"), 0o700);
        let path = std::env::join_paths([&first, &second]).unwrap();

        assert_eq!(
            which_on_path_with("coven", &path),
            Some(path_text(&first.join("real-coven").canonicalize().unwrap()).to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn path_resolution_requires_effective_execute_access_and_rejects_directories() {
        let tree = TempTree::new("coven-path-executable");
        let non_executable = tree.root.join("non-executable");
        let group_only = tree.root.join("group-only");
        let other_only = tree.root.join("other-only");
        let directory = tree.root.join("directory");
        let executable = tree.root.join("executable");
        for dir in [
            &non_executable,
            &group_only,
            &other_only,
            &directory,
            &executable,
        ] {
            std::fs::create_dir_all(dir).unwrap();
        }
        write_test_executable(&non_executable.join("coven"), 0o600);
        write_test_executable(&group_only.join("coven"), 0o010);
        write_test_executable(&other_only.join("coven"), 0o001);
        std::fs::create_dir_all(directory.join("coven")).unwrap();
        write_test_executable(&executable.join("coven"), 0o700);
        let effective_uid = unsafe { libc::geteuid() };
        let mut search_dirs = vec![&non_executable];
        if effective_uid != 0 {
            search_dirs.extend([&group_only, &other_only]);
        }
        search_dirs.extend([&directory, &executable]);
        let path = std::env::join_paths(search_dirs).unwrap();

        assert_eq!(
            which_on_path_with("coven", &path),
            Some(path_text(&executable.join("coven").canonicalize().unwrap()).to_string())
        );
        assert!(!is_executable_file(&non_executable.join("coven")));
        assert!(!is_executable_file(&directory.join("coven")));
        if effective_uid == 0 {
            // POSIX grants root X_OK when any execute bit is set.
            assert!(is_executable_file(&group_only.join("coven")));
            assert!(is_executable_file(&other_only.join("coven")));
        } else {
            assert!(!is_executable_file(&group_only.join("coven")));
            assert!(!is_executable_file(&other_only.join("coven")));
        }
    }

    fn launch_options(
        launch_kind: Option<&str>,
        session_id: Option<&str>,
        command: Option<&str>,
        args: Option<&[&str]>,
    ) -> StartOptions {
        launch_options_with_env(launch_kind, session_id, command, args, None)
    }

    fn launch_options_with_env(
        launch_kind: Option<&str>,
        session_id: Option<&str>,
        command: Option<&str>,
        args: Option<&[&str]>,
        env: Option<&[(&str, &str)]>,
    ) -> StartOptions {
        StartOptions {
            thread_id: "launch-validation".to_string(),
            project_root: Some("/project".to_string()),
            cwd: None,
            launch_kind: launch_kind.map(str::to_string),
            coven_session_id: session_id.map(str::to_string),
            command: command.map(str::to_string),
            args: args.map(|values| values.iter().map(|value| (*value).to_string()).collect()),
            cols: None,
            rows: None,
            env: env.map(|values| {
                values
                    .iter()
                    .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                    .collect()
            }),
        }
    }

    fn native_chat_options(
        session_id: Option<&str>,
        command: Option<&str>,
        args: Option<&[&str]>,
    ) -> StartOptions {
        launch_options_with_env(
            Some("coven-chat"),
            session_id,
            command,
            args,
            Some(&[(COVEN_SESSION_SOURCE, PSYCHE_SESSION_SOURCE)]),
        )
    }

    #[test]
    fn accepts_exact_native_coven_chat_and_attach_launches() {
        let coven = "/canonical/bin/coven";
        let session_id = "12345678-1234-4abc-8def-1234567890ab";
        let chat = native_chat_options(
            Some(session_id),
            Some(coven),
            Some(&["code", "--session-id", session_id]),
        );
        let attach = launch_options(
            Some("coven-attach"),
            Some(session_id),
            Some(coven),
            Some(&["attach", session_id]),
        );

        assert_eq!(validate_coven_launch_with(&chat, Some(coven)), Ok(()));
        assert_eq!(validate_coven_launch_with(&attach, Some(coven)), Ok(()));
    }

    #[test]
    fn rejects_invalid_native_coven_launch_environments() {
        let coven = "/canonical/bin/coven";
        let chat_envs = [
            None,
            Some(&[][..]),
            Some(&[("COVEN_SESSION_SOURCE", "other")][..]),
            Some(&[("OTHER", "psyche-build")][..]),
            Some(&[("COVEN_SESSION_SOURCE", "psyche-build"), ("OTHER", "value")][..]),
        ];
        for env in chat_envs {
            let chat = launch_options_with_env(
                Some("coven-chat"),
                None,
                Some(coven),
                Some(&["chat"]),
                env,
            );
            assert_eq!(
                validate_coven_launch_with(&chat, Some(coven)),
                Err("coven-chat requires exactly COVEN_SESSION_SOURCE=psyche-build".to_string())
            );
        }

        for env in [
            Some(&[("COVEN_SESSION_SOURCE", "psyche-build")][..]),
            Some(&[("OTHER", "value")][..]),
        ] {
            let attach = launch_options_with_env(
                Some("coven-attach"),
                Some("safe"),
                Some(coven),
                Some(&["attach", "safe"]),
                env,
            );
            assert_eq!(
                validate_coven_launch_with(&attach, Some(coven)),
                Err("coven-attach does not accept launch environment entries".to_string())
            );
        }

        let empty_env_attach = launch_options_with_env(
            Some("coven-attach"),
            Some("safe"),
            Some(coven),
            Some(&["attach", "safe"]),
            Some(&[]),
        );
        assert_eq!(
            validate_coven_launch_with(&empty_env_attach, Some(coven)),
            Ok(())
        );
    }

    #[test]
    fn applies_effective_launch_environment_without_relabeling_attachments() {
        let mut attach_without_env = CommandBuilder::new("/bin/coven");
        attach_without_env.env(COVEN_SESSION_SOURCE, PSYCHE_SESSION_SOURCE);
        apply_launch_env(&mut attach_without_env, None, Some("coven-attach"));
        assert_eq!(attach_without_env.get_env(COVEN_SESSION_SOURCE), None);

        let empty_env = HashMap::new();
        let mut attach_with_empty_env = CommandBuilder::new("/bin/coven");
        attach_with_empty_env.env(COVEN_SESSION_SOURCE, PSYCHE_SESSION_SOURCE);
        apply_launch_env(
            &mut attach_with_empty_env,
            Some(&empty_env),
            Some("coven-attach"),
        );
        assert_eq!(attach_with_empty_env.get_env(COVEN_SESSION_SOURCE), None);

        let mut legacy = CommandBuilder::new("/bin/zsh");
        legacy.env(COVEN_SESSION_SOURCE, "inherited");
        apply_launch_env(&mut legacy, None, None);
        assert_eq!(
            legacy.get_env(COVEN_SESSION_SOURCE),
            Some(std::ffi::OsStr::new("inherited"))
        );

        let chat_env = HashMap::from([(
            COVEN_SESSION_SOURCE.to_string(),
            PSYCHE_SESSION_SOURCE.to_string(),
        )]);
        let mut chat = CommandBuilder::new("/bin/coven");
        chat.env(COVEN_SESSION_SOURCE, "inherited");
        apply_launch_env(&mut chat, Some(&chat_env), Some("coven-chat"));
        assert_eq!(
            chat.get_env(COVEN_SESSION_SOURCE),
            Some(std::ffi::OsStr::new(PSYCHE_SESSION_SOURCE))
        );
    }

    #[test]
    fn empty_descriptor_environment_values_still_unset_variables() {
        let env = HashMap::from([("REMOVE_ME".to_string(), String::new())]);
        let mut command = CommandBuilder::new("/bin/zsh");
        command.env("REMOVE_ME", "inherited");

        apply_launch_env(&mut command, Some(&env), None);

        assert_eq!(command.get_env("REMOVE_ME"), None);
    }

    #[test]
    fn preserves_legacy_launches_without_a_launch_kind() {
        let legacy = launch_options_with_env(
            None,
            Some("ignored"),
            Some("/bin/zsh"),
            Some(&["-l"]),
            Some(&[("LEGACY_ENV", "unrestricted")]),
        );
        assert_eq!(validate_coven_launch_with(&legacy, None), Ok(()));
    }

    #[test]
    fn rejects_malformed_or_unresolved_native_coven_launches() {
        let coven = "/canonical/bin/coven";
        let session_id = "12345678-1234-4abc-8def-1234567890ab";
        let invalid = [
            (
                native_chat_options(Some(session_id), Some(coven), None),
                "coven-chat requires exactly 'code --session-id' and the validated session id",
            ),
            (
                native_chat_options(
                    None,
                    Some(coven),
                    Some(&["code", "--session-id", session_id]),
                ),
                "coven-chat requires a session id",
            ),
            (
                native_chat_options(
                    Some(session_id),
                    Some(coven),
                    Some(&[
                        "code",
                        "--session-id",
                        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    ]),
                ),
                "coven-chat requires exactly 'code --session-id' and the validated session id",
            ),
            (
                native_chat_options(
                    Some("../unsafe"),
                    Some(coven),
                    Some(&["code", "--session-id", "../unsafe"]),
                ),
                "coven-chat session id is unsafe",
            ),
            (
                native_chat_options(
                    Some(session_id),
                    Some("/wrong/coven"),
                    Some(&["code", "--session-id", session_id]),
                ),
                "Coven launch command does not match the resolved executable",
            ),
            (
                native_chat_options(Some(session_id), Some(coven), Some(&["code", session_id])),
                "coven-chat requires exactly 'code --session-id' and the validated session id",
            ),
            (
                native_chat_options(
                    Some(session_id),
                    Some(coven),
                    Some(&["code", "--session-id", session_id, "extra"]),
                ),
                "coven-chat requires exactly 'code --session-id' and the validated session id",
            ),
            (
                launch_options(
                    Some("coven-attach"),
                    None,
                    Some(coven),
                    Some(&["attach", "safe"]),
                ),
                "coven-attach requires a session id",
            ),
            (
                launch_options(
                    Some("coven-attach"),
                    Some("../unsafe"),
                    Some(coven),
                    Some(&["attach", "../unsafe"]),
                ),
                "coven-attach session id is unsafe",
            ),
            (
                launch_options(
                    Some("coven-attach"),
                    Some("safe"),
                    Some(coven),
                    Some(&["attach"]),
                ),
                "coven-attach requires exactly 'attach' and the validated session id",
            ),
            (
                launch_options(
                    Some("coven-attach"),
                    Some("safe"),
                    Some(coven),
                    Some(&["attach", "other"]),
                ),
                "coven-attach requires exactly 'attach' and the validated session id",
            ),
            (
                launch_options(Some("unknown"), None, Some(coven), Some(&["chat"])),
                "unsupported launch kind: unknown",
            ),
        ];

        for (options, expected) in invalid {
            assert_eq!(
                validate_coven_launch_with(&options, Some(coven)),
                Err(expected.to_string())
            );
        }
        let chat = native_chat_options(
            Some(session_id),
            Some(coven),
            Some(&["code", "--session-id", session_id]),
        );
        assert_eq!(
            validate_coven_launch_with(&chat, None),
            Err("Coven executable not found".to_string())
        );
    }

    #[test]
    fn resolves_pty_cwd_inside_project_or_verified_linked_worktree() {
        let tree = TempTree::new("pty-cwd-contained");
        let project = tree.root.join("project");
        let nested = project.join("packages").join("app");
        let linked = tree.root.join("linked-review");
        let linked_nested = linked.join("crates").join("native");
        std::fs::create_dir_all(&nested).unwrap();
        run_test_git(&project, &["init", "-q"]);
        run_test_git(&project, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &project,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&project, &["commit", "--allow-empty", "-qm", "baseline"]);
        run_test_git(
            &project,
            &["worktree", "add", "-q", "-b", "review", path_text(&linked)],
        );
        std::fs::create_dir_all(&linked_nested).unwrap();

        assert_eq!(
            resolve_pty_cwd_with_worktrees(path_text(&project), path_text(&nested), &[]).unwrap(),
            nested.canonicalize().unwrap(),
        );
        assert_eq!(
            resolve_pty_cwd_with_worktrees(
                path_text(&project),
                path_text(&linked_nested),
                &[linked.canonicalize().unwrap()],
            )
            .unwrap(),
            linked_nested.canonicalize().unwrap(),
        );
        assert_eq!(
            resolve_pty_cwd(path_text(&project), path_text(&linked_nested)).unwrap(),
            linked_nested.canonicalize().unwrap(),
        );
    }

    #[test]
    fn rejects_unrelated_missing_and_file_pty_cwds() {
        let tree = TempTree::new("pty-cwd-rejected");
        let project = tree.root.join("project");
        let sibling = tree.root.join("sibling");
        let file = project.join("README.md");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(&file, "not a directory\n").unwrap();

        assert!(
            resolve_pty_cwd_with_worktrees(path_text(&project), path_text(&sibling), &[]).is_err()
        );
        assert!(resolve_pty_cwd(path_text(&project), path_text(&sibling)).is_err());
        assert!(resolve_pty_cwd_with_worktrees(
            path_text(&project),
            path_text(&project.join("missing")),
            &[],
        )
        .is_err());
        assert!(
            resolve_pty_cwd_with_worktrees(path_text(&project), path_text(&file), &[]).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_pty_cwd_symlinks_that_escape_the_project() {
        use std::os::unix::fs::symlink;

        let tree = TempTree::new("pty-cwd-symlink");
        let project = tree.root.join("project");
        let outside = tree.root.join("outside");
        let link = project.join("escape");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, &link).unwrap();

        assert!(
            resolve_pty_cwd_with_worktrees(path_text(&project), path_text(&link), &[]).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn opened_pty_cwd_cannot_retarget_after_rename_and_symlink_swap() {
        use std::os::unix::fs::symlink;

        let tree = TempTree::new("pty-cwd-handle");
        let project = tree.root.join("project");
        let original = project.join("workspace");
        let moved = project.join("workspace-moved");
        let outside = tree.root.join("outside");
        std::fs::create_dir_all(&original).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let opened =
            open_pty_cwd_with_worktrees(path_text(&project), path_text(&original), &[]).unwrap();
        std::fs::rename(&original, &moved).unwrap();
        symlink(&outside, &original).unwrap();

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 10,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/pwd");
        command.arg("-P");
        opened.configure_command_cwd(&mut command).unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(opened);
        drop(pair.slave);
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut reader = pair.master.try_clone_reader().unwrap();
        std::thread::spawn(move || {
            let mut output = String::new();
            reader.read_to_string(&mut output).unwrap();
            sender.send(output).unwrap();
        });
        let writer = pair.master.take_writer().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        drop(writer);
        let status = child.wait().unwrap();
        assert!(status.success(), "portable-pty child failed: {status}");
        drop(pair.master);
        let actual = receiver.recv().unwrap();
        assert_eq!(actual.trim(), path_text(&moved.canonicalize().unwrap()));
        assert_ne!(actual.trim(), path_text(&outside.canonicalize().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_an_unavailable_pty_cwd_locator_before_command_construction() {
        let tree = TempTree::new("pty-cwd-locator");
        let project = tree.root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let mut opened =
            open_pty_cwd_with_worktrees(path_text(&project), path_text(&project), &[]).unwrap();
        opened.spawn_path = tree.root.join("unavailable-locator");
        let mut command = CommandBuilder::new("/bin/pwd");

        let error = opened.configure_command_cwd(&mut command).unwrap_err();

        assert!(error.contains("stable PTY cwd locator is unavailable"));
        assert!(command.get_cwd().is_none());
    }

    #[test]
    fn reserves_thread_before_invalid_cwd_validation_and_releases_on_failure() {
        let tree = TempTree::new("pty-reservation-order");
        let thread_id = format!("duplicate-{}", tree.root.display());
        let reserved = PendingPtyStart::reserve(&thread_id).unwrap();
        let duplicate = StartOptions {
            thread_id: thread_id.clone(),
            project_root: None,
            cwd: Some("/definitely/missing".to_string()),
            launch_kind: None,
            coven_session_id: None,
            command: None,
            args: None,
            cols: None,
            rows: None,
            env: None,
        };

        let error = prepare_pty_start(&duplicate).unwrap_err();
        assert!(error.contains("already running"));
        drop(reserved);

        let invalid = StartOptions {
            project_root: Some(path_text(&tree.root.join("missing")).to_string()),
            ..duplicate
        };
        assert!(prepare_pty_start(&invalid).is_err());
        assert!(PendingPtyStart::reserve(&thread_id).is_ok());
    }

    fn run_test_git(root: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .expect("git must run in tests");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn parses_feature_flag_values_without_mutating_process_environment() {
        assert!(feature_flag_value(None, true));
        assert!(!feature_flag_value(None, false));
        assert!(feature_flag_value(Some("1"), false));
        assert!(feature_flag_value(Some("true"), false));
        assert!(!feature_flag_value(Some("0"), true));
        assert!(!feature_flag_value(Some(" FALSE "), true));
        assert!(!feature_flag_value(Some("off"), true));
        assert!(!feature_flag_value(Some("Disabled"), true));
    }

    fn save_temp_paths(target: &Path) -> Vec<PathBuf> {
        let prefix = format!(
            "{}.psyche-save-",
            target
                .file_name()
                .expect("save target must have a file name")
                .to_string_lossy()
        );
        std::fs::read_dir(target.parent().expect("save target must have a parent"))
            .expect("save target parent must be readable")
            .map(|entry| entry.expect("directory entry must be readable").path())
            .filter(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().starts_with(&prefix))
                    .unwrap_or(false)
            })
            .collect()
    }

    #[test]
    fn resolves_existing_paths_inside_the_project() {
        let tree = TempTree::new("inside");
        let nested = tree.root.join("src").join("main.rs");
        std::fs::create_dir_all(nested.parent().unwrap()).unwrap();
        std::fs::write(&nested, "fn main() {}\n").unwrap();

        let resolved = resolve_project_path(path_text(&tree.root), path_text(&nested)).unwrap();

        assert_eq!(resolved, nested.canonicalize().unwrap());
    }

    #[test]
    fn rejects_parent_traversal_and_sibling_prefixes() {
        let tree = TempTree::new("outside");
        let project = tree.root.join("project");
        let sibling = tree.root.join("project-copy");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let sibling_file = sibling.join("secret.txt");
        std::fs::write(&sibling_file, "secret\n").unwrap();

        assert!(resolve_project_path(path_text(&project), "../project-copy/secret.txt").is_err());
        assert!(resolve_project_path(path_text(&project), path_text(&sibling_file)).is_err());

        let relative_error = fs_write_text(
            path_text(&project).to_string(),
            "../project-copy/secret.txt".to_string(),
            "clobbered\n".to_string(),
            "secret\n".to_string(),
        )
        .unwrap_err();
        let absolute_error = fs_write_text(
            path_text(&project).to_string(),
            path_text(&sibling_file).to_string(),
            "clobbered\n".to_string(),
            "secret\n".to_string(),
        )
        .unwrap_err();
        assert!(relative_error.contains("outside project root"));
        assert!(absolute_error.contains("outside project root"));
        assert_eq!(std::fs::read(&sibling_file).unwrap(), b"secret\n");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_the_project() {
        use std::os::unix::fs::symlink;

        let tree = TempTree::new("symlink");
        let project = tree.root.join("project");
        let outside = tree.root.join("outside.txt");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(&outside, "secret\n").unwrap();
        let link = project.join("linked-secret.txt");
        symlink(&outside, &link).unwrap();

        assert!(resolve_project_path(path_text(&project), path_text(&link)).is_err());
        let error = fs_write_text(
            path_text(&project).to_string(),
            path_text(&link).to_string(),
            "clobbered\n".to_string(),
            "secret\n".to_string(),
        )
        .unwrap_err();
        assert!(error.contains("outside project root"));
        assert_eq!(std::fs::read(&outside).unwrap(), b"secret\n");
    }

    #[test]
    fn saves_contained_text_atomically_and_preserves_permissions() {
        let tree = TempTree::new("save");
        let target = tree.root.join("notes.txt");
        std::fs::write(&target, "before\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o4750)).unwrap();
        }
        let permissions_before = std::fs::metadata(&target).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            assert_eq!(permissions_before.mode() & 0o7777, 0o4750);
        }

        let saved = fs_write_text(
            path_text(&tree.root).to_string(),
            path_text(&target).to_string(),
            "after\n".to_string(),
            "before\n".to_string(),
        )
        .unwrap();

        assert_eq!(saved.path, target.canonicalize().unwrap().to_string_lossy());
        assert_eq!(saved.text, "after\n");
        assert_eq!(saved.size, 6);
        assert_eq!(std::fs::read(&target).unwrap(), b"after\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let permissions_after = std::fs::metadata(&target).unwrap().permissions();
            assert_eq!(permissions_after.mode(), permissions_before.mode());
            assert_eq!(permissions_after.mode() & 0o7777, 0o4750);
        }
        assert!(save_temp_paths(&target).is_empty());
    }

    #[test]
    fn rejects_stale_saves_without_mutation_or_temp_files() {
        let tree = TempTree::new("stale-save");
        let target = tree.root.join("notes.txt");
        std::fs::write(&target, "current\n").unwrap();

        let error = fs_write_text(
            path_text(&tree.root).to_string(),
            path_text(&target).to_string(),
            "replacement\n".to_string(),
            "stale\n".to_string(),
        )
        .unwrap_err();

        assert!(error.contains("changed on disk"));
        assert_eq!(std::fs::read(&target).unwrap(), b"current\n");
        assert!(save_temp_paths(&target).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_content_changes_before_the_atomic_commit() {
        let tree = TempTree::new("save-race-content");
        let target = tree.root.join("notes.txt");
        std::fs::write(&target, "before\n").unwrap();

        let error = fs_write_text_with_before_commit(
            path_text(&tree.root).to_string(),
            path_text(&target).to_string(),
            "editor\n".to_string(),
            "before\n".to_string(),
            || {
                std::fs::write(&target, "external\n").unwrap();
            },
        )
        .unwrap_err();

        assert!(error.contains("changed on disk"));
        assert_eq!(std::fs::read(&target).unwrap(), b"external\n");
        assert!(save_temp_paths(&target).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_target_deletion_before_the_atomic_commit() {
        let tree = TempTree::new("save-race-delete");
        let target = tree.root.join("notes.txt");
        std::fs::write(&target, "before\n").unwrap();

        let error = fs_write_text_with_before_commit(
            path_text(&tree.root).to_string(),
            path_text(&target).to_string(),
            "editor\n".to_string(),
            "before\n".to_string(),
            || {
                std::fs::remove_file(&target).unwrap();
            },
        )
        .unwrap_err();

        assert!(error.contains("changed on disk"));
        assert!(!target.exists());
        assert!(save_temp_paths(&target).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_target_replacement_before_the_atomic_commit() {
        let tree = TempTree::new("save-race-replace");
        let target = tree.root.join("notes.txt");
        let moved_target = tree.root.join("notes-original.txt");
        std::fs::write(&target, "before\n").unwrap();

        let error = fs_write_text_with_before_commit(
            path_text(&tree.root).to_string(),
            path_text(&target).to_string(),
            "editor\n".to_string(),
            "before\n".to_string(),
            || {
                std::fs::rename(&target, &moved_target).unwrap();
                std::fs::write(&target, "replacement\n").unwrap();
            },
        )
        .unwrap_err();

        assert!(error.contains("changed on disk"));
        assert_eq!(std::fs::read(&target).unwrap(), b"replacement\n");
        assert_eq!(std::fs::read(&moved_target).unwrap(), b"before\n");
        assert!(save_temp_paths(&target).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_parent_replacement_with_an_outside_symlink_before_commit() {
        use std::os::unix::fs::symlink;

        let tree = TempTree::new("save-race-parent");
        let project = tree.root.join("project");
        let parent = project.join("src");
        let moved_parent = project.join("src-original");
        let target = parent.join("notes.txt");
        let moved_target = moved_parent.join("notes.txt");
        let outside = tree.root.join("outside");
        let outside_target = outside.join("notes.txt");
        std::fs::create_dir_all(&parent).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(&target, "before\n").unwrap();
        std::fs::write(&outside_target, "outside\n").unwrap();

        let error = fs_write_text_with_before_commit(
            path_text(&project).to_string(),
            path_text(&target).to_string(),
            "editor\n".to_string(),
            "before\n".to_string(),
            || {
                std::fs::rename(&parent, &moved_parent).unwrap();
                symlink(&outside, &parent).unwrap();
            },
        )
        .unwrap_err();

        assert!(error.contains("outside project root") || error.contains("parent changed"));
        assert_eq!(std::fs::read(&outside_target).unwrap(), b"outside\n");
        assert_eq!(std::fs::read(&moved_target).unwrap(), b"before\n");
        assert!(save_temp_paths(&moved_target).is_empty());
        assert!(save_temp_paths(&outside_target).is_empty());
    }

    #[test]
    fn invalid_utf8_is_binary_and_cannot_be_saved_as_text() {
        let tree = TempTree::new("invalid-utf8");
        let target = tree.root.join("invalid.txt");
        let original = [0xff, 0xfe, b'x'];
        std::fs::write(&target, original).unwrap();

        let preview = fs_read_text(
            path_text(&tree.root).to_string(),
            path_text(&target).to_string(),
        )
        .unwrap();
        assert!(preview.binary);
        assert!(preview.text.is_empty());

        let error = fs_write_text(
            path_text(&tree.root).to_string(),
            path_text(&target).to_string(),
            "replacement\n".to_string(),
            String::new(),
        )
        .unwrap_err();
        assert!(error.contains("file is not valid UTF-8"));
        assert_eq!(std::fs::read(&target).unwrap(), original);
        assert!(save_temp_paths(&target).is_empty());
    }

    #[test]
    fn nul_anywhere_in_the_bounded_preview_is_binary() {
        let tree = TempTree::new("late-nul");
        let target = tree.root.join("binary.txt");
        let mut original = vec![b'a'; 9000];
        original[8500] = 0;
        std::fs::write(&target, original).unwrap();

        let preview = fs_read_text(
            path_text(&tree.root).to_string(),
            path_text(&target).to_string(),
        )
        .unwrap();

        assert!(preview.binary);
        assert!(preview.text.is_empty());
    }

    #[test]
    fn git_file_paths_must_be_relative_and_cannot_traverse() {
        assert!(validate_git_relative_path("src/main.rs").is_ok());
        assert!(validate_git_relative_path("../secret.txt").is_err());
        assert!(validate_git_relative_path("src/../../secret.txt").is_err());
        assert!(validate_git_relative_path("/tmp/secret.txt").is_err());
    }

    #[test]
    fn git_status_and_diff_stay_inside_a_nested_project_root() {
        let tree = TempTree::new("git-scope");
        let project = tree.root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(tree.root.join("outside.txt"), "outside baseline\n").unwrap();
        std::fs::write(project.join("inside.txt"), "inside baseline\n").unwrap();
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&tree.root, &["add", "."]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::write(tree.root.join("outside.txt"), "outside changed\n").unwrap();
        std::fs::write(project.join("inside.txt"), "inside changed\n").unwrap();

        let status = git_status(path_text(&project).to_string()).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "inside.txt");

        let diff = git_diff(
            path_text(&project).to_string(),
            Some("inside.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();
        assert!(diff.text.contains("+inside changed"));
        assert!(!diff.text.contains("outside changed"));
        assert!(!diff.truncated);
        assert_eq!(diff.bytes, diff.text.len() as u64);
        assert_eq!(diff.lines, diff.text.lines().count() as u64);
    }

    #[test]
    fn bounded_diffs_stop_before_a_split_utf8_character() {
        let mut full = "a".repeat(MAX_DIFF_BYTES - 1);
        full.push('💖');

        let diff = bounded_diff(full);

        assert!(diff.truncated);
        assert_eq!(diff.text.len(), MAX_DIFF_BYTES - 1);
        assert_eq!(diff.bytes, (MAX_DIFF_BYTES + 3) as u64);
        assert_eq!(diff.lines, 1);
        assert!(std::str::from_utf8(diff.text.as_bytes()).is_ok());
    }

    #[test]
    fn caps_large_tracked_git_diffs_with_full_result_metadata() {
        let tree = TempTree::new("large-tracked-diff");
        let target = tree.root.join("large.txt");
        std::fs::write(&target, "baseline\n").unwrap();
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&tree.root, &["add", "large.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::write(&target, "changed payload\n".repeat(180_000)).unwrap();

        let full = run_git(
            path_text(&tree.root),
            &[
                "--no-pager",
                "diff",
                "--no-color",
                "--relative",
                "--",
                "large.txt",
            ],
        )
        .unwrap();
        assert!(full.len() > MAX_DIFF_BYTES);

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("large.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.truncated);
        assert!(diff.text.len() <= MAX_DIFF_BYTES);
        assert_eq!(diff.bytes, full.len() as u64);
        assert_eq!(diff.lines, full.lines().count() as u64);
        assert!(diff.bytes > diff.text.len() as u64);
        assert!(diff.lines > diff.text.lines().count() as u64);
        assert!(std::str::from_utf8(diff.text.as_bytes()).is_ok());
    }

    #[test]
    fn caps_large_untracked_diffs_with_the_same_byte_contract() {
        let tree = TempTree::new("large-untracked-diff");
        run_test_git(&tree.root, &["init", "-q"]);
        let target = tree.root.join("untracked.txt");
        let contents = "untracked payload\n".repeat(150_000);
        std::fs::write(&target, &contents).unwrap();
        let full = format!(
            "--- /dev/null\n+++ b/untracked.txt\n{}",
            contents
                .lines()
                .map(|line| format!("+{line}\n"))
                .collect::<String>()
        );

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("untracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(full.len() > MAX_DIFF_BYTES);
        assert!(diff.truncated);
        assert!(diff.text.len() <= MAX_DIFF_BYTES);
        assert_eq!(diff.bytes, full.len() as u64);
        assert_eq!(diff.lines, full.lines().count() as u64);
        assert!(diff.lines > diff.text.lines().count() as u64);
        assert!(std::str::from_utf8(diff.text.as_bytes()).is_ok());
    }

    #[test]
    fn returns_complete_structured_diff_for_a_small_untracked_file() {
        let tree = TempTree::new("small-untracked-diff");
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("notes.txt"), "one\ntwo\n").unwrap();

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("notes.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();
        let expected = "--- /dev/null\n+++ b/notes.txt\n+one\n+two\n";

        assert_eq!(diff.text, expected);
        assert_eq!(diff.bytes, expected.len() as u64);
        assert_eq!(diff.lines, expected.lines().count() as u64);
        assert!(!diff.truncated);
    }

    #[test]
    fn git_diff_widens_context_and_clamps_the_request() {
        let tree = TempTree::new("git-diff-context");
        run_git(path_text(&tree.root), &["init", "--quiet"]).unwrap();
        let mut body = String::new();
        for index in 0..40 {
            body.push_str(&format!("line {}\n", index));
        }
        std::fs::write(tree.root.join("wide.txt"), &body).unwrap();
        run_git(path_text(&tree.root), &["add", "-A"]).unwrap();
        run_git(
            path_text(&tree.root),
            &[
                "-c",
                "user.email=t@e",
                "-c",
                "user.name=t",
                "commit",
                "-m",
                "seed",
                "--quiet",
            ],
        )
        .unwrap();
        let edited = body.replace("line 20\n", "line twenty\n");
        std::fs::write(tree.root.join("wide.txt"), edited).unwrap();

        let narrow = git_diff(
            path_text(&tree.root).to_string(),
            Some("wide.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();
        let wide = git_diff(
            path_text(&tree.root).to_string(),
            Some("wide.txt".to_string()),
            Some(false),
            Some(30),
        )
        .unwrap();
        // More context means more surrounding lines for the same one-line edit.
        assert!(wide.text.lines().count() > narrow.text.lines().count());

        // Beyond the cap the request is clamped, not honoured: the argument
        // reaches a subprocess and an unbounded one is not ours to forward.
        let clamped = git_diff(
            path_text(&tree.root).to_string(),
            Some("wide.txt".to_string()),
            Some(false),
            Some(u32::MAX),
        )
        .unwrap();
        assert!(clamped.text.contains("line twenty"));
    }

    #[test]
    fn parses_linked_detached_locked_and_prunable_worktrees() {
        let worktrees = parse_git_worktrees(
            "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n\
             worktree /external/review\nHEAD def\ndetached\nlocked in use\n\n\
             worktree /missing\nHEAD 000\nprunable gitdir file points to non-existent location\n\n",
        );

        assert_eq!(worktrees.len(), 3);
        assert!(worktrees[0].is_main);
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
        assert!(worktrees[1].detached);
        assert_eq!(worktrees[1].lock_reason.as_deref(), Some("in use"));
        assert!(worktrees[2].prunable);
        assert!(worktrees[2].missing);
    }
}
