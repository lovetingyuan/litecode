mod profiles;

use crate::{
    error::{AppError, Result},
    state::AppState,
    tools,
};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
};
use tauri::{
    State, WebviewWindow,
    ipc::{Channel, InvokeResponseBody},
};

const OUTPUT_WINDOW: usize = 256 * 1024;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct Service {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

#[derive(Default)]
struct Flow {
    pending: Mutex<usize>,
    changed: Condvar,
    closed: AtomicBool,
}
impl Flow {
    fn reserve(&self, count: usize) -> bool {
        let mut pending = self.pending.lock().unwrap();
        while *pending + count > OUTPUT_WINDOW && !self.closed.load(Ordering::Acquire) {
            pending = self.changed.wait(pending).unwrap();
        }
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        *pending += count;
        true
    }
    fn ack(&self, count: usize) -> Result<()> {
        let mut pending = self.pending.lock().unwrap();
        if count > *pending {
            return Err(AppError::new(
                "terminalAck",
                "Invalid terminal acknowledgement",
            ));
        }
        *pending -= count;
        self.changed.notify_all();
        Ok(())
    }
    fn drained(&self) -> bool {
        let mut pending = self.pending.lock().unwrap();
        while *pending > 0 && !self.closed.load(Ordering::Acquire) {
            pending = self.changed.wait(pending).unwrap();
        }
        !self.closed.load(Ordering::Acquire)
    }
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.changed.notify_all();
    }
}

struct Session {
    owner: String,
    profile: profiles::Profile,
    cwd: Mutex<PathBuf>,
    initial_cwd: PathBuf,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<mpsc::SyncSender<Vec<u8>>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    flow: Arc<Flow>,
    closed: AtomicBool,
    events: Channel<Event>,
    #[cfg(windows)]
    job: Job,
}
impl Session {
    fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.flow.close();
        let _ = self.events.send(Event {
            kind: "closed".into(),
            exit_code: None,
            error: Some("Terminal session was closed.".into()),
        });
        #[cfg(windows)]
        self.job.terminate();
        let _ = self.killer.lock().unwrap().kill();
        self.writer.lock().unwrap().take();
        // ClosePseudoConsole can wait for its output pipe; never run it on the UI thread.
        if let Some(master) = self.master.lock().unwrap().take() {
            std::thread::spawn(move || drop(master));
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(windows)]
struct Job(isize);
#[cfg(windows)]
impl Job {
    fn new(pid: u32) -> Result<Self> {
        use windows::Win32::{
            Foundation::CloseHandle,
            System::{JobObjects::*, Threading::*},
        };
        unsafe {
            let handle = CreateJobObjectW(None, None).map_err(pty_error)?;
            let job = Self(handle.0 as isize);
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            )
            .map_err(pty_error)?;
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
                .map_err(pty_error)?;
            let assigned = AssignProcessToJobObject(handle, process);
            let _ = CloseHandle(process);
            assigned.map_err(pty_error)?;
            Ok(job)
        }
    }
    fn terminate(&self) {
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(
                windows::Win32::Foundation::HANDLE(self.0 as *mut _),
                1,
            );
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                self.0 as *mut _,
            ));
        }
    }
}

impl Service {
    fn get(&self, owner: &str, id: &str) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .filter(|s| s.owner == owner)
            .cloned()
            .ok_or_else(|| {
                AppError::new(
                    "terminalSession",
                    "Terminal session is closed or belongs to another window",
                )
            })
    }
    pub fn close_window(&self, owner: &str) {
        let removed: Vec<_> = {
            let mut sessions = self.sessions.lock().unwrap();
            let ids: Vec<_> = sessions
                .iter()
                .filter(|(_, s)| s.owner == owner)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| sessions.remove(&id))
                .collect()
        };
        for session in removed {
            session.close();
        }
    }
}

fn pty_error(e: impl std::fmt::Display) -> AppError {
    AppError::new("terminal", e.to_string())
}
fn size(cols: u16, rows: u16) -> Result<PtySize> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
        return Err(AppError::new("terminalSize", "Invalid terminal dimensions"));
    }
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileList {
    profiles: Vec<profiles::Profile>,
    default_profile: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    id: String,
    profile: profiles::Profile,
    cwd: String,
    integration: bool,
    pid: Option<u32>,
    windows_build: u32,
}

