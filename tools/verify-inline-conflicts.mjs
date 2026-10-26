import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";

const run = path.resolve(".verification", `inline-conflicts-${Date.now()}`);
const root = path.join(run, "fixture");
const app = path.join(run, "app");
const file = path.join(root, "merge.txt");
const port = 9277;
const checks = [];
const errors = [];
let browser;
let page;
let native;
await mkdir(path.join(app, "data"), { recursive: true });
await mkdir(root, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, stdio: "pipe" });
git("init", "-b", "main");
git("config", "user.name", "Conflict Verification");
git("config", "user.email", "conflict-verification@example.invalid");
git("config", "core.autocrlf", "false");
git("config", "merge.conflictStyle", "diff3");
const shared = (prefix) => ["header", `${prefix} one`, "context a", "context b", "context c", "context d", `${prefix} two`, "context e", "context f", "context g", "context h", `${prefix} three`, "footer", ""].join("\n");
await writeFile(file, shared("base"));
git("add", ".");
git("commit", "-m", "Shared base");
git("checkout", "-b", "incoming");
await writeFile(file, shared("传入"));
git("commit", "-am", "Incoming edits");
git("checkout", "main");
await writeFile(file, shared("当前"));
git("commit", "-am", "Current edits");
try { git("merge", "incoming"); assert.fail("Expected a real merge conflict"); }
catch (error) { assert.equal(error.status, 1); }
assert.match(git("status", "--porcelain"), /UU merge\.txt/);
const original = await readFile(file, "utf8");
assert.equal((original.match(/^<<<<<<< /gm) ?? []).length, 3);
await writeFile(path.join(run, "original-conflict.txt"), original);
await copyFile("src-tauri/target/debug/litecode.exe", path.join(app, "LiteCode.exe"));
await writeFile(path.join(app, "data", "session-main.json"), JSON.stringify({ root, documents: [], session: {} }));
await writeFile(path.join(app, "data", "settings.json"), JSON.stringify({ "files.autoSave": "off", "editor.minimap.enabled": false }));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function connect(endpoint) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try { return await chromium.connectOverCDP(endpoint, { timeout: 1000 }); }
    catch { await pause(200); }
  }
  throw new Error(`Native debugging endpoint unavailable: ${endpoint}`);
}
async function appCode(script, args = []) {
  return page.evaluate(async ({ script, args }) => {
    const load = async (name) => {
      const entry = performance.getEntriesByType("resource").find((entry) => new URL(entry.name).pathname === name);
      return import(entry?.name ?? name);
    };
    const documents = await load("/src/editor/documents.ts");
    try { return await new Function("d", "load", "args", `return (async () => {${script}})();`)(documents, load, args); }
    catch (error) { throw new Error(error?.message ?? JSON.stringify(error)); }
  }, { script, args });
}
const record = (message) => { checks.push(message); console.log(`PASS: ${message}`); };
async function lensCount(count, group = page) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && await group.getByRole("button", { name: "Accept Current Change", exact: true }).count() !== count) { await pause(100); }
  assert.equal(await group.getByRole("button", { name: "Accept Current Change", exact: true }).count(), count);
}

