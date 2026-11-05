use super::*;
use serde_json::{Value, json};
use std::{fs, sync::Mutex};

fn query(include: &str) -> Query {
    Query {
        text: "needle".into(),
        case_sensitive: true,
        whole_word: false,
        regex: false,
        include: include.into(),
        exclude: String::new(),
        use_ignore: true,
        open_only: false,
        changed_only: false,
        follow_symlinks: false,
        encoding: None,
        context: 0,
    }
}

fn fixture(files: &[(&str, &str)]) -> tempfile::TempDir {
    let temp = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmp");
    fs::create_dir_all(&temp).unwrap();
    let directory = tempfile::tempdir_in(temp).unwrap();
    for (path, text) in files {
        let path = directory.path().join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    directory
}

fn mirror(root: &Path, path: &str, text: &str) -> Mirror {
    serde_json::from_value(json!({
        "id": path, "path": root.join(path), "text": text, "version": 7,
        "revision": null, "encoding": "utf-8", "dirty": true
    }))
    .unwrap()
}

async fn search(
    root: &Path,
    query: &Query,
    settings: &Value,
    documents: &[Mirror],
    cancel_after: Option<usize>,
) -> Result<(Vec<SearchMatch>, SearchBatch)> {
    let task = Arc::new(SearchTask {
        cancelled: AtomicBool::new(cancel_after == Some(0)),
        acknowledged: AtomicU64::new(1_000_000),
    });
    let received = Arc::new(Mutex::new(vec![]));
    let output = received.clone();
    let cancellation = task.clone();
    let channel = Channel::new(move |message| {
        let data = message.deserialize::<Value>().unwrap();
        output
            .lock()
            .unwrap()
            .extend(serde_json::from_value::<Vec<SearchMatch>>(data["matches"].clone()).unwrap());
        if cancel_after.is_some_and(|limit| output.lock().unwrap().len() >= limit) {
            cancellation.cancelled.store(true, Ordering::Release);
        }
        Ok(())
    });
    let mut batch = SearchBatch {
        request_id: "scope".into(),
        sequence: 1,
        matches: vec![],
        done: false,
        limited: false,
        cancelled: false,
        errors: vec![],
    };
    let rg = if cfg!(windows) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/rg.exe")
    } else {
        PathBuf::from("rg")
    };
    SearchRun {
        rg: &rg,
        query,
        task: &task,
        channel: &channel,
        batch: &mut batch,
        count: 0,
    }
    .search(Some(root), documents, settings, None)
    .await?;
    let mut matches = received.lock().unwrap().clone();
    matches.append(&mut batch.matches);
    matches.sort_by(|a, b| a.path.cmp(&b.path));
    Ok((matches, batch))
}

fn names(root: &Path, matches: &[SearchMatch]) -> Vec<String> {
    matches
        .iter()
        .map(|m| paths::relative(Path::new(&m.path), root).unwrap())
        .collect()
}

#[tokio::test]
async fn excludes_and_nested_ignores_win_for_disk_and_dirty_open_files() {
    let directory = fixture(&[
        (".gitignore", "*.log\n!keep.log\n"),
        ("src/.gitignore", "!nested.log\n"),
        (".ignore", "cache/\n"),
        ("cache/a.ts", "needle"),
        ("drop.log", "needle"),
        ("keep.log", "needle"),
        ("src/drop.log", "needle"),
        ("src/nested.log", "needle"),
        ("node_modules/a.ts", "needle"),
        ("src/a.ts", "needle on disk"),
        ("src/a.js", "needle"),
        ("src/only.js", "needle"),
        ("generated/a.ts", "needle"),
        ("disabled/a.ts", "needle"),
    ]);
    let root = directory.path();
    let documents = [
        mirror(root, "drop.log", "needle dirty ignored"),
        mirror(root, "node_modules/a.ts", "needle dependency"),
        mirror(root, "src/a.js", "needle compiled"),
        mirror(root, "generated/a.ts", "needle generated"),
        mirror(root, "src/a.ts", "needle from buffer"),
    ];
    let mut settings = crate::configuration::defaults();
    settings["files.exclude"]["**/*.js"] = json!({"when": "$(basename).ts"});
    settings["files.exclude"]["disabled"] = true.into();
    settings["search.exclude"]["disabled"] = false.into();
    settings["search.exclude"]["generated"] = true.into();
    let q = query("**/*.{ts,js,log}");
    let (matches, batch) = search(root, &q, &settings, &documents, None).await.unwrap();
    assert!(batch.errors.is_empty());
    assert_eq!(
        names(root, &matches),
        [
            "disabled/a.ts",
            "keep.log",
            "src/a.ts",
            "src/nested.log",
            "src/only.js"
        ]
    );
    let dirty = matches
        .iter()
        .find(|m| m.document_id.as_deref() == Some("src/a.ts"))
        .unwrap();
    assert_eq!(dirty.preview, "needle from buffer");
    assert_eq!(dirty.version, Some(7));

    let mut q = q;
    q.open_only = true;
    let (matches, _) = search(root, &q, &settings, &documents, None).await.unwrap();
    assert_eq!(names(root, &matches), ["src/a.ts"]);
    q.use_ignore = false;
    q.exclude = "generated, **/*.js".into();
    let (matches, _) = search(root, &q, &settings, &documents, None).await.unwrap();
    assert_eq!(
        names(root, &matches),
        ["drop.log", "node_modules/a.ts", "src/a.ts"]
    );
    q.open_only = false;
    let (matches, _) = search(root, &q, &settings, &documents, None).await.unwrap();
    assert!(names(root, &matches).contains(&"cache/a.ts".into()));
    assert!(!names(root, &matches).contains(&"generated/a.ts".into()));
}

