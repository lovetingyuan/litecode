use crate::sync::MutexExt;
use crate::{
    error::{AppError, Result},
    state::AppState,
};
use git2::{Repository, Status, StatusOptions};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{Emitter, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySnapshot {
    pub root: String,
    pub session: u64,
    pub directory: String,
    pub paths: Vec<String>,
    pub warnings: Vec<String>,
}

pub fn read_directory(root: &Path, directory: &str, session: u64) -> Result<DirectorySnapshot> {
    let canonical_root = std::fs::canonicalize(root)?;
    let root = canonical_root.as_path();
    // Directory arguments are workspace-relative; never traverse through a symlink.
    let relative = Path::new(directory);
    if relative
        .components()
        .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(AppError::new("access", "Invalid workspace directory"));
    }
    let mut target = root.to_path_buf();
    for component in relative.components() {
        target.push(component);
        if std::fs::symlink_metadata(&target)?.file_type().is_symlink() {
            return Err(AppError::new("access", "Cannot expand a symbolic link"));
        }
    }
    let target = std::fs::canonicalize(target)?;
    if !target.starts_with(root) {
        return Err(AppError::new(
            "access",
            "Directory is outside the workspace",
        ));
    }
    let directory = target
        .strip_prefix(root)
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    let mut snapshot = DirectorySnapshot {
        root: crate::tools::process_path(root)
            .to_string_lossy()
            .into_owned(),
        session,
        directory: if directory.is_empty() {
            directory
        } else {
            format!("{directory}/")
        },
        paths: vec![],
        warnings: vec![],
    };
    for entry in std::fs::read_dir(target)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                snapshot.warnings.push(error.to_string());
                continue;
            }
        };
        if entry.file_name() == ".git" {
            continue;
        }
        match entry.file_type() {
            Ok(kind) => snapshot.paths.push(format!(
                "{}{}{}",
                snapshot.directory,
                entry.file_name().to_string_lossy(),
                if kind.is_dir() { "/" } else { "" }
            )),
            Err(error) => snapshot.warnings.push(error.to_string()),
        }
    }
    Ok(snapshot)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub root: String,
    pub session: u64,
    pub git: Vec<GitEntry>,
    pub branch: Option<String>,
    pub warnings: Vec<String>,
    pub repositories: Vec<crate::git::Snapshot>,
}

#[derive(Clone, Serialize)]
pub struct GitEntry {
    pub path: String,
    pub status: String,
}

#[derive(Default)]
pub struct RepositoryIndex {
    pub repositories: Mutex<HashSet<PathBuf>>,
    pub complete: AtomicBool,
    discovery_lock: Mutex<()>,
    pub status_lock: Mutex<()>,
    versions: Mutex<HashMap<PathBuf, u64>>,
    cache: Mutex<HashMap<PathBuf, (u64, crate::git::Snapshot, Vec<GitEntry>)>>,
}

impl RepositoryIndex {
    pub fn invalidate(&self) {
        for version in self.versions.lock_recover().values_mut() {
            *version += 1;
        }
    }
    fn invalidate_path(&self, path: &Path) {
        let mut versions = self.versions.lock_recover();
        let matches = versions.keys().any(|root| path.starts_with(root));
        for (root, version) in versions.iter_mut() {
            if !matches || path.starts_with(root) {
                *version += 1;
            }
        }
    }
}

