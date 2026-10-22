use crate::{
    error::{AppError, Result},
    file_moves::{visible, within},
    state::AppState,
};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{State, WebviewWindow};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedEntry {
    path: String,
    relative_path: String,
    kind: String,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new("path", message)
}

fn segments(name: &str, windows: bool) -> Result<Vec<&str>> {
    if name.starts_with(['/', '\\']) || name.contains(':') {
        return Err(invalid("Enter a relative path inside this folder."));
    }
    let parts: Vec<_> = name
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        return Err(invalid("A file or folder name must be provided."));
    }
    for part in &parts {
        if part.trim().is_empty()
            || *part == "."
            || *part == ".."
            || part
                .chars()
                .any(|c| c == '\0' || (windows && (c < ' ' || "<>:\"|?*".contains(c))))
            || (windows && (part.ends_with([' ', '.']) || part.encode_utf16().count() > 255))
            || (!windows && part.len() > 255)
        {
            return Err(invalid(format!(
                "The name '{part}' is not valid as a file or folder name."
            )));
        }
        if windows {
            let stem = part
                .split('.')
                .next()
                .unwrap_or("")
                .trim_end()
                .to_uppercase();
            let device = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
                || ["COM", "LPT"].iter().any(|prefix| {
                    stem.strip_prefix(prefix).is_some_and(|n| {
                        matches!(
                            n,
                            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                        )
                    })
                });
            if device {
                return Err(invalid(format!(
                    "The name '{part}' is reserved by Windows."
                )));
            }
        }
    }
    Ok(parts)
}

fn existing(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

// Do not traverse directory links, including Windows junctions.
fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn check_directory(path: &Path, root: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if linked(&meta) || !meta.is_dir() || !within(&fs::canonicalize(path)?, root) {
        return Err(invalid(
            "The parent must be a directory in this workspace, without symbolic links.",
        ));
    }
    Ok(())
}

fn plan(root: &Path, parent: &str, name: &str, kind: &str) -> Result<(PathBuf, Vec<String>, bool)> {
    if !["newFile", "newFolder"].contains(&kind) {
        return Err(invalid("Invalid creation type."));
    }
    let mut directory = root.to_path_buf();
    if !parent.is_empty() {
        for part in segments(parent, cfg!(windows))? {
            directory.push(part);
            check_directory(&directory, root)?;
        }
    }
    check_directory(&directory, root)?;
    let parts = segments(name, cfg!(windows))?;
    let mut target = directory.clone();
    for (index, part) in parts.iter().enumerate() {
        target.push(part);
        if let Some(meta) = existing(&target)? {
            if index == parts.len() - 1 {
                return Err(AppError::new(
                    "exists",
                    format!(
                        "A file or folder '{name}' already exists at this location. Please choose a different name."
                    ),
                ));
            }
            if linked(&meta) || !meta.is_dir() {
                return Err(invalid(format!(
                    "'{part}' cannot be used as an intermediate folder."
                )));
            }
            check_directory(&target, root)?;
        }
    }
    Ok((
        directory,
        parts.iter().map(|s| (*s).to_owned()).collect(),
        kind == "newFolder" || name.ends_with(['/', '\\']),
    ))
}

fn create(root: &Path, parent: &str, name: &str, kind: &str) -> Result<CreatedEntry> {
    let (mut path, parts, folder) = plan(root, parent, name, kind)?;
    let mut created = Vec::new();
    let result = (|| {
        for (index, part) in parts.iter().enumerate() {
            check_directory(&path, root)?;
            path.push(part);
            if index < parts.len() - 1 {
                match fs::create_dir(&path) {
                    Ok(()) => created.push(path.clone()),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                        check_directory(&path, root)?
                    }
                    Err(e) => return Err(e.into()),
                }
            } else if folder {
                fs::create_dir(&path)?;
            } else {
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)?;
            }
        }
        Ok(CreatedEntry {
            path: visible(&path),
            relative_path: path
                .strip_prefix(root)
                .map_err(|_| invalid("Path is outside this workspace."))?
                .to_string_lossy()
                .replace('\\', "/"),
            kind: if folder { "newFolder" } else { "newFile" }.into(),
        })
    })();
    if result.is_err() {
        for directory in created.iter().rev() {
            let _ = fs::remove_dir(directory);
        }
    }
    result
}

fn with_current_root<T>(
    state: &AppState,
    label: &str,
    expected: &str,
    session: u64,
    operation: impl FnOnce(&Path) -> Result<T>,
) -> Result<T> {
    let expected = fs::canonicalize(expected)?;
    let windows = state.windows.lock().unwrap();
    let root = windows
        .get(label)
        .filter(|window| window.workspace_session == session)
        .and_then(|window| window.root.as_ref())
        .filter(|root| **root == expected)
        .ok_or_else(|| {
            AppError::new(
                "workspace",
                "Workspace changed. Please start creation again.",
            )
        })?;
    operation(root)
}

