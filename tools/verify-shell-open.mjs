import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { chromium } from "playwright";

// Accepts a bundled executable, or a debug executable with Vite running on 1420.
const executable = path.resolve(process.argv[2] ?? "src-tauri/target/debug/litecode.exe");
const run = path.resolve("tmp", `shell-open-${Date.now()}`);
const app = path.join(run, "app");
const data = path.join(app, "data");
const folder = path.join(run, "项目 with spaces");
const file = path.join(folder, "中文 file.txt");
await mkdir(data, { recursive: true });
await mkdir(folder, { recursive: true });
await writeFile(file, "shell open fixture\n");
const binary = path.join(app, "LiteCode.exe");
await copyFile(executable, binary);
await writeFile(path.join(data, "settings.json"), JSON.stringify({ "files.autoSave": "off" }));

const preserved = new Map();
for (const label of ["main", "editor-history"]) {
  const id = `untitled:${label}`;
  const text = `unsaved ${label}\n`;
  const hash = createHash("sha256").update(text).digest("hex");
  const body = path.join(data, "recovery", label, `${hash}.txt`);
  await mkdir(path.dirname(body), { recursive: true });
  const manifest = path.join(data, `session-${label}.json`);
  const session = JSON.stringify({
    version: 2,
    root: folder,
    documents: [
      {
        id,
        path: null,
        text: null,
        version: 1,
        revision: null,
        encoding: "utf8",
        dirty: true,
        name: `History ${label}`,
        body: hash,
      },
    ],
    session: {
      activeGroup: "history-group",
      groups: [{ id: "history-group", tabs: [id], active: id, preview: null, views: {} }],
    },
  });
  await writeFile(body, text);
  await writeFile(manifest, session);
  preserved.set(body, text);
  preserved.set(manifest, session);
}

const checks = [];
const children = [];
const pageErrors = [];
let browser;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(get, message) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const value = await get();
    if (value) {
      return value;
    }
    await delay(100);
  }
  throw new Error(message);
}
function launch(args, port) {
  const child = spawn(binary, args, {
    cwd: app,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: path.join(run, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });
  children.push(child);
  return child;
}
function exited(child) {
  return waitFor(() => child.exitCode !== null, "Secondary process did not exit").then(() => {
    assert.equal(child.exitCode, 0);
  });
}
function stop() {
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      try {
        execFileSync(
          path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
      } catch {
        // A forwarded process may exit between checking exitCode and taskkill.
      }
    }
  }
}
async function start(args) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  launch(args, port);
  browser = await waitFor(async () => {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
    } catch {
      return null;
    }
  }, "WebView2 did not start");
  for (const context of browser.contexts()) {
    const observe = (page) => page.on("pageerror", (error) => pageErrors.push(String(error)));
    context.pages().forEach(observe);
    context.on("page", observe);
  }
  return port;
}
function pages() {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => {
      // WebView2 can expose workers as pages; only count editor documents.
      const url = new URL(page.url());
      return (
        ["http://localhost:1420", "http://tauri.localhost"].includes(url.origin) &&
        ["/", "/index.html"].includes(url.pathname)
      );
    });
}
async function ready(count) {
  await waitFor(() => pages().length >= count, `Expected ${count} editor pages`);
  for (const page of pages()) {
    try {
      await page.locator(".workbench-layout").waitFor({ timeout: 60000 });
    } catch (error) {
      await page.screenshot({ path: path.join(run, "startup-failure.png") });
      console.error({ url: page.url(), body: await page.locator("body").innerText(), pageErrors });
      throw error;
    }
  }
  // Native labels also detect any unwanted default window before its WebView has loaded.
  const labels = await pages()[0].evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:window|get_all_windows"),
  );
  assert.equal(labels.length, count, `Unexpected windows: ${labels.join(", ")}`);
  return labels;
}
function check(message) {
  checks.push(message);
  console.log(`PASS: ${message}`);
}
async function verifyPreserved() {
  for (const [name, contents] of preserved) {
    assert.equal(await readFile(name, "utf8"), contents);
  }
}
async function openFolder(port, target, count, args = ["--open-path", target]) {
  const existing = new Set(pages());
  await exited(launch(args, port));
  await ready(count);
  const page = pages().find((entry) => !existing.has(entry));
  assert(page, "No new target window");
  await verifyFolder(page, target);
  return page;
}
async function verifyFile(page) {
  await page
    .locator(".editor-tab")
    .filter({ hasText: path.basename(file) })
    .waitFor();
}
async function verifyFolder(page, target) {
  await page.getByRole("button", { name: "Restricted Mode", exact: true }).click();
  const resolved = path.resolve(target);
  const name = path.basename(resolved) || path.parse(resolved).root.slice(0, -1);
  await waitFor(async () => {
    const title = await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("plugin:window|title"),
    );
    return title.includes(name);
  }, `Target window did not open ${target}`);
}

