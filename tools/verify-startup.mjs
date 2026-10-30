import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const option = (name, fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=") ?? fallback;
const label = option("label", "startup");
assert.match(label, /^[\w-]+$/);
const run = path.resolve(".verification/startup", `${label}-${Date.now()}`);
const executable = path.resolve(option("exe", "src-tauri/target/debug/litecode.exe"));
const url = option("url", "http://localhost:1420/");
const runs = Number(option("runs", "3"));
assert(Number.isInteger(runs) && runs > 0 && runs <= 20);
const expectEarlyLoading = process.argv.includes("--expect-early-loading");
const profile = option("profile");
const results = [];
await mkdir(run, { recursive: true });

for (let index = 0; index < runs; index++) {
  const directory = path.join(run, String(index));
  await mkdir(path.join(directory, "data"), { recursive: true });
  await copyFile(executable, path.join(directory, "LiteCode.exe"));
  const port = 21000 + ((Date.now() + index) % 10000);
  const nativeLog = path.join(directory, "native.jsonl");
  const launchedAt = Date.now();
  const native = spawn(path.join(directory, "LiteCode.exe"), [], {
    cwd: directory,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      LITECODE_STARTUP_LOG: nativeLog,
      WEBVIEW2_USER_DATA_FOLDER: profile ? path.resolve(profile) : path.join(directory, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });
  let browser;
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${endpoint}/json/version`);
        if (response.ok) {
          browser = await chromium.connectOverCDP(endpoint);
          break;
        }
      } catch {
        // WebView2 has not opened its debugging port yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(browser, "WebView2 did not start");
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent("page"));
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.waitForURL(url, { timeout: 30000 });
    await page.waitForFunction(
      () => performance.getEntriesByName("startup:workbench-painted").length > 0,
      undefined,
      { timeout: 60000 },
    );
    const sample = await page.evaluate(() => ({
      navigationStartedAt: performance.timeOrigin,
      paints: performance
        .getEntriesByType("paint")
        .map((entry) => ({ name: entry.name, ms: entry.startTime })),
      marks: performance
        .getEntriesByType("mark")
        .filter((entry) => entry.name.startsWith("startup:"))
        .map((entry) => ({ name: entry.name.slice(8), ms: entry.startTime, detail: entry.detail })),
      resources: performance.getEntriesByType("resource").map((entry) => ({
        name: new URL(entry.name).pathname,
        ms: entry.duration,
        bytes: entry.decodedBodySize,
      })),
      ready: !!document.querySelector(".workbench-layout"),
    }));
    assert(sample.ready, "Workbench is not ready");
    assert.deepEqual(errors, []);
    if (expectEarlyLoading) {
      const loading = sample.marks.find((mark) => mark.name === "loading-painted");
      const modules = sample.marks.find((mark) => mark.name === "workbench-module-loaded");
      const firstPaint = sample.paints.find((paint) => paint.name === "first-paint");
      assert(
        loading && modules && loading.ms < modules.ms,
        "Loading must paint before the workbench module evaluates",
      );
      assert(
        firstPaint && firstPaint.ms <= loading.ms,
        "Record loading only after an actual first paint",
      );
    }
    const nativePhases = (await readFile(nativeLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    results.push({
      index,
      navigationAfterLaunchMs: sample.navigationStartedAt - launchedAt,
      ...sample,
      nativePhases,
      errors,
    });
    await page.screenshot({ path: path.join(directory, "ready.png") });
    console.log(
      JSON.stringify({
        index,
        navigationAfterLaunchMs: sample.navigationStartedAt - launchedAt,
        paints: sample.paints,
        marks: sample.marks,
      }),
    );
    await writeFile(
      path.join(run, "results.json"),
      JSON.stringify({ label, url, results }, null, 2),
    );
    const exited = new Promise((resolve) => native.once("exit", resolve));
    // Destroying the final window closes the renderer before invoke can resolve.
    await page
      .evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|destroy"))
      .catch((error) => {
        if (!page.isClosed()) throw error;
      });
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  } finally {
    await browser?.close().catch(() => {});
    if (native.exitCode === null) native.kill();
  }
}

await writeFile(path.join(run, "results.json"), JSON.stringify({ label, url, results }, null, 2));
console.log(`Startup measurements: ${path.join(run, "results.json")}`);
