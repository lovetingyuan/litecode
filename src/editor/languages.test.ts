import { afterEach, beforeEach, expect, it, vi } from "vitest";

type ClientOptions = {
  clientOptions: {
    documentSelector: string[];
    initializationOptions: Record<string, unknown>;
    workspaceFolder?: { uri: string };
    middleware: { workspace: { handleApplyEdit: (params: { edit: object }) => Promise<{ applied: boolean }> } };
  };
};

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
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
vi.mock("@tauri-apps/api/core", () => ({ Channel: class { } }));
vi.mock("vscode-jsonrpc/browser", () => ({ AbstractMessageReader: class { fireClose() {} }, AbstractMessageWriter: class { } }));
vi.mock("vscode", () => ({ Uri: { file: (path: string) => path }, workspace: { textDocuments: [] } }));
vi.mock("monaco-languageclient", () => ({
  MonacoLanguageClient: class {
    running = false;
    handlers = new Map();
    sendRequest = vi.fn().mockResolvedValue({ body: { result: true } });
    sendNotification = vi.fn().mockResolvedValue(undefined);
    onNotification(method: string, handler: (params: unknown) => Promise<void>) { this.handlers.set(method, handler); }
    constructor(public options: typeof mocks.clients[number]["options"]) { mocks.clients.push(this); }
    async start() { this.running = true; }
    async stop() { this.running = false; }
    isRunning() { return this.running; }
  }
}));
vi.mock("@codingame/monaco-vscode-files-service-override", () => ({ RegisteredFileSystemProvider: class { } }));
vi.mock("@codingame/monaco-vscode-api/monaco", () => ({ createModelReference: mocks.reference }));
vi.mock("../core/bridge", () => ({ call: mocks.call, desktop: true, errorMessage: String }));
vi.mock("../core/workspaceTrust", () => ({ trustedCall: mocks.call, cancelWorkspaceTrustPrompt: vi.fn() }));
vi.mock("../store/store", () => ({ useApp: { getState: () => mocks.state }, setApp: vi.fn(), notify: vi.fn() }));
vi.mock("./monaco", () => ({ monaco: {} }));
vi.mock("./documents", () => ({ models: mocks.models, visiblePath: (path: string) => path }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
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
});

it("reinitializes services with the new workspace after stopping the old clients", async () => {
  const { ensureLanguage, stopLanguages, languageReport } = await import("./languages");
  await ensureLanguage("doc", "typescript");
  expect(mocks.clients[0].options.clientOptions.workspaceFolder?.uri).toBe("C:/a");
  await stopLanguages();
  expect(mocks.clients[0].running).toBe(false);
  expect(await mocks.clients[0].options.clientOptions.middleware.workspace.handleApplyEdit({ edit: {} })).toMatchObject({ applied: false });
  mocks.state.root = "C:/b";
  await ensureLanguage("doc", "typescript");
  expect(mocks.clients[1].options.clientOptions.workspaceFolder?.uri).toBe("C:/b");
  expect(languageReport().services).toHaveLength(1);
});

it("drains an in-flight start and prevents its stale client from being registered", async () => {
  const { ensureLanguage, stopLanguages, languageReport } = await import("./languages");
  let complete!: (description: { description: string; initializationOptions: object }) => void;
  mocks.call.mockImplementation((command) => command === "lsp_start"
    ? new Promise<{ description: string; initializationOptions: object }>((resolve) => { complete = resolve; }) : Promise.resolve(undefined));
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
    "typescript", "javascript", "typescriptreact", "javascriptreact", "vue",
  ]);
  expect(mocks.clients[2].options.clientOptions.documentSelector).toEqual(["vue"]);
  expect(mocks.call.mock.calls.filter(([command]) => command === "lsp_start").map(([, args]) => args.language))
    .toEqual(["typescript", "vue-typescript", "vue"]);
  oldChannel.onmessage({ kind: "exit" });
  expect(languageReport().services).toHaveLength(2);
  expect(canFormat("vue")).toBe(false);
  await stopLanguages();
  await ensureLanguage("doc", "typescript");
  expect(mocks.clients[3].options.clientOptions.documentSelector).not.toContain("vue");
});

it("passes native initialization options and forwards Vue requests to TypeScript, answering errors too", async () => {
  mocks.call.mockResolvedValue({ description: "service", initializationOptions: { plugins: [{ name: "@vue/typescript-plugin" }] } });
  const { ensureLanguage } = await import("./languages");
  await ensureLanguage("doc", "vue");
  const [typescript, vue] = mocks.clients;
  expect(typescript.options.clientOptions.initializationOptions.plugins).toEqual([{ name: "@vue/typescript-plugin" }]);
  const forward = vue.handlers.get("tsserver/request")!;
  await forward([1, "_vue:projectInfo", { file: "C:/a/App.vue" }]);
  expect(typescript.sendRequest).toHaveBeenCalledWith("workspace/executeCommand", {
    command: "typescript.tsserverRequest", arguments: ["_vue:projectInfo", { file: "C:/a/App.vue" }],
  });
  expect(vue.sendNotification).toHaveBeenLastCalledWith("tsserver/response", [1, { result: true }]);
  typescript.sendRequest.mockRejectedValueOnce(new Error("TypeScript stopped"));
  await forward([2, "_vue:projectInfo", {}]);
  expect(vue.sendNotification).toHaveBeenLastCalledWith("tsserver/response", [2, null]);
});

it("drains a pending TypeScript startup before enabling the Vue plugin", async () => {
  const { ensureLanguage } = await import("./languages");
  let complete!: (info: object) => void;
  mocks.call.mockImplementation((command, args) => command === "lsp_start" && args.language === "typescript"
    ? new Promise((resolve) => { complete = resolve; })
    : Promise.resolve({ description: "service", initializationOptions: {} }));
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
  mocks.call.mockImplementation((command) => command === "lsp_start"
    ? Promise.reject(new Error("missing Vue plugin")) : Promise.resolve());
  const { ensureLanguage, languageReport } = await import("./languages");
  await ensureLanguage("doc", "vue");
  expect(mocks.call.mock.calls.filter(([command]) => command === "lsp_start")).toHaveLength(1);
  expect(languageReport().failures.typescript).toContain("missing Vue plugin");
});
