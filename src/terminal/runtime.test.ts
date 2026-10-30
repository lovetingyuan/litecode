import { beforeEach, describe, expect, it, vi } from "vitest";

// Terminal lifecycle tests run without a browser; theme resolution is verified separately.
vi.mock("../styles/theme", () => ({ terminalTheme: () => ({}) }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    unicode = {};
    cols = 80;
    rows = 24;
    element = {};
    parser = { registerOscHandler: vi.fn() };
    loadAddon() {}
    open() {}
    dispose() {}
    focus() {}
    writeln() {}
    write(_text: string, done?: () => void) {
      done?.();
    }
    onData() {}
    onBinary() {}
    onSelectionChange() {}
    onTitleChange() {}
    onBell() {}
    registerLinkProvider() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = vi.fn();
  },
}));
vi.mock("../core/bridge", () => ({ desktop: true, call: vi.fn(), errorMessage: String }));
vi.mock("../core/workspaceTrust", () => ({ trustedCall: vi.fn(), manageWorkspaceTrust: vi.fn() }));
vi.mock("../components/dialog", () => ({ ask: vi.fn() }));

import { call } from "../core/bridge";
import { trustedCall } from "../core/workspaceTrust";
import { ask } from "../components/dialog";
import { useApp } from "../store/store";
import { addSplit, addTab, patchPane, useTerminal } from "./state";
import { closePane, closeTab, mountPane, resetTerminals, restartPane } from "./runtime";

