use crate::sync::MutexExt;
use std::{
    collections::VecDeque,
    ffi::OsString,
    os::windows::ffi::{OsStrExt, OsStringExt},
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
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions},
};

const REQUEST: &[u8; 4] = b"LCA1";
const OPEN_REQUEST: &[u8; 4] = b"LCO1";
const ACK: &[u8; 4] = b"ACK1";
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PATH_BYTES: usize = 64 * 1024;

#[derive(Debug, PartialEq)]
enum Request {
    Activate,
    Open(PathBuf),
}

fn arguments(args: impl IntoIterator<Item = OsString>) -> std::io::Result<Request> {
    let mut args = args.into_iter();
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--open-path")) {
        return Ok(Request::Activate);
    }
    let path = args
        .next()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| std::io::Error::other("--open-path requires a file or directory path"))?;
    if args.next().is_some() {
        return Err(std::io::Error::other("Expected one path after --open-path"));
    }
    let path = std::path::absolute(PathBuf::from(path))?;
    if path.as_os_str().encode_wide().count() * 2 > MAX_PATH_BYTES {
        return Err(std::io::Error::other("The requested path is too long"));
    }
    Ok(Request::Open(path))
}

async fn write_request(
    writer: &mut (impl AsyncWrite + Unpin),
    request: &Request,
) -> std::io::Result<()> {
    match request {
        Request::Activate => writer.write_all(REQUEST).await,
        Request::Open(path) => {
            let bytes: Vec<u8> = path
                .as_os_str()
                .encode_wide()
                .flat_map(u16::to_le_bytes)
                .collect();
            if bytes.is_empty() || bytes.len() > MAX_PATH_BYTES {
                return Err(std::io::Error::other("Invalid open request length"));
            }
            writer.write_all(OPEN_REQUEST).await?;
            writer.write_u32_le(bytes.len() as u32).await?;
            writer.write_all(&bytes).await
        }
    }
}

async fn read_request(reader: &mut (impl AsyncRead + Unpin)) -> std::io::Result<Request> {
    let mut header = [0; 4];
    reader.read_exact(&mut header).await?;
    if &header == REQUEST {
        return Ok(Request::Activate);
    }
    if &header != OPEN_REQUEST {
        return Err(std::io::Error::other("Invalid open request"));
    }
    let length = reader.read_u32_le().await? as usize;
    if length == 0 || length > MAX_PATH_BYTES || !length.is_multiple_of(2) {
        return Err(std::io::Error::other("Invalid open request length"));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).await?;
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let path = PathBuf::from(OsString::from_wide(&units));
    if units.contains(&0) || !path.is_absolute() {
        return Err(std::io::Error::other(
            "The requested path must be absolute without null characters",
        ));
    }
    Ok(Request::Open(path))
}

