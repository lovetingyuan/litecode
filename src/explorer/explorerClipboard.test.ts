import { describe, expect, it, vi } from "vitest";
import { createExplorerClipboard, pasteDirectory, type FileClipboard } from "./explorerClipboard";

function fixture() {
  let snapshot: FileClipboard = { sequence: 1, paths: ["C:/external/a.txt"] };
  const services = {
    read: vi.fn(async () => snapshot),
    confirm: vi.fn(async () => true),
    copyExternal: vi.fn(async () => ({
      copied: [{ from: "C:/external/a.txt", to: "C:/project/a.txt" }],
      failed: [],
    })),
    pasteInternal: vi.fn(async (_source: string, _destination: string, _cut: boolean) => {}),
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
  it("confirms native files before copying and sends no renderer-supplied sources", async () => {
    const { clipboard, services, signal } = fixture();
    await clipboard.paste("C:/project", "C:/project/target", signal);
    expect(services.confirm).toHaveBeenCalledWith(
      ["C:/external/a.txt"],
      "C:/project/target",
      signal,
    );
    expect(services.copyExternal).toHaveBeenCalledWith(1, "C:/project", "C:/project/target");
    expect(services.confirm.mock.invocationCallOrder[0]).toBeLessThan(
      services.copyExternal.mock.invocationCallOrder[0],
    );
    expect(services.pasteInternal).not.toHaveBeenCalled();
  });
  it("does not copy when confirmation is cancelled or the workspace request is aborted", async () => {
    const { clipboard, services, signal } = fixture();
    services.confirm.mockResolvedValue(false);
    expect(await clipboard.paste("C:/project", "C:/project", signal)).toBeNull();
    services.confirm.mockResolvedValue(true);
    const abort = new AbortController();
    services.confirm.mockImplementation(async () => {
      abort.abort();
      return true;
    });
    expect(await clipboard.paste("C:/project", "C:/project", abort.signal)).toBeNull();
    expect(services.copyExternal).not.toHaveBeenCalled();
    expect(services.pasteInternal).not.toHaveBeenCalled();
  });
  it("ignores text, images, and empty clipboards without showing confirmation", async () => {
    const { clipboard, services, signal, change } = fixture();
    change({ sequence: 2, paths: [] });
    expect(await clipboard.paste("C:/project", "C:/project", signal)).toBeNull();
    expect(services.confirm).not.toHaveBeenCalled();
  });
  it("uses internal copy only until the native clipboard changes", async () => {
    const { clipboard, services, signal, change } = fixture();
    await clipboard.remember(["C:/project/original.txt"], false);
    expect(services.confirm).not.toHaveBeenCalled();
    await clipboard.paste("C:/project", "C:/project/target", signal);
    expect(services.pasteInternal).toHaveBeenCalledWith(
      "C:/project/original.txt",
      "C:/project/target/original.txt",
      false,
    );
    change({ sequence: 2, paths: ["C:/external/new.txt"] });
    await clipboard.paste("C:/project", "C:/project/target", signal);
    expect(services.copyExternal).toHaveBeenLastCalledWith(2, "C:/project", "C:/project/target");
    change({ sequence: 3, paths: [] });
    expect(await clipboard.paste("C:/project", "C:/project/target", signal)).toBeNull();
    expect(services.pasteInternal).toHaveBeenCalledTimes(1);
  });
  it("rejects internal clipboard changes while copy confirmation is open", async () => {
    const { clipboard, services, signal, change } = fixture();
    await clipboard.remember(["C:/project/original.txt"], false);
    services.confirm.mockImplementation(async () => {
      change({ sequence: 2, paths: [] });
      return true;
    });
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
    services.pasteInternal.mockRejectedValueOnce(new Error("busy"));
    const report = await clipboard.paste("C:/project", "C:/project/target", signal);
    expect(report?.copied).toEqual([{ from: "C:/project/b.txt", to: "C:/project/target/b.txt" }]);
    expect(report?.failed).toHaveLength(1);
    expect(services.pasteInternal).toHaveBeenCalledTimes(2);
    expect(services.confirm).not.toHaveBeenCalled();
    await clipboard.paste("C:/project", "C:/project/target", signal);
    expect(services.pasteInternal).toHaveBeenCalledTimes(3);
    expect(services.pasteInternal).toHaveBeenLastCalledWith(
      "C:/project/folder/",
      "C:/project/target/folder",
      true,
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
    expect(services.confirm).not.toHaveBeenCalled();
    finish({ sequence: 1, paths: ["C:/external/a.txt"] });
    await remember;
    await paste;
    expect(services.pasteInternal).toHaveBeenCalledWith(
      "C:/project/new.txt",
      "C:/project/target/new.txt",
      false,
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
