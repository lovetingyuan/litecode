use super::*;
use crate::sync::MutexExt;

fn edit(path: &Path, before: &str, encoding: &str) -> DiskEdit {
    let bytes = files::encode(before, encoding).unwrap();
    fs::write(path, &bytes).unwrap();
    DiskEdit {
        path: path.to_string_lossy().into_owned(),
        before: before.into(),
        after: "新内容\n".into(),
        encoding: encoding.into(),
        revision: files::hash(&bytes),
    }
}
#[test]
fn interruptions_before_and_after_writes_and_progress_are_idempotent() {
    for stage in [
        Stage::BeforeWrite,
        Stage::AfterWrite,
        Stage::BeforeProgress,
        Stage::AfterProgress,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("中文.txt");
        let b = dir.path().join("b.txt");
        let mut journal = create_journal(
            "main",
            None,
            vec![edit(&a, "a\r\nb\nc\n", "utf8"), edit(&b, "before", "utf8")],
            vec![],
        )
        .unwrap();
        let path = dir.path().join("journal.json");
        persist(&path, &journal).unwrap();
        assert!(
            execute_with(&path, &mut journal, |s, i| if s == stage && i == 0 {
                Err(AppError::new("test", "power loss"))
            } else {
                Ok(())
            })
            .is_err()
        );
        let mut reopened = load(&path).unwrap();
        assert!(reopened.pending.is_some());
        assert!(execute(&path, &mut reopened).unwrap().complete);
        assert_eq!(fs::read(&a).unwrap(), "新内容\n".as_bytes());
        assert_eq!(fs::read(&b).unwrap(), "新内容\n".as_bytes());
        assert!(execute(&path, &mut reopened).unwrap().succeeded.is_empty());
        reopened.pending = None;
        persist(&path, &reopened).unwrap();
        for redo in [false, true, false] {
            begin_replay(&path, &mut reopened, redo).unwrap();
            assert!(execute(&path, &mut reopened).unwrap().complete);
            reopened.pending = None;
            persist(&path, &reopened).unwrap();
            assert_eq!(
                fs::read(&a).unwrap(),
                if redo {
                    "新内容\n".as_bytes()
                } else {
                    b"a\r\nb\nc\n"
                }
            );
        }
    }
}
#[test]
fn group_preflight_preserves_all_files_and_partial_undo_can_retry() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    let mut journal = create_journal(
        "main",
        None,
        vec![edit(&a, "old", "utf8"), edit(&b, "old", "utf8")],
        vec![],
    )
    .unwrap();
    let path = dir.path().join("journal.json");
    persist(&path, &journal).unwrap();
    fs::write(&b, "external").unwrap();
    assert!(!execute(&path, &mut journal).unwrap().complete);
    assert_eq!(fs::read(&a).unwrap(), b"old");
    fs::write(&b, "old").unwrap();
    assert!(execute(&path, &mut journal).unwrap().complete);
    journal.pending = None;
    begin_replay(&path, &mut journal, false).unwrap();
    assert!(
        execute_with(&path, &mut journal, |s, i| {
            if s == Stage::BeforeWrite && i == 1 {
                Err(AppError::new("test", "disk full"))
            } else {
                Ok(())
            }
        })
        .is_err()
    );
    let mut reopened = load(&path).unwrap();
    assert!(begin_replay(&path, &mut reopened, true).is_err());
    assert!(execute(&path, &mut reopened).unwrap().complete);
    assert_eq!(fs::read(&a).unwrap(), b"old");
    assert_eq!(fs::read(&b).unwrap(), b"old");
}
#[test]
fn external_edits_after_group_preflight_are_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    let mut journal = create_journal(
        "main",
        None,
        vec![edit(&a, "old", "utf8"), edit(&b, "old", "utf8")],
        vec![],
    )
    .unwrap();
    let path = dir.path().join("journal.json");
    persist(&path, &journal).unwrap();
    let report = execute_with(&path, &mut journal, |s, i| {
        if s == Stage::AfterProgress && i == 0 {
            fs::write(&b, "external")?;
        }
        Ok(())
    })
    .unwrap();
    assert!(!report.complete);
    assert_eq!(report.remaining, vec![b.to_string_lossy()]);
    assert_eq!(fs::read(&b).unwrap(), b"external");
    assert!(load(&path).unwrap().pending.is_some());
}
#[test]
fn interrupted_rollback_preserves_encodings_boms_and_mixed_line_endings() {
    for encoding in ["utf8", "utf8bom", "utf16le", "utf16be", "gbk"] {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("中文.txt");
        let e = edit(&a, "中文\r\n混合\n", encoding);
        let original = fs::read(&a).unwrap();
        let mut journal = create_journal("main", None, vec![e], vec![]).unwrap();
        let path = dir.path().join("log.json");
        persist(&path, &journal).unwrap();
        assert!(
            execute_with(&path, &mut journal, |s, _| if s == Stage::AfterWrite {
                Err(AppError::new("test", "crash"))
            } else {
                Ok(())
            })
            .is_err()
        );
        let mut reopened = load(&path).unwrap();
        reopened.pending.as_mut().unwrap().rollback = true;
        persist(&path, &reopened).unwrap();
        assert!(execute(&path, &mut reopened).unwrap().complete);
        assert_eq!(fs::read(&a).unwrap(), original);
    }
}
#[test]
fn snapshots_keep_noncanonical_original_encoding_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("no-bom.txt");
    let bytes: Vec<u8> = "旧内容\r\n"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    fs::write(&a, &bytes).unwrap();
    let e = DiskEdit {
        path: a.to_string_lossy().into_owned(),
        before: "旧内容\r\n".into(),
        after: "new".into(),
        encoding: "utf16le".into(),
        revision: files::hash(&bytes),
    };
    let mut journal = create_journal("main", None, vec![e], vec![]).unwrap();
    let path = dir.path().join("log.json");
    persist(&path, &journal).unwrap();
    assert!(execute(&path, &mut journal).unwrap().complete);
    journal.pending.as_mut().unwrap().rollback = true;
    persist(&path, &journal).unwrap();
    assert!(execute(&path, &mut journal).unwrap().complete);
    assert_eq!(fs::read(&a).unwrap(), bytes);
}
#[test]
fn pending_logs_reopen_clean_secondary_windows_and_legacy_backups_are_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState {
        data_dir: dir.path().join("data"),
        ..Default::default()
    };
    let a = dir.path().join("a");
    let journal = create_journal(
        "editor-project",
        Some(dir.path().into()),
        vec![edit(&a, "old", "utf8")],
        vec![],
    )
    .unwrap();
    let path = journal_path(&state, "editor-project", "abc-123").unwrap();
    persist(&path, &journal).unwrap();
    assert_eq!(pending_windows(&state).unwrap()[0].0, "editor-project");
    let mut legacy: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for key in ["version", "pending", "owner", "root", "buffers"] {
        legacy.as_object_mut().unwrap().remove(key);
    }
    let original = serde_json::to_vec(&legacy).unwrap();
    fs::write(&path, &original).unwrap();
    fs::write(&a, "新内容\n").unwrap();
    assert_eq!(logs(&state, "editor-project").unwrap().len(), 1);
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(journal_path(&state, "../escape", "abc").is_err());
    assert!(journal_path(&state, "main", "../escape").is_err());
}
#[test]
fn recovery_checks_owner_root_and_buffers_without_losing_unsaved_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState {
        data_dir: dir.path().join("data"),
        ..Default::default()
    };
    let buffer: Mirror = serde_json::from_value(serde_json::json!({"id":"untitled:one","path":null,"text":"unsaved before","version":7,"revision":null,"encoding":"utf8","dirty":true,"name":"Untitled"})).unwrap();
    let journal = create_journal(
        "editor-project",
        Some(canonical(dir.path()).unwrap()),
        vec![],
        vec![BufferEdit {
            before: buffer,
            after: "unsaved after".into(),
        }],
    )
    .unwrap();
    let path = journal_path(&state, "editor-project", "abc-123").unwrap();
    persist(&path, &journal).unwrap();
    let mut window = WindowState {
        root: journal.root.clone(),
        ..Default::default()
    };
    restore_buffers(&state, "editor-project", &mut window).unwrap();
    assert_eq!(window.documents["untitled:one"].text, "unsaved before");
    assert!(window.documents["untitled:one"].dirty);
    state
        .windows
        .lock_recover()
        .insert("editor-project".into(), window);
    assert!(authorize(&state, "main", &journal, true).is_err());
    assert!(authorize(&state, "editor-project", &journal, true).is_ok());
    assert!(check_buffers(&state, "editor-project", &journal, false).is_ok());
    assert!(check_buffers(&state, "editor-project", &journal, true).is_err());
    state
        .windows
        .lock_recover()
        .get_mut("editor-project")
        .unwrap()
        .documents
        .get_mut("untitled:one")
        .unwrap()
        .text = "later unsaved changes".into();
    assert!(check_buffers(&state, "editor-project", &journal, false).is_err());
    assert_eq!(
        load(&path).unwrap().buffers[0].before.text,
        "unsaved before"
    );
    state
        .windows
        .lock_recover()
        .get_mut("editor-project")
        .unwrap()
        .root = None;
    assert!(authorize(&state, "editor-project", &journal, false).is_ok());
    assert!(authorize(&state, "editor-project", &journal, true).is_err());
}

