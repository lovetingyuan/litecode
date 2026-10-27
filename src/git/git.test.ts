import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc } from "../types/types";

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
import { setApp, useApp } from "../store/store";
import { runGitOperation } from "./git";

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
      git: [],
      warnings: [],
    },
  });
  vi.mocked(ask).mockResolvedValue("Cancel");
});
describe("Git operation protections", () => {
  it("does not stage disk bytes after the user cancels the save prompt", async () => {
    expect(
      await runGitOperation("C:/repo", { kind: "stage", paths: ["file.txt"] }),
    ).toBe(false);
    expect(trustedCall).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(useApp.getState().gitBusy).toEqual({});
  });
  it("stops when a requested save fails or leaves the source dirty", async () => {
    vi.mocked(ask).mockResolvedValue("Save and Continue");
    expect(
      await runGitOperation("C:/repo", { kind: "switch", branch: "other" }),
    ).toBe(false);
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
    expect(
      await runGitOperation("C:/repo", { kind: "stage", paths: ["file.txt"] }),
    ).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    cancel();
    await first;
  });
  it("never starts an operation after its workspace has changed during confirmation", async () => {
    vi.mocked(ask).mockImplementation(async () => {
      setApp({ root: "C:/other", docs: {} });
      return "Save and Continue";
    });
    expect(
      await runGitOperation("C:/repo", { kind: "switch", branch: "other" }),
    ).toBe(false);
    expect(trustedCall).not.toHaveBeenCalled();
  });
});
