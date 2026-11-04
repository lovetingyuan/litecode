import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitInfo, GitRepository } from "../types/types";

const dialogResponses = vi.hoisted(() => ({ ask: vi.fn(), input: vi.fn() }));
vi.mock("../components/dialog", () => ({
  ask: dialogResponses.ask,
  input: async (...args: Parameters<typeof import("../components/dialog").input>) => {
    const value = await dialogResponses.input(...args);
    if (value) {
      await args[2]?.run(value);
    }
    return value;
  },
}));
const environment = vi.hoisted(() => ({ desktop: true }));
vi.mock("../core/bridge", () => environment);
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("./git", () => ({
  gitContext: () => ({ expectedRoot: "C:/repo", session: 1 }),
  readGitInfo: vi.fn(),
  runGitOperation: vi.fn(),
  selectedRepository: () =>
    useApp
      .getState()
      .gitState.repositories?.find((r) => r.path === useApp.getState().gitRepository),
}));

const { ask, input } = dialogResponses;
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { setApp, useApp } from "../store/store";
import { readGitInfo, runGitOperation } from "./git";
import {
  branchReference,
  branchSwitchTarget,
  copyBranchName,
  createBranch,
  switchBranch,
  type GitBranch,
} from "./branches";

const local = (name: string, extra: Partial<GitBranch> = {}): GitBranch => ({
  name,
  current: false,
  remote: false,
  upstream: null,
  worktree: false,
  ...extra,
});
const remote = local("origin/feature/demo", { remote: true });
const repository: GitRepository = {
  path: "C:/repo",
  name: "repo",
  branch: "main",
  detached: false,
  operation: null,
  changes: [],
};
const details = (branches: GitBranch[]): GitInfo => ({
  branch: "main",
  head: "oid",
  detached: false,
  upstream: "origin/main",
  ahead: 2,
  behind: 3,
  lastFetch: null,
  operation: null,
  remotes: [],
  branches,
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  environment.desktop = true;
  setApp({
    root: "C:/repo",
    gitRepository: "C:/repo",
    gitBusy: {},
    notice: null,
    gitState: {
      root: "C:/repo",
      session: 1,
      branch: "main",
      git: [],
      warnings: [],
      repositories: [repository],
    },
  });
  vi.mocked(readGitInfo).mockResolvedValue(details([local("main", { current: true }), remote]));
  vi.mocked(input).mockResolvedValue("child");
  ask.mockResolvedValue("Switch Branch");
  vi.mocked(runGitOperation).mockResolvedValue(true);
});

describe("branch targets", () => {
  it("uses fully qualified refs and preserves nested branch names", () => {
    expect(branchReference(remote)).toBe("refs/remotes/origin/feature/demo");
    expect(branchReference(local("feature/demo"))).toBe("refs/heads/feature/demo");
    expect(branchSwitchTarget(remote, [remote])).toEqual({
      kind: "create",
      name: "feature/demo",
      start: "refs/remotes/origin/feature/demo",
    });
  });
  it("matches upstream exactly, even for a differently named local branch", () => {
    expect(branchSwitchTarget(remote, [local("other", { upstream: remote.name }), remote])).toEqual(
      { kind: "switch", branch: "other" },
    );
    expect(
      branchSwitchTarget(remote, [
        local("feature/demo", { upstream: "second/feature/demo" }),
        remote,
      ]).kind,
    ).toBe("create");
  });
  it("offers a picker for multiple usable tracking branches", () => {
    const branches = [
      local("one", { upstream: remote.name }),
      local("two", { upstream: remote.name }),
    ];
    expect(branchSwitchTarget(remote, [...branches, remote])).toEqual({ kind: "choose", branches });
  });
  it("blocks current and occupied targets, while allowing creation from them", () => {
    for (const flags of [{ current: true }, { worktree: true }]) {
      const branch = local("feature/demo", { ...flags, upstream: remote.name });
      expect(branchSwitchTarget(branch, [branch]).kind).toBe("blocked");
      expect(branchSwitchTarget(remote, [branch, remote]).kind).toBe("blocked");
      expect(branchReference(branch)).toBe("refs/heads/feature/demo");
    }
  });
});

