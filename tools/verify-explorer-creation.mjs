import { workspaceFixtureCommands } from "./explorer-fixture.mjs";
import {
  offscreenCreationPaths,
  verifyOffscreenCreation,
} from "./verify-explorer-offscreen-creation.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

// Real tree, focus, virtual scroll and Monaco; disk IPC is a mutable fixture.
const root = "C:/creation-fixture";
const initial = [
  "src/dir/existing.txt",
  ...Array.from({ length: 80 }, (_, i) => `src/dir/file-${String(i).padStart(3, "0")}.txt`),
  "src/empty/",
  "src/assets",
  "src/b.txt",
  "root.txt",
  ...Array.from({ length: 100 }, (_, i) => `z-folder-${String(i).padStart(3, "0")}/`),
];
let fixturePaths = [...offscreenCreationPaths, "src/"];
const output = ".verification/explorer-creation";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(15000);
const errors = [];
const checks = [];
const record = checks.push.bind(checks);
checks.push = (message) => {
  console.log(message);
  return record(message);
};
let storeURL;
page.on("pageerror", (error) => errors.push(String(error)));
page.on("request", (request) => {
  if (new URL(request.url()).pathname === "/src/store/store.ts") {
    storeURL = request.url();
  }
});
await page.route("**/src/core/bridge.ts*", (route) =>
  route.fulfill({
    contentType: "application/javascript",
    body: `
export const desktop = false;
export const mediaSource = path => path;
export const errorMessage = e => e?.message ?? String(e);
export const channel = fn => ({onmessage:fn});
export async function bootstrap() { return {root:${JSON.stringify(root)},documents:[],session:{sidebarWidth:340},recent:[],settings:{},keybindings:[],warnings:[],dataDir:''}; }
window.creationPaths = ${JSON.stringify(fixturePaths)};
window.creationCalls = [];
window.renameCalls = [];
export async function call(command, args) {
${workspaceFixtureCommands}
 if (command === 'fixture_workspace_snapshot') return {paths:window.creationPaths,git:[],branch:null,warnings:[],truncated:false};
 if (command === 'quick_file_paths') return {root:${JSON.stringify(root)},paths:window.creationPaths.filter(p=>!p.endsWith('/')),excludes:{}};
 if (command === 'inspect_file') return {kind:'text',size:20,stamp:'fixture'};
 if (command === 'read_document') return {text:'fixture content',encoding:'utf8',eol:'LF',revision:'fixture'};
 if (command === 'language_document') return;
 if(command === 'validate_workspace_rename' || command === 'rename_workspace_entry') {
  const source=args.source.replace(/\\/$/,'');
  const name=args.name.replace(/\\\\/g,'/').replace(/\\/+$/,'');
  const parent=source.split('/').slice(0,-1).join('/');
  const target=(parent?parent+'/':'')+name;
  const same=source.toLowerCase()===target.toLowerCase();
  const exists=!same&&window.creationPaths.some(p=>p.replace(/\\/$/,'').toLowerCase()===target.toLowerCase());
  if(command==='validate_workspace_rename') return exists?'A file or folder already exists at this location.':null;
  window.renameCalls.push({...args});
  if(window.failNextRename) {window.failNextRename=false;throw new Error('Permission denied');}
  if(exists) throw new Error('Already exists');
  const directory=window.creationPaths.some(p=>p.startsWith(source+'/'));
  window.creationPaths=window.creationPaths.map(p=>p===source?target:p.startsWith(source+'/')?target+p.slice(source.length):p);
  // Simulate a watcher arriving before the rename IPC response.
  await (await import('/src/explorer/workspaceTree.ts')).handleWorkspaceChanges({root:${JSON.stringify(root)},session:1,changes:[{path:source,structural:true},{path:target,structural:true}],rescan:false,gitChanged:false});
  return {from:${JSON.stringify(root)}+'/'+source,to:${JSON.stringify(root)}+'/'+target,relativePath:target,isDirectory:directory,changed:source!==target};
 }
 if (command === 'validate_workspace_creation' || command === 'create_workspace_entry') {
  const name = args.name.replace(/\\\\/g,'/');
  const path = (args.parent ? args.parent + '/' : '') + name.replace(/\\/+$/,'');
  const existing = window.creationPaths.some(p=>p.replace(/\\/$/,'').toLowerCase()===path.toLowerCase());
  if(command === 'validate_workspace_creation') return existing ? 'A file or folder '+args.name+' already exists at this location. Please choose a different name.' : null;
  window.creationCalls.push({...args});
  if(window.failNextCreation) { window.failNextCreation=false; throw new Error('Permission denied'); }
  if(existing) throw new Error('Already exists');
  const folder = args.kind === 'newFolder' || name.endsWith('/');
  window.creationPaths.push(path+(folder?'/':''));
  return {path:${JSON.stringify(root)}+'/'+path,relativePath:path,kind:folder?'newFolder':'newFile'};
 }
 throw new Error('Unexpected fixture command: '+command);
}
`,
  }),
);
const tree = page.locator("file-tree-container");
const input = tree.locator("[data-file-tree-creation-input]");
const renameInput = tree.locator("[data-file-tree-rename-input]");
const row = (path) =>
  tree.locator(
    `[data-item-path="${path}"]:not([data-file-tree-sticky-row]):not([data-item-parked="true"])`,
  );
