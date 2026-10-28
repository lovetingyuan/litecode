use crate::sync::{MutexExt, RwLockExt};
use crate::{
    error::{AppError, Result},
    files,
};
use notify::RecommendedWatcher;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock, Weak,
        atomic::{AtomicBool, AtomicU64},
    },
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRecord<T = String> {
    pub id: String,
    pub path: Option<String>,
    pub text: T,
    pub version: u64,
    pub revision: Option<String>,
    pub encoding: String,
    pub dirty: bool,
    #[serde(default)]
    pub kind: crate::media::FileKind,
    #[serde(default)]
    pub file_info: Option<crate::media::FileInfo>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub search_query: Option<serde_json::Value>,
}

pub type Mirror = DocumentRecord<String>;
pub type DocumentSnapshot = DocumentRecord<Option<String>>;

impl<T> DocumentRecord<T> {
    pub fn with_text<U>(self, text: U) -> DocumentRecord<U> {
        DocumentRecord {
            id: self.id,
            path: self.path,
            text,
            version: self.version,
            revision: self.revision,
            encoding: self.encoding,
            dirty: self.dirty,
            kind: self.kind,
            file_info: self.file_info,
            language: self.language,
            name: self.name,
            search_query: self.search_query,
        }
    }
}

impl Mirror {
    // Never clone the body when capturing a recovery manifest.
    pub fn metadata(&self) -> DocumentSnapshot {
        DocumentRecord {
            id: self.id.clone(),
            path: self.path.clone(),
            text: None,
            version: self.version,
            revision: self.revision.clone(),
            encoding: self.encoding.clone(),
            dirty: self.dirty,
            kind: self.kind,
            file_info: self.file_info.clone(),
            language: self.language.clone(),
            name: self.name.clone(),
            search_query: self.search_query.clone(),
        }
    }
}

#[derive(Default)]
pub struct WindowState {
    pub root: Option<PathBuf>,
    pub formatter_trust: HashSet<(Option<PathBuf>, PathBuf)>,
    pub grants: HashSet<PathBuf>,
    pub documents: HashMap<String, Mirror>,
    pub text_generations: HashMap<String, u64>,
    pub next_text_generation: u64,
    pub backup: crate::recovery::BackupState,
    pub watcher: Option<RecommendedWatcher>,
    pub workspace_session: u64,
    pub repositories: Arc<crate::workspace::RepositoryIndex>,
    pub git_blame: Arc<Mutex<crate::git::blame::Cache>>,
    pub session: serde_json::Value,
    pub drops: HashMap<String, Vec<PathBuf>>,
}

pub struct SearchTask {
    pub cancelled: AtomicBool,
    pub acknowledged: AtomicU64,
}

#[derive(Default)]
pub struct AppState {
    pub git_operations: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
    pub git_tasks: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
    pub replacement_plans: crate::replacement::PlanningTasks,
    pub tool_lock: tokio::sync::Mutex<()>,
    pub windows: Mutex<HashMap<String, WindowState>>,
    // Shared for ordinary saves/backups; exclusive for multi-file mutations.
    pub disk_lock: RwLock<()>,
    pub(crate) disk_operations: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    pub searches: Mutex<HashMap<String, Arc<SearchTask>>>,
    pub servers: Mutex<HashMap<String, crate::lsp::Server>>,
    pub terminals: crate::terminal::Service,
    pub startup_warnings: Mutex<Vec<String>>,
    pub data_dir: PathBuf,
}

