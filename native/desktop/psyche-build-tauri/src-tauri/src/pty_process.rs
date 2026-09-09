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

#[cfg(test)]
pub(crate) mod tests {
    /// A terminator wired to a counting `ChildKiller`, for fixtures elsewhere.
    ///
    /// Exists so `PtyProcessTerminator::from_parts` and
    /// `PtyProcessIdentity::direct_child` can stay private. One test in
    /// `lib.rs` builds a live `PtySession`, which needs a terminator; giving it
    /// a constructor here is cheaper than making two internals crate-visible
    /// and keeps the shape of a real terminator in the module that owns it.
    #[cfg(not(windows))]
    pub(crate) fn recording_terminator(
        calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    ) -> super::PtyProcessTerminator {
        super::PtyProcessTerminator::from_parts(
            Box::new(RecordingChildKiller { calls }),
            super::PtyProcessIdentity::direct_child(None),
        )
    }

    #[cfg(unix)]
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    use super::*;
    #[cfg(not(windows))]
    use portable_pty::ChildKiller;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    #[cfg(not(windows))]
    #[derive(Debug)]
    pub(crate) struct RecordingChildKiller {
        pub(crate) calls: Arc<AtomicUsize>,
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