pub fn discover_repositories(root: &Path, index: &RepositoryIndex, cancelled: impl Fn() -> bool) {
    let _discovery = index.discovery_lock.lock_recover();
    if index.complete.load(Ordering::Acquire) {
        return;
    }
    let owner = Repository::discover(root).ok();
    let owner_root = owner
        .as_ref()
        .and_then(|repo| repo.workdir())
        .and_then(|path| std::fs::canonicalize(path).ok());
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.file_name() == ".git" {
                return false;
            }
            if e.depth() > 0
                && e.file_type().is_dir()
                && let Some(repo) = &owner
                && let Some(relative) = owner_root
                    .as_ref()
                    .and_then(|base| e.path().strip_prefix(base).ok())
                && repo
                    .status_should_ignore(Path::new(&format!(
                        "{}/",
                        relative.to_string_lossy().replace('\\', "/")
                    )))
                    .unwrap_or(false)
            {
                return false;
            }
            true
        })
    {
        if cancelled() {
            return;
        }
        if let Ok(entry) = entry
            && entry.file_type().is_dir()
            && entry.path().join(".git").exists()
        {
            index
                .repositories
                .lock_recover()
                .insert(entry.path().into());
        }
    }
    index.complete.store(true, Ordering::Release);
}

pub fn git_snapshot(root: &Path, index: &RepositoryIndex, session: u64) -> Result<GitSnapshot> {
    let _status = index.status_lock.lock_recover();
    if !root.is_dir() {
        return Err(AppError::new(
            "workspaceMissing",
            "Workspace directory no longer exists",
        ));
    }
    let mut snapshot = GitSnapshot {
        root: crate::tools::process_path(root)
            .to_string_lossy()
            .into_owned(),
        session,
        git: vec![],
        branch: None,
        warnings: vec![],
        repositories: vec![],
    };
    let mut repositories = index.repositories.lock_recover().clone();
    if let Ok(repo) = Repository::discover(root) {
        if let Some(workdir) = repo.workdir() {
            repositories
                .insert(std::fs::canonicalize(workdir).unwrap_or_else(|_| workdir.to_path_buf()));
        }
        snapshot.branch = crate::git::current_branch(&repo);
    }
    for repo_path in repositories {
        let version = *index
            .versions
            .lock_recover()
            .entry(repo_path.clone())
            .or_default();
        if let Some((cached_version, repository, git)) = index.cache.lock_recover().get(&repo_path)
            && *cached_version == version
        {
            snapshot.repositories.push(repository.clone());
            for entry in git {
                let full = repo_path.join(&entry.path);
                if let Ok(relative) = full.strip_prefix(root) {
                    let mut path = relative.to_string_lossy().replace('\\', "/");
                    if entry.path.ends_with('/') && !path.ends_with('/') {
                        path.push('/');
                    }
                    snapshot.git.push(GitEntry {
                        path,
                        status: entry.status.clone(),
                    });
                }
            }
            continue;
        }
        let repo = match Repository::open(&repo_path) {
            Ok(repo) => repo,
            Err(error) => {
                // A .git/hooks leftover is not a repository. Keep genuine open errors visible.
                if error.code() != git2::ErrorCode::NotFound && repo_path.join(".git").exists() {
                    snapshot.warnings.push(error.to_string());
                }
                continue;
            }
        };
        let mut options = StatusOptions::new();
        options
            .update_index(false)
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(true)
            .recurse_ignored_dirs(false)
            .renames_head_to_index(true)
            .renames_index_to_workdir(true);
        match repo.statuses(Some(&mut options)) {
            Ok(statuses) => {
                let repository = crate::git::snapshot(&repo, &statuses);
                let mut cached = vec![];
                for entry in statuses.iter() {
                    let Some(relative) = entry.path() else {
                        continue;
                    };
                    // Path operations on Windows strip a trailing separator.
                    // The tree needs it to inherit ignored directory statuses.
                    let is_directory = relative.ends_with('/');
                    let full = repo_path.join(relative);
                    let s = entry.status();
                    let status = if s.is_conflicted() {
                        "conflicted"
                    } else if s.is_ignored() {
                        "ignored"
                    } else if s.intersects(Status::WT_NEW) {
                        "untracked"
                    } else if s.intersects(Status::WT_DELETED | Status::INDEX_DELETED) {
                        "deleted"
                    } else if s.intersects(Status::WT_RENAMED | Status::INDEX_RENAMED) {
                        "renamed"
                    } else if s.intersects(Status::INDEX_NEW) {
                        "added"
                    } else {
                        "modified"
                    };
                    let mut path = relative.replace('\\', "/");
                    if is_directory && !path.ends_with('/') {
                        path.push('/');
                    }
                    cached.push(GitEntry {
                        path,
                        status: status.into(),
                    });
                    if let Ok(relative) = full.strip_prefix(root) {
                        let mut path = relative.to_string_lossy().replace('\\', "/");
                        if is_directory && !path.ends_with('/') {
                            path.push('/');
                        }
                        snapshot.git.push(GitEntry {
                            path,
                            status: status.into(),
                        });
                    }
                }
                index
                    .cache
                    .lock_recover()
                    .insert(repo_path.clone(), (version, repository.clone(), cached));
                snapshot.repositories.push(repository);
            }
            Err(e) => snapshot.warnings.push(e.to_string()),
        };
    }
    snapshot.repositories.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(snapshot)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChange {
    pub path: String,
    pub structural: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChanges {
    pub root: String,
    pub session: u64,
    pub changes: Vec<WorkspaceChange>,
    pub rescan: bool,
    pub git_changed: bool,
    pub file_index_changed: bool,
    pub git_paths: Vec<String>,
}

#[derive(Default)]
pub struct ChangeQueue {
    paths: HashMap<String, bool>,
    git_paths: HashSet<String>,
    rescan: bool,
    git_changed: bool,
    file_index_changed: bool,
}
impl ChangeQueue {
    fn push(&mut self, root: &Path, event: notify::Result<notify::Event>) {
        let event = match event {
            Ok(event) => event,
            Err(_) => {
                self.rescan = true;
                self.git_changed = true;
                self.paths.clear();
                return;
            }
        };
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        self.git_changed = true;
        if event.need_rescan()
            || matches!(
                event.kind,
                notify::EventKind::Any | notify::EventKind::Other
            )
            || event.paths.is_empty()
        {
            self.rescan = true;
            self.paths.clear();
            return;
        }
        let structural = matches!(
            event.kind,
            notify::EventKind::Create(_)
                | notify::EventKind::Remove(_)
                | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
        );
        for path in event.paths {
            let Ok(relative) = path.strip_prefix(root) else {
                self.rescan = true;
                continue;
            };
            let path = relative.to_string_lossy().replace('\\', "/");
            if path.split('/').any(|part| part == ".git") {
                if path.ends_with("/info/exclude") || path.ends_with("/.git/config") {
                    self.file_index_changed = true;
                }
                if !self.rescan {
                    self.paths.entry(path).or_insert(false);
                }
                if self.paths.len() > 4096 {
                    self.paths.clear();
                    self.rescan = true;
                }
                continue;
            }
            if matches!(
                event.kind,
                notify::EventKind::Modify(notify::event::ModifyKind::Any)
            ) {
                self.paths.clear();
                self.rescan = true;
            }
            if self.rescan {
                continue;
            }
            self.paths
                .entry(path)
                .and_modify(|value| *value |= structural)
                .or_insert(structural);
            if self.paths.len() > 4096 {
                self.paths.clear();
                self.rescan = true;
            }
        }
    }
    fn take(&mut self, root: &Path, session: u64) -> Option<WorkspaceChanges> {
        if self.paths.is_empty() && !self.rescan && !self.git_changed {
            return None;
        }
        Some(WorkspaceChanges {
            root: crate::tools::process_path(root)
                .to_string_lossy()
                .into_owned(),
            session,
            changes: self
                .paths
                .drain()
                .map(|(path, structural)| WorkspaceChange { path, structural })
                .collect(),
            rescan: std::mem::take(&mut self.rescan),
            git_changed: std::mem::take(&mut self.git_changed),
            file_index_changed: std::mem::take(&mut self.file_index_changed),
            git_paths: self.git_paths.drain().collect(),
        })
    }
}

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
fn ignored_watch_path(path: &Path) -> bool {
    let value = path.to_string_lossy().replace('\\', "/");
    value.contains("/.git/objects/")
        || value.contains("/.git/logs/")
        || (value.contains("/.git/") && value.ends_with(".lock"))
}

pub fn watch(app: &tauri::AppHandle, label: &str, root: PathBuf) -> Result<()> {
    let pending = Arc::new(Mutex::new(ChangeQueue::default()));
    let dirty = pending.clone();
    let repositories = Arc::new(RepositoryIndex::default());
    let watched_repositories = repositories.clone();
    let watched_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = &event {
            if event.need_rescan() || event.paths.is_empty() {
                watched_repositories.invalidate();
            }
            if matches!(event.kind, notify::EventKind::Access(_)) {
                return;
            }
            if !event.paths.is_empty() && event.paths.iter().all(|path| ignored_watch_path(path)) {
                return;
            }
            for path in &event.paths {
                watched_repositories.invalidate_path(path);
                if !path.starts_with(&watched_root) {
                    continue;
                }
                if let Some(metadata) = path
                    .ancestors()
                    .find(|path| path.file_name().is_some_and(|name| name == ".git"))
                    && let Some(repository) = metadata.parent()
                {
                    watched_repositories
                        .repositories
                        .lock_recover()
                        .insert(repository.to_path_buf());
                }
            }
        } else {
            watched_repositories.invalidate();
        }
        let mut queue = dirty.lock_recover();
        if event.as_ref().is_ok_and(|event| {
            !event.paths.is_empty() && event.paths.iter().all(|p| !p.starts_with(&watched_root))
        }) {
            queue.git_changed = true;
            if let Ok(event) = &event {
                for path in &event.paths {
                    queue.git_paths.insert(crate::git::visible(path));
                }
                if queue.git_paths.len() > 4096 {
                    queue.git_paths.clear();
                    queue.rescan = true;
                }
            }
        } else {
            queue.push(&watched_root, event);
        }
    })
    .map_err(|e| AppError::new("watch", e.to_string()))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| AppError::new("watch", e.to_string()))?;
    if let Ok(repo) = Repository::discover(&root) {
        watch_git_paths(&mut watcher, &repo, &root);
    }
    let session = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    {
        let state = app.state::<AppState>();
        let mut windows = state.windows.lock_recover();
        let window = windows.entry(label.into()).or_default();
        window.watcher = Some(watcher);
        window.workspace_session = session;
        window.repositories = repositories.clone();
        window.git_blame = Default::default();
    }
    let handle = app.clone();
    let label_owned = label.to_owned();
    let root_owned = root.clone();
    let discovering = pending.clone();
    let discovery_handle = app.clone();
    let discovery_label = label.to_owned();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(350));
        discover_repositories(&root_owned, &repositories, || {
            discovery_handle
                .state::<AppState>()
                .windows
                .lock_recover()
                .get(&discovery_label)
                .is_none_or(|window| window.workspace_session != session)
        });
        let roots = repositories.repositories.lock_recover().clone();
        let state = discovery_handle.state::<AppState>();
        let mut windows = state.windows.lock_recover();
        if let Some(window) = windows
            .get_mut(&discovery_label)
            .filter(|w| w.workspace_session == session)
            && let Some(watcher) = &mut window.watcher
        {
            for root in roots {
                if let Ok(repo) = Repository::open(root) {
                    watch_git_paths(watcher, &repo, &root_owned);
                }
            }
        }
        discovering.lock_recover().git_changed = true;
    });
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(350));
            let state = handle.state::<AppState>();
            if state
                .windows
                .lock_recover()
                .get(&label_owned)
                .is_none_or(|window| window.workspace_session != session)
            {
                break;
            }
            let event = pending.lock_recover().take(&root, session);
            if let Some(event) = event {
                let _ = handle.emit_to(label_owned.as_str(), "workspace-changed", event);
            }
        }
    });
    Ok(())
}