#[tokio::test]
async fn directory_scopes_are_recursive_anchored_and_preserve_glob_lists() {
    let directory = fixture(&[
        ("src/a.ts", "needle"),
        ("src/nested/b.ts", "needle"),
        ("nested/src/c.ts", "needle"),
        ("src-other/a.ts", "needle"),
        ("src/[a],{b}/x.ts", "needle"),
        ("root.json", "needle"),
    ]);
    let root = directory.path();
    let settings = crate::configuration::defaults();
    let documents = [mirror(root, "src/nested/b.ts", "needle dirty")];
    for include in [
        "src",
        "src/",
        "./src",
        "./src/",
        ".\\src\\",
        &root.join("src").to_string_lossy(),
    ] {
        let (matches, _) = search(root, &query(include), &settings, &documents, None)
            .await
            .unwrap();
        let names = names(root, &matches);
        assert!(names.contains(&"src/a.ts".into()), "{include}");
        assert!(names.contains(&"src/nested/b.ts".into()), "{include}");
        assert!(!names.contains(&"src-other/a.ts".into()), "{include}");
        assert_eq!(
            names.contains(&"nested/src/c.ts".into()),
            include == "src" || include == "src/",
            "{include}"
        );
    }
    let q = query("./src/[[]a[]][,][{]b[}], *.json");
    let (matches, _) = search(root, &q, &settings, &documents, None).await.unwrap();
    assert_eq!(names(root, &matches), ["root.json", "src/[a],{b}/x.ts"]);
    let (matches, _) = search(root, &query("src/a.ts"), &settings, &documents, None)
        .await
        .unwrap();
    assert_eq!(names(root, &matches), ["src/a.ts"]);
    let mut q = query("src");
    q.exclude = "nested".into();
    let (matches, _) = search(root, &q, &settings, &documents, None).await.unwrap();
    assert_eq!(names(root, &matches), ["src/[a],{b}/x.ts", "src/a.ts"]);
}

#[tokio::test]
async fn file_batches_remain_complete_and_cancelled_or_failed_scans_do_not_search() {
    let directory = fixture(&[]);
    let root = directory.path();
    for i in 0..530 {
        fs::write(root.join(format!("中文 file {i:04}.txt")), "needle").unwrap();
    }
    let q = query("*.txt");
    let settings = crate::configuration::defaults();
    let (matches, batch) = search(root, &q, &settings, &[], None).await.unwrap();
    assert_eq!(matches.len(), 530);
    assert!(!batch.limited);
    assert!(batch.errors.is_empty());
    let (matches, _) = search(root, &q, &settings, &[], Some(0)).await.unwrap();
    assert!(matches.is_empty());
    let (matches, _) = search(root, &q, &settings, &[], Some(64)).await.unwrap();
    assert!(!matches.is_empty());
    assert!(matches.len() < 530);
    assert!(
        search(&root.join("missing"), &q, &settings, &[], None)
            .await
            .is_err()
    );
    let mut invalid = query("nonexistent");
    invalid.regex = true;
    invalid.text = "[".into();
    assert_eq!(
        search(root, &invalid, &settings, &[], None)
            .await
            .err()
            .unwrap()
            .code,
        "regex"
    );
    fs::write(root.join("dense.txt"), "needle\n".repeat(MAX_RESULTS + 1)).unwrap();
    let (matches, batch) = search(root, &q, &settings, &[], None).await.unwrap();
    assert_eq!(matches.len(), MAX_RESULTS);
    assert!(batch.limited);
}

#[test]
fn patterns_do_not_match_workspace_ancestors_and_windows_batches_are_bounded() {
    let root = Path::new("C:/src");
    let filter = PathFilter::new(&query("src"), &json!({})).unwrap();
    assert!(
        !filter
            .accepts(&root.join("other/a.ts"), Some(root))
            .unwrap()
    );
    let filter = PathFilter::new(&query("./src"), &json!({})).unwrap();
    assert!(
        !filter
            .accepts(&root.join("nested/src/a.ts"), Some(root))
            .unwrap()
    );
    let mut command = Command::new("rg");
    command.arg("needle");
    let mut batch = PathBatch::new(&command);
    let path = format!("./{}\".txt", "🙂 ".repeat(100));
    while batch.fits(&path) {
        batch.push(path.clone()).unwrap();
    }
    assert!(!batch.paths.is_empty());
    assert!(batch.paths.len() < 512);
    assert!(batch.push(path.clone()).is_err());
    batch.clear();
    assert!(batch.push(path).is_ok());
}
