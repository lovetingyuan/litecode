import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: { root: "C:/project" as string | null },
  call: vi.fn(),
  ask: vi.fn(),
}));
vi.mock("./bridge", () => ({ call: mocks.call }));
vi.mock("../components/dialog", () => ({ ask: mocks.ask }));
vi.mock("../store/store", () => ({ useApp: { getState: () => mocks.state } }));

const denied = { code: "workspaceTrust", message: "Restricted Mode" };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.state.root = "C:/project";
});

it("shares concurrent trust prompts and retries only after explicit approval", async () => {
  const { trustedCall } = await import("./workspaceTrust");
  let approve!: (choice: string) => void;
  mocks.ask.mockReturnValue(new Promise<string>((resolve) => { approve = resolve; }));
  let trusted = false;
  mocks.call.mockImplementation(async (command) => {
    if (command === "set_workspace_trust") {
      trusted = true;
      return;
    }
    if (!trusted) {
      throw denied;
    }
    return command;
  });
  const pending = Promise.all([trustedCall("lsp_start"), trustedCall("format_document")]);
  await vi.waitFor(() => expect(mocks.ask).toHaveBeenCalledOnce());
  expect(trusted).toBe(false);
  approve("Trust Workspace");
  expect(await pending).toEqual(["lsp_start", "format_document"]);
  expect(mocks.call.mock.calls.filter(([command]) => command === "set_workspace_trust")).toEqual([
    ["set_workspace_trust", { expectedRoot: "C:/project", trusted: true }],
  ]);
});

it("keeps restricted workspaces editable without repeated prompts or granting trust", async () => {
  const { trustedCall } = await import("./workspaceTrust");
  mocks.call.mockRejectedValue(denied);
  mocks.ask.mockResolvedValue("Restricted Mode");
  await expect(trustedCall("lsp_start")).rejects.toBe(denied);
  await expect(trustedCall("format_document")).rejects.toBe(denied);
  expect(mocks.ask).toHaveBeenCalledOnce();
  expect(mocks.call.mock.calls.some(([command]) => command === "set_workspace_trust")).toBe(false);
});

it("does not trust or retry a folder that changed while the prompt was open", async () => {
  const { trustedCall } = await import("./workspaceTrust");
  mocks.call.mockRejectedValue(denied);
  mocks.ask.mockImplementation(async () => {
    mocks.state.root = "C:/different";
    return "Trust Workspace";
  });
  await expect(trustedCall("lsp_start")).rejects.toBe(denied);
  expect(mocks.call).toHaveBeenCalledExactlyOnceWith("lsp_start", undefined);
});

it("propagates unrelated failures without requesting trust", async () => {
  const { trustedCall } = await import("./workspaceTrust");
  const error = { code: "missingTool", message: "Missing Node" };
  mocks.call.mockRejectedValue(error);
  await expect(trustedCall("lsp_start")).rejects.toBe(error);
  expect(mocks.ask).not.toHaveBeenCalled();
});

it("recreates channel arguments after an invocation rejected for trust", async () => {
  const { trustedCall } = await import("./workspaceTrust");
  const argumentsForCall = vi
    .fn()
    .mockReturnValueOnce({ channel: "first" })
    .mockReturnValueOnce({ channel: "second" });
  mocks.ask.mockResolvedValue("Trust Workspace");
  let attempts = 0;
  mocks.call.mockImplementation(async (command) => {
    if (command === "set_workspace_trust") {
      return;
    }
    if (!attempts++) {
      throw denied;
    }
    return "started";
  });
  expect(await trustedCall("terminal_create", argumentsForCall)).toBe(
    "started",
  );
  expect(argumentsForCall).toHaveBeenCalledTimes(2);
  expect(mocks.call).toHaveBeenCalledWith("terminal_create", {
    channel: "second",
  });
});

it("revokes trust through the manage command and suppresses automatic prompts", async () => {
  const { trustedCall, manageWorkspaceTrust } = await import("./workspaceTrust");
  mocks.ask.mockResolvedValue("Restricted Mode");
  mocks.call.mockResolvedValue(undefined);
  expect(await manageWorkspaceTrust()).toBe(false);
  expect(mocks.call).toHaveBeenCalledWith("set_workspace_trust", { expectedRoot: "C:/project", trusted: false });
  mocks.call.mockRejectedValue(denied);
  await expect(trustedCall("lsp_start")).rejects.toBe(denied);
  expect(mocks.ask).toHaveBeenCalledOnce();
});
