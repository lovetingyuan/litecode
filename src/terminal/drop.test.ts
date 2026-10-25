import { expect, it } from "vitest";
import { quoteDroppedPaths } from "./drop";

it("quotes PowerShell paths literally, including spaces, apostrophes and expressions", () => {
  expect(quoteDroppedPaths(["C:/中文 folder/O'Brien;$(echo x)", "C:/other"], "powershell"))
    .toBe("'C:/中文 folder/O''Brien;$(echo x)' 'C:/other'");
});

it("uses Windows separators and double quotes for cmd", () => {
  expect(quoteDroppedPaths(["C:/中文 folder/a&b", "C:/other"], "cmd"))
    .toBe('"C:\\中文 folder\\a&b" "C:\\other"');
});

it("escapes Bash apostrophes and backslashes without expanding expressions", () => {
  expect(quoteDroppedPaths(["C:\\中文 folder\\O'Brien;$HOME"], "bash"))
    .toBe("'C:/中文 folder/O'\\''Brien;$HOME'");
});