pub struct Instance {
    pub data_dir: PathBuf,
    focused: Mutex<Option<String>>,
    ready: AtomicBool,
    pending: Mutex<VecDeque<Request>>,
    draining: AtomicBool,
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
async fn claim(name: &str, request: &Request) -> std::io::Result<Option<NamedPipeServer>> {
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
                    write_request(&mut client, request).await?;
                    let mut response = [0; 4];
                    client.read_exact(&mut response).await?;
                    if &response != ACK {
                        return Err(std::io::Error::other(
                            "The running instance did not accept the open request",
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

fn show_error(message: &str) {
    use windows::{
        Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW},
        core::PCWSTR,
    };
    let message: Vec<u16> = message
        .replace('\0', "")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let title: Vec<u16> = "LiteCode\0".encode_utf16().collect();
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(message.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONERROR,
        );
    }
}

fn drain(app: &tauri::AppHandle) {
    let instance = app.state::<Instance>();
    if !instance.ready.load(Ordering::Acquire) || instance.draining.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        loop {
            let request = {
                let instance = app.state::<Instance>();
                let mut pending = instance.pending.lock_recover();
                let Some(request) = pending.pop_front() else {
                    // Release while holding the queue lock so enqueue cannot miss a wakeup.
                    instance.draining.store(false, Ordering::Release);
                    return;
                };
                request
            };
            let result = match request {
                Request::Activate => activate(&app).map_err(|error| error.to_string()),
                Request::Open(path) => crate::launch::open(&app, &path).map_err(|error| {
                    format!("Could not open {}: {}", path.display(), error.message)
                }),
            };
            if let Err(error) = result {
                show_error(&error);
            }
        }
    });
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
                let request = read_request(&mut server).await?;
                let instance = app.state::<Instance>();
                {
                    let mut pending = instance.pending.lock_recover();
                    if pending.len() >= 128 {
                        return Err(std::io::Error::other("Too many pending open requests"));
                    }
                    pending.push_back(request);
                }
                drain(&app);
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
                let request = arguments(std::env::args_os().skip(1))?;
                let server = tauri::async_runtime::block_on(claim(&name, &request))?;
                Ok((data_dir, name, server, request))
            })();
            match result {
                Ok((data_dir, name, Some(server), request)) => {
                    let mut pending = VecDeque::new();
                    if matches!(request, Request::Open(_)) {
                        pending.push_back(request);
                    }
                    app.manage(Instance {
                        data_dir,
                        focused: Mutex::new(None),
                        ready: AtomicBool::new(false),
                        pending: Mutex::new(pending),
                        draining: AtomicBool::new(false),
                    });
                    tauri::async_runtime::spawn(serve(app.clone(), name, server));
                }
                Ok((_, _, None, _)) => {
                    eprintln!("Forwarded the request to the running LiteCode instance.");
                    std::process::exit(0);
                }
                Err(error) => {
                    show_error(&format!(
                        "LiteCode could not start or forward the open request.\n\n{error}"
                    ));
                    std::process::exit(1);
                }
            }
            Ok(())
        })
        .on_event(|app, event| {
            let Some(instance) = app.try_state::<Instance>() else {
                return;
            };
            match event {
                RunEvent::Ready => {
                    instance.ready.store(true, Ordering::Release);
                    drain(app);
                }
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::Focused(true),
                    ..
                } => {
                    *instance.focused.lock_recover() = Some(label.clone());
                }
                _ => (),
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_directory() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmp");
        std::fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }

    #[test]
    fn command_line_preserves_paths_and_rejects_missing_or_extra_arguments() {
        assert_eq!(arguments([]).unwrap(), Request::Activate);
        for path in [
            r"C:\项目 with spaces\a.txt",
            r"C:\.",
            r"\\server\share\项目\.",
        ] {
            let request = arguments(["--open-path".into(), path.into()]).unwrap();
            assert_eq!(request, Request::Open(std::path::absolute(path).unwrap()));
        }
        assert!(arguments(["--open-path".into()]).is_err());
        assert!(arguments(["--open-path".into(), "".into()]).is_err());
        assert!(arguments(["--open-path".into(), "C:\\one".into(), "C:\\two".into()]).is_err());
        assert!(
            arguments([
                "--open-path".into(),
                format!("C:\\{}", "a".repeat(MAX_PATH_BYTES)).into()
            ])
            .is_err()
        );
    }

    #[tokio::test]
    async fn request_frames_preserve_order_and_windows_paths() {
        let requests = [
            Request::Activate,
            Request::Open(PathBuf::from(r"C:\项目 with spaces\a🙂.txt")),
            Request::Open(PathBuf::from(r"C:\")),
            Request::Open(PathBuf::from(r"\\server\share\项目")),
        ];
        let mut bytes = Vec::new();
        for request in &requests {
            write_request(&mut bytes, request).await.unwrap();
        }
        let mut reader = bytes.as_slice();
        for request in requests {
            let decoded = read_request(&mut reader).await.unwrap();
            assert_eq!(decoded, request);
        }
        assert!(reader.is_empty());
    }

    #[tokio::test]
    async fn invalid_requests_are_rejected_before_unbounded_allocation() {
        for length in [0u32, 3, MAX_PATH_BYTES as u32 + 2, u32::MAX] {
            let mut bytes = OPEN_REQUEST.to_vec();
            bytes.extend(length.to_le_bytes());
            assert!(read_request(&mut bytes.as_slice()).await.is_err());
        }
        for path in ["relative.txt", "C:\\bad\0name"] {
            let mut bytes = Vec::new();
            write_request(&mut bytes, &Request::Open(path.into()))
                .await
                .unwrap();
            assert!(read_request(&mut bytes.as_slice()).await.is_err());
        }
        assert!(read_request(&mut b"NOPE".as_slice()).await.is_err());
        let mut incomplete = OPEN_REQUEST.to_vec();
        incomplete.extend(4u32.to_le_bytes());
        incomplete.extend([1, 0]);
        assert!(read_request(&mut incomplete.as_slice()).await.is_err());
    }

    #[tokio::test]
    async fn single_instance_forwards_consecutive_open_requests_without_releasing_the_lock() {
        let directory = temp_directory();
        let name = pipe_name(directory.path()).unwrap();
        let mut server = claim(&name, &Request::Activate).await.unwrap().unwrap();
        for path in [
            r"C:\项目 with spaces\a.txt",
            r"C:\项目 with spaces",
            r"C:\项目 with spaces",
        ] {
            let client = tokio::spawn({
                let name = name.clone();
                let request = Request::Open(path.into());
                async move { claim(&name, &request).await.unwrap().is_none() }
            });
            server.connect().await.unwrap();
            let next = bind(&name, false).unwrap();
            assert_eq!(
                read_request(&mut server).await.unwrap(),
                Request::Open(path.into())
            );
            server.write_all(ACK).await.unwrap();
            assert!(client.await.unwrap());
            server = next;
            assert!(bind(&name, true).is_err());
        }
    }

    #[tokio::test]
    async fn data_directories_are_independent_and_locks_release_without_a_lockfile() {
        let one = temp_directory();
        let two = temp_directory();
        let name = pipe_name(one.path()).unwrap();
        let mut first = claim(&name, &Request::Activate).await.unwrap().unwrap();
        assert!(bind(&name, true).is_err());
        let independent = claim(&pipe_name(two.path()).unwrap(), &Request::Activate)
            .await
            .unwrap()
            .unwrap();
        let client = tokio::spawn({
            let name = name.clone();
            async move { claim(&name, &Request::Activate).await.unwrap().is_none() }
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
        assert!(claim(&name, &Request::Activate).await.unwrap().is_some());
        drop(independent);
    }
}
