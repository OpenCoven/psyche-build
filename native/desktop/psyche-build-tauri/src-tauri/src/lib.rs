use std::borrow::Cow;
#[cfg(test)]
use std::cell::RefCell;
use std::collections::HashMap;
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
#[cfg(unix)]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU64, Ordering};
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
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl,
};
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
mod browser_focus;
mod control_provider;
mod coven_sessions;
mod metrics;
mod native_sessions;
mod native_workspace;
mod pane_metrics;
mod platform;
pub mod pty_transport;
mod workspace_contract;
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
use coven_sessions::{coven_session_kill, coven_sessions};
use metrics::{MetricsCollector, MetricsScope, MetricsSnapshot, TrackedPty};
use native_sessions::{
    native_session_capture, native_session_create, native_session_list, native_session_stop,
    NativeLaunchKind, NativeSessionCreate,
};
use native_workspace::{workspace_load, workspace_save};
use pane_metrics::PaneSessionMetrics;
use pty_transport::{
    coordinate_exit_shutdown, AckOutcome as TransportAckOutcome, CompletionOutcome, DrainOutcome,
    EnqueueError, ExitShutdownHooks, ExitShutdownOutcome, FinalOutputPumpSnapshot, OutputPump,
    OutputPumpMetrics as TransportOutputPumpMetrics,
    OutputPumpSnapshot as TransportOutputPumpSnapshot, PaneVisibility as TransportPaneVisibility,
    PumpMetrics as TransportPumpMetrics, RecentOutputSnapshots, TransportSessionKey,
    EXIT_DRAIN_TIMEOUT, EXIT_TERMINATION_CLEANUP_TIMEOUT,
};

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
const PSYCHE_SESSION_SOURCE: &str = "psyche-build";

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

struct PtySession {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    operation_lane: Arc<tokio::sync::Mutex<()>>,
    operation_admission: Arc<tokio::sync::Semaphore>,
    pump: OutputPump,
    terminator: PtyProcessTerminator,
    reader_cancellation: PtyReaderCancellation,
    pid: Option<u32>,
    spawn_time_unix_secs: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PtySessionToken {
    thread_id: String,
    generation: u64,
}

#[derive(Debug)]
enum PtyLifecycleState<T> {
    Starting { stop_requested: bool },
    Running(T),
    Stopping,
    Exiting,
}

#[derive(Debug)]
struct PtyLifecycleEntry<T> {
    generation: u64,
    state: PtyLifecycleState<T>,
}

#[derive(Debug)]
struct PtyLifecycleRegistry<T> {
    next_generation: u64,
    entries: HashMap<String, PtyLifecycleEntry<T>>,
}

impl<T> Default for PtyLifecycleRegistry<T> {
    fn default() -> Self {
        Self {
            next_generation: 1,
            entries: HashMap::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PtyLifecycleError {
    AlreadyRunning { thread_id: String },
    CleanupInProgress { thread_id: String },
    GenerationExhausted,
    StaleStart { thread_id: String, generation: u64 },
    NotFound { thread_id: String },
    AlreadyStopping { thread_id: String, generation: u64 },
}

impl std::fmt::Display for PtyLifecycleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyRunning { thread_id } => {
                write!(formatter, "thread '{thread_id}' already running")
            }
            Self::CleanupInProgress { thread_id } => {
                write!(formatter, "thread '{thread_id}' cleanup in progress")
            }
            Self::GenerationExhausted => formatter.write_str("PTY session generation exhausted"),
            Self::StaleStart {
                thread_id,
                generation,
            } => write!(
                formatter,
                "thread '{thread_id}' start generation {generation} is stale"
            ),
            Self::NotFound { thread_id } => write!(formatter, "thread '{thread_id}' not found"),
            Self::AlreadyStopping {
                thread_id,
                generation,
            } => write!(
                formatter,
                "thread '{thread_id}' generation {generation} is already stopping"
            ),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum InstallSessionOutcome<T> {
    Running,
    StopImmediately(T),
}

#[derive(Debug, PartialEq, Eq)]
enum StopSessionOutcome<T> {
    RecordedDuringStart { generation: u64 },
    Terminate { generation: u64, session: T },
}

#[derive(Debug, PartialEq, Eq)]
enum BeginExitOutcome<T> {
    Emit { session: Option<T> },
    Stale,
}

impl<T> PtyLifecycleRegistry<T> {
    fn reserve(&mut self, thread_id: &str) -> Result<PtySessionToken, PtyLifecycleError> {
        if let Some(entry) = self.entries.get(thread_id) {
            return Err(match entry.state {
                PtyLifecycleState::Exiting => PtyLifecycleError::CleanupInProgress {
                    thread_id: thread_id.to_string(),
                },
                _ => PtyLifecycleError::AlreadyRunning {
                    thread_id: thread_id.to_string(),
                },
            });
        }
        let generation = self.next_generation;
        self.next_generation = self
            .next_generation
            .checked_add(1)
            .ok_or(PtyLifecycleError::GenerationExhausted)?;
        self.entries.insert(
            thread_id.to_string(),
            PtyLifecycleEntry {
                generation,
                state: PtyLifecycleState::Starting {
                    stop_requested: false,
                },
            },
        );
        Ok(PtySessionToken {
            thread_id: thread_id.to_string(),
            generation,
        })
    }

    fn install(
        &mut self,
        token: &PtySessionToken,
        session: T,
    ) -> Result<InstallSessionOutcome<T>, PtyLifecycleError> {
        let entry = self
            .entries
            .get_mut(&token.thread_id)
            .filter(|entry| entry.generation == token.generation)
            .ok_or_else(|| PtyLifecycleError::StaleStart {
                thread_id: token.thread_id.clone(),
                generation: token.generation,
            })?;
        match entry.state {
            PtyLifecycleState::Starting {
                stop_requested: true,
            } => {
                entry.state = PtyLifecycleState::Stopping;
                Ok(InstallSessionOutcome::StopImmediately(session))
            }
            PtyLifecycleState::Starting {
                stop_requested: false,
            } => {
                entry.state = PtyLifecycleState::Running(session);
                Ok(InstallSessionOutcome::Running)
            }
            _ => Err(PtyLifecycleError::StaleStart {
                thread_id: token.thread_id.clone(),
                generation: token.generation,
            }),
        }
    }

    fn stop(&mut self, thread_id: &str) -> Result<StopSessionOutcome<T>, PtyLifecycleError> {
        let entry = self
            .entries
            .get_mut(thread_id)
            .ok_or_else(|| PtyLifecycleError::NotFound {
                thread_id: thread_id.to_string(),
            })?;
        match &mut entry.state {
            PtyLifecycleState::Starting { stop_requested } => {
                *stop_requested = true;
                Ok(StopSessionOutcome::RecordedDuringStart {
                    generation: entry.generation,
                })
            }
            PtyLifecycleState::Running(_) => {
                let state = std::mem::replace(&mut entry.state, PtyLifecycleState::Stopping);
                let PtyLifecycleState::Running(session) = state else {
                    unreachable!("running PTY state was checked before replacement");
                };
                Ok(StopSessionOutcome::Terminate {
                    generation: entry.generation,
                    session,
                })
            }
            PtyLifecycleState::Stopping | PtyLifecycleState::Exiting => {
                Err(PtyLifecycleError::AlreadyStopping {
                    thread_id: thread_id.to_string(),
                    generation: entry.generation,
                })
            }
        }
    }

    fn begin_exit(&mut self, token: &PtySessionToken) -> BeginExitOutcome<T> {
        let Some(entry) = self
            .entries
            .get_mut(&token.thread_id)
            .filter(|entry| entry.generation == token.generation)
        else {
            return BeginExitOutcome::Stale;
        };
        match entry.state {
            PtyLifecycleState::Running(_) => {
                let state = std::mem::replace(&mut entry.state, PtyLifecycleState::Exiting);
                let PtyLifecycleState::Running(session) = state else {
                    unreachable!("running PTY state was checked before replacement");
                };
                BeginExitOutcome::Emit {
                    session: Some(session),
                }
            }
            PtyLifecycleState::Stopping => {
                entry.state = PtyLifecycleState::Exiting;
                BeginExitOutcome::Emit { session: None }
            }
            PtyLifecycleState::Starting { .. } | PtyLifecycleState::Exiting => {
                BeginExitOutcome::Stale
            }
        }
    }

    fn finish_exit(&mut self, token: &PtySessionToken) -> bool {
        let should_remove = self.entries.get(&token.thread_id).is_some_and(|entry| {
            entry.generation == token.generation
                && matches!(entry.state, PtyLifecycleState::Exiting)
        });
        if should_remove {
            self.entries.remove(&token.thread_id);
        }
        should_remove
    }

    fn abort_start(&mut self, token: &PtySessionToken) -> bool {
        let should_remove = self.entries.get(&token.thread_id).is_some_and(|entry| {
            entry.generation == token.generation
                && matches!(entry.state, PtyLifecycleState::Starting { .. })
        });
        if should_remove {
            self.entries.remove(&token.thread_id);
        }
        should_remove
    }

    fn live(&self, thread_id: &str) -> Option<&T> {
        self.entries
            .get(thread_id)
            .and_then(|entry| match &entry.state {
                PtyLifecycleState::Running(session) => Some(session),
                _ => None,
            })
    }

    #[cfg(test)]
    fn is_live(&self, thread_id: &str) -> bool {
        self.live(thread_id).is_some()
    }

    fn live_sessions(&self) -> Vec<(&String, &T)> {
        self.entries
            .iter()
            .filter_map(|(thread_id, entry)| match &entry.state {
                PtyLifecycleState::Running(session) => Some((thread_id, session)),
                _ => None,
            })
            .collect()
    }

    fn live_thread_ids(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter_map(|(thread_id, entry)| {
                matches!(entry.state, PtyLifecycleState::Running(_)).then(|| thread_id.clone())
            })
            .collect()
    }
}

static PTY_LIFECYCLES: Lazy<Mutex<PtyLifecycleRegistry<PtySession>>> =
    Lazy::new(|| Mutex::new(PtyLifecycleRegistry::default()));
static RECENT_PTY_SNAPSHOTS: Lazy<Mutex<RecentOutputSnapshots>> =
    Lazy::new(|| Mutex::new(RecentOutputSnapshots::default()));

#[derive(Debug)]
enum PtyProcessTerminatorSetupError {
    Message(String),
}

impl std::fmt::Display for PtyProcessTerminatorSetupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Message(message) => formatter.write_str(message),
        }
    }
}

#[cfg(windows)]
#[derive(Debug)]
struct WindowsProcessTreeKiller {
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[cfg(windows)]
impl WindowsProcessTreeKiller {
    fn new(killer: Box<dyn ChildKiller + Send + Sync>) -> Self {
        Self {
            killer: Mutex::new(killer),
        }
    }

    fn terminate(&self) -> std::io::Result<()> {
        self.killer.lock().kill()
    }
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct UnixPtyIdentity {
    session_id: libc::pid_t,
    original_process_group: libc::pid_t,
}

#[cfg(unix)]
#[derive(Debug)]
struct UnixPtyControl {
    descriptor: OwnedFd,
}

#[cfg(unix)]
impl UnixPtyControl {
    fn retain(master: &dyn MasterPty) -> std::io::Result<Self> {
        let descriptor = master.as_raw_fd().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Unix PTY master did not expose its control descriptor",
            )
        })?;
        Ok(Self {
            descriptor: duplicate_cloexec_fd(descriptor)?,
        })
    }

    fn descriptor(&self) -> RawFd {
        self.descriptor.as_raw_fd()
    }
}

#[cfg(unix)]
trait UnixTerminationPlatform: Send + Sync {
    fn observe_termination(
        &self,
        identity: UnixPtyIdentity,
    ) -> std::io::Result<Option<UnixTerminationObservation>>;

    fn signal_process_group(
        &self,
        process_group: libc::pid_t,
        signal: libc::c_int,
    ) -> std::io::Result<()>;
}

#[cfg(unix)]
impl UnixTerminationPlatform for UnixPtyControl {
    fn observe_termination(
        &self,
        identity: UnixPtyIdentity,
    ) -> std::io::Result<Option<UnixTerminationObservation>> {
        let current_pid = unsafe { libc::getpid() };
        let current_process_group = unsafe { libc::getpgrp() };
        let current_session = checked_unix_pid("getsid(0)", unsafe { libc::getsid(0) })?;
        let Some(tty_session) =
            optional_unix_tty_pid("tcgetsid", unsafe { libc::tcgetsid(self.descriptor()) })?
        else {
            return Ok(None);
        };
        let Some(foreground_process_group) =
            optional_unix_tty_pid("tcgetpgrp", unsafe { libc::tcgetpgrp(self.descriptor()) })?
        else {
            return Ok(None);
        };
        let foreground_session =
            optional_unix_process_pid("getsid(foreground group leader)", unsafe {
                libc::getsid(foreground_process_group)
            })?;
        let foreground_group =
            optional_unix_process_pid("getpgid(foreground group leader)", unsafe {
                libc::getpgid(foreground_process_group)
            })?;
        let (original_session, original_group) =
            if identity.original_process_group == foreground_process_group {
                (foreground_session, foreground_group)
            } else {
                (
                    optional_unix_process_pid("getsid(original group leader)", unsafe {
                        libc::getsid(identity.original_process_group)
                    })?,
                    optional_unix_process_pid("getpgid(original group leader)", unsafe {
                        libc::getpgid(identity.original_process_group)
                    })?,
                )
            };
        Ok(Some(UnixTerminationObservation {
            current_pid,
            current_process_group,
            current_session,
            tty_session,
            foreground_process_group,
            foreground_session,
            foreground_group,
            original_session,
            original_group,
        }))
    }

    fn signal_process_group(
        &self,
        process_group: libc::pid_t,
        signal: libc::c_int,
    ) -> std::io::Result<()> {
        signal_unix_process_group(process_group, signal)
    }
}

#[cfg(unix)]
fn checked_unix_pid(operation: &str, result: libc::pid_t) -> std::io::Result<libc::pid_t> {
    if result > 0 {
        Ok(result)
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{operation} failed: {}", std::io::Error::last_os_error()),
        ))
    }
}

#[cfg(unix)]
fn optional_unix_process_pid(
    operation: &str,
    result: libc::pid_t,
) -> std::io::Result<Option<libc::pid_t>> {
    if result > 0 {
        return Ok(Some(result));
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(None)
    } else {
        Err(std::io::Error::new(
            error.kind(),
            format!("{operation} failed: {error}"),
        ))
    }
}

#[cfg(unix)]
fn optional_unix_tty_pid(
    operation: &str,
    result: libc::pid_t,
) -> std::io::Result<Option<libc::pid_t>> {
    if result > 0 {
        return Ok(Some(result));
    }
    let error = std::io::Error::last_os_error();
    if matches!(
        error.raw_os_error(),
        Some(libc::ESRCH) | Some(libc::ENOTTY) | Some(libc::EIO) | Some(libc::ENXIO)
    ) {
        Ok(None)
    } else {
        Err(std::io::Error::new(
            error.kind(),
            format!("{operation} failed: {error}"),
        ))
    }
}

#[cfg(unix)]
impl UnixPtyIdentity {
    fn from_spawned_child(
        child_pid: Option<u32>,
        master: &dyn MasterPty,
        control: &UnixPtyControl,
    ) -> std::io::Result<Self> {
        let child_pid = child_pid
            .and_then(|pid| libc::pid_t::try_from(pid).ok())
            .filter(|pid| *pid > 1)
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "spawned PTY child did not expose a valid Unix process id",
                )
            })?;
        let current_pid = unsafe { libc::getpid() };
        let current_process_group = unsafe { libc::getpgrp() };
        let current_session = checked_unix_pid("getsid(0)", unsafe { libc::getsid(0) })?;
        let tty_session =
            checked_unix_pid("tcgetsid", unsafe { libc::tcgetsid(control.descriptor()) })?;
        let child_session = checked_unix_pid("getsid(child)", unsafe { libc::getsid(child_pid) })?;
        let child_process_group =
            checked_unix_pid("getpgid(child)", unsafe { libc::getpgid(child_pid) })?;
        let initial_foreground = master.process_group_leader().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Unix PTY master did not expose its foreground process group",
            )
        })?;
        let initial_foreground_session = checked_unix_pid("getsid(initial foreground)", unsafe {
            libc::getsid(initial_foreground)
        })?;
        let initial_foreground_group = checked_unix_pid("getpgid(initial foreground)", unsafe {
            libc::getpgid(initial_foreground)
        })?;

        if child_pid == current_pid
            || child_process_group == current_process_group
            || child_session == current_session
            || child_session != child_pid
            || child_process_group != child_pid
            || tty_session != child_pid
            || initial_foreground <= 1
            || initial_foreground_session != child_pid
            || initial_foreground_group != initial_foreground
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "spawned PTY process/session ownership could not be verified",
            ));
        }

        Ok(Self {
            session_id: child_session,
            original_process_group: child_process_group,
        })
    }
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct UnixTerminationObservation {
    current_pid: libc::pid_t,
    current_process_group: libc::pid_t,
    current_session: libc::pid_t,
    tty_session: libc::pid_t,
    foreground_process_group: libc::pid_t,
    foreground_session: Option<libc::pid_t>,
    foreground_group: Option<libc::pid_t>,
    original_session: Option<libc::pid_t>,
    original_group: Option<libc::pid_t>,
}

#[cfg(unix)]
fn verified_unix_process_groups(
    identity: UnixPtyIdentity,
    observation: UnixTerminationObservation,
) -> std::io::Result<Vec<libc::pid_t>> {
    // The per-group session checks below establish ownership. Some PTYs report
    // a changed terminal session while their foreground and original groups
    // still independently prove they belong to this spawned session.
    if observation.current_pid <= 1
        || observation.tty_session <= 1
        || identity.session_id <= 1
        || identity.original_process_group != identity.session_id
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "PTY control descriptor no longer belongs to the spawned PTY session",
        ));
    }

    let foreground = observation.foreground_process_group;
    let candidates = [
        (
            foreground,
            observation.foreground_session,
            observation.foreground_group,
        ),
        (
            identity.original_process_group,
            observation.original_session,
            observation.original_group,
        ),
    ];
    let mut groups = Vec::with_capacity(2);
    for (group, observed_session, observed_group) in candidates {
        if groups.contains(&group) {
            continue;
        }
        if group <= 1
            || group == observation.current_pid
            || group == observation.current_process_group
            || group == observation.current_session
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "refusing to signal Psyche's own process or an invalid process group",
            ));
        }
        if identity.session_id == observation.current_session {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "spawned PTY session unexpectedly matches Psyche's own session",
            ));
        }
        match (observed_session, observed_group) {
            (None, _) | (_, None) => continue,
            (Some(session), Some(observed_group))
                if session == identity.session_id && observed_group == group =>
            {
                groups.push(group);
            }
            _ => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "observed process group does not belong to the spawned PTY session",
                ));
            }
        }
    }
    Ok(groups)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PtyProcessIdentity {
    child_pid: Option<u32>,
    #[cfg(unix)]
    unix: Option<UnixPtyIdentity>,
}

impl PtyProcessIdentity {
    #[cfg(test)]
    fn direct_child(child_pid: Option<u32>) -> Self {
        Self {
            child_pid,
            #[cfg(unix)]
            unix: None,
        }
    }

    #[cfg(unix)]
    #[cfg(test)]
    fn confirmed_unix_process_group(&self) -> Option<libc::pid_t> {
        self.unix.map(|identity| identity.original_process_group)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PtyTerminationOutcome {
    NoProcess,
    DirectChild,
    #[cfg(windows)]
    ProcessTree,
    #[cfg(unix)]
    ConfirmedProcessGroups {
        foreground_process_group: libc::pid_t,
        original_process_group: libc::pid_t,
        group_count: usize,
    },
}

#[cfg(not(windows))]
enum RawPidFallbackState {
    Available(Box<dyn ChildKiller + Send + Sync>),
    Consumed,
    DisabledBeforeWait,
}

#[cfg(not(windows))]
struct RawPidFallback {
    state: Mutex<RawPidFallbackState>,
}

#[cfg(not(windows))]
impl RawPidFallback {
    fn new(killer: Box<dyn ChildKiller + Send + Sync>) -> Self {
        Self {
            state: Mutex::new(RawPidFallbackState::Available(killer)),
        }
    }

    fn disable_pid_fallback_before_wait(&self) {
        let mut state = self.state.lock();
        if matches!(*state, RawPidFallbackState::Available(_)) {
            *state = RawPidFallbackState::DisabledBeforeWait;
        }
    }

    fn invoke_once(&self) -> std::io::Result<bool> {
        let mut guard = self.state.lock();
        let state = std::mem::replace(&mut *guard, RawPidFallbackState::Consumed);
        let result = match state {
            RawPidFallbackState::Available(mut killer) => killer.kill().map(|()| true),
            RawPidFallbackState::Consumed => Ok(false),
            RawPidFallbackState::DisabledBeforeWait => {
                *guard = RawPidFallbackState::DisabledBeforeWait;
                Ok(false)
            }
        };
        drop(guard);
        result
    }
}

#[derive(Clone)]
struct PtyProcessTerminator {
    #[cfg(not(windows))]
    raw_pid_fallback: Arc<RawPidFallback>,
    #[cfg(unix)]
    unix_platform: Option<Arc<dyn UnixTerminationPlatform>>,
    #[cfg(windows)]
    process_tree: Arc<WindowsProcessTreeKiller>,
    identity: PtyProcessIdentity,
}

impl PtyProcessTerminator {
    fn from_spawned_child(
        child: &dyn Child,
        master: &dyn MasterPty,
    ) -> Result<Self, PtyProcessTerminatorSetupError> {
        let child_pid = child.process_id();
        #[cfg(windows)]
        {
            Ok(Self {
                process_tree: Arc::new(WindowsProcessTreeKiller::new(child.clone_killer())),
                identity: PtyProcessIdentity { child_pid },
            })
        }
        #[cfg(unix)]
        {
            let mut killer = child.clone_killer();
            let control = match UnixPtyControl::retain(master) {
                Ok(control) => control,
                Err(error) => {
                    let cleanup = terminate_unretained_unix_child(child_pid, killer.as_mut());
                    return Err(PtyProcessTerminatorSetupError::Message(
                        unix_terminator_setup_error(
                            "retain PTY control descriptor",
                            error,
                            cleanup,
                        ),
                    ));
                }
            };
            let unix_identity =
                match UnixPtyIdentity::from_spawned_child(child_pid, master, &control) {
                    Ok(identity) => identity,
                    Err(error) => {
                        let cleanup = terminate_unretained_unix_child(child_pid, killer.as_mut());
                        return Err(PtyProcessTerminatorSetupError::Message(
                            unix_terminator_setup_error(
                                "verify PTY process/session ownership",
                                error,
                                cleanup,
                            ),
                        ));
                    }
                };
            Ok(Self::from_unix_parts(
                killer,
                PtyProcessIdentity {
                    child_pid,
                    unix: Some(unix_identity),
                },
                Arc::new(control),
            ))
        }
        #[cfg(not(any(unix, windows)))]
        {
            Ok(Self::from_parts(
                child.clone_killer(),
                PtyProcessIdentity { child_pid },
            ))
        }
    }

    #[cfg(all(not(windows), any(test, not(unix))))]
    fn from_parts(
        killer: Box<dyn ChildKiller + Send + Sync>,
        identity: PtyProcessIdentity,
    ) -> Self {
        Self {
            raw_pid_fallback: Arc::new(RawPidFallback::new(killer)),
            #[cfg(unix)]
            unix_platform: None,
            identity,
        }
    }

    #[cfg(unix)]
    fn from_unix_parts(
        killer: Box<dyn ChildKiller + Send + Sync>,
        identity: PtyProcessIdentity,
        unix_platform: Arc<dyn UnixTerminationPlatform>,
    ) -> Self {
        Self {
            raw_pid_fallback: Arc::new(RawPidFallback::new(killer)),
            unix_platform: Some(unix_platform),
            identity,
        }
    }

    #[cfg(test)]
    fn identity(&self) -> PtyProcessIdentity {
        self.identity
    }

    fn disable_pid_fallback_before_wait(&self) {
        #[cfg(not(windows))]
        self.raw_pid_fallback.disable_pid_fallback_before_wait();
    }

    fn wait_for_child<T>(&self, wait: impl FnOnce() -> T) -> T {
        self.disable_pid_fallback_before_wait();
        wait()
    }

    fn terminate(&self) -> Result<PtyTerminationOutcome, String> {
        #[cfg(windows)]
        let result = terminate_platform_process(self.process_tree.as_ref(), self.identity);
        #[cfg(unix)]
        let result = terminate_platform_process(
            self.raw_pid_fallback.as_ref(),
            self.identity,
            self.unix_platform.as_deref(),
        );
        #[cfg(not(any(unix, windows)))]
        let result = match self.raw_pid_fallback.invoke_once() {
            Ok(true) => Ok(PtyTerminationOutcome::DirectChild),
            Ok(false) => Ok(PtyTerminationOutcome::NoProcess),
            Err(error) => Err(error),
        };
        result.map_err(|error| {
            format!(
                "failed to terminate PTY child {:?}: {error}",
                self.identity.child_pid
            )
        })
    }
}

#[cfg(unix)]
fn terminate_unretained_unix_child(
    child_pid: Option<u32>,
    killer: &mut dyn ChildKiller,
) -> std::io::Result<()> {
    let Some(pid) = child_pid.and_then(|pid| libc::pid_t::try_from(pid).ok()) else {
        return killer.kill();
    };
    if pid <= 1 || pid == unsafe { libc::getpid() } {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "refusing unsafe spawned-child cleanup",
        ));
    }
    let result = unsafe { libc::kill(pid, libc::SIGKILL) };
    if result == 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(error)
        }
    }
}

#[cfg(unix)]
fn unix_terminator_setup_error(
    operation: &str,
    error: std::io::Error,
    cleanup: std::io::Result<()>,
) -> String {
    match cleanup {
        Ok(()) => format!("failed to {operation}: {error}; spawned PTY child was terminated"),
        Err(cleanup_error) => format!(
            "failed to {operation}: {error}; spawned-child cleanup also failed: {cleanup_error}"
        ),
    }
}

struct PtySpawnTerminationGuard {
    terminator: Option<PtyProcessTerminator>,
}

impl PtySpawnTerminationGuard {
    fn new(terminator: PtyProcessTerminator) -> Self {
        Self {
            terminator: Some(terminator),
        }
    }

    fn disarm(&mut self) {
        self.terminator = None;
    }
}

impl Drop for PtySpawnTerminationGuard {
    fn drop(&mut self) {
        if let Some(terminator) = self.terminator.take() {
            if let Err(error) = terminator.terminate() {
                log::warn!("failed to terminate PTY after start setup error: {error}");
            }
        }
    }
}

