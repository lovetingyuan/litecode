use crate::{
    error::{AppError, Result},
    state::AppState,
};
use serde::Serialize;
use std::{fs, path::PathBuf};
use tauri::{Manager, State, WebviewWindow};
use tokio::{io::AsyncWriteExt, process::Command};

pub struct ServerSpec {
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub root: Option<PathBuf>,
    pub description: String,
}

// Node's module loader cannot resolve Windows extended-length resource paths.
// Keep canonical paths for authorization, and use Win32 paths at process boundaries.
pub fn process_path(path: &std::path::Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else if let Some(local) = value.strip_prefix(r"\\?\") {
        PathBuf::from(local)
    } else {
        path.to_path_buf()
    }
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let direct = PathBuf::from(name);
    if direct.is_file() {
        return Some(direct);
    }
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .find_map(|directory| {
            [directory.join(name), directory.join(format!("{name}.exe"))]
                .into_iter()
                .find(|p| p.is_file())
        })
}

pub fn settings(window: &WebviewWindow, state: &AppState) -> serde_json::Value {
    let root = state
        .windows
        .lock()
        .unwrap()
        .get(window.label())
        .and_then(|w| w.root.clone());
    crate::configuration::load_settings(
        &state.data_dir.join("settings.json"),
        root.as_deref(),
        &mut vec![],
    )
}

fn node(window: &WebviewWindow, state: &AppState) -> Result<PathBuf> {
    let configured = settings(window, state)["litecode.nodePath"]
        .as_str()
        .map(PathBuf::from);
    configured.or_else(|| {
        let installed = state.data_dir.join("tools/node-v24.12.0-win-x64/node.exe"); installed.is_file().then_some(installed)
    }).or_else(|| find_executable("node")).ok_or_else(|| AppError::new("missingTool", "Node.js is required for this language service. Install Node.js 24 LTS or set litecode.nodePath to node.exe."))
}

fn packaged(window: &WebviewWindow, path: &str) -> PathBuf {
    let resource = window
        .app_handle()
        .path()
        .resource_dir()
        .unwrap_or_default()
        .join("tools")
        .join(path);
    if resource.exists() {
        process_path(&resource)
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tools")
            .join(path)
    }
}

