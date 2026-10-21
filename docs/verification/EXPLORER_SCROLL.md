# Explorer sticky scroll and sidebar scrollbars

The Explorer enables the existing Trees sticky folder renderer. Its beta.6 patch
limits the stack to 7 rows and 40% of the tree viewport, including virtual row
occlusion, keyboard positioning and editor reveals. Directory names reveal the
canonical row without collapsing it; chevrons collapse directories. The workspace
heading stays outside the scrolling tree. No new setting or persisted state is added.

Search results and the tree's shadow DOM load the same
`src/styles/sidebar-scrollbar.css`. Both use a 12px scrollbar, 2px transparent
thumb border, 7px radius, 24px minimum thumb height and matching normal/hover colors.
The tree's gutter probe uses that CSS too. The existing 32px bottom padding remains
part of the scrollable content.

## Verification

Start `npm run dev`, then run:

```powershell
node tools/verify-explorer-scroll.mjs
node tools/verify-explorer-sync.mjs
$env:LITECODE_TEST_URL='http://localhost:1420'
node tools/verify-explorer-moves.mjs
npm test
npm run lint
npm run build
```

Set `LITECODE_TEST_URL` before running the browser scripts to use another dev port.
The browser fixtures substitute desktop IPC; Trees, its worker, Monaco, browser
layout, mouse drags and keyboard input are real. These checks do not verify native
filesystem operations or the packaged desktop executable.

`verify-explorer-scroll.mjs` checks nested ancestors, Git decoration, sibling
transitions, reverse scrolling, name/chevron actions, context menus, keyboard
navigation, drops onto sticky ancestors, deep/small-view limits, editor reveals,
bottom padding, scrollbar dragging and shared computed scrollbar styles.
It writes screenshots and `report.json` to `.verification/explorer-scroll/`.
The existing sync and move checks distinguish canonical rows from sticky copies.
