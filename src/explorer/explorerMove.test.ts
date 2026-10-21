import { describe, expect, it } from "vitest";
import { treeMovePlan } from "./explorerMove";

describe("Explorer drag move plan", () => {
  it("moves files and directories, excluding duplicate and selected child paths", () => {
    expect(treeMovePlan(["src/", "src/a.txt", "b.txt", "b.txt"], "target/")).toEqual([
      { from: "src/", to: "target/src/" },
      { from: "b.txt", to: "target/b.txt" },
    ]);
  });
  it("supports the root and excludes only no-op members of mixed selections", () => {
    expect(treeMovePlan(["a.txt", "src/b.txt"], null)).toEqual([
      { from: "src/b.txt", to: "b.txt" },
    ]);
    expect(treeMovePlan(["src/", "a.txt"], null)).toEqual([]);
    expect(treeMovePlan(["src/a.txt", "src/deep/"], "src")).toEqual([]);
  });
  it("rejects self and descendant targets without confusing similarly named siblings", () => {
    expect(treeMovePlan(["src/"], "src/")).toBeNull();
    expect(treeMovePlan(["src/", "b.txt"], "src/deep/")).toBeNull();
    expect(treeMovePlan(["src/"], "src-other/")).toEqual([{ from: "src/", to: "src-other/src/" }]);
  });
});
