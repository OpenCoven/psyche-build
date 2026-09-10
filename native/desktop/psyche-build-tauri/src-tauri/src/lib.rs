use std::borrow::Cow;
#[cfg(test)]
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
#[cfg(unix)]
use std::ffi::CString;
use std::ffi::{OsStr, OsString};
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
#[cfg(unix)]
use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
#[cfg(target_os = "macos")]
use objc2::{
    runtime::{AnyObject, Imp, Sel},
    sel,
};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSDictionary, NSError, NSString, NSURLRequest, NSURL};
#[cfg(target_os = "macos")]
use objc2_web_kit::{WKNavigation, WKWebView};
use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl,
};
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;
#[cfg(target_os = "linux")]
use webkit2gtk::{
    glib::{self, translate::ToGlibPtr},
    LoadEvent, WebViewExt,
};
#[cfg(target_os = "windows")]
use webview2_com::{
    take_pwstr, CoTaskMemPWSTR, NavigationCompletedEventHandler, NavigationStartingEventHandler,
};
#[cfg(target_os = "windows")]
use windows::core::{Interface, PWSTR};
mod app;
mod browser_focus;
mod control_provider;
mod coven_sessions;
mod git_control;
mod metrics;
mod native_sessions;
mod native_workspace;
mod pane_metrics;
mod platform;
mod pty_cwd;
mod pty_launch;
mod pty_lifecycle;
mod pty_process;
mod pty_reader;

pub mod pty_transport;
mod runtime_diagnostics;

// Re-exported so `main.rs` keeps calling
// `psyche_build_tauri_lib::run()` unchanged.
pub use app::run;
mod workspace_contract;

// `coven_sessions` reaches `verified_worktree_root` as `super::…`, so it is
// re-exported rather than merely imported.
pub(crate) use git_control::verified_worktree_root;
use git_control::{git_diff, git_log, git_status, git_worktrees};

use pty_cwd::{open_pty_cwd, OpenedPtyCwd};
// `trusted_coven_executable_with` is re-exported rather than merely imported:
// `coven_sessions` reaches it as `super::trusted_coven_executable_with`.
#[cfg(debug_assertions)]
use pty_launch::pty_start_blocking_with_trusted_fixture;
pub(crate) use pty_launch::trusted_coven_executable_with;
// Windows-only, matching its single `#[cfg(target_os = "windows")]`
// definition; `coven_sessions` reaches it as `super::trusted_coven_executable`.
#[cfg(target_os = "windows")]
pub(crate) use pty_launch::trusted_coven_executable;
// `pty_runtime_tests` drives launch validation directly, and the shared
// `TestLivePtySession` fixture reserves a slot through `PendingPtyStart`.
#[cfg(test)]
use pty_launch::{
    apply_launch_env, prepare_pty_start, validate_coven_launch_with, PendingPtyStart,
};
use pty_launch::{pty_attach, pty_start, StartOptions};
// `pty_runtime_tests` drives cwd resolution through these; they are
// `#[cfg(test)]` in `pty_cwd` so the import matches.
#[cfg(test)]
use pty_cwd::{open_pty_cwd_with_worktrees, resolve_pty_cwd, resolve_pty_cwd_with_worktrees};
use pty_lifecycle::{
    InstallSessionOutcome, PtyLifecycleError, PtySession, PtySessionToken, StopSessionOutcome,
    PTY_LIFECYCLES,
};
use pty_process::{PtyProcessTerminator, PtySpawnTerminationGuard, PtyTerminationOutcome};
use pty_reader::{prepare_pty_reader, pump_pty_reader, PtyExitShutdown, PtyReaderCancellation};

// Only `pty_runtime_tests` needs these. They stay behind a `#[cfg(test)]`
// import so the coupling is visible: nineteen inline tests reach into the
// termination internals, and until they move alongside the code they test,
// this module cannot narrow those four types.
#[cfg(test)]
use browser_focus::refresh_browser_focus_identity_document_url;
use browser_focus::{
    browser_focus_identity, detach_browser_native_focus_callback, install_browser_focus_identity,
    install_browser_native_focus_callback, retire_browser_focus_label,
    retire_matching_browser_focus_identity, BrowserFocusIdentity,
};
use control_provider::{
    control_operator_submit, control_provider_complete, control_provider_remove,
    control_provider_shutdown, control_provider_start, control_provider_stop,
    control_provider_upsert, control_state, ControlProviderState,
};

use coven_sessions::is_safe_session_id;
use coven_sessions::{
    coven_launch_capabilities, coven_launch_session, coven_session_kill, coven_sessions,
};
use metrics::{MetricsCollector, MetricsScope, MetricsSnapshot, TrackedPty};
use native_sessions::{
    native_session_capture, native_session_create, native_session_list, native_session_stop,
    NativeLaunchKind, NativeSessionCreate,
};
use native_workspace::{workspace_load, workspace_save};
use pane_metrics::PaneSessionMetrics;
use pty_transport::{
    coordinate_exit_shutdown, AckOutcome as TransportAckOutcome, ExitShutdownOutcome,
    FinalOutputPumpSnapshot, OutputPump, OutputPumpMetrics as TransportOutputPumpMetrics,
    OutputPumpSnapshot as TransportOutputPumpSnapshot, PaneVisibility as TransportPaneVisibility,
    PumpMetrics as TransportPumpMetrics, RecentOutputSnapshots, TransportSessionKey,
    EXIT_DRAIN_TIMEOUT, EXIT_TERMINATION_CLEANUP_TIMEOUT,
};
#[cfg(debug_assertions)]
use runtime_diagnostics::{fixture_start_request, DiagnosticsFixture};
use runtime_diagnostics::{runtime_diagnostics, runtime_process_metrics, RuntimeDiagnosticsState};

const BROWSER_LABEL_PREFIX: &str = "psyche-browser-";
const MIN_BROWSER_SHORTCUT_INTERVAL: Duration = Duration::from_millis(100);
const MAX_PROVIDER_RESULT_BYTES: usize = 4 * 1024 * 1024;
const MAX_BROWSER_SNAPSHOT_JSON_OVERHEAD: usize = 64 * 1024;
const MAX_BROWSER_SNAPSHOT_BYTES: usize =
    (MAX_PROVIDER_RESULT_BYTES - MAX_BROWSER_SNAPSHOT_JSON_OVERHEAD) / 4 * 3;
const MAX_BROWSER_SNAPSHOT_DIMENSION: u32 = 8192;
const MAX_BROWSER_SNAPSHOT_PIXELS: u64 = 16 * 1024 * 1024;
const MAX_BROWSER_SCRIPT_SOURCE_BYTES: usize = 64 * 1024;
const MAX_BROWSER_SCRIPT_ARGS_BYTES: usize = 256 * 1024;
const MAX_BROWSER_SCRIPT_RESULT_BYTES: usize = 256 * 1024;
const BROWSER_SCRIPT_TIMEOUT: Duration = Duration::from_secs(5);
const BROWSER_SCRIPT_CONTEXT_WORLD_NAME: &str = "com.opencoven.psyche.browser-script-context";
const COVEN_SESSION_SOURCE: &str = "COVEN_SESSION_SOURCE";

#[cfg(test)]
std::thread_local! {
    static TEST_GIT_ENV_OVERRIDES: RefCell<Vec<(OsString, Option<OsString>)>> =
        RefCell::new(Vec::new());
    static TEST_GIT_FILTER_SCOPE_QUERIES: RefCell<Vec<String>> = RefCell::new(Vec::new());
    static TEST_GIT_COMMAND_COUNT: RefCell<usize> = const { RefCell::new(0) };
    static TEST_GIT_METADATA_READ_LIMITS: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
}

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

fn ensure_trusted_browser_caller(label: &str) -> Result<(), String> {
    if label == "main" {
        return Ok(());
    }
    Err(format!(
        "browser automation authority is only available to trusted webview 'main'; rejected caller '{label}'"
    ))
}

fn ensure_trusted_pty_caller(label: &str) -> Result<(), String> {
    if label == "main" {
        return Ok(());
    }
    Err(format!(
        "PTY authority is only available to trusted webview 'main'; rejected caller '{label}'"
    ))
}

fn ensure_trusted_project_caller(label: &str) -> Result<(), String> {
    if label == "main" {
        return Ok(());
    }
    Err(format!(
        "project authority is only available to trusted webview 'main'; rejected caller '{label}'"
    ))
}

#[derive(Default)]
struct NativeProjectRootAuthority {
    in_flight_submissions: usize,
    revoking: bool,
}

#[derive(Default)]
struct NativeProjectAuthorityInner {
    roots: Mutex<HashMap<PathBuf, NativeProjectRootAuthority>>,
    startup_reconciled: AtomicBool,
    changed: Condvar,
}

#[derive(Clone, Default)]
pub(crate) struct NativeProjectAuthority {
    inner: Arc<NativeProjectAuthorityInner>,
}

struct NativeProjectSubmissionLease {
    authority: NativeProjectAuthority,
    root: PathBuf,
}

const MAX_NATIVE_PROJECTS: usize = 10;

impl Drop for NativeProjectSubmissionLease {
    fn drop(&mut self) {
        self.authority.release_submission(&self.root);
    }
}

impl NativeProjectAuthority {
    fn from_startup() -> Self {
        let authority = native_workspace::workspace_default_path()
            .and_then(|path| Self::from_workspace_path(&path));
        match authority {
            Ok(authority) => authority,
            Err(error) => {
                log::warn!("native project authority startup rehydration failed closed: {error}");
                Self::default()
            }
        }
    }

    fn from_workspace_path(path: &Path) -> Result<Self, String> {
        let Some(workspace) = native_workspace::load_workspace_from(path)? else {
            return Ok(Self::default());
        };
        native_workspace::validate_workspace(&workspace)?;
        let projects = workspace
            .get("projects")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| "persisted workspace projects are unavailable".to_string())?;
        let authority = Self::default();
        for project in projects {
            let root = project
                .get("root")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "persisted workspace project root must be a string".to_string())?;
            if !Path::new(root).is_absolute() {
                return Err("persisted workspace project root must be absolute".to_string());
            }
            let canonical_root = match canonical_project_root(root) {
                Ok(root) => root,
                Err(error) => {
                    log::warn!(
                        "skipping unavailable persisted project root during startup: {error}"
                    );
                    continue;
                }
            };
            authority.authorize_canonical_native_open(canonical_root)?;
        }
        Ok(authority)
    }

    fn authorize_native_open(&self, root: &Path) -> Result<String, String> {
        if !self.inner.startup_reconciled.load(Ordering::Acquire) {
            return Err("native project authority startup reconciliation is pending".to_string());
        }
        let root = canonical_project_root(&root.to_string_lossy())?;
        self.authorize_canonical_native_open(root)
    }

    fn authorize_canonical_native_open(&self, root: PathBuf) -> Result<String, String> {
        let root_text = root.to_string_lossy().into_owned();
        let mut roots = self.inner.roots.lock();
        if let Some(existing) = roots.get(&root) {
            if existing.revoking {
                return Err("native project authority is closing".to_string());
            }
            return Ok(root_text);
        }
        if roots.len() >= MAX_NATIVE_PROJECTS {
            return Err(format!(
                "native project authority limit reached ({MAX_NATIVE_PROJECTS})"
            ));
        }
        roots.insert(root, NativeProjectRootAuthority::default());
        Ok(root_text)
    }

    fn revoke_native_open(&self, root: &Path) -> Result<bool, String> {
        self.revoke_native_open_with(root, |roots, canonical_root| {
            Ok(roots.remove(canonical_root).is_some())
        })
    }

    fn reconcile_startup_roots(&self, retained_roots: &[String]) -> Result<(), String> {
        let retained_roots = retained_roots
            .iter()
            .map(|root| {
                canonical_project_root(root)
                    .map_err(|_| "restored project root is unavailable".to_string())
            })
            .collect::<Result<HashSet<_>, _>>()?;
        let mut roots = self.inner.roots.lock();
        if self.inner.startup_reconciled.load(Ordering::Acquire) {
            return Err("startup project authority was already reconciled".to_string());
        }
        if retained_roots
            .iter()
            .any(|root| roots.get(root).is_none_or(|authority| authority.revoking))
        {
            return Err("restored project root was not authorized at startup".to_string());
        }
        if roots
            .values()
            .any(|authority| authority.in_flight_submissions > 0)
        {
            return Err(
                "startup project authority cannot reconcile after submissions begin".to_string(),
            );
        }
        roots.retain(|root, _| retained_roots.contains(root));
        self.inner.startup_reconciled.store(true, Ordering::Release);
        Ok(())
    }

    fn revoke_native_open_with<F>(&self, root: &Path, remove: F) -> Result<bool, String>
    where
        F: FnOnce(&mut HashMap<PathBuf, NativeProjectRootAuthority>, &Path) -> Result<bool, String>,
    {
        if !root.is_absolute() {
            return Err("native project authority requires an absolute root".to_string());
        }
        let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let mut roots = self.inner.roots.lock();
        let Some(authority) = roots.get_mut(&root) else {
            return Ok(false);
        };
        authority.revoking = true;
        while roots
            .get(&root)
            .is_some_and(|authority| authority.in_flight_submissions > 0)
        {
            self.inner.changed.wait(&mut roots);
        }
        let result = remove(&mut roots, &root);
        if !matches!(&result, Ok(true)) {
            if let Some(authority) = roots.get_mut(&root) {
                authority.revoking = false;
            }
            self.inner.changed.notify_all();
        }
        result
    }

    fn claim_submission(&self, root: &Path) -> Result<NativeProjectSubmissionLease, String> {
        let root = canonical_project_root(&root.to_string_lossy())
            .map_err(|_| "Coven launch project root is unavailable".to_string())?;
        let mut roots = self.inner.roots.lock();
        if !self.inner.startup_reconciled.load(Ordering::Acquire) {
            return Err("native project authority startup reconciliation is pending".to_string());
        }
        let authority = roots
            .get_mut(&root)
            .filter(|authority| !authority.revoking)
            .ok_or_else(|| "Coven launch project is not open in Psyche".to_string())?;
        authority.in_flight_submissions += 1;
        Ok(NativeProjectSubmissionLease {
            authority: self.clone(),
            root,
        })
    }

    fn release_submission(&self, root: &Path) {
        let mut roots = self.inner.roots.lock();
        let Some(authority) = roots.get_mut(root) else {
            return;
        };
        authority.in_flight_submissions = authority.in_flight_submissions.saturating_sub(1);
        if authority.in_flight_submissions == 0 {
            self.inner.changed.notify_all();
        }
    }

    pub(crate) fn open_project_roots(&self) -> Vec<PathBuf> {
        let roots = self.inner.roots.lock();
        if !self.inner.startup_reconciled.load(Ordering::Acquire) {
            return Vec::new();
        }
        roots
            .iter()
            .filter_map(|(root, authority)| (!authority.revoking).then_some(root.clone()))
            .collect()
    }
}

fn validate_browser_snapshot_dimensions(width: u32, height: u32) -> Result<(), String> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| "browser snapshot dimensions overflow".to_string())?;
    if width == 0
        || height == 0
        || width > MAX_BROWSER_SNAPSHOT_DIMENSION
        || height > MAX_BROWSER_SNAPSHOT_DIMENSION
        || pixels > MAX_BROWSER_SNAPSHOT_PIXELS
    {
        return Err("browser snapshot dimensions exceed maximum".to_string());
    }
    Ok(())
}

// ----------------------------------------------------------------------------
// Multi-PTY backend
// ----------------------------------------------------------------------------

static RECENT_PTY_SNAPSHOTS: Lazy<Mutex<RecentOutputSnapshots>> =
    Lazy::new(|| Mutex::new(RecentOutputSnapshots::default()));

#[derive(Clone, Default)]
struct MetricsState {
    collector: Arc<Mutex<MetricsCollector>>,
}

#[tauri::command]
fn canonical_project_path(root: String) -> Result<String, String> {
    canonical_project_root(&root).map(|path| path.to_string_lossy().to_string())
}