pub fn canonical(path: &Path) -> Result<PathBuf> {
    if path.exists() {
        return Ok(fs::canonicalize(path)?);
    }
    let name = path
        .file_name()
        .ok_or_else(|| AppError::new("path", "Invalid path"))?;
    if name == "." || name == ".." {
        return Err(AppError::new("path", "Invalid filename"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("path", "Path must be absolute"))?;
    Ok(fs::canonicalize(parent)?.join(name))
}

// Recovery stores buffers, not files: missing ancestors must not disable backups.
pub fn recovery_path(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() || path.components().any(|c| c == Component::ParentDir) {
        return Err(AppError::new(
            "path",
            "Recovery paths must be absolute without parent traversal",
        ));
    }
    let mut ancestor = path;
    let mut missing = vec![];
    while !ancestor.try_exists()? {
        missing.push(
            ancestor
                .file_name()
                .ok_or_else(|| AppError::new("path", "Invalid recovery path"))?,
        );
        ancestor = ancestor
            .parent()
            .ok_or_else(|| AppError::new("path", "Invalid recovery path"))?;
    }
    let mut resolved = fs::canonicalize(ancestor)?;
    for name in missing.into_iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}

impl AppState {
    pub fn cancel_git(&self, label: &str) {
        for (key, task) in self.git_tasks.lock_recover().iter() {
            if key.starts_with(&format!("{label}/")) {
                task.send_replace(true);
            }
        }
    }
    pub fn disk_operation(&self, key: String) -> Arc<Mutex<()>> {
        let mut operations = self.disk_operations.lock_recover();
        operations.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = operations.get(&key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        operations.insert(key, Arc::downgrade(&lock));
        lock
    }

    pub fn authorize_recovery(&self, label: &str, path: &str) -> Result<PathBuf> {
        self.authorize_path(label, recovery_path(Path::new(path))?)
    }

    pub fn authorize(&self, label: &str, path: &str) -> Result<PathBuf> {
        self.authorize_path(label, canonical(Path::new(path))?)
    }

    fn authorize_path(&self, label: &str, path: PathBuf) -> Result<PathBuf> {
        let windows = self.windows.lock_recover();
        let window = windows
            .get(label)
            .ok_or_else(|| AppError::new("window", "Window is not initialized"))?;
        if window
            .root
            .as_ref()
            .is_some_and(|root| path.starts_with(root))
            || window.grants.contains(&path)
        {
            Ok(path)
        } else {
            Err(AppError::new(
                "access",
                "Open this file through Open File to grant this window access.",
            ))
        }
    }

    pub fn require_workspace_trust(&self, label: &str) -> Result<Option<PathBuf>> {
        let root = self
            .windows
            .lock_recover()
            .get(label)
            .ok_or_else(|| AppError::new("window", "Window is not initialized"))?
            .root
            .clone();
        if let Some(root) = &root
            && !self.trusted_roots()?.contains(root)
        {
            return Err(AppError::new(
                "workspaceTrust",
                "Restricted Mode: trust this workspace before running terminals, language services or external formatters.",
            ));
        }
        Ok(root)
    }

    fn trusted_roots(&self) -> Result<Vec<PathBuf>> {
        match fs::read(self.data_dir.join("trusted-workspaces.json")) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(e.into()),
        }
    }

    pub fn set_workspace_trust(
        &self,
        label: &str,
        expected_root: &str,
        trusted: bool,
    ) -> Result<()> {
        let expected = canonical(Path::new(expected_root))?;
        let _disk = self.disk_lock.write_recover();
        let windows = self.windows.lock_recover();
        if windows.get(label).and_then(|w| w.root.as_ref()) != Some(&expected) {
            return Err(AppError::new(
                "workspace",
                "The workspace changed. Review the current folder before trusting it.",
            ));
        }
        drop(windows);
        let mut roots = self.trusted_roots()?;
        roots.retain(|root| root != &expected);
        if trusted {
            roots.push(expected.clone());
        }
        files::atomic_write(
            &self.data_dir.join("trusted-workspaces.json"),
            &serde_json::to_vec(&roots)?,
        )?;
        if !trusted {
            let mut windows = self.windows.lock_recover();
            for (label, w) in windows.iter_mut() {
                if w.root.as_ref() == Some(&expected) {
                    self.cancel_git(label);
                    w.formatter_trust.clear();
                    self.terminals.close_window(label);
                }
            }
            let labels: Vec<_> = windows
                .iter()
                .filter(|(_, w)| w.root.as_ref() == Some(&expected))
                .map(|(label, _)| format!("{label}/"))
                .collect();
            self.servers.lock_recover().retain(|key, server| {
                if labels.iter().any(|label| key.starts_with(label)) {
                    crate::lsp::kill_tree(server.pid);
                    false
                } else {
                    true
                }
            });
        }
        Ok(())
    }

    pub fn sync_documents(
        &self,
        label: &str,
        documents: Vec<DocumentSnapshot>,
        session: serde_json::Value,
    ) -> Result<()> {
        let _disk = self.disk_lock.read_recover();
        let lock = self.disk_operation(format!("session:{label}"));
        let _session = lock.lock_recover();
        for doc in &documents {
            if !doc.kind.is_text()
                && (doc.text.as_ref().is_some_and(|text| !text.is_empty()) || doc.dirty)
            {
                return Err(AppError::new(
                    "binary",
                    "Binary recovery records cannot contain text edits.",
                ));
            }
            if let Some(path) = &doc.path {
                self.authorize_path(label, recovery_path(Path::new(path))?)?;
            }
            if doc
                .text
                .as_ref()
                .is_some_and(|text| text.len() > files::MAX_FILE as usize)
            {
                return Err(AppError::new("size", "Backup exceeds the document limit"));
            }
        }
        {
            let mut windows = self.windows.lock_recover();
            let w = windows
                .get_mut(label)
                .ok_or_else(|| AppError::new("window", "Window is not initialized"))?;
            let mut unique = HashSet::new();
            for doc in &documents {
                if !unique.insert(&doc.id) {
                    return Err(AppError::new("document", "Duplicate document snapshot"));
                }
                let previous = w.documents.get(&doc.id);
                if previous.is_some_and(|old| old.version > doc.version) {
                    continue;
                }
                if doc.kind.is_text()
                    && doc.text.is_none()
                    && previous.is_none_or(|old| !old.kind.is_text() || old.version != doc.version)
                {
                    return Err(AppError::new(
                        "document",
                        "The document body must be synchronized before reusing it",
                    ));
                }
            }
            let ids: HashSet<_> = documents.iter().map(|d| d.id.clone()).collect();
            w.documents.retain(|id, _| ids.contains(id));
            w.text_generations.retain(|id, _| ids.contains(id));
            for mut doc in documents {
                if w.documents
                    .get(&doc.id)
                    .is_none_or(|m| m.version <= doc.version)
                {
                    let text = if let Some(text) = doc.text.take() {
                        w.next_text_generation += 1;
                        w.text_generations
                            .insert(doc.id.clone(), w.next_text_generation);
                        text
                    } else if doc.kind.is_text() {
                        // Move, rather than clone, an unchanged body out of the old mirror.
                        w.documents
                            .remove(&doc.id)
                            .map(|old| old.text)
                            .unwrap_or_default()
                    } else {
                        String::new()
                    };
                    w.documents.insert(doc.id.clone(), doc.with_text(text));
                }
            }
            w.session = session;
        }
        self.checkpoint(label)
    }

    pub fn recovery_windows(&self) -> Result<Vec<String>> {
        let mut labels = vec![];
        let mut warnings = self.startup_warnings.lock_recover();
        for entry in fs::read_dir(&self.data_dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(label) = name
                .to_str()
                .and_then(|s| s.strip_prefix("session-"))
                .and_then(|s| s.strip_suffix(".json"))
            else {
                continue;
            };
            if !label.starts_with("editor-")
                || !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            {
                continue;
            }
            let value = crate::configuration::read_json(&entry.path(), &mut warnings);
            if value["documents"]
                .as_array()
                .is_some_and(|docs| docs.iter().any(|d| d["dirty"] == true))
            {
                labels.push(label.to_string());
            }
        }
        labels.sort();
        Ok(labels)
    }

    pub fn grant(&self, label: &str, path: &Path) -> Result<PathBuf> {
        let path = canonical(path)?;
        self.windows
            .lock_recover()
            .entry(label.into())
            .or_default()
            .grants
            .insert(path.clone());
        Ok(path)
    }

    pub fn checkpoint(&self, label: &str) -> Result<()> {
        crate::recovery::checkpoint(self, label)
    }
}

// Own the window/app handle rather than borrowing Tauri State across the task.
pub async fn blocking<T, F>(window: tauri::WebviewWindow, work: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(tauri::WebviewWindow, &AppState) -> Result<T> + Send + 'static,
{
    use tauri::Manager;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || work(window, &app.state::<AppState>()))
        .await
        .map_err(|error| AppError::new("task", error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poisoned_window_and_disk_locks_do_not_disable_backups() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState {
            data_dir: dir.path().into(),
            ..Default::default()
        };
        state
            .windows
            .lock_recover()
            .insert("main".into(), WindowState::default());
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _disk = state.disk_lock.write_recover();
            let _windows = state.windows.lock_recover();
            panic!("failed task");
        }));
        state
            .sync_documents("main", vec![mirror("unsaved", None)], serde_json::json!({}))
            .unwrap();
        assert!(state.data_dir.join("session-main.json").is_file());
        assert_eq!(
            state.windows.lock_recover()["main"].documents["unsaved"].text,
            "unsaved text"
        );
    }

    #[test]
    fn a_busy_window_does_not_block_another_windows_backup() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState {
            data_dir: dir.path().into(),
            ..Default::default()
        });
        state
            .windows
            .lock_recover()
            .insert("other".into(), WindowState::default());
        let gate = state.disk_lock.read_recover();
        let session = state.disk_operation("session:busy".into());
        let busy = session.lock_recover();
        assert!(state.disk_lock.try_write().is_err());
        assert!(Arc::ptr_eq(
            &session,
            &state.disk_operation("session:busy".into())
        ));
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = state.clone();
        let task = std::thread::spawn(move || {
            sender
                .send(worker.sync_documents(
                    "other",
                    vec![mirror("buffer", None)],
                    serde_json::json!({}),
                ))
                .unwrap();
        });
        let result = receiver.recv_timeout(std::time::Duration::from_secs(5));
        drop(busy);
        drop(gate);
        task.join().unwrap();
        result.unwrap().unwrap();
        assert!(state.data_dir.join("session-other.json").is_file());
    }

    fn mirror(id: &str, path: Option<&Path>) -> DocumentSnapshot {
        serde_json::from_value(serde_json::json!({
            "id": id, "path": path.map(|p| p.to_string_lossy()), "text": "unsaved text",
            "version": 1, "revision": null, "encoding": "utf8", "dirty": true
        }))
        .unwrap()
    }

    #[test]
    fn missing_directories_do_not_block_other_buffers_or_relax_file_access() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        let parent = root.join("one/two");
        fs::create_dir_all(&parent).unwrap();
        let path = parent.join("a.txt");
        fs::write(&path, "saved").unwrap();
        let state = AppState {
            data_dir: dir.path().join("data"),
            ..Default::default()
        };
        state.windows.lock_recover().insert(
            "main".into(),
            WindowState {
                root: Some(fs::canonicalize(&root).unwrap()),
                ..Default::default()
            },
        );
        fs::remove_dir_all(root.join("one")).unwrap();
        state
            .sync_documents(
                "main",
                vec![mirror("missing", Some(&path)), mirror("untitled", None)],
                serde_json::json!({}),
            )
            .unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(state.data_dir.join("session-main.json")).unwrap())
                .unwrap();
        assert_eq!(saved["documents"].as_array().unwrap().len(), 2);
        assert_eq!(saved["version"], 2);
        let restored = crate::recovery::load(&state, "main", &mut vec![]);
        assert!(restored.documents.iter().all(|d| d.text == "unsaved text"));
        assert!(state.authorize("main", path.to_str().unwrap()).is_err());
        let outside = root.join("../outside/missing.txt");
        assert!(
            state
                .sync_documents(
                    "main",
                    vec![mirror("outside", Some(&outside))],
                    serde_json::json!({})
                )
                .is_err()
        );
        assert!(
            state
                .sync_documents(
                    "main",
                    vec![mirror("outside", Some(&dir.path().join("outside/a.txt")))],
                    serde_json::json!({})
                )
                .is_err()
        );
        assert_eq!(state.windows.lock_recover()["main"].documents.len(), 2);
    }

    #[test]
    fn a_granted_loose_file_can_be_backed_up_after_its_ancestors_disappear() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("loose/sub");
        fs::create_dir_all(&parent).unwrap();
        let path = parent.join("a.txt");
        fs::write(&path, "saved").unwrap();
        let state = AppState {
            data_dir: dir.path().join("data"),
            ..Default::default()
        };
        state.grant("main", &path).unwrap();
        fs::remove_dir_all(dir.path().join("loose")).unwrap();
        state
            .sync_documents(
                "main",
                vec![mirror("loose", Some(&path))],
                serde_json::json!({}),
            )
            .unwrap();
        assert!(state.data_dir.join("session-main.json").is_file());
        assert!(state.authorize("main", path.to_str().unwrap()).is_err());
    }

    #[test]
    fn workspace_trust_is_explicit_persistent_and_bound_to_the_selected_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        let other = dir.path().join("other");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::create_dir(root.join(".litecode")).unwrap();
        fs::write(
            root.join(".litecode/settings.json"),
            r#"{"litecode.trusted":true}"#,
        )
        .unwrap();
        let state = AppState {
            data_dir: dir.path().join("data"),
            ..Default::default()
        };
        state.windows.lock_recover().insert(
            "main".into(),
            WindowState {
                root: Some(fs::canonicalize(&root).unwrap()),
                ..Default::default()
            },
        );
        assert_eq!(
            state.require_workspace_trust("main").unwrap_err().code,
            "workspaceTrust"
        );
        assert!(
            state
                .set_workspace_trust("main", other.to_str().unwrap(), true)
                .is_err()
        );
        state
            .set_workspace_trust("main", root.to_str().unwrap(), true)
            .unwrap();
        assert_eq!(
            state.require_workspace_trust("main").unwrap(),
            Some(fs::canonicalize(&root).unwrap())
        );
        let restarted = AppState {
            data_dir: state.data_dir.clone(),
            ..Default::default()
        };
        restarted.windows.lock_recover().insert(
            "main".into(),
            WindowState {
                root: Some(fs::canonicalize(&root).unwrap()),
                ..Default::default()
            },
        );
        assert!(restarted.require_workspace_trust("main").is_ok());
        restarted
            .set_workspace_trust("main", root.to_str().unwrap(), false)
            .unwrap();
        assert_eq!(
            state.require_workspace_trust("main").unwrap_err().code,
            "workspaceTrust"
        );
        state.windows.lock_recover().get_mut("main").unwrap().root =
            Some(fs::canonicalize(&other).unwrap());
        assert!(
            state
                .set_workspace_trust("main", root.to_str().unwrap(), true)
                .is_err()
        );
        assert_eq!(
            state.require_workspace_trust("unknown").unwrap_err().code,
            "window"
        );
    }

    #[test]
    fn recovery_discovers_dirty_secondary_windows_without_reusing_or_deleting_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState {
            data_dir: dir.path().into(),
            ..Default::default()
        };
        for label in [
            "main",
            "editor-empty-123-0",
            "editor-project",
            "editor-clean",
        ] {
            state
                .windows
                .lock_recover()
                .insert(label.into(), WindowState::default());
            let mut doc = mirror(label, None);
            doc.dirty = label != "editor-clean";
            state
                .sync_documents(
                    label,
                    vec![doc],
                    serde_json::json!({"activeGroup": "original"}),
                )
                .unwrap();
        }
        fs::write(dir.path().join("session-editor-bad.json"), "broken").unwrap();
        assert_eq!(
            state.recovery_windows().unwrap(),
            vec!["editor-empty-123-0", "editor-project"]
        );
        assert_eq!(
            state.recovery_windows().unwrap(),
            vec!["editor-empty-123-0", "editor-project"]
        );
        assert!(dir.path().join("session-editor-empty-123-0.json").is_file());
        assert!(!state.startup_warnings.lock_recover().is_empty());
    }

    #[test]
    fn scope_rejects_siblings_and_parent_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(dir.path().join("secret"), "secret").unwrap();
        let state = AppState::default();
        state.windows.lock_recover().insert(
            "main".into(),
            WindowState {
                root: Some(fs::canonicalize(&root).unwrap()),
                ..Default::default()
            },
        );
        assert!(
            state
                .authorize("main", root.join("new").to_str().unwrap())
                .is_ok()
        );
        assert!(
            state
                .authorize("main", root.join("../secret").to_str().unwrap())
                .is_err()
        );
        assert!(
            state
                .authorize("other", root.join("new").to_str().unwrap())
                .is_err()
        );
    }
}
