import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";

type ClientOptions = {
  messageTransports: { reader: { listen: (callback: (message: unknown) => void) => unknown } };
  clientOptions: {
    documentSelector: string[];
    initializationOptions: Record<string, unknown>;
    workspaceFolder?: { uri: string };
    middleware: {
      workspace: { handleApplyEdit: (params: { edit: object }) => Promise<{ applied: boolean }> };
    };
  };
};

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  ask: vi.fn(),
  messages: [] as unknown[],
  callbacks: new Map<number, (message: unknown) => void>(),
  reference: vi.fn(),
  clients: [] as {
    options: ClientOptions;
    running: boolean;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    handlers: Map<string, (params: unknown) => Promise<void>>;
    sendRequest: ReturnType<typeof vi.fn>;
    sendNotification: ReturnType<typeof vi.fn>;
  }[],
  state: { root: "C:/a", settings: {}, docs: {} },
  models: new Map(),
}));
vi.mock("vscode-jsonrpc/browser", () => ({
  AbstractMessageReader: class {
    fireClose() {}
  },
  AbstractMessageWriter: class {},
}));
vi.mock("vscode", () => ({
  Uri: { file: (path: string) => path },
  workspace: { textDocuments: [] },
}));
vi.mock("monaco-languageclient", () => ({
  MonacoLanguageClient: class {
    running = false;
    handlers = new Map();
    sendRequest = vi.fn().mockResolvedValue({ body: { result: true } });
    sendNotification = vi.fn().mockResolvedValue(undefined);
    onNotification(method: string, handler: (params: unknown) => Promise<void>) {
      this.handlers.set(method, handler);
    }
    constructor(public options: (typeof mocks.clients)[number]["options"]) {
      mocks.clients.push(this);
    }
    async start() {
      this.options.messageTransports.reader.listen((message) => mocks.messages.push(message));
      this.running = true;
    }
    async stop() {
      this.running = false;
    }
    isRunning() {
      return this.running;
    }
  },
}));
vi.mock("@codingame/monaco-vscode-files-service-override", () => ({
  RegisteredFileSystemProvider: class {},
}));
vi.mock("@codingame/monaco-vscode-api/monaco", () => ({ createModelReference: mocks.reference }));
vi.mock("../core/bridge", () => ({ call: mocks.call, desktop: true, errorMessage: String }));
vi.mock("../components/dialog", () => ({ ask: mocks.ask }));
vi.mock("../store/store", () => ({
  useApp: { getState: () => mocks.state },
  setApp: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("./monaco", () => ({ monaco: {} }));
vi.mock("./documents", () => ({ models: mocks.models, visiblePath: (path: string) => path }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.callbacks.clear();
  mocks.messages.length = 0;
  let callbackId = 0;
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {
      transformCallback: (callback: (message: unknown) => void) => {
        mocks.callbacks.set(++callbackId, callback);
        return callbackId;
      },
      unregisterCallback: (id: number) => mocks.callbacks.delete(id),
    },
  });
  mocks.state.root = "C:/a";
  mocks.clients.length = 0;
  mocks.models.clear();
  mocks.models.set("doc", { uri: { scheme: "file" }, isDisposed: () => false });
  mocks.reference.mockResolvedValue({ dispose: vi.fn() });
  mocks.call.mockResolvedValue({ description: "service", initializationOptions: {} });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not register or upgrade a Vue document when native document trust is denied", async () => {
  mocks.call.mockRejectedValue({ code: "languageTrust", message: "Open and trust this folder" });
  const { ensureLanguage } = await import("./languages");
  await ensureLanguage("doc", "vue");
  expect(mocks.reference).not.toHaveBeenCalled();
  expect(mocks.clients).toHaveLength(0);
  expect(mocks.call.mock.calls.map(([name]) => name)).toEqual(["check_language_document"]);
});

it.each([true, false])(
  "formats JSONC with the model's insertSpaces=%s and line endings",
  async (insertSpaces) => {
    const { formatModelText } = await import("./languages");
    const text = await formatModelText({
      getLanguageId: () => "jsonc",
      getValue: () => '{"x":{"value":1}}',
      getOptions: () => ({ tabSize: 2, insertSpaces }),
      getEOL: () => "\r\n",
    } as unknown as editor.ITextModel);
    expect(text).toContain(insertSpaces ? '\r\n  "x": {' : '\r\n\t"x": {');
    expect(text).toContain(insertSpaces ? '\r\n    "value": 1' : '\r\n\t\t"value": 1');
  },
);

it("reinitializes services with the new workspace after stopping the old clients", async () => {
  const { ensureLanguage, stopLanguages, languageReport } = await import("./languages");
  await ensureLanguage("doc", "typescript");
  expect(mocks.clients[0].options.clientOptions.workspaceFolder?.uri).toBe("C:/a");
  await stopLanguages();
  expect(mocks.clients[0].running).toBe(false);
  expect(
    await mocks.clients[0].options.clientOptions.middleware.workspace.handleApplyEdit({ edit: {} }),
  ).toMatchObject({ applied: false });
  mocks.state.root = "C:/b";
  await ensureLanguage("doc", "typescript");
  expect(mocks.clients[1].options.clientOptions.workspaceFolder?.uri).toBe("C:/b");
  expect(languageReport().services).toHaveLength(1);
});

it("drains an in-flight start and prevents its stale client from being registered", async () => {
  const { ensureLanguage, stopLanguages, languageReport } = await import("./languages");
  let complete!: (description: { description: string; initializationOptions: object }) => void;
  mocks.call.mockImplementation((command) =>
    command === "lsp_start"
      ? new Promise<{ description: string; initializationOptions: object }>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(undefined),
  );
  const starting = ensureLanguage("doc", "typescript");
  await vi.waitFor(() => expect(complete).toBeDefined());
  const stopped = stopLanguages();
  complete({ description: "old service", initializationOptions: {} });
  await Promise.all([starting, stopped]);
  expect(mocks.clients).toHaveLength(0);
  expect(languageReport().services).toHaveLength(0);
  expect(languageReport().starting).toHaveLength(0);
});

it("upgrades TypeScript once for concurrent Vue documents and restores normal selection after a workspace change", async () => {
  const { ensureLanguage, stopLanguages, languageReport, canFormat } = await import("./languages");
  await ensureLanguage("doc", "typescript");
  const previous = mocks.clients[0];
  const oldChannel = mocks.call.mock.calls.find(([command]) => command === "lsp_start")![1].onEvent;
  await Promise.all([ensureLanguage("doc", "vue"), ensureLanguage("doc", "vue")]);
  expect(previous.running).toBe(false);
  expect(mocks.clients).toHaveLength(3);
  expect(mocks.clients[1].options.clientOptions.documentSelector).toEqual([
    "typescript",
    "javascript",
    "typescriptreact",
    "javascriptreact",
    "vue",
  ]);
  expect(mocks.clients[2].options.clientOptions.documentSelector).toEqual(["vue"]);
  expect(
    mocks.call.mock.calls
      .filter(([command]) => command === "lsp_start")
      .map(([, args]) => args.language),
  ).toEqual(["typescript", "vue-typescript", "vue"]);
  oldChannel.onmessage({ kind: "exit" });
  expect(languageReport().services).toHaveLength(2);
  expect(canFormat("vue")).toBe(false);
  await stopLanguages();
  await ensureLanguage("doc", "typescript");
  expect(mocks.clients[3].options.clientOptions.documentSelector).not.toContain("vue");
});

it("passes native initialization options and forwards Vue requests to TypeScript, answering errors too", async () => {
  mocks.call.mockResolvedValue({
    description: "service",
    initializationOptions: { plugins: [{ name: "@vue/typescript-plugin" }] },
  });
  const { ensureLanguage } = await import("./languages");
  await ensureLanguage("doc", "vue");
  const [typescript, vue] = mocks.clients;
  expect(typescript.options.clientOptions.initializationOptions.plugins).toEqual([
    { name: "@vue/typescript-plugin" },
  ]);
  const forward = vue.handlers.get("tsserver/request")!;
  await forward([1, "_vue:projectInfo", { file: "C:/a/App.vue" }]);
  expect(typescript.sendRequest).toHaveBeenCalledWith("workspace/executeCommand", {
    command: "typescript.tsserverRequest",
    arguments: ["_vue:projectInfo", { file: "C:/a/App.vue" }],
  });
  expect(vue.sendNotification).toHaveBeenLastCalledWith("tsserver/response", [1, { result: true }]);
  typescript.sendRequest.mockRejectedValueOnce(new Error("TypeScript stopped"));
  await forward([2, "_vue:projectInfo", {}]);
  expect(vue.sendNotification).toHaveBeenLastCalledWith("tsserver/response", [2, null]);
});

it("drains a pending TypeScript startup before enabling the Vue plugin", async () => {
  const { ensureLanguage } = await import("./languages");
  let complete!: (info: object) => void;
  mocks.call.mockImplementation((command, args) =>
    command === "lsp_start" && args.language === "typescript"
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : Promise.resolve({ description: "service", initializationOptions: {} }),
  );
  const starting = ensureLanguage("doc", "typescript");
  await vi.waitFor(() => expect(complete).toBeDefined());
  const vue = ensureLanguage("doc", "vue");
  complete({ description: "old service", initializationOptions: {} });
  await Promise.all([starting, vue]);
  expect(mocks.clients).toHaveLength(3);
  expect(mocks.clients[0].running).toBe(false);
  expect(mocks.clients[1].running).toBe(true);
});

it("does not start Vue without its TypeScript companion", async () => {
  mocks.call.mockImplementation((command) =>
    command === "lsp_start" ? Promise.reject(new Error("missing Vue plugin")) : Promise.resolve(),
  );
  const { ensureLanguage, languageReport } = await import("./languages");
  await ensureLanguage("doc", "vue");
  expect(mocks.call.mock.calls.filter(([command]) => command === "lsp_start")).toHaveLength(1);
  expect(languageReport().failures.typescript).toContain("missing Vue plugin");
});

it("recreates the real Channel after a trust rejection and delivers messages with acknowledgements", async () => {
  mocks.ask.mockResolvedValue("Trust Workspace");
  const channels: { id: number }[] = [];
  mocks.call.mockImplementation(async (command, args) => {
    if (command !== "lsp_start") {
      return;
    }
    channels.push(args.onEvent);
    if (channels.length === 1) {
      mocks.callbacks.get(args.onEvent.id)!({ index: 0, end: true });
      throw { code: "workspaceTrust", message: "Restricted Mode" };
    }
    return { description: "trusted service", initializationOptions: {} };
  });
  const { ensureLanguage, languageReport } = await import("./languages");
  await ensureLanguage("doc", "typescript");
  expect(channels).toHaveLength(2);
  expect(channels[0].id).not.toBe(channels[1].id);
  expect(mocks.callbacks.has(channels[0].id)).toBe(false);
  const deliver = mocks.callbacks.get(channels[1].id)!;
  const messages = [
    { jsonrpc: "2.0", id: 1, result: { capabilities: {} } },
    {
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: "file:///C:/a/main.ts", diagnostics: [] },
    },
  ];
  messages.forEach((message, index) =>
    deliver({ index, message: { kind: "message", sequence: index + 1, message } }),
  );
  expect(mocks.messages).toEqual(messages);
  expect(mocks.call).toHaveBeenCalledWith("lsp_ack", { serverId: "typescript", sequence: 2 });
  expect(languageReport().services).toEqual([
    { id: "typescript", running: true, capabilities: undefined },
  ]);
});

