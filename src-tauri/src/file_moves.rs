use crate::sync::MutexExt;
use crate::sync::RwLockExt;
use crate::{
    error::{AppError, Result},
    state::{AppState, canonical},
};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use tauri::WebviewWindow;

#[derive(Clone, Debug, Serialize)]
pub struct FileMove {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Serialize)]
pub struct MoveFailure {
    pub path: String,
    pub message: String,
}

#[derive(Default, Debug, Serialize)]
pub struct MoveReport {
    pub moved: Vec<FileMove>,
    pub failed: Vec<MoveFailure>,
}

pub(crate) fn visible(path: &Path) -> String {
    crate::tools::process_path(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub(crate) fn key(path: &Path) -> String {
    let path = visible(path);
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path
    }
}

pub(crate) fn within(path: &Path, root: &Path) -> bool {
    let path = key(path);
    let root = key(root);
    path == root || path.starts_with(&(root.trim_end_matches('/').to_owned() + "/"))
}

fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

// The caller holds disk_lock; validate the displayed identity before canonicalizing it.
pub(crate) fn rename_checked(
    state: &AppState,
    label: &str,
    source: &str,
    destination: &str,
) -> Result<()> {
    crate::file_clipboard::check_source(Path::new(source))?;
    let source = state.authorize(label, source)?;
    if state
        .windows
        .lock_recover()
        .get(label)
        .and_then(|w| w.root.as_ref())
        == Some(&source)
    {
        return Err(AppError::new(
            "workspace",
            "Cannot modify the open workspace root",
        ));
    }
    let destination = Path::new(destination);
    let parent = destination
        .parent()
        .ok_or_else(|| AppError::new("path", "Invalid destination"))?;
    crate::file_clipboard::check_source(parent)?;
    if exists(destination)? {
        return Err(AppError::new("exists", "Destination already exists"));
    }
    let destination = state.authorize(label, &destination.to_string_lossy())?;
    if within(&destination, &source) {
        return Err(AppError::new("path", "Cannot move a directory into itself"));
    }
    rename_no_replace(&source, &destination)?;
    Ok(())
}

fn plan(root: &Path, sources: &[String], target: &Path) -> Result<Vec<FileMove>> {
    let target = fs::canonicalize(target)?;
    if !within(&target, root) || !target.is_dir() {
        return Err(AppError::new(
            "path",
            "The destination must be a directory in the current workspace",
        ));
    }
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    for source in sources {
        let resolved = fs::canonicalize(source)?;
        // A tree entry through a symlink must not silently move its referent.
        if key(Path::new(source)) != key(&resolved)
            || fs::symlink_metadata(source)?.file_type().is_symlink()
        {
            return Err(AppError::new(
                "path",
                "Moving symbolic links or items through directory links is not supported",
            ));
        }
        let source = resolved;
        if !within(&source, root) || key(&source) == key(root) {
            return Err(AppError::new(
                "access",
                "Only items inside the current workspace can be moved",
            ));
        }
        if seen.insert(key(&source)) {
            paths.push(source);
        }
    }
    // Moving a selected directory already includes every selected descendant.
    let directories: HashSet<_> = paths
        .iter()
        .filter(|p| p.is_dir())
        .map(|p| key(p))
        .collect();
    let paths: Vec<_> = paths
        .iter()
        .filter(|source| {
            !source
                .ancestors()
                .skip(1)
                .any(|p| directories.contains(&key(p)))
        })
        .collect();
    let mut destinations = HashSet::new();
    let mut conflicts = Vec::new();
    let mut moves = Vec::new();
    for source in paths {
        if source.is_dir() && within(&target, source) {
            return Err(AppError::new(
                "path",
                "Cannot move a directory into itself or one of its descendants",
            ));
        }
        let destination = target.join(
            source
                .file_name()
                .ok_or_else(|| AppError::new("path", "Invalid source name"))?,
        );
        if key(source) == key(&destination) {
            continue;
        }
        if !destinations.insert(key(&destination)) || exists(&destination)? {
            conflicts.push(visible(&destination));
        }
        moves.push(FileMove {
            from: visible(source),
            to: visible(&destination),
        });
    }
    if !conflicts.is_empty() {
        return Err(AppError::new(
            "exists",
            format!(
                "Nothing was moved. These destinations already exist or have duplicate names:\n{}",
                conflicts.join("\n")
            ),
        ));
    }
    Ok(moves)
}

pub(crate) fn workspace(state: &AppState, label: &str, expected_root: &str) -> Result<PathBuf> {
    let expected = canonical(Path::new(expected_root))?;
    let windows = state.windows.lock_recover();
    let root = windows
        .get(label)
        .and_then(|w| w.root.as_ref())
        .ok_or_else(|| AppError::new("workspace", "No workspace is open"))?;
    if key(root) != key(&expected) {
        return Err(AppError::new(
            "workspace",
            "The workspace changed; try the operation again",
        ));
    }
    Ok(root.clone())
}

fn apply(moves: Vec<FileMove>) -> MoveReport {
    let mut report = MoveReport::default();
    for item in moves {
        let result = (|| {
            if exists(Path::new(&item.to))? {
                return Err(AppError::new(
                    "exists",
                    "Destination already exists; nothing was overwritten",
                ));
            }
            rename_no_replace(Path::new(&item.from), Path::new(&item.to))?;
            Ok(())
        })();
        match result {
            Ok(()) => report.moved.push(item),
            Err(e) => {
                report.failed.push(MoveFailure {
                    path: item.from,
                    message: e.message,
                });
                break;
            }
        }
    }
    report
}

#[cfg(windows)]
pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileW(existing: *const u16, destination: *const u16) -> i32;
    }
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // MoveFileW refuses an existing destination, including one created after preflight.
    if unsafe { MoveFileW(from.as_ptr(), to.as_ptr()) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[tauri::command]
pub async fn plan_file_moves(
    window: WebviewWindow,
    sources: Vec<String>,
    target_directory: String,
    expected_root: String,
) -> Result<Vec<FileMove>> {
    crate::state::blocking(window, move |window, state| {
        let _disk = state.disk_lock.write_recover();
        let root = workspace(&state, window.label(), &expected_root)?;
        plan(&root, &sources, Path::new(&target_directory))
    })
    .await
}

#[tauri::command]
pub async fn move_files(
    window: WebviewWindow,
    sources: Vec<String>,
    target_directory: String,
    expected_root: String,
) -> Result<MoveReport> {
    crate::state::blocking(window, move |window, state| {
        let _disk = state.disk_lock.write_recover();
        let root = workspace(&state, window.label(), &expected_root)?;
        Ok(apply(plan(&root, &sources, Path::new(&target_directory))?))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn legacy_rename_rejects_junctions_and_their_children_and_preserves_conflicts() {
        let (_dir, root, target, _) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "secret").unwrap();
        let link = root.join("linked");
        assert!(
            std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&link)
                .arg(outside.path())
                .output()
                .unwrap()
                .status
                .success()
        );
        let state = AppState::default();
        state.windows.lock_recover().insert(
            "main".into(),
            crate::state::WindowState {
                root: Some(root.clone()),
                ..Default::default()
            },
        );
        for source in [&link, &link.join("secret")] {
            assert!(
                rename_checked(
                    &state,
                    "main",
                    &visible(source),
                    &visible(&target.join("moved"))
                )
                .is_err()
            );
        }
        assert!(link.exists());
        assert_eq!(
            fs::read_to_string(outside.path().join("secret")).unwrap(),
            "secret"
        );
        let destination = target.join("b.txt");
        fs::write(&destination, "existing").unwrap();
        assert!(rename_no_replace(&root.join("b.txt"), &destination).is_err());
        assert_eq!(fs::read_to_string(&destination).unwrap(), "existing");
        fs::remove_file(&destination).unwrap();
        rename_checked(
            &state,
            "main",
            &visible(&root.join("b.txt")),
            &visible(&destination),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&destination).unwrap(), "b");
    }
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, Vec<String>) {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let target = root.join("target");
        fs::create_dir(&target).unwrap();
        fs::create_dir_all(root.join("folder/deep")).unwrap();
        fs::write(root.join("folder/deep/a.txt"), "a").unwrap();
        fs::write(root.join("b.txt"), "b").unwrap();
        let sources = ["folder", "folder/deep/a.txt", "b.txt", "b.txt"]
            .map(|p| visible(&root.join(p)))
            .to_vec();
        (dir, root, target, sources)
    }
    #[test]
    fn preview_is_read_only_and_deduplicates_then_moves_files_and_directories() {
        let (_dir, root, target, sources) = fixture();
        let moves = plan(&root, &sources, &target).unwrap();
        assert_eq!(moves.len(), 2);
        assert!(root.join("b.txt").exists());
        assert!(!target.join("b.txt").exists());
        let report = apply(moves);
        assert_eq!(report.moved.len(), 2);
        assert!(report.failed.is_empty());
        assert_eq!(
            fs::read_to_string(target.join("folder/deep/a.txt")).unwrap(),
            "a"
        );
        assert_eq!(fs::read_to_string(target.join("b.txt")).unwrap(), "b");
    }
    #[test]
    fn conflict_blocks_the_whole_batch_and_is_rechecked_after_preview() {
        let (_dir, root, target, sources) = fixture();
        plan(&root, &sources, &target).unwrap();
        fs::write(target.join("b.txt"), "existing").unwrap();
        assert_eq!(plan(&root, &sources, &target).unwrap_err().code, "exists");
        assert!(root.join("folder/deep/a.txt").exists());
        assert_eq!(
            fs::read_to_string(target.join("b.txt")).unwrap(),
            "existing"
        );
    }
    #[test]
    fn rejects_duplicate_destinations_root_descendants_and_outside_paths() {
        let (_dir, root, target, _) = fixture();
        fs::write(root.join("a.txt"), "another").unwrap();
        assert_eq!(
            plan(
                &root,
                &[
                    visible(&root.join("a.txt")),
                    visible(&root.join("folder/deep/a.txt"))
                ],
                &target
            )
            .unwrap_err()
            .code,
            "exists"
        );
        assert!(plan(&root, &[visible(&root)], &target).is_err());
        assert!(
            plan(
                &root,
                &[visible(&root.join("folder"))],
                &root.join("folder/deep")
            )
            .is_err()
        );
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("outside.txt"), "secret").unwrap();
        assert!(
            plan(
                &root,
                &[visible(&outside.path().join("outside.txt"))],
                &target
            )
            .is_err()
        );
        assert!(plan(&root, &[visible(&root.join("b.txt"))], outside.path()).is_err());
        assert!(plan(&root, &[visible(&root.join("missing"))], &target).is_err());
    }
    #[test]
    fn same_parent_is_a_noop_and_root_is_a_valid_target() {
        let (_dir, root, target, _) = fixture();
        assert!(
            plan(&root, &[visible(&root.join("b.txt"))], &root)
                .unwrap()
                .is_empty()
        );
        let report =
            apply(plan(&root, &[visible(&root.join("folder/deep/a.txt"))], &root).unwrap());
        assert_eq!(report.moved.len(), 1);
        assert!(root.join("a.txt").exists());
        assert!(plan(&root, &[], &target).unwrap().is_empty());
    }
    #[test]
    fn execution_stops_on_io_failure_and_reports_completed_items() {
        let (_dir, root, target, sources) = fixture();
        let moves = plan(&root, &sources, &target).unwrap();
        fs::remove_file(root.join("b.txt")).unwrap();
        let report = apply(moves);
        assert_eq!(report.moved.len(), 1);
        assert_eq!(report.failed.len(), 1);
        assert!(target.join("folder/deep/a.txt").exists());
    }
    #[test]
    fn stale_workspace_is_rejected() {
        let (_dir, root, _, _) = fixture();
        let state = AppState::default();
        state
            .windows
            .lock_recover()
            .entry("test".into())
            .or_default()
            .root = Some(root.clone());
        assert!(workspace(&state, "test", &visible(&root)).is_ok());
        let other = tempfile::tempdir().unwrap();
        assert!(workspace(&state, "test", &visible(other.path())).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn windows_names_are_case_insensitive() {
        let (_dir, root, target, _) = fixture();
        fs::write(target.join("B.TXT"), "existing").unwrap();
        assert!(plan(&root, &[visible(&root.join("b.txt"))], &target).is_err());
    }
}
