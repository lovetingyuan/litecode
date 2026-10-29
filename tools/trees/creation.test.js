import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTree } from "@pierre/trees";
import { InlineEditSession as CreationSession } from "./inlineEdit.js";

afterEach(() => vi.useRealTimers());
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("Virtual creation rows", () => {
  it("renames the original row without deleting it on cancel, and excludes file extensions", () => {
    const tree = new FileTree({ paths: ["a.test.ts", "folder/"], renaming: true });
    try {
      expect(tree.startRenaming("a.test.ts")).toBe(true);
      expect(tree.getEditingPath()).toBe("a.test.ts");
      expect(tree.getCreatingPath()).toBeNull();
      tree.cancelEditing();
      expect(tree.getItem("a.test.ts")).not.toBeNull();
      const options = {
        parentPath: "",
        mode: "rename",
        path: "a.test.ts",
        initialValue: "a.test.ts",
        kind: "newFile",
        validate: () => null,
        onCommit: async () => {},
      };
      const session = new CreationSession(
        null,
        options,
        () => {},
        () => {},
      );
      expect(session.selection).toEqual([0, 6]);
      session.dispose();
      tree.startCreating({
        parentPath: "",
        kind: "newFile",
        validate: () => null,
        onCommit: async () => {},
      });
      const draft = tree.getCreatingPath();
      tree.startRenaming("folder/");
      expect(tree.getItem(draft)).toBeNull();
      tree.cancelEditing();
      expect(tree.getItem("folder/")).not.toBeNull();
    } finally {
      tree.cleanUp();
    }
  });
  it("places new folders first, and new files after expanded directory subtrees", () => {
    const tree = new FileTree({
      paths: ["src/dir/a.txt", "src/b.txt", "src/c.txt"],
      initialExpansion: "open",
    });
    const options = { parentPath: "src", validate: () => null, onCommit: async () => {} };
    try {
      const file = tree.startCreating({ ...options, kind: "newFile" });
      const rows = tree.getVisibleRows(0, tree.getVisibleCount());
      expect(rows.map((row) => row.path)).toEqual([
        "src/",
        "src/dir/",
        "src/dir/a.txt",
        file,
        "src/b.txt",
        "src/c.txt",
      ]);
      const folder = tree.startCreating({ ...options, kind: "newFolder" });
      expect(tree.getItem(file)).toBeNull();
      expect(tree.getVisibleRows(0, tree.getVisibleCount())[1].path).toBe(folder);
      tree.getItem("src").collapse();
      expect(tree.getCreatingPath()).toBeNull();
      expect(tree.getItem(folder)).toBeNull();
    } finally {
      tree.cleanUp();
    }
  });
  it("cleans drafts on parent deletion, reset and cleanup", () => {
    const tree = new FileTree({ paths: ["dir/"], initialExpansion: "open" });
    const onCancel = vi.fn();
    const options = {
      parentPath: "dir",
      kind: "newFile",
      validate: () => null,
      onCommit: async () => {},
      onCancel,
    };
    tree.startCreating(options);
    tree.remove("dir/", { recursive: true });
    expect(tree.getCreatingPath()).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
    tree.startCreating({ ...options, parentPath: "" });
    tree.resetPaths([]);
    expect(tree.getCreatingPath()).toBeNull();
    tree.cleanUp();
  });
  it("cancels rename sessions when their source disappears or an ancestor collapses", () => {
    const onCancel = vi.fn();
    const tree = new FileTree({
      paths: ["dir/a.txt"],
      initialExpansion: "open",
      renaming: {
        onStart: () => ({ validate: () => null, onCommit: async () => {}, onCancel }),
      },
    });
    try {
      tree.startRenaming("dir/a.txt");
      tree.getItem("dir/").collapse();
      expect(tree.getEditingPath()).toBeNull();
      expect(tree.getItem("dir/a.txt")).not.toBeNull();
      tree.startRenaming("dir/a.txt");
      tree.remove("dir/a.txt");
      expect(tree.getEditingPath()).toBeNull();
      expect(onCancel).toHaveBeenCalledTimes(2);
    } finally {
      tree.cleanUp();
    }
  });
});

