use crate::{
    error::{AppError, Result},
    file_moves::key,
    state::AppState,
};
use std::{fs, path::Path};

pub(crate) fn recycle(
    state: &AppState,
    label: &str,
    path: &str,
    recycler: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
    let _disk = state.disk_lock.lock().unwrap();
    // Authorization resolves links. Check the user's selected entry first so a
    // grant for its referent can never turn "delete link" into "delete target".
    let selected = Path::new(path);
    let metadata = fs::symlink_metadata(selected)?;
    if metadata.file_type().is_symlink() {
        return Err(link_error());
    }
    let resolved = fs::canonicalize(selected)?;
    if key(selected).trim_end_matches('/') != key(&resolved).trim_end_matches('/') {
        return Err(link_error());
    }
    let source = state.authorize(label, path)?;
    if source != resolved {
        return Err(AppError::new(
            "path",
            "The selected path changed; nothing was deleted.",
        ));
    }
    if state
        .windows
        .lock()
        .unwrap()
        .get(label)
        .and_then(|window| window.root.as_ref())
        .is_some_and(|root| root == &source)
    {
        return Err(AppError::new(
            "workspace",
            "Cannot modify the open workspace root",
        ));
    }
    recycler(&source)
}

fn link_error() -> AppError {
    AppError::new(
        "path",
        "Deleting symbolic links, directory junctions or items through directory links is not supported; nothing was deleted.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_moves::visible;
    use std::{cell::RefCell, fs, path::PathBuf};

    fn fixture() -> (tempfile::TempDir, AppState, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let state = AppState::default();
        state
            .windows
            .lock()
            .unwrap()
            .entry("test".into())
            .or_default()
            .root = Some(root.clone());
        (temp, state, root)
    }

    #[test]
    fn normal_items_are_authorized_and_root_and_outside_items_never_reach_recycler() {
        let (_temp, state, root) = fixture();
        fs::write(root.join("普通 file.txt"), "preserve").unwrap();
        fs::create_dir(root.join("folder")).unwrap();
        let calls = RefCell::new(Vec::new());
        for path in [root.join("普通 file.txt"), root.join("folder")] {
            recycle(&state, "test", &visible(&path), |path| {
                calls.borrow_mut().push(path.to_path_buf());
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(calls.borrow().len(), 2);
        recycle(
            &state,
            "test",
            &(visible(&root.join("folder")) + "/"),
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("普通 file.txt")).unwrap(),
            "preserve"
        );
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "secret").unwrap();
        for path in [root, outside.path().join("secret")] {
            assert!(
                recycle(&state, "test", &visible(&path), |_| panic!(
                    "unauthorized recycle"
                ))
                .is_err()
            );
        }
    }

    #[test]
    fn granted_loose_files_keep_the_existing_recycle_error_without_a_delete_fallback() {
        let (_temp, state, _root) = fixture();
        let outside = tempfile::tempdir().unwrap();
        let file = outside.path().join("granted.txt");
        fs::write(&file, "keep").unwrap();
        state
            .windows
            .lock()
            .unwrap()
            .get_mut("test")
            .unwrap()
            .grants
            .insert(fs::canonicalize(&file).unwrap());
        let error = recycle(&state, "test", &visible(&file), |_| {
            Err(AppError::new("recycle", "unavailable"))
        })
        .unwrap_err();
        assert_eq!(error.code, "recycle");
        assert_eq!(fs::read_to_string(&file).unwrap(), "keep");
    }

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        assert!(
            std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap()
                .status
                .success()
        );
    }

    #[cfg(windows)]
    #[test]
    fn junctions_and_paths_through_them_preserve_the_real_target() {
        let (_temp, state, root) = fixture();
        let real = root.join("important");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("a.txt"), "important bytes").unwrap();
        let link = root.join("shortcut");
        junction(&link, &real);
        for path in [&link, &link.join("a.txt")] {
            assert!(
                recycle(&state, "test", &visible(path), |_| panic!(
                    "link reached recycler"
                ))
                .is_err()
            );
        }
        assert_eq!(
            fs::read_to_string(real.join("a.txt")).unwrap(),
            "important bytes"
        );
        assert!(fs::symlink_metadata(&link).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn outside_and_broken_junctions_never_reach_recycler() {
        let (_temp, state, root) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "secret").unwrap();
        let link = root.join("outside");
        junction(&link, outside.path());
        assert!(
            recycle(&state, "test", &visible(&link), |_| panic!(
                "outside target recycled"
            ))
            .is_err()
        );
        let missing = root.join("missing");
        fs::create_dir(&missing).unwrap();
        let broken = root.join("broken");
        junction(&broken, &missing);
        fs::remove_dir(&missing).unwrap();
        assert!(
            recycle(&state, "test", &visible(&broken), |_| panic!(
                "broken link recycled"
            ))
            .is_err()
        );
        assert_eq!(
            fs::read_to_string(outside.path().join("secret")).unwrap(),
            "secret"
        );
        assert!(fs::symlink_metadata(&broken).is_ok());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Requires Windows Developer Mode or symlink privilege"]
    fn file_symlinks_never_reach_recycler() {
        let (_temp, state, root) = fixture();
        let target = root.join("important.txt");
        fs::write(&target, "keep").unwrap();
        let link = root.join("link.txt");
        std::os::windows::fs::symlink_file(&target, &link).unwrap();
        assert!(
            recycle(&state, "test", &visible(&link), |_| panic!(
                "file symlink recycled"
            ))
            .is_err()
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
        fs::remove_file(&target).unwrap();
        assert!(
            recycle(&state, "test", &visible(&link), |_| panic!(
                "broken symlink recycled"
            ))
            .is_err()
        );
        assert!(fs::symlink_metadata(link).is_ok());
    }
}
