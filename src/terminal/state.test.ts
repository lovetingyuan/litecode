import { describe, expect, it } from "vitest";
import { plainTerminalText, reportedDirectory } from "./settings";

describe("Shell-reported directories", () => {
  it("accepts explicit local cwd sequences including escaped characters", () => {
    expect(reportedDirectory(9, '9;"D:\\中文 space;dir"')).toBe("D:\\中文 space;dir");
    expect(reportedDirectory(633, "P;Cwd=D:\\\\test\\x3bdir")).toBe("D:\\test;dir");
    expect(reportedDirectory(7, "file:///D:/%E4%B8%AD%E6%96%87%20dir")).toBe("D:/中文 dir");
    expect(reportedDirectory(9, "9;relative")).toBeNull();
    expect(reportedDirectory(7, "https://example.com/path")).toBeNull();
    expect(reportedDirectory(7, "file:///D:/bad%00path")).toBeNull();
    expect(plainTerminalText("bad\x1b[31m\nmessage")).toBe("bad [31m message");
  });
});
