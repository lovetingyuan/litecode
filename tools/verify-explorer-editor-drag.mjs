import { workspaceFixtureCommands } from "./explorer-fixture.mjs";
import assert from "node:assert/strict";
import { chromium } from "playwright";

// Run against npm run dev. Real mouse drags exercise the tree's shadow DOM and Monaco;
// only disk IPC is replaced, and any unexpected file operation fails the check.
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const paths = [
  "first.txt",
  "second.txt",
  "third.txt",
  "目录/",
  "目录/文件 name.txt",
  "broken.txt",
  "preview.md",
  "target/",
];
const errors = [];
const operations = [];
let documentsUrl;
page.on("pageerror", (error) => errors.push(String(error)));
page.on("request", (request) => {
  if (!documentsUrl && new URL(request.url()).pathname === "/src/editor/documents.ts") {
    documentsUrl = request.url();
  }
});
await page.exposeFunction("recordOperation", (command) => operations.push(command));
await page.route("**/src/core/bridge.ts*", (route) =>
  route.fulfill({
    contentType: "application/javascript",
    body: `
export const desktop = false;
export const mediaSource = path => path;
export const errorMessage = e => e?.message ?? String(e);
export const channel = fn => ({ onmessage: fn });
export async function bootstrap() {
 return {root:'C:/drag-fixture',documents:[],session:{},recent:[],settings:{},keybindings:[],warnings:[],dataDir:''};
}
export async function call(command, args) {
${workspaceFixtureCommands}
 if(command === 'fixture_workspace_snapshot') return {paths:${JSON.stringify(paths)},git:[],branch:null,warnings:[],truncated:false};
 if(command === 'inspect_file') {
   if(args.path.endsWith('/broken.txt')) throw new Error('Fixture file unavailable');
   return {kind:'text',size:20,stamp:'fixture'};
 }
 if(command === 'read_document') return {text:args.path+' content',encoding:'utf8',eol:'LF',revision:'fixture'};
 if(command === 'plan_file_moves') return args.sources.map(from => ({from, to:args.targetDirectory+'/'+from.split('/').pop()}));
 await window.recordOperation(command);
 throw new Error('Unexpected fixture command: '+command);
}
`,
  }),
);
const row = (name) =>
  page.locator("file-tree-container").locator(`[data-item-path="${name}"]`).first();
