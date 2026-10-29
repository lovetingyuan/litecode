import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

// Real Git components, Allotment and tree virtualization; only desktop IPC is mocked.
const output = ".verification/git-panes";
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  ignoreDefaultArgs: ["--hide-scrollbars"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(15000);
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(String(error)));
await page.route("**/src/core/bridge.ts*", (route) =>
  route.fulfill({
    contentType: "application/javascript",
    body: `
    export const desktop = false;
    export const mediaSource = path => path;
    export const errorMessage = error => error?.message ?? String(error);
    export const channel = fn => ({ onmessage: fn });
    export async function bootstrap() { return {root:null,documents:[],session:{sidebar:'git',sidebarWidth:400},recent:[],settings:{},keybindings:[],warnings:[],dataDir:''}; }
    export async function call(command, args) {
      if (command === 'sync_documents') { (window.backups ??= []).push(args.session); return; }
      if (command === 'read_workspace_directory') return {root:args.expectedRoot,session:1,directory:args.directory,paths:[],warnings:[]};
      if (command === 'workspace_git_status') return window.gitPaneSnapshot;
      if (command === 'git_repository_info') return {branch:'main',head:'fixture',detached:false,upstream:null,ahead:0,behind:0,lastFetch:null,operation:null,remotes:[],branches:[]};
      if (command === 'terminal_create') return {id:crypto.randomUUID(),profile:{name:'Fixture',path:'fixture',kind:'fixture',args:[],env:{}},cwd:'C:/git-panes',integration:false,windowsBuild:0};
      if (command === 'terminal_resize' || command === 'terminal_close') return;
      throw new Error('Unexpected fixture command: ' + command);
    }
  `,
  }),
);
const settle = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const state = (patch) =>
  page.evaluate(async (patch) => (await import("/src/store/store.ts")).setApp(patch), patch);
