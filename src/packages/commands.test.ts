import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc } from "../types/types";

vi.mock("../core/bridge", () => ({ call: vi.fn() }));
// These tests exercise command routing without starting Monaco or a real terminal.
vi.mock("../editor/documents", () => ({ normalize: (path: string) => path.toLowerCase() }));
vi.mock("../terminal/runtime", () => ({ runTerminalCommand: vi.fn() }));

import { call } from "../core/bridge";
import { useApp } from "../store/store";
import { runTerminalCommand } from "../terminal/runtime";
import { runPackageCommand } from "./commands";
import { isWorkspacePackageDocument } from "./document";

const doc: Doc = {
  id: "package",
  path: "C:/project/packages/app/package.json",
  name: "package.json",
  language: "json",
  version: 1,
  revision: "one",
  encoding: "utf8",
  eol: "LF",
  dirty: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  useApp.setState({ root: "C:/project", workspaceEpoch: 0, docs: { package: doc } });
});

describe("Package view and command routing", () => {
  it("offers management only for package manifests inside the workspace", () => {
    expect(isWorkspacePackageDocument(doc, "C:/project")).toBe(true);
    expect(
      isWorkspacePackageDocument({ ...doc, path: "C:/project/package.json" }, "C:/project"),
    ).toBe(true);
    expect(isWorkspacePackageDocument(doc, null)).toBe(false);
    for (const path of [
      "C:/project-other/package.json",
      "C:/outside/package.json",
      "C:/project/config.json",
    ]) {
      expect(isWorkspacePackageDocument({ ...doc, path }, "C:/project")).toBe(false);
    }
    expect(isWorkspacePackageDocument({ ...doc, kind: "binary" }, "C:/project")).toBe(false);
    expect(
      isWorkspacePackageDocument(
        {
          ...doc,
          gitDiff: {
            workspace: "C:/project",
            repository: "C:/project",
            path: "packages/app/package.json",
            oldPath: null,
            staged: false,
            conflicted: false,
          },
        },
        "C:/project",
      ),
    ).toBe(false);
  });

  it.each(["C:/project", "C:/project/packages/app"])(
    "runs npm in the backend-validated package directory %s",
    async (directory) => {
      const current = { ...doc, path: `${directory}/package.json` };
      useApp.setState({ docs: { package: current } });
      vi.mocked(call).mockResolvedValue({ directory, installed: {}, warnings: [] });
      await runPackageCommand("C:/project", current, ["run", "--", "build"]);
      expect(call).toHaveBeenCalledWith("package_snapshot", {
        root: "C:/project",
        manifestPath: current.path,
      });
      expect(runTerminalCommand).toHaveBeenCalledWith(directory, "npm", ["run", "--", "build"]);
    },
  );

  it.each([{ dirty: true }, { conflict: true }, { deleted: true }])(
    "blocks commands on unavailable manifests: %j",
    async (patch) => {
      useApp.setState({ docs: { package: { ...doc, ...patch } } });
      await expect(runPackageCommand("C:/project", doc, ["install"])).rejects.toThrow(
        "Save package.json",
      );
      expect(call).not.toHaveBeenCalled();
      expect(runTerminalCommand).not.toHaveBeenCalled();
    },
  );

  it("does not start a terminal when package validation fails", async () => {
    vi.mocked(call).mockRejectedValue(new Error("Package manifest is outside the workspace"));
    await expect(runPackageCommand("C:/project", doc, ["install"])).rejects.toThrow(
      "outside the workspace",
    );
    expect(runTerminalCommand).not.toHaveBeenCalled();
  });

  it.each(["workspace", "document"])(
    "rejects a stale %s after asynchronous validation",
    async (change) => {
      vi.mocked(call).mockImplementationOnce(async () => {
        if (change === "workspace") {
          useApp.setState({ workspaceEpoch: 1 });
        } else {
          useApp.setState({ docs: { package: { ...doc, dirty: true } } });
        }
        return { directory: "C:/project/packages/app", installed: {}, warnings: [] };
      });
      await expect(runPackageCommand("C:/project", doc, ["install"])).rejects.toThrow("changed");
      expect(runTerminalCommand).not.toHaveBeenCalled();
    },
  );
});
