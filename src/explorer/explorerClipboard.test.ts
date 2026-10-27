import { describe, expect, it, vi } from "vitest";
import { createExplorerClipboard, pasteDirectory, type FileClipboard } from "./explorerClipboard";
import type { FileMove } from "./explorerMove";

function fixture() {
  let snapshot: FileClipboard = { sequence: 1, paths: ["C:/external/a.txt"] };
  const services = {
    read: vi.fn(async () => snapshot),
    copyExternal: vi.fn(async () => ({
      copied: [{ from: "C:/external/a.txt", to: "C:/project/a.txt" }],
      failed: [],
    })),
    pasteInternal: vi.fn(async (moves: FileMove[], _cut: boolean, _signal: AbortSignal) => ({ copied: moves, failed: [] as { path: string; message: string }[] })),
  };
  return {
    clipboard: createExplorerClipboard(services),
    services,
    signal: new AbortController().signal,
    change: (value: FileClipboard) => {
      snapshot = value;
    },
  };
}

describe("Explorer file clipboard", () => {
  it("copies native files immediately and sends no renderer-supplied sources", async () => {
    const { clipboard, services, signal } = fixture();
    await clipboard.paste("C:/project", "C:/project/target", signal);
    expect(services.copyExternal).toHaveBeenCalledWith(1, "C:/project", "C:/project/target");
    expect(services.pasteInternal).not.toHaveBeenCalled();
  });
  it("does not copy when the workspace request is aborted while reading the clipboard", async () => {
    const { clipboard, services } = fixture();
    const abort = new AbortController();
    services.read.mockImplementation(async () => {
      abort.abort();
      return { sequence: 1, paths: ["C:/external/a.txt"] };
    });
    expect(await clipboard.paste("C:/project", "C:/project", abort.signal)).toBeNull();
    expect(services.copyExternal).not.toHaveBeenCalled();
    expect(services.pasteInternal).not.toHaveBeenCalled();
  });
  it("ignores text, images, and empty clipboards without showing confirmation", async () => {
    const { clipboard, services, signal, change } = fixture();
    change({ sequence: 2, paths: [] });
    expect(await clipboard.paste("C:/project", "C:/project", signal)).toBeNull();
    expect(services.copyExternal).not.toHaveBeenCalled();
    expect(services.pasteInternal).not.toHaveBeenCalled();
  });
  it("uses internal copy only until the native clipboard changes", async () => {
    const { clipboard, services, signal, change } = fixture();
    await clipboard.remember(["C:/project/original.txt"], false);
    await clipboard.paste("C:/project", "C:/project/target", signal);
    expect(services.pasteInternal).toHaveBeenCalledWith(
      [{ from: "C:/project/original.txt", to: "C:/project/target/original.txt" }],
      false,
      signal,
    );
    change({ sequence: 2, paths: ["C:/external/new.txt"] });
    await clipboard.paste("C:/project", "C:/project/target", signal);
    expect(services.copyExternal).toHaveBeenLastCalledWith(2, "C:/project", "C:/project/target");
    change({ sequence: 3, paths: [] });
    expect(await clipboard.paste("C:/project", "C:/project/target", signal)).toBeNull();
    expect(services.pasteInternal).toHaveBeenCalledTimes(1);
  });
  it("rejects internal clipboard changes before disk operations", async () => {
    const { clipboard, services, signal } = fixture();
    await clipboard.remember(["C:/project/original.txt"], false);
    services.read.mockResolvedValueOnce({ sequence: 1, paths: [] })
      .mockResolvedValueOnce({ sequence: 2, paths: [] });
    await expect(clipboard.paste("C:/project", "C:/project", signal)).rejects.toThrow(
      "clipboard changed",
    );
    expect(services.pasteInternal).not.toHaveBeenCalled();
  });
  it("deduplicates selected directories and preserves failed cut items for retry", async () => {
    const { clipboard, services, signal } = fixture();
    await clipboard.remember(
      ["C:/project/folder/", "C:/project/folder/a.txt", "C:/project/b.txt", "C:/project/b.txt"],
      true,
    );
    services.pasteInternal.mockResolvedValueOnce({
      copied: [{ from: "C:/project/b.txt", to: "C:/project/target/b.txt" }],
      failed: [{ path: "C:/project/folder/", message: "busy" }],
    });
    const report = await clipboard.paste("C:/project", "C:/project/target", signal);
    expect(report?.copied).toEqual([{ from: "C:/project/b.txt", to: "C:/project/target/b.txt" }]);
    expect(report?.failed).toHaveLength(1);
    expect(services.pasteInternal).toHaveBeenCalledExactlyOnceWith([
      { from: "C:/project/folder/", to: "C:/project/target/folder" },
      { from: "C:/project/b.txt", to: "C:/project/target/b.txt" },
    ], true, signal);
    await clipboard.paste("C:/project", "C:/project/target", signal);
    expect(services.pasteInternal).toHaveBeenCalledTimes(2);
    expect(services.pasteInternal).toHaveBeenLastCalledWith(
      [{ from: "C:/project/folder/", to: "C:/project/target/folder" }],
      true,
      signal,
    );
  });
  it("keeps application copy working on platforms without native file clipboard support", async () => {
    const { clipboard, services, signal, change } = fixture();
    change({ sequence: null, paths: [] });
    await clipboard.remember(["C:/project/a.txt"], false);
    await clipboard.paste("C:/project", "C:/project/target", signal);
    expect(services.pasteInternal).toHaveBeenCalledOnce();
    expect(services.copyExternal).not.toHaveBeenCalled();
  });
  it("waits for a pending Ctrl+C before deciding which files to paste", async () => {
    const { clipboard, services, signal } = fixture();
    let finish!: (snapshot: FileClipboard) => void;
    services.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const remember = clipboard.remember(["C:/project/new.txt"], false);
    const paste = clipboard.paste("C:/project", "C:/project/target", signal);
    finish({ sequence: 1, paths: ["C:/external/a.txt"] });
    await remember;
    await paste;
    expect(services.pasteInternal).toHaveBeenCalledWith(
      [{ from: "C:/project/new.txt", to: "C:/project/target/new.txt" }],
      false,
      signal,
    );
    expect(services.copyExternal).not.toHaveBeenCalled();
  });
  it("does not fall back to old sources when remembering a new copy fails", async () => {
    const { clipboard, services, signal } = fixture();
    await clipboard.remember(["C:/project/old.txt"], false);
    services.read.mockRejectedValueOnce(new Error("Clipboard busy"));
    await expect(clipboard.remember(["C:/project/new.txt"], false)).rejects.toThrow(
      "Clipboard busy",
    );
    await clipboard.paste("C:/project", "C:/project", signal);
    expect(services.pasteInternal).not.toHaveBeenCalled();
    expect(services.copyExternal).toHaveBeenCalledWith(1, "C:/project", "C:/project");
  });
  it("resolves folder, file, root, and empty-tree paste targets", () => {
    expect(pasteDirectory("folder/", true)).toBe("folder");
    expect(pasteDirectory("folder/file.txt", false)).toBe("folder");
    expect(pasteDirectory("file.txt", false)).toBe("");
    expect(pasteDirectory("", false)).toBe("");
  });
});
