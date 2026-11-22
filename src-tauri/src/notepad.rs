use crate::{
    error::{AppError, Result},
    files,
    state::AppState,
    sync::MutexExt,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const INDEX_VERSION: u32 = 1;
const DEFAULT_FORMAT: &str = "txt";
const DEFAULT_SORT: &str = "manual";
const MAX_TITLE_CHARS: usize = 120;
const MAX_PREVIEW_CHARS: usize = 140;

const KNOWN_FORMATS: &[&str] = &[
    "txt", "md", "json", "jsonc", "yaml", "toml", "ini", "xml", "html", "css", "csv", "sql", "js",
    "ts", "py", "sh", "ps1", "env", "log",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub id: String,
    pub title: String,
    pub format: String,
    #[serde(default)]
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub preview: String,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotepadIndex {
    #[serde(default = "default_index_version")]
    version: u32,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    active_id: Option<String>,
    #[serde(default)]
    open_tabs: Vec<String>,
    #[serde(default = "default_sort_mode")]
    sort: String,
    #[serde(default)]
    notes: Vec<NoteMeta>,
}

fn default_index_version() -> u32 {
    INDEX_VERSION
}

fn default_sort_mode() -> String {
    DEFAULT_SORT.to_string()
}

fn normalize_sort(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some("manual") => "manual".to_string(),
        Some("updated") => "updated".to_string(),
        Some("created") => "created".to_string(),
        Some("title") => "title".to_string(),
        _ => DEFAULT_SORT.to_string(),
    }
}

impl Default for NotepadIndex {
    fn default() -> Self {
        Self {
            version: INDEX_VERSION,
            revision: 0,
            active_id: None,
            open_tabs: Vec::new(),
            sort: default_sort_mode(),
            notes: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotepadSnapshot {
    pub revision: u64,
    pub notes: Vec<NoteMeta>,
    pub active_id: Option<String>,
    pub open_tabs: Vec<String>,
    pub sort: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotepadNoteContent {
    pub id: String,
    pub content: String,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotepadLoadResponse {
    pub snapshot: NotepadSnapshot,
    pub contents: HashMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotepadCreateResponse {
    pub snapshot: NotepadSnapshot,
    pub note: NoteMeta,
    pub content: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotepadSaveResponse {
    pub snapshot: NotepadSnapshot,
    pub note_revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotepadEvent {
    pub source_window: String,
    pub revision: u64,
    pub snapshot: NotepadSnapshot,
    pub updated_note: Option<NotepadNoteContent>,
}

struct LoadedStore {
    index: NotepadIndex,
    mtime: Option<SystemTime>,
}

#[derive(Default)]
pub struct Service {
    inner: Mutex<Option<LoadedStore>>,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn generate_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("note-{nanos:x}-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::new("notepad", "Invalid note identifier."));
    }
    Ok(())
}

fn normalize_format(raw: Option<&str>) -> String {
    let cleaned = raw
        .unwrap_or(DEFAULT_FORMAT)
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    let mapped = match cleaned.as_str() {
        "markdown" => "md",
        "yml" => "yaml",
        "htm" => "html",
        "mjs" | "cjs" | "javascript" => "js",
        "typescript" => "ts",
        "python" => "py",
        "bash" | "zsh" | "shell" => "sh",
        "powershell" => "ps1",
        "plaintext" | "text" => "txt",
        "dotenv" => "env",
        other => other,
    };
    if KNOWN_FORMATS.contains(&mapped) {
        mapped.to_string()
    } else if !mapped.is_empty()
        && mapped.len() <= 16
        && mapped.chars().all(|c| c.is_ascii_alphanumeric())
    {
        mapped.to_string()
    } else {
        DEFAULT_FORMAT.to_string()
    }
}

fn normalize_title(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(MAX_TITLE_CHARS).collect())
}

fn make_preview(content: &str) -> String {
    let first = content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let collapsed = first.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::new();
    for ch in collapsed.chars().take(MAX_PREVIEW_CHARS) {
        out.push(ch);
    }
    out
}

fn next_default_title(notes: &[NoteMeta]) -> String {
    let existing: HashSet<String> = notes.iter().map(|n| n.title.to_ascii_lowercase()).collect();
    let mut n = 1usize;
    loop {
        let candidate = format!("Note {n}");
        if !existing.contains(&candidate.to_ascii_lowercase()) {
            return candidate;
        }
        n += 1;
    }
}

fn notepad_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("notepad")
}

fn index_path(data_dir: &Path) -> PathBuf {
    notepad_dir(data_dir).join("index.json")
}

fn note_file_path(data_dir: &Path, id: &str) -> PathBuf {
    notepad_dir(data_dir)
        .join("notes")
        .join(format!("{id}.txt"))
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok().and_then(|m| m.modified().ok())
}

fn sanitize_export_filename(title: &str, format: &str) -> String {
    let safe_title: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = safe_title.trim().trim_matches('.');
    let base = if trimmed.is_empty() { "Note" } else { trimmed };
    let suffix = format!(".{format}");
    if base.to_ascii_lowercase().ends_with(&suffix) {
        base.to_string()
    } else {
        format!("{base}{suffix}")
    }
}

impl NotepadIndex {
    fn snapshot(&self) -> NotepadSnapshot {
        NotepadSnapshot {
            revision: self.revision,
            notes: self.notes.clone(),
            active_id: self.active_id.clone(),
            open_tabs: self.open_tabs.clone(),
            sort: self.sort.clone(),
        }
    }

    fn sync_open_tabs_order(&mut self) {
        let open: HashSet<String> = self.open_tabs.iter().cloned().collect();
        let mut next = Vec::with_capacity(open.len());
        for note in &self.notes {
            if note.pinned && open.contains(&note.id) {
                next.push(note.id.clone());
            }
        }
        for note in &self.notes {
            if !note.pinned && open.contains(&note.id) {
                next.push(note.id.clone());
            }
        }
        self.open_tabs = next;
    }

    fn normalize_references(&mut self) {
        self.sort = normalize_sort(Some(&self.sort));
        let valid: HashSet<&str> = self.notes.iter().map(|n| n.id.as_str()).collect();
        let mut seen = HashSet::new();
        self.open_tabs
            .retain(|id| valid.contains(id.as_str()) && seen.insert(id.clone()));
        if self
            .active_id
            .as_deref()
            .is_none_or(|id| !valid.contains(id))
        {
            self.active_id = self
                .open_tabs
                .first()
                .cloned()
                .or_else(|| self.notes.first().map(|n| n.id.clone()));
        }
        if let Some(active) = &self.active_id
            && !self.open_tabs.contains(active)
        {
            self.open_tabs.push(active.clone());
        }
    }
}

impl Service {
    fn ensure_loaded<'a>(
        guard: &'a mut Option<LoadedStore>,
        data_dir: &Path,
        check_disk: bool,
    ) -> Result<&'a mut LoadedStore> {
        let path = index_path(data_dir);
        let disk_mtime = file_mtime(&path);
        let should_reload = match guard {
            None => true,
            Some(loaded) => check_disk && disk_mtime != loaded.mtime,
        };
        if should_reload {
            let mut index = match fs::read(&path) {
                Ok(bytes) => serde_json::from_slice::<NotepadIndex>(&bytes).unwrap_or_default(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    NotepadIndex::default()
                }
                Err(error) => return Err(error.into()),
            };
            index.notes.retain(|note| validate_id(&note.id).is_ok());
            index.normalize_references();
            *guard = Some(LoadedStore {
                index,
                mtime: disk_mtime,
            });
        }
        Ok(guard.as_mut().unwrap())
    }

    fn persist_index(store: &mut LoadedStore, data_dir: &Path) -> Result<()> {
        let path = index_path(data_dir);
        let bytes = serde_json::to_vec_pretty(&store.index)?;
        files::atomic_write(&path, &bytes)?;
        store.mtime = file_mtime(&path);
        Ok(())
    }

    fn read_content_file(data_dir: &Path, id: &str) -> Result<String> {
        validate_id(id)?;
        let path = note_file_path(data_dir, id);
        match fs::read(&path) {
            Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn load(&self, data_dir: &Path) -> Result<NotepadLoadResponse> {
        let mut guard = self.inner.lock_recover();
        let store = Self::ensure_loaded(&mut guard, data_dir, true)?;
        if store.index.notes.is_empty() {
            let now = now_millis();
            let id = generate_id();
            let note = NoteMeta {
                id: id.clone(),
                title: "Note 1".to_string(),
                format: DEFAULT_FORMAT.to_string(),
                pinned: false,
                created_at: now,
                updated_at: now,
                preview: String::new(),
                revision: 1,
            };
            store.index.revision += 1;
            store.index.notes.push(note);
            store.index.open_tabs = vec![id.clone()];
            store.index.active_id = Some(id.clone());
            files::atomic_write(&note_file_path(data_dir, &id), b"")?;
            Self::persist_index(store, data_dir)?;
        }
        let snapshot = store.index.snapshot();
        let mut contents = HashMap::new();
        for id in &snapshot.open_tabs {
            contents.insert(id.clone(), Self::read_content_file(data_dir, id)?);
        }
        if let Some(active_id) = &snapshot.active_id
            && !contents.contains_key(active_id)
        {
            contents.insert(
                active_id.clone(),
                Self::read_content_file(data_dir, active_id)?,
            );
        }
        Ok(NotepadLoadResponse { snapshot, contents })
    }

    pub fn read_note(&self, data_dir: &Path, id: &str) -> Result<NotepadNoteContent> {
        validate_id(id)?;
        let mut guard = self.inner.lock_recover();
        let store = Self::ensure_loaded(&mut guard, data_dir, true)?;
        let note = store
            .index
            .notes
            .iter()
            .find(|n| n.id == id)
            .ok_or_else(|| AppError::new("notFound", "Note was not found."))?;
        let content = Self::read_content_file(data_dir, id)?;
        Ok(NotepadNoteContent {
            id: id.to_string(),
            content,
            revision: note.revision,
        })
    }

    pub fn create_note(
        &self,
        data_dir: &Path,
        title: Option<String>,
        format: Option<String>,
        content: Option<String>,
    ) -> Result<NotepadCreateResponse> {
        let content = content.unwrap_or_default();
        if content.len() > files::MAX_FILE as usize {
            return Err(AppError::new(
                "fileTooLarge",
                "Note content exceeds the maximum file size limit.",
            ));
        }
        let mut guard = self.inner.lock_recover();
        let store = Self::ensure_loaded(&mut guard, data_dir, true)?;
        let now = now_millis();
        let id = generate_id();
        let title = title
            .as_deref()
            .and_then(normalize_title)
            .unwrap_or_else(|| next_default_title(&store.index.notes));
        let format = normalize_format(format.as_deref());
        let note = NoteMeta {
            id: id.clone(),
            title,
            format,
            pinned: false,
            created_at: now,
            updated_at: now,
            preview: make_preview(&content),
            revision: 1,
        };
        files::atomic_write(&note_file_path(data_dir, &id), content.as_bytes())?;
        store.index.revision += 1;
        store.index.notes.insert(0, note.clone());
        store.index.open_tabs.push(id.clone());
        store.index.sync_open_tabs_order();
        store.index.active_id = Some(id);
        Self::persist_index(store, data_dir)?;
        Ok(NotepadCreateResponse {
            snapshot: store.index.snapshot(),
            note,
            content,
        })
    }

    pub fn save_content(
        &self,
        data_dir: &Path,
        id: &str,
        content: String,
    ) -> Result<NotepadSaveResponse> {
        validate_id(id)?;
        if content.len() > files::MAX_FILE as usize {
            return Err(AppError::new(
                "fileTooLarge",
                "Note content exceeds the maximum file size limit.",
            ));
        }
        let mut guard = self.inner.lock_recover();
        let store = Self::ensure_loaded(&mut guard, data_dir, false)?;
        let Some(note) = store.index.notes.iter_mut().find(|n| n.id == id) else {
            return Err(AppError::new("notFound", "Note was not found."));
        };
        let path = note_file_path(data_dir, id);
        files::atomic_write(&path, content.as_bytes())?;
        note.updated_at = now_millis();
        note.preview = make_preview(&content);
        note.revision += 1;
        let note_revision = note.revision;
        store.index.revision += 1;
        Self::persist_index(store, data_dir)?;
        Ok(NotepadSaveResponse {
            snapshot: store.index.snapshot(),
            note_revision,
        })
    }

    pub fn update_meta(
        &self,
        data_dir: &Path,
        id: &str,
        title: Option<String>,
        format: Option<String>,
        pinned: Option<bool>,
    ) -> Result<NotepadSnapshot> {
        validate_id(id)?;
        let mut guard = self.inner.lock_recover();
        let store = Self::ensure_loaded(&mut guard, data_dir, false)?;
        let Some(note) = store.index.notes.iter_mut().find(|n| n.id == id) else {
            return Err(AppError::new("notFound", "Note was not found."));
        };
        let mut changed = false;
        if let Some(raw_title) = title {
            let next_title = normalize_title(&raw_title)
                .ok_or_else(|| AppError::new("notepad", "Note title cannot be empty."))?;
            if note.title != next_title {
                note.title = next_title;
                changed = true;
            }
        }
        if let Some(raw_format) = format {
            let next_format = normalize_format(Some(&raw_format));
            if note.format != next_format {
                note.format = next_format;
                changed = true;
            }
        }
        if let Some(next_pinned) = pinned
            && note.pinned != next_pinned
        {
            note.pinned = next_pinned;
            changed = true;
        }
        if changed {
            note.updated_at = now_millis();
            note.revision += 1;
            store.index.revision += 1;
            Self::persist_index(store, data_dir)?;
        }
        Ok(store.index.snapshot())
    }

    pub fn delete_note(&self, data_dir: &Path, id: &str) -> Result<NotepadSnapshot> {
        validate_id(id)?;
        let mut guard = self.inner.lock_recover();
        let store = Self::ensure_loaded(&mut guard, data_dir, false)?;
        let before = store.index.notes.len();
        store.index.notes.retain(|n| n.id != id);
        if store.index.notes.len() == before {
            return Ok(store.index.snapshot());
        }
        let removed_tab = store.index.open_tabs.iter().position(|tab| tab == id);
        store.index.open_tabs.retain(|tab| tab != id);
        if store.index.active_id.as_deref() == Some(id) {
            store.index.active_id = removed_tab
                .and_then(|idx| {
                    store
                        .index
                        .open_tabs
                        .get(idx)
                        .or_else(|| {
                            idx.checked_sub(1)
                                .and_then(|p| store.index.open_tabs.get(p))
                        })
                        .cloned()
                })
                .or_else(|| store.index.open_tabs.first().cloned())
                .or_else(|| store.index.notes.first().map(|n| n.id.clone()));
            if let Some(active) = &store.index.active_id
                && !store.index.open_tabs.contains(active)
            {
                store.index.open_tabs.push(active.clone());
            }
        }
        let path = note_file_path(data_dir, id);
        if let Err(error) = fs::remove_file(&path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error.into());
        }
        store.index.revision += 1;
        Self::persist_index(store, data_dir)?;
        Ok(store.index.snapshot())
    }

    pub fn set_tabs(
        &self,
        data_dir: &Path,
        open_tabs: Vec<String>,
        active_id: Option<String>,
    ) -> Result<NotepadSnapshot> {
        let mut guard = self.inner.lock_recover();
        let store = Self::ensure_loaded(&mut guard, data_dir, false)?;
        let valid: HashSet<&str> = store.index.notes.iter().map(|n| n.id.as_str()).collect();
        let mut seen = HashSet::new();
        let next_tabs: Vec<String> = open_tabs
            .into_iter()
            .filter(|id| valid.contains(id.as_str()) && seen.insert(id.clone()))
            .collect();
        let next_active = active_id.filter(|id| valid.contains(id.as_str()));
        if store.index.open_tabs != next_tabs || store.index.active_id != next_active {
            store.index.open_tabs = next_tabs;
            store.index.active_id = next_active;
            if let Some(active) = &store.index.active_id
                && !store.index.open_tabs.contains(active)
            {
                store.index.open_tabs.push(active.clone());
            }
            Self::persist_index(store, data_dir)?;
        }
        Ok(store.index.snapshot())
    }

    pub fn reorder_notes(
        &self,
        data_dir: &Path,
        note_ids: Vec<String>,
        open_tabs: Option<Vec<String>>,
    ) -> Result<NotepadSnapshot> {
        let mut guard = self.inner.lock_recover();
        let store = Self::ensure_loaded(&mut guard, data_dir, false)?;
        let mut remaining: HashMap<String, NoteMeta> = store
            .index
            .notes
            .iter()
            .cloned()
            .map(|note| (note.id.clone(), note))
            .collect();
        let mut next_notes = Vec::with_capacity(store.index.notes.len());
        for id in note_ids {
            if let Some(note) = remaining.remove(&id) {
                next_notes.push(note);
            }
        }
        for note in &store.index.notes {
            if let Some(unlisted) = remaining.remove(&note.id) {
                next_notes.push(unlisted);
            }
        }
        let next_sort = "manual".to_string();
        let mut changed = store.index.notes != next_notes || store.index.sort != next_sort;
        store.index.notes = next_notes;
        store.index.sort = next_sort;
        let previous_tabs = store.index.open_tabs.clone();
        if let Some(tabs) = open_tabs {
            let valid: HashSet<&str> = store.index.notes.iter().map(|n| n.id.as_str()).collect();
            let mut seen = HashSet::new();
            store.index.open_tabs = tabs
                .into_iter()
                .filter(|id| valid.contains(id.as_str()) && seen.insert(id.clone()))
                .collect();
            if let Some(active) = &store.index.active_id
                && !store.index.open_tabs.contains(active)
            {
                store.index.open_tabs.push(active.clone());
            }
        }
        store.index.sync_open_tabs_order();
        if store.index.open_tabs != previous_tabs {
            changed = true;
        }
        if changed {
            store.index.revision += 1;
            Self::persist_index(store, data_dir)?;
        }
        Ok(store.index.snapshot())
    }

    pub fn set_sort(
        &self,
        data_dir: &Path,
        sort: String,
        open_tabs: Option<Vec<String>>,
    ) -> Result<NotepadSnapshot> {
        let mut guard = self.inner.lock_recover();
        let store = Self::ensure_loaded(&mut guard, data_dir, false)?;
        let next_sort = normalize_sort(Some(&sort));
        let mut changed = store.index.sort != next_sort;
        store.index.sort = next_sort;
        if let Some(tabs) = open_tabs {
            let valid: HashSet<&str> = store.index.notes.iter().map(|n| n.id.as_str()).collect();
            let mut seen = HashSet::new();
            let mut next_tabs: Vec<String> = tabs
                .into_iter()
                .filter(|id| valid.contains(id.as_str()) && seen.insert(id.clone()))
                .collect();
            if let Some(active) = &store.index.active_id
                && !next_tabs.contains(active)
            {
                next_tabs.push(active.clone());
            }
            if store.index.open_tabs != next_tabs {
                store.index.open_tabs = next_tabs;
                changed = true;
            }
        }
        if changed {
            store.index.revision += 1;
            Self::persist_index(store, data_dir)?;
        }
        Ok(store.index.snapshot())
    }
}

fn emit_change(
    window: &WebviewWindow,
    snapshot: &NotepadSnapshot,
    updated_note: Option<NotepadNoteContent>,
) {
    let event = NotepadEvent {
        source_window: window.label().to_string(),
        revision: snapshot.revision,
        snapshot: snapshot.clone(),
        updated_note,
    };
    let _ = window.app_handle().emit("notepad-changed", event);
}

#[tauri::command]
pub async fn notepad_load(window: WebviewWindow) -> Result<NotepadLoadResponse> {
    crate::state::blocking(window, move |_window, state: &AppState| {
        state.notepad.load(&state.data_dir)
    })
    .await
}

#[tauri::command]
pub async fn notepad_read(window: WebviewWindow, id: String) -> Result<NotepadNoteContent> {
    crate::state::blocking(window, move |_window, state: &AppState| {
        state.notepad.read_note(&state.data_dir, &id)
    })
    .await
}

#[tauri::command]
pub async fn notepad_create(
    window: WebviewWindow,
    title: Option<String>,
    format: Option<String>,
    content: Option<String>,
) -> Result<NotepadCreateResponse> {
    crate::state::blocking(window, move |window, state: &AppState| {
        let created = state
            .notepad
            .create_note(&state.data_dir, title, format, content)?;
        emit_change(
            &window,
            &created.snapshot,
            Some(NotepadNoteContent {
                id: created.note.id.clone(),
                content: created.content.clone(),
                revision: created.note.revision,
            }),
        );
        Ok(created)
    })
    .await
}

#[tauri::command]
pub async fn notepad_save_content(
    window: WebviewWindow,
    id: String,
    content: String,
) -> Result<NotepadSaveResponse> {
    crate::state::blocking(window, move |window, state: &AppState| {
        let saved = state
            .notepad
            .save_content(&state.data_dir, &id, content.clone())?;
        emit_change(
            &window,
            &saved.snapshot,
            Some(NotepadNoteContent {
                id,
                content,
                revision: saved.note_revision,
            }),
        );
        Ok(saved)
    })
    .await
}

#[tauri::command]
pub async fn notepad_update_meta(
    window: WebviewWindow,
    id: String,
    title: Option<String>,
    format: Option<String>,
    pinned: Option<bool>,
) -> Result<NotepadSnapshot> {
    crate::state::blocking(window, move |window, state: &AppState| {
        let snapshot = state
            .notepad
            .update_meta(&state.data_dir, &id, title, format, pinned)?;
        emit_change(&window, &snapshot, None);
        Ok(snapshot)
    })
    .await
}

#[tauri::command]
pub async fn notepad_delete(window: WebviewWindow, id: String) -> Result<NotepadSnapshot> {
    crate::state::blocking(window, move |window, state: &AppState| {
        let snapshot = state.notepad.delete_note(&state.data_dir, &id)?;
        emit_change(&window, &snapshot, None);
        Ok(snapshot)
    })
    .await
}

#[tauri::command]
pub async fn notepad_set_tabs(
    window: WebviewWindow,
    open_tabs: Vec<String>,
    active_id: Option<String>,
) -> Result<NotepadSnapshot> {
    crate::state::blocking(window, move |_window, state: &AppState| {
        state
            .notepad
            .set_tabs(&state.data_dir, open_tabs, active_id)
    })
    .await
}

#[tauri::command]
pub async fn notepad_reorder(
    window: WebviewWindow,
    note_ids: Vec<String>,
    open_tabs: Option<Vec<String>>,
) -> Result<NotepadSnapshot> {
    crate::state::blocking(window, move |window, state: &AppState| {
        let snapshot = state
            .notepad
            .reorder_notes(&state.data_dir, note_ids, open_tabs)?;
        emit_change(&window, &snapshot, None);
        Ok(snapshot)
    })
    .await
}

#[tauri::command]
pub async fn notepad_set_sort(
    window: WebviewWindow,
    sort: String,
    open_tabs: Option<Vec<String>>,
) -> Result<NotepadSnapshot> {
    crate::state::blocking(window, move |window, state: &AppState| {
        let snapshot = state
            .notepad
            .set_sort(&state.data_dir, sort, open_tabs)?;
        emit_change(&window, &snapshot, None);
        Ok(snapshot)
    })
    .await
}

#[tauri::command]
pub async fn notepad_import_file(window: WebviewWindow) -> Result<Option<NotepadCreateResponse>> {
    let app = window.app_handle().clone();
    let picker_window = window.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&picker_window)
            .blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::new("dialog", e.to_string()))?;
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| AppError::new("path", e.to_string()))?;
    crate::state::blocking(window, move |window, state: &AppState| {
        let disk = files::read(&path, true, None)?;
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Imported Note");
        let (title, format) = if file_name.starts_with(".env") {
            (file_name.to_string(), "env".to_string())
        } else {
            let ext = path.extension().and_then(|s| s.to_str());
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(file_name);
            (stem.to_string(), normalize_format(ext))
        };
        let created = state.notepad.create_note(
            &state.data_dir,
            Some(title),
            Some(format),
            Some(disk.text),
        )?;
        emit_change(
            &window,
            &created.snapshot,
            Some(NotepadNoteContent {
                id: created.note.id.clone(),
                content: created.content.clone(),
                revision: created.note.revision,
            }),
        );
        Ok(Some(created))
    })
    .await
}

#[tauri::command]
pub async fn notepad_export_file(window: WebviewWindow, id: String) -> Result<Option<String>> {
    let (default_name, content) =
        crate::state::blocking(window.clone(), move |_window, state: &AppState| {
            let note_content = state.notepad.read_note(&state.data_dir, &id)?;
            let loaded = state.notepad.load(&state.data_dir)?;
            let meta = loaded
                .snapshot
                .notes
                .into_iter()
                .find(|n| n.id == id)
                .ok_or_else(|| AppError::new("notFound", "Note was not found."))?;
            Ok((
                sanitize_export_filename(&meta.title, &meta.format),
                note_content.content,
            ))
        })
        .await?;
    let app = window.app_handle().clone();
    let picker_window = window.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&picker_window)
            .set_file_name(&default_name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| AppError::new("dialog", e.to_string()))?;
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| AppError::new("path", e.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || -> Result<String> {
        files::atomic_write(&path, content.as_bytes())?;
        Ok(crate::tools::process_path(&path)
            .to_string_lossy()
            .into_owned())
    })
    .await
    .map_err(|e| AppError::new("task", e.to_string()))?
    .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notepad_initializes_default_txt_note_and_persists_globally() {
        let dir = tempfile::tempdir().unwrap();
        let service = Service::default();
        let loaded = service.load(dir.path()).unwrap();
        assert_eq!(loaded.snapshot.notes.len(), 1);
        let first = &loaded.snapshot.notes[0];
        assert_eq!(first.title, "Note 1");
        assert_eq!(first.format, "txt");
        assert_eq!(
            loaded.snapshot.active_id.as_deref(),
            Some(first.id.as_str())
        );
        assert_eq!(loaded.contents.get(&first.id).map(String::as_str), Some(""));

        let saved = service
            .save_content(dir.path(), &first.id, "  Hello world  \nSecond line".into())
            .unwrap();
        assert_eq!(saved.note_revision, 2);
        assert_eq!(saved.snapshot.notes[0].preview, "Hello world");

        // Fresh service instance simulates restart or another process reading global storage.
        let reloaded = Service::default().load(dir.path()).unwrap();
        assert_eq!(reloaded.snapshot.notes.len(), 1);
        assert_eq!(
            reloaded.contents.get(&first.id).map(String::as_str),
            Some("  Hello world  \nSecond line")
        );
    }

    #[test]
    fn notepad_crud_format_normalization_and_id_validation() {
        let dir = tempfile::tempdir().unwrap();
        let service = Service::default();
        let first = service.load(dir.path()).unwrap().snapshot.notes[0].clone();

        let created = service
            .create_note(
                dir.path(),
                None,
                Some(".markdown".into()),
                Some("# Title\nBody".into()),
            )
            .unwrap();
        assert_eq!(created.note.title, "Note 2");
        assert_eq!(created.note.format, "md");
        assert_eq!(created.note.preview, "# Title");

        let updated = service
            .update_meta(
                dir.path(),
                &created.note.id,
                Some("API Payload".into()),
                Some("JSON".into()),
                Some(true),
            )
            .unwrap();
        let meta = updated
            .notes
            .iter()
            .find(|n| n.id == created.note.id)
            .unwrap();
        assert_eq!(meta.title, "API Payload");
        assert_eq!(meta.format, "json");
        assert!(meta.pinned);

        assert!(service.read_note(dir.path(), "../escape").is_err());
        assert!(
            service
                .save_content(dir.path(), "bad/id", "x".into())
                .is_err()
        );

        let after_delete = service.delete_note(dir.path(), &created.note.id).unwrap();
        assert_eq!(after_delete.notes.len(), 1);
        assert_eq!(after_delete.active_id.as_deref(), Some(first.id.as_str()));
        assert!(!note_file_path(dir.path(), &created.note.id).exists());
    }

    #[test]
    fn notepad_reorders_notes_persists_sort_and_syncs_open_tabs() {
        let dir = tempfile::tempdir().unwrap();
        let service = Service::default();
        let first = service.load(dir.path()).unwrap().snapshot.notes[0].clone();
        let second = service
            .create_note(dir.path(), Some("Second".into()), None, None)
            .unwrap()
            .note;
        let third = service
            .create_note(dir.path(), Some("Third".into()), None, None)
            .unwrap()
            .note;

        let reordered = service
            .reorder_notes(
                dir.path(),
                vec![first.id.clone(), third.id.clone()],
                Some(vec![third.id.clone(), first.id.clone()]),
            )
            .unwrap();
        let ids: Vec<&str> = reordered.notes.iter().map(|n| n.id.as_str()).collect();
        // Unlisted note (second) is preserved at the end rather than dropped.
        assert_eq!(
            ids,
            vec![first.id.as_str(), third.id.as_str(), second.id.as_str()]
        );
        assert_eq!(reordered.sort, "manual");
        assert_eq!(
            reordered.open_tabs,
            vec![first.id.clone(), third.id.clone()]
        );

        let reloaded = Service::default().load(dir.path()).unwrap().snapshot;
        let reloaded_ids: Vec<&str> = reloaded.notes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(reloaded_ids, ids);
        assert_eq!(reloaded.sort, "manual");
        assert_eq!(reloaded.open_tabs, vec![first.id.clone(), third.id.clone()]);

        let sorted = service
            .set_sort(
                dir.path(),
                "title".into(),
                Some(vec![first.id.clone(), second.id.clone(), third.id.clone()]),
            )
            .unwrap();
        assert_eq!(sorted.sort, "title");
        assert_eq!(Service::default().load(dir.path()).unwrap().snapshot.sort, "title");
    }
}
