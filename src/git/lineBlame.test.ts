import { afterEach, describe, expect, it, vi } from "vitest";
import { blameAge, blameRange, blameRepository, createBlameLoader, type BlameTask } from "./lineBlame";
import type { GitFileBlame, GitRepository } from "../types/types";

const repository = (path: string): GitRepository => ({ path, name: "repo", branch: "main", detached: false, operation: null, changes: [] });
const data: GitFileBlame = { head: "head", ranges: [{ startLine: 1, lineCount: 2, commit: "first" }], commits: { first: { author: "Alice", authorTime: 100, summary: "initial" } } };
afterEach(() => vi.useRealTimers());

describe("line attribution", () => {
  it("selects the deepest containing repository with path boundaries and Windows casing", () => {
    const parent = repository("C:/repo"), nested = repository("C:/repo/nested"), other = repository("C:/repo-two");
    expect(blameRepository("c:\\REPO\\nested\\中文 file.ts", [nested, parent, other])).toEqual({ repository: nested, path: "中文 file.ts", oldPath: null });
    expect(blameRepository("C:/repo-two/file.ts", [parent])).toBeNull();
    expect(blameRepository("C:/repo/file.ts", [nested, parent])?.repository).toBe(parent);
    expect(blameRepository("C:/elsewhere/file.ts", [parent])).toBeNull();
    expect(blameRepository("/home/repo/File.ts", [repository("/home/Repo")])).toBeNull();
  });
  it("preserves rename metadata and supports namespaced and UNC paths", () => {
    const repo = repository("//server/share/repo");
    repo.changes.push({ path: "new.ts", oldPath: "old.ts", indexStatus: "renamed", worktreeStatus: null, conflicted: false, stamp: "1" });
    expect(blameRepository("\\\\?\\UNC\\server\\share\\repo\\new.ts", [repo])?.oldPath).toBe("old.ts");
    expect(blameRepository("\\\\?\\C:\\repo\\file.ts", [repository("C:/repo")])?.path).toBe("file.ts");
  });
  it("looks up committed and uncommitted intervals without attributing virtual trailing lines", () => {
    const ranges = [{ startLine: 1, lineCount: 2, commit: "a" }, { startLine: 3, lineCount: 1, commit: null }, { startLine: 4, lineCount: 3, commit: "b" }];
    expect(blameRange(ranges, 1)?.commit).toBe("a");
    expect(blameRange(ranges, 2)?.commit).toBe("a");
    expect(blameRange(ranges, 3)?.commit).toBeNull();
    expect(blameRange(ranges, 6)?.commit).toBe("b");
    expect(blameRange(ranges, 0)).toBeUndefined();
    expect(blameRange(ranges, 7)).toBeUndefined();
    expect(blameRange([], 1)).toBeUndefined();
  });
  it("formats relative times in English including future author dates", () => {
    const now = 1_800_000_000_000;
    expect(blameAge(now / 1000 - 30, now)).toBe("just now");
    expect(blameAge(now / 1000 - 90, now)).toBe("1 minute ago");
    expect(blameAge(now / 1000 - 3600 * 3, now)).toBe("3 hours ago");
    expect(blameAge(now / 1000 - 86400 * 32, now)).toBe("1 month ago");
    expect(blameAge(now / 1000 + 86400 * 2, now)).toBe("in 2 days");
  });
});

describe("blame request lifecycle", () => {
  it("debounces edits and reads only the final version", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const loader = createBlameLoader(publish);
    const first = { read: vi.fn().mockResolvedValue(data) }, last = { read: vi.fn().mockResolvedValue(data) };
    loader.update(first);
    await vi.advanceTimersByTimeAsync(150);
    loader.update(last);
    await vi.advanceTimersByTimeAsync(199);
    expect(first.read).not.toHaveBeenCalled();
    expect(last.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(last.read).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenLastCalledWith({ task: last, data });
    loader.update(null);
  });
  it("serializes requests and discards an old file, branch or workspace response", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const loader = createBlameLoader(publish);
    let finish!: (value: GitFileBlame) => void;
    const first: BlameTask = { read: vi.fn(() => new Promise<GitFileBlame | null>((resolve) => { finish = resolve; })) };
    const skipped = { read: vi.fn().mockResolvedValue(data) }, last = { read: vi.fn().mockResolvedValue(data) };
    loader.update(first);
    await vi.advanceTimersByTimeAsync(200);
    loader.update(skipped);
    await vi.advanceTimersByTimeAsync(200);
    loader.update(last);
    await vi.advanceTimersByTimeAsync(200);
    expect(last.read).not.toHaveBeenCalled();
    finish(data);
    await vi.advanceTimersByTimeAsync(0);
    expect(skipped.read).not.toHaveBeenCalled();
    expect(last.read).toHaveBeenCalledOnce();
    expect(publish.mock.calls.some(([result]) => result?.task === first)).toBe(false);
    expect(publish).toHaveBeenLastCalledWith({ task: last, data });
    loader.update(null);
  });
  it("clears on unsupported views, failure and disposal, without publishing a late success", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const loader = createBlameLoader(publish);
    loader.update({ read: () => Promise.reject(new Error("unavailable")) });
    await vi.advanceTimersByTimeAsync(200);
    expect(publish).toHaveBeenLastCalledWith(null);
    let finish!: (value: GitFileBlame) => void;
    loader.update({ read: () => new Promise((resolve) => { finish = resolve; }) });
    await vi.advanceTimersByTimeAsync(200);
    loader.update(null);
    publish.mockClear();
    finish(data);
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).not.toHaveBeenCalled();
    const pending = { read: vi.fn().mockResolvedValue(data) };
    loader.update(pending);
    loader.update(null);
    await vi.advanceTimersByTimeAsync(200);
    expect(pending.read).not.toHaveBeenCalled();
  });
});
