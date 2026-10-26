# Inline merge conflicts

Text editors recognize complete Git conflict blocks, including the ancestor regions
in diff3 and zdiff3 output. Current, incoming and ancestor regions receive distinct
backgrounds and labels. Incomplete or malformed blocks have no destructive actions.

Each conflict offers **Accept Current Change**, **Accept Incoming Change** and
**Accept Both Changes**. Both keeps current content followed by incoming content;
ancestor content and marker lines are removed. Each action is one undoable edit in
the existing document model. The surrounding content, indentation and line endings
are retained. Saving and auto-save follow the normal document settings.

The editor toolbar and command palette provide Previous Conflict and Next Conflict,
with wraparound. Accepting a block does not automatically jump to another block.
The command IDs are `merge-conflict.accept.current`,
`merge-conflict.accept.incoming`, `merge-conflict.accept.both`,
`merge-conflict.previous` and `merge-conflict.next`.

`merge-conflict.codeLens.enabled` and `merge-conflict.decorators.enabled` default to
true and apply immediately. Ordinary text files outside Git repositories also
support conflict markers; no Git repository is required for the inline actions.

Git unmerged files have a separate `!` badge in the file tree, breadcrumb picker
and editor tabs. Removing every text marker does not stage the file or clear its
Git index conflicts. Use Git externally to stage the resolution. The existing
disk-versus-buffer save conflict flow is independent of inline merge conflicts.

## Native acceptance

Run `npm run dev` and build the native debug app if it is not already available.
Then run `node tools/verify-inline-conflicts.mjs`. This Windows acceptance script
uses an isolated portable native app and connects Playwright to its real WebView2
renderer on port 9277. It does not mock IPC or Git.

The script creates `.verification/inline-conflicts-<timestamp>/fixture`, commits a
shared base, edits the same three locations on `main` and `incoming`, and performs
an actual merge with `merge.conflictStyle=diff3`. It clicks the inline actions and
checks exact saved bytes, undo/redo, navigation, settings, split editors, stale
actions, external staging and the existing save-conflict flow.

The fixture is left in its original unmerged state for manual verification. Open
its `merge.txt` in LiteCode to repeat the acceptance. The parent folder contains
screenshots, `original-conflict.txt`, `resolved-result.txt`, `git-status.txt` and
`results.json`. A passing script is native development evidence, not a release-wide
claim of full VS Code parity. Three-way merge and Source Control UI are outside
this feature.

## Verification record (2026-10-26)

- All 529 tests in 32 files pass, including the parser, Git status decorations and
  existing disk save-conflict tests. Type checking, production frontend build,
  lint and patch whitespace checks pass. The build retains its existing bundler
  warnings about external Node modules and large chunks.
- All 10 native acceptance checks pass against real Git and WebView2, including
  breadcrumb decorations, read-only handling and command-palette actions on an
  ordinary untracked text file.
- `node tools/capture-inline-conflicts-reference.mjs` captures the installed
  VS Code 1.143.1 using the same conflict content and compares all six region
  background colors and CodeLens font family, size and line height. These values
  match. The native and reference screenshots and appearance JSON files are stored
  together in the latest acceptance output folder.
- The demo fixture retains `UU merge.txt` and all three Git index stages. Its
  three conflicting regions can be resolved again in the development app.
