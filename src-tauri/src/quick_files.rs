use crate::{
    error::{AppError, Result},
    state::AppState,
};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use tauri::{Manager, State, WebviewWindow};
use tokio::process::Command;

#[derive(Serialize)]
pub struct QuickFilePaths {
    root: Option<String>,
    paths: Vec<String>,
    excludes: serde_json::Map<String, Value>,
}

fn exclusion_rules(settings: &Value) -> serde_json::Map<String, Value> {
    let mut excludes = serde_json::Map::new();
    for key in ["files.exclude", "search.exclude"] {
        if let Some(rules) = settings[key].as_object() {
            excludes.extend(rules.clone());
        }
    }
    excludes
}

fn arguments(settings: &Value) -> Vec<String> {
    let mut args: Vec<String> = [
        "--files",
        "--null",
        "--hidden",
        "--no-config",
        "--no-require-git",
        "--case-sensitive",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    if settings["search.useIgnoreFiles"].as_bool() == Some(false) {
        args.push("--no-ignore".into());
    } else {
        if settings["search.useGlobalIgnoreFiles"].as_bool() != Some(true) {
            args.push("--no-ignore-global".into());
        }
        if settings["search.useParentIgnoreFiles"].as_bool() != Some(true) {
            args.push("--no-ignore-parent".into());
        }
    }
    if settings["search.followSymlinks"].as_bool() != Some(false) {
        args.push("--follow".into());
    }
    // Match VS Code's ignore-file casing on Windows without changing glob casing.
    #[cfg(windows)]
    args.push("--ignore-file-case-insensitive".into());
    for (pattern, value) in exclusion_rules(settings) {
        if value == true && !pattern.is_empty() {
            let pattern = pattern.replace('\\', "/");
            // Absolute rules are evaluated by the Worker's VS Code glob matcher.
            // ripgrep globs are relative to cwd and cannot represent drive/UNC paths.
            if pattern.starts_with('/') || pattern.as_bytes().get(1) == Some(&b':') {
                continue;
            }
            // Anchor relative globs to the workspace, as VS Code does.
            let pattern = pattern.trim_end_matches('/');
            args.push("--glob".into());
            args.push(format!("!/{pattern}"));
        }
    }
    args
}

async fn enumerate(rg: &Path, root: &Path, settings: &Value) -> Result<Vec<String>> {
    let mut command = Command::new(rg);
    command
        .args(arguments(settings))
        .current_dir(root)
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .await
        .map_err(|e| AppError::new("quickFiles", format!("Cannot start file search: {e}")))?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(AppError::new(
            "quickFiles",
            format!(
                "Cannot list workspace files: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    Ok(output
        .stdout
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|path| {
            String::from_utf8_lossy(path)
                .trim_start_matches(".\\")
                .trim_start_matches("./")
                .replace('\\', "/")
        })
        .collect())
}

#[tauri::command]
pub async fn quick_file_paths(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<QuickFilePaths> {
    let root = state
        .windows
        .lock()
        .unwrap()
        .get(window.label())
        .and_then(|w| w.root.clone());
    let Some(root) = root else {
        return Ok(QuickFilePaths {
            root: None,
            paths: vec![],
            excludes: serde_json::Map::new(),
        });
    };
    let settings = crate::configuration::load_settings(
        &state.data_dir.join("settings.json"),
        Some(&root),
        &mut vec![],
    );
    let paths = enumerate(
        &crate::search::rg_path(window.app_handle()),
        &root,
        &settings,
    )
    .await?;
    Ok(QuickFilePaths {
        root: Some(
            crate::tools::process_path(&root)
                .to_string_lossy()
                .into_owned(),
        ),
        paths,
        excludes: exclusion_rules(&settings),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture(files: &[(&str, &str)]) -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        for (path, text) in files {
            let path = directory.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        directory
    }

    async fn scan(root: &Path, settings: &Value) -> Vec<String> {
        let mut paths = enumerate(Path::new("rg"), root, settings).await.unwrap();
        paths.sort();
        paths
    }

    #[tokio::test]
    async fn defaults_prune_dependency_and_metadata_directories_in_plain_folders() {
        let directory = fixture(&[
            ("node_modules/a/index.js", "dependency"),
            ("packages/app/node_modules/b/index.js", "dependency"),
            ("bower_components/a/index.js", "dependency"),
            ("nested/results.code-search", "results"),
            (".git/config", "metadata"),
            (".env", "hidden source"),
            ("dist/main.js", "output"),
            ("build/main.js", "output"),
            ("src/App.ts", "source"),
        ]);
        assert_eq!(
            scan(directory.path(), &crate::configuration::defaults()).await,
            [".env", "build/main.js", "dist/main.js", "src/App.ts"]
        );
    }

    #[tokio::test]
    async fn ignore_files_nested_negations_and_setting_changes_apply_to_each_scan() {
        let directory = fixture(&[
            (".gitignore", "*.log\n!keep.log\n"),
            ("drop.log", "ignored"),
            ("keep.log", "included"),
            ("src/.gitignore", "!nested.log\n"),
            ("src/drop.log", "ignored"),
            ("src/nested.log", "included"),
            (".ignore", "cache/\n"),
            ("cache/a.ts", "ignored"),
            ("node_modules/a.ts", "dependency"),
        ]);
        let mut settings = crate::configuration::defaults();
        let paths = scan(directory.path(), &settings).await;
        assert!(paths.contains(&"keep.log".into()));
        assert!(paths.contains(&"src/nested.log".into()));
        assert!(!paths.contains(&"drop.log".into()));
        assert!(!paths.contains(&"src/drop.log".into()));
        assert!(!paths.contains(&"cache/a.ts".into()));
        settings["search.useIgnoreFiles"] = false.into();
        settings["search.exclude"]["**/node_modules"] = false.into();
        let paths = scan(directory.path(), &settings).await;
        for path in [
            "drop.log",
            "src/drop.log",
            "cache/a.ts",
            "node_modules/a.ts",
        ] {
            assert!(paths.contains(&path.into()), "missing {path}");
        }
        settings["search.useIgnoreFiles"] = true.into();
        fs::write(directory.path().join(".gitignore"), "").unwrap();
        assert!(
            scan(directory.path(), &settings)
                .await
                .contains(&"drop.log".into())
        );
    }

    #[tokio::test]
    async fn excludes_are_anchored_merged_and_parent_ignores_are_opt_in() {
        let directory = fixture(&[
            (".ignore", "*.log\n"),
            ("project/root-only/a.ts", "excluded"),
            ("project/src/root-only/a.ts", "included"),
            ("project/src/cache/a.ts", "excluded"),
            ("project/a.log", "included by default"),
        ]);
        let root = directory.path().join("project");
        let mut settings = crate::configuration::defaults();
        settings["files.exclude"]["root-only"] = true.into();
        settings["files.exclude"]["**/cache"] = true.into();
        assert_eq!(
            scan(&root, &settings).await,
            ["a.log", "src/root-only/a.ts"]
        );
        settings["search.exclude"]["**/cache"] = false.into();
        settings["search.useParentIgnoreFiles"] = true.into();
        assert_eq!(
            scan(&root, &settings).await,
            ["src/cache/a.ts", "src/root-only/a.ts"]
        );
        let args = arguments(&settings);
        assert!(args.contains(&"--no-ignore-global".into()));
        assert!(!args.contains(&"--no-ignore-parent".into()));
        assert!(args.contains(&"--follow".into()));
        settings["search.followSymlinks"] = false.into();
        settings["search.useGlobalIgnoreFiles"] = true.into();
        let args = arguments(&settings);
        assert!(!args.contains(&"--follow".into()));
        assert!(!args.contains(&"--no-ignore-global".into()));
    }

    #[tokio::test]
    async fn empty_workspaces_succeed_and_scan_failures_are_errors() {
        let directory = tempfile::tempdir().unwrap();
        let settings = crate::configuration::defaults();
        assert!(scan(directory.path(), &settings).await.is_empty());
        assert!(
            enumerate(
                Path::new("rg"),
                &directory.path().join("missing"),
                &settings
            )
            .await
            .is_err()
        );
    }
}
