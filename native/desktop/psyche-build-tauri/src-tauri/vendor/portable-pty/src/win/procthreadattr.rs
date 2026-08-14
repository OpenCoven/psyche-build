use crate::win::psuedocon::HPCON;
use crate::win_support::{
    attribute_storage_words, PROC_THREAD_ATTRIBUTE_JOB_LIST, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
};
use anyhow::{ensure, Error};
use std::io::Error as IoError;
use std::{mem, ptr};
use winapi::shared::minwindef::DWORD;
use winapi::um::processthreadsapi::*;
use winapi::um::winnt::HANDLE;

pub struct ProcThreadAttributeList {
    data: Vec<usize>,
}

impl ProcThreadAttributeList {
    pub fn with_capacity(num_attributes: DWORD) -> Result<Self, Error> {
        let mut bytes_required: usize = 0;
        unsafe {
            InitializeProcThreadAttributeList(
                ptr::null_mut(),
                num_attributes,
                0,
                &mut bytes_required,
            )
        };
        ensure!(
            bytes_required > 0,
            "InitializeProcThreadAttributeList sizing failed: {}",
            IoError::last_os_error()
        );
        let storage_words = attribute_storage_words(bytes_required).ok_or_else(|| {
            IoError::new(
                std::io::ErrorKind::Other,
                "attribute-list storage size overflow",
            )
        })?;
        let mut data = vec![0usize; storage_words];

        let attr_ptr = data.as_mut_ptr() as *mut _;
        let res = unsafe {
            InitializeProcThreadAttributeList(attr_ptr, num_attributes, 0, &mut bytes_required)
        };
        ensure!(
            res != 0,
            "InitializeProcThreadAttributeList failed: {}",
            IoError::last_os_error()
        );
        Ok(Self { data })
    }

    pub fn as_mut_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.data.as_mut_ptr() as *mut _
    }

    pub fn set_pty(&mut self, con: HPCON) -> Result<(), Error> {
        let res = unsafe {
            UpdateProcThreadAttribute(
                self.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                con,
                mem::size_of::<HPCON>(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        ensure!(
            res != 0,
            "UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE) failed: {}",
            IoError::last_os_error()
        );
        Ok(())
    }

    pub fn set_job_list(&mut self, jobs: &mut [HANDLE]) -> Result<(), Error> {
        ensure!(
            !jobs.is_empty(),
            "PROC_THREAD_ATTRIBUTE_JOB_LIST requires at least one job"
        );
        let res = unsafe {
            UpdateProcThreadAttribute(
                self.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST,
                jobs.as_mut_ptr() as *mut _,
                mem::size_of_val(jobs),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        ensure!(
            res != 0,
            "UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_JOB_LIST) failed: {}",
            IoError::last_os_error()
        );
        Ok(())
    }
}

impl Drop for ProcThreadAttributeList {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.as_mut_ptr()) };
    }
}
