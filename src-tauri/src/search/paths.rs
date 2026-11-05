use super::{Query, split_globs};
use crate::error::{AppError, Result};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde_json::Value;
use std::{path::Path, sync::atomic::Ordering};
use tokio::{
    io::{AsyncReadExt, BufReader},
    process::{Child, ChildStdout, Command},
    task::JoinHandle,
};

struct Exclusion {
    pattern: GlobSet,
    when: Option<String>,
    absolute: bool,
}

pub(super) struct PathFilter {
    include: Patterns,
    exclude: Patterns,
    settings: Vec<Exclusion>,
}

struct Patterns {
    relative: GlobSet,
    absolute: GlobSet,
}

fn is_absolute(pattern: &str) -> bool {
    pattern.starts_with('/') || pattern.as_bytes().get(1) == Some(&b':')
}

impl Patterns {
    fn new(value: &str) -> Result<Self> {
        let (absolute, relative): (Vec<_>, Vec<_>) = input_patterns(value)
            .into_iter()
            .partition(|p| is_absolute(p));
        Ok(Self {
            relative: compile(relative)?,
            absolute: compile(absolute)?,
        })
    }

    fn is_empty(&self) -> bool {
        self.relative.is_empty() && self.absolute.is_empty()
    }

    fn matches(&self, relative: &str, absolute: &str) -> bool {
        Path::new(relative)
            .ancestors()
            .any(|p| self.relative.is_match(p))
            || Path::new(absolute)
                .ancestors()
                .any(|p| self.absolute.is_match(p))
    }
}

fn compile(patterns: impl IntoIterator<Item = String>) -> Result<GlobSet> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(
            GlobBuilder::new(&pattern)
                .literal_separator(true)
                .backslash_escape(false)
                .build()
                .map_err(|e| {
                    AppError::new("searchGlob", format!("Invalid pattern {pattern}: {e}"))
                })?,
        );
    }
    builder
        .build()
        .map_err(|e| AppError::new("searchGlob", e.to_string()))
}

fn input_patterns(value: &str) -> Vec<String> {
    let value = value.replace('\\', "/");
    split_globs(&value)
        .into_iter()
        .map(|pattern| {
            let pattern = pattern.trim_end_matches('/');
            if pattern.is_empty() || pattern == "." {
                "**".into()
            } else if let Some(pattern) = pattern.strip_prefix("./") {
                pattern.into()
            } else if is_absolute(pattern) {
                visible(Path::new(pattern))
            } else {
                format!("**/{pattern}")
            }
        })
        .collect()
}

pub(super) fn visible(path: &Path) -> String {
    let path = crate::file_moves::visible(path);
    let path = if let Some(unc) = path.strip_prefix("//?/UNC/") {
        format!("//{unc}")
    } else {
        path.strip_prefix("//?/").unwrap_or(&path).to_owned()
    };
    // Windows drive letters are case insensitive even when glob matching is not.
    if path.as_bytes().get(1) == Some(&b':') {
        format!("{}{}", path[..1].to_ascii_lowercase(), &path[1..])
    } else {
        path
    }
}

pub(super) fn relative(path: &Path, root: &Path) -> Option<String> {
    let path = visible(path);
    let root = visible(root);
    let root = root.trim_end_matches('/');
    let prefix = path.get(..root.len())?;
    let same = if cfg!(windows) {
        prefix.eq_ignore_ascii_case(root)
    } else {
        prefix == root
    };
    if !same {
        return None;
    }
    path.get(root.len()..)?.strip_prefix('/').map(str::to_owned)
}

impl PathFilter {
    pub(super) fn new(query: &Query, settings: &Value) -> Result<Self> {
        let settings = if query.use_ignore {
            crate::quick_files::exclusion_rules(settings)
        } else {
            Default::default()
        };
        let mut exclusions = vec![];
        for (pattern, value) in settings {
            if pattern.is_empty() || value == false {
                continue;
            }
            let when = value["when"].as_str().map(str::to_owned);
            if value == true || when.is_some() {
                exclusions.push(Exclusion {
                    pattern: compile([visible(Path::new(&pattern)).trim_end_matches('/').into()])?,
                    when,
                    absolute: is_absolute(&pattern.replace('\\', "/")),
                });
            }
        }
        Ok(Self {
            include: Patterns::new(&query.include)?,
            exclude: Patterns::new(&query.exclude)?,
            settings: exclusions,
        })
    }

