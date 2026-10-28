use super::*;
use git2::{RepositoryInitOptions, Signature, Time};
use std::fs;

fn fixture() -> (tempfile::TempDir, Repository) {
    let dir = tempfile::tempdir().unwrap();
    let mut options = RepositoryInitOptions::new();
    options.initial_head("main");
    let repo = Repository::init_opts(dir.path(), &options).unwrap();
    repo.config()
        .unwrap()
        .set_bool("core.autocrlf", false)
        .unwrap();
    (dir, repo)
}

fn commit(repo: &Repository, path: &str, bytes: &[u8], author: &str, seconds: i64) -> Oid {
    fs::write(repo.workdir().unwrap().join(path), bytes).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(path)).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = Signature::new(author, "test@example.invalid", &Time::new(seconds, 0)).unwrap();
    let parent = repo.head().and_then(|h| h.peel_to_commit()).ok();
    let parents: Vec<_> = parent.iter().collect();
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        &format!("{author} change"),
        &tree,
        &parents,
    )
    .unwrap()
}

fn attribution(blame: &FileBlame, line: usize) -> Option<&str> {
    blame
        .ranges
        .iter()
        .find(|r| r.start_line <= line && line < r.start_line + r.line_count)
        .and_then(|r| r.commit.as_deref())
}