pub fn server_spec(window: &WebviewWindow, state: &AppState, language: &str) -> Result<ServerSpec> {
    let settings = settings(window, state);
    let root = state
        .windows
        .lock()
        .unwrap()
        .get(window.label())
        .and_then(|w| w.root.clone());
    let tools = process_path(&state.data_dir.join("tools/languages/node_modules"));
    match language {
        "rust" => {
            let executable = settings["rust-analyzer.server.path"].as_str().map(PathBuf::from).or_else(|| find_executable("rust-analyzer")).ok_or_else(|| AppError::new("missingTool", "rust-analyzer is missing. Install your project's Rust toolchain, then run: rustup component add rust-analyzer rust-src rustfmt. Cargo and rustc are also required."))?;
            Ok(ServerSpec {
                executable,
                arguments: vec![],
                root,
                description: "rust-analyzer".into(),
            })
        }
        "typescript" | "javascript" => {
            let project_ts = root
                .as_ref()
                .map(|r| r.join("node_modules/typescript/package.json"))
                .filter(|p| p.exists());
            let version = project_ts
                .as_ref()
                .and_then(|p| fs::read(p).ok())
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .and_then(|v| v["version"].as_str().map(str::to_owned));
            let old = version
                .as_deref()
                .and_then(|v| v.split('.').next())
                .and_then(|v| v.parse::<u32>().ok())
                .is_some_and(|major| major < 7);
            let native = settings["typescript.native.serverPath"]
                .as_str()
                .map(PathBuf::from)
                .or_else(|| {
                    let native = tools.join("@typescript/native-preview-win32-x64/lib/tsgo.exe");
                    native.is_file().then_some(native)
                })
                .or_else(|| find_executable("tsgo"));
            if !old && let Some(executable) = native {
                return Ok(ServerSpec {
                    executable,
                    arguments: vec!["--lsp".into(), "--stdio".into()],
                    root,
                    description: "TypeScript Native LSP".into(),
                });
            }
            let script = settings["litecode.typescriptLanguageServerPath"]
                .as_str()
                .map(PathBuf::from)
                .unwrap_or_else(|| tools.join("typescript-language-server/lib/cli.mjs"));
            if !script.is_file() {
                return Err(AppError::new(
                    "missingTool",
                    "TypeScript language tools are missing. Run 'Language Tools: Install JavaScript/TypeScript Tools', or configure litecode.typescriptLanguageServerPath. Existing project dependencies are never installed automatically.",
                ));
            }
            Ok(ServerSpec {
                executable: node(window, state)?,
                // The server resolves workspace TypeScript from the LSP root URI.
                arguments: vec![script.to_string_lossy().into(), "--stdio".into()],
                root,
                description: format!(
                    "TypeScript {} compatibility LSP",
                    version.unwrap_or_else(|| "bundled".into())
                ),
            })
        }
        "html" | "css" | "scss" | "less" | "json" | "jsonc" => {
            let script = packaged(window, "web-language-server.cjs");
            if !script.exists() {
                return Err(AppError::new(
                    "missingTool",
                    "Language service bundle is missing. Run npm run build:tools.",
                ));
            }
            Ok(ServerSpec {
                executable: node(window, state)?,
                arguments: vec![
                    script.to_string_lossy().into(),
                    "--stdio".into(),
                    language.into(),
                ],
                root,
                description: format!("Microsoft {language} language service"),
            })
        }
        _ => Err(AppError::new(
            "language",
            "This language supports syntax highlighting and general editing only",
        )),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolReport {
    pub node: Option<String>,
    pub rustc: Option<String>,
    pub cargo: Option<String>,
    pub rustfmt: Option<String>,
    pub rust_analyzer: Option<String>,
    pub data_dir: String,
}

#[tauri::command]
pub fn tool_status(window: WebviewWindow, state: State<'_, AppState>) -> ToolReport {
    ToolReport {
        node: node(&window, &state)
            .ok()
            .map(|p| p.to_string_lossy().into()),
        rustc: find_executable("rustc").map(|p| p.to_string_lossy().into()),
        cargo: find_executable("cargo").map(|p| p.to_string_lossy().into()),
        rustfmt: find_executable("rustfmt").map(|p| p.to_string_lossy().into()),
        rust_analyzer: find_executable("rust-analyzer").map(|p| p.to_string_lossy().into()),
        data_dir: state.data_dir.to_string_lossy().into(),
    }
}

#[tauri::command]
pub async fn format_document(
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: Option<String>,
    text: String,
    language: String,
) -> Result<String> {
    let path = if let Some(path) = path {
        process_path(&state.authorize(window.label(), &path)?)
    } else {
        let extension = match language.as_str() {
            "typescript" => "ts",
            "typescriptreact" => "tsx",
            "javascript" => "js",
            "javascriptreact" => "jsx",
            "rust" => "rs",
            "jsonc" => "jsonc",
            "html" => "html",
            "css" => "css",
            "scss" => "scss",
            "less" => "less",
            "json" => "json",
            _ => {
                return Err(AppError::new(
                    "formatter",
                    "No formatter is configured for this language",
                ));
            }
        };
        let root = state
            .windows
            .lock()
            .unwrap()
            .get(window.label())
            .and_then(|w| w.root.clone())
            .unwrap_or_else(|| state.data_dir.clone());
        process_path(&root.join(format!("Untitled.{extension}")))
    };
    let config = settings(&window, &state);
    let root = state
        .windows
        .lock()
        .unwrap()
        .get(window.label())
        .and_then(|w| w.root.clone())
        .unwrap_or_else(|| path.parent().unwrap().into());
    let explicit = config["editor.defaultFormatter"].as_str();
    if explicit.is_some_and(|id| {
        ![
            "esbenp.prettier-vscode",
            "oxc.oxc-vscode",
            "rust-lang.rust-analyzer",
        ]
        .contains(&id)
    }) {
        return Err(AppError::new(
            "formatter",
            "The configured editor.defaultFormatter is not available in LiteCode.",
        ));
    }
    let prettier_script = root.join("node_modules/prettier/bin/prettier.cjs");
    let prettier_config = [
        ".prettierrc",
        ".prettierrc.json",
        ".prettierrc.js",
        ".prettierrc.cjs",
        "prettier.config.js",
        "prettier.config.mjs",
        ".prettierrc.yaml",
    ]
    .iter()
    .any(|p| root.join(p).exists())
        || fs::read(root.join("package.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .is_some_and(|v| v.get("prettier").is_some());
    let mut command;
    if language == "rust" {
        let executable = find_executable("rustfmt").ok_or_else(|| {
            AppError::new(
                "missingTool",
                "rustfmt is missing. Run rustup component add rustfmt for your project toolchain.",
            )
        })?;
        command = Command::new(executable);
        command.args(["--emit", "stdout"]);
        let regex = regex::Regex::new(r#"edition\s*=\s*"(2015|2018|2021|2024)""#).unwrap();
        for directory in path.parent().unwrap().ancestors() {
            if let Ok(cargo) = fs::read_to_string(directory.join("Cargo.toml"))
                && let Some(captures) = regex.captures(&cargo)
            {
                command.args(["--edition", &captures[1]]);
                break;
            }
        }
    } else if language == "html"
        || explicit == Some("esbenp.prettier-vscode")
        || explicit.is_none() && (prettier_config || prettier_script.exists())
    {
        let script = if prettier_script.exists() {
            prettier_script
        } else {
            state
                .data_dir
                .join("tools/languages/node_modules/prettier/bin/prettier.cjs")
        };
        if !script.exists() {
            return Err(AppError::new(
                "missingTool",
                "Prettier is required for this document. Install Language Tools, or add Prettier to your project. Missing project plugins are not installed automatically.",
            ));
        }
        command = Command::new(node(&window, &state)?);
        command
            .arg(process_path(&script))
            .arg("--stdin-filepath")
            .arg(&path);
    } else {
        let local_script = root.join("node_modules/oxfmt/bin/oxfmt");
        let installed = state
            .data_dir
            .join("tools/languages/node_modules/oxfmt/bin/oxfmt");
        if let Some(executable) = config["oxfmt.path"]
            .as_str()
            .map(PathBuf::from)
            .or_else(|| find_executable("oxfmt"))
        {
            command = Command::new(executable);
        } else if local_script.is_file() || installed.is_file() {
            command = Command::new(node(&window, &state)?);
            command.arg(process_path(&if local_script.is_file() {
                local_script
            } else {
                installed
            }));
        } else {
            return Err(AppError::new(
                "missingTool",
                "Oxfmt is missing. Install Language Tools, set oxfmt.path, or configure Prettier.",
            ));
        }
        command.arg("--stdin-filepath").arg(&path);
    }
    command
        .current_dir(process_path(&root))
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    tokio::spawn(async move {
        let _ = stdin.write_all(text.as_bytes()).await;
    });
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), child.wait_with_output())
        .await
        .map_err(|_| {
            AppError::new(
                "timeout",
                "Formatter exceeded 30 seconds; no edits were applied",
            )
        })??;
    if !output.status.success() {
        return Err(AppError::new(
            "formatter",
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }
    String::from_utf8(output.stdout).map_err(|e| AppError::new("encoding", e.to_string()))
}

#[tauri::command]
pub async fn install_tools(
    window: WebviewWindow,
    state: State<'_, AppState>,
    kind: String,
) -> Result<String> {
    use sha2::{Digest, Sha256};
    let _install_guard = state.tool_lock.try_lock().map_err(|_| {
        AppError::new(
            "toolBusy",
            "A tool installation is already running. Wait for it to finish before retrying.",
        )
    })?;
    if !matches!(kind.as_str(), "node" | "languages") {
        return Err(AppError::new("tool", "Unknown tool package"));
    }
    let tools = process_path(&state.data_dir.join("tools"));
    fs::create_dir_all(&tools)?;
    let node_home = tools.join("node-v24.12.0-win-x64");
    if !node_home.join("node.exe").is_file() {
        let url = "https://nodejs.org/dist/v24.12.0/node-v24.12.0-win-x64.zip";
        let expected = "9c125f61ae947b52e779095830f9cac267846a043ef7192183c84016aaad2812";
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .map_err(|e| AppError::new("download", e.to_string()))?;
        let mut response = client
            .get(url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|e| AppError::new("download", e.to_string()))?;
        let mut bytes = vec![];
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| AppError::new("download", e.to_string()))?
        {
            if window
                .app_handle()
                .get_webview_window(window.label())
                .is_none()
            {
                return Err(AppError::new(
                    "cancelled",
                    "Window closed; tool download cancelled",
                ));
            }
            if bytes.len() + chunk.len() > 100 * 1024 * 1024 {
                return Err(AppError::new("download", "Download exceeded size limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        if format!("{:x}", Sha256::digest(&bytes)) != expected {
            return Err(AppError::new(
                "integrity",
                "Node.js SHA-256 mismatch; download was not installed",
            ));
        }
        let temp = tempfile::tempdir_in(&tools)?;
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
            .map_err(|e| AppError::new("archive", e.to_string()))?;
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| AppError::new("archive", e.to_string()))?;
            let path = entry
                .enclosed_name()
                .ok_or_else(|| AppError::new("archive", "Unsafe archive entry"))?;
            let target = temp.path().join(path);
            if entry.is_dir() {
                fs::create_dir_all(&target)?;
            } else {
                fs::create_dir_all(target.parent().unwrap())?;
                std::io::copy(&mut entry, &mut fs::File::create(target)?)?;
            }
        }
        fs::rename(temp.path().join("node-v24.12.0-win-x64"), &node_home)?;
    }
    if kind == "node" {
        return Ok("Node.js 24.12.0 installed and verified. It can now be used offline.".into());
    }
    if kind != "languages" {
        return Err(AppError::new("tool", "Unknown tool package"));
    }
    let temp = tempfile::tempdir_in(&tools)?;
    for (source, target) in [
        ("languages-package.json", "package.json"),
        ("languages-package-lock.json", "package-lock.json"),
    ] {
        fs::copy(packaged(&window, source), temp.path().join(target))?;
    }
    let mut command = Command::new(node_home.join("node.exe"));
    command
        .arg(node_home.join("node_modules/npm/bin/npm-cli.js"))
        .args([
            "ci",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--registry=https://registry.npmjs.org",
        ])
        .current_dir(temp.path())
        .env(
            "PATH",
            format!(
                "{};{}",
                node_home.display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(std::time::Duration::from_secs(300), command.output())
        .await
        .map_err(|_| {
            AppError::new(
                "timeout",
                "Language tools installation timed out; previous tools remain available",
            )
        })??;
    if !output.status.success() {
        return Err(AppError::new(
            "install",
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }
    let destination = tools.join("languages");
    let previous = tools.join("languages-previous");
    if previous.exists() {
        return Err(AppError::new(
            "rollback",
            "A previous tool version is retained at tools/languages-previous. Remove it explicitly before another upgrade.",
        ));
    }
    if destination.exists() {
        fs::rename(&destination, &previous)?;
    }
    if let Err(e) = fs::rename(temp.path(), &destination) {
        if previous.exists() {
            let _ = fs::rename(previous, destination);
        }
        return Err(e.into());
    }
    Ok("Pinned TypeScript Native, TypeScript compatibility server and Prettier installed. npm verified package integrity against the bundled lockfile.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn process_paths_remove_windows_verbatim_prefixes() {
        for (input, expected) in [
            (
                r"\\?\D:\project with spaces\格式化\prettier.cjs",
                r"D:\project with spaces\格式化\prettier.cjs",
            ),
            (r"\\?\UNC\server\share\oxfmt", r"\\server\share\oxfmt"),
            (r"D:\project\prettier.cjs", r"D:\project\prettier.cjs"),
            (r"\\server\share\oxfmt", r"\\server\share\oxfmt"),
            ("--stdio", "--stdio"),
        ] {
            assert_eq!(process_path(Path::new(input)), PathBuf::from(expected));
        }
    }
}
