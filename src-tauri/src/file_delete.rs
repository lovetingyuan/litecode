use crate::sync::MutexExt;
use crate::sync::RwLockExt;
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
    let _disk = state.disk_lock.write_recover();
    let selected = Path::new(path);
    if let Some((parent, name)) = selected.parent().zip(selected.file_name()) {
        let entry = parent.join(name);
        if fs::symlink_metadata(&entry)?.file_type().is_symlink() {
            // Authorize the containing directory without resolving the link itself.
            let parent = state.authorize(label, &parent.to_string_lossy())?;
            let source = parent.join(name);
            if key(selected).trim_end_matches('/') != key(&source) {
                return Err(link_error());
            }
            return recycler(&source);
        }
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
        .lock_recover()
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
        "Cannot delete items through directory links. Nothing was deleted.",
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
            .lock_recover()
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
        let file = state.grant("test", &file).unwrap();
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
    fn junctions_are_recycled_as_entries_and_paths_through_them_are_rejected() {
        let (_temp, state, root) = fixture();
        let real = root.join("important");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("a.txt"), "important bytes").unwrap();
        let link = root.join("shortcut");
        junction(&link, &real);
        let snapshot = crate::workspace::read_directory(&root, "", 0).unwrap();
        let link_info = &snapshot.symlinks["shortcut"];
        assert!(link_info.is_directory);
        assert_eq!(
            link_info.target.as_deref(),
            Some(crate::tools::process_path(&real).to_string_lossy().as_ref())
        );
        assert!(crate::workspace::read_directory(&root, "shortcut", 0).is_err());
        let nested = real.join("nested");
        let other = root.join("other");
        fs::create_dir(&other).unwrap();
        junction(&nested, &other);
        for path in [link.join("a.txt"), link.join("nested")] {
            assert!(
                recycle(&state, "test", &visible(&path), |_| panic!(
                    "path through a link reached recycler"
                ))
                .is_err()
            );
        }
        recycle(&state, "test", &visible(&link), |source| {
            assert_eq!(source, link);
            Ok(())
        })
        .unwrap();
        assert_eq!(
            fs::read_to_string(real.join("a.txt")).unwrap(),
            "important bytes"
        );
        assert!(fs::symlink_metadata(&link).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn junctions_with_outside_or_missing_targets_are_authorized_by_their_location() {
        let (_temp, state, root) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "secret").unwrap();
        let link = root.join("outside");
        junction(&link, outside.path());
        let outside_link = outside.path().join("shortcut");
        junction(&outside_link, &root);
        assert!(
            recycle(&state, "test", &visible(&outside_link), |_| panic!(
                "outside link reached recycler"
            ))
            .is_err()
        );
        let missing = root.join("missing");
        fs::create_dir(&missing).unwrap();
        let broken = root.join("broken");
        junction(&broken, &missing);
        fs::remove_dir(&missing).unwrap();
        for entry in [&link, &broken] {
            recycle(&state, "test", &visible(entry), |source| {
                assert_eq!(source, entry);
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(
            fs::read_to_string(outside.path().join("secret")).unwrap(),
            "secret"
        );
        assert!(fs::symlink_metadata(&broken).is_ok());
    }

    #[test]
    #[cfg_attr(
        windows,
        ignore = "Requires Windows Developer Mode or symlink privilege"
    )]
    fn file_symlinks_are_recycled_as_entries() {
        let (_temp, state, root) = fixture();
        let target = root.join("important.txt");
        fs::write(&target, "keep").unwrap();
        let link = root.join("link.txt");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&target, &link).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let check_link = || {
            recycle(&state, "test", &visible(&link), |source| {
                assert_eq!(source, link);
                Ok(())
            })
            .unwrap();
        };
        check_link();
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
        fs::remove_file(&target).unwrap();
        check_link();
        assert!(fs::symlink_metadata(link).is_ok());
    }
}
