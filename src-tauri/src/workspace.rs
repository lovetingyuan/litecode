use crate::{
    error::{AppError, Result},
    state::AppState,
};
use git2::{Repository, Status, StatusOptions};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{Emitter, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeSnapshot {
    pub paths: Vec<String>,
    pub git: Vec<GitEntry>,
    pub branch: Option<String>,
    pub warnings: Vec<String>,
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct GitEntry {
    pub path: String,
    pub status: String,
}

pub fn scan(root: &Path) -> Result<TreeSnapshot> {
    if !root.is_dir() {
        return Err(AppError::new(
            "workspaceMissing",
            "Workspace directory no longer exists",
        ));
    }
    let mut snapshot = TreeSnapshot {
        paths: vec![],
        git: vec![],
        branch: None,
        warnings: vec![],
        truncated: false,
    };
    let mut repositories = HashSet::new();
    if let Ok(repo) = Repository::discover(root) {
        if let Some(workdir) = repo.workdir() {
            repositories
                .insert(std::fs::canonicalize(workdir).unwrap_or_else(|_| workdir.to_path_buf()));
        }
        snapshot.branch = repo
            .head()
            .ok()
            .and_then(|head| head.shorthand().map(str::to_owned));
    }
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.file_name() != ".git")
    {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                snapshot.warnings.push(e.to_string());
                continue;
            }
        };
        if entry.depth() == 0 {
            continue;
        }
        if snapshot.paths.len() >= 200_000 {
            snapshot.truncated = true;
            break;
        }
        if entry.file_type().is_dir() && entry.path().join(".git").exists() {
            repositories.insert(entry.path().into());
        }
        let mut path = entry
            .path()
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if entry.file_type().is_dir() {
            path.push('/');
        }
        snapshot.paths.push(path);
    }
    for repo_path in repositories {
        let Ok(repo) = Repository::open(&repo_path) else {
            continue;
        };
        let mut options = StatusOptions::new();
        options
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(true)
            .recurse_ignored_dirs(false)
            .renames_head_to_index(true)
            .renames_index_to_workdir(true);
        match repo.statuses(Some(&mut options)) {
            Ok(statuses) => {
                for entry in statuses.iter() {
                    let Some(relative) = entry.path() else {
                        continue;
                    };
                    // Path operations on Windows strip a trailing separator.
                    // The tree needs it to inherit ignored directory statuses.
                    let is_directory = relative.ends_with('/');
                    let full = repo_path.join(relative);
                    let Ok(relative) = full.strip_prefix(root) else {
                        continue;
                    };
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
            Err(e) => snapshot.warnings.push(e.to_string()),
        };
    }
    Ok(snapshot)
}

pub fn watch(app: &tauri::AppHandle, label: &str, root: PathBuf) -> Result<()> {
    let pending = Arc::new(AtomicBool::new(false));
    let dirty = pending.clone();
    let mut watcher = notify::recommended_watcher(move |_event: notify::Result<notify::Event>| {
        dirty.store(true, Ordering::Release);
    })
    .map_err(|e| AppError::new("watch", e.to_string()))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| AppError::new("watch", e.to_string()))?;
    let handle = app.clone();
    let label_owned = label.to_owned();
    let root_owned = root.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(350));
            let state = handle.state::<AppState>();
            let windows = state.windows.lock().unwrap();
            if windows
                .get(&label_owned)
                .is_none_or(|w| w.root.as_ref() != Some(&root_owned))
            {
                break;
            }
            drop(windows);
            if pending.swap(false, Ordering::AcqRel) {
                let _ = handle.emit_to(label_owned.as_str(), "workspace-changed", ());
            }
        }
    });
    app.state::<AppState>()
        .windows
        .lock()
        .unwrap()
        .entry(label.into())
        .or_default()
        .watcher = Some(watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn status<'a>(snapshot: &'a TreeSnapshot, path: &str) -> Option<&'a str> {
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
        let snapshot = scan(&root).unwrap();
        assert!(snapshot.paths.contains(&"build/deep/file.txt".to_owned()));
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
        let snapshot = scan(&root).unwrap();
        assert_ne!(status(&snapshot, "drop.log"), Some("ignored"));
        assert_eq!(status(&snapshot, "keep.log"), Some("untracked"));
        assert_eq!(status(&snapshot, "src/drop.log"), Some("ignored"));
        assert_eq!(status(&snapshot, "src/keep.log"), Some("untracked"));
        assert_eq!(status(&snapshot, "src/cache/"), Some("ignored"));
        let subtree = scan(&root.join("src")).unwrap();
        assert_eq!(status(&subtree, "drop.log"), Some("ignored"));
        assert_eq!(status(&subtree, "cache/"), Some("ignored"));
        std::fs::remove_file(root.join("src/.gitignore")).unwrap();
        std::fs::write(root.join(".gitignore"), "").unwrap();
        let updated = scan(&root).unwrap();
        assert_eq!(status(&updated, "src/drop.log"), Some("untracked"));
        assert_eq!(status(&updated, "src/cache/file.txt"), Some("untracked"));
    }

    #[test]
    fn plain_folders_do_not_apply_gitignore() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join(".gitignore"), "file.txt\n").unwrap();
        std::fs::write(directory.path().join("file.txt"), "visible").unwrap();
        let snapshot = scan(directory.path()).unwrap();
        assert!(snapshot.paths.contains(&"file.txt".to_owned()));
        assert!(snapshot.git.is_empty());
    }

    #[test]
    #[ignore = "filesystem performance sample; run explicitly with --ignored --nocapture"]
    fn ignored_scan_performance() {
        let (_directory, root, _repo) = fixture(&[(".gitignore", "generated/\n")]);
        for directory in 0..100 {
            let path = root.join(format!("generated/package-{directory}"));
            std::fs::create_dir_all(&path).unwrap();
            for file in 0..100 {
                std::fs::write(path.join(format!("file-{file}.txt")), "fixture").unwrap();
            }
        }
        for iteration in 0..6 {
            let start = std::time::Instant::now();
            let snapshot = scan(&root).unwrap();
            println!(
                "scan {iteration}: {:.2} ms, {} paths, {} git entries",
                start.elapsed().as_secs_f64() * 1000.0,
                snapshot.paths.len(),
                snapshot.git.len()
            );
        }
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
        let snapshot = scan(&root).unwrap();
        assert!(snapshot.paths.contains(&"ignored.txt".to_owned()));
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
