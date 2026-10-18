# LiteCode implementation ledger

Source of requirements: `DEVELOPMENT_PLAN.md` (2026-10-16). Scope is unchanged.

## Delivery order

1. Lock dependencies; validate Trees and classic Monaco; build the shell, commands and keyboard routing.
2. Implement Rust file authorization, encoding, versioned writes, recovery, watcher, Git and windows; connect document models and editor groups.
3. Implement bounded/cancellable search with buffer overlays, quick access, search documents and coordinated replacement.
4. Connect stdio language clients, configuration and version-checked formatting; verify tool acquisition.
5. Run automated checks, build Windows packages, capture real release/reference screenshots and record measurements.

## Invariants

- Monaco owns text and undo. UI state contains document metadata, never a second live text copy.
- A failed disk operation cannot clear a dirty marker. Writes check the last read disk hash.
- Backups and JSON use atomic replacement. Corrupt recovery data is preserved.
- File access is checked against the calling window's root and explicit file grants.
- Search tasks belong to windows; request IDs reject obsolete results; acknowledgements bound outstanding batches.
- Replacement must retain successful edits and report partial failures; no claim of global atomicity.
- Unverified functionality stays unverified in the matrix. A browser screenshot is not a release-app acceptance screenshot.

## Reference sources

- [VS Code 1.142.0](https://code.visualstudio.com/updates/v1_142), source tag `1.142.0`.
- [Trees public API](https://trees.software/docs), package pinned to `1.0.0-beta.6`.
- [Monaco language client configuration](https://github.com/TypeFox/monaco-languageclient/blob/main/docs/guides/configuration.md); installed package declarations are authoritative for the pinned version.
- [Oxfmt language support](https://oxc.rs/docs/guide/usage/formatter/language-support).

Local VS Code observed at start: 1.141.0, commit `2a59476c9bfcb90b3ddc372c36762471b7dfad1c`; this is not the acceptance reference.
