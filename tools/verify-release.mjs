import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

// Exercise embedded production assets and a Store shell alias without the dev server.
const executable = path.resolve(process.argv[2] ?? "src-tauri/target/release/litecode.exe");
const run = path.resolve(".verification", `release-${Date.now()}`);
const app = path.join(run, "app"),
  root = path.join(run, "project 中文 space");
await mkdir(path.join(app, "data"), { recursive: true });
await mkdir(root, { recursive: true });
await copyFile(executable, path.join(app, "LiteCode.exe"));
await symlink(path.resolve("src-tauri/tools"), path.join(app, "tools"), "junction");
const alias = path.join(process.env.LOCALAPPDATA, "Microsoft/WindowsApps/pwsh.exe");
const shell = await access(alias)
  .then(() => alias)
  .catch(() => path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"));
await writeFile(
  path.join(app, "data/settings.json"),
  JSON.stringify({
    "files.autoSave": "off",
    "terminal.integrated.defaultProfile.windows": "Release Test Shell",
    "terminal.integrated.profiles.windows": {
      "Release Test Shell": { path: shell, args: ["-NoProfile"] },
    },
  }),
);
await writeFile(
  path.join(app, "data/session-main.json"),
  JSON.stringify({ root, documents: [], session: {} }),
);
const samples = {
  "index.js": 'export const message = "Hello";\nconsole.log(message);\n',
  "main.ts": "export const count: number = 42;\n",
  "App.vue":
    '<template><p v-if="message">Hello</p></template>\n<script>\nexport default { data() { return { message: "hello" }; } };\n</script>\n<style>p { color: red; }</style>\n',
  "config.json": '{"name": "LiteCode", "count": 42}\n',
  "main.py": 'def hello():\n    return "Hello"\n',
  "style.css": ".message { color: red; font-size: 14px; }\n",
};
for (const [name, text] of Object.entries(samples)) await writeFile(path.join(root, name), text);
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const child = spawn(path.join(app, "LiteCode.exe"), [], {
  cwd: app,
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: path.join(run, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --no-proxy-server`,
  },
});
let browser, page;
const errors = [],
  colors = {},
  checks = [];
let stage = "startup";
try {
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assert(browser, "Production WebView did not start");
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`${stage}: ${message.text()}`);
      console.error(stage, message.text());
    }
  });
  await page.waitForURL("http://tauri.localhost/**");
  await page.locator("file-tree-container").waitFor();
  // Reload after attaching listeners to capture startup CSP violations as well.
  await page.reload();
  // Start with Vue so its shared TypeScript service need not be replaced mid-test.
  for (const name of ["App.vue", ...Object.keys(samples).filter((name) => name !== "App.vue")]) {
    stage = name;
    console.log(`Checking ${name}`);
    await page.locator(`[data-item-path="${name}"]`).dblclick();
    await page.getByRole("tab", { name, exact: true, selected: true }).waitFor();
    if (name === "App.vue") {
      // Highlighting must work in Restricted Mode without external language servers.
      await page.getByRole("button", { name: "Restricted Mode", exact: true }).click();
    }
    await page.waitForFunction(() => {
      const tokens = [
        ...document.querySelectorAll(".monaco-editor .view-lines span[class*='mtk']"),
      ];
      return (
        new Set(tokens.filter((t) => t.textContent.trim()).map((t) => getComputedStyle(t).color))
          .size >= 3
      );
    });
    colors[name] = await page
      .locator(".monaco-editor .view-lines")
      .first()
      .evaluate((element) => [
        ...new Set(
          [...element.querySelectorAll("span[class*='mtk']")]
            .filter((t) => t.textContent.trim())
            .map((t) => getComputedStyle(t).color),
        ),
      ]);
    assert(colors[name].length >= 3, `${name} lost token colors`);
  }
  checks.push(
    "JavaScript, TypeScript, Vue, JSON, Python and CSS have visible token colors in the release WebView",
  );
  await page.getByRole("tab", { name: "App.vue", exact: true }).click();
  await page.screenshot({ path: path.join(run, "highlighting.png") });
  stage = "terminal";
  await page.getByRole("button", { name: "Terminal (Ctrl+`)", exact: true }).click();
  await page.getByRole("button", { name: "Trust Workspace and Retry", exact: true }).click();
  await page.getByRole("button", { name: "Trust Workspace", exact: true }).click();
  await page.locator(".terminal-pane-caption").filter({ hasText: root }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Restart Terminal", exact: true }).count(),
    0,
  );
  // Shell initialization can still be running after terminal_create returns.
  await page.getByRole("button", { name: "Find in Terminal (Ctrl+F)", exact: true }).click();
  await page.getByRole("textbox", { name: "Terminal search", exact: true }).fill(root);
  for (let attempt = 0; attempt < 100; attempt++) {
    await page.getByRole("textbox", { name: "Terminal search", exact: true }).press("Enter");
    if ((await page.locator(".terminal-find [role='status']").textContent()) === "") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(
    await page.locator(".terminal-find [role='status']").textContent(),
    "",
    "Shell prompt did not appear",
  );
  await page.getByRole("textbox", { name: "Terminal search", exact: true }).press("Escape");
  const input = page.locator(".xterm-helper-textarea").first();
  await input.focus();
  await page.keyboard.type(
    "Set-Content -LiteralPath 'release-shell.txt' -Value ('RELEASE_' + 'SHELL_OK'); Write-Output ('RELEASE_' + 'OUTPUT_OK')",
  );
  await page.keyboard.press("Enter");
  const marker = path.join(root, "release-shell.txt");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await readFile(marker, "utf8")
        .then((text) => text.includes("RELEASE_SHELL_OK"))
        .catch(() => false)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(await readFile(marker, "utf8"), /RELEASE_SHELL_OK/);
  await page.getByRole("button", { name: "Find in Terminal (Ctrl+F)", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Terminal search", exact: true })
    .fill("MISSING_RELEASE_OUTPUT");
  await page.locator(".terminal-find [role='status']").filter({ hasText: "No results" }).waitFor();
  await page
    .getByRole("textbox", { name: "Terminal search", exact: true })
    .fill("RELEASE_OUTPUT_OK");
  await page.waitForFunction(
    () => document.querySelector(".terminal-find [role='status']")?.textContent === "",
  );
  checks.push(
    `Shell launches and accepts input, produces output, and uses the project directory: ${shell}`,
  );
  await page.screenshot({ path: path.join(run, "terminal.png") });
  assert.deepEqual(errors, [], "Release must have no CSP or runtime errors");
  checks.push("No CSP or JavaScript errors");
  await writeFile(
    path.join(run, "report.json"),
    JSON.stringify({ executable, shell, checks, colors, errors }, null, 2),
  );
  console.log(JSON.stringify({ run, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(run, "failure.png") }).catch(() => {});
  console.error({ run, errors });
  throw error;
} finally {
  await browser?.close();
  child.kill();
}
