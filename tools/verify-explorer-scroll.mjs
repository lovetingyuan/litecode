import { workspaceFixtureCommands } from "./explorer-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

// Real tree, Worker, virtual layout and mouse input; only desktop IPC is mocked.
const root = "C:/scroll-fixture";
const parents = ["apps", "web-content", "superchannel", "src", "add-device-guide"];
const folder = parents.join("/");
const deep = Array.from({ length: 10 }, (_, i) => `level-${i}`).join("/");
const files = (prefix) =>
  Array.from({ length: 70 }, (_, i) => `${prefix}/file-${String(i).padStart(3, "0")}.ts`);
const leaves = [
  ...files(folder),
  ...files("apps/web-content/superchannel/src/sibling"),
  ...files(deep),
  "z-last.txt",
];
const paths = [
  ...new Set(
    leaves.flatMap((path) => [
      path,
      ...path
        .split("/")
        .slice(0, -1)
        .map((_, i, parts) => `${parts.slice(0, i + 1).join("/")}/`),
    ]),
  ),
].sort();
const output = ".verification/explorer-scroll";
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  ignoreDefaultArgs: ["--hide-scrollbars"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(15000);
page.setDefaultNavigationTimeout(60000);
const errors = [];
const checks = [];
const urls = {};
page.on("pageerror", (error) => errors.push(String(error)));
page.on("request", (request) => {
  const name = new URL(request.url()).pathname.match(
    /^\/src\/(?:editor|store)\/(documents|store)\.ts$/,
  )?.[1];
  if (name && !urls[name]) urls[name] = request.url();
});
await page.route("**/src/core/bridge.ts*", (route) =>
  route.fulfill({
    contentType: "application/javascript",
    body: `
export const desktop = false;
export const mediaSource = path => path;
export const errorMessage = e => e?.message ?? String(e);
export const channel = fn => ({ onmessage: fn });
export async function bootstrap() { return {root:${JSON.stringify(root)},documents:[],session:{sidebarWidth:400},recent:[],settings:{},keybindings:[],warnings:[],dataDir:''}; }
export async function call(command, args) {
${workspaceFixtureCommands}
 if (command === 'fixture_workspace_snapshot') return {paths:${JSON.stringify(paths)},git:[{path:${JSON.stringify(`${folder}/file-000.ts`)},status:'modified'}],branch:null,warnings:[],truncated:false};
 if (command === 'quick_file_paths') return {root:${JSON.stringify(root)},paths:${JSON.stringify(leaves)},excludes:{}};
 if (command === 'inspect_file') return {kind:'text',size:20,stamp:'fixture'};
 if (command === 'read_document') return {text:'export const value = 1;',encoding:'utf8',eol:'LF',revision:'fixture'};
 if (command === 'language_document') return;
 if (command === 'plan_file_moves') { window.scrollDrop = args; return []; }
 throw new Error('Unexpected fixture command: '+command);
}
`,
  }),
);
const tree = page.locator("file-tree-container");
const treePath = (path) => (paths.includes(path) ? path : `${path}/`);
const flow = (path) =>
  tree.locator(
    `[data-item-path="${treePath(path)}"]:not([data-file-tree-sticky-row]):not([data-item-parked="true"])`,
  );
const sticky = (path) => tree.locator(`[data-file-tree-sticky-path="${treePath(path)}"]`);
const settle = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
async function scroll(top) {
  await tree.evaluate((host, top) => {
    host.shadowRoot.querySelector("[data-file-tree-virtualized-scroll]").scrollTop = top;
  }, top);
  await settle();
  await page.waitForTimeout(180); // The tree suppresses pointer input during scrolling.
}
async function expand(parts) {
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join("/");
    await flow(path).click();
    await settle();
  }
}
async function stack() {
  return tree.evaluate((host) => {
    const shadow = host.shadowRoot;
    const viewport = shadow
      .querySelector("[data-file-tree-virtualized-scroll]")
      .getBoundingClientRect();
    return [...shadow.querySelectorAll("[data-file-tree-sticky-row]")]
      .filter((row) => getComputedStyle(row).visibility !== "hidden")
      .map((row) => ({
        path: row.dataset.itemPath.replace(/\/$/, ""),
        top: row.getBoundingClientRect().top - viewport.top,
        bottom: row.getBoundingClientRect().bottom - viewport.top,
      }));
  });
}
async function moduleCall(module, name, ...args) {
  return page.evaluate(async ({ url, name, args }) => (await import(url))[name](...args), {
    url: urls[module],
    name,
    args,
  });
}
async function screenshot(name) {
  await page.mouse.move(1100, 750);
  await page.locator(".explorer").screenshot({ path: `${output}/${name}.png` });
}
async function scrollbarStyle(locator) {
  return locator.evaluate((element) => {
    const scroller =
      element.shadowRoot?.querySelector("[data-file-tree-virtualized-scroll]") ?? element;
    const style = getComputedStyle(scroller, "::-webkit-scrollbar");
    const thumb = getComputedStyle(scroller, "::-webkit-scrollbar-thumb");
    return {
      width: style.width,
      height: style.height,
      color: thumb.backgroundColor,
      border: thumb.borderTopWidth,
      radius: thumb.borderRadius,
      minHeight: thumb.minHeight,
      clip: thumb.backgroundClip,
    };
  });
}
try {
  await mkdir(output, { recursive: true });
  await page.goto(process.env.LITECODE_TEST_URL ?? "http://localhost:1420");
  await flow("apps").waitFor();
  await expand(parents);
  await scroll(500);
  assert.deepEqual(
    (await stack()).map((r) => r.path),
    parents.map((_, i) => parents.slice(0, i + 1).join("/")),
  );
  assert.deepEqual(
    (await stack()).map((r) => r.top),
    [0, 26, 52, 78, 104],
  );
  assert.equal(await sticky(folder).getAttribute("data-item-contains-git-change"), "true");
  await screenshot("01-sticky-ancestors");
  checks.push("Five ancestors stay at the top beneath the workspace header");

  const treeStyle = await scrollbarStyle(tree);
  assert.deepEqual(treeStyle, {
    width: "12px",
    height: "12px",
    color: "rgba(121, 121, 121, 0.6)",
    border: "2px",
    radius: "7px",
    minHeight: "24px",
    clip: "padding-box",
  });
  assert.equal(
    await tree.evaluate((host) =>
      getComputedStyle(host).getPropertyValue("--trees-scrollbar-gutter-measured").trim(),
    ),
    "12px",
  );
  await page.mouse.move(1100, 750);
  const thumbBox = await tree.boundingBox();
  await page.mouse.move(thumbBox.x + thumbBox.width - 6, thumbBox.y + 210);
  const treeHover = await scrollbarStyle(tree);
  assert.equal(treeHover.color, "rgba(121, 121, 121, 0.8)");

  await flow(`${folder}/file-020.ts`).dragTo(sticky("apps/web-content/superchannel/src"));
  await page.waitForFunction(() => !!window.scrollDrop);
  assert.equal(
    await page.evaluate(() => window.scrollDrop.targetDirectory),
    `${root}/apps/web-content/superchannel/src`,
  );
  checks.push("Files can be dragged onto a sticky ancestor directory");
  await scroll(500);

  await sticky(folder).locator('[data-item-section="content"]').click();
  await settle();
  assert.equal(
    await flow(folder).getAttribute("aria-expanded"),
    "true",
    "Name click must not collapse the directory",
  );
  assert.equal(await flow(folder).getAttribute("aria-selected"), "true");
  const revealedTop = await flow(folder).evaluate(
    (row) =>
      row.getBoundingClientRect().top -
      row.getRootNode().querySelector("[data-file-tree-virtualized-scroll]").getBoundingClientRect()
        .top,
  );
  assert.equal(revealedTop, 104, "The canonical directory is revealed below its sticky parents");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await tree.locator('[data-item-focused="true"]').first().getAttribute("data-item-type"),
    "file",
  );
  checks.push("Name click reveals without collapsing; keyboard navigation continues into children");

  await scroll(500);
  await sticky(folder).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename…", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await scroll(500);
  await sticky(folder).locator('[data-item-section="icon"]').click();
  await settle();
  assert.equal(await flow(folder).getAttribute("aria-expanded"), "false");
  await flow(folder).click();
  checks.push("Sticky directory right-click menu and chevron collapse work");

  await scroll((parents.length + 70) * 26 - 104);
  const sibling = "apps/web-content/superchannel/src/sibling";
  await flow(sibling).click();
  await scroll((parents.length + 70 + 10) * 26);
  assert.equal((await stack()).at(-1).path, sibling);
  await scroll(500);
  assert.equal((await stack()).at(-1).path, folder);
  await scroll(0);
  assert.deepEqual(await stack(), []);
  checks.push(
    "Sibling transitions, reverse scrolling and returning to the top update the sticky stack",
  );

  await page.locator(".section-heading").hover();
  await page.getByRole("button", { name: "Collapse Folders", exact: true }).click();
  await scroll(0);
  await expand(deep.split("/"));
  await scroll(500);
  assert.equal((await stack()).length, 7);
  await screenshot("02-seven-row-limit");
  await page.setViewportSize({ width: 1280, height: 420 });
  await settle();
  await scroll(500);
  const viewportHeight = await tree.evaluate(
    (host) => host.shadowRoot.querySelector("[data-file-tree-virtualized-scroll]").clientHeight,
  );
  const shortStack = await stack();
  assert.equal(shortStack.length, Math.min(7, Math.floor((viewportHeight * 0.4) / 26)));
  assert.ok(shortStack.at(-1).bottom <= viewportHeight * 0.4);
  await screenshot("03-small-viewport");
  await moduleCall("documents", "openPath", `${root}/${deep}/file-030.ts`, {
    pinned: true,
    preserveFocus: true,
  });
  await flow(`${deep}/file-030.ts`).waitFor();
  await settle();
  const bounds = await flow(`${deep}/file-030.ts`).evaluate((row) => {
    const viewport = row
      .getRootNode()
      .querySelector("[data-file-tree-virtualized-scroll]")
      .getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return {
      top: rect.top - viewport.top,
      bottom: rect.bottom - viewport.top,
      height: viewport.height,
    };
  });
  assert.ok(
    bounds.top >= shortStack.at(-1).bottom && bounds.bottom <= bounds.height,
    JSON.stringify(bounds),
  );
  checks.push("Deep trees respect 7 rows / 40%; editor reveal stays below the capped stack");

  await page.setViewportSize({ width: 1280, height: 820 });
  await scroll(1e6);
  const bottom = await flow("z-last.txt").evaluate((row) => {
    const scroller = row.getRootNode().querySelector("[data-file-tree-virtualized-scroll]");
    return {
      gap: scroller.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom,
      top: scroller.scrollTop,
      max: scroller.scrollHeight - scroller.clientHeight,
    };
  });
  assert.equal(bottom.gap, 32);
  assert.equal(bottom.top, bottom.max);
  await tree.hover();
  const viewport = await tree.evaluate((host) => {
    const rect = host.shadowRoot
      .querySelector("[data-file-tree-virtualized-scroll]")
      .getBoundingClientRect();
    return { x: rect.right - 6, y: rect.bottom - 12, top: rect.top };
  });
  await page.mouse.move(viewport.x, viewport.y);
  await page.mouse.down();
  await page.mouse.move(viewport.x, viewport.top + 20, { steps: 12 });
  await page.mouse.up();
  await settle();
  assert.ok(
    (await tree.evaluate(
      (host) => host.shadowRoot.querySelector("[data-file-tree-virtualized-scroll]").scrollTop,
    )) <
      bottom.max / 2,
  );
  checks.push("Scrollbar dragging works; the final row retains 32px of scrollable bottom space");

  await moduleCall("store", "setApp", {
    sidebar: "search",
    results: Array.from({ length: 80 }, (_, i) => ({
      path: `${root}/${folder}/file-000.ts`,
      line: i + 1,
      column: 1,
      endLine: i + 1,
      endColumn: 6,
      preview: "value",
      matched: "value",
    })),
  });
  const search = page.locator(".search-results");
  await search.waitFor();
  assert.deepEqual(await scrollbarStyle(search), treeStyle);
  const searchBox = await search.boundingBox();
  await page.mouse.move(searchBox.x + searchBox.width - 6, searchBox.y + 20);
  await settle();
  // Headless Chromium exposes native thumb :hover after pointer capture.
  await page.mouse.down();
  const searchHover = await scrollbarStyle(search);
  await page.mouse.up();
  assert.equal(searchHover.color, treeHover.color);
  await search.screenshot({ path: `${output}/04-search-scrollbar.png` });
  assert.deepEqual(errors, []);
  checks.push("Search and Explorer use identical scrollbar dimensions and colors; no page errors");
  await writeFile(
    `${output}/report.json`,
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  console.error(JSON.stringify({ checks, errors }, null, 2));
  throw error;
} finally {
  await browser.close();
}
