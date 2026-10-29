// Capture the real desktop application, never a browser recreation of its UI.
import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const { chromium } = createRequire(import.meta.url)("playwright");

export const run = path.resolve(".verification/website");
export const project = path.join(run, "daylight");
export const app = path.join(run, "app");
export const assets = path.resolve("website/assets/screenshots");
const files = {
  "package.json": JSON.stringify({ name: "daylight", private: true, version: "1.0.0", type: "module", scripts: { dev: "vite", build: "vite build" }, devDependencies: { vite: "^8.0.0", typescript: "^6.0.0" } }, null, 2) + "\n",
  ".gitignore": "node_modules\ndist/\n",
  "index.html": '<!doctype html>\n<html lang="en">\n  <head><meta charset="UTF-8"><title>Daylight · A little room to focus</title></head>\n  <body><main id="app"></main><script type="module" src="/src/main.ts"></script></body>\n</html>\n',
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, lib: ["ES2022", "DOM"], noEmit: true }, include: ["src"] }, null, 2) + "\n",
  "src/vite-env.d.ts": '/// <reference types="vite/client" />\n',
  "src/tasks.ts": 'export interface Task {\n  id: string;\n  title: string;\n  completed: boolean;\n}\n\nexport const initialTasks: Task[] = [\n  { id: "sketch", title: "Sketch the idea", completed: true },\n  { id: "build", title: "Build something small", completed: true },\n  { id: "review", title: "Review the details", completed: false },\n  { id: "ship", title: "Make it yours", completed: false },\n];\n\nexport function remainingTasks(tasks: Task[]): number {\n  return tasks.filter((task) => !task.completed).length;\n}\n',
  "src/main.ts": 'import "./style.css";\nimport { initialTasks, remainingTasks, type Task } from "./tasks";\n\nconst tasks: Task[] = [...initialTasks];\nconst app = document.querySelector<HTMLElement>("#app")!;\n\nfunction render(): void {\n  app.innerHTML = `\n    <header>\n      <span class="wordmark">daylight.</span>\n      <span class="date">A little room to focus</span>\n    </header>\n    <section class="workspace">\n      <p class="intro">ONE THING AT A TIME</p>\n      <h1>Good things start small.</h1>\n      <p class="description">A quiet place for your next idea.</p>\n      <ul class="tasks">\n        ${tasks.map((task) => `\n          <li>\n            <label class="${task.completed ? "done" : ""}">\n              <input type="checkbox" data-id="${task.id}"\n                ${task.completed ? "checked" : ""}>\n              <span>${task.title}</span>\n            </label>\n          </li>\n        `).join("")}\n      </ul>\n      <footer>${remainingTasks(tasks)} things left. You have time.</footer>\n    </section>\n  `;\n}\n\napp.addEventListener("change", (event) => {\n  const input = event.target as HTMLInputElement;\n  const task = tasks.find((item) => item.id === input.dataset.id);\n  if (task) {\n    task.completed = input.checked;\n    render();\n  }\n});\n\nrender();\n',
  "src/style.css": ':root {\n  font-family: system-ui, sans-serif;\n  color: #26352e;\n  background: #f8f7f2;\n}\n\nbody { margin: 0; }\nheader { display: flex; justify-content: space-between; padding: 32px 48px; }\n.wordmark { font-size: 24px; font-weight: 700; }\n.date { color: #68756d; }\n.workspace { max-width: 640px; margin: 80px auto; }\n.intro { color: #68756d; font-size: 12px; letter-spacing: .12em; }\nh1 { font-size: 48px; font-weight: 500; letter-spacing: -.04em; }\n.description { color: #68756d; font-size: 18px; }\n.tasks { list-style: none; padding: 24px 0; }\n.tasks label { display: flex; gap: 16px; padding: 16px 0; }\n.tasks input { accent-color: #46765c; }\n.done span { color: #68756d; text-decoration: line-through; }\nfooter { color: #68756d; font-size: 14px; }\n',
  "README.md": '# Daylight\n\nA little room to focus. A small task list built with **Vite** and **TypeScript**.\n\n## Start small\n\nWrite an idea down. Build a little. Review the details.\n\n```sh\nnpm install\nnpm run dev\n```\n\n## What is inside\n\n| File | Purpose |\n| --- | --- |\n| `src/main.ts` | Render the task list and handle changes |\n| `src/tasks.ts` | Keep task data and types together |\n| `src/style.css` | A quiet, readable workspace |\n\n## Before you ship\n\n- [x] Keep the interface small\n- [x] Give every task a clear name\n- [ ] Review the changes in Git\n- [ ] Make it yours\n\nBuilt one thoughtful detail at a time.\n',
};

