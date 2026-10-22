# Explorer inline creation and rename

All Explorer creation entry points use one draft at a time. A folder target
creates inside that folder; a file target uses its parent; the workspace menu
uses the root. Draft folders sort before folders, and draft files sort before
files, after expanded folder subtrees. The draft path never reaches disk IPC.

`tools/patch-trees-scroll.mjs` installs the pinned beta.6 inline editing extension
alongside the existing scroll/drag patches. `tools/patch-trees-creation.mjs`
defines the small controller/render patches; `tools/trees/` holds the session
and input implementation. Patch replacements for the same dependency file
are grouped before writing. Vite's cache key includes all patch sources.
Review these patches when upgrading `@pierre/trees`.

The patched model exposes `startCreating`, `cancelCreating`, `getCreatingPath`,
`startRenaming`, `cancelEditing`, and `getEditingPath`. Creation and rename share
`InlineEditSession` and `InlineEditInput`, with at most one active session.
Validation is debounced while typing; Enter/blur waits for
the current validation. Escape cancels. Invalid blur cancels, whereas a disk
submission error retains the text for retry. Late responses are ignored after
editing or disposal. Starting another edit cancels the previous session.
IME composition does not submit. Error messages escape the virtual scroller,
while their accessible descriptions remain in the input's shadow root.

F2 and the Rename context action edit the original row in place. Files initially
select their stem (before the last extension); folders select the whole name.
An unchanged name closes without a disk request. Canceling a rename preserves
the original node. Removing its source, collapsing an ancestor, resetting the
tree, or switching workspaces disposes the session.

Both Tauri commands `validate_workspace_creation` and `create_workspace_entry`
accept `{ expectedRoot, session, parent, name, kind }`. `parent` is relative to
the workspace; `kind` is `newFile` or `newFolder`. Validation returns an error
string or null. Creation returns `{ path, relativePath, kind }`, with an absolute
disk path and workspace-relative tree path. Trailing separators create folders.
The backend checks every segment, directory links, current workspace session,
and actual disk conflicts, then exclusively creates the final item. It removes
only its own still-empty intermediate directories after a failure.

`validate_workspace_rename` and `rename_workspace_entry` accept
`{ expectedRoot, session, source, name }`. `source` is workspace-relative;
the backend derives the source type and parent. A nested name is relative to
that parent. Files reject trailing separators; folders allow them. Validation
returns an error string or null. Commit returns
`{ from, to, relativePath, isDirectory, changed }`, with absolute document paths.
It reuses creation's segment/platform checks, rejects directory links and moves
into descendants, excludes the source itself from conflicts, and supports
case-only Windows renames. Windows uses `MoveFileW` without replacement, so
a destination created after validation cannot be overwritten.

The tree moves only after disk success. A directory-cache guard defers watcher
reads under the source parent during commit and discards in-flight snapshots;
release refreshes affected directories. Tree mutation relocates cached folder
descendants and preserves expansion. Document move protection waits for saves
and rebinds open document paths while retaining dirty buffers. It also drains
in-flight backups before moving and defers new backups until paths are rebound.
Successful disk
moves still rebind documents after a workspace switch; tree updates require the
original workspace epoch. The virtual renderer suppresses the old-path rename
handoff while committing, avoiding repeated attempts to reveal a removed row.

Verification (with the Vite dev server running for browser/desktop checks):

```powershell
npm test
npm run lint
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
node tools/verify-explorer-creation.mjs
node tools/verify-explorer-scroll.mjs
cargo build --manifest-path src-tauri/Cargo.toml
node tools/verify-explorer-creation-desktop.mjs
```

The browser fixture uses real tree rendering and substitutes disk IPC. The
desktop check launches an isolated portable app with WebView2 debugging,
uses actual Tauri commands and disk operations, and preserves the user's
workspace and app data. Reports/screenshots are written under `.verification/`.
Both checks cover rename as well as creation, including nested and case-only
renames, inline errors, and dirty descendant documents; the browser fixture
also delivers structural watcher events before the rename response.
