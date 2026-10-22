use crate::{
    error::{AppError, Result},
    state::{AppState, Mirror, SearchTask},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{Manager, State, WebviewWindow, ipc::Channel};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub text: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
    pub include: String,
    pub exclude: String,
    pub use_ignore: bool,
    pub open_only: bool,
    pub changed_only: bool,
    pub follow_symlinks: bool,
    pub encoding: Option<String>,
    pub context: u32,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub document_id: Option<String>,
    pub version: Option<u64>,
    pub line: usize,
    pub column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub preview: String,
    pub matched: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchBatch {
    pub request_id: String,
    pub sequence: u64,
    pub matches: Vec<SearchMatch>,
    pub done: bool,
    pub limited: bool,
    pub cancelled: bool,
    pub errors: Vec<String>,
}

fn key(label: &str, id: &str) -> String {
    format!("{label}/{id}")
}
fn normalized(path: &str) -> String {
    path.trim_start_matches("\\\\?\\")
        .replace('\\', "/")
        .to_lowercase()
}

pub fn rg_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .resource_dir()
        .ok()
        .map(|p| p.join("tools/rg.exe"))
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("rg"))
}

fn add_arguments(command: &mut Command, query: &Query) {
    command.args([
        "--json",
        "--pcre2",
        "--multiline",
        "--line-number",
        "--hidden",
        "--color=never",
        "--glob=!.git",
        "--max-filesize=20M",
    ]);
    if !query.case_sensitive {
        command.arg("--ignore-case");
    }
    if !query.use_ignore {
        command.arg("--no-ignore");
    }
    if query.follow_symlinks {
        command.arg("--follow");
    }
    if let Some(encoding) = &query.encoding {
        command.args(["--encoding", encoding]);
    }
    for glob in split_globs(&query.include) {
        command.arg("--glob").arg(glob);
    }
    for glob in split_globs(&query.exclude) {
        command.arg("--glob").arg(format!("!{glob}"));
    }
}

fn split_globs(value: &str) -> Vec<&str> {
    let mut depth = 0_u32;
    let mut start = 0;
    let mut escaped = false;
    let mut result = vec![];
    for (i, ch) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                let item = value[start..i].trim();
                if !item.is_empty() {
                    result.push(item);
                }
                start = i + 1;
            }
            _ => {}
        }
    }
    let last = value[start..].trim();
    if !last.is_empty() {
        result.push(last);
    }
    result
}

pub fn byte_position(text: &str, offset: usize, start_line: usize) -> (usize, usize) {
    let mut offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    let before = &text[..offset];
    let line = start_line + before.bytes().filter(|b| *b == b'\n').count();
    let column = before
        .rsplit('\n')
        .next()
        .unwrap_or("")
        .encode_utf16()
        .count()
        + 1;
    (line, column)
}

const MAX_RESULTS: usize = 20_000;
const MAX_EVENT_BYTES: usize = 8 * 1024 * 1024;

fn parse_matches<'a>(
    value: &'a serde_json::Value,
    path: &'a str,
    mirror: Option<&'a Mirror>,
    limit: usize,
) -> impl Iterator<Item = SearchMatch> + 'a {
    let data = &value["data"];
    let text = data["lines"]["text"].as_str().unwrap_or("");
    let start_line = data["line_number"].as_u64().unwrap_or(1) as usize;
    let (mut offset, mut line, mut column) = (0, start_line, 1);
    let mut position = move |target: usize| {
        let mut target = target.min(text.len());
        while !text.is_char_boundary(target) {
            target -= 1;
        }
        if target < offset {
            (offset, line, column) = (0, start_line, 1);
        }
        for c in text[offset..target].chars() {
            if c == '\n' {
                line += 1;
                column = 1;
            } else {
                column += c.len_utf16();
            }
        }
        offset = target;
        (line, column)
    };
    let mut preview_line = None;
    let mut preview = String::new();
    data["submatches"]
        .as_array()
        .filter(|_| value["type"] == "match" && data["lines"]["text"].is_string())
        .into_iter()
        .flatten()
        .take(limit)
        .map(move |m| {
            let start = (m["start"].as_u64().unwrap_or(0) as usize).min(text.len());
            let (line, column) = position(start);
            let (end_line, end_column) = position(m["end"].as_u64().unwrap_or(0) as usize);
            if preview_line != Some(line) {
                let mut boundary = start;
                while !text.is_char_boundary(boundary) {
                    boundary -= 1;
                }
                let line_start = text[..boundary].rfind('\n').map_or(0, |i| i + 1);
                preview = text[line_start..]
                    .lines()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .take(2000)
                    .collect::<String>()
                    .trim_end()
                    .into();
                preview_line = Some(line);
            }
            SearchMatch {
                path: path.into(),
                document_id: mirror.map(|d| d.id.clone()),
                version: mirror.map(|d| d.version),
                line,
                column,
                end_line,
                end_column,
                preview: preview.clone(),
                matched: m["match"]["text"].as_str().unwrap_or("").into(),
            }
        })
}

