use crate::error::{AppError, Result};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::watch,
};

async fn read_tail(mut stream: impl AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    let mut output = vec![];
    let mut bytes = [0; 8192];
    loop {
        let count = stream.read(&mut bytes).await?;
        if count == 0 {
            return Ok(output);
        }
        output.extend_from_slice(&bytes[..count]);
        if output.len() > 65536 {
            output.drain(..output.len() - 65536);
        }
    }
}

pub(super) async fn run(
    root: &Path,
    args: &[String],
    input: Option<&[u8]>,
    mut cancelled: watch::Receiver<bool>,
    timeout: Duration,
) -> Result<String> {
    if *cancelled.borrow() {
        return Err(AppError::new(
            "cancelled",
            "Git operation cancelled. Refresh before retrying.",
        ));
    }
    let mut cmd = tokio::process::Command::new("git");
    cmd.current_dir(crate::tools::process_path(root))
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let mut child = cmd.spawn().map_err(|error| {
        AppError::new(
            "missingGit",
            format!("Cannot start system Git. Install Git and restart LiteCode. {error}"),
        )
    })?;
    let pid = child
        .id()
        .ok_or_else(|| super::git_error("Git exited before startup"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| super::git_error("Git stdin is unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| super::git_error("Git stdout is unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| super::git_error("Git stderr is unavailable"))?;
    let result = tokio::select! {
        result = async {
            let write = async {
                if let Some(input) = input { stdin.write_all(input).await?; }
                drop(stdin);
                std::io::Result::Ok(())
            };
            // Read and write concurrently: large pathspec input cannot deadlock
            // a child that fills its output pipe before reading stdin.
            let (stdout, stderr, ()) = tokio::try_join!(read_tail(stdout), read_tail(stderr), write)?;
            let status = child.wait().await?;
            let text = format!("{}{}", String::from_utf8_lossy(&stdout), String::from_utf8_lossy(&stderr));
            if !status.success() {
                return Err(super::git_error(if text.trim().is_empty() { format!("Git exited with {status}") } else { text }));
            }
            Ok(text)
        } => result,
        _ = cancelled.wait_for(|value| *value) => Err(AppError::new("cancelled", "Git operation cancelled. Refresh before retrying.")),
        _ = tokio::time::sleep(timeout) => Err(AppError::new("gitTimeout", "Git timed out. Check credentials or hooks, then refresh before retrying.")),
    };
    if result.is_err() && child.id().is_some() {
        // Credential helpers, hooks and SSH may inherit pipes. Terminate the
        // process tree as well as reaping Git before releasing the repository.
        let _ = tauri::async_runtime::spawn_blocking(move || crate::lsp::kill_tree(pid)).await;
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}

#[cfg(test)]
pub(super) fn run_sync(root: &Path, args: &[String], input: Option<&[u8]>) -> Result<String> {
    let (_cancel, cancelled) = watch::channel(false);
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(run(root, args, input, cancelled, Duration::from_secs(300)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_requests_never_start_git() {
        let (_cancel, cancelled) = watch::channel(true);
        let error = run(
            Path::new("missing"),
            &[],
            None,
            cancelled,
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "cancelled");
    }

    // Git aliases run a real child process, including on Windows Git Bash.
    async fn stalled(cancel: bool) {
        let dir = tempfile::tempdir().unwrap();
        let (sender, cancelled) = watch::channel(false);
        let args = vec![
            "-c".into(),
            "alias.stall=!echo started; sleep 60".into(),
            "stall".into(),
        ];
        let signal = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            if cancel {
                sender.send_replace(true);
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        });
        let start = std::time::Instant::now();
        let result = run(
            dir.path(),
            &args,
            None,
            cancelled,
            if cancel {
                Duration::from_secs(10)
            } else {
                Duration::from_millis(250)
            },
        )
        .await;
        signal.abort();
        assert_eq!(
            result.unwrap_err().code,
            if cancel { "cancelled" } else { "gitTimeout" }
        );
        // Windows taskkill can take several seconds under a parallel test load.
        assert!(start.elapsed() < Duration::from_secs(30));
    }

    #[tokio::test]
    async fn cancellation_terminates_a_running_process() {
        stalled(true).await;
    }

    #[tokio::test]
    async fn timeout_terminates_a_running_process() {
        stalled(false).await;
    }
}