fn windows_build() -> u32 {
    #[cfg(windows)]
    unsafe {
        let mut version = windows::Win32::System::SystemInformation::OSVERSIONINFOW::default();
        version.dwOSVersionInfoSize = std::mem::size_of_val(&version) as u32;
        if windows::Wdk::System::SystemServices::RtlGetVersion(&mut version).is_ok() {
            return version.dwBuildNumber;
        }
    }
    0
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    kind: String,
    exit_code: Option<u32>,
    error: Option<String>,
}

#[tauri::command]
pub fn terminal_profiles(window: WebviewWindow, state: State<'_, AppState>) -> Result<ProfileList> {
    let settings = tools::settings(&window, &state);
    let root = state
        .windows
        .lock()
        .unwrap()
        .get(window.label())
        .and_then(|w| w.root.clone());
    let profiles = profiles::detect(&settings, root.as_deref())?;
    let default_profile = settings["terminal.integrated.defaultProfile.windows"]
        .as_str()
        .map(String::from)
        .or_else(|| profiles.first().map(|p| p.name.clone()));
    Ok(ProfileList {
        profiles,
        default_profile,
    })
}

fn build_command(
    profile: &profiles::Profile,
    settings: &Value,
    root: Option<&std::path::Path>,
    cwd: &std::path::Path,
    data_dir: &std::path::Path,
) -> Result<(CommandBuilder, bool)> {
    let executable = PathBuf::from(profiles::expand(&profile.path, root)?);
    if !executable.is_absolute() || !executable.is_file() {
        return Err(AppError::new(
            "terminalProfile",
            format!("Shell executable does not exist: {}", executable.display()),
        ));
    }
    // App execution aliases (e.g. Store PowerShell) are executable by CreateProcessW
    // but cannot be canonicalized (ERROR_CANT_ACCESS_FILE / 1920).
    // cmd.exe also requires native separators in argv[0], even with lpApplicationName.
    let executable = match std::fs::canonicalize(&executable) {
        Ok(path) => path,
        Err(error) if cfg!(windows) && error.raw_os_error() == Some(1920) => executable,
        Err(error) => return Err(error.into()),
    };
    let executable = tools::process_path(&executable);
    let mut cmd = CommandBuilder::new(executable);
    let requested = settings["terminal.integrated.shellIntegration.enabled"]
        .as_bool()
        .unwrap_or(true);
    let compatible = !profile.args.iter().any(|arg| {
        matches!(
            arg.to_lowercase().as_str(),
            "-command"
                | "-encodedcommand"
                | "-file"
                | "-c"
                | "/c"
                | "/k"
                | "--rcfile"
                | "--init-file"
        )
    });
    let integration = requested && compatible && profile.kind != "custom";
    if profile.kind == "bash" && integration {
        let dir = data_dir.join("terminal");
        std::fs::create_dir_all(&dir)?;
        let script = dir.join("integration.bash");
        crate::files::atomic_write(&script, include_bytes!("integration.bash"))?;
        cmd.args(
            profile
                .args
                .iter()
                .filter(|arg| !matches!(arg.as_str(), "--login" | "-l" | "-i")),
        );
        cmd.arg("--init-file");
        cmd.arg(tools::process_path(&script));
        cmd.arg("-i");
    } else {
        cmd.args(&profile.args);
        if profile.kind == "cmd" && profile.args.is_empty() {
            cmd.arg("/K");
        }
        if profile.kind == "powershell" && integration {
            cmd.args([
                "-NoLogo",
                "-NoExit",
                "-Command",
                include_str!("integration.ps1"),
            ]);
        }
    }
    if let Some(env) = settings["terminal.integrated.env.windows"].as_object() {
        for (name, value) in env {
            if let Some(value) = value.as_str() {
                cmd.env(name, profiles::expand(value, root)?);
            } else if value.is_null() {
                cmd.env_remove(name);
            }
        }
    }
    for (name, value) in &profile.env {
        if let Some(value) = value {
            cmd.env(name, profiles::expand(value, root)?);
        } else {
            cmd.env_remove(name);
        }
    }
    if profile.kind == "cmd" && integration {
        let prompt = std::env::var("PROMPT").unwrap_or_else(|_| "$P$G".into());
        cmd.env("PROMPT", format!("$E]9;9;\"$P\"$E\\{prompt}"));
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "LiteCode");
    cmd.env("CHERE_INVOKING", "1");
    cmd.env("LITECODE_INITIAL_CWD", cwd.as_os_str());
    cmd.cwd(cwd);
    Ok((cmd, integration))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri binds these named IPC arguments individually.
pub async fn terminal_create(
    window: WebviewWindow,
    state: State<'_, AppState>,
    profile: Option<String>,
    source: Option<String>,
    cwd: Option<String>,
    expected_root: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel,
    on_event: Channel<Event>,
) -> Result<Created> {
    let root = state.require_workspace_trust(window.label())?;
    let expected = expected_root
        .map(PathBuf::from)
        .map(std::fs::canonicalize)
        .transpose()?;
    if root != expected {
        return Err(AppError::new(
            "workspace",
            "Workspace changed before starting terminal",
        ));
    }
    let epoch = state
        .windows
        .lock()
        .unwrap()
        .get(window.label())
        .map(|w| w.workspace_session)
        .unwrap_or(0);
    let settings = tools::settings(&window, &state);
    let source = source
        .as_deref()
        .map(|id| state.terminals.get(window.label(), id))
        .transpose()?;
    let selected = if let Some(source) = &source {
        source.profile.clone()
    } else {
        let profiles = profiles::detect(&settings, root.as_deref())?;
        let name = profile
            .as_deref()
            .or_else(|| settings["terminal.integrated.defaultProfile.windows"].as_str());
        name.map(|name| profiles.iter().find(|p| p.name == name))
            .unwrap_or_else(|| profiles.first())
            .cloned()
            .ok_or_else(|| {
                AppError::new(
                    "terminalProfile",
                    "The selected shell profile is unavailable",
                )
            })?
    };
    let cwd = if let Some(source) = source {
        match settings["terminal.integrated.splitCwd"]
            .as_str()
            .unwrap_or("inherited")
        {
            "initial" => source.initial_cwd.clone(),
            "workspaceRoot" => root
                .as_deref()
                .map(tools::process_path)
                .unwrap_or_else(profiles::home),
            _ => source.cwd.lock().unwrap().clone(),
        }
    } else if let Some(cwd) = cwd {
        let path = PathBuf::from(cwd);
        if !path.is_absolute() || !path.is_dir() {
            return Err(AppError::new(
                "terminalCwd",
                "Terminal directory is invalid",
            ));
        }
        tools::process_path(&std::fs::canonicalize(path)?)
    } else {
        profiles::directory(&settings, root.as_deref())?
    };
    if !cwd.is_dir() {
        return Err(AppError::new(
            "terminalCwd",
            format!("Terminal directory no longer exists: {}", cwd.display()),
        ));
    }
    let size = size(cols, rows)?;
    let owner = window.label().to_string();
    let data_dir = state.data_dir.clone();
    let created = tauri::async_runtime::spawn_blocking(move || -> Result<_> {
        let (cmd, integration) =
            build_command(&selected, &settings, root.as_deref(), &cwd, &data_dir)?;
        let pair = portable_pty::native_pty_system()
            .openpty(size)
            .map_err(pty_error)?;
        let mut child = pair.slave.spawn_command(cmd).map_err(pty_error)?;
        #[cfg(windows)]
        let job = match child
            .process_id()
            .ok_or_else(|| pty_error("Shell has no process ID"))
            .and_then(Job::new)
        {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                return Err(error);
            }
        };
        let reader = pair.master.try_clone_reader().map_err(pty_error)?;
        let mut writer = pair.master.take_writer().map_err(pty_error)?;
        let flow = Arc::new(Flow::default());
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(64);
        let session = Arc::new(Session {
            owner,
            profile: selected.clone(),
            cwd: Mutex::new(cwd.clone()),
            initial_cwd: cwd.clone(),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(tx)),
            killer: Mutex::new(child.clone_killer()),
            flow: flow.clone(),
            closed: AtomicBool::new(false),
            events: on_event.clone(),
            #[cfg(windows)]
            job,
        });
        drop(pair.slave);
        let write_flow = flow.clone();
        let write_events = on_event.clone();
        std::thread::spawn(move || {
            for bytes in rx {
                if write_flow.closed.load(Ordering::Acquire) {
                    break;
                }
                if let Err(error) = writer.write_all(&bytes).and_then(|_| writer.flush()) {
                    if !write_flow.closed.load(Ordering::Acquire) {
                        let _ = write_events.send(Event {
                            kind: "error".into(),
                            exit_code: None,
                            error: Some(error.to_string()),
                        });
                    }
                    break;
                }
            }
        });
        let id = format!("terminal-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
        let result = Created {
            id: id.clone(),
            profile: selected,
            cwd: cwd.to_string_lossy().into_owned(),
            integration,
            pid: child.process_id(),
            windows_build: windows_build(),
        };
        Ok((
            id, result, session, reader, child, flow, on_output, on_event,
        ))
    })
    .await
    .map_err(pty_error)??;
    let (id, result, session, mut reader, mut child, flow, output, events) = created;
    {
        // Serialize installation with trust revocation and workspace replacement.
        let _disk = state.disk_lock.lock().unwrap();
        if let Err(error) = state.require_workspace_trust(window.label()) {
            session.close();
            return Err(error);
        }
        let windows = state.windows.lock().unwrap();
        if !windows
            .get(window.label())
            .is_some_and(|w| w.workspace_session == epoch && w.root.as_ref() == expected.as_ref())
        {
            session.close();
            return Err(AppError::new(
                "workspace",
                "Workspace changed while starting terminal",
            ));
        }
        state
            .terminals
            .sessions
            .lock()
            .unwrap()
            .insert(id, session.clone());
    }
    let (status_tx, status_rx) = mpsc::channel();
    let exit_session = session.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        let _ = status_tx.send(status);
        #[cfg(windows)]
        exit_session.job.terminate();
        // ConPTY's output pipe reaches EOF only after closing the pseudoconsole.
        let master = exit_session.master.lock().unwrap().take();
        drop(master);
        exit_session.writer.lock().unwrap().take();
    });
    std::thread::spawn(move || {
        let mut buffer = [0; 16 * 1024];
        let mut error = None;
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if !flow.reserve(count) {
                        break;
                    }
                    if output
                        .send(InvokeResponseBody::Raw(buffer[..count].to_vec()))
                        .is_err()
                    {
                        session.close();
                        break;
                    }
                }
                Err(e) => {
                    error = Some(e.to_string());
                    break;
                }
            }
        }
        if flow.closed.load(Ordering::Acquire) {
            session.close();
        }
        let status = status_rx
            .recv()
            .unwrap_or_else(|_| Err(std::io::Error::other("Shell waiter stopped")));
        if flow.drained() {
            let _ = events.send(Event {
                kind: "exit".into(),
                exit_code: status.as_ref().ok().map(|s| s.exit_code()),
                error: status.err().map(|e| e.to_string()).or(error),
            });
        }
    });
    Ok(result)
}

