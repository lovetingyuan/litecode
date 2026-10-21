use crate::files;
use serde_json::Value;
use std::{fs, path::Path};

pub fn read_json(path: &Path, warnings: &mut Vec<String>) -> Value {
    match fs::read(path) {
        Ok(bytes) => {
            let parsed = if matches!(
                path.file_name().and_then(|s| s.to_str()),
                Some("settings.json" | "keybindings.json")
            ) {
                parse(&bytes).map_err(|e| e.to_string())
            } else {
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())
            };
            parsed.unwrap_or_else(|e| {
                let backup = path.with_extension(format!("corrupt-{}.json", &files::hash(&bytes)[..12]));
                let preserved = files::atomic_write(&backup, &bytes).is_ok();
                warnings.push(format!(
                    "Cannot read {}: {e}. {}",
                    path.display(), if preserved { format!("Original bytes preserved at {}", backup.display()) } else { "Could not create a corruption backup; inspect file permissions before editing configuration.".into() }
                ));
                Value::Null
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(e) => {
            warnings.push(format!("{}: {e}", path.display()));
            Value::Null
        }
    }
}

pub fn load_settings(user: &Path, workspace: Option<&Path>, warnings: &mut Vec<String>) -> Value {
    let mut settings = defaults();
    for path in std::iter::once(user.to_path_buf())
        .chain(workspace.map(|root| root.join(".litecode/settings.json")))
    {
        if let Some(values) = read_json(&path, warnings).as_object() {
            for (key, value) in values {
                if matches!(key.as_str(), "files.exclude" | "search.exclude")
                    && let Some(rules) = value.as_object()
                {
                    settings[key].as_object_mut().unwrap().extend(rules.clone());
                } else if !matches!(key.as_str(), "files.exclude" | "search.exclude") {
                    settings[key] = value.clone();
                }
            }
        }
    }
    settings
}

pub fn parse(bytes: &[u8]) -> Result<Value, serde_json_lenient::Error> {
    serde_json_lenient::from_slice(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes))
}

pub fn defaults() -> Value {
    let schema: Value =
        serde_json::from_str(include_str!("../../src/config/settings-schema.json")).unwrap();
    Value::Object(
        schema["properties"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, setting)| (key.clone(), setting["default"].clone()))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusion_patterns_merge_individually_across_configuration_layers() {
        let temp = tempfile::tempdir().unwrap();
        let user = temp.path().join("settings.json");
        let root = temp.path().join("project");
        fs::create_dir_all(root.join(".litecode")).unwrap();
        fs::write(&user, r#"{"search.exclude":{"**/node_modules":false,"**/cache":true},"files.exclude":{"**/*.js":{"when":"$(basename).ts"}}}"#).unwrap();
        fs::write(
            root.join(".litecode/settings.json"),
            r#"{"search.exclude":{"**/cache":false,"generated":true}}"#,
        )
        .unwrap();
        let settings = load_settings(&user, Some(&root), &mut vec![]);
        assert_eq!(settings["search.exclude"]["**/node_modules"], false);
        assert_eq!(settings["search.exclude"]["**/cache"], false);
        assert_eq!(settings["search.exclude"]["generated"], true);
        assert_eq!(settings["search.exclude"]["**/bower_components"], true);
        assert_eq!(settings["files.exclude"]["**/.git"], true);
        assert_eq!(
            settings["files.exclude"]["**/*.js"]["when"],
            "$(basename).ts"
        );
        fs::write(root.join(".litecode/settings.json"), "{}").unwrap();
        assert_eq!(
            load_settings(&user, Some(&root), &mut vec![])["search.exclude"]["**/cache"],
            true
        );
    }

    #[test]
    fn jsonc_keeps_string_contents_and_accepts_comments_and_trailing_commas() {
        let value = parse(
            br#"{ // a comment
          "editor.lineHeight": 24,
          "path": "C:\\tools\\node.exe",
          "url": "https://example.com/*not a comment*/",
          "items": [1, /* block comment */ 2,],
        }"#,
        )
        .unwrap();
        assert_eq!(value["editor.lineHeight"], 24);
        assert_eq!(value["path"], r"C:\tools\node.exe");
        assert_eq!(value["url"], "https://example.com/*not a comment*/");
        assert_eq!(value["items"], serde_json::json!([1, 2]));
        assert!(parse(br#"{"broken": }"#).is_err());
        assert_eq!(defaults()["editor.lineHeight"], 20);
        assert!(defaults()["litecode.nodePath"].is_null());
    }

    #[test]
    fn settings_merge_defaults_user_and_workspace_and_reset_deleted_overrides() {
        let temp = tempfile::tempdir().unwrap();
        let user = temp.path().join("settings.json");
        let workspace = temp.path().join("project");
        fs::create_dir_all(workspace.join(".litecode")).unwrap();
        let project = workspace.join(".litecode/settings.json");
        fs::write(
            &user,
            "{ // user\n\"editor.lineHeight\":24,\"editor.fontSize\":16,}",
        )
        .unwrap();
        fs::write(&project, "{/* project */\"editor.lineHeight\":30,}").unwrap();
        let mut warnings = vec![];
        let settings = load_settings(&user, Some(&workspace), &mut warnings);
        assert_eq!(settings["editor.lineHeight"], 30);
        assert_eq!(settings["editor.fontSize"], 16);
        assert_eq!(settings["editor.tabSize"], 4);
        assert!(warnings.is_empty());
        fs::write(&project, "{}").unwrap();
        assert_eq!(
            load_settings(&user, Some(&workspace), &mut warnings)["editor.lineHeight"],
            24
        );
        fs::write(&user, "{}").unwrap();
        assert_eq!(
            load_settings(&user, Some(&workspace), &mut warnings)["editor.lineHeight"],
            20
        );
        assert!(
            !user
                .with_extension(format!("corrupt-{}.json", &files::hash(b"{}")[..12]))
                .exists()
        );
        fs::write(&user, "{ broken }").unwrap();
        assert_eq!(
            load_settings(&user, None, &mut warnings)["editor.lineHeight"],
            20
        );
        assert_eq!(warnings.len(), 1);
        assert!(
            user.with_extension(format!(
                "corrupt-{}.json",
                &files::hash(b"{ broken }")[..12]
            ))
            .is_file()
        );
    }
}
