import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: { root: "C:/project" as string | null, openingWorkspace: null as string | null },
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
  mocks.state.openingWorkspace = null;
});

it.each([true, false])(
  "asks before opening and returns a path-bound trust decision (%s)",
  async (trusted) => {
    const { prepareWorkspaceOpen } = await import("./workspaceTrust");
    mocks.call.mockResolvedValue({ path: "C:/canonical", trusted: false, alreadyOpen: false });
    let answer!: (choice: string) => void;
    mocks.ask.mockReturnValue(
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
    );
    const pending = prepareWorkspaceOpen("C:/selected");
    await vi.waitFor(() => expect(mocks.ask).toHaveBeenCalledOnce());
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith("workspace_open_info", {
      path: "C:/selected",
    });
    answer(trusted ? "Trust Workspace" : "Restricted Mode");
    expect(await pending).toEqual({
      path: "C:/canonical",
      trusted: false,
      alreadyOpen: false,
      trust: { root: "C:/canonical", trusted },
    });
  },
);

it.each([
  { trusted: true, alreadyOpen: false },
  { trusted: false, alreadyOpen: true },
])("skips opening prompts when trust or the existing window can be reused (%j)", async (flags) => {
  const { prepareWorkspaceOpen } = await import("./workspaceTrust");
  const info = { path: "C:/project", ...flags };
  mocks.call.mockResolvedValue(info);
  expect(await prepareWorkspaceOpen(info.path)).toEqual(info);
  expect(mocks.ask).not.toHaveBeenCalled();
});

it("cancels opening when the trust dialog is dismissed", async () => {
  const { prepareWorkspaceOpen } = await import("./workspaceTrust");
  mocks.call.mockResolvedValue({ path: "C:/next", trusted: false, alreadyOpen: false });
  mocks.ask.mockResolvedValue(null);
  expect(await prepareWorkspaceOpen("C:/next")).toBeNull();
  expect(mocks.call).toHaveBeenCalledOnce();
});

it("restores restricted-mode consent without prompting or allowing protected commands", async () => {
  const { rememberWorkspaceTrust, trustedCall } = await import("./workspaceTrust");
  rememberWorkspaceTrust("C:/project", true);
  mocks.call.mockRejectedValue(denied);
  await expect(trustedCall("lsp_start")).rejects.toBe(denied);
  expect(mocks.ask).not.toHaveBeenCalled();
});

it.each(["", "C:/next"])(
  "does not let old background services prompt while picking or opening a workspace (%s)",
  async (opening) => {
    const { trustedCall } = await import("./workspaceTrust");
    mocks.state.openingWorkspace = opening;
    mocks.call.mockRejectedValue(denied);
    await expect(trustedCall("lsp_start")).rejects.toBe(denied);
    expect(mocks.ask).not.toHaveBeenCalled();
  },
);

it("shares concurrent trust prompts and retries only after explicit approval", async () => {
  const { trustedCall } = await import("./workspaceTrust");
  let approve!: (choice: string) => void;
  mocks.ask.mockReturnValue(
    new Promise<string>((resolve) => {
      approve = resolve;
    }),
  );
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
  expect(await trustedCall("terminal_create", argumentsForCall)).toBe("started");
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
  expect(mocks.call).toHaveBeenCalledWith("set_workspace_trust", {
    expectedRoot: "C:/project",
    trusted: false,
  });
  mocks.call.mockRejectedValue(denied);
  await expect(trustedCall("lsp_start")).rejects.toBe(denied);
  expect(mocks.ask).toHaveBeenCalledOnce();
});

const formatterDenied = {
  code: "formatterTrust",
  trustPath: "C:/loose",
  message: "Trust formatters",
};

it("authorizes loose-file formatting without granting workspace trust", async () => {
  mocks.state.root = null;
  const { trustedCall } = await import("./workspaceTrust");
  mocks.ask.mockResolvedValue("Trust Formatters");
  mocks.call
    .mockRejectedValueOnce(formatterDenied)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce("formatted");
  const args = { path: "C:/loose/a.html", text: "original", language: "html" };
  expect(await trustedCall("format_document", args)).toBe("formatted");
  expect(mocks.call.mock.calls).toEqual([
    ["format_document", args],
    ["trust_formatter", { path: args.path, expectedRoot: null, directory: "C:/loose" }],
    ["format_document", args],
  ]);
});

it("shares concurrent folder prompts and checks additional configuration sources", async () => {
  mocks.state.root = null;
  const { trustedCall } = await import("./workspaceTrust");
  let approve!: (choice: string) => void;
  mocks.ask
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          approve = resolve;
        }),
    )
    .mockResolvedValue("Trust Formatters");
  const trusted = new Set<string>();
  mocks.call.mockImplementation(async (command, args) => {
    if (command === "trust_formatter") {
      trusted.add(args.directory);
      return;
    }
    for (const trustPath of ["C:/loose", "C:/configs"]) {
      if (!trusted.has(trustPath)) {
        throw { ...formatterDenied, trustPath };
      }
    }
    return "formatted";
  });
  const pending = Promise.all(
    [1, 2].map(() => trustedCall("format_document", { path: "C:/loose/a.html" })),
  );
  await vi.waitFor(() => expect(mocks.ask).toHaveBeenCalledOnce());
  expect(trusted.size).toBe(0);
  approve("Trust Formatters");
  expect(await pending).toEqual(["formatted", "formatted"]);
  expect(mocks.ask).toHaveBeenCalledTimes(2);
  expect(trusted).toEqual(new Set(["C:/loose", "C:/configs"]));
});

it.each([null, "C:/project"])(
  "does not retry formatting when folder trust is refused (root=%s)",
  async (root) => {
    mocks.state.root = root;
    const { trustedCall } = await import("./workspaceTrust");
    mocks.call.mockRejectedValue(formatterDenied);
    mocks.ask.mockResolvedValue("Cancel");
    await expect(trustedCall("format_document", { path: "C:/loose/a.html" })).rejects.toBe(
      formatterDenied,
    );
    expect(mocks.call).toHaveBeenCalledTimes(1);
  },
);

it("abandons formatter approval after workspace change or prompt cancellation", async () => {
  mocks.state.root = null;
  const { trustedCall, cancelWorkspaceTrustPrompt } = await import("./workspaceTrust");
  mocks.call.mockRejectedValue(formatterDenied);
  mocks.ask.mockImplementation(async () => {
    await Promise.resolve();
    cancelWorkspaceTrustPrompt();
    return "Trust Formatters";
  });
  await expect(trustedCall("format_document")).rejects.toBe(formatterDenied);
  mocks.ask.mockImplementation(async () => {
    mocks.state.root = "C:/other";
    return "Trust Formatters";
  });
  await expect(trustedCall("format_document")).rejects.toBe(formatterDenied);
  expect(mocks.call.mock.calls.every(([command]) => command === "format_document")).toBe(true);
});

it("does not loop on a repeated formatter denial or grant it to other commands", async () => {
  const { trustedCall } = await import("./workspaceTrust");
  mocks.ask.mockResolvedValue("Trust Formatters");
  mocks.call.mockImplementation(async (command) => {
    if (command !== "trust_formatter") {
      throw formatterDenied;
    }
  });
  await expect(trustedCall("format_document")).rejects.toBe(formatterDenied);
  expect(mocks.ask).toHaveBeenCalledOnce();
  await expect(trustedCall("terminal_create")).rejects.toBe(formatterDenied);
  expect(mocks.ask).toHaveBeenCalledOnce();
});
