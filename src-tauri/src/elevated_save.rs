mod native;

use crate::{
    error::{AppError, Result},
    files,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    ffi::OsString,
    path::{Component, Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::windows::named_pipe::ClientOptions,
    time::timeout,
};

const MAGIC: &[u8; 4] = b"LCS1";
const MAX_HEADER: usize = 256 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    path: PathBuf,
    encoding: String,
    revision: Option<String>,
}

fn pipe_name(parent: u32, nonce: &str) -> String {
    format!(r"\\.\pipe\LiteCode-save-{parent}-{nonce}")
}

fn communication(error: impl std::fmt::Display) -> AppError {
    AppError::new(
        "elevation",
        format!(
            "Could not confirm the administrator save result. Check the file on disk before retrying: {error}"
        ),
    )
}

async fn write_frame(pipe: &mut (impl AsyncWrite + Unpin), value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_HEADER {
        return Err(AppError::new(
            "size",
            "The administrator save message is too large.",
        ));
    }
    pipe.write_u32_le(bytes.len() as u32).await?;
    pipe.write_all(&bytes).await?;
    Ok(())
}

async fn read_frame<T: DeserializeOwned>(pipe: &mut (impl AsyncRead + Unpin)) -> Result<T> {
    let length = pipe.read_u32_le().await? as usize;
    if length > MAX_HEADER {
        return Err(AppError::new(
            "size",
            "The administrator save message is too large.",
        ));
    }
    let mut bytes = vec![0; length];
    pipe.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn check_request(request: &Request) -> Result<()> {
    if !request.path.is_absolute()
        || request.path.components().any(|c| c == Component::ParentDir)
        || !matches!(
            request.encoding.as_str(),
            "utf8" | "utf8bom" | "utf16le" | "utf16be" | "gbk"
        )
        || request
            .revision
            .as_ref()
            .is_some_and(|r| r.len() != 64 || !r.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(AppError::new(
            "elevation",
            "Invalid administrator save request.",
        ));
    }
    // The parent sends the already authorized canonical destination. Resolve it
    // again after UAC so a replaced junction cannot redirect the request.
    if crate::state::canonical(&request.path)? != request.path {
        return Err(AppError::new(
            "elevation",
            "The save destination has changed. Reopen the file before saving.",
        ));
    }
    Ok(())
}

fn check_size(length: u64) -> Result<usize> {
    if length > files::MAX_FILE {
        return Err(AppError::new(
            "size",
            "Administrator saves cannot exceed 100 MiB.",
        ));
    }
    Ok(length as usize)
}

pub fn save(path: &Path, text: &str, encoding: &str, revision: Option<&str>) -> Result<String> {
    check_size(text.len() as u64)?;
    let request = Request {
        path: path.to_owned(),
        encoding: encoding.to_owned(),
        revision: revision.map(str::to_owned),
    };
    check_request(&request)?;
    tauri::async_runtime::block_on(async {
        let parent = std::process::id();
        let nonce = native::nonce()?;
        // Bind before displaying UAC; the elevated client must never create a server.
        let mut pipe = native::server(&pipe_name(parent, &nonce))?;
        let process = native::launch(parent, &nonce)?;
        let connected = timeout(CONNECT_TIMEOUT, async {
            tokio::select! {
                result = pipe.connect() => result.map_err(AppError::from),
                _ = async {
                    while native::running(&process) {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                } => Err(AppError::new("elevation", "The administrator save process exited before connecting.")),
            }
        })
        .await
        .map_err(communication)?;
        connected?;
        native::check_client(&pipe, &process)?;
        timeout(TRANSFER_TIMEOUT, async {
            pipe.write_all(MAGIC).await?;
            write_frame(&mut pipe, &request).await?;
            pipe.write_u64_le(text.len() as u64).await?;
            pipe.write_all(text.as_bytes()).await?;
            let response: Result<String> = read_frame(&mut pipe).await?;
            // Keep the helper alive until the complete response has been consumed.
            let _ = pipe.write_u8(1).await;
            Ok::<_, AppError>(response)
        })
        .await
        .map_err(communication)?
        .map_err(|error| communication(error.message))?
    })
}

fn helper_arguments(arguments: Vec<OsString>) -> Result<(u32, String)> {
    if arguments.len() != 2 {
        return Err(AppError::new(
            "elevation",
            "Invalid administrator save arguments.",
        ));
    }
    let parent = arguments[0]
        .to_str()
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|id| *id != 0);
    let nonce = arguments[1]
        .to_str()
        .filter(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()));
    match (parent, nonce) {
        (Some(parent), Some(nonce)) => Ok((parent, nonce.to_owned())),
        _ => Err(AppError::new(
            "elevation",
            "Invalid administrator save arguments.",
        )),
    }
}

