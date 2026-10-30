use crate::{
    commands,
    error::{AppError, Result},
    state::AppState,
};
use serde::Serialize;
use std::path::Path;
use tauri::Manager;

#[derive(Serialize)]
pub struct OpenTarget {
    pub path: String,
    pub directory: bool,
}

pub fn inspect(path: &Path) -> Result<OpenTarget> {
    let path = std::fs::canonicalize(path)?;
    if path.to_str().is_none() {
        return Err(AppError::new(
            "path",
            "The selected path is not valid Unicode",
        ));
    }
    let metadata = std::fs::metadata(&path)?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(AppError::new("path", "Select a regular file or directory"));
    }
    Ok(OpenTarget {
        path: crate::tools::process_path(&path)
            .into_os_string()
            .into_string()
            .map_err(|_| AppError::new("path", "The selected path is not valid Unicode"))?,
        directory: metadata.is_dir(),
    })
}

pub fn open(app: &tauri::AppHandle, path: &Path) -> Result<()> {
    let target = inspect(path)?;
    commands::create_empty_window(app, &app.state::<AppState>(), Some(target))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspects_files_directories_roots_and_missing_paths() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmp");
        std::fs::create_dir_all(&root).unwrap();
        let directory = tempfile::tempdir_in(root).unwrap();
        let file = directory.path().join("中文 file.txt");
        std::fs::write(&file, "hello").unwrap();
        assert!(!inspect(&file).unwrap().directory);
        let folder = inspect(&directory.path().join(".")).unwrap();
        assert!(folder.directory);
        assert_eq!(
            Path::new(&folder.path).canonicalize().unwrap(),
            directory.path().canonicalize().unwrap()
        );
        assert!(inspect(&directory.path().join("missing")).is_err());
        #[cfg(windows)]
        assert!(inspect(Path::new(r"C:\.")).unwrap().directory);
    }
}