try {
  native = spawn(path.join(app, "LiteCode.exe"), [], {
    cwd: app, windowsHide: true,
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: path.join(run, "webview") },
    stdio: "ignore",
  });
  browser = await connect(`http://127.0.0.1:${port}`);
  page = browser.contexts()[0].pages()[0];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.waitForSelector(".editor-group", { timeout: 60000 });
  let id = await appCode("return await d.openPath(args[0], {pinned:true});", [file]);
  const buffer = () => appCode("return d.models.get(args[0]).getValue();", [id]);
  await lensCount(3);
  await page.waitForSelector(".merge-conflict-common-header");
  await page.waitForSelector(".git-conflict-badge");
  assert.equal(await buffer(), original);
  assert.equal(await page.locator(".conflict-banner").count(), 0);
  await page.locator('.explorer [title="Git: Unmerged changes"]').waitFor();
  await page.getByRole("button", { name: "Browse siblings of merge.txt", exact: true }).click();
  await page.locator('.breadcrumb-popup [title="Git: Unmerged changes"]').waitFor();
  await page.keyboard.press("Escape");
  const appearance = await page.evaluate(() => {
    const lens = getComputedStyle(document.querySelector(".codelens-decoration"));
    const kinds = ["current-header", "current-content", "common-header", "common-content", "incoming-content", "incoming-header"];
    return { fontFamily: lens.fontFamily, fontSize: lens.fontSize, lineHeight: lens.lineHeight,
      colors: kinds.map((kind) => getComputedStyle(document.querySelector(`.merge-conflict-${kind}`)).backgroundColor) };
  });
  assert.equal(appearance.fontFamily, '"Segoe WPC", "Segoe UI", sans-serif');
  assert.equal(appearance.fontSize, "12px");
  assert.equal(appearance.lineHeight, "17px");
  assert.deepEqual(appearance.colors, ["rgba(64, 200, 174, 0.5)", "rgba(64, 200, 174, 0.2)", "rgba(96, 96, 96, 0.4)", "rgba(96, 96, 96, 0.16)", "rgba(64, 166, 255, 0.2)", "rgba(64, 166, 255, 0.5)"]);
  await writeFile(path.join(run, "native-appearance.json"), JSON.stringify(appearance, null, 2));
  await page.screenshot({ path: path.join(run, "01-native-conflicts.png") });
  record("Real Git merge produces three diff3 conflicts with inline actions, ancestor highlights and unmerged badges");

  await page.getByRole("button", { name: "Next Conflict", exact: true }).click();
  const secondPosition = await appCode("return d.editor().getPosition();");
  await page.getByRole("button", { name: "Next Conflict", exact: true }).click();
  await page.getByRole("button", { name: "Next Conflict", exact: true }).click();
  await page.getByRole("button", { name: "Next Conflict", exact: true }).click();
  assert.deepEqual(await appCode("return d.editor().getPosition();"), secondPosition);
  await page.getByRole("button", { name: "Previous Conflict", exact: true }).click();
  await page.getByRole("button", { name: "Next Conflict", exact: true }).click();
  record("Previous and next conflict navigation wraps and focuses the editor");

  await appCode("d.editor().revealLine(1); d.editor().setPosition({lineNumber:1,column:1});");
  await page.getByRole("button", { name: "Accept Current Change", exact: true }).first().click();
  await lensCount(2);
  const firstResolved = await buffer();
  assert.equal((firstResolved.match(/^<<<<<<< /gm) ?? []).length, 2);
  assert.match(firstResolved, /^header\n当前 one\ncontext a/);
  await appCode("await d.models.get(args[0]).undo();", [id]);
  assert.equal(await buffer(), original);
  await lensCount(3);
  await appCode("await d.models.get(args[0]).redo();", [id]);
  assert.equal(await buffer(), firstResolved);
  await lensCount(2);
  record("Accept Current changes only one block; a single undo and redo restore exact content and actions");

  await page.getByRole("button", { name: "Accept Incoming Change", exact: true }).first().click();
  await lensCount(1);
  await page.getByRole("button", { name: "Accept Both Changes", exact: true }).click();
  await lensCount(0);
  const expected = ["header", "当前 one", "context a", "context b", "context c", "context d", "传入 two", "context e", "context f", "context g", "context h", "当前 three", "传入 three", "footer", ""].join("\n");
  assert.equal(await buffer(), expected);
  assert.equal(await page.getByRole("button", { name: "Next Conflict", exact: true }).count(), 0);
  assert.equal(await page.locator(".merge-conflict-current-header").count(), 0);
  await appCode("await d.save(args[0]);", [id]);
  assert.equal(await readFile(file, "utf8"), expected);
  assert.match(git("status", "--porcelain"), /UU merge\.txt/);
  await page.waitForSelector(".git-conflict-badge");
  id = await appCode("await d.closeDocument(args[0]); return await d.openPath(args[1], {pinned:true});", [id, file]);
  assert.equal(await buffer(), expected);
  await page.screenshot({ path: path.join(run, "02-native-resolved.png") });
  record("All three choices produce expected saved bytes after reopening; Git remains unmerged until explicitly staged");

  const manual = "prefix\r\n<<<<<<< ours\r\n\t当前\r\n||||||| base\r\n原文\r\n=======\r\n\t传入\r\n>>>>>>> theirs\r\nsuffix";
  await appCode("d.models.get(args[0]).setValue(args[1]); d.editor().revealLine(1);", [id, manual]);
  await lensCount(1);
  await appCode("const {setApp,useApp}=await load('/src/store/store.ts'); setApp({settings:{...useApp.getState().settings,'merge-conflict.codeLens.enabled':false,'merge-conflict.decorators.enabled':false}});");
  await lensCount(0);
  assert.equal(await page.locator(".merge-conflict-current-header").count(), 0);
  await appCode("const {setApp,useApp}=await load('/src/store/store.ts'); setApp({settings:{...useApp.getState().settings,'merge-conflict.codeLens.enabled':true,'merge-conflict.decorators.enabled':true}});");
  await lensCount(1);
  const split = await appCode("return d.splitGroup(undefined,args[0],'right');", [id]);
  await page.waitForFunction(() => document.querySelectorAll(".editor-group").length === 2);
  const right = page.locator(".editor-group").last();
  await lensCount(1, right);
  await right.getByRole("button", { name: "Accept Both Changes", exact: true }).click();
  assert.equal(await appCode("const {useApp}=await load('/src/store/store.ts'); return useApp.getState().activeGroup;"), split);
  assert.equal(await buffer(), "prefix\r\n\t当前\r\n\t传入\r\nsuffix");
  await lensCount(0);
  await appCode("await d.models.get(args[0]).undo();", [id]);
  assert.equal(await buffer(), manual);
  await lensCount(1, right);
  await appCode("await d.closeGroup(args[0]);", [split]);
  await lensCount(1);
  record("Settings update live; split editors share edits and undo without duplicated actions; CRLF and indentation are preserved");

  await appCode("const editor=d.editor(), model=editor.getModel(); const reference={uri:model.uri.toString(),modelId:model.id,version:model.getVersionId(),start:model.getValue().indexOf('<<<<<<<')}; model.pushEditOperations([],[{range:{startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:1},text:'new '}],()=>null); editor.focus(); editor.trigger('verification','merge-conflict.accept.current',reference);");
  assert.equal(await buffer(), "new " + manual);
  await lensCount(1);
  record("A stale CodeLens reference cannot apply an outdated range after manual editing");
  await appCode("d.models.get(args[0]).setValue(args[1]); await d.save(args[0]);", [id, expected]);
  git("add", "merge.txt");
  await appCode("const {refreshTree}=await load('/src/explorer/workspaceTree.ts'); await refreshTree();");
  await page.waitForSelector(".git-conflict-badge", { state: "hidden" });
  await page.locator('.explorer [title="Git: Unmerged changes"]').waitFor({ state: "hidden" });
  assert.doesNotMatch(git("status", "--porcelain"), /^UU/m);
  record("External git add removes the unmerged decorations through the real Git refresh");

  await appCode("d.models.get(args[0]).setValue('unsaved local edit');", [id]);
  await writeFile(file, "external edit\n");
  await appCode("await d.refreshDocuments();");
  await page.waitForSelector(".conflict-banner");
  await appCode("await d.compareDisk(args[0]);", [id]);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await buffer(), "unsaved local edit");
  assert.equal(await readFile(file, "utf8"), "external edit\n");
  await appCode("await d.compareDisk(args[0]);", [id]);
  await page.getByRole("button", { name: "使用磁盘版本", exact: true }).click();
  assert.equal(await buffer(), "external edit\n");
  record("Disk save conflicts still preserve local edits, support cancellation and reload independently");

  const ordinaryFile = path.join(root, "untracked.txt");
  await writeFile(ordinaryFile, manual);
  const ordinary = await appCode("return await d.openPath(args[0], {pinned:true});", [ordinaryFile]);
  await lensCount(1);
  await appCode("const {execute}=await load('/src/core/commands.ts'); await execute('merge-conflict.next'); d.editor().updateOptions({readOnly:true}); await execute('merge-conflict.accept.incoming');");
  assert.equal(await appCode("return d.models.get(args[0]).getValue();", [ordinary]), manual);
  await appCode("d.editor().updateOptions({readOnly:false}); const {execute}=await load('/src/core/commands.ts'); await execute('merge-conflict.accept.incoming');");
  assert.equal(await appCode("return d.models.get(args[0]).getValue();", [ordinary]), "prefix\r\n\t传入\r\nsuffix");
  await appCode("d.patchDoc(args[0],{dirty:false}); await d.closeDocument(args[0]); d.showDocument(args[1]);", [ordinary, id]);
  record("Command-palette actions resolve an ordinary untracked file and respect read-only editors");
  await writeFile(path.join(run, "resolved-result.txt"), expected);
  git("restore", "--worktree", "--", "merge.txt");
  git("merge", "--abort");
  try { git("merge", "incoming"); assert.fail("Expected the demo merge conflict to be restored"); }
  catch (error) { assert.equal(error.status, 1); }
  assert.equal(await readFile(file, "utf8"), original);
  await appCode("await d.refreshDocuments();");
  await appCode("const {setApp}=await load('/src/store/store.ts'); setApp({notice:null});");
  await lensCount(3);
  await writeFile(path.join(run, "git-status.txt"), git("status"));
  await page.screenshot({ path: path.join(run, "03-demo-ready.png") });
  record("The example repository is left with its original three real conflicts for manual acceptance");
  assert.deepEqual(errors, []);
  await writeFile(path.join(run, "results.json"), JSON.stringify({ passed: true, checks, errors, run, root }, null, 2));
  console.log(`Evidence: ${run}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(run, "failure.png") }).catch(() => {});
    console.error(await page.locator("body").innerText().catch(() => ""));
  }
  console.error({ run, errors });
  throw error;
} finally {
  if (browser) { await browser.close().catch(() => {}); }
  if (native) { native.kill(); }
}
