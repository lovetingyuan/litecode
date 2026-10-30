use crate::sync::MutexExt;
use std::{
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{
    Manager, RunEvent, WindowEvent,
    plugin::{Builder, TauriPlugin},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions},
};

const REQUEST: &[u8; 4] = b"LCA1";
const ACK: &[u8; 4] = b"ACK1";
const TIMEOUT: Duration = Duration::from_secs(10);

pub struct Instance {
    pub data_dir: PathBuf,
    focused: Mutex<Option<String>>,
    ready: AtomicBool,
    pending: AtomicBool,
}

fn pipe_name(directory: &Path) -> std::io::Result<String> {
    let canonical = std::fs::canonicalize(directory)?
        .to_string_lossy()
        .to_lowercase();
    Ok(format!(
        r"\\.\pipe\LiteCode-{}",
        crate::files::hash(canonical.as_bytes())
    ))
}

fn bind(name: &str, first: bool) -> std::io::Result<NamedPipeServer> {
    ServerOptions::new()
        .first_pipe_instance(first)
        .reject_remote_clients(true)
        .create(name)
}

// The listening pipe is also the instance lock. Never drop the last handle while
// this process can still write sessions, including between client connections.
async fn claim(name: &str) -> std::io::Result<Option<NamedPipeServer>> {
    match bind(name, true) {
        Ok(server) => return Ok(Some(server)),
        Err(error) if error.raw_os_error() == Some(5) => (),
        Err(error) => return Err(error),
    }
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    let mut retried = false;
    loop {
        match ClientOptions::new().open(name) {
            Ok(mut client) => {
                use std::os::windows::io::AsRawHandle;
                use windows::Win32::{
                    Foundation::HANDLE, System::Pipes::GetNamedPipeServerProcessId,
                    UI::WindowsAndMessaging::AllowSetForegroundWindow,
                };
                let mut pid = 0;
                unsafe {
                    if GetNamedPipeServerProcessId(HANDLE(client.as_raw_handle()), &mut pid).is_ok()
                    {
                        let _ = AllowSetForegroundWindow(pid);
                    }
                }
                let response = tokio::time::timeout_at(deadline, async {
                    client.write_all(REQUEST).await?;
                    let mut response = [0; 4];
                    client.read_exact(&mut response).await?;
                    if &response != ACK {
                        return Err(std::io::Error::other(
                            "The running instance did not accept the activation request",
                        ));
                    }
                    Ok(None)
                })
                .await
                .map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "The running LiteCode instance did not respond within 10 seconds",
                    )
                })?;
                drop(client);
                if response.is_err() && !retried {
                    if let Ok(server) = bind(name, true) {
                        return Ok(Some(server));
                    }
                }
                return response;
            }
            Err(error) => {
                if error.kind() == std::io::ErrorKind::NotFound && !retried {
                    retried = true;
                    if let Ok(server) = bind(name, true) {
                        return Ok(Some(server));
                    }
                } else if error.raw_os_error() != Some(231)
                    && error.kind() != std::io::ErrorKind::NotFound
                {
                    return Err(error);
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(error);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

fn activate(app: &tauri::AppHandle) -> std::io::Result<()> {
    let instance = app.state::<Instance>();
    let focused = instance.focused.lock_recover().clone();
    let window = focused
        .and_then(|label| app.get_webview_window(&label))
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| app.webview_windows().into_values().next())
        .ok_or_else(|| std::io::Error::other("The running instance has no editor window"))?;
    window.show().map_err(std::io::Error::other)?;
    window.unminimize().map_err(std::io::Error::other)?;
    window.set_focus().map_err(std::io::Error::other)?;
    Ok(())
}

async fn serve(app: tauri::AppHandle, name: String, mut server: NamedPipeServer) {
    loop {
        let connected = server.connect().await;
        let next = match bind(&name, false) {
            Ok(next) => next,
            Err(error) => {
                eprintln!("Could not maintain the instance listener: {error}");
                app.exit(1);
                // Keep the lock until Tauri has finished exiting.
                std::future::pending::<()>().await;
                return;
            }
        };
        if connected.is_ok() {
            let _ = tokio::time::timeout(TIMEOUT, async {
                let mut request = [0; 4];
                server.read_exact(&mut request).await?;
                if &request != REQUEST {
                    return Err(std::io::Error::other("Invalid activation request"));
                }
                let instance = app.state::<Instance>();
                instance.pending.store(true, Ordering::Release);
                if instance.ready.load(Ordering::Acquire) {
                    let (send, receive) = tokio::sync::oneshot::channel();
                    let handle = app.clone();
                    app.run_on_main_thread(move || {
                        handle
                            .state::<Instance>()
                            .pending
                            .store(false, Ordering::Release);
                        let _ = send.send(activate(&handle));
                    })
                    .map_err(std::io::Error::other)?;
                    receive.await.map_err(std::io::Error::other)??;
                }
                server.write_all(ACK).await
            })
            .await;
        }
        server = next;
    }
}

pub fn init() -> TauriPlugin<tauri::Wry> {
    Builder::new("instance")
        .setup(|app, _| {
            let result = (|| -> std::result::Result<_, Box<dyn std::error::Error>> {
                let data_dir = crate::data_directory(app)?;
                std::fs::create_dir_all(&data_dir)?;
                let name = pipe_name(&data_dir)?;
                Ok((data_dir, name.clone(), tauri::async_runtime::block_on(claim(&name))?))
            })();
            match result {
                Ok((data_dir, name, Some(server))) => {
                    app.manage(Instance { data_dir, focused: Mutex::new(None), ready: AtomicBool::new(false), pending: AtomicBool::new(false) });
                    tauri::async_runtime::spawn(serve(app.clone(), name, server));
                }
                Ok((_, _, None)) => {
                    eprintln!("LiteCode is already running with this user data directory; activated the existing instance.");
                    std::process::exit(0);
                }
                Err(error) => {
                    use windows::{core::PCWSTR, Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK}};
                    let message: Vec<u16> = format!("LiteCode could not safely open its user data directory. Close the running instance and try again.\n\n{error}\0").encode_utf16().collect();
                    let title: Vec<u16> = "LiteCode\0".encode_utf16().collect();
                    unsafe { MessageBoxW(None, PCWSTR(message.as_ptr()), PCWSTR(title.as_ptr()), MB_OK | MB_ICONERROR); }
                    std::process::exit(1);
                }
            }
            Ok(())
        })
        .on_event(|app, event| {
            let Some(instance) = app.try_state::<Instance>() else { return; };
            match event {
                RunEvent::Ready => {
                    instance.ready.store(true, Ordering::Release);
                    if instance.pending.swap(false, Ordering::AcqRel) { let _ = activate(app); }
                }
                RunEvent::WindowEvent { label, event: WindowEvent::Focused(true), .. } => {
                    *instance.focused.lock_recover() = Some(label.clone());
                }
                _ => (),
            }
        }).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn data_directories_are_independent_and_locks_release_without_a_lockfile() {
        let one = tempfile::tempdir().unwrap();
        let two = tempfile::tempdir().unwrap();
        let name = pipe_name(one.path()).unwrap();
        let mut first = claim(&name).await.unwrap().unwrap();
        assert!(bind(&name, true).is_err());
        let independent = claim(&pipe_name(two.path()).unwrap())
            .await
            .unwrap()
            .unwrap();
        let client = tokio::spawn({
            let name = name.clone();
            async move { claim(&name).await.unwrap().is_none() }
        });
        first.connect().await.unwrap();
        let next = bind(&name, false).unwrap();
        let mut request = [0; 4];
        first.read_exact(&mut request).await.unwrap();
        assert_eq!(&request, REQUEST);
        first.write_all(ACK).await.unwrap();
        assert!(client.await.unwrap());
        drop(first);
        assert!(bind(&name, true).is_err());
        drop(next);
        assert!(claim(&name).await.unwrap().is_some());
        drop(independent);
    }
}
