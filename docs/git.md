# Source Control

Open Source Control below Terminal in the activity bar, or press **Ctrl+Shift+G**.
The Changes and Repository tabs share the normal sidebar and editor groups.

## Daily workflow

- Select the containing repository or a nested repository. Opening a repository
  subfolder still exposes the entire selected repository, including files outside
  the workspace folder. The repository path is shown in the selector.
- Changes are grouped into merge conflicts, staged changes, working tree changes,
  and untracked files. Flat and path-tree layouts are virtualized. Files can
  appear in both staged and working tree groups.
- Drag the horizontal dividers between groups to adjust their heights. Each
  group scrolls independently in both flat and tree layouts. Focus a divider
  and use Up/Down for 10px adjustments, or double-click to balance its adjacent
  groups. Collapsing a group frees its space; expanding restores its proportion.
  Initial heights follow file counts. Manual proportions last until the panel
  is reopened or the repository changes; they are not saved in the session.
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
- Click Commit at the end of the Git toolbar to open the message dialog. Commit
  uses the blue theme color and is disabled without staged content, when conflicts
  remain, or while a Git operation is running. The message dialog
  requires a nonblank message, staged content and no unresolved conflicts;
  Ctrl+Enter submits, while Enter adds a newline. Only the index is committed.
  Cancel, Escape and clicking the backdrop retain each repository's draft.
  Failed commits keep the dialog and message; successful commits close it and
  clear the draft. Switching repositories or workspaces closes the dialog.
- In the Repository tab, each remote name, address and Open button share one
  line. Open launches that address's repository in the system's default browser.
  Identical fetch and push addresses share one row; different addresses have
  separate rows and buttons. HTTP/HTTPS URLs and common SSH remotes are supported;
  SSH addresses become HTTPS web addresses. Unsupported addresses have disabled
  buttons. Long names and addresses use ellipses with their full text available
  on hover; Open buttons remain visible on the right.
- Fetch is manual. Pull merges; Pull (Rebase) rebases. Neither automatically
  stashes local changes. Push can publish an upstream-less branch. Multiple
  remotes and missing upstreams use the existing quick picker.
- Remote operations show a spinner inside the active button without changing its
  size. Errors appear in the bottom-right notification.
- Above the remote buttons, the current branch shows `(↓3 behind · ↑2 ahead)`
  against its upstream, including zero counts when synced. Counts are hidden
  while unavailable, refreshing after Git operations, or in detached HEAD state.
  Repository details contain Remotes and Branches.
- Every branch row has Create (+) and Copy Name buttons; local branches
  also have Delete. Names truncate with a full-name tooltip; buttons appear when
  the row is hovered or contains keyboard focus, with their space reserved.
  Create starts at that row's branch and immediately switches to the new local
  branch. Remote sources establish tracking. The Branches heading's + starts
  from the current HEAD. Click the branch name to switch branches.
- Switching a remote branch reuses a local branch tracking that exact remote
  ref, or creates one using the name without the remote prefix. Multiple usable
  tracking branches open a picker; conflicting local names prompt for a new name.
  Copy preserves the complete displayed name, including the remote prefix.
- Local deletion requires confirmation. Git refuses unmerged or checked-out
  deletions; current and occupied worktree branches cannot be switched to or
  deleted. Create, Switch and Delete are disabled during Git operations and
  merge/rebase; Copy stays available. Branch dialogs recheck the selected
  repository and workspace before executing.
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

Remote address Open buttons were verified on 2026-10-27: all 621 frontend tests,
lint, type checking and the production build passed. The focused native check
passed without page errors, covering missing/multiple remotes, distinct fetch
and push targets, unsupported local addresses, opening while Git is busy,
keyboard activation and an actual 240px sidebar resized using its separator.
Screenshots and results are in `.verification/git-1793090202904/`.

The single-line refinement also passed lint, type checking, the production build
and the focused native check. Names, addresses and buttons remain on one line
at 240px, with ellipses and full-text tooltips. Evidence is in
`.verification/git-1793090473064/`.

Run frontend tests and checks with `npm test`, `npm run lint`, and `npm run build`.
Run native tests with `cargo test --lib` in `src-tauri`.
With Vite running, `node tools/verify-git-panes.mjs` checks group dividers,
collapse/expansion, independent scrolling, virtualization and transient sizing.

With the debug executable built and Vite running on port 1420:

```powershell
npm run test:e2e -- --git
npm run test:e2e -- --git --branches-only
npm run test:e2e -- --git --repo D:/lovetingyuan/hotsou
node tools/verify-git.mjs --remotes-only
```

The first command uses an independent temporary repository and a local bare
remote for branch row actions, tracking reuse and creation, name collisions,
copying, worktree guards, keyboard/overflow checks and ahead/behind states.
These additional branch checks run without `--repo`, keeping remote settings
isolated from a user's shared worktree configuration.
Use `--branches-only` to run just the branch checks in a fresh fixture.
Use `--remotes-only` to check per-address Open buttons, fetch/push targets,
unsupported addresses, keyboard activation and single-line narrow-sidebar layout in an
isolated fixture. Browser opener requests are intercepted without launching
external websites.

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

Branch action validation on 2026-10-27: 621 frontend tests passed, along with
lint, type checking and the production build. The Git native suite passed
11 tests with one performance benchmark skipped, using `--test-threads=1`.
Desktop checks exercised source-branch creation, remote tracking reuse and
creation, name collisions, picker selection, copying, worktree guards and
layout. The complete desktop Fetch/Pull count sequence could not finish on
this machine because Git for Windows MSYS subprocesses intermittently failed
to initialize or timed out. Branch UI evidence is
`.verification/git-1793088633150/03-branch-actions.png`.

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

Commit dialog and Open Remote validation on 2026-10-27: 589 frontend tests passed
with `npm test -- --maxWorkers=4`; lint and the production build passed. The
default test concurrency hit existing trust/language-service timeouts on this
machine. Native acceptance passed all eight workflow checks with no page errors;
evidence is `.verification/git-1793085368398/`. It covers draft retention,
focus restoration, multiline index-only commits, failed-commit retry, conflict
and busy guards, repository/workspace changes, and intercepted browser opener
requests (including opening while Git is busy).
