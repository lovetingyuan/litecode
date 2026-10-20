use crate::{
    error::{AppError, Result},
    files,
};
use notify::RecommendedWatcher;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64},
    },
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mirror {
    pub id: String,
    pub path: Option<String>,
    pub text: String,
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

#[derive(Default)]
pub struct WindowState {
    pub root: Option<PathBuf>,
    pub grants: HashSet<PathBuf>,
    pub documents: HashMap<String, Mirror>,
    pub watcher: Option<RecommendedWatcher>,
    pub session: serde_json::Value,
    pub drops: HashMap<String, Vec<PathBuf>>,
}

pub struct SearchTask {
    pub cancelled: AtomicBool,
    pub acknowledged: AtomicU64,
}

#[derive(Default)]
pub struct AppState {
    pub tool_lock: tokio::sync::Mutex<()>,
    pub windows: Mutex<HashMap<String, WindowState>>,
    pub disk_lock: Mutex<()>,
    pub searches: Mutex<HashMap<String, Arc<SearchTask>>>,
    pub servers: Mutex<HashMap<String, crate::lsp::Server>>,
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

impl AppState {
    pub fn authorize(&self, label: &str, path: &str) -> Result<PathBuf> {
        let path = canonical(Path::new(path))?;
        let windows = self.windows.lock().unwrap();
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

    pub fn grant(&self, label: &str, path: &Path) -> Result<PathBuf> {
        let path = canonical(path)?;
        self.windows
            .lock()
            .unwrap()
            .entry(label.into())
            .or_default()
            .grants
            .insert(path.clone());
        Ok(path)
    }

    pub fn checkpoint(&self, label: &str) -> Result<()> {
        let windows = self.windows.lock().unwrap();
        let Some(window) = windows.get(label) else {
            return Ok(());
        };
        let data = serde_json::json!({"root": window.root, "session": window.session, "documents": window.documents.values().collect::<Vec<_>>()});
        files::atomic_write(
            &self.data_dir.join(format!("session-{label}.json")),
            &serde_json::to_vec(&data)?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scope_rejects_siblings_and_parent_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(dir.path().join("secret"), "secret").unwrap();
        let state = AppState::default();
        state.windows.lock().unwrap().insert(
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
