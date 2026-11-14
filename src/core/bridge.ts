import { invoke, isTauri, Channel, convertFileSrc } from "@tauri-apps/api/core";
import type { Bootstrap, SearchBatch } from "../types/types";
import { logCommandError } from "./logging";
import { errorMessage } from "./errorMessage";

export { errorMessage };

export const desktop = isTauri();
export const mediaSource = (path: string) => convertFileSrc(path, "media");
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktop) {
    throw {
      code: "desktop",
      message: "This operation needs the LiteCode desktop app. Run npm run tauri dev.",
    };
  }
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    logCommandError(command, error, typeof args?.path === "string" ? args.path : undefined);
    throw error;
  }
}
export const channel = (fn: (batch: SearchBatch) => void) => {
  const c = new Channel<SearchBatch>();
  c.onmessage = (batch) => {
    if (batch.errors.length) {
      batch.errors = batch.errors.map((error) => errorMessage(error, "Search failed."));
    }
    fn(batch);
  };
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
