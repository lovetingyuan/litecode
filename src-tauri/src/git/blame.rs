use super::{context, file_path, git_error};
use crate::{error::Result, files, state::AppState, sync::MutexExt};
use git2::{BlameOptions, DiffOptions, ErrorCode, Oid, Patch, Repository};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{State, WebviewWindow};

const CACHE_BYTES: usize = 32 * 1024 * 1024;
const CACHE_FILES: usize = 8;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    start_line: usize,
    line_count: usize,
    commit: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    author: String,
    author_time: i64,
    summary: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBlame {
    head: Option<String>,
    ranges: Vec<Range>,
    commits: BTreeMap<String, Commit>,
}

struct Base {
    text: String,
    ranges: Vec<Range>,
    commits: BTreeMap<String, Commit>,
}

#[derive(PartialEq)]
struct Key {
    repository: PathBuf,
    head: Oid,
    path: String,
    encoding: String,
}

#[derive(Default)]
pub struct Cache {
    entries: VecDeque<(Key, Arc<Base>, usize)>,
    bytes: usize,
}

impl Cache {
    fn get(&mut self, key: &Key) -> Option<Arc<Base>> {
        let index = self.entries.iter().position(|(k, _, _)| k == key)?;
        let entry = self.entries.remove(index)?;
        let base = entry.1.clone();
        self.entries.push_back(entry);
        Some(base)
    }

    fn insert(&mut self, key: Key, base: Arc<Base>) {
        let bytes = base.text.len()
            + base
                .ranges
                .iter()
                .map(|r| size_of::<Range>() + r.commit.as_ref().map_or(0, String::len))
                .sum::<usize>()
            + base
                .commits
                .iter()
                .map(|(id, c)| id.len() + size_of::<Commit>() + c.author.len() + c.summary.len())
                .sum::<usize>();
        if bytes > CACHE_BYTES {
            return;
        }
        if let Some(index) = self.entries.iter().position(|(k, _, _)| k == &key) {
            self.bytes -= self.entries.remove(index).unwrap().2;
        }
        while self.entries.len() >= CACHE_FILES || self.bytes + bytes > CACHE_BYTES {
            if let Some((_, _, old_bytes)) = self.entries.pop_front() {
                self.bytes -= old_bytes;
            }
        }
        self.bytes += bytes;
        self.entries.push_back((key, base, bytes));
    }
}

fn line_count(text: &str) -> usize {
    text.split_inclusive('\n').count()
}

fn push(ranges: &mut Vec<Range>, start_line: usize, line_count: usize, commit: Option<String>) {
    if line_count == 0 {
        return;
    }
    if let Some(last) = ranges.last_mut()
        && last.start_line + last.line_count == start_line
        && last.commit == commit
    {
        last.line_count += line_count;
        return;
    }
    ranges.push(Range {
        start_line,
        line_count,
        commit,
    });
}

fn copy_ranges(base: &[Range], output: &mut Vec<Range>, old: usize, new: usize, count: usize) {
    let start = base.partition_point(|r| r.start_line + r.line_count <= old + 1);
    for range in &base[start..] {
        let from = range.start_line.max(old + 1);
        let to = (range.start_line + range.line_count).min(old + count + 1);
        if from >= to {
            break;
        }
        push(output, new + from - old, to - from, range.commit.clone());
    }
}

fn map_buffer(base: &Base, text: &str) -> Result<Vec<Range>> {
    let mut options = DiffOptions::new();
    options.context_lines(0).interhunk_lines(0).force_text(true);
    let patch = Patch::from_buffers(
        base.text.as_bytes(),
        None,
        text.as_bytes(),
        None,
        Some(&mut options),
    )
    .map_err(git_error)?;
    let mut ranges = vec![];
    let (mut old, mut new) = (0, 0);
    for index in 0..patch.num_hunks() {
        let (hunk, _) = patch.hunk(index).map_err(git_error)?;
        // Insertion/deletion-only hunks point just after the preceding line.
        let old_start = hunk.old_start() as usize - usize::from(hunk.old_lines() > 0);
        let new_start = hunk.new_start() as usize - usize::from(hunk.new_lines() > 0);
        copy_ranges(&base.ranges, &mut ranges, old, new, old_start - old);
        push(&mut ranges, new_start + 1, hunk.new_lines() as usize, None);
        old = old_start + hunk.old_lines() as usize;
        new = new_start + hunk.new_lines() as usize;
    }
    copy_ranges(
        &base.ranges,
        &mut ranges,
        old,
        new,
        line_count(&base.text) - old,
    );
    if text.is_empty() && !base.text.is_empty() {
        push(&mut ranges, 1, 1, None);
    }
    Ok(ranges)
}

