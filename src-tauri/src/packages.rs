use crate::{
    error::{AppError, Result},
    state::{AppState, canonical},
    sync::MutexExt,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};
use tauri::{State, WebviewWindow};

fn workspace_root(window: &WebviewWindow, state: &AppState, expected: &str) -> Result<PathBuf> {
    let expected = canonical(std::path::Path::new(expected))?;
    let windows = state.windows.lock_recover();
    windows
        .get(window.label())
        .and_then(|window| window.root.as_ref())
        .filter(|root| **root == expected)
        .cloned()
        .ok_or_else(|| AppError::new("workspace", "Workspace changed before reading package.json"))
}

fn package_directory(root: &Path, manifest_path: &Path) -> Result<PathBuf> {
    if !manifest_path.is_absolute()
        || manifest_path
            .file_name()
            .is_none_or(|name| name != "package.json")
    {
        return Err(AppError::new(
            "package",
            "Expected an absolute package.json path",
        ));
    }
    let manifest = std::fs::canonicalize(manifest_path)?;
    if !manifest.starts_with(root)
        || manifest
            .file_name()
            .is_none_or(|name| name != "package.json")
        || !manifest.is_file()
    {
        return Err(AppError::new(
            "access",
            "Package manifest is outside the workspace or invalid",
        ));
    }
    manifest
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::new("package", "Package directory is invalid"))
}

fn read_json(path: &std::path::Path) -> Result<Value> {
    if std::fs::metadata(path)?.len() > 2 * 1024 * 1024 {
        return Err(AppError::new(
            "package",
            "Package manifest exceeds the 2 MB limit",
        ));
    }
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

pub fn valid_package_name(name: &str) -> bool {
    let valid_part = |part: &str| {
        !part.is_empty()
            && !part.starts_with('.')
            && !part.starts_with('-')
            && part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.~".contains(&c))
    };
    if name.len() > 214 {
        return false;
    }
    if let Some(scoped) = name.strip_prefix('@') {
        scoped
            .split_once('/')
            .is_some_and(|(scope, package)| valid_part(scope) && valid_part(package))
    } else {
        valid_part(name)
    }
}

#[derive(Serialize)]
pub struct PackageSnapshot {
    directory: String,
    installed: BTreeMap<String, String>,
    warnings: Vec<String>,
}

#[tauri::command]
pub async fn package_snapshot(
    window: WebviewWindow,
    state: State<'_, AppState>,
    root: String,
    manifest_path: String,
) -> Result<PackageSnapshot> {
    let root = workspace_root(&window, &state, &root)?;
    tauri::async_runtime::spawn_blocking(move || read_snapshot(&root, Path::new(&manifest_path)))
        .await
        .map_err(|error| AppError::new("package", error.to_string()))?
}

fn read_snapshot(root: &Path, manifest_path: &Path) -> Result<PackageSnapshot> {
    let directory = package_directory(root, manifest_path)?;
    let manifest = read_json(&directory.join("package.json"))?;
    let mut snapshot = PackageSnapshot {
        directory: crate::tools::process_path(&directory)
            .to_string_lossy()
            .into_owned(),
        installed: BTreeMap::new(),
        warnings: vec![],
    };
    for section in [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ] {
        for name in manifest
            .get(section)
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|deps| deps.keys())
        {
            if !valid_package_name(name) || snapshot.installed.contains_key(name) {
                continue;
            }
            let Some(path) = directory
                .ancestors()
                .take_while(|ancestor| ancestor.starts_with(root))
                .map(|ancestor| {
                    ancestor
                        .join("node_modules")
                        .join(name)
                        .join("package.json")
                })
                .find(|path| path.is_file())
            else {
                continue;
            };
            match read_json(&path) {
                Ok(package) => {
                    if let Some(version) = package.get("version").and_then(Value::as_str) {
                        snapshot.installed.insert(name.clone(), version.into());
                    }
                }
                Err(error) => snapshot.warnings.push(format!("{name}: {}", error.message)),
            }
        }
    }
    Ok(snapshot)
}

async fn request_json(request: reqwest::RequestBuilder) -> Result<Value> {
    let response = request
        .send()
        .await
        .map_err(|error| AppError::new("registry", error.to_string()))?
        .error_for_status()
        .map_err(|error| AppError::new("registry", error.to_string()))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|error| AppError::new("registry", error.to_string()))?;
    Ok(serde_json::from_slice(&bytes)?)
}

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("LiteCode package manager")
        .build()
        .expect("HTTP client configuration is valid")
});

