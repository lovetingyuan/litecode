# Windows shell open verification — 2026-11-03

## Behavior

Explorer file, folder and folder-background commands open one target window per
request. A cold explicit open skips the default `main` window and historical
window recovery. Recovery sessions and bodies remain available to the next
normal launch. Existing application windows remain intact.

The installer removes the old `MultiSelectModel=Single` value from the folder
background verb on fresh installation and upgrade. File and folder verbs retain
their single-selection restriction. Command quoting and ownership-aware
uninstallation remain unchanged.

## Checks

- `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib`: 187 passed,
  4 existing ignored tests, 0 failed. Includes startup request consumption,
  consecutive named-pipe requests, path validation and recovery tests.
- `npm test -- --run src/core/workspaceTrust.test.ts`: 21 passed.
- `npm run build`, `npm run lint` and the native debug build passed.
- Rustfmt passed for the modified Rust files. The new desktop verification
  script passed a direct Oxlint check using the project's correctness plugins
  and curly-brace rule (the normal lint configuration excludes `tools/`).
- Clippy completed successfully without denying warnings. Strict
  `--all-targets -- -D warnings` is blocked by 46 existing diagnostics. The
  diagnostics touching modified files refer to unchanged request decoding and
  the existing placement of `data_directory_tests`; no added lines were flagged.

`node tools/verify-shell-open.mjs` passed all eight desktop checks against the
debug executable and production frontend assets served by Vite preview on 1420:

1. Cold file open creates one target window without changing recovery data.
2. A forwarded folder request adds exactly one window.
3. A background `folder\.` request opens the current folder once.
4. A drive-root background argument opens the root once.
5. A normal launch into the running instance adds one empty window.
6. Consecutive requests do not replay the initial target or alter old recovery.
7. Cold folder-background open also skips default and historical windows.
8. The next normal launch restores both historical windows and unsaved bodies.

Fixtures, isolated portable profiles and JSON results are stored under `tmp/`.
The script excludes worker targets from editor-window counts and also checks
native Tauri window labels, so hidden/default windows cannot evade the count.

## Installer and environment notes

An NSIS harness compiled and executed the actual installer macros against an
isolated registry subtree. It verified upgrade removal of the old restriction,
fresh installation, all three quoted commands, removal of owned registrations,
and preservation of another installation's command.

The actual Explorer popup could not be reliably inspected through desktop UI
automation. Menu visibility after installing the updated package still needs
an Explorer smoke check. The existing installed application and its registration
were not changed. Automatic approval rejected deletion of the separate
`HKCU\Software\Classes\Directory\Background\shell\LiteCodeVerification`
probe with `blocked by policy`; its `LegacyDisable` value was set instead, so
the temporary verb is disabled.

The initial `npm ci` failed because the existing lockfile omits two Emnapi
entries. Dependencies were installed without saving or changing the lockfile.
An early desktop attempt during dependency extraction stalled in the Vite
development loader; the completed production frontend passed verification.