#[tauri::command]
pub async fn terminal_write(
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    data: Vec<u8>,
) -> Result<()> {
    if data.len() > 64 * 1024 {
        return Err(AppError::new(
            "terminalInput",
            "Terminal input chunk is too large",
        ));
    }
    let session = state.terminals.get(window.label(), &id)?;
    let writer = session
        .writer
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| pty_error("Terminal input is closed"))?;
    tauri::async_runtime::spawn_blocking(move || writer.send(data).map_err(pty_error))
        .await
        .map_err(pty_error)?
}

#[tauri::command]
pub fn terminal_resize(
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let size = size(cols, rows)?;
    let session = state.terminals.get(window.label(), &id)?;
    let master = session.master.lock().unwrap();
    master
        .as_ref()
        .ok_or_else(|| pty_error("Terminal is closed"))?
        .resize(size)
        .map_err(pty_error)
}
#[tauri::command]
pub fn terminal_ack(
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    bytes: usize,
) -> Result<()> {
    state.terminals.get(window.label(), &id)?.flow.ack(bytes)
}
#[tauri::command]
pub fn terminal_close(window: WebviewWindow, state: State<'_, AppState>, id: String) -> Result<()> {
    let mut sessions = state.terminals.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&id)
        && session.owner != window.label()
    {
        return Err(pty_error("Terminal belongs to another window"));
    }
    let removed = sessions.remove(&id);
    drop(sessions);
    if let Some(session) = removed {
        session.close();
    }
    Ok(())
}
#[tauri::command]
pub fn terminal_update_cwd(
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    cwd: String,
) -> Result<()> {
    let session = state.terminals.get(window.label(), &id)?;
    let path = PathBuf::from(cwd);
    if !path.is_absolute() || !path.is_dir() {
        return Err(AppError::new(
            "terminalCwd",
            "Shell reported an invalid local directory",
        ));
    }
    *session.cwd.lock().unwrap() = tools::process_path(&std::fs::canonicalize(path)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flow_is_bounded_acknowledged_and_cancelable() {
        let flow = Arc::new(Flow::default());
        assert!(flow.reserve(OUTPUT_WINDOW));
        assert!(flow.ack(OUTPUT_WINDOW + 1).is_err());
        let waiter = flow.clone();
        let thread = std::thread::spawn(move || waiter.reserve(1));
        flow.close();
        assert!(!thread.join().unwrap());
        assert!(flow.ack(OUTPUT_WINDOW).is_ok());
    }
    #[test]
    fn invalid_sizes_are_rejected() {
        assert!(size(0, 10).is_err());
        assert!(size(1001, 10).is_err());
        assert!(size(80, 24).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn store_powershell_alias_can_build_a_command() {
        let Some(local) = std::env::var_os("LOCALAPPDATA") else {
            return;
        };
        let alias = PathBuf::from(local).join("Microsoft/WindowsApps/pwsh.exe");
        if !alias.is_file() {
            return;
        }
        let profile = profiles::Profile {
            name: "Store PowerShell".into(),
            path: alias.to_string_lossy().into_owned(),
            args: vec![],
            env: Default::default(),
            kind: "powershell".into(),
        };
        let dir = tempfile::tempdir().unwrap();
        build_command(
            &profile,
            &serde_json::json!({}),
            None,
            dir.path(),
            dir.path(),
        )
        .unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn cmd_runs_inside_a_real_pseudoconsole() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("中文;space");
        std::fs::create_dir(&cwd).unwrap();
        let profile = profiles::detect(&serde_json::json!({}), Some(&cwd))
            .unwrap()
            .into_iter()
            .find(|p| p.kind == "cmd")
            .unwrap();
        let (command, _) = build_command(
            &profile,
            &serde_json::json!({}),
            Some(&cwd),
            &cwd,
            dir.path(),
        )
        .unwrap();
        let pair = portable_pty::native_pty_system()
            .openpty(size(80, 24).unwrap())
            .unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = [0; 4096];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 {
                    break;
                }
                if tx.send(bytes[..count].to_vec()).is_err() {
                    break;
                }
            }
        });
        writer.write_all(b"\x1b[1;1R").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        writer.write_all(b"echo PTY_NATIVE_MARKER\r").unwrap();
        let end = std::time::Instant::now() + std::time::Duration::from_secs(4);
        let mut output = String::new();
        while std::time::Instant::now() < end {
            if let Ok(bytes) = rx.recv_timeout(std::time::Duration::from_millis(100)) {
                output.push_str(&String::from_utf8_lossy(&bytes));
                if output.contains("PTY_NATIVE_MARKER") {
                    break;
                }
            }
        }
        let _ = child.kill();
        drop(pair);
        assert!(
            output.contains("PTY_NATIVE_MARKER"),
            "cmd output: {output:?}"
        );
    }
}
