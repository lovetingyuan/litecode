import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const url =
  process.argv.find((arg) => arg.startsWith("--url="))?.slice(6) ?? "http://localhost:1420/";
const directory = path.resolve(".verification/startup/loading");
await mkdir(directory, { recursive: true });
const systemChrome = path.join(
  process.env.ProgramFiles ?? "C:/Program Files",
  "Google/Chrome/Application/chrome.exe",
);
const executablePath =
  process.env.CHROME_PATH ?? (existsSync(systemChrome) ? systemChrome : undefined);
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : { channel: "chrome" }),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(/\.(css|js|tsx)(\?|$)/, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith(".css") || /\/workbench[-.]/.test(pathname)) await held;
    await route.continue();
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(
      () => performance.getEntriesByName("startup:loading-painted").length > 0,
    );
    assert(await page.locator(".startup-loading").isVisible());
    const timing = await page.evaluate(() => ({
      firstPaint: performance.getEntriesByName("first-paint", "paint")[0]?.startTime,
      loading: performance.getEntriesByName("startup:loading-painted")[0]?.startTime,
      animation: getComputedStyle(document.querySelector(".startup-loading"), "::after")
        .animationName,
      mounted: !!document.querySelector(".workbench"),
    }));
    assert(timing.firstPaint <= timing.loading);
    assert.equal(timing.animation, "none");
    assert.equal(timing.mounted, false);
    await page.screenshot({ path: path.join(directory, "loading.png") });
    console.log("Loading painted with workbench JS/CSS held:", timing);
  } finally {
    release();
  }
  await page.waitForFunction(
    () => performance.getEntriesByName("startup:workbench-painted").length > 0,
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(directory, "ready.png") });

  // A failed workbench download must leave a usable retry control.
  const failure = await browser.newPage();
  await failure.route(/\/workbench[^/]*\.(js|tsx)(\?|$)/, (route) => route.abort());
  await failure.goto(url, { waitUntil: "domcontentloaded" });
  await failure.locator(".startup-failed").waitFor();
  assert(await failure.getByRole("button", { name: "Reload", exact: true }).isVisible());
  await failure.unrouteAll();
  await failure.getByRole("button", { name: "Reload", exact: true }).click();
  await failure.waitForFunction(
    () => performance.getEntriesByName("startup:workbench-painted").length > 0,
  );
  console.log("Passed early loading, reduced motion, failed import and reload checks.");
} finally {
  await browser.close();
}
