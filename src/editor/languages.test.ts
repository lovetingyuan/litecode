import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  reference: vi.fn(),
  clients: [] as { options: { clientOptions: { workspaceFolder?: { uri: string }; middleware: { workspace: { handleApplyEdit: (params: { edit: object }) => Promise<{ applied: boolean }> } } } }; running: boolean; start: () => Promise<void>; stop: () => Promise<void> }[],
  state: { root: "C:/a", settings: {}, docs: {} },
  models: new Map(),
}));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class { } }));
vi.mock("vscode-jsonrpc/browser", () => ({ AbstractMessageReader: class { }, AbstractMessageWriter: class { } }));
vi.mock("vscode", () => ({ Uri: { file: (path: string) => path }, workspace: { textDocuments: [] } }));
vi.mock("monaco-languageclient", () => ({
  MonacoLanguageClient: class {
    running = false;
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
  mocks.call.mockResolvedValue("service");
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
  let complete!: (description: string) => void;
  mocks.call.mockImplementation((command) => command === "lsp_start"
    ? new Promise<string>((resolve) => { complete = resolve; }) : Promise.resolve(undefined));
  const starting = ensureLanguage("doc", "typescript");
  await vi.waitFor(() => expect(complete).toBeDefined());
  const stopped = stopLanguages();
  complete("old service");
  await Promise.all([starting, stopped]);
  expect(mocks.clients).toHaveLength(0);
  expect(languageReport().services).toHaveLength(0);
  expect(languageReport().starting).toHaveLength(0);
});
