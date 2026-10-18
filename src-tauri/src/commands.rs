use crate::{
    configuration::read_json,
    error::{AppError, Result},
    files::{self, DiskDocument},
    state::{AppState, Mirror, canonical},
    workspace,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

fn visible_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    s.strip_prefix("\\\\?\\").unwrap_or(&s).to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub root: Option<String>,
    pub documents: Vec<Mirror>,
    pub session: serde_json::Value,
    pub recent: Vec<String>,
    pub settings: serde_json::Value,
    pub keybindings: serde_json::Value,
    pub warnings: Vec<String>,
    pub data_dir: String,
}

pub fn recent(state: &AppState) -> Vec<String> {
    serde_json::from_value(read_json(&state.data_dir.join("recent.json"), &mut vec![]))
        .unwrap_or_default()
}

pub fn remember(state: &AppState, path: &str) -> Result<()> {
    let mut paths = recent(state);
    paths.retain(|p| p != path);
    paths.insert(0, path.into());
    paths.truncate(30);
    files::atomic_write(
        &state.data_dir.join("recent.json"),
        &serde_json::to_vec(&paths)?,
    )
}

#[tauri::command]
pub async fn bootstrap(window: WebviewWindow, state: State<'_, AppState>) -> Result<Bootstrap> {
    // A reloaded WebView cannot acknowledge its old Channels.
    for (key, task) in state.searches.lock().unwrap().iter() {
        if key.starts_with(&format!("{}/", window.label())) {
            task.cancelled
                .store(true, std::sync::atomic::Ordering::Release);
        }
    }
    let mut warnings = vec![];
    let value = read_json(
        &state
            .data_dir
            .join(format!("session-{}.json", window.label())),
        &mut warnings,
    );
    {
        let mut windows = state.windows.lock().unwrap();
        let w = windows.entry(window.label().into()).or_default();
        if w.session.is_null() {
            w.root = w.root.clone().or_else(|| {
                value["root"]
                    .as_str()
                    .and_then(|p| canonical(Path::new(p)).ok())
                    .filter(|p| p.is_dir())
            });
            w.session = value["session"].clone();
            let docs: Vec<Mirror> =
                serde_json::from_value(value["documents"].clone()).unwrap_or_default();
            for d in docs {
                if let Some(path) = &d.path
                    && let Ok(path) = canonical(Path::new(path))
                {
                    w.grants.insert(path);
                }
                w.documents.insert(d.id.clone(), d);
            }
        }
    }
    let root = state
        .windows
        .lock()
        .unwrap()
        .get(window.label())
        .and_then(|w| w.root.clone());
    let needs_watcher = state
        .windows
        .lock()
        .unwrap()
        .get(window.label())
        .is_none_or(|w| w.watcher.is_none());
    if needs_watcher
        && let Some(root) = &root
        && let Err(e) = workspace::watch(window.app_handle(), window.label(), root.clone())
    {
        warnings.push(e.message);
    }
    let settings = crate::configuration::load_settings(
        &state.data_dir.join("settings.json"),
        root.as_deref(),
        &mut warnings,
    );
    let windows = state.windows.lock().unwrap();
    let w = windows.get(window.label()).unwrap();
    Ok(Bootstrap {
        root: root.as_deref().map(visible_path),
        documents: w.documents.values().cloned().collect(),
        session: w.session.clone(),
        recent: recent(&state),
        settings,
        keybindings: read_json(&state.data_dir.join("keybindings.json"), &mut warnings),
        warnings,
        data_dir: visible_path(&state.data_dir),
    })
}

#[tauri::command]
pub async fn pick_path(
    window: WebviewWindow,
    state: State<'_, AppState>,
    kind: String,
) -> Result<Option<String>> {
    let app = window.app_handle().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file();
        match kind.as_str() {
            "folder" => dialog.blocking_pick_folder(),
            "save" => dialog.blocking_save_file(),
            _ => dialog.blocking_pick_file(),
        }
    })
    .await
    .map_err(|e| AppError::new("dialog", e.to_string()))?;
    result
        .map(|p| {
            let path = p
                .into_path()
                .map_err(|e| AppError::new("path", e.to_string()))?;
            state.grant(window.label(), &path).map(|p| visible_path(&p))
        })
        .transpose()
}

