//! Ending a PTY's process, and proving it is the right one.
//!
//! #197 slice 3 gives this capability its own module. It answers two
//! questions: which operating-system process a pane's PTY actually is, and
//! how to end it and everything it started.
//!
//! Identity is not a pid. A pid can be reused between the moment a pane
//! records it and the moment something tries to kill it, so
//! `PtyProcessIdentity` and `UnixPtyIdentity` carry enough to detect that, and
//! `verified_unix_process_groups` refuses to signal a group it cannot confirm.
//! That is the "stale identity detection" this slice is named for, and it is
//! why the terminator is more than a `kill` call.
//!
//! Almost every item here is platform-gated: `#[cfg(unix)]` for process groups
//! and tty ownership, `#[cfg(windows)]` for job-object tree kills, and
//! `#[cfg(not(windows))]` for the raw-pid fallback. `terminate_platform_process`
//! is a gated pair, one definition per family, and both must stay together —
//! moving one would leave the other platform with no implementation at all.

use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{Child, ChildKiller, MasterPty};

#[cfg(unix)]
use std::os::fd::{AsRawFd, OwnedFd, RawFd};

// `duplicate_cloexec_fd` is `#[cfg(unix)]` in the crate root, so this import
// must be too. Gating it only on the module's own needs would compile here and
// fail on Windows.
#[cfg(unix)]
use super::duplicate_cloexec_fd;

#[derive(Debug)]
pub(crate) enum PtyProcessTerminatorSetupError {
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
    // portable-pty's Windows child implementation owns a dedicated kill-on-close
    // job and assigns the child through its process-creation attributes.
    // ChildKiller therefore carries a duplicated job handle; retaining that
    // capability avoids PID-reuse races and terminates descendants with the PTY root.
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
        // This is a job-wide termination through portable-pty's Windows killer,
        // rather than a raw PID termination. It is intentionally idempotent at
        // the job boundary: an already-exited job is handled by the backend.
        self.killer.lock().kill()
    }
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct UnixPtyIdentity {
    pub(crate) session_id: libc::pid_t,
    pub(crate) original_process_group: libc::pid_t,
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
pub(crate) trait UnixTerminationPlatform: Send + Sync {
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
pub(crate) struct UnixTerminationObservation {
    pub(crate) current_pid: libc::pid_t,
    pub(crate) current_process_group: libc::pid_t,
    pub(crate) current_session: libc::pid_t,
    pub(crate) tty_session: libc::pid_t,
    pub(crate) foreground_process_group: libc::pid_t,
    pub(crate) foreground_session: Option<libc::pid_t>,
    pub(crate) foreground_group: Option<libc::pid_t>,
    pub(crate) original_session: Option<libc::pid_t>,
    pub(crate) original_group: Option<libc::pid_t>,
}

#[cfg(unix)]
pub(crate) fn verified_unix_process_groups(
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
pub(crate) struct PtyProcessIdentity {
    pub(crate) child_pid: Option<u32>,
    #[cfg(unix)]
    pub(crate) unix: Option<UnixPtyIdentity>,
}

impl PtyProcessIdentity {
    #[cfg(test)]
    pub(crate) fn direct_child(child_pid: Option<u32>) -> Self {
        Self {
            child_pid,
            #[cfg(unix)]
            unix: None,
        }
    }

    #[cfg(unix)]
    #[cfg(test)]
    pub(crate) fn confirmed_unix_process_group(&self) -> Option<libc::pid_t> {
        self.unix.map(|identity| identity.original_process_group)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PtyTerminationOutcome {
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
pub(crate) struct PtyProcessTerminator {
    #[cfg(not(windows))]
    raw_pid_fallback: Arc<RawPidFallback>,
    #[cfg(unix)]
    unix_platform: Option<Arc<dyn UnixTerminationPlatform>>,
    #[cfg(windows)]
    process_tree: Arc<WindowsProcessTreeKiller>,
    identity: PtyProcessIdentity,
}

impl PtyProcessTerminator {
    pub(crate) fn from_spawned_child(
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
    pub(crate) fn from_parts(
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
    pub(crate) fn from_unix_parts(
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
    pub(crate) fn identity(&self) -> PtyProcessIdentity {
        self.identity
    }

    fn disable_pid_fallback_before_wait(&self) {
        #[cfg(not(windows))]
        self.raw_pid_fallback.disable_pid_fallback_before_wait();
    }

    pub(crate) fn wait_for_child<T>(&self, wait: impl FnOnce() -> T) -> T {
        self.disable_pid_fallback_before_wait();
        wait()
    }

    pub(crate) fn terminate(&self) -> Result<PtyTerminationOutcome, String> {
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

pub(crate) struct PtySpawnTerminationGuard {
    terminator: Option<PtyProcessTerminator>,
}

impl PtySpawnTerminationGuard {
    pub(crate) fn new(terminator: PtyProcessTerminator) -> Self {
        Self {
            terminator: Some(terminator),
        }
    }

    pub(crate) fn disarm(&mut self) {
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
