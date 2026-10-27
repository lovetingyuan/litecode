use super::*;
use crate::workspace;

fn fixture() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = canonical(temp.path()).unwrap();
    run_git(&root, &["init", "-b", "main"], None).unwrap();
    run_git(&root, &["config", "user.name", "LiteCode Test"], None).unwrap();
    run_git(
        &root,
        &["config", "user.email", "test@example.invalid"],
        None,
    )
    .unwrap();
    run_git(&root, &["config", "commit.gpgsign", "false"], None).unwrap();
    run_git(&root, &["config", "core.autocrlf", "false"], None).unwrap();
    (temp, root)
}
fn stage(root: &Path, paths: &[&str]) {
    execute(
        root,
        Operation::Stage {
            paths: paths.iter().map(|s| (*s).into()).collect(),
        },
    )
    .unwrap();
}
fn commit(root: &Path, message: &str) {
    execute(
        root,
        Operation::Commit {
            message: message.into(),
        },
    )
    .unwrap();
}
fn changes(root: &Path) -> Snapshot {
    let repo = Repository::open(root).unwrap();
    let mut options = git2::StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .update_index(false);
    let statuses = repo.statuses(Some(&mut options)).unwrap();
    snapshot(&repo, &statuses)
}

#[test]
fn staged_then_modified_keeps_both_versions_and_commit_only_uses_index() {
    let (_temp, root) = fixture();
    fs::write(root.join("file.txt"), "base\n").unwrap();
    stage(&root, &["file.txt"]);
    commit(&root, "initial");
    fs::write(root.join("file.txt"), "staged\n").unwrap();
    stage(&root, &["file.txt"]);
    fs::write(root.join("file.txt"), "working\n").unwrap();
    let current = changes(&root);
    assert_eq!(current.changes[0].index_status.as_deref(), Some("modified"));
    assert_eq!(
        current.changes[0].worktree_status.as_deref(),
        Some("modified")
    );
    let staged = diff(&root, "file.txt", true, None, false).unwrap();
    assert_eq!(
        (staged.before.as_str(), staged.after.as_str()),
        ("base\n", "staged\n")
    );
    let working = diff(&root, "file.txt", false, None, false).unwrap();
    assert_eq!(
        (working.before.as_str(), working.after.as_str()),
        ("staged\n", "working\n")
    );
    commit(&root, "only index");
    assert_eq!(
        diff(&root, "file.txt", true, None, false).unwrap().before,
        "staged\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        "working\n"
    );
}

#[test]
fn discard_restores_index_preserves_staging_and_rejects_stale_confirmation() {
    let (_temp, root) = fixture();
    fs::write(root.join("file.txt"), "base").unwrap();
    stage(&root, &["file.txt"]);
    commit(&root, "initial");
    fs::write(root.join("file.txt"), "staged").unwrap();
    stage(&root, &["file.txt"]);
    fs::write(root.join("file.txt"), "working").unwrap();
    let change = changes(&root).changes.remove(0);
    fs::write(root.join("file.txt"), "changed after confirmation").unwrap();
    assert!(
        execute(
            &root,
            Operation::Discard {
                files: vec![Selected {
                    path: change.path,
                    stamp: change.stamp
                }]
            }
        )
        .is_err()
    );
    let change = changes(&root).changes.remove(0);
    execute(
        &root,
        Operation::Discard {
            files: vec![Selected {
                path: change.path,
                stamp: change.stamp,
            }],
        },
    )
    .unwrap();
    assert_eq!(fs::read_to_string(root.join("file.txt")).unwrap(), "staged");
    assert_eq!(
        changes(&root).changes[0].index_status.as_deref(),
        Some("modified")
    );
    assert!(changes(&root).changes[0].worktree_status.is_none());
}

#[test]
fn unborn_unstage_preserves_special_filenames_and_multiline_commit_message() {
    let (_temp, root) = fixture();
    let paths = ["中文 file.txt", "[literal].txt", "-option.txt"];
    for path in paths {
        fs::write(root.join(path), path).unwrap();
    }
    stage(&root, &paths);
    fs::write(root.join(paths[0]), "edited after staging").unwrap();
    assert_eq!(changes(&root).changes.len(), 3);
    execute(
        &root,
        Operation::Unstage {
            paths: paths.iter().map(|s| (*s).into()).collect(),
        },
    )
    .unwrap();
    assert!(paths.iter().all(|p| root.join(p).is_file()));
    assert_eq!(fs::read_to_string(root.join(paths[0])).unwrap(), "edited after staging");
    assert!(
        changes(&root)
            .changes
            .iter()
            .all(|c| c.index_status.is_none())
    );
    assert!(
        execute(
            &root,
            Operation::Commit {
                message: " \n ".into()
            }
        )
        .is_err()
    );
    stage(&root, &paths);
    commit(&root, "subject\n\nbody with `literal` and $characters");
    let repo = Repository::open(&root).unwrap();
    assert!(
        repo.head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .message()
            .unwrap()
            .contains("body with `literal` and $characters")
    );
}