fn watch_git_paths(watcher: &mut notify::RecommendedWatcher, repo: &Repository, root: &Path) {
    if let Some(workdir) = repo.workdir().and_then(|p| std::fs::canonicalize(p).ok())
        && !workdir.starts_with(root)
    {
        let _ = watcher.watch(&workdir, RecursiveMode::Recursive);
    }
    let mut metadata = vec![repo.path().to_path_buf()];
    if let Ok(common) = std::fs::read_to_string(repo.path().join("commondir")) {
        metadata.push(repo.path().join(common.trim()));
    }
    for path in metadata {
        if let Ok(path) = std::fs::canonicalize(path)
            && !path.starts_with(root)
        {
            let _ = watcher.watch(&path, RecursiveMode::Recursive);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_git(root: &Path) -> GitSnapshot {
        let index = RepositoryIndex::default();
        discover_repositories(root, &index, || false);
        git_snapshot(root, &index, 0).unwrap()
    }

    #[test]
    #[ignore = "read-only benchmark; requires LITECODE_BENCH_ROOT"]
    fn existing_workspace_performance() {
        use std::time::Instant;
        let requested = std::env::var("LITECODE_BENCH_ROOT")
            .expect("Set LITECODE_BENCH_ROOT to an existing read-only test project");
        let root = std::fs::canonicalize(requested).unwrap();
        // This branch never initializes repositories, writes fixtures, or changes the target.
        let started = Instant::now();
        let first_directory = read_directory(&root, "", 1).unwrap();
        let first_directory_ms = started.elapsed().as_secs_f64() * 1000.0;
        println!(
            "first root read: {first_directory_ms:.3} ms, {} entries",
            first_directory.paths.len()
        );
        let index = RepositoryIndex::default();
        let started = Instant::now();
        discover_repositories(&root, &index, || false);
        let discovery_ms = started.elapsed().as_secs_f64() * 1000.0;
        let count = walkdir::WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| entry.file_name() != ".git")
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.depth() > 0)
            .count();
        let child_path = first_directory
            .paths
            .iter()
            .find(|path| path.as_str() == "apps/")
            .or_else(|| {
                first_directory
                    .paths
                    .iter()
                    .find(|path| path.ends_with('/') && !path.starts_with('.'))
            })
            .cloned()
            .unwrap_or_default();
        println!("workspace entries: {count}; repository discovery: {discovery_ms:.3} ms");
        let mut samples = vec![];
        for iteration in 0..6 {
            let started = Instant::now();
            let legacy_index = RepositoryIndex::default();
            let mut paths = vec![];
            for entry in walkdir::WalkDir::new(&root)
                .follow_links(false)
                .into_iter()
                .filter_entry(|entry| entry.file_name() != ".git")
            {
                let Ok(entry) = entry else {
                    continue;
                };
                if entry.depth() == 0 {
                    continue;
                }
                if paths.len() >= 200_000 {
                    break;
                }
                if entry.file_type().is_dir() && entry.path().join(".git").exists() {
                    legacy_index
                        .repositories
                        .lock_recover()
                        .insert(entry.path().into());
                }
                let mut path = entry
                    .path()
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if entry.file_type().is_dir() {
                    path.push('/');
                }
                paths.push(path);
            }
            let git = git_snapshot(&root, &legacy_index, 1).unwrap();
            let legacy_ms = started.elapsed().as_secs_f64() * 1000.0;
            let started = Instant::now();
            let legacy_bytes = serde_json::to_vec(&serde_json::json!({"paths":paths,"git":git.git,"branch":git.branch,"warnings":git.warnings,"truncated":count>200000})).unwrap().len();
            let legacy_serialize_ms = started.elapsed().as_secs_f64() * 1000.0;
            let started = Instant::now();
            let directory = read_directory(&root, "", 1).unwrap();
            let directory_ms = started.elapsed().as_secs_f64() * 1000.0;
            let started = Instant::now();
            let directory_bytes = serde_json::to_vec(&directory).unwrap().len();
            let directory_serialize_ms = started.elapsed().as_secs_f64() * 1000.0;
            let started = Instant::now();
            let child = read_directory(&root, child_path.trim_end_matches('/'), 1).unwrap();
            let child_ms = started.elapsed().as_secs_f64() * 1000.0;
            let started = Instant::now();
            let _ = git_snapshot(&root, &index, 1).unwrap();
            let git_ms = started.elapsed().as_secs_f64() * 1000.0;
            let sample = serde_json::json!({"iteration":iteration,"legacyMs":legacy_ms,"legacySerializationMs":legacy_serialize_ms,"directoryMs":directory_ms,"directorySerializationMs":directory_serialize_ms,"childMs":child_ms,"gitMs":git_ms,"legacyBytes":legacy_bytes,"directoryBytes":directory_bytes,"legacyEntries":paths.len(),"directoryEntries":directory.paths.len(),"childEntries":child.paths.len()});
            println!("{sample}");
            samples.push(sample);
        }
        let output = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".verification/lazy-explorer");
        std::fs::create_dir_all(&output).unwrap();
        std::fs::write(output.join("existing-backend.json"), serde_json::to_vec_pretty(&serde_json::json!({"root":root,"entries":count,"firstDirectoryMs":first_directory_ms,"discoveryMs":discovery_ms,"child":child_path,"samples":samples,"cacheNote":"First root read precedes this process's traversal. OS disk caches were not cleared; repeated samples are warm."})).unwrap()).unwrap();
    }

    #[test]
    fn dependency_lock_files_are_watched_while_git_internal_locks_are_ignored() {
        for path in [
            "/workspace/Cargo.lock",
            "/workspace/yarn.lock",
            "/workspace/folder/custom.lock",
        ] {
            assert!(!ignored_watch_path(Path::new(path)));
        }
        for path in [
            "/workspace/.git/index.lock",
            "/workspace/.git/objects/ab/cd",
            "/workspace/.git/logs/HEAD",
        ] {
            assert!(ignored_watch_path(Path::new(path)));
        }
    }

    #[test]
    fn watcher_events_keep_paths_and_coalesce_structural_changes() {
        use notify::{
            Event, EventKind,
            event::{CreateKind, ModifyKind, RenameMode},
        };
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut queue = ChangeQueue::default();
        queue.push(
            root,
            Ok(Event::new(EventKind::Modify(ModifyKind::Data(
                notify::event::DataChange::Any,
            )))
            .add_path(root.join("src/a.txt"))),
        );
        queue.push(
            root,
            Ok(Event::new(EventKind::Create(CreateKind::File)).add_path(root.join("src/a.txt"))),
        );
        queue.push(
            root,
            Ok(
                Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                    .add_path(root.join("src/old.txt"))
                    .add_path(root.join("other/new.txt")),
            ),
        );
        queue.push(
            root,
            Ok(Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.join(".git/HEAD"))),
        );
        let event = queue.take(root, 9).unwrap();
        assert_eq!(event.session, 9);
        assert!(event.git_changed);
        assert!(!event.rescan);
        assert_eq!(event.changes.len(), 4);
        assert_eq!(
            event
                .changes
                .iter()
                .filter(|change| change.structural)
                .count(),
            3
        );
        assert!(queue.take(root, 9).is_none());
    }

    #[test]
    fn watcher_overflow_and_errors_request_recovery() {
        use notify::{Event, EventKind, event::CreateKind};
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut queue = ChangeQueue::default();
        for number in 0..4200 {
            queue.push(
                root,
                Ok(Event::new(EventKind::Create(CreateKind::File))
                    .add_path(root.join(format!("{number}.txt")))),
            );
        }
        let event = queue.take(root, 1).unwrap();
        assert!(event.rescan);
        assert!(event.changes.is_empty());
        queue.push(root, Err(notify::Error::generic("watcher failed")));
        assert!(queue.take(root, 1).unwrap().rescan);
    }

    #[test]
    fn git_queries_keep_nested_repositories_without_building_a_file_index() {
        let (_directory, root, _repo) = fixture(&[("root.txt", "a"), ("nested/child.txt", "b")]);
        Repository::init(root.join("nested")).unwrap();
        let index = RepositoryIndex::default();
        discover_repositories(&root, &index, || false);
        assert!(index.complete.load(Ordering::Acquire));
        assert_eq!(index.repositories.lock_recover().len(), 2);
        let snapshot = git_snapshot(&root, &index, 1).unwrap();
        assert_eq!(status(&snapshot, "nested/child.txt"), Some("untracked"));
    }

    #[test]
    fn discovery_skips_ignored_dependencies_but_keeps_regular_nested_repositories() {
        let (_directory, root, _repo) = fixture(&[(".gitignore", "node_modules/\ntmp/\n")]);
        Repository::init(root.join("node_modules/ignored-repo")).unwrap();
        Repository::init(root.join("tmp/build-fixture")).unwrap();
        Repository::init(root.join("packages/nested")).unwrap();
        let index = RepositoryIndex::default();
        discover_repositories(&root, &index, || false);
        let roots = index.repositories.lock_recover();
        assert!(roots.contains(&root.join("packages/nested")));
        assert!(!roots.contains(&root.join("node_modules/ignored-repo")));
        assert!(!roots.contains(&root.join("tmp/build-fixture")));
    }

    #[test]
    fn leftover_git_hooks_do_not_report_a_missing_nested_repository() {
        let (_directory, root, _repo) =
            fixture(&[("root.txt", "visible"), ("apps/aipkb/file.txt", "visible")]);
        // Hook installers can leave a .git/hooks directory inside a monorepo app.
        std::fs::create_dir_all(root.join("apps/aipkb/.git/hooks")).unwrap();
        let snapshot = test_git(&root);
        assert!(snapshot.warnings.is_empty(), "{:?}", snapshot.warnings);
        assert_eq!(status(&snapshot, "root.txt"), Some("untracked"));

        let subtree = test_git(&root.join("apps/aipkb"));
        assert!(subtree.warnings.is_empty(), "{:?}", subtree.warnings);
    }

    #[test]
    fn unreadable_repository_configuration_still_reports_a_warning() {
        let (_directory, root, repo) = fixture(&[("file.txt", "visible")]);
        let config = repo.path().join("config");
        drop(repo);
        std::fs::write(config, "[invalid\n").unwrap();
        let snapshot = test_git(&root);
        assert!(!snapshot.warnings.is_empty());
    }

    #[test]
    fn directory_reads_only_children_and_keeps_empty_and_ignored_directories() {
        let (_directory, root, _repo) = fixture(&[
            (".gitignore", "generated/\n"),
            ("generated/deep/a.txt", "a"),
            ("src/main.rs", "a"),
        ]);
        std::fs::create_dir(root.join("empty")).unwrap();
        let mut snapshot = read_directory(&root, "", 7).unwrap();
        snapshot.paths.sort();
        assert_eq!(
            snapshot.paths,
            [".gitignore", "empty/", "generated/", "src/"]
        );
        assert_eq!(snapshot.session, 7);
        assert_eq!(
            read_directory(&root, "generated", 7).unwrap().paths,
            ["generated/deep/"]
        );
        assert!(read_directory(&root, "empty", 7).unwrap().paths.is_empty());
        assert!(read_directory(&root, "../", 7).is_err());
        assert!(read_directory(&root, root.to_str().unwrap(), 7).is_err());
        assert!(read_directory(&root, "missing", 7).is_err());
    }

    fn fixture(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf, Repository) {
        let directory = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        let repo = Repository::init(&root).unwrap();
        for (path, text) in files {
            let path = root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        (directory, root, repo)
    }

    fn status<'a>(snapshot: &'a GitSnapshot, path: &str) -> Option<&'a str> {
        snapshot
            .git
            .iter()
            .find(|g| g.path == path)
            .map(|g| g.status.as_str())
    }

    #[test]
    fn ignored_directories_keep_trailing_slashes_and_compact_statuses() {
        let (_directory, root, _repo) = fixture(&[
            (".gitignore", "build/\n"),
            ("build/deep/file.txt", "ignored"),
            ("build-other/visible.txt", "visible"),
        ]);
        let snapshot = test_git(&root);
        assert!(
            read_directory(&root, "build/deep", 0)
                .unwrap()
                .paths
                .contains(&"build/deep/file.txt".to_owned())
        );
        assert_eq!(status(&snapshot, "build/"), Some("ignored"));
        assert_eq!(status(&snapshot, "build/deep/file.txt"), None);
        assert_eq!(
            status(&snapshot, "build-other/visible.txt"),
            Some("untracked")
        );
    }

    #[test]
    fn nested_rules_negations_and_rule_changes_follow_git() {
        let (_directory, root, repo) = fixture(&[
            (".gitignore", "*.log\n!keep.log\n"),
            ("drop.log", "ignored"),
            ("keep.log", "visible"),
            ("src/.gitignore", "!keep.log\ncache/\n"),
            ("src/drop.log", "ignored"),
            ("src/keep.log", "visible"),
            ("src/cache/file.txt", "ignored"),
        ]);
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("drop.log")).unwrap();
        index.write().unwrap();
        let snapshot = test_git(&root);
        assert_ne!(status(&snapshot, "drop.log"), Some("ignored"));
        assert_eq!(status(&snapshot, "keep.log"), Some("untracked"));
        assert_eq!(status(&snapshot, "src/drop.log"), Some("ignored"));
        assert_eq!(status(&snapshot, "src/keep.log"), Some("untracked"));
        assert_eq!(status(&snapshot, "src/cache/"), Some("ignored"));
        let subtree = test_git(&root.join("src"));
        assert_eq!(status(&subtree, "drop.log"), Some("ignored"));
        assert_eq!(status(&subtree, "cache/"), Some("ignored"));
        std::fs::remove_file(root.join("src/.gitignore")).unwrap();
        std::fs::write(root.join(".gitignore"), "").unwrap();
        let updated = test_git(&root);
        assert_eq!(status(&updated, "src/drop.log"), Some("untracked"));
        assert_eq!(status(&updated, "src/cache/file.txt"), Some("untracked"));
    }

    #[test]
    fn plain_folders_do_not_apply_gitignore() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join(".gitignore"), "file.txt\n").unwrap();
        std::fs::write(directory.path().join("file.txt"), "visible").unwrap();
        let snapshot = test_git(directory.path());
        assert!(
            read_directory(directory.path(), "", 0)
                .unwrap()
                .paths
                .contains(&"file.txt".to_owned())
        );
        assert!(snapshot.git.is_empty());
    }

    #[test]
    fn canonical_windows_roots_keep_git_status_and_ignored_files() {
        let directory = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        let repo = Repository::init(&root).unwrap();
        std::fs::write(root.join("tracked.txt"), "before").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        index.write().unwrap();
        let oid = index.write_tree().unwrap();
        let tree = repo.find_tree(oid).unwrap();
        let signature = git2::Signature::now("LiteCode Test", "test@example.invalid").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "fixture", &tree, &[])
            .unwrap();
        std::fs::write(root.join("tracked.txt"), "after").unwrap();
        std::fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(root.join("ignored.txt"), "ignored").unwrap();
        std::fs::write(root.join("new.txt"), "new").unwrap();
        let snapshot = test_git(&root);
        assert!(
            read_directory(&root, "", 0)
                .unwrap()
                .paths
                .contains(&"ignored.txt".to_owned())
        );
        assert!(
            snapshot
                .git
                .iter()
                .any(|g| g.path == "tracked.txt" && g.status == "modified")
        );
        assert!(
            snapshot
                .git
                .iter()
                .any(|g| g.path == "ignored.txt" && g.status == "ignored")
        );
        assert!(
            snapshot
                .git
                .iter()
                .any(|g| g.path == "new.txt" && g.status == "untracked")
        );
    }
}