#[test]
fn current_buffer_tracks_authors_insertions_deletions_staging_and_undo() {
    let (_dir, repo) = fixture();
    let root_path = crate::state::canonical(repo.workdir().unwrap()).unwrap();
    let root = root_path.as_path();
    let first = commit(
        &repo,
        "中文 file.txt",
        b"one\ntwo\nthree\n",
        "Alice",
        1_700_000_000,
    )
    .to_string();
    let second = commit(
        &repo,
        "中文 file.txt",
        b"one\nchanged\nthree\n",
        "Bob",
        1_700_100_000,
    )
    .to_string();
    let cache = Mutex::new(Cache::default());
    let read_text = |text: &str| {
        read(root, "中文 file.txt", None, text, "utf8", &cache)
            .unwrap()
            .unwrap()
    };
    let original = read_text("one\nchanged\nthree\n");
    assert_eq!(attribution(&original, 1), Some(first.as_str()));
    assert_eq!(attribution(&original, 2), Some(second.as_str()));
    assert_eq!(original.commits[&second].author, "Bob");
    assert_eq!(original.commits[&second].author_time, 1_700_100_000);
    let changed = read_text("inserted\none\nunsaved\nthree\nlast");
    assert_eq!(attribution(&changed, 1), None);
    assert_eq!(attribution(&changed, 2), Some(first.as_str()));
    assert_eq!(attribution(&changed, 3), None);
    assert_eq!(attribution(&changed, 4), Some(first.as_str()));
    assert_eq!(attribution(&changed, 5), None);
    assert_eq!(
        changed.ranges.iter().map(|r| r.line_count).sum::<usize>(),
        5
    );
    assert!(!changed.commits.contains_key(&second));
    let deleted = read_text("changed\nthree\n");
    assert_eq!(attribution(&deleted, 1), Some(second.as_str()));
    assert_eq!(attribution(&deleted, 2), Some(first.as_str()));
    fs::write(root.join("中文 file.txt"), "one\nstaged\nthree\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("中文 file.txt")).unwrap();
    index.write().unwrap();
    let index_before = fs::read(repo.path().join("index")).unwrap();
    let staged = read_text("one\nstaged\nthree\n");
    assert_eq!(attribution(&staged, 2), None);
    assert_eq!(attribution(&staged, 3), Some(first.as_str()));
    assert_eq!(fs::read(repo.path().join("index")).unwrap(), index_before);
    assert_eq!(
        fs::read_to_string(root.join("中文 file.txt")).unwrap(),
        "one\nstaged\nthree\n"
    );
    assert_eq!(
        attribution(&read_text("one\nchanged\nthree\n"), 2),
        Some(second.as_str())
    );
    assert_eq!(cache.lock_recover().entries.len(), 1);
}

#[test]
fn head_changes_invalidate_history_including_detached_head() {
    let (_dir, repo) = fixture();
    let first = commit(&repo, "file.txt", b"first\n", "Alice", 100);
    repo.branch("old", &repo.find_commit(first).unwrap(), false)
        .unwrap();
    let second = commit(&repo, "file.txt", b"second\n", "Bob", 200);
    let cache = Mutex::new(Cache::default());
    let root_path = crate::state::canonical(repo.workdir().unwrap()).unwrap();
    let root = root_path.as_path();
    let current = read(root, "file.txt", None, "second\n", "utf8", &cache)
        .unwrap()
        .unwrap();
    assert_eq!(current.head, Some(second.to_string()));
    repo.set_head("refs/heads/old").unwrap();
    let older = read(root, "file.txt", None, "first\n", "utf8", &cache)
        .unwrap()
        .unwrap();
    assert_eq!(attribution(&older, 1), Some(first.to_string().as_str()));
    repo.set_head_detached(second).unwrap();
    assert_eq!(
        read(root, "file.txt", None, "second\n", "utf8", &cache)
            .unwrap()
            .unwrap()
            .head,
        Some(second.to_string())
    );
}

#[test]
fn crlf_bom_and_gbk_do_not_make_unchanged_lines_uncommitted() {
    let (_dir, repo) = fixture();
    let root_path = crate::state::canonical(repo.workdir().unwrap()).unwrap();
    let root = root_path.as_path();
    let cache = Mutex::new(Cache::default());
    for (path, bytes, text, encoding) in [
        ("crlf.txt", b"one\r\ntwo\r\n".to_vec(), "one\ntwo\n", "utf8"),
        (
            "bom.txt",
            [vec![0xef, 0xbb, 0xbf], b"one\ntwo".to_vec()].concat(),
            "one\ntwo",
            "utf8bom",
        ),
        (
            "gbk.txt",
            files::encode("你好\n世界", "gbk").unwrap(),
            "你好\r\n世界",
            "gbk",
        ),
    ] {
        let id = commit(&repo, path, &bytes, "Alice", 100).to_string();
        let result = read(root, path, None, text, encoding, &cache)
            .unwrap()
            .unwrap();
        assert_eq!(attribution(&result, 1), Some(id.as_str()), "{path}");
        assert_eq!(attribution(&result, 2), Some(id.as_str()), "{path}");
        assert_eq!(result.ranges.len(), 1);
    }
}

#[test]
fn renamed_path_uses_the_head_path_and_file_boundaries_are_safe() {
    let (_dir, repo) = fixture();
    let root_path = crate::state::canonical(repo.workdir().unwrap()).unwrap();
    let root = root_path.as_path();
    let id = commit(&repo, "old.txt", b"base\n", "Alice", 100).to_string();
    fs::rename(root.join("old.txt"), root.join("new.txt")).unwrap();
    let cache = Mutex::new(Cache::default());
    let result = read(root, "new.txt", Some("old.txt"), "base\n", "utf8", &cache)
        .unwrap()
        .unwrap();
    assert_eq!(attribution(&result, 1), Some(id.as_str()));
    for path in ["../escape", ".git/config", "", "C:/outside"] {
        assert!(read(root, path, None, "base", "utf8", &cache).is_err());
        assert!(read(root, "new.txt", Some(path), "base", "utf8", &cache).is_err());
    }
    assert!(
        read(root, "new.txt", None, "x\0y", "utf8", &cache)
            .unwrap()
            .is_none()
    );
    assert!(
        read(
            root,
            "new.txt",
            None,
            &"x".repeat(files::LARGE_FILE as usize + 1),
            "utf8",
            &cache
        )
        .unwrap()
        .is_none()
    );
}

#[test]
fn unborn_untracked_ignored_empty_and_unsupported_files() {
    let (_dir, repo) = fixture();
    let root_path = crate::state::canonical(repo.workdir().unwrap()).unwrap();
    let root = root_path.as_path();
    let cache = Mutex::new(Cache::default());
    let new = read(root, "new.txt", None, "", "utf8", &cache)
        .unwrap()
        .unwrap();
    assert!(new.head.is_none());
    assert_eq!(new.ranges[0].line_count, 1);
    commit(&repo, ".gitignore", b"ignored.txt\n", "Alice", 100);
    assert!(
        read(root, "ignored.txt", None, "ignored", "utf8", &cache)
            .unwrap()
            .is_none()
    );
    let new = read(root, "new.txt", None, "new\n", "utf8", &cache)
        .unwrap()
        .unwrap();
    assert!(new.head.is_some());
    assert_eq!(new.ranges[0].commit, None);
    commit(&repo, "empty.txt", b"", "Alice", 200);
    let empty = read(root, "empty.txt", None, "", "utf8", &cache)
        .unwrap()
        .unwrap();
    assert!(empty.ranges.is_empty());
    commit(
        &repo,
        "utf16.txt",
        &files::encode("hello\nworld", "utf16le").unwrap(),
        "Alice",
        300,
    );
    assert!(
        read(root, "utf16.txt", None, "hello\nworld", "utf16le", &cache)
            .unwrap()
            .is_none()
    );
}

#[test]
fn cache_evicts_the_least_recent_file_and_respects_byte_limit() {
    let mut cache = Cache::default();
    let key = |i: usize| Key {
        repository: PathBuf::from("repo"),
        head: Oid::zero(),
        path: i.to_string(),
        encoding: "utf8".into(),
    };
    let base = || {
        Arc::new(Base {
            text: "text".into(),
            ranges: vec![],
            commits: BTreeMap::new(),
        })
    };
    for i in 0..8 {
        cache.insert(key(i), base());
    }
    assert!(cache.get(&key(0)).is_some());
    cache.insert(key(8), base());
    assert!(cache.get(&key(1)).is_none());
    assert!(cache.get(&key(0)).is_some());
    assert_eq!(cache.entries.len(), 8);
    cache.insert(
        key(9),
        Arc::new(Base {
            text: "x".repeat(CACHE_BYTES + 1),
            ranges: vec![],
            commits: BTreeMap::new(),
        }),
    );
    assert!(cache.get(&key(9)).is_none());
    assert!(cache.bytes <= CACHE_BYTES);
}
