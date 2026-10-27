import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./bridge", () => ({ desktop: true, call: vi.fn(), errorMessage: (e: Error) => e.message }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../editor/documents", () => ({ checkpoint: vi.fn() }));
import { call } from "./bridge";
import { listen } from "@tauri-apps/api/event";
import { checkpoint } from "../editor/documents";
import { acceptUpdate, checkForUpdates, initializeUpdates, installUpdate, updateLocked, useUpdates, type UpdateSnapshot } from "./updates";

const initial: UpdateSnapshot = { revision: 0, phase: "idle", currentVersion: "0.1.0", version: null, notes: null, downloaded: 0, total: null, error: null, portable: false, requestId: null };
const listeners = new Map<string, (event: { payload: UpdateSnapshot }) => void>();
const inert = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  useUpdates.setState({ ...initial, revision: -1, open: false });
  vi.stubGlobal("document", { querySelector: () => ({ toggleAttribute: inert, removeAttribute: vi.fn() }), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.mocked(listen).mockImplementation(async (event, listener) => { listeners.set(event, listener as never); return vi.fn<() => void>(); });
  vi.mocked(call).mockImplementation(async (command) => command === "get_update_state" ? initial : { ...initial, revision: 1, phase: "current" });
  vi.mocked(checkpoint).mockResolvedValue(undefined);
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
describe("update bridge", () => {
  it("keeps background checks quiet and listens before reading the snapshot", async () => {
    const stop = await initializeUpdates(); await settle();
    expect(useUpdates.getState().open).toBe(false);
    expect(call).toHaveBeenCalledWith("check_update", { background: true });
    expect(vi.mocked(listen).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(call).mock.invocationCallOrder[0]);
    stop();
  });
  it("does not let a stale IPC snapshot replace a newer event", () => {
    acceptUpdate({ ...initial, revision: 4, phase: "available", version: "0.2.0" });
    acceptUpdate({ ...initial, revision: 3 });
    expect(useUpdates.getState().version).toBe("0.2.0");
  });
  it("opens manual checks and displays errors without discarding release notes", async () => {
    acceptUpdate({ ...initial, version: "0.2.0", notes: "- Changes" });
    vi.mocked(call).mockRejectedValueOnce(new Error("Offline"));
    await checkForUpdates();
    expect(useUpdates.getState()).toMatchObject({ open: true, phase: "error", error: "Offline", notes: "- Changes" });
  });
  it("freezes input and acknowledges each backup request only once", async () => {
    await initializeUpdates(); await settle();
    const snapshot: UpdateSnapshot = { ...initial, revision: 10, phase: "preparing", requestId: 10 };
    listeners.get("update-state")!({ payload: snapshot });
    listeners.get("update-state")!({ payload: snapshot });
    expect(inert).toHaveBeenLastCalledWith("inert", true);
    await settle();
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith({ waitForMoves: true });
    expect(call).toHaveBeenCalledWith("ack_update_checkpoint", { requestId: 10, error: null });
  });
  it("reports backup failures and unfreezes when installation is cancelled", async () => {
    await initializeUpdates(); await settle();
    vi.mocked(checkpoint).mockRejectedValueOnce(new Error("Disk full"));
    listeners.get("update-state")!({ payload: { ...initial, revision: 10, phase: "preparing", requestId: 10 } });
    await settle();
    expect(call).toHaveBeenCalledWith("ack_update_checkpoint", { requestId: 10, error: "Disk full" });
    listeners.get("update-state")!({ payload: { ...initial, revision: 11, phase: "error", error: "Disk full" } });
    expect(inert).toHaveBeenLastCalledWith("inert", false);
  });
  it("retains download errors for retry and locks only during installation", async () => {
    vi.mocked(call).mockRejectedValueOnce(new Error("Signature mismatch"));
    await installUpdate();
    expect(useUpdates.getState().error).toBe("Signature mismatch");
    expect(updateLocked("downloading")).toBe(false);
    expect(updateLocked("preparing")).toBe(true);
    expect(updateLocked("installing")).toBe(true);
  });
});