#[test]
fn renamed_deleted_and_binary_files_have_correct_diff_sources() {
    let (_temp, root) = fixture();
    fs::write(root.join("old.txt"), "rename contents\n").unwrap();
    stage(&root, &["old.txt"]);
    commit(&root, "initial");
    fs::rename(root.join("old.txt"), root.join("new.txt")).unwrap();
    stage(&root, &["old.txt", "new.txt"]);
    let change = changes(&root).changes.remove(0);
    assert_eq!(change.old_path.as_deref(), Some("old.txt"));
    let result = diff(&root, "new.txt", true, Some("old.txt"), false).unwrap();
    assert_eq!(result.before, result.after);
    commit(&root, "rename");
    fs::remove_file(root.join("new.txt")).unwrap();
    let deleted = diff(&root, "new.txt", false, None, false).unwrap();
    assert!(!deleted.before.is_empty());
    assert!(deleted.after.is_empty());
    fs::write(root.join("binary.bin"), [0, 1, 0, 2]).unwrap();
    assert!(
        diff(&root, "binary.bin", false, None, false)
            .unwrap()
            .summary
            .is_some()
    );
}

#[test]
fn staged_rename_then_worktree_rename_keeps_each_layer() {
    let (_temp, root) = fixture();
    fs::write(root.join("head.txt"), "rename contents\n").unwrap();
    stage(&root, &["head.txt"]);
    commit(&root, "initial");
    fs::rename(root.join("head.txt"), root.join("index.txt")).unwrap();
    stage(&root, &["head.txt", "index.txt"]);
    fs::rename(root.join("index.txt"), root.join("working.txt")).unwrap();
    let current = changes(&root);
    let index = current
        .changes
        .iter()
        .find(|c| c.index_status.is_some())
        .unwrap();
    assert_eq!(index.index_path.as_deref(), Some("index.txt"));
    assert_eq!(index.index_old_path.as_deref(), Some("head.txt"));
    let staged = diff(&root, "index.txt", true, Some("head.txt"), false).unwrap();
    assert_eq!(staged.before, staged.after);
    let working = current
        .changes
        .iter()
        .find(|c| c.worktree_status.as_deref() == Some("renamed"))
        .unwrap();
    assert_eq!(working.worktree_old_path.as_deref(), Some("index.txt"));
    let working_diff = diff(&root, "working.txt", false, Some("index.txt"), false).unwrap();
    assert_eq!(working_diff.before, working_diff.after);
}

#[test]
fn paths_and_repository_scope_are_authorized() {
    let (_temp, root) = fixture();
    let state = AppState::default();
    let mut window = crate::state::WindowState::default();
    window.root = Some(root.clone());
    window.workspace_session = 7;
    state.windows.lock().unwrap().insert("test".into(), window);
    assert_eq!(
        context(&state, "test", &visible(&root), 7, &visible(&root)).unwrap(),
        root
    );
    assert!(context(&state, "test", &visible(&root), 6, &visible(&root)).is_err());
    let (_other, outside) = fixture();
    assert!(context(&state, "test", &visible(&root), 7, &visible(&outside)).is_err());
    for path in [
        "../escape",
        ".git/config",
        "src/../../escape",
        "C:/escape",
        "",
    ] {
        assert!(file_path(&root, path).is_err(), "{path}");
    }
    assert!(
        execute(
            &root,
            Operation::CreateBranch {
                name: "--evil".into(),
                start: None
            }
        )
        .is_err()
    );
    assert!(
        execute(
            &root,
            Operation::Fetch {
                remote: "--upload-pack=evil".into()
            }
        )
        .is_err()
    );
}

