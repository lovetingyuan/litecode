import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, copyFile, symlink, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "playwright";

// Real Monaco providers, Tauri IPC and packaged Vue tools in a portable workspace.
const run = path.resolve(".verification", `vue-中文 ${Date.now()}`);
const app = path.join(run, "app"), root = path.join(run, "fixture");
await mkdir(path.join(app, "data"), { recursive: true });
await mkdir(path.join(root, "src"), { recursive: true });
await copyFile("src-tauri/target/debug/litecode.exe", path.join(app, "LiteCode.exe"));
await symlink(path.resolve("src-tauri/tools"), path.join(app, "tools"), "junction");
await writeFile(path.join(app, "data/session-main.json"), JSON.stringify({ root, documents: [], session: {} }));
await writeFile(path.join(app, "data/settings.json"), JSON.stringify({
  "files.autoSave": "off", "litecode.nodePath": process.execPath,
}));
await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "Bundler", paths: { "@/*": ["./src/*"] }, types: [] },
  include: ["src/**/*"],
}));
await writeFile(path.join(root, "src/helper.ts"), 'export const greeting = "hello";\n');
await writeFile(path.join(root, "src/Child.vue"), '<script setup lang="ts">\nconst title = "child";\n</script>\n<template><p>{{ title }}</p></template>\n');
const text = [
  '<script setup lang="ts">',
  'import Child from "@/Child.vue";',
  'import { greeting } from "@/helper";',
  'const message: string = greeting;',
  '</script>',
  '<template>',
  '  <Child />',
  '  <p v-if="message.length > 0">Hello {{ message }}</p>',
  '</template>',
  '<style scoped lang="scss">',
  '$color: red;',
  'p { color: $color; }',
  '</style>',
].join("\n");
await writeFile(path.join(root, "src/App.vue"), text);
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const child = spawn(path.join(app, "LiteCode.exe"), [], {
  cwd: app, windowsHide: true,
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(run, "webview"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --no-proxy-server` },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "", browser, page;
child.stdout.on("data", (b) => { log += b; });
child.stderr.on("data", (b) => { log += b; });
const checks = [], errors = [];
try {
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 180; attempt++) {
    if (child.exitCode !== null) throw new Error(`App exited: ${log}`);
    if (await fetch(`${endpoint}/json/version`).then((r) => r.ok).catch(() => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.locator("file-tree-container").waitFor({ timeout: 180_000 });
  const urls = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType("resource").flatMap((entry) => {
    if (new URL(entry.name).pathname === "/node_modules/vscode/extension.api.js") return [["vscode", entry.name]];
    const match = new URL(entry.name).pathname.match(/^\/src\/(?:editor|store|core)\/(documents|store|bridge|monaco|languages)\.ts$/);
    return match ? [[match[1], entry.name]] : [];
  })));
  await page.evaluate(async (urls) => {
    window.vueTest = { languages: await import(urls.languages), store: await import(urls.store) };
  }, urls);
  const action = (module, method, ...args) => page.evaluate(async ({ url, method, args }) => (await import(url))[method](...args), { url: urls[module], method, args });
  await action("bridge", "call", "set_workspace_trust", { expectedRoot: root, trusted: true });
  await action("documents", "openPath", path.join(root, "src/helper.ts"), { pinned: true });
  await page.waitForFunction(() => window.vueTest.languages.languageReport().services.some((s) => s.id === "typescript"));
  const id = await action("documents", "openPath", path.join(root, "src/App.vue"), { pinned: true });
  await page.waitForFunction(() => {
    const report = window.vueTest.languages.languageReport();
    return report.services.length === 2 && report.services.every((s) => s.running) && !report.starting.length;
  });
  checks.push("TypeScript service upgrades for Vue; both services run over Tauri IPC");
  for (const language of ["vue", "typescript", "scss", "less", "javascript"]) await action("monaco", "loadSyntax", language);
  const tokens = await page.evaluate(async ({ url, text }) => (await import(url)).monaco.editor.tokenize(text, "vue"), { url: urls.monaco, text });
  const has = (line, language, type) => tokens[line].some((token) => token.language === language && type.test(token.type));
  assert.ok(has(3, "typescript", /keyword/), JSON.stringify(tokens[3]));
  assert.ok(has(7, "typescript", /identifier|number/), JSON.stringify(tokens[7]));
  assert.ok(has(7, "vue", /tag/), JSON.stringify(tokens[7]));
  assert.ok(has(10, "scss", /variable/), JSON.stringify(tokens[10]));
  assert.ok(has(8, "vue", /tag/), JSON.stringify(tokens[8]));
  checks.push("Vue template, interpolation, directive, TypeScript and SCSS tokens");
  async function definitions(lineNumber, column) {
    return page.evaluate(async ({ urls, id, lineNumber, column }) => {
      const { models } = await import(urls.documents);
      const vscode = await import(urls.vscode);
      const result = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", models.get(id).uri, new vscode.Position(lineNumber - 1, column - 1));
      return (result ?? []).map((d) => ({ path: (d.targetUri ?? d.uri).fsPath, line: (d.targetSelectionRange ?? d.range).start.line }));
    }, { urls, id, lineNumber, column });
  }
  const helper = await definitions(4, 26);
  assert.ok(helper.some((d) => d.path.endsWith("helper.ts")), JSON.stringify(helper));
  const component = await definitions(7, 5);
  assert.ok(component.some((d) => d.path.endsWith("Child.vue")), JSON.stringify(component));
  const variable = await definitions(8, 44);
  assert.ok(variable.some((d) => d.line === 3), JSON.stringify(variable));
  checks.push("Monaco definition providers resolve aliases, Vue components and template variables");
  // Exercise the actual F12 command and the registered editor opener.
  await page.evaluate(async ({ url }) => {
    const editor = (await import(url)).editor();
    editor.setPosition({ lineNumber: 7, column: 5 });
    editor.focus();
  }, { url: urls.documents });
  await page.keyboard.press("F12");
  await page.waitForFunction(() => {
    const state = window.vueTest.store.useApp.getState();
    const group = state.groups.find((g) => g.id === state.activeGroup);
    return state.docs[group.active]?.path.endsWith("Child.vue");
  });
  checks.push("F12 opens the target Vue component");
  await action("documents", "openPath", path.join(root, "src/App.vue"), { pinned: true });
  const target = await page.evaluate(async (url) => {
    const editor = (await import(url)).editor();
    editor.revealLineInCenter(4);
    editor.focus();
    const position = editor.getScrolledVisiblePosition({ lineNumber: 4, column: 26 });
    const bounds = editor.getDomNode().getBoundingClientRect();
    return { x: bounds.x + position.left + 2, y: bounds.y + position.top + position.height / 2 };
  }, urls.documents);
  await page.keyboard.down("Control");
  try {
    await page.mouse.move(target.x, target.y);
    await page.locator(".goto-definition-link").first().waitFor();
    await page.mouse.click(target.x, target.y);
  } finally {
    await page.keyboard.up("Control");
  }
  await page.waitForFunction(() => {
    const state = window.vueTest.store.useApp.getState();
    const group = state.groups.find((g) => g.id === state.activeGroup);
    return state.docs[group.active]?.path.endsWith("helper.ts");
  });
  checks.push("Ctrl+click opens a TypeScript definition from Vue");
  await action("documents", "openPath", path.join(root, "src/App.vue"), { pinned: true });
  await page.evaluate(async ({ url, id, text }) => {
    const model = (await import(url)).models.get(id);
    model.setValue(text.replace('const message: string = greeting;', 'const message: string = "unsaved";\nconst count = 42;'));
  }, { url: urls.documents, id, text });
  const unsaved = await definitions(9, 44);
  assert.ok(unsaved.some((d) => d.line === 3), JSON.stringify(unsaved));
  assert.equal(await readFile(path.join(root, "src/App.vue"), "utf8"), text);
  checks.push("Unsaved Vue edits update definitions without changing the file on disk");
  await page.screenshot({ path: path.join(run, "vue-highlighting.png") });
  assert.deepEqual(errors, []);
  await writeFile("docs/verification/vue-desktop-results.json", JSON.stringify({ run, checks, errors }, null, 2));
  console.log(checks.join("\n"));
} catch (error) {
  if (page) {
    console.error(await page.evaluate(() => document.body.innerText).catch(() => ""));
    await page.screenshot({ path: path.join(run, "failure.png") }).catch(() => {});
  }
  console.error(log.slice(-2000));
  throw error;
} finally {
  await browser?.close();
  child.kill();
}
