import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../core/bridge", () => ({ call: vi.fn(), errorMessage: (error: Error) => error.message }));
import { call } from "../core/bridge";
import { useApp, setApp } from "../store/store";
import { DirectoryCache } from "./directoryCache";
import { refreshGit } from "./workspaceGit";
import type { GitSnapshot } from "../types/types";

const snapshot = (branch: string): GitSnapshot => ({ root: "C:/project", session: 1, git: [], branch, warnings: [] });
const caches: DirectoryCache[] = [];
function cache() {
  const value = new DirectoryCache("C:/project", () => { throw new Error("Git must not read directories"); });
  value.session = 1;
  caches.push(value);
  return value;
}
afterEach(() => {
  caches.splice(0).forEach((cache) => cache.dispose());
  vi.resetAllMocks();
  setApp({ gitState: { root: null, session: null, git: [], branch: null, warnings: [] }, notice: null });
});
describe("Independent Git refresh", () => {
  it("retains previous status if a repository reports an incomplete result", async () => {
    setApp({ gitState: snapshot("keep") });
    vi.mocked(call).mockResolvedValueOnce({ ...snapshot("incomplete"), warnings: ["Repository could not be read"] });
    await refreshGit(cache());
    expect(useApp.getState().gitState.branch).toBe("keep");
    expect(useApp.getState().notice).toBe("Repository could not be read");
  });
  it("coalesces requests into one follow-up without reading the file tree", async () => {
    let resolve!: (value: GitSnapshot) => void;
    vi.mocked(call).mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockResolvedValueOnce(snapshot("latest"));
    const current = cache();
    const pending = refreshGit(current);
    expect(refreshGit(current)).toBe(pending);
    expect(refreshGit(current)).toBe(pending);
    resolve(snapshot("old"));
    await pending;
    expect(vi.mocked(call).mock.calls.map(([command]) => command)).toEqual(["workspace_git_status", "workspace_git_status"]);
    expect(useApp.getState().gitState.branch).toBe("latest");
  });
  it("keeps previous Git status when a refresh fails", async () => {
    setApp({ gitState: snapshot("keep") });
    vi.mocked(call).mockRejectedValueOnce(new Error("Git failed"));
    await refreshGit(cache());
    expect(useApp.getState().gitState.branch).toBe("keep");
    expect(useApp.getState().notice).toBe("Git failed");
  });
  it("ignores results from a disposed workspace session", async () => {
    let resolve!: (value: GitSnapshot) => void;
    vi.mocked(call).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const current = cache();
    const pending = refreshGit(current);
    current.dispose();
    resolve(snapshot("stale"));
    await pending;
    expect(useApp.getState().gitState.root).toBeNull();
  });
});
