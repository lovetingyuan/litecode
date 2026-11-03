import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const url =
  process.argv.find((arg) => arg.startsWith("--url="))?.slice(6) ?? "http://localhost:1420/";
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
  // A failed workbench download must leave a usable retry control.
  const failure = await browser.newPage();
  await failure.route(/\/workbench[^/]*\.(js|tsx)(\?|$)/, (route) => route.abort());
  await failure.goto(url, { waitUntil: "domcontentloaded" });
  await failure.locator(".startup-failed").waitFor();
  await failure.unrouteAll();
  await failure.getByRole("button", { name: "Reload", exact: true }).click();
  await failure.waitForFunction(
    () => performance.getEntriesByName("startup:workbench-painted").length > 0,
  );
  assert.equal(await failure.locator(".startup-failed").count(), 0);
  console.log("Passed failed workbench import and successful reload recovery.");
} finally {
  await browser.close();
}
