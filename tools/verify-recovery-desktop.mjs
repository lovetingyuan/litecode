import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// Requires Vite on 1420 and a current debug executable. All application data,
// external writers and terminated processes belong to this isolated fixture.
const run = path.resolve(".verification", "recovery-" + Date.now());
const app = path.join(run, "app"),
  data = path.join(app, "data"),
  root = path.join(run, "project 中文");
await mkdir(data, { recursive: true });
await mkdir(root, { recursive: true });
const exe = path.join(app, "LiteCode.exe");
await copyFile("src-tauri/target/debug/litecode.exe", exe);
await writeFile(path.join(data, "settings.json"), JSON.stringify({ "files.autoSave": "off" }));
await writeFile(
  path.join(data, "session-main.json"),
  JSON.stringify({ root, documents: [], session: {} }),
);
const open = path.join(root, "打开.txt"),
  a = path.join(root, "a.txt"),
  b = path.join(root, "b.txt");
await writeFile(open, "alpha original\n");
await writeFile(a, "alpha disk A\r\n");
await writeFile(b, "alpha disk B\n");
const processes = [],
  browsers = [],
  locks = [],
  checks = [];
const errors = [];
let port = 23000 + (Date.now() % 5000);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// WebView2 can expose worker targets as pages over CDP. Only editor URLs have
// the application DOM; waiting for a worker's load/sidebar never completes.
const editorPages = (browser) =>
  browser
    .contexts()[0]
    .pages()
    .filter((page) => {
      try {
        const url = new URL(page.url());
        return url.origin === "http://localhost:1420" && url.pathname === "/";
      } catch {
        return false;
      }
    });
