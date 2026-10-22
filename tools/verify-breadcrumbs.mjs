import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { workspaceFixtureCommands } from "./explorer-fixture.mjs";

// Real Popover, Trees shadow DOM, keyboard input and Monaco; only disk IPC is mocked.
const root = "C:/breadcrumbs-fixture";
const paths = ["README.md", "icon.svg", "root.ts", "src/", "src/a.ts", "src/b.ts", "src/nested/", "src/nested/deep.ts", "src/empty/", "src/fail/", "src/fail/recovered.ts", "src/large/", ...Array.from({ length: 200 }, (_, i) => `src/large/file-${i}.ts`), "目录/", "目录/文件 name.ts"];
const output = ".verification/breadcrumbs";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(15000);
page.setDefaultNavigationTimeout(60000);
const errors = [];
const checks = [];
const urls = {};
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => { if (message.type() === "error") { errors.push(message.text()); } });
page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
page.on("request", (request) => {
  const match = new URL(request.url()).pathname.match(/^\/src\/(?:editor\/documents|store\/store|explorer\/workspaceTree)\.ts$/);
  if (match) { urls[match[0].split("/").at(-1).split(".")[0]] ??= request.url(); }
});
await page.route("**/src/core/bridge.ts*", (route) => route.fulfill({ contentType: "application/javascript", body: `
export const desktop = false;
export const mediaSource = path => path;
export const errorMessage = error => error?.message ?? String(error);
export const channel = fn => ({ onmessage: fn });
window.breadcrumbFixture = { paths: ${JSON.stringify(paths)}, reads: [], fail: null, delay: null };
export async function bootstrap() { return {root:${JSON.stringify(root)},documents:[],session:{},recent:[],settings:{},keybindings:[],warnings:[],dataDir:''}; }
export async function call(command, args) {
 if (command === 'read_workspace_directory') {
   window.breadcrumbFixture.reads.push(args.directory);
   if (window.breadcrumbFixture.delay === args.directory) await new Promise(resolve => { window.breadcrumbResolve = resolve; });
   if (window.breadcrumbFixture.fail === args.directory) throw new Error('Fixture access denied');
 }
${workspaceFixtureCommands}
 if (command === 'fixture_workspace_snapshot') return {paths:window.breadcrumbFixture.paths,git:[{path:'src/b.ts',status:'modified'}],branch:null,warnings:[]};
 if (command === 'inspect_file') return {kind:args.path.endsWith('.svg')?'svg':'text',size:50,stamp:'fixture'};
 if (command === 'read_document') return {text:args.path.endsWith('.svg')?'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>':'# Fixture\\nexport const value = 1;',encoding:'utf8',eol:'LF',revision:'fixture'};
 if (command === 'language_document') return;
 throw new Error('Unexpected fixture command: '+command);
}
` }));
const popup = page.locator(".breadcrumb-popup");
const tree = popup.locator("file-tree-container");
const row = (path) => tree.locator(`[data-item-path="${path}"]:not([data-item-parked="true"])`);
const group = (index = 0) => page.locator(".editor-group").nth(index);
const crumb = (label, index = 0) => group(index).getByRole("button", { name: `Browse siblings of ${label}`, exact: true });
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function moduleCall(module, action, ...args) {
  return page.evaluate(async ({ url, action, args }) => (await import(url))[action](...args), { url: urls[module], action, args });
}
async function openFile(path, index = 0) {
  const id = await group(index).getAttribute("data-group-id");
  await moduleCall("documents", "openPath", path.includes(":") ? path : `${root}/${path}`, { group: id, pinned: true });
  await active(path.split("/").at(-1), index);
}
async function active(name, index = 0) {
  await page.waitForFunction(({ name, index }) => document.querySelectorAll(".editor-group")[index]?.querySelector(".editor-tab.active")?.getAttribute("aria-label") === name, { name, index });
}
async function closed() { await popup.waitFor({ state: "hidden" }); }
async function focusedPath() { return tree.locator('[data-item-focused="true"]').getAttribute("data-item-path"); }
async function change(changes) {
  await moduleCall("workspaceTree", "handleWorkspaceChanges", { root, session: 1, changes, rescan: false, gitChanged: false });
  await settle();
}
try {
  await mkdir(output, { recursive: true });
  await page.goto(process.env.LITECODE_TEST_URL ?? "http://localhost:1420");
  await page.locator('.explorer [data-item-path="src/"]').waitFor();
  await openFile("src/a.ts");
  await crumb("a.ts").click();
  await row("a.ts").waitFor();
  assert.equal(await row("src/").count(), 0);
  assert.equal(await row("nested/deep.ts").count(), 0);
  assert.equal(await focusedPath(), "a.ts");
  assert.ok(!(await page.evaluate(() => window.breadcrumbFixture.reads)).includes("src/nested"));
  await row("nested/").click();
  await row("nested/deep.ts").waitFor();
  await row("empty/").click();
  await popup.getByText("Empty", { exact: true }).waitFor();
  await page.screenshot({ path: `${output}/01-tree.png` });
  await row("nested/deep.ts").click();
  await closed(); await active("deep.ts");
  assert.equal(await group().locator('.editor-tab.active').evaluate((element) => element.classList.contains("preview")), true);
  await page.waitForFunction(() => !!document.activeElement.closest(".monaco-editor"));
  checks.push("Sibling root, collapsed initial folders, lazy expansion, empty directory and preview opening with editor focus");

  await openFile("src/a.ts");
  await crumb("a.ts").focus(); await page.keyboard.press("ArrowDown");
  await row("a.ts").waitFor();
  await page.keyboard.press("ArrowDown");
  assert.equal(await focusedPath(), "b.ts");
  await active("a.ts");
  await page.keyboard.press("Enter");
  await closed(); await active("b.ts");
  assert.equal(await group().locator('.editor-tab.active').evaluate((element) => element.classList.contains("preview")), false);
  await crumb("b.ts").click(); await row("b.ts").waitFor();
  await page.keyboard.press("Escape"); await closed();
  assert.equal(await crumb("b.ts").evaluate((element) => element === document.activeElement), true);
  await crumb("b.ts").press("Space"); await row("b.ts").waitFor();
  await crumb("b.ts").click(); await closed();
  await crumb("src").press("Enter"); await row("src/").waitFor();
  await tree.locator('[data-item-focused="true"]').waitFor();
  await page.keyboard.press("ArrowRight"); await row("src/a.ts").waitFor();
  await page.keyboard.press("ArrowRight");
  assert.equal(await focusedPath(), "src/empty/");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await focusedPath(), "src/");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await row("src/a.ts").count(), 0);
  await page.keyboard.press("Enter"); await row("src/a.ts").waitFor();
  await page.keyboard.press("Enter");
  assert.equal(await row("src/a.ts").count(), 0);
  await page.keyboard.press("Escape"); await closed();
  checks.push("Keyboard entry, navigation without opening, Enter pinning, Esc focus restoration and repeated trigger toggle");

  await crumb("src").click(); await row("src/").waitFor();
  await crumb("b.ts").click(); await row("b.ts").waitFor();
  assert.equal(await popup.count(), 1);
  await page.getByRole("button", { name: "Split Editor Right (Ctrl+\\)", exact: true }).click();
  await closed();
  await group(1).waitFor();
  await openFile("src/a.ts", 1);
  await crumb("a.ts", 1).click(); await row("b.ts").waitFor();
  await row("b.ts").click(); await closed(); await active("b.ts", 1);
  checks.push("Switching breadcrumb anchors, outside dismissal and opening in the originating split editor");

  await openFile("src/a.ts", 1);
  await crumb("a.ts", 1).click(); await row("a.ts").waitFor();
  await row("nested/").click(); await row("nested/deep.ts").waitFor();
  const explorer = page.locator(".explorer file-tree-container");
  const before = await explorer.locator('[data-item-selected="true"]').evaluateAll((elements) => elements.map((element) => element.dataset.itemPath));
  const expansionBefore = await explorer.locator('[data-item-path="src/nested/"]').getAttribute("aria-expanded");
  await row("nested/deep.ts").click({ modifiers: ["Control"] });
  const after = await explorer.locator('[data-item-selected="true"]').evaluateAll((elements) => elements.map((element) => element.dataset.itemPath));
  assert.deepEqual(after, before);
  assert.equal(await explorer.locator('[data-item-path="src/nested/"]').getAttribute("aria-expanded"), expansionBefore);
  await page.evaluate(() => { window.breadcrumbFixture.paths = window.breadcrumbFixture.paths.filter((path) => path !== "src/b.ts" && path !== "src/nested/deep.ts").concat("src/new.ts", "src/nested/renamed.ts"); });
  await change([{ path: "src/b.ts", structural: true }, { path: "src/new.ts", structural: true }, { path: "src/nested/deep.ts", structural: true }, { path: "src/nested/renamed.ts", structural: true }]);
  await row("new.ts").waitFor(); await row("nested/renamed.ts").waitFor();
  assert.equal(await row("b.ts").count(), 0);
  assert.equal(await row("nested/deep.ts").count(), 0);
  checks.push("Independent Explorer state, disabled multiselect and live create/delete/rename in expanded directories");

  await page.evaluate(() => { window.breadcrumbFixture.fail = "src/fail"; });
  await row("fail/").click();
  await popup.getByText("!", { exact: true }).waitFor();
  await page.evaluate(() => { window.breadcrumbFixture.fail = null; });
  await row("fail/").click(); await row("fail/").click();
  await row("fail/recovered.ts").waitFor();
  await row("large/").click();
  await settle();
  await tree.evaluate((host) => { host.shadowRoot.querySelector('[data-file-tree-virtualized-scroll]').scrollTop = 100000; });
  await row("large/file-199.ts").waitFor();
  const bounds = await popup.boundingBox();
  assert.ok(bounds.height <= 400 && bounds.x >= 0 && bounds.x + bounds.width <= 1280);
  await page.screenshot({ path: `${output}/02-large-tree.png` });
  await page.keyboard.press("Escape"); await closed();
  checks.push("Failed directory retry, virtualized large directory scrolling and viewport bounds");

  await page.evaluate(async (url) => { window.breadcrumbFixture.fail = 'src'; (await import(url)).workspaceDirectories().invalidate('src'); }, urls.workspaceTree);
  await crumb("a.ts", 1).click();
  await popup.getByRole("button", { name: "Retry", exact: true }).waitFor();
  await page.evaluate(() => { window.breadcrumbFixture.fail = null; });
  await popup.getByRole("button", { name: "Retry", exact: true }).click();
  await row("a.ts").waitFor();
  await page.keyboard.press("Escape"); await closed();
  await page.setViewportSize({ width: 768, height: 420 });
  await crumb("a.ts", 1).click(); await row("a.ts").waitFor();
  const narrow = await popup.boundingBox();
  assert.ok(narrow.x >= 0 && narrow.x + narrow.width <= 768 && narrow.y + narrow.height <= 420);
  await page.screenshot({ path: `${output}/03-narrow.png` });
  await page.keyboard.press("Escape"); await closed();
  await page.setViewportSize({ width: 1280, height: 820 });
  checks.push("Root read errors have an actionable Retry button; popup remains inside a narrow, short viewport");

  await openFile("README.md", 1);
  await group(1).getByRole("button", { name: "Select Markdown editor" }).click();
  await page.getByRole("menuitem", { name: "Markdown Preview" }).click();
  await group(1).locator(".markdown-preview").waitFor();
  await crumb("README.md", 1).click(); await row("root.ts").waitFor();
  await row("root.ts").click(); await closed(); await active("root.ts", 1);
  await openFile("icon.svg", 1);
  await group(1).getByRole("button", { name: "Select SVG editor" }).click();
  await page.getByRole("menuitem", { name: "Text Editor" }).click();
  await crumb("icon.svg", 1).click(); await row("root.ts").waitFor();
  await page.keyboard.press("Escape"); await closed();
  await openFile("D:/outside.ts", 1);
  assert.equal(await group(1).getByRole("button", { name: /^Browse siblings/ }).count(), 0);
  await moduleCall("documents", "newDocument");
  assert.equal(await group(1).getByRole("button", { name: /^Browse siblings/ }).count(), 0);
  checks.push("Markdown/SVG view menus remain functional; outside and untitled documents have noninteractive paths");

  await openFile("src/a.ts", 1);
  await page.evaluate(() => { window.breadcrumbFixture.delay = "src"; });
  await page.evaluate(async (url) => { const cache = (await import(url)).workspaceDirectories(); cache.invalidate("src"); }, urls.workspaceTree);
  await crumb("a.ts", 1).click();
  await page.waitForFunction(() => !!window.breadcrumbResolve);
  await page.keyboard.press("Escape"); await closed();
  await page.evaluate(() => { window.breadcrumbFixture.delay = null; window.breadcrumbResolve(); });
  await settle(); await closed();
  await crumb("a.ts", 1).click(); await row("a.ts").waitFor();
  await moduleCall("store", "setApp", { root: "C:/another-workspace" });
  await closed();
  checks.push("Late directory responses cannot reopen a closed picker; switching workspace dismisses the popup");
  assert.deepEqual(errors, []);
  await writeFile(`${output}/report.json`, JSON.stringify({ passed: true, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  console.error(await page.evaluate(() => ({ active: document.activeElement?.tagName, popup: document.querySelector('.breadcrumb-popup')?.textContent })));
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  console.error(JSON.stringify({ checks, errors }, null, 2));
  throw error;
} finally { await browser.close(); }
