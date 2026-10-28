use crate::{
    error::{AppError, Result},
    files,
    state::{AppState, DocumentSnapshot, Mirror},
    sync::MutexExt,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf};

#[cfg(test)]
mod tests;

#[derive(Default)]
pub struct BackupState {
    bodies: HashMap<String, (u64, u64, String)>,
    manifest: Option<Vec<u8>>,
    pub preserve_files: bool,
    pub blocked: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDocument {
    #[serde(flatten)]
    metadata: DocumentSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<String>,
}

#[derive(Default)]
pub struct LoadedSession {
    pub root: Option<PathBuf>,
    pub session: serde_json::Value,
    pub documents: Vec<Mirror>,
    pub preserve_files: bool,
    pub blocked: bool,
}

fn directory(state: &AppState, label: &str) -> Result<PathBuf> {
    if label.is_empty() || !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(AppError::new("recovery", "Invalid recovery window"));
    }
    let directory = state.data_dir.join("recovery").join(label);
    for path in [state.data_dir.join("recovery"), directory.clone()] {
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err(AppError::new(
                    "recovery",
                    "Recovery directories must be ordinary directories",
                ));
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(directory)
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

// Serialize every persistence entry point, including Destroyed, without taking
// disk_lock. Workers holding that gate may be waiting for the UI thread.
pub fn checkpoint(state: &AppState, label: &str) -> Result<()> {
    let lock = state.disk_operation(format!("recovery:{label}"));
    let _recovery = lock.lock_recover();
    let directory = directory(state, label)?;
    let (root, session, mut documents, pending, mut bodies, previous, preserve) = {
        let windows = state.windows.lock_recover();
        let Some(window) = windows.get(label) else {
            return Ok(());
        };
        if window.backup.blocked {
            return Err(AppError::new(
                "recovery",
                "Cannot replace a damaged recovery manifest before preserving it",
            ));
        }
        let mut documents = vec![];
        let mut pending = vec![];
        let mut bodies = HashMap::new();
        let mut mirrors: Vec<_> = window.documents.values().collect();
        mirrors.sort_by(|a, b| a.id.cmp(&b.id));
        for doc in mirrors {
            let mut body = None;
            if doc.kind.is_text() && (doc.dirty || doc.path.is_none()) {
                let generation = *window.text_generations.get(&doc.id).unwrap_or(&0);
                if let Some(cached) = window.backup.bodies.get(&doc.id)
                    && cached.0 == generation
                    && cached.1 == doc.version
                {
                    body = Some(cached.2.clone());
                    bodies.insert(doc.id.clone(), cached.clone());
                } else {
                    // Only newly changed recoverable bodies are cloned.
                    pending.push((documents.len(), generation, doc.version, doc.text.clone()));
                }
            }
            documents.push(StoredDocument {
                metadata: doc.metadata(),
                body,
            });
        }
        (
            window.root.clone(),
            window.session.clone(),
            documents,
            pending,
            bodies,
            window.backup.manifest.clone(),
            window.backup.preserve_files,
        )
    };
    for (index, generation, version, text) in pending {
        let hash = files::hash(text.as_bytes());
        let file = directory.join(format!("{hash}.txt"));
        // A prior failed manifest commit may already have written this blob.
        let reusable = match fs::symlink_metadata(&file) {
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
                fs::read(&file).is_ok_and(|bytes| files::hash(&bytes) == hash)
            }
            Ok(_) => return Err(AppError::new("recovery", "Invalid recovery body file")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        if !reusable {
            files::atomic_write(&file, text.as_bytes())?;
        }
        bodies.insert(
            documents[index].metadata.id.clone(),
            (generation, version, hash.clone()),
        );
        documents[index].body = Some(hash);
    }
    let manifest = serde_json::to_vec(&serde_json::json!({
        "version": 2, "root": root, "session": session, "documents": documents,
    }))?;
    if previous.as_ref() != Some(&manifest) {
        let path = state.data_dir.join(format!("session-{label}.json"));
        // A restored window has no in-memory commit cache yet. Compare only
        // same-sized manifests so legacy inline bodies are never reread here.
        let already_committed = previous.is_none()
            && fs::metadata(&path).is_ok_and(|meta| meta.len() == manifest.len() as u64)
            && fs::read(&path).is_ok_and(|bytes| bytes == manifest);
        if !already_committed {
            files::atomic_write(&path, &manifest)?;
        }
    }
    {
        let mut windows = state.windows.lock_recover();
        if let Some(window) = windows.get_mut(label) {
            // These generations describe the captured snapshot. If a newer
            // sync arrived during I/O, it will still miss this cache next time.
            window.backup.bodies = bodies;
            window.backup.manifest = Some(manifest);
        }
    }
    if !preserve && directory.is_dir() {
        let referenced: std::collections::HashSet<_> =
            documents.iter().filter_map(|d| d.body.as_deref()).collect();
        // Cleanup failure must not invalidate a successfully committed backup.
        let cleanup = || -> Result<()> {
            for entry in fs::read_dir(&directory)? {
                let entry = entry?;
                let name = entry.file_name();
                if let Some(hash) = name.to_str().and_then(|name| name.strip_suffix(".txt"))
                    && valid_hash(hash)
                    && !referenced.contains(hash)
                    && entry.file_type()?.is_file()
                {
                    fs::remove_file(entry.path())?;
                }
            }
            Ok(())
        };
        if let Err(error) = cleanup() {
            state.startup_warnings.lock_recover().push(format!(
                "Could not clean obsolete recovery data: {}",
                error.message
            ));
        }
    }
    Ok(())
}

pub fn load(state: &AppState, label: &str, warnings: &mut Vec<String>) -> LoadedSession {
    let mut loaded = LoadedSession::default();
    let directory = match directory(state, label) {
        Ok(directory) => directory,
        Err(error) => {
            warnings.push(error.message);
            loaded.blocked = true;
            return loaded;
        }
    };
    loaded.preserve_files = fs::read_dir(&directory).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("preserved-") && name.ends_with(".json"))
        })
    });
    let file = state.data_dir.join(format!("session-{label}.json"));
    let bytes = match fs::read(&file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return loaded,
        Err(error) => {
            warnings.push(format!("Cannot read {}: {error}", file.display()));
            loaded.blocked = true;
            return loaded;
        }
    };
    let mut damaged = false;
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => {
            warnings.push(format!(
                "Cannot read {}: {error}. Recovery files were preserved.",
                file.display()
            ));
            damaged = true;
            serde_json::Value::Null
        }
    };
    let version = value["version"].as_u64().unwrap_or(1);
    loaded.root = value["root"].as_str().map(PathBuf::from);
    loaded.session = value["session"].clone();
    if !matches!(version, 1 | 2) {
        damaged = true;
        warnings.push(format!(
            "Unsupported recovery format {version} in {}",
            file.display()
        ));
    } else if let Some(records) = value["documents"].as_array() {
        for record in records {
            let parsed = serde_json::from_value::<DocumentSnapshot>(record.clone());
            let invalid_metadata = parsed.is_err();
            let restore = || -> Result<Mirror> {
                let mut doc = parsed?;
                let text = if !doc.kind.is_text() {
                    String::new()
                } else if !doc.dirty && doc.path.is_some() {
                    // Clean files have no persistent body. Reopen the current
                    // disk contents, never an empty stand-in for a missing file.
                    let disk = files::read(
                        std::path::Path::new(doc.path.as_ref().unwrap()),
                        true,
                        Some(&doc.encoding),
                    )?;
                    if let Some(info) = &mut doc.file_info {
                        info.size = fs::metadata(doc.path.as_ref().unwrap())?.len();
                    }
                    doc.revision = Some(disk.revision);
                    doc.encoding = disk.encoding;
                    disk.text
                } else if version == 1 {
                    doc.text
                        .take()
                        .ok_or_else(|| AppError::new("recovery", "Missing legacy document body"))?
                } else {
                    let hash = record["body"]
                        .as_str()
                        .filter(|hash| valid_hash(hash))
                        .ok_or_else(|| {
                            AppError::new("recovery", "Invalid recovery body reference")
                        })?;
                    let file = directory.join(format!("{hash}.txt"));
                    let meta = fs::symlink_metadata(&file)?;
                    if !meta.is_file()
                        || meta.file_type().is_symlink()
                        || meta.len() > files::MAX_FILE
                    {
                        return Err(AppError::new("recovery", "Invalid recovery body file"));
                    }
                    let text = fs::read(&file)?;
                    if files::hash(&text) != hash {
                        return Err(AppError::new("recovery", "Recovery body checksum mismatch"));
                    }
                    String::from_utf8(text).map_err(|e| AppError::new("recovery", e.to_string()))?
                };
                if text.len() > files::MAX_FILE as usize || (!doc.kind.is_text() && doc.dirty) {
                    return Err(AppError::new("recovery", "Invalid recovery document"));
                }
                Ok(doc.with_text(text))
            };
            match restore() {
                Ok(doc) => loaded.documents.push(doc),
                Err(error) => {
                    // Missing clean files are expected under metadata-only
                    // recovery; unreadable unsaved buffers need preservation.
                    damaged |=
                        invalid_metadata || record["dirty"] != false || !record["path"].is_string();
                    warnings.push(format!(
                        "Could not restore {}: {}. Recovery data was preserved.",
                        record["name"]
                            .as_str()
                            .or(record["id"].as_str())
                            .unwrap_or("document"),
                        error.message
                    ));
                }
            }
        }
    } else {
        damaged = true;
        warnings.push(format!("Invalid document list in {}", file.display()));
    }
    if damaged {
        loaded.preserve_files = true;
        let preserved = directory.join(format!("preserved-{}.json", files::hash(&bytes)));
        if let Err(error) = files::atomic_write(&preserved, &bytes) {
            loaded.blocked = true;
            warnings.push(format!(
                "Cannot preserve damaged recovery manifest: {}",
                error.message
            ));
        }
    }
    loaded
}
