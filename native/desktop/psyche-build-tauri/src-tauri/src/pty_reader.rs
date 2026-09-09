//! Reading a PTY's output, and shutting one down when its process exits.
//!
//! #197 slice 3 gives this its own module. Two responsibilities that share a
//! lifetime: a blocking reader thread draining the PTY into the output pump,
//! and the shutdown that runs once the child process is gone.
//!
//! Cancellation is the reason these belong together. A reader blocked in
//! `read()` cannot be asked politely to stop, so `PtyReaderCancellation` wakes
//! it by platform-specific means and `PtyExitShutdown` is what decides when
//! that should happen. Splitting them would put the wake-up in one module and
//! the reason for it in another.
//!
//! `prepare_pty_reader` has three definitions, not two: `#[cfg(unix)]`,
//! `#[cfg(windows)]`, and `#[cfg(all(not(unix), not(windows)))]` for anything
//! else. All three move together — a two-way split would silently drop the
//! fallback and leave an unsupported target with no reader at all rather than
//! a compile error.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use portable_pty::MasterPty;

use super::pty_process::PtyProcessTerminator;
use super::pty_transport::{
    CompletionOutcome, DrainOutcome, EnqueueError, ExitShutdownHooks, OutputPump,
};
// `BeginExitOutcome` belongs to the lifecycle registry, which is still in the
// crate root and is the next slice's concern.
use super::{BeginExitOutcome, PtySessionToken, PTY_LIFECYCLES};

// Both pipe helpers are `#[cfg(unix)]` in the crate root, so these imports
// must be too; ungated they would compile here and fail on Windows.
#[cfg(unix)]
use super::{create_cloexec_pipe, duplicate_cloexec_fd};
#[cfg(unix)]
use std::os::fd::{AsRawFd, OwnedFd};

pub(crate) fn pump_pty_reader<R: Read>(mut reader: R, pump: OutputPump) -> Result<(), String> {
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

#[cfg(windows)]
struct WindowsPtyReaderCancellation {
    cancelled: AtomicBool,
    reader_thread: Mutex<Option<std::os::windows::io::OwnedHandle>>,
}

#[derive(Clone)]
pub(crate) struct PtyReaderCancellation {
    #[cfg(unix)]
    inner: Arc<UnixPtyReaderCancellation>,
    #[cfg(windows)]
    inner: Arc<WindowsPtyReaderCancellation>,
}

impl PtyReaderCancellation {
    pub(crate) fn cancel(&self) -> std::io::Result<()> {
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
        #[cfg(windows)]
        {
            self.inner.cancelled.store(true, Ordering::Release);
            let reader_thread = self.inner.reader_thread.lock();
            let Some(reader_thread) = reader_thread.as_ref() else {
                // The reader installs its handle at thread start. If it has
                // not started yet, the atomic check makes its first read a
                // clean EOF and no synchronous I/O is pending to cancel.
                return Ok(());
            };
            let result = unsafe {
                windows::Win32::System::IO::CancelSynchronousIo(windows::Win32::Foundation::HANDLE(
                    std::os::windows::io::AsRawHandle::as_raw_handle(reader_thread),
                ))
            };
            match result {
                Ok(()) => Ok(()),
                Err(error)
                    if error.code()
                        == windows::core::HRESULT::from_win32(
                            windows::Win32::Foundation::ERROR_NOT_FOUND.0,
                        ) =>
                {
                    Ok(())
                }
                Err(error) => Err(std::io::Error::other(error.to_string())),
            }
        }
        #[cfg(all(not(unix), not(windows)))]
        {
            Ok(())
        }
    }

    #[cfg(windows)]
    fn install_current_thread(&self) -> std::io::Result<()> {
        use std::os::windows::io::FromRawHandle;
        use windows::Win32::System::Threading::{GetCurrentThreadId, OpenThread, THREAD_TERMINATE};

        let handle = unsafe { OpenThread(THREAD_TERMINATE, false, GetCurrentThreadId()) }
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        let owned = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle.0) };
        *self.inner.reader_thread.lock() = Some(owned);
        Ok(())
    }
}

