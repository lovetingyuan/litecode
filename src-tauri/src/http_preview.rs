use crate::{
    error::{AppError, Result},
    state::AppState,
    sync::{MutexExt, RwLockExt},
};
use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    net::{Ipv4Addr, TcpListener},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager, WebviewWindow};
use tokio::sync::oneshot;
use tower_http::services::ServeDir;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    id: u64,
    root: String,
    port: u16,
    url: String,
}

#[derive(Clone, Serialize)]
pub struct Snapshot {
    revision: u64,
    services: Vec<ServiceInfo>,
}

#[derive(Serialize)]
pub struct Started {
    snapshot: Snapshot,
    url: String,
}

struct Server {
    info: ServiceInfo,
    root: PathBuf,
    stop: Option<oneshot::Sender<()>>,
    done: oneshot::Receiver<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

#[derive(Default)]
struct Registry {
    revision: u64,
    next_id: u64,
    windows: HashMap<String, Vec<Server>>,
}

impl Registry {
    fn snapshot(&self, label: &str) -> Snapshot {
        Snapshot {
            revision: self.revision,
            services: self
                .windows
                .get(label)
                .into_iter()
                .flatten()
                .map(|s| s.info.clone())
                .collect(),
        }
    }
}

#[derive(Clone, Default)]
pub struct Service(Arc<Mutex<Registry>>);

#[derive(Clone)]
struct HttpRoot {
    directory: PathBuf,
    authority: String,
}

impl HttpRoot {
    fn allows_host(&self, host: Option<&str>) -> bool {
        host == Some(self.authority.as_str())
            || (self.authority == "127.0.0.1:80" && host == Some("127.0.0.1"))
    }
}

impl Service {
    pub fn snapshot(&self, label: &str) -> Snapshot {
        self.0.lock_recover().snapshot(label)
    }

    fn start(
        &self,
        label: &str,
        path: &Path,
        port: u16,
        changed: impl Fn(Snapshot) + Send + 'static,
    ) -> Result<Started> {
        let root = path
            .parent()
            .ok_or_else(|| AppError::new("path", "HTML file has no parent directory."))?;
        let mut registry = self.0.lock_recover();
        if let Some(server) = registry
            .windows
            .get_mut(label)
            .into_iter()
            .flatten()
            .find(|s| s.root == root)
        {
            let url = file_url(&server.info.url, path)?;
            if server.info.url != url {
                server.info.url = url.clone();
                registry.revision += 1;
            }
            return Ok(Started {
                url,
                snapshot: registry.snapshot(label),
            });
        }
        let listener = bind(port)?;
        let port = listener.local_addr()?.port();
        listener.set_nonblocking(true)?;
        registry.next_id += 1;
        let id = registry.next_id;
        let mut info = ServiceInfo {
            id,
            root: crate::tools::process_path(root)
                .to_string_lossy()
                .into_owned(),
            port,
            url: format!("http://127.0.0.1:{port}/"),
        };
        let url = file_url(&info.url, path)?;
        info.url = url.clone();
        let (stop, stopped) = oneshot::channel();
        let (done, finished) = oneshot::channel();
        registry
            .windows
            .entry(label.into())
            .or_default()
            .push(Server {
                info,
                root: root.into(),
                stop: Some(stop),
                done: finished,
            });
        registry.revision += 1;
        let snapshot = registry.snapshot(label);
        let service = self.clone();
        let label = label.to_owned();
        let root = root.to_owned();
        tauri::async_runtime::spawn(async move {
            let result = async {
                let listener = tokio::net::TcpListener::from_std(listener)?;
                let router = Router::new().fallback(serve).with_state(HttpRoot {
                    directory: root,
                    authority: format!("127.0.0.1:{port}"),
                });
                axum::serve(listener, router)
                    .with_graceful_shutdown(async {
                        let _ = stopped.await;
                    })
                    .await
            }
            .await;
            if let Err(error) = result {
                eprintln!("HTML preview server failed: {error}");
            }
            let (removed, snapshot) = service.remove(&label, Some(id));
            if !removed.is_empty() {
                changed(snapshot);
            }
            let _ = done.send(());
        });
        Ok(Started { snapshot, url })
    }

    fn remove(&self, label: &str, id: Option<u64>) -> (Vec<Server>, Snapshot) {
        let mut registry = self.0.lock_recover();
        let mut removed = Vec::new();
        if let Some(servers) = registry.windows.get_mut(label) {
            let mut index = 0;
            while index < servers.len() {
                if id.is_none_or(|id| servers[index].info.id == id) {
                    removed.push(servers.remove(index));
                } else {
                    index += 1;
                }
            }
            if servers.is_empty() {
                registry.windows.remove(label);
            }
        }
        if !removed.is_empty() {
            registry.revision += 1;
        }
        let snapshot = registry.snapshot(label);
        (removed, snapshot)
    }