const section = (title) => page.getByRole("region", { name: title, exact: true });
const sashes = () => page.getByRole("separator", { name: "Git change group height", exact: true });
const near = (a, b, tolerance = 3) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} should be near ${b}`);
const heights = () =>
  page
    .locator(".git-change-section")
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
async function fixture(counts = [27, 6, 9], layout = "list", repository = "C:/git-panes") {
  await page.evaluate(
    async ({ counts, layout, repository }) => {
      const { setApp } = await import("/src/store/store.ts");
      const changes = counts.flatMap((count, group) =>
        Array.from({ length: count }, (_, i) => ({
          path: `src/group-${group}-${String(i).padStart(5, "0")}.ts`,
          oldPath: null,
          indexStatus: group === 0 ? "added" : null,
          worktreeStatus: group === 1 ? "modified" : group === 2 ? "untracked" : null,
          conflicted: group === 3,
          stamp: "fixture",
        })),
      );
      window.gitPaneSnapshot = {
        root: repository,
        session: 1,
        git: [],
        branch: "main",
        warnings: [],
        repositories: [
          {
            path: repository,
            name: "git-panes",
            branch: "main",
            detached: false,
            operation: null,
            changes,
          },
        ],
      };
      setApp({ root: repository });
      setApp({ sidebar: "git", gitLayout: layout, gitState: window.gitPaneSnapshot });
    },
    { counts, layout, repository },
  );
  await page.locator(".git-change-section").first().waitFor();
  await settle();
}
async function reopen() {
  await state({ sidebar: "explorer" });
  await page.locator(".git-view").waitFor({ state: "detached" });
  await state({ sidebar: "git" });
  await section("Staged Changes").waitFor();
  await settle();
}
async function drag(index, distance) {
  const bounds = await sashes().nth(index).boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + distance, {
    steps: 12,
  });
  await page.mouse.up();
  await settle();
}
try {
  await mkdir(output, { recursive: true });
  await page.goto(process.env.LITECODE_TEST_URL ?? "http://localhost:1420", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.locator(".git-view").waitFor();
  await fixture();
  assert.equal(await sashes().count(), 2);
  const initial = await heights();
  near((initial[0] - 54) / (initial[1] - 54), 27 / 6, 0.1);
  near((initial[2] - 54) / (initial[1] - 54), 9 / 6, 0.1);
  await page.locator(".git-view").screenshot({ path: `${output}/01-default.png` });
  await page.waitForTimeout(500); // Drain existing workbench startup backups before checking Git dragging.
  await page.evaluate(() => {
    window.backups = [];
  });
  await drag(0, -90);
  const dragged = await heights();
  assert.ok(dragged[0] < initial[0] - 60 && dragged[1] > initial[1] + 60);
  near(dragged[2], initial[2]);
  await drag(1, 35);
  const manual = await heights();
  await sashes().nth(0).focus();
  await sashes().nth(0).press("ArrowDown");
  const keyboard = await heights();
  near(keyboard[0], manual[0] + 10);
  await sashes().nth(0).dblclick();
  const balanced = await heights();
  near(balanced[0], balanced[1]);
  near(balanced[2], keyboard[2]);
  await page.waitForTimeout(500);
  assert.equal(
    await page.evaluate(() => window.backups.length),
    0,
    "Git resizing must not trigger session backups",
  );
  checks.push(
    "27/6/9 defaults; both sashes drag; keyboard adjustment; adjacent pair balance; no backup writes",
  );

  const toggle = section("Staged Changes").locator(".git-section-toggle");
  await toggle.click();
  await settle();
  near((await heights())[0], 28, 0.5);
  await toggle.click();
  await settle();
  (await heights()).forEach((height, i) => near(height, balanced[i]));
  await fixture([54, 12, 18]);
  (await heights()).forEach((height, i) => near(height, balanced[i]));
  await fixture([54, 12, 18, 8]);
  assert.equal(await sashes().count(), 3);
  const withConflict = await heights();
  near(
    (withConflict[1] - 54) / (withConflict[2] - 54),
    (balanced[0] - 54) / (balanced[1] - 54),
    0.1,
  );
  await fixture([27, 6, 9]);
  (await heights()).forEach((height, i) => near(height, balanced[i]));
  checks.push(
    "Collapse restores prior sizes; refreshed counts preserve manual proportions; Merge Changes appears and disappears",
  );

  await state({ gitLayout: "tree" });
  await section("Staged Changes").locator("file-tree-container").waitFor();
  await settle();
  (await heights()).forEach((height, i) => near(height, balanced[i]));
  await section("Staged Changes")
    .locator('[data-item-path="src/"] [data-item-section="content"]')
    .click();
  const actions = section("Staged Changes").locator(".git-tree-selection-actions");
  await actions.waitFor();
  await page.setViewportSize({ width: 1280, height: 380 });
  await settle();
  assert.equal(
    await actions.evaluate(
      (element) =>
        element.getBoundingClientRect().bottom <=
        element.closest(".git-change-section").getBoundingClientRect().bottom + 1,
    ),
    true,
  );
  await page.setViewportSize({ width: 1280, height: 240 });
  await settle();
  const panel = page.locator("#git-panel-changes");
  await panel.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const bounds = await panel.boundingBox();
  const last = await section("Untracked Files").boundingBox();
  assert.ok(
    last.y + last.height <= bounds.y + bounds.height + 1,
    "Small windows keep all groups reachable",
  );
  await page.setViewportSize({ width: 1280, height: 820 });
  await fixture();
  await reopen();
  (await heights()).forEach((height, i) => near(height, initial[i]));
  await drag(0, -50);
  await fixture([27, 6, 9], "list", "C:/git-other");
  (await heights()).forEach((height, i) => near(height, initial[i]));
  checks.push(
    "Tree shares pane sizes; selection toolbar fits; small windows scroll; reopening and repository switching reset defaults",
  );

  for (const layout of ["list", "tree"]) {
    await fixture([1000, 1000, 1000], layout);
    for (const [index, title] of ["Staged Changes", "Changes", "Untracked Files"].entries()) {
      const group = section(title);
      const scroller =
        layout === "list"
          ? group.locator(".git-changes-list")
          : group.locator("[data-file-tree-virtualized-scroll]");
      await scroller.waitFor();
      await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await settle();
      await group
        .locator(
          layout === "list"
            ? `[data-git-path="src/group-${index}-00999.ts"]`
            : `[data-item-path="src/group-${index}-00999.ts"]`,
        )
        .waitFor();
    }
    const rendered = await page
      .locator(layout === "list" ? ".git-file-row" : "[data-item-path]")
      .count();
    assert.ok(rendered < 150, `${layout} rendered ${rendered} rows`);
    await page.locator(".git-view").screenshot({ path: `${output}/02-${layout}-bottom.png` });
  }
  await fixture([0, 0, 100]);
  assert.equal(await sashes().count(), 0);
  await fixture([27, 6, 9]);
  for (const title of ["Staged Changes", "Changes", "Untracked Files"])
    await section(title).locator(".git-section-toggle").click();
  await settle();
  (await heights()).forEach((height) => near(height, 28, 0.5));
  checks.push(
    "All three lists independently reach their final file in both modes; virtualization; single group; all collapsed",
  );

  await page.evaluate(async () => {
    window.__TAURI_INTERNALS__ = { transformCallback: () => 1 };
    const { addTab, addSplit } = await import("/src/terminal/state.ts");
    const top = addTab();
    addSplit(top, "down");
    const { setApp, useApp } = await import("/src/store/store.ts");
    setApp({
      view: "terminal",
      settings: { ...useApp.getState().settings, "terminal.integrated.gpuAcceleration": "off" },
    });
  });
  const terminalSash = page.getByRole("separator", { name: "Terminal pane size", exact: true });
  await terminalSash.waitFor();
  await settle();
  const terminalHeights = () =>
    page
      .locator("[data-terminal-pane]")
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  const beforeTerminal = await terminalHeights();
  const terminalBounds = await terminalSash.boundingBox();
  await page.mouse.move(
    terminalBounds.x + terminalBounds.width / 2,
    terminalBounds.y + terminalBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    terminalBounds.x + terminalBounds.width / 2,
    terminalBounds.y + terminalBounds.height / 2 + 65,
    { steps: 12 },
  );
  await page.mouse.up();
  await settle();
  assert.ok((await terminalHeights())[0] > beforeTerminal[0] + 40);
  await terminalSash.focus();
  await terminalSash.press("ArrowUp");
  near((await terminalHeights())[0], beforeTerminal[0] + 55);
  await terminalSash.dblclick();
  const balancedTerminal = await terminalHeights();
  near(balancedTerminal[0], balancedTerminal[1]);
  checks.push(
    "Existing terminal vertical panes still drag, resize by keyboard and balance on double-click",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/report.json`,
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  console.error({ errors, checks });
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
