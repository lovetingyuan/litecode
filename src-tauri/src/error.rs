use serde::Serialize;

#[derive(Debug, Serialize)]
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
        let code = if e.kind() == std::io::ErrorKind::NotFound {
            "notFound"
        } else {
            "io"
        };
        Self::new(code, e.to_string())
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
            "io"
        );
    }
}
