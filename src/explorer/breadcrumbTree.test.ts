import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTree } from "@pierre/trees";
import { DirectoryCache } from "./directoryCache";
import { attachBreadcrumbTree, breadcrumbSegments } from "./breadcrumbTree";
import type { DirectorySnapshot } from "../types/types";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function fixture(target = "src/a.ts") {
  const content: Record<string, string[]> = {
    "": ["src/", "other/", "README.md"],
    src: ["src/a.ts", "src/b.ts", "src/nested/", "src/empty/"],
    "src/nested": ["src/nested/deep.ts"],
    "src/empty": [],
  };
  const read = vi.fn(async (directory: string): Promise<DirectorySnapshot> => ({
    root: "C:/project",
    session: 1,
    directory,
    paths: content[directory] ?? [],
    warnings: [],
  }));
  const cache = new DirectoryCache("C:/project", read);
  const model = new FileTree({ paths: [], initialExpansion: 0, flattenEmptyDirectories: false });
  const tree = attachBreadcrumbTree(model, cache, target, vi.fn());
  cleanups.push(() => {
    tree.dispose();
    model.cleanUp();
    cache.dispose();
  });
  return { content, read, cache, model, tree };
}

describe("Breadcrumb paths", () => {
  it("maps every segment to its own full and workspace path", () => {
    expect(
      breadcrumbSegments("\\\\?\\C:\\Project\\src\\nested\\a.ts", "a.ts", "c:/project"),
    ).toEqual([
      { label: "src", path: "c:/project/src", workspacePath: "src" },
      { label: "nested", path: "c:/project/src/nested", workspacePath: "src/nested" },
      { label: "a.ts", path: "c:/project/src/nested/a.ts", workspacePath: "src/nested/a.ts" },
    ]);
  });
  it("handles UNC workspaces, root files and outside or untitled documents", () => {
    expect(
      breadcrumbSegments("\\\\?\\UNC\\server\\share\\a.ts", "a.ts", "\\\\server\\share")[0]
        .workspacePath,
    ).toBe("a.ts");
    expect(breadcrumbSegments("C:/project/a.ts", "a.ts", "C:/project/")).toHaveLength(1);
    for (const path of ["C:/project-other/a.ts", "D:/a.ts", undefined]) {
      expect(
        breadcrumbSegments(path, "Untitled-1", "C:/project").every(
          (segment) => segment.workspacePath === undefined,
        ),
      ).toBe(true);
    }
  });
});