    pub(super) fn accepts(&self, path: &Path, root: Option<&Path>) -> Result<bool> {
        let absolute = visible(path);
        let relative = root
            .and_then(|root| relative(path, root))
            .unwrap_or_else(|| absolute.clone());
        if (!self.include.is_empty() && !self.include.matches(&relative, &absolute))
            || self.exclude.matches(&relative, &absolute)
        {
            return Ok(false);
        }
        for ancestor in Path::new(&relative)
            .ancestors()
            .filter(|p| !p.as_os_str().is_empty())
        {
            let absolute = root.map_or_else(|| ancestor.to_path_buf(), |r| r.join(ancestor));
            let absolute_path = visible(&absolute);
            for rule in &self.settings {
                let candidate = if rule.absolute {
                    Path::new(&absolute_path)
                } else {
                    ancestor
                };
                if !rule.pattern.is_match(candidate) {
                    continue;
                }
                let Some(when) = &rule.when else {
                    return Ok(false);
                };
                let basename = ancestor.file_stem().unwrap_or_default().to_string_lossy();
                let sibling = absolute.with_file_name(when.replace("$(basename)", &basename));
                if sibling.try_exists()? {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }
}

// Count UTF-16 plus worst-case Windows argument quoting, including the separator.
fn argument_units(value: &str) -> usize {
    value.encode_utf16().count() * 2 + 3
}

pub(super) struct PathBatch {
    pub(super) paths: Vec<String>,
    base: usize,
    units: usize,
}

impl PathBatch {
    pub(super) fn new(command: &tokio::process::Command) -> Self {
        let command = command.as_std();
        let base = std::iter::once(command.get_program())
            .chain(command.get_args())
            .map(|arg| argument_units(&arg.to_string_lossy()))
            .sum();
        Self {
            paths: vec![],
            base,
            units: base,
        }
    }

    pub(super) fn fits(&self, path: &str) -> bool {
        self.paths.len() < 512 && self.units + argument_units(path) < 28_000
    }

    pub(super) fn push(&mut self, path: String) -> Result<()> {
        if !self.fits(&path) {
            return Err(AppError::new(
                "searchTool",
                "Search arguments exceed the command line limit",
            ));
        }
        self.units += argument_units(&path);
        self.paths.push(path);
        Ok(())
    }

    pub(super) fn clear(&mut self) {
        self.paths.clear();
        self.units = self.base;
    }
}

pub(super) fn enumeration_settings(query: &Query, settings: &Value) -> Value {
    let mut settings = if query.use_ignore {
        settings.clone()
    } else {
        serde_json::json!({})
    };
    if !query.use_ignore {
        settings["search.useIgnoreFiles"] = false.into();
    }
    settings["search.followSymlinks"] = query.follow_symlinks.into();
    settings
}

pub(super) struct CandidateFiles {
    child: Child,
    reader: BufReader<ChildStdout>,
    errors: Option<JoinHandle<String>>,
}

impl CandidateFiles {
    pub(super) fn start(rg: &Path, root: &Path, settings: &Value) -> Result<Self> {
        let mut command = Command::new(rg);
        command
            .args(crate::quick_files::arguments(settings))
            .arg(".")
            .current_dir(root)
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|e| AppError::new("searchTool", format!("Cannot list search files: {e}")))?;
        let reader = BufReader::new(child.stdout.take().unwrap());
        let stderr = child.stderr.take().unwrap();
        let errors = tokio::spawn(async move {
            let mut bytes = vec![];
            let _ = stderr.take(16384).read_to_end(&mut bytes).await;
            String::from_utf8_lossy(&bytes).into_owned()
        });
        Ok(Self {
            child,
            reader,
            errors: Some(errors),
        })
    }

    pub(super) async fn next(&mut self, task: &super::SearchTask) -> Result<Option<String>> {
        if task.cancelled.load(Ordering::Acquire) || self.errors.is_none() {
            return Ok(None);
        }
        if let Some(mut bytes) = super::read_record(&mut self.reader, task, 0).await? {
            if bytes.last() == Some(&0) {
                bytes.pop();
            }
            let path = String::from_utf8(bytes).map_err(|e| {
                AppError::new("searchPath", format!("Invalid search file path: {e}"))
            })?;
            return Ok(Some(
                path.strip_prefix("./")
                    .or_else(|| path.strip_prefix(".\\"))
                    .unwrap_or(&path)
                    .replace('\\', "/"),
            ));
        }
        if task.cancelled.load(Ordering::Acquire) {
            return Ok(None);
        }
        let status = self.child.wait().await?;
        let errors = self.errors.take().unwrap().await.unwrap_or_default();
        if !status.success() && status.code() != Some(1) {
            return Err(AppError::new(
                "searchFiles",
                format!("Cannot list search files: {errors}"),
            ));
        }
        Ok(None)
    }
}
