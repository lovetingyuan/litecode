import { describe, expect, it } from "vitest";
import { filesUnder, groupChanges, visibleRange } from "./changes";
import type { GitChange } from "../types/types";

const change = (path: string, patch: Partial<GitChange> = {}): GitChange => ({
  path,
  oldPath: null,
  indexStatus: null,
  worktreeStatus: null,
  conflicted: false,
  stamp: path,
  ...patch,
});
describe("Git changes", () => {
  it("shows index and worktree versions independently, with conflicts in their own group", () => {
    const dual = change("src/dual.ts", {
      indexStatus: "modified",
      worktreeStatus: "modified",
    });
    const conflict = change("conflict.txt", {
      indexStatus: "modified",
      worktreeStatus: "modified",
      conflicted: true,
    });
    const result = groupChanges([
      dual,
      conflict,
      change("new.txt", { worktreeStatus: "untracked" }),
      change("deleted.txt", { indexStatus: "deleted" }),
    ]);
    expect(result.staged.map((c) => c.path)).toEqual([
      "deleted.txt",
      "src/dual.ts",
    ]);
    expect(result.changes).toEqual([dual]);
    expect(result.conflicts).toEqual([conflict]);
    expect(result.untracked.map((c) => c.path)).toEqual(["new.txt"]);
  });
  it("directory actions only include actual descendants", () => {
    const changes = [
      change("src/a.txt"),
      change("src/deep/b.txt"),
      change("src-other/c.txt"),
    ];
    expect(filesUnder(changes, "src/")).toEqual(changes.slice(0, 2));
    expect(filesUnder(changes, "src/a.txt")).toEqual([changes[0]]);
  });
  it("keeps the two rename paths distinct when the worktree is renamed again", () => {
    const result = groupChanges([
      change("working.txt", {
        indexStatus: "renamed",
        worktreeStatus: "renamed",
        oldPath: "head.txt",
        indexPath: "index.txt",
        indexOldPath: "head.txt",
        worktreeOldPath: "index.txt",
      }),
    ]);
    expect(result.staged[0]).toMatchObject({
      path: "index.txt",
      oldPath: "head.txt",
    });
    expect(result.changes[0]).toMatchObject({
      path: "working.txt",
      oldPath: "index.txt",
    });
  });
  it("bounds rendered rows independently of the number of changed files", () => {
    for (const scroll of [0, 26000, 259000]) {
      const { first, end } = visibleRange(10000, scroll, 312);
      expect(end - first).toBeLessThanOrEqual(29);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(10000);
    }
  });
});
