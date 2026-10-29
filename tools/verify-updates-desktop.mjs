import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// Real, signed NSIS upgrades use a unique identifier and installation directory.
// Builds write only ignored outputs. The production updater key is never used.
const root = process.cwd();
const id = String(Date.now());
const run = path.resolve(".verification", `updates-${id}`);
const install = path.join(run, "installed");
const productName = `LiteCode Update Test ${id}`;
const identifier = `com.tingyuan.litecode.updatetest${id}`;
const cli = path.resolve("node_modules/@tauri-apps/cli/tauri.js");
await mkdir(run, { recursive: true });
const key = path.join(run, "test.key");
execFileSync(process.execPath, [cli, "signer", "generate", "--ci", "--write-keys", key], {
  stdio: "pipe",
  windowsHide: true,
});
const target = path.resolve(".verification", "updates-target");
const env = {
  ...process.env,
  CARGO_TARGET_DIR: target,
  TAURI_SIGNING_PRIVATE_KEY: await readFile(key, "utf8"),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
};
const fixtureResource = path.join(run, "resource.txt");
async function build(version, contents) {
  await writeFile(fixtureResource, contents);
  const config = path.join(run, `tauri-${version}.json`);
  await writeFile(
    config,
    JSON.stringify({
      productName,
      identifier,
      version,
      build: { beforeBuildCommand: "" },
      bundle: { resources: { [fixtureResource]: "update-fixture.txt" } },
      plugins: { updater: { pubkey: (await readFile(`${key}.pub`, "utf8")).trim() } },
    }),
  );
  console.log(`Building isolated signed installer ${version}`);
  execFileSync(
    process.execPath,
    [cli, "build", "--debug", "--ci", "--config", config, "--bundles", "nsis"],
    { cwd: root, env, stdio: "inherit", windowsHide: true },
  );
  const bundle = path.join(target, "debug/bundle/nsis");
  const name = (await readdir(bundle)).find(
    (name) => name.startsWith(productName) && name.endsWith(`_${version}_x64-setup.exe`),
  );
  assert(name, `Missing installer ${version}`);
  const output = path.join(run, `${version}-setup.exe`);
  await copyFile(path.join(bundle, name), output);
  await copyFile(path.join(bundle, `${name}.sig`), `${output}.sig`);
  return output;
}

const oldInstaller = await build("0.1.0", "old resources\n");
const newInstaller = await build("0.1.1", "new resources\n");
console.log("Installing the isolated old version");
execFileSync(oldInstaller, ["/S", `/D=${install}`], { windowsHide: true, stdio: "pipe" });
const exe = path.join(install, "litecode.exe");
assert.equal(await readFile(path.join(install, "update-fixture.txt"), "utf8"), "old resources\n");
let mode = "available",
  manifestRequests = 0;
