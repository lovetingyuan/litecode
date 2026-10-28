use crate::sync::MutexExt;
use crate::{
    error::{AppError, Result},
    files,
    state::{AppState, canonical},
};
use git2::{BranchType, Repository, RepositoryState, Status};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};
use tauri::{State, WebviewWindow};

pub mod blame;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub old_path: Option<String>,
    pub index_path: Option<String>,
    pub index_old_path: Option<String>,
    pub worktree_old_path: Option<String>,
    pub index_status: Option<String>,
    pub worktree_status: Option<String>,
    pub conflicted: bool,
    pub stamp: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub operation: Option<String>,
    pub changes: Vec<Change>,
}

pub fn visible(path: &Path) -> String {
    crate::tools::process_path(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub fn operation(repo: &Repository) -> Option<String> {
    match repo.state() {
        RepositoryState::Clean => None,
        RepositoryState::Merge => Some("merge".into()),
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge
        | RepositoryState::ApplyMailboxOrRebase => Some("rebase".into()),
        _ => Some("other".into()),
    }
}

pub fn current_branch(repo: &Repository) -> Option<String> {
    repo.head()
        .ok()
        .and_then(|head| {
            if head.is_branch() {
                head.shorthand().map(str::to_owned)
            } else {
                head.target().map(|id| id.to_string()[..7].to_owned())
            }
        })
        .or_else(|| {
            repo.find_reference("HEAD").ok().and_then(|head| {
                head.symbolic_target()
                    .and_then(|target| target.strip_prefix("refs/heads/"))
                    .map(str::to_owned)
            })
        })
}

fn status_name(status: Status, index: bool) -> Option<String> {
    let flags = if index {
        [
            Status::INDEX_NEW,
            Status::INDEX_DELETED,
            Status::INDEX_RENAMED,
            Status::INDEX_TYPECHANGE,
            Status::INDEX_MODIFIED,
        ]
    } else {
        [
            Status::WT_NEW,
            Status::WT_DELETED,
            Status::WT_RENAMED,
            Status::WT_TYPECHANGE,
            Status::WT_MODIFIED,
        ]
    };
    flags
        .into_iter()
        .zip(["added", "deleted", "renamed", "modified", "modified"])
        .find_map(|(flag, name)| {
            status.intersects(flag).then(|| {
                if !index && flag == Status::WT_NEW {
                    "untracked".into()
                } else {
                    name.into()
                }
            })
        })
}

fn stamp(root: &Path, path: &str, index_id: git2::Oid) -> String {
    match fs::symlink_metadata(root.join(path)) {
        Ok(meta) => format!(
            "{}:{}:{}",
            index_id,
            meta.len(),
            meta.modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ),
        Err(_) => format!("{index_id}:missing"),
    }
}

pub fn snapshot(repo: &Repository, statuses: &git2::Statuses<'_>) -> Snapshot {
    let root = repo.workdir().unwrap();
    let changes = statuses
        .iter()
        .filter(|e| !e.status().is_ignored())
        .filter_map(|entry| {
            let delta = entry.index_to_workdir().or_else(|| entry.head_to_index());
            let path = delta
                .as_ref()
                .and_then(|d| {
                    d.new_file()
                        .path()
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                })
                .or_else(|| entry.path().map(str::to_owned))?;
            let index_path = entry.head_to_index().and_then(|d| {
                d.new_file()
                    .path()
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
            });
            let index_old_path = entry
                .head_to_index()
                .filter(|d| d.status() == git2::Delta::Renamed)
                .and_then(|d| {
                    d.old_file()
                        .path()
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                });
            let worktree_old_path = entry
                .index_to_workdir()
                .filter(|d| d.status() == git2::Delta::Renamed)
                .and_then(|d| {
                    d.old_file()
                        .path()
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                });
            let old_path = index_old_path.clone().or(worktree_old_path.clone());
            let index_id = entry
                .head_to_index()
                .map(|d| d.new_file().id())
                .or_else(|| entry.index_to_workdir().map(|d| d.old_file().id()))
                .unwrap_or(git2::Oid::zero());
            Some(Change {
                stamp: stamp(root, &path, index_id),
                path,
                old_path,
                index_path,
                index_old_path,
                worktree_old_path,
                index_status: status_name(entry.status(), true),
                worktree_status: status_name(entry.status(), false),
                conflicted: entry.status().is_conflicted(),
            })
        })
        .collect();
    Snapshot {
        path: visible(root).trim_end_matches('/').into(),
        name: root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        branch: current_branch(repo),
        detached: repo.head_detached().unwrap_or(false),
        operation: operation(repo),
        changes,
    }
}

fn context(
    state: &AppState,
    label: &str,
    expected_root: &str,
    session: u64,
    repository: &str,
) -> Result<PathBuf> {
    let expected = canonical(Path::new(expected_root))?;
    let requested = canonical(Path::new(repository))?;
    let windows = state.windows.lock_recover();
    let window = windows
        .get(label)
        .ok_or_else(|| AppError::new("workspace", "Window is closed"))?;
    if window.root.as_ref() != Some(&expected) || window.workspace_session != session {
        return Err(AppError::new("workspace", "Workspace changed"));
    }
    let listed = window
        .repositories
        .repositories
        .lock_recover()
        .contains(&requested);
    let containing = Repository::discover(&expected)
        .ok()
        .and_then(|r| r.workdir().and_then(|p| canonical(p).ok()));
    if !listed && containing.as_ref() != Some(&requested) {
        return Err(AppError::new(
            "access",
            "Repository is not part of this workspace",
        ));
    }
    let repo = Repository::open(&requested).map_err(git_error)?;
    if repo.workdir().and_then(|p| canonical(p).ok()).as_ref() != Some(&requested) {
        return Err(AppError::new("access", "Not a working tree"));
    }
    Ok(requested)
}

fn git_error(error: impl std::fmt::Display) -> AppError {
    AppError::new("git", error.to_string())
}

// Validate each existing ancestor without resolving a link into an unrelated directory.
fn file_path(root: &Path, path: &str) -> Result<PathBuf> {
    let relative = Path::new(path);
    if path.is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || relative
            .components()
            .any(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
    {
        return Err(AppError::new("access", "Invalid repository path"));
    }
    let mut target = root.to_path_buf();
    for part in relative.components() {
        target.push(part);
        match fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(AppError::new(
                    "access",
                    "Git file operations through symbolic links are not supported",
                ));
            }
            Ok(_) => {
                let resolved = canonical(&target)?;
                if !resolved.starts_with(root)
                    || resolved.strip_prefix(root).is_ok_and(|path| {
                        path.components()
                            .any(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
                    })
                {
                    return Err(AppError::new(
                        "access",
                        "Path leaves the repository or enters Git metadata",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(target)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    name: String,
    current: bool,
    remote: bool,
    upstream: Option<String>,
    worktree: bool,
}
#[derive(Serialize)]
pub struct Remote {
    name: String,
    fetch: Option<String>,
    push: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    branch: Option<String>,
    detached: bool,
    head: Option<String>,
    upstream: Option<String>,
    ahead: Option<usize>,
    behind: Option<usize>,
    branches: Vec<Branch>,
    remotes: Vec<Remote>,
    operation: Option<String>,
    last_fetch: Option<u64>,
}

pub fn info(root: &Path) -> Result<Info> {
    let repo = Repository::open(root).map_err(git_error)?;
    let head = repo.head().ok();
    let branch = (!repo.head_detached().unwrap_or(false))
        .then(|| current_branch(&repo))
        .flatten();
    let upstream_branch = branch
        .as_ref()
        .and_then(|name| repo.find_branch(name, BranchType::Local).ok())
        .and_then(|b| b.upstream().ok());
    let upstream = upstream_branch
        .as_ref()
        .and_then(|b| b.name().ok().flatten())
        .map(str::to_owned);
    let counts = head
        .as_ref()
        .and_then(|h| h.target())
        .zip(upstream_branch.as_ref().and_then(|b| b.get().target()))
        .and_then(|(local, remote)| repo.graph_ahead_behind(local, remote).ok());
    let mut checked_out: HashSet<String> = repo
        .worktrees()
        .map_err(git_error)?
        .iter()
        .flatten()
        .filter_map(|name| repo.find_worktree(name).ok())
        .filter_map(|w| Repository::open(w.path()).ok())
        .filter_map(|r| r.head().ok().and_then(|h| h.name().map(str::to_owned)))
        .collect();
    if let Ok(common) = fs::read_to_string(repo.path().join("commondir"))
        && let Ok(primary) = Repository::open(repo.path().join(common.trim()))
        && let Ok(head) = primary.head()
        && let Some(name) = head.name()
    {
        checked_out.insert(name.into());
    }
    let mut branches = vec![];
    for entry in repo.branches(None).map_err(git_error)? {
        let (b, kind) = entry.map_err(git_error)?;
        if b.get().symbolic_target().is_some() {
            continue;
        }
        if let Some(name) = b.name().map_err(git_error)? {
            branches.push(Branch {
                name: name.into(),
                current: b.is_head(),
                remote: kind == BranchType::Remote,
                upstream: b
                    .upstream()
                    .ok()
                    .and_then(|u| u.name().ok().flatten().map(str::to_owned)),
                worktree: b.get().name().is_some_and(|n| checked_out.contains(n)),
            });
        }
    }
    branches.sort_by(|a, b| a.remote.cmp(&b.remote).then_with(|| a.name.cmp(&b.name)));
    let remotes = repo
        .remotes()
        .map_err(git_error)?
        .iter()
        .flatten()
        .map(|name| {
            let remote = repo.find_remote(name).map_err(git_error)?;
            Ok(Remote {
                name: name.into(),
                fetch: remote.url().map(str::to_owned),
                push: remote.pushurl().or(remote.url()).map(str::to_owned),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Info {
        branch,
        detached: repo.head_detached().unwrap_or(false),
        head: head
            .as_ref()
            .and_then(|h| h.target())
            .map(|id| id.to_string()),
        upstream,
        ahead: counts.map(|c| c.0),
        behind: counts.map(|c| c.1),
        branches,
        remotes,
        operation: operation(&repo),
        last_fetch: fs::metadata(repo.path().join("FETCH_HEAD"))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()),
    })
}

#[tauri::command]
pub async fn git_repository_info(
    window: WebviewWindow,
    state: State<'_, AppState>,
    expected_root: String,
    session: u64,
    repository: String,
) -> Result<Info> {
    let root = context(&state, window.label(), &expected_root, session, &repository)?;
    tauri::async_runtime::spawn_blocking(move || info(&root))
        .await
        .map_err(git_error)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    before: String,
    after: String,
    source: Option<String>,
    summary: Option<String>,
}

fn blob_bytes(
    repo: &Repository,
    path: &str,
    staged: bool,
    old_path: Option<&str>,
    conflicted: bool,
) -> Result<Vec<u8>> {
    let path = old_path.unwrap_or(path);
    let id = if staged {
        match repo.head().and_then(|h| h.peel_to_tree()) {
            Ok(tree) => tree.get_path(Path::new(path)).ok().map(|e| e.id()),
            Err(error)
                if matches!(
                    error.code(),
                    git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound
                ) =>
            {
                None
            }
            Err(error) => return Err(git_error(error)),
        }
    } else {
        repo.index()
            .map_err(git_error)?
            .get_path(Path::new(path), if conflicted { 2 } else { 0 })
            .map(|e| e.id)
    };
    let Some(id) = id else {
        return Ok(vec![]);
    };
    let blob = repo.find_blob(id).map_err(git_error)?;
    if blob.size() as u64 > files::LARGE_FILE {
        return Err(AppError::new(
            "gitSummary",
            "File exceeds the 20 MiB text comparison limit",
        ));
    }
    if blob.is_binary()
        && !blob.content().starts_with(&[0xff, 0xfe])
        && !blob.content().starts_with(&[0xfe, 0xff])
    {
        return Err(AppError::new("gitSummary", "Binary files differ"));
    }
    Ok(blob.content().to_vec())
}

pub fn diff(
    root: &Path,
    path: &str,
    staged: bool,
    old_path: Option<&str>,
    conflicted: bool,
) -> Result<Diff> {
    let target = file_path(root, path)?;
    if let Some(old) = old_path {
        file_path(root, old)?;
    }
    let repo = Repository::open(root).map_err(git_error)?;
    if target.is_dir()
        || repo
            .index()
            .ok()
            .and_then(|index| index.get_path(Path::new(path), 0))
            .is_some_and(|entry| entry.mode == 0o160000)
    {
        return Ok(Diff {
            before: String::new(),
            after: String::new(),
            source: None,
            summary: Some(
                "Submodule changes: select its repository to inspect individual files".into(),
            ),
        });
    }
    let result = (|| -> Result<Diff> {
        let before = blob_bytes(&repo, path, staged, old_path, conflicted)?;
        let after = if staged {
            let entry = repo
                .index()
                .map_err(git_error)?
                .get_path(Path::new(path), 0);
            if let Some(entry) = entry {
                let blob = repo.find_blob(entry.id).map_err(git_error)?;
                if blob.size() as u64 > files::LARGE_FILE
                    || blob.is_binary()
                        && !blob.content().starts_with(&[0xff, 0xfe])
                        && !blob.content().starts_with(&[0xfe, 0xff])
                {
                    return Err(AppError::new(
                        "gitSummary",
                        "Binary or large file: open the source to inspect it",
                    ));
                }
                blob.content().to_vec()
            } else {
                vec![]
            }
        } else if target.is_file() {
            if fs::metadata(&target)?.len() > files::LARGE_FILE {
                return Err(AppError::new(
                    "gitSummary",
                    "File exceeds the 20 MiB text comparison limit",
                ));
            }
            fs::read(&target)?
        } else {
            vec![]
        };
        let before = files::decode(&before, None)
            .map_err(|_| AppError::new("gitSummary", "Binary files differ"))?
            .0;
        let after = files::decode(&after, None)
            .map_err(|_| AppError::new("gitSummary", "Binary files differ"))?
            .0;
        Ok(Diff {
            before,
            after,
            source: (!staged && target.is_file()).then(|| visible(&target)),
            summary: None,
        })
    })();
    match result {
        Err(error) if error.code == "gitSummary" => Ok(Diff {
            before: String::new(),
            after: String::new(),
            source: None,
            summary: Some(error.message),
        }),
        other => other,
    }
}

#[tauri::command]
pub async fn git_read_diff(
    window: WebviewWindow,
    state: State<'_, AppState>,
    expected_root: String,
    session: u64,
    repository: String,
    path: String,
    staged: bool,
    old_path: Option<String>,
    conflicted: bool,
) -> Result<Diff> {
    let root = context(&state, window.label(), &expected_root, session, &repository)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        diff(&root, &path, staged, old_path.as_deref(), conflicted)
    })
    .await
    .map_err(git_error)??;
    if let Some(source) = &result.source {
        context(&state, window.label(), &expected_root, session, &repository)?;
        state
            .windows
            .lock_recover()
            .get_mut(window.label())
            .unwrap()
            .grants
            .insert(canonical(Path::new(source))?);
    }
    Ok(result)
}

#[tauri::command]
pub fn git_open_source(
    window: WebviewWindow,
    state: State<'_, AppState>,
    expected_root: String,
    session: u64,
    repository: String,
    path: String,
) -> Result<String> {
    let root = context(&state, window.label(), &expected_root, session, &repository)?;
    let target = file_path(&root, &path)?;
    if !target.is_file() {
        return Err(AppError::new(
            "git",
            "This file no longer exists in the working tree",
        ));
    }
    state
        .windows
        .lock_recover()
        .get_mut(window.label())
        .unwrap()
        .grants
        .insert(canonical(&target)?);
    Ok(visible(&target))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selected {
    pub path: String,
    pub stamp: String,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Operation {
    Stage {
        paths: Vec<String>,
    },
    Unstage {
        paths: Vec<String>,
    },
    Discard {
        files: Vec<Selected>,
    },
    Commit {
        message: String,
    },
    Fetch {
        remote: String,
    },
    Pull {
        remote: Option<String>,
        branch: Option<String>,
        rebase: bool,
    },
    Push {
        remote: Option<String>,
    },
    Switch {
        branch: String,
    },
    CreateBranch {
        name: String,
        start: Option<String>,
    },
    DeleteBranch {
        branch: String,
    },
    Continue,
    Abort,
}

mod process;

enum Prepared {
    Command {
        args: Vec<String>,
        input: Option<Vec<u8>>,
    },
    Done(String),
}

fn git_command(_root: &Path, args: &[&str], input: Option<&[u8]>) -> Result<Prepared> {
    Ok(Prepared::Command {
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        input: input.map(<[u8]>::to_vec),
    })
}

#[cfg(test)]
fn run_git(root: &Path, args: &[&str], input: Option<&[u8]>) -> Result<String> {
    process::run_sync(
        root,
        &args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>(),
        input,
    )
}

#[cfg(test)]
pub fn execute(root: &Path, request: Operation) -> Result<String> {
    match prepare(root, request)? {
        Prepared::Done(text) => Ok(text),
        Prepared::Command { args, input } => process::run_sync(root, &args, input.as_deref()),
    }
}

fn branch_name(name: &str) -> Result<()> {
    if name.starts_with('-') || !git2::Reference::is_valid_name(&format!("refs/heads/{name}")) {
        return Err(git_error("Invalid branch name"));
    }
    Ok(())
}
fn remote_name(repo: &Repository, name: &str) -> Result<()> {
    if name.starts_with('-')
        || !repo
            .remotes()
            .map_err(git_error)?
            .iter()
            .flatten()
            .any(|r| r == name)
    {
        return Err(git_error("Select an existing remote"));
    }
    Ok(())
}
fn path_input(root: &Path, paths: &[String]) -> Result<Vec<u8>> {
    if paths.is_empty() {
        return Err(git_error("No files selected"));
    }
    let mut input = vec![];
    for path in paths {
        file_path(root, path)?;
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    Ok(input)
}

fn prepare(root: &Path, request: Operation) -> Result<Prepared> {
    let repo = Repository::open(root).map_err(git_error)?;
    match request {
        Operation::Stage { paths } => git_command(
            root,
            &[
                "--literal-pathspecs",
                "add",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            Some(&path_input(root, &paths)?),
        ),
        Operation::Unstage { paths } => {
            let input = path_input(root, &paths)?;
            if repo.head().is_err() {
                git_command(
                    root,
                    &[
                        "--literal-pathspecs",
                        "rm",
                        "--cached",
                        "--force",
                        "--ignore-unmatch",
                        "--pathspec-from-file=-",
                        "--pathspec-file-nul",
                    ],
                    Some(&input),
                )
            } else {
                git_command(
                    root,
                    &[
                        "--literal-pathspecs",
                        "restore",
                        "--staged",
                        "--pathspec-from-file=-",
                        "--pathspec-file-nul",
                    ],
                    Some(&input),
                )
            }
        }
        Operation::Discard { files: selected } => {
            if selected.is_empty() {
                return Err(git_error("No files selected"));
            }
            let mut options = git2::StatusOptions::new();
            options
                .include_untracked(true)
                .recurse_untracked_dirs(true)
                .renames_head_to_index(true)
                .renames_index_to_workdir(true)
                .update_index(false);
            let statuses = repo.statuses(Some(&mut options)).map_err(git_error)?;
            let current = snapshot(&repo, &statuses);
            let mut tracked = vec![];
            let mut untracked = vec![];
            for file in selected {
                let target = file_path(root, &file.path)?;
                let change = current.changes.iter().find(|c| c.path == file.path && c.stamp == file.stamp).ok_or_else(|| git_error("Files changed since confirmation. Refresh and review before discarding."))?;
                if change.conflicted {
                    return Err(git_error(
                        "Resolve conflicts in the editor before staging the result",
                    ));
                }
                if change.worktree_status.as_deref() == Some("untracked") {
                    untracked.push(target);
                } else if let Some(old) = &change.worktree_old_path {
                    untracked.push(target);
                    tracked.push(old.clone());
                } else if change.worktree_status.is_some() {
                    tracked.push(change.path.clone());
                }
            }
            // Recycle first: a failed recycle must never fall back to permanent deletion.
            for path in untracked {
                trash::delete(path).map_err(git_error)?;
            }
            if tracked.is_empty() {
                Ok(Prepared::Done(String::new()))
            } else {
                git_command(
                    root,
                    &[
                        "--literal-pathspecs",
                        "restore",
                        "--worktree",
                        "--pathspec-from-file=-",
                        "--pathspec-file-nul",
                    ],
                    Some(&path_input(root, &tracked)?),
                )
            }
        }
        Operation::Commit { message } => {
            if message.trim().is_empty() {
                return Err(git_error("Commit message is required"));
            }
            if repo.index().map_err(git_error)?.has_conflicts() {
                return Err(git_error("Stage resolved conflicts before committing"));
            }
            git_command(root, &["commit", "--file=-"], Some(message.as_bytes()))
        }
        Operation::Fetch { remote } => {
            remote_name(&repo, &remote)?;
            git_command(root, &["fetch", "--progress", &remote], None)
        }
        Operation::Pull {
            remote,
            branch,
            rebase,
        } => {
            if repo.head_detached().unwrap_or(false) {
                return Err(git_error("Create or switch to a branch before pulling"));
            }
            let mut args = vec![
                "pull",
                if rebase { "--rebase" } else { "--no-rebase" },
                "--no-autostash",
                "--no-edit",
            ];
            if let Some(remote) = remote.as_deref() {
                remote_name(&repo, remote)?;
                let branch = branch
                    .as_deref()
                    .ok_or_else(|| git_error("Select a remote branch"))?;
                branch_name(branch)?;
                args.extend([remote, branch]);
            }
            git_command(root, &args, None)
        }
        Operation::Push { remote } => {
            if repo.head_detached().unwrap_or(false) {
                return Err(git_error("Create or switch to a branch before pushing"));
            }
            if let Some(remote) = remote {
                remote_name(&repo, &remote)?;
                let head = repo.head().map_err(git_error)?;
                let name = head
                    .shorthand()
                    .ok_or_else(|| git_error("No current branch"))?;
                git_command(
                    root,
                    &[
                        "push",
                        "--progress",
                        "--set-upstream",
                        &remote,
                        &format!("HEAD:refs/heads/{name}"),
                    ],
                    None,
                )
            } else {
                git_command(root, &["push", "--progress"], None)
            }
        }
        Operation::Switch { branch } => {
            branch_name(&branch)?;
            repo.find_branch(&branch, BranchType::Local)
                .map_err(git_error)?;
            git_command(root, &["switch", "--", &branch], None)
        }
        Operation::CreateBranch { name, start } => {
            branch_name(&name)?;
            let mut args = vec!["switch", "--create", name.as_str()];
            if let Some(start) = start.as_deref() {
                if !start.starts_with("refs/heads/") && !start.starts_with("refs/remotes/") {
                    return Err(git_error("Select a local or remote branch"));
                }
                repo.find_reference(start).map_err(git_error)?;
                if start.starts_with("refs/remotes/") {
                    args.push("--track");
                }
                args.push(start);
            }
            git_command(root, &args, None)
        }
        Operation::DeleteBranch { branch } => {
            branch_name(&branch)?;
            git_command(root, &["branch", "--delete", "--", &branch], None)
        }
        Operation::Continue | Operation::Abort => {
            let action = if matches!(request, Operation::Continue) {
                "--continue"
            } else {
                "--abort"
            };
            match operation(&repo).as_deref() {
                Some("merge") => git_command(root, &["merge", action], None),
                Some("rebase") => git_command(root, &["rebase", action], None),
                _ => Err(git_error("No supported merge or rebase is in progress")),
            }
        }
    }
}

#[tauri::command]
pub async fn git_operate(
    window: WebviewWindow,
    state: State<'_, AppState>,
    expected_root: String,
    session: u64,
    repository: String,
    request_id: String,
    request: Operation,
) -> Result<String> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(git_error("Invalid Git request ID"));
    }
    let label = window.label().to_owned();
    let key = format!("{label}/{request_id}");
    let (cancel, cancelled) = tokio::sync::watch::channel(false);
    {
        let mut tasks = state.git_tasks.lock_recover();
        if tasks.contains_key(&key) {
            return Err(git_error("Git request already exists"));
        }
        tasks.insert(key.clone(), cancel);
    }
    let _task = RunningTask { state: &state, key };
    let preparation_cancelled = cancelled.clone();
    let (root, _operation, prepared) = crate::state::blocking(window, move |window, state| {
        if *preparation_cancelled.borrow() { return Err(AppError::new("cancelled", "Git operation cancelled.")); }
        state.require_workspace_trust(window.label())?;
        let root = context(state, window.label(), &expected_root, session, &repository)?;
        let lock = {
            let mut operations = state.git_operations.lock_recover();
            operations.retain(|_, lock| Arc::strong_count(lock) > 1);
            operations.entry(root.clone()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
        };
        let guard = lock.try_lock_owned().map_err(|_| AppError::new("gitBusy",
            "Another Git operation is running in this repository. Wait or cancel it before retrying."))?;
        Ok((root.clone(), guard, prepare(&root, request)?))
    }).await?;
    let result = match prepared {
        Prepared::Done(text) => Ok(text),
        Prepared::Command { args, input } => {
            process::run(
                &root,
                &args,
                input.as_deref(),
                cancelled,
                Duration::from_secs(300),
            )
            .await
        }
    };
    result
}

struct RunningTask<'a> {
    state: &'a AppState,
    key: String,
}
impl Drop for RunningTask<'_> {
    fn drop(&mut self) {
        self.state.git_tasks.lock_recover().remove(&self.key);
        for window in self.state.windows.lock_recover().values() {
            window.repositories.invalidate();
        }
    }
}

#[tauri::command]
pub fn git_cancel(window: WebviewWindow, state: State<'_, AppState>, request_id: String) -> bool {
    state
        .git_tasks
        .lock_recover()
        .get(&format!("{}/{}", window.label(), request_id))
        .map(|task| {
            task.send_replace(true);
            true
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests;
