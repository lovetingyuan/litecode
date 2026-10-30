use crate::sync::MutexExt;
use crate::sync::RwLockExt;
use crate::{
    configuration::read_json,
    error::{AppError, Result},
    files::{self, DiskDocument},
    state::{AppState, DocumentSnapshot, Mirror, WindowState, canonical, recovery_path},
    workspace,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

fn visible_path(path: &Path) -> String {
    crate::tools::process_path(path)
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn workspace_preflight_checks_directory_access_without_loading_or_trusting_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();
        let file = root.join("file.txt");
        fs::write(&file, "text").unwrap();
        let state = AppState {
            data_dir: dir.path().join("data"),
            ..Default::default()
        };
        state
            .windows
            .lock_recover()
            .insert("main".into(), WindowState::default());
        assert_eq!(
            workspace_open_root(&state, "main", root.to_str().unwrap())
                .unwrap_err()
                .code,
            "access"
        );
        state.grant("main", &root).unwrap();
        let canonical = fs::canonicalize(&root).unwrap();
        assert_eq!(
            workspace_open_root(&state, "main", root.to_str().unwrap()).unwrap(),
            canonical
        );
        assert!(!state.workspace_is_trusted(&canonical).unwrap());
        assert!(!state.data_dir.exists());
        let windows = state.windows.lock_recover();
        let window = windows.get("main").unwrap();
        assert!(window.root.is_none());
        assert!(window.watcher.is_none());
        drop(windows);
        assert_eq!(
            workspace_open_root(&state, "main", file.to_str().unwrap())
                .unwrap_err()
                .code,
            "path"
        );
        remember(&state, root.to_str().unwrap()).unwrap();
        assert!(workspace_open_root(&state, "another", root.to_str().unwrap()).is_ok());
    }

    #[test]
    fn opening_consent_only_applies_to_the_reviewed_canonical_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let consent = WorkspaceTrustDecision {
            root: visible_path(&root),
            trusted: true,
        };
        assert!(consent.validate(&root).is_ok());
        assert_eq!(
            consent.validate(&root.join("other")).unwrap_err().code,
            "workspace"
        );
    }

    #[test]
    fn returned_paths_keep_unc_roots_and_agree_with_move_paths() {
        for (input, expected) in [
            (
                r"\\?\UNC\server\share\project 中文\a.txt",
                r"\\server\share\project 中文\a.txt",
            ),
            (r"\\?\D:\project 中文\a.txt", r"D:\project 中文\a.txt"),
            (
                r"\\server\share\project 中文\a.txt",
                r"\\server\share\project 中文\a.txt",
            ),
            (r"D:\project 中文\a.txt", r"D:\project 中文\a.txt"),
            ("/tmp/project/a.txt", "/tmp/project/a.txt"),
        ] {
            let visible = visible_path(Path::new(input));
            assert_eq!(visible, expected);
            assert_eq!(
                visible.replace('\\', "/"),
                crate::file_moves::visible(Path::new(input))
            );
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub initial_open: Option<crate::launch::OpenTarget>,
    pub root: Option<String>,
    pub workspace_restricted: bool,
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
pub async fn bootstrap(window: WebviewWindow) -> Result<Bootstrap> {
    let started = std::time::Instant::now();
    crate::state::blocking(window, move |window, state| {
        crate::startup::mark("bootstrap-dispatched", started);
        let started = std::time::Instant::now();
        state.cancel_git(window.label());
        let _disk = state.disk_lock.write_recover();
        crate::startup::mark("bootstrap-disk-lock", started);
        let started = std::time::Instant::now();
        state.terminals.close_window(window.label());
        state.replacement_plans.close_window(window.label());
        // A reloaded WebView cannot acknowledge its old Channels.
        for (key, task) in state.searches.lock_recover().iter() {
            if key.starts_with(&format!("{}/", window.label())) {
                task.cancelled
                    .store(true, std::sync::atomic::Ordering::Release);
            }
        }
        let mut warnings = std::mem::take(&mut *state.startup_warnings.lock_recover());
        let needs_restore = state
            .windows
            .lock_recover()
            .get(window.label())
            .is_none_or(|w| w.session.is_null());
        let restored =
            needs_restore.then(|| crate::recovery::load(state, window.label(), &mut warnings));
        {
            let mut windows = state.windows.lock_recover();
            let w = windows.entry(window.label().into()).or_default();
            w.drops.clear();
            if let Some(restored) = restored {
                w.root = w.root.clone().or_else(|| {
                    restored
                        .root
                        .as_deref()
                        .and_then(|p| canonical(p).ok())
                        .filter(|p| p.is_dir())
                });
                w.session = restored.session;
                w.backup.preserve_files = restored.preserve_files;
                w.backup.blocked = restored.blocked;
                for d in restored.documents {
                    if let Some(path) = &d.path
                        && let Ok(path) = recovery_path(Path::new(path))
                    {
                        w.grants.insert(path);
                    }
                    w.documents.insert(d.id.clone(), d);
                }
                if let Err(error) = crate::transactions::restore_buffers(&state, window.label(), w)
                {
                    warnings.push(format!(
                        "Could not inspect replacement buffers: {}. Backups were preserved.",
                        error.message
                    ));
                }
            }
        }
        crate::startup::mark("bootstrap-recovery", started);
        let started = std::time::Instant::now();
        let root = state
            .windows
            .lock_recover()
            .get(window.label())
            .and_then(|w| w.root.clone());
        let needs_watcher = state
            .windows
            .lock_recover()
            .get(window.label())
            .is_none_or(|w| w.watcher.is_none());
        if needs_watcher
            && let Some(root) = &root
            && let Err(e) = workspace::watch(window.app_handle(), window.label(), root.clone())
        {
            warnings.push(e.message);
        }
        crate::startup::mark("bootstrap-watcher", started);
        let started = std::time::Instant::now();
        let settings = crate::configuration::load_settings(
            &state.data_dir.join("settings.json"),
            root.as_deref(),
            &mut warnings,
        );
        let mut windows = state.windows.lock_recover();
        let w = windows
            .get_mut(window.label())
            .ok_or_else(|| AppError::new("window", "Window is not initialized"))?;
        let boot = Bootstrap {
            initial_open: w.initial_open.take(),
            root: root.as_deref().map(visible_path),
            workspace_restricted: w.workspace_restricted,
            documents: w.documents.values().cloned().collect(),
            session: w.session.clone(),
            recent: recent(&state),
            settings,
            keybindings: read_json(&state.data_dir.join("keybindings.json"), &mut warnings),
            warnings,
            data_dir: visible_path(&state.data_dir),
        };
        crate::startup::mark("bootstrap-settings", started);
        Ok(boot)
    })
    .await
}

#[tauri::command]
pub async fn pick_path(
    window: WebviewWindow,
    state: State<'_, AppState>,
    kind: String,
) -> Result<Option<String>> {
    let app = window.app_handle().clone();
    let picker_window = window.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        if kind == "folder" {
            return crate::folder_picker::pick(&picker_window).map(|path| path.map(Into::into));
        }
        let dialog = app.dialog().file().set_parent(&picker_window);
        Ok(match kind.as_str() {
            "folder" => dialog.blocking_pick_folder(),
            "save" => dialog.blocking_save_file(),
            _ => dialog.blocking_pick_file(),
        })
    })
    .await
    .map_err(|e| AppError::new("dialog", e.to_string()))??;
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
pub async fn new_window(window: WebviewWindow, state: State<'_, AppState>) -> Result<String> {
    create_empty_window(window.app_handle(), &state, None)
}

pub(crate) fn create_empty_window(
    app: &tauri::AppHandle,
    state: &AppState,
    initial_open: Option<crate::launch::OpenTarget>,
) -> Result<String> {
    let label = empty_window_label()?;
    let mut grants = std::collections::HashSet::new();
    if let Some(target) = &initial_open {
        grants.insert(fs::canonicalize(&target.path)?);
    }
    state.windows.lock_recover().insert(
        label.clone(),
        WindowState {
            initial_open,
            grants,
            // New windows must not restore a previous window's recovery session.
            session: serde_json::json!({}),
            ..Default::default()
        },
    );
    create_editor_window(app, state, &label)?;
    Ok(label)
}

fn empty_window_label() -> Result<String> {
    static NEXT_WINDOW: AtomicU64 = AtomicU64::new(0);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| AppError::new("window", e.to_string()))?
        .as_nanos();
    Ok(format!(
        "editor-empty-{timestamp}-{}",
        NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)
    ))
}

