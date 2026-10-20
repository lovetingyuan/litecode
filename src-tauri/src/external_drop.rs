use crate::{
    error::{AppError, Result},
    file_clipboard::{check_source, copy_item},
    file_moves::{FileMove, MoveFailure, key, visible, within, workspace},
    state::AppState,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use tauri::{Manager, State, WebviewWindow};

#[derive(Clone, Debug, Serialize)]
pub struct DropItem {
    path: String,
    directory: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedDrop {
    batch_id: String,
    items: Vec<DropItem>,
    failed: Vec<MoveFailure>,
}

fn resolve_sources(paths: Vec<PathBuf>) -> (Vec<PathBuf>, Vec<MoveFailure>) {
    let mut seen = HashSet::new();
    let mut failed = vec![];
    let mut valid = vec![];
    for path in paths {
        if !seen.insert(key(&path)) {
            continue;
        }
        match check_source(&path) {
            Ok(_) => valid.push(path),
            Err(error) => failed.push(MoveFailure {
                path: visible(&path),
                message: error.message,
            }),
        }
    }
    let directories: Vec<_> = valid.iter().filter(|p| p.is_dir()).cloned().collect();
    valid.retain(|p| {
        !directories
            .iter()
            .any(|parent| key(p) != key(parent) && within(p, parent))
    });
    (valid, failed)
}

#[cfg(windows)]
pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    use tauri::Emitter;
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
        },
        WebMessageReceivedEventHandler,
    };
    use windows::{
        Win32::System::Com::CoTaskMemFree,
        core::{Interface, PWSTR},
    };
    let window = window.clone();
    window.clone().with_webview(move |webview| unsafe {
        let core = webview.controller().CoreWebView2().expect("WebView2 core");
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()); };
            let read_string = |read: &dyn Fn(*mut PWSTR) -> windows::core::Result<()>| -> windows::core::Result<String> {
                let mut value = PWSTR::null();
                read(&mut value)?;
                let result = value.to_string();
                CoTaskMemFree(Some(value.0.cast()));
                Ok(result?)
            };
            let source = read_string(&|p| args.Source(p))?;
            let Ok(url) = url::Url::parse(&source) else { return Ok(()); };
            let local = matches!((url.scheme(), url.host_str()), ("tauri", Some("localhost")) | ("http", Some("tauri.localhost")))
                || cfg!(debug_assertions) && window.app_handle().config().build.dev_url.as_ref().is_some_and(|dev| dev.origin() == url.origin());
            if !local {
                return Ok(());
            }
            let json = read_string(&|p| args.TryGetWebMessageAsString(p))?;
            let Ok(message) = serde_json::from_str::<serde_json::Value>(&json) else { return Ok(()); };
            if message["type"] != "litecode-external-drop" { return Ok(()); }
            let Some(id) = message["batchId"].as_str().filter(|s| !s.is_empty() && s.len() <= 100) else { return Ok(()); };
            let mut paths = vec![];
            let mut failed = vec![];
            let objects = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>()?.AdditionalObjects()?;
            let mut count = 0;
            objects.Count(&mut count)?;
            for index in 0..count {
                let result = (|| -> windows::core::Result<String> {
                    let file = objects.GetValueAtIndex(index)?.cast::<ICoreWebView2File>()?;
                    read_string(&|p| file.Path(p))
                })();
                match result {
                    Ok(path) if !path.is_empty() => paths.push(PathBuf::from(path)),
                    _ => failed.push(MoveFailure { path: format!("Item {}", index + 1), message: "Could not resolve the dropped item to a local path".into() }),
                }
            }
            let id = id.to_owned();
            let window = window.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let (paths, errors) = resolve_sources(paths);
                failed.extend(errors);
                let items = paths.iter().map(|path| DropItem { path: visible(path), directory: path.is_dir() }).collect();
                {
                    let state = window.state::<AppState>();
                    let mut windows = state.windows.lock().unwrap();
                    let Some(w) = windows.get_mut(window.label()) else { return; };
                    // Resolution can finish out of order; the renderer releases cancelled batches.
                    if w.drops.len() >= 8 { return; }
                    w.drops.insert(id.clone(), paths);
                }
                let _ = window.emit("external-drop-resolved", &ResolvedDrop { batch_id: id, items, failed });
            });
            Ok(())
        }));
        let mut token = 0;
        if let Err(error) = core.add_WebMessageReceived(&handler, &mut token) {
            eprintln!("Could not install external file drop bridge: {error}");
        }
    })
}