#[cfg(desktop)]
#[tauri::command]
async fn native_project_open(
    app: AppHandle,
    webview: tauri::Webview,
    authority: State<'_, NativeProjectAuthority>,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    ensure_trusted_project_caller(webview.label())?;
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title("Open project");
        if let Some(default_path) = default_path {
            let default_path = PathBuf::from(default_path);
            if default_path.is_dir() {
                dialog = dialog.set_directory(default_path);
            }
        }
        dialog.blocking_pick_folder()
    })
    .await
    .map_err(|error| format!("project picker failed: {error}"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let selected = selected
        .into_path()
        .map_err(|error| format!("project picker returned an unavailable path: {error}"))?;
    authority.authorize_native_open(&selected).map(Some)
}

#[tauri::command]
async fn native_project_close(
    webview: tauri::Webview,
    authority: State<'_, NativeProjectAuthority>,
    root: String,
) -> Result<bool, String> {
    ensure_trusted_project_caller(webview.label())?;
    let authority = authority.inner().clone();
    tauri::async_runtime::spawn_blocking(move || authority.revoke_native_open(Path::new(&root)))
        .await
        .map_err(|error| format!("project authority revocation failed: {error}"))?
}

#[tauri::command]
async fn native_project_reconcile(
    webview: tauri::Webview,
    authority: State<'_, NativeProjectAuthority>,
    roots: Vec<String>,
) -> Result<(), String> {
    ensure_trusted_project_caller(webview.label())?;
    let authority = authority.inner().clone();
    tauri::async_runtime::spawn_blocking(move || authority.reconcile_startup_roots(&roots))
        .await
        .map_err(|error| format!("startup project authority reconciliation failed: {error}"))?
}

#[cfg(mobile)]
#[tauri::command]
async fn native_project_open(
    _app: AppHandle,
    webview: tauri::Webview,
    _authority: State<'_, NativeProjectAuthority>,
    _default_path: Option<String>,
) -> Result<Option<String>, String> {
    ensure_trusted_project_caller(webview.label())?;
    Err("native project selection is unavailable on this platform".to_string())
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
    let path = platform::augmented_path().to_string_lossy().to_string();

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

#[derive(Debug, Serialize, Clone)]
pub struct BrowserPageLoadEvent {
    pub label: String,
    pub url: String,
    pub phase: String,
    pub navigation_token: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BrowserNavigationResult {
    terminal_url: String,
}

struct BrowserNavigationWaiter {
    generation: u64,
    token: String,
    requested_url: String,
    native_view: Option<usize>,
    navigation_identity: Option<u64>,
    completion: Option<tokio::sync::oneshot::Sender<Result<BrowserNavigationResult, String>>>,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct BrowserNavigationKey {
    label: String,
    generation: u64,
    token: String,
    native_view: usize,
    navigation_identity: u64,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
enum BrowserLinuxNavigationPhase {
    AwaitingStart,
    Started,
    Redirected(String),
    Committed(String),
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BrowserLinuxNavigationEvent {
    Started,
    Redirected,
    Committed,
    Finished,
    Failed,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
enum BrowserLinuxNavigationDecision {
    Pending,
    Complete(String),
    Reject(String),
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn browser_navigation_urls_equivalent(left: &str, right: &str) -> bool {
    fn is_unreserved(byte: u8) -> bool {
        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
    }

    fn hex_value(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    fn canonical_component(value: &str) -> String {
        const HEX: &[u8; 16] = b"0123456789ABCDEF";
        let input = value.as_bytes();
        let mut output = Vec::with_capacity(input.len());
        let mut index = 0;
        while index < input.len() {
            if input[index] == b'%' && index + 2 < input.len() {
                if let (Some(high), Some(low)) =
                    (hex_value(input[index + 1]), hex_value(input[index + 2]))
                {
                    let decoded = (high << 4) | low;
                    if is_unreserved(decoded) {
                        output.push(decoded);
                    } else {
                        output.extend_from_slice(&[
                            b'%',
                            HEX[(decoded >> 4) as usize],
                            HEX[(decoded & 0x0f) as usize],
                        ]);
                    }
                    index += 3;
                    continue;
                }
            }
            output.push(input[index]);
            index += 1;
        }
        String::from_utf8(output).unwrap_or_else(|_| value.to_string())
    }

    let (Ok(left), Ok(right)) = (Url::parse(left), Url::parse(right)) else {
        return left == right;
    };
    left.scheme() == right.scheme()
        && canonical_component(left.username()) == canonical_component(right.username())
        && left.password().map(canonical_component) == right.password().map(canonical_component)
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
        && canonical_component(left.path()) == canonical_component(right.path())
        && left.query().map(canonical_component) == right.query().map(canonical_component)
        && left.fragment().map(canonical_component) == right.fragment().map(canonical_component)
}

#[cfg(any(target_os = "linux", test))]
fn advance_browser_linux_navigation(
    phase: &mut BrowserLinuxNavigationPhase,
    event: BrowserLinuxNavigationEvent,
    observed_url: &str,
    requested_url: &str,
) -> BrowserLinuxNavigationDecision {
    const REPLACED: &str = "browser navigation was replaced before completion";
    const FAILED: &str = "browser navigation failed";
    const AMBIGUOUS: &str = "browser navigation signal order was ambiguous";

    match (phase.clone(), event) {
        (BrowserLinuxNavigationPhase::AwaitingStart, BrowserLinuxNavigationEvent::Started) => {
            if !browser_navigation_urls_equivalent(observed_url, requested_url) {
                BrowserLinuxNavigationDecision::Reject(REPLACED.to_string())
            } else {
                *phase = BrowserLinuxNavigationPhase::Started;
                BrowserLinuxNavigationDecision::Pending
            }
        }
        (
            BrowserLinuxNavigationPhase::AwaitingStart,
            BrowserLinuxNavigationEvent::Redirected
            | BrowserLinuxNavigationEvent::Committed
            | BrowserLinuxNavigationEvent::Finished
            | BrowserLinuxNavigationEvent::Failed,
        ) => BrowserLinuxNavigationDecision::Pending,
        (
            BrowserLinuxNavigationPhase::Started | BrowserLinuxNavigationPhase::Redirected(_),
            BrowserLinuxNavigationEvent::Redirected,
        ) if !observed_url.is_empty() => {
            *phase = BrowserLinuxNavigationPhase::Redirected(observed_url.to_string());
            BrowserLinuxNavigationDecision::Pending
        }
        (BrowserLinuxNavigationPhase::Started, BrowserLinuxNavigationEvent::Committed) => {
            if browser_navigation_urls_equivalent(observed_url, requested_url) {
                *phase = BrowserLinuxNavigationPhase::Committed(observed_url.to_string());
                BrowserLinuxNavigationDecision::Pending
            } else {
                BrowserLinuxNavigationDecision::Reject(AMBIGUOUS.to_string())
            }
        }
        (
            BrowserLinuxNavigationPhase::Redirected(ref redirected_url),
            BrowserLinuxNavigationEvent::Committed,
        ) => {
            if browser_navigation_urls_equivalent(observed_url, redirected_url) {
                *phase = BrowserLinuxNavigationPhase::Committed(observed_url.to_string());
                BrowserLinuxNavigationDecision::Pending
            } else {
                BrowserLinuxNavigationDecision::Reject(AMBIGUOUS.to_string())
            }
        }
        (
            BrowserLinuxNavigationPhase::Committed(ref committed_url),
            BrowserLinuxNavigationEvent::Finished,
        ) => {
            if browser_navigation_urls_equivalent(observed_url, committed_url) {
                BrowserLinuxNavigationDecision::Complete(observed_url.to_string())
            } else {
                BrowserLinuxNavigationDecision::Reject(AMBIGUOUS.to_string())
            }
        }
        (_, BrowserLinuxNavigationEvent::Started) => {
            BrowserLinuxNavigationDecision::Reject(REPLACED.to_string())
        }
        (_, BrowserLinuxNavigationEvent::Failed) => {
            BrowserLinuxNavigationDecision::Reject(FAILED.to_string())
        }
        _ => BrowserLinuxNavigationDecision::Reject(AMBIGUOUS.to_string()),
    }
}

#[cfg(target_os = "windows")]
struct BrowserWindowsNavigationRegistration {
    native_view: usize,
    generation: u64,
    token: String,
    requested_url: String,
    starting_token: i64,
    completed_token: i64,
    navigation_id: Option<u64>,
    armed: bool,
}

#[cfg(any(target_os = "windows", test))]
fn browser_windows_completion_matches(expected: Option<u64>, observed: u64) -> bool {
    expected == Some(observed)
}

#[cfg(target_os = "linux")]
struct BrowserLinuxNavigationRegistration {
    native_view: usize,
    generation: u64,
    token: String,
    sequence: u64,
    requested_url: String,
    load_changed_handler: libc::c_ulong,
    load_failed_handler: libc::c_ulong,
    load_failed_tls_handler: libc::c_ulong,
    phase: BrowserLinuxNavigationPhase,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTitleEvent {
    pub label: String,
    pub title: String,
    pub url: String,
    pub generation: u64,
    pub navigation_token: String,
}

struct BrowserNavigationWaiterGuard {
    label: String,
    token: String,
}

impl Drop for BrowserNavigationWaiterGuard {
    fn drop(&mut self) {
        let mut waiters = BROWSER_NAVIGATION_WAITERS.lock();
        if waiters
            .get(&self.label)
            .is_some_and(|waiter| waiter.token == self.token)
        {
            waiters.remove(&self.label);
        }
    }
}

static BROWSER_NAVIGATION_WAITERS: Lazy<Mutex<HashMap<String, BrowserNavigationWaiter>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn browser_documents_match_exact(left: &str, right: &str) -> bool {
    let Ok(left) = Url::parse(left) else {
        return false;
    };
    let Ok(right) = Url::parse(right) else {
        return false;
    };
    matches!(left.scheme(), "http" | "https" | "about") && left == right
}

fn retire_browser_authority_for_page_load(label: &str, current_url: &str) -> bool {
    let _ = current_url;
    if BROWSER_NAVIGATION_WAITERS.lock().contains_key(label) {
        return false;
    }
    let Some(identity) = browser_focus_identity(label) else {
        return false;
    };
    retire_matching_browser_focus_identity(label, &identity);
    true
}

fn ensure_live_browser_document_authority(
    label: &str,
    current_url: &str,
) -> Result<BrowserFocusIdentity, String> {
    let identity = browser_focus_identity(label)
        .ok_or_else(|| "browser document authority is unavailable".to_string())?;
    if !browser_documents_match_exact(&identity.document_url, current_url) {
        retire_matching_browser_focus_identity(label, &identity);
        return Err("browser document authority was replaced".to_string());
    }
    Ok(identity)
}

fn browser_document_authority_unchanged(
    expected_url: &str,
    expected_identity: &BrowserFocusIdentity,
    observed_url: &str,
    observed_identity: Option<&BrowserFocusIdentity>,
) -> bool {
    browser_documents_match_exact(expected_url, observed_url)
        && observed_identity == Some(expected_identity)
}

fn browser_title_identity(label: &str) -> Option<BrowserFocusIdentity> {
    {
        let waiters = BROWSER_NAVIGATION_WAITERS.lock();
        if let Some(waiter) = waiters.get(label) {
            return (waiter.native_view.is_some() && waiter.navigation_identity.is_some()).then(
                || BrowserFocusIdentity {
                    generation: waiter.generation,
                    navigation_token: waiter.token.clone(),
                    document_url: waiter.requested_url.clone(),
                },
            );
        }
    }
    browser_focus_identity(label)
}

#[cfg(target_os = "windows")]
static BROWSER_WINDOWS_NAVIGATIONS: Lazy<
    Mutex<HashMap<String, BrowserWindowsNavigationRegistration>>,
> = Lazy::new(|| Mutex::new(HashMap::new()));

#[cfg(target_os = "linux")]
static BROWSER_LINUX_NAVIGATIONS: Lazy<Mutex<HashMap<String, BrowserLinuxNavigationRegistration>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[cfg(target_os = "linux")]
static NEXT_BROWSER_LINUX_NAVIGATION_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn bind_browser_navigation_identity(
    label: &str,
    generation: u64,
    token: &str,
    native_view: usize,
    navigation_identity: u64,
) -> bool {
    let mut waiters = BROWSER_NAVIGATION_WAITERS.lock();
    let Some(waiter) = waiters.get_mut(label) else {
        return false;
    };
    if waiter.generation != generation
        || waiter.token != token
        || waiter
            .native_view
            .is_some_and(|identity| identity != native_view)
        || waiter
            .navigation_identity
            .is_some_and(|identity| identity != navigation_identity)
    {
        return false;
    }
    waiter.native_view = Some(native_view);
    waiter.navigation_identity = Some(navigation_identity);
    true
}

#[cfg(target_os = "windows")]
fn bind_browser_navigation_native_view(
    label: &str,
    generation: u64,
    token: &str,
    native_view: usize,
) -> bool {
    let mut waiters = BROWSER_NAVIGATION_WAITERS.lock();
    let Some(waiter) = waiters.get_mut(label) else {
        return false;
    };
    if waiter.generation != generation
        || waiter.token != token
        || waiter
            .native_view
            .is_some_and(|identity| identity != native_view)
    {
        return false;
    }
    waiter.native_view = Some(native_view);
    true
}

#[cfg(any(target_os = "macos", test))]
fn browser_navigation_key_for_native_identity(
    native_view: usize,
    navigation_identity: u64,
) -> Option<BrowserNavigationKey> {
    BROWSER_NAVIGATION_WAITERS
        .lock()
        .iter()
        .find_map(|(label, waiter)| {
            (waiter.native_view == Some(native_view)
                && waiter.navigation_identity == Some(navigation_identity))
            .then(|| BrowserNavigationKey {
                label: label.clone(),
                generation: waiter.generation,
                token: waiter.token.clone(),
                native_view,
                navigation_identity,
            })
        })
}

fn take_browser_navigation_waiter(
    label: &str,
    generation: u64,
    token: &str,
    native_view: usize,
    navigation_identity: Option<u64>,
) -> Option<BrowserNavigationWaiter> {
    let mut waiters = BROWSER_NAVIGATION_WAITERS.lock();
    let matches = waiters.get(label).is_some_and(|waiter| {
        waiter.generation == generation
            && waiter.token == token
            && waiter.native_view == Some(native_view)
            && navigation_identity
                .is_none_or(|identity| waiter.navigation_identity == Some(identity))
    });
    matches.then(|| waiters.remove(label)).flatten()
}

fn send_browser_navigation_result(
    label: &str,
    mut waiter: BrowserNavigationWaiter,
    result: Result<String, String>,
) -> bool {
    let Some(completion) = waiter.completion.take() else {
        return false;
    };
    let result = result.and_then(|terminal_url| {
        if terminal_url.is_empty() {
            Err("browser navigation terminal URL is unavailable".to_string())
        } else {
            Ok(BrowserNavigationResult { terminal_url })
        }
    });
    let focus_identity = result.as_ref().ok().map(|result| BrowserFocusIdentity {
        generation: waiter.generation,
        navigation_token: waiter.token.clone(),
        document_url: result.terminal_url.clone(),
    });
    if let Some(identity) = focus_identity.as_ref() {
        install_browser_focus_identity(label.to_string(), identity.clone());
    }
    if completion.send(result).is_err() {
        if let Some(identity) = focus_identity.as_ref() {
            retire_matching_browser_focus_identity(label, identity);
        }
    }
    true
}

fn resolve_browser_navigation(
    label: &str,
    generation: u64,
    token: &str,
    native_view: usize,
    navigation_identity: u64,
    result: Result<String, String>,
) -> bool {
    take_browser_navigation_waiter(
        label,
        generation,
        token,
        native_view,
        Some(navigation_identity),
    )
    .is_some_and(|waiter| send_browser_navigation_result(label, waiter, result))
}

#[cfg(target_os = "windows")]
fn reject_pending_browser_navigation(
    label: &str,
    generation: u64,
    token: &str,
    native_view: usize,
    error: String,
) -> bool {
    take_browser_navigation_waiter(label, generation, token, native_view, None)
        .is_some_and(|waiter| send_browser_navigation_result(label, waiter, Err(error)))
}

#[cfg(target_os = "macos")]
static ORIGINAL_BROWSER_DID_FINISH_NAVIGATION: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(target_os = "macos")]
static BROWSER_NAVIGATION_HOOK_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[cfg(target_os = "macos")]
unsafe extern "C-unwind" fn browser_did_finish_navigation(
    delegate: &AnyObject,
    selector: Sel,
    webview: &WKWebView,
    navigation: &WKNavigation,
) {
    let original = ORIGINAL_BROWSER_DID_FINISH_NAVIGATION.load(Ordering::Acquire);
    if original != 0 {
        let original: unsafe extern "C-unwind" fn(&AnyObject, Sel, &WKWebView, &WKNavigation) =
            unsafe { std::mem::transmute(original) };
        unsafe { original(delegate, selector, webview, navigation) };
    }
    let native_view = webview as *const WKWebView as usize;
    let navigation_identity = navigation as *const WKNavigation as u64;
    let terminal_url = unsafe { webview.URL() }
        .and_then(|url| url.absoluteString())
        .map(|url| url.to_string())
        .unwrap_or_default();
    if let Some(key) = browser_navigation_key_for_native_identity(native_view, navigation_identity)
    {
        resolve_browser_navigation(
            &key.label,
            key.generation,
            &key.token,
            key.native_view,
            key.navigation_identity,
            Ok(terminal_url),
        );
    }
}

#[cfg(target_os = "macos")]
fn install_browser_navigation_identity_hook(delegate: &AnyObject) -> Result<(), String> {
    let _install_guard = BROWSER_NAVIGATION_HOOK_LOCK.lock();
    if ORIGINAL_BROWSER_DID_FINISH_NAVIGATION.load(Ordering::Acquire) != 0 {
        return Ok(());
    }
    let class = delegate.class();
    let method = class
        .instance_method(sel!(webView:didFinishNavigation:))
        .ok_or_else(|| "browser navigation delegate finish hook is unavailable".to_string())?;
    let replacement: unsafe extern "C-unwind" fn(&AnyObject, Sel, &WKWebView, &WKNavigation) =
        browser_did_finish_navigation;
    let replacement: Imp = unsafe { std::mem::transmute(replacement) };
    let original = method.implementation() as usize;
    ORIGINAL_BROWSER_DID_FINISH_NAVIGATION.store(original, Ordering::Release);
    unsafe { method.set_implementation(replacement) };
    Ok(())
}

#[cfg(unix)]
fn set_cloexec(fd: RawFd) -> std::io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
fn duplicate_cloexec_fd(fd: RawFd) -> std::io::Result<OwnedFd> {
    let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicate < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
}

#[cfg(unix)]
fn create_cloexec_pipe() -> std::io::Result<(OwnedFd, OwnedFd)> {
    let mut descriptors = [-1; 2];
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let read = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    let write = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    set_cloexec(read.as_raw_fd())?;
    set_cloexec(write.as_raw_fd())?;
    Ok((read, write))
}

fn terminate_pty_session(session: PtySession) -> Result<PtyTerminationOutcome, String> {
    let termination = session.terminator.terminate();
    let reader_cancellation = session
        .reader_cancellation
        .cancel()
        .map_err(|error| format!("failed to cancel PTY reader: {error}"));
    session.pump.cancel();
    drop(session);
    match (termination, reader_cancellation) {
        (Ok(outcome), Ok(())) => Ok(outcome),
        (Err(termination_error), Ok(())) => Err(termination_error),
        (Ok(_), Err(cancellation_error)) => Err(cancellation_error),
        (Err(termination_error), Err(cancellation_error)) => {
            Err(format!("{termination_error}; {cancellation_error}"))
        }
    }
}

pub fn recent_pty_transport_snapshot(
    thread_id: &str,
    generation: u64,
) -> Option<FinalOutputPumpSnapshot> {
    RECENT_PTY_SNAPSHOTS
        .lock()
        .get(&TransportSessionKey::new(thread_id, generation))
        .cloned()
}

pub fn latest_pty_transport_snapshot(thread_id: &str) -> Option<FinalOutputPumpSnapshot> {
    RECENT_PTY_SNAPSHOTS
        .lock()
        .latest_for_thread(thread_id)
        .cloned()
}

fn validate_pty_thread_id(thread_id: &str) -> Result<(), String> {
    if is_safe_session_id(thread_id) {
        Ok(())
    } else {
        Err("thread id is unsafe".to_string())
    }
}

fn clone_live_pty_pump(
    thread_id: &str,
    expected_generation: Option<u64>,
) -> Result<OutputPump, String> {
    validate_pty_thread_id(thread_id)?;
    let guard = PTY_LIFECYCLES.lock();
    guard
        .live_with_generation(thread_id, expected_generation)
        .map(|session| session.pump.clone())
        .map_err(|error| error.to_string())
}

fn duration_to_micros(duration: std::time::Duration) -> u64 {
    duration.as_micros().min(u128::from(u64::MAX)) as u64
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum AckOutcome {
    Advanced {
        sequence: u64,
        bytes: usize,
        latency_micros: u64,
    },
    Duplicate {
        sequence: u64,
    },
}

impl From<TransportAckOutcome> for AckOutcome {
    fn from(outcome: TransportAckOutcome) -> Self {
        match outcome {
            TransportAckOutcome::Advanced {
                sequence,
                bytes,
                latency,
                ..
            } => Self::Advanced {
                sequence,
                bytes,
                latency_micros: duration_to_micros(latency),
            },
            TransportAckOutcome::Duplicate { sequence } => Self::Duplicate { sequence },
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum PtyTransportVisibility {
    Visible,
    Hidden,
}

impl From<TransportPaneVisibility> for PtyTransportVisibility {
    fn from(visibility: TransportPaneVisibility) -> Self {
        match visibility {
            TransportPaneVisibility::Visible => Self::Visible,
            TransportPaneVisibility::Hidden => Self::Hidden,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PtyTransportStateMetrics {
    bytes_accepted: u64,
    fragments_accepted: u64,
    bytes_emitted: u64,
    batches_emitted: u64,
    bytes_acknowledged: u64,
    batches_acknowledged: u64,
    push_would_block_count: u64,
    pending_bytes_high_water: usize,
    pending_fragments_high_water: usize,
    in_flight_batches_high_water: usize,
    in_flight_bytes_high_water: usize,
    total_ack_latency_micros: u64,
    max_ack_latency_micros: u64,
}

impl From<TransportPumpMetrics> for PtyTransportStateMetrics {
    fn from(metrics: TransportPumpMetrics) -> Self {
        Self {
            bytes_accepted: metrics.bytes_accepted,
            fragments_accepted: metrics.fragments_accepted,
            bytes_emitted: metrics.bytes_emitted,
            batches_emitted: metrics.batches_emitted,
            bytes_acknowledged: metrics.bytes_acknowledged,
            batches_acknowledged: metrics.batches_acknowledged,
            push_would_block_count: metrics.push_would_block_count,
            pending_bytes_high_water: metrics.pending_bytes_high_water,
            pending_fragments_high_water: metrics.pending_fragments_high_water,
            in_flight_batches_high_water: metrics.in_flight_batches_high_water,
            in_flight_bytes_high_water: metrics.in_flight_bytes_high_water,
            total_ack_latency_micros: duration_to_micros(metrics.total_ack_latency),
            max_ack_latency_micros: duration_to_micros(metrics.max_ack_latency),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PtyTransportMetrics {
    state: PtyTransportStateMetrics,
    blocked_reader_count: u64,
    total_blocked_reader_duration_micros: u64,
    max_blocked_reader_duration_micros: u64,
    emit_failure_count: u64,
    emit_retry_count: u64,
    visibility_transition_count: u64,
    drain_timeout_count: u64,
    worker_error_count: u64,
}

impl From<TransportOutputPumpMetrics> for PtyTransportMetrics {
    fn from(metrics: TransportOutputPumpMetrics) -> Self {
        Self {
            state: metrics.state.into(),
            blocked_reader_count: metrics.blocked_reader_count,
            total_blocked_reader_duration_micros: duration_to_micros(
                metrics.total_blocked_reader_duration,
            ),
            max_blocked_reader_duration_micros: duration_to_micros(
                metrics.max_blocked_reader_duration,
            ),
            emit_failure_count: metrics.emit_failure_count,
            emit_retry_count: metrics.emit_retry_count,
            visibility_transition_count: metrics.visibility_transition_count,
            drain_timeout_count: metrics.drain_timeout_count,
            worker_error_count: metrics.worker_error_count,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PtyTransportSnapshot {
    thread_id: String,
    pending_bytes: usize,
    pending_fragments: usize,
    queued_bytes: usize,
    queue_depth: usize,
    prepared: bool,
    in_flight_batches: usize,
    in_flight_bytes: usize,
    last_acked_sequence: u64,
    blocked_producers: usize,
    visibility: PtyTransportVisibility,
    effective_cadence_micros: u64,
    draining: bool,
    cancelled: bool,
    worker_running: bool,
    metrics: PtyTransportMetrics,
}

impl From<TransportOutputPumpSnapshot> for PtyTransportSnapshot {
    fn from(snapshot: TransportOutputPumpSnapshot) -> Self {
        Self {
            thread_id: snapshot.thread_id,
            pending_bytes: snapshot.pending_bytes,
            pending_fragments: snapshot.pending_fragments,
            queued_bytes: snapshot.queued_bytes,
            queue_depth: snapshot.queue_depth,
            prepared: snapshot.prepared,
            in_flight_batches: snapshot.in_flight_batches,
            in_flight_bytes: snapshot.in_flight_bytes,
            last_acked_sequence: snapshot.last_acked_sequence,
            blocked_producers: snapshot.blocked_producers,
            visibility: snapshot.visibility.into(),
            effective_cadence_micros: duration_to_micros(snapshot.effective_cadence),
            draining: snapshot.draining,
            cancelled: snapshot.cancelled,
            worker_running: snapshot.worker_running,
            metrics: snapshot.metrics.into(),
        }
    }
}

fn finish_pty_lifecycle(shutdown: &PtyExitShutdown) {
    if shutdown.exit_event_allowed && !PTY_LIFECYCLES.lock().finish_exit(&shutdown.token) {
        log::debug!(
            "PTY lifecycle entry was already finalized for '{}' generation {}",
            shutdown.token.thread_id,
            shutdown.token.generation,
        );
    }
}

#[cfg(debug_assertions)]
#[tauri::command]
async fn diagnostics_spawn_fixture(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, RuntimeDiagnosticsState>,
    thread_id: String,
    fixture: DiagnosticsFixture,
) -> Result<(), String> {
    ensure_trusted_pty_caller(webview.label())?;
    state.ensure_stress_authorized()?;
    let (options, fixture_launch) = fixture_start_request(&thread_id, fixture)?;

    match tauri::async_runtime::spawn_blocking(move || {
        pty_start_blocking_with_trusted_fixture(app, options, fixture_launch)
    })
    .await
    {
        Ok(result) => result.map(|_| ()),
        Err(error) => Err(format!("failed to join PTY start task: {error}")),
    }
}

#[cfg(debug_assertions)]
#[tauri::command]
async fn diagnostics_cycle_window(
    webview: tauri::Webview,
    state: State<'_, RuntimeDiagnosticsState>,
) -> Result<(), String> {
    ensure_trusted_pty_caller(webview.label())?;
    state.ensure_stress_authorized()?;
    let window = webview.window();
    window
        .minimize()
        .map_err(|error| format!("failed to minimize diagnostics window: {error}"))?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut cycle_result: Result<(), String> =
        Err("failed to restore diagnostics window: no restore attempt was made".to_string());
    for _attempt in 0..3 {
        cycle_result = window
            .unminimize()
            .map_err(|error| format!("failed to restore diagnostics window: {error}"))
            .and_then(|()| {
                window.set_focus().map_err(|error| {
                    format!("failed to focus restored diagnostics window: {error}")
                })
            });
        if cycle_result.is_ok() {
            return Ok(());
        }
    }
    if let Err(error) = cycle_result {
        let mut rollback_error: Option<String> = None;
        for _attempt in 0..3 {
            match window.unminimize().and_then(|()| window.set_focus()) {
                Ok(()) => return Err(format!("{error}; diagnostics window rollback succeeded")),
                Err(error) => rollback_error = Some(error.to_string()),
            }
        }
        return Err(format!(
            "{error}; failed to rollback diagnostics window state: {}",
            rollback_error.unwrap_or_else(|| "unknown rollback error".to_string()),
        ));
    }
    Ok(())
}

#[tauri::command]
async fn pty_write(
    webview: tauri::Webview,
    thread_id: String,
    generation: Option<u64>,
    bytes: Vec<u8>,
) -> Result<(), String> {
    ensure_trusted_pty_caller(webview.label())?;
    let (writer, operation_lane, operation_admission) =
        pty_write_operation(&thread_id, generation)?;
    let operation_permit = operation_admission
        .try_acquire_owned()
        .map_err(|_| format!("thread '{}' PTY operation queue is full", thread_id))?;
    let operation_guard = operation_lane.lock_owned().await;
    match tauri::async_runtime::spawn_blocking(move || {
        pty_write_blocking(writer, bytes, operation_guard, operation_permit)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => Err(format!("failed to join PTY write task: {error}")),
    }
}

fn pty_write_operation(
    thread_id: &str,
    expected_generation: Option<u64>,
) -> Result<
    (
        Arc<Mutex<Box<dyn Write + Send>>>,
        Arc<tokio::sync::Mutex<()>>,
        Arc<tokio::sync::Semaphore>,
    ),
    String,
> {
    let guard = PTY_LIFECYCLES.lock();
    let session = guard
        .live_with_generation(thread_id, expected_generation)
        .map_err(|error| error.to_string())?;
    let operation = (
        Arc::clone(&session.writer),
        Arc::clone(&session.operation_lane),
        Arc::clone(&session.operation_admission),
    );
    drop(guard);
    Ok(operation)
}

fn pty_write_blocking(
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    bytes: Vec<u8>,
    _operation_guard: tokio::sync::OwnedMutexGuard<()>,
    _operation_permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<(), String> {
    let mut writer = writer.lock();
    writer.write_all(&bytes).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn pty_resize(
    webview: tauri::Webview,
    thread_id: String,
    generation: Option<u64>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    ensure_trusted_pty_caller(webview.label())?;
    let Some((master, operation_lane, operation_admission)) =
        pty_resize_operation(&thread_id, generation)?
    else {
        return Ok(());
    };
    let operation_permit = operation_admission
        .try_acquire_owned()
        .map_err(|_| format!("thread '{}' PTY operation queue is full", thread_id))?;
    let operation_guard = operation_lane.lock_owned().await;
    match tauri::async_runtime::spawn_blocking(move || {
        pty_resize_blocking(master, cols, rows, operation_guard, operation_permit)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => Err(format!("failed to join PTY resize task: {error}")),
    }
}

fn pty_resize_operation(
    thread_id: &str,
    expected_generation: Option<u64>,
) -> Result<
    Option<(
        Arc<Mutex<Box<dyn MasterPty + Send>>>,
        Arc<tokio::sync::Mutex<()>>,
        Arc<tokio::sync::Semaphore>,
    )>,
    String,
> {
    validate_pty_thread_id(thread_id)?;
    let guard = PTY_LIFECYCLES.lock();
    let operation = match guard.live_with_generation(thread_id, expected_generation) {
        Ok(session) => Some((
            Arc::clone(&session.master),
            Arc::clone(&session.operation_lane),
            Arc::clone(&session.operation_admission),
        )),
        Err(PtyLifecycleError::NotFound { .. }) => None,
        Err(error) => return Err(error.to_string()),
    };
    drop(guard);
    Ok(operation)
}

fn pty_resize_blocking(
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    cols: u16,
    rows: u16,
    _operation_guard: tokio::sync::OwnedMutexGuard<()>,
    _operation_permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<(), String> {
    master
        .lock()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyStopResult {
    thread_id: String,
    generation: u64,
    state: &'static str,
    termination_scope: Option<String>,
}

#[tauri::command]
fn pty_stop(
    webview: tauri::Webview,
    thread_id: String,
    generation: Option<u64>,
) -> Result<PtyStopResult, String> {
    ensure_trusted_pty_caller(webview.label())?;
    let action = {
        let mut registry = PTY_LIFECYCLES.lock();
        registry
            .stop(&thread_id, generation)
            .map_err(|error| error.to_string())?
    };
    match action {
        StopSessionOutcome::RecordedDuringStart { generation } => Ok(PtyStopResult {
            thread_id,
            generation,
            state: "recorded-during-start",
            termination_scope: None,
        }),
        StopSessionOutcome::Terminate {
            generation,
            session,
        } => {
            let outcome = terminate_pty_session(session)?;
            Ok(PtyStopResult {
                thread_id,
                generation,
                state: "termination-requested",
                termination_scope: Some(format!("{outcome:?}")),
            })
        }
    }
}

#[tauri::command]
fn pty_current_generation(webview: tauri::Webview, thread_id: String) -> Result<u64, String> {
    ensure_trusted_pty_caller(webview.label())?;
    validate_pty_thread_id(&thread_id)?;
    PTY_LIFECYCLES
        .lock()
        .current_generation(&thread_id)
        .ok_or_else(|| format!("thread '{}' not found", thread_id))
}

#[tauri::command]
fn pty_ack(
    webview: tauri::Webview,
    thread_id: String,
    sequence: u64,
    generation: Option<u64>,
) -> Result<AckOutcome, String> {
    ensure_trusted_pty_caller(webview.label())?;
    pty_ack_inner(thread_id, sequence, generation)
}

fn pty_ack_inner(
    thread_id: String,
    sequence: u64,
    generation: Option<u64>,
) -> Result<AckOutcome, String> {
    let pump = clone_live_pty_pump(&thread_id, generation)?;
    pump.acknowledge(sequence)
        .map(AckOutcome::from)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn pty_set_visibility(
    webview: tauri::Webview,
    thread_id: String,
    visible: bool,
    generation: Option<u64>,
) -> Result<(), String> {
    ensure_trusted_pty_caller(webview.label())?;
    pty_set_visibility_inner(thread_id, visible, generation)
}

fn pty_set_visibility_inner(
    thread_id: String,
    visible: bool,
    generation: Option<u64>,
) -> Result<(), String> {
    let pump = clone_live_pty_pump(&thread_id, generation)?;
    pump.set_visibility(if visible {
        TransportPaneVisibility::Visible
    } else {
        TransportPaneVisibility::Hidden
    });
    Ok(())
}

#[tauri::command]
fn pty_list(webview: tauri::Webview) -> Result<Vec<String>, String> {
    ensure_trusted_pty_caller(webview.label())?;
    Ok(PTY_LIFECYCLES.lock().live_thread_ids())
}

#[tauri::command]
fn pty_transport_metrics(
    webview: tauri::Webview,
    thread_id: Option<String>,
) -> Result<Vec<PtyTransportSnapshot>, String> {
    ensure_trusted_pty_caller(webview.label())?;
    Ok(pty_transport_metrics_inner(thread_id))
}

fn pty_transport_metrics_inner(thread_id: Option<String>) -> Vec<PtyTransportSnapshot> {
    let pumps = match thread_id {
        Some(thread_id) => {
            if validate_pty_thread_id(&thread_id).is_err() {
                return Vec::new();
            }
            let guard = PTY_LIFECYCLES.lock();
            guard
                .live(&thread_id)
                .map(|session| vec![session.pump.clone()])
                .unwrap_or_default()
        }
        None => {
            let guard = PTY_LIFECYCLES.lock();
            guard
                .live_sessions()
                .into_iter()
                .map(|(_, session)| session.pump.clone())
                .collect::<Vec<_>>()
        }
    };
    let mut snapshots = pumps
        .into_iter()
        .map(|pump| PtyTransportSnapshot::from(pump.snapshot()))
        .collect::<Vec<_>>();
    snapshots.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
    snapshots
}

#[tauri::command]
async fn workspace_metrics(
    state: State<'_, MetricsState>,
    scope: Option<MetricsScope>,
) -> Result<MetricsSnapshot, String> {
    let tracked_sessions = {
        let guard = PTY_LIFECYCLES.lock();
        guard
            .live_sessions()
            .into_iter()
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

#[derive(Clone, Serialize)]
struct BrowserAppShortcutPayload {
    label: String,
    url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserAutomationResultError {
    code: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserAutomationCorrelation {
    action_id: String,
    tab_id: String,
    generation: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserAutomationSuccessResult {
    action_id: String,
    tab_id: String,
    generation: u64,
    value: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserAutomationFailureResult {
    action_id: String,
    tab_id: String,
    generation: u64,
    error: BrowserAutomationResultError,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum BrowserAutomationResultPayload {
    Success(BrowserAutomationSuccessResult),
    Failure(BrowserAutomationFailureResult),
}

#[derive(Default)]
struct BrowserAutomationAuthorizations {
    by_label: Mutex<HashMap<String, BrowserAutomationCorrelation>>,
}

impl BrowserAutomationAuthorizations {
    fn install(&self, label: &str, correlation: BrowserAutomationCorrelation) {
        self.by_label.lock().insert(label.to_string(), correlation);
    }

    fn consume(&self, label: &str, correlation: &BrowserAutomationCorrelation) -> bool {
        let mut authorizations = self.by_label.lock();
        if authorizations.get(label) != Some(correlation) {
            return false;
        }
        authorizations.remove(label);
        true
    }

    fn remove(&self, label: &str) -> bool {
        self.by_label.lock().remove(label).is_some()
    }
}

impl BrowserAutomationResultPayload {
    fn correlation(&self) -> BrowserAutomationCorrelation {
        match self {
            Self::Success(result) => BrowserAutomationCorrelation {
                action_id: result.action_id.clone(),
                tab_id: result.tab_id.clone(),
                generation: result.generation,
            },
            Self::Failure(result) => BrowserAutomationCorrelation {
                action_id: result.action_id.clone(),
                tab_id: result.tab_id.clone(),
                generation: result.generation,
            },
        }
    }

    fn validate(&self) -> Result<(), String> {
        let correlation = self.correlation();
        if correlation.action_id.is_empty()
            || correlation.action_id.len() > 128
            || correlation.tab_id.is_empty()
            || correlation.tab_id.len() > 128
        {
            return Err("browser automation result correlation is invalid".to_string());
        }
        if correlation.generation > 9_007_199_254_740_991 {
            return Err("browser automation result generation is invalid".to_string());
        }
        if let Self::Failure(result) = self {
            const ALLOWED_CODES: &[&str] = &[
                "action_cancelled",
                "automation_failed",
                "backend_unavailable",
                "bad_request",
                "effect_unknown",
                "ref_missing",
                "result_too_large",
                "serialization_failed",
                "snapshot_stale",
                "target_changed",
                "target_unavailable",
                "unsupported_operation",
            ];
            if !ALLOWED_CODES.contains(&result.error.code.as_str()) {
                return Err("browser automation result error code is invalid".to_string());
            }
        }
        let encoded = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        if encoded.len() > MAX_PROVIDER_RESULT_BYTES {
            return Err("browser automation result is too large".to_string());
        }
        Ok(())
    }
}

#[derive(Debug)]
struct BrowserShortcutAuthorization {
    initial_secret: String,
    current_secret: String,
    last_accepted: Option<Instant>,
}

#[derive(Default)]
struct BrowserShortcutAuthorizations {
    by_label: Mutex<HashMap<String, BrowserShortcutAuthorization>>,
}

impl BrowserShortcutAuthorizations {
    fn install(&self, label: &str, initial_secret: String) {
        self.by_label.lock().insert(
            label.to_string(),
            BrowserShortcutAuthorization {
                current_secret: initial_secret.clone(),
                initial_secret,
                last_accepted: None,
            },
        );
    }

    fn reset(&self, label: &str) -> bool {
        let mut authorizations = self.by_label.lock();
        let Some(authorization) = authorizations.get_mut(label) else {
            return false;
        };
        authorization.current_secret = authorization.initial_secret.clone();
        authorization.last_accepted = None;
        true
    }

    fn remove(&self, label: &str) -> bool {
        self.by_label.lock().remove(label).is_some()
    }

    fn authorize_and_rotate<GenerateSecret, Dispatch>(
        &self,
        label: &str,
        supplied_secret: &str,
        now: Instant,
        generate_secret: GenerateSecret,
        dispatch: Dispatch,
    ) -> Result<String, String>
    where
        GenerateSecret: FnOnce() -> Result<String, String>,
        Dispatch: FnOnce() -> Result<(), String>,
    {
        if !label.starts_with(BROWSER_LABEL_PREFIX) {
            return Err(
                "browser app shortcut caller is not an embedded browser webview".to_string(),
            );
        }

        let mut authorizations = self.by_label.lock();
        let authorization = authorizations
            .get_mut(label)
            .ok_or_else(|| "browser app shortcut authorization is missing".to_string())?;
        if !browser_shortcut_secrets_match(&authorization.current_secret, supplied_secret) {
            return Err("browser app shortcut secret is invalid".to_string());
        }
        if authorization.last_accepted.is_some_and(|last_accepted| {
            now.saturating_duration_since(last_accepted) < MIN_BROWSER_SHORTCUT_INTERVAL
        }) {
            return Err("browser app shortcut rate limit exceeded".to_string());
        }

        let next_secret = generate_secret()?;
        if next_secret.is_empty()
            || browser_shortcut_secrets_match(&authorization.current_secret, &next_secret)
        {
            return Err("browser app shortcut secret rotation failed".to_string());
        }
        dispatch()?;
        authorization.current_secret = next_secret.clone();
        authorization.last_accepted = Some(now);
        Ok(next_secret)
    }
}

fn browser_shortcut_secrets_match(expected: &str, supplied: &str) -> bool {
    expected.len() == supplied.len()
        && expected
            .bytes()
            .zip(supplied.bytes())
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0
}

fn random_browser_shortcut_secret() -> Result<String, String> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("failed to generate browser shortcut secret: {error}"))?;
    let mut secret = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        secret.push(HEX[(byte >> 4) as usize] as char);
        secret.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(secret)
}

fn browser_shortcut_initialization_script(initial_secret: &str) -> Result<String, String> {
    let secret_json = serde_json::to_string(initial_secret).map_err(|error| error.to_string())?;
    Ok(r#"(function(initialSecret) {
          try {
            if (window.top !== window) return;
            var core = window.__TAURI__ && window.__TAURI__.core;
            if (!core || typeof core.invoke !== "function") return;
            var invoke = core.invoke;
            var promiseThen = Promise.prototype.then;
            var reflectApply = Reflect.apply;
            var stringToLowerCase = String.prototype.toLowerCase;
            var secret = initialSecret;
            window.addEventListener("keydown", function(event) {
              try {
                if (event.isTrusted !== true || event.repeat) return;
                var key = event.key ? reflectApply(stringToLowerCase, event.key, []) : "";
                var primary = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
                var shortcut = "";
                if ((event.metaKey || event.ctrlKey) && key === "t") {
                  shortcut = "terminal-pane";
                } else if (primary && key === "d") {
                  shortcut = "agent-pane";
                } else if (primary && key === "f") {
                  shortcut = "composer";
                } else {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                var pending = reflectApply(invoke, core, [
                  "browser_app_shortcut",
                  { shortcut: shortcut, url: location.href, secret: secret }
                ]);
                reflectApply(promiseThen, pending, [
                  function(nextSecret) {
                    if (typeof nextSecret === "string" && nextSecret) {
                      secret = nextSecret;
                    }
                  },
                  function() {}
                ]);
              } catch (_) {}
            }, true);
          } catch (_) {}
        })(__PSYCHE_BROWSER_SHORTCUT_INITIAL_SECRET__);"#
        .replace("__PSYCHE_BROWSER_SHORTCUT_INITIAL_SECRET__", &secret_json))
}

fn resolve_browser_app_shortcut(label: &str, shortcut: &str) -> Result<&'static str, String> {
    if !label.starts_with(BROWSER_LABEL_PREFIX) {
        return Err("browser app shortcut caller is not an embedded browser webview".to_string());
    }

    match shortcut {
        "terminal-pane" => Ok("browser:shortcut-terminal-pane"),
        "agent-pane" => Ok("browser:shortcut-agent-pane"),
        "composer" => Ok("browser:shortcut-composer"),
        _ => Err(format!("unknown browser app shortcut: {shortcut}")),
    }
}

#[tauri::command]
fn browser_app_shortcut(
    webview: tauri::Webview,
    authorizations: State<'_, BrowserShortcutAuthorizations>,
    shortcut: String,
    url: String,
    secret: String,
) -> Result<String, String> {
    let event = resolve_browser_app_shortcut(webview.label(), &shortcut)?;
    authorizations.authorize_and_rotate(
        webview.label(),
        &secret,
        Instant::now(),
        random_browser_shortcut_secret,
        || {
            let main = webview
                .app_handle()
                .get_webview("main")
                .ok_or_else(|| "main webview missing".to_string())?;
            main.set_focus().map_err(|error| error.to_string())?;
            webview
                .app_handle()
                .emit_to(
                    "main",
                    event,
                    BrowserAppShortcutPayload {
                        label: webview.label().to_string(),
                        url,
                    },
                )
                .map_err(|error| error.to_string())
        },
    )
}

#[tauri::command]
fn browser_automation_result(
    webview: tauri::Webview,
    authorizations: State<'_, BrowserAutomationAuthorizations>,
    result: BrowserAutomationResultPayload,
) -> Result<(), String> {
    if !webview.label().starts_with(BROWSER_LABEL_PREFIX) {
        return Err(
            "browser automation result caller is not an embedded browser webview".to_string(),
        );
    }
    result.validate()?;
    if !authorizations.consume(webview.label(), &result.correlation()) {
        return Err("browser automation result does not match a pending action".to_string());
    }
    webview
        .app_handle()
        .emit_to("main", "browser:automation-result", result)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn browser_report_title(webview: tauri::Webview, title: String) -> Result<(), String> {
    if !webview.label().starts_with(BROWSER_LABEL_PREFIX) {
        return Err("browser title caller is not an embedded browser webview".to_string());
    }
    let title = title.trim();
    if title.is_empty() || title.len() > 4096 {
        return Err("browser title is invalid".to_string());
    }
    let url = webview
        .url()
        .map_err(|error| error.to_string())?
        .to_string();
    let identity = browser_title_identity(webview.label())
        .ok_or_else(|| "browser title has no live native navigation identity".to_string())?;
    webview
        .app_handle()
        .emit_to(
            "main",
            "browser:title",
            BrowserTitleEvent {
                label: webview.label().to_string(),
                title: title.to_string(),
                url,
                generation: identity.generation,
                navigation_token: identity.navigation_token,
            },
        )
        .map_err(|error| error.to_string())
}

fn browser_title_initialization_script() -> String {
    r#"(function() {
          try {
            if (window.top !== window) return;
            var core = window.__TAURI__ && window.__TAURI__.core;
            if (!core || typeof core.invoke !== "function") return;
            var invoke = core.invoke;
            var reflectApply = Reflect.apply;
            var reportTitle = function() {
              try {
                var title = document.title || location.hostname || location.href;
                reflectApply(invoke, core, [
                  "browser_report_title",
                  { title: title }
                ]);
              } catch (_) {}
            };
            if (document.readyState === "loading") {
              document.addEventListener("DOMContentLoaded", reportTitle, { once: true });
            } else {
              reportTitle();
            }
          } catch (_) {}
        })();"#
        .to_string()
}

fn ensure_browser(
    app: &AppHandle,
    label: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    _url: &str,
    automation_source: &str,
) -> Result<bool, String> {
    if app.webviews().keys().any(|existing| existing == label) {
        return Ok(false);
    }

    let main = app
        .get_window("main")
        .ok_or_else(|| "main window missing".to_string())?;

    let initial_url = Url::parse("about:blank").map_err(|e| e.to_string())?;
    let initial_secret = random_browser_shortcut_secret()?;
    let shortcut_script = browser_shortcut_initialization_script(&initial_secret)?;
    let title_script = browser_title_initialization_script();
    app.state::<BrowserShortcutAuthorizations>()
        .install(label, initial_secret.clone());
    let browser_label = label.to_string();
    let app_for_load = app.clone();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(initial_url))
        .initialization_script(shortcut_script)
        .initialization_script(title_script)
        .initialization_script(automation_source)
        .on_page_load(move |_webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Started) {
                app_for_load
                    .state::<BrowserShortcutAuthorizations>()
                    .reset(&browser_label);
                app_for_load
                    .state::<BrowserAutomationAuthorizations>()
                    .remove(&browser_label);
                retire_browser_authority_for_page_load(&browser_label, payload.url().as_str());
            }
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            // Wry's page-load callback omits native navigation identity.
            // Controlled navigation therefore never attaches its token here.
            let navigation_token = None;
            let _ = app_for_load.emit(
                "browser:page-load",
                BrowserPageLoadEvent {
                    label: browser_label.clone(),
                    url: payload.url().to_string(),
                    phase: phase.to_string(),
                    navigation_token,
                },
            );
        });

    if let Err(error) = main.add_child(
        builder,
        LogicalPosition::new(x, y),
        LogicalSize::new(w.max(1.0), h.max(1.0)),
    ) {
        app.state::<BrowserShortcutAuthorizations>().remove(label);
        return Err(error.to_string());
    }

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

fn cleanup_created_browser_after_setup_failure(
    created: bool,
    close: impl FnOnce() -> Result<(), String>,
) {
    if created {
        let _ = close();
    }
}

#[cfg(target_os = "windows")]
fn take_windows_browser_navigation(
    label: &str,
    generation: u64,
    token: &str,
    native_view: usize,
) -> Option<BrowserWindowsNavigationRegistration> {
    let mut registrations = BROWSER_WINDOWS_NAVIGATIONS.lock();
    let matches = registrations.get(label).is_some_and(|registration| {
        registration.generation == generation
            && registration.token == token
            && registration.native_view == native_view
    });
    matches.then(|| registrations.remove(label)).flatten()
}

#[cfg(target_os = "windows")]
fn disconnect_windows_browser_navigation_handlers(
    webview: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    registration: &BrowserWindowsNavigationRegistration,
) {
    let _ = unsafe { webview.remove_NavigationStarting(registration.starting_token) };
    let _ = unsafe { webview.remove_NavigationCompleted(registration.completed_token) };
}

#[cfg(target_os = "windows")]
fn detach_browser_navigation_callbacks(webview: &tauri::Webview, label: &str) {
    let registration = BROWSER_WINDOWS_NAVIGATIONS.lock().remove(label);
    let Some(registration) = registration else {
        return;
    };
    let _ = webview.with_webview(move |platform_webview| {
        let controller = platform_webview.controller();
        if let Ok(native_webview) = unsafe { controller.CoreWebView2() } {
            if native_webview.as_raw() as usize == registration.native_view {
                disconnect_windows_browser_navigation_handlers(&native_webview, &registration);
            }
        }
    });
}

#[cfg(target_os = "linux")]
fn take_linux_browser_navigation(
    label: &str,
    generation: u64,
    token: &str,
    native_view: usize,
) -> Option<BrowserLinuxNavigationRegistration> {
    let mut registrations = BROWSER_LINUX_NAVIGATIONS.lock();
    let matches = registrations.get(label).is_some_and(|registration| {
        registration.generation == generation
            && registration.token == token
            && registration.native_view == native_view
    });
    matches.then(|| registrations.remove(label)).flatten()
}

#[cfg(target_os = "linux")]
fn linux_browser_webview_pointer(
    webview: &webkit2gtk::WebView,
) -> *mut webkit2gtk::ffi::WebKitWebView {
    <webkit2gtk::WebView as ToGlibPtr<'_, *mut webkit2gtk::ffi::WebKitWebView>>::to_glib_none(
        webview,
    )
    .0
}

#[cfg(target_os = "linux")]
fn linux_browser_webview_identity(webview: &webkit2gtk::WebView) -> usize {
    linux_browser_webview_pointer(webview) as usize
}

#[cfg(target_os = "linux")]
fn disconnect_linux_browser_navigation_signals(
    webview: &webkit2gtk::WebView,
    registration: &BrowserLinuxNavigationRegistration,
) {
    let pointer = linux_browser_webview_pointer(webview);
    let object = pointer.cast::<glib::gobject_ffi::GObject>();
    for handler in [
        registration.load_changed_handler,
        registration.load_failed_handler,
        registration.load_failed_tls_handler,
    ] {
        unsafe {
            glib::gobject_ffi::g_signal_handler_disconnect(object, handler);
        }
    }
}

#[cfg(target_os = "linux")]
fn detach_browser_navigation_callbacks(webview: &tauri::Webview, label: &str) {
    let registration = BROWSER_LINUX_NAVIGATIONS.lock().remove(label);
    let Some(registration) = registration else {
        return;
    };
    let _ = webview.with_webview(move |platform_webview| {
        let native_webview = platform_webview.inner();
        if linux_browser_webview_identity(&native_webview) == registration.native_view {
            disconnect_linux_browser_navigation_signals(&native_webview, &registration);
        }
    });
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn detach_browser_navigation_callbacks(_webview: &tauri::Webview, _label: &str) {}

fn close_browser_webview_transactionally(
    close: impl FnOnce() -> Result<(), String>,
    retire: impl FnOnce(),
) -> Result<(), String> {
    close()?;
    retire();
    Ok(())
}

fn retire_browser_webview_for_navigation(app: &AppHandle, label: &str) -> Result<(), String> {
    if let Some(webview) = app.get_webview(label) {
        close_browser_webview_transactionally(
            || webview.close().map_err(|error| error.to_string()),
            || {
                detach_browser_navigation_callbacks(&webview, label);
                detach_browser_native_focus_callback(&webview);
                retire_browser_focus_label(label);
            },
        )?;
    } else {
        retire_browser_focus_label(label);
    }
    app.state::<BrowserShortcutAuthorizations>().remove(label);
    app.state::<BrowserAutomationAuthorizations>().remove(label);
    Ok(())
}

#[cfg(target_os = "macos")]
async fn start_browser_navigation(
    webview: &tauri::Webview,
    label: &str,
    url: &str,
    generation: u64,
    token: &str,
) -> Result<(), String> {
    let label = label.to_string();
    let url = url.to_string();
    let token = token.to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| unsafe {
            let result = (|| {
                let wk_webview = &*(platform_webview.inner().cast::<WKWebView>());
                let delegate = wk_webview
                    .navigationDelegate()
                    .ok_or_else(|| "browser navigation delegate is unavailable".to_string())?;
                let delegate_object = &*((&*delegate) as *const _ as *const AnyObject);
                install_browser_navigation_identity_hook(delegate_object)?;
                let url_string = NSString::from_str(&url);
                let native_url = NSURL::URLWithString(&url_string)
                    .ok_or_else(|| "browser navigation URL is invalid".to_string())?;
                let request = NSURLRequest::requestWithURL(&native_url);
                let navigation = wk_webview
                    .loadRequest(&request)
                    .ok_or_else(|| "browser navigation did not start".to_string())?;
                let native_view = wk_webview as *const WKWebView as usize;
                let navigation_identity = (&*navigation) as *const WKNavigation as u64;
                if !bind_browser_navigation_identity(
                    &label,
                    generation,
                    &token,
                    native_view,
                    navigation_identity,
                ) {
                    return Err("browser navigation waiter was replaced".to_string());
                }
                Ok(())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "browser navigation setup was cancelled".to_string())?
}

#[cfg(target_os = "windows")]
async fn start_browser_navigation(
    webview: &tauri::Webview,
    label: &str,
    url: &str,
    generation: u64,
    token: &str,
) -> Result<(), String> {
    let label = label.to_string();
    let url = url.to_string();
    let token = token.to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = (|| {
                let controller = platform_webview.controller();
                let native_webview =
                    unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
                let native_view = native_webview.as_raw() as usize;
                if !bind_browser_navigation_native_view(&label, generation, &token, native_view) {
                    return Err("browser navigation waiter was replaced".to_string());
                }

                let starting_label = label.clone();
                let starting_token = token.clone();
                let starting = NavigationStartingEventHandler::create(Box::new(
                    move |callback_webview, args| {
                        let Some(callback_webview) = callback_webview else {
                            return Ok(());
                        };
                        let callback_view = callback_webview.as_raw() as usize;
                        if callback_view != native_view {
                            return Ok(());
                        }
                        let event = (|| {
                            let args = args.ok_or_else(|| {
                                "browser navigation starting arguments are unavailable".to_string()
                            })?;
                            let mut uri = PWSTR::null();
                            unsafe { args.Uri(&mut uri) }.map_err(|error| error.to_string())?;
                            let uri = take_pwstr(uri);
                            let mut navigation_id = 0;
                            unsafe { args.NavigationId(&mut navigation_id) }
                                .map_err(|error| error.to_string())?;
                            let mut redirected = Default::default();
                            unsafe { args.IsRedirected(&mut redirected) }
                                .map_err(|error| error.to_string())?;
                            Ok::<_, String>((uri, navigation_id, redirected.as_bool()))
                        })();

                        let mut rejection = None;
                        let mut claimed_navigation = None;
                        match event {
                            Ok((uri, navigation_id, redirected)) => {
                                let mut registrations = BROWSER_WINDOWS_NAVIGATIONS.lock();
                                let Some(registration) = registrations.get_mut(&starting_label)
                                else {
                                    return Ok(());
                                };
                                if registration.generation != generation
                                    || registration.token != starting_token
                                    || registration.native_view != callback_view
                                    || !registration.armed
                                {
                                    return Ok(());
                                }
                                if let Some(expected_id) = registration.navigation_id {
                                    if expected_id != navigation_id {
                                        rejection = Some(
                                            "browser navigation was replaced before completion"
                                                .to_string(),
                                        );
                                    }
                                } else if redirected {
                                    rejection = Some(
                                        "browser navigation redirect identity was ambiguous"
                                            .to_string(),
                                    );
                                } else if !browser_navigation_urls_equivalent(
                                    &uri,
                                    &registration.requested_url,
                                ) {
                                    rejection = Some(
                                        "browser navigation was replaced before completion"
                                            .to_string(),
                                    );
                                } else {
                                    registration.navigation_id = Some(navigation_id);
                                    claimed_navigation = Some(navigation_id);
                                }
                            }
                            Err(error) => rejection = Some(error),
                        }

                        if let Some(navigation_id) = claimed_navigation {
                            if !bind_browser_navigation_identity(
                                &starting_label,
                                generation,
                                &starting_token,
                                callback_view,
                                navigation_id,
                            ) {
                                rejection =
                                    Some("browser navigation waiter was replaced".to_string());
                            }
                        }
                        if let Some(error) = rejection {
                            if let Some(registration) = take_windows_browser_navigation(
                                &starting_label,
                                generation,
                                &starting_token,
                                callback_view,
                            ) {
                                disconnect_windows_browser_navigation_handlers(
                                    &callback_webview,
                                    &registration,
                                );
                            }
                            reject_pending_browser_navigation(
                                &starting_label,
                                generation,
                                &starting_token,
                                callback_view,
                                error,
                            );
                        }
                        Ok(())
                    },
                ));

                let completed_label = label.clone();
                let completed_navigation_token = token.clone();
                let completed = NavigationCompletedEventHandler::create(Box::new(
                    move |callback_webview, args| {
                        let Some(callback_webview) = callback_webview else {
                            return Ok(());
                        };
                        let callback_view = callback_webview.as_raw() as usize;
                        if callback_view != native_view {
                            return Ok(());
                        }
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let mut navigation_id = 0;
                        if unsafe { args.NavigationId(&mut navigation_id) }.is_err() {
                            return Ok(());
                        }
                        let event = (|| {
                            let mut succeeded = Default::default();
                            unsafe { args.IsSuccess(&mut succeeded) }
                                .map_err(|error| error.to_string())?;
                            let mut web_error_status = Default::default();
                            unsafe { args.WebErrorStatus(&mut web_error_status) }
                                .map_err(|error| error.to_string())?;
                            let mut source = PWSTR::null();
                            unsafe { callback_webview.Source(&mut source) }
                                .map_err(|error| error.to_string())?;
                            Ok::<_, String>((
                                succeeded.as_bool(),
                                web_error_status.0,
                                take_pwstr(source),
                            ))
                        })();

                        let expected_navigation_id = BROWSER_WINDOWS_NAVIGATIONS
                            .lock()
                            .get(&completed_label)
                            .filter(|registration| {
                                registration.generation == generation
                                    && registration.token == completed_navigation_token
                                    && registration.native_view == callback_view
                                    && registration.armed
                            })
                            .and_then(|registration| registration.navigation_id);
                        if !browser_windows_completion_matches(
                            expected_navigation_id,
                            navigation_id,
                        ) {
                            return Ok(());
                        }
                        let Some(registration) = take_windows_browser_navigation(
                            &completed_label,
                            generation,
                            &completed_navigation_token,
                            callback_view,
                        ) else {
                            return Ok(());
                        };
                        disconnect_windows_browser_navigation_handlers(
                            &callback_webview,
                            &registration,
                        );

                        match event {
                            Ok((succeeded, status, terminal_url)) => {
                                let result = if succeeded {
                                    Ok(terminal_url)
                                } else {
                                    Err(format!(
                                        "browser navigation failed with WebView2 status {status}"
                                    ))
                                };
                                resolve_browser_navigation(
                                    &completed_label,
                                    generation,
                                    &completed_navigation_token,
                                    callback_view,
                                    navigation_id,
                                    result,
                                );
                            }
                            Err(error) => {
                                reject_pending_browser_navigation(
                                    &completed_label,
                                    generation,
                                    &completed_navigation_token,
                                    callback_view,
                                    error,
                                );
                            }
                        }
                        Ok(())
                    },
                ));

                let mut starting_registration_token = 0;
                unsafe {
                    native_webview
                        .add_NavigationStarting(&starting, &mut starting_registration_token)
                }
                .map_err(|error| error.to_string())?;
                let mut completed_registration_token = 0;
                if let Err(error) = unsafe {
                    native_webview
                        .add_NavigationCompleted(&completed, &mut completed_registration_token)
                } {
                    let _ = unsafe {
                        native_webview.remove_NavigationStarting(starting_registration_token)
                    };
                    return Err(error.to_string());
                }

                BROWSER_WINDOWS_NAVIGATIONS.lock().insert(
                    label.clone(),
                    BrowserWindowsNavigationRegistration {
                        native_view,
                        generation,
                        token: token.clone(),
                        requested_url: url.clone(),
                        starting_token: starting_registration_token,
                        completed_token: completed_registration_token,
                        navigation_id: None,
                        armed: true,
                    },
                );
                let native_url = CoTaskMemPWSTR::from(url.as_str());
                if let Err(error) =
                    unsafe { native_webview.Navigate(*native_url.as_ref().as_pcwstr()) }
                {
                    if let Some(registration) =
                        take_windows_browser_navigation(&label, generation, &token, native_view)
                    {
                        disconnect_windows_browser_navigation_handlers(
                            &native_webview,
                            &registration,
                        );
                    }
                    return Err(error.to_string());
                }
                Ok(())
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "browser navigation setup was cancelled".to_string())?
}

#[cfg(target_os = "linux")]
async fn start_browser_navigation(
    webview: &tauri::Webview,
    label: &str,
    url: &str,
    generation: u64,
    token: &str,
) -> Result<(), String> {
    let label = label.to_string();
    let url = url.to_string();
    let token = token.to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let native_webview = platform_webview.inner();
            let native_view = linux_browser_webview_identity(&native_webview);
            let sequence = NEXT_BROWSER_LINUX_NAVIGATION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            if !bind_browser_navigation_identity(&label, generation, &token, native_view, sequence)
            {
                let _ = sender.send(Err("browser navigation waiter was replaced".to_string()));
                return;
            }

            let changed_label = label.clone();
            let changed_token = token.clone();
            let load_changed_handler =
                native_webview.connect_load_changed(move |callback_webview, load_event| {
                    let callback_view = linux_browser_webview_identity(callback_webview);
                    let observed_url = callback_webview
                        .uri()
                        .map(|uri| uri.to_string())
                        .unwrap_or_default();
                    let event = match load_event {
                        LoadEvent::Started => BrowserLinuxNavigationEvent::Started,
                        LoadEvent::Redirected => BrowserLinuxNavigationEvent::Redirected,
                        LoadEvent::Committed => BrowserLinuxNavigationEvent::Committed,
                        LoadEvent::Finished => BrowserLinuxNavigationEvent::Finished,
                        _ => BrowserLinuxNavigationEvent::Failed,
                    };
                    let decision = {
                        let mut registrations = BROWSER_LINUX_NAVIGATIONS.lock();
                        let Some(registration) = registrations.get_mut(&changed_label) else {
                            return;
                        };
                        if registration.generation != generation
                            || registration.token != changed_token
                            || registration.native_view != callback_view
                            || registration.sequence != sequence
                        {
                            return;
                        }
                        advance_browser_linux_navigation(
                            &mut registration.phase,
                            event,
                            &observed_url,
                            &registration.requested_url,
                        )
                    };
                    match decision {
                        BrowserLinuxNavigationDecision::Pending => {}
                        BrowserLinuxNavigationDecision::Complete(terminal_url) => {
                            if let Some(registration) = take_linux_browser_navigation(
                                &changed_label,
                                generation,
                                &changed_token,
                                callback_view,
                            ) {
                                disconnect_linux_browser_navigation_signals(
                                    callback_webview,
                                    &registration,
                                );
                                resolve_browser_navigation(
                                    &changed_label,
                                    generation,
                                    &changed_token,
                                    callback_view,
                                    registration.sequence,
                                    Ok(terminal_url),
                                );
                            }
                        }
                        BrowserLinuxNavigationDecision::Reject(error) => {
                            if let Some(registration) = take_linux_browser_navigation(
                                &changed_label,
                                generation,
                                &changed_token,
                                callback_view,
                            ) {
                                disconnect_linux_browser_navigation_signals(
                                    callback_webview,
                                    &registration,
                                );
                                resolve_browser_navigation(
                                    &changed_label,
                                    generation,
                                    &changed_token,
                                    callback_view,
                                    registration.sequence,
                                    Err(error),
                                );
                            }
                        }
                    }
                });

            let failed_label = label.clone();
            let failed_token = token.clone();
            let load_failed_handler = native_webview.connect_load_failed(
                move |callback_webview, _load_event, failing_uri, _error| {
                    let callback_view = linux_browser_webview_identity(callback_webview);
                    let decision = {
                        let mut registrations = BROWSER_LINUX_NAVIGATIONS.lock();
                        let Some(registration) = registrations.get_mut(&failed_label) else {
                            return false;
                        };
                        if registration.generation != generation
                            || registration.token != failed_token
                            || registration.native_view != callback_view
                            || registration.sequence != sequence
                        {
                            return false;
                        }
                        advance_browser_linux_navigation(
                            &mut registration.phase,
                            BrowserLinuxNavigationEvent::Failed,
                            failing_uri,
                            &registration.requested_url,
                        )
                    };
                    if let BrowserLinuxNavigationDecision::Reject(error) = decision {
                        if let Some(registration) = take_linux_browser_navigation(
                            &failed_label,
                            generation,
                            &failed_token,
                            callback_view,
                        ) {
                            disconnect_linux_browser_navigation_signals(
                                callback_webview,
                                &registration,
                            );
                            resolve_browser_navigation(
                                &failed_label,
                                generation,
                                &failed_token,
                                callback_view,
                                registration.sequence,
                                Err(error),
                            );
                        }
                    }
                    false
                },
            );

            let tls_label = label.clone();
            let tls_token = token.clone();
            let load_failed_tls_handler = native_webview.connect_load_failed_with_tls_errors(
                move |callback_webview, failing_uri, _certificate, _errors| {
                    let callback_view = linux_browser_webview_identity(callback_webview);
                    let registration = take_linux_browser_navigation(
                        &tls_label,
                        generation,
                        &tls_token,
                        callback_view,
                    );
                    if let Some(registration) = registration {
                        disconnect_linux_browser_navigation_signals(
                            callback_webview,
                            &registration,
                        );
                        resolve_browser_navigation(
                            &tls_label,
                            generation,
                            &tls_token,
                            callback_view,
                            registration.sequence,
                            Err(format!(
                                "browser navigation failed TLS validation for {failing_uri}"
                            )),
                        );
                    }
                    false
                },
            );

            BROWSER_LINUX_NAVIGATIONS.lock().insert(
                label.clone(),
                BrowserLinuxNavigationRegistration {
                    native_view,
                    generation,
                    token: token.clone(),
                    sequence,
                    requested_url: url.clone(),
                    load_changed_handler: unsafe { load_changed_handler.as_raw() },
                    load_failed_handler: unsafe { load_failed_handler.as_raw() },
                    load_failed_tls_handler: unsafe { load_failed_tls_handler.as_raw() },
                    phase: BrowserLinuxNavigationPhase::AwaitingStart,
                },
            );
            native_webview.load_uri(&url);
            let _ = sender.send(Ok(()));
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "browser navigation setup was cancelled".to_string())?
}

#[tauri::command]
async fn browser_navigate(
    webview: tauri::Webview,
    app: AppHandle,
    label: Option<String>,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    generation: u64,
    navigation_token: String,
    automation_source: String,
) -> Result<BrowserNavigationResult, String> {
    ensure_trusted_browser_caller(webview.label())?;
    if generation == 0 {
        return Err("browser navigation generation is invalid".to_string());
    }
    if navigation_token.is_empty() || navigation_token.len() > 128 {
        return Err("browser navigation token is invalid".to_string());
    }
    if automation_source.is_empty() || automation_source.len() > 1024 * 1024 {
        return Err("browser automation initialization source is invalid".to_string());
    }
    let label = safe_browser_label(label);
    Url::parse(&url).map_err(|error| error.to_string())?;
    let (completion, receiver) = tokio::sync::oneshot::channel();
    {
        let mut waiters = BROWSER_NAVIGATION_WAITERS.lock();
        if waiters.contains_key(&label) {
            return Err("browser navigation is already in progress".to_string());
        }
        waiters.insert(
            label.clone(),
            BrowserNavigationWaiter {
                generation,
                token: navigation_token.clone(),
                requested_url: url.clone(),
                native_view: None,
                navigation_identity: None,
                completion: Some(completion),
            },
        );
    }
    let _waiter_guard = BrowserNavigationWaiterGuard {
        label: label.clone(),
        token: navigation_token.clone(),
    };
    retire_browser_webview_for_navigation(&app, &label)?;
    let created = ensure_browser(&app, &label, x, y, w, h, &url, &automation_source)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview missing".to_string())?;
    if !created {
        webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(LogicalSize::new(w.max(1.0), h.max(1.0)))
            .map_err(|e| e.to_string())?;
    }
    if let Err(error) = install_browser_native_focus_callback(&webview, &label).await {
        cleanup_created_browser_after_setup_failure(created, || {
            retire_browser_webview_for_navigation(&app, &label)
        });
        return Err(error);
    }
    if let Err(error) =
        start_browser_navigation(&webview, &label, &url, generation, &navigation_token).await
    {
        cleanup_created_browser_after_setup_failure(created, || {
            retire_browser_webview_for_navigation(&app, &label)
        });
        return Err(error);
    }
    match tokio::time::timeout(std::time::Duration::from_secs(30), receiver).await {
        Ok(Ok(Ok(result))) => {
            let live_focus_identity = browser_focus_identity(&label)
                .ok_or_else(|| "browser focus identity is unavailable".to_string())?;
            if live_focus_identity.generation != generation
                || live_focus_identity.navigation_token != navigation_token
            {
                return Err(
                    "browser focus identity does not match completed navigation".to_string()
                );
            }
            Ok(result)
        }
        Ok(Ok(Err(error))) => {
            let _ = retire_browser_webview_for_navigation(&app, &label);
            Err(error)
        }
        Ok(Err(_)) => Err("browser navigation was cancelled".to_string()),
        Err(_) => {
            let _ = retire_browser_webview_for_navigation(&app, &label);
            Err("browser navigation timed out".to_string())
        }
    }
}

#[tauri::command]
fn browser_set_bounds(
    webview: tauri::Webview,
    app: AppHandle,
    label: Option<String>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    ensure_trusted_browser_caller(webview.label())?;
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
fn browser_hide(
    webview: tauri::Webview,
    app: AppHandle,
    label: Option<String>,
) -> Result<(), String> {
    ensure_trusted_browser_caller(webview.label())?;
    let label = safe_browser_label(label);
    if let Some(webview) = app.get_webview(&label) {
        hide_webview(&webview)?;
    }
    Ok(())
}

#[tauri::command]
fn browser_hide_all_except(
    webview: tauri::Webview,
    app: AppHandle,
    label: Option<String>,
) -> Result<(), String> {
    ensure_trusted_browser_caller(webview.label())?;
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
        close_browser_webview_transactionally(
            || webview.close().map_err(|error| error.to_string()),
            || {
                BROWSER_NAVIGATION_WAITERS.lock().remove(&label);
                detach_browser_navigation_callbacks(&webview, &label);
                detach_browser_native_focus_callback(&webview);
                retire_browser_focus_label(&label);
            },
        )?;
    } else {
        BROWSER_NAVIGATION_WAITERS.lock().remove(&label);
        retire_browser_focus_label(&label);
    }
    app.state::<BrowserShortcutAuthorizations>().remove(&label);
    app.state::<BrowserAutomationAuthorizations>()
        .remove(&label);
    Ok(())
}

#[tauri::command]
fn browser_destroy(
    webview: tauri::Webview,
    app: AppHandle,
    label: Option<String>,
) -> Result<(), String> {
    ensure_trusted_browser_caller(webview.label())?;
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
fn browser_destroy_many(
    webview: tauri::Webview,
    app: AppHandle,
    labels: Vec<String>,
) -> Result<BrowserDestroyManyOutcome, String> {
    ensure_trusted_browser_caller(webview.label())?;
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
    Ok(outcome)
}

#[tauri::command]
fn browser_current_url(
    webview: tauri::Webview,
    app: AppHandle,
    label: Option<String>,
) -> Result<String, String> {
    ensure_trusted_browser_caller(webview.label())?;
    let label = safe_browser_label(label);
    let browser = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview missing".to_string())?;
    let url = browser.url().map_err(|error| error.to_string())?;
    match url.scheme() {
        "http" | "https" | "about" => Ok(url.to_string()),
        _ => Err("browser document URL is unsupported".to_string()),
    }
}

#[tauri::command]
fn browser_reload(
    webview: tauri::Webview,
    app: AppHandle,
    label: Option<String>,
) -> Result<(), String> {
    ensure_trusted_browser_caller(webview.label())?;
    let label = safe_browser_label(label);
    if let Some(webview) = app.get_webview(&label) {
        webview.reload().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn browser_eval(
    webview: tauri::Webview,
    app: AppHandle,
    label: Option<String>,
    script: String,
    automation_receipt: Option<BrowserAutomationCorrelation>,
) -> Result<(), String> {
    ensure_trusted_browser_caller(webview.label())?;
    let label = safe_browser_label(label);
    if let Some(webview) = app.get_webview(&label) {
        let current_url = webview.url().map_err(|error| error.to_string())?;
        ensure_live_browser_document_authority(&label, current_url.as_str())?;
        if let Some(correlation) = automation_receipt {
            let authorizations = app.state::<BrowserAutomationAuthorizations>();
            authorizations.install(&label, correlation.clone());
            if let Err(error) = webview.eval(&script) {
                authorizations.consume(&label, &correlation);
                return Err(error.to_string());
            }
        } else {
            webview.eval(&script).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserScriptRequest {
    source: String,
    #[serde(default)]
    args: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserScriptResponse {
    value: serde_json::Value,
    result_bytes: usize,
    duration_ms: f64,
}

fn browser_script_execution_world_name() -> &'static str {
    BROWSER_SCRIPT_CONTEXT_WORLD_NAME
}

fn classify_browser_script_callback<T>(
    callback_result: Result<T, String>,
    expected_document_token: &str,
    observed_document_token: Result<String, String>,
) -> Result<T, String> {
    match observed_document_token {
        Ok(token) if token == expected_document_token => callback_result,
        Ok(_) | Err(_) => Err("effect_unknown".to_string()),
    }
}

#[cfg(target_os = "macos")]
async fn evaluate_browser_script_in_world(
    webview: &tauri::Webview,
    script: String,
    world_name: String,
) -> Result<String, String> {
    use block2::RcBlock;
    use objc2::{runtime::AnyObject, ClassType, MainThreadMarker};
    use objc2_foundation::{NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_web_kit::{WKContentWorld, WKWebView};

    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let sender = Mutex::new(Some(sender));
            let completion = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
                let result = if !error.is_null() || value.is_null() {
                    Err("automation_failed".to_string())
                } else {
                    let object = unsafe { &*(value as *const NSObject) };
                    if !object.isKindOfClass(NSString::class()) {
                        Err("serialization_failed".to_string())
                    } else {
                        Ok(unsafe { &*(value as *const AnyObject as *const NSString) }.to_string())
                    }
                };
                if let Some(sender) = sender.lock().take() {
                    let _ = sender.send(result);
                }
            });
            let mtm = MainThreadMarker::new().expect("WKWebView callback runs on the main thread");
            let world_name = NSString::from_str(&world_name);
            let world = unsafe { WKContentWorld::worldWithName(&world_name, mtm) };
            let source = NSString::from_str(&script);
            let webview = unsafe { &*(platform_webview.inner() as *mut WKWebView) };
            unsafe {
                webview.evaluateJavaScript_inFrame_inContentWorld_completionHandler(
                    &source,
                    None,
                    &world,
                    Some(&completion),
                )
            };
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(BROWSER_SCRIPT_TIMEOUT, receiver)
        .await
        .map_err(|_| "effect_unknown".to_string())?
        .map_err(|_| "effect_unknown".to_string())?
}

#[cfg(target_os = "macos")]
async fn evaluate_browser_script_document_token(
    webview: &tauri::Webview,
) -> Result<String, String> {
    let script = r#"(() => {
      const key = '__PSYCHE_BROWSER_SCRIPT_DOCUMENT_CONTEXT__';
      let state = globalThis[key];
      if (!state || state.document !== document || state.root !== document.documentElement) {
        state = Object.freeze({ document, root: document.documentElement,
          token: crypto.randomUUID() });
        Object.defineProperty(globalThis, key, { value: state, configurable: true });
      }
      return JSON.stringify({ documentToken: state.token });
    })()"#;
    let result_json = evaluate_browser_script_in_world(
        webview,
        script.to_string(),
        BROWSER_SCRIPT_CONTEXT_WORLD_NAME.to_string(),
    )
    .await
    .map_err(|_| "document_token_unavailable".to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(&result_json).map_err(|_| "document_token_unavailable".to_string())?;
    value
        .get("documentToken")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "document_token_unavailable".to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn browser_script(
    webview: tauri::Webview,
    app: AppHandle,
    label: Option<String>,
    request: BrowserScriptRequest,
) -> Result<BrowserScriptResponse, String> {
    ensure_trusted_browser_caller(webview.label())?;
    if request.source.len() > MAX_BROWSER_SCRIPT_SOURCE_BYTES {
        return Err("script_source_too_large".to_string());
    }
    let argument_bytes =
        serde_json::to_vec(&request.args).map_err(|_| "serialization_failed".to_string())?;
    if argument_bytes.len() > MAX_BROWSER_SCRIPT_ARGS_BYTES {
        return Err("args_too_large".to_string());
    }
    let label = safe_browser_label(label);
    let browser = app
        .get_webview(&label)
        .ok_or_else(|| "target_unavailable".to_string())?;
    let before_url = browser
        .url()
        .map_err(|_| "target_unavailable".to_string())?;
    ensure_live_browser_document_authority(&label, before_url.as_str())
        .map_err(|_| "target_unavailable".to_string())?;
    let document_token = evaluate_browser_script_document_token(&browser)
        .await
        .map_err(|_| "effect_unknown".to_string())?;
    let input = serde_json::to_string(&serde_json::json!({
        "source": request.source,
        "args": request.args,
        "workerSource": include_str!("../../web/control/browser-script-worker-runtime.js"),
        "expectedUrl": before_url.as_str(),
        "expectedDocumentToken": document_token,
    }))
    .map_err(|_| "serialization_failed".to_string())?;
    let script = format!(
        "{}({})",
        include_str!("../../web/control/browser-script-runtime.js"),
        input
    );
    let callback_result = evaluate_browser_script_in_world(
        &browser,
        script,
        browser_script_execution_world_name().to_string(),
    )
    .await;
    let after_url = browser.url().map_err(|_| "effect_unknown".to_string())?;
    if after_url != before_url {
        return Err("effect_unknown".to_string());
    }
    let observed_document_token = evaluate_browser_script_document_token(&browser).await;
    let result_json = classify_browser_script_callback(
        callback_result,
        &document_token,
        observed_document_token,
    )?;
    let envelope: serde_json::Value =
        serde_json::from_str(&result_json).map_err(|_| "serialization_failed".to_string())?;
    if envelope.get("ok") != Some(&serde_json::Value::Bool(true)) {
        let code = envelope
            .get("code")
            .and_then(|value| value.as_str())
            .filter(|code| {
                matches!(
                    *code,
                    "automation_failed"
                        | "effect_unknown"
                        | "result_too_large"
                        | "serialization_failed"
                        | "snapshot_too_large"
                        | "mutation_plan_invalid"
                        | "mutation_target_stale"
                        | "mutation_not_allowed"
                )
            })
            .unwrap_or("automation_failed");
        return Err(code.to_string());
    }
    let result_text = envelope
        .get("json")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "serialization_failed".to_string())?;
    let result_bytes = envelope
        .get("byteCount")
        .and_then(|value| value.as_u64())
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "serialization_failed".to_string())?;
    let duration_ms = envelope
        .get("durationMs")
        .and_then(|value| value.as_f64())
        .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 5000.0)
        .ok_or_else(|| "serialization_failed".to_string())?;
    if result_bytes != result_text.len() || result_bytes > MAX_BROWSER_SCRIPT_RESULT_BYTES {
        return Err("result_too_large".to_string());
    }
    let value =
        serde_json::from_str(result_text).map_err(|_| "serialization_failed".to_string())?;
    Ok(BrowserScriptResponse {
        value,
        result_bytes,
        duration_ms,
    })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn browser_script(
    webview: tauri::Webview,
    _app: AppHandle,
    _label: Option<String>,
    _request: BrowserScriptRequest,
) -> Result<BrowserScriptResponse, String> {
    ensure_trusted_browser_caller(webview.label())?;
    Err("backend_unavailable".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSnapshot {
    png_base64: String,
    width: u32,
    height: u32,
}

/// Captures only an exact child browser webview. macOS uses that child's native
/// WKWebView snapshot API; other platforms fail closed without desktop or
/// coordinate capture.
#[tauri::command]
async fn browser_snapshot(
    webview: tauri::Webview,
    app: AppHandle,
    label: Option<String>,
) -> Result<BrowserSnapshot, String> {
    ensure_trusted_browser_caller(webview.label())?;
    let label = safe_browser_label(label);
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview missing".to_string())?;
    let current_url = webview.url().map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    let document_authority = ensure_live_browser_document_authority(&label, current_url.as_str())?;
    #[cfg(not(target_os = "macos"))]
    ensure_live_browser_document_authority(&label, current_url.as_str())?;
    let size = webview.size().map_err(|error| error.to_string())?;
    validate_browser_snapshot_dimensions(size.width, size.height)?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview;
        return Err(
            "backend_unavailable: browser snapshot is unsupported on this platform".to_string(),
        );
    }
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        webview
            .with_webview(move |platform_webview| unsafe {
                let wk_webview = &*(platform_webview.inner().cast::<WKWebView>());
                let sender = std::sync::Mutex::new(Some(sender));
                let completion =
                    block2::RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                        let result = (|| {
                            let image = image
                                .as_ref()
                                .ok_or_else(|| "browser snapshot failed".to_string())?;
                            let tiff = image
                                .TIFFRepresentation()
                                .ok_or_else(|| "browser snapshot encoding failed".to_string())?;
                            let bitmap =
                                NSBitmapImageRep::imageRepWithData(&tiff).ok_or_else(|| {
                                    "browser snapshot bitmap is unavailable".to_string()
                                })?;
                            let width = u32::try_from(bitmap.pixelsWide())
                                .map_err(|_| "browser snapshot width is invalid".to_string())?;
                            let height = u32::try_from(bitmap.pixelsHigh())
                                .map_err(|_| "browser snapshot height is invalid".to_string())?;
                            validate_browser_snapshot_dimensions(width, height)?;
                            let properties =
                                NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
                            let png = bitmap
                                .representationUsingType_properties(
                                    NSBitmapImageFileType::PNG,
                                    &properties,
                                )
                                .ok_or_else(|| {
                                    "browser snapshot PNG encoding failed".to_string()
                                })?;
                            let bytes = png.as_bytes_unchecked();
                            if bytes.len() > MAX_BROWSER_SNAPSHOT_BYTES {
                                return Err("browser snapshot exceeds maximum size".to_string());
                            }
                            Ok(BrowserSnapshot {
                                png_base64: BASE64_STANDARD.encode(bytes),
                                width,
                                height,
                            })
                        })();
                        if let Some(sender) =
                            sender.lock().ok().and_then(|mut sender| sender.take())
                        {
                            let _ = sender.send(result);
                        }
                    });
                wk_webview.takeSnapshotWithConfiguration_completionHandler(None, &completion);
            })
            .map_err(|error| error.to_string())?;
        let snapshot = tokio::time::timeout(std::time::Duration::from_secs(15), receiver)
            .await
            .map_err(|_| "browser snapshot timed out".to_string())?
            .map_err(|_| "browser snapshot callback was dropped".to_string())??;
        let observed_url = webview.url().map_err(|error| error.to_string())?;
        let observed_identity =
            ensure_live_browser_document_authority(&label, observed_url.as_str()).ok();
        if !browser_document_authority_unchanged(
            current_url.as_str(),
            &document_authority,
            observed_url.as_str(),
            observed_identity.as_ref(),
        ) {
            return Err("browser document authority was replaced".to_string());
        }
        Ok(snapshot)
    }
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
    pub default_shell_args: Vec<String>,
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
    let home = platform::home_directory();
    let (default_shell, default_shell_args) = platform::default_shell();
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
        default_shell_args,
        native_workspace_v2,
    }
}

fn native_launch_command(request: &NativeSessionCreate) -> Result<(String, Vec<String>), String> {
    #[cfg(not(unix))]
    {
        let _ = request;
        return Err("durable native sessions require tmux on a Unix platform".to_string());
    }

    #[cfg(unix)]
    {
        let environment = app_environment();
        let (executable, command_args) = match &request.launch_kind {
            NativeLaunchKind::Shell => (environment.default_shell, environment.default_shell_args),
            NativeLaunchKind::Psyche => (
                environment
                    .node_path
                    .ok_or_else(|| "node is unavailable".to_string())?,
                vec![environment
                    .psyche_entry
                    .ok_or_else(|| "Psyche entrypoint is unavailable".to_string())?],
            ),
            NativeLaunchKind::CovenCode => (
                environment
                    .coven_path
                    .ok_or_else(|| "Coven CLI is unavailable".to_string())?,
                Vec::new(),
            ),
            NativeLaunchKind::CovenAttach => {
                let id = request
                    .coven_session_id
                    .clone()
                    .filter(|id| is_safe_session_id(id))
                    .ok_or_else(|| "Coven session id is unsafe".to_string())?;
                (
                    environment
                        .coven_path
                        .ok_or_else(|| "Coven CLI is unavailable".to_string())?,
                    vec!["attach".to_string(), id],
                )
            }
        };
        let mut args = vec![
            "-u".to_string(),
            "TMUX".to_string(),
            "-u".to_string(),
            "npm_config_prefix".to_string(),
            "-u".to_string(),
            "NPM_CONFIG_PREFIX".to_string(),
            "-u".to_string(),
            "PREFIX".to_string(),
            format!("PATH={}", platform::augmented_path().to_string_lossy()),
            "TERM=xterm-256color".to_string(),
            "COLORTERM=truecolor".to_string(),
            "PSYCHE_TAURI=1".to_string(),
            "PSYCHE_NATIVE_CONTAINER=1".to_string(),
        ];
        if matches!(
            request.launch_kind,
            NativeLaunchKind::CovenCode | NativeLaunchKind::CovenAttach
        ) {
            args.push("-u".to_string());
            args.push(COVEN_SESSION_SOURCE.to_string());
        }
        if matches!(request.launch_kind, NativeLaunchKind::Psyche) {
            let home = environment
                .home
                .ok_or_else(|| "home directory is unavailable".to_string())?;
            args.push(format!("TMUX_TMPDIR={home}/.psyche/macos-app/nested-tmux"));
        }
        args.push(executable);
        args.extend(command_args);
        Ok(("/usr/bin/env".to_string(), args))
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

fn executable_names_with_extensions(binary: &OsStr, extensions: &[OsString]) -> Vec<OsString> {
    if extensions.is_empty() || Path::new(binary).extension().is_some() {
        return vec![binary.to_os_string()];
    }

    extensions
        .iter()
        .filter(|extension| !extension.is_empty())
        .map(|extension| {
            let mut executable = binary.to_os_string();
            if !extension.to_string_lossy().starts_with('.') {
                executable.push(".");
            }
            executable.push(extension);
            executable
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn executable_extensions() -> Vec<OsString> {
    let path_extensions = std::env::var_os("PATHEXT")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
    std::env::split_paths(&path_extensions)
        .map(|extension| extension.into_os_string())
        .filter(|extension| !extension.is_empty())
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn executable_extensions() -> Vec<OsString> {
    Vec::new()
}

fn executable_in_dir(binary: &str, dir: &Path) -> Option<String> {
    let extensions = executable_extensions();
    executable_names_with_extensions(OsStr::new(binary), &extensions)
        .into_iter()
        .find_map(|name| {
            let canonical = dir.join(name).canonicalize().ok()?;
            is_executable_file(&canonical).then(|| canonical.to_string_lossy().to_string())
        })
}

#[cfg_attr(not(test), allow(dead_code))]
fn which_on_path_with(binary: &str, path: &std::ffi::OsStr) -> Option<String> {
    std::env::split_paths(path).find_map(|dir| executable_in_dir(binary, &dir))
}

fn which_on_path(binary: &str) -> Option<String> {
    let path = platform::augmented_path();
    for dir in std::env::split_paths(&path) {
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
    Ok(metadata_file_state(&metadata))
}

#[cfg(unix)]
fn metadata_file_state(metadata: &std::fs::Metadata) -> FileState {
    FileState {
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
    }
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

#[cfg(test)]
mod native_project_authority_tests {
    use super::*;

    fn authorize_project_for_test(authority: &NativeProjectAuthority, root: &Path) {
        authority.reconcile_startup_roots(&[]).unwrap();
        authority.authorize_native_open(root).unwrap();
    }

    fn revoke_project_for_test(authority: &NativeProjectAuthority, root: &Path) {
        authority.revoke_native_open(root).unwrap();
    }

    #[test]
    fn native_project_authority_starts_fail_closed() {
        let tree = tempfile::TempDir::new().unwrap();
        assert!(NativeProjectAuthority::from_workspace_path(
            &tree.path().join("missing-workspace.json")
        )
        .unwrap()
        .open_project_roots()
        .is_empty());
    }

    #[test]
    fn native_project_authority_is_bounded_and_existing_roots_are_idempotent() {
        let tree = tempfile::TempDir::new().unwrap();
        let authority = NativeProjectAuthority::default();
        let first = tree.path().join("project-0");
        std::fs::create_dir_all(&first).unwrap();

        authorize_project_for_test(&authority, &first);
        authority.authorize_native_open(&first).unwrap();
        for index in 1..10 {
            let root = tree.path().join(format!("project-{index}"));
            std::fs::create_dir_all(&root).unwrap();
            authority.authorize_native_open(&root).unwrap();
        }

        let overflow = tree.path().join("project-10");
        std::fs::create_dir_all(&overflow).unwrap();
        assert_eq!(
            authority.authorize_native_open(&overflow).unwrap_err(),
            "native project authority limit reached (10)"
        );
        assert_eq!(authority.open_project_roots().len(), 10);
    }

    #[test]
    fn revoked_project_authority_rejects_stale_launch_scope() {
        let tree = tempfile::TempDir::new().unwrap();
        let root = tree.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let authority = NativeProjectAuthority::default();
        authorize_project_for_test(&authority, &root);

        revoke_project_for_test(&authority, &root);

        assert!(authority.open_project_roots().is_empty());
    }

    #[test]
    fn failed_project_revocation_restores_open_authority() {
        let tree = tempfile::TempDir::new().unwrap();
        let root = tree.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let authority = NativeProjectAuthority::default();
        authorize_project_for_test(&authority, &root);

        let result = authority
            .revoke_native_open_with(&root, |_, _| Err("injected revocation failure".to_string()));

        assert_eq!(result.unwrap_err(), "injected revocation failure");
        assert_eq!(
            authority.open_project_roots(),
            vec![root.canonicalize().unwrap()]
        );
        assert!(authority.claim_submission(&root).is_ok());
    }

    #[test]
    fn non_removing_project_revocation_restores_open_authority() {
        let tree = tempfile::TempDir::new().unwrap();
        let root = tree.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let authority = NativeProjectAuthority::default();
        authorize_project_for_test(&authority, &root);

        assert!(!authority
            .revoke_native_open_with(&root, |_, _| Ok(false))
            .unwrap());

        assert_eq!(
            authority.open_project_roots(),
            vec![root.canonicalize().unwrap()]
        );
        assert!(authority.claim_submission(&root).is_ok());
    }

    #[test]
    fn project_revocation_waits_for_native_session_submission_leases() {
        let tree = tempfile::TempDir::new().unwrap();
        let root = tree.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let authority = NativeProjectAuthority::default();
        authorize_project_for_test(&authority, &root);
        let lease = authority.claim_submission(&root).unwrap();
        let revoking_authority = authority.clone();
        let revoking_root = root.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let revoke = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            revoking_authority.revoke_native_open(&revoking_root)
        });
        started_rx.recv().unwrap();

        while authority.open_project_roots().len() == 1 {
            std::thread::yield_now();
        }
        assert!(authority.claim_submission(&root).is_err());
        assert!(!revoke.is_finished());

        drop(lease);
        assert!(revoke.join().unwrap().unwrap());
        assert!(authority.open_project_roots().is_empty());
    }

    #[test]
    fn startup_project_authority_rehydrates_preexisting_persisted_roots() {
        let tree = tempfile::TempDir::new().unwrap();
        let workspace_path = tree.path().join("workspace.json");
        let saved_root = tree.path().join("saved");
        std::fs::create_dir_all(&saved_root).unwrap();
        let workspace = serde_json::json!({
            "version": 3,
            "activeProjectId": "saved",
            "activeThreadId": null,
            "projects": [{
                "id": "saved",
                "name": "Saved",
                "root": saved_root.to_string_lossy(),
            }],
            "sessions": [],
            "paneLayouts": [],
        });
        native_workspace::save_workspace_to(&workspace_path, &workspace).unwrap();

        let authority = NativeProjectAuthority::from_workspace_path(&workspace_path).unwrap();

        assert!(authority.claim_submission(&saved_root).is_err());
        authority
            .reconcile_startup_roots(&[saved_root.to_string_lossy().into_owned()])
            .unwrap();
        assert!(authority.claim_submission(&saved_root).is_ok());
    }

    #[test]
    fn startup_project_authority_keeps_valid_roots_when_an_absolute_root_is_missing() {
        let tree = tempfile::TempDir::new().unwrap();
        let workspace_path = tree.path().join("workspace.json");
        let saved_root = tree.path().join("saved");
        let missing_root = tree.path().join("missing");
        std::fs::create_dir_all(&saved_root).unwrap();
        let workspace = serde_json::json!({
            "version": 3,
            "activeProjectId": "saved",
            "activeThreadId": null,
            "projects": [
                {
                    "id": "saved",
                    "name": "Saved",
                    "root": saved_root.to_string_lossy(),
                },
                {
                    "id": "missing",
                    "name": "Missing",
                    "root": missing_root.to_string_lossy(),
                }
            ],
            "sessions": [],
            "paneLayouts": [],
        });
        native_workspace::save_workspace_to(&workspace_path, &workspace).unwrap();

        let authority = NativeProjectAuthority::from_workspace_path(&workspace_path).unwrap();

        authority
            .reconcile_startup_roots(&[saved_root.to_string_lossy().into_owned()])
            .unwrap();
        assert!(authority.claim_submission(&saved_root).is_ok());
        assert!(authority.claim_submission(&missing_root).is_err());
        assert_eq!(
            authority.open_project_roots(),
            vec![saved_root.canonicalize().unwrap()]
        );
    }

    #[test]
    fn startup_project_authority_snapshot_cannot_be_mutated_by_later_workspace_saves() {
        let tree = tempfile::TempDir::new().unwrap();
        let workspace_path = tree.path().join("workspace.json");
        let saved_root = tree.path().join("saved");
        let later_root = tree.path().join("later");
        std::fs::create_dir_all(&saved_root).unwrap();
        std::fs::create_dir_all(&later_root).unwrap();
        let workspace = |root: &Path| {
            serde_json::json!({
                "version": 3,
                "activeProjectId": "project",
                "activeThreadId": null,
                "projects": [{
                    "id": "project",
                    "name": "Project",
                    "root": root.to_string_lossy(),
                }],
                "sessions": [],
                "paneLayouts": [],
            })
        };
        native_workspace::save_workspace_to(&workspace_path, &workspace(&saved_root)).unwrap();
        let authority = NativeProjectAuthority::from_workspace_path(&workspace_path).unwrap();
        authority
            .reconcile_startup_roots(&[saved_root.to_string_lossy().into_owned()])
            .unwrap();

        native_workspace::save_workspace_to(&workspace_path, &workspace(&later_root)).unwrap();

        assert!(authority.claim_submission(&saved_root).is_ok());
        assert!(authority.claim_submission(&later_root).is_err());
        assert!(authority.authorize_native_open(&later_root).is_ok());
        assert!(authority.claim_submission(&later_root).is_ok());
    }

    #[test]
    fn startup_project_authority_reconciliation_only_retains_authorized_roots() {
        let tree = tempfile::TempDir::new().unwrap();
        let retained_root = tree.path().join("retained");
        let omitted_root = tree.path().join("omitted");
        let arbitrary_root = tree.path().join("arbitrary");
        std::fs::create_dir_all(&retained_root).unwrap();
        std::fs::create_dir_all(&omitted_root).unwrap();
        std::fs::create_dir_all(&arbitrary_root).unwrap();
        let authority = NativeProjectAuthority::default();
        authority
            .authorize_canonical_native_open(retained_root.canonicalize().unwrap())
            .unwrap();
        authority
            .authorize_canonical_native_open(omitted_root.canonicalize().unwrap())
            .unwrap();

        authority
            .reconcile_startup_roots(&[retained_root.to_string_lossy().into_owned()])
            .unwrap();

        assert!(authority.claim_submission(&retained_root).is_ok());
        assert!(authority.claim_submission(&omitted_root).is_err());
        assert!(authority
            .reconcile_startup_roots(&[arbitrary_root.to_string_lossy().into_owned()])
            .is_err());
        assert!(authority.claim_submission(&retained_root).is_ok());
    }

    #[test]
    fn startup_project_authority_rejects_submissions_until_reconciled_once() {
        let tree = tempfile::TempDir::new().unwrap();
        let retained_root = tree.path().join("retained");
        let omitted_root = tree.path().join("omitted");
        std::fs::create_dir_all(&retained_root).unwrap();
        std::fs::create_dir_all(&omitted_root).unwrap();
        let authority = NativeProjectAuthority::default();
        authority
            .authorize_canonical_native_open(retained_root.canonicalize().unwrap())
            .unwrap();
        authority
            .authorize_canonical_native_open(omitted_root.canonicalize().unwrap())
            .unwrap();

        assert!(authority.claim_submission(&retained_root).is_err());
        assert!(authority.open_project_roots().is_empty());
        authority
            .reconcile_startup_roots(&[retained_root.to_string_lossy().into_owned()])
            .unwrap();
        assert!(authority.claim_submission(&retained_root).is_ok());
        assert!(authority
            .reconcile_startup_roots(&[retained_root.to_string_lossy().into_owned()])
            .is_err());
        assert!(authority.claim_submission(&omitted_root).is_err());
    }

    #[test]
    fn native_project_open_authority_waits_for_startup_reconciliation() {
        let tree = tempfile::TempDir::new().unwrap();
        let root = tree.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let authority = NativeProjectAuthority::default();

        assert!(authority.authorize_native_open(&root).is_err());
        authority.reconcile_startup_roots(&[]).unwrap();
        assert!(authority.authorize_native_open(&root).is_ok());
        assert!(authority.claim_submission(&root).is_ok());
    }

    #[test]
    fn startup_project_authority_rejects_malformed_or_arbitrary_roots() {
        let tree = tempfile::TempDir::new().unwrap();
        let workspace_path = tree.path().join("workspace.json");
        let saved_root = tree.path().join("saved");
        std::fs::create_dir_all(&saved_root).unwrap();
        let workspace = serde_json::json!({
            "version": 3,
            "activeProjectId": "project",
            "activeThreadId": null,
            "projects": [
                {
                    "id": "saved",
                    "name": "Saved",
                    "root": saved_root.to_string_lossy(),
                },
                {
                    "id": "project",
                    "name": "Project",
                    "root": "relative/arbitrary",
                }
            ],
            "sessions": [],
            "paneLayouts": [],
        });
        native_workspace::save_workspace_to(&workspace_path, &workspace).unwrap();

        assert!(NativeProjectAuthority::from_workspace_path(&workspace_path).is_err());
    }

    #[test]
    fn project_privileged_commands_reject_external_callers() {
        assert_eq!(ensure_trusted_project_caller("main"), Ok(()));
        assert_eq!(
            ensure_trusted_project_caller("psyche-browser-untrusted").unwrap_err(),
            "project authority is only available to trusted webview 'main'; rejected caller 'psyche-browser-untrusted'"
        );
    }
}

#[cfg(test)]
mod runtime_diagnostics_command_tests {
    use crate::runtime_diagnostics::{stress_authorized_for, NativeRuntimeReport, ProcessMetrics};

    #[test]
    fn runtime_diagnostics_omits_unavailable_engine_version_and_metrics() {
        let report = NativeRuntimeReport::from_parts(
            "linux",
            "x86_64",
            "WebKitGTK",
            None,
            None,
            true,
            false,
        );
        let json = serde_json::to_value(report).unwrap();
        assert!(json.get("engineVersion").is_none());
        assert!(json.get("process").is_none());
    }

    #[test]
    fn runtime_diagnostics_production_never_authorizes_the_stress_harness() {
        assert!(!stress_authorized_for(false, Some("1")));
        assert!(stress_authorized_for(true, Some("1")));
        assert!(!stress_authorized_for(true, Some("0")));
        assert!(!stress_authorized_for(true, Some("true")));
    }

    #[test]
    fn runtime_diagnostics_uses_stable_camel_case_process_fields() {
        let report = NativeRuntimeReport::from_parts(
            "macos",
            "aarch64",
            "WKWebView",
            Some("17.6".to_string()),
            Some(ProcessMetrics {
                cpu_percent: Some(12.5),
                rss_bytes: Some(4096),
            }),
            true,
            true,
        );

        let json = serde_json::to_value(report).unwrap();

        assert!(json.get("engineVersion").is_some());
        assert!(json.get("debugBuild").is_some());
        assert!(json.get("stressAuthorized").is_some());
        assert!(json.get("engine_version").is_none());
        assert!(json.get("debug_build").is_none());
        assert!(json.get("stress_authorized").is_none());

        let process = json.get("process").unwrap();
        assert!(process.get("cpuPercent").is_some());
        assert!(process.get("rssBytes").is_some());
        assert!(process.get("cpu_percent").is_none());
        assert!(process.get("rss_bytes").is_none());
    }
}

#[cfg(test)]
mod browser_app_shortcut_tests {
    use super::*;
    use std::cell::Cell;
    use std::time::{Duration, Instant};

    fn authorize(
        authorizations: &BrowserShortcutAuthorizations,
        label: &str,
        secret: &str,
        now: Instant,
        next_secret: &str,
        dispatched: &Cell<usize>,
    ) -> Result<String, String> {
        authorizations.authorize_and_rotate(
            label,
            secret,
            now,
            || Ok(next_secret.to_string()),
            || {
                dispatched.set(dispatched.get() + 1);
                Ok(())
            },
        )
    }

    #[test]
    fn browser_app_shortcut_accepts_supported_mappings() {
        let label = "psyche-browser-project-1";
        assert_eq!(
            resolve_browser_app_shortcut(label, "terminal-pane").unwrap(),
            "browser:shortcut-terminal-pane"
        );
        assert_eq!(
            resolve_browser_app_shortcut(label, "agent-pane").unwrap(),
            "browser:shortcut-agent-pane"
        );
        assert_eq!(
            resolve_browser_app_shortcut(label, "composer").unwrap(),
            "browser:shortcut-composer"
        );
    }

    #[test]
    fn browser_app_shortcut_rejects_untrusted_callers_and_unknown_actions() {
        assert!(resolve_browser_app_shortcut("main", "terminal-pane").is_err());
        assert!(resolve_browser_app_shortcut("psyche-browser-project-1", "new-tab").is_err());
    }

    #[test]
    fn browser_app_shortcut_rejects_invalid_secrets_without_dispatching() {
        let authorizations = BrowserShortcutAuthorizations::default();
        let label = "psyche-browser-project-1";
        authorizations.install(label, "initial-secret".to_string());
        let dispatched = Cell::new(0);

        assert!(authorize(
            &authorizations,
            label,
            "wrong-secret",
            Instant::now(),
            "next-secret",
            &dispatched,
        )
        .is_err());
        assert_eq!(dispatched.get(), 0);
    }

    #[test]
    fn browser_app_shortcut_rotates_only_after_successful_dispatch() {
        let authorizations = BrowserShortcutAuthorizations::default();
        let label = "psyche-browser-project-1";
        authorizations.install(label, "initial-secret".to_string());
        let now = Instant::now();

        let failed = authorizations.authorize_and_rotate(
            label,
            "initial-secret",
            now,
            || Ok("unused-secret".to_string()),
            || Err("dispatch failed".to_string()),
        );
        assert_eq!(failed.unwrap_err(), "dispatch failed");

        let dispatched = Cell::new(0);
        assert_eq!(
            authorize(
                &authorizations,
                label,
                "initial-secret",
                now,
                "rotated-secret",
                &dispatched,
            )
            .unwrap(),
            "rotated-secret"
        );
        assert_eq!(dispatched.get(), 1);
        assert!(authorize(
            &authorizations,
            label,
            "initial-secret",
            now + MIN_BROWSER_SHORTCUT_INTERVAL,
            "another-secret",
            &dispatched,
        )
        .is_err());
    }

    #[test]
    fn browser_app_shortcut_rate_limits_without_rotating() {
        let authorizations = BrowserShortcutAuthorizations::default();
        let label = "psyche-browser-project-1";
        authorizations.install(label, "initial-secret".to_string());
        let now = Instant::now();
        let dispatched = Cell::new(0);

        authorize(
            &authorizations,
            label,
            "initial-secret",
            now,
            "second-secret",
            &dispatched,
        )
        .unwrap();
        assert!(authorize(
            &authorizations,
            label,
            "second-secret",
            now + MIN_BROWSER_SHORTCUT_INTERVAL - Duration::from_millis(1),
            "too-fast-secret",
            &dispatched,
        )
        .is_err());
        assert_eq!(dispatched.get(), 1);
        assert_eq!(
            authorize(
                &authorizations,
                label,
                "second-secret",
                now + MIN_BROWSER_SHORTCUT_INTERVAL,
                "third-secret",
                &dispatched,
            )
            .unwrap(),
            "third-secret"
        );
        assert_eq!(dispatched.get(), 2);
    }

    #[test]
    fn browser_app_shortcut_navigation_reset_restores_initial_secret() {
        let authorizations = BrowserShortcutAuthorizations::default();
        let label = "psyche-browser-project-1";
        authorizations.install(label, "initial-secret".to_string());
        let now = Instant::now();
        let dispatched = Cell::new(0);

        authorize(
            &authorizations,
            label,
            "initial-secret",
            now,
            "rotated-secret",
            &dispatched,
        )
        .unwrap();
        assert!(authorizations.reset(label));
        assert_eq!(
            authorize(
                &authorizations,
                label,
                "initial-secret",
                now,
                "post-navigation-secret",
                &dispatched,
            )
            .unwrap(),
            "post-navigation-secret"
        );
        assert!(authorize(
            &authorizations,
            label,
            "rotated-secret",
            now + MIN_BROWSER_SHORTCUT_INTERVAL,
            "unused-secret",
            &dispatched,
        )
        .is_err());
    }

    #[test]
    fn browser_app_shortcut_cleanup_removes_authorization() {
        let authorizations = BrowserShortcutAuthorizations::default();
        let label = "psyche-browser-project-1";
        authorizations.install(label, "initial-secret".to_string());
        assert!(authorizations.remove(label));

        let dispatched = Cell::new(0);
        assert!(authorize(
            &authorizations,
            label,
            "initial-secret",
            Instant::now(),
            "next-secret",
            &dispatched,
        )
        .is_err());
        assert_eq!(dispatched.get(), 0);
    }

    #[test]
    fn browser_app_shortcut_secret_is_random_hex() {
        let secret = random_browser_shortcut_secret().unwrap();
        assert_eq!(secret.len(), 64);
        assert!(secret.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn browser_automation_result_accepts_bounded_success_and_failure_payloads() {
        let success: BrowserAutomationResultPayload = serde_json::from_value(serde_json::json!({
            "actionId": "action-1",
            "tabId": "tab-1",
            "generation": 1,
            "value": null
        }))
        .unwrap();
        assert!(success.validate().is_ok());

        let failure: BrowserAutomationResultPayload = serde_json::from_value(serde_json::json!({
            "actionId": "action-1",
            "tabId": "tab-1",
            "generation": 1,
            "error": { "code": "effect_unknown" }
        }))
        .unwrap();
        assert!(failure.validate().is_ok());
    }

    #[test]
    fn browser_automation_result_rejects_unbounded_or_ambiguous_payloads() {
        let unknown_code: BrowserAutomationResultPayload =
            serde_json::from_value(serde_json::json!({
                "actionId": "action-1",
                "tabId": "tab-1",
                "generation": 1,
                "error": { "code": "forged" }
            }))
            .unwrap();
        assert!(unknown_code.validate().is_err());

        assert!(
            serde_json::from_value::<BrowserAutomationResultPayload>(serde_json::json!({
                "actionId": "action-1",
                "tabId": "tab-1",
                "generation": 1,
                "value": {},
                "error": { "code": "automation_failed" }
            }))
            .is_err()
        );

        let oversized: BrowserAutomationResultPayload = serde_json::from_value(serde_json::json!({
            "actionId": "action-1",
            "tabId": "tab-1",
            "generation": 1,
            "value": "x".repeat(MAX_PROVIDER_RESULT_BYTES)
        }))
        .unwrap();
        assert!(oversized.validate().is_err());
    }

    #[test]
    fn browser_automation_result_consumes_only_the_exact_pending_correlation() {
        let authorizations = BrowserAutomationAuthorizations::default();
        let correlation = BrowserAutomationCorrelation {
            action_id: "action-1".to_string(),
            tab_id: "tab-1".to_string(),
            generation: 7,
        };
        authorizations.install("psyche-browser-project-1", correlation.clone());
        assert!(!authorizations.consume("psyche-browser-project-2", &correlation));
        assert!(!authorizations.consume(
            "psyche-browser-project-1",
            &BrowserAutomationCorrelation {
                generation: 8,
                ..correlation.clone()
            },
        ));
        assert!(authorizations.consume("psyche-browser-project-1", &correlation));
        assert!(!authorizations.consume("psyche-browser-project-1", &correlation));
    }

    #[test]
    fn browser_script_callback_is_stable_only_for_the_same_document() {
        assert_eq!(
            classify_browser_script_callback(
                Err::<String, _>("automation_failed".to_string()),
                "approved-token",
                Ok("approved-token".to_string()),
            ),
            Err("automation_failed".to_string()),
        );
        assert_eq!(
            classify_browser_script_callback(
                Ok("old result"),
                "approved-token",
                Ok("replacement-token".to_string()),
            ),
            Err("effect_unknown".to_string()),
        );
    }

    #[test]
    fn browser_snapshot_completion_requires_unchanged_document_authority() {
        let identity = BrowserFocusIdentity {
            generation: 70,
            navigation_token: "approved-document".to_string(),
            document_url: "https://old.example/account".to_string(),
        };
        let replacement = BrowserFocusIdentity {
            generation: 71,
            navigation_token: "replacement-document".to_string(),
            document_url: "https://new.example/dashboard".to_string(),
        };

        assert!(browser_document_authority_unchanged(
            "https://old.example/account",
            &identity,
            "https://old.example/account",
            Some(&identity),
        ));
        assert!(!browser_document_authority_unchanged(
            "https://old.example/account",
            &identity,
            "https://new.example/dashboard",
            Some(&replacement),
        ));
        assert!(!browser_document_authority_unchanged(
            "https://old.example/account",
            &identity,
            "https://old.example/account",
            None,
        ));
    }

    #[test]
    fn page_initiated_page_load_retires_exact_native_authority() {
        let label = "psyche-browser-page-load-retirement".to_string();
        let identity = BrowserFocusIdentity {
            generation: 71,
            navigation_token: "old-document".to_string(),
            document_url: "https://old.example/account".to_string(),
        };
        install_browser_focus_identity(label.clone(), identity.clone());

        assert!(retire_browser_authority_for_page_load(
            &label,
            "https://new.example/dashboard",
        ));
        assert_eq!(browser_focus_identity(&label), None);

        install_browser_focus_identity(label.clone(), identity.clone());
        assert!(retire_browser_authority_for_page_load(
            &label,
            "https://old.example/settings",
        ));
        assert_eq!(browser_focus_identity(&label), None);

        install_browser_focus_identity(label.clone(), identity);
        assert!(retire_browser_authority_for_page_load(
            &label,
            "https://old.example/account",
        ));
        assert_eq!(browser_focus_identity(&label), None);
        retire_browser_focus_label(&label);
    }

    #[test]
    fn exact_document_authority_rejects_same_origin_replacement_but_accepts_route_updates() {
        let label = "psyche-browser-exact-document-authority".to_string();
        let identity = BrowserFocusIdentity {
            generation: 72,
            navigation_token: "live-document".to_string(),
            document_url: "https://old.example/account".to_string(),
        };
        install_browser_focus_identity(label.clone(), identity.clone());

        assert_eq!(
            ensure_live_browser_document_authority(&label, "https://old.example/settings")
                .unwrap_err(),
            "browser document authority was replaced"
        );
        assert_eq!(browser_focus_identity(&label), None);

        install_browser_focus_identity(label.clone(), identity.clone());
        assert!(refresh_browser_focus_identity_document_url(
            &label,
            identity.generation,
            &identity.navigation_token,
            "https://old.example/settings",
        ));
        assert_eq!(
            ensure_live_browser_document_authority(&label, "https://old.example/settings")
                .unwrap()
                .document_url,
            "https://old.example/settings".to_string()
        );
        retire_browser_focus_label(&label);
    }

    #[test]
    fn browser_script_execution_uses_the_document_context_world() {
        assert_eq!(
            browser_script_execution_world_name(),
            BROWSER_SCRIPT_CONTEXT_WORLD_NAME
        );
    }

    #[test]
    fn browser_script_worker_runtime_is_embedded_and_bounded() {
        assert!(
            include_str!("../../web/control/browser-script-worker-runtime.js")
                .contains("installBrowserScriptWorkerRuntime")
        );
        assert_eq!(MAX_BROWSER_SCRIPT_ARGS_BYTES, 256 * 1024);
    }
}

#[cfg(test)]
mod pty_runtime_tests {
    use std::future::Future;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    #[cfg(not(windows))]
    struct TestLivePtySession {
        token: PtySessionToken,
        pump: OutputPump,
    }

    #[cfg(not(windows))]
    impl TestLivePtySession {
        fn register(thread_id: &str) -> Self {
            let pair = native_pty_system()
                .openpty(PtySize {
                    rows: 10,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .unwrap();
            let writer = pair.master.take_writer().unwrap();
            let (_, reader_cancellation) = prepare_pty_reader(pair.master.as_ref()).unwrap();
            let pending = PendingPtyStart::reserve(thread_id).unwrap();
            let pump =
                OutputPump::new_with_generation(thread_id.to_string(), pending.token.generation)
                    .unwrap();
            let (token, install_outcome) = pending
                .install(PtySession {
                    master: Arc::new(Mutex::new(pair.master)),
                    writer: Arc::new(Mutex::new(writer)),
                    operation_lane: Arc::new(tokio::sync::Mutex::new(())),
                    operation_admission: Arc::new(tokio::sync::Semaphore::new(2)),
                    pump: pump.clone(),
                    terminator: crate::pty_process::tests::recording_terminator(Arc::new(
                        AtomicUsize::new(0),
                    )),
                    reader_cancellation,
                    pid: Some(42),
                    spawn_time_unix_secs: 99,
                })
                .unwrap();
            assert!(matches!(install_outcome, InstallSessionOutcome::Running));
            Self { token, pump }
        }
    }

    #[cfg(not(windows))]
    impl Drop for TestLivePtySession {
        fn drop(&mut self) {
            let action = {
                let mut registry = PTY_LIFECYCLES.lock();
                registry.stop(&self.token.thread_id, Some(self.token.generation))
            };
            if let Ok(StopSessionOutcome::Terminate { session, .. }) = action {
                drop(session);
            }
            PTY_LIFECYCLES.lock().finish_exit(&self.token);
        }
    }

    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pty_operation_lane_prevents_a_later_operation_from_overtaking() {
        let lane = Arc::new(tokio::sync::Mutex::new(()));
        let initial_guard = Arc::clone(&lane).lock_owned().await;
        let order = Arc::new(Mutex::new(Vec::new()));

        let (first_waiting_tx, first_waiting_rx) = tokio::sync::oneshot::channel();
        let first_lane = Arc::clone(&lane);
        let first_order = Arc::clone(&order);
        let first = tokio::spawn(async move {
            let mut first_waiting_tx = Some(first_waiting_tx);
            let lock = first_lane.lock_owned();
            tokio::pin!(lock);
            let _guard = std::future::poll_fn(|context| {
                let result = lock.as_mut().poll(context);
                if result.is_pending() {
                    if let Some(waiting_tx) = first_waiting_tx.take() {
                        let _ = waiting_tx.send(());
                    }
                }
                result
            })
            .await;
            first_order.lock().push(1);
        });
        first_waiting_rx.await.unwrap();

        let (second_waiting_tx, second_waiting_rx) = tokio::sync::oneshot::channel();
        let second_lane = Arc::clone(&lane);
        let second_order = Arc::clone(&order);
        let second = tokio::spawn(async move {
            let mut second_waiting_tx = Some(second_waiting_tx);
            let lock = second_lane.lock_owned();
            tokio::pin!(lock);
            let _guard = std::future::poll_fn(|context| {
                let result = lock.as_mut().poll(context);
                if result.is_pending() {
                    if let Some(waiting_tx) = second_waiting_tx.take() {
                        let _ = waiting_tx.send(());
                    }
                }
                result
            })
            .await;
            second_order.lock().push(2);
        });
        second_waiting_rx.await.unwrap();

        drop(initial_guard);
        first.await.unwrap();
        second.await.unwrap();
        assert_eq!(*order.lock(), vec![1, 2]);
    }

    #[test]
    fn pty_operation_admission_is_bounded() {
        let admission = Arc::new(tokio::sync::Semaphore::new(2));
        let first = Arc::clone(&admission).try_acquire_owned().unwrap();
        let second = Arc::clone(&admission).try_acquire_owned().unwrap();
        assert!(Arc::clone(&admission).try_acquire_owned().is_err());
        drop(first);
        assert!(Arc::clone(&admission).try_acquire_owned().is_ok());
        drop(second);
    }

    #[test]
    fn browser_privileged_commands_reject_external_callers() {
        assert_eq!(ensure_trusted_browser_caller("main"), Ok(()));
        assert!(ensure_trusted_browser_caller("psyche-browser-untrusted").is_err());
    }

    #[test]
    fn pty_privileged_commands_reject_external_callers() {
        assert_eq!(ensure_trusted_pty_caller("main"), Ok(()));
        assert_eq!(
            ensure_trusted_pty_caller("psyche-browser-untrusted").unwrap_err(),
            "PTY authority is only available to trusted webview 'main'; rejected caller 'psyche-browser-untrusted'"
        );
    }

    #[test]
    fn browser_snapshot_dimensions_are_bounded_before_capture() {
        assert!(validate_browser_snapshot_dimensions(800, 600).is_ok());
        assert!(validate_browser_snapshot_dimensions(0, 600).is_err());
        assert!(validate_browser_snapshot_dimensions(8192, 8192).is_err());
    }

    fn browser_navigation_waiter(url: &str) -> BrowserNavigationWaiter {
        let (completion, _receiver) = tokio::sync::oneshot::channel();
        BrowserNavigationWaiter {
            generation: 1,
            token: "requested-token".to_string(),
            requested_url: url.to_string(),
            native_view: None,
            navigation_identity: None,
            completion: Some(completion),
        }
    }

    #[test]
    fn browser_navigation_waiters_correlate_only_exact_native_identity() {
        let requested_label = "browser-native-identity-requested".to_string();
        let unrelated_label = "browser-native-identity-unrelated".to_string();
        let (requested_sender, mut requested_receiver) = tokio::sync::oneshot::channel();
        let (unrelated_sender, mut unrelated_receiver) = tokio::sync::oneshot::channel();
        BROWSER_NAVIGATION_WAITERS.lock().insert(
            requested_label.clone(),
            BrowserNavigationWaiter {
                generation: 41,
                token: "requested".to_string(),
                requested_url: "https://requested.example".to_string(),
                native_view: Some(410),
                navigation_identity: Some(41),
                completion: Some(requested_sender),
            },
        );
        BROWSER_NAVIGATION_WAITERS.lock().insert(
            unrelated_label.clone(),
            BrowserNavigationWaiter {
                generation: 42,
                token: "unrelated".to_string(),
                requested_url: "https://unrelated.example".to_string(),
                native_view: Some(420),
                navigation_identity: Some(42),
                completion: Some(unrelated_sender),
            },
        );

        assert!(!resolve_browser_navigation(
            &requested_label,
            41,
            "requested",
            410,
            99,
            Ok("https://user.example".to_string()),
        ));
        assert!(requested_receiver.try_recv().is_err());
        assert!(unrelated_receiver.try_recv().is_err());
        assert!(!resolve_browser_navigation(
            &requested_label,
            99,
            "requested",
            410,
            41,
            Ok("https://wrong-generation.example".to_string()),
        ));
        assert!(!resolve_browser_navigation(
            &requested_label,
            41,
            "wrong-token",
            410,
            41,
            Ok("https://wrong-token.example".to_string()),
        ));
        assert!(!resolve_browser_navigation(
            &requested_label,
            41,
            "requested",
            999,
            41,
            Ok("https://wrong-view.example".to_string()),
        ));
        assert!(resolve_browser_navigation(
            &requested_label,
            41,
            "requested",
            410,
            41,
            Ok("https://terminal.example".to_string()),
        ));
        let requested_result = requested_receiver.try_recv().unwrap().unwrap();
        assert_eq!(requested_result.terminal_url, "https://terminal.example");
        assert_eq!(
            browser_focus_identity(&requested_label),
            Some(BrowserFocusIdentity {
                generation: 41,
                navigation_token: "requested".to_string(),
                document_url: "https://terminal.example".to_string(),
            })
        );
        assert_eq!(browser_focus_identity(&unrelated_label), None);
        assert!(unrelated_receiver.try_recv().is_err());
        retire_browser_focus_label(&requested_label);
        BROWSER_NAVIGATION_WAITERS.lock().remove(&unrelated_label);
    }

    #[test]
    fn browser_navigation_failure_does_not_publish_a_focus_identity() {
        let label = "browser-native-failure".to_string();
        let (sender, mut receiver) = tokio::sync::oneshot::channel();
        BROWSER_NAVIGATION_WAITERS.lock().insert(
            label.clone(),
            BrowserNavigationWaiter {
                generation: 51,
                token: "failure".to_string(),
                requested_url: "https://failure.example".to_string(),
                native_view: Some(510),
                navigation_identity: Some(52),
                completion: Some(sender),
            },
        );

        assert!(resolve_browser_navigation(
            &label,
            51,
            "failure",
            510,
            52,
            Err("browser navigation failed".to_string()),
        ));
        assert_eq!(
            receiver.try_recv().unwrap().unwrap_err(),
            "browser navigation failed"
        );
        assert_eq!(browser_focus_identity(&label), None);
    }

    #[test]
    fn browser_title_identity_tracks_pending_then_live_native_navigation() {
        let label = "browser-native-title".to_string();
        let (sender, _receiver) = tokio::sync::oneshot::channel();
        BROWSER_NAVIGATION_WAITERS.lock().insert(
            label.clone(),
            BrowserNavigationWaiter {
                generation: 61,
                token: "pending-title".to_string(),
                requested_url: "https://pending-title.example".to_string(),
                native_view: Some(610),
                navigation_identity: Some(62),
                completion: Some(sender),
            },
        );

        assert_eq!(
            browser_title_identity(&label),
            Some(BrowserFocusIdentity {
                generation: 61,
                navigation_token: "pending-title".to_string(),
                document_url: "https://pending-title.example".to_string(),
            })
        );
        BROWSER_NAVIGATION_WAITERS.lock().remove(&label);
        install_browser_focus_identity(
            label.clone(),
            BrowserFocusIdentity {
                generation: 63,
                navigation_token: "live-title".to_string(),
                document_url: "https://live-title.example".to_string(),
            },
        );
        assert_eq!(
            browser_title_identity(&label),
            Some(BrowserFocusIdentity {
                generation: 63,
                navigation_token: "live-title".to_string(),
                document_url: "https://live-title.example".to_string(),
            })
        );
        retire_browser_focus_label(&label);
    }

    #[test]
    fn linux_navigation_state_completes_only_after_finished() {
        let requested = "https://example.test/path";
        let mut phase = BrowserLinuxNavigationPhase::AwaitingStart;

        assert_eq!(
            advance_browser_linux_navigation(
                &mut phase,
                BrowserLinuxNavigationEvent::Started,
                requested,
                requested,
            ),
            BrowserLinuxNavigationDecision::Pending
        );
        assert_eq!(
            advance_browser_linux_navigation(
                &mut phase,
                BrowserLinuxNavigationEvent::Committed,
                requested,
                requested,
            ),
            BrowserLinuxNavigationDecision::Pending
        );
        assert_eq!(
            advance_browser_linux_navigation(
                &mut phase,
                BrowserLinuxNavigationEvent::Finished,
                requested,
                requested,
            ),
            BrowserLinuxNavigationDecision::Complete(requested.to_string())
        );
    }

    #[test]
    fn linux_navigation_state_accepts_owned_redirect_chains() {
        let requested = "http://example.test/login";
        let mut phase = BrowserLinuxNavigationPhase::AwaitingStart;

        for (event, url) in [
            (BrowserLinuxNavigationEvent::Started, requested),
            (
                BrowserLinuxNavigationEvent::Redirected,
                "https://example.test/login",
            ),
            (
                BrowserLinuxNavigationEvent::Redirected,
                "https://auth.example.test/authorize",
            ),
            (
                BrowserLinuxNavigationEvent::Redirected,
                "https://example.test/callback",
            ),
            (
                BrowserLinuxNavigationEvent::Committed,
                "https://example.test/callback",
            ),
        ] {
            assert_eq!(
                advance_browser_linux_navigation(&mut phase, event, url, requested),
                BrowserLinuxNavigationDecision::Pending
            );
        }
        assert_eq!(
            advance_browser_linux_navigation(
                &mut phase,
                BrowserLinuxNavigationEvent::Finished,
                "https://example.test/callback",
                requested,
            ),
            BrowserLinuxNavigationDecision::Complete("https://example.test/callback".to_string())
        );
    }

    #[test]
    fn browser_navigation_url_equivalence_accepts_common_webview_canonicalization() {
        for (requested, observed) in [
            ("https://example.test", "https://example.test/"),
            ("https://example.test:443/docs", "https://example.test/docs"),
            (
                "http://EXAMPLE.test:80/%7euser",
                "http://example.test/~user",
            ),
            (
                "https://example.test/a%2fb?value=%7e#%61",
                "https://example.test/a%2Fb?value=~#a",
            ),
        ] {
            assert!(
                browser_navigation_urls_equivalent(requested, observed),
                "{requested} should be equivalent to {observed}"
            );
        }
    }

    #[test]
    fn browser_navigation_url_equivalence_preserves_navigation_distinctions() {
        for (left, right) in [
            ("http://example.test/path", "https://example.test/path"),
            ("https://a.example.test/path", "https://b.example.test/path"),
            ("https://example.test:444/path", "https://example.test/path"),
            ("https://example.test/path", "https://example.test/path/"),
            ("https://example.test/a%2Fb", "https://example.test/a/b"),
            (
                "https://example.test/path?a=1",
                "https://example.test/path?a=2",
            ),
            ("https://example.test/path#a", "https://example.test/path#b"),
        ] {
            assert!(
                !browser_navigation_urls_equivalent(left, right),
                "{left} should remain distinct from {right}"
            );
        }
    }

    #[test]
    fn linux_navigation_state_accepts_direct_canonicalization_without_weakening_redirect_policy() {
        let requested = "https://example.test/%7euser";
        let mut direct = BrowserLinuxNavigationPhase::AwaitingStart;
        assert_eq!(
            advance_browser_linux_navigation(
                &mut direct,
                BrowserLinuxNavigationEvent::Started,
                "https://example.test/~user",
                requested,
            ),
            BrowserLinuxNavigationDecision::Pending
        );
        assert_eq!(
            advance_browser_linux_navigation(
                &mut direct,
                BrowserLinuxNavigationEvent::Committed,
                "https://example.test:443/~user",
                requested,
            ),
            BrowserLinuxNavigationDecision::Pending
        );
        assert_eq!(
            advance_browser_linux_navigation(
                &mut direct,
                BrowserLinuxNavigationEvent::Finished,
                "https://example.test/~user",
                requested,
            ),
            BrowserLinuxNavigationDecision::Complete("https://example.test/~user".to_string())
        );

        let mut replacement = BrowserLinuxNavigationPhase::AwaitingStart;
        assert_eq!(
            advance_browser_linux_navigation(
                &mut replacement,
                BrowserLinuxNavigationEvent::Started,
                "https://example.test/replaced",
                requested,
            ),
            BrowserLinuxNavigationDecision::Reject(
                "browser navigation was replaced before completion".to_string()
            )
        );
    }

    #[test]
    fn linux_navigation_state_rejects_replacement_ambiguous_evolution_and_failure() {
        let requested = "https://example.test/path";

        let mut replacement = BrowserLinuxNavigationPhase::Started;
        assert_eq!(
            advance_browser_linux_navigation(
                &mut replacement,
                BrowserLinuxNavigationEvent::Started,
                requested,
                requested,
            ),
            BrowserLinuxNavigationDecision::Reject(
                "browser navigation was replaced before completion".to_string()
            )
        );

        let mut ambiguous = BrowserLinuxNavigationPhase::Started;
        assert_eq!(
            advance_browser_linux_navigation(
                &mut ambiguous,
                BrowserLinuxNavigationEvent::Committed,
                "https://redirected.example",
                requested,
            ),
            BrowserLinuxNavigationDecision::Reject(
                "browser navigation signal order was ambiguous".to_string()
            )
        );

        let mut failure = BrowserLinuxNavigationPhase::Started;
        assert_eq!(
            advance_browser_linux_navigation(
                &mut failure,
                BrowserLinuxNavigationEvent::Failed,
                requested,
                requested,
            ),
            BrowserLinuxNavigationDecision::Reject("browser navigation failed".to_string())
        );
    }

    #[test]
    fn windows_navigation_completion_ignores_unrelated_native_ids() {
        assert!(!browser_windows_completion_matches(None, 7));
        assert!(!browser_windows_completion_matches(Some(41), 7));
        assert!(browser_windows_completion_matches(Some(41), 41));
    }

    #[test]
    fn browser_close_failure_preserves_live_authority() {
        let retired = std::cell::Cell::new(false);
        assert_eq!(
            close_browser_webview_transactionally(
                || Err("close failed".to_string()),
                || retired.set(true),
            ),
            Err("close failed".to_string())
        );
        assert!(!retired.get());

        close_browser_webview_transactionally(|| Ok(()), || retired.set(true)).unwrap();
        assert!(retired.get());
    }

    #[test]
    fn browser_navigation_waiter_guard_cleans_every_early_exit_without_removing_a_successor() {
        for stage in ["ensure", "lookup", "bounds", "navigate", "timeout"] {
            let label = format!("browser-waiter-guard-{stage}");
            let token = format!("token-{stage}");
            BROWSER_NAVIGATION_WAITERS.lock().insert(
                label.clone(),
                browser_navigation_waiter("https://example.test"),
            );
            BROWSER_NAVIGATION_WAITERS
                .lock()
                .get_mut(&label)
                .unwrap()
                .token = token.clone();
            {
                let _guard = BrowserNavigationWaiterGuard {
                    label: label.clone(),
                    token: token.clone(),
                };
            }
            assert!(!BROWSER_NAVIGATION_WAITERS.lock().contains_key(&label));

            BROWSER_NAVIGATION_WAITERS.lock().insert(
                label.clone(),
                browser_navigation_waiter("https://example.test"),
            );
            {
                let _old_guard = BrowserNavigationWaiterGuard {
                    label: label.clone(),
                    token,
                };
            }
            assert!(BROWSER_NAVIGATION_WAITERS.lock().contains_key(&label));
            BROWSER_NAVIGATION_WAITERS.lock().remove(&label);
        }
    }

    #[test]
    fn browser_navigation_setup_failure_closes_only_a_newly_created_view() {
        let closes = AtomicUsize::new(0);
        cleanup_created_browser_after_setup_failure(true, || {
            closes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
        assert_eq!(closes.load(Ordering::SeqCst), 1);

        cleanup_created_browser_after_setup_failure(false, || {
            closes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
        assert_eq!(closes.load(Ordering::SeqCst), 1);
    }

    fn assert_no_output_fields(value: &serde_json::Value) {
        match value {
            serde_json::Value::Array(values) => {
                for value in values {
                    assert_no_output_fields(value);
                }
            }
            serde_json::Value::Object(values) => {
                for (key, value) in values {
                    assert!(!matches!(key.as_str(), "bytes" | "data" | "payload"));
                    assert_no_output_fields(value);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn pty_reader_enqueues_raw_bytes_for_the_batch_worker() {
        let pump = pty_transport::OutputPump::new("reader-test".to_string()).unwrap();
        pump_pty_reader(Cursor::new(b"ordered pty bytes".to_vec()), pump.clone()).unwrap();

        let mut emitted = None;
        assert_eq!(
            pump.emit_ready(|event| {
                emitted = Some((event.thread_id.clone(), event.sequence, event.bytes.clone()));
                Ok(())
            }),
            Ok(pty_transport::EmitOutcome::Emitted { sequence: 1 })
        );
        assert_eq!(
            emitted,
            Some(("reader-test".to_string(), 1, b"ordered pty bytes".to_vec()))
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_reader_cancellation_releases_a_blocked_pty_read() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 10,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let (mut reader, reader_cancellation) = prepare_pty_reader(pair.master.as_ref()).unwrap();
        let (reader_tx, reader_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = reader_tx.send(reader.read_to_end(&mut bytes));
        });

        assert!(matches!(
            reader_rx.recv_timeout(Duration::from_millis(25)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        reader_cancellation.cancel().unwrap();
        reader_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("reader cancellation must release the blocked PTY read")
            .expect("cancelled PTY reader must exit cleanly");

        drop(pair.slave);
        drop(pair.master);
    }

    #[cfg(windows)]
    #[test]
    fn windows_reader_cancellation_releases_a_blocked_pty_read() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 10,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let (mut reader, reader_cancellation) = prepare_pty_reader(pair.master.as_ref()).unwrap();
        let reader_cancellation_for_thread = reader_cancellation.clone();
        let (reader_tx, reader_rx) = mpsc::channel();
        std::thread::spawn(move || {
            reader_cancellation_for_thread
                .install_current_thread()
                .expect("reader thread handle must be retained");
            let mut bytes = Vec::new();
            let _ = reader_tx.send(reader.read_to_end(&mut bytes));
        });

        assert!(matches!(
            reader_rx.recv_timeout(Duration::from_millis(25)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        reader_cancellation.cancel().unwrap();
        reader_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("reader cancellation must release the blocked PTY read")
            .expect("cancelled PTY reader must exit cleanly");

        drop(pair.slave);
        drop(pair.master);
    }

    #[cfg(not(windows))]
    #[test]
    fn pty_ack_reports_missing_invalid_duplicate_future_and_skipped_sequences() {
        assert_eq!(
            pty_ack_inner("missing-pane".to_string(), 1, None).unwrap_err(),
            "thread 'missing-pane' not found"
        );
        assert_eq!(
            pty_ack_inner("../unsafe".to_string(), 1, None).unwrap_err(),
            "thread id is unsafe"
        );

        let session = TestLivePtySession::register("ack-pane");
        session.pump.enqueue(vec![b'a']).unwrap();
        assert_eq!(
            session.pump.emit_ready(|_| Ok(())),
            Ok(pty_transport::EmitOutcome::Emitted { sequence: 1 })
        );
        session.pump.enqueue(vec![b'b']).unwrap();
        std::thread::sleep(pty_transport::VISIBLE_CADENCE + Duration::from_millis(5));
        assert_eq!(
            session.pump.emit_ready(|_| Ok(())),
            Ok(pty_transport::EmitOutcome::Emitted { sequence: 2 })
        );

        assert!(matches!(
            pty_ack_inner("ack-pane".to_string(), 1, Some(session.token.generation)).unwrap(),
            AckOutcome::Advanced {
                sequence: 1,
                bytes: 1,
                latency_micros,
            } if latency_micros >= duration_to_micros(pty_transport::VISIBLE_CADENCE)
        ));
        assert_eq!(
            pty_ack_inner("ack-pane".to_string(), 1, Some(session.token.generation)).unwrap(),
            AckOutcome::Duplicate { sequence: 1 }
        );
        assert!(matches!(
            pty_ack_inner("ack-pane".to_string(), 2, Some(session.token.generation)).unwrap(),
            AckOutcome::Advanced {
                sequence: 2,
                bytes: 1,
                ..
            }
        ));

        let skipped = TestLivePtySession::register("ack-skipped-pane");
        skipped.pump.enqueue(vec![b'a']).unwrap();
        assert_eq!(
            skipped.pump.emit_ready(|_| Ok(())),
            Ok(pty_transport::EmitOutcome::Emitted { sequence: 1 })
        );
        skipped.pump.enqueue(vec![b'b']).unwrap();
        std::thread::sleep(pty_transport::VISIBLE_CADENCE + Duration::from_millis(5));
        assert_eq!(
            skipped.pump.emit_ready(|_| Ok(())),
            Ok(pty_transport::EmitOutcome::Emitted { sequence: 2 })
        );
        assert_eq!(
            pty_ack_inner(
                "ack-skipped-pane".to_string(),
                2,
                Some(skipped.token.generation),
            )
            .unwrap_err(),
            "PTY batch acknowledgement 2 skipped expected sequence 1"
        );
        assert_eq!(
            pty_ack_inner(
                "ack-skipped-pane".to_string(),
                3,
                Some(skipped.token.generation),
            )
            .unwrap_err(),
            "PTY batch acknowledgement 3 is newer than emitted sequence 2"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn pty_set_visibility_only_updates_metrics_on_actual_transitions() {
        assert_eq!(
            pty_set_visibility_inner("missing-visibility".to_string(), false, None).unwrap_err(),
            "thread 'missing-visibility' not found"
        );

        let session = TestLivePtySession::register("visibility-pane");
        let visible_cadence = duration_to_micros(pty_transport::VISIBLE_CADENCE);
        let hidden_cadence = duration_to_micros(pty_transport::HIDDEN_CADENCE);

        let initial = pty_transport_metrics_inner(Some("visibility-pane".to_string()))
            .pop()
            .unwrap();
        assert_eq!(initial.visibility, PtyTransportVisibility::Visible);
        assert_eq!(initial.effective_cadence_micros, visible_cadence);
        assert_eq!(initial.metrics.visibility_transition_count, 0);

        pty_set_visibility_inner(
            "visibility-pane".to_string(),
            true,
            Some(session.token.generation),
        )
        .unwrap();
        let noop_visible = pty_transport_metrics_inner(Some("visibility-pane".to_string()))
            .pop()
            .unwrap();
        assert_eq!(noop_visible.visibility, PtyTransportVisibility::Visible);
        assert_eq!(noop_visible.effective_cadence_micros, visible_cadence);
        assert_eq!(noop_visible.metrics.visibility_transition_count, 0);

        pty_set_visibility_inner(
            "visibility-pane".to_string(),
            false,
            Some(session.token.generation),
        )
        .unwrap();
        let hidden = pty_transport_metrics_inner(Some("visibility-pane".to_string()))
            .pop()
            .unwrap();
        assert_eq!(hidden.visibility, PtyTransportVisibility::Hidden);
        assert_eq!(hidden.effective_cadence_micros, hidden_cadence);
        assert_eq!(hidden.metrics.visibility_transition_count, 1);

        pty_set_visibility_inner(
            "visibility-pane".to_string(),
            false,
            Some(session.token.generation),
        )
        .unwrap();
        let noop_hidden = pty_transport_metrics_inner(Some("visibility-pane".to_string()))
            .pop()
            .unwrap();
        assert_eq!(noop_hidden.visibility, PtyTransportVisibility::Hidden);
        assert_eq!(noop_hidden.effective_cadence_micros, hidden_cadence);
        assert_eq!(noop_hidden.metrics.visibility_transition_count, 1);

        drop(session);
    }

    #[cfg(not(windows))]
    #[test]
    fn pty_transport_metrics_filters_live_sessions_and_serializes_metadata_only() {
        let owned_ids = ["metrics-a", "metrics-b"];
        let first = TestLivePtySession::register("metrics-a");
        let second = TestLivePtySession::register("metrics-b");
        first.pump.enqueue(b"secret-metadata".to_vec()).unwrap();

        let mut filtered = pty_transport_metrics_inner(Some("metrics-a".to_string()));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].thread_id, "metrics-a");
        assert_eq!(filtered[0].pending_bytes, b"secret-metadata".len());
        assert_eq!(
            filtered[0].metrics.state.bytes_accepted,
            b"secret-metadata".len() as u64
        );
        assert!(pty_transport_metrics_inner(Some("metrics-missing".to_string())).is_empty());
        assert!(pty_transport_metrics_inner(Some("../unsafe".to_string())).is_empty());

        let all = pty_transport_metrics_inner(None);
        let owned_from_all = all
            .into_iter()
            .filter(|snapshot| owned_ids.contains(&snapshot.thread_id.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            owned_from_all
                .iter()
                .map(|snapshot| snapshot.thread_id.as_str())
                .collect::<Vec<_>>(),
            vec!["metrics-a", "metrics-b"]
        );
        assert_eq!(
            owned_from_all
                .iter()
                .find(|snapshot| snapshot.thread_id == "metrics-a")
                .unwrap(),
            &filtered[0]
        );

        let serialized = serde_json::to_value(filtered.pop().unwrap()).unwrap();
        assert_no_output_fields(&serialized);
        assert!(!serialized.to_string().contains("secret-metadata"));

        drop(second);
        assert!(pty_transport_metrics_inner(Some("metrics-b".to_string())).is_empty());
        drop(first);
        assert!(pty_transport_metrics_inner(Some("metrics-a".to_string())).is_empty());
        assert!(pty_transport_metrics_inner(None)
            .into_iter()
            .all(|snapshot| !owned_ids.contains(&snapshot.thread_id.as_str())));
    }
}

#[cfg(test)]
pub(crate) mod workspace_panel_tests {
    use super::*;
    use std::ffi::{OsStr, OsString};
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[cfg(windows)]
    use std::os::windows::fs::{symlink_dir, symlink_file};
    use std::time::{SystemTime, UNIX_EPOCH};

    pub(crate) fn path_text(path: &Path) -> &str {
        path.to_str().expect("test paths must be UTF-8")
    }

    pub(crate) struct TempTree {
        pub(crate) root: PathBuf,
    }

    impl TempTree {
        pub(crate) fn new(label: &str) -> Self {
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

    pub(crate) fn shell_single_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    #[cfg(unix)]
    fn write_test_executable(path: &Path, mode: u32) {
        std::fs::write(path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    pub(crate) fn write_marker_executable(path: &Path) {
        std::fs::write(
            path,
            "#!/bin/sh\n: \"${PSYCHE_TEST_MARKER:?missing marker}\"\ntouch \"$PSYCHE_TEST_MARKER\"\n",
        )
        .unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    // Git invokes configured helpers through a POSIX shell on every platform,
    // including Git for Windows. Forward slashes are required so the git config
    // parser does not interpret backslashes as escape sequences (bad config
    // line) and so the shell resolves the helper path.
    pub(crate) fn shell_path(path: &Path) -> String {
        path_text(path).replace('\\', "/")
    }

    pub(crate) fn marker_command(helper: &Path, marker: &Path) -> String {
        format!(
            "PSYCHE_TEST_MARKER={} {}",
            shell_single_quote(&shell_path(marker)),
            shell_single_quote(&shell_path(helper))
        )
    }

    pub(crate) fn trusted_normalizing_clean_command() -> &'static str {
        "sed -e 's/[[:space:]]*$//'"
    }

    #[derive(Clone, Copy)]
    pub(crate) enum TestSymlinkKind {
        Directory,
        File,
    }

    fn can_skip_symlink_test(error: &std::io::Error) -> bool {
        matches!(
            error.kind(),
            std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Unsupported
        ) || matches!(error.raw_os_error(), Some(1314))
    }

    pub(crate) fn create_test_symlink(kind: TestSymlinkKind, target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        let result = {
            let _ = kind;
            symlink(target, link)
        };
        #[cfg(windows)]
        let result = match kind {
            TestSymlinkKind::Directory => symlink_dir(target, link),
            TestSymlinkKind::File => symlink_file(target, link),
        };
        #[cfg(all(not(unix), not(windows)))]
        let result: std::io::Result<()> = {
            let _ = (kind, target, link);
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "symlinks unsupported on this target",
            ))
        };
        match result {
            Ok(()) => true,
            Err(error) if can_skip_symlink_test(&error) => false,
            Err(error) => panic!(
                "create test symlink '{}' -> '{}': {error}",
                link.display(),
                target.display()
            ),
        }
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

    #[test]
    fn appends_windows_pathext_entries_to_extensionless_executable_names() {
        let extensions = [
            OsString::from(".COM"),
            OsString::from(".EXE"),
            OsString::from(".CMD"),
        ];

        assert_eq!(
            executable_names_with_extensions(OsStr::new("node"), &extensions),
            vec![
                OsString::from("node.COM"),
                OsString::from("node.EXE"),
                OsString::from("node.CMD"),
            ]
        );
    }

    #[test]
    fn preserves_an_explicit_windows_executable_extension() {
        let extensions = [OsString::from(".EXE"), OsString::from(".CMD")];

        assert_eq!(
            executable_names_with_extensions(OsStr::new("coven.cmd"), &extensions),
            vec![OsString::from("coven.cmd")]
        );
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

    fn native_code_options(
        session_id: Option<&str>,
        command: Option<&str>,
        args: Option<&[&str]>,
    ) -> StartOptions {
        launch_options_with_env(Some("coven-code"), session_id, command, args, None)
    }

    #[test]
    fn accepts_exact_native_coven_code_and_attach_launches() {
        let coven = "/canonical/bin/coven";
        let session_id = "12345678-1234-4abc-8def-1234567890ab";
        let code = native_code_options(None, Some(coven), Some(&[]));
        let attach = launch_options(
            Some("coven-attach"),
            Some(session_id),
            Some(coven),
            Some(&["attach", session_id]),
        );

        assert_eq!(validate_coven_launch_with(&code, Some(coven)), Ok(()));
        assert_eq!(validate_coven_launch_with(&attach, Some(coven)), Ok(()));
    }

    #[test]
    fn rejects_legacy_native_coven_chat_launch_kind_after_workspace_migration() {
        let legacy = launch_options_with_env(
            Some("coven-chat"),
            None,
            Some("/canonical/bin/coven"),
            None,
            Some(&[]),
        );

        assert_eq!(
            validate_coven_launch_with(&legacy, Some("/canonical/bin/coven")),
            Err("unsupported launch kind: coven-chat".to_string())
        );
    }

    #[test]
    fn rejects_invalid_native_coven_launch_environments() {
        let coven = "/canonical/bin/coven";
        let code_envs = [
            Some(&[("COVEN_SESSION_SOURCE", "psyche-build")][..]),
            Some(&[("OTHER", "value")][..]),
            Some(&[("COVEN_SESSION_SOURCE", "psyche-build"), ("OTHER", "value")][..]),
        ];
        for env in code_envs {
            let code =
                launch_options_with_env(Some("coven-code"), None, Some(coven), Some(&[]), env);
            assert_eq!(
                validate_coven_launch_with(&code, Some(coven)),
                Err("coven-code does not accept launch environment entries".to_string())
            );
        }

        let no_env_code =
            launch_options_with_env(Some("coven-code"), None, Some(coven), None, None);
        assert_eq!(
            validate_coven_launch_with(&no_env_code, Some(coven)),
            Ok(())
        );

        let empty_env_code =
            launch_options_with_env(Some("coven-code"), None, Some(coven), Some(&[]), Some(&[]));
        assert_eq!(
            validate_coven_launch_with(&empty_env_code, Some(coven)),
            Ok(())
        );

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
    fn scrubs_inherited_coven_source_from_native_coven_launches() {
        let mut code_without_env = CommandBuilder::new("/bin/coven");
        code_without_env.env(COVEN_SESSION_SOURCE, "psyche-build");
        apply_launch_env(&mut code_without_env, None, Some("coven-code"));
        assert_eq!(code_without_env.get_env(COVEN_SESSION_SOURCE), None);

        let empty_env = HashMap::new();
        let mut code_with_empty_env = CommandBuilder::new("/bin/coven");
        code_with_empty_env.env(COVEN_SESSION_SOURCE, "psyche-build");
        apply_launch_env(
            &mut code_with_empty_env,
            Some(&empty_env),
            Some("coven-code"),
        );
        assert_eq!(code_with_empty_env.get_env(COVEN_SESSION_SOURCE), None);

        let mut attach_without_env = CommandBuilder::new("/bin/coven");
        attach_without_env.env(COVEN_SESSION_SOURCE, "psyche-build");
        apply_launch_env(&mut attach_without_env, None, Some("coven-attach"));
        assert_eq!(attach_without_env.get_env(COVEN_SESSION_SOURCE), None);

        let mut attach_with_empty_env = CommandBuilder::new("/bin/coven");
        attach_with_empty_env.env(COVEN_SESSION_SOURCE, "psyche-build");
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
                native_code_options(Some(session_id), Some(coven), None),
                "coven-code does not accept a session id",
            ),
            (
                native_code_options(
                    None,
                    Some(coven),
                    Some(&["code", "--session-id", session_id]),
                ),
                "coven-code does not accept launch arguments",
            ),
            (
                native_code_options(
                    Some(session_id),
                    Some(coven),
                    Some(&[
                        "code",
                        "--session-id",
                        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    ]),
                ),
                "coven-code does not accept a session id",
            ),
            (
                native_code_options(Some("../unsafe"), Some(coven), None),
                "coven-code does not accept a session id",
            ),
            (
                native_code_options(None, Some("/wrong/coven"), Some(&[])),
                "Coven launch command does not match the resolved executable",
            ),
            (
                native_code_options(None, Some(coven), Some(&["code", session_id])),
                "coven-code does not accept launch arguments",
            ),
            (
                native_code_options(
                    None,
                    Some(coven),
                    Some(&["code", "--session-id", session_id, "extra"]),
                ),
                "coven-code does not accept launch arguments",
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
        let code = native_code_options(None, Some(coven), Some(&[]));
        assert_eq!(
            validate_coven_launch_with(&code, None),
            Err("Coven executable not found".to_string())
        );
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
        #[cfg(unix)]
        {
            assert!(relative_error.contains("outside project root"));
            assert!(absolute_error.contains("outside project root"));
        }
        #[cfg(not(unix))]
        {
            assert!(relative_error.contains("require POSIX descriptor-relative operations"));
            assert!(absolute_error.contains("require POSIX descriptor-relative operations"));
        }
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

    #[cfg(unix)]
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

    #[cfg(unix)]
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
        #[cfg(unix)]
        assert!(error.contains("file is not valid UTF-8"));
        #[cfg(not(unix))]
        assert!(error.contains("require POSIX descriptor-relative operations"));
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
}
