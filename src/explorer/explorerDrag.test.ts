import { describe, expect, it } from "vitest";
import { explorerDragFiles } from "./explorerDrag";

const root = "C:/workspace";
const paths = ["first.txt", "目录/", "目录/文件 name.txt", "last.txt"];
const payload = (selected: unknown[], source = root) =>
  JSON.stringify({ root: source, paths: selected });

describe("Explorer files dropped into an editor", () => {
  it("preserves selection order, skips directories and deduplicates files", () => {
    expect(
      explorerDragFiles(
        payload(["last.txt", "目录/", "目录/文件 name.txt", "last.txt", "first.txt"]),
        root,
        paths,
      ),
    ).toEqual(["last.txt", "目录/文件 name.txt", "first.txt"]);
  });

  it("rejects drops from another workspace or without an active workspace", () => {
    expect(explorerDragFiles(payload(["first.txt"], "C:/old"), root, paths)).toEqual([]);
    expect(explorerDragFiles(payload(["first.txt"]), null, paths)).toEqual([]);
  });

  it("only accepts files present in the current tree", () => {
    expect(
      explorerDragFiles(
        payload(["../outside.txt", "C:/outside.txt", "removed.txt", null, 3, "first.txt"]),
        root,
        paths,
      ),
    ).toEqual(["first.txt"]);
  });

  it.each(["", "invalid", "null", "[]", "{}", JSON.stringify({ root, paths: "first.txt" })])(
    "ignores malformed payload %s",
    (raw) => {
      expect(explorerDragFiles(raw, root, paths)).toEqual([]);
    },
  );
});
