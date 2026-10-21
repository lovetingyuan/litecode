import { describe, expect, it, vi } from "vitest";
import { DirectoryCache } from "./directoryCache";
import type { DirectorySnapshot } from "../types/types";
const snapshot = (paths: string[], session = 1): DirectorySnapshot => ({ root: "C:/project", session, directory: "", paths, warnings: [] });
function deferred() {
  let resolve!: (value: DirectorySnapshot) => void;
  const promise = new Promise<DirectorySnapshot>((done) => { resolve = done; });
  return { promise, resolve };
}
describe("Lazy workspace directories", () => {
  it("remaps moved directories without retaining them in their old parent", async () => {
    const read = vi.fn().mockImplementation(async (directory) => snapshot(directory === "" ? ["src/", "dst/"] : directory === "src" ? ["src/moved/"] : ["src/moved/a.txt"]));
    const cache = new DirectoryCache("C:/project", read);
    await cache.load("");
    await cache.load("src");
    await cache.load("src/moved");
    cache.entry("dst").status = "loaded";
    cache.relocate("src/moved/", "dst/moved/");
    expect(cache.entry("src").paths).toEqual([]);
    expect(cache.entry("dst").paths).toEqual(["dst/moved/"]);
    expect(cache.entry("dst/moved").paths).toEqual(["dst/moved/a.txt"]);
    expect(cache.directories.has("src/moved")).toBe(false);
  });
  it("reads only requested directories, coalesces reads and reuses cached empty directories", async () => {
    const read = vi.fn().mockResolvedValue(snapshot(["empty/", "src/"]));
    const cache = new DirectoryCache("C:/project", read);
    const first = cache.load("");
    expect(cache.load("")).toBe(first);
    await first;
    await cache.load("");
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue(snapshot([]));
    await cache.load("empty");
    await cache.load("empty");
    expect(read.mock.calls.map(([path]) => path)).toEqual(["", "empty"]);
  });
  it("re-reads a directory when invalidated while reading", async () => {
    const first = deferred();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(snapshot(["new.txt"]));
    const cache = new DirectoryCache("C:/project", read);
    const pending = cache.load("");
    await Promise.resolve();
    cache.invalidate("");
    first.resolve(snapshot(["old.txt"]));
    await pending;
    expect(read).toHaveBeenCalledTimes(2);
    expect(cache.entry("").paths).toEqual(["new.txt"]);
  });
  it("loads only ancestors for reveal, preserving canonical spelling", async () => {
    const read = vi.fn(async (directory) => snapshot(directory === "" ? ["Src/", "other/"] : ["Src/Mixed.TXT"]));
    const cache = new DirectoryCache("C:/project", read);
    expect(await cache.ensurePath("src/mixed.txt")).toBe("Src/Mixed.TXT");
    expect(read.mock.calls.map(([path]) => path)).toEqual(["", "Src"]);
  });
  it("does not apply a late reply from a disposed session", async () => {
    const pending = deferred();
    const cache = new DirectoryCache("C:/project", () => pending.promise);
    const listener = vi.fn();
    cache.subscribe(listener);
    const load = cache.load("");
    await Promise.resolve();
    cache.dispose();
    pending.resolve(snapshot(["old.txt"]));
    await load;
    expect(cache.entry("").paths).toEqual([]);
  });
  it("preserves cached children after failure and retries explicitly", async () => {
    const read = vi.fn().mockResolvedValueOnce(snapshot(["keep.txt"])).mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce(snapshot([]));
    const cache = new DirectoryCache("C:/project", read);
    await cache.load("");
    await cache.load("", true);
    expect(cache.entry("").status).toBe("failed");
    expect(cache.entry("").paths).toEqual(["keep.txt"]);
    await cache.load("", true);
    expect(cache.entry("").status).toBe("loaded");
  });
});
