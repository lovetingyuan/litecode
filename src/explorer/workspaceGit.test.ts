import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../core/bridge", () => ({ call: vi.fn(), errorMessage: (error: Error) => error.message }));
import { call } from "../core/bridge";
import { useApp, setApp } from "../store/store";
import { DirectoryCache } from "./directoryCache";
import { refreshGit } from "./workspaceGit";
import type { GitSnapshot } from "../types/types";

const snapshot = (branch: string): GitSnapshot => ({
  root: "C:/project",
  session: 1,
  git: [],
  branch,
  tracking: null,
  warnings: [],
});
const caches: DirectoryCache[] = [];
function cache() {
  const value = new DirectoryCache("C:/project", () => {
    throw new Error("Git must not read directories");
  });
  value.session = 1;
  caches.push(value);
  return value;
}
afterEach(() => {
  caches.splice(0).forEach((cache) => cache.dispose());
  vi.resetAllMocks();
  setApp({
    gitState: { root: null, session: null, git: [], branch: null, tracking: null, warnings: [] },
    gitInfoVersion: 0,
    notice: null,
  });
});
describe("Independent Git refresh", () => {
  it("does not publish identical file status or invalidate repository info", async () => {
    const previous = snapshot("main");
    setApp({ gitState: previous });
    const listener = vi.fn();
    const unsubscribe = useApp.subscribe(listener);
    try {
      vi.mocked(call).mockResolvedValueOnce(snapshot("main"));
      await refreshGit(cache(), false, false);
      expect(useApp.getState().gitState).toBe(previous);
      expect(useApp.getState().gitInfoVersion).toBe(0);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
  it("publishes file changes without invalidating repository info", async () => {
    setApp({ gitState: snapshot("main") });
    vi.mocked(call).mockResolvedValueOnce({
      ...snapshot("main"),
      git: [{ path: "a.txt", status: "modified" }],
    });
    await refreshGit(cache(), false, false);
    expect(useApp.getState().gitState.git).toEqual([{ path: "a.txt", status: "modified" }]);
    expect(useApp.getState().gitInfoVersion).toBe(0);
  });
  it.each([false, true])(
    "invalidates info for metadata or forced refresh (force=%s)",
    async (force) => {
      const previous = snapshot("main");
      setApp({ gitState: previous });
      vi.mocked(call).mockResolvedValueOnce(snapshot("main"));
      await refreshGit(cache(), force, !force);
      expect(useApp.getState().gitState).toBe(previous);
      expect(useApp.getState().gitInfoVersion).toBe(1);
      expect(call).toHaveBeenCalledWith("workspace_git_status", {
        expectedRoot: "C:/project",
        session: 1,
        ...(force ? { force: true } : {}),
      });
    },
  );
  it.each([
    { force: false, infoChanged: true },
    { force: true, infoChanged: false },
  ])(
    "retains invalidation when concurrent refresh requests are merged: %j",
    async ({ force, infoChanged }) => {
      let resolve!: (value: GitSnapshot) => void;
      vi.mocked(call)
        .mockReturnValueOnce(
          new Promise((done) => {
            resolve = done;
          }),
        )
        .mockResolvedValueOnce(snapshot("main"));
      const current = cache();
      const pending = refreshGit(current, false, false);
      expect(refreshGit(current, force, infoChanged)).toBe(pending);
      expect(refreshGit(current, false, false)).toBe(pending);
      resolve(snapshot("main"));
      await pending;
      expect(call).toHaveBeenCalledTimes(2);
      expect(vi.mocked(call).mock.calls[1][1]).toEqual({
        expectedRoot: "C:/project",
        session: 1,
        ...(force ? { force: true } : {}),
      });
      expect(useApp.getState().gitInfoVersion).toBe(1);
    },
  );
  it.each(["error", "warning"])("retries invalidated info after a status %s", async (failure) => {
    const current = cache();
    if (failure === "error") {
      vi.mocked(call).mockRejectedValueOnce(new Error("Git failed"));
    } else {
      vi.mocked(call).mockResolvedValueOnce({
        ...snapshot("main"),
        warnings: ["Incomplete status"],
      });
    }
    await refreshGit(current, false, true);
    expect(useApp.getState().gitInfoVersion).toBe(0);
    vi.mocked(call).mockResolvedValueOnce(snapshot("main"));
    await refreshGit(current, false, false);
    expect(useApp.getState().gitInfoVersion).toBe(1);
  });
  it("retains previous status if a repository reports an incomplete result", async () => {
    setApp({ gitState: snapshot("keep") });
    vi.mocked(call).mockResolvedValueOnce({
      ...snapshot("incomplete"),
      warnings: ["Repository could not be read"],
    });
    await refreshGit(cache());
    expect(useApp.getState().gitState.branch).toBe("keep");
    expect(useApp.getState().notice).toBe("Repository could not be read");
    expect(useApp.getState().gitInfoVersion).toBe(0);
  });
  it("coalesces requests into one follow-up without reading the file tree", async () => {
    let resolve!: (value: GitSnapshot) => void;
    vi.mocked(call)
      .mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      )
      .mockResolvedValueOnce(snapshot("latest"));
    const current = cache();
    const pending = refreshGit(current);
    expect(refreshGit(current)).toBe(pending);
    expect(refreshGit(current)).toBe(pending);
    resolve(snapshot("old"));
    await pending;
    expect(vi.mocked(call).mock.calls.map(([command]) => command)).toEqual([
      "workspace_git_status",
      "workspace_git_status",
    ]);
    expect(useApp.getState().gitState.branch).toBe("latest");
  });
  it("keeps previous Git status when a refresh fails", async () => {
    setApp({ gitState: snapshot("keep") });
    vi.mocked(call).mockRejectedValueOnce(new Error("Git failed"));
    await refreshGit(cache());
    expect(useApp.getState().gitState.branch).toBe("keep");
    expect(useApp.getState().notice).toBe("Git failed");
    expect(useApp.getState().gitInfoVersion).toBe(0);
  });
  it("ignores results from a disposed workspace session", async () => {
    let resolve!: (value: GitSnapshot) => void;
    vi.mocked(call).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const current = cache();
    const pending = refreshGit(current);
    current.dispose();
    resolve(snapshot("stale"));
    await pending;
    expect(useApp.getState().gitState.root).toBeNull();
    expect(useApp.getState().gitInfoVersion).toBe(0);
  });
  it.each([{ session: 2 }, { root: "C:/other" }])(
    "ignores mismatched status contexts: %j",
    async (patch) => {
      const previous = snapshot("keep");
      setApp({ gitState: previous });
      vi.mocked(call).mockResolvedValueOnce({ ...snapshot("stale"), ...patch });
      await refreshGit(cache());
      expect(useApp.getState().gitState).toBe(previous);
      expect(useApp.getState().gitInfoVersion).toBe(0);
    },
  );
});
