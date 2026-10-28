import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

// Real Monaco, status bar and split editors; only native IPC is isolated.
const output = ".verification/line-blame";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(20000);
const urls = {}, errors = [];
const root = "C:/blame-fixture", id = `file:///${root}/sample.txt`;
const doc = { id, path: `${root}/sample.txt`, name: "sample.txt", language: "plaintext", text: "one\ntwo\nthree", encoding: "utf8", eol: "LF", revision: "fixture", dirty: false, version: 1 };
page.on("pageerror", (error) => errors.push(String(error)));
page.on("request", (request) => {
  const match = new URL(request.url()).pathname.match(/^\/src\/(?:store|editor)\/(store|documents)\.ts$/);
  if (match) { urls[match[1]] = request.url(); }
});
await page.route("**/src/core/bridge.ts*", (route) => route.fulfill({ contentType: "application/javascript", body: `
export const desktop = false;
export const mediaSource = path => path;
export const errorMessage = e => e?.message ?? String(e);
export const channel = fn => ({ onmessage: fn });
window.blameFixture = { calls: [], long: false, fail: false };
const root = ${JSON.stringify(root)}, doc = ${JSON.stringify(doc)};
const snapshot = () => ({root,session:1,branch:'main',git:[],warnings:[],repositories:[{path:root,name:'fixture',branch:'main',detached:false,operation:null,changes:[]}]});
export async function bootstrap() { return {root,documents:[doc],session:{groups:[{id:'one',tabs:[doc.id],active:doc.id,preview:null,views:{}}],activeGroup:'one'},recent:[],settings:{'files.autoSave':'off'},keybindings:[],warnings:[],dataDir:''}; }
export async function call(command,args) {
 if (command === 'read_workspace_directory') return {root,session:1,directory:args.directory,paths:['sample.txt'],warnings:[]};
 if (command === 'workspace_git_status') return snapshot();
 if (command === 'inspect_file') return {kind:'text',size:13,stamp:'fixture'};
 if (command === 'read_document' || command === 'language_document') return doc;
 if (command === 'sync_documents' || command === 'configuration') return;
 if (command === 'git_blame_file') {
   window.blameFixture.calls.push(args);
   if (window.blameFixture.fail) throw new Error('unavailable');
   return {head:'head',ranges:args.contents.split('\\n').map((line,i)=>({startLine:i+1,lineCount:1,commit:line==='two'?'bbbbbbbb':line==='one'||line==='three'?'aaaaaaaa':null})),commits:{aaaaaaaa:{author:window.blameFixture.long?'Alice '.repeat(35):'Alice',authorTime:1700000000,summary:'initial lines'},bbbbbbbb:{author:'Bob',authorTime:1701000000,summary:'change second line'}}};
 }
 throw new Error('Unexpected fixture command: '+command);
}
` }));
const status = page.locator(".git-line-status");
async function action(fn, value) {
  return page.evaluate(async ({ urls, fn, value }) => {
    const documents = await import(urls.documents), store = await import(urls.store);
    return Function("documents", "store", "value", `return (${fn})(documents, store, value)`)(documents, store, value);
  }, { urls, fn: String(fn), value });
}
async function clickLine(line) {
  const point = await action((documents, _store, line) => {
    const editor = documents.editor(), node = editor.getDomNode(), box = node.getBoundingClientRect();
    const position = editor.getScrolledVisiblePosition({ lineNumber: line, column: 1 });
    return { x: box.x + position.left + 2, y: box.y + position.top + position.height / 2 };
  }, line);
  await page.mouse.click(point.x, point.y);
}
try {
  await mkdir(output, { recursive: true });
  await page.goto("http://localhost:1420", { timeout: 60000 });
  await status.filter({ hasText: "Alice" }).waitFor();
  const calls = await page.evaluate(() => window.blameFixture.calls.length);
  await clickLine(2);
  await status.filter({ hasText: "Bob" }).waitFor();
  assert.match(await status.getAttribute("title"), /Bob.*ago.*\nchange second line\nbbbbbbbb/s);
  assert.equal(await status.evaluate((el) => el.nextElementSibling.textContent.startsWith("Ln 2")), true);
  await page.keyboard.press("ArrowUp");
  await status.filter({ hasText: "Alice" }).waitFor();
  assert.equal(await page.evaluate(() => window.blameFixture.calls.length), calls, "Moving the cursor does not read Git");
  await page.keyboard.type("unsaved ");
  await status.filter({ hasText: "尚未提交" }).waitFor();
  await page.keyboard.press("ArrowDown");
  await status.filter({ hasText: "Bob" }).waitFor();
  for (let i = 0; i < 3 && await action((documents) => documents.editor().getValue()) !== doc.text; i++) {
    await page.keyboard.press("Control+z");
  }
  await clickLine(1);
  await status.filter({ hasText: "Alice" }).waitFor();

  await page.keyboard.press("Control+\\");
  await page.locator(".editor-group").nth(1).waitFor();
  await clickLine(3);
  await status.filter({ hasText: "Alice" }).waitFor();
  await page.locator(".editor-group").first().locator(".editor-tab").click();
  await page.waitForFunction(() => document.querySelector(".status-right")?.textContent.includes("Ln 1, Col"));
  await status.filter({ hasText: "Alice" }).waitFor();

  await page.evaluate(() => { window.blameFixture.long = true; });
  await action((_documents, { setApp, useApp }) => setApp({ gitState: { ...useApp.getState().gitState } }));
  await page.waitForFunction(() => (document.querySelector(".git-line-label")?.textContent.length ?? 0) > 100);
  await status.hover();
  await page.screenshot({ path: `${output}/01-desktop.png` });
  await page.setViewportSize({ width: 800, height: 650 });
  const layout = await status.evaluate((el) => {
    const label = el.querySelector(".git-line-label"), row = el.parentElement, cursor = el.nextElementSibling;
    return { clipped: label.scrollWidth > label.clientWidth, cursorVisible: cursor.getBoundingClientRect().right <= innerWidth, rowFits: row.getBoundingClientRect().right <= innerWidth, height: el.closest("footer").getBoundingClientRect().height };
  });
  assert.deepEqual(layout, { clipped: true, cursorVisible: true, rowFits: true, height: 22 });
  assert.equal(await page.locator(".indentation-status").isVisible(), false);
  assert.equal(await page.locator(".encoding-status").isVisible(), false);
  await page.screenshot({ path: `${output}/02-narrow.png` });
  await page.evaluate(() => { window.blameFixture.fail = true; });
  await action((_documents, { setApp, useApp }) => setApp({ gitState: { ...useApp.getState().gitState } }));
  await status.waitFor({ state: "hidden" });
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".notification").count(), 0);
  await action((_documents, { setApp, useApp }) => setApp({ gitState: { ...useApp.getState().gitState, repositories: [] } }));
  assert.equal(await status.count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(`${output}/results.json`, JSON.stringify({ passed: true, errors, layout }, null, 2));
  console.log(`Line blame browser checks passed: ${output}`);
} catch (error) {
  console.error(error);
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  console.error(await action((documents, store) => ({ fixture: window.blameFixture, state: store.useApp.getState().docs, text: documents.editor()?.getValue() })).catch(String));
  console.error(await page.locator("body").innerText().catch(String));
  throw error;
} finally {
  await browser.close();
}
