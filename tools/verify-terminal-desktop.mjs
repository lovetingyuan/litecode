import assert from "node:assert/strict";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const run = path.resolve(".verification", `terminal-${Date.now()}`);
const app = path.join(run, "app"),
  root = path.join(run, "project 中文;space"),
  nested = path.join(root, "nested 中文;dir");
await mkdir(path.join(app, "data"), { recursive: true });
await mkdir(nested, { recursive: true });
await writeFile(path.join(root, "sample.txt"), "terminal file link\nsecond line\n");
await writeFile(
  path.join(app, "data", "settings.json"),
  JSON.stringify({
    "files.autoSave": "off",
    "terminal.integrated.enableMultiLinePasteWarning": "never",
  }),
);
await writeFile(
  path.join(app, "data", "session-main.json"),
  JSON.stringify({ root, documents: [], session: {} }),
);
await copyFile("src-tauri/target/debug/litecode.exe", path.join(app, "LiteCode.exe"));
const port = 20000 + (Date.now() % 10000);
const native = spawn(path.join(app, "LiteCode.exe"), [], {
  cwd: app,
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: path.join(run, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
});
let browser, page;
const checks = [],
  errors = [];
const measurements = [];
const resourceScript = await readFile("tools/process-resources.ps1", "utf8");
const modules = {};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  for (let i = 0; i < 80; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      await delay(250);
    }
  }
  assert(browser, "WebView2 did not start");
  page = browser.contexts()[0].pages()[0] ?? (await browser.contexts()[0].waitForEvent("page"));
  page.setDefaultTimeout(20_000);
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      /\/src\/(terminal\/(state|runtime)|store\/store|editor\/documents|core\/commands)\.ts$/.test(
        pathname,
      )
    ) {
      modules[pathname] ??= request.url();
    }
  });
  page.on("pageerror", (error) => {
    errors.push(String(error));
    console.error("PAGE:", error);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.error("CONSOLE:", message.text());
    }
  });
  await page.waitForURL("http://localhost:1420/**", { timeout: 60_000 });
  await page.locator(".sidebar").waitFor({ state: "attached", timeout: 90_000 });
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  const moduleUrl = async (suffix) =>
    modules[suffix] ??
    (await page.evaluate(
      (suffix) =>
        performance
          .getEntriesByType("resource")
          .map((e) => e.name)
          .findLast((name) => new URL(name).pathname.endsWith(suffix)) ?? suffix,
      suffix,
    ));
  const state = async () =>
    page.evaluate(
      async (url) => {
        const { useTerminal } = await import(url);
        const s = useTerminal.getState();
        return {
          tabs: s.tabs,
          panes: s.panes,
          activeTab: s.activeTab,
          initialized: s.initialized,
        };
      },
      await moduleUrl("/src/terminal/state.ts"),
    );
  const runtime = async (method, ...args) =>
    page.evaluate(async ({ url, method, args }) => (await import(url))[method](...args), {
      url: await moduleUrl("/src/terminal/runtime.ts"),
      method,
      args,
    });
  async function waitState(predicate, message, timeout = 20_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const s = await state();
      if (predicate(s)) return s;
      await delay(100);
    }
    throw Error(message + ": " + JSON.stringify(await state()));
  }
  const current = (s) => s.tabs.find((t) => t.id === s.activeTab)?.activePane;
  async function shell(command, id) {
    if (id) {
      await runtime("focusTerminal", id);
      const host = page.locator(`[data-terminal-pane="${id}"]`);
      await host.waitFor({ state: "visible" });
      await host.locator(".xterm-helper-textarea").focus();
    }
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
  }
  async function output(text, id) {
    if (id) await runtime("focusTerminal", id);
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      if (await runtime("findTerminal", text)) return;
      await delay(100);
    }
    throw Error("Missing output: " + text);
  }
  async function exists(file) {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      try {
        await access(file);
        return;
      } catch {
        await delay(100);
      }
    }
    throw Error("File not produced: " + file);
  }
  const action = async (module, method, ...args) =>
    page.evaluate(async ({ url, method, args }) => (await import(url))[method](...args), {
      url: await moduleUrl(`/src/${module}.ts`),
      method,
      args,
    });
  async function settings(values) {
    const file = await invoke("settings_path", { kind: "settings" });
    await page.evaluate(
      async ({ url, file, values }) => {
        const docs = await import(url);
        const id = await docs.openPath(file, { pinned: true });
        const model = docs.models.get(id);
        model.setValue(JSON.stringify(values, null, 2));
        await docs.save(id);
      },
      { url: await moduleUrl("/src/editor/documents.ts"), file, values },
    );
    await runtime("showTerminal");
  }
  const resources = (label) => {
    const data = JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `& { ${resourceScript} } -ApplicationPath '${path.join(app, "LiteCode.exe").replaceAll("'", "''")}'`,
        ],
        { windowsHide: true, encoding: "utf8" },
      ),
    );
    measurements.push({
      label,
      workingSetBytes: data.workingSetBytes,
      privateBytes: data.privateBytes,
      processes: data.processes,
    });
    return data;
  };

  await page.getByRole("button", { name: "Terminal (Ctrl+`)", exact: true }).click();
  await page.getByRole("button", { name: "Restricted Mode", exact: true }).click();
  await waitState(
    (s) => Object.values(s.panes).some((p) => p.errorCode === "workspaceTrust"),
    "Restricted terminal did not report its trust error",
  );
  await page.getByRole("button", { name: "Trust Workspace and Retry", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(Object.values((await state()).panes)[0].status, "error");
  await page.getByRole("button", { name: "Trust Workspace and Retry", exact: true }).click();
  await page.getByRole("button", { name: "Trust Workspace", exact: true }).click();
  let s = await waitState(
    (s) => Object.values(s.panes).some((p) => p.status === "running"),
    "First shell did not start",
  );
  const first = current(s);
  await waitState((s) => s.panes[first]?.reportedCwd, "PowerShell did not report cwd");
  assert.equal((await state()).panes[first].cwd.toLowerCase(), root.toLowerCase());
  await page.getByRole("button", { name: "Split Terminal Right", exact: true }).waitFor();
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  checks.push(
    "Terminal activity icon opens a trusted real PTY at project root and fills the workspace",
    "Restricted terminal offers trust and retry; cancelling preserves the error and approving starts the shell",
  );

  const cdp = await page.context().newCDPSession(page);
  async function dropPaths(id, files) {
    const box = await page.locator(`[data-terminal-pane="${id}"] .terminal-host`).boundingBox();
    assert(box);
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await cdp.send("Input.dispatchDragEvent", {
        type,
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        data: { items: [], files, dragOperationsMask: 1 },
      });
    }
  }
  const droppedFolder = path.join(run, "external 中文 O'Brien;$(echo x)");
  await mkdir(droppedFolder);
  await runtime("pasteTerminal", first, "Write-Output ('DROP_RESULT:' + ");
  await dropPaths(first, [droppedFolder]);
  await output(droppedFolder.replaceAll("\\", "/").replaceAll("'", "''"), first);
  assert.equal((await state()).panes[first].cwd.toLowerCase(), root.toLowerCase());
  assert.equal((await state()).tabs.length, 1);
  assert.equal(await page.getByRole("dialog").count(), 0);
  const terminalBody = page.locator(`[data-terminal-pane="${first}"]`);
  await terminalBody.locator("textarea").press("End");
  await page.keyboard.type("); Write-Output ('DROP_' + 'DONE')");
  await page.keyboard.press("Enter");
  await output("DROP_DONE", first);
  await output("DROP_RESULT:" + droppedFolder.replaceAll("\\", "/"), first);
  checks.push(
    "Native folder drop inserts a literal path without executing or switching the workspace",
  );

  await shell(`Set-Location -LiteralPath '${nested.replaceAll("'", "''")}'`, first);
  await waitState(
    (s) => s.panes[first]?.cwd.toLowerCase() === nested.toLowerCase(),
    "cd did not update cwd",
  );
  await page.getByRole("button", { name: "Split Terminal Right", exact: true }).click();
  s = await waitState(
    (s) => Object.values(s.panes).filter((p) => p.status === "running").length === 2,
    "Right split did not start",
  );
  const second = current(s);
  assert.equal(s.panes[second].cwd.toLowerCase(), nested.toLowerCase());
  await page.getByRole("button", { name: "Split Terminal Down", exact: true }).click();
  s = await waitState(
    (s) => Object.values(s.panes).filter((p) => p.status === "running").length === 3,
    "Down split did not start",
  );
  const third = current(s);
  assert.equal(s.panes[third].cwd.toLowerCase(), nested.toLowerCase());
  await shell("Write-Output ('SESSION_' + 'SURVIVED')", first);
  await output("SESSION_SURVIVED", first);
  checks.push(
    "Nested horizontal/vertical splits inherit cd-updated Unicode/semicolon paths without resetting existing sessions",
  );

  const close = page
    .locator(`[data-terminal-pane="${third}"]`)
    .getByRole("button", { name: "Close Terminal Pane", exact: true });
  await page.locator(`[data-terminal-pane="${first}"]`).hover();
  await page.locator(`[data-terminal-pane="${first}"] .xterm-helper-textarea`).focus();
  assert.equal(await close.evaluate((e) => getComputedStyle(e).opacity), "0");
  await page.locator(`[data-terminal-pane="${third}"]`).hover();
  assert.equal(await close.evaluate((e) => getComputedStyle(e).opacity), "1");
  await close.click();
  await waitState((s) => Object.keys(s.panes).length === 2, "Pane close did not collapse layout");
  checks.push("Pane close is hover/focus accessible and removes only its own session");

  await runtime("newTerminal");
  s = await waitState(
    (s) =>
      s.tabs.length === 2 &&
      Object.values(s.panes).filter((p) => p.status === "running").length === 3,
    "Second tab did not start",
  );
  const another = current(s);
  assert.equal(s.panes[another].cwd.toLowerCase(), root.toLowerCase());
  await page.getByRole("button", { name: "Explorer (Ctrl+Shift+E)", exact: true }).click();
  await page.getByRole("button", { name: "Terminal (Ctrl+`)", exact: true }).click();
  await runtime("selectTab", s.tabs[0].id);
  await runtime("focusTerminal", first);
  await output("SESSION_SURVIVED", first);
  checks.push("Tab switches and editor/terminal navigation preserve live sessions and output");

  await page.keyboard.press("Control+f");
  await page
    .getByRole("textbox", { name: "Terminal search", exact: true })
    .fill("SESSION_SURVIVED");
  await page.getByRole("button", { name: "Close Terminal Search", exact: true }).click();
  await page.keyboard.press("Control+c");
  await shell("Write-Output ('AFTER_' + 'CTRL_C')", first);
  await output("AFTER_CTRL_C", first);
  checks.push("Terminal find and Ctrl+C remain scoped to the terminal");

  const profiles = await invoke("terminal_profiles");
  for (const profile of profiles.profiles) {
    const id = await runtime("newTerminal", profile.name);
    s = await waitState(
      (s) => s.panes[id]?.status === "running",
      "Profile failed: " + profile.name,
    );
    assert.equal(s.panes[id].profile, profile.name);
    await waitState((s) => s.panes[id]?.reportedCwd, "Profile cwd missing: " + profile.name);
    if (profile.kind === "cmd") await shell(`cd /d "${nested}"`, id);
    else if (profile.kind === "bash")
      await shell(`cd '${nested.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`, id);
    else await shell(`Set-Location -LiteralPath '${nested.replaceAll("'", "''")}'`, id);
    await waitState(
      (s) =>
        s.panes[id]?.cwd.toLowerCase().replaceAll("\\", "/") ===
        nested.toLowerCase().replaceAll("\\", "/"),
      "Profile cd failed: " + profile.name,
    );
    const marker = "PROFILE_" + profile.name.replaceAll(" ", "_");
    await shell(
      profile.kind === "cmd"
        ? `echo ${marker}`
        : profile.kind === "bash"
          ? `printf '%s\\n' '${marker}'`
          : `Write-Output '${marker}'`,
      id,
    );
    await output(marker, id);
    await shell("exit", id);
    await waitState((s) => !s.panes[id], "Normal exit did not close: " + profile.name);
    checks.push("Native shell profile: " + profile.name + " input/output/cwd/exit");
  }

  await runtime("focusTerminal", first);
  await page.keyboard.press("Control+Shift+p");
  await page.getByRole("combobox", { name: "Quick Access", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("xterm-helper-textarea"),
  );
  await page.keyboard.press("Control+Shift+5");
  s = await waitState(
    (s) => Object.keys(s.panes).length === 4 && s.panes[current(s)]?.status === "running",
    "Split keyboard shortcut failed",
  );
  const extra = current(s);
  await page.keyboard.press("Control+Shift+w");
  await waitState((s) => !s.panes[extra], "Close keyboard shortcut failed");
  checks.push(
    "Command palette restores terminal focus; physical Ctrl+Shift+5 and close shortcuts work",
  );

  const oldCount = Object.keys((await state()).panes).length;
  await settings({
    "files.autoSave": "off",
    "terminal.integrated.fontSize": 20,
    "terminal.integrated.fontFamily": "Consolas",
    "terminal.integrated.gpuAcceleration": "off",
    "terminal.integrated.enableMultiLinePasteWarning": "always",
  });
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".terminal-panel:not([hidden]) .xterm-rows")).some(
      (e) => getComputedStyle(e).fontSize === "20px",
    ),
  );
  assert.equal(Object.keys((await state()).panes).length, oldCount);
  await runtime("focusTerminal", first);
  const paste = runtime("pasteTerminal", first, "Write-Output 'PASTE_CANCELLED'\n");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await paste;
  assert.equal(await runtime("findTerminal", "PASTE_CANCELLED"), false);
  await runtime("pasteTerminal", first, "Write-Output ('PASTE_'+'OK')");
  await page.keyboard.press("Enter");
  await output("PASTE_OK", first);
  checks.push("Saved terminal settings update live sessions and multi-line paste can be cancelled");

  await runtime("focusTerminal", first);
  await page.keyboard.type("Write-Output ('IME_'+'");
  const ime = await page.context().newCDPSession(page);
  await ime.send("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 });
  await ime.send("Input.insertText", { text: "中文" });
  await delay(50);
  await page.keyboard.insertText("🙂");
  await delay(50);
  await page.keyboard.type("')");
  await page.keyboard.press("Enter");
  await output("IME_中文🙂", first);
  await ime.detach();
  checks.push("Composition input, Chinese text and emoji travel through the real PTY");

  await shell("exit 7", another);
  await waitState(
    (s) => s.panes[another]?.status === "exited" && s.panes[another]?.exitCode === 7,
    "Nonzero exit lost output or exit code",
  );
  await runtime("restartPane", another);
  await waitState(
    (s) => s.panes[another]?.status === "running" && s.panes[another]?.reportedCwd,
    "Restart failed",
  );
  checks.push("Nonzero shell exit remains visible and restarts in the same pane");
  await settings({
    "files.autoSave": "off",
    "terminal.integrated.fontSize": 14,
    "terminal.integrated.gpuAcceleration": "auto",
    "terminal.integrated.enableMultiLinePasteWarning": "never",
  });

  await runtime("selectTab", (await state()).tabs[0].id);
  await runtime("splitTerminal", "down", first);
  s = await waitState(
    (s) => Object.keys(s.panes).length === 4 && s.panes[current(s)]?.status === "running",
    "Stress split 3 failed",
  );
  await runtime("splitTerminal", "down", second);
  await waitState(
    (s) => Object.keys(s.panes).length === 5 && s.panes[current(s)]?.status === "running",
    "Stress split 4 failed",
  );
  for (let i = 0; i < 3; i++) {
    const id = await runtime("newTerminal");
    await waitState((s) => s.panes[id]?.status === "running", "Stress tab failed");
  }
  assert.equal(Object.keys((await state()).panes).length, 8);
  await runtime("selectTab", (await state()).tabs[0].id);
  resources("eight-sessions-before-output");
  const started = Date.now();
  await shell(
    "$watch=[Diagnostics.Stopwatch]::StartNew(); while($watch.Elapsed.TotalSeconds -lt 60){[Console]::WriteLine(('x'*2048));Start-Sleep -Milliseconds 5};Write-Output ('LOAD_'+'DONE')",
    first,
  );
  const latencies = [];
  for (let i = 0; i < 6; i++) {
    const before = Date.now();
    await shell(`Write-Output ('PING_'+'${i}')`, second);
    await output(`PING_${i}`, second);
    latencies.push(Date.now() - before);
    await page.getByRole("button", { name: "Explorer (Ctrl+Shift+E)", exact: true }).click();
    await page.getByRole("button", { name: "Terminal (Ctrl+`)", exact: true }).click();
    await delay(8000);
  }
  await output("LOAD_DONE", first);
  assert(Date.now() - started >= 60_000, "Output load ended early");
  const during = resources("eight-sessions-after-output");
  measurements.push({
    label: "input-latency-ms",
    samples: latencies,
    max: Math.max(...latencies),
    durationMs: Date.now() - started,
  });
  await page.screenshot({ path: path.join(run, "terminal-four-panes.png") });
  assert.equal(await page.locator(".terminal-panel:not([hidden]) [data-terminal-pane]").count(), 4);
  checks.push(
    "Eight sessions / four visible panes sustain 60 seconds of output while typing and switching views",
  );

  await runtime("focusTerminal", second);
  const childPidFile = path.join(root, "child.pid");
  await shell(
    `$p=Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 300' -PassThru -WindowStyle Hidden;[IO.File]::WriteAllText('${childPidFile.replaceAll("'", "''")}',[string]$p.Id)`,
    second,
  );
  await exists(childPidFile);
  const childPid = Number(await readFile(childPidFile, "utf8"));
  await runtime("closePane", second);
  await delay(500);
  const childAlive = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `[bool](Get-Process -Id ${childPid} -ErrorAction SilentlyContinue)`],
    { windowsHide: true, encoding: "utf8" },
  ).trim();
  assert.equal(childAlive, "False");
  for (const id of Object.keys((await state()).panes)) await runtime("closePane", id);
  await waitState((s) => s.tabs.length === 0, "Last tab did not become empty state");
  await page.getByRole("button", { name: "New Terminal", exact: true }).waitFor();
  await delay(500);
  const after = resources("all-terminals-closed");
  assert(
    after.processes.filter((p) => /^(pwsh|powershell|cmd|bash)\.exe$/i.test(p.name)).length === 0,
    "Shell process leaked after close",
  );
  assert(
    after.privateBytes < during.privateBytes,
    "Terminal cleanup did not release process memory",
  );
  checks.push(
    "Closing a pane kills its descendant process; closing all tabs releases shell processes and memory",
  );

  const newWindow = page.context().waitForEvent("page");
  await invoke("new_window");
  const other = await newWindow;
  await other.locator(".sidebar").waitFor({ state: "attached", timeout: 90_000 });
  await other.getByRole("button", { name: "Terminal (Ctrl+`)", exact: true }).click();
  await other.waitForFunction(() => {
    const caption = document.querySelector(".terminal-pane-caption");
    return caption && caption.textContent !== "Starting…" && caption.textContent.length > 0;
  });
  const otherCwd = await other.locator(".terminal-pane-caption").innerText();
  const rawId = await page.evaluate(async (root) => {
    const { Channel, invoke } = await import("/node_modules/@tauri-apps/api/core.js");
    return (
      await invoke("terminal_create", {
        profile: null,
        source: null,
        cwd: null,
        expectedRoot: root,
        cols: 80,
        rows: 24,
        onOutput: new Channel(),
        onEvent: new Channel(),
      })
    ).id;
  }, root);
  await assert.rejects(
    other.evaluate((id) => window.__TAURI_INTERNALS__.invoke("terminal_close", { id }), rawId),
  );
  await invoke("terminal_close", { id: rawId });
  await invoke("terminal_close", { id: rawId });
  checks.push(
    "A second window cannot close another window's terminal; closing an owned session is idempotent",
  );

  await runtime("newTerminal");
  await waitState(
    (s) => s.panes[current(s)]?.status === "running",
    "New terminal from empty state failed",
  );
  const changedRoot = path.join(run, "other-project");
  await mkdir(changedRoot);
  await invoke("explicit_open", { path: changedRoot });
  await action("core/commands", "openFolder", false, changedRoot);
  assert.equal((await state()).tabs.length, 0);
  await page.getByRole("button", { name: "Terminal (Ctrl+`)", exact: true }).click();
  await page.getByRole("button", { name: "Trust Workspace", exact: true }).click();
  s = await waitState((s) => s.panes[current(s)]?.reportedCwd, "New project terminal failed");
  assert.equal(s.panes[current(s)].cwd.toLowerCase(), changedRoot.toLowerCase());
  assert.equal(await other.locator(".terminal-pane-caption").innerText(), otherCwd);
  assert.equal(await other.locator("[data-terminal-pane]").count(), 1);
  checks.push("Switching projects clears old terminals and creates a fresh shell at the new root");

  await page.screenshot({ path: path.join(run, "terminal.png") });
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(run, "results.json"),
    JSON.stringify({ checks, errors, root, measurements }, null, 2),
  );
  console.log(JSON.stringify({ run, checks, errors }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(run, "failure.png") }).catch(() => {});
  console.error("ARTIFACTS:", run, "CHECKS:", checks);
  throw error;
} finally {
  if (page)
    await page
      .evaluate(async () => {
        (await import("/src/terminal/runtime.ts")).resetTerminals();
      })
      .catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (native.exitCode === null) {
    try {
      execFileSync("taskkill", ["/PID", String(native.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {}
  }
}