async function waitEditors(browser, count = 1) {
  for (let i = 0; i < 600; i++) {
    const pages = editorPages(browser);
    if (pages.length >= count) {
      return pages;
    }
    await delay(100);
  }
  throw new Error(`Expected ${count} editor windows`);
}
function check(message) {
  checks.push(message);
  console.log("PASS: " + message);
}
function launch(binary, debugPort) {
  const child = spawn(binary, [], {
    windowsHide: true,
    stdio: "ignore",
    cwd: path.dirname(binary),
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: path.join(path.dirname(binary), "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + debugPort,
    },
  });
  processes.push(child);
  return child;
}
async function exited(child) {
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  return Promise.race([
    new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    }),
    delay(15000).then(() => {
      throw new Error("Secondary instance did not exit");
    }),
  ]);
}
function kill(child) {
  if (child.exitCode === null && child.pid) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      /* It may have already exited. */
    }
  }
}
async function connect(debugPort) {
  let browser;
  for (let i = 0; i < 100; i++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:" + debugPort);
      break;
    } catch {
      await delay(200);
    }
  }
  assert(browser, "WebView2 did not start");
  browsers.push(browser);
  return browser;
}
async function prepare(page) {
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.waitForURL("http://localhost:1420/**", { waitUntil: "commit", timeout: 60000 });
  await page.locator(".sidebar").waitFor({ state: "attached", timeout: 90000 });
  await page.evaluate(async () => {
    function moduleUrl(suffix) {
      return (
        performance
          .getEntriesByType("resource")
          .slice()
          .reverse()
          .find((entry) => new URL(entry.name).pathname === suffix)?.name ?? suffix
      );
    }
    window.__litecodeVerification = {
      d: await import(moduleUrl("/src/editor/documents.ts")),
      r: await import(moduleUrl("/src/search/replacements.ts")),
      s: await import(moduleUrl("/src/store/store.ts")),
      t: await import(moduleUrl("/src/types/types.ts")),
    };
  });
  await page.waitForFunction(() => window.__litecodeVerification.s.useApp.getState().ready);
  return page;
}
const invoke = (page, command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const buffer = (page, id) =>
  page.evaluate((id) => window.__litecodeVerification.d.models.get(id).getValue(), id);
async function hold(file) {
  const script =
    "$held = [IO.File]::Open($env:LITECODE_TEST_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null; $held.Dispose()";
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LITECODE_TEST_LOCK_FILE: file },
    },
  );
  locks.push(child);
  await Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.once("data", (bytes) =>
        bytes.toString().includes("locked") ? resolve() : reject(new Error("File lock failed")),
      );
      child.once("exit", (code) => reject(new Error("File lock exited: " + code)));
    }),
    delay(10000).then(() => {
      throw new Error("File lock timed out");
    }),
  ]);
  return async () => {
    child.stdin.end("\n");
    await exited(child);
  };
}
async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
async function recoveryText(manifest, id) {
  const doc = manifest.documents.find((doc) => doc.id === id);
  return doc.body
    ? readFile(path.join(data, "recovery", "main", `${doc.body}.txt`), "utf8")
    : doc.text;
}
async function pending(page) {
  return invoke(page, "replacement_recovery");
}
async function prompt(page, choice) {
  await page.evaluate(() => {
    void window.__litecodeVerification.r.recoverInterruptedReplacements();
  });
  await page.getByRole("button", { name: choice, exact: true }).click();
}
try {
  console.log("Fixture: " + run);
  const first = launch(exe, port);
  let browser = await connect(port);
  let page = await prepare((await waitEditors(browser))[0]);
  const documentId = await page.evaluate(async (file) => {
    const { d } = window.__litecodeVerification;
    const id = await d.openPath(file, { pinned: true });
    const m = d.models.get(id);
    m.pushEditOperations(
      [],
      [{ range: m.getFullModelRange(), text: "alpha user edit\n" }],
      () => null,
    );
    await d.checkpoint();
    return id;
  }, open);
  const before = await json(path.join(data, "session-main.json"));
  const secondaryLabel = await invoke(page, "new_window");
  let second;
  for (let i = 0; i < 100; i++) {
    second = editorPages(browser).find((p) => p !== page);
    if (second) {
      break;
    }
    await delay(100);
  }
  assert(second, "New editor window was not created");
  await prepare(second);
  // Minimize both windows so the OS cannot refocus main when the last editor
  // is minimized and change which window the duplicate launch should restore.
  await invoke(page, "plugin:window|minimize", { label: "main" });
  await invoke(second, "plugin:window|minimize", { label: secondaryLabel });
  const duplicates = [launch(exe, port + 10), launch(exe, port + 11), launch(exe, port + 12)];
  assert.deepEqual(await Promise.all(duplicates.map(exited)), [0, 0, 0]);
  assert.equal(first.exitCode, null);
  assert.equal(editorPages(browser).length, 2);
  for (let i = 0; i < 100; i++) {
    if (
      !(await invoke(second, "plugin:window|is_minimized", { label: secondaryLabel })) &&
      (await invoke(second, "plugin:window|is_focused", { label: secondaryLabel }))
    ) {
      break;
    }
    await delay(100);
  }
  assert.equal(
    await invoke(second, "plugin:window|is_minimized", { label: secondaryLabel }),
    false,
  );
  assert.equal(await invoke(second, "plugin:window|is_focused", { label: secondaryLabel }), true);
  const after = await json(path.join(data, "session-main.json"));
  assert.equal(await recoveryText(before, documentId), "alpha user edit\n");
  assert.equal(await recoveryText(after, documentId), "alpha user edit\n");
  check(
    "Concurrent duplicate launches reuse the process, restore the last window and preserve unsaved recovery data",
  );

  await page.evaluate(
    async ({ id, files }) => {
      const { d, r, s, t } = window.__litecodeVerification;
      const hit = (file, documentId = null) => ({
        path: file,
        documentId,
        version: documentId ? s.useApp.getState().docs[documentId].version : null,
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 6,
        matched: "alpha",
        preview: "alpha",
      });
      const errors = await r.replaceMatches(
        [hit(s.useApp.getState().docs[id].path, id), ...files.map((file) => hit(file))],
        "beta",
        false,
        { ...t.defaultQuery, text: "alpha" },
      );
      if (errors?.length) {
        throw new Error(errors.join("\n"));
      }
      await d.checkpoint();
    },
    { id: documentId, files: [a, b] },
  );
  assert.equal(await buffer(page, documentId), "beta user edit\n");
  assert.equal(await readFile(open, "utf8"), "alpha original\n");
  assert.equal(await readFile(a, "utf8"), "beta disk A\r\n");
  const logNames = await readdir(path.join(data, "transactions", "main"));
  const log = await json(path.join(data, "transactions", "main", logNames[0]));
  assert.equal(log.version, 2);
  assert.equal(log.pending, null);
  assert.equal(log.buffers[0].before.text, "alpha user edit\n");
  check(
    "Mixed open/disk replacement persists the complete group and preserves pre-existing unsaved edits",
  );

  const release = await hold(b);
  await page.evaluate(() => window.__litecodeVerification.r.undoReplacement());
  assert.equal(await readFile(a, "utf8"), "alpha disk A\r\n");
  assert.equal(await readFile(b, "utf8"), "beta disk B\n");
  assert.equal(await buffer(page, documentId), "beta user edit\n");
  assert.equal((await pending(page)).length, 1);
  await release();
  await page.evaluate(() => window.__litecodeVerification.r.undoReplacement());
  assert.equal(await readFile(b, "utf8"), "alpha disk B\n");
  assert.equal(await buffer(page, documentId), "alpha user edit\n");
  assert.deepEqual(await pending(page), []);
  await page.evaluate(() => window.__litecodeVerification.r.undoReplacement(true));
  await writeFile(b, "external changes\n");
  await page.evaluate(() => window.__litecodeVerification.r.undoReplacement());
  assert.equal(await readFile(a, "utf8"), "beta disk A\r\n");
  assert.equal(await readFile(b, "utf8"), "external changes\n");
  assert.equal(await buffer(page, documentId), "beta user edit\n");
  await writeFile(b, "beta disk B\n");
  await page.evaluate(() => window.__litecodeVerification.r.undoReplacement());
  assert.equal(await buffer(page, documentId), "alpha user edit\n");
  check(
    "A real Windows file lock causes partial undo; retry succeeds, and external changes block the whole group",
  );

  const c = path.join(root, "secondary-c.txt"),
    d = path.join(root, "secondary-d.txt");
  await writeFile(c, "old C\n");
  await writeFile(d, "old D\n");
  for (const file of [c, d]) {
    await invoke(second, "explicit_open", { path: file });
  }
  const secondId = "aabbcc-1234";
  const edits = [];
  const { createHash } = await import("node:crypto");
  for (const file of [c, d]) {
    const bytes = await readFile(file);
    edits.push({
      path: file,
      before: bytes.toString("utf8"),
      after: "new\n",
      encoding: "utf8",
      revision: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const unlock = await hold(d);
  const partial = await invoke(second, "replace_disk", {
    transactionId: secondId,
    edits,
    buffers: [],
    expectedRoot: null,
  });
  assert.equal(partial.complete, false);
  assert.equal(await readFile(c, "utf8"), "new\n");
  assert.equal(await readFile(d, "utf8"), "old D\n");
  const largeRecovery = path.join(root, "large-recovery.txt");
  await writeFile(largeRecovery, "x".repeat(21 * 1024 * 1024));
  const largeId = await page.evaluate(async (file) => {
    const { d } = window.__litecodeVerification;
    const id = await d.openPath(file, { reveal: false, force: true });
    d.models.get(id).setValue("large recovered edit\n");
    await d.checkpoint();
    return id;
  }, largeRecovery);
  await page.evaluate(() => window.__litecodeVerification.d.checkpoint());
  await invoke(second, "sync_documents", { documents: [], session: {} });
  await unlock();
  kill(first);
  await delay(500);
  port += 1;
  const restarted = launch(exe, port);
  browser = await connect(port);
  const pages = await Promise.all((await waitEditors(browser, 2)).map(prepare));
  second = (
    await Promise.all(pages.map(async (p) => ({ page: p, pending: await pending(p) })))
  ).find((p) => p.pending.length)?.page;
  assert(second, "A clean secondary window with a pending disk journal was not restored");
  page = pages.find((p) => p !== second);
  assert.equal(await buffer(page, documentId), "alpha user edit\n");
  assert.equal(await buffer(page, largeId), "large recovered edit\n");
  await delay(600);
  const largeBackup = (await json(path.join(data, "session-main.json"))).documents.find(
    (doc) => doc.id === largeId,
  );
  assert(
    largeBackup?.dirty && largeBackup.body,
    "Restored large document disappeared during its first backup interval",
  );
  assert.equal(await recoveryText({ documents: [largeBackup] }, largeId), "large recovered edit\n");
  check(
    "A restored large document retains its unsaved body through the first metadata-only checkpoint",
  );
  await second.getByRole("button", { name: "恢复操作前状态", exact: true }).click();
  for (let i = 0; i < 100 && (await pending(second)).length; i++) {
    await delay(100);
  }
  assert.equal(await readFile(c, "utf8"), "old C\n");
  assert.equal(await readFile(d, "utf8"), "old D\n");
  assert.deepEqual(await pending(second), []);
  assert.equal(restarted.exitCode, null);
  check(
    "Force-kill releases the instance lock and restores unsaved buffers plus a clean secondary window's pending replacement",
  );

  const unlockAgain = await hold(d);
  const partialAgain = await invoke(second, "replace_disk", {
    transactionId: "aabbcc-5678",
    edits,
    buffers: [],
    expectedRoot: null,
  });
  assert.equal(partialAgain.complete, false);
  await unlockAgain();
  await writeFile(c, "new external work\n");
  await prompt(second, "恢复操作前状态");
  await delay(500);
  assert.equal(await readFile(c, "utf8"), "new external work\n");
  assert.equal((await pending(second)).length, 1);
  await prompt(second, "保留现状");
  for (let i = 0; i < 100 && (await pending(second)).length; i++) {
    await delay(100);
  }
  assert.equal(await readFile(c, "utf8"), "new external work\n");
  assert.deepEqual(await pending(second), []);
  await second.screenshot({ path: path.join(run, "recovery.png") });
  check(
    "Recovery preserves new external edits, retains the journal on conflict and supports explicitly keeping current contents",
  );

  const independentDir = path.join(run, "independent");
  await mkdir(path.join(independentDir, "data"), { recursive: true });
  const independentExe = path.join(independentDir, "LiteCode.exe");
  await copyFile(exe, independentExe);
  const independent = launch(independentExe, port + 1);
  const separate = await connect(port + 1);
  await prepare((await waitEditors(separate))[0]);
  assert.equal(independent.exitCode, null);
  assert.equal(restarted.exitCode, null);
  check("A different portable data directory runs independently alongside the first instance");
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(run, "results.json"),
    JSON.stringify({ checks, errors, run, generatedAt: new Date().toISOString() }, null, 2),
  );
  console.log(JSON.stringify({ checks: checks.length, run }));
} catch (error) {
  const pages = browsers.flatMap((browser) =>
    browser
      .contexts()
      .flatMap((context) =>
        context.pages().map((page) => ({ url: page.url(), closed: page.isClosed() })),
      ),
  );
  await writeFile(
    path.join(run, "failure.json"),
    JSON.stringify({ error: String(error.stack ?? error), checks, errors, pages }, null, 2),
  );
  throw error;
} finally {
  for (const child of locks) {
    if (child.exitCode === null) {
      child.stdin.end("\n");
    }
  }
  for (const child of processes) {
    kill(child);
  }
  for (const browser of browsers) {
    await browser.close().catch(() => {});
  }
}