export async function launch() {
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(app, "data"), { recursive: true });
  await mkdir(assets, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(project, name), text);
  const git = (...args) => execFileSync("git", ["-C", project, ...args], { windowsHide: true, stdio: "pipe" });
  git("init", "-b", "main");
  git("add", ".");
  git("-c", "user.name=LiteCode Demo", "-c", "user.email=demo@example.invalid", "commit", "--allow-empty", "-m", "Start with a small idea");
  await writeFile(path.join(project, "src/tasks.ts"), files["src/tasks.ts"].replace("Make it yours", "Ship something thoughtful").replace("!task.completed", "task.completed === false"));
  await writeFile(path.join(project, "src/style.css"), files["src/style.css"].replace("#f8f7f2", "#f5f3ec"));
  await writeFile(path.join(project, "NOTES.md"), "# Next steps\n\nLet AI help with the first draft. Make the final details your own.\n");
  await symlink(path.resolve("node_modules"), path.join(project, "node_modules"), "junction").catch((error) => { if (error.code !== "EEXIST") throw error; });
  await symlink(path.resolve("src-tauri/tools"), path.join(app, "tools"), "junction").catch((error) => { if (error.code !== "EEXIST") throw error; });
  await copyFile("src-tauri/target/release/litecode.exe", path.join(app, "LiteCode.exe"));
  await writeFile(path.join(app, "data/settings.json"), JSON.stringify({ "files.autoSave": "off", "files.exclude": { "node_modules": true, "**/node_modules": true }, "editor.fontSize": 15, "editor.minimap.enabled": false, "terminal.integrated.fontSize": 16, "terminal.integrated.defaultProfile.windows": "Windows PowerShell", "terminal.integrated.profiles.windows": { "Windows PowerShell": { path: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", args: ["-NoLogo", "-NoProfile"] } }, "litecode.checkForUpdatesOnStartup": false }));
  await writeFile(path.join(app, "data/session-main.json"), JSON.stringify({ root: project, documents: [], session: {} }));
  const child = spawn(path.join(app, "LiteCode.exe"), [], { cwd: app, windowsHide: true, stdio: "ignore", env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(run, "webview"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=19427 --no-proxy-server" } });
  let browser;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { browser = await chromium.connectOverCDP("http://127.0.0.1:19427"); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  if (!browser) { child.kill(); throw new Error("The desktop WebView did not start"); }
  const page = browser.contexts()[0].pages()[0];
  try {
    await page.waitForURL("http://tauri.localhost/**");
    await page.locator("file-tree-container").waitFor({ timeout: 90_000 });
  } catch (error) {
    await page.screenshot({ path: path.join(run, "startup-failure.png") });
    console.error(await page.locator("body").innerText());
    await browser.close();
    child.kill();
    throw error;
  }
  return { browser, page, child };
}

export async function openFile(page, name) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+p");
  await page.getByRole("combobox", { name: "Quick Access", exact: true }).fill(name);
  await page.keyboard.press("Enter");
  await page.locator(".editor-tab.active").filter({ hasText: name }).waitFor();
}

export async function capture(page, name) {
  await page.screenshot({ path: path.join(run, `${name}.png`), scale: "css" });
  execFileSync("ffmpeg", ["-y", "-i", path.join(run, `${name}.png`), "-c:v", "libwebp", "-quality", "90", path.join(assets, `${name}.webp`)], { windowsHide: true, stdio: "pipe" });
}

async function command(page, text) {
  await page.keyboard.press("Control+Shift+p");
  await page.getByRole("combobox", { name: "Quick Access", exact: true }).fill(`>${text}`);
  await page.keyboard.press("Enter");
  await page.locator(".quick-open").waitFor({ state: "hidden" });
}

async function waitUntil(check, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${label}`);
}

export async function captureAll(page) {
  await openFile(page, "main.ts");
  const trust = page.getByText("Trust Workspace", { exact: true });
  if (await trust.isVisible()) await trust.click();
  for (const name of ["main.ts", "tasks.ts", "style.css", "main.ts"]) {
    await openFile(page, name);
    await page.locator(".editor-tab.active").filter({ hasText: name }).dblclick();
  }
  await command(page, "Split Editor");
  await openFile(page, "tasks.ts");
  await page.waitForTimeout(1500);
  await capture(page, "workspace");

  await page.locator('[aria-label="Close Editor Group"]').last().click();
  await openFile(page, "tasks.ts");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\ninitialTasks.");
  await page.keyboard.press("Control+Space");
  await page.locator(".suggest-widget.visible .monaco-list-row").first().waitFor();
  await capture(page, "editor");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+z");

  await openFile(page, "main.ts");
  await page.locator('[aria-label="Search (Ctrl+Shift+F)"]').click();
  await page.locator('[aria-label="Search text"]').fill("tasks");
  await page.locator(".search-summary").filter({ hasText: /results in/ }).waitFor();
  await capture(page, "search");

  await page.locator('[aria-label="Source Control (Ctrl+Shift+G)"]').click();
  await page.locator('.git-view [data-item-path="src/tasks.ts"], .git-view [aria-label="src/tasks.ts"]').first().click();
  await page.locator(".monaco-diff-editor").waitFor();
  await page.waitForTimeout(500);
  await capture(page, "git");

  await page.locator('[aria-label="Explorer (Ctrl+Shift+E)"]').click();
  await openFile(page, "README.md");
  await page.locator(".editor-tab.active").filter({ hasText: "README.md" }).dblclick();
  await command(page, "Split Editor");
  await page.locator('.editor-group.focused [aria-label="Select Markdown editor"]').click();
  await page.getByRole("menuitem").filter({ hasText: "Markdown Preview" }).click();
  await page.locator(".markdown-preview h1").waitFor();
  await capture(page, "preview");

  await page.locator('[aria-label="Terminal (Ctrl+`)"]').click();
  await page.locator(".xterm-helper-textarea").first().waitFor({ state: "attached" });
  const typeCommand = async (index, text) => {
    await page.locator(".xterm-helper-textarea").nth(index).focus();
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
  };
  // A real shell prompt keeps the demo's long absolute path out of command lines.
  await page.waitForTimeout(500);
  await typeCommand(0, "function prompt { 'PS daylight> ' }; Clear-Host");
  await page.waitForTimeout(300);
  await typeCommand(0, "npm run dev -- --host 127.0.0.1 --port 5178 --strictPort");
  await waitUntil(() => fetch("http://127.0.0.1:5178").then((response) => response.ok).catch(() => false), "Vite development server");
  await page.locator('[aria-label="Split Terminal Right"]').click();
  await page.locator(".xterm-helper-textarea").nth(1).waitFor({ state: "attached" });
  await page.waitForTimeout(500);
  await typeCommand(1, "function prompt { 'PS daylight> ' }; Clear-Host");
  await page.waitForTimeout(300);
  await typeCommand(1, "npm run build");
  await waitUntil(() => readFile(path.join(project, "dist/index.html")).then(() => true).catch(() => false), "Vite build output");
  await page.waitForTimeout(1000);
  await capture(page, "terminal");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { browser, page, child } = await launch();
  try {
    await captureAll(page);
    const names = ["workspace", "editor", "search", "terminal", "git", "preview"];
    const provenance = {
      capturedAt: new Date().toISOString(),
      source: "Real LiteCode Windows desktop WebView with embedded production assets",
      sample: "Daylight, an illustrative Vite + TypeScript project",
      executableSha256: createHash("sha256").update(await readFile(path.join(app, "LiteCode.exe"))).digest("hex"),
      viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio })),
      outputScale: "css",
      images: await Promise.all(names.map(async (name) => ({ file: `${name}.webp`, sha256: createHash("sha256").update(await readFile(path.join(assets, `${name}.webp`))).digest("hex") }))),
    };
    await writeFile(path.join(run, "provenance.json"), JSON.stringify(provenance, null, 2));
    console.log(`Captured ${names.length} real desktop screenshots in ${assets}`);
  } catch (error) {
    await page.screenshot({ path: path.join(run, "capture-failure.png"), scale: "css" }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
    child.kill();
  }
}
