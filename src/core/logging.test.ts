import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ write: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: mocks.write }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: mocks.invoke,
  Channel: class {},
  convertFileSrc: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

beforeEach(() => {
  vi.resetModules();
  mocks.write.mockReset().mockResolvedValue(undefined);
  mocks.invoke.mockReset();
});

it("normalizes errors without serializing arbitrary payloads", async () => {
  const { normalizeLogError } = await import("./logging");
  expect(normalizeLogError({ code: "io", message: "Denied", text: "private" })).toEqual({
    code: "io",
    message: "Denied",
  });
  expect(normalizeLogError("failed")).toEqual({ message: "failed" });
  expect(normalizeLogError({ text: "private" }).message).toBe("Unknown error");
});

it("ignores expected control flow and native-owned update errors", async () => {
  const { logError, logCommandError } = await import("./logging");
  for (const code of [
    "cancelled",
    "workspaceTrust",
    "formatterTrust",
    "languageTrust",
    "lspStopped",
  ]) {
    logError("test", { code, message: "expected" });
  }
  const failure = new Error("Update failed");
  logCommandError("check_update", failure);
  logError("outer", failure);
  expect(mocks.write).not.toHaveBeenCalled();
});

it("deduplicates rethrown objects and bounds repeated errors", async () => {
  const { logError } = await import("./logging");
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  const error = new Error("Disk failed");
  logError("save", error);
  logError("outer", error);
  logError("save", new Error("Disk failed"));
  expect(mocks.write).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mocks.write.mock.calls[0][0])).toMatchObject({
    event: "save",
    window: "main",
    message: "Disk failed",
  });
  logError("save", new Error("Disk failed"), { path: "C:/project/other.ts" });
  expect(mocks.write).toHaveBeenCalledTimes(2);
  now.mockReturnValue(31_000);
  logError("save", new Error("Disk failed"));
  expect(mocks.write).toHaveBeenCalledTimes(3);
  expect(JSON.parse(mocks.write.mock.calls[2][0])).toMatchObject({ suppressed: 1 });
  now.mockRestore();
});

it("omits external tool and parser output", async () => {
  const { logError } = await import("./logging");
  logError("format", { code: "formatter", message: "private source", stack: "private stack" });
  expect(mocks.write.mock.calls[0][0]).not.toContain("private");
});

it("preserves the original command rejection when logging also fails", async () => {
  const failure = { code: "io", message: "Permission denied" };
  mocks.invoke.mockRejectedValue(failure);
  mocks.write.mockRejectedValue(new Error("Logger unavailable"));
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const { call } = await import("./bridge");
  await expect(
    call("save_document", { path: "C:/project/file.ts", text: "private buffer" }),
  ).rejects.toBe(failure);
  await Promise.resolve();
  expect(mocks.write.mock.calls[0][0]).not.toContain("private buffer");
  expect(JSON.parse(mocks.write.mock.calls[0][0]).path).toBe("C:/project/file.ts");
  expect(consoleError).toHaveBeenCalledTimes(1);
  consoleError.mockRestore();
});

it("does not fail on objects with throwing getters", async () => {
  const { logError } = await import("./logging");
  const error = Object.defineProperty({}, "message", {
    get: () => {
      throw new Error("getter");
    },
  });
  expect(() => logError("test", error)).not.toThrow();
});

it("installs global handlers once and records uncaught errors and rejected promises", async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const addEventListener = vi.fn((name: string, listener: (event: unknown) => void) => {
    listeners.set(name, listener);
  });
  vi.stubGlobal("window", { addEventListener });
  try {
    const { installErrorLogging } = await import("./logging");
    installErrorLogging();
    installErrorLogging();
    expect(addEventListener).toHaveBeenCalledTimes(2);
    listeners.get("error")?.({ error: new Error("Uncaught fixture") });
    listeners.get("unhandledrejection")?.({ reason: new Error("Rejected fixture") });
    expect(mocks.write.mock.calls.map(([record]) => JSON.parse(record).event)).toEqual([
      "uncaught_error",
      "unhandled_rejection",
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
