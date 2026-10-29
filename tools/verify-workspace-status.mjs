import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

// Real status bar and Popover; only native IPC is isolated.
const output = ".verification/workspace-status";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(15000);
page.setDefaultNavigationTimeout(60000);
const errors = [];
let storeUrl;
page.on("pageerror", (error) => errors.push(String(error)));
page.on("request", (request) => {
  if (new URL(request.url()).pathname === "/src/store/store.ts") {
    storeUrl = request.url();
  }
});
await page.route("**/src/core/bridge.ts*", (route) =>
  route.fulfill({
    contentType: "application/javascript",
    body: `
export const desktop = false;
export const mediaSource = path => path;
export const errorMessage = error => error?.message ?? String(error);
export const channel = fn => ({ onmessage: fn });
window.workspaceStatusFixture = { calls: [], fail: false, branch: 'main' };
export async function bootstrap() { return {root:null,documents:[],session:{},recent:[],settings:{},keybindings:[],warnings:[],dataDir:''}; }
export async function call(command, args) {
 if (command === 'read_workspace_directory') return {root:args.expectedRoot,session:1,directory:args.directory,paths:[],warnings:[]};
 if (command === 'workspace_git_status') return {root:args.expectedRoot,session:1,git:[],branch:window.workspaceStatusFixture.branch,warnings:[]};
 if (command === 'open_directory') {
   window.workspaceStatusFixture.calls.push(args);
   if (window.workspaceStatusFixture.fail) throw new Error('Could not open project folder');
   return;
 }
 throw new Error('Unexpected fixture command: '+command);
}
`,
  }),
);
const trigger = page.locator(".workspace-status");
const popup = page.getByRole("dialog", { name: "Project folder", exact: true });
const openButton = page.getByRole("button", {
  name: "Open Project Folder in File Explorer",
  exact: true,
});
const closed = () => popup.waitFor({ state: "hidden" });
async function setRoot(root, branch = "main") {
  await page.evaluate(
    async ({ url, root, branch }) => {
      const { setApp, useApp } = await import(url);
      window.workspaceStatusFixture.branch = branch;
      setApp({ root });
      setApp({ gitState: { ...useApp.getState().gitState, root, branch } });
    },
    { url: storeUrl, root, branch },
  );
}
async function focused(locator) {
  assert.equal(await locator.evaluate((element) => element === document.activeElement), true);
}
try {
  await mkdir(output, { recursive: true });
  await page.goto(process.env.LITECODE_TEST_URL ?? "http://localhost:1420");
  await page.locator(".welcome-page").waitFor();
  assert.equal(await trigger.count(), 0, "No project button without a workspace");

  const root = "C:/workspace/项目 name";
  await setRoot(root);
  await trigger.waitFor();
  assert.equal(await trigger.innerText(), "项目 name");
  assert.equal(await trigger.getAttribute("title"), "项目 name");
  assert.equal(
    await trigger.evaluate((element) => element.previousElementSibling.className),
    "remote-indicator",
  );
  assert.equal(
    await trigger.evaluate((element) => element.nextElementSibling.title),
    "Current Git branch",
  );
  await trigger.click();
  await popup.waitFor();
  assert.equal(await popup.locator(".workspace-path").innerText(), "C:\\workspace\\项目 name");
  assert.equal(
    await popup
      .locator(".workspace-path")
      .evaluate((element) => getComputedStyle(element).userSelect),
    "text",
  );
  const popupBox = await popup.boundingBox(),
    triggerBox = await trigger.boundingBox();
  assert.ok(popupBox.y + popupBox.height <= triggerBox.y, "Popover appears above the button");
  await page.screenshot({ path: `${output}/01-project-folder.png` });
  await trigger.click();
  await closed();

  await trigger.focus();
  await page.keyboard.press("Enter");
  await popup.waitFor();
  await focused(trigger);
  await page.keyboard.press("Tab");
  await focused(openButton);
  await page.keyboard.press("Escape");
  await closed();
  await focused(trigger);
  await page.keyboard.press("Space");
  await popup.waitFor();
  await page.locator(".app-mark").click();
  await closed();

  await trigger.click();
  await openButton.click();
  await closed();
  assert.deepEqual(await page.evaluate(() => window.workspaceStatusFixture.calls), [
    { path: root },
  ]);
  await page.evaluate(() => {
    window.workspaceStatusFixture.fail = true;
  });
  await trigger.click();
  await openButton.click();
  await closed();
  await page.getByRole("status").filter({ hasText: "Could not open project folder" }).waitFor();
  await page.getByRole("button", { name: "Dismiss Notification", exact: true }).click();

  await trigger.click();
  await popup.waitFor();
  await setRoot("D:\\other\\second project\\", null);
  await closed();
  assert.equal(await trigger.innerText(), "second project");
  assert.equal(
    await page.locator('[title="Current Git branch"]').count(),
    0,
    "Non-Git projects keep the button",
  );
  await trigger.click();
  assert.equal(await popup.locator(".workspace-path").innerText(), "D:\\other\\second project\\");
  await page.keyboard.press("Escape");
  await closed();

  const longName = "很长的项目名称 with spaces ".repeat(5);
  const longRoot = "C:/" + "long parent folder/".repeat(10) + longName;
  await setRoot(longRoot);
  await page.setViewportSize({ width: 700, height: 420 });
  await trigger.waitFor();
  assert.equal(await trigger.getAttribute("title"), longName);
  assert.equal(
    await trigger
      .locator("span:not(.codicon)")
      .evaluate((element) => element.scrollWidth > element.clientWidth),
    true,
  );
  await trigger.click();
  await popup.waitFor();
  assert.equal(
    await popup.locator(".workspace-path").innerText(),
    longRoot.replaceAll("/", "\\").trimEnd(),
  );
  const box = await popup.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 700 && box.y >= 0 && box.y + box.height <= 420);
  assert.equal(
    await popup.evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
    "Long paths wrap without horizontal overflow",
  );
  const pathBox = await popup.locator(".workspace-path").boundingBox(),
    buttonBox = await openButton.boundingBox();
  assert.ok(buttonBox.x >= pathBox.x + pathBox.width, "Open button stays to the right of the path");
  await page.screenshot({ path: `${output}/02-long-path.png` });
  await setRoot(null);
  await closed();
  assert.equal(await trigger.count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: project status placement, paths, keyboard/focus, dismissal, opening/errors, workspace changes and narrow layout",
  );
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
  throw error;
} finally {
  await browser.close();
}
