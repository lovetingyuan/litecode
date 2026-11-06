import { expect, it } from "vitest";
import { validateBranchName } from "./branchName";

it("accepts branch names including nested paths and Unicode", () => {
  for (const name of ["main", "feature/editor", "修复/编辑器", "release/v1.0", "@"]) {
    expect(validateBranchName(name), name).toBeUndefined();
  }
});

it("rejects invalid branch names and reserved HEAD", () => {
  for (const name of [
    "",
    "HEAD",
    "-topic",
    "a b",
    "a\t b",
    "a\n",
    "a\x7f",
    "a~b",
    "a^b",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
    "a..b",
    "a@{b",
    "/a",
    "a/",
    "a//b",
    ".a",
    "a/.b",
    "a.",
    "a.lock",
    "a.lock/b",
  ]) {
    expect(validateBranchName(name), name).toBeTruthy();
  }
});

it("rejects names that Git accepts but Windows cannot store", () => {
  for (const name of [
    "sf.s./dsf/sdf-",
    "topic./fix",
    "CON",
    "feature/nul.txt",
    "aux/topic",
    "COM1",
    "lpt9.log",
    "COM¹",
    "CONIN$",
    "conout$",
    'a"b',
    "a<b",
    "a>b",
    "a|b",
  ]) {
    expect(validateBranchName(name, false), name).toBeUndefined();
    expect(validateBranchName(name, true), name).toContain("Windows");
  }
});

it("allows ordinary dots, trailing hyphens, and nonreserved names on Windows", () => {
  for (const name of ["sf.s/dsf/sdf-", "feature/v1.2", "console", "COM10", "auxiliary", "a/HEAD"]) {
    expect(validateBranchName(name, true), name).toBeUndefined();
  }
});
