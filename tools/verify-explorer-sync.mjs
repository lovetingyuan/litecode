import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

// Run against npm run dev. Only IPC is mocked; the tree, Worker and Monaco are real.
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(15000);
page.setDefaultNavigationTimeout(60000);
const root = "C:/explorer-fixture";
const first = "alpha/deep/first.txt";
const second = "beta/nested/second.txt";
const files = Array.from(
  { length: 140 },
  (_, index) => `file-${String(index).padStart(3, "0")}.txt`,
);
const paths = ["alpha/", "alpha/deep/", first, "beta/", "beta/nested/", second,
  "CaseDir/", "CaseDir/Mixed.TXT", "unrelated/", "unrelated/keep.txt", ...files];
const output = ".verification/explorer-sync";
const urls = {};
const errors = [];
let restored = false;
page.on("pageerror", (error) => errors.push(String(error)));
page.on("request", (request) => {
  if (new URL(request.url()).pathname === "/src/explorer/workspaceTree.ts") { urls.workspaceTree = request.url(); }
  const name = new URL(request.url()).pathname.match(
    /^\/src\/(?:editor|store|components)\/(documents|store|Explorer)\.tsx?$/,
  )?.[1];
  if (name && !urls[name]) {
    urls[name] = request.url();
  }
});
await page.addInitScript(() => { window.directoryReplies = 0; });
await page.route("**/src/core/bridge.ts*", (route) =>
  route.fulfill({
    contentType: "application/javascript",
    body: `
export const desktop = false;
export const mediaSource = path => path;
export const errorMessage = e => e?.message ?? String(e);
export const channel = fn => ({ onmessage: fn });
export async function bootstrap() {
  const documents = ${JSON.stringify(
    restored
      ? [first, second].map((path) => ({
          id: `file:///${root}/${path}`,
          path: `${root}/${path}`,
          name: path.split("/").at(-1),
          language: "plaintext",
          text: `${path} content`,
          encoding: "utf8",
          eol: "LF",
          revision: "fixture",
          dirty: false,
          version: 1,
        }))
      : [],
  )};
  const session = documents.length ? { groups: [{ id: 'restored', tabs: documents.map(d => d.id),
    active: documents.at(-1).id, preview: null, views: {} }], activeGroup: 'restored' } : {};
  return { root: ${JSON.stringify(root)}, documents, session, recent: [], settings: {},
    keybindings: [], warnings: [], dataDir: '' };
}
export async function call(command, args) {
  if (command === 'inspect_file') return {kind:'text',size:20,stamp:'fixture'};
  if (command === 'workspace_git_status') return {root:args.expectedRoot,session:1,git:[],branch:null,warnings:[]};
  if (command === 'read_workspace_directory') {
    window.scanStarts = (window.scanStarts ?? 0) + 1;
    const snapshot = [...(window.scanPaths ?? ${JSON.stringify(paths)})];
    try {
      await new Promise(resolve => setTimeout(resolve, (window.scanDelay ?? 80) + (window.directoryDelay ?? 0)));
      if (window.scanError) throw new Error(window.scanError);
      const prefix = args.directory ? args.directory.replace(/\\/$/, '') + '/' : '';
      const children = new Set();
      for (const path of snapshot) {
        if (!path.startsWith(prefix) || path === prefix) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        children.add(prefix + (slash >= 0 ? rest.slice(0, slash + 1) : rest));
      }
      window.directoryReplies++;
      return {root:args.expectedRoot,session:1,directory:args.directory,paths:[...children],warnings:[]};
    } finally { window.scanSettled = (window.scanSettled ?? 0) + 1; }
  }
  if (command === 'read_document') return { text: args.path + ' content', encoding: 'utf8', eol: 'LF', revision: 'fixture' };
  throw new Error('Unexpected fixture command: ' + command);
}
`,
  }),
);
const tree = page.locator("file-tree-container");
const row = (path) => tree.locator(`[data-item-path="${path}"]:not([data-file-tree-sticky-row])`).first();
const selected = () => tree.locator('[aria-selected="true"]');
const tab = (path, group = 0) =>
  page
    .locator(".editor-group")
    .nth(group)
    .getByRole("tab", { name: path.split("/").at(-1), exact: true });
async function settle() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
async function action(module, name, ...args) {
  const result = await page.evaluate(
    async ({ url, name, args }) => (await import(url))[name](...args),
    { url: urls[module], name, args },
  );
  await settle();
  return result;
}
const open = (path, options = {}) =>
  action("documents", "openPath", `${root}/${path}`, { pinned: true, ...options });
async function scrollTop(value) {
  return tree.evaluate((host, value) => {
    const scroller = host.shadowRoot.querySelector("[data-file-tree-virtualized-scroll]");
    if (value !== undefined) {
      scroller.scrollTop = value;
    }
    return scroller.scrollTop;
  }, value);
}
async function revealed(path) {
  await row(path).waitFor();
  await page.waitForFunction((path) => {
    const shadow = document.querySelector("file-tree-container")?.shadowRoot;
    const selected = [...(shadow?.querySelectorAll('[aria-selected="true"]') ?? [])];
    const row = selected[0];
    const scroller = shadow?.querySelector("[data-file-tree-virtualized-scroll]");
    if (selected.length !== 1 || row.dataset.itemPath !== path || !scroller) {
      return false;
    }
    const bounds = row.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    return (
      bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1 && viewport.height > 0
    );
  }, path);
}
async function editorFocused() {
  assert.equal(
    await page.evaluate(() => document.activeElement?.closest(".monaco-editor") !== null),
    true,
    "The editor retains DOM focus",
  );
}
async function centered(path) {
  await revealed(path);
  const offset = await row(path).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const scroller = element.getRootNode().querySelector("[data-file-tree-virtualized-scroll]");
    const viewport = scroller.getBoundingClientRect();
    return (bounds.top + bounds.bottom) / 2 - (viewport.top + scroller.clientHeight / 2);
  });
  assert.ok(Math.abs(offset) <= 2, `${path} should be centered, actual offset: ${offset}px`);
}
async function selectionIs(path) {
  assert.deepEqual(
    await selected().evaluateAll((rows) => rows.map((row) => row.dataset.itemPath)),
    [path],
  );
}
async function patchTree(nextPaths, delay = 0) {
  await page.evaluate(({ nextPaths, delay, url }) => {
    window.scanPaths = nextPaths;
    window.directoryDelay = delay;
    window.patchPromise = import(url).then(({ refreshTree }) => refreshTree());
  }, { nextPaths, delay, url: urls.workspaceTree });
}
async function patchAndWait(nextPaths) {
  await patchTree(nextPaths);
  await page.evaluate(() => window.patchPromise);
  await settle();
}
const refreshButton = page.getByRole("button", { name: "Refresh Explorer", exact: true });
const collapseButton = page.getByRole("button", { name: "Collapse Folders", exact: true });
async function manualRefresh(success = true) {
  const before = await page.evaluate(() => ({
    scans: window.scanSettled ?? 0,
    replies: window.directoryReplies,
  }));
  await refreshButton.click();
  await page.waitForFunction((count) => window.scanSettled > count, before.scans);
  if (success) {
    await page.waitForFunction((count) => window.directoryReplies > count, before.replies);
  }
  await page.waitForFunction(async (url) => {
    const { workspaceDirectories } = await import(url);
    return ![...(workspaceDirectories()?.directories.values() ?? [])].some((entry) => entry.promise);
  }, urls.workspaceTree);
  await settle();
}

try {
  await mkdir(output, { recursive: true });
  await page.goto(process.env.LITECODE_TEST_URL ?? "http://localhost:1420");
  await row(files[0]).waitFor();
  await page.mouse.move(1100, 750);
  for (const button of await page.locator(".section-heading .actions button").all()) {
    assert.equal(await button.isVisible(), true, "Toolbar actions stay visible without hover");
  }
  const toolbarLabels = ["New File", "New Folder", "Refresh Explorer", "Collapse Folders"];
  await page.getByRole("button", { name: "New File", exact: true }).focus();
  for (let index = 0; index < toolbarLabels.length; index++) {
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), toolbarLabels[index]);
    if (index < toolbarLabels.length - 1) await page.keyboard.press("Tab");
  }
  for (const height of [820, 600]) {
    await page.setViewportSize({ width: 1280, height });
    await tree.hover();
    await page.mouse.wheel(0, 10000);
    await page.waitForTimeout(150);
    const metrics = await tree.evaluate((host) => {
      const scroller = host.shadowRoot.querySelector("[data-file-tree-virtualized-scroll]");
      const last = host.shadowRoot.querySelector('[data-item-path="file-139.txt"]');
      return {
        bottomGap: scroller.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom,
        outsideGap: host.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom,
        scrollTop: scroller.scrollTop,
        max: scroller.scrollHeight - scroller.clientHeight,
      };
    });
    assert.equal(metrics.bottomGap, 32, "The last row has 32px of scrollable space below it");
    assert.equal(metrics.outsideGap, 0, "No fixed gap is reserved outside the scroller");
    assert.equal(metrics.scrollTop, metrics.max, "The scrollbar reaches the end of the padding");
    if (height === 820) {
      await page.screenshot({ path: `${output}/scrollable-bottom-spacing.png` });
    }
    await scrollTop(metrics.max - 16);
    await page.waitForTimeout(100);
    assert.equal(
      await row(files.at(-1)).evaluate((element) => {
        const scroller = element.getRootNode().querySelector("[data-file-tree-virtualized-scroll]");
        return scroller.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
      }),
      16,
      "The blank space moves with scrolling",
    );
  }
  await page.setViewportSize({ width: 1280, height: 820 });
  await scrollTop(0);
  await settle();
  console.log(
    "PASS: bottom padding belongs to the scroll range and moves with content at both window heights",
  );
  await row(files[0]).click();
  await tab(files[0]).waitFor();
  assert.equal(
    await tab(files[0])
      .getAttribute("class")
      .then((value) => value.includes("preview")),
    true,
  );
  await row(files[0]).dblclick();
  await settle();
  assert.equal(
    await tab(files[0])
      .getAttribute("class")
      .then((value) => value.includes("preview")),
    false,
  );
  console.log("PASS: tree clicks open previews and double-clicks pin files");

  await open(first);
  await revealed(first);
  await editorFocused();
  await open(second);
  await revealed(second);
  // Both groups of ancestors were automatically expanded, then explicitly collapse one.
  await row("alpha/").click();
  await tab(first).click();
  await revealed(first);
  await editorFocused();
  await page.keyboard.type("typed");
  const text = await page.evaluate(
    async (url) => (await import(url)).model().getValue(),
    urls.documents,
  );
  assert.ok(text.includes("typed"), "Typing after switching edits the active file");
  await page.keyboard.press("Control+z");
  await tab(first).press("ArrowRight");
  await revealed(second);
  await page.keyboard.press("Control+Tab");
  await revealed(files[0]);
  console.log(
    "PASS: mouse and keyboard tab switches expand ancestors, select the file and preserve typing focus",
  );

  await open(files[70]);
  await centered(files[70]);
  await open(files[71]);
  await centered(files[71]);
  await tab(files[70]).click();
  await centered(files[70]);
  await tab(files[70]).press("ArrowRight");
  await centered(files[71]);
  const centeredPosition = await scrollTop();
  await open(files[71]);
  assert.equal(await scrollTop(), centeredPosition, "Repeated reveals do not drift");
  await row(files[73]).click();
  await settle();
  assert.equal(
    await scrollTop(),
    centeredPosition,
    "Clicking the tree keeps the row under the pointer",
  );
  await row(files[73]).dblclick();
  await settle();
  assert.equal(await scrollTop(), centeredPosition, "Double-clicking does not move the tree");
  assert.equal(await tab(files[73]).getAttribute("aria-selected"), "true");
  assert.equal(
    await tab(files[73])
      .getAttribute("class")
      .then((value) => value.includes("preview")),
    false,
  );
  console.log(
    "PASS: editor navigation centers files; direct tree clicks and double-clicks keep their position",
  );

  await open(files.at(-1));
  await revealed(files.at(-1));
  const position = await scrollTop();
  assert.ok(position > 0, "An offscreen file scrolls into view");
  await open(files.at(-2));
  await revealed(files.at(-2));
  assert.equal(
    await scrollTop(),
    position,
    "Near the end, centering clamps to the maximum scroll position",
  );
  await scrollTop(0);
  await settle();
  await page.keyboard.type("x");
  await settle();
  assert.equal(await scrollTop(), 0, "Typing does not undo manual scrolling");
  await page.keyboard.press("Control+z");
  await open(files[20], { background: true });
  assert.equal(await scrollTop(), 0, "Background opening does not scroll the tree");
  await open(files.at(-2));
  await revealed(files.at(-2));
  console.log(
    "PASS: centered scrolling clamps at the boundary; manual scrolling and background opening stay put",
  );

  await page.keyboard.press("Control+w");
  await revealed(files.at(-1));
  const group = await action("documents", "splitGroup");
  await scrollTop(0);
  await page.locator(".editor-group").first().locator(".monaco-editor").click();
  await revealed(files.at(-1));
  await open(second, { group });
  await revealed(second);
  await page.locator(".editor-group").first().locator(".monaco-editor").click();
  await revealed(files.at(-1));
  await editorFocused();
  await tab(second, 1).click();
  await revealed(second);
  console.log("PASS: closing tabs and changing editor group follow the current active file");

  await action("store", "setApp", { sidebar: "search" });
  await open(first);
  assert.equal(await tree.isVisible(), false, "Automatic reveal keeps the Search view open");
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("button", { name: "Explorer (Ctrl+Shift+E)", exact: true })
    .click();
  await revealed(first);
  await action("store", "setApp", { sidebar: null });
  await open(second);
  assert.equal(await tree.isVisible(), false, "Automatic reveal keeps the sidebar hidden");
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("button", { name: "Explorer (Ctrl+Shift+E)", exact: true })
    .click();
  await revealed(second);
  const heading = page.locator(".section-heading > button");
  await heading.click();
  await settle();
  assert.equal(await tree.count(), 0, "Manual workspace collapse stays collapsed");
  await heading.click();
  await revealed(second);
  await heading.click();
  await open(first);
  await revealed(first);
  await row("alpha/").click();
  await page.locator(".editor-group").nth(1).locator(".monaco-editor").click();
  await page.keyboard.type("x");
  await settle();
  assert.equal(
    await row("alpha/").getAttribute("aria-expanded"),
    "false",
    "Typing does not reopen manually collapsed ancestors",
  );
  await page.keyboard.press("Control+z");
  await open(first);
  await revealed(first);
  console.log("PASS: hidden views, workspace collapse and folder collapse respect user actions");

  // Refresh must preserve both visible expansion and expansion hidden by a collapsed parent.
  await row("unrelated/").click();
  await row("alpha/").click();
  await page.locator(".editor-group").nth(1).locator(".monaco-editor").click();
  await editorFocused();
  await scrollTop(0);
  await settle();
  await page.evaluate(() => {
    window.refreshFrames = [];
    window.refreshFocus = document.activeElement;
    window.recordRefresh = true;
    const sample = () => {
      if (!window.recordRefresh) {
        return;
      }
      const shadow = document.querySelector("file-tree-container")?.shadowRoot;
      window.refreshFrames.push({
        expanded: ["alpha/", "beta/", "unrelated/"].map((path) =>
          shadow?.querySelector(`[data-item-path="${path}"]`)?.getAttribute("aria-expanded"),
        ),
        scroll: shadow?.querySelector("[data-file-tree-virtualized-scroll]")?.scrollTop,
        focusStable: document.activeElement === window.refreshFocus,
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await patchAndWait([...paths, "unrelated/added.txt", "new/empty/"]);
  assert.equal(
    await row("new/").getAttribute("aria-expanded"),
    "false",
    "New directories start collapsed",
  );
  await patchAndWait([...paths.filter((path) => path !== "unrelated/keep.txt"), "unrelated/"]);
  await patchAndWait(paths);
  await action("Explorer", "refreshTree");
  await settle();
  await action("store", "setApp", {
    gitState: {
      root, session: 1,
      git: [{ path: first, status: "modified" }],
      branch: "main",
      warnings: [],
    },
  });
  await settle();
  const refreshFrames = await page.evaluate(() => {
    window.recordRefresh = false;
    return window.refreshFrames;
  });
  assert.ok(refreshFrames.length > 5, "Sample multiple frames during refresh");
  for (const frame of refreshFrames) {
    assert.deepEqual(
      frame.expanded,
      ["false", "true", "true"],
      "No frame collapses an expanded folder or reopens the active file parent",
    );
    assert.equal(frame.scroll, 0, "Refresh does not recenter the active file");
    assert.equal(frame.focusStable, true, "Refresh keeps DOM focus");
  }
  await row("alpha/").click();
  await row(first).waitFor();
  assert.equal(
    await row("alpha/deep/").getAttribute("aria-expanded"),
    "true",
    "Hidden descendant expansion survives refresh",
  );
  await open(first);
  await revealed(first);
  await scrollTop(120);
  await settle();
  const refreshPosition = await scrollTop();
  await patchAndWait(paths);
  assert.equal(
    await scrollTop(),
    refreshPosition,
    "An unchanged snapshot keeps manual scroll position",
  );
  await open(second);
  await revealed(second);
  await patchAndWait([...paths, "unrelated/new.txt"]);
  await selectionIs(second);
  await editorFocused();
  await patchAndWait(paths);
  console.log(
    "PASS: per-frame refresh checks preserve expansion, hidden descendants, scroll, selection and focus",
  );

  await collapseButton.click();
  await manualRefresh();
  await revealed(second);
  assert.equal(await row("alpha/").getAttribute("aria-expanded"), "false", "Refresh only expands the active file's ancestors");
  assert.equal(await refreshButton.evaluate((button) => document.activeElement === button), true, "Refresh retains button focus");
  await heading.click();
  await manualRefresh();
  await revealed(second);
  assert.equal(await heading.getAttribute("aria-expanded"), "true", "Refresh reopens a collapsed workspace");

  // Delay directory results: reveal must wait for the newly loaded ancestors.
  await open("arriving/deep/new.txt");
  await page.evaluate((paths) => {
    window.scanPaths = [...paths, "arriving/deep/new.txt"];
    window.directoryDelay = 250;
  }, paths);
  await manualRefresh();
  await revealed("arriving/deep/new.txt");
  await page.evaluate(() => { window.scanPaths = undefined; window.directoryDelay = 0; });
  await patchAndWait(paths);

  await open(first);
  await revealed(first);
  await page.evaluate(() => { window.scanDelay = 300; });
  const starts = await page.evaluate(() => window.scanStarts);
  await refreshButton.click();
  await page.waitForFunction((count) => window.scanStarts > count, starts);
  await open(second);
  await revealed(second);
  await collapseButton.click();
  await page.waitForFunction((count) => window.scanSettled >= count, starts + 1);
  await revealed(second);
  await page.evaluate(() => { window.scanDelay = 80; });

  await collapseButton.click();
  await page.evaluate(() => { window.scanError = "Fixture refresh failure"; });
  await manualRefresh(false);
  assert.equal(await row("beta/").getAttribute("aria-expanded"), "false", "Failed refresh does not reopen folders");
  assert.equal(await page.getByRole("status").innerText(), "Fixture refresh failure");
  await page.evaluate(() => { window.scanError = undefined; });
  await page.getByRole("button", { name: "Dismiss Notification" }).click();

  for (const kind of ["untitled", "outside", "missing", "none"]) {
    if (kind === "untitled") await action("documents", "newDocument");
    if (kind === "outside") await action("documents", "openPath", "C:/outside/file.txt", { pinned: true });
    if (kind === "missing") await open("not-indexed.txt");
    if (kind === "none") {
      await page.evaluate(async (url) => {
        const { useApp, setApp } = await import(url);
        const state = useApp.getState();
        setApp({ groups: state.groups.map((group) => group.id === state.activeGroup ? { ...group, active: null } : group) });
      }, urls.store);
    }
    await manualRefresh();
    assert.equal(await row("beta/").getAttribute("aria-expanded"), "false", `${kind} file does not reopen folders`);
  }
  await open(second);
  await revealed(second);
  console.log("PASS: manual refresh reveals the latest active file after directory reads, retains focus, handles invalid files and errors; toolbar stays visible and keyboard accessible");

  await open("arriving/deep/new.txt");
  await patchAndWait([...paths, "arriving/deep/new.txt"]);
  await revealed("arriving/deep/new.txt");
  await patchAndWait(paths);
  await open(first);
  await revealed(first);
  console.log("PASS: opening a new file waits for the snapshot that first contains it");

  await action("documents", "newDocument");
  await selectionIs(first);
  await action("documents", "openPath", "C:/explorer-fixture-other/file.txt", { pinned: true });
  await selectionIs(first);
  await open("not-indexed.txt");
  await selectionIs(first);
  await action("documents", "openPath", `c:\\EXPLORER-FIXTURE\\casedir\\mixed.txt`, {
    pinned: true,
  });
  await revealed("CaseDir/Mixed.TXT");
  console.log(
    "PASS: untitled, missing and external files are ignored; Windows separators and casing resolve correctly",
  );

  await open(first);
  await open(second);
  await action("documents", "navigate", -1);
  await revealed(first);
  await action("documents", "navigate", 1);
  await revealed(second);
  console.log("PASS: back and forward navigation keep the tree in sync");

  await action("store", "setApp", { sidebar: "search" });
  await action("Explorer", "revealInTree", `${root}/${first}`);
  await revealed(first);
  await page.waitForFunction((path) => {
    const host = document.querySelector("file-tree-container");
    return (
      document.activeElement === host && host.shadowRoot.activeElement?.dataset.itemPath === path
    );
  }, first);
  await open(second);
  await editorFocused();
  await action("Explorer", "refreshTree");
  await revealed(second);
  await editorFocused();
  await patchTree([...paths, "stale/old.txt"], 300);
  await open(first);
  await patchTree([...paths, "latest/added.txt"]);
  await open(second);
  await revealed(second);
  await row("latest/").waitFor({ state: "attached" });
  await page.waitForTimeout(400);
  assert.equal(
    await row("latest/").count(),
    1,
    "A stale directory response cannot replace the newest tree",
  );
  await selectionIs(second);
  await patchTree([...paths, "pending/ready.txt"], 200);
  await action("Explorer", "revealInTree", `${root}/${first}`);
  await open(second);
  await row("pending/").waitFor({ state: "attached" });
  await revealed(second);
  await editorFocused();
  await page.screenshot({ path: `${output}/linked.png` });
  console.log(
    "PASS: explicit reveals focus the tree; refresh and out-of-order directory responses follow the latest editor",
  );

  restored = true;
  await page.reload();
  await revealed(second);
  assert.equal(
    await tree.evaluate((host) => document.activeElement === host),
    false,
    "Restoration does not transfer focus into the tree",
  );
  await page.screenshot({ path: `${output}/restored.png` });
  assert.deepEqual(errors, []);
  console.log("PASS: session restoration waits for asynchronous tree data; no browser page errors");
  await patchTree(["only.txt"]);
  await row("only.txt").waitFor();
  assert.equal(await scrollTop(), 0, "Shrinking the tree clamps the previous scroll position");
  assert.equal(
    await tree.evaluate((host) => {
      const scroller = host.shadowRoot.querySelector("[data-file-tree-virtualized-scroll]");
      return scroller.scrollHeight - scroller.clientHeight;
    }),
    0,
    "A short tree does not gain an unnecessary scrollbar",
  );
  console.log("PASS: short trees remain at the top without unnecessary scrolling");

  await patchAndWait(["same/deep/a.txt"]);
  await row("same/").click();
  await row("same/deep/").click();
  await page.evaluate(() => { window.scanDelay = 300; });
  const workspaceRefreshStarts = await page.evaluate(() => window.scanStarts);
  await refreshButton.click();
  await page.waitForFunction((count) => window.scanStarts > count, workspaceRefreshStarts);
  await patchTree(["same/deep/a.txt", "stale-root/a.txt"], 300);
  await action("store", "setApp", { root: "C:/other-workspace" });
  assert.equal(
    await row("same/").count(),
    0,
    "Changing roots clears the previous workspace immediately",
  );
  await page.evaluate(() => {
    window.directoryDelay = 0;
  });
  await patchTree(["same/deep/new.txt", "fresh.txt"]);
  await row("fresh.txt").waitFor();
  await page.waitForFunction((count) => window.scanSettled >= count, workspaceRefreshStarts + 1);
  await page.waitForTimeout(400);
  assert.equal(
    await row("same/").getAttribute("aria-expanded"),
    "false",
    "Another workspace starts with fresh expansion",
  );
  assert.equal(
    await row("stale-root/").count(),
    0,
    "A delayed result from another workspace is discarded",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: workspace switches cancel manual refresh, reset expansion and reject delayed results from the previous root",
  );
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
  console.error(
    await tree
      .evaluate((host) => ({
        selected: [...host.shadowRoot.querySelectorAll('[aria-selected="true"]')].map(
          (row) => row.dataset.itemPath,
        ),
        scroll: host.shadowRoot
          .querySelector("[data-file-tree-virtualized-scroll]")
          ?.getBoundingClientRect()
          .toJSON(),
        rows: [...host.shadowRoot.querySelectorAll("[data-item-path]")]
          .slice(0, 12)
          .map((row) => ({
            path: row.dataset.itemPath,
            bounds: row.getBoundingClientRect().toJSON(),
          })),
      }))
      .catch(() => null),
  );
  throw error;
} finally {
  await browser.close();
}
