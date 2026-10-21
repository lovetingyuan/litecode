import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTree } from "@pierre/trees";
import { createDirectorySync } from "./explorerSync";
const cleanups: (() => void)[] = [];
function fixture() {
  const model = new FileTree({ paths: [], initialExpansion: 0, flattenEmptyDirectories: false });
  const sync = createDirectorySync(model);
  cleanups.push(() => { sync.dispose(); model.cleanUp(); });
  return { model, sync };
}
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
describe("Directory reconciliation", () => {
  it("retains unrelated subtrees, hidden expansion, selection and focus", async () => {
    const { model, sync } = fixture();
    await sync.update("", ["alpha/", "beta/"]);
    await sync.update("alpha", ["alpha/deep/"]);
    await sync.update("alpha/deep", ["alpha/deep/a.txt"]);
    await sync.update("beta", ["beta/b.txt"]);
    const deep = model.getItem("alpha/deep/")!;
    if ("expand" in deep) {
      deep.expand();
    }
    const alpha = model.getItem("alpha/")!;
    if ("collapse" in alpha) {
      alpha.collapse();
    }
    const beta = model.getItem("beta/")!;
    if ("expand" in beta) {
      beta.expand();
    }
    model.getItem("beta/b.txt")!.select();
    model.focusPath("beta/b.txt");
    await sync.update("beta", ["beta/b.txt", "beta/new.txt"]);
    expect(model.getSelectedPaths()).toEqual(["beta/b.txt"]);
    expect(model.getFocusedPath()).toBe("beta/b.txt");
    if ("expand" in deep) {
      expect(deep.isExpanded()).toBe(true);
    }
    if ("expand" in alpha) {
      expect(alpha.isExpanded()).toBe(false);
    }
  });
  it("does not mutate an unchanged directory", async () => {
    const { model, sync } = fixture();
    await sync.update("", ["dir/", "a.txt"]);
    const changes = vi.fn();
    model.onMutation("*", changes);
    await sync.update("", ["a.txt", "dir/"]);
    expect(changes).not.toHaveBeenCalled();
  });
  it("retains empty directories and removes deleted subtrees once", async () => {
    const { model, sync } = fixture();
    await sync.update("", ["keep/", "delete/"]);
    await sync.update("keep", ["keep/last.txt"]);
    await sync.update("delete", ["delete/deep/"]);
    await sync.update("delete/deep", ["delete/deep/a.txt"]);
    await sync.update("keep", []);
    await sync.update("", ["keep/"]);
    expect(model.getItem("keep/")).not.toBeNull();
    expect(model.getItem("keep/last.txt")).toBeNull();
    expect(model.getItem("delete/deep/a.txt")).toBeNull();
  });
  it("handles file-directory replacements and moved cached subtrees", async () => {
    const { model, sync } = fixture();
    await sync.update("", ["item.txt", "source/"]);
    await sync.update("source", ["source/a.txt"]);
    model.move("source/", "destination/");
    await sync.update("destination", ["destination/new.txt"]);
    await sync.update("", ["item.txt/", "destination/"]);
    expect(model.getItem("destination/a.txt")).toBeNull();
    expect(model.getItem("destination/new.txt")).not.toBeNull();
    expect(model.getItem("item.txt/")?.isDirectory()).toBe(true);
  });
  it("yields between large batches and stops applying a disposed workspace", async () => {
    const { model, sync } = fixture();
    const pending = sync.update("", Array.from({ length: 2000 }, (_, index) => `${index}.txt`));
    expect(model.getItem("0.txt")).not.toBeNull();
    expect(model.getItem("1999.txt")).toBeNull();
    sync.dispose();
    await pending;
    expect(model.getItem("1999.txt")).toBeNull();
  });
});
