use crate::{
    error::{AppError, Result},
    tools::process_path,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, Option<String>>,
    pub kind: String,
}

pub fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

pub fn expand(value: &str, root: Option<&Path>) -> Result<String> {
    let pattern = regex::Regex::new(r"\$\{([^}]+)\}").unwrap();
    let mut error = None;
    let result = pattern.replace_all(value, |caps: &regex::Captures<'_>| {
        let key = &caps[1];
        let resolved = match key {
            "workspaceFolder" => root.map(|p| process_path(p).to_string_lossy().into_owned()),
            "userHome" => Some(home().to_string_lossy().into_owned()),
            _ => key
                .strip_prefix("env:")
                .and_then(|name| std::env::var(name).ok()),
        };
        resolved.unwrap_or_else(|| {
            error = Some(format!("Cannot resolve ${{{key}}}"));
            String::new()
        })
    });
    match error {
        Some(message) => Err(AppError::new("terminalConfig", message)),
        None => Ok(result.into_owned()),
    }
}

fn find(name: &str) -> Option<PathBuf> {
    let direct = PathBuf::from(name);
    if direct.is_absolute() {
        return direct.is_file().then_some(direct);
    }
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .filter(|p| p.is_absolute())
        .find_map(|dir| {
            [dir.join(name), dir.join(format!("{name}.exe"))]
                .into_iter()
                .find(|p| p.is_file())
        })
}

fn profile(name: &str, path: PathBuf, kind: &str) -> Profile {
    Profile {
        name: name.into(),
        path: process_path(&path).to_string_lossy().into_owned(),
        args: if kind == "bash" {
            vec!["--login".into(), "-i".into()]
        } else {
            vec![]
        },
        env: BTreeMap::new(),
        kind: kind.into(),
    }
}

pub fn detect(settings: &Value, root: Option<&Path>) -> Result<Vec<Profile>> {
    let system =
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()));
    let programs = PathBuf::from(
        std::env::var_os("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".into()),
    );
    let mut builtins = vec![];
    if let Some(path) = find("pwsh.exe").or_else(|| {
        let p = programs.join("PowerShell/7/pwsh.exe");
        p.is_file().then_some(p)
    }) {
        builtins.push(profile("PowerShell", path, "powershell"));
    }
    let powershell = system.join("System32/WindowsPowerShell/v1.0/powershell.exe");
    if powershell.is_file() {
        builtins.push(profile("Windows PowerShell", powershell, "powershell"));
    }
    let cmd = system.join("System32/cmd.exe");
    if cmd.is_file() {
        builtins.push(profile("Command Prompt", cmd, "cmd"));
    }
    let mut git_paths = vec![
        programs.join("Git/bin/bash.exe"),
        home().join("AppData/Local/Programs/Git/bin/bash.exe"),
    ];
    if let Some(git) = find("git.exe") {
        if let Some(dir) = git.parent().and_then(Path::parent) {
            git_paths.insert(0, dir.join("bin/bash.exe"));
        }
    }
    if let Some(path) = git_paths.into_iter().find(|p| p.is_file()) {
        builtins.push(profile("Git Bash", path, "bash"));
    }
    #[cfg(not(windows))]
    if let Some(path) = find("bash") {
        builtins.push(profile("Bash", path, "bash"));
    }
    let mut result = builtins.clone();
    if let Some(configured) = settings["terminal.integrated.profiles.windows"].as_object() {
        for (name, value) in configured {
            if !value.is_null() && !value.is_object() {
                continue;
            }
            let position = result.iter().position(|p| &p.name == name);
            result.retain(|p| &p.name != name);
            if value.is_null() {
                continue;
            }
            let Some(object) = value.as_object() else {
                continue;
            };
            let source = object.get("source").and_then(Value::as_str).unwrap_or(name);
            let base = builtins.iter().find(|p| p.name == source);
            let path = match object.get("path").and_then(Value::as_str) {
                Some(path) => {
                    let path = expand(path, root)?;
                    find(&path).unwrap_or_else(|| PathBuf::from(path))
                }
                None => match base {
                    Some(p) => PathBuf::from(&p.path),
                    None => continue,
                },
            };
            let kind = match path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase()
                .as_str()
            {
                "pwsh" | "powershell" => "powershell",
                "cmd" => "cmd",
                "bash" => "bash",
                _ => "custom",
            };
            let mut p = profile(name, path, kind);
            if let Some(args) = object.get("args").and_then(Value::as_array) {
                p.args = args
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|s| expand(s, root))
                    .collect::<Result<_>>()?;
            } else if let Some(base) = base {
                p.args = base.args.clone();
            }
            if let Some(env) = object.get("env").and_then(Value::as_object) {
                p.env = env
                    .iter()
                    .filter(|(_, v)| v.is_string() || v.is_null())
                    .map(|(k, v)| (k.clone(), v.as_str().map(String::from)))
                    .collect();
            }
            if let Some(position) = position {
                result.insert(position.min(result.len()), p);
            } else {
                result.push(p);
            }
        }
    }
    Ok(result)
}

pub fn directory(settings: &Value, root: Option<&Path>) -> Result<PathBuf> {
    let value = settings["terminal.integrated.cwd"].as_str().unwrap_or("");
    let path = if value.is_empty() {
        root.map(Path::to_path_buf).unwrap_or_else(home)
    } else {
        let path = PathBuf::from(expand(value, root)?);
        if path.is_absolute() {
            path
        } else {
            root.map(Path::to_path_buf).unwrap_or_else(home).join(path)
        }
    };
    if !path.is_dir() {
        return Err(AppError::new(
            "terminalCwd",
            format!("Terminal directory does not exist: {}", path.display()),
        ));
    }
    Ok(process_path(&std::fs::canonicalize(path)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn variables_and_directories_are_explicit() {
        let temp = tempfile::tempdir().unwrap();
        assert!(expand("${workspaceFolder}", None).is_err());
        assert!(expand("${unknown}", Some(temp.path())).is_err());
        assert_eq!(
            directory(&serde_json::json!({}), Some(temp.path())).unwrap(),
            process_path(&std::fs::canonicalize(temp.path()).unwrap())
        );
        assert!(
            directory(
                &serde_json::json!({"terminal.integrated.cwd":"missing"}),
                Some(temp.path())
            )
            .is_err()
        );
    }
    #[test]
    fn custom_profiles_preserve_argument_boundaries_and_can_hide_builtins() {
        let settings = serde_json::json!({"terminal.integrated.profiles.windows": {"Command Prompt":null,"Test":{"path":"C:\\my tools\\shell.exe","args":["hello world","${userHome}"],"env":{"DROP":null,"KEEP":"yes"}}}});
        let profiles = detect(&settings, None).unwrap();
        assert!(!profiles.iter().any(|p| p.name == "Command Prompt"));
        let p = profiles.iter().find(|p| p.name == "Test").unwrap();
        assert_eq!(p.args[0], "hello world");
        assert_eq!(p.env["DROP"], None);
    }
}
