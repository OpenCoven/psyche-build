use std::collections::HashMap;
#[cfg(unix)]
use std::ffi::CString;
use std::ffi::{OsStr, OsString};
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
#[cfg(unix)]
use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
use std::path::{Component, Path, PathBuf};
#[cfg(unix)]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl,
};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenProcess, TerminateProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
    },
};

mod coven_sessions;
mod metrics;
mod native_workspace;
mod pane_metrics;
mod platform;
pub mod pty_transport;
mod workspace_contract;
use coven_sessions::is_safe_session_id;
use coven_sessions::{coven_session_kill, coven_sessions};
use metrics::{MetricsCollector, MetricsScope, MetricsSnapshot, TrackedPty};
use native_workspace::{workspace_load, workspace_save};
use pane_metrics::PaneSessionMetrics;
use pty_transport::{
    coordinate_exit_shutdown, CompletionOutcome, DrainOutcome, EnqueueError, ExitShutdownHooks,
    ExitShutdownOutcome, FinalOutputPumpSnapshot, OutputPump, RecentOutputSnapshots,
    TransportSessionKey, EXIT_DRAIN_TIMEOUT, EXIT_TERMINATION_CLEANUP_TIMEOUT,
};

const BROWSER_LABEL_PREFIX: &str = "psyche-browser-";
const MIN_BROWSER_SHORTCUT_INTERVAL: Duration = Duration::from_millis(100);
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
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
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

#[cfg(any(test, windows))]
const WINDOWS_REQUIRED_PROCESS_RIGHTS: u32 = 0x0101;
#[cfg(any(test, windows))]
const WINDOWS_JOB_KILL_ON_CLOSE_LIMIT: u32 = 0x2000;
#[cfg(any(test, windows))]
const WINDOWS_ERROR_ACCESS_DENIED: i32 = 5;

#[cfg(any(test, windows))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowsJobAssignmentFailure {
    ExternalJobRestriction,
    Other,
}

#[cfg(any(test, windows))]
fn classify_windows_job_assignment_error(error: &std::io::Error) -> WindowsJobAssignmentFailure {
    if error.raw_os_error() == Some(WINDOWS_ERROR_ACCESS_DENIED) {
        WindowsJobAssignmentFailure::ExternalJobRestriction
    } else {
        WindowsJobAssignmentFailure::Other
    }
}

#[derive(Debug)]
enum PtyProcessTerminatorSetupError {
    Message(String),
    #[cfg(windows)]
    WindowsExternalJobRestriction {
        process_id: u32,
        assignment_error: std::io::Error,
        cleanup_error: Option<std::io::Error>,
    },
    #[cfg(windows)]
    WindowsJobAssignmentFailed {
        process_id: u32,
        assignment_error: std::io::Error,
        cleanup_error: Option<std::io::Error>,
    },
}

impl std::fmt::Display for PtyProcessTerminatorSetupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Message(message) => formatter.write_str(message),
            #[cfg(windows)]
            Self::WindowsExternalJobRestriction {
                process_id,
                assignment_error,
                cleanup_error,
            } => {
                write!(
                    formatter,
                    "WindowsExternalJobRestriction: failed to assign PTY process {process_id} \
                     to its owned Job Object: {assignment_error}"
                )?;
                match cleanup_error {
                    Some(error) => write!(
                        formatter,
                        "; direct-child fallback also failed: {error}; descendant termination \
                         is not proven"
                    ),
                    None => formatter.write_str(
                        "; the direct child was terminated, but descendant termination is not proven",
                    ),
                }
            }
            #[cfg(windows)]
            Self::WindowsJobAssignmentFailed {
                process_id,
                assignment_error,
                cleanup_error,
            } => {
                write!(
                    formatter,
                    "failed to assign Windows PTY process {process_id} to its owned Job Object: \
                     {assignment_error}"
                )?;
                match cleanup_error {
                    Some(error) => {
                        write!(formatter, "; direct-child fallback also failed: {error}")
                    }
                    None => formatter.write_str("; the direct child was terminated"),
                }
            }
        }
    }
}