#[cfg(unix)]
fn signal_unix_process_group(
    process_group: libc::pid_t,
    signal: libc::c_int,
) -> std::io::Result<()> {
    let result = unsafe { libc::kill(-process_group, signal) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(unix)]
fn unix_validation_error_with_fallback(
    error: std::io::Error,
    raw_pid_fallback: &RawPidFallback,
) -> std::io::Error {
    match raw_pid_fallback.invoke_once() {
        Ok(true) => std::io::Error::new(
            error.kind(),
            format!(
                "{error}; the one-shot direct-child fallback was requested, but group \
                 termination was not reported as successful"
            ),
        ),
        Ok(false) => error,
        Err(fallback_error) => std::io::Error::new(
            error.kind(),
            format!("{error}; direct-child fallback also failed: {fallback_error}"),
        ),
    }
}

#[cfg(unix)]
fn terminate_platform_process(
    raw_pid_fallback: &RawPidFallback,
    identity: PtyProcessIdentity,
    platform: Option<&dyn UnixTerminationPlatform>,
) -> std::io::Result<PtyTerminationOutcome> {
    let (Some(unix_identity), Some(platform)) = (identity.unix, platform) else {
        return match raw_pid_fallback.invoke_once()? {
            true => Ok(PtyTerminationOutcome::DirectChild),
            false => Ok(PtyTerminationOutcome::NoProcess),
        };
    };

    let mut reported_groups = None;
    let mut first_error = None;
    // Groups stay owned once verified. Re-observing between escalations exists to
    // pick up a foreground group that appeared after SIGHUP, not to re-earn the
    // right to signal groups already proven to belong to this PTY session.
    //
    // That distinction matters because the earlier signals are what tear the
    // session down: by SIGCONT or SIGKILL the leader may be gone, the terminal
    // disassociated, or the foreground group reaped, so observation legitimately
    // starts failing. Treating that as fatal aborted the escalation *before
    // SIGKILL* and reported a hard error for a session that was terminating
    // exactly as asked. Instead, fall back to the last verified set and finish
    // escalating; kill() on a group that has already exited reports ESRCH, which
    // signal_process_group folds into success.
    //
    // A failure before anything is verified is still fatal — nothing has been
    // proven ours at that point, so signalling would be a guess.
    let mut verified_groups: Option<Vec<libc::pid_t>> = None;
    for signal in [libc::SIGHUP, libc::SIGCONT, libc::SIGKILL] {
        let process_groups = match platform.observe_termination(unix_identity) {
            Ok(Some(observation)) => {
                match verified_unix_process_groups(unix_identity, observation) {
                    Ok(groups) => {
                        if reported_groups.is_none() && !groups.is_empty() {
                            reported_groups =
                                Some((observation.foreground_process_group, groups.len()));
                        }
                        verified_groups = Some(groups.clone());
                        groups
                    }
                    Err(error) => match verified_groups.clone() {
                        Some(groups) => groups,
                        None => {
                            return Err(unix_validation_error_with_fallback(
                                error,
                                raw_pid_fallback,
                            ))
                        }
                    },
                }
            }
            // Nothing observable this round. This is the pre-existing
            // "disappeared" path and keeps its original meaning: skip the round
            // rather than signalling anything.
            Ok(None) => continue,
            Err(error) => match verified_groups.clone() {
                Some(groups) => groups,
                None => return Err(unix_validation_error_with_fallback(error, raw_pid_fallback)),
            },
        };
        for process_group in process_groups {
            if let Err(error) = platform.signal_process_group(process_group, signal) {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    if let Some(error) = first_error {
        return Err(unix_validation_error_with_fallback(error, raw_pid_fallback));
    }

    match reported_groups {
        Some((foreground_process_group, group_count)) => {
            Ok(PtyTerminationOutcome::ConfirmedProcessGroups {
                foreground_process_group,
                original_process_group: unix_identity.original_process_group,
                group_count,
            })
        }
        None => Ok(PtyTerminationOutcome::NoProcess),
    }
}

#[cfg(windows)]
fn terminate_platform_process(
    process_tree: &WindowsProcessTreeKiller,
    _identity: PtyProcessIdentity,
) -> std::io::Result<PtyTerminationOutcome> {
    process_tree.terminate()?;
    Ok(PtyTerminationOutcome::ProcessTree)
}

#[derive(Clone, Default)]
struct MetricsState {
    collector: Arc<Mutex<MetricsCollector>>,
}

#[derive(Debug)]
struct PendingPtyStart {
    token: PtySessionToken,
    completed: bool,
}

impl PendingPtyStart {
    fn reserve(thread_id: &str) -> Result<Self, String> {
        let token = PTY_LIFECYCLES
            .lock()
            .reserve(thread_id)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            token,
            completed: false,
        })
    }

    fn install(
        mut self,
        session: PtySession,
    ) -> Result<(PtySessionToken, InstallSessionOutcome<PtySession>), String> {
        let outcome = PTY_LIFECYCLES
            .lock()
            .install(&self.token, session)
            .map_err(|error| error.to_string())?;
        self.completed = true;
        Ok((self.token.clone(), outcome))
    }
}

impl Drop for PendingPtyStart {
    fn drop(&mut self) {
        if !self.completed {
            PTY_LIFECYCLES.lock().abort_start(&self.token);
        }
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PtyAttachOptions {
    pub thread_id: String,
    pub session_id: String,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[cfg(unix)]
#[derive(Debug)]
struct OpenedPtyCwd {
    _directory: std::fs::File,
    spawn_path: PathBuf,
    canonical_path: PathBuf,
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
struct OpenedPtyCwd {
    project_root: String,
    requested_cwd: String,
    canonical_path: PathBuf,
}

impl OpenedPtyCwd {
    fn configure_command_cwd(&self, command: &mut CommandBuilder) -> Result<(), String> {
        #[cfg(unix)]
        {
            if !locator_matches_open_directory(&self.spawn_path, &self._directory) {
                return Err(format!(
                    "stable PTY cwd locator is unavailable: {}",
                    self.spawn_path.display()
                ));
            }
            command.cwd(&self.spawn_path);
        }
        #[cfg(target_os = "windows")]
        {
            let canonical_path =
                canonical_windows_pty_cwd_for_spawn(&self.project_root, &self.requested_cwd)?;
            command.cwd(canonical_path);
        }
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
fn open_pty_cwd_candidate(
    candidate: &Path,
    cwd: &str,
    _project_root: &str,
) -> Result<OpenedPtyCwd, String> {
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

#[cfg(target_os = "windows")]
fn open_pty_cwd_candidate(
    candidate: &Path,
    cwd: &str,
    project_root: &str,
) -> Result<OpenedPtyCwd, String> {
    let canonical_path = candidate
        .canonicalize()
        .map_err(|e| format!("PTY cwd '{}': {}", cwd, e))?;
    if !canonical_path.is_dir() {
        return Err(format!("PTY cwd is not a directory: {}", cwd));
    }
    Ok(OpenedPtyCwd {
        project_root: project_root.to_string(),
        requested_cwd: cwd.to_string(),
        canonical_path,
    })
}

#[cfg(target_os = "windows")]
fn canonical_windows_pty_cwd_for_spawn(project_root: &str, cwd: &str) -> Result<PathBuf, String> {
    let canonical_root = canonical_project_root(project_root)?;
    let candidate = pty_cwd_candidate(&canonical_root, cwd);
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|e| format!("PTY cwd '{}': {}", cwd, e))?;
    if !canonical_candidate.is_dir() {
        return Err(format!("PTY cwd is not a directory: {}", cwd));
    }
    if canonical_candidate.starts_with(&canonical_root) {
        return Ok(canonical_candidate);
    }

    let linked_worktrees = linked_worktree_roots(&canonical_root)?;
    validate_opened_pty_cwd(
        &canonical_root,
        &canonical_candidate,
        &linked_worktrees,
        cwd,
    )?;
    Ok(canonical_candidate)
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
    let opened = open_pty_cwd_candidate(&candidate, cwd, project_root)?;
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
    let raw = run_git_metadata(root, &["worktree", "list", "--porcelain"])?;
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
    let opened = open_pty_cwd_candidate(&candidate, cwd, project_root)?;
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
    if !matches!(launch_kind, "coven-code" | "coven-attach") {
        return Err(format!("unsupported launch kind: {launch_kind}"));
    }

    let resolved_coven = resolved_coven.ok_or_else(|| "Coven executable not found".to_string())?;
    if options.command.as_deref() != Some(resolved_coven) {
        return Err("Coven launch command does not match the resolved executable".to_string());
    }

    match launch_kind {
        "coven-code" => {
            if !has_exact_psyche_source(options.env.as_ref()) {
                return Err(
                    "coven-code requires exactly COVEN_SESSION_SOURCE=psyche-build".to_string(),
                );
            }
            let session_id = options
                .coven_session_id
                .as_deref()
                .ok_or_else(|| "coven-code requires a session id".to_string())?;
            if !is_safe_session_id(session_id) {
                return Err("coven-code session id is unsafe".to_string());
            }
            match options.args.as_deref() {
                Some([verb, flag, argument])
                    if verb == "code" && flag == "--session-id" && argument == session_id =>
                {
                    Ok(())
                }
                _ => Err(
                    "coven-code requires exactly 'code --session-id' and the validated session id"
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PtyExitEvent {
    pub thread_id: String,
    pub generation: u64,
    pub code: Option<i32>,
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

fn pump_pty_reader<R: Read>(mut reader: R, pump: OutputPump) -> Result<(), String> {
    let mut buffer = [0u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(bytes_read) => match pump.enqueue(buffer[..bytes_read].to_vec()) {
                Ok(()) => {}
                Err(EnqueueError::Cancelled { .. }) => return Ok(()),
                Err(error) => return Err(error.to_string()),
            },
            Err(error) => return Err(error.to_string()),
        }
    }
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

#[cfg(unix)]
struct UnixPtyReader {
    pty: OwnedFd,
    cancellation: OwnedFd,
}

#[cfg(unix)]
impl Read for UnixPtyReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let mut descriptors = [
                libc::pollfd {
                    fd: self.cancellation.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: self.pty.as_raw_fd(),
                    events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
                    revents: 0,
                },
            ];
            let poll_result =
                unsafe { libc::poll(descriptors.as_mut_ptr(), descriptors.len() as _, -1) };
            if poll_result < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if descriptors[0].revents != 0 {
                return Ok(0);
            }
            if descriptors[1].revents & libc::POLLNVAL != 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "PTY reader descriptor became invalid",
                ));
            }
            if descriptors[1].revents != 0 {
                let read_result = unsafe {
                    libc::read(
                        self.pty.as_raw_fd(),
                        buffer.as_mut_ptr().cast(),
                        buffer.len(),
                    )
                };
                if read_result >= 0 {
                    return Ok(read_result as usize);
                }
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
        }
    }
}

#[cfg(unix)]
struct UnixPtyReaderCancellation {
    write: OwnedFd,
    cancelled: AtomicBool,
}

#[derive(Clone)]
struct PtyReaderCancellation {
    #[cfg(unix)]
    inner: Arc<UnixPtyReaderCancellation>,
}

impl PtyReaderCancellation {
    fn cancel(&self) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            if self.inner.cancelled.swap(true, Ordering::AcqRel) {
                return Ok(());
            }
            let byte = [1u8];
            loop {
                let result = unsafe {
                    libc::write(
                        self.inner.write.as_raw_fd(),
                        byte.as_ptr().cast(),
                        byte.len(),
                    )
                };
                if result >= 0 {
                    return Ok(());
                }
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                if error.kind() == std::io::ErrorKind::BrokenPipe {
                    return Ok(());
                }
                return Err(error);
            }
        }
        #[cfg(not(unix))]
        {
            Ok(())
        }
    }
}

#[cfg(unix)]
fn prepare_pty_reader(
    master: &dyn MasterPty,
) -> Result<(Box<dyn Read + Send>, PtyReaderCancellation), String> {
    let master_fd = master
        .as_raw_fd()
        .ok_or_else(|| "Unix PTY master did not expose its reader descriptor".to_string())?;
    let pty = duplicate_cloexec_fd(master_fd).map_err(|error| error.to_string())?;
    let (cancellation_read, cancellation_write) =
        create_cloexec_pipe().map_err(|error| error.to_string())?;
    Ok((
        Box::new(UnixPtyReader {
            pty,
            cancellation: cancellation_read,
        }),
        PtyReaderCancellation {
            inner: Arc::new(UnixPtyReaderCancellation {
                write: cancellation_write,
                cancelled: AtomicBool::new(false),
            }),
        },
    ))
}

#[cfg(not(unix))]
fn prepare_pty_reader(
    master: &dyn MasterPty,
) -> Result<(Box<dyn Read + Send>, PtyReaderCancellation), String> {
    Ok((
        master
            .try_clone_reader()
            .map_err(|error| error.to_string())?,
        PtyReaderCancellation {},
    ))
}

struct PtyExitShutdown {
    token: PtySessionToken,
    pump: OutputPump,
    terminator: PtyProcessTerminator,
    reader_cancellation: PtyReaderCancellation,
    reader_done_rx: std::sync::mpsc::Receiver<Result<(), String>>,
    reader_thread: Option<std::thread::JoinHandle<()>>,
    reader_result: Option<Result<(), String>>,
    reader_completion_known: bool,
    exit_event_allowed: bool,
}

impl PtyExitShutdown {
    fn new(
        token: PtySessionToken,
        pump: OutputPump,
        terminator: PtyProcessTerminator,
        reader_cancellation: PtyReaderCancellation,
        reader_done_rx: std::sync::mpsc::Receiver<Result<(), String>>,
        reader_thread: std::thread::JoinHandle<()>,
    ) -> Self {
        Self {
            token,
            pump,
            terminator,
            reader_cancellation,
            reader_done_rx,
            reader_thread: Some(reader_thread),
            reader_result: None,
            reader_completion_known: false,
            exit_event_allowed: false,
        }
    }

    fn store_reader_completion(
        &mut self,
        completion: Result<Result<(), String>, std::sync::mpsc::RecvTimeoutError>,
    ) -> CompletionOutcome {
        match completion {
            Ok(result) => {
                self.reader_result = Some(result);
                self.reader_completion_known = true;
                CompletionOutcome::Completed
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                self.reader_completion_known = true;
                CompletionOutcome::Completed
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => CompletionOutcome::TimedOut,
        }
    }

    fn log_reader_result(&mut self) {
        if let Some(Err(error)) = self.reader_result.take() {
            log::warn!("PTY reader stopped after output pump error: {error}");
        }
    }

    fn join_reader_after_completion(&mut self) {
        if !self.reader_completion_known {
            return;
        }
        if let Some(reader_thread) = self.reader_thread.take() {
            if reader_thread.join().is_err() {
                log::warn!("PTY reader thread panicked for '{}'", self.token.thread_id);
            }
        }
        self.log_reader_result();
    }

    fn begin_matching_exit(&mut self) {
        let outcome = {
            let mut registry = PTY_LIFECYCLES.lock();
            registry.begin_exit(&self.token)
        };
        match outcome {
            BeginExitOutcome::Emit { session } => {
                self.exit_event_allowed = true;
                drop(session);
            }
            BeginExitOutcome::Stale => {
                self.exit_event_allowed = false;
            }
        }
    }

    fn finish_terminated_threads(&mut self, timeout: std::time::Duration) {
        let started_at = std::time::Instant::now();
        let deadline = started_at.checked_add(timeout).unwrap_or(started_at);
        if !self.reader_completion_known {
            let remaining = deadline
                .checked_duration_since(std::time::Instant::now())
                .unwrap_or(std::time::Duration::ZERO);
            let completion = self.reader_done_rx.recv_timeout(remaining);
            self.store_reader_completion(completion);
        }
        self.join_reader_after_completion();

        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .unwrap_or(std::time::Duration::ZERO);
        if self.pump.wait_for_worker_timeout(remaining) == CompletionOutcome::Completed {
            if self.pump.join_worker_after_completion().is_err() {
                log::warn!("PTY output worker panicked for '{}'", self.token.thread_id);
            }
        } else {
            log::warn!(
                "PTY output worker did not finish after terminating '{}'",
                self.token.thread_id
            );
        }
        if !self.reader_completion_known {
            log::warn!(
                "PTY reader did not finish after terminating and cancelling '{}'",
                self.token.thread_id
            );
        }
    }

    fn finish_terminated_threads_to_completion(&mut self) {
        if !self.reader_completion_known {
            match self.reader_done_rx.recv() {
                Ok(result) => {
                    self.reader_result = Some(result);
                    self.reader_completion_known = true;
                }
                Err(_) => {
                    self.reader_completion_known = true;
                }
            }
        }
        self.join_reader_after_completion();
        if self.pump.cancel_and_join().is_err() {
            log::warn!("PTY output worker panicked for '{}'", self.token.thread_id);
        }
    }
}

impl ExitShutdownHooks for PtyExitShutdown {
    fn now(&self) -> std::time::Instant {
        std::time::Instant::now()
    }

    fn request_drain(&mut self) {
        self.pump.request_drain();
    }

    fn wait_for_reader(&mut self, timeout: std::time::Duration) -> CompletionOutcome {
        let completion = self.reader_done_rx.recv_timeout(timeout);
        self.store_reader_completion(completion)
    }

    fn join_reader(&mut self) {
        self.join_reader_after_completion();
    }

    fn wait_for_drain(&mut self, timeout: std::time::Duration) -> DrainOutcome {
        self.pump.wait_for_drain_timeout_unrecorded(timeout)
    }

    fn cancel_pump(&mut self) {
        self.pump.cancel();
    }

    fn wait_for_worker(&mut self, timeout: std::time::Duration) -> CompletionOutcome {
        self.pump.wait_for_worker_timeout(timeout)
    }

    fn join_worker(&mut self) {
        if self.pump.join_worker_after_completion().is_err() {
            log::warn!("PTY output worker panicked for '{}'", self.token.thread_id);
        }
    }

    fn record_drain_timeout(&mut self) {
        self.pump.record_drain_timeout();
    }

    fn terminate_process(&mut self) {
        if let Err(error) = self.terminator.terminate() {
            log::warn!("PTY termination cleanup failed: {error}");
        }
        if let Err(error) = self.reader_cancellation.cancel() {
            log::warn!("PTY reader cancellation failed: {error}");
        }
    }

    fn remove_session(&mut self) {
        self.begin_matching_exit();
    }
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

fn clone_live_pty_pump(thread_id: &str) -> Result<OutputPump, String> {
    validate_pty_thread_id(thread_id)?;
    let guard = PTY_LIFECYCLES.lock();
    guard
        .live(thread_id)
        .map(|session| session.pump.clone())
        .ok_or_else(|| format!("thread '{}' not found", thread_id))
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

#[tauri::command]
async fn pty_start(
    webview: tauri::Webview,
    app: AppHandle,
    options: StartOptions,
) -> Result<(), String> {
    ensure_trusted_pty_caller(webview.label())?;
    match tauri::async_runtime::spawn_blocking(move || pty_start_blocking(app, options)).await {
        Ok(result) => result,
        Err(error) => Err(format!("failed to join PTY start task: {error}")),
    }
}

fn pty_start_blocking(app: AppHandle, options: StartOptions) -> Result<(), String> {
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

    let platform::LaunchDescriptor {
        command,
        args,
        env: launch_env,
    } = platform::pty_launch_descriptor(options.command, options.args)?;
    let mut cmd = CommandBuilder::new(command);
    cmd.args(args);
    cmd.env("PATH", platform::augmented_path());
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
    for (key, value) in launch_env {
        cmd.env(key, value);
    }

    resolved_cwd.configure_command_cwd(&mut cmd)?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(resolved_cwd);
    register_pty_client(app, thread_id, pending_start, pair, child)
}

fn register_pty_client(
    app: AppHandle,
    thread_id: String,
    pending_start: PendingPtyStart,
    pair: portable_pty::PtyPair,
    mut child: Box<dyn Child + Send + Sync>,
) -> Result<(), String> {
    let spawn_time_unix_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let pid = child.process_id();
    let terminator = PtyProcessTerminator::from_spawned_child(child.as_ref(), pair.master.as_ref())
        .map_err(|error| error.to_string())?;
    let mut spawn_guard = PtySpawnTerminationGuard::new(terminator.clone());
    let (mut reader, reader_cancellation) = prepare_pty_reader(pair.master.as_ref())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let pump = OutputPump::new(thread_id.clone()).map_err(|e| e.to_string())?;
    let app_for_output = app.clone();
    pump.start_worker(move |payload| {
        app_for_output
            .emit("pty:data-batch", payload)
            .map_err(|error| error.to_string())
    })
    .map_err(|e| e.to_string())?;

    let (session_token, install_outcome) = pending_start.install(PtySession {
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        operation_lane: Arc::new(tokio::sync::Mutex::new(())),
        operation_admission: Arc::new(tokio::sync::Semaphore::new(2)),
        pump: pump.clone(),
        terminator: terminator.clone(),
        reader_cancellation: reader_cancellation.clone(),
        pid,
        spawn_time_unix_secs,
    })?;
    spawn_guard.disarm();

    let reader_pump = pump.clone();
    let (reader_done_tx, reader_done_rx) = std::sync::mpsc::sync_channel(1);
    let data_thread = std::thread::spawn(move || {
        let reader_result = pump_pty_reader(&mut reader, reader_pump);
        let _ = reader_done_tx.send(reader_result);
    });

    let app_for_exit = app.clone();
    let exit_pump = pump;
    let exit_token = session_token.clone();
    let exit_terminator = terminator;
    std::thread::spawn(move || {
        let status = exit_terminator.wait_for_child(|| child.wait());
        let code = status.ok().map(|s| s.exit_code() as i32);
        let mut shutdown = PtyExitShutdown::new(
            exit_token.clone(),
            exit_pump,
            exit_terminator,
            reader_cancellation,
            reader_done_rx,
            data_thread,
        );
        let outcome = coordinate_exit_shutdown(&mut shutdown, EXIT_DRAIN_TIMEOUT);
        if outcome == ExitShutdownOutcome::TimedOut {
            let snapshot = shutdown.pump.snapshot();
            log::warn!(
                "PTY output shutdown timed out for '{}' with {} pending bytes, \
                 prepared={}, {} in-flight batches, and {} blocked producers",
                snapshot.thread_id,
                snapshot.pending_bytes,
                snapshot.prepared,
                snapshot.in_flight_batches,
                snapshot.blocked_producers,
            );
        }
        RECENT_PTY_SNAPSHOTS.lock().insert(FinalOutputPumpSnapshot {
            key: TransportSessionKey::new(exit_token.thread_id.clone(), exit_token.generation),
            outcome,
            transport: shutdown.pump.snapshot(),
        });
        if shutdown.exit_event_allowed {
            let _ = app_for_exit.emit(
                "pty:exit",
                PtyExitEvent {
                    thread_id: exit_token.thread_id.clone(),
                    generation: exit_token.generation,
                    code,
                },
            );
        }
        // Timeout cleanup has its own bounded budget, so it must happen only after
        // observers receive the exit. Keep the generation reserved until the old
        // reader and worker can no longer collide with a replacement session.
        if outcome == ExitShutdownOutcome::TimedOut {
            shutdown.finish_terminated_threads(EXIT_TERMINATION_CLEANUP_TIMEOUT);
            shutdown.finish_terminated_threads_to_completion();
        }
        if shutdown.exit_event_allowed {
            PTY_LIFECYCLES.lock().finish_exit(&exit_token);
        }
    });

    if let InstallSessionOutcome::StopImmediately(session) = install_outcome {
        let termination = terminate_pty_session(session)
            .map(|outcome| format!("{outcome:?}"))
            .unwrap_or_else(|error| error);
        return Err(format!(
            "thread '{}' generation {} was stopped during start ({termination})",
            session_token.thread_id, session_token.generation
        ));
    }

    Ok(())
}

#[tauri::command]
async fn pty_attach(
    webview: tauri::Webview,
    app: AppHandle,
    options: PtyAttachOptions,
) -> Result<(), String> {
    ensure_trusted_pty_caller(webview.label())?;
    match tauri::async_runtime::spawn_blocking(move || pty_attach_blocking(app, options)).await {
        Ok(result) => result,
        Err(error) => Err(format!("failed to join PTY attach task: {error}")),
    }
}

fn pty_attach_blocking(app: AppHandle, options: PtyAttachOptions) -> Result<(), String> {
    validate_pty_thread_id(&options.thread_id)?;
    let attach_args = native_sessions::build_attach_args(
        &native_sessions::native_socket_path()?,
        &options.session_id,
    )?;
    let pending_start = PendingPtyStart::reserve(&options.thread_id)?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: options.rows.unwrap_or(40),
            cols: options.cols.unwrap_or(120),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let tmux = which_on_path("tmux")
        .ok_or_else(|| "tmux is unavailable; install tmux and restart Psyche".to_string())?;
    let mut command = CommandBuilder::new(tmux);
    command.args(attach_args);
    command.env("PATH", platform::augmented_path());
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env_remove("TMUX");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    register_pty_client(app, options.thread_id, pending_start, pair, child)
}

#[tauri::command]
async fn pty_write(
    webview: tauri::Webview,
    thread_id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    ensure_trusted_pty_caller(webview.label())?;
    let (writer, operation_lane, operation_admission) = pty_write_operation(&thread_id)?;
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
        .live(thread_id)
        .ok_or_else(|| format!("thread '{}' not found", thread_id))?;
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
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    ensure_trusted_pty_caller(webview.label())?;
    let Some((master, operation_lane, operation_admission)) = pty_resize_operation(&thread_id)
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
) -> Option<(
    Arc<Mutex<Box<dyn MasterPty + Send>>>,
    Arc<tokio::sync::Mutex<()>>,
    Arc<tokio::sync::Semaphore>,
)> {
    let guard = PTY_LIFECYCLES.lock();
    let operation = guard.live(thread_id).map(|session| {
        (
            Arc::clone(&session.master),
            Arc::clone(&session.operation_lane),
            Arc::clone(&session.operation_admission),
        )
    });
    drop(guard);
    operation
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
fn pty_stop(webview: tauri::Webview, thread_id: String) -> Result<PtyStopResult, String> {
    ensure_trusted_pty_caller(webview.label())?;
    let action = {
        let mut registry = PTY_LIFECYCLES.lock();
        registry
            .stop(&thread_id)
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
fn pty_ack(
    webview: tauri::Webview,
    thread_id: String,
    sequence: u64,
) -> Result<AckOutcome, String> {
    ensure_trusted_pty_caller(webview.label())?;
    pty_ack_inner(thread_id, sequence)
}

fn pty_ack_inner(thread_id: String, sequence: u64) -> Result<AckOutcome, String> {
    let pump = clone_live_pty_pump(&thread_id)?;
    pump.acknowledge(sequence)
        .map(AckOutcome::from)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn pty_set_visibility(
    webview: tauri::Webview,
    thread_id: String,
    visible: bool,
) -> Result<(), String> {
    ensure_trusted_pty_caller(webview.label())?;
    pty_set_visibility_inner(thread_id, visible)
}

fn pty_set_visibility_inner(thread_id: String, visible: bool) -> Result<(), String> {
    let pump = clone_live_pty_pump(&thread_id)?;
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
            NativeLaunchKind::CovenCode => {
                let id = request
                    .coven_session_id
                    .clone()
                    .filter(|id| is_safe_session_id(id))
                    .ok_or_else(|| "Coven session id is unsafe".to_string())?;
                (
                    environment
                        .coven_path
                        .ok_or_else(|| "Coven CLI is unavailable".to_string())?,
                    vec!["code".to_string(), "--session-id".to_string(), id],
                )
            }
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
        if matches!(request.launch_kind, NativeLaunchKind::CovenCode) {
            args.push(format!("{COVEN_SESSION_SOURCE}={PSYCHE_SESSION_SOURCE}"));
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
fn git_repository_config_available(root: &str) -> Result<bool, String> {
    let out = git_command(root)
        .args(["rev-parse", "--git-dir"])
        .output()
        .map_err(|e| format!("git: {}", e))?;
    Ok(out.status.success())
}

#[cfg(any(windows, test))]
fn has_windows_verbatim_disk_prefix(encoded: &[u16]) -> bool {
    const VERBATIM_PREFIX: [u16; 4] = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];

    encoded.starts_with(&VERBATIM_PREFIX)
        && encoded.get(4).is_some_and(|unit| {
            (b'A' as u16..=b'Z' as u16).contains(unit) || (b'a' as u16..=b'z' as u16).contains(unit)
        })
        && encoded.get(5) == Some(&(b':' as u16))
        && encoded.get(6) == Some(&(b'\\' as u16))
}

fn git_subprocess_root(root: &Path) -> Cow<'_, Path> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        let encoded = root.as_os_str().encode_wide().collect::<Vec<_>>();
        if has_windows_verbatim_disk_prefix(&encoded) {
            return Cow::Owned(PathBuf::from(OsString::from_wide(&encoded[4..])));
        }
    }

    Cow::Borrowed(root)
}

fn git_command(root: &str) -> std::process::Command {
    #[cfg(test)]
    TEST_GIT_COMMAND_COUNT.with(|count| *count.borrow_mut() += 1);
    let mut command = std::process::Command::new("git");
    command.current_dir(git_subprocess_root(Path::new(root)).as_ref());
    #[cfg(test)]
    TEST_GIT_ENV_OVERRIDES.with(|overrides| {
        for (key, value) in overrides.borrow().iter() {
            match value {
                Some(value) => {
                    command.env(key, value);
                }
                None => {
                    command.env_remove(key);
                }
            }
        }
    });
    // Inspection must retain repository/global paths without inheriting
    // command-scope configuration supplied by the parent process.
    command.env_remove("GIT_CONFIG_PARAMETERS");
    command.env_remove("GIT_CONFIG_COUNT");
    command
}

fn git_worktree_config_enabled(root: &str) -> Result<bool, String> {
    let out = git_command(root)
        .args([
            "config",
            "--local",
            "--includes",
            "--bool",
            "--default=false",
            "extensions.worktreeConfig",
        ])
        .output()
        .map_err(|e| format!("git: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8(out.stderr)
            .map_err(|err| format!("git config returned invalid UTF-8 stderr: {err}"))?
            .trim()
            .to_string();
        return Err(if stderr.is_empty() {
            format!(
                "git config extensions.worktreeConfig query failed with status {}",
                out.status
            )
        } else {
            format!(
                "git config extensions.worktreeConfig query failed: {}",
                stderr
            )
        });
    }
    match String::from_utf8(out.stdout)
        .map_err(|err| format!("git config returned invalid UTF-8 stdout: {err}"))?
        .trim()
    {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(
            "git config extensions.worktreeConfig query returned a non-boolean value".to_string(),
        ),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GitFilterDriverKind {
    Clean,
    Process,
    Required,
}

#[derive(Default)]
struct GitFilterScopeConfig {
    values: HashMap<String, String>,
}

impl GitFilterScopeConfig {
    fn value(&self, key: &str) -> Option<String> {
        self.values.get(key).cloned()
    }

    fn bool(&self, key: &str) -> Result<Option<bool>, String> {
        let Some(value) = self.values.get(key) else {
            return Ok(None);
        };
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "true" | "yes" | "on" | "1" => Ok(Some(true)),
            "false" | "no" | "off" | "0" => Ok(Some(false)),
            _ => Err(format!(
                "git config {key} query returned a non-boolean value"
            )),
        }
    }

    fn driver_names(&self) -> Result<Vec<(String, GitFilterDriverKind)>, String> {
        let mut drivers = Vec::new();
        for key in self.values.keys() {
            let Some(rest) = key.strip_prefix("filter.") else {
                continue;
            };
            let (driver, kind) = if let Some(driver) = rest.strip_suffix(".clean") {
                (driver, GitFilterDriverKind::Clean)
            } else if let Some(driver) = rest.strip_suffix(".process") {
                (driver, GitFilterDriverKind::Process)
            } else if let Some(driver) = rest.strip_suffix(".required") {
                (driver, GitFilterDriverKind::Required)
            } else {
                continue;
            };
            if driver.is_empty() {
                return Err("git config returned an empty filter driver name".to_string());
            }
            drivers.push((driver.to_string(), kind));
        }
        Ok(drivers)
    }
}

fn git_filter_config_for_scope(root: &str, scope: &str) -> Result<GitFilterScopeConfig, String> {
    #[cfg(test)]
    TEST_GIT_FILTER_SCOPE_QUERIES.with(|queries| queries.borrow_mut().push(scope.to_string()));
    let out = git_command(root)
        .args([
            "config",
            scope,
            "--includes",
            "--null",
            "--get-regexp",
            r"^filter\..*\.(clean|process|required)$",
        ])
        .output()
        .map_err(|e| format!("git: {}", e))?;
    if !out.status.success() {
        if out.status.code() == Some(1) {
            return Ok(GitFilterScopeConfig::default());
        }
        let stderr = String::from_utf8(out.stderr)
            .map_err(|err| format!("git config returned invalid UTF-8 stderr: {err}"))?
            .trim()
            .to_string();
        return Err(if stderr.is_empty() {
            format!("git config filter query failed with status {}", out.status)
        } else {
            format!("git config filter query failed: {}", stderr)
        });
    }

    let mut config = GitFilterScopeConfig::default();
    for record in out
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let Some(separator) = record.iter().position(|byte| *byte == b'\n') else {
            return Err("git config filter query returned malformed output".to_string());
        };
        let (key_bytes, value_bytes) = record.split_at(separator);
        let key = std::str::from_utf8(key_bytes)
            .map_err(|_| "git config filter query returned invalid UTF-8 keys".to_string())?;
        let value = std::str::from_utf8(&value_bytes[1..]).map_err(|err| {
            format!("git config {key} query returned invalid UTF-8 stdout: {err}")
        })?;
        config.values.insert(key.to_string(), value.to_string());
    }
    Ok(config)
}

#[derive(Debug, PartialEq, Eq)]
struct GitFilterDriverOverride {
    driver: String,
    clean: Option<String>,
    process: Option<String>,
    required: Option<bool>,
    repository_clean: bool,
    repository_process: bool,
}

fn git_filter_driver_override_from_scopes(
    driver: String,
    repository_clean: bool,
    repository_process: bool,
    system: &GitFilterScopeConfig,
    global: &GitFilterScopeConfig,
) -> Result<GitFilterDriverOverride, String> {
    let clean_key = format!("filter.{driver}.clean");
    let process_key = format!("filter.{driver}.process");
    let required_key = format!("filter.{driver}.required");
    Ok(GitFilterDriverOverride {
        clean: global
            .value(&clean_key)
            .or_else(|| system.value(&clean_key)),
        process: global
            .value(&process_key)
            .or_else(|| system.value(&process_key)),
        required: match global.bool(&required_key)? {
            Some(value) => Some(value),
            None => system.bool(&required_key)?,
        },
        repository_clean,
        repository_process,
        driver,
    })
}

#[cfg(test)]
fn git_filter_driver_override(
    root: &str,
    driver: String,
    repository_clean: bool,
    repository_process: bool,
) -> Result<GitFilterDriverOverride, String> {
    let system = git_filter_config_for_scope(root, "--system")?;
    let global = git_filter_config_for_scope(root, "--global")?;
    git_filter_driver_override_from_scopes(
        driver,
        repository_clean,
        repository_process,
        &system,
        &global,
    )
}

#[cfg(test)]
fn git_filter_driver_overrides(root: &str) -> Result<Vec<GitFilterDriverOverride>, String> {
    if !git_repository_config_available(root)? {
        return Ok(Vec::new());
    }

    let local = git_filter_config_for_scope(root, "--local")?;
    let mut drivers = local.driver_names()?;
    // Without extensions.worktreeConfig, `git config --worktree` falls back to
    // local config instead of reporting an unavailable worktree scope. Only
    // query worktree-owned config when the repository explicitly enables it.
    if git_worktree_config_enabled(root)? {
        drivers.extend(git_filter_config_for_scope(root, "--worktree")?.driver_names()?);
    }
    let system = git_filter_config_for_scope(root, "--system")?;
    let global = git_filter_config_for_scope(root, "--global")?;
    drivers.sort_by(|left, right| left.0.cmp(&right.0));
    let mut driver_sources: Vec<(String, bool, bool)> = Vec::new();
    for (driver, kind) in drivers {
        if driver_sources.last().map(|entry| entry.0.as_str()) != Some(driver.as_str()) {
            driver_sources.push((driver, false, false));
        }
        let entry = driver_sources.last_mut().expect("driver entry must exist");
        match kind {
            GitFilterDriverKind::Clean => entry.1 = true,
            GitFilterDriverKind::Process => entry.2 = true,
            GitFilterDriverKind::Required => {}
        }
    }
    driver_sources
        .into_iter()
        .map(|(driver, repository_clean, repository_process)| {
            git_filter_driver_override_from_scopes(
                driver,
                repository_clean,
                repository_process,
                &system,
                &global,
            )
        })
        .collect()
}

fn git_trusted_filter_driver_overrides(root: &str) -> Result<Vec<GitFilterDriverOverride>, String> {
    let system = git_filter_config_for_scope(root, "--system")?;
    let global = git_filter_config_for_scope(root, "--global")?;
    let mut drivers = system.driver_names()?;
    drivers.extend(global.driver_names()?);
    drivers.sort_by(|left, right| left.0.cmp(&right.0));
    drivers.dedup_by(|left, right| left.0 == right.0);
    drivers
        .into_iter()
        .map(|(driver, _)| {
            git_filter_driver_override_from_scopes(driver, false, false, &system, &global)
        })
        .collect()
}

fn git_url_rewrite_config_for_scope(
    root: &str,
    scope: &str,
) -> Result<Vec<(String, String)>, String> {
    let out = git_command(root)
        .args([
            "config",
            scope,
            "--includes",
            "--null",
            "--get-regexp",
            r"^url\..*\.insteadof$",
        ])
        .output()
        .map_err(|e| format!("git: {}", e))?;
    if !out.status.success() {
        if out.status.code() == Some(1) {
            return Ok(Vec::new());
        }
        let stderr = String::from_utf8(out.stderr)
            .map_err(|err| format!("git config returned invalid UTF-8 stderr: {err}"))?
            .trim()
            .to_string();
        return Err(if stderr.is_empty() {
            format!(
                "git config URL rewrite query failed with status {}",
                out.status
            )
        } else {
            format!("git config URL rewrite query failed: {}", stderr)
        });
    }

    let mut values = Vec::new();
    for record in out
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let Some(separator) = record.iter().position(|byte| *byte == b'\n') else {
            return Err("git config URL rewrite query returned malformed output".to_string());
        };
        let (key_bytes, value_bytes) = record.split_at(separator);
        let key = std::str::from_utf8(key_bytes)
            .map_err(|_| "git config URL rewrite query returned invalid UTF-8 keys".to_string())?;
        let value = std::str::from_utf8(&value_bytes[1..]).map_err(|err| {
            format!("git config {key} query returned invalid UTF-8 stdout: {err}")
        })?;
        values.push((key.to_string(), value.to_string()));
    }
    Ok(values)
}

fn git_trusted_url_rewrite_config(root: &str) -> Result<Vec<(String, String)>, String> {
    let mut values = git_url_rewrite_config_for_scope(root, "--system")?;
    values.extend(git_url_rewrite_config_for_scope(root, "--global")?);
    Ok(values)
}

fn git_metadata_output(root: &str, args: &[&str]) -> Result<std::process::Output, String> {
    git_command(root)
        .args(args)
        .output()
        .map_err(|e| format!("git: {}", e))
}

fn run_git_metadata(root: &str, args: &[&str]) -> Result<String, String> {
    let out = git_metadata_output(root, args)?;
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

fn resolve_git_path(root: &Path, raw: &str) -> PathBuf {
    let path = PathBuf::from(raw.trim());
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

fn git_dir_for_worktree(root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let mut current = Some(root);
    while let Some(candidate) = current {
        let dot_git = candidate.join(".git");
        if dot_git.is_dir() {
            return Ok((candidate.to_path_buf(), dot_git));
        }
        if dot_git.is_file() {
            let text = std::fs::read_to_string(&dot_git)
                .map_err(|e| format!("read linked worktree Git directory: {e}"))?;
            let raw = text
                .trim()
                .strip_prefix("gitdir:")
                .ok_or_else(|| "linked worktree .git file is malformed".to_string())?
                .trim();
            let git_dir = resolve_git_path(candidate, raw);
            return Ok((candidate.to_path_buf(), git_dir));
        }
        current = candidate.parent();
    }
    Err("not a Git worktree".to_string())
}

fn git_common_dir(git_dir: &Path) -> Result<PathBuf, String> {
    let commondir = git_dir.join("commondir");
    if !commondir.is_file() {
        return Ok(git_dir.to_path_buf());
    }
    let raw = std::fs::read_to_string(&commondir)
        .map_err(|e| format!("read Git common directory: {e}"))?;
    Ok(resolve_git_path(git_dir, &raw))
}

fn is_valid_git_ref_name(name: &str) -> bool {
    if name == "@"
        || !name.contains('/')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.contains("..")
        || name.contains("@{")
        || name.contains("//")
    {
        return false;
    }
    if name.split('/').any(|component| {
        component.is_empty() || component.starts_with('.') || component.ends_with(".lock")
    }) {
        return false;
    }
    !name.bytes().any(|byte| {
        byte < b' '
            || byte == 0x7f
            || matches!(byte, b' ' | b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
    })
}

fn git_oid_hex_len(object_format: Option<&str>) -> usize {
    if object_format == Some("sha256") {
        64
    } else {
        40
    }
}

fn is_valid_git_oid(value: &str, object_format: Option<&str>) -> bool {
    value.len() == git_oid_hex_len(object_format)
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn collect_loose_refs(
    directory: &Path,
    prefix: &str,
    refs: &mut HashMap<String, GitRefValue>,
    object_format: Option<&str>,
) -> Result<(), String> {
    if !directory.is_dir() {
        return Ok(());
    }
    for entry in
        std::fs::read_dir(directory).map_err(|e| format!("read Git refs directory: {e}"))?
    {
        let entry = entry.map_err(|e| format!("read Git ref entry: {e}"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("inspect Git ref entry: {e}"))?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if name.ends_with(".lock") {
            continue;
        }
        let ref_name = format!("{prefix}/{name}");
        if file_type.is_dir() {
            collect_loose_refs(&entry.path(), &ref_name, refs, object_format)?;
        } else if file_type.is_file() && is_valid_git_ref_name(&ref_name) {
            let value = std::fs::read_to_string(entry.path())
                .map_err(|e| format!("read Git ref: {e}"))?
                .trim()
                .to_string();
            if let Some(target) = value.strip_prefix("ref: ") {
                refs.insert(ref_name, GitRefValue::Symbolic(target.to_string()));
            } else if is_valid_git_oid(&value, object_format) {
                refs.insert(ref_name, GitRefValue::Direct(value));
            }
        }
    }
    Ok(())
}

enum GitRefValue {
    Direct(String),
    Symbolic(String),
}

fn snapshot_git_refs(
    common_dir: &Path,
    object_format: Option<&str>,
) -> Result<HashMap<String, GitRefValue>, String> {
    let mut refs = HashMap::new();
    let packed_refs = common_dir.join("packed-refs");
    if packed_refs.is_file() {
        let packed = std::fs::read_to_string(&packed_refs)
            .map_err(|e| format!("read packed Git refs: {e}"))?;
        for line in packed.lines() {
            if line.is_empty() || line.starts_with('#') || line.starts_with('^') {
                continue;
            }
            if let Some((oid, name)) = line.split_once(' ') {
                refs.insert(name.to_string(), GitRefValue::Direct(oid.to_string()));
            }
        }
    }
    collect_loose_refs(&common_dir.join("refs"), "refs", &mut refs, object_format)?;
    Ok(refs)
}

const MAX_GIT_SHALLOW_BYTES: u64 = 16 * 1024 * 1024;
const MAX_GIT_INFO_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_GIT_REFTABLE_LIST_BYTES: u64 = 1024 * 1024;
const MAX_GIT_REFTABLE_TABLES: usize = 4096;
const MAX_GIT_REFTABLE_TABLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_GIT_REFTABLE_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Copy)]
struct GitReftableSnapshotLimits {
    list_bytes: u64,
    tables: usize,
    table_bytes: u64,
    total_bytes: u64,
}

const GIT_REFTABLE_SNAPSHOT_LIMITS: GitReftableSnapshotLimits = GitReftableSnapshotLimits {
    list_bytes: MAX_GIT_REFTABLE_LIST_BYTES,
    tables: MAX_GIT_REFTABLE_TABLES,
    table_bytes: MAX_GIT_REFTABLE_TABLE_BYTES,
    total_bytes: MAX_GIT_REFTABLE_TOTAL_BYTES,
};

fn validate_git_shallow(bytes: &[u8], object_format: Option<&str>) -> Result<(), String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "invalid Git shallow boundary: content is not UTF-8".to_string())?;
    if text.is_empty()
        || text
            .lines()
            .any(|oid| !is_valid_git_oid(oid, object_format))
    {
        return Err("invalid Git shallow boundary".to_string());
    }
    Ok(())
}

#[cfg(unix)]
fn read_git_shallow(common_dir: &Path) -> Result<Option<Vec<u8>>, String> {
    let directory = open_directory_no_follow(common_dir, "Git common directory")?;
    let name = CString::new("shallow").expect("static file name has no NUL");
    let mut file = match open_target_no_follow(&directory, &name) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("open Git shallow boundary: {error}")),
    };
    let before = file_state(&file)?;
    if before.mode & u32::from(libc::S_IFMT) != u32::from(libc::S_IFREG) {
        return Err("Git shallow boundary is not a regular file".to_string());
    }
    if before.size > MAX_GIT_SHALLOW_BYTES {
        return Err("Git shallow boundary is too large".to_string());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("read Git shallow boundary: {e}"))?;
    let mut bytes = Vec::with_capacity(before.size as usize);
    std::io::Read::by_ref(&mut file)
        .take(MAX_GIT_SHALLOW_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read Git shallow boundary: {e}"))?;
    let after = file_state(&file)?;
    if before != after {
        return Err("Git shallow boundary changed while being read".to_string());
    }
    if bytes.len() as u64 > MAX_GIT_SHALLOW_BYTES {
        return Err("Git shallow boundary is too large".to_string());
    }
    Ok(Some(bytes))
}

#[cfg(not(unix))]
fn read_git_shallow(common_dir: &Path) -> Result<Option<Vec<u8>>, String> {
    let path = common_dir.join("shallow");
    let before = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("inspect Git shallow boundary: {error}")),
    };
    if before.file_type().is_symlink() || !before.is_file() {
        return Err("Git shallow boundary is not a regular file".to_string());
    }
    if before.len() > MAX_GIT_SHALLOW_BYTES {
        return Err("Git shallow boundary is too large".to_string());
    }
    let mut file =
        std::fs::File::open(&path).map_err(|e| format!("open Git shallow boundary: {e}"))?;
    let mut bytes = Vec::with_capacity(before.len() as usize);
    std::io::Read::by_ref(&mut file)
        .take(MAX_GIT_SHALLOW_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read Git shallow boundary: {e}"))?;
    let after = std::fs::symlink_metadata(&path)
        .map_err(|e| format!("inspect Git shallow boundary after reading: {e}"))?;
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || after.file_type().is_symlink()
        || !after.is_file()
    {
        return Err("Git shallow boundary changed while being read".to_string());
    }
    if bytes.len() as u64 > MAX_GIT_SHALLOW_BYTES {
        return Err("Git shallow boundary is too large".to_string());
    }
    Ok(Some(bytes))
}

fn snapshot_git_shallow(
    common_dir: &Path,
    destination: &Path,
    object_format: Option<&str>,
) -> Result<(), String> {
    let Some(bytes) = read_git_shallow(common_dir)? else {
        return Ok(());
    };
    validate_git_shallow(&bytes, object_format)?;
    std::fs::write(destination.join("shallow"), bytes)
        .map_err(|e| format!("snapshot Git shallow boundary: {e}"))
}

#[cfg(any(windows, test))]
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0010;

#[cfg(any(windows, test))]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

#[cfg(windows)]
fn metadata_is_reparse_like(metadata: &std::fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_like(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn metadata_is_link_like(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink() || metadata_is_reparse_like(metadata)
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WindowsGitMetadataState {
    volume_serial_number: u32,
    file_index: u64,
    file_attributes: u32,
    file_size: u64,
    last_write_time: u64,
}

#[cfg(any(windows, test))]
fn windows_git_metadata_same_identity(
    before: WindowsGitMetadataState,
    after: WindowsGitMetadataState,
) -> bool {
    before.volume_serial_number == after.volume_serial_number
        && before.file_index == after.file_index
}

#[cfg(any(windows, test))]
fn windows_git_metadata_file_state_matches(
    before: WindowsGitMetadataState,
    after: WindowsGitMetadataState,
) -> bool {
    windows_git_metadata_same_identity(before, after)
        && before.file_attributes == after.file_attributes
        && before.file_size == after.file_size
        && before.last_write_time == after.last_write_time
}

#[cfg(any(windows, test))]
fn windows_git_metadata_directory_state_matches(
    before: WindowsGitMetadataState,
    after: WindowsGitMetadataState,
) -> bool {
    windows_git_metadata_same_identity(before, after)
        && before.file_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
            == after.file_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
}

#[cfg(all(not(unix), not(windows)))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct OtherGitMetadataState {
    length: u64,
    modified: SystemTime,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsFileTime {
    low_date_time: u32,
    high_date_time: u32,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsByHandleFileInformation {
    file_attributes: u32,
    creation_time: WindowsFileTime,
    last_access_time: WindowsFileTime,
    last_write_time: WindowsFileTime,
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsUnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsObjectAttributes {
    length: u32,
    root_directory: *mut std::ffi::c_void,
    object_name: *mut WindowsUnicodeString,
    attributes: u32,
    security_descriptor: *mut std::ffi::c_void,
    security_quality_of_service: *mut std::ffi::c_void,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsIoStatusBlock {
    status: isize,
    information: usize,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetFileInformationByHandle(
        file: *mut std::ffi::c_void,
        information: *mut WindowsByHandleFileInformation,
    ) -> i32;
}

#[cfg(windows)]
#[link(name = "ntdll")]
extern "system" {
    fn NtCreateFile(
        file_handle: *mut *mut std::ffi::c_void,
        desired_access: u32,
        object_attributes: *mut WindowsObjectAttributes,
        io_status_block: *mut WindowsIoStatusBlock,
        allocation_size: *mut i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *mut std::ffi::c_void,
        ea_length: u32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

#[cfg(all(not(unix), not(windows)))]
fn other_git_metadata_state(
    metadata: &std::fs::Metadata,
    label: &str,
) -> Result<OtherGitMetadataState, String> {
    Ok(OtherGitMetadataState {
        length: metadata.len(),
        modified: metadata
            .modified()
            .map_err(|error| format!("inspect {label} modification time: {error}"))?,
    })
}

#[cfg(windows)]
fn windows_git_metadata_handle_state(
    file: &std::fs::File,
    label: &str,
) -> Result<WindowsGitMetadataState, String> {
    use std::os::windows::io::AsRawHandle;

    let mut information = std::mem::MaybeUninit::<WindowsByHandleFileInformation>::uninit();
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if succeeded == 0 {
        return Err(format!(
            "inspect open {label}: {}",
            std::io::Error::last_os_error()
        ));
    }
    let information = unsafe { information.assume_init() };
    Ok(WindowsGitMetadataState {
        volume_serial_number: information.volume_serial_number,
        file_index: (u64::from(information.file_index_high) << 32)
            | u64::from(information.file_index_low),
        file_attributes: information.file_attributes,
        file_size: (u64::from(information.file_size_high) << 32)
            | u64::from(information.file_size_low),
        last_write_time: (u64::from(information.last_write_time.high_date_time) << 32)
            | u64::from(information.last_write_time.low_date_time),
    })
}

#[cfg(any(test, windows))]
fn windows_git_metadata_child_share_mode() -> u32 {
    const FILE_SHARE_READ: u32 = 0x0001;
    const FILE_SHARE_DELETE: u32 = 0x0004;

    FILE_SHARE_READ | FILE_SHARE_DELETE
}

#[cfg(any(test, windows))]
fn windows_git_metadata_open_error(label: &str, error: u32) -> String {
    const ERROR_SHARING_VIOLATION: u32 = 32;

    if error == ERROR_SHARING_VIOLATION {
        format!("{label} changed while being read")
    } else {
        format!(
            "open {label}: {}",
            std::io::Error::from_raw_os_error(error as i32)
        )
    }
}

#[cfg(windows)]
fn windows_open_directory_no_follow(path: &Path, label: &str) -> Result<std::fs::File, String> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_LIST_DIRECTORY: u32 = 0x0001;
    const FILE_TRAVERSE: u32 = 0x0020;
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const FILE_SHARE_READ: u32 = 0x0001;
    const FILE_SHARE_WRITE: u32 = 0x0002;
    const FILE_SHARE_DELETE: u32 = 0x0004;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .access_mode(FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    options
        .open(path)
        .map_err(|error| format!("open {label} '{}': {error}", path.display()))
}

#[cfg(windows)]
fn windows_open_relative_no_follow(
    directory: &std::fs::File,
    name: &str,
    label: &str,
) -> Result<std::fs::File, String> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle};

    const FILE_GENERIC_READ: u32 = 0x0012_0089;
    const FILE_OPEN: u32 = 0x0001;
    const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0020;
    const FILE_NON_DIRECTORY_FILE: u32 = 0x0040;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const OBJ_CASE_INSENSITIVE: u32 = 0x0040;

    let mut name = name.encode_utf16().collect::<Vec<_>>();
    if name.iter().any(|unit| *unit == 0) {
        return Err(format!("{label} has an invalid file name"));
    }
    let byte_length = name
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| format!("{label} has an invalid file name"))?;
    let mut unicode_name = WindowsUnicodeString {
        length: byte_length,
        maximum_length: byte_length,
        buffer: name.as_mut_ptr(),
    };
    let mut object_attributes = WindowsObjectAttributes {
        length: u32::try_from(std::mem::size_of::<WindowsObjectAttributes>())
            .expect("Windows object attributes size fits u32"),
        root_directory: directory.as_raw_handle(),
        object_name: &mut unicode_name,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: std::ptr::null_mut(),
        security_quality_of_service: std::ptr::null_mut(),
    };
    let mut io_status = WindowsIoStatusBlock {
        status: 0,
        information: 0,
    };
    let mut handle = std::ptr::null_mut();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            FILE_GENERIC_READ,
            &mut object_attributes,
            &mut io_status,
            std::ptr::null_mut(),
            0,
            windows_git_metadata_child_share_mode(),
            FILE_OPEN,
            FILE_SYNCHRONOUS_IO_NONALERT | FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
            0,
        )
    };
    if status < 0 {
        let error = unsafe { RtlNtStatusToDosError(status) };
        return Err(windows_git_metadata_open_error(label, error));
    }
    if handle.is_null() {
        return Err(format!("open {label}: Windows returned an invalid handle"));
    }
    Ok(unsafe { std::fs::File::from_raw_handle(handle) })
}

#[derive(Debug, Eq, PartialEq)]
enum GitMetadataReadError {
    TooLarge,
    Other(String),
}

impl From<String> for GitMetadataReadError {
    fn from(error: String) -> Self {
        Self::Other(error)
    }
}

impl GitMetadataReadError {
    fn into_message(self, label: &str) -> String {
        match self {
            Self::TooLarge => format!("{label} is too large"),
            Self::Other(error) => error,
        }
    }
}

#[cfg(all(not(unix), not(windows)))]
fn read_bounded_git_metadata_file(
    path: &Path,
    label: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, GitMetadataReadError> {
    let before =
        std::fs::symlink_metadata(path).map_err(|error| format!("inspect {label}: {error}"))?;
    if metadata_is_link_like(&before) || !before.is_file() {
        return Err(format!("{label} is not a regular file").into());
    }
    if before.len() > max_bytes {
        return Err(GitMetadataReadError::TooLarge);
    }
    let path_before_state = other_git_metadata_state(&before, label)?;

    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    let mut file = options
        .open(path)
        .map_err(|error| format!("open {label}: {error}"))?;
    let handle_before_metadata = file
        .metadata()
        .map_err(|error| format!("inspect open {label}: {error}"))?;
    if metadata_is_link_like(&handle_before_metadata) || !handle_before_metadata.is_file() {
        return Err(format!("{label} is not a regular file").into());
    }
    if handle_before_metadata.len() > max_bytes {
        return Err(GitMetadataReadError::TooLarge);
    }
    let handle_before_state = other_git_metadata_state(&handle_before_metadata, label)?;
    if path_before_state != handle_before_state {
        return Err(format!("{label} changed while being opened").into());
    }

    let read_limit = max_bytes
        .checked_add(1)
        .ok_or_else(|| format!("{label} byte limit is invalid"))?;
    let initial_capacity = usize::try_from(handle_before_metadata.len())
        .map_err(|_| GitMetadataReadError::TooLarge)?;
    let mut bytes = Vec::with_capacity(initial_capacity);
    std::io::Read::by_ref(&mut file)
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read {label}: {error}"))?;

    let handle_after_metadata = file
        .metadata()
        .map_err(|error| format!("inspect open {label} after reading: {error}"))?;
    if metadata_is_link_like(&handle_after_metadata) || !handle_after_metadata.is_file() {
        return Err(format!("{label} changed while being read").into());
    }
    let handle_after_state = other_git_metadata_state(&handle_after_metadata, label)?;
    if handle_before_state != handle_after_state {
        return Err(format!("{label} changed while being read").into());
    }
    let bytes_read = u64::try_from(bytes.len()).map_err(|_| GitMetadataReadError::TooLarge)?;
    if bytes_read > max_bytes {
        return Err(GitMetadataReadError::TooLarge);
    }

    let after = std::fs::symlink_metadata(path)
        .map_err(|error| format!("inspect {label} after reading: {error}"))?;
    if metadata_is_link_like(&after) || !after.is_file() {
        return Err(format!("{label} changed while being read").into());
    }
    let path_after_state = other_git_metadata_state(&after, label)?;
    if path_before_state != path_after_state || path_after_state != handle_after_state {
        return Err(format!("{label} changed while being read").into());
    }
    Ok(bytes)
}

fn validate_git_metadata_child_name(name: &str, label: &str) -> Result<(), String> {
    if name.is_empty() || Path::new(name).file_name().and_then(OsStr::to_str) != Some(name) {
        return Err(format!("{label} has an invalid file name"));
    }
    Ok(())
}

#[cfg(test)]
fn record_git_metadata_read_limit(max_bytes: u64) {
    TEST_GIT_METADATA_READ_LIMITS.with(|limits| limits.borrow_mut().push(max_bytes));
}

#[cfg(not(test))]
fn record_git_metadata_read_limit(_max_bytes: u64) {}

#[cfg(unix)]
struct GitMetadataDirectory {
    directory: std::fs::File,
    state: FileState,
}

#[cfg(unix)]
impl GitMetadataDirectory {
    fn open(path: &Path, label: &str) -> Result<Self, String> {
        let directory = open_directory_no_follow(path, label)?;
        let state =
            file_state(&directory).map_err(|error| format!("inspect open {label}: {error}"))?;
        if state.mode & u32::from(libc::S_IFMT) != u32::from(libc::S_IFDIR) {
            return Err(format!("{label} is not a real directory"));
        }
        Ok(Self { directory, state })
    }

    fn read_file(
        &self,
        name: &str,
        label: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>, GitMetadataReadError> {
        record_git_metadata_read_limit(max_bytes);
        validate_git_metadata_child_name(name, label)?;
        let name = CString::new(name).map_err(|_| format!("{label} has an invalid file name"))?;
        let fd = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(libc::ELOOP)) {
                return Err(format!("{label} is not a regular file").into());
            }
            return Err(format!("open {label}: {error}").into());
        }
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        let before = file_state(&file).map_err(|error| format!("inspect open {label}: {error}"))?;
        if before.mode & u32::from(libc::S_IFMT) != u32::from(libc::S_IFREG) {
            return Err(format!("{label} is not a regular file").into());
        }
        if before.size > max_bytes {
            return Err(GitMetadataReadError::TooLarge);
        }

        let read_limit = max_bytes
            .checked_add(1)
            .ok_or_else(|| format!("{label} byte limit is invalid"))?;
        let initial_capacity =
            usize::try_from(before.size).map_err(|_| GitMetadataReadError::TooLarge)?;
        let mut bytes = Vec::with_capacity(initial_capacity);
        std::io::Read::by_ref(&mut file)
            .take(read_limit)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("read {label}: {error}"))?;

        let after = file_state(&file)
            .map_err(|error| format!("inspect open {label} after reading: {error}"))?;
        if before != after {
            return Err(format!("{label} changed while being read").into());
        }
        let bytes_read = u64::try_from(bytes.len()).map_err(|_| GitMetadataReadError::TooLarge)?;
        if bytes_read > max_bytes {
            return Err(GitMetadataReadError::TooLarge);
        }
        Ok(bytes)
    }

    fn validate(&self, label: &str) -> Result<(), String> {
        let after = file_state(&self.directory)
            .map_err(|error| format!("inspect open {label} after reading: {error}"))?;
        if !same_identity(self.state, after)
            || after.mode & u32::from(libc::S_IFMT) != u32::from(libc::S_IFDIR)
        {
            return Err(format!("{label} changed while being read"));
        }
        Ok(())
    }
}

#[cfg(windows)]
struct GitMetadataDirectory {
    directory: std::fs::File,
    state: WindowsGitMetadataState,
}

#[cfg(windows)]
impl GitMetadataDirectory {
    fn open(path: &Path, label: &str) -> Result<Self, String> {
        let directory = windows_open_directory_no_follow(path, label)?;
        let state = windows_git_metadata_handle_state(&directory, label)?;
        if state.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || state.file_attributes & FILE_ATTRIBUTE_DIRECTORY == 0
        {
            return Err(format!("{label} is not a real directory"));
        }
        Ok(Self { directory, state })
    }

    fn read_file(
        &self,
        name: &str,
        label: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>, GitMetadataReadError> {
        record_git_metadata_read_limit(max_bytes);

        validate_git_metadata_child_name(name, label)?;
        let mut file = windows_open_relative_no_follow(&self.directory, name, label)?;
        let before = windows_git_metadata_handle_state(&file, label)?;
        if before.file_attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 {
            return Err(format!("{label} is not a regular file").into());
        }
        if before.file_size > max_bytes {
            return Err(GitMetadataReadError::TooLarge);
        }

        let read_limit = max_bytes
            .checked_add(1)
            .ok_or_else(|| format!("{label} byte limit is invalid"))?;
        let initial_capacity =
            usize::try_from(before.file_size).map_err(|_| GitMetadataReadError::TooLarge)?;
        let mut bytes = Vec::with_capacity(initial_capacity);
        std::io::Read::by_ref(&mut file)
            .take(read_limit)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("read {label}: {error}"))?;

        let after = windows_git_metadata_handle_state(&file, label)?;
        if !windows_git_metadata_file_state_matches(before, after)
            || after.file_attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)
                != 0
        {
            return Err(format!("{label} changed while being read").into());
        }
        let bytes_read = u64::try_from(bytes.len()).map_err(|_| GitMetadataReadError::TooLarge)?;
        if bytes_read > max_bytes {
            return Err(GitMetadataReadError::TooLarge);
        }
        Ok(bytes)
    }

    fn validate(&self, label: &str) -> Result<(), String> {
        let after = windows_git_metadata_handle_state(&self.directory, label)?;
        if !windows_git_metadata_directory_state_matches(self.state, after)
            || after.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || after.file_attributes & FILE_ATTRIBUTE_DIRECTORY == 0
        {
            return Err(format!("{label} changed while being read"));
        }
        Ok(())
    }
}

#[cfg(all(not(unix), not(windows)))]
struct GitMetadataDirectory {
    path: PathBuf,
    state: OtherGitMetadataState,
}

#[cfg(all(not(unix), not(windows)))]
impl GitMetadataDirectory {
    fn open(path: &Path, label: &str) -> Result<Self, String> {
        let metadata =
            std::fs::symlink_metadata(path).map_err(|error| format!("inspect {label}: {error}"))?;
        if metadata_is_link_like(&metadata) || !metadata.is_dir() {
            return Err(format!("{label} is not a real directory"));
        }
        let state = other_git_metadata_state(&metadata, label)?;
        Ok(Self {
            path: path.to_path_buf(),
            state,
        })
    }

    fn read_file(
        &self,
        name: &str,
        label: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>, GitMetadataReadError> {
        record_git_metadata_read_limit(max_bytes);
        validate_git_metadata_child_name(name, label)?;
        read_bounded_git_metadata_file(&self.path.join(name), label, max_bytes)
    }

    fn validate(&self, label: &str) -> Result<(), String> {
        let metadata = std::fs::symlink_metadata(&self.path)
            .map_err(|error| format!("inspect {label} after reading: {error}"))?;
        if metadata_is_link_like(&metadata) || !metadata.is_dir() {
            return Err(format!("{label} changed while being read"));
        }
        let after = other_git_metadata_state(&metadata, label)?;
        if self.state != after {
            return Err(format!("{label} changed while being read"));
        }
        Ok(())
    }
}

fn inspect_real_git_info_directory(git_dir: &Path) -> Result<Option<PathBuf>, String> {
    let info_dir = git_dir.join("info");
    match std::fs::symlink_metadata(&info_dir) {
        Ok(metadata) if metadata.is_dir() && !metadata_is_link_like(&metadata) => {
            Ok(Some(info_dir))
        }
        Ok(_) => Err("Git info directory is not a real directory".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("inspect Git info directory: {error}")),
    }
}

#[cfg(unix)]
fn read_git_info_file(git_dir: &Path, name: &str) -> Result<Option<Vec<u8>>, String> {
    let Some(info_dir) = inspect_real_git_info_directory(git_dir)? else {
        return Ok(None);
    };
    let directory = open_directory_no_follow(&info_dir, "Git info directory")?;
    let file_name = CString::new(name).expect("static file name has no NUL");
    let mut file = match open_target_no_follow(&directory, &file_name) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) if matches!(error.raw_os_error(), Some(libc::ELOOP)) => {
            return Err(format!("Git info/{name} is not a regular file"));
        }
        Err(error) => return Err(format!("open Git info/{name}: {error}")),
    };
    let before = file_state(&file)?;
    if before.mode & u32::from(libc::S_IFMT) != u32::from(libc::S_IFREG) {
        return Err(format!("Git info/{name} is not a regular file"));
    }
    if before.size > MAX_GIT_INFO_FILE_BYTES {
        return Err(format!("Git info/{name} is too large"));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("read Git info/{name}: {e}"))?;
    let mut bytes = Vec::with_capacity(before.size as usize);
    std::io::Read::by_ref(&mut file)
        .take(MAX_GIT_INFO_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read Git info/{name}: {e}"))?;
    let after = file_state(&file)?;
    if before != after {
        return Err(format!("Git info/{name} changed while being read"));
    }
    if bytes.len() as u64 > MAX_GIT_INFO_FILE_BYTES {
        return Err(format!("Git info/{name} is too large"));
    }
    Ok(Some(bytes))
}

#[cfg(not(unix))]
fn read_git_info_file(git_dir: &Path, name: &str) -> Result<Option<Vec<u8>>, String> {
    let Some(info_dir) = inspect_real_git_info_directory(git_dir)? else {
        return Ok(None);
    };
    let path = info_dir.join(name);
    let before = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("inspect Git info/{name}: {error}")),
    };
    if metadata_is_link_like(&before) || !before.is_file() {
        return Err(format!("Git info/{name} is not a regular file"));
    }
    if before.len() > MAX_GIT_INFO_FILE_BYTES {
        return Err(format!("Git info/{name} is too large"));
    }
    let mut file = std::fs::File::open(&path).map_err(|e| format!("open Git info/{name}: {e}"))?;
    let mut bytes = Vec::with_capacity(before.len() as usize);
    std::io::Read::by_ref(&mut file)
        .take(MAX_GIT_INFO_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read Git info/{name}: {e}"))?;
    let after = std::fs::symlink_metadata(&path)
        .map_err(|e| format!("inspect Git info/{name} after reading: {e}"))?;
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || metadata_is_link_like(&after)
        || !after.is_file()
    {
        return Err(format!("Git info/{name} changed while being read"));
    }
    if inspect_real_git_info_directory(git_dir)?.is_none() {
        return Err(format!("Git info/{name} changed while being read"));
    }
    if bytes.len() as u64 > MAX_GIT_INFO_FILE_BYTES {
        return Err(format!("Git info/{name} is too large"));
    }
    Ok(Some(bytes))
}

fn snapshot_git_info_file(
    source_git_dir: &Path,
    destination: &Path,
    name: &str,
) -> Result<(), String> {
    let Some(bytes) = read_git_info_file(source_git_dir, name)? else {
        return Ok(());
    };
    let info_dir = destination.join("info");
    std::fs::create_dir_all(&info_dir)
        .map_err(|e| format!("create isolated Git info directory: {e}"))?;
    std::fs::write(info_dir.join(name), bytes).map_err(|e| format!("snapshot Git info/{name}: {e}"))
}

fn snapshot_trusted_git_info(source_git_dir: &Path, destination: &Path) -> Result<(), String> {
    snapshot_git_info_file(source_git_dir, destination, "attributes")?;
    snapshot_git_info_file(source_git_dir, destination, "exclude")
}

fn resolve_git_ref(refs: &HashMap<String, GitRefValue>, name: &str) -> Option<String> {
    let mut current = name;
    let mut remaining = refs.len().saturating_add(1);
    while remaining > 0 {
        match refs.get(current)? {
            GitRefValue::Direct(oid) => return Some(oid.clone()),
            GitRefValue::Symbolic(target) => current = target,
        }
        remaining -= 1;
    }
    None
}

fn is_valid_git_reftable_table_name(name: &str) -> bool {
    fn is_windows_device_alias(stem: &str) -> bool {
        let stem = stem.trim_end_matches(|character| character == ' ' || character == '.');
        if ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"]
            .iter()
            .any(|alias| stem.eq_ignore_ascii_case(alias))
        {
            return true;
        }

        let bytes = stem.as_bytes();
        let Some(prefix) = bytes.get(..3) else {
            return false;
        };
        if !prefix.eq_ignore_ascii_case(b"COM") && !prefix.eq_ignore_ascii_case(b"LPT") {
            return false;
        }

        matches!(
            &stem[3..],
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
        )
    }

    if name.ends_with([' ', '.'])
        || name.chars().any(|character| {
            character.is_ascii_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return false;
    }

    let Some(stem) = name
        .strip_suffix(".ref")
        .or_else(|| name.strip_suffix(".log"))
    else {
        return false;
    };

    !stem.is_empty() && !is_windows_device_alias(name.split('.').next().unwrap_or_default())
}

fn snapshot_git_reftable_with_limits_and_hook<F, G>(
    source: &Path,
    destination: &Path,
    limits: GitReftableSnapshotLimits,
    after_directory_open: F,
) -> Result<(), String>
where
    F: FnOnce() -> G,
{
    let directory = GitMetadataDirectory::open(source, "Git reftable directory")?;
    let hook_guard = after_directory_open();

    let list_label = "Git reftable table list";
    let list_bytes = directory
        .read_file("tables.list", list_label, limits.list_bytes)
        .map_err(|error| error.into_message(list_label))?;
    let tables = std::str::from_utf8(&list_bytes)
        .map_err(|_| "Git reftable table list is not UTF-8".to_string())?;
    let mut names = Vec::new();
    for table in tables.lines().filter(|table| !table.is_empty()) {
        if names.len() >= limits.tables {
            return Err("Git reftable table list contains too many tables".to_string());
        }
        if Path::new(table).file_name().and_then(OsStr::to_str) != Some(table) {
            return Err("Git reftable table list contains an invalid path".to_string());
        }
        if !is_valid_git_reftable_table_name(table) {
            return Err("Git reftable table list contains an invalid table name".to_string());
        }
        names.push(table);
    }

    let mut snapshots = Vec::with_capacity(names.len());
    let mut total_bytes = 0_u64;
    for table in names {
        let remaining_bytes = limits
            .total_bytes
            .checked_sub(total_bytes)
            .ok_or_else(|| "Git reftable aggregate size is too large".to_string())?;
        let read_limit = limits.table_bytes.min(remaining_bytes);
        let aggregate_limited = remaining_bytes < limits.table_bytes;
        let label = format!("Git reftable table {table}");
        let bytes = match directory.read_file(table, &label, read_limit) {
            Ok(bytes) => bytes,
            Err(GitMetadataReadError::TooLarge) if aggregate_limited => {
                return Err("Git reftable aggregate size is too large".to_string());
            }
            Err(error) => return Err(error.into_message(&label)),
        };
        let table_bytes = u64::try_from(bytes.len())
            .map_err(|_| "Git reftable aggregate size overflowed".to_string())?;
        total_bytes = total_bytes
            .checked_add(table_bytes)
            .ok_or_else(|| "Git reftable aggregate size overflowed".to_string())?;
        if total_bytes > limits.total_bytes {
            return Err("Git reftable aggregate size is too large".to_string());
        }
        snapshots.push((table.to_string(), bytes));
    }

    drop(hook_guard);
    directory.validate("Git reftable directory")?;

    std::fs::create_dir_all(destination)
        .map_err(|error| format!("create isolated Git reftable directory: {error}"))?;
    for (table, bytes) in snapshots {
        std::fs::write(destination.join(&table), bytes)
            .map_err(|error| format!("snapshot Git reftable table {table}: {error}"))?;
    }
    std::fs::write(destination.join("tables.list"), list_bytes)
        .map_err(|error| format!("snapshot Git reftable table list: {error}"))
}

fn snapshot_git_reftable_with_limits(
    source: &Path,
    destination: &Path,
    limits: GitReftableSnapshotLimits,
) -> Result<(), String> {
    snapshot_git_reftable_with_limits_and_hook(source, destination, limits, || ())
}

fn snapshot_git_reftable(source: &Path, destination: &Path) -> Result<(), String> {
    snapshot_git_reftable_with_limits(source, destination, GIT_REFTABLE_SNAPSHOT_LIMITS)
}

fn isolated_git_metadata_command(root: &str, git_dir: &Path) -> std::process::Command {
    let mut command = git_command(root);
    command
        .env("GIT_DIR", git_dir)
        .env("GIT_OBJECT_DIRECTORY", git_dir.join("objects"))
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_CONFIG_SYSTEM", git_dir.join("empty-config"))
        .env("GIT_CONFIG_GLOBAL", git_dir.join("empty-config"))
        .env_remove("GIT_CONFIG_NOSYSTEM");
    command
}

fn resolve_isolated_git_attribute_source(
    root: &str,
    git_dir: &Path,
) -> Result<Option<String>, String> {
    let output = isolated_git_metadata_command(root, git_dir)
        .args(["rev-parse", "--verify", "HEAD"])
        .output()
        .map_err(|e| format!("resolve isolated Git attribute source: {e}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let source = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if source.is_empty() {
        Ok(None)
    } else {
        Ok(Some(source))
    }
}

fn is_null_git_oid(value: &str, object_format: Option<&str>) -> bool {
    value.len() == git_oid_hex_len(object_format) && value.bytes().all(|byte| byte == b'0')
}

fn snapshotted_git_attribute_source(
    actual_head: &str,
    refs: &HashMap<String, GitRefValue>,
    object_format: Option<&str>,
) -> Option<String> {
    let head = actual_head.trim();
    if let Some(name) = head.strip_prefix("ref: ") {
        return resolve_git_ref(refs, name).filter(|oid| !is_null_git_oid(oid, object_format));
    }
    (!head.is_empty() && !is_null_git_oid(head, object_format)).then(|| head.to_string())
}

fn validate_git_ref_storage(
    ref_storage: &str,
    detected_format: Result<String, String>,
) -> Result<(), String> {
    match ref_storage {
        "files" => Ok(()),
        "reftable" => match detected_format {
            Ok(format) if format.trim() == "reftable" => Ok(()),
            Ok(format) => Err(format!(
                "installed Git does not support reftable ref storage: reported {}",
                format.trim()
            )),
            Err(error) => Err(format!(
                "installed Git does not support reftable ref storage: {error}"
            )),
        },
        _ => Err(format!("unsupported Git ref storage: {ref_storage}")),
    }
}

fn normalize_git_line_ending_config(key: &str, value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    let normalized = match key {
        "core.autocrlf" => match value.as_str() {
            "" | "true" | "yes" | "on" | "1" => "true",
            "false" | "no" | "off" | "0" => "false",
            "input" => "input",
            _ => return Err("git config core.autocrlf has an invalid value".to_string()),
        },
        "core.eol" => match value.as_str() {
            "lf" => "lf",
            "crlf" => "crlf",
            "native" => "native",
            _ => return Err("git config core.eol has an invalid value".to_string()),
        },
        "core.safecrlf" => match value.as_str() {
            "" | "true" | "yes" | "on" | "1" => "true",
            "false" | "no" | "off" | "0" => "false",
            "warn" => "warn",
            _ => return Err("git config core.safecrlf has an invalid value".to_string()),
        },
        _ => return Err("unsupported Git line-ending config key".to_string()),
    };
    Ok(normalized.to_string())
}

fn git_inspection_line_ending_config(root: &str) -> Result<Vec<(String, String)>, String> {
    const LINE_ENDING_CONFIG_PATTERN: &str = r"^core\.(autocrlf|eol|safecrlf)$";
    let out = git_metadata_output(
        root,
        &[
            "config",
            "--includes",
            "--null",
            "--get-regexp",
            LINE_ENDING_CONFIG_PATTERN,
        ],
    )?;
    if !out.status.success() {
        if out.status.code() == Some(1) {
            return Ok(Vec::new());
        }
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let mut values = HashMap::new();
    for record in out
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let separator = record
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(|| "git config query returned malformed output".to_string())?;
        let key = std::str::from_utf8(&record[..separator])
            .map_err(|_| "git config query returned invalid UTF-8 keys".to_string())?
            .to_ascii_lowercase();
        let value = std::str::from_utf8(&record[separator + 1..])
            .map_err(|_| format!("git config {key} returned invalid UTF-8"))?;
        values.insert(key.clone(), normalize_git_line_ending_config(&key, value)?);
    }
    Ok(values.into_iter().collect())
}

fn git_inspection_config_is_multi_valued(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.starts_with("remote.") && (key.ends_with(".url") || key.ends_with(".fetch"))
}

fn git_inspection_repository_config(root: &str) -> Result<Vec<(String, String)>, String> {
    const SAFE_CONFIG_PATTERN: &str = r"^(core\.(repositoryformatversion|filemode|ignorecase|symlinks|precomposeunicode)|extensions\.(objectformat|refstorage)|branch\..*\.(remote|merge)|remote\..*\.(url|fetch))$";
    let mut scalar_values = HashMap::new();
    let mut multi_values = Vec::new();
    let mut scopes = vec!["--local"];
    if git_worktree_config_enabled(root)? {
        scopes.push("--worktree");
    }
    for scope in scopes {
        let out = git_metadata_output(
            root,
            &[
                "config",
                scope,
                "--includes",
                "--null",
                "--get-regexp",
                SAFE_CONFIG_PATTERN,
            ],
        )?;
        if !out.status.success() {
            if out.status.code() == Some(1) {
                continue;
            }
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        for record in out
            .stdout
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty())
        {
            let separator = record
                .iter()
                .position(|byte| *byte == b'\n')
                .ok_or_else(|| "git config query returned malformed output".to_string())?;
            let key = std::str::from_utf8(&record[..separator])
                .map_err(|_| "git config query returned invalid UTF-8 keys".to_string())?
                .to_string();
            let value = std::str::from_utf8(&record[separator + 1..])
                .map_err(|_| format!("git config {key} returned invalid UTF-8"))?
                .to_string();
            if git_inspection_config_is_multi_valued(&key) {
                multi_values.push((key, value));
            } else {
                scalar_values.insert(key, value);
            }
        }
    }
    // Preserve only validated, non-executable EOL conversion semantics from
    // the complete effective config. safecrlf travels with autocrlf/eol
    // because it governs diagnostics for the same irreversible conversions.
    // Encoding conversion policy remains outside this deliberately narrow
    // contract.
    for (key, value) in git_inspection_line_ending_config(root)? {
        scalar_values.insert(key, value);
    }
    let mut values = scalar_values.into_iter().collect::<Vec<_>>();
    values.extend(multi_values);
    Ok(values)
}

struct GitInspectionRepository {
    git_dir: tempfile::TempDir,
    work_tree: PathBuf,
    index: PathBuf,
    attribute_source: Option<String>,
    config: Vec<(String, String)>,
}

impl GitInspectionRepository {
    fn snapshot(
        root: &str,
        head_override: Option<&str>,
        config: Vec<(String, String)>,
    ) -> Result<Self, String> {
        let (work_tree, actual_git_dir) = git_dir_for_worktree(Path::new(root))?;
        let common_dir = git_common_dir(&actual_git_dir)?;
        let index = actual_git_dir.join("index");
        let alternate_objects = common_dir.join("objects");
        let ref_storage = config
            .iter()
            .find_map(|(key, value)| (key == "extensions.refstorage").then_some(value.as_str()))
            .unwrap_or("files");
        let detected_format = if ref_storage == "reftable" {
            run_git_metadata(root, &["rev-parse", "--show-ref-format"])
        } else {
            Ok(String::new())
        };
        validate_git_ref_storage(ref_storage, detected_format)?;
        let object_format = config
            .iter()
            .find_map(|(key, value)| (key == "extensions.objectformat").then_some(value));
        if object_format.is_some_and(|value| !matches!(value.as_str(), "sha1" | "sha256")) {
            return Err("unsupported Git object format".to_string());
        }
        let refs = if ref_storage == "files" {
            snapshot_git_refs(&common_dir, object_format.map(String::as_str))?
        } else {
            HashMap::new()
        };
        let actual_head = std::fs::read_to_string(actual_git_dir.join("HEAD"))
            .map_err(|e| format!("snapshot Git HEAD: {e}"))?;
        let expected_head = head_override
            .filter(|head| {
                !head.is_empty() && !is_null_git_oid(head, object_format.map(String::as_str))
            })
            .map(str::to_string);
        let mut attribute_source = match (
            expected_head.as_deref(),
            snapshotted_git_attribute_source(
                &actual_head,
                &refs,
                object_format.map(String::as_str),
            ),
        ) {
            (Some(expected), Some(actual)) if expected == actual => Some(expected.to_string()),
            (_, actual) => actual,
        };

        let git_dir = tempfile::Builder::new()
            .prefix("psyche-git-inspection-")
            .tempdir()
            .map_err(|e| format!("create isolated Git inspection directory: {e}"))?;
        std::fs::create_dir_all(git_dir.path().join("objects"))
            .map_err(|e| format!("create isolated Git object directory: {e}"))?;
        std::fs::create_dir_all(git_dir.path().join("objects/info"))
            .map_err(|e| format!("create isolated Git object info directory: {e}"))?;
        let alternate_objects = git_subprocess_root(&alternate_objects);
        let alternate_objects = alternate_objects.to_string_lossy();
        #[cfg(windows)]
        let alternate_objects = alternate_objects.replace('\\', "/");
        std::fs::write(
            git_dir.path().join("objects/info/alternates"),
            format!("{alternate_objects}\n"),
        )
        .map_err(|e| format!("write isolated Git alternates file: {e}"))?;
        std::fs::create_dir_all(git_dir.path().join("refs"))
            .map_err(|e| format!("create isolated Git refs directory: {e}"))?;
        let repository_format_version = config
            .iter()
            .find_map(|(key, value)| (key == "core.repositoryformatversion").then_some(value))
            .map(String::as_str)
            .unwrap_or("0");
        if !matches!(repository_format_version, "0" | "1") {
            return Err("unsupported Git repository format version".to_string());
        }
        let mut isolated_config = format!(
            "[core]\n\trepositoryformatversion = {repository_format_version}\n\tbare = false\n\tfsmonitor = false\n"
        );
        if let Some(object_format) = object_format {
            isolated_config.push_str(&format!("[extensions]\n\tobjectformat = {object_format}\n"));
        }
        if ref_storage == "reftable" {
            isolated_config.push_str("[extensions]\n\trefStorage = reftable\n");
        }
        std::fs::write(git_dir.path().join("config"), isolated_config)
            .map_err(|e| format!("write isolated Git config: {e}"))?;
        std::fs::write(git_dir.path().join("empty-config"), "")
            .map_err(|e| format!("write isolated empty Git config: {e}"))?;
        snapshot_trusted_git_info(&common_dir, git_dir.path())?;
        std::fs::write(git_dir.path().join("HEAD"), actual_head)
            .map_err(|e| format!("write isolated Git HEAD: {e}"))?;
        snapshot_git_shallow(
            &common_dir,
            git_dir.path(),
            object_format.map(String::as_str),
        )?;
        if ref_storage == "reftable" {
            snapshot_git_reftable(
                &common_dir.join("reftable"),
                &git_dir.path().join("reftable"),
            )?;
        } else {
            let mut packed_refs = Vec::new();
            for (name, value) in refs {
                match value {
                    GitRefValue::Direct(oid) => packed_refs.push((name, oid)),
                    GitRefValue::Symbolic(target) => {
                        let destination = git_dir.path().join(&name);
                        if let Some(parent) = destination.parent() {
                            std::fs::create_dir_all(parent)
                                .map_err(|e| format!("create isolated Git ref directory: {e}"))?;
                        }
                        std::fs::write(destination, format!("ref: {target}\n"))
                            .map_err(|e| format!("snapshot symbolic Git ref {name}: {e}"))?;
                    }
                }
            }
            packed_refs.sort_by(|left, right| left.0.cmp(&right.0));
            std::fs::write(
                git_dir.path().join("packed-refs"),
                format!(
                    "# pack-refs with: fully-peeled sorted\n{}",
                    packed_refs
                        .into_iter()
                        .map(|(name, oid)| format!("{oid} {name}\n"))
                        .collect::<String>()
                ),
            )
            .map_err(|e| format!("snapshot Git refs: {e}"))?;
        }
        if attribute_source.is_none() {
            attribute_source = resolve_isolated_git_attribute_source(root, git_dir.path())?;
        }
        if attribute_source.is_none() {
            let mut child = isolated_git_metadata_command(root, git_dir.path())
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .args(["hash-object", "-t", "tree", "-w", "--stdin"])
                .spawn()
                .map_err(|e| format!("create empty Git attribute tree: {e}"))?;
            drop(child.stdin.take());
            let output = child
                .wait_with_output()
                .map_err(|e| format!("create empty Git attribute tree: {e}"))?;
            if !output.status.success() {
                return Err(format!(
                    "create empty Git attribute tree: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            attribute_source = Some(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }

        Ok(Self {
            git_dir,
            work_tree,
            index,
            attribute_source,
            config,
        })
    }
}

struct GitInspectionPolicy {
    filter_drivers: Vec<GitFilterDriverOverride>,
}

impl GitInspectionPolicy {
    fn new(root: &str) -> Result<Self, String> {
        Ok(Self {
            // Inspection replays only trusted system/global filter commands.
            // Repository-local/worktree config is snapshotted separately and
            // never gets to shadow those inherited filter fallbacks by name.
            filter_drivers: git_trusted_filter_driver_overrides(root)?,
        })
    }
}

struct GitInspection<'a> {
    root: &'a str,
    policy: Arc<GitInspectionPolicy>,
    repository: GitInspectionRepository,
}

impl<'a> GitInspection<'a> {
    fn new(root: &'a str) -> Result<Self, String> {
        let config = git_inspection_repository_config(root)?;
        Self::with_policy_and_snapshot(
            root,
            Arc::new(GitInspectionPolicy::new(root)?),
            None,
            config,
        )
    }

    fn with_policy(
        root: &'a str,
        policy: Arc<GitInspectionPolicy>,
        head: Option<&str>,
    ) -> Result<Self, String> {
        let config = git_inspection_repository_config(root)?;
        Self::with_policy_and_snapshot(root, policy, head, config)
    }

    fn with_policy_and_snapshot(
        root: &'a str,
        policy: Arc<GitInspectionPolicy>,
        head: Option<&str>,
        config: Vec<(String, String)>,
    ) -> Result<Self, String> {
        Ok(Self {
            root,
            policy,
            repository: GitInspectionRepository::snapshot(root, head, config)?,
        })
    }

    fn git_command_with_config(&self, extra_config: &[(String, String)]) -> std::process::Command {
        let mut command = git_command(self.root);
        let work_tree = git_subprocess_root(&self.repository.work_tree);
        let index = git_subprocess_root(&self.repository.index);
        command
            .env("GIT_DIR", self.repository.git_dir.path())
            .env("GIT_WORK_TREE", work_tree.as_ref())
            .env("GIT_INDEX_FILE", index.as_ref())
            .env(
                "GIT_OBJECT_DIRECTORY",
                self.repository.git_dir.path().join("objects"),
            )
            .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_SYSTEM",
                self.repository.git_dir.path().join("empty-config"),
            )
            .env(
                "GIT_CONFIG_GLOBAL",
                self.repository.git_dir.path().join("empty-config"),
            )
            .env_remove("GIT_CONFIG_NOSYSTEM");
        // Preserve gitlink commit/index reporting without launching Git inside
        // populated submodules, whose repository config is not isolated here.
        command.arg("-c").arg("diff.ignoreSubmodules=dirty");
        if let Some(source) = &self.repository.attribute_source {
            command.env("GIT_ATTR_SOURCE", source);
        } else {
            command.env_remove("GIT_ATTR_SOURCE");
        }
        for (key, value) in &self.repository.config {
            command.arg("-c").arg(format!("{key}={value}"));
        }
        for (key, value) in extra_config {
            command.arg("-c").arg(format!("{key}={value}"));
        }
        for driver in &self.policy.filter_drivers {
            let has_trusted_command = driver.clean.is_some() || driver.process.is_some();
            let required = if has_trusted_command && driver.required.unwrap_or(false) {
                "true"
            } else {
                "false"
            };
            if let Some(clean) = &driver.clean {
                command
                    .arg("-c")
                    .arg(format!("filter.{}.clean={clean}", driver.driver));
            }
            if let Some(process) = &driver.process {
                command
                    .arg("-c")
                    .arg(format!("filter.{}.process={process}", driver.driver));
            }
            command
                .arg("-c")
                .arg(format!("filter.{}.required={required}", driver.driver));
        }
        command
    }

    fn execute(&self, args: &[&str]) -> Result<String, String> {
        self.execute_with_config(args, &[])
    }

    fn execute_with_config(
        &self,
        args: &[&str],
        extra_config: &[(String, String)],
    ) -> Result<String, String> {
        let out = self
            .git_command_with_config(extra_config)
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

    fn config_value(&self, key: &str) -> Option<&str> {
        self.repository
            .config
            .iter()
            .find_map(|(candidate, value)| (candidate == key).then_some(value.as_str()))
    }

    fn first_non_empty_config_value_after_last_empty_reset(&self, key: &str) -> Option<&str> {
        let last_reset = self
            .repository
            .config
            .iter()
            .rposition(|(candidate, value)| candidate == key && value.is_empty());
        let Some(last_reset) = last_reset else {
            return self.config_value(key).filter(|value| !value.is_empty());
        };
        self.repository.config[last_reset + 1..]
            .iter()
            .find_map(|(candidate, value)| {
                (candidate == key && !value.is_empty()).then_some(value.as_str())
            })
    }
}

fn run_git(root: &str, args: &[&str]) -> Result<String, String> {
    GitInspection::new(root)?.execute(args)
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
    let policy = Arc::new(GitInspectionPolicy::new(&root)?);
    let raw = run_git_metadata(&root, &["worktree", "list", "--porcelain"])?;
    let mut worktrees = parse_git_worktrees(&raw);
    for worktree in &mut worktrees {
        if worktree.prunable || worktree.bare {
            continue;
        }
        let status =
            GitInspection::with_policy(&worktree.path, Arc::clone(&policy), Some(&worktree.head))
                .and_then(|inspection| {
                    inspection.execute(&["status", "--porcelain=v1", "--untracked-files=normal"])
                });
        match status {
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
    let inside =
        run_git_metadata(&root, &["rev-parse", "--is-inside-work-tree"]).unwrap_or_default();
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
    let trusted_url_rewrites = git_trusted_url_rewrite_config(&root)?;
    let inspection = GitInspection::new(&root)?;

    let prefix = inspection
        .execute(&["rev-parse", "--show-prefix"])?
        .trim()
        .to_string();
    let raw = inspection.execute(&[
        "status",
        "--porcelain",
        "-b",
        "--untracked-files=all",
        "--",
        ".",
    ])?;
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

    let remote_url = inspection
        .first_non_empty_config_value_after_last_empty_reset("remote.origin.url")
        .map(|_| {
            // `git remote get-url` ignores command-scope `-c remote.*` values,
            // but `ls-remote --get-url` resolves the same fetch URL without
            // consulting live repository config.
            inspection
                .execute_with_config(&["ls-remote", "--get-url", "origin"], &trusted_url_rewrites)
        })
        .transpose()?
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty());
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
        "--no-ext-diff".into(),
        "--no-textconv".into(),
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
    let raw = run_git_metadata(
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

    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder
        // Registers before Tauri creates any webview, including child browser
        // webviews, so WKWebView does not silently constrain visual updates to
        // 60 Hz on macOS 13–15 and before setup/run lifecycle hooks execute.
        .plugin(tauri_plugin_macos_fps::init());
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(MetricsState::default())
        .manage(ControlProviderState::default())
        .manage(BrowserShortcutAuthorizations::default())
        .manage(BrowserAutomationAuthorizations::default())
        .invoke_handler(tauri::generate_handler![
            pty_start,
            pty_attach,
            pane_session_metrics,
            canonical_project_path,
            pty_write,
            pty_resize,
            pty_ack,
            pty_set_visibility,
            pty_stop,
            pty_list,
            pty_transport_metrics,
            browser_app_shortcut,
            browser_report_title,
            browser_automation_result,
            browser_navigate,
            browser_set_bounds,
            browser_hide,
            browser_hide_all_except,
            browser_destroy,
            browser_destroy_many,
            browser_current_url,
            browser_reload,
            browser_eval,
            browser_script,
            browser_snapshot,
            app_environment,
            coven_sessions,
            coven_session_kill,
            workspace_load,
            workspace_save,
            native_session_create,
            native_session_list,
            native_session_stop,
            native_session_capture,
            agent_skills,
            fs_list_dir,
            fs_read_text,
            fs_write_text,
            git_status,
            git_worktrees,
            git_diff,
            git_log,
            workspace_metrics,
            control_provider_start,
            control_provider_stop,
            control_provider_upsert,
            control_provider_remove,
            control_provider_complete,
            control_provider_shutdown,
            control_operator_submit,
            control_state,
        ])
        .setup(|app| {
            if let Err(error) = platform::configure_window(app) {
                log::warn!("optional window configuration unavailable: {error}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
    #[cfg(unix)]
    use std::collections::VecDeque;
    use std::future::Future;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    use super::*;
    #[cfg(not(windows))]
    use portable_pty::ChildKiller;

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

    #[cfg(not(windows))]
    #[derive(Debug)]
    struct RecordingChildKiller {
        calls: Arc<AtomicUsize>,
    }

    #[cfg(not(windows))]
    impl ChildKiller for RecordingChildKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(Self {
                calls: Arc::clone(&self.calls),
            })
        }
    }

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
            let pump = OutputPump::new(thread_id.to_string()).unwrap();
            let pending = PendingPtyStart::reserve(thread_id).unwrap();
            let (token, install_outcome) = pending
                .install(PtySession {
                    master: Arc::new(Mutex::new(pair.master)),
                    writer: Arc::new(Mutex::new(writer)),
                    operation_lane: Arc::new(tokio::sync::Mutex::new(())),
                    operation_admission: Arc::new(tokio::sync::Semaphore::new(2)),
                    pump: pump.clone(),
                    terminator: PtyProcessTerminator::from_parts(
                        Box::new(RecordingChildKiller {
                            calls: Arc::new(AtomicUsize::new(0)),
                        }),
                        PtyProcessIdentity::direct_child(None),
                    ),
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
                registry.stop(&self.token.thread_id)
            };
            if let Ok(StopSessionOutcome::Terminate { session, .. }) = action {
                drop(session);
            }
            PTY_LIFECYCLES.lock().finish_exit(&self.token);
        }
    }

    #[cfg(unix)]
    #[derive(Clone, Copy)]
    enum UnixObservationStep {
        Observed(UnixTerminationObservation),
        Disappeared,
        PermissionDenied,
    }

    #[cfg(unix)]
    struct RecordingUnixTerminationPlatform {
        observations: Mutex<VecDeque<UnixObservationStep>>,
        observation_count: AtomicUsize,
        signals: Mutex<Vec<(libc::pid_t, libc::c_int)>>,
    }

    #[cfg(unix)]
    impl RecordingUnixTerminationPlatform {
        fn new(observations: impl IntoIterator<Item = UnixObservationStep>) -> Self {
            Self {
                observations: Mutex::new(observations.into_iter().collect()),
                observation_count: AtomicUsize::new(0),
                signals: Mutex::new(Vec::new()),
            }
        }

        fn signals(&self) -> Vec<(libc::pid_t, libc::c_int)> {
            self.signals.lock().clone()
        }
    }

    #[cfg(unix)]
    impl UnixTerminationPlatform for RecordingUnixTerminationPlatform {
        fn observe_termination(
            &self,
            _identity: UnixPtyIdentity,
        ) -> std::io::Result<Option<UnixTerminationObservation>> {
            self.observation_count.fetch_add(1, Ordering::SeqCst);
            match self
                .observations
                .lock()
                .pop_front()
                .expect("test must provide one observation per escalation")
            {
                UnixObservationStep::Observed(observation) => Ok(Some(observation)),
                UnixObservationStep::Disappeared => Ok(None),
                UnixObservationStep::PermissionDenied => {
                    Err(std::io::Error::from_raw_os_error(libc::EPERM))
                }
            }
        }

        fn signal_process_group(
            &self,
            process_group: libc::pid_t,
            signal: libc::c_int,
        ) -> std::io::Result<()> {
            self.signals.lock().push((process_group, signal));
            Ok(())
        }
    }

    #[cfg(unix)]
    fn unix_observation(
        foreground_process_group: libc::pid_t,
        foreground_session: Option<libc::pid_t>,
        foreground_group: Option<libc::pid_t>,
        original_session: Option<libc::pid_t>,
        original_group: Option<libc::pid_t>,
    ) -> UnixTerminationObservation {
        UnixTerminationObservation {
            current_pid: 100,
            current_process_group: 100,
            current_session: 100,
            tty_session: 4_100,
            foreground_process_group,
            foreground_session,
            foreground_group,
            original_session,
            original_group,
        }
    }

    #[cfg(unix)]
    struct ExactUnixFixtureCleanup {
        pids: Vec<libc::pid_t>,
        process_groups: Vec<libc::pid_t>,
    }

    #[cfg(unix)]
    impl ExactUnixFixtureCleanup {
        fn new() -> Self {
            Self {
                pids: Vec::new(),
                process_groups: Vec::new(),
            }
        }

        fn track_pid(&mut self, pid: libc::pid_t) {
            self.pids.push(pid);
        }

        fn track_process_group(&mut self, process_group: libc::pid_t) {
            self.process_groups.push(process_group);
        }
    }

    #[cfg(unix)]
    impl Drop for ExactUnixFixtureCleanup {
        fn drop(&mut self) {
            let own_process_group = unsafe { libc::getpgrp() };
            self.process_groups.sort_unstable();
            self.process_groups.dedup();
            for process_group in self.process_groups.iter().copied() {
                if process_group > 1 && process_group != own_process_group {
                    unsafe {
                        libc::kill(-process_group, libc::SIGKILL);
                    }
                }
            }
            self.pids.sort_unstable();
            self.pids.dedup();
            for pid in self.pids.iter().copied() {
                if pid > 1 && pid != unsafe { libc::getpid() } {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
            }
        }
    }

    #[cfg(unix)]
    fn assert_process_group_disappears(process_group: libc::pid_t) {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if unsafe { libc::kill(-process_group, 0) } == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "process group {process_group} remained observable after SIGKILL"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
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

    #[cfg(unix)]
    #[test]
    fn unix_termination_selects_distinct_foreground_and_original_groups() {
        let groups = verified_unix_process_groups(
            UnixPtyIdentity {
                session_id: 4_100,
                original_process_group: 4_100,
            },
            UnixTerminationObservation {
                current_pid: 100,
                current_process_group: 100,
                current_session: 100,
                tty_session: 4_100,
                foreground_process_group: 4_200,
                foreground_session: Some(4_100),
                foreground_group: Some(4_200),
                original_session: Some(4_100),
                original_group: Some(4_100),
            },
        )
        .unwrap();

        assert_eq!(groups, vec![4_200, 4_100]);
    }

    #[cfg(unix)]
    #[test]
    fn unix_termination_uses_independently_verified_groups_when_ambient_ids_change() {
        let groups = verified_unix_process_groups(
            UnixPtyIdentity {
                session_id: 4_100,
                original_process_group: 4_100,
            },
            UnixTerminationObservation {
                current_pid: 100,
                current_process_group: 1,
                current_session: 1,
                tty_session: 4_200,
                foreground_process_group: 4_200,
                foreground_session: Some(4_100),
                foreground_group: Some(4_200),
                original_session: Some(4_100),
                original_group: Some(4_100),
            },
        )
        .unwrap();

        assert_eq!(groups, vec![4_200, 4_100]);
    }

    #[cfg(unix)]
    #[test]
    fn unix_termination_deduplicates_matching_foreground_and_original_groups() {
        let groups = verified_unix_process_groups(
            UnixPtyIdentity {
                session_id: 4_100,
                original_process_group: 4_100,
            },
            UnixTerminationObservation {
                current_pid: 100,
                current_process_group: 100,
                current_session: 100,
                tty_session: 4_100,
                foreground_process_group: 4_100,
                foreground_session: Some(4_100),
                foreground_group: Some(4_100),
                original_session: Some(4_100),
                original_group: Some(4_100),
            },
        )
        .unwrap();

        assert_eq!(groups, vec![4_100]);
    }

    #[cfg(unix)]
    #[test]
    fn unix_termination_rejects_psyches_own_process_group() {
        let error = verified_unix_process_groups(
            UnixPtyIdentity {
                session_id: 4_100,
                original_process_group: 4_100,
            },
            UnixTerminationObservation {
                current_pid: 99,
                current_process_group: 100,
                current_session: 90,
                tty_session: 4_100,
                foreground_process_group: 100,
                foreground_session: Some(4_100),
                foreground_group: Some(100),
                original_session: Some(4_100),
                original_group: Some(4_100),
            },
        )
        .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("Psyche"));
    }

    #[cfg(unix)]
    #[test]
    fn unix_termination_rejects_foreground_groups_from_an_unrelated_session() {
        let error = verified_unix_process_groups(
            UnixPtyIdentity {
                session_id: 4_100,
                original_process_group: 4_100,
            },
            UnixTerminationObservation {
                current_pid: 100,
                current_process_group: 100,
                current_session: 100,
                tty_session: 4_100,
                foreground_process_group: 4_200,
                foreground_session: Some(9_900),
                foreground_group: Some(4_200),
                original_session: Some(4_100),
                original_group: Some(4_100),
            },
        )
        .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("spawned PTY session"));
    }

    #[test]
    fn stop_during_start_is_recorded_and_installed_session_is_stopped() {
        let mut registry = PtyLifecycleRegistry::default();
        let start = registry.reserve("racing-start").unwrap();

        assert_eq!(
            registry.stop("racing-start").unwrap(),
            StopSessionOutcome::RecordedDuringStart {
                generation: start.generation,
            }
        );
        assert_eq!(
            registry.install(&start, "spawned-child").unwrap(),
            InstallSessionOutcome::StopImmediately("spawned-child")
        );
        assert!(!registry.is_live("racing-start"));
        assert!(registry.reserve("racing-start").is_err());
        assert!(matches!(
            registry.begin_exit(&start),
            BeginExitOutcome::Emit { session: None }
        ));
        assert!(registry.finish_exit(&start));
    }

    #[test]
    fn same_id_restart_waits_for_exit_and_old_generation_cannot_emit_again() {
        let mut registry = PtyLifecycleRegistry::default();
        let old = registry.reserve("same-id").unwrap();
        assert_eq!(
            registry.install(&old, "old-session").unwrap(),
            InstallSessionOutcome::Running
        );
        assert_eq!(
            registry.stop("same-id").unwrap(),
            StopSessionOutcome::Terminate {
                generation: old.generation,
                session: "old-session",
            }
        );
        assert!(matches!(
            registry.begin_exit(&old),
            BeginExitOutcome::Emit { session: None }
        ));
        assert!(registry.reserve("same-id").is_err());

        assert!(registry.finish_exit(&old));
        let replacement = registry.reserve("same-id").unwrap();
        assert_ne!(replacement.generation, old.generation);
        assert!(matches!(registry.begin_exit(&old), BeginExitOutcome::Stale));
        assert_eq!(
            registry
                .install(&replacement, "replacement-session")
                .unwrap(),
            InstallSessionOutcome::Running
        );
        assert!(registry.is_live("same-id"));
    }

    #[test]
    fn timed_out_exit_blocks_same_id_restart_until_old_emitter_cleanup_finishes() {
        let registry = Arc::new(Mutex::new(PtyLifecycleRegistry::default()));
        let old = {
            let mut registry = registry.lock();
            let old = registry.reserve("timed-out-pane").unwrap();
            assert_eq!(
                registry.install(&old, "old-output-pump").unwrap(),
                InstallSessionOutcome::Running
            );
            assert_eq!(
                registry.reserve("timed-out-pane").unwrap_err().to_string(),
                "thread 'timed-out-pane' already running"
            );
            assert!(matches!(
                registry.begin_exit(&old),
                BeginExitOutcome::Emit {
                    session: Some("old-output-pump")
                }
            ));
            old
        };
        let (old_emit_done_tx, old_emit_done_rx) = mpsc::channel();
        let cleanup_registry = Arc::clone(&registry);
        let cleanup_token = old.clone();
        let cleanup = std::thread::spawn(move || {
            old_emit_done_rx.recv().unwrap();
            cleanup_registry.lock().finish_exit(&cleanup_token)
        });
        assert_eq!(
            registry
                .lock()
                .reserve("timed-out-pane")
                .unwrap_err()
                .to_string(),
            "thread 'timed-out-pane' cleanup in progress"
        );
        old_emit_done_tx.send(()).unwrap();
        assert!(cleanup.join().unwrap());
        let replacement = registry.lock().reserve("timed-out-pane").unwrap();
        assert_ne!(replacement.generation, old.generation);
    }

    #[cfg(not(windows))]
    #[test]
    fn pty_ack_reports_missing_invalid_duplicate_future_and_skipped_sequences() {
        assert_eq!(
            pty_ack_inner("missing-pane".to_string(), 1).unwrap_err(),
            "thread 'missing-pane' not found"
        );
        assert_eq!(
            pty_ack_inner("../unsafe".to_string(), 1).unwrap_err(),
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
            pty_ack_inner("ack-pane".to_string(), 1).unwrap(),
            AckOutcome::Advanced {
                sequence: 1,
                bytes: 1,
                latency_micros,
            } if latency_micros >= duration_to_micros(pty_transport::VISIBLE_CADENCE)
        ));
        assert_eq!(
            pty_ack_inner("ack-pane".to_string(), 1).unwrap(),
            AckOutcome::Duplicate { sequence: 1 }
        );
        assert!(matches!(
            pty_ack_inner("ack-pane".to_string(), 2).unwrap(),
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
            pty_ack_inner("ack-skipped-pane".to_string(), 2).unwrap_err(),
            "PTY batch acknowledgement 2 skipped expected sequence 1"
        );
        assert_eq!(
            pty_ack_inner("ack-skipped-pane".to_string(), 3).unwrap_err(),
            "PTY batch acknowledgement 3 is newer than emitted sequence 2"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn pty_set_visibility_only_updates_metrics_on_actual_transitions() {
        assert_eq!(
            pty_set_visibility_inner("missing-visibility".to_string(), false).unwrap_err(),
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

        pty_set_visibility_inner("visibility-pane".to_string(), true).unwrap();
        let noop_visible = pty_transport_metrics_inner(Some("visibility-pane".to_string()))
            .pop()
            .unwrap();
        assert_eq!(noop_visible.visibility, PtyTransportVisibility::Visible);
        assert_eq!(noop_visible.effective_cadence_micros, visible_cadence);
        assert_eq!(noop_visible.metrics.visibility_transition_count, 0);

        pty_set_visibility_inner("visibility-pane".to_string(), false).unwrap();
        let hidden = pty_transport_metrics_inner(Some("visibility-pane".to_string()))
            .pop()
            .unwrap();
        assert_eq!(hidden.visibility, PtyTransportVisibility::Hidden);
        assert_eq!(hidden.effective_cadence_micros, hidden_cadence);
        assert_eq!(hidden.metrics.visibility_transition_count, 1);

        pty_set_visibility_inner("visibility-pane".to_string(), false).unwrap();
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

    #[cfg(not(windows))]
    #[test]
    fn retained_child_killer_is_invoked_by_process_termination() {
        let calls = Arc::new(AtomicUsize::new(0));
        let terminator = PtyProcessTerminator::from_parts(
            Box::new(RecordingChildKiller {
                calls: Arc::clone(&calls),
            }),
            PtyProcessIdentity::direct_child(Some(41)),
        );

        assert_eq!(
            terminator.terminate().unwrap(),
            PtyTerminationOutcome::DirectChild
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[cfg(not(windows))]
    #[test]
    fn pid_fallback_is_disabled_before_the_wait_callback_runs() {
        let calls = Arc::new(AtomicUsize::new(0));
        let terminator = PtyProcessTerminator::from_parts(
            Box::new(RecordingChildKiller {
                calls: Arc::clone(&calls),
            }),
            PtyProcessIdentity::direct_child(Some(44)),
        );

        let outcome = terminator.wait_for_child(|| terminator.terminate().unwrap());

        assert_eq!(outcome, PtyTerminationOutcome::NoProcess);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[cfg(not(windows))]
    #[test]
    fn timeout_cleanup_after_wait_never_calls_the_raw_pid_killer() {
        let calls = Arc::new(AtomicUsize::new(0));
        let terminator = PtyProcessTerminator::from_parts(
            Box::new(RecordingChildKiller {
                calls: Arc::clone(&calls),
            }),
            PtyProcessIdentity::direct_child(Some(45)),
        );

        terminator.wait_for_child(|| ());
        assert_eq!(
            terminator.terminate().unwrap(),
            PtyTerminationOutcome::NoProcess
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[cfg(not(windows))]
    #[test]
    fn stop_before_wait_consumes_the_owned_killer_exactly_once() {
        let calls = Arc::new(AtomicUsize::new(0));
        let terminator = PtyProcessTerminator::from_parts(
            Box::new(RecordingChildKiller {
                calls: Arc::clone(&calls),
            }),
            PtyProcessIdentity::direct_child(Some(46)),
        );

        assert_eq!(
            terminator.terminate().unwrap(),
            PtyTerminationOutcome::DirectChild
        );
        assert_eq!(
            terminator.terminate().unwrap(),
            PtyTerminationOutcome::NoProcess
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
    #[test]
    fn unix_each_escalation_uses_a_fresh_validation_snapshot() {
        let calls = Arc::new(AtomicUsize::new(0));
        let platform = Arc::new(RecordingUnixTerminationPlatform::new([
            UnixObservationStep::Observed(unix_observation(
                4_200,
                Some(4_100),
                Some(4_200),
                Some(4_100),
                Some(4_100),
            )),
            UnixObservationStep::Observed(unix_observation(
                4_300,
                Some(4_100),
                Some(4_300),
                Some(4_100),
                Some(4_100),
            )),
            UnixObservationStep::Observed(unix_observation(
                4_400,
                Some(4_100),
                Some(4_400),
                Some(4_100),
                Some(4_100),
            )),
        ]));
        let terminator = PtyProcessTerminator::from_unix_parts(
            Box::new(RecordingChildKiller {
                calls: Arc::clone(&calls),
            }),
            PtyProcessIdentity {
                child_pid: Some(4_100),
                unix: Some(UnixPtyIdentity {
                    session_id: 4_100,
                    original_process_group: 4_100,
                }),
            },
            platform.clone(),
        );

        assert_eq!(
            terminator.terminate().unwrap(),
            PtyTerminationOutcome::ConfirmedProcessGroups {
                foreground_process_group: 4_200,
                original_process_group: 4_100,
                group_count: 2,
            }
        );
        assert_eq!(platform.observation_count.load(Ordering::SeqCst), 3);
        assert_eq!(
            platform.signals(),
            vec![
                (4_200, libc::SIGHUP),
                (4_100, libc::SIGHUP),
                (4_300, libc::SIGCONT),
                (4_100, libc::SIGCONT),
                (4_400, libc::SIGKILL),
                (4_100, libc::SIGKILL),
            ]
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[cfg(unix)]
    #[test]
    fn unix_recycled_original_group_identity_is_rejected_without_signaling() {
        let calls = Arc::new(AtomicUsize::new(0));
        let platform = Arc::new(RecordingUnixTerminationPlatform::new([
            UnixObservationStep::Observed(unix_observation(
                4_200,
                Some(4_100),
                Some(4_200),
                Some(9_900),
                Some(4_100),
            )),
        ]));
        let terminator = PtyProcessTerminator::from_unix_parts(
            Box::new(RecordingChildKiller {
                calls: Arc::clone(&calls),
            }),
            PtyProcessIdentity {
                child_pid: Some(4_100),
                unix: Some(UnixPtyIdentity {
                    session_id: 4_100,
                    original_process_group: 4_100,
                }),
            },
            platform.clone(),
        );
        terminator.wait_for_child(|| ());

        let error = terminator.terminate().unwrap_err();

        assert!(error.contains("spawned PTY session"));
        assert!(platform.signals().is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[cfg(unix)]
    #[test]
    fn unix_disappeared_groups_are_a_successful_no_op() {
        let calls = Arc::new(AtomicUsize::new(0));
        let platform = Arc::new(RecordingUnixTerminationPlatform::new([
            UnixObservationStep::Disappeared,
            UnixObservationStep::Disappeared,
            UnixObservationStep::Disappeared,
        ]));
        let terminator = PtyProcessTerminator::from_unix_parts(
            Box::new(RecordingChildKiller {
                calls: Arc::clone(&calls),
            }),
            PtyProcessIdentity {
                child_pid: Some(4_100),
                unix: Some(UnixPtyIdentity {
                    session_id: 4_100,
                    original_process_group: 4_100,
                }),
            },
            platform.clone(),
        );
        terminator.wait_for_child(|| ());

        assert_eq!(
            terminator.terminate().unwrap(),
            PtyTerminationOutcome::NoProcess
        );
        assert_eq!(platform.observation_count.load(Ordering::SeqCst), 3);
        assert!(platform.signals().is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[cfg(unix)]
    #[test]
    fn unix_permission_errors_surface_without_post_wait_pid_fallback() {
        let calls = Arc::new(AtomicUsize::new(0));
        let platform = Arc::new(RecordingUnixTerminationPlatform::new([
            UnixObservationStep::PermissionDenied,
        ]));
        let terminator = PtyProcessTerminator::from_unix_parts(
            Box::new(RecordingChildKiller {
                calls: Arc::clone(&calls),
            }),
            PtyProcessIdentity {
                child_pid: Some(4_100),
                unix: Some(UnixPtyIdentity {
                    session_id: 4_100,
                    original_process_group: 4_100,
                }),
            },
            platform.clone(),
        );
        terminator.wait_for_child(|| ());

        let error = terminator.terminate().unwrap_err();

        assert!(error.contains("Operation not permitted"));
        assert!(platform.signals().is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    /// SIGHUP is what tears the session down, so by SIGCONT the terminal may
    /// already be disassociated and observation starts failing. That must not
    /// abort the escalation before SIGKILL: the groups were verified as ours on
    /// the first round and stay ours.
    #[cfg(unix)]
    #[test]
    fn unix_termination_finishes_escalating_when_observation_fails_after_verification() {
        let calls = Arc::new(AtomicUsize::new(0));
        let platform = Arc::new(RecordingUnixTerminationPlatform::new([
            UnixObservationStep::Observed(unix_observation(
                4_200,
                Some(4_100),
                Some(4_200),
                Some(4_100),
                Some(4_100),
            )),
            UnixObservationStep::PermissionDenied,
            UnixObservationStep::PermissionDenied,
        ]));
        let terminator = PtyProcessTerminator::from_unix_parts(
            Box::new(RecordingChildKiller {
                calls: Arc::clone(&calls),
            }),
            PtyProcessIdentity {
                child_pid: Some(4_100),
                unix: Some(UnixPtyIdentity {
                    session_id: 4_100,
                    original_process_group: 4_100,
                }),
            },
            platform.clone(),
        );
        terminator.wait_for_child(|| ());

        assert_eq!(
            terminator.terminate().unwrap(),
            PtyTerminationOutcome::ConfirmedProcessGroups {
                foreground_process_group: 4_200,
                original_process_group: 4_100,
                group_count: 2,
            }
        );
        // Both groups still receive all three signals, SIGKILL included.
        assert_eq!(
            platform.signals(),
            vec![
                (4_200, libc::SIGHUP),
                (4_100, libc::SIGHUP),
                (4_200, libc::SIGCONT),
                (4_100, libc::SIGCONT),
                (4_200, libc::SIGKILL),
                (4_100, libc::SIGKILL),
            ]
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    /// Same guarantee when the observation succeeds but no longer validates —
    /// a reaped foreground leader reports a session that is not ours.
    #[cfg(unix)]
    #[test]
    fn unix_termination_finishes_escalating_when_validation_fails_after_verification() {
        let calls = Arc::new(AtomicUsize::new(0));
        let foreign = unix_observation(4_200, Some(9_999), Some(4_200), Some(9_999), Some(4_100));
        let platform = Arc::new(RecordingUnixTerminationPlatform::new([
            UnixObservationStep::Observed(unix_observation(
                4_200,
                Some(4_100),
                Some(4_200),
                Some(4_100),
                Some(4_100),
            )),
            UnixObservationStep::Observed(foreign),
            UnixObservationStep::Observed(foreign),
        ]));
        let terminator = PtyProcessTerminator::from_unix_parts(
            Box::new(RecordingChildKiller {
                calls: Arc::clone(&calls),
            }),
            PtyProcessIdentity {
                child_pid: Some(4_100),
                unix: Some(UnixPtyIdentity {
                    session_id: 4_100,
                    original_process_group: 4_100,
                }),
            },
            platform.clone(),
        );
        terminator.wait_for_child(|| ());

        assert_eq!(
            terminator.terminate().unwrap(),
            PtyTerminationOutcome::ConfirmedProcessGroups {
                foreground_process_group: 4_200,
                original_process_group: 4_100,
                group_count: 2,
            }
        );
        assert_eq!(platform.signals().len(), 6);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[cfg(not(windows))]
    #[test]
    fn spawned_start_guard_terminates_on_setup_failure_but_not_after_install() {
        let failed_calls = Arc::new(AtomicUsize::new(0));
        let failed_terminator = PtyProcessTerminator::from_parts(
            Box::new(RecordingChildKiller {
                calls: Arc::clone(&failed_calls),
            }),
            PtyProcessIdentity::direct_child(Some(42)),
        );
        drop(PtySpawnTerminationGuard::new(failed_terminator));
        assert_eq!(failed_calls.load(Ordering::SeqCst), 1);

        let installed_calls = Arc::new(AtomicUsize::new(0));
        let installed_terminator = PtyProcessTerminator::from_parts(
            Box::new(RecordingChildKiller {
                calls: Arc::clone(&installed_calls),
            }),
            PtyProcessIdentity::direct_child(Some(43)),
        );
        let mut guard = PtySpawnTerminationGuard::new(installed_terminator);
        guard.disarm();
        drop(guard);
        assert_eq!(installed_calls.load(Ordering::SeqCst), 0);
    }

    #[cfg(unix)]
    #[test]
    fn interactive_foreground_process_group_termination_finishes_child_and_reader() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 10,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "set -m; trap '' HUP TERM; sh -c 'trap \"\" HUP TERM; exec sleep 30' & fg",
        ]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        let child_pid = child.process_id().unwrap() as libc::pid_t;
        let mut cleanup = ExactUnixFixtureCleanup::new();
        cleanup.track_pid(child_pid);
        cleanup.track_process_group(child_pid);
        let terminator =
            PtyProcessTerminator::from_spawned_child(child.as_ref(), pair.master.as_ref()).unwrap();
        assert_eq!(
            terminator.identity().confirmed_unix_process_group(),
            Some(child_pid)
        );
        let control_fd = pair
            .master
            .as_raw_fd()
            .expect("Unix PTY master must expose its control descriptor");
        let foreground_deadline = std::time::Instant::now() + Duration::from_secs(2);
        let foreground_process_group = loop {
            let foreground = unsafe { libc::tcgetpgrp(control_fd) };
            if foreground > 1 && foreground != child_pid {
                break foreground;
            }
            assert!(
                std::time::Instant::now() < foreground_deadline,
                "interactive fixture never installed a distinct foreground process group"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        cleanup.track_pid(foreground_process_group);
        cleanup.track_process_group(foreground_process_group);

        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let (reader_tx, reader_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = reader.read_to_end(&mut bytes);
            let _ = reader_tx.send(result);
        });
        let (child_tx, child_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = child_tx.send(child.wait());
        });

        assert_eq!(
            terminator.terminate().unwrap(),
            PtyTerminationOutcome::ConfirmedProcessGroups {
                foreground_process_group,
                original_process_group: child_pid,
                group_count: 2,
            }
        );
        drop(writer);
        drop(pair.master);

        child_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("terminated PTY child wait must finish")
            .expect("terminated PTY child wait must succeed");
        reader_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("terminated PTY reader must finish")
            .expect("terminated PTY reader must exit cleanly");
        assert_process_group_disappears(foreground_process_group);
        assert_process_group_disappears(child_pid);
    }
}

#[cfg(test)]
mod workspace_panel_tests {
    use super::*;
    use std::ffi::{OsStr, OsString};
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[cfg(windows)]
    use std::os::windows::fs::{symlink_dir, symlink_file};
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

    struct TestGitEnvOverrideGuard {
        previous: Vec<(OsString, Option<OsString>)>,
    }

    impl TestGitEnvOverrideGuard {
        fn set(overrides: &[(&str, Option<&OsStr>)]) -> Self {
            let overrides = overrides
                .iter()
                .map(|(key, value)| {
                    (
                        OsString::from(key),
                        value.map(std::borrow::ToOwned::to_owned),
                    )
                })
                .collect();
            let previous = TEST_GIT_ENV_OVERRIDES
                .with(|slot| std::mem::replace(&mut *slot.borrow_mut(), overrides));
            Self { previous }
        }
    }

    impl Drop for TestGitEnvOverrideGuard {
        fn drop(&mut self) {
            TEST_GIT_ENV_OVERRIDES.with(|slot| {
                *slot.borrow_mut() = std::mem::take(&mut self.previous);
            });
        }
    }

    fn path_text(path: &Path) -> &str {
        path.to_str().expect("test paths must be UTF-8")
    }

    #[test]
    fn git_subprocess_root_requires_ascii_drive_letters() {
        let prefix = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
        let mut ascii_drive = prefix.to_vec();
        ascii_drive.extend([b'C' as u16, b':' as u16, b'\\' as u16]);
        let mut non_ascii_drive = prefix.to_vec();
        non_ascii_drive.extend([0x0141, b':' as u16, b'\\' as u16]);

        assert!(has_windows_verbatim_disk_prefix(&ascii_drive));
        assert!(!has_windows_verbatim_disk_prefix(&non_ascii_drive));
    }

    #[cfg(windows)]
    #[test]
    fn git_subprocess_root_removes_only_verbatim_disk_prefixes() {
        assert_eq!(
            git_subprocess_root(Path::new(r"\\?\C:\workspace\project")).as_ref(),
            Path::new(r"C:\workspace\project")
        );
        assert_eq!(
            git_subprocess_root(Path::new(r"\\?\UNC\server\share\project")).as_ref(),
            Path::new(r"\\?\UNC\server\share\project")
        );
        assert_eq!(
            git_subprocess_root(Path::new(r"C:\workspace\project")).as_ref(),
            Path::new(r"C:\workspace\project")
        );
    }

    fn shell_single_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    #[cfg(unix)]
    fn write_test_executable(path: &Path, mode: u32) {
        std::fs::write(path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn write_marker_executable(path: &Path) {
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
    fn shell_path(path: &Path) -> String {
        path_text(path).replace('\\', "/")
    }

    fn marker_command(helper: &Path, marker: &Path) -> String {
        format!(
            "PSYCHE_TEST_MARKER={} {}",
            shell_single_quote(&shell_path(marker)),
            shell_single_quote(&shell_path(helper))
        )
    }

    fn trusted_normalizing_clean_command() -> &'static str {
        "sed -e 's/[[:space:]]*$//'"
    }

    #[derive(Clone, Copy)]
    enum TestSymlinkKind {
        Directory,
        File,
    }

    fn can_skip_symlink_test(error: &std::io::Error) -> bool {
        matches!(
            error.kind(),
            std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Unsupported
        ) || matches!(error.raw_os_error(), Some(1314))
    }

    fn create_test_symlink(kind: TestSymlinkKind, target: &Path, link: &Path) -> bool {
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

    #[test]
    fn git_filter_driver_overrides_respect_includes_and_prefer_global_over_system_per_key() {
        let tree = TempTree::new("git-filter-scope-precedence");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let system_config = tree.root.join("system.gitconfig");
        let system_include = tree.root.join("system-filter.cfg");
        let global_config = home.join(".gitconfig");
        let global_include = tree.root.join("global-filter.cfg");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        run_test_git(&project, &["init", "-q"]);
        std::fs::write(
            &system_include,
            "[filter \"trusted-mixed\"]\n\tclean = system-clean --mode normalize\n\tprocess = system-process --mode normalize\n\trequired = true\n",
        )
        .unwrap();
        run_test_git(
            &project,
            &[
                "config",
                "--file",
                path_text(&system_config),
                "include.path",
                path_text(&system_include),
            ],
        );
        std::fs::write(
            &global_include,
            "[filter \"trusted-mixed\"]\n\tprocess = global-process --mode normalize\n\trequired = false\n",
        )
        .unwrap();
        run_test_git(
            &project,
            &[
                "config",
                "--file",
                path_text(&global_config),
                "include.path",
                path_text(&global_include),
            ],
        );

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_SYSTEM", Some(system_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", None),
        ]);

        let config = git_filter_driver_override(
            path_text(&project),
            "trusted-mixed".to_string(),
            true,
            true,
        )
        .unwrap();

        assert_eq!(config.driver, "trusted-mixed");
        assert!(config.repository_clean);
        assert!(config.repository_process);
        assert_eq!(
            config.clean.as_deref(),
            Some("system-clean --mode normalize")
        );
        assert_eq!(
            config.process.as_deref(),
            Some("global-process --mode normalize")
        );
        assert_eq!(config.required, Some(false));
    }

    #[test]
    fn git_status_reads_each_filter_config_scope_once() {
        let tree = TempTree::new("git-filter-query-count");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "filter.first.clean", "first-clean"]);
        run_test_git(
            &tree.root,
            &["config", "filter.second.process", "second-process"],
        );
        TEST_GIT_FILTER_SCOPE_QUERIES.with(|queries| queries.borrow_mut().clear());

        git_status(path_text(&tree.root).to_string()).unwrap();

        let queries = TEST_GIT_FILTER_SCOPE_QUERIES.with(|queries| queries.borrow().clone());
        assert!(
            !queries.iter().any(|query| query == "--local"),
            "repository filter config must not be loaded into the inspection policy: {queries:?}"
        );
        for scope in ["--system", "--global"] {
            assert_eq!(
                queries
                    .iter()
                    .filter(|query| query.as_str() == scope)
                    .count(),
                1,
                "{scope} filter config must be read once per git_status operation: {queries:?}"
            );
        }
    }

    #[test]
    fn git_worktrees_reuses_one_filter_policy_for_all_worktrees() {
        let tree = TempTree::new("git-worktree-filter-query-count");
        let linked_one = tree.root.join("linked-one");
        let linked_two = tree.root.join("linked-two");
        let repository = tree.root.join("repository");
        std::fs::create_dir_all(&repository).unwrap();
        run_test_git(&repository, &["init", "-q"]);
        run_test_git(&repository, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &repository,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(repository.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&repository, &["add", "tracked.txt"]);
        run_test_git(&repository, &["commit", "-qm", "baseline"]);
        run_test_git(
            &repository,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "linked-one",
                path_text(&linked_one),
            ],
        );
        run_test_git(
            &repository,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "linked-two",
                path_text(&linked_two),
            ],
        );
        TEST_GIT_FILTER_SCOPE_QUERIES.with(|queries| queries.borrow_mut().clear());
        TEST_GIT_COMMAND_COUNT.with(|count| *count.borrow_mut() = 0);

        let worktrees = git_worktrees(path_text(&repository).to_string()).unwrap();

        assert_eq!(worktrees.len(), 3);
        let command_count = TEST_GIT_COMMAND_COUNT.with(|count| *count.borrow());
        assert_eq!(
            command_count,
            15,
            "worktree inspection should reuse three shared policy/list queries while snapshotting two repository config scopes, effective line endings, and one status process per worktree"
        );
        let queries = TEST_GIT_FILTER_SCOPE_QUERIES.with(|queries| queries.borrow().clone());
        for scope in ["--system", "--global"] {
            assert_eq!(
                queries
                    .iter()
                    .filter(|query| query.as_str() == scope)
                    .count(),
                1,
                "{scope} filter config must be snapshotted once for the complete worktree operation: {queries:?}"
            );
        }
    }

    #[test]
    fn git_worktrees_preserves_linked_worktree_sha256_and_filemode_config() {
        let tree = TempTree::new("git-worktree-sha256-filemode");
        let repository = tree.root.join("repository");
        let linked = tree.root.join("linked");
        std::fs::create_dir_all(&repository).unwrap();
        run_test_git(&repository, &["init", "-q", "--object-format=sha256"]);
        run_test_git(&repository, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &repository,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&repository, &["config", "core.filemode", "false"]);
        std::fs::write(repository.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&repository, &["add", "tracked.txt"]);
        run_test_git(&repository, &["commit", "-qm", "baseline"]);
        run_test_git(
            &repository,
            &["worktree", "add", "-q", "-b", "linked", path_text(&linked)],
        );
        #[cfg(unix)]
        std::fs::set_permissions(
            linked.join("tracked.txt"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();

        let worktrees = git_worktrees(path_text(&repository).to_string()).unwrap();
        let linked_status = worktrees
            .iter()
            .find(|worktree| worktree.branch.as_deref() == Some("linked"))
            .expect("linked worktree must be reported");

        assert!(
            !linked_status.missing,
            "SHA-256 linked worktree inspection must succeed"
        );
        assert!(
            !linked_status.dirty,
            "linked worktree inspection must preserve core.filemode=false"
        );
    }

    #[test]
    fn git_status_and_diff_preserve_effective_global_crlf_normalization() {
        let tree = TempTree::new("git-global-crlf-normalization");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            &global_config,
            "[core]\n\tautocrlf = true\n\teol = crlf\n\tsafecrlf = true\n",
        )
        .unwrap();
        run_test_git(&project, &["init", "-q"]);
        std::fs::write(
            project.join(".gitattributes"),
            b"/.gitattributes -text\r\ntracked.txt text\r\n",
        )
        .unwrap();
        std::fs::write(project.join("tracked.txt"), b"first\r\nsecond\r\n").unwrap();

        let env = [
            ("HOME", path_text(&home)),
            ("GIT_CONFIG_GLOBAL", path_text(&global_config)),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ];
        run_test_git_with_env(&project, &["add", ".gitattributes", "tracked.txt"], &env);
        run_test_git_with_env(
            &project,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
            &env,
        );
        std::fs::write(project.join("tracked.txt"), b"first\r\nsecond\r\n").unwrap();
        let raw_status =
            run_test_git_stdout_with_env(&project, &["status", "--porcelain", "--", "."], &env);
        assert!(
            raw_status.trim().is_empty(),
            "effective global CRLF normalization must keep raw status clean: {raw_status:?}"
        );

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);
        let status = git_status(path_text(&project).to_string()).unwrap();
        let diff = git_diff(path_text(&project).to_string(), None, Some(false), None).unwrap();

        assert!(
            status.files.is_empty(),
            "isolated CRLF status files: {:?}",
            status.files
        );
        assert!(diff.text.is_empty(), "isolated CRLF diff: {:?}", diff.text);
        assert_eq!(diff.bytes, 0);
    }

    #[test]
    fn git_status_and_diff_preserve_local_line_endings_after_root_canonicalization() {
        let tree = TempTree::new("git-canonical-root-line-endings");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            &global_config,
            "[core]\n\tautocrlf = true\n\teol = crlf\n\tsafecrlf = true\n",
        )
        .unwrap();
        run_test_git(&project, &["init", "-q"]);
        run_test_git(&project, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &project,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&project, &["config", "core.autocrlf", "false"]);
        std::fs::write(project.join("tracked.txt"), b"first\nsecond\nthird\n").unwrap();
        run_test_git(&project, &["add", "tracked.txt"]);
        run_test_git(&project, &["commit", "-qm", "baseline"]);

        std::fs::write(project.join("tracked.txt"), b"first\nsecond\nthird\n").unwrap();
        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);
        let status = git_status(path_text(&project).to_string()).unwrap();
        assert!(
            status.files.is_empty(),
            "canonicalized inspection must preserve local core.autocrlf=false: {:?}",
            status.files
        );

        std::fs::write(project.join("tracked.txt"), b"first\nchanged\nthird\n").unwrap();
        let diff = git_diff(
            path_text(&project).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            Some(0),
        )
        .unwrap();
        assert!(diff.text.contains("-second"));
        assert!(diff.text.contains("+changed"));
        assert!(!diff.text.contains("-first"));
        assert!(!diff.text.contains("+first"));
        assert!(!diff.text.contains("-third"));
        assert!(!diff.text.contains("+third"));
    }

    #[test]
    fn git_inspection_snapshots_only_effective_line_ending_config() {
        let tree = TempTree::new("git-effective-line-ending-config");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            &global_config,
            "[core]\n\tautocrlf = true\n\teol = crlf\n\tsafecrlf = warn\n\tcheckRoundtripEncoding = SHIFT-JIS\n",
        )
        .unwrap();
        run_test_git(&project, &["init", "-q"]);
        run_test_git(&project, &["config", "core.autocrlf", "input"]);
        run_test_git(&project, &["config", "core.eol", "lf"]);

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);
        let config = git_inspection_repository_config(path_text(&project)).unwrap();
        let values = config.into_iter().collect::<HashMap<_, _>>();

        assert_eq!(
            values.get("core.autocrlf").map(String::as_str),
            Some("input")
        );
        assert_eq!(values.get("core.eol").map(String::as_str), Some("lf"));
        assert_eq!(
            values.get("core.safecrlf").map(String::as_str),
            Some("warn")
        );
        assert!(
            !values.contains_key("core.checkroundtripencoding"),
            "encoding conversion policy is outside the line-ending snapshot contract"
        );
    }

    #[test]
    fn git_worktrees_preserve_worktree_specific_crlf_normalization() {
        let tree = TempTree::new("git-worktree-crlf-normalization");
        let repository = tree.root.join("repository");
        let linked = tree.root.join("linked");
        std::fs::create_dir_all(&repository).unwrap();
        run_test_git(&repository, &["init", "-q"]);
        run_test_git(&repository, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &repository,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&repository, &["config", "core.autocrlf", "false"]);
        run_test_git(&repository, &["config", "core.eol", "lf"]);
        std::fs::write(repository.join(".gitattributes"), "tracked.txt text\n").unwrap();
        std::fs::write(repository.join("tracked.txt"), "first\nsecond\n").unwrap();
        run_test_git(&repository, &["add", ".gitattributes", "tracked.txt"]);
        run_test_git(&repository, &["commit", "-qm", "baseline"]);
        run_test_git(
            &repository,
            &["config", "extensions.worktreeConfig", "true"],
        );
        run_test_git(
            &repository,
            &["worktree", "add", "-q", "-b", "linked", path_text(&linked)],
        );
        run_test_git(&linked, &["config", "--worktree", "core.autocrlf", "true"]);
        run_test_git(&linked, &["config", "--worktree", "core.eol", "crlf"]);
        std::fs::remove_file(linked.join("tracked.txt")).unwrap();
        run_test_git(&linked, &["checkout", "HEAD", "--", "tracked.txt"]);
        assert_eq!(
            std::fs::read(linked.join("tracked.txt")).unwrap(),
            b"first\r\nsecond\r\n"
        );
        let raw_status =
            run_test_git_stdout_with_env(&linked, &["status", "--porcelain", "--", "."], &[]);
        assert!(
            raw_status.trim().is_empty(),
            "linked worktree CRLF normalization must keep raw status clean: {raw_status:?}"
        );

        let worktrees = git_worktrees(path_text(&repository).to_string()).unwrap();
        let linked_status = worktrees
            .iter()
            .find(|worktree| worktree.branch.as_deref() == Some("linked"))
            .expect("linked worktree must be reported");

        assert!(!linked_status.missing);
        assert!(
            !linked_status.dirty,
            "linked worktree inspection must preserve worktree-specific line endings"
        );
    }

    #[test]
    fn git_worktrees_handles_an_unborn_sha256_head() {
        let tree = TempTree::new("git-worktree-unborn-sha256");
        run_test_git(&tree.root, &["init", "-q", "--object-format=sha256"]);
        let policy = Arc::new(GitInspectionPolicy::new(path_text(&tree.root)).unwrap());
        let zero_oid = "0".repeat(64);

        let inspection =
            GitInspection::with_policy(path_text(&tree.root), policy, Some(&zero_oid)).unwrap();
        let attribute_source = inspection
            .repository
            .attribute_source
            .as_deref()
            .expect("unborn repositories must use an isolated empty attribute tree");

        assert!(
            attribute_source.chars().any(|character| character != '0'),
            "all-zero SHA-256 HEAD must not be used as an attribute source"
        );
        assert_eq!(attribute_source.len(), 64);
    }

    #[test]
    fn stale_worktree_head_override_cannot_change_dirty_semantics() {
        let tree = TempTree::new("git-stale-worktree-head-override");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            &global_config,
            format!(
                "[filter \"trusted-normalize\"]\n\tclean = {}\n\trequired = true\n",
                trusted_normalizing_clean_command()
            ),
        )
        .unwrap();
        run_test_git(&project, &["init", "-q"]);
        run_test_git(&project, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &project,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(project.join("tracked.txt"), "same content\n").unwrap();

        let env = [
            ("HOME", path_text(&home)),
            ("GIT_CONFIG_GLOBAL", path_text(&global_config)),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ];
        run_test_git_with_env(&project, &["add", "tracked.txt"], &env);
        run_test_git_with_env(&project, &["commit", "-qm", "baseline"], &env);
        let stale_head = run_test_git_stdout_with_env(&project, &["rev-parse", "HEAD"], &env)
            .trim()
            .to_string();

        std::fs::write(
            project.join(".gitattributes"),
            "tracked.txt filter=trusted-normalize\n",
        )
        .unwrap();
        std::fs::write(project.join("tracked.txt"), "same content   \n").unwrap();
        run_test_git_with_env(&project, &["add", ".gitattributes", "tracked.txt"], &env);
        run_test_git_with_env(&project, &["commit", "-qm", "attributes"], &env);
        let current_head = run_test_git_stdout_with_env(&project, &["rev-parse", "HEAD"], &env)
            .trim()
            .to_string();
        let raw_status =
            run_test_git_stdout_with_env(&project, &["status", "--porcelain", "--", "."], &env);
        assert!(
            raw_status.trim().is_empty(),
            "current attributes should keep the repository clean: {raw_status:?}"
        );

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);
        let policy = Arc::new(GitInspectionPolicy::new(path_text(&project)).unwrap());
        let inspection =
            GitInspection::with_policy(path_text(&project), policy, Some(&stale_head)).unwrap();
        let status = inspection
            .execute(&["status", "--porcelain=v1", "--untracked-files=normal"])
            .unwrap();

        assert_eq!(
            inspection.repository.attribute_source.as_deref(),
            Some(current_head.as_str()),
            "stale worktree-list HEAD metadata must not override the snapshotted attribute source"
        );
        assert!(
            status.trim().is_empty(),
            "stale worktree-list HEAD metadata must not change dirty semantics"
        );
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
        launch_options_with_env(
            Some("coven-code"),
            session_id,
            command,
            args,
            Some(&[(COVEN_SESSION_SOURCE, PSYCHE_SESSION_SOURCE)]),
        )
    }

    #[test]
    fn accepts_exact_native_coven_code_and_attach_launches() {
        let coven = "/canonical/bin/coven";
        let session_id = "12345678-1234-4abc-8def-1234567890ab";
        let code = native_code_options(
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

        assert_eq!(validate_coven_launch_with(&code, Some(coven)), Ok(()));
        assert_eq!(validate_coven_launch_with(&attach, Some(coven)), Ok(()));
    }

    #[test]
    fn rejects_legacy_native_coven_chat_launch_kind_after_workspace_migration() {
        let legacy = launch_options_with_env(
            Some("coven-chat"),
            Some("12345678-1234-4abc-8def-1234567890ab"),
            Some("/canonical/bin/coven"),
            Some(&[
                "code",
                "--session-id",
                "12345678-1234-4abc-8def-1234567890ab",
            ]),
            Some(&[(COVEN_SESSION_SOURCE, PSYCHE_SESSION_SOURCE)]),
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
            None,
            Some(&[][..]),
            Some(&[("COVEN_SESSION_SOURCE", "other")][..]),
            Some(&[("OTHER", "psyche-build")][..]),
            Some(&[("COVEN_SESSION_SOURCE", "psyche-build"), ("OTHER", "value")][..]),
        ];
        for env in code_envs {
            let code = launch_options_with_env(
                Some("coven-code"),
                None,
                Some(coven),
                Some(&["code"]),
                env,
            );
            assert_eq!(
                validate_coven_launch_with(&code, Some(coven)),
                Err("coven-code requires exactly COVEN_SESSION_SOURCE=psyche-build".to_string())
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

        let code_env = HashMap::from([(
            COVEN_SESSION_SOURCE.to_string(),
            PSYCHE_SESSION_SOURCE.to_string(),
        )]);
        let mut code = CommandBuilder::new("/bin/coven");
        code.env(COVEN_SESSION_SOURCE, "inherited");
        apply_launch_env(&mut code, Some(&code_env), Some("coven-code"));
        assert_eq!(
            code.get_env(COVEN_SESSION_SOURCE),
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
                native_code_options(Some(session_id), Some(coven), None),
                "coven-code requires exactly 'code --session-id' and the validated session id",
            ),
            (
                native_code_options(
                    None,
                    Some(coven),
                    Some(&["code", "--session-id", session_id]),
                ),
                "coven-code requires a session id",
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
                "coven-code requires exactly 'code --session-id' and the validated session id",
            ),
            (
                native_code_options(
                    Some("../unsafe"),
                    Some(coven),
                    Some(&["code", "--session-id", "../unsafe"]),
                ),
                "coven-code session id is unsafe",
            ),
            (
                native_code_options(
                    Some(session_id),
                    Some("/wrong/coven"),
                    Some(&["code", "--session-id", session_id]),
                ),
                "Coven launch command does not match the resolved executable",
            ),
            (
                native_code_options(Some(session_id), Some(coven), Some(&["code", session_id])),
                "coven-code requires exactly 'code --session-id' and the validated session id",
            ),
            (
                native_code_options(
                    Some(session_id),
                    Some(coven),
                    Some(&["code", "--session-id", session_id, "extra"]),
                ),
                "coven-code requires exactly 'code --session-id' and the validated session id",
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
        let code = native_code_options(
            Some(session_id),
            Some(coven),
            Some(&["code", "--session-id", session_id]),
        );
        assert_eq!(
            validate_coven_launch_with(&code, None),
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

    fn run_test_git_with_env(root: &Path, args: &[&str], env: &[(&str, &str)]) {
        let output = std::process::Command::new("git")
            .current_dir(root)
            .envs(env.iter().copied())
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

    fn run_test_git(root: &Path, args: &[&str]) {
        run_test_git_with_env(root, args, &[]);
    }

    fn run_test_git_stdout_with_env(root: &Path, args: &[&str], env: &[(&str, &str)]) -> String {
        let output = std::process::Command::new("git")
            .current_dir(root)
            .envs(env.iter().copied())
            .args(args)
            .output()
            .expect("git must run in tests");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).expect("git stdout must be UTF-8 in tests")
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

    #[test]
    fn git_file_paths_must_be_relative_and_cannot_traverse() {
        assert!(validate_git_relative_path("src/main.rs").is_ok());
        assert!(validate_git_relative_path("../secret.txt").is_err());
        assert!(validate_git_relative_path("src/../../secret.txt").is_err());
        assert!(validate_git_relative_path("/tmp/secret.txt").is_err());
    }

    #[test]
    fn git_status_does_not_execute_a_repository_fsmonitor() {
        let tree = TempTree::new("git-fsmonitor");
        let hook = tree.root.join("fsmonitor.sh");
        let marker = tree.root.join("fsmonitor-ran");
        write_marker_executable(&hook);
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(
            &tree.root,
            &["config", "core.fsmonitor", &marker_command(&hook, &marker)],
        );

        run_test_git(&tree.root, &["status", "--porcelain"]);
        assert!(
            marker.exists(),
            "unhardened git status must execute fsmonitor"
        );
        std::fs::remove_file(&marker).unwrap();

        git_status(path_text(&tree.root).to_string()).unwrap();

        assert!(!marker.exists());
    }

    #[test]
    fn git_status_reports_a_non_repository_without_error() {
        let tree = TempTree::new("git-status-non-repository");

        let status = git_status(path_text(&tree.root).to_string()).unwrap();

        assert!(!status.is_repo);
        assert!(status.files.is_empty());
    }

    #[test]
    fn git_status_preserves_branch_upstream_and_remote_metadata() {
        let tree = TempTree::new("git-status-metadata");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        let branch = run_test_git_stdout_with_env(&tree.root, &["branch", "--show-current"], &[])
            .trim()
            .to_string();
        run_test_git(
            &tree.root,
            &[
                "remote",
                "add",
                "origin",
                "https://example.invalid/repo.git",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "update-ref",
                &format!("refs/remotes/origin/{branch}"),
                "HEAD",
            ],
        );
        run_test_git(
            &tree.root,
            &["config", &format!("branch.{branch}.remote"), "origin"],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                &format!("branch.{branch}.merge"),
                &format!("refs/heads/{branch}"),
            ],
        );

        let status = git_status(path_text(&tree.root).to_string()).unwrap();
        let expected_upstream = format!("origin/{branch}");

        assert_eq!(status.branch.as_deref(), Some(branch.as_str()));
        assert_eq!(status.upstream.as_deref(), Some(expected_upstream.as_str()));
        assert_eq!(
            status.remote_url.as_deref(),
            Some("https://example.invalid/repo.git")
        );
    }

    #[test]
    fn git_inspection_preserves_ordered_remote_urls_and_fetch_refspecs() {
        let tree = TempTree::new("git-remote-multivalue");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://first.invalid/repo.git",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://second.invalid/repo.git",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.fetch",
                "+refs/heads/main:refs/remotes/origin/main",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.fetch",
                "+refs/heads/release:refs/remotes/origin/release",
            ],
        );

        let config = git_inspection_repository_config(path_text(&tree.root)).unwrap();
        let urls = config
            .iter()
            .filter(|(key, _)| key == "remote.origin.url")
            .map(|(_, value)| value.as_str())
            .collect::<Vec<_>>();
        let fetch = config
            .iter()
            .filter(|(key, _)| key == "remote.origin.fetch")
            .map(|(_, value)| value.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            urls,
            vec![
                "https://first.invalid/repo.git",
                "https://second.invalid/repo.git",
            ]
        );
        assert_eq!(
            fetch,
            vec![
                "+refs/heads/main:refs/remotes/origin/main",
                "+refs/heads/release:refs/remotes/origin/release",
            ]
        );

        let status = git_status(path_text(&tree.root).to_string()).unwrap();
        assert_eq!(
            status.remote_url.as_deref(),
            Some("https://first.invalid/repo.git")
        );
    }

    #[test]
    fn git_status_uses_first_origin_url_after_empty_reset() {
        let tree = TempTree::new("git-remote-url-after-reset");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://first.invalid/repo.git",
            ],
        );
        run_test_git(&tree.root, &["config", "--add", "remote.origin.url", ""]);
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://later.invalid/repo.git",
            ],
        );

        let status = git_status(path_text(&tree.root).to_string()).unwrap();

        assert_eq!(
            status.remote_url.as_deref(),
            Some("https://later.invalid/repo.git")
        );
    }

    #[test]
    fn git_status_omits_origin_url_after_trailing_empty_reset() {
        let tree = TempTree::new("git-remote-url-trailing-reset");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://first.invalid/repo.git",
            ],
        );
        run_test_git(&tree.root, &["config", "--add", "remote.origin.url", ""]);

        let status = git_status(path_text(&tree.root).to_string()).unwrap();

        assert_eq!(status.remote_url, None);
        assert_eq!(status.web_url, None);
    }

    #[test]
    fn git_inspection_preserves_remote_subsection_case() {
        let tree = TempTree::new("git-remote-subsection-case");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.Origin.url",
                "https://uppercase.invalid/repo.git",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://lowercase-first.invalid/repo.git",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://lowercase-second.invalid/repo.git",
            ],
        );

        let config = git_inspection_repository_config(path_text(&tree.root)).unwrap();
        let urls = config
            .iter()
            .filter(|(key, _)| key.ends_with(".url"))
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect::<Vec<_>>();

        assert_eq!(
            urls,
            vec![
                ("remote.Origin.url", "https://uppercase.invalid/repo.git",),
                (
                    "remote.origin.url",
                    "https://lowercase-first.invalid/repo.git",
                ),
                (
                    "remote.origin.url",
                    "https://lowercase-second.invalid/repo.git",
                ),
            ]
        );

        let status = git_status(path_text(&tree.root).to_string()).unwrap();
        assert_eq!(
            status.remote_url.as_deref(),
            Some("https://lowercase-first.invalid/repo.git")
        );
    }

    #[test]
    fn git_inspection_preserves_a_loose_remote_head_symbolic_ref() {
        let tree = TempTree::new("git-symbolic-remote-head");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        run_test_git(&tree.root, &["branch", "-M", "main"]);
        run_test_git(
            &tree.root,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        run_test_git(
            &tree.root,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );

        let inspection = GitInspection::new(path_text(&tree.root)).unwrap();

        assert_eq!(
            inspection
                .execute(&["symbolic-ref", "refs/remotes/origin/HEAD"])
                .unwrap()
                .trim(),
            "refs/remotes/origin/main"
        );
        assert_eq!(
            inspection
                .execute(&["rev-parse", "refs/remotes/origin/HEAD"])
                .unwrap()
                .trim(),
            run_test_git_stdout_with_env(&tree.root, &["rev-parse", "HEAD"], &[]).trim()
        );
        assert!(git_status(path_text(&tree.root).to_string()).is_ok());
    }

    #[test]
    fn git_status_resolves_origin_url_through_trusted_global_instead_of_rules() {
        let tree = TempTree::new("git-status-remote-url-rewrite");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            &global_config,
            "[url \"git@github.com:\"]\n\tinsteadOf = gh:\n",
        )
        .unwrap();

        run_test_git(&project, &["init", "-q"]);
        run_test_git(&project, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &project,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(project.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&project, &["add", "tracked.txt"]);
        run_test_git(&project, &["commit", "-qm", "baseline"]);
        run_test_git(&project, &["remote", "add", "origin", "gh:owner/repo.git"]);

        let env = [
            ("HOME", path_text(&home)),
            ("GIT_CONFIG_GLOBAL", path_text(&global_config)),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ];
        let raw_remote =
            run_test_git_stdout_with_env(&project, &["remote", "get-url", "origin"], &env);
        assert_eq!(raw_remote.trim(), "git@github.com:owner/repo.git");

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);

        let status = git_status(path_text(&project).to_string()).unwrap();

        assert_eq!(
            status.remote_url.as_deref(),
            Some("git@github.com:owner/repo.git")
        );
        assert_eq!(
            status.web_url.as_deref(),
            Some("https://github.com/owner/repo")
        );
    }

    #[test]
    fn git_ref_snapshot_ignores_populated_lockfiles() {
        let tree = TempTree::new("git-ref-lockfile");
        let common_dir = tree.root.join("common");
        let heads = common_dir.join("refs/heads");
        std::fs::create_dir_all(&heads).unwrap();
        std::fs::write(
            heads.join("main"),
            "1111111111111111111111111111111111111111\n",
        )
        .unwrap();
        std::fs::write(
            heads.join("main.lock"),
            "2222222222222222222222222222222222222222\n",
        )
        .unwrap();

        let refs = snapshot_git_refs(&common_dir, None).unwrap();

        assert!(matches!(
            refs.get("refs/heads/main"),
            Some(GitRefValue::Direct(oid))
                if oid == "1111111111111111111111111111111111111111"
        ));
        assert!(!refs.contains_key("refs/heads/main.lock"));
    }

    #[test]
    fn git_ref_snapshot_ignores_invalid_files_and_keeps_valid_symbolic_refs() {
        let tree = TempTree::new("git-invalid-ref-file");
        let common_dir = tree.root.join("common");
        let remote_refs = common_dir.join("refs/remotes/origin");
        std::fs::create_dir_all(&remote_refs).unwrap();
        std::fs::write(
            remote_refs.join("main"),
            "1111111111111111111111111111111111111111\n",
        )
        .unwrap();
        std::fs::write(remote_refs.join("HEAD"), "ref: refs/remotes/origin/main\n").unwrap();
        std::fs::write(
            remote_refs.join("bad..name"),
            "2222222222222222222222222222222222222222\n",
        )
        .unwrap();

        let refs = snapshot_git_refs(&common_dir, None).unwrap();

        assert!(matches!(
            refs.get("refs/remotes/origin/HEAD"),
            Some(GitRefValue::Symbolic(target)) if target == "refs/remotes/origin/main"
        ));
        assert!(!refs.contains_key("refs/remotes/origin/bad..name"));
    }

    #[test]
    fn git_ref_snapshot_skips_malformed_sha256_loose_refs() {
        let tree = TempTree::new("git-invalid-sha256-ref-file");
        let common_dir = tree.root.join("common");
        let tag_refs = common_dir.join("refs/tags");
        std::fs::create_dir_all(&tag_refs).unwrap();
        std::fs::write(
            tag_refs.join("good"),
            "1111111111111111111111111111111111111111111111111111111111111111\n",
        )
        .unwrap();
        std::fs::write(tag_refs.join("bad"), "22222222222222222222\n").unwrap();

        let refs = snapshot_git_refs(&common_dir, Some("sha256")).unwrap();

        assert!(matches!(
            refs.get("refs/tags/good"),
            Some(GitRefValue::Direct(oid))
                if oid == "1111111111111111111111111111111111111111111111111111111111111111"
        ));
        assert!(!refs.contains_key("refs/tags/bad"));
    }

    #[test]
    fn git_status_and_diff_ignore_unrelated_malformed_loose_refs() {
        let tree = TempTree::new("git-malformed-loose-ref");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::create_dir_all(tree.root.join(".git/refs/tags")).unwrap();
        std::fs::write(tree.root.join(".git/refs/tags/bad"), "not-an-oid\n").unwrap();
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let raw_status =
            run_test_git_stdout_with_env(&tree.root, &["status", "--porcelain", "--", "."], &[]);
        assert!(
            raw_status.contains(" M tracked.txt"),
            "raw git status should ignore unrelated malformed loose refs: {raw_status:?}"
        );
        let raw_diff = run_test_git_stdout_with_env(
            &tree.root,
            &["diff", "--no-color", "--relative", "--", "tracked.txt"],
            &[],
        );
        assert!(
            raw_diff.contains("+after"),
            "raw git diff should ignore unrelated malformed loose refs: {raw_diff:?}"
        );

        let status = git_status(path_text(&tree.root).to_string()).unwrap();
        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert_eq!(
            status.files.len(),
            1,
            "unexpected malformed-ref status files: {:?}",
            status.files
        );
        assert_eq!(status.files[0].path, "tracked.txt");
        assert!(status.files[0].unstaged);
        assert!(diff.text.contains("+after"));
    }

    #[test]
    fn parent_inspection_does_not_execute_populated_submodule_helpers() {
        let tree = TempTree::new("git-submodule-inspection");
        let parent = tree.root.join("parent");
        let source = tree.root.join("submodule-source");
        let submodule = parent.join("vendor/submodule");
        let filter_helper = tree.root.join("submodule-filter.sh");
        let filter_marker = tree.root.join("submodule-filter-ran");
        let fsmonitor_helper = tree.root.join("submodule-fsmonitor.sh");
        let fsmonitor_marker = tree.root.join("submodule-fsmonitor-ran");
        std::fs::create_dir_all(&parent).unwrap();
        std::fs::create_dir_all(&source).unwrap();
        write_marker_executable(&filter_helper);
        write_marker_executable(&fsmonitor_helper);

        run_test_git(&source, &["init", "-q"]);
        run_test_git(&source, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &source,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&source, &["config", "core.autocrlf", "false"]);
        std::fs::write(source.join("tracked.txt"), "baseline\n").unwrap();
        std::fs::write(
            source.join(".gitattributes"),
            "tracked.txt filter=malicious-submodule\n",
        )
        .unwrap();
        run_test_git(&source, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(&source, &["commit", "-qm", "baseline"]);

        run_test_git(&parent, &["init", "-q"]);
        run_test_git(&parent, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &parent,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&parent, &["config", "core.autocrlf", "false"]);
        run_test_git(
            &parent,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                path_text(&source),
                "vendor/submodule",
            ],
        );
        run_test_git(&submodule, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &submodule,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&submodule, &["config", "core.autocrlf", "false"]);
        run_test_git(&parent, &["commit", "-qam", "add submodule"]);
        run_test_git(
            &submodule,
            &[
                "config",
                "filter.malicious-submodule.clean",
                &format!("{}; cat", marker_command(&filter_helper, &filter_marker)),
            ],
        );
        run_test_git(
            &submodule,
            &["config", "filter.malicious-submodule.required", "true"],
        );
        run_test_git(
            &submodule,
            &[
                "config",
                "core.fsmonitor",
                &marker_command(&fsmonitor_helper, &fsmonitor_marker),
            ],
        );
        std::fs::write(submodule.join("tracked.txt"), "dirty\n").unwrap();

        run_test_git(&parent, &["status", "--porcelain"]);
        assert!(fsmonitor_marker.exists());
        std::fs::remove_file(&fsmonitor_marker).unwrap();
        run_test_git(&submodule, &["config", "--unset", "core.fsmonitor"]);
        run_test_git(&submodule, &["diff", "--no-color"]);
        assert!(filter_marker.exists());
        std::fs::remove_file(&filter_marker).unwrap();
        run_test_git(
            &submodule,
            &[
                "config",
                "core.fsmonitor",
                &marker_command(&fsmonitor_helper, &fsmonitor_marker),
            ],
        );

        let status = git_status(path_text(&parent).to_string()).unwrap();
        assert!(
            status.files.is_empty(),
            "unexpected parent status files: {:?}",
            status.files
        );
        assert!(!filter_marker.exists());
        assert!(!fsmonitor_marker.exists());

        let diff = git_diff(path_text(&parent).to_string(), None, Some(false), None).unwrap();
        assert!(diff.text.is_empty());
        assert!(!filter_marker.exists());
        assert!(!fsmonitor_marker.exists());

        let worktrees = git_worktrees(path_text(&parent).to_string()).unwrap();
        assert_eq!(worktrees.len(), 1);
        assert!(!worktrees[0].dirty);
        assert!(!filter_marker.exists());
        assert!(!fsmonitor_marker.exists());

        run_test_git(&submodule, &["add", "tracked.txt"]);
        run_test_git(&submodule, &["commit", "-qm", "advance submodule"]);
        if filter_marker.exists() {
            std::fs::remove_file(&filter_marker).unwrap();
        }
        if fsmonitor_marker.exists() {
            std::fs::remove_file(&fsmonitor_marker).unwrap();
        }

        let status = git_status(path_text(&parent).to_string()).unwrap();
        assert_eq!(
            status.files.len(),
            1,
            "unexpected reftable status files: {:?}",
            status.files
        );
        assert_eq!(status.files[0].path, "vendor/submodule");
        assert!(status.files[0].unstaged);
        assert!(!filter_marker.exists());
        assert!(!fsmonitor_marker.exists());

        let diff = git_diff(path_text(&parent).to_string(), None, Some(false), None).unwrap();
        assert!(diff.text.contains("Subproject commit"));
        assert!(!filter_marker.exists());
        assert!(!fsmonitor_marker.exists());

        let worktrees = git_worktrees(path_text(&parent).to_string()).unwrap();
        assert!(worktrees[0].dirty);
        assert!(!filter_marker.exists());
        assert!(!fsmonitor_marker.exists());

        run_test_git(&parent, &["add", "vendor/submodule"]);

        let status = git_status(path_text(&parent).to_string()).unwrap();
        assert_eq!(status.files.len(), 1);
        assert!(status.files[0].staged);
        assert!(!status.files[0].unstaged);
        assert!(!filter_marker.exists());
        assert!(!fsmonitor_marker.exists());

        let diff = git_diff(path_text(&parent).to_string(), None, Some(true), None).unwrap();
        assert!(diff.text.contains("Subproject commit"));
        assert!(!filter_marker.exists());
        assert!(!fsmonitor_marker.exists());

        let worktrees = git_worktrees(path_text(&parent).to_string()).unwrap();
        assert!(worktrees[0].dirty);
        assert!(!filter_marker.exists());
        assert!(!fsmonitor_marker.exists());
    }

    #[test]
    fn git_inspection_preserves_sha256_repository_format() {
        let tree = TempTree::new("git-sha256-inspection");
        run_test_git(&tree.root, &["init", "-q", "--object-format=sha256"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
    }

    #[test]
    fn git_inspection_supports_object_paths_with_path_list_separators() {
        let tree = TempTree::new("git-alternate-separator");
        let separator = if cfg!(windows) { ';' } else { ':' };
        let repository = tree.root.join(format!("repository{separator}objects"));
        std::fs::create_dir_all(&repository).unwrap();
        run_test_git(&repository, &["init", "-q"]);
        run_test_git(&repository, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &repository,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(repository.join("tracked.txt"), "before\n").unwrap();
        run_test_git(&repository, &["add", "tracked.txt"]);
        run_test_git(&repository, &["commit", "-qm", "baseline"]);
        std::fs::write(repository.join("tracked.txt"), "after\n").unwrap();

        let diff = git_diff(
            path_text(&repository).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
    }

    #[test]
    fn isolated_git_log_preserves_linked_worktree_shallow_boundary() {
        let tree = TempTree::new("git-shallow-linked-worktree");
        let source = tree.root.join("source");
        let shallow = tree.root.join("shallow");
        let linked = tree.root.join("linked");
        std::fs::create_dir_all(&source).unwrap();
        run_test_git(&source, &["init", "-q"]);
        run_test_git(&source, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &source,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        for subject in ["first", "second", "third"] {
            std::fs::write(source.join("tracked.txt"), format!("{subject}\n")).unwrap();
            run_test_git(&source, &["add", "tracked.txt"]);
            run_test_git(&source, &["commit", "-qm", subject]);
        }
        run_test_git(
            &tree.root,
            &[
                "clone",
                "-q",
                "--depth=2",
                &format!("file://{}", path_text(&source)),
                path_text(&shallow),
            ],
        );
        run_test_git(
            &shallow,
            &[
                "worktree",
                "add",
                "-q",
                "--detach",
                path_text(&linked),
                "HEAD",
            ],
        );

        let (_, linked_git_dir) = git_dir_for_worktree(&linked).unwrap();
        let common_dir = git_common_dir(&linked_git_dir).unwrap();
        assert!(common_dir.join("shallow").is_file());
        assert!(!linked_git_dir.join("shallow").exists());

        let inspection = GitInspection::new(path_text(&linked)).unwrap();
        std::fs::remove_file(common_dir.join("shallow")).unwrap();
        let log = inspection
            .execute(&["--no-pager", "log", "--pretty=format:%s"])
            .unwrap();

        assert_eq!(log.lines().collect::<Vec<_>>(), ["third", "second"]);
    }

    #[test]
    fn git_inspection_rejects_malformed_shallow_boundaries() {
        let tree = TempTree::new("git-invalid-shallow");
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::write(tree.root.join(".git/shallow"), "../not-an-object\n").unwrap();

        let error = match GitInspection::new(path_text(&tree.root)) {
            Ok(_) => panic!("malformed shallow metadata must be rejected"),
            Err(error) => error,
        };

        assert!(error.contains("invalid Git shallow boundary"));
    }

    fn tiny_git_reftable_snapshot_limits() -> GitReftableSnapshotLimits {
        GitReftableSnapshotLimits {
            list_bytes: 32,
            tables: 2,
            table_bytes: 8,
            total_bytes: 12,
        }
    }

    const TEST_REFTABLE_TABLE_ONE: &str = "table-alpha.ref";
    const TEST_REFTABLE_TABLE_TWO: &str = "table-beta.log";
    const TEST_REFTABLE_TABLE_THREE: &str = "table-gamma.ref";
    const REPRESENTATIVE_GIT_REFTABLE_TABLE: &str = "0x000000000001-0x000000000002-3b8de075.ref";
    const SPEC_GIT_REFTABLE_LOG: &str = "00000001-00000001-RANDOM1.log";
    const SAFE_ARBITRARY_GIT_REFTABLE_TABLE: &str = "réftable-随机-7Kp9.ref";
    const SAFE_DECOMPOSED_GIT_REFTABLE_TABLE: &str = "re\u{301}ftable.ref";

    fn write_test_reftable_table_list(source: &Path, names: &[&str]) {
        let mut list = names.join("\n");
        list.push('\n');
        std::fs::write(source.join("tables.list"), list).unwrap();
    }

    fn invalid_git_reftable_table_names() -> Vec<String> {
        let mut names = [
            "NUL.ref",
            "COM1.ref",
            "COM1.any.ref",
            "cOm\u{00b9}.ref",
            "COM\u{00b2}.any.ref",
            "com\u{00b3}.log",
            "nul.any.log",
            "CLOCK$.ref",
            "CONIN$.log",
            "CONOUT$.any.ref",
            "LPT9.log",
            "LpT\u{00b9}.log",
            "LPT\u{00b2}.any.log",
            "lpt\u{00b3}.ref",
            "NUL .ref",
            "safe.ref.",
            "safe.ref ",
            "missing-extension",
            "uppercase.REF",
            "uppercase.LOG",
            "other.txt",
            ".ref",
            ".log",
            "nested/name.ref",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
        for forbidden in ['<', '>', ':', '"', '/', '\\', '|', '?', '*'] {
            names.push(format!("bad{forbidden}name.ref"));
        }
        for control in ['\0', '\u{0001}', '\u{001f}', '\u{007f}'] {
            names.push(format!("bad{control}name.log"));
        }
        names
    }

    #[test]
    fn git_reftable_table_name_validation_accepts_safe_git_names() {
        for name in [
            REPRESENTATIVE_GIT_REFTABLE_TABLE,
            SPEC_GIT_REFTABLE_LOG,
            SAFE_ARBITRARY_GIT_REFTABLE_TABLE,
            SAFE_DECOMPOSED_GIT_REFTABLE_TABLE,
        ] {
            assert!(
                is_valid_git_reftable_table_name(name),
                "unexpectedly rejected {name}"
            );
        }
    }

    #[test]
    fn git_reftable_table_name_validation_rejects_unsafe_names() {
        for name in invalid_git_reftable_table_names() {
            assert!(
                !is_valid_git_reftable_table_name(&name),
                "unexpectedly accepted {name}"
            );
        }
    }

    #[test]
    fn git_reftable_snapshot_rejects_invalid_table_names_without_publication() {
        for name in invalid_git_reftable_table_names() {
            let tree = TempTree::new("git-reftable-invalid-table-name");
            let source = tree.root.join("source");
            let destination = tree.root.join("destination");
            std::fs::create_dir_all(&source).unwrap();
            write_test_reftable_table_list(&source, &[&name]);

            let error = snapshot_git_reftable_with_limits(
                &source,
                &destination,
                tiny_git_reftable_snapshot_limits(),
            )
            .unwrap_err();

            assert!(
                error.contains("invalid table name") || error.contains("invalid path"),
                "{name}: {error}"
            );
            assert!(!destination.exists(), "{name} must not be published");
        }
    }

    #[test]
    fn git_reftable_windows_child_share_mode_allows_read_and_delete_but_not_write() {
        let share_mode = windows_git_metadata_child_share_mode();

        assert_ne!(share_mode & 0x0001, 0, "read sharing must remain enabled");
        assert_eq!(share_mode & 0x0002, 0, "write sharing must be disabled");
        assert_ne!(share_mode & 0x0004, 0, "delete sharing must remain enabled");
    }

    #[test]
    fn git_reftable_windows_sharing_violation_reports_change() {
        assert_eq!(
            windows_git_metadata_open_error("Git reftable table list", 32),
            "Git reftable table list changed while being read"
        );
    }

    #[test]
    fn git_metadata_windows_directory_state_ignores_mutable_size_and_time() {
        let before = WindowsGitMetadataState {
            volume_serial_number: 7,
            file_index: 11,
            file_attributes: FILE_ATTRIBUTE_DIRECTORY,
            file_size: 23,
            last_write_time: 29,
        };
        let after = WindowsGitMetadataState {
            file_size: 31,
            last_write_time: 37,
            ..before
        };

        assert!(windows_git_metadata_directory_state_matches(before, after));
    }

    #[test]
    fn git_metadata_windows_directory_state_rejects_identity_reparse_and_type_changes() {
        let directory = WindowsGitMetadataState {
            volume_serial_number: 7,
            file_index: 11,
            file_attributes: FILE_ATTRIBUTE_DIRECTORY,
            file_size: 23,
            last_write_time: 29,
        };

        assert!(!windows_git_metadata_directory_state_matches(
            directory,
            WindowsGitMetadataState {
                volume_serial_number: 13,
                ..directory
            }
        ));
        assert!(!windows_git_metadata_directory_state_matches(
            directory,
            WindowsGitMetadataState {
                file_index: 17,
                ..directory
            }
        ));
        assert!(!windows_git_metadata_directory_state_matches(
            directory,
            WindowsGitMetadataState {
                file_attributes: FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT,
                ..directory
            }
        ));
        assert!(!windows_git_metadata_directory_state_matches(
            directory,
            WindowsGitMetadataState {
                file_attributes: 0,
                ..directory
            }
        ));
    }

    #[test]
    fn git_metadata_windows_file_state_compares_size_and_time() {
        let file = WindowsGitMetadataState {
            volume_serial_number: 7,
            file_index: 11,
            file_attributes: 0,
            file_size: 23,
            last_write_time: 29,
        };

        assert!(windows_git_metadata_file_state_matches(file, file));
        assert!(!windows_git_metadata_file_state_matches(
            file,
            WindowsGitMetadataState {
                file_size: 31,
                ..file
            }
        ));
        assert!(!windows_git_metadata_file_state_matches(
            file,
            WindowsGitMetadataState {
                last_write_time: 37,
                ..file
            }
        ));
    }

    #[cfg(unix)]
    struct ReftableSourceSwapGuard {
        source: PathBuf,
        parked: PathBuf,
        replacement: PathBuf,
    }

    #[cfg(unix)]
    impl Drop for ReftableSourceSwapGuard {
        fn drop(&mut self) {
            std::fs::rename(&self.source, &self.replacement).unwrap();
            std::fs::rename(&self.parked, &self.source).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn git_reftable_snapshot_anchors_children_to_open_directory() {
        let tree = TempTree::new("git-reftable-anchored-directory");
        let source = tree.root.join("source");
        let parked = tree.root.join("parked");
        let replacement = tree.root.join("replacement");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&replacement).unwrap();
        write_test_reftable_table_list(&source, &[TEST_REFTABLE_TABLE_ONE]);
        std::fs::write(source.join(TEST_REFTABLE_TABLE_ONE), b"orig").unwrap();
        write_test_reftable_table_list(&replacement, &[TEST_REFTABLE_TABLE_ONE]);
        std::fs::write(replacement.join(TEST_REFTABLE_TABLE_ONE), b"evil").unwrap();

        snapshot_git_reftable_with_limits_and_hook(
            &source,
            &destination,
            tiny_git_reftable_snapshot_limits(),
            || {
                std::fs::rename(&source, &parked).unwrap();
                std::fs::rename(&replacement, &source).unwrap();
                ReftableSourceSwapGuard {
                    source: source.clone(),
                    parked: parked.clone(),
                    replacement: replacement.clone(),
                }
            },
        )
        .unwrap();

        assert_eq!(
            std::fs::read(destination.join(TEST_REFTABLE_TABLE_ONE)).unwrap(),
            b"orig"
        );
    }

    #[cfg(unix)]
    #[test]
    fn git_reftable_snapshot_rejects_fifo_table_promptly() {
        use std::os::unix::fs::OpenOptionsExt;

        let tree = TempTree::new("git-reftable-fifo-table");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        let fifo = source.join(TEST_REFTABLE_TABLE_ONE);
        std::fs::create_dir_all(&source).unwrap();
        write_test_reftable_table_list(&source, &[TEST_REFTABLE_TABLE_ONE]);
        let fifo_path = c_path(&fifo).unwrap();
        let created = unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) };
        assert_eq!(
            created,
            0,
            "create test FIFO: {}",
            std::io::Error::last_os_error()
        );

        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            let result = snapshot_git_reftable_with_limits(
                &source,
                &destination,
                tiny_git_reftable_snapshot_limits(),
            );
            sender.send(result).unwrap();
        });

        let result = match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(result) => result,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let unblock = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .custom_flags(libc::O_NONBLOCK)
                    .open(&fifo)
                    .unwrap();
                let _ = receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("FIFO reader must unblock for test cleanup");
                drop(unblock);
                worker.join().unwrap();
                panic!("Git reftable FIFO open blocked instead of failing promptly");
            }
            Err(error) => panic!("Git reftable FIFO worker disconnected: {error}"),
        };
        worker.join().unwrap();

        let error = result.unwrap_err();
        assert!(error.contains("not a regular file"));
    }

    #[test]
    fn git_reftable_snapshot_copies_valid_bounded_files() {
        let tree = TempTree::new("git-reftable-valid-snapshot");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        write_test_reftable_table_list(&source, &[TEST_REFTABLE_TABLE_ONE]);
        std::fs::write(source.join(TEST_REFTABLE_TABLE_ONE), b"table").unwrap();

        snapshot_git_reftable_with_limits(
            &source,
            &destination,
            tiny_git_reftable_snapshot_limits(),
        )
        .unwrap();

        assert_eq!(
            std::fs::read(destination.join(TEST_REFTABLE_TABLE_ONE)).unwrap(),
            b"table"
        );
        assert_eq!(
            std::fs::read(destination.join("tables.list")).unwrap(),
            format!("{TEST_REFTABLE_TABLE_ONE}\n").as_bytes()
        );
    }

    #[test]
    fn git_reftable_snapshot_rejects_oversized_table_list() {
        let tree = TempTree::new("git-reftable-large-list");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("tables.list"), vec![b'x'; 33]).unwrap();

        let error = snapshot_git_reftable_with_limits(
            &source,
            &destination,
            tiny_git_reftable_snapshot_limits(),
        )
        .unwrap_err();

        assert!(error.contains("table list is too large"));
        assert!(!destination.exists());
    }

    #[test]
    fn git_reftable_snapshot_rejects_excessive_table_count() {
        let tree = TempTree::new("git-reftable-table-count");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        write_test_reftable_table_list(
            &source,
            &[
                TEST_REFTABLE_TABLE_ONE,
                TEST_REFTABLE_TABLE_TWO,
                TEST_REFTABLE_TABLE_THREE,
            ],
        );
        let limits = GitReftableSnapshotLimits {
            list_bytes: 64,
            ..tiny_git_reftable_snapshot_limits()
        };

        let error = snapshot_git_reftable_with_limits(&source, &destination, limits).unwrap_err();

        assert!(error.contains("too many tables"));
        assert!(!destination.exists());
    }

    #[test]
    fn git_reftable_snapshot_rejects_oversized_table() {
        let tree = TempTree::new("git-reftable-large-table");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        write_test_reftable_table_list(&source, &[TEST_REFTABLE_TABLE_ONE]);
        std::fs::write(source.join(TEST_REFTABLE_TABLE_ONE), b"123456789").unwrap();

        let error = snapshot_git_reftable_with_limits(
            &source,
            &destination,
            tiny_git_reftable_snapshot_limits(),
        )
        .unwrap_err();

        assert!(error.contains(&format!("table {TEST_REFTABLE_TABLE_ONE} is too large")));
        assert!(!destination.exists());
    }

    #[test]
    fn git_reftable_snapshot_rejects_aggregate_overflow() {
        let tree = TempTree::new("git-reftable-aggregate-size");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        write_test_reftable_table_list(
            &source,
            &[TEST_REFTABLE_TABLE_ONE, TEST_REFTABLE_TABLE_TWO],
        );
        std::fs::write(source.join(TEST_REFTABLE_TABLE_ONE), b"12345678").unwrap();
        std::fs::write(source.join(TEST_REFTABLE_TABLE_TWO), b"12345678").unwrap();

        let error = snapshot_git_reftable_with_limits(
            &source,
            &destination,
            tiny_git_reftable_snapshot_limits(),
        )
        .unwrap_err();

        assert!(error.contains("aggregate size"));
        assert!(!destination.exists());
    }

    #[test]
    fn git_reftable_snapshot_caps_reads_to_remaining_aggregate_budget() {
        let tree = TempTree::new("git-reftable-remaining-budget");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        write_test_reftable_table_list(
            &source,
            &[TEST_REFTABLE_TABLE_ONE, TEST_REFTABLE_TABLE_TWO],
        );
        std::fs::write(source.join(TEST_REFTABLE_TABLE_ONE), b"12345678").unwrap();
        std::fs::write(source.join(TEST_REFTABLE_TABLE_TWO), b"12345").unwrap();
        TEST_GIT_METADATA_READ_LIMITS.with(|limits| limits.borrow_mut().clear());

        let error = snapshot_git_reftable_with_limits(
            &source,
            &destination,
            tiny_git_reftable_snapshot_limits(),
        )
        .unwrap_err();

        let read_limits =
            TEST_GIT_METADATA_READ_LIMITS.with(|limits| std::mem::take(&mut *limits.borrow_mut()));
        assert_eq!(read_limits, vec![32, 8, 4]);
        assert_eq!(error, "Git reftable aggregate size is too large");
        assert!(!destination.exists());
    }

    #[test]
    fn git_reftable_snapshot_rejects_linked_tables_when_supported() {
        let tree = TempTree::new("git-reftable-linked-table");
        let source = tree.root.join("source");
        let destination = tree.root.join("destination");
        let linked = tree.root.join("linked.ref");
        std::fs::create_dir_all(&source).unwrap();
        write_test_reftable_table_list(&source, &[TEST_REFTABLE_TABLE_ONE]);
        std::fs::write(&linked, b"linked").unwrap();
        if !create_test_symlink(
            TestSymlinkKind::File,
            &linked,
            &source.join(TEST_REFTABLE_TABLE_ONE),
        ) {
            return;
        }

        let error = snapshot_git_reftable_with_limits(
            &source,
            &destination,
            tiny_git_reftable_snapshot_limits(),
        )
        .unwrap_err();

        assert!(error.contains("not a regular file"));
        assert!(!destination.exists());
    }

    #[test]
    fn git_inspection_preserves_reftable_refs_when_supported() {
        let tree = TempTree::new("git-reftable-inspection");
        let init = std::process::Command::new("git")
            .current_dir(&tree.root)
            .args(["init", "-q", "-b", "main", "--ref-format=reftable"])
            .output()
            .expect("git init must run in tests");
        if !init.status.success() {
            assert!(
                !String::from_utf8_lossy(&init.stderr).trim().is_empty(),
                "Git without reftable support must reject the requested ref format clearly"
            );
            return;
        }
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&tree.root, &["config", "core.autocrlf", "false"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let status = git_status(path_text(&tree.root).to_string()).unwrap();
        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();
        let log = git_log(path_text(&tree.root).to_string(), Some(1)).unwrap();

        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "tracked.txt");
        assert!(diff.text.contains("+after"));
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "baseline");
    }

    #[test]
    fn git_log_succeeds_for_a_bare_repository() {
        let tree = TempTree::new("git-log-bare");
        let source = tree.root.join("source");
        let bare = tree.root.join("bare.git");
        std::fs::create_dir_all(&source).unwrap();
        run_test_git(&source, &["init", "-q"]);
        run_test_git(&source, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &source,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(source.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&source, &["add", "tracked.txt"]);
        run_test_git(&source, &["commit", "-qm", "baseline"]);
        run_test_git(
            &tree.root,
            &["clone", "--bare", path_text(&source), path_text(&bare)],
        );

        let log = git_log(path_text(&bare).to_string(), Some(1)).unwrap();

        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "baseline");
    }

    #[test]
    fn git_status_and_diff_preserve_trusted_global_attributes_in_reftable_repositories() {
        let tree = TempTree::new("git-reftable-global-clean-filter");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        let helper = tree.root.join("shadow-reftable-clean-filter.sh");
        let marker = tree.root.join("shadow-reftable-clean-filter-ran");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        write_marker_executable(&helper);
        std::fs::write(
            &global_config,
            format!(
                "[filter \"trusted-normalize\"]\n\tclean = {}\n\trequired = true\n",
                trusted_normalizing_clean_command()
            ),
        )
        .unwrap();

        let init = std::process::Command::new("git")
            .current_dir(&project)
            .args(["init", "-q", "-b", "main", "--ref-format=reftable"])
            .output()
            .expect("git init must run in tests");
        if !init.status.success() {
            let stderr = String::from_utf8_lossy(&init.stderr);
            assert!(
                stderr.contains("reftable")
                    || stderr.contains("ref-format")
                    || stderr.contains("unknown option"),
                "Git without reftable support must fail the exact reftable capability probe clearly: {}",
                stderr.trim()
            );
            eprintln!("skipping reftable-only regression: {}", stderr.trim());
            return;
        }
        run_test_git(&project, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &project,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&project, &["config", "core.autocrlf", "false"]);
        std::fs::write(
            project.join(".gitattributes"),
            "tracked.txt filter=trusted-normalize\n",
        )
        .unwrap();
        std::fs::write(project.join("tracked.txt"), "same content   \n").unwrap();

        let env = [
            ("HOME", path_text(&home)),
            ("GIT_CONFIG_GLOBAL", path_text(&global_config)),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ];
        run_test_git_with_env(&project, &["add", "tracked.txt", ".gitattributes"], &env);
        run_test_git_with_env(&project, &["commit", "-qm", "baseline"], &env);

        run_test_git(
            &project,
            &[
                "config",
                "filter.trusted-normalize.clean",
                &format!("{}; cat", marker_command(&helper, &marker)),
            ],
        );
        run_test_git(
            &project,
            &["config", "filter.trusted-normalize.required", "true"],
        );
        std::fs::write(project.join("tracked.txt"), "same content\t\t\t\n").unwrap();

        let raw_status =
            run_test_git_stdout_with_env(&project, &["status", "--porcelain", "--", "."], &env);
        assert!(
            !raw_status.trim().is_empty(),
            "shadowing local clean filter should dirty raw git status in reftable repos: {raw_status:?}"
        );
        if marker.exists() {
            std::fs::remove_file(&marker).unwrap();
        }

        let raw_diff = run_test_git_stdout_with_env(
            &project,
            &["diff", "--no-color", "--relative", "--", "tracked.txt"],
            &env,
        );
        assert!(
            !raw_diff.trim().is_empty(),
            "shadowing local clean filter should dirty raw git diff in reftable repos: {raw_diff:?}"
        );
        assert!(
            marker.exists(),
            "shadowing local clean filter should execute during raw git diff in reftable repos"
        );
        std::fs::remove_file(&marker).unwrap();

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);

        let status = git_status(path_text(&project).to_string()).unwrap();
        assert!(
            status.files.is_empty(),
            "isolated git_status must preserve committed reftable attributes: {:?}",
            status.files
        );

        let diff = git_diff(path_text(&project).to_string(), None, Some(false), None).unwrap();
        assert!(
            diff.text.is_empty(),
            "isolated git_diff must preserve committed reftable attributes"
        );
        assert_eq!(diff.bytes, 0);
        assert_eq!(diff.lines, 0);
        assert!(!diff.truncated);
        assert!(
            !marker.exists(),
            "isolated inspection must keep blocking repo-owned executable filters in reftable repos"
        );
    }

    #[test]
    fn reftable_probe_failures_return_an_explicit_unsupported_error() {
        let error =
            validate_git_ref_storage("reftable", Err("unknown option".to_string())).unwrap_err();

        assert_eq!(
            error,
            "installed Git does not support reftable ref storage: unknown option"
        );
    }

    #[test]
    fn git_diff_does_not_execute_repository_clean_filter() {
        let tree = TempTree::new("git-clean-filter");
        let helper = tree.root.join("clean-filter.sh");
        let marker = tree.root.join("clean-filter-ran");
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=psyche-clean\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                "filter.psyche-clean.clean",
                &format!("{}; cat", marker_command(&helper, &marker)),
            ],
        );
        run_test_git(
            &tree.root,
            &["config", "filter.psyche-clean.required", "true"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let output = std::process::Command::new("git")
            .current_dir(&tree.root)
            .args(["diff", "--no-color", "--relative", "--", "tracked.txt"])
            .output()
            .expect("git diff must run in tests");
        assert!(
            output.status.success(),
            "raw git diff positive control must succeed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("+after"),
            "raw git diff positive control must include the tracked change"
        );
        assert!(
            marker.exists(),
            "raw git diff positive control must execute the configured clean filter"
        );
        std::fs::remove_file(&marker).unwrap();

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
        assert!(
            !marker.exists(),
            "hardened git_diff must not execute repository clean filters"
        );
    }

    #[test]
    fn git_diff_does_not_execute_command_scope_clean_filter() {
        let tree = TempTree::new("git-command-clean-filter");
        let helper = tree.root.join("command-clean-filter.sh");
        let marker = tree.root.join("command-clean-filter-ran");
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=command-clean\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let command = format!("{}; cat", marker_command(&helper, &marker));
        let env = [
            ("GIT_CONFIG_COUNT", "2"),
            ("GIT_CONFIG_KEY_0", "filter.command-clean.clean"),
            ("GIT_CONFIG_VALUE_0", command.as_str()),
            ("GIT_CONFIG_KEY_1", "filter.command-clean.required"),
            ("GIT_CONFIG_VALUE_1", "true"),
        ];
        let raw_diff = run_test_git_stdout_with_env(
            &tree.root,
            &["diff", "--no-color", "--relative", "--", "tracked.txt"],
            &env,
        );
        assert!(raw_diff.contains("+after"));
        assert!(
            marker.exists(),
            "raw git diff must execute the command-scope clean filter"
        );
        std::fs::remove_file(&marker).unwrap();

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("GIT_CONFIG_COUNT", Some(OsStr::new("2"))),
            (
                "GIT_CONFIG_KEY_0",
                Some(OsStr::new("filter.command-clean.clean")),
            ),
            ("GIT_CONFIG_VALUE_0", Some(command.as_ref())),
            (
                "GIT_CONFIG_KEY_1",
                Some(OsStr::new("filter.command-clean.required")),
            ),
            ("GIT_CONFIG_VALUE_1", Some(OsStr::new("true"))),
        ]);

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
        assert!(
            !marker.exists(),
            "hardened git_diff must not execute command-scope clean filters"
        );
    }

    #[test]
    fn git_diff_does_not_execute_git_config_parameters_clean_filter() {
        let tree = TempTree::new("git-parameters-clean-filter");
        let helper = tree.root.join("parameters-clean-filter.sh");
        let marker = tree.root.join("parameters-clean-filter-ran");
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=parameters-clean\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let command = format!("{}; cat", marker_command(&helper, &marker));
        let parameters = format!(
            "'filter.parameters-clean.clean'='{}' 'filter.parameters-clean.required'='true'",
            command.replace('\'', "'\\''")
        );
        let env = [("GIT_CONFIG_PARAMETERS", parameters.as_str())];
        let raw_diff = run_test_git_stdout_with_env(
            &tree.root,
            &["diff", "--no-color", "--relative", "--", "tracked.txt"],
            &env,
        );
        assert!(raw_diff.contains("+after"));
        assert!(
            marker.exists(),
            "raw git diff must execute the GIT_CONFIG_PARAMETERS clean filter"
        );
        std::fs::remove_file(&marker).unwrap();

        let _git_env =
            TestGitEnvOverrideGuard::set(&[("GIT_CONFIG_PARAMETERS", Some(parameters.as_ref()))]);
        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
        assert!(
            !marker.exists(),
            "hardened git_diff must not execute GIT_CONFIG_PARAMETERS clean filters"
        );
    }

    #[test]
    fn git_diff_neutralizes_repository_required_only_filter() {
        let tree = TempTree::new("git-required-only-filter");
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=required-only\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        run_test_git(
            &tree.root,
            &["config", "filter.required-only.required", "true"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let raw = std::process::Command::new("git")
            .current_dir(&tree.root)
            .args(["diff", "--no-color", "--relative", "--", "tracked.txt"])
            .output()
            .expect("git diff must run in tests");
        assert!(
            !raw.status.success(),
            "raw git diff must reject a required filter without a command"
        );

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
    }

    #[test]
    fn git_status_and_diff_restore_trusted_global_clean_filters_under_local_shadow() {
        let tree = TempTree::new("git-global-clean-filter");
        let project = tree.root.join("project");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        let helper = tree.root.join("shadow-clean-filter.sh");
        let marker = tree.root.join("shadow-clean-filter-ran");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        write_marker_executable(&helper);
        std::fs::write(
            &global_config,
            format!(
                "[filter \"trusted-normalize\"]\n\tclean = {}\n\trequired = true\n",
                trusted_normalizing_clean_command()
            ),
        )
        .unwrap();

        run_test_git(&project, &["init", "-q"]);
        run_test_git(&project, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &project,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&project, &["config", "core.autocrlf", "false"]);
        std::fs::write(
            project.join(".gitattributes"),
            "tracked.txt filter=trusted-normalize\n",
        )
        .unwrap();
        std::fs::write(project.join("tracked.txt"), "same content   \n").unwrap();

        let env = [
            ("HOME", path_text(&home)),
            ("GIT_CONFIG_GLOBAL", path_text(&global_config)),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ];
        run_test_git_with_env(&project, &["add", "tracked.txt", ".gitattributes"], &env);
        run_test_git_with_env(&project, &["commit", "-qm", "baseline"], &env);

        let raw_status =
            run_test_git_stdout_with_env(&project, &["status", "--porcelain", "--", "."], &env);
        assert!(
            raw_status.trim().is_empty(),
            "trusted global clean filter should start with a clean raw git status: {raw_status:?}"
        );

        std::fs::write(project.join("tracked.txt"), "same content   \n").unwrap();
        let raw_status =
            run_test_git_stdout_with_env(&project, &["status", "--porcelain", "--", "."], &env);
        assert!(
            raw_status.trim().is_empty(),
            "trusted global clean filter should keep raw git status clean: {raw_status:?}"
        );

        run_test_git(
            &project,
            &[
                "config",
                "filter.trusted-normalize.clean",
                &format!("{}; cat", marker_command(&helper, &marker)),
            ],
        );
        run_test_git(
            &project,
            &["config", "filter.trusted-normalize.required", "true"],
        );
        std::fs::write(project.join("tracked.txt"), "same content\t\t\n").unwrap();

        let raw_status =
            run_test_git_stdout_with_env(&project, &["status", "--porcelain", "--", "."], &env);
        assert!(
            !raw_status.trim().is_empty(),
            "shadowing local clean filter should dirty raw git status: {raw_status:?}"
        );
        if marker.exists() {
            std::fs::remove_file(&marker).unwrap();
        }

        std::fs::write(project.join("tracked.txt"), "same content\t\t\t\n").unwrap();
        let raw_diff = run_test_git_stdout_with_env(
            &project,
            &["diff", "--no-color", "--relative", "--", "tracked.txt"],
            &env,
        );
        assert!(
            !raw_diff.trim().is_empty(),
            "shadowing local clean filter should dirty raw git diff: {raw_diff:?}"
        );
        assert!(
            marker.exists(),
            "shadowing local clean filter should execute during raw git diff"
        );
        std::fs::remove_file(&marker).unwrap();

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);

        let overrides = git_filter_driver_overrides(path_text(&project)).unwrap();
        assert_eq!(
            overrides,
            vec![GitFilterDriverOverride {
                driver: "trusted-normalize".to_string(),
                clean: Some(trusted_normalizing_clean_command().to_string()),
                process: None,
                required: Some(true),
                repository_clean: true,
                repository_process: false,
            }]
        );

        let status = git_status(path_text(&project).to_string()).unwrap();
        assert!(
            status.files.is_empty(),
            "isolated trusted-filter status files: {:?}",
            status.files
        );

        let diff = git_diff(path_text(&project).to_string(), None, Some(false), None).unwrap();
        assert!(diff.text.is_empty());
        assert_eq!(diff.bytes, 0);
        assert_eq!(diff.lines, 0);
        assert!(!diff.truncated);
        assert!(
            !marker.exists(),
            "hardened git inspection must not execute the shadowing local clean filter"
        );
    }

    #[test]
    fn git_status_and_diff_preserve_trusted_worktree_info_attributes() {
        let tree = TempTree::new("git-worktree-info-attributes");
        let repository = tree.root.join("repository");
        let linked = tree.root.join("linked");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        std::fs::create_dir_all(&repository).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            &global_config,
            format!(
                "[filter \"trusted-normalize\"]\n\tclean = {}\n\trequired = true\n",
                trusted_normalizing_clean_command()
            ),
        )
        .unwrap();

        run_test_git(&repository, &["init", "-q"]);
        run_test_git(&repository, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &repository,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(repository.join("tracked.txt"), "seed\n").unwrap();
        run_test_git(&repository, &["add", "tracked.txt"]);
        run_test_git(&repository, &["commit", "-qm", "seed"]);
        run_test_git(
            &repository,
            &["worktree", "add", "-q", "-b", "linked", path_text(&linked)],
        );

        let (_, linked_git_dir) = git_dir_for_worktree(&linked).unwrap();
        let common_git_dir = git_common_dir(&linked_git_dir).unwrap();
        std::fs::create_dir_all(common_git_dir.join("info")).unwrap();
        std::fs::write(
            common_git_dir.join("info/attributes"),
            "tracked.txt filter=trusted-normalize\n",
        )
        .unwrap();
        std::fs::write(linked.join("tracked.txt"), "same content   \n").unwrap();

        let env = [
            ("HOME", path_text(&home)),
            ("GIT_CONFIG_GLOBAL", path_text(&global_config)),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ];
        run_test_git_with_env(&linked, &["add", "tracked.txt"], &env);
        run_test_git_with_env(&linked, &["commit", "-qm", "baseline"], &env);

        std::fs::write(linked.join("tracked.txt"), "same content\t\t\t\n").unwrap();
        let raw_status =
            run_test_git_stdout_with_env(&linked, &["status", "--porcelain", "--", "."], &env);
        assert!(
            raw_status.trim().is_empty(),
            "worktree info/attributes should keep raw git status clean: {raw_status:?}"
        );
        let raw_diff = run_test_git_stdout_with_env(
            &linked,
            &["diff", "--no-color", "--relative", "--", "."],
            &env,
        );
        assert!(
            raw_diff.trim().is_empty(),
            "worktree info/attributes should keep raw git diff clean: {raw_diff:?}"
        );

        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);
        let status = git_status(path_text(&linked).to_string()).unwrap();
        let diff = git_diff(path_text(&linked).to_string(), None, Some(false), None).unwrap();

        assert!(status.files.is_empty());
        assert!(diff.text.is_empty());
        assert_eq!(diff.bytes, 0);
        assert_eq!(diff.lines, 0);
        assert!(!diff.truncated);
    }

    #[test]
    fn git_status_and_diff_preserve_trusted_worktree_info_exclude() {
        let tree = TempTree::new("git-worktree-info-exclude");
        let repository = tree.root.join("repository");
        let linked = tree.root.join("linked");
        std::fs::create_dir_all(&repository).unwrap();

        run_test_git(&repository, &["init", "-q"]);
        run_test_git(&repository, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &repository,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(repository.join("tracked.txt"), "baseline\n").unwrap();
        run_test_git(&repository, &["add", "tracked.txt"]);
        run_test_git(&repository, &["commit", "-qm", "baseline"]);
        run_test_git(
            &repository,
            &["worktree", "add", "-q", "-b", "linked", path_text(&linked)],
        );

        let (_, linked_git_dir) = git_dir_for_worktree(&linked).unwrap();
        let common_git_dir = git_common_dir(&linked_git_dir).unwrap();
        std::fs::create_dir_all(common_git_dir.join("info")).unwrap();
        std::fs::write(common_git_dir.join("info/exclude"), "ignored.txt\n").unwrap();
        std::fs::write(linked.join("ignored.txt"), "ignored\n").unwrap();

        let raw_status =
            run_test_git_stdout_with_env(&linked, &["status", "--porcelain", "--", "."], &[]);
        assert!(
            raw_status.trim().is_empty(),
            "worktree info/exclude should hide ignored untracked files from raw git status: {raw_status:?}"
        );

        let status = git_status(path_text(&linked).to_string()).unwrap();
        let diff = git_diff(path_text(&linked).to_string(), None, Some(false), None).unwrap();

        assert!(status.files.is_empty());
        assert!(diff.text.is_empty());
        assert_eq!(diff.bytes, 0);
        assert_eq!(diff.lines, 0);
        assert!(!diff.truncated);
    }

    #[test]
    fn git_info_metadata_rejects_symlinked_info_directory_when_supported() {
        let tree = TempTree::new("git-info-linked-dir");
        let git_dir = tree.root.join("source.git");
        let outside_info = tree.root.join("outside-info");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::create_dir_all(&outside_info).unwrap();
        std::fs::write(outside_info.join("attributes"), "tracked.txt text\n").unwrap();
        if !create_test_symlink(
            TestSymlinkKind::Directory,
            &outside_info,
            &git_dir.join("info"),
        ) {
            return;
        }

        let error = read_git_info_file(&git_dir, "attributes").unwrap_err();

        assert!(error.contains("Git info directory"));
        assert!(error.contains("real directory"));
    }

    #[test]
    fn git_info_metadata_rejects_symlinked_child_files_when_supported() {
        for name in ["attributes", "exclude"] {
            let label = format!("git-info-linked-file-{name}");
            let tree = TempTree::new(&label);
            let git_dir = tree.root.join("source.git");
            let info_dir = git_dir.join("info");
            let outside = tree.root.join(format!("outside-{name}"));
            std::fs::create_dir_all(&info_dir).unwrap();
            std::fs::write(&outside, format!("{name}\n")).unwrap();
            if !create_test_symlink(TestSymlinkKind::File, &outside, &info_dir.join(name)) {
                return;
            }

            let error = read_git_info_file(&git_dir, name).unwrap_err();

            assert!(error.contains(&format!("Git info/{name}")));
            assert!(error.contains("regular file"));
        }
    }

    #[test]
    fn git_diff_does_not_execute_repository_clean_filter_from_local_include() {
        let tree = TempTree::new("git-clean-filter-include");
        let helper = tree.root.join("clean-filter-include.sh");
        let marker = tree.root.join("clean-filter-include-ran");
        let include = tree.root.join("filter-include.cfg");
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=psyche-include\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        std::fs::write(
            &include,
            format!(
                "[filter \"psyche-include\"]\n\tclean = {}; cat\n\trequired = true\n",
                marker_command(&helper, &marker)
            ),
        )
        .unwrap();
        run_test_git(&tree.root, &["config", "include.path", path_text(&include)]);
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let output = std::process::Command::new("git")
            .current_dir(&tree.root)
            .args(["diff", "--no-color", "--relative", "--", "tracked.txt"])
            .output()
            .expect("git diff must run in tests");
        assert!(
            output.status.success(),
            "raw git diff positive control must succeed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        assert!(
            marker.exists(),
            "raw git diff positive control must execute the included clean filter"
        );
        std::fs::remove_file(&marker).unwrap();

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
        assert!(
            !marker.exists(),
            "hardened git_diff must not execute repository clean filters loaded through local includes"
        );
    }

    #[test]
    fn git_diff_does_not_execute_repository_diff_helpers() {
        let tree = TempTree::new("git-external-diff");
        let helper = tree.root.join("external-diff.sh");
        let marker = tree.root.join("external-diff-ran");
        write_marker_executable(&helper);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        run_test_git(
            &tree.root,
            &["config", "diff.external", &marker_command(&helper, &marker)],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        run_test_git(
            &tree.root,
            &["diff", "--no-color", "--relative", "--", "tracked.txt"],
        );
        assert!(
            marker.exists(),
            "unhardened git diff must execute the configured helper"
        );
        std::fs::remove_file(&marker).unwrap();

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
        assert!(!marker.exists());
    }

    #[test]
    fn git_diff_does_not_execute_repository_process_filter() {
        let tree = TempTree::new("git-process-filter");
        let helper = tree.root.join("process-filter.sh");
        let marker = tree.root.join("process-filter-ran");
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=psyche-process\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        run_test_git(
            &tree.root,
            &[
                "config",
                "filter.psyche-process.process",
                &marker_command(&helper, &marker),
            ],
        );
        run_test_git(
            &tree.root,
            &["config", "filter.psyche-process.required", "true"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let output = std::process::Command::new("git")
            .current_dir(&tree.root)
            .args(["diff", "--no-color", "--relative", "--", "tracked.txt"])
            .output()
            .expect("git diff must run in tests");
        assert!(
            marker.exists(),
            "unhardened raw git diff must execute the configured process filter (status: {}, stderr: {})",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        std::fs::remove_file(&marker).unwrap();

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
        assert!(
            !marker.exists(),
            "hardened git_diff must not execute repository process filters"
        );
    }

    #[test]
    fn git_diff_does_not_execute_repository_process_filter_from_worktree_include() {
        let tree = TempTree::new("git-process-filter-worktree-include");
        let helper = tree.root.join("process-filter-worktree-include.sh");
        let marker = tree.root.join("process-filter-worktree-include-ran");
        let include = tree.root.join("worktree-filter-include.cfg");
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=psyche-worktree-include\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(
            &tree.root,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Psyche Tests",
                "commit",
                "-qm",
                "baseline",
            ],
        );
        run_test_git(&tree.root, &["config", "extensions.worktreeConfig", "true"]);
        std::fs::write(
            &include,
            format!(
                "[filter \"psyche-worktree-include\"]\n\tprocess = {}\n\trequired = true\n",
                marker_command(&helper, &marker)
            ),
        )
        .unwrap();
        run_test_git(
            &tree.root,
            &["config", "--worktree", "include.path", path_text(&include)],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let output = std::process::Command::new("git")
            .current_dir(&tree.root)
            .args(["diff", "--no-color", "--relative", "--", "tracked.txt"])
            .output()
            .expect("git diff must run in tests");
        assert!(
            marker.exists(),
            "raw git diff positive control must execute the worktree-included process filter (status: {}, stderr: {})",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        std::fs::remove_file(&marker).unwrap();

        let diff = git_diff(
            path_text(&tree.root).to_string(),
            Some("tracked.txt".to_string()),
            Some(false),
            None,
        )
        .unwrap();

        assert!(diff.text.contains("+after"));
        assert!(
            !marker.exists(),
            "hardened git_diff must not execute repository process filters loaded through worktree includes"
        );
    }

    #[test]
    fn git_inspection_does_not_execute_a_filter_added_after_policy_construction() {
        let tree = TempTree::new("git-filter-policy-race");
        let helper = if cfg!(windows) {
            tree.root.join("late-filter.bat")
        } else {
            tree.root.join("late-filter.sh")
        };
        let marker = tree.root.join("late-filter-ran");
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=late-filter\n",
        )
        .unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt", ".gitattributes"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);

        let inspection = GitInspection::new(path_text(&tree.root)).unwrap();

        run_test_git(
            &tree.root,
            &[
                "config",
                "filter.late-filter.clean",
                &format!("{}; cat", marker_command(&helper, &marker)),
            ],
        );
        run_test_git(
            &tree.root,
            &["config", "filter.late-filter.required", "true"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();

        let diff = inspection
            .execute(&[
                "--no-pager",
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--relative",
                "--",
                "tracked.txt",
            ])
            .unwrap();

        assert!(diff.contains("+after"));
        assert!(
            !marker.exists(),
            "an inspection must not reread repository filter config after its policy is constructed"
        );
    }

    #[test]
    fn git_inspection_does_not_read_attributes_added_after_policy_construction() {
        let tree = TempTree::new("git-attribute-policy-race");
        let home = tree.root.join("home");
        let global_config = home.join(".gitconfig");
        let helper = if cfg!(windows) {
            tree.root.join("trusted-late-filter.bat")
        } else {
            tree.root.join("trusted-late-filter.sh")
        };
        let marker = tree.root.join("trusted-late-filter-ran");
        std::fs::create_dir_all(&home).unwrap();
        write_marker_executable(&helper);
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        std::fs::write(tree.root.join("tracked.txt"), "before\n").unwrap();
        run_test_git(&tree.root, &["add", "tracked.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::write(
            &global_config,
            format!(
                "[filter \"trusted-late-filter\"]\n\tclean = {}; cat\n\trequired = true\n",
                marker_command(&helper, &marker)
            ),
        )
        .unwrap();
        let _git_env = TestGitEnvOverrideGuard::set(&[
            ("HOME", Some(home.as_os_str())),
            ("GIT_CONFIG_GLOBAL", Some(global_config.as_os_str())),
            ("GIT_CONFIG_NOSYSTEM", Some(OsStr::new("1"))),
        ]);

        let inspection = GitInspection::new(path_text(&tree.root)).unwrap();

        std::fs::write(
            tree.root.join(".gitattributes"),
            "tracked.txt filter=trusted-late-filter\n",
        )
        .unwrap();
        std::fs::write(tree.root.join("tracked.txt"), "after\n").unwrap();
        let diff = inspection
            .execute(&[
                "--no-pager",
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--relative",
                "--",
                "tracked.txt",
            ])
            .unwrap();

        assert!(diff.contains("+after"));
        assert!(
            !marker.exists(),
            "an inspection must keep using its immutable attribute tree"
        );
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
        run_test_git(&tree.root, &["config", "core.autocrlf", "false"]);
        run_test_git(&tree.root, &["add", "."]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::write(tree.root.join("outside.txt"), "outside changed\n").unwrap();
        std::fs::write(project.join("inside.txt"), "inside changed\n").unwrap();

        let status = git_status(path_text(&project).to_string()).unwrap();
        assert_eq!(
            status.files.len(),
            1,
            "unexpected nested-root status files: {:?}",
            status.files
        );
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
        std::fs::write(&target, b"baseline\n").unwrap();
        run_test_git(&tree.root, &["init", "-q"]);
        run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
        run_test_git(
            &tree.root,
            &["config", "user.email", "psyche-tests@example.invalid"],
        );
        run_test_git(&tree.root, &["config", "core.autocrlf", "false"]);
        run_test_git(&tree.root, &["add", "large.txt"]);
        run_test_git(&tree.root, &["commit", "-qm", "baseline"]);
        std::fs::write(&target, b"changed payload\n".repeat(180_000)).unwrap();

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
        assert_eq!(
            diff.bytes,
            full.len() as u64,
            "full diff prefix: {:?}; bounded diff prefix: {:?}",
            full.lines().take(8).collect::<Vec<_>>(),
            diff.text.lines().take(8).collect::<Vec<_>>()
        );
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
        run_test_git(&tree.root, &["init", "--quiet"]);
        run_test_git(&tree.root, &["config", "core.autocrlf", "false"]);
        let mut body = String::new();
        for index in 0..40 {
            body.push_str(&format!("line {}\n", index));
        }
        std::fs::write(tree.root.join("wide.txt"), &body).unwrap();
        run_test_git(&tree.root, &["add", "-A"]);
        run_test_git(
            &tree.root,
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
        );
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
        assert!(
            wide.text.lines().count() > narrow.text.lines().count(),
            "narrow diff: {:?}; wide diff: {:?}",
            narrow.text,
            wide.text
        );

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