const installerBytes = await readFile(newInstaller);
const signature = (await readFile(`${newInstaller}.sig`, "utf8")).trim();
let endpoint;
const server = createServer((req, res) => {
  if (req.url === "/latest.json") {
    manifestRequests++;
    if (mode === "offline") {
      res.writeHead(503).end("Fixture offline");
      return;
    }
    const version =
      mode === "current"
        ? "0.1.0"
        : mode === "older"
          ? "0.0.9"
          : mode === "prerelease"
            ? "0.2.0-beta.1"
            : "0.1.1";
    setTimeout(
      () =>
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            version,
            notes: "- 更新测试 & Markdown\n- Preserve unsaved documents",
            pub_date: new Date().toISOString(),
            platforms: {
              "windows-x86_64": {
                url: `${endpoint}/installer.exe`,
                signature: mode === "bad-signature" ? "invalid" : signature,
              },
            },
          }),
        ),
      100,
    );
  } else if (req.url === "/installer.exe") {
    res
      .writeHead(200, {
        "Content-Length": installerBytes.length,
        "Content-Type": "application/octet-stream",
      })
      .end(installerBytes);
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
endpoint = `http://127.0.0.1:${server.address().port}`;
const socket = netServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const child = spawn(exe, [], {
  cwd: install,
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    LITECODE_UPDATE_TEST_ENDPOINT: `${endpoint}/latest.json`,
    WEBVIEW2_USER_DATA_FOLDER: path.join(run, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --no-proxy-server`,
  },
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const invoke = (page, command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const checks = [];
function check(message) {
  checks.push(message);
  console.log(`PASS: ${message}`);
}
async function connect() {
  for (let i = 0; i < 160; i++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await delay(250);
    }
  }
  throw new Error("Update test WebView did not start");
}
async function phase(page, expected, timeout = 45000) {
  await page.waitForFunction(
    async (expected) =>
      (await window.__TAURI_INTERNALS__.invoke("get_update_state")).phase === expected,
    expected,
    { timeout },
  );
}
let browser, dataDir, backupLock;
try {
  browser = await connect();
  let page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(30000);
  await page.locator(".welcome-page").waitFor();
  await phase(page, "available");
  assert.equal(manifestRequests, 1);
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Update Available" }).count(), 1);
  assert.equal((await invoke(page, "get_update_state")).portable, false);
  dataDir = (await invoke(page, "bootstrap")).dataDir;
  check("Startup checks once, displays the update button, and keeps the dialog closed");
  await page.getByRole("button", { name: "Update Available" }).click();
  await page.getByRole("dialog").waitFor();
  assert((await page.getByRole("dialog").textContent()).includes("更新测试 & Markdown"));
  await page.screenshot({ path: path.join(run, "update-dialog.png") });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const label = await invoke(page, "new_window");
  await delay(1000);
  const pages = browser.contexts()[0].pages();
  const second = pages.find((p) => p !== page);
  assert(second, "Secondary editor window missing");
  await second.locator(".welcome-page").waitFor();
  await delay(500);
  assert.equal(manifestRequests, 1);
  const before = manifestRequests;
  await Promise.all([
    invoke(page, "check_update", { background: false }),
    invoke(second, "check_update", { background: false }),
  ]);
  assert.equal(manifestRequests, before + 1);
  check("Secondary windows reuse startup results and concurrent manual checks share one request");
  for (const next of ["current", "older", "prerelease"]) {
    mode = next;
    await invoke(page, "check_update", { background: false });
    assert.equal((await invoke(page, "get_update_state")).phase, "current");
  }
  mode = "offline";
  await invoke(page, "check_update", { background: false }).catch(() => {});
  assert.equal((await invoke(page, "get_update_state")).phase, "error");
  mode = "available";
  await invoke(page, "check_update", { background: false });
  check("Same/older/prerelease versions do not update, and failed checks can retry");
  for (const [editorPage, text] of [
    [page, "unsaved main 更新"],
    [second, "unsaved second 编辑"],
  ]) {
    await editorPage.bringToFront();
    await editorPage.keyboard.press("Control+n");
    await editorPage
      .locator(".monaco-editor .view-lines")
      .first()
      .click({ position: { x: 40, y: 8 } });
    await editorPage.keyboard.insertText(text);
    await editorPage.waitForFunction(
      (text) =>
        document
          .querySelector(".monaco-editor .view-lines")
          ?.textContent.replace(/\u00a0/g, " ")
          .includes(text),
      text,
    );
  }
  mode = "bad-signature";
  await invoke(page, "check_update", { background: false });
  await invoke(page, "install_update").then(
    () => {
      throw new Error("Bad signature installed");
    },
    () => {},
  );
  assert.equal((await invoke(page, "get_update_state")).phase, "error");
  assert.equal(await readFile(path.join(install, "update-fixture.txt"), "utf8"), "old resources\n");
  check("Invalid signatures refuse installation and preserve the running version");
  mode = "available";
  await invoke(page, "check_update", { background: false });
  await delay(500);
  backupLock = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$held = [IO.File]::Open($env:LITECODE_BACKUP_LOCK,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null; $held.Dispose()",
    ],
    {
      env: { ...process.env, LITECODE_BACKUP_LOCK: path.join(dataDir, `session-${label}.json`) },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  await new Promise((resolve, reject) => {
    backupLock.stdout.once("data", resolve);
    backupLock.once("error", reject);
    backupLock.once("exit", (code) => {
      if (code) reject(new Error("Could not lock the fixture backup"));
    });
  });
  await invoke(page, "install_update").catch(() => {});
  assert.equal((await invoke(page, "get_update_state")).phase, "error");
  backupLock.stdin.end("\n");
  await new Promise((resolve) => backupLock.once("exit", resolve));
  await page.waitForFunction(() => !document.querySelector(".workbench").inert);
  check("A backup failure in either window cancels installation and unlocks editing");
  const editorUrl = second.url();
  // An existing native window with no editor bridge cannot acknowledge backup.
  await second.goto("about:blank");
  await invoke(page, "install_update").catch(() => {});
  assert((await invoke(page, "get_update_state")).error.includes("Timed out"));
  await second.goto(editorUrl);
  await second.locator(".monaco-editor").first().waitFor();
  check("Missing backup confirmation cancels installation after 30 seconds");
  await page.getByRole("button", { name: "Update Available" }).click();
  await page.getByRole("button", { name: "Download and Install", exact: true }).click();
  await new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(
      () => reject(new Error("Updater did not exit the old application")),
      60000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  for (let i = 0; i < 160; i++) {
    if (
      await readFile(path.join(install, "update-fixture.txt"), "utf8").then(
        (text) => text === "new resources\n",
        () => false,
      )
    )
      break;
    await delay(250);
  }
  assert.equal(await readFile(path.join(install, "update-fixture.txt"), "utf8"), "new resources\n");
  browser = await connect();
  const restored = browser.contexts()[0].pages();
  page = restored[0];
  await page.waitForFunction(
    async () =>
      (await window.__TAURI_INTERNALS__.invoke("get_update_state")).currentVersion === "0.1.1",
  );
  const mainBackup = JSON.parse(await readFile(path.join(dataDir, "session-main.json"), "utf8"));
  const secondaryBackup = JSON.parse(
    await readFile(path.join(dataDir, `session-${label}.json`), "utf8"),
  );
  const recoveryText = async (backup, owner) =>
    Promise.all(
      backup.documents
        .filter((d) => d.dirty)
        .map((d) =>
          d.body
            ? readFile(path.join(dataDir, "recovery", owner, `${d.body}.txt`), "utf8")
            : d.text,
        ),
    );
  assert((await recoveryText(mainBackup, "main")).includes("unsaved main 更新"));
  assert((await recoveryText(secondaryBackup, label)).includes("unsaved second 编辑"));
  await page.locator(".monaco-editor").first().waitFor();
  check(
    "NSIS upgrades resources, restarts version 0.1.1, and preserves dirty buffers from both windows",
  );
  await page.screenshot({ path: path.join(run, "after-upgrade.png") });
  await writeFile(
    path.join(run, "results.json"),
    JSON.stringify({ checks, dataDir, identifier, install, passed: true }, null, 2),
  );
} catch (error) {
  await writeFile(
    path.join(run, "results.json"),
    JSON.stringify(
      { checks, error: String(error), dataDir, identifier, install, passed: false },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (backupLock?.exitCode === null) backupLock.stdin.end("\n");
  if (browser) {
    for (const page of browser.contexts()[0].pages()) {
      try {
        await invoke(page, "get_update_state");
        await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|destroy"));
      } catch {
        /* May already be exiting. */
      }
    }
  }
  // Kill only the executable belonging to this isolated fixture, including restarts.
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:LITECODE_TEST_EXE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ],
    { env: { ...process.env, LITECODE_TEST_EXE: exe }, stdio: "pipe", windowsHide: true },
  );
  await delay(500);
  const uninstaller = path.join(install, "uninstall.exe");
  try {
    execFileSync(uninstaller, ["/S"], { stdio: "pipe", windowsHide: true });
  } catch {
    /* Test report retains paths for cleanup. */
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  console.log(`Update verification artifacts: ${run}`);
}
