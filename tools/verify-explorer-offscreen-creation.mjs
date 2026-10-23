import assert from "node:assert/strict";

// A preceding expanded subtree puts scripts just outside the viewport, within overscan.
export const offscreenCreationPaths = [
  ".github/", ".vscode/", "changelogs/",
  ...Array.from({ length: 16 }, (_, i) => `packages/package-${String(i).padStart(2, "0")}/`),
  "scripts/existing.txt",
  ...Array.from({ length: 20 }, (_, i) => `root-${String(i).padStart(2, "0")}.txt`),
];

export async function verifyOffscreenCreation(page) {
  const tree = page.locator("file-tree-container");
  const input = tree.locator("[data-file-tree-creation-input]");
  const row = path => tree.locator(`[data-item-path="${path}"]:not([data-file-tree-sticky-row]):not([data-item-parked="true"])`);
  const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const results = [];
  async function settle() {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForFunction(() => !document.querySelector("file-tree-container").shadowRoot.querySelector("[data-is-scrolling]"));
  }
  async function scroll(top) {
    await tree.evaluate((host, top) => {
      const scroller = host.shadowRoot.querySelector("[data-file-tree-virtualized-scroll]");
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event("scroll"));
    }, top);
    await settle();
  }
  async function begin(kind) {
    await page.locator(".section-heading").hover();
    await page.getByRole("button", { name: kind, exact: true }).click();
    await settle();
    assert.equal(await input.count(), 1, "Scrolling must not cancel the empty creation draft");
    const state = await input.evaluate(element => {
      const shadow = element.getRootNode();
      const viewport = shadow.querySelector("[data-file-tree-virtualized-scroll]").getBoundingClientRect();
      const sticky = [...shadow.querySelectorAll("[data-file-tree-sticky-row]")].filter(e => getComputedStyle(e).visibility !== "hidden");
      const bounds = element.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, start: Math.max(viewport.top, ...sticky.map(e => e.getBoundingClientRect().bottom)), end: viewport.bottom, focused: shadow.activeElement === element };
    });
    assert(state.focused && state.top >= state.start - 1 && state.bottom <= state.end + 1, JSON.stringify(state));
  }
  try {
    for (const height of [550, 300]) for (const target of ["scripts/", "scripts/existing.txt"]) for (const kind of ["New File", "New Folder"]) {
      await page.setViewportSize({ width: 1280, height });
      await page.locator(".section-heading").hover();
      await page.getByRole("button", { name: "Collapse Folders", exact: true }).click();
      await scroll(0);
      await row("packages/").evaluate(element => element.click());
      await row("packages/package-00/").waitFor();
      await scroll(20 * 26);
      // Avoid Playwright scrolling a virtual row again while selecting it.
      await row("scripts/").evaluate(element => element.click());
      if (target !== "scripts/") {
        await row(target).waitFor();
        await row(target).evaluate(element => element.click());
      }
      assert.equal(await row(target).getAttribute("aria-selected"), "true");
      await scroll(0);
      if (height === 550) {
        assert(await row(target).evaluate(element => element.getBoundingClientRect().top >= element.getRootNode().querySelector("[data-file-tree-virtualized-scroll]").getBoundingClientRect().bottom), "The selected row must be offscreen but still rendered");
      } else {
        assert.equal(await row(target).count(), 0, "The selected row must be outside overscan");
      }
      await begin(kind);
      const name = `offscreen-${height}-${target.endsWith("/") ? "folder" : "file"}-${kind === "New File" ? "file.txt" : "folder"}`;
      await input.fill(name);
      await input.press("Enter");
      await input.waitFor({ state: "detached" });
      await row(`scripts/${name}${kind === "New Folder" ? "/" : ""}`).waitFor();
      await row("scripts/existing.txt").evaluate(element => element.click());
      await begin(kind);
      await input.fill(`${name}-canceled`);
      await input.press("Escape");
      await input.waitFor({ state: "detached" });
      results.push({ path: `scripts/${name}`, canceledPath: `scripts/${name}-canceled`, kind });
    }
  } finally {
    await page.setViewportSize(original);
  }
  return results;
}