const host = () => ({
  append: vi.fn(),
  remove: vi.fn(),
  addEventListener: vi.fn(),
  getBoundingClientRect: () => ({ width: 100 }),
});
const events = new Map<string, { onmessage: (event: unknown) => void }>();
let serial = 0;
beforeEach(() => {
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("document", { createElement: host });
  resetTerminals();
  vi.resetAllMocks();
  events.clear();
  serial = 0;
  useApp.setState({ settings: { "terminal.integrated.gpuAcceleration": "off" } });
  vi.mocked(call).mockResolvedValue(false);
  vi.mocked(ask).mockResolvedValue("Cancel");
  vi.mocked(trustedCall).mockImplementation(async (_command, factory) => {
    const args = typeof factory === "function" ? factory() : factory;
    const id = `session-${++serial}`;
    events.set(id, args!.onEvent as never);
    return {
      id,
      cwd: "C:/",
      profile: { name: "cmd", kind: "cmd" },
      integration: false,
      windowsBuild: 0,
    } as never;
  });
});
async function start(id = addTab()) {
  mountPane(id, host() as unknown as HTMLElement);
  await vi.waitFor(() => expect(useTerminal.getState().panes[id]?.status).toBe("running"));
  return id;
}
const hasPane = (id: string) => !!useTerminal.getState().panes[id];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("terminal close requests", () => {
  it("waits for a starting shell before checking its child processes", async () => {
    const created = deferred<unknown>();
    vi.mocked(trustedCall).mockReturnValueOnce(created.promise as never);
    const id = addTab();
    mountPane(id, host() as unknown as HTMLElement);
    const closing = closePane(id);
    expect(call).not.toHaveBeenCalled();
    created.resolve({
      id: "starting-session",
      cwd: "C:/",
      profile: { name: "cmd", kind: "cmd" },
      integration: false,
      windowsBuild: 0,
    });
    await closing;
    expect(call).toHaveBeenCalledWith("terminal_has_child_processes", { id: "starting-session" });
    expect(hasPane(id)).toBe(false);
  });

  it("removes a failed terminal without inspecting it", async () => {
    const id = addTab();
    patchPane(id, { status: "error" });
    await closePane(id);
    expect(call).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(hasPane(id)).toBe(false);
  });
  it("closes an idle shell without prompting", async () => {
    const id = await start();
    await closePane(id);
    expect(call).toHaveBeenCalledWith("terminal_has_child_processes", { id: "session-1" });
    expect(ask).not.toHaveBeenCalled();
    expect(hasPane(id)).toBe(false);
    expect(call).toHaveBeenCalledWith("terminal_close", { id: "session-1" });
  });
  it.each(["Cancel", null])("keeps a busy shell alive on %s", async (choice) => {
    const id = await start();
    vi.mocked(call).mockResolvedValue(true);
    vi.mocked(ask).mockResolvedValue(choice);
    await closePane(id);
    expect(hasPane(id)).toBe(true);
    expect(call).not.toHaveBeenCalledWith("terminal_close", expect.anything());
    expect(ask).toHaveBeenCalledWith(
      "Close Terminal?",
      expect.stringContaining("Processes are still running"),
      ["Close Terminal", "Cancel"],
      expect.objectContaining({ defaultChoice: "Cancel" }),
    );
  });
  it("confirms all panes in a tab once and leaves other tabs alive", async () => {
    const first = await start();
    const second = await start(addSplit(first, "right")!);
    const tab = useTerminal.getState().tabs[0].id;
    const other = await start();
    vi.mocked(call).mockImplementation(async (_command, args) => args?.id === "session-2");
    await closeTab(tab);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(hasPane(first) && hasPane(second)).toBe(true);
    vi.mocked(ask).mockResolvedValue("Close Tab");
    await closeTab(tab);
    expect(hasPane(first) || hasPane(second)).toBe(false);
    expect(hasPane(other)).toBe(true);
    expect(call).not.toHaveBeenCalledWith("terminal_close", { id: "session-3" });
  });
  it("requires explicit confirmation when inspection fails", async () => {
    const id = await start();
    vi.mocked(call).mockRejectedValueOnce(new Error("inspection failed"));
    await closePane(id);
    expect(ask).toHaveBeenCalledWith(
      "Close Terminal?",
      expect.stringContaining("Could not check"),
      expect.anything(),
      expect.anything(),
    );
    expect(hasPane(id)).toBe(true);
    vi.mocked(call).mockRejectedValueOnce(new Error("inspection failed"));
    vi.mocked(ask).mockResolvedValue("Close Terminal");
    await closePane(id);
    expect(hasPane(id)).toBe(false);
  });
  it("ignores overlapping pane and tab requests while checking and confirming", async () => {
    const id = await start();
    const check = deferred<boolean>();
    const answer = deferred<string>();
    vi.mocked(call).mockReturnValueOnce(check.promise);
    vi.mocked(ask).mockReturnValueOnce(answer.promise);
    const closing = closePane(id);
    await closeTab(useTerminal.getState().tabs[0].id);
    check.resolve(true);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    await closePane(id);
    answer.resolve("Close Terminal");
    await closing;
    expect(call).toHaveBeenCalledTimes(2);
    expect(hasPane(id)).toBe(false);
  });
  it("automatically removes an exited shell while its inspection is pending", async () => {
    const id = await start();
    const check = deferred<boolean>();
    vi.mocked(call).mockReturnValueOnce(check.promise);
    const closing = closePane(id);
    await vi.waitFor(() => expect(call).toHaveBeenCalled());
    events.get("session-1")!.onmessage({ kind: "exit", exitCode: 0, error: null });
    expect(hasPane(id)).toBe(false);
    check.resolve(true);
    await closing;
    expect(ask).not.toHaveBeenCalled();
  });
  it("does not close a restarted session after the old session was confirmed", async () => {
    const id = await start();
    vi.mocked(call).mockResolvedValue(true);
    const answer = deferred<string>();
    vi.mocked(ask).mockReturnValueOnce(answer.promise);
    const closing = closePane(id);
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    patchPane(id, { status: "error" });
    await restartPane(id);
    await start(id);
    answer.resolve("Close Terminal");
    await closing;
    expect(hasPane(id)).toBe(true);
    expect(call).not.toHaveBeenCalledWith("terminal_close", { id: "session-2" });
  });
  it("ignores an inspection response for a session restarted during the check", async () => {
    const id = await start();
    const check = deferred<boolean>();
    vi.mocked(call).mockReturnValueOnce(check.promise);
    const closing = closePane(id);
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith("terminal_has_child_processes", { id: "session-1" }),
    );
    patchPane(id, { status: "error" });
    await restartPane(id);
    await start(id);
    check.resolve(true);
    await closing;
    expect(ask).not.toHaveBeenCalled();
    expect(hasPane(id)).toBe(true);
    expect(call).not.toHaveBeenCalledWith("terminal_close", { id: "session-2" });
  });
  it("aborts a pending dialog when its terminal disappears", async () => {
    const id = await start();
    vi.mocked(call).mockResolvedValue(true);
    vi.mocked(ask).mockImplementation(
      (_title, _message, _choices, options) =>
        new Promise((resolve) => options?.signal?.addEventListener("abort", () => resolve(null))),
    );
    const closing = closePane(id);
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    resetTerminals();
    await closing;
    expect(hasPane(id)).toBe(false);
  });
});
