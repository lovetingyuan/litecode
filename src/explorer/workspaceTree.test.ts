import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTree } from "@pierre/trees";
import type { DirectorySnapshot, WorkspaceChanges } from "../types/types";
vi.mock("../core/bridge", () => ({ call: vi.fn(), errorMessage: (error: Error) => error.message }));
import { call } from "../core/bridge";
import { useApp, setApp } from "../store/store";
import {
  attachWorkspaceTree,
  handleWorkspaceChanges,
  loadedWorkspacePaths,
  refreshTree,
  workspaceDirectories,
} from "./workspaceTree";
const cleanups: (() => void)[] = [];
function fixture() {
  setApp({ root: "C:/project" });
  const content: Record<string, string[]> = {
    "": ["src/", "other/", "root.txt"],
    src: ["src/a.txt"],
    other: ["other/b.txt"],
  };
  vi.mocked(call).mockImplementation(async (command, args) => {
    if (command === "workspace_git_status") {
      return { root: "C:/project", session: 1, git: [], branch: "main", warnings: [] };
    }
    if (command !== "read_workspace_directory") {
      throw new Error(`Unexpected command ${command}`);
    }
    return {
      root: "C:/project",
      session: 1,
      directory: args?.directory,
      paths: content[String(args?.directory)] ?? [],
      warnings: [],
    };
  });
  const model = new FileTree({ paths: [], initialExpansion: 0, flattenEmptyDirectories: false });
  const detach = attachWorkspaceTree(model, () => {});
  cleanups.push(() => {
    detach();
    model.cleanUp();
  });
  const change = (changes: WorkspaceChanges["changes"], rescan = false) =>
    handleWorkspaceChanges({ root: "C:/project", session: 1, changes, rescan, gitChanged: false });
  const reads = () =>
    vi
      .mocked(call)
      .mock.calls.filter(([command]) => command === "read_workspace_directory")
      .map(([, args]) => args?.directory);
  return { model, content, change, reads };
}
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  setApp({ root: null, treeRoot: null, notice: null });
  vi.resetAllMocks();
});
describe("Workspace directory integration", () => {
  it.each([
    { path: "output.log", metadata: false },
    { path: ".gitignore", metadata: false },
    { path: ".git/HEAD", metadata: true },
    { path: "nested/.git/config", metadata: true },
  ])("classifies Git refreshes for $path", async ({ path, metadata }) => {
    setApp({ root: "C:/project" });
    const current = workspaceDirectories()!;
    current.session = 1;
    const version = useApp.getState().gitInfoVersion;
    vi.mocked(call).mockResolvedValue({
      root: "C:/project",
      session: 1,
      git: [],
      branch: "main",
      tracking: null,
      warnings: [],
    });
    await handleWorkspaceChanges({
      root: current.root,
      session: 1,
      changes: [{ path, structural: false }],
      rescan: false,
      gitChanged: true,
    });
    await vi.waitFor(() => expect(useApp.getState().gitState.branch).toBe("main"));
    expect(useApp.getState().gitInfoVersion).toBe(version + Number(metadata));
  });
  it.each([
    { changes: [], rescan: false },
    { changes: [{ path: "a.txt", structural: false }], rescan: true },
    {
      changes: [{ path: "a.txt", structural: false }],
      rescan: false,
      gitPaths: ["C:/repo/.git/HEAD"],
    },
  ])(
    "invalidates info for metadata outside the workspace or uncertain events: %j",
    async (event) => {
      setApp({ root: "C:/project" });
      workspaceDirectories()!.session = 1;
      vi.mocked(call).mockImplementation(async (command) =>
        command === "workspace_git_status"
          ? {
              root: "C:/project",
              session: 1,
              git: [],
              branch: "main",
              tracking: null,
              warnings: [],
            }
          : { root: "C:/project", session: 1, directory: "", paths: [], warnings: [] },
      );
      await handleWorkspaceChanges({ root: "C:/project", session: 1, gitChanged: true, ...event });
      await vi.waitFor(() => expect(useApp.getState().gitInfoVersion).toBe(1));
    },
  );
  it("distinguishes a workspace reopened at the same path after rapid switches", () => {
    setApp({ root: "C:/project" });
    const previous = workspaceDirectories()!;
    const epoch = useApp.getState().workspaceEpoch;
    setApp({ root: "C:/other" });
    setApp({ gitInfoVersion: 4 });
    setApp({ root: "C:/project" });
    expect(previous.disposed).toBe(true);
    expect(workspaceDirectories()).not.toBe(previous);
    expect(useApp.getState().workspaceEpoch).toBe(epoch + 2);
    expect(useApp.getState().gitInfoVersion).toBe(0);
  });
  it("loads root and expanded folders only, preserving cached repeated expansion", async () => {
    const { model, reads } = fixture();
    await vi.waitFor(() => expect(model.getItem("src/")).not.toBeNull());
    expect(reads()).toEqual([""]);
    const folder = model.getItem("src/")!;
    if (!("expand" in folder)) {
      throw new Error("Missing directory");
    }
    folder.expand();
    await vi.waitFor(() => expect(model.getItem("src/a.txt")).not.toBeNull());
    folder.collapse();
    folder.expand();
    await Promise.resolve();
    expect(reads()).toEqual(["", "src"]);
    expect(loadedWorkspacePaths()).not.toContain("other/b.txt");
  });
  it("does not read directories or invalidate file search on a content-only event", async () => {
    const { model, change, reads } = fixture();
    await vi.waitFor(() => expect(model.getItem("src/")).not.toBeNull());
    const version = useApp.getState().fileIndexVersion;
    await change([{ path: "src/a.txt", structural: false }]);
    expect(reads()).toEqual([""]);
    expect(useApp.getState().fileIndexVersion).toBe(version);
  });
  it("defers collapsed folder changes until expansion and refreshes only affected directories", async () => {
    const { model, change, reads, content } = fixture();
    await vi.waitFor(() => expect(model.getItem("src/")).not.toBeNull());
    content.src.push("src/new.txt");
    await change([{ path: "src/new.txt", structural: true }]);
    expect(reads()).toEqual([""]);
    const folder = model.getItem("src/")!;
    if ("expand" in folder) {
      folder.expand();
    }
    await vi.waitFor(() => expect(model.getItem("src/new.txt")).not.toBeNull());
    content.src = ["src/new.txt"];
    model.getItem("src/new.txt")!.select();
    await change([{ path: "src/a.txt", structural: true }]);
    expect(reads()).toEqual(["", "src", "src"]);
    expect(model.getItem("src/a.txt")).toBeNull();
    expect(model.getSelectedPaths()).toEqual(["src/new.txt"]);
  });
  it("rejects stale session events and refreshes expanded directories after event loss", async () => {
    const { model, change, reads } = fixture();
    await vi.waitFor(() => expect(model.getItem("src/")).not.toBeNull());
    expect(
      await handleWorkspaceChanges({
        root: "C:/project",
        session: 0,
        changes: [],
        rescan: true,
        gitChanged: true,
      }),
    ).toBe(false);
    await change([], true);
    expect(reads()).toEqual(["", ""]);
  });
  it("discards late directory results after switching workspaces", async () => {
    setApp({ root: "C:/old" });
    let resolve!: (value: DirectorySnapshot) => void;
    vi.mocked(call).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = refreshTree();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    const old = workspaceDirectories()!;
    setApp({ root: "C:/new" });
    resolve({ root: "C:/old", session: 1, directory: "", paths: ["stale.txt"], warnings: [] });
    await pending;
    expect(old.disposed).toBe(true);
    expect(loadedWorkspacePaths()).toEqual([]);
    expect(useApp.getState().treeRoot).toBeNull();
  });
  it("does not read without an open workspace", async () => {
    await refreshTree();
    expect(call).not.toHaveBeenCalled();
  });
});
