use crate::error::{AppError, Result};
use serde::Serialize;
use std::{
    collections::HashSet,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Notify;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Checking,
    Current,
    Available,
    Downloading,
    Preparing,
    Installing,
    Error,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    phase: Phase,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    error: Option<String>,
    portable: bool,
    request_id: Option<u64>,
}

struct Barrier {
    id: u64,
    pending: HashSet<String>,
    failure: Option<String>,
}
impl Barrier {
    fn acknowledge(&mut self, id: u64, label: &str, error: Option<String>) -> bool {
        if self.id != id || !self.pending.remove(label) {
            return false;
        }
        if let Some(error) = error {
            self.failure = Some(format!("{label}: {error}"));
        }
        true
    }
    fn result(&self) -> Result<bool> {
        if let Some(error) = &self.failure {
            return Err(AppError::new("updateBackup", error));
        }
        Ok(self.pending.is_empty())
    }
}

struct Inner {
    snapshot: Snapshot,
    update: Option<Update>,
    barrier: Option<Barrier>,
}
pub struct Updates {
    pub window_gate: Mutex<()>,
    inner: Mutex<Inner>,
    operation: tokio::sync::Mutex<()>,
    started: AtomicBool,
    notify: Notify,
}

impl Updates {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            window_gate: Mutex::new(()),
            inner: Mutex::new(Inner {
                snapshot: Snapshot {
                    revision: 0,
                    phase: Phase::Idle,
                    current_version: app.package_info().version.to_string(),
                    version: None,
                    notes: None,
                    downloaded: 0,
                    total: None,
                    error: None,
                    portable: std::env::current_exe()
                        .ok()
                        .and_then(|p| p.parent().map(|p| p.join("data").is_dir()))
                        .unwrap_or(false),
                    request_id: None,
                },
                update: None,
                barrier: None,
            }),
            operation: Default::default(),
            started: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }
    fn snapshot(&self) -> Snapshot {
        self.inner.lock().unwrap().snapshot.clone()
    }
    fn publish(&self, app: &AppHandle, change: impl FnOnce(&mut Snapshot)) -> Snapshot {
        let snapshot = {
            let mut inner = self.inner.lock().unwrap();
            change(&mut inner.snapshot);
            inner.snapshot.revision += 1;
            inner.snapshot.clone()
        };
        let _ = app.emit("update-state", &snapshot);
        snapshot
    }
    pub fn ensure_interactive(&self) -> Result<()> {
        if matches!(self.snapshot().phase, Phase::Preparing | Phase::Installing) {
            return Err(AppError::new(
                "updateBusy",
                "An update is preparing to install. Please wait.",
            ));
        }
        Ok(())
    }
    pub fn window_destroyed(&self, label: &str) {
        if let Some(barrier) = &mut self.inner.lock().unwrap().barrier {
            if barrier.pending.contains(label) {
                barrier.failure = Some(format!(
                    "Window {label} closed before its update backup completed"
                ));
                self.notify.notify_one();
            }
        }
    }
    fn fail(&self, app: &AppHandle, error: &AppError) {
        self.inner.lock().unwrap().barrier = None;
        self.publish(app, |s| {
            s.phase = Phase::Error;
            s.error = Some(error.message.clone());
            s.request_id = None;
        });
    }
    async fn prepare(&self, app: &AppHandle) -> Result<()> {
        let id = {
            let _window_gate = self.window_gate.lock().unwrap();
            let mut inner = self.inner.lock().unwrap();
            let id = inner.snapshot.revision + 1;
            inner.snapshot.phase = Phase::Preparing;
            inner.snapshot.request_id = Some(id);
            inner.barrier = Some(Barrier {
                id,
                pending: app.webview_windows().into_keys().collect(),
                failure: None,
            });
            id
        };
        self.publish(app, |s| {
            s.phase = Phase::Preparing;
            s.request_id = Some(id);
        });
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let notified = self.notify.notified();
                if self
                    .inner
                    .lock()
                    .unwrap()
                    .barrier
                    .as_ref()
                    .ok_or_else(|| AppError::new("updateBackup", "Update backup was cancelled"))?
                    .result()?
                {
                    return Ok(());
                }
                notified.await;
            }
        })
        .await
        .map_err(|_| {
            AppError::new(
                "updateBackup",
                "Timed out saving all editor windows. The update was not installed.",
            )
        })?
    }
}