#[cfg(any(test, windows))]
fn check_windows_bool<LastError>(result: i32, last_error: LastError) -> std::io::Result<()>
where
    LastError: FnOnce() -> std::io::Error,
{
    if result != 0 {
        Ok(())
    } else {
        Err(last_error())
    }
}

#[cfg(any(test, windows))]
struct OwnedTerminationResource<T, Close>
where
    Close: FnMut(T),
{
    resource: Option<T>,
    close_resource: Close,
}

#[cfg(any(test, windows))]
impl<T, Close> OwnedTerminationResource<T, Close>
where
    Close: FnMut(T),
{
    fn new(resource: T, close_resource: Close) -> Self {
        Self {
            resource: Some(resource),
            close_resource,
        }
    }

    #[cfg(windows)]
    fn get(&self) -> Option<&T> {
        self.resource.as_ref()
    }

    fn close(&mut self) {
        if let Some(resource) = self.resource.take() {
            (self.close_resource)(resource);
        }
    }
}

#[cfg(any(test, windows))]
impl<T, Close: FnMut(T)> Drop for OwnedTerminationResource<T, Close> {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(windows)]
fn close_windows_handle(handle: isize) {
    let result = unsafe { CloseHandle(handle as HANDLE) };
    if result == 0 {
        log::warn!(
            "failed to close retained PTY termination handle: {}",
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(windows)]
struct OwnedWindowsProcessHandle {
    handle: OwnedTerminationResource<isize, fn(isize)>,
}

#[cfg(windows)]
impl OwnedWindowsProcessHandle {
    fn open(process_id: u32) -> std::io::Result<Self> {
        debug_assert_eq!(
            WINDOWS_REQUIRED_PROCESS_RIGHTS,
            PROCESS_SET_QUOTA | PROCESS_TERMINATE
        );
        let handle = unsafe { OpenProcess(WINDOWS_REQUIRED_PROCESS_RIGHTS, 0, process_id) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self {
            handle: OwnedTerminationResource::new(handle as isize, close_windows_handle),
        })
    }

    fn raw_handle(&self) -> HANDLE {
        *self
            .handle
            .get()
            .expect("owned Windows process handle must remain open until drop") as HANDLE
    }

    fn terminate(&self) -> std::io::Result<()> {
        let result = unsafe { TerminateProcess(self.raw_handle(), 1) };
        check_windows_bool(result, std::io::Error::last_os_error)
    }
}

#[cfg(windows)]
struct OwnedWindowsJobObject {
    handle: OwnedTerminationResource<isize, fn(isize)>,
}

#[cfg(windows)]
impl OwnedWindowsJobObject {
    fn create() -> std::io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self {
            handle: OwnedTerminationResource::new(handle as isize, close_windows_handle),
        })
    }

    fn raw_handle(&self) -> HANDLE {
        *self
            .handle
            .get()
            .expect("owned Windows Job Object handle must remain open until drop") as HANDLE
    }

    fn configure_kill_on_close(&self) -> std::io::Result<()> {
        debug_assert_eq!(
            WINDOWS_JOB_KILL_ON_CLOSE_LIMIT,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        );
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let result = unsafe {
            SetInformationJobObject(
                self.raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        check_windows_bool(result, std::io::Error::last_os_error)
    }

    fn assign_process(&self, process: &OwnedWindowsProcessHandle) -> std::io::Result<()> {
        let result = unsafe { AssignProcessToJobObject(self.raw_handle(), process.raw_handle()) };
        check_windows_bool(result, std::io::Error::last_os_error)
    }

    fn terminate(&self) -> std::io::Result<()> {
        let result = unsafe { TerminateJobObject(self.raw_handle(), 1) };
        check_windows_bool(result, std::io::Error::last_os_error)
    }
}

#[cfg(windows)]
struct OwnedWindowsProcessTree {
    job: OwnedWindowsJobObject,
    process: OwnedWindowsProcessHandle,
}

#[cfg(windows)]
impl OwnedWindowsProcessTree {
    fn terminate(&self) -> std::io::Result<()> {
        match self.job.terminate() {
            Ok(()) => Ok(()),
            Err(job_error) => {
                let fallback = self.process.terminate();
                Err(std::io::Error::new(
                    job_error.kind(),
                    match fallback {
                        Ok(()) => format!(
                            "{job_error}; the direct-child fallback was terminated, but \
                             descendant termination is not proven"
                        ),
                        Err(fallback_error) => format!(
                            "{job_error}; direct-child fallback also failed: {fallback_error}"
                        ),
                    },
                ))
            }
        }
    }
}

#[cfg(windows)]
fn terminate_borrowed_windows_child(child: &dyn Child) -> std::io::Result<()> {
    let handle = child.as_raw_handle().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "spawned PTY child did not expose a Windows process handle",
        )
    })?;
    let result = unsafe { TerminateProcess(handle as HANDLE, 1) };
    check_windows_bool(result, std::io::Error::last_os_error)
}