    pub fn close_window(&self, label: &str) -> Snapshot {
        let (_, snapshot) = self.remove(label, None);
        snapshot
    }
}

fn bind(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).or_else(|error| {
        if port == 0 {
            Err(error)
        } else {
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        }
    })
}

fn file_url(base: &str, path: &Path) -> Result<String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::new("path", "Invalid HTML filename."))?;
    let mut url = url::Url::parse(base).map_err(|e| AppError::new("url", e.to_string()))?;
    url.path_segments_mut()
        .map_err(|_| AppError::new("url", "Invalid preview URL."))?
        .clear()
        .push(name);
    Ok(url.into())
}

fn html_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm"))
}

async fn checked_path(root: &Path, uri_path: &str) -> std::result::Result<(), StatusCode> {
    let decoded = percent_encoding::percent_decode_str(uri_path)
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let mut path = root.to_owned();
    for segment in decoded
        .trim_start_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
    {
        if segment.contains(['\\', ':', '\0'])
            || !matches!(
                Path::new(segment).components().next(),
                Some(Component::Normal(_))
            )
        {
            return Err(StatusCode::NOT_FOUND);
        }
        path.push(segment);
    }
    let mut target = tokio::fs::canonicalize(path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if !target.starts_with(root) {
        return Err(StatusCode::NOT_FOUND);
    }
    if tokio::fs::metadata(&target)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?
        .is_dir()
    {
        target = tokio::fs::canonicalize(target.join("index.html"))
            .await
            .map_err(|_| StatusCode::NOT_FOUND)?;
        if !target.starts_with(root) {
            return Err(StatusCode::NOT_FOUND);
        }
    }
    Ok(())
}

async fn serve(State(root): State<HttpRoot>, request: Request) -> Response {
    // Reject foreign hostnames so DNS rebinding cannot expose the served directory.
    let mut response = if !root.allows_host(
        request
            .headers()
            .get(header::HOST)
            .and_then(|value| value.to_str().ok()),
    ) {
        StatusCode::FORBIDDEN.into_response()
    } else if request.method() != axum::http::Method::GET
        && request.method() != axum::http::Method::HEAD
    {
        StatusCode::METHOD_NOT_ALLOWED.into_response()
    } else if let Err(status) = checked_path(&root.directory, request.uri().path()).await {
        status.into_response()
    } else {
        match ServeDir::new(root.directory).try_call(request).await {
            Ok(response) => response.map(Body::new),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}

#[tauri::command]
pub async fn html_preview_start(window: WebviewWindow, path: String) -> Result<Started> {
    let context = {
        let state = window.state::<AppState>();
        let windows = state.windows.lock_recover();
        let current = windows
            .get(window.label())
            .ok_or_else(|| AppError::new("window", "Window is not initialized."))?;
        (current.root.clone(), current.workspace_session)
    };
    crate::state::blocking(window, move |window, state| {
        let _disk = state.disk_lock.read_recover();
        let path = state.authorize(window.label(), &path)?;
        if !html_file(&path) || !path.is_file() {
            return Err(AppError::new(
                "path",
                "Save the document as an HTML file before previewing.",
            ));
        }
        std::fs::File::open(&path)?;
        let port = crate::tools::settings(&window, state)["html.preview.port"]
            .as_u64()
            .and_then(|p| u16::try_from(p).ok())
            .unwrap_or(0);
        let windows = state.windows.lock_recover();
        let current = windows
            .get(window.label())
            .ok_or_else(|| AppError::new("window", "Window was closed."))?;
        if (current.root.clone(), current.workspace_session) != context {
            return Err(AppError::new(
                "workspace",
                "Workspace changed before HTML preview started.",
            ));
        }
        let target = window.clone();
        let started = state
            .http_previews
            .start(window.label(), &path, port, move |snapshot| {
                let _ = target.emit("html-preview-changed", snapshot);
            })?;
        let _ = window.emit("html-preview-changed", &started.snapshot);
        Ok(started)
    })
    .await
}

#[tauri::command]
pub fn html_preview_list(window: WebviewWindow, state: tauri::State<'_, AppState>) -> Snapshot {
    state.http_previews.snapshot(window.label())
}

#[tauri::command]
pub async fn html_preview_stop(window: WebviewWindow, id: u64) -> Snapshot {
    let (servers, snapshot) = window
        .state::<AppState>()
        .http_previews
        .remove(window.label(), Some(id));
    for mut server in servers {
        if let Some(stop) = server.stop.take() {
            let _ = stop.send(());
        }
        // Shutdown closes the listener immediately; give in-flight responses time to finish.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), &mut server.done).await;
    }
    let _ = window.emit("html-preview-changed", &snapshot);
    snapshot
}

#[cfg(test)]
#[path = "http_preview_tests.rs"]
mod tests;
