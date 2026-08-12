use std::io::{Error as IoError, Result as IoResult};

pub(crate) const WINDOWS_SPAWN_ATTRIBUTE_COUNT: u32 = 2;
pub(crate) const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;
pub(crate) const PROC_THREAD_ATTRIBUTE_JOB_LIST: usize = 0x0002_000d;

pub(crate) fn attribute_storage_words(bytes_required: usize) -> Option<usize> {
    bytes_required
        .checked_add(std::mem::size_of::<usize>() - 1)
        .map(|rounded| rounded / std::mem::size_of::<usize>())
}

pub(crate) fn check_win32_bool(result: i32, operation: &str) -> IoResult<()> {
    check_win32_bool_with(result, operation, IoError::last_os_error)
}

fn check_win32_bool_with<LastError>(
    result: i32,
    operation: &str,
    last_error: LastError,
) -> IoResult<()>
where
    LastError: FnOnce() -> IoError,
{
    if result != 0 {
        Ok(())
    } else {
        let source = last_error();
        Err(IoError::new(
            source.kind(),
            format!("{} failed: {}", operation, source),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_spawn_reserves_both_required_attributes() {
        assert_eq!(WINDOWS_SPAWN_ATTRIBUTE_COUNT, 2);
        assert_eq!(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, 0x0002_0016);
        assert_eq!(PROC_THREAD_ATTRIBUTE_JOB_LIST, 0x0002_000d);
    }

    #[test]
    fn attribute_storage_rounds_up_to_pointer_alignment() {
        let word = std::mem::size_of::<usize>();
        assert_eq!(attribute_storage_words(1), Some(1));
        assert_eq!(attribute_storage_words(word), Some(1));
        assert_eq!(attribute_storage_words(word + 1), Some(2));
        assert_eq!(attribute_storage_words(usize::MAX), None);
    }

    #[test]
    fn nonzero_win32_bool_is_success_without_reading_last_error() {
        let injected = check_win32_bool_with(1, "operation", || {
            panic!("successful Win32 BOOL must not read last-error state")
        });

        assert!(injected.is_ok());
        assert!(check_win32_bool(1, "operation").is_ok());
    }

    #[test]
    fn zero_win32_bool_includes_operation_and_os_error() {
        let error = check_win32_bool_with(0, "operation", || {
            IoError::new(std::io::ErrorKind::PermissionDenied, "access denied")
        })
        .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(error.to_string().contains("operation failed"));
        assert!(error.to_string().contains("access denied"));
    }
}