const group = (index = 0) => page.locator(".editor-group").nth(index);
const tab = (name, index = 0) =>
  group(index).getByRole("tab", {
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:, unsaved)?$`),
  });
async function documentAction(action, ...args) {
  return page.evaluate(
    async ({ action, args, documentsUrl }) => (await import(documentsUrl))[action](...args),
    { action, args, documentsUrl },
  );
}
async function active(name, index = 0) {
  await page.waitForFunction(
    ({ name, index }) =>
      document
        .querySelectorAll(".editor-group")
        [index]?.querySelector(".editor-tab.active")
        ?.getAttribute("aria-label") === name,
    { name, index },
  );
}
async function retained(name, index = 0) {
  await active(name, index);
  assert.equal(
    await tab(name, index).evaluate((el) => el.classList.contains("preview")),
    false,
    "Drop keeps a regular tab",
  );
}
async function drag(name, destination) {
  await row(name).dragTo(destination);
}
async function syntheticDrop(data, destination) {
  await destination.evaluate((element, data) => {
    const transfer = new DataTransfer();
    transfer.setData("application/litecode-tree", data);
    element.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  }, data);
}
try {
  await page.goto(process.env.LITECODE_TEST_URL ?? "http://localhost:1420");
  await row("first.txt").waitFor();
  await page.evaluate(() => {
    window.dragPayloads = [];
    window.dropEvents = [];
    window.addEventListener(
      "drop",
      (event) =>
        window.dropEvents.push({
          target: event.target.className,
          row: event.composedPath().find((el) => el instanceof HTMLElement && el.dataset.itemPath)
            ?.dataset.itemPath,
          types: [...event.dataTransfer.types],
        }),
      true,
    );
    window.addEventListener("dragstart", (event) =>
      window.dragPayloads.push({
        data: event.dataTransfer.getData("application/litecode-tree"),
        effectAllowed: event.dataTransfer.effectAllowed,
      }),
    );
  });
  await drag("first.txt", group());
  await retained("first.txt");
  assert.deepEqual(await page.evaluate(() => window.dragPayloads.at(-1)), {
    data: JSON.stringify({ root: "C:/drag-fixture", paths: ["first.txt"] }),
    effectAllowed: "copyMove",
  });
  console.log("PASS: actual tree drag reaches an empty editor and keeps a regular tab");

  await group().locator(".monaco-editor").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" unsaved");
  const before = await page.evaluate(async (documentsUrl) => {
    const d = await import(documentsUrl);
    return [...d.models.values()][0].getValue();
  }, documentsUrl);
  await drag("second.txt", group().locator(".monaco-editor .view-lines"));
  await retained("second.txt");
  assert.equal(
    await page.evaluate(
      async (documentsUrl) => [...(await import(documentsUrl)).models.values()][0].getValue(),
      documentsUrl,
    ),
    before,
  );
  assert.equal(await tab("first.txt, unsaved").count(), 1);
  console.log(
    "PASS: dropping onto Monaco opens the file without inserting paths or losing unsaved edits",
  );

  await drag("third.txt", tab("second.txt"));
  await retained("third.txt");
  await drag("third.txt", group().locator(".tabs-toolbar"));
  await retained("third.txt");
  assert.equal(await tab("third.txt").count(), 1);
  assert.equal(await group().getByRole("tab").count(), 3);
  console.log("PASS: drops onto tabs and toolbar work and repeated drops reuse the existing tab");

  await row("目录/").click();
  await row("目录/文件 name.txt").waitFor();
  await drag("目录/文件 name.txt", group().locator(".breadcrumbs"));
  await retained("文件 name.txt");
  const count = await group().getByRole("tab").count();
  await drag("目录/", group().locator(".tabs-toolbar"));
  assert.equal(await group().getByRole("tab").count(), count, "Directories are ignored");
  console.log("PASS: Unicode and spaces survive drag data; directories do not open recursively");

  const splitId = await documentAction("splitGroup");
  // Start from an explicit selection so mouse-down does not collapse a multi-file drag.
  await row("first.txt").click();
  await row("second.txt").click({ modifiers: ["Control"] });
  const sourceActive = await group().locator(".editor-tab.active").getAttribute("aria-label");
  await drag("first.txt", group(1).locator(".monaco-editor"));
  await retained("second.txt", 1);
  assert.equal(await tab("first.txt", 1).count(), 1);
  assert.equal(
    await group().locator(".editor-tab.active").getAttribute("aria-label"),
    sourceActive,
  );
  assert.equal(
    await page.evaluate(() => document.activeElement.closest(".editor-group")?.dataset.groupId),
    splitId,
  );
  const selected = JSON.parse(await page.evaluate(() => window.dragPayloads.at(-1).data));
  assert.deepEqual(selected.paths, ["first.txt", "second.txt"]);
  console.log(
    "PASS: a real multi-selection drag opens each file in the destination split and focuses it",
  );

  const previewId = await documentAction("openPath", "C:/drag-fixture/preview.md", {
    group: splitId,
    pinned: true,
  });
  await documentAction("patchMediaView", splitId, previewId, { mode: "markdown" });
  await group(1).locator(".markdown-preview").waitFor();
  await drag("third.txt", group(1).locator(".markdown-preview"));
  await retained("third.txt", 1);
  console.log("PASS: preview surfaces accept tree drops");

  await syntheticDrop(
    JSON.stringify({ root: "C:/drag-fixture", paths: ["broken.txt", "目录/文件 name.txt"] }),
    group(1),
  );
  await retained("文件 name.txt", 1);
  assert.ok(await page.getByText("Fixture file unavailable", { exact: true }).count());
  await syntheticDrop(JSON.stringify({ root: "C:/old-workspace", paths: ["first.txt"] }), group(1));
  await syntheticDrop("invalid JSON", group(1));
  await syntheticDrop(
    JSON.stringify({ root: "C:/drag-fixture", paths: ["../outside.txt"] }),
    group(1),
  );
  assert.equal(
    await group(1).locator(".editor-tab.active").getAttribute("aria-label"),
    "文件 name.txt",
  );
  console.log(
    "PASS: one failed file does not stop the batch; stale, malformed and foreign paths are ignored",
  );

  await tab("third.txt", 1).click();
  await tab("third.txt", 1).dragTo(tab("preview.md", 1));
  await retained("third.txt", 1);
  const ordered = await group(1).getByRole("tab").allTextContents();
  assert.ok(
    ordered.findIndex((text) => text.includes("third.txt")) <
      ordered.findIndex((text) => text.includes("preview.md")),
  );
  await tab("third.txt", 1).dragTo(group().locator(".monaco-editor"));
  await retained("third.txt");
  assert.equal(await tab("third.txt", 1).count(), 0);
  console.log("PASS: actual tab reorder and cross-group tab drags still work");

  await row("third.txt").click();
  await row("third.txt").dragTo(row("target/"), { targetPosition: { x: 50, y: 13 } });
  await page.getByRole("button", { name: "Cancel", exact: true }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(operations, [], "Editor drops and cancelled tree moves never mutate disk");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: tree-to-tree dragging still requests a move; no disk mutations or browser errors",
  );
} catch (error) {
  console.error(
    await page.evaluate(() => ({
      drags: window.dragPayloads,
      drops: window.dropEvents,
      tabs: [...document.querySelectorAll(".editor-group")].map((g) =>
        [...g.querySelectorAll(".editor-tab")].map((t) => t.getAttribute("aria-label")),
      ),
    })),
  );
  throw error;
} finally {
  await browser.close();
}