#[test]
fn creating_from_non_current_local_and_remote_refs_preserves_the_start_and_tracking() {
    let (_temp, root) = fixture();
    fs::write(root.join("file.txt"), "base").unwrap();
    stage(&root, &["file.txt"]);
    commit(&root, "base");
    let repo = Repository::open(&root).unwrap();
    let base = repo.head().unwrap().target().unwrap();
    run_git(&root, &["branch", "feature/base"], None).unwrap();
    fs::write(root.join("file.txt"), "newer").unwrap();
    stage(&root, &["file.txt"]);
    commit(&root, "newer HEAD");
    execute(&root, Operation::CreateBranch {
        name: "local-child".into(), start: Some("refs/heads/feature/base".into()),
    }).unwrap();
    assert_eq!(repo.head().unwrap().target(), Some(base));
    assert_eq!(info(&root).unwrap().branch.as_deref(), Some("local-child"));
    assert_eq!(fs::read_to_string(root.join("file.txt")).unwrap(), "base");

    let remote = tempfile::tempdir().unwrap();
    run_git(remote.path(), &["init", "--bare"], None).unwrap();
    run_git(&root, &["remote", "add", "origin", remote.path().to_str().unwrap()], None).unwrap();
    run_git(&root, &["push", "origin", "HEAD:refs/heads/feature/base"], None).unwrap();
    execute(&root, Operation::Switch { branch: "main".into() }).unwrap();
    execute(&root, Operation::CreateBranch {
        name: "remote-child".into(), start: Some("refs/remotes/origin/feature/base".into()),
    }).unwrap();
    let current = info(&root).unwrap();
    assert_eq!(current.branch.as_deref(), Some("remote-child"));
    assert_eq!(repo.head().unwrap().target(), Some(base));
    assert_eq!(current.upstream.as_deref(), Some("origin/feature/base"));
    assert_eq!((current.ahead, current.behind), (Some(0), Some(0)));
    assert!(execute(&root, Operation::CreateBranch {
        name: "main".into(), start: Some("refs/remotes/origin/feature/base".into()),
    }).is_err());
    assert_eq!(info(&root).unwrap().branch.as_deref(), Some("remote-child"));
    run_git(&root, &["commit", "--allow-empty", "-m", "unmerged child"], None).unwrap();
    execute(&root, Operation::Switch { branch: "main".into() }).unwrap();
    assert!(execute(&root, Operation::DeleteBranch { branch: "remote-child".into() }).is_err());
    assert!(repo.find_branch("remote-child", BranchType::Local).is_ok());
}

#[test]
fn local_branch_operations_and_worktrees_are_reported() {
    let (_temp, root) = fixture();
    fs::write(root.join("file.txt"), "base").unwrap();
    stage(&root, &["file.txt"]);
    commit(&root, "initial");
    execute(
        &root,
        Operation::CreateBranch {
            name: "feature/test".into(),
            start: None,
        },
    )
    .unwrap();
    assert_eq!(info(&root).unwrap().branch.as_deref(), Some("feature/test"));
    assert!(
        execute(
            &root,
            Operation::DeleteBranch {
                branch: "feature/test".into()
            }
        )
        .is_err()
    );
    execute(
        &root,
        Operation::Switch {
            branch: "main".into(),
        },
    )
    .unwrap();
    let worktree = root.parent().unwrap().join(format!(
        "worktree-{}",
        root.file_name().unwrap().to_string_lossy()
    ));
    run_git(
        &root,
        &["worktree", "add", &visible(&worktree), "feature/test"],
        None,
    )
    .unwrap();
    assert!(
        info(&root)
            .unwrap()
            .branches
            .iter()
            .any(|b| b.name == "feature/test" && b.worktree)
    );
    assert!(
        execute(
            &root,
            Operation::DeleteBranch {
                branch: "feature/test".into()
            }
        )
        .is_err()
    );
    run_git(&root, &["worktree", "remove", &visible(&worktree)], None).unwrap();
    execute(
        &root,
        Operation::DeleteBranch {
            branch: "feature/test".into(),
        },
    )
    .unwrap();
}

#[test]
fn local_remote_fetch_push_pull_and_tracking() {
    let (_temp, root) = fixture();
    let remote = tempfile::tempdir().unwrap();
    run_git(remote.path(), &["init", "--bare"], None).unwrap();
    run_git(
        &root,
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
        None,
    )
    .unwrap();
    fs::write(root.join("file.txt"), "base").unwrap();
    stage(&root, &["file.txt"]);
    commit(&root, "initial");
    execute(
        &root,
        Operation::Push {
            remote: Some("origin".into()),
        },
    )
    .unwrap();
    let initial = info(&root).unwrap();
    assert_eq!(initial.upstream.as_deref(), Some("origin/main"));
    assert_eq!(initial.ahead, Some(0));
    fs::write(root.join("local.txt"), "local").unwrap();
    stage(&root, &["local.txt"]);
    commit(&root, "local");
    assert_eq!(info(&root).unwrap().ahead, Some(1));
    execute(&root, Operation::Push { remote: None }).unwrap();
    let (_peer_temp, peer) = fixture();
    run_git(
        &peer,
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
        None,
    )
    .unwrap();
    execute(
        &peer,
        Operation::Fetch {
            remote: "origin".into(),
        },
    )
    .unwrap();
    execute(
        &peer,
        Operation::CreateBranch {
            name: "peer".into(),
            start: Some("refs/remotes/origin/main".into()),
        },
    )
    .unwrap();
    fs::write(peer.join("remote.txt"), "remote").unwrap();
    stage(&peer, &["remote.txt"]);
    commit(&peer, "remote");
    run_git(&peer, &["push", "origin", "HEAD:main"], None).unwrap();
    execute(
        &root,
        Operation::Fetch {
            remote: "origin".into(),
        },
    )
    .unwrap();
    assert_eq!(info(&root).unwrap().behind, Some(1));
    execute(
        &root,
        Operation::Pull {
            remote: None,
            branch: None,
            rebase: false,
        },
    )
    .unwrap();
    assert!(root.join("remote.txt").is_file());
    fs::write(root.join("rebase-local.txt"), "local").unwrap();
    stage(&root, &["rebase-local.txt"]);
    commit(&root, "local rebase");
    fs::write(peer.join("remote-two.txt"), "remote two").unwrap();
    stage(&peer, &["remote-two.txt"]);
    commit(&peer, "remote two");
    run_git(&peer, &["push", "origin", "HEAD:main"], None).unwrap();
    execute(
        &root,
        Operation::Pull {
            remote: None,
            branch: None,
            rebase: true,
        },
    )
    .unwrap();
    assert!(root.join("remote-two.txt").is_file());
    assert!(root.join("rebase-local.txt").is_file());
}

