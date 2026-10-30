use crate::error::{AppError, Result, windows_io};
use std::{
    ffi::{OsStr, OsString},
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::PathBuf,
};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows::{
    Win32::{
        Foundation::{HANDLE, HLOCAL, LocalFree, WAIT_TIMEOUT},
        Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_ELEVATION,
            TOKEN_QUERY, TokenElevation,
        },
        System::{
            Com::{
                COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateGuid, CoInitializeEx,
                CoUninitialize,
            },
            Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId},
            Threading::{
                GetCurrentProcess, GetProcessId, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW, WaitForSingleObject,
            },
        },
        UI::{
            Shell::{
                SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
                ShellExecuteExW,
            },
            WindowsAndMessaging::SW_HIDE,
        },
    },
    core::{PCWSTR, PWSTR, w},
};

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn handle(value: &impl AsRawHandle) -> HANDLE {
    HANDLE(value.as_raw_handle())
}

pub(super) fn nonce() -> Result<String> {
    let guid = unsafe { CoCreateGuid() }.map_err(windows_io)?;
    Ok(format!("{:032x}", guid.to_u128()))
}

pub(super) fn server(name: &str) -> Result<NamedPipeServer> {
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // Only the object's owner, administrators (including UAC credential prompts)
    // and SYSTEM may connect. Never inherit the default Everyone read grant.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            w!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)"),
            1,
            &mut descriptor,
            None,
        )
        .map_err(windows_io)?;
    }
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    };
    let result = unsafe {
        ServerOptions::new()
            .first_pipe_instance(true)
            .max_instances(1)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                name,
                (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
            )
    };
    unsafe { LocalFree(Some(HLOCAL(descriptor.0))) };
    Ok(result?)
}

struct Com;

impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub(super) fn launch(parent: u32, nonce: &str) -> Result<OwnedHandle> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }
        .ok()
        .map_err(windows_io)?;
    let _com = Com;
    let executable = wide(std::env::current_exe()?.as_os_str());
    // All arguments are generated numbers/hex; no file path or body is interpreted
    // by a shell, exposed in argv, or loaded from a user-writable payload file.
    let arguments = wide(OsStr::new(&format!("--elevated-save {parent} {nonce}")));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(executable.as_ptr()),
        lpParameters: PCWSTR(arguments.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    if let Err(error) = unsafe { ShellExecuteExW(&mut info) } {
        let error = windows_io(error);
        return Err(if error.raw_os_error() == Some(1223) {
            AppError::new(
                "elevationCancelled",
                "Administrator authorization cancelled. The file has not been saved.",
            )
        } else {
            AppError::new(
                "elevation",
                format!("Could not start the administrator save process: {error}"),
            )
        });
    }
    if info.hProcess.is_invalid() {
        return Err(AppError::new(
            "elevation",
            "Windows did not return an administrator save process.",
        ));
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(info.hProcess.0) })
}

pub(super) fn running(process: &OwnedHandle) -> bool {
    unsafe { WaitForSingleObject(handle(process), 0) == WAIT_TIMEOUT }
}

pub(super) fn check_client(pipe: &impl AsRawHandle, process: &OwnedHandle) -> Result<()> {
    let mut actual = 0;
    unsafe { GetNamedPipeClientProcessId(handle(pipe), &mut actual) }.map_err(windows_io)?;
    let expected = unsafe { GetProcessId(handle(process)) };
    check_pid(actual, expected)
}

fn check_pid(actual: u32, expected: u32) -> Result<()> {
    if expected == 0 || actual != expected {
        return Err(AppError::new(
            "elevation",
            "The administrator save connection has an unexpected process identity.",
        ));
    }
    Ok(())
}

pub(super) fn check_server(pipe: &impl AsRawHandle, parent: u32) -> Result<OwnedHandle> {
    let mut actual = 0;
    unsafe { GetNamedPipeServerProcessId(handle(pipe), &mut actual) }.map_err(windows_io)?;
    check_pid(actual, parent)?;
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, parent) }
        .map_err(windows_io)?;
    let process = unsafe { OwnedHandle::from_raw_handle(process.0) };
    let mut name = vec![0u16; 32768];
    let mut length = name.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            handle(&process),
            PROCESS_NAME_WIN32,
            PWSTR(name.as_mut_ptr()),
            &mut length,
        )
    }
    .map_err(windows_io)?;
    let image = PathBuf::from(OsString::from_wide(&name[..length as usize]));
    if std::fs::canonicalize(image)? != std::fs::canonicalize(std::env::current_exe()?)? {
        return Err(AppError::new(
            "elevation",
            "The administrator save request did not originate from this editor.",
        ));
    }
    Ok(process)
}

pub(super) fn require_elevated() -> Result<()> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }
        .map_err(windows_io)?;
    let token = unsafe { OwnedHandle::from_raw_handle(token.0) };
    let mut elevation = TOKEN_ELEVATION::default();
    let mut length = 0;
    unsafe {
        GetTokenInformation(
            handle(&token),
            TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut length,
        )
    }
    .map_err(windows_io)?;
    if elevation.TokenIsElevated == 0 {
        return Err(AppError::new(
            "elevation",
            "The administrator save process did not receive elevated permissions.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peers_must_match_the_expected_process() {
        assert!(super::check_pid(12, 12).is_ok());
        assert!(super::check_pid(13, 12).is_err());
        assert!(super::check_pid(0, 0).is_err());
    }

    #[tokio::test]
    async fn private_pipe_authenticates_both_ends() {
        let parent = std::process::id();
        let name = super::super::pipe_name(parent, &nonce().unwrap());
        let server = server(&name).unwrap();
        assert!(super::server(&name).is_err());
        let client = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(&name)
            .unwrap();
        server.connect().await.unwrap();
        let process = check_server(&client, parent).unwrap();
        check_client(&server, &process).unwrap();
        assert!(check_server(&client, parent + 1).is_err());
    }
}
