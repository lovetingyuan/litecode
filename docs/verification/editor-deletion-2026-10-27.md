# Editor deletion verification — 2026-10-27

Deleting files through Explorer closes their editors after each successful
recycle operation. External deletion preserves the buffer and decorates the tab
and breadcrumb file names with a gray strike-through, following the supplied
VS Code screenshot.

## Behavior and coverage

- Explorer's Delete key and context menu use the same existing confirmation.
  When affected files contain unsaved changes, that confirmation includes
  `包含未保存修改，删除后这些修改将丢失。` No second save prompt appears.
- Successful deletions close previews, pinned tabs, shared split views, media,
  and open descendants of deleted folders. Unrelated paths remain open.
  Canceled, failed and unattempted deletions retain their editors.
- The existing move/save coordination also covers deletion: pending saves and
  backups drain before recycling; later saves wait until document disposal.
  Automatic-save timers and models are released; session backups and navigation
  history no longer include successfully deleted editors.
- External deletion preserves text, dirty state and save protection. The tab
  and breadcrumb carry an accessible deletion hint. Only the file name is
  struck through; icons, directory names and close buttons remain normal.
- Deletion alone shows no warning icon or conflict banner. Restoring a file
  clears the decoration; actual content conflicts still preserve unsaved edits.
  Restoring the original revision or saving under another name clears the
  deletion conflict. Permission errors are not marked as deletion.

## Verification

- `npm test`: 36 files and 633 tests passed, including deletion/save concurrency,
  restoration, Save As, comparison-source cleanup and session persistence.
- `npm run build`: TypeScript and production bundle passed; existing browser
  externalization and large-chunk warnings remain.
- `npm run lint`: passed with warnings denied.
- With `npm run dev` running: `node tools/verify-editor-deletion.mjs`.
  Real Edge, tree, dialogs, split editors and Monaco are exercised with isolated
  file IPC fixtures. Five scenario groups cover external deletion/restoration,
  keyboard and menu deletion, cancel, dirty pinned/shared editors, folders,
  clean files and partial batch failure. No browser page errors were observed.
- Browser evidence: `.verification/editor-deletion/result.json`,
  `external-deleted.png`, and `after-internal-deletion.png` in that directory.

The browser fixture does not exercise the Windows recycle bin itself. Backend
recycle behavior and authorization interfaces are unchanged by this change.