#[cfg(not(windows))]
pub fn install(_: &WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

fn batch(state: &AppState, label: &str, id: &str) -> Result<Vec<PathBuf>> {
    state
        .windows
        .lock()
        .unwrap()
        .get(label)
        .and_then(|w| w.drops.get(id))
        .cloned()
        .ok_or_else(|| AppError::new("drop", "This file drop expired; drag the items again"))
}

#[tauri::command]
pub fn release_external_drop(window: WebviewWindow, state: State<'_, AppState>, batch_id: String) {
    if let Some(w) = state.windows.lock().unwrap().get_mut(window.label()) {
        w.drops.remove(&batch_id);
    }
}

#[tauri::command]
pub fn authorize_external_drop(
    window: WebviewWindow,
    state: State<'_, AppState>,
    batch_id: String,
) -> Result<Vec<DropItem>> {
    batch(&state, window.label(), &batch_id)?
        .iter()
        .map(|path| {
            let metadata = check_source(path)?;
            let path = state.grant(window.label(), path)?;
            Ok(DropItem {
                path: visible(&path),
                directory: metadata.is_dir(),
            })
        })
        .collect()
}

#[derive(Debug, Serialize)]
pub struct CopyPlan {
    destination: String,
    existing: Option<String>,
    directory: bool,
}

// Include descendants and bytes: an overwrite confirmation must not authorize a later edit.
fn target_stamp(path: &Path) -> Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
        Ok(_) => (),
    }
    let mut hash = Sha256::new();
    for entry in walkdir::WalkDir::new(path)
        .follow_links(false)
        .follow_root_links(false)
        .sort_by_file_name()
    {
        let entry = entry.map_err(|e| AppError::new("copy", e.to_string()))?;
        let metadata = check_source(entry.path())?;
        hash.update(
            entry
                .path()
                .strip_prefix(path)
                .unwrap()
                .to_string_lossy()
                .as_bytes(),
        );
        hash.update([u8::from(metadata.is_dir())]);
        hash.update(metadata.len().to_le_bytes());
        hash.update(format!("{:?}", metadata.modified()).as_bytes());
        if metadata.is_file() {
            let mut file = fs::File::open(entry.path())?;
            let mut buffer = [0u8; 65536];
            loop {
                let n = file.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                hash.update(&buffer[..n]);
            }
        }
    }
    Ok(Some(format!("{:x}", hash.finalize())))
}

fn destination(source: &Path, target: &Path) -> Result<PathBuf> {
    check_source(source)?;
    let name = source
        .file_name()
        .ok_or_else(|| AppError::new("path", "Cannot import a filesystem root"))?;
    let dest = target.join(name);
    if within(target, source) || within(source, &dest) {
        return Err(AppError::new(
            "path",
            "Cannot copy an item onto itself or into a containing directory",
        ));
    }
    Ok(dest)
}

fn checked_target(state: &AppState, label: &str, root: &str, directory: &str) -> Result<PathBuf> {
    let root = workspace(state, label, root)?;
    check_source(Path::new(directory))?;
    let target = fs::canonicalize(directory)?;
    if !target.is_dir() || !within(&target, &root) {
        return Err(AppError::new(
            "access",
            "The destination must be a directory in the current workspace",
        ));
    }
    Ok(target)
}

#[tauri::command]
pub async fn plan_external_copy(
    window: WebviewWindow,
    batch_id: String,
    index: usize,
    expected_root: String,
    target_directory: String,
) -> Result<CopyPlan> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _disk = state.disk_lock.lock().unwrap();
        let paths = batch(&state, &label, &batch_id)?;
        let source = paths
            .get(index)
            .ok_or_else(|| AppError::new("drop", "Invalid dropped item"))?;
        let target = checked_target(&state, &label, &expected_root, &target_directory)?;
        let dest = destination(source, &target)?;
        Ok(CopyPlan {
            destination: visible(&dest),
            existing: target_stamp(&dest)?,
            directory: dest.is_dir(),
        })
    })
    .await
    .map_err(|e| AppError::new("copy", e.to_string()))?
}

