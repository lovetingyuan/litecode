use super::*;
use crate::state::WindowState;

fn state() -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState {
        data_dir: dir.path().into(),
        ..Default::default()
    };
    state
        .windows
        .lock_recover()
        .insert("main".into(), WindowState::default());
    (dir, state)
}

fn doc(id: &str, text: Option<&str>, version: u64) -> DocumentSnapshot {
    serde_json::from_value(serde_json::json!({
        "id": id, "path": null, "text": text, "version": version,
        "revision": null, "encoding": "utf8", "dirty": true,
    }))
    .unwrap()
}

fn manifest(state: &AppState) -> serde_json::Value {
    serde_json::from_slice(&fs::read(state.data_dir.join("session-main.json")).unwrap()).unwrap()
}

fn body_file(state: &AppState, id: &str) -> PathBuf {
    let value = manifest(state);
    let hash = value["documents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == id)
        .unwrap()["body"]
        .as_str()
        .unwrap();
    directory(state, "main")
        .unwrap()
        .join(format!("{hash}.txt"))
}

#[test]
fn metadata_only_sync_reuses_bodies_and_the_unchanged_manifest() {
    let (_dir, state) = state();
    state
        .sync_documents(
            "main",
            vec![doc("one", Some("one"), 1), doc("two", Some("two"), 1)],
            serde_json::json!({}),
        )
        .unwrap();
    let file = body_file(&state, "two");
    let stamp = fs::metadata(&file).unwrap().modified().unwrap();
    let clean = doc("two", None, 1);
    state
        .sync_documents(
            "main",
            vec![doc("one", Some("edited"), 2), clean.clone()],
            serde_json::json!({}),
        )
        .unwrap();
    assert_eq!(fs::metadata(file).unwrap().modified().unwrap(), stamp);
    let value = manifest(&state);
    assert_eq!(value["version"], 2);
    assert!(
        value["documents"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["text"].is_null())
    );
    let manifest_path = state.data_dir.join("session-main.json");
    let stamp = fs::metadata(&manifest_path).unwrap().modified().unwrap();
    state
        .sync_documents(
            "main",
            vec![doc("one", None, 2), clean],
            serde_json::json!({}),
        )
        .unwrap();
    assert_eq!(
        fs::metadata(manifest_path).unwrap().modified().unwrap(),
        stamp
    );
    assert_eq!(
        state.windows.lock_recover()["main"].documents["two"].text,
        "two"
    );
}

#[test]
fn first_checkpoint_after_restore_reuses_an_identical_manifest() {
    let (_dir, state) = state();
    state
        .sync_documents(
            "main",
            vec![doc("one", Some("recover"), 1)],
            serde_json::json!({}),
        )
        .unwrap();
    let file = state.data_dir.join("session-main.json");
    let stamp = fs::metadata(&file).unwrap().modified().unwrap();
    let loaded = load(&state, "main", &mut vec![]);
    state.windows.lock_recover().insert(
        "main".into(),
        WindowState {
            documents: loaded
                .documents
                .into_iter()
                .map(|doc| (doc.id.clone(), doc))
                .collect(),
            session: loaded.session,
            ..Default::default()
        },
    );
    state.checkpoint("main").unwrap();
    assert_eq!(fs::metadata(file).unwrap().modified().unwrap(), stamp);
}

#[test]
fn empty_bodies_and_invalid_reuse_are_distinct_and_validation_is_atomic() {
    let mut omitted = serde_json::to_value(doc("omitted", None, 1)).unwrap();
    omitted.as_object_mut().unwrap().remove("text");
    assert!(
        serde_json::from_value::<DocumentSnapshot>(omitted.clone())
            .unwrap()
            .text
            .is_none()
    );
    assert!(serde_json::from_value::<Mirror>(omitted).is_err());
    let (_dir, state) = state();
    state
        .sync_documents(
            "main",
            vec![doc("one", Some("original"), 1)],
            serde_json::json!({}),
        )
        .unwrap();
    assert!(
        state
            .sync_documents(
                "main",
                vec![doc("one", Some("changed"), 2), doc("missing", None, 1)],
                serde_json::json!({})
            )
            .is_err()
    );
    assert_eq!(
        state.windows.lock_recover()["main"].documents["one"].text,
        "original"
    );
    assert!(
        state
            .sync_documents("main", vec![doc("one", None, 2)], serde_json::json!({}))
            .is_err()
    );
    state
        .sync_documents("main", vec![doc("one", Some(""), 2)], serde_json::json!({}))
        .unwrap();
    assert_eq!(load(&state, "main", &mut vec![]).documents[0].text, "");
    state
        .sync_documents("main", vec![doc("one", None, 1)], serde_json::json!({}))
        .unwrap();
    assert_eq!(load(&state, "main", &mut vec![]).documents[0].text, "");
}

#[test]
fn final_checkpoint_does_not_wait_for_the_disk_gate() {
    use crate::sync::RwLockExt;
    let (_dir, state) = state();
    let state = std::sync::Arc::new(state);
    let gate = state.disk_lock.write_recover();
    let (sender, receiver) = std::sync::mpsc::channel();
    let worker = state.clone();
    let job = std::thread::spawn(move || sender.send(worker.checkpoint("main")).unwrap());
    let result = receiver.recv_timeout(std::time::Duration::from_secs(5));
    drop(gate);
    job.join().unwrap();
    result.unwrap().unwrap();
}

#[test]
fn clean_files_are_metadata_only_and_reopened_from_current_disk() {
    let (dir, state) = state();
    let file = dir.path().join("clean.txt");
    fs::write(&file, "before").unwrap();
    state.grant("main", &file).unwrap();
    let mut clean = doc("clean", Some("before"), 1);
    clean.path = Some(file.to_string_lossy().into_owned());
    clean.dirty = false;
    state
        .sync_documents("main", vec![clean.clone()], serde_json::json!({}))
        .unwrap();
    assert!(manifest(&state)["documents"][0]["body"].is_null());
    assert!(!directory(&state, "main").unwrap().exists());
    fs::write(&file, "external changes").unwrap();
    assert_eq!(
        load(&state, "main", &mut vec![]).documents[0].text,
        "external changes"
    );
    let mut changed_encoding = clean.clone();
    changed_encoding.text = None;
    changed_encoding.encoding = "gbk".into();
    changed_encoding.dirty = true;
    state
        .sync_documents("main", vec![changed_encoding], serde_json::json!({}))
        .unwrap();
    assert_eq!(
        load(&state, "main", &mut vec![]).documents[0].text,
        "before"
    );
    clean.text = None;
    state
        .sync_documents("main", vec![clean], serde_json::json!({}))
        .unwrap();
    fs::remove_file(file).unwrap();
    let mut warnings = vec![];
    assert!(load(&state, "main", &mut warnings).documents.is_empty());
    assert!(!warnings.is_empty());
}

#[test]
fn successful_save_and_close_remove_obsolete_bodies_after_commit() {
    let (dir, state) = state();
    state
        .sync_documents(
            "main",
            vec![doc("one", Some("unsaved"), 1)],
            serde_json::json!({}),
        )
        .unwrap();
    let old = body_file(&state, "one");
    let file = dir.path().join("saved.txt");
    fs::write(&file, "unsaved").unwrap();
    state.grant("main", &file).unwrap();
    let mut saved = doc("one", None, 1);
    saved.dirty = false;
    saved.path = Some(file.to_string_lossy().into_owned());
    state
        .sync_documents(
            "main",
            vec![saved, doc("untitled", Some(""), 1)],
            serde_json::json!({}),
        )
        .unwrap();
    assert!(!old.exists());
    let untitled = body_file(&state, "untitled");
    state
        .sync_documents("main", vec![], serde_json::json!({}))
        .unwrap();
    assert!(!untitled.exists());
}

#[test]
fn failed_manifest_commit_preserves_previous_bodies_and_allows_retry() {
    let (_dir, state) = state();
    state
        .sync_documents(
            "main",
            vec![doc("one", Some("original"), 1)],
            serde_json::json!({}),
        )
        .unwrap();
    let original = body_file(&state, "one");
    let path = state.data_dir.join("session-main.json");
    let old_manifest = fs::read(&path).unwrap();
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(
        state
            .sync_documents(
                "main",
                vec![doc("one", Some("latest"), 2)],
                serde_json::json!({})
            )
            .is_err()
    );
    assert!(original.exists());
    fs::remove_dir(&path).unwrap();
    fs::write(&path, old_manifest).unwrap();
    assert_eq!(
        load(&state, "main", &mut vec![]).documents[0].text,
        "original"
    );
    state
        .sync_documents(
            "main",
            vec![doc("one", Some("latest"), 2)],
            serde_json::json!({}),
        )
        .unwrap();
    assert_eq!(
        load(&state, "main", &mut vec![]).documents[0].text,
        "latest"
    );
    assert!(!original.exists());
}

#[test]
fn failed_body_write_does_not_replace_the_manifest() {
    let (_dir, state) = state();
    state
        .sync_documents(
            "main",
            vec![doc("one", Some("original"), 1)],
            serde_json::json!({}),
        )
        .unwrap();
    let before = manifest(&state);
    let file = directory(&state, "main")
        .unwrap()
        .join(format!("{}.txt", files::hash(b"latest")));
    fs::create_dir(&file).unwrap();
    assert!(
        state
            .sync_documents(
                "main",
                vec![doc("one", Some("latest"), 2)],
                serde_json::json!({})
            )
            .is_err()
    );
    assert_eq!(manifest(&state), before);
    assert_eq!(
        load(&state, "main", &mut vec![]).documents[0].text,
        "original"
    );
}

#[test]
fn legacy_recovery_migrates_only_after_a_successful_checkpoint() {
    let (_dir, state) = state();
    let value = serde_json::json!({ "root": null, "documents": [doc("one", Some("legacy text"), 1)], "session": {"sidebar": "git"} });
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::write(state.data_dir.join("session-main.json"), &bytes).unwrap();
    let loaded = load(&state, "main", &mut vec![]);
    assert_eq!(loaded.documents[0].text, "legacy text");
    assert_eq!(
        fs::read(state.data_dir.join("session-main.json")).unwrap(),
        bytes
    );
    state
        .sync_documents(
            "main",
            vec![doc("one", Some("legacy text"), 1)],
            loaded.session,
        )
        .unwrap();
    assert_eq!(manifest(&state)["version"], 2);
    assert_eq!(
        load(&state, "main", &mut vec![]).documents[0].text,
        "legacy text"
    );
}

#[test]
fn corrupt_body_preserves_the_manifest_and_survives_later_cleanup() {
    let (_dir, state) = state();
    state
        .sync_documents(
            "main",
            vec![doc("one", Some("important"), 1)],
            serde_json::json!({}),
        )
        .unwrap();
    let file = body_file(&state, "one");
    fs::write(&file, "damaged").unwrap();
    let mut warnings = vec![];
    let loaded = load(&state, "main", &mut warnings);
    assert!(loaded.documents.is_empty());
    assert!(loaded.preserve_files);
    assert!(!warnings.is_empty());
    state
        .windows
        .lock_recover()
        .get_mut("main")
        .unwrap()
        .backup
        .preserve_files = loaded.preserve_files;
    state
        .sync_documents("main", vec![], serde_json::json!({}))
        .unwrap();
    assert!(file.exists());
    assert!(
        fs::read_dir(directory(&state, "main").unwrap())
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with("preserved-"))
    );
    assert!(load(&state, "main", &mut vec![]).preserve_files);
}

