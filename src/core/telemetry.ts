import { captureException, getClient, init, metrics } from "@sentry/react";
import { isTauri } from "@tauri-apps/api/core";

export function initTelemetry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn || !isTauri()) {
    return;
  }

  init({
    dsn,
    release: `litecode@${__APP_VERSION__}`,
    environment: import.meta.env.DEV ? "development" : "production",
    defaultIntegrations: false,
    beforeSend(event) {
      // Error messages can include editor contents, paths, or command output.
      const kind = event.tags?.error_kind;
      for (const exception of event.exception?.values ?? []) {
        exception.value = typeof kind === "string" ? kind : "LiteCode error";
      }
      return event;
    },
  });
  metrics.count("litecode.window.open", 1);
}

export function reportError(kind: string, error: unknown): void {
  if (!getClient()) {
    return;
  }
  captureException(error instanceof Error ? error : new Error(kind), {
    tags: { error_kind: kind },
  });
}

export function recordWorkspaceOpen(): void {
  metrics.count("litecode.workspace.open", 1);
}
