import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { call, desktop, errorMessage } from "./bridge";

export type UpdateSnapshot = {
  revision: number;
  phase:
    | "idle"
    | "checking"
    | "current"
    | "available"
    | "downloading"
    | "preparing"
    | "installing"
    | "error";
  currentVersion: string;
  version: string | null;
  notes: string | null;
  downloaded: number;
  total: number | null;
  error: string | null;
  portable: boolean;
  requestId: number | null;
};
export const useUpdates = create<UpdateSnapshot & { open: boolean }>(() => ({
  revision: -1,
  phase: "idle",
  currentVersion: "",
  version: null,
  notes: null,
  downloaded: 0,
  total: null,
  error: null,
  portable: false,
  requestId: null,
  open: false,
}));
export const updateLocked = (phase: UpdateSnapshot["phase"]) =>
  phase === "preparing" || phase === "installing";
export function acceptUpdate(snapshot: UpdateSnapshot) {
  if (snapshot.revision >= useUpdates.getState().revision) {
    useUpdates.setState(snapshot);
  }
}

export async function checkForUpdates() {
  useUpdates.setState({ open: true });
  try {
    acceptUpdate(await call<UpdateSnapshot>("check_update", { background: false }));
  } catch (error) {
    useUpdates.setState({ phase: "error", error: errorMessage(error) });
  }
}

export async function installUpdate() {
  try {
    await call<void>("install_update");
  } catch (error) {
    useUpdates.setState({ error: errorMessage(error) });
  }
}

export async function initializeUpdates(): Promise<() => void> {
  if (!desktop) {
    return () => {};
  }
  let requestId: number | null = null;
  const block = (event: Event) => {
    if (updateLocked(useUpdates.getState().phase)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const events = ["keydown", "beforeinput", "paste", "drop", "pointerdown"];
  const receive = (snapshot: UpdateSnapshot) => {
    acceptUpdate(snapshot);
    const current = useUpdates.getState();
    // Freeze input synchronously, before React renders or a checkpoint yields.
    document.querySelector(".workbench")?.toggleAttribute("inert", updateLocked(current.phase));
    if (
      current.phase === "preparing" &&
      current.requestId !== null &&
      requestId !== current.requestId
    ) {
      requestId = current.requestId;
      const id = requestId;
      void (async () => {
        let error: string | null = null;
        try {
          await (await import("../editor/documents")).checkpoint({ waitForMoves: true });
        } catch (cause) {
          error = errorMessage(cause);
        }
        await call("ack_update_checkpoint", { requestId: id, error });
      })().catch((error) => useUpdates.setState({ error: errorMessage(error) }));
    }
  };
  const unlisten = await listen<UpdateSnapshot>("update-state", ({ payload }) => receive(payload));
  events.forEach((event) => document.addEventListener(event, block, true));
  try {
    receive(await call<UpdateSnapshot>("get_update_state"));
    void call<UpdateSnapshot>("check_update", { background: true })
      .then(receive)
      .catch(() => {});
  } catch (error) {
    unlisten();
    events.forEach((event) => document.removeEventListener(event, block, true));
    throw error;
  }
  return () => {
    unlisten();
    events.forEach((event) => document.removeEventListener(event, block, true));
    document.querySelector(".workbench")?.removeAttribute("inert");
  };
}