#[tauri::command]
pub fn get_update_state(state: State<'_, Updates>) -> Snapshot {
    state.snapshot()
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, Updates>,
    background: bool,
) -> Result<Snapshot> {
    if background && state.started.swap(true, Ordering::AcqRel) {
        return Ok(state.snapshot());
    }
    state.started.store(true, Ordering::Release);
    let _operation = match state.operation.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            let _wait = state.operation.lock().await;
            return Ok(state.snapshot());
        }
    };
    state.publish(&app, |s| {
        s.phase = Phase::Checking;
        s.error = None;
    });
    let result = async {
        let cleanup_app = app.clone();
        let builder = app
            .updater_builder()
            .on_before_exit(move || {
                let state = cleanup_app.state::<crate::state::AppState>();
                for label in cleanup_app.webview_windows().keys() {
                    state.terminals.close_window(label);
                }
                for (_, server) in state.servers.lock().unwrap().drain() {
                    crate::lsp::kill_tree(server.pid);
                }
                cleanup_app.cleanup_before_exit();
            })
            .timeout(Duration::from_secs(600))
            .version_comparator(|current, release| {
                release.version.pre.is_empty() && release.version > current
            });
        // Only debug builds can point verification at a loopback fixture server.
        #[cfg(debug_assertions)]
        let builder = if let Ok(endpoint) = std::env::var("LITECODE_UPDATE_TEST_ENDPOINT") {
            let endpoint = url::Url::parse(&endpoint).map_err(update_error)?;
            if endpoint.scheme() != "http"
                || !matches!(endpoint.host_str(), Some("127.0.0.1" | "localhost"))
            {
                return Err(AppError::new(
                    "update",
                    "Update test endpoint must use loopback HTTP",
                ));
            }
            builder
                .endpoints(vec![endpoint])
                .map_err(update_error)?
                .no_proxy()
        } else {
            builder
        };
        let updater = builder.build().map_err(update_error)?;
        let update = tokio::time::timeout(Duration::from_secs(20), updater.check())
            .await
            .map_err(|_| {
                AppError::new(
                    "update",
                    "Could not check for updates within 20 seconds. Please retry.",
                )
            })?
            .map_err(update_error)?;
        let mut inner = state.inner.lock().unwrap();
        inner.update = update;
        let version = inner.update.as_ref().map(|u| u.version.clone());
        let notes = inner.update.as_ref().and_then(|u| u.body.clone());
        drop(inner);
        Ok(state.publish(&app, |s| {
            s.phase = if version.is_some() {
                Phase::Available
            } else {
                Phase::Current
            };
            s.version = version;
            s.notes = notes;
            s.downloaded = 0;
            s.total = None;
        }))
    }
    .await;
    if let Err(error) = &result {
        state.fail(&app, error);
    }
    result
}

fn update_error(error: impl std::fmt::Display) -> AppError {
    AppError::new(
        "update",
        format!(
            "{error}. Check your connection and that the latest official Release includes latest.json and a signed Windows x64 installer."
        ),
    )
}

#[tauri::command]
pub fn ack_update_checkpoint(
    window: WebviewWindow,
    state: State<'_, Updates>,
    request_id: u64,
    error: Option<String>,
) {
    if let Some(barrier) = &mut state.inner.lock().unwrap().barrier {
        if barrier.acknowledge(request_id, window.label(), error) {
            state.notify.notify_one();
        }
    }
}

#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, Updates>) -> Result<()> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| AppError::new("updateBusy", "An update operation is already running."))?;
    let update = {
        let inner = state.inner.lock().unwrap();
        if inner.snapshot.portable {
            return Err(AppError::new(
                "portable",
                "Download the portable release from GitHub and keep your data directory.",
            ));
        }
        inner
            .update
            .clone()
            .ok_or_else(|| AppError::new("update", "Check for an update before installing."))?
    };
    state.publish(&app, |s| {
        s.phase = Phase::Downloading;
        s.downloaded = 0;
        s.total = None;
        s.error = None;
    });
    let result = async {
        let mut downloaded = 0;
        let mut last_event = Instant::now() - Duration::from_secs(1);
        let bytes = update
            .download(
                |chunk, total| {
                    downloaded += chunk as u64;
                    if last_event.elapsed() >= Duration::from_millis(100) {
                        state.publish(&app, |s| {
                            s.downloaded = downloaded;
                            s.total = total;
                        });
                        last_event = Instant::now();
                    }
                },
                || {},
            )
            .await
            .map_err(update_error)?;
        state.publish(&app, |s| {
            s.downloaded = bytes.len() as u64;
        });
        state.prepare(&app).await?;
        state.publish(&app, |s| {
            s.phase = Phase::Installing;
        });
        // Windows updater launches NSIS, cleans up the app, and exits the process.
        update.install(bytes).map_err(update_error)?;
        #[cfg(not(windows))]
        app.restart();
        Ok(())
    }
    .await;
    if let Err(error) = &result {
        state.fail(&app, error);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn barrier() -> Barrier {
        Barrier {
            id: 7,
            pending: ["main".into(), "editor-1".into()].into(),
            failure: None,
        }
    }
    #[test]
    fn all_windows_must_confirm_the_current_request() {
        let mut b = barrier();
        assert!(!b.acknowledge(6, "main", None));
        assert!(!b.acknowledge(7, "unknown", None));
        assert!(b.acknowledge(7, "main", None));
        assert!(!b.acknowledge(7, "main", None));
        assert!(!b.result().unwrap());
        assert!(b.acknowledge(7, "editor-1", None));
        assert!(b.result().unwrap());
    }
    #[test]
    fn any_backup_failure_prevents_installation() {
        let mut b = barrier();
        b.acknowledge(7, "main", Some("Disk full".into()));
        assert!(b.result().unwrap_err().message.contains("Disk full"));
    }
}