#[test]
fn merge_conflicts_can_be_reviewed_resolved_continued_and_aborted() {
    let (_temp, root) = fixture();
    fs::write(root.join("file.txt"), "base\n").unwrap();
    stage(&root, &["file.txt"]);
    commit(&root, "initial");
    execute(
        &root,
        Operation::CreateBranch {
            name: "incoming".into(),
            start: None,
        },
    )
    .unwrap();
    fs::write(root.join("file.txt"), "incoming\n").unwrap();
    stage(&root, &["file.txt"]);
    commit(&root, "incoming");
    execute(
        &root,
        Operation::Switch {
            branch: "main".into(),
        },
    )
    .unwrap();
    fs::write(root.join("file.txt"), "current\n").unwrap();
    stage(&root, &["file.txt"]);
    commit(&root, "current");
    assert!(run_git(&root, &["merge", "incoming", "--no-edit"], None).is_err());
    assert_eq!(info(&root).unwrap().operation.as_deref(), Some("merge"));
    assert!(changes(&root).changes[0].conflicted);
    assert_eq!(
        diff(&root, "file.txt", false, None, true).unwrap().before,
        "current\n"
    );
    execute(&root, Operation::Abort).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        "current\n"
    );
    assert!(run_git(&root, &["merge", "incoming", "--no-edit"], None).is_err());
    fs::write(root.join("file.txt"), "resolved\n").unwrap();
    stage(&root, &["file.txt"]);
    execute(&root, Operation::Continue).unwrap();
    assert!(info(&root).unwrap().operation.is_none());
}

#[test]
fn hooks_fail_without_losing_the_index() {
    let (_temp, root) = fixture();
    fs::write(root.join("file.txt"), "content").unwrap();
    stage(&root, &["file.txt"]);
    let repo = Repository::open(&root).unwrap();
    fs::write(
        repo.path().join("hooks/pre-commit"),
        "#!/bin/sh\necho blocked-by-test-hook >&2\nexit 1\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            repo.path().join("hooks/pre-commit"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    let error = execute(
        &root,
        Operation::Commit {
            message: "test".into(),
        },
    )
    .unwrap_err();
    assert!(error.message.contains("blocked-by-test-hook"));
    assert!(changes(&root).changes[0].index_status.is_some());
}

#[test]
#[ignore = "Creates a 100,000-file benchmark fixture; run explicitly in release mode"]
fn large_repository_performance() {
    let (_temp, root) = fixture();
    for directory in 0..100 {
        fs::create_dir(root.join(format!("dir-{directory}"))).unwrap();
        for file in 0..1000 {
            fs::write(root.join(format!("dir-{directory}/{file}.txt")), "base\n").unwrap();
        }
    }
    run_git(&root, &["add", "."], None).unwrap();
    commit(&root, "benchmark");
    for directory in 0..10 {
        for file in 0..1000 {
            fs::write(
                root.join(format!("dir-{directory}/{file}.txt")),
                "changed\n",
            )
            .unwrap();
        }
    }
    let index = workspace::RepositoryIndex::default();
    let mut samples = vec![];
    for _ in 0..10 {
        index.invalidate();
        let start = Instant::now();
        let snapshot = workspace::git_snapshot(&root, &index, 1).unwrap();
        assert_eq!(snapshot.repositories[0].changes.len(), 10_000);
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(f64::total_cmp);
    let start = Instant::now();
    let snapshot = workspace::git_snapshot(&root, &index, 1).unwrap();
    let cached_ms = start.elapsed().as_secs_f64() * 1000.0;
    println!(
        "git benchmark: tracked=100000 changed=10000 p50Ms={:.2} p95Ms={:.2} cachedMs={cached_ms:.2} payloadBytes={}",
        samples[4],
        samples[9],
        serde_json::to_vec(&snapshot).unwrap().len()
    );
}
