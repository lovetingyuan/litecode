use crate::{
    error::{AppError, Result},
    file_moves::{FileMove, MoveFailure, key, visible, within, workspace},
    state::AppState,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use tauri::{Manager, WebviewWindow};

#[derive(Debug, Serialize)]
pub struct FileClipboard {
    sequence: Option<u32>,
    paths: Vec<String>,
}

#[derive(Default, Debug, Serialize)]
pub struct CopyReport {
    copied: Vec<FileMove>,
    failed: Vec<MoveFailure>,
}

#[cfg(windows)]
fn read_native() -> Result<FileClipboard> {
    use clipboard_win::{Clipboard, Getter, formats, is_format_avail, seq_num};
    // Clipboard owners can briefly hold the lock. Retry off the UI thread.
    let mut attempts = 0;
    let _clipboard = loop {
        match Clipboard::new() {
            Ok(clipboard) => break clipboard,
            Err(error) if attempts == 9 => {
                return Err(AppError::new(
                    "clipboard",
                    format!("Could not read the clipboard: {error}"),
                ));
            }
            Err(_) => {
                attempts += 1;
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    };
    let mut paths: Vec<PathBuf> = Vec::new();
    if is_format_avail(formats::CF_HDROP) {
        formats::FileList
            .read_clipboard(&mut paths)
            .map_err(|error| {
                AppError::new("clipboard", format!("Could not read copied files: {error}"))
            })?;
    }
    // Read the sequence after delayed rendering, while the clipboard is still locked.
    Ok(FileClipboard {
        sequence: seq_num().map(|n| n.get()),
        paths: paths.iter().map(|p| visible(p)).collect(),
    })
}

#[cfg(not(windows))]
fn read_native() -> Result<FileClipboard> {
    Ok(FileClipboard {
        sequence: None,
        paths: vec![],
    })
}

fn check_sequence(snapshot: &FileClipboard, expected: u32) -> Result<()> {
    if snapshot.sequence != Some(expected) {
        return Err(AppError::new(
            "clipboard",
            "The clipboard changed; paste the files again",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn read_file_clipboard() -> Result<FileClipboard> {
    tauri::async_runtime::spawn_blocking(read_native)
        .await
        .map_err(|error| AppError::new("clipboard", error.to_string()))?
}

#[tauri::command]
pub async fn paste_file_clipboard(
    window: WebviewWindow,
    expected_sequence: u32,
    expected_root: String,
    target_directory: String,
) -> Result<CopyReport> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _disk = state.disk_lock.lock().unwrap();
        let root = workspace(&state, &label, &expected_root)?;
        let target = fs::canonicalize(&target_directory)?;
        if !target.is_dir() || !within(&target, &root) {
            return Err(AppError::new(
                "access",
                "The destination must be a directory in the current workspace",
            ));
        }
        let snapshot = read_native()?;
        check_sequence(&snapshot, expected_sequence)?;
        // External sources come exclusively from the native clipboard. Do not grant
        // the renderer general access to them or hold the clipboard during disk I/O.
        Ok(copy_sources(&snapshot.paths, &target))
    })
    .await
    .map_err(|error| AppError::new("copy", error.to_string()))?
}

pub(crate) fn check_source(path: &Path) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    // Canonical comparison also rejects paths through directory links. Avoid
    // rejecting all Windows reparse points: cloud-backed regular files use them too.
    if metadata.file_type().is_symlink() || key(path) != key(&fs::canonicalize(path)?) {
        return Err(AppError::new(
            "copy",
            "Copying symbolic links or items through directory links is not supported; source was preserved",
        ));
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(AppError::new(
            "copy",
            "Only regular files and directories can be copied",
        ));
    }
    Ok(metadata)
}

fn increment_name(name: &str, directory: bool) -> String {
    let (stem, suffix) = if directory {
        (name, String::new())
    } else if let Some(ext) = Path::new(name).extension().and_then(|e| e.to_str()) {
        (&name[..name.len() - ext.len() - 1], format!(".{ext}"))
    } else {
        (name, String::new())
    };
    if stem.ends_with(" copy") {
        return format!("{stem} 2{suffix}");
    }
    if let Some((prefix, number)) = stem.rsplit_once(' ')
        && prefix.ends_with(" copy")
        && !number.is_empty()
        && number.bytes().all(|b| b.is_ascii_digit())
        && let Ok(number) = number.parse::<u64>()
        && number < (1 << 30) - 1
    {
        return if number == 0 {
            format!("{prefix}{suffix}")
        } else {
            format!("{prefix} {}{suffix}", number + 1)
        };
    }
    format!("{stem} copy{suffix}")
}

fn available_target(
    target: &Path,
    name: &str,
    directory: bool,
    reserved: &mut HashSet<String>,
) -> Result<PathBuf> {
    let mut name = name.to_owned();
    loop {
        let path = target.join(&name);
        let exists = match fs::symlink_metadata(&path) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        if !exists && reserved.insert(key(&path)) {
            return Ok(path);
        }
        name = increment_name(&name, directory);
    }
}

fn copy_file(source: &Path, target: &Path) -> Result<()> {
    check_source(source)?;
    let mut input = fs::File::open(source)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    let result = std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all());
    drop(output);
    if let Err(error) = result {
        let cleanup = fs::remove_file(target);
        return Err(AppError::new(
            "copy",
            format!(
                "{error}{}",
                cleanup
                    .err()
                    .map(|e| format!("; could not remove the incomplete copy: {e}"))
                    .unwrap_or_default()
            ),
        ));
    }
    Ok(())
}

pub(crate) fn copy_item(source: &Path, target: &Path, directory: bool) -> Result<()> {
    if !directory {
        return copy_file(source, target);
    }
    // Preflight the whole directory, including empty directories, before creating
    // anything. WalkDir must never follow a source link or junction.
    let mut entries = Vec::new();
    for entry in walkdir::WalkDir::new(source)
        .follow_links(false)
        .follow_root_links(false)
    {
        let entry = entry.map_err(|error| AppError::new("copy", error.to_string()))?;
        let metadata = check_source(entry.path())?;
        entries.push((entry.path().to_owned(), metadata.is_dir()));
    }
    fs::create_dir(target)?; // Exclusive ownership: cleanup must never remove a pre-existing destination.
    let result: Result<()> = (|| {
        for (path, directory) in entries {
            check_source(&path)?;
            let destination = target.join(path.strip_prefix(source).unwrap());
            if path == source {
                continue;
            }
            if directory {
                fs::create_dir(destination)?;
            } else {
                copy_file(&path, &destination)?;
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        let cleanup = fs::remove_dir_all(target);
        return Err(AppError::new(
            "copy",
            format!(
                "{}{}",
                error.message,
                cleanup
                    .err()
                    .map(|e| format!("; could not remove the incomplete copy: {e}"))
                    .unwrap_or_default()
            ),
        ));
    }
    Ok(())
}

fn copy_sources(sources: &[String], target: &Path) -> CopyReport {
    let mut report = CopyReport::default();
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for source in sources {
        let path = Path::new(source);
        if !seen.insert(key(path)) {
            continue;
        }
        match check_source(path) {
            Ok(metadata) => candidates.push((path, metadata.is_dir())),
            Err(error) => report.failed.push(MoveFailure {
                path: source.clone(),
                message: error.message,
            }),
        }
    }
    let directories: HashSet<_> = candidates
        .iter()
        .filter(|(_, directory)| *directory)
        .map(|(path, _)| key(path))
        .collect();
    let mut reserved = HashSet::new();
    for &(source, directory) in &candidates {
        if source
            .ancestors()
            .skip(1)
            .any(|parent| directories.contains(&key(parent)))
        {
            continue;
        }
        let result = (|| {
            if directory && within(target, source) {
                return Err(AppError::new(
                    "path",
                    "Cannot copy a directory into itself or one of its descendants",
                ));
            }
            let name = source
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| AppError::new("path", "Invalid source name"))?;
            let destination = available_target(target, name, directory, &mut reserved)?;
            copy_item(source, &destination, directory)?;
            Ok(destination)
        })();
        match result {
            Ok(destination) => report.copied.push(FileMove {
                from: visible(source),
                to: visible(&destination),
            }),
            Err(error) => report.failed.push(MoveFailure {
                path: visible(source),
                message: error.message,
            }),
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("external");
        let target = temp.path().join("project");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        (
            temp,
            fs::canonicalize(source).unwrap(),
            fs::canonicalize(target).unwrap(),
        )
    }
    fn paths(items: &[PathBuf]) -> Vec<String> {
        items.iter().map(|path| visible(path)).collect()
    }

    #[test]
    fn copies_unicode_binary_files_nested_and_empty_directories_without_touching_sources() {
        let (_temp, source, target) = fixture();
        let folder = source.join("中文 空格");
        fs::create_dir_all(folder.join("deep/empty")).unwrap();
        let bytes = [0, 255, 14, 0, 250];
        fs::write(folder.join("deep/数据.bin"), bytes).unwrap();
        fs::write(source.join("a.txt"), "hello").unwrap();
        let report = copy_sources(&paths(&[folder.clone(), source.join("a.txt")]), &target);
        assert_eq!(report.copied.len(), 2);
        assert!(report.failed.is_empty());
        assert_eq!(
            fs::read(target.join("中文 空格/deep/数据.bin")).unwrap(),
            bytes
        );
        assert!(target.join("中文 空格/deep/empty").is_dir());
        assert_eq!(fs::read_to_string(source.join("a.txt")).unwrap(), "hello");
        assert!(folder.join("deep/数据.bin").exists());
    }

    #[test]
    fn removes_duplicate_paths_and_children_even_if_the_child_appears_first() {
        let (_temp, source, target) = fixture();
        fs::create_dir(source.join("folder")).unwrap();
        fs::write(source.join("folder/a.txt"), "a").unwrap();
        let report = copy_sources(
            &paths(&[
                source.join("folder/a.txt"),
                source.join("folder"),
                source.join("folder"),
            ]),
            &target,
        );
        assert_eq!(report.copied.len(), 1);
        assert!(report.failed.is_empty());
        assert!(target.join("folder/a.txt").exists());
        assert!(!target.join("a.txt").exists());
    }

    #[test]
    fn increments_names_for_existing_items_repeated_pastes_and_same_batch_names() {
        let (_temp, source, target) = fixture();
        fs::create_dir(source.join("other")).unwrap();
        fs::write(source.join("a.txt"), "first").unwrap();
        fs::write(source.join("other/a.txt"), "second").unwrap();
        fs::write(target.join("a.txt"), "original").unwrap();
        let sources = paths(&[source.join("a.txt"), source.join("other/a.txt")]);
        let report = copy_sources(&sources, &target);
        assert!(report.failed.is_empty());
        assert_eq!(
            fs::read_to_string(target.join("a copy.txt")).unwrap(),
            "first"
        );
        assert_eq!(
            fs::read_to_string(target.join("a copy 2.txt")).unwrap(),
            "second"
        );
        assert_eq!(
            fs::read_to_string(target.join("a.txt")).unwrap(),
            "original"
        );
        let report = copy_sources(&sources, &target);
        assert_eq!(report.copied.len(), 2);
        assert!(target.join("a copy 3.txt").exists());
        assert!(target.join("a copy 4.txt").exists());
    }

    #[test]
    fn naming_preserves_extensions_dotfiles_and_directory_names() {
        assert_eq!(increment_name("a.tar.gz", false), "a.tar copy.gz");
        assert_eq!(increment_name(".gitignore", false), ".gitignore copy");
        assert_eq!(increment_name("folder.ext", true), "folder.ext copy");
        assert_eq!(increment_name("a copy.txt", false), "a copy 2.txt");
        assert_eq!(increment_name("a copy 9.txt", false), "a copy 10.txt");
        assert_eq!(increment_name("a copy 0.txt", false), "a copy.txt");
    }

    #[test]
    fn rejects_self_and_descendant_directory_copies_but_allows_siblings() {
        let (_temp, source, target) = fixture();
        fs::create_dir_all(source.join("folder/deep")).unwrap();
        let sources = paths(&[source.join("folder")]);
        for invalid in [source.join("folder"), source.join("folder/deep")] {
            let report = copy_sources(&sources, &invalid);
            assert!(report.copied.is_empty());
            assert_eq!(report.failed.len(), 1);
            assert!(!invalid.join("folder").exists());
        }
        assert_eq!(copy_sources(&sources, &target).copied.len(), 1);
    }

    #[test]
    fn reports_missing_sources_while_copying_other_valid_items() {
        let (_temp, source, target) = fixture();
        fs::write(source.join("good"), "ok").unwrap();
        let report = copy_sources(
            &paths(&[source.join("missing"), source.join("good")]),
            &target,
        );
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.copied.len(), 1);
        assert!(target.join("good").exists());
    }

    #[test]
    fn exclusive_creation_never_overwrites_or_cleans_up_an_existing_destination() {
        let (_temp, source, target) = fixture();
        fs::write(source.join("a.txt"), "new").unwrap();
        fs::write(target.join("a.txt"), "old").unwrap();
        assert!(copy_item(&source.join("a.txt"), &target.join("a.txt"), false).is_err());
        assert_eq!(fs::read_to_string(target.join("a.txt")).unwrap(), "old");
        fs::create_dir(source.join("folder")).unwrap();
        fs::create_dir(target.join("folder")).unwrap();
        fs::write(target.join("folder/keep"), "keep").unwrap();
        assert!(copy_item(&source.join("folder"), &target.join("folder"), true).is_err());
        assert!(target.join("folder/keep").exists());
    }

    #[test]
    fn clipboard_revalidation_rejects_changed_or_unavailable_sequences() {
        let snapshot = FileClipboard {
            sequence: Some(5),
            paths: vec![],
        };
        assert!(check_sequence(&snapshot, 5).is_ok());
        assert!(check_sequence(&snapshot, 6).is_err());
        assert!(
            check_sequence(
                &FileClipboard {
                    sequence: None,
                    paths: vec![]
                },
                0
            )
            .is_err()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_conflicts_are_case_insensitive() {
        let (_temp, source, target) = fixture();
        fs::write(source.join("a.txt"), "new").unwrap();
        fs::write(target.join("A.TXT"), "old").unwrap();
        let report = copy_sources(&paths(&[source.join("a.txt")]), &target);
        assert!(report.failed.is_empty());
        assert!(target.join("a copy.txt").exists());
        assert_eq!(fs::read_to_string(target.join("A.TXT")).unwrap(), "old");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_junctions_and_paths_through_junctions_before_copying() {
        let (_temp, source, target) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "secret").unwrap();
        let junction = source.join("linked");
        // Junctions do not require developer mode or administrator privileges.
        assert!(
            std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&junction)
                .arg(outside.path())
                .output()
                .unwrap()
                .status
                .success()
        );
        let report = copy_sources(
            &paths(&[junction.clone(), junction.join("secret")]),
            &target,
        );
        assert!(report.copied.is_empty());
        assert_eq!(report.failed.len(), 2);
        let report = copy_sources(&paths(std::slice::from_ref(&source)), &target);
        assert!(report.copied.is_empty());
        assert!(!target.join("external").exists());
        assert!(outside.path().join("secret").exists());
    }

    #[cfg(windows)]
    #[test]
    fn failed_file_reads_clean_up_the_incomplete_directory_and_preserve_source() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_temp, source, target) = fixture();
        fs::create_dir(source.join("folder")).unwrap();
        fs::write(source.join("folder/a.txt"), "a").unwrap();
        fs::write(source.join("folder/locked.txt"), "locked").unwrap();
        let _locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(source.join("folder/locked.txt"))
            .unwrap();
        let report = copy_sources(&paths(&[source.join("folder")]), &target);
        assert!(report.copied.is_empty());
        assert_eq!(report.failed.len(), 1);
        assert!(!target.join("folder").exists());
        assert!(source.join("folder/a.txt").exists());
    }
}