async fn read_event(
    reader: &mut (impl AsyncBufRead + Unpin),
    task: &SearchTask,
) -> Result<Option<Vec<u8>>> {
    let mut bytes = vec![];
    loop {
        if task.cancelled.load(Ordering::Acquire) {
            return Ok(None);
        }
        let mut bounded = (&mut *reader).take((MAX_EVENT_BYTES + 1 - bytes.len()) as u64);
        let read = tokio::select! {
            read = bounded.read_until(b'\n', &mut bytes) => read?,
            _ = tokio::time::sleep(Duration::from_millis(40)) => continue,
        };
        if bytes.len() > MAX_EVENT_BYTES {
            return Err(AppError::new(
                "searchLimit",
                "A search result exceeded 8 MiB. Narrow the query or exclude files with very long lines.",
            ));
        }
        if read == 0 || bytes.last() == Some(&b'\n') {
            return Ok((!bytes.is_empty()).then_some(bytes));
        }
    }
}

async fn send_batch(
    task: &SearchTask,
    channel: &Channel<SearchBatch>,
    batch: &mut SearchBatch,
) -> bool {
    while batch.sequence > task.acknowledged.load(Ordering::Acquire) + 3 {
        if task.cancelled.load(Ordering::Acquire) {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    if channel.send(batch.clone()).is_err() {
        return false;
    }
    batch.matches.clear();
    batch.errors.clear();
    batch.sequence += 1;
    true
}

#[allow(clippy::too_many_arguments)] // One invocation shares the task's bounded output and cancellation state.
async fn run_rg(
    app: &tauri::AppHandle,
    root: Option<&PathBuf>,
    query: &Query,
    mirror: Option<&Mirror>,
    overlay: &HashSet<String>,
    allowed: Option<&HashSet<String>>,
    task: &SearchTask,
    channel: &Channel<SearchBatch>,
    batch: &mut SearchBatch,
    count: &mut usize,
) -> Result<()> {
    let mut command = Command::new(rg_path(app));
    add_arguments(&mut command, query);
    command.arg("--").arg(crate::replacement::pattern(query));
    if let Some(root) = root {
        command.current_dir(root);
    }
    command.arg(if mirror.is_some() { "-" } else { "." });
    command
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|e| {
        AppError::new(
            "searchTool",
            format!("Cannot start bundled ripgrep with PCRE2: {e}"),
        )
    })?;
    if let Some(mirror) = mirror {
        let mut stdin = child.stdin.take().unwrap();
        let text = mirror.text.clone();
        tokio::spawn(async move {
            let _ = stdin.write_all(text.as_bytes()).await;
        });
    } else {
        drop(child.stdin.take());
    }
    let stderr = child.stderr.take().unwrap();
    let error_reader = tokio::spawn(async move {
        let mut bytes = vec![];
        let _ = stderr.take(16384).read_to_end(&mut bytes).await;
        String::from_utf8_lossy(&bytes).to_string()
    });
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    loop {
        let next = match read_event(&mut reader, task).await {
            Ok(next) => next,
            Err(error) if error.code == "searchLimit" => {
                batch.limited = true;
                batch.errors.push(error.message);
                let _ = child.kill().await;
                break;
            }
            Err(error) => return Err(error),
        };
        if task.cancelled.load(Ordering::Acquire) {
            let _ = child.kill().await;
            break;
        }
        let Some(line) = next else { break };
        let value: serde_json::Value = serde_json::from_slice(&line)?;
        let relative = value["data"]["path"]["text"]
            .as_str()
            .unwrap_or("")
            .trim_start_matches(".\\")
            .trim_start_matches("./");
        let path = if let Some(m) = mirror {
            m.path.clone().unwrap_or(m.id.clone())
        } else {
            root.unwrap().join(relative).to_string_lossy().into_owned()
        };
        if mirror.is_none()
            && (overlay.contains(&normalized(&path))
                || allowed.is_some_and(|a| !a.contains(&normalized(&path))))
        {
            continue;
        }
        let matches = parse_matches(&value, &path, mirror, MAX_RESULTS.saturating_sub(*count));
        for m in matches {
            if task.cancelled.load(Ordering::Acquire) {
                let _ = child.kill().await;
                break;
            }
            *count += 1;
            batch.matches.push(m);
            if *count >= MAX_RESULTS {
                batch.limited = true;
                let _ = child.kill().await;
                break;
            }
            if batch.matches.len() >= 64 && !send_batch(task, channel, batch).await {
                let _ = child.kill().await;
                return Ok(());
            }
        }
        if batch.limited {
            break;
        }
    }
    let status = child.wait().await?;
    let stderr = error_reader.await.unwrap_or_default();
    if status.code().is_some_and(|c| c > 1)
        && !task.cancelled.load(Ordering::Acquire)
        && !batch.limited
    {
        batch.errors.push(if stderr.is_empty() {
            format!("ripgrep exited with {status}")
        } else {
            stderr
        });
    }
    Ok(())
}

fn buffer_included(query: &Query, path: &str) -> bool {
    fn matches(patterns: &str, path: &str) -> bool {
        split_globs(patterns).into_iter().any(|p| {
            globset::Glob::new(p).is_ok_and(|g| {
                g.compile_matcher().is_match(path)
                    || g.compile_matcher()
                        .is_match(PathBuf::from(path).file_name().unwrap_or_default())
            })
        })
    }
    (query.include.trim().is_empty() || matches(&query.include, path))
        && !matches(&query.exclude, path)
}

#[tauri::command]
pub async fn search_start(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request_id: String,
    query: Query,
    on_batch: Channel<SearchBatch>,
) -> Result<()> {
    if query.text.is_empty() {
        return Err(AppError::new("query", "Search text is empty"));
    }
    let (root, documents, repositories) = {
        let windows = state.windows.lock().unwrap();
        let w = windows
            .get(window.label())
            .ok_or_else(|| AppError::new("window", "Window not initialized"))?;
        (
            w.root.clone(),
            w.documents
                .values()
                .filter(|m| m.kind.is_text())
                .cloned()
                .collect::<Vec<_>>(),
            w.repositories.clone(),
        )
    };
    let task = Arc::new(SearchTask {
        cancelled: AtomicBool::new(false),
        acknowledged: AtomicU64::new(0),
    });
    let task_key = key(window.label(), &request_id);
    {
        let mut tasks = state.searches.lock().unwrap();
        if tasks
            .keys()
            .filter(|k| k.starts_with(&format!("{}/", window.label())))
            .count()
            >= 8
        {
            return Err(AppError::new(
                "searchBusy",
                "Eight searches are already running in this window. Cancel a search first.",
            ));
        }
        tasks.insert(task_key.clone(), task.clone());
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let mut batch = SearchBatch {
            request_id,
            sequence: 1,
            matches: vec![],
            done: false,
            limited: false,
            cancelled: false,
            errors: vec![],
        };
        let overlay = documents
            .iter()
            .filter_map(|m| m.path.as_deref().map(normalized))
            .collect();
        let allowed = if query.changed_only {
            let result = if let Some(root) = root.clone() {
                let repositories = repositories.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    workspace_changed(&root, &repositories)
                })
                .await
                .unwrap_or_else(|error| Err(AppError::new("git", error.to_string())))
                .map(Some)
            } else {
                Ok(None)
            };
            match result {
                Ok(paths) => Some(paths.unwrap_or_default()),
                Err(e) => {
                    batch.errors.push(e.message);
                    Some(HashSet::new())
                }
            }
        } else {
            None
        };
        let mut count = 0;
        if !query.open_only
            && let Some(root) = &root
            && let Err(e) = run_rg(
                &app,
                Some(root),
                &query,
                None,
                &overlay,
                allowed.as_ref(),
                &task,
                &on_batch,
                &mut batch,
                &mut count,
            )
            .await
        {
            batch.errors.push(e.message);
        }
        for mirror in documents {
            if task.cancelled.load(Ordering::Acquire) || batch.limited {
                break;
            }
            let path = mirror.path.as_deref().unwrap_or(&mirror.id);
            let relative = root
                .as_ref()
                .and_then(|r| Path::new(path).strip_prefix(r).ok())
                .map(|p| p.to_string_lossy().replace('\\', "/"));
            if !buffer_included(&query, relative.as_deref().unwrap_or(path))
                || allowed
                    .as_ref()
                    .is_some_and(|a| !a.contains(&normalized(path)))
            {
                continue;
            }
            if let Err(e) = run_rg(
                &app,
                root.as_ref(),
                &query,
                Some(&mirror),
                &overlay,
                None,
                &task,
                &on_batch,
                &mut batch,
                &mut count,
            )
            .await
            {
                batch.errors.push(e.message);
            }
        }
        batch.done = true;
        batch.cancelled = task.cancelled.load(Ordering::Acquire);
        if batch.cancelled {
            let _ = on_batch.send(batch);
        } else {
            send_batch(&task, &on_batch, &mut batch).await;
        }
        app.state::<AppState>()
            .searches
            .lock()
            .unwrap()
            .remove(&task_key);
    });
    Ok(())
}