fn commit_copy(source: &Path, dest: &Path, expected: Option<&str>, replace: bool) -> Result<()> {
    let directory = check_source(source)?.is_dir();
    let staging = tempfile::Builder::new()
        .prefix(".litecode-drop-")
        .tempdir_in(dest.parent().unwrap())?;
    let prepared = staging.path().join("new");
    copy_item(source, &prepared, directory)?;
    if target_stamp(dest)?.as_deref() != expected {
        return Err(AppError::new(
            "conflict",
            "The destination changed; drag the item again",
        ));
    }
    if expected.is_some() && !replace {
        return Err(AppError::new(
            "conflict",
            "Replacing this item requires confirmation",
        ));
    }
    let backup = staging.path().join("original");
    if expected.is_some() {
        fs::rename(dest, &backup)?;
    }
    // Persist the backup on failure if restoring it is impossible.
    if let Err(error) = rename_exclusive(&prepared, dest) {
        if expected.is_some()
            && let Err(restore) = rename_exclusive(&backup, dest)
        {
            let recovery = staging.keep();
            return Err(AppError::new(
                "copy",
                format!(
                    "{error}; restore failed: {restore}. Original preserved in {}",
                    visible(&recovery.join("original"))
                ),
            ));
        }
        return Err(error.into());
    }
    Ok(())
}

fn rename_exclusive(source: &Path, dest: &Path) -> std::io::Result<()> {
    // Windows rename fails if the destination exists; never delete a racing writer's file.
    if fs::symlink_metadata(dest).is_ok() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "Destination already exists",
        ));
    }
    fs::rename(source, dest)
}