async fn npm_metadata(name: &str, version: Option<&str>) -> Result<Value> {
    let mut url = url::Url::parse("https://registry.npmjs.org/").unwrap();
    url.path_segments_mut().unwrap().push(name);
    if let Some(version) = version {
        url.path_segments_mut().unwrap().push(version);
    }
    let mut request = CLIENT.get(url);
    if version.is_none() {
        request = request.header("Accept", "application/vnd.npm.install-v1+json");
    }
    request_json(request).await
}

fn resolve_declared<'a>(packument: &'a Value, declared: &str) -> Option<&'a Value> {
    let versions = packument.get("versions")?.as_object()?;
    if let Some(tag) = packument
        .get("dist-tags")
        .and_then(|tags| tags.get(declared))
        .and_then(Value::as_str)
    {
        return versions.get(tag);
    }
    let range = declared.parse::<node_semver::Range>().ok()?;
    versions
        .iter()
        .filter_map(|(version, package)| {
            let version = version.parse::<node_semver::Version>().ok()?;
            version.satisfies(&range).then_some((version, package))
        })
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(_, package)| package)
}

async fn declared_metadata(name: &str, declared: &str) -> Result<Value> {
    if declared.parse::<node_semver::Version>().is_ok() {
        return npm_metadata(name, Some(declared)).await;
    }
    let packument = npm_metadata(name, None).await?;
    resolve_declared(&packument, declared)
        .cloned()
        .ok_or_else(|| {
            AppError::new(
                "registry",
                format!("No published version matches {declared}"),
            )
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageRegistry {
    latest: Option<String>,
    repository: Option<String>,
    warnings: Vec<String>,
    errors: Vec<String>,
}

#[tauri::command]
pub async fn package_registry(
    name: String,
    declared: String,
    installed: Option<String>,
) -> Result<PackageRegistry> {
    if !valid_package_name(&name) || declared.len() > 256 || declared.chars().any(char::is_control)
    {
        return Err(AppError::new(
            "package",
            "Invalid registry package or version",
        ));
    }
    let (latest, declared_package) = tokio::join!(
        npm_metadata(&name, Some("latest")),
        declared_metadata(&name, &declared)
    );
    let mut result = PackageRegistry {
        latest: None,
        repository: None,
        warnings: vec![],
        errors: vec![],
    };
    match latest {
        Ok(package) => {
            result.latest = package
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_owned);
            result.repository = package
                .get("repository")
                .and_then(|repo| {
                    repo.as_str()
                        .or_else(|| repo.get("url").and_then(Value::as_str))
                })
                .map(str::to_owned);
        }
        Err(error) => result
            .errors
            .push(format!("Latest version unavailable: {}", error.message)),
    }
    let mut versions = BTreeMap::new();
    match declared_package {
        Ok(package) => {
            if let Some(version) = package.get("version").and_then(Value::as_str) {
                versions.insert(version.to_owned(), package);
            }
        }
        Err(error) => result.errors.push(format!(
            "Declared version could not be resolved: {}",
            error.message
        )),
    }
    if let Some(version) = installed.filter(|version| !versions.contains_key(version)) {
        match npm_metadata(&name, Some(&version)).await {
            Ok(package) => {
                versions.insert(version, package);
            }
            Err(error) => {
                result
                    .errors
                    .push(format!("Installed metadata unavailable: {}", error.message));
                versions.insert(version, Value::Null);
            }
        }
    }
    for (version, package) in versions {
        if let Some(deprecated) = package
            .get("deprecated")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            result
                .warnings
                .push(format!("Deprecated ({version}): {deprecated}"));
        }
        let body = json!({ "package": { "name": name, "ecosystem": "npm" }, "version": version });
        match request_json(
            CLIENT
                .post("https://api.osv.dev/v1/query")
                .header("Content-Type", "application/json")
                .body(body.to_string()),
        )
        .await
        {
            Ok(response) => {
                for vulnerability in response
                    .get("vulns")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let id = vulnerability
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("Security advisory");
                    let summary = vulnerability
                        .get("summary")
                        .and_then(Value::as_str)
                        .or_else(|| vulnerability.get("details").and_then(Value::as_str))
                        .unwrap_or("Known vulnerability");
                    result.warnings.push(format!("{id} ({version}): {summary}"));
                }
                if response.get("next_page_token").is_some() {
                    result.errors.push(format!(
                        "More security advisories exist for {version}; see osv.dev"
                    ));
                }
            }
            Err(error) => result.errors.push(format!(
                "Security check unavailable ({version}): {}",
                error.message
            )),
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    fn write_manifest(path: &std::path::Path, value: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, value).unwrap();
    }

    #[test]
    fn nested_snapshots_prefer_local_dependencies_and_find_hoisted_versions() {
        let fixture = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(fixture.path()).unwrap();
        let package = root.join("packages/app/package.json");
        write_manifest(
            &root.join("package.json"),
            r#"{"dependencies":{"root-only":"*"}}"#,
        );
        write_manifest(
            &package,
            r#"{"dependencies":{"local":"*","hoisted":"*","missing":"*"}}"#,
        );
        write_manifest(
            &root.join("node_modules/local/package.json"),
            r#"{"version":"1.0.0"}"#,
        );
        write_manifest(
            &root.join("packages/app/node_modules/local/package.json"),
            r#"{"version":"2.0.0"}"#,
        );
        write_manifest(
            &root.join("node_modules/hoisted/package.json"),
            r#"{"version":"3.0.0"}"#,
        );
        let snapshot = super::read_snapshot(&root, &package).unwrap();
        assert_eq!(
            snapshot.directory,
            crate::tools::process_path(&root.join("packages/app")).to_string_lossy()
        );
        assert_eq!(snapshot.installed["local"], "2.0.0");
        assert_eq!(snapshot.installed["hoisted"], "3.0.0");
        assert_eq!(snapshot.installed.len(), 2);
        let root_snapshot = super::read_snapshot(&root, &root.join("package.json")).unwrap();
        assert!(root_snapshot.installed.is_empty());
    }

    #[test]
    fn package_paths_and_dependency_lookup_stay_inside_the_workspace() {
        let fixture = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(fixture.path()).unwrap();
        let root = base.join("workspace");
        let package = root.join("package.json");
        write_manifest(&package, r#"{"dependencies":{"outside":"*"}}"#);
        write_manifest(
            &base.join("node_modules/outside/package.json"),
            r#"{"version":"9.0.0"}"#,
        );
        write_manifest(&base.join("package.json"), "{}");
        write_manifest(&root.join("other.json"), "{}");
        assert!(
            super::read_snapshot(&root, &package)
                .unwrap()
                .installed
                .is_empty()
        );
        assert!(super::package_directory(&root, &base.join("package.json")).is_err());
        assert!(super::package_directory(&root, &root.join("../package.json")).is_err());
        assert!(super::package_directory(&root, &root.join("other.json")).is_err());
        assert!(super::package_directory(&root, std::path::Path::new("package.json")).is_err());
    }

    #[test]
    fn manifests_cannot_escape_through_directory_links() {
        let fixture = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(fixture.path()).unwrap();
        let root = base.join("workspace");
        let outside = base.join("outside");
        std::fs::create_dir(&root).unwrap();
        write_manifest(&outside.join("package.json"), "{}");
        let link = root.join("linked");
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .output()
                .unwrap();
            assert!(status.status.success());
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(super::package_directory(&root, &link.join("package.json")).is_err());
    }

    #[test]
    fn resolves_npm_ranges_tags_and_prereleases_without_changing_the_selected_major() {
        let metadata = serde_json::json!({
            "dist-tags": { "latest": "2.0.0", "next": "3.0.0-beta.1" },
            "versions": {
                "1.0.0": { "version": "1.0.0" },
                "1.5.0": { "version": "1.5.0" },
                "2.0.0": { "version": "2.0.0" },
                "3.0.0-beta.1": { "version": "3.0.0-beta.1" }
            }
        });
        for (range, expected) in [
            ("^1.0.0", "1.5.0"),
            ("~1.0", "1.0.0"),
            ("1.x || 2.x", "2.0.0"),
            ("latest", "2.0.0"),
            ("next", "3.0.0-beta.1"),
            ("*", "2.0.0"),
        ] {
            assert_eq!(
                super::resolve_declared(&metadata, range).unwrap()["version"],
                expected
            );
        }
        assert!(super::resolve_declared(&metadata, "^4.0.0").is_none());
    }

    #[test]
    fn package_names_cannot_escape_node_modules_or_registry_paths() {
        for name in ["react", "@scope/package", "@types/node", "some.package"] {
            assert!(super::valid_package_name(name));
        }
        for name in [
            "",
            "..",
            "../secret",
            "@scope/../secret",
            "@scope/pkg/sub",
            "a\\b",
            "-x",
            "https://example.com",
            "a?b",
        ] {
            assert!(!super::valid_package_name(name));
        }
    }
}