const error = page.locator("[data-file-tree-creation-error]");
const settle = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
async function toolbar(name) {
  await page.locator(".section-heading").hover();
  await page.getByRole("button", { name, exact: true }).click();
  await input.waitFor();
  await settle();
}
async function reveal(path) {
  await page.evaluate(
    async (path) => (await import("/src/components/Explorer.tsx")).revealInTree(path),
    `${root}/${path}`,
  );
  await row(path).waitFor();
  await settle();
  await page.waitForTimeout(180); // Virtual rows suppress pointer input briefly after scrolling.
}
async function menu(path, name) {
  const sticky = tree.locator(`[data-file-tree-sticky-path="${path}"]`);
  if (await sticky.isVisible()) await sticky.click({ button: "right" });
  else {
    await reveal(path);
    await row(path).click({ button: "right" });
  }
  await page.getByRole("menuitem", { name: `${name}…`, exact: true }).click();
  await input.waitFor();
  await settle();
}
async function visibleInput(locator = input) {
  const state = await locator.evaluate((element) => {
    const shadow = element.getRootNode();
    const view = shadow
      .querySelector("[data-file-tree-virtualized-scroll]")
      .getBoundingClientRect();
    const sticky = [...shadow.querySelectorAll("[data-file-tree-sticky-row]")].filter(
      (e) => getComputedStyle(e).visibility !== "hidden",
    );
    return {
      top: element.getBoundingClientRect().top,
      bottom: element.getBoundingClientRect().bottom,
      start: Math.max(view.top, ...sticky.map((e) => e.getBoundingClientRect().bottom)),
      end: view.bottom,
      focused: shadow.activeElement === element,
    };
  });
  assert(state.focused, "The input must receive DOM focus");
  assert(state.top >= state.start - 1 && state.bottom <= state.end + 1, JSON.stringify(state));
}
try {
  await mkdir(output, { recursive: true });
  await page.goto(process.env.LITECODE_TEST_URL ?? "http://127.0.0.1:1420", { timeout: 60000 });
  await row("src/").waitFor();
  const offscreen = await verifyOffscreenCreation(page);
  const creations = await page.evaluate(() => window.creationCalls);
  assert.equal(creations.length, offscreen.length);
  assert(creations.every((call) => call.parent === "scripts"));
  for (const result of offscreen) {
    assert(
      !(await page.evaluate(() => window.creationPaths)).some(
        (path) => path.replace(/\/$/, "") === result.canceledPath,
      ),
    );
  }
  fixturePaths = initial;
  await page.reload();
  await row("src/").waitFor();
  checks.push(
    "Offscreen folder/file selections keep one visible focused input across overscan and sticky transitions; Enter commits into scripts and Escape leaves disk untouched",
  );
  await toolbar("New Folder");
  assert.equal(await input.inputValue(), "");
  await visibleInput();
  await input.fill("canceled");
  await page.keyboard.press("Escape");
  await input.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.creationCalls.length), 0);
  checks.push("Root toolbar creates an empty focused row; Escape leaves disk untouched");
  await toolbar("New File");
  await input.fill("must-not-create.txt");
  await toolbar("New Folder");
  assert.equal(await input.inputValue(), "");
  await input.press("Escape");
  assert.equal(await page.evaluate(() => window.creationCalls.length), 0);
  checks.push("Triggering creation again cancels the previous draft without submitting it");

  await row("src/").click();
  await row("src/dir/").click();
  await menu("src/", "New File");
  await visibleInput();
  const order = await tree
    .locator(
      '[data-item-path^="src/"]:not([data-file-tree-sticky-row]):not([data-item-parked="true"])',
    )
    .evaluateAll((elements) =>
      elements.map((e) => ({ path: e.dataset.itemPath, creation: e.dataset.fileTreeCreating })),
    );
  const draftIndex = order.findIndex((item) => item.creation === "true");
  assert(draftIndex > order.findIndex((item) => item.path === "src/empty/"));
  assert(draftIndex < order.findIndex((item) => item.path === "src/assets"));
  await input.fill("assets");
  await error.waitFor();
  assert.equal(await input.getAttribute("aria-invalid"), "true");
  await page.keyboard.press("Enter");
  assert.equal(await input.count(), 1);
  await page.locator(".explorer").screenshot({ path: `${output}/01-duplicate.png` });
  await input.fill("CON.txt");
  await page.waitForFunction(() =>
    document.querySelector("[data-file-tree-creation-error]")?.textContent.includes("reserved"),
  );
  await input.fill("nested/ui/中文.tsx");
  await page.keyboard.press("Enter");
  await input.waitFor({ state: "detached" });
  await row("src/nested/ui/中文.tsx").waitFor();
  assert.equal((await page.evaluate(() => window.creationCalls)).at(-1).parent, "src");
  checks.push(
    "Context menu calculates parent and insertion index, rejects duplicate/illegal names, and creates nested paths",
  );

  await menu("src/empty/", "New Folder");
  await input.fill("retry");
  await page.evaluate(() => {
    window.failNextCreation = true;
  });
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () =>
      document.querySelector("[data-file-tree-creation-error]")?.textContent ===
      "Permission denied",
  );
  assert.equal(await input.inputValue(), "retry");
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
  await row("src/empty/retry/").waitFor();
  await settle();
  assert.equal(
    await row("src/empty/retry/").evaluate(
      (element) => element.getRootNode().activeElement === element,
    ),
    true,
  );
  checks.push("A disk error preserves text and permits retry; folders are revealed after creation");

  await menu("src/", "New File");
  await input.fill("assets");
  await error.waitFor();
  await page.locator(".editor-tab.active").click();
  await input.waitFor({ state: "detached" });
  await menu("src/b.txt", "New File");
  await input.fill("blur-created.txt");
  await page.locator(".editor-tab.active").click();
  await input.waitFor({ state: "detached" });
  assert((await page.evaluate(() => window.creationPaths)).includes("src/blur-created.txt"));
  checks.push("Invalid blur cancels; valid blur commits into the selected file's parent");

  // Explicit root menu ignores stale tree focus and scrolls past 100 folders.
  await page.locator(".section-heading > button").click({ button: "right" });
  await page.getByRole("menuitem", { name: "New File…", exact: true }).click();
  await input.waitFor();
  await settle();
  await visibleInput();
  await input.fill("root-created.txt");
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
  });
  assert.equal(await input.count(), 1);
  await input.evaluate((element) =>
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
  );
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
  assert.equal((await page.evaluate(() => window.creationCalls)).at(-1).parent, "");
  checks.push(
    "Root context ignores old selection, reveals below sticky rows, and Enter respects IME composition",
  );

  await reveal("src/b.txt");
  await row("src/b.txt").click();
  await page.keyboard.press("F2");
  await renameInput.waitFor();
  await settle();
  await visibleInput(renameInput);
  assert.deepEqual(
    await renameInput.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [0, 1],
  );
  await renameInput.press("Enter");
  await renameInput.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.renameCalls.length), 0);
  await page.keyboard.press("F2");
  await renameInput.waitFor();
  await renameInput.fill("assets");
  await error.waitFor();
  await renameInput.press("Enter");
  assert.equal(await renameInput.count(), 1);
  await page.locator(".explorer").screenshot({ path: `${output}/03-rename-error.png` });
  await renameInput.press("Escape");
  assert.equal(await row("src/b.txt").count(), 1);
  checks.push(
    "F2 uses the shared editor, selects the stem, skips unchanged names and retains duplicate errors inline",
  );

  await page.keyboard.press("F2");
  await renameInput.waitFor();
  await renameInput.fill("assets");
  await error.waitFor();
  await page.locator(".editor-tab.active").click();
  await renameInput.waitFor({ state: "detached" });
  assert.equal(await row("src/b.txt").count(), 1);
  assert.equal(await page.evaluate(() => window.renameCalls.length), 0);
  await row("src/b.txt").click();
  checks.push("Invalid rename blur restores the original node without touching disk");

  await page.evaluate(async () => {
    const { useApp } = await import("/src/store/store.ts");
    const documents = await import("/src/editor/documents.ts");
    const doc = Object.values(useApp.getState().docs).find((doc) =>
      doc.path?.endsWith("/src/b.txt"),
    );
    documents.models.get(doc.id).setValue("unsaved rename content");
  });
  await page.keyboard.press("F2");
  await renameInput.waitFor();
  await renameInput.fill("renamed/deep/b2.txt");
  await renameInput.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
  });
  assert.equal(await page.evaluate(() => window.renameCalls.length), 0);
  await renameInput.evaluate((element) =>
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
  );
  await page.evaluate(() => {
    window.failNextRename = true;
  });
  await renameInput.press("Enter");
  await page.waitForFunction(
    () =>
      document.querySelector("[data-file-tree-edit-error]")?.textContent === "Permission denied",
  );
  await renameInput.press("Enter");
  await renameInput.waitFor({ state: "detached" });
  await row("src/renamed/deep/b2.txt").waitFor();
  assert(
    await page.evaluate(async () => {
      const { useApp } = await import("/src/store/store.ts");
      const { models } = await import("/src/editor/documents.ts");
      const doc = Object.values(useApp.getState().docs).find((doc) =>
        doc.path?.endsWith("/src/renamed/deep/b2.txt"),
      );
      return doc?.dirty && models.get(doc.id)?.getValue() === "unsaved rename content";
    }),
  );
  checks.push(
    "Nested rename respects IME, waits for disk, retries errors and rebinds dirty buffers despite early watcher events",
  );

  await page.keyboard.press("F2");
  await renameInput.waitFor();
  await renameInput.fill("B2.TXT");
  await page.locator(".editor-tab.active").click();
  await renameInput.waitFor({ state: "detached" });
  await row("src/renamed/deep/B2.TXT").waitFor();
  await reveal("src/dir/existing.txt");
  await row("src/dir/existing.txt").click();
  await page.evaluate(async () => {
    const { useApp } = await import("/src/store/store.ts");
    const { models } = await import("/src/editor/documents.ts");
    const doc = Object.values(useApp.getState().docs).find((doc) =>
      doc.path?.endsWith("/src/dir/existing.txt"),
    );
    models.get(doc.id).setValue("dirty descendant");
  });
  const stickyDir = tree.locator('[data-file-tree-sticky-path="src/dir/"]');
  if (await stickyDir.isVisible()) await stickyDir.click({ button: "right" });
  else await row("src/dir/").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
  await renameInput.waitFor();
  await settle();
  assert.equal(await renameInput.inputValue(), "dir");
  assert.deepEqual(
    await renameInput.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [0, 3],
  );
  await renameInput.fill("relocated/nested/");
  await renameInput.press("Enter");
  await renameInput.waitFor({ state: "detached" });
  await row("src/relocated/nested/").waitFor();
  assert(
    await page.evaluate(async () => {
      const { useApp } = await import("/src/store/store.ts");
      const { models } = await import("/src/editor/documents.ts");
      const doc = Object.values(useApp.getState().docs).find((doc) =>
        doc.path?.endsWith("/src/relocated/nested/existing.txt"),
      );
      return doc?.dirty && models.get(doc.id)?.getValue() === "dirty descendant";
    }),
  );
  checks.push(
    "Valid rename blur supports case changes; folder context rename preserves dirty descendants and expansion",
  );

  await toolbar("New Folder");
  await page.setViewportSize({ width: 900, height: 400 });
  await input.fill("CON.txt");
  await error.waitFor();
  const bounds = await error.boundingBox();
  assert(bounds.y >= 0 && bounds.y + bounds.height <= 400);
  await page.locator(".explorer").screenshot({ path: `${output}/02-small-viewport.png` });
  await page.evaluate(
    async (url) => (await import(url)).setApp({ root: "C:/other-workspace" }),
    storeURL,
  );
  await input.waitFor({ state: "detached" });
  assert.equal(await error.count(), 0);
  checks.push("Error messages fit short viewports; workspace changes dispose drafts and messages");
  assert.deepEqual(errors, []);
  await writeFile(`${output}/report.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  console.error(error);
  await page.screenshot({ path: `${output}/failure.png`, timeout: 3000 }).catch(() => {});
  console.error(await page.locator("body").innerText());
  console.error(errors);
  console.error(
    await page.evaluate(() => ({
      created: window.creationCalls,
      renamed: window.renameCalls,
      files: window.creationPaths?.filter((path) => !path.startsWith("z-folder")),
    })),
  );
  throw error;
} finally {
  await browser.close();
}
