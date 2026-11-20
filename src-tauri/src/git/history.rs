use super::{context, git_error};
use crate::{error::Result, state::AppState};
use git2::{Commit, ErrorCode, Oid, Repository, Sort};
use serde::Serialize;
use std::path::Path;
use tauri::{State, WebviewWindow};

const MAX_PAGE_SIZE: usize = 200;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCommit {
    pub sha: String,
    pub summary: String,
    pub author: String,
    pub author_time: i64,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub head: Option<String>,
    pub commits: Vec<HistoryCommit>,
    pub has_more: bool,
}

fn parse_sha(sha: &str) -> Result<Oid> {
    if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(git_error("A full commit SHA is required"));
    }
    Oid::from_str(sha).map_err(git_error)
}

fn commit_summary(commit: &Commit<'_>) -> String {
    commit
        .summary_bytes()
        .map(|bytes| String::from_utf8_lossy(bytes).trim().to_owned())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| {
            String::from_utf8_lossy(commit.message_bytes())
                .lines()
                .next()
                .unwrap_or_default()
                .trim()
                .to_owned()
        })
}

pub(super) fn read(
    root: &Path,
    head: Option<&str>,
    skip: usize,
    limit: usize,
) -> Result<HistoryPage> {
    let repo = Repository::open(root).map_err(git_error)?;
    let start = match head {
        Some(sha) => parse_sha(sha)?,
        None => match repo.head().and_then(|reference| reference.peel_to_commit()) {
            Ok(commit) => commit.id(),
            Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
                return Ok(HistoryPage {
                    head: None,
                    commits: vec![],
                    has_more: false,
                });
            }
            Err(error) => return Err(git_error(error)),
        },
    };
    let page_size = limit.clamp(1, MAX_PAGE_SIZE);
    let mut walk = repo.revwalk().map_err(git_error)?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(git_error)?;
    walk.push(start).map_err(git_error)?;

    let mut iter = walk.skip(skip);
    let mut commits = Vec::with_capacity(page_size);
    for entry in iter.by_ref().take(page_size) {
        let oid = entry.map_err(git_error)?;
        let commit = repo.find_commit(oid).map_err(git_error)?;
        let author = commit.author();
        commits.push(HistoryCommit {
            sha: oid.to_string(),
            summary: commit_summary(&commit),
            author: String::from_utf8_lossy(author.name_bytes()).into_owned(),
            author_time: author.when().seconds(),
        });
    }
    let has_more = iter.next().transpose().map_err(git_error)?.is_some();

    Ok(HistoryPage {
        head: Some(start.to_string()),
        commits,
        has_more,
    })
}

#[tauri::command]
pub async fn git_commit_history(
    window: WebviewWindow,
    state: State<'_, AppState>,
    expected_root: String,
    session: u64,
    repository: String,
    head: Option<String>,
    skip: usize,
    limit: usize,
) -> Result<HistoryPage> {
    let root = context(&state, window.label(), &expected_root, session, &repository)?;
    let result =
        tauri::async_runtime::spawn_blocking(move || read(&root, head.as_deref(), skip, limit))
            .await
            .map_err(git_error)??;
    context(&state, window.label(), &expected_root, session, &repository)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::canonical;
    use git2::{Signature, Time};
    use std::path::PathBuf;

    fn repo_fixture() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = canonical(temp.path()).unwrap();
        Repository::init(&root).unwrap();
        (temp, root)
    }

    fn make_commit(root: &Path, message: &str, author_name: &str, timestamp: i64) -> String {
        let repo = Repository::open(root).unwrap();
        let mut index = repo.index().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = Signature::new(
            author_name,
            "author@example.invalid",
            &Time::new(timestamp, 0),
        )
        .unwrap();
        let parents: Vec<Commit<'_>> = repo
            .head()
            .ok()
            .and_then(|head| head.peel_to_commit().ok())
            .into_iter()
            .collect();
        let parent_refs: Vec<&Commit<'_>> = parents.iter().collect();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parent_refs,
        )
        .unwrap()
        .to_string()
    }

    #[test]
    fn unborn_branch_returns_empty_history() {
        let (_temp, root) = repo_fixture();
        let page = read(&root, None, 0, 50).unwrap();
        assert_eq!(
            page,
            HistoryPage {
                head: None,
                commits: vec![],
                has_more: false,
            }
        );
    }

    #[test]
    fn paginates_current_branch_and_pins_head_across_pages() {
        let (_temp, root) = repo_fixture();
        let first = make_commit(&root, "first commit\n\ndetails", "Alice", 1_700_000_001);
        let second = make_commit(&root, "second commit", "Bob", 1_700_000_002);
        let third = make_commit(&root, "third commit", "Carol", 1_700_000_003);

        let page1 = read(&root, None, 0, 2).unwrap();
        assert_eq!(page1.head.as_deref(), Some(third.as_str()));
        assert!(page1.has_more);
        assert_eq!(
            page1
                .commits
                .iter()
                .map(|c| (
                    c.sha.as_str(),
                    c.summary.as_str(),
                    c.author.as_str(),
                    c.author_time
                ))
                .collect::<Vec<_>>(),
            vec![
                (third.as_str(), "third commit", "Carol", 1_700_000_003),
                (second.as_str(), "second commit", "Bob", 1_700_000_002),
            ]
        );

        // Creating a new commit after page 1 must not shift page 2 when pinned to page1.head.
        let _fourth = make_commit(&root, "fourth commit", "Dave", 1_700_000_004);
        let page2 = read(&root, page1.head.as_deref(), 2, 2).unwrap();
        assert_eq!(page2.head.as_deref(), Some(third.as_str()));
        assert!(!page2.has_more);
        assert_eq!(
            page2.commits,
            vec![HistoryCommit {
                sha: first,
                summary: "first commit".into(),
                author: "Alice".into(),
                author_time: 1_700_000_001,
            }]
        );
    }

    #[test]
    fn rejects_invalid_head_sha() {
        let (_temp, root) = repo_fixture();
        let error = read(&root, Some("not-a-sha"), 0, 50).unwrap_err();
        assert_eq!(error.code, "git");
    }
}
