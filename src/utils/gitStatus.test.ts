import { describe, expect, it } from "vitest";
import { gitConflictDecoration, isGitConflicted, isGitIgnored } from "./gitStatus";
import type { GitEntry } from "../types/types";

const entries: GitEntry[] = [
  { path: "ignored.txt", status: "ignored" },
  { path: "build/", status: "ignored" },
  { path: "build/tracked.txt", status: "modified" },
];
const ignored = (path: string | null, git = entries) =>
  isGitIgnored(path, "C:/project", "C:/project", git);

describe("Git unmerged decorations", () => {
  const conflicts: GitEntry[] = [{ path: "src/组件.ts", status: "conflicted" }];
  it("recognizes normalized paths and displays a distinct unmerged badge", () => {
    expect(
      isGitConflicted("\\\\?\\C:\\PROJECT\\src\\组件.ts", "C:/project", "C:/project", conflicts),
    ).toBe(true);
    expect(
      gitConflictDecoration("C:/project/src/组件.ts", "C:/project", "C:/project", conflicts),
    ).toMatchObject({ text: "!", title: "Git: Unmerged changes" });
    expect(isGitConflicted("C:/project/src/other.ts", "C:/project", "C:/project", conflicts)).toBe(
      false,
    );
  });
  it("rejects stale workspaces, outside paths and untitled files, and refreshes after staging", () => {
    expect(isGitConflicted(null, "C:/project", "C:/project", conflicts)).toBe(false);
    expect(isGitConflicted("C:/project2/src/组件.ts", "C:/project", "C:/project", conflicts)).toBe(
      false,
    );
    expect(isGitConflicted("C:/project/src/组件.ts", "C:/project", "C:/old", conflicts)).toBe(
      false,
    );
    expect(
      gitConflictDecoration("C:/project/src/组件.ts", "C:/project", "C:/project", []),
    ).toBeNull();
  });
});

describe("Git ignore decorations", () => {
  it("inherits ignored directories but respects explicit file statuses and directory boundaries", () => {
    expect(ignored("C:/project/ignored.txt")).toBe(true);
    expect(ignored("C:/project/build/")).toBe(true);
    expect(ignored("C:/project/build/deep/file.ts")).toBe(true);
    expect(ignored("C:/project/build/tracked.txt")).toBe(false);
    expect(ignored("C:/project/build-other/file.ts")).toBe(false);
    expect(ignored("C:/project/src/build/file.ts")).toBe(false);
    expect(ignored("C:/project/src/file.ts")).toBe(false);
  });

  it("normalizes Windows extended, UNC, drive-root and mixed-separator paths", () => {
    expect(ignored("\\\\?\\C:\\PROJECT\\BUILD\\deep\\File.ts")).toBe(true);
    expect(
      isGitIgnored(
        "\\\\server\\share\\build\\a.ts",
        "\\\\?\\UNC\\server\\share",
        "\\\\?\\UNC\\server\\share",
        entries,
      ),
    ).toBe(true);
    expect(isGitIgnored("C:\\ignored.txt", "C:\\", "C:\\", entries)).toBe(true);
    expect(isGitIgnored("C:\\project\\build\\a.ts", "C:/project/", "C:/project/", entries)).toBe(
      true,
    );
  });

  it("preserves case sensitivity on POSIX paths", () => {
    expect(isGitIgnored("/project/build/a.ts", "/project", "/project", entries)).toBe(true);
    expect(isGitIgnored("/project/BUILD/a.ts", "/project", "/project", entries)).toBe(false);
    expect(isGitIgnored("/project2/build/a.ts", "/project", "/project", entries)).toBe(false);
  });

  it("ignores untitled, outside-workspace and stale snapshot documents", () => {
    expect(ignored(null)).toBe(false);
    expect(ignored("C:/project2/ignored.txt")).toBe(false);
    expect(ignored("D:/project/ignored.txt")).toBe(false);
    expect(isGitIgnored("C:/project/build/a.ts", null, "C:/project", entries)).toBe(false);
    expect(isGitIgnored("C:/project/build/a.ts", "C:/project", "C:/old", entries)).toBe(false);
    expect(isGitIgnored("C:/project/build/a.ts", "C:/project", null, entries)).toBe(false);
  });

  it("replaces cached positive and negative results with each new snapshot", () => {
    expect(ignored("C:/project/build/a.ts")).toBe(true);
    expect(ignored("C:/project/src/a.ts")).toBe(false);
    const changed: GitEntry[] = [{ path: "src/", status: "ignored" }];
    expect(ignored("C:/project/build/a.ts", changed)).toBe(false);
    expect(ignored("C:/project/src/a.ts", changed)).toBe(true);
    expect(ignored("C:/project/ignored.txt", [])).toBe(false);
  });

  it("indexes 200,000 entries once across repeated tab and group lookups", () => {
    let reads = 0;
    const large: GitEntry[] = Array.from({ length: 200_000 }, (_, i) => ({
      get path() {
        reads++;
        return `generated-${i}/`;
      },
      status: "ignored",
    }));
    const start = performance.now();
    expect(ignored("C:/project/generated-199999/deep/file.ts", large)).toBe(true);
    const indexed = performance.now();
    const initialReads = reads;
    for (let i = 0; i < 10_000; i++) {
      if (!ignored("C:/project/generated-199999/deep/file.ts", large)) {
        throw new Error("Lost ignored status");
      }
    }
    expect(reads).toBe(initialReads);
    console.info(
      `Git decoration benchmark: index ${(indexed - start).toFixed(1)} ms; 10,000 cached queries ${(performance.now() - indexed).toFixed(1)} ms`,
    );
  });
});