pub(crate) fn create_editor_window(
    app: &tauri::AppHandle,
    state: &AppState,
    label: &str,
) -> Result<()> {
    let result = (|| {
        let updates = app.state::<crate::updates::Updates>();
        let _update_gate = updates.window_gate.lock_recover();
        updates.ensure_interactive()?;
        let created = tauri::WebviewWindowBuilder::new(
            app,
            label,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("LiteCode")
        .inner_size(1280.0, 820.0)
        .min_inner_size(700.0, 420.0)
        .decorations(false)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| AppError::new("window", e.to_string()))?;
        if let Err(error) =
            crate::external_drop::install(&created).and_then(|()| created.set_focus())
        {
            let _ = created.destroy();
            return Err(AppError::new("window", error.to_string()));
        }
        Ok(())
    })();
    if result.is_err() {
        state.windows.lock_recover().remove(label);
    }
    result
}

fn workspace_open_root(state: &AppState, label: &str, path: &str) -> Result<PathBuf> {
    let root = canonical(Path::new(path))?;
    if !root.is_dir() {
        return Err(AppError::new("path", "Not a directory"));
    }
    let known = recent(state)
        .iter()
        .any(|p| canonical(Path::new(p)).ok().as_ref() == Some(&root));
    let allowed = state.authorize(label, path).is_ok();
    if !known && !allowed {
        return Err(AppError::new(
            "access",
            "Select the directory with Open Folder first",
        ));
    }
    Ok(root)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpenInfo {
    path: String,
    trusted: bool,
    already_open: bool,
}

#[tauri::command]
pub async fn workspace_open_info(
    window: WebviewWindow,
    path: String,
    reuse_existing: Option<bool>,
) -> Result<WorkspaceOpenInfo> {
    crate::state::blocking(window, move |window, state| {
        let root = workspace_open_root(state, window.label(), &path)?;
        let already_open = reuse_existing.unwrap_or(true)
            && state
                .windows
                .lock_recover()
                .values()
                .any(|w| w.root.as_ref() == Some(&root));
        Ok(WorkspaceOpenInfo {
            path: visible_path(&root),
            trusted: state.workspace_is_trusted(&root)?,
            already_open,
        })
    })
    .await
}

#[derive(Deserialize)]
pub struct WorkspaceTrustDecision {
    root: String,
    trusted: bool,
}

impl WorkspaceTrustDecision {
    fn validate(&self, root: &Path) -> Result<()> {
        if visible_path(root) != self.root {
            return Err(AppError::new(
                "workspace",
                "The selected directory changed. Open the folder again to review trust.",
            ));
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn open_workspace(
    window: WebviewWindow,
    path: String,
    new_window: bool,
    trust: Option<WorkspaceTrustDecision>,
    reuse_existing: Option<bool>,
) -> Result<bool> {
    crate::state::blocking(window, move |window, state| {
        let root = workspace_open_root(state, window.label(), &path)?;
        if let Some(trust) = &trust {
            trust.validate(&root)?;
        }
        {
            let windows = state.windows.lock_recover();
            if reuse_existing.unwrap_or(true)
                && let Some((label, _)) =
                    windows.iter().find(|(_, w)| w.root.as_ref() == Some(&root))
            {
                if let Some(existing) = window.app_handle().get_webview_window(label) {
                    let _ = existing.set_focus();
                }
                return Ok(label == window.label());
            }
        }
        let _disk = state.disk_lock.write_recover();
        if !new_window {
            crate::transactions::ensure_no_pending(&state, window.label())?;
        }
        remember(&state, &visible_path(&root))?;
        if trust.as_ref().is_some_and(|choice| choice.trusted) {
            state.save_workspace_trust(&root, true)?;
        }
        let restricted = trust.as_ref().is_some_and(|choice| !choice.trusted);
        if new_window {
            let label = if reuse_existing.unwrap_or(true) {
                format!(
                    "editor-{}",
                    &files::hash(root.to_string_lossy().as_bytes())[..12]
                )
            } else {
                empty_window_label()?
            };
            state.windows.lock_recover().insert(
                label.clone(),
                WindowState {
                    root: Some(root),
                    workspace_restricted: restricted,
                    ..Default::default()
                },
            );
            create_editor_window(window.app_handle(), &state, &label)?;
            Ok(false)
        } else {
            state.checkpoint(window.label())?;
            let mut windows = state.windows.lock_recover();
            let w = windows.entry(window.label().into()).or_default();
            for doc in w.documents.values() {
                if let Some(path) = &doc.path
                    && let Ok(path) = canonical(Path::new(path))
                {
                    w.grants.insert(path);
                }
            }
            state.cancel_git(window.label());
            w.root = Some(root.clone());
            w.workspace_restricted = restricted;
            state.terminals.close_window(window.label());
            drop(windows);
            workspace::watch(window.app_handle(), window.label(), root)?;
            Ok(true)
        }
    })
    .await
}

#[tauri::command]
pub async fn read_workspace_directory(
    window: WebviewWindow,
    state: State<'_, AppState>,
    directory: String,
    expected_root: String,
    session: Option<u64>,
) -> Result<workspace::DirectorySnapshot> {
    let expected = canonical(Path::new(&expected_root))?;
    let (root, repositories, current_session) = {
        let windows = state.windows.lock_recover();
        let current = windows
            .get(window.label())
            .ok_or_else(|| AppError::new("workspace", "No folder is open"))?;
        let root = current
            .root
            .clone()
            .filter(|root| root == &expected)
            .ok_or_else(|| AppError::new("workspace", "Workspace changed"))?;
        if session.is_some_and(|session| session != current.workspace_session) {
            return Err(AppError::new("workspace", "Workspace changed"));
        }
        (
            root,
            current.repositories.clone(),
            current.workspace_session,
        )
    };
    let (snapshot, discovered) = tauri::async_runtime::spawn_blocking(move || -> Result<_> {
        let result = workspace::read_directory(&root, &directory, current_session)?;
        let target = root.join(&result.directory);
        let discovered =
            target.join(".git").exists() && repositories.repositories.lock_recover().insert(target);
        Ok((result, discovered))
    })
    .await
    .map_err(|e| AppError::new("directory", e.to_string()))??;
    if discovered {
        let _ = window.emit_to(
            window.label(),
            "workspace-changed",
            workspace::WorkspaceChanges {
                root: snapshot.root.clone(),
                session: current_session,
                changes: vec![],
                rescan: false,
                git_changed: true,
                file_index_changed: false,
                git_paths: vec![],
            },
        );
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn workspace_git_status(
    window: WebviewWindow,
    state: State<'_, AppState>,
    expected_root: String,
    session: Option<u64>,
    force: Option<bool>,
) -> Result<workspace::GitSnapshot> {
    let expected = canonical(Path::new(&expected_root))?;
    let (root, repositories, current_session) = {
        let windows = state.windows.lock_recover();
        let current = windows
            .get(window.label())
            .ok_or_else(|| AppError::new("workspace", "No folder is open"))?;
        let root = current
            .root
            .clone()
            .filter(|root| root == &expected)
            .ok_or_else(|| AppError::new("workspace", "Workspace changed"))?;
        if session.is_some_and(|session| session != current.workspace_session) {
            return Err(AppError::new("workspace", "Workspace changed"));
        }
        (
            root,
            current.repositories.clone(),
            current.workspace_session,
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        if force.unwrap_or(false) {
            repositories.invalidate();
        }
        workspace::git_snapshot(&root, &repositories, current_session)
    })
    .await
    .map_err(|e| AppError::new("git", e.to_string()))?
}

#[tauri::command]
pub async fn inspect_file(
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: String,
) -> Result<crate::media::FileInfo> {
    let path = state.authorize(window.label(), &path)?;
    tauri::async_runtime::spawn_blocking(move || crate::media::inspect(&path))
        .await
        .map_err(|e| AppError::new("read", e.to_string()))?
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
    id: String,
    version: u64,
    path: String,
    text: String,
    encoding: String,
    revision: Option<String>,
    elevate: Option<bool>,
) -> Result<String> {
    crate::state::blocking(window, move |window, state| {
        let _disk = state.disk_lock.read_recover();
        let session_lock = state.disk_operation(format!("session:{}", window.label()));
        let _session = session_lock.lock_recover();
        let path = state.authorize(window.label(), &path)?;
        let path_lock = state.disk_operation(format!("path:{}", crate::file_moves::key(&path)));
        let _path = path_lock.lock_recover();
        {
            let windows = state.windows.lock_recover();
            let mirror = windows
                .get(window.label())
                .and_then(|w| w.documents.get(&id));
            if mirror.is_some_and(|m| !m.kind.is_text()) {
                return Err(AppError::new(
                    "binary",
                    "Media and binary previews cannot be saved as text.",
                ));
            }
            if mirror.is_some_and(|m| m.version > version) {
                return Err(AppError::new(
                    "stale",
                    "The document changed while saving. Save again.",
                ));
            }
        }
        let saved = files::save(&path, &text, &encoding, revision.as_deref());
        #[cfg(windows)]
        let saved = match saved {
            Err(error) if error.code == "permissionDenied" => {
                if elevate.unwrap_or(false) {
                    crate::elevated_save::save(&path, &text, &encoding, revision.as_deref())
                } else {
                    Err(AppError::new(
                        "elevationRequired",
                        "Administrator permission is required. Save the file manually to continue.",
                    ))
                }
            }
            result => result,
        };
        #[cfg(not(windows))]
        let _ = elevate;
        let revision = saved?;
        if matches!(
            path.file_name().and_then(|s| s.to_str()),
            Some("settings.json" | "keybindings.json")
        ) {
            let _ = window.app_handle().emit("configuration-changed", ());
        }
        if let Some(m) = state
            .windows
            .lock_recover()
            .get_mut(window.label())
            .and_then(|w| w.documents.get_mut(&id))
        {
            m.path = Some(visible_path(&path));
            m.revision = Some(revision.clone());
            m.dirty = m.version != version;
        }
        Ok(revision)
    })
    .await
}

#[tauri::command]
pub fn configuration(window: WebviewWindow, state: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({ "settings": crate::tools::settings(&window, &state), "keybindings": read_json(&state.data_dir.join("keybindings.json"), &mut vec![]) })
}

#[tauri::command]
pub async fn set_workspace_trust(
    window: WebviewWindow,
    expected_root: String,
    trusted: bool,
) -> Result<()> {
    crate::state::blocking(window, move |window, state| {
        state.set_workspace_trust(window.label(), &expected_root, trusted)
    })
    .await
}

#[tauri::command]
pub async fn sync_documents(
    window: WebviewWindow,
    documents: Vec<DocumentSnapshot>,
    session: serde_json::Value,
) -> Result<()> {
    crate::state::blocking(window, move |window, state| {
        state.sync_documents(window.label(), documents, session)
    })
    .await
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
    operation: FileOperation,
) -> Result<Option<String>> {
    crate::state::blocking(window, move |window, state| {
        if operation.kind == "delete" {
            return crate::file_delete::recycle(
                &state,
                window.label(),
                &operation.path,
                |source| {
                    trash::delete(source).map_err(|error| {
                AppError::new(
                    "recycle",
                    format!(
                        "Could not move to Recycle Bin; nothing was permanently deleted: {error}"
                    ),
                )
            })
                },
            )
            .map(|_| None);
        }
        let _disk = state.disk_lock.write_recover();
        if operation.kind == "rename" {
            let destination = operation
                .destination
                .as_deref()
                .ok_or_else(|| AppError::new("path", "Missing destination"))?;
            crate::file_moves::rename_checked(state, window.label(), &operation.path, destination)?;
            return Ok(None);
        }
        let source = state.authorize(window.label(), &operation.path)?;
        if state
            .windows
            .lock_recover()
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
            "copy" => {
                let destination = operation
                    .destination
                    .ok_or_else(|| AppError::new("path", "Missing destination"))?;
                let requested = Path::new(&destination);
                let parent = requested
                    .parent()
                    .ok_or_else(|| AppError::new("path", "Invalid destination"))?;
                let name = requested
                    .file_name()
                    .ok_or_else(|| AppError::new("path", "Invalid destination name"))?;
                let parent = state.authorize(window.label(), &parent.to_string_lossy())?;
                let destination = crate::file_clipboard::copy_available(
                    Path::new(&operation.path),
                    &parent.join(name),
                )?;
                return Ok(Some(crate::file_moves::visible(&destination)));
            }
            _ => return Err(AppError::new("operation", "Unsupported file operation")),
        }
        Ok(None)
    })
    .await
}

#[tauri::command]
pub async fn open_directory(
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: String,
) -> Result<()> {
    let directory = state.authorize(window.label(), &path)?;
    if !directory.is_dir() {
        return Err(AppError::new(
            "path",
            "The folder no longer exists or is not a directory.",
        ));
    }
    std::process::Command::new("explorer.exe")
        .arg(path)
        .spawn()?;
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
pub async fn settings_path(window: WebviewWindow, kind: String) -> Result<String> {
    crate::state::blocking(window, move |window, state| {
        let filename = if kind == "keybindings" {
            "keybindings.json"
        } else {
            "settings.json"
        };
        let path = state.data_dir.join(filename);
        let _disk = state.disk_lock.write_recover();
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
    })
    .await
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
pub fn check_language_document(
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: String,
) -> Result<()> {
    state.require_language_path(window.label(), Path::new(&path))?;
    Ok(())
}

#[tauri::command]
pub async fn language_document(window: WebviewWindow, path: String) -> Result<DiskDocument> {
    crate::state::blocking(window, move |window, state| {
        let path = if let Ok(path) = state.authorize(window.label(), &path) {
            path
        } else {
            let running = state
                .servers
                .lock_recover()
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
    })
    .await
}
