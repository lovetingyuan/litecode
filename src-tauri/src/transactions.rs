use crate::sync::MutexExt;
use crate::sync::RwLockExt;
use crate::{
    error::{AppError, Result},
    files,
    state::{AppState, Mirror, WindowState, canonical, recovery_path},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use tauri::WebviewWindow;

#[cfg(test)]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskEdit {
    pub path: String,
    pub before: String,
    pub after: String,
    pub encoding: String,
    pub revision: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct BufferEdit {
    pub before: Mirror,
    pub after: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    edit: DiskEdit,
    after_revision: String,
    applied: bool,
    undone: bool,
    // Keep exact bytes only when decoding/re-encoding would change the original.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    before_bytes: Option<Vec<u8>>,
}
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
enum Direction {
    Apply,
    Undo,
    Redo,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
struct Operation {
    direction: Direction,
    #[serde(default)]
    rollback: bool,
}
impl Operation {
    fn target_after(self) -> bool {
        (self.direction != Direction::Undo) != self.rollback
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    #[serde(default)]
    version: u8,
    #[serde(default)]
    owner: String,
    #[serde(default)]
    root: Option<PathBuf>,
    entries: Vec<Entry>,
    #[serde(default)]
    buffers: Vec<BufferEdit>,
    #[serde(default)]
    pending: Option<Operation>,
}
#[derive(Default, Serialize)]
pub struct Report {
    pub succeeded: Vec<String>,
    pub failed: Vec<String>,
    pub remaining: Vec<String>,
    pub complete: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    pub transaction_id: String,
    pub root: Option<String>,
    pub paths: Vec<String>,
    pub buffers: Vec<BufferEdit>,
    pub target_after: bool,
}

fn valid_owner(label: &str) -> bool {
    (label == "main" || label.starts_with("editor-"))
        && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}
fn journal_path(state: &AppState, owner: &str, id: &str) -> Result<PathBuf> {
    if !valid_owner(owner)
        || id.is_empty()
        || id.len() > 64
        || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    {
        return Err(AppError::new(
            "transaction",
            "Invalid replacement identifier",
        ));
    }
    Ok(state
        .data_dir
        .join("transactions")
        .join(owner)
        .join(format!("{id}.json")))
}
fn persist(path: &Path, journal: &Journal) -> Result<()> {
    files::atomic_write(path, &serde_json::to_vec(journal)?)
}
fn load(path: &Path) -> Result<Journal> {
    let journal: Journal = serde_json::from_slice(&fs::read(path)?)?;
    if journal.version > 2 {
        return Err(AppError::new(
            "transaction",
            "This replacement log needs a newer LiteCode version",
        ));
    }
    Ok(journal)
}
fn revision(path: &str) -> Result<String> {
    Ok(files::hash(&fs::read(path)?))
}
fn original_bytes(entry: &Entry) -> Result<Vec<u8>> {
    entry
        .before_bytes
        .clone()
        .map(Ok)
        .unwrap_or_else(|| files::encode(&entry.edit.before, &entry.edit.encoding))
}
fn eligible(journal: &Journal, entry: &Entry) -> bool {
    journal
        .pending
        .is_some_and(|op| op.direction == Direction::Apply)
        || entry.applied
}
fn description(journal: &Journal, id: String) -> Recovery {
    Recovery {
        transaction_id: id,
        root: journal
            .root
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        paths: journal
            .entries
            .iter()
            .map(|e| e.edit.path.clone())
            .chain(journal.buffers.iter().map(|b| {
                b.before
                    .path
                    .clone()
                    .unwrap_or_else(|| b.before.name.clone().unwrap_or_else(|| "Untitled".into()))
            }))
            .collect(),
        buffers: journal.buffers.clone(),
        target_after: journal.pending.is_some_and(Operation::target_after),
    }
}
// Legacy logs lack a completion marker. Surface disagreement without rewriting
// the backup; only an explicit recovery action upgrades its format.
fn upgrade_legacy(journal: &mut Journal, owner: &str, root: Option<PathBuf>) {
    if journal.version != 0 {
        return;
    }
    let observed: Vec<_> = journal
        .entries
        .iter()
        .map(|e| revision(&e.edit.path).ok())
        .collect();
    let inconsistent = journal.entries.iter().zip(&observed).any(|(e, actual)| {
        actual.as_ref()
            != Some(if e.applied && !e.undone {
                &e.after_revision
            } else {
                &e.edit.revision
            })
    });
    journal.owner = owner.into();
    journal.root = root.map(|p| canonical(&p).unwrap_or(p));
    if inconsistent {
        let direction = if journal.entries.iter().any(|e| !e.applied) {
            Direction::Apply
        } else if journal.entries.iter().zip(&observed).any(|(e, actual)| {
            !e.undone
                && e.edit.revision != e.after_revision
                && actual.as_ref() == Some(&e.edit.revision)
        }) {
            Direction::Undo
        } else if journal.entries.iter().zip(&observed).any(|(e, actual)| {
            e.undone
                && e.edit.revision != e.after_revision
                && actual.as_ref() == Some(&e.after_revision)
        }) {
            Direction::Redo
        } else {
            Direction::Undo
        };
        journal.pending = Some(Operation {
            direction,
            rollback: false,
        });
        for e in &mut journal.entries {
            if revision(&e.edit.path).is_ok_and(|r| r == e.after_revision) {
                e.applied = true;
            }
        }
    }
}
fn logs(state: &AppState, owner: &str) -> Result<Vec<(String, PathBuf, Journal)>> {
    if !valid_owner(owner) {
        return Err(AppError::new("transaction", "Invalid recovery window"));
    }
    let directory = state.data_dir.join("transactions").join(owner);
    if !directory.try_exists()? {
        return Ok(vec![]);
    }
    if fs::symlink_metadata(&directory)?.file_type().is_symlink() {
        return Err(AppError::new(
            "transaction",
            "Recovery directories cannot be symbolic links",
        ));
    }
    let root = fs::read(state.data_dir.join(format!("session-{owner}.json")))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v["root"].as_str().map(PathBuf::from));
    let mut result = vec![];
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
            continue;
        };
        if journal_path(state, owner, &id).is_err() {
            continue;
        }
        match load(&path) {
            Ok(mut journal) => {
                upgrade_legacy(&mut journal, owner, root.clone());
                if !journal.owner.is_empty() && journal.owner != owner {
                    continue;
                }
                if journal.pending.is_some() {
                    result.push((id, path, journal));
                }
            }
            Err(error) => state.startup_warnings.lock_recover().push(format!(
                "Could not inspect replacement backup {}: {}. The backup was preserved.",
                path.display(),
                error.message
            )),
        }
    }
    result.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(result)
}
pub fn pending_windows(state: &AppState) -> Result<Vec<(String, Option<PathBuf>)>> {
    let directory = state.data_dir.join("transactions");
    if !directory.try_exists()? {
        return Ok(vec![]);
    }
    let mut windows = vec![];
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let owner = entry.file_name().to_string_lossy().into_owned();
        if !entry.file_type()?.is_dir() || !valid_owner(&owner) {
            continue;
        }
        if let Some((_, _, journal)) = logs(state, &owner)?.into_iter().next() {
            windows.push((owner, journal.root));
        }
    }
    Ok(windows)
}
pub fn restore_buffers(state: &AppState, owner: &str, window: &mut WindowState) -> Result<()> {
    for (_, _, journal) in logs(state, owner)? {
        // These exact targets were authorized before the v2 intent was saved,
        // just like loose-file grants restored from session document mirrors.
        if journal.version == 2 {
            for entry in &journal.entries {
                if let Ok(path) = recovery_path(Path::new(&entry.edit.path)) {
                    window.grants.insert(path);
                }
            }
        }
        for buffer in journal.buffers {
            if window.documents.contains_key(&buffer.before.id)
                || buffer.before.path.as_ref().is_some_and(|p| {
                    window.documents.values().any(|d| {
                        d.path
                            .as_ref()
                            .is_some_and(|other| other.eq_ignore_ascii_case(p))
                    })
                })
            {
                continue;
            }
            if let Some(path) = &buffer.before.path {
                if let Ok(path) = recovery_path(Path::new(path)) {
                    window.grants.insert(path);
                }
            }
            let id = buffer.before.id.clone();
            window.documents.insert(id.clone(), buffer.before);
            if let Some(groups) = window.session["groups"]
                .as_array_mut()
                .filter(|g| !g.is_empty())
            {
                let group = &mut groups[0];
                if let Some(tabs) = group["tabs"].as_array_mut() {
                    tabs.push(serde_json::json!(id));
                }
                group["active"] = serde_json::json!(id);
            } else {
                window.session = serde_json::json!({"groups":[{"id":"recovery","tabs":[id],"active":id,"preview":null,"views":{}}],"activeGroup":"recovery"});
            }
        }
    }
    Ok(())
}
pub fn ensure_no_pending(state: &AppState, owner: &str) -> Result<()> {
    if !logs(state, owner)?.is_empty() {
        return Err(AppError::new(
            "replacementPending",
            "Resolve the interrupted workspace replacement before starting another replacement or changing folders. Use Search: Recover Interrupted Replacements.",
        ));
    }
    Ok(())
}
fn authorize(state: &AppState, owner: &str, journal: &Journal, paths: bool) -> Result<()> {
    if journal.owner != owner {
        return Err(AppError::new(
            "access",
            "This replacement belongs to another window",
        ));
    }
    // Keeping current contents only acknowledges this window's backup. It must
    // remain possible even if the original workspace has since disappeared.
    if !paths {
        return Ok(());
    }
    let root = state
        .windows
        .lock_recover()
        .get(owner)
        .and_then(|w| w.root.clone());
    if root != journal.root {
        return Err(AppError::new(
            "workspace",
            "Open the original workspace before recovering this replacement",
        ));
    }
    if paths {
        for e in &journal.entries {
            state.authorize_recovery(owner, &e.edit.path)?;
        }
        for b in &journal.buffers {
            if let Some(p) = &b.before.path {
                state.authorize_recovery(owner, p)?;
            }
        }
    }
    Ok(())
}
fn check_buffers(state: &AppState, owner: &str, journal: &Journal, finished: bool) -> Result<()> {
    let windows = state.windows.lock_recover();
    let window = windows
        .get(owner)
        .ok_or_else(|| AppError::new("window", "Window is not initialized"))?;
    let after = journal.pending.is_some_and(Operation::target_after);
    for b in &journal.buffers {
        let m = window.documents.get(&b.before.id).ok_or_else(|| {
            AppError::new(
                "conflict",
                "A replacement editor was closed. Reopen it before retrying.",
            )
        })?;
        let expected = if after { &b.after } else { &b.before.text };
        if m.path != b.before.path
            || m.encoding != b.before.encoding
            || (if finished {
                &m.text != expected
            } else {
                m.text != b.before.text && m.text != b.after
            })
        {
            return Err(AppError::new(
                "conflict",
                format!(
                    "{} changed after replacement. Preserve those edits or restore the expected version before retrying.",
                    b.before.name.as_deref().unwrap_or(&b.before.id)
                ),
            ));
        }
    }
    Ok(())
}
fn create_journal(
    owner: &str,
    root: Option<PathBuf>,
    edits: Vec<DiskEdit>,
    buffers: Vec<BufferEdit>,
) -> Result<Journal> {
    let mut entries = vec![];
    let mut paths = HashSet::new();
    for edit in edits {
        if !paths.insert(canonical(Path::new(&edit.path))?) {
            return Err(AppError::new("transaction", "Duplicate replacement target"));
        }
        let bytes = fs::read(&edit.path)?;
        if files::hash(&bytes) != edit.revision {
            return Err(AppError::new(
                "conflict",
                format!("{} changed after searching", edit.path),
            ));
        }
        let before_bytes = (files::encode(&edit.before, &edit.encoding)? != bytes).then_some(bytes);
        let after_revision = files::hash(&files::encode(&edit.after, &edit.encoding)?);
        entries.push(Entry {
            edit,
            after_revision,
            applied: false,
            undone: false,
            before_bytes,
        });
    }
    let mut ids = HashSet::new();
    for b in &buffers {
        if !b.before.kind.is_text()
            || !ids.insert(&b.before.id)
            || b.before.text.len() > files::MAX_FILE as usize
            || b.after.len() > files::MAX_FILE as usize
        {
            return Err(AppError::new(
                "transaction",
                "Invalid replacement buffer snapshot",
            ));
        }
        if let Some(p) = &b.before.path {
            if !paths.insert(recovery_path(Path::new(p))?) {
                return Err(AppError::new(
                    "transaction",
                    "A file cannot be both an editor and disk replacement",
                ));
            }
        }
    }
    Ok(Journal {
        version: 2,
        owner: owner.into(),
        root,
        entries,
        buffers,
        pending: Some(Operation {
            direction: Direction::Apply,
            rollback: false,
        }),
    })
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    BeforeWrite,
    AfterWrite,
    BeforeProgress,
    AfterProgress,
}
fn execute(path: &Path, journal: &mut Journal) -> Result<Report> {
    execute_with(path, journal, |_, _| Ok(()))
}
fn execute_with(
    path: &Path,
    journal: &mut Journal,
    mut fault: impl FnMut(Stage, usize) -> Result<()>,
) -> Result<Report> {
    let operation = journal
        .pending
        .ok_or_else(|| AppError::new("transaction", "No replacement operation is pending"))?;
    let after = operation.target_after();
    let indices: Vec<_> = journal
        .entries
        .iter()
        .enumerate()
        .filter(|(_, e)| eligible(journal, e))
        .map(|(i, _)| i)
        .collect();
    let mut report = Report::default();
    // Validate the entire group before writing. Pending retries may already be
    // at the target: a write can succeed even though its progress ACK was lost.
    for &index in &indices {
        let e = &journal.entries[index];
        match revision(&e.edit.path) {
            Ok(r) if r == e.edit.revision || r == e.after_revision => (),
            Ok(_) => report.failed.push(format!(
                "{}: The file was modified outside this operation",
                e.edit.path
            )),
            Err(error) => report
                .failed
                .push(format!("{}: {}", e.edit.path, error.message)),
        }
    }
    if !report.failed.is_empty() {
        report.remaining = indices
            .iter()
            .map(|&i| journal.entries[i].edit.path.clone())
            .collect();
        return Ok(report);
    }
    for &index in &indices {
        let e = &mut journal.entries[index];
        let target = if after {
            &e.after_revision
        } else {
            &e.edit.revision
        };
        let current = revision(&e.edit.path)?;
        if current != e.edit.revision && current != e.after_revision {
            report.failed.push(format!(
                "{}: The file changed during replacement",
                e.edit.path
            ));
            break;
        }
        if current != *target {
            fault(Stage::BeforeWrite, index)?;
            let bytes = if after {
                files::encode(&e.edit.after, &e.edit.encoding)?
            } else {
                original_bytes(e)?
            };
            if revision(&e.edit.path)? != current {
                report.failed.push(format!(
                    "{}: The file changed during replacement",
                    e.edit.path
                ));
                break;
            }
            if let Err(error) = files::atomic_write(Path::new(&e.edit.path), &bytes) {
                report
                    .failed
                    .push(format!("{}: {}", e.edit.path, error.message));
                break;
            }
            fault(Stage::AfterWrite, index)?;
            report.succeeded.push(e.edit.path.clone());
        }
        if after {
            e.applied = true;
        }
        e.undone = !after;
        fault(Stage::BeforeProgress, index)?;
        persist(path, journal)?;
        fault(Stage::AfterProgress, index)?;
    }
    report.remaining = indices
        .iter()
        .filter_map(|&i| {
            let e = &journal.entries[i];
            let target = if after {
                &e.after_revision
            } else {
                &e.edit.revision
            };
            (!revision(&e.edit.path).is_ok_and(|r| r == *target)).then(|| e.edit.path.clone())
        })
        .collect();
    report.complete = report.remaining.is_empty() && report.failed.is_empty();
    Ok(report)
}
fn begin_replay(path: &Path, journal: &mut Journal, redo: bool) -> Result<()> {
    let direction = if redo {
        Direction::Redo
    } else {
        Direction::Undo
    };
    if let Some(pending) = journal.pending {
        if pending.direction != direction || pending.rollback {
            return Err(AppError::new(
                "replacementPending",
                "Finish or recover the pending replacement before changing direction",
            ));
        }
        return Ok(());
    }
    for e in journal.entries.iter().filter(|e| e.applied) {
        let expected = if redo {
            &e.edit.revision
        } else {
            &e.after_revision
        };
        if revision(&e.edit.path)? != *expected {
            return Err(AppError::new(
                "conflict",
                format!("{} changed after replacement", e.edit.path),
            ));
        }
    }
    journal.pending = Some(Operation {
        direction,
        rollback: false,
    });
    persist(path, journal)
}
#[tauri::command]
pub async fn replace_disk(
    window: WebviewWindow,
    transaction_id: String,
    edits: Vec<DiskEdit>,
    buffers: Vec<BufferEdit>,
    expected_root: Option<String>,
) -> Result<Report> {
    crate::state::blocking(window, move |window, state| {
        let _disk = state.disk_lock.write_recover();
        ensure_no_pending(&state, window.label())?;
        let root = state
            .windows
            .lock_recover()
            .get(window.label())
            .and_then(|w| w.root.clone());
        if expected_root
            .as_deref()
            .map(Path::new)
            .map(canonical)
            .transpose()?
            != root
        {
            return Err(AppError::new(
                "workspace",
                "The workspace changed before replacement",
            ));
        }
        let path = journal_path(&state, window.label(), &transaction_id)?;
        if path.try_exists()? {
            return Err(AppError::new(
                "transaction",
                "This replacement already exists",
            ));
        }
        for e in &edits {
            state.authorize(window.label(), &e.path)?;
        }
        for b in &buffers {
            if let Some(p) = &b.before.path {
                state.authorize_recovery(window.label(), p)?;
            }
            let windows = state.windows.lock_recover();
            let m = windows
                .get(window.label())
                .and_then(|w| w.documents.get(&b.before.id))
                .ok_or_else(|| AppError::new("stale", "A replacement editor was closed"))?;
            if m.version != b.before.version
                || m.text != b.before.text
                || m.path != b.before.path
                || m.encoding != b.before.encoding
            {
                return Err(AppError::new(
                    "stale",
                    "An editor changed while preparing replacement",
                ));
            }
        }
        let mut journal = create_journal(window.label(), root, edits, buffers)?;
        persist(&path, &journal)?;
        execute(&path, &mut journal)
    })
    .await
}
#[tauri::command]
pub async fn replay_replacement(
    window: WebviewWindow,
    transaction_id: String,
    redo: bool,
) -> Result<Report> {
    crate::state::blocking(window, move |window, state| {
        let _disk = state.disk_lock.write_recover();
        let path = journal_path(&state, window.label(), &transaction_id)?;
        let mut journal = load(&path)?;
        authorize(&state, window.label(), &journal, true)?;
        check_buffers(&state, window.label(), &journal, false)?;
        begin_replay(&path, &mut journal, redo)?;
        execute(&path, &mut journal)
    })
    .await
}
#[tauri::command]
pub async fn finish_replacement(window: WebviewWindow, transaction_id: String) -> Result<()> {
    crate::state::blocking(window, move |window, state| {
        let _disk = state.disk_lock.write_recover();
        let path = journal_path(&state, window.label(), &transaction_id)?;
        let mut journal = load(&path)?;
        authorize(&state, window.label(), &journal, true)?;
        let Some(operation) = journal.pending else {
            return Ok(());
        };
        check_buffers(&state, window.label(), &journal, true)?;
        for e in journal.entries.iter().filter(|e| eligible(&journal, e)) {
            let expected = if operation.target_after() {
                &e.after_revision
            } else {
                &e.edit.revision
            };
            if revision(&e.edit.path)? != *expected {
                return Err(AppError::new(
                    "conflict",
                    format!("{} changed before confirming replacement", e.edit.path),
                ));
            }
        }
        journal.pending = None;
        persist(&path, &journal)
    })
    .await
}
#[tauri::command]
pub async fn resume_replacement(window: WebviewWindow, transaction_id: String) -> Result<Report> {
    crate::state::blocking(window, move |window, state| {
        let _disk = state.disk_lock.write_recover();
        let path = journal_path(&state, window.label(), &transaction_id)?;
        let mut journal = load(&path)?;
        authorize(&state, window.label(), &journal, true)?;
        check_buffers(&state, window.label(), &journal, false)?;
        execute(&path, &mut journal)
    })
    .await
}
#[tauri::command]
pub async fn replacement_recovery(window: WebviewWindow) -> Result<Vec<Recovery>> {
    crate::state::blocking(window, move |window, state| {
        let _disk = state.disk_lock.write_recover();
        Ok(logs(&state, window.label())?
            .into_iter()
            .map(|(id, _, journal)| description(&journal, id))
            .collect())
    })
    .await
}
#[tauri::command]
pub async fn recover_replacement(
    window: WebviewWindow,
    transaction_id: String,
    keep: bool,
) -> Result<Report> {
    crate::state::blocking(window, move |window, state| {
        let _disk = state.disk_lock.write_recover();
        let path = journal_path(&state, window.label(), &transaction_id)?;
        let root = state
            .windows
            .lock_recover()
            .get(window.label())
            .and_then(|w| w.root.clone());
        let mut journal = load(&path)?;
        upgrade_legacy(&mut journal, window.label(), root);
        authorize(&state, window.label(), &journal, !keep)?;
        if keep {
            journal.version = 2;
            journal.pending = None;
            persist(&path, &journal)?;
            return Ok(Report {
                complete: true,
                ..Default::default()
            });
        }
        check_buffers(&state, window.label(), &journal, false)?;
        journal
            .pending
            .as_mut()
            .ok_or_else(|| AppError::new("transaction", "This replacement is already resolved"))?
            .rollback = true;
        journal.version = 2;
        persist(&path, &journal)?;
        execute(&path, &mut journal)
    })
    .await
}
