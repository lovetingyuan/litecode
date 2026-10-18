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
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
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

fn parse_matches(
    value: &serde_json::Value,
    path: &str,
    mirror: Option<&Mirror>,
) -> Vec<SearchMatch> {
    if value["type"] != "match" {
        return vec![];
    }
    let data = &value["data"];
    let Some(text) = data["lines"]["text"].as_str() else {
        return vec![];
    };
    let start_line = data["line_number"].as_u64().unwrap_or(1) as usize;
    data["submatches"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|m| {
            let (line, column) =
                byte_position(text, m["start"].as_u64().unwrap_or(0) as usize, start_line);
            let (end_line, end_column) =
                byte_position(text, m["end"].as_u64().unwrap_or(0) as usize, start_line);
            SearchMatch {
                path: path.into(),
                document_id: mirror.map(|d| d.id.clone()),
                version: mirror.map(|d| d.version),
                line,
                column,
                end_line,
                end_column,
                preview: text
                    .lines()
                    .nth(line.saturating_sub(start_line))
                    .unwrap_or("")
                    .chars()
                    .take(2000)
                    .collect::<String>()
                    .trim_end()
                    .into(),
                matched: m["match"]["text"].as_str().unwrap_or("").into(),
            }
        })
        .collect()
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
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    loop {
        let next = tokio::select! {
            next = lines.next_line() => next?,
            _ = tokio::time::sleep(Duration::from_millis(40)) => {
                if task.cancelled.load(Ordering::Acquire) { let _ = child.kill().await; break; }
                continue;
            }
        };
        let Some(line) = next else { break };
        if task.cancelled.load(Ordering::Acquire) {
            let _ = child.kill().await;
            break;
        }
        let value: serde_json::Value = serde_json::from_str(&line)?;
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
        let matches = parse_matches(&value, &path, mirror);
        for m in matches {
            *count += 1;
            batch.matches.push(m);
            if *count >= 20_000 {
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
    let (root, documents) = {
        let windows = state.windows.lock().unwrap();
        let w = windows
            .get(window.label())
            .ok_or_else(|| AppError::new("window", "Window not initialized"))?;
        (
            w.root.clone(),
            w.documents.values().cloned().collect::<Vec<_>>(),
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
            match root.as_ref().map(|r| workspace_changed(r)).transpose() {
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

fn workspace_changed(root: &Path) -> Result<HashSet<String>> {
    Ok(crate::workspace::scan(root)?
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