it("does not retry LSP startup when trust is denied", async () => {
  mocks.ask.mockResolvedValue("Restricted Mode");
  mocks.call.mockRejectedValue({ code: "workspaceTrust" });
  const { ensureLanguage, languageReport } = await import("./languages");
  await ensureLanguage("doc", "typescript");
  expect(mocks.call.mock.calls.filter(([command]) => command === "lsp_start")).toHaveLength(0);
  expect(mocks.reference).not.toHaveBeenCalled();
  expect(mocks.clients).toHaveLength(0);
  expect(languageReport().services).toHaveLength(0);
  expect(mocks.call.mock.calls.some(([command]) => command === "set_workspace_trust")).toBe(false);
});

it("does not retry or register an old client when the workspace changes during the trust prompt", async () => {
  let approve!: (choice: string) => void;
  mocks.ask.mockReturnValue(
    new Promise<string>((resolve) => {
      approve = resolve;
    }),
  );
  mocks.call.mockRejectedValue({ code: "workspaceTrust" });
  const { ensureLanguage, stopLanguages, languageReport } = await import("./languages");
  const pending = ensureLanguage("doc", "typescript");
  await vi.waitFor(() => expect(mocks.ask).toHaveBeenCalledOnce());
  const stopped = stopLanguages();
  mocks.state.root = "C:/b";
  approve("Trust Workspace");
  await Promise.all([pending, stopped]);
  expect(mocks.clients).toHaveLength(0);
  expect(languageReport().services).toHaveLength(0);
  expect(mocks.call.mock.calls.filter(([command]) => command === "lsp_start")).toHaveLength(0);
  expect(mocks.reference).not.toHaveBeenCalled();
});
