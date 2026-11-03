import { describe, expect, it } from "vitest";
import {
  layoutGroups,
  restoreLayout,
  splitLayout,
  type EditorLayout,
  type EditorSplit,
} from "./editorLayout";

const leaf = (id: string): EditorLayout => ({ type: "group", id });
const row = (sizes: number[]): EditorSplit => ({
  type: "split",
  id: "row",
  axis: "horizontal",
  children: sizes.map((_, i) => leaf(String(i))),
  sizes,
});

describe("Editor layout", () => {
  it("migrates legacy sessions, repairs stale layouts and keeps every recovered group", () => {
    expect(layoutGroups(restoreLayout(undefined, ["a", "b", "c"]))).toEqual(["a", "b", "c"]);
    const bad = {
      type: "split",
      axis: "horizontal",
      children: [leaf("a"), leaf("a"), leaf("missing")],
      sizes: [NaN, -1, 2],
    };
    const repaired = restoreLayout(bad, ["a", "b"]);
    expect(layoutGroups(repaired)).toEqual(["a", "b"]);
    expect(repaired).toMatchObject({ sizes: [1, 1] });
    expect(restoreLayout({ type: "split", children: "invalid" }, ["a"])).toEqual(leaf("a"));
  });
  it("round-trips nested sizes and repairs invalid weights", () => {
    const layout = splitLayout(row([600, 400]), "1", "new", "up");
    expect(restoreLayout(JSON.parse(JSON.stringify(layout)), layoutGroups(layout))).toEqual(layout);
    expect(restoreLayout({ ...row([Infinity, 0]), id: undefined }, ["0", "1"])).toMatchObject({
      sizes: [1, 1],
    });
  });
});
