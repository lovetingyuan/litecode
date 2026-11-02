import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { error as writeError } from "@tauri-apps/plugin-log";
import type { ErrorLogContext, NormalizedLogError } from "../types/logging";

const recorded = new WeakSet<object>();
const recent = new Map<string, { time: number; suppressed: number }>();
const expected = new Set([
  "cancelled",
  "workspaceTrust",
  "formatterTrust",
  "languageTrust",
  "updateBusy",
  "gitBusy",
  "toolBusy",
  "searchBusy",
  "lspStopped",
]);
let installed = false;
let transportFailed = false;

function rateLimit(key: string): number | undefined {
  const now = Date.now();
  const previous = recent.get(key);
  if (previous && now - previous.time < 30_000) {
    previous.suppressed++;
    return;
  }
  recent.delete(key);
  if (recent.size >= 128) {
    const oldest = recent.keys().next().value;
    if (oldest !== undefined) {
      recent.delete(oldest);
    }
  }
  recent.set(key, { time: now, suppressed: 0 });
  return previous?.suppressed ?? 0;
}

export function normalizeLogError(error: unknown): NormalizedLogError {
  if (typeof error !== "object" || error === null) {
    return { message: typeof error === "string" ? error : String(error) };
  }
  return {
    code: "code" in error && typeof error.code === "string" ? error.code : undefined,
    message:
      "message" in error && typeof error.message === "string" ? error.message : "Unknown error",
    stack: "stack" in error && typeof error.stack === "string" ? error.stack : undefined,
  };
}

/** Logging must never delay an operation, replace its error, or reject another promise. */
export function logError(event: string, error: unknown, context: ErrorLogContext = {}): void {
  try {
    if (typeof error === "object" && error !== null && recorded.has(error)) {
      return;
    }
    const normalized = normalizeLogError(error);
    if (normalized.code && expected.has(normalized.code)) {
      return;
    }
    if (typeof error === "object" && error !== null) {
      recorded.add(error);
    }
    // These error messages can contain source excerpts or external tool output.
    const omitDetails =
      context.omitDetails ||
      ["formatter", "install", "encoding", "json", "regex", "lspProtocol", "git"].includes(
        normalized.code ?? "",
      );
    const message = omitDetails
      ? `Operation failed (${normalized.code ?? event}); tool output omitted`
      : normalized.message;
    const key = `${event}:${context.command ?? ""}:${context.path?.slice(0, 1024) ?? ""}:${normalized.code ?? ""}:${message.slice(0, 512)}`;
    const suppressed = rateLimit(key);
    if (suppressed === undefined) {
      return;
    }
    const record = {
      source: "frontend",
      event,
      command: context.command,
      path: context.path,
      operationId: context.operationId ?? crypto.randomUUID(),
      window: isTauri() ? getCurrentWindow().label : undefined,
      code: normalized.code,
      message: message.slice(0, 8192),
      stack: omitDetails ? undefined : (context.stack ?? normalized.stack)?.slice(0, 4096),
      suppressed,
    };
    if (!isTauri()) {
      // The native writer owns redaction; browser previews only emit safe metadata.
      console.error("LiteCode error", event, normalized.code ?? "unknown");
      return;
    }
    // Use the plugin directly, never the business IPC wrapper.
    void writeError(JSON.stringify(record)).catch(() => {
      if (!transportFailed) {
        transportFailed = true;
        console.error("Could not write LiteCode error logs.");
      }
    });
  } catch {
    // Hostile error getters and unavailable browser APIs cannot break error handling.
  }
}

export function logCommandError(command: string, error: unknown, path?: string): void {
  // Updater failures are also produced by its native scheduler.
  if (command === "check_update" || command === "install_update") {
    if (typeof error === "object" && error !== null) {
      recorded.add(error);
    }
    return;
  }
  logError("command_failed", error, { command, path });
}

export function installErrorLogging(): void {
  if (installed) {
    return;
  }
  installed = true;
  window.addEventListener("error", (event) => {
    logError("uncaught_error", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    logError("unhandled_rejection", event.reason);
  });
}
