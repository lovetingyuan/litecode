import { describe, expect, it, vi } from "vitest";
import {
  copyDroppedItems,
  externalDropDirectory,
  hasExternalFiles,
  openDroppedItems,
  type DropItem,
} from "./externalDrop";

const file = (path: string): DropItem => ({ path, directory: false });

describe("external file drops", () => {
  it("only intercepts OS file transfers, leaving text and internal tabs alone", () => {
    expect(hasExternalFiles({ types: ["Files"] })).toBe(true);
    expect(hasExternalFiles({ types: ["text/plain"] })).toBe(false);
    expect(hasExternalFiles({ types: ["Files", "application/litecode-tab"] })).toBe(false);
    expect(hasExternalFiles(null)).toBe(false);
  });

  it("resolves directory rows, file parents and root empty space", () => {
    expect(externalDropDirectory("src/nested/", true)).toBe("src/nested");
    expect(externalDropDirectory("src/a.ts", false)).toBe("src");
    expect(externalDropDirectory("README.md", false)).toBe("");
    expect(externalDropDirectory(undefined, false)).toBe("");
  });

  it("opens folders in separate windows, then every file in the original group", async () => {
    const calls: unknown[] = [];
    await openDroppedItems(
      [
        file("a.txt"),
        { path: "folder1", directory: true },
        file("b.txt"),
        { path: "folder2", directory: true },
      ],
      {
        folder: async (path, newWindow) => {
          calls.push([path, newWindow]);
        },
        file: async (path) => {
          calls.push(path);
        },
      },
      new AbortController().signal,
    );
    expect(calls).toEqual([["folder1", false], ["folder2", true], "a.txt", "b.txt"]);
  });

  it("reports a failed file but still opens later files", async () => {
    const open = vi.fn().mockRejectedValueOnce(new Error("missing")).mockResolvedValue(undefined);
    const report = await openDroppedItems(
      [file("a"), file("b")],
      { folder: vi.fn(), file: open },
      new AbortController().signal,
    );
    expect(report).toEqual([{ path: "a", message: "missing" }]);
    expect(open.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("checks collisions sequentially, skips one and cancels the remaining batch", async () => {
    const plan = vi.fn(async () => ({ destination: "target/a", existing: "stamp" }));
    const confirm = vi
      .fn()
      .mockResolvedValueOnce("Replace")
      .mockResolvedValueOnce("Skip")
      .mockResolvedValueOnce("Cancel");
    const copy = vi.fn(async () => ({ from: "a", to: "target/a" }));
    const report = await copyDroppedItems(
      ["a", "b", "c", "d"].map(file),
      { plan, confirm, copy },
      new AbortController().signal,
    );
    expect(report.copied).toHaveLength(1);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(plan.mock.calls).toHaveLength(3);
  });

  it("copies conflict-free files without asking and continues after partial failure", async () => {
    const confirm = vi.fn();
    const copy = vi
      .fn()
      .mockRejectedValueOnce({ message: "locked" })
      .mockResolvedValueOnce({ from: "b", to: "target/b" });
    const report = await copyDroppedItems(
      [file("a"), file("b")],
      {
        plan: async () => ({ destination: "target/a", existing: null }),
        confirm,
        copy,
      },
      new AbortController().signal,
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(report.failed).toEqual([{ path: "a", message: "locked" }]);
    expect(report.copied).toEqual([{ from: "b", to: "target/b" }]);
  });

  it("does not copy after workspace change while confirmation is pending", async () => {
    const abort = new AbortController();
    const copy = vi.fn();
    await copyDroppedItems(
      [file("a")],
      {
        plan: async () => ({ destination: "target/a", existing: "stamp" }),
        confirm: async () => {
          abort.abort();
          return "Replace";
        },
        copy,
      },
      abort.signal,
    );
    expect(copy).not.toHaveBeenCalled();
    const open = vi.fn();
    await openDroppedItems([file("a")], { file: open, folder: vi.fn() }, abort.signal);
    expect(open).not.toHaveBeenCalled();
  });
});
