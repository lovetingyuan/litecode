# Source Control

Open Source Control below Terminal in the activity bar, or press **Ctrl+Shift+G**.
The Changes and Repository tabs share the normal sidebar and editor groups.

## Daily workflow

- Select the containing repository or a nested repository. Opening a repository
  subfolder still exposes the entire selected repository, including files outside
  the workspace folder. The repository path is shown in the selector and details.
- Changes are grouped into merge conflicts, staged changes, working tree changes,
  and untracked files. Flat and path-tree layouts are virtualized. Files can
  appear in both staged and working tree groups.
- Click to preview a comparison; double-click to keep the tab open. Comparisons
  support normal tab pinning, moving, splitting and session restoration.
- Staged comparisons show HEAD versus the index and are read-only. Working tree
  comparisons show the index versus the shared, editable source model. Ctrl+S,
  undo and redo use that source document. The toolbar switches between side by
  side and inline views and opens the source file.
- Stage and unstage individual files, directories, or an entire group. Tree mode
  exposes actions for the selected file or directory below its tree.
- Discard restores tracked files from the index, preserving staged changes.
  Untracked files go to the Recycle Bin. Confirmation is required. Failed
  recycling never falls back to permanent deletion. Files changed since the
  confirmation snapshot must be reviewed again; newer editor edits are preserved.
- Commit requires a nonblank message and staged content; Ctrl+Enter submits the
  message. Only the index is committed. Failed commits retain the message.
- Fetch is manual. Pull merges; Pull (Rebase) rebases. Neither automatically
  stashes local changes. Push can publish an upstream-less branch. Multiple
  remotes and missing upstreams use the existing quick picker.
- Repository details show remotes, upstream, ahead/behind and last fetch time.
  Create and switch branches, create tracking branches from remote refs, and
  safely delete local branches. Git refuses unmerged or checked-out deletions.
- Resolve conflicts using the existing inline conflict actions, save and stage
  the result, then Continue. Abort requires confirmation.

## Implementation and boundaries

Rust git2/libgit2 reads status, refs and blobs. System Git on PATH handles writes
and network operations, retaining Git configuration, SSH, credential helpers,
hooks and signing. These operations use the existing workspace trust flow.
Git is started without a shell or a visible console; messages and NUL-separated
literal paths go through stdin. Output is bounded and hung commands time out.

Workspace/session and repository membership are validated by the backend. Source
files outside a subfolder workspace receive individual grants after repository
authorization. Traversal, Git metadata and symlink-based file operations are
rejected. Binary files, submodules and files over 20 MiB show a comparison summary
with a source-file entry point.

The explorer and Source Control use one status source, with separate index and
worktree deltas. Rust snapshots are cached per repository and invalidated by
coalesced filesystem events. Parent worktrees and external worktree metadata are
watched, including source-file changes outside the workspace. Repository discovery
prunes Git-ignored directories; expanding a folder can discover a newly created
repository. Source content is loaded only for open editors. Git panel code is
loaded on demand, and historical comparison content is excluded from recovery mirrors.

This version does not include line/hunk staging, branch renaming, a separate
upstream settings page, editing remotes, or deleting remote branches.

## Verification

Run frontend tests and checks with `npm test`, `npm run lint`, and `npm run build`.
Run native tests with `cargo test --lib` in `src-tauri`.

With the debug executable built and Vite running on port 1420:

```powershell
npm run test:e2e -- --git --repo D:/lovetingyuan/hotsou
```

The native test uses an isolated portable app/profile and a temporary worktree
and branch. It checks real IPC, watchers, shared models, saving, comparison modes,
session restoration, staging, index-only commits, discard/recycling, branches,
nested repositories, subfolder scope, and 10,000 untracked entries. It opens the
original checkout read-only and fetches its real GitHub origin. Its main branch
OID, active branch and working tree status must match the initial record. Successful
runs remove their temporary worktree and branch. No test commits are pushed to
GitHub; local bare remotes cover Push, Pull, tracking and divergence in Rust tests.

Screenshots, results, process memory observations and preservation checks are
written under `.verification/git-<timestamp>/`. The existing editor-tab browser
regression is `node tools/verify-editor-tabs.mjs`.

The opt-in large repository benchmark is:

```powershell
cargo test --release --lib git::tests::large_repository_performance -- --ignored --nocapture
```

On this Windows machine, 100,000 tracked files with 10,000 modifications measured
500.98 ms p50 and 521.22 ms p95 across ten scans. A cached Rust snapshot took
12.35 ms before JSON serialization; the payload was 2,838,072 bytes and contained
no file bodies. These are local observations, not hardware-independent budgets.

Validation on 2026-10-27: 549 frontend tests and 113 native tests passed; four
opt-in/platform tests were skipped in the normal native suite. The release
benchmark passed separately. Type checking, lint, frontend production build and
the existing editor-tab regression passed. The build retains existing dependency
browser-externalization and large-chunk warnings.

The final native acceptance evidence is `.verification/git-1793034913620/`.
All seven workflow checks passed with no page errors. The 10,000-entry list used
20 DOM rows and retained one source model before and after population. At that
point the native process used 59.66 MiB working set / 15.83 MiB private memory;
renderer JS heap was 205.26 MiB. Native memory excludes WebView2, and JS heap is a
separate observation rather than a total application memory measurement.
`main-preserved.json` records the original and final clean `hotsou/main` at
`d86daf2ccc40681a47e2f5e3c5b3da36e18d6bbb`.
