# Explorer paste verification — 2026-10-27

Internal and native clipboard copies paste immediately without a confirmation
dialog. Conflicting names use VS Code simple incremental naming (`a copy.txt`,
`a copy 2.txt`, `folder copy`). Existing destinations and source contents are
preserved. The backend returns the actual destination so the tree can select it.
Cut/move and manual rename behavior is unchanged.

## Automated checks

- `npm test`: 36 files, 622 tests passed.
- `npm run build`: passed (existing browser externalization and chunk-size warnings).
- `npm run lint`: passed.
- `cargo build --manifest-path src-tauri/Cargo.toml --bin litecode`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml file_clipboard --lib`: 14 passed.
- `node tools/verify-explorer-paste.mjs`: all 12 desktop scenarios passed using
  the development executable. Local evidence (results JSON and screenshot):
  `.verification/explorer-paste-1793091662235/`.
- Changed Rust files pass `rustfmt --edition 2024 --check`.
- Full Rust library suite: 115 passed, 2 failed, 4 ignored. Both failures are Git
  remote tests whose Git for Windows shell exits with `fatal error - add_item`
  while initializing its installation path; no clipboard test failed.
- Repository-wide `cargo fmt --check` also reports formatting differences in
  unrelated Git/workspace code; only the changed Rust files were formatted.

## Coverage

Rust tests cover in-place and repeated copies, same-name selections from different
directories, extension and dotfile naming, Unicode, file/directory collisions,
Windows case-insensitive collisions, nested and empty directories, stale clipboard
sequences, partial failure, exclusive creation, and source link rejection.
Frontend tests cover immediate dispatch, clipboard changes, workspace cancellation,
actual returned destination paths, and preserving cut/save/document bindings.

The desktop fixture uses the real Windows clipboard, Tauri IPC, and WebView2,
with a separate WebView2 profile. It restores the original clipboard on exit.
It verifies keyboard/context-menu/root/empty-tree paste, internal same-directory
and cross-directory conflicts, selected actual destinations, Unicode folders and
empty descendants, native text paste in rename inputs, cut/move, stale clipboard
and workspace requests, access boundaries, and partial-failure reporting.