#[tauri::command]
pub async fn validate_workspace_creation(
    window: WebviewWindow,
    state: State<'_, AppState>,
    expected_root: String,
    session: u64,
    parent: String,
    name: String,
    kind: String,
) -> Result<Option<String>> {
    with_current_root(&state, window.label(), &expected_root, session, |root| {
        Ok(plan(root, &parent, &name, &kind)
            .err()
            .map(|error| error.message))
    })
}

#[tauri::command]
pub async fn create_workspace_entry(
    window: WebviewWindow,
    state: State<'_, AppState>,
    expected_root: String,
    session: u64,
    parent: String,
    name: String,
    kind: String,
) -> Result<CreatedEntry> {
    let _disk = state.disk_lock.lock().unwrap();
    with_current_root(&state, window.label(), &expected_root, session, |root| {
        create(root, &parent, &name, &kind)
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamedEntry {
    from: String,
    to: String,
    relative_path: String,
    is_directory: bool,
    changed: bool,
}

struct RenamePlan {
    source: PathBuf,
    target: PathBuf,
    directory: bool,
}

fn plan_rename(root: &Path, source: &str, name: &str) -> Result<RenamePlan> {
    let parts = segments(source, cfg!(windows))?;
    let mut from = root.to_path_buf();
    for part in &parts[..parts.len() - 1] {
        from.push(part);
        check_directory(&from, root)?;
    }
    from.push(parts[parts.len() - 1]);
    let meta = fs::symlink_metadata(&from)?;
    if linked(&meta) {
        return Err(invalid("Renaming symbolic links is not supported."));
    }
    let from = fs::canonicalize(&from)?;
    if !within(&from, root) || from == root {
        return Err(invalid(
            "Only items inside the current workspace can be renamed.",
        ));
    }
    if !meta.is_dir() && name.ends_with(['/', '\\']) {
        return Err(invalid(
            "A file name cannot end with a directory separator.",
        ));
    }
    let names = segments(name, cfg!(windows))?;
    let mut target = from
        .parent()
        .ok_or_else(|| invalid("Invalid source parent."))?
        .to_path_buf();
    for (index, part) in names.iter().enumerate() {
        target.push(part);
        if let Some(meta) = existing(&target)? {
            if index == names.len() - 1 {
                // Only the source itself is exempt: notably case-only renames on Windows.
                if linked(&meta) || fs::canonicalize(&target)? != from {
                    return Err(AppError::new(
                        "exists",
                        format!(
                            "A file or folder '{name}' already exists at this location. Please choose a different name."
                        ),
                    ));
                }
            } else {
                check_directory(&target, root)?;
            }
        }
    }
    if meta.is_dir()
        && within(&target, &from)
        && crate::file_moves::key(&target) != crate::file_moves::key(&from)
    {
        return Err(invalid(
            "A folder cannot be moved into itself or one of its descendants.",
        ));
    }
    Ok(RenamePlan {
        source: from,
        target,
        directory: meta.is_dir(),
    })
}

fn rename_entry(root: &Path, source: &str, name: &str) -> Result<RenamedEntry> {
    let plan = plan_rename(root, source, name)?;
    let changed = visible(&plan.source) != visible(&plan.target);
    let mut created = Vec::new();
    let result = (|| {
        if changed {
            let parent = plan
                .target
                .parent()
                .ok_or_else(|| invalid("Invalid destination."))?;
            let mut directory = root.to_path_buf();
            for part in parent
                .strip_prefix(root)
                .map_err(|_| invalid("Destination is outside the workspace."))?
                .components()
            {
                check_directory(&directory, root)?;
                directory.push(part);
                match fs::create_dir(&directory) {
                    Ok(()) => created.push(directory.clone()),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        check_directory(&directory, root)?
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            check_directory(parent, root)?;
            crate::file_moves::rename_no_replace(&plan.source, &plan.target)?;
        }
        Ok(RenamedEntry {
            from: visible(&plan.source),
            to: visible(&plan.target),
            relative_path: plan
                .target
                .strip_prefix(root)
                .map_err(|_| invalid("Invalid destination."))?
                .to_string_lossy()
                .replace('\\', "/"),
            is_directory: plan.directory,
            changed,
        })
    })();
    if result.is_err() {
        for directory in created.iter().rev() {
            let _ = fs::remove_dir(directory);
        }
    }
    result
}

#[tauri::command]
pub async fn validate_workspace_rename(
    window: WebviewWindow,
    state: State<'_, AppState>,
    expected_root: String,
    session: u64,
    source: String,
    name: String,
) -> Result<Option<String>> {
    with_current_root(&state, window.label(), &expected_root, session, |root| {
        Ok(plan_rename(root, &source, &name)
            .err()
            .map(|error| error.message))
    })
}

#[tauri::command]
pub async fn rename_workspace_entry(
    window: WebviewWindow,
    state: State<'_, AppState>,
    expected_root: String,
    session: u64,
    source: String,
    name: String,
) -> Result<RenamedEntry> {
    let _disk = state.disk_lock.lock().unwrap();
    with_current_root(&state, window.label(), &expected_root, session, |root| {
        rename_entry(root, &source, &name)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_validates_source_conflicts_and_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("a.txt"), "keep").unwrap();
        fs::write(root.join("taken"), "other").unwrap();
        assert!(!rename_entry(&root, "a.txt", "a.txt").unwrap().changed);
        for name in ["taken", "taken/child", "../escape", "a.txt/", "CON", ""] {
            assert!(rename_entry(&root, "a.txt", name).is_err(), "{name}");
        }
        assert!(rename_entry(&root, "missing", "other").is_err());
        assert!(rename_entry(&root, "../a.txt", "other").is_err());
        let result = rename_entry(&root, "a.txt", "nested/deep/b.txt").unwrap();
        assert_eq!(result.relative_path, "nested/deep/b.txt");
        assert_eq!(fs::read_to_string(&result.to).unwrap(), "keep");
        assert!(!root.join("a.txt").exists());
        assert!(rename_entry(&root, "nested", "nested/inside").is_err());
        let folder = rename_entry(&root, "nested", "folder/").unwrap();
        assert!(folder.is_directory);
        assert_eq!(
            fs::read_to_string(root.join("folder/deep/b.txt")).unwrap(),
            "keep"
        );
        assert_eq!(fs::read_to_string(root.join("taken")).unwrap(), "other");
    }

    #[cfg(windows)]
    #[test]
    fn renames_case_only_without_overwriting_other_items() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("a.txt"), "keep").unwrap();
        assert!(rename_entry(&root, "a.txt", "A.TXT").unwrap().changed);
        assert!(
            fs::read_dir(&root)
                .unwrap()
                .any(|entry| entry.unwrap().file_name() == "A.TXT")
        );
        fs::create_dir(root.join("folder")).unwrap();
        assert!(rename_entry(&root, "folder", "FOLDER").unwrap().changed);
        assert!(
            fs::read_dir(&root)
                .unwrap()
                .any(|entry| entry.unwrap().file_name() == "FOLDER")
        );
    }

    #[test]
    fn validates_each_segment_and_windows_devices() {
        for name in [
            "",
            "  ",
            "/abs",
            "\\abs",
            "C:a",
            "../escape",
            "a/./b",
            "a/../b",
            "a\0b",
        ] {
            assert!(segments(name, false).is_err(), "{name:?}");
        }
        for name in [
            "a?b",
            "a/CON.txt",
            "LPT1",
            "COM¹.log",
            "NUL",
            "aux",
            "tail.",
            "tail ",
            "a\nb",
        ] {
            assert!(segments(name, true).is_err(), "{name:?}");
        }
        assert!(segments(&"中".repeat(256), true).is_err());
        assert!(segments(".gitignore/中文🙂.txt", true).is_ok());
        assert!(segments("COM10.txt", true).is_ok());
    }

    #[test]
    fn creates_nested_paths_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let item = create(&root, "", "src\\ui/Button.tsx", "newFile").unwrap();
        assert_eq!(item.relative_path, "src/ui/Button.tsx");
        fs::write(&item.path, "keep").unwrap();
        assert!(create(&root, "", "src/ui/Button.tsx", "newFile").is_err());
        assert!(create(&root, "", "src/ui/Button.tsx", "newFolder").is_err());
        assert_eq!(fs::read_to_string(item.path).unwrap(), "keep");
        assert_eq!(
            create(&root, "src", "new/deep/", "newFile").unwrap().kind,
            "newFolder"
        );
        assert!(root.join("src/new/deep").is_dir());
        assert!(create(&root, "", "src/ui/Button.tsx/child", "newFile").is_err());
        assert!(create(&root, "missing", "a", "newFile").is_err());
        assert!(create(&root, "../", "a", "newFile").is_err());
    }

    #[test]
    fn rejects_directory_links() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir(root.join("real")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(root.join("real"), root.join("link")).is_err() {
            return;
        }
        assert!(create(&root, "", "link/file", "newFile").is_err());
        assert!(create(&root, "link", "file", "newFile").is_err());
    }
}