#[cfg(windows)]
fn windows_setup_error(
    operation: &str,
    process_id: u32,
    error: std::io::Error,
    cleanup: std::io::Result<()>,
) -> PtyProcessTerminatorSetupError {
    PtyProcessTerminatorSetupError::Message(match cleanup {
        Ok(()) => format!(
            "failed to {operation} for Windows PTY process {process_id}: {error}; \
             the direct child was terminated, but descendant termination is not proven"
        ),
        Err(cleanup_error) => format!(
            "failed to {operation} for Windows PTY process {process_id}: {error}; \
             direct-child fallback also failed: {cleanup_error}"
        ),
    })
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
    process_tree: Arc<OwnedWindowsProcessTree>,
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
            let process_id = child_pid.ok_or_else(|| {
                PtyProcessTerminatorSetupError::Message(
                    "spawned PTY child did not expose a Windows process id".to_string(),
                )
            })?;
            let process = match OwnedWindowsProcessHandle::open(process_id) {
                Ok(process) => process,
                Err(open_error) => {
                    let cleanup = terminate_borrowed_windows_child(child);
                    return Err(PtyProcessTerminatorSetupError::Message(match cleanup {
                        Ok(()) => format!(
                            "failed to retain Windows PTY process handle for {process_id}: \
                             {open_error}; the direct child was terminated, but descendant \
                             termination is not proven"
                        ),
                        Err(cleanup_error) => format!(
                            "failed to retain Windows PTY process handle for {process_id}: \
                             {open_error}; direct spawned-child cleanup also failed: \
                             {cleanup_error}"
                        ),
                    }));
                }
            };
            let job = OwnedWindowsJobObject::create().map_err(|error| {
                windows_setup_error(
                    "create an owned Job Object",
                    process_id,
                    error,
                    process.terminate(),
                )
            })?;
            job.configure_kill_on_close().map_err(|error| {
                windows_setup_error(
                    "configure JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
                    process_id,
                    error,
                    process.terminate(),
                )
            })?;
            if let Err(assignment_error) = job.assign_process(&process) {
                let cleanup_error = process.terminate().err();
                return Err(
                    match classify_windows_job_assignment_error(&assignment_error) {
                        WindowsJobAssignmentFailure::ExternalJobRestriction => {
                            PtyProcessTerminatorSetupError::WindowsExternalJobRestriction {
                                process_id,
                                assignment_error,
                                cleanup_error,
                            }
                        }
                        WindowsJobAssignmentFailure::Other => {
                            PtyProcessTerminatorSetupError::WindowsJobAssignmentFailed {
                                process_id,
                                assignment_error,
                                cleanup_error,
                            }
                        }
                    },
                );
            }
            Ok(Self {
                process_tree: Arc::new(OwnedWindowsProcessTree { job, process }),
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
    process_tree: &OwnedWindowsProcessTree,
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

    let spawn_time_unix_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    resolved_cwd.configure_command_cwd(&mut cmd)?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let pid = child.process_id();
    drop(resolved_cwd);
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
fn pty_write(thread_id: String, bytes: Vec<u8>) -> Result<(), String> {
    let writer = {
        let guard = PTY_LIFECYCLES.lock();
        let session = guard
            .live(&thread_id)
            .ok_or_else(|| format!("thread '{}' not found", thread_id))?;
        Arc::clone(&session.writer)
    };
    let mut writer = writer.lock();
    writer.write_all(&bytes).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn pty_ack(thread_id: String, sequence: u64) -> Result<(), String> {
    let pump = {
        let guard = PTY_LIFECYCLES.lock();
        let session = guard
            .live(&thread_id)
            .ok_or_else(|| format!("thread '{}' not found", thread_id))?;
        session.pump.clone()
    };
    pump.acknowledge(sequence)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn pty_resize(thread_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let master = {
        let guard = PTY_LIFECYCLES.lock();
        guard
            .live(&thread_id)
            .map(|session| Arc::clone(&session.master))
    };
    if let Some(master) = master {
        master
            .lock()
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyStopResult {
    thread_id: String,
    generation: u64,
    state: &'static str,
    termination_scope: Option<String>,
}

#[tauri::command]
fn pty_stop(thread_id: String) -> Result<PtyStopResult, String> {
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
fn pty_list() -> Vec<String> {
    PTY_LIFECYCLES.lock().live_thread_ids()
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
    let initial_secret = random_browser_shortcut_secret()?;
    let shortcut_script = browser_shortcut_initialization_script(&initial_secret)?;
    app.state::<BrowserShortcutAuthorizations>()
        .install(label, initial_secret.clone());
    let browser_label = label.to_string();
    let app_for_load = app.clone();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed_url))
        .initialization_script(shortcut_script)
        .on_page_load(move |webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Started) {
                app_for_load
                    .state::<BrowserShortcutAuthorizations>()
                    .reset(&browser_label);
            }
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
                        if (!window.__PSYCHE_BROWSER_FOCUS_INSTALLED__) {{
                          window.__PSYCHE_BROWSER_FOCUS_INSTALLED__ = true;
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
    app.state::<BrowserShortcutAuthorizations>().remove(&label);
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
        .manage(BrowserShortcutAuthorizations::default())
        .invoke_handler(tauri::generate_handler![
            pty_start,
            pane_session_metrics,
            canonical_project_path,
            pty_write,
            pty_ack,
            pty_resize,
            pty_stop,
            pty_list,
            browser_app_shortcut,
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
            coven_session_kill,
            workspace_load,
            workspace_save,
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
}

#[cfg(test)]
mod pty_runtime_tests {
    #[cfg(unix)]
    use std::collections::VecDeque;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    use super::*;
    #[cfg(not(windows))]
    use portable_pty::ChildKiller;

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
    fn windows_job_assignment_requests_only_required_process_access() {
        assert_eq!(WINDOWS_REQUIRED_PROCESS_RIGHTS, 0x0101);
    }

    #[test]
    fn windows_job_uses_kill_on_close_limit() {
        assert_eq!(WINDOWS_JOB_KILL_ON_CLOSE_LIMIT, 0x2000);
    }

    #[test]
    fn windows_access_denied_job_assignment_is_typed_as_external_restriction() {
        assert_eq!(
            classify_windows_job_assignment_error(&std::io::Error::from_raw_os_error(5)),
            WindowsJobAssignmentFailure::ExternalJobRestriction
        );
    }

    #[test]
    fn windows_bool_interpretation_accepts_nonzero_without_reading_last_error() {
        let result = check_windows_bool(1, || {
            panic!("successful Win32 BOOL results must not read last-error state")
        });

        assert!(result.is_ok());
    }

    #[test]
    fn windows_bool_interpretation_rejects_zero_with_the_explicit_os_error() {
        let error = check_windows_bool(0, || std::io::Error::from_raw_os_error(5)).unwrap_err();

        assert_eq!(error.raw_os_error(), Some(5));
    }

    #[test]
    fn owned_termination_resource_closes_exactly_once() {
        let closes = Arc::new(AtomicUsize::new(0));
        {
            let closes_for_drop = Arc::clone(&closes);
            let mut resource = OwnedTerminationResource::new(41usize, move |handle| {
                assert_eq!(handle, 41);
                closes_for_drop.fetch_add(1, Ordering::SeqCst);
            });
            resource.close();
            resource.close();
        }

        assert_eq!(closes.load(Ordering::SeqCst), 1);
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
