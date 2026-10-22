use crate::{
    error::{AppError, Result},
    files,
    state::AppState,
};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use tauri::{State, WebviewWindow};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskEdit {
    pub path: String,
    pub before: String,
    pub after: String,
    pub encoding: String,
    pub revision: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    edit: DiskEdit,
    after_revision: String,
    applied: bool,
    undone: bool,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    entries: Vec<Entry>,
}
#[derive(Default, Serialize)]
pub struct Report {
    pub succeeded: Vec<String>,
    pub failed: Vec<String>,
}

fn journal_path(state: &AppState, window: &str, id: &str) -> Result<std::path::PathBuf> {
    if id.len() > 64 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(AppError::new(
            "transaction",
            "Invalid transaction identifier",
        ));
    }
    Ok(state
        .data_dir
        .join("transactions")
        .join(window)
        .join(format!("{id}.json")))
}

fn persist(path: &Path, journal: &Journal) -> Result<()> {
    files::atomic_write(path, &serde_json::to_vec(journal)?)
}

fn apply(path: &Path, edits: Vec<DiskEdit>) -> Result<Report> {
    let entries = edits
        .into_iter()
        .map(|edit| {
            let after_revision =
                files::encode(&edit.after, &edit.encoding).map(|b| files::hash(&b))?;
            Ok(Entry {
                edit,
                after_revision,
                applied: false,
                undone: false,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut journal = Journal { entries };
    let mut report = Report::default();
    persist(path, &journal)?;
    for index in 0..journal.entries.len() {
        let entry = &mut journal.entries[index];
        match files::save(
            Path::new(&entry.edit.path),
            &entry.edit.after,
            &entry.edit.encoding,
            Some(&entry.edit.revision),
        ) {
            Ok(_) => {
                entry.applied = true;
                report.succeeded.push(entry.edit.path.clone());
            }
            Err(e) => report
                .failed
                .push(format!("{}: {}", entry.edit.path, e.message)),
        }
        persist(path, &journal)?;
    }
    Ok(report)
}

fn replay(path: &Path, redo: bool) -> Result<Report> {
    let mut journal: Journal = serde_json::from_slice(&fs::read(path)?)?;
    let mut report = Report::default();
    for index in 0..journal.entries.len() {
        let entry = &mut journal.entries[index];
        if !entry.applied || entry.undone != redo {
            continue;
        }
        let (text, expected) = if redo {
            (&entry.edit.after, &entry.edit.revision)
        } else {
            (&entry.edit.before, &entry.after_revision)
        };
        match files::save(
            Path::new(&entry.edit.path),
            text,
            &entry.edit.encoding,
            Some(expected),
        ) {
            Ok(_) => {
                entry.undone = !redo;
                report.succeeded.push(entry.edit.path.clone());
            }
            Err(e) => report
                .failed
                .push(format!("{}: {}", entry.edit.path, e.message)),
        }
        persist(path, &journal)?;
    }
    Ok(report)
}

#[tauri::command]
pub async fn replace_disk(
    window: WebviewWindow,
    state: State<'_, AppState>,
    transaction_id: String,
    edits: Vec<DiskEdit>,
) -> Result<Report> {
    for edit in &edits {
        state.authorize(window.label(), &edit.path)?;
    }
    let path = journal_path(&state, window.label(), &transaction_id)?;
    let _disk = state.disk_lock.lock().unwrap();
    if path.exists() {
        return Err(AppError::new(
            "transaction",
            "This replacement transaction already exists",
        ));
    }
    apply(&path, edits)
}

#[tauri::command]
pub async fn replay_replacement(
    window: WebviewWindow,
    state: State<'_, AppState>,
    transaction_id: String,
    redo: bool,
) -> Result<Report> {
    let path = journal_path(&state, window.label(), &transaction_id)?;
    let _disk = state.disk_lock.lock().unwrap();
    let journal: Journal = serde_json::from_slice(&fs::read(&path)?)?;
    for entry in &journal.entries {
        state.authorize(window.label(), &entry.edit.path)?;
    }
    replay(&path, redo)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mixed_line_endings_roundtrip_through_undo_and_redo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mixed.txt");
        let original = "a\r\nb\nc\n";
        fs::write(&path, original).unwrap();
        let journal = dir.path().join("transaction.json");
        let report = apply(
            &journal,
            vec![DiskEdit {
                path: path.to_string_lossy().into_owned(),
                before: original.into(),
                after: "x\nb\nc\n".into(),
                encoding: "utf8".into(),
                revision: files::hash(original.as_bytes()),
            }],
        )
        .unwrap();
        assert_eq!(report.succeeded.len(), 1);
        for redo in [false, true, false] {
            assert_eq!(replay(&journal, redo).unwrap().succeeded.len(), 1);
            assert_eq!(
                fs::read(&path).unwrap(),
                if redo {
                    b"x\nb\nc\n".as_slice()
                } else {
                    original.as_bytes()
                }
            );
        }
    }

    #[test]
    fn partial_failure_can_undo_and_redo_successful_writes() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        fs::write(&a, "old").unwrap();
        fs::write(&b, "external").unwrap();
        let edits = [&a, &b]
            .into_iter()
            .map(|path| DiskEdit {
                path: path.to_string_lossy().into(),
                before: "old".into(),
                after: "new".into(),
                encoding: "utf8".into(),
                revision: files::hash(b"old"),
            })
            .collect();
        let journal = dir.path().join("transaction.json");
        let report = apply(&journal, edits).unwrap();
        assert_eq!(report.succeeded.len(), 1);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(fs::read_to_string(&b).unwrap(), "external");
        assert_eq!(replay(&journal, false).unwrap().succeeded.len(), 1);
        assert_eq!(fs::read_to_string(&a).unwrap(), "old");
        assert_eq!(replay(&journal, true).unwrap().succeeded.len(), 1);
        assert_eq!(fs::read_to_string(&a).unwrap(), "new");
        fs::write(&a, "later").unwrap();
        assert_eq!(replay(&journal, false).unwrap().failed.len(), 1);
        assert_eq!(fs::read_to_string(&a).unwrap(), "later");
    }
}
