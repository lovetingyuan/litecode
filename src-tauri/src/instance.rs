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
    Manager, RunEvent,
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
    /// Launch without a path: open a new empty window, like VS Code.
    NewWindow,
    Open(PathBuf),
}

fn arguments(args: impl IntoIterator<Item = OsString>) -> std::io::Result<Request> {
    let mut args = args.into_iter();
    let Some(first) = args.next() else {
        return Ok(Request::NewWindow);
    };
    // Explorer drops and Open With pass the path without --open-path.
    let path = if first == "--open-path" {
        args.next()
    } else {
        Some(first)
    }
    .filter(|path| !path.is_empty())
    .ok_or_else(|| std::io::Error::other("Expected a file or directory path"))?;
    if args.next().is_some() {
        return Err(std::io::Error::other("Expected one file or directory path"));
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
        Request::NewWindow => writer.write_all(REQUEST).await,
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
        return Ok(Request::NewWindow);
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
    initial_open: Mutex<Option<PathBuf>>,
    ready: AtomicBool,
    pending: Mutex<VecDeque<Request>>,
    draining: AtomicBool,
}

impl Instance {
    fn new(data_dir: PathBuf, request: Request) -> Self {
        Self {
            data_dir,
            initial_open: Mutex::new(match request {
                Request::NewWindow => None,
                Request::Open(path) => Some(path),
            }),
            ready: AtomicBool::new(false),
            pending: Mutex::new(VecDeque::new()),
            draining: AtomicBool::new(false),
        }
    }

    // The first request is handled during setup, before any default or recovery window exists.
    pub fn take_initial_open(&self) -> Option<PathBuf> {
        self.initial_open.lock_recover().take()
    }
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
                match response {
                    Ok(none) => return Ok(none),
                    // The previous instance is exiting: it accepted the connection but closed
                    // the pipe before acknowledging. Wait for it to release the lock.
                    Err(error) if is_transient(&error) => {
                        if let Some(server) = wait_and_rebind(name, deadline, error).await? {
                            return Ok(Some(server));
                        }
                    }
                    Err(error) => return Err(error),
                }
            }
            // NotFound: the last pipe handle was just released. 231: all instances are busy.
            Err(error) if is_transient(&error) || error.raw_os_error() == Some(231) => {
                if let Some(server) = wait_and_rebind(name, deadline, error).await? {
                    return Ok(Some(server));
                }
            }
            Err(error) => return Err(error),
        }
    }
}

fn is_transient(error: &std::io::Error) -> bool {
    use std::io::ErrorKind;
    matches!(
        error.kind(),
        ErrorKind::NotFound
            | ErrorKind::UnexpectedEof
            | ErrorKind::BrokenPipe
            | ErrorKind::ConnectionReset
            | ErrorKind::ConnectionAborted
    ) || error.raw_os_error() == Some(232) // ERROR_NO_DATA: pipe is being closed
}

/// Tries to take over the lock; otherwise sleeps briefly so the caller can reconnect.
async fn wait_and_rebind(
    name: &str,
    deadline: tokio::time::Instant,
    error: std::io::Error,
) -> std::io::Result<Option<NamedPipeServer>> {
    if let Ok(server) = bind(name, true) {
        return Ok(Some(server));
    }
    if tokio::time::Instant::now() >= deadline {
        return Err(error);
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    Ok(None)
}

pub(crate) fn show_error(message: &str) {
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
                Request::NewWindow => crate::commands::create_empty_window(
                    &app,
                    &app.state::<crate::state::AppState>(),
                    None,
                )
                .map(|_| ())
                .map_err(|error| format!("Could not open a new window: {}", error.message)),
                Request::Open(path) => crate::launch::open(&app, &path).map_err(|error| {
                    format!("Could not open {}: {}", path.display(), error.message)
                }),
            };
            if let Err(error) = result {
                crate::logging::error("instance_open_failed", None, "instance", &error);
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
                crate::logging::error(
                    "instance_listener_failed",
                    None,
                    "instance",
                    &error.to_string(),
                );
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
                    crate::logging::init(app, &data_dir);
                    app.manage(Instance::new(data_dir, request));
                    tauri::async_runtime::spawn(serve(app.clone(), name, server));
                }
                Ok((_, _, None, _)) => {
                    eprintln!("Forwarded the request to the running LiteCode instance.");
                    std::process::exit(0);
                }
                Err(error) => {
                    crate::logging::error(
                        "instance_start_failed",
                        None,
                        "instance",
                        &error.to_string(),
                    );
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
            if let RunEvent::Ready = event {
                instance.ready.store(true, Ordering::Release);
                drain(app);
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
    fn startup_open_is_consumed_once_without_replaying_or_removing_forwarded_requests() {
        let directory = temp_directory();
        let initial = PathBuf::from(r"C:\项目 with spaces\a.txt");
        let instance = Instance::new(directory.path().into(), Request::Open(initial.clone()));
        assert!(instance.pending.lock_recover().is_empty());
        instance
            .pending
            .lock_recover()
            .extend([Request::Open(r"C:\next folder".into()), Request::NewWindow]);
        assert_eq!(instance.take_initial_open(), Some(initial));
        assert_eq!(instance.take_initial_open(), None);
        let mut pending = instance.pending.lock_recover();
        assert_eq!(
            pending.pop_front(),
            Some(Request::Open(r"C:\next folder".into()))
        );
        assert_eq!(pending.pop_front(), Some(Request::NewWindow));
        assert!(pending.is_empty());

        let normal = Instance::new(directory.path().into(), Request::NewWindow);
        assert_eq!(normal.take_initial_open(), None);
        assert!(normal.pending.lock_recover().is_empty());
    }

    #[test]
    fn command_line_preserves_paths_and_rejects_missing_or_extra_arguments() {
        assert_eq!(arguments([]).unwrap(), Request::NewWindow);
        for path in [
            r"C:\项目 with spaces\a.txt",
            r"C:\.",
            r"\\server\share\项目\.",
            r"relative folder\中文.txt",
        ] {
            for args in [vec![path.into()], vec!["--open-path".into(), path.into()]] {
                let request = arguments(args).unwrap();
                assert_eq!(request, Request::Open(std::path::absolute(path).unwrap()));
            }
        }
        assert!(arguments(["".into()]).is_err());
        assert!(arguments(["C:\\one".into(), "C:\\two".into()]).is_err());
        assert!(arguments(["--open-path".into()]).is_err());
        assert!(arguments(["--open-path".into(), "".into()]).is_err());
        assert!(arguments(["--open-path".into(), "C:\\one".into(), "C:\\two".into()]).is_err());
        assert!(arguments([format!("C:\\{}", "a".repeat(MAX_PATH_BYTES)).into()]).is_err());
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
            Request::NewWindow,
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
        let mut server = claim(&name, &Request::NewWindow).await.unwrap().unwrap();
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
        let mut first = claim(&name, &Request::NewWindow).await.unwrap().unwrap();
        assert!(bind(&name, true).is_err());
        let independent = claim(&pipe_name(two.path()).unwrap(), &Request::NewWindow)
            .await
            .unwrap()
            .unwrap();
        let client = tokio::spawn({
            let name = name.clone();
            async move { claim(&name, &Request::NewWindow).await.unwrap().is_none() }
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
        assert!(claim(&name, &Request::NewWindow).await.unwrap().is_some());
        drop(independent);
    }
}
