use crate::sync::MutexExt;
use crate::sync::RwLockExt;
use crate::{
    error::{AppError, Result},
    state::{AppState, canonical},
};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::WebviewWindow;

pub fn require_source(
    state: &AppState,
    label: &str,
    path: &Path,
    root: &Option<PathBuf>,
) -> Result<()> {
    if state.require_workspace_trust(label)? != *root {
        return Err(AppError::new(
            "workspace",
            "The workspace changed before formatting started.",
        ));
    }
    let source = canonical(path)?;
    let directory = if source.is_dir() {
        source
    } else {
        source.parent().unwrap().to_path_buf()
    };
    let windows = state.windows.lock_recover();
    let window = windows
        .get(label)
        .ok_or_else(|| AppError::new("window", "Window is not initialized"))?;
    if root.as_ref().is_some_and(|r| directory.starts_with(r))
        || window
            .formatter_trust
            .iter()
            .any(|(context, trusted)| context == root && directory.starts_with(trusted))
    {
        return Ok(());
    }
    let mut error = AppError::new(
        "formatterTrust",
        "Trust this folder before running its formatters or loading formatter configuration.",
    );
    error.trust_path = Some(
        crate::tools::process_path(&directory)
            .to_string_lossy()
            .into_owned(),
    );
    Err(error)
}

fn grant(
    state: &AppState,
    label: &str,
    path: Option<&str>,
    expected_root: Option<&str>,
    directory: &str,
) -> Result<()> {
    let _disk = state.disk_lock.write_recover();
    let root = state.require_workspace_trust(label)?;
    if expected_root.map(Path::new).map(canonical).transpose()? != root {
        return Err(AppError::new(
            "workspace",
            "The workspace changed. Review the current folder before trusting it.",
        ));
    }
    if let Some(path) = path {
        state.authorize(label, path)?;
    }
    let directory = canonical(Path::new(directory))?;
    if !directory.is_dir() {
        return Err(AppError::new("path", "Formatter trust requires a folder."));
    }
    state
        .windows
        .lock_recover()
        .get_mut(label)
        .unwrap()
        .formatter_trust
        .insert((root, directory));
    Ok(())
}

#[tauri::command]
pub async fn trust_formatter(
    window: WebviewWindow,
    path: Option<String>,
    expected_root: Option<String>,
    directory: String,
) -> Result<()> {
    crate::state::blocking(window, move |window, state| {
        grant(
            &state,
            window.label(),
            path.as_deref(),
            expected_root.as_deref(),
            &directory,
        )
    })
    .await
}

// Resolve configuration without executing project code, then pin this exact file
// on the CLI so the formatter cannot discover a different, unchecked ancestor.
pub fn find_config(path: &Path, names: &[&str], prettier: bool) -> Result<Option<PathBuf>> {
    for directory in path.parent().unwrap().ancestors() {
        if prettier {
            let package = directory.join("package.json");
            if package.is_file()
                && serde_json::from_slice::<serde_json::Value>(&fs::read(&package)?)
                    .ok()
                    .is_some_and(|v| v.get("prettier").is_some())
            {
                return Ok(Some(package));
            }
            let package = directory.join("package.yaml");
            if package.is_file()
                && regex::Regex::new(r"(?m)^prettier\s*:")
                    .unwrap()
                    .is_match(&fs::read_to_string(&package)?)
            {
                return Ok(Some(package));
            }
        }
        for name in names {
            let config = directory.join(name);
            if config.is_file() {
                return Ok(Some(config));
            }
        }
    }
    Ok(None)
}