#[tauri::command]
pub async fn open_workspace(
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: String,
    new_window: bool,
) -> Result<bool> {
    let root = canonical(Path::new(&path))?;
    if !root.is_dir() {
        return Err(AppError::new("path", "Not a directory"));
    }
    let known = recent(&state)
        .iter()
        .any(|p| canonical(Path::new(p)).ok().as_ref() == Some(&root));
    let allowed = state.authorize(window.label(), &path).is_ok();
    if !known && !allowed {
        return Err(AppError::new(
            "access",
            "Select the directory with Open Folder first",
        ));
    }
    {
        let windows = state.windows.lock().unwrap();
        if let Some((label, _)) = windows.iter().find(|(_, w)| w.root.as_ref() == Some(&root)) {
            if let Some(existing) = window.app_handle().get_webview_window(label) {
                let _ = existing.set_focus();
            }
            return Ok(label == window.label());
        }
    }
    let _disk = state.disk_lock.lock().unwrap();
    remember(&state, &visible_path(&root))?;
    if new_window {
        let label = format!(
            "editor-{}",
            &files::hash(root.to_string_lossy().as_bytes())[..12]
        );
        state
            .windows
            .lock()
            .unwrap()
            .entry(label.clone())
            .or_default()
            .root = Some(root);
        tauri::WebviewWindowBuilder::new(
            window.app_handle(),
            &label,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("LiteCode")
        .inner_size(1280.0, 820.0)
        .min_inner_size(700.0, 420.0)
        .decorations(false)
        .build()
        .map_err(|e| AppError::new("window", e.to_string()))?;
        Ok(false)
    } else {
        state.checkpoint(window.label())?;
        let mut windows = state.windows.lock().unwrap();
        let w = windows.entry(window.label().into()).or_default();
        for doc in w.documents.values() {
            if let Some(path) = &doc.path
                && let Ok(path) = canonical(Path::new(path))
            {
                w.grants.insert(path);
            }
        }
        w.root = Some(root.clone());
        drop(windows);
        workspace::watch(window.app_handle(), window.label(), root)?;
        Ok(true)
    }
}

#[tauri::command]
pub async fn scan_workspace(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<workspace::TreeSnapshot> {
    let root = state
        .windows
        .lock()
        .unwrap()
        .get(window.label())
        .and_then(|w| w.root.clone())
        .ok_or_else(|| AppError::new("workspace", "No folder is open"))?;
    tauri::async_runtime::spawn_blocking(move || workspace::scan(&root))
        .await
        .map_err(|e| AppError::new("scan", e.to_string()))?
}

#[tauri::command]
pub async fn read_document(
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: String,
    force: Option<bool>,
    encoding: Option<String>,
) -> Result<DiskDocument> {
    let path = state.authorize(window.label(), &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        files::read(&path, force.unwrap_or(false), encoding.as_deref())
    })
    .await
    .map_err(|e| AppError::new("read", e.to_string()))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri binds these named IPC arguments individually.
pub async fn save_document(
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    version: u64,
    path: String,
    text: String,
    encoding: String,
    revision: Option<String>,
) -> Result<String> {
    let path = state.authorize(window.label(), &path)?;
    let _disk = state.disk_lock.lock().unwrap();
    {
        let windows = state.windows.lock().unwrap();
        let mirror = windows
            .get(window.label())
            .and_then(|w| w.documents.get(&id));
        if mirror.is_some_and(|m| m.version > version) {
            return Err(AppError::new(
                "stale",
                "The document changed while saving. Save again.",
            ));
        }
    }
    let revision = files::save(&path, &text, &encoding, revision.as_deref())?;
    if matches!(
        path.file_name().and_then(|s| s.to_str()),
        Some("settings.json" | "keybindings.json")
    ) {
        let _ = window.app_handle().emit("configuration-changed", ());
    }
    if let Some(m) = state
        .windows
        .lock()
        .unwrap()
        .get_mut(window.label())
        .and_then(|w| w.documents.get_mut(&id))
    {
        m.path = Some(visible_path(&path));
        m.revision = Some(revision.clone());
        m.dirty = m.version != version;
    }
    Ok(revision)
}

#[tauri::command]
pub fn configuration(window: WebviewWindow, state: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({ "settings": crate::tools::settings(&window, &state), "keybindings": read_json(&state.data_dir.join("keybindings.json"), &mut vec![]) })
}

#[tauri::command]
pub async fn sync_documents(
    window: WebviewWindow,
    state: State<'_, AppState>,
    documents: Vec<Mirror>,
    session: serde_json::Value,
) -> Result<()> {
    for doc in &documents {
        if let Some(path) = &doc.path {
            state.authorize(window.label(), path)?;
        }
        if doc.text.len() > files::MAX_FILE as usize {
            return Err(AppError::new("size", "Backup exceeds the document limit"));
        }
    }
    let _disk = state.disk_lock.lock().unwrap();
    {
        let mut windows = state.windows.lock().unwrap();
        let w = windows.entry(window.label().into()).or_default();
        let ids: std::collections::HashSet<_> = documents.iter().map(|d| d.id.clone()).collect();
        w.documents.retain(|id, _| ids.contains(id));
        for doc in documents {
            if w.documents
                .get(&doc.id)
                .is_none_or(|m| m.version <= doc.version)
            {
                w.documents.insert(doc.id.clone(), doc);
            }
        }
        w.session = session;
    }
    state.checkpoint(window.label())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperation {
    pub kind: String,
    pub path: String,
    pub destination: Option<String>,
}

#[tauri::command]
pub async fn file_operation(
    window: WebviewWindow,
    state: State<'_, AppState>,
    operation: FileOperation,
) -> Result<()> {
    let source = state.authorize(window.label(), &operation.path)?;
    let _disk = state.disk_lock.lock().unwrap();
    if state
        .windows
        .lock()
        .unwrap()
        .get(window.label())
        .and_then(|w| w.root.as_ref())
        .is_some_and(|r| r == &source)
    {
        return Err(AppError::new(
            "workspace",
            "Cannot modify the open workspace root",
        ));
    }
    match operation.kind.as_str() {
        "newFile" => {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(source)?;
        }
        "newFolder" => fs::create_dir(source)?,
        "delete" => trash::delete(&source).map_err(|e| {
            AppError::new(
                "recycle",
                format!("Could not move to Recycle Bin; nothing was permanently deleted: {e}"),
            )
        })?,
        "rename" | "copy" => {
            let destination = operation
                .destination
                .ok_or_else(|| AppError::new("path", "Missing destination"))?;
            let destination = state.authorize(window.label(), &destination)?;
            if destination.exists() {
                return Err(AppError::new("exists", "Destination already exists"));
            }
            if destination.starts_with(&source) {
                return Err(AppError::new(
                    "path",
                    "Cannot move or copy a directory into itself",
                ));
            }
            if operation.kind == "rename" {
                fs::rename(&source, &destination)?;
            } else if source.is_dir() {
                // Validate the entire copy first; do not traverse symlinks outside the granted root.
                let mut entries = vec![];
                for entry in walkdir::WalkDir::new(&source).follow_links(false) {
                    let entry = entry.map_err(|e| AppError::new("copy", e.to_string()))?;
                    if entry.file_type().is_symlink() {
                        return Err(AppError::new(
                            "copy",
                            "Copying symbolic links is not supported; source was preserved.",
                        ));
                    }
                    entries.push((entry.path().to_path_buf(), entry.file_type().is_dir()));
                }
                for (p, directory) in entries {
                    let target = destination.join(p.strip_prefix(&source).unwrap());
                    if directory {
                        fs::create_dir(&target)?;
                    } else {
                        fs::copy(p, target)?;
                    }
                }
            } else {
                fs::copy(source, destination)?;
            }
        }
        _ => return Err(AppError::new("operation", "Unsupported file operation")),
    }
    Ok(())
}

#[tauri::command]
pub async fn reveal_path(
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: String,
) -> Result<()> {
    let path = state.authorize(window.label(), &path)?;
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{}", path.display()))
        .spawn()?;
    Ok(())
}

#[tauri::command]
pub async fn settings_path(
    window: WebviewWindow,
    state: State<'_, AppState>,
    kind: String,
) -> Result<String> {
    let filename = if kind == "keybindings" {
        "keybindings.json"
    } else {
        "settings.json"
    };
    let path = state.data_dir.join(filename);
    let _disk = state.disk_lock.lock().unwrap();
    if !path.exists() {
        files::atomic_write(
            &path,
            if kind == "keybindings" {
                b"[]\n"
            } else {
                b"{}\n"
            },
        )?;
    }
    state.grant(window.label(), &path).map(|p| visible_path(&p))
}

#[tauri::command]
pub async fn explicit_open(
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: String,
) -> Result<String> {
    // This command is used only by the explicit path entry in Quick Open. Remote content has no IPC capability.
    state
        .grant(window.label(), &PathBuf::from(path))
        .map(|p| visible_path(&p))
}

#[tauri::command]
pub async fn language_document(
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: String,
) -> Result<DiskDocument> {
    let path = if let Ok(path) = state.authorize(window.label(), &path) {
        path
    } else {
        let running = state
            .servers
            .lock()
            .unwrap()
            .keys()
            .any(|k| k.starts_with(&format!("{}/", window.label())));
        if !running {
            return Err(AppError::new(
                "access",
                "No language service is running for this dependency request",
            ));
        }
        state.grant(window.label(), Path::new(&path))?
    };
    files::read(&path, false, None)
}
