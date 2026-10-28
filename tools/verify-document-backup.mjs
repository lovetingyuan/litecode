import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// Like the other desktop checks, requires Vite on 1420 and a current debug exe.
const baseline = process.argv.includes("--baseline");
const run = path.resolve(".verification", `document-backup-${baseline ? "before" : "after"}-${Date.now()}`);
const app = path.join(run, "app"), data = path.join(app, "data"), root = path.join(run, "project");
await mkdir(data, { recursive: true });
await mkdir(root, { recursive: true });
const exe = path.join(app, "LiteCode.exe");
const exeArg = process.argv.indexOf("--executable");
await copyFile(exeArg < 0 ? "src-tauri/target/debug/litecode.exe" : process.argv[exeArg + 1], exe);
await writeFile(path.join(data, "session-main.json"), JSON.stringify({ root, documents: [], session: {} }));
await writeFile(path.join(data, "settings.json"), JSON.stringify({ "files.autoSave": "off" }));
const files = [];
for (let i = 0; i < 8; i++) {
  const file = path.join(root, `clean-${i}.txt`);
  await writeFile(file, "0123456789abcdef\n".repeat(61681));
  files.push(file);
}
const large = path.join(root, "large.txt"), edited = path.join(root, "edited.txt");
await writeFile(large, "0123456789abcdef\n".repeat(1480343));
await writeFile(edited, "editable\n".repeat(512));
files.push(large, edited);
const port = 24000 + Date.now() % 5000;
const errors = [];
let child, browser;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function kill() {
  if (child?.pid && child.exitCode === null) {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* Already exited. */ }
  }
}
async function disk(directory = data) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name === "recovery") { Object.assign(result, await disk(file)); }
    else if (entry.isDirectory() && directory !== data) { Object.assign(result, await disk(file)); }
    else if (entry.isFile() && (directory !== data || entry.name.startsWith("session-"))) {
      const bytes = await readFile(file);
      result[file] = { hash: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    }
  }
  return result;
}
try {
  console.log(`Fixture: ${run}`);
  child = spawn(exe, [], { cwd: app, windowsHide: true, stdio: "ignore", env: { ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: path.join(run, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
  for (let i = 0; i < 100; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; }
    catch { await delay(200); }
  }
  assert(browser, "WebView2 did not start");
  let page;
  for (let i = 0; i < 600; i++) {
    page = browser.contexts()[0].pages().find(page => {
      try { const url = new URL(page.url()); return url.origin === "http://localhost:1420" && url.pathname === "/"; }
      catch { return false; }
    });
    if (page) { break; }
    await delay(100);
  }
  assert(page, "Editor window did not navigate");
  page.on("pageerror", e => errors.push(String(e)));
  await page.waitForURL("http://localhost:1420/**", { waitUntil: "commit", timeout: 60000 });
  // Tauri's injected globals are immutable. Instrument our bridge in this
  // fixture's HTTP response instead of trying to replace native invoke.
  await page.route("**/src/core/bridge.ts*", async route => {
    const response = await route.fetch({ timeout: 90000 });
    const source = await response.text();
    const body = source.replace(/async function call\([^)]*\)\s*\{/, "$&\nwindow.recordBackup?.(command, args);");
    assert.notEqual(body, source, "Could not instrument the application bridge");
    await route.fulfill({ response, body });
  });
  await page.goto(page.url(), { waitUntil: "commit", timeout: 90000 });
  await page.locator(".sidebar").waitFor({ state: "attached", timeout: 90000 });
  await page.evaluate(async () => {
    const url = suffix => performance.getEntriesByType("resource").find(e => new URL(e.name).pathname === suffix)?.name ?? suffix;
    window.backupCheck = { d: await import(url("/src/editor/documents.ts")), s: await import(url("/src/store/store.ts")) };
  });
  await page.waitForFunction(() => window.backupCheck.s.useApp.getState().ready);
  console.log("Application ready");
  const ids = await page.evaluate(async files => {
    const { d } = window.backupCheck;
    const ids = [];
    for (const file of files) { ids.push(await d.openPath(file, { reveal: false, force: file.endsWith("large.txt") })); }
    await d.checkpoint();
    return ids;
  }, files);
  await delay(2200);
  console.log("Document mirrors initialized");
  await page.evaluate(() => {
    const { d } = window.backupCheck;
    window.backupCheck.metrics = { calls: 0, ipcBytes: 0, bodies: 0, reads: {} };
    window.recordBackup = (command, args) => {
      if (command === "sync_documents") {
        const m = window.backupCheck.metrics;
        m.calls++;
        m.ipcBytes += new TextEncoder().encode(JSON.stringify(args)).length;
        m.bodies += args.documents.filter(doc => Object.hasOwn(doc, "text")).length;
      }
    };
    for (const [id, model] of d.models) {
      const getValue = model.getValue.bind(model);
      model.getValue = (...args) => {
        const reads = window.backupCheck.metrics.reads;
        reads[id] = (reads[id] ?? 0) + 1;
        return getValue(...args);
      };
    }
  });
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const before = await disk();
    const sample = await page.evaluate(async ({ id, i }) => {
      const { d } = window.backupCheck;
      window.backupCheck.metrics = { calls: 0, ipcBytes: 0, bodies: 0, reads: {} };
      const started = performance.now();
      d.models.get(id).setValue("editable\n".repeat(512) + i);
      await d.checkpoint();
      return { ...window.backupCheck.metrics, durationMs: performance.now() - started };
    }, { id: ids.at(-1), i });
    const after = await disk();
    const changed = Object.entries(after).filter(([file, value]) => before[file]?.hash !== value.hash);
    sample.changedFiles = changed.length;
    sample.diskBytes = changed.reduce((sum, [, value]) => sum + value.bytes, 0);
    if (!baseline) {
      assert.equal(sample.bodies, 1);
      assert.deepEqual(Object.keys(sample.reads), [ids.at(-1)]);
      assert(sample.diskBytes < 20000, `Unexpected write volume: ${sample.diskBytes}`);
    }
    samples.push(sample);
  }
  assert.deepEqual(errors, []);
  const report = { baseline, files: files.length, samples, errors, run };
  await writeFile(path.join(run, "results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const pages = browser?.contexts().flatMap(context => context.pages().map(page => ({ url: page.url(), closed: page.isClosed() })));
  await writeFile(path.join(run, "failure.json"), JSON.stringify({ error: String(error.stack ?? error), errors, pages }, null, 2));
  throw error;
} finally {
  await browser?.close();
  kill();
}