pub const PRETTIER_CONFIGS: &[&str] = &[
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yml",
    ".prettierrc.yaml",
    ".prettierrc.json5",
    ".prettierrc.js",
    "prettier.config.js",
    ".prettierrc.ts",
    "prettier.config.ts",
    ".prettierrc.mjs",
    "prettier.config.mjs",
    ".prettierrc.mts",
    "prettier.config.mts",
    ".prettierrc.cjs",
    "prettier.config.cjs",
    ".prettierrc.cts",
    "prettier.config.cts",
    ".prettierrc.toml",
];
pub const OXFMT_CONFIGS: &[&str] = &[
    ".oxfmtrc.json",
    ".oxfmtrc.jsonc",
    "oxfmt.config.ts",
    "oxfmt.config.mts",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(dir: &Path) -> (AppState, PathBuf) {
        let parent = dir.join("loose");
        fs::create_dir(&parent).unwrap();
        let file = parent.join("a.html");
        fs::write(&file, "<p>text</p>").unwrap();
        let state = AppState {
            data_dir: dir.join("data"),
            ..Default::default()
        };
        state.grant("main", &file).unwrap();
        (state, file)
    }

    #[test]
    fn loose_files_need_explicit_window_scoped_formatter_trust() {
        let dir = tempfile::tempdir().unwrap();
        let (state, file) = fixture(dir.path());
        // Keep the empty-window terminal policy, but never inherit it for formatting.
        assert!(state.require_workspace_trust("main").unwrap().is_none());
        let error = require_source(&state, "main", &file, &None).unwrap_err();
        assert_eq!(error.code, "formatterTrust");
        assert_eq!(
            serde_json::to_value(&error).unwrap()["trustPath"],
            error.trust_path.as_ref().unwrap().as_str()
        );
        grant(
            &state,
            "main",
            Some(file.to_str().unwrap()),
            None,
            file.parent().unwrap().to_str().unwrap(),
        )
        .unwrap();
        require_source(&state, "main", &file, &None).unwrap();
        state.grant("editor-other", &file).unwrap();
        assert_eq!(
            require_source(&state, "editor-other", &file, &None)
                .unwrap_err()
                .code,
            "formatterTrust"
        );
        assert!(!state.data_dir.join("trusted-workspaces.json").exists());
    }

    #[test]
    fn workspace_trust_does_not_cover_outside_files_or_ancestor_configs() {
        let dir = tempfile::tempdir().unwrap();
        let (state, file) = fixture(dir.path());
        let root = dir.path().join("workspace");
        fs::create_dir(&root).unwrap();
        let root = canonical(&root).unwrap();
        state.windows.lock_recover().get_mut("main").unwrap().root = Some(root.clone());
        state
            .set_workspace_trust("main", root.to_str().unwrap(), true)
            .unwrap();
        let inside = root.join("a.ts");
        fs::write(&inside, "const x = 1").unwrap();
        require_source(&state, "main", &inside, &Some(root.clone())).unwrap();
        for source in [&file, dir.path()] {
            assert_eq!(
                require_source(&state, "main", source, &Some(root.clone()))
                    .unwrap_err()
                    .code,
                "formatterTrust"
            );
        }
        assert!(
            grant(
                &state,
                "main",
                Some(file.to_str().unwrap()),
                None,
                file.parent().unwrap().to_str().unwrap()
            )
            .is_err()
        );
        grant(
            &state,
            "main",
            Some(file.to_str().unwrap()),
            root.to_str(),
            file.parent().unwrap().to_str().unwrap(),
        )
        .unwrap();
        require_source(&state, "main", &file, &Some(root.clone())).unwrap();
        state
            .set_workspace_trust("main", root.to_str().unwrap(), false)
            .unwrap();
        assert!(
            state.windows.lock_recover()["main"]
                .formatter_trust
                .is_empty()
        );
        assert_eq!(
            require_source(&state, "main", &file, &Some(root))
                .unwrap_err()
                .code,
            "workspaceTrust"
        );
    }

    #[test]
    fn grants_are_bound_to_the_workspace_and_do_not_allow_unauthorized_files() {
        let dir = tempfile::tempdir().unwrap();
        let (state, file) = fixture(dir.path());
        let outside = dir.path().join("secret.html");
        fs::write(&outside, "private").unwrap();
        assert_eq!(
            grant(
                &state,
                "main",
                outside.to_str(),
                None,
                dir.path().to_str().unwrap()
            )
            .unwrap_err()
            .code,
            "access"
        );
        grant(
            &state,
            "main",
            file.to_str(),
            None,
            file.parent().unwrap().to_str().unwrap(),
        )
        .unwrap();
        let root = canonical(dir.path()).unwrap();
        state.windows.lock_recover().get_mut("main").unwrap().root = Some(root.clone());
        assert_eq!(
            require_source(&state, "main", &file, &None)
                .unwrap_err()
                .code,
            "workspaceTrust"
        );
        // A separate, trusted context cannot reuse the loose-window permission.
        let other = dir.path().join("other");
        fs::create_dir(&other).unwrap();
        let other = canonical(&other).unwrap();
        state.windows.lock_recover().get_mut("main").unwrap().root = Some(other.clone());
        state
            .set_workspace_trust("main", other.to_str().unwrap(), true)
            .unwrap();
        assert_eq!(
            require_source(&state, "main", &file, &Some(other.clone()))
                .unwrap_err()
                .code,
            "formatterTrust"
        );
        assert_eq!(
            require_source(&state, "main", &file, &Some(root))
                .unwrap_err()
                .code,
            "workspace"
        );
    }

    #[test]
    fn nearest_configs_and_package_fields_are_resolved_without_executing_them() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("src");
        fs::create_dir(&nested).unwrap();
        let file = nested.join("a.ts");
        let outer = dir.path().join("prettier.config.mjs");
        fs::write(&outer, "throw new Error('must not execute')").unwrap();
        assert_eq!(
            find_config(&file, PRETTIER_CONFIGS, true).unwrap(),
            Some(outer)
        );
        let local = nested.join(".prettierrc.cts");
        fs::write(&local, "throw new Error('must not execute')").unwrap();
        assert_eq!(
            find_config(&file, PRETTIER_CONFIGS, true).unwrap(),
            Some(local)
        );
        let package = nested.join("package.json");
        fs::write(&package, r#"{"name":"test"}"#).unwrap();
        assert!(
            find_config(&file, PRETTIER_CONFIGS, true)
                .unwrap()
                .unwrap()
                .ends_with(".prettierrc.cts")
        );
        fs::write(&package, r#"{"prettier":{"semi":false}}"#).unwrap();
        assert_eq!(
            find_config(&file, PRETTIER_CONFIGS, true).unwrap(),
            Some(package)
        );
        assert!(find_config(&file, OXFMT_CONFIGS, false).unwrap().is_none());
        let oxfmt = nested.join("oxfmt.config.mts");
        fs::write(&oxfmt, "throw new Error('must not execute')").unwrap();
        assert_eq!(
            find_config(&file, OXFMT_CONFIGS, false).unwrap(),
            Some(oxfmt)
        );
    }

    #[cfg(windows)]
    #[test]
    fn canonical_tool_and_config_targets_outside_a_trusted_root_need_their_own_grant() {
        use std::os::windows::process::CommandExt;
        let dir = tempfile::tempdir().unwrap();
        let (state, file) = fixture(dir.path());
        let root = dir.path().join("workspace");
        fs::create_dir(&root).unwrap();
        let junction = root.join("node_modules");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(file.parent().unwrap())
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(status.status.success());
        let root = canonical(&root).unwrap();
        state.windows.lock_recover().get_mut("main").unwrap().root = Some(root.clone());
        state
            .set_workspace_trust("main", root.to_str().unwrap(), true)
            .unwrap();
        let result = require_source(&state, "main", &junction.join("a.html"), &Some(root));
        fs::remove_dir(&junction).unwrap();
        assert_eq!(result.unwrap_err().code, "formatterTrust");
    }
}
