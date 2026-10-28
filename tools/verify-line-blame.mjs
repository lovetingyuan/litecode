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
const alice = "a".repeat(40), bob = "b".repeat(40);
const doc = { id, path: `${root}/sample.txt`, name: "sample.txt", language: "plaintext", text: "one\ntwo\nthree", encoding: "utf8", eol: "LF", revision: "fixture", dirty: false, version: 1 };
page.on("pageerror", (error) => errors.push(String(error)));
page.on("request", (request) => {
  const match = new URL(request.url()).pathname.match(/^\/src\/(?:store|editor)\/(store|documents)\.ts$/);
  if (match) { urls[match[1]] = request.url(); }
});
await page.addInitScript(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => {
    if (window.blameFixture.copyFail) { throw new Error("clipboard unavailable"); }
    window.blameFixture.copied.push(text);
  } } });
});
await page.route("**/src/core/bridge.ts*", (route) => route.fulfill({ contentType: "application/javascript", body: `
export const desktop = false;
export const mediaSource = path => path;
export const errorMessage = e => e?.message ?? String(e);
export const channel = fn => ({ onmessage: fn });
window.blameFixture = { calls: [], detailsCalls: [], copied: [], pending: [], long: false, fail: false, detailsFail: false, hold: false, longMessage: false, copyFail: false };
const alice = ${JSON.stringify(alice)}, bob = ${JSON.stringify(bob)};
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
   return {head:'head',ranges:args.contents.split('\\n').map((line,i)=>({startLine:i+1,lineCount:1,commit:line==='two'?bob:line==='one'||line==='three'?alice:null})),commits:{[alice]:{author:window.blameFixture.long?'Alice '.repeat(35):'Alice',authorTime:1700000000,summary:'initial lines'},[bob]:{author:'Bob',authorTime:1701000000,summary:'change second line'}}};
 }
 if (command === 'git_commit_details') {
   const fixture = window.blameFixture;
   fixture.detailsCalls.push(args);
   if (fixture.detailsFail) throw new Error('details unavailable');
   const author = args.sha === bob ? 'Bob' : 'Alice';
   const result = {sha:args.sha,author:fixture.long?author.repeat(80):author,authorEmail:author.toLowerCase()+'@example.invalid',authorTime:args.sha===bob?1701000000:1700000000,message:(args.sha===bob?'change second line':'initial lines')+'\\n\\nFull commit description.\\n保留完整的多行说明。'+(fixture.longMessage?'\\nLong text '+ 'x'.repeat(180)+'\\nMore details.'.repeat(80):'')};
   if (fixture.hold) return new Promise(resolve => fixture.pending.push(() => resolve(result)));
   return result;
 }
 throw new Error('Unexpected fixture command: '+command);
}
` }));
const status = page.locator(".git-line-status");
const popup = page.getByTestId("git-commit-popup");
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
  assert.equal(await page.evaluate(() => window.blameFixture.detailsCalls.length), 0, "Details are lazy");
  assert.equal(await status.evaluate((el) => el.tagName), "BUTTON");
  await status.click();
  await popup.getByText("Full commit description.", { exact: false }).waitFor();
  assert.match(await popup.innerText(), /Alice[\s\S]*alice@example.invalid/);
  assert.equal(await popup.getByText("Alice(alice@example.invalid)", { exact: true }).count(), 1);
  assert.equal(await popup.locator("code").innerText(), alice.slice(0, 8));
  assert.equal(await popup.locator("code").getAttribute("title"), alice);
  const copyButton = popup.getByRole("button", { name: "复制 SHA", exact: true });
  assert.equal(await copyButton.innerText(), "", "Copy uses only an icon");
  assert.equal(await popup.locator("dt").count(), 0, "Metadata has no field headings");
  assert.equal(await popup.locator("time").getAttribute("datetime"), new Date(1700000000000).toISOString());
  assert.deepEqual(await page.evaluate(() => window.blameFixture.detailsCalls[0]), { expectedRoot: root, session: 1, repository: root, sha: alice });
  await popup.getByRole("button", { name: "复制 SHA", exact: true }).click();
  await popup.getByText("已复制 SHA", { exact: true }).waitFor();
  assert.equal(await copyButton.locator(".codicon-check").count(), 1);
  assert.deepEqual(await page.evaluate(() => window.blameFixture.copied), [alice]);
  await page.evaluate(() => { window.blameFixture.copyFail = true; });
  await popup.getByRole("button", { name: "复制 SHA", exact: true }).click();
  await popup.getByText("复制失败：clipboard unavailable", { exact: true }).waitFor();
  await page.evaluate(() => { window.blameFixture.copyFail = false; });
  await page.keyboard.press("Escape");
  await popup.waitFor({ state: "hidden" });
  assert.equal(await status.evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press("Enter");
  await popup.waitFor();
  await popup.getByRole("button", { name: "关闭提交详情", exact: true }).click();
  await popup.waitFor({ state: "hidden" });
  await status.click();
  await popup.waitFor();
  await status.click();
  await popup.waitFor({ state: "hidden" });
  await status.focus();
  await page.keyboard.press("Space");
  await popup.waitFor();
  await action((documents) => documents.editor().setPosition({ lineNumber: 3, column: 1 }));
  assert.equal(await popup.isVisible(), true, "Same-commit cursor movement keeps the panel open");
  await action((documents) => documents.editor().setPosition({ lineNumber: 2, column: 1 }));
  await popup.waitFor({ state: "hidden" });
  await clickLine(2);
  await status.filter({ hasText: "Bob" }).waitFor();
  assert.equal(await status.getAttribute("title"), null);
  assert.equal(await status.evaluate((el) => el.nextElementSibling.textContent.startsWith("Ln 2")), true);
  await page.keyboard.press("ArrowUp");
  await status.filter({ hasText: "Alice" }).waitFor();
  assert.equal(await page.evaluate(() => window.blameFixture.calls.length), calls, "Moving the cursor does not read Git");

  await page.evaluate(() => { window.blameFixture.hold = true; });
  await status.click();
  await popup.getByText("正在加载完整提交信息…").waitFor();
  await page.waitForFunction(() => window.blameFixture.pending.length === 1);
  await action((documents) => documents.editor().setPosition({ lineNumber: 2, column: 1 }));
  await popup.waitFor({ state: "hidden" });
  await status.filter({ hasText: "Bob" }).waitFor();
  await page.evaluate(() => { window.blameFixture.hold = false; });
  await status.click();
  await popup.getByText("bob@example.invalid").waitFor();
  await page.evaluate(() => { window.blameFixture.pending.splice(0).forEach((resolve) => resolve()); });
  assert.equal(await popup.getByText("alice@example.invalid").count(), 0, "Stale details cannot replace the current commit");
  await clickLine(1);
  await popup.waitFor({ state: "hidden" });

  await page.evaluate(() => { window.blameFixture.detailsFail = true; });
  await status.click();
  await popup.getByRole("alert").waitFor();
  assert.match(await popup.innerText(), /initial lines/);
  await page.evaluate(() => { window.blameFixture.detailsFail = false; });
  await popup.getByRole("button", { name: "重试", exact: true }).click();
  await popup.getByText("alice@example.invalid").waitFor();
  await clickLine(1);
  await page.keyboard.type("unsaved ");
  await status.filter({ hasText: "尚未提交" }).waitFor();
  const detailsCalls = await page.evaluate(() => window.blameFixture.detailsCalls.length);
  await status.click();
  await popup.getByText("当前行尚未包含在 HEAD 提交中。").waitFor();
  assert.equal(await page.evaluate(() => window.blameFixture.detailsCalls.length), detailsCalls);
  await clickLine(1);
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

  await status.click();
  await popup.getByText("alice@example.invalid").waitFor();
  await action((_documents, { setApp, useApp }) => {
    const state = useApp.getState(), current = state.docs[state.groups.find((group) => group.id === state.activeGroup).active];
    setApp({ docs: { ...state.docs, [current.id]: { ...current, path: current.path.replace("sample.txt", "renamed.txt") } } });
  });
  await popup.waitFor({ state: "hidden" });
  await status.filter({ hasText: "Alice" }).waitFor();
  await action((_documents, { setApp, useApp }) => {
    const state = useApp.getState(), current = state.docs[state.groups.find((group) => group.id === state.activeGroup).active];
    setApp({ docs: { ...state.docs, [current.id]: { ...current, path: current.path.replace("renamed.txt", "sample.txt") } } });
  });
  await status.filter({ hasText: "Alice" }).waitFor();
  await status.click();
  await popup.waitFor();
  await action((_documents, { setApp, useApp }) => setApp({ activeGroup: useApp.getState().groups[1].id }));
  await popup.waitFor({ state: "hidden" });
  await status.filter({ hasText: "Alice" }).waitFor();
  await action((_documents, { setApp, useApp }) => setApp({ activeGroup: useApp.getState().groups[0].id }));
  await status.filter({ hasText: "Alice" }).waitFor();
  await status.click();
  await popup.waitFor();
  await action((_documents, { setApp, useApp }) => setApp({ gitState: { ...useApp.getState().gitState, session: 2 } }));
  await popup.waitFor({ state: "hidden" });
  await status.filter({ hasText: "Alice" }).waitFor();
  await status.click();
  await popup.getByText("alice@example.invalid").waitFor();
  assert.equal(await page.evaluate(() => window.blameFixture.detailsCalls.at(-1).session), 2);
  await page.screenshot({ path: `${output}/01-desktop.png` });
  await page.keyboard.press("Escape");

  await page.evaluate(() => { window.blameFixture.long = true; });
  await action((_documents, { setApp, useApp }) => setApp({ gitState: { ...useApp.getState().gitState } }));
  await page.waitForFunction(() => (document.querySelector(".git-line-label")?.textContent.length ?? 0) > 100);
  await page.setViewportSize({ width: 800, height: 650 });
  const layout = await status.evaluate((el) => {
    const label = el.querySelector(".git-line-label"), row = el.parentElement, cursor = el.nextElementSibling;
    return { clipped: label.scrollWidth > label.clientWidth, cursorVisible: cursor.getBoundingClientRect().right <= innerWidth, rowFits: row.getBoundingClientRect().right <= innerWidth, height: el.closest("footer").getBoundingClientRect().height };
  });
  assert.deepEqual(layout, { clipped: true, cursorVisible: true, rowFits: true, height: 22 });
  assert.equal(await page.locator(".indentation-status").isVisible(), false);
  assert.equal(await page.locator(".encoding-status").isVisible(), false);
  await page.evaluate(() => { window.blameFixture.longMessage = true; });
  await status.click();
  await popup.getByText("More details.", { exact: false }).waitFor();
  const panel = await popup.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { fits: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight, scrolls: el.scrollHeight > el.clientHeight, wraps: el.scrollWidth <= el.clientWidth };
  });
  assert.deepEqual(panel, { fits: true, scrolls: true, wraps: true });
  await page.screenshot({ path: `${output}/02-narrow.png` });
  await page.evaluate(() => { window.blameFixture.fail = true; });
  await action((_documents, { setApp, useApp }) => setApp({ gitState: { ...useApp.getState().gitState } }));
  await status.waitFor({ state: "hidden" });
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".notification").count(), 0);
  await action((_documents, { setApp, useApp }) => setApp({ gitState: { ...useApp.getState().gitState, repositories: [] } }));
  assert.equal(await status.count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(`${output}/results.json`, JSON.stringify({ passed: true, errors, layout, panel }, null, 2));
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
