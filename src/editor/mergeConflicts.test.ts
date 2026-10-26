import { describe, expect, it } from "vitest";
import { conflictReplacement, parseMergeConflicts, type ConflictChoice } from "./mergeConflicts";

const block = "<<<<<<< HEAD\n当前\n=======\n传入\n>>>>>>> feature\n";
function resolve(text: string, choice: ConflictChoice, index = 0) {
  const conflict = parseMergeConflicts(text)[index];
  return text.slice(0, conflict.range.start) + conflictReplacement(text, conflict, choice) + text.slice(conflict.range.end);
}

describe("Inline merge conflicts", () => {
  it.each(["\n", "\r\n"])("preserves surrounding text and %j line endings for every choice", (eol) => {
    const text = `before\n${block}after\n`.replace(/\n/g, eol);
    expect(resolve(text, "current")).toBe(["before", "当前", "after", ""].join(eol));
    expect(resolve(text, "incoming")).toBe(["before", "传入", "after", ""].join(eol));
    expect(resolve(text, "both")).toBe(["before", "当前", "传入", "after", ""].join(eol));
    const [conflict] = parseMergeConflicts(text);
    expect(conflict.current.name).toBe("HEAD");
    expect(conflict.incoming.name).toBe("feature");
  });

  it("resolves only the selected block and retains indentation and whitespace", () => {
    const text = block + "middle\n" + block.replace("当前", "\t  value  ");
    expect(resolve(text, "current", 1)).toBe(block + "middle\n\t  value  \n");
    expect(parseMergeConflicts(resolve(text, "incoming")).length).toBe(1);
  });

  it.each(["", "\n", "\r\n"])("accepts an empty or newline-only side %j without an extra blank line", (content) => {
    const text = `prefix\n<<<<<<< HEAD\n${content}=======\nother\n>>>>>>> incoming\nsuffix`;
    expect(resolve(text, "current")).toBe("prefix\nsuffix");
    expect(resolve(text, "both")).toBe(`prefix\n${content}other\nsuffix`);
  });

  it("handles empty incoming content, both empty sides and a footer without a final newline", () => {
    expect(resolve("<<<<<<<\nvalue\n=======\n>>>>>>>", "incoming")).toBe("");
    expect(resolve("<<<<<<<\n=======\n>>>>>>>", "both")).toBe("");
    expect(resolve(block.trimEnd(), "current")).toBe("当前\n");
  });

  it("excludes diff3 and zdiff3 ancestors from all accepted results", () => {
    const text = "common\n<<<<<<< ours\nours\n||||||| base\nold\n=======\ntheirs\n>>>>>>> theirs\nend";
    const [conflict] = parseMergeConflicts(text);
    expect(conflict.ancestors).toHaveLength(1);
    expect(conflict.ancestors[0].name).toBe("base");
    expect(resolve(text, "both")).toBe("common\nours\ntheirs\nend");
    expect(resolve(text, "current")).toBe("common\nours\nend");
    expect(resolve(text, "incoming")).toBe("common\ntheirs\nend");
  });

  it.each([
    "<<<<<<< HEAD\nincomplete", "<<<<<<< HEAD\nno separator\n>>>>>>> branch\n",
    "<<<<<<< HEAD\na\n=======\nb\n=======\nc\n>>>>>>> branch\n",
    "<<<<<<< HEAD\na\n=======\nb\n||||||| base\nc\n>>>>>>> branch\n",
    "<<<<<<< HEAD\na\n<<<<<<< nested\nb\n=======\nc\n>>>>>>> nested\n>>>>>>> branch\n",
    "  <<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n", "const text = '<<<<<<< HEAD';\n",
  ])("does not offer destructive actions for malformed or non-marker text: %j", (text) => {
    expect(parseMergeConflicts(text)).toEqual([]);
  });

  it("keeps valid blocks before a malformed block", () => {
    expect(parseMergeConflicts(block + "<<<<<<< outer\n<<<<<<< nested\n")).toHaveLength(1);
  });
});
