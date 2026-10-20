# Git ignore decorations

Git repositories use the existing `git2/libgit2` status scan. Ignored directories
remain compact directory entries ending in `/`; their files are still present in
the workspace path list. Windows path conversion must preserve that suffix.
No additional matcher or filesystem traversal is introduced.

Trees inherits ignored directory statuses using its native cache. The public
`--trees-git-ignored-color-override` variable and tab label styles share
`--git-ignored-foreground: #8c8c8c`; beta.6's theme converter does not map the
ignored-resource theme key. Tabs use an index cached by Git entry array identity,
exact statuses take precedence over ignored ancestors, and repeated lookups are
memoized. A replaced snapshot releases the old cache through a WeakMap.

Watcher events received during a scan queue a follow-up scan. Both views reject
snapshots from a different workspace. Plain folders without a discovered Git
repository do not apply `.gitignore` decorations.

Trees beta.6 also retained ancestor-match results across Git status changes. The
reproducible dependency patch now recreates that cache when the ignored-directory
set changes. The native regression expands `server/api/` before adding `server/`,
then removes and restores the rule; this failed before the cache fix. Tracked
files continue to follow Git's existing rules and are not ignored merely because
a newly added pattern matches them.

## Checks (2026-10-20)

- `npm test`: 92 passed, including directory inheritance, path boundaries,
  Windows/UNC and POSIX paths, snapshot replacement, 200,000-entry index reuse,
  scan coalescing, failures and workspace changes.
- `cargo test --lib` (in `src-tauri`): 34 passed; one explicitly opt-in performance
  sample. The new directory regression failed before the Windows suffix fix.
- `npm run build`: passed, with existing dependency/browser externalization,
  chunk-size and mixed static/dynamic import warnings.
- `node tools/verify-explorer-sync.mjs` and `node tools/verify-editor-tabs.mjs`:
  existing real-browser checks passed without page errors.
- `node tools/verify-git-ignore.mjs`: passed against an isolated portable native
  debug app, real libgit2 IPC and real filesystem watchers. Verified exact computed
  colors, ignored descendants, preview/active/hover/pinned/split tabs, negation,
  tracked files, rule save/delete/recreation and workspace state isolation.

Run the focused native check through the desktop entry point with
`npm run test:e2e -- --git-ignore`, after building the debug executable and starting
`npm run dev` on port 1420. It creates its own Git fixture, portable settings and
WebView2 profile under `.verification/git-ignore-<timestamp>`, writes screenshots
and `results.json`, then closes only its own application. Unlike the broad desktop
suite, this focused check attaches through WebView2 CDP and needs no WebDriver.
The observed screenshots are debug-app evidence, not release/reference acceptance.

## Performance observations

Windows debug builds, warmed caches; local samples with other development
processes running. These observations are not performance budgets.

| Sample | Observed |
| --- | --- |
| 200,000 synthetic individual ignored-directory entries, initial tab index | 168.65 ms |
| 100,000 repeated tab queries against that index | 62.45 ms total |
| Existing scan of 10,102 paths, before suffix fix, five warm samples | 82.65–95.32 ms (median 85.89 ms) |
| Same scan after suffix fix, five warm samples | 76.08–119.02 ms (median 102.74 ms) |
| Git status payload for the 10,102-path fixture, before and after | 2 entries |

The 200,000-entry case deliberately stresses index creation; a single ignored
directory containing many files only contributes one ignored status entry. The
reuse test checks that repeated queries do not read the entry array again. Scan
samples include the existing filesystem walk and fluctuate with concurrent load;
they do not establish a statistically significant scan regression or improvement.

Reproduce the filesystem sample with
`cargo test --lib workspace::tests::ignored_scan_performance -- --ignored --nocapture`
inside `src-tauri`. Fixture creation and cleanup are outside the printed scan
timings and can be slow on Windows. Do not compile the same test executable while
this sample is running, as Windows holds the executable open until cleanup ends.
