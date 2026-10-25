import { call } from "./bridge";
import { ask } from "../components/dialog";
import { useApp } from "../store/store";

const restricted = new Set<string>();
const prompts = new Map<string, { controller: AbortController; pending: Promise<boolean> }>();

export function cancelWorkspaceTrustPrompt() {
  for (const { controller } of prompts.values()) {
    controller.abort();
  }
}

export async function manageWorkspaceTrust(root = useApp.getState().root) {
  if (!root) {
    return;
  }
  cancelWorkspaceTrustPrompt();
  const choice = await ask(
    "Workspace Trust",
    `Only trust folders from authors you trust. Terminals, language services and formatters can execute code from this folder.\n\n${root}`,
    ["Restricted Mode", "Trust Workspace", "Cancel"],
  );
  if (!choice || choice === "Cancel" || useApp.getState().root !== root) {
    return;
  }
  const trusted = choice === "Trust Workspace";
  await call("set_workspace_trust", { expectedRoot: root, trusted });
  if (trusted) {
    restricted.delete(root);
  } else {
    restricted.add(root);
  }
  return trusted;
}

function requestTrust(root: string) {
  if (restricted.has(root)) {
    return Promise.resolve(false);
  }
  const existing = prompts.get(root);
  if (existing) {
    return existing.pending;
  }
  const controller = new AbortController();
  const pending = (async () => {
    const choice = await ask(
      "Do you trust the authors of this folder?",
      `Terminals, language services and formatters can execute code from this folder. Restricted Mode keeps text editing available.\n\n${root}`,
      ["Restricted Mode", "Trust Workspace"],
      { signal: controller.signal },
    );
    if (controller.signal.aborted || useApp.getState().root !== root) {
      return false;
    }
    if (choice !== "Trust Workspace") {
      restricted.add(root);
      return false;
    }
    await call("set_workspace_trust", { expectedRoot: root, trusted: true });
    return true;
  })().finally(() => prompts.delete(root));
  prompts.set(root, { controller, pending });
  return pending;
}

export async function trustedCall<T>(
  command: string,
  args?: Record<string, unknown> | (() => Record<string, unknown>),
): Promise<T> {
  const root = useApp.getState().root;
  const argumentsForCall = () => (typeof args === "function" ? args() : args);
  try {
    return await call<T>(command, argumentsForCall());
  } catch (error) {
    if (
      (error as { code?: string })?.code !== "workspaceTrust" ||
      !root ||
      useApp.getState().root !== root ||
      !(await requestTrust(root)) ||
      useApp.getState().root !== root
    ) {
      throw error;
    }
    return call<T>(command, argumentsForCall());
  }
}