describe("branch operations", () => {
  it("confirms before switching a local branch", async () => {
    const branch = local("dev");
    vi.mocked(readGitInfo).mockResolvedValue(details([branch]));
    await switchBranch(repository.path, branch, vi.fn());
    expect(ask).toHaveBeenCalledWith("Switch branch?", "Switch to branch “dev”?", [
      "Switch Branch",
      "Cancel",
    ]);
    expect(runGitOperation).toHaveBeenCalledWith(repository.path, {
      kind: "switch",
      branch: "dev",
    });
  });
  it.each(["Cancel", null])("does not switch when confirmation returns %s", async (choice) => {
    ask.mockResolvedValue(choice);
    await switchBranch(repository.path, remote, vi.fn());
    expect(readGitInfo).not.toHaveBeenCalled();
    expect(runGitOperation).not.toHaveBeenCalled();
  });
  it("stops if the selected repository changes during confirmation", async () => {
    ask.mockImplementation(async () => {
      setApp({ gitRepository: "C:/other" });
      return "Switch Branch";
    });
    await switchBranch(repository.path, remote, vi.fn());
    expect(readGitInfo).not.toHaveBeenCalled();
    expect(runGitOperation).not.toHaveBeenCalled();
  });
  it.each([local("feature/base"), remote])("creates and switches from $name", async (branch) => {
    vi.mocked(readGitInfo).mockResolvedValue(details([branch]));
    await createBranch(repository.path, branch);
    expect(input).toHaveBeenCalledWith(
      `New branch from ${branch.name}`,
      "",
      expect.objectContaining({ label: "Creating…" }),
    );
    expect(runGitOperation).toHaveBeenCalledWith(repository.path, {
      kind: "createBranch",
      name: "child",
      start: branchReference(branch),
    });
  });
  it("retains the create-from-HEAD entry", async () => {
    await createBranch(repository.path);
    expect(runGitOperation).toHaveBeenCalledWith(repository.path, {
      kind: "createBranch",
      name: "child",
    });
  });
  it("automatically creates a remote tracking branch", async () => {
    await switchBranch(repository.path, remote, vi.fn());
    expect(input).not.toHaveBeenCalled();
    expect(runGitOperation).toHaveBeenCalledWith(repository.path, {
      kind: "createBranch",
      name: "feature/demo",
      start: branchReference(remote),
    });
  });
  it("switches an existing tracking branch without asking for a name or recreating it", async () => {
    vi.mocked(readGitInfo).mockResolvedValue(
      details([remote, local("tracking", { upstream: remote.name })]),
    );
    await switchBranch(repository.path, remote, vi.fn());
    expect(runGitOperation).toHaveBeenCalledWith(repository.path, {
      kind: "switch",
      branch: "tracking",
    });
    expect(input).not.toHaveBeenCalled();
  });
  it("prompts for a different name when the local name belongs to another branch", async () => {
    vi.mocked(readGitInfo).mockResolvedValue(details([remote, local("feature/demo")]));
    await switchBranch(repository.path, remote, vi.fn());
    expect(input).toHaveBeenCalledWith(
      expect.stringContaining("already exists"),
      "",
      expect.objectContaining({ label: "Creating…" }),
    );
    expect(runGitOperation).toHaveBeenCalledWith(repository.path, {
      kind: "createBranch",
      name: "child",
      start: branchReference(remote),
    });
  });
  it("revalidates picker targets after selection", async () => {
    const one = local("one", { upstream: remote.name });
    const two = local("two", { upstream: remote.name });
    vi.mocked(readGitInfo)
      .mockResolvedValueOnce(details([one, two, remote]))
      .mockResolvedValueOnce(details([{ ...one, worktree: true }, two, remote]));
    const choose = vi.fn().mockResolvedValue("one");
    await switchBranch(repository.path, remote, choose);
    expect(choose).toHaveBeenCalledWith([one, two]);
    expect(runGitOperation).not.toHaveBeenCalled();
  });
  it("switches the selected tracking branch", async () => {
    const branches = [
      local("one", { upstream: remote.name }),
      local("two", { upstream: remote.name }),
      remote,
    ];
    vi.mocked(readGitInfo).mockResolvedValue(details(branches));
    await switchBranch(repository.path, remote, vi.fn().mockResolvedValue("two"));
    expect(runGitOperation).toHaveBeenCalledWith(repository.path, {
      kind: "switch",
      branch: "two",
    });
  });
  it("stops if the selected repository changes while the tracking picker is open", async () => {
    vi.mocked(readGitInfo).mockResolvedValue(
      details([
        remote,
        local("one", { upstream: remote.name }),
        local("two", { upstream: remote.name }),
      ]),
    );
    await switchBranch(repository.path, remote, async () => {
      setApp({ gitRepository: "C:/other" });
      return "one";
    });
    expect(runGitOperation).not.toHaveBeenCalled();
  });
  it("does nothing when creation or picking is cancelled", async () => {
    vi.mocked(input).mockResolvedValue(null);
    await createBranch(repository.path, remote);
    vi.mocked(readGitInfo).mockResolvedValue(
      details([
        remote,
        local("one", { upstream: remote.name }),
        local("two", { upstream: remote.name }),
      ]),
    );
    await switchBranch(repository.path, remote, vi.fn().mockResolvedValue(null));
    expect(runGitOperation).not.toHaveBeenCalled();
  });
  it.each(["workspace", "repository", "session", "busy", "operation"])(
    "stops after a %s change while a prompt is open",
    async (change) => {
      vi.mocked(input).mockImplementation(async () => {
        if (change === "workspace") {
          setApp({ root: "C:/other" });
        }
        if (change === "repository") {
          setApp({ gitRepository: "C:/other" });
        }
        if (change === "session") {
          setApp({ gitState: { ...useApp.getState().gitState, session: 2 } });
        }
        if (change === "busy") {
          setApp({ gitBusy: { [repository.path]: "fetch" } });
        }
        if (change === "operation") {
          setApp({
            gitState: {
              ...useApp.getState().gitState,
              repositories: [{ ...repository, operation: "merge" }],
            },
          });
        }
        return "child";
      });
      await expect(createBranch(repository.path, remote)).rejects.toThrow("repository changed");
      expect(runGitOperation).not.toHaveBeenCalled();
    },
  );
  it("rejects a deleted source after the name prompt", async () => {
    vi.mocked(readGitInfo).mockResolvedValue(details([]));
    await expect(createBranch(repository.path, remote)).rejects.toThrow("no longer exists");
    expect(runGitOperation).not.toHaveBeenCalled();
  });
  it("copies the full remote name and reports success", async () => {
    await copyBranchName(remote);
    expect(writeText).toHaveBeenCalledWith(remote.name);
    expect(useApp.getState().notice).toContain(remote.name);
  });
  it("does not report success when the clipboard fails", async () => {
    vi.mocked(writeText).mockRejectedValue(new Error("clipboard unavailable"));
    await expect(copyBranchName(remote)).rejects.toThrow("clipboard unavailable");
    expect(useApp.getState().notice).toBeNull();
  });
  it("uses the browser clipboard outside the desktop app", async () => {
    environment.desktop = false;
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: write } });
    await copyBranchName(local("feature/demo"));
    expect(write).toHaveBeenCalledWith("feature/demo");
    expect(writeText).not.toHaveBeenCalled();
  });
});
