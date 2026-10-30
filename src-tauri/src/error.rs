use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trust_path: Option<String>,
}

pub type Result<T> = std::result::Result<T, AppError>;

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            trust_path: None,
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => "notFound",
            std::io::ErrorKind::PermissionDenied => "permissionDenied",
            _ => "io",
        };
        Self::new(code, e.to_string())
    }
}

#[cfg(windows)]
pub fn windows_io(error: windows::core::Error) -> std::io::Error {
    // HRESULT_FROM_WIN32 keeps the original Win32 error in the low word.
    if error.code().0 as u32 & 0xffff0000 == 0x80070000 {
        std::io::Error::from_raw_os_error(error.code().0 & 0xffff)
    } else {
        std::io::Error::other(error)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::new("json", e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_files_are_distinct_from_other_io_errors() {
        assert_eq!(
            AppError::from(std::io::Error::from(std::io::ErrorKind::NotFound)).code,
            "notFound"
        );
        assert_eq!(
            AppError::from(std::io::Error::from(std::io::ErrorKind::PermissionDenied)).code,
            "permissionDenied"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_errors_retain_their_kind() {
        use windows::core::{Error, HRESULT};
        let denied = windows_io(Error::from_hresult(HRESULT::from_win32(5)));
        assert_eq!(denied.raw_os_error(), Some(5));
        assert_eq!(AppError::from(denied).code, "permissionDenied");
        let sharing = windows_io(Error::from_hresult(HRESULT::from_win32(32)));
        assert_eq!(sharing.raw_os_error(), Some(32));
        assert_eq!(AppError::from(sharing).code, "io");
    }
}
