use crate::{
    error::{AppError, Result},
    logging,
};
use log::Level;
use serde_json::json;
use std::{
    os::windows::ffi::OsStrExt,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};
use windows::{
    Win32::{
        Foundation::{ERROR_MORE_DATA, ERROR_SHARING_VIOLATION, ERROR_SUCCESS, WIN32_ERROR},
        System::RestartManager::{
            CCH_RM_SESSION_KEY, RM_PROCESS_INFO, RmEndSession, RmGetList, RmRegisterResources,
            RmStartSession,
        },
    },
    core::{PCWSTR, PWSTR},
};

static PROBE_RUNNING: AtomicBool = AtomicBool::new(false);

pub(crate) fn retry<T>(
    path: &Path,
    window: &str,
    mut attempt: impl FnMut(bool) -> Result<T>,
) -> Result<T> {
    let mut delays = [50, 100, 200, 400].into_iter();
    let mut attempts = 0;
    let mut first_sharing_error = None;
    loop {
        attempts += 1;
        let error = match attempt(attempts > 1) {
            Ok(value) => {
                if let Some(error) = first_sharing_error {
                    record("file_save_recovered", path, window, &error, attempts, false);
                }
                return Ok(value);
            }
            Err(error) => error,
        };
        let sharing = error.os_error == Some(ERROR_SHARING_VIOLATION.0 as i32);
        if sharing && let Some(delay) = delays.next() {
            first_sharing_error.get_or_insert(error);
            thread::sleep(Duration::from_millis(delay));
            continue;
        }
        if error.io_stage.is_some() {
            record(
                "file_save_io_failed",
                path,
                window,
                &error,
                attempts,
                sharing,
            );
        }
        if sharing {
            return Err(AppError::new(
                "fileInUse",
                "The file is in use. Your changes are still in the editor.",
            ));
        }
        return Err(error);
    }
}

fn record(event: &str, path: &Path, window: &str, error: &AppError, attempts: u32, probe: bool) {
    let path_text = crate::tools::process_path(path);
    let mut record = json!({
        "event": event,
        "command": "save_document",
        "window": window,
        "path": path_text.to_string_lossy(),
        "operationId": logging::operation_id(),
        "stage": error.io_stage,
        "osError": error.os_error,
        "code": error.code,
        "message": error.message,
        "attempts": attempts,
    });
    if probe {
        let path = path.to_owned();
        let busy = PROBE_RUNNING.swap(true, Ordering::AcqRel);
        record["lockProbe"] = if busy { "busy" } else { "pending" }.into();
        if !busy {
            let mut probe_record = record.clone();
            logging::emit(Level::Warn, record);
            tauri::async_runtime::spawn_blocking(move || {
                let users = file_users(&path);
                PROBE_RUNNING.store(false, Ordering::Release);
                probe_record["event"] = "file_save_lock_probe".into();
                match users {
                    Ok(users) => {
                        probe_record["lockProbe"] =
                            if users.is_empty() { "empty" } else { "found" }.into();
                        probe_record["fileUsers"] = users.join(", ").into();
                    }
                    Err(error) => {
                        probe_record["lockProbe"] = "failed".into();
                        probe_record["lockProbeError"] = error.0.into();
                    }
                }
                logging::emit(Level::Warn, probe_record);
            });
            return;
        }
    }
    logging::emit(Level::Warn, record);
}

fn file_users(path: &Path) -> std::result::Result<Vec<String>, WIN32_ERROR> {
    let mut handle = 0;
    let mut key = [0; CCH_RM_SESSION_KEY as usize + 1];
    let status = unsafe { RmStartSession(&mut handle, None, PWSTR(key.as_mut_ptr())) };
    if status != ERROR_SUCCESS {
        return Err(status);
    }
    let result = (|| {
        let path: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let resources = [PCWSTR(path.as_ptr())];
        let status = unsafe { RmRegisterResources(handle, Some(&resources), None, None) };
        if status != ERROR_SUCCESS {
            return Err(status);
        }
        let mut needed = 0;
        let mut count = 0;
        let mut reasons = 0;
        let status = unsafe { RmGetList(handle, &mut needed, &mut count, None, &mut reasons) };
        match status {
            ERROR_SUCCESS => return Ok(vec![]),
            ERROR_MORE_DATA if needed <= 256 => (),
            _ => return Err(status),
        }
        let mut processes = vec![RM_PROCESS_INFO::default(); needed as usize];
        count = needed;
        let status = unsafe {
            RmGetList(
                handle,
                &mut needed,
                &mut count,
                Some(processes.as_mut_ptr()),
                &mut reasons,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(status);
        }
        processes.truncate(count as usize);
        Ok(processes
            .into_iter()
            .map(|process| {
                let name = String::from_utf16_lossy(
                    process
                        .strAppName
                        .split(|&unit| unit == 0)
                        .next()
                        .unwrap_or_default(),
                );
                format!("{} (PID {})", name, process.Process.dwProcessId)
            })
            .collect())
    })();
    let _ = unsafe { RmEndSession(handle) };
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::{hash, save};
    use std::{
        fs::{self, OpenOptions},
        os::windows::fs::OpenOptionsExt,
    };
    use windows::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

    #[test]
    fn sharing_violation_retries_and_rechecks_disk_revision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("file.txt");
        let revision = hash(b"original");
        for change_on_disk in [false, true] {
            fs::write(&path, "original").unwrap();
            let mut reader = Some(
                OpenOptions::new()
                    .read(true)
                    .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE).0)
                    .open(&path)
                    .unwrap(),
            );
            let result = retry(&path, "test", |_| {
                let result = save(&path, "edited", "utf8", Some(&revision));
                if let Some(handle) = reader.take() {
                    let error = result.as_ref().unwrap_err();
                    assert_eq!(error.os_error, Some(ERROR_SHARING_VIOLATION.0 as i32));
                    assert_eq!(error.io_stage, Some("replace_file"));
                    let users = file_users(&path).unwrap();
                    let pid = format!("(PID {})", std::process::id());
                    assert!(users.iter().any(|user| user.ends_with(&pid)), "{users:?}");
                    drop(handle);
                    if change_on_disk {
                        fs::write(&path, "external").unwrap();
                    }
                }
                result
            });
            if change_on_disk {
                assert_eq!(result.unwrap_err().code, "conflict");
                assert_eq!(fs::read_to_string(&path).unwrap(), "external");
            } else {
                assert_eq!(result.unwrap(), hash(b"edited"));
                assert_eq!(fs::read_to_string(&path).unwrap(), "edited");
            }
        }
    }
}
