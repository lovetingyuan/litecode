import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const latest = (await readdir(".verification")).filter((name) => /^inline-conflicts-\d+$/.test(name)).sort().pop();
if (!latest) { throw new Error("Run verify-inline-conflicts.mjs first"); }
const run = path.resolve(".verification", latest);
const reference = path.join(run, "vscode");
const data = path.join(reference, "data");
const cli = execFileSync("where.exe", ["code"], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/)[0];
const executable = process.env.VSCODE_EXECUTABLE ?? path.join(path.dirname(path.dirname(cli)), "Code.exe");
await mkdir(path.join(data, "User"), { recursive: true });
await writeFile(path.join(reference, "merge.txt"), await readFile(path.join(run, "original-conflict.txt")));
await writeFile(path.join(data, "User", "settings.json"), JSON.stringify({
  "security.workspace.trust.enabled": false, "git.mergeEditor": false,
  "workbench.startupEditor": "none", "workbench.colorTheme": "Default Dark Modern",
  "editor.fontFamily": "Consolas, 'Courier New', monospace", "editor.fontSize": 14, "editor.lineHeight": 20,
  "editor.minimap.enabled": false, "window.newWindowDimensions": "maximized", "update.mode": "none",
}));
const child = spawn(executable, ["--user-data-dir", data, "--extensions-dir", path.join(reference, "extensions"), "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--new-window", "--remote-debugging-port=9278", path.join(reference, "merge.txt")], { windowsHide: true, stdio: "ignore" });
let browser;
try {
  const deadline = Date.now() + 45000;
  while (!browser && Date.now() < deadline) {
    try { browser = await chromium.connectOverCDP("http://127.0.0.1:9278", { timeout: 1000 }); }
    catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  if (!browser) { throw new Error("VS Code debugging endpoint did not start"); }
  const page = browser.contexts()[0].pages().find((page) => page.url().includes("workbench")) ?? browser.contexts()[0].pages()[0];
  await page.getByText("Accept Current Change", { exact: true }).first().waitFor({ timeout: 60000 });
  await page.screenshot({ path: path.join(run, "04-vscode-reference.png") });
  const appearance = await page.evaluate(() => {
    const lens = document.querySelector(".codelens-decoration");
    const style = getComputedStyle(lens);
    const overlays = [...document.querySelectorAll(".view-overlays [class]")].map((element) => getComputedStyle(element).backgroundColor);
    return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight, colors: [...new Set(overlays)].filter((color) => color !== "rgba(0, 0, 0, 0)") };
  });
  await writeFile(path.join(run, "vscode-appearance.json"), JSON.stringify(appearance, null, 2));
  const native = JSON.parse(await readFile(path.join(run, "native-appearance.json"), "utf8"));
  for (const property of ["fontFamily", "fontSize", "lineHeight"]) { assert.equal(native[property], appearance[property]); }
  for (const color of native.colors) { assert.ok(appearance.colors.includes(color), `Missing VS Code reference color: ${color}`); }
  console.log("PASS: All six conflict colors and CodeLens font, size and line height match the installed VS Code reference");
  console.log({ run, appearance });
} finally {
  if (browser) { await browser.close().catch(() => {}); }
  child.kill();
}