async fn helper(parent: u32, nonce: &str) -> Result<()> {
    native::require_elevated()?;
    // Tokio defaults to SECURITY_IDENTIFICATION, preventing the server from
    // impersonating this elevated client even before its identity is checked.
    let mut pipe = ClientOptions::new().open(pipe_name(parent, nonce))?;
    let _parent = native::check_server(&pipe, parent)?;
    let (request, text) = timeout(CONNECT_TIMEOUT, async {
        let mut magic = [0; 4];
        pipe.read_exact(&mut magic).await?;
        if &magic != MAGIC {
            return Err(AppError::new(
                "elevation",
                "Invalid administrator save protocol.",
            ));
        }
        let request: Request = read_frame(&mut pipe).await?;
        check_request(&request)?;
        let length = check_size(pipe.read_u64_le().await?)?;
        let mut text = vec![0; length];
        pipe.read_exact(&mut text).await?;
        let text = String::from_utf8(text)
            .map_err(|_| AppError::new("encoding", "Invalid text in the save request."))?;
        Ok::<_, AppError>((request, text))
    })
    .await
    .map_err(communication)??;
    // Share all encoding, conflict, atomic replacement and ACL handling with
    // ordinary saves. Never relax permissions or take ownership to force a write.
    check_request(&request)?;
    let result = files::save(
        &request.path,
        &text,
        &request.encoding,
        request.revision.as_deref(),
    );
    timeout(CONNECT_TIMEOUT, async {
        write_frame(&mut pipe, &result).await?;
        pipe.read_u8().await?;
        Ok::<_, AppError>(())
    })
    .await
    .map_err(communication)??;
    Ok(())
}

/// Dispatch before Tauri, WebView or the single-instance listener is initialized.
/// Invalid helper invocations fail closed instead of falling through to the GUI.
pub fn run_helper() -> Option<i32> {
    let mut arguments = std::env::args_os().skip(1);
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--elevated-save")) {
        return None;
    }
    let result = (|| {
        let (parent, nonce) = helper_arguments(arguments.collect())?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(helper(parent, &nonce))
    })();
    Some(if result.is_ok() { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_helper_arguments_and_body_sizes() {
        assert!(helper_arguments(vec![]).is_err());
        assert!(helper_arguments(vec!["0".into(), "a".repeat(32).into()]).is_err());
        assert!(helper_arguments(vec!["12".into(), "../../payload".into()]).is_err());
        assert!(helper_arguments(vec!["12".into(), "a".repeat(32).into()]).is_ok());
        assert!(check_size(files::MAX_FILE).is_ok());
        assert!(check_size(files::MAX_FILE + 1).is_err());
        assert!(check_size(u64::MAX).is_err());
    }

    #[test]
    fn rejects_invalid_targets_encodings_and_revisions() {
        let mut request = Request {
            path: "relative.txt".into(),
            encoding: "utf8".into(),
            revision: None,
        };
        assert!(check_request(&request).is_err());
        request.path = std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
        request.encoding = "unknown".into();
        assert!(check_request(&request).is_err());
        request.encoding = "utf8".into();
        request.revision = Some("invalid".into());
        assert!(check_request(&request).is_err());
    }

    #[tokio::test]
    async fn rejects_oversized_and_unknown_protocol_messages() {
        let oversized = ((MAX_HEADER + 1) as u32).to_le_bytes();
        assert_eq!(
            read_frame::<Request>(&mut oversized.as_slice())
                .await
                .unwrap_err()
                .code,
            "size"
        );
        let payload = br#"{"path":"x","encoding":"utf8","revision":null,"command":"shell"}"#;
        let mut frame = (payload.len() as u32).to_le_bytes().to_vec();
        frame.extend_from_slice(payload);
        assert_eq!(
            read_frame::<Request>(&mut frame.as_slice())
                .await
                .unwrap_err()
                .code,
            "json"
        );
    }
}
