import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, copyFile, symlink, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "playwright";

// Real Tauri/WebView2 over CDP, real settings files and IPC. No standalone browser.
const appIndex = process.argv.indexOf("--app");
const executable = path.resolve(appIndex < 0 ? "src-tauri/target/debug/litecode.exe" : process.argv[appIndex + 1]);
const run = path.resolve(".verification", `fonts-native-${Date.now()}`);
const root = path.join(run, "fixture"), app = path.join(run, "app"), data = path.join(app, "data");
await mkdir(path.join(root, ".litecode"), { recursive: true });
await mkdir(data, { recursive: true });
await copyFile(executable, path.join(app, "LiteCode.exe"));
await symlink(path.resolve("src-tauri/tools"), path.join(app, "tools"), "junction");
await writeFile(path.join(data, "session-main.json"), JSON.stringify({ root, documents: [], session: {} }));
const initial = { "editor.fontSize": 16, "editor.lineHeight": 25 };
await writeFile(path.join(data, "settings.json"), JSON.stringify(initial));
await writeFile(path.join(root, ".litecode/settings.json"), "{}");
await writeFile(path.join(root, "sample.txt"), "// 隐藏窗口\nexport function test() {\n  return window;\n}\n// 调用登录对话框");
await writeFile(path.join(root, "preview.md"), "# Preview\n\n正文 and `隐藏窗口 =>`.\n\n```js\n// 调用登录对话框\nconst code = 1;\n```\n\n```\n普通代码 中文\n```");
const server = createServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const child = spawn(path.join(app, "LiteCode.exe"), [], {
  cwd: app, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(run, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --no-proxy-server`,
  },
});
let log = "", browser, page;
child.stdout.on("data", value => { log += value; });
child.stderr.on("data", value => { log += value; });
const errors = [], evidence = [];
try {
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 180; attempt++) {
    if (child.exitCode !== null) throw new Error(`App exited ${child.exitCode}: ${log}`);
    if (await fetch(`${endpoint}/json/version`).then(r => r.ok).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  page = context.pages()[0];
  page.setDefaultTimeout(30_000);
  page.on("pageerror", error => errors.push(String(error)));
  await page.waitForURL("http://localhost:1420/**", { waitUntil: "commit", timeout: 60_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("file-tree-container").waitFor({ timeout: 120_000 });
  console.log("Native Tauri ready");
  const urls = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType("resource").flatMap(entry => {
    const match = new URL(entry.name).pathname.match(/^\/src\/(?:editor|store|core)\/(documents|store|bridge|monaco)\.ts$/);
    return match ? [[match[1], entry.name]] : [];
  })));
  const action = (module, method, ...args) => page.evaluate(async ({ url, method, args }) =>
    (await import(url))[method](...args), { url: urls[module], method, args });
  const codeId = await action("documents", "openPath", path.join(root, "sample.txt"), { pinned: true });
  const codeGroup = await page.evaluate(async url => (await import(url)).useApp.getState().activeGroup, urls.store);
  await action("documents", "splitGroup", codeGroup);
  const markdownId = await action("documents", "openPath", path.join(root, "preview.md"), { pinned: true });
  const previewGroup = await page.evaluate(async url => (await import(url)).useApp.getState().activeGroup, urls.store);
  await action("documents", "patchMediaView", previewGroup, markdownId, { mode: "markdown" });
  await page.locator(".markdown-body code").first().waitFor();
  const userPath = await action("bridge", "call", "settings_path", { kind: "settings" });
  const userId = await action("documents", "openPath", userPath, { pinned: true, group: codeGroup });
  const workspaceId = await action("documents", "openPath", path.join(root, ".litecode/settings.json"), { pinned: true, group: codeGroup });
  await action("documents", "showDocument", codeId, { group: codeGroup, pinned: true });
  const client = await context.newCDPSession(page);
  await client.send("DOM.enable");
  await client.send("CSS.enable");
  async function fonts(selector) {
    const { root: document } = await client.send("DOM.getDocument");
    const { nodeIds } = await client.send("DOM.querySelectorAll", { nodeId: document.nodeId, selector });
    const result = [];
    for (const nodeId of nodeIds) result.push(...(await client.send("CSS.getPlatformFontsForNode", { nodeId })).fonts);
    return result.filter(font => font.glyphCount > 0);
  }
  const codeSelector = `[data-group-id="${codeGroup}"] .view-lines .view-line span span`;
  async function checkGlyphs(expected) {
    const code = await fonts(codeSelector), preview = await fonts(".markdown-body code, .markdown-body code span");
    assert.ok(code.some(font => font.familyName === expected), JSON.stringify(code));
    assert.ok(preview.some(font => font.familyName === expected), JSON.stringify(preview));
    evidence.push({ expected, code, preview });
  }
  async function save(id, value) {
    await page.evaluate(async ({ url, id, value }) => {
      const { models, save } = await import(url);
      models.get(id).setValue(JSON.stringify(value, null, 2));
      await save(id);
    }, { url: urls.documents, id, value });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function checkOptions(family, ligatures) {
    await page.waitForFunction(async ({ urls, family, ligatures }) => {
      const { editors } = await import(urls.documents);
      const { monaco } = await import(urls.monaco);
      const { editorFontOptions, previewFontStyle } = await import("/src/editor/font.ts");
      const settings = { "editor.fontFamily": family, "editor.fontLigatures": ligatures };
      const expected = editorFontOptions(settings).fontFamily;
      const features = previewFontStyle(settings)["--code-font-features"];
      const active = [...editors.values()].filter(editor => editor.hasModel());
      return active.length > 0 && active.every(editor =>
        editor.getOption(monaco.editor.EditorOption.fontFamily) === expected &&
        editor.getOption(monaco.editor.EditorOption.fontLigatures) === features);
    }, { urls, family, ligatures });
  }
  await checkOptions(undefined, false);
  await checkGlyphs("Microsoft YaHei");
  assert.ok((await fonts(codeSelector)).some(font => font.familyName === "Consolas"));
  assert.ok(!(await fonts(codeSelector)).some(font => font.familyName === "NSimSun"));
  await page.screenshot({ path: path.join(run, "default.png") });
  console.log("PASS: actual Latin glyphs use Consolas; Chinese glyphs use Microsoft YaHei instead of NSimSun");
  for (const ligatures of [true, false, "'liga' off, 'calt' on", "true", "false", ""]) {
    const family = '"Missing Font 中文", "Courier New", monospace';
    await save(userId, { ...initial, "editor.fontFamily": family, "editor.fontLigatures": ligatures });
    await checkOptions(family, ligatures);
    await checkGlyphs("Microsoft YaHei");
  }
  await save(workspaceId, { "editor.fontFamily": 'Consolas, "SimSun", monospace', "editor.fontLigatures": true });
  await checkOptions('Consolas, "SimSun", monospace', true);
  await checkGlyphs("SimSun");
  await save(workspaceId, {});
  await checkOptions('"Missing Font 中文", "Courier New", monospace', "");
  await checkGlyphs("Microsoft YaHei");
  await action("documents", "splitGroup", codeGroup);
  await checkOptions('"Missing Font 中文", "Courier New", monospace', "");
  await action("documents", "patchMediaView", previewGroup, markdownId, { mode: "text" });
  await checkOptions('"Missing Font 中文", "Courier New", monospace', "");
  await action("documents", "patchMediaView", previewGroup, markdownId, { mode: "markdown" });
  await page.locator(".markdown-body code").first().waitFor();
  await save(userId, initial);
  await checkOptions(undefined, false);
  await checkGlyphs("Microsoft YaHei");
  assert.deepEqual(JSON.parse(await readFile(userPath, "utf8")), initial);
  assert.deepEqual(errors, []);
  await writeFile(path.join(run, "fonts.json"), JSON.stringify(evidence, null, 2));
  console.log(`PASS: real JSON saves, user/workspace precedence/reset, explicit CJK font override, ligature options, new splits and preview/source toggle. Artifacts: ${run}`);
} catch (error) {
  await page?.screenshot({ path: path.join(run, "failure.png") }).catch(() => {});
  console.error(log, errors, await page?.locator("body").innerText().catch(() => ""));
  throw error;
} finally {
  await browser?.close().catch(() => {});
  child.kill();
}