#[cfg(unix)]
pub(crate) fn prepare_pty_reader(
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

#[cfg(windows)]
struct WindowsPtyReader {
    reader: Box<dyn Read + Send>,
    cancellation: Arc<WindowsPtyReaderCancellation>,
}

#[cfg(windows)]
impl Read for WindowsPtyReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.cancellation.cancelled.load(Ordering::Acquire) {
            return Ok(0);
        }
        let result = self.reader.read(buffer);
        if self.cancellation.cancelled.load(Ordering::Acquire) {
            Ok(0)
        } else {
            result
        }
    }
}

#[cfg(windows)]
pub(crate) fn prepare_pty_reader(
    master: &dyn MasterPty,
) -> Result<(Box<dyn Read + Send>, PtyReaderCancellation), String> {
    let cancellation = Arc::new(WindowsPtyReaderCancellation {
        cancelled: AtomicBool::new(false),
        reader_thread: Mutex::new(None),
    });
    let reader = master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    Ok((
        Box::new(WindowsPtyReader {
            reader,
            cancellation: cancellation.clone(),
        }),
        PtyReaderCancellation {
            inner: cancellation,
        },
    ))
}

#[cfg(all(not(unix), not(windows)))]
pub(crate) fn prepare_pty_reader(
    master: &dyn MasterPty,
) -> Result<(Box<dyn Read + Send>, PtyReaderCancellation), String> {
    Ok((
        master
            .try_clone_reader()
            .map_err(|error| error.to_string())?,
        PtyReaderCancellation {},
    ))
}

pub(crate) struct PtyExitShutdown {
    pub(crate) token: PtySessionToken,
    pub(crate) pump: OutputPump,
    terminator: PtyProcessTerminator,
    reader_cancellation: PtyReaderCancellation,
    reader_done_rx: std::sync::mpsc::Receiver<Result<(), String>>,
    reader_thread: Option<std::thread::JoinHandle<()>>,
    reader_result: Option<Result<(), String>>,
    reader_completion_known: bool,
    pub(crate) exit_event_allowed: bool,
}

impl PtyExitShutdown {
    pub(crate) fn new(
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

    pub(crate) fn finish_terminated_threads(&mut self, timeout: std::time::Duration) -> bool {
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
        let worker_completed =
            if self.pump.wait_for_worker_timeout(remaining) == CompletionOutcome::Completed {
                if self.pump.join_worker_after_completion().is_err() {
                    log::warn!("PTY output worker panicked for '{}'", self.token.thread_id);
                }
                true
            } else {
                log::warn!(
                    "PTY output worker did not finish after terminating '{}'",
                    self.token.thread_id
                );
                false
            };
        if !self.reader_completion_known {
            log::warn!(
                "PTY reader did not finish after terminating and cancelling '{}'",
                self.token.thread_id
            );
        }
        self.reader_completion_known && worker_completed
    }

    pub(crate) fn abandon_terminated_threads(&mut self) {
        // The reader and output pump were already cancelled by the bounded
        // shutdown path. Dropping their join handles deliberately detaches
        // any OS thread that ignored cancellation; the cancelled pump rejects
        // late output, so the lifecycle entry can leave Exiting without an
        // unbounded reaper or a permanently reserved thread id.
        if let Err(error) = self.reader_cancellation.cancel() {
            log::warn!(
                "failed to re-cancel PTY reader before detaching '{}': {error}",
                self.token.thread_id
            );
        }
        self.pump.cancel();
        self.pump.abandon_worker();
        if self.reader_thread.take().is_some() {
            log::warn!(
                "detaching PTY reader after bounded cleanup for '{}'",
                self.token.thread_id
            );
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