#[test]
fn legacy_mixed_progress_infers_undo_and_redo_from_the_unacknowledged_write() {
    for redo in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        let mut journal = create_journal(
            "main",
            None,
            vec![edit(&a, "old", "utf8"), edit(&b, "old", "utf8")],
            vec![],
        )
        .unwrap();
        for e in &mut journal.entries {
            e.applied = true;
            e.undone = redo;
        }
        // The first entry's progress is durable; the second write lost its ACK.
        journal.entries[0].undone = !redo;
        for file in [&a, &b] {
            fs::write(file, if redo { "新内容\n" } else { "old" }).unwrap();
        }
        journal.version = 0;
        journal.owner.clear();
        journal.pending = None;
        upgrade_legacy(&mut journal, "main", None);
        assert_eq!(
            journal.pending.unwrap().direction,
            if redo {
                Direction::Redo
            } else {
                Direction::Undo
            }
        );
        journal.pending.as_mut().unwrap().rollback = true;
        let path = dir.path().join("legacy.json");
        persist(&path, &journal).unwrap();
        assert!(execute(&path, &mut journal).unwrap().complete);
        assert_eq!(
            fs::read(&a).unwrap(),
            if redo {
                b"old".as_slice()
            } else {
                "新内容\n".as_bytes()
            }
        );
        assert_eq!(fs::read(&a).unwrap(), fs::read(&b).unwrap());
    }
}

#[test]
fn a_missing_buffer_parent_does_not_prevent_journaling_or_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let root = canonical(dir.path()).unwrap();
    let missing = dir.path().join("removed/parent/中文.txt");
    let mirror: Mirror = serde_json::from_value(serde_json::json!({
        "id":"missing","path":missing,"text":"unsaved original","version":1,
        "revision":null,"encoding":"utf8","dirty":true
    }))
    .unwrap();
    let journal = create_journal(
        "main",
        Some(root.clone()),
        vec![],
        vec![BufferEdit {
            before: mirror,
            after: "changed".into(),
        }],
    )
    .unwrap();
    let state = AppState {
        data_dir: dir.path().join("data"),
        ..Default::default()
    };
    let path = journal_path(&state, "main", "abc").unwrap();
    persist(&path, &journal).unwrap();
    let mut window = WindowState {
        root: Some(root),
        ..Default::default()
    };
    restore_buffers(&state, "main", &mut window).unwrap();
    state.windows.lock_recover().insert("main".into(), window);
    assert!(authorize(&state, "main", &journal, true).is_ok());
    assert_eq!(
        load(&path).unwrap().buffers[0].before.text,
        "unsaved original"
    );
    assert!(!missing.exists());
}
