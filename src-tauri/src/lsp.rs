use crate::{
    error::{AppError, Result},
    state::AppState,
    tools,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State, WebviewWindow, ipc::Channel};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{OwnedSemaphorePermit, Semaphore, mpsc},
};

pub struct Server {
    pub pid: u32,
    pub sender: mpsc::Sender<Value>,
    pub pending: Arc<Mutex<HashMap<u64, OwnedSemaphorePermit>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEvent {
    pub sequence: u64,
    pub kind: String,
    pub message: Value,
}

pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }
}

async fn read_message<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Value>> {
    let mut length = None;
    let mut header_size = 0;
    loop {
        let mut line = String::new();
        let size = reader.read_line(&mut line).await?;
        if size == 0 {
            return Ok(None);
        }
        header_size += size;
        if header_size > 8192 {
            return Err(AppError::new(
                "lspProtocol",
                "Language server sent an oversized header",
            ));
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((key, value)) = line.split_once(':')
            && key.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse::<usize>().ok();
        }
    }
    let length = length
        .filter(|n| *n <= 16 * 1024 * 1024)
        .ok_or_else(|| AppError::new("lspProtocol", "Missing or oversized LSP Content-Length"))?;
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).await?;
    Ok(Some(serde_json::from_slice(&bytes)?))
}

#[tauri::command]
pub async fn lsp_start(
    window: WebviewWindow,
    state: State<'_, AppState>,
    server_id: String,
    language: String,
    on_event: Channel<ServerEvent>,
) -> Result<String> {
    let key = format!("{}/{}", window.label(), server_id);
    // A WebView reload loses its client transports; replace that window's old process.
    if let Some(previous) = state.servers.lock().unwrap().remove(&key) {
        kill_tree(previous.pid);
    }
    let spec = tools::server_spec(&window, &state, &language)?;
    let mut command = tokio::process::Command::new(tools::process_path(&spec.executable));
    command
        .args(
            spec.arguments.iter().map(|argument| {
                tools::process_path(std::path::Path::new(argument)).into_os_string()
            }),
        )
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(root) = &spec.root {
        command.current_dir(tools::process_path(root));
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|e| {
        AppError::new(
            "languageTool",
            format!("Cannot start {}: {e}", spec.executable.display()),
        )
    })?;
    let pid = child
        .id()
        .ok_or_else(|| AppError::new("process", "Server exited before startup"))?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (sender, mut receiver) = mpsc::channel::<Value>(64);
    let pending = Arc::new(Mutex::new(HashMap::new()));
    state.servers.lock().unwrap().insert(
        key.clone(),
        Server {
            pid,
            sender,
            pending: pending.clone(),
        },
    );
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let writer = tokio::spawn(async move {
            while let Some(message) = receiver.recv().await {
                let bytes = serde_json::to_vec(&message)?;
                stdin
                    .write_all(format!("Content-Length: {}\r\n\r\n", bytes.len()).as_bytes())
                    .await?;
                stdin.write_all(&bytes).await?;
                stdin.flush().await?;
            }
            std::io::Result::Ok(())
        });
        let event_channel = on_event.clone();
        let log = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut count = 0;
            while let Ok(Some(line)) = lines.next_line().await {
                count += 1;
                if count <= 1000 {
                    let _ = event_channel.send(ServerEvent {
                        sequence: 0,
                        kind: "log".into(),
                        message: Value::String(line.chars().take(8192).collect()),
                    });
                }
            }
        });
        let semaphore = Arc::new(Semaphore::new(32));
        let reader_channel = on_event.clone();
        let mut output = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut sequence = 0;
            loop {
                let permit = semaphore
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|e| AppError::new("lsp", e.to_string()))?;
                let Some(message) = read_message(&mut reader).await? else {
                    break;
                };
                sequence += 1;
                pending.lock().unwrap().insert(sequence, permit);
                reader_channel
                    .send(ServerEvent {
                        sequence,
                        kind: "message".into(),
                        message,
                    })
                    .map_err(|e| AppError::new("channel", e.to_string()))?;
            }
            Result::Ok(())
        });
        tokio::select! {
            result = &mut output => { if let Ok(Err(e)) = result { let _ = on_event.send(ServerEvent { sequence: 0, kind: "error".into(), message: Value::String(e.message) }); } }
            _ = child.wait() => {}
        }
        kill_tree(pid);
        let _ = child.kill().await;
        let _ = child.wait().await;
        writer.abort();
        output.abort();
        log.abort();
        let _ = on_event.send(ServerEvent {
            sequence: 0,
            kind: "exit".into(),
            message: Value::Null,
        });
        let state = app.state::<AppState>();
        let mut servers = state.servers.lock().unwrap();
        if servers.get(&key).is_some_and(|server| server.pid == pid) {
            servers.remove(&key);
        }
    });
    Ok(spec.description)
}

#[tauri::command]
pub async fn lsp_send(
    window: WebviewWindow,
    state: State<'_, AppState>,
    server_id: String,
    message: Value,
) -> Result<()> {
    let key = format!("{}/{}", window.label(), server_id);
    let sender = state
        .servers
        .lock()
        .unwrap()
        .get(&key)
        .map(|s| s.sender.clone())
        .ok_or_else(|| AppError::new("lspStopped", "Language service is not running"))?;
    sender
        .send(message)
        .await
        .map_err(|e| AppError::new("lspStopped", e.to_string()))
}

#[tauri::command]
pub fn lsp_ack(
    window: WebviewWindow,
    state: State<'_, AppState>,
    server_id: String,
    sequence: u64,
) {
    if let Some(server) =
        state
            .servers
            .lock()
            .unwrap()
            .get(&format!("{}/{}", window.label(), server_id))
    {
        server.pending.lock().unwrap().remove(&sequence);
    }
}

#[tauri::command]
pub fn lsp_stop(window: WebviewWindow, state: State<'_, AppState>, server_id: String) {
    if let Some(server) =
        state
            .servers
            .lock()
            .unwrap()
            .remove(&format!("{}/{}", window.label(), server_id))
    {
        kill_tree(server.pid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn framing_uses_bytes_and_rejects_bad_headers() {
        let text = r#"{"jsonrpc":"2.0","method":"中文🙂"}"#;
        let frame = format!("Content-Length: {}\r\n\r\n{text}", text.len());
        let mut reader = BufReader::new(frame.as_bytes());
        assert_eq!(
            read_message(&mut reader).await.unwrap().unwrap()["method"],
            "中文🙂"
        );
        let mut reader = BufReader::new(&b"Content-Length: 999999999\r\n\r\n"[..]);
        assert!(read_message(&mut reader).await.is_err());
    }
}
