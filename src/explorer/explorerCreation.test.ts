import { describe, expect, it } from "vitest";
import { creationParent, validateCreationName, validateRenameName } from "./explorerCreation";

describe("Explorer creation paths", () => {
  it("resolves folders, files, root and nested siblings", () => {
    expect(creationParent("src/ui/", true)).toBe("src/ui");
    expect(creationParent("src/ui/a.ts", false)).toBe("src/ui");
    expect(creationParent("root.txt", false)).toBe("");
    expect(creationParent("", false)).toBe("");
  });
  it("accepts relative paths and checks every Windows segment", () => {
    for (const name of ["src/ui/Button.tsx", "src\\ui\\", ".env", "中文🙂.txt", "COM10"]) {
      expect(validateCreationName(name, true)).toBeNull();
    }
    for (const name of [
      "",
      " ",
      "../x",
      "a/./b",
      "a/../b",
      "C:a",
      "/root",
      "\\root",
      "a?b",
      "src/NUL.txt",
      "COM¹",
      "a/LPT9.log",
      "tail.",
      "tail ",
      "a\0b",
    ]) {
      expect(validateCreationName(name, true), name).not.toBeNull();
    }
    expect(validateCreationName("x".repeat(256), true)).not.toBeNull();
    expect(validateCreationName("CON.txt", false)).toBeNull();
  });
  it("keeps the source type when renaming nested paths", () => {
    expect(validateRenameName("nested/file.txt", true, false)).toBeNull();
    expect(validateRenameName("nested/folder/", true, true)).toBeNull();
    expect(validateRenameName("nested/folder\\", true, true)).toBeNull();
    for (const name of ["nested/file/", "nested/file\\", "../file", "nested/CON.txt"]) {
      expect(validateRenameName(name, true, false), name).not.toBeNull();
    }
  });
});
