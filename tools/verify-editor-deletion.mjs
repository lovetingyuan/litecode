import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { workspaceFixtureCommands } from "./explorer-fixture.mjs";

// Real tree, dialogs, split editors and Monaco; file IPC uses disposable data.
// Run against npm run dev. No real files are deleted or recycled.
const root = "C:/deletion-fixture";
const output = ".verification/editor-deletion";
const files = ["internal.txt", "external.js", "keep.txt", "folder/child.txt", "failed.txt", "a-success.txt", "b-failed.txt", "c-retained.txt"];
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(15000);
const errors = [];
const checks = [];
const moduleURLs = {};
const pendingRequests = new Set();
page.on("pageerror", error => errors.push(String(error)));
page.on("request", request => {
  pendingRequests.add(request.url());
  const pathname = new URL(request.url()).pathname;
  if (["/src/editor/documents.ts", "/src/explorer/workspaceTree.ts"].includes(pathname)) { moduleURLs[pathname] = request.url(); }
});
page.on("requestfinished", request => pendingRequests.delete(request.url()));
page.on("requestfailed", request => { pendingRequests.delete(request.url()); errors.push(`${request.url()}: ${request.failure()?.errorText}`); });
await page.route("**/src/core/bridge.ts*", route => route.fulfill({
  contentType: "application/javascript",
  body: `
export const desktop = false;
export const mediaSource = path => path;
export const errorMessage = e => e?.message ?? String(e);
export const channel = fn => ({onmessage:fn});
window.deletionFixture = { paths: ${JSON.stringify(files)}, calls: [], revisions: {}, fail: null };
const root = ${JSON.stringify(root)};
const key = path => path.slice(root.length + 1);
const exists = path => window.deletionFixture.paths.includes(key(path));
export async function bootstrap() {
  const documents = window.deletionFixture.paths.map(path => ({
    id: path, path: root+'/'+path, name: path.split('/').pop(), text: '// Preserved editor content\\nconst answer = 42;',
    language: path.endsWith('.js') ? 'javascript' : 'plaintext', encoding:'utf8', eol:'LF', revision:'fixture', version:1,
    dirty: ['internal.txt', 'folder/child.txt'].includes(path), kind:'text'
  }));
  return { root, documents, session:{groups:[
    {id:'one',tabs:documents.map(doc=>doc.id),active:'external.js',preview:null,sticky:['internal.txt'],views:{}},
    {id:'two',tabs:['internal.txt'],active:'internal.txt',preview:null,views:{}}
  ],activeGroup:'one'}, recent:[],settings:{'files.autoSave':'off'},keybindings:[],warnings:[],dataDir:'' };
}
export async function call(command, args) {
${workspaceFixtureCommands}
  const fixture = window.deletionFixture;
  if(command === 'fixture_workspace_snapshot') return { paths:fixture.paths, git:[],branch:null,warnings:[],truncated:false };
  if(command === 'inspect_file' || command === 'read_document') {
    if(!exists(args.path)) throw {code:'notFound',message:'File deleted'};
    if(command === 'inspect_file') return {kind:'text',size:60,stamp:fixture.revisions[key(args.path)] ?? 'fixture'};
    return {path:args.path,text:'// Preserved editor content\\nconst answer = 42;',encoding:'utf8',eol:'LF',revision:fixture.revisions[key(args.path)] ?? 'fixture'};
  }
  if(command === 'file_operation') {
    const path = key(args.operation.path);
    fixture.calls.push(path);
    if(path === fixture.fail) throw {code:'io',message:'Recycle failed: Permission denied'};
    fixture.paths = fixture.paths.filter(candidate => candidate !== path && !candidate.startsWith(path + '/'));
    return null;
  }
  if(command === 'language_document') return;
  throw new Error('Unexpected fixture command: '+command);
}
`,
}));
const row = path => page.locator("file-tree-container").first().locator(`[data-item-path="${path}"]:not([data-file-tree-sticky-row]):not([data-item-parked="true"])`);
const dialog = page.getByRole("dialog");
const tab = name => page.locator(".editor-tab").filter({ has: page.getByText(name, { exact: true }) });
async function externalChange(path, deleted) {
  await page.evaluate(async ({ path, deleted, root, moduleURLs }) => {
    const fixture = window.deletionFixture;
    fixture.paths = fixture.paths.filter(candidate => candidate !== path);
    if (!deleted) { fixture.paths.push(path); fixture.revisions[path] = 'restored'; }
    await (await import(moduleURLs['/src/explorer/workspaceTree.ts'])).handleWorkspaceChanges({
      root, session: 1, changes: [{ path, structural: true }], rescan: false, gitChanged: false,
    });
    await (await import(moduleURLs['/src/editor/documents.ts'])).refreshDocuments([root + '/' + path]);
  }, { path, deleted, root, moduleURLs });
}
async function requestDelete(path, keyboard = false) {
  await row(path).waitFor();
  if (keyboard) {
    await row(path).click();
    await page.keyboard.press("Delete");
  } else {
    await row(path).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  }
  await dialog.waitFor();
}
async function confirmDelete() {
  await dialog.getByRole("button", { name: "Move to Recycle Bin", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}
try {
  await mkdir(output, { recursive: true });
  await page.goto(process.env.LITECODE_TEST_URL ?? "http://localhost:1420", { waitUntil: "domcontentloaded", timeout: 60000 });
  await row("internal.txt").waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('.editor-tab').length === 9, undefined, { timeout: 60000 });

  await externalChange("external.js", true);
  await tab("external.js").locator(".deleted-file-name").waitFor();
  const breadcrumb = page.locator('[data-group-id="one"] .breadcrumbs .deleted-file-name');
  await breadcrumb.waitFor();
  assert.equal(await tab("external.js").getAttribute("title"), `${root.replace(/\//g, "\\")}\\external.js\n文件已从磁盘删除`);
  assert.match(await breadcrumb.locator("..").getAttribute("title"), /文件已从磁盘删除/);
  const decoration = await tab("external.js").evaluate(element => ({
    label: getComputedStyle(element.querySelector('.editor-tab-label')).textDecorationLine,
    color: getComputedStyle(element.querySelector('.editor-tab-label')).color,
    icon: getComputedStyle(element.firstElementChild).textDecorationLine,
    close: getComputedStyle(element.querySelector('.tab-close')).textDecorationLine,
    warning: !!element.querySelector('.codicon-warning'),
  }));
  assert.deepEqual(decoration, { label: "line-through", color: "rgb(140, 140, 140)", icon: "none", close: "none", warning: false });
  assert.equal(await page.locator(".conflict-banner").count(), 0);
  await page.screenshot({ path: `${output}/external-deleted.png` });
  checks.push("External deletion retains Monaco content and shows gray strike-through on file text only, with accessible deletion hints and no conflict warning.");

  await page.evaluate(async url => {
    (await import(url)).models.get('external.js').setValue('const importantUnsaved = true;');
  }, moduleURLs['/src/editor/documents.ts']);
  await externalChange("external.js", false);
  await page.waitForFunction(() => !document.querySelector('[data-group-id="one"] .breadcrumbs .deleted-file-name'));
  assert.equal(await tab("external.js").locator(".deleted-file-name").count(), 0);
  assert.equal(await page.evaluate(async url => (await import(url)).models.get('external.js').getValue(), moduleURLs['/src/editor/documents.ts']), "const importantUnsaved = true;");
  await page.locator(".conflict-banner").waitFor();
  checks.push("Restoration clears deletion decoration and preserves unsaved content and genuine disk conflict protection.");

  await requestDelete("internal.txt", true);
  assert.match(await dialog.textContent(), /包含未保存修改/);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await tab("internal.txt").count(), 2);
  assert.deepEqual(await page.evaluate(() => window.deletionFixture.calls), []);
  await requestDelete("internal.txt");
  await confirmDelete();
  await tab("internal.txt").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelectorAll('.editor-group').length === 1);
  assert.equal(await page.evaluate(async url => (await import(url)).models.has('internal.txt'), moduleURLs['/src/editor/documents.ts']), false);
  checks.push("Delete key and context menu share a single dirty warning; cancel preserves both splits, while confirmed deletion closes dirty pinned tabs and the empty split.");

  await requestDelete("folder/");
  assert.match(await dialog.textContent(), /包含未保存修改/);
  await confirmDelete();
  await tab("child.txt").waitFor({ state: "detached" });
  assert.equal(await tab("keep.txt").count(), 1);
  checks.push("Deleting a folder closes its open descendants and preserves unrelated tabs.");

  await page.evaluate(() => { window.deletionFixture.fail = 'b-failed.txt'; });
  await row("a-success.txt").click();
  await row("b-failed.txt").click({ modifiers: ["Control"] });
  await row("c-retained.txt").click({ modifiers: ["Control"] });
  await page.keyboard.press("Delete");
  await dialog.waitFor();
  assert.doesNotMatch(await dialog.textContent(), /包含未保存修改/);
  await confirmDelete();
  await tab("a-success.txt").waitFor({ state: "detached" });
  await page.getByText("Recycle failed: Permission denied", { exact: true }).waitFor();
  assert.equal(await tab("b-failed.txt").count(), 1);
  assert.equal(await tab("c-retained.txt").count(), 1);
  assert.deepEqual(await page.evaluate(() => window.deletionFixture.calls), ['internal.txt', 'folder', 'a-success.txt', 'b-failed.txt']);
  checks.push("Multi-selection closes successful deletions only; failed and unattempted files remain open, and clean deletions have no dirty warning.");

  await externalChange("external.js", true);
  await tab("external.js").locator(".deleted-file-name").waitFor();
  await page.screenshot({ path: `${output}/after-internal-deletion.png` });
  assert.deepEqual(errors, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  const result = { checks, errors, pendingRequests: [...pendingRequests], failure: String(error) };
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
