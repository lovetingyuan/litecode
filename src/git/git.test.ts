import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, GitOperation } from "../types/types";

vi.mock("../core/bridge", () => ({
  call: vi.fn(),
  errorMessage: (e: Error) => e.message,
}));
vi.mock("../core/workspaceTrust", () => ({ trustedCall: vi.fn() }));
vi.mock("../components/dialog", () => ({ ask: vi.fn() }));
vi.mock("../editor/documents", () => ({
  basename: (p: string) => p.split("/").pop(),
  join: (root: string, path: string) => `${root}/${path}`,
  normalize: (p: string) => p.toLowerCase(),
  openPath: vi.fn(),
  patchDoc: vi.fn(),
  refreshDocuments: vi.fn(),
  save: vi.fn(),
  showDocument: vi.fn(),
}));
vi.mock("../editor/monaco", () => ({ languageFor: () => "plaintext" }));
vi.mock("../explorer/workspaceGit", () => ({ refreshGit: vi.fn() }));
vi.mock("../explorer/workspaceTree", () => ({
  workspaceDirectories: () => null,
}));

import { trustedCall } from "../core/workspaceTrust";
import { ask } from "../components/dialog";
import { patchDoc, save } from "../editor/documents";
import { refreshGit } from "../explorer/workspaceGit";
import { setApp, useApp } from "../store/store";
import { cancelGitOperation, runGitOperation } from "./git";
import { call } from "../core/bridge";

