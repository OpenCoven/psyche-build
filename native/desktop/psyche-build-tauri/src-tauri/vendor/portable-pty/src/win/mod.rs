use crate::{Child, ChildKiller, ExitStatus};
use anyhow::Context as _;
use std::io::{Error as IoError, Result as IoResult};
use std::os::windows::io::{AsRawHandle, RawHandle};
use std::pin::Pin;
use std::sync::Mutex;
use std::task::{Context, Poll};
use winapi::shared::minwindef::DWORD;
use winapi::um::jobapi2::TerminateJobObject;
use winapi::um::minwinbase::STILL_ACTIVE;
use winapi::um::processthreadsapi::*;
use winapi::um::synchapi::WaitForSingleObject;
use winapi::um::winbase::INFINITE;

use crate::win_support::check_win32_bool;

pub mod conpty;
mod procthreadattr;
mod psuedocon;

use filedescriptor::OwnedHandle;

#[derive(Debug)]
pub struct WinChild {
    proc: Mutex<OwnedHandle>,
    job: Mutex<OwnedHandle>,
}

impl WinChild {
    fn is_complete(&mut self) -> IoResult<Option<ExitStatus>> {
        let mut status: DWORD = 0;
        let proc = self.proc.lock().unwrap().try_clone().unwrap();
        let res = unsafe { GetExitCodeProcess(proc.as_raw_handle() as _, &mut status) };
        if res != 0 {
            if status == STILL_ACTIVE {
                Ok(None)
            } else {
                Ok(Some(ExitStatus::with_exit_code(status)))
            }
        } else {
            Ok(None)
        }
    }

    fn do_kill(&mut self) -> IoResult<()> {
        let job = self.job.lock().map_err(|_| {
            IoError::new(
                std::io::ErrorKind::Other,
                "Windows PTY job handle lock was poisoned",
            )
        })?;
        let result = unsafe { TerminateJobObject(job.as_raw_handle() as _, 1) };
        check_win32_bool(result, "TerminateJobObject")
    }
}

impl ChildKiller for WinChild {
    fn kill(&mut self) -> IoResult<()> {
        self.do_kill()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        let job = self.job.lock().unwrap().try_clone().unwrap();
        Box::new(WinChildKiller { job })
    }
}

#[derive(Debug)]
pub struct WinChildKiller {
    job: OwnedHandle,
}

impl ChildKiller for WinChildKiller {
    fn kill(&mut self) -> IoResult<()> {
        let result = unsafe { TerminateJobObject(self.job.as_raw_handle() as _, 1) };
        check_win32_bool(result, "TerminateJobObject")
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        let job = self.job.try_clone().unwrap();
        Box::new(WinChildKiller { job })
    }
}

impl Child for WinChild {
    fn try_wait(&mut self) -> IoResult<Option<ExitStatus>> {
        self.is_complete()
    }

    fn wait(&mut self) -> IoResult<ExitStatus> {
        if let Ok(Some(status)) = self.try_wait() {
            return Ok(status);
        }
        let proc = self.proc.lock().unwrap().try_clone().unwrap();
        unsafe {
            WaitForSingleObject(proc.as_raw_handle() as _, INFINITE);
        }
        let mut status: DWORD = 0;
        let res = unsafe { GetExitCodeProcess(proc.as_raw_handle() as _, &mut status) };
        if res != 0 {
            Ok(ExitStatus::with_exit_code(status))
        } else {
            Err(IoError::last_os_error())
        }
    }

    fn process_id(&self) -> Option<u32> {
        let res = unsafe { GetProcessId(self.proc.lock().unwrap().as_raw_handle() as _) };
        if res == 0 {
            None
        } else {
            Some(res)
        }
    }

    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        let proc = self.proc.lock().unwrap();
        Some(proc.as_raw_handle())
    }
}

impl std::future::Future for WinChild {
    type Output = anyhow::Result<ExitStatus>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context) -> Poll<anyhow::Result<ExitStatus>> {
        match self.is_complete() {
            Ok(Some(status)) => Poll::Ready(Ok(status)),
            Err(err) => Poll::Ready(Err(err).context("Failed to retrieve process exit status")),
            Ok(None) => {
                struct PassRawHandleToWaiterThread(pub RawHandle);
                unsafe impl Send for PassRawHandleToWaiterThread {}

                let proc = self.proc.lock().unwrap().try_clone()?;
                let handle = PassRawHandleToWaiterThread(proc.as_raw_handle());

                let waker = cx.waker().clone();
                std::thread::spawn(move || {
                    unsafe {
                        WaitForSingleObject(handle.0 as _, INFINITE);
                    }
                    waker.wake();
                });
                Poll::Pending
            }
        }
    }
}