#[tauri::command]
pub async fn copy_external_item(
    window: WebviewWindow,
    batch_id: String,
    index: usize,
    expected_root: String,
    target_directory: String,
    expected_target: Option<String>,
    replace: bool,
) -> Result<FileMove> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _disk = state.disk_lock.lock().unwrap();
        let paths = batch(&state, &label, &batch_id)?;
        let source = paths
            .get(index)
            .ok_or_else(|| AppError::new("drop", "Invalid dropped item"))?;
        let target = checked_target(&state, &label, &expected_root, &target_directory)?;
        let dest = destination(source, &target)?;
        if paths.iter().any(|path| within(path, &dest)) {
            return Err(AppError::new(
                "path",
                "The destination contains a dropped source; no source may be replaced",
            ));
        }
        commit_copy(source, &dest, expected_target.as_deref(), replace)?;
        Ok(FileMove {
            from: visible(source),
            to: visible(&dest),
        })
    })
    .await
    .map_err(|e| AppError::new("copy", e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("external");
        let target = temp.path().join("workspace");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        (
            temp,
            fs::canonicalize(source).unwrap(),
            fs::canonicalize(target).unwrap(),
        )
    }

    #[test]
    fn resolves_native_paths_and_removes_duplicates_and_selected_children() {
        let (_temp, source, _) = fixture();
        fs::create_dir(source.join("folder")).unwrap();
        fs::write(source.join("folder/a"), "a").unwrap();
        let (items, failed) = resolve_sources(vec![
            source.join("folder/a"),
            source.join("folder"),
            source.join("folder"),
            source.join("missing"),
        ]);
        assert_eq!(items, vec![source.join("folder")]);
        assert_eq!(failed.len(), 1);
    }

    #[test]
    fn preserves_bytes_empty_directories_and_source_when_replacing_a_folder() {
        let (_temp, source, target) = fixture();
        let folder = source.join("中文 空格");
        fs::create_dir_all(folder.join("nested/empty")).unwrap();
        fs::write(folder.join("nested/binary"), [0, 255, 1, 0]).unwrap();
        let dest = target.join("中文 空格");
        fs::create_dir(&dest).unwrap();
        fs::write(dest.join("old"), "old").unwrap();
        let stamp = target_stamp(&dest).unwrap();
        commit_copy(&folder, &dest, stamp.as_deref(), true).unwrap();
        assert!(!dest.join("old").exists());
        assert!(dest.join("nested/empty").is_dir());
        assert_eq!(
            fs::read(dest.join("nested/binary")).unwrap(),
            [0, 255, 1, 0]
        );
        assert!(folder.join("nested/binary").exists());
    }

    #[test]
    fn rejects_unconfirmed_or_stale_targets_without_changing_them() {
        let (_temp, source, target) = fixture();
        fs::write(source.join("a"), "incoming").unwrap();
        let dest = target.join("a");
        fs::write(&dest, "old").unwrap();
        let stamp = target_stamp(&dest).unwrap();
        assert!(commit_copy(&source.join("a"), &dest, stamp.as_deref(), false).is_err());
        fs::write(&dest, "later edit").unwrap();
        assert!(commit_copy(&source.join("a"), &dest, stamp.as_deref(), true).is_err());
        assert!(commit_copy(&source.join("a"), &dest, None, false).is_err());
        assert_eq!(fs::read_to_string(&dest).unwrap(), "later edit");
        assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
    }

    #[test]
    fn detects_changes_deep_inside_target_directory() {
        let (_temp, _, target) = fixture();
        fs::create_dir_all(target.join("folder/nested")).unwrap();
        fs::write(target.join("folder/nested/a"), "before").unwrap();
        let stamp = target_stamp(&target.join("folder")).unwrap();
        fs::write(target.join("folder/nested/a"), "after!").unwrap();
        assert_ne!(stamp, target_stamp(&target.join("folder")).unwrap());
    }

    #[test]
    fn rejects_self_descendant_and_ancestor_replacement() {
        let (_temp, source, _) = fixture();
        fs::create_dir_all(source.join("folder/deep/folder")).unwrap();
        assert!(destination(&source.join("folder"), &source).is_err());
        assert!(destination(&source.join("folder"), &source.join("folder/deep")).is_err());
        assert!(destination(&source.join("folder/deep/folder"), &source).is_err());
    }

    #[test]
    fn isolates_native_batches_by_window_and_validates_workspace_target() {
        let (_temp, source, target) = fixture();
        let state = AppState::default();
        state.windows.lock().unwrap().insert(
            "main".into(),
            crate::state::WindowState {
                root: Some(target.clone()),
                ..Default::default()
            },
        );
        state
            .windows
            .lock()
            .unwrap()
            .get_mut("main")
            .unwrap()
            .drops
            .insert("drop".into(), vec![source.clone()]);
        assert!(batch(&state, "other", "drop").is_err());
        assert!(batch(&state, "main", "forged").is_err());
        assert!(checked_target(&state, "main", &visible(&target), &visible(&source)).is_err());
        assert!(checked_target(&state, "main", &visible(&source), &visible(&target)).is_err());
        assert!(checked_target(&state, "main", &visible(&target), &visible(&target)).is_ok());
    }

    #[test]
    fn consecutive_same_names_require_a_new_confirmation_and_preserve_original_sources() {
        let (_temp, source, target) = fixture();
        fs::create_dir(source.join("other")).unwrap();
        fs::write(source.join("a.txt"), "first").unwrap();
        fs::write(source.join("other/a.txt"), "second").unwrap();
        let dest = target.join("a.txt");
        commit_copy(&source.join("a.txt"), &dest, None, false).unwrap();
        assert!(commit_copy(&source.join("other/a.txt"), &dest, None, false).is_err());
        let stamp = target_stamp(&dest).unwrap();
        commit_copy(&source.join("other/a.txt"), &dest, stamp.as_deref(), true).unwrap();
        assert_eq!(fs::read_to_string(dest).unwrap(), "second");
        assert_eq!(fs::read_to_string(source.join("a.txt")).unwrap(), "first");
    }

    #[cfg(windows)]
    #[test]
    fn failed_source_read_preserves_existing_target_and_cleans_staging() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_temp, source, target) = fixture();
        fs::write(source.join("a"), "incoming").unwrap();
        fs::write(target.join("a"), "original").unwrap();
        let stamp = target_stamp(&target.join("a")).unwrap();
        let _lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(source.join("a"))
            .unwrap();
        assert!(commit_copy(&source.join("a"), &target.join("a"), stamp.as_deref(), true).is_err());
        assert_eq!(fs::read_to_string(target.join("a")).unwrap(), "original");
        assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn failed_commit_restores_the_old_target() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_temp, source, target) = fixture();
        fs::write(source.join("a"), "incoming").unwrap();
        fs::write(target.join("a"), "original").unwrap();
        let stamp = target_stamp(&target.join("a")).unwrap();
        let _lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(target.join("a"))
            .unwrap();
        assert!(commit_copy(&source.join("a"), &target.join("a"), stamp.as_deref(), true).is_err());
        assert_eq!(fs::read_to_string(target.join("a")).unwrap(), "original");
    }
}
