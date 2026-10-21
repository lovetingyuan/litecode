import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

// The target is read-only. The portable app's data, screenshots and logs stay here.
const root = process.env.LITECODE_BENCH_ROOT;
assert.ok(root, "Set LITECODE_BENCH_ROOT to an existing project");
const run = path.resolve(".verification", `large-explorer-${Date.now()}`);
const app = path.join(run, "app");
await mkdir(path.join(app, "data"), { recursive: true });
await copyFile("src-tauri/target/debug/litecode.exe", path.join(app, "LiteCode.exe"));
await writeFile(path.join(app, "data", "session-main.json"), JSON.stringify({ root, documents: [], session: {} }));
await writeFile(path.join(app, "data", "settings.json"), JSON.stringify({ "files.autoSave": "off" }));
const tracked = ["package.json", "pnpm-lock.yaml", ".git/index"];
async function fingerprints() {
  return Object.fromEntries(await Promise.all(tracked.map(async (relative) => [relative, createHash("sha256").update(await readFile(path.join(root, relative))).digest("hex")])));
}
const before = await fingerprints();
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const launchStarted = performance.now();
const child = spawn(path.join(app, "LiteCode.exe"), [], {
  cwd: app, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(run, "webview"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --no-proxy-server` },
});
let logs = "";
child.stdout.on("data", (chunk) => { logs += chunk; });
child.stderr.on("data", (chunk) => { logs += chunk; });
let browser;
let page;
try {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) { throw new Error(`App exited: ${child.exitCode}`); }
    if (await fetch(`${endpoint}/json/version`).then((result) => result.ok).catch(() => false)) { break; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? await context.waitForEvent("page");
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.waitForURL("http://localhost:1420/**", { waitUntil: "commit", timeout: 60000 });
  console.log("Native app navigation committed");
  const tree = page.locator("file-tree-container");
  const row = (name) => tree.locator(`[data-item-path="${name}"]:not([data-file-tree-sticky-row])`).first();
  await row("apps/").waitFor();
  const coldProcessTreeMs = performance.now() - launchStarted;
  console.log("Native project root rendered");
  const moduleUrl = await page.evaluate(() => performance.getEntriesByType("resource").find((entry) => new URL(entry.name).pathname === "/src/explorer/workspaceTree.ts")?.name);
  assert.ok(moduleUrl);
  const startupDirectories = await page.evaluate(async (url) => [...(await import(url)).workspaceDirectories().directories.keys()], moduleUrl);
  assert.deepEqual(startupDirectories, [""], "Startup loads root only");
  await page.evaluate(async (url) => {
    window.largeExplorerCalls = [];
    const cache = (await import(url)).workspaceDirectories();
    const read = cache.read;
    if (typeof read !== 'function') throw new Error('Missing directory reader');
    cache.read = async (...args) => {
      const started = performance.now();
      const result = await read(...args);
      window.largeExplorerCalls.push({command:'read_workspace_directory',directory:args[0],ms:performance.now()-started,jsonCharacters:JSON.stringify(result).length,entries:result.paths.length});
      return result;
    };
  }, moduleUrl);
  await page.evaluate(async (url) => { await (await import(url)).refreshTree(); }, moduleUrl);
  const initial = await page.evaluate(() => window.largeExplorerCalls);
  assert.deepEqual(initial.filter((call) => call.command === "read_workspace_directory").map((call) => call.directory), [""], "Refresh reads only root");
  assert.equal(initial.filter((call) => call.command === "quick_file_paths").length, 0, "Closed Quick Open does not enumerate files");
  console.log("PASS: native startup and refresh load root only");
  await row("apps/").click();
  await page.waitForFunction(() => window.largeExplorerCalls.some((call) => call.directory === "apps"));
  await row("apps/").click();
  await row("apps/").click();
  await page.waitForTimeout(300);
  assert.equal((await page.evaluate(() => window.largeExplorerCalls)).filter((call) => call.directory === "apps").length, 1, "Repeated expansion uses cache");
  const readsBeforeContent = (await page.evaluate(() => window.largeExplorerCalls)).filter((call) => call.command === "read_workspace_directory").length;
  await page.evaluate(async (url) => {
    const module = await import(url);
    const cache = module.workspaceDirectories();
    await module.handleWorkspaceChanges({ root: cache.root, session: cache.session, changes: [{ path: "package.json", structural: false }], rescan: false, gitChanged: true });
  }, moduleUrl);
  assert.equal((await page.evaluate(() => window.largeExplorerCalls)).filter((call) => call.command === "read_workspace_directory").length, readsBeforeContent, "Content events do not read directories");
  // File enumeration uses the bundled ripgrep, copied only into the portable app.
  const { cp } = await import("node:fs/promises");
  await cp("src-tauri/tools", path.join(app, "tools"), { recursive: true });
  const quickStarted = performance.now();
  await page.keyboard.press("Control+p");
  const input = page.getByRole("combobox", { name: "Quick Access" });
  await input.waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Quick Access"]')?.getAttribute("aria-busy") === "false");
  const quickOpenMs = performance.now() - quickStarted;
  await input.fill("package");
  await page.waitForFunction(() => document.querySelector('[aria-label="Quick Access"]')?.getAttribute("aria-busy") === "false");
  await page.keyboard.press("Escape");
  const reopenStarted = performance.now();
  await page.keyboard.press("Control+p");
  await input.waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Quick Access"]')?.getAttribute("aria-busy") === "false");
  await page.keyboard.press("Escape");
  const quickReopenMs = performance.now() - reopenStarted;
  assert.ok(await page.locator(".section-heading").isVisible());
  console.log("PASS: cached expansion, content events and Quick Open reopening");
  const calls = await page.evaluate(() => window.largeExplorerCalls);
  assert.deepEqual(errors, []);
  assert.deepEqual(await fingerprints(), before, "Target manifests and Git index remain unchanged");
  await page.screenshot({ path: path.join(run, "tree.png") });
  const result = { passed: true, root, coldProcessTreeMs, quickOpenMs, quickReopenMs, calls, errors, unchangedFingerprints: before };
  await writeFile(path.join(run, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: true, run, coldProcessTreeMs, quickOpenMs, quickReopenMs, calls }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(run, "failure.png"), timeout: 10000 }).catch(() => {});
  console.error(`Evidence: ${run}`);
  console.error(await page?.evaluate(() => ({url:location.href,ready:document.readyState,body:document.body?.innerText.slice(0,600)})).catch(() => null));
  throw error;
} finally {
  await writeFile(path.join(run, "native.log"), logs);
  await browser?.close();
  child.kill();
}
