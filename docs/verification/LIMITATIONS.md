# Outstanding acceptance work

This is an initial working implementation. DEVELOPMENT_PLAN.md remains the agreed scope; the complete plan has **not** passed acceptance.

## Functional gaps

- Quick Search and Quick Open still lack live result previews and full VS Code ranking/selection parity. Quick Search has an independent cancellable query and a Search View handoff.
- Search tree results currently group by file, with a list alternative; nested folder result operations and the complete VS Code glob/ignore/encoding differential suite are incomplete. Open-buffer ignore matching needs further alignment. Closed files larger than 20 MiB are omitted by search; the search view currently reports this only alongside the result cap.
- Replacement journals preserve successful disk edits and version-check undo/redo. Frontend linked undo history does not survive application restart; partial replay still requires more coordination work. Crash recovery of a journal interrupted between disk write and journal update is incomplete.
- Save As and Explorer rename update model URI, language-service document, labels and navigation paths. They recreate the Monaco model and reset that document's local undo history. External renames appear as deletion/conflict rather than an automatically followed rename.
- Multiple windows work, but automatic reopening of the complete previous window set is incomplete. Editor group widths are equal; group resizing, MRU editor switching and detailed focus parity remain incomplete.
- User/workspace settings and user keybindings are supported. Keybinding context expressions support booleans, equality, parentheses, AND/OR/NOT; regex and membership operators and the complete VS Code context-key catalog are not implemented. The import command produces a supported/ignored settings review without modifying the source.
- Git status is computed in the background and rendered by Trees, but repository caching/incremental indexing and the complete nested-repository/worktree/conflict fixture suite are incomplete.
- HTML/CSS/JSON service smoke tests and JSON/TypeScript Native diagnostics in the desktop application are exercised. Per-language semantic/navigation/refactoring capability acceptance, Rust/old-project TypeScript tests, configured range formatting and EditorConfig parity remain incomplete. Unsupported server capabilities must not be inferred from syntax highlighting.
- Tool acquisition uses pinned Node SHA-256 and npm lockfile integrity, staging and a retained previous installation. Successful in-app download, interrupted-install cleanup, offline reinstall, activation rollback and cancellation remain incompletely verified. The latest download attempt failed while receiving the HTTP response; no downloaded runtime was installed by that failed attempt.
- Files over 20 MiB require explicit confirmation; files over 100 MiB are rejected. Streaming ultra-large-file handling is not implemented.

## Acceptance gaps

- Fixed VS Code 1.142.0 binary download fails during TLS handshake in this environment. The expected build is `6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1`, archive SHA-256 `ace1da7d1432d43c1ab4b2bbf643f6494f6d25dec07494976755eac522cd50d9`. These identify the intended reference; the archive has not been obtained and verified locally.
- Captures are real application development/Release evidence as labeled. None establish paired visual acceptance against the required reference. 100% display, IME, multi-monitor and native picker/recycle interactions require further verification.
- The installer is built, but clean-machine install/upgrade/uninstall and the WebView2 bootstrap prompt have not been accepted.
- Resource snapshots are observations of one machine and fixture. They are not performance guarantees or the complete planned workload report.

See MATRIX.md, desktop-results.json and language-server-results.json for the evidence that actually exists. A passing build or a similar screenshot does not close the remaining rows.