describe("Breadcrumb directory tree", () => {
  it("shows siblings without ancestors or unrelated folders, focusing the target", async () => {
    const { tree, model, read } = fixture();
    await tree.initialized;
    expect(model.getFocusedPath()).toBe("a.ts");
    expect(model.getSelectedPaths()).toEqual(["a.ts"]);
    expect(model.getItem("nested/")?.isDirectory()).toBe(true);
    expect(model.getItem("src/")).toBeNull();
    expect(model.getItem("other/")).toBeNull();
    expect(read.mock.calls.map(([path]) => path)).toEqual(["", "src"]);
    expect(tree.toWorkspacePath("nested/deep.ts")).toBe("src/nested/deep.ts");
  });
  it("starts directories collapsed and loads only expanded subtrees, reusing cache", async () => {
    const { tree, model, read } = fixture("src/nested/");
    await tree.initialized;
    const nested = model.getItem("nested/")!;
    if (!("expand" in nested)) {
      throw new Error("Expected directory");
    }
    expect(nested.isExpanded()).toBe(false);
    nested.expand();
    await vi.waitFor(() => expect(model.getItem("nested/deep.ts")).not.toBeNull());
    nested.collapse();
    nested.expand();
    await Promise.resolve();
    expect(read.mock.calls.map(([path]) => path)).toEqual(["", "src", "src/nested"]);
  });
  it("resolves case-insensitive Windows paths and naturally sorts siblings", async () => {
    const { tree, model, content } = fixture("SRC/A.TS");
    content.src.push("src/file10.ts", "src/file2.ts");
    await tree.initialized;
    expect(tree.toWorkspacePath("b.ts")).toBe("src/b.ts");
    expect(model.getFocusedPath()).toBe("a.ts");
    const paths = model.getVisibleRows(0, model.getVisibleCount() - 1).map((row) => row.path);
    expect(paths).toEqual(["empty/", "nested/", "a.ts", "b.ts", "file2.ts", "file10.ts"]);
  });
  it("refreshes visible stale directories and retains valid selection and expansion", async () => {
    const { tree, model, cache, content } = fixture();
    await tree.initialized;
    const folder = model.getItem("nested/")!;
    if ("expand" in folder) {
      folder.expand();
    }
    await vi.waitFor(() => expect(model.getItem("nested/deep.ts")).not.toBeNull());
    content.src = ["src/a.ts", "src/nested/", "src/new.ts"];
    content["src/nested"] = ["src/nested/renamed.ts"];
    cache.invalidate("src");
    cache.invalidate("src/nested");
    tree.refresh();
    await vi.waitFor(() => expect(model.getItem("nested/renamed.ts")).not.toBeNull());
    expect(model.getItem("b.ts")).toBeNull();
    expect(model.getItem("nested/deep.ts")).toBeNull();
    expect(model.getSelectedPaths()).toEqual(["a.ts"]);
    expect("isExpanded" in folder && folder.isExpanded()).toBe(true);
  });
  it("exposes failed and empty directories and retries a failed read", async () => {
    const { tree, model, read } = fixture();
    await tree.initialized;
    read.mockRejectedValueOnce(new Error("Access denied"));
    const nested = model.getItem("nested/")!;
    if ("expand" in nested) {
      nested.expand();
    }
    await vi.waitFor(() => expect(tree.state("nested").status).toBe("failed"));
    expect(tree.state("nested").error).toBe("Access denied");
    tree.retry("nested");
    await vi.waitFor(() => expect(model.getItem("nested/deep.ts")).not.toBeNull());
    const empty = model.getItem("empty/")!;
    if ("expand" in empty) {
      empty.expand();
    }
    await vi.waitFor(() => expect(tree.state("empty").status).toBe("loaded"));
    expect(tree.state("empty").paths).toEqual([]);
  });
  it("keeps two trees' selection and expansion independent while sharing reads", async () => {
    const { tree, model, cache, read } = fixture();
    await tree.initialized;
    const second = new FileTree({ paths: [], initialExpansion: 0, flattenEmptyDirectories: false });
    const picker = attachBreadcrumbTree(second, cache, "src/b.ts", vi.fn());
    cleanups.push(() => {
      picker.dispose();
      second.cleanUp();
    });
    await picker.initialized;
    const folder = second.getItem("nested/")!;
    if ("expand" in folder) {
      folder.expand();
    }
    await vi.waitFor(() => expect(second.getItem("nested/deep.ts")).not.toBeNull());
    const original = model.getItem("nested/")!;
    expect("isExpanded" in original && original.isExpanded()).toBe(false);
    expect(model.getSelectedPaths()).toEqual(["a.ts"]);
    expect(second.getSelectedPaths()).toEqual(["b.ts"]);
    expect(read.mock.calls.map(([path]) => path)).toEqual(["", "src", "src/nested"]);
  });
  it("ignores late results after the picker closes or the workspace is disposed", async () => {
    for (const workspaceChanged of [false, true]) {
      const { tree, cache, model, read } = fixture();
      await tree.initialized;
      let resolve!: (snapshot: DirectorySnapshot) => void;
      read.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      cache.invalidate("src");
      tree.refresh();
      await vi.waitFor(() => expect(resolve).toBeDefined());
      if (workspaceChanged) {
        cache.dispose();
      } else {
        tree.dispose();
      }
      resolve({
        root: cache.root,
        session: 1,
        directory: "src",
        paths: ["src/late.ts"],
        warnings: [],
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(model.getItem("late.ts")).toBeNull();
    }
  });
});
