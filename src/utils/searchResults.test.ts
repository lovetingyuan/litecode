import { describe, expect, it } from "vitest";
import { buildSearchResults, searchResultRows, searchRowMatches } from "./searchResults";
import type { SearchMatch } from "../types/types";

const match = (path: string, line = 1): SearchMatch => ({
  path,
  documentId: null,
  version: null,
  line,
  column: 1,
  endLine: line,
  endColumn: 5,
  preview: "function example()",
  matched: "func",
});
const results = [
  match("/work/app/src/maps/Map.tsx"),
  match("/work/app/src/maps/Map.tsx", 2),
  match("/work/app/src/ui.tsx"),
  match("/work/readme.md"),
  match("/work/app/src/maps-other/Map.tsx"),
];

describe("Search result layouts", () => {
  it("preserves match indices and aggregate selection targets in the directory tree", () => {
    const { tree } = buildSearchResults(results, "/work/");
    const rows = searchResultRows(tree, new Set());
    const matches = rows.filter((row) => row.kind === "match");
    expect(matches).toHaveLength(results.length);
    for (const row of matches) {
      expect(results[row.index]).toBe(row.match);
    }
    expect(searchRowMatches(tree[0])).toHaveLength(4);
    const folder = rows.find((row) => row.kind === "folder" && row.path === "/work/app/src/maps");
    if (!folder) {
      throw new Error("Missing replacement target folder");
    }
    expect(searchRowMatches(folder)).toEqual(results.slice(0, 2));
  });

  it("handles Windows separators, root casing, root files and external files", () => {
    const { tree } = buildSearchResults(
      [match("C:\\Work\\src\\a.ts"), match("C:/Work/b.ts"), match("D:/Other/c.ts")],
      "c:\\work\\",
    );
    expect(tree.map((node) => node.name)).toEqual(["D:", "src", "b.ts"]);
    expect(
      searchResultRows(tree, new Set())
        .filter((row) => row.kind === "folder")
        .map((row) => row.path),
    ).toEqual(["D:", "D:/Other", "c:/work/src"]);
    const absolute = buildSearchResults([match("/outside/src/a.ts")], null);
    expect(
      searchResultRows(absolute.tree, new Set())
        .filter((row) => row.kind === "folder")
        .map((row) => row.path),
    ).toEqual(["/outside", "/outside/src"]);
    expect(searchResultRows(buildSearchResults([], "/work").tree, new Set())).toEqual([]);
  });
});
