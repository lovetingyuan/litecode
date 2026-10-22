import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { chromium } from "playwright";

// Isolated portable app and real Tauri commands, disk, watcher and WebView2.
const run = path.resolve(".verification", `explorer-creation-desktop-${Date.now()}`);
const app = path.join(run, "app");
const root = path.join(run, "fixture");
await mkdir(path.join(app, "data"), { recursive: true });
await mkdir(path.join(root, "src"), { recursive: true });
await mkdir(path.join(root, ".git"));
await writeFile(path.join(root, "src", "assets"), "preserve");
await writeFile(path.join(app, "data", "session-main.json"), JSON.stringify({ root, documents: [], session: { sidebarWidth: 400 } }));
await writeFile(path.join(app,"data","settings.json"),JSON.stringify({"files.autoSave":"off"}));
await copyFile("src-tauri/target/debug/litecode.exe", path.join(app, "LiteCode.exe"));
const port = 19000 + Date.now() % 10000;
const process = spawn(path.join(app, "LiteCode.exe"), [], {
  cwd: app,
  windowsHide: true,
  stdio: "ignore",
  env: { ...globalThis.process.env, WEBVIEW2_USER_DATA_FOLDER:path.join(run,"webview"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
let browser;
let page;
const checks = [];
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  assert(browser, "Native WebView2 debugging endpoint did not start");
  const context = browser.contexts()[0];
  page = context.pages()[0];
  if (!page) page = await context.waitForEvent("page");
  page.on("pageerror", error => console.error("WebView error:", String(error)));
  page.on("console", message => { if (message.type() === "error") console.error("WebView console:", message.text()); });
  page.on("requestfailed", request => console.error("WebView request:", request.url(), request.failure()));
  await page.waitForURL("http://localhost:1420/**", {timeout:60000});
  page.setDefaultTimeout(15000);
  const tree = page.locator("file-tree-container");
  const input = tree.locator("[data-file-tree-creation-input]");
  const renameInput = tree.locator("[data-file-tree-rename-input]");
  const row = item => tree.locator(`[data-item-path="${item}"]:not([data-file-tree-sticky-row]):not([data-item-parked="true"])`);
  const error = page.locator("[data-file-tree-creation-error]");
  await row("src/").waitFor({timeout:60000});
  async function invoke(command, args) {
    return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {command,args});
  }
  const snapshot = await invoke("read_workspace_directory", { expectedRoot: root, directory: "", session: null });
  const args = { expectedRoot: root, session: snapshot.session, parent: "", kind: "newFile" };
  assert.match(await invoke("validate_workspace_creation", {...args,name:".git"}), /already exists/);
  await assert.rejects(invoke("create_workspace_entry", {...args,session:args.session+1,name:"stale.txt"}));
  await assert.rejects(access(path.join(root, "stale.txt")));
  checks.push("Native validation sees hidden disk entries and rejects stale workspace sessions");

  await page.locator(".section-heading").hover();
  await page.getByRole("button", {name:"New File",exact:true}).click();
  await input.waitFor();
  await input.fill("new/deep/file.txt");
  await input.press("Enter");
  await input.waitFor({state:"detached"});
  assert.equal(await readFile(path.join(root,"new/deep/file.txt"),"utf8"), "");
  await row("new/deep/file.txt").waitFor();
  checks.push("Tree input creates missing intermediate directories on disk and reveals the real file");

  await page.locator(".section-heading").hover();
  await page.getByRole("button", {name:"New File",exact:true}).click();
  await input.waitFor();
  await input.fill("FILE.TXT");
  await error.waitFor();
  assert.match(await error.innerText(), /already exists/);
  await input.press("Enter");
  assert.equal(await input.count(),1);
  await input.fill("CON.txt");
  await page.waitForFunction(() => document.querySelector("[data-file-tree-creation-error]")?.textContent.includes("reserved"));
  await input.press("Escape");
  checks.push("Actual Windows IPC rejects case-insensitive collisions; reserved names are blocked inline");

  await row("src/").click({button:"right"});
  await page.getByRole("menuitem",{name:"New File…",exact:true}).click();
  await input.waitFor();
  await input.fill("nested/folder/");
  await input.press("Enter");
  await input.waitFor({state:"detached"});
  await access(path.join(root,"src/nested/folder"));
  await row("src/nested/folder/").waitFor();
  assert.equal(await readFile(path.join(root,"src/assets"),"utf8"),"preserve");
  checks.push("A trailing separator creates a real folder; existing file contents are preserved");

  async function reveal(item) {
    await page.evaluate(async item=>(await import('/src/components/Explorer.tsx')).revealInTree(item),path.join(root,item));
    await row(item).waitFor();
    await page.waitForTimeout(180);
  }
  await reveal("src/assets");
  await row("src/assets").click();
  await page.keyboard.press("F2");
  await renameInput.waitFor();
  assert.deepEqual(await renameInput.evaluate(e=>[e.selectionStart,e.selectionEnd]),[0,6]);
  await renameInput.fill("nested");
  await error.waitFor();
  await renameInput.press("Escape");
  assert.equal(await readFile(path.join(root,"src/assets"),"utf8"),"preserve");
  await page.waitForFunction(async()=>{
    const {useApp}=await import('/src/store/store.ts');
    const {models}=await import('/src/editor/documents.ts');
    const doc=Object.values(useApp.getState().docs).find(doc=>doc.path?.replace(/\\/g,'/').endsWith('/src/assets'));
    return !!doc&&models.has(doc.id);
  });
  await page.evaluate(async()=>{
    const {useApp}=await import('/src/store/store.ts');
    const {models}=await import('/src/editor/documents.ts');
    const doc=Object.values(useApp.getState().docs).find(doc=>doc.path?.replace(/\\/g,'/').endsWith('/src/assets'));
    models.get(doc.id).setValue('unsaved native rename');
  });
  await page.keyboard.press("F2");
  await renameInput.waitFor();
  await renameInput.fill("moved/deep/Assets.txt");
  await renameInput.press("Enter");
  await renameInput.waitFor({state:"detached"});
  await row("src/moved/deep/Assets.txt").waitFor();
  assert.equal(await readFile(path.join(root,"src/moved/deep/Assets.txt"),"utf8"),"preserve");
  await assert.rejects(access(path.join(root,"src/assets")));
  await row("src/moved/deep/Assets.txt").click();
  await page.keyboard.press("F2");
  await renameInput.waitFor();
  assert.deepEqual(await renameInput.evaluate(e=>[e.selectionStart,e.selectionEnd]),[0,6]);
  await renameInput.fill("ASSETS.TXT");
  await renameInput.press("Enter");
  await renameInput.waitFor({state:"detached"});
  await row("src/moved/deep/ASSETS.TXT").waitFor();
  checks.push("Native F2 rename validates real conflicts, creates nested directories and supports case-only changes");

  const sticky=tree.locator('[data-file-tree-sticky-path="src/moved/"]');
  if(await sticky.isVisible()) await sticky.click({button:"right"});
  else await row("src/moved/").click({button:"right"});
  await page.getByRole("menuitem",{name:"Rename…",exact:true}).click();
  await renameInput.waitFor();
  await renameInput.fill("relocated/folder");
  await renameInput.press("Enter");
  await renameInput.waitFor({state:"detached"});
  await row("src/relocated/folder/").waitFor();
  assert(await page.evaluate(async()=>{
    const {useApp}=await import('/src/store/store.ts');
    const {models}=await import('/src/editor/documents.ts');
    const doc=Object.values(useApp.getState().docs).find(doc=>doc.path?.replace(/\\/g,'/').endsWith('/src/relocated/folder/deep/ASSETS.TXT'));
    return doc?.dirty&&models.get(doc.id)?.getValue()==='unsaved native rename';
  }));
  assert.equal(await readFile(path.join(root,"src/relocated/folder/deep/ASSETS.TXT"),"utf8"),"preserve");
  checks.push("Real watcher events preserve folder descendants and dirty editor content while rebinding their paths");
  await page.waitForTimeout(650);
  assert(!((await page.locator("body").innerText()).includes("Backup failed:")), "Rename must not leave backups pointing to deleted source directories");
  await page.screenshot({path:path.join(run,"verified.png")});
  await writeFile(path.join(run,"report.json"), JSON.stringify({checks},null,2));
  console.log(JSON.stringify({run,checks},null,2));
} catch (error) {
  if (page) {
    console.error({url:page.url(),body:await page.locator("body").innerText()});
    await page.screenshot({path:path.join(run,"failure.png")});
  }
  throw error;
} finally {
  await browser?.close();
  process.kill();
}