fn base_blame(repo: &Repository, head: Oid, path: &str, encoding: &str) -> Result<Option<Base>> {
    let tree = repo
        .find_commit(head)
        .and_then(|c| c.tree())
        .map_err(git_error)?;
    let entry = match tree.get_path(Path::new(path)) {
        Ok(entry) => entry,
        Err(e) if e.code() == ErrorCode::NotFound => return Ok(None),
        Err(e) => return Err(git_error(e)),
    };
    if entry.kind() != Some(git2::ObjectType::Blob) || entry.filemode() == 0o120000 {
        return Ok(None);
    }
    let blob = repo.find_blob(entry.id()).map_err(git_error)?;
    if blob.size() as u64 > files::LARGE_FILE || blob.is_binary() {
        return Ok(None);
    }
    // Prefer the historical encoding; a pending editor encoding change must not
    // reinterpret valid UTF-8 history as the new encoding.
    let Ok((text, _)) = files::decode(blob.content(), None)
        .or_else(|_| files::decode(blob.content(), Some(encoding)))
    else {
        return Ok(None);
    };
    let text = text.replace("\r\n", "\n");
    if text.contains('\r') {
        return Ok(None);
    }
    let mut options = BlameOptions::new();
    options.newest_commit(head);
    let blame = repo
        .blame_file(Path::new(path), Some(&mut options))
        .map_err(git_error)?;
    let mut ranges = vec![];
    let mut commits = BTreeMap::new();
    for hunk in blame.iter() {
        let oid = hunk.final_commit_id();
        let id = oid.to_string();
        if !commits.contains_key(&id) {
            let commit = repo.find_commit(oid).map_err(git_error)?;
            let author = commit.author();
            commits.insert(
                id.clone(),
                Commit {
                    author: String::from_utf8_lossy(author.name_bytes()).into_owned(),
                    author_time: author.when().seconds(),
                    summary: String::from_utf8_lossy(commit.summary_bytes().unwrap_or_default())
                        .into_owned(),
                },
            );
        }
        push(
            &mut ranges,
            hunk.final_start_line(),
            hunk.lines_in_hunk(),
            Some(id),
        );
    }
    // Reject historical formats whose physical Git lines cannot match editor lines.
    if ranges.iter().map(|r| r.line_count).sum::<usize>() != line_count(&text) {
        return Ok(None);
    }
    Ok(Some(Base {
        text,
        ranges,
        commits,
    }))
}

pub(super) fn read(
    root: &Path,
    path: &str,
    old_path: Option<&str>,
    contents: &str,
    encoding: &str,
    cache: &Mutex<Cache>,
) -> Result<Option<FileBlame>> {
    let target = file_path(root, path)?;
    if let Some(old) = old_path {
        file_path(root, old)?;
    }
    if contents.len() as u64 > files::LARGE_FILE || contents.contains('\0') || target.is_dir() {
        return Ok(None);
    }
    let repo = Repository::open(root).map_err(git_error)?;
    let head = match repo.head().and_then(|h| h.peel_to_commit()) {
        Ok(commit) => Some(commit.id()),
        Err(e) if matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => None,
        Err(e) => return Err(git_error(e)),
    };
    let historical_path = old_path.unwrap_or(path);
    let tracked = head
        .and_then(|id| repo.find_commit(id).ok())
        .and_then(|c| c.tree().ok())
        .and_then(|t| t.get_path(Path::new(historical_path)).ok())
        .is_some();
    if !tracked
        && repo
            .status_should_ignore(Path::new(path))
            .map_err(git_error)?
    {
        return Ok(None);
    }
    let text = contents.replace("\r\n", "\n");
    if text.contains('\r') {
        return Ok(None);
    }
    let Some(head) = head else {
        return Ok(Some(FileBlame {
            head: None,
            ranges: vec![Range {
                start_line: 1,
                line_count: line_count(&text).max(1),
                commit: None,
            }],
            commits: BTreeMap::new(),
        }));
    };
    let key = Key {
        repository: root.to_owned(),
        head,
        path: historical_path.into(),
        encoding: encoding.into(),
    };
    let cached = cache.lock_recover().get(&key);
    let base = if let Some(base) = cached {
        base
    } else if tracked {
        let Some(base) = base_blame(&repo, head, historical_path, encoding)? else {
            return Ok(None);
        };
        let base = Arc::new(base);
        cache.lock_recover().insert(key, base.clone());
        base
    } else {
        return Ok(Some(FileBlame {
            head: Some(head.to_string()),
            ranges: vec![Range {
                start_line: 1,
                line_count: line_count(&text).max(1),
                commit: None,
            }],
            commits: BTreeMap::new(),
        }));
    };
    let ranges = map_buffer(&base, &text)?;
    let used: HashSet<_> = ranges.iter().filter_map(|r| r.commit.as_ref()).collect();
    let commits = base
        .commits
        .iter()
        .filter(|(id, _)| used.contains(id))
        .map(|(id, c)| (id.clone(), c.clone()))
        .collect();
    Ok(Some(FileBlame {
        head: Some(head.to_string()),
        ranges,
        commits,
    }))
}

#[tauri::command]
pub async fn git_blame_file(
    window: WebviewWindow,
    state: State<'_, AppState>,
    expected_root: String,
    session: u64,
    repository: String,
    path: String,
    old_path: Option<String>,
    contents: String,
    encoding: String,
) -> Result<Option<FileBlame>> {
    let root = context(&state, window.label(), &expected_root, session, &repository)?;
    let cache = state
        .windows
        .lock_recover()
        .get(window.label())
        .filter(|w| w.workspace_session == session)
        .ok_or_else(|| crate::error::AppError::new("workspace", "Workspace changed"))?
        .git_blame
        .clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        read(
            &root,
            &path,
            old_path.as_deref(),
            &contents,
            &encoding,
            &cache,
        )
    })
    .await
    .map_err(git_error)??;
    context(&state, window.label(), &expected_root, session, &repository)?;
    Ok(result)
}

#[cfg(test)]
mod tests;