try {
  const port = await start(["--open-path", file]);
  const labels = await ready(1);
  assert(!labels.includes("main"));
  await verifyFile(pages()[0]);
  await verifyPreserved();
  check("Cold file open creates one target window and preserves historical sessions and bodies");

  await openFolder(port, folder, 2);
  check("Forwarded folder open adds exactly one window without replacing the existing file");
  await openFolder(port, folder + path.sep + ".", 3);
  check("Folder background open adds exactly one window for the current directory");

  const root = path.parse(folder).root;
  await openFolder(port, root + ".", 4);
  check("Drive-root background argument opens exactly one root window");

  const existing = new Set(pages());
  await exited(launch([path.relative(app, file)], port));
  await ready(5);
  const filePage = pages().find((page) => !existing.has(page));
  assert(filePage, "No new file window");
  await verifyFile(filePage);
  check("Forwarded positional file path resolves against the sender's working directory");
  await openFolder(port, folder, 6, [folder]);
  check("Forwarded positional folder path opens exactly one target window");

  await exited(launch([], port));
  await ready(7);
  check("Launching normally into an existing instance adds one empty window");
  await delay(1000);
  await ready(7);
  await verifyPreserved();
  check(
    "Initial request is not replayed and recovery remains untouched after consecutive requests",
  );

  stop();
  await browser.close();
  browser = undefined;
  await start([file]);
  assert(!(await ready(1)).includes("main"));
  await verifyFile(pages()[0]);
  await verifyPreserved();
  check("Cold positional file open creates only its target and defers recovery");

  stop();
  await browser.close();
  browser = undefined;
  await start([folder]);
  assert(!(await ready(1)).includes("main"));
  await verifyFolder(pages()[0], folder);
  await verifyPreserved();
  check("Cold positional folder open creates only its target and defers recovery");

  stop();
  await browser.close();
  browser = undefined;
  await start(["--open-path", folder + path.sep + "."]);
  assert(!(await ready(1)).includes("main"));
  await verifyFolder(pages()[0], folder);
  await verifyPreserved();
  check("Cold folder background open also creates only its target and defers recovery");
  stop();
  await browser.close();
  browser = undefined;
  await start([]);
  const restored = await ready(2);
  assert(restored.includes("main") && restored.includes("editor-history"));
  for (const name of ["History main", "History editor-history"]) {
    await waitFor(async () => {
      const matches = await Promise.all(
        pages().map((page) => page.locator(".editor-tab").filter({ hasText: name }).count()),
      );
      return matches.some((count) => count > 0);
    }, `${name} was not restored`);
  }
  for (const label of ["main", "editor-history"]) {
    await waitFor(async () => {
      const contents = await Promise.all(
        pages().map((page) => page.locator(".view-lines").allTextContents()),
      );
      return contents
        .flat()
        .some((text) => text.replaceAll("\u00a0", " ").includes(`unsaved ${label}`));
    }, `Unsaved ${label} body was not restored`);
  }
  check("Subsequent normal startup restores both deferred unsaved windows");
  assert.deepEqual(pageErrors, []);
  await writeFile(path.join(run, "result.json"), JSON.stringify({ checks }, null, 2));
  console.log(`Results: ${run}`);
} finally {
  stop();
  await browser?.close();
}