const source: Doc = {
  id: "source",
  path: "C:/repo/file.txt",
  name: "file.txt",
  language: "plaintext",
  encoding: "utf8",
  eol: "LF",
  dirty: true,
  version: 1,
  revision: "v1",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  setApp({
    root: "C:/repo",
    docs: { source: { ...source } },
    groups: [],
    gitBusy: {},
    notice: null,
    gitState: {
      root: "C:/repo",
      session: 1,
      branch: "main",
      repositories: [
        {
          path: "C:/repo",
          name: "repo",
          branch: "main",
          detached: false,
          operation: null,
          changes: [],
        },
      ],
      git: [],
      warnings: [],
    },
  });
  vi.mocked(ask).mockResolvedValue("Cancel");
});
describe("Git remote operation feedback", () => {
  it("cancels the current request and keeps busy until the operation settles", async () => {
    setApp({ docs: {} });
    let finish!: () => void;
    vi.mocked(trustedCall).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve("");
        }),
    );
    vi.mocked(call).mockResolvedValue(true);
    const pending = runGitOperation("C:/repo", { kind: "fetch", remote: "origin" });
    const args = vi.mocked(trustedCall).mock.calls[0][1];
    if (!args || typeof args === "function") {
      throw new Error("Expected Git request arguments");
    }
    const requestId = args.requestId;
    expect(await cancelGitOperation("C:/repo")).toBe(true);
    expect(call).toHaveBeenCalledWith("git_cancel", { requestId });
    expect(useApp.getState().gitBusy["C:/repo"]).toBe("fetch");
    finish();
    await pending;
    expect(await cancelGitOperation("C:/repo")).toBe(false);
  });
  it.each([
    { request: { kind: "fetch", remote: "origin" }, busy: "fetch" },
    { request: { kind: "pull", rebase: false }, busy: "pull" },
    { request: { kind: "pull", rebase: true }, busy: "pullRebase" },
    { request: { kind: "push" }, busy: "push" },
  ] satisfies { request: GitOperation; busy: string }[])(
    "keeps $busy busy through execution and refresh without changing the request",
    async ({ request, busy }) => {
      setApp({ docs: {}, gitBusy: { "C:/other": "push" } });
      let finish!: () => void;
      let finishRefresh!: () => void;
      vi.mocked(trustedCall).mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve("");
          }),
      );
      vi.mocked(refreshGit).mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRefresh = () => resolve();
          }),
      );
      const pending = runGitOperation("C:/repo", request);
      expect(useApp.getState().gitBusy).toEqual({
        "C:/repo": busy,
        "C:/other": "push",
      });
      expect(trustedCall).toHaveBeenCalledWith("git_operate", expect.objectContaining({ request }));
      expect(await runGitOperation("C:/repo", request)).toBe(false);
      expect(trustedCall).toHaveBeenCalledTimes(1);
      finish();
      await vi.waitFor(() => expect(refreshGit).toHaveBeenCalled());
      expect(useApp.getState().gitBusy["C:/repo"]).toBe(busy);
      finishRefresh();
      expect(await pending).toBe(true);
      expect(useApp.getState().gitBusy).toEqual({ "C:/other": "push" });
      expect(useApp.getState().notice).toBeNull();
    },
  );
  it("notifies once on failure, clears busy state and permits retry", async () => {
    setApp({ docs: {} });
    const notices: string[] = [];
    const unsubscribe = useApp.subscribe((state, previous) => {
      if (state.notice && state.notice !== previous.notice) {
        notices.push(state.notice);
      }
    });
    try {
      vi.mocked(trustedCall).mockRejectedValueOnce(new Error("Fetch failed: offline"));
      const request = { kind: "fetch", remote: "origin" } as const;
      expect(await runGitOperation("C:/repo", request)).toBe(false);
      expect(notices).toEqual(["Fetch failed: offline"]);
      expect(useApp.getState().gitBusy).toEqual({});
      vi.mocked(trustedCall).mockResolvedValueOnce("");
      expect(await runGitOperation("C:/repo", request)).toBe(true);
      expect(trustedCall).toHaveBeenCalledTimes(2);
      expect(useApp.getState().gitBusy).toEqual({});
      expect(notices).toEqual(["Fetch failed: offline"]);
    } finally {
      unsubscribe();
    }
  });
});
describe("Git operation protections", () => {
  it("requires confirmation before deleting and permits cancellation", async () => {
    setApp({ docs: {} });
    expect(await runGitOperation("C:/repo", { kind: "deleteBranch", branch: "other" })).toBe(false);
    expect(ask).toHaveBeenCalledWith("Delete branch?", expect.stringContaining("other"), [
      "Delete Branch",
      "Cancel",
    ]);
    expect(trustedCall).not.toHaveBeenCalled();
    vi.mocked(ask).mockResolvedValue("Delete Branch");
    expect(await runGitOperation("C:/repo", { kind: "deleteBranch", branch: "other" })).toBe(true);
    expect(trustedCall).toHaveBeenCalledWith(
      "git_operate",
      expect.objectContaining({
        request: { kind: "deleteBranch", branch: "other" },
      }),
    );
  });
  it.each(["repository", "session", "operation"])(
    "stops deletion if %s changes during confirmation",
    async (change) => {
      setApp({ docs: {} });
      vi.mocked(ask).mockImplementation(async () => {
        const state = useApp.getState();
        if (change === "repository") {
          setApp({
            gitRepository: "C:/other",
            gitState: {
              ...state.gitState,
              repositories: [
                ...state.gitState.repositories!,
                {
                  path: "C:/other",
                  name: "other",
                  branch: "main",
                  detached: false,
                  operation: null,
                  changes: [],
                },
              ],
            },
          });
        }
        if (change === "session") {
          setApp({ gitState: { ...state.gitState, session: 2 } });
        }
        if (change === "operation") {
          setApp({
            gitState: {
              ...state.gitState,
              repositories: [{ ...state.gitState.repositories![0], operation: "merge" }],
            },
          });
        }
        return "Delete Branch";
      });
      expect(await runGitOperation("C:/repo", { kind: "deleteBranch", branch: "other" })).toBe(
        false,
      );
      expect(trustedCall).not.toHaveBeenCalled();
    },
  );
  it("does not stage disk bytes after the user cancels the save prompt", async () => {
    expect(await runGitOperation("C:/repo", { kind: "stage", paths: ["file.txt"] })).toBe(false);
    expect(trustedCall).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(useApp.getState().gitBusy).toEqual({});
  });
  it("stops when a requested save fails or leaves the source dirty", async () => {
    vi.mocked(ask).mockResolvedValue("Save and Continue");
    expect(await runGitOperation("C:/repo", { kind: "switch", branch: "other" })).toBe(false);
    expect(save).toHaveBeenCalledWith("source");
    expect(trustedCall).not.toHaveBeenCalled();
  });
  it("does not clear newer buffer edits made while a discard is running", async () => {
    vi.mocked(ask).mockResolvedValue("Discard Changes");
    let finish!: () => void;
    vi.mocked(trustedCall).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve("");
        }),
    );
    const pending = runGitOperation("C:/repo", {
      kind: "discard",
      files: [{ path: "file.txt", stamp: "original" }],
    });
    await vi.waitFor(() => expect(trustedCall).toHaveBeenCalled());
    setApp({ docs: { source: { ...source, version: 2 } } });
    finish();
    expect(await pending).toBe(true);
    expect(patchDoc).not.toHaveBeenCalled();
    expect(useApp.getState().docs.source.dirty).toBe(true);
  });
  it("rejects duplicate operations on a repository while the first prompt is open", async () => {
    let cancel!: () => void;
    vi.mocked(ask).mockImplementation(
      () =>
        new Promise((resolve) => {
          cancel = () => resolve("Cancel");
        }),
    );
    const first = runGitOperation("C:/repo", {
      kind: "stage",
      paths: ["file.txt"],
    });
    expect(await runGitOperation("C:/repo", { kind: "stage", paths: ["file.txt"] })).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    cancel();
    await first;
  });
  it("never starts an operation after its workspace has changed during confirmation", async () => {
    vi.mocked(ask).mockImplementation(async () => {
      setApp({ root: "C:/other", docs: {} });
      return "Save and Continue";
    });
    expect(await runGitOperation("C:/repo", { kind: "switch", branch: "other" })).toBe(false);
    expect(trustedCall).not.toHaveBeenCalled();
  });
});