describe("Creation validation and submission", () => {
  it("finishes unchanged names without disk calls and restores rename sources on invalid blur", async () => {
    const validate = vi.fn(() => "Already exists");
    const onCommit = vi.fn(async () => {});
    const onFinish = vi.fn();
    const session = new CreationSession(
      null,
      {
        mode: "rename",
        path: "a.txt",
        parentPath: "",
        kind: "newFile",
        initialValue: "a.txt",
        validate,
        onCommit,
        onFinish,
      },
      () => {},
      () => {},
    );
    await session.commit();
    expect(validate).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
    const invalid = new CreationSession(
      null,
      {
        mode: "rename",
        path: "a.txt",
        parentPath: "",
        kind: "newFile",
        initialValue: "a.txt",
        validate,
        onCommit,
      },
      () => {},
      () => {},
    );
    invalid.setValue("taken.txt");
    await invalid.commit(true);
    expect(invalid.disposed).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
  });
  function fixture(options = {}) {
    let session;
    const onCommit = vi.fn(async () => {});
    const close = vi.fn();
    session = new CreationSession(
      null,
      { parentPath: "", kind: "newFile", validate: () => null, onCommit, ...options },
      () => {},
      close,
    );
    return { session, onCommit, close };
  }
  it("debounces disk checks and ignores results for old text", async () => {
    vi.useFakeTimers();
    const old = deferred();
    const validate = vi.fn((value) => (value === "old" ? old.promise : null));
    const { session } = fixture({ validate });
    session.setValue("a");
    session.setValue("old");
    await vi.advanceTimersByTimeAsync(150);
    expect(validate).toHaveBeenCalledTimes(1);
    session.setValue("new");
    await vi.advanceTimersByTimeAsync(150);
    old.resolve("Already exists");
    await Promise.resolve();
    expect(session.error).toBeNull();
    session.dispose();
  });
  it("waits for validation and sends only one concurrent commit", async () => {
    const check = deferred();
    const disk = deferred();
    const onCommit = vi.fn(() => disk.promise);
    const { session, close } = fixture({ validate: () => check.promise, onCommit });
    session.setValue("a.txt");
    const first = session.commit();
    const second = session.commit();
    expect(onCommit).not.toHaveBeenCalled();
    check.resolve(null);
    await vi.waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    disk.resolve();
    await Promise.all([first, second]);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("retains errors for Enter, cancels invalid blur, and permits retry after disk errors", async () => {
    const onCommit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Permission denied"))
      .mockResolvedValue(undefined);
    const { session, close } = fixture({ onCommit });
    session.setValue("a.txt");
    await session.commit();
    expect(session.error).toBe("Permission denied");
    expect(close).not.toHaveBeenCalled();
    await session.commit();
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    const invalid = fixture({ validate: () => "Already exists" });
    invalid.session.setValue("duplicate");
    await invalid.session.commit();
    expect(invalid.close).not.toHaveBeenCalled();
    await invalid.session.commit(true);
    expect(invalid.close).toHaveBeenCalledOnce();
  });
  it("never submits a canceled or superseded validation and rechecks unchanged text", async () => {
    const check = deferred();
    const canceled = fixture({ validate: () => check.promise });
    canceled.session.setValue("old.txt");
    const pending = canceled.session.commit();
    canceled.session.dispose();
    check.resolve(null);
    await pending;
    expect(canceled.onCommit).not.toHaveBeenCalled();

    const validate = vi.fn().mockResolvedValueOnce("Already exists").mockResolvedValue(null);
    const retry = fixture({ validate });
    retry.session.setValue("same.txt");
    await retry.session.commit();
    expect(retry.session.error).toBe("Already exists");
    await retry.session.commit();
    expect(validate).toHaveBeenCalledTimes(2);
    expect(retry.onCommit).toHaveBeenCalledOnce();
  });
});
