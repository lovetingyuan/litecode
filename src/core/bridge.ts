import { invoke, isTauri, Channel, convertFileSrc } from "@tauri-apps/api/core";
import type { Bootstrap, SearchBatch } from "../types/types";

export const desktop = isTauri();
export const mediaSource = (path: string) => convertFileSrc(path, "media");
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktop) {
    throw {
      code: "desktop",
      message: "This operation needs the LiteCode desktop app. Run npm run tauri dev.",
    };
  }
  return invoke<T>(command, args);
}
export const channel = (fn: (batch: SearchBatch) => void) => {
  const c = new Channel<SearchBatch>();
  c.onmessage = fn;
  return c;
};
export function bootstrap(): Promise<Bootstrap> {
  if (desktop) {
    return call("bootstrap");
  }
  return Promise.resolve({
    root: null,
    documents: [],
    session: {},
    recent: [],
    settings: {},
    keybindings: [],
    warnings: [],
    dataDir: "",
  });
}
export function errorMessage(error: unknown): string {
  return typeof error === "object" && error && "message" in error
    ? String(error.message)
    : String(error);
}
