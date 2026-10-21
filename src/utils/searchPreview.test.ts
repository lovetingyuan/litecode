import { describe, expect, it } from "vitest";
import { searchPreview } from "./searchPreview";
import type { SearchMatch } from "../types/types";

const match = (preview: string, column: number, endColumn: number, endLine = 1): SearchMatch => ({
  path: "src/example.ts",
  documentId: null,
  version: null,
  line: 1,
  column,
  endLine,
  endColumn,
  preview,
  matched: "",
});

describe("Search result previews", () => {
  it("uses UTF-16 columns without changing source positions", () => {
    const source = match("中文🙂 function example", 6, 14);
    expect(searchPreview(source)).toEqual({
      before: "中文🙂 ",
      matched: "function",
      after: " example",
      clipped: false,
    });
    expect(source.column).toBe(6);
  });
  it("shows a distant match with bounded preceding context", () => {
    const preview = searchPreview(match("x".repeat(500) + "function after", 501, 509));
    expect(preview).toEqual({
      before: "x".repeat(24),
      matched: "function",
      after: " after",
      clipped: true,
    });
  });
  it("removes indentation and avoids splitting a surrogate pair at the crop", () => {
    expect(searchPreview(match("    function", 5, 13))).toMatchObject({
      before: "",
      matched: "function",
      clipped: false,
    });
    const text = "prefix🙂" + "x".repeat(23) + "function";
    expect(searchPreview(match(text, 32, 40)).before).toBe("🙂" + "x".repeat(23));
  });
  it("keeps separate hits on one line and clips multiline matches to the first line", () => {
    expect(searchPreview(match("function function", 10, 18)).matched).toBe("function");
    expect(searchPreview(match("before function\r\nnext", 8, 3, 2))).toMatchObject({
      before: "before ",
      matched: "function",
      after: "",
    });
    expect(searchPreview(match("abc", 2, 2)).matched).toBe("");
  });
});