#[test]
fn corrupt_metadata_and_null_manifests_preserve_all_existing_bodies() {
    for null_manifest in [false, true] {
        let (_dir, state) = state();
        state
            .sync_documents(
                "main",
                vec![doc("one", Some("important"), 1)],
                serde_json::json!({}),
            )
            .unwrap();
        let body = body_file(&state, "one");
        let mut value = manifest(&state);
        if null_manifest {
            value = serde_json::Value::Null;
        } else {
            value["documents"][0]
                .as_object_mut()
                .unwrap()
                .remove("dirty");
        }
        fs::write(
            state.data_dir.join("session-main.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        let mut warnings = vec![];
        let loaded = load(&state, "main", &mut warnings);
        assert!(loaded.documents.is_empty());
        assert!(loaded.preserve_files);
        assert!(!warnings.is_empty());
        state
            .windows
            .lock_recover()
            .get_mut("main")
            .unwrap()
            .backup
            .preserve_files = loaded.preserve_files;
        state
            .sync_documents("main", vec![], serde_json::json!({}))
            .unwrap();
        assert_eq!(fs::read_to_string(body).unwrap(), "important");
    }
}

#[test]
fn body_reference_cannot_escape_the_window_directory() {
    let (_dir, state) = state();
    let record = serde_json::json!({"id":"one", "path": null, "version":1, "revision":null,
        "encoding":"utf8", "dirty":true, "body":"../../outside"});
    fs::write(
        state.data_dir.join("session-main.json"),
        serde_json::to_vec(&serde_json::json!({
            "version":2, "documents":[record], "session":{}
        }))
        .unwrap(),
    )
    .unwrap();
    let loaded = load(&state, "main", &mut vec![]);
    assert!(loaded.documents.is_empty());
    assert!(loaded.preserve_files);
}