fn workspace_changed(
    root: &Path,
    index: &crate::workspace::RepositoryIndex,
) -> Result<HashSet<String>> {
    crate::workspace::discover_repositories(root, index, || false);
    Ok(crate::workspace::git_snapshot(root, index, 0)?
        .git
        .into_iter()
        .filter(|g| g.status != "ignored")
        .map(|g| normalized(&root.join(g.path).to_string_lossy()))
        .collect())
}

#[tauri::command]
pub fn search_ack(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request_id: String,
    sequence: u64,
) {
    if let Some(task) = state
        .searches
        .lock()
        .unwrap()
        .get(&key(window.label(), &request_id))
    {
        task.acknowledged.fetch_max(sequence, Ordering::Release);
    }
}

#[tauri::command]
pub fn search_cancel(window: WebviewWindow, state: State<'_, AppState>, request_id: String) {
    if let Some(task) = state
        .searches
        .lock()
        .unwrap()
        .get(&key(window.label(), &request_id))
    {
        task.cancelled.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dense_results_are_lazy_bounded_and_keep_utf16_multiline_positions() {
        let text = "🙂a ".repeat(25_000);
        let submatches: Vec<_> = (0..25_000)
            .map(|i| serde_json::json!({"start": i*6+4, "end": i*6+5, "match": {"text": "a"}}))
            .collect();
        let value = serde_json::json!({"type": "match", "data": {"lines": {"text": text}, "line_number": 3, "submatches": submatches}});
        assert_eq!(parse_matches(&value, "dense.txt", None, 0).count(), 0);
        let mut results = parse_matches(&value, "dense.txt", None, MAX_RESULTS);
        assert_eq!(results.next().unwrap().column, 3);
        let last = results.last().unwrap();
        assert_eq!((last.line, last.column), (3, (MAX_RESULTS - 1) * 4 + 3));
        assert_eq!(parse_matches(&value, "dense.txt", None, 17).count(), 17);
        let value = serde_json::json!({"type":"match","data":{"lines":{"text":"中文🙂x\r\nsecond"},"line_number":4,"submatches":[{"start":6,"end":15,"match":{"text":"🙂x\r\nse"}},{"start":15,"end":18,"match":{"text":"con"}}]}});
        for result in parse_matches(&value, "multi.txt", None, 20) {
            let start = value["data"]["submatches"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["match"]["text"] == result.matched)
                .unwrap();
            let text = value["data"]["lines"]["text"].as_str().unwrap();
            assert_eq!(
                (result.line, result.column),
                byte_position(text, start["start"].as_u64().unwrap() as usize, 4)
            );
            assert_eq!(
                (result.end_line, result.end_column),
                byte_position(text, start["end"].as_u64().unwrap() as usize, 4)
            );
        }
    }

    #[tokio::test]
    async fn oversized_events_are_bounded_and_cancelled_reads_stop() {
        let task = SearchTask {
            cancelled: AtomicBool::new(false),
            acknowledged: AtomicU64::new(0),
        };
        let bytes = vec![b'a'; MAX_EVENT_BYTES + 100];
        let mut reader = BufReader::new(bytes.as_slice());
        assert_eq!(
            read_event(&mut reader, &task).await.unwrap_err().code,
            "searchLimit"
        );
        task.cancelled.store(true, Ordering::Release);
        assert!(read_event(&mut reader, &task).await.unwrap().is_none());
        task.cancelled.store(false, Ordering::Release);
        let mut reader = BufReader::new(&b"one\ntwo"[..]);
        assert_eq!(
            read_event(&mut reader, &task).await.unwrap().unwrap(),
            b"one\n"
        );
        assert_eq!(
            read_event(&mut reader, &task).await.unwrap().unwrap(),
            b"two"
        );
        assert!(read_event(&mut reader, &task).await.unwrap().is_none());
    }

    #[test]
    fn utf16_and_multiline_positions() {
        let s = "中文🙂x\r\nsecond";
        assert_eq!(byte_position(s, "中文🙂".len(), 4), (4, 5));
        assert_eq!(byte_position(s, "中文🙂x\r\nsec".len(), 4), (5, 4));
    }
    #[test]
    fn comma_lists_keep_brace_alternations() {
        assert_eq!(
            split_globs("**/*.{ts,tsx}, src/{a,b}/** , *.json"),
            vec!["**/*.{ts,tsx}", "src/{a,b}/**", "*.json"]
        );
    }
}
