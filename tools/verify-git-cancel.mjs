import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, copyFile, symlink, writeFile, access } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "playwright";

// Run against an isolated portable app; never touch the user's repository/data.
const run = path.resolve(".verification", `git-cancel-${Date.now()}`);
const app = path.join(run, "app"), data = path.join(app, "data"), root = path.join(run, "workspace");
for (const directory of [data, root]) { await mkdir(directory, { recursive: true }); }
await copyFile("src-tauri/target/debug/litecode.exe", path.join(app, "LiteCode.exe"));
await symlink(path.resolve("src-tauri/tools"), path.join(app, "tools"), "junction");
const git = (...args) => execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe" });
git("init", "-b", "main");
git("init", "--bare", path.join(run, "remote"));
await writeFile(path.join(root, "file.txt"), "original\n");
const marker = path.join(run, "upload-started");
const upload = path.join(run, "upload.sh");
const shellQuote = (value) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
await writeFile(upload, `#!/bin/sh\necho started > ${shellQuote(marker)}\nsleep 60\nexec git-upload-pack "$@"\n`);
git("remote", "add", "slow", path.join(run, "remote"));
git("config", "remote.slow.uploadpack", `sh ${shellQuote(upload)}`);
await writeFile(path.join(data, "session-main.json"), JSON.stringify({ root, documents: [], session: {} }));
await writeFile(path.join(data, "settings.json"), JSON.stringify({ "files.autoSave": "off" }));
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const child = spawn(path.join(app, "LiteCode.exe"), [], {
  cwd: app, windowsHide: true, stdio: "ignore",
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(run, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --no-proxy-server` },
});
const repository = root.replaceAll("\\", "/");
let browser, page;
async function wait(check, description) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) { throw new Error(`App exited: ${child.exitCode}`); }
    if (await check().catch(() => false)) { return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
}
try {
  const endpoint = `http://127.0.0.1:${port}`;
  await wait(() => fetch(`${endpoint}/json/version`).then((r) => r.ok), "WebView startup");
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(60000);
  await page.locator("file-tree-container").waitFor({ timeout: 180000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.evaluate(async (root) => {
    await window.__TAURI_INTERNALS__.invoke("set_workspace_trust", { expectedRoot: root, trusted: true });
    const storeUrl = performance.getEntriesByType("resource").map((entry) => entry.name)
      .find((url) => new URL(url).pathname === "/src/store/store.ts");
    const { setApp } = await import(storeUrl);
    setApp({ sidebar: "git" });
  }, repository);
  await page.getByRole("region", { name: "Source Control", exact: true }).waitFor();
  await page.waitForFunction(async () => {
    const url = performance.getEntriesByType("resource").map((entry) => entry.name)
      .find((url) => new URL(url).pathname === "/src/store/store.ts");
    return (await import(url)).useApp.getState().gitState.session !== null;
  });
  const viewSource = await fetch("http://localhost:1420/src/components/GitView.tsx").then((response) => response.text());
  const modulePath = viewSource.match(/from ["']([^"']*\/src\/git\/git\.ts[^"']*)["']/)?.[1];
  assert.ok(modulePath, "GitView must import the Git module");
  const gitUrl = new URL(modulePath, "http://localhost:1420").href;
  const operation = page.evaluate(async ({ root, gitUrl }) => {
    return (await import(gitUrl)).runGitOperation(root, { kind: "fetch", remote: "slow" });
  }, { root: repository, gitUrl }).catch((error) => ({ error: String(error) }));
  const cancel = page.getByRole("button", { name: "Cancel Git operation", exact: true });
  await cancel.waitFor();
  await wait(() => access(marker).then(() => true), "Git upload-pack startup");
  const busy = await page.evaluate(async ({ root, gitUrl }) => {
    const { gitContext } = await import(gitUrl);
    try {
      await window.__TAURI_INTERNALS__.invoke("git_operate", {
        ...gitContext(root), requestId: "while-fetching", request: { kind: "stage", paths: ["file.txt"] },
      });
      return "unexpected success";
    } catch (error) { return error.code; }
  }, { root: repository, gitUrl });
  assert.equal(busy, "gitBusy");
  const started = Date.now();
  await cancel.click();
  assert.equal(await operation, false);
  const cancellationMs = Date.now() - started;
  assert.ok(cancellationMs < 30000, "Cancellation must finish before the 60-second upload");
  await cancel.waitFor({ state: "hidden" });
  const local = await page.evaluate(async ({ root, gitUrl }) => {
    return (await import(gitUrl)).runGitOperation(root, { kind: "stage", paths: ["file.txt"] });
  }, { root: repository, gitUrl });
  assert.equal(local, true);
  assert.equal(git("diff", "--cached", "--name-only").toString().trim(), "file.txt");
  assert.deepEqual(errors, []);
  const report = { run, checks: ["Real fetch is cancellable from Source Control", "Concurrent write returns gitBusy without queuing", "Local staging works after cancellation"], cancellationMs, errors };
  await page.screenshot({ path: path.join(run, "cancelled.png") });
  await writeFile(path.join(run, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close().catch(() => {});
  child.kill();
}
